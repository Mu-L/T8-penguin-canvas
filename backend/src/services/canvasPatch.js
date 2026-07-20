const crypto = require('crypto');

const {
  applyCanvasOperation,
  normalizeCanvasDocument,
} = require('../collaboration/protocol');
const {
  containsLocalPath,
  redactLocalPaths,
} = require('./assetPublicView');

const CANVAS_PATCH_CONTRACT = 't8-canvas-patch-v1';
const CANVAS_PATCH_OPERATION_LIMIT = 100;
const CANVAS_PATCH_JSON_LIMIT = 512 * 1024;
const CANVAS_PATCH_AFFECTED_LIMIT = 500;
const CANVAS_PATCH_INTERNAL_PLAN_LIMIT = 2 * 1024 * 1024;
const CANVAS_PATCH_OPERATION_TYPES = Object.freeze([
  'node.add',
  'node.patch',
  'node.move',
  'node.delete',
  'node.restore',
  'edge.add',
  'edge.delete',
  'edge.restore',
  'viewport.set',
]);
const CANVAS_PATCH_OPERATION_TYPE_SET = new Set(CANVAS_PATCH_OPERATION_TYPES);
const CANVAS_PATCH_AUTHORITY_SOURCES = Object.freeze([
  'local-owner',
  'collaboration',
  'agent',
]);
const CANVAS_PATCH_AUTHORITY_SOURCE_SET = new Set(CANVAS_PATCH_AUTHORITY_SOURCES);
const PROTECTED_NODE_KEYS = new Set(['id', 'entityUid', 'type', 'position']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_KEY_PATTERN = /(?:token|api.?key|authorization|authentication|cookie|password|passwd|passphrase|credential|secret|signature|private.?key|access.?key|session)/i;
const SECRET_TEXT_PATTERN = /(?:\bBearer\s+[^\s,;"'`<>]+|\bsk-[A-Za-z0-9_-]{8,}\b|\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b|data:[^;,\s]+;base64,)/i;
const HOST_CREDENTIAL_FIELD_EXACT = new Set([
  'apikey', 'apitoken', 'auth', 'authentication', 'authorization', 'bearer',
  'clientsecret', 'cookie', 'cookies', 'credential', 'credentials', 'key',
  'password', 'passwd', 'passphrase', 'privatekey', 'pwd', 'secret', 'secretkey',
  'sessionid', 'sessionkey', 'sessiontoken', 'signature', 'token', 'tokens',
]);
const NON_CREDENTIAL_TOKEN_FIELD_PATTERN = /^(?:(?:max|min|input|output|prompt|completion|total|used|remaining|estimated|cached|reasoning)tokens?(?:count|limit|budget|usage)?|token(?:count|limit|budget|usage|estimate|length|window))$/;
const MAX_CANVAS_COORDINATE = 10_000_000;
const MAX_CANVAS_ZOOM = 64;

function defineError(error, code, status, details = {}) {
  error.code = code;
  error.status = status;
  Object.assign(error, details);
  return error;
}

class CanvasPatchValidationError extends Error {
  constructor(message = 'CanvasPatch 请求无效', details = {}) {
    super(message);
    this.name = 'CanvasPatchValidationError';
    defineError(this, 'canvas_patch_invalid', 400, details);
  }
}

class CanvasPatchConflictError extends Error {
  constructor(message = 'CanvasPatch 与当前画布状态冲突', details = {}) {
    super(message);
    this.name = 'CanvasPatchConflictError';
    defineError(this, details.code || 'canvas_patch_conflict', 409, details);
  }
}

class CanvasPatchConfirmationError extends Error {
  constructor(message = 'CanvasPatch 必须使用匹配预览并显式确认') {
    super(message);
    this.name = 'CanvasPatchConfirmationError';
    defineError(this, 'canvas_patch_confirmation_required', 400);
  }
}

class CanvasPatchPermissionError extends Error {
  constructor(message = '无权访问此 CanvasPatch', details = {}) {
    super(message);
    this.name = 'CanvasPatchPermissionError';
    defineError(this, details.code || 'canvas_patch_forbidden', 403, details);
  }
}

class CanvasPatchNotFoundError extends Error {
  constructor(message = 'CanvasPatch 不存在') {
    super(message);
    this.name = 'CanvasPatchNotFoundError';
    defineError(this, 'canvas_patch_not_found', 404);
  }
}

class CanvasPatchRevertConflictError extends Error {
  constructor(conflicts = [], currentRevision = null) {
    super('CanvasPatch 触及的字段或实体已被后续修改，无法安全撤销');
    this.name = 'CanvasPatchRevertConflictError';
    defineError(this, 'canvas_patch_revert_conflict', 409, {
      conflicts: Array.isArray(conflicts) ? conflicts.slice(0, 100) : [],
      currentRevision,
    });
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function compareText(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function decodeCredentialFieldText(value) {
  let decoded = String(value || '').normalize('NFKC');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const before = decoded;
    decoded = decoded
      .replace(/%u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_match, hex) => {
        const codePoint = Number.parseInt(hex, 16);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
      })
      .replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\x([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/&#x([0-9a-f]{1,6});?/gi, (_match, hex) => {
        const codePoint = Number.parseInt(hex, 16);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
      })
      .replace(/&#([0-9]{1,7});?/g, (_match, digits) => {
        const codePoint = Number.parseInt(digits, 10);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
      });
    try {
      decoded = decodeURIComponent(decoded);
    } catch (_) {}
    decoded = decoded.normalize('NFKC');
    if (decoded === before) break;
  }
  return decoded;
}

function credentialFieldCandidates(value) {
  const decoded = decodeCredentialFieldText(value);
  const candidates = [decoded];
  const compact = decoded.replace(/[\s._:-]+/g, '');
  if (/^(?:[0-9a-f]{2}){3,80}$/i.test(compact)) {
    try {
      const text = Buffer.from(compact, 'hex').toString('utf8');
      if (/^[\p{L}\p{N}\s._:%+\\{}&#-]{1,160}$/u.test(text)) candidates.push(decodeCredentialFieldText(text));
    } catch (_) {}
  }
  if (/^[A-Za-z0-9+/_-]{8,216}={0,2}$/.test(compact) && compact.length % 4 !== 1) {
    try {
      const text = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/^[\p{L}\p{N}\s._:%+\\{}&#-]{1,160}$/u.test(text)) candidates.push(decodeCredentialFieldText(text));
    } catch (_) {}
  }
  return [...new Set(candidates)];
}

function canonicalCredentialField(value) {
  return decodeCredentialFieldText(value)
    .replace(/[\u0000-\u001f\u007f\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .toLowerCase()
    // Common visual confusables used to disguise ASCII credential field names.
    .replace(/[\u0430\u03b1\u0251]/g, 'a')
    .replace(/[\u0435\u03b5]/g, 'e')
    .replace(/[\u0456\u03b9]/g, 'i')
    .replace(/[\u043a\u03ba]/g, 'k')
    .replace(/[\u043e\u03bf]/g, 'o')
    .replace(/[\u0440\u03c1]/g, 'p')
    .replace(/[\u0441\u03f2]/g, 'c')
    .replace(/[\u0442\u03c4]/g, 't')
    .replace(/[\u0443\u03c5]/g, 'y')
    .replace(/[^a-z0-9\u3400-\u9fff]/g, '');
}

function isHostCredentialFieldKey(value) {
  return credentialFieldCandidates(value).some((candidate) => {
    if (/(?:密钥|秘钥|令牌|口令|密码|凭据|授权|签名|会话令牌)/u.test(candidate)) return true;
    const canonical = canonicalCredentialField(candidate);
    if (!canonical) return false;
    if (HOST_CREDENTIAL_FIELD_EXACT.has(canonical)) return true;
    if (/(?:apikey|apiaccesskey|accesskey|privatekey|secretkey|clientsecret|credential|password|passwd|passphrase|authorization|authentication|cookie|signature)/.test(canonical)) {
      return true;
    }
    if (NON_CREDENTIAL_TOKEN_FIELD_PATTERN.test(canonical)) return false;
    if (/tokens?$/.test(canonical)) return true;
    if (/(?:^|(?:api|auth|oauth|jwt|bearer|access|refresh|session|client|provider|csrf|id))token(?:s|value|secret|key)?$/.test(canonical)) {
      return true;
    }
    if (/(?:api|auth|access|secret|private|client|encryption|signing|provider)key(?:id|value|secret)?$/.test(canonical)) {
      return true;
    }
    return /(?:^|(?:auth|access|refresh|session|bearer|provider))token$/.test(canonical);
  });
}

function isStructuredCredentialContainerKey(value) {
  const canonical = canonicalCredentialField(value);
  return /(?:config|settings|headers?|params?|query|environment|env|options|request|body|payload|workflow|provider)(?:json)?$/.test(canonical);
}

function structuredStringContainsHostCredentialField(value, depth, state) {
  const decoded = decodeCredentialFieldText(value).trim();
  if (!decoded || decoded.length > CANVAS_PATCH_JSON_LIMIT) return false;
  if (decoded.startsWith('{') || decoded.startsWith('[')) {
    try {
      return valueContainsHostCredentialField(JSON.parse(decoded), depth + 1, state, '');
    } catch (_) {}
  }
  const assignments = decoded.matchAll(/(?:^|[{,&;\r\n])\s*["']?([^"':=,&{}\r\n]{1,160})["']?\s*[:=]/g);
  for (const match of assignments) {
    if (isHostCredentialFieldKey(match[1])) return true;
  }
  return false;
}

function valueContainsHostCredentialField(value, depth = 0, state = null, parentKey = '') {
  const context = state || { nodes: 0 };
  context.nodes += 1;
  if (context.nodes > 10_000 || depth > 16) return true;
  if (Array.isArray(value)) {
    return value.some((item) => {
      if (isStructuredCredentialContainerKey(parentKey)
        && Array.isArray(item) && typeof item[0] === 'string' && isHostCredentialFieldKey(item[0])) return true;
      return valueContainsHostCredentialField(item, depth + 1, context, parentKey);
    });
  }
  if (typeof value === 'string' && isStructuredCredentialContainerKey(parentKey)) {
    return structuredStringContainsHostCredentialField(value, depth, context);
  }
  if (!isRecord(value)) return false;
  return Object.keys(value).some((key) => (
    isHostCredentialFieldKey(key)
    || valueContainsHostCredentialField(value[key], depth + 1, context, key)
  ));
}

function canvasPatchTouchesHostCredentials(patch) {
  return (Array.isArray(patch?.operations) ? patch.operations : []).some((operation) => {
    if (operation?.type === 'node.add' || operation?.type === 'node.restore') {
      return valueContainsHostCredentialField(operation?.payload?.node);
    }
    if (operation?.type !== 'node.patch') return false;
    if (valueContainsHostCredentialField(operation?.payload?.dataPatch)) return true;
    return (Array.isArray(operation?.payload?.dataUnsetKeys) ? operation.payload.dataUnsetKeys : [])
      .some((key) => isHostCredentialFieldKey(key));
  });
}

function normalizeCanvasPatchAuthority(context = {}) {
  const explicit = isRecord(context.authority);
  const input = explicit ? context.authority : {};
  const sourceValue = explicit ? input.source : context.source;
  const source = CANVAS_PATCH_AUTHORITY_SOURCE_SET.has(String(sourceValue)) ? String(sourceValue) : 'unknown';
  const role = String(input.role || (source === 'local-owner' ? 'owner' : '')).trim().toLowerCase();
  const capabilities = new Set(Array.isArray(input.capabilities) ? input.capabilities.map(String) : []);
  let canManageHostCredentials = source === 'local-owner' && role === 'owner';
  if (source === 'collaboration') {
    canManageHostCredentials = role === 'owner' && capabilities.has('manageProviders');
  }
  if (source === 'agent') canManageHostCredentials = false;
  if (input.canManageHostCredentials === false) canManageHostCredentials = false;
  return { source, role, canManageHostCredentials };
}

function assertCanvasPatchCredentialAuthority(patch, context = {}) {
  const authority = normalizeCanvasPatchAuthority(context);
  if (!canvasPatchTouchesHostCredentials(patch) || authority.canManageHostCredentials) return authority;
  throw new CanvasPatchPermissionError('此来源不能通过 CanvasPatch 修改主机凭据', {
    code: 'canvas_patch_host_credentials_forbidden',
  });
}

function isSensitivePatchKey(value) {
  const raw = String(value || '').trim().toLowerCase();
  const segments = raw.split(/[^a-z0-9]+/).filter(Boolean);
  const normalized = raw.replace(/[^a-z0-9]/g, '');
  if (!normalized) return false;
  if (segments.some((segment) => ['auth', 'key', 'accesskey', 'accesskeyid', 'session', 'sessionid'].includes(segment))) return true;
  if (normalized.endsWith('auth')) return true;
  return SENSITIVE_KEY_PATTERN.test(normalized);
}

function redactSecretText(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s,;"'`<>]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/gi, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[redacted]')
    .replace(/(["']?\b(?:auth|authorization|access[_-]?(?:key|token)|refresh[_-]?token|id[_-]?token|token|session(?:[_-]?(?:id|token))?|api[_-]?key|credential|password|secret|signature)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"'`<>]+)/gi, '$1[redacted]');
}

function redactBinaryDataUrls(value) {
  const text = String(value);
  const match = /data:[^;,\s]+;base64,/i.exec(text);
  if (!match) return text;
  // Patch summaries and errors never need to expose inline binary payloads. Dropping
  // the suffix also covers whitespace-folded and deliberately fragmented base64.
  return `${text.slice(0, match.index)}[binary]`;
}

function redactEncodedUnsafeContent(value, preservePublicUrl = false) {
  return String(value).replace(/[^\s"'`<>]+/g, (token) => {
    let candidate = token;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const decoded = decodeURIComponent(candidate);
        if (decoded === candidate) break;
        candidate = decoded;
      } catch (_) {
        break;
      }
    }
    if (candidate === token) return token;
    if (redactBinaryDataUrls(candidate) !== candidate) return '[binary]';
    if (redactSecretText(candidate) !== candidate) return '[redacted]';
    if (redactLocalPaths(candidate, { preservePublicUrl }) !== candidate) return '[local-path]';
    return token;
  });
}

function sanitizePublicPatchText(value, preservePublicUrl = false) {
  const withoutEncodedUnsafeContent = redactEncodedUnsafeContent(value, preservePublicUrl);
  return redactBinaryDataUrls(redactSecretText(redactLocalPaths(withoutEncodedUnsafeContent, { preservePublicUrl })));
}

function safeCanvasPatchErrorMessage(value, fallback = 'CanvasPatch 请求失败') {
  const normalized = typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  if (!normalized) return fallback;
  const safe = sanitizePublicPatchText(normalized, false)
    .replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=_-]+/gi, '[binary]')
    .slice(0, 500)
    .trim();
  return safe || fallback;
}

function safeCanvasMutationErrorCode(error, fallback = 'canvas_patch_invalid') {
  const safeFallback = /^[a-z0-9_.-]{1,120}$/i.test(String(fallback)) ? String(fallback) : 'canvas_patch_invalid';
  const inferred = error?.name === 'RevisionConflictError' ? 'revision_conflict' : safeFallback;
  const raw = String(error?.code || inferred);
  return /^[a-z0-9_.-]{1,120}$/i.test(raw) ? raw : safeFallback;
}

function canvasMutationErrorStatus(error, code, defaultStatus = 400) {
  const explicit = Number(error?.statusCode ?? error?.status);
  if ([400, 401, 403, 404, 409, 413, 422, 429, 500, 503].includes(explicit)) return explicit;
  if (/(?:forbidden|permission|not_owner|actor_mismatch|access_denied)/i.test(code)) return 403;
  if (/(?:not_found|missing_record|unknown_patch|canvas_missing)$/i.test(code)) return 404;
  if (/(?:revision_conflict|stale|digest_mismatch|conflict|already_applied|already_reverted|operation_id_reserved|busy)/i.test(code)) return 409;
  return [400, 500].includes(Number(defaultStatus)) ? Number(defaultStatus) : 400;
}

function mapCanvasMutationError(error, options = {}) {
  const fallbackCode = typeof options.fallbackCode === 'string' ? options.fallbackCode : 'canvas_patch_invalid';
  const code = safeCanvasMutationErrorCode(error, fallbackCode);
  const currentRevisionValue = error?.currentRevision ?? error?.current?.revision;
  const currentRevision = Number(currentRevisionValue);
  const body = {
    success: false,
    code,
    error: safeCanvasPatchErrorMessage(error?.message, options.fallbackMessage || 'CanvasPatch 请求无效'),
  };
  if (Number.isSafeInteger(currentRevision) && currentRevision >= 0) body.currentRevision = currentRevision;
  return {
    status: canvasMutationErrorStatus(error, code, options.defaultStatus),
    body,
  };
}

function assertJsonValue(value, path = 'value', depth = 0, state = null) {
  const context = state || { nodes: 0, stringChars: 0, seen: new WeakSet() };
  context.nodes += 1;
  if (context.nodes > 10_000 || depth > 16) throw new CanvasPatchValidationError('CanvasPatch JSON 结构过深或过大');
  if (value == null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanvasPatchValidationError('CanvasPatch 包含非有限数值');
    return;
  }
  if (typeof value === 'string') {
    context.stringChars += value.length;
    if (value.length > 64 * 1024 || context.stringChars > CANVAS_PATCH_JSON_LIMIT) {
      throw new CanvasPatchValidationError('CanvasPatch 文本超过限制');
    }
    return;
  }
  if (typeof value !== 'object' || Buffer.isBuffer(value)) throw new CanvasPatchValidationError(`${path} 不是 JSON 值`);
  if (context.seen.has(value)) throw new CanvasPatchValidationError('CanvasPatch 不能包含循环引用');
  context.seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new CanvasPatchValidationError(`${path} 数组超过限制`);
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, depth + 1, context));
  } else {
    const keys = Object.keys(value);
    if (keys.length > 500) throw new CanvasPatchValidationError(`${path} 字段超过限制`);
    for (const key of keys) {
      if (UNSAFE_KEYS.has(key)) throw new CanvasPatchValidationError(`${path} 包含不安全字段`);
      assertJsonValue(value[key], `${path}.${key}`, depth + 1, context);
    }
  }
  context.seen.delete(value);
}

function normalizePublicIdentifier(value, label, maxLength = 240, pattern = null) {
  if (typeof value !== 'string') throw new CanvasPatchValidationError(`${label} 无效`);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new CanvasPatchValidationError(`${label} 无效`);
  }
  if (UNSAFE_KEYS.has(normalized)) throw new CanvasPatchValidationError(`${label} 无效`);
  if (pattern && !pattern.test(normalized)) throw new CanvasPatchValidationError(`${label} 无效`);
  if (containsLocalPath(normalized) || SECRET_TEXT_PATTERN.test(normalized)) {
    throw new CanvasPatchValidationError(`${label} 包含不可公开内容`);
  }
  return normalized;
}

function sanitizeSummary(value) {
  if (typeof value !== 'string') throw new CanvasPatchValidationError('summary 无效');
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 500) throw new CanvasPatchValidationError('summary 为空或超过 500 字符');
  const safe = sanitizePublicPatchText(normalized, false)
    .replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=_-]+/gi, '[binary]')
    .slice(0, 500);
  if (!safe.trim()) throw new CanvasPatchValidationError('summary 无效');
  return safe;
}

function safeDirectKey(value, label, protectedKeys = null) {
  if (typeof value !== 'string') throw new CanvasPatchValidationError(`${label} 包含无效字段`);
  const key = value.normalize('NFKC').trim();
  if (!key || key.length > 160 || /[\u0000-\u001f\u007f]/.test(key) || UNSAFE_KEYS.has(key)) {
    throw new CanvasPatchValidationError(`${label} 包含无效字段`);
  }
  if (containsLocalPath(key) || SECRET_TEXT_PATTERN.test(key)) {
    throw new CanvasPatchValidationError(`${label} 包含不可公开字段`);
  }
  if (protectedKeys?.has(key)) throw new CanvasPatchValidationError('node.patch 禁止修改节点身份或类型');
  return key;
}

function normalizeKeyList(value, label, protectedKeys = null) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 500) throw new CanvasPatchValidationError(`${label} 必须是有界数组`);
  return [...new Set(value.map((key) => safeDirectKey(key, label, protectedKeys)))].sort();
}

