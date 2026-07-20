'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');
const {
  createFixture,
  openSocketProbe,
  redeemActor,
  requestJson,
} = require('./helpers/collaborationF2Fixture.cjs');

function heartbeatIdentity(actor) {
  return {
    sessionId: actor.id,
    projectId: actor.projectId,
    canvasId: actor.canvasId,
    memberId: actor.memberId,
    authorizationEpoch: actor.authorizationEpoch,
  };
}

async function heartbeatRequest(fixture, actor, body = heartbeatIdentity(actor), options = {}) {
  const headers = {
    cookie: actor.cookie,
    'content-type': 'application/json',
    ...(options.headers || {}),
  };
  return requestJson(`${fixture.baseUrl}/api/collab/session/heartbeat`, {
    method: options.method || 'POST',
    headers,
    body: options.body === undefined ? JSON.stringify(body) : options.body,
  });
}

test('B2 default HTTP and WebSocket authentication are pure reads while explicit heartbeat is rate-bounded durable state', async (t) => {
  const fixture = await createFixture(t);
  const actor = await redeemActor(fixture, 'editor', 'Heartbeat pure auth actor');
  const boundaryCalls = [];
  const originalBoundary = fixture.database.withProjectDatabaseWrite.bind(fixture.database);
  fixture.database.withProjectDatabaseWrite = (operation, callback) => {
    boundaryCalls.push(operation);
    return originalBoundary(operation, callback);
  };

  const beforeChanges = fixture.database.db.totalChanges;
  fixture.database.db.pragma('query_only = ON');
  try {
    const current = await requestJson(`${fixture.baseUrl}/api/collab/session`, {
      headers: { cookie: actor.cookie },
    });
    assert.equal(current.response.status, 200, current.text);
    assert.equal(current.payload.data.id, actor.id);
    assert.equal(current.response.headers.get('cache-control'), null);

    const probe = await openSocketProbe(fixture, actor, { label: 'heartbeat pure websocket' });
    const ready = await probe.nextMessage(
      (message) => message.type === 'session.ready',
      'pure authentication session.ready timed out',
    );
    assert.equal(ready.session.id, actor.id);
    probe.socket.close(1000, 'pure auth verified');
    await probe.waitForClose();
  } finally {
    fixture.database.db.pragma('query_only = OFF');
  }
  assert.equal(fixture.database.db.totalChanges, beforeChanges);
  assert.deepEqual(boundaryCalls, []);

  fixture.database.db.prepare('UPDATE collaboration_sessions SET last_seen_at = 1 WHERE id = ?')
    .run(actor.id);
  const heartbeat = await heartbeatRequest(fixture, actor);
  assert.equal(heartbeat.response.status, 200, heartbeat.text);
  assert.equal(heartbeat.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(heartbeat.payload.data), ['touched', 'lastSeenAt', 'nextHeartbeatAt']);
  assert.equal(heartbeat.payload.data.touched, true);
  assert.ok(Number.isSafeInteger(heartbeat.payload.data.lastSeenAt));
  assert.equal(
    heartbeat.payload.data.nextHeartbeatAt - heartbeat.payload.data.lastSeenAt,
    30_000,
  );
  assert.deepEqual(boundaryCalls, ['collaboration.session.heartbeat']);

  const noOp = await heartbeatRequest(fixture, actor);
  assert.equal(noOp.response.status, 200, noOp.text);
  assert.equal(noOp.payload.data.touched, false);
  assert.equal(noOp.payload.data.lastSeenAt, heartbeat.payload.data.lastSeenAt);
  assert.deepEqual(boundaryCalls, ['collaboration.session.heartbeat']);
});

