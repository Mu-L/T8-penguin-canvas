const assert = require('node:assert/strict');
const test = require('node:test');
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

async function request(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('private run-output route gates loopback JSON, keeps only materialization hints, avoids bypass writes, and redacts failures', async (t) => {
  const run = { id: 'run-a', projectId: 'project-a', canvasId: 'canvas-a', revision: 1 };
  const nodeRun = {
    id: 'node-run-a',
    runId: run.id,
    nodeId: 'node-display-a',
    nodeEntityUid: 'a1000000-0000-4000-8000-000000000001',
    outputRefs: [],
    revision: 1,
  };
  const committedNodeRun = { ...nodeRun, outputRefs: ['run-output-a'], revision: 2 };
  const asset = {
    id: 'run-output-a',
    entityUid: 'a2000000-0000-4000-8000-000000000001',
    projectId: run.projectId,
    contentHash: 'a'.repeat(64),
    kind: 'text',
    mimeType: 'text/plain',
    filename: 'actual.txt',
    managedPath: 'C:\\Users\\victim\\private-cas\\blob',
    sourceUrl: '/api/project-assets/run-output-a/media',
    storageMode: 'managed',
    availability: 'available',
    metadata: {
      size: 3,
      sourcePath: 'C:\\Users\\victim\\source.txt',
      apiKey: 'must-not-leak',
      health: 'ok',
    },
    provenance: { source: 'host-authoritative-run-output' },
    tags: [],
    collectionIds: [],
    createdBy: 'host-executor',
    createdAt: 1,
    updatedAt: 1,
  };
  const commitCalls = [];
  const broadcasts = { node: [], output: [] };
  let appendedEvents = 0;
  const database = {
    getRun: (id) => String(id) === run.id ? run : null,
    getNodeRun: (id) => String(id) === nodeRun.id ? nodeRun : null,
    appendRunEvent() {
      appendedEvents += 1;
      throw new Error('private host artifact route must not append a second event');
    },
  };
  const indexer = {
    recordRunOutputAssets: async () => {
      throw new Error('legacy two-write output ingestion must not be used');
    },
    async commitHostRunOutputAssets(input) {
      commitCalls.push(input);
      if (input.outputs[0]?.sourceUrl === '/files/output/fail.txt') {
        const error = new Error('C:\\Users\\victim\\secret.txt could not be committed');
        error.code = 'host_artifact_output_slot_conflict';
        error.status = 409;
        throw error;
      }
      return {
        duplicate: commitCalls.length > 1,
        run: { ...run, revision: 2 },
        nodeRun: committedNodeRun,
        assets: [asset],
        results: [{ assetId: asset.id, artifactUid: asset.entityUid }],
      };
    },
  };
  const gateway = {
    broadcastHostRunIntent() {},
    broadcastHostRunState() {},
    broadcastHostNodeRunState(...args) { broadcasts.node.push(args); },
    broadcastHostRunOutput(...args) { broadcasts.output.push(args); },
  };

  const restores = [
    installModuleMock('../backend/src/services/projectDatabase', { getProjectDatabase: () => database }),
    installModuleMock('../backend/src/services/assetPreviewPipeline', { getAssetPreviewPipeline: () => ({}) }),
    installModuleMock('../backend/src/services/assetIndexer', { getBackgroundAssetIndexer: () => indexer }),
    installModuleMock('../backend/src/collaboration/gateway', { getCollaborationGateway: () => gateway }),
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
  const endpoint = `http://127.0.0.1:${server.address().port}/api/project-runs/run-a/nodes/node-run-a/outputs`;
  const forgedBody = {
    attemptId: 'attempt-a',
    actorId: 'forged-actor',
    sessionId: 'forged-session',
    eventPayload: { sourcePath: 'C:\\Users\\victim\\event.txt' },
    outputs: [{
      sourceUrl: '/files/output/actual.txt',
      outputOrdinal: 7,
      actorId: 'forged-output-actor',
      sessionId: 'forged-output-session',
      filename: '../forged.png',
      kind: 'image',
      mimeType: 'image/png',
      contentHash: 'f'.repeat(64),
      managedPath: 'C:\\Users\\victim\\secret.txt',
      storageKey: '../../secret',
    }],
  };

  const first = await request(endpoint, forgedBody);
  assert.equal(first.response.status, 201);
  assert.equal(first.body.data.duplicate, false);
  const { signal: commitSignal, ...commitCall } = commitCalls[0];
  assert.equal(commitSignal instanceof AbortSignal, true);
  assert.deepEqual(commitCall, {
    runId: run.id,
    nodeRunId: nodeRun.id,
    attemptId: 'attempt-a',
    outputs: [{
      sourceUrl: '/files/output/actual.txt',
      kind: 'image',
      filename: '../forged.png',
      mimeType: 'image/png',
      outputOrdinal: 7,
    }],
  });
  assert.equal(appendedEvents, 0);

  const bypass = await fetch(`http://127.0.0.1:${server.address().port}/api/project-runs/run-a/nodes/node-run-a`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outputRefs: ['forged-output-ref'] }),
  });
  const bypassBody = await bypass.json();
  assert.equal(bypass.status, 409);
  assert.equal(bypassBody.code, 'host_artifact_authority_required');
  assert.equal(appendedEvents, 0);

  const createBypass = await request(
    `http://127.0.0.1:${server.address().port}/api/project-runs/run-a/nodes`,
    { nodeId: 'forged-node', outputRefs: ['forged-output-ref'] },
  );
  assert.equal(createBypass.response.status, 409);
  assert.equal(createBypass.body.code, 'host_artifact_authority_required');
  assert.equal(appendedEvents, 0);

  const eventBypass = await request(
    `http://127.0.0.1:${server.address().port}/api/project-runs/run-a/events`,
    { nodeRunId: nodeRun.id, type: 'node.output', payload: { outputRefs: ['forged-output-ref'] } },
  );
  assert.equal(eventBypass.response.status, 409);
  assert.equal(eventBypass.body.code, 'run_event_authority_required');
  assert.equal(appendedEvents, 0);
  assert.equal(broadcasts.node.length, 1);
  assert.equal(broadcasts.output.length, 1);
  const publicResponse = JSON.stringify(first.body);
  assert.doesNotMatch(publicResponse, /victim|private-cas|sourcePath|apiKey|must-not-leak|forged/i);

  const replay = await request(endpoint, forgedBody);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.data.duplicate, true);
  assert.equal(commitCalls.length, 2);
  assert.equal(broadcasts.node.length, 1);
  assert.equal(broadcasts.output.length, 1);
  assert.equal(appendedEvents, 0);

  const untrusted = await request(endpoint, forgedBody, { origin: 'https://evil.example' });
  assert.equal(untrusted.response.status, 403);
  assert.equal(untrusted.body.code, 'trusted_loopback_required');
  assert.equal(commitCalls.length, 2);

  const wrongContentType = await request(endpoint, JSON.stringify(forgedBody), { 'content-type': 'text/plain' });
  assert.equal(wrongContentType.response.status, 415);
  assert.equal(wrongContentType.body.code, 'host_artifact_json_required');
  assert.equal(commitCalls.length, 2);

  const failed = await request(endpoint, {
    attemptId: 'attempt-a',
    outputs: [{ sourceUrl: '/files/output/fail.txt', outputOrdinal: 8 }],
  });
  assert.equal(failed.response.status, 409);
  assert.equal(failed.body.code, 'host_artifact_output_slot_conflict');
  assert.doesNotMatch(JSON.stringify(failed.body), /[A-Za-z]:\\|victim|secret\.txt/i);
  assert.equal(broadcasts.node.length, 1);
  assert.equal(broadcasts.output.length, 1);
  assert.equal(appendedEvents, 0);
});
