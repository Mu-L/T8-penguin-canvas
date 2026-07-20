const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { deriveRunIntentAuthority, summarizeRunIntentAuthority } = require('../backend/src/collaboration/runIntentAuthority');
const {
  createFixture,
  joinSocket,
  openSocketProbe,
  redeemActor,
  requestJson,
  TEST_MANAGEMENT_AUTHORITY,
} = require('./helpers/collaborationF2Fixture.cjs');

const PROJECT_ID = 'project-execution-queue-f7';
const CANVAS_ID = 'canvas-execution-queue-f7';
const SIBLING_CANVAS_ID = 'canvas-execution-queue-f7-sibling';
const OTHER_PROJECT_ID = 'project-execution-queue-f7-other';
const OTHER_CANVAS_ID = 'canvas-execution-queue-f7-other';
const MODEL_SECRET = 'F7_PRIVATE_MODEL_MUST_BE_HIDDEN';
const PROVIDER_SECRET = 'F7_PRIVATE_PROVIDER_MUST_BE_HIDDEN';
const PROMPT_SECRET = 'F7_PRIVATE_PROMPT_MUST_BE_HIDDEN';

function imageSnapshot() {
  return {
    name: 'F7 execution queue',
    nodes: [{
      id: 'image-node',
      type: 'image',
      position: { x: 0, y: 0 },
      data: { model: 'gpt-image-2', apiModel: 'gpt-image-2-all' },
    }],
    edges: [],
  };
}

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

function loadRouterFactory(gateway) {
  const restoreGateway = installModuleMock('../backend/src/collaboration/gateway', {
    getCollaborationGateway: () => gateway,
  });
  const routePath = require.resolve('../backend/src/routes/collaboration');
  const previousRoute = require.cache[routePath];
  delete require.cache[routePath];
  try {
    return require(routePath).createCollaborationRouter;
  } finally {
    restoreGateway();
    if (previousRoute) require.cache[routePath] = previousRoute;
    else delete require.cache[routePath];
  }
}

