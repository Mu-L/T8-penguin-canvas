const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const BetterSqlite3 = require('better-sqlite3');

const {
  COMMON_OPERATION_BATCH_CONTRACT,
} = require('../backend/src/collaboration/commonOperationProtocol');
const {
  digestSubflowUpgradePlan,
} = require('../backend/src/services/collaborationDomainAuthority');
const {
  OperationBatchConflictError,
  PROJECT_DATABASE_MIGRATIONS,
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
  RevisionConflictError,
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
  stableEntityUuid,
} = require('../backend/src/collaboration/protocol');
const {
  assertCurrentProjectDatabaseRegistry,
  stripSchema32ForSyntheticSchema31,
} = require('./helpers/projectDatabaseVersion.cjs');

const PROJECT_ID = 'project-subflow-common-b1';
const CANVAS_ID = 'canvas-subflow-common-b1';
const DEFINITION_ID = 'legacy-definition-display-id';
const DEFINITION_UID = stableEntityUuid(PROJECT_ID, 'subflow-definition', DEFINITION_ID);

const U = Object.freeze({
  canvas: '90000000-0000-4000-8000-000000000001',
  batch: '90000000-0000-4000-8000-000000000002',
  client: '90000000-0000-4000-8000-000000000003',
  operation: '90000000-0000-4000-8000-000000000004',
  instance: '90000000-0000-4000-8000-000000000005',
  sourceNode: '90000000-0000-4000-8000-000000000006',
  targetNode: '90000000-0000-4000-8000-000000000007',
  mappedEdge: '90000000-0000-4000-8000-000000000008',
  disconnectedEdge: '90000000-0000-4000-8000-000000000009',
  inputV1: '90000000-0000-4000-8000-000000000010',
  inputV2: '90000000-0000-4000-8000-000000000011',
  outputV1: '90000000-0000-4000-8000-000000000012',
  parameterKeepV1: '90000000-0000-4000-8000-000000000013',
  parameterKeepV2: '90000000-0000-4000-8000-000000000014',
  parameterDropV1: '90000000-0000-4000-8000-000000000015',
  definitionNodeV1: '90000000-0000-4000-8000-000000000016',
  definitionNodeV2: '90000000-0000-4000-8000-000000000017',
  secondOperation: '90000000-0000-4000-8000-000000000020',
  rollbackBatch: '90000000-0000-4000-8000-000000000021',
  rollbackClient: '90000000-0000-4000-8000-000000000022',
  collisionBatch: '90000000-0000-4000-8000-000000000023',
  collisionClient: '90000000-0000-4000-8000-000000000024',
});

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

function publishDefinitions(database) {
  const source = database.saveSubflowDefinition({
    id: DEFINITION_ID,
    entityUid: DEFINITION_UID,
    projectId: PROJECT_ID,
    version: 1,
    name: '旧显示 ID 子工作流',
    description: 'v1 source',
    nodes: [{
      id: 'definition-node-v1',
      entityUid: U.definitionNodeV1,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { prompt: 'v1' },
    }],
    edges: [],
    inputs: [{
      id: 'prompt-v1', entityUid: U.inputV1, name: 'Prompt', kind: 'text',
      internalNodeId: 'definition-node-v1', internalHandle: 'text-in', maxConnections: 2,
    }],
    outputs: [{
      id: 'image-v1', entityUid: U.outputV1, name: 'Image', kind: 'image',
      internalNodeId: 'definition-node-v1', internalHandle: 'image-out',
    }],
    exposedParameters: [
      {
        id: 'steps-v1', entityUid: U.parameterKeepV1, name: 'Steps',
        nodeId: 'definition-node-v1', dataKey: 'steps',
        schema: { type: 'integer', minimum: 1, maximum: 20 },
      },
      {
        id: 'obsolete-v1', entityUid: U.parameterDropV1, name: 'Obsolete',
        nodeId: 'definition-node-v1', dataKey: 'obsolete', schema: { type: 'string' },
      },
    ],
    customDefinitionField: { preserved: true, stage: 'source' },
  }, { actorId: 'owner-b1', sessionId: 'publish-session', expectedRevision: 0 });

  const target = database.saveSubflowDefinition({
    id: DEFINITION_ID,
    entityUid: DEFINITION_UID,
    projectId: PROJECT_ID,
    name: '旧显示 ID 子工作流 v2',
    description: 'v2 complete authoritative definition',
    nodes: [{
      id: 'definition-node-v2',
      entityUid: U.definitionNodeV2,
      type: 'text',
      position: { x: 25, y: 35 },
      data: { prompt: 'v2', nested: { exact: true } },
    }],
    edges: [],
    inputs: [{
      id: 'prompt-v2', entityUid: U.inputV2, name: 'Prompt 2', kind: 'text',
      internalNodeId: 'definition-node-v2', internalHandle: 'text-in-v2', maxConnections: 2,
    }],
    outputs: [],
    exposedParameters: [{
      id: 'steps-v2', entityUid: U.parameterKeepV2, name: 'Steps 2',
      nodeId: 'definition-node-v2', dataKey: 'steps',
      schema: { type: 'integer', minimum: 1, maximum: 20 },
    }],
    customDefinitionField: {
      preserved: true,
      stage: 'target',
      unknownBusinessPayload: ['must', 'survive', { deeply: true }],
    },
  }, { actorId: 'owner-b1', sessionId: 'publish-session', expectedRevision: 1 });

  assert.equal(source.entityUid, DEFINITION_UID);
  assert.equal(target.entityUid, DEFINITION_UID);
  assert.equal(source.version, 1);
  assert.equal(source.revision, 1);
  assert.equal(target.version, 2);
  assert.equal(target.revision, 2);
  return { source, target };
}

