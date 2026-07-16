const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const { CollaborationGateway } = require('../backend/src/collaboration/gateway');
const { collectCanvasResourceReferences } = require('../backend/src/services/canvasResourceScope');

const PROJECT_ID = 'project-resource-scope-edge-f1';
const CANVAS_ID = 'canvas-resource-scope-edge-f1';

function textNode(id, text) {
  return {
    id,
    type: 'text',
    position: { x: 0, y: 0 },
    data: { text },
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

function subflowDefinition(id, name, nodes = [textNode(`${id}-text`, name)]) {
  return {
    id,
    version: 1,
    projectId: PROJECT_ID,
    name,
    description: `${name} definition`,
    tags: [],
    nodes,
    edges: [],
    inputs: [],
    outputs: [],
    exposedParameters: [],
    requiredCapabilities: [],
    assetRefs: [],
  };
}

function saveSubflow(database, definition, expectedRevision = 0) {
  return database.saveSubflowDefinition(definition, {
    expectedRevision,
    actorId: 'local-owner',
    sessionId: 'resource-scope-edge-fixture',
    changeSummary: `save ${definition.name}`,
  });
}

function ensureCanvas(database, nodes = []) {
  return database.ensureCanvas(CANVAS_ID, {
    name: 'Resource scope edge cases',
    nodes,
    edges: [],
  }, PROJECT_ID);
}

function addAsset(database, id, filename, createdAt, sourceUrl = null) {
  return database.upsertAsset({
    id,
    projectId: PROJECT_ID,
    kind: 'image',
    mimeType: 'image/png',
    filename,
    createdBy: 'local-owner',
    createdAt,
    updatedAt: createdAt,
    sourceUrl,
  });
}

function createFixture(setupDatabase) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-collab-resource-scope-edge-f1-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });

  const database = new ProjectDatabase(':memory:');
  setupDatabase(database);
  assert.ok(database.getCanvas(CANVAS_ID), 'fixture must create the collaboration canvas');

  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    FRONTEND_DIST: '',
    INPUT_DIR: input,
    OUTPUT_DIR: output,
  }, database);
  return { database, gateway, directory };
}

