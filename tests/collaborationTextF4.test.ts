import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLLABORATION_TEXT_BINDING_CONTRACT,
  COLLABORATION_TEXT_UPDATE_CONTRACT,
  CollaborationTextClient,
  CollaborationTextProtocolError,
  normalizeCollaborationTextUpdateEnvelope,
  type CollaborationTextClientOptions,
  type CollaborationTextUpdateEnvelope,
} from '../src/utils/collaborationText.ts';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CANVAS_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';
const BINDING_EPOCH = '44444444-4444-4444-8444-444444444444';
const OTHER_EPOCH = '55555555-5555-4555-8555-555555555555';

function updateIdFactory(seed: number) {
  let current = seed;
  return () => {
    const suffix = current.toString(16).padStart(12, '0');
    current += 1;
    return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
  };
}

function client(
  seed: number,
  overrides: Partial<CollaborationTextClientOptions> = {},
) {
  return new CollaborationTextClient({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    baseRevision: 7,
    targetType: 'node',
    targetEntityUid: TARGET_ID,
    bindingEpoch: BINDING_EPOCH,
    field: 'prompt',
    online: true,
    createUpdateId: updateIdFactory(seed),
    ...overrides,
  });
}

test('two Y.Text clients merge concurrent prompt edits and materialize the same value', () => {
  const alice = client(1);
  const bob = client(100);
  try {
    alice.insertText(0, '甲');
    bob.insertText(0, '乙');
    const aliceUpdate = alice.flush();
    const bobUpdate = bob.flush();
    assert.ok(aliceUpdate);
    assert.ok(bobUpdate);

    assert.equal(alice.applyRemoteEnvelope(bobUpdate).status, 'applied');
    assert.equal(bob.applyRemoteEnvelope(aliceUpdate).status, 'applied');
    assert.equal(alice.materializedText, bob.materializedText);
    assert.equal(alice.materializedText.length, 2);
    assert.deepEqual(new Set(alice.materializedText), new Set(['甲', '乙']));
  } finally {
    alice.dispose();
    bob.dispose();
  }
});

test('Y.UndoManager tracks only the local origin and never rolls back a remote edit', () => {
  const alice = client(2);
  const bob = client(200);
  try {
    alice.insertText(0, 'A');
    const addA = alice.flush();
    assert.ok(addA);
    bob.applyRemoteEnvelope(addA);

    bob.insertText(bob.materializedText.length, 'B');
    const addB = bob.flush();
    assert.ok(addB);
    alice.applyRemoteEnvelope(addB);
    assert.equal(alice.materializedText, 'AB');
    assert.equal(bob.materializedText, 'AB');

    assert.equal(alice.undo(), true);
    assert.equal(alice.materializedText, 'B', 'Alice undo must retain Bob remote insertion');
    const undoA = alice.flush();
    assert.ok(undoA);
    bob.applyRemoteEnvelope(undoA);
    assert.equal(bob.materializedText, 'B');

    assert.equal(bob.undo(), true);
    assert.equal(bob.materializedText, '', 'Bob undo removes only Bob local insertion');
  } finally {
    alice.dispose();
    bob.dispose();
  }
});

test('100ms buffer merges local increments into one strict envelope and deduplicates its echo', async () => {
  let resolveFlush!: (value: CollaborationTextUpdateEnvelope) => void;
  const flushed = new Promise<CollaborationTextUpdateEnvelope>((resolve) => { resolveFlush = resolve; });
  const sender = client(3, {
    flushDelayMs: 100,
    initialClientSeq: 41,
    onFlush: (envelope) => resolveFlush(envelope),
  });
  const receiver = client(300);
  try {
    sender.replaceText('p');
    sender.replaceText('pro');
    sender.replaceText('prompt');
    assert.equal(sender.pendingUpdateCount, 3);

    const envelope = await Promise.race([
      flushed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('flush timeout')), 1000)),
    ]);
    assert.equal(sender.pendingUpdateCount, 0);
    assert.equal(envelope.clientSeq, 41);
    assert.deepEqual(Object.keys(envelope).sort(), [
      'baseRevision',
      'bindingEpoch',
      'canvasId',
      'clientSeq',
      'contractVersion',
      'field',
      'projectId',
      'targetEntityUid',
      'targetType',
      'update',
      'updateId',
    ]);
    assert.equal(normalizeCollaborationTextUpdateEnvelope(envelope).update, envelope.update);
    assert.equal(receiver.applyRemoteEnvelope(envelope).status, 'applied');
    assert.equal(receiver.materializedText, 'prompt');
    assert.equal(receiver.applyRemoteEnvelope(envelope).status, 'duplicate');
    assert.equal(sender.applyRemoteEnvelope(envelope).status, 'duplicate', 'server echo of a local update is ignored');
  } finally {
    sender.dispose();
    receiver.dispose();
  }
});