function normalizePatchObject(value, label, protectedKeys = null) {
  if (value == null) return {};
  if (!isRecord(value)) throw new CanvasPatchValidationError(`${label} 必须是对象`);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const normalizedKey = safeDirectKey(key, label, protectedKeys);
    output[normalizedKey] = cloneJson(value[key]);
  }
  return output;
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new CanvasPatchValidationError(`${label} 包含未定义字段`);
  }
}

function normalizePatchOperation(raw, index) {
  if (!isRecord(raw)) throw new CanvasPatchValidationError(`operations[${index}] 必须是对象`);
  const allowedEnvelopeKeys = new Set([
    'type', 'payload', 'opId', 'projectId', 'canvasId', 'actorId', 'sessionId',
    'baseRevision', 'revision', 'clientSeq', 'timestamp',
  ]);
  assertOnlyKeys(raw, allowedEnvelopeKeys, `operations[${index}]`);
  const type = String(raw.type || '');
  if (!CANVAS_PATCH_OPERATION_TYPE_SET.has(type)) {
    throw new CanvasPatchValidationError(`operations[${index}] 类型不受 CanvasPatch 支持`);
  }
  const payload = isRecord(raw.payload) ? raw.payload : null;
  if (!payload) throw new CanvasPatchValidationError(`operations[${index}].payload 必须是对象`);

  if (type === 'node.add' || type === 'node.restore') {
    assertOnlyKeys(payload, new Set(['node']), `operations[${index}].payload`);
    if (!isRecord(payload.node)) throw new CanvasPatchValidationError(`operations[${index}].payload.node 必须是对象`);
    const node = cloneJson(payload.node);
    node.id = normalizePublicIdentifier(node.id, `operations[${index}].payload.node.id`);
    if (node.type != null) node.type = normalizePublicIdentifier(node.type, `operations[${index}].payload.node.type`, 160);
    if (node.entityUid != null) node.entityUid = normalizePublicIdentifier(node.entityUid, `operations[${index}].payload.node.entityUid`, 160);
    if (type === 'node.add' && node.type == null) throw new CanvasPatchValidationError(`operations[${index}].payload.node.type 无效`);
    if (node.position != null) {
      if (!isRecord(node.position)) throw new CanvasPatchValidationError(`operations[${index}].payload.node.position 无效`);
      assertOnlyKeys(node.position, new Set(['x', 'y']), `operations[${index}].payload.node.position`);
      if (typeof node.position.x !== 'number' || typeof node.position.y !== 'number'
        || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)
        || Math.abs(node.position.x) > MAX_CANVAS_COORDINATE || Math.abs(node.position.y) > MAX_CANVAS_COORDINATE) {
        throw new CanvasPatchValidationError(`operations[${index}].payload.node.position 无效`);
      }
    } else if (type === 'node.add') {
      throw new CanvasPatchValidationError(`operations[${index}].payload.node.position 无效`);
    }
    if (node.data != null && !isRecord(node.data)) {
      throw new CanvasPatchValidationError(`operations[${index}].payload.node.data 无效`);
    }
    return { type, payload: { node } };
  }
  if (type === 'node.patch') {
    assertOnlyKeys(payload, new Set(['nodeId', 'patch', 'dataPatch', 'unsetKeys', 'dataUnsetKeys']), `operations[${index}].payload`);
    const nodeId = normalizePublicIdentifier(payload.nodeId, `operations[${index}].payload.nodeId`);
    const topPatch = normalizePatchObject(payload.patch, `operations[${index}].payload.patch`, PROTECTED_NODE_KEYS);
    if (hasOwn(topPatch, 'data')) throw new CanvasPatchValidationError('node.patch 必须通过 dataPatch 修改 data');
    const dataPatch = normalizePatchObject(payload.dataPatch, `operations[${index}].payload.dataPatch`);
    const unsetKeys = normalizeKeyList(payload.unsetKeys, `operations[${index}].payload.unsetKeys`, PROTECTED_NODE_KEYS);
    const dataUnsetKeys = normalizeKeyList(payload.dataUnsetKeys, `operations[${index}].payload.dataUnsetKeys`);
    if (!Object.keys(topPatch).length && !Object.keys(dataPatch).length && !unsetKeys.length && !dataUnsetKeys.length) {
      throw new CanvasPatchValidationError('node.patch 不能为空');
    }
    const overlapTop = unsetKeys.find((key) => hasOwn(topPatch, key));
    const overlapData = dataUnsetKeys.find((key) => hasOwn(dataPatch, key));
    if (overlapTop || overlapData) throw new CanvasPatchValidationError('node.patch 同一字段不能同时设置和删除');
    return {
      type,
      payload: {
        nodeId,
        ...(Object.keys(topPatch).length ? { patch: topPatch } : {}),
        ...(unsetKeys.length ? { unsetKeys } : {}),
        ...(Object.keys(dataPatch).length ? { dataPatch } : {}),
        ...(dataUnsetKeys.length ? { dataUnsetKeys } : {}),
      },
    };
  }
  if (type === 'node.move') {
    assertOnlyKeys(payload, new Set(['nodeId', 'position']), `operations[${index}].payload`);
    const nodeId = normalizePublicIdentifier(payload.nodeId, `operations[${index}].payload.nodeId`);
    if (!isRecord(payload.position)) throw new CanvasPatchValidationError(`operations[${index}].payload.position 必须是对象`);
    assertOnlyKeys(payload.position, new Set(['x', 'y']), `operations[${index}].payload.position`);
    const position = { x: payload.position.x, y: payload.position.y };
    if (typeof position.x !== 'number' || typeof position.y !== 'number'
      || !Number.isFinite(position.x) || !Number.isFinite(position.y)
      || Math.abs(position.x) > MAX_CANVAS_COORDINATE || Math.abs(position.y) > MAX_CANVAS_COORDINATE) {
      throw new CanvasPatchValidationError(`operations[${index}].payload.position 无效`);
    }
    return { type, payload: { nodeId, position } };
  }
  if (type === 'node.delete') {
    assertOnlyKeys(payload, new Set(['nodeId']), `operations[${index}].payload`);
    return { type, payload: { nodeId: normalizePublicIdentifier(payload.nodeId, `operations[${index}].payload.nodeId`) } };
  }
  if (type === 'edge.add' || type === 'edge.restore') {
    assertOnlyKeys(payload, new Set(['edge']), `operations[${index}].payload`);
    if (!isRecord(payload.edge)) throw new CanvasPatchValidationError(`operations[${index}].payload.edge 必须是对象`);
    const edge = cloneJson(payload.edge);
    edge.id = normalizePublicIdentifier(edge.id, `operations[${index}].payload.edge.id`);
    edge.source = normalizePublicIdentifier(edge.source, `operations[${index}].payload.edge.source`);
    edge.target = normalizePublicIdentifier(edge.target, `operations[${index}].payload.edge.target`);
    if (edge.type != null) edge.type = normalizePublicIdentifier(edge.type, `operations[${index}].payload.edge.type`, 160);
    if (edge.entityUid != null) edge.entityUid = normalizePublicIdentifier(edge.entityUid, `operations[${index}].payload.edge.entityUid`, 160);
    return { type, payload: { edge } };
  }
  if (type === 'edge.delete') {
    assertOnlyKeys(payload, new Set(['edgeId']), `operations[${index}].payload`);
    return { type, payload: { edgeId: normalizePublicIdentifier(payload.edgeId, `operations[${index}].payload.edgeId`) } };
  }
  assertOnlyKeys(payload, new Set(['viewport']), `operations[${index}].payload`);
  if (!isRecord(payload.viewport)) throw new CanvasPatchValidationError(`operations[${index}].payload.viewport 必须是对象`);
  assertOnlyKeys(payload.viewport, new Set(['x', 'y', 'zoom']), `operations[${index}].payload.viewport`);
  const viewport = {
    x: payload.viewport.x,
    y: payload.viewport.y,
    zoom: payload.viewport.zoom,
  };
  if (typeof viewport.x !== 'number' || typeof viewport.y !== 'number' || typeof viewport.zoom !== 'number'
    || !Number.isFinite(viewport.x) || !Number.isFinite(viewport.y)
    || !Number.isFinite(viewport.zoom) || viewport.zoom < 0.01 || viewport.zoom > MAX_CANVAS_ZOOM
    || Math.abs(viewport.x) > MAX_CANVAS_COORDINATE || Math.abs(viewport.y) > MAX_CANVAS_COORDINATE) {
    throw new CanvasPatchValidationError(`operations[${index}].payload.viewport 无效`);
  }
  return { type, payload: { viewport } };
}