async function attachManagementServer(t, fixture) {
  const createCollaborationRouter = loadRouterFactory(fixture.gateway);
  const app = express();
  app.use(express.json({ strict: true }));
  app.use('/api/collaboration', createCollaborationRouter(fixture.gateway, {
    managementAuthority: TEST_MANAGEMENT_AUTHORITY,
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/api/collaboration`;
}

async function createExecutionFixture(t) {
  const fixture = await createFixture(t, {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    snapshot: imageSnapshot(),
  });
  fixture.managementBase = await attachManagementServer(t, fixture);
  fixture.database.setExecutionPolicy(PROJECT_ID, {
    allowedModels: ['zhenzhen:gpt-image-2-all'],
    dailyCostLimit: 0,
    perRunCostLimit: 0,
    concurrencyLimit: 8,
  }, {
    actorId: 'local-owner',
    sessionId: 'f7-test',
  });
  return fixture;
}

function createAuthoritativeIntent(fixture, actor, suffix, options = {}) {
  const canvas = fixture.database.getCanvas(CANVAS_ID);
  const authority = deriveRunIntentAuthority(canvas, ['image-node']);
  const summary = summarizeRunIntentAuthority(authority);
  return fixture.database.createRunIntent({
    id: `f7-intent-${suffix}`,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    canvasRevision: canvas.revision,
    nodeIds: authority.requestedNodeIds,
    idempotencyKey: `f7-execution-${suffix}`,
    requestedBy: actor.memberId,
    provider: summary.provider,
    model: summary.model,
    estimatedCost: summary.estimatedCost,
    estimatedCostKnown: summary.estimatedCostKnown,
    executionAuthority: authority,
    confirmationRequired: options.confirmationRequired !== false,
  });
}

async function managementPost(fixture, pathname, body) {
  return requestJson(`${fixture.managementBase}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function assertNoLeaseAuthority(value, forbiddenValues = []) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /leaseToken|lease_token|leaseOwner|lease_owner/i);
  for (const forbidden of forbiddenValues) assert.equal(serialized.includes(String(forbidden)), false);
}

test('F7 room execution policy requires a complete document and exact CAS revision', async (t) => {
  const fixture = await createExecutionFixture(t);

  const initial = await requestJson(
    `${fixture.managementBase}/room-execution-policy?projectId=${PROJECT_ID}&canvasId=${CANVAS_ID}`,
  );
  assert.equal(initial.response.status, 200, initial.text);
  assert.deepEqual(initial.payload.data.policy, {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    allowEditorRuns: true,
    memberDailyRunLimit: 0,
    canvasConcurrencyLimit: 1,
    autoApproveLowRisk: false,
    highCostConfirmationThreshold: 0,
    requireUnknownCostConfirmation: true,
    revision: 0,
    updatedBy: null,
    updatedAt: null,
  });

  const fullPolicy = {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    expectedRevision: 0,
    allowEditorRuns: true,
    memberDailyRunLimit: 7,
    canvasConcurrencyLimit: 2,
    autoApproveLowRisk: true,
    highCostConfirmationThreshold: 12.5,
    requireUnknownCostConfirmation: true,
  };
  const incomplete = await requestJson(`${fixture.managementBase}/room-execution-policy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...fullPolicy, requireUnknownCostConfirmation: undefined }),
  });
  assert.equal(incomplete.response.status, 400);
  assert.equal(incomplete.payload.code, 'room_execution_policy_invalid');

  const extra = await requestJson(`${fixture.managementBase}/room-execution-policy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...fullPolicy, unexpectedAuthority: true }),
  });
  assert.equal(extra.response.status, 400);
  assert.equal(extra.payload.code, 'room_execution_policy_invalid');

  const updated = await requestJson(`${fixture.managementBase}/room-execution-policy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fullPolicy),
  });
  assert.equal(updated.response.status, 200, updated.text);
  assert.equal(updated.payload.data.revision, 1);
  assert.equal(updated.payload.data.memberDailyRunLimit, 7);
  assert.equal(updated.payload.data.canvasConcurrencyLimit, 2);

  const stale = await requestJson(`${fixture.managementBase}/room-execution-policy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...fullPolicy, memberDailyRunLimit: 9 }),
  });
  assert.equal(stale.response.status, 409, stale.text);
  assert.equal(stale.payload.code, 'room_execution_policy_conflict');
  assert.equal(fixture.database.getRoomExecutionPolicy(PROJECT_ID, CANVAS_ID).memberDailyRunLimit, 7);
  assert.equal(
    fixture.database.listAuditEvents({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      action: 'collaboration.room-execution-policy.update',
    }).length,
    1,
  );
});

