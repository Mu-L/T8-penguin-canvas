const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const { HostExecutionPolicy } = require('../backend/src/collaboration/executionPolicy');
const { deriveRunIntentAuthority, summarizeRunIntentAuthority } = require('../backend/src/collaboration/runIntentAuthority');

const PROJECT_ID = 'project-runs-lease-f7';
const CANVAS_ID = 'canvas-runs-lease-f7';
const MEMBER_ID = 'member-runs-lease-f7';

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

function insertMember(database) {
  const now = Date.now();
  database.db.prepare(`
    INSERT INTO collaboration_members(
      id, project_id, canvas_id, display_name, role, capabilities_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    MEMBER_ID,
    PROJECT_ID,
    CANVAS_ID,
    'F7 run worker member',
    'editor',
    JSON.stringify(['runWorkflow']),
    now,
    now,
  );
}

function createDatabase() {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  database.ensureCanvas(CANVAS_ID, {
    name: 'F7 project Runs lease',
    nodes: [{
      id: 'image-node',
      type: 'image',
      position: { x: 0, y: 0 },
      data: { model: 'gpt-image-2', apiModel: 'gpt-image-2-all' },
    }],
    edges: [],
  }, PROJECT_ID);
  insertMember(database);
  database.setExecutionPolicy(PROJECT_ID, {
    allowedModels: ['zhenzhen:gpt-image-2-all'],
    dailyCostLimit: 0,
    perRunCostLimit: 0,
    concurrencyLimit: 8,
  }, {
    actorId: 'local-owner',
    sessionId: 'f7-test',
  });
  database.setRoomExecutionPolicy(PROJECT_ID, CANVAS_ID, {
    expectedRevision: 0,
    allowEditorRuns: true,
    memberDailyRunLimit: 0,
    canvasConcurrencyLimit: 8,
    autoApproveLowRisk: false,
    highCostConfirmationThreshold: 0,
    requireUnknownCostConfirmation: true,
  }, {
    actorId: 'local-owner',
    sessionId: 'f7-test',
  });
  return database;
}

function createIntent(database, suffix) {
  const canvas = database.getCanvas(CANVAS_ID);
  const authority = deriveRunIntentAuthority(canvas, ['image-node']);
  const summary = summarizeRunIntentAuthority(authority);
  const pending = database.createRunIntent({
    id: `f7-project-run-intent-${suffix}`,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    canvasRevision: canvas.revision,
    nodeIds: authority.requestedNodeIds,
    idempotencyKey: `f7-project-run-${suffix}`,
    requestedBy: MEMBER_ID,
    provider: summary.provider,
    model: summary.model,
    estimatedCost: summary.estimatedCost,
    estimatedCostKnown: summary.estimatedCostKnown,
    executionAuthority: authority,
    confirmationRequired: true,
  });
  database.acceptRunIntentForDispatch(pending.id, {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    expectedQueueRevision: pending.queueRevision,
    confirmedBy: 'local-owner',
    sessionId: 'f7-test',
  });
  const leased = database.leaseRunIntentForDispatch(
    { projectId: PROJECT_ID, canvasId: CANVAS_ID },
    {
      workerId: `worker-${suffix}`,
      leaseDurationMs: 60_000,
      canvasConcurrencyLimit: 8,
      actorId: 'local-owner',
      sessionId: 'f7-test',
    },
  );
  assert.equal(leased.intent.id, pending.id);
  return {
    intent: leased.intent,
    token: leased.leaseToken,
    owner: `worker-${suffix}`,
  };
}

function gatewayStub(database) {
  return {
    database,
    executionPolicy: new HostExecutionPolicy(database),
    broadcastHostRunIntent() {},
    broadcastHostRunState() {},
    broadcastHostNodeRunState() {},
    broadcastHostRunOutput() {},
  };
}

async function createRunServer(t, database, options = {}) {
  const gateway = { ...gatewayStub(database), ...(options.gateway || {}) };
  const restores = [
    installModuleMock('../backend/src/services/projectDatabase', { getProjectDatabase: () => database }),
    installModuleMock('../backend/src/services/assetPreviewPipeline', { getAssetPreviewPipeline: () => ({}) }),
    installModuleMock('../backend/src/services/assetIndexer', {
      getBackgroundAssetIndexer: () => ({
        commitHostRunOutputAssets: async () => ({ nodeRun: {}, assets: [] }),
        recordRunOutputAssets: async () => ({ nodeRun: {}, assets: [] }),
      }),
    }),
    installModuleMock('../backend/src/collaboration/gateway', { getCollaborationGateway: () => gateway }),
    installModuleMock('../backend/src/services/runRecovery', {
      getRunRecoveryManager: () => ({
        status: () => ({}),
        recoverPendingRuns: async () => ({}),
      }),
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
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/api/project-runs`;
}

async function postClaim(baseUrl, lease, suffix, overrides = {}) {
  const claim = {
    intentId: lease.intent.id,
    expectedQueueRevision: lease.intent.queueRevision,
    leaseToken: lease.token,
    leaseOwner: lease.owner,
    ...(overrides.claim || {}),
  };
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: `f7-host-run-${suffix}`,
      projectId: 'forged-project',
      canvasId: 'forged-canvas',
      canvasRevision: 999,
      initiatorId: 'forged-initiator',
      summary: {
        runIntentId: lease.intent.id,
        safeLabel: suffix,
        ...(overrides.summary || {}),
      },
      runIntentClaim: claim,
    }),
  });
  return { response, payload: await response.json() };
}

