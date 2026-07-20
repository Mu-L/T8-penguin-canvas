const {
  containsLocalPath,
  redactLocalPaths,
} = require('./assetPublicView');
const { isHostCredentialFieldKey } = require('./canvasPatch');

const PUBLIC_VALUE_MAX_DEPTH = 32;
const PUBLIC_VALUE_MAX_NODES = 1_000_000;
const ENCODED_TEXT_MAX_LENGTH = 128 * 1024;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PRIVATE_PATH_KEYS = new Set([
  'absolutepath',
  'blobid',
  'cwd',
  'databasepath',
  'executablepath',
  'filesystempath',
  'globalblobid',
  'localpath',
  'logpath',
  'managedpath',
  'sourcelocator',
  'sourcepath',
  'temppath',
  'workspacepath',
]);
const CREDENTIAL_DESCRIPTOR_KEYS = new Set([
  'field', 'fieldname', 'header', 'headername', 'name',
  'parameter', 'parametername', 'property', 'propertyname',
]);
const CREDENTIAL_DESCRIPTOR_VALUE_KEYS = new Set(['content', 'defaultvalue', 'secret', 'value']);

function normalizePublicKey(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPrivatePathKey(value) {
  return PRIVATE_PATH_KEYS.has(normalizePublicKey(value));
}

function preservePublicUrl(value) {
  return /^(?:https?:\/\/|\/(?:api|files|input|output)\/)/i.test(String(value || '').trim());
}

function decodedUrlCandidates(value) {
  const candidates = [];
  let decoded = String(value || '');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      candidates.push(next);
      decoded = next;
    } catch (_) {
      break;
    }
  }
  return candidates;
}

function printableDecodedText(buffer) {
  const value = buffer.toString('utf8');
  if (!value || value.includes('\u0000') || value.includes('\ufffd')) return null;
  const printable = [...value].filter((character) => (
    character === '\t' || character === '\n' || character === '\r'
    || character.codePointAt(0) >= 0x20
  )).length;
  return printable / [...value].length >= 0.9 ? value : null;
}

function decodedOpaqueCandidates(value) {
  const raw = String(value || '');
  if (raw.length < 8 || raw.length > ENCODED_TEXT_MAX_LENGTH) return [];
  const compact = raw.replace(/\s+/g, '');
  const candidates = [];
  if (/^(?:[0-9a-f]{2}){4,}$/i.test(compact)) {
    try {
      const decoded = printableDecodedText(Buffer.from(compact, 'hex'));
      if (decoded) candidates.push(decoded);
    } catch (_) {}
  }
  if (/^[A-Za-z0-9+/_-]{8,}={0,2}$/.test(compact) && compact.length % 4 !== 1) {
    try {
      const decoded = printableDecodedText(Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
      if (decoded) candidates.push(decoded);
    } catch (_) {}
  }
  return [...new Set(candidates)];
}

function valueContainsCredentialField(value, depth = 0, state = null) {
  const context = state || { remaining: 10_000, seen: new WeakSet() };
  if (context.remaining <= 0 || depth > 16) return true;
  context.remaining -= 1;
  if (!value || typeof value !== 'object') return false;
  if (context.seen.has(value)) return true;
  context.seen.add(value);
  const result = Array.isArray(value)
    ? value.some((item) => valueContainsCredentialField(item, depth + 1, context))
    : Object.entries(value).some(([key, item]) => (
      isHostCredentialFieldKey(key) || valueContainsCredentialField(item, depth + 1, context)
    ));
  context.seen.delete(value);
  return result;
}

function structuredTextContainsCredentialField(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      if (valueContainsCredentialField(JSON.parse(text))) return true;
    } catch (_) {}
  }
  const assignments = text.matchAll(/(?:^|[{,&;\r\n])\s*["']?([^"':=,&{}\r\n]{1,160})["']?\s*[:=]/g);
  for (const match of assignments) {
    if (isHostCredentialFieldKey(match[1])) return true;
  }
  return false;
}

function decodedTextIsUnsafe(value) {
  const text = String(value || '');
  if (!text) return false;
  if (/^data:[^;,\s]+;base64,/i.test(text.trim())) return true;
  if (containsLocalPath(text) || structuredTextContainsCredentialField(text)) return true;
  return redactLocalPaths(text, { preservePublicUrl: preservePublicUrl(text) }) !== text;
}

function publicString(value) {
  const raw = String(value);
  if (/^data:[^;,\s]+;base64,/i.test(raw.trim())) return '[binary]';
  for (const decoded of [...decodedUrlCandidates(raw), ...decodedOpaqueCandidates(raw)]) {
    if (decodedTextIsUnsafe(decoded)) return '[redacted]';
  }
  return redactLocalPaths(raw, { preservePublicUrl: preservePublicUrl(raw) });
}

function publicFieldName(value) {
  const raw = String(value);
  if (UNSAFE_OBJECT_KEYS.has(raw) || isPrivatePathKey(raw) || isHostCredentialFieldKey(raw)) return null;
  return publicString(raw) === raw ? raw : null;
}

function objectDescribesCredential(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (!entries.some(([key]) => CREDENTIAL_DESCRIPTOR_VALUE_KEYS.has(normalizePublicKey(key)))) return false;
  return entries.some(([key, item]) => (
    CREDENTIAL_DESCRIPTOR_KEYS.has(normalizePublicKey(key))
    && typeof item === 'string'
    && isHostCredentialFieldKey(item)
  ));
}

function publicCollaborationCanvasValue(value, key = '', depth = 0, state = null) {
  const context = state || { remaining: PUBLIC_VALUE_MAX_NODES, seen: new WeakSet() };
  if (context.remaining <= 0 || depth > PUBLIC_VALUE_MAX_DEPTH) return '[truncated]';
  context.remaining -= 1;
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return publicString(value);
  if (typeof value !== 'object' || Buffer.isBuffer(value)) return null;
  if (context.seen.has(value)) return '[cycle]';
  context.seen.add(value);
  if (Array.isArray(value)) {
    if (value.length >= 2 && typeof value[0] === 'string' && isHostCredentialFieldKey(value[0])) {
      context.seen.delete(value);
      return ['[redacted-field]', '[redacted]'];
    }
    const output = value.map((item) => publicCollaborationCanvasValue(item, key, depth + 1, context));
    context.seen.delete(value);
    return output;
  }
  const output = {};
  const credentialDescriptor = objectDescribesCredential(value);
  for (const [rawKey, item] of Object.entries(value)) {
    const publicKey = publicFieldName(rawKey);
    if (!publicKey) continue;
    if (credentialDescriptor && CREDENTIAL_DESCRIPTOR_VALUE_KEYS.has(normalizePublicKey(rawKey))) {
      output[publicKey] = '[redacted]';
      continue;
    }
    output[publicKey] = publicCollaborationCanvasValue(item, publicKey, depth + 1, context);
  }
  context.seen.delete(value);
  return output;
}

function publicCanvasDocument(document) {
  return publicCollaborationCanvasValue(document);
}

function publicCanvasSync(sync) {
  return publicCollaborationCanvasValue(sync);
}

module.exports = {
  publicCanvasDocument,
  publicCanvasSync,
  publicCollaborationCanvasValue,
};
