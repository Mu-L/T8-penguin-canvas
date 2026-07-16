const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const projectRoot = path.resolve(__dirname, '..');
const routeModulePath = path.join(projectRoot, 'backend', 'src', 'routes', 'canvasAgentTools.js');
const projectDatabaseModulePath = require.resolve('../backend/src/services/projectDatabase');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canvasDocument() {
  return {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: 'project-a',
    canvasId: 'canvas-a',
    revision: 4,
    nodes: [
      { id: 'prompt-a', type: 'text', position: { x: 0, y: 0 }, data: { text: 'private prompt' } },
      { id: 'output-a', type: 'output', position: { x: 300, y: 0 }, data: {} },
    ],
    edges: [{ id: 'edge-a', source: 'prompt-a', target: 'output-a' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function createDatabase(overrides = {}) {
  const document = canvasDocument();
  const database = {
    getCanvas(canvasId) {
      return canvasId === document.canvasId ? clone(document) : null;
    },
    listAccessibleAssets() { return []; },
    countAccessibleAssets() { return 0; },
    listSubflowDefinitions() { return []; },
    getSubflowDefinition() { return null; },
    listRuns() { return []; },
    getRun() { return null; },
    listNodeRuns() { return []; },
    listAttempts() { return []; },
    getExecutionPolicy() { return null; },
    getExecutionUsage() { return null; },
    ...overrides,
  };
  return database;
}

// canvasAgentTools.js exports a factory, but also constructs the production router
// at module load. Replace only that default database dependency while loading the
// module so this route test never opens or migrates the developer's real database.
const inertDefaultDatabase = createDatabase();
const previousProjectDatabaseModule = require.cache[projectDatabaseModulePath];
require.cache[projectDatabaseModulePath] = {
  id: projectDatabaseModulePath,
  filename: projectDatabaseModulePath,
  loaded: true,
  exports: { getProjectDatabase: () => inertDefaultDatabase },
};
const { createCanvasAgentToolsRouter, MAX_AGENT_REQUEST_BYTES } = require(routeModulePath);
if (previousProjectDatabaseModule) require.cache[projectDatabaseModulePath] = previousProjectDatabaseModule;
else delete require.cache[projectDatabaseModulePath];

function agentRequest(tool, input = {}, overrides = {}) {
  return {
    tool,
    requestId: `request-${tool}`,
    projectId: 'project-a',
    canvasId: 'canvas-a',
    input,
    ...overrides,
  };
}

async function startRoute(database) {
  const app = express();
  // Keep this parser wider than the Agent limit so the router's independent,
  // serialized-body guard is exercised. server.js has its own 64 KiB pre-parser.
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use('/api/canvas-agent', createCanvasAgentToolsRouter({ database }));
  app.use((_req, res) => res.status(404).json({ success: false, error: 'not found' }));
  app.use((error, _req, res, _next) => res.status(400).json({
    success: false,
    code: error?.type === 'entity.too.large' ? 'agent_request_too_large' : 'agent_request_invalid',
    error: error?.type === 'entity.too.large' ? 'Agent 工具请求超过 64 KiB' : 'Agent 工具请求格式无效',
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/api/canvas-agent/tools`,
  };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

test('local Agent HTTP route returns bounded 200/400/403/404/409/413 contracts', async (t) => {
  const database = createDatabase();
  const { server, baseUrl } = await startRoute(database);
  t.after(() => closeServer(server));

  const ok = await postJson(baseUrl, agentRequest('inspectCanvas'));
  assert.equal(ok.response.status, 200);
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.data.schema, 't8-canvas-agent-tool-result-v1');
  assert.equal(ok.body.data.tool, 'inspectCanvas');
  assert.equal(ok.body.data.projectId, 'project-a');
  assert.equal(ok.body.data.canvasId, 'canvas-a');
  assert.equal(ok.body.data.canvasRevision, 4);
  assert.equal(ok.body.data.readOnly, true);
  assert.deepEqual(ok.body.data.authority, {
    advisoryOnly: false,
    canPreviewCanvasPatch: true,
    canApplyCanvasPatch: true,
    canManageHostCredentials: false,
    credentialVisibility: 'configured-state-only',
  });
  assert.match(ok.body.data.digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(ok.body), /private prompt/);

  const invalid = await postJson(baseUrl, { ...agentRequest('inspectCanvas'), unexpected: true });
  assert.equal(invalid.response.status, 400);
  assert.deepEqual(Object.keys(invalid.body).sort(), ['code', 'error', 'success']);
  assert.equal(invalid.body.code, 'agent_request_invalid');

  const forgedValidation = await postJson(baseUrl, agentRequest('inspectRun', {
    validationTrusted: true,
    validation: { tool: 'validateCanvas', projectId: 'project-a', canvasId: 'canvas-a', canvasRevision: 4 },
  }));
  assert.equal(forgedValidation.response.status, 400);
  assert.equal(forgedValidation.body.code, 'agent_request_invalid');

  const forbidden = await postJson(baseUrl, agentRequest('readFile'));
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.body.code, 'agent_tool_forbidden');
  assert.doesNotMatch(forbidden.body.error, /disk|filesystem|shell/i);

  const missing = await postJson(baseUrl, agentRequest('inspectCanvas', {}, { canvasId: 'canvas-missing' }));
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.code, 'agent_scope_not_found');
  assert.doesNotMatch(JSON.stringify(missing.body), /project-a|canvas-a/);

  const stale = await postJson(baseUrl, agentRequest('simulateExecutionPlan', {
    proposal: {
      schema: 't8-canvas-agent-execution-proposal-v1',
      baseRevision: 3,
      operations: [{ type: 'node.delete', nodeId: 'prompt-a' }],
    },
  }));
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, 'agent_snapshot_changed');
  assert.doesNotMatch(JSON.stringify(stale.body), /"nodes"|"edges"/);

  const oversized = await postJson(baseUrl, agentRequest('searchSubflows', { query: 'x'.repeat(MAX_AGENT_REQUEST_BYTES + 1) }));
  assert.equal(oversized.response.status, 413);
  assert.deepEqual(oversized.body, {
    success: false,
    code: 'agent_request_too_large',
    error: 'Agent 工具请求超过 64 KiB',
  });
});

test('local Agent HTTP route redacts unexpected internal errors and returns no stack or raw secret', async (t) => {
  const secret = 'sk-routeLeakSecret123456789';
  const database = createDatabase({
    listSubflowDefinitions() {
      throw new Error(`provider failed apiKey=${secret} at C:\\Users\\alice\\private.txt data:image/png;base64,${'A'.repeat(512)}`);
    },
  });
  const { server, baseUrl } = await startRoute(database);
  t.after(() => closeServer(server));

  const failed = await postJson(baseUrl, agentRequest('searchSubflows', { query: 'safe' }));
  assert.equal(failed.response.status, 400);
  assert.deepEqual(Object.keys(failed.body).sort(), ['code', 'error', 'success']);
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.code, 'agent_tool_failed');
  assert.ok(failed.body.error.length <= 500);
  assert.doesNotMatch(JSON.stringify(failed.body), /routeLeakSecret|C:\\Users|private\.txt|base64|AAAAAA|Error:|\n\s+at /);
  assert.match(failed.body.error, /\[redacted\]|\[local-path\]|\[binary\]/);
});

test('server mounts the strict 64 KiB Agent parser before the global 120 MiB parser', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'backend', 'src', 'server.js'), 'utf8');
  const importIndex = source.indexOf("require('./routes/canvasAgentTools')");
  const parserIndex = source.indexOf("const canvasAgentJsonParser = express.json({ limit: '64kb', strict: true });");
  const mountIndex = source.indexOf("app.use('/api/canvas-agent'");
  const broadParserIndex = source.indexOf("app.use(express.json({ limit: '120mb' }));");

  assert.ok(importIndex >= 0, 'server must import the Agent router');
  assert.ok(parserIndex > importIndex, 'dedicated Agent parser must be declared after the router import');
  assert.ok(mountIndex > parserIndex, 'dedicated Agent parser must guard the Agent mount');
  assert.ok(broadParserIndex > mountIndex, 'Agent mount must run before the global 120 MiB parser');
  assert.equal((source.match(/app\.use\('\/api\/canvas-agent'/g) || []).length, 1);

  const guardedMount = source.slice(mountIndex, broadParserIndex);
  assert.match(guardedMount, /content-length/);
  assert.match(guardedMount, /64 \* 1024/);
  assert.match(guardedMount, /canvasAgentJsonParser\(req, res/);
  assert.match(guardedMount, /error\?\.type === 'entity\.too\.large'/);
  assert.match(guardedMount, /agent_request_too_large/);
  assert.match(guardedMount, /agent_request_invalid/);
  assert.doesNotMatch(guardedMount, /error\?\.message|String\(error\)|error\.stack/);
});

test('collaboration Agent route is pre-parsed, authenticated, scope-forced, and read-only by construction', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'backend', 'src', 'collaboration', 'gateway.js'), 'utf8');
  const parserIndex = source.indexOf("const collaborationAgentJsonParser = express.json({ limit: '64kb', strict: true });");
  const broadParserIndex = source.indexOf("app.use(express.json({ limit: '2mb', strict: true }));");
  const authIndex = source.indexOf("app.use('/api/collab', this.requireSession.bind(this));");
  const routeIndex = source.indexOf("app.post('/api/collab/canvases/:canvasId/agent/tools'");
  const nextRouteIndex = source.indexOf("app.post('/api/collab/canvases/:canvasId/patches/preview'", routeIndex);

  assert.ok(parserIndex >= 0 && parserIndex < broadParserIndex, 'Agent parser must precede the collaboration-wide parser');
  assert.ok(broadParserIndex < authIndex && authIndex < routeIndex, 'session authentication must precede the Agent route');
  const parserBlock = source.slice(parserIndex, broadParserIndex);
  assert.match(parserBlock, /req\.method !== 'POST'/);
  assert.match(parserBlock, /\/agent\\\/tools/);
  assert.match(parserBlock, /MAX_CANVAS_AGENT_REQUEST_BYTES/);
  assert.match(parserBlock, /agent_request_too_large/);
  assert.match(parserBlock, /agent_request_invalid/);
  assert.doesNotMatch(parserBlock, /error\?\.message|String\(error\)|error\.stack/);

  assert.ok(nextRouteIndex > routeIndex, 'Agent route boundary must be discoverable');
  const route = source.slice(routeIndex, nextRouteIndex);
  assert.match(route, /ensureCanvasAccess\(req\.collaborationSession, req\.params\.canvasId\)/);
  assert.match(route, /projectId: req\.collaborationSession\.projectId/);
  assert.match(route, /canvasId: document\.canvasId/);
  assert.match(route, /actorId: req\.collaborationSession\.memberId/);
  assert.match(route, /sessionId: req\.collaborationSession\.id/);
  assert.match(route, /role: req\.collaborationSession\.role/);
  assert.match(route, /capabilities: req\.collaborationSession\.capabilities/);
  assert.match(route, /executeCanvasAgentTool\(this\.database/);
  assert.match(route, /sendCanvasPatchError\(res, error/);
  assert.match(route, /fallbackCode: 'agent_tool_failed'/);
  assert.doesNotMatch(route, /(?:apply|save|update|delete|restore|revert)Canvas|broadcast\(/);
});