test('F7 management queue is FIFO, renewable, cancellable, and never republishes lease authority', async (t) => {
  const fixture = await createExecutionFixture(t);
  const actor = await redeemActor(fixture, 'editor', 'F7 queue editor');
  const otherActor = await redeemActor(fixture, 'editor', 'F7 other editor');
  const probe = await openSocketProbe(fixture, actor, { label: 'F7 queue socket' });
  await joinSocket(probe, CANVAS_ID, 0);

  const first = createAuthoritativeIntent(fixture, actor, 'fifo-a');
  const second = createAuthoritativeIntent(fixture, actor, 'fifo-b');
  const legacyBypass = createAuthoritativeIntent(fixture, actor, 'legacy-bypass');
  const bypassAttempt = await requestJson(
    `${fixture.managementBase}/run-intents/${encodeURIComponent(legacyBypass.id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        status: 'rejected',
      }),
    },
  );
  assert.notEqual(bypassAttempt.response.status, 200, 'legacy non-CAS queue mutation must be closed');
  assert.equal(fixture.database.getRunIntent(legacyBypass.id).status, 'pending');
  const exactInvalidation = await requestJson(
    `${fixture.managementBase}/run-intents/${encodeURIComponent(legacyBypass.id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        expectedQueueRevision: legacyBypass.queueRevision,
        status: 'rejected',
      }),
    },
  );
  assert.equal(exactInvalidation.response.status, 200, exactInvalidation.text);
  assert.equal(exactInvalidation.payload.data.status, 'rejected');
  assert.equal(exactInvalidation.payload.data.queueRevision, legacyBypass.queueRevision + 1);
  const staleInvalidation = await requestJson(
    `${fixture.managementBase}/run-intents/${encodeURIComponent(legacyBypass.id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        expectedQueueRevision: legacyBypass.queueRevision,
        status: 'stale',
      }),
    },
  );
  assert.equal(staleInvalidation.response.status, 409, staleInvalidation.text);
  assert.equal(staleInvalidation.payload.code, 'run_intent_queue_cas_conflict');

  const noFailedBypass = createAuthoritativeIntent(fixture, actor, 'no-failed-bypass');
  const acceptedNoFailedBypass = await managementPost(
    fixture,
    `/run-intents/${encodeURIComponent(noFailedBypass.id)}/accept`,
    { projectId: PROJECT_ID, canvasId: CANVAS_ID, expectedQueueRevision: 1 },
  );
  assert.equal(acceptedNoFailedBypass.response.status, 200, acceptedNoFailedBypass.text);
  const failedBypass = await requestJson(
    `${fixture.managementBase}/run-intents/${encodeURIComponent(noFailedBypass.id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        expectedQueueRevision: acceptedNoFailedBypass.payload.data.queueRevision,
        status: 'failed',
      }),
    },
  );
  assert.equal(failedBypass.response.status, 400, failedBypass.text);
  assert.equal(failedBypass.payload.code, 'run_intent_queue_transition_invalid');
  assert.equal(fixture.database.getRunIntent(noFailedBypass.id).status, 'accepted');
  const createdAt = Date.now() - 1000;
  fixture.database.db.prepare(
    'UPDATE run_intents SET created_at = ?, updated_at = ? WHERE id IN (?, ?)',
  ).run(createdAt, createdAt, first.id, second.id);

  for (const intent of [first, second]) {
    const accepted = await managementPost(
      fixture,
      `/run-intents/${encodeURIComponent(intent.id)}/accept`,
      { projectId: PROJECT_ID, canvasId: CANVAS_ID, expectedQueueRevision: 1 },
    );
    assert.equal(accepted.response.status, 200, accepted.text);
    assert.equal(accepted.payload.data.status, 'accepted');
    assert.equal(accepted.payload.data.queueRevision, 2);
  }

  const skippedFifo = await managementPost(fixture, '/run-intents/lease', {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    workerId: 'worker-f7-cannot-skip',
    expectedIntentId: second.id,
    leaseDurationMs: 60_000,
  });
  assert.equal(skippedFifo.response.status, 200, skippedFifo.text);
  assert.equal(skippedFifo.payload.data, null, 'an exact-intent hint must never skip an older eligible item');
  assert.equal(fixture.database.getRunIntent(first.id).status, 'accepted');
  assert.equal(fixture.database.getRunIntent(second.id).status, 'accepted');

  const leasedFirst = await managementPost(fixture, '/run-intents/lease', {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    workerId: 'worker-f7-private',
    leaseDurationMs: 60_000,
  });
  assert.equal(leasedFirst.response.status, 200, leasedFirst.text);
  assert.equal(leasedFirst.payload.data.intent.id, first.id, 'oldest accepted intent must lease first');
  assert.match(leasedFirst.payload.data.lease.token, /^[0-9a-f-]{36}$/);
  assert.equal(leasedFirst.payload.data.lease.owner, 'worker-f7-private');
  const leaseToken = leasedFirst.payload.data.lease.token;
  const leasedRevision = leasedFirst.payload.data.intent.queueRevision;
  const broadcast = await probe.nextMessage(
    (message) => message.type === 'run.intent-state'
      && message.intent?.id === first.id
      && message.intent?.status === 'dispatching',
    `F7 dispatch broadcast timed out; buffered=${JSON.stringify(probe.messages)}`,
  );
  assertNoLeaseAuthority(broadcast, [leaseToken, 'worker-f7-private']);

  const missingProjectScope = await requestJson(
    `${fixture.managementBase}/run-intents/${encodeURIComponent(first.id)}?canvasId=${CANVAS_ID}`,
  );
  assert.equal(missingProjectScope.response.status, 400, missingProjectScope.text);
  const missingCanvasScope = await requestJson(
    `${fixture.managementBase}/run-intents/${encodeURIComponent(first.id)}?projectId=${PROJECT_ID}`,
  );
  assert.equal(missingCanvasScope.response.status, 400, missingCanvasScope.text);
  const wrongProjectScope = await requestJson(
    `${fixture.managementBase}/run-intents/${encodeURIComponent(first.id)}?projectId=${OTHER_PROJECT_ID}&canvasId=${CANVAS_ID}`,
  );
  assert.equal(wrongProjectScope.response.status, 404, wrongProjectScope.text);
  assert.equal(wrongProjectScope.payload.code, 'run_intent_not_found');
  const wrongCanvasScope = await requestJson(
    `${fixture.managementBase}/run-intents/${encodeURIComponent(first.id)}?projectId=${PROJECT_ID}&canvasId=${SIBLING_CANVAS_ID}`,
  );
  assert.equal(wrongCanvasScope.response.status, 404, wrongCanvasScope.text);
  assert.equal(wrongCanvasScope.payload.code, 'run_intent_not_found');
  const exactIntent = await requestJson(
    `${fixture.managementBase}/run-intents/${encodeURIComponent(first.id)}?projectId=${PROJECT_ID}&canvasId=${CANVAS_ID}`,
  );
  assert.equal(exactIntent.response.status, 200, exactIntent.text);
  assert.equal(exactIntent.response.headers.get('cache-control'), 'no-store');
  assert.equal(exactIntent.payload.data.id, first.id);
  assert.equal(exactIntent.payload.data.status, 'dispatching');
  assertNoLeaseAuthority(exactIntent.payload, [leaseToken, 'worker-f7-private']);

  const listed = await requestJson(
    `${fixture.managementBase}/run-intents?projectId=${PROJECT_ID}&canvasId=${CANVAS_ID}&status=actionable`,
  );
  assert.equal(listed.response.status, 200, listed.text);
  assertNoLeaseAuthority(listed.payload, [leaseToken, 'worker-f7-private']);

  const leaseAudits = fixture.database.listAuditEvents({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    action: 'run-intent.dispatch.lease',
  });
  assert.equal(leaseAudits.length, 1);
  assertNoLeaseAuthority(leaseAudits, [leaseToken, 'worker-f7-private']);

  const renewed = await managementPost(
    fixture,
    `/run-intents/${encodeURIComponent(first.id)}/lease/renew`,
    {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      expectedQueueRevision: leasedRevision,
      workerId: 'worker-f7-private',
      leaseToken,
      leaseDurationMs: 60_000,
    },
  );
  assert.equal(renewed.response.status, 200, renewed.text);
  assert.equal(renewed.payload.data.intent.queueRevision, leasedRevision + 1);
  assert.equal(JSON.stringify(renewed.payload).includes(leaseToken), false, 'renew must not return the token again');

  const released = await managementPost(
    fixture,
    `/run-intents/${encodeURIComponent(first.id)}/lease/release`,
    {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      expectedQueueRevision: renewed.payload.data.intent.queueRevision,
      workerId: 'worker-f7-private',
      leaseToken,
      retryable: false,
      errorCode: 'worker_declined',
      errorMessage: 'test release',
    },
  );
  assert.equal(released.response.status, 200, released.text);
  assert.equal(released.payload.data.status, 'failed');
  assertNoLeaseAuthority(released.payload, [leaseToken, 'worker-f7-private']);

  const leasedSecond = await managementPost(fixture, '/run-intents/lease', {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    workerId: 'worker-f7-second',
    leaseDurationMs: 60_000,
  });
  assert.equal(leasedSecond.response.status, 200, leasedSecond.text);
  assert.equal(leasedSecond.payload.data.intent.id, second.id);
  const secondToken = leasedSecond.payload.data.lease.token;
  const cancelSecond = await managementPost(
    fixture,
    `/run-intents/${encodeURIComponent(second.id)}/cancel`,
    {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      expectedQueueRevision: leasedSecond.payload.data.intent.queueRevision,
    },
  );
  assert.equal(cancelSecond.response.status, 200, cancelSecond.text);
  assert.equal(cancelSecond.payload.data.status, 'dispatching');
  assert.ok(cancelSecond.payload.data.cancelRequestedAt > 0);
  const cancelRelease = await managementPost(
    fixture,
    `/run-intents/${encodeURIComponent(second.id)}/lease/release`,
    {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      expectedQueueRevision: cancelSecond.payload.data.queueRevision,
      workerId: 'worker-f7-second',
      leaseToken: secondToken,
      retryable: true,
    },
  );
  assert.equal(cancelRelease.response.status, 200, cancelRelease.text);
  assert.equal(cancelRelease.payload.data.status, 'cancelled');

  const ownIntent = createAuthoritativeIntent(fixture, actor, 'public-cancel');
  const wrongActorCancel = await requestJson(
    `${fixture.baseUrl}/api/collab/run-intents/${encodeURIComponent(ownIntent.id)}/cancel`,
    {
      method: 'POST',
      headers: { cookie: otherActor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedQueueRevision: ownIntent.queueRevision }),
    },
  );
  assert.equal(wrongActorCancel.response.status, 404);
  const staleOwnCancel = await requestJson(
    `${fixture.baseUrl}/api/collab/run-intents/${encodeURIComponent(ownIntent.id)}/cancel`,
    {
      method: 'POST',
      headers: { cookie: actor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedQueueRevision: ownIntent.queueRevision + 1 }),
    },
  );
  assert.equal(staleOwnCancel.response.status, 409);
  assert.equal(staleOwnCancel.payload.code, 'run_intent_queue_cas_conflict');
  const ownCancel = await requestJson(
    `${fixture.baseUrl}/api/collab/run-intents/${encodeURIComponent(ownIntent.id)}/cancel`,
    {
      method: 'POST',
      headers: { cookie: actor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedQueueRevision: ownIntent.queueRevision }),
    },
  );
  assert.equal(ownCancel.response.status, 200, ownCancel.text);
  assert.equal(ownCancel.payload.data.status, 'cancelled');
  assert.equal(ownCancel.payload.data.queueRevision, ownIntent.queueRevision + 1);
});

