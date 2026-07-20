const assert = require('node:assert/strict');
const test = require('node:test');
const Y = require('yjs');

const {
  COLLABORATION_TEXT_BINDING_CONTRACT,
  COLLABORATION_TEXT_UPDATE_CONTRACT,
  MAX_TEXT_UPDATE_BYTES,
  CollaborationTextAuthorityError,
  authorizeCollaborationTextUpdate,
  digestCollaborationTextEnvelope,
} = require('../backend/src/services/collaborationTextAuthority');

const UUIDS = Object.freeze({
  project: '00000000-0000-4000-8000-000000000001',
  canvas: '00000000-0000-4000-8000-000000000002',
  canvasEntity: '00000000-0000-4000-8000-000000000003',
  node: '10000000-0000-4000-8000-000000000001',
  nodeDisplay: 'node-display-a',
  review: '20000000-0000-4000-8000-000000000001',
  epochA: '30000000-0000-4000-8000-000000000001',
  epochB: '30000000-0000-4000-8000-000000000002',
  aliceUpdate: '40000000-0000-4000-8000-000000000001',
  bobUpdate: '40000000-0000-4000-8000-000000000002',
  extraUpdate: '40000000-0000-4000-8000-000000000003',
});

function yState(text = '') {
  const document = new Y.Doc();
  if (text) document.getText('content').insert(0, text);
  else document.getText('content');
  const state = Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64');
  document.destroy();
  return state;
}

function yUpdate(state, mutate) {
  const document = new Y.Doc();
  if (state) Y.applyUpdate(document, Buffer.from(state, 'base64'));
  const before = Y.encodeStateVector(document);
  mutate(document);
  const update = Buffer.from(Y.encodeStateAsUpdate(document, before)).toString('base64');
  document.destroy();
  return update;
}

function textUpdate(state, value, index = 0) {
  return yUpdate(state, (document) => document.getText('content').insert(index, value));
}

function principal(overrides = {}) {
  return {
    memberId: 'member-alice',
    sessionId: 'session-alice',
    role: 'editor',
    capabilities: ['editGraph', 'comment'],
    projectId: UUIDS.project,
    canvasId: UUIDS.canvas,
    ...overrides,
  };
}

function documentFixture(overrides = {}) {
  return {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: UUIDS.project,
    canvasId: UUIDS.canvas,
    entityUid: UUIDS.canvasEntity,
    revision: 10,
    nodes: [{
      id: UUIDS.nodeDisplay,
      entityUid: UUIDS.node,
      type: 'text',
      data: { prompt: '', title: '' },
    }],
    edges: [],
    subflowInstances: [],
    tombstones: { nodes: {}, edges: {} },
    ...overrides,
  };
}

function bindingFixture(overrides = {}) {
  return {
    contractVersion: COLLABORATION_TEXT_BINDING_CONTRACT,
    projectId: UUIDS.project,
    canvasId: UUIDS.canvas,
    targetType: 'node',
    targetEntityUid: UUIDS.node,
    bindingEpoch: UUIDS.epochA,
    field: 'prompt',
    lifecycle: 'active',
    createdRevision: 10,
    revision: 10,
    state: yState(),
    materializedText: '',
    ...overrides,
  };
}

function authorityFixture(overrides = {}) {
  return {
    document: documentFixture(),
    principal: principal(),
    transport: { online: true, mode: 'online', queued: false },
    binding: bindingFixture(),
    lastClientSeq: 0,
    idempotencyRecord: null,
    now: 1_750_000_000_000,
    ...overrides,
  };
}

function envelopeFixture(update, overrides = {}) {
  return {
    contractVersion: COLLABORATION_TEXT_UPDATE_CONTRACT,
    updateId: UUIDS.aliceUpdate,
    clientSeq: 1,
    projectId: UUIDS.project,
    canvasId: UUIDS.canvas,
    baseRevision: 10,
    targetType: 'node',
    targetEntityUid: UUIDS.node,
    bindingEpoch: UUIDS.epochA,
    field: 'prompt',
    update,
    ...overrides,
  };
}

