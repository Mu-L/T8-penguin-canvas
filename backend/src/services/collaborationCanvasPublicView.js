const {
  containsLocalPath,
  redactLocalPaths,
} = require('./assetPublicView');
const {
  canvasNodeCredentialScope,
  canvasStringContainsHostCredentialField,
  isHostCredentialFieldKey,
  isPublicCanvasResourceTokenField,
} = require('./canvasPatch');
const { OPERATION_PAYLOAD_KEYS } = require('../collaboration/protocol');

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
const PRIVATE_AUTH_TRANSACTION_KEYS = new Set([
  'authorizationcode',
  'codeverifier',
  'devicecode',
  'oauthloginurl',
  'oauthloginsessionid',
  'oauthstate',
  'pkceverifier',
  'usercode',
  'verificationuricomplete',
]);
const GENERIC_APPLICATION_KEY_COLLECTION_KEYS = new Set([
  'categories',
  'defaults',
  'fields',
  'inputs',
  'items',
  'outputs',
  'parameters',
  'params',
  'presets',
  'shortcuts',
  'tabs',
]);
const GENERIC_APPLICATION_KEY_COMPANION_KEYS = new Set([
  'description',
  'id',
  'kind',
  'label',
  'placeholder',
  'shortcut',
  'title',
  'type',
]);
const CREDENTIAL_DESCRIPTOR_KEYS = new Set([
  'field', 'fieldname', 'header', 'headername', 'id', 'name',
  'key', 'parameter', 'parametername', 'property', 'propertyname',
]);
const CREDENTIAL_DESCRIPTOR_VALUE_KEYS = new Set(['content', 'defaultvalue', 'secret', 'value']);
const CANVAS_FIELD_LIST_KEYS = new Set(['unsetkeys', 'dataunsetkeys']);
const INLINE_SECRET_PATTERN = /(?:\bBearer\s+[^\s,;"'`<>]+|\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{8,}\b|\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b)/i;

function normalizePublicKey(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPrivatePathKey(value) {
  return PRIVATE_PATH_KEYS.has(normalizePublicKey(value));
}

function isPrivateAuthTransactionKey(value) {
  return PRIVATE_AUTH_TRANSACTION_KEYS.has(normalizePublicKey(value));
}

function isCanvasFieldListKey(value) {
  return CANVAS_FIELD_LIST_KEYS.has(normalizePublicKey(value));
}

function isPrivateAuthContextField(value, parentKey = '', path = []) {
  const canonical = normalizePublicKey(value);
  if (canonical !== 'code' && canonical !== 'state') return false;
  const contexts = [parentKey, ...(Array.isArray(path) ? path : [])].map(normalizePublicKey);
  return contexts.some((context) => (
    context.includes('oauth')
    || context.includes('authorization')
    || context.includes('callback')
    || context.includes('device')
    || context.includes('pkce')
    || context.includes('signin')
    || context.includes('login')
    || context.includes('sso')
    || /auth(?:response|result|params|parameters|payload|data|session|state|code)/.test(context)
  ));
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

function decodedTextIsUnsafe(value, key = '', scope = '') {
  const text = String(value || '');
  if (!text) return false;
  if (/^data:[^;,\s]+;base64,/i.test(text.trim())) return true;
  if (containsLocalPath(text)
    || canvasStringContainsHostCredentialField(text, { parentKey: key, scope })) return true;
  return redactLocalPaths(text, { preservePublicUrl: preservePublicUrl(text) }) !== text;
}

function publicString(value, key = '', scope = '') {
  const raw = String(value);
  if (/^data:[^;,\s]+;base64,/i.test(raw.trim())) return '[binary]';
  if (INLINE_SECRET_PATTERN.test(raw)) return '[redacted]';
  if (canvasStringContainsHostCredentialField(raw, { parentKey: key, scope })) {
    return '[redacted]';
  }
  for (const decoded of [...decodedUrlCandidates(raw), ...decodedOpaqueCandidates(raw)]) {
    if (decodedTextIsUnsafe(decoded, key, scope)) return '[redacted]';
  }
  return redactLocalPaths(raw, { preservePublicUrl: preservePublicUrl(raw) });
}

function genericApplicationKeyIsSafe(item, container, parentKey = '') {
  if (typeof item !== 'string'
    || !item
    || item.length > 240
    || INLINE_SECRET_PATTERN.test(item)
    || isHostCredentialFieldKey(item)
    || !container
    || typeof container !== 'object'
    || Array.isArray(container)) return false;
  const containerKeys = new Set(Object.keys(container).map(normalizePublicKey));
  if ([...CREDENTIAL_DESCRIPTOR_VALUE_KEYS].some((key) => containerKeys.has(key))) return true;
  return GENERIC_APPLICATION_KEY_COLLECTION_KEYS.has(normalizePublicKey(parentKey))
    && [...GENERIC_APPLICATION_KEY_COMPANION_KEYS].some((key) => containerKeys.has(key));
}

function publicFieldName(value, scope, container, parentKey = '', path = []) {
  const raw = String(value);
  if (UNSAFE_OBJECT_KEYS.has(raw)
    || isPrivatePathKey(raw)
    || isPrivateAuthTransactionKey(raw)
    || isPrivateAuthContextField(raw, parentKey, path)) return null;
  if (isHostCredentialFieldKey(raw) && !isPublicCanvasResourceTokenField(raw, scope, path)) {
    if (normalizePublicKey(raw) !== 'key'
      || !genericApplicationKeyIsSafe(container?.[raw], container, parentKey)) return null;
  }
  return publicString(raw, parentKey, scope) === raw ? raw : null;
}

function objectDescribesCredential(value, scope, path = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (!entries.some(([key]) => CREDENTIAL_DESCRIPTOR_VALUE_KEYS.has(normalizePublicKey(key)))) return false;
  return entries.some(([key, item]) => (
    CREDENTIAL_DESCRIPTOR_KEYS.has(normalizePublicKey(key))
    && typeof item === 'string'
    && isHostCredentialFieldKey(item)
    && !isPublicCanvasResourceTokenField(item, scope, path)
  ));
}

function publicCollaborationCanvasValue(
  value,
  key = '',
  depth = 0,
  state = null,
  inheritedScope = '',
  path = [],
) {
  const context = state || { remaining: PUBLIC_VALUE_MAX_NODES, seen: new WeakSet() };
  if (context.remaining <= 0 || depth > PUBLIC_VALUE_MAX_DEPTH) return '[truncated]';
  context.remaining -= 1;
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return publicString(value, key, inheritedScope);
  if (typeof value !== 'object' || Buffer.isBuffer(value)) return null;
  if (context.seen.has(value)) return '[cycle]';
  context.seen.add(value);
  const scope = inheritedScope;
  if (Array.isArray(value)) {
    if (!isCanvasFieldListKey(key)
      && value.length >= 2
      && typeof value[0] === 'string'
      && (isHostCredentialFieldKey(value[0]) || isPrivateAuthContextField(value[0], key, path))) {
      context.seen.delete(value);
      return ['[redacted-field]', '[redacted]'];
    }
    const output = value.map((item) => (
      publicCollaborationCanvasValue(item, key, depth + 1, context, scope, path)
    ));
    context.seen.delete(value);
    return output;
  }
  const output = {};
  const credentialDescriptor = objectDescribesCredential(value, scope, path);
  for (const [rawKey, item] of Object.entries(value)) {
    const publicKey = publicFieldName(rawKey, scope, value, key, path);
    if (!publicKey) continue;
    if (credentialDescriptor && CREDENTIAL_DESCRIPTOR_VALUE_KEYS.has(normalizePublicKey(rawKey))) {
      output[publicKey] = '[redacted]';
      continue;
    }
    output[publicKey] = publicCollaborationCanvasValue(
      item,
      publicKey,
      depth + 1,
      context,
      scope,
      [...path, rawKey],
    );
  }
  context.seen.delete(value);
  return output;
}

function publicCanvasDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document) || !Array.isArray(document.nodes)) {
    return publicCollaborationCanvasValue(document);
  }
  const envelope = publicCollaborationCanvasValue({ ...document, nodes: [] });
  envelope.nodes = document.nodes.map((node) => (
    publicCollaborationCanvasValue(node, '', 0, null, canvasNodeCredentialScope(node), [])
  ));
  return envelope;
}

function publicSubflowDefinition(definition) {
  return publicCanvasDocument(definition);
}

function publicCanvasMutationResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return publicCollaborationCanvasValue(result);
  }
  const hasDocument = result.document && typeof result.document === 'object' && !Array.isArray(result.document);
  const hasResultingDocument = result.resultingDocument
    && typeof result.resultingDocument === 'object'
    && !Array.isArray(result.resultingDocument);
  const envelope = publicCollaborationCanvasValue({
    ...result,
    ...(hasDocument ? { document: null } : {}),
    ...(hasResultingDocument ? { resultingDocument: null } : {}),
  });
  if (hasDocument) envelope.document = publicCanvasDocument(result.document);
  if (hasResultingDocument) {
    envelope.resultingDocument = publicCanvasDocument(result.resultingDocument);
  }
  return envelope;
}

