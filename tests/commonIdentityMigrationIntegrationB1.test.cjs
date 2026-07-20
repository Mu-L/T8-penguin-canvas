const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MIGRATION_CONTRACT,
  stableProjectEntityUuid,
} = require('../backend/src/services/projectIdentityMigration');
const {
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');

const FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'canvas-v1',
  '30-comprehensive-cross-domain.json',
);
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function readFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function assertV5Identity(record, legacyAlias, label) {
  assert.match(record.entityUid, UUID_V5, `${label} must persist an RFC4122 v5 identity`);
  assert.ok(Array.isArray(record.legacyAliases), `${label} must persist legacyAliases`);
  assert.ok(record.legacyAliases.includes(legacyAlias), `${label} must retain ${legacyAlias} as an alias`);
}

function identityProjection(document) {
  const definition = document.subflowDefinitions[0];
  const run = document.runs[0];
  const thread = document.reviewThreads[0];
  return {
    canvas: document.entityUid,
    nodes: document.nodes.map(({ id, entityUid, legacyAliases }) => ({ id, entityUid, legacyAliases })),
    edges: document.edges.map(({
      id,
      entityUid,
      legacyAliases,
      sourceEntityUid,
      targetEntityUid,
    }) => ({ id, entityUid, legacyAliases, sourceEntityUid, targetEntityUid })),
    assets: document.assets.map(({ id, entityUid, legacyAliases }) => ({ id, entityUid, legacyAliases })),
    subflowDefinition: {
      id: definition.id,
      entityUid: definition.entityUid,
      legacyAliases: definition.legacyAliases,
      nodes: definition.nodes.map(({ id, entityUid, legacyAliases }) => ({ id, entityUid, legacyAliases })),
      edges: definition.edges.map(({ id, entityUid, legacyAliases }) => ({ id, entityUid, legacyAliases })),
      inputs: definition.inputs.map(({ id, entityUid, legacyAliases }) => ({ id, entityUid, legacyAliases })),
      outputs: definition.outputs.map(({ id, entityUid, legacyAliases }) => ({ id, entityUid, legacyAliases })),
      parameters: definition.exposedParameters.map(({ id, entityUid, legacyAliases }) => ({ id, entityUid, legacyAliases })),
    },
    subflowInstances: document.subflowInstances.map(({
      instanceId,
      entityUid,
      legacyAliases,
      definitionEntityUid,
      nodeEntityUid,
    }) => ({ instanceId, entityUid, legacyAliases, definitionEntityUid, nodeEntityUid })),
    run: {
      id: run.id,
      entityUid: run.entityUid,
      legacyAliases: run.legacyAliases,
      nodeEntityUids: run.nodeEntityUids,
      outputAssetEntityUids: run.outputAssetEntityUids,
      nodeRuns: run.nodeRuns.map((nodeRun) => ({
        id: nodeRun.id,
        entityUid: nodeRun.entityUid,
        legacyAliases: nodeRun.legacyAliases,
        nodeEntityUid: nodeRun.nodeEntityUid,
        definitionEntityUid: nodeRun.definitionEntityUid,
        attempts: nodeRun.attempts.map(({ id, entityUid, legacyAliases, nodeRunEntityUid }) => ({
          id,
          entityUid,
          legacyAliases,
          nodeRunEntityUid,
        })),
      })),
      events: run.events.map(({ id, entityUid, legacyAliases, runEntityUid, nodeRunEntityUid }) => ({
        id,
        entityUid,
        legacyAliases,
        runEntityUid,
        nodeRunEntityUid,
      })),
    },
    review: {
      id: thread.id,
      entityUid: thread.entityUid,
      legacyAliases: thread.legacyAliases,
      anchor: thread.anchor,
      comments: thread.comments.map(({ id, entityUid, legacyAliases, threadEntityUid, parentEntityUid }) => ({
        id,
        entityUid,
        legacyAliases,
        threadEntityUid,
        parentEntityUid,
      })),
    },
  };
}

function assertLegacyBusinessFieldsPreserved(document, legacy) {
  assert.deepEqual(document.theme, legacy.theme);
  assert.deepEqual(document.creativeDesk, legacy.creativeDesk);
  assert.deepEqual(document.privateData, legacy.privateData);
  assert.deepEqual(document.unknownRootField, legacy.unknownRootField);
  assert.deepEqual(document.viewport, legacy.viewport);
  assert.deepEqual(
    document.subflowDefinitions[0].unknownDefinitionField,
    legacy.subflowDefinitions[0].unknownDefinitionField,
  );
}

