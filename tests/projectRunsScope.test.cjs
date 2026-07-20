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
  const writeOperations = [];
  const database = {
    getRun: (id) => runs.get(String(id)) || null,
    getNodeRun: (id) => nodes.get(String(id)) || null,
    getAttempt: (id) => attempts.get(String(id)) || null,
    withProjectDatabaseWrite(operation, callback) {
      writeOperations.push(operation);
      return callback(this);
    },
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
    nodeRunId: 'node-b', type: 'log', payload: { status: 'failed' },
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
    nodeRunId: 'node-a', type: 'log', payload: { status: 'failed' },
  });
  assert.equal(validEvent.response.status, 201);
  assert.equal(appendedEvents.length, 1);
  assert.equal(appendedEvents[0].runId, 'run-a');
  assert.equal(appendedEvents[0].event.nodeRunId, 'node-a');

  const forgedAuthorityEvent = await requestJson(`${baseUrl}/run-a/events`, 'POST', {
    nodeRunId: 'node-a', type: 'node.failed', payload: { status: 'failed' },
  });
  assert.equal(forgedAuthorityEvent.response.status, 409);
  assert.equal(forgedAuthorityEvent.body.code, 'run_event_authority_required');
  assert.equal(appendedEvents.length, 1);

  const validAttempt = await requestJson(`${baseUrl}/run-a/nodes/node-a/attempts/attempt-a`, 'PATCH', {
    status: 'succeeded',
  });
  assert.equal(validAttempt.response.status, 200);
  assert.equal(updatedAttempts.length, 1);
  assert.deepEqual(updatedAttempts[0].scope, { runId: 'run-a', nodeRunId: 'node-a' });
  assert.deepEqual(writeOperations, ['run.attempt-update']);
});

