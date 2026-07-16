const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');
const express = require('express');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const { CollaborationAuth } = require('../backend/src/collaboration/auth');
const { CollaborationGateway } = require('../backend/src/collaboration/gateway');

const PROJECT_ID = 'project-resource-grant-publish-f1';
const CANVAS_ID = 'canvas-resource-grant-publish-f1';
const MAIN_SUBFLOW_ID = 'authorized-main-flow';
const DENIED_PUBLISH_STATUSES = new Set([400, 403, 409]);

function textNode(id, text, data = {}) {
  return {
    id,
    type: 'text',
    position: { x: 0, y: 0 },
    data: { text, ...data },
  };
}

function subflowNode(id, definitionId, definitionVersion = 1) {
  return {
    id,
    type: 'subflow',
    position: { x: 160, y: 0 },
    data: { definitionId, definitionVersion },
  };
}

function subflowDefinition(id, name, options = {}) {
  return {
    id,
    version: 1,
    projectId: PROJECT_ID,
    name,
    description: `${name} definition`,
    tags: [],
    nodes: options.nodes || [textNode(`${id}-text`, name)],
    edges: [],
    inputs: [],
    outputs: [],
    exposedParameters: [],
    requiredCapabilities: [],
    assetRefs: options.assetRefs || [],
  };
}

function saveSubflow(database, definition, expectedRevision = 0) {
  return database.saveSubflowDefinition(definition, {
    expectedRevision,
    actorId: 'local-owner',
    sessionId: 'resource-grant-publish-fixture',
    changeSummary: `save ${definition.name}`,
  });
}

function addAsset(database, id, filename) {
  return database.upsertAsset({
    id,
    projectId: PROJECT_ID,
    kind: 'image',
    mimeType: 'image/png',
    filename,
    createdBy: 'local-owner',
  });
}

function ensureCanvas(database, nodes) {
  return database.ensureCanvas(CANVAS_ID, {
    name: 'Resource grant publish F1',
    nodes,
    edges: [],
  }, PROJECT_ID);
}

function normalizeGrants(database) {
  const grants = database.listCanvasResourceGrants(PROJECT_ID, CANVAS_ID);
  const subflows = [];
  for (const [id, versions] of grants.subflowReferences) {
    for (const version of versions) subflows.push(`${id}@${version}`);
  }
  return {
    assets: [...grants.assetIds].sort(),
    subflows: subflows.sort(),
  };
}

function createGateway(database, directory) {
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  return new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    FRONTEND_DIST: '',
    INPUT_DIR: input,
    OUTPUT_DIR: output,
  }, database);
}