test('F7 lease rechecks policy drift and atomically returns an auto-approved intent to confirmation', async (t) => {
  const fixture = await createExecutionFixture(t);
  const actor = await redeemActor(fixture, 'editor', 'F7 policy drift editor');
  const probe = await openSocketProbe(fixture, actor, { label: 'F7 policy drift socket' });
  await joinSocket(probe, CANVAS_ID, 0);

  const lowRiskPolicy = {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    expectedRevision: 0,
    allowEditorRuns: true,
    memberDailyRunLimit: 0,
    canvasConcurrencyLimit: 2,
    autoApproveLowRisk: true,
    highCostConfirmationThreshold: 0,
    requireUnknownCostConfirmation: false,
  };
  const enabledAutoApproval = await requestJson(`${fixture.managementBase}/room-execution-policy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(lowRiskPolicy),
  });
  assert.equal(enabledAutoApproval.response.status, 200, enabledAutoApproval.text);
  assert.equal(enabledAutoApproval.payload.data.revision, 1);

  const canvas = fixture.database.getCanvas(CANVAS_ID);
  const created = await requestJson(`${fixture.baseUrl}/api/collab/run-intents`, {
    method: 'POST',
    headers: { cookie: actor.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      canvasId: CANVAS_ID,
      canvasRevision: canvas.revision,
      nodeIds: ['image-node'],
      idempotencyKey: 'f7-policy-drift-auto-approved',
    }),
  });
  assert.equal(created.response.status, 202, created.text);
  assert.equal(created.payload.data.status, 'accepted');
  assert.equal(created.payload.data.confirmationRequired, false);
  assert.equal(created.payload.data.queueRevision, 1);

  const tightened = await requestJson(`${fixture.managementBase}/room-execution-policy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...lowRiskPolicy,
      expectedRevision: 1,
      requireUnknownCostConfirmation: true,
    }),
  });
  assert.equal(tightened.response.status, 200, tightened.text);
  assert.equal(tightened.payload.data.revision, 2);

  const workerId = 'worker-f7-policy-drift-secret';
  const originalRequeue = fixture.database.returnRunIntentToPendingConfirmation.bind(fixture.database);
  let observedRequeue = null;
  fixture.database.returnRunIntentToPendingConfirmation = (intentId, options) => {
    const raw = fixture.database.db.prepare(`
      SELECT status, queue_revision, lease_owner, lease_token, lease_expires_at
      FROM run_intents WHERE id = ?
    `).get(intentId);
    observedRequeue = { intentId, options: { ...options }, raw: { ...raw } };
    return originalRequeue(intentId, options);
  };
  t.after(() => {
    fixture.database.returnRunIntentToPendingConfirmation = originalRequeue;
  });

  const lease = await managementPost(fixture, '/run-intents/lease', {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    workerId,
    expectedIntentId: created.payload.data.id,
    leaseDurationMs: 60_000,
  });
  assert.equal(lease.response.status, 409, lease.text);
  assert.equal(lease.payload.code, 'intent_confirmation_required');
  assert.ok(observedRequeue, 'policy drift must invoke the exact lease-to-confirmation CAS path');
  assert.equal(observedRequeue.intentId, created.payload.data.id);
  assert.equal(observedRequeue.raw.status, 'dispatching');
  assert.equal(observedRequeue.raw.queue_revision, 2);
  assert.equal(observedRequeue.raw.lease_owner, workerId);
  assert.match(observedRequeue.raw.lease_token, /^[0-9a-f-]{36}$/);
  assert.ok(observedRequeue.raw.lease_expires_at > Date.now());
  assert.equal(observedRequeue.options.expectedQueueRevision, observedRequeue.raw.queue_revision);
  assert.equal(observedRequeue.options.workerId, observedRequeue.raw.lease_owner);
  assert.equal(observedRequeue.options.leaseToken, observedRequeue.raw.lease_token);
  assertNoLeaseAuthority(lease.payload, [observedRequeue.raw.lease_token, workerId]);

  const current = fixture.database.getRunIntent(created.payload.data.id);
  assert.equal(current.status, 'pending');
  assert.equal(current.queueRevision, 3);
  assert.equal(current.confirmationRequired, true);
  assert.equal(current.confirmedAt, null);
  assert.equal(current.confirmedBy, null);
  assert.equal(current.runId, null);
  assert.equal(current.nextAttemptAt, 0);
  assert.equal(current.leaseExpiresAt, null);
  assert.equal(current.lastHeartbeatAt, null);
  const rawCurrent = fixture.database.db.prepare(`
    SELECT lease_owner, lease_token, lease_expires_at, confirmed_at, confirmed_by
    FROM run_intents WHERE id = ?
  `).get(current.id);
  assert.deepEqual(rawCurrent, {
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    confirmed_at: null,
    confirmed_by: null,
  });

  const pendingBroadcast = await probe.nextMessage(
    (message) => message.type === 'run.intent-state'
      && message.intent?.id === current.id
      && message.intent?.status === 'pending'
      && message.intent?.confirmationRequired === true,
    `F7 policy requeue broadcast timed out; buffered=${JSON.stringify(probe.messages)}`,
  );
  assertNoLeaseAuthority(pendingBroadcast, [observedRequeue.raw.lease_token, workerId]);

  const queueAudits = fixture.database.listAuditEvents({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    limit: 1000,
  }).filter((event) => event.action === 'run-intent.dispatch.lease'
    || event.action === 'run-intent.confirmation.requeue');
  assert.deepEqual(queueAudits.map((event) => event.action).sort(), [
    'run-intent.confirmation.requeue',
    'run-intent.dispatch.lease',
  ]);
  assertNoLeaseAuthority(queueAudits, [observedRequeue.raw.lease_token, workerId]);
  const requeueAudit = queueAudits.find((event) => event.action === 'run-intent.confirmation.requeue');
  assert.deepEqual(requeueAudit.metadata, {
    previousStatus: 'dispatching',
    status: 'pending',
    previousQueueRevision: 2,
    queueRevision: 3,
    confirmationRequired: true,
  });
});

