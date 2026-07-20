const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');

const { CollaborationGateway } = require('../backend/src/collaboration/gateway');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

const PROJECT_A = 'project-f1-a';
const PROJECT_B = 'project-f1-b';
const CANVAS_A = 'canvas-f1-a';
const CANVAS_A_SIBLING = 'canvas-f1-a-sibling';
const CANVAS_B = 'canvas-f1-b';
const MANAGEMENT_AUTHORITY_HEADER = 'x-t8-collaboration-management-token';
const TEST_MANAGEMENT_AUTHORITY = Object.freeze({
  token: 'test-collaboration-management-authority-token-f1-000001',
  actorId: 'test-f1-host-owner',
  sessionId: 'test-f1-host-backend-session',
});
const LOOPBACK_INTERFACES = Object.freeze([
  {
    id: 'loopback:127.0.0.1',
    name: '本机回环',
    address: '127.0.0.1',
    family: 'IPv4',
    internal: true,
    cidr: '127.0.0.1/8',
    scope: 'loopback',
    label: '本机回环 · 127.0.0.1 · 仅本机',
  },
  {
    id: 'all-ipv4:0.0.0.0',
    name: '全部 IPv4 网卡',
    address: '0.0.0.0',
    family: 'IPv4',
    internal: false,
    cidr: null,
    scope: 'wildcard',
    label: '全部 IPv4 网卡（谨慎使用）',
  },
]);

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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-f1-management-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const database = new ProjectDatabase(':memory:');
  database.ensureCanvas(CANVAS_A, { name: 'F1 A', nodes: [], edges: [] }, PROJECT_A);
  database.ensureCanvas(CANVAS_B, { name: 'F1 B', nodes: [], edges: [] }, PROJECT_B);
  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    FRONTEND_DIST: '',
    INPUT_DIR: input,
    OUTPUT_DIR: output,
  }, database, {
    listNetworkInterfaces: () => LOOPBACK_INTERFACES.map((entry) => ({ ...entry })),
  });
  const collaboration = await gateway.start({ host: '127.0.0.1', port: 0 });
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
    collaborationBase: `http://127.0.0.1:${collaboration.port}`,
    managementBase: `http://127.0.0.1:${managementServer.address().port}/api/collaboration`,
  };
}

