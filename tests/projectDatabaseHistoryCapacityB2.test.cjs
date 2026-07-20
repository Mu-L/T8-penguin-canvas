const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BetterSqlite3 = require('better-sqlite3');
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
  COMMON_OPERATION_BATCH_CONTRACT,
} = require('../backend/src/collaboration/commonOperationProtocol');
const {
  adaptCommonGraphBatch,
} = require('../backend/src/collaboration/commonOperationAdapter');
const {
  OperationBatchConflictError,
  PROJECT_DATABASE_MIGRATIONS,
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');
const {
  assertCurrentProjectDatabaseRegistry,
  stripSchema32ForSyntheticSchema31,
} = require('./helpers/projectDatabaseVersion.cjs');

const PROJECT_ID = 'project-history-capacity-b2';
const ACTOR_ID = 'history-capacity-writer';
const SESSION_ID = 'history-capacity-session';
const EVIDENCE_TABLE = 'collaboration_common_graph_operation_evidence';
const RECEIPT_TABLE = 'schema_migration_receipts';

function tableExists(database, tableName) {
  return Boolean(database.prepare(`
    SELECT 1 AS found
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function tableCount(database, tableName, canvasId = null) {
  if (!tableExists(database, tableName)) return null;
  if (canvasId == null) {
    return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count);
  }
  return Number(database.prepare(`
    SELECT COUNT(*) AS count FROM ${tableName} WHERE canvas_id = ?
  `).get(canvasId).count);
}

function scopedTableRows(database, tableName, canvasId) {
  if (!tableExists(database, tableName)) return null;
  return database.prepare(`
    SELECT * FROM ${tableName} WHERE canvas_id = ?
  `).all(canvasId).sort((left, right) => (
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  ));
}

function seedCanvas(database, canvasId) {
  return database.ensureCanvas(canvasId, {
    nodes: [{
      id: 'node-a',
      type: 'text',
      position: { x: 0, y: 0 },
      data: {},
    }],
    edges: [],
  }, PROJECT_ID);
}

function buildGraphBatch(database, canvasId, options = {}) {
  const document = database.getCanvas(canvasId);
  const node = document.nodes.find((item) => item.id === 'node-a');
  const clientSeq = Number(options.clientSeq || 1);
  const batch = {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: PROJECT_ID,
    canvasId,
    baseRevision: document.revision,
    batchId: options.batchId || crypto.randomUUID(),
    clientId: options.clientId || crypto.randomUUID(),
    clientSeq,
    operations: [{
      opId: options.opId || crypto.randomUUID(),
      type: 'node.move',
      payload: {
        nodeUid: node.entityUid,
        expectedEntityRevision: node.entityRevision,
        position: {
          x: Number(options.x ?? clientSeq),
          y: Number(options.y ?? clientSeq + 1),
        },
      },
    }],
  };
  const adapted = adaptCommonGraphBatch(batch, document, {
    actorId: ACTOR_ID,
    sessionId: SESSION_ID,
    timestamp: 1_910_000_000_000 + clientSeq * 10,
  });
  return { batch, adapted, document };
}

function applyGraphBatch(database, canvasId, options = {}) {
  const prepared = buildGraphBatch(database, canvasId, options);
  const result = database.applyOperations(canvasId, prepared.adapted.operations, {
    expectedRevision: prepared.batch.baseRevision,
    commonBatch: prepared.batch,
    requireTimestampIdentity: false,
  });
  return { ...prepared, result };
}

function evidenceRows(database, batchId) {
  return database.db.prepare(`
    SELECT batch_id, operation_index, op_id, project_id, canvas_id, revision,
           base_revision, actor_id, session_id, client_seq, type, payload_json,
           payload_digest, timestamp, logical_bytes, created_at
    FROM ${EVIDENCE_TABLE}
    WHERE batch_id = ?
    ORDER BY operation_index ASC
  `).all(batchId);
}

function atomicState(database, canvasId) {
  return {
    document: database.db.prepare(`
      SELECT project_id, canvas_id, revision, snapshot_json, created_at, updated_at
      FROM canvas_documents WHERE canvas_id = ?
    `).get(canvasId),
    rawOperations: scopedTableRows(database.db, 'canvas_operations', canvasId),
    operationIdempotency: scopedTableRows(database.db, 'canvas_operation_idempotency', canvasId),
    canvasBatches: scopedTableRows(database.db, 'canvas_operation_batches', canvasId),
    commonBatches: scopedTableRows(database.db, 'collaboration_common_operation_batches', canvasId),
    commonEvidence: scopedTableRows(database.db, EVIDENCE_TABLE, canvasId),
    globalIdentities: scopedTableRows(database.db, 'collaboration_operation_identities', canvasId),
    audits: scopedTableRows(database.db, 'audit_events', canvasId),
    provenance: scopedTableRows(database.db, 'canvas_mutation_provenance', canvasId),
    snapshots: scopedTableRows(database.db, 'canvas_snapshots', canvasId),
    snapshotPins: scopedTableRows(database.db, 'canvas_snapshot_pins', canvasId),
    historyPolicies: scopedTableRows(database.db, 'canvas_history_policies', canvasId),
    historyUsage: scopedTableRows(database.db, 'canvas_history_usage', canvasId),
  };
}

async function closeQuietly(database) {
  if (!database) return;
  try { await database.close(); } catch (_) {}
}

// Production schema31 DOWN remains backup-only. Historical schema28 fixtures
// explicitly remove schema31-owned objects before exercising v29/v30 contracts.
function stripSchema31ForSchema30Test(raw) {
  stripSchema32ForSyntheticSchema31(raw);
  raw.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DOWN_SQL);
  const drop = (type, name) => raw.exec(`DROP ${type} IF EXISTS "${name}"`);
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.triggers.forEach((name) => drop('TRIGGER', name));
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.views.forEach((name) => drop('VIEW', name));
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.indexes.forEach((name) => drop('INDEX', name));
  [...PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.tables]
    .reverse()
    .forEach((name) => drop('TABLE', name));
  raw.prepare('DELETE FROM schema_migration_receipts WHERE version = ?')
    .run(PROJECT_DATABASE_MIGRATION_31.version);
  raw.prepare('DELETE FROM schema_migrations WHERE version = ?')
    .run(PROJECT_DATABASE_MIGRATION_31.version);
}

function removeV29Objects(raw) {
  raw.pragma('foreign_keys = OFF');
  stripSchema31ForSchema30Test(raw);
  raw.exec(PROJECT_DATABASE_MIGRATION_30_DOWN_SQL);
  raw.exec(PROJECT_DATABASE_MIGRATION_29_DOWN_SQL);
  raw.prepare('DELETE FROM schema_migrations WHERE version = ?').run(30);
  raw.prepare('DELETE FROM schema_migrations WHERE version = ?').run(29);
  raw.pragma('foreign_keys = ON');
}

function directDatabaseState(raw, canvasId) {
  return {
    revision: Number(raw.prepare(`
      SELECT revision FROM canvas_documents WHERE canvas_id = ?
    `).get(canvasId).revision),
    rawOperations: Number(raw.prepare(`
      SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?
    `).get(canvasId).count),
    operationIdempotency: Number(raw.prepare(`
      SELECT COUNT(*) AS count FROM canvas_operation_idempotency WHERE canvas_id = ?
    `).get(canvasId).count),
    commonBatches: Number(raw.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_common_operation_batches WHERE canvas_id = ?
    `).get(canvasId).count),
    globalIdentities: Number(raw.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_operation_identities WHERE canvas_id = ?
    `).get(canvasId).count),
  };
}

test('B2 current schema preserves the immutable v29 receipt and complete evidence schema', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    assertCurrentProjectDatabaseRegistry(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATIONS);
    assert.equal(
      database.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      PROJECT_DATABASE_SCHEMA_VERSION,
    );
    assert.equal(tableExists(database.db, RECEIPT_TABLE), true);
    assert.equal(tableExists(database.db, EVIDENCE_TABLE), true);

    const receipt = database.db.prepare(`
      SELECT version, name, checksum, from_fingerprint, to_fingerprint,
             down_policy, applied_at
      FROM ${RECEIPT_TABLE}
      WHERE version = 29
    `).get();
    assert.equal(receipt.version, 29);
    assert.match(receipt.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.match(receipt.checksum, /^[0-9a-f]{64}$/);
    assert.match(receipt.from_fingerprint, /^[0-9a-f]{64}$/);
    assert.match(receipt.to_fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(receipt.down_policy.length > 0);
    assert.ok(Number(receipt.applied_at) >= 1);

    const columns = database.db.prepare(`PRAGMA table_xinfo(${EVIDENCE_TABLE})`)
      .all().map((column) => column.name);
    assert.deepEqual(columns, [
      'batch_id',
      'operation_index',
      'op_id',
      'project_id',
      'canvas_id',
      'revision',
      'base_revision',
      'actor_id',
      'session_id',
      'client_seq',
      'type',
      'payload_json',
      'payload_digest',
      'logical_bytes',
      'timestamp',
      'created_at',
    ]);
    const indexes = database.db.prepare(`PRAGMA index_list(${EVIDENCE_TABLE})`).all();
    assert.ok(indexes.some((index) => Number(index.unique) === 1));
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    await database.close();
  }
});

test('B2 Common graph evidence replays exactly after raw operation and base snapshot deletion, hot and cold', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-history-evidence-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const canvasId = 'canvas-history-evidence-b2';
  let database = null;

  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    const initial = seedCanvas(database, canvasId);
    const applied = applyGraphBatch(database, canvasId, {
      clientSeq: 10,
      x: 100,
      y: 200,
    });
    const rows = evidenceRows(database, applied.batch.batchId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operation_index, 0);
    assert.equal(rows[0].op_id, applied.batch.operations[0].opId);
    assert.equal(rows[0].revision, applied.result.document.revision);
    assert.equal(rows[0].actor_id, ACTOR_ID);
    assert.equal(rows[0].session_id, SESSION_ID);
    assert.equal(rows[0].client_seq, applied.adapted.operations[0].clientSeq);
    assert.equal(rows[0].type, applied.adapted.operations[0].type);
    assert.deepEqual(JSON.parse(rows[0].payload_json), applied.adapted.operations[0].payload);
    assert.match(rows[0].payload_digest, /^[0-9a-f]{64}$/);
    assert.equal(rows[0].timestamp, applied.adapted.operations[0].timestamp);
    assert.ok(Number(rows[0].logical_bytes) >= Buffer.byteLength(rows[0].payload_json, 'utf8'));

    database.db.prepare('DELETE FROM canvas_operations WHERE op_id = ?')
      .run(applied.batch.operations[0].opId);
    database.db.prepare(`
      DELETE FROM canvas_snapshot_pins WHERE canvas_id = ? AND snapshot_revision = ?
    `).run(canvasId, initial.revision);
    database.db.prepare(`
      DELETE FROM canvas_snapshots WHERE canvas_id = ? AND revision = ?
    `).run(canvasId, initial.revision);
    assert.equal(database.db.prepare(`
      SELECT 1 FROM canvas_operations WHERE op_id = ?
    `).get(applied.batch.operations[0].opId), undefined);
    assert.equal(database.db.prepare(`
      SELECT 1 FROM canvas_snapshots WHERE canvas_id = ? AND revision = ?
    `).get(canvasId, initial.revision), undefined);

    const stateBeforeReplay = atomicState(database, canvasId);
    const hotReplay = database.replayCommonOperationBatch(applied.batch, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
    });
    assert.deepEqual(hotReplay.operations, applied.adapted.operations);
    assert.deepEqual(hotReplay.acknowledgements.map((item) => ({
      opId: item.opId,
      revision: item.revision,
      duplicate: item.duplicate,
    })), [{
      opId: applied.batch.operations[0].opId,
      revision: applied.result.document.revision,
      duplicate: true,
    }]);
    assert.deepEqual(atomicState(database, canvasId), stateBeforeReplay);

    await database.close();
    database = null;
    database = new ProjectDatabase(filename, { autoBackup: false });
    const coldReplay = database.replayCommonOperationBatch(applied.batch, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
    });
    assert.deepEqual(coldReplay.operations, applied.adapted.operations);
    assert.equal(coldReplay.acknowledgements[0].duplicate, true);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    await closeQuietly(database);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('B2 missing or tampered Common graph evidence fails closed without mutation', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const missingCanvasId = 'canvas-history-evidence-missing-b2';
  const tamperedCanvasId = 'canvas-history-evidence-tampered-b2';
  const bindingCanvasId = 'canvas-history-evidence-binding-b2';
  const timestampCanvasId = 'canvas-history-evidence-timestamp-b2';
  const globalIdentityCanvasId = 'canvas-history-evidence-global-identity-b2';

  try {
    seedCanvas(database, missingCanvasId);
    const missing = applyGraphBatch(database, missingCanvasId, { clientSeq: 20, x: 20 });
    database.db.prepare(`DELETE FROM ${EVIDENCE_TABLE} WHERE batch_id = ?`)
      .run(missing.batch.batchId);
    const missingState = atomicState(database, missingCanvasId);
    assert.throws(
      () => database.replayCommonOperationBatch(missing.batch, {
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
      (error) => error instanceof OperationBatchConflictError,
    );
    assert.deepEqual(atomicState(database, missingCanvasId), missingState);

    seedCanvas(database, tamperedCanvasId);
    const tampered = applyGraphBatch(database, tamperedCanvasId, { clientSeq: 30, x: 30 });
    const triggerNames = database.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = ?
    `).all(EVIDENCE_TABLE).map((row) => row.name);
    triggerNames.forEach((name) => database.db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`));
    const stored = evidenceRows(database, tampered.batch.batchId)[0];
    const payload = JSON.parse(stored.payload_json);
    if (payload?.position) payload.position.x = Number(payload.position.x) + 1;
    else if (payload?.payload?.position) payload.payload.position.x = Number(payload.payload.position.x) + 1;
    else assert.fail('resolved graph evidence does not contain a position payload');
    const payloadJson = JSON.stringify(payload);
    database.db.prepare(`
      UPDATE ${EVIDENCE_TABLE}
      SET payload_json = ?, logical_bytes = logical_bytes - length(CAST(payload_json AS BLOB))
        + length(CAST(? AS BLOB))
      WHERE batch_id = ? AND operation_index = 0
    `).run(payloadJson, payloadJson, tampered.batch.batchId);
    const tamperedState = atomicState(database, tamperedCanvasId);
    assert.throws(
      () => database.replayCommonOperationBatch(tampered.batch, {
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
      (error) => error instanceof OperationBatchConflictError,
    );
    assert.deepEqual(atomicState(database, tamperedCanvasId), tamperedState);

    seedCanvas(database, bindingCanvasId);
    const binding = applyGraphBatch(database, bindingCanvasId, { clientSeq: 40, x: 40 });
    const identityTriggerNames = database.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = 'canvas_operation_idempotency'
    `).all().map((row) => row.name);
    identityTriggerNames.forEach((name) => database.db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`));
    const storedBinding = evidenceRows(database, binding.batch.batchId)[0];
    const forgedOperation = {
      opId: storedBinding.op_id,
      projectId: storedBinding.project_id,
      canvasId: storedBinding.canvas_id,
      baseRevision: Number(storedBinding.base_revision) + 7,
      actorId: `${ACTOR_ID}-forged`,
      sessionId: `${SESSION_ID}-forged`,
      clientSeq: Number(storedBinding.client_seq) + 11,
      type: storedBinding.type,
      payload: JSON.parse(storedBinding.payload_json),
      timestamp: Number(storedBinding.timestamp),
    };
    const forgedLogicalBytes = database._commonEvidenceLogicalBytes({
      ...forgedOperation,
      revision: Number(storedBinding.revision),
    });
    database.db.prepare(`
      UPDATE ${EVIDENCE_TABLE}
      SET base_revision = ?, actor_id = ?, session_id = ?, client_seq = ?, logical_bytes = ?
      WHERE batch_id = ? AND operation_index = 0
    `).run(
      forgedOperation.baseRevision,
      forgedOperation.actorId,
      forgedOperation.sessionId,
      forgedOperation.clientSeq,
      forgedLogicalBytes,
      binding.batch.batchId,
    );
    database.db.prepare(`
      UPDATE canvas_operation_idempotency
      SET base_revision = ?, actor_id = ?, session_id = ?, client_seq = ?
      WHERE op_id = ?
    `).run(
      forgedOperation.baseRevision,
      forgedOperation.actorId,
      forgedOperation.sessionId,
      forgedOperation.clientSeq,
      binding.batch.operations[0].opId,
    );
    const bindingState = atomicState(database, bindingCanvasId);
    assert.throws(
      () => database.replayCommonOperationBatch(binding.batch, {
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
      (error) => error instanceof OperationBatchConflictError,
    );
    assert.deepEqual(atomicState(database, bindingCanvasId), bindingState);

    seedCanvas(database, timestampCanvasId);
    const timestampBinding = applyGraphBatch(database, timestampCanvasId, { clientSeq: 50, x: 50 });
    const storedTimestamp = evidenceRows(database, timestampBinding.batch.batchId)[0];
    const timestampOperation = {
      opId: storedTimestamp.op_id,
      projectId: storedTimestamp.project_id,
      canvasId: storedTimestamp.canvas_id,
      baseRevision: Number(storedTimestamp.base_revision),
      actorId: storedTimestamp.actor_id,
      sessionId: storedTimestamp.session_id,
      clientSeq: Number(storedTimestamp.client_seq),
      type: storedTimestamp.type,
      payload: JSON.parse(storedTimestamp.payload_json),
      timestamp: Number(storedTimestamp.timestamp) + 23,
    };
    const timestampLogicalBytes = database._commonEvidenceLogicalBytes({
      ...timestampOperation,
      revision: Number(storedTimestamp.revision),
    });
    database.db.prepare(`
      UPDATE ${EVIDENCE_TABLE}
      SET timestamp = ?, logical_bytes = ?
      WHERE batch_id = ? AND operation_index = 0
    `).run(
      timestampOperation.timestamp,
      timestampLogicalBytes,
      timestampBinding.batch.batchId,
    );
    const timestampState = atomicState(database, timestampCanvasId);
    assert.throws(
      () => database.replayCommonOperationBatch(timestampBinding.batch, {
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
      (error) => error instanceof OperationBatchConflictError,
    );
    assert.deepEqual(atomicState(database, timestampCanvasId), timestampState);

    seedCanvas(database, globalIdentityCanvasId);
    const globalBinding = applyGraphBatch(database, globalIdentityCanvasId, { clientSeq: 60, x: 60 });
    database.db.exec('DROP TRIGGER trg_permanent_ledger_operation_identity_delete_guard');
    assert.equal(database.db.prepare(`
      DELETE FROM collaboration_operation_identities WHERE op_id = ?
    `).run(globalBinding.batch.operations[0].opId).changes, 1);
    const globalIdentityState = atomicState(database, globalIdentityCanvasId);
    assert.throws(
      () => database.replayCommonOperationBatch(globalBinding.batch, {
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
      (error) => error instanceof OperationBatchConflictError,
    );
    assert.deepEqual(atomicState(database, globalIdentityCanvasId), globalIdentityState);
  } finally {
    await database.close();
  }
});

test('B2 bounded raw history compacts Common operations without an all-ledger scan', async () => {
  const canvasId = 'canvas-history-no-common-scan-b2';
  const clientId = crypto.randomUUID();
  const policy = {
    maxRawOperationRows: 2,
    maxRawOperationBytes: 4 * 1024,
    maxCommonEvidenceRows: 100,
    maxCommonEvidenceBytes: 4 * 1024 * 1024,
    maxSnapshotRows: 50,
    maxSnapshotBytes: 4 * 1024 * 1024,
    maxPinRows: 50,
  };
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasHistoryPolicy: policy,
  });

  try {
    seedCanvas(database, canvasId);
    for (let index = 1; index <= 12; index += 1) {
      applyGraphBatch(database, canvasId, {
        clientId,
        clientSeq: index,
        x: index,
        y: index + 1,
      });
    }
    assert.equal(tableCount(database.db, 'collaboration_common_operation_batches', canvasId), 12);
    assert.equal(tableCount(database.db, EVIDENCE_TABLE, canvasId), 12);
    assert.ok(tableCount(database.db, 'canvas_operations', canvasId) <= policy.maxRawOperationRows);
    const rawPayloadBytes = Number(database.db.prepare(`
      SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes
      FROM canvas_operations WHERE canvas_id = ?
    `).get(canvasId).bytes);
    assert.ok(rawPayloadBytes <= policy.maxRawOperationBytes);

    const scannedSql = [];
    const nativeDatabase = database.db;
    database.db = new Proxy(nativeDatabase, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql, ...args) => {
            const normalized = String(sql).replace(/\s+/g, ' ').trim();
            if (/FROM collaboration_common_operation_batches(?:\s+batch)?/i.test(normalized)
              && /operation_ids_json/i.test(normalized)
              && !/batch_id\s*=\s*\?/i.test(normalized)
              && !/client_id\s*=\s*\?/i.test(normalized)) {
              scannedSql.push(normalized);
            }
            return target.prepare(sql, ...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    applyGraphBatch(database, canvasId, {
      clientId,
      clientSeq: 13,
      x: 13,
      y: 14,
    });
    database.db = nativeDatabase;
    assert.deepEqual(scannedSql, []);
    assert.ok(tableCount(database.db, 'canvas_operations', canvasId) <= policy.maxRawOperationRows);
    assert.equal(tableCount(database.db, EVIDENCE_TABLE, canvasId), 13);
  } finally {
    await database.close();
  }
});

test('B2 Common evidence quota rejects one row over capacity with every write rolled back', async () => {
  const canvasId = 'canvas-history-evidence-quota-b2';
  const clientId = crypto.randomUUID();
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasHistoryPolicy: {
      maxRawOperationRows: 100,
      maxRawOperationBytes: 4 * 1024 * 1024,
      maxCommonEvidenceRows: 1,
      maxCommonEvidenceBytes: 4 * 1024 * 1024,
      maxSnapshotRows: 50,
      maxSnapshotBytes: 4 * 1024 * 1024,
      maxPinRows: 50,
    },
  });

  try {
    seedCanvas(database, canvasId);
    applyGraphBatch(database, canvasId, { clientId, clientSeq: 1, x: 1, y: 2 });
    const before = atomicState(database, canvasId);
    const rejected = buildGraphBatch(database, canvasId, {
      clientId,
      clientSeq: 2,
      x: 2,
      y: 3,
    });
    assert.throws(
      () => database.applyOperations(canvasId, rejected.adapted.operations, {
        expectedRevision: rejected.batch.baseRevision,
        commonBatch: rejected.batch,
        requireTimestampIdentity: false,
      }),
      (error) => error?.code === 'common_operation_evidence_capacity_exceeded'
        && Number(error.status ?? error.statusCode) === 507,
    );
    assert.deepEqual(atomicState(database, canvasId), before);
    assert.equal(database.getCanvasOperationIdentity(rejected.batch.operations[0].opId), undefined);
    assert.equal(database.getCollaborationOperationIdentity(rejected.batch.operations[0].opId), null);
    assert.equal(database.getCommonOperationBatch({ batchId: rejected.batch.batchId }), null);
  } finally {
    await database.close();
  }
});

test('B2 schema 28 with complete Common raw history backfills v29 evidence and receipt atomically', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-history-v29-backfill-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const canvasId = 'canvas-history-v29-backfill-b2';
  let database = null;

  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    seedCanvas(database, canvasId);
    const applied = applyGraphBatch(database, canvasId, { clientSeq: 40, x: 40, y: 41 });
    assert.equal(evidenceRows(database, applied.batch.batchId).length, 1);
    await database.close();
    database = null;

    const raw = new BetterSqlite3(filename);
    assert.equal(raw.prepare(`
      SELECT COUNT(*) AS count FROM canvas_operations WHERE op_id = ?
    `).get(applied.batch.operations[0].opId).count, 1);
    removeV29Objects(raw);
    raw.pragma('wal_checkpoint(TRUNCATE)');
    assert.equal(raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 28);
    assert.equal(tableExists(raw, EVIDENCE_TABLE), false);
    assert.equal(tableExists(raw, RECEIPT_TABLE), false);
    raw.close();
    fs.rmSync(`${filename}.pre-migration-v30.sqlite3`, { force: true });

    database = new ProjectDatabase(filename, { autoBackup: false });
    assertCurrentProjectDatabaseRegistry(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATIONS);
    assert.equal(
      database.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      PROJECT_DATABASE_SCHEMA_VERSION,
    );
    assert.ok(database.db.prepare(`
      SELECT 1 FROM ${RECEIPT_TABLE} WHERE version = 29
    `).get());
    const backfilled = evidenceRows(database, applied.batch.batchId);
    assert.equal(backfilled.length, 1);
    assert.equal(backfilled[0].op_id, applied.batch.operations[0].opId);
    assert.deepEqual(JSON.parse(backfilled[0].payload_json), applied.adapted.operations[0].payload);
    const replay = database.replayCommonOperationBatch(applied.batch, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
    });
    assert.deepEqual(replay.operations, applied.adapted.operations);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    await closeQuietly(database);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('B2 schema 28 multi-operation domain Common batches migrate without graph evidence', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-history-v29-domain-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const canvasId = 'canvas-history-v29-domain-b2';
  const projectId = PROJECT_ID;
  const batch = {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId,
    canvasId,
    baseRevision: 1,
    batchId: 'b2000000-0000-4000-8000-000000000001',
    clientId: 'b2000000-0000-4000-8000-000000000002',
    clientSeq: 1,
    operations: [
      {
        opId: 'b2000000-0000-4000-8000-000000000003',
        type: 'review.thread.create',
        payload: {
          threadUid: 'b2000000-0000-4000-8000-000000000004',
          expectedCanvasRevision: 1,
          anchor: { kind: 'canvas', x: 10, y: 20 },
          severity: 'high',
          initialComment: {
            commentUid: 'b2000000-0000-4000-8000-000000000005',
            body: 'schema 28 domain migration first comment',
          },
        },
      },
      {
        opId: 'b2000000-0000-4000-8000-000000000006',
        type: 'review.comment.add',
        payload: {
          threadUid: 'b2000000-0000-4000-8000-000000000004',
          commentUid: 'b2000000-0000-4000-8000-000000000007',
          parentCommentUid: 'b2000000-0000-4000-8000-000000000005',
          expectedCanvasRevision: 1,
          expectedThreadRevision: 1,
          body: 'schema 28 domain migration reply',
        },
      },
    ],
  };
  const principal = {
    memberId: ACTOR_ID,
    sessionId: SESSION_ID,
    capabilities: ['comment'],
  };
  let database = null;

  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    seedCanvas(database, canvasId);
    const applied = database.applyCommonReviewBatch(batch, { principal });
    assert.equal(applied.results.length, 2);
    assert.equal(tableCount(database.db, EVIDENCE_TABLE, canvasId), 0);
    assert.equal(tableCount(database.db, 'collaboration_domain_operation_idempotency', canvasId), 2);
    await database.close();
    database = null;

    const raw = new BetterSqlite3(filename);
    removeV29Objects(raw);
    raw.pragma('wal_checkpoint(TRUNCATE)');
    assert.equal(raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 28);
    raw.close();
    fs.rmSync(`${filename}.pre-migration-v30.sqlite3`, { force: true });

    database = new ProjectDatabase(filename, { autoBackup: false });
    assert.equal(
      database.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      PROJECT_DATABASE_SCHEMA_VERSION,
    );
    assert.equal(tableCount(database.db, EVIDENCE_TABLE, canvasId), 0);
    assert.equal(tableCount(database.db, 'collaboration_domain_operation_idempotency', canvasId), 2);
    const replay = database.replayCommonDomainBatch(batch, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.results.length, 2);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    await closeQuietly(database);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('B2 schema 28 Common evidence migration rolls back completely when one raw operation is missing', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-history-v29-missing-raw-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const canvasId = 'canvas-history-v29-missing-raw-b2';
  let database = null;

  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    seedCanvas(database, canvasId);
    const applied = applyGraphBatch(database, canvasId, { clientSeq: 50, x: 50, y: 51 });
    await database.close();
    database = null;

    const raw = new BetterSqlite3(filename);
    raw.prepare('DELETE FROM canvas_operations WHERE op_id = ?')
      .run(applied.batch.operations[0].opId);
    removeV29Objects(raw);
    raw.pragma('wal_checkpoint(TRUNCATE)');
    const before = directDatabaseState(raw, canvasId);
    assert.equal(before.rawOperations, 0);
    assert.equal(raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 28);
    raw.close();
    fs.rmSync(`${filename}.pre-migration-v30.sqlite3`, { force: true });

    assert.throws(
      () => new ProjectDatabase(filename, { autoBackup: false }),
      (error) => error?.code === 'common_operation_evidence_backfill_missing_raw'
        || /Common|evidence|原始 operation|raw operation/i.test(String(error?.message || '')),
    );

    const verify = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
    assert.equal(verify.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 28);
    assert.equal(tableExists(verify, EVIDENCE_TABLE), false);
    assert.equal(tableExists(verify, RECEIPT_TABLE), false);
    assert.deepEqual(directDatabaseState(verify, canvasId), before);
    assert.equal(verify.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(verify.pragma('foreign_key_check'), []);
    verify.close();
  } finally {
    await closeQuietly(database);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
