const test = require('node:test');
const assert = require('node:assert/strict');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const {
  RunRecoveryManager,
  normalizeRunRecoveryDescriptor,
  recoveryRequest,
} = require('../backend/src/services/runRecovery');

function createActiveRecovery(db, options = {}) {
  db.ensureCanvas('recovery-canvas', { nodes: [], edges: [] }, 'recovery-project');
  const run = db.createRun({ projectId: 'recovery-project', canvasId: 'recovery-canvas', status: 'running' });
  const nodeRun = db.createNodeRun({ runId: run.id, nodeId: options.nodeId || 'async-node', status: 'polling' });
  const attempt = db.createAttempt({
    nodeRunId: nodeRun.id,
    provider: options.provider || 'seedance-nz',
    model: options.model || 'wan-2.7-spicy-i2v',
    upstreamTaskId: options.taskId || 'task-recovery-1',
    status: 'polling',
    pollCount: 2,
    metadata: options.metadata || {
      recovery: {
        kind: 'wan', taskId: options.taskId || 'task-recovery-1', model: 'wan-2.7-spicy-i2v',
        pollIntervalMs: 250, maxPolls: 4,
      },
    },
  });
  return { run, nodeRun, attempt };
}

function linkRunningIntent(db, run, suffix) {
  const intent = db.createRunIntent({
    projectId: run.projectId,
    canvasId: run.canvasId,
    canvasRevision: run.canvasRevision,
    idempotencyKey: `recovery-intent-${suffix}`,
    requestedBy: 'remote-editor',
    provider: 'seedance-nz',
    model: 'wan-2.7-spicy-i2v',
    estimatedCostKnown: false,
  });
  db.updateRunIntent(intent.id, { status: 'running', runId: run.id });
  return db.getRunIntent(intent.id);
}

test('recovery descriptors map only allowlisted kinds to fixed loopback routes', () => {
  const descriptor = normalizeRunRecoveryDescriptor({ kind: 'runninghub', taskId: 'task/a', site: 'intl', pollIntervalMs: 1, maxPolls: 99999 });
  assert.deepEqual(descriptor, {
    version: 1, kind: 'runninghub', taskId: 'task/a', taskIds: [], requestId: null,
    responseUrl: null, statusUrl: null, endpoint: null, model: null, site: 'intl', taskProvider: null,
    speed: null, pollIntervalMs: 250, maxPolls: 7200,
  });
  assert.deepEqual(recoveryRequest('http://127.0.0.1:18766', descriptor), {
    url: 'http://127.0.0.1:18766/api/proxy/runninghub/query?taskId=task%2Fa&site=intl',
    options: { method: 'GET' },
  });
  assert.equal(normalizeRunRecoveryDescriptor({ kind: 'http', taskId: 'x', url: 'https://evil.example' }), null);
  assert.equal(normalizeRunRecoveryDescriptor({ kind: 'video-fal', requestId: 'req-only' }), null);
});