test('deleted, new binding epoch and old schema conflicts expose copy-or-discard memory recovery', () => {
  const deleted = client(4, { now: () => 12345 });
  deleted.replaceText('未提交的提示词');
  const deletedRecovery = deleted.registerAuthorityError({ code: 'collaboration_text_target_deleted' });
  assert.equal(deletedRecovery?.reason, 'target_deleted');
  assert.equal(deletedRecovery?.hadUnflushedChanges, true);
  assert.equal(deleted.copyRecoveryText(), '未提交的提示词');
  assert.throws(() => deleted.flush(), (error: unknown) => (
    error instanceof CollaborationTextProtocolError && error.code === 'collaboration_text_conflicted'
  ));
  assert.equal(deleted.discardRecovery(), true);
  assert.equal(deleted.copyRecoveryText(), null);

  const stale = client(5);
  const remote = client(500, { bindingEpoch: OTHER_EPOCH });
  try {
    stale.replaceText('旧对象上的本地正文');
    remote.replaceText('恢复后的新对象');
    const nextEpochUpdate = remote.flush();
    assert.ok(nextEpochUpdate);
    const epochResult = stale.applyRemoteEnvelope(nextEpochUpdate);
    assert.equal(epochResult.status, 'conflict');
    assert.equal(epochResult.recovery?.reason, 'binding_epoch_mismatch');
    assert.equal(epochResult.recovery?.receivedBindingEpoch, OTHER_EPOCH);
    assert.equal(stale.copyRecoveryText(), '旧对象上的本地正文');
  } finally {
    stale.dispose();
    remote.dispose();
  }

  const oldSchema = client(6);
  try {
    oldSchema.replaceText('可复制恢复的评论');
    const result = oldSchema.applyRemoteEnvelope({ contractVersion: 't8-collaboration-text-update-v0' });
    assert.equal(result.status, 'conflict');
    assert.equal(result.recovery?.reason, 'schema_mismatch');
    assert.equal(oldSchema.copyRecoveryText(), '可复制恢复的评论');
  } finally {
    oldSchema.dispose();
  }

  const staleRevision = client(601);
  try {
    staleRevision.replaceText('保留并发冲突时的本地正文');
    const recovery = staleRevision.registerAuthorityError({ code: 'collaboration_text_revision_conflict' });
    assert.equal(recovery?.reason, 'revision_conflict');
    assert.equal(staleRevision.copyRecoveryText(), '保留并发冲突时的本地正文');
  } finally {
    staleRevision.dispose();
  }
});