function assertNoRun(database, runId, intentId, expectedStatus = 'dispatching') {
  assert.equal(database.getRun(runId), null);
  const intent = database.getRunIntent(intentId);
  assert.equal(intent.status, expectedStatus);
  assert.equal(intent.runId, null);
}

function retireLease(database, lease) {
  return database.releaseRunIntentDispatchLease(lease.intent.id, {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    expectedQueueRevision: lease.intent.queueRevision,
    workerId: lease.owner,
    leaseToken: lease.token,
    retryable: false,
    actorId: 'local-owner',
    sessionId: 'f7-test',
  });
}

test('F7 project Run creation requires one exact live dispatch lease and rejects stale, wrong, expired, and duplicate claims', async (t) => {
  const database = createDatabase();
  t.after(() => database.close());
  const baseUrl = await createRunServer(t, database);

  const noClaimLease = createIntent(database, 'no-claim');
  const noClaimResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'f7-host-run-no-claim',
      summary: { runIntentId: noClaimLease.intent.id },
    }),
  });
  const noClaim = await noClaimResponse.json();
  assert.equal(noClaimResponse.status, 409);
  assert.equal(noClaim.code, 'run_intent_lease_required');
  assertNoRun(database, 'f7-host-run-no-claim', noClaimLease.intent.id);
  retireLease(database, noClaimLease);

  const wrongOwnerLease = createIntent(database, 'wrong-owner');
  const wrongOwner = await postClaim(baseUrl, wrongOwnerLease, 'wrong-owner', {
    claim: { leaseOwner: 'worker-forged' },
  });
  assert.equal(wrongOwner.response.status, 409, JSON.stringify(wrongOwner.payload));
  assert.equal(wrongOwner.payload.code, 'run_intent_lease_invalid');
  assertNoRun(database, 'f7-host-run-wrong-owner', wrongOwnerLease.intent.id);
  retireLease(database, wrongOwnerLease);

  const wrongTokenLease = createIntent(database, 'wrong-token');
  const wrongToken = await postClaim(baseUrl, wrongTokenLease, 'wrong-token', {
    claim: { leaseToken: '00000000-0000-4000-8000-000000000099' },
  });
  assert.equal(wrongToken.response.status, 409, JSON.stringify(wrongToken.payload));
  assert.equal(wrongToken.payload.code, 'run_intent_lease_invalid');
  assertNoRun(database, 'f7-host-run-wrong-token', wrongTokenLease.intent.id);
  retireLease(database, wrongTokenLease);

  const staleLease = createIntent(database, 'stale-revision');
  const stale = await postClaim(baseUrl, staleLease, 'stale-revision', {
    claim: { expectedQueueRevision: staleLease.intent.queueRevision - 1 },
  });
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
  assert.equal(stale.payload.code, 'run_intent_queue_cas_conflict');
  assertNoRun(database, 'f7-host-run-stale-revision', staleLease.intent.id);
  retireLease(database, staleLease);

  const expiredLease = createIntent(database, 'expired');
  database.db.prepare('UPDATE run_intents SET lease_expires_at = ? WHERE id = ?')
    .run(Date.now() - 1, expiredLease.intent.id);
  const expired = await postClaim(baseUrl, expiredLease, 'expired');
  assert.equal(expired.response.status, 409, JSON.stringify(expired.payload));
  assert.equal(expired.payload.code, 'run_intent_lease_invalid');
  assertNoRun(database, 'f7-host-run-expired', expiredLease.intent.id);
  database.requestRunIntentCancellation(expiredLease.intent.id, {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    expectedQueueRevision: expiredLease.intent.queueRevision,
    actorId: 'local-owner',
    sessionId: 'f7-test',
  });

  const validLease = createIntent(database, 'valid');
  const valid = await postClaim(baseUrl, validLease, 'valid', {
    summary: {
      runIntentLeaseToken: validLease.token,
      runIntentLeaseOwner: validLease.owner,
    },
  });
  assert.equal(valid.response.status, 201, JSON.stringify(valid.payload));
  assert.equal(valid.payload.data.projectId, PROJECT_ID);
  assert.equal(valid.payload.data.canvasId, CANVAS_ID);
  assert.equal(valid.payload.data.canvasRevision, database.getCanvas(CANVAS_ID).revision);
  assert.equal(valid.payload.data.initiatorId, MEMBER_ID);
  assert.equal(valid.payload.data.summary.runIntentId, validLease.intent.id);
  const publicRun = JSON.stringify(valid.payload.data);
  assert.equal(publicRun.includes(validLease.token), false);
  assert.equal(publicRun.includes(validLease.owner), false);
  assert.doesNotMatch(publicRun, /leaseToken|leaseOwner/i);

  const claimed = database.getRunIntent(validLease.intent.id);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.runId, valid.payload.data.id);
  assert.deepEqual(database.getRunEvents(valid.payload.data.id).map((event) => event.type), ['run.queued']);
  const audit = database.listAuditEvents({ projectId: PROJECT_ID, canvasId: CANVAS_ID, limit: 1000 });
  assert.equal(audit.some((event) => event.action === 'run-intent.claim'), true);
  assert.equal(audit.some((event) => event.action === 'run.queued'), true);
  assert.equal(JSON.stringify(audit).includes(validLease.token), false);
  assert.equal(JSON.stringify(audit).includes(validLease.owner), false);
  assert.doesNotMatch(JSON.stringify(audit), /leaseToken|leaseOwner/i);

  const duplicate = await postClaim(baseUrl, validLease, 'duplicate');
  assert.equal(duplicate.response.status, 409, JSON.stringify(duplicate.payload));
  assert.equal(duplicate.payload.code, 'intent_state_invalid');
  assert.equal(database.getRun('f7-host-run-duplicate'), null);
  assert.equal(database.getRunIntent(validLease.intent.id).runId, valid.payload.data.id);
});

