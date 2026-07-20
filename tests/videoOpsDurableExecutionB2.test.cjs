const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const videoOpsRouter = require('../backend/src/routes/videoOps');

function listenVideoOps(options = {}) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  if (typeof options.trackApplicationTask === 'function') {
    app.use((_req, res, next) => {
      res.locals.trackApplicationTask = options.trackApplicationTask;
      next();
    });
  }
  app.use('/api/video-ops', videoOpsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function delay(ms = 25) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function legacyAsyncBody(extra = {}) {
  return {
    async: true,
    clips: [{ id: 'clip-local', url: '/files/input/local.mp4', trimStart: 0, trimEnd: 1 }],
    settings: { aspect: '16:9', resolution: '720p', transition: 'none', audio: 'mute' },
    ...extra,
  };
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function createExecutionFixture(database, suffix) {
  const input = {
    schema: 't8-video-edit-execution-input-v1',
    mode: 'compose',
    clips: [{ id: `clip-${suffix}`, url: `/files/${suffix}.mp4`, trimStart: 0, trimEnd: 1 }],
    settings: { aspect: '16:9' },
    timelineV2: { version: 2, assets: [], tracks: [] },
    renderPlan: { version: 1, videoSegments: [] },
    packageIds: [],
    operationSettings: [{ aspect: '16:9' }],
  };
  const inputDigest = `sha256:${crypto.createHash('sha256').update(stableJson(input), 'utf8').digest('hex')}`;
  const actionDigest = `fnv1a32:${crypto.createHash('sha256').update(String(suffix)).digest('hex').slice(0, 8)}`;
  const requestId = `video-edit-request-${suffix}`;
  database.ensureCanvas(`canvas-${suffix}`, {
    projectId: `project-${suffix}`,
    nodes: [],
    edges: [],
  }, `project-${suffix}`);
  const run = database.createRun({
    id: `run-${suffix}`,
    projectId: `project-${suffix}`,
    canvasId: `canvas-${suffix}`,
    canvasRevision: 1,
    status: 'running',
    summary: {
      runRequestId: requestId,
      plannedNodeIds: [`node-${suffix}`],
      authorizedNodeIds: [`node-${suffix}`],
      secondaryProviderActionId: 'video-edit.compose',
      secondaryProviderActionTarget: 'compose',
      secondaryProviderActionDigest: actionDigest,
      secondaryProviderActionInputDigest: inputDigest,
    },
  });
  const nodeRun = database.createNodeRun({
    id: `node-run-${suffix}`,
    runId: run.id,
    nodeId: `node-${suffix}`,
    status: 'running',
  });
  const attempt = database.createAttempt({
    id: `attempt-${suffix}`,
    nodeRunId: nodeRun.id,
    status: 'running',
  });
  const evidence = {
    schema: 't8-video-operation-execution-v1',
    projectId: run.projectId,
    canvasId: run.canvasId,
    runId: run.id,
    nodeRunId: nodeRun.id,
    attemptId: attempt.id,
    nodeId: nodeRun.nodeId,
    requestId,
    actionId: 'video-edit.compose',
    actionTarget: 'compose',
    actionDigest,
    inputDigest,
    operationIndex: 0,
  };
  return {
    input,
    evidence,
    run,
    nodeRun,
    attempt,
    requestBody: {
      async: true,
      clips: input.clips,
      settings: input.operationSettings[0],
      timelineV2: input.timelineV2,
      renderPlan: input.renderPlan,
      executionInput: input,
      executionEvidence: evidence,
    },
  };
}

function createOperationFixture(database, suffix, action, rawBody) {
  const binding = videoOpsRouter._test.buildVideoOperationBinding(action, rawBody);
  const input = binding.executionInput;
  const inputDigest = `sha256:${crypto.createHash('sha256').update(stableJson(input), 'utf8').digest('hex')}`;
  const actionDigest = `fnv1a32:${crypto.createHash('sha256').update(`${action}:${suffix}`).digest('hex').slice(0, 8)}`;
  const requestId = `video-edit-request-${action}-${suffix}`;
  const nodeId = `node-${action}-${suffix}`;
  database.ensureCanvas(`canvas-${suffix}`, {
    projectId: `project-${suffix}`,
    nodes: [],
    edges: [],
  }, `project-${suffix}`);
  const run = database.createRun({
    id: `run-${action}-${suffix}`,
    projectId: `project-${suffix}`,
    canvasId: `canvas-${suffix}`,
    canvasRevision: 1,
    status: 'running',
    summary: {
      runRequestId: requestId,
      plannedNodeIds: [nodeId],
      authorizedNodeIds: [nodeId],
      secondaryProviderActionId: `video-edit.${action}`,
      secondaryProviderActionTarget: action,
      secondaryProviderActionDigest: actionDigest,
      secondaryProviderActionInputDigest: inputDigest,
    },
  });
  const nodeRun = database.createNodeRun({
    id: `node-run-${action}-${suffix}`,
    runId: run.id,
    nodeId,
    status: 'running',
    inputSnapshot: input,
  });
  const attempt = database.createAttempt({
    id: `attempt-${action}-${suffix}`,
    nodeRunId: nodeRun.id,
    status: 'running',
  });
  const evidence = {
    schema: 't8-video-operation-execution-v1',
    projectId: run.projectId,
    canvasId: run.canvasId,
    runId: run.id,
    nodeRunId: nodeRun.id,
    attemptId: attempt.id,
    nodeId,
    requestId,
    actionId: `video-edit.${action}`,
    actionTarget: action,
    actionDigest,
    inputDigest,
    operationIndex: 0,
  };
  const operationBody = action === 'snapshot'
    ? {
        clip: binding.clip,
        time: binding.time,
        format: binding.format,
        sourceLabel: binding.sourceLabel,
      }
    : {
        clips: binding.clips,
        settings: binding.settings,
        timelineV2: binding.timelineV2,
        renderPlan: binding.renderPlan,
        mode: binding.mode,
      };
  return {
    binding,
    input,
    evidence,
    run,
    nodeRun,
    attempt,
    requestBody: {
      ...operationBody,
      executionInput: input,
      executionEvidence: evidence,
    },
  };
}

async function postJson(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}/api/video-ops/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('videoOps bridges jobs to durable Run evidence and reconstructs restart outcomes', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const input = {
    schema: 't8-video-edit-execution-input-v1',
    mode: 'compose',
    clips: [{ id: 'clip-a', url: '/files/a.mp4', trimStart: 0, trimEnd: 1 }],
    settings: { aspect: '16:9' },
    timelineV2: { version: 2, assets: [], tracks: [] },
    renderPlan: { version: 1, videoSegments: [] },
    packageIds: [],
    operationSettings: [{ aspect: '16:9' }],
  };
  const inputDigest = `sha256:${crypto.createHash('sha256').update(stableJson(input), 'utf8').digest('hex')}`;
  const actionDigest = 'fnv1a32:1234abcd';
  const requestId = 'video-edit-request-0001';
  database.ensureCanvas('canvas-video-b2', {
    projectId: 'project-video-b2',
    nodes: [],
    edges: [],
  }, 'project-video-b2');
  const run = database.createRun({
    id: 'run-video-b2',
    projectId: 'project-video-b2',
    canvasId: 'canvas-video-b2',
    canvasRevision: 1,
    status: 'running',
    summary: {
      runRequestId: requestId,
      plannedNodeIds: ['video-node-b2'],
      authorizedNodeIds: ['video-node-b2'],
      secondaryProviderActionId: 'video-edit.compose',
      secondaryProviderActionTarget: 'compose',
      secondaryProviderActionDigest: actionDigest,
      secondaryProviderActionInputDigest: inputDigest,
    },
  });
  const nodeRun = database.createNodeRun({ id: 'node-run-video-b2', runId: run.id, nodeId: 'video-node-b2', status: 'running' });
  const attempt = database.createAttempt({ id: 'attempt-video-b2', nodeRunId: nodeRun.id, status: 'running' });
  const evidence = {
    schema: 't8-video-operation-execution-v1',
    projectId: run.projectId,
    canvasId: run.canvasId,
    runId: run.id,
    nodeRunId: nodeRun.id,
    attemptId: attempt.id,
    nodeId: nodeRun.nodeId,
    requestId,
    actionId: 'video-edit.compose',
    actionTarget: 'compose',
    actionDigest,
    inputDigest,
    operationIndex: 0,
  };

  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.clearJobsForTests();
  try {
    const bound = videoOpsRouter._test.validateVideoOperationInputBinding({
      clips: input.clips,
      settings: input.operationSettings[0],
      timelineV2: input.timelineV2,
      renderPlan: input.renderPlan,
      executionInput: input,
    }, evidence);
    assert.equal(bound.inputDigest, inputDigest);
    assert.throws(() => videoOpsRouter._test.validateVideoOperationInputBinding({
      clips: [{ ...input.clips[0], trimEnd: 0.5 }],
      settings: input.operationSettings[0],
      timelineV2: input.timelineV2,
      renderPlan: input.renderPlan,
      executionInput: input,
    }, evidence), /实际合成参数/);

    const completed = videoOpsRouter._test.makeJob('compose', evidence, { requireExecutionEvidence: true });
    assert.equal(videoOpsRouter._test.readDurableVideoOperationEvents(completed.id)[0].payload.phase, 'accepted');
    videoOpsRouter._test.finishJob(completed, '合成完成', {
      jobId: completed.id,
      videoUrl: '/files/output/final.mp4',
      fileName: 'final.mp4',
    });
    videoOpsRouter._test.clearJobsForTests();
    const restoredCompleted = videoOpsRouter._test.reconstructDurableVideoOperationJob(completed.id);
    assert.equal(restoredCompleted.status, 'done');
    assert.equal(restoredCompleted.result.videoUrl, '/files/output/final.mp4');

    const acceptedFixture = createExecutionFixture(database, 'accepted-only');
    const acceptedOnly = videoOpsRouter._test.makeJob('compose', acceptedFixture.evidence, { requireExecutionEvidence: true });
    videoOpsRouter._test.clearJobsForTests();
    const restoredInterrupted = videoOpsRouter._test.reconstructDurableVideoOperationJob(acceptedOnly.id);
    assert.equal(restoredInterrupted.status, 'interrupted');
    assert.match(restoredInterrupted.error, /重启后中断/);
    const interruptedEvents = videoOpsRouter._test.readDurableVideoOperationEvents(acceptedOnly.id);
    assert.equal(interruptedEvents.at(-1).payload.phase, 'interrupted');
    assert.equal(videoOpsRouter._test.reconstructDurableVideoOperationJob(acceptedOnly.id).status, 'interrupted');

    assert.throws(() => videoOpsRouter._test.makeJob('compose', { ...evidence, attemptId: 'forged-attempt' }, {
      requireExecutionEvidence: true,
    }), /不存在/);
  } finally {
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('exact execution evidence retries reuse one durable job before and after restart without a second schedule', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const fixture = createExecutionFixture(database, 'exact-retry');
  let executorCalls = 0;
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.setAsyncComposeExecutorForTests(async (_clips, _settings, job) => {
    executorCalls += 1;
    videoOpsRouter._test.finishJob(job, 'exact retry result', {
      jobId: job.id,
      videoUrl: '/files/output/exact-retry.mp4',
      fileName: 'exact-retry.mp4',
    });
  });
  videoOpsRouter._test.clearJobsForTests();
  const { server, baseUrl } = await listenVideoOps();
  const submit = async () => {
    const response = await fetch(`${baseUrl}/api/video-ops/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture.requestBody),
    });
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };
  try {
    const first = await submit();
    await delay(50);
    const ambiguousRetry = await submit();
    assert.equal(ambiguousRetry.id, first.id);
    assert.equal(ambiguousRetry.status, 'done');
    assert.equal(executorCalls, 1);
    assert.equal(videoOpsRouter._test.jobCountForTests(), 1);
    assert.equal(
      database.getRunEvents(fixture.run.id).filter((event) => event.payload?.phase === 'accepted').length,
      1,
    );
    assert.equal(database.getAttempt(fixture.attempt.id).upstreamTaskId, first.id);

    videoOpsRouter._test.clearJobsForTests();
    const restartRetry = await submit();
    assert.equal(restartRetry.id, first.id);
    assert.equal(restartRetry.status, 'done');
    assert.equal(restartRetry.result.videoUrl, '/files/output/exact-retry.mp4');
    assert.equal(executorCalls, 1);
    assert.equal(database.getAttempt(fixture.attempt.id).upstreamTaskId, first.id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetAsyncComposeExecutorForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('async compose registers the scheduler promise with the host application lifecycle', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const fixture = createExecutionFixture(database, 'tracked-task');
  let releaseExecutor;
  const executorGate = new Promise((resolve) => { releaseExecutor = resolve; });
  let resolveExecutorStarted;
  const executorStarted = new Promise((resolve) => { resolveExecutorStarted = resolve; });
  let trackedTask = null;
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.setAsyncComposeExecutorForTests(async (_clips, _settings, job) => {
    resolveExecutorStarted();
    await executorGate;
    videoOpsRouter._test.finishJob(job, 'tracked result', {
      jobId: job.id,
      videoUrl: '/files/output/tracked-task.mp4',
      fileName: 'tracked-task.mp4',
    });
  });
  videoOpsRouter._test.clearJobsForTests();
  const { server, baseUrl } = await listenVideoOps({
    trackApplicationTask(task) { trackedTask = task; },
  });
  try {
    const response = await fetch(`${baseUrl}/api/video-ops/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture.requestBody),
    });
    assert.equal(response.status, 200);
    await response.json();
    await executorStarted;
    assert.equal(typeof trackedTask?.then, 'function');
    let settled = false;
    trackedTask.then(() => { settled = true; });
    await delay(20);
    assert.equal(settled, false, 'tracked task must represent the full detached executor lifetime');
    releaseExecutor();
    await trackedTask;
    assert.equal(settled, true);
  } finally {
    releaseExecutor();
    await trackedTask;
    await new Promise((resolve) => server.close(resolve));
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetAsyncComposeExecutorForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('sync exact retries return the durable success, running, or failure state without executing again', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.clearJobsForTests();
  const successFixture = createExecutionFixture(database, 'sync-success');
  const runningFixture = createExecutionFixture(database, 'sync-running');
  const failedFixture = createExecutionFixture(database, 'sync-failed');
  const successJob = videoOpsRouter._test.makeJob('compose', successFixture.evidence, { requireExecutionEvidence: true });
  videoOpsRouter._test.finishJob(successJob, 'persisted sync success', {
    jobId: successJob.id,
    videoUrl: '/files/output/persisted-sync.mp4',
    fileName: 'persisted-sync.mp4',
  });
  const runningJob = videoOpsRouter._test.makeJob('compose', runningFixture.evidence, { requireExecutionEvidence: true });
  const failedJob = videoOpsRouter._test.makeJob('compose', failedFixture.evidence, { requireExecutionEvidence: true });
  videoOpsRouter._test.failJob(failedJob, new Error('persisted sync failure'));
  const { server, baseUrl } = await listenVideoOps();
  const submit = async (fixture) => {
    const response = await fetch(`${baseUrl}/api/video-ops/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...fixture.requestBody, async: false }),
    });
    return { response, body: await response.json() };
  };
  try {
    const succeeded = await submit(successFixture);
    assert.equal(succeeded.response.status, 200);
    assert.equal(succeeded.body.data.videoUrl, '/files/output/persisted-sync.mp4');
    assert.equal(succeeded.body.job.id, successJob.id);

    const running = await submit(runningFixture);
    assert.equal(running.response.status, 202);
    assert.equal(running.body.data.id, runningJob.id);
    assert.equal(running.body.data.status, 'running');

    const failed = await submit(failedFixture);
    assert.equal(failed.response.status, 500);
    assert.equal(failed.body.success, false);
    assert.equal(failed.body.job.id, failedJob.id);
    assert.match(failed.body.error, /persisted sync failure/);

    for (const fixture of [successFixture, runningFixture, failedFixture]) {
      assert.equal(
        database.getRunEvents(fixture.run.id).filter((event) => event.payload?.phase === 'accepted').length,
        1,
      );
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('a conflicting durable event in the same Attempt operation slot fails closed', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const fixture = createExecutionFixture(database, 'slot-collision');
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.clearJobsForTests();
  try {
    database.appendRunEvent(fixture.run.id, {
      nodeRunId: fixture.nodeRun.id,
      type: 'log',
      payload: {
        schema: 't8-video-operation-run-evidence-v1',
        phase: 'accepted',
        videoOperation: {
          jobId: 'colliding-job',
          action: 'compose',
          status: 'running',
          executionEvidence: {
            ...fixture.evidence,
            inputDigest: `sha256:${'0'.repeat(64)}`,
          },
        },
      },
    });
    assert.throws(
      () => videoOpsRouter._test.makeJob('compose', fixture.evidence, { requireExecutionEvidence: true }),
      (error) => error?.code === 'video_operation_execution_conflict'
        && error?.statusCode === 409,
    );
    assert.equal(videoOpsRouter._test.jobCountForTests(), 0);
    assert.equal(database.getAttempt(fixture.attempt.id).upstreamTaskId, null);
  } finally {
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('legacy async compatibility never falls back from partial or forged execution evidence', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  let executorCalls = 0;
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.setAsyncComposeExecutorForTests(async () => { executorCalls += 1; });
  videoOpsRouter._test.clearJobsForTests();
  const { server, baseUrl } = await listenVideoOps();
  try {
    const partialEvidence = await fetch(`${baseUrl}/api/video-ops/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(legacyAsyncBody({ executionEvidence: {} })),
    });
    assert.equal(partialEvidence.status, 400);

    const partialInput = await fetch(`${baseUrl}/api/video-ops/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(legacyAsyncBody({
        executionInput: { schema: 't8-video-edit-execution-input-v1' },
      })),
    });
    assert.equal(partialInput.status, 400);
    await delay();

    assert.equal(executorCalls, 0);
    assert.equal(videoOpsRouter._test.jobCountForTests(), 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM runs').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM node_runs').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM run_attempts').get().count, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetAsyncComposeExecutorForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('synthetic compatibility transaction failure rolls back the trio and invokes ffmpeg zero times', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const originalCreateAttempt = database.createAttempt.bind(database);
  let executorCalls = 0;
  database.createAttempt = () => { throw new Error('injected attempt persistence failure'); };
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.setAsyncComposeExecutorForTests(async () => { executorCalls += 1; });
  videoOpsRouter._test.clearJobsForTests();
  const { server, baseUrl } = await listenVideoOps();
  try {
    const response = await fetch(`${baseUrl}/api/video-ops/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(legacyAsyncBody()),
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.match(body.error, /原子建立.*Run\/NodeRun\/Attempt.*停止 ffmpeg/);
    await delay();

    assert.equal(executorCalls, 0);
    assert.equal(videoOpsRouter._test.jobCountForTests(), 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM runs').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM node_runs').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM run_attempts').get().count, 0);
  } finally {
    database.createAttempt = originalCreateAttempt;
    await new Promise((resolve) => server.close(resolve));
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetAsyncComposeExecutorForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('synthetic enqueue evidence failure invokes ffmpeg zero times and terminalizes the persisted trio', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const originalAppendRunEvent = database.appendRunEvent.bind(database);
  let failAcceptedOnce = true;
  let executorCalls = 0;
  database.appendRunEvent = (runId, event) => {
    if (failAcceptedOnce && event?.payload?.phase === 'accepted') {
      failAcceptedOnce = false;
      throw new Error('injected accepted event failure');
    }
    return originalAppendRunEvent(runId, event);
  };
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.setAsyncComposeExecutorForTests(async () => { executorCalls += 1; });
  videoOpsRouter._test.clearJobsForTests();
  const { server, baseUrl } = await listenVideoOps();
  try {
    const response = await fetch(`${baseUrl}/api/video-ops/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(legacyAsyncBody()),
    });
    assert.equal(response.status, 503);
    await delay();

    assert.equal(executorCalls, 0);
    assert.equal(videoOpsRouter._test.jobCountForTests(), 0);
    const run = database.db.prepare('SELECT id, status FROM runs').get();
    const nodeRun = database.db.prepare('SELECT id, run_id, status FROM node_runs').get();
    const attempt = database.db.prepare('SELECT node_run_id, status FROM run_attempts').get();
    assert.equal(run.status, 'failed');
    assert.equal(nodeRun.run_id, run.id);
    assert.equal(nodeRun.status, 'failed');
    assert.equal(attempt.node_run_id, nodeRun.id);
    assert.equal(attempt.status, 'failed');
  } finally {
    database.appendRunEvent = originalAppendRunEvent;
    await new Promise((resolve) => server.close(resolve));
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetAsyncComposeExecutorForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('synthetic terminal evidence failure fails closed and terminalizes Run NodeRun and Attempt', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const originalAppendRunEvent = database.appendRunEvent.bind(database);
  database.appendRunEvent = (runId, event) => {
    if (event?.payload?.phase === 'terminal') throw new Error('injected terminal event failure');
    return originalAppendRunEvent(runId, event);
  };
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.setAsyncComposeExecutorForTests(async (_clips, _settings, job) => {
    videoOpsRouter._test.finishJob(job, 'fake compose complete', {
      jobId: job.id,
      videoUrl: '/files/output/should-not-be-claimed.mp4',
      fileName: 'should-not-be-claimed.mp4',
    });
  });
  videoOpsRouter._test.clearJobsForTests();
  const { server, baseUrl } = await listenVideoOps();
  try {
    const response = await fetch(`${baseUrl}/api/video-ops/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(legacyAsyncBody()),
    });
    const started = await response.json();
    assert.equal(response.status, 200);
    const evidence = started.data.durableEvidence;
    await delay(50);

    const jobResponse = await fetch(`${baseUrl}/api/video-ops/jobs/${encodeURIComponent(started.data.id)}`);
    const jobBody = await jobResponse.json();
    assert.equal(jobResponse.status, 200);
    assert.equal(jobBody.data.status, 'failed');
    assert.equal('result' in jobBody.data, false);
    assert.match(jobBody.data.error, /终态证据写入失败/);
    assert.equal(database.getRun(evidence.runId).status, 'failed');
    assert.equal(database.getNodeRun(evidence.nodeRunId).status, 'failed');
    assert.equal(database.getAttempt(evidence.attemptId).status, 'failed');
  } finally {
    database.appendRunEvent = originalAppendRunEvent;
    await new Promise((resolve) => server.close(resolve));
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetAsyncComposeExecutorForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('a cold restart converts an accepted synthetic job into an honest interrupted terminal trio', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.clearJobsForTests();
  try {
    const synthetic = videoOpsRouter._test.createSyntheticVideoOperationExecution(legacyAsyncBody());
    const evidence = videoOpsRouter._test.validateVideoOperationInputBinding({
      clips: synthetic.clips,
      settings: synthetic.settings,
      timelineV2: synthetic.timelineV2,
      renderPlan: synthetic.renderPlan,
      executionInput: synthetic.executionInput,
    }, synthetic.evidence);
    const job = videoOpsRouter._test.makeJob('compose', evidence, {
      requireExecutionEvidence: true,
      syntheticExecution: true,
    });
    assert.equal(database.getRun(evidence.runId).status, 'running');

    videoOpsRouter._test.clearJobsForTests();
    const restored = videoOpsRouter._test.reconstructDurableVideoOperationJob(job.id);
    assert.equal(restored.status, 'interrupted');
    assert.equal(database.getRun(evidence.runId).status, 'interrupted');
    assert.equal(database.getNodeRun(evidence.nodeRunId).status, 'interrupted');
    assert.equal(database.getAttempt(evidence.attemptId).status, 'interrupted');
  } finally {
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('separate-audio sync and async requests replay one durable result without a second execution', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const asyncFixture = createOperationFixture(database, 'separate-async', 'separate-audio', {
    async: true,
    clips: [{ id: 'clip-separate-async', url: '/files/input/a.mp4', trimStart: 0, trimEnd: 1 }],
    settings: { aspect: '16:9', audio: 'keep' },
    timelineV2: null,
    renderPlan: {},
    mode: 'both',
  });
  const syncFixture = createOperationFixture(database, 'separate-sync', 'separate-audio', {
    clips: [{ id: 'clip-separate-sync', url: '/files/input/b.mp4', trimStart: 0, trimEnd: 1 }],
    settings: { aspect: '16:9', audio: 'keep' },
    timelineV2: null,
    renderPlan: {},
    mode: 'audio-only',
  });
  const calls = new Map();
  let signalAsyncStarted;
  let releaseAsyncExecution;
  const asyncStarted = new Promise((resolve) => { signalAsyncStarted = resolve; });
  const asyncRelease = new Promise((resolve) => { releaseAsyncExecution = resolve; });
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.setOperationExecutorForTests('separate-audio', async (binding, job) => {
    const key = binding.clips[0].id;
    calls.set(key, Number(calls.get(key) || 0) + 1);
    if (key === 'clip-separate-async') {
      signalAsyncStarted();
      await asyncRelease;
    }
    return {
      jobId: job.id,
      mode: binding.mode,
      audioUrl: `/files/output/${key}.mp3`,
      audioFileName: `${key}.mp3`,
    };
  });
  videoOpsRouter._test.clearJobsForTests();
  const { server, baseUrl } = await listenVideoOps();
  try {
    const firstAsync = await postJson(baseUrl, 'separate-audio', { ...asyncFixture.requestBody, async: true });
    assert.equal(firstAsync.response.status, 200);
    const asyncJobId = firstAsync.body.data.id;
    await asyncStarted;
    const liveRetry = await postJson(baseUrl, 'separate-audio', { ...asyncFixture.requestBody, async: true });
    assert.equal(liveRetry.response.status, 200);
    assert.equal(liveRetry.body.data.id, asyncJobId);
    assert.equal(liveRetry.body.data.status, 'running');
    assert.equal(calls.get('clip-separate-async'), 1);
    releaseAsyncExecution();
    await delay(60);
    const terminalRetry = await postJson(baseUrl, 'separate-audio', { ...asyncFixture.requestBody, async: true });
    assert.equal(terminalRetry.body.data.status, 'done');
    assert.equal(terminalRetry.body.data.id, asyncJobId);

    videoOpsRouter._test.clearJobsForTests();
    const restartRetry = await postJson(baseUrl, 'separate-audio', { ...asyncFixture.requestBody, async: true });
    assert.equal(restartRetry.body.data.id, asyncJobId);
    assert.equal(restartRetry.body.data.result.audioUrl, '/files/output/clip-separate-async.mp3');
    assert.equal(calls.get('clip-separate-async'), 1);

    const firstSync = await postJson(baseUrl, 'separate-audio', syncFixture.requestBody);
    assert.equal(firstSync.response.status, 200);
    assert.equal(firstSync.body.data.audioUrl, '/files/output/clip-separate-sync.mp3');
    const syncJobId = firstSync.body.job.id;
    const syncRetry = await postJson(baseUrl, 'separate-audio', syncFixture.requestBody);
    assert.equal(syncRetry.response.status, 200);
    assert.equal(syncRetry.body.job.id, syncJobId);
    assert.equal(calls.get('clip-separate-sync'), 1);
    const tamperedSync = await postJson(baseUrl, 'separate-audio', {
      ...syncFixture.requestBody,
      mode: 'mute-video',
    });
    assert.equal(tamperedSync.response.status, 400);
    assert.match(tamperedSync.body.error, /实际操作参数/);
    assert.equal(calls.get('clip-separate-sync'), 1);

    videoOpsRouter._test.clearJobsForTests();
    const syncRestartRetry = await postJson(baseUrl, 'separate-audio', syncFixture.requestBody);
    assert.equal(syncRestartRetry.body.job.id, syncJobId);
    assert.equal(calls.get('clip-separate-sync'), 1);

    for (const fixture of [asyncFixture, syncFixture]) {
      const accepted = database.getRunEvents(fixture.run.id).filter((event) => event.payload?.phase === 'accepted');
      const terminal = database.getRunEvents(fixture.run.id).filter((event) => event.payload?.phase === 'terminal');
      assert.equal(accepted.length, 1);
      assert.equal(terminal.length, 1);
      assert.equal(database.getAttempt(fixture.attempt.id).upstreamTaskId, terminal[0].payload.videoOperation.jobId);
    }
  } finally {
    releaseAsyncExecution();
    await new Promise((resolve) => server.close(resolve));
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetOperationExecutorsForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('snapshot exact retries replay durable success and failure without extracting a second frame', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const successFixture = createOperationFixture(database, 'snapshot-success', 'snapshot', {
    clip: { id: 'clip-snapshot-success', url: '/files/input/success.mp4', name: '成功片段' },
    time: 1.25,
    format: 'jpg',
    sourceLabel: '权威截图',
  });
  const failureFixture = createOperationFixture(database, 'snapshot-failure', 'snapshot', {
    clip: { id: 'clip-snapshot-failure', url: '/files/input/failure.mp4', name: '失败片段' },
    time: 2,
    format: 'png',
  });
  const calls = new Map();
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.setOperationExecutorForTests('snapshot', async (binding, job) => {
    const key = binding.clip.id;
    calls.set(key, Number(calls.get(key) || 0) + 1);
    if (key === 'clip-snapshot-failure') throw new Error('injected snapshot extraction failure');
    return {
      jobId: job.id,
      imageUrl: '/files/output/snapshot-success.jpg',
      fileName: 'snapshot-success.jpg',
      time: binding.time,
      mime: 'image/jpeg',
    };
  });
  videoOpsRouter._test.clearJobsForTests();
  const { server, baseUrl } = await listenVideoOps();
  try {
    const success = await postJson(baseUrl, 'snapshot', successFixture.requestBody);
    assert.equal(success.response.status, 200);
    const successJobId = success.body.job.id;
    const successRetry = await postJson(baseUrl, 'snapshot', successFixture.requestBody);
    assert.equal(successRetry.response.status, 200);
    assert.equal(successRetry.body.job.id, successJobId);
    assert.equal(successRetry.body.data.imageUrl, '/files/output/snapshot-success.jpg');
    assert.equal(calls.get('clip-snapshot-success'), 1);
    const tamperedSnapshot = await postJson(baseUrl, 'snapshot', {
      ...successFixture.requestBody,
      time: 0.25,
    });
    assert.equal(tamperedSnapshot.response.status, 400);
    assert.match(tamperedSnapshot.body.error, /实际操作参数/);
    assert.equal(calls.get('clip-snapshot-success'), 1);

    videoOpsRouter._test.clearJobsForTests();
    const successRestartRetry = await postJson(baseUrl, 'snapshot', successFixture.requestBody);
    assert.equal(successRestartRetry.body.job.id, successJobId);
    assert.equal(calls.get('clip-snapshot-success'), 1);

    const failure = await postJson(baseUrl, 'snapshot', failureFixture.requestBody);
    assert.equal(failure.response.status, 500);
    assert.match(failure.body.error, /injected snapshot extraction failure/);
    const failureJobId = failure.body.job.id;
    const failureRetry = await postJson(baseUrl, 'snapshot', failureFixture.requestBody);
    assert.equal(failureRetry.response.status, 500);
    assert.equal(failureRetry.body.job.id, failureJobId);
    assert.equal(calls.get('clip-snapshot-failure'), 1);

    videoOpsRouter._test.clearJobsForTests();
    const failureRestartRetry = await postJson(baseUrl, 'snapshot', failureFixture.requestBody);
    assert.equal(failureRestartRetry.response.status, 500);
    assert.equal(failureRestartRetry.body.job.id, failureJobId);
    assert.equal(calls.get('clip-snapshot-failure'), 1);
    assert.equal(
      database.getRunEvents(failureFixture.run.id).filter((event) => event.payload?.phase === 'terminal').length,
      1,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetOperationExecutorsForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('separate-audio operation slot collisions and cross-route evidence fail closed with HTTP 409 or 400', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const fixture = createOperationFixture(database, 'separate-collision', 'separate-audio', {
    clips: [{ id: 'clip-separate-collision', url: '/files/input/collision.mp4' }],
    settings: {},
    mode: 'both',
  });
  const snapshotFixture = createOperationFixture(database, 'snapshot-route-mismatch', 'snapshot', {
    clip: { id: 'clip-route-mismatch', url: '/files/input/mismatch.mp4' },
    time: 0,
  });
  let executorCalls = 0;
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.setOperationExecutorForTests('separate-audio', async () => { executorCalls += 1; });
  videoOpsRouter._test.clearJobsForTests();
  database.appendRunEvent(fixture.run.id, {
    nodeRunId: fixture.nodeRun.id,
    type: 'log',
    payload: {
      schema: 't8-video-operation-run-evidence-v1',
      phase: 'accepted',
      videoOperation: {
        jobId: 'colliding-separate-job',
        action: 'separate-audio',
        status: 'running',
        executionEvidence: {
          ...fixture.evidence,
          inputDigest: `sha256:${'1'.repeat(64)}`,
        },
      },
    },
  });
  const { server, baseUrl } = await listenVideoOps();
  try {
    const collision = await postJson(baseUrl, 'separate-audio', fixture.requestBody);
    assert.equal(collision.response.status, 409);
    assert.match(collision.body.error, /不同视频任务|碰撞/);
    const routeMismatch = await postJson(baseUrl, 'separate-audio', snapshotFixture.requestBody);
    assert.equal(routeMismatch.response.status, 400);
    assert.match(routeMismatch.body.error, /当前路由 action 不匹配/);
    assert.equal(executorCalls, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetOperationExecutorsForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('loopback compatibility mints durable synthetic evidence for separate-audio sync async and snapshot', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.setOperationExecutorForTests('separate-audio', async (binding, job) => ({
    jobId: job.id,
    mode: binding.mode,
    audioUrl: '/files/output/synthetic.mp3',
  }));
  videoOpsRouter._test.setOperationExecutorForTests('snapshot', async (binding, job) => ({
    jobId: job.id,
    imageUrl: '/files/output/synthetic.png',
    time: binding.time,
  }));
  videoOpsRouter._test.clearJobsForTests();
  const { server, baseUrl } = await listenVideoOps();
  try {
    const separateBody = {
      clips: [{ id: 'synthetic-separate', url: '/files/input/local.mp4' }],
      settings: {},
      mode: 'both',
    };
    const syncSeparate = await postJson(baseUrl, 'separate-audio', separateBody);
    assert.equal(syncSeparate.response.status, 200);
    assert.equal(syncSeparate.body.job.status, 'done');
    assert.equal(syncSeparate.body.job.durableEvidence.actionTarget, 'separate-audio');

    const asyncSeparate = await postJson(baseUrl, 'separate-audio', { ...separateBody, async: true });
    assert.equal(asyncSeparate.response.status, 200);
    assert.equal(asyncSeparate.body.data.durableEvidence.actionTarget, 'separate-audio');
    await delay(60);

    const snapshot = await postJson(baseUrl, 'snapshot', {
      clip: { id: 'synthetic-snapshot', url: '/files/input/local.mp4' },
      time: 0.5,
      format: 'png',
    });
    assert.equal(snapshot.response.status, 200);
    assert.equal(snapshot.body.job.status, 'done');
    assert.equal(snapshot.body.job.durableEvidence.actionTarget, 'snapshot');

    const runs = database.db.prepare('SELECT id, status FROM runs ORDER BY created_at ASC').all();
    assert.equal(runs.length, 3);
    assert.deepEqual(runs.map((row) => row.status), ['succeeded', 'succeeded', 'succeeded']);
    for (const run of runs) {
      const events = database.getRunEvents(run.id);
      assert.equal(events.filter((event) => event.payload?.phase === 'accepted').length, 1);
      assert.equal(events.filter((event) => event.payload?.phase === 'terminal').length, 1);
    }
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM node_runs WHERE status = 'succeeded'").get().count, 3);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM run_attempts WHERE status = 'succeeded'").get().count, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetOperationExecutorsForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('synthetic separate-audio and snapshot failures persist terminal evidence and never claim success', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.setOperationExecutorForTests('separate-audio', async () => {
    throw new Error('injected synthetic separate failure');
  });
  videoOpsRouter._test.setOperationExecutorForTests('snapshot', async () => {
    throw new Error('injected synthetic snapshot failure');
  });
  videoOpsRouter._test.clearJobsForTests();
  const { server, baseUrl } = await listenVideoOps();
  try {
    const separate = await postJson(baseUrl, 'separate-audio', {
      async: true,
      clips: [{ id: 'synthetic-separate-failure', url: '/files/input/failure.mp4' }],
      settings: {},
    });
    assert.equal(separate.response.status, 200);
    await delay(60);
    const separateJob = await fetch(`${baseUrl}/api/video-ops/jobs/${encodeURIComponent(separate.body.data.id)}`);
    const separateJobBody = await separateJob.json();
    assert.equal(separateJobBody.data.status, 'failed');
    assert.equal('result' in separateJobBody.data, false);

    const snapshot = await postJson(baseUrl, 'snapshot', {
      clip: { id: 'synthetic-snapshot-failure', url: '/files/input/failure.mp4' },
      time: 1,
    });
    assert.equal(snapshot.response.status, 500);
    assert.equal(snapshot.body.job.status, 'failed');
    assert.equal('result' in snapshot.body.job, false);

    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status = 'failed'").get().count, 2);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM node_runs WHERE status = 'failed'").get().count, 2);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM run_attempts WHERE status = 'failed'").get().count, 2);
    const terminalEvents = database.db.prepare("SELECT COUNT(*) AS count FROM run_events WHERE payload_json LIKE '%\"phase\":\"terminal\"%'").get().count;
    assert.equal(terminalEvents, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetOperationExecutorsForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('cold restart marks in-flight synthetic separate-audio and snapshot evidence interrupted', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.clearJobsForTests();
  try {
    const inputs = [
      ['separate-audio', { clips: [{ id: 'restart-separate', url: '/files/input/a.mp4' }], settings: {}, mode: 'both' }],
      ['snapshot', { clip: { id: 'restart-snapshot', url: '/files/input/a.mp4' }, time: 1 }],
    ];
    const jobs = inputs.map(([action, body]) => {
      const synthetic = videoOpsRouter._test.createSyntheticVideoOperationExecution(action, body);
      const evidence = videoOpsRouter._test.validateVideoOperationInputBinding({
        ...body,
        ...synthetic,
        executionInput: synthetic.executionInput,
      }, synthetic.evidence, action);
      const job = videoOpsRouter._test.makeJob(action, evidence, {
        requireExecutionEvidence: true,
        syntheticExecution: true,
      });
      return { job, evidence };
    });
    videoOpsRouter._test.clearJobsForTests();
    for (const item of jobs) {
      const restored = videoOpsRouter._test.reconstructDurableVideoOperationJob(item.job.id);
      assert.equal(restored.status, 'interrupted');
      assert.equal(database.getRun(item.evidence.runId).status, 'interrupted');
      assert.equal(database.getNodeRun(item.evidence.nodeRunId).status, 'interrupted');
      assert.equal(database.getAttempt(item.evidence.attemptId).status, 'interrupted');
    }
  } finally {
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('remote evidence-less execution fails closed while probe and timeline-preview remain non-durable internal traces', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.clearJobsForTests();
  try {
    assert.throws(
      () => videoOpsRouter._test.prepareDurableVideoOperationRequest({
        body: { clips: [{ url: '/files/input/a.mp4' }] },
        socket: { remoteAddress: '198.51.100.24' },
      }, 'separate-audio'),
      (error) => error?.statusCode === 403,
    );
    assert.throws(
      () => videoOpsRouter._test.prepareDurableVideoOperationRequest({
        body: { clip: { url: '/files/input/a.mp4' } },
        socket: { remoteAddress: '203.0.113.8' },
      }, 'snapshot'),
      (error) => error?.statusCode === 403,
    );

    const { server, baseUrl } = await listenVideoOps();
    try {
      const partial = await postJson(baseUrl, 'snapshot', {
        clip: { url: '/files/input/a.mp4' },
        executionEvidence: {},
      });
      assert.equal(partial.response.status, 400);
      const probe = await postJson(baseUrl, 'probe', {});
      assert.equal(probe.response.status, 400);
      assert.equal('durableEvidence' in probe.body.job, false);
      const preview = await postJson(baseUrl, 'timeline-preview', {});
      assert.equal(preview.response.status, 500);
      assert.equal('durableEvidence' in preview.body.job, false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM runs').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM node_runs').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM run_attempts').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM run_events').get().count, 0);
  } finally {
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetOperationExecutorsForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('video shutdown cancels active children, blocks new work, and exposes bounded task drain', async () => {
  videoOpsRouter._test.clearJobsForTests();
  let releaseExecutor;
  const executorGate = new Promise((resolve) => { releaseExecutor = resolve; });
  let resolveExecutorStarted;
  const executorStarted = new Promise((resolve) => { resolveExecutorStarted = resolve; });
  let childKills = 0;
  const job = videoOpsRouter._test.makeJob('compose');
  const task = videoOpsRouter._test.scheduleAsyncVideoOperation(job, async () => {
    resolveExecutorStarted();
    await executorGate;
  }, '视频合成失败');
  try {
    await executorStarted;
    job.child = {
      kill() { childKills += 1; },
    };
    const shutdown = await videoOpsRouter._test.shutdownVideoOperationsLifecycle({ timeoutMs: 100 });
    assert.equal(shutdown.forced, true);
    assert.equal(shutdown.tasks.drained, false);
    assert.deepEqual(shutdown.cancelledJobIds, [job.id]);
    assert.equal(childKills, 1);
    assert.equal(job.status, 'cancelled');
    assert.throws(
      () => videoOpsRouter._test.makeJob('compose'),
      (error) => error?.code === 'video_operations_shutting_down' && error?.statusCode === 503,
    );
    releaseExecutor();
    await task;
    assert.deepEqual(
      await videoOpsRouter._test.waitForAsyncVideoOperations(0),
      { drained: true, activeTasks: 0 },
    );
  } finally {
    releaseExecutor();
    await task;
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetVideoOperationsLifecycleForTests();
  }
});
