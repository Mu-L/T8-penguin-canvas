const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WebSocket } = require('ws');

const {
  applyCanvasOperation,
  normalizeCanvasDocument,
} = require('../../backend/src/collaboration/protocol');
const { CollaborationGateway } = require('../../backend/src/collaboration/gateway');
const { ProjectDatabase } = require('../../backend/src/services/projectDatabase');

const DEFAULT_PROJECT_ID = 'project-f2-reconnect';
const DEFAULT_CANVAS_ID = 'canvas-f2-reconnect';
const MANAGEMENT_AUTHORITY_HEADER = 'x-t8-collaboration-management-token';
const TEST_MANAGEMENT_AUTHORITY = Object.freeze({
  token: 'test-collaboration-management-authority-token-00000001',
  actorId: 'test-host-owner',
  sessionId: 'test-host-backend-session',
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

async function eventually(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (lastError) throw lastError;
  throw new Error(message);
}

function defaultCanvasSnapshot() {
  return {
    name: 'F2 reconnect test canvas',
    nodes: [
      { id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: { text: 'A' } },
      { id: 'node-b', type: 'text', position: { x: 160, y: 0 }, data: { text: 'B' } },
      { id: 'node-c', type: 'text', position: { x: 320, y: 0 }, data: { text: 'C' } },
    ],
    edges: [],
  };
}

function gatewayConfig(directory) {
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  return {
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    FRONTEND_DIST: '',
    INPUT_DIR: input,
    OUTPUT_DIR: output,
  };
}

async function createFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-f2-collaboration-'));
  const projectId = String(options.projectId || DEFAULT_PROJECT_ID);
  const canvasId = String(options.canvasId || DEFAULT_CANVAS_ID);
  const databaseFilename = options.persistent === true
    ? path.join(directory, 'projects.sqlite3')
    : ':memory:';
  const config = gatewayConfig(directory);
  const gatewayOptions = {
    ...(options.heartbeatIntervalMs == null
      ? {}
      : { webSocketHeartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.heartbeatTimeoutMs == null
      ? {}
      : { webSocketHeartbeatTimeoutMs: options.heartbeatTimeoutMs }),
  };
  const fixture = {
    directory,
    projectId,
    canvasId,
    databaseFilename,
    config,
    gatewayOptions,
    database: null,
    gateway: null,
    status: null,
    baseUrl: null,
    sockets: new Set(),
    cleaned: false,
  };

  const openDatabaseAndGateway = async (initialize) => {
    fixture.database = new ProjectDatabase(databaseFilename, { autoBackup: false });
    if (initialize) {
      fixture.database.ensureCanvas(
        canvasId,
        clone(options.snapshot || defaultCanvasSnapshot()),
        projectId,
      );
    }
    fixture.gateway = new CollaborationGateway(config, fixture.database, gatewayOptions);
    fixture.status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
    fixture.baseUrl = `http://127.0.0.1:${fixture.status.port}`;
  };

  fixture.restart = async (restartOptions = {}) => {
    if (databaseFilename === ':memory:') throw new Error('Only persistent F2 fixtures can restart');
    for (const probe of fixture.sockets) await closeSocket(probe.socket);
    fixture.sockets.clear();
    await fixture.gateway.stop();
    fixture.database.close();
    await restartOptions.beforeOpen?.(fixture);
    await openDatabaseAndGateway(false);
    return fixture;
  };

  fixture.cleanup = async () => {
    if (fixture.cleaned) return;
    fixture.cleaned = true;
    for (const probe of fixture.sockets) {
      try { await closeSocket(probe.socket); } catch (_) { /* best effort */ }
    }
    fixture.sockets.clear();
    try { await fixture.gateway?.stop(); } catch (_) { /* best effort */ }
    try { fixture.database?.close(); } catch (_) { /* best effort */ }
    fs.rmSync(directory, { recursive: true, force: true });
  };

  await openDatabaseAndGateway(true);
  t.after(() => fixture.cleanup());
  return fixture;
}

async function requestJson(url, options = {}) {
  const requestOptions = { ...options };
  const pathname = new URL(String(url)).pathname;
  if (pathname === '/api/collaboration' || pathname.startsWith('/api/collaboration/')) {
    const headers = new Headers(options.headers || {});
    headers.set(MANAGEMENT_AUTHORITY_HEADER, TEST_MANAGEMENT_AUTHORITY.token);
    requestOptions.headers = headers;
  }
  const response = await fetch(url, requestOptions);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`Expected JSON from ${url}, received: ${text.slice(0, 500)}`, { cause: error });
    }
  }
  return { response, payload, text };
}

