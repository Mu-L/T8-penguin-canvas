const path = require('path');

const PUBLIC_VALUE_MAX_DEPTH = 12;
const PUBLIC_VALUE_MAX_ARRAY_ITEMS = 200;
const PUBLIC_VALUE_MAX_OBJECT_KEYS = 200;
const PUBLIC_VALUE_MAX_NODES = 5000;
const PUBLIC_VALUE_MAX_STRING_LENGTH = 16 * 1024;
const PUBLIC_VALUE_MAX_TOTAL_STRING_LENGTH = 256 * 1024;
const PUBLIC_LINEAGE_MAX_ITEMS = 1000;
const PUBLIC_SOURCE_GRAPH_MAX_NODES = 500;
const PUBLIC_SOURCE_GRAPH_MAX_EDGES = 1000;
const PUBLIC_SOURCE_GRAPH_MAX_VALUES = 20_000;
const PUBLIC_SOURCE_GRAPH_MAX_STRING_LENGTH = 512 * 1024;

const PRIVATE_PATH_KEYS = new Set([
  'absolutepath',
  'blobid',
  'filesystempath',
  'globalblobid',
  'localpath',
  'managedpath',
  'sourcelocator',
  'sourcepath',
]);

const SENSITIVE_KEYS = new Set([
  'accesskeyid',
  'apikey',
  'apisecret',
  'auth',
  'authorization',
  'awsaccesskeyid',
  'bearertoken',
  'clientsecret',
  'cookie',
  'credential',
  'credentials',
  'idtoken',
  'key',
  'passphrase',
  'password',
  'passwd',
  'privatekey',
  'proxyauthorization',
  'refreshtoken',
  'secret',
  'secretaccesskey',
  'secretkey',
  'secrets',
  'sessiontoken',
  'setcookie',
  'signature',
  'signingkey',
  'sig',
  'token',
  'tokens',
  'xapikey',
  'xamzcredential',
  'xamzsecuritytoken',
  'xamzsignature',
  'xgoogcredential',
  'xgoogsecuritytoken',
  'xgoogsignature',
]);