function validateCanvasPatch(raw) {
  if (!isRecord(raw)) throw new CanvasPatchValidationError('CanvasPatch 必须是对象');
  assertOnlyKeys(raw, new Set([
    'schema', 'id', 'baseRevision', 'summary', 'operations',
    'diagnosticsResolved', 'requiresConfirmation',
  ]), 'CanvasPatch');
  assertJsonValue(raw, 'patch');
  const serialized = JSON.stringify(raw);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > CANVAS_PATCH_JSON_LIMIT) {
    throw new CanvasPatchValidationError('CanvasPatch 超过 512 KiB');
  }
  if (raw.schema !== CANVAS_PATCH_CONTRACT) throw new CanvasPatchValidationError(`schema 必须是 ${CANVAS_PATCH_CONTRACT}`);
  const id = normalizePublicIdentifier(raw.id, 'id', 160, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
  if (!hasOwn(raw, 'baseRevision') || !Number.isInteger(raw.baseRevision) || raw.baseRevision < 1) {
    throw new CanvasPatchValidationError('baseRevision 必须是正整数');
  }
  const summary = sanitizeSummary(raw.summary);
  if (!hasOwn(raw, 'diagnosticsResolved') || !Array.isArray(raw.diagnosticsResolved) || raw.diagnosticsResolved.length > 100) {
    throw new CanvasPatchValidationError('diagnosticsResolved 必须是最多 100 项的数组');
  }
  const diagnosticsResolved = [...new Set(raw.diagnosticsResolved.map((value) => (
    normalizePublicIdentifier(value, 'diagnosticsResolved', 160, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
  )))].sort();
  if (raw.requiresConfirmation !== true) throw new CanvasPatchValidationError('requiresConfirmation 必须为 true');
  if (!Array.isArray(raw.operations) || raw.operations.length < 1 || raw.operations.length > CANVAS_PATCH_OPERATION_LIMIT) {
    throw new CanvasPatchValidationError(`operations 必须包含 1-${CANVAS_PATCH_OPERATION_LIMIT} 条 Operation`);
  }
  const operations = raw.operations.map(normalizePatchOperation);
  return {
    schema: CANVAS_PATCH_CONTRACT,
    id,
    baseRevision: raw.baseRevision,
    summary,
    diagnosticsResolved,
    requiresConfirmation: true,
    operations,
  };
}

function canvasPatchRequestDigest(input) {
  const patch = validateCanvasPatch(input);
  return sha256(stableJson(patch));
}

function scopedCanvasPatchOperationId(projectId, canvasId, patchId, phase, index) {
  const digest = sha256(stableJson([
    CANVAS_PATCH_CONTRACT,
    String(projectId || ''),
    String(canvasId || ''),
    String(patchId || ''),
    phase === 'revert' ? 'revert' : 'apply',
    Number(index) || 0,
  ]));
  return `canvas-patch:${digest}`;
}

function matchingNodes(document, identity) {
  const value = String(identity || '');
  return (Array.isArray(document?.nodes) ? document.nodes : []).filter((node) => (
    String(node?.id || '') === value || String(node?.entityUid || '') === value
  ));
}

function matchingEdges(document, identity) {
  const value = String(identity || '');
  return (Array.isArray(document?.edges) ? document.edges : []).filter((edge) => (
    String(edge?.id || '') === value || String(edge?.entityUid || '') === value
  ));
}

function resolveNode(document, identity, operationIndex) {
  const matches = matchingNodes(document, identity);
  if (matches.length !== 1) {
    throw new CanvasPatchValidationError(matches.length ? 'CanvasPatch 节点目标不唯一' : 'CanvasPatch 节点目标不存在', { operationIndex });
  }
  return matches[0];
}

function resolveEdge(document, identity, operationIndex) {
  const matches = matchingEdges(document, identity);
  if (matches.length !== 1) {
    throw new CanvasPatchValidationError(matches.length ? 'CanvasPatch 连线目标不唯一' : 'CanvasPatch 连线目标不存在', { operationIndex });
  }
  return matches[0];
}

function nodeIdentityMatches(node, identity) {
  const value = String(identity || '');
  return Boolean(node) && (String(node.id || '') === value || String(node.entityUid || '') === value);
}

function safeIdentifier(value) {
  const safe = sanitizePublicPatchText(String(value || ''), false)
    .replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=_-]+/gi, '[binary]')
    .slice(0, 240);
  return SECRET_TEXT_PATTERN.test(safe) ? '[redacted-id]' : safe;
}

