'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  COMMON_OPERATION_BATCH_CONTRACT,
} = require('../backend/src/collaboration/commonOperationProtocol');
const {
  stableEntityUuid,
} = require('../backend/src/collaboration/protocol');
const {
  PROJECT_DATABASE_MIGRATIONS,
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
  ProjectDatabaseDurableLedgerError,
} = require('../backend/src/services/projectDatabase');
const {
  assertCurrentProjectDatabaseRegistry,
} = require('./helpers/projectDatabaseVersion.cjs');
const {
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS,
  projectDatabaseDurableLedgerLogicalBytes,
} = require('../backend/src/services/projectDatabaseMigration31DurableLedgers');

const HOST_IDENTITY = Object.freeze({
  actorId: 'host-executor',
  sessionId: 'host-authority',
});
const PROJECT_MAX_BYTES = 64 * 1024 * 1024;

// This is an explicit inventory of every table the real host artifact path can
// mutate before its final audit insert. Comparing full rows (not only counts)
// also freezes Run revisions, asset catalog state, and both accounting layers.
const HOST_TRANSACTION_TABLES = Object.freeze([
  'canvas_documents',
  'canvas_snapshots',
  'canvas_snapshot_pins',
  'canvas_history_usage',
  'runs',
  'node_runs',
  'run_attempts',
  'assets',
  'asset_blobs',
  'asset_blob_refs',
  'asset_access_policies',
  'asset_catalog_revisions',
  'asset_fingerprints',
  'asset_lineage_events',
  'canvas_resource_grant_state',
  'canvas_resource_grants',
  'run_events',
  'run_event_durable_bindings',
  'run_output_commits',
  'run_output_slot_reservations',
  'audit_events',
  'collaboration_operation_identities',
  'collaboration_common_operation_batches',
  'collaboration_domain_operation_idempotency',
  'canvas_permanent_ledger_policies',
  'canvas_permanent_ledger_usage',
  'project_durable_ledger_policies',
  'project_durable_ledger_usage',
  'database_durable_ledger_policy',
  'database_durable_ledger_usage',
]);

