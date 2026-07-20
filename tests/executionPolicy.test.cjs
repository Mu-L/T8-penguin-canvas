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
  canvasId = 'canvas-authority',
  role = 'editor',
  capabilities = ['runWorkflow'],
} = {}) {
  const now = Date.now();
  database.db.prepare(`
    INSERT INTO collaboration_members(
      id, project_id, canvas_id, display_name, role, capabilities_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, canvasId, id, role, JSON.stringify(capabilities), now, now);
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
  id,
  idempotencyKey = `intent-${Date.now()}-${Math.random()}`,
  requestedBy = 'member-editor',
  confirmationRequired,
} = {}) {
  const authority = deriveRunIntentAuthority(canvas, ['image-node']);
  const summary = summarizeRunIntentAuthority(authority);
  return database.createRunIntent({
    id,
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
    confirmationRequired,
  });
}

test('host execution policy enforces model, per-run, daily and concurrency limits', () => {
  const database = new ProjectDatabase(':memory:');
  const policy = new HostExecutionPolicy(database);
  try {
    const canvas = ensureImageCanvas(database, 'canvas-a');
    database.setExecutionPolicy('project-local', {
      allowedModels: ['image:allowed-model'],
      perRunCostLimit: 2,
      dailyCostLimit: 3,
      concurrencyLimit: 1,
    });
    assert.throws(() => policy.authorize({ projectId: 'project-local', provider: 'image', model: 'denied', estimatedCost: 1 }), (error) => error instanceof ExecutionPolicyError && error.code === 'model_not_allowed');
    assert.throws(() => policy.authorize({ projectId: 'project-local', provider: 'image', model: 'allowed-model', estimatedCost: 2.5 }), (error) => error.code === 'run_cost_limit');
    assert.doesNotThrow(() => policy.authorize({ projectId: 'project-local', provider: 'image', model: 'allowed-model', estimatedCost: 1.5 }));
    const queuedIntent = database.createRunIntent({
      projectId: 'project-local', canvasId: canvas.canvasId, canvasRevision: canvas.revision, idempotencyKey: 'policy-intent-1',
      requestedBy: 'member-a', provider: 'image', model: 'allowed-model', estimatedCost: 1.5,
      confirmationRequired: false,
    });
    assert.doesNotThrow(
      () => policy.authorize({ projectId: 'project-local', provider: 'image', model: 'allowed-model', estimatedCost: 1 }),
      'accepted work may wait in the durable queue without consuming active concurrency',
    );
    const leased = database.leaseRunIntentForDispatch(
      { projectId: 'project-local', canvasId: 'canvas-a' },
      { workerId: 'policy-test-worker', canvasConcurrencyLimit: 1 },
    );
    assert.equal(leased.intent.id, queuedIntent.id);
    assert.throws(() => policy.authorize({ projectId: 'project-local', provider: 'image', model: 'allowed-model', estimatedCost: 1 }), (error) => error.code === 'concurrency_limit');
    database.updateRunIntent(queuedIntent.id, { status: 'completed', actualCost: 2.5 });
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

test('queued RunIntent reserves cost without consuming concurrency and dispatch lease is excluded exactly once', () => {
  const database = new ProjectDatabase(':memory:');
  const policy = new HostExecutionPolicy(database);
  try {
    const canvas = ensureImageCanvas(database);
    insertMember(database, { canvasId: canvas.canvasId });
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

    assert.doesNotThrow(() => policy.authorize({
      projectId: intent.projectId,
      provider: 'zhenzhen',
      model: 'gpt-image-2-all',
      estimatedCost: 0,
    }));
    const accepted = database.acceptRunIntentForDispatch(intent.id, {
      projectId: intent.projectId,
      canvasId: intent.canvasId,
      expectedQueueRevision: intent.queueRevision,
      confirmedBy: 'local-owner',
    });
    const leased = database.leaseRunIntentForDispatch(
      { projectId: intent.projectId, canvasId: intent.canvasId },
      { workerId: 'reservation-test-worker', canvasConcurrencyLimit: 1 },
    );
    assert.equal(leased.intent.id, intent.id);
    assert.throws(() => policy.authorize({
      projectId: intent.projectId,
      provider: 'zhenzhen',
      model: 'gpt-image-2-all',
      estimatedCost: 0,
    }), (error) => error.code === 'concurrency_limit');
    assert.doesNotThrow(() => policy.authorizeRunIntent(intent.id, {
      allowedStatuses: ['dispatching'],
      reservationAlreadyCounted: true,
    }));

    assert.deepEqual(database.getExecutionUsage('project-local'), {
      activeCount: 1,
      queuedCount: 0,
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
    const canvas = ensureImageCanvas(database);
    insertMember(database, { canvasId: canvas.canvasId });
    const intent = createAuthoritativeIntent(database, { canvas, idempotencyKey: 'intent-cost-unknown' });
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

test('room execution policy separates editor permission, member quota, and risk confirmation from queue concurrency', () => {
  const database = new ProjectDatabase(':memory:');
  const policy = new HostExecutionPolicy(database);
  try {
    const canvas = ensureImageCanvas(database);
    insertMember(database, { canvasId: canvas.canvasId });
    database.setExecutionPolicy('project-local', {
      allowedModels: ['zhenzhen:gpt-image-2-all'],
      perRunCostLimit: 0,
      dailyCostLimit: 0,
      concurrencyLimit: 1,
    });
    const blockedEditors = database.setRoomExecutionPolicy('project-local', 'canvas-authority', {
      expectedRevision: 0,
      allowEditorRuns: false,
      memberDailyRunLimit: 0,
      canvasConcurrencyLimit: 1,
      autoApproveLowRisk: false,
      highCostConfirmationThreshold: 0,
      requireUnknownCostConfirmation: true,
    });
    assert.throws(() => policy.authorize({
      projectId: 'project-local',
      canvasId: 'canvas-authority',
      requestedBy: 'member-editor',
      requesterRole: 'editor',
      provider: 'zhenzhen',
      model: 'gpt-image-2-all',
      estimatedCost: 0,
      enforceConcurrency: false,
    }), (error) => error.code === 'room_editor_runs_disabled');

    const configured = database.setRoomExecutionPolicy('project-local', 'canvas-authority', {
      expectedRevision: blockedEditors.revision,
      allowEditorRuns: true,
      memberDailyRunLimit: 1,
      canvasConcurrencyLimit: 1,
      autoApproveLowRisk: true,
      highCostConfirmationThreshold: 2,
      requireUnknownCostConfirmation: true,
    });
    assert.equal(configured.revision, 2);
    const lowRisk = policy.authorize({
      projectId: 'project-local',
      canvasId: 'canvas-authority',
      requestedBy: 'member-editor',
      requesterRole: 'editor',
      provider: 'zhenzhen',
      model: 'gpt-image-2-all',
      estimatedCost: 1,
      enforceConcurrency: false,
    });
    assert.deepEqual(lowRisk.confirmation, { required: false, lowRisk: true, reasons: [] });
    const highCost = policy.authorize({
      projectId: 'project-local',
      canvasId: 'canvas-authority',
      requestedBy: 'member-editor',
      requesterRole: 'editor',
      provider: 'zhenzhen',
      model: 'gpt-image-2-all',
      estimatedCost: 3,
      enforceConcurrency: false,
    });
    assert.deepEqual(highCost.confirmation, { required: true, lowRisk: false, reasons: ['high_cost'] });
    const unknown = policy.authorize({
      projectId: 'project-local',
      canvasId: 'canvas-authority',
      requestedBy: 'member-editor',
      requesterRole: 'editor',
      provider: 'zhenzhen',
      model: 'gpt-image-2-all',
      estimatedCostKnown: false,
      enforceConcurrency: false,
    });
    assert.deepEqual(unknown.confirmation, { required: true, lowRisk: false, reasons: ['cost_unknown'] });

    database.createRunIntent({
      projectId: 'project-local',
      canvasId: 'canvas-authority',
      canvasRevision: 1,
      idempotencyKey: 'room-member-limit-1',
      requestedBy: 'member-editor',
      provider: 'zhenzhen',
      model: 'gpt-image-2-all',
      estimatedCost: 0,
      confirmationRequired: false,
    });
    assert.throws(() => policy.authorize({
      projectId: 'project-local',
      canvasId: 'canvas-authority',
      requestedBy: 'member-editor',
      requesterRole: 'editor',
      provider: 'zhenzhen',
      model: 'gpt-image-2-all',
      estimatedCost: 0,
      enforceConcurrency: false,
    }), (error) => error.code === 'room_member_daily_run_limit');
  } finally {
    database.close();
  }
});

test('latest room policy requires durable human confirmation before a leased intent can run', () => {
  const database = new ProjectDatabase(':memory:');
  const policy = new HostExecutionPolicy(database);
  try {
    const canvas = ensureImageCanvas(database);
    insertMember(database, { canvasId: canvas.canvasId });
    database.setExecutionPolicy('project-local', {
      allowedModels: ['zhenzhen:gpt-image-2-all'],
      perRunCostLimit: 0,
      dailyCostLimit: 0,
      concurrencyLimit: 4,
    });
    const initialRoomPolicy = database.setRoomExecutionPolicy('project-local', canvas.canvasId, {
      expectedRevision: 0,
      allowEditorRuns: true,
      memberDailyRunLimit: 0,
      canvasConcurrencyLimit: 2,
      autoApproveLowRisk: true,
      highCostConfirmationThreshold: 0,
      requireUnknownCostConfirmation: false,
    });
    const intent = createAuthoritativeIntent(database, {
      canvas,
      id: 'policy-confirmation-drift',
      idempotencyKey: 'policy-confirmation-drift',
      confirmationRequired: false,
    });
    assert.equal(intent.status, 'accepted');
    assert.equal(intent.confirmationRequired, false);
    assert.doesNotThrow(() => policy.authorizeRunIntent(intent.id, {
      allowedStatuses: ['accepted'],
      reservationAlreadyCounted: true,
      requireConfirmationSatisfied: true,
    }));
    const lease = database.leaseRunIntentForDispatch(
      { projectId: intent.projectId, canvasId: intent.canvasId },
      { workerId: 'confirmation-drift-worker', canvasConcurrencyLimit: 2 },
    );
    assert.equal(lease.intent.id, intent.id);

    const tightened = database.setRoomExecutionPolicy('project-local', canvas.canvasId, {
      expectedRevision: initialRoomPolicy.revision,
      allowEditorRuns: true,
      memberDailyRunLimit: 0,
      canvasConcurrencyLimit: 2,
      autoApproveLowRisk: true,
      highCostConfirmationThreshold: 0,
      requireUnknownCostConfirmation: true,
    });
    assert.throws(() => policy.authorizeRunIntent(intent.id, {
      allowedStatuses: ['dispatching'],
      requireUnclaimed: true,
      reservationAlreadyCounted: true,
      requireConfirmationSatisfied: true,
    }), (error) => error instanceof ExecutionPolicyError
      && error.code === 'intent_confirmation_required'
      && error.httpStatus === 409
      && error.details.roomPolicyRevision === tightened.revision
      && error.details.confirmationRequired === false
      && error.details.confirmationSatisfied === false
      && error.details.reasons.includes('cost_unknown')
      && !JSON.stringify(error.details).includes(lease.leaseToken));
    assert.equal(database.getRunIntent(intent.id).status, 'dispatching');

    const pending = database.returnRunIntentToPendingConfirmation(intent.id, {
      projectId: intent.projectId,
      canvasId: intent.canvasId,
      expectedQueueRevision: lease.intent.queueRevision,
      workerId: 'confirmation-drift-worker',
      leaseToken: lease.leaseToken,
    });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.confirmationRequired, true);
    assert.throws(() => policy.authorizeRunIntent(intent.id, {
      allowedStatuses: ['pending'],
      reservationAlreadyCounted: true,
      requireConfirmationSatisfied: true,
    }), (error) => error.code === 'intent_confirmation_required');

    const accepted = database.acceptRunIntentForDispatch(intent.id, {
      projectId: intent.projectId,
      canvasId: intent.canvasId,
      expectedQueueRevision: pending.queueRevision,
      confirmedBy: 'local-owner',
    });
    assert.equal(accepted.confirmationRequired, true);
    assert.equal(Boolean(accepted.confirmedAt), true);
    assert.equal(accepted.confirmedBy, 'local-owner');
    const confirmedLease = database.leaseRunIntentForDispatch(
      { projectId: intent.projectId, canvasId: intent.canvasId },
      { workerId: 'confirmation-drift-worker', canvasConcurrencyLimit: 2 },
    );
    assert.doesNotThrow(() => policy.authorizeRunIntent(intent.id, {
      allowedStatuses: ['dispatching'],
      requireUnclaimed: true,
      reservationAlreadyCounted: true,
      requireConfirmationSatisfied: true,
    }));
    assert.equal(Object.hasOwn(confirmedLease.intent, 'leaseToken'), false);
  } finally {
    database.close();
  }
});

test('latest room concurrency excludes only the leased intent and fails closed after a 2-to-1 drift', () => {
  const database = new ProjectDatabase(':memory:');
  const policy = new HostExecutionPolicy(database);
  try {
    const canvas = ensureImageCanvas(database);
    insertMember(database, { canvasId: canvas.canvasId });
    database.setExecutionPolicy('project-local', {
      allowedModels: ['zhenzhen:gpt-image-2-all'],
      perRunCostLimit: 0,
      dailyCostLimit: 0,
      concurrencyLimit: 4,
    });
    let roomPolicy = database.setRoomExecutionPolicy('project-local', canvas.canvasId, {
      expectedRevision: 0,
      allowEditorRuns: true,
      memberDailyRunLimit: 0,
      canvasConcurrencyLimit: 2,
      autoApproveLowRisk: true,
      highCostConfirmationThreshold: 0,
      requireUnknownCostConfirmation: false,
    });
    const first = createAuthoritativeIntent(database, {
      canvas,
      id: 'room-concurrency-a',
      idempotencyKey: 'room-concurrency-a',
      confirmationRequired: false,
    });
    const second = createAuthoritativeIntent(database, {
      canvas,
      id: 'room-concurrency-b',
      idempotencyKey: 'room-concurrency-b',
      confirmationRequired: false,
    });
    const firstLease = database.leaseRunIntentForDispatch(
      { projectId: first.projectId, canvasId: first.canvasId },
      { workerId: 'room-worker-a', canvasConcurrencyLimit: 2 },
    );
    assert.equal(firstLease.intent.id, first.id);
    roomPolicy = database.setRoomExecutionPolicy('project-local', canvas.canvasId, {
      expectedRevision: roomPolicy.revision,
      allowEditorRuns: true,
      memberDailyRunLimit: 0,
      canvasConcurrencyLimit: 1,
      autoApproveLowRisk: true,
      highCostConfirmationThreshold: 0,
      requireUnknownCostConfirmation: false,
    });
    assert.doesNotThrow(() => policy.authorizeRunIntent(first.id, {
      allowedStatuses: ['dispatching'],
      reservationAlreadyCounted: true,
      requireConfirmationSatisfied: true,
    }), 'the currently leased intent is excluded exactly once from the latest room limit');
    assert.throws(() => policy.authorizeRunIntent(second.id, {
      allowedStatuses: ['accepted'],
      reservationAlreadyCounted: true,
      requireConfirmationSatisfied: true,
    }), (error) => error.code === 'concurrency_limit'
      && error.details.scope === 'room'
      && error.details.active === 1,
    'an accepted reservation must not subtract a different active lease');

    roomPolicy = database.setRoomExecutionPolicy('project-local', canvas.canvasId, {
      expectedRevision: roomPolicy.revision,
      allowEditorRuns: true,
      memberDailyRunLimit: 0,
      canvasConcurrencyLimit: 2,
      autoApproveLowRisk: true,
      highCostConfirmationThreshold: 0,
      requireUnknownCostConfirmation: false,
    });
    const secondLease = database.leaseRunIntentForDispatch(
      { projectId: second.projectId, canvasId: second.canvasId },
      { workerId: 'room-worker-b', canvasConcurrencyLimit: 2 },
    );
    assert.equal(secondLease.intent.id, second.id);
    roomPolicy = database.setRoomExecutionPolicy('project-local', canvas.canvasId, {
      expectedRevision: roomPolicy.revision,
      allowEditorRuns: true,
      memberDailyRunLimit: 0,
      canvasConcurrencyLimit: 1,
      autoApproveLowRisk: true,
      highCostConfirmationThreshold: 0,
      requireUnknownCostConfirmation: false,
    });
    assert.equal(roomPolicy.canvasConcurrencyLimit, 1);
    assert.throws(() => policy.authorizeRunIntent(second.id, {
      allowedStatuses: ['dispatching'],
      reservationAlreadyCounted: true,
      requireConfirmationSatisfied: true,
    }), (error) => error.code === 'concurrency_limit'
      && error.details.scope === 'room'
      && error.details.limit === 1
      && error.details.active === 1);
  } finally {
    database.close();
  }
});

test('room daily limit never subtracts a previous-day reservation from current-day usage', () => {
  const database = new ProjectDatabase(':memory:');
  const policy = new HostExecutionPolicy(database);
  try {
    const canvas = ensureImageCanvas(database);
    insertMember(database, { canvasId: canvas.canvasId });
    database.setExecutionPolicy('project-local', {
      allowedModels: ['zhenzhen:gpt-image-2-all'],
      perRunCostLimit: 0,
      dailyCostLimit: 0,
      concurrencyLimit: 4,
    });
    database.setRoomExecutionPolicy('project-local', canvas.canvasId, {
      expectedRevision: 0,
      allowEditorRuns: true,
      memberDailyRunLimit: 1,
      canvasConcurrencyLimit: 2,
      autoApproveLowRisk: true,
      highCostConfirmationThreshold: 0,
      requireUnknownCostConfirmation: false,
    });
    const previousDay = createAuthoritativeIntent(database, {
      canvas,
      id: 'room-daily-previous',
      idempotencyKey: 'room-daily-previous',
      confirmationRequired: false,
    });
    const currentDay = createAuthoritativeIntent(database, {
      canvas,
      id: 'room-daily-current',
      idempotencyKey: 'room-daily-current',
      confirmationRequired: false,
    });
    const tomorrow = new Date(Date.now() + 86_400_000);
    tomorrow.setHours(0, 0, 0, 0);
    const dayStart = tomorrow.getTime();
    database.db.prepare('UPDATE run_intents SET created_at = ? WHERE id = ?').run(dayStart - 1, previousDay.id);
    database.db.prepare('UPDATE run_intents SET created_at = ? WHERE id = ?').run(dayStart + 1, currentDay.id);
    assert.throws(() => policy.authorizeRunIntent(previousDay.id, {
      allowedStatuses: ['accepted'],
      reservationAlreadyCounted: true,
      enforceConcurrency: false,
      now: dayStart + 2,
    }), (error) => error.code === 'room_member_daily_run_limit'
      && error.details.used === 1
      && error.details.limit === 1);
  } finally {
    database.close();
  }
});

test('authoritative RunIntent validation ignores caller overrides, keeps its pinned revision, and rejects tightened member or host policy', () => {
  const createFixture = () => {
    const database = new ProjectDatabase(':memory:');
    const policy = new HostExecutionPolicy(database);
    const canvas = ensureImageCanvas(database);
    insertMember(database, { canvasId: canvas.canvasId });
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
      const authorized = policy.authorizeRunIntent(intent.id, {
        allowedStatuses: ['pending'],
        reservationAlreadyCounted: true,
      });
      assert.equal(authorized.canvas.revision, canvas.revision);
      assert.equal(authorized.currentCanvas.revision, canvas.revision + 1);
      assert.equal(database.getRunIntent(intent.id).status, 'pending');
    } finally {
      database.close();
    }
  }
});

test('final RunIntent authorization reopens the current recovery-generation fence before reading pinned input', () => {
  const database = new ProjectDatabase(':memory:');
  const policy = new HostExecutionPolicy(database);
  const originalGenerationReader = database.getRecoveryGeneration.bind(database);
  const originalSnapshotReader = database.getCanvasSnapshotDocument.bind(database);
  try {
    const canvas = ensureImageCanvas(database);
    insertMember(database, { canvasId: canvas.canvasId });
    database.setExecutionPolicy('project-local', {
      allowedModels: ['zhenzhen:gpt-image-2-all'],
      perRunCostLimit: 0,
      dailyCostLimit: 0,
      concurrencyLimit: 4,
    });
    const intent = createAuthoritativeIntent(database, {
      canvas,
      idempotencyKey: 'intent-generation-fence',
    });
    let snapshotReads = 0;
    database.getCanvasSnapshotDocument = (...args) => {
      snapshotReads += 1;
      return originalSnapshotReader(...args);
    };
    database.getRecoveryGeneration = () => {
      const error = new Error('forced current generation failure');
      error.code = 'project_database_recovery_generation_unavailable';
      error.status = 503;
      throw error;
    };

    assert.throws(
      () => policy.authorizeRunIntent(intent.id, {
        allowedStatuses: ['pending'],
        reservationAlreadyCounted: true,
      }),
      (error) => error instanceof ExecutionPolicyError
        && error.code === 'project_database_recovery_generation_unavailable'
        && error.httpStatus === 503,
    );
    assert.equal(snapshotReads, 0, 'generation failure must stop before historical input is read');
  } finally {
    database.getRecoveryGeneration = originalGenerationReader;
    database.getCanvasSnapshotDocument = originalSnapshotReader;
    database.close();
  }
});