async function withFixture(setupDatabase, run) {
  const fixture = createFixture(setupDatabase);
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

async function redeemMember(baseUrl, gateway, role = 'viewer') {
  const invite = gateway.auth.createInvite({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    role,
    maxUses: 1,
  });
  const response = await fetch(`${baseUrl}/api/collab/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: invite.code,
      displayName: `Resource scope edge ${role}`,
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  const cookie = String(response.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.includes('='), 'redeemed collaboration session must set a cookie');
  return { cookie, memberId: payload.data.memberId };
}

function redeemViewer(baseUrl, gateway) {
  return redeemMember(baseUrl, gateway, 'viewer');
}

async function postOperation(baseUrl, database, cookie, operation) {
  return request(baseUrl, `/api/collab/canvases/${encodeURIComponent(CANVAS_ID)}/operations`, {
    method: 'POST',
    cookie,
    body: {
      baseRevision: database.getCanvas(CANVAS_ID).revision,
      operations: [operation],
    },
  });
}

function normalizeGrants(database) {
  const grants = database.listCanvasResourceGrants(PROJECT_ID, CANVAS_ID);
  return {
    assets: [...grants.assetIds].sort(),
    subflows: [...grants.subflowReferences.entries()]
      .flatMap(([id, versions]) => [...versions].map((version) => `${id}@${version}`))
      .sort(),
  };
}

test('subflow list returns the exact pinned old version instead of dropping it when a newer version exists', async () => {
  const pinnedId = 'pinned-old-version';
  await withFixture((database) => {
    const versionOne = saveSubflow(
      database,
      subflowDefinition(pinnedId, 'Pinned version one'),
    );
    assert.equal(versionOne.version, 1);
    ensureCanvas(database, [subflowNode('pinned-instance', pinnedId, 1)]);

    const versionTwo = saveSubflow(
      database,
      subflowDefinition(pinnedId, 'Pinned version two'),
      1,
    );
    assert.equal(versionTwo.version, 2);
  }, async ({ baseUrl, gateway }) => {
    const viewer = await redeemViewer(baseUrl, gateway);
    const detail = await request(
      baseUrl,
      `/api/collab/subflows/${encodeURIComponent(pinnedId)}/1`,
      { cookie: viewer.cookie },
    );
    assert.equal(detail.status, 200, JSON.stringify(detail.payload));
    assert.equal(detail.payload.data.version, 1);

    const listed = await request(baseUrl, '/api/collab/subflows', {
      cookie: viewer.cookie,
    });
    assert.equal(listed.status, 200, JSON.stringify(listed.payload));
    assert.deepEqual(
      listed.payload.data.map((definition) => ({
        id: definition.id,
        version: definition.version,
        name: definition.name,
      })),
      [{
        id: pinnedId,
        version: 1,
        name: 'Pinned version one',
      }],
      JSON.stringify(listed.payload),
    );
  });
});

test('a fixed recursive dependency is accessible when the canvas directly references its parent subflow', async () => {
  const parentId = 'recursive-parent-a';
  const childId = 'recursive-child-b';
  await withFixture((database) => {
    const child = saveSubflow(
      database,
      subflowDefinition(childId, 'Recursive child B'),
    );
    assert.equal(child.version, 1);
    const parent = saveSubflow(
      database,
      subflowDefinition(parentId, 'Recursive parent A', [
        subflowNode('parent-to-child', childId, 1),
      ]),
    );
    assert.equal(parent.version, 1);
    ensureCanvas(database, [subflowNode('direct-parent-instance', parentId, 1)]);
  }, async ({ baseUrl, gateway }) => {
    const viewer = await redeemViewer(baseUrl, gateway);
    const parent = await request(
      baseUrl,
      `/api/collab/subflows/${encodeURIComponent(parentId)}/1`,
      { cookie: viewer.cookie },
    );
    assert.equal(parent.status, 200, JSON.stringify(parent.payload));

    const child = await request(
      baseUrl,
      `/api/collab/subflows/${encodeURIComponent(childId)}/1`,
      { cookie: viewer.cookie },
    );
    assert.equal(child.status, 200, JSON.stringify(child.payload));
    assert.deepEqual({
      id: child.payload.data.id,
      version: child.payload.data.version,
      name: child.payload.data.name,
    }, {
      id: childId,
      version: 1,
      name: 'Recursive child B',
    });
  });
});

test('collaboration asset scope is filtered before pagination and reports the scoped total', async () => {
  const scopedOldId = 'asset-scoped-old';
  const unscopedNewId = 'asset-unscoped-new';
  await withFixture((database) => {
    ensureCanvas(database);
    addAsset(database, scopedOldId, 'scoped-old.png', 1_000);
    database.recordAssetLineageEvent({
      assetId: scopedOldId,
      canvasId: CANVAS_ID,
      sourceType: 'collaboration-upload',
      creatorId: 'local-owner',
      createdAt: 1_100,
    });
    database.grantCanvasAssetResource(
      PROJECT_ID,
      CANVAS_ID,
      scopedOldId,
      'lineage',
    );
    addAsset(database, unscopedNewId, 'unscoped-new.png', 2_000);
    assert.deepEqual(
      database.listAssets({ projectId: PROJECT_ID, limit: 2, offset: 0 })
        .map((asset) => asset.id),
      [unscopedNewId, scopedOldId],
      'fixture must put the unscoped asset before the scoped asset in project ordering',
    );
  }, async ({ baseUrl, gateway }) => {
    const viewer = await redeemViewer(baseUrl, gateway);
    const scopedDetail = await request(
      baseUrl,
      `/api/collab/assets/${encodeURIComponent(scopedOldId)}`,
      { cookie: viewer.cookie },
    );
    assert.equal(scopedDetail.status, 200, JSON.stringify(scopedDetail.payload));
    const unscopedDetail = await request(
      baseUrl,
      `/api/collab/assets/${encodeURIComponent(unscopedNewId)}`,
      { cookie: viewer.cookie },
    );
    assert.equal(unscopedDetail.status, 404, JSON.stringify(unscopedDetail.payload));

    const firstPage = await request(
      baseUrl,
      '/api/collab/assets?limit=1&offset=0',
      { cookie: viewer.cookie },
    );
    assert.equal(firstPage.status, 200, JSON.stringify(firstPage.payload));
    assert.deepEqual(
      firstPage.payload.data.map((asset) => asset.id),
      [scopedOldId],
      JSON.stringify(firstPage.payload),
    );
    assert.equal(firstPage.payload.meta.total, 1, JSON.stringify(firstPage.payload));
  });
});

test('URL-only asset references resolve to durable AssetRef grants and cannot be injected by an editor', async () => {
  const assetId = 'asset-url-only-private';
  const sourceUrl = '/files/output/url-only-private.png';
  await withFixture((database) => {
    addAsset(database, assetId, 'url-only-private.png', 1_000, sourceUrl);
    ensureCanvas(database, [textNode('url-target', 'safe')]);
    assert.deepEqual(normalizeGrants(database), { assets: [], subflows: [] });
  }, async ({ baseUrl, database, gateway }) => {
    const editor = await redeemMember(baseUrl, gateway, 'editor');
    const before = database.getCanvas(CANVAS_ID);
    const mutation = await postOperation(baseUrl, database, editor.cookie, {
      opId: 'url-only-asset-injection',
      type: 'node.patch',
      payload: {
        nodeId: 'url-target',
        dataPatch: { imageUrl: sourceUrl },
      },
    });
    const after = database.getCanvas(CANVAS_ID);

    assert.equal(mutation.status, 403, JSON.stringify(mutation.payload));
    assert.equal(after.revision, before.revision);
    assert.equal(after.nodes[0].data.imageUrl, undefined);
    assert.deepEqual(normalizeGrants(database), { assets: [], subflows: [] });
  });

  await withFixture((database) => {
    addAsset(database, assetId, 'url-only-private.png', 1_000, sourceUrl);
    ensureCanvas(database, [{
      ...textNode('url-authorized', 'host-authorized'),
      data: { text: 'host-authorized', imageUrl: sourceUrl },
    }]);
    assert.deepEqual(normalizeGrants(database), {
      assets: [assetId],
      subflows: [],
    });
  }, async ({ baseUrl, gateway }) => {
    const viewer = await redeemViewer(baseUrl, gateway);
    const detail = await request(
      baseUrl,
      `/api/collab/assets/${encodeURIComponent(assetId)}`,
      { cookie: viewer.cookie },
    );
    assert.equal(detail.status, 200, JSON.stringify(detail.payload));
    assert.equal(detail.payload.data.id, assetId);
  });
});

test('same-pin embedded subflow content must match the canonical immutable version', async () => {
  const definitionId = 'canonical-content-a';
  const privateMarker = 'FORGED_SAME_PIN_CONTENT_MARKER';
  await withFixture((database) => {
    saveSubflow(
      database,
      subflowDefinition(definitionId, 'Canonical content A'),
    );
    ensureCanvas(database, [subflowNode('canonical-instance', definitionId, 1)]);
  }, async ({ baseUrl, database, gateway }) => {
    const editor = await redeemMember(baseUrl, gateway, 'editor');
    const canonical = database.getSubflowDefinition(definitionId, 1, PROJECT_ID);
    const forged = {
      ...canonical,
      nodes: [textNode('forged-leaf', privateMarker)],
    };
    const before = database.getCanvas(CANVAS_ID);
    const mutation = await postOperation(baseUrl, database, editor.cookie, {
      opId: 'same-pin-forged-content',
      type: 'node.patch',
      payload: {
        nodeId: 'canonical-instance',
        dataPatch: { definition: forged },
      },
    });
    const after = database.getCanvas(CANVAS_ID);
    const canvas = await request(
      baseUrl,
      `/api/collab/canvases/${encodeURIComponent(CANVAS_ID)}`,
      { cookie: editor.cookie },
    );

    assert.equal(mutation.status, 422, JSON.stringify(mutation.payload));
    assert.equal(mutation.payload.code, 'canvas_resource_subflow_content_mismatch');
    assert.equal(after.revision, before.revision);
    assert.equal(JSON.stringify(canvas.payload).includes(privateMarker), false);
  });
});

test('missing canonical subflow versions quarantine sharing and explicit initialization fails closed', () => {
  const database = new ProjectDatabase(':memory:');
  try {
    ensureCanvas(database, [subflowNode('missing-instance', 'missing-canonical', 1)]);
    const state = database.getCanvasResourceGrantState(PROJECT_ID, CANVAS_ID);
    assert.ok(state);
    assert.equal(state.initializedAt, 0);
    assert.throws(
      () => database.initializeCanvasResourceGrantsForSharing(PROJECT_ID, CANVAS_ID),
      (error) => error?.code === 'canvas_resource_subflow_missing' && error?.status === 422,
    );
  } finally {
    database.close();
  }
});

test('snapshot restore with a trailing operation gap forces snapshot sync instead of claiming a false revision', async () => {
  await withFixture((database) => {
    ensureCanvas(database, [textNode('restore-target', 'v1')]);
    database.applyOperations(CANVAS_ID, [{
      opId: 'restore-gap-v2',
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      actorId: 'local-owner',
      sessionId: 'restore-gap-session',
      baseRevision: 1,
      clientSeq: 1,
      type: 'node.patch',
      payload: {
        nodeId: 'restore-target',
        dataPatch: { text: 'v2' },
      },
      timestamp: Date.now(),
    }], { expectedRevision: 1 });
    database.restoreCanvasSnapshot(CANVAS_ID, 1, {
      expectedRevision: 2,
      actorId: 'local-owner',
      sessionId: 'restore-gap-session',
    });
    assert.equal(database.getCanvas(CANVAS_ID).revision, 3);
    assert.equal(database.getCanvas(CANVAS_ID).nodes[0].data.text, 'v1');
    assert.equal(database.syncCanvas(CANVAS_ID, 1).mode, 'snapshot');
  }, async ({ baseUrl, gateway }) => {
    const viewer = await redeemViewer(baseUrl, gateway);
    const sync = await request(
      baseUrl,
      `/api/collab/canvases/${encodeURIComponent(CANVAS_ID)}/sync?afterRevision=1`,
      { cookie: viewer.cookie },
    );
    assert.equal(sync.status, 200, JSON.stringify(sync.payload));
    assert.equal(sync.payload.data.mode, 'snapshot');
    assert.equal(sync.payload.data.document.revision, 3);
    assert.equal(sync.payload.data.document.nodes[0].data.text, 'v1');
  });
});

test('duplicate CanvasPatch replay cannot return an older snapshot after its resources are no longer granted', async () => {
  const definitionId = 'patch-history-private-flow';
  const privateMarker = 'PATCH_HISTORY_PRIVATE_MARKER';
  await withFixture((database) => {
    saveSubflow(
      database,
      subflowDefinition(
        definitionId,
        'Patch history private flow',
        [textNode('patch-private-leaf', privateMarker)],
      ),
    );
    ensureCanvas(database, [subflowNode('seed-private-instance', definitionId, 1)]);
  }, async ({ baseUrl, database, gateway }) => {
    const editor = await redeemMember(baseUrl, gateway, 'editor');
    const canonical = database.getSubflowDefinition(definitionId, 1, PROJECT_ID);
    const patch = {
      schema: 't8-canvas-patch-v1',
      id: 'patch-history-resource-replay',
      baseRevision: 1,
      summary: 'Add an already authorized subflow instance',
      diagnosticsResolved: ['security.resource-scope'],
      requiresConfirmation: true,
      operations: [{
        type: 'node.add',
        payload: {
          node: subflowNode('patch-private-instance', definitionId, 1, {
            definition: canonical,
          }),
        },
      }],
    };
    const preview = await request(
      baseUrl,
      `/api/collab/canvases/${encodeURIComponent(CANVAS_ID)}/patches/preview`,
      { method: 'POST', cookie: editor.cookie, body: { patch } },
    );
    assert.equal(preview.status, 200, JSON.stringify(preview.payload));
    const applyBody = {
      patch,
      previewDigest: preview.payload.data.previewDigest,
      confirmed: true,
    };
    const applied = await request(
      baseUrl,
      `/api/collab/canvases/${encodeURIComponent(CANVAS_ID)}/patches`,
      { method: 'POST', cookie: editor.cookie, body: applyBody },
    );
    assert.equal(applied.status, 200, JSON.stringify(applied.payload));

    database.applyOperations(CANVAS_ID, [{
      opId: 'remove-seed-private-instance',
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      actorId: 'local-owner',
      sessionId: 'patch-history-host',
      baseRevision: 2,
      clientSeq: 1,
      type: 'node.delete',
      payload: { nodeId: 'seed-private-instance' },
      timestamp: Date.now(),
    }], { expectedRevision: 2 });
    database.applyOperations(CANVAS_ID, [{
      opId: 'remove-patch-private-instance',
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      actorId: 'local-owner',
      sessionId: 'patch-history-host',
      baseRevision: 3,
      clientSeq: 2,
      type: 'node.delete',
      payload: { nodeId: 'patch-private-instance' },
      timestamp: Date.now() + 1,
    }], { expectedRevision: 3 });
    assert.deepEqual(normalizeGrants(database), { assets: [], subflows: [] });

    const duplicate = await request(
      baseUrl,
      `/api/collab/canvases/${encodeURIComponent(CANVAS_ID)}/patches`,
      { method: 'POST', cookie: editor.cookie, body: applyBody },
    );
    const serialized = JSON.stringify(duplicate.payload);
    assert.equal(duplicate.status, 403, serialized);
    assert.equal(serialized.includes(privateMarker), false, serialized);
    assert.equal(serialized.includes(definitionId), false, serialized);
  });
});

test('resource discovery accepts a 20,000-node canvas without treating ordinary graph size as resource overflow', () => {
  const nodes = Array.from({ length: 20_000 }, (_, index) => ({
    id: `large-node-${index}`,
    type: 'text',
    position: { x: index, y: index % 100 },
    data: { text: `node ${index}` },
  }));
  const references = collectCanvasResourceReferences({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    revision: 1,
    nodes,
    edges: [],
  });
  assert.equal(references.truncated, false);
  assert.equal(references.assetIds.size, 0);
  assert.equal(references.assetUrls.size, 0);
  assert.equal(references.subflowReferences.size, 0);
  assert.deepEqual(references.subflowPinMismatches, []);
});

test('resource discovery distinguishes Project AssetRef fields from video timeline internal asset ids', () => {
  const references = collectCanvasResourceReferences({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    revision: 1,
    embeddedDefinition: {
      id: 'resource-scope-definition',
      version: 1,
      nodes: [],
      edges: [],
      assetRefs: ['definition-project-asset'],
    },
    draftDefinition: {
      id: 'resource-scope-draft-definition',
      nodes: [],
      edges: [],
      assetRefs: ['draft-definition-project-asset'],
    },
    nodes: [{
      id: 'video-edit-resource-scope',
      type: 'video-edit',
      position: { x: 0, y: 0 },
      data: {
        sourceAssetId: 'node-project-asset',
        timelineV2: {
          version: 2,
          assets: [{
            id: 'timeline-local-asset',
            kind: 'video',
            url: 'blob:timeline-local',
          }],
          items: [{
            id: 'timeline-item',
            assetId: 'timeline-local-asset',
            trackId: 'track-video-main',
            kind: 'video',
            timelineStart: 0,
            sourceIn: 0,
            sourceOut: 1,
          }],
        },
      },
    }],
    edges: [],
  });

  assert.deepEqual(
    [...references.assetIds].sort(),
    [
      'definition-project-asset',
      'draft-definition-project-asset',
      'node-project-asset',
    ],
  );
  assert.equal(references.assetIds.has('timeline-local-asset'), false);
});
