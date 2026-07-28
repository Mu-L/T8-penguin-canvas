'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const surfaces = require('../backend/src/shared/creativeCapabilitySurfaces.json');
const { createAgentControlAuthService } = require('../backend/src/services/agentControlAuth.js');
const { createAgentControlApprovalService } = require('../backend/src/services/agentControlApprovals.js');
const {
  VERSIONED_TOOL_REQUEST_SCHEMA,
  createAgentControlCapabilityToolService,
} = require('../backend/src/services/agentControlCapabilityTools.js');
const agentControlRoute = require('../backend/src/routes/agentControl.js');

function request(server, options = {}, body = null) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      method: options.method || 'GET',
      path: options.path || '/',
      headers: {
        Host: '127.0.0.1:19041',
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: text ? JSON.parse(text) : null,
      }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function issueSession(auth, scopes, name) {
  const pairing = auth.createPairing({
    clientName: name,
    agentKind: 'codex',
    requestedScopes: scopes,
  });
  auth.approvePairing({
    pairingId: pairing.pairingId,
    userCode: pairing.userCode,
    approvedScopes: scopes,
  });
  return auth.pollPairing({
    pairingId: pairing.pairingId,
    pollSecret: pairing.pollSecret,
  });
}

function toolRequest(overrides = {}) {
  return {
    schema: VERSIONED_TOOL_REQUEST_SCHEMA,
    tool: 'zcanvas_create_image',
    version: surfaces.capabilityManifestVersion,
    operation: 'plan',
    projectId: 'project-local',
    canvasId: 'canvas-capability-route',
    clientRequestId: 'request-capability-route-1',
    input: { prompt: '雨夜角色海报' },
    ...overrides,
  };
}

test('capability tool routes enforce catalog auth, per-operation scopes and approval boundaries', async (t) => {
  const auth = createAgentControlAuthService();
  const approvals = createAgentControlApprovalService();
  const dispatches = [];
  const capabilityToolService = createAgentControlCapabilityToolService({
    dispatch: async (entry) => {
      dispatches.push(structuredClone(entry));
      return { planId: 'plan-capability-route-1', ready: true };
    },
  });
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/agent-control/v1', agentControlRoute.createAgentControlRouter({
    auth,
    approvals,
    capabilityToolService,
    config: {
      PORT: 19041,
      APP_VERSION: '2.6.5',
      BACKEND_INSTANCE_ID: 'r'.repeat(43),
      SETTINGS_FILE: '',
    },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const anonymousCatalog = await request(server, {
    path: '/api/agent-control/v1/capability-tools',
  });
  assert.equal(anonymousCatalog.status, 401);

  const reader = issueSession(auth, ['canvas:read'], 'Capability reader');
  const writer = issueSession(auth, ['canvas:read', 'canvas:write'], 'Capability writer');
  const browser = issueSession(auth, ['canvas:read', 'browser:handoff'], 'Capability browser');
  const readerHeaders = { Authorization: `Bearer ${reader.accessToken}` };
  const writerHeaders = { Authorization: `Bearer ${writer.accessToken}` };
  const browserHeaders = { Authorization: `Bearer ${browser.accessToken}` };

  const catalog = await request(server, {
    path: '/api/agent-control/v1/capability-tools',
    headers: readerHeaders,
  });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.data.tools.length, 31);
  assert.equal(JSON.stringify(catalog.body.data).includes('"handler"'), false);
  assert.equal(JSON.stringify(catalog.body.data).includes('"service"'), false);
  assert.equal(JSON.stringify(catalog.body.data).includes('"method"'), false);

  const planned = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/capability-tools/invoke',
    headers: readerHeaders,
  }, toolRequest());
  assert.equal(planned.status, 200);
  assert.equal(planned.body.data.schema, 't8-versioned-creative-tool-result-v1');
  assert.equal(planned.body.data.readOnly, true);
  assert.deepEqual(planned.body.data.sideEffects, {
    canvasWrites: 0,
    providerCalls: 0,
    fileWrites: 0,
  });
  assert.equal(dispatches.length, 1);

  const blockedApply = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/capability-tools/invoke',
    headers: writerHeaders,
  }, toolRequest({ operation: 'apply' }));
  assert.equal(blockedApply.status, 409);
  assert.equal(blockedApply.body.code, 'CAPABILITY_TOOL_APPROVAL_REQUIRED');
  assert.equal(blockedApply.body.details.approvalRequired, true);
  assert.equal(dispatches.length, 1);

  const missingBrowserScope = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/capability-tools/invoke',
    headers: readerHeaders,
  }, toolRequest({
    tool: 'zcanvas_browser_handoff',
    operation: 'preview',
    input: { action: 'open', userInitiated: true },
  }));
  assert.equal(missingBrowserScope.status, 403);
  assert.equal(missingBrowserScope.body.code, 'AUTH_SCOPE_FORBIDDEN');
  assert.equal(dispatches.length, 1);

  const allowedBrowserScope = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/capability-tools/invoke',
    headers: browserHeaders,
  }, toolRequest({
    tool: 'zcanvas_browser_handoff',
    operation: 'preview',
    input: { action: 'open', userInitiated: true },
  }));
  assert.equal(allowedBrowserScope.status, 200);
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[1].binding.service, 'agentControlBrowser');
  assert.equal(dispatches[1].binding.method, 'createBrowserHandoff');
  assert.equal(dispatches[1].binding.operation, 'open');

  const lowLevelRequest = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/capability-tools/invoke',
    headers: readerHeaders,
  }, toolRequest({
    input: { providerPayload: { endpoint: 'https://example.invalid' } },
  }));
  assert.equal(lowLevelRequest.status, 403);
  assert.equal(lowLevelRequest.body.code, 'CAPABILITY_TOOL_LOW_LEVEL_FIELD_FORBIDDEN');
  assert.equal(dispatches.length, 2);
});

