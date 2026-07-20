const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  createFixture,
  redeemActor,
  requestJson,
} = require('./helpers/collaborationF2Fixture.cjs');

const MiB = 1024 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function uploadInput(name, marker, idempotencyKey) {
  const bytes = Buffer.from(marker.repeat(32), 'utf8');
  return {
    filename: name,
    mimeType: 'text/plain',
    size: bytes.length,
    contentHash: sha256(bytes),
    chunkSize: MiB,
    idempotencyKey,
  };
}

function actorUploadContext(actor, overrides = {}) {
  return {
    projectId: actor.projectId,
    canvasId: actor.canvasId,
    memberId: actor.memberId,
    sessionId: actor.id,
    authorizationEpoch: actor.authorizationEpoch,
    sourceKind: 'collaboration',
    ...overrides,
  };
}

async function createUpload(fixture, actor, input) {
  return requestJson(`${fixture.baseUrl}/api/collab/assets/uploads`, {
    method: 'POST',
    headers: { cookie: actor.cookie, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

async function listUploads(fixture, actor) {
  return requestJson(`${fixture.baseUrl}/api/collab/assets/uploads`, {
    headers: { cookie: actor.cookie },
  });
}

test('F5 active upload discovery is exact to member, auth session, canvas, and authorization epoch', async (t) => {
  const fixture = await createFixture(t);
  const actor = await redeemActor(fixture, 'editor', 'F5 recovery actor');
  const otherActor = await redeemActor(fixture, 'editor', 'F5 recovery other actor');
  const viewer = await redeemActor(fixture, 'viewer', 'F5 recovery viewer');

  const ownInput = uploadInput('own-recovery.txt', 'own', 'f5-recovery-own-0001');
  const own = await createUpload(fixture, actor, ownInput);
  assert.equal(own.response.status, 201, own.text);
  const ownSession = own.payload.data;

  const oldEpoch = fixture.gateway.uploadManager.createSession(
    uploadInput('old-epoch-hidden.txt', 'epoch', 'f5-recovery-old-epoch-0001'),
    actorUploadContext(actor, { authorizationEpoch: Number(actor.authorizationEpoch) + 1 }),
  );
  const otherSession = fixture.gateway.uploadManager.createSession(
    uploadInput('other-session-hidden.txt', 'session', 'f5-recovery-other-session-0001'),
    actorUploadContext(actor, { sessionId: `${actor.id}-other-session` }),
  );
  const otherCanvas = fixture.gateway.uploadManager.createSession(
    uploadInput('other-canvas-hidden.txt', 'canvas', 'f5-recovery-other-canvas-0001'),
    actorUploadContext(actor, { canvasId: `${actor.canvasId}-other` }),
  );
  const otherMember = await createUpload(
    fixture,
    otherActor,
    uploadInput('other-member-hidden.txt', 'member', 'f5-recovery-other-member-0001'),
  );
  assert.equal(otherMember.response.status, 201, otherMember.text);

  const listed = await listUploads(fixture, actor);
  assert.equal(listed.response.status, 200, listed.text);
  assert.equal(listed.response.headers.get('cache-control'), 'no-store');
  assert.equal(listed.payload.success, true);
  assert.equal(listed.payload.data.truncated, false);
  assert.deepEqual(listed.payload.data.sessions.map((session) => session.id), [ownSession.id]);
  assert.equal(listed.payload.data.sessions[0].filename, ownInput.filename);
  assert.equal(listed.payload.data.sessions[0].expectedSize, ownInput.size);
  assert.equal(listed.payload.data.sessions[0].expectedHash, ownInput.contentHash);
  assert.equal(listed.payload.data.sessions[0].chunkSize, MiB);

  const serialized = JSON.stringify(listed.payload);
  for (const hidden of [oldEpoch, otherSession, otherCanvas, otherMember.payload.data]) {
    assert.equal(serialized.includes(hidden.id), false, `leaked foreign upload ${hidden.id}`);
    assert.equal(serialized.includes(hidden.filename), false, `leaked foreign filename ${hidden.filename}`);
  }
  for (const forbidden of ['idempotencyKey', 'idempotency_key', 'requestDigest', 'request_digest', 'memberId', 'sourceKind']) {
    assert.equal(Object.hasOwn(listed.payload.data.sessions[0], forbidden), false, `leaked ${forbidden}`);
  }
  assert.equal(serialized.includes(fixture.directory), false, 'discovery leaked a host path');
  assert.doesNotMatch(serialized, /(?:temporary|managed|absolute|blob)(?:_|-)?path/i);

  const viewerList = await listUploads(fixture, viewer);
  assert.equal(viewerList.response.status, 403, viewerList.text);
  const otherList = await listUploads(fixture, otherActor);
  assert.equal(otherList.response.status, 200, otherList.text);
  assert.deepEqual(otherList.payload.data.sessions.map((session) => session.id), [otherMember.payload.data.id]);
});

test('F5 discovered reservation survives page loss until the user explicitly cancels it', async (t) => {
  const fixture = await createFixture(t);
  const actor = await redeemActor(fixture, 'editor', 'F5 explicit cancellation actor');
  const input = uploadInput('cancel-recovery.txt', 'cancel', 'f5-recovery-cancel-0001');
  const created = await createUpload(fixture, actor, input);
  assert.equal(created.response.status, 201, created.text);
  const sessionId = created.payload.data.id;

  const before = await listUploads(fixture, actor);
  assert.deepEqual(before.payload.data.sessions.map((session) => session.id), [sessionId]);
  assert.equal(fixture.database.getAssetUploadSession(sessionId).status, 'uploading');

  const cancelled = await requestJson(
    `${fixture.baseUrl}/api/collab/assets/uploads/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', headers: { cookie: actor.cookie } },
  );
  assert.equal(cancelled.response.status, 200, cancelled.text);
  assert.equal(cancelled.payload.data.status, 'cancelled');
  assert.equal(fixture.database.getAssetUploadSession(sessionId).status, 'cancelled');

  const after = await listUploads(fixture, actor);
  assert.deepEqual(after.payload.data.sessions, []);
  const quota = fixture.database.getAssetUploadQuotaStatus(fixture.projectId, actor.memberId);
  assert.equal(quota.member.reservedBytes, 0);
});
