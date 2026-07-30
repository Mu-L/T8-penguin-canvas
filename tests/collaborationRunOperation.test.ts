import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginCollaborationRunOperation,
  collaborationRunOperationStorageKey,
  completeCollaborationRunOperation,
  readCollaborationRunOperation,
} from '../src/utils/collaborationRunOperation.ts';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() { return this.values.size; }

  clear() { this.values.clear(); }

  getItem(key: string) { return this.values.get(key) ?? null; }

  key(index: number) { return [...this.values.keys()][index] ?? null; }

  removeItem(key: string) { this.values.delete(key); }

  setItem(key: string, value: string) { this.values.set(key, value); }
}

const scope = {
  projectId: 'project-local',
  canvasId: 'canvas-a',
  memberId: 'member-a',
};

test('collaboration run operation persists exact identity before transport and survives refresh', () => {
  const storage = new MemoryStorage();
  const first = beginCollaborationRunOperation(
    storage,
    scope,
    42,
    ['node-b', 'node-a', 'node-a'],
    { now: 1_000, randomUUID: () => 'stable-operation-0001' },
  );

  assert.equal(first.idempotencyKey, 'remote:stable-operation-0001');
  assert.deepEqual(first.nodeIds, ['node-a', 'node-b']);
  assert.deepEqual(
    readCollaborationRunOperation(storage, scope, 1_001),
    first,
    'a new page instance must recover the exact pre-submit operation',
  );

  const replay = beginCollaborationRunOperation(
    storage,
    scope,
    42,
    ['node-a', 'node-b'],
    { now: 1_002, randomUUID: () => 'must-not-be-used' },
  );
  assert.equal(replay.idempotencyKey, first.idempotencyKey);
  assert.equal(replay.createdAt, first.createdAt);
});

test('collaboration run operation only clears the matching acknowledged identity', () => {
  const storage = new MemoryStorage();
  const now = Date.now();
  const operation = beginCollaborationRunOperation(
    storage,
    scope,
    7,
    [],
    { now, randomUUID: () => 'stable-operation-0002' },
  );

  completeCollaborationRunOperation(storage, scope, 'remote:different-operation');
  assert.ok(readCollaborationRunOperation(storage, scope, now + 1));

  completeCollaborationRunOperation(storage, scope, operation.idempotencyKey);
  assert.equal(readCollaborationRunOperation(storage, scope, now + 2), null);
});

test('new payload replaces a pending operation instead of reusing the wrong identity', () => {
  const storage = new MemoryStorage();
  const first = beginCollaborationRunOperation(
    storage,
    scope,
    8,
    ['node-a'],
    { now: 3_000, randomUUID: () => 'stable-operation-0003' },
  );
  const next = beginCollaborationRunOperation(
    storage,
    scope,
    9,
    ['node-a'],
    { now: 3_001, randomUUID: () => 'stable-operation-0004' },
  );

  assert.notEqual(next.idempotencyKey, first.idempotencyKey);
  assert.equal(readCollaborationRunOperation(storage, scope, 3_002)?.idempotencyKey, next.idempotencyKey);
});

test('expired or tampered collaboration run operations fail closed and are removed', () => {
  const storage = new MemoryStorage();
  const key = collaborationRunOperationStorageKey(scope);
  storage.setItem(key, JSON.stringify({
    schema: 't8-collaboration-run-operation-v1',
    ...scope,
    canvasRevision: 1,
    nodeIds: ['node-a'],
    idempotencyKey: 'remote:stable-operation-0005',
    createdAt: 4_000,
  }));
  assert.equal(
    readCollaborationRunOperation(storage, scope, 4_000 + 24 * 60 * 60 * 1_000 + 1),
    null,
  );
  assert.equal(storage.getItem(key), null);

  storage.setItem(key, '{"schema":"t8-collaboration-run-operation-v1","memberId":"other"}');
  assert.equal(readCollaborationRunOperation(storage, scope, 5_000), null);
  assert.equal(storage.getItem(key), null);
});

test('rapid duplicate clicks reuse one durable collaboration run identity', () => {
  const storage = new MemoryStorage();
  const identities = Array.from({ length: 25 }, (_, index) => beginCollaborationRunOperation(
    storage,
    scope,
    12,
    index % 2 === 0 ? ['node-b', 'node-a'] : ['node-a', 'node-b'],
    { now: 6_000 + index, randomUUID: () => `unexpected-${index}` },
  ).idempotencyKey);

  assert.equal(new Set(identities).size, 1);
  assert.equal(identities[0], 'remote:unexpected-0');
});

test('an acknowledgement for an older operation cannot clear a replacement operation', () => {
  const storage = new MemoryStorage();
  const now = Date.now();
  const first = beginCollaborationRunOperation(
    storage,
    scope,
    13,
    ['node-a'],
    { now, randomUUID: () => 'stable-operation-old' },
  );
  const replacement = beginCollaborationRunOperation(
    storage,
    scope,
    14,
    ['node-a'],
    { now: now + 1, randomUUID: () => 'stable-operation-new' },
  );

  completeCollaborationRunOperation(storage, scope, first.idempotencyKey);
  assert.equal(
    readCollaborationRunOperation(storage, scope, now + 2)?.idempotencyKey,
    replacement.idempotencyKey,
  );
});

test('member scopes keep independent pending identities', () => {
  const storage = new MemoryStorage();
  const memberA = beginCollaborationRunOperation(
    storage,
    scope,
    15,
    [],
    { now: 8_000, randomUUID: () => 'member-a-operation' },
  );
  const otherScope = { ...scope, memberId: 'member-b' };
  const memberB = beginCollaborationRunOperation(
    storage,
    otherScope,
    15,
    [],
    { now: 8_001, randomUUID: () => 'member-b-operation' },
  );

  assert.notEqual(memberA.idempotencyKey, memberB.idempotencyKey);
  assert.equal(readCollaborationRunOperation(storage, scope, 8_002)?.idempotencyKey, memberA.idempotencyKey);
  assert.equal(readCollaborationRunOperation(storage, otherScope, 8_002)?.idempotencyKey, memberB.idempotencyKey);
});

test('storage write failure prevents transport identity from being treated as durable', () => {
  const storage = {
    getItem: () => null,
    removeItem: () => undefined,
    setItem: () => {
      throw new Error('quota exceeded');
    },
  };

  assert.throws(
    () => beginCollaborationRunOperation(
      storage,
      scope,
      16,
      [],
      { now: 9_000, randomUUID: () => 'must-not-submit' },
    ),
    /quota exceeded/,
  );
});