test('projectRuns revalidates Run, NodeRun, and Attempt authority inside each write transaction', async (t) => {
  const runs = new Map([
    ['run-a', { id: 'run-a', projectId: 'project-a', canvasId: 'canvas-a' }],
    ['run-b', { id: 'run-b', projectId: 'project-a', canvasId: 'canvas-a' }],
  ]);
  const nodes = new Map([
    ['node-a', { id: 'node-a', runId: 'run-a', nodeId: 'image-a', status: 'queued' }],
    ['node-b', { id: 'node-b', runId: 'run-b', nodeId: 'image-b', status: 'queued' }],
  ]);
  const attempts = new Map([
    ['attempt-a', {
      id: 'attempt-a',
      nodeRunId: 'node-a',
      status: 'failed',
      timestamps: {},
      usage: {},
      metadata: {},
      error: { kind: 'network' },
    }],
  ]);
  const writeOperations = [];
  const bottomWrites = [];
  const appendedEvents = [];
  const broadcasts = [];
  let beforeWrite = null;
  const database = {
    getRun: (id) => runs.get(String(id)) || null,
    getNodeRun: (id) => nodes.get(String(id)) || null,
    getAttempt: (id) => attempts.get(String(id)) || null,
    armBeforeWrite(hook) {
      assert.equal(beforeWrite, null, 'beforeWrite hook must be consumed exactly once');
      beforeWrite = hook;
    },
    withProjectDatabaseWrite(operation, callback) {
      writeOperations.push(operation);
      const hook = beforeWrite;
      beforeWrite = null;
      if (hook) hook();
      return callback(this);
    },
    createNodeRun(input) {
      bottomWrites.push({ method: 'createNodeRun', input });
      return input;
    },
    updateNodeRun(id, patch) {
      bottomWrites.push({ method: 'updateNodeRun', id, patch });
      return { ...nodes.get(id), ...patch };
    },
    createAttempt(input) {
      bottomWrites.push({ method: 'createAttempt', input });
      return input;
    },
    updateAttempt(id, patch, scope) {
      bottomWrites.push({ method: 'updateAttempt', id, patch, scope });
      return { ...attempts.get(id), ...patch };
    },
    appendRunEvent(runId, event) {
      appendedEvents.push({ runId, event });
      return { id: appendedEvents.length, runId, ...event };
    },
  };

  const restores = [
    installModuleMock('../backend/src/services/projectDatabase', { getProjectDatabase: () => database }),
    installModuleMock('../backend/src/services/assetPreviewPipeline', { getAssetPreviewPipeline: () => ({}) }),
    installModuleMock('../backend/src/services/assetIndexer', {
      getBackgroundAssetIndexer: () => ({ commitHostRunOutputAssets: async () => ({ nodeRun: {}, assets: [] }) }),
    }),
    installModuleMock('../backend/src/collaboration/gateway', {
      getCollaborationGateway: () => ({
        broadcastHostRunIntent(value) { broadcasts.push({ kind: 'intent', value }); },
        broadcastHostRunState(value) { broadcasts.push({ kind: 'run', value }); },
        broadcastHostNodeRunState(run, nodeRun) { broadcasts.push({ kind: 'node', run, nodeRun }); },
        broadcastHostRunOutput(run, nodeRun, assets) { broadcasts.push({ kind: 'output', run, nodeRun, assets }); },
      }),
    }),
    installModuleMock('../backend/src/services/runRecovery', {
      getRunRecoveryManager: () => ({ status: () => ({}), recoverPendingRuns: async () => ({}) }),
    }),
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

  database.armBeforeWrite(() => runs.delete('run-a'));
  const staleNodeCreate = await requestJson(`${baseUrl}/run-a/nodes`, 'POST', {
    id: 'node-created-after-stale-precheck',
    nodeId: 'image-new',
  });
  assert.equal(staleNodeCreate.response.status, 400, JSON.stringify(staleNodeCreate.body));
  assert.match(staleNodeCreate.body.error, /运行记录不存在/);
  assert.deepEqual(writeOperations, ['run.node-create']);
  runs.set('run-a', { id: 'run-a', projectId: 'project-a', canvasId: 'canvas-a' });

  database.armBeforeWrite(() => {
    nodes.set('node-a', { ...nodes.get('node-a'), runId: 'run-b' });
  });
  const staleNodeUpdate = await requestJson(`${baseUrl}/run-a/nodes/node-a`, 'PATCH', {
    status: 'running',
  });
  assert.equal(staleNodeUpdate.response.status, 400, JSON.stringify(staleNodeUpdate.body));
  assert.match(staleNodeUpdate.body.error, /不属于当前 Run/);
  assert.deepEqual(writeOperations, ['run.node-create', 'run.node-update']);
  nodes.set('node-a', { ...nodes.get('node-a'), runId: 'run-a' });

  database.armBeforeWrite(() => {
    nodes.set('node-a', { ...nodes.get('node-a'), runId: 'run-b' });
  });
  const staleAttemptCreate = await requestJson(`${baseUrl}/run-a/nodes/node-a/attempts`, 'POST', {
    id: 'attempt-created-after-stale-precheck',
    status: 'running',
  });
  assert.equal(staleAttemptCreate.response.status, 400, JSON.stringify(staleAttemptCreate.body));
  assert.match(staleAttemptCreate.body.error, /不属于当前 Run/);
  assert.deepEqual(writeOperations, ['run.node-create', 'run.node-update', 'run.attempt-create']);
  nodes.set('node-a', { ...nodes.get('node-a'), runId: 'run-a' });

  database.armBeforeWrite(() => {
    attempts.set('attempt-a', { ...attempts.get('attempt-a'), nodeRunId: 'node-b' });
  });
  const staleAttemptUpdate = await requestJson(
    `${baseUrl}/run-a/nodes/node-a/attempts/attempt-a`,
    'PATCH',
    { status: 'succeeded' },
  );
  assert.equal(staleAttemptUpdate.response.status, 400, JSON.stringify(staleAttemptUpdate.body));
  assert.match(staleAttemptUpdate.body.error, /Attempt 不属于当前 Run\/NodeRun/);
  assert.deepEqual(writeOperations, [
    'run.node-create',
    'run.node-update',
    'run.attempt-create',
    'run.attempt-update',
  ]);

  assert.equal(beforeWrite, null, 'every beforeWrite hook must be consumed by its coordinator');
  assert.deepEqual(bottomWrites, []);
  assert.deepEqual(appendedEvents, []);
  assert.deepEqual(broadcasts, []);
});
