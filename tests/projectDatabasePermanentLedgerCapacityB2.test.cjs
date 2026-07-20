'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const Y = require('yjs');

const {
  COMMON_OPERATION_BATCH_CONTRACT,
} = require('../backend/src/collaboration/commonOperationProtocol');
const {
  adaptCommonGraphBatch,
} = require('../backend/src/collaboration/commonOperationAdapter');
const {
  stableEntityUuid,
} = require('../backend/src/collaboration/protocol');
const {
  digestSubflowUpgradePlan,
} = require('../backend/src/services/collaborationDomainAuthority');
const {
  CollaborationTextPersistence,
} = require('../backend/src/services/collaborationTextPersistence');
const {
  PROJECT_DATABASE_PERMANENT_LEDGER_SPECS,
} = require('../backend/src/services/projectDatabaseMigration30');
const {
  PROJECT_DATABASE_MIGRATIONS,
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
  ProjectDatabaseHistoryCapacityError,
  ProjectDatabaseSchemaInvalidError,
  ProjectDatabaseStorageCapacityError,
  RevisionConflictError,
} = require('../backend/src/services/projectDatabase');
const {
  assertCurrentProjectDatabaseRegistry,
} = require('./helpers/projectDatabaseVersion.cjs');

const LARGE_LIMIT = 1_000_000;
const ACTOR_ID = 'member-permanent-ledger-b2';
const SESSION_ID = 'session-permanent-ledger-b2';
const NODE_UID = '71000000-0000-4000-8000-000000000001';
const TEXT_UPDATE_ID = '71000000-0000-4000-8000-000000000002';

