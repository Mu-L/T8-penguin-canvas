'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createFfmpegProcessQueue,
} = require('../backend/src/utils/ffmpegProcessQueue');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('FFmpeg process queue runs local media processes one at a time in FIFO order', async () => {
  const queue = createFfmpegProcessQueue({ maxConcurrency: 1 });
  const firstGate = deferred();
  const order = [];
  let active = 0;
  let maxActive = 0;

  const runTask = (name, gate = null) => queue.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${name}`);
    if (gate) await gate.promise;
    await Promise.resolve();
    order.push(`end:${name}`);
    active -= 1;
    return name;
  });

  const first = runTask('first', firstGate);
  const second = runTask('second');
  const third = runTask('third');
  await Promise.resolve();

  assert.deepEqual(queue.snapshot(), { active: 1, pending: 2, maxConcurrency: 1 });
  firstGate.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), ['first', 'second', 'third']);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [
    'start:first',
    'end:first',
    'start:second',
    'end:second',
    'start:third',
    'end:third',
  ]);
  assert.deepEqual(queue.snapshot(), { active: 0, pending: 0, maxConcurrency: 1 });
});

test('FFmpeg process queue releases its slot after a failed process', async () => {
  const queue = createFfmpegProcessQueue({ maxConcurrency: 1 });
  const failure = queue.run(async () => {
    throw new Error('native process failed');
  });
  const recovery = queue.run(async () => 'recovered');

  await assert.rejects(failure, /native process failed/);
  assert.equal(await recovery, 'recovered');
  assert.deepEqual(queue.snapshot(), { active: 0, pending: 0, maxConcurrency: 1 });
});

test('FFmpeg process queue does not start a cancelled queued process', async () => {
  const queue = createFfmpegProcessQueue({ maxConcurrency: 1 });
  const gate = deferred();
  let cancelled = false;
  let started = false;
  const first = queue.run(() => gate.promise);
  const queued = queue.run(async () => {
    started = true;
  }, {
    isCancelled: () => cancelled,
  });

  await Promise.resolve();
  cancelled = true;
  gate.resolve();
  await first;
  await assert.rejects(queued, (error) => error?.code === 'FFMPEG_PROCESS_QUEUE_CANCELLED');
  assert.equal(started, false);
  assert.deepEqual(queue.snapshot(), { active: 0, pending: 0, maxConcurrency: 1 });
});