function errorCode(action) {
  try {
    action();
    return null;
  } catch (error) {
    assert.ok(error instanceof CollaborationTextAuthorityError, String(error?.stack || error));
    return error.code;
  }
}

function setPath(root, path, value) {
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!current[path[index]] || typeof current[path[index]] !== 'object') current[path[index]] = {};
    current = current[path[index]];
  }
  current[path[path.length - 1]] = value;
}

function commitPlan(authority, plan) {
  authority.document.revision = plan.result.revision;
  const materialization = plan.writes.find((write) => write.kind === 'canvas.materialized-text.update');
  const target = authority.document.nodes.find((node) => node.entityUid === plan.result.targetEntityUid);
  if (target) setPath(target, materialization.path, materialization.value);
  authority.binding = plan.bindingRecord;
  authority.lastClientSeq = plan.operation.clientSeq;
}

test('F4 authority merges concurrent Y.Text updates and emits one atomic materialization/operation/audit plan', () => {
  const authority = authorityFixture();
  const initialState = authority.binding.state;
  const aliceEnvelope = envelopeFixture(textUpdate(initialState, '甲'));
  const alice = authorizeCollaborationTextUpdate(aliceEnvelope, authority);

  assert.equal(alice.atomic, true);
  assert.equal(alice.duplicate, false);
  assert.equal(alice.result.text, '甲');
  assert.equal(alice.result.revision, 11);
  assert.equal(alice.operation.type, 'text.update');
  assert.equal(alice.operation.baseRevision, 10);
  assert.equal(alice.audit.metadata.updateBytes > 0, true);
  assert.equal(Object.hasOwn(alice.audit.metadata, 'text'), false);
  assert.deepEqual(alice.writes.map((write) => write.kind), [
    'collaboration.text.document.upsert',
    'canvas.materialized-text.update',
    'canvas.document.revision.cas',
    'canvas.operation.insert',
    'collaboration.text.idempotency.insert',
    'collaboration.client-sequence.cas',
    'audit.event.insert',
  ]);
  assert.deepEqual(
    alice.preconditions.find((item) => item.kind === 'text.binding.equals'),
    {
      kind: 'text.binding.equals',
      targetType: 'node',
      targetEntityUid: UUIDS.node,
      field: 'prompt',
      bindingEpoch: UUIDS.epochA,
      stateDigest: alice.preconditions.find((item) => item.kind === 'text.binding.equals').stateDigest,
      revision: 10,
    },
  );

  commitPlan(authority, alice);
  authority.principal = principal({ memberId: 'member-bob', sessionId: 'session-bob' });
  authority.lastClientSeq = 0;
  const bobEnvelope = envelopeFixture(textUpdate(initialState, '乙'), {
    updateId: UUIDS.bobUpdate,
    clientSeq: 1,
  });
  const bob = authorizeCollaborationTextUpdate(bobEnvelope, authority);
  assert.equal(bob.result.revision, 12);
  assert.equal(bob.result.text.length, 2);
  assert.deepEqual(new Set(bob.result.text), new Set(['甲', '乙']));
  assert.equal(bob.operation.baseRevision, 10, 'CRDT update keeps the client base while commit CAS uses current revision');
  assert.deepEqual(
    bob.preconditions.find((item) => item.kind === 'canvas.revision.equals'),
    { kind: 'canvas.revision.equals', revision: 11 },
  );

  const verification = new Y.Doc();
  Y.applyUpdate(verification, Buffer.from(bob.result.state, 'base64'));
  assert.equal(verification.getText('content').toString(), bob.result.text);
  verification.destroy();
});

