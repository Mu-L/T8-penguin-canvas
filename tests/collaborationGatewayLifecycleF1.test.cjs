const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { CollaborationAuth } = require('../backend/src/collaboration/auth');
const { CollaborationGateway, SESSION_COOKIE } = require('../backend/src/collaboration/gateway');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

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

function createGatewayFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-f1-lifecycle-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const database = new ProjectDatabase(':memory:');
  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    FRONTEND_DIST: '',
    INPUT_DIR: input,
    OUTPUT_DIR: output,
  }, database, {
    listNetworkInterfaces: () => LOOPBACK_INTERFACES.map((entry) => ({ ...entry })),
  });
  return { directory, database, gateway };
}

async function cleanupFixture(fixture) {
  await fixture.gateway.stop();
  fixture.database.close();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function occupyPort() {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    port: typeof address === 'object' && address ? address.port : 0,
  };
}

async function closeNetServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function waitForSocketClose(socket, timeoutMs, message) {
  if (socket.destroyed) return Promise.resolve();
  return withTimeout(
    new Promise((resolve) => socket.once('close', resolve)),
    timeoutMs,
    message,
  );
}

async function waitForCondition(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function openUnresponsiveWebSocket(port, sessionToken) {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.setNoDelay(true);
  socket.on('error', () => {
    // Forced termination can surface as ECONNRESET on the intentionally non-compliant client.
  });
  await withTimeout(
    new Promise((resolve, reject) => {
      let response = Buffer.alloc(0);
      const fail = (error) => {
        socket.off('connect', sendUpgrade);
        socket.off('data', readUpgrade);
        reject(error);
      };
      const sendUpgrade = () => {
        const key = crypto.randomBytes(16).toString('base64');
        socket.write([
          'GET /ws/collab HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          `Sec-WebSocket-Key: ${key}`,
          `Origin: http://127.0.0.1:${port}`,
          `Cookie: ${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
          '',
          '',
        ].join('\r\n'));
      };
      const readUpgrade = (chunk) => {
        response = Buffer.concat([response, chunk]);
        const headerEnd = response.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        socket.off('data', readUpgrade);
        const head = response.subarray(0, headerEnd).toString('latin1');
        if (!/^HTTP\/1\.1 101 Switching Protocols\r\n/i.test(head)) {
          fail(new Error(`WebSocket upgrade failed: ${head.split('\r\n')[0] || '(empty)'}`));
          return;
        }
        socket.on('data', () => {
          // Deliberately consume server frames without parsing or acknowledging close frames.
        });
        resolve();
      };
      socket.once('connect', sendUpgrade);
      socket.once('error', fail);
      socket.on('data', readUpgrade);
    }),
    3000,
    'WebSocket upgrade timed out',
  );
  return socket;
}

function createUnresponsiveActor(gateway, projectId, displayName) {
  const canvasId = `${projectId}-canvas`;
  gateway.database.ensureCanvas(canvasId, { nodes: [], edges: [] }, projectId);
  const invite = gateway.auth.createInvite({
    projectId,
    canvasId,
    role: 'viewer',
    maxUses: 1,
  });
  const actor = gateway.auth.redeemInvite(invite.code, displayName);
  assert.ok(actor);
  return actor;
}

test('F1 concurrent starts with the same ephemeral request share one listener', async (t) => {
  const fixture = createGatewayFixture();
  t.after(() => cleanupFixture(fixture));
  let startInternalCalls = 0;
  const originalStartInternal = fixture.gateway.startInternal.bind(fixture.gateway);
  fixture.gateway.startInternal = async (...args) => {
    startInternalCalls += 1;
    return originalStartInternal(...args);
  };

  const [first, second] = await Promise.all([
    fixture.gateway.start({ host: '127.0.0.1', port: 0 }),
    fixture.gateway.start({ host: '127.0.0.1', port: 0 }),
  ]);

  assert.equal(startInternalCalls, 1);
  assert.equal(first.port, second.port);
  assert.equal(first.startedAt, second.startedAt);
  assert.equal(fixture.gateway.status().port, first.port);
  assert.equal(await canConnect(first.port), true);
});

test('F1 changing the running port closes the old listener and exposes the new listener', async (t) => {
  const fixture = createGatewayFixture();
  t.after(() => cleanupFixture(fixture));

  const first = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  const nextPort = await reservePort();
  const second = await fixture.gateway.start({ host: '127.0.0.1', port: nextPort });

  assert.equal(second.running, true);
  assert.equal(second.host, '127.0.0.1');
  assert.equal(second.port, nextPort);
  assert.notEqual(first.port, second.port);
  assert.equal(await canConnect(first.port), false);
  assert.equal(await canConnect(second.port), true);
});

test('F1 stop and following start serialize behind an active HTTP request without leaving an orphan listener', async (t) => {
  const fixture = createGatewayFixture();
  t.after(() => cleanupFixture(fixture));
  const requestStarted = deferred();
  const releaseRequest = deferred();
  fixture.gateway.createApp = () => (req, res) => {
    if (req.url !== '/__f1_hold') {
      res.writeHead(404, { connection: 'close' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/plain',
      connection: 'close',
    });
    res.write('held');
    requestStarted.resolve();
    releaseRequest.promise.then(
      () => {
        if (!res.writableEnded) res.end(':released');
      },
      () => {
        if (!res.writableEnded) res.destroy();
      },
    );
  };

  const oldStatus = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  const activeResponse = await fetch(`http://127.0.0.1:${oldStatus.port}/__f1_hold`);
  assert.equal(activeResponse.status, 200);
  const activeBody = activeResponse.text();
  await requestStarted.promise;

  const nextPort = await reservePort();
  const events = [];
  const stopEntered = deferred();
  const originalStopInternal = fixture.gateway.stopInternal.bind(fixture.gateway);
  fixture.gateway.stopInternal = async (...args) => {
    events.push('stop:begin');
    stopEntered.resolve();
    const result = await originalStopInternal(...args);
    events.push('stop:end');
    return result;
  };
  const originalStartInternal = fixture.gateway.startInternal.bind(fixture.gateway);
  fixture.gateway.startInternal = async (...args) => {
    events.push('start:begin');
    const result = await originalStartInternal(...args);
    events.push('start:end');
    return result;
  };

  const stopPromise = fixture.gateway.stop();
  const startPromise = fixture.gateway.start({ host: '127.0.0.1', port: nextPort });
  await stopEntered.promise;
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(events, ['stop:begin']);
    assert.equal(await canConnect(nextPort), false);
  } finally {
    releaseRequest.resolve();
    await Promise.allSettled([activeBody, stopPromise, startPromise]);
  }

  const started = await startPromise;
  assert.deepEqual(events, ['stop:begin', 'stop:end', 'start:begin', 'start:end']);
  assert.equal(started.running, true);
  assert.equal(started.host, '127.0.0.1');
  assert.equal(started.port, nextPort);
  assert.deepEqual(
    {
      running: fixture.gateway.status().running,
      host: fixture.gateway.status().host,
      port: fixture.gateway.status().port,
    },
    { running: true, host: '127.0.0.1', port: nextPort },
  );
  assert.equal(await canConnect(oldStatus.port), false);
  assert.equal(await canConnect(nextPort), true);
});

test('F1 failed port update preserves the old reachable listener and its authoritative status', async (t) => {
  const fixture = createGatewayFixture();
  t.after(() => cleanupFixture(fixture));
  const oldStatus = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  const blocker = await occupyPort();
  t.after(() => closeNetServer(blocker.server));

  await assert.rejects(
    fixture.gateway.start({ host: '127.0.0.1', port: blocker.port }),
    (error) => {
      assert.equal(error?.code, 'EADDRINUSE');
      return true;
    },
  );

  const statusAfterFailure = fixture.gateway.status();
  assert.deepEqual(
    {
      running: statusAfterFailure.running,
      host: statusAfterFailure.host,
      port: statusAfterFailure.port,
      startedAt: statusAfterFailure.startedAt,
    },
    {
      running: true,
      host: oldStatus.host,
      port: oldStatus.port,
      startedAt: oldStatus.startedAt,
    },
  );
  const publicStatus = await fetch(`http://127.0.0.1:${oldStatus.port}/api/collab/status`);
  const publicPayload = await publicStatus.json();
  assert.equal(publicStatus.status, 200);
  assert.equal(publicPayload.data.running, true);
  assert.equal(Object.hasOwn(publicPayload.data, 'host'), false);
  assert.equal(Object.hasOwn(publicPayload.data, 'port'), false);
  assert.equal(await canConnect(oldStatus.port), true);

  await closeNetServer(blocker.server);
  assert.equal(await canConnect(blocker.port), false);
  assert.equal(await canConnect(oldStatus.port), true);
});

test('F1 stop force-terminates a WebSocket client that never acknowledges the close frame', async (t) => {
  const fixture = createGatewayFixture();
  let socket = null;
  t.after(async () => {
    socket?.destroy();
    await cleanupFixture(fixture);
  });

  const running = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  const actor = createUnresponsiveActor(fixture.gateway, 'project-f1-stop', 'Unresponsive stop client');
  socket = await openUnresponsiveWebSocket(running.port, actor.token);
  assert.equal(fixture.gateway.connectionCountForSession(actor.sessionId), 1);
  const socketClosed = waitForSocketClose(socket, 3000, 'stop() did not terminate the unresponsive WebSocket');

  const startedAt = Date.now();
  const stopped = await withTimeout(
    fixture.gateway.stop(),
    3000,
    'stop() did not resolve within the bounded WebSocket shutdown window',
  );
  const elapsedMs = Date.now() - startedAt;

  await socketClosed;
  assert.ok(elapsedMs < 3000, `stop() took ${elapsedMs}ms`);
  assert.equal(stopped.running, false);
  assert.equal(fixture.gateway.connectionCountForSession(actor.sessionId), 0);
  assert.equal(await canConnect(running.port), false);
});

test('F1 scoped connection closes terminate unresponsive session, member, and project WebSockets after a short grace period', async (t) => {
  const fixture = createGatewayFixture();
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await cleanupFixture(fixture);
  });

  const running = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  const sessionActor = createUnresponsiveActor(fixture.gateway, 'project-f1-scoped-session', 'Scoped session');
  const memberActor = createUnresponsiveActor(fixture.gateway, 'project-f1-scoped-member', 'Scoped member');
  const projectActor = createUnresponsiveActor(fixture.gateway, 'project-f1-scoped-project', 'Scoped project');
  for (const actor of [sessionActor, memberActor, projectActor]) {
    sockets.push(await openUnresponsiveWebSocket(running.port, actor.token));
  }
  assert.equal(fixture.gateway.connectionCountForSession(sessionActor.sessionId), 1);
  assert.equal(fixture.gateway.connectionCountForSession(memberActor.sessionId), 1);
  assert.equal(fixture.gateway.connectionCountForSession(projectActor.sessionId), 1);
  const closed = sockets.map((socket, index) => waitForSocketClose(
    socket,
    1500,
    `scoped close did not terminate unresponsive WebSocket ${index + 1}`,
  ));

  const startedAt = Date.now();
  assert.equal(fixture.gateway.closeSessionConnections(sessionActor.sessionId, 'F1 session close'), 1);
  assert.equal(fixture.gateway.closeMemberConnections(memberActor.memberId, 'F1 member close'), 1);
  assert.equal(fixture.gateway.closeProjectConnections(projectActor.projectId, 'F1 project close'), 1);
  await Promise.all(closed);
  await waitForCondition(
    () => fixture.gateway.connectionCountForSession(sessionActor.sessionId) === 0
      && fixture.gateway.connectionCountForSession(memberActor.sessionId) === 0
      && fixture.gateway.connectionCountForSession(projectActor.sessionId) === 0,
    500,
    'terminated scoped WebSockets remained in the gateway connection registry',
  );
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 1500, `scoped WebSocket termination took ${elapsedMs}ms`);
  assert.equal(fixture.gateway.connectionCountForSession(sessionActor.sessionId), 0);
  assert.equal(fixture.gateway.connectionCountForSession(memberActor.sessionId), 0);
  assert.equal(fixture.gateway.connectionCountForSession(projectActor.sessionId), 0);
  assert.equal(fixture.gateway.status().running, true);
  assert.equal(await canConnect(running.port), true);
});

test('F1 stop is idempotent and returns only after the collaboration port is reclaimed', async (t) => {
  const fixture = createGatewayFixture();
  t.after(() => cleanupFixture(fixture));

  const running = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  assert.equal(await canConnect(running.port), true);

  const stopped = await fixture.gateway.stop();
  assert.equal(stopped.running, false);
  assert.equal(stopped.host, null);
  assert.equal(stopped.port, null);
  assert.equal(await canConnect(running.port), false);

  const stoppedAgain = await fixture.gateway.stop();
  assert.equal(stoppedAgain.running, false);
  assert.equal(await canConnect(running.port), false);
});

test('F1 public status omits local topology while management status contains host-only details', async (t) => {
  const fixture = createGatewayFixture();
  t.after(() => cleanupFixture(fixture));
  const running = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });

  const response = await fetch(`http://127.0.0.1:${running.port}/api/collab/status`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.data.service, 't8-collaboration-gateway');
  for (const key of ['networkInterfaces', 'shareUrls', 'defaultHost', 'defaultPort']) {
    assert.equal(Object.hasOwn(payload.data, key), false, key);
  }

  const management = fixture.gateway.managementStatus();
  assert.deepEqual(management.networkInterfaces, LOOPBACK_INTERFACES);
  assert.deepEqual(management.shareUrls, [`http://127.0.0.1:${running.port}/collab`]);
  assert.equal(management.defaultHost, '127.0.0.1');
  assert.equal(management.defaultPort, 18767);
});

