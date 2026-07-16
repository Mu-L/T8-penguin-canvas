const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const { CollaborationGateway } = require('../backend/src/collaboration/gateway');
const { previewCanvasPatch } = require('../backend/src/services/canvasPatch');

const PROJECT_ID = 'project-resource-scope-f1';
const CANVAS_A = 'canvas-resource-scope-a';
const CANVAS_B = 'canvas-resource-scope-b';
const AUTHORIZED_ASSET_ID = 'asset-upload-lineage-a';
const SIBLING_ASSET_ID = 'asset-sibling-lineage-b';
const UNREFERENCED_ASSET_ID = 'asset-unreferenced';
const AUTHORIZED_SUBFLOW_ID = 'subflow-authorized-a';
const SIBLING_SUBFLOW_ID = 'subflow-sibling-b';
const UNREFERENCED_SUBFLOW_ID = 'subflow-unreferenced';
const DENIED_MUTATION_STATUSES = new Set([403, 409]);

function subflowDefinition(id, name) {
  return {
    id,
    version: 1,
    projectId: PROJECT_ID,
    name,
    description: `${name} definition`,
    tags: [],
    nodes: [{
      id: `${id}-node`,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { text: name },
    }],
    edges: [],
    inputs: [],
    outputs: [],
    exposedParameters: [],
    requiredCapabilities: [],
    assetRefs: [],
  };
}

function saveSubflow(database, id, name) {
  return database.saveSubflowDefinition(subflowDefinition(id, name), {
    expectedRevision: 0,
    actorId: 'local-owner',
    sessionId: 'resource-scope-fixture',
    changeSummary: `create ${name}`,
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

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-collab-resource-scope-f1-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });

  const database = new ProjectDatabase(':memory:');
  saveSubflow(database, AUTHORIZED_SUBFLOW_ID, 'Authorized A');
  saveSubflow(database, SIBLING_SUBFLOW_ID, 'Sibling B');
  saveSubflow(database, UNREFERENCED_SUBFLOW_ID, 'Unreferenced');

  addAsset(database, AUTHORIZED_ASSET_ID, 'authorized-upload-a.png');
  addAsset(database, SIBLING_ASSET_ID, 'sibling-b.png');
  addAsset(database, UNREFERENCED_ASSET_ID, 'unreferenced.png');
  database.ensureCanvas(CANVAS_A, {
    name: 'Resource scope A',
    nodes: [
      {
        id: 'node-a',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { text: 'safe' },
      },
      {
        id: 'authorized-subflow-node',
        type: 'subflow',
        position: { x: 160, y: 0 },
        data: {
          definitionId: AUTHORIZED_SUBFLOW_ID,
          definitionVersion: 1,
        },
      },
    ],
    edges: [],
  }, PROJECT_ID);
  database.ensureCanvas(CANVAS_B, {
    name: 'Resource scope B',
    nodes: [
      {
        id: 'sibling-node',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { sourceAssetId: SIBLING_ASSET_ID },
      },
      {
        id: 'sibling-subflow-node',
        type: 'subflow',
        position: { x: 160, y: 0 },
        data: {
          definitionId: SIBLING_SUBFLOW_ID,
          definitionVersion: 1,
        },
      },
    ],
    edges: [],
  }, PROJECT_ID);
  database.recordAssetLineageEvent({
    assetId: AUTHORIZED_ASSET_ID,
    canvasId: CANVAS_A,
    sourceType: 'collaboration-upload',
    creatorId: 'local-owner',
  });
  database.recordAssetLineageEvent({
    assetId: SIBLING_ASSET_ID,
    canvasId: CANVAS_B,
    sourceType: 'collaboration-upload',
    creatorId: 'local-owner',
  });

  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    FRONTEND_DIST: '',
    INPUT_DIR: input,
    OUTPUT_DIR: output,
  }, database);
  return { database, gateway, directory };
}

async function withFixture(run) {
  const fixture = createFixture();
  try {
    const status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}`;
    await run({ ...fixture, baseUrl });
  } finally {
    await fixture.gateway.stop();
    fixture.database.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
}

async function request(baseUrl, pathname, options = {}) {
  const headers = {
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
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

async function redeem(baseUrl, gateway, role) {
  const invite = gateway.auth.createInvite({
    projectId: PROJECT_ID,
    canvasId: CANVAS_A,
    role,
    maxUses: 1,
  });
  const response = await fetch(`${baseUrl}/api/collab/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: invite.code,
      displayName: `Resource scope ${role}`,
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  const cookie = String(response.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.includes('='), 'redeemed collaboration session must set a cookie');
  const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
  const session = gateway.auth.authenticate(token);
  assert.ok(session, 'redeemed collaboration session must authenticate');
  return { cookie, session };
}

async function postOperation(baseUrl, database, cookie, operation) {
  return request(baseUrl, `/api/collab/canvases/${CANVAS_A}/operations`, {
    method: 'POST',
    cookie,
    body: {
      baseRevision: database.getCanvas(CANVAS_A).revision,
      operations: [operation],
    },
  });
}

