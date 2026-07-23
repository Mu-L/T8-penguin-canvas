'use strict';

const DEFAULT_MAX_CONCURRENCY = 1;
const MAX_CONFIGURED_CONCURRENCY = 4;

function cancelledError() {
  const error = new Error('任务已取消');
  error.code = 'FFMPEG_PROCESS_QUEUE_CANCELLED';
  return error;
}

function normalizeConcurrency(value, fallback = DEFAULT_MAX_CONCURRENCY) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_CONFIGURED_CONCURRENCY, parsed));
}

function createFfmpegProcessQueue(options = {}) {
  const maxConcurrency = normalizeConcurrency(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
  const pending = [];
  let active = 0;
  let nextTicket = 1;

  function snapshot() {
    return {
      active,
      pending: pending.length,
      maxConcurrency,
    };
  }

  function drain() {
    while (active < maxConcurrency && pending.length > 0) {
      const entry = pending.shift();
      if (entry.isCancelled?.()) {
        entry.reject(cancelledError());
        continue;
      }
      active += 1;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
        queueMicrotask(drain);
      });
    }
  }

  function acquire(acquireOptions = {}) {
    const isCancelled = typeof acquireOptions.isCancelled === 'function'
      ? acquireOptions.isCancelled
      : null;
    if (isCancelled?.()) return Promise.reject(cancelledError());
    return new Promise((resolve, reject) => {
      pending.push({
        ticket: nextTicket,
        isCancelled,
        resolve,
        reject,
      });
      nextTicket += 1;
      drain();
    });
  }

  async function run(task, runOptions = {}) {
    if (typeof task !== 'function') throw new TypeError('FFmpeg 队列任务必须是函数');
    const release = await acquire(runOptions);
    try {
      if (runOptions.isCancelled?.()) throw cancelledError();
      return await task();
    } finally {
      release();
    }
  }

  return Object.freeze({
    acquire,
    run,
    snapshot,
  });
}

const sharedFfmpegProcessQueue = createFfmpegProcessQueue({
  maxConcurrency: process.env.T8_FFMPEG_MAX_CONCURRENCY || DEFAULT_MAX_CONCURRENCY,
});

module.exports = {
  DEFAULT_MAX_CONCURRENCY,
  createFfmpegProcessQueue,
  acquireFfmpegProcessSlot: (options) => sharedFfmpegProcessQueue.acquire(options),
  withFfmpegProcessSlot: (task, options) => sharedFfmpegProcessQueue.run(task, options),
  getFfmpegProcessQueueSnapshot: () => sharedFfmpegProcessQueue.snapshot(),
};
