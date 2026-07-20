const SECRET_KEY_PATTERN = /(?:^|[-_])(?:api[-_]?key|authorization|cookie|token|secret|password|credential|access[-_]?(?:key|token)|refresh[-_]?token|auth[-_]?token)(?:$|[-_])/i;
const TOKEN_USAGE_KEY_PATTERN = /^(?:total|prompt|completion|input|output|cached|reasoning)[-_]?tokens?(?:[-_]?count)?$/i;
const SIGNED_QUERY_PATTERN = /(?:signature|sig|token|key|credential|expires)=/i;
const MAX_STRING_LENGTH = 4000;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 200;
const INLINE_API_KEY_PATTERN = /\b(?:sk|rk|pk)-(?:proj-)?[a-z0-9_-]{16,}\b/ig;
const INLINE_AUTHORIZATION_PATTERN = /(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/ig;
const INLINE_COOKIE_PATTERN = /(cookie\s*[:=]\s*)[^\r\n]+/ig;

function redactInlineSecrets(value) {
  return String(value)
    .replace(INLINE_AUTHORIZATION_PATTERN, '$1[redacted]')
    .replace(INLINE_COOKIE_PATTERN, '$1[redacted]')
    .replace(INLINE_API_KEY_PATTERN, '[redacted api key]');
}

function redactString(value) {
  const text = redactInlineSecrets(value);
  if (/^data:[^;,]+;base64,/i.test(text)) return `[base64 omitted: ${text.length} chars]`;
  if (/^bearer\s+/i.test(text)) return '[redacted bearer token]';
  try {
    const url = new URL(text);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY_PATTERN.test(key) || SIGNED_QUERY_PATTERN.test(`${key}=`)) url.searchParams.set(key, '[redacted]');
    }
    const sanitized = url.toString();
    return sanitized.length > MAX_STRING_LENGTH ? `${sanitized.slice(0, MAX_STRING_LENGTH)}…` : sanitized;
  } catch (_) {
    return text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}…` : text;
  }
}

function scanRunValueForSecrets(value, path = '$', depth = 0, seen = new WeakSet()) {
  if (depth > MAX_DEPTH) return [];
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return [];
  if (typeof value === 'string') {
    const findings = [];
    if (/^data:[^;,]+;base64,/i.test(value)) findings.push(`${path}:base64`);
    const authorizationValue = value.match(/authorization\s*[:=]\s*([^\r\n]+)/i)?.[1]?.trim() || '';
    const cookieValue = value.match(/cookie\s*[:=]\s*([^\r\n]+)/i)?.[1]?.trim() || '';
    if (/^bearer\s+/i.test(value) || (authorizationValue && !/^\[redacted\]/i.test(authorizationValue))) findings.push(`${path}:authorization`);
    if (cookieValue && !/^\[redacted\]/i.test(cookieValue)) findings.push(`${path}:cookie`);
    if (/\b(?:sk|rk|pk)-(?:proj-)?[a-z0-9_-]{16,}\b/i.test(value)) findings.push(`${path}:api-key`);
    try {
      const url = new URL(value);
      for (const key of url.searchParams.keys()) {
        const parameter = String(url.searchParams.get(key) || '');
        if ((SECRET_KEY_PATTERN.test(key) || SIGNED_QUERY_PATTERN.test(`${key}=`)) && !/^\[redacted\]$/i.test(parameter)) {
          findings.push(`${path}:signed-url:${key}`);
        }
      }
    } catch (_) {
      // Plain strings are covered by the inline patterns above.
    }
    return [...new Set(findings)];
  }
  if (Buffer.isBuffer(value)) return [`${path}:buffer`];
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).flatMap((item, index) => scanRunValueForSecrets(item, `${path}[${index}]`, depth + 1, seen));
  }
  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const findings = [];
  for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    if (isRunSecretKey(key) && item !== '[redacted]') findings.push(`${path}.${key}:secret-field`);
    findings.push(...scanRunValueForSecrets(item, `${path}.${key}`, depth + 1, seen));
  }
  seen.delete(value);
  return [...new Set(findings)];
}

function redactAndScanRunValue(value) {
  const redacted = redactRunValue(value);
  const findings = scanRunValueForSecrets(redacted);
  if (findings.length) {
    const error = new Error(`运行记录敏感信息扫描未通过：${findings.slice(0, 5).join(', ')}`);
    error.code = 'run_secret_scan_failed';
    error.findings = findings.slice(0, 50);
    throw error;
  }
  return redacted;
}

function isRunSecretKey(key) {
  const normalized = String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return !TOKEN_USAGE_KEY_PATTERN.test(normalized) && SECRET_KEY_PATTERN.test(normalized);
}

function redactRunValue(value, depth = 0, seen = new WeakSet()) {
  if (depth > MAX_DEPTH) return '[max depth]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactString(value);
  if (Buffer.isBuffer(value)) return `[buffer omitted: ${value.length} bytes]`;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactRunValue(item, depth + 1, seen));
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    output[key] = isRunSecretKey(key) ? '[redacted]' : redactRunValue(item, depth + 1, seen);
  }
  seen.delete(value);
  return output;
}

module.exports = {
  SECRET_KEY_PATTERN,
  isRunSecretKey,
  redactAndScanRunValue,
  redactInlineSecrets,
  redactRunValue,
  scanRunValueForSecrets,
};