function assetDetail(baseUrl, cookie, assetId) {
  return request(baseUrl, `/api/collab/assets/${encodeURIComponent(assetId)}`, { cookie });
}

function subflowDetail(baseUrl, cookie, definitionId) {
  return request(
    baseUrl,
    `/api/collab/subflows/${encodeURIComponent(definitionId)}/1`,
    { cookie },
  );
}

async function agentSearch(baseUrl, cookie, role, tool) {
  const result = await request(baseUrl, `/api/collab/canvases/${CANVAS_A}/agent/tools`, {
    method: 'POST',
    cookie,
    body: {
      tool,
      requestId: `resource-scope-${role}-${tool}`,
      projectId: 'forged-project',
      canvasId: 'forged-canvas',
      input: {
        query: '',
        limit: 20,
        offset: 0,
      },
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  return result.payload.data.data.items.map((item) => item.id).sort();
}

function resourceExpansionPatch(id, baseRevision) {
  return {
    schema: 't8-canvas-patch-v1',
    id,
    baseRevision,
    summary: 'Attempt to expand collaboration asset authority',
    diagnosticsResolved: ['security.resource-scope'],
    requiresConfirmation: true,
    operations: [{
      type: 'node.patch',
      payload: {
        nodeId: 'node-a',
        dataPatch: { sourceAssetId: SIBLING_ASSET_ID },
      },
    }],
  };
}

test('editor node.patch cannot authorize a sibling-canvas asset by injecting its sourceAssetId', async () => {
  await withFixture(async ({ baseUrl, gateway, database }) => {
    const editor = await redeem(baseUrl, gateway, 'editor');
    const hiddenBefore = await assetDetail(baseUrl, editor.cookie, SIBLING_ASSET_ID);
    assert.equal(hiddenBefore.status, 404, JSON.stringify(hiddenBefore.payload));
    const before = database.getCanvas(CANVAS_A);

    const mutation = await postOperation(baseUrl, database, editor.cookie, {
      opId: 'resource-scope-node-patch-sibling-asset',
      type: 'node.patch',
      payload: {
        nodeId: 'node-a',
        dataPatch: { sourceAssetId: SIBLING_ASSET_ID },
      },
    });
    const hiddenAfter = await assetDetail(baseUrl, editor.cookie, SIBLING_ASSET_ID);
    const after = database.getCanvas(CANVAS_A);

    assert.deepEqual({
      mutationDenied: DENIED_MUTATION_STATUSES.has(mutation.status),
      resourceStillHidden: hiddenAfter.status === 404,
      revisionUnchanged: after.revision === before.revision,
      referenceNotPersisted: !Object.hasOwn(after.nodes.find((node) => node.id === 'node-a').data, 'sourceAssetId'),
    }, {
      mutationDenied: true,
      resourceStillHidden: true,
      revisionUnchanged: true,
      referenceNotPersisted: true,
    }, JSON.stringify({
      mutationStatus: mutation.status,
      mutationPayload: mutation.payload,
      resourceStatus: hiddenAfter.status,
      beforeRevision: before.revision,
      afterRevision: after.revision,
    }));
  });
});

test('editor node.add cannot authorize an unreferenced sibling subflow', async () => {
  await withFixture(async ({ baseUrl, gateway, database }) => {
    const editor = await redeem(baseUrl, gateway, 'editor');
    const hiddenBefore = await subflowDetail(baseUrl, editor.cookie, SIBLING_SUBFLOW_ID);
    assert.equal(hiddenBefore.status, 404, JSON.stringify(hiddenBefore.payload));
    const before = database.getCanvas(CANVAS_A);

    const mutation = await postOperation(baseUrl, database, editor.cookie, {
      opId: 'resource-scope-node-add-sibling-subflow',
      type: 'node.add',
      payload: {
        node: {
          id: 'injected-sibling-subflow',
          type: 'subflow',
          position: { x: 320, y: 0 },
          data: {
            definitionId: SIBLING_SUBFLOW_ID,
            definitionVersion: 1,
          },
        },
      },
    });
    const hiddenAfter = await subflowDetail(baseUrl, editor.cookie, SIBLING_SUBFLOW_ID);
    const after = database.getCanvas(CANVAS_A);

    assert.deepEqual({
      mutationDenied: DENIED_MUTATION_STATUSES.has(mutation.status),
      definitionStillHidden: hiddenAfter.status === 404,
      revisionUnchanged: after.revision === before.revision,
      nodeNotPersisted: !after.nodes.some((node) => node.id === 'injected-sibling-subflow'),
    }, {
      mutationDenied: true,
      definitionStillHidden: true,
      revisionUnchanged: true,
      nodeNotPersisted: true,
    }, JSON.stringify({
      mutationStatus: mutation.status,
      mutationPayload: mutation.payload,
      definitionStatus: hiddenAfter.status,
      beforeRevision: before.revision,
      afterRevision: after.revision,
    }));
  });
});

test('Agent asset and subflow searches expose only resources authorized to the current canvas', async () => {
  await withFixture(async ({ baseUrl, gateway }) => {
    const observed = {};
    for (const role of ['viewer', 'editor']) {
      const session = await redeem(baseUrl, gateway, role);
      observed[role] = {
        assets: await agentSearch(baseUrl, session.cookie, role, 'searchAssets'),
        subflows: await agentSearch(baseUrl, session.cookie, role, 'searchSubflows'),
      };
    }

    assert.deepEqual(observed, {
      viewer: {
        assets: [AUTHORIZED_ASSET_ID],
        subflows: [AUTHORIZED_SUBFLOW_ID],
      },
      editor: {
        assets: [AUTHORIZED_ASSET_ID],
        subflows: [AUTHORIZED_SUBFLOW_ID],
      },
    }, JSON.stringify({
      observed,
      forbiddenAssets: [SIBLING_ASSET_ID, UNREFERENCED_ASSET_ID],
      forbiddenSubflows: [SIBLING_SUBFLOW_ID, UNREFERENCED_SUBFLOW_ID],
    }));
  });
});

test('CanvasPatch preview and apply cannot expand collaboration asset authority', async () => {
  await withFixture(async ({ baseUrl, gateway, database }) => {
    const editor = await redeem(baseUrl, gateway, 'editor');
    const hiddenBefore = await assetDetail(baseUrl, editor.cookie, SIBLING_ASSET_ID);
    assert.equal(hiddenBefore.status, 404, JSON.stringify(hiddenBefore.payload));
    const before = database.getCanvas(CANVAS_A);

    const previewAttack = resourceExpansionPatch(
      'resource-scope-preview-sibling-asset',
      before.revision,
    );
    const previewResult = await request(
      baseUrl,
      `/api/collab/canvases/${CANVAS_A}/patches/preview`,
      {
        method: 'POST',
        cookie: editor.cookie,
        body: { patch: previewAttack },
      },
    );

    const applyAttack = resourceExpansionPatch(
      'resource-scope-apply-sibling-asset',
      before.revision,
    );
    const localPreview = previewCanvasPatch(before, applyAttack, {
      actorId: editor.session.memberId,
      sessionId: editor.session.id,
      authority: {
        source: 'collaboration',
        role: editor.session.role,
        capabilities: editor.session.capabilities,
      },
    });
    const applyResult = await request(
      baseUrl,
      `/api/collab/canvases/${CANVAS_A}/patches`,
      {
        method: 'POST',
        cookie: editor.cookie,
        body: {
          patch: applyAttack,
          previewDigest: localPreview.previewDigest,
          confirmed: true,
        },
      },
    );
    const hiddenAfter = await assetDetail(baseUrl, editor.cookie, SIBLING_ASSET_ID);
    const after = database.getCanvas(CANVAS_A);

    assert.deepEqual({
      previewDenied: DENIED_MUTATION_STATUSES.has(previewResult.status),
      applyDenied: DENIED_MUTATION_STATUSES.has(applyResult.status),
      resourceStillHidden: hiddenAfter.status === 404,
      revisionUnchanged: after.revision === before.revision,
      referenceNotPersisted: !Object.hasOwn(after.nodes.find((node) => node.id === 'node-a').data, 'sourceAssetId'),
    }, {
      previewDenied: true,
      applyDenied: true,
      resourceStillHidden: true,
      revisionUnchanged: true,
      referenceNotPersisted: true,
    }, JSON.stringify({
      previewStatus: previewResult.status,
      previewPayload: previewResult.payload,
      applyStatus: applyResult.status,
      applyPayload: applyResult.payload,
      resourceStatus: hiddenAfter.status,
      beforeRevision: before.revision,
      afterRevision: after.revision,
    }));
  });
});

test('an asset authorized by current-canvas upload lineage remains referenceable', async () => {
  await withFixture(async ({ baseUrl, gateway, database }) => {
    const editor = await redeem(baseUrl, gateway, 'editor');
    const visibleBefore = await assetDetail(baseUrl, editor.cookie, AUTHORIZED_ASSET_ID);
    assert.equal(visibleBefore.status, 200, JSON.stringify(visibleBefore.payload));
    const before = database.getCanvas(CANVAS_A);

    const mutation = await postOperation(baseUrl, database, editor.cookie, {
      opId: 'resource-scope-reference-authorized-upload',
      type: 'node.patch',
      payload: {
        nodeId: 'node-a',
        dataPatch: { sourceAssetId: AUTHORIZED_ASSET_ID },
      },
    });
    const visibleAfter = await assetDetail(baseUrl, editor.cookie, AUTHORIZED_ASSET_ID);
    const after = database.getCanvas(CANVAS_A);

    assert.equal(mutation.status, 200, JSON.stringify(mutation.payload));
    assert.equal(visibleAfter.status, 200, JSON.stringify(visibleAfter.payload));
    assert.equal(after.revision, before.revision + 1);
    assert.equal(
      after.nodes.find((node) => node.id === 'node-a').data.sourceAssetId,
      AUTHORIZED_ASSET_ID,
    );
  });
});