function ensureCanvas(database, projectId, canvasId, options = {}) {
  return database.ensureCanvas(canvasId, {
    name: 'Permanent ledger capacity B2',
    nodes: [{
      id: options.nodeId || 'node-a',
      entityUid: options.nodeUid || NODE_UID,
      entityRevision: 1,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { prompt: '' },
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }, projectId, { initializeResourceScope: false });
}

function permanentTotals(database, projectId, canvasId) {
  const row = database.db.prepare(`
    SELECT * FROM canvas_permanent_ledger_totals
    WHERE project_id = ? AND canvas_id = ?
  `).get(projectId, canvasId);
  return row && {
    maxRows: Number(row.max_rows),
    maxBytes: Number(row.max_bytes),
    totalRows: Number(row.total_rows),
    totalBytes: Number(row.total_bytes),
    pressureState: row.pressure_state,
  };
}

function permanentUsage(database, projectId, canvasId) {
  return database.db.prepare(`
    SELECT ledger_kind, row_count, logical_bytes
    FROM canvas_permanent_ledger_usage
    WHERE project_id = ? AND canvas_id = ?
    ORDER BY ledger_kind ASC
  `).all(projectId, canvasId).map((row) => ({
    ledgerKind: row.ledger_kind,
    rowCount: Number(row.row_count),
    logicalBytes: Number(row.logical_bytes),
  }));
}

function updatePolicy(database, projectId, canvasId, maxRows, maxBytes) {
  const totals = permanentTotals(database, projectId, canvasId);
  const pressureState = totals.totalRows > maxRows || totals.totalBytes > maxBytes
    ? 'over-capacity'
    : 'normal';
  const result = database.db.prepare(`
    UPDATE canvas_permanent_ledger_policies
    SET max_rows = ?, max_bytes = ?, pressure_state = ?, updated_at = ?
    WHERE project_id = ? AND canvas_id = ?
  `).run(maxRows, maxBytes, pressureState, Date.now(), projectId, canvasId);
  assert.equal(result.changes, 1);
}

function logicalBytes(spec, row) {
  let total = 0;
  for (const column of spec.textColumns) {
    if (row[column] != null) total += Buffer.byteLength(String(row[column]), 'utf8');
  }
  for (const column of spec.integerColumns) {
    if (row[column] != null) total += 8;
  }
  return total;
}

function assertExactAccounting(database, projectId, canvasId) {
  const actualUsage = new Map(permanentUsage(database, projectId, canvasId)
    .map((entry) => [entry.ledgerKind, entry]));
  let totalRows = 0;
  let totalBytes = 0;
  for (const spec of PROJECT_DATABASE_PERMANENT_LEDGER_SPECS) {
    const rows = database.db.prepare(`
      SELECT * FROM ${spec.table} WHERE project_id = ? AND canvas_id = ?
    `).all(projectId, canvasId);
    const expectedBytes = rows.reduce((sum, row) => sum + logicalBytes(spec, row), 0);
    assert.deepEqual(actualUsage.get(spec.kind), {
      ledgerKind: spec.kind,
      rowCount: rows.length,
      logicalBytes: expectedBytes,
    }, `${spec.kind} usage must exactly match authoritative rows`);
    totalRows += rows.length;
    totalBytes += expectedBytes;
  }
  const totals = permanentTotals(database, projectId, canvasId);
  assert.equal(totals.totalRows, totalRows);
  assert.equal(totals.totalBytes, totalBytes);
  return { totalRows, totalBytes };
}

function identityRow(projectId, canvasId, overrides = {}) {
  return {
    op_id: overrides.opId || crypto.randomUUID(),
    project_id: projectId,
    canvas_id: canvasId,
    domain: overrides.domain || 'canvas',
    type: overrides.type || 'node.move',
    identity_digest: overrides.identityDigest || 'a'.repeat(64),
    batch_id: overrides.batchId === undefined ? null : overrides.batchId,
    created_at: overrides.createdAt || 1_920_000_000_000,
  };
}

function insertIdentity(database, row) {
  database.db.prepare(`
    INSERT INTO collaboration_operation_identities(
      op_id, project_id, canvas_id, domain, type, identity_digest, batch_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.op_id,
    row.project_id,
    row.canvas_id,
    row.domain,
    row.type,
    row.identity_digest,
    row.batch_id,
    row.created_at,
  );
}

function prepareGraphBatch(database, projectId, canvasId, options = {}) {
  const document = database.getCanvas(canvasId);
  const node = document.nodes.find((item) => item.entityUid === (options.nodeUid || NODE_UID));
  const clientSeq = Number(options.clientSeq || 1);
  const batch = {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId,
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
        position: { x: Number(options.x ?? 12), y: Number(options.y ?? 34) },
      },
    }],
  };
  const adapted = adaptCommonGraphBatch(batch, document, {
    actorId: ACTOR_ID,
    sessionId: SESSION_ID,
    timestamp: Number(options.timestamp || 1_920_000_000_100),
  });
  return { batch, adapted };
}

function applyPreparedGraphBatch(database, canvasId, prepared) {
  return database.applyOperations(canvasId, prepared.adapted.operations, {
    expectedRevision: prepared.batch.baseRevision,
    commonBatch: prepared.batch,
    requireTimestampIdentity: false,
  });
}

function scopedCount(database, table, projectId, canvasId) {
  return Number(database.db.prepare(`
    SELECT COUNT(*) AS count FROM ${table}
    WHERE project_id = ? AND canvas_id = ?
  `).get(projectId, canvasId).count);
}

function atomicCanvasState(database, projectId, canvasId) {
  const tables = [
    ...PROJECT_DATABASE_PERMANENT_LEDGER_SPECS.map((spec) => spec.table),
    'canvas_operations',
    'collaboration_common_graph_operation_evidence',
    'audit_events',
    'canvas_mutation_provenance',
    'canvas_snapshots',
    'canvas_snapshot_pins',
  ];
  return {
    document: database.db.prepare(`
      SELECT revision, snapshot_json, updated_at
      FROM canvas_documents WHERE project_id = ? AND canvas_id = ?
    `).get(projectId, canvasId),
    counts: Object.fromEntries(tables.map((table) => [
      table,
      scopedCount(database, table, projectId, canvasId),
    ])),
    permanentUsage: permanentUsage(database, projectId, canvasId),
    permanentTotals: permanentTotals(database, projectId, canvasId),
    historyUsage: database.db.prepare(`
      SELECT snapshot_rows, snapshot_bytes, common_evidence_rows, common_evidence_bytes,
             raw_operation_rows, raw_operation_bytes, pin_rows, pin_bytes
      FROM canvas_history_usage WHERE project_id = ? AND canvas_id = ?
    `).get(projectId, canvasId),
  };
}

function principal(projectId, canvasId) {
  return {
    memberId: ACTOR_ID,
    actorId: ACTOR_ID,
    sessionId: SESSION_ID,
    role: 'editor',
    capabilities: ['editGraph', 'comment'],
    projectId,
    canvasId,
  };
}

function noOpUpdate(state) {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, Buffer.from(state, 'base64'));
    const before = Y.encodeStateVector(document);
    return Buffer.from(Y.encodeStateAsUpdate(document, before)).toString('base64');
  } finally {
    document.destroy();
  }
}

function appendTextUpdate(state, value) {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, Buffer.from(state, 'base64'));
    const before = Y.encodeStateVector(document);
    const text = document.getText('content');
    text.insert(text.length, value);
    return Buffer.from(Y.encodeStateAsUpdate(document, before)).toString('base64');
  } finally {
    document.destroy();
  }
}

function tableCount(database, table) {
  return Number(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

function assertStablePermanentCapacityError(error, expectedMaxRows = 2) {
  return error instanceof ProjectDatabaseHistoryCapacityError
    && error.code === 'permanent_operation_ledger_capacity_exceeded'
    && error.status === 507
    && error.statusCode === 507
    && error.details?.limitKind === 'rows'
    && error.details?.maxRows === expectedMaxRows;
}

function assertStableStorageCapacityError(error, rawCode, operation) {
  return error instanceof ProjectDatabaseStorageCapacityError
    && error.code === 'project_database_storage_capacity_exceeded'
    && error.status === 507
    && error.statusCode === 507
    && error.reason === (rawCode === 'ENOSPC' ? 'filesystem-reserve' : 'sqlite-full')
    && error.details?.operation === operation;
}

function installCommonDomainRawWriteFault(database, suffix) {
  const safeSuffix = String(suffix).replace(/[^a-z0-9_]/gi, '_');
  const functionName = `b2_common_domain_raw_fault_${safeSuffix}`;
  const triggerName = `b2_common_domain_raw_fault_trigger_${safeSuffix}`;
  let armedCode = null;
  const observations = [];

  database.db.function(functionName, () => {
    if (!armedCode) return 1;
    const code = armedCode;
    armedCode = null;
    observations.push({
      code,
      coordinatorActive: database.isProjectDatabaseWriteCoordinatorActive(),
    });
    throw Object.assign(new Error(`controlled nested ${code}`), { code });
  });
  database.db.exec(`
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT ON collaboration_domain_operation_idempotency
    BEGIN
      SELECT ${functionName}();
    END;
  `);

  return {
    arm(code) {
      armedCode = String(code);
    },
    observations,
  };
}

function domainLedgerRows(database, projectId, canvasId) {
  return {
    global: scopedCount(
      database,
      'collaboration_operation_identities',
      projectId,
      canvasId,
    ),
    commonBatch: scopedCount(
      database,
      'collaboration_common_operation_batches',
      projectId,
      canvasId,
    ),
    domainIdempotency: scopedCount(
      database,
      'collaboration_domain_operation_idempotency',
      projectId,
      canvasId,
    ),
  };
}

function prepareReviewCapacityFixture(database, projectId, canvasId) {
  ensureCanvas(database, projectId, canvasId);
  const batch = {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId,
    canvasId,
    baseRevision: 1,
    batchId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    clientSeq: 1,
    operations: [{
      opId: crypto.randomUUID(),
      type: 'review.thread.create',
      payload: {
        threadUid: crypto.randomUUID(),
        expectedCanvasRevision: 1,
        anchor: { kind: 'canvas', x: 10, y: 20 },
        severity: 'high',
        initialComment: {
          commentUid: crypto.randomUUID(),
          body: '容量门应回滚这条审阅意见',
        },
      },
    }],
  };
  return {
    batch,
    principal: {
      memberId: 'reviewer-permanent-ledger-b2',
      sessionId: 'review-session-permanent-ledger-b2',
      capabilities: ['comment', 'approve'],
    },
  };
}

function prepareSubflowCapacityFixture(database, projectId, canvasId) {
  const definitionId = 'permanent-ledger-subflow';
  const definitionUid = stableEntityUuid(projectId, 'subflow-definition', definitionId);
  const source = database.saveSubflowDefinition({
    id: definitionId,
    entityUid: definitionUid,
    projectId,
    version: 1,
    name: 'Permanent ledger subflow v1',
    description: '',
    nodes: [],
    edges: [],
    inputs: [],
    outputs: [],
    exposedParameters: [],
  }, {
    actorId: 'owner-permanent-ledger-b2',
    sessionId: 'publish-permanent-ledger-b2',
    expectedRevision: 0,
  });
  const target = database.saveSubflowDefinition({
    id: definitionId,
    entityUid: definitionUid,
    projectId,
    name: 'Permanent ledger subflow v2',
    description: '',
    nodes: [],
    edges: [],
    inputs: [],
    outputs: [],
    exposedParameters: [],
  }, {
    actorId: 'owner-permanent-ledger-b2',
    sessionId: 'publish-permanent-ledger-b2',
    expectedRevision: 1,
  });
  const instanceUid = crypto.randomUUID();
  database.ensureCanvas(canvasId, {
    projectId,
    nodes: [{
      id: 'subflow-instance',
      entityUid: instanceUid,
      entityRevision: 1,
      type: 'subflow',
      position: { x: 0, y: 0 },
      data: {
        definitionEntityUid: definitionUid,
        definitionId,
        definitionVersion: source.version,
        definitionRevision: source.revision,
        definitionProjectId: projectId,
        definition: source,
        parameterOverrides: {},
      },
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }, projectId, { initializeResourceScope: false });
  const unsignedPlan = {
    instanceUid,
    definitionUid,
    expectedCanvasRevision: 1,
    expectedInstanceRevision: 1,
    expectedDefinitionVersion: source.version,
    expectedDefinitionRevision: source.revision,
    targetDefinitionVersion: target.version,
    targetDefinitionRevision: target.revision,
    portMappings: [],
    parameterMappings: [],
  };
  const plan = {
    ...unsignedPlan,
    upgradePlanDigest: digestSubflowUpgradePlan(unsignedPlan),
  };
  const batch = {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId,
    canvasId,
    baseRevision: 1,
    batchId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    clientSeq: 1,
    operations: [{
      opId: crypto.randomUUID(),
      type: 'subflow.instance.upgrade',
      payload: {
        instanceUid,
        definitionUid,
        expectedCanvasRevision: 1,
        expectedInstanceRevision: 1,
        expectedDefinitionVersion: source.version,
        expectedDefinitionRevision: source.revision,
        targetDefinitionVersion: target.version,
        targetDefinitionRevision: target.revision,
        upgradePlanDigest: plan.upgradePlanDigest,
      },
    }],
  };
  return {
    batch,
    plan,
    principal: {
      memberId: 'editor-subflow-permanent-ledger-b2',
      sessionId: 'subflow-session-permanent-ledger-b2',
      capabilities: ['editGraph'],
    },
  };
}

function prepareHostArtifactCapacityFixture(database, projectId, canvasId) {
  const document = ensureCanvas(database, projectId, canvasId);
  const run = database.createRun({
    id: 'run-permanent-ledger-b2',
    projectId,
    canvasId,
    canvasRevision: document.revision,
    initiatorId: 'owner-permanent-ledger-b2',
    status: 'running',
  });
  const nodeRun = database.createNodeRun({
    id: 'node-run-permanent-ledger-b2',
    runId: run.id,
    nodeId: 'node-a',
    originalNodeId: 'node-a',
    status: 'running',
    inputSnapshot: {
      node: {
        id: 'node-a',
        entityUid: NODE_UID,
        type: 'text',
        data: { prompt: 'authoritative output' },
      },
      upstreamNodes: [],
      incomingEdges: [],
    },
  });
  const attempt = database.createAttempt({
    id: 'attempt-permanent-ledger-b2',
    nodeRunId: nodeRun.id,
    provider: 'host-local',
    model: 'host-model',
    status: 'running',
  });
  const contentHash = 'd'.repeat(64);
  const opId = stableEntityUuid(
    't8-host-artifact-operation-v1',
    attempt.entityUid,
    0,
  );
  const artifactUid = stableEntityUuid('t8-host-artifact-v1', attempt.entityUid, 0);
  const blobUid = stableEntityUuid('t8-asset-blob-v1', 'sha256', contentHash);
  const verifiedArtifact = {
    opId,
    artifactUid,
    blobUid,
    contentHash,
    byteSize: 12,
    kind: 'image',
    filename: 'capacity-result.png',
    mimeType: 'image/png',
    storageKey: `sha256/dd/dd/${contentHash}`,
    managedPath: path.join('C:\\host-private-cas', contentHash),
    sourceUrl: `/api/project-assets/run-output-${artifactUid}/media`,
    metadata: { size: 12, health: 'ok' },
    outputOrdinal: 0,
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
      '0',
    ),
    clientId: stableEntityUuid(
      't8-host-artifact-client-v1',
      run.entityUid,
      nodeRun.entityUid,
      attempt.entityUid,
    ),
    clientSeq: 0,
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
        expectedCanvasRevision: document.revision,
        expectedRunRevision: run.revision,
        expectedNodeRunRevision: nodeRun.revision,
        expectedAttemptRevision: attempt.revision,
        outputOrdinal: 0,
        kind: verifiedArtifact.kind,
        contentHash,
        byteSize: verifiedArtifact.byteSize,
        filename: verifiedArtifact.filename,
        mimeType: verifiedArtifact.mimeType,
      },
    }],
  };
  return { document, run, nodeRun, attempt, batch, verifiedArtifact };
}

test('B2 schema 30 gives each fresh canvas one configured policy and exactly seven zeroed usage rows', () => {
  const projectId = 'project-permanent-ledger-fresh';
  const canvasId = 'canvas-permanent-ledger-fresh';
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasPermanentLedgerPolicy: { maxRows: 19, maxBytes: 4096 },
  });
  try {
    ensureCanvas(database, projectId, canvasId);
    assertCurrentProjectDatabaseRegistry(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATIONS);
    assert.deepEqual(database.db.prepare(`
      SELECT max_rows, max_bytes, pressure_state
      FROM canvas_permanent_ledger_policies
      WHERE project_id = ? AND canvas_id = ?
    `).get(projectId, canvasId), {
      max_rows: 19,
      max_bytes: 4096,
      pressure_state: 'normal',
    });
    assert.deepEqual(permanentUsage(database, projectId, canvasId),
      PROJECT_DATABASE_PERMANENT_LEDGER_SPECS
        .map((spec) => ({ ledgerKind: spec.kind, rowCount: 0, logicalBytes: 0 }))
        .sort((left, right) => left.ledgerKind.localeCompare(right.ledgerKind)));
    assert.deepEqual(permanentTotals(database, projectId, canvasId), {
      maxRows: 19,
      maxBytes: 4096,
      totalRows: 0,
      totalBytes: 0,
      pressureState: 'normal',
    });
  } finally {
    database.close();
  }
});

test('B2 raw SQL triggers account exact UTF-8 bytes, reject byte boundary plus one, and guard live evidence/state', () => {
  const projectId = 'project-permanent-ledger-utf8';
  const canvasId = 'canvas-permanent-ledger-utf8';
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasPermanentLedgerPolicy: { maxRows: 100, maxBytes: LARGE_LIMIT },
  });
  try {
    ensureCanvas(database, projectId, canvasId);
    const spec = PROJECT_DATABASE_PERMANENT_LEDGER_SPECS
      .find((entry) => entry.kind === 'operation-identity');
    const first = identityRow(projectId, canvasId, {
      opId: '原始-幂等-🐧-甲',
      type: '节点.移动🐧',
      batchId: '批次-乙🐧',
      createdAt: 1_920_000_000_200,
    });
    insertIdentity(database, first);
    assert.ok(Buffer.byteLength(first.op_id, 'utf8') > first.op_id.length);
    const expectedFirstBytes = logicalBytes(spec, first);
    assert.deepEqual(permanentUsage(database, projectId, canvasId)
      .find((entry) => entry.ledgerKind === spec.kind), {
      ledgerKind: spec.kind,
      rowCount: 1,
      logicalBytes: expectedFirstBytes,
    });
    assert.deepEqual(assertExactAccounting(database, projectId, canvasId), {
      totalRows: 1,
      totalBytes: expectedFirstBytes,
    });

    assert.throws(
      () => database.db.prepare(`
        UPDATE collaboration_operation_identities SET type = 'rewritten' WHERE op_id = ?
      `).run(first.op_id),
      /immutable/i,
    );
    assert.throws(
      () => database.db.prepare(`
        DELETE FROM collaboration_operation_identities WHERE op_id = ?
      `).run(first.op_id),
      /cannot be deleted/i,
    );
    assert.throws(
      () => database.db.prepare(`
        UPDATE canvas_permanent_ledger_policies
        SET project_id = project_id || '-tampered'
        WHERE project_id = ? AND canvas_id = ?
      `).run(projectId, canvasId),
      /scope is immutable/i,
    );
    assert.throws(
      () => database.db.prepare(`
        DELETE FROM canvas_permanent_ledger_policies
        WHERE project_id = ? AND canvas_id = ?
      `).run(projectId, canvasId),
      /cannot be deleted/i,
    );
    assert.throws(
      () => database.db.prepare(`
        UPDATE canvas_permanent_ledger_usage
        SET project_id = project_id || '-tampered'
        WHERE project_id = ? AND canvas_id = ? AND ledger_kind = ?
      `).run(projectId, canvasId, spec.kind),
      /scope is immutable/i,
    );
    assert.throws(
      () => database.db.prepare(`
        DELETE FROM canvas_permanent_ledger_usage
        WHERE project_id = ? AND canvas_id = ? AND ledger_kind = ?
      `).run(projectId, canvasId, spec.kind),
      /cannot be deleted/i,
    );

    for (const ledgerSpec of PROJECT_DATABASE_PERMANENT_LEDGER_SPECS) {
      const stem = ledgerSpec.kind.replace(/-/g, '_');
      assert.equal(Number(database.db.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'trigger' AND name IN (?, ?)
      `).get(
        `trg_permanent_ledger_${stem}_immutable_update`,
        `trg_permanent_ledger_${stem}_delete_guard`,
      ).count), 2, `${ledgerSpec.kind} must install UPDATE and DELETE guards`);
    }

    const second = identityRow(projectId, canvasId, {
      opId: '原始-幂等-🐧-丙',
      type: '节点.移动🐧',
      batchId: '批次-丁🐧',
      identityDigest: 'b'.repeat(64),
      createdAt: 1_920_000_000_201,
    });
    const secondBytes = logicalBytes(spec, second);
    updatePolicy(
      database,
      projectId,
      canvasId,
      100,
      expectedFirstBytes + secondBytes - 1,
    );
    const before = atomicCanvasState(database, projectId, canvasId);
    assert.throws(() => insertIdentity(database, second), /byte capacity exceeded/i);
    assert.deepEqual(atomicCanvasState(database, projectId, canvasId), before);
    assert.equal(database.getCollaborationOperationIdentity(second.op_id), null);
    assertExactAccounting(database, projectId, canvasId);
  } finally {
    database.close();
  }
});

