const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

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

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('NodeRun and Attempt terminal evidence commits atomically and rolls back with its event', async (t) => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  t.after(() => database.close());
  const run = database.createRun({ projectId: 'project-terminal', canvasId: 'canvas-terminal', status: 'running' });
  const nodeRun = database.createNodeRun({ runId: run.id, nodeId: 'provider-node', status: 'running' });
  const attempt = database.createAttempt({ nodeRunId: nodeRun.id, provider: 'test', model: 'model-a', status: 'running' });

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

  const succeeded = await patchJson(
    `${baseUrl}/${run.id}/nodes/${nodeRun.id}/attempts/${attempt.id}/terminal`,
    {
      status: 'succeeded',
      timestamps: { finishedAt: 1234 },
      eventPayload: { executionToken: 'token-a', contextId: 'context-a' },
    },
  );
  assert.equal(succeeded.response.status, 200);
  assert.equal(database.getNodeRun(nodeRun.id).status, 'succeeded');
  assert.equal(database.getAttempt(attempt.id).status, 'succeeded');
  assert.equal(database.getAttempt(attempt.id).timestamps.finishedAt, 1234);
  const terminalEvent = database.getRunEvents(run.id, 0).at(-1);
  assert.equal(terminalEvent.type, 'node.succeeded');
  assert.equal(terminalEvent.nodeRunId, nodeRun.id);
  assert.equal(terminalEvent.payload.attemptId, attempt.id);
  assert.equal(terminalEvent.payload.executionToken, '[redacted]');
  assert.equal(terminalEvent.payload.contextId, 'context-a');

  const rollbackNode = database.createNodeRun({ runId: run.id, nodeId: 'provider-node-rollback', status: 'running' });
  const rollbackAttempt = database.createAttempt({ nodeRunId: rollbackNode.id, provider: 'test', model: 'model-b', status: 'running' });
  const appendRunEvent = database.appendRunEvent.bind(database);
  database.appendRunEvent = (runId, event) => {
    if (event.nodeRunId === rollbackNode.id && event.type === 'node.failed') throw new Error('forced terminal event failure');
    return appendRunEvent(runId, event);
  };
  const failed = await patchJson(
    `${baseUrl}/${run.id}/nodes/${rollbackNode.id}/attempts/${rollbackAttempt.id}/terminal`,
    {
      status: 'failed',
      timestamps: { finishedAt: 5678 },
      error: { kind: 'network', message: 'upstream failed', retryable: true },
    },
  );
  assert.equal(failed.response.status, 400);
  assert.match(failed.body.error, /forced terminal event failure/);
  assert.equal(database.getNodeRun(rollbackNode.id).status, 'running');
  assert.equal(database.getAttempt(rollbackAttempt.id).status, 'running');
  assert.equal(database.getAttempt(rollbackAttempt.id).timestamps.finishedAt, undefined);
  assert.equal(database.getRunEvents(run.id, 0).some((event) => event.nodeRunId === rollbackNode.id), false);

  const createLinkedRunIntent = (suffix) => {
    const linkedRun = database.createRun({
      projectId: 'project-terminal',
      canvasId: `canvas-run-terminal-${suffix}`,
      canvasRevision: 1,
      status: 'running',
    });
    const intent = database.createRunIntent({
      projectId: linkedRun.projectId,
      canvasId: linkedRun.canvasId,
      canvasRevision: linkedRun.canvasRevision,
      idempotencyKey: `run-terminal-intent-${suffix}`,
      requestedBy: 'remote-editor',
      provider: 'image',
      model: 'gpt-image-2-all',
      estimatedCostKnown: false,
    });
    database.updateRunIntent(intent.id, { status: 'running', runId: linkedRun.id });
    return { run: linkedRun, intent: database.getRunIntent(intent.id) };
  };

  const eventRollback = createLinkedRunIntent('event-rollback');
  database.appendRunEvent = (runId, event) => {
    if (runId === eventRollback.run.id && event.type === 'run.succeeded') {
      throw new Error('forced Run terminal event failure');
    }
    return appendRunEvent(runId, event);
  };
  const failedRunEvent = await patchJson(`${baseUrl}/${eventRollback.run.id}`, {
    status: 'succeeded',
    finishedAt: 6789,
  });
  assert.equal(failedRunEvent.response.status, 400);
  assert.match(failedRunEvent.body.error, /forced Run terminal event failure/);
  assert.equal(database.getRun(eventRollback.run.id).status, 'running');
  assert.equal(database.getRun(eventRollback.run.id).finishedAt, null);
  assert.equal(database.getRunIntent(eventRollback.intent.id).status, 'running');
  assert.equal(database.getRunEvents(eventRollback.run.id, 0).length, 0);
  database.appendRunEvent = appendRunEvent;

  const finishRollback = createLinkedRunIntent('finish-rollback');
  const finishRunIntentForRun = database.finishRunIntentForRun.bind(database);
  database.finishRunIntentForRun = (runId, ...args) => {
    if (runId === finishRollback.run.id) throw new Error('forced RunIntent finish failure');
    return finishRunIntentForRun(runId, ...args);
  };
  const failedIntentFinish = await patchJson(`${baseUrl}/${finishRollback.run.id}`, {
    status: 'succeeded',
    finishedAt: 7890,
  });
  assert.equal(failedIntentFinish.response.status, 400);
  assert.match(failedIntentFinish.body.error, /forced RunIntent finish failure/);
  assert.equal(database.getRun(finishRollback.run.id).status, 'running');
  assert.equal(database.getRun(finishRollback.run.id).finishedAt, null);
  assert.equal(database.getRunIntent(finishRollback.intent.id).status, 'running');
  assert.equal(database.getRunEvents(finishRollback.run.id, 0).length, 0);
  database.finishRunIntentForRun = finishRunIntentForRun;

  const committed = createLinkedRunIntent('commit');
  const committedTerminal = await patchJson(`${baseUrl}/${committed.run.id}`, {
    status: 'succeeded',
    finishedAt: 8901,
  });
  assert.equal(committedTerminal.response.status, 200);
  assert.equal(database.getRun(committed.run.id).status, 'succeeded');
  assert.equal(database.getRun(committed.run.id).finishedAt, 8901);
  assert.equal(database.getRunIntent(committed.intent.id).status, 'completed');
  assert.deepEqual(
    database.getRunEvents(committed.run.id, 0).map((event) => event.type),
    ['run.succeeded'],
  );
});
