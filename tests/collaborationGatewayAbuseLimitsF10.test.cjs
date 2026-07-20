const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { WebSocket } = require('ws');

const {
  CollaborationGateway,
  SESSION_COOKIE,
} = require('../backend/src/collaboration/gateway');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'project-f10';
const CANVAS_ID = 'canvas-f10';
const MiB = 1024 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createFixture(options = {}, configOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-collab-f10-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  const thumbnails = path.join(root, 'thumbnails');
  const previews = path.join(thumbnails, 'asset-previews');
  const blobDir = path.join(root, 'asset-blobs');
  const uploadTemp = path.join(root, 'upload-parts');
  for (const directory of [input, output, thumbnails, previews, blobDir, uploadTemp]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const database = new ProjectDatabase(':memory:');
  database.ensureCanvas(CANVAS_ID, {
    projectId: PROJECT_ID,
    name: 'F10 abuse-limit fixture',
    nodes: [],
    edges: [],
  }, PROJECT_ID);
  database.initializeCanvasResourceGrantsForSharing(PROJECT_ID, CANVAS_ID, {
    actorId: 'local-owner',
    sessionId: 'f10-fixture',
  });
  const config = {
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    COLLAB_ALLOWED_ORIGINS: [],
    COLLAB_PROJECT_QUOTA_BYTES: 64 * MiB,
    COLLAB_MEMBER_QUOTA_BYTES: 32 * MiB,
    COLLAB_UPLOAD_CHUNK_BYTES: MiB,
    COLLAB_MAX_UPLOAD_BYTES: 32 * MiB,
    COLLAB_UPLOAD_SESSION_TTL_MS: 60 * 60 * 1000,
    INPUT_DIR: input,
    OUTPUT_DIR: output,
    THUMBNAILS_DIR: thumbnails,
    ASSET_PREVIEWS_DIR: previews,
    ASSET_BLOB_DIR: blobDir,
    COLLAB_UPLOAD_TEMP_DIR: uploadTemp,
    FRONTEND_DIST: '',
    ...configOverrides,
  };
  return {
    root,
    input,
    output,
    thumbnails,
    previews,
    blobDir,
    uploadTemp,
    database,
    gateway: new CollaborationGateway(config, database, options),
    baseUrl: '',
  };
}

async function startFixture(fixture) {
  const status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  fixture.baseUrl = `http://127.0.0.1:${status.port}`;
  return status;
}

async function disposeFixture(fixture, sockets = []) {
  for (const socket of sockets) {
    if (!socket || socket.readyState === WebSocket.CLOSED) continue;
    try { socket.terminate(); } catch (_) { /* already closed */ }
  }
  try { await fixture.gateway.stop(); } catch (_) {}
  try { await fixture.database.close(); } catch (_) {}
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function createActor(fixture, role, displayName) {
  const invite = fixture.gateway.auth.createInvite({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    role,
    maxUses: 1,
  });
  const actor = fixture.gateway.auth.redeemInvite(invite.code, displayName);
  assert.ok(actor);
  return {
    ...actor,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(actor.token)}`,
  };
}

async function responseBody(response) {
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_) {}
  return { response, text, payload };
}

async function uploadPolicy(fixture, actor) {
  return responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/uploads/policy`, {
    headers: { cookie: actor.cookie },
  }));
}

async function putUnknownChunk(fixture, actor, body) {
  return responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/uploads/not-a-session/chunks/0`, {
    method: 'PUT',
    headers: {
      cookie: actor.cookie,
      'content-type': 'application/octet-stream',
      'content-range': `bytes 0-${body.length - 1}/${body.length}`,
      'x-chunk-sha256': sha256(body),
    },
    body,
  }));
}

function installOriginalAsset(fixture, bytes) {
  const digest = sha256(bytes);
  const filename = path.join(fixture.blobDir, digest.slice(0, 2), digest);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
  const asset = fixture.database.upsertAsset({
    id: 'asset-f10-download',
    projectId: PROJECT_ID,
    contentHash: digest,
    contentHashVerification: 'verified',
    kind: 'other',
    mimeType: 'application/octet-stream',
    filename: 'f10-download.bin',
    managedPath: filename,
    sourceUrl: '/api/collab/assets/asset-f10-download/media',
    storageMode: 'managed',
    availability: 'available',
    metadata: { size: bytes.length },
    createdBy: 'local-owner',
  });
  fixture.database.recordAssetLineageEvent({
    assetId: asset.id,
    canvasId: CANVAS_ID,
    sourceType: 'test-fixture',
    creatorId: 'local-owner',
  });
  fixture.database.db.prepare(`
    UPDATE asset_blobs
    SET storage_key = ?, storage_state = 'ready', verified_at = ?
    WHERE content_hash = ?
  `).run(path.relative(fixture.blobDir, filename).replace(/\\/g, '/'), Date.now(), digest);
  fixture.database.setAssetAccessPolicy(PROJECT_ID, asset.id, {
    scope: 'restricted',
    grants: [
      { principalType: 'role', principalId: 'reviewer', permissions: ['view', 'preview', 'original'] },
    ],
  }, { actorId: 'local-owner' });
  return asset;
}

function connectWebSocket(port, actor) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/collab`, {
    origin: `http://127.0.0.1:${port}`,
    headers: { cookie: actor.cookie },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('F10 WebSocket connection timed out')), 3_000);
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== 'session.ready') return;
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