function deepRedactPatchValue(value, field, depth, state) {
  state.nodes += 1;
  if (state.nodes > 500 || depth > 8) return '[truncated]';
  if (isSensitivePatchKey(field)) return '[redacted]';
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (/^data:[^;,\s]+;base64,/i.test(value.trim()) || value.length > 4096) {
      return `[redacted-content:${sha256(value).slice(0, 12)}]`;
    }
    const redacted = sanitizePublicPatchText(value, /^https?:\/\//i.test(value.trim()));
    return redacted.length > 512 ? `${redacted.slice(0, 480)}…[${sha256(redacted).slice(0, 12)}]` : redacted;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => deepRedactPatchValue(item, field, depth + 1, state));
  }
  if (!isRecord(value)) return null;
  const output = {};
  Object.keys(value).sort().slice(0, 50).forEach((key) => {
    if (UNSAFE_KEYS.has(key)) return;
    let publicKey = sanitizePublicPatchText(key, false);
    if (SECRET_TEXT_PATTERN.test(publicKey) || publicKey.length > 160) {
      publicKey = `[redacted-key:${sha256(key).slice(0, 12)}]`;
    }
    if (hasOwn(output, publicKey)) publicKey = `${publicKey}:${sha256(key).slice(0, 8)}`;
    output[publicKey] = deepRedactPatchValue(value[key], key, depth + 1, state);
  });
  return output;
}