async function redeemActor(fixture, role, displayName) {
  const invite = fixture.gateway.auth.createInvite({
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    role,
    maxUses: 1,
  });
  const redeemed = await requestJson(`${fixture.baseUrl}/api/collab/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, displayName }),
  });
  assert.equal(redeemed.response.status, 200, JSON.stringify(redeemed.payload));
  const setCookie = redeemed.response.headers.get('set-cookie');
  assert.ok(setCookie, 'invite redemption did not set a collaboration cookie');
  const cookie = setCookie.split(';')[0];
  const current = await requestJson(`${fixture.baseUrl}/api/collab/session`, {
    headers: { cookie },
  });
  assert.equal(current.response.status, 200, JSON.stringify(current.payload));
  return {
    ...redeemed.payload.data,
    ...current.payload.data,
    cookie,
    recoveryGeneration: fixture.database.getRecoveryGeneration(),
  };
}

function createSocketProbe(socket, label) {
  const messages = [];
  const waiters = new Set();
  const observers = new Set();
  let closeRecord = null;

  const dispatch = (message) => {
    for (const observer of [...observers]) observer(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    messages.push(message);
  };

  socket.on('message', (raw) => {
    try {
      dispatch(JSON.parse(String(raw)));
    } catch (error) {
      dispatch({ type: '__invalid_json__', error: error.message, raw: String(raw) });
    }
  });

  const opened = withTimeout(new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    socket.once('open', resolve);
    socket.once('error', reject);
  }), 3_000, `${label} did not open`);

  const closed = new Promise((resolve) => {
    socket.once('close', (code, reason) => {
      closeRecord = { code, reason: String(reason) };
      resolve(closeRecord);
    });
  });

  return {
    socket,
    messages,
    opened,
    get closeRecord() { return closeRecord; },
    send(value) {
      socket.send(typeof value === 'string' ? value : JSON.stringify(value));
    },
    nextMessage(predicate, message, timeoutMs = 3_000) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(message));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    expectNoMessage(predicate, durationMs, message) {
      const existing = messages.find(predicate);
      if (existing) return Promise.reject(new Error(`${message}: ${JSON.stringify(existing)}`));
      return new Promise((resolve, reject) => {
        const observer = (candidate) => {
          if (!predicate(candidate)) return;
          observers.delete(observer);
          clearTimeout(timer);
          reject(new Error(`${message}: ${JSON.stringify(candidate)}`));
        };
        const timer = setTimeout(() => {
          observers.delete(observer);
          resolve();
        }, durationMs);
        observers.add(observer);
      });
    },
    waitForClose(timeoutMs = 3_000, message = `${label} did not close`) {
      if (closeRecord) return Promise.resolve(closeRecord);
      return withTimeout(closed, timeoutMs, message);
    },
  };
}

async function openSocketProbe(fixture, actor, options = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${fixture.status.port}/ws/collab`, {
    autoPong: options.autoPong !== false,
    origin: fixture.baseUrl,
    headers: { cookie: actor.cookie },
  });
  const probe = createSocketProbe(socket, options.label || actor.displayName || 'F2 socket');
  fixture.sockets.add(probe);
  await probe.opened;
  return probe;
}

async function joinSocket(probe, canvasId, afterRevision, options = {}) {
  const ready = await probe.nextMessage(
    (message) => message.type === 'session.ready',
    'session.ready timed out',
  );
  const join = { type: 'canvas.join', canvasId };
  if (options.omitAfterRevision !== true) join.afterRevision = afterRevision;
  if (options.generation) join.generation = options.generation;
  probe.send(join);
  const joined = await probe.nextMessage(
    (message) => message.type === 'canvas.joined',
    'canvas.joined timed out',
  );
  const presence = await probe.nextMessage(
    (message) => message.type === 'presence.snapshot',
    'presence.snapshot timed out',
  );
  return { ready, joined, presence };
}