test('F4 exact unknown-result retry returns the original result without reapplying, while collisions fail closed', () => {
  const authority = authorityFixture();
  const initialState = authority.binding.state;
  const envelope = envelopeFixture(textUpdate(initialState, 'exactly-once'));
  const first = authorizeCollaborationTextUpdate(envelope, authority);

  const retryAuthority = authorityFixture({
    document: documentFixture({
      revision: 12,
      nodes: [],
      tombstones: { nodes: { [UUIDS.nodeDisplay]: { entityUid: UUIDS.node, deletedAt: 1 } }, edges: {} },
    }),
    lastClientSeq: 1,
    idempotencyRecord: first.idempotencyRecord,
  });
  const retry = authorizeCollaborationTextUpdate(structuredClone(envelope), retryAuthority);
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.result, first.result);
  assert.deepEqual(retry.writes, []);
  assert.equal(retry.operation, null);
  assert.equal(retry.audit, null);

  const changed = { ...envelope, update: textUpdate(initialState, 'changed') };
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(changed, retryAuthority)),
    'collaboration_text_idempotency_collision',
  );
  const otherActor = { ...retryAuthority, principal: principal({ memberId: 'member-eve', sessionId: 'session-eve' }) };
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelope, otherActor)),
    'collaboration_text_idempotency_collision',
  );
});

test('F4 update decoding rejects non-canonical, oversized, malformed, rich-text, and extra-root Yjs payloads', () => {
  const authority = authorityFixture();
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelopeFixture('not base64'), authority)),
    'collaboration_text_update_invalid',
  );
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(
      envelopeFixture(Buffer.alloc(MAX_TEXT_UPDATE_BYTES + 1).toString('base64')),
      authority,
    )),
    'collaboration_text_update_too_large',
  );
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(
      envelopeFixture(Buffer.from('not-a-yjs-update').toString('base64')),
      authority,
    )),
    'collaboration_text_update_invalid',
  );

  const rich = yUpdate(authority.binding.state, (document) => {
    document.getText('content').insert(0, 'bold', { bold: true });
  });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelopeFixture(rich), authority)),
    'collaboration_text_update_invalid',
  );

  const extraRoot = yUpdate(authority.binding.state, (document) => {
    document.getMap('unexpected').set('secret', 'hidden');
  });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelopeFixture(extraRoot), authority)),
    'collaboration_text_update_invalid',
  );

  const titleAuthority = authorityFixture({
    binding: bindingFixture({ field: 'title' }),
  });
  const titleEnvelope = envelopeFixture(textUpdate(titleAuthority.binding.state, 'x'.repeat(513)), { field: 'title' });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(titleEnvelope, titleAuthority)),
    'collaboration_text_materialized_too_large',
  );
});

test('F4 delete/edit races fail closed and restored ABA targets require a fresh binding epoch', () => {
  const initialState = yState();
  const update = textUpdate(initialState, 'old edit');
  const deleted = authorityFixture({
    document: documentFixture({
      nodes: [],
      tombstones: { nodes: { [UUIDS.nodeDisplay]: { entityUid: UUIDS.node, deletedAt: 1 } }, edges: {} },
    }),
  });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelopeFixture(update), deleted)),
    'collaboration_text_target_deleted',
  );

  const restored = authorityFixture({
    document: documentFixture({ revision: 12 }),
    binding: bindingFixture({
      bindingEpoch: UUIDS.epochB,
      createdRevision: 12,
      revision: 12,
      state: yState(),
      materializedText: '',
    }),
  });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelopeFixture(update), restored)),
    'collaboration_text_binding_epoch_mismatch',
  );

  const freshUpdate = textUpdate(restored.binding.state, 'new edit');
  const fresh = authorizeCollaborationTextUpdate(envelopeFixture(freshUpdate, {
    updateId: UUIDS.extraUpdate,
    baseRevision: 12,
    bindingEpoch: UUIDS.epochB,
  }), restored);
  assert.equal(fresh.result.text, 'new edit');
  assert.equal(fresh.result.bindingEpoch, UUIDS.epochB);
  assert.equal(fresh.result.text.includes('old edit'), false);
});