async function cleanupFixture(fixture, sockets = []) {
  for (const socket of sockets) {
    if (!socket || socket.readyState === WebSocket.CLOSED) continue;
    try {
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else socket.terminate();
    } catch (_) {
      // Best-effort cleanup for a socket already closed by the host.
    }
  }
  await fixture.gateway.stop();
  await new Promise((resolve) => fixture.managementServer.close(resolve));
  fixture.database.close();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

async function requestJson(url, init = {}, options = {}) {
  const requestOptions = { ...init };
  const pathname = new URL(String(url)).pathname;
  if (pathname === '/api/collaboration' || pathname.startsWith('/api/collaboration/')) {
    const token = Object.hasOwn(options, 'managementToken')
      ? options.managementToken
      : TEST_MANAGEMENT_AUTHORITY.token;
    const headers = new Headers(init.headers || {});
    if (token != null) headers.set(MANAGEMENT_AUTHORITY_HEADER, String(token));
    requestOptions.headers = headers;
  }
  const response = await fetch(url, requestOptions);
  const text = await response.text();
  return {
    response,
    payload: text ? JSON.parse(text) : null,
  };
}

async function redeemActor(fixture, projectId, canvasId, role, displayName) {
  const invite = fixture.gateway.auth.createInvite({
    projectId,
    canvasId,
    role,
    maxUses: 1,
  });
  const redeemed = await requestJson(`${fixture.collaborationBase}/api/collab/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, displayName }),
  });
  assert.equal(redeemed.response.status, 200, JSON.stringify(redeemed.payload));
  const cookie = String(redeemed.response.headers.get('set-cookie') || '').split(';')[0];
  const session = await requestJson(`${fixture.collaborationBase}/api/collab/session`, {
    headers: { cookie },
  });
  assert.equal(session.response.status, 200, JSON.stringify(session.payload));
  return {
    cookie,
    memberId: redeemed.payload.data.memberId,
    sessionId: session.payload.data.id,
    projectId,
    canvasId,
  };
}

async function openSocket(fixture, actor) {
  const socket = new WebSocket(`${fixture.collaborationBase.replace(/^http/, 'ws')}/ws/collab`, {
    origin: fixture.collaborationBase,
    headers: { cookie: actor.cookie },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('协作 WebSocket 建立超时')), 3000);
    socket.once('error', reject);
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== 'session.ready') return;
      clearTimeout(timer);
      resolve();
    });
  });
  return socket;
}

function waitForClose(socket, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve({ code: socket._closeCode, reason: String(socket._closeMessage || '') });
      return;
    }
    const timer = setTimeout(() => reject(new Error('主机撤销后 WebSocket 未即时关闭')), timeoutMs);
    socket.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reason) });
    });
  });
}

function waitForSocketMessage(socket, predicate, timeoutMessage, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw));
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

test('B3 loopback management rejects cross-site browser authority while preserving local clients', async (t) => {
  const fixture = await createFixture();
  t.after(() => cleanupFixture(fixture));

  const localCli = await requestJson(`${fixture.managementBase}/status`);
  assert.equal(localCli.response.status, 200, JSON.stringify(localCli.payload));

  const localBrowser = await requestJson(`${fixture.managementBase}/status`, {
    headers: {
      origin: 'http://localhost:11422',
      'sec-fetch-site': 'same-origin',
    },
  });
  assert.equal(localBrowser.response.status, 200, JSON.stringify(localBrowser.payload));

  const unrelatedLoopbackSite = await requestJson(`${fixture.managementBase}/stop`, {
    method: 'POST',
    headers: {
      origin: 'http://localhost:45678',
      'sec-fetch-site': 'same-site',
    },
  });
  assert.equal(unrelatedLoopbackSite.response.status, 403, JSON.stringify(unrelatedLoopbackSite.payload));
  assert.equal(unrelatedLoopbackSite.payload.code, 'collaboration_management_origin_forbidden');
  assert.equal(fixture.gateway.status().running, true);

  const evilOrigin = await requestJson(`${fixture.managementBase}/stop`, {
    method: 'POST',
    headers: {
      origin: 'https://evil.example',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: '',
  });
  assert.equal(evilOrigin.response.status, 403, JSON.stringify(evilOrigin.payload));
  assert.equal(evilOrigin.payload.code, 'collaboration_management_origin_forbidden');
  assert.equal(fixture.gateway.status().running, true);

  const fetchMetadataCrossSite = await requestJson(`${fixture.managementBase}/stop`, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(fetchMetadataCrossSite.response.status, 403, JSON.stringify(fetchMetadataCrossSite.payload));
  assert.equal(fixture.gateway.status().running, true);
});

test('B3 management authority rejects missing or wrong tokens and ignores forged invite audit principals', async (t) => {
  const fixture = await createFixture();
  t.after(() => cleanupFixture(fixture));

  const missing = await requestJson(
    `${fixture.managementBase}/status`,
    {},
    { managementToken: null },
  );
  assert.equal(missing.response.status, 401, JSON.stringify(missing.payload));
  assert.equal(missing.payload.code, 'collaboration_management_auth_required');

  const wrong = await requestJson(
    `${fixture.managementBase}/status`,
    {},
    { managementToken: 'wrong-management-authority-token-000000000000000000' },
  );
  assert.equal(wrong.response.status, 401, JSON.stringify(wrong.payload));
  assert.equal(wrong.payload.code, 'collaboration_management_auth_required');

  const forged = await requestJson(`${fixture.managementBase}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: PROJECT_A,
      canvasId: CANVAS_A,
      role: 'viewer',
      maxUses: 1,
      createdBy: 'forged-request-actor',
      sessionId: 'forged-request-session',
    }),
  });
  assert.equal(forged.response.status, 200, JSON.stringify(forged.payload));
  const audits = fixture.database.listAuditEvents({
    projectId: PROJECT_A,
    canvasId: CANVAS_A,
    action: 'collaboration.invite.create',
    limit: 20,
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actorId, TEST_MANAGEMENT_AUTHORITY.actorId);
  assert.equal(audits[0].sessionId, TEST_MANAGEMENT_AUTHORITY.sessionId);
  assert.notEqual(audits[0].actorId, 'forged-request-actor');
  assert.notEqual(audits[0].sessionId, 'forged-request-session');
});

