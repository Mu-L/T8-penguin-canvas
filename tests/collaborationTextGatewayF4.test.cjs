const assert = require('node:assert/strict');
const test = require('node:test');
const Y = require('yjs');

const {
  clone,
  createFixture,
  joinSocket,
  openSocketProbe,
  postOperation,
  redeemActor,
  requestJson,
} = require('./helpers/collaborationF2Fixture.cjs');

const TEXT_UPDATE_CONTRACT = 't8-collaboration-text-update-v1';
const TEXT_BINDING_CONTRACT = 't8-collaboration-text-binding-v1';
const NODE_ENTITY_UID = '10000000-0000-4000-8000-000000000001';
const DELETE_NODE_ENTITY_UID = '10000000-0000-4000-8000-000000000002';
const RECOVERY_NODE_ENTITY_UID = '10000000-0000-4000-8000-000000000003';
const REUSED_OLD_NODE_ENTITY_UID = '10000000-0000-4000-8000-000000000004';
const REUSED_NEW_NODE_ENTITY_UID = '10000000-0000-4000-8000-000000000005';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const IDS = Object.freeze({
  alice: '40000000-0000-4000-8000-000000000001',
  bob: '40000000-0000-4000-8000-000000000002',
  viewer: '40000000-0000-4000-8000-000000000004',
  reviewer: '40000000-0000-4000-8000-000000000005',
  extra: '40000000-0000-4000-8000-000000000006',
  offline: '40000000-0000-4000-8000-000000000007',
  staleDeleted: '40000000-0000-4000-8000-000000000008',
  staleEpoch: '40000000-0000-4000-8000-000000000009',
  freshEpoch: '40000000-0000-4000-8000-00000000000a',
  reviewBody: '40000000-0000-4000-8000-00000000000b',
  reviewViewer: '40000000-0000-4000-8000-00000000000c',
  noOp: '40000000-0000-4000-8000-00000000000d',
  crossedScope: '40000000-0000-4000-8000-00000000000e',
  afterNoOp: '40000000-0000-4000-8000-00000000000f',
});

const BINDING_KEYS = Object.freeze([
  'contractVersion',
  'projectId',
  'canvasId',
  'revision',
  'targetType',
  'targetEntityUid',
  'bindingEpoch',
  'field',
  'state',
  'stateVector',
  'materializedText',
]);

const RESULT_KEYS = Object.freeze([
  'contractVersion',
  'updateId',
  'projectId',
  'canvasId',
  'baseRevision',
  'revision',
  'targetType',
  'targetEntityUid',
  'bindingEpoch',
  'field',
  'state',
  'stateVector',
  'text',
  'textDigest',
  'updatedBy',
]);

const RECOVERY_KEYS = Object.freeze([
  'contractVersion',
  'projectId',
  'canvasId',
  'targetType',
  'targetEntityUid',
  'field',
  'legacyText',
  'currentText',
  'legacyTextDigest',
  'materializedTextDigest',
  'preserved',
  'updatedAt',
]);

