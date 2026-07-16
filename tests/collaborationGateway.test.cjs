const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { WebSocket } = require('ws');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const { CollaborationGateway } = require('../backend/src/collaboration/gateway');
const {
  publicCanvasDocument,
  publicCanvasSync,
} = require('../backend/src/services/collaborationCanvasPublicView');

test('public collaboration views only preserve Feishu resource tokens for authoritative Feishu nodes', () => {
  const document = {
    nodes: [
      {
        id: 'text-node',
        type: 'text',
        data: {
          feishuRows: [{
            appToken: 'TEXT_NODE_APP_TOKEN_SECRET',
            media: [{ fileToken: 'TEXT_NODE_FILE_TOKEN_SECRET' }],
          }],
          providerParameter: {
            id: 'apiKey',
            value: 'TEXT_NODE_DESCRIPTOR_SECRET',
          },
          nestedFakeFeishu: {
            type: 'feishu-bitable-input',
            feishuRows: [{
              appToken: 'TEXT_NODE_FAKE_TYPE_APP_SECRET',
              media: [{ fileToken: 'TEXT_NODE_FAKE_TYPE_FILE_SECRET' }],
            }],
          },
          authQueryUrl: 'https://example.test/?code=TEXT_QUERY_CODE_SECRET',
          authFragmentUrl: 'https://example.test/#/callback?state=TEXT_HASH_STATE_SECRET',
          nestedAuthUrl: `https://example.test/?next=${encodeURIComponent('https://auth.example/callback?code=TEXT_NESTED_CODE_SECRET')}`,
          encodedAuthPayload: `https://example.test/?payload=${Buffer.from(JSON.stringify({ apiKey: 'TEXT_BASE64_SECRET' })).toString('base64url')}`,
          oauthResponse: { code: 'TEXT_OBJECT_CODE_SECRET', state: 'TEXT_OBJECT_STATE_SECRET' },
          pairs: [['apiKey', 'TEXT_PAIR_SECRET'], ['prompt', 'visible']],
        },
      },
      {
        id: 'feishu-node',
        entityUid: 'feishu-entity',
        type: 'feishu-bitable-input',
        data: {
          feishuRows: [{
            appToken: 'bascnPublicResourceId',
            media: [{ fileToken: 'boxcnPublicFileId' }],
          }],
          feishuBitableRows: [{
            appToken: 'bascnPublicBitableResourceId',
            fields: { 附件: [{ file_token: 'boxcnPublicRawFieldFileId' }] },
            rowData: { 附件: [{ fileToken: 'boxcnPublicRowDataFileId' }] },
            media: [{ fileToken: 'boxcnPublicBitableFileId' }],
            attachments: [{ fileToken: 'boxcnPublicAttachmentFileId' }],
          }],
          feishuRecords: [{
            fields: { 附件: [{ file_token: 'boxcnPublicRecordFileId' }] },
          }],
          feishuWriteResult: [{
            fields: { 附件: [{ file_token: 'boxcnPublicWriteResultFileId' }] },
          }],
          metadata: {
            feishuBitable: {
              appToken: 'bascnPublicMetadataContainerResourceId',
              rows: [{
                appToken: 'bascnPublicMetadataResourceId',
                media: [{ fileToken: 'boxcnPublicMetadataFileId' }],
              }],
            },
            feishuBitableWrite: { appToken: 'bascnPublicWriteResourceId' },
          },
          ignored: { appToken: 'FEISHU_IGNORED_APP_SECRET' },
        },
      },
    ],
    edges: [],
  };
  const publicDocument = publicCanvasDocument(document);
  assert.doesNotMatch(
    JSON.stringify(publicDocument.nodes.find((node) => node.id === 'text-node')),
    /TEXT_NODE_APP_TOKEN_SECRET|TEXT_NODE_FILE_TOKEN_SECRET|TEXT_NODE_DESCRIPTOR_SECRET|TEXT_NODE_FAKE_TYPE_APP_SECRET|TEXT_NODE_FAKE_TYPE_FILE_SECRET|TEXT_QUERY_CODE_SECRET|TEXT_HASH_STATE_SECRET|TEXT_NESTED_CODE_SECRET|TEXT_BASE64_SECRET|TEXT_OBJECT_CODE_SECRET|TEXT_OBJECT_STATE_SECRET|TEXT_PAIR_SECRET/,
  );
  assert.equal(
    publicDocument.nodes.find((node) => node.id === 'text-node').data.providerParameter.value,
    '[redacted]',
  );
  const publicFeishuNode = publicDocument.nodes.find((node) => node.id === 'feishu-node');
  assert.equal(publicFeishuNode.data.feishuRows[0].appToken, 'bascnPublicResourceId');
  assert.equal(publicFeishuNode.data.feishuRows[0].media[0].fileToken, 'boxcnPublicFileId');
  assert.equal(publicFeishuNode.data.feishuBitableRows[0].appToken, 'bascnPublicBitableResourceId');
  assert.equal(publicFeishuNode.data.feishuBitableRows[0].media[0].fileToken, 'boxcnPublicBitableFileId');
  assert.equal(publicFeishuNode.data.feishuBitableRows[0].attachments[0].fileToken, 'boxcnPublicAttachmentFileId');
  assert.equal(publicFeishuNode.data.feishuBitableRows[0].fields.附件[0].file_token, 'boxcnPublicRawFieldFileId');
  assert.equal(publicFeishuNode.data.feishuBitableRows[0].rowData.附件[0].fileToken, 'boxcnPublicRowDataFileId');
  assert.equal(publicFeishuNode.data.feishuRecords[0].fields.附件[0].file_token, 'boxcnPublicRecordFileId');
  assert.equal(publicFeishuNode.data.feishuWriteResult[0].fields.附件[0].file_token, 'boxcnPublicWriteResultFileId');
  assert.equal(publicFeishuNode.data.metadata.feishuBitable.appToken, 'bascnPublicMetadataContainerResourceId');
  assert.equal(publicFeishuNode.data.metadata.feishuBitable.rows[0].appToken, 'bascnPublicMetadataResourceId');
  assert.equal(publicFeishuNode.data.metadata.feishuBitable.rows[0].media[0].fileToken, 'boxcnPublicMetadataFileId');
  assert.equal(publicFeishuNode.data.metadata.feishuBitableWrite.appToken, 'bascnPublicWriteResourceId');
  assert.equal(Object.hasOwn(publicFeishuNode.data.ignored, 'appToken'), false);
  const publicTextNode = publicDocument.nodes.find((node) => node.id === 'text-node');
  assert.equal(publicTextNode.data.authQueryUrl, '[redacted]');
  assert.equal(publicTextNode.data.authFragmentUrl, '[redacted]');
  assert.equal(publicTextNode.data.nestedAuthUrl, '[redacted]');
  assert.equal(publicTextNode.data.encodedAuthPayload, '[redacted]');
  assert.deepEqual(publicTextNode.data.oauthResponse, {});
  assert.deepEqual(publicTextNode.data.pairs[0], ['[redacted-field]', '[redacted]']);
  assert.deepEqual(publicTextNode.data.pairs[1], ['prompt', 'visible']);

  const publicSync = publicCanvasSync({
    operations: [
      {
        type: 'node.patch',
        payload: {
          nodeId: 'text-node',
          dataPatch: {
            feishuRows: [{
              appToken: 'TEXT_SYNC_APP_TOKEN_SECRET',
              media: [{ fileToken: 'TEXT_SYNC_FILE_TOKEN_SECRET' }],
            }],
            providerParameter: {
              id: 'authorization',
              defaultValue: 'TEXT_SYNC_DESCRIPTOR_SECRET',
            },
          },
        },
      },
      {
        type: 'node.patch',
        payload: {
          nodeId: 'feishu-entity',
          dataPatch: {
            feishuRows: [{
              appToken: 'bascnSyncResourceId',
              media: [{ fileToken: 'boxcnSyncFileId' }],
            }],
            feishuBitableRows: [{
              appToken: 'bascnSyncBitableResourceId',
              media: [{ fileToken: 'boxcnSyncBitableFileId' }],
            }],
            metadata: {
              feishuBitable: {
                rows: [{
                  appToken: 'bascnSyncMetadataResourceId',
                  media: [{ fileToken: 'boxcnSyncMetadataFileId' }],
                }],
              },
              feishuBitableWrite: { appToken: 'bascnSyncWriteResourceId' },
            },
          },
        },
      },
      {
        type: 'node.move',
        payload: {
          nodeId: 'feishu-entity',
          position: { x: 10, y: 20 },
          ignoredEnvelope: { appToken: 'SYNC_ENVELOPE_APP_SECRET' },
        },
      },
      {
        type: 'node.add',
        payload: {
          node: {
            id: 'new-feishu',
            type: 'feishu-bitable-output',
            data: {
              feishuOutputAppToken: 'bascnAddedResourceId',
              feishuRows: [{
                appToken: 'bascnAddedResourceId',
                media: [{ fileToken: 'boxcnAddedFileId' }],
              }],
            },
          },
        },
      },
      {
        type: 'node.patch',
        payload: {
          nodeId: 'feishu-node',
          dataUnsetKeys: ['feishuAppToken', 'feishuOutputAppToken'],
        },
      },
    ],
  }, document);
  assert.doesNotMatch(
    JSON.stringify(publicSync.operations[0]),
    /TEXT_SYNC_APP_TOKEN_SECRET|TEXT_SYNC_FILE_TOKEN_SECRET|TEXT_SYNC_DESCRIPTOR_SECRET/,
  );
  assert.equal(
    publicSync.operations[0].payload.dataPatch.providerParameter.defaultValue,
    '[redacted]',
  );
  assert.equal(
    publicSync.operations[1].payload.dataPatch.feishuRows[0].appToken,
    'bascnSyncResourceId',
  );
  assert.equal(
    publicSync.operations[1].payload.dataPatch.feishuRows[0].media[0].fileToken,
    'boxcnSyncFileId',
  );
  assert.equal(
    publicSync.operations[1].payload.dataPatch.feishuBitableRows[0].media[0].fileToken,
    'boxcnSyncBitableFileId',
  );
  assert.equal(
    publicSync.operations[1].payload.dataPatch.metadata.feishuBitable.rows[0].appToken,
    'bascnSyncMetadataResourceId',
  );
  assert.equal(
    publicSync.operations[1].payload.dataPatch.metadata.feishuBitableWrite.appToken,
    'bascnSyncWriteResourceId',
  );
  assert.equal(Object.hasOwn(publicSync.operations[2].payload, 'ignoredEnvelope'), false);
  assert.doesNotMatch(JSON.stringify(publicSync.operations[2]), /SYNC_ENVELOPE_APP_SECRET/);
  assert.equal(
    publicSync.operations[3].payload.node.data.feishuOutputAppToken,
    'bascnAddedResourceId',
  );
  assert.equal(
    publicSync.operations[3].payload.node.data.feishuRows[0].media[0].fileToken,
    'boxcnAddedFileId',
  );
  assert.deepEqual(
    publicSync.operations[4].payload.dataUnsetKeys,
    ['feishuAppToken', 'feishuOutputAppToken'],
  );
  const publicSnapshot = publicCanvasSync({ mode: 'snapshot', document });
  assert.equal(
    publicSnapshot.document.nodes.find((node) => node.id === 'feishu-node').data.feishuRows[0].appToken,
    'bascnPublicResourceId',
  );
  assert.doesNotMatch(
    JSON.stringify(publicSnapshot),
    /TEXT_NODE_FAKE_TYPE_APP_SECRET|FEISHU_IGNORED_APP_SECRET|TEXT_QUERY_CODE_SECRET/,
  );
});

function createGatewayFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-collab-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const database = new ProjectDatabase(':memory:');
  database.ensureCanvas('canvas-a', {
    projectId: 'project-local',
    name: '协作测试画布',
    nodes: [
      {
        id: 'node-a', type: 'text', position: { x: 0, y: 0 },
        data: {
          text: 'hello',
          parameter: { key: 'prompt', value: 'visible parameter value' },
          tabs: [{ key: 'timeline', label: '时间线' }],
        },
      },
      {
        id: 'secret-node', type: 'text', position: { x: 160, y: 0 },
        data: {
          key: 'opaque-bare-key',
          configuredParameter: { key: 'apiKey', value: 'collabCurrentDescriptorSecret159' },
          access_token: 'collabCurrentDocumentSecret987',
          comfyMakerWorkflowRaw: '{"1":{"inputs":{"key":"collabRawWorkflowSecret246"}}}',
        },
      },
      {
        id: 'run-image-node', type: 'image', position: { x: 320, y: 0 },
        data: { model: 'gpt-image-2', apiModel: 'gpt-image-2-all' },
      },
      {
        id: 'feishu-node', type: 'feishu-bitable-input', position: { x: 640, y: 0 },
        data: {
          feishuAppToken: 'bascnVisibleResourceId',
          feishuTableId: 'tblVisibleResourceId',
          feishuRows: [{
            appToken: 'bascnVisibleResourceId',
            tableId: 'tblVisibleResourceId',
            media: [{ fileToken: 'boxcnVisibleFileId', name: 'visible.png' }],
          }],
        },
      },
      {
        id: 'grok-oauth-node', type: 'grok-oauth-agent', position: { x: 960, y: 0 },
        data: {
          oauthLoginUrl: 'https://accounts.x.ai/device?device_code=oauthDeviceSecret123&user_code=oauthUserSecret456&state=oauthStateSecret789',
          oauthLoginSessionId: 'oauthDeviceSecret123',
          progressMessage: '等待授权',
        },
      },
      {
        id: 'shared-subflow-node', type: 'subflow', position: { x: 1280, y: 0 },
        data: { definitionId: 'shared-subflow', definitionVersion: 1 },
      },
    ],
    edges: [{
      id: 'secret-edge',
      source: 'node-a',
      target: 'run-image-node',
      data: { access_token: 'collabEdgeSecret864' },
    }],
  });
  database.saveSubflowDefinition({
    id: 'shared-subflow',
    version: 1,
    projectId: 'project-local',
    name: '共享子工作流',
    description: '初始定义',
    tags: [],
    nodes: [{ id: 'subflow-node', type: 'text', position: { x: 0, y: 0 }, data: { text: 'initial' } }],
    edges: [],
    inputs: [],
    outputs: [],
    exposedParameters: [],
    requiredCapabilities: [],
    assetRefs: [],
  }, {
    expectedRevision: 0,
    actorId: 'local-owner',
    sessionId: 'fixture',
    changeSummary: '创建共享子工作流',
  });
  database.initializeCanvasResourceGrantsForSharing('project-local', 'canvas-a', {
    actorId: 'local-owner',
    sessionId: 'fixture',
  });
  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    FRONTEND_DIST: '',
    INPUT_DIR: input,
    OUTPUT_DIR: output,
  }, database);
  return { database, gateway, directory, input, output };
}

async function redeem(baseUrl, gateway, role, displayName = role) {
  const invite = gateway.auth.createInvite({
    projectId: 'project-local',
    canvasId: 'canvas-a',
    role,
    maxUses: 1,
  });
  const response = await fetch(`${baseUrl}/api/collab/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, displayName }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return { cookie, payload: payload.data };
}

function setAssetPolicy(database, assetId, scope, grants, expectedRevision) {
  assert.equal(typeof database.setAssetAccessPolicy, 'function');
  return database.setAssetAccessPolicy('project-local', assetId, {
    scope,
    grants,
    ...(expectedRevision == null ? {} : { expectedRevision }),
  }, { actorId: 'local-owner' });
}

function scopeAssetToCanvas(database, assetId, canvasId = 'canvas-a') {
  return database.recordAssetLineageEvent({
    assetId,
    canvasId,
    sourceType: 'test-fixture',
    creatorId: 'local-owner',
  });
}

async function openJoinedSocket(status, cookie) {
  const socket = new WebSocket(`ws://127.0.0.1:${status.port}/ws/collab`, {
    origin: `http://127.0.0.1:${status.port}`,
    headers: { cookie },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('asset ACL websocket did not join')), 3000);
    socket.once('error', reject);
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'session.ready') socket.send(JSON.stringify({ type: 'canvas.join', canvasId: 'canvas-a' }));
      if (message.type !== 'canvas.joined') return;
      clearTimeout(timer);
      resolve();
    });
  });
  return socket;
}

function waitForSocketMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} broadcast timed out`)), 3000);
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

async function withGateway(run) {
  const fixture = createGatewayFixture();
  try {
    const status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}`;
    await run({ ...fixture, baseUrl, status });
  } finally {
    await fixture.gateway.stop();
    fixture.database.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
}