test('B2 a four-ledger modern graph write crossing a three-row boundary rolls back its whole transaction', () => {
  const projectId = 'project-permanent-ledger-graph-rollback';
  const canvasId = 'canvas-permanent-ledger-graph-rollback';
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasPermanentLedgerPolicy: { maxRows: 3, maxBytes: LARGE_LIMIT },
  });
  try {
    ensureCanvas(database, projectId, canvasId);
    const prepared = prepareGraphBatch(database, projectId, canvasId);
    const before = atomicCanvasState(database, projectId, canvasId);
    assert.throws(
      () => applyPreparedGraphBatch(database, canvasId, prepared),
      (error) => error instanceof ProjectDatabaseHistoryCapacityError
        && error.code === 'permanent_operation_ledger_capacity_exceeded'
        && error.status === 507
        && error.details?.limitKind === 'rows'
        && error.details?.maxRows === 3,
    );
    assert.deepEqual(atomicCanvasState(database, projectId, canvasId), before);
    assert.equal(database.getCanvas(canvasId).revision, 1);
    assert.equal(database.getCanvas(canvasId).nodes[0].position.x, 0);
    assert.equal(database.getCollaborationOperationIdentity(prepared.batch.operations[0].opId), null);
    assert.equal(database.getCanvasOperationIdentity(prepared.batch.operations[0].opId), undefined);
    assertExactAccounting(database, projectId, canvasId);
  } finally {
    database.close();
  }
});