function waitForMessage(socket, type, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`F10 WebSocket ${type} timed out`)), timeoutMs);
    const listener = (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off('message', listener);
      resolve(message);
    };
    socket.on('message', listener);
  });
}

function waitForClose(socket, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('F10 WebSocket close timed out')), timeoutMs);
    socket.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reason) });
    });
  });
}

test('F10 trusted-proxy invite budgets are per client IP and return a stable 429 contract', async (t) => {
  const fixture = createFixture({
    trustedProxyAddresses: ['127.0.0.1'],
    inviteRedeemsPerMinutePerIp: 1,
    inviteRedeemsPerMinutePerCode: 100,
  });
  t.after(() => disposeFixture(fixture));
  await startFixture(fixture);

  const redeem = async (ip, code) => responseBody(await fetch(
    `${fixture.baseUrl}/api/collab/invites/redeem`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ code, displayName: 'F10 invite probe' }),
    },
  ));
  assert.equal((await redeem('198.51.100.10', 'invalid-a')).response.status, 400);
  assert.equal((await redeem('198.51.100.11', 'invalid-b')).response.status, 400);
  const limited = await redeem('198.51.100.10', 'invalid-c');
  assert.equal(limited.response.status, 429, limited.text);
  assert.equal(limited.payload.code, 'collaboration_invite_redeem_rate_limited');
  assert.equal(limited.payload.limitDimension, 'ip');
  assert.equal(limited.payload.retryable, true);
  assert.ok(Number(limited.response.headers.get('retry-after')) >= 1);
});

test('F10 upload request tiers share the IP budget, isolate sessions, and roll back rejected tiers', async (t) => {
  const fixture = createFixture({
    uploadRequestsPerMinutePerIp: 3,
    uploadRequestsPerMinutePerSession: 1,
  });
  t.after(() => disposeFixture(fixture));
  await startFixture(fixture);
  const actorA = createActor(fixture, 'editor', 'F10 request A');
  const actorB = createActor(fixture, 'editor', 'F10 request B');
  const actorC = createActor(fixture, 'editor', 'F10 request C');
  const actorD = createActor(fixture, 'editor', 'F10 request D');

  assert.equal((await uploadPolicy(fixture, actorA)).response.status, 200);
  const sessionLimited = await uploadPolicy(fixture, actorA);
  assert.equal(sessionLimited.response.status, 429, sessionLimited.text);
  assert.equal(sessionLimited.payload.code, 'collaboration_upload_request_rate_limited');
  assert.equal(sessionLimited.payload.limitDimension, 'session');
  assert.equal((await uploadPolicy(fixture, actorB)).response.status, 200);
  assert.equal((await uploadPolicy(fixture, actorC)).response.status, 200);
  const ipLimited = await uploadPolicy(fixture, actorD);
  assert.equal(ipLimited.response.status, 429, ipLimited.text);
  assert.equal(ipLimited.payload.code, 'collaboration_upload_request_rate_limited');
  assert.equal(ipLimited.payload.limitDimension, 'ip');
});

