const test = require('node:test');
const assert = require('node:assert/strict');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

function ensureCanvasRevision(db, projectId, canvasId, revision = 4) {
  let document = db.ensureCanvas(canvasId, {
    projectId,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }, projectId);
  while (document.revision < revision) {
    document = db.saveCanvasSnapshot(canvasId, document, {
      expectedRevision: document.revision,
    });
  }
  return document;
}

function createRun(db, id, overrides = {}) {
  return db.createRun({
    id,
    projectId: 'project-a',
    canvasId: 'canvas-a',
    canvasRevision: 4,
    initiatorId: 'owner-a',
    status: 'failed',
    ...overrides,
  });
}

function createNodeAndAttempts(db, runId, nodeIndex, attemptCount = 1, overrides = {}) {
  const nodeRun = db.createNodeRun({
    id: `${runId}-node-${String(nodeIndex).padStart(3, '0')}`,
    runId,
    nodeId: `node-${String(nodeIndex).padStart(3, '0')}`,
    status: overrides.nodeStatus || 'failed',
  });
  const attempts = [];
  for (let index = 0; index < attemptCount; index += 1) {
    attempts.push(db.createAttempt({
      id: `${nodeRun.id}-attempt-${String(index + 1).padStart(2, '0')}`,
      nodeRunId: nodeRun.id,
      status: overrides.attemptStatus || 'failed',
      provider: `provider-${nodeIndex}`,
      model: `model-${index}`,
      error: { kind: overrides.kind || 'network', code: 'ETIMEDOUT', retryable: true },
    }));
  }
  return { nodeRun, attempts };
}

function subflow(id, projectId, name) {
  return {
    id,
    projectId,
    name,
    description: '',
    tags: [],
    nodes: [{ id: 'inside', type: 'text', position: { x: 0, y: 0 }, data: {} }],
    edges: [],
    inputs: [],
    outputs: [],
    exposedParameters: [],
    requiredCapabilities: [],
    assetRefs: [],
  };
}

test('E4 run evidence uses constant bounded SQL queries and reports exact pagination completeness', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    ensureCanvasRevision(db, 'project-a', 'canvas-a');
    const run = createRun(db, 'run-large');
    for (let index = 0; index < 51; index += 1) createNodeAndAttempts(db, run.id, index, 4);

    const originalPrepare = db.db.prepare.bind(db.db);
    let preparedStatements = 0;
    db.db.prepare = (...args) => {
      preparedStatements += 1;
      return originalPrepare(...args);
    };
    const evidence = db.getRunEvidence({
      projectId: 'project-a', canvasId: 'canvas-a', runId: run.id, nodeLimit: 50, attemptLimit: 3,
    });

    assert.ok(preparedStatements <= 5, `expected constant queries, got ${preparedStatements}`);
    assert.deepEqual(evidence.totals, { nodeRuns: 51, attempts: 204 });
    assert.deepEqual(evidence.returned, { nodeRuns: 50, attempts: 150 });
    assert.deepEqual(evidence.hasMore, { nodeRuns: true, attempts: true });
    assert.equal(evidence.evidenceComplete, false);
    assert.deepEqual(evidence.evidenceReasons, ['node_runs_truncated', 'attempts_truncated']);
    assert.equal(evidence.nodeRuns.length, 50);
    assert.equal(evidence.attemptsByNodeId.size, 50);
    assert.equal([...evidence.attemptsByNodeId.values()].every((items) => items.length === 3), true);
  } finally {
    db.close();
  }
});

