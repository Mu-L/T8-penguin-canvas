const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CollaborationGateway } = require('../backend/src/collaboration/gateway');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'project-b3-management';
const CANVAS_ID = 'canvas-b3-management';
const MANAGEMENT_AUTHORITY_HEADER = 'x-t8-collaboration-management-token';
const TEST_MANAGEMENT_AUTHORITY = Object.freeze({
  token: 'test-collaboration-management-authority-token-b3-000001',
  actorId: 'test-b3-host-owner',
  sessionId: 'test-b3-host-backend-session',
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

async function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b3-management-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  const thumbnails = path.join(directory, 'thumbnails');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(thumbnails, { recursive: true });
  const database = new ProjectDatabase(':memory:');
  database.ensureCanvas(CANVAS_ID, { name: 'B3 management', nodes: [], edges: [] }, PROJECT_ID);
  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    COLLAB_ALLOWED_ORIGINS: [],
    FRONTEND_DIST: '',
    INPUT_DIR: input,
    OUTPUT_DIR: output,
    THUMBNAILS_DIR: thumbnails,
    COLLAB_UPLOAD_TEMP_DIR: path.join(directory, 'uploads'),
  }, database, {
    listNetworkInterfaces: () => [{
      id: 'loopback:127.0.0.1',
      name: '本机回环',
      address: '127.0.0.1',
      family: 'IPv4',
      internal: true,
      cidr: '127.0.0.1/8',
      scope: 'loopback',
      label: '本机回环 · 127.0.0.1 · 仅本机',
    }],
  });
  const publicStatus = await gateway.start({ host: '127.0.0.1', port: 0 });
  const createCollaborationRouter = loadRouterFactory(gateway);
  const app = express();
  app.use(express.json({ strict: true }));
  app.use('/api/collaboration', createCollaborationRouter(gateway, {
    managementAuthority: TEST_MANAGEMENT_AUTHORITY,
  }));
  const managementServer = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    directory,
    database,
    gateway,
    managementServer,
    managementBase: `http://127.0.0.1:${managementServer.address().port}/api/collaboration`,
    publicBase: `http://127.0.0.1:${publicStatus.port}`,
  };
}