test('collaboration gateway exposes only its explicit unauthenticated allowlist', async () => {
  await withGateway(async ({ baseUrl }) => {
    const status = await fetch(`${baseUrl}/api/collab/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).data.privateBackendExposed, false);

    const canvases = await fetch(`${baseUrl}/api/collab/canvases`);
    assert.equal(canvases.status, 401);

    const privateSettings = await fetch(`${baseUrl}/api/settings/raw`);
    assert.equal(privateSettings.status, 404);
    assert.match((await privateSettings.json()).error, /未开放/);
  });
});

test('collaboration Agent tools require a session, force scope, honor asset ACL, and remain read-only', async () => {
  await withGateway(async ({ baseUrl, gateway, database }) => {
    const endpoint = `${baseUrl}/api/collab/canvases/canvas-a/agent/tools`;
    const post = async (cookie, body) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });
      return { response, payload: await response.json() };
    };
    const request = (tool, input = {}, requestId = tool) => ({
      tool,
      requestId: `collab-agent-${requestId}`,
      projectId: 'forged-project',
      canvasId: 'forged-canvas',
      input,
    });

    const unauthenticated = await post('', request('inspectCanvas'));
    assert.equal(unauthenticated.response.status, 401);

    database.upsertAsset({ id: 'agent-project-asset', projectId: 'project-local', kind: 'image', filename: 'project.png', createdBy: 'local-owner' });
    database.upsertAsset({ id: 'agent-reviewer-asset', projectId: 'project-local', kind: 'image', filename: 'reviewer.png', createdBy: 'local-owner' });
    scopeAssetToCanvas(database, 'agent-project-asset');
    scopeAssetToCanvas(database, 'agent-reviewer-asset');
    const viewer = await redeem(baseUrl, gateway, 'viewer', 'Agent 查看者');
    const reviewer = await redeem(baseUrl, gateway, 'reviewer', 'Agent 审片者');
    setAssetPolicy(database, 'agent-reviewer-asset', 'restricted', [{
      principalType: 'role', principalId: 'reviewer', permissions: ['view'],
    }]);

    const before = database.getCanvas('canvas-a');
    const inspection = await post(viewer.cookie, request('inspectCanvas', { nodeLimit: 100, edgeLimit: 200 }, 'inspect'));
    assert.equal(inspection.response.status, 200, JSON.stringify(inspection.payload));
    assert.equal(inspection.payload.data.projectId, 'project-local');
    assert.equal(inspection.payload.data.canvasId, 'canvas-a');
    assert.equal(inspection.payload.data.actorId, viewer.payload.memberId);
    assert.equal(inspection.payload.data.role, 'viewer');
    assert.equal(inspection.payload.data.readOnly, true);
    assert.doesNotMatch(JSON.stringify(inspection.payload), /collabCurrentDocumentSecret987|forged-project|forged-canvas|hello/);

    const viewerAssets = await post(viewer.cookie, request('searchAssets', { query: '', kind: 'image', limit: 20, offset: 0 }, 'viewer-assets'));
    assert.equal(viewerAssets.response.status, 200, JSON.stringify(viewerAssets.payload));
    assert.deepEqual(viewerAssets.payload.data.data.items.map((item) => item.id).sort(), ['agent-project-asset']);
    const reviewerAssets = await post(reviewer.cookie, request('searchAssets', { query: '', kind: 'image', limit: 20, offset: 0 }, 'reviewer-assets'));
    assert.equal(reviewerAssets.response.status, 200, JSON.stringify(reviewerAssets.payload));
    assert.deepEqual(reviewerAssets.payload.data.data.items.map((item) => item.id).sort(), ['agent-project-asset', 'agent-reviewer-asset']);

    const forbidden = await post(viewer.cookie, request('shell', {}, 'forbidden'));
    assert.equal(forbidden.response.status, 403);
    assert.equal(forbidden.payload.code, 'agent_tool_forbidden');

    const oversized = await post(viewer.cookie, request('searchAssets', { query: 'x'.repeat(70 * 1024) }, 'oversized'));
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.payload.code, 'agent_request_too_large');
    const after = database.getCanvas('canvas-a');
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.nodes, before.nodes);
    assert.deepEqual(after.edges, before.edges);
  });
});

test('corrupt collaboration models stay indexed but never enter the preview queue', async () => {
  await withGateway(async ({ baseUrl, gateway, database }) => {
    let enqueueCalls = 0;
    gateway.previewPipeline = { enqueueAsset() { enqueueCalls += 1; throw new Error('corrupt asset must not enqueue'); } };
    const editor = await redeem(baseUrl, gateway, 'editor', '上传者');
    const form = new FormData();
    form.append('file', new Blob(['#'.repeat(1_048_577)], { type: 'model/obj' }), 'oversized-line.obj');
    const response = await fetch(`${baseUrl}/api/collab/assets/upload`, {
      method: 'POST', headers: { cookie: editor.cookie }, body: form,
    });
    const payload = await response.json();
    assert.equal(response.status, 201, JSON.stringify(payload));
    assert.equal(payload.data.availability, 'corrupt');
    assert.equal(payload.data.metadata.health, 'corrupt');
    assert.equal(payload.data.metadata.previewStatus, 'failed');
    assert.equal(enqueueCalls, 0);
    assert.equal(database.listAssetPreviewJobs({ assetId: payload.data.id }).length, 0);
  });
});

test('collaboration media filesystem races return pathless 404 responses without stream errors', async () => {
  await withGateway(async ({ baseUrl, gateway, database, output, directory }) => {
    const mediaPath = path.join(output, 'race.bin');
    fs.writeFileSync(mediaPath, 'race payload');
    database.upsertAsset({
      id: 'asset-media-race', projectId: 'project-local', kind: 'video', mimeType: 'video/mp4',
      filename: 'race.mp4', managedPath: mediaPath, sourceUrl: '/files/output/race.bin', createdBy: 'local-owner',
    });
    const viewer = await redeem(baseUrl, gateway, 'viewer', '读取者');
    const mediaUrl = `${baseUrl}/api/collab/assets/asset-media-race/media`;

    const originalRealpath = fs.realpathSync;
    fs.realpathSync = (value, ...args) => {
      if (path.resolve(String(value)) === path.resolve(mediaPath)) throw new Error(`ENOENT: ${mediaPath}`);
      return originalRealpath(value, ...args);
    };
    try {
      const response = await fetch(mediaUrl, { headers: { cookie: viewer.cookie } });
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    } finally {
      fs.realpathSync = originalRealpath;
    }

    const originalCreateReadStream = fs.createReadStream;
    fs.createReadStream = (value, options) => {
      if (path.resolve(String(value)) !== path.resolve(mediaPath)) return originalCreateReadStream(value, options);
      const stream = new PassThrough();
      setImmediate(() => stream.emit('error', new Error(`EACCES: ${mediaPath}`)));
      return stream;
    };
    try {
      const response = await fetch(mediaUrl, { headers: { cookie: viewer.cookie } });
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    } finally {
      fs.createReadStream = originalCreateReadStream;
    }
  });
});

test('review roles, run intent idempotency and asset range stay capability scoped', async () => {
  await withGateway(async ({ baseUrl, gateway, database, output }) => {
    const mediaPath = path.join(output, 'sample.bin');
    fs.writeFileSync(mediaPath, Buffer.from('0123456789'));
    database.upsertAsset({
      id: 'asset-range',
      kind: 'video',
      mimeType: 'video/mp4',
      filename: 'sample.mp4',
      managedPath: mediaPath,
      sourceUrl: '/files/output/sample.bin',
      createdBy: 'local-owner',
    });
    scopeAssetToCanvas(database, 'asset-range');
    const editor = await redeem(baseUrl, gateway, 'editor', '编辑者');
    const reviewer = await redeem(baseUrl, gateway, 'reviewer', '审片者');

    const createReview = await fetch(`${baseUrl}/api/collab/reviews`, {
      method: 'POST',
      headers: { cookie: reviewer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ canvasId: 'canvas-a', anchor: { kind: 'node', nodeId: 'node-a' }, body: '这里需要修改' }),
    });
    assert.equal(createReview.status, 201);
    const thread = (await createReview.json()).data;

    const editorApprove = await fetch(`${baseUrl}/api/collab/reviews/${thread.id}`, {
      method: 'PATCH',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    assert.equal(editorApprove.status, 403);

    const reviewerApprove = await fetch(`${baseUrl}/api/collab/reviews/${thread.id}`, {
      method: 'PATCH',
      headers: { cookie: reviewer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    assert.equal(reviewerApprove.status, 200);

    const document = (await (await fetch(`${baseUrl}/api/collab/canvases/canvas-a`, { headers: { cookie: editor.cookie } })).json()).data;
    const intentPayload = { canvasId: 'canvas-a', canvasRevision: document.revision, nodeIds: ['run-image-node'], idempotencyKey: 'intent-test-0001' };
    const firstIntent = await fetch(`${baseUrl}/api/collab/run-intents`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' }, body: JSON.stringify(intentPayload),
    });
    const secondIntent = await fetch(`${baseUrl}/api/collab/run-intents`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' }, body: JSON.stringify(intentPayload),
    });
    assert.equal(firstIntent.status, 202);
    assert.equal(secondIntent.status, 202);
    assert.equal((await firstIntent.json()).data.id, (await secondIntent.json()).data.id);

    const metadata = await fetch(`${baseUrl}/api/collab/assets/asset-range`, { headers: { cookie: reviewer.cookie } });
    const asset = (await metadata.json()).data;
    assert.equal(metadata.status, 200);
    assert.equal(Object.hasOwn(asset, 'managedPath'), false);

    const range = await fetch(`${baseUrl}/api/collab/assets/asset-range/media`, {
      headers: { cookie: reviewer.cookie, range: 'bytes=2-5' },
    });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), '2345');
    const unsatisfiable = await fetch(`${baseUrl}/api/collab/assets/asset-range/media`, {
      headers: { cookie: reviewer.cookie, range: 'bytes=999-' },
    });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */10');
  });
});

test('asset ACL filters list, detail, media and host broadcasts by current member and role grants', async () => {
  await withGateway(async ({ baseUrl, gateway, database, output, status }) => {
    const sharedPath = path.join(output, 'shared-blob.bin');
    fs.writeFileSync(sharedPath, Buffer.from('0123456789'));
    const createAsset = (id, metadata = {}) => {
      const asset = database.upsertAsset({
        id,
        projectId: 'project-local',
        contentHash: 'a'.repeat(64),
        kind: 'video',
        mimeType: 'video/mp4',
        filename: `${id}.mp4`,
        managedPath: sharedPath,
        sourceUrl: `/files/output/${id}.mp4`,
        storageMode: 'managed',
        availability: 'available',
        metadata: { size: 10, ...metadata },
        createdBy: 'local-owner',
      });
      scopeAssetToCanvas(database, id);
      return asset;
    };
    createAsset('asset-project');
    createAsset('asset-member', {
      apiKey: 'must-not-leak-api-key',
      nested: { Authorization: 'Bearer must-not-leak-authorization', cookie: 'must-not-leak-cookie', safe: 'visible' },
      previewUrl: 'https://cdn.example.test/preview.mp4?signature=must-not-leak-signature&safe=1',
    });
    createAsset('asset-role');
    createAsset('asset-shared-a');
    createAsset('asset-shared-b');
    createAsset('asset-editor-view');
    createAsset('asset-viewer-original');

    const editor = await redeem(baseUrl, gateway, 'editor', 'ACL 编辑者');
    const reviewer = await redeem(baseUrl, gateway, 'reviewer', 'ACL 审片者');
    const viewerA = await redeem(baseUrl, gateway, 'viewer', '成员 A');
    const viewerB = await redeem(baseUrl, gateway, 'viewer', '成员 B');

    const memberPolicy = setAssetPolicy(database, 'asset-member', 'restricted', [{
      principalType: 'member', principalId: viewerA.payload.memberId, permissions: ['view'],
    }]);
    setAssetPolicy(database, 'asset-role', 'restricted', [{
      principalType: 'role', principalId: 'reviewer', permissions: ['view', 'original'],
    }]);
    const sharedAPolicy = setAssetPolicy(database, 'asset-shared-a', 'restricted', [{
      principalType: 'member', principalId: viewerA.payload.memberId, permissions: ['view', 'preview'],
    }]);
    setAssetPolicy(database, 'asset-shared-b', 'restricted', [{
      principalType: 'member', principalId: viewerB.payload.memberId, permissions: ['view'],
    }]);
    setAssetPolicy(database, 'asset-editor-view', 'restricted', [{
      principalType: 'member', principalId: editor.payload.memberId, permissions: ['view', 'preview'],
    }]);
    setAssetPolicy(database, 'asset-viewer-original', 'restricted', [{
      principalType: 'member', principalId: viewerB.payload.memberId, permissions: ['original'],
    }]);

    const allListResponse = await fetch(`${baseUrl}/api/collab/assets?limit=100`, { headers: { cookie: viewerA.cookie } });
    const allListPayload = await allListResponse.json();
    assert.equal(allListResponse.status, 200, JSON.stringify(allListPayload));
    assert.deepEqual(allListPayload.data.map((asset) => asset.id).sort(), ['asset-member', 'asset-project', 'asset-shared-a']);
    assert.equal(allListPayload.meta.total, 3);
    const listResponse = await fetch(`${baseUrl}/api/collab/assets?limit=1&offset=1`, { headers: { cookie: viewerA.cookie } });
    const listPayload = await listResponse.json();
    assert.equal(listResponse.status, 200, JSON.stringify(listPayload));
    assert.equal(listPayload.data.length, 1);
    assert.equal(listPayload.meta.total, 3);

    const memberDetail = await fetch(`${baseUrl}/api/collab/assets/asset-member`, { headers: { cookie: viewerA.cookie } });
    const memberPayload = await memberDetail.json();
    assert.equal(memberDetail.status, 200, JSON.stringify(memberPayload));
    assert.equal(memberPayload.data.metadata.nested.safe, 'visible');
    assert.equal(Object.hasOwn(memberPayload.data.metadata, 'apiKey'), false);
    assert.equal(Object.hasOwn(memberPayload.data.metadata.nested, 'Authorization'), false);
    assert.equal(Object.hasOwn(memberPayload.data.metadata.nested, 'cookie'), false);
    assert.doesNotMatch(JSON.stringify(memberPayload), /must-not-leak/);
    assert.equal(Object.hasOwn(memberPayload.data.metadata, 'previewUrl'), false);
    assert.equal(Object.hasOwn(memberPayload.data.representations, 'preview'), false);
    assert.equal(memberPayload.data.sourceUrl, null);

    const deniedMemberDetail = await fetch(`${baseUrl}/api/collab/assets/asset-member`, { headers: { cookie: viewerB.cookie } });
    assert.equal(deniedMemberDetail.status, 404);
    const roleDetail = await fetch(`${baseUrl}/api/collab/assets/asset-role`, { headers: { cookie: reviewer.cookie } });
    assert.equal(roleDetail.status, 200);
    const deniedRoleDetail = await fetch(`${baseUrl}/api/collab/assets/asset-role`, { headers: { cookie: viewerA.cookie } });
    assert.equal(deniedRoleDetail.status, 404);
    const viewOnlyMediaDenied = await fetch(`${baseUrl}/api/collab/assets/asset-member/media`, { headers: { cookie: viewerA.cookie } });
    assert.equal(viewOnlyMediaDenied.status, 404);

    const sharedMediaUrl = `${baseUrl}/api/collab/assets/asset-shared-a/media`;
    const inline = await fetch(`${sharedMediaUrl}?download=0`, { headers: { cookie: viewerA.cookie } });
    assert.equal(inline.status, 404, 'preview permission must not fall back to original bytes when no safe proxy exists');
    const range = await fetch(sharedMediaUrl, { headers: { cookie: viewerA.cookie, range: 'bytes=2-5' } });
    assert.equal(range.status, 404);
    const head = await fetch(sharedMediaUrl, { method: 'HEAD', headers: { cookie: viewerA.cookie, range: 'bytes=1-3' } });
    assert.equal(head.status, 404);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const sameBlobDenied = await fetch(`${baseUrl}/api/collab/assets/asset-shared-b/media`, { headers: { cookie: viewerA.cookie } });
    assert.equal(sameBlobDenied.status, 404);

    const editorInline = await fetch(`${baseUrl}/api/collab/assets/asset-editor-view/media`, { headers: { cookie: editor.cookie } });
    assert.equal(editorInline.status, 404);
    const editorOriginalDenied = await fetch(`${baseUrl}/api/collab/assets/asset-editor-view/media?download=1`, { headers: { cookie: editor.cookie } });
    assert.equal(editorOriginalDenied.status, 404);
    const viewerCapabilityDenied = await fetch(`${baseUrl}/api/collab/assets/asset-viewer-original/media?download=1`, { headers: { cookie: viewerB.cookie } });
    assert.equal(viewerCapabilityDenied.status, 403);
    const reviewerDownload = await fetch(`${baseUrl}/api/collab/assets/asset-role/media?download=1`, { headers: { cookie: reviewer.cookie } });
    assert.equal(reviewerDownload.status, 200);
    assert.match(reviewerDownload.headers.get('content-disposition'), /^attachment;/);
    assert.equal(await reviewerDownload.text(), '0123456789');

    const reviewerSocket = await openJoinedSocket(status, reviewer.cookie);
    try {
      const roleRun = { id: 'role-run', projectId: 'project-local', canvasId: 'canvas-a' };
      const roleNodeRun = { id: 'role-node-run', nodeId: 'role-node', outputRefs: ['asset-role'] };
      const beforeRoleChange = waitForSocketMessage(reviewerSocket, 'run.output');
      gateway.broadcastHostRunOutput(roleRun, roleNodeRun, [database.getAsset('asset-role')]);
      assert.deepEqual((await beforeRoleChange).assets, [], 'original permission must not be promoted to preview permission in broadcasts');
      gateway.auth.updateMember(reviewer.payload.memberId, { role: 'viewer' }, { actorId: 'local-owner', sessionId: 'fixture' });
      const roleDowngradedDetail = await fetch(`${baseUrl}/api/collab/assets/asset-role`, { headers: { cookie: reviewer.cookie } });
      assert.equal(roleDowngradedDetail.status, 404);
      const afterRoleChange = waitForSocketMessage(reviewerSocket, 'run.output');
      gateway.broadcastHostRunOutput(roleRun, roleNodeRun, [database.getAsset('asset-role')]);
      assert.deepEqual((await afterRoleChange).assets, []);
    } finally {
      reviewerSocket.close();
    }

    setAssetPolicy(database, 'asset-member', 'restricted', [], memberPolicy.revision);
    const revokedDetail = await fetch(`${baseUrl}/api/collab/assets/asset-member`, { headers: { cookie: viewerA.cookie } });
    assert.equal(revokedDetail.status, 404);
    const afterRevokeList = await fetch(`${baseUrl}/api/collab/assets`, { headers: { cookie: viewerA.cookie } });
    assert.equal((await afterRevokeList.json()).meta.total, 2);

    const socketA = await openJoinedSocket(status, viewerA.cookie);
    const socketB = await openJoinedSocket(status, viewerB.cookie);
    try {
      const run = { id: 'acl-run', projectId: 'project-local', canvasId: 'canvas-a' };
      const nodeRun = {
        id: 'acl-node-run', nodeId: 'video-node', status: 'succeeded',
        outputRefs: ['asset-shared-a', 'asset-shared-b'], updatedAt: Date.now(),
      };
      const assets = [database.getAsset('asset-shared-a'), database.getAsset('asset-shared-b')];

      const outputA = waitForSocketMessage(socketA, 'run.output');
      const outputB = waitForSocketMessage(socketB, 'run.output');
      gateway.broadcastHostRunOutput(run, nodeRun, assets);
      assert.deepEqual((await outputA).assets.map((asset) => asset.id), ['asset-shared-a']);
      assert.deepEqual((await outputB).assets, []);

      const nodeA = waitForSocketMessage(socketA, 'run.node-state');
      const nodeB = waitForSocketMessage(socketB, 'run.node-state');
      gateway.broadcastHostNodeRunState(run, nodeRun);
      assert.deepEqual((await nodeA).node.outputRefs, ['asset-shared-a']);
      assert.deepEqual((await nodeB).node.outputRefs, ['asset-shared-b']);

      setAssetPolicy(database, 'asset-shared-a', 'restricted', [], sharedAPolicy.revision);
      const revokedOutputA = waitForSocketMessage(socketA, 'run.output');
      const unchangedOutputB = waitForSocketMessage(socketB, 'run.output');
      gateway.broadcastHostRunOutput(run, nodeRun, assets);
      assert.deepEqual((await revokedOutputA).assets, []);
      assert.deepEqual((await unchangedOutputB).assets, []);
    } finally {
      socketA.close();
      socketB.close();
    }
  });
});

test('canvas document and sync responses keep graph data usable without exposing host secrets', async () => {
  await withGateway(async ({ baseUrl, gateway, database }) => {
    const viewer = await redeem(baseUrl, gateway, 'viewer', '安全查看者');
    const headers = { cookie: viewer.cookie };
    database.ensureCanvas('canvas-list-secret', {
      projectId: 'project-local',
      name: 'C:\\Users\\host-owner\\private-canvas.json https://example.test/?state=CANVAS_LIST_STATE_SECRET',
      nodes: [],
      edges: [],
    });
    const listResponse = await fetch(`${baseUrl}/api/collab/canvases`, { headers });
    const listPayload = await listResponse.json();
    assert.equal(listResponse.status, 200, JSON.stringify(listPayload));
    assert.deepEqual(listPayload.data.map((canvas) => canvas.id), ['canvas-a']);
    assert.doesNotMatch(
      JSON.stringify(listPayload),
      /host-owner|private-canvas|CANVAS_LIST_STATE_SECRET/,
    );

    const documentResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-a`, { headers });
    const documentPayload = await documentResponse.json();
    assert.equal(documentResponse.status, 200, JSON.stringify(documentPayload));
    assert.equal(documentPayload.data.nodes[0].data.text, 'hello');
    assert.equal(Object.hasOwn(documentPayload.data.nodes[0].data, 'key'), false);
    assert.deepEqual(documentPayload.data.nodes[0].data.parameter, {
      key: 'prompt',
      value: 'visible parameter value',
    });
    assert.deepEqual(documentPayload.data.nodes[0].data.tabs, [{
      key: 'timeline',
      label: '时间线',
    }]);
    const secretDocumentNode = documentPayload.data.nodes.find((node) => node.id === 'secret-node');
    assert.deepEqual(secretDocumentNode.data.configuredParameter, {
      value: '[redacted]',
    });
    assert.equal(secretDocumentNode.data.comfyMakerWorkflowRaw, '[redacted]');
    assert.equal(Object.hasOwn(secretDocumentNode.data, 'key'), false);
    const feishuDocumentNode = documentPayload.data.nodes.find((node) => node.id === 'feishu-node');
    assert.equal(feishuDocumentNode.data.feishuAppToken, 'bascnVisibleResourceId');
    assert.equal(feishuDocumentNode.data.feishuRows[0].appToken, 'bascnVisibleResourceId');
    assert.equal(feishuDocumentNode.data.feishuRows[0].media[0].fileToken, 'boxcnVisibleFileId');
    const oauthDocumentNode = documentPayload.data.nodes.find((node) => node.id === 'grok-oauth-node');
    assert.equal(Object.hasOwn(oauthDocumentNode.data, 'oauthLoginUrl'), false);
    assert.equal(Object.hasOwn(oauthDocumentNode.data, 'oauthLoginSessionId'), false);
    assert.equal(oauthDocumentNode.data.progressMessage, '等待授权');
    assert.equal(Object.hasOwn(secretDocumentNode.data, 'access_token'), false);
    assert.equal(Object.hasOwn(documentPayload.data.edges[0].data, 'access_token'), false);
    assert.doesNotMatch(
      JSON.stringify(documentPayload),
      /collabCurrentDocumentSecret987|collabCurrentDescriptorSecret159|collabRawWorkflowSecret246|collabEdgeSecret864|opaque-bare-key|oauthDeviceSecret123|oauthUserSecret456|oauthStateSecret789/i,
    );

    const snapshotResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/sync`, { headers });
    const snapshotPayload = await snapshotResponse.json();
    assert.equal(snapshotResponse.status, 200, JSON.stringify(snapshotPayload));
    assert.equal(snapshotPayload.data.mode, 'snapshot');
    assert.equal(snapshotPayload.data.document.nodes[0].data.text, 'hello');
    assert.equal(Object.hasOwn(snapshotPayload.data.document.nodes[0].data, 'key'), false);
    assert.equal(snapshotPayload.data.document.nodes[0].data.parameter.key, 'prompt');
    assert.equal(snapshotPayload.data.document.nodes[0].data.parameter.value, 'visible parameter value');
    const secretSnapshotNode = snapshotPayload.data.document.nodes.find((node) => node.id === 'secret-node');
    assert.equal(secretSnapshotNode.data.configuredParameter.value, '[redacted]');
    assert.equal(Object.hasOwn(secretSnapshotNode.data.configuredParameter, 'key'), false);
    assert.equal(secretSnapshotNode.data.comfyMakerWorkflowRaw, '[redacted]');
    assert.equal(Object.hasOwn(secretSnapshotNode.data, 'key'), false);
    const feishuSnapshotNode = snapshotPayload.data.document.nodes.find((node) => node.id === 'feishu-node');
    assert.equal(feishuSnapshotNode.data.feishuAppToken, 'bascnVisibleResourceId');
    assert.equal(feishuSnapshotNode.data.feishuRows[0].media[0].fileToken, 'boxcnVisibleFileId');
    const oauthSnapshotNode = snapshotPayload.data.document.nodes.find((node) => node.id === 'grok-oauth-node');
    assert.equal(Object.hasOwn(oauthSnapshotNode.data, 'oauthLoginUrl'), false);
    assert.equal(Object.hasOwn(oauthSnapshotNode.data, 'oauthLoginSessionId'), false);
    assert.equal(Object.hasOwn(secretSnapshotNode.data, 'access_token'), false);
    assert.equal(Object.hasOwn(snapshotPayload.data.document.edges[0].data, 'access_token'), false);
    assert.doesNotMatch(
      JSON.stringify(snapshotPayload),
      /collabCurrentDocumentSecret987|collabCurrentDescriptorSecret159|collabRawWorkflowSecret246|collabEdgeSecret864|opaque-bare-key|oauthDeviceSecret123|oauthUserSecret456|oauthStateSecret789/i,
    );

    database.applyOperations('canvas-a', [{
      opId: 'historical-secret-operation',
      projectId: 'project-local',
      canvasId: 'canvas-a',
      actorId: 'local-owner',
      sessionId: 'local-owner-secret-session',
      baseRevision: 1,
      type: 'node.patch',
      payload: {
        nodeId: 'feishu-node',
        dataPatch: {
          prompt: 'visible prompt',
          key: 'visible-history-key',
          parameter: { key: 'prompt', value: 'visible history value' },
          configuredParameter: { key: 'apiKey', value: 'collabHistoryDescriptorSecret753' },
          feishuAppToken: 'bascnHistoryResourceId',
          feishuRows: [{
            appToken: 'bascnHistoryResourceId',
            media: [{ fileToken: 'boxcnHistoryFileId' }],
          }],
          oauthLoginUrl: 'https://accounts.x.ai/device?device_code=oauthHistoryDeviceSecret321',
          oauthLoginSessionId: 'oauthHistoryDeviceSecret321',
          access_token: 'collabHistoricalOperationSecret654',
          YXBpS2V5: 'collabEncodedFieldSecret987',
          headers: [['X-Api-Key', 'collabHeaderPairSecret741']],
          providerParameter: { name: 'apiKey', value: 'collabDescriptorSecret852' },
          localNote: 'C:\\Users\\host-owner\\private-workflow.json',
          referenceUrl: 'https://example.test/result.png?token=collabSignedUrlSecret321',
        },
      },
    }], { expectedRevision: 1 });

    const operationResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/sync?afterRevision=1`, { headers });
    const operationPayload = await operationResponse.json();
    assert.equal(operationResponse.status, 200, JSON.stringify(operationPayload));
    assert.equal(operationPayload.data.mode, 'operations');
    assert.equal(operationPayload.data.operations[0].payload.dataPatch.prompt, 'visible prompt');
    assert.equal(Object.hasOwn(operationPayload.data.operations[0].payload.dataPatch, 'key'), false);
    assert.deepEqual(operationPayload.data.operations[0].payload.dataPatch.parameter, {
      key: 'prompt',
      value: 'visible history value',
    });
    assert.deepEqual(operationPayload.data.operations[0].payload.dataPatch.configuredParameter, {
      value: '[redacted]',
    });
    assert.equal(operationPayload.data.operations[0].payload.dataPatch.feishuAppToken, 'bascnHistoryResourceId');
    assert.equal(operationPayload.data.operations[0].payload.dataPatch.feishuRows[0].appToken, 'bascnHistoryResourceId');
    assert.equal(operationPayload.data.operations[0].payload.dataPatch.feishuRows[0].media[0].fileToken, 'boxcnHistoryFileId');
    assert.equal(Object.hasOwn(operationPayload.data.operations[0].payload.dataPatch, 'oauthLoginUrl'), false);
    assert.equal(Object.hasOwn(operationPayload.data.operations[0].payload.dataPatch, 'oauthLoginSessionId'), false);
    assert.equal(Object.hasOwn(operationPayload.data.operations[0].payload.dataPatch, 'access_token'), false);
    assert.equal(Object.hasOwn(operationPayload.data.operations[0].payload.dataPatch, 'YXBpS2V5'), false);
    assert.equal(operationPayload.data.operations[0].payload.dataPatch.localNote, '[local-path]');
    assert.equal(Object.hasOwn(operationPayload.data.operations[0], 'sessionId'), false);
    assert.doesNotMatch(
      JSON.stringify(operationPayload),
      /collabHistoricalOperationSecret654|collabEncodedFieldSecret987|collabHeaderPairSecret741|collabDescriptorSecret852|collabHistoryDescriptorSecret753|collabSignedUrlSecret321|oauthHistoryDeviceSecret321|visible-history-key|host-owner|local-owner-secret-session/i,
    );
  });
});