test('F7 Run, intent claim, queued event, and audit roll back as one transaction', async (t) => {
  const database = createDatabase();
  t.after(() => database.close());
  const lease = createIntent(database, 'atomic-rollback');
  const originalAppendAuditEvent = database.appendAuditEvent.bind(database);
  database.appendAuditEvent = (input) => {
    if (input?.action === 'run.queued') throw new Error('forced F7 queued audit failure');
    return originalAppendAuditEvent(input);
  };
  const baseUrl = await createRunServer(t, database);

  const result = await postClaim(baseUrl, lease, 'atomic-rollback');
  assert.equal(result.response.status, 400, JSON.stringify(result.payload));
  assert.match(result.payload.error, /forced F7 queued audit failure/);
  assertNoRun(database, 'f7-host-run-atomic-rollback', lease.intent.id);
  assert.deepEqual(database.getRunEvents('f7-host-run-atomic-rollback'), []);
  assert.equal(
    database.listAuditEvents({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      action: 'run-intent.claim',
    }).length,
    0,
  );
});

test('F7 committed Run stays successful when best-effort collaboration broadcast throws', async (t) => {
  const database = createDatabase();
  t.after(() => database.close());
  const lease = createIntent(database, 'broadcast-failure');
  let runBroadcastAttempts = 0;
  let intentBroadcastAttempts = 0;
  const baseUrl = await createRunServer(t, database, {
    gateway: {
      broadcastHostRunState() {
        runBroadcastAttempts += 1;
        throw new Error('forced F7 live broadcast failure');
      },
      broadcastHostRunIntent() {
        intentBroadcastAttempts += 1;
      },
    },
  });

  const result = await postClaim(baseUrl, lease, 'broadcast-failure');
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  assert.equal(result.payload.success, true);
  assert.equal(result.payload.data.id, 'f7-host-run-broadcast-failure');
  assert.equal(runBroadcastAttempts, 1);
  assert.equal(
    intentBroadcastAttempts,
    1,
    'independent committed notifications must still be attempted after an earlier broadcast fails',
  );

  const persistedRun = database.getRun(result.payload.data.id);
  assert.ok(persistedRun);
  assert.equal(persistedRun.status, 'queued');
  assert.equal(persistedRun.projectId, PROJECT_ID);
  assert.equal(persistedRun.canvasId, CANVAS_ID);
  const claimedIntent = database.getRunIntent(lease.intent.id);
  assert.equal(claimedIntent.status, 'running');
  assert.equal(claimedIntent.runId, persistedRun.id);
  assert.deepEqual(database.getRunEvents(persistedRun.id).map((event) => event.type), ['run.queued']);
  const audits = database.listAuditEvents({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    limit: 1000,
  });
  assert.equal(audits.some((event) => event.action === 'run-intent.claim'), true);
  assert.equal(audits.some((event) => event.action === 'run.queued'), true);
  assert.equal(JSON.stringify(audits).includes(lease.token), false);
  assert.equal(JSON.stringify(result.payload).includes(lease.token), false);
});