test('F10 upload byte tiers charge parsed chunks per IP and session without weakening request limits', async (t) => {
  const fixture = createFixture({
    uploadRequestsPerMinutePerIp: 100,
    uploadRequestsPerMinutePerSession: 100,
    uploadBytesPerMinutePerIp: 6,
    uploadBytesPerMinutePerSession: 4,
  });
  t.after(() => disposeFixture(fixture));
  await startFixture(fixture);
  const actorA = createActor(fixture, 'editor', 'F10 bytes A');
  const actorB = createActor(fixture, 'editor', 'F10 bytes B');
  const actorC = createActor(fixture, 'editor', 'F10 bytes C');
  const threeBytes = Buffer.from('abc');

  assert.notEqual((await putUnknownChunk(fixture, actorA, threeBytes)).response.status, 429);
  const sessionLimited = await putUnknownChunk(fixture, actorA, threeBytes);
  assert.equal(sessionLimited.response.status, 429, sessionLimited.text);
  assert.equal(sessionLimited.payload.code, 'collaboration_upload_bytes_rate_limited');
  assert.equal(sessionLimited.payload.limitDimension, 'session');
  assert.notEqual((await putUnknownChunk(fixture, actorB, threeBytes)).response.status, 429);
  const ipLimited = await putUnknownChunk(fixture, actorC, Buffer.from('z'));
  assert.equal(ipLimited.response.status, 429, ipLimited.text);
  assert.equal(ipLimited.payload.code, 'collaboration_upload_bytes_rate_limited');
  assert.equal(ipLimited.payload.limitDimension, 'ip');
});

test('F10 HEAD consumes only the download request budget while Range bytes use the shared slow-stream throttle', async (t) => {
  let now = 0;
  const scheduled = [];
  const fixture = createFixture({
    rateLimitNow: () => now,
    downloadRequestsPerMinutePerIp: 100,
    downloadRequestsPerMinutePerSession: 100,
    downloadBytesPerSecondPerIp: 4,
    downloadBytesPerSecondPerSession: 4,
    bandwidthThrottleSchedule(callback, delay) {
      scheduled.push(delay);
      return setImmediate(() => {
        now += delay;
        callback();
      });
    },
    bandwidthThrottleCancel(timer) { clearImmediate(timer); },
  });
  t.after(() => disposeFixture(fixture));
  const bytes = Buffer.from('0123456789');
  const asset = installOriginalAsset(fixture, bytes);
  await startFixture(fixture);
  const reviewer = createActor(fixture, 'reviewer', 'F10 download reviewer');
  const url = `${fixture.baseUrl}/api/collab/assets/${asset.id}/media?download=1`;

  const head = await responseBody(await fetch(url, {
    method: 'HEAD',
    headers: { cookie: reviewer.cookie, range: 'bytes=0-5' },
  }));
  assert.equal(head.response.status, 206, head.text);
  assert.equal(head.response.headers.get('content-length'), '6');
  assert.equal(head.text, '');
  assert.deepEqual(scheduled, [], 'HEAD must not consume the byte budget');

  const range = await responseBody(await fetch(url, {
    headers: { cookie: reviewer.cookie, range: 'bytes=0-5' },
  }));
  assert.equal(range.response.status, 206, range.text);
  assert.equal(range.response.headers.get('content-range'), `bytes 0-5/${bytes.length}`);
  assert.equal(range.text, '012345');
  assert.deepEqual(scheduled, [1_000]);
});

