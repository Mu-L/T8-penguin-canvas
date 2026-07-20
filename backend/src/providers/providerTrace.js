const SECRET_KEY_PATTERN = /(?:^|[-_])(?:api[-_]?key|authorization|cookie|token|secret|password|credential|access[-_]?(?:key|token)|refresh[-_]?token|auth[-_]?token)(?:$|[-_])/i;
const TOKEN_USAGE_KEY_PATTERN = /^(?:total|prompt|completion|input|output|cached|reasoning)[-_]?tokens?(?:[-_]?count)?$/i;
const MAX_TRACE_STRING = 4000;

function boundedString(value, max = 500) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text ? text.slice(0, max) : '';
}

function sanitizeTraceValue(value, depth = 0) {
  if (depth > 6) return '[max depth]';
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    return value.length > MAX_TRACE_STRING ? `${value.slice(0, MAX_TRACE_STRING)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeTraceValue(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, MAX_TRACE_STRING);
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const isSecret = !TOKEN_USAGE_KEY_PATTERN.test(normalizedKey) && SECRET_KEY_PATTERN.test(normalizedKey);
    output[key] = isSecret ? '[redacted]' : sanitizeTraceValue(item, depth + 1);
  }
  return output;
}

function responseHeader(response, names) {
  if (!response?.headers || typeof response.headers.get !== 'function') return '';
  for (const name of names) {
    const value = boundedString(response.headers.get(name));
    if (value) return value;
  }
  return '';
}

function explicitRequestId(raw, response) {
  const candidates = [
    raw?.requestId,
    raw?.request_id,
    raw?.data?.requestId,
    raw?.data?.request_id,
    raw?.meta?.requestId,
    raw?.meta?.request_id,
  ];
  for (const value of candidates) {
    const requestId = boundedString(value);
    if (requestId) return requestId;
  }
  return responseHeader(response, [
    'x-request-id',
    'request-id',
    'x-amzn-requestid',
    'x-amz-request-id',
    'x-tt-logid',
  ]);
}

function explicitUsage(raw) {
  const candidates = [raw?.usage, raw?.data?.usage, raw?.meta?.usage, raw?.response?.usage];
  const usage = candidates.find((value) => value && typeof value === 'object' && !Array.isArray(value));
  return usage ? sanitizeTraceValue(usage) : undefined;
}

function providerTrace(response, raw, options = {}) {
  const status = Number(response?.status);
  const requestId = explicitRequestId(raw, response);
  const usage = explicitUsage(raw);
  const rawPollCount = options.pollCount;
  const pollCount = rawPollCount === undefined
    ? undefined
    : Math.max(0, Math.min(1_000_000, Math.trunc(Number(rawPollCount) || 0)));
  return {
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { upstreamHttpStatus: status } : {}),
    ...(requestId ? { requestId } : {}),
    ...(usage ? { usage } : {}),
    ...(pollCount !== undefined ? { pollCount } : {}),
  };
}

function mergeProviderTrace(...traces) {
  const result = {};
  for (const trace of traces) {
    if (!trace || typeof trace !== 'object') continue;
    if (!result.requestId && boundedString(trace.requestId)) result.requestId = boundedString(trace.requestId);
    const status = Number(trace.upstreamHttpStatus);
    if (Number.isInteger(status) && status >= 100 && status <= 599) result.upstreamHttpStatus = status;
    if (trace.usage && typeof trace.usage === 'object' && !Array.isArray(trace.usage)) result.usage = sanitizeTraceValue(trace.usage);
    if (trace.pollCount !== undefined) {
      result.pollCount = Math.max(Number(result.pollCount) || 0, Math.max(0, Math.trunc(Number(trace.pollCount) || 0)));
    }
  }
  return result;
}

module.exports = {
  explicitRequestId,
  explicitUsage,
  mergeProviderTrace,
  providerTrace,
  sanitizeTraceValue,
};