test('F1 router factory creates room-scoped non-default-project invites and rejects cross-room revocation', async (t) => {
  const fixture = await createFixture();
  t.after(() => cleanupFixture(fixture));
  fixture.database.ensureCanvas(
    CANVAS_A_SIBLING,
    { name: 'F1 A sibling', nodes: [], edges: [] },
    PROJECT_A,
  );

  const managementStatus = await requestJson(
    `${fixture.managementBase}/status?projectId=${PROJECT_A}&canvasId=${CANVAS_A}`,
  );
  assert.equal(managementStatus.response.status, 200);
  assert.deepEqual(managementStatus.payload.data.networkInterfaces, LOOPBACK_INTERFACES);
  assert.deepEqual(
    managementStatus.payload.data.shareUrls,
    [`${fixture.collaborationBase}/collab`],
  );
  const { resourceScope, ...roomStatus } = managementStatus.payload.data.room;
  assert.deepEqual(roomStatus, {
    projectId: PROJECT_A,
    canvasId: CANVAS_A,
    canvasCount: 1,
    memberCount: 0,
    activeSessionCount: 0,
    connectionCount: 0,
  });
  assert.deepEqual({
    status: resourceScope.status,
    ready: resourceScope.ready,
    canvasRevision: resourceScope.canvasRevision,
    trustedRevision: resourceScope.trustedRevision,
    assetCount: resourceScope.assetCount,
    subflowCount: resourceScope.subflowCount,
    initialized: Number(resourceScope.initializedAt) > 0,
  }, {
    status: 'ready',
    ready: true,
    canvasRevision: 1,
    trustedRevision: 1,
    assetCount: 0,
    subflowCount: 0,
    initialized: true,
  });

  const publicStatus = await requestJson(`${fixture.collaborationBase}/api/collab/status`);
  assert.equal(publicStatus.response.status, 200);
  for (const key of ['networkInterfaces', 'shareUrls', 'defaultHost', 'defaultPort', 'room']) {
    assert.equal(Object.hasOwn(publicStatus.payload.data, key), false, key);
  }

  const wrongCanvas = await requestJson(`${fixture.managementBase}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: PROJECT_A,
      canvasId: CANVAS_B,
      role: 'reviewer',
      maxUses: 1,
    }),
  });
  assert.equal(wrongCanvas.response.status, 404);
  assert.equal(fixture.database.listInvites(PROJECT_A).length, 0);

  const created = await requestJson(`${fixture.managementBase}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: PROJECT_A,
      canvasId: CANVAS_A,
      role: 'reviewer',
      maxUses: 1,
    }),
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.payload));
  assert.equal(created.payload.data.projectId, PROJECT_A);
  assert.equal(created.payload.data.canvasId, CANVAS_A);
  assert.equal(created.payload.data.shareUrls.length, 1);
  const inviteUrl = new URL(created.payload.data.localUrl);
  assert.equal(inviteUrl.origin, fixture.collaborationBase);
  assert.equal(inviteUrl.pathname, '/collab');
  assert.equal(inviteUrl.searchParams.get('invite'), created.payload.data.code);
  assert.equal(inviteUrl.searchParams.get('canvas'), CANVAS_A);
  assert.equal(fixture.database.listInvites(PROJECT_A).length, 1);
  assert.equal(fixture.database.listInvites(PROJECT_B).length, 0);

  const redeemed = await requestJson(`${fixture.collaborationBase}/api/collab/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: created.payload.data.code, displayName: 'Non-default reviewer' }),
  });
  assert.equal(redeemed.response.status, 200, JSON.stringify(redeemed.payload));
  assert.equal(redeemed.payload.data.projectId, PROJECT_A);

  const secondInvite = fixture.gateway.auth.createInvite({
    projectId: PROJECT_A,
    canvasId: CANVAS_A,
    role: 'viewer',
    maxUses: 1,
  });
  const siblingInvite = fixture.gateway.auth.createInvite({
    projectId: PROJECT_A,
    canvasId: CANVAS_A_SIBLING,
    role: 'viewer',
    maxUses: 1,
  });
  const roomInvites = await requestJson(
    `${fixture.managementBase}/invites?projectId=${PROJECT_A}&canvasId=${CANVAS_A}`,
  );
  assert.equal(roomInvites.response.status, 200, JSON.stringify(roomInvites.payload));
  assert.deepEqual(
    roomInvites.payload.data.map((invite) => invite.id).sort(),
    [created.payload.data.id, secondInvite.id].sort(),
  );
  assert.equal(roomInvites.payload.data.some((invite) => invite.id === siblingInvite.id), false);
  const crossProjectRevoke = await requestJson(
    `${fixture.managementBase}/invites/${encodeURIComponent(secondInvite.id)}?projectId=${PROJECT_B}&canvasId=${CANVAS_B}`,
    { method: 'DELETE' },
  );
  assert.equal(crossProjectRevoke.response.status, 404);
  assert.equal(
    fixture.database.listInvites(PROJECT_A).find((entry) => entry.id === secondInvite.id).revokedAt,
    null,
  );
  const crossCanvasRevoke = await requestJson(
    `${fixture.managementBase}/invites/${encodeURIComponent(secondInvite.id)}?projectId=${PROJECT_A}&canvasId=${CANVAS_A_SIBLING}`,
    { method: 'DELETE' },
  );
  assert.equal(crossCanvasRevoke.response.status, 404);
  assert.equal(
    fixture.database.listInvites(PROJECT_A, { canvasId: CANVAS_A })
      .find((entry) => entry.id === secondInvite.id).revokedAt,
    null,
  );

  const correctRevoke = await requestJson(
    `${fixture.managementBase}/invites/${encodeURIComponent(secondInvite.id)}?projectId=${PROJECT_A}&canvasId=${CANVAS_A}`,
    { method: 'DELETE' },
  );
  assert.equal(correctRevoke.response.status, 200);
  assert.equal(correctRevoke.payload.data.projectId, PROJECT_A);
});

test('F1 legacy room resource scope requires explicit local confirmation before invitations', async (t) => {
  const fixture = await createFixture();
  t.after(() => cleanupFixture(fixture));
  fixture.database.db.prepare(`
    UPDATE canvas_resource_grant_state
    SET initialized_at = 0
    WHERE project_id = ? AND canvas_id = ?
  `).run(PROJECT_A, CANVAS_A);
  fixture.database.upsertAsset({
    id: 'legacy-confirmed-asset',
    projectId: PROJECT_A,
    kind: 'image',
    mimeType: 'image/png',
    filename: 'legacy-confirmed.png',
    createdBy: 'local-owner',
  });
  fixture.database.saveCanvasSnapshot(CANVAS_A, {
    name: 'F1 legacy confirmation',
    nodes: [{
      id: 'legacy-resource-node',
      type: 'text',
      position: { x: 0, y: 0 },
        data: { sourceAssetId: 'legacy-confirmed-asset' },
    }],
    edges: [],
  }, {
    expectedRevision: 1,
    projectId: PROJECT_A,
    actorId: 'local-owner',
    sessionId: 'local-management',
  });
  assert.deepEqual(fixture.database.listCanvasResourceGrants(PROJECT_A, CANVAS_A).assetIds, new Set());

  const before = await requestJson(
    `${fixture.managementBase}/status?projectId=${PROJECT_A}&canvasId=${CANVAS_A}`,
  );
  assert.equal(before.response.status, 200);
  assert.deepEqual(before.payload.data.room.resourceScope, {
    status: 'confirmation-required',
    ready: false,
    canvasRevision: 2,
    trustedRevision: 2,
    initializedAt: null,
    assetCount: 0,
    subflowCount: 0,
  });

  const blockedInvite = await requestJson(`${fixture.managementBase}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: PROJECT_A,
      canvasId: CANVAS_A,
      role: 'viewer',
      maxUses: 1,
    }),
  });
  assert.equal(blockedInvite.response.status, 409);
  assert.equal(blockedInvite.payload.code, 'canvas_resource_scope_confirmation_required');

  const missingConfirmation = await requestJson(`${fixture.managementBase}/resource-scope/initialize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: PROJECT_A, canvasId: CANVAS_A }),
  });
  assert.equal(missingConfirmation.response.status, 409);
  assert.equal(missingConfirmation.payload.code, 'canvas_resource_scope_confirmation_required');

  const initialized = await requestJson(`${fixture.managementBase}/resource-scope/initialize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: PROJECT_A,
      canvasId: CANVAS_A,
      confirmed: true,
    }),
  });
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.payload));
  assert.deepEqual({
    status: initialized.payload.data.status,
    ready: initialized.payload.data.ready,
    canvasRevision: initialized.payload.data.canvasRevision,
    trustedRevision: initialized.payload.data.trustedRevision,
    assetCount: initialized.payload.data.assetCount,
    subflowCount: initialized.payload.data.subflowCount,
    initialized: Number(initialized.payload.data.initializedAt) > 0,
  }, {
    status: 'ready',
    ready: true,
    canvasRevision: 2,
    trustedRevision: 2,
    assetCount: 1,
    subflowCount: 0,
    initialized: true,
  });

  const invite = await requestJson(`${fixture.managementBase}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: PROJECT_A,
      canvasId: CANVAS_A,
      role: 'viewer',
      maxUses: 1,
    }),
  });
  assert.equal(invite.response.status, 200, JSON.stringify(invite.payload));
});

test('F1 canvas-scoped invite cannot list, read, join, or review a sibling canvas in the same project', async (t) => {
  const fixture = await createFixture();
  const sockets = [];
  t.after(() => cleanupFixture(fixture, sockets));
  fixture.database.ensureCanvas(
    CANVAS_A_SIBLING,
    { name: 'F1 A sibling', nodes: [], edges: [] },
    PROJECT_A,
  );

  const actor = await redeemActor(
    fixture,
    PROJECT_A,
    CANVAS_A,
    'reviewer',
    'Canvas A reviewer',
  );
  const headers = { cookie: actor.cookie };
  const session = await requestJson(`${fixture.collaborationBase}/api/collab/session`, { headers });
  assert.equal(session.response.status, 200);
  assert.equal(session.payload.data.projectId, PROJECT_A);
  assert.equal(session.payload.data.canvasId, CANVAS_A);

  const listed = await requestJson(`${fixture.collaborationBase}/api/collab/canvases`, { headers });
  assert.equal(listed.response.status, 200, JSON.stringify(listed.payload));
  assert.deepEqual(listed.payload.data.map((canvas) => canvas.id), [CANVAS_A]);

  const ownCanvas = await requestJson(
    `${fixture.collaborationBase}/api/collab/canvases/${encodeURIComponent(CANVAS_A)}`,
    { headers },
  );
  assert.equal(ownCanvas.response.status, 200, JSON.stringify(ownCanvas.payload));
  assert.equal(ownCanvas.payload.data.canvasId, CANVAS_A);
  const siblingCanvas = await requestJson(
    `${fixture.collaborationBase}/api/collab/canvases/${encodeURIComponent(CANVAS_A_SIBLING)}`,
    { headers },
  );
  assert.equal(siblingCanvas.response.status, 404);

  const socket = await openSocket(fixture, actor);
  sockets.push(socket);
  const ownJoin = waitForSocketMessage(
    socket,
    (message) => message.type === 'canvas.joined',
    '绑定画布加入超时',
  );
  socket.send(JSON.stringify({ type: 'canvas.join', canvasId: CANVAS_A }));
  assert.equal((await ownJoin).canvasId, CANVAS_A);
  const siblingJoin = waitForSocketMessage(
    socket,
    (message) => message.type === 'error' && message.code === 'canvas_forbidden',
    '同项目兄弟画布加入未被拒绝',
  );
  socket.send(JSON.stringify({ type: 'canvas.join', canvasId: CANVAS_A_SIBLING }));
  assert.equal((await siblingJoin).code, 'canvas_forbidden');

  const ownReview = await requestJson(`${fixture.collaborationBase}/api/collab/reviews`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      canvasId: CANVAS_A,
      expectedCanvasRevision: fixture.database.getCanvas(CANVAS_A).revision,
      anchor: { kind: 'canvas', x: 0, y: 0 },
      body: 'Allowed review on bound canvas',
    }),
  });
  assert.equal(ownReview.response.status, 201, JSON.stringify(ownReview.payload));
  const siblingReviews = await requestJson(
    `${fixture.collaborationBase}/api/collab/reviews?canvasId=${encodeURIComponent(CANVAS_A_SIBLING)}`,
    { headers },
  );
  assert.equal(siblingReviews.response.status, 404);
  const siblingReview = await requestJson(`${fixture.collaborationBase}/api/collab/reviews`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      canvasId: CANVAS_A_SIBLING,
      anchor: { kind: 'canvas', x: 0, y: 0 },
      body: 'Forbidden sibling review',
    }),
  });
  assert.equal(siblingReview.response.status, 404);
  assert.equal(
    fixture.database.listReviewThreads({
      projectId: PROJECT_A,
      canvasId: CANVAS_A_SIBLING,
    }).length,
    0,
  );
});

test('F1 member management is canvas-scoped and role updates preserve the session while refreshing WebSockets', async (t) => {
  const fixture = await createFixture();
  const sockets = [];
  t.after(() => cleanupFixture(fixture, sockets));
  fixture.database.ensureCanvas(
    CANVAS_A_SIBLING,
    { name: 'F1 A sibling', nodes: [], edges: [] },
    PROJECT_A,
  );

  const actorA = await redeemActor(fixture, PROJECT_A, CANVAS_A, 'viewer', 'A member');
  const siblingActor = await redeemActor(
    fixture,
    PROJECT_A,
    CANVAS_A_SIBLING,
    'viewer',
    'Sibling member',
  );
  const socketA = await openSocket(fixture, actorA);
  const siblingSocket = await openSocket(fixture, siblingActor);
  sockets.push(socketA, siblingSocket);

  const roomMembers = await requestJson(
    `${fixture.managementBase}/members?projectId=${PROJECT_A}&canvasId=${CANVAS_A}`,
  );
  assert.equal(roomMembers.response.status, 200, JSON.stringify(roomMembers.payload));
  assert.deepEqual(roomMembers.payload.data.map((member) => member.id), [actorA.memberId]);
  assert.equal(roomMembers.payload.data[0].canvasId, CANVAS_A);
  assert.equal(roomMembers.payload.data[0].sessionCount, 1);
  assert.equal(roomMembers.payload.data[0].connectionCount, 1);
  assert.equal(roomMembers.payload.data[0].online, true);
  const siblingMembers = await requestJson(
    `${fixture.managementBase}/members?projectId=${PROJECT_A}&canvasId=${CANVAS_A_SIBLING}`,
  );
  assert.deepEqual(siblingMembers.payload.data.map((member) => member.id), [siblingActor.memberId]);

  const wrongCanvasUpdate = await requestJson(
    `${fixture.managementBase}/members/${encodeURIComponent(actorA.memberId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: PROJECT_A,
        canvasId: CANVAS_A_SIBLING,
        role: 'reviewer',
      }),
    },
  );
  assert.equal(wrongCanvasUpdate.response.status, 404);
  const unchangedSession = await requestJson(`${fixture.collaborationBase}/api/collab/session`, {
    headers: { cookie: actorA.cookie },
  });
  assert.equal(unchangedSession.response.status, 200);
  assert.equal(unchangedSession.payload.data.role, 'viewer');
  assert.equal(socketA.readyState, WebSocket.OPEN);

  const changedNotice = waitForSocketMessage(
    socketA,
    (message) => message.type === 'session.changed',
    '角色更新未发送 session.changed',
  );
  const changedClose = waitForClose(socketA);
  const updated = await requestJson(
    `${fixture.managementBase}/members/${encodeURIComponent(actorA.memberId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: PROJECT_A,
        canvasId: CANVAS_A,
        role: 'reviewer',
      }),
    },
  );
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.data.id, actorA.memberId);
  assert.equal(updated.payload.data.canvasId, CANVAS_A);
  assert.equal(updated.payload.data.role, 'reviewer');
  assert.equal(updated.payload.data.disconnectedConnections, 1);
  assert.equal((await changedNotice).reason, 'member role changed');
  assert.deepEqual(await changedClose, {
    code: 4002,
    reason: 'member role changed',
  });

  const refreshedSession = await requestJson(`${fixture.collaborationBase}/api/collab/session`, {
    headers: { cookie: actorA.cookie },
  });
  assert.equal(refreshedSession.response.status, 200, JSON.stringify(refreshedSession.payload));
  assert.equal(refreshedSession.payload.data.id, actorA.sessionId);
  assert.equal(refreshedSession.payload.data.memberId, actorA.memberId);
  assert.equal(refreshedSession.payload.data.canvasId, CANVAS_A);
  assert.equal(refreshedSession.payload.data.role, 'reviewer');
  assert.deepEqual(
    refreshedSession.payload.data.capabilities.sort(),
    ['approve', 'comment', 'downloadOriginal'].sort(),
  );
  assert.equal(siblingSocket.readyState, WebSocket.OPEN);

  const refreshedSocket = await openSocket(fixture, actorA);
  sockets.push(refreshedSocket);
  const wrongCanvasRemove = await requestJson(
    `${fixture.managementBase}/members/${encodeURIComponent(actorA.memberId)}?projectId=${PROJECT_A}&canvasId=${CANVAS_A_SIBLING}`,
    { method: 'DELETE' },
  );
  assert.equal(wrongCanvasRemove.response.status, 404);
  assert.equal(refreshedSocket.readyState, WebSocket.OPEN);
  const removedClose = waitForClose(refreshedSocket);
  const removed = await requestJson(
    `${fixture.managementBase}/members/${encodeURIComponent(actorA.memberId)}?projectId=${PROJECT_A}&canvasId=${CANVAS_A}`,
    { method: 'DELETE' },
  );
  assert.equal(removed.response.status, 200, JSON.stringify(removed.payload));
  assert.equal(removed.payload.data.id, actorA.memberId);
  assert.equal(removed.payload.data.canvasId, CANVAS_A);
  assert.equal(removed.payload.data.disconnectedConnections, 1);
  assert.deepEqual(await removedClose, {
    code: 4001,
    reason: 'member removed',
  });
  assert.equal(
    (await fetch(`${fixture.collaborationBase}/api/collab/session`, {
      headers: { cookie: actorA.cookie },
    })).status,
    401,
  );
  assert.equal(
    (await fetch(`${fixture.collaborationBase}/api/collab/session`, {
      headers: { cookie: siblingActor.cookie },
    })).status,
    200,
  );
  assert.equal(siblingSocket.readyState, WebSocket.OPEN);
});

test('F1 run-intent management rejects cross-room patches without mutating target intents', async (t) => {
  const fixture = await createFixture();
  t.after(() => cleanupFixture(fixture));
  fixture.database.ensureCanvas(
    CANVAS_A_SIBLING,
    { name: 'F1 A sibling', nodes: [], edges: [] },
    PROJECT_A,
  );

  const canvasA = fixture.database.getCanvas(CANVAS_A);
  const canvasASibling = fixture.database.getCanvas(CANVAS_A_SIBLING);
  const canvasB = fixture.database.getCanvas(CANVAS_B);
  const intentA = fixture.database.createRunIntent({
    projectId: PROJECT_A,
    canvasId: CANVAS_A,
    canvasRevision: canvasA.revision,
    nodeIds: [],
    idempotencyKey: 'f1-management-intent-a',
    requestedBy: 'member-f1-a',
  });
  const intentASibling = fixture.database.createRunIntent({
    projectId: PROJECT_A,
    canvasId: CANVAS_A_SIBLING,
    canvasRevision: canvasASibling.revision,
    nodeIds: [],
    idempotencyKey: 'f1-management-intent-a-sibling',
    requestedBy: 'member-f1-a-sibling',
  });
  const intentB = fixture.database.createRunIntent({
    projectId: PROJECT_B,
    canvasId: CANVAS_B,
    canvasRevision: canvasB.revision,
    nodeIds: [],
    idempotencyKey: 'f1-management-intent-b',
    requestedBy: 'member-f1-b',
  });
  const listedA = await requestJson(
    `${fixture.managementBase}/run-intents?projectId=${PROJECT_A}&canvasId=${CANVAS_A}`,
  );
  assert.equal(listedA.response.status, 200, JSON.stringify(listedA.payload));
  assert.deepEqual(listedA.payload.data.map((intent) => intent.id), [intentA.id]);
  const listedASibling = await requestJson(
    `${fixture.managementBase}/run-intents?projectId=${PROJECT_A}&canvasId=${CANVAS_A_SIBLING}`,
  );
  assert.deepEqual(listedASibling.payload.data.map((intent) => intent.id), [intentASibling.id]);

  const intentASiblingBeforeCrossCanvasPatch = fixture.database.getRunIntent(intentASibling.id);
  const crossCanvasPatch = await requestJson(
    `${fixture.managementBase}/run-intents/${encodeURIComponent(intentASibling.id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: PROJECT_A,
        canvasId: CANVAS_A,
        expectedQueueRevision: intentASiblingBeforeCrossCanvasPatch.queueRevision,
        status: 'rejected',
      }),
    },
  );
  assert.equal(crossCanvasPatch.response.status, 404);
  assert.equal(crossCanvasPatch.payload.error, '运行意图不存在');
  assert.deepEqual(
    fixture.database.getRunIntent(intentASibling.id),
    intentASiblingBeforeCrossCanvasPatch,
  );
  const intentBBeforeCrossProjectPatch = fixture.database.getRunIntent(intentB.id);

  const crossProjectPatch = await requestJson(
    `${fixture.managementBase}/run-intents/${encodeURIComponent(intentB.id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: PROJECT_A,
        canvasId: CANVAS_A,
        expectedQueueRevision: intentBBeforeCrossProjectPatch.queueRevision,
        status: 'rejected',
      }),
    },
  );
  assert.equal(crossProjectPatch.response.status, 404);
  assert.equal(crossProjectPatch.payload.error, '运行意图不存在');
  assert.deepEqual(fixture.database.getRunIntent(intentB.id), intentBBeforeCrossProjectPatch);
  assert.equal(fixture.database.getRunIntent(intentA.id).status, 'pending');

  const correctProjectPatch = await requestJson(
    `${fixture.managementBase}/run-intents/${encodeURIComponent(intentB.id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: PROJECT_B,
        canvasId: CANVAS_B,
        expectedQueueRevision: fixture.database.getRunIntent(intentB.id).queueRevision,
        status: 'rejected',
      }),
    },
  );
  assert.equal(correctProjectPatch.response.status, 200, JSON.stringify(correctProjectPatch.payload));
  assert.equal(correctProjectPatch.payload.data.id, intentB.id);
  assert.equal(correctProjectPatch.payload.data.projectId, PROJECT_B);
  assert.equal(correctProjectPatch.payload.data.status, 'rejected');
  assert.equal(fixture.database.getRunIntent(intentB.id).status, 'rejected');
  assert.equal(fixture.database.getRunIntent(intentA.id).status, 'pending');
});