function sortedTableRows(database, table) {
  return database.db.prepare(`SELECT * FROM ${table}`).all()
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function projectDurableTotals(database, projectId) {
  const row = database.db.prepare(`
    SELECT max_rows, max_bytes, total_rows, total_bytes, pressure_state
    FROM project_durable_ledger_totals
    WHERE project_id = ?
  `).get(projectId);
  assert.ok(row, `missing project durable totals for ${projectId}`);
  return {
    maxRows: Number(row.max_rows),
    maxBytes: Number(row.max_bytes),
    totalRows: Number(row.total_rows),
    totalBytes: Number(row.total_bytes),
    pressureState: row.pressure_state,
  };
}

function databaseDurableTotals(database) {
  const row = database.db.prepare(`
    SELECT max_rows, max_bytes, total_rows, total_bytes, pressure_state
    FROM database_durable_ledger_totals
    WHERE singleton_id = 1
  `).get();
  assert.ok(row, 'missing database durable totals');
  return {
    maxRows: Number(row.max_rows),
    maxBytes: Number(row.max_bytes),
    totalRows: Number(row.total_rows),
    totalBytes: Number(row.total_bytes),
    pressureState: row.pressure_state,
  };
}

function normalizedUsage(rows) {
  return rows.map((row) => ({
    ledgerKind: row.ledger_kind,
    rowCount: Number(row.row_count),
    logicalBytes: Number(row.logical_bytes),
  }));
}

function durableUsageState(database, projectId) {
  return {
    project: normalizedUsage(database.db.prepare(`
      SELECT ledger_kind, row_count, logical_bytes
      FROM project_durable_ledger_usage
      WHERE project_id = ?
      ORDER BY ledger_kind ASC
    `).all(projectId)),
    database: normalizedUsage(database.db.prepare(`
      SELECT ledger_kind, row_count, logical_bytes
      FROM database_durable_ledger_usage
      WHERE singleton_id = 1
      ORDER BY ledger_kind ASC
    `).all()),
    projectTotals: projectDurableTotals(database, projectId),
    databaseTotals: databaseDurableTotals(database),
  };
}

function authoritativeRows(database, spec, projectId = null) {
  if (spec.kind === 'run-event') {
    const where = projectId == null ? '' : 'WHERE binding.project_id = ?';
    return database.db.prepare(`
      SELECT event.*, binding.project_id
      FROM run_events event
      JOIN run_event_durable_bindings binding ON binding.event_id = event.id
      ${where}
    `).all(...(projectId == null ? [] : [projectId]));
  }
  const where = projectId == null ? '' : 'WHERE project_id = ?';
  return database.db.prepare(`SELECT * FROM ${spec.table} ${where}`)
    .all(...(projectId == null ? [] : [projectId]));
}

function expectedUsage(database, projectId = null) {
  return PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS.map((spec) => {
    const rows = authoritativeRows(database, spec, projectId);
    return {
      ledgerKind: spec.kind,
      rowCount: rows.length,
      logicalBytes: rows.reduce(
        (total, row) => total + projectDatabaseDurableLedgerLogicalBytes(spec, row),
        0,
      ),
    };
  }).sort((left, right) => left.ledgerKind.localeCompare(right.ledgerKind));
}

function assertExactDurableAccounting(database, projectId) {
  const state = durableUsageState(database, projectId);
  const expectedProject = expectedUsage(database, projectId);
  const expectedDatabase = expectedUsage(database);
  assert.equal(state.project.length, 4);
  assert.equal(state.database.length, 4);
  assert.deepEqual(state.project, expectedProject);
  assert.deepEqual(state.database, expectedDatabase);
  assert.equal(
    state.projectTotals.totalRows,
    expectedProject.reduce((total, usage) => total + usage.rowCount, 0),
  );
  assert.equal(
    state.projectTotals.totalBytes,
    expectedProject.reduce((total, usage) => total + usage.logicalBytes, 0),
  );
  assert.equal(
    state.databaseTotals.totalRows,
    expectedDatabase.reduce((total, usage) => total + usage.rowCount, 0),
  );
  assert.equal(
    state.databaseTotals.totalBytes,
    expectedDatabase.reduce((total, usage) => total + usage.logicalBytes, 0),
  );
  return state;
}

function setProjectRowCapacity(database, projectId, maxRows) {
  const before = projectDurableTotals(database, projectId);
  assert.equal(before.totalRows <= maxRows, true);
  assert.equal(before.totalBytes <= PROJECT_MAX_BYTES, true);
  const updated = database.db.prepare(`
    UPDATE project_durable_ledger_policies
    SET max_rows = ?, max_bytes = ?, pressure_state = 'normal',
        updated_at = updated_at + 1
    WHERE project_id = ?
  `).run(maxRows, PROJECT_MAX_BYTES, projectId);
  assert.equal(updated.changes, 1);
  assert.deepEqual(projectDurableTotals(database, projectId), {
    ...before,
    maxRows,
    maxBytes: PROJECT_MAX_BYTES,
    pressureState: 'normal',
  });
}

function snapshotHostTransactionState(database, fixture) {
  return {
    canvas: database.getCanvas(fixture.document.canvasId),
    run: database.getRun(fixture.run.id),
    nodeRun: database.getNodeRun(fixture.nodeRun.id),
    attempt: database.getAttempt(fixture.attempt.id),
    tables: Object.fromEntries(HOST_TRANSACTION_TABLES.map((table) => [
      table,
      sortedTableRows(database, table),
    ])),
  };
}

function prepareHostArtifactFixture(database, suffix) {
  const projectId = `project-schema31-host-${suffix}`;
  const canvasId = `canvas-schema31-host-${suffix}`;
  const nodeId = `node-schema31-host-${suffix}`;
  const nodeUid = stableEntityUuid('t8-schema31-host-capacity-node-v1', suffix);
  const document = database.ensureCanvas(canvasId, {
    name: 'Schema31 host durable capacity B2',
    nodes: [{
      id: nodeId,
      entityUid: nodeUid,
      entityRevision: 1,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { prompt: 'authoritative host output' },
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }, projectId);
  const run = database.createRun({
    id: `run-schema31-host-${suffix}`,
    projectId,
    canvasId,
    canvasRevision: document.revision,
    initiatorId: 'owner-schema31-host-capacity',
    status: 'running',
  });
  const nodeRun = database.createNodeRun({
    id: `node-run-schema31-host-${suffix}`,
    runId: run.id,
    nodeId,
    originalNodeId: nodeId,
    status: 'running',
    inputSnapshot: {
      node: {
        id: nodeId,
        entityUid: nodeUid,
        type: 'text',
        data: { prompt: 'authoritative host output' },
      },
      upstreamNodes: [],
      incomingEdges: [],
    },
  });
  const attempt = database.createAttempt({
    id: `attempt-schema31-host-${suffix}`,
    nodeRunId: nodeRun.id,
    provider: 'host-local',
    model: 'host-capacity-model',
    status: 'running',
  });
  const outputOrdinal = 0;
  const contentHash = suffix === 'late-failure' ? 'd'.repeat(64) : 'e'.repeat(64);
  const opId = stableEntityUuid(
    't8-host-artifact-operation-v1',
    attempt.entityUid,
    outputOrdinal,
  );
  const artifactUid = stableEntityUuid(
    't8-host-artifact-v1',
    attempt.entityUid,
    outputOrdinal,
  );
  const blobUid = stableEntityUuid('t8-asset-blob-v1', 'sha256', contentHash);
  const verifiedArtifact = {
    opId,
    artifactUid,
    blobUid,
    contentHash,
    byteSize: 12,
    kind: 'image',
    filename: `${suffix}.png`,
    mimeType: 'image/png',
    storageKey: `sha256/${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}`,
    managedPath: path.join('C:\\host-private-cas', contentHash),
    sourceUrl: `/api/project-assets/run-output-${artifactUid}/media`,
    metadata: { size: 12, health: 'ok' },
    outputOrdinal,
    verifiedAt: 2_000_000_000_000,
  };
  const batch = {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId,
    canvasId,
    baseRevision: document.revision,
    batchId: stableEntityUuid(
      't8-host-artifact-batch-v1',
      run.entityUid,
      nodeRun.entityUid,
      attempt.entityUid,
      String(outputOrdinal),
    ),
    clientId: stableEntityUuid(
      't8-host-artifact-client-v1',
      run.entityUid,
      nodeRun.entityUid,
      attempt.entityUid,
    ),
    clientSeq: 1,
    operations: [{
      opId,
      type: 'host.artifact.commit',
      payload: {
        artifactUid,
        blobUid,
        runUid: run.entityUid,
        nodeRunUid: nodeRun.entityUid,
        attemptUid: attempt.entityUid,
        nodeUid,
        expectedCanvasRevision: document.revision,
        expectedRunRevision: run.revision,
        expectedNodeRunRevision: nodeRun.revision,
        expectedAttemptRevision: attempt.revision,
        outputOrdinal,
        kind: verifiedArtifact.kind,
        contentHash,
        byteSize: verifiedArtifact.byteSize,
        filename: verifiedArtifact.filename,
        mimeType: verifiedArtifact.mimeType,
      },
    }],
  };
  return {
    projectId,
    document,
    run,
    nodeRun,
    attempt,
    batch,
    verifiedArtifact,
  };
}

function applyFixture(database, fixture) {
  return database.applyCommonHostArtifactBatch(fixture.batch, {
    hostIdentity: HOST_IDENTITY,
    verifiedArtifacts: [fixture.verifiedArtifact],
  });
}

function usageByKind(rows) {
  return new Map(rows.map((row) => [row.ledgerKind, row]));
}

test('B2 schema31 nested host artifact keeps the late durable error and rolls the complete transaction back', async () => {
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    projectDurableLedgerPolicy: { maxRows: 100, maxBytes: PROJECT_MAX_BYTES },
  });
  try {
    assertCurrentProjectDatabaseRegistry(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATIONS);
    const fixture = prepareHostArtifactFixture(database, 'late-failure');
    const baselineUsage = assertExactDurableAccounting(database, fixture.projectId);

    // A host commit writes RunEvent, output commit, and output-slot evidence
    // before the audit row. Exactly three free rows therefore reaches the
    // fourth (late) durable gate instead of rejecting at the first insert.
    const maxRows = baselineUsage.projectTotals.totalRows + 3;
    setProjectRowCapacity(database, fixture.projectId, maxRows);
    const before = snapshotHostTransactionState(database, fixture);
    const beforeUsage = durableUsageState(database, fixture.projectId);

    assert.throws(
      () => database.withProjectDatabaseWrite('b2.outer.host-artifact.durable-capacity', () => (
        applyFixture(database, fixture)
      )),
      (error) => {
        assert.ok(error instanceof ProjectDatabaseDurableLedgerError);
        assert.equal(error.code, 'project_durable_ledger_capacity_exceeded');
        assert.equal(error.status, 507);
        assert.equal(error.statusCode, 507);
        assert.equal(error.details?.projectId, fixture.projectId);
        // appendAuditEvent translates the durable trigger while both the host
        // writer and its caller share one outer transaction. The details prove
        // that the first three durable rows reached their gates before audit.
        assert.equal(error.details?.projectRows, beforeUsage.projectTotals.totalRows + 3);
        assert.equal(error.details?.projectMaxRows, maxRows);
        assert.equal(error.details?.databaseRows, beforeUsage.databaseTotals.totalRows + 3);
        return true;
      },
    );

    assert.deepEqual(
      snapshotHostTransactionState(database, fixture),
      before,
      'late durable failure must roll back canvas/Run hierarchy, asset/CAS, commit/slot, event/audit, identities, and all usage rows',
    );
    assert.deepEqual(durableUsageState(database, fixture.projectId), beforeUsage);
    assertExactDurableAccounting(database, fixture.projectId);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    await database.close();
  }
});

test('B2 schema31 exact project capacity accepts one host artifact and exact replay charges no durable row twice', async () => {
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    projectDurableLedgerPolicy: { maxRows: 100, maxBytes: PROJECT_MAX_BYTES },
  });
  try {
    assertCurrentProjectDatabaseRegistry(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATIONS);
    const fixture = prepareHostArtifactFixture(database, 'exact-capacity');
    const beforeUsage = assertExactDurableAccounting(database, fixture.projectId);
    const maxRows = beforeUsage.projectTotals.totalRows + 4;
    setProjectRowCapacity(database, fixture.projectId, maxRows);
    const beforeCommitState = snapshotHostTransactionState(database, fixture);

    const applied = applyFixture(database, fixture);
    assert.equal(applied.duplicate, false);
    assert.equal(applied.results.length, 1);
    assert.equal(applied.results[0].opId, fixture.verifiedArtifact.opId);
    assert.deepEqual(database.getCanvas(fixture.document.canvasId), beforeCommitState.canvas);
    assert.equal(database.getRun(fixture.run.id).revision, beforeCommitState.run.revision + 1);
    assert.equal(database.getNodeRun(fixture.nodeRun.id).revision, beforeCommitState.nodeRun.revision + 1);
    assert.equal(database.getAttempt(fixture.attempt.id).revision, beforeCommitState.attempt.revision + 1);
    for (const [table, expectedDelta] of [
      ['assets', 1],
      ['asset_blobs', 1],
      ['asset_blob_refs', 1],
      ['asset_access_policies', 1],
      ['asset_lineage_events', 1],
      // The host visibility grant and lineage grant are distinct retained
      // authority rows even though they name the same asset.
      ['canvas_resource_grants', 2],
      ['run_events', 1],
      ['run_event_durable_bindings', 1],
      ['run_output_commits', 1],
      ['run_output_slot_reservations', 1],
      ['audit_events', 1],
      ['collaboration_operation_identities', 1],
      ['collaboration_common_operation_batches', 1],
      ['collaboration_domain_operation_idempotency', 1],
    ]) {
      assert.equal(
        sortedTableRows(database, table).length,
        beforeCommitState.tables[table].length + expectedDelta,
        `${table} must receive its exact authoritative host row delta`,
      );
    }

    const afterApplyUsage = assertExactDurableAccounting(database, fixture.projectId);
    assert.equal(afterApplyUsage.projectTotals.totalRows, maxRows);
    assert.equal(afterApplyUsage.projectTotals.pressureState, 'normal');
    assert.equal(
      afterApplyUsage.databaseTotals.totalRows,
      beforeUsage.databaseTotals.totalRows + 4,
    );
    const projectBeforeByKind = usageByKind(beforeUsage.project);
    const projectAfterByKind = usageByKind(afterApplyUsage.project);
    const databaseBeforeByKind = usageByKind(beforeUsage.database);
    const databaseAfterByKind = usageByKind(afterApplyUsage.database);
    for (const spec of PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS) {
      assert.equal(
        projectAfterByKind.get(spec.kind).rowCount,
        projectBeforeByKind.get(spec.kind).rowCount + 1,
        `${spec.kind} must charge exactly one project row`,
      );
      assert.equal(
        databaseAfterByKind.get(spec.kind).rowCount,
        databaseBeforeByKind.get(spec.kind).rowCount + 1,
        `${spec.kind} must charge exactly one database row`,
      );
    }

    const committedState = snapshotHostTransactionState(database, fixture);
    const replay = applyFixture(database, fixture);
    assert.equal(replay.duplicate, true);
    assert.deepEqual(replay.results, applied.results);
    assert.deepEqual(snapshotHostTransactionState(database, fixture), committedState);
    assert.deepEqual(
      assertExactDurableAccounting(database, fixture.projectId),
      afterApplyUsage,
      'exact replay at the full row boundary must not consume project/global capacity again',
    );
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    await database.close();
  }
});