test('F4 field whitelist, capabilities, scope, online-only mode, schema, revision, and client sequence are authoritative', () => {
  const base = authorityFixture();
  const update = textUpdate(base.binding.state, 'allowed');
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelopeFixture(update, { field: 'apiKey' }), base)),
    'collaboration_text_field_forbidden',
  );

  const reviewer = authorityFixture({
    principal: principal({ role: 'reviewer', capabilities: ['comment'] }),
  });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelopeFixture(update), reviewer)),
    'collaboration_text_permission_denied',
  );
  const viewer = authorityFixture({
    principal: principal({ role: 'viewer', capabilities: [] }),
  });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelopeFixture(update), viewer)),
    'collaboration_text_permission_denied',
  );

  const offline = authorityFixture({ transport: { online: false, mode: 'offline', queued: true } });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelopeFixture(update), offline)),
    'collaboration_text_offline_forbidden',
  );
  const oldSchema = authorityFixture({ document: documentFixture({ schemaVersion: 1 }) });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelopeFixture(update), oldSchema)),
    'collaboration_text_schema_mismatch',
  );
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelopeFixture(update, { baseRevision: 11 }), base)),
    'collaboration_text_revision_conflict',
  );
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelopeFixture(update, { projectId: UUIDS.canvasEntity }), base)),
    'collaboration_text_scope_mismatch',
  );
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelopeFixture(update, { clientSeq: 2 }), base)),
    'collaboration_text_client_seq_conflict',
  );

  const extra = { ...envelopeFixture(update), offline: false };
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(extra, base)),
    'collaboration_text_envelope_invalid',
  );
  const unsafe = envelopeFixture(update);
  Object.setPrototypeOf(unsafe, { inherited: true });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(unsafe, base)),
    'collaboration_text_unsafe_envelope',
  );
});

test('F4 review body updates are author-only even with comment capability, with exact author retry preserved', () => {
  const initialState = yState('原评论');
  const reviewTarget = {
    id: 'comment-display-a',
    entityUid: UUIDS.review,
    projectId: UUIDS.project,
    canvasId: UUIDS.canvas,
    body: '原评论',
    createdBy: 'member-author',
  };
  const binding = bindingFixture({
    targetType: 'review',
    targetEntityUid: UUIDS.review,
    field: 'body',
    state: initialState,
    materializedText: '原评论',
  });
  const envelope = envelopeFixture(textUpdate(initialState, ' + 复核', 3), {
    targetType: 'review',
    targetEntityUid: UUIDS.review,
    field: 'body',
  });
  const author = authorityFixture({
    principal: principal({ memberId: 'member-author', role: 'reviewer', capabilities: ['comment', 'approve'] }),
    reviewComments: [reviewTarget],
    binding,
  });
  const accepted = authorizeCollaborationTextUpdate(envelope, author);
  assert.equal(accepted.result.text, '原评论 + 复核');
  assert.deepEqual(
    accepted.writes.find((write) => write.kind === 'canvas.materialized-text.update').path,
    ['body'],
  );

  const exactRetry = authorizeCollaborationTextUpdate(structuredClone(envelope), {
    ...author,
    lastClientSeq: 1,
    idempotencyRecord: accepted.idempotencyRecord,
  });
  assert.equal(exactRetry.duplicate, true);
  assert.deepEqual(exactRetry.result, accepted.result);

  const nonAuthorReviewer = {
    ...author,
    principal: principal({ memberId: 'member-reviewer', role: 'reviewer', capabilities: ['comment', 'approve'] }),
  };
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelope, nonAuthorReviewer)),
    'collaboration_text_permission_denied',
  );
  const nonAuthorOwner = {
    ...author,
    principal: principal({
      memberId: 'member-owner',
      role: 'owner',
      capabilities: ['comment', 'approve', 'editGraph'],
    }),
  };
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelope, nonAuthorOwner)),
    'collaboration_text_permission_denied',
    'owner role does not imply hidden review-body moderation',
  );

  const editorWithoutComment = {
    ...author,
    principal: principal({ memberId: 'member-author', role: 'editor', capabilities: ['editGraph'] }),
  };
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelope, editorWithoutComment)),
    'collaboration_text_permission_denied',
  );
});