test('viewer can read but cannot mutate while editor operation is revision checked', async () => {
  await withGateway(async ({ baseUrl, gateway }) => {
    const viewer = await redeem(baseUrl, gateway, 'viewer', '只读审片');
    const viewResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-a`, {
      headers: { cookie: viewer.cookie },
    });
    assert.equal(viewResponse.status, 200);
    const initial = (await viewResponse.json()).data;

    const denied = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/operations`, {
      method: 'POST',
      headers: { cookie: viewer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: initial.revision, operations: [] }),
    });
    assert.equal(denied.status, 403);

    const editor = await redeem(baseUrl, gateway, 'editor', '协作编辑');
    const applied = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/operations`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: initial.revision,
        operations: [{
          opId: 'editor-move-1',
          clientSeq: 1,
          type: 'node.move',
          payload: { nodeId: 'node-a', position: { x: 80, y: 120 } },
        }],
      }),
    });
    const appliedPayload = await applied.json();
    assert.equal(applied.status, 200, JSON.stringify(appliedPayload));
    const responseFeishuNode = appliedPayload.data.document.nodes.find((node) => node.id === 'feishu-node');
    assert.equal(responseFeishuNode.data.feishuAppToken, 'bascnVisibleResourceId');
    assert.equal(responseFeishuNode.data.feishuRows[0].appToken, 'bascnVisibleResourceId');
    assert.equal(responseFeishuNode.data.feishuRows[0].media[0].fileToken, 'boxcnVisibleFileId');
    assert.doesNotMatch(
      JSON.stringify(appliedPayload),
      /collabCurrentDocumentSecret987|collabCurrentDescriptorSecret159|collabRawWorkflowSecret246|collabEdgeSecret864/,
    );

    const collision = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/operations`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 2,
        operations: [{
          opId: 'editor-move-1',
          clientSeq: 1,
          type: 'node.move',
          payload: { nodeId: 'node-a', position: { x: 81, y: 121 } },
        }],
      }),
    });
    const collisionPayload = await collision.json();
    assert.equal(collision.status, 409, JSON.stringify(collisionPayload));
    assert.equal(collisionPayload.code, 'operation_id_conflict');
    assert.equal(collisionPayload.currentRevision, 2);
    assert.equal(collisionPayload.data, undefined);
    assert.doesNotMatch(JSON.stringify(collisionPayload), /collabCurrentDocumentSecret987/i);

    const stale = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/operations`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: initial.revision,
        operations: [{ opId: 'editor-move-2', type: 'node.move', payload: { nodeId: 'node-a', position: { x: 1, y: 1 } } }],
      }),
    });
    assert.equal(stale.status, 409);
  });
});

test('collaboration operations require one authoritative top-level baseRevision', async () => {
  await withGateway(async ({ baseUrl, gateway, database }) => {
    const editor = await redeem(baseUrl, gateway, 'editor', '版本攻击测试');
    const applied = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/operations`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 1,
        operations: [{
          opId: 'fresh-operation-before-stale',
          type: 'node.patch',
          payload: { nodeId: 'node-a', dataPatch: { prompt: 'fresh update' } },
        }],
      }),
    });
    assert.equal(applied.status, 200, await applied.text());
    assert.equal(database.getCanvas('canvas-a').revision, 2);

    const staleWithoutBatchRevision = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/operations`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        operations: [{
          opId: 'stale-operation-without-batch-revision',
          baseRevision: 1,
          type: 'node.patch',
          payload: { nodeId: 'node-a', dataPatch: { prompt: 'stale overwrite' } },
        }],
      }),
    });
    const stalePayload = await staleWithoutBatchRevision.json();
    assert.equal(staleWithoutBatchRevision.status, 400, JSON.stringify(stalePayload));
    assert.equal(stalePayload.code, 'canvas_operation_revision_required');
    assert.equal(database.getCanvas('canvas-a').revision, 2);
    assert.equal(database.getCanvas('canvas-a').nodes[0].data.prompt, 'fresh update');

    const mismatchedOperationRevision = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/operations`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 2,
        operations: [{
          opId: 'stale-operation-with-conflicting-batch-revision',
          baseRevision: 1,
          type: 'node.patch',
          payload: { nodeId: 'node-a', dataPatch: { prompt: 'conflicting overwrite' } },
        }],
      }),
    });
    const mismatchPayload = await mismatchedOperationRevision.json();
    assert.equal(mismatchedOperationRevision.status, 400, JSON.stringify(mismatchPayload));
    assert.equal(mismatchPayload.code, 'canvas_operation_revision_mismatch');
    assert.equal(database.getCanvas('canvas-a').revision, 2);
    assert.equal(database.getCanvas('canvas-a').nodes[0].data.prompt, 'fresh update');
  });
});