async function withMemoryGateway(setupDatabase, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-resource-grant-publish-f1-'));
  const database = new ProjectDatabase(':memory:');
  const gateway = createGateway(database, directory);
  try {
    setupDatabase(database);
    assert.ok(database.getCanvas(CANVAS_ID), 'fixture must create the collaboration canvas');
    const status = await gateway.start({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}`;
    await run({ baseUrl, database, gateway });
  } finally {
    await gateway.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_) {
      payload = text;
    }
  }
  return { status: response.status, payload };
}

async function redeemInvite(baseUrl, invite, displayName) {
  const response = await fetch(`${baseUrl}/api/collab/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, displayName }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  const cookie = String(response.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.includes('='), 'redeemed collaboration session must set a cookie');
  return { cookie, payload: payload.data };
}

async function redeemEditor(baseUrl, gateway) {
  const invite = gateway.auth.createInvite({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    role: 'editor',
    maxUses: 1,
  });
  return redeemInvite(baseUrl, invite, 'Resource grant editor');
}

function publishSubflow(baseUrl, cookie, definition, changeSummary) {
  return request(
    baseUrl,
    `/api/collab/subflows/${encodeURIComponent(MAIN_SUBFLOW_ID)}/publish`,
    {
      method: 'POST',
      cookie,
      body: {
        baseRevision: 1,
        changeSummary,
        definition,
      },
    },
  );
}

function assertNoPublishResidue(database, before) {
  const head = database.getSubflowDefinitionHead(MAIN_SUBFLOW_ID, PROJECT_ID);
  assert.deepEqual({
    revision: head.revision,
    latestVersion: head.latestVersion,
    versionCount: database.listSubflowVersions(MAIN_SUBFLOW_ID, PROJECT_ID).length,
    versionTwoExists: Boolean(database.getSubflowDefinition(MAIN_SUBFLOW_ID, 2, PROJECT_ID)),
    grants: normalizeGrants(database),
    auditCount: database.listAuditEvents({
      projectId: PROJECT_ID,
      action: 'subflow.definition.publish',
    }).length,
  }, {
    revision: before.head.revision,
    latestVersion: before.head.latestVersion,
    versionCount: before.versionCount,
    versionTwoExists: false,
    grants: before.grants,
    auditCount: before.auditCount,
  });
}

function publishBaseline(database) {
  saveSubflow(
    database,
    subflowDefinition(MAIN_SUBFLOW_ID, 'Authorized main v1'),
  );
  ensureCanvas(database, [
    subflowNode('authorized-main-instance', MAIN_SUBFLOW_ID, 1),
  ]);
  assert.deepEqual(normalizeGrants(database), {
    assets: [],
    subflows: [`${MAIN_SUBFLOW_ID}@1`],
  });
}

test('publishing an authorized subflow cannot add an unauthorized sibling subflow or leave version/grant residue', async () => {
  const siblingId = 'unauthorized-sibling-flow';
  await withMemoryGateway((database) => {
    saveSubflow(
      database,
      subflowDefinition(siblingId, 'Unauthorized sibling'),
    );
    publishBaseline(database);
  }, async ({ baseUrl, database, gateway }) => {
    const editor = await redeemEditor(baseUrl, gateway);
    const hiddenBefore = await request(
      baseUrl,
      `/api/collab/subflows/${encodeURIComponent(siblingId)}/1`,
      { cookie: editor.cookie },
    );
    assert.equal(hiddenBefore.status, 404, JSON.stringify(hiddenBefore.payload));
    const before = {
      head: database.getSubflowDefinitionHead(MAIN_SUBFLOW_ID, PROJECT_ID),
      versionCount: database.listSubflowVersions(MAIN_SUBFLOW_ID, PROJECT_ID).length,
      grants: normalizeGrants(database),
      auditCount: database.listAuditEvents({
        projectId: PROJECT_ID,
        action: 'subflow.definition.publish',
      }).length,
    };

    const denied = await publishSubflow(
      baseUrl,
      editor.cookie,
      subflowDefinition(MAIN_SUBFLOW_ID, 'Malicious main v2', {
        nodes: [subflowNode('main-to-sibling', siblingId, 1)],
      }),
      'attempt unauthorized sibling dependency',
    );
    assert.equal(DENIED_PUBLISH_STATUSES.has(denied.status), true, JSON.stringify(denied.payload));
    assert.equal(denied.payload?.success, false, JSON.stringify(denied.payload));
    assertNoPublishResidue(database, before);

    const hiddenAfter = await request(
      baseUrl,
      `/api/collab/subflows/${encodeURIComponent(siblingId)}/1`,
      { cookie: editor.cookie },
    );
    assert.equal(hiddenAfter.status, 404, JSON.stringify(hiddenAfter.payload));
  });
});

test('publishing an authorized subflow cannot add an unauthorized asset or leave version/grant residue', async () => {
  const siblingAssetId = 'unauthorized-sibling-asset';
  await withMemoryGateway((database) => {
    addAsset(database, siblingAssetId, 'unauthorized-sibling.png');
    publishBaseline(database);
  }, async ({ baseUrl, database, gateway }) => {
    const editor = await redeemEditor(baseUrl, gateway);
    const hiddenBefore = await request(
      baseUrl,
      `/api/collab/assets/${encodeURIComponent(siblingAssetId)}`,
      { cookie: editor.cookie },
    );
    assert.equal(hiddenBefore.status, 404, JSON.stringify(hiddenBefore.payload));
    const before = {
      head: database.getSubflowDefinitionHead(MAIN_SUBFLOW_ID, PROJECT_ID),
      versionCount: database.listSubflowVersions(MAIN_SUBFLOW_ID, PROJECT_ID).length,
      grants: normalizeGrants(database),
      auditCount: database.listAuditEvents({
        projectId: PROJECT_ID,
        action: 'subflow.definition.publish',
      }).length,
    };

    const maliciousDefinition = subflowDefinition(
      MAIN_SUBFLOW_ID,
      'Malicious asset main v2',
      { assetRefs: [siblingAssetId] },
    );
    delete maliciousDefinition.version;
    const denied = await publishSubflow(
      baseUrl,
      editor.cookie,
      maliciousDefinition,
      'attempt unauthorized asset dependency',
    );
    assert.equal(DENIED_PUBLISH_STATUSES.has(denied.status), true, JSON.stringify(denied.payload));
    assert.equal(denied.payload?.success, false, JSON.stringify(denied.payload));
    assertNoPublishResidue(database, before);

    const hiddenAfter = await request(
      baseUrl,
      `/api/collab/assets/${encodeURIComponent(siblingAssetId)}`,
      { cookie: editor.cookie },
    );
    assert.equal(hiddenAfter.status, 404, JSON.stringify(hiddenAfter.payload));
  });
});

test('publishing with already authorized dependencies atomically grants only the exact new subflow version', async () => {
  const legalChildId = 'authorized-child-flow';
  const legalAssetId = 'authorized-child-asset';
  const unrelatedFlowId = 'unrelated-flow';
  const unrelatedAssetId = 'unrelated-asset';
  await withMemoryGateway((database) => {
    addAsset(database, legalAssetId, 'authorized-child.png');
    addAsset(database, unrelatedAssetId, 'unrelated.png');
    saveSubflow(
      database,
      subflowDefinition(legalChildId, 'Authorized child'),
    );
    saveSubflow(
      database,
      subflowDefinition(unrelatedFlowId, 'Unrelated flow'),
    );
    saveSubflow(
      database,
      subflowDefinition(MAIN_SUBFLOW_ID, 'Authorized dependency main v1', {
        nodes: [subflowNode('main-to-authorized-child', legalChildId, 1)],
        assetRefs: [legalAssetId],
      }),
    );
    ensureCanvas(database, [
      subflowNode('authorized-main-instance', MAIN_SUBFLOW_ID, 1),
    ]);
    assert.deepEqual(normalizeGrants(database), {
      assets: [legalAssetId],
      subflows: [
        `${legalChildId}@1`,
        `${MAIN_SUBFLOW_ID}@1`,
      ].sort(),
    });
  }, async ({ baseUrl, database, gateway }) => {
    const editor = await redeemEditor(baseUrl, gateway);
    const published = await publishSubflow(
      baseUrl,
      editor.cookie,
      subflowDefinition(MAIN_SUBFLOW_ID, 'Authorized dependency main v2', {
        nodes: [
          subflowNode('main-to-authorized-child', legalChildId, 1),
          textNode('main-v2-note', 'safe update'),
        ],
        assetRefs: [legalAssetId],
      }),
      'publish exact authorized dependencies',
    );
    assert.equal(published.status, 201, JSON.stringify(published.payload));
    assert.equal(published.payload.data.version, 2);
    assert.equal(published.payload.data.revision, 2);

    assert.deepEqual(normalizeGrants(database), {
      assets: [legalAssetId],
      subflows: [
        `${legalChildId}@1`,
        `${MAIN_SUBFLOW_ID}@1`,
        `${MAIN_SUBFLOW_ID}@2`,
      ].sort(),
    });
    assert.deepEqual(
      database.listSubflowVersions(MAIN_SUBFLOW_ID, PROJECT_ID)
        .map((definition) => definition.version),
      [2, 1],
    );
    assert.equal(
      database.getSubflowDefinitionHead(MAIN_SUBFLOW_ID, PROJECT_ID).latestVersion,
      2,
    );

    const versionTwo = await request(
      baseUrl,
      `/api/collab/subflows/${encodeURIComponent(MAIN_SUBFLOW_ID)}/2`,
      { cookie: editor.cookie },
    );
    assert.equal(versionTwo.status, 200, JSON.stringify(versionTwo.payload));
    assert.equal(versionTwo.payload.data.name, 'Authorized dependency main v2');
    const unrelatedFlow = await request(
      baseUrl,
      `/api/collab/subflows/${encodeURIComponent(unrelatedFlowId)}/1`,
      { cookie: editor.cookie },
    );
    assert.equal(unrelatedFlow.status, 404, JSON.stringify(unrelatedFlow.payload));
    const unrelatedAsset = await request(
      baseUrl,
      `/api/collab/assets/${encodeURIComponent(unrelatedAssetId)}`,
      { cookie: editor.cookie },
    );
    assert.equal(unrelatedAsset.status, 404, JSON.stringify(unrelatedAsset.payload));
  });
});

test('schema 22 upgrade does not auto-grant resources already referenced by a legacy canvas or on first invite', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-resource-grant-schema22-f1-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const legacyAssetId = 'legacy-referenced-asset';
  const legacySubflowId = 'legacy-referenced-subflow';
  let upgraded = null;
  let gateway = null;
  try {
    const latest = new ProjectDatabase(filename, { autoBackup: false });
    try {
      addAsset(latest, legacyAssetId, 'legacy-reference.png');
      saveSubflow(
        latest,
        subflowDefinition(legacySubflowId, 'Legacy referenced subflow'),
      );
      ensureCanvas(latest, [
        textNode('legacy-asset-node', 'legacy asset', { sourceAssetId: legacyAssetId }),
        subflowNode('legacy-subflow-node', legacySubflowId, 1),
      ]);
      assert.deepEqual(normalizeGrants(latest), {
        assets: [legacyAssetId],
        subflows: [`${legacySubflowId}@1`],
      });
    } finally {
      latest.close();
    }

    const legacy = new BetterSqlite3(filename);
    try {
      legacy.exec(`
        DELETE FROM schema_migrations WHERE version = 23;
        DROP TABLE canvas_resource_grants;
        DROP TABLE canvas_resource_grant_state;
      `);
      assert.equal(
        legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
        22,
      );
      assert.equal(
        legacy.prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'canvas_resource_grants'",
        ).get(),
        undefined,
      );
    } finally {
      legacy.close();
    }

    upgraded = new ProjectDatabase(filename, { autoBackup: false });
    assert.equal(
      upgraded.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      23,
    );
    const resolvedLegacyReferences = upgraded.resolveCanvasDocumentResources(
      upgraded.getCanvas(CANVAS_ID),
    );
    assert.equal(resolvedLegacyReferences.requestedAssetIds.has(legacyAssetId), true);
    assert.equal(
      resolvedLegacyReferences.requestedSubflowReferences
        .get(legacySubflowId)
        ?.has(1),
      true,
    );
    assert.deepEqual(normalizeGrants(upgraded), {
      assets: [],
      subflows: [],
    }, 'upgrade must not convert pre-existing canvas content into collaboration grants');
    const migratedState = upgraded.getCanvasResourceGrantState(PROJECT_ID, CANVAS_ID);
    assert.ok(migratedState, 'upgrade must create a fail-closed resource state marker');
    assert.equal(migratedState.initializedAt, 0);

    gateway = createGateway(upgraded, directory);
    const status = await gateway.start({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}`;
    assert.throws(() => gateway.auth.createInvite({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      role: 'viewer',
      maxUses: 1,
    }), (error) => (
      error?.code === 'canvas_resource_scope_confirmation_required'
      && error?.status === 409
    ));
    assert.deepEqual(normalizeGrants(upgraded), {
      assets: [],
      subflows: [],
    }, 'the blocked first invite must not backfill grants from legacy canvas content');
    assert.equal(
      upgraded.getCanvasResourceGrantState(PROJECT_ID, CANVAS_ID).initializedAt,
      0,
    );

    const initialized = upgraded.initializeCanvasResourceGrantsForSharing(
      PROJECT_ID,
      CANVAS_ID,
    );
    assert.deepEqual({
      assetCount: initialized.assetCount,
      subflowCount: initialized.subflowCount,
      trustedRevision: initialized.trustedRevision,
    }, {
      assetCount: 1,
      subflowCount: 1,
      trustedRevision: upgraded.getCanvas(CANVAS_ID).revision,
    });
    assert.deepEqual(normalizeGrants(upgraded), {
      assets: [legacyAssetId],
      subflows: [`${legacySubflowId}@1`],
    }, 'only explicit host initialization may authorize legacy canvas references');
    assert.ok(
      upgraded.getCanvasResourceGrantState(PROJECT_ID, CANVAS_ID).initializedAt > 0,
    );

    const invite = gateway.auth.createInvite({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      role: 'viewer',
      maxUses: 1,
    });
    const viewer = await redeemInvite(baseUrl, invite, 'Legacy isolation viewer');
    assert.deepEqual(normalizeGrants(upgraded), {
      assets: [legacyAssetId],
      subflows: [`${legacySubflowId}@1`],
    }, 'invite redemption must preserve the explicitly confirmed grant set');

    const canvas = await request(
      baseUrl,
      `/api/collab/canvases/${encodeURIComponent(CANVAS_ID)}`,
      { cookie: viewer.cookie },
    );
    assert.equal(canvas.status, 200, JSON.stringify(canvas.payload));
    const asset = await request(
      baseUrl,
      `/api/collab/assets/${encodeURIComponent(legacyAssetId)}`,
      { cookie: viewer.cookie },
    );
    assert.equal(asset.status, 200, JSON.stringify(asset.payload));
    const subflow = await request(
      baseUrl,
      `/api/collab/subflows/${encodeURIComponent(legacySubflowId)}/1`,
      { cookie: viewer.cookie },
    );
    assert.equal(subflow.status, 200, JSON.stringify(subflow.payload));
    const assetList = await request(baseUrl, '/api/collab/assets?limit=20&offset=0', {
      cookie: viewer.cookie,
    });
    assert.equal(assetList.status, 200, JSON.stringify(assetList.payload));
    assert.deepEqual(assetList.payload.data.map((item) => item.id), [legacyAssetId]);
    assert.equal(assetList.payload.meta.total, 1);
    const subflowList = await request(baseUrl, '/api/collab/subflows', {
      cookie: viewer.cookie,
    });
    assert.equal(subflowList.status, 200, JSON.stringify(subflowList.payload));
    assert.deepEqual(
      subflowList.payload.data.map((item) => `${item.id}@${item.version}`),
      [`${legacySubflowId}@1`],
    );
  } finally {
    await gateway?.stop();
    upgraded?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy JSON GET hydration stays uninitialized until the host confirms resource scope', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-legacy-json-resource-scope-f1-'));
  const dataDirectory = path.join(directory, 'data');
  const canvasId = 'canvas-legacy-json-resource-scope-f1';
  const projectId = 'project-local';
  const canvasFile = path.join(dataDirectory, `canvas_${canvasId}.json`);
  const canvasListFile = path.join(dataDirectory, 'canvas_list.json');
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(canvasFile, JSON.stringify({
    nodes: [textNode('legacy-json-node', 'legacy JSON')],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }), 'utf8');
  fs.writeFileSync(canvasListFile, JSON.stringify([{
    id: canvasId,
    name: 'Legacy JSON resource scope',
    nodeCount: 1,
    createdAt: 1,
    updatedAt: 1,
  }]), 'utf8');

  const database = new ProjectDatabase(':memory:');
  const auth = new CollaborationAuth(database);
  const config = require('../backend/src/config');
  const previousConfig = {
    DATA_DIR: config.DATA_DIR,
    CANVAS_FILE: config.CANVAS_FILE,
    SETTINGS_FILE: config.SETTINGS_FILE,
  };
  Object.assign(config, {
    DATA_DIR: dataDirectory,
    CANVAS_FILE: canvasListFile,
    SETTINGS_FILE: path.join(dataDirectory, 'settings.json'),
  });

  const servicePath = require.resolve('../backend/src/services/projectDatabase');
  const routePath = require.resolve('../backend/src/routes/canvas');
  const serviceModule = require.cache[servicePath];
  const previousGetProjectDatabase = serviceModule.exports.getProjectDatabase;
  const previousRouteModule = require.cache[routePath];
  serviceModule.exports.getProjectDatabase = () => database;
  delete require.cache[routePath];

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/canvas', require(routePath));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/canvas`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    Object.assign(config, previousConfig);
    serviceModule.exports.getProjectDatabase = previousGetProjectDatabase;
    delete require.cache[routePath];
    if (previousRouteModule) require.cache[routePath] = previousRouteModule;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const hydratedResponse = await fetch(`${baseUrl}/${encodeURIComponent(canvasId)}`);
  const hydratedPayload = await hydratedResponse.json();
  assert.equal(hydratedResponse.status, 200, JSON.stringify(hydratedPayload));
  assert.equal(hydratedPayload.data.canvasId, canvasId);
  assert.deepEqual(database.listCanvasResourceGrants(projectId, canvasId).assetIds, new Set());
  assert.equal(
    database.getCanvasResourceGrantState(projectId, canvasId)?.initializedAt,
    0,
    'reading a legacy JSON mirror must create only a fail-closed state marker',
  );
  assert.throws(() => auth.createInvite({
    projectId,
    canvasId,
    role: 'viewer',
  }), (error) => (
    error?.code === 'canvas_resource_scope_confirmation_required'
    && error?.status === 409
  ));

  const initialized = database.initializeCanvasResourceGrantsForSharing(projectId, canvasId);
  assert.equal(initialized.confirmationRequired, false);
  assert.ok(database.getCanvasResourceGrantState(projectId, canvasId).initializedAt > 0);
  const invite = auth.createInvite({
    projectId,
    canvasId,
    role: 'viewer',
  });
  assert.equal(invite.canvasId, canvasId);

  const createdResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Explicit new canvas' }),
  });
  const createdPayload = await createdResponse.json();
  assert.equal(createdResponse.status, 200, JSON.stringify(createdPayload));
  assert.ok(
    database.getCanvasResourceGrantState(projectId, createdPayload.data.id).initializedAt > 0,
    'the explicit new-canvas route must keep its initialized resource scope behavior',
  );
});