test('F4 rejects state/materialization divergence and proves accepted state round-trips to the exact materialized field', () => {
  const inconsistent = authorityFixture({
    binding: bindingFixture({ state: yState('权威状态'), materializedText: '权威状态' }),
  });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(
      envelopeFixture(textUpdate(inconsistent.binding.state, '!')),
      inconsistent,
    )),
    'collaboration_text_materialization_mismatch',
  );

  const consistent = authorityFixture();
  const envelope = envelopeFixture(textUpdate(consistent.binding.state, 'materialized'));
  const plan = authorizeCollaborationTextUpdate(envelope, consistent);
  const write = plan.writes.find((item) => item.kind === 'canvas.materialized-text.update');
  assert.equal(write.value, plan.result.text);
  assert.equal(plan.bindingRecord.materializedText, plan.result.text);
  assert.equal(plan.operation.payload.textDigest, plan.result.textDigest);
  const roundtrip = new Y.Doc();
  Y.applyUpdate(roundtrip, Buffer.from(plan.bindingRecord.state, 'base64'));
  assert.equal(roundtrip.getText('content').toString(), write.value);
  roundtrip.destroy();
});

test('F4 target identity, binding lifecycle, and authoritative Yjs state corruption all fail closed', () => {
  const emptyState = yState();
  const envelope = envelopeFixture(textUpdate(emptyState, 'guarded'));
  const missing = authorityFixture({ document: documentFixture({ nodes: [] }) });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelope, missing)),
    'collaboration_text_target_missing',
  );

  const duplicateNode = documentFixture().nodes[0];
  const ambiguous = authorityFixture({
    document: documentFixture({ nodes: [duplicateNode, { ...duplicateNode, id: 'duplicate-display-id' }] }),
  });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelope, ambiguous)),
    'collaboration_text_target_ambiguous',
  );

  const deletedBinding = authorityFixture({ binding: bindingFixture({ lifecycle: 'deleted' }) });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelope, deletedBinding)),
    'collaboration_text_target_deleted',
  );

  const corruptState = authorityFixture({
    binding: bindingFixture({ state: Buffer.from('corrupt-yjs-state').toString('base64') }),
  });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelope, corruptState)),
    'collaboration_text_state_invalid',
  );

  const crossedBinding = authorityFixture({
    binding: bindingFixture({ targetEntityUid: UUIDS.review }),
  });
  assert.equal(
    errorCode(() => authorizeCollaborationTextUpdate(envelope, crossedBinding)),
    'collaboration_text_binding_invalid',
  );
});

test('F4 canonical request digest ignores object insertion order but binds every envelope value', () => {
  const state = yState();
  const original = envelopeFixture(textUpdate(state, 'digest'));
  const reversed = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(digestCollaborationTextEnvelope(original), digestCollaborationTextEnvelope(reversed));
  assert.notEqual(
    digestCollaborationTextEnvelope(original),
    digestCollaborationTextEnvelope({ ...original, clientSeq: original.clientSeq + 1 }),
  );
});

test('F4 text scope accepts bounded legacy project/canvas IDs while entity and binding identities stay UUIDs', () => {
  const projectId = 'project-f4-legacy';
  const canvasId = 'canvas-f4-legacy';
  const state = yState();
  const authority = authorityFixture({
    document: documentFixture({ projectId, canvasId }),
    principal: principal({ projectId, canvasId }),
    binding: bindingFixture({ projectId, canvasId, state, materializedText: '' }),
  });
  const envelope = envelopeFixture(textUpdate(state, 'legacy-scope'), { projectId, canvasId });
  const accepted = authorizeCollaborationTextUpdate(envelope, authority);
  assert.equal(accepted.result.projectId, projectId);
  assert.equal(accepted.result.canvasId, canvasId);
  assert.equal(accepted.result.targetEntityUid, UUIDS.node);
  assert.equal(errorCode(() => authorizeCollaborationTextUpdate({
    ...envelope,
    projectId: 'project\nunsafe',
  }, authority)), 'collaboration_text_envelope_invalid');
});
