import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLLABORATION_QUEUE_MAX_BYTES,
  COLLABORATION_QUEUE_MAX_OPERATIONS,
  COLLABORATION_QUEUE_STORAGE_VERSION,
  collaborationQueueBytes,
  collaborationQueueStats,
  collaborationQueueStorageKey,
  enqueueCollaborationOperation,
  firstCollaborationQueueItemForReplay,
  freezeCollaborationQueue,
  loadCollaborationQueue,
  pendingNodeMoveOverrides,
  removeCollaborationQueueItem,
  sameCollaborationQueueScope,
  saveCollaborationQueue,
  updateCollaborationQueueItem,
  validCollaborationQueue,
  validCollaborationQueueScope,
  type CollaborationQueueItem,
  type CollaborationQueueScope,
} from '../src/utils/collaborationOfflineQueue.ts';

function scope(overrides: Partial<CollaborationQueueScope> = {}): CollaborationQueueScope {
  return {
    projectId: 'project-1',
    canvasId: 'canvas-1',
    memberId: 'member-1',
    sessionId: 'session-1',
    role: 'editor',
    authorizationEpoch: 1,
    recoveryGeneration: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

function queueItem(
  id: string,
  nodeId = `node-${id}`,
  overrides: Partial<CollaborationQueueItem> = {},
): CollaborationQueueItem {
  return {
    id,
    operation: {
      opId: id,
      clientSeq: Number(id.match(/\d+/)?.[0] || 1),
      timestamp: 1_700_000_000_000 + Number(id.match(/\d+/)?.[0] || 1),
      type: 'node.move',
      payload: { nodeId, position: { x: 10, y: 20 } },
    },
    baseRevision: null,
    status: 'pending',
    ambiguous: false,
    attempts: 0,
    rebaseAttempts: 0,
    ...overrides,
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const removed: string[] = [];
  return {
    values,
    removed,
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { removed.push(key); values.delete(key); },
  };
}

test('queue scope is strict, epoch-bound, encoded, and collision-resistant', () => {
  const base = scope({ projectId: '项目:1/%', memberId: '成员😀' });
  assert.equal(validCollaborationQueueScope(base), true);
  assert.match(collaborationQueueStorageKey(base), /^t8-collaboration-queue:v3:/);
  assert.match(collaborationQueueStorageKey(base), /%E9%A1%B9%E7%9B%AE%3A1%2F%25/);
  for (const changed of [
    scope({ projectId: 'project-2' }),
    scope({ canvasId: 'canvas-2' }),
    scope({ memberId: 'member-2' }),
    scope({ sessionId: 'session-2' }),
    scope({ role: 'viewer' }),
    scope({ authorizationEpoch: 2 }),
    scope({ recoveryGeneration: '22222222-2222-4222-8222-222222222222' }),
  ]) {
    assert.equal(sameCollaborationQueueScope(scope(), changed), false);
    assert.notEqual(collaborationQueueStorageKey(scope()), collaborationQueueStorageKey(changed));
  }
  for (const invalid of [
    null,
    {},
    scope({ projectId: '' }),
    scope({ sessionId: 'x'.repeat(241) }),
    scope({ role: 'admin' as never }),
    scope({ authorizationEpoch: 0 }),
    scope({ authorizationEpoch: 1.5 }),
    scope({ recoveryGeneration: '' }),
    scope({ recoveryGeneration: '11111111-1111-4111-8111-11111111111Z' }),
    scope({ recoveryGeneration: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }),
  ]) assert.equal(validCollaborationQueueScope(invalid), false);
  assert.throws(() => collaborationQueueStorageKey(scope({ authorizationEpoch: 0 })));
});

test('queue accepts only exact node.move envelopes and finite bounded positions', () => {
  assert.equal(enqueueCollaborationOperation([], queueItem('op-1')).accepted, true);
  const invalidItems: unknown[] = [
    queueItem('', 'node-1'),
    queueItem('x'.repeat(241), 'node-1'),
    queueItem('op-1', ''),
    queueItem('op-1', 'x'.repeat(241)),
    queueItem('op-1', 'node-1', { baseRevision: 0 }),
    queueItem('op-1', 'node-1', { status: 'inflight', baseRevision: null }),
    queueItem('op-1', 'node-1', { ambiguous: true, baseRevision: null }),
    { ...queueItem('op-1'), id: 'different-id' },
    { ...queueItem('op-1'), operation: { ...queueItem('op-1').operation, clientSeq: -1 } },
    { ...queueItem('op-1'), operation: { ...queueItem('op-1').operation, timestamp: 0 } },
    { ...queueItem('op-1'), operation: { ...queueItem('op-1').operation, extra: true } },
    { ...queueItem('op-1'), operation: { ...queueItem('op-1').operation, payload: { nodeId: 'node-1', position: { x: Number.NaN, y: 0 } } } },
    { ...queueItem('op-1'), operation: { ...queueItem('op-1').operation, payload: { nodeId: 'node-1', position: { x: 10_000_001, y: 0 } } } },
    { ...queueItem('op-1'), operation: { ...queueItem('op-1').operation, payload: { nodeId: 'node-1', position: { x: 0, y: 0, z: 1 } } } },
  ];
  for (const invalid of invalidItems) {
    assert.deepEqual(enqueueCollaborationOperation([], invalid as CollaborationQueueItem), {
      queue: [], accepted: false, coalesced: false, reason: 'unsupported',
    });
  }
  for (const type of [
    'node.add', 'node.patch', 'node.delete', 'node.restore',
    'edge.add', 'edge.delete', 'edge.restore', 'viewport.set',
    'presence.update', 'review.comment', 'run.intent', 'subflow.publish', 'asset.upload',
  ]) {
    const item = queueItem(`op-${type}`) as any;
    item.operation.type = type;
    assert.equal(enqueueCollaborationOperation([], item).reason, 'unsupported');
  }
  assert.equal(enqueueCollaborationOperation([], queueItem('min', 'node', {
    operation: {
      ...queueItem('min').operation,
      opId: 'min',
      payload: { nodeId: 'node', position: { x: -10_000_000, y: 10_000_000 } },
    },
  })).accepted, true);
});

test('coalescing is tail-only and never crosses FIFO barriers', () => {
  const first = queueItem('op-1', 'node-a');
  const latest = queueItem('op-2', 'node-a');
  latest.operation.payload.position = { x: 99, y: 100 };
  const coalesced = enqueueCollaborationOperation([first], latest);
  assert.equal(coalesced.accepted, true);
  assert.equal(coalesced.coalesced, true);
  assert.deepEqual(coalesced.queue, [latest]);
  assert.deepEqual(first.operation.payload.position, { x: 10, y: 20 });
  assert.equal(validCollaborationQueue(coalesced.queue), true);

  const interleaved = enqueueCollaborationOperation(
    [first, queueItem('op-2', 'node-b')],
    queueItem('op-3', 'node-a'),
  );
  assert.equal(interleaved.coalesced, false);
  assert.deepEqual(interleaved.queue.map((item) => item.id), ['op-1', 'op-2', 'op-3']);

  const blockedBarrier = enqueueCollaborationOperation(
    [first, queueItem('op-2', 'node-x', { status: 'blocked', baseRevision: 4 })],
    queueItem('op-3', 'node-a'),
  );
  assert.equal(blockedBarrier.coalesced, false);
  assert.deepEqual(blockedBarrier.queue.map((item) => item.id), ['op-1', 'op-2', 'op-3']);

  const ambiguousTail = enqueueCollaborationOperation(
    [queueItem('op-1', 'node-a', { baseRevision: 3, ambiguous: true })],
    queueItem('op-2', 'node-a'),
  );
  assert.equal(ambiguousTail.coalesced, false);
});

test('strict FIFO replay stops at the first blocked or inflight item', () => {
  const pending = queueItem('op-1');
  const blocked = queueItem('op-2', 'node-2', { status: 'blocked', baseRevision: 2 });
  const later = queueItem('op-3');
  assert.equal(firstCollaborationQueueItemForReplay([]), null);
  assert.equal(firstCollaborationQueueItemForReplay([pending, blocked, later])?.id, 'op-1');
  assert.equal(firstCollaborationQueueItemForReplay([blocked, later]), null);
  assert.equal(firstCollaborationQueueItemForReplay([
    queueItem('op-4', 'node-4', { status: 'inflight', baseRevision: 2 }),
    later,
  ]), null);
  assert.deepEqual(removeCollaborationQueueItem([pending, blocked, later], 'op-1'), [blocked, later]);
  assert.equal(firstCollaborationQueueItemForReplay(removeCollaborationQueueItem([pending, blocked, later], 'op-1')), null);
});

test('operation count and UTF-8 byte limits are enforced without mutating the accepted prefix', () => {
  const full = Array.from({ length: COLLABORATION_QUEUE_MAX_OPERATIONS }, (_, index) => (
    queueItem(`op-${index + 1}`, `node-${index + 1}`)
  ));
  assert.equal(validCollaborationQueue(full), true);
  const overflow = enqueueCollaborationOperation(full, queueItem('op-overflow', 'node-overflow'));
  assert.equal(overflow.accepted, false);
  assert.equal(overflow.reason, 'operation_limit');
  assert.equal(overflow.queue, full);

  assert.ok(collaborationQueueBytes([queueItem('ascii', 'a')])
    < collaborationQueueBytes([queueItem('emoji', '😀')]));

  let queue: CollaborationQueueItem[] = [];
  let rejected: ReturnType<typeof enqueueCollaborationOperation> | null = null;
  for (let index = 0; index < COLLABORATION_QUEUE_MAX_OPERATIONS; index += 1) {
    const prefix = `op-${index}-`;
    const item = queueItem(
      `${prefix}${'x'.repeat(240 - prefix.length)}`,
      `node-${index}-${'界'.repeat(110)}`.slice(0, 240),
      { error: 'e'.repeat(1_000) },
    );
    const result = enqueueCollaborationOperation(queue, item);
    if (!result.accepted) {
      rejected = result;
      break;
    }
    queue = result.queue;
  }
  assert.ok(rejected, 'a maximally sized queue should reach its byte limit before 200 items');
  assert.equal(rejected.reason, 'byte_limit');
  assert.ok(collaborationQueueBytes(queue) <= COLLABORATION_QUEUE_MAX_BYTES);
  assert.equal(validCollaborationQueue(queue), true);
});

test('persistence preserves an ambiguous exact retry envelope after an inflight crash', () => {
  const activeScope = scope();
  const key = collaborationQueueStorageKey(activeScope);
  const storage = memoryStorage();
  const inflight = queueItem('op-7', 'node-a', {
    baseRevision: 41,
    status: 'inflight',
    attempts: 1,
  });
  assert.equal(saveCollaborationQueue(storage, key, activeScope, [inflight]), true);
  const restored = loadCollaborationQueue(storage, key, activeScope);
  assert.equal(restored.rejected, 0);
  assert.equal(restored.queue.length, 1);
  assert.equal(restored.queue[0].status, 'pending');
  assert.equal(restored.queue[0].ambiguous, true);
  assert.equal(restored.queue[0].baseRevision, 41);
  assert.deepEqual(restored.queue[0].operation, inflight.operation);
});

test('persistence rejects wrong epochs, malformed state, duplicates, and oversized raw input', () => {
  const activeScope = scope();
  const key = collaborationQueueStorageKey(activeScope);
  const storage = memoryStorage();
  const envelope = (items: unknown[], storedScope: CollaborationQueueScope = activeScope) => JSON.stringify({
    version: COLLABORATION_QUEUE_STORAGE_VERSION,
    scope: storedScope,
    items,
  });

  storage.values.set(key, '{');
  assert.equal(loadCollaborationQueue(storage, key, activeScope).rejected, 1);
  storage.values.set(key, envelope([queueItem('op-1')], scope({ authorizationEpoch: 2 })));
  assert.equal(loadCollaborationQueue(storage, key, activeScope).rejected, 1);
  storage.values.set(key, envelope([queueItem('op-1')], scope({
    recoveryGeneration: '22222222-2222-4222-8222-222222222222',
  })));
  assert.equal(loadCollaborationQueue(storage, key, activeScope).rejected, 1);
  storage.values.set(key, envelope([
    queueItem('op-1'),
    queueItem('op-1'),
  ]));
  assert.deepEqual(loadCollaborationQueue(storage, key, activeScope), {
    queue: [queueItem('op-1')], rejected: 1,
  });
  storage.values.set(key, envelope([
    queueItem('op-2', 'node-2', { ambiguous: true, baseRevision: null }),
  ]));
  assert.deepEqual(loadCollaborationQueue(storage, key, activeScope), { queue: [], rejected: 1 });
  storage.values.set(key, 'x'.repeat(COLLABORATION_QUEUE_MAX_BYTES * 2 + 1));
  assert.deepEqual(loadCollaborationQueue(storage, key, activeScope), { queue: [], rejected: 1 });
  assert.deepEqual(loadCollaborationQueue(storage, 'wrong-key', activeScope), { queue: [], rejected: 1 });
  assert.deepEqual(loadCollaborationQueue(null, key, activeScope), { queue: [], rejected: 0 });
});

test('save, update, freeze, stats, and display overrides preserve queue invariants', () => {
  const activeScope = scope();
  const key = collaborationQueueStorageKey(activeScope);
  const storage = memoryStorage();
  const pending = queueItem('op-1', 'node-a');
  const inflight = queueItem('op-2', 'node-b', { status: 'inflight', baseRevision: 3 });
  assert.equal(saveCollaborationQueue(storage, 'wrong-key', activeScope, [pending]), false);
  assert.equal(saveCollaborationQueue(storage, key, activeScope, [
    queueItem('op-bad', 'node-bad', { ambiguous: true, baseRevision: null }),
  ]), false);
  assert.equal(saveCollaborationQueue(storage, key, activeScope, [pending]), true);
  assert.equal(saveCollaborationQueue(storage, key, activeScope, []), true);
  assert.deepEqual(storage.removed, [key]);

  const unchanged = updateCollaborationQueueItem([pending], 'op-1', {
    status: 'inflight', baseRevision: null,
  });
  assert.deepEqual(unchanged, [pending]);
  const sending = updateCollaborationQueueItem([pending], 'op-1', {
    status: 'inflight', baseRevision: 4, attempts: 1,
  });
  assert.equal(sending[0].status, 'inflight');
  assert.equal(sending[0].baseRevision, 4);

  const frozen = freezeCollaborationQueue([pending, inflight], 'scope changed');
  assert.deepEqual(frozen.map((item) => item.status), ['blocked', 'blocked']);
  assert.equal(frozen[0].ambiguous, false);
  assert.equal(frozen[1].ambiguous, true);
  assert.deepEqual(frozen[1].operation, inflight.operation);
  assert.equal(frozen[1].baseRevision, inflight.baseRevision);

  assert.deepEqual(collaborationQueueStats([pending, inflight]), {
    operations: 2,
    bytes: collaborationQueueBytes([pending, inflight]),
    blocked: 0,
    inflight: 1,
  });
  const overrides = pendingNodeMoveOverrides([
    pending,
    queueItem('op-3', 'node-a', { operation: {
      ...queueItem('op-3').operation,
      opId: 'op-3',
      payload: { nodeId: 'node-a', position: { x: 30, y: 40 } },
    } }),
    queueItem('op-4', 'node-b', { status: 'blocked', baseRevision: 4 }),
  ]);
  assert.deepEqual(overrides.get('node-a'), { x: 30, y: 40 });
  assert.equal(overrides.has('node-b'), false);
  overrides.get('node-a')!.x = 999;
  assert.deepEqual(pending.operation.payload.position, { x: 10, y: 20 });
});