test('collaboration editors cannot inject host credentials through generic operations', async () => {
  await withGateway(async ({ baseUrl, gateway, database }) => {
    const editor = await redeem(baseUrl, gateway, 'editor', '凭据攻击测试');
    const response = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/operations`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 1,
        operations: [{
          opId: 'editor-credential-injection',
          type: 'node.patch',
          payload: {
            nodeId: 'node-a',
            dataPatch: { YXBpS2V5: 'EDITOR_INJECTED_SECRET_321' },
          },
        }],
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 403, JSON.stringify(payload));
    assert.equal(payload.code, 'canvas_patch_host_credentials_forbidden');
    assert.equal(database.getCanvas('canvas-a').revision, 1);
    assert.doesNotMatch(JSON.stringify(database.getCanvas('canvas-a')), /EDITOR_INJECTED_SECRET_321/);

    const nestedResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/operations`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 1,
        operations: [{
          opId: 'editor-nested-credential-injection',
          type: 'node.patch',
          payload: {
            nodeId: 'node-a',
            patch: { data: { 'a%70i_key': 'EDITOR_NESTED_SECRET_654' } },
          },
        }],
      }),
    });
    const nestedPayload = await nestedResponse.json();
    assert.equal(nestedResponse.status, 403, JSON.stringify(nestedPayload));
    assert.equal(nestedPayload.code, 'canvas_patch_host_credentials_forbidden');
    assert.equal(database.getCanvas('canvas-a').revision, 1);
    assert.doesNotMatch(JSON.stringify(database.getCanvas('canvas-a')), /EDITOR_NESTED_SECRET_654/);

    const descriptorResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/operations`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 1,
        operations: [{
          opId: 'editor-descriptor-credential-injection',
          type: 'node.patch',
          payload: {
            nodeId: 'node-a',
            dataPatch: {
              providerParameter: { name: 'apiKey', value: 'EDITOR_DESCRIPTOR_SECRET_963' },
            },
          },
        }],
      }),
    });
    const descriptorPayload = await descriptorResponse.json();
    assert.equal(descriptorResponse.status, 403, JSON.stringify(descriptorPayload));
    assert.equal(descriptorPayload.code, 'canvas_patch_host_credentials_forbidden');
    assert.equal(database.getCanvas('canvas-a').revision, 1);
    assert.doesNotMatch(JSON.stringify(database.getCanvas('canvas-a')), /EDITOR_DESCRIPTOR_SECRET_963/);

    const securityDocument = database.getCanvas('canvas-a');
    const secretNodeEntityUid = securityDocument.nodes.find((node) => node.id === 'secret-node').entityUid;
    const deniedExistingCredentialMutations = [
      {
        opId: 'editor-raw-comfy-credential-injection',
        type: 'node.patch',
        payload: {
          nodeId: 'node-a',
          dataPatch: {
            comfyMakerWorkflowRaw: '{"1":{"inputs":{"key":"EDITOR_RAW_WORKFLOW_SECRET_147"}}}',
          },
        },
      },
      {
        opId: 'editor-base64-credential-injection',
        type: 'node.patch',
        payload: {
          nodeId: 'node-a',
          dataPatch: {
            workflowJson: Buffer.from('{"apiKey":"EDITOR_BASE64_SECRET_258"}').toString('base64'),
          },
        },
      },
      {
        opId: 'editor-oversized-structured-credential-injection',
        type: 'node.patch',
        payload: {
          nodeId: 'node-a',
          dataPatch: {
            comfyMakerWorkflowRaw: JSON.stringify({
              padding: 'x'.repeat((512 * 1024) + 1024),
              apiKey: 'EDITOR_OVERSIZED_SECRET_741',
            }),
          },
        },
      },
      {
        opId: 'editor-fake-feishu-scope',
        type: 'node.patch',
        payload: {
          nodeId: 'node-a',
          dataPatch: {
            feishuAppToken: 'fake-scope-marker',
            fileToken: 'EDITOR_FAKE_SCOPE_SECRET_369',
          },
        },
      },
      {
        opId: 'editor-fake-feishu-container-scope',
        type: 'node.patch',
        payload: {
          nodeId: 'node-a',
          dataPatch: {
            feishuRows: [{
              appToken: 'EDITOR_FAKE_CONTAINER_APP_SECRET_159',
              media: [{ fileToken: 'EDITOR_FAKE_CONTAINER_FILE_SECRET_753' }],
            }],
          },
        },
      },
      {
        opId: 'editor-feishu-operation-envelope-smuggling',
        type: 'node.move',
        payload: {
          nodeId: 'feishu-node',
          position: { x: 700, y: 20 },
          ignoredEnvelope: { appToken: 'EDITOR_FEISHU_ENVELOPE_SECRET_951' },
        },
      },
      {
        opId: 'editor-feishu-nested-container-smuggling',
        type: 'node.patch',
        payload: {
          nodeId: 'feishu-node',
          dataPatch: {
            ignored: {
              feishuRows: [{
                appToken: 'EDITOR_FEISHU_NESTED_APP_SECRET_357',
                media: [{ fileToken: 'EDITOR_FEISHU_NESTED_FILE_SECRET_852' }],
              }],
            },
          },
        },
      },
      {
        opId: 'editor-oauth-fragment-and-pair-smuggling',
        type: 'node.patch',
        payload: {
          nodeId: 'node-a',
          dataPatch: {
            callbackUrl: 'https://example.test/#/callback?code=EDITOR_HASH_CODE_SECRET_654',
            nestedUrl: `https://example.test/?payload=${Buffer.from(JSON.stringify({ apiKey: 'EDITOR_URL_PAYLOAD_SECRET_456' })).toString('base64url')}`,
            pairs: [['apiKey', 'EDITOR_PAIR_SECRET_753']],
          },
        },
      },
      {
        opId: 'editor-sensitive-data-unset',
        type: 'node.patch',
        payload: { nodeId: 'secret-node', unsetKeys: ['data'] },
      },
      {
        opId: 'editor-sensitive-data-replace',
        type: 'node.patch',
        payload: { nodeId: 'secret-node', patch: { data: {} } },
      },
      {
        opId: 'editor-sensitive-node-delete',
        type: 'node.delete',
        payload: { nodeId: 'secret-node' },
      },
      {
        opId: 'editor-sensitive-data-unset-by-entity-uid',
        type: 'node.patch',
        payload: { nodeId: secretNodeEntityUid, unsetKeys: ['data'] },
      },
      {
        opId: 'editor-sensitive-node-delete-by-entity-uid',
        type: 'node.delete',
        payload: { nodeId: secretNodeEntityUid },
      },
      {
        opId: 'editor-sensitive-edge-cascade-delete',
        type: 'node.delete',
        payload: { nodeId: 'node-a' },
      },
    ];
    for (const operation of deniedExistingCredentialMutations) {
      const deniedMutation = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/operations`, {
        method: 'POST',
        headers: { cookie: editor.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevision: 1, operations: [operation] }),
      });
      const deniedMutationPayload = await deniedMutation.json();
      assert.equal(deniedMutation.status, 403, `${operation.opId}: ${JSON.stringify(deniedMutationPayload)}`);
      assert.equal(deniedMutationPayload.code, 'canvas_patch_host_credentials_forbidden');
      assert.equal(database.getCanvas('canvas-a').revision, 1);
      assert.ok(database.getCanvas('canvas-a').nodes.some((node) => node.id === 'secret-node'));
      assert.doesNotMatch(
        JSON.stringify(database.getCanvas('canvas-a')),
        /EDITOR_RAW_WORKFLOW_SECRET_147|EDITOR_BASE64_SECRET_258|EDITOR_OVERSIZED_SECRET_741|EDITOR_FAKE_SCOPE_SECRET_369|EDITOR_FAKE_CONTAINER_APP_SECRET_159|EDITOR_FAKE_CONTAINER_FILE_SECRET_753|EDITOR_FEISHU_ENVELOPE_SECRET_951|EDITOR_FEISHU_NESTED_APP_SECRET_357|EDITOR_FEISHU_NESTED_FILE_SECRET_852|EDITOR_HASH_CODE_SECRET_654|EDITOR_URL_PAYLOAD_SECRET_456|EDITOR_PAIR_SECRET_753/,
      );
    }
    const unknownSafePayload = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/operations`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 1,
        operations: [{
          opId: 'editor-unknown-safe-payload',
          type: 'node.move',
          payload: {
            nodeId: 'node-a',
            position: { x: 40, y: 50 },
            ignoredEnvelope: { label: 'must not persist' },
          },
        }],
      }),
    });
    const unknownSafePayloadBody = await unknownSafePayload.json();
    assert.equal(unknownSafePayload.status, 400, JSON.stringify(unknownSafePayloadBody));
    assert.ok(String(unknownSafePayloadBody.error || '').includes('payload 包含不支持字段'));
    assert.equal(database.getCanvas('canvas-a').revision, 1);

    const safeGraphData = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/operations`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 1,
        operations: [
          {
            opId: 'editor-safe-generic-key-data',
            type: 'node.patch',
            payload: {
              nodeId: 'node-a',
              dataPatch: {
                parameter: { key: 'prompt', value: 'visible editor value' },
              },
            },
          },
          {
            opId: 'editor-safe-feishu-resource-data',
            type: 'node.patch',
            payload: {
              nodeId: 'feishu-node',
              dataPatch: {
                feishuAppToken: 'bascnEditorResourceId',
                feishuRows: [{
                  appToken: 'bascnEditorResourceId',
                  media: [{ fileToken: 'boxcnEditorFileId' }],
                }],
              },
            },
          },
          {
            opId: 'editor-safe-key-node',
            type: 'node.add',
            payload: {
              node: {
                id: 'editor-safe-key-node',
                type: 'text',
                position: { x: 100, y: 100 },
                data: { tabs: [{ key: 'timeline', label: '时间线' }] },
              },
            },
          },
        ],
      }),
    });
    const safeGraphPayload = await safeGraphData.json();
    assert.equal(safeGraphData.status, 200, JSON.stringify(safeGraphPayload));
    const saved = database.getCanvas('canvas-a');
    assert.equal(saved.revision, 4);
    assert.deepEqual(saved.nodes.find((node) => node.id === 'node-a').data.parameter, {
      key: 'prompt',
      value: 'visible editor value',
    });
    assert.equal(saved.nodes.find((node) => node.id === 'feishu-node').data.feishuAppToken, 'bascnEditorResourceId');
    assert.equal(saved.nodes.find((node) => node.id === 'feishu-node').data.feishuRows[0].media[0].fileToken, 'boxcnEditorFileId');
    assert.equal(saved.nodes.find((node) => node.id === 'editor-safe-key-node').data.tabs[0].key, 'timeline');
  });
});

test('canvas history is readable but only editors can restore a new revision', async () => {
  await withGateway(async ({ baseUrl, gateway, database }) => {
    const viewer = await redeem(baseUrl, gateway, 'viewer', '历史查看者');
    const editor = await redeem(baseUrl, gateway, 'editor', '历史恢复者');
    database.saveCanvasSnapshot('canvas-a', {
      nodes: [{ id: 'node-a', type: 'text', position: { x: 10, y: 10 }, data: { text: 'changed' } }],
      edges: [],
    }, { expectedRevision: 1 });
    const history = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/history`, { headers: { cookie: viewer.cookie } });
    assert.equal(history.status, 200);
    assert.deepEqual((await history.json()).data.map((item) => item.revision), [2, 1]);
    const denied = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/history/2/restore`, {
      method: 'POST', headers: { cookie: viewer.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision: 2 }),
    });
    assert.equal(denied.status, 403);
    const restored = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/history/2/restore`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision: 2 }),
    });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).data.revision, 3);
    const beforeSensitiveRestore = database.getCanvas('canvas-a');
    const sensitiveRestore = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/history/1/restore`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: 3 }),
    });
    const sensitiveRestorePayload = await sensitiveRestore.json();
    assert.equal(sensitiveRestore.status, 403, JSON.stringify(sensitiveRestorePayload));
    assert.equal(sensitiveRestorePayload.code, 'canvas_snapshot_host_credentials_forbidden');
    assert.deepEqual(database.getCanvas('canvas-a'), beforeSensitiveRestore);

    const restoreCanvasSnapshot = database.restoreCanvasSnapshot;
    database.restoreCanvasSnapshot = () => {
      throw Object.assign(new Error(
        'restore rejected token=collabTokenStandalone123 access_token=collabAccessStandalone456 refresh_token=collabRefreshStandalone789 id_token=collabIdStandalone012',
      ), {
        code: 'snapshot_restore_invalid',
        status: 400,
        current: {
          revision: 3,
          nodes: [{ data: { access_token: 'collabRestoreCurrentSecret987' } }],
        },
      });
    };
    let rejectedRestore;
    try {
      rejectedRestore = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/history/1/restore`, {
        method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision: 3 }),
      });
    } finally {
      database.restoreCanvasSnapshot = restoreCanvasSnapshot;
    }
    const rejectedRestorePayload = await rejectedRestore.json();
    assert.equal(rejectedRestore.status, 400, JSON.stringify(rejectedRestorePayload));
    assert.equal(rejectedRestorePayload.code, 'snapshot_restore_invalid');
    assert.equal(rejectedRestorePayload.currentRevision, 3);
    assert.equal(rejectedRestorePayload.data, undefined);
    assert.doesNotMatch(JSON.stringify(rejectedRestorePayload), /collab(?:Token|Access|Refresh|Id)Standalone|collabRestoreCurrentSecret987/i);
  });
});

