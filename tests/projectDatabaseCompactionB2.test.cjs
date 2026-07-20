const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');

const {
  COMMON_OPERATION_BATCH_CONTRACT,
} = require('../backend/src/collaboration/commonOperationProtocol');
const {
  adaptCommonGraphBatch,
} = require('../backend/src/collaboration/commonOperationAdapter');
const {
  PROJECT_DATABASE_MIGRATION_29_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration29');
const {
  PROJECT_DATABASE_MIGRATION_30_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration30');
const {
  PROJECT_DATABASE_MIGRATION_31,
} = require('../backend/src/services/projectDatabaseMigration31');
const {
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration31LegacyGaps');
const {
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS,
} = require('../backend/src/services/projectDatabaseMigration31DurableLedgers');
const {
  OperationBatchConflictError,
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');
const {
  stripSchema32ForSyntheticSchema31,
} = require('./helpers/projectDatabaseVersion.cjs');

const PROJECT_ID = 'project-compaction-b2';
const ACTOR_ID = 'compaction-b2-writer';
const SESSION_ID = 'compaction-b2-session';
const FILLER_BATCH_SIZE = 500;
const FILLER_BATCH_COUNT = 10;
const FILLER_OPERATION_COUNT = FILLER_BATCH_SIZE * FILLER_BATCH_COUNT;

// Production schema31 DOWN remains backup-only. Historical migration fixtures
// explicitly remove only schema31-owned objects and its receipt/checkpoint.
function stripSchema31ForSchema30Test(database) {
  stripSchema32ForSyntheticSchema31(database);
  database.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DOWN_SQL);
  const drop = (type, name) => database.exec(`DROP ${type} IF EXISTS "${name}"`);
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.triggers.forEach((name) => drop('TRIGGER', name));
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.views.forEach((name) => drop('VIEW', name));
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.indexes.forEach((name) => drop('INDEX', name));
  [...PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.tables]
    .reverse()
    .forEach((name) => drop('TABLE', name));
  database.prepare('DELETE FROM schema_migration_receipts WHERE version = ?')
    .run(PROJECT_DATABASE_MIGRATION_31.version);
  database.prepare('DELETE FROM schema_migrations WHERE version = ?')
    .run(PROJECT_DATABASE_MIGRATION_31.version);
}

function seedCanvas(database, canvasId) {
  return database.ensureCanvas(canvasId, {
    nodes: [{
      id: 'node-a',
      type: 'text',
      position: { x: 0, y: 0 },
      data: { marker: -1 },
    }],
    edges: [],
  }, PROJECT_ID);
}

function operation(canvasId, sequence, baseRevision, prefix = 'filler') {
  return {
    opId: `${prefix}-${sequence}`,
    projectId: PROJECT_ID,
    canvasId,
    actorId: ACTOR_ID,
    sessionId: SESSION_ID,
    baseRevision,
    clientSeq: sequence,
    type: 'node.patch',
    payload: { nodeId: 'node-a', dataPatch: { marker: sequence } },
    timestamp: 1_800_000_000_000 + sequence,
  };
}

function fillToCompactionThreshold(database, canvasId) {
  let document = database.getCanvas(canvasId);
  for (let batch = 0; batch < FILLER_BATCH_COUNT; batch += 1) {
    const baseRevision = document.revision;
    const operations = Array.from({ length: FILLER_BATCH_SIZE }, (_, index) => {
      const sequence = batch * FILLER_BATCH_SIZE + index + 1;
      return operation(canvasId, sequence, baseRevision);
    });
    document = database.applyOperations(canvasId, operations, {
      expectedRevision: baseRevision,
    }).document;
  }
  assert.equal(document.revision, FILLER_OPERATION_COUNT + 1);
  assert.equal(database.db.prepare(`
    SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?
  `).get(canvasId).count, FILLER_OPERATION_COUNT);
  return document;
}

function operationWindow(database, canvasId) {
  return database.db.prepare(`
    SELECT revision, op_id
    FROM canvas_operations
    WHERE canvas_id = ?
    ORDER BY revision ASC
  `).all(canvasId).map((row) => ({
    revision: Number(row.revision),
    opId: row.op_id,
  }));
}

function snapshotRows(database, canvasId) {
  return database.db.prepare(`
    SELECT canvas_id, revision, project_id, reason, snapshot_json, created_at
    FROM canvas_snapshots
    WHERE canvas_id = ?
    ORDER BY revision ASC
  `).all(canvasId);
}

function commonEvidenceRows(database, batchId) {
  return database.db.prepare(`
    SELECT batch_id, operation_index, op_id, project_id, canvas_id, revision,
           base_revision, actor_id, session_id, client_seq, type, payload_json,
           payload_digest, logical_bytes, timestamp, created_at
    FROM collaboration_common_graph_operation_evidence
    WHERE batch_id = ?
    ORDER BY operation_index ASC
  `).all(batchId);
}

function deleteUnownedRecoverySnapshot(database, canvasId, revision) {
  const pins = database.db.prepare(`
    SELECT pin_kind, owner_id, slot
    FROM canvas_snapshot_pins
    WHERE project_id = ? AND canvas_id = ? AND snapshot_revision = ?
    ORDER BY pin_kind ASC, owner_id ASC, slot ASC
  `).all(PROJECT_ID, canvasId, revision);
  assert.deepEqual(pins, [{
    pin_kind: 'recovery_anchor',
    owner_id: canvasId,
    slot: 'anchor',
  }]);
  assert.equal(database.db.prepare(`
    DELETE FROM canvas_snapshot_pins
    WHERE project_id = ? AND canvas_id = ? AND snapshot_revision = ?
      AND pin_kind = 'recovery_anchor' AND owner_id = ? AND slot = 'anchor'
  `).run(PROJECT_ID, canvasId, revision, canvasId).changes, 1);
  assert.equal(database.db.prepare(`
    DELETE FROM canvas_snapshots
    WHERE project_id = ? AND canvas_id = ? AND revision = ?
  `).run(PROJECT_ID, canvasId, revision).changes, 1);
  assert.deepEqual(database.db.pragma('foreign_key_check'), []);
}

function atomicState(database, canvasId) {
  return {
    document: database.db.prepare(`
      SELECT canvas_id, project_id, schema_version, revision, snapshot_json, created_at, updated_at
      FROM canvas_documents
      WHERE canvas_id = ?
    `).get(canvasId),
    operations: database.db.prepare(`
      SELECT COUNT(*) AS count, MIN(revision) AS min_revision, MAX(revision) AS max_revision
      FROM canvas_operations
      WHERE canvas_id = ?
    `).get(canvasId),
    idempotency: database.db.prepare(`
      SELECT COUNT(*) AS count, MIN(revision) AS min_revision, MAX(revision) AS max_revision
      FROM canvas_operation_idempotency
      WHERE canvas_id = ?
    `).get(canvasId),
    snapshots: snapshotRows(database, canvasId),
    snapshotPins: database.db.prepare(`
      SELECT * FROM canvas_snapshot_pins
      WHERE canvas_id = ?
      ORDER BY snapshot_revision ASC, pin_kind ASC, owner_id ASC, slot ASC
    `).all(canvasId),
    commonEvidence: database.db.prepare(`
      SELECT COUNT(*) AS count, MIN(revision) AS min_revision, MAX(revision) AS max_revision
      FROM collaboration_common_graph_operation_evidence
      WHERE canvas_id = ?
    `).get(canvasId),
    historyUsage: database.db.prepare(`
      SELECT * FROM canvas_history_usage WHERE canvas_id = ?
    `).get(canvasId),
  };
}

function assertContiguousWindow(rows, expectedMin, expectedMax) {
  assert.equal(rows.length, expectedMax - expectedMin + 1);
  assert.equal(rows[0].revision, expectedMin);
  assert.equal(rows.at(-1).revision, expectedMax);
  rows.forEach((row, index) => {
    assert.equal(row.revision, expectedMin + index);
  });
}

test('B2 default raw history hard cap releases only the minimum reserve and survives a cold reopen', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-project-compaction-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const canvasId = 'canvas-compaction-b2-cold';
  let database = null;

  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    seedCanvas(database, canvasId);
    const atThreshold = fillToCompactionThreshold(database, canvasId);
    const thresholdWindow = operationWindow(database, canvasId);
    assertContiguousWindow(thresholdWindow, 2, atThreshold.revision);
    assert.equal(database.db.prepare(`
      SELECT max_raw_operation_rows FROM canvas_history_policies WHERE canvas_id = ?
    `).get(canvasId).max_raw_operation_rows, FILLER_OPERATION_COUNT);
    const compactionOperation = operation(
      canvasId,
      FILLER_OPERATION_COUNT + 1,
      atThreshold.revision,
      'compaction-boundary',
    );
    const compacted = database.applyOperations(canvasId, [compactionOperation], {
      expectedRevision: atThreshold.revision,
    });

    assert.equal(compacted.document.revision, 5002);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count
      FROM canvas_snapshots
      WHERE canvas_id = ? AND reason = 'operation-compaction'
    `).get(canvasId).count, 0);

    const retained = operationWindow(database, canvasId);
    const expectedMinRevision = compacted.document.revision - FILLER_OPERATION_COUNT + 1;
    assertContiguousWindow(retained, expectedMinRevision, compacted.document.revision);
    assert.equal(retained.length, FILLER_OPERATION_COUNT);
    assert.deepEqual(retained, [
      ...thresholdWindow.slice(1),
      { revision: compacted.document.revision, opId: compactionOperation.opId },
    ]);
    assert.equal(database.db.prepare(`
      SELECT raw_operation_rows FROM canvas_history_usage WHERE canvas_id = ?
    `).get(canvasId).raw_operation_rows, FILLER_OPERATION_COUNT);

    const oldClientSync = database.syncCanvas(canvasId, 2, 500);
    assert.equal(oldClientSync.mode, 'snapshot');
    assert.equal(oldClientSync.reason, 'range_exceeded');
    assert.equal(oldClientSync.revision, compacted.document.revision);
    assert.deepEqual(oldClientSync.document, compacted.document);

    const windowAfterRevision = compacted.document.revision - 25;
    const expectedWindow = retained.filter((row) => row.revision > windowAfterRevision);
    const windowSync = database.syncCanvas(canvasId, windowAfterRevision, 500);
    assert.equal(windowSync.mode, 'operations');
    assert.equal(windowSync.revision, compacted.document.revision);
    assert.deepEqual(windowSync.operations.map(({ revision, opId }) => ({ revision, opId })), expectedWindow);

    const freshOperation = operation(
      canvasId,
      FILLER_OPERATION_COUNT + 2,
      compacted.document.revision,
      'post-compaction',
    );
    const fresh = database.applyOperations(canvasId, [freshOperation], {
      expectedRevision: compacted.document.revision,
    });
    assert.equal(fresh.document.revision, 5003);
    assert.equal(fresh.acknowledgements[0].duplicate, false);
    const countsBeforeReplay = atomicState(database, canvasId);
    const exactReplay = database.applyOperations(canvasId, [freshOperation], {
      expectedRevision: fresh.document.revision,
    });
    assert.equal(exactReplay.document.revision, fresh.document.revision);
    assert.deepEqual(exactReplay.acknowledgements, [{
      opId: freshOperation.opId,
      revision: fresh.document.revision,
      duplicate: true,
    }]);
    assert.deepEqual(atomicState(database, canvasId), countsBeforeReplay);

    const durableDocument = fresh.document;
    const durableWindow = operationWindow(database, canvasId);
    assertContiguousWindow(
      durableWindow,
      durableDocument.revision - FILLER_OPERATION_COUNT + 1,
      durableDocument.revision,
    );
    const durableSnapshots = snapshotRows(database, canvasId);
    await database.close();
    database = null;

    database = new ProjectDatabase(filename, { autoBackup: false });
    assert.deepEqual(database.getCanvas(canvasId), durableDocument);
    assert.deepEqual(operationWindow(database, canvasId), durableWindow);
    assert.deepEqual(snapshotRows(database, canvasId), durableSnapshots);
    const reopenedSync = database.syncCanvas(canvasId, durableDocument.revision - 25, 500);
    assert.equal(reopenedSync.mode, 'operations');
    assert.deepEqual(
      reopenedSync.operations.map(({ revision, opId }) => ({ revision, opId })),
      durableWindow.filter((row) => row.revision > durableDocument.revision - 25),
    );
    const reopenedCount = database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?
    `).get(canvasId).count;
    const reopenedReplay = database.applyOperations(canvasId, [freshOperation], {
      expectedRevision: durableDocument.revision,
    });
    assert.equal(reopenedReplay.acknowledgements[0].duplicate, true);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?
    `).get(canvasId).count, reopenedCount);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
  } finally {
    if (database) await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('B2 Common batch evidence survives compaction, rejects forged bindings, and replays after cold reopen', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-common-compaction-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const canvasId = 'canvas-common-compaction-b2';
  const batchId = '60000000-0000-4000-8000-000000000001';
  const clientId = '60000000-0000-4000-8000-000000000002';
  const opId = '60000000-0000-4000-8000-000000000003';
  const promotedBatchId = '60000000-0000-4000-8000-000000000004';
  const promotedClientId = '60000000-0000-4000-8000-000000000005';
  const promotedOpId = '60000000-0000-4000-8000-000000000006';
  let database = null;

  try {
    database = new ProjectDatabase(filename, {
      autoBackup: false,
      canvasSnapshotRetentionLimit: 2,
    });
    let document = seedCanvas(database, canvasId);
    const initialNode = document.nodes.find((item) => item.id === 'node-a');
    const promotedBatch = {
      contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
      projectId: PROJECT_ID,
      canvasId,
      baseRevision: document.revision,
      batchId: promotedBatchId,
      clientId: promotedClientId,
      clientSeq: 900,
      operations: [{
        opId: promotedOpId,
        type: 'node.move',
        payload: {
          nodeUid: initialNode.entityUid,
          expectedEntityRevision: initialNode.entityRevision,
          position: { x: 5, y: 6 },
        },
      }],
    };
    const promotedAdapted = adaptCommonGraphBatch(promotedBatch, document, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
      timestamp: 1_899_999_999_000,
    });
    document = database.applyOperations(canvasId, promotedAdapted.operations, {
      expectedRevision: promotedBatch.baseRevision,
      requireTimestampIdentity: false,
    }).document;
    assert.equal(document.revision, 2);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_common_operation_batches
    `).get().count, 0);
    const promoted = database.applyOperations(canvasId, promotedAdapted.operations, {
      expectedRevision: document.revision,
      commonBatch: promotedBatch,
      requireTimestampIdentity: false,
    });
    assert.equal(promoted.acknowledgements[0].duplicate, true);
    assert.ok(database.db.prepare(`
      SELECT 1 FROM collaboration_common_operation_batches WHERE batch_id = ?
    `).get(promotedBatchId));

    const prelude = Array.from({ length: 10 }, (_, index) => operation(
      canvasId,
      index + 1,
      document.revision,
      'common-compaction-prelude',
    ));
    document = database.applyOperations(canvasId, prelude, {
      expectedRevision: document.revision,
    }).document;
    assert.equal(document.revision, 12);

    const node = document.nodes.find((item) => item.id === 'node-a');
    const commonBatch = {
      contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
      projectId: PROJECT_ID,
      canvasId,
      baseRevision: document.revision,
      batchId,
      clientId,
      clientSeq: 1_000,
      operations: [{
        opId,
        type: 'node.move',
        payload: {
          nodeUid: node.entityUid,
          expectedEntityRevision: node.entityRevision,
          position: { x: 77, y: 88 },
        },
      }],
    };
    const commonBaseDocument = document;
    const adapted = adaptCommonGraphBatch(commonBatch, document, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
      timestamp: 1_900_000_000_000,
    });
    const beforeForgedBindings = atomicState(database, canvasId);
    const forgedOperations = [
      {
        ...adapted.operations[0],
        payload: { ...adapted.operations[0].payload, position: { x: 99, y: 88 } },
      },
      {
        ...adapted.operations[0],
        baseRevision: adapted.operations[0].baseRevision + 1,
      },
      {
        ...adapted.operations[0],
        clientSeq: adapted.operations[0].clientSeq + 1,
      },
    ];
    for (const forgedOperation of forgedOperations) {
      assert.throws(
        () => database.applyOperations(canvasId, [forgedOperation], {
          expectedRevision: commonBatch.baseRevision,
          commonBatch,
          requireTimestampIdentity: false,
        }),
        (error) => error instanceof OperationBatchConflictError,
      );
      assert.deepEqual(atomicState(database, canvasId), beforeForgedBindings);
      assert.equal(database.getCanvasOperationIdentity(opId), undefined);
    }
    const commonApplied = database.applyOperations(canvasId, adapted.operations, {
      expectedRevision: commonBatch.baseRevision,
      commonBatch,
      requireTimestampIdentity: false,
    });
    document = commonApplied.document;
    assert.equal(document.revision, 13);
    assert.equal(database.db.prepare(`
      SELECT 1 FROM canvas_snapshots
      WHERE canvas_id = ? AND revision = ?
    `).get(canvasId, commonBatch.baseRevision), undefined);

    const staleBatch = {
      ...commonBatch,
      batchId: '60000000-0000-4000-8000-000000000007',
      clientId: '60000000-0000-4000-8000-000000000008',
      operations: [{
        ...commonBatch.operations[0],
        opId: '60000000-0000-4000-8000-000000000009',
      }],
    };
    const staleAdapted = adaptCommonGraphBatch(staleBatch, commonBaseDocument, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
      timestamp: 1_900_000_001_000,
    });
    const beforeStaleWrite = atomicState(database, canvasId);
    assert.throws(
      () => database.applyOperations(canvasId, staleAdapted.operations, {
        commonBatch: staleBatch,
        requireTimestampIdentity: false,
      }),
      (error) => error instanceof OperationBatchConflictError,
    );
    assert.deepEqual(atomicState(database, canvasId), beforeStaleWrite);

    for (let batch = 0; batch < FILLER_BATCH_COUNT; batch += 1) {
      const baseRevision = document.revision;
      const operations = Array.from({ length: FILLER_BATCH_SIZE }, (_, index) => {
        const sequence = 10_000 + batch * FILLER_BATCH_SIZE + index;
        return operation(canvasId, sequence, baseRevision, 'common-compaction-filler');
      });
      document = database.applyOperations(canvasId, operations, {
        expectedRevision: baseRevision,
      }).document;
    }
    assert.equal(document.revision, 5_013);
    assert.equal(database.db.prepare(`
      SELECT 1 FROM canvas_operations WHERE op_id = ?
    `).get(opId), undefined);
    assert.equal(database.db.prepare(`
      SELECT 1 FROM canvas_operations WHERE op_id = ?
    `).get(promotedOpId), undefined);
    assert.ok(database.db.prepare(`
      SELECT 1 FROM canvas_operation_idempotency WHERE op_id = ?
    `).get(opId));
    assert.ok(database.db.prepare(`
      SELECT 1 FROM collaboration_common_operation_batches WHERE batch_id = ?
    `).get(batchId));
    const durableCommonEvidence = commonEvidenceRows(database, batchId);
    const durablePromotedEvidence = commonEvidenceRows(database, promotedBatchId);
    assert.equal(durableCommonEvidence.length, 1);
    assert.equal(durableCommonEvidence[0].op_id, opId);
    assert.equal(durableCommonEvidence[0].revision, commonBatch.baseRevision + 1);
    assert.deepEqual(JSON.parse(durableCommonEvidence[0].payload_json), adapted.operations[0].payload);
    assert.equal(durablePromotedEvidence.length, 1);
    assert.equal(durablePromotedEvidence[0].op_id, promotedOpId);
    assert.deepEqual(JSON.parse(durablePromotedEvidence[0].payload_json), promotedAdapted.operations[0].payload);

    const beforeReplay = atomicState(database, canvasId);
    const replay = database.replayCommonOperationBatch(commonBatch, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
    });
    assert.equal(replay.document.revision, document.revision);
    assert.deepEqual(replay.acknowledgements, [{
      opId,
      projectId: PROJECT_ID,
      canvasId,
      baseRevision: commonBatch.baseRevision,
      revision: commonBatch.baseRevision + 1,
      duplicate: true,
    }]);
    assert.deepEqual(replay.operations, adapted.operations);
    const promotedReplay = database.replayCommonOperationBatch(promotedBatch, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
    });
    assert.deepEqual(promotedReplay.operations, promotedAdapted.operations);
    assert.deepEqual(atomicState(database, canvasId), beforeReplay);

    const tampered = {
      ...commonBatch,
      operations: [{
        ...commonBatch.operations[0],
        payload: {
          ...commonBatch.operations[0].payload,
          position: { x: 99, y: 88 },
        },
      }],
    };
    assert.throws(
      () => database.replayCommonOperationBatch(tampered, {
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
      (error) => error instanceof OperationBatchConflictError,
    );

    await database.close();
    database = null;
    database = new ProjectDatabase(filename, {
      autoBackup: false,
      canvasSnapshotRetentionLimit: 2,
    });
    const reopenedReplay = database.replayCommonOperationBatch(commonBatch, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
    });
    assert.equal(reopenedReplay.document.revision, document.revision);
    assert.deepEqual(reopenedReplay.operations, adapted.operations);
    assert.deepEqual(database.replayCommonOperationBatch(promotedBatch, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
    }).operations, promotedAdapted.operations);
    assert.deepEqual(commonEvidenceRows(database, batchId), durableCommonEvidence);
    assert.deepEqual(commonEvidenceRows(database, promotedBatchId), durablePromotedEvidence);
    assert.equal(database.db.prepare(`
      SELECT 1 FROM canvas_operations WHERE op_id IN (?, ?) LIMIT 1
    `).get(opId, promotedOpId), undefined);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try { await database?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('B2 Common legacy promotion rejects a historical operation recorded outside the exact base revision chain', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const canvasId = 'canvas-common-invalid-promotion-b2';

  try {
    const initial = database.ensureCanvas(canvasId, {
      nodes: [
        { id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: {} },
        { id: 'node-b', type: 'text', position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [],
    }, PROJECT_ID);
    database.recordCanvasSnapshot(initial, 'invalid-promotion-base');

    const advanced = database.applyOperations(canvasId, [{
      ...operation(canvasId, 1, initial.revision, 'invalid-promotion-prelude'),
      payload: { nodeId: 'node-b', dataPatch: { marker: 1 } },
    }], {
      expectedRevision: initial.revision,
    }).document;
    assert.equal(advanced.revision, initial.revision + 1);

    const node = initial.nodes.find((item) => item.id === 'node-a');
    const batch = {
      contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
      projectId: PROJECT_ID,
      canvasId,
      baseRevision: initial.revision,
      batchId: '60500000-0000-4000-8000-000000000001',
      clientId: '60500000-0000-4000-8000-000000000002',
      clientSeq: 100,
      operations: [{
        opId: '60500000-0000-4000-8000-000000000003',
        type: 'node.move',
        payload: {
          nodeUid: node.entityUid,
          expectedEntityRevision: node.entityRevision,
          position: { x: 25, y: 35 },
        },
      }],
    };
    const adapted = adaptCommonGraphBatch(batch, initial, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
      timestamp: 1_900_050_000_000,
    });
    const historical = database.applyOperations(canvasId, adapted.operations, {
      expectedRevision: advanced.revision,
      requireTimestampIdentity: false,
    });
    assert.equal(historical.document.revision, initial.revision + 2);
    assert.equal(
      database.getCanvasOperationIdentity(batch.operations[0].opId).revision,
      initial.revision + 2,
    );

    const beforePromotion = atomicState(database, canvasId);
    assert.throws(
      () => database.applyOperations(canvasId, adapted.operations, {
        expectedRevision: historical.document.revision,
        commonBatch: batch,
        requireTimestampIdentity: false,
      }),
      (error) => error instanceof OperationBatchConflictError,
    );
    assert.deepEqual(atomicState(database, canvasId), beforePromotion);
    assert.equal(database.getCommonOperationBatch({ batchId: batch.batchId }), null);
  } finally {
    await database.close();
  }
});

test('B2 Common replay uses batch evidence without raw/base and fails closed when evidence is missing', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-common-evidence-replay-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const canvasId = 'canvas-common-evidence-replay-b2';
  let database = null;

  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    const initial = database.ensureCanvas(canvasId, {
      nodes: [
        { id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: {} },
        { id: 'node-b', type: 'text', position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [],
    }, PROJECT_ID);
    database.recordCanvasSnapshot(initial, 'common-fallback-base');
    const [nodeA, nodeB] = initial.nodes;
    const batch = {
      contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
      projectId: PROJECT_ID,
      canvasId,
      baseRevision: initial.revision,
      batchId: '61000000-0000-4000-8000-000000000001',
      clientId: '61000000-0000-4000-8000-000000000002',
      clientSeq: 100,
      operations: [
        {
          opId: '61000000-0000-4000-8000-000000000003',
          type: 'node.move',
          payload: {
            nodeUid: nodeA.entityUid,
            expectedEntityRevision: nodeA.entityRevision,
            position: { x: 10, y: 11 },
          },
        },
        {
          opId: '61000000-0000-4000-8000-000000000004',
          type: 'node.move',
          payload: {
            nodeUid: nodeB.entityUid,
            expectedEntityRevision: nodeB.entityRevision,
            position: { x: 20, y: 21 },
          },
        },
      ],
    };
    const adapted = adaptCommonGraphBatch(batch, initial, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
      timestamp: 1_900_100_000_000,
    });
    const applied = database.applyOperations(canvasId, adapted.operations, {
      expectedRevision: batch.baseRevision,
      commonBatch: batch,
      requireTimestampIdentity: false,
    });
    assert.equal(applied.document.revision, 3);
    const durableEvidence = commonEvidenceRows(database, batch.batchId);
    assert.equal(durableEvidence.length, 2);
    assert.deepEqual(
      durableEvidence.map((row) => row.op_id),
      batch.operations.map((item) => item.opId),
    );
    assert.deepEqual(
      durableEvidence.map((row) => JSON.parse(row.payload_json)),
      adapted.operations.map((item) => item.payload),
    );
    assert.equal(database.db.prepare(`
      DELETE FROM canvas_operations WHERE op_id IN (?, ?)
    `).run(batch.operations[0].opId, batch.operations[1].opId).changes, 2);
    deleteUnownedRecoverySnapshot(database, canvasId, batch.baseRevision);
    assert.equal(database.db.prepare(`
      SELECT 1 FROM canvas_operations WHERE op_id IN (?, ?) LIMIT 1
    `).get(batch.operations[0].opId, batch.operations[1].opId), undefined);
    assert.equal(database.db.prepare(`
      SELECT 1 FROM canvas_snapshots WHERE canvas_id = ? AND revision = ?
    `).get(canvasId, batch.baseRevision), undefined);

    const beforeReplay = atomicState(database, canvasId);
    const replay = database.replayCommonOperationBatch(batch, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
    });
    assert.deepEqual(replay.operations, adapted.operations);
    assert.deepEqual(replay.acknowledgements.map((item) => item.revision), [2, 3]);
    assert.deepEqual(atomicState(database, canvasId), beforeReplay);
    assert.throws(
      () => database.replayCommonOperationBatch(batch, {
        actorId: 'wrong-actor',
        sessionId: SESSION_ID,
      }),
      (error) => error instanceof OperationBatchConflictError,
    );
    const forgedRequest = {
      ...batch,
      operations: batch.operations.map((operation, index) => index === 0
        ? {
          ...operation,
          payload: { ...operation.payload, position: { x: 999, y: 11 } },
        }
        : operation),
    };
    assert.throws(
      () => database.replayCommonOperationBatch(forgedRequest, {
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
      (error) => error instanceof OperationBatchConflictError,
    );
    assert.deepEqual(atomicState(database, canvasId), beforeReplay);

    await database.close();
    database = null;
    database = new ProjectDatabase(filename, { autoBackup: false });
    assert.deepEqual(commonEvidenceRows(database, batch.batchId), durableEvidence);
    assert.deepEqual(database.replayCommonOperationBatch(batch, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
    }).operations, adapted.operations);
    assert.equal(database.db.prepare(`
      DELETE FROM collaboration_common_graph_operation_evidence
      WHERE batch_id = ? AND operation_index = 0
    `).run(batch.batchId).changes, 1);
    const missingEvidenceState = atomicState(database, canvasId);
    assert.throws(
      () => database.replayCommonOperationBatch(batch, {
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
      (error) => error instanceof OperationBatchConflictError,
    );
    assert.deepEqual(atomicState(database, canvasId), missingEvidenceState);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try { await database?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('B2 SQLITE_FULL rolls back the whole WAL operation transaction and preserves revision continuity after reopen', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-project-sqlite-full-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const canvasId = 'canvas-sqlite-full-b2';
  let database = null;

  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    const initial = seedCanvas(database, canvasId);
    database.db.pragma('wal_checkpoint(TRUNCATE)');
    database.db.exec('VACUUM');
    database.db.pragma('wal_checkpoint(TRUNCATE)');
    const pageCount = Number(database.db.pragma('page_count', { simple: true }));
    assert.equal(Number(database.db.pragma(`max_page_count = ${pageCount}`, { simple: true })), pageCount);
    const before = atomicState(database, canvasId);
    const failedOperation = {
      ...operation(canvasId, 1, initial.revision, 'sqlite-full'),
      payload: {
        nodeId: 'node-a',
        dataPatch: { diskPressurePayload: 'x'.repeat(2 * 1024 * 1024) },
      },
    };

    assert.throws(
      () => database.applyOperations(canvasId, [failedOperation], {
        expectedRevision: initial.revision,
      }),
      (error) => error instanceof ProjectDatabaseStorageCapacityError
        && error.code === 'project_database_storage_capacity_exceeded'
        && error.status === 507
        && error.reason === 'sqlite-full',
    );
    assert.deepEqual(atomicState(database, canvasId), before);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    database.db.pragma('max_page_count = 1073741823');
    const recoveryOperation = {
      ...failedOperation,
      payload: { nodeId: 'node-a', dataPatch: { marker: 1 } },
    };
    const recovered = database.applyOperations(canvasId, [recoveryOperation], {
      expectedRevision: initial.revision,
    });
    assert.equal(recovered.document.revision, initial.revision + 1);
    assert.equal(recovered.acknowledgements[0].duplicate, false);
    assert.equal(recovered.document.nodes.find((node) => node.id === 'node-a').data.marker, 1);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?
    `).get(canvasId).count, 1);

    await database.close();
    database = new ProjectDatabase(filename, { autoBackup: false });
    assert.equal(database.getCanvas(canvasId).revision, initial.revision + 1);
    assert.equal(database.getCanvas(canvasId).nodes.find((node) => node.id === 'node-a').data.marker, 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try { await database?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('B2 Common compaction DELETE failure rolls every ledger back, then the same batch retries safely', async () => {
  const canvasId = 'canvas-compaction-b2-rollback';
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    seedCanvas(database, canvasId);
    const atThreshold = fillToCompactionThreshold(database, canvasId);
    const node = atThreshold.nodes.find((item) => item.id === 'node-a');
    const commonBatch = {
      contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
      projectId: PROJECT_ID,
      canvasId,
      baseRevision: atThreshold.revision,
      batchId: '62000000-0000-4000-8000-000000000001',
      clientId: '62000000-0000-4000-8000-000000000002',
      clientSeq: FILLER_OPERATION_COUNT + 1,
      operations: [{
        opId: '62000000-0000-4000-8000-000000000003',
        type: 'node.move',
        payload: {
          nodeUid: node.entityUid,
          expectedEntityRevision: node.entityRevision,
          position: { x: 123, y: 456 },
        },
      }],
    };
    const adapted = adaptCommonGraphBatch(commonBatch, atThreshold, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
      timestamp: 1_900_200_000_000,
    });
    const retryableOperation = adapted.operations[0];
    const beforeFailure = atomicState(database, canvasId);
    const durableLedgerState = () => ({
      commonBatches: database.db.prepare(`
        SELECT COUNT(*) AS count FROM collaboration_common_operation_batches WHERE canvas_id = ?
      `).get(canvasId).count,
      canvasBatches: database.db.prepare(`
        SELECT COUNT(*) AS count FROM canvas_operation_batches WHERE canvas_id = ?
      `).get(canvasId).count,
      globalIdentities: database.db.prepare(`
        SELECT COUNT(*) AS count FROM collaboration_operation_identities WHERE canvas_id = ?
      `).get(canvasId).count,
      audits: database.db.prepare(`
        SELECT COUNT(*) AS count FROM audit_events WHERE canvas_id = ?
      `).get(canvasId).count,
      provenance: database.db.prepare(`
        SELECT COUNT(*) AS count FROM canvas_mutation_provenance WHERE canvas_id = ?
      `).get(canvasId).count,
      commonEvidence: database.db.prepare(`
        SELECT COUNT(*) AS count
        FROM collaboration_common_graph_operation_evidence WHERE canvas_id = ?
      `).get(canvasId).count,
      historyUsage: database.db.prepare(`
        SELECT * FROM canvas_history_usage WHERE canvas_id = ?
      `).get(canvasId),
    });
    const beforeLedgers = durableLedgerState();

    database.db.exec(`
      CREATE TRIGGER b2_fail_operation_compaction_delete
      BEFORE DELETE ON canvas_operations
      WHEN OLD.canvas_id = '${canvasId}'
      BEGIN
        SELECT RAISE(ABORT, 'B2 forced compaction DELETE failure');
      END;
    `);
    assert.throws(() => database.applyOperations(canvasId, adapted.operations, {
      expectedRevision: atThreshold.revision,
      commonBatch,
      requireTimestampIdentity: false,
    }), /B2 forced compaction DELETE failure/);
    assert.deepEqual(atomicState(database, canvasId), beforeFailure);
    assert.deepEqual(durableLedgerState(), beforeLedgers);
    assert.equal(database.db.prepare(`
      SELECT 1 FROM canvas_operations WHERE op_id = ?
    `).get(retryableOperation.opId), undefined);
    assert.equal(database.db.prepare(`
      SELECT 1 FROM canvas_operation_idempotency WHERE op_id = ?
    `).get(retryableOperation.opId), undefined);
    assert.equal(database.getCollaborationOperationIdentity(retryableOperation.opId), null);
    assert.equal(database.getCommonOperationBatch({ batchId: commonBatch.batchId }), null);
    assert.equal(database.db.prepare(`
      SELECT 1 FROM canvas_snapshots WHERE canvas_id = ? AND revision = ?
    `).get(canvasId, atThreshold.revision + 1), undefined);

    database.db.exec('DROP TRIGGER b2_fail_operation_compaction_delete');
    const retried = database.applyOperations(canvasId, adapted.operations, {
      expectedRevision: atThreshold.revision,
      commonBatch,
      requireTimestampIdentity: false,
    });
    assert.equal(retried.document.revision, atThreshold.revision + 1);
    assert.equal(retried.acknowledgements[0].duplicate, false);
    const retained = operationWindow(database, canvasId);
    assertContiguousWindow(
      retained,
      retried.document.revision - FILLER_OPERATION_COUNT + 1,
      retried.document.revision,
    );
    assert.equal(retained.length, FILLER_OPERATION_COUNT);
    assert.equal(retained[0].opId, 'filler-2');
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count
      FROM canvas_snapshots
      WHERE canvas_id = ? AND reason = 'operation-compaction'
    `).get(canvasId).count, 0);
    assert.deepEqual(database.db.prepare(`
      SELECT COUNT(*) AS count, MIN(revision) AS min_revision, MAX(revision) AS max_revision
      FROM canvas_operation_idempotency
      WHERE op_id = ?
    `).get(retryableOperation.opId), {
      count: 1,
      min_revision: retried.document.revision,
      max_revision: retried.document.revision,
    });
    assert.ok(database.getCommonOperationBatch({ batchId: commonBatch.batchId }));
    assert.ok(database.getCollaborationOperationIdentity(retryableOperation.opId));
    assert.equal(commonEvidenceRows(database, commonBatch.batchId).length, 1);

    const afterRetry = atomicState(database, canvasId);
    const exactReplay = database.replayCommonOperationBatch(commonBatch, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
    });
    assert.equal(exactReplay.acknowledgements[0].duplicate, true);
    assert.deepEqual(exactReplay.operations, adapted.operations);
    assert.deepEqual(atomicState(database, canvasId), afterRetry);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
  } finally {
    await database.close();
  }
});

test('B2 history migration preserves valid embedded updatedAt and only falls back for missing or invalid legacy values', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-project-snapshot-time-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const preMigration31BackupFilename = path.join(directory, 'schema30-before-schema31.sqlite3');
  const canvasId = 'canvas-snapshot-time-b2';
  const validUpdatedAt = 1_800_000_100_001;
  const validCreatedAt = 1_800_000_100_999;
  const missingFallback = 1_800_000_101_001;
  const invalidFallback = 1_800_000_102_001;
  let database = null;

  try {
    database = new ProjectDatabase(filename, { autoBackup: false, preMigration31BackupFilename });
    const document = seedCanvas(database, canvasId);
    const validSnapshot = { ...document, revision: 101, updatedAt: validUpdatedAt };
    const missingSnapshot = { ...document, revision: 102 };
    delete missingSnapshot.updatedAt;
    const invalidSnapshot = { ...document, revision: 103, updatedAt: 'not-a-timestamp' };
    const insert = database.db.prepare(`
      INSERT OR REPLACE INTO canvas_snapshots(
        canvas_id, revision, project_id, reason, snapshot_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run(canvasId, 101, PROJECT_ID, 'valid-time', JSON.stringify(validSnapshot), validCreatedAt);
    insert.run(canvasId, 102, PROJECT_ID, 'missing-time', JSON.stringify(missingSnapshot), missingFallback);
    insert.run(canvasId, 103, PROJECT_ID, 'invalid-time', JSON.stringify(invalidSnapshot), invalidFallback);
    await database.close();
    database = null;

    const legacy = new BetterSqlite3(filename);
    try {
      stripSchema31ForSchema30Test(legacy);
      legacy.exec(PROJECT_DATABASE_MIGRATION_30_DOWN_SQL);
      legacy.exec(PROJECT_DATABASE_MIGRATION_29_DOWN_SQL);
      legacy.prepare('DELETE FROM schema_migrations WHERE version >= ?').run(26);
      assert.equal(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 25);
    } finally {
      legacy.close();
    }
    // The first schema31 migration backup describes the pre-fixture database;
    // remove it so the synthetic schema25 upgrade must create an exact new one.
    fs.rmSync(preMigration31BackupFilename, { force: true });

    database = new ProjectDatabase(filename, { autoBackup: false, preMigration31BackupFilename });
    const migrated = database.db.prepare(`
      SELECT revision, snapshot_json
      FROM canvas_snapshots
      WHERE canvas_id = ? AND revision BETWEEN 101 AND 103
      ORDER BY revision ASC
    `).all(canvasId).map((row) => ({
      revision: Number(row.revision),
      document: JSON.parse(row.snapshot_json),
    }));
    assert.equal(migrated.length, 3);
    assert.equal(migrated[0].document.updatedAt, validUpdatedAt);
    assert.equal(migrated[1].document.updatedAt, missingFallback);
    assert.equal(migrated[2].document.updatedAt, invalidFallback);
    assert.deepEqual(
      database.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version),
      Array.from({ length: PROJECT_DATABASE_SCHEMA_VERSION }, (_, index) => index + 1),
    );

    const onceMigrated = snapshotRows(database, canvasId);
    await database.close();
    database = null;
    database = new ProjectDatabase(filename, { autoBackup: false });
    assert.deepEqual(snapshotRows(database, canvasId), onceMigrated);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
  } finally {
    if (database) await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