test('F1 session management lists safe metadata and single/all revocation immediately close only scoped WebSockets', async (t) => {
  const fixture = await createFixture();
  const sockets = [];
  t.after(() => cleanupFixture(fixture, sockets));
  fixture.database.ensureCanvas(
    CANVAS_A_SIBLING,
    { name: 'F1 A sibling', nodes: [], edges: [] },
    PROJECT_A,
  );

  const actorA1 = await redeemActor(fixture, PROJECT_A, CANVAS_A, 'viewer', 'A1');
  const actorA2 = await redeemActor(fixture, PROJECT_A, CANVAS_A, 'reviewer', 'A2');
  const actorASibling = await redeemActor(
    fixture,
    PROJECT_A,
    CANVAS_A_SIBLING,
    'viewer',
    'A sibling',
  );
  const actorB1 = await redeemActor(fixture, PROJECT_B, CANVAS_B, 'viewer', 'B1');
  const socketA1 = await openSocket(fixture, actorA1);
  const socketA2 = await openSocket(fixture, actorA2);
  const socketASibling = await openSocket(fixture, actorASibling);
  const socketB1 = await openSocket(fixture, actorB1);
  sockets.push(socketA1, socketA2, socketASibling, socketB1);

  const listed = await requestJson(
    `${fixture.managementBase}/sessions?projectId=${PROJECT_A}&canvasId=${CANVAS_A}`,
  );
  assert.equal(listed.response.status, 200);
  assert.equal(listed.payload.data.length, 2);
  for (const session of listed.payload.data) {
    assert.equal(session.projectId, PROJECT_A);
    assert.equal(session.canvasId, CANVAS_A);
    assert.equal(session.active, true);
    assert.equal(session.connected, true);
    assert.equal(session.connectionCount, 1);
    for (const secretField of ['token', 'tokenHash', 'token_hash']) {
      assert.equal(Object.hasOwn(session, secretField), false, secretField);
    }
  }
  const siblingListed = await requestJson(
    `${fixture.managementBase}/sessions?projectId=${PROJECT_A}&canvasId=${CANVAS_A_SIBLING}`,
  );
  assert.deepEqual(siblingListed.payload.data.map((session) => session.id), [actorASibling.sessionId]);

  const crossProjectRevoke = await requestJson(
    `${fixture.managementBase}/sessions/${encodeURIComponent(actorA1.sessionId)}?projectId=${PROJECT_B}&canvasId=${CANVAS_B}`,
    { method: 'DELETE' },
  );
  assert.equal(crossProjectRevoke.response.status, 404);
  const crossCanvasRevoke = await requestJson(
    `${fixture.managementBase}/sessions/${encodeURIComponent(actorA1.sessionId)}?projectId=${PROJECT_A}&canvasId=${CANVAS_A_SIBLING}`,
    { method: 'DELETE' },
  );
  assert.equal(crossCanvasRevoke.response.status, 404);
  assert.equal(socketA1.readyState, WebSocket.OPEN);
  assert.equal(
    (await fetch(`${fixture.collaborationBase}/api/collab/session`, {
      headers: { cookie: actorA1.cookie },
    })).status,
    200,
  );

  const closeA1 = waitForClose(socketA1);
  const singleRevoke = await requestJson(
    `${fixture.managementBase}/sessions/${encodeURIComponent(actorA1.sessionId)}?projectId=${PROJECT_A}&canvasId=${CANVAS_A}`,
    { method: 'DELETE' },
  );
  assert.equal(singleRevoke.response.status, 200);
  assert.equal(singleRevoke.payload.data.projectId, PROJECT_A);
  assert.equal(singleRevoke.payload.data.canvasId, CANVAS_A);
  assert.equal(singleRevoke.payload.data.disconnectedConnections, 1);
  assert.deepEqual(await closeA1, {
    code: 4001,
    reason: 'session revoked by host',
  });
  assert.equal(fixture.gateway.connectionCountForSession(actorA1.sessionId), 0);
  assert.equal(
    (await fetch(`${fixture.collaborationBase}/api/collab/session`, {
      headers: { cookie: actorA1.cookie },
    })).status,
    401,
  );
  assert.equal(socketA2.readyState, WebSocket.OPEN);
  assert.equal(socketASibling.readyState, WebSocket.OPEN);
  assert.equal(socketB1.readyState, WebSocket.OPEN);

  const closeA2 = waitForClose(socketA2);
  const revokeAll = await requestJson(`${fixture.managementBase}/sessions/revoke-all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: PROJECT_A, canvasId: CANVAS_A }),
  });
  assert.equal(revokeAll.response.status, 200);
  assert.deepEqual(revokeAll.payload.data, {
    projectId: PROJECT_A,
    canvasId: CANVAS_A,
    revokedSessions: 1,
    disconnectedConnections: 1,
  });
  assert.deepEqual(await closeA2, {
    code: 4001,
    reason: 'all canvas sessions revoked by host',
  });
  assert.equal(fixture.gateway.connectionCountForCanvas(PROJECT_A, CANVAS_A), 0);
  assert.equal(fixture.gateway.connectionCountForCanvas(PROJECT_A, CANVAS_A_SIBLING), 1);
  assert.equal(fixture.gateway.connectionCountForProject(PROJECT_A), 1);
  assert.equal(fixture.gateway.connectionCountForProject(PROJECT_B), 1);
  assert.equal(
    (await fetch(`${fixture.collaborationBase}/api/collab/session`, {
      headers: { cookie: actorA2.cookie },
    })).status,
    401,
  );
  assert.equal(
    (await fetch(`${fixture.collaborationBase}/api/collab/session`, {
      headers: { cookie: actorASibling.cookie },
    })).status,
    200,
  );
  assert.equal(
    (await fetch(`${fixture.collaborationBase}/api/collab/session`, {
      headers: { cookie: actorB1.cookie },
    })).status,
    200,
  );
  assert.equal(socketASibling.readyState, WebSocket.OPEN);
  assert.equal(socketB1.readyState, WebSocket.OPEN);

  const roomStatus = await requestJson(
    `${fixture.managementBase}/status?projectId=${PROJECT_A}&canvasId=${CANVAS_A}`,
  );
  assert.equal(roomStatus.payload.data.room.activeSessionCount, 0);
  assert.equal(roomStatus.payload.data.room.connectionCount, 0);
  const siblingRoomStatus = await requestJson(
    `${fixture.managementBase}/status?projectId=${PROJECT_A}&canvasId=${CANVAS_A_SIBLING}`,
  );
  assert.equal(siblingRoomStatus.payload.data.room.activeSessionCount, 1);
  assert.equal(siblingRoomStatus.payload.data.room.connectionCount, 1);
});
