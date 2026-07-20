const crypto = require('crypto');
const { Transform } = require('stream');

const RATE_LIMIT_RECEIPT = Symbol('t8-collaboration-rate-limit-receipt');

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function normalizedBudgetKey(value) {
  const normalized = String(value || 'unknown');
  if (normalized.length <= 160) return normalized;
  return `sha256:${crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

function retryAfterSeconds(value) {
  return Math.max(1, Math.min(86_400, Math.ceil(Number(value || 1) / 1000)));
}

function createWeightedWindowLimiter({
  limit,
  windowMs,
  maxBuckets = 4096,
  now = Date.now,
} = {}) {
  const budget = boundedInteger(limit, 1, 1, Number.MAX_SAFE_INTEGER);
  const duration = boundedInteger(windowMs, 60_000, 1, 24 * 60 * 60 * 1000);
  const capacity = boundedInteger(maxBuckets, 4096, 1, 1_000_000);
  const buckets = new Map();
  let lastTimestamp = 0;
  let nextSweepAt = 0;

  const timestamp = () => {
    const observed = Math.trunc(Number(now()));
    if (!Number.isFinite(observed)) return lastTimestamp;
    lastTimestamp = Math.max(lastTimestamp, observed);
    return lastTimestamp;
  };

  const prune = (at = timestamp()) => {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key);
    }
    nextSweepAt = at + Math.min(duration, 60_000);
    return buckets.size;
  };

  const consume = (rawKey, rawUnits = 1) => {
    const units = boundedInteger(rawUnits, 1, 1, Number.MAX_SAFE_INTEGER);
    const key = normalizedBudgetKey(rawKey);
    const at = timestamp();
    if (at >= nextSweepAt || buckets.size >= capacity) prune(at);
    let bucket = buckets.get(key);
    if (bucket && bucket.resetAt <= at) {
      buckets.delete(key);
      bucket = null;
    }
    if (!bucket && buckets.size >= capacity) {
      return Object.freeze({
        allowed: false,
        reason: 'bucket_capacity',
        retryAfterMs: duration,
        retryAfterSeconds: retryAfterSeconds(duration),
        limit: budget,
        used: 0,
        remaining: 0,
      });
    }
    if (!bucket) {
      bucket = { used: 0, resetAt: at + duration };
      buckets.set(key, bucket);
    }
    if (units > budget || bucket.used > budget - units) {
      return Object.freeze({
        allowed: false,
        reason: 'rate_exceeded',
        retryAfterMs: Math.max(1, bucket.resetAt - at),
        retryAfterSeconds: retryAfterSeconds(bucket.resetAt - at),
        limit: budget,
        used: bucket.used,
        remaining: Math.max(0, budget - bucket.used),
      });
    }
    const previousUsed = bucket.used;
    bucket.used += units;
    return Object.freeze({
      allowed: true,
      reason: null,
      retryAfterMs: Math.max(1, bucket.resetAt - at),
      retryAfterSeconds: retryAfterSeconds(bucket.resetAt - at),
      limit: budget,
      used: bucket.used,
      remaining: Math.max(0, budget - bucket.used),
      [RATE_LIMIT_RECEIPT]: Object.freeze({ key, resetAt: bucket.resetAt, previousUsed, units }),
    });
  };

  const refund = (result) => {
    const receipt = result?.[RATE_LIMIT_RECEIPT];
    if (!receipt) return false;
    const bucket = buckets.get(receipt.key);
    if (!bucket || bucket.resetAt !== receipt.resetAt
      || bucket.used !== receipt.previousUsed + receipt.units) return false;
    bucket.used = receipt.previousUsed;
    if (bucket.used === 0) buckets.delete(receipt.key);
    return true;
  };

  return Object.freeze({
    consume,
    prune,
    refund,
    limit: budget,
    windowMs: duration,
    get size() { return buckets.size; },
  });
}

function consumeTieredWindowBudget(entries, units = 1) {
  if (!Array.isArray(entries) || entries.length < 1) {
    throw new TypeError('tiered rate limit requires at least one limiter');
  }
  const consumed = [];
  for (const entry of entries) {
    if (!entry?.limiter || typeof entry.limiter.consume !== 'function'
      || typeof entry.limiter.refund !== 'function') {
      throw new TypeError('tiered rate limit entry is invalid');
    }
    const result = entry.limiter.consume(entry.key, units);
    if (!result.allowed) {
      for (let index = consumed.length - 1; index >= 0; index -= 1) {
        consumed[index].entry.limiter.refund(consumed[index].result);
      }
      return Object.freeze({
        ...result,
        dimension: String(entry.dimension || 'unknown'),
      });
    }
    consumed.push({ entry, result });
  }
  return Object.freeze({
    allowed: true,
    reason: null,
    retryAfterMs: Math.max(...consumed.map(({ result }) => result.retryAfterMs)),
    retryAfterSeconds: Math.max(...consumed.map(({ result }) => result.retryAfterSeconds)),
    remaining: Math.min(...consumed.map(({ result }) => result.remaining)),
    dimension: null,
  });
}

function sendCollaborationRateLimit(res, result, {
  code = 'collaboration_rate_limited',
  message = '请求过于频繁，请稍后再试',
} = {}) {
  const seconds = retryAfterSeconds(result?.retryAfterMs);
  res.setHeader('Retry-After', String(seconds));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(429).json({
    success: false,
    code,
    error: message,
    retryable: true,
    retryAfterSeconds: seconds,
    limitDimension: result?.dimension || null,
  });
}

function classifyCollaborationWebSocketMessage(value) {
  const type = String(value || '');
  if (type === 'presence.update' || type === 'awareness.update') return 'presence';
  if (type === 'ping') return 'heartbeat';
  if (type === 'canvas.join') return 'join';
  return 'unknown';
}

class TieredBandwidthThrottle extends Transform {
  constructor(entries, options = {}) {
    super(options.streamOptions);
    if (!Array.isArray(entries) || entries.length < 1) {
      throw new TypeError('bandwidth throttle requires at least one limiter');
    }
    this.entries = entries;
    this.schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
    this.cancel = options.cancel || ((timer) => clearTimeout(timer));
    this.timer = null;
    const smallestBudget = Math.max(
      1,
      Math.min(...entries.map((entry) => Number(entry?.limiter?.limit) || 1)),
    );
    this.maximumSegmentBytes = boundedInteger(
      options.maximumSegmentBytes,
      Math.min(64 * 1024, smallestBudget),
      1,
      smallestBudget,
    );
  }

  _transform(chunk, encoding, callback) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    let offset = 0;
    const advance = () => {
      if (this.destroyed) return;
      while (offset < buffer.length) {
        const end = Math.min(buffer.length, offset + this.maximumSegmentBytes);
        const segment = buffer.subarray(offset, end);
        const result = consumeTieredWindowBudget(this.entries, segment.length);
        if (result.allowed) {
          offset = end;
          this.push(segment);
          continue;
        }
        this.timer = this.schedule(() => {
          this.timer = null;
          advance();
        }, Math.max(1, result.retryAfterMs));
        return;
      }
      callback();
    };
    advance();
  }

  _destroy(error, callback) {
    if (this.timer != null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    callback(error);
  }
}

function createTieredBandwidthThrottle(entries, options) {
  return new TieredBandwidthThrottle(entries, options);
}

module.exports = {
  classifyCollaborationWebSocketMessage,
  consumeTieredWindowBudget,
  createTieredBandwidthThrottle,
  createWeightedWindowLimiter,
  retryAfterSeconds,
  sendCollaborationRateLimit,
};