test('F7 committed Run update stays successful on broadcast failure while mutation errors still fail', async (t) => {
  const database = createDatabase();
  t.after(() => database.close());
  const run = database.createRun({
    id: 'f7-run-update-broadcast-boundary',
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    canvasRevision: database.getCanvas(CANVAS_ID).revision,
    initiatorId: MEMBER_ID,
    status: 'queued',
    summary: {},
  });
  let broadcastAttempts = 0;
  const privateBroadcastMessage = 'C:\\Users\\private-owner\\runs.sqlite token=never-expose';
  const baseUrl = await createRunServer(t, database, {
    gateway: {
      broadcastHostRunState() {
        broadcastAttempts += 1;
        throw new Error(privateBroadcastMessage);
      },
    },
  });

  const updatedResponse = await fetch(`${baseUrl}/${run.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'running', summary: { phase: 'started' } }),
  });
  const updatedText = await updatedResponse.text();
  const updated = JSON.parse(updatedText);
  assert.equal(updatedResponse.status, 200, updatedText);
  assert.equal(updated.success, true);
  assert.equal(updated.data.status, 'running');
  assert.equal(broadcastAttempts, 1);
  assert.doesNotMatch(updatedText, /private-owner|runs\.sqlite|never-expose/i);
  assert.equal(database.getRun(run.id).status, 'running');
  assert.deepEqual(database.getRunEvents(run.id).map((event) => event.type), ['run.running']);

  const originalUpdateRun = database.updateRun.bind(database);
  database.updateRun = () => {
    throw new Error('forced durable Run mutation failure');
  };
  const failedResponse = await fetch(`${baseUrl}/${run.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'succeeded' }),
  });
  const failed = await failedResponse.json();
  database.updateRun = originalUpdateRun;
  assert.equal(failedResponse.status, 400, JSON.stringify(failed));
  assert.match(failed.error, /forced durable Run mutation failure/);
  assert.equal(database.getRun(run.id).status, 'running');
  assert.equal(broadcastAttempts, 1, 'failed durable mutation must not emit a live notification');
});