test('F7 public run snapshot, cursor sync, and detail stay room-scoped and review-redacted', async (t) => {
  const fixture = await createExecutionFixture(t);
  fixture.database.ensureCanvas(
    SIBLING_CANVAS_ID,
    { name: 'F7 sibling', nodes: [], edges: [] },
    PROJECT_ID,
  );
  fixture.database.ensureCanvas(
    OTHER_CANVAS_ID,
    { name: 'F7 other', nodes: [], edges: [] },
    OTHER_PROJECT_ID,
  );

  const run = fixture.database.createRun({
    id: 'f7-visible-run',
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    canvasRevision: 1,
    initiatorId: 'local-owner',
    status: 'running',
  });
  const nodeRun = fixture.database.createNodeRun({
    id: 'f7-visible-node-run',
    runId: run.id,
    nodeId: 'image-node',
    status: 'polling',
  });
  fixture.database.createAttempt({
    id: 'f7-visible-attempt',
    nodeRunId: nodeRun.id,
    provider: PROVIDER_SECRET,
    model: MODEL_SECRET,
    status: 'polling',
    usage: { prompt: PROMPT_SECRET, temperature: 0.75 },
  });
  const visibleEvent = fixture.database.appendRunEvent(run.id, {
    nodeRunId: nodeRun.id,
    type: 'node.polling',
    payload: {
      prompt: PROMPT_SECRET,
      model: MODEL_SECRET,
      provider: PROVIDER_SECRET,
      progress: 0.5,
    },
  });
  const siblingRun = fixture.database.createRun({
    id: 'f7-sibling-run',
    projectId: PROJECT_ID,
    canvasId: SIBLING_CANVAS_ID,
    canvasRevision: 1,
    initiatorId: 'local-owner',
    status: 'queued',
  });
  fixture.database.appendRunEvent(siblingRun.id, { type: 'run.queued', payload: { status: 'queued' } });
  const otherRun = fixture.database.createRun({
    id: 'f7-other-run',
    projectId: OTHER_PROJECT_ID,
    canvasId: OTHER_CANVAS_ID,
    canvasRevision: 1,
    initiatorId: 'local-owner',
    status: 'queued',
  });
  fixture.database.appendRunEvent(otherRun.id, { type: 'run.queued', payload: { status: 'queued' } });
  fixture.database.setProjectReviewVisibilityPolicy(PROJECT_ID, {
    expectedRevision: 0,
    hidePrompts: true,
    hideModelParameters: true,
  }, {
    actorId: 'local-owner',
    sessionId: 'f7-test',
  });

  const reviewer = await redeemActor(fixture, 'reviewer', 'F7 run reviewer');
  const editor = await redeemActor(fixture, 'editor', 'F7 run editor');
  const reviewerHeaders = { cookie: reviewer.cookie };
  const editorHeaders = { cookie: editor.cookie };

  const snapshot = await requestJson(`${fixture.baseUrl}/api/collab/runs?limit=20`, {
    headers: reviewerHeaders,
  });
  assert.equal(snapshot.response.status, 200, snapshot.text);
  assert.deepEqual(snapshot.payload.data.map((entry) => entry.id), [run.id]);
  assert.equal(snapshot.text.includes(SIBLING_CANVAS_ID), false);
  assert.equal(snapshot.text.includes(OTHER_PROJECT_ID), false);

  const reviewerDetail = await requestJson(
    `${fixture.baseUrl}/api/collab/runs/${encodeURIComponent(run.id)}`,
    { headers: reviewerHeaders },
  );
  assert.equal(reviewerDetail.response.status, 200, reviewerDetail.text);
  assert.equal(reviewerDetail.text.includes(PROMPT_SECRET), false);
  assert.equal(reviewerDetail.text.includes(MODEL_SECRET), false);
  assert.equal(reviewerDetail.text.includes(PROVIDER_SECRET), false);
  assert.equal(reviewerDetail.payload.data.nodes[0].attempts[0].model, '[由主机隐藏]');
  assert.equal(reviewerDetail.payload.data.nodes[0].attempts[0].provider, '[由主机隐藏]');

  const editorDetail = await requestJson(
    `${fixture.baseUrl}/api/collab/runs/${encodeURIComponent(run.id)}`,
    { headers: editorHeaders },
  );
  assert.equal(editorDetail.response.status, 200, editorDetail.text);
  assert.equal(editorDetail.payload.data.nodes[0].attempts[0].model, MODEL_SECRET);
  assert.equal(editorDetail.payload.data.nodes[0].attempts[0].provider, PROVIDER_SECRET);
  assert.equal(editorDetail.text.includes(PROMPT_SECRET), true);

  const siblingDetail = await requestJson(
    `${fixture.baseUrl}/api/collab/runs/${encodeURIComponent(siblingRun.id)}`,
    { headers: reviewerHeaders },
  );
  assert.equal(siblingDetail.response.status, 404);

  const reviewerSync = await requestJson(
    `${fixture.baseUrl}/api/collab/runs/sync?afterEventId=0&limit=100`,
    { headers: reviewerHeaders },
  );
  assert.equal(reviewerSync.response.status, 200, reviewerSync.text);
  assert.deepEqual(reviewerSync.payload.data.map((entry) => entry.runId), [run.id]);
  assert.equal(reviewerSync.payload.data[0].id, visibleEvent.id);
  assert.equal(reviewerSync.text.includes(PROMPT_SECRET), false);
  assert.equal(reviewerSync.text.includes(MODEL_SECRET), false);
  assert.equal(reviewerSync.text.includes(PROVIDER_SECRET), false);
  assert.equal(reviewerSync.payload.data[0].payload.progress, 0.5);

  const editorSync = await requestJson(
    `${fixture.baseUrl}/api/collab/runs/sync?afterEventId=0&limit=100`,
    { headers: editorHeaders },
  );
  assert.equal(editorSync.response.status, 200, editorSync.text);
  assert.equal(editorSync.text.includes(PROMPT_SECRET), true);
  assert.equal(editorSync.text.includes(MODEL_SECRET), true);
  assert.equal(editorSync.text.includes(PROVIDER_SECRET), true);

  const caughtUp = await requestJson(
    `${fixture.baseUrl}/api/collab/runs/sync?afterEventId=${visibleEvent.id}&limit=100`,
    { headers: reviewerHeaders },
  );
  assert.equal(caughtUp.response.status, 200, caughtUp.text);
  assert.deepEqual(caughtUp.payload.data, []);
  assert.equal(caughtUp.payload.meta.nextCursor, visibleEvent.id);
});