function instanceNode(entityUid, displayId, definition, overrides = {}) {
  return {
    id: displayId,
    entityUid,
    entityRevision: 1,
    type: 'subflow',
    position: { x: 100, y: 200 },
    data: {
      definitionEntityUid: DEFINITION_UID,
      definitionId: DEFINITION_ID,
      definitionVersion: definition.version,
      definitionRevision: definition.revision,
      definitionProjectId: PROJECT_ID,
      definition,
      parameterOverrides: { 'steps-v1': 8, 'obsolete-v1': 'discard me' },
      privateUiState: { mustRemain: true },
      ...overrides,
    },
  };
}

function ensureCanvas(database, source) {
  const nodes = [
    {
      id: 'source-display', entityUid: U.sourceNode, entityRevision: 1,
      type: 'text', position: { x: 0, y: 0 }, data: {},
    },
    instanceNode(U.instance, 'subflow-display', source),
    {
      id: 'target-display', entityUid: U.targetNode, entityRevision: 1,
      type: 'output', position: { x: 400, y: 0 }, data: {},
    },
  ];
  const edges = [
    {
      id: 'mapped-edge-display', entityUid: U.mappedEdge, entityRevision: 1,
      source: 'source-display', target: 'subflow-display',
      sourceHandle: 'text-out', targetHandle: 'prompt-v1', type: 'default', data: { keep: 1 },
    },
    {
      id: 'disconnect-edge-display', entityUid: U.disconnectedEdge, entityRevision: 1,
      source: 'subflow-display', target: 'target-display',
      sourceHandle: 'image-v1', targetHandle: 'image-in', type: 'default', data: { remove: 1 },
    },
  ];
  return database.ensureCanvas(CANVAS_ID, {
    projectId: PROJECT_ID,
    entityUid: U.canvas,
    nodes,
    edges,
    viewport: { x: 0, y: 0, zoom: 1 },
  }, PROJECT_ID);
}

function upgradePlan(instanceUid = U.instance, overrides = {}) {
  const plan = {
    instanceUid,
    definitionUid: DEFINITION_UID,
    expectedCanvasRevision: 1,
    expectedInstanceRevision: 1,
    expectedDefinitionVersion: 1,
    expectedDefinitionRevision: 1,
    targetDefinitionVersion: 2,
    targetDefinitionRevision: 2,
    portMappings: [
      { direction: 'input', fromPortEntityUid: U.inputV1, toPortEntityUid: U.inputV2 },
      { direction: 'output', fromPortEntityUid: U.outputV1, toPortEntityUid: null },
    ],
    parameterMappings: [
      { fromParameterEntityUid: U.parameterKeepV1, toParameterEntityUid: U.parameterKeepV2 },
      { fromParameterEntityUid: U.parameterDropV1, toParameterEntityUid: null },
    ],
    ...overrides,
  };
  return { ...plan, upgradePlanDigest: digestSubflowUpgradePlan(plan) };
}

function upgradeOperation(plan = upgradePlan(), overrides = {}) {
  return {
    opId: U.operation,
    type: 'subflow.instance.upgrade',
    payload: {
      instanceUid: plan.instanceUid,
      definitionUid: DEFINITION_UID,
      expectedCanvasRevision: 1,
      expectedInstanceRevision: 1,
      expectedDefinitionVersion: 1,
      expectedDefinitionRevision: 1,
      targetDefinitionVersion: 2,
      targetDefinitionRevision: 2,
      upgradePlanDigest: plan.upgradePlanDigest,
    },
    ...overrides,
  };
}