function assertCrossDomainReferences(document) {
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]));
  const assetById = new Map(document.assets.map((asset) => [asset.id, asset]));
  const definition = document.subflowDefinitions[0];
  const run = document.runs[0];
  const thread = document.reviewThreads[0];

  for (const edge of document.edges) {
    assert.equal(edge.sourceEntityUid, nodeById.get(edge.source).entityUid);
    assert.equal(edge.targetEntityUid, nodeById.get(edge.target).entityUid);
  }
  assert.equal(
    nodeById.get('campaign-upload').data.sourceAssetEntityUid,
    assetById.get('campaign-product').entityUid,
  );
  assert.deepEqual(
    document.assets[1].parentAssetEntityUids,
    [assetById.get('campaign-product').entityUid],
  );
  assert.equal(
    nodeById.get('campaign-subflow').data.definitionEntityUid,
    definition.entityUid,
  );
  assert.equal(document.subflowInstances[0].definitionEntityUid, definition.entityUid);
  assert.equal(
    document.subflowInstances[0].nodeEntityUid,
    nodeById.get('campaign-subflow').entityUid,
  );
  assert.equal(
    definition.inputs[0].internalNodeEntityUid,
    definition.nodes.find((node) => node.id === 'layout-image').entityUid,
  );
  assert.equal(
    definition.exposedParameters[0].nodeEntityUid,
    definition.nodes.find((node) => node.id === 'layout-copy').entityUid,
  );
  assert.equal(run.nodeEntityUids[0], nodeById.get('campaign-subflow').entityUid);
  assert.equal(run.outputAssetEntityUids[0], assetById.get('campaign-result').entityUid);
  assert.equal(run.nodeRuns[0].definitionEntityUid, definition.entityUid);
  assert.equal(run.events[0].nodeRunEntityUid, run.nodeRuns[0].entityUid);
  assert.equal(run.events[0].payload.assetEntityUid, assetById.get('campaign-result').entityUid);
  assert.equal(thread.anchor.assetEntityUid, assetById.get('campaign-result').entityUid);
  assert.equal(thread.comments[0].threadEntityUid, thread.entityUid);
}