function safePatchValue(value, field = '') {
  const safe = deepRedactPatchValue(value, field, 0, { nodes: 0 });
  const serialized = JSON.stringify(safe);
  if (serialized && Buffer.byteLength(serialized, 'utf8') > 2048) {
    return { redactedContentDigest: sha256(serialized).slice(0, 16) };
  }
  return safe;
}

function fieldState(node, scope, key) {
  const target = scope === 'data' && isRecord(node?.data) ? node.data : (scope === 'node' ? node : {});
  return hasOwn(target, key)
    ? { scope, key, exists: true, value: cloneJson(target[key]) }
    : { scope, key, exists: false, value: null };
}

function publicFieldState(state) {
  return state.exists ? safePatchValue(state.value, `${state.scope}.${state.key}`) : { exists: false };
}

function tombstoneRecord(records, id, entityUid) {
  if (!isRecord(records)) return null;
  if (hasOwn(records, id)) return records[id];
  return Object.values(records).find((record) => String(record?.entityUid || '') === String(entityUid || '')) || null;
}

function claimTarget(claimed, kind, id, operationIndex) {
  const key = `${kind}:${String(id)}`;
  if (claimed.has(key)) throw new CanvasPatchValidationError('CanvasPatch 包含重复或重叠目标', { operationIndex });
  claimed.add(key);
}

