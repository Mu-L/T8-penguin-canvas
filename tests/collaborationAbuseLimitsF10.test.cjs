const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyCollaborationWebSocketMessage,
  consumeTieredWindowBudget,
  createTieredBandwidthThrottle,
  createWeightedWindowLimiter,
  retryAfterSeconds,
  sendCollaborationRateLimit,
} = require('../backend/src/collaboration/abuseLimits');

test('F10 weighted limiter is bounded, monotonic, weighted, and exact at reset', () => {
  let now = 1_000;
  const limiter = createWeightedWindowLimiter({ limit: 10, windowMs: 1_000, maxBuckets: 2, now: () => now });
  assert.equal(limiter.consume('a', 4).remaining, 6);
  assert.equal(limiter.consume('a', 6).allowed, true);
  const denied = limiter.consume('a', 1);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 1_000);
  now = 500;
  assert.equal(limiter.consume('a', 1).retryAfterMs, 1_000, 'wall-clock rollback must not reset budget');
  assert.equal(limiter.consume('b', 1).allowed, true);
  assert.equal(limiter.consume('c', 1).reason, 'bucket_capacity');
  now = 2_000;
  assert.equal(limiter.consume('a', 10).allowed, true);
  assert.equal(limiter.consume('a', 11).allowed, false);
  assert.equal(limiter.size <= 2, true);
});

test('F10 tiered limiter rolls back earlier dimensions when a later session budget rejects', () => {
  let now = 0;
  const ip = createWeightedWindowLimiter({ limit: 10, windowMs: 1_000, now: () => now });
  const session = createWeightedWindowLimiter({ limit: 2, windowMs: 1_000, now: () => now });
  const entries = [
    { dimension: 'ip', limiter: ip, key: '203.0.113.1' },
    { dimension: 'session', limiter: session, key: 'session-a' },
  ];
  assert.equal(consumeTieredWindowBudget(entries, 2).allowed, true);
  const denied = consumeTieredWindowBudget(entries, 1);
  assert.equal(denied.allowed, false);
  assert.equal(denied.dimension, 'session');
  assert.equal(ip.consume('203.0.113.1', 8).allowed, true, 'failed tier must not charge shared IP');
  now = 1_000;
  assert.equal(consumeTieredWindowBudget(entries, 1).allowed, true);
});

test('F10 rate-limit response exposes stable Retry-After without raw limiter keys', () => {
  const headers = new Map();
  let response;
  const res = {
    setHeader(name, value) { headers.set(name, value); },
    status(status) { assert.equal(status, 429); return this; },
    json(body) { response = body; return body; },
  };
  sendCollaborationRateLimit(res, { retryAfterMs: 1_001, dimension: 'session' }, {
    code: 'collaboration_download_rate_limited',
  });
  assert.equal(headers.get('Retry-After'), '2');
  assert.equal(headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(response, {
    success: false,
    code: 'collaboration_download_rate_limited',
    error: '请求过于频繁，请稍后再试',
    retryable: true,
    retryAfterSeconds: 2,
    limitDimension: 'session',
  });
  assert.equal(retryAfterSeconds(0), 1);
  assert.equal(retryAfterSeconds(86_400_001), 86_400);
});

test('F10 WebSocket classifier has separate presence, heartbeat, join, and unknown budgets', () => {
  assert.equal(classifyCollaborationWebSocketMessage('presence.update'), 'presence');
  assert.equal(classifyCollaborationWebSocketMessage('awareness.update'), 'presence');
  assert.equal(classifyCollaborationWebSocketMessage('ping'), 'heartbeat');
  assert.equal(classifyCollaborationWebSocketMessage('canvas.join'), 'join');
  assert.equal(classifyCollaborationWebSocketMessage('run.output'), 'unknown');
});

test('F10 tiered bandwidth throttle pauses at the shared byte budget and resumes after reset', async () => {
  let now = 0;
  const ip = createWeightedWindowLimiter({ limit: 4, windowMs: 1_000, now: () => now });
  const session = createWeightedWindowLimiter({ limit: 3, windowMs: 1_000, now: () => now });
  const scheduled = [];
  const throttle = createTieredBandwidthThrottle([
    { dimension: 'ip', limiter: ip, key: '203.0.113.2' },
    { dimension: 'session', limiter: session, key: 'session-b' },
  ], {
    schedule(callback, delay) {
      scheduled.push(delay);
      return setImmediate(() => {
        now += delay;
        callback();
      });
    },
    cancel(timer) { clearImmediate(timer); },
  });
  const chunks = [];
  throttle.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const completed = new Promise((resolve, reject) => {
    throttle.once('end', resolve);
    throttle.once('error', reject);
  });
  throttle.end(Buffer.from('abcdef', 'utf8'));
  await completed;
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'abcdef');
  assert.deepEqual(scheduled, [1_000]);
});

test('F10 bandwidth throttle keeps a slow stream paused until the shared window actually resets', async () => {
  let now = 0;
  const pending = [];
  const limiter = createWeightedWindowLimiter({ limit: 3, windowMs: 1_000, now: () => now });
  const throttle = createTieredBandwidthThrottle([
    { dimension: 'ip', limiter, key: '198.51.100.8' },
  ], {
    schedule(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      pending.push(timer);
      return timer;
    },
    cancel(timer) { timer.cancelled = true; },
  });
  const chunks = [];
  let ended = false;
  throttle.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const completed = new Promise((resolve, reject) => {
    throttle.once('end', () => { ended = true; resolve(); });
    throttle.once('error', reject);
  });
  throttle.end(Buffer.from('abcdef', 'utf8'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'abc');
  assert.equal(ended, false);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].delay, 1_000);
  now = 1_000;
  pending[0].callback();
  await completed;
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'abcdef');
});

test('F10 destroying a throttled client stream cancels its pending bandwidth timer', async () => {
  const pending = [];
  const limiter = createWeightedWindowLimiter({ limit: 2, windowMs: 1_000, now: () => 0 });
  const throttle = createTieredBandwidthThrottle([
    { dimension: 'session', limiter, key: 'disconnecting-session' },
  ], {
    schedule(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      pending.push(timer);
      return timer;
    },
    cancel(timer) { timer.cancelled = true; },
  });
  throttle.on('data', () => {});
  throttle.write(Buffer.from('abcdef', 'utf8'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 1);
  throttle.destroy();
  await new Promise((resolve) => throttle.once('close', resolve));
  assert.equal(pending[0].cancelled, true);
});