function exactKeys(value, expected, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} fields drifted`);
}

function canonicalBase64(value, label) {
  assert.equal(typeof value, 'string', `${label} must be base64 text`);
  assert.ok(value.length > 0, `${label} must not be empty`);
  assert.equal(Buffer.from(value, 'base64').toString('base64'), value, `${label} is not canonical base64`);
  return Buffer.from(value, 'base64');
}

function textFromState(state) {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, canonicalBase64(state, 'Yjs state'));
    const text = document.getText('content');
    const roots = [...document.share.entries()];
    assert.equal(roots.length, 1, 'text state must contain exactly one shared root');
    assert.equal(roots[0][0], 'content');
    assert.ok(roots[0][1] instanceof Y.Text);
    return text.toString();
  } finally {
    document.destroy();
  }
}

function updateFromState(state, mutate) {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, canonicalBase64(state, 'base Yjs state'));
    const before = Y.encodeStateVector(document);
    mutate(document.getText('content'));
    return Buffer.from(Y.encodeStateAsUpdate(document, before)).toString('base64');
  } finally {
    document.destroy();
  }
}

function stateBufferFromText(value) {
  const document = new Y.Doc();
  try {
    document.getText('content').insert(0, value);
    return Buffer.from(Y.encodeStateAsUpdate(document));
  } finally {
    document.destroy();
  }
}

function appendUpdate(state, value) {
  return updateFromState(state, (text) => text.insert(text.length, value));
}

function envelope(snapshot, input = {}) {
  return {
    contractVersion: TEXT_UPDATE_CONTRACT,
    updateId: input.updateId,
    clientSeq: input.clientSeq ?? 0,
    projectId: snapshot.projectId,
    canvasId: snapshot.canvasId,
    baseRevision: input.baseRevision ?? snapshot.revision,
    targetType: snapshot.targetType,
    targetEntityUid: snapshot.targetEntityUid,
    bindingEpoch: input.bindingEpoch ?? snapshot.bindingEpoch,
    field: snapshot.field,
    update: input.update,
  };
}

function textUrl(fixture, targetType, targetEntityUid, field) {
  const query = new URLSearchParams({ targetType, targetEntityUid, field });
  return `${fixture.baseUrl}/api/collab/canvases/${encodeURIComponent(fixture.canvasId)}/text?${query}`;
}

function recoveryUrl(fixture, targetType, targetEntityUid, field, canvasId = fixture.canvasId) {
  const query = new URLSearchParams({ targetType, targetEntityUid, field });
  return `${fixture.baseUrl}/api/collab/canvases/${encodeURIComponent(canvasId)}/text/recovery?${query}`;
}

async function getTextBinding(fixture, actor, targetType, targetEntityUid, field, expectedNextSeq = null) {
  const result = await requestJson(textUrl(fixture, targetType, targetEntityUid, field), {
    headers: { cookie: actor.cookie },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload?.success, true);
  exactKeys(result.payload.data, BINDING_KEYS, 'text binding snapshot');
  const snapshot = result.payload.data;
  assert.equal(snapshot.contractVersion, TEXT_BINDING_CONTRACT);
  assert.equal(snapshot.projectId, fixture.projectId);
  assert.equal(snapshot.canvasId, fixture.canvasId);
  assert.equal(snapshot.targetType, targetType);
  assert.equal(snapshot.targetEntityUid, targetEntityUid);
  assert.equal(snapshot.field, field);
  assert.match(snapshot.bindingEpoch, UUID_PATTERN);
  assert.ok(Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 1);
  canonicalBase64(snapshot.stateVector, 'binding stateVector');
  assert.equal(textFromState(snapshot.state), snapshot.materializedText);
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
  if (expectedNextSeq != null) {
    assert.equal(
      result.response.headers.get('x-t8-text-next-client-seq'),
      String(expectedNextSeq),
      'GET must expose the session-scoped next text client sequence',
    );
  }
  return snapshot;
}

async function postTextUpdate(fixture, actor, body) {
  return requestJson(
    `${fixture.baseUrl}/api/collab/canvases/${encodeURIComponent(fixture.canvasId)}/text/updates`,
    {
      method: 'POST',
      headers: { cookie: actor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

function assertTextResult(result, expected = {}) {
  exactKeys(result, RESULT_KEYS, 'text update result');
  assert.equal(result.contractVersion, TEXT_UPDATE_CONTRACT);
  assert.equal(result.updateId, expected.updateId);
  assert.equal(result.projectId, expected.projectId);
  assert.equal(result.canvasId, expected.canvasId);
  assert.equal(result.baseRevision, expected.baseRevision);
  assert.equal(result.revision, expected.revision);
  assert.equal(result.targetType, expected.targetType);
  assert.equal(result.targetEntityUid, expected.targetEntityUid);
  assert.equal(result.bindingEpoch, expected.bindingEpoch);
  assert.equal(result.field, expected.field);
  assert.equal(result.updatedBy, expected.updatedBy);
  assert.match(result.textDigest, SHA256_PATTERN);
  canonicalBase64(result.stateVector, 'result stateVector');
  assert.equal(textFromState(result.state), result.text);
}

function rows(database, table, orderBy = '') {
  const suffix = orderBy ? ` ORDER BY ${orderBy}` : '';
  return database.db.prepare(`SELECT * FROM ${table}${suffix}`).all();
}

function parsePayload(row) {
  return JSON.parse(row.payload_json);
}

function parseResult(row) {
  return JSON.parse(row.result_json);
}

function collaborationTextAuditRows(database, projectId, canvasId) {
  return database.listAuditEvents({
    projectId,
    canvasId,
    action: 'collaboration.text.update',
    limit: 1000,
  }).sort((left, right) => left.id - right.id);
}

function persistenceFingerprint(fixture) {
  const database = fixture.database;
  return {
    document: clone(database.getCanvas(fixture.canvasId)),
    bindings: rows(database, 'collaboration_text_documents', 'target_type, target_entity_uid, field_name')
      .map((row) => ({ ...row, state_blob: Buffer.from(row.state_blob).toString('hex') })),
    operations: rows(database, 'canvas_operations', 'revision')
      .filter((row) => row.type === 'text.update'),
    operationIdempotency: rows(database, 'canvas_operation_idempotency', 'revision')
      .filter((row) => row.type === 'text.update'),
    textIdempotency: rows(database, 'collaboration_text_update_idempotency', 'revision'),
    textNoOpIdempotency: rows(database, 'collaboration_text_noop_idempotency', 'revision'),
    operationIdentities: rows(database, 'collaboration_operation_identities', 'created_at, op_id'),
    clientSequences: rows(database, 'collaboration_text_client_sequences', 'actor_id, session_id'),
    audits: collaborationTextAuditRows(database, fixture.projectId, fixture.canvasId),
  };
}

function assertNoHalfWrite(before, fixture, label) {
  assert.deepEqual(persistenceFingerprint(fixture), before, `${label} left a partial text transaction`);
}

function collectStringValues(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStringValues(item, output));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStringValues(item, output));
  }
  return output;
}

function assertPublicTextEvent(event, expected, fixture, actorCookies, secret) {
  assert.equal(event.type, 'collaboration.text-update');
  assert.equal(event.contractVersion, TEXT_UPDATE_CONTRACT);
  assert.equal(event.canvasId, fixture.canvasId);
  assert.equal(event.updateId, expected.updateId);
  assert.equal(event.revision, expected.revision);
  assert.equal(event.targetType, expected.targetType);
  assert.equal(event.targetEntityUid, expected.targetEntityUid);
  assert.equal(event.bindingEpoch, expected.bindingEpoch);
  assert.equal(event.field, expected.field);
  assert.equal(event.update, expected.update);
  assert.equal(event.actorId, expected.actorId);
  assert.ok(Number.isSafeInteger(event.timestamp) && event.timestamp > 0);

  const forbiddenKeys = new Set([
    'state',
    'materializedText',
    'requestDigest',
    'sessionId',
    'cookie',
    'token',
    'absolutePath',
    'sourcePath',
  ]);
  const inspect = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `public text event exposed forbidden field ${key}`);
      inspect(child);
    }
  };
  inspect(event);
  const strings = collectStringValues(event);
  const normalizedDirectory = fixture.directory.replace(/\\/g, '/');
  const cookieSecrets = actorCookies.map((cookie) => String(cookie).split('=').slice(1).join('='));
  for (const value of strings) {
    assert.equal(value.includes(fixture.directory), false, 'public text event leaked the host temp directory');
    assert.equal(value.replace(/\\/g, '/').includes(normalizedDirectory), false, 'public text event leaked a normalized host path');
    assert.doesNotMatch(
      value,
      /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/(?:Users|home|tmp|var|etc)\/)/,
      'public text event exposed an absolute host path',
    );
    assert.equal(value.includes(secret), false, 'public text event leaked a configured secret');
    for (const cookieSecret of cookieSecrets) {
      assert.equal(Boolean(cookieSecret) && value.includes(cookieSecret), false, 'public text event leaked a session cookie');
    }
  }
}

function promptSnapshot(entityUid = NODE_ENTITY_UID, prompt = '') {
  return {
    name: 'F4 collaborative text gateway',
    nodes: [{
      id: 'node-prompt',
      entityUid,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { title: 'Prompt node', prompt },
    }],
    edges: [],
  };
}

function graphBatch(baseRevision, operations) {
  return JSON.stringify({ baseRevision, operations });
}

test('F4 gateway merges two independent editor Y.Text increments atomically and replays only exact unknown results', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-f4-text-concurrency',
    canvasId: 'canvas-f4-text-concurrency',
    snapshot: promptSnapshot(),
  });
  const secret = 'F4_GATEWAY_SECRET_MUST_NOT_LEAK';
  fixture.gateway.config.F4_ACCEPTANCE_SECRET = secret;
  const alice = await redeemActor(fixture, 'editor', 'F4 text Alice');
  const bob = await redeemActor(fixture, 'editor', 'F4 text Bob');
  const observer = await redeemActor(fixture, 'viewer', 'F4 text observer');
  const probe = await openSocketProbe(fixture, observer, { label: 'F4 text observer socket' });
  await joinSocket(probe, fixture.canvasId, 1);

  const initial = await getTextBinding(fixture, alice, 'node', NODE_ENTITY_UID, 'prompt', 0);
  assert.equal(initial.revision, 1);
  assert.equal(initial.materializedText, '');
  const bobInitial = await getTextBinding(fixture, bob, 'node', NODE_ENTITY_UID, 'prompt', 0);
  assert.deepEqual(bobInitial, initial, 'both editors must start from one authoritative binding');

  const aliceEnvelope = envelope(initial, {
    updateId: IDS.alice,
    clientSeq: 0,
    update: appendUpdate(initial.state, '甲'),
  });
  const bobEnvelope = envelope(bobInitial, {
    updateId: IDS.bob,
    clientSeq: 0,
    update: appendUpdate(bobInitial.state, '乙'),
  });

  const aliceApplied = await postTextUpdate(fixture, alice, aliceEnvelope);
  assert.equal(aliceApplied.response.status, 200, JSON.stringify(aliceApplied.payload));
  assert.equal(aliceApplied.payload?.success, true);
  assert.equal(aliceApplied.response.headers.get('x-t8-collaboration-text-noop'), '0');
  assertTextResult(aliceApplied.payload.data, {
    ...aliceEnvelope,
    revision: 2,
    updatedBy: alice.memberId,
  });
  assert.equal(aliceApplied.payload.data.text, '甲');

  const bobApplied = await postTextUpdate(fixture, bob, bobEnvelope);
  assert.equal(bobApplied.response.status, 200, JSON.stringify(bobApplied.payload));
  assert.equal(bobApplied.payload?.success, true);
  assert.equal(bobApplied.response.headers.get('x-t8-collaboration-text-noop'), '0');
  assertTextResult(bobApplied.payload.data, {
    ...bobEnvelope,
    revision: 3,
    updatedBy: bob.memberId,
  });
  assert.equal(bobApplied.payload.data.text.length, 2);
  assert.deepEqual(new Set(bobApplied.payload.data.text), new Set(['甲', '乙']));

  const aliceEvent = await probe.nextMessage(
    (message) => message.type === 'collaboration.text-update' && message.updateId === IDS.alice,
    'Alice public text event timed out',
  );
  const bobEvent = await probe.nextMessage(
    (message) => message.type === 'collaboration.text-update' && message.updateId === IDS.bob,
    'Bob public text event timed out',
  );
  assertPublicTextEvent(aliceEvent, {
    ...aliceEnvelope,
    revision: 2,
    actorId: alice.memberId,
  }, fixture, [alice.cookie, bob.cookie, observer.cookie], secret);
  assertPublicTextEvent(bobEvent, {
    ...bobEnvelope,
    revision: 3,
    actorId: bob.memberId,
  }, fixture, [alice.cookie, bob.cookie, observer.cookie], secret);

  const authoritative = fixture.database.getCanvas(fixture.canvasId);
  assert.equal(authoritative.revision, 3);
  const materialized = authoritative.nodes.find((node) => node.entityUid === NODE_ENTITY_UID)?.data?.prompt;
  assert.equal(materialized, bobApplied.payload.data.text);
  assert.deepEqual(new Set(materialized), new Set(['甲', '乙']));

  const operations = fixture.database.db.prepare(`
    SELECT * FROM canvas_operations WHERE type = 'text.update' ORDER BY revision
  `).all();
  assert.deepEqual(operations.map((row) => [row.op_id, row.revision, row.base_revision, row.client_seq]), [
    [IDS.alice, 2, 1, 0],
    [IDS.bob, 3, 1, 0],
  ]);
  assert.deepEqual(operations.map((row) => row.actor_id), [alice.memberId, bob.memberId]);
  assert.deepEqual(operations.map(parsePayload).map((payload) => ({
    contractVersion: payload.contractVersion,
    targetType: payload.targetType,
    targetEntityUid: payload.targetEntityUid,
    bindingEpoch: payload.bindingEpoch,
    field: payload.field,
    update: payload.update,
  })), [
    {
      contractVersion: TEXT_UPDATE_CONTRACT,
      targetType: 'node',
      targetEntityUid: NODE_ENTITY_UID,
      bindingEpoch: initial.bindingEpoch,
      field: 'prompt',
      update: aliceEnvelope.update,
    },
    {
      contractVersion: TEXT_UPDATE_CONTRACT,
      targetType: 'node',
      targetEntityUid: NODE_ENTITY_UID,
      bindingEpoch: initial.bindingEpoch,
      field: 'prompt',
      update: bobEnvelope.update,
    },
  ]);

  const bindingRows = rows(fixture.database, 'collaboration_text_documents');
  assert.equal(bindingRows.length, 1);
  assert.equal(bindingRows[0].project_id, fixture.projectId);
  assert.equal(bindingRows[0].canvas_id, fixture.canvasId);
  assert.equal(bindingRows[0].target_type, 'node');
  assert.equal(bindingRows[0].target_id, `@t8/text-entity/${NODE_ENTITY_UID}`);
  assert.equal(bindingRows[0].display_target_id, 'node-prompt');
  assert.equal(bindingRows[0].target_entity_uid, NODE_ENTITY_UID);
  assert.equal(bindingRows[0].binding_epoch, initial.bindingEpoch);
  assert.equal(bindingRows[0].lifecycle, 'active');
  assert.equal(bindingRows[0].created_revision, 1);
  assert.equal(bindingRows[0].revision, 3);
  assert.equal(bindingRows[0].materialized_text, materialized);
  assert.equal(textFromState(Buffer.from(bindingRows[0].state_blob).toString('base64')), materialized);
  assert.match(bindingRows[0].state_digest, SHA256_PATTERN);
  assert.match(bindingRows[0].text_digest, SHA256_PATTERN);

  const textIdempotency = rows(fixture.database, 'collaboration_text_update_idempotency', 'revision');
  assert.deepEqual(textIdempotency.map((row) => [row.update_id, row.revision, row.client_seq]), [
    [IDS.alice, 2, 0],
    [IDS.bob, 3, 0],
  ]);
  assert.deepEqual(textIdempotency.map((row) => row.actor_id), [alice.memberId, bob.memberId]);
  for (const row of textIdempotency) {
    assert.match(row.request_digest, SHA256_PATTERN);
    assert.equal(parseResult(row).updateId, row.update_id);
  }
  const sequences = rows(fixture.database, 'collaboration_text_client_sequences', 'actor_id, session_id');
  assert.equal(sequences.length, 2);
  assert.deepEqual(new Set(sequences.map((row) => row.actor_id)), new Set([alice.memberId, bob.memberId]));
  assert.deepEqual(sequences.map((row) => row.last_client_seq), [0, 0]);
  const audits = collaborationTextAuditRows(fixture.database, fixture.projectId, fixture.canvasId);
  assert.deepEqual(new Set(audits.map((audit) => audit.metadata.updateId)), new Set([IDS.alice, IDS.bob]));
  assert.equal(audits.length, 2);
  for (const audit of audits) {
    assert.equal(audit.targetType, 'node');
    assert.equal(audit.targetId, NODE_ENTITY_UID);
    assert.equal(Object.hasOwn(audit.metadata, 'text'), false);
    assert.match(audit.metadata.textDigest, SHA256_PATTERN);
  }

  const beforeReplay = persistenceFingerprint(fixture);
  const replay = await postTextUpdate(fixture, alice, clone(aliceEnvelope));
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.deepEqual(replay.payload.data, aliceApplied.payload.data, 'exact retry must return the original result');
  assertNoHalfWrite(beforeReplay, fixture, 'exact unknown-result replay');
  await probe.expectNoMessage(
    (message) => message.type === 'collaboration.text-update',
    200,
    'exact text retry emitted a duplicate WebSocket event',
  );

  const changedCollision = {
    ...aliceEnvelope,
    update: appendUpdate(initial.state, '碰撞'),
  };
  const collision = await postTextUpdate(fixture, alice, changedCollision);
  assert.equal(collision.response.status, 409, JSON.stringify(collision.payload));
  assert.equal(collision.payload.code, 'collaboration_text_idempotency_collision');
  assertNoHalfWrite(beforeReplay, fixture, 'same updateId collision');

  const reviewer = await redeemActor(fixture, 'reviewer', 'F4 prompt reviewer');
  const viewer = await redeemActor(fixture, 'viewer', 'F4 prompt viewer');
  const current = await getTextBinding(fixture, alice, 'node', NODE_ENTITY_UID, 'prompt', 1);
  const noOpEnvelope = envelope(current, {
    updateId: IDS.noOp,
    clientSeq: 1,
    update: updateFromState(current.state, () => {}),
  });
  const beforeNoOp = persistenceFingerprint(fixture);
  const noOp = await postTextUpdate(fixture, alice, noOpEnvelope);
  assert.equal(noOp.response.status, 200, JSON.stringify(noOp.payload));
  assert.equal(noOp.response.headers.get('x-t8-collaboration-text-noop'), '1');
  assert.equal(noOp.response.headers.get('cache-control'), 'no-store');
  assertTextResult(noOp.payload.data, {
    ...noOpEnvelope,
    revision: current.revision,
    updatedBy: bob.memberId,
  });
  assert.deepEqual({
    ...persistenceFingerprint(fixture),
    textNoOpIdempotency: beforeNoOp.textNoOpIdempotency,
    operationIdentities: beforeNoOp.operationIdentities,
  }, beforeNoOp, 'legal Yjs no-op must not advance canvas/binding/sequence/operation/audit state');
  assert.equal(rows(fixture.database, 'collaboration_text_noop_idempotency').length, 1);
  assert.equal(rows(fixture.database, 'collaboration_text_noop_idempotency')[0].update_id, IDS.noOp);
  await probe.expectNoMessage(
    (message) => message.type === 'collaboration.text-update' && message.updateId === IDS.noOp,
    200,
    'legal Yjs no-op emitted a WebSocket event',
  );
  const noOpReplayFingerprint = persistenceFingerprint(fixture);
  const noOpReplay = await postTextUpdate(fixture, alice, clone(noOpEnvelope));
  assert.equal(noOpReplay.response.status, 200, JSON.stringify(noOpReplay.payload));
  assert.equal(noOpReplay.response.headers.get('x-t8-collaboration-text-noop'), '1');
  assert.deepEqual(noOpReplay.payload.data, noOp.payload.data);
  assertNoHalfWrite(noOpReplayFingerprint, fixture, 'exact no-op replay');
  const afterNoOpBinding = await getTextBinding(fixture, alice, 'node', NODE_ENTITY_UID, 'prompt', 1);
  assert.equal(afterNoOpBinding.revision, current.revision);

  const rejectedUpdate = appendUpdate(current.state, '!');
  const invalidCases = [
    {
      label: 'reviewer prompt capability',
      actor: reviewer,
      body: envelope(current, { updateId: IDS.reviewer, clientSeq: 0, update: rejectedUpdate }),
      status: 403,
      code: 'collaboration_text_permission_denied',
    },
    {
      label: 'viewer prompt capability',
      actor: viewer,
      body: envelope(current, { updateId: IDS.viewer, clientSeq: 0, update: rejectedUpdate }),
      status: 403,
      code: 'collaboration_text_permission_denied',
    },
    {
      label: 'extra envelope field',
      actor: alice,
      body: { ...envelope(current, { updateId: IDS.extra, clientSeq: 1, update: rejectedUpdate }), unexpected: true },
      status: 400,
      code: 'collaboration_text_envelope_invalid',
    },
    {
      label: 'offline queue marker',
      actor: alice,
      body: { ...envelope(current, { updateId: IDS.offline, clientSeq: 1, update: rejectedUpdate }), offline: true },
      status: 400,
      code: 'collaboration_text_envelope_invalid',
    },
    {
      label: 'principal/envelope project scope mismatch',
      actor: alice,
      body: {
        ...envelope(current, { updateId: IDS.crossedScope, clientSeq: 1, update: rejectedUpdate }),
        projectId: 'project-f4-crossed-scope',
      },
      status: 403,
      code: 'collaboration_text_scope_mismatch',
    },
  ];
  for (const item of invalidCases) {
    const before = persistenceFingerprint(fixture);
    const rejected = await postTextUpdate(fixture, item.actor, item.body);
    assert.equal(rejected.response.status, item.status, `${item.label}: ${JSON.stringify(rejected.payload)}`);
    assert.equal(rejected.payload.code, item.code, item.label);
    assertNoHalfWrite(before, fixture, item.label);
  }

  const meaningfulAfterNoOpEnvelope = envelope(afterNoOpBinding, {
    updateId: IDS.afterNoOp,
    clientSeq: 1,
    update: appendUpdate(afterNoOpBinding.state, ' after no-op'),
  });
  const meaningfulAfterNoOp = await postTextUpdate(
    fixture,
    alice,
    meaningfulAfterNoOpEnvelope,
  );
  assert.equal(
    meaningfulAfterNoOp.response.status,
    200,
    JSON.stringify(meaningfulAfterNoOp.payload),
  );
  assert.equal(
    meaningfulAfterNoOp.response.headers.get('x-t8-collaboration-text-noop'),
    '0',
  );
  assertTextResult(meaningfulAfterNoOp.payload.data, {
    ...meaningfulAfterNoOpEnvelope,
    revision: current.revision + 1,
    updatedBy: alice.memberId,
  });
  assert.equal(
    meaningfulAfterNoOp.payload.data.text,
    `${current.materializedText} after no-op`,
  );
  const meaningfulEvent = await probe.nextMessage(
    (message) => message.type === 'collaboration.text-update'
      && message.updateId === IDS.afterNoOp,
    'meaningful update after state-level no-op timed out',
  );
  assertPublicTextEvent(meaningfulEvent, {
    ...meaningfulAfterNoOpEnvelope,
    revision: current.revision + 1,
    actorId: alice.memberId,
  }, fixture, [alice.cookie, bob.cookie, observer.cookie], secret);
  const finalBinding = await getTextBinding(
    fixture,
    alice,
    'node',
    NODE_ENTITY_UID,
    'prompt',
    2,
  );
  assert.equal(finalBinding.revision, current.revision + 1);
  assert.equal(finalBinding.materializedText, `${current.materializedText} after no-op`);

  assert.equal(fixture.database.db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(fixture.database.db.pragma('foreign_key_check'), []);
});

test('F4 gateway rejects delete/edit races and rotates the binding epoch after explicit restore', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-f4-text-delete-restore',
    canvasId: 'canvas-f4-text-delete-restore',
    snapshot: promptSnapshot(DELETE_NODE_ENTITY_UID, ''),
  });
  const editor = await redeemActor(fixture, 'editor', 'F4 delete restore editor');
  const original = await getTextBinding(
    fixture,
    editor,
    'node',
    DELETE_NODE_ENTITY_UID,
    'prompt',
    0,
  );
  const staleUpdate = appendUpdate(original.state, 'stale edit');

  const deletion = await postOperation(fixture, editor, graphBatch(1, [{
    opId: 'f4-text-node-delete',
    clientSeq: 100,
    timestamp: 1_900_000_100_001,
    type: 'node.delete',
    payload: { nodeId: 'node-prompt' },
  }]));
  assert.equal(deletion.response.status, 200, JSON.stringify(deletion.payload));
  assert.equal(deletion.payload.data.document.revision, 2);
  assert.equal(deletion.payload.data.document.nodes.length, 0);
  assert.equal(
    deletion.payload.data.document.tombstones.nodes['node-prompt'].entityUid,
    DELETE_NODE_ENTITY_UID,
  );

  const deletedFingerprint = persistenceFingerprint(fixture);
  const deleteRace = await postTextUpdate(fixture, editor, envelope(original, {
    updateId: IDS.staleDeleted,
    clientSeq: 0,
    update: staleUpdate,
  }));
  assert.equal(deleteRace.response.status, 409, JSON.stringify(deleteRace.payload));
  assert.equal(deleteRace.payload.code, 'collaboration_text_target_deleted');
  assertNoHalfWrite(deletedFingerprint, fixture, 'delete/edit race');

  const restored = await postOperation(fixture, editor, graphBatch(2, [{
    opId: 'f4-text-node-restore',
    clientSeq: 101,
    timestamp: 1_900_000_100_002,
    type: 'node.restore',
    payload: {
      node: {
        id: 'node-prompt',
        type: 'text',
        position: { x: 20, y: 30 },
        data: { title: 'Restored prompt', prompt: '' },
      },
    },
  }]));
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.data.document.revision, 3);
  const restoredNode = restored.payload.data.document.nodes.find((node) => node.id === 'node-prompt');
  assert.equal(restoredNode.entityUid, DELETE_NODE_ENTITY_UID);
  assert.equal(restoredNode.data.prompt, '');

  const fresh = await getTextBinding(
    fixture,
    editor,
    'node',
    DELETE_NODE_ENTITY_UID,
    'prompt',
    0,
  );
  assert.equal(fresh.revision, 3);
  assert.equal(fresh.materializedText, '');
  assert.notEqual(fresh.bindingEpoch, original.bindingEpoch, 'explicit restore must rotate the binding epoch');

  const beforeOldEpoch = persistenceFingerprint(fixture);
  const oldEpoch = await postTextUpdate(fixture, editor, envelope(fresh, {
    updateId: IDS.staleEpoch,
    clientSeq: 0,
    bindingEpoch: original.bindingEpoch,
    update: staleUpdate,
  }));
  assert.equal(oldEpoch.response.status, 409, JSON.stringify(oldEpoch.payload));
  assert.equal(oldEpoch.payload.code, 'collaboration_text_binding_epoch_mismatch');
  assertNoHalfWrite(beforeOldEpoch, fixture, 'stale pre-delete binding epoch');

  const freshEnvelope = envelope(fresh, {
    updateId: IDS.freshEpoch,
    clientSeq: 0,
    update: appendUpdate(fresh.state, 'fresh edit'),
  });
  const freshApplied = await postTextUpdate(fixture, editor, freshEnvelope);
  assert.equal(freshApplied.response.status, 200, JSON.stringify(freshApplied.payload));
  assertTextResult(freshApplied.payload.data, {
    ...freshEnvelope,
    revision: 4,
    updatedBy: editor.memberId,
  });
  assert.equal(freshApplied.payload.data.text, 'fresh edit');
  const finalDocument = fixture.database.getCanvas(fixture.canvasId);
  assert.equal(finalDocument.revision, 4);
  assert.equal(finalDocument.nodes.find((node) => node.entityUid === DELETE_NODE_ENTITY_UID).data.prompt, 'fresh edit');
  assert.equal(finalDocument.nodes.find((node) => node.entityUid === DELETE_NODE_ENTITY_UID).data.prompt.includes('stale edit'), false);

  const binding = rows(fixture.database, 'collaboration_text_documents');
  assert.equal(binding.length, 1);
  assert.equal(binding[0].binding_epoch, fresh.bindingEpoch);
  assert.equal(binding[0].lifecycle, 'active');
  assert.equal(binding[0].created_revision, 3);
  assert.equal(binding[0].revision, 4);
  assert.deepEqual(
    rows(fixture.database, 'collaboration_text_update_idempotency').map((row) => row.update_id),
    [IDS.freshEpoch],
  );
  assert.deepEqual(
    fixture.database.db.prepare("SELECT op_id FROM canvas_operations WHERE type = 'text.update'").all().map((row) => row.op_id),
    [IDS.freshEpoch],
  );
  assert.equal(collaborationTextAuditRows(fixture.database, fixture.projectId, fixture.canvasId).length, 1);
  assert.equal(fixture.database.db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(fixture.database.db.pragma('foreign_key_check'), []);
});

test('F4 gateway grants reviewer comment-body text authority dynamically and denies a viewer without partial writes', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-f4-review-text',
    canvasId: 'canvas-f4-review-text',
    snapshot: promptSnapshot(),
  });
  const reviewer = await redeemActor(fixture, 'reviewer', 'F4 body reviewer');
  const viewer = await redeemActor(fixture, 'viewer', 'F4 body viewer');

  const thread = fixture.database.createReviewThreadWithComment({
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    canvasRevision: 1,
    anchor: { kind: 'canvas' },
    severity: 'normal',
    createdBy: reviewer.memberId,
  }, {
    body: '原评论',
    actorId: reviewer.memberId,
    sessionId: reviewer.id,
  });
  assert.equal(thread.comments.length, 1);
  const comment = thread.comments[0];
  assert.match(comment.entityUid, UUID_PATTERN);
  assert.equal(comment.body, '原评论');

  const binding = await getTextBinding(
    fixture,
    reviewer,
    'review',
    comment.entityUid,
    'body',
    0,
  );
  assert.equal(binding.revision, 1);
  assert.equal(binding.materializedText, '原评论');
  const bodyEnvelope = envelope(binding, {
    updateId: IDS.reviewBody,
    clientSeq: 0,
    update: appendUpdate(binding.state, ' + 复核'),
  });
  const updated = await postTextUpdate(fixture, reviewer, bodyEnvelope);
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assertTextResult(updated.payload.data, {
    ...bodyEnvelope,
    revision: 2,
    updatedBy: reviewer.memberId,
  });
  assert.equal(updated.payload.data.text, '原评论 + 复核');
  assert.equal(fixture.database.getCanvas(fixture.canvasId).revision, 2);
  assert.equal(fixture.database.listReviewComments(thread.id)[0].body, '原评论 + 复核');

  const operations = fixture.database.db.prepare(`
    SELECT * FROM canvas_operations WHERE type = 'text.update'
  `).all();
  assert.equal(operations.length, 1);
  assert.equal(operations[0].op_id, IDS.reviewBody);
  assert.equal(operations[0].actor_id, reviewer.memberId);
  assert.equal(operations[0].revision, 2);
  assert.equal(parsePayload(operations[0]).targetType, 'review');
  const textIdempotency = rows(fixture.database, 'collaboration_text_update_idempotency');
  assert.equal(textIdempotency.length, 1);
  assert.equal(textIdempotency[0].update_id, IDS.reviewBody);
  const clientSequences = rows(fixture.database, 'collaboration_text_client_sequences');
  assert.equal(clientSequences.length, 1);
  assert.equal(clientSequences[0].actor_id, reviewer.memberId);
  assert.equal(clientSequences[0].last_client_seq, 0);
  const audits = collaborationTextAuditRows(fixture.database, fixture.projectId, fixture.canvasId);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].targetType, 'review');
  assert.equal(audits[0].targetId, comment.entityUid);

  const current = await getTextBinding(
    fixture,
    viewer,
    'review',
    comment.entityUid,
    'body',
    0,
  );
  const beforeDenied = persistenceFingerprint(fixture);
  const denied = await postTextUpdate(fixture, viewer, envelope(current, {
    updateId: IDS.reviewViewer,
    clientSeq: 0,
    update: appendUpdate(current.state, ' forbidden'),
  }));
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, 'collaboration_text_permission_denied');
  assertNoHalfWrite(beforeDenied, fixture, 'viewer review-body update');
  assert.equal(fixture.database.listReviewComments(thread.id)[0].body, '原评论 + 复核');
  assert.equal(fixture.database.db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(fixture.database.db.pragma('foreign_key_check'), []);
});

test('F4 gateway exposes legacy recovery text only through the authorized no-store endpoint', async (t) => {
  const legacyText = '仅授权恢复接口可见的旧草稿';
  const currentText = '当前画布正文';
  const reusedLegacyText = '显示 ID 复用前的无 UID 草稿';
  const fixture = await createFixture(t, {
    projectId: 'project-f4-text-recovery',
    canvasId: 'canvas-f4-text-recovery',
    snapshot: {
      name: 'F4 collaborative text recovery',
      nodes: [
        {
          id: 'node-recovery',
          entityUid: RECOVERY_NODE_ENTITY_UID,
          type: 'text',
          position: { x: 0, y: 0 },
          data: { title: 'Recovery node', prompt: currentText },
        },
        {
          id: 'node-reused',
          entityUid: REUSED_OLD_NODE_ENTITY_UID,
          type: 'text',
          position: { x: 100, y: 0 },
          data: { title: 'Reused node', prompt: 'stable old text' },
        },
      ],
      edges: [],
    },
  });
  const editor = await redeemActor(fixture, 'editor', 'F4 recovery editor');
  const viewer = await redeemActor(fixture, 'viewer', 'F4 recovery viewer');
  fixture.database.saveCollaborativeTextDocument({
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    targetType: 'node',
    targetId: 'node-recovery',
    field: 'prompt',
    state: stateBufferFromText(legacyText),
    updatedBy: 'legacy-writer',
  });

  const beforeConflict = persistenceFingerprint(fixture);
  const ordinary = await requestJson(
    textUrl(fixture, 'node', RECOVERY_NODE_ENTITY_UID, 'prompt'),
    { headers: { cookie: editor.cookie } },
  );
  assert.equal(ordinary.response.status, 409, JSON.stringify(ordinary.payload));
  assert.equal(ordinary.payload.code, 'collaboration_text_schema_mismatch');
  assert.equal(ordinary.payload.details?.recoveryAvailable, true);
  assert.equal(
    ordinary.payload.details?.recoveryContractVersion,
    't8-collaboration-text-recovery-v1',
  );
  assert.match(ordinary.payload.details?.legacyTextDigest, SHA256_PATTERN);
  assert.match(ordinary.payload.details?.materializedTextDigest, SHA256_PATTERN);
  assert.equal(Object.hasOwn(ordinary.payload.details || {}, 'legacyText'), false);
  assert.equal(Object.hasOwn(ordinary.payload.details || {}, 'currentText'), false);
  assert.equal(collectStringValues(ordinary.payload).some((value) => (
    value.includes(legacyText) || value.includes(currentText)
  )), false, 'ordinary binding conflict leaked plaintext recovery data');
  assertNoHalfWrite(beforeConflict, fixture, 'ordinary schema-mismatch binding read');

  const beforeRecovery = persistenceFingerprint(fixture);
  const recovery = await requestJson(
    recoveryUrl(fixture, 'node', RECOVERY_NODE_ENTITY_UID, 'prompt'),
    { headers: { cookie: editor.cookie } },
  );
  assert.equal(recovery.response.status, 200, JSON.stringify(recovery.payload));
  assert.equal(recovery.payload?.success, true);
  exactKeys(recovery.payload.data, RECOVERY_KEYS, 'legacy recovery model');
  assert.deepEqual({
    contractVersion: recovery.payload.data.contractVersion,
    projectId: recovery.payload.data.projectId,
    canvasId: recovery.payload.data.canvasId,
    targetType: recovery.payload.data.targetType,
    targetEntityUid: recovery.payload.data.targetEntityUid,
    field: recovery.payload.data.field,
    legacyText: recovery.payload.data.legacyText,
    currentText: recovery.payload.data.currentText,
    preserved: recovery.payload.data.preserved,
  }, {
    contractVersion: 't8-collaboration-text-recovery-v1',
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    targetType: 'node',
    targetEntityUid: RECOVERY_NODE_ENTITY_UID,
    field: 'prompt',
    legacyText,
    currentText,
    preserved: true,
  });
  assert.match(recovery.payload.data.legacyTextDigest, SHA256_PATTERN);
  assert.match(recovery.payload.data.materializedTextDigest, SHA256_PATTERN);
  assert.ok(Number.isSafeInteger(recovery.payload.data.updatedAt));
  assert.equal(recovery.response.headers.get('cache-control'), 'no-store');
  assertNoHalfWrite(beforeRecovery, fixture, 'authorized legacy recovery read');

  const beforeViewer = persistenceFingerprint(fixture);
  const viewerDenied = await requestJson(
    recoveryUrl(fixture, 'node', RECOVERY_NODE_ENTITY_UID, 'prompt'),
    { headers: { cookie: viewer.cookie } },
  );
  assert.equal(viewerDenied.response.status, 403, JSON.stringify(viewerDenied.payload));
  assert.equal(viewerDenied.payload.code, 'collaboration_text_permission_denied');
  assert.equal(collectStringValues(viewerDenied.payload).some((value) => (
    value.includes(legacyText) || value.includes(currentText)
  )), false);
  assertNoHalfWrite(beforeViewer, fixture, 'viewer legacy recovery read');

  const crossedCanvasId = 'canvas-f4-text-recovery-crossed';
  fixture.database.ensureCanvas(crossedCanvasId, {
    name: 'Crossed recovery canvas',
    nodes: [{
      id: 'node-recovery',
      entityUid: RECOVERY_NODE_ENTITY_UID,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { prompt: 'crossed secret' },
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }, fixture.projectId, { initializeResourceScope: false });
  const beforeCrossed = persistenceFingerprint(fixture);
  const crossed = await requestJson(
    recoveryUrl(fixture, 'node', RECOVERY_NODE_ENTITY_UID, 'prompt', crossedCanvasId),
    { headers: { cookie: editor.cookie } },
  );
  assert.equal(crossed.response.status, 404, JSON.stringify(crossed.payload));
  assert.equal(collectStringValues(crossed.payload).some((value) => value.includes('crossed secret')), false);
  assertNoHalfWrite(beforeCrossed, fixture, 'cross-scope legacy recovery read');

  const oldBinding = await getTextBinding(
    fixture,
    editor,
    'node',
    REUSED_OLD_NODE_ENTITY_UID,
    'prompt',
    0,
  );
  fixture.database.saveCollaborativeTextDocument({
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    targetType: 'node',
    targetId: 'node-reused',
    field: 'prompt',
    state: stateBufferFromText(reusedLegacyText),
    updatedBy: 'legacy-writer',
  });
  const document = fixture.database.getCanvas(fixture.canvasId);
  const replacement = clone(document);
  replacement.revision = document.revision + 1;
  replacement.updatedAt = Date.now();
  const reusedNode = replacement.nodes.find((node) => node.id === 'node-reused');
  reusedNode.entityUid = REUSED_NEW_NODE_ENTITY_UID;
  reusedNode.entityRevision = replacement.revision;
  reusedNode.data.prompt = 'stable new text';
  fixture.database.db.transaction(() => {
    fixture.database.db.prepare(`
      UPDATE canvas_documents SET revision = ?, snapshot_json = ?, updated_at = ?
      WHERE project_id = ? AND canvas_id = ?
    `).run(
      replacement.revision,
      JSON.stringify(replacement),
      replacement.updatedAt,
      fixture.projectId,
      fixture.canvasId,
    );
    fixture.database._advanceCanvasResourceGrantState(replacement);
  }).immediate();
  const beforeReused = persistenceFingerprint(fixture);
  const reusedDenied = await requestJson(
    recoveryUrl(fixture, 'node', REUSED_NEW_NODE_ENTITY_UID, 'prompt'),
    { headers: { cookie: editor.cookie } },
  );
  assert.equal(reusedDenied.response.status, 409, JSON.stringify(reusedDenied.payload));
  assert.equal(reusedDenied.payload.code, 'collaboration_text_recovery_unavailable');
  assert.equal(collectStringValues(reusedDenied.payload).some((value) => (
    value.includes(reusedLegacyText) || value.includes(oldBinding.materializedText)
  )), false, 'display-ID reuse exposed an old binding or legacy draft');
  assertNoHalfWrite(beforeReused, fixture, 'display-ID reuse legacy recovery read');
  assert.equal(fixture.database.db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(fixture.database.db.pragma('foreign_key_check'), []);
});