function batch(plan = upgradePlan(), overrides = {}) {
  return {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    baseRevision: 1,
    batchId: U.batch,
    clientId: U.client,
    clientSeq: 1,
    operations: [upgradeOperation(plan)],
    ...overrides,
  };
}

function principal() {
  return {
    memberId: 'editor-subflow-b1',
    sessionId: 'session-subflow-b1',
    capabilities: ['editGraph'],
  };
}

test('B1 subflow common batch resolves stable UID to legacy display IDs and commits one exact canvas transaction', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const { source, target } = publishDefinitions(database);
    ensureCanvas(database, source);
    const plan = upgradePlan();
    const request = batch(plan);
    const applied = database.applyCommonSubflowBatch(request, {
      principal: principal(),
      subflowUpgradePlans: [plan],
    });

    assert.equal(applied.duplicate, false);
    assert.equal(applied.document.revision, 2);
    assert.equal(applied.results.length, 1);
    assert.equal(applied.results[0].revision, 2);
    assert.equal(applied.results[0].instanceEntityUid, U.instance);
    assert.deepEqual(applied.results[0].nodeDataPatch.definition, target);
    assert.deepEqual(applied.results[0].disconnectedEdgeEntityUids, [U.disconnectedEdge]);
    assert.deepEqual(applied.results[0].discardedOverrides, [{
      parameterEntityUid: U.parameterDropV1,
      reason: 'removed',
    }]);

    const stored = database.getCanvas(CANVAS_ID);
    const instance = stored.nodes.find((node) => node.entityUid === U.instance);
    assert.equal(instance.id, 'subflow-display', 'the UUID target must not be mistaken for the legacy display primary key');
    assert.equal(instance.entityRevision, 2);
    assert.deepEqual(instance.data.privateUiState, { mustRemain: true }, 'nodeDataPatch must shallow-merge data');
    assert.equal(instance.data.definitionEntityUid, DEFINITION_UID);
    assert.equal(instance.data.definitionId, DEFINITION_ID);
    assert.equal(instance.data.definitionVersion, 2);
    assert.equal(instance.data.definitionRevision, 2);
    assert.deepEqual(instance.data.parameterOverrides, { 'steps-v2': 8 });
    assert.deepEqual(instance.data.definition, target, 'the complete authoritative target definition must be embedded');
    assert.deepEqual(instance.data.definition.customDefinitionField.unknownBusinessPayload, [
      'must', 'survive', { deeply: true },
    ]);

    const mapped = stored.edges.find((edge) => edge.entityUid === U.mappedEdge);
    assert.equal(mapped.id, 'mapped-edge-display');
    assert.equal(mapped.targetHandle, 'prompt-v2');
    assert.equal(mapped.entityRevision, 2);
    assert.equal(stored.edges.some((edge) => edge.entityUid === U.disconnectedEdge), false);
    assert.deepEqual(stored.tombstones.edges['disconnect-edge-display'], {
      opId: U.operation,
      actorId: principal().memberId,
      sessionId: principal().sessionId,
      deletedAt: stored.tombstones.edges['disconnect-edge-display'].deletedAt,
      revision: 2,
      entityUid: U.disconnectedEdge,
      entityType: 'default',
      source: 'subflow-display',
      target: 'target-display',
      sourceHandle: 'image-v1',
      targetHandle: 'image-in',
      legacyAliases: ['disconnect-edge-display'],
      sourceEntityUid: U.instance,
      targetEntityUid: U.targetNode,
    });

    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_common_operation_batches').get().count, 1);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_domain_operation_idempotency').get().count, 1);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'subflow.instance.upgrade'").get().count, 1);

    const replay = database.applyCommonSubflowBatch(request, { principal: principal() });
    assert.equal(replay.duplicate, true);
    assert.deepEqual(replay.results, applied.results);
    assert.equal(database.getCanvas(CANVAS_ID).revision, 2);

    const collision = structuredClone(request);
    collision.operations[0].payload.targetDefinitionRevision = 3;
    assert.throws(
      () => database.applyCommonSubflowBatch(collision, { principal: principal() }),
      (error) => error instanceof OperationBatchConflictError,
    );

    const stale = structuredClone(request);
    stale.batchId = U.collisionBatch;
    stale.clientId = U.collisionClient;
    stale.clientSeq = 2;
    stale.operations[0].opId = U.secondOperation;
    assert.throws(
      () => database.applyCommonSubflowBatch(stale, { principal: principal() }),
      (error) => error instanceof RevisionConflictError,
    );
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_common_operation_batches').get().count, 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});