test('B2 exact modern graph replay remains available when permanent row and byte capacity are both full', () => {
  const projectId = 'project-permanent-ledger-graph-replay';
  const canvasId = 'canvas-permanent-ledger-graph-replay';
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasPermanentLedgerPolicy: { maxRows: 100, maxBytes: LARGE_LIMIT },
  });
  try {
    ensureCanvas(database, projectId, canvasId);
    const prepared = prepareGraphBatch(database, projectId, canvasId);
    const first = applyPreparedGraphBatch(database, canvasId, prepared);
    assert.equal(first.document.revision, 2);
    assert.deepEqual(Object.fromEntries(permanentUsage(database, projectId, canvasId)
      .map((entry) => [entry.ledgerKind, entry.rowCount])), {
      'canvas-batch': 1,
      'canvas-idempotency': 1,
      'common-batch': 1,
      'domain-idempotency': 0,
      'operation-identity': 1,
      'text-noop': 0,
      'text-update': 0,
    });
    const exact = assertExactAccounting(database, projectId, canvasId);
    assert.equal(exact.totalRows, 4);
    updatePolicy(database, projectId, canvasId, exact.totalRows, exact.totalBytes);
    assert.deepEqual(permanentTotals(database, projectId, canvasId), {
      maxRows: exact.totalRows,
      maxBytes: exact.totalBytes,
      totalRows: exact.totalRows,
      totalBytes: exact.totalBytes,
      pressureState: 'normal',
    });
    const beforeReplay = atomicCanvasState(database, projectId, canvasId);
    const replay = applyPreparedGraphBatch(database, canvasId, prepared);
    assert.deepEqual(replay.acknowledgements.map((entry) => ({
      opId: entry.opId,
      revision: entry.revision,
      duplicate: entry.duplicate,
    })), [{
      opId: prepared.batch.operations[0].opId,
      revision: 2,
      duplicate: true,
    }]);
    assert.equal(replay.document.revision, 2);
    assert.deepEqual(atomicCanvasState(database, projectId, canvasId), beforeReplay);
  } finally {
    database.close();
  }
});

