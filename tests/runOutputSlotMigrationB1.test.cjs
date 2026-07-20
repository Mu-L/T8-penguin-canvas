const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const BetterSqlite3 = require('better-sqlite3');

const {
  COMMON_OPERATION_BATCH_CONTRACT,
} = require('../backend/src/collaboration/commonOperationProtocol');
const { stableEntityUuid } = require('../backend/src/collaboration/protocol');
const {
  PROJECT_DATABASE_MIGRATIONS,
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
  ProjectDatabaseSchemaInvalidError,
} = require('../backend/src/services/projectDatabase');
const {
  PROJECT_DATABASE_MIGRATION_29_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration29');
const {
  PROJECT_DATABASE_MIGRATION_30_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration30');
const {
  PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS,
} = require('../backend/src/services/projectDatabaseMigration31');
const {
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS,
} = require('../backend/src/services/projectDatabaseMigration31DurableLedgers');
const {
  assertCurrentProjectDatabaseRegistry,
  stripSchema32ForSyntheticSchema31,
} = require('./helpers/projectDatabaseVersion.cjs');

const HOST_IDENTITY = Object.freeze({ actorId: 'host-executor', sessionId: 'host-authority' });
const NODE_UID = 'a7000000-0000-4000-8000-000000000001';

function makeDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { directory, filename: path.join(directory, 'projects.sqlite3') };
}

function quoteSqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

// TEST-ONLY fixture teardown. Production schema31 DOWN remains backup-only.
function removeSchema31ExtensionForSyntheticSchema30(database) {
  stripSchema32ForSyntheticSchema31(database);
  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      for (const name of [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS.triggers].reverse()) {
        database.exec(`DROP TRIGGER IF EXISTS ${quoteSqlIdentifier(name)}`);
      }
      for (const name of [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS.views].reverse()) {
        database.exec(`DROP VIEW IF EXISTS ${quoteSqlIdentifier(name)}`);
      }
      for (const name of [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS.indexes].reverse()) {
        database.exec(`DROP INDEX IF EXISTS ${quoteSqlIdentifier(name)}`);
      }
      for (const name of [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS.tables].reverse()) {
        database.exec(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(name)}`);
      }
      database.prepare('DELETE FROM schema_migration_receipts WHERE version = 31').run();
      database.prepare('DELETE FROM schema_migrations WHERE version = 31').run();
    }).immediate();
  } finally {
    database.pragma('foreign_keys = ON');
  }
  assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 30);
  assert.deepEqual(database.pragma('foreign_key_check'), []);
}

// TEST-ONLY corruption fixture. Schema30/31 guards correctly reject these
// direct deletes while the canvas is live, so temporarily remove the exact
// guards, let the common-batch FK cascade run, then restore byte-identical DDL
// before the database is closed. The following cold-open failure must therefore
// come from broken host slot/commit authority, not a missing schema object.
function deleteCommonBatchKeepingLiveHostOwner(database, batchId) {
  const guardNames = [
    'trg_permanent_ledger_common_batch_delete_guard',
    'trg_permanent_ledger_domain_idempotency_delete_guard',
    'trg_durable_ledger_run_output_commit_direct_delete_guard',
  ];
  const guards = guardNames.map((name) => {
    const row = database.db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name = ?
    `).get(name);
    assert.equal(row?.name, name);
    assert.match(String(row?.sql || ''), /^CREATE TRIGGER /);
    return row;
  });
  const tamper = database.db.transaction(() => {
    for (const guard of guards) {
      database.db.exec(`DROP TRIGGER ${quoteSqlIdentifier(guard.name)}`);
    }
    const deleted = database.db.prepare(`
      DELETE FROM collaboration_common_operation_batches WHERE batch_id = ?
    `).run(batchId);
    for (const guard of guards) database.db.exec(guard.sql);
    return deleted;
  });
  const deleted = tamper.immediate();
  assert.equal(deleted.changes, 1);
  for (const guard of guards) {
    assert.equal(database.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
    `).get(guard.name)?.sql, guard.sql);
  }
}

function createRunFixture(database, suffix = '', identities = {}) {
  const projectId = `project-slot${suffix}`;
  const canvasId = `canvas-slot${suffix}`;
  const document = database.ensureCanvas(canvasId, {
    projectId,
    nodes: [{
      id: 'node-display',
      entityUid: NODE_UID,
      entityRevision: 1,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { prompt: 'slot migration' },
    }],
    edges: [],
  }, projectId);
  const run = database.createRun({
    id: 'run-display',
    entityUid: identities.runEntityUid,
    projectId,
    canvasId,
    canvasRevision: document.revision,
    status: 'running',
  });
  const nodeRun = database.createNodeRun({
    id: 'node-run-display',
    entityUid: identities.nodeRunEntityUid,
    runId: run.id,
    nodeId: 'node-display',
    originalNodeId: 'node-display',
    status: 'running',
    inputSnapshot: {
      node: { id: 'node-display', entityUid: NODE_UID, type: 'text', data: { prompt: 'slot migration' } },
    },
  });
  const attempt = database.createAttempt({
    id: 'attempt-display',
    entityUid: identities.attemptEntityUid,
    nodeRunId: nodeRun.id,
    provider: 'host-local',
    model: 'slot-test',
    status: 'running',
  });
  return { document, run, nodeRun, attempt };
}

function hostArtifactInput(database, fixture, text, outputOrdinal = 0) {
  const run = database.getRun(fixture.run.id);
  const nodeRun = database.getNodeRun(fixture.nodeRun.id);
  const attempt = database.getAttempt(fixture.attempt.id);
  const contentHash = crypto.createHash('sha256').update(text).digest('hex');
  const artifactUid = stableEntityUuid('t8-host-artifact-v1', attempt.entityUid, outputOrdinal);
  const opId = stableEntityUuid('t8-host-artifact-operation-v1', attempt.entityUid, outputOrdinal);
  const blobUid = stableEntityUuid('t8-asset-blob-v1', 'sha256', contentHash);
  const artifact = {
    opId,
    artifactUid,
    blobUid,
    contentHash,
    byteSize: Buffer.byteLength(text),
    kind: 'text',
    filename: `slot-${outputOrdinal}.txt`,
    mimeType: 'text/plain',
    storageKey: `sha256/${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}`,
    managedPath: path.join('C:\\host-private-cas', contentHash),
    outputOrdinal,
    metadata: { size: Buffer.byteLength(text), health: 'ok' },
  };
  const batch = {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: run.projectId,
    canvasId: run.canvasId,
    baseRevision: fixture.document.revision,
    batchId: stableEntityUuid('t8-host-artifact-batch-v1', run.entityUid, nodeRun.entityUid, attempt.entityUid, outputOrdinal),
    clientId: stableEntityUuid('t8-host-artifact-client-v1', run.entityUid, nodeRun.entityUid, attempt.entityUid),
    clientSeq: outputOrdinal,
    operations: [{
      opId,
      type: 'host.artifact.commit',
      payload: {
        artifactUid,
        blobUid,
        runUid: run.entityUid,
        nodeRunUid: nodeRun.entityUid,
        attemptUid: attempt.entityUid,
        nodeUid: NODE_UID,
        expectedCanvasRevision: fixture.document.revision,
        expectedRunRevision: run.revision,
        expectedNodeRunRevision: nodeRun.revision,
        expectedAttemptRevision: attempt.revision,
        outputOrdinal,
        kind: artifact.kind,
        contentHash,
        byteSize: artifact.byteSize,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
      },
    }],
  };
  return { batch, artifact };
}

function applyHostArtifact(database, fixture, text, outputOrdinal = 0) {
  const input = hostArtifactInput(database, fixture, text, outputOrdinal);
  return {
    ...input,
    applied: database.applyCommonHostArtifactBatch(input.batch, {
      hostIdentity: HOST_IDENTITY,
      verifiedArtifacts: [input.artifact],
    }),
  };
}

function hostArtifactBatchInput(database, fixture, texts) {
  assert.ok(Array.isArray(texts) && texts.length > 1);
  const inputs = texts.map((text, outputOrdinal) => (
    hostArtifactInput(database, fixture, text, outputOrdinal)
  ));
  const first = inputs[0].batch;
  const firstPayload = first.operations[0].payload;
  const batch = {
    ...first,
    batchId: stableEntityUuid(
      't8-host-artifact-multi-batch-v1',
      fixture.run.entityUid,
      fixture.nodeRun.entityUid,
      fixture.attempt.entityUid,
      texts.length,
    ),
    clientId: stableEntityUuid(
      't8-host-artifact-multi-client-v1',
      fixture.run.entityUid,
      fixture.nodeRun.entityUid,
      fixture.attempt.entityUid,
    ),
    clientSeq: 0,
    operations: inputs.map((input, operationIndex) => ({
      ...input.batch.operations[0],
      payload: {
        ...input.batch.operations[0].payload,
        expectedRunRevision: firstPayload.expectedRunRevision + operationIndex,
        expectedNodeRunRevision: firstPayload.expectedNodeRunRevision + operationIndex,
        expectedAttemptRevision: firstPayload.expectedAttemptRevision + operationIndex,
      },
    })),
  };
  return { batch, artifacts: inputs.map((input) => input.artifact) };
}

function applyHostArtifactBatch(database, fixture, texts) {
  const input = hostArtifactBatchInput(database, fixture, texts);
  return {
    ...input,
    applied: database.applyCommonHostArtifactBatch(input.batch, {
      hostIdentity: HOST_IDENTITY,
      verifiedArtifacts: input.artifacts,
    }),
  };
}

function rebuiltCanvasSnapshot(projectId) {
  return {
    projectId,
    nodes: [{
      id: 'node-display',
      entityUid: NODE_UID,
      entityRevision: 1,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { prompt: 'rebuilt canvas' },
    }],
    edges: [],
  };
}

function hostArtifactAuditRows(database, projectId, canvasId, batchId) {
  return database.db.prepare(`
    SELECT id, metadata_json, created_at
    FROM audit_events
    WHERE project_id = ? AND canvas_id = ? AND action = 'host.artifact.commit'
      AND json_extract(metadata_json, '$.batchId') = ?
    ORDER BY created_at ASC, id ASC
  `).all(projectId, canvasId, batchId).map((row) => ({
    id: Number(row.id),
    metadata: JSON.parse(row.metadata_json),
    createdAt: Number(row.created_at),
  }));
}

function assertCanvasIdentityRetained(callback) {
  assert.throws(callback, (error) => (
    error?.code === 'canvas_identity_retained'
      && error.status === 409
  ));
}

function durableRowCount(database, projectId, ledgerKind) {
  return Number(database.db.prepare(`
    SELECT row_count FROM project_durable_ledger_usage
    WHERE project_id = ? AND ledger_kind = ?
  `).get(projectId, ledgerKind)?.row_count || 0);
}

function globalDurableRowCount(database, ledgerKind) {
  return Number(database.db.prepare(`
    SELECT row_count FROM database_durable_ledger_usage
    WHERE singleton_id = 1 AND ledger_kind = ?
  `).get(ledgerKind)?.row_count || 0);
}

function stripSlotReservations(filename, mutation = null) {
  const raw = new BetterSqlite3(filename);
  try {
    raw.pragma('foreign_keys = ON');
    removeSchema31ExtensionForSyntheticSchema30(raw);
    raw.prepare('DELETE FROM schema_migration_receipts WHERE version = 30').run();
    raw.prepare('DELETE FROM schema_migrations WHERE version = 30').run();
    raw.exec(PROJECT_DATABASE_MIGRATION_30_DOWN_SQL);
    raw.exec(PROJECT_DATABASE_MIGRATION_29_DOWN_SQL);
    raw.prepare('DELETE FROM schema_migrations WHERE version = 29').run();
    assert.deepEqual(raw.pragma('foreign_key_check'), []);
    if (mutation) mutation(raw);
    raw.exec('DROP TABLE run_output_slot_reservations');
    raw.prepare('DELETE FROM schema_migrations WHERE version >= 26').run();
    assert.equal(raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 25);
  } finally {
    raw.close();
  }
  fs.rmSync(`${filename}.pre-migration-v30.sqlite3`, { force: true });
}

test('legacy lineage plus AssetRefs upgrade to one unverified immutable slot and reject a host overwrite across reopen', () => {
  const { directory, filename } = makeDirectory('t8-legacy-output-slot-');
  let fixture;
  try {
    const seed = new ProjectDatabase(filename, { autoBackup: false });
    try {
      fixture = createRunFixture(seed, '-legacy');
      const recorded = seed.recordRunOutputAssets({
        runId: fixture.run.id,
        nodeRunId: fixture.nodeRun.id,
        attemptId: fixture.attempt.id,
        outputs: [{ kind: 'text', text: 'legacy output', filename: 'legacy.txt', mimeType: 'text/plain' }],
      });
      assert.equal(recorded.assets.length, 1);
      assert.equal(seed.db.prepare('SELECT COUNT(*) AS count FROM run_output_slot_reservations').get().count, 0);
    } finally {
      seed.close();
    }
    stripSlotReservations(filename);

    const migrated = new ProjectDatabase(filename, { autoBackup: false });
    try {
      const reservation = migrated.getRunOutputSlotReservation(fixture.attempt.entityUid, 0);
      assert.equal(reservation.reservationState, 'legacy-unverified');
      assert.equal(reservation.evidenceSource, 'legacy-mixed');
      assert.equal(reservation.attemptId, fixture.attempt.id);
      assert.equal(reservation.assetId, migrated.getNodeRun(fixture.nodeRun.id).outputRefs[0]);
      assert.equal(migrated.db.prepare('SELECT COUNT(*) AS count FROM run_output_commits').get().count, 0);
      assert.throws(() => applyHostArtifact(migrated, fixture, 'replacement output'), (error) => (
        error?.code === 'host_artifact_output_slot_conflict' && error?.status === 409
      ));
      assert.equal(migrated.db.prepare('SELECT COUNT(*) AS count FROM run_output_commits').get().count, 0);
      assert.equal(migrated.db.prepare('SELECT COUNT(*) AS count FROM collaboration_common_operation_batches').get().count, 0);
    } finally {
      migrated.close();
    }

    const reopened = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(reopened.getRunOutputSlotReservation(fixture.attempt.entityUid, 0).reservationState, 'legacy-unverified');
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM run_output_slot_reservations').get().count, 1);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='run-output.legacy-slot-ambiguous'").get().count, 0);
      assert.equal(reopened.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(reopened.db.pragma('foreign_key_check'), []);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('duplicate legacy lineage candidates seal one ambiguous slot, audit once, and stay immutable on reopen', () => {
  const { directory, filename } = makeDirectory('t8-ambiguous-output-slot-');
  let fixture;
  try {
    const seed = new ProjectDatabase(filename, { autoBackup: false });
    try {
      fixture = createRunFixture(seed, '-ambiguous');
      seed.recordRunOutputAssets({
        runId: fixture.run.id,
        nodeRunId: fixture.nodeRun.id,
        attemptId: fixture.attempt.id,
        outputs: [
          { kind: 'text', text: 'legacy a', filename: 'a.txt', mimeType: 'text/plain' },
          { kind: 'text', text: 'legacy b', filename: 'b.txt', mimeType: 'text/plain' },
        ],
      });
    } finally {
      seed.close();
    }
    stripSlotReservations(filename, (raw) => {
      const secondAssetId = JSON.parse(raw.prepare('SELECT output_refs_json FROM node_runs WHERE id = ?').get(fixture.nodeRun.id).output_refs_json)[1];
      raw.prepare('UPDATE asset_lineage_events SET output_ordinal = 0 WHERE asset_id = ?').run(secondAssetId);
    });

    const migrated = new ProjectDatabase(filename, { autoBackup: false });
    try {
      const ambiguous = migrated.getRunOutputSlotReservation(fixture.attempt.entityUid, 0);
      assert.equal(ambiguous.reservationState, 'legacy-ambiguous');
      assert.equal(ambiguous.evidenceSource, 'legacy-mixed');
      assert.equal(ambiguous.assetId, null);
      assert.equal(ambiguous.assetEntityUid, null);
      assert.equal(ambiguous.evidenceCount >= 3, true);
      const audit = migrated.db.prepare(`
        SELECT metadata_json FROM audit_events
        WHERE action = 'run-output.legacy-slot-ambiguous'
      `).get();
      assert.equal(JSON.parse(audit.metadata_json).candidateCount, 2);
      assert.throws(() => migrated.db.prepare(`
        UPDATE run_output_slot_reservations SET evidence_count = evidence_count + 1
      `).run(), /immutable/);
      assert.throws(() => migrated.db.prepare(`
        DELETE FROM run_output_slot_reservations WHERE attempt_entity_uid = ? AND output_ordinal = 0
      `).run(fixture.attempt.entityUid), (error) => (
        error?.code === 'SQLITE_CONSTRAINT_TRIGGER'
        && error?.message === PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.directDelete.sqliteMessage
      ));
      assert.throws(() => applyHostArtifact(migrated, fixture, 'must not overwrite ambiguous legacy'), (error) => (
        error?.code === 'host_artifact_output_slot_conflict'
      ));
    } finally {
      migrated.close();
    }

    const reopened = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(reopened.getRunOutputSlotReservation(fixture.attempt.entityUid, 0).reservationState, 'legacy-ambiguous');
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='run-output.legacy-slot-ambiguous'").get().count, 1);
      assert.equal(reopened.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(reopened.db.pragma('foreign_key_check'), []);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('exact host replay fails closed when the live NodeRun outputRefs no longer match its immutable commit', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const fixture = createRunFixture(database, '-replay');
    const committed = applyHostArtifact(database, fixture, 'replay consistency');
    assert.equal(committed.applied.duplicate, false);
    database.db.prepare(`
      UPDATE node_runs SET output_refs_json = '[]', revision = revision + 1
      WHERE id = ?
    `).run(fixture.nodeRun.id);
    assert.throws(() => database.applyCommonHostArtifactBatch(committed.batch, {
      hostIdentity: HOST_IDENTITY,
      verifiedArtifacts: [committed.artifact],
    }), (error) => (
      error?.code === 'host_artifact_replay_inconsistent'
      && error?.status === 409
      && /outputRefs/.test(error.message)
    ));
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM run_output_commits').get().count, 1);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM run_output_slot_reservations').get().count, 1);
  } finally {
    database.close();
  }
});

test('source descriptor digest is frozen without plaintext and exact replay rejects a different signed source', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const fixture = createRunFixture(database, '-source-digest');
    const input = hostArtifactInput(database, fixture, 'signed source bytes');
    const sourceDescriptorDigest = crypto.createHash('sha256')
      .update('https://signed.example/object?token=one\nslot-0.txt\ntext')
      .digest('hex');
    input.artifact.sourceDescriptorDigest = sourceDescriptorDigest;
    const applied = database.applyCommonHostArtifactBatch(input.batch, {
      hostIdentity: HOST_IDENTITY,
      verifiedArtifacts: [input.artifact],
    });
    assert.equal(applied.duplicate, false);
    const commit = database.getRunOutputCommitBySlot(fixture.attempt.entityUid, 0);
    const reservation = database.getRunOutputSlotReservation(fixture.attempt.entityUid, 0);
    assert.equal(commit.sourceDescriptorDigest, sourceDescriptorDigest);
    assert.equal(reservation.sourceDescriptorDigest, sourceDescriptorDigest);
    assert.equal(applied.results[0].sourceDescriptorDigest, sourceDescriptorDigest);

    const replay = database.applyCommonHostArtifactBatch(input.batch, {
      hostIdentity: HOST_IDENTITY,
      verifiedArtifacts: [input.artifact],
    });
    assert.equal(replay.duplicate, true);
    const differentSource = {
      ...input.artifact,
      sourceDescriptorDigest: crypto.createHash('sha256')
        .update('https://signed.example/object?token=two\nslot-0.txt\ntext')
        .digest('hex'),
    };
    assert.throws(() => database.applyCommonHostArtifactBatch(input.batch, {
      hostIdentity: HOST_IDENTITY,
      verifiedArtifacts: [differentSource],
    }), (error) => error?.code === 'host_artifact_replay_inconsistent' && error?.status === 409);
    const persisted = JSON.stringify(database.db.prepare(`
      SELECT source_descriptor_digest FROM run_output_commits WHERE op_id = ?
    `).get(input.artifact.opId));
    assert.equal(persisted.includes('token=one'), false);
    assert.equal(persisted.includes('signed.example'), false);
  } finally {
    database.close();
  }
});

test('cold open fails closed when a common batch and its host commit disappear while the exact canvas and Run owner remain', () => {
  const { directory, filename } = makeDirectory('t8-live-owner-missing-host-commit-');
  let database = null;
  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    const fixture = createRunFixture(database, '-live-owner-missing-commit');
    const committed = applyHostArtifact(database, fixture, 'live owner must retain commit');
    assert.equal(committed.applied.duplicate, false);
    assert.equal(database.getRunOutputCommitBySlot(fixture.attempt.entityUid, 0).opId, committed.artifact.opId);
    assert.equal(
      database.getRunOutputSlotReservation(fixture.attempt.entityUid, 0).reservationState,
      'host-verified',
    );

    deleteCommonBatchKeepingLiveHostOwner(database, committed.batch.batchId);
    assert.equal(database.getCanvas(fixture.document.canvasId).projectId, fixture.run.projectId);
    assert.equal(database.getRunByEntityUid(fixture.run.entityUid).id, fixture.run.id);
    assert.equal(database.getNodeRunByEntityUid(fixture.nodeRun.entityUid).id, fixture.nodeRun.id);
    assert.equal(database.getAttemptByEntityUid(fixture.attempt.entityUid).id, fixture.attempt.id);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_common_operation_batches WHERE batch_id = ?
    `).get(committed.batch.batchId).count, 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_domain_operation_idempotency WHERE batch_id = ?
    `).get(committed.batch.batchId).count, 0);
    assert.equal(database.getRunOutputCommitBySlot(fixture.attempt.entityUid, 0), null);
    assert.equal(
      database.getRunOutputSlotReservation(fixture.attempt.entityUid, 0).reservationState,
      'host-verified',
    );
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_operation_identities WHERE op_id = ?
    `).get(committed.artifact.opId).count, 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
    database.close();
    database = null;

    assert.throws(
      () => new ProjectDatabase(filename, { autoBackup: false }),
      (error) => error instanceof ProjectDatabaseSchemaInvalidError
        && error.code === 'project_database_schema_invalid'
        && error.message === 'host-verified output slot 缺少精确 host commit 证据',
    );
  } finally {
    try { if (database) database.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('deleteCanvas permits same-id revision-1 recreation when no retained identity evidence exists', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const canvasId = 'canvas-slot-empty-reusable';
    const projectId = 'project-slot-empty-reusable';
    const first = database.ensureCanvas(canvasId, { nodes: [], edges: [] }, projectId);
    assert.equal(first.revision, 1);

    database.deleteCanvas(canvasId);
    assert.equal(database.getCanvas(canvasId), null);

    const recreated = database.ensureCanvas(canvasId, { nodes: [], edges: [] }, projectId);
    assert.equal(recreated.canvasId, canvasId);
    assert.equal(recreated.projectId, projectId);
    assert.equal(recreated.revision, 1);
  } finally {
    database.close();
  }
});