function buildCanvasPatchPlan(inputDocument, inputPatch, context = {}) {
  const patch = validateCanvasPatch(inputPatch);
  assertCanvasPatchCredentialAuthority(patch, context);
  const document = normalizeCanvasDocument(inputDocument?.canvasId || context.canvasId || 'unknown', inputDocument, {
    projectId: inputDocument?.projectId || context.projectId,
    revision: inputDocument?.revision,
    updatedAt: inputDocument?.updatedAt,
  });
  if (patch.baseRevision !== document.revision) {
    throw new CanvasPatchConflictError('CanvasPatch baseRevision 已过期', {
      code: 'canvas_patch_revision_conflict',
      currentRevision: document.revision,
    });
  }

  const requestDigest = canvasPatchRequestDigest(patch);
  let working = cloneJson(document);
  const operations = [];
  const inverseGroups = [];
  const postconditions = [];
  const changes = [];
  const affectedNodeIds = new Set();
  const affectedEdgeIds = new Set();
  const warnings = [];
  const claimed = new Set();

  patch.operations.forEach((rawOperation, operationIndex) => {
    const opId = scopedCanvasPatchOperationId(document.projectId, document.canvasId, patch.id, 'apply', operationIndex);
    const envelope = {
      opId,
      projectId: document.projectId,
      canvasId: document.canvasId,
      actorId: String(context.actorId || 'local-owner'),
      sessionId: String(context.sessionId || 'local-session'),
      baseRevision: working.revision,
      clientSeq: operationIndex,
      timestamp: 1,
    };
    try {
      if (rawOperation.type === 'node.add' || rawOperation.type === 'node.restore') {
        const payload = cloneJson(rawOperation.payload);
        const nodeId = String(payload.node.id);
        claimTarget(claimed, 'node', nodeId, operationIndex);
        const applied = applyCanvasOperation(working, { ...envelope, type: rawOperation.type, payload });
        working = normalizeCanvasDocument(document.canvasId, applied.document, {
          projectId: document.projectId,
          revision: working.revision + 1,
          updatedAt: document.updatedAt,
        });
        const added = resolveNode(working, nodeId, operationIndex);
        operations.push({ type: rawOperation.type, payload });
        inverseGroups.push([{ type: 'node.delete', payload: { nodeId: String(added.id) } }]);
        postconditions.push({
          kind: 'node.added',
          nodeId: String(added.id),
          entityUid: added.entityUid || null,
          node: cloneJson(added),
          connectedEdges: [],
        });
        changes.push({
          operationIndex,
          type: rawOperation.type,
          targetType: 'node',
          targetId: safeIdentifier(added.id),
          fields: ['exists'],
          before: { exists: false },
          after: { exists: true },
        });
        affectedNodeIds.add(safeIdentifier(added.id));
        return;
      }

      if (rawOperation.type === 'node.patch') {
        const current = resolveNode(working, rawOperation.payload.nodeId, operationIndex);
        const nodeId = String(current.id);
        claimTarget(claimed, 'node', nodeId, operationIndex);
        const payload = { ...cloneJson(rawOperation.payload), nodeId };
        const topKeys = [...new Set([
          ...Object.keys(payload.patch || {}),
          ...(payload.unsetKeys || []),
        ])].sort();
        const dataKeys = [...new Set([
          ...Object.keys(payload.dataPatch || {}),
          ...(payload.dataUnsetKeys || []),
        ])].sort();
        const beforeStates = [
          ...topKeys.map((key) => fieldState(current, 'node', key)),
          ...dataKeys.map((key) => fieldState(current, 'data', key)),
        ];
        const applied = applyCanvasOperation(working, { ...envelope, type: rawOperation.type, payload });
        working = normalizeCanvasDocument(document.canvasId, applied.document, {
          projectId: document.projectId,
          revision: working.revision + 1,
          updatedAt: document.updatedAt,
        });
        const afterNode = resolveNode(working, current.entityUid || nodeId, operationIndex);
        const afterStates = beforeStates.map((state) => fieldState(afterNode, state.scope, state.key));
        const inversePayload = { nodeId };
        const inverseTopPatch = {};
        const inverseDataPatch = {};
        const inverseUnsetKeys = [];
        const inverseDataUnsetKeys = [];
        beforeStates.forEach((state) => {
          if (state.scope === 'node') {
            if (state.exists) inverseTopPatch[state.key] = cloneJson(state.value);
            else inverseUnsetKeys.push(state.key);
          } else if (state.exists) inverseDataPatch[state.key] = cloneJson(state.value);
          else inverseDataUnsetKeys.push(state.key);
        });
        if (Object.keys(inverseTopPatch).length) inversePayload.patch = inverseTopPatch;
        if (inverseUnsetKeys.length) inversePayload.unsetKeys = inverseUnsetKeys.sort();
        if (Object.keys(inverseDataPatch).length) inversePayload.dataPatch = inverseDataPatch;
        if (inverseDataUnsetKeys.length) inversePayload.dataUnsetKeys = inverseDataUnsetKeys.sort();
        operations.push({ type: rawOperation.type, payload });
        inverseGroups.push([{ type: 'node.patch', payload: inversePayload }]);
        postconditions.push({
          kind: 'node.fields',
          nodeId,
          entityUid: current.entityUid || null,
          fields: afterStates,
        });
        const fields = [
          ...topKeys,
          ...dataKeys.map((key) => `data.${key}`),
        ].sort();
        const before = {};
        const after = {};
        beforeStates.forEach((state) => { before[state.scope === 'data' ? `data.${state.key}` : state.key] = publicFieldState(state); });
        afterStates.forEach((state) => { after[state.scope === 'data' ? `data.${state.key}` : state.key] = publicFieldState(state); });
        changes.push({
          operationIndex,
          type: rawOperation.type,
          targetType: 'node',
          targetId: safeIdentifier(nodeId),
          fields,
          before,
          after,
        });
        affectedNodeIds.add(safeIdentifier(nodeId));
        return;
      }

      if (rawOperation.type === 'node.move') {
        const current = resolveNode(working, rawOperation.payload.nodeId, operationIndex);
        const nodeId = String(current.id);
        claimTarget(claimed, 'node', nodeId, operationIndex);
        const beforeState = fieldState(current, 'node', 'position');
        const payload = { nodeId, position: cloneJson(rawOperation.payload.position) };
        const applied = applyCanvasOperation(working, { ...envelope, type: rawOperation.type, payload });
        working = normalizeCanvasDocument(document.canvasId, applied.document, {
          projectId: document.projectId,
          revision: working.revision + 1,
          updatedAt: document.updatedAt,
        });
        const moved = resolveNode(working, current.entityUid || nodeId, operationIndex);
        const afterState = fieldState(moved, 'node', 'position');
        operations.push({ type: rawOperation.type, payload });
        inverseGroups.push([beforeState.exists ? {
          type: 'node.move',
          payload: { nodeId, position: cloneJson(beforeState.value) },
        } : {
          type: 'node.patch',
          payload: { nodeId, unsetKeys: ['position'] },
        }]);
        postconditions.push({
          kind: 'node.fields',
          nodeId,
          entityUid: current.entityUid || null,
          fields: [afterState],
        });
        changes.push({
          operationIndex,
          type: rawOperation.type,
          targetType: 'node',
          targetId: safeIdentifier(nodeId),
          fields: ['position'],
          before: { position: publicFieldState(beforeState) },
          after: { position: publicFieldState(afterState) },
        });
        affectedNodeIds.add(safeIdentifier(nodeId));
        return;
      }

      if (rawOperation.type === 'node.delete') {
        const current = resolveNode(working, rawOperation.payload.nodeId, operationIndex);
        const nodeId = String(current.id);
        claimTarget(claimed, 'node', nodeId, operationIndex);
        const connectedEdges = working.edges.filter((edge) => (
          nodeIdentityMatches(current, edge?.source) || nodeIdentityMatches(current, edge?.target)
        ));
        if (connectedEdges.length + affectedNodeIds.size + affectedEdgeIds.size > CANVAS_PATCH_AFFECTED_LIMIT) {
          throw new CanvasPatchValidationError(`CanvasPatch 影响实体不能超过 ${CANVAS_PATCH_AFFECTED_LIMIT} 个`, { operationIndex });
        }
        connectedEdges.forEach((edge) => claimTarget(claimed, 'edge', String(edge.id), operationIndex));
        const payload = { nodeId };
        const applied = applyCanvasOperation(working, { ...envelope, type: rawOperation.type, payload });
        working = normalizeCanvasDocument(document.canvasId, applied.document, {
          projectId: document.projectId,
          revision: working.revision + 1,
          updatedAt: document.updatedAt,
        });
        operations.push({ type: rawOperation.type, payload });
        inverseGroups.push([
          { type: 'node.restore', payload: { node: cloneJson(current) } },
          ...connectedEdges.map((edge) => ({ type: 'edge.restore', payload: { edge: cloneJson(edge) } })),
        ]);
        postconditions.push({
          kind: 'node.deleted',
          nodeId,
          entityUid: current.entityUid || null,
          opId,
          edges: connectedEdges.map((edge) => ({ id: String(edge.id), entityUid: edge.entityUid || null })),
        });
        const relatedEdgeIds = connectedEdges.map((edge) => safeIdentifier(edge.id)).sort();
        changes.push({
          operationIndex,
          type: rawOperation.type,
          targetType: 'node',
          targetId: safeIdentifier(nodeId),
          fields: ['exists'],
          before: { exists: true },
          after: { exists: false },
          ...(relatedEdgeIds.length ? { relatedEdgeIds } : {}),
        });
        affectedNodeIds.add(safeIdentifier(nodeId));
        connectedEdges.forEach((edge) => affectedEdgeIds.add(safeIdentifier(edge.id)));
        if (connectedEdges.length) warnings.push(`删除节点将级联删除 ${connectedEdges.length} 条连线`);
        return;
      }

      if (rawOperation.type === 'edge.add' || rawOperation.type === 'edge.restore') {
        const payload = cloneJson(rawOperation.payload);
        const edgeId = String(payload.edge.id);
        claimTarget(claimed, 'edge', edgeId, operationIndex);
        const source = resolveNode(working, payload.edge.source, operationIndex);
        const target = resolveNode(working, payload.edge.target, operationIndex);
        const applied = applyCanvasOperation(working, { ...envelope, type: rawOperation.type, payload });
        working = normalizeCanvasDocument(document.canvasId, applied.document, {
          projectId: document.projectId,
          revision: working.revision + 1,
          updatedAt: document.updatedAt,
        });
        const added = resolveEdge(working, edgeId, operationIndex);
        operations.push({ type: rawOperation.type, payload });
        inverseGroups.push([{ type: 'edge.delete', payload: { edgeId: String(added.id) } }]);
        postconditions.push({
          kind: 'edge.added',
          edgeId: String(added.id),
          entityUid: added.entityUid || null,
          edge: cloneJson(added),
        });
        const relatedNodeIds = [...new Set([safeIdentifier(source.id), safeIdentifier(target.id)])].sort();
        changes.push({
          operationIndex,
          type: rawOperation.type,
          targetType: 'edge',
          targetId: safeIdentifier(added.id),
          fields: ['exists'],
          before: { exists: false },
          after: { exists: true },
          relatedNodeIds,
        });
        affectedEdgeIds.add(safeIdentifier(added.id));
        affectedNodeIds.add(safeIdentifier(source.id));
        affectedNodeIds.add(safeIdentifier(target.id));
        return;
      }

      if (rawOperation.type === 'viewport.set') {
        claimTarget(claimed, 'canvas', 'viewport', operationIndex);
        const beforeViewport = cloneJson(working.viewport);
        const payload = cloneJson(rawOperation.payload);
        const applied = applyCanvasOperation(working, { ...envelope, type: rawOperation.type, payload });
        working = normalizeCanvasDocument(document.canvasId, applied.document, {
          projectId: document.projectId,
          revision: working.revision + 1,
          updatedAt: document.updatedAt,
        });
        operations.push({ type: rawOperation.type, payload });
        inverseGroups.push([{ type: 'viewport.set', payload: { viewport: beforeViewport } }]);
        postconditions.push({
          kind: 'canvas.fields',
          canvasId: document.canvasId,
          fields: [{ key: 'viewport', exists: true, value: cloneJson(working.viewport) }],
        });
        changes.push({
          operationIndex,
          type: rawOperation.type,
          targetType: 'canvas',
          targetId: safeIdentifier(document.canvasId),
          fields: ['viewport'],
          before: { viewport: safePatchValue(beforeViewport, 'viewport') },
          after: { viewport: safePatchValue(working.viewport, 'viewport') },
        });
        return;
      }

      const current = resolveEdge(working, rawOperation.payload.edgeId, operationIndex);
      const edgeId = String(current.id);
      claimTarget(claimed, 'edge', edgeId, operationIndex);
      const payload = { edgeId };
      const applied = applyCanvasOperation(working, { ...envelope, type: rawOperation.type, payload });
      working = normalizeCanvasDocument(document.canvasId, applied.document, {
        projectId: document.projectId,
        revision: working.revision + 1,
        updatedAt: document.updatedAt,
      });
      operations.push({ type: rawOperation.type, payload });
      inverseGroups.push([{ type: 'edge.restore', payload: { edge: cloneJson(current) } }]);
      postconditions.push({
        kind: 'edge.deleted',
        edgeId,
        entityUid: current.entityUid || null,
        opId,
      });
      const relatedNodeIds = [...new Set([current.source, current.target].map(safeIdentifier).filter(Boolean))].sort();
      changes.push({
        operationIndex,
        type: rawOperation.type,
        targetType: 'edge',
        targetId: safeIdentifier(edgeId),
        fields: ['exists'],
        before: { exists: true },
        after: { exists: false },
        ...(relatedNodeIds.length ? { relatedNodeIds } : {}),
      });
      affectedEdgeIds.add(safeIdentifier(edgeId));
      [current.source, current.target].forEach((identity) => {
        const matches = matchingNodes(working, identity);
        affectedNodeIds.add(safeIdentifier(matches.length === 1 ? matches[0].id : identity));
      });
    } catch (error) {
      if (error instanceof CanvasPatchValidationError) throw error;
      throw new CanvasPatchValidationError('CanvasPatch Operation 无法安全应用', { operationIndex });
    }
  });

  postconditions.forEach((condition) => {
    if (condition?.kind !== 'node.added') return;
    const matches = matchingNodes(working, condition.entityUid || condition.nodeId);
    if (matches.length !== 1) throw new CanvasPatchValidationError('CanvasPatch 新增节点的最终状态无效');
    const node = matches[0];
    condition.connectedEdges = working.edges
      .filter((edge) => nodeIdentityMatches(node, edge?.source) || nodeIdentityMatches(node, edge?.target))
      .map((edge) => ({ id: String(edge.id), entityUid: edge.entityUid || null }))
      .sort((left, right) => compareText(left.id, right.id));
  });

  if (affectedNodeIds.size + affectedEdgeIds.size > CANVAS_PATCH_AFFECTED_LIMIT) {
    throw new CanvasPatchValidationError(`CanvasPatch 影响实体不能超过 ${CANVAS_PATCH_AFFECTED_LIMIT} 个`);
  }

  const inverseOperations = inverseGroups.slice().reverse().flat();
  const internalPlanJson = JSON.stringify({ operations, inverseOperations, postconditions });
  if (!internalPlanJson || Buffer.byteLength(internalPlanJson, 'utf8') > CANVAS_PATCH_INTERNAL_PLAN_LIMIT) {
    throw new CanvasPatchValidationError('CanvasPatch 逆操作或校验状态超过安全大小限制');
  }
  const guardDigest = sha256(stableJson({ operations, inverseOperations, postconditions }));
  const previewDigest = sha256(stableJson({
    schema: CANVAS_PATCH_CONTRACT,
    requestDigest,
    projectId: document.projectId,
    canvasId: document.canvasId,
    currentRevision: document.revision,
    guardDigest,
  }));
  const preview = {
    patchId: patch.id,
    baseRevision: patch.baseRevision,
    currentRevision: document.revision,
    previewDigest,
    summary: patch.summary,
    diagnosticsResolved: [...patch.diagnosticsResolved],
    affectedNodeIds: [...affectedNodeIds].sort(),
    affectedEdgeIds: [...affectedEdgeIds].sort(),
    changes,
    warnings,
  };
  if (Buffer.byteLength(JSON.stringify(preview), 'utf8') > CANVAS_PATCH_JSON_LIMIT) {
    throw new CanvasPatchValidationError('CanvasPatch 预览超过安全大小限制');
  }
  return {
    patch,
    requestDigest,
    previewDigest,
    preview,
    operations,
    inverseOperations,
    postconditions,
    resultingDocument: working,
  };
}