test('restart keeps allowlisted provider polling recoverable and manager finishes the authoritative Run', async () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const active = createActiveRecovery(db);
    const intent = linkRunningIntent(db, active.run, 'success');
    const prepared = db.recoverInterruptedRuns();
    assert.deepEqual(prepared, { runs: 0, nodeRuns: 0, attempts: 0, recoverableRuns: 1, recoverableNodeRuns: 1, recoverableAttempts: 1 });
    assert.equal(db.getRun(active.run.id).status, 'running');
    assert.equal(db.listPendingRunRecoveries().length, 1);
    const probes = [
      { state: 'pending', outputs: [], usage: { credits: 1 }, error: null, providerStatus: 'running' },
      { state: 'succeeded', outputs: [{ kind: 'video', sourceUrl: '/files/output/recovered.mp4', filename: 'recovered.mp4' }], usage: { costUsd: 0.5, credits: 1 }, error: null, providerStatus: 'succeeded' },
    ];
    const recordedOutputInputs = [];
    const broadcasts = { runs: [], nodes: [], outputs: [] };
    const manager = new RunRecoveryManager({
      database: db,
      baseUrl: 'http://127.0.0.1:1',
      wait: async () => undefined,
      queryRecovery: async () => probes.shift(),
      recordRunOutputAssets: async (input) => {
        recordedOutputInputs.push(input);
        return db.recordRunOutputAssets(input);
      },
      broadcast: {
        run: (run) => broadcasts.runs.push(run),
        node: (_run, nodeRun) => broadcasts.nodes.push(nodeRun),
        output: (_run, _nodeRun, assets) => broadcasts.outputs.push(...assets),
      },
    });
    const result = await manager.recoverPendingRuns();
    assert.equal(result.recovered, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.interrupted, 0);
    assert.equal(db.getRun(active.run.id).status, 'succeeded');
    assert.equal(db.getRun(active.run.id).summary.recoveredAfterRestart, true);
    assert.equal(db.getNodeRun(active.nodeRun.id).status, 'succeeded');
    assert.equal(db.getNodeRun(active.nodeRun.id).outputRefs.length, 1);
    assert.equal(db.getAttempt(active.attempt.id).status, 'succeeded');
    assert.equal(db.getAttempt(active.attempt.id).pollCount, 4);
    assert.equal(db.getAttempt(active.attempt.id).usage.costUsd, 0.5);
    assert.equal(db.getRunIntent(intent.id).status, 'completed');
    assert.equal(db.getRunIntent(intent.id).actualCost, 0.5);
    assert.equal(broadcasts.outputs.length, 1);
    assert.equal(recordedOutputInputs.length, 1);
    assert.equal(recordedOutputInputs[0].outputs[0].sourceUrl, '/files/output/recovered.mp4');
    assert.equal(broadcasts.runs.at(-1).status, 'succeeded');
    const eventTypes = db.getRunEvents(active.run.id).map((event) => event.type);
    assert.equal(eventTypes.includes('provider.polling'), true);
    assert.equal(eventTypes.includes('node.output'), true);
    assert.equal(eventTypes.includes('node.succeeded'), true);
    assert.equal(eventTypes.includes('run.succeeded'), true);
  } finally {
    db.close();
  }
});

test('startup interruption finishes the linked RunIntent in the same immediate transaction and rolls every write back on failure', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const active = createActiveRecovery(db, {
      nodeId: 'startup-unrecoverable',
      metadata: { lastProviderEvent: 'provider.polling' },
    });
    const intent = linkRunningIntent(db, active.run, 'startup-rollback');
    const finishRunIntentForRun = db.finishRunIntentForRun.bind(db);
    db.finishRunIntentForRun = (runId, ...args) => {
      if (runId === active.run.id) throw new Error('forced startup intent finish failure');
      return finishRunIntentForRun(runId, ...args);
    };

    assert.throws(() => db.recoverInterruptedRuns(), /forced startup intent finish failure/);
    assert.equal(db.getRun(active.run.id).status, 'running');
    assert.equal(db.getRun(active.run.id).finishedAt, null);
    assert.equal(db.getNodeRun(active.nodeRun.id).status, 'polling');
    assert.equal(db.getAttempt(active.attempt.id).status, 'polling');
    assert.equal(db.getRunIntent(intent.id).status, 'running');
    assert.equal(db.getRunEvents(active.run.id).some((event) => event.type === 'run.interrupted'), false);

    db.finishRunIntentForRun = finishRunIntentForRun;
    const recovered = db.recoverInterruptedRuns();
    assert.equal(recovered.runs, 1);
    assert.equal(db.getRun(active.run.id).status, 'interrupted');
    assert.equal(db.getNodeRun(active.nodeRun.id).status, 'interrupted');
    assert.equal(db.getAttempt(active.attempt.id).status, 'interrupted');
    assert.equal(db.getRunIntent(intent.id).status, 'failed');
    assert.equal(db.getExecutionUsage(active.run.projectId).activeCount, 0);
    assert.equal(
      db.getRunEvents(active.run.id).filter((event) => event.type === 'run.interrupted').length,
      1,
    );
  } finally {
    db.close();
  }
});

