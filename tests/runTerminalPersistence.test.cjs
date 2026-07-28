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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('NodeRun creation, state transitions, and terminal evidence commit atomically with their events', async (t) => {
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

  const ambiguousNode = database.createNodeRun({
    runId: run.id,
    nodeId: 'provider-node-ambiguous',
    status: 'running',
  });
  const ambiguousAttempt = database.createAttempt({
    nodeRunId: ambiguousNode.id,
    provider: 'test',
    model: 'model-ambiguous',
    status: 'running',
    metadata: {
      providerSubmission: {
        version: 1,
        submissionKey: 'submission-ambiguous',
        expectedOutput: true,
        state: 'ambiguous',
      },
    },
  });
  const ambiguousTerminal = await patchJson(
    `${baseUrl}/${run.id}/nodes/${ambiguousNode.id}/attempts/${ambiguousAttempt.id}/terminal`,
    { status: 'succeeded' },
  );
  assert.equal(ambiguousTerminal.response.status, 409);
  assert.equal(ambiguousTerminal.body.code, 'provider_submission_not_verified');
  assert.equal(database.getNodeRun(ambiguousNode.id).status, 'running');
  assert.equal(database.getAttempt(ambiguousAttempt.id).status, 'running');

  const unlinkedNode = database.createNodeRun({
    runId: run.id,
    nodeId: 'provider-node-unlinked',
    status: 'running',
  });
  const unlinkedAttempt = database.createAttempt({
    nodeRunId: unlinkedNode.id,
    provider: 'test',
    model: 'model-unlinked',
    status: 'running',
    metadata: {
      providerSubmission: {
        version: 1,
        submissionKey: 'submission-unlinked',
        expectedOutput: true,
        state: 'verified',
      },
    },
  });
  const unlinkedTerminal = await patchJson(
    `${baseUrl}/${run.id}/nodes/${unlinkedNode.id}/attempts/${unlinkedAttempt.id}/terminal`,
    { status: 'succeeded' },
  );
  assert.equal(unlinkedTerminal.response.status, 409);
  assert.equal(unlinkedTerminal.body.code, 'provider_submission_output_missing');
  assert.equal(database.getNodeRun(unlinkedNode.id).status, 'running');
  assert.equal(database.getAttempt(unlinkedAttempt.id).status, 'running');

  const verifiedNode = database.createNodeRun({
    runId: run.id,
    nodeId: 'provider-node-verified',
    status: 'running',
    outputRefs: ['asset-verified'],
  }, { allowOutputRefs: true });
  const verifiedAttempt = database.createAttempt({
    nodeRunId: verifiedNode.id,
    provider: 'test',
    model: 'model-verified',
    status: 'running',
    metadata: {
      providerSubmission: {
        version: 1,
        submissionKey: 'submission-verified',
        expectedOutput: true,
        state: 'verified',
      },
    },
  });
  const verifiedTerminal = await patchJson(
    `${baseUrl}/${run.id}/nodes/${verifiedNode.id}/attempts/${verifiedAttempt.id}/terminal`,
    { status: 'succeeded' },
  );
  assert.equal(verifiedTerminal.response.status, 200);
  assert.equal(database.getNodeRun(verifiedNode.id).status, 'succeeded');
  assert.equal(database.getAttempt(verifiedAttempt.id).status, 'succeeded');

  const appendRunEvent = database.appendRunEvent.bind(database);
  database.appendRunEvent = (runId, event) => {
    if (event.nodeRunId === 'node-create-rollback' && event.type === 'node.queued') {
      throw new Error('forced queued event failure');
    }
    return appendRunEvent(runId, event);
  };
  const failedCreate = await postJson(`${baseUrl}/${run.id}/nodes`, {
    id: 'node-create-rollback',
    nodeId: 'provider-node-create-rollback',
    inputSnapshot: { prompt: 'must roll back' },
  });
  assert.equal(failedCreate.response.status, 400);
  assert.match(failedCreate.body.error, /forced queued event failure/);
  assert.equal(database.getNodeRun('node-create-rollback'), null);
  assert.equal(database.getRunEvents(run.id, 0).some((event) => event.nodeRunId === 'node-create-rollback'), false);

  database.appendRunEvent = appendRunEvent;
  const created = await postJson(`${baseUrl}/${run.id}/nodes`, {
    id: 'node-create-commit',
    nodeId: 'provider-node-create-commit',
    inputSnapshot: { prompt: 'commit atomically' },
  });
  assert.equal(created.response.status, 201);
  assert.equal(database.getNodeRun('node-create-commit').status, 'queued');
  assert.deepEqual(
    database.getRunEvents(run.id, 0).filter((event) => event.nodeRunId === 'node-create-commit').map((event) => event.type),
    ['node.queued'],
  );

  const transitionNode = database.createNodeRun({
    id: 'node-transition-rollback',
    runId: run.id,
    nodeId: 'provider-node-transition-rollback',
    status: 'queued',
  });
  database.appendRunEvent = (runId, event) => {
    if (event.nodeRunId === transitionNode.id && event.type === 'node.started') {
      throw new Error('forced transition event failure');
    }
    return appendRunEvent(runId, event);
  };
  const failedTransition = await patchJson(`${baseUrl}/${run.id}/nodes/${transitionNode.id}`, {
    status: 'running',
  });
  assert.equal(failedTransition.response.status, 400);
  assert.match(failedTransition.body.error, /forced transition event failure/);
  assert.equal(database.getNodeRun(transitionNode.id).status, 'queued');
  assert.equal(database.getNodeRun(transitionNode.id).revision, transitionNode.revision);
  assert.equal(database.getRunEvents(run.id, 0).some((event) => event.nodeRunId === transitionNode.id), false);
  database.appendRunEvent = appendRunEvent;

  const succeeded = await patchJson(
    `${baseUrl}/${run.id}/nodes/${nodeRun.id}/attempts/${attempt.id}/terminal`,
    {
      status: 'succeeded',
      timestamps: { finishedAt: 1234 },
      eventPayload: {
        executionToken: 'token-a',
        contextId: 'context-a',
        nodeId: 'forged-node',
        attemptId: 'forged-attempt',
        status: 'failed',
        outputRefs: ['forged-output-ref'],
      },
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
  assert.equal(terminalEvent.payload.nodeId, nodeRun.nodeId);
  assert.equal(terminalEvent.payload.attemptId, attempt.id);
  assert.equal(terminalEvent.payload.status, 'succeeded');
  assert.deepEqual(terminalEvent.payload.outputRefs, []);

  const rollbackNode = database.createNodeRun({ runId: run.id, nodeId: 'provider-node-rollback', status: 'running' });
  const rollbackAttempt = database.createAttempt({ nodeRunId: rollbackNode.id, provider: 'test', model: 'model-b', status: 'running' });
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
    const canvasId = `canvas-run-terminal-${suffix}`;
    database.ensureCanvas(canvasId, {
      name: `Run terminal ${suffix}`,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }, 'project-terminal');
    const linkedRun = database.createRun({
      projectId: 'project-terminal',
      canvasId,
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