test('subflow publication is editor scoped, revision checked and broadcast to the current canvas', async () => {
  await withGateway(async ({ baseUrl, gateway, database, status }) => {
    const viewer = await redeem(baseUrl, gateway, 'viewer', '定义查看者');
    const reviewer = await redeem(baseUrl, gateway, 'reviewer', '定义审片者');
    const editorA = await redeem(baseUrl, gateway, 'editor', '发布者 A');
    const editorB = await redeem(baseUrl, gateway, 'editor', '发布者 B');
    const editorASession = (await (await fetch(`${baseUrl}/api/collab/session`, { headers: { cookie: editorA.cookie } })).json()).data;
    const legacyDefinition = database.getSubflowDefinition('shared-subflow', 1, 'project-local');
    legacyDefinition.description = 'C:\\Users\\host-owner\\private-subflow.json';
    legacyDefinition.referenceUrl = 'https://example.test/?state=SUBFLOW_STATE_SECRET';
    legacyDefinition.nodes[0].data = {
      ...legacyDefinition.nodes[0].data,
      nestedFakeFeishu: {
        type: 'feishu-bitable-input',
        feishuRows: [{
          appToken: 'SUBFLOW_FAKE_APP_SECRET',
          media: [{ fileToken: 'SUBFLOW_FAKE_FILE_SECRET' }],
        }],
      },
      oauthResponse: { code: 'SUBFLOW_OBJECT_CODE_SECRET', state: 'SUBFLOW_OBJECT_STATE_SECRET' },
      pairs: [['apiKey', 'SUBFLOW_PAIR_SECRET'], ['prompt', 'visible']],
    };
    database.db.prepare(`
      UPDATE subflow_definitions SET definition_json = ?
      WHERE project_id = ? AND id = ? AND version = ?
    `).run(JSON.stringify(legacyDefinition), 'project-local', 'shared-subflow', 1);

    const listResponse = await fetch(`${baseUrl}/api/collab/subflows`, { headers: { cookie: viewer.cookie } });
    assert.equal(listResponse.status, 200);
    const initial = (await listResponse.json()).data[0];
    assert.equal(initial.id, 'shared-subflow');
    assert.equal(initial.version, 1);
    assert.equal(initial.revision, 1);
    assert.equal(initial.changeSummary, '创建共享子工作流');
    assert.equal(initial.description, '[local-path]');
    assert.equal(initial.referenceUrl, '[redacted]');
    assert.deepEqual(initial.nodes[0].data.oauthResponse, {});
    assert.deepEqual(initial.nodes[0].data.pairs[0], ['[redacted-field]', '[redacted]']);
    assert.deepEqual(initial.nodes[0].data.pairs[1], ['prompt', 'visible']);
    assert.doesNotMatch(
      JSON.stringify(initial),
      /host-owner|private-subflow|SUBFLOW_STATE_SECRET|SUBFLOW_FAKE_APP_SECRET|SUBFLOW_FAKE_FILE_SECRET|SUBFLOW_OBJECT_CODE_SECRET|SUBFLOW_OBJECT_STATE_SECRET|SUBFLOW_PAIR_SECRET/,
    );
    for (const endpoint of [
      '/api/collab/subflows/shared-subflow/1',
      '/api/collab/subflows/shared-subflow/versions',
    ]) {
      const response = await fetch(`${baseUrl}${endpoint}`, { headers: { cookie: viewer.cookie } });
      const payload = await response.json();
      assert.equal(response.status, 200, `${endpoint}: ${JSON.stringify(payload)}`);
      assert.doesNotMatch(
        JSON.stringify(payload),
        /host-owner|private-subflow|SUBFLOW_STATE_SECRET|SUBFLOW_FAKE_APP_SECRET|SUBFLOW_FAKE_FILE_SECRET|SUBFLOW_OBJECT_CODE_SECRET|SUBFLOW_OBJECT_STATE_SECRET|SUBFLOW_PAIR_SECRET/,
      );
    }

    const reviewerDenied = await fetch(`${baseUrl}/api/collab/subflows/shared-subflow/publish`, {
      method: 'POST',
      headers: { cookie: reviewer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: 1, changeSummary: '越权发布', definition: initial }),
    });
    assert.equal(reviewerDenied.status, 403);

    const missingSummary = await fetch(`${baseUrl}/api/collab/subflows/shared-subflow/publish`, {
      method: 'POST',
      headers: { cookie: editorA.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: 1, definition: initial }),
    });
    assert.equal(missingSummary.status, 400);
    assert.match((await missingSummary.json()).error, /变更说明/);
    const rejectedSecretDefinitions = [
      { pairs: [['apiKey', 'SUBFLOW_PUBLISH_PAIR_SECRET']] },
      { workflowRaw: JSON.stringify({ apiKey: 'SUBFLOW_PUBLISH_JSON_SECRET' }) },
      { workflowEncoded: Buffer.from(JSON.stringify({ apiKey: 'SUBFLOW_PUBLISH_BASE64_SECRET' })).toString('base64url') },
      { callbackUrl: 'https://example.test/#access_token=SUBFLOW_PUBLISH_FRAGMENT_SECRET' },
      { prompt: ['sk-', 'abcdefghijklmnopqrstuvwxyz123456'].join('') },
      { prompt: 'Bearer subflow-publish-bearer-secret' },
      { prompt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJzdWJmbG93In0', 'c2lnbmF0dXJl'].join('.') },
      { prompt: 'data:image/png;base64,QUJDREVGRw==' },
    ];
    for (const [index, injectedData] of rejectedSecretDefinitions.entries()) {
      const rejected = await fetch(`${baseUrl}/api/collab/subflows/shared-subflow/publish`, {
        method: 'POST',
        headers: { cookie: editorA.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          baseRevision: 1,
          changeSummary: `拒绝秘密子工作流 ${index + 1}`,
          definition: {
            ...initial,
            nodes: initial.nodes.map((node, nodeIndex) => (
              nodeIndex === 0 ? { ...node, data: { ...node.data, ...injectedData } } : node
            )),
          },
        }),
      });
      const rejectedPayload = await rejected.json();
      assert.equal(rejected.status, 400, JSON.stringify(rejectedPayload));
      assert.match(rejectedPayload.error, /凭据|秘密/);
      assert.equal(database.listSubflowVersions('shared-subflow', 'project-local').length, 1);
    }

    const socket = new WebSocket(`ws://127.0.0.1:${status.port}/ws/collab`, {
      origin: `http://127.0.0.1:${status.port}`,
      headers: { cookie: editorB.cookie },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('canvas websocket did not join')), 3000);
      socket.once('error', reject);
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'session.ready') {
          socket.send(JSON.stringify({ type: 'canvas.join', canvasId: 'canvas-a' }));
          return;
        }
        if (message.type !== 'canvas.joined') return;
        clearTimeout(timer);
        resolve();
      });
    });
    const broadcast = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('subflow canvas broadcast timed out')), 3000);
      const onMessage = (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type !== 'subflow.published') return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(message);
      };
      socket.on('message', onMessage);
    });

    const publishedResponse = await fetch(`${baseUrl}/api/collab/subflows/shared-subflow/publish`, {
      method: 'POST',
      headers: { cookie: editorA.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 1,
        changeSummary: '编辑者 A 更新说明',
        definition: { ...initial, name: '共享子工作流 v2', description: 'A 的版本' },
      }),
    });
    const publishedPayload = await publishedResponse.json();
    assert.equal(publishedResponse.status, 201, JSON.stringify(publishedPayload));
    const published = publishedPayload.data;
    assert.equal(published.version, 2);
    assert.equal(published.revision, 2);
    assert.equal(published.changeSummary, '编辑者 A 更新说明');
    assert.equal(published.publishedBy, editorA.payload.memberId);
    const unsafeCurrent = database.getSubflowDefinition('shared-subflow', 2, 'project-local');
    unsafeCurrent.referenceUrl = 'https://example.test/#/callback?code=SUBFLOW_CONFLICT_CODE_SECRET';
    unsafeCurrent.nodes[0].data.oauthResponseRaw = JSON.stringify({
      code: 'SUBFLOW_CONFLICT_RAW_CODE_SECRET',
      state: 'SUBFLOW_CONFLICT_RAW_STATE_SECRET',
    });
    database.db.prepare(`
      UPDATE subflow_definitions SET definition_json = ?
      WHERE project_id = ? AND id = ? AND version = ?
    `).run(JSON.stringify(unsafeCurrent), 'project-local', 'shared-subflow', 2);

    const event = await broadcast;
    assert.deepEqual(event.publication, {
      id: 'shared-subflow',
      projectId: 'project-local',
      name: '共享子工作流 v2',
      version: 2,
      revision: 2,
      changeSummary: '编辑者 A 更新说明',
      publishedBy: editorA.payload.memberId,
      publishedAt: published.publishedAt,
    });
    assert.equal(Object.hasOwn(event.publication, 'nodes'), false);

    const staleResponse = await fetch(`${baseUrl}/api/collab/subflows/shared-subflow/publish`, {
      method: 'POST',
      headers: { cookie: editorB.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 1,
        changeSummary: '编辑者 B 的过期草稿',
        definition: { ...initial, name: '不应覆盖的新名字' },
      }),
    });
    assert.equal(staleResponse.status, 409);
    const stale = await staleResponse.json();
    assert.equal(stale.code, 'subflow_revision_conflict');
    assert.equal(stale.data.revision, 2);
    assert.equal(stale.data.latestVersion, 2);
    assert.equal(stale.data.definition.name, '共享子工作流 v2');
    assert.equal(stale.data.definition.referenceUrl, '[redacted]');
    assert.equal(stale.data.definition.nodes[0].data.oauthResponseRaw, '[redacted]');
    assert.doesNotMatch(
      JSON.stringify(stale),
      /SUBFLOW_CONFLICT_CODE_SECRET|SUBFLOW_CONFLICT_RAW_CODE_SECRET|SUBFLOW_CONFLICT_RAW_STATE_SECRET/,
    );
    assert.equal(database.listSubflowVersions('shared-subflow', 'project-local').length, 2);

    const audit = database.listAuditEvents({ projectId: 'project-local', action: 'subflow.definition.publish' })[0];
    assert.equal(audit.actorId, editorA.payload.memberId);
    assert.equal(audit.sessionId, editorASession.id);
    assert.equal(audit.metadata.revision, 2);
    assert.equal(audit.metadata.changeSummary, '编辑者 A 更新说明');
    socket.close();
  });
});