test('B2 legacy graph compatibility replay fails at full capacity without leaving a partial batch repair', () => {
  const projectId = 'project-permanent-ledger-legacy-replay';
  const canvasId = 'canvas-permanent-ledger-legacy-replay';
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasPermanentLedgerPolicy: { maxRows: 100, maxBytes: LARGE_LIMIT },
  });
  try {
    ensureCanvas(database, projectId, canvasId);
    const prepared = prepareGraphBatch(database, projectId, canvasId);
    const applied = database.applyOperations(canvasId, prepared.adapted.operations, {
      expectedRevision: prepared.batch.baseRevision,
      requireTimestampIdentity: false,
    });
    assert.equal(applied.document.revision, 2);
    assert.equal(scopedCount(database, 'canvas_operation_batches', projectId, canvasId), 1);
    assert.equal(scopedCount(
      database,
      'collaboration_common_operation_batches',
      projectId,
      canvasId,
    ), 0);

    // Reproduce the exact pre-ordered-batch compatibility shape: the operation
    // and its idempotency identity survive, but the newer ordered batch row is
    // absent. The production delete guard is restored byte-for-byte after this
    // in-memory fixture-only surgery, while the normal AFTER DELETE accounting
    // trigger decrements usage authoritatively.
    const guardName = 'trg_permanent_ledger_canvas_batch_delete_guard';
    const guardSql = database.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
    `).get(guardName).sql;
    database.db.exec(`DROP TRIGGER ${guardName}`);
    assert.equal(database.db.prepare(`
      DELETE FROM canvas_operation_batches WHERE project_id = ? AND canvas_id = ?
    `).run(projectId, canvasId).changes, 1);
    database.db.exec(guardSql);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = ?
    `).get(guardName).count, 1);

    const legacyUsage = assertExactAccounting(database, projectId, canvasId);
    assert.equal(legacyUsage.totalRows, 2, 'legacy shape retains global and canvas idempotency only');
    updatePolicy(
      database,
      projectId,
      canvasId,
      legacyUsage.totalRows,
      legacyUsage.totalBytes,
    );
    const beforeReplay = atomicCanvasState(database, projectId, canvasId);
    assert.throws(
      () => applyPreparedGraphBatch(database, canvasId, prepared),
      (error) => assertStablePermanentCapacityError(error, legacyUsage.totalRows),
    );
    assert.deepEqual(atomicCanvasState(database, projectId, canvasId), beforeReplay);
    assert.equal(scopedCount(database, 'canvas_operation_batches', projectId, canvasId), 0);
    assert.equal(scopedCount(
      database,
      'collaboration_common_operation_batches',
      projectId,
      canvasId,
    ), 0);
    assert.equal(scopedCount(
      database,
      'collaboration_common_graph_operation_evidence',
      projectId,
      canvasId,
    ), 0);
    assert.equal(database.getCanvas(canvasId).revision, 2);
    assertExactAccounting(database, projectId, canvasId);
  } finally {
    database.close();
  }
});