test('B1 subflow common batch refreshes entity CAS per operation and rolls back every earlier write on failure', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const { source } = publishDefinitions(database);
    ensureCanvas(database, source);
    const firstPlan = upgradePlan();
    const staleSecondPlan = upgradePlan(U.instance, {
      // Reordering produces a distinct trusted digest for the same logical
      // request. The second operation would authorize against the stale input
      // document, but must fail after the first operation refreshes this
      // instance from entity revision 1 to 2.
      portMappings: [
        { direction: 'output', fromPortEntityUid: U.outputV1, toPortEntityUid: null },
        { direction: 'input', fromPortEntityUid: U.inputV1, toPortEntityUid: U.inputV2 },
      ],
      parameterMappings: [
        { fromParameterEntityUid: U.parameterDropV1, toParameterEntityUid: null },
        { fromParameterEntityUid: U.parameterKeepV1, toParameterEntityUid: U.parameterKeepV2 },
      ],
    });
    const request = {
      contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      baseRevision: 1,
      batchId: U.rollbackBatch,
      clientId: U.rollbackClient,
      clientSeq: 10,
      operations: [
        upgradeOperation(firstPlan),
        upgradeOperation(staleSecondPlan, { opId: U.secondOperation }),
      ],
    };

    assert.throws(
      () => database.applyCommonSubflowBatch(request, { principal: principal() }),
      (error) => error?.code === 'collaboration_domain_subflow_invalid',
      'a fresh write must never accept client-only plan digests without trusted server plans',
    );
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_common_operation_batches').get().count, 0);

    assert.throws(
      () => database.applyCommonSubflowBatch(request, {
        principal: principal(),
        subflowUpgradePlans: [firstPlan, staleSecondPlan],
      }),
      (error) => error?.code === 'collaboration_domain_subflow_invalid',
    );

    const stored = database.getCanvas(CANVAS_ID);
    assert.equal(stored.revision, 1);
    assert.equal(stored.nodes.find((node) => node.entityUid === U.instance).data.definitionVersion, 1);
    assert.equal(stored.edges.find((edge) => edge.entityUid === U.mappedEdge).targetHandle, 'prompt-v1');
    assert.equal(stored.edges.some((edge) => edge.entityUid === U.disconnectedEdge), true);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_common_operation_batches').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_domain_operation_idempotency').get().count, 0);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'subflow.instance.upgrade'").get().count, 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});

test('B2 schema28 persisted subflow Common batch upgrades through v29 to schema31 and keeps exact domain replay', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-subflow-domain-v29-'));
  const filename = path.join(directory, 'projects.sqlite3');
  let database = null;
  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    const { source } = publishDefinitions(database);
    ensureCanvas(database, source);
    const plan = upgradePlan();
    const request = batch(plan);
    const applied = database.applyCommonSubflowBatch(request, {
      principal: principal(),
      subflowUpgradePlans: [plan],
    });
    assert.equal(applied.document.revision, 2);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_domain_operation_idempotency
      WHERE batch_id = ?
    `).get(request.batchId).count, 1);
    await database.close();
    database = null;

    const legacy = new BetterSqlite3(filename);
    try {
      removeSchema31ExtensionForSyntheticSchema30(legacy);
      legacy.prepare('DELETE FROM schema_migration_receipts WHERE version = 30').run();
      legacy.prepare('DELETE FROM schema_migrations WHERE version = 30').run();
      legacy.exec(PROJECT_DATABASE_MIGRATION_30_DOWN_SQL);
      legacy.exec(PROJECT_DATABASE_MIGRATION_29_DOWN_SQL);
      legacy.prepare('DELETE FROM schema_migrations WHERE version = 29').run();
      assert.equal(legacy.prepare(`
        SELECT MAX(version) AS version FROM schema_migrations
      `).get().version, 28);
      assert.deepEqual(legacy.pragma('foreign_key_check'), []);
    } finally {
      legacy.close();
    }

    // The original current-schema bootstrap recovery point belongs to the
    // pre-rewrite lineage and cannot be reused by this synthetic schema28 DB.
    fs.rmSync(`${filename}.pre-migration-v30.sqlite3`, { force: true });

    database = new ProjectDatabase(filename, { autoBackup: false });
    assertCurrentProjectDatabaseRegistry(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATIONS);
    assert.equal(database.db.prepare(`
      SELECT MAX(version) AS version FROM schema_migrations
    `).get().version, PROJECT_DATABASE_SCHEMA_VERSION);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_common_graph_operation_evidence
      WHERE batch_id = ?
    `).get(request.batchId).count, 0, 'subflow replay remains domain evidence, not graph evidence');
    const replay = database.applyCommonSubflowBatch(request, { principal: principal() });
    assert.equal(replay.duplicate, true);
    assert.deepEqual(replay.results, applied.results);
    assert.equal(database.getCanvas(CANVAS_ID).revision, 2);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try { await database?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