test('B2 heartbeat HTTP boundary is exact POST JSON, no-store, origin-safe, and strict five-field identity', async (t) => {
  const fixture = await createFixture(t);
  const actor = await redeemActor(fixture, 'editor', 'Heartbeat boundary actor');
  const url = `${fixture.baseUrl}/api/collab/session/heartbeat`;

  const method = await fetch(url, { method: 'GET' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST');
  assert.equal(method.headers.get('cache-control'), 'no-store');

  const allowedOriginMethod = await fetch(url, {
    method: 'GET',
    headers: { origin: fixture.baseUrl },
  });
  assert.equal(allowedOriginMethod.status, 405);
  assert.equal(allowedOriginMethod.headers.get('access-control-allow-origin'), fixture.baseUrl);

  const hostileOriginMethod = await fetch(url, {
    method: 'GET',
    headers: { origin: 'https://hostile.example' },
  });
  assert.equal(hostileOriginMethod.status, 403);
  assert.equal(hostileOriginMethod.headers.get('cache-control'), 'no-store');

  const preflight = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      origin: fixture.baseUrl,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type');
  assert.equal(preflight.headers.get('cache-control'), 'no-store');

  const generationHeaderPreflight = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      origin: fixture.baseUrl,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, x-t8-canvas-generation',
    },
  });
  assert.equal(generationHeaderPreflight.status, 403);
  assert.equal(generationHeaderPreflight.headers.get('access-control-allow-headers'), null);
  assert.equal(generationHeaderPreflight.headers.get('cache-control'), 'no-store');

  const wrongType = await fetch(url, {
    method: 'POST',
    headers: { cookie: actor.cookie, 'content-type': 'text/plain' },
    body: JSON.stringify(heartbeatIdentity(actor)),
  });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.headers.get('cache-control'), 'no-store');

  const utf8Type = await heartbeatRequest(fixture, actor, heartbeatIdentity(actor), {
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
  assert.equal(utf8Type.response.status, 200, utf8Type.text);

  const unsupportedCharset = await heartbeatRequest(fixture, actor, heartbeatIdentity(actor), {
    headers: { 'content-type': 'application/json; charset=iso-8859-1' },
  });
  assert.equal(unsupportedCharset.response.status, 415, unsupportedCharset.text);
  assert.equal(
    unsupportedCharset.payload.code,
    'collaboration_session_heartbeat_content_type_unsupported',
  );
  assert.equal(unsupportedCharset.response.headers.get('cache-control'), 'no-store');

  const compressed = await fetch(url, {
    method: 'POST',
    headers: {
      cookie: actor.cookie,
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    },
    body: JSON.stringify(heartbeatIdentity(actor)),
  });
  assert.equal(compressed.status, 415);

  const malformedJson = await heartbeatRequest(fixture, actor, null, { body: '{' });
  assert.equal(malformedJson.response.status, 400, malformedJson.text);
  assert.equal(malformedJson.payload.code, 'collaboration_session_heartbeat_invalid');

  const tooLarge = await heartbeatRequest(fixture, actor, null, {
    body: JSON.stringify({ padding: 'x'.repeat(5_000) }),
  });
  assert.equal(tooLarge.response.status, 413, tooLarge.text);
  assert.equal(tooLarge.payload.code, 'collaboration_session_heartbeat_too_large');

  for (const invalid of [
    { ...heartbeatIdentity(actor), extra: true },
    { ...heartbeatIdentity(actor), memberId: undefined },
    { ...heartbeatIdentity(actor), projectId: ` ${actor.projectId}` },
    { ...heartbeatIdentity(actor), authorizationEpoch: String(actor.authorizationEpoch) },
  ]) {
    const response = await heartbeatRequest(fixture, actor, invalid);
    assert.equal(response.response.status, 400, response.text);
    assert.equal(response.payload.code, 'collaboration_session_heartbeat_invalid');
    assert.equal(response.response.headers.get('cache-control'), 'no-store');
  }

  const conflict = await heartbeatRequest(fixture, actor, {
    ...heartbeatIdentity(actor),
    sessionId: `${actor.id}-stale`,
  });
  assert.equal(conflict.response.status, 409, conflict.text);
  assert.equal(conflict.payload.code, 'collaboration_session_heartbeat_conflict');

  const crossSite = await fetch(url, {
    method: 'POST',
    headers: {
      cookie: actor.cookie,
      'content-type': 'application/json',
      'sec-fetch-site': 'cross-site',
    },
    body: JSON.stringify(heartbeatIdentity(actor)),
  });
  const crossSiteText = await crossSite.text();
  assert.equal(crossSite.status, 403, crossSiteText);
  assert.equal(JSON.parse(crossSiteText).code, 'collaboration_session_heartbeat_cross_site_forbidden');
  assert.equal(crossSite.headers.get('cache-control'), 'no-store');
});