test('B2 valid text update exceeding two rows of headroom rolls back revision, client sequence, and all ledgers with stable 507', () => {
  const projectId = 'project-permanent-ledger-text-update';
  const canvasId = 'canvas-permanent-ledger-text-update';
  const updateId = '71000000-0000-4000-8000-000000000003';
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasPermanentLedgerPolicy: { maxRows: 100, maxBytes: LARGE_LIMIT },
  });
  try {
    ensureCanvas(database, projectId, canvasId);
    const persistence = new CollaborationTextPersistence(database);
    const actor = principal(projectId, canvasId);
    const identity = {
      projectId,
      canvasId,
      targetType: 'node',
      targetEntityUid: NODE_UID,
      field: 'prompt',
    };
    const binding = persistence.getBindingSnapshot(identity, actor).binding;
    const envelope = {
      contractVersion: 't8-collaboration-text-update-v1',
      updateId,
      clientSeq: 0,
      projectId,
      canvasId,
      baseRevision: binding.revision,
      targetType: binding.targetType,
      targetEntityUid: binding.targetEntityUid,
      bindingEpoch: binding.bindingEpoch,
      field: binding.field,
      update: appendTextUpdate(binding.state, '有效文本必须整体回滚'),
    };
    updatePolicy(database, projectId, canvasId, 2, LARGE_LIMIT);
    const before = atomicCanvasState(database, projectId, canvasId);
    const beforeBinding = structuredClone(binding);
    const beforeClientSequences = scopedCount(
      database,
      'collaboration_text_client_sequences',
      projectId,
      canvasId,
    );
    assert.throws(
      () => persistence.applyUpdate(envelope, { principal: actor }),
      (error) => assertStablePermanentCapacityError(error, 2),
    );
    assert.deepEqual(atomicCanvasState(database, projectId, canvasId), before);
    assert.deepEqual(persistence.getBindingSnapshot(identity, actor).binding, beforeBinding);
    assert.equal(database.getCanvas(canvasId).revision, binding.revision);
    assert.equal(database.getCanvas(canvasId).nodes[0].data.prompt, '');
    assert.equal(scopedCount(
      database,
      'collaboration_text_client_sequences',
      projectId,
      canvasId,
    ), beforeClientSequences);
    assert.equal(database.getCollaborationOperationIdentity(updateId), null);
    assert.equal(database.getCanvasOperationIdentity(updateId), undefined);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_text_update_idempotency WHERE update_id = ?
    `).get(updateId).count, 0);
    assertExactAccounting(database, projectId, canvasId);
  } finally {
    database.close();
  }
});

test('B2 nested review Common permanent capacity failure keeps its stable 507 and rolls every write back', () => {
  const projectId = 'project-permanent-ledger-review-domain';
  const canvasId = 'canvas-permanent-ledger-review-domain';
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasPermanentLedgerPolicy: { maxRows: 100, maxBytes: LARGE_LIMIT },
  });
  try {
    const fixture = prepareReviewCapacityFixture(database, projectId, canvasId);
    updatePolicy(database, projectId, canvasId, 2, LARGE_LIMIT);
    const before = atomicCanvasState(database, projectId, canvasId);
    const beforeReview = {
      threads: tableCount(database, 'review_threads'),
      comments: tableCount(database, 'review_comments'),
      ledgers: domainLedgerRows(database, projectId, canvasId),
    };
    assert.throws(
      () => database.withProjectDatabaseWrite('b2.outer.review.permanent-capacity', () => (
        database.applyCommonReviewBatch(fixture.batch, { principal: fixture.principal })
      )),
      (error) => assertStablePermanentCapacityError(error, 2),
    );
    assert.deepEqual(atomicCanvasState(database, projectId, canvasId), before);
    assert.deepEqual({
      threads: tableCount(database, 'review_threads'),
      comments: tableCount(database, 'review_comments'),
      ledgers: domainLedgerRows(database, projectId, canvasId),
    }, beforeReview);
    assert.equal(database.getCanvas(canvasId).revision, 1);
    assertExactAccounting(database, projectId, canvasId);
  } finally {
    database.close();
  }
});

test('B2 nested subflow Common permanent capacity failure keeps its stable 507 and rolls every write back', () => {
  const projectId = 'project-permanent-ledger-subflow-domain';
  const canvasId = 'canvas-permanent-ledger-subflow-domain';
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasPermanentLedgerPolicy: { maxRows: 100, maxBytes: LARGE_LIMIT },
  });
  try {
    const fixture = prepareSubflowCapacityFixture(database, projectId, canvasId);
    updatePolicy(database, projectId, canvasId, 2, LARGE_LIMIT);
    const before = atomicCanvasState(database, projectId, canvasId);
    const beforeDocument = database.getCanvas(canvasId);
    const beforeLedgers = domainLedgerRows(database, projectId, canvasId);
    assert.throws(
      () => database.withProjectDatabaseWrite('b2.outer.subflow.permanent-capacity', () => (
        database.applyCommonSubflowBatch(fixture.batch, {
          principal: fixture.principal,
          subflowUpgradePlans: [fixture.plan],
        })
      )),
      (error) => assertStablePermanentCapacityError(error, 2),
    );
    assert.deepEqual(atomicCanvasState(database, projectId, canvasId), before);
    assert.deepEqual(database.getCanvas(canvasId), beforeDocument);
    assert.deepEqual(domainLedgerRows(database, projectId, canvasId), beforeLedgers);
    assert.equal(database.getCanvas(canvasId).revision, 1);
    assertExactAccounting(database, projectId, canvasId);
  } finally {
    database.close();
  }
});

test('B2 nested host-artifact Common permanent capacity failure keeps its stable 507 and rolls every write back', () => {
  const projectId = 'project-permanent-ledger-host-domain';
  const canvasId = 'canvas-permanent-ledger-host-domain';
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasPermanentLedgerPolicy: { maxRows: 100, maxBytes: LARGE_LIMIT },
  });
  try {
    const fixture = prepareHostArtifactCapacityFixture(database, projectId, canvasId);
    updatePolicy(database, projectId, canvasId, 2, LARGE_LIMIT);
    const hostTables = [
      'assets',
      'asset_blobs',
      'asset_blob_refs',
      'run_output_commits',
      'run_output_slot_reservations',
      'run_events',
      'asset_lineage_events',
      'canvas_resource_grants',
    ];
    const hostState = () => ({
      atomic: atomicCanvasState(database, projectId, canvasId),
      ledgers: domainLedgerRows(database, projectId, canvasId),
      tableCounts: Object.fromEntries(hostTables.map((table) => [table, tableCount(database, table)])),
      run: database.getRun(fixture.run.id),
      nodeRun: database.getNodeRun(fixture.nodeRun.id),
      attempt: database.getAttempt(fixture.attempt.id),
    });
    const before = hostState();
    assert.throws(
      () => database.withProjectDatabaseWrite('b2.outer.host-artifact.permanent-capacity', () => (
        database.applyCommonHostArtifactBatch(fixture.batch, {
          hostIdentity: { actorId: 'host-executor', sessionId: 'host-authority' },
          verifiedArtifacts: [fixture.verifiedArtifact],
        })
      )),
      (error) => assertStablePermanentCapacityError(error, 2),
    );
    assert.deepEqual(hostState(), before);
    assert.equal(database.getCanvas(canvasId).revision, 1);
    assertExactAccounting(database, projectId, canvasId);
  } finally {
    database.close();
  }
});

test('B2 nested review Common raw SQLITE_FULL and ENOSPC are attributed to the outer coordinator', () => {
  const projectId = 'project-common-review-nested-storage';
  const canvasId = 'canvas-common-review-nested-storage';
  const outerOperation = 'b2.outer.review.atomic-batch';
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasPermanentLedgerPolicy: { maxRows: 100, maxBytes: LARGE_LIMIT },
  });
  try {
    const fixture = prepareReviewCapacityFixture(database, projectId, canvasId);
    const fault = installCommonDomainRawWriteFault(database, 'review');
    const reviewState = () => ({
      atomic: atomicCanvasState(database, projectId, canvasId),
      threads: tableCount(database, 'review_threads'),
      comments: tableCount(database, 'review_comments'),
      ledgers: domainLedgerRows(database, projectId, canvasId),
    });
    const before = reviewState();
    const apply = () => database.withProjectDatabaseWrite(outerOperation, () => (
      database.applyCommonReviewBatch(fixture.batch, { principal: fixture.principal })
    ));

    for (const rawCode of ['SQLITE_FULL', 'ENOSPC']) {
      fault.arm(rawCode);
      assert.throws(
        apply,
        (error) => assertStableStorageCapacityError(error, rawCode, outerOperation),
      );
      assert.equal(database.db.inTransaction, false);
      assert.deepEqual(reviewState(), before);
    }

    const applied = apply();
    assert.equal(applied.duplicate, false);
    assert.equal(applied.results.length, 1);
    assert.equal(tableCount(database, 'review_threads'), 1);
    assert.equal(tableCount(database, 'review_comments'), 1);
    assert.deepEqual(fault.observations, [
      { code: 'SQLITE_FULL', coordinatorActive: true },
      { code: 'ENOSPC', coordinatorActive: true },
    ]);
  } finally {
    database.close();
  }
});

test('B2 nested subflow Common raw capacity uses the outer operation and keeps SQLITE_BUSY conflict mapping', () => {
  const projectId = 'project-common-subflow-nested-storage';
  const canvasId = 'canvas-common-subflow-nested-storage';
  const outerOperation = 'b2.outer.subflow.atomic-batch';
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasPermanentLedgerPolicy: { maxRows: 100, maxBytes: LARGE_LIMIT },
  });
  try {
    const fixture = prepareSubflowCapacityFixture(database, projectId, canvasId);
    const fault = installCommonDomainRawWriteFault(database, 'subflow');
    const subflowState = () => ({
      atomic: atomicCanvasState(database, projectId, canvasId),
      document: database.getCanvas(canvasId),
      ledgers: domainLedgerRows(database, projectId, canvasId),
    });
    const before = subflowState();
    const apply = () => database.withProjectDatabaseWrite(outerOperation, () => (
      database.applyCommonSubflowBatch(fixture.batch, {
        principal: fixture.principal,
        subflowUpgradePlans: [fixture.plan],
      })
    ));

    for (const rawCode of ['SQLITE_FULL', 'ENOSPC']) {
      fault.arm(rawCode);
      assert.throws(
        apply,
        (error) => assertStableStorageCapacityError(error, rawCode, outerOperation),
      );
      assert.equal(database.db.inTransaction, false);
      assert.deepEqual(subflowState(), before);
    }

    fault.arm('SQLITE_BUSY_TEST');
    assert.throws(
      apply,
      (error) => error instanceof RevisionConflictError
        && error.code === 'revision_conflict',
    );
    assert.equal(database.db.inTransaction, false);
    assert.deepEqual(subflowState(), before);

    const applied = apply();
    assert.equal(applied.duplicate, false);
    assert.equal(applied.results.length, 1);
    assert.equal(database.getCanvas(canvasId).revision, 2);
    assert.deepEqual(fault.observations, [
      { code: 'SQLITE_FULL', coordinatorActive: true },
      { code: 'ENOSPC', coordinatorActive: true },
      { code: 'SQLITE_BUSY_TEST', coordinatorActive: true },
    ]);
  } finally {
    database.close();
  }
});

test('B2 nested host-artifact Common raw capacity uses the outer operation and keeps SQLITE_BUSY conflict mapping', () => {
  const projectId = 'project-common-host-nested-storage';
  const canvasId = 'canvas-common-host-nested-storage';
  const outerOperation = 'b2.outer.host-artifact.atomic-batch';
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasPermanentLedgerPolicy: { maxRows: 100, maxBytes: LARGE_LIMIT },
  });
  try {
    const fixture = prepareHostArtifactCapacityFixture(database, projectId, canvasId);
    const fault = installCommonDomainRawWriteFault(database, 'host_artifact');
    const hostTables = [
      'assets',
      'asset_blobs',
      'asset_blob_refs',
      'run_output_commits',
      'run_output_slot_reservations',
      'run_events',
      'asset_lineage_events',
      'canvas_resource_grants',
    ];
    const hostState = () => ({
      atomic: atomicCanvasState(database, projectId, canvasId),
      ledgers: domainLedgerRows(database, projectId, canvasId),
      tableCounts: Object.fromEntries(hostTables.map((table) => [table, tableCount(database, table)])),
      run: database.getRun(fixture.run.id),
      nodeRun: database.getNodeRun(fixture.nodeRun.id),
      attempt: database.getAttempt(fixture.attempt.id),
    });
    const before = hostState();
    const apply = () => database.withProjectDatabaseWrite(outerOperation, () => (
      database.applyCommonHostArtifactBatch(fixture.batch, {
        hostIdentity: { actorId: 'host-executor', sessionId: 'host-authority' },
        verifiedArtifacts: [fixture.verifiedArtifact],
      })
    ));

    for (const rawCode of ['SQLITE_FULL', 'ENOSPC']) {
      fault.arm(rawCode);
      assert.throws(
        apply,
        (error) => assertStableStorageCapacityError(error, rawCode, outerOperation),
      );
      assert.equal(database.db.inTransaction, false);
      assert.deepEqual(hostState(), before);
    }

    fault.arm('SQLITE_BUSY_TEST');
    assert.throws(
      apply,
      (error) => error instanceof RevisionConflictError
        && error.code === 'revision_conflict',
    );
    assert.equal(database.db.inTransaction, false);
    assert.deepEqual(hostState(), before);

    const applied = apply();
    assert.equal(applied.duplicate, false);
    assert.equal(applied.results.length, 1);
    assert.equal(database.getRun(fixture.run.id).revision, fixture.run.revision + 1);
    assert.equal(database.getNodeRun(fixture.nodeRun.id).revision, fixture.nodeRun.revision + 1);
    assert.equal(database.getAttempt(fixture.attempt.id).revision, fixture.attempt.revision + 1);
    assert.deepEqual(fault.observations, [
      { code: 'SQLITE_FULL', coordinatorActive: true },
      { code: 'ENOSPC', coordinatorActive: true },
      { code: 'SQLITE_BUSY_TEST', coordinatorActive: true },
    ]);
  } finally {
    database.close();
  }
});

test('B2 text no-op capacity failure rolls back both global identity and no-op ledger without advancing revision', () => {
  const projectId = 'project-permanent-ledger-text-noop';
  const canvasId = 'canvas-permanent-ledger-text-noop';
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasPermanentLedgerPolicy: { maxRows: 100, maxBytes: LARGE_LIMIT },
  });
  try {
    ensureCanvas(database, projectId, canvasId);
    const persistence = new CollaborationTextPersistence(database);
    const actor = principal(projectId, canvasId);
    const binding = persistence.getBindingSnapshot({
      projectId,
      canvasId,
      targetType: 'node',
      targetEntityUid: NODE_UID,
      field: 'prompt',
    }, actor).binding;
    const envelope = {
      contractVersion: 't8-collaboration-text-update-v1',
      updateId: TEXT_UPDATE_ID,
      clientSeq: 0,
      projectId,
      canvasId,
      baseRevision: binding.revision,
      targetType: binding.targetType,
      targetEntityUid: binding.targetEntityUid,
      bindingEpoch: binding.bindingEpoch,
      field: binding.field,
      update: noOpUpdate(binding.state),
    };
    updatePolicy(database, projectId, canvasId, 1, LARGE_LIMIT);
    const before = atomicCanvasState(database, projectId, canvasId);
    const beforeBindingCount = scopedCount(
      database,
      'collaboration_text_documents',
      projectId,
      canvasId,
    );
    assert.throws(
      () => persistence.applyUpdate(envelope, { principal: actor }),
      (error) => error instanceof ProjectDatabaseHistoryCapacityError
        && error.code === 'permanent_operation_ledger_capacity_exceeded'
        && error.details?.limitKind === 'rows',
    );
    assert.deepEqual(atomicCanvasState(database, projectId, canvasId), before);
    assert.equal(database.getCanvas(canvasId).revision, binding.revision);
    assert.equal(database.getCollaborationOperationIdentity(TEXT_UPDATE_ID), null);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_text_noop_idempotency WHERE update_id = ?
    `).get(TEXT_UPDATE_ID).count, 0);
    assert.equal(scopedCount(
      database,
      'collaboration_text_documents',
      projectId,
      canvasId,
    ), beforeBindingCount);
    assertExactAccounting(database, projectId, canvasId);
  } finally {
    database.close();
  }
});