test('websocket requires a valid session and same-origin upgrade', async () => {
  await withGateway(async ({ baseUrl, gateway, status }) => {
    const editor = await redeem(baseUrl, gateway, 'editor', '在线编辑');
    const wsUrl = `ws://127.0.0.1:${status.port}/ws/collab`;

    await assert.rejects(new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { origin: 'https://evil.example', headers: { cookie: editor.cookie } });
      socket.once('open', () => resolve());
      socket.once('error', reject);
    }));

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl, {
        origin: `http://127.0.0.1:${status.port}`,
        headers: { cookie: editor.cookie },
      });
      const timer = setTimeout(() => reject(new Error('websocket test timed out')), 3000);
      socket.once('error', reject);
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'session.ready') {
          socket.send(JSON.stringify({ type: 'canvas.join', canvasId: 'canvas-a' }));
        }
        if (message.type === 'canvas.joined') {
          clearTimeout(timer);
          assert.equal(message.canvasId, 'canvas-a');
          socket.close();
          resolve();
        }
      });
    });
  });
});

test('remote clients cannot forge run state or output while host broadcasts safe authoritative media URLs', async () => {
  await withGateway(async ({ baseUrl, gateway, database, status }) => {
    const editor = await redeem(baseUrl, gateway, 'editor', '运行协作者');
    database.upsertAsset({
      id: 'asset-host-1', projectId: 'project-local', kind: 'image', filename: 'host.png', mimeType: 'image/png',
      sourceUrl: 'https://evil.example/forged.png', managedPath: 'C:\\secret\\host.png', createdBy: 'local-owner',
    });
    scopeAssetToCanvas(database, 'asset-host-1');
    const forgedHttp = await fetch(`${baseUrl}/api/collab/project-runs`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'succeeded', outputUrl: 'https://evil.example/fake.mp4' }),
    });
    assert.equal(forgedHttp.status, 404);

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${status.port}/ws/collab`, {
        origin: `http://127.0.0.1:${status.port}`,
        headers: { cookie: editor.cookie },
      });
      const timer = setTimeout(() => reject(new Error('authoritative run broadcast timed out')), 4000);
      socket.once('error', reject);
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'session.ready') socket.send(JSON.stringify({ type: 'canvas.join', canvasId: 'canvas-a' }));
        else if (message.type === 'canvas.joined') socket.send(JSON.stringify({ type: 'run.state', run: { id: 'forged', status: 'succeeded' } }));
        else if (message.type === 'error' && message.code === 'host_authoritative_message') {
          gateway.broadcastHostRunState({
            id: 'host-run-1', projectId: 'project-local', canvasId: 'canvas-a', canvasRevision: 1,
            initiatorId: editor.payload.memberId, status: 'running', createdAt: 10, startedAt: 11,
          });
        } else if (message.type === 'run.state') {
          assert.equal(message.run.id, 'host-run-1');
          assert.equal(message.run.status, 'running');
          assert.equal(Object.hasOwn(message.run, 'summary'), false);
          gateway.broadcastHostRunOutput(
            { id: 'host-run-1', projectId: 'project-local', canvasId: 'canvas-a' },
            { id: 'host-node-1', nodeId: 'image-node', outputRefs: ['asset-host-1'] },
            [{ id: 'asset-host-1', kind: 'image', filename: 'host.png', mimeType: 'image/png', sourceUrl: 'https://evil.example/forged.png', managedPath: 'C:\\secret\\host.png' }],
          );
        } else if (message.type === 'run.output') {
          assert.deepEqual(message.assets, [{
            id: 'asset-host-1', kind: 'image', filename: 'host.png', mimeType: 'image/png',
            mediaUrl: '/api/collab/assets/asset-host-1/media',
          }]);
          assert.equal(JSON.stringify(message).includes('evil.example'), false);
          assert.equal(JSON.stringify(message).includes('secret'), false);
          clearTimeout(timer);
          socket.close();
          resolve();
        }
      });
    });
  });
});