test('E4 exact Run/NodeRun/Attempt selection is scope-joined, complete, and preserves the real Attempt number', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    ensureCanvasRevision(db, 'project-a', 'canvas-a');
    ensureCanvasRevision(db, 'project-b', 'canvas-b');
    const runA = createRun(db, 'run-a');
    const runB = createRun(db, 'run-b');
    const a = createNodeAndAttempts(db, runA.id, 1, 4);
    const b = createNodeAndAttempts(db, runB.id, 2, 2);
    createRun(db, 'run-other-project', { projectId: 'project-b', canvasId: 'canvas-b' });

    const exact = db.getRunEvidence({
      projectId: 'project-a',
      canvasId: 'canvas-a',
      runId: runA.id,
      nodeRunId: a.nodeRun.id,
      attemptId: a.attempts[3].id,
      nodeLimit: 50,
      attemptLimit: 3,
    });
    assert.deepEqual(exact.selection, {
      runId: runA.id, nodeRunId: a.nodeRun.id, attemptId: a.attempts[3].id,
    });
    assert.deepEqual(exact.totals, { nodeRuns: 1, attempts: 1 });
    assert.deepEqual(exact.returned, { nodeRuns: 1, attempts: 1 });
    assert.deepEqual(exact.hasMore, { nodeRuns: false, attempts: false });
    assert.equal(exact.evidenceComplete, true);
    assert.equal(exact.attemptsByNodeId.get(a.nodeRun.id)[0].id, a.attempts[3].id);
    assert.equal(exact.attemptsByNodeId.get(a.nodeRun.id)[0].attemptNumber, 4);

    const attemptOnly = db.getRunEvidence({
      projectId: 'project-a', canvasId: 'canvas-a', attemptId: b.attempts[1].id,
    });
    assert.deepEqual(attemptOnly.selection, {
      runId: runB.id, nodeRunId: b.nodeRun.id, attemptId: b.attempts[1].id,
    });

    const crossRun = db.getRunEvidence({
      projectId: 'project-a', canvasId: 'canvas-a', runId: runA.id,
      nodeRunId: b.nodeRun.id, attemptId: b.attempts[0].id,
    });
    assert.equal(crossRun.run.id, runA.id);
    assert.deepEqual(crossRun.nodeRuns, []);
    assert.deepEqual(crossRun.returned, { nodeRuns: 0, attempts: 0 });
    assert.equal(crossRun.evidenceComplete, false);
    assert.deepEqual(crossRun.evidenceReasons, ['selected_evidence_missing_or_retained']);

    assert.equal(db.getRunEvidence({
      projectId: 'project-a', canvasId: 'canvas-a', runId: 'run-other-project',
    }), null);
  } finally {
    db.close();
  }
});

test('E4 authoritative validation loads exact immutable subflow refs in one bounded project-scoped query', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const first = db.saveSubflowDefinition(subflow('flow-a', 'project-a', 'A v1'));
    const second = db.saveSubflowDefinition(subflow('flow-a', 'project-a', 'A v2'));
    db.saveSubflowDefinition(subflow('flow-a', 'project-b', 'B v1'));

    const originalPrepare = db.db.prepare.bind(db.db);
    let preparedStatements = 0;
    db.db.prepare = (...args) => {
      preparedStatements += 1;
      return originalPrepare(...args);
    };
    const definitions = db.getSubflowDefinitionsByRefs([
      { id: first.id, version: first.version },
      { id: second.id, version: second.version },
      { id: first.id, version: first.version },
      { id: 'missing-flow', version: 1 },
    ], 'project-a');

    assert.equal(preparedStatements, 1);
    assert.deepEqual(definitions.map((item) => [item.projectId, item.id, item.version, item.name]), [
      ['project-a', 'flow-a', 1, 'A v1'],
      ['project-a', 'flow-a', 2, 'A v2'],
    ]);
    assert.throws(() => db.getSubflowDefinitionsByRefs(
      Array.from({ length: 101 }, (_, index) => ({ id: `flow-${index}`, version: 1 })),
      'project-a',
    ), /超过限制/);
  } finally {
    db.close();
  }
});

test('E4 database rejects cross-Run Attempt updates and RunEvent relationships without mutating either Run', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    ensureCanvasRevision(db, 'project-a', 'canvas-a');
    const runA = createRun(db, 'run-a');
    const runB = createRun(db, 'run-b');
    const a = createNodeAndAttempts(db, runA.id, 1, 1);
    const b = createNodeAndAttempts(db, runB.id, 2, 1);

    assert.throws(() => db.updateAttempt(b.attempts[0].id, { status: 'succeeded' }, {
      runId: runA.id, nodeRunId: b.nodeRun.id,
    }), /不属于当前 Run\/NodeRun/);
    assert.equal(db.getAttempt(b.attempts[0].id).status, 'failed');

    assert.throws(() => db.appendRunEvent(runA.id, {
      nodeRunId: b.nodeRun.id, type: 'node.failed', payload: { status: 'failed' },
    }), /不属于当前 Run/);
    assert.deepEqual(db.getRunEvents(runA.id), []);

    const validAttempt = db.updateAttempt(a.attempts[0].id, { status: 'succeeded' }, {
      runId: runA.id, nodeRunId: a.nodeRun.id,
    });
    assert.equal(validAttempt.status, 'succeeded');
    const validEvent = db.appendRunEvent(runA.id, {
      nodeRunId: a.nodeRun.id, type: 'node.succeeded', payload: { status: 'succeeded' },
    });
    assert.equal(validEvent.runId, runA.id);
    assert.equal(validEvent.nodeRunId, a.nodeRun.id);
  } finally {
    db.close();
  }
});