function publicCanvasSync(sync, document = null) {
  if (!sync || typeof sync !== 'object' || Array.isArray(sync)) {
    return publicCollaborationCanvasValue(sync);
  }
  if (sync.document && typeof sync.document === 'object' && !Array.isArray(sync.document)) {
    const snapshot = publicCollaborationCanvasValue({ ...sync, document: null });
    snapshot.document = publicCanvasDocument(sync.document);
    return snapshot;
  }
  if (sync.snapshot && typeof sync.snapshot === 'object' && !Array.isArray(sync.snapshot)) {
    const snapshot = publicCollaborationCanvasValue({ ...sync, snapshot: null });
    snapshot.snapshot = publicCanvasDocument(sync.snapshot);
    return snapshot;
  }
  if (!Array.isArray(sync.operations)) return publicCollaborationCanvasValue(sync);
  const nodesById = new Map();
  (Array.isArray(document?.nodes) ? document.nodes : []).forEach((node) => {
    if (node?.id != null) nodesById.set(String(node.id), node);
    if (node?.entityUid != null) nodesById.set(String(node.entityUid), node);
  });
  const envelope = publicCollaborationCanvasValue({ ...sync, operations: [] });
  envelope.operations = sync.operations.map((operation) => {
    const payload = operation?.payload && typeof operation.payload === 'object' && !Array.isArray(operation.payload)
      ? operation.payload
      : {};
    const nodeId = String(payload.nodeId || payload.node?.id || '');
    const node = nodesById.get(nodeId);
    const operationType = String(operation?.type || '');
    const addedNode = ['node.add', 'node.restore'].includes(operationType)
      && payload.node
      && typeof payload.node === 'object'
      && !Array.isArray(payload.node)
      ? payload.node
      : null;
    const scope = operationType === 'node.patch'
      ? canvasNodeCredentialScope(node)
      : canvasNodeCredentialScope(addedNode);
    const canonicalPayload = {};
    for (const key of OPERATION_PAYLOAD_KEYS[operationType] || []) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) canonicalPayload[key] = payload[key];
    }
    return publicCollaborationCanvasValue(
      { ...operation, payload: canonicalPayload },
      '',
      0,
      null,
      scope,
      [],
    );
  });
  return envelope;
}

module.exports = {
  publicCanvasDocument,
  publicCanvasMutationResult,
  publicCanvasSync,
  publicCollaborationCanvasValue,
  publicSubflowDefinition,
};