test('strict contracts bind title, prompt and review body to their allowed target schemas', () => {
  const nodePrompt = client(7);
  const canvasTitle = client(8, {
    targetType: 'canvas',
    targetEntityUid: CANVAS_ID,
    field: 'title',
  });
  const reviewBody = client(9, {
    targetType: 'review',
    targetEntityUid: '66666666-6666-4666-8666-666666666666',
    field: 'body',
  });
  try {
    nodePrompt.replaceText('prompt');
    canvasTitle.replaceText('title');
    reviewBody.replaceText('comment');
    const promptEnvelope = nodePrompt.flush();
    const titleEnvelope = canvasTitle.flush();
    const commentEnvelope = reviewBody.flush();
    assert.equal(promptEnvelope?.field, 'prompt');
    assert.equal(titleEnvelope?.field, 'title');
    assert.equal(commentEnvelope?.field, 'body');
    assert.equal(commentEnvelope?.targetType, 'review');

    assert.throws(() => client(10, { targetType: 'node', field: 'body' }), (error: unknown) => (
      error instanceof CollaborationTextProtocolError && error.code === 'collaboration_text_field_forbidden'
    ));
    assert.throws(() => normalizeCollaborationTextUpdateEnvelope({
      ...promptEnvelope,
      unexpected: true,
    }), (error: unknown) => (
      error instanceof CollaborationTextProtocolError && error.code === 'collaboration_text_envelope_invalid'
    ));

    const snapshot = {
      contractVersion: COLLABORATION_TEXT_BINDING_CONTRACT,
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      revision: 7,
      targetType: 'node',
      targetEntityUid: TARGET_ID,
      bindingEpoch: BINDING_EPOCH,
      field: 'prompt',
      state: nodePrompt.encodedState,
      stateVector: nodePrompt.encodedStateVector,
      materializedText: 'prompt',
    };
    const hydrated = CollaborationTextClient.fromBindingSnapshot(snapshot, {
      online: true,
      createUpdateId: updateIdFactory(700),
    });
    try {
      assert.equal(hydrated.materializedText, 'prompt');
      assert.equal(hydrated.canUndo, false, 'authoritative hydration is never local undo history');
    } finally {
      hydrated.dispose();
    }
    assert.equal(COLLABORATION_TEXT_UPDATE_CONTRACT, 't8-collaboration-text-update-v1');
  } finally {
    nodePrompt.dispose();
    canvasTitle.dispose();
    reviewBody.dispose();
  }
});

test('client remains strictly memory-only and never touches Web Storage or IndexedDB', () => {
  const names = ['localStorage', 'sessionStorage', 'indexedDB'] as const;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let accesses = 0;
  for (const name of names) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        accesses += 1;
        throw new Error(`${name} must not be accessed`);
      },
    });
  }

  const local = client(11);
  const remote = client(1100);
  try {
    local.replaceText('memory only');
    const update = local.flush();
    assert.ok(update);
    remote.applyRemoteEnvelope(update);
    remote.registerConflict('target_deleted');
    assert.equal(remote.copyRecoveryText(), 'memory only');
    remote.discardRecovery();
    const offline = client(1200, { online: false });
    try {
      assert.throws(() => offline.replaceText('must not queue'), (error: unknown) => (
        error instanceof CollaborationTextProtocolError && error.code === 'collaboration_text_offline_forbidden'
      ));
      offline.setOnline(true);
      offline.replaceText('copy before disconnect');
      const recovery = offline.setOnline(false);
      assert.equal(recovery?.reason, 'offline_forbidden');
      assert.equal(offline.pendingUpdateCount, 0);
      assert.equal(offline.copyRecoveryText(), 'copy before disconnect');
    } finally {
      offline.dispose();
    }
    assert.equal(accesses, 0);
  } finally {
    local.dispose();
    remote.dispose();
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});

test('text bindings keep legacy project/canvas lookup scopes while requiring UUID entity lifecycles', () => {
  const scoped = client(11, { projectId: 'project-f4-legacy', canvasId: 'canvas-f4-legacy' });
  try {
    scoped.replaceText('legacy scope');
    const envelope = scoped.flush();
    assert.equal(envelope?.projectId, 'project-f4-legacy');
    assert.equal(envelope?.canvasId, 'canvas-f4-legacy');
    assert.equal(envelope?.targetEntityUid, TARGET_ID);
    assert.equal(normalizeCollaborationTextUpdateEnvelope(envelope).projectId, 'project-f4-legacy');
  } finally {
    scoped.dispose();
  }
  assert.throws(() => client(12, { projectId: 'project\nunsafe' }), (error: unknown) => (
    error instanceof CollaborationTextProtocolError && error.code === 'collaboration_text_identity_invalid'
  ));
});