test('F1 invite maxUses accepts integer boundaries and rejects fractional or out-of-range values', () => {
  const database = new ProjectDatabase(':memory:');
  const auth = new CollaborationAuth(database);
  try {
    database.ensureCanvas('canvas-f1-local', { nodes: [], edges: [] }, 'project-local');
    database.ensureCanvas('canvas-f1', { nodes: [], edges: [] }, 'project-f1');
    const localScope = { projectId: 'project-local', canvasId: 'canvas-f1-local' };
    assert.equal(auth.createInvite({ ...localScope, maxUses: 1 }).maxUses, 1);
    assert.equal(auth.createInvite({ ...localScope, maxUses: 100 }).maxUses, 100);
    assert.equal(auth.createInvite({ ...localScope, maxUses: '' }).maxUses, 1);
    assert.equal(auth.createInvite(localScope).maxUses, 1);

    for (const value of [0, -1, 101, 1.01, 1.5, 1.99, 99.9, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => auth.createInvite({ ...localScope, maxUses: value }),
        /1-100 的整数/,
        String(value),
      );
    }

    const twice = auth.createInvite({
      projectId: 'project-f1',
      canvasId: 'canvas-f1',
      role: 'viewer',
      maxUses: 2,
    });
    assert.ok(auth.redeemInvite(twice.code, 'first'));
    assert.ok(auth.redeemInvite(twice.code, 'second'));
    assert.equal(auth.redeemInvite(twice.code, 'third'), null);
    assert.equal(database.listInvites('project-f1')[0].useCount, 2);
  } finally {
    database.close();
  }
});
