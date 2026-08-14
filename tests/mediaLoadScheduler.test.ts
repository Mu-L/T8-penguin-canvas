import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaLoadQueue, MEDIA_LOAD_CONCURRENCY } from '../src/utils/mediaLoadScheduler.ts';

test('image, video, and audio queues keep the fixed startup resource budgets', () => {
  assert.deepEqual(MEDIA_LOAD_CONCURRENCY, { image: 4, video: 1, audio: 1 });
  for (const [kind, limit] of Object.entries(MEDIA_LOAD_CONCURRENCY)) {
    const queue = createMediaLoadQueue(limit);
    const releases: Array<() => void> = [];
    for (let index = 0; index < limit + 2; index += 1) {
      queue.schedule((release) => releases.push(release));
    }
    assert.equal(queue.activeCount, limit, kind + ' active loads stay within budget');
    assert.equal(queue.queuedCount, 2, kind + ' queues overflow work');
    while (releases.length > 0) releases.shift()?.();
    assert.equal(queue.activeCount, 0);
    assert.equal(queue.queuedCount, 0);
  }
});

test('media queue never exceeds its configured concurrency', () => {
  const queue = createMediaLoadQueue(2);
  const started: string[] = [];
  const releases = new Map<string, () => void>();

  for (const id of ['a', 'b', 'c', 'd']) {
    queue.schedule((release) => {
      started.push(id);
      releases.set(id, release);
    });
  }

  assert.deepEqual(started, ['a', 'b']);
  assert.equal(queue.activeCount, 2);
  assert.equal(queue.queuedCount, 2);

  releases.get('a')?.();
  assert.deepEqual(started, ['a', 'b', 'c']);
  assert.equal(queue.activeCount, 2);
  assert.equal(queue.queuedCount, 1);

  releases.get('b')?.();
  releases.get('c')?.();
  releases.get('d')?.();
  assert.equal(queue.activeCount, 0);
  assert.equal(queue.queuedCount, 0);
});

test('media queue cancellation frees active slots and skips cancelled work', () => {
  const queue = createMediaLoadQueue(1);
  const started: string[] = [];
  let releaseActive: (() => void) | null = null;

  const active = queue.schedule((release) => {
    started.push('active');
    releaseActive = release;
  });
  const cancelled = queue.schedule(() => {
    started.push('cancelled');
  });
  queue.schedule((release) => {
    started.push('priority');
    release();
  }, true);

  cancelled.cancel();
  assert.equal(queue.queuedCount, 1);
  active.cancel();

  assert.deepEqual(started, ['active', 'priority']);
  assert.equal(queue.activeCount, 0);
  assert.equal(queue.queuedCount, 0);

  releaseActive?.();
  assert.equal(queue.activeCount, 0);
});
