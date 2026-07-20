'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');

const {
  createFixture,
  getSync,
  joinSocket,
  moveRequest,
  openSocketProbe,
  postOperation,
  redeemActor,
  requestJson,
  withTimeout,
} = require('./helpers/collaborationF2Fixture.cjs');

const RECOVERY_GENERATION_UNAVAILABLE_CODE = 'project_database_recovery_generation_unavailable';
const RECOVERY_GENERATION_NOTICE_TYPE = 'canvas.generation-unavailable';
const RECOVERY_GENERATION_CLOSE_REASON = 'recovery generation temporarily unavailable';

function assertPublicRecoveryGenerationFailure(result, label) {
  assert.equal(result.response.status, 503, `${label}: ${result.text}`);
  assert.equal(result.response.headers.get('cache-control'), 'no-store', label);
  assert.equal(result.response.headers.get('retry-after'), '1', label);
  assert.equal(result.payload?.success, false, label);
  assert.equal(result.payload?.code, RECOVERY_GENERATION_UNAVAILABLE_CODE, label);
  assert.equal(result.payload?.retryable, true, label);
  assert.doesNotMatch(
    result.text,
    /EIO|runtime-fence|published-not-durable|sidecar|projects\.sqlite3|recovery-generation\.json/i,
    label,
  );
}

async function expectRecoveryGenerationSocketClose(probe, trigger, label) {
  const noticePromise = probe.nextMessage(
    (message) => message.type === RECOVERY_GENERATION_NOTICE_TYPE,
    `${label} did not receive a recovery-generation retry notice`,
  );
  const closePromise = probe.waitForClose(
    3_000,
    `${label} did not close after the recovery-generation failure`,
  );
  trigger();
  const [notice, closed] = await Promise.all([noticePromise, closePromise]);
  assert.equal(notice.reason, RECOVERY_GENERATION_CLOSE_REASON, label);
  assert.deepEqual(closed, {
    code: 1013,
    reason: RECOVERY_GENERATION_CLOSE_REASON,
  }, label);
  assert.doesNotMatch(
    `${JSON.stringify(notice)} ${closed.reason}`,
    /EIO|runtime-fence|published-not-durable|sidecar|projects\.sqlite3|recovery-generation\.json/i,
    label,
  );
}

function requestWebSocketUpgrade(fixture, actor) {
  const base = new URL(fixture.baseUrl);
  return withTimeout(new Promise((resolve, reject) => {
    const request = http.request({
      method: 'GET',
      hostname: base.hostname,
      port: Number(base.port),
      path: '/ws/collab',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Origin: fixture.baseUrl,
        Cookie: actor.cookie,
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    });
    request.once('upgrade', (_response, socket) => {
      socket.destroy();
      reject(new Error('recovery-generation-unavailable WebSocket upgrade unexpectedly succeeded'));
    });
    request.once('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.once('error', reject);
      response.resume();
    });
    request.once('error', reject);
    request.end();
  }), 3_000, 'recovery-generation-unavailable WebSocket upgrade did not settle');
}