async function cleanupFixture(fixture) {
  await fixture.gateway.stop();
  await new Promise((resolve) => fixture.managementServer.close(resolve));
  fixture.database.close();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

async function requestJson(url, init = {}) {
  const requestOptions = { ...init };
  const pathname = new URL(String(url)).pathname;
  if (pathname === '/api/collaboration' || pathname.startsWith('/api/collaboration/')) {
    const headers = new Headers(init.headers || {});
    headers.set(MANAGEMENT_AUTHORITY_HEADER, TEST_MANAGEMENT_AUTHORITY.token);
    requestOptions.headers = headers;
  }
  const response = await fetch(url, requestOptions);
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

test('B3 audit management query is scoped, filtered, paginated, bounded, and redacted', async (t) => {
  const fixture = await createFixture();
  t.after(() => cleanupFixture(fixture));
  fixture.database.appendAuditEvent({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    actorId: 'member-a',
    sessionId: 'private-session-a',
    action: 'collaboration.member.remove',
    targetType: 'member',
    targetId: 'member-old',
    metadata: { safe: 'older' },
    createdAt: 100,
  });
  fixture.database.appendAuditEvent({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    actorId: 'member-a',
    sessionId: 'private-session-b',
    action: 'collaboration.member.remove',
    targetType: 'member',
    targetId: 'member-new',
    metadata: {
      safe: 'visible',
      apiKey: 'AUDIT_API_KEY_SECRET',
      nested: { access_token: 'AUDIT_ACCESS_TOKEN_SECRET' },
      sourcePath: 'C:\\Users\\host-owner\\private.png',
      note: 'C:\\Users\\host-owner\\private-note.txt',
      url: 'https://example.test/file?token=AUDIT_SIGNED_URL_SECRET',
    },
    createdAt: 200,
  });
  fixture.database.appendAuditEvent({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    actorId: 'member-b',
    sessionId: 'private-session-c',
    action: 'canvas.operation.apply',
    targetType: 'canvas',
    targetId: CANVAS_ID,
    metadata: { safe: 'other-action' },
    createdAt: 300,
  });
  fixture.database.appendAuditEvent({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    actorId: 'local-owner',
    sessionId: 'local-management-session',
    action: 'collaboration.session.revoke',
    targetType: 'session',
    targetId: 'sensitive-target-session-id',
    metadata: { safe: 'session-revoked' },
    createdAt: 350,
  });
  fixture.database.ensureCanvas(
    'canvas-other',
    { name: 'Cross-project audit authority', nodes: [], edges: [] },
    'project-other',
  );
  fixture.database.appendAuditEvent({
    projectId: 'project-other',
    canvasId: 'canvas-other',
    actorId: 'member-a',
    sessionId: 'cross-project-session',
    action: 'collaboration.member.remove',
    targetType: 'member',
    targetId: 'cross-project-member',
    createdAt: 400,
  });

  const query = new URLSearchParams({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    action: 'collaboration.member.remove',
    actorId: 'member-a',
    targetType: 'member',
    offset: '0',
    limit: '1',
  });
  const first = await requestJson(`${fixture.managementBase}/audit-events?${query}`);
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.data.events.length, 1);
  assert.equal(first.payload.data.events[0].targetId, 'member-new');
  assert.equal(first.payload.data.events[0].metadata.safe, 'visible');
  assert.equal(Object.hasOwn(first.payload.data.events[0], 'sessionId'), false);
  assert.match(first.payload.data.events[0].sessionRef, /^[a-f0-9]{12}$/);
  assert.deepEqual(first.payload.data.pagination, {
    offset: 0,
    limit: 1,
    nextOffset: 1,
    hasMoreWithinWindow: true,
    totalWithinWindow: 2,
    windowLimit: 1000,
    sourceTruncated: false,
  });
  assert.doesNotMatch(
    JSON.stringify(first.payload),
    /AUDIT_API_KEY_SECRET|AUDIT_ACCESS_TOKEN_SECRET|AUDIT_SIGNED_URL_SECRET|host-owner|private-session-b/i,
  );

  query.set('offset', '1');
  const second = await requestJson(`${fixture.managementBase}/audit-events?${query}`);
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  assert.deepEqual(second.payload.data.events.map((event) => event.targetId), ['member-old']);
  assert.equal(second.payload.data.pagination.nextOffset, null);

  const sessionTarget = await requestJson(
    `${fixture.managementBase}/audit-events?${new URLSearchParams({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      action: 'collaboration.session.revoke',
      targetType: 'session',
    })}`,
  );
  assert.equal(sessionTarget.response.status, 200, JSON.stringify(sessionTarget.payload));
  assert.match(sessionTarget.payload.data.events[0].targetId, /^session:[a-f0-9]{12}$/);
  assert.doesNotMatch(JSON.stringify(sessionTarget.payload), /sensitive-target-session-id|local-management-session/);

  for (const invalidQuery of [
    `projectId=${PROJECT_ID}&limit=101`,
    `projectId=${PROJECT_ID}&offset=990&limit=25`,
    `projectId=${PROJECT_ID}&offset=-1`,
  ]) {
    const invalid = await requestJson(`${fixture.managementBase}/audit-events?${invalidQuery}`);
    assert.equal(invalid.response.status, 400, JSON.stringify(invalid.payload));
    assert.equal(invalid.payload.code, 'audit_query_invalid');
  }
});

test('B3 host execution policy API stores complete bounded policy and rejects partial or forged fields', async (t) => {
  const fixture = await createFixture();
  t.after(() => cleanupFixture(fixture));

  const initial = await requestJson(`${fixture.managementBase}/execution-policy?projectId=${PROJECT_ID}`);
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
  assert.deepEqual(initial.payload.data.policy.allowedModels, ['*']);
  assert.equal(initial.payload.data.policy.dailyCostLimit, 0);
  assert.equal(initial.payload.data.policy.perRunCostLimit, 0);
  assert.equal(initial.payload.data.policy.concurrencyLimit, 2);

  const updated = await requestJson(`${fixture.managementBase}/execution-policy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: PROJECT_ID,
      allowedModels: ['image:allowed-model', 'video:allowed-model'],
      dailyCostLimit: 50,
      perRunCostLimit: 5,
      concurrencyLimit: 3,
    }),
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.deepEqual(updated.payload.data.allowedModels, ['image:allowed-model', 'video:allowed-model']);
  assert.equal(updated.payload.data.dailyCostLimit, 50);
  assert.equal(updated.payload.data.perRunCostLimit, 5);
  assert.equal(updated.payload.data.concurrencyLimit, 3);

  const persisted = fixture.database.getExecutionPolicy(PROJECT_ID);
  assert.deepEqual(persisted.allowedModels, ['image:allowed-model', 'video:allowed-model']);
  const audit = fixture.database.listAuditEvents({
    projectId: PROJECT_ID,
    action: 'collaboration.execution-policy.update',
  });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actorId, TEST_MANAGEMENT_AUTHORITY.actorId);
  assert.equal(audit[0].sessionId, TEST_MANAGEMENT_AUTHORITY.sessionId);
  assert.deepEqual(audit[0].metadata, {
    allowedModelCount: 2,
    dailyCostLimit: 50,
    perRunCostLimit: 5,
    concurrencyLimit: 3,
  });

  for (const body of [
    { allowedModels: ['*'], dailyCostLimit: 0, perRunCostLimit: 0, concurrencyLimit: 2 },
    { projectId: PROJECT_ID, allowedModels: ['*'], dailyCostLimit: 0, perRunCostLimit: 0 },
    { projectId: PROJECT_ID, allowedModels: ['*'], dailyCostLimit: '0', perRunCostLimit: 0, concurrencyLimit: 2 },
    { projectId: PROJECT_ID, allowedModels: ['*'], dailyCostLimit: 0, perRunCostLimit: 0, concurrencyLimit: 0 },
    { projectId: PROJECT_ID, allowedModels: ['*'], dailyCostLimit: 0, perRunCostLimit: 0, concurrencyLimit: 2, updatedBy: 'remote-owner' },
  ]) {
    const invalid = await requestJson(`${fixture.managementBase}/execution-policy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(invalid.response.status, 400, JSON.stringify(invalid.payload));
    assert.equal(invalid.payload.code, 'execution_policy_invalid');
    assert.deepEqual(fixture.database.getExecutionPolicy(PROJECT_ID), persisted);
  }
});

test('B3 audit and policy management endpoints reject cross-site browser authority and stay absent from the public gateway', async (t) => {
  const fixture = await createFixture();
  t.after(() => cleanupFixture(fixture));

  for (const managementPath of [
    `/audit-events?projectId=${PROJECT_ID}`,
    `/execution-policy?projectId=${PROJECT_ID}`,
  ]) {
    const crossSite = await requestJson(`${fixture.managementBase}${managementPath}`, {
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossSite.response.status, 403, JSON.stringify(crossSite.payload));
    assert.equal(crossSite.payload.code, 'collaboration_management_origin_forbidden');
  }

  const invite = fixture.gateway.auth.createInvite({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    role: 'viewer',
    maxUses: 1,
  });
  const redeemed = await requestJson(`${fixture.publicBase}/api/collab/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, displayName: 'B3 public-route probe' }),
  });
  assert.equal(redeemed.response.status, 200, JSON.stringify(redeemed.payload));
  const cookie = String(redeemed.response.headers.get('set-cookie') || '').split(';')[0];

  for (const publicPath of [
    '/api/collab/audit-events',
    '/api/collab/execution-policy',
    '/api/collaboration/audit-events',
    '/api/collaboration/execution-policy',
  ]) {
    const denied = await requestJson(`${fixture.publicBase}${publicPath}`, { headers: { cookie } });
    assert.equal(denied.response.status, 404, `${publicPath}: ${JSON.stringify(denied.payload)}`);
    assert.equal(denied.payload.error, '协作网关未开放此接口');
  }
});