function previewCanvasPatch(document, rawPatch, context = {}) {
  return buildCanvasPatchPlan(document, validateCanvasPatch(rawPatch), context).preview;
}

function assertCanvasPatchPostconditions(document, rawPostconditions) {
  const postconditions = Array.isArray(rawPostconditions) ? rawPostconditions : [];
  const conflicts = [];
  const addConflict = (condition, field = null) => {
    const targetType = condition.kind.startsWith('node')
      ? 'node'
      : condition.kind.startsWith('edge') ? 'edge' : 'canvas';
    conflicts.push({
      targetType,
      targetId: safeIdentifier(condition.nodeId || condition.edgeId || condition.canvasId || document?.canvasId),
      ...(field ? { field } : {}),
    });
  };

  postconditions.forEach((condition) => {
    if (condition?.kind === 'node.fields') {
      const matches = matchingNodes(document, condition.entityUid || condition.nodeId);
      if (matches.length !== 1) {
        addConflict(condition);
        return;
      }
      const node = matches[0];
      (Array.isArray(condition.fields) ? condition.fields : []).forEach((expected) => {
        const actual = fieldState(node, expected.scope, expected.key);
        if (actual.exists !== Boolean(expected.exists)
          || (actual.exists && stableJson(actual.value) !== stableJson(expected.value))) {
          addConflict(condition, expected.scope === 'data' ? `data.${expected.key}` : expected.key);
        }
      });
      return;
    }
    if (condition?.kind === 'node.added') {
      const matches = matchingNodes(document, condition.entityUid || condition.nodeId);
      if (matches.length !== 1 || stableJson(matches[0]) !== stableJson(condition.node)) {
        addConflict(condition);
        return;
      }
      const node = matches[0];
      const actualEdges = document.edges
        .filter((edge) => nodeIdentityMatches(node, edge?.source) || nodeIdentityMatches(node, edge?.target))
        .map((edge) => ({ id: String(edge.id), entityUid: edge.entityUid || null }))
        .sort((left, right) => compareText(left.id, right.id));
      if (stableJson(actualEdges) !== stableJson(condition.connectedEdges || [])) addConflict(condition, 'connections');
      return;
    }
    if (condition?.kind === 'node.deleted') {
      const live = matchingNodes(document, condition.entityUid || condition.nodeId);
      const tombstone = tombstoneRecord(document?.tombstones?.nodes, condition.nodeId, condition.entityUid);
      if (live.length || !tombstone || String(tombstone.opId || '') !== String(condition.opId || '')) addConflict(condition);
      (Array.isArray(condition.edges) ? condition.edges : []).forEach((edge) => {
        const liveEdge = matchingEdges(document, edge.entityUid || edge.id);
        const edgeTombstone = tombstoneRecord(document?.tombstones?.edges, edge.id, edge.entityUid);
        if (liveEdge.length || !edgeTombstone || String(edgeTombstone.opId || '') !== String(condition.opId || '')) {
          addConflict({ kind: 'edge.deleted', edgeId: edge.id });
        }
      });
      return;
    }
    if (condition?.kind === 'edge.deleted') {
      const live = matchingEdges(document, condition.entityUid || condition.edgeId);
      const tombstone = tombstoneRecord(document?.tombstones?.edges, condition.edgeId, condition.entityUid);
      if (live.length || !tombstone || String(tombstone.opId || '') !== String(condition.opId || '')) addConflict(condition);
      return;
    }
    if (condition?.kind === 'edge.added') {
      const matches = matchingEdges(document, condition.entityUid || condition.edgeId);
      if (matches.length !== 1 || stableJson(matches[0]) !== stableJson(condition.edge)) addConflict(condition);
      return;
    }
    if (condition?.kind === 'canvas.fields') {
      (Array.isArray(condition.fields) ? condition.fields : []).forEach((expected) => {
        const exists = hasOwn(document, expected.key);
        if (exists !== Boolean(expected.exists)
          || (exists && stableJson(document[expected.key]) !== stableJson(expected.value))) {
          addConflict(condition, expected.key);
        }
      });
      return;
    }
    conflicts.push({ targetType: 'canvas', targetId: safeIdentifier(document?.canvasId) });
  });
  if (conflicts.length) throw new CanvasPatchRevertConflictError(conflicts, Number(document?.revision) || null);
  return true;
}

module.exports = {
  CANVAS_PATCH_CONTRACT,
  CANVAS_PATCH_AUTHORITY_SOURCES,
  CANVAS_PATCH_AFFECTED_LIMIT,
  CANVAS_PATCH_JSON_LIMIT,
  CANVAS_PATCH_INTERNAL_PLAN_LIMIT,
  CANVAS_PATCH_OPERATION_LIMIT,
  CANVAS_PATCH_OPERATION_TYPES,
  CanvasPatchConflictError,
  CanvasPatchConfirmationError,
  CanvasPatchNotFoundError,
  CanvasPatchPermissionError,
  CanvasPatchRevertConflictError,
  CanvasPatchValidationError,
  assertCanvasPatchCredentialAuthority,
  assertCanvasPatchPostconditions,
  buildCanvasPatchPlan,
  canvasPatchTouchesHostCredentials,
  canvasPatchRequestDigest,
  mapCanvasMutationError,
  normalizeCanvasPatchAuthority,
  previewCanvasPatch,
  safeCanvasPatchErrorMessage,
  safeIdentifier,
  safePatchValue,
  scopedCanvasPatchOperationId,
  stableJson,
  isHostCredentialFieldKey,
  validateCanvasPatch,
};
