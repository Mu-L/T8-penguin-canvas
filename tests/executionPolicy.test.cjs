const test = require('node:test');
const assert = require('node:assert/strict');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const { ExecutionPolicyError, HostExecutionPolicy } = require('../backend/src/collaboration/executionPolicy');
const {
  deriveRunIntentAuthority,
  summarizeRunIntentAuthority,
} = require('../backend/src/collaboration/runIntentAuthority');
const { explicitAttemptCost, explicitRunCost } = require('../backend/src/services/runUsage');

function insertMember(database, {
  id = 'member-editor',
  projectId = 'project-local',
  role = 'editor',
  capabilities = ['runWorkflow'],
} = {}) {
  const now = Date.now();
  database.db.prepare(`
    INSERT INTO collaboration_members(id, project_id, display_name, role, capabilities_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, id, role, JSON.stringify(capabilities), now, now);
  return database.getCollaborationMember(id);
}

function ensureImageCanvas(database, canvasId = 'canvas-authority') {
  return database.ensureCanvas(canvasId, {
    nodes: [{
      id: 'image-node',
      type: 'image',
      position: { x: 0, y: 0 },
      data: { model: 'gpt-image-2', apiModel: 'gpt-image-2-all' },
    }],
    edges: [],
  }, 'project-local');
}

function createAuthoritativeIntent(database, {
  canvas = ensureImageCanvas(database),
  idempotencyKey = `intent-${Date.now()}-${Math.random()}`,
  requestedBy = 'member-editor',
} = {}) {
  const authority = deriveRunIntentAuthority(canvas, ['image-node']);
  const summary = summarizeRunIntentAuthority(authority);
  return database.createRunIntent({
    projectId: canvas.projectId,
    canvasId: canvas.canvasId,
    canvasRevision: canvas.revision,
    nodeIds: authority.requestedNodeIds,
    idempotencyKey,
    requestedBy,
    provider: summary.provider,
    model: summary.model,
    estimatedCost: summary.estimatedCost,
    estimatedCostKnown: summary.estimatedCostKnown,
    executionAuthority: authority,
  });
}

test('host execution policy enforces model, per-run, daily and concurrency limits', () => {
  const database = new ProjectDatabase(':memory:');
  const policy = new HostExecutionPolicy(database);
  try {
    database.setExecutionPolicy('project-local', {
      allowedModels: ['image:allowed-model'],
      perRunCostLimit: 2,
      dailyCostLimit: 3,
      concurrencyLimit: 1,
    });
    assert.throws(() => policy.authorize({ projectId: 'project-local', provider: 'image', model: 'denied', estimatedCost: 1 }), (error) => error instanceof ExecutionPolicyError && error.code === 'model_not_allowed');
    assert.throws(() => policy.authorize({ projectId: 'project-local', provider: 'image', model: 'allowed-model', estimatedCost: 2.5 }), (error) => error.code === 'run_cost_limit');
    assert.doesNotThrow(() => policy.authorize({ projectId: 'project-local', provider: 'image', model: 'allowed-model', estimatedCost: 1.5 }));
    database.createRunIntent({
      projectId: 'project-local', canvasId: 'canvas-a', canvasRevision: 1, idempotencyKey: 'policy-intent-1',
      requestedBy: 'member-a', provider: 'image', model: 'allowed-model', estimatedCost: 1.5,
    });
    assert.throws(() => policy.authorize({ projectId: 'project-local', provider: 'image', model: 'allowed-model', estimatedCost: 1 }), (error) => error.code === 'concurrency_limit');
    database.updateRunIntent(database.getRunIntentByKey('project-local', 'policy-intent-1').id, { status: 'completed', actualCost: 2.5 });
    assert.throws(() => policy.authorize({ projectId: 'project-local', provider: 'image', model: 'allowed-model', estimatedCost: 1 }), (error) => error.code === 'daily_cost_limit');
  } finally {
    database.close();
  }
});

test('actual run cost uses only explicit cost fields and never treats credits or tokens as currency', () => {
  assert.equal(explicitAttemptCost({ inputTokens: 40, credits: 3 }), null);
  assert.equal(explicitAttemptCost({ cost: 0.4, totalCost: 0.7, inputTokens: 40 }), 0.7);
  assert.equal(explicitAttemptCost({ billing: { costUsd: 0.25 } }), 0.25);
  assert.equal(explicitRunCost([
    { usage: { totalCostUsd: 0.5, credits: 2 } },
    { usage: { cost: 0.2 } },
    { usage: { credits: 9 } },
  ]), 0.7);
});

test('persisted RunIntent reservation is excluded exactly once from concurrency checks', () => {
  const database = new ProjectDatabase(':memory:');
  const policy = new HostExecutionPolicy(database);
  try {
    insertMember(database);
    const canvas = ensureImageCanvas(database);
    database.setExecutionPolicy('project-local', {
      allowedModels: ['zhenzhen:gpt-image-2-all'],
      perRunCostLimit: 0,
      dailyCostLimit: 0,
      concurrencyLimit: 1,
    });
    const intent = createAuthoritativeIntent(database, {
      canvas,
      idempotencyKey: 'intent-reservation-once',
    });

    assert.throws(() => policy.authorize({
      projectId: intent.projectId,
      provider: 'zhenzhen',
      model: 'gpt-image-2-all',
      estimatedCost: 0,
    }), (error) => error.code === 'concurrency_limit');
    assert.doesNotThrow(() => policy.authorizeRunIntent(intent.id, {
      allowedStatuses: ['pending'],
      reservationAlreadyCounted: true,
    }));

    assert.deepEqual(database.getExecutionUsage('project-local'), {
      activeCount: 1,
      dailyCost: 0,
      unknownCostCount: 1,
      dayStart: database.getExecutionUsage('project-local').dayStart,
    });
  } finally {
    database.close();
  }
});

test('unknown remote cost stays unknown and fails closed whenever the host configured a cost limit', () => {
  const database = new ProjectDatabase(':memory:');
  const policy = new HostExecutionPolicy(database);
  try {
    insertMember(database);
    const intent = createAuthoritativeIntent(database, { idempotencyKey: 'intent-cost-unknown' });
    database.setExecutionPolicy('project-local', {
      allowedModels: ['zhenzhen:gpt-image-2-all'],
      perRunCostLimit: 1,
      dailyCostLimit: 0,
      concurrencyLimit: 2,
    });
    assert.equal(intent.estimatedCostKnown, false);
    assert.equal(intent.estimatedCost, null);
    assert.throws(() => policy.authorizeRunIntent(intent.id, {
      allowedStatuses: ['pending'],
      reservationAlreadyCounted: true,
    }), (error) => error.code === 'cost_estimate_unavailable');
    assert.equal(database.getRunIntent(intent.id).status, 'pending');
  } finally {
    database.close();
  }
});

test('authoritative RunIntent validation ignores caller overrides and rejects tightened member, revision, and host policy', () => {
  const createFixture = () => {
    const database = new ProjectDatabase(':memory:');
    const policy = new HostExecutionPolicy(database);
    insertMember(database);
    const canvas = ensureImageCanvas(database);
    database.setExecutionPolicy('project-local', {
      allowedModels: ['zhenzhen:gpt-image-2-all'],
      perRunCostLimit: 0,
      dailyCostLimit: 0,
      concurrencyLimit: 4,
    });
    const intent = createAuthoritativeIntent(database, {
      canvas,
      idempotencyKey: 'intent-authority-fixture',
    });
    return { database, policy, canvas, intent };
  };

  {
    const { database, policy, intent } = createFixture();
    try {
      database.setExecutionPolicy('project-local', {
        allowedModels: ['zhenzhen:nano-banana-pro'], perRunCostLimit: 0, dailyCostLimit: 0, concurrencyLimit: 4,
      });
      assert.throws(() => policy.authorizeRunIntent({
        id: intent.id,
        provider: 'zhenzhen',
        model: 'nano-banana-pro',
        estimatedCost: 0,
      }, { reservationAlreadyCounted: true }), (error) => error.code === 'model_not_allowed');
      assert.equal(database.getRunIntent(intent.id).status, 'pending');
    } finally {
      database.close();
    }
  }

  {
    const { database, policy, intent } = createFixture();
    try {
      database.updateMember('member-editor', { role: 'reviewer', capabilities: [] });
      assert.throws(() => policy.authorizeRunIntent(intent.id, {
        allowedStatuses: ['pending'],
        reservationAlreadyCounted: true,
      }), (error) => error.code === 'intent_requester_not_authorized');
      assert.equal(database.getRunIntent(intent.id).status, 'pending');
    } finally {
      database.close();
    }
  }

  {
    const { database, policy, canvas, intent } = createFixture();
    try {
      database.saveCanvasSnapshot(canvas.canvasId, { nodes: canvas.nodes, edges: canvas.edges }, {
        expectedRevision: canvas.revision,
        projectId: canvas.projectId,
      });
      assert.throws(() => policy.authorizeRunIntent(intent.id, {
        allowedStatuses: ['pending'],
        reservationAlreadyCounted: true,
      }), (error) => error.code === 'intent_canvas_stale');
      assert.equal(database.getRunIntent(intent.id).status, 'pending');
    } finally {
      database.close();
    }
  }
});