test('real versioned planning route uses the generated high-level handler without approval or canvas writes', async (t) => {
  const auth = createAgentControlAuthService();
  const baseApprovals = createAgentControlApprovalService();
  let invalidationCalls = 0;
  const approvals = {
    ...baseApprovals,
    invalidateBinding(...args) {
      invalidationCalls += 1;
      return baseApprovals.invalidateBinding(...args);
    },
  };
  const document = {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: 'project-local',
    canvasId: 'canvas-capability-real-route',
    revision: 7,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  let previewCalls = 0;
  let applyCalls = 0;
  const database = {
    getCanvas: (canvasId) => canvasId === document.canvasId ? structuredClone(document) : null,
    previewCanvasPatch: () => {
      previewCalls += 1;
      throw new Error('versioned L0 plan must not preview a persisted CanvasPatch');
    },
    applyCanvasPatch: () => {
      applyCalls += 1;
      throw new Error('versioned L0 plan must not apply a CanvasPatch');
    },
  };
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/agent-control/v1', agentControlRoute.createAgentControlRouter({
    auth,
    approvals,
    database,
    config: {
      PORT: 19041,
      APP_VERSION: '2.6.5',
      BACKEND_INSTANCE_ID: 'p'.repeat(43),
      SETTINGS_FILE: '',
    },
    settingsProvider: () => [],
    credentialSettingsProvider: () => ({ zhenzhenSd2ApiKey: 'configured-not-returned' }),
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const reader = issueSession(auth, ['canvas:read'], 'Capability real-route reader');
  const headers = { Authorization: `Bearer ${reader.accessToken}` };
  const models = await request(server, {
    path: `/api/agent-control/v1/models?projectId=${document.projectId}&canvasId=${document.canvasId}`,
    headers,
  });
  assert.equal(models.status, 200);
  const imageModel = models.body.data.items.find((item) => (
    item.kind === 'image' && item.provider === 'seedance-nz' && item.readiness.executable === true
  ));
  assert.ok(imageModel);

  const planned = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/capability-tools/invoke',
    headers,
  }, toolRequest({
    canvasId: document.canvasId,
    input: {
      kind: 'image',
      prompt: '雨夜角色海报',
      ratio: '16:9',
      imageProvider: imageModel.provider,
      imageModel: imageModel.model,
    },
  }));
  assert.equal(planned.status, 200);
  assert.equal(planned.body.data.tool.capabilityId, 'create.image');
  assert.equal(planned.body.data.data.ready, true);
  assert.equal(planned.body.data.data.impact.writesNow, 0);
  assert.equal(planned.body.data.data.impact.providerCallsNow, 0);
  assert.equal(planned.body.data.readOnly, true);
  assert.deepEqual(planned.body.data.sideEffects, {
    canvasWrites: 0,
    providerCalls: 0,
    fileWrites: 0,
  });
  assert.equal(document.revision, 7);
  assert.equal(previewCalls, 0);
  assert.equal(applyCalls, 0);
  assert.equal(invalidationCalls, 0);
  assert.equal(JSON.stringify(planned.body).includes('configured-not-returned'), false);
});