test('recovery finalization commits Run, terminal event, and RunIntent atomically and a failed finish can be retried', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const active = createActiveRecovery(db, { nodeId: 'finalize-atomic' });
    const intent = linkRunningIntent(db, active.run, 'finalize-atomic');
    db.updateAttempt(active.attempt.id, {
      status: 'succeeded',
      usage: { costUsd: 0.75 },
      timestamps: { finishedAt: 1234, recoveredAt: 1234 },
    });
    db.updateNodeRun(active.nodeRun.id, { status: 'succeeded' });
    const broadcasts = { runs: [], intents: [] };
    const manager = new RunRecoveryManager({
      database: db,
      baseUrl: 'http://127.0.0.1:1',
      broadcast: {
        run: (run) => broadcasts.runs.push(run),
        intent: (value) => broadcasts.intents.push(value),
      },
    });
    const finishRunIntentForRun = db.finishRunIntentForRun.bind(db);
    db.finishRunIntentForRun = (runId, ...args) => {
      if (runId === active.run.id) throw new Error('forced recovery intent finish failure');
      return finishRunIntentForRun(runId, ...args);
    };

    assert.throws(() => manager.finalizeRun(active.run.id), /forced recovery intent finish failure/);
    assert.equal(db.getRun(active.run.id).status, 'running');
    assert.equal(db.getRun(active.run.id).finishedAt, null);
    assert.equal(db.getRunIntent(intent.id).status, 'running');
    assert.equal(db.getRunEvents(active.run.id).some((event) => event.type === 'run.succeeded'), false);
    assert.deepEqual(broadcasts, { runs: [], intents: [] });

    db.finishRunIntentForRun = finishRunIntentForRun;
    const finished = manager.finalizeRun(active.run.id);
    assert.equal(finished.status, 'succeeded');
    assert.equal(db.getRunIntent(intent.id).status, 'completed');
    assert.equal(db.getRunIntent(intent.id).actualCost, 0.75);
    assert.equal(
      db.getRunEvents(active.run.id).filter((event) => event.type === 'run.succeeded').length,
      1,
    );
    assert.equal(broadcasts.runs.length, 1);
    assert.equal(broadcasts.intents.length, 1);
  } finally {
    db.close();
  }
});

test('restart archives unsupported or non-queryable tasks as interrupted instead of pretending to resume', async () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const unsupported = createActiveRecovery(db, { nodeId: 'local-only', metadata: { lastProviderEvent: 'provider.polling' } });
    const prepared = db.recoverInterruptedRuns();
    assert.equal(prepared.runs, 1);
    assert.equal(db.getRun(unsupported.run.id).status, 'interrupted');
    assert.equal(db.getAttempt(unsupported.attempt.id).error.code, 'RUN_RECOVERY_UNAVAILABLE');

    const retryable = createActiveRecovery(db, { nodeId: 'expired-remote', taskId: 'expired-task' });
    db.recoverInterruptedRuns();
    const manager = new RunRecoveryManager({
      database: db,
      baseUrl: 'http://127.0.0.1:1',
      wait: async () => undefined,
      queryRecovery: async () => Object.assign(new Error('task not found'), { httpStatus: 404, retryable: false }),
    });
    manager.queryRecovery = async () => { throw Object.assign(new Error('task not found'), { httpStatus: 404, retryable: false }); };
    const result = await manager.recoverPendingRuns();
    assert.equal(result.interrupted, 1);
    assert.equal(db.getRun(retryable.run.id).status, 'interrupted');
    assert.equal(db.getAttempt(retryable.attempt.id).error.code, 'RUN_RECOVERY_UNAVAILABLE');
  } finally {
    db.close();
  }
});
