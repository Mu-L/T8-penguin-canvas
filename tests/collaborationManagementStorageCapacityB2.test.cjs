'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'project-collaboration-capacity-b2';
const CANVAS_ID = 'canvas-collaboration-capacity-b2';
const MANAGEMENT_AUTHORITY_HEADER = 'x-t8-collaboration-management-token';
const TEST_MANAGEMENT_AUTHORITY = Object.freeze({
  token: 'test-collaboration-management-capacity-authority-b2-000001',
  actorId: 'capacity-b2-host-owner',
  sessionId: 'capacity-b2-host-session',
});
const SAFE_SQLITE_FULL_RESPONSE = Object.freeze({
  success: false,
  code: 'project_database_storage_capacity_exceeded',
  error: '项目数据库或 SQLite 临时存储空间不足，本次写入已回滚',
  reason: 'sqlite-full',
  retryable: false,
});

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

function loadRouterFactory() {
  const restoreGateway = installModuleMock('../backend/src/collaboration/gateway', {
    getCollaborationGateway: () => ({}),
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

const createCollaborationRouter = loadRouterFactory();

async function listenGateway(gateway) {
  const app = express();
  app.use(express.json({ strict: true }));
  app.use('/api/collaboration', createCollaborationRouter(gateway, {
    managementAuthority: TEST_MANAGEMENT_AUTHORITY,
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/api/collaboration`,
  };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function requestJson(baseUrl, request) {
  const headers = new Headers(request.headers || {});
  headers.set(MANAGEMENT_AUTHORITY_HEADER, TEST_MANAGEMENT_AUTHORITY.token);
  if (request.body != null) headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${request.path}`, {
    method: request.method,
    headers,
    ...(request.body == null ? {} : { body: JSON.stringify(request.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function rawFullError() {
  return Object.assign(
    new Error('INSERT failed at C:\\Users\\private-user\\projects.sqlite3 token=never-expose'),
    {
      code: 'SQLITE_FULL',
      path: 'C:\\Users\\private-user\\projects.sqlite3',
      sql: 'INSERT INTO private_collaboration_table VALUES (?)',
    },
  );
}

function capacityGateway() {
  const calls = [];
  let failureFactory = rawFullError;
  let mode = 'fail-write';
  const fail = (name) => {
    calls.push(name);
    throw failureFactory(name);
  };
  const leased = Object.freeze({
    intent: Object.freeze({
      id: 'intent-capacity-b2',
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      queueRevision: 2,
      status: 'dispatching',
      leaseExpiresAt: Date.now() + 60_000,
    }),
    leaseToken: 'lease-token-capacity-b2',
  });
  const database = {
    getCanvas() {
      return { projectId: PROJECT_ID, canvasId: CANVAS_ID };
    },
    getRoomExecutionPolicy() {
      return { canvasConcurrencyLimit: 1 };
    },
    getRunIntent() {
      return leased.intent;
    },
    initializeCanvasResourceGrantsForSharing() {
      return fail('resource-scope.initialize');
    },
    setExecutionPolicy() {
      return fail('execution-policy.update');
    },
    setRoomExecutionPolicy() {
      return fail('room-execution-policy.update');
    },
    setProjectReviewVisibilityPolicy() {
      return fail('review-visibility-policy.update');
    },
    revokeSession() {
      return fail('session.revoke');
    },
    revokeCanvasSessions() {
      return fail('sessions.revoke-all');
    },
    acceptRunIntentForDispatch() {
      return fail('run-intent.accept');
    },
    leaseRunIntentForDispatch() {
      if (mode === 'lease-return-pending' || mode === 'lease-release-after-policy') return leased;
      return fail('run-intent.lease');
    },
    returnRunIntentToPendingConfirmation() {
      return fail('run-intent.return-pending');
    },
    releaseRunIntentDispatchLease() {
      return fail(mode === 'lease-release-after-policy'
        ? 'run-intent.release-after-policy'
        : 'run-intent.lease-release');
    },
    renewRunIntentDispatchLease() {
      return fail('run-intent.lease-renew');
    },
    requestRunIntentCancellation() {
      return fail('run-intent.cancel');
    },
    transitionRunIntentQueueState() {
      return fail('run-intent.update');
    },
  };
  const auth = {
    createInvite() {
      return fail('invite.create');
    },
    revokeInvite() {
      return fail('invite.revoke');
    },
    updateMember() {
      return fail('member.update');
    },
    removeMember() {
      return fail('member.remove');
    },
  };
  return {
    gateway: {
      database,
      auth,
      executionPolicy: {
        authorizeRunIntent() {
          if (mode === 'lease-return-pending') {
            const error = new Error('confirmation required');
            error.code = 'intent_confirmation_required';
            throw error;
          }
          if (mode === 'lease-release-after-policy') {
            const error = new Error('concurrency limit');
            error.code = 'concurrency_limit';
            throw error;
          }
        },
      },
      managementStatus: () => ({ shareUrls: [] }),
      managementResourceScope: () => ({}),
      closeMemberConnections: () => 0,
      closeSessionConnections: () => 0,
      closeCanvasConnections: () => 0,
      broadcastHostRunIntent: () => {},
    },
    calls,
    setFailureFactory(next) {
      failureFactory = next;
    },
    setMode(next) {
      mode = next;
    },
  };
}

function executionPolicyBody() {
  return {
    projectId: PROJECT_ID,
    allowedModels: ['*'],
    dailyCostLimit: 100,
    perRunCostLimit: 10,
    concurrencyLimit: 2,
  };
}

function roomExecutionPolicyBody() {
  return {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    expectedRevision: 0,
    allowEditorRuns: true,
    memberDailyRunLimit: 10,
    canvasConcurrencyLimit: 2,
    autoApproveLowRisk: false,
    highCostConfirmationThreshold: 5,
    requireUnknownCostConfirmation: true,
  };
}

function reviewVisibilityPolicyBody() {
  return {
    projectId: PROJECT_ID,
    expectedRevision: 0,
    hidePrompts: true,
    hideModelParameters: false,
  };
}

test('B2 collaboration management maps every database write boundary to safe 507 only', async (t) => {
  const fixture = capacityGateway();
  const { server, baseUrl } = await listenGateway(fixture.gateway);
  t.after(() => closeServer(server));

  const requests = [
    { name: 'resource-scope.initialize', method: 'POST', path: '/resource-scope/initialize', body: { projectId: PROJECT_ID, canvasId: CANVAS_ID, confirmed: true } },
    { name: 'invite.create', method: 'POST', path: '/invites', body: { projectId: PROJECT_ID, canvasId: CANVAS_ID, role: 'viewer' } },
    { name: 'invite.revoke', method: 'DELETE', path: `/invites/invite-b2?projectId=${PROJECT_ID}&canvasId=${CANVAS_ID}` },
    { name: 'member.update', method: 'PATCH', path: '/members/member-b2', body: { projectId: PROJECT_ID, canvasId: CANVAS_ID, role: 'viewer' } },
    { name: 'member.remove', method: 'DELETE', path: `/members/member-b2?projectId=${PROJECT_ID}&canvasId=${CANVAS_ID}` },
    { name: 'session.revoke', method: 'DELETE', path: `/sessions/session-b2?projectId=${PROJECT_ID}&canvasId=${CANVAS_ID}` },
    { name: 'sessions.revoke-all', method: 'POST', path: '/sessions/revoke-all', body: { projectId: PROJECT_ID, canvasId: CANVAS_ID } },
    { name: 'execution-policy.update', method: 'PUT', path: '/execution-policy', body: executionPolicyBody() },
    { name: 'room-execution-policy.update', method: 'PUT', path: '/room-execution-policy', body: roomExecutionPolicyBody() },
    { name: 'review-visibility-policy.update', method: 'PUT', path: '/review-visibility-policy', body: reviewVisibilityPolicyBody() },
    { name: 'run-intent.accept', method: 'POST', path: '/run-intents/intent-b2/accept', body: { projectId: PROJECT_ID, canvasId: CANVAS_ID, expectedQueueRevision: 1 } },
    { name: 'run-intent.lease', method: 'POST', path: '/run-intents/lease', body: { projectId: PROJECT_ID, canvasId: CANVAS_ID, workerId: 'worker-b2', expectedIntentId: 'intent-b2' } },
    { name: 'run-intent.lease-renew', method: 'POST', path: '/run-intents/intent-b2/lease/renew', body: { projectId: PROJECT_ID, canvasId: CANVAS_ID, expectedQueueRevision: 1, workerId: 'worker-b2', leaseToken: 'lease-b2' } },
    { name: 'run-intent.lease-release', method: 'POST', path: '/run-intents/intent-b2/lease/release', body: { projectId: PROJECT_ID, canvasId: CANVAS_ID, expectedQueueRevision: 1, workerId: 'worker-b2', leaseToken: 'lease-b2', retryable: true } },
    { name: 'run-intent.cancel', method: 'POST', path: '/run-intents/intent-b2/cancel', body: { projectId: PROJECT_ID, canvasId: CANVAS_ID, expectedQueueRevision: 1 } },
    { name: 'run-intent.update', method: 'PATCH', path: '/run-intents/intent-b2', body: { projectId: PROJECT_ID, canvasId: CANVAS_ID, expectedQueueRevision: 1, status: 'rejected' } },
  ];

  for (const request of requests) {
    const result = await requestJson(baseUrl, request);
    assert.equal(result.status, 507, `${request.name}: ${JSON.stringify(result.body)}`);
    assert.deepEqual(result.body, SAFE_SQLITE_FULL_RESPONSE, request.name);
    assert.doesNotMatch(
      JSON.stringify(result.body),
      /Users|private-user|projects\.sqlite3|private_collaboration_table|token|never-expose|INSERT/i,
      request.name,
    );
  }

  fixture.setMode('lease-return-pending');
  let result = await requestJson(baseUrl, requests.find((entry) => entry.name === 'run-intent.lease'));
  assert.deepEqual(result, { status: 507, body: SAFE_SQLITE_FULL_RESPONSE });

  fixture.setMode('lease-release-after-policy');
  result = await requestJson(baseUrl, requests.find((entry) => entry.name === 'run-intent.lease'));
  assert.deepEqual(result, { status: 507, body: SAFE_SQLITE_FULL_RESPONSE });

  assert.deepEqual(fixture.calls, [
    ...requests.map((entry) => entry.name),
    'run-intent.return-pending',
    'run-intent.release-after-policy',
  ]);
});

test('B2 collaboration management preserves typed WAL pressure and existing 409 business semantics', async (t) => {
  const fixture = capacityGateway();
  const { server, baseUrl } = await listenGateway(fixture.gateway);
  t.after(() => closeServer(server));

  fixture.setFailureFactory(() => {
    const error = new ProjectDatabaseStorageCapacityError('wal-pressure', {
      operation: 'private.collaboration.writer',
    });
    error.message = 'checkpoint failed at C:\\Users\\private-user\\projects.sqlite3 token=never-expose';
    error.privateSql = 'PRAGMA wal_checkpoint(TRUNCATE)';
    return error;
  });
  let result = await requestJson(baseUrl, {
    method: 'PUT',
    path: '/review-visibility-policy',
    body: reviewVisibilityPolicyBody(),
  });
  assert.deepEqual(result, {
    status: 507,
    body: {
      success: false,
      code: 'project_database_storage_capacity_exceeded',
      error: '项目数据库或 SQLite 临时存储空间不足，本次写入已回滚',
      reason: 'wal-pressure',
      retryable: true,
    },
  });
  assert.doesNotMatch(JSON.stringify(result.body), /Users|private|token|checkpoint|PRAGMA|TRUNCATE/i);

  fixture.setFailureFactory(() => Object.assign(
    new Error('审阅可见性策略 revision 冲突'),
    {
      code: 'collaboration_review_visibility_policy_conflict',
      status: 409,
      details: { current: { revision: 7 } },
    },
  ));
  result = await requestJson(baseUrl, {
    method: 'PUT',
    path: '/review-visibility-policy',
    body: reviewVisibilityPolicyBody(),
  });
  assert.deepEqual(result, {
    status: 409,
    body: {
      success: false,
      code: 'collaboration_review_visibility_policy_conflict',
      error: '审阅可见性策略 revision 冲突',
      data: { current: { revision: 7 } },
    },
  });
});

function installLateExecutionPolicyFull(database) {
  let lateAuditHits = 0;
  database.db.function('collaboration_capacity_b2_mark_late_audit', () => {
    lateAuditHits += 1;
    return 1;
  });
  database.db.exec(`
    CREATE TABLE collaboration_capacity_b2_filler (
      id INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
    CREATE TRIGGER collaboration_capacity_b2_force_late_full
    BEFORE INSERT ON audit_events
    WHEN NEW.action = 'collaboration.execution-policy.update'
    BEGIN
      SELECT collaboration_capacity_b2_mark_late_audit();
      INSERT INTO collaboration_capacity_b2_filler(payload) VALUES (zeroblob(4194304));
    END;
  `);
  database.db.pragma('wal_checkpoint(TRUNCATE)');
  database.db.exec('VACUUM');
  database.db.pragma('wal_checkpoint(TRUNCATE)');
  const pageCount = Number(database.db.pragma('page_count', { simple: true }));
  const constrainedPageCount = pageCount + 64;
  assert.equal(
    Number(database.db.pragma(`max_page_count = ${constrainedPageCount}`, { simple: true })),
    constrainedPageCount,
  );
  return {
    lateAuditHits: () => lateAuditHits,
    release() {
      database.db.pragma('max_page_count = 1073741823');
    },
  };
}

function scalarCount(database, sql, ...values) {
  return Number(database.db.prepare(sql).get(...values)?.count || 0);
}

const ROUTE_NODE_ID = 'collaboration-capacity-b2-node';
const ROUTE_NODE_UID = '4b200000-0000-4000-8000-000000000001';
let routeIntentSequence = 0;

function ensureRouteCanvas(database) {
  return database.ensureCanvas(CANVAS_ID, {
    projectId: PROJECT_ID,
    nodes: [{
      id: ROUTE_NODE_ID,
      entityUid: ROUTE_NODE_UID,
      entityRevision: 1,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { text: 'B2 lease flow' },
    }],
    edges: [],
  }, PROJECT_ID);
}

function createRouteIntent(database, options = {}) {
  routeIntentSequence += 1;
  const canvas = database.getCanvas(CANVAS_ID) || ensureRouteCanvas(database);
  const suffix = options.suffix || String(routeIntentSequence);
  return database.createRunIntent({
    id: `collaboration-capacity-b2-intent-${suffix}`,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    canvasRevision: canvas.revision,
    nodeIds: [ROUTE_NODE_ID],
    idempotencyKey: `collaboration-capacity-b2-idempotency-${suffix}`,
    requestedBy: 'collaboration-capacity-b2-member',
    confirmationRequired: options.confirmationRequired !== false,
    estimatedCostKnown: true,
    estimatedCost: 0,
  });
}

function installLateLeaseCompensationFull(database) {
  let lateCompensationHits = 0;
  database.db.function('collaboration_capacity_b2_mark_late_compensation', () => {
    lateCompensationHits += 1;
    return 1;
  });
  database.db.exec(`
    CREATE TABLE collaboration_lease_capacity_b2_filler (
      id INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
    CREATE TRIGGER collaboration_capacity_b2_force_late_compensation_full
    BEFORE INSERT ON audit_events
    WHEN NEW.action = 'run-intent.confirmation.requeue'
    BEGIN
      SELECT collaboration_capacity_b2_mark_late_compensation();
      INSERT INTO collaboration_lease_capacity_b2_filler(payload) VALUES (zeroblob(4194304));
    END;
  `);
  database.db.pragma('wal_checkpoint(TRUNCATE)');
  database.db.exec('VACUUM');
  database.db.pragma('wal_checkpoint(TRUNCATE)');
  const pageCount = Number(database.db.pragma('page_count', { simple: true }));
  const constrainedPageCount = pageCount + 64;
  assert.equal(
    Number(database.db.pragma(`max_page_count = ${constrainedPageCount}`, { simple: true })),
    constrainedPageCount,
  );
  return {
    lateCompensationHits: () => lateCompensationHits,
    release() {
      database.db.pragma('max_page_count = 1073741823');
    },
  };
}

test('B2 collaboration HTTP late real SQLITE_FULL rolls back policy and audit before exact retry', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-collaboration-route-capacity-b2-'));
  const filename = path.join(directory, 'project.sqlite3');
  const database = new ProjectDatabase(filename, { autoBackup: false });
  const fault = installLateExecutionPolicyFull(database);
  const { server, baseUrl } = await listenGateway({ database });
  t.after(async () => {
    await closeServer(server);
    try { fault.release(); } catch (_) {}
    try { await database.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  });

  let result = await requestJson(baseUrl, {
    method: 'PUT',
    path: '/execution-policy',
    body: executionPolicyBody(),
  });
  assert.deepEqual(result, { status: 507, body: SAFE_SQLITE_FULL_RESPONSE });
  assert.equal(fault.lateAuditHits(), 1, 'FULL must occur after the policy row write at audit append');
  assert.equal(scalarCount(
    database,
    'SELECT COUNT(*) AS count FROM project_execution_policies WHERE project_id = ?',
    PROJECT_ID,
  ), 0);
  assert.equal(scalarCount(
    database,
    `SELECT COUNT(*) AS count FROM audit_events
     WHERE project_id = ? AND action = 'collaboration.execution-policy.update'`,
    PROJECT_ID,
  ), 0);
  assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM collaboration_capacity_b2_filler'), 0);

  fault.release();
  result = await requestJson(baseUrl, {
    method: 'PUT',
    path: '/execution-policy',
    body: executionPolicyBody(),
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.success, true);
  assert.equal(result.body.data.projectId, PROJECT_ID);
  assert.equal(fault.lateAuditHits(), 2);
  assert.equal(scalarCount(
    database,
    'SELECT COUNT(*) AS count FROM project_execution_policies WHERE project_id = ?',
    PROJECT_ID,
  ), 1);
  assert.equal(scalarCount(
    database,
    `SELECT COUNT(*) AS count FROM audit_events
     WHERE project_id = ? AND action = 'collaboration.execution-policy.update'`,
    PROJECT_ID,
  ), 1);
  assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM collaboration_capacity_b2_filler'), 1);
  assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.db.pragma('foreign_key_check'), []);
});

test('B2 lease flow rolls back the initial lease when late confirmation compensation hits real SQLITE_FULL', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-collaboration-lease-capacity-b2-'));
  const filename = path.join(directory, 'project.sqlite3');
  const database = new ProjectDatabase(filename, { autoBackup: false });
  ensureRouteCanvas(database);
  const intent = createRouteIntent(database, {
    suffix: 'lease-atomic',
    confirmationRequired: false,
  });
  const fault = installLateLeaseCompensationFull(database);
  const policyError = Object.assign(new Error('最新策略要求明确确认'), {
    code: 'intent_confirmation_required',
    httpStatus: 409,
  });
  const broadcasts = [];
  const gateway = {
    database,
    executionPolicy: {
      authorizeRunIntent() {
        throw policyError;
      },
    },
    broadcastHostRunIntent(nextIntent) {
      broadcasts.push(nextIntent);
    },
  };
  const { server, baseUrl } = await listenGateway(gateway);
  t.after(async () => {
    await closeServer(server);
    try { fault.release(); } catch (_) {}
    try { await database.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const before = database.db.prepare('SELECT * FROM run_intents WHERE id = ?').get(intent.id);
  const beforeAuditCount = scalarCount(database, 'SELECT COUNT(*) AS count FROM audit_events');
  let result = await requestJson(baseUrl, {
    method: 'POST',
    path: '/run-intents/lease',
    body: {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      workerId: 'collaboration-capacity-b2-worker',
      expectedIntentId: intent.id,
      leaseDurationMs: 60_000,
    },
  });
  assert.deepEqual(result, { status: 507, body: SAFE_SQLITE_FULL_RESPONSE });
  assert.equal(fault.lateCompensationHits(), 1, 'FULL must happen after the initial lease inside compensation');
  assert.deepEqual(
    database.db.prepare('SELECT * FROM run_intents WHERE id = ?').get(intent.id),
    before,
    'the outer coordinator must roll the initial lease and dispatch attempt back',
  );
  assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM audit_events'), beforeAuditCount);
  assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM collaboration_lease_capacity_b2_filler'), 0);
  assert.deepEqual(broadcasts, [], 'rolled-back state must never be broadcast');

  fault.release();
  result = await requestJson(baseUrl, {
    method: 'POST',
    path: '/run-intents/lease',
    body: {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      workerId: 'collaboration-capacity-b2-worker',
      expectedIntentId: intent.id,
      leaseDurationMs: 60_000,
    },
  });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'intent_confirmation_required');
  const pending = database.getRunIntent(intent.id);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.queueRevision, 3);
  assert.equal(pending.dispatchAttempts, 1);
  assert.equal(pending.leaseExpiresAt, null);
  assert.equal(scalarCount(
    database,
    "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'run-intent.dispatch.lease'",
  ), 1);
  assert.equal(scalarCount(
    database,
    "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'run-intent.confirmation.requeue'",
  ), 1);
  assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM collaboration_lease_capacity_b2_filler'), 1);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].status, 'pending');
  assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.db.pragma('foreign_key_check'), []);
});

test('B2 committed run-intent routes keep their success response when best-effort broadcast throws', async (t) => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  ensureRouteCanvas(database);
  const acceptedViaRoute = createRouteIntent(database, { suffix: 'broadcast-accept' });
  const cancelledViaRoute = createRouteIntent(database, {
    suffix: 'broadcast-cancel',
    confirmationRequired: false,
  });
  const rejectedViaRoute = createRouteIntent(database, {
    suffix: 'broadcast-reject',
    confirmationRequired: false,
  });
  let broadcastAttempts = 0;
  const gateway = {
    database,
    executionPolicy: { authorizeRunIntent() {} },
    broadcastHostRunIntent() {
      broadcastAttempts += 1;
      if (broadcastAttempts % 2 === 1) throw rawFullError();
      throw new Error('socket broadcast failed after commit');
    },
  };
  const { server, baseUrl } = await listenGateway(gateway);
  const assertBroadcastFailureHidden = (body) => assert.doesNotMatch(
    JSON.stringify(body),
    /Users|private-user|projects\.sqlite3|never-expose|INSERT|socket broadcast failed/i,
  );
  t.after(async () => {
    await closeServer(server);
    try { await database.close(); } catch (_) {}
  });

  let result = await requestJson(baseUrl, {
    method: 'POST',
    path: `/run-intents/${acceptedViaRoute.id}/accept`,
    body: {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      expectedQueueRevision: acceptedViaRoute.queueRevision,
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assertBroadcastFailureHidden(result.body);
  assert.equal(result.body.data.status, 'accepted');
  assert.equal(database.getRunIntent(acceptedViaRoute.id).status, 'accepted');

  result = await requestJson(baseUrl, {
    method: 'POST',
    path: '/run-intents/lease',
    body: {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      workerId: 'collaboration-broadcast-b2-worker',
      expectedIntentId: acceptedViaRoute.id,
      leaseDurationMs: 60_000,
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assertBroadcastFailureHidden(result.body);
  assert.equal(result.body.data.intent.status, 'dispatching');
  const leaseToken = result.body.data.lease.token;
  let current = database.getRunIntent(acceptedViaRoute.id);
  assert.equal(current.status, 'dispatching');

  result = await requestJson(baseUrl, {
    method: 'POST',
    path: `/run-intents/${acceptedViaRoute.id}/lease/renew`,
    body: {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      expectedQueueRevision: current.queueRevision,
      workerId: 'collaboration-broadcast-b2-worker',
      leaseToken,
      leaseDurationMs: 60_000,
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assertBroadcastFailureHidden(result.body);
  current = database.getRunIntent(acceptedViaRoute.id);
  assert.equal(current.queueRevision, result.body.data.intent.queueRevision);

  result = await requestJson(baseUrl, {
    method: 'POST',
    path: `/run-intents/${acceptedViaRoute.id}/lease/release`,
    body: {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      expectedQueueRevision: current.queueRevision,
      workerId: 'collaboration-broadcast-b2-worker',
      leaseToken,
      retryable: false,
      errorCode: 'worker-failed',
      errorMessage: 'expected test failure',
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assertBroadcastFailureHidden(result.body);
  assert.equal(result.body.data.status, 'failed');
  assert.equal(database.getRunIntent(acceptedViaRoute.id).status, 'failed');

  result = await requestJson(baseUrl, {
    method: 'POST',
    path: `/run-intents/${cancelledViaRoute.id}/cancel`,
    body: {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      expectedQueueRevision: cancelledViaRoute.queueRevision,
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assertBroadcastFailureHidden(result.body);
  assert.equal(result.body.data.status, 'cancelled');
  assert.equal(database.getRunIntent(cancelledViaRoute.id).status, 'cancelled');

  result = await requestJson(baseUrl, {
    method: 'PATCH',
    path: `/run-intents/${rejectedViaRoute.id}`,
    body: {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      expectedQueueRevision: rejectedViaRoute.queueRevision,
      status: 'rejected',
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assertBroadcastFailureHidden(result.body);
  assert.equal(result.body.data.status, 'rejected');
  assert.equal(database.getRunIntent(rejectedViaRoute.id).status, 'rejected');
  assert.equal(broadcastAttempts, 6, 'every committed route must attempt one non-fatal broadcast');
  assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.db.pragma('foreign_key_check'), []);
});
