const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');

const {
  CollaborationGateway,
  SESSION_COOKIE,
  createFixedWindowLimiter,
  requestClientAddress,
} = require('../backend/src/collaboration/gateway');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

function createGatewayFixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b3-security-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const database = new ProjectDatabase(':memory:');
  database.ensureCanvas('canvas-b3', { nodes: [], edges: [] }, 'project-b3');
  database.initializeCanvasResourceGrantsForSharing('project-b3', 'canvas-b3', {
    actorId: 'local-owner',
    sessionId: 'b3-fixture',
  });
  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    FRONTEND_DIST: '',
    INPUT_DIR: input,
    OUTPUT_DIR: output,
  }, database, options);
  return { directory, database, gateway };
}

async function cleanupFixture(fixture, sockets = []) {
  for (const socket of sockets) {
    if (!socket || socket.readyState === WebSocket.CLOSED) continue;
    try { socket.terminate(); } catch (_) { /* already closed */ }
  }
  await fixture.gateway.stop();
  fixture.database.close();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

function createActor(gateway, displayName) {
  const invite = gateway.auth.createInvite({
    projectId: 'project-b3',
    canvasId: 'canvas-b3',
    role: 'viewer',
    maxUses: 1,
  });
  const actor = gateway.auth.redeemInvite(invite.code, displayName);
  assert.ok(actor);
  return actor;
}

function connectWebSocket(port, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/collab`, {
    origin: `http://127.0.0.1:${port}`,
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new Error('B3 WebSocket connection timed out'));
    }, 3_000);
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      finish({ socket, status: response.statusCode, ready: false });
    });
    socket.once('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'session.ready') finish({ socket, status: 101, ready: true });
    });
  });
}

function waitForClose(socket, timeoutMs = 3_000) {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve({ code: socket._closeCode, reason: String(socket._closeMessage || '') });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('B3 WebSocket close timed out')), timeoutMs);
    socket.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reason) });
    });
  });
}

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = waitForClose(socket);
  socket.close();
  await closed;
}

test('B3 HTTP identity ignores rotating X-Forwarded-For by default and limiter storage is bounded', async (t) => {
  const directRequest = {
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    headers: { 'x-forwarded-for': '198.51.100.11' },
  };
  assert.equal(requestClientAddress(directRequest), '127.0.0.1');
  assert.equal(
    requestClientAddress(directRequest, new Set(['127.0.0.1'])),
    '198.51.100.11',
  );

  let clock = 0;
  const limiter = createFixedWindowLimiter({
    limit: 10,
    windowMs: 100,
    maxBuckets: 3,
    now: () => clock,
  });
  assert.equal(limiter.consume('one').allowed, true);
  assert.equal(limiter.consume('two').allowed, true);
  assert.equal(limiter.consume('three').allowed, true);
  assert.equal(limiter.size, 3);
  assert.deepEqual(limiter.consume('four'), {
    allowed: false,
    retryAfterMs: 100,
    reason: 'bucket_capacity',
  });
  assert.equal(limiter.size, 3);
  clock = 101;
  assert.equal(limiter.consume('four').allowed, true);
  assert.equal(limiter.size, 1);

  const fixture = createGatewayFixture();
  t.after(() => cleanupFixture(fixture));
  const status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  const statuses = [];
  for (let index = 0; index < 13; index += 1) {
    const response = await fetch(`http://127.0.0.1:${status.port}/api/collab/invites/redeem`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `198.51.100.${index + 1}`,
      },
      body: JSON.stringify({ code: 'invalid-b3-invite', displayName: 'rate test' }),
    });
    statuses.push(response.status);
    await response.arrayBuffer();
  }
  assert.deepEqual(statuses, [...Array(12).fill(400), 429]);
});

test('B3 malformed WebSocket frames consume the raw-frame rate budget before JSON parsing', async (t) => {
  const fixture = createGatewayFixture({ webSocketMessagesPerWindow: 3 });
  const sockets = [];
  t.after(() => cleanupFixture(fixture, sockets));
  const status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  const actor = createActor(fixture.gateway, 'Malformed flood actor');
  const opened = await connectWebSocket(status.port, actor.token);
  assert.equal(opened.ready, true);
  sockets.push(opened.socket);
  const closed = waitForClose(opened.socket);
  for (let index = 0; index < 4; index += 1) opened.socket.send('{not-json');
  assert.deepEqual(await closed, { code: 1008, reason: 'message rate exceeded' });
});

test('B3 WebSocket handshake and active connection caps apply per IP and session and release on close', async (t) => {
  const fixture = createGatewayFixture({
    webSocketMaxConnectionsPerIp: 2,
    webSocketMaxConnectionsPerSession: 1,
    webSocketHandshakesPerMinutePerIp: 100,
    webSocketHandshakesPerMinutePerSession: 100,
  });
  const sockets = [];
  t.after(() => cleanupFixture(fixture, sockets));
  const status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  const actorA = createActor(fixture.gateway, 'Active A');
  const actorB = createActor(fixture.gateway, 'Active B');
  const actorC = createActor(fixture.gateway, 'Active C');

  const first = await connectWebSocket(status.port, actorA.token);
  assert.equal(first.ready, true);
  sockets.push(first.socket);
  const sameSession = await connectWebSocket(status.port, actorA.token);
  assert.equal(sameSession.status, 429);

  const second = await connectWebSocket(status.port, actorB.token);
  assert.equal(second.ready, true);
  sockets.push(second.socket);
  const sameIp = await connectWebSocket(status.port, actorC.token);
  assert.equal(sameIp.status, 429);

  await closeSocket(first.socket);
  const afterRelease = await connectWebSocket(status.port, actorC.token);
  assert.equal(afterRelease.ready, true);
  sockets.push(afterRelease.socket);
});

test('B3 WebSocket handshake-rate buckets enforce both session and IP identities', async (t) => {
  const fixture = createGatewayFixture({
    webSocketMaxConnectionsPerIp: 10,
    webSocketMaxConnectionsPerSession: 10,
    webSocketHandshakesPerMinutePerIp: 3,
    webSocketHandshakesPerMinutePerSession: 2,
  });
  const sockets = [];
  t.after(() => cleanupFixture(fixture, sockets));
  const status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  const actorA = createActor(fixture.gateway, 'Handshake A');
  const actorB = createActor(fixture.gateway, 'Handshake B');

  for (let index = 0; index < 2; index += 1) {
    const opened = await connectWebSocket(status.port, actorA.token);
    assert.equal(opened.ready, true);
    sockets.push(opened.socket);
    await closeSocket(opened.socket);
  }
  const sessionLimited = await connectWebSocket(status.port, actorA.token);
  assert.equal(sessionLimited.status, 429);
  const ipLimited = await connectWebSocket(status.port, actorB.token);
  assert.equal(ipLimited.status, 429);
});