test('B2 live canvas evidence is isolated per canvas and deleteCanvas releases all policy, usage, and FK evidence', () => {
  const projectId = 'project-permanent-ledger-isolation';
  const canvasA = 'canvas-permanent-ledger-isolation-a';
  const canvasB = 'canvas-permanent-ledger-isolation-b';
  const nodeB = '71000000-0000-4000-8000-000000000099';
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    canvasPermanentLedgerPolicy: { maxRows: 100, maxBytes: LARGE_LIMIT },
  });
  try {
    ensureCanvas(database, projectId, canvasA);
    ensureCanvas(database, projectId, canvasB, { nodeId: 'node-b', nodeUid: nodeB });
    updatePolicy(database, projectId, canvasA, 1, LARGE_LIMIT);
    const firstA = identityRow(projectId, canvasA, { opId: 'isolation-a-1' });
    const rejectedA = identityRow(projectId, canvasA, {
      opId: 'isolation-a-2', identityDigest: 'b'.repeat(64), createdAt: 1_920_000_000_001,
    });
    const firstB = identityRow(projectId, canvasB, {
      opId: 'isolation-b-1', identityDigest: 'c'.repeat(64), createdAt: 1_920_000_000_002,
    });
    insertIdentity(database, firstA);
    assert.throws(() => insertIdentity(database, rejectedA), /row capacity exceeded/i);
    insertIdentity(database, firstB);
    assert.equal(permanentTotals(database, projectId, canvasA).totalRows, 1);
    assert.equal(permanentTotals(database, projectId, canvasB).totalRows, 1);
    assert.equal(database.getCollaborationOperationIdentity(rejectedA.op_id), null);
    assertExactAccounting(database, projectId, canvasA);
    assertExactAccounting(database, projectId, canvasB);

    const graphB = prepareGraphBatch(database, projectId, canvasB, { nodeUid: nodeB });
    applyPreparedGraphBatch(database, canvasB, graphB);
    assert.ok(permanentTotals(database, projectId, canvasB).totalRows > 1);
    database.deleteCanvas(canvasB);
    assert.equal(database.getCanvas(canvasB), null);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_permanent_ledger_policies WHERE canvas_id = ?
    `).get(canvasB).count, 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_permanent_ledger_usage WHERE canvas_id = ?
    `).get(canvasB).count, 0);
    for (const spec of PROJECT_DATABASE_PERMANENT_LEDGER_SPECS) {
      assert.equal(database.db.prepare(`
        SELECT COUNT(*) AS count FROM ${spec.table} WHERE canvas_id = ?
      `).get(canvasB).count, 0, `${spec.kind} must cascade with deleteCanvas`);
    }
    assert.equal(permanentTotals(database, projectId, canvasA).totalRows, 1);
    assert.equal(database.getCollaborationOperationIdentity(firstA.op_id).canvas_id, canvasA);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});