async function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
    return;
  }
  const closed = new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { socket.terminate(); } catch (_) { /* already closed */ }
      resolve();
    }, 1_000);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'test complete');
  await closed;
}

function moveRequest(baseRevision, input) {
  return JSON.stringify({
    baseRevision,
    operations: [{
      opId: input.opId,
      clientSeq: input.clientSeq,
      timestamp: input.timestamp || Date.now(),
      type: 'node.move',
      payload: {
        nodeId: input.nodeId,
        position: clone(input.position),
      },
    }],
  });
}

async function postOperation(
  fixture,
  actor,
  serializedBody,
  canvasId = fixture.canvasId,
  options = {},
) {
  const headers = { cookie: actor.cookie, 'content-type': 'application/json' };
  const generation = Object.hasOwn(options, 'generation')
    ? options.generation
    : actor.recoveryGeneration;
  if (generation != null) headers['x-t8-canvas-generation'] = generation;
  return requestJson(`${fixture.baseUrl}/api/collab/canvases/${encodeURIComponent(canvasId)}/operations`, {
    method: 'POST',
    headers,
    body: serializedBody,
  });
}

async function getCanvas(fixture, actor) {
  const result = await requestJson(
    `${fixture.baseUrl}/api/collab/canvases/${encodeURIComponent(fixture.canvasId)}`,
    { headers: { cookie: actor.cookie } },
  );
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return result.payload.data;
}

async function getSync(fixture, actor, afterRevision, generation = null) {
  const generationQuery = generation ? `&generation=${encodeURIComponent(generation)}` : '';
  return requestJson(
    `${fixture.baseUrl}/api/collab/canvases/${encodeURIComponent(fixture.canvasId)}/sync?afterRevision=${encodeURIComponent(String(afterRevision))}${generationQuery}`,
    { headers: { cookie: actor.cookie } },
  );
}

function reconstructFromSync(baseDocument, sync) {
  if (sync.mode === 'snapshot') return sync.document;
  let document = clone(baseDocument);
  for (const operation of sync.operations) {
    assert.equal(operation.revision, document.revision + 1);
    const applied = applyCanvasOperation(document, operation);
    document = normalizeCanvasDocument(document.canvasId, applied.document, {
      projectId: document.projectId,
      revision: operation.revision,
      updatedAt: operation.timestamp,
    });
  }
  assert.equal(document.revision, sync.revision);
  return document;
}

function operationCounts(database, opId) {
  const operationRow = database.db.prepare(
    'SELECT project_id FROM canvas_operations WHERE op_id = ?',
  ).get(opId);
  const operation = database.db.prepare(
    'SELECT COUNT(*) AS count FROM canvas_operations WHERE op_id = ?',
  ).get(opId).count;
  const idempotencyRow = database.db.prepare(
    'SELECT project_id FROM canvas_operation_idempotency WHERE op_id = ?',
  ).get(opId);
  const idempotency = database.db.prepare(
    'SELECT COUNT(*) AS count FROM canvas_operation_idempotency WHERE op_id = ?',
  ).get(opId).count;
  const projectId = operationRow?.project_id || idempotencyRow?.project_id;
  const audits = projectId
    ? database.listAuditEvents({ projectId, limit: 1000 })
      .filter((event) => event.metadata?.opId === opId).length
    : 0;
  return { operation, idempotency, audits };
}

module.exports = {
  DEFAULT_CANVAS_ID,
  DEFAULT_PROJECT_ID,
  MANAGEMENT_AUTHORITY_HEADER,
  TEST_MANAGEMENT_AUTHORITY,
  WebSocket,
  clone,
  closeSocket,
  createFixture,
  eventually,
  getCanvas,
  getSync,
  joinSocket,
  moveRequest,
  openSocketProbe,
  operationCounts,
  postOperation,
  reconstructFromSync,
  redeemActor,
  requestJson,
  withTimeout,
};