function scopedRowCount(database, table, canvasId) {
  return database.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE canvas_id = ?`)
    .get(canvasId).count;
}

test('ensureCanvas persists the real B1 identity migration and survives close, save and reopen exactly', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b1-identity-integration-'));
  const filename = path.join(directory, 'project.sqlite3');
  const legacy = readFixture();
  const canvasId = legacy.canvasId;
  let database;

  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    const ensured = database.ensureCanvas(canvasId, legacy, legacy.projectId, {
      initializeResourceScope: false,
    });

    assert.equal(ensured.identityContract, MIGRATION_CONTRACT);
    assert.equal(
      ensured.entityUid,
      stableProjectEntityUuid(legacy.projectId, canvasId, 'canvas'),
    );
    assert.match(ensured.entityUid, UUID_V5);
    assertLegacyBusinessFieldsPreserved(ensured, legacy);

    for (const node of ensured.nodes) assertV5Identity(node, node.id, `node ${node.id}`);
    for (const edge of ensured.edges) assertV5Identity(edge, edge.id, `edge ${edge.id}`);
    for (const asset of ensured.assets) assertV5Identity(asset, asset.id, `asset ${asset.id}`);
    const definition = ensured.subflowDefinitions[0];
    assertV5Identity(definition, definition.id, `subflow ${definition.id}`);
    assertV5Identity(
      ensured.subflowInstances[0],
      ensured.subflowInstances[0].instanceId,
      `subflow instance ${ensured.subflowInstances[0].instanceId}`,
    );
    const run = ensured.runs[0];
    assertV5Identity(run, run.id, `run ${run.id}`);
    assertV5Identity(run.nodeRuns[0], run.nodeRuns[0].id, `node run ${run.nodeRuns[0].id}`);
    assertV5Identity(
      run.nodeRuns[0].attempts[0],
      run.nodeRuns[0].attempts[0].id,
      `attempt ${run.nodeRuns[0].attempts[0].id}`,
    );
    assertV5Identity(run.events[0], run.events[0].id, `event ${run.events[0].id}`);
    const review = ensured.reviewThreads[0];
    assertV5Identity(review, review.id, `review ${review.id}`);
    assertV5Identity(review.comments[0], review.comments[0].id, `comment ${review.comments[0].id}`);
    assertCrossDomainReferences(ensured);

    const firstIdentities = identityProjection(ensured);
    const rawInitial = JSON.parse(database.db.prepare(`
      SELECT snapshot_json FROM canvas_documents WHERE canvas_id = ?
    `).get(canvasId).snapshot_json);
    assert.deepEqual(rawInitial, ensured, 'ensureCanvas must persist the migrated document, not only hydrate it in memory');
    assert.equal(rawInitial.identityContract, MIGRATION_CONTRACT);
    assert.equal(scopedRowCount(database, 'canvas_snapshots', canvasId), 1);
    database.close();
    database = null;

    database = new ProjectDatabase(filename, { autoBackup: false });
    const reopened = database.getCanvas(canvasId);
    assert.deepEqual(reopened, ensured);
    assertLegacyBusinessFieldsPreserved(reopened, legacy);
    assert.deepEqual(identityProjection(reopened), firstIdentities);
    assertCrossDomainReferences(reopened);

    const saved = database.saveCanvasSnapshot(canvasId, reopened, {
      expectedRevision: reopened.revision,
      opId: 'b1-identity-idempotent-save',
      actorId: 'local-owner',
      sessionId: 'b1-identity-test',
    });
    assert.equal(saved.revision, reopened.revision + 1);
    assert.equal(saved.identityContract, MIGRATION_CONTRACT);
    assertLegacyBusinessFieldsPreserved(saved, legacy);
    assert.deepEqual(identityProjection(saved), firstIdentities);
    assertCrossDomainReferences(saved);
    assert.equal(scopedRowCount(database, 'canvas_snapshots', canvasId), 2);
    database.close();
    database = null;

    database = new ProjectDatabase(filename, { autoBackup: false });
    const savedAndReopened = database.getCanvas(canvasId);
    assert.deepEqual(savedAndReopened, saved);
    assertLegacyBusinessFieldsPreserved(savedAndReopened, legacy);
    assert.deepEqual(identityProjection(savedAndReopened), firstIdentities);
    assertCrossDomainReferences(savedAndReopened);
    const rawSaved = JSON.parse(database.db.prepare(`
      SELECT snapshot_json FROM canvas_documents WHERE canvas_id = ?
    `).get(canvasId).snapshot_json);
    assert.deepEqual(rawSaved, savedAndReopened);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('duplicate B1 aliases fail closed without any partially persisted canvas rows', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const canvasId = 'b1-duplicate-alias-canvas';
  try {
    assert.throws(() => database.ensureCanvas(canvasId, {
      projectId: 'b1-failure-project',
      nodes: [
        { id: 'node-a', legacyAliases: ['shared-old-node'], type: 'text', position: { x: 0, y: 0 }, data: {} },
        { id: 'node-b', legacyAliases: ['shared-old-node'], type: 'text', position: { x: 1, y: 1 }, data: {} },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }, 'b1-failure-project', { initializeResourceScope: false }), (error) => (
      error?.code === 'identity_alias_collision'
    ));

    for (const table of [
      'canvas_documents',
      'canvas_snapshots',
      'canvas_resource_grant_state',
      'canvas_resource_grants',
      'canvas_operations',
      'audit_events',
    ]) {
      assert.equal(scopedRowCount(database, table, canvasId), 0, table);
    }
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});

test('dangling B1 structural references fail closed without any partially persisted canvas rows', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const canvasId = 'b1-dangling-reference-canvas';
  try {
    assert.throws(() => database.ensureCanvas(canvasId, {
      projectId: 'b1-failure-project',
      nodes: [
        { id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [
        { id: 'edge-a', source: 'node-a', target: 'missing-node' },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    }, 'b1-failure-project', { initializeResourceScope: false }), (error) => (
      error?.code === 'identity_reference_missing'
    ));

    for (const table of [
      'canvas_documents',
      'canvas_snapshots',
      'canvas_resource_grant_state',
      'canvas_resource_grants',
      'canvas_operations',
      'audit_events',
    ]) {
      assert.equal(scopedRowCount(database, table, canvasId), 0, table);
    }
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});