test('deleteCanvas permanently reserves its retained identity while a fresh canvas id remains cold-openable', () => {
  const { directory, filename } = makeDirectory('t8-deleted-retained-canvas-identity-');
  let database = null;
  let fixture;
  let committed;
  const replacementCanvasId = 'canvas-slot-deleted-retained-canvas-replacement';
  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    fixture = createRunFixture(database, '-deleted-retained-canvas');
    committed = applyHostArtifactBatch(database, fixture, [
      'deleted canvas output zero',
      'deleted canvas output one',
    ]);
    assert.equal(committed.applied.duplicate, false);
    assert.equal(committed.applied.results.length, 2);
    const auditBeforeDelete = hostArtifactAuditRows(
      database,
      fixture.run.projectId,
      fixture.run.canvasId,
      committed.batch.batchId,
    );
    assert.equal(auditBeforeDelete.length, 2);
    assert.equal(auditBeforeDelete[1].createdAt, auditBeforeDelete[0].createdAt + 1);
    auditBeforeDelete.forEach((audit, operationIndex) => {
      assert.equal(audit.metadata.opId, committed.artifacts[operationIndex].opId);
      assert.equal(audit.metadata.batchId, committed.batch.batchId);
      assert.equal(audit.metadata.attemptEntityUid, fixture.attempt.entityUid);
      assert.equal(audit.metadata.outputOrdinal, operationIndex);
    });

    database.deleteCanvas(fixture.run.canvasId);
    assert.equal(database.getCanvas(fixture.run.canvasId), null);
    assert.equal(database.getRunByEntityUid(fixture.run.entityUid).id, fixture.run.id);
    assert.equal(database.getNodeRunByEntityUid(fixture.nodeRun.entityUid).id, fixture.nodeRun.id);
    assert.equal(database.getAttemptByEntityUid(fixture.attempt.entityUid).id, fixture.attempt.id);
    committed.artifacts.forEach((artifact, outputOrdinal) => {
      assert.equal(database.getRunOutputCommitBySlot(fixture.attempt.entityUid, outputOrdinal), null);
      const slot = database.getRunOutputSlotReservation(fixture.attempt.entityUid, outputOrdinal);
      assert.equal(slot.reservationState, 'host-verified');
      assert.equal(slot.evidenceSource, 'host-commit');
      assert.equal(slot.evidenceCount, 1);
      assert.equal(slot.assetEntityUid, artifact.artifactUid);
      assert.equal(slot.contentHash, artifact.contentHash);
    });
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_common_operation_batches
      WHERE batch_id = ?
    `).get(committed.batch.batchId).count, 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_domain_operation_idempotency
      WHERE batch_id = ?
    `).get(committed.batch.batchId).count, 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_operation_identities
      WHERE op_id IN (?, ?)
    `).get(committed.artifacts[0].opId, committed.artifacts[1].opId).count, 0);
    assert.equal(hostArtifactAuditRows(
      database,
      fixture.run.projectId,
      fixture.run.canvasId,
      committed.batch.batchId,
    ).length, 2);

    assertCanvasIdentityRetained(() => database.ensureCanvas(
      fixture.run.canvasId,
      rebuiltCanvasSnapshot(fixture.run.projectId),
      fixture.run.projectId,
    ));
    assertCanvasIdentityRetained(() => database.saveCanvasSnapshot(
      fixture.run.canvasId,
      rebuiltCanvasSnapshot(fixture.run.projectId),
      { projectId: fixture.run.projectId },
    ));
    assert.equal(database.getCanvas(fixture.run.canvasId), null);
    const replacement = database.ensureCanvas(
      replacementCanvasId,
      rebuiltCanvasSnapshot(fixture.run.projectId),
      fixture.run.projectId,
    );
    assert.equal(replacement.canvasId, replacementCanvasId);
    assert.equal(replacement.revision, 1);
    assert.equal(replacement.nodes[0].data.prompt, 'rebuilt canvas');
    assert.equal(durableRowCount(database, fixture.run.projectId, 'run-output-commit'), 0);
    assert.equal(durableRowCount(database, fixture.run.projectId, 'run-output-slot-reservation'), 2);
    database.close();
    database = null;

    database = new ProjectDatabase(filename, { autoBackup: false });
    assert.equal(database.getCanvas(fixture.run.canvasId), null);
    assert.equal(database.getCanvas(replacementCanvasId).revision, 1);
    assert.equal(database.getCanvas(replacementCanvasId).nodes[0].data.prompt, 'rebuilt canvas');
    assertCanvasIdentityRetained(() => database.ensureCanvas(
      fixture.run.canvasId,
      rebuiltCanvasSnapshot(fixture.run.projectId),
      fixture.run.projectId,
    ));
    assertCanvasIdentityRetained(() => database.saveCanvasSnapshot(
      fixture.run.canvasId,
      rebuiltCanvasSnapshot(fixture.run.projectId),
      { projectId: fixture.run.projectId },
    ));
    assert.equal(database.getRunByEntityUid(fixture.run.entityUid).id, fixture.run.id);
    assert.equal(database.getNodeRunByEntityUid(fixture.nodeRun.entityUid).id, fixture.nodeRun.id);
    assert.equal(database.getAttemptByEntityUid(fixture.attempt.entityUid).id, fixture.attempt.id);
    committed.artifacts.forEach((artifact, outputOrdinal) => {
      assert.equal(database.getRunOutputCommitBySlot(fixture.attempt.entityUid, outputOrdinal), null);
      const slot = database.getRunOutputSlotReservation(fixture.attempt.entityUid, outputOrdinal);
      assert.equal(slot.reservationState, 'host-verified');
      assert.equal(slot.evidenceSource, 'host-commit');
      assert.equal(slot.evidenceCount, 1);
      assert.equal(slot.assetEntityUid, artifact.artifactUid);
      assert.equal(slot.contentHash, artifact.contentHash);
    });
    const auditAfterReopen = hostArtifactAuditRows(
      database,
      fixture.run.projectId,
      fixture.run.canvasId,
      committed.batch.batchId,
    );
    assert.equal(auditAfterReopen.length, 2);
    assert.equal(auditAfterReopen[1].createdAt, auditAfterReopen[0].createdAt + 1);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_common_operation_batches
      WHERE batch_id = ?
    `).get(committed.batch.batchId).count, 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_domain_operation_idempotency
      WHERE batch_id = ?
    `).get(committed.batch.batchId).count, 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_operation_identities
      WHERE op_id IN (?, ?)
    `).get(committed.artifacts[0].opId, committed.artifacts[1].opId).count, 0);
    assert.equal(durableRowCount(database, fixture.run.projectId, 'run-output-commit'), 0);
    assert.equal(durableRowCount(database, fixture.run.projectId, 'run-output-slot-reservation'), 2);
    assert.equal(globalDurableRowCount(database, 'run-output-commit'), 0);
    assert.equal(globalDurableRowCount(database, 'run-output-slot-reservation'), 2);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try { if (database) database.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('authoritative Run pruning retains its consumed stable slot without a commit and remains valid across cold open', () => {
  const { directory, filename } = makeDirectory('t8-pruned-owner-retained-slot-');
  let database = null;
  let fixture;
  let committed;
  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    fixture = createRunFixture(database, '-pruned-owner');
    committed = applyHostArtifact(database, fixture, 'retained slot after owner prune');
    database.db.prepare("UPDATE runs SET status = 'succeeded', created_at = 1 WHERE id = ?")
      .run(fixture.run.id);
    database.setRunRetentionPolicy(fixture.run.projectId, { maxDays: 1, keepReferenced: false });
    const pruned = database.pruneRuns(fixture.run.projectId);
    assert.equal(pruned.deletedRuns, 1);
    assert.equal(database.getRunByEntityUid(fixture.run.entityUid), null);
    assert.equal(database.getRunOutputCommitBySlot(fixture.attempt.entityUid, 0), null);
    const retained = database.getRunOutputSlotReservation(fixture.attempt.entityUid, 0);
    assert.equal(retained.reservationState, 'host-verified');
    assert.equal(retained.evidenceSource, 'host-commit');
    assert.equal(retained.runEntityUid, fixture.run.entityUid);
    assert.equal(retained.nodeRunEntityUid, fixture.nodeRun.entityUid);
    assert.equal(retained.attemptEntityUid, fixture.attempt.entityUid);
    assert.equal(retained.contentHash, committed.artifact.contentHash);
    assert.equal(durableRowCount(database, fixture.run.projectId, 'run-output-commit'), 0);
    assert.equal(durableRowCount(database, fixture.run.projectId, 'run-output-slot-reservation'), 1);
    assert.equal(globalDurableRowCount(database, 'run-output-commit'), 0);
    assert.equal(globalDurableRowCount(database, 'run-output-slot-reservation'), 1);
    database.close();
    database = null;

    database = new ProjectDatabase(filename, { autoBackup: false });
    assert.equal(database.getCanvas(fixture.document.canvasId).projectId, fixture.run.projectId);
    assert.equal(database.getRunByEntityUid(fixture.run.entityUid), null);
    assert.equal(database.getRunOutputCommitBySlot(fixture.attempt.entityUid, 0), null);
    const reopenedSlot = database.getRunOutputSlotReservation(fixture.attempt.entityUid, 0);
    assert.equal(reopenedSlot.reservationState, 'host-verified');
    assert.equal(reopenedSlot.evidenceSource, 'host-commit');
    assert.equal(reopenedSlot.evidenceCount, 1);
    assert.equal(reopenedSlot.runEntityUid, fixture.run.entityUid);
    assert.equal(reopenedSlot.nodeRunEntityUid, fixture.nodeRun.entityUid);
    assert.equal(reopenedSlot.attemptEntityUid, fixture.attempt.entityUid);
    assert.equal(reopenedSlot.assetEntityUid, committed.artifact.artifactUid);
    assert.equal(reopenedSlot.contentHash, committed.artifact.contentHash);
    assert.equal(durableRowCount(database, fixture.run.projectId, 'run-output-commit'), 0);
    assert.equal(durableRowCount(database, fixture.run.projectId, 'run-output-slot-reservation'), 1);
    assert.equal(globalDurableRowCount(database, 'run-output-commit'), 0);
    assert.equal(globalDurableRowCount(database, 'run-output-slot-reservation'), 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try { if (database) database.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema 26 adds descriptor columns to already-created schema-25 commit and reservation tables', () => {
  const { directory, filename } = makeDirectory('t8-schema25-descriptor-columns-');
  try {
    assertCurrentProjectDatabaseRegistry(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATIONS);
    const seed = new ProjectDatabase(filename, { autoBackup: false });
    seed.close();
    const raw = new BetterSqlite3(filename);
    try {
      removeSchema31ExtensionForSyntheticSchema30(raw);
      raw.prepare('DELETE FROM schema_migration_receipts WHERE version = 30').run();
      raw.prepare('DELETE FROM schema_migrations WHERE version = 30').run();
      raw.exec(PROJECT_DATABASE_MIGRATION_30_DOWN_SQL);
      raw.exec(PROJECT_DATABASE_MIGRATION_29_DOWN_SQL);
      raw.prepare('DELETE FROM schema_migrations WHERE version = 29').run();
      assert.deepEqual(raw.pragma('foreign_key_check'), []);
      raw.exec(`
        ALTER TABLE run_output_commits DROP COLUMN source_descriptor_digest;
        ALTER TABLE run_output_slot_reservations DROP COLUMN source_descriptor_digest;
      `);
      raw.prepare('DELETE FROM schema_migrations WHERE version >= 26').run();
      assert.equal(raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 25);
    } finally {
      raw.close();
    }

    fs.rmSync(`${filename}.pre-migration-v30.sqlite3`, { force: true });

    const upgraded = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(
        upgraded.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
        PROJECT_DATABASE_SCHEMA_VERSION,
      );
      assert.equal(upgraded.db.pragma('table_info(run_output_commits)').some((row) => row.name === 'source_descriptor_digest'), true);
      assert.equal(upgraded.db.pragma('table_info(run_output_slot_reservations)').some((row) => row.name === 'source_descriptor_digest'), true);
      assert.equal(upgraded.db.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      upgraded.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a real schema-25 ledger with a retention-pruned commit upgrades to an unverified slot without inventing a commit', () => {
  const { directory, filename } = makeDirectory('t8-schema25-pruned-slot-');
  let fixture;
  let committed;
  try {
    const seed = new ProjectDatabase(filename, { autoBackup: false });
    try {
      fixture = createRunFixture(seed, '-schema25');
      committed = applyHostArtifact(seed, fixture, 'schema 25 retained bytes');
      assert.equal(seed.db.prepare('SELECT COUNT(*) AS count FROM run_output_commits').get().count, 1);
    } finally {
      seed.close();
    }
    stripSlotReservations(filename, (raw) => {
      raw.prepare('DELETE FROM runs WHERE id = ?').run(fixture.run.id);
      assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM run_output_commits').get().count, 0);
      assert.equal(raw.prepare(`
        SELECT COUNT(*) AS count FROM collaboration_domain_operation_idempotency
        WHERE op_id = ? AND type = 'host.artifact.commit'
      `).get(committed.artifact.opId).count, 1);
      assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM assets WHERE entity_uid = ?').get(committed.artifact.artifactUid).count, 1);
    });

    const upgraded = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(
        upgraded.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
        PROJECT_DATABASE_SCHEMA_VERSION,
      );
      assert.equal(
        upgraded.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,
        PROJECT_DATABASE_SCHEMA_VERSION,
      );
      assert.equal(upgraded.getRun(fixture.run.id), null);
      assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS count FROM run_output_commits').get().count, 0);
      const reservation = upgraded.getRunOutputSlotReservation(fixture.attempt.entityUid, 0);
      assert.equal(reservation.reservationState, 'legacy-unverified');
      assert.equal(reservation.evidenceSource, 'legacy-mixed');
      assert.equal(reservation.runId, fixture.run.id);
      assert.equal(reservation.nodeRunId, fixture.nodeRun.id);
      assert.equal(reservation.attemptId, fixture.attempt.id);
      assert.equal(reservation.assetEntityUid, committed.artifact.artifactUid);
      assert.equal(reservation.contentHash, committed.artifact.contentHash);
      assert.equal(upgraded.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='run-output.legacy-slot-ambiguous'").get().count, 0);
      assert.throws(() => upgraded.applyCommonHostArtifactBatch(committed.batch, {
        hostIdentity: HOST_IDENTITY,
        verifiedArtifacts: [committed.artifact],
      }), (error) => error?.code === 'host_artifact_replay_inconsistent');
    } finally {
      upgraded.close();
    }

    const reopened = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM run_output_slot_reservations').get().count, 1);
      assert.equal(reopened.getRunOutputSlotReservation(fixture.attempt.entityUid, 0).reservationState, 'legacy-unverified');
      assert.equal(reopened.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(reopened.db.pragma('foreign_key_check'), []);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime UUIDs prevent display-id ABA across commit, retention, and same/different-content rebuilds', () => {
  const { directory, filename } = makeDirectory('t8-retention-output-slot-');
  const database = new ProjectDatabase(filename, { autoBackup: false });
  const generations = [];
  let originalReplay;
  try {
    const explicit = {
      runEntityUid: 'b7000000-0000-4000-8000-000000000001',
      nodeRunEntityUid: 'b7000000-0000-4000-8000-000000000002',
      attemptEntityUid: 'b7000000-0000-4000-8000-000000000003',
    };
    let fixture = createRunFixture(database, '-retention', explicit);
    assert.equal(fixture.run.entityUid, explicit.runEntityUid);
    assert.equal(fixture.nodeRun.entityUid, explicit.nodeRunEntityUid);
    assert.equal(fixture.attempt.entityUid, explicit.attemptEntityUid);
    originalReplay = applyHostArtifact(database, fixture, 'same bytes');
    generations.push({
      ...fixture,
      contentHash: originalReplay.artifact.contentHash,
      artifactUid: originalReplay.artifact.artifactUid,
      opId: originalReplay.artifact.opId,
    });

    const prune = () => {
      database.db.prepare("UPDATE runs SET status='succeeded', created_at=1 WHERE id = ?").run('run-display');
      database.setRunRetentionPolicy('project-slot-retention', { maxDays: 1, keepReferenced: false });
      const result = database.pruneRuns('project-slot-retention');
      assert.equal(result.deletedRuns, 1);
      assert.equal(database.getRun('run-display'), null);
      assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM run_output_commits').get().count, 0);
    };

    prune();
    fixture = createRunFixture(database, '-retention');
    const same = applyHostArtifact(database, fixture, 'same bytes');
    generations.push({
      ...fixture,
      contentHash: same.artifact.contentHash,
      artifactUid: same.artifact.artifactUid,
      opId: same.artifact.opId,
    });
    assert.notEqual(fixture.run.entityUid, generations[0].run.entityUid);
    assert.notEqual(fixture.nodeRun.entityUid, generations[0].nodeRun.entityUid);
    assert.notEqual(fixture.attempt.entityUid, generations[0].attempt.entityUid);
    assert.equal(same.artifact.contentHash, originalReplay.artifact.contentHash);

    prune();
    fixture = createRunFixture(database, '-retention');
    const different = applyHostArtifact(database, fixture, 'different bytes');
    generations.push({
      ...fixture,
      contentHash: different.artifact.contentHash,
      artifactUid: different.artifact.artifactUid,
      opId: different.artifact.opId,
    });
    assert.notEqual(different.artifact.contentHash, same.artifact.contentHash);
    assert.notEqual(fixture.run.entityUid, generations[1].run.entityUid);
    assert.notEqual(fixture.nodeRun.entityUid, generations[1].nodeRun.entityUid);
    assert.notEqual(fixture.attempt.entityUid, generations[1].attempt.entityUid);

    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM run_output_slot_reservations
      WHERE attempt_id = 'attempt-display' AND output_ordinal = 0
    `).get().count, 3);
    assert.equal(database.getRunOutputSlotReservation('attempt-display', 0), null);
    for (const generation of generations) {
      assert.equal(
        database.getRunOutputSlotReservation(generation.attempt.entityUid, 0).reservationState,
        'host-verified',
      );
    }
    assert.throws(() => database.applyCommonHostArtifactBatch(originalReplay.batch, {
      hostIdentity: HOST_IDENTITY,
      verifiedArtifacts: [originalReplay.artifact],
    }), (error) => error?.code === 'host_artifact_replay_inconsistent' && error?.status === 409);
  } finally {
    database.close();
  }

  try {
    const reopened = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(reopened.db.prepare(`
        SELECT COUNT(*) AS count FROM run_output_slot_reservations
        WHERE attempt_id = 'attempt-display' AND output_ordinal = 0
      `).get().count, 3);
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM run_output_commits').get().count, 1);
      assert.equal(reopened.getRun('run-display').entityUid, generations[2].run.entityUid);
      for (const [index, generation] of generations.entries()) {
        const reservation = reopened.getRunOutputSlotReservation(generation.attempt.entityUid, 0);
        assert.equal(reservation.reservationState, 'host-verified');
        assert.equal(reservation.evidenceSource, 'host-commit');
        assert.equal(reservation.evidenceCount, 1);
        assert.equal(reservation.runEntityUid, generation.run.entityUid);
        assert.equal(reservation.nodeRunEntityUid, generation.nodeRun.entityUid);
        assert.equal(reservation.attemptEntityUid, generation.attempt.entityUid);
        assert.equal(reservation.assetEntityUid, generation.artifactUid);
        assert.equal(reservation.contentHash, generation.contentHash);
        const commit = reopened.getRunOutputCommitBySlot(generation.attempt.entityUid, 0);
        const liveRun = reopened.getRunByEntityUid(generation.run.entityUid);
        if (index < 2) {
          assert.equal(commit, null, 'authoritatively pruned owner releases only its commit');
          assert.equal(liveRun, null);
        } else {
          assert.equal(commit.opId, generation.opId);
          assert.equal(commit.assetEntityUid, generation.artifactUid);
          assert.equal(liveRun.id, 'run-display');
        }
      }
      assert.equal(durableRowCount(reopened, 'project-slot-retention', 'run-output-commit'), 1);
      assert.equal(durableRowCount(reopened, 'project-slot-retention', 'run-output-slot-reservation'), 3);
      assert.equal(globalDurableRowCount(reopened, 'run-output-commit'), 1);
      assert.equal(globalDurableRowCount(reopened, 'run-output-slot-reservation'), 3);
      assert.equal(reopened.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(reopened.db.pragma('foreign_key_check'), []);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