test('B2 post-publish recovery-generation failure is safely fenced across collaboration HTTP and WebSocket runtime paths', async (t) => {
  const fixture = await createFixture(t, {
    persistent: true,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 120_000,
  });
  const pingActor = await redeemActor(fixture, 'editor', 'Generation failure ping actor');
  const joinActor = await redeemActor(fixture, 'editor', 'Generation failure join actor');
  const presenceActor = await redeemActor(fixture, 'editor', 'Generation failure presence actor');
  const upgradeActor = await redeemActor(fixture, 'editor', 'Generation failure upgrade actor');
  const generationBefore = fixture.database.getRecoveryGeneration();
  const documentBefore = fixture.database.getCanvas(fixture.canvasId);

  const pingProbe = await openSocketProbe(fixture, pingActor, { label: 'generation failure ping socket' });
  await joinSocket(pingProbe, fixture.canvasId, documentBefore.revision, {
    generation: generationBefore,
  });
  const presenceProbe = await openSocketProbe(fixture, presenceActor, {
    label: 'generation failure presence socket',
  });
  await joinSocket(presenceProbe, fixture.canvasId, documentBefore.revision, {
    generation: generationBefore,
  });
  const joinProbe = await openSocketProbe(fixture, joinActor, { label: 'generation failure join socket' });
  await joinProbe.nextMessage(
    (message) => message.type === 'session.ready',
    'generation failure join socket did not become ready',
  );

  let injected = false;
  fixture.database.options.projectDatabaseWriteAcknowledgementPersistenceOptions32 = {
    afterReplace: ({ value }) => {
      if (value.reason !== 'gateway-runtime-failure') return;
      injected = true;
      throw Object.assign(new Error('EIO C:\\private\\projects.sqlite3.recovery-generation.json'), {
        code: 'EIO',
      });
    },
  };
  try {
    assert.throws(
      () => fixture.database.rotateRecoveryGeneration('gateway-runtime-failure'),
      (error) => error?.code === RECOVERY_GENERATION_UNAVAILABLE_CODE
        && error?.status === 503
        && error?.details?.phase === 'schema32-rotation-committed-acknowledgement-failed'
        && error?.details?.committed === true
        && error?.details?.acknowledgementPublished === true
        && error?.details?.errorCode === 'EIO',
    );
  } finally {
    delete fixture.database.options.projectDatabaseWriteAcknowledgementPersistenceOptions32;
  }
  assert.equal(injected, true);
  assert.throws(
    () => fixture.database.getRecoveryGeneration(),
    (error) => error?.code === RECOVERY_GENERATION_UNAVAILABLE_CODE
      && error?.details?.phase === 'schema32-rotation-committed-acknowledgement-failed'
      && error?.details?.errorCode === 'EIO',
  );

  const syncFailure = await getSync(
    fixture,
    pingActor,
    documentBefore.revision,
    generationBefore,
  );
  assertPublicRecoveryGenerationFailure(syncFailure, 'canvas sync');

  const mutationFailure = await postOperation(
    fixture,
    pingActor,
    moveRequest(documentBefore.revision, {
      opId: 'generation-runtime-failure-move',
      clientSeq: 1,
      nodeId: 'node-a',
      position: { x: 24, y: 48 },
    }),
    fixture.canvasId,
    { generation: generationBefore },
  );
  assertPublicRecoveryGenerationFailure(mutationFailure, 'durable mutation generation middleware');

  const currentSession = await requestJson(`${fixture.baseUrl}/api/collab/session`, {
    headers: { cookie: pingActor.cookie },
  });
  assert.equal(currentSession.response.status, 200, currentSession.text);
  assert.equal(currentSession.payload?.data?.id, pingActor.id);
  const statusBeforeSocketFailures = await requestJson(`${fixture.baseUrl}/api/collab/status`);
  assert.equal(statusBeforeSocketFailures.response.status, 200, statusBeforeSocketFailures.text);
  assert.equal(statusBeforeSocketFailures.payload?.data?.running, true);

  const rejectedUpgrade = await requestWebSocketUpgrade(fixture, upgradeActor);
  assert.equal(rejectedUpgrade.statusCode, 503);
  assert.equal(rejectedUpgrade.headers['retry-after'], '1');
  assert.equal(rejectedUpgrade.body, '');

  await Promise.all([
    expectRecoveryGenerationSocketClose(
      pingProbe,
      () => pingProbe.send({ type: 'ping', nonce: 'generation-failure-ping' }),
      'joined ping',
    ),
    expectRecoveryGenerationSocketClose(
      joinProbe,
      () => joinProbe.send({
        type: 'canvas.join',
        canvasId: fixture.canvasId,
        afterRevision: documentBefore.revision,
        generation: generationBefore,
      }),
      'canvas.join',
    ),
    expectRecoveryGenerationSocketClose(
      presenceProbe,
      () => presenceProbe.send({
        type: 'presence.update',
        presence: { cursor: { x: 12, y: 34 } },
      }),
      'presence.update',
    ),
  ]);

  const statusAfterSocketFailures = await requestJson(`${fixture.baseUrl}/api/collab/status`);
  assert.equal(statusAfterSocketFailures.response.status, 200, statusAfterSocketFailures.text);
  assert.equal(statusAfterSocketFailures.payload?.data?.running, true);
});