test('F10 WebSocket message-class tiers share IP capacity and close predictably on session excess', async (t) => {
  const fixture = createFixture({
    webSocketMessagesPerWindow: 100,
    webSocketMessageLimits: {
      presence: { ip: 3, session: 1 },
      heartbeat: { ip: 100, session: 100 },
      join: { ip: 100, session: 100 },
      unknown: { ip: 100, session: 2 },
    },
  });
  const sockets = [];
  t.after(() => disposeFixture(fixture, sockets));
  const status = await startFixture(fixture);
  const actorA = createActor(fixture, 'editor', 'F10 socket A');
  const actorB = createActor(fixture, 'editor', 'F10 socket B');
  const actorC = createActor(fixture, 'editor', 'F10 socket C');
  const actorD = createActor(fixture, 'editor', 'F10 socket D');

  const directState = (id) => ({ clientIp: '203.0.113.90', session: { id } });
  assert.equal(fixture.gateway.webSocketMessageRateLimit(directState('direct-a'), 'presence.update').allowed, true);
  const rejectedSession = fixture.gateway.webSocketMessageRateLimit(directState('direct-a'), 'presence.update');
  assert.equal(rejectedSession.allowed, false);
  assert.equal(rejectedSession.dimension, 'session');
  assert.equal(fixture.gateway.webSocketMessageRateLimit(directState('direct-b'), 'presence.update').allowed, true);
  assert.equal(fixture.gateway.webSocketMessageRateLimit(directState('direct-c'), 'presence.update').allowed, true);
  const rejectedIp = fixture.gateway.webSocketMessageRateLimit(directState('direct-d'), 'presence.update');
  assert.equal(rejectedIp.allowed, false);
  assert.equal(rejectedIp.dimension, 'ip');

  const socket = await connectWebSocket(status.port, actorA);
  sockets.push(socket);
  socket.send(JSON.stringify({ type: 'presence.update', presence: {} }));
  const pong = waitForMessage(socket, 'pong');
  socket.send(JSON.stringify({ type: 'ping', nonce: 'f10-class-isolation' }));
  assert.equal((await pong).nonce, 'f10-class-isolation');
  const notice = waitForMessage(socket, 'connection.rate-limited');
  const closed = waitForClose(socket);
  socket.send(JSON.stringify({ type: 'presence.update', presence: {} }));
  const rateNotice = await notice;
  assert.equal(rateNotice.code, 'collaboration_ws_message_rate_limited');
  assert.equal(rateNotice.messageClass, 'presence');
  assert.equal(rateNotice.limitDimension, 'session');
  assert.equal(rateNotice.retryable, true);
  assert.ok(rateNotice.retryAfterMs >= 1);
  assert.deepEqual(await closed, { code: 1013, reason: 'message rate exceeded' });

  const malformedSocket = await connectWebSocket(status.port, actorB);
  sockets.push(malformedSocket);
  const malformedNotice = waitForMessage(malformedSocket, 'connection.rate-limited');
  const malformedClosed = waitForClose(malformedSocket);
  malformedSocket.send('{invalid-json');
  malformedSocket.send('{still-invalid');
  malformedSocket.send('{limited-now');
  const unknownNotice = await malformedNotice;
  assert.equal(unknownNotice.messageClass, 'unknown');
  assert.equal(unknownNotice.limitDimension, 'session');
  assert.deepEqual(await malformedClosed, { code: 1013, reason: 'message rate exceeded' });
});

test('F10 environment configuration keeps conservative defaults and hard upper bounds', () => {
  const script = `
    const config = require('./backend/src/config.js');
    process.stdout.write(JSON.stringify({
      inviteIp: config.COLLAB_INVITE_REDEEMS_PER_MINUTE_PER_IP,
      uploadIpBytes: config.COLLAB_UPLOAD_BYTES_PER_MINUTE_PER_IP,
      downloadSessionBytes: config.COLLAB_DOWNLOAD_BYTES_PER_SECOND_PER_SESSION,
      wsWindow: config.COLLAB_WS_MESSAGE_WINDOW_MS,
      wsUnknownSession: config.COLLAB_WS_UNKNOWN_MESSAGES_PER_WINDOW_PER_SESSION,
    }));
  `;
  const run = (overrides) => {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '1',
        T8_COLLAB_MANAGEMENT_TOKEN: 'A'.repeat(43),
        ...overrides,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(run({
    T8_COLLAB_INVITE_REDEEMS_PER_MINUTE_PER_IP: '-1',
    T8_COLLAB_UPLOAD_BYTES_PER_MINUTE_PER_IP: '-1',
    T8_COLLAB_DOWNLOAD_BYTES_PER_SECOND_PER_SESSION: '-1',
    T8_COLLAB_WS_MESSAGE_WINDOW_MS: '-1',
    T8_COLLAB_WS_UNKNOWN_MESSAGES_PER_WINDOW_PER_SESSION: '-1',
  }), {
    inviteIp: 1,
    uploadIpBytes: MiB,
    downloadSessionBytes: 64 * 1024,
    wsWindow: 1_000,
    wsUnknownSession: 1,
  });
  assert.deepEqual(run({
    T8_COLLAB_INVITE_REDEEMS_PER_MINUTE_PER_IP: '999999999999',
    T8_COLLAB_UPLOAD_BYTES_PER_MINUTE_PER_IP: '999999999999',
    T8_COLLAB_DOWNLOAD_BYTES_PER_SECOND_PER_SESSION: '999999999999',
    T8_COLLAB_WS_MESSAGE_WINDOW_MS: '999999999999',
    T8_COLLAB_WS_UNKNOWN_MESSAGES_PER_WINDOW_PER_SESSION: '999999999999',
  }), {
    inviteIp: 1_000,
    uploadIpBytes: 64 * 1024 * 1024 * 1024,
    downloadSessionBytes: 2 * 1024 * 1024 * 1024,
    wsWindow: 60_000,
    wsUnknownSession: 1_000_000,
  });
});