const SECRET_QUERY_KEYS = new Set([
  'access_token', 'accesstoken', 'api_key', 'apikey', 'authorization', 'key', 'sig', 'signature', 'token',
  'x-amz-credential', 'x-amz-security-token', 'x-amz-signature',
  'x-goog-credential', 'x-goog-security-token', 'x-goog-signature',
]);
const LOCAL_POSIX_PATH_RE = /(^|[\s("'`=,:;?&#])\/(?:Users|home|tmp|var|private|mnt|workspace)(?:\/|$)/i;

function normalizePublicKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitivePublicKey(value) {
  const normalized = normalizePublicKey(value);
  if (!normalized) return false;
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return /(?:token|apikey|authorization|cookie|password|passwd|passphrase|credential|secret|signature)/.test(normalized)
    || /^(?:aws)?accesskey(?:id)?$/.test(normalized)
    || /^(?:api|client|private|secret|signing)key$/.test(normalized);
}

function redactSecrets(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s,;"'`<>]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/["']?\b(Authorization|Proxy-Authorization|X-Api-Key|Api[_-]?Key|Access[_-]?Token|Refresh[_-]?Token|Session[_-]?Token|Cookie|Set-Cookie|Password|Passwd|Credential|Client-Secret|Secret|Signature)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;"'`<>]+)/gi, '$1: [redacted]')
    .replace(/([?&](?:access_?token|refresh_?token|session_?token|api_?key|client_?secret|credential|key|password|secret|signature|sig|token|x-amz-(?:credential|signature|security-token)|x-goog-(?:credential|signature|security-token))=)[^&#\s"'`<>]+/gi, '$1[redacted]');
}

function decodedCandidates(value) {
  const candidates = [String(value || '')];
  try {
    const decoded = decodeURIComponent(candidates[0]);
    if (decoded !== candidates[0]) candidates.push(decoded);
  } catch (_) {}
  return candidates;
}

function containsLocalPath(value) {
  return decodedCandidates(value).some((candidate) => (
    /(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(candidate)
    || /^\\\\/.test(candidate)
    || LOCAL_POSIX_PATH_RE.test(candidate)
  ));
}

function sanitizePublicUrl(value) {
  const raw = String(value || '').trim();
  const absolute = /^https?:\/\//i.test(raw);
  let parsed;
  try {
    parsed = new URL(raw, 'http://t8-public.invalid');
  } catch (_) {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  if (!absolute && parsed.origin !== 'http://t8-public.invalid') return null;

  parsed.username = '';
  parsed.password = '';
  for (const [key, item] of [...parsed.searchParams.entries()]) {
    const normalizedKey = key.trim().toLowerCase();
    if (SECRET_QUERY_KEYS.has(normalizedKey) || isSensitivePublicKey(normalizedKey)) parsed.searchParams.set(key, '[redacted]');
    else if (containsLocalPath(item)) parsed.searchParams.set(key, '[local-path]');
    else parsed.searchParams.set(key, redactSecrets(item));
  }
  if (containsLocalPath(parsed.hash.slice(1))) parsed.hash = '#[local-path]';
  if (containsLocalPath(parsed.pathname)) parsed.pathname = '/[local-path]';

  if (absolute) return parsed.toString();
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function redactLocalPaths(value, options = {}) {
  if (options.preservePublicUrl) {
    const publicUrl = sanitizePublicUrl(value);
    if (publicUrl) return publicUrl;
  }
  let safe = redactSecrets(value)
    // Require a boundary so the `s:/` in `https://` is not mistaken for a drive.
    .replace(/(^|[^A-Za-z0-9])([A-Za-z]:[\\/][^\r\n"'`<>]+)/g, '$1[local-path]')
    .replace(/\\\\[^\r\n"'`<>]+/g, '[local-path]');
  if (!options.preservePublicUrl) {
    safe = safe.replace(/(^|[\s("'`=,:;?&#])\/{1,2}[^\r\n"'`<>]+/g, '$1[local-path]');
  }
  return safe;
}

function linkedBasename(value) {
  const normalized = String(value || '').replace(/\\/g, '/');
  return path.posix.basename(normalized) || null;
}

function sanitizePublicValue(value, options = {}, depth = 0, key = '', state = null) {
  const context = state || {
    remaining: PUBLIC_VALUE_MAX_NODES,
    remainingStringChars: PUBLIC_VALUE_MAX_TOTAL_STRING_LENGTH,
    seen: new WeakSet(),
  };
  if (context.remaining <= 0 || depth > PUBLIC_VALUE_MAX_DEPTH) return null;
  context.remaining -= 1;
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const preservePublicUrl = /urls?$/i.test(key)
      && /^(?:https?:\/\/|\/(?:api|files|input|output)\/)/i.test(value.trim());
    const safe = redactLocalPaths(value, { preservePublicUrl });
    const aggregateLimit = Number.isFinite(context.remainingStringChars)
      ? Math.max(0, context.remainingStringChars)
      : PUBLIC_VALUE_MAX_STRING_LENGTH;
    const output = safe.slice(0, Math.min(PUBLIC_VALUE_MAX_STRING_LENGTH, aggregateLimit));
    if (Number.isFinite(context.remainingStringChars)) context.remainingStringChars -= output.length;
    return output;
  }
  if (depth >= PUBLIC_VALUE_MAX_DEPTH) return null;
  if (Array.isArray(value)) {
    if (context.seen.has(value)) return null;
    context.seen.add(value);
    const output = value
      .slice(0, PUBLIC_VALUE_MAX_ARRAY_ITEMS)
      .map((item) => sanitizePublicValue(item, options, depth + 1, key, context));
    context.seen.delete(value);
    return output;
  }
  if (typeof value !== 'object' || Buffer.isBuffer(value)) return null;
  if (context.seen.has(value)) return null;
  context.seen.add(value);

  const output = {};
  Object.entries(value).slice(0, PUBLIC_VALUE_MAX_OBJECT_KEYS).forEach(([key, item]) => {
    const normalizedKey = normalizePublicKey(key);
    if (['__proto__', 'constructor', 'prototype'].includes(String(key))) return;
    if (PRIVATE_PATH_KEYS.has(normalizedKey)) return;
    if (isSensitivePublicKey(normalizedKey)) return;
    if (normalizedKey === 'relativepath' && options.storageMode === 'linked') {
      const basename = linkedBasename(item);
      if (basename) output[key] = sanitizePublicValue(basename, options, depth + 1, key, context);
      return;
    }
    output[key] = sanitizePublicValue(item, options, depth + 1, key, context);
  });
  context.seen.delete(value);
  return output;
}

function sanitizePublicAsset(asset, state = null) {
  if (!asset) return null;
  return sanitizePublicValue(asset, { storageMode: asset.storageMode }, 0, '', state);
}

function publicAsset(asset) {
  return sanitizePublicAsset(asset);
}

function sanitizePublicAssetLineage(lineage, state = null) {
  if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage)) return null;
  const context = state || {
    remaining: PUBLIC_VALUE_MAX_NODES,
    remainingStringChars: PUBLIC_VALUE_MAX_TOTAL_STRING_LENGTH,
    seen: new WeakSet(),
  };
  const output = {};
  [
    'id',
    'eventId',
    'childAssetId',
    'parentAssetId',
    'sourceAssetId',
    'targetAssetId',
    'from',
    'to',
    'type',
    'direction',
    'depth',
    'relation',
    'sourceType',
    'sourceNodeId',
    'sourceNodeType',
    'runId',
    'nodeRunId',
    'attemptId',
    'canvasId',
    'creatorId',
    'promptSummary',
    'promptDigest',
    'derivedOperation',
    'metadata',
    'createdAt',
  ].forEach((key) => {
    if (!Object.hasOwn(lineage, key)) return;
    output[key] = sanitizePublicValue(lineage[key], {}, 0, key, context);
  });
  return output;
}

function publicAssetLineage(lineage) {
  return sanitizePublicAssetLineage(lineage);
}

function publicAssetLineageList(lineage, state = null) {
  const context = state || {
    remaining: PUBLIC_SOURCE_GRAPH_MAX_VALUES,
    remainingStringChars: PUBLIC_SOURCE_GRAPH_MAX_STRING_LENGTH,
    seen: new WeakSet(),
  };
  return (Array.isArray(lineage) ? lineage : [])
    .slice(0, PUBLIC_LINEAGE_MAX_ITEMS)
    .map((item) => sanitizePublicAssetLineage(item, context))
    .filter(Boolean);
}

function publicSourceGraphNode(node, state) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const output = {};
  ['id', 'assetId', 'tombstone', 'depth', 'direction', 'parentAssetId'].forEach((key) => {
    if (Object.hasOwn(node, key)) output[key] = sanitizePublicValue(node[key], {}, 0, key, state);
  });
  if (node.asset) output.asset = sanitizePublicAsset(node.asset, state);
  return output;
}

function publicAssetSourceGraph(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return null;
  const state = {
    remaining: PUBLIC_SOURCE_GRAPH_MAX_VALUES,
    remainingStringChars: PUBLIC_SOURCE_GRAPH_MAX_STRING_LENGTH,
    seen: new WeakSet(),
  };
  const output = {};
  [
    'rootAssetId',
    'direction',
    'maxDepth',
    'maxNodes',
    'cycleDetected',
    'truncated',
    'totalNodes',
    'totalEdges',
    'nextCursor',
  ].forEach((key) => {
    if (Object.hasOwn(graph, key)) output[key] = sanitizePublicValue(graph[key], {}, 0, key, state);
  });
  output.nodes = (Array.isArray(graph.nodes) ? graph.nodes : [])
    .slice(0, PUBLIC_SOURCE_GRAPH_MAX_NODES)
    .map((node) => publicSourceGraphNode(node, state))
    .filter(Boolean);
  output.edges = publicAssetLineageList(
    (Array.isArray(graph.edges) ? graph.edges : []).slice(0, PUBLIC_SOURCE_GRAPH_MAX_EDGES),
    state,
  );
  if (Array.isArray(graph.lineage)) {
    output.lineage = publicAssetLineageList(graph.lineage.slice(0, PUBLIC_SOURCE_GRAPH_MAX_EDGES), state);
  }
  if (Array.isArray(graph.cycles)) {
    output.cycles = sanitizePublicValue(graph.cycles.slice(0, PUBLIC_SOURCE_GRAPH_MAX_EDGES), {}, 0, 'cycles', state);
  }
  if (graph.nodes?.length > PUBLIC_SOURCE_GRAPH_MAX_NODES || graph.edges?.length > PUBLIC_SOURCE_GRAPH_MAX_EDGES) {
    output.truncated = true;
  }
  return output;
}

module.exports = {
  containsLocalPath,
  publicAsset,
  publicAssetLineage,
  publicAssetLineageList,
  publicAssetSourceGraph,
  redactLocalPaths,
  sanitizePublicUrl,
  sanitizePublicValue,
};