test('B2 cold reopen fails closed on usage and policy tampering without repairing either file', async () => {
  const cases = [
    {
      name: 'usage',
      tamper(raw, projectId, canvasId) {
        raw.prepare(`
          UPDATE canvas_permanent_ledger_usage
          SET logical_bytes = logical_bytes + 1
          WHERE project_id = ? AND canvas_id = ? AND ledger_kind = 'operation-identity'
        `).run(projectId, canvasId);
      },
      read(raw, projectId, canvasId) {
        return Number(raw.prepare(`
          SELECT logical_bytes FROM canvas_permanent_ledger_usage
          WHERE project_id = ? AND canvas_id = ? AND ledger_kind = 'operation-identity'
        `).get(projectId, canvasId).logical_bytes);
      },
    },
    {
      name: 'policy',
      tamper(raw, projectId, canvasId) {
        raw.prepare(`
          UPDATE canvas_permanent_ledger_policies SET pressure_state = 'over-capacity'
          WHERE project_id = ? AND canvas_id = ?
        `).run(projectId, canvasId);
      },
      read(raw, projectId, canvasId) {
        return raw.prepare(`
          SELECT pressure_state FROM canvas_permanent_ledger_policies
          WHERE project_id = ? AND canvas_id = ?
        `).get(projectId, canvasId).pressure_state;
      },
    },
  ];

  for (const scenario of cases) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `t8-b2-ledger-${scenario.name}-`));
    const filename = path.join(directory, 'project.sqlite3');
    const projectId = `project-permanent-ledger-cold-${scenario.name}`;
    const canvasId = `canvas-permanent-ledger-cold-${scenario.name}`;
    let database = null;
    let raw = null;
    try {
      database = new ProjectDatabase(filename, { autoBackup: false });
      ensureCanvas(database, projectId, canvasId);
      insertIdentity(database, identityRow(projectId, canvasId, {
        opId: `cold-${scenario.name}-identity`,
      }));
      await database.close();
      database = null;

      raw = new BetterSqlite3(filename);
      const beforeTamper = scenario.read(raw, projectId, canvasId);
      scenario.tamper(raw, projectId, canvasId);
      const tampered = scenario.read(raw, projectId, canvasId);
      assert.notEqual(tampered, beforeTamper);
      raw.close();
      raw = null;

      assert.throws(
        () => new ProjectDatabase(filename, { autoBackup: false }),
        (error) => error instanceof ProjectDatabaseSchemaInvalidError
          && error.code === 'project_database_schema_invalid',
        `${scenario.name} tampering must fail closed during read-only preflight`,
      );

      raw = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
      assert.equal(
        scenario.read(raw, projectId, canvasId),
        tampered,
        `${scenario.name} fail-close must not repair or rewrite the retained evidence`,
      );
      raw.close();
      raw = null;
    } finally {
      try { if (raw?.open) raw.close(); } catch (_) {}
      if (database) await database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});