test('B2 heartbeat maps revoke races, BUSY, and storage capacity without leaking private state', async (t) => {
  const fixture = await createFixture(t);
  const actor = await redeemActor(fixture, 'editor', 'Heartbeat failure actor');
  const originalHeartbeat = fixture.gateway.auth.heartbeat.bind(fixture.gateway.auth);
  const originalAuthenticate = fixture.gateway.auth.authenticate.bind(fixture.gateway.auth);

  fixture.gateway.auth.authenticate = () => {
    throw Object.assign(new Error('SQLITE_BUSY private authentication statement'), { code: 'SQLITE_BUSY' });
  };
  const authenticationBusy = await heartbeatRequest(fixture, actor);
  assert.equal(authenticationBusy.response.status, 503, authenticationBusy.text);
  assert.equal(authenticationBusy.payload.code, 'collaboration_session_heartbeat_busy');
  assert.equal(authenticationBusy.payload.retryable, true);
  assert.equal(authenticationBusy.response.headers.get('retry-after'), '1');
  assert.equal(authenticationBusy.response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(authenticationBusy.text, /private authentication|SQLITE_BUSY/i);
  fixture.gateway.auth.authenticate = originalAuthenticate;

  fixture.gateway.auth.heartbeat = () => null;
  const revoked = await heartbeatRequest(fixture, actor);
  assert.equal(revoked.response.status, 401, revoked.text);
  assert.equal(revoked.payload.code, 'collaboration_session_heartbeat_unauthorized');
  assert.equal(revoked.response.headers.get('cache-control'), 'no-store');

  fixture.gateway.auth.heartbeat = () => {
    throw Object.assign(new Error('SQLITE_BUSY private statement'), { code: 'SQLITE_BUSY' });
  };
  const busy = await heartbeatRequest(fixture, actor);
  assert.equal(busy.response.status, 503, busy.text);
  assert.equal(busy.payload.code, 'collaboration_session_heartbeat_busy');
  assert.equal(busy.payload.retryable, true);
  assert.equal(busy.response.headers.get('retry-after'), '1');
  assert.doesNotMatch(busy.text, /private statement|SQLITE_BUSY/i);

  fixture.gateway.auth.heartbeat = () => {
    const error = new ProjectDatabaseStorageCapacityError('sqlite-full', {
      operation: 'C:\\private\\session-heartbeat.sqlite3',
    });
    error.message = 'SQLITE_FULL C:\\private\\session-heartbeat.sqlite3 token=never-expose';
    throw error;
  };
  const capacity = await heartbeatRequest(fixture, actor);
  assert.equal(capacity.response.status, 507, capacity.text);
  assert.equal(capacity.payload.code, 'project_database_storage_capacity_exceeded');
  assert.equal(capacity.payload.reason, 'sqlite-full');
  assert.equal(capacity.payload.retryable, false);
  assert.doesNotMatch(capacity.text, /C:\\private|session-heartbeat\.sqlite3|never-expose/i);
  assert.equal(capacity.response.headers.get('cache-control'), 'no-store');

  fixture.gateway.auth.heartbeat = originalHeartbeat;
});

test('B2 established WebSocket refresh failures close only the exact socket with a safe retry signal', async (t) => {
  const fixture = await createFixture(t);
  const scopeActor = await redeemActor(fixture, 'editor', 'Heartbeat scope refresh actor');
  const unaffectedActor = await redeemActor(fixture, 'editor', 'Heartbeat unaffected refresh actor');
  const scopeProbe = await openSocketProbe(fixture, scopeActor, { label: 'heartbeat scope refresh failure socket' });
  const unaffectedProbe = await openSocketProbe(fixture, unaffectedActor, { label: 'heartbeat unaffected socket' });
  await scopeProbe.nextMessage(
    (message) => message.type === 'session.ready',
    'scope actor session.ready timed out before refresh failure injection',
  );
  await unaffectedProbe.nextMessage(
    (message) => message.type === 'session.ready',
    'unaffected actor session.ready timed out before refresh failure injection',
  );

  const assertSafeRefreshClose = async (probe, nonce) => {
    const noticePromise = probe.nextMessage(
      (message) => message.type === 'session.refresh-unavailable',
      'refresh failure did not emit a safe retry notice',
    );
    const closePromise = probe.waitForClose(3_000, 'refresh failure did not close the socket');
    probe.send({ type: 'ping', nonce });
    const [notice, closed] = await Promise.all([noticePromise, closePromise]);
    assert.equal(notice.reason, 'session refresh temporarily unavailable');
    assert.deepEqual(closed, {
      code: 1013,
      reason: 'session refresh temporarily unavailable',
    });
    assert.doesNotMatch(JSON.stringify(notice), /SQLITE_BUSY|private|never-expose/i);
  };
  const assertUnaffectedPong = async (nonce) => {
    const pongPromise = unaffectedProbe.nextMessage(
      (message) => message.type === 'pong' && message.nonce === nonce,
      'unaffected socket did not remain online',
    );
    unaffectedProbe.send({ type: 'ping', nonce });
    await pongPromise;
  };

  const originalCanvasResourceScope = fixture.gateway.canvasResourceScope.bind(fixture.gateway);
  fixture.gateway.canvasResourceScope = (session) => {
    if (session?.id === scopeActor.id) {
      throw Object.assign(new Error('SQLITE_BUSY C:\\private\\scope.sqlite3 token=never-expose'), {
        code: 'SQLITE_BUSY',
      });
    }
    return originalCanvasResourceScope(session);
  };
  try {
    await assertSafeRefreshClose(scopeProbe, 'force-resource-scope-refresh');
    await assertUnaffectedPong('unaffected-after-scope-failure');
  } finally {
    fixture.gateway.canvasResourceScope = originalCanvasResourceScope;
  }

  const authenticateActor = await redeemActor(fixture, 'editor', 'Heartbeat authenticate refresh actor');
  const authenticateProbe = await openSocketProbe(fixture, authenticateActor, {
    label: 'heartbeat authenticate refresh failure socket',
  });
  await authenticateProbe.nextMessage(
    (message) => message.type === 'session.ready',
    'authenticate actor session.ready timed out before refresh failure injection',
  );

  const originalAuthenticate = fixture.gateway.auth.authenticate.bind(fixture.gateway.auth);
  const authenticateActorToken = decodeURIComponent(
    authenticateActor.cookie.slice(authenticateActor.cookie.indexOf('=') + 1),
  );
  fixture.gateway.auth.authenticate = (token) => {
    if (token === authenticateActorToken) {
      throw Object.assign(new Error('SQLITE_BUSY C:\\private\\refresh.sqlite3 token=never-expose'), {
        code: 'SQLITE_BUSY',
      });
    }
    return originalAuthenticate(token);
  };
  try {
    await assertSafeRefreshClose(authenticateProbe, 'force-authenticate-refresh');
    await assertUnaffectedPong('unaffected-after-authenticate-failure');
  } finally {
    fixture.gateway.auth.authenticate = originalAuthenticate;
  }

  assert.equal(fixture.gateway.server?.listening, true);
  const status = await requestJson(`${fixture.baseUrl}/api/collab/status`);
  assert.equal(status.response.status, 200, status.text);
  assert.equal(status.payload.data.running, true);
});

test('B2 heartbeat limiter is keyed by authenticated session and the thirteenth request is retryable 429', async (t) => {
  const fixture = await createFixture(t);
  const actor = await redeemActor(fixture, 'editor', 'Heartbeat limiter actor');
  const independentActor = await redeemActor(fixture, 'editor', 'Independent heartbeat limiter actor');
  for (let index = 0; index < 12; index += 1) {
    const allowed = await heartbeatRequest(fixture, actor);
    assert.equal(allowed.response.status, 200, `request ${index + 1}: ${allowed.text}`);
  }
  const limited = await heartbeatRequest(fixture, actor);
  assert.equal(limited.response.status, 429, limited.text);
  assert.equal(limited.payload.code, 'collaboration_session_heartbeat_rate_limited');
  assert.equal(limited.payload.retryable, true);
  assert.ok(Number(limited.response.headers.get('retry-after')) >= 1);
  assert.equal(limited.response.headers.get('cache-control'), 'no-store');

  const independent = await heartbeatRequest(fixture, independentActor);
  assert.equal(independent.response.status, 200, independent.text);
});

test('B2 ordinary collaboration preflight precisely allows the durable generation header', async (t) => {
  const fixture = await createFixture(t);
  const url = `${fixture.baseUrl}/api/collab/canvases/${fixture.canvasId}/operations`;
  const preflight = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      origin: fixture.baseUrl,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'X-T8-Canvas-Generation, Content-Type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get('access-control-allow-headers'),
    'Content-Type, X-T8-Canvas-Generation',
  );
  assert.match(preflight.headers.get('access-control-allow-methods') || '', /\bPOST\b/);
  assert.equal(preflight.headers.get('access-control-allow-origin'), fixture.baseUrl);

  const generationOnly = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      origin: fixture.baseUrl,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'x-t8-canvas-generation',
    },
  });
  assert.equal(generationOnly.status, 204);
  assert.equal(
    generationOnly.headers.get('access-control-allow-headers'),
    'X-T8-Canvas-Generation',
  );

  const unknown = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      origin: fixture.baseUrl,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, authorization',
    },
  });
  assert.equal(unknown.status, 403);
  assert.equal(unknown.headers.get('access-control-allow-headers'), null);
});
