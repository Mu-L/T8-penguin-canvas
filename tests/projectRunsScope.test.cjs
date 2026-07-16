const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function installModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  const previous = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
  return () => {
    if (previous) require.cache[resolved] = previous;
    else delete require.cache[resolved];
  };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function requestJson(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('projectRuns HTTP boundary rejects the proven cross-Run Event and Attempt PATCH counterexamples', async (t) => {
  const runs = new Map([
    ['run-a', { id: 'run-a', projectId: 'project-a', canvasId: 'canvas-a' }],
    ['run-b', { id: 'run-b', projectId: 'project-a', canvasId: 'canvas-a' }],
  ]);
  const nodes = new Map([
    ['node-a', { id: 'node-a', runId: 'run-a', nodeId: 'image-a' }],
    ['node-b', { id: 'node-b', runId: 'run-b', nodeId: 'image-b' }],
  ]);
  const attempts = new Map([
    ['attempt-a', { id: 'attempt-a', nodeRunId: 'node-a', status: 'failed', timestamps: {}, usage: {}, metadata: {}, error: { kind: 'network' } }],
    ['attempt-b', { id: 'attempt-b', nodeRunId: 'node-b', status: 'failed', timestamps: {}, usage: {}, metadata: {}, error: { kind: 'network' } }],
  ]);
  const appendedEvents = [];
  const updatedAttempts = [];
  const database = {
    getRun: (id) => runs.get(String(id)) || null,
    getNodeRun: (id) => nodes.get(String(id)) || null,
    getAttempt: (id) => attempts.get(String(id)) || null,
    appendRunEvent(runId, event) {
      appendedEvents.push({ runId, event });
      return { id: appendedEvents.length, runId, ...event };
    },
    updateAttempt(id, patch, scope) {
      updatedAttempts.push({ id, patch, scope });
      return { ...attempts.get(id), ...patch };
    },
  };

  const restores = [
    installModuleMock('../backend/src/services/projectDatabase', { getProjectDatabase: () => database }),
    installModuleMock('../backend/src/services/assetPreviewPipeline', { getAssetPreviewPipeline: () => ({}) }),
    installModuleMock('../backend/src/services/assetIndexer', { getBackgroundAssetIndexer: () => ({ recordRunOutputAssets: async () => ({ nodeRun: {}, assets: [] }) }) }),
    installModuleMock('../backend/src/collaboration/gateway', { getCollaborationGateway: () => ({
      broadcastHostRunIntent() {}, broadcastHostRunState() {}, broadcastHostNodeRunState() {}, broadcastHostRunOutput() {},
    }) }),
    installModuleMock('../backend/src/services/runRecovery', { getRunRecoveryManager: () => ({ status: () => ({}), recoverPendingRuns: async () => ({}) }) }),
  ];
  const routePath = require.resolve('../backend/src/routes/projectRuns');
  const previousRoute = require.cache[routePath];
  delete require.cache[routePath];
  const router = require(routePath);
  restores.reverse().forEach((restore) => restore());
  if (previousRoute) require.cache[routePath] = previousRoute;
  else delete require.cache[routePath];

  const app = express();
  app.use(express.json({ strict: true }));
  app.use('/api/project-runs', router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => closeServer(server));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/project-runs`;

  const crossEvent = await requestJson(`${baseUrl}/run-a/events`, 'POST', {
    nodeRunId: 'node-b', type: 'node.failed', payload: { status: 'failed' },
  });
  assert.equal(crossEvent.response.status, 400);
  assert.match(crossEvent.body.error, /不属于当前 Run/);
  assert.equal(appendedEvents.length, 0);

  const crossAttempt = await requestJson(`${baseUrl}/run-a/nodes/node-b/attempts/attempt-b`, 'PATCH', {
    status: 'succeeded',
  });
  assert.equal(crossAttempt.response.status, 404);
  assert.equal(updatedAttempts.length, 0);
  assert.equal(attempts.get('attempt-b').status, 'failed');

  const validEvent = await requestJson(`${baseUrl}/run-a/events`, 'POST', {
    nodeRunId: 'node-a', type: 'node.failed', payload: { status: 'failed' },
  });
  assert.equal(validEvent.response.status, 201);
  assert.equal(appendedEvents.length, 1);
  assert.equal(appendedEvents[0].runId, 'run-a');
  assert.equal(appendedEvents[0].event.nodeRunId, 'node-a');

  const validAttempt = await requestJson(`${baseUrl}/run-a/nodes/node-a/attempts/attempt-a`, 'PATCH', {
    status: 'succeeded',
  });
  assert.equal(validAttempt.response.status, 200);
  assert.equal(updatedAttempts.length, 1);
  assert.deepEqual(updatedAttempts[0].scope, { runId: 'run-a', nodeRunId: 'node-a' });
});
