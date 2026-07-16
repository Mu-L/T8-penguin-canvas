const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const BetterSqlite3 = require('better-sqlite3');
const { ACTIVE_STATUSES, isRecoverableRunAttempt, normalizeRunRecoveryDescriptor } = require('./runRecovery');
const { explicitRunCost } = require('./runUsage');
const {
  DEFAULT_PROJECT_ID,
  assertCanvasDocumentInvariants,
  isUuid,
  normalizeCanvasDocument,
  applyCanvasOperation,
  stableEntityUuid,
  validateOperation,
} = require('../collaboration/protocol');
const {
  CANVAS_PATCH_CONTRACT,
  CanvasPatchConflictError,
  CanvasPatchConfirmationError,
  CanvasPatchNotFoundError,
  CanvasPatchPermissionError,
  CanvasPatchRevertConflictError,
  CanvasPatchValidationError,
  assertCanvasDocumentCredentialAuthority,
  assertCanvasOperationCredentialAuthority,
  assertCanvasPatchPostconditions,
  buildCanvasPatchPlan,
  canvasPatchRequestDigest,
  safeIdentifier,
  safePatchValue,
  scopedCanvasPatchOperationId,
  validateCanvasPatch,
} = require('./canvasPatch');
const {
  deriveRunIntentAuthority,
  summarizeRunIntentAuthority,
} = require('../collaboration/runIntentAuthority');
const {
  MAX_ASSET_REFERENCES,
  MAX_SUBFLOW_REFERENCES,
  collectCanvasResourceReferences,
  subflowDefinitionContentDigest,
  subflowReferenceKey,
} = require('./canvasResourceScope');

const PROJECT_DATABASE_SCHEMA_VERSION = 23;
const OPERATION_SNAPSHOT_INTERVAL = 100;
const CANVAS_PROVENANCE_GUARD_VERSION = 1;
const CANVAS_PROVENANCE_GUARD_LIMIT = 2000;
const RESERVED_CANVAS_PATCH_OPERATION_ID_PREFIX = 'canvas-patch:';
const CANVAS_RESOURCE_DOCUMENT_SOURCE = 'canvas-document';
const CANVAS_RESOURCE_LINEAGE_SOURCE = 'lineage';
const CANVAS_RESOURCE_PUBLISH_SOURCE = 'collaboration-publish';

const ASSET_STORAGE_MODES = new Set(['managed', 'linked', 'remote', 'embedded']);
const ASSET_AVAILABILITY_STATES = new Set(['available', 'missing', 'corrupt', 'unverified']);
const ASSET_PREVIEW_JOB_STATUSES = new Set(['queued', 'running', 'retrying', 'succeeded', 'failed']);
const ASSET_FINGERPRINT_ALGORITHMS = new Set(['dhash64-v1', 'phash-dct64-v1']);
const ASSET_DUPLICATE_DECISIONS = new Set(['pending', 'confirmed', 'dismissed']);
const ASSET_ACCESS_SCOPES = new Set(['project', 'restricted']);
const ASSET_ACCESS_PERMISSIONS = new Set(['view', 'preview', 'original', 'organize', 'manage_acl']);
const ASSET_ACCESS_PRINCIPALS = new Set(['member', 'role']);
const ASSET_BATCH_EXPLICIT_LIMIT = 500;
const ASSET_BATCH_QUERY_LIMIT = 10_000;
const ASSET_DUPLICATE_PAGE_LIMIT = 200;
const ASSET_SOURCE_GRAPH_HARD_LIMIT = 5_000;
const ASSET_SOURCE_GRAPH_EDGE_PAGE_LIMIT = 240;
const ASSET_SEMANTIC_CAPABILITIES = new Set(['caption', 'ocr', 'embedding']);
const ASSET_SEMANTIC_MODEL_STATUSES = new Set(['not-installed', 'downloading', 'verifying', 'installed', 'failed', 'disabled', 'deleting']);
const ASSET_SEMANTIC_JOB_STATUSES = new Set(['queued', 'running', 'retrying', 'succeeded', 'skipped', 'failed', 'superseded']);
const ASSET_SEMANTIC_GENERATION_STATUSES = new Set(['building', 'ready', 'active', 'failed', 'superseded']);
const ASSET_SEMANTIC_SEARCH_HARD_LIMIT = 50_000;
const ASSET_SEMANTIC_VECTOR_MAX_DIMENSIONS = 8192;
const ASSET_UPLOAD_ACTIVE_STATUSES = new Set(['uploading', 'paused', 'assembling']);
const ASSET_UPLOAD_STATUSES = new Set([...ASSET_UPLOAD_ACTIVE_STATUSES, 'completed', 'cancelled', 'expired', 'failed']);
const PROMPT_FIELD_PATTERN = /(?:^|[_-])(?:prompt|instruction|description|caption|query|text)(?:$|[_-])/i;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;
const HASH64_HEX_PATTERN = /^[a-f0-9]{16}$/i;

function normalizeSemanticIdentity(value, label = 'semantic identity', maxLength = 240) {
  const normalized = String(value || '').normalize('NFKC').trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} 无效`);
  }
  return normalized;
}

function normalizeSemanticCapability(value) {
  const capability = String(value || '').trim().toLowerCase();
  if (!ASSET_SEMANTIC_CAPABILITIES.has(capability)) throw new Error('语义模型能力无效');
  return capability;
}

function normalizeSemanticText(value, label = '语义文本') {
  const text = String(value || '').normalize('NFKC').replace(/\u0000/g, '').trim();
  if (!text || text.length > 32_000) throw new Error(`${label}为空或超过 32000 字符`);
  return text;
}

function normalizeEmbeddingValues(value) {
  if (Buffer.isBuffer(value)) throw new Error('Embedding 必须提供数值数组，不能假定 Buffer 字节序');
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw new Error('Embedding 必须是数值数组');
  const values = Array.from(value, Number);
  if (values.length < 1 || values.length > ASSET_SEMANTIC_VECTOR_MAX_DIMENSIONS) {
    throw new Error(`Embedding 维度必须在 1-${ASSET_SEMANTIC_VECTOR_MAX_DIMENSIONS} 之间`);
  }
  let squaredNorm = 0;
  for (const item of values) {
    if (!Number.isFinite(item)) throw new Error('Embedding 包含非有限数值');
    squaredNorm += item * item;
  }
  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm <= 0) throw new Error('Embedding 向量范数必须大于 0');
  return { values, dimensions: values.length, norm };
}

function encodeFloat32LE(value) {
  const normalized = normalizeEmbeddingValues(value);
  const blob = Buffer.allocUnsafe(normalized.dimensions * 4);
  normalized.values.forEach((item, index) => blob.writeFloatLE(item, index * 4));
  return { blob, dimensions: normalized.dimensions, norm: normalized.norm };
}

function decodeFloat32LE(blob, dimensions) {
  if (!Buffer.isBuffer(blob)) throw new Error('Embedding 存储不是 Buffer');
  const expectedDimensions = Math.trunc(Number(dimensions));
  if (expectedDimensions < 1 || expectedDimensions > ASSET_SEMANTIC_VECTOR_MAX_DIMENSIONS
    || blob.length !== expectedDimensions * 4) {
    throw new Error('Embedding Float32LE 长度与维度不一致');
  }
  const values = new Array(expectedDimensions);
  for (let index = 0; index < expectedDimensions; index += 1) {
    const value = blob.readFloatLE(index * 4);
    if (!Number.isFinite(value)) throw new Error('Embedding Float32LE 包含非有限数值');
    values[index] = value;
  }
  return values;
}

function cosineSimilarity(left, right) {
  const normalizedLeft = normalizeEmbeddingValues(left);
  const normalizedRight = normalizeEmbeddingValues(right);
  if (normalizedLeft.dimensions !== normalizedRight.dimensions) throw new Error('Embedding 维度不一致');
  let dot = 0;
  for (let index = 0; index < normalizedLeft.dimensions; index += 1) {
    dot += normalizedLeft.values[index] * normalizedRight.values[index];
  }
  const result = dot / (normalizedLeft.norm * normalizedRight.norm);
  if (!Number.isFinite(result)) throw new Error('Embedding 余弦相似度无效');
  return Math.max(-1, Math.min(1, result));
}

function normalizeSemanticMetadata(value, maxLength = 32_000) {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const serialized = JSON.stringify(metadata);
  if (serialized.length > maxLength) throw new Error(`语义元数据超过 ${maxLength} 字符`);
  return { value: metadata, serialized };
}

function semanticProfileConfig(profile = {}) {
  const capability = (name) => ({
    enabled: Boolean(profile?.[name]?.enabled),
    modelKey: profile?.[name]?.modelKey ? String(profile[name].modelKey) : null,
    modelVersion: profile?.[name]?.modelVersion ? String(profile[name].modelVersion) : null,
  });
  return {
    enabled: Boolean(profile.enabled),
    caption: capability('caption'),
    ocr: capability('ocr'),
    embedding: capability('embedding'),
  };
}

function semanticProfileDigest(profile = {}) {
  return crypto.createHash('sha256').update(stableJson(semanticProfileConfig(profile))).digest('hex');
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function escapeLikePattern(value) {
  return String(value || '').replace(/[\\%_]/g, (match) => `\\${match}`);
}

function hammingDistanceHex(left, right) {
  if (!/^[a-f0-9]{16}$/i.test(String(left || '')) || !/^[a-f0-9]{16}$/i.test(String(right || ''))) return Infinity;
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value) { count += Number(value & 1n); value >>= 1n; }
  return count;
}

function median(values = []) {
  const sorted = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return Infinity;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeSha256(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return SHA256_HEX_PATTERN.test(normalized) ? normalized : null;
}

function normalizeHash64(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return HASH64_HEX_PATTERN.test(normalized) ? normalized : null;
}

function normalizeFingerprintAlgorithm(value, fallback = null) {
  const normalized = String(value || '').trim().toLowerCase();
  return ASSET_FINGERPRINT_ALGORITHMS.has(normalized) ? normalized : fallback;
}

function fingerprintBands(hash) {
  const normalized = normalizeHash64(hash);
  if (!normalized) return Array(9).fill(null);
  const bits = BigInt(`0x${normalized}`).toString(2).padStart(64, '0');
  // Nine disjoint bands guarantee at least one unchanged band for hashes with
  // Hamming distance <= 8. The final distance check remains authoritative.
  const widths = [8, 7, 7, 7, 7, 7, 7, 7, 7];
  let offset = 0;
  return widths.map((width) => {
    const band = bits.slice(offset, offset + width);
    offset += width;
    return band;
  });
}

function normalizeTags(tags = []) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(tags) ? tags : []) {
    const tag = String(value || '').normalize('NFKC').trim().slice(0, 60);
    const key = tag.toLocaleLowerCase('und');
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= 100) break;
  }
  return result;
}

function normalizeAccessPermissions(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => ASSET_ACCESS_PERMISSIONS.has(value)))].sort();
}

function normalizeFingerprintEntries(input = {}, asset = {}) {
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : (asset.metadata || {});
  const rawEntries = input.perceptualHashes
    ?? input.fingerprints
    ?? metadata.perceptualHashes
    ?? metadata.fingerprints;
  const hasMultiple = Array.isArray(rawEntries) && rawEntries.length > 0;
  const algorithm = normalizeFingerprintAlgorithm(
    input.perceptualHashAlgorithm
      ?? input.algorithm
      ?? metadata.perceptualHashAlgorithm
      ?? metadata.fingerprintAlgorithm,
    hasMultiple ? 'phash-dct64-v1' : (normalizeHash64(input.perceptualHash ?? metadata.perceptualHash ?? asset.perceptualHash) ? 'dhash64-v1' : null),
  );
  if (!algorithm) return { algorithm: null, entries: [] };
  const durationMs = Math.max(0, Number(metadata.duration ?? asset.metadata?.duration) || 0) * 1000;
  const source = hasMultiple ? rawEntries : [input.perceptualHash ?? metadata.perceptualHash ?? asset.perceptualHash];
  const entries = [];
  for (let index = 0; index < source.length && entries.length < 64; index += 1) {
    const raw = source[index];
    const hash = normalizeHash64(raw && typeof raw === 'object' ? (raw.hash ?? raw.hashHex ?? raw.perceptualHash) : raw);
    if (!hash) continue;
    const frameIndex = Math.max(0, Math.min(100_000, Math.trunc(Number(raw?.frameIndex ?? raw?.index ?? index) || 0)));
    const timestampMsValue = Number(raw?.timestampMs ?? (Number.isFinite(Number(raw?.time)) ? Number(raw.time) * 1000 : NaN));
    const timestampMs = Number.isFinite(timestampMsValue) && timestampMsValue >= 0 ? Math.round(timestampMsValue) : null;
    const normalizedValue = Number(raw?.normalizedTime);
    const normalizedTime = Number.isFinite(normalizedValue)
      ? Math.max(0, Math.min(1, normalizedValue))
      : (durationMs > 0 && timestampMs != null ? Math.max(0, Math.min(1, timestampMs / durationMs)) : null);
    entries.push({
      hash,
      frameKind: String(raw?.frameKind || (asset.kind === 'video' ? 'video-keyframe' : 'image')).slice(0, 40),
      frameIndex,
      timestampMs,
      normalizedTime,
      evidence: raw?.evidence && typeof raw.evidence === 'object' ? raw.evidence : {},
    });
  }
  return { algorithm, entries };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function canvasOperationPayloadDigest(payload) {
  return crypto.createHash('sha256').update(stableJson(payload)).digest('hex');
}

function canvasOperationIdentityMatches(row, operation) {
  if (!row) return false;
  const storedBaseRevision = row.base_revision == null ? null : Number(row.base_revision);
  const operationBaseRevision = operation.baseRevision == null ? null : Number(operation.baseRevision);
  return row.canvas_id === operation.canvasId
    && row.project_id === operation.projectId
    && row.actor_id === operation.actorId
    && row.session_id === operation.sessionId
    && row.type === operation.type
    && Number(row.client_seq) === Number(operation.clientSeq)
    && storedBaseRevision === operationBaseRevision
    && row.payload_digest === canvasOperationPayloadDigest(operation.payload);
}

function assertUnreservedCanvasOperationId(opId) {
  if (String(opId || '').toLowerCase().startsWith(RESERVED_CANVAS_PATCH_OPERATION_ID_PREFIX)) {
    throw new OperationIdReservedError();
  }
}

function opaqueSourceLocator(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^asset_source_[a-f0-9]{64}$/i.test(raw)) return raw.toLowerCase();
  if (/^sha256:[a-f0-9]{64}$/i.test(raw)) return raw.toLowerCase();
  return `sha256:${crypto.createHash('sha256').update(raw.replace(/\\/g, '/').normalize('NFKC').toLowerCase()).digest('hex')}`;
}

function stableAssetSourceLocator(projectId, rootName, relativePath) {
  const normalizedPath = String(relativePath || '').replace(/\\/g, '/').toLowerCase();
  const digest = crypto.createHash('sha256').update(JSON.stringify([
    String(projectId || DEFAULT_PROJECT_ID),
    String(rootName || 'linked').toLowerCase(),
    normalizedPath,
  ])).digest('hex');
  return `asset_source_${digest}`;
}

function revisionConflict(code, message, current = null) {
  const error = new Error(message);
  error.code = code;
  error.current = current;
  return error;
}

function assetUploadError(code, message, current = null, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.current = current;
  error.status = status;
  return error;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value, fallback = {}) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function normalizeAssetStorageMode(value, managedPath, sourceUrl) {
  const explicit = String(value || '').trim().toLowerCase();
  if (ASSET_STORAGE_MODES.has(explicit)) return explicit;
  if (managedPath) return 'managed';
  if (/^https?:\/\//i.test(String(sourceUrl || ''))) return 'remote';
  if (!sourceUrl) return 'embedded';
  return 'linked';
}

function normalizeAssetAvailability(value, storageMode) {
  const explicit = String(value || '').trim().toLowerCase();
  if (ASSET_AVAILABILITY_STATES.has(explicit)) return explicit;
  return storageMode === 'remote' ? 'unverified' : 'available';
}

function promptSummaryFromSnapshot(snapshot) {
  const collected = [];
  const seen = new Set();
  const visit = (value, key = '', depth = 0) => {
    if (depth > 7 || collected.join('\n').length >= 1200) return;
    if (typeof value === 'string') {
      const text = value.replace(/\s+/g, ' ').trim();
      if (!text || !PROMPT_FIELD_PATTERN.test(key) || /^https?:\/\//i.test(text) || text.startsWith('/files/')) return;
      const bounded = text.slice(0, 600);
      if (!seen.has(bounded)) { seen.add(bounded); collected.push(bounded); }
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 30).forEach((item) => visit(item, key, depth + 1));
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.entries(value).slice(0, 100).forEach(([childKey, item]) => visit(item, childKey, depth + 1));
  };
  visit(snapshot);
  return collected.join(' · ').slice(0, 1200);
}

function collectSnapshotAssetUrls(snapshot) {
  const urls = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 8 || urls.size >= 200) return;
    if (typeof value === 'string') {
      const text = value.trim();
      if (/^https?:\/\//i.test(text) || text.startsWith('/files/') || text.startsWith('/input/') || text.startsWith('/output/')) urls.add(text.slice(0, 16384));
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 100).forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.values(value).slice(0, 200).forEach((item) => visit(item, depth + 1));
  };
  visit(snapshot);
  return [...urls];
}

class RevisionConflictError extends Error {
  constructor(current) {
    super('画布已被其他会话更新');
    this.name = 'RevisionConflictError';
    this.code = 'revision_conflict';
    this.current = current;
  }
}

class OperationIdConflictError extends Error {
  constructor(current = null) {
    super('同一 opId 已用于不同的画布、身份或 Operation 内容');
    this.name = 'OperationIdConflictError';
    this.code = 'operation_id_conflict';
    this.status = 409;
    this.current = current;
  }
}

class OperationIdReservedError extends Error {
  constructor() {
    super('该 opId 命名空间仅供 CanvasPatch 权威操作使用');
    this.name = 'OperationIdReservedError';
    this.code = 'operation_id_reserved';
    this.status = 409;
  }
}

class SubflowRevisionConflictError extends Error {
  constructor(current) {
    super('子工作流定义已被其他会话发布，请加载最新版本后重试');
    this.name = 'SubflowRevisionConflictError';
    this.code = 'subflow_revision_conflict';
    this.current = current;
  }
}

function normalizeCanvasPatchPrincipal(value, fallback, label) {
  const normalized = String(value || fallback || '').normalize('NFKC').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,239}$/.test(normalized)) {
    throw new CanvasPatchValidationError(`${label} 无效`);
  }
  return normalized;
}

function normalizeCanvasPatchId(value) {
  const normalized = String(value || '').normalize('NFKC').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(normalized)
    || ['__proto__', 'prototype', 'constructor'].includes(normalized)) {
    throw new CanvasPatchValidationError('patchId 无效');
  }
  return normalized;
}

function canvasMutationOpDigest(opId) {
  return crypto.createHash('sha256').update(String(opId || '')).digest('hex');
}

function canvasNodeByIdentity(document, identity) {
  const value = String(identity || '');
  const matches = (Array.isArray(document?.nodes) ? document.nodes : []).filter((node) => (
    String(node?.id || '') === value || String(node?.entityUid || '') === value
  ));
  return matches.length === 1 ? matches[0] : null;
}

function canvasEdgeByIdentity(document, identity) {
  const value = String(identity || '');
  const matches = (Array.isArray(document?.edges) ? document.edges : []).filter((edge) => (
    String(edge?.id || '') === value || String(edge?.entityUid || '') === value
  ));
  return matches.length === 1 ? matches[0] : null;
}

function canvasNodeMatchesIdentity(node, identity) {
  const value = String(identity || '');
  return Boolean(node) && (String(node.id || '') === value || String(node.entityUid || '') === value);
}

function canvasMutationMark(targetType, entityUid, aspect, fieldScope = '', fieldName = '') {
  return {
    targetType,
    entityUid: String(entityUid || '').toLowerCase(),
    aspect,
    fieldScope,
    fieldName,
  };
}

function canvasMutationMarkKey(mark) {
  return [mark.targetType, mark.entityUid, mark.aspect, mark.fieldScope, mark.fieldName].join('\u001f');
}

function deriveCanvasMutationMarks(beforeDocument, afterDocument, operation) {
  const marks = new Map();
  const add = (mark) => {
    if (!mark.entityUid) return;
    marks.set(canvasMutationMarkKey(mark), mark);
  };
  const addNode = (node, aspect, fieldScope = '', fieldName = '') => {
    if (node?.entityUid) add(canvasMutationMark('node', node.entityUid, aspect, fieldScope, fieldName));
  };
  const addEdge = (edge, aspect) => {
    if (edge?.entityUid) add(canvasMutationMark('edge', edge.entityUid, aspect));
  };
  const addConnections = (document, edge) => {
    if (!edge) return;
    addNode(canvasNodeByIdentity(document, edge.source), 'connections');
    addNode(canvasNodeByIdentity(document, edge.target), 'connections');
  };
  const type = String(operation?.type || '');
  const payload = operation?.payload || {};

  if (type === 'node.patch') {
    const node = canvasNodeByIdentity(beforeDocument, payload.nodeId);
    addNode(node, 'entity');
    const topKeys = new Set([
      ...Object.keys(payload.patch || {}),
      ...(Array.isArray(payload.unsetKeys) ? payload.unsetKeys : []),
    ]);
    const dataKeys = new Set([
      ...Object.keys(payload.dataPatch || {}),
      ...(Array.isArray(payload.dataUnsetKeys) ? payload.dataUnsetKeys : []),
    ]);
    topKeys.forEach((key) => addNode(node, 'field', 'node', String(key)));
    dataKeys.forEach((key) => addNode(node, 'field', 'data', String(key)));
  } else if (type === 'node.move') {
    const node = canvasNodeByIdentity(beforeDocument, payload.nodeId);
    addNode(node, 'entity');
    addNode(node, 'field', 'node', 'position');
  } else if (type === 'node.add' || type === 'node.restore') {
    const node = canvasNodeByIdentity(afterDocument, payload.node?.entityUid || payload.node?.id);
    addNode(node, 'lifecycle');
    addNode(node, 'entity');
  } else if (type === 'node.delete') {
    const node = canvasNodeByIdentity(beforeDocument, payload.nodeId);
    addNode(node, 'lifecycle');
    addNode(node, 'entity');
    const connectedEdges = (beforeDocument?.edges || []).filter((edge) => (
      canvasNodeMatchesIdentity(node, edge?.source) || canvasNodeMatchesIdentity(node, edge?.target)
    ));
    connectedEdges.forEach((edge) => {
      addEdge(edge, 'lifecycle');
      addEdge(edge, 'entity');
      addConnections(beforeDocument, edge);
    });
  } else if (type === 'edge.add' || type === 'edge.restore') {
    const edge = canvasEdgeByIdentity(afterDocument, payload.edge?.entityUid || payload.edge?.id);
    addEdge(edge, 'lifecycle');
    addEdge(edge, 'entity');
    addConnections(afterDocument, edge);
  } else if (type === 'edge.delete') {
    const edge = canvasEdgeByIdentity(beforeDocument, payload.edgeId);
    addEdge(edge, 'lifecycle');
    addEdge(edge, 'entity');
    addConnections(beforeDocument, edge);
  } else if (type === 'viewport.set') {
    add(canvasMutationMark('canvas', afterDocument?.entityUid || beforeDocument?.entityUid, 'field', 'canvas', 'viewport'));
  }
  return [...marks.values()].sort((left, right) => canvasMutationMarkKey(left).localeCompare(canvasMutationMarkKey(right)));
}

function deriveCanvasPatchProvenanceGuardKeys(document, postconditions) {
  const guards = new Map();
  const add = (mark) => {
    if (!mark.entityUid) throw new CanvasPatchValidationError('CanvasPatch provenance 缺少稳定实体身份');
    guards.set(canvasMutationMarkKey(mark), mark);
  };
  add(canvasMutationMark('canvas', document?.entityUid, 'reset'));
  for (const condition of Array.isArray(postconditions) ? postconditions : []) {
    if (condition?.kind === 'node.fields') {
      add(canvasMutationMark('node', condition.entityUid, 'lifecycle'));
      for (const field of Array.isArray(condition.fields) ? condition.fields : []) {
        add(canvasMutationMark('node', condition.entityUid, 'field', field.scope, field.key));
      }
    } else if (condition?.kind === 'node.added') {
      add(canvasMutationMark('node', condition.entityUid, 'lifecycle'));
      add(canvasMutationMark('node', condition.entityUid, 'entity'));
      add(canvasMutationMark('node', condition.entityUid, 'connections'));
    } else if (condition?.kind === 'node.deleted') {
      add(canvasMutationMark('node', condition.entityUid, 'lifecycle'));
      for (const edge of Array.isArray(condition.edges) ? condition.edges : []) {
        add(canvasMutationMark('edge', edge.entityUid, 'lifecycle'));
      }
    } else if (condition?.kind === 'edge.added') {
      add(canvasMutationMark('edge', condition.entityUid, 'lifecycle'));
      add(canvasMutationMark('edge', condition.entityUid, 'entity'));
    } else if (condition?.kind === 'edge.deleted') {
      add(canvasMutationMark('edge', condition.entityUid, 'lifecycle'));
    } else if (condition?.kind === 'canvas.fields') {
      for (const field of Array.isArray(condition.fields) ? condition.fields : []) {
        add(canvasMutationMark('canvas', document?.entityUid, 'field', 'canvas', field.key));
      }
    }
  }
  const output = [...guards.values()].sort((left, right) => canvasMutationMarkKey(left).localeCompare(canvasMutationMarkKey(right)));
  if (output.length > CANVAS_PROVENANCE_GUARD_LIMIT) {
    throw new CanvasPatchValidationError('CanvasPatch provenance guard 超过安全上限');
  }
  return output;
}

function canvasPatchProvenanceDigest(row, guards) {
  return crypto.createHash('sha256').update(stableJson({
    guardVersion: CANVAS_PROVENANCE_GUARD_VERSION,
    projectId: row.projectId,
    canvasId: row.canvasId,
    patchId: row.patchId,
    appliedRevision: Number(row.appliedRevision),
    guards,
  })).digest('hex');
}

function normalizeStoredSubflowDefinition(value, metadata = {}) {
  if (!value || typeof value !== 'object') return null;
  const version = Math.max(1, Number(value.version) || 1);
  const revision = Math.max(1, Number(value.revision) || version);
  return {
    ...value,
    version,
    revision,
    changeSummary: String(value.changeSummary || (revision === 1 ? '创建子工作流' : `发布 v${version}`)),
    publishedBy: String(value.publishedBy || value.createdBy || metadata.createdBy || metadata.created_by || 'local-owner'),
    publishedAt: Math.max(1, Number(value.publishedAt || value.updatedAt || value.createdAt || metadata.createdAt || metadata.created_at) || 1),
  };
}

class ProjectDatabase {
  constructor(filename, options = {}) {
    this.filename = filename;
    this.options = options;
    this.backupFilename = options.backupFilename || (filename === ':memory:' ? null : `${filename}.backup`);
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    try {
      this.db = new BetterSqlite3(this.filename);
      this.initializeDatabase();
    } catch (error) {
      if (this.filename === ':memory:') throw error;
      let databaseIsReadable = false;
      try {
        databaseIsReadable = Boolean(this.db?.open) && this.db.pragma('quick_check', { simple: true }) === 'ok';
      } catch (_) {
        databaseIsReadable = false;
      }
      try { if (this.db?.open) this.db.close(); } catch (_) {}
      if (databaseIsReadable) throw error;
      this.db = this.recoverDatabase(error);
      try {
        this.initializeDatabase();
      } catch (recoveryError) {
        try { if (this.db?.open) this.db.close(); } catch (_) {}
        throw recoveryError;
      }
    }
    if (this.backupFilename && options.autoBackup !== false) {
      this.createBackup().catch((error) => {
        console.warn('[project-db] startup backup failed:', error?.message || error);
      });
    }
  }

  initializeDatabase() {
    this.configure();
    this.migrate();
    const integrity = this.db.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`项目数据库完整性检查失败: ${integrity}`);
    this.lastInterruptedRecovery = this.recoverInterruptedRuns();
  }

  recoverDatabase(originalError) {
    const corruptName = `${this.filename}.corrupt-${Date.now()}`;
    if (fs.existsSync(this.filename)) fs.renameSync(this.filename, corruptName);
    if (this.backupFilename && fs.existsSync(this.backupFilename)) {
      fs.copyFileSync(this.backupFilename, this.filename);
      try {
        return new BetterSqlite3(this.filename);
      } catch (restoreError) {
        if (fs.existsSync(this.filename)) fs.renameSync(this.filename, `${corruptName}.backup`);
        console.warn('[project-db] backup restore failed, creating a new database:', restoreError?.message || restoreError);
      }
    }
    console.warn('[project-db] primary database quarantined:', originalError?.message || originalError);
    return new BetterSqlite3(this.filename);
  }

  configure() {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  createBackup() {
    if (!this.backupFilename) return Promise.resolve(null);
    return this.db.backup(this.backupFilename);
  }

  migrate() {
    const migrateTransaction = this.db.transaction(() => {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS canvas_documents (
        canvas_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS canvas_operations (
        op_id TEXT PRIMARY KEY,
        canvas_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        actor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        client_seq INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        requires_snapshot INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(canvas_id) REFERENCES canvas_documents(canvas_id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_operations_revision
        ON canvas_operations(canvas_id, revision);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        canvas_revision INTEGER NOT NULL,
        initiator_id TEXT NOT NULL,
        parent_run_id TEXT,
        status TEXT NOT NULL,
        summary_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_runs_canvas_created ON runs(canvas_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_project_status_initiator_created ON runs(project_id, status, initiator_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS node_runs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        parent_node_run_id TEXT,
        original_node_id TEXT,
        definition_id TEXT,
        definition_version INTEGER,
        subflow_path_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        input_json TEXT NOT NULL DEFAULT '{}',
        output_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_node_runs_run ON node_runs(run_id, created_at);

      CREATE TABLE IF NOT EXISTS run_attempts (
        id TEXT PRIMARY KEY,
        node_run_id TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        upstream_task_id TEXT,
        request_id TEXT,
        http_status INTEGER,
        poll_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        timestamps_json TEXT NOT NULL DEFAULT '{}',
        usage_json TEXT NOT NULL DEFAULT '{}',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(node_run_id) REFERENCES node_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_run_attempts_node ON run_attempts(node_run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_run_attempts_provider_model_node ON run_attempts(provider, model, node_run_id);
      CREATE INDEX IF NOT EXISTS idx_run_attempts_model_node ON run_attempts(model, node_run_id);

      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        node_run_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);

      CREATE TABLE IF NOT EXISTS run_retention_policies (
        project_id TEXT PRIMARY KEY,
        max_days INTEGER NOT NULL DEFAULT 30,
        max_runs INTEGER NOT NULL DEFAULT 5000,
        max_asset_refs INTEGER NOT NULL DEFAULT 100000,
        max_db_bytes INTEGER NOT NULL DEFAULT 2147483648,
        keep_referenced INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        content_hash TEXT,
        perceptual_hash TEXT,
        kind TEXT NOT NULL,
        mime_type TEXT,
        filename TEXT NOT NULL,
        managed_path TEXT,
        source_url TEXT,
        storage_mode TEXT NOT NULL DEFAULT 'linked',
        availability TEXT NOT NULL DEFAULT 'available',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        provenance_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(content_hash);
      CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS asset_preview_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        job_kind TEXT NOT NULL,
        pipeline_version TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_attempt_at INTEGER,
        error_code TEXT,
        error_message TEXT,
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER,
        FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE,
        UNIQUE(asset_id, content_hash, job_kind, pipeline_version)
      );
      CREATE INDEX IF NOT EXISTS idx_asset_preview_jobs_ready
        ON asset_preview_jobs(status, next_attempt_at, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_asset_preview_jobs_asset
        ON asset_preview_jobs(asset_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_asset_preview_jobs_project
        ON asset_preview_jobs(project_id, status, created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS asset_collections (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_collections_name ON asset_collections(project_id, name);

      CREATE TABLE IF NOT EXISTS asset_collection_members (
        collection_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY(collection_id, asset_id),
        FOREIGN KEY(collection_id) REFERENCES asset_collections(id) ON DELETE CASCADE,
        FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS asset_tags (
        asset_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(asset_id, tag),
        FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag, asset_id);

      CREATE TABLE IF NOT EXISTS asset_lineage (
        child_asset_id TEXT NOT NULL,
        parent_asset_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        run_id TEXT,
        node_run_id TEXT,
        attempt_id TEXT,
        prompt_digest TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        PRIMARY KEY(child_asset_id, parent_asset_id, relation),
        FOREIGN KEY(child_asset_id) REFERENCES assets(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_asset_id) REFERENCES assets(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_asset_lineage_parent ON asset_lineage(parent_asset_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS asset_lineage_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        parent_asset_id TEXT,
        source_type TEXT NOT NULL,
        source_node_id TEXT,
        source_node_type TEXT,
        run_id TEXT,
        node_run_id TEXT,
        attempt_id TEXT,
        canvas_id TEXT,
        creator_id TEXT NOT NULL,
        prompt_summary TEXT,
        prompt_digest TEXT,
        derived_operation TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_asset_id) REFERENCES assets(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_asset_lineage_events_asset ON asset_lineage_events(asset_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_asset_lineage_events_parent ON asset_lineage_events(parent_asset_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_asset_lineage_events_run ON asset_lineage_events(run_id, node_run_id, attempt_id);

      CREATE TABLE IF NOT EXISTS subflow_definitions (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_subflow_definitions_project_created
        ON subflow_definitions(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS subflow_definition_heads (
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        latest_version INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_subflow_definition_heads_updated
        ON subflow_definition_heads(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS canvas_resource_grants (
        project_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, canvas_id, resource_type, resource_id, resource_version, source)
      );
      CREATE INDEX IF NOT EXISTS idx_canvas_resource_grants_scope
        ON canvas_resource_grants(project_id, canvas_id, resource_type, resource_id, resource_version);

      CREATE TABLE IF NOT EXISTS canvas_resource_grant_state (
        project_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        trusted_revision INTEGER NOT NULL,
        initialized_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, canvas_id)
      );

      CREATE TABLE IF NOT EXISTS collaboration_members (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        canvas_id TEXT,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collaboration_invites (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        canvas_id TEXT,
        code_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        max_uses INTEGER NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collaboration_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        canvas_id TEXT,
        member_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        FOREIGN KEY(member_id) REFERENCES collaboration_members(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS review_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        canvas_revision INTEGER NOT NULL,
        anchor_json TEXT NOT NULL,
        status TEXT NOT NULL,
        severity TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        parent_id TEXT,
        body TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES review_threads(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS run_intents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        canvas_revision INTEGER NOT NULL,
        node_ids_json TEXT NOT NULL DEFAULT '[]',
        idempotency_key TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_run_intents_status ON run_intents(project_id, status, created_at);
      `);
      const ensureColumn = (table, column, sql) => {
        const columns = new Set(this.db.pragma(`table_info(${table})`).map((entry) => entry.name));
        if (!columns.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);
      };
      const assetColumnsBeforeV14 = new Set(this.db.pragma('table_info(assets)').map((entry) => entry.name));
      const needsAssetStorageBackfill = !assetColumnsBeforeV14.has('storage_mode');
      ensureColumn('review_comments', 'parent_id', 'parent_id TEXT');
      ensureColumn('canvas_operations', 'project_id', `project_id TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_ID}'`);
      ensureColumn('canvas_operations', 'base_revision', 'base_revision INTEGER');
      ensureColumn('runs', 'parent_run_id', 'parent_run_id TEXT');
      ensureColumn('node_runs', 'parent_node_run_id', 'parent_node_run_id TEXT');
      ensureColumn('node_runs', 'original_node_id', 'original_node_id TEXT');
      ensureColumn('node_runs', 'definition_id', 'definition_id TEXT');
      ensureColumn('node_runs', 'definition_version', 'definition_version INTEGER');
      ensureColumn('run_attempts', 'http_status', 'http_status INTEGER');
      ensureColumn('run_attempts', 'poll_count', 'poll_count INTEGER NOT NULL DEFAULT 0');
      ensureColumn('run_attempts', 'metadata_json', `metadata_json TEXT NOT NULL DEFAULT '{}'`);
      ensureColumn('assets', 'entity_uid', 'entity_uid TEXT');
      ensureColumn('assets', 'perceptual_hash', 'perceptual_hash TEXT');
      ensureColumn('assets', 'perceptual_hash_algorithm', 'perceptual_hash_algorithm TEXT');
      ensureColumn('assets', 'organization_revision', 'organization_revision INTEGER NOT NULL DEFAULT 1');
      ensureColumn('assets', 'source_locator', 'source_locator TEXT');
      ensureColumn('assets', 'storage_mode', "storage_mode TEXT NOT NULL DEFAULT 'linked'");
      ensureColumn('assets', 'availability', "availability TEXT NOT NULL DEFAULT 'available'");
      ensureColumn('asset_collections', 'revision', 'revision INTEGER NOT NULL DEFAULT 1');
      ensureColumn('run_intents', 'provider', 'provider TEXT');
      ensureColumn('run_intents', 'model', 'model TEXT');
      ensureColumn('run_intents', 'estimated_cost', 'estimated_cost REAL NOT NULL DEFAULT 0');
      ensureColumn('run_intents', 'estimated_cost_known', 'estimated_cost_known INTEGER NOT NULL DEFAULT 0');
      ensureColumn('run_intents', 'execution_authority_json', `execution_authority_json TEXT NOT NULL DEFAULT '{}'`);
      ensureColumn('run_intents', 'actual_cost', 'actual_cost REAL');
      ensureColumn('run_retention_policies', 'max_asset_refs', 'max_asset_refs INTEGER NOT NULL DEFAULT 100000');
      ensureColumn('collaboration_invites', 'canvas_id', 'canvas_id TEXT');
      ensureColumn('collaboration_members', 'canvas_id', 'canvas_id TEXT');
      ensureColumn('collaboration_sessions', 'canvas_id', 'canvas_id TEXT');
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_collaboration_invites_scope
          ON collaboration_invites(project_id, canvas_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_collaboration_members_scope
          ON collaboration_members(project_id, canvas_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_collaboration_sessions_scope
          ON collaboration_sessions(project_id, canvas_id, created_at DESC);
      `);
      const subflowPrimaryKey = this.db.pragma('table_info(subflow_definitions)')
        .filter((entry) => Number(entry.pk) > 0)
        .sort((left, right) => Number(left.pk) - Number(right.pk))
        .map((entry) => entry.name);
      if (subflowPrimaryKey.join(',') !== 'project_id,id,version') {
        this.db.exec(`
          ALTER TABLE subflow_definitions RENAME TO subflow_definitions_legacy_v6;
          CREATE TABLE subflow_definitions (
            id TEXT NOT NULL,
            version INTEGER NOT NULL,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            definition_json TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(project_id, id, version)
          );
          INSERT INTO subflow_definitions(id, version, project_id, name, definition_json, created_by, created_at)
            SELECT id, version, project_id, name, definition_json, created_by, created_at
            FROM subflow_definitions_legacy_v6;
          DROP TABLE subflow_definitions_legacy_v6;
        `);
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_subflow_definitions_project_created
          ON subflow_definitions(project_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS subflow_definition_heads (
          project_id TEXT NOT NULL,
          id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          latest_version INTEGER NOT NULL,
          updated_by TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_subflow_definition_heads_updated
          ON subflow_definition_heads(project_id, updated_at DESC);
      `);
      this.db.exec(`
        INSERT OR IGNORE INTO subflow_definition_heads(project_id, id, revision, latest_version, updated_by, updated_at)
        SELECT project_id, id, MAX(version), MAX(version), 'legacy-migration', MAX(created_at)
        FROM subflow_definitions GROUP BY project_id, id;
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS canvas_snapshots (
          canvas_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          project_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(canvas_id, revision),
          FOREIGN KEY(canvas_id) REFERENCES canvas_documents(canvas_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_created
          ON canvas_snapshots(canvas_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS canvas_operation_idempotency (
          op_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          canvas_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          base_revision INTEGER CHECK(base_revision IS NULL OR base_revision >= 0),
          actor_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          client_seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
          created_at INTEGER NOT NULL,
          FOREIGN KEY(canvas_id) REFERENCES canvas_documents(canvas_id) ON DELETE CASCADE
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_canvas_operation_idempotency_canvas_revision
          ON canvas_operation_idempotency(project_id, canvas_id, revision DESC);
        CREATE TRIGGER IF NOT EXISTS trg_canvas_operation_idempotency_project_insert
        BEFORE INSERT ON canvas_operation_idempotency BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM canvas_documents d
            WHERE d.canvas_id = NEW.canvas_id AND d.project_id = NEW.project_id
          ) THEN RAISE(ABORT, 'canvas_operation_idempotency project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_canvas_operation_idempotency_project_update
        BEFORE UPDATE OF project_id, canvas_id ON canvas_operation_idempotency BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM canvas_documents d
            WHERE d.canvas_id = NEW.canvas_id AND d.project_id = NEW.project_id
          ) THEN RAISE(ABORT, 'canvas_operation_idempotency project mismatch') END;
        END;

        CREATE TABLE IF NOT EXISTS audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          canvas_id TEXT,
          actor_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          action TEXT NOT NULL,
          target_type TEXT,
          target_id TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_events_project_created
          ON audit_events(project_id, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_events_canvas_created
          ON audit_events(canvas_id, created_at DESC, id DESC);

        CREATE TABLE IF NOT EXISTS canvas_patch_applications (
          project_id TEXT NOT NULL,
          canvas_id TEXT NOT NULL,
          patch_id TEXT NOT NULL,
          schema TEXT NOT NULL CHECK(schema = 't8-canvas-patch-v1'),
          request_digest TEXT NOT NULL CHECK(length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
          preview_digest TEXT NOT NULL CHECK(length(preview_digest) = 64 AND preview_digest NOT GLOB '*[^0-9a-f]*'),
          base_revision INTEGER NOT NULL CHECK(base_revision >= 1),
          applied_revision INTEGER NOT NULL CHECK(applied_revision > base_revision),
          reverted_revision INTEGER CHECK(reverted_revision IS NULL OR reverted_revision > applied_revision),
          actor_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          summary TEXT NOT NULL,
          diagnostics_json TEXT NOT NULL DEFAULT '[]',
          operation_count INTEGER NOT NULL CHECK(operation_count BETWEEN 1 AND 100),
          affected_node_ids_json TEXT NOT NULL DEFAULT '[]',
          affected_edge_ids_json TEXT NOT NULL DEFAULT '[]',
          changes_json TEXT NOT NULL DEFAULT '[]',
          forward_ops_json TEXT NOT NULL,
          inverse_ops_json TEXT NOT NULL,
          postconditions_json TEXT NOT NULL,
          guard_version INTEGER NOT NULL DEFAULT 0 CHECK(guard_version IN (0, 1)),
          provenance_guards_json TEXT NOT NULL DEFAULT '[]',
          provenance_guards_digest TEXT NOT NULL DEFAULT '',
          acknowledgements_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'applied' CHECK(status IN ('applied', 'reverted')),
          created_at INTEGER NOT NULL,
          reverted_at INTEGER,
          updated_at INTEGER NOT NULL,
          CHECK(
            (status = 'applied' AND reverted_revision IS NULL AND reverted_at IS NULL)
            OR (status = 'reverted' AND reverted_revision IS NOT NULL AND reverted_at IS NOT NULL)
          ),
          PRIMARY KEY(project_id, canvas_id, patch_id),
          FOREIGN KEY(canvas_id) REFERENCES canvas_documents(canvas_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_canvas_patch_applications_actor_created
          ON canvas_patch_applications(project_id, canvas_id, actor_id, created_at DESC, patch_id DESC);
        CREATE INDEX IF NOT EXISTS idx_canvas_patch_applications_canvas_revision
          ON canvas_patch_applications(canvas_id, applied_revision DESC);
        CREATE TRIGGER IF NOT EXISTS trg_canvas_patch_applications_project_insert
        BEFORE INSERT ON canvas_patch_applications BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM canvas_documents d
            WHERE d.canvas_id = NEW.canvas_id AND d.project_id = NEW.project_id
          ) THEN RAISE(ABORT, 'canvas_patch_applications project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_canvas_patch_applications_project_update
        BEFORE UPDATE OF project_id, canvas_id ON canvas_patch_applications BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM canvas_documents d
            WHERE d.canvas_id = NEW.canvas_id AND d.project_id = NEW.project_id
          ) THEN RAISE(ABORT, 'canvas_patch_applications project mismatch') END;
        END;

        CREATE TABLE IF NOT EXISTS canvas_mutation_provenance (
          project_id TEXT NOT NULL,
          canvas_id TEXT NOT NULL,
          target_type TEXT NOT NULL CHECK(target_type IN ('canvas', 'node', 'edge')),
          entity_uid TEXT NOT NULL,
          aspect TEXT NOT NULL CHECK(aspect IN ('reset', 'lifecycle', 'entity', 'connections', 'field')),
          field_scope TEXT NOT NULL DEFAULT '',
          field_name TEXT NOT NULL DEFAULT '',
          last_revision INTEGER NOT NULL CHECK(last_revision >= 1),
          last_op_digest TEXT NOT NULL CHECK(length(last_op_digest) = 64 AND last_op_digest NOT GLOB '*[^0-9a-f]*'),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, canvas_id, target_type, entity_uid, aspect, field_scope, field_name),
          FOREIGN KEY(canvas_id) REFERENCES canvas_documents(canvas_id) ON DELETE CASCADE
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_canvas_mutation_provenance_canvas_revision
          ON canvas_mutation_provenance(project_id, canvas_id, last_revision DESC);
        CREATE TRIGGER IF NOT EXISTS trg_canvas_mutation_provenance_project_insert
        BEFORE INSERT ON canvas_mutation_provenance BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM canvas_documents d
            WHERE d.canvas_id = NEW.canvas_id AND d.project_id = NEW.project_id
          ) THEN RAISE(ABORT, 'canvas_mutation_provenance project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_canvas_mutation_provenance_project_update
        BEFORE UPDATE OF project_id, canvas_id ON canvas_mutation_provenance BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM canvas_documents d
            WHERE d.canvas_id = NEW.canvas_id AND d.project_id = NEW.project_id
          ) THEN RAISE(ABORT, 'canvas_mutation_provenance project mismatch') END;
        END;

        CREATE TABLE IF NOT EXISTS collaboration_text_documents (
          project_id TEXT NOT NULL,
          canvas_id TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          field_name TEXT NOT NULL,
          state_blob BLOB NOT NULL,
          updated_by TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, canvas_id, target_type, target_id, field_name),
          FOREIGN KEY(canvas_id) REFERENCES canvas_documents(canvas_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_collaboration_text_canvas
          ON collaboration_text_documents(project_id, canvas_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS project_execution_policies (
          project_id TEXT PRIMARY KEY,
          allowed_models_json TEXT NOT NULL DEFAULT '[]',
          daily_cost_limit REAL NOT NULL DEFAULT 0,
          per_run_cost_limit REAL NOT NULL DEFAULT 0,
          concurrency_limit INTEGER NOT NULL DEFAULT 2,
          updated_by TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_assets_perceptual_hash ON assets(project_id, kind, perceptual_hash);
        CREATE INDEX IF NOT EXISTS idx_assets_storage_state ON assets(project_id, storage_mode, availability, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_assets_project_source_locator ON assets(project_id, source_locator, updated_at DESC)
          WHERE source_locator IS NOT NULL;

        CREATE TABLE IF NOT EXISTS asset_blobs (
          id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL UNIQUE,
          verification_state TEXT NOT NULL DEFAULT 'legacy-unverified',
          byte_size INTEGER,
          mime_type TEXT,
          storage_key TEXT,
          storage_state TEXT NOT NULL DEFAULT 'logical',
          verified_at INTEGER,
          pending_delete_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS asset_blob_refs (
          project_id TEXT NOT NULL,
          asset_id TEXT PRIMARY KEY,
          blob_id TEXT NOT NULL,
          verification_state TEXT NOT NULL DEFAULT 'legacy-unverified',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE,
          FOREIGN KEY(blob_id) REFERENCES asset_blobs(id) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_asset_blob_refs_project_blob
          ON asset_blob_refs(project_id, blob_id, asset_id);
        CREATE TABLE IF NOT EXISTS asset_upload_sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          member_id TEXT NOT NULL,
          source_kind TEXT NOT NULL DEFAULT 'collaboration',
          idempotency_key TEXT NOT NULL,
          request_digest TEXT NOT NULL,
          filename TEXT NOT NULL,
          mime_type TEXT,
          expected_size INTEGER NOT NULL CHECK(expected_size > 0),
          expected_hash TEXT,
          chunk_size INTEGER NOT NULL CHECK(chunk_size > 0),
          chunk_count INTEGER NOT NULL CHECK(chunk_count > 0),
          received_bytes INTEGER NOT NULL DEFAULT 0 CHECK(received_bytes >= 0),
          reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes >= 0),
          status TEXT NOT NULL DEFAULT 'uploading'
            CHECK(status IN ('uploading', 'paused', 'assembling', 'completed', 'cancelled', 'expired', 'failed')),
          revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
          asset_id TEXT,
          content_hash TEXT,
          deduplicated INTEGER NOT NULL DEFAULT 0 CHECK(deduplicated IN (0, 1)),
          error_code TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          completed_at INTEGER,
          UNIQUE(project_id, member_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS idx_asset_upload_sessions_active
          ON asset_upload_sessions(project_id, status, expires_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_asset_upload_sessions_member
          ON asset_upload_sessions(project_id, member_id, status, expires_at);
        CREATE TABLE IF NOT EXISTS asset_upload_chunks (
          session_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
          byte_start INTEGER NOT NULL CHECK(byte_start >= 0),
          byte_end INTEGER NOT NULL CHECK(byte_end >= byte_start),
          byte_size INTEGER NOT NULL CHECK(byte_size > 0),
          content_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(session_id, chunk_index),
          FOREIGN KEY(session_id) REFERENCES asset_upload_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_asset_upload_chunks_session_range
          ON asset_upload_chunks(session_id, byte_start, byte_end);
        CREATE INDEX IF NOT EXISTS idx_assets_project_created_id
          ON assets(project_id, created_at DESC, id DESC);

        CREATE TABLE IF NOT EXISTS asset_fingerprints (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          algorithm TEXT NOT NULL,
          frame_kind TEXT NOT NULL DEFAULT 'image',
          frame_index INTEGER NOT NULL DEFAULT 0,
          timestamp_ms INTEGER,
          normalized_time REAL,
          hash_hex TEXT NOT NULL,
          band_0 TEXT NOT NULL,
          band_1 TEXT NOT NULL,
          band_2 TEXT NOT NULL,
          band_3 TEXT NOT NULL,
          band_4 TEXT NOT NULL,
          band_5 TEXT NOT NULL,
          band_6 TEXT NOT NULL,
          band_7 TEXT NOT NULL,
          band_8 TEXT NOT NULL,
          evidence_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(asset_id, content_hash, algorithm, frame_kind, frame_index),
          FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_asset_fingerprints_asset
          ON asset_fingerprints(asset_id, algorithm, frame_index);
        CREATE INDEX IF NOT EXISTS idx_asset_fingerprints_project_algorithm
          ON asset_fingerprints(project_id, algorithm, asset_id);
        CREATE INDEX IF NOT EXISTS idx_asset_fingerprint_band_0 ON asset_fingerprints(project_id, algorithm, band_0, asset_id);
        CREATE INDEX IF NOT EXISTS idx_asset_fingerprint_band_1 ON asset_fingerprints(project_id, algorithm, band_1, asset_id);
        CREATE INDEX IF NOT EXISTS idx_asset_fingerprint_band_2 ON asset_fingerprints(project_id, algorithm, band_2, asset_id);
        CREATE INDEX IF NOT EXISTS idx_asset_fingerprint_band_3 ON asset_fingerprints(project_id, algorithm, band_3, asset_id);
        CREATE INDEX IF NOT EXISTS idx_asset_fingerprint_band_4 ON asset_fingerprints(project_id, algorithm, band_4, asset_id);
        CREATE INDEX IF NOT EXISTS idx_asset_fingerprint_band_5 ON asset_fingerprints(project_id, algorithm, band_5, asset_id);
        CREATE INDEX IF NOT EXISTS idx_asset_fingerprint_band_6 ON asset_fingerprints(project_id, algorithm, band_6, asset_id);
        CREATE INDEX IF NOT EXISTS idx_asset_fingerprint_band_7 ON asset_fingerprints(project_id, algorithm, band_7, asset_id);
        CREATE INDEX IF NOT EXISTS idx_asset_fingerprint_band_8 ON asset_fingerprints(project_id, algorithm, band_8, asset_id);

        CREATE TABLE IF NOT EXISTS asset_duplicate_candidates (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          left_asset_id TEXT NOT NULL,
          right_asset_id TEXT NOT NULL,
          algorithm TEXT NOT NULL,
          distance REAL NOT NULL,
          minimum_distance INTEGER NOT NULL DEFAULT 8,
          catalog_revision INTEGER NOT NULL DEFAULT 0,
          confidence TEXT NOT NULL,
          evidence_json TEXT NOT NULL DEFAULT '[]',
          decision TEXT NOT NULL DEFAULT 'pending',
          revision INTEGER NOT NULL DEFAULT 1,
          decided_by TEXT,
          decided_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(project_id, left_asset_id, right_asset_id, algorithm),
          FOREIGN KEY(left_asset_id) REFERENCES assets(id) ON DELETE CASCADE,
          FOREIGN KEY(right_asset_id) REFERENCES assets(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_asset_duplicate_candidates_left
          ON asset_duplicate_candidates(project_id, left_asset_id, distance, right_asset_id);
        CREATE INDEX IF NOT EXISTS idx_asset_duplicate_candidates_right
          ON asset_duplicate_candidates(project_id, right_asset_id, distance, left_asset_id);
        CREATE TABLE IF NOT EXISTS asset_duplicate_scans (
          project_id TEXT NOT NULL,
          asset_id TEXT PRIMARY KEY,
          catalog_revision INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS asset_access_policies (
          project_id TEXT NOT NULL,
          asset_id TEXT PRIMARY KEY,
          scope TEXT NOT NULL DEFAULT 'project',
          revision INTEGER NOT NULL DEFAULT 1,
          updated_by TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_asset_access_policies_project_scope
          ON asset_access_policies(project_id, scope, asset_id);
        CREATE TABLE IF NOT EXISTS asset_access_grants (
          project_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          principal_type TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          permission TEXT NOT NULL,
          granted_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(asset_id, principal_type, principal_id, permission),
          FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_asset_access_grants_lookup
          ON asset_access_grants(project_id, asset_id, principal_type, principal_id, permission);

        CREATE TABLE IF NOT EXISTS asset_catalog_revisions (
          project_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS asset_batch_requests (
          project_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_digest TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, actor_id, idempotency_key)
        );

        CREATE TABLE IF NOT EXISTS asset_lineage_tombstones (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          entity_uid TEXT,
          filename TEXT NOT NULL,
          kind TEXT NOT NULL,
          mime_type TEXT,
          content_hash TEXT,
          deleted_at INTEGER NOT NULL
        );
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS asset_semantic_models (
          model_key TEXT NOT NULL,
          model_version TEXT NOT NULL,
          capability TEXT NOT NULL CHECK(capability IN ('caption', 'ocr', 'embedding')),
          status TEXT NOT NULL CHECK(status IN ('not-installed', 'downloading', 'verifying', 'installed', 'failed', 'disabled', 'deleting')),
          revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
          artifact_digest TEXT,
          byte_size INTEGER,
          downloaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK(downloaded_bytes >= 0),
          total_bytes INTEGER CHECK(total_bytes IS NULL OR total_bytes >= 0),
          install_path TEXT,
          error_code TEXT,
          error_message TEXT,
          installed_at INTEGER,
          download_idempotency_key TEXT CHECK(download_idempotency_key IS NULL OR length(download_idempotency_key) BETWEEN 1 AND 160),
          download_request_revision INTEGER CHECK(download_request_revision IS NULL OR download_request_revision >= 1),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK (
            (download_idempotency_key IS NULL AND download_request_revision IS NULL)
            OR (download_idempotency_key IS NOT NULL AND download_request_revision IS NOT NULL)
          ),
          PRIMARY KEY(model_key, model_version)
        );
        CREATE INDEX IF NOT EXISTS idx_asset_semantic_models_capability_status
          ON asset_semantic_models(capability, status, model_key, model_version);

        CREATE TABLE IF NOT EXISTS asset_semantic_profiles (
          project_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
          enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
          caption_enabled INTEGER NOT NULL DEFAULT 0 CHECK(caption_enabled IN (0, 1)),
          caption_model_key TEXT,
          caption_model_version TEXT,
          ocr_enabled INTEGER NOT NULL DEFAULT 0 CHECK(ocr_enabled IN (0, 1)),
          ocr_model_key TEXT,
          ocr_model_version TEXT,
          embedding_enabled INTEGER NOT NULL DEFAULT 0 CHECK(embedding_enabled IN (0, 1)),
          embedding_model_key TEXT,
          embedding_model_version TEXT,
          active_generation INTEGER,
          building_generation INTEGER,
          updated_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(caption_model_key, caption_model_version)
            REFERENCES asset_semantic_models(model_key, model_version) ON DELETE RESTRICT,
          FOREIGN KEY(ocr_model_key, ocr_model_version)
            REFERENCES asset_semantic_models(model_key, model_version) ON DELETE RESTRICT,
          FOREIGN KEY(embedding_model_key, embedding_model_version)
            REFERENCES asset_semantic_models(model_key, model_version) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS asset_semantic_generations (
          project_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK(generation >= 1),
          revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
          catalog_revision INTEGER NOT NULL CHECK(catalog_revision >= 1),
          profile_revision INTEGER NOT NULL CHECK(profile_revision >= 1),
          profile_digest TEXT NOT NULL,
          profile_snapshot_json TEXT NOT NULL,
          idempotency_key TEXT,
          jobs_sealed INTEGER NOT NULL DEFAULT 0 CHECK(jobs_sealed IN (0, 1)),
          expected_job_count INTEGER NOT NULL DEFAULT 0 CHECK(expected_job_count >= 0),
          eligible_asset_count INTEGER NOT NULL DEFAULT 0 CHECK(eligible_asset_count >= 0),
          excluded_asset_count INTEGER NOT NULL DEFAULT 0 CHECK(excluded_asset_count >= 0),
          payload_pruned_at INTEGER,
          status TEXT NOT NULL CHECK(status IN ('building', 'ready', 'active', 'failed', 'superseded')),
          error_code TEXT,
          error_message TEXT,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          finished_at INTEGER,
          PRIMARY KEY(project_id, generation),
          FOREIGN KEY(project_id) REFERENCES asset_semantic_profiles(project_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_asset_semantic_generations_status
          ON asset_semantic_generations(project_id, status, generation DESC);

        CREATE TABLE IF NOT EXISTS asset_semantic_jobs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          job_kind TEXT NOT NULL CHECK(job_kind IN ('caption', 'ocr', 'embedding')),
          model_key TEXT NOT NULL,
          model_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'retrying', 'succeeded', 'skipped', 'failed', 'superseded')),
          revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
          max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 5),
          next_attempt_at INTEGER,
          claim_token TEXT,
          error_code TEXT,
          error_message TEXT,
          result_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          updated_at INTEGER NOT NULL,
          finished_at INTEGER,
          UNIQUE(project_id, asset_id, generation, job_kind, model_key, model_version),
          FOREIGN KEY(project_id, asset_id) REFERENCES assets(project_id, id) ON DELETE CASCADE,
          FOREIGN KEY(project_id, generation) REFERENCES asset_semantic_generations(project_id, generation) ON DELETE CASCADE,
          FOREIGN KEY(model_key, model_version) REFERENCES asset_semantic_models(model_key, model_version) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_asset_semantic_jobs_ready
          ON asset_semantic_jobs(status, next_attempt_at, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_asset_semantic_jobs_project_generation
          ON asset_semantic_jobs(project_id, generation, status, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_asset_semantic_jobs_asset
          ON asset_semantic_jobs(project_id, asset_id, generation DESC, job_kind);

        CREATE TABLE IF NOT EXISTS asset_semantic_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          document_kind TEXT NOT NULL CHECK(document_kind IN ('caption', 'ocr')),
          model_key TEXT NOT NULL,
          model_version TEXT NOT NULL,
          text TEXT NOT NULL,
          language TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          source_job_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(project_id, asset_id, generation, document_kind),
          FOREIGN KEY(project_id, asset_id) REFERENCES assets(project_id, id) ON DELETE CASCADE,
          FOREIGN KEY(project_id, generation) REFERENCES asset_semantic_generations(project_id, generation) ON DELETE CASCADE,
          FOREIGN KEY(model_key, model_version) REFERENCES asset_semantic_models(model_key, model_version) ON DELETE RESTRICT,
          FOREIGN KEY(source_job_id) REFERENCES asset_semantic_jobs(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_asset_semantic_documents_active
          ON asset_semantic_documents(project_id, generation, asset_id, document_kind);

        CREATE TABLE IF NOT EXISTS asset_semantic_embeddings (
          project_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          model_key TEXT NOT NULL,
          model_version TEXT NOT NULL,
          dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND ${ASSET_SEMANTIC_VECTOR_MAX_DIMENSIONS}),
          vector_blob BLOB NOT NULL CHECK(length(vector_blob) = dimensions * 4),
          vector_norm REAL NOT NULL CHECK(vector_norm > 0),
          metadata_json TEXT NOT NULL DEFAULT '{}',
          source_job_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, asset_id, generation, model_key, model_version),
          FOREIGN KEY(project_id, asset_id) REFERENCES assets(project_id, id) ON DELETE CASCADE,
          FOREIGN KEY(project_id, generation) REFERENCES asset_semantic_generations(project_id, generation) ON DELETE CASCADE,
          FOREIGN KEY(model_key, model_version) REFERENCES asset_semantic_models(model_key, model_version) ON DELETE RESTRICT,
          FOREIGN KEY(source_job_id) REFERENCES asset_semantic_jobs(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_asset_semantic_embeddings_active
          ON asset_semantic_embeddings(project_id, generation, model_key, model_version, asset_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS asset_semantic_fts USING fts5(
          text,
          project_id UNINDEXED,
          asset_id UNINDEXED,
          generation UNINDEXED,
          document_kind UNINDEXED,
          tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS trg_asset_semantic_documents_fts_insert
        AFTER INSERT ON asset_semantic_documents BEGIN
          INSERT INTO asset_semantic_fts(rowid, text, project_id, asset_id, generation, document_kind)
          VALUES (NEW.id, NEW.text, NEW.project_id, NEW.asset_id, NEW.generation, NEW.document_kind);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_semantic_documents_fts_update
        AFTER UPDATE ON asset_semantic_documents BEGIN
          DELETE FROM asset_semantic_fts WHERE rowid = OLD.id;
          INSERT INTO asset_semantic_fts(rowid, text, project_id, asset_id, generation, document_kind)
          VALUES (NEW.id, NEW.text, NEW.project_id, NEW.asset_id, NEW.generation, NEW.document_kind);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_semantic_documents_fts_delete
        AFTER DELETE ON asset_semantic_documents BEGIN
          DELETE FROM asset_semantic_fts WHERE rowid = OLD.id;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_asset_semantic_models_identity_immutable
        BEFORE UPDATE OF model_key, model_version, capability ON asset_semantic_models
        WHEN NEW.model_key <> OLD.model_key OR NEW.model_version <> OLD.model_version OR NEW.capability <> OLD.capability
        BEGIN SELECT RAISE(ABORT, 'asset_semantic_models identity is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_semantic_profiles_project_immutable
        BEFORE UPDATE OF project_id ON asset_semantic_profiles
        WHEN NEW.project_id <> OLD.project_id
        BEGIN SELECT RAISE(ABORT, 'asset_semantic_profiles project_id is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_semantic_profiles_generation_update
        BEFORE UPDATE OF active_generation, building_generation ON asset_semantic_profiles BEGIN
          SELECT CASE WHEN NEW.active_generation IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM asset_semantic_generations g
            WHERE g.project_id = NEW.project_id AND g.generation = NEW.active_generation
          ) THEN RAISE(ABORT, 'asset_semantic_profiles active generation mismatch') END;
          SELECT CASE WHEN NEW.building_generation IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM asset_semantic_generations g
            WHERE g.project_id = NEW.project_id AND g.generation = NEW.building_generation
          ) THEN RAISE(ABORT, 'asset_semantic_profiles building generation mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_semantic_generations_identity_immutable
        BEFORE UPDATE OF project_id, generation ON asset_semantic_generations
        WHEN NEW.project_id <> OLD.project_id OR NEW.generation <> OLD.generation
        BEGIN SELECT RAISE(ABORT, 'asset_semantic_generations identity is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_semantic_jobs_owner_insert
        BEFORE INSERT ON asset_semantic_jobs BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM assets a WHERE a.project_id = NEW.project_id AND a.id = NEW.asset_id
          ) THEN RAISE(ABORT, 'asset_semantic_jobs project mismatch') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM asset_semantic_generations g
            WHERE g.project_id = NEW.project_id AND g.generation = NEW.generation
          ) THEN RAISE(ABORT, 'asset_semantic_jobs generation mismatch') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM asset_semantic_models m
            WHERE m.model_key = NEW.model_key AND m.model_version = NEW.model_version
              AND m.capability = NEW.job_kind
          ) THEN RAISE(ABORT, 'asset_semantic_jobs model mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_semantic_jobs_owner_update
        BEFORE UPDATE ON asset_semantic_jobs BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM assets a WHERE a.project_id = NEW.project_id AND a.id = NEW.asset_id
          ) THEN RAISE(ABORT, 'asset_semantic_jobs project mismatch') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM asset_semantic_generations g
            WHERE g.project_id = NEW.project_id AND g.generation = NEW.generation
          ) THEN RAISE(ABORT, 'asset_semantic_jobs generation mismatch') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM asset_semantic_models m
            WHERE m.model_key = NEW.model_key AND m.model_version = NEW.model_version
              AND m.capability = NEW.job_kind
          ) THEN RAISE(ABORT, 'asset_semantic_jobs model mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_semantic_documents_owner_insert
        BEFORE INSERT ON asset_semantic_documents BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM assets a WHERE a.project_id = NEW.project_id AND a.id = NEW.asset_id
          ) THEN RAISE(ABORT, 'asset_semantic_documents project mismatch') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM asset_semantic_models m
            WHERE m.model_key = NEW.model_key AND m.model_version = NEW.model_version
              AND m.capability = NEW.document_kind
          ) THEN RAISE(ABORT, 'asset_semantic_documents model mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_semantic_documents_owner_update
        BEFORE UPDATE ON asset_semantic_documents BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM assets a WHERE a.project_id = NEW.project_id AND a.id = NEW.asset_id
          ) THEN RAISE(ABORT, 'asset_semantic_documents project mismatch') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM asset_semantic_models m
            WHERE m.model_key = NEW.model_key AND m.model_version = NEW.model_version
              AND m.capability = NEW.document_kind
          ) THEN RAISE(ABORT, 'asset_semantic_documents model mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_semantic_embeddings_owner_insert
        BEFORE INSERT ON asset_semantic_embeddings BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM assets a WHERE a.project_id = NEW.project_id AND a.id = NEW.asset_id
          ) THEN RAISE(ABORT, 'asset_semantic_embeddings project mismatch') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM asset_semantic_models m
            WHERE m.model_key = NEW.model_key AND m.model_version = NEW.model_version
              AND m.capability = 'embedding'
          ) THEN RAISE(ABORT, 'asset_semantic_embeddings model mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_semantic_embeddings_owner_update
        BEFORE UPDATE ON asset_semantic_embeddings BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM assets a WHERE a.project_id = NEW.project_id AND a.id = NEW.asset_id
          ) THEN RAISE(ABORT, 'asset_semantic_embeddings project mismatch') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM asset_semantic_models m
            WHERE m.model_key = NEW.model_key AND m.model_version = NEW.model_version
              AND m.capability = 'embedding'
          ) THEN RAISE(ABORT, 'asset_semantic_embeddings model mismatch') END;
        END;
      `);
      ensureColumn('canvas_patch_applications', 'guard_version', 'guard_version INTEGER NOT NULL DEFAULT 0 CHECK(guard_version IN (0, 1))');
      ensureColumn('canvas_patch_applications', 'provenance_guards_json', "provenance_guards_json TEXT NOT NULL DEFAULT '[]'");
      ensureColumn('canvas_patch_applications', 'provenance_guards_digest', "provenance_guards_digest TEXT NOT NULL DEFAULT ''");
      ensureColumn('asset_blob_refs', 'verification_state', "verification_state TEXT NOT NULL DEFAULT 'legacy-unverified'");
      ensureColumn('asset_blobs', 'storage_key', 'storage_key TEXT');
      ensureColumn('asset_blobs', 'storage_state', "storage_state TEXT NOT NULL DEFAULT 'logical'");
      ensureColumn('asset_blobs', 'verified_at', 'verified_at INTEGER');
      ensureColumn('asset_blobs', 'pending_delete_at', 'pending_delete_at INTEGER');
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_asset_blobs_storage_state
          ON asset_blobs(storage_state, pending_delete_at, updated_at);
      `);
      ensureColumn('asset_duplicate_candidates', 'minimum_distance', 'minimum_distance INTEGER NOT NULL DEFAULT 8');
      ensureColumn('asset_duplicate_candidates', 'catalog_revision', 'catalog_revision INTEGER NOT NULL DEFAULT 0');
      // R17 was exercised by local prerelease builds before its final model-download
      // idempotency contract landed. Keep those databases readable without claiming a
      // new public schema round; released schema-16 databases still create both
      // columns directly in the transactional R17 migration above.
      ensureColumn('asset_semantic_models', 'download_idempotency_key', 'download_idempotency_key TEXT');
      ensureColumn('asset_semantic_models', 'download_request_revision', 'download_request_revision INTEGER');
      const semanticGenerationColumns = new Set(this.db.pragma('table_info(asset_semantic_generations)').map((entry) => entry.name));
      const needsSemanticEnrollmentBackfill = !semanticGenerationColumns.has('jobs_sealed')
        || !semanticGenerationColumns.has('expected_job_count')
        || !semanticGenerationColumns.has('eligible_asset_count')
        || !semanticGenerationColumns.has('excluded_asset_count');
      ensureColumn('asset_semantic_generations', 'idempotency_key', 'idempotency_key TEXT');
      ensureColumn('asset_semantic_generations', 'jobs_sealed', 'jobs_sealed INTEGER NOT NULL DEFAULT 0 CHECK(jobs_sealed IN (0, 1))');
      ensureColumn('asset_semantic_generations', 'expected_job_count', 'expected_job_count INTEGER NOT NULL DEFAULT 0 CHECK(expected_job_count >= 0)');
      ensureColumn('asset_semantic_generations', 'eligible_asset_count', 'eligible_asset_count INTEGER NOT NULL DEFAULT 0 CHECK(eligible_asset_count >= 0)');
      ensureColumn('asset_semantic_generations', 'excluded_asset_count', 'excluded_asset_count INTEGER NOT NULL DEFAULT 0 CHECK(excluded_asset_count >= 0)');
      ensureColumn('asset_semantic_generations', 'payload_pruned_at', 'payload_pruned_at INTEGER');
      if (needsSemanticEnrollmentBackfill) {
        this.db.exec(`
          UPDATE asset_semantic_generations
          SET jobs_sealed = CASE WHEN status = 'building' THEN 0 ELSE 1 END,
              expected_job_count = (
                SELECT COUNT(*) FROM asset_semantic_jobs j
                WHERE j.project_id = asset_semantic_generations.project_id
                  AND j.generation = asset_semantic_generations.generation
              ),
              eligible_asset_count = 0,
              excluded_asset_count = 0;
        `);
      }
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_semantic_generations_idempotency
          ON asset_semantic_generations(project_id, idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_asset_duplicate_candidates_left_page
          ON asset_duplicate_candidates(project_id, left_asset_id, catalog_revision, minimum_distance, distance, right_asset_id, id);
        CREATE INDEX IF NOT EXISTS idx_asset_duplicate_candidates_right_page
          ON asset_duplicate_candidates(project_id, right_asset_id, catalog_revision, minimum_distance, distance, left_asset_id, id);
      `);

      if (needsAssetStorageBackfill) {
        this.db.prepare(`
          UPDATE assets SET storage_mode = CASE
            WHEN managed_path IS NOT NULL AND TRIM(managed_path) <> '' THEN 'managed'
            WHEN source_url LIKE 'http://%' OR source_url LIKE 'https://%' THEN 'remote'
            WHEN source_url IS NULL OR TRIM(source_url) = '' THEN 'embedded'
            ELSE 'linked'
          END
        `).run();
      }
      const legacyLineageRows = this.db.prepare(`
        SELECT l.*, a.project_id, a.created_by
        FROM asset_lineage l JOIN assets a ON a.id = l.child_asset_id
      `).all();
      const insertLineageEvent = this.db.prepare(`
        INSERT OR IGNORE INTO asset_lineage_events(
          id, project_id, asset_id, parent_asset_id, source_type, source_node_id, source_node_type,
          run_id, node_run_id, attempt_id, canvas_id, creator_id, prompt_summary, prompt_digest,
          derived_operation, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?)
      `);
      for (const row of legacyLineageRows) {
        const eventId = `lineage_${crypto.createHash('sha256').update(JSON.stringify([
          row.child_asset_id, row.parent_asset_id, row.relation, row.run_id, row.node_run_id, row.attempt_id,
        ])).digest('hex').slice(0, 32)}`;
        insertLineageEvent.run(
          eventId,
          row.project_id,
          row.child_asset_id,
          row.parent_asset_id,
          'legacy-derived',
          row.run_id,
          row.node_run_id,
          row.attempt_id,
          row.created_by || 'local-owner',
          row.prompt_digest,
          row.relation,
          row.metadata_json || '{}',
          row.created_at,
        );
      }

      // Schema 16 keeps lineage identity after an asset index is removed. The
      // old cascading foreign keys erased the historical edge when either end
      // was deleted, so rebuild once without destructive asset FKs. Safe public
      // tombstones are written by removeAssetIndex before the asset row goes.
      const lineageForeignKeys = this.db.pragma('foreign_key_list(asset_lineage_events)');
      if (lineageForeignKeys.some((entry) => entry.table === 'assets')) {
        this.db.exec(`
          ALTER TABLE asset_lineage_events RENAME TO asset_lineage_events_legacy_v16;
          CREATE TABLE asset_lineage_events (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            asset_id TEXT NOT NULL,
            parent_asset_id TEXT,
            source_type TEXT NOT NULL,
            source_node_id TEXT,
            source_node_type TEXT,
            run_id TEXT,
            node_run_id TEXT,
            attempt_id TEXT,
            canvas_id TEXT,
            creator_id TEXT NOT NULL,
            prompt_summary TEXT,
            prompt_digest TEXT,
            derived_operation TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL
          );
          INSERT INTO asset_lineage_events(
            id, project_id, asset_id, parent_asset_id, source_type, source_node_id, source_node_type,
            run_id, node_run_id, attempt_id, canvas_id, creator_id, prompt_summary, prompt_digest,
            derived_operation, metadata_json, created_at
          )
          SELECT id, project_id, asset_id, parent_asset_id, source_type, source_node_id, source_node_type,
            run_id, node_run_id, attempt_id, canvas_id, creator_id, prompt_summary, prompt_digest,
            derived_operation, metadata_json, created_at
          FROM asset_lineage_events_legacy_v16;
          DROP TABLE asset_lineage_events_legacy_v16;
          CREATE INDEX idx_asset_lineage_events_asset ON asset_lineage_events(asset_id, created_at DESC);
          CREATE INDEX idx_asset_lineage_events_parent ON asset_lineage_events(parent_asset_id, created_at DESC);
          CREATE INDEX idx_asset_lineage_events_run ON asset_lineage_events(run_id, node_run_id, attempt_id);
          CREATE INDEX idx_asset_lineage_events_project_asset ON asset_lineage_events(project_id, asset_id, created_at DESC, id);
          CREATE INDEX idx_asset_lineage_events_project_parent ON asset_lineage_events(project_id, parent_asset_id, created_at DESC, id);
        `);
      } else {
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_asset_lineage_events_project_asset ON asset_lineage_events(project_id, asset_id, created_at DESC, id);
          CREATE INDEX IF NOT EXISTS idx_asset_lineage_events_project_parent ON asset_lineage_events(project_id, parent_asset_id, created_at DESC, id);
        `);
      }

      const migratedAssetRows = this.db.prepare('SELECT * FROM assets ORDER BY project_id, id').all();
      const insertBlob = this.db.prepare(`
        INSERT INTO asset_blobs(id, content_hash, verification_state, byte_size, mime_type, created_at, updated_at)
        VALUES (?, ?, 'legacy-unverified', ?, ?, ?, ?)
        ON CONFLICT(content_hash) DO UPDATE SET
          byte_size=COALESCE(asset_blobs.byte_size, excluded.byte_size),
          mime_type=COALESCE(asset_blobs.mime_type, excluded.mime_type),
          updated_at=MAX(asset_blobs.updated_at, excluded.updated_at)
      `);
      const insertBlobRef = this.db.prepare(`
        INSERT OR IGNORE INTO asset_blob_refs(project_id, asset_id, blob_id, verification_state, created_at, updated_at)
        VALUES (?, ?, ?, 'legacy-unverified', ?, ?)
      `);
      const updateAssetV16 = this.db.prepare(`
        UPDATE assets SET source_locator = COALESCE(source_locator, ?),
          perceptual_hash_algorithm = COALESCE(perceptual_hash_algorithm, ?),
          organization_revision = MAX(1, COALESCE(organization_revision, 1))
        WHERE id = ?
      `);
      const insertFingerprint = this.db.prepare(`
        INSERT OR IGNORE INTO asset_fingerprints(
          id, project_id, asset_id, content_hash, algorithm, frame_kind, frame_index,
          timestamp_ms, normalized_time, hash_hex,
          band_0, band_1, band_2, band_3, band_4, band_5, band_6, band_7, band_8,
          evidence_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertDefaultPolicy = this.db.prepare(`
        INSERT OR IGNORE INTO asset_access_policies(project_id, asset_id, scope, revision, updated_by, updated_at)
        VALUES (?, ?, 'project', 1, 'schema16-migration', ?)
      `);
      const catalogProjects = new Set();
      for (const row of migratedAssetRows) {
        catalogProjects.add(row.project_id);
        const metadata = parseJson(row.metadata_json, {});
        const locatorRoot = metadata.root || row.storage_mode || 'unknown';
        const locatorPath = String(row.storage_mode || '').toLowerCase() === 'linked' && row.managed_path
          ? row.managed_path
          : (metadata.relativePath || row.managed_path || row.source_url || row.id);
        const sourceLocator = stableAssetSourceLocator(row.project_id, locatorRoot, locatorPath);
        const contentHash = normalizeSha256(row.content_hash);
        if (contentHash) {
          const blobId = `blob_${contentHash}`;
          const now = Number(row.updated_at) || Date.now();
          insertBlob.run(blobId, contentHash, Number(metadata.size) || null, row.mime_type || null, Number(row.created_at) || now, now);
          insertBlobRef.run(row.project_id, row.id, blobId, Number(row.created_at) || now, now);
        }
        const fingerprints = normalizeFingerprintEntries({ metadata, perceptualHash: row.perceptual_hash }, {
          id: row.id,
          kind: row.kind,
          metadata,
          perceptualHash: row.perceptual_hash,
        });
        updateAssetV16.run(sourceLocator, fingerprints.algorithm, row.id);
        if (contentHash && fingerprints.algorithm) {
          for (const entry of fingerprints.entries) {
            const bands = fingerprintBands(entry.hash);
            const fingerprintId = `fp_${crypto.createHash('sha256').update(stableJson([
              row.id, contentHash, fingerprints.algorithm, entry.frameKind, entry.frameIndex,
            ])).digest('hex').slice(0, 32)}`;
            insertFingerprint.run(
              fingerprintId, row.project_id, row.id, contentHash, fingerprints.algorithm,
              entry.frameKind, entry.frameIndex, entry.timestampMs, entry.normalizedTime, entry.hash,
              ...bands, JSON.stringify(entry.evidence || {}), Number(row.created_at) || Date.now(), Number(row.updated_at) || Date.now(),
            );
          }
        }
        insertDefaultPolicy.run(row.project_id, row.id, Number(row.updated_at) || Date.now());
      }
      const insertCatalog = this.db.prepare(`
        INSERT OR IGNORE INTO asset_catalog_revisions(project_id, revision, updated_at) VALUES (?, 1, ?)
      `);
      for (const projectId of catalogProjects) insertCatalog.run(projectId, Date.now());

      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_project_id ON assets(project_id, id);
        CREATE TRIGGER IF NOT EXISTS trg_assets_project_immutable
        BEFORE UPDATE OF project_id ON assets
        WHEN NEW.project_id <> OLD.project_id BEGIN
          SELECT RAISE(ABORT, 'assets project_id is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_blob_refs_project_insert
        BEFORE INSERT ON asset_blob_refs BEGIN
          SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = NEW.asset_id AND a.project_id = NEW.project_id)
            THEN RAISE(ABORT, 'asset_blob_refs project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_blob_refs_project_update
        BEFORE UPDATE ON asset_blob_refs BEGIN
          SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = NEW.asset_id AND a.project_id = NEW.project_id)
            THEN RAISE(ABORT, 'asset_blob_refs project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_fingerprints_project_insert
        BEFORE INSERT ON asset_fingerprints BEGIN
          SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = NEW.asset_id AND a.project_id = NEW.project_id)
            THEN RAISE(ABORT, 'asset_fingerprints project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_fingerprints_project_update
        BEFORE UPDATE ON asset_fingerprints BEGIN
          SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = NEW.asset_id AND a.project_id = NEW.project_id)
            THEN RAISE(ABORT, 'asset_fingerprints project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_duplicate_candidates_project_insert
        BEFORE INSERT ON asset_duplicate_candidates BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM assets l JOIN assets r ON r.id = NEW.right_asset_id
            WHERE l.id = NEW.left_asset_id AND l.project_id = NEW.project_id AND r.project_id = NEW.project_id
          ) THEN RAISE(ABORT, 'asset_duplicate_candidates project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_duplicate_candidates_project_update
        BEFORE UPDATE ON asset_duplicate_candidates BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM assets l JOIN assets r ON r.id = NEW.right_asset_id
            WHERE l.id = NEW.left_asset_id AND l.project_id = NEW.project_id AND r.project_id = NEW.project_id
          ) THEN RAISE(ABORT, 'asset_duplicate_candidates project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_duplicate_scans_project_insert
        BEFORE INSERT ON asset_duplicate_scans BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM assets a WHERE a.id = NEW.asset_id AND a.project_id = NEW.project_id
          ) THEN RAISE(ABORT, 'asset_duplicate_scans project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_duplicate_scans_project_update
        BEFORE UPDATE ON asset_duplicate_scans BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM assets a WHERE a.id = NEW.asset_id AND a.project_id = NEW.project_id
          ) THEN RAISE(ABORT, 'asset_duplicate_scans project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_lineage_events_project_insert
        BEFORE INSERT ON asset_lineage_events BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM assets a WHERE a.id = NEW.asset_id AND a.project_id = NEW.project_id
            UNION ALL
            SELECT 1 FROM asset_lineage_tombstones t WHERE t.id = NEW.asset_id AND t.project_id = NEW.project_id
          ) THEN RAISE(ABORT, 'asset_lineage_events child project mismatch') END;
          SELECT CASE WHEN NEW.parent_asset_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM assets a WHERE a.id = NEW.parent_asset_id AND a.project_id = NEW.project_id
            UNION ALL
            SELECT 1 FROM asset_lineage_tombstones t WHERE t.id = NEW.parent_asset_id AND t.project_id = NEW.project_id
          ) THEN RAISE(ABORT, 'asset_lineage_events parent project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_lineage_events_project_update
        BEFORE UPDATE ON asset_lineage_events BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM assets a WHERE a.id = NEW.asset_id AND a.project_id = NEW.project_id
            UNION ALL
            SELECT 1 FROM asset_lineage_tombstones t WHERE t.id = NEW.asset_id AND t.project_id = NEW.project_id
          ) THEN RAISE(ABORT, 'asset_lineage_events child project mismatch') END;
          SELECT CASE WHEN NEW.parent_asset_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM assets a WHERE a.id = NEW.parent_asset_id AND a.project_id = NEW.project_id
            UNION ALL
            SELECT 1 FROM asset_lineage_tombstones t WHERE t.id = NEW.parent_asset_id AND t.project_id = NEW.project_id
          ) THEN RAISE(ABORT, 'asset_lineage_events parent project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_access_policies_project_insert
        BEFORE INSERT ON asset_access_policies BEGIN
          SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = NEW.asset_id AND a.project_id = NEW.project_id)
            THEN RAISE(ABORT, 'asset_access_policies project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_access_policies_project_update
        BEFORE UPDATE ON asset_access_policies BEGIN
          SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = NEW.asset_id AND a.project_id = NEW.project_id)
            THEN RAISE(ABORT, 'asset_access_policies project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_access_grants_project_insert
        BEFORE INSERT ON asset_access_grants BEGIN
          SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = NEW.asset_id AND a.project_id = NEW.project_id)
            THEN RAISE(ABORT, 'asset_access_grants project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_access_grants_project_update
        BEFORE UPDATE ON asset_access_grants BEGIN
          SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = NEW.asset_id AND a.project_id = NEW.project_id)
            THEN RAISE(ABORT, 'asset_access_grants project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_collection_members_project_insert
        BEFORE INSERT ON asset_collection_members BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM asset_collections c JOIN assets a ON a.id = NEW.asset_id
            WHERE c.id = NEW.collection_id AND c.project_id = a.project_id
          ) THEN RAISE(ABORT, 'asset_collection_members project mismatch') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_asset_collection_members_project_update
        BEFORE UPDATE ON asset_collection_members BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM asset_collections c JOIN assets a ON a.id = NEW.asset_id
            WHERE c.id = NEW.collection_id AND c.project_id = a.project_id
          ) THEN RAISE(ABORT, 'asset_collection_members project mismatch') END;
        END;
      `);
      const assetIdentityRows = this.db.prepare(`
        SELECT id, project_id FROM assets WHERE entity_uid IS NULL OR TRIM(entity_uid) = ''
      `).all();
      const updateAssetIdentity = this.db.prepare('UPDATE assets SET entity_uid = ? WHERE id = ?');
      for (const row of assetIdentityRows) {
        updateAssetIdentity.run(stableEntityUuid(row.project_id, 'asset', row.id), row.id);
      }
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_project_entity_uid
          ON assets(project_id, entity_uid) WHERE entity_uid IS NOT NULL;
      `);

      this.db.exec(`
        UPDATE canvas_operations
        SET project_id = (
          SELECT d.project_id FROM canvas_documents d
          WHERE d.canvas_id = canvas_operations.canvas_id
        )
        WHERE EXISTS (
          SELECT 1 FROM canvas_documents d
          WHERE d.canvas_id = canvas_operations.canvas_id
            AND d.project_id <> canvas_operations.project_id
        );
      `);
      const legacyOperationRows = this.db.prepare(`
        SELECT op_id, project_id, canvas_id, revision, base_revision, actor_id,
               session_id, client_seq, type, payload_json, created_at
        FROM canvas_operations
      `).all();
      const backfillOperationIdentity = this.db.prepare(`
        INSERT OR IGNORE INTO canvas_operation_idempotency(
          op_id, project_id, canvas_id, revision, base_revision, actor_id,
          session_id, client_seq, type, payload_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of legacyOperationRows) {
        backfillOperationIdentity.run(
          row.op_id,
          row.project_id,
          row.canvas_id,
          Number(row.revision),
          row.base_revision == null ? null : Number(row.base_revision),
          row.actor_id,
          row.session_id,
          Number(row.client_seq),
          row.type,
          canvasOperationPayloadDigest(parseJson(row.payload_json, null)),
          Number(row.created_at),
        );
      }

      const canvasRows = this.db.prepare(`
        SELECT canvas_id, project_id, revision, snapshot_json, updated_at FROM canvas_documents
      `).all();
      const updateCanvasSnapshot = this.db.prepare(`
        UPDATE canvas_documents SET schema_version = ?, snapshot_json = ? WHERE canvas_id = ?
      `);
      for (const row of canvasRows) {
        const normalized = normalizeCanvasDocument(row.canvas_id, parseJson(row.snapshot_json, {}), {
          projectId: row.project_id,
          revision: row.revision,
          updatedAt: row.updated_at,
        });
        const serialized = JSON.stringify(normalized);
        if (serialized !== row.snapshot_json) updateCanvasSnapshot.run(normalized.schemaVersion, serialized, row.canvas_id);
      }

      const historyRows = this.db.prepare(`
        SELECT canvas_id, revision, project_id, snapshot_json, created_at FROM canvas_snapshots
      `).all();
      const updateHistorySnapshot = this.db.prepare(`
        UPDATE canvas_snapshots SET snapshot_json = ? WHERE canvas_id = ? AND revision = ?
      `);
      for (const row of historyRows) {
        const normalized = normalizeCanvasDocument(row.canvas_id, parseJson(row.snapshot_json, {}), {
          projectId: row.project_id,
          revision: row.revision,
          updatedAt: row.created_at,
        });
        const serialized = JSON.stringify(normalized);
        if (serialized !== row.snapshot_json) updateHistorySnapshot.run(serialized, row.canvas_id, row.revision);
      }
      const now = Date.now();
      const schema22AlreadyApplied = Boolean(
        this.db.prepare('SELECT 1 AS applied FROM schema_migrations WHERE version = 22').get(),
      );
      if (!schema22AlreadyApplied) {
        const legacyReservations = this.db.prepare(`
          SELECT id, project_id, canvas_id, canvas_revision, node_ids_json, status
          FROM run_intents
          WHERE run_id IS NULL
            AND status IN ('pending', 'accepted')
            AND (
              execution_authority_json IS NULL
              OR TRIM(execution_authority_json) = ''
              OR TRIM(execution_authority_json) = '{}'
            )
          ORDER BY created_at ASC, id ASC
        `).all();
        const readCanvas = this.db.prepare(`
          SELECT canvas_id, project_id, revision, snapshot_json, updated_at
          FROM canvas_documents WHERE canvas_id = ?
        `);
        const recoverReservation = this.db.prepare(`
          UPDATE run_intents
          SET status = 'pending',
              provider = ?,
              model = ?,
              estimated_cost = 0,
              estimated_cost_known = 0,
              execution_authority_json = ?,
              updated_at = ?
          WHERE id = ? AND run_id IS NULL AND status IN ('pending', 'accepted')
        `);
        const staleReservation = this.db.prepare(`
          UPDATE run_intents
          SET status = 'stale', updated_at = ?
          WHERE id = ? AND run_id IS NULL AND status IN ('pending', 'accepted')
        `);
        const auditReservationRecovery = this.db.prepare(`
          INSERT INTO audit_events(
            project_id, canvas_id, actor_id, session_id, action,
            target_type, target_id, metadata_json, created_at
          ) VALUES (?, ?, 'local-owner', 'schema22-migration', ?, 'run-intent', ?, ?, ?)
        `);
        for (const row of legacyReservations) {
          let nextStatus = 'stale';
          let reasonCode = 'intent_canvas_scope_invalid';
          try {
            const canvasRow = readCanvas.get(row.canvas_id);
            if (!canvasRow
              || canvasRow.project_id !== row.project_id
              || Number(canvasRow.revision) !== Number(row.canvas_revision)) {
              throw Object.assign(new Error('旧运行意图的画布或 revision 已变化'), {
                code: 'intent_canvas_stale',
              });
            }
            const canvas = normalizeCanvasDocument(
              canvasRow.canvas_id,
              parseJson(canvasRow.snapshot_json, {}),
              {
                projectId: canvasRow.project_id,
                revision: canvasRow.revision,
                updatedAt: canvasRow.updated_at,
              },
            );
            const authority = deriveRunIntentAuthority(canvas, parseJson(row.node_ids_json, []));
            const summary = summarizeRunIntentAuthority(authority);
            recoverReservation.run(
              summary.provider,
              summary.model,
              JSON.stringify(authority),
              now,
              row.id,
            );
            nextStatus = 'pending';
            reasonCode = 'authority_backfilled';
          } catch (error) {
            reasonCode = String(error?.code || 'intent_execution_authority_unresolved').slice(0, 120);
            staleReservation.run(now, row.id);
          }
          auditReservationRecovery.run(
            row.project_id,
            row.canvas_id,
            'collaboration.run-intent.schema22-recover',
            row.id,
            JSON.stringify({
              previousStatus: row.status,
              nextStatus,
              reasonCode,
            }),
            now,
          );
        }
      }
      const schema23AlreadyApplied = Boolean(
        this.db.prepare('SELECT 1 AS applied FROM schema_migrations WHERE version = 23').get(),
      );
      if (!schema23AlreadyApplied) {
        this.db.exec(`
          UPDATE collaboration_invites
          SET canvas_id = (
            SELECT MIN(d.canvas_id)
            FROM canvas_documents d
            WHERE d.project_id = collaboration_invites.project_id
            HAVING COUNT(*) = 1
          )
          WHERE canvas_id IS NULL OR TRIM(canvas_id) = '';

          UPDATE collaboration_members
          SET canvas_id = (
            SELECT MIN(d.canvas_id)
            FROM canvas_documents d
            WHERE d.project_id = collaboration_members.project_id
            HAVING COUNT(*) = 1
          )
          WHERE canvas_id IS NULL OR TRIM(canvas_id) = '';

          UPDATE collaboration_sessions
          SET canvas_id = (
            SELECT m.canvas_id
            FROM collaboration_members m
            WHERE m.id = collaboration_sessions.member_id
              AND m.project_id = collaboration_sessions.project_id
          )
          WHERE canvas_id IS NULL OR TRIM(canvas_id) = '';

          UPDATE collaboration_invites
          SET revoked_at = COALESCE(revoked_at, ${now})
          WHERE canvas_id IS NULL
             OR TRIM(canvas_id) = ''
             OR NOT EXISTS (
               SELECT 1 FROM canvas_documents d
               WHERE d.canvas_id = collaboration_invites.canvas_id
                 AND d.project_id = collaboration_invites.project_id
             );

          UPDATE collaboration_sessions
          SET revoked_at = COALESCE(revoked_at, ${now})
          WHERE canvas_id IS NULL
             OR TRIM(canvas_id) = ''
             OR NOT EXISTS (
               SELECT 1 FROM canvas_documents d
               WHERE d.canvas_id = collaboration_sessions.canvas_id
                 AND d.project_id = collaboration_sessions.project_id
             )
             OR NOT EXISTS (
               SELECT 1 FROM collaboration_members m
               WHERE m.id = collaboration_sessions.member_id
                 AND m.project_id = collaboration_sessions.project_id
                 AND m.canvas_id = collaboration_sessions.canvas_id
             );
        `);
        const invalidScopedIntents = this.db.prepare(`
          SELECT ri.id, ri.project_id, ri.canvas_id, ri.requested_by, ri.status
          FROM run_intents ri
          LEFT JOIN collaboration_members m ON m.id = ri.requested_by
          WHERE ri.run_id IS NULL
            AND ri.status IN ('pending', 'accepted')
            AND (
              m.id IS NULL
              OR m.project_id <> ri.project_id
              OR m.canvas_id IS NULL
              OR TRIM(m.canvas_id) = ''
              OR m.canvas_id <> ri.canvas_id
            )
          ORDER BY ri.created_at ASC, ri.id ASC
        `).all();
        const staleInvalidScopedIntent = this.db.prepare(`
          UPDATE run_intents
          SET status = 'stale', updated_at = ?
          WHERE id = ? AND run_id IS NULL AND status IN ('pending', 'accepted')
        `);
        const auditInvalidScopedIntent = this.db.prepare(`
          INSERT INTO audit_events(
            project_id, canvas_id, actor_id, session_id, action,
            target_type, target_id, metadata_json, created_at
          ) VALUES (?, ?, 'local-owner', 'schema23-migration',
            'collaboration.run-intent.schema23-scope-stale',
            'run-intent', ?, ?, ?)
        `);
        for (const intent of invalidScopedIntents) {
          staleInvalidScopedIntent.run(now, intent.id);
          auditInvalidScopedIntent.run(
            intent.project_id,
            intent.canvas_id,
            intent.id,
            JSON.stringify({
              previousStatus: intent.status,
              nextStatus: 'stale',
              requestedBy: intent.requested_by,
              reasonCode: 'intent_requester_canvas_scope_invalid',
            }),
            now,
          );
        }
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO canvas_resource_grant_state(
          project_id, canvas_id, trusted_revision, initialized_at, updated_at
        )
        SELECT project_id, canvas_id, revision, 0, ?
        FROM canvas_documents
      `).run(now);
      if (!schema23AlreadyApplied) {
        this.db.prepare(`
          UPDATE collaboration_invites
          SET revoked_at = COALESCE(revoked_at, ?)
          WHERE revoked_at IS NULL
            AND EXISTS (
              SELECT 1
              FROM canvas_resource_grant_state state
              WHERE state.project_id = collaboration_invites.project_id
                AND state.canvas_id = collaboration_invites.canvas_id
                AND state.initialized_at <= 0
            )
        `).run(now);
        this.db.prepare(`
          UPDATE collaboration_sessions
          SET revoked_at = COALESCE(revoked_at, ?)
          WHERE revoked_at IS NULL
            AND EXISTS (
              SELECT 1
              FROM canvas_resource_grant_state state
              WHERE state.project_id = collaboration_sessions.project_id
                AND state.canvas_id = collaboration_sessions.canvas_id
                AND state.initialized_at <= 0
            )
        `).run(now);
      }
      for (let version = 1; version <= PROJECT_DATABASE_SCHEMA_VERSION; version += 1) {
        this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, now);
      }
      this.options.beforeMigrationCommit?.(this.db, PROJECT_DATABASE_SCHEMA_VERSION);
    });
    migrateTransaction();
  }

  _upsertCanvasResourceGrant(projectId, canvasId, resourceType, resourceId, resourceVersion, source, now = Date.now()) {
    this.db.prepare(`
      INSERT INTO canvas_resource_grants(
        project_id, canvas_id, resource_type, resource_id, resource_version, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, canvas_id, resource_type, resource_id, resource_version, source)
      DO UPDATE SET updated_at = excluded.updated_at
    `).run(
      String(projectId),
      String(canvasId),
      String(resourceType),
      String(resourceId),
      Math.max(0, Math.trunc(Number(resourceVersion) || 0)),
      String(source),
      now,
      now,
    );
  }

  resolveCanvasDocumentResources(inputDocument, options = {}) {
    const document = inputDocument?.canvasId
      ? inputDocument
      : this.getCanvas(inputDocument);
    if (!document) throw new Error('画布不存在');
    const projectId = String(document.projectId || DEFAULT_PROJECT_ID);
    const canonicalSubflowDigests = new Map();
    const embeddedValidationResults = new Map();
    const validateEmbeddedSubflow = ({
      definitionId,
      version,
      projectId: embeddedProjectId,
      contentDigest,
    }) => {
      if (embeddedProjectId && String(embeddedProjectId) !== projectId) return false;
      const referenceKey = subflowReferenceKey(definitionId, version);
      const validationKey = `${referenceKey}\u0000${String(contentDigest || '')}`;
      if (embeddedValidationResults.has(validationKey)) {
        return embeddedValidationResults.get(validationKey);
      }
      if (!canonicalSubflowDigests.has(referenceKey)) {
        const canonical = this.getSubflowDefinition(definitionId, version, projectId);
        canonicalSubflowDigests.set(
          referenceKey,
          canonical ? subflowDefinitionContentDigest(canonical) : null,
        );
      }
      const valid = Boolean(contentDigest)
        && canonicalSubflowDigests.get(referenceKey) === contentDigest;
      embeddedValidationResults.set(validationKey, valid);
      return valid;
    };
    const collected = collectCanvasResourceReferences(document, {
      validateEmbeddedSubflow,
      validateRootSubflowDefinition: options.validateRootSubflowDefinition,
    });
    const assetIds = new Set(collected.assetIds);
    const assetUrls = new Set(collected.assetUrls);
    const subflowReferences = new Map();
    const requestedSubflowReferences = new Map();
    const subflowDefinitions = new Map();
    const missingSubflows = [];
    const subflowPinMismatches = [...collected.subflowPinMismatches];
    const subflowContentMismatches = [...collected.subflowContentMismatches];
    const queue = [];
    const scheduledSubflowKeys = new Set();
    let truncated = Boolean(collected.truncated);

    const scheduleSubflow = (id, version, depth) => {
      const normalizedId = String(id || '').trim();
      const normalizedVersion = Number(version);
      if (!normalizedId || !Number.isInteger(normalizedVersion) || normalizedVersion < 1) return;
      const key = subflowReferenceKey(normalizedId, normalizedVersion);
      if (scheduledSubflowKeys.has(key)) return;
      if (scheduledSubflowKeys.size >= MAX_SUBFLOW_REFERENCES || depth > 16) {
        truncated = true;
        return;
      }
      scheduledSubflowKeys.add(key);
      if (!requestedSubflowReferences.has(normalizedId)) {
        requestedSubflowReferences.set(normalizedId, new Set());
      }
      requestedSubflowReferences.get(normalizedId).add(normalizedVersion);
      queue.push({ id: normalizedId, version: normalizedVersion, depth, key });
    };

    for (const [id, versions] of collected.subflowReferences) {
      for (const version of versions) scheduleSubflow(id, version, 1);
    }

    while (queue.length > 0) {
      const reference = queue.shift();
      const definition = this.getSubflowDefinition(reference.id, reference.version, projectId);
      if (!definition) {
        missingSubflows.push({ id: reference.id, version: reference.version });
        continue;
      }
      subflowDefinitions.set(reference.key, definition);
      if (!subflowReferences.has(reference.id)) subflowReferences.set(reference.id, new Set());
      subflowReferences.get(reference.id).add(reference.version);
      const nested = collectCanvasResourceReferences(definition, {
        validateEmbeddedSubflow,
      });
      if (nested.truncated) truncated = true;
      for (const mismatch of nested.subflowPinMismatches) {
        if (subflowPinMismatches.length >= MAX_SUBFLOW_REFERENCES) {
          truncated = true;
          break;
        }
        subflowPinMismatches.push(mismatch);
      }
      for (const mismatch of nested.subflowContentMismatches) {
        if (subflowContentMismatches.length >= MAX_SUBFLOW_REFERENCES) {
          truncated = true;
          break;
        }
        subflowContentMismatches.push(mismatch);
      }
      for (const assetId of nested.assetIds) {
        if (assetIds.size >= MAX_ASSET_REFERENCES) truncated = true;
        else assetIds.add(assetId);
      }
      for (const assetUrl of nested.assetUrls) {
        if (assetUrls.size >= MAX_ASSET_REFERENCES) truncated = true;
        else assetUrls.add(assetUrl);
      }
      for (const [id, versions] of nested.subflowReferences) {
        for (const version of versions) scheduleSubflow(id, version, reference.depth + 1);
      }
    }

    const existingAssetIds = new Set();
    const foreignAssetIds = [];
    const candidateAssetIds = [...assetIds].slice(0, MAX_ASSET_REFERENCES);
    for (let index = 0; index < candidateAssetIds.length; index += 400) {
      const batch = candidateAssetIds.slice(index, index + 400);
      if (!batch.length) continue;
      const rows = this.db.prepare(`
        SELECT id, project_id FROM assets
        WHERE id IN (${batch.map(() => '?').join(',')})
      `).all(...batch);
      for (const row of rows) {
        if (String(row.project_id) === projectId) existingAssetIds.add(String(row.id));
        else foreignAssetIds.push(String(row.id));
      }
    }
    for (const asset of this.findAssetsBySourceUrls(projectId, [...assetUrls])) {
      if (asset?.id) existingAssetIds.add(String(asset.id));
    }
    const grantAssetIds = new Set([...assetIds, ...existingAssetIds]);

    return {
      document,
      projectId,
      requestedAssetIds: assetIds,
      assetIds: existingAssetIds,
      grantAssetIds,
      requestedSubflowReferences,
      subflowReferences,
      subflowDefinitions,
      missingSubflows,
      subflowPinMismatches: subflowPinMismatches.slice(0, MAX_SUBFLOW_REFERENCES),
      subflowContentMismatches: subflowContentMismatches.slice(0, MAX_SUBFLOW_REFERENCES),
      foreignAssetIds: [...new Set(foreignAssetIds)],
      truncated,
    };
  }

  _syncCanvasDocumentResourceGrants(document, options = {}) {
    const existingState = this.getCanvasResourceGrantState(document.projectId, document.canvasId);
    if (existingState && existingState.initializedAt <= 0 && options.initializeResourceScope !== true) {
      this._advanceCanvasResourceGrantState(document);
      return {
        projectId: String(document.projectId),
        canvasId: String(document.canvasId),
        trustedRevision: Number(document.revision),
        assetCount: 0,
        subflowCount: 0,
        missingSubflows: [],
        confirmationRequired: true,
      };
    }
    const resolved = this.resolveCanvasDocumentResources(document);
    if (resolved.truncated) {
      const error = new Error('画布资源引用超过协作授权安全上限');
      error.code = 'canvas_resource_scope_too_large';
      error.status = 422;
      throw error;
    }
    if (resolved.subflowPinMismatches.length > 0) {
      const error = new Error('画布包含身份或固定版本不一致的内嵌子工作流');
      error.code = 'canvas_resource_subflow_pin_mismatch';
      error.status = 422;
      throw error;
    }
    const missingSubflowKeys = new Set(
      resolved.missingSubflows.map((reference) => subflowReferenceKey(reference.id, reference.version)),
    );
    const divergentEmbeddedSubflows = resolved.subflowContentMismatches.filter((mismatch) => (
      !missingSubflowKeys.has(subflowReferenceKey(mismatch.definitionId, mismatch.version))
    ));
    if (divergentEmbeddedSubflows.length > 0) {
      const error = new Error('画布包含与权威固定版本内容不一致的内嵌子工作流');
      error.code = 'canvas_resource_subflow_content_mismatch';
      error.status = 422;
      throw error;
    }
    const missingSubflowsRequireConfirmation = resolved.missingSubflows.length > 0;
    if (missingSubflowsRequireConfirmation && options.initializeResourceScope === true) {
      const error = new Error('画布引用的固定版本子工作流不存在');
      error.code = 'canvas_resource_subflow_missing';
      error.status = 422;
      throw error;
    }
    const source = String(options.source || CANVAS_RESOURCE_DOCUMENT_SOURCE);
    const now = Date.now();
    this.db.prepare(`
      DELETE FROM canvas_resource_grants
      WHERE project_id = ? AND canvas_id = ? AND source = ?
    `).run(resolved.projectId, resolved.document.canvasId, source);
    for (const assetId of resolved.grantAssetIds) {
      this._upsertCanvasResourceGrant(
        resolved.projectId,
        resolved.document.canvasId,
        'asset',
        assetId,
        0,
        source,
        now,
      );
    }
    for (const [id, versions] of resolved.requestedSubflowReferences) {
      for (const version of versions) {
        this._upsertCanvasResourceGrant(
          resolved.projectId,
          resolved.document.canvasId,
          'subflow',
          id,
          version,
          source,
          now,
        );
      }
    }
    this.db.prepare(`
      INSERT INTO canvas_resource_grant_state(project_id, canvas_id, trusted_revision, initialized_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, canvas_id)
      DO UPDATE SET
        trusted_revision = excluded.trusted_revision,
        initialized_at = CASE
          WHEN ? = 1 THEN excluded.initialized_at
          WHEN ? = 1 THEN 0
          ELSE canvas_resource_grant_state.initialized_at
        END,
        updated_at = excluded.updated_at
    `).run(
      resolved.projectId,
      resolved.document.canvasId,
      Number(resolved.document.revision),
      missingSubflowsRequireConfirmation ? 0 : now,
      now,
      options.initializeResourceScope === true ? 1 : 0,
      missingSubflowsRequireConfirmation ? 1 : 0,
    );
    return {
      projectId: resolved.projectId,
      canvasId: resolved.document.canvasId,
      trustedRevision: Number(resolved.document.revision),
      assetCount: resolved.grantAssetIds.size,
      subflowCount: [...resolved.requestedSubflowReferences.values()]
        .reduce((total, versions) => total + versions.size, 0),
      missingSubflows: resolved.missingSubflows,
      confirmationRequired: missingSubflowsRequireConfirmation,
    };
  }

  _advanceCanvasResourceGrantState(document) {
    const result = this.db.prepare(`
      UPDATE canvas_resource_grant_state
      SET trusted_revision = ?, updated_at = ?
      WHERE project_id = ? AND canvas_id = ?
    `).run(
      Number(document.revision),
      Date.now(),
      String(document.projectId),
      String(document.canvasId),
    );
    if (result.changes !== 1) {
      const error = new Error('协作资源授权状态尚未由主机初始化');
      error.code = 'canvas_resource_scope_uninitialized';
      error.status = 409;
      throw error;
    }
  }

  _commitCanvasResourceState(document, options = {}) {
    if (options.syncResourceGrants === false) {
      if (typeof options.assertResultingDocument !== 'function') {
        const error = new Error('协作画布写入缺少资源授权校验');
        error.code = 'canvas_resource_authority_required';
        error.status = 403;
        throw error;
      }
      options.assertResultingDocument(document);
      this._advanceCanvasResourceGrantState(document);
      return;
    }
    options.assertResultingDocument?.(document);
    this._syncCanvasDocumentResourceGrants(document);
  }

  syncCanvasDocumentResourceGrants(canvasIdOrDocument, options = {}) {
    const document = typeof canvasIdOrDocument === 'string'
      ? this.getCanvas(canvasIdOrDocument)
      : canvasIdOrDocument;
    if (!document) throw new Error('画布不存在');
    const transaction = this.db.transaction(() => this._syncCanvasDocumentResourceGrants(document, options));
    return transaction.immediate();
  }

  initializeCanvasResourceGrantsForSharing(projectId, canvasId, options = {}) {
    const transaction = this.db.transaction(() => {
      const document = this.getCanvas(canvasId);
      if (!document || String(document.projectId) !== String(projectId)) {
        throw new Error('协作房间画布不存在');
      }
      const summary = this._syncCanvasDocumentResourceGrants(document, {
        initializeResourceScope: true,
      });
      this.db.prepare(`
        UPDATE canvas_operations
        SET requires_snapshot = 1
        WHERE canvas_id = ?
      `).run(String(canvasId));
      this.appendAuditEvent({
        projectId,
        canvasId,
        actorId: options.actorId || 'local-owner',
        sessionId: options.sessionId || 'local-management',
        action: 'collaboration.resource-scope.initialize',
        targetType: 'canvas',
        targetId: canvasId,
        metadata: {
          trustedRevision: summary.trustedRevision,
          assetCount: summary.assetCount,
          subflowCount: summary.subflowCount,
        },
      });
      return summary;
    });
    return transaction.immediate();
  }

  getCanvasResourceGrantState(projectId, canvasId) {
    const state = this.db.prepare(`
      SELECT project_id, canvas_id, trusted_revision, initialized_at, updated_at
      FROM canvas_resource_grant_state WHERE project_id = ? AND canvas_id = ?
    `).get(String(projectId), String(canvasId));
    return state ? {
      projectId: state.project_id,
      canvasId: state.canvas_id,
      trustedRevision: Number(state.trusted_revision),
      initializedAt: Number(state.initialized_at),
      updatedAt: Number(state.updated_at),
    } : null;
  }

  ensureCanvasResourceGrantState(projectId, canvasId) {
    const document = this.getCanvas(canvasId);
    if (!document || String(document.projectId) !== String(projectId)) throw new Error('协作房间画布不存在');
    const state = this.getCanvasResourceGrantState(projectId, canvasId);
    if (state) return state;
    const now = Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO canvas_resource_grant_state(
        project_id, canvas_id, trusted_revision, initialized_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      String(projectId),
      String(canvasId),
      Number(document.revision),
      0,
      now,
    );
    return this.getCanvasResourceGrantState(projectId, canvasId);
  }

  listCanvasResourceGrants(projectId, canvasId) {
    const rows = this.db.prepare(`
      SELECT resource_type, resource_id, resource_version
      FROM canvas_resource_grants
      WHERE project_id = ? AND canvas_id = ?
      GROUP BY resource_type, resource_id, resource_version
      ORDER BY resource_type, resource_id, resource_version
      LIMIT 10000
    `).all(String(projectId), String(canvasId));
    const assetIds = new Set();
    const subflowReferences = new Map();
    for (const row of rows) {
      if (row.resource_type === 'asset') {
        assetIds.add(String(row.resource_id));
        continue;
      }
      if (row.resource_type !== 'subflow') continue;
      const id = String(row.resource_id);
      const version = Number(row.resource_version);
      if (!subflowReferences.has(id)) subflowReferences.set(id, new Set());
      subflowReferences.get(id).add(version);
    }
    return { assetIds, subflowReferences };
  }

  grantCanvasAssetResource(projectId, canvasId, assetId, source = CANVAS_RESOURCE_LINEAGE_SOURCE) {
    const canvas = this.getCanvas(canvasId);
    const asset = this.getAsset(assetId);
    if (!canvas || String(canvas.projectId) !== String(projectId)
      || !asset || String(asset.projectId) !== String(projectId)) {
      throw new Error('素材协作授权必须绑定同一项目中的有效画布和素材');
    }
    this._upsertCanvasResourceGrant(projectId, canvasId, 'asset', assetId, 0, source);
    return String(assetId);
  }

  _grantCanvasSubflowResource(projectId, canvasId, definitionId, version, source, now = Date.now()) {
    const canvas = this.getCanvas(canvasId);
    if (!canvas || String(canvas.projectId) !== String(projectId)) {
      throw new Error('子工作流协作授权必须绑定同一项目中的有效画布');
    }
    const synthetic = {
      projectId: String(projectId),
      canvasId: String(canvasId),
      revision: Number(canvas.revision),
      nodes: [{
        id: 'canvas-resource-grant',
        type: 'subflow',
        position: { x: 0, y: 0 },
        data: { definitionId: String(definitionId), definitionVersion: Number(version) },
      }],
      edges: [],
    };
    const resolved = this.resolveCanvasDocumentResources(synthetic);
    if (resolved.truncated || resolved.missingSubflows.length > 0) {
      throw new Error('子工作流协作授权无法解析固定版本依赖');
    }
    for (const assetId of resolved.assetIds) {
      this._upsertCanvasResourceGrant(projectId, canvasId, 'asset', assetId, 0, source, now);
    }
    for (const [id, versions] of resolved.subflowReferences) {
      for (const grantedVersion of versions) {
        this._upsertCanvasResourceGrant(projectId, canvasId, 'subflow', id, grantedVersion, source, now);
      }
    }
    return { projectId: String(projectId), canvasId: String(canvasId), definitionId: String(definitionId), version: Number(version) };
  }

  grantCanvasSubflowResource(projectId, canvasId, definitionId, version, source = CANVAS_RESOURCE_PUBLISH_SOURCE) {
    const transaction = this.db.transaction(() => this._grantCanvasSubflowResource(
      projectId,
      canvasId,
      definitionId,
      version,
      source,
    ));
    return transaction.immediate();
  }

  close() {
    if (this.db?.open) this.db.close();
  }

  getCanvas(canvasId) {
    const row = this.db.prepare('SELECT * FROM canvas_documents WHERE canvas_id = ?').get(String(canvasId));
    return row ? normalizeCanvasDocument(row.canvas_id, parseJson(row.snapshot_json, {}), {
      projectId: row.project_id,
      revision: row.revision,
      updatedAt: row.updated_at,
    }) : null;
  }

  ensureCanvas(canvasId, snapshot, projectId = DEFAULT_PROJECT_ID, options = {}) {
    const existing = this.getCanvas(canvasId);
    if (existing) return existing;
    const now = Date.now();
    const document = normalizeCanvasDocument(canvasId, snapshot, { projectId, revision: 1, updatedAt: now });
    assertCanvasDocumentInvariants(document);
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO canvas_documents(canvas_id, project_id, schema_version, revision, snapshot_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(document.canvasId, document.projectId, document.schemaVersion, 1, JSON.stringify(document), now, now);
      this.recordCanvasSnapshot(document, 'legacy-migration');
      if (options.initializeResourceScope === false) {
        this.db.prepare(`
          INSERT INTO canvas_resource_grant_state(
            project_id, canvas_id, trusted_revision, initialized_at, updated_at
          ) VALUES (?, ?, ?, 0, ?)
        `).run(
          document.projectId,
          document.canvasId,
          Number(document.revision),
          now,
        );
      } else {
        this._syncCanvasDocumentResourceGrants(document);
      }
      return document;
    });
    return transaction.immediate();
  }

  recordCanvasSnapshot(document, reason = 'periodic') {
    this.db.prepare(`
      INSERT OR REPLACE INTO canvas_snapshots(canvas_id, revision, project_id, reason, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      document.canvasId,
      document.revision,
      document.projectId,
      String(reason || 'periodic').slice(0, 80),
      JSON.stringify(document),
      Date.now(),
    );
    return document;
  }

  getCanvasOperationIdentity(opId) {
    return this.db.prepare(`
      SELECT op_id, project_id, canvas_id, revision, base_revision, actor_id,
             session_id, client_seq, type, payload_digest, created_at
      FROM canvas_operation_idempotency WHERE op_id = ?
    `).get(String(opId));
  }

  insertCanvasOperationRecord(operation, revision, requiresSnapshot = false) {
    const normalizedRevision = Number(revision);
    const createdAt = Number(operation.timestamp);
    const timestamp = Number.isFinite(createdAt) ? createdAt : Date.now();
    const payloadJson = JSON.stringify(operation.payload);
    this.db.prepare(`
      INSERT INTO canvas_operation_idempotency(
        op_id, project_id, canvas_id, revision, base_revision, actor_id,
        session_id, client_seq, type, payload_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      operation.opId,
      operation.projectId,
      operation.canvasId,
      normalizedRevision,
      operation.baseRevision == null ? null : Number(operation.baseRevision),
      operation.actorId,
      operation.sessionId,
      Number(operation.clientSeq),
      operation.type,
      canvasOperationPayloadDigest(operation.payload),
      timestamp,
    );
    this.db.prepare(`
      INSERT INTO canvas_operations(
        op_id, canvas_id, project_id, revision, base_revision, actor_id, session_id,
        client_seq, type, payload_json, requires_snapshot, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      operation.opId,
      operation.canvasId,
      operation.projectId,
      normalizedRevision,
      operation.baseRevision == null ? null : Number(operation.baseRevision),
      operation.actorId,
      operation.sessionId,
      Number(operation.clientSeq),
      operation.type,
      payloadJson,
      requiresSnapshot ? 1 : 0,
      timestamp,
    );
    return normalizedRevision;
  }

  recordCanvasMutationMarks(document, revision, opId, marks, updatedAt = Date.now()) {
    const normalizedRevision = Number(revision);
    if (!Number.isInteger(normalizedRevision) || normalizedRevision < 1) throw new Error('canvas provenance revision 无效');
    const opDigest = canvasMutationOpDigest(opId);
    const insert = this.db.prepare(`
      INSERT INTO canvas_mutation_provenance(
        project_id, canvas_id, target_type, entity_uid, aspect,
        field_scope, field_name, last_revision, last_op_digest, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, canvas_id, target_type, entity_uid, aspect, field_scope, field_name)
      DO UPDATE SET
        last_revision = excluded.last_revision,
        last_op_digest = excluded.last_op_digest,
        updated_at = excluded.updated_at
    `);
    const unique = new Map();
    for (const mark of Array.isArray(marks) ? marks : []) unique.set(canvasMutationMarkKey(mark), mark);
    for (const mark of unique.values()) {
      insert.run(
        document.projectId,
        document.canvasId,
        mark.targetType,
        mark.entityUid,
        mark.aspect,
        mark.fieldScope || '',
        mark.fieldName || '',
        normalizedRevision,
        opDigest,
        Number(updatedAt) || Date.now(),
      );
    }
  }

  recordCanvasOperationMutation(beforeDocument, afterDocument, operation) {
    const marks = deriveCanvasMutationMarks(beforeDocument, afterDocument, operation);
    this.recordCanvasMutationMarks(
      afterDocument,
      afterDocument.revision,
      operation.opId,
      marks,
      operation.timestamp,
    );
    return marks;
  }

  recordCanvasResetMutation(document, opId, updatedAt = Date.now()) {
    this.recordCanvasMutationMarks(document, document.revision, opId, [
      canvasMutationMark('canvas', document.entityUid, 'reset'),
    ], updatedAt);
  }

  buildCanvasPatchProvenanceGuards(document, postconditions) {
    const keys = deriveCanvasPatchProvenanceGuardKeys(document, postconditions);
    const select = this.db.prepare(`
      SELECT last_revision, last_op_digest
      FROM canvas_mutation_provenance
      WHERE project_id = ? AND canvas_id = ? AND target_type = ? AND entity_uid = ?
        AND aspect = ? AND field_scope = ? AND field_name = ?
    `);
    return keys.map((key) => {
      const row = select.get(
        document.projectId,
        document.canvasId,
        key.targetType,
        key.entityUid,
        key.aspect,
        key.fieldScope || '',
        key.fieldName || '',
      );
      return {
        ...key,
        expectedRevision: row ? Number(row.last_revision) : 0,
        expectedOpDigest: row ? String(row.last_op_digest) : '',
      };
    });
  }

  assertCanvasPatchProvenanceGuards(document, rawGuards) {
    if (!Array.isArray(rawGuards) || !rawGuards.length || rawGuards.length > CANVAS_PROVENANCE_GUARD_LIMIT) {
      throw new CanvasPatchRevertConflictError([{
        targetType: 'canvas', targetId: safeIdentifier(document.canvasId),
      }], document.revision);
    }
    const allowedTargetTypes = new Set(['canvas', 'node', 'edge']);
    const allowedAspects = new Set(['reset', 'lifecycle', 'entity', 'connections', 'field']);
    const select = this.db.prepare(`
      SELECT last_revision, last_op_digest
      FROM canvas_mutation_provenance
      WHERE project_id = ? AND canvas_id = ? AND target_type = ? AND entity_uid = ?
        AND aspect = ? AND field_scope = ? AND field_name = ?
    `);
    const seen = new Set();
    const conflicts = [];
    for (const guard of rawGuards) {
      const valid = guard && typeof guard === 'object' && !Array.isArray(guard)
        && allowedTargetTypes.has(guard.targetType)
        && typeof guard.entityUid === 'string' && isUuid(guard.entityUid)
        && allowedAspects.has(guard.aspect)
        && typeof guard.fieldScope === 'string' && guard.fieldScope.length <= 32
        && typeof guard.fieldName === 'string' && guard.fieldName.length <= 160
        && Number.isInteger(guard.expectedRevision) && guard.expectedRevision >= 0
        && typeof guard.expectedOpDigest === 'string'
        && (guard.expectedOpDigest === '' || /^[a-f0-9]{64}$/.test(guard.expectedOpDigest));
      const key = valid ? canvasMutationMarkKey(guard) : '';
      if (!valid || seen.has(key)) {
        throw new CanvasPatchRevertConflictError([{
          targetType: 'canvas', targetId: safeIdentifier(document.canvasId),
        }], document.revision);
      }
      seen.add(key);
      const row = select.get(
        document.projectId,
        document.canvasId,
        guard.targetType,
        guard.entityUid,
        guard.aspect,
        guard.fieldScope,
        guard.fieldName,
      );
      const currentRevision = row ? Number(row.last_revision) : 0;
      const currentOpDigest = row ? String(row.last_op_digest) : '';
      if (currentRevision !== guard.expectedRevision || currentOpDigest !== guard.expectedOpDigest) {
        conflicts.push({
          targetType: guard.targetType,
          targetId: safeIdentifier(guard.targetType === 'canvas' ? document.canvasId : guard.entityUid),
          ...(guard.aspect === 'field' ? {
            field: guard.fieldScope === 'data' ? `data.${safeIdentifier(guard.fieldName)}` : safeIdentifier(guard.fieldName),
          } : {}),
        });
      }
    }
    if (conflicts.length) throw new CanvasPatchRevertConflictError(conflicts, document.revision);
    return true;
  }

  listCanvasSnapshots(canvasId, limit = 100) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    return this.db.prepare(`
      SELECT canvas_id, revision, project_id, reason, created_at
      FROM canvas_snapshots WHERE canvas_id = ? ORDER BY revision DESC LIMIT ?
    `).all(String(canvasId), safeLimit).map((row) => ({
      canvasId: row.canvas_id,
      revision: row.revision,
      projectId: row.project_id,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  restoreCanvasSnapshot(canvasId, sourceRevision, options = {}) {
    const transaction = this.db.transaction(() => {
      const current = this.getCanvas(canvasId);
      if (!current) throw new Error('画布不存在');
      if (options.expectedRevision != null && Number(options.expectedRevision) !== current.revision) {
        throw new RevisionConflictError(current);
      }
      const row = this.db.prepare('SELECT snapshot_json FROM canvas_snapshots WHERE canvas_id = ? AND revision = ?')
        .get(String(canvasId), Number(sourceRevision));
      if (!row) throw new Error(`历史快照不存在: ${sourceRevision}`);
      const restored = normalizeCanvasDocument(canvasId, parseJson(row.snapshot_json, {}), {
        projectId: current.projectId,
        revision: current.revision + 1,
        updatedAt: Date.now(),
      });
      assertCanvasDocumentInvariants(restored);
      assertCanvasDocumentCredentialAuthority(restored, {
        authority: options.authority,
      });
      this._commitCanvasResourceState(restored, options);
      const operationId = String(options.opId || crypto.randomUUID());
      assertUnreservedCanvasOperationId(operationId);
      const updated = this.db.prepare(`
        UPDATE canvas_documents
        SET schema_version = ?, revision = ?, snapshot_json = ?, updated_at = ?
        WHERE canvas_id = ? AND project_id = ? AND revision = ?
      `).run(
        restored.schemaVersion,
        restored.revision,
        JSON.stringify(restored),
        restored.updatedAt,
        restored.canvasId,
        restored.projectId,
        current.revision,
      );
      if (updated.changes !== 1) throw new RevisionConflictError(this.getCanvas(canvasId));
      this.recordCanvasResetMutation(restored, operationId, restored.updatedAt);
      this.recordCanvasSnapshot(restored, `restore:${sourceRevision}`);
      this.appendAuditEvent({
        projectId: restored.projectId,
        canvasId: restored.canvasId,
        actorId: options.actorId,
        sessionId: options.sessionId,
        action: 'canvas.snapshot.restore',
        targetType: 'canvas',
        targetId: restored.canvasId,
        metadata: { sourceRevision, restoredRevision: restored.revision },
      });
      return restored;
    });
    try {
      return transaction.immediate();
    } catch (error) {
      if (/^SQLITE_BUSY/.test(String(error?.code || ''))) {
        let current = null;
        try { current = this.getCanvas(canvasId); } catch (_) {}
        throw new RevisionConflictError(current);
      }
      throw error;
    }
  }

  deleteCanvas(canvasId) {
    const normalizedCanvasId = String(canvasId);
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM canvas_resource_grants WHERE canvas_id = ?').run(normalizedCanvasId);
      this.db.prepare('DELETE FROM canvas_resource_grant_state WHERE canvas_id = ?').run(normalizedCanvasId);
      this.db.prepare('DELETE FROM canvas_documents WHERE canvas_id = ?').run(normalizedCanvasId);
    });
    transaction.immediate();
  }

  saveCanvasSnapshot(canvasId, snapshot, options = {}) {
    const transaction = this.db.transaction(() => {
      const current = this.getCanvas(canvasId);
      const currentRevision = current?.revision || 0;
      if (options.expectedRevision != null && Number(options.expectedRevision) !== currentRevision) {
        throw new RevisionConflictError(current);
      }
      const revision = currentRevision + 1;
      const now = Date.now();
      const document = normalizeCanvasDocument(canvasId, snapshot, {
        projectId: current?.projectId || options.projectId || DEFAULT_PROJECT_ID,
        revision,
        updatedAt: now,
      });
      assertCanvasDocumentInvariants(document);
      this._commitCanvasResourceState(document, options);
      const operationId = String(options.opId || crypto.randomUUID());
      assertUnreservedCanvasOperationId(operationId);
      if (this.getCanvasOperationIdentity(operationId)) throw new OperationIdConflictError(current);
      if (current) {
        const updated = this.db.prepare(`
          UPDATE canvas_documents
          SET schema_version = ?, revision = ?, snapshot_json = ?, updated_at = ?
          WHERE canvas_id = ? AND project_id = ? AND revision = ?
        `).run(
          document.schemaVersion,
          revision,
          JSON.stringify(document),
          now,
          document.canvasId,
          document.projectId,
          currentRevision,
        );
        if (updated.changes !== 1) throw new RevisionConflictError(this.getCanvas(canvasId));
      } else {
        this.db.prepare(`
          INSERT INTO canvas_documents(
            canvas_id, project_id, schema_version, revision, snapshot_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          document.canvasId,
          document.projectId,
          document.schemaVersion,
          revision,
          JSON.stringify(document),
          now,
          now,
        );
      }
      this.insertCanvasOperationRecord({
        opId: operationId,
        projectId: document.projectId,
        canvasId: document.canvasId,
        baseRevision: currentRevision,
        actorId: String(options.actorId || 'local-owner'),
        sessionId: String(options.sessionId || 'local-session'),
        clientSeq: Number(options.clientSeq || 0),
        type: 'snapshot.replace',
        payload: { nodeCount: document.nodes.length, edgeCount: document.edges.length },
        timestamp: now,
      }, revision, true);
      this.recordCanvasResetMutation(document, operationId, now);
      this.recordCanvasSnapshot(document, 'snapshot-replace');
      this.appendAuditEvent({
        projectId: document.projectId,
        canvasId: document.canvasId,
        actorId: options.actorId,
        sessionId: options.sessionId,
        action: 'canvas.snapshot.replace',
        targetType: 'canvas',
        targetId: document.canvasId,
        metadata: { revision, nodeCount: document.nodes.length, edgeCount: document.edges.length },
      });
      return document;
    });
    try {
      return transaction.immediate();
    } catch (error) {
      if (/^SQLITE_BUSY/.test(String(error?.code || ''))) {
        let current = null;
        try { current = this.getCanvas(canvasId); } catch (_) {}
        throw new RevisionConflictError(current);
      }
      throw error;
    }
  }

  applyOperations(canvasId, rawOperations, options = {}) {
    const operations = Array.isArray(rawOperations) ? rawOperations : [];
    if (!operations.length) throw new Error('operations 不能为空');
    if (operations.length > 500) throw new Error('单批 operations 不能超过 500 条');
    const transaction = this.db.transaction(() => {
      let document = this.getCanvas(canvasId);
      if (!document) throw new Error('画布不存在');
      const normalizedOperations = operations.map((raw) => {
        const validated = validateOperation(raw);
        const operation = {
          ...validated,
          projectId: validated.projectId || document.projectId,
          canvasId: validated.canvasId || document.canvasId,
        };
        assertUnreservedCanvasOperationId(operation.opId);
        if (operation.projectId !== document.projectId) throw new Error('operation.projectId 与画布不一致');
        if (operation.canvasId !== document.canvasId) throw new Error('operation.canvasId 与画布不一致');
        return operation;
      });
      const existingOperations = normalizedOperations.map((operation) => {
        const existing = this.getCanvasOperationIdentity(operation.opId);
        if (existing && !canvasOperationIdentityMatches(existing, operation)) {
          throw new OperationIdConflictError(document);
        }
        return existing;
      });
      if (existingOperations.every(Boolean)) {
        return {
          document,
          acknowledgements: normalizedOperations.map((operation, index) => ({
            opId: operation.opId,
            revision: existingOperations[index].revision,
            duplicate: true,
          })),
        };
      }
      if (options.expectedRevision != null && Number(options.expectedRevision) !== document.revision) {
        throw new RevisionConflictError(document);
      }
      const originalRevision = document.revision;
      const acknowledgements = [];
      let appliedCount = 0;
      for (const operation of normalizedOperations) {
        const duplicate = this.getCanvasOperationIdentity(operation.opId);
        if (duplicate) {
          if (!canvasOperationIdentityMatches(duplicate, operation)) throw new OperationIdConflictError(document);
          acknowledgements.push({ opId: operation.opId, revision: duplicate.revision, duplicate: true });
          continue;
        }
        const beforeOperation = document;
        const applied = applyCanvasOperation(document, operation);
        document = normalizeCanvasDocument(canvasId, applied.document, {
          projectId: document.projectId,
          revision: document.revision + 1,
          updatedAt: Date.now(),
        });
        this.recordCanvasOperationMutation(beforeOperation, document, applied.operation);
        this.insertCanvasOperationRecord({
          ...applied.operation,
          projectId: document.projectId,
          canvasId: document.canvasId,
        }, document.revision, false);
        this.appendAuditEvent({
          projectId: document.projectId,
          canvasId,
          actorId: applied.operation.actorId,
          sessionId: applied.operation.sessionId,
          action: `canvas.${applied.operation.type}`,
          targetType: applied.operation.type.startsWith('node.') ? 'node' : applied.operation.type.startsWith('edge.') ? 'edge' : 'canvas',
          targetId: String(applied.operation.payload?.nodeId || applied.operation.payload?.node?.id || applied.operation.payload?.edgeId || applied.operation.payload?.edge?.id || canvasId),
          metadata: { opId: applied.operation.opId, revision: document.revision, baseRevision: applied.operation.baseRevision },
          createdAt: applied.operation.timestamp,
        });
        acknowledgements.push({
          opId: applied.operation.opId,
          projectId: document.projectId,
          canvasId: document.canvasId,
          baseRevision: applied.operation.baseRevision,
          revision: document.revision,
          duplicate: false,
        });
        appliedCount += 1;
      }
      if (!appliedCount) return { document, acknowledgements };
      this._commitCanvasResourceState(document, options);
      const updated = this.db.prepare(`
        UPDATE canvas_documents
        SET revision = ?, schema_version = ?, snapshot_json = ?, updated_at = ?
        WHERE canvas_id = ? AND project_id = ? AND revision = ?
      `).run(
        document.revision,
        document.schemaVersion,
        JSON.stringify(document),
        document.updatedAt,
        canvasId,
        document.projectId,
        originalRevision,
      );
      if (updated.changes !== 1) throw new RevisionConflictError(this.getCanvas(canvasId));
      if (document.revision % OPERATION_SNAPSHOT_INTERVAL === 0) this.recordCanvasSnapshot(document, 'operation-checkpoint');
      const operationCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?').get(canvasId).count);
      if (operationCount > 5000) {
        this.recordCanvasSnapshot(document, 'operation-compaction');
        this.db.prepare('DELETE FROM canvas_operations WHERE canvas_id = ? AND revision < ?')
          .run(canvasId, Math.max(1, document.revision - 2000));
      }
      return { document, acknowledgements };
    });
    try {
      return transaction.immediate();
    } catch (error) {
      if (/^SQLITE_BUSY/.test(String(error?.code || ''))) {
        let current = null;
        try { current = this.getCanvas(canvasId); } catch (_) {}
        throw new RevisionConflictError(current);
      }
      throw error;
    }
  }

  previewCanvasPatch(canvasId, rawPatch, options = {}) {
    const document = this.getCanvas(canvasId);
    if (!document) throw new CanvasPatchNotFoundError('画布不存在');
    if (options.projectId != null && String(options.projectId) !== document.projectId) {
      throw new CanvasPatchPermissionError('画布不属于当前项目');
    }
    const patch = validateCanvasPatch(rawPatch);
    assertCanvasOperationCredentialAuthority(document, patch.operations, { authority: options.authority });
    if (patch.baseRevision !== document.revision) throw new RevisionConflictError(document);
    const plan = buildCanvasPatchPlan(document, patch, {
      actorId: options.actorId,
      sessionId: options.sessionId,
      authority: options.authority,
    });
    options.assertResultingDocument?.(plan.resultingDocument);
    return plan.preview;
  }

  applyCanvasPatch(canvasId, rawPatch, options = {}) {
    const patch = validateCanvasPatch(rawPatch);
    const authorityDocument = this.getCanvas(canvasId);
    if (authorityDocument) {
      assertCanvasOperationCredentialAuthority(authorityDocument, patch.operations, {
        authority: options.authority,
      });
    }
    const requestDigest = canvasPatchRequestDigest(patch);
    if (options.confirmed !== true) throw new CanvasPatchConfirmationError();
    const suppliedPreviewDigest = String(options.previewDigest || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(suppliedPreviewDigest)) throw new CanvasPatchConfirmationError();
    const actorId = normalizeCanvasPatchPrincipal(options.actorId, 'local-owner', 'actorId');
    const sessionId = normalizeCanvasPatchPrincipal(options.sessionId, 'local-session', 'sessionId');

    const write = this.db.transaction(() => {
      let document = this.getCanvas(canvasId);
      if (!document) throw new CanvasPatchNotFoundError('画布不存在');
      if (options.projectId != null && String(options.projectId) !== document.projectId) {
        throw new CanvasPatchPermissionError('画布不属于当前项目');
      }
      assertCanvasOperationCredentialAuthority(document, patch.operations, {
        authority: options.authority,
      });
      const existing = this.db.prepare(`
        SELECT * FROM canvas_patch_applications
        WHERE project_id = ? AND canvas_id = ? AND patch_id = ?
      `).get(document.projectId, document.canvasId, patch.id);
      if (existing) {
        if (existing.request_digest !== requestDigest) {
          throw new CanvasPatchConflictError('同一 patchId 已用于不同内容', {
            code: 'canvas_patch_id_conflict',
            currentRevision: document.revision,
          });
        }
        if (existing.actor_id !== actorId) throw new CanvasPatchPermissionError();
        if (existing.preview_digest !== suppliedPreviewDigest) {
          throw new CanvasPatchConflictError('previewDigest 与已应用 Patch 不一致', {
            code: 'canvas_patch_preview_mismatch',
            currentRevision: document.revision,
          });
        }
        if (existing.status !== 'applied') {
          throw new CanvasPatchConflictError('CanvasPatch 已撤销，不能再次应用', {
            code: 'canvas_patch_already_reverted',
            currentRevision: document.revision,
          });
        }
        const snapshotRow = this.db.prepare(`
          SELECT snapshot_json, created_at FROM canvas_snapshots
          WHERE canvas_id = ? AND revision = ?
        `).get(document.canvasId, existing.applied_revision);
        const storedSnapshot = snapshotRow ? parseJson(snapshotRow.snapshot_json, {}) : null;
        const appliedDocument = snapshotRow
          ? normalizeCanvasDocument(document.canvasId, storedSnapshot, {
            projectId: document.projectId,
            revision: existing.applied_revision,
            updatedAt: storedSnapshot?.updatedAt || snapshotRow.created_at,
          })
          : document;
        return {
          patchId: existing.patch_id,
          status: 'applied',
          duplicate: true,
          baseRevision: Number(existing.base_revision),
          revision: Number(existing.applied_revision),
          document: appliedDocument,
          acknowledgements: parseJson(existing.acknowledgements_json, [])
            .map((acknowledgement) => ({ ...acknowledgement, duplicate: true })),
        };
      }
      if (patch.baseRevision !== document.revision) throw new RevisionConflictError(document);

      const plan = buildCanvasPatchPlan(document, patch, {
        actorId,
        sessionId,
        authority: options.authority,
      });
      if (plan.previewDigest !== suppliedPreviewDigest) {
        throw new CanvasPatchConflictError('预览已失效，请重新预览后确认', {
          code: 'canvas_patch_preview_stale',
          currentRevision: document.revision,
        });
      }
      const baseRevision = document.revision;
      const now = Date.now();
      const acknowledgements = [];
      plan.operations.forEach((semanticOperation, index) => {
        const beforeOperation = document;
        const operation = {
          opId: scopedCanvasPatchOperationId(document.projectId, document.canvasId, patch.id, 'apply', index),
          projectId: document.projectId,
          canvasId: document.canvasId,
          actorId,
          sessionId,
          baseRevision: document.revision,
          clientSeq: index,
          type: semanticOperation.type,
          payload: semanticOperation.payload,
          timestamp: now + index,
        };
        let applied;
        try {
          applied = applyCanvasOperation(document, operation);
        } catch (_) {
          throw new CanvasPatchConflictError('CanvasPatch 无法按预览结果应用', {
            code: 'canvas_patch_apply_failed',
            currentRevision: document.revision,
          });
        }
        document = normalizeCanvasDocument(document.canvasId, applied.document, {
          projectId: document.projectId,
          revision: document.revision + 1,
          updatedAt: now,
        });
        this.recordCanvasOperationMutation(beforeOperation, document, operation);
        this.insertCanvasOperationRecord(operation, document.revision, false);
        acknowledgements.push({ opId: operation.opId, revision: document.revision, duplicate: false });
      });

      const provenanceGuards = this.buildCanvasPatchProvenanceGuards(document, plan.postconditions);
      const provenanceGuardsJson = JSON.stringify(provenanceGuards);
      if (Buffer.byteLength(provenanceGuardsJson, 'utf8') > 512 * 1024) {
        throw new CanvasPatchValidationError('CanvasPatch provenance guard 超过安全大小限制');
      }
      const provenanceGuardsDigest = canvasPatchProvenanceDigest({
        projectId: document.projectId,
        canvasId: document.canvasId,
        patchId: patch.id,
        appliedRevision: document.revision,
      }, provenanceGuards);

      this._commitCanvasResourceState(document, options);
      const updated = this.db.prepare(`
        UPDATE canvas_documents
        SET revision = ?, schema_version = ?, snapshot_json = ?, updated_at = ?
        WHERE canvas_id = ? AND project_id = ? AND revision = ?
      `).run(
        document.revision,
        document.schemaVersion,
        JSON.stringify(document),
        document.updatedAt,
        document.canvasId,
        document.projectId,
        baseRevision,
      );
      if (updated.changes !== 1) throw new RevisionConflictError(this.getCanvas(canvasId));

      this.recordCanvasSnapshot(document, `patch:${patch.id}`);
      this.db.prepare(`
        INSERT INTO canvas_patch_applications(
          project_id, canvas_id, patch_id, schema, request_digest, preview_digest,
          base_revision, applied_revision, actor_id, session_id, summary,
          diagnostics_json, operation_count, affected_node_ids_json, affected_edge_ids_json,
          changes_json, forward_ops_json, inverse_ops_json, postconditions_json,
          guard_version, provenance_guards_json, provenance_guards_digest,
          acknowledgements_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?)
      `).run(
        document.projectId,
        document.canvasId,
        patch.id,
        CANVAS_PATCH_CONTRACT,
        requestDigest,
        plan.previewDigest,
        baseRevision,
        document.revision,
        actorId,
        sessionId,
        patch.summary,
        JSON.stringify(patch.diagnosticsResolved),
        plan.operations.length,
        JSON.stringify(plan.preview.affectedNodeIds),
        JSON.stringify(plan.preview.affectedEdgeIds),
        JSON.stringify(plan.preview.changes),
        JSON.stringify(plan.operations),
        JSON.stringify(plan.inverseOperations),
        JSON.stringify(plan.postconditions),
        CANVAS_PROVENANCE_GUARD_VERSION,
        provenanceGuardsJson,
        provenanceGuardsDigest,
        JSON.stringify(acknowledgements),
        now,
        now,
      );
      this.appendAuditEvent({
        projectId: document.projectId,
        canvasId: document.canvasId,
        actorId,
        sessionId,
        action: 'canvas.patch.apply',
        targetType: 'canvas-patch',
        targetId: patch.id,
        metadata: {
          patchId: patch.id,
          summary: patch.summary,
          baseRevision,
          appliedRevision: document.revision,
          operationCount: plan.operations.length,
          diagnosticCount: patch.diagnosticsResolved.length,
        },
        createdAt: now,
      });
      this.options.beforeCanvasPatchCommit?.(this.db, {
        phase: 'apply',
        projectId: document.projectId,
        canvasId: document.canvasId,
        patchId: patch.id,
      });
      return {
        patchId: patch.id,
        status: 'applied',
        duplicate: false,
        baseRevision,
        revision: document.revision,
        document,
        acknowledgements,
      };
    });
    try {
      return write.immediate();
    } catch (error) {
      if (/^SQLITE_BUSY/.test(String(error?.code || ''))) {
        let currentRevision = null;
        try { currentRevision = this.getCanvas(canvasId)?.revision ?? null; } catch (_) {}
        throw new CanvasPatchConflictError('画布当前繁忙，请同步后重试', {
          code: 'canvas_patch_busy',
          currentRevision,
        });
      }
      throw error;
    }
  }

  listCanvasPatches(canvasId, options = {}) {
    const document = this.getCanvas(canvasId);
    if (!document) return [];
    if (options.projectId != null && String(options.projectId) !== document.projectId) {
      throw new CanvasPatchPermissionError('画布不属于当前项目');
    }
    const actorId = normalizeCanvasPatchPrincipal(options.actorId, 'local-owner', 'actorId');
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(options.limit) || 50)));
    return this.db.prepare(`
      SELECT patch_id, summary, diagnostics_json, base_revision, applied_revision,
             reverted_revision, actor_id, status, operation_count, guard_version, created_at, reverted_at
      FROM canvas_patch_applications
      WHERE project_id = ? AND canvas_id = ? AND actor_id = ?
      ORDER BY created_at DESC, patch_id DESC LIMIT ?
    `).all(document.projectId, document.canvasId, actorId, limit).map((row) => {
      const diagnostics = parseJson(row.diagnostics_json, []);
      const summary = safePatchValue(row.summary, 'summary');
      return {
        patchId: safeIdentifier(row.patch_id),
        summary: typeof summary === 'string' ? summary : '[redacted]',
        diagnosticsResolved: (Array.isArray(diagnostics) ? diagnostics : [])
          .slice(0, 100)
          .map((value) => safeIdentifier(value)),
        baseRevision: Number(row.base_revision),
        appliedRevision: Number(row.applied_revision),
        revertedRevision: row.reverted_revision == null ? null : Number(row.reverted_revision),
        actorId: safeIdentifier(row.actor_id),
        status: row.status === 'reverted' ? 'reverted' : 'applied',
        operationCount: Number(row.operation_count),
        createdAt: Number(row.created_at),
        revertedAt: row.reverted_at == null ? null : Number(row.reverted_at),
        canRevert: row.status === 'applied' && row.actor_id === actorId
          && Number(row.guard_version) === CANVAS_PROVENANCE_GUARD_VERSION,
      };
    });
  }

  revertCanvasPatch(canvasId, rawPatchId, options = {}) {
    const patchId = normalizeCanvasPatchId(rawPatchId);
    const actorId = normalizeCanvasPatchPrincipal(options.actorId, 'local-owner', 'actorId');
    const sessionId = normalizeCanvasPatchPrincipal(options.sessionId, 'local-session', 'sessionId');
    if (options.expectedRevision != null
      && (!Number.isInteger(Number(options.expectedRevision)) || Number(options.expectedRevision) < 1)) {
      throw new CanvasPatchValidationError('expectedRevision 必须是正整数');
    }
    const write = this.db.transaction(() => {
      let document = this.getCanvas(canvasId);
      if (!document) throw new CanvasPatchNotFoundError('画布不存在');
      if (options.projectId != null && String(options.projectId) !== document.projectId) {
        throw new CanvasPatchPermissionError('画布不属于当前项目');
      }
      const row = this.db.prepare(`
        SELECT * FROM canvas_patch_applications
        WHERE project_id = ? AND canvas_id = ? AND patch_id = ?
      `).get(document.projectId, document.canvasId, patchId);
      if (!row) throw new CanvasPatchNotFoundError();
      if (row.actor_id !== actorId) throw new CanvasPatchPermissionError();
      if (row.status === 'reverted') {
        return {
          patchId,
          status: 'reverted',
          duplicate: true,
          revision: document.revision,
          document,
        };
      }
      if (Number(row.guard_version) !== CANVAS_PROVENANCE_GUARD_VERSION) {
        throw new CanvasPatchConflictError('CanvasPatch 缺少可验证的撤销 provenance guard', {
          code: 'canvas_patch_revert_guard_unavailable',
          currentRevision: document.revision,
        });
      }
      if (options.expectedRevision != null && Number(options.expectedRevision) !== document.revision) {
        throw new RevisionConflictError(document);
      }
      const postconditions = parseJson(row.postconditions_json, null);
      const inverseOperations = parseJson(row.inverse_ops_json, null);
      const forwardOperations = parseJson(row.forward_ops_json, null);
      const provenanceGuards = parseJson(row.provenance_guards_json, null);
      if (!Array.isArray(postconditions) || !Array.isArray(inverseOperations)
        || !Array.isArray(forwardOperations) || !inverseOperations.length
        || inverseOperations.length > 1000 || forwardOperations.length !== Number(row.operation_count)) {
        throw new CanvasPatchRevertConflictError([{ targetType: 'canvas', targetId: safeIdentifier(document.canvasId) }], document.revision);
      }
      const guardDigest = crypto.createHash('sha256').update(stableJson({
        operations: forwardOperations,
        inverseOperations,
        postconditions,
      })).digest('hex');
      const expectedPreviewDigest = crypto.createHash('sha256').update(stableJson({
        schema: row.schema,
        requestDigest: row.request_digest,
        projectId: row.project_id,
        canvasId: row.canvas_id,
        currentRevision: Number(row.base_revision),
        guardDigest,
      })).digest('hex');
      if (row.schema !== CANVAS_PATCH_CONTRACT || expectedPreviewDigest !== row.preview_digest) {
        throw new CanvasPatchRevertConflictError([{ targetType: 'canvas', targetId: safeIdentifier(document.canvasId) }], document.revision);
      }
      const expectedProvenanceDigest = canvasPatchProvenanceDigest({
        projectId: row.project_id,
        canvasId: row.canvas_id,
        patchId: row.patch_id,
        appliedRevision: row.applied_revision,
      }, provenanceGuards);
      if (!/^[a-f0-9]{64}$/.test(String(row.provenance_guards_digest || ''))
        || expectedProvenanceDigest !== row.provenance_guards_digest) {
        throw new CanvasPatchRevertConflictError([{
          targetType: 'canvas', targetId: safeIdentifier(document.canvasId),
        }], document.revision);
      }
      this.assertCanvasPatchProvenanceGuards(document, provenanceGuards);
      assertCanvasPatchPostconditions(document, postconditions);
      assertCanvasOperationCredentialAuthority(document, inverseOperations, {
        authority: options.authority,
      });
      const baseRevision = document.revision;
      const now = Date.now();
      inverseOperations.forEach((semanticOperation, index) => {
        const beforeOperation = document;
        if (!semanticOperation || typeof semanticOperation !== 'object'
          || typeof semanticOperation.type !== 'string'
          || !semanticOperation.payload || typeof semanticOperation.payload !== 'object') {
          throw new CanvasPatchRevertConflictError([{ targetType: 'canvas', targetId: safeIdentifier(document.canvasId) }], document.revision);
        }
        const operation = {
          opId: scopedCanvasPatchOperationId(document.projectId, document.canvasId, patchId, 'revert', index),
          projectId: document.projectId,
          canvasId: document.canvasId,
          actorId,
          sessionId,
          baseRevision: document.revision,
          clientSeq: index,
          type: semanticOperation.type,
          payload: semanticOperation.payload,
          timestamp: now + index,
        };
        let applied;
        try {
          applied = applyCanvasOperation(document, operation);
        } catch (_) {
          throw new CanvasPatchRevertConflictError([{
            targetType: 'canvas',
            targetId: safeIdentifier(document.canvasId),
          }], document.revision);
        }
        document = normalizeCanvasDocument(document.canvasId, applied.document, {
          projectId: document.projectId,
          revision: document.revision + 1,
          updatedAt: now,
        });
        this.recordCanvasOperationMutation(beforeOperation, document, operation);
        this.insertCanvasOperationRecord(operation, document.revision, false);
      });
      this._commitCanvasResourceState(document, options);
      const updated = this.db.prepare(`
        UPDATE canvas_documents
        SET revision = ?, schema_version = ?, snapshot_json = ?, updated_at = ?
        WHERE canvas_id = ? AND project_id = ? AND revision = ?
      `).run(
        document.revision,
        document.schemaVersion,
        JSON.stringify(document),
        document.updatedAt,
        document.canvasId,
        document.projectId,
        baseRevision,
      );
      if (updated.changes !== 1) throw new RevisionConflictError(this.getCanvas(canvasId));
      const patchUpdated = this.db.prepare(`
        UPDATE canvas_patch_applications
        SET status = 'reverted', reverted_revision = ?, reverted_at = ?, updated_at = ?
        WHERE project_id = ? AND canvas_id = ? AND patch_id = ? AND status = 'applied'
      `).run(document.revision, now, now, document.projectId, document.canvasId, patchId);
      if (patchUpdated.changes !== 1) {
        throw new CanvasPatchConflictError('CanvasPatch 撤销状态已变化', {
          code: 'canvas_patch_revert_race',
          currentRevision: document.revision,
        });
      }
      this.recordCanvasSnapshot(document, `patch-revert:${patchId}`);
      this.appendAuditEvent({
        projectId: document.projectId,
        canvasId: document.canvasId,
        actorId,
        sessionId,
        action: 'canvas.patch.revert',
        targetType: 'canvas-patch',
        targetId: patchId,
        metadata: {
          patchId,
          appliedRevision: Number(row.applied_revision),
          revertedRevision: document.revision,
          inverseOperationCount: inverseOperations.length,
        },
        createdAt: now,
      });
      this.options.beforeCanvasPatchCommit?.(this.db, {
        phase: 'revert',
        projectId: document.projectId,
        canvasId: document.canvasId,
        patchId,
      });
      return {
        patchId,
        status: 'reverted',
        duplicate: false,
        revision: document.revision,
        document,
      };
    });
    try {
      return write.immediate();
    } catch (error) {
      if (/^SQLITE_BUSY/.test(String(error?.code || ''))) {
        let currentRevision = null;
        try { currentRevision = this.getCanvas(canvasId)?.revision ?? null; } catch (_) {}
        throw new CanvasPatchConflictError('画布当前繁忙，请同步后重试', {
          code: 'canvas_patch_busy',
          currentRevision,
        });
      }
      throw error;
    }
  }

  syncCanvas(canvasId, afterRevision = 0, limit = 500) {
    const document = this.getCanvas(canvasId);
    if (!document) return null;
    const revision = Math.max(0, Number(afterRevision) || 0);
    const revisionGap = Number(document.revision) - revision;
    if (revision <= 0 || revisionGap < 0 || revisionGap > limit) {
      return { mode: 'snapshot', document };
    }
    const rows = this.db.prepare(`
      SELECT * FROM canvas_operations
      WHERE canvas_id = ? AND revision > ?
      ORDER BY revision ASC LIMIT ?
    `).all(canvasId, revision, limit + 1);
    const completeRevisionCoverage = rows.length === revisionGap
      && rows.every((row, index) => Number(row.revision) === revision + index + 1);
    if (
      rows.length > limit
      || rows.some((row) => row.requires_snapshot)
      || !completeRevisionCoverage
    ) return { mode: 'snapshot', document };
    return {
      mode: 'operations',
      canvasId,
      revision: document.revision,
      operations: rows.map((row) => ({
        opId: row.op_id,
        projectId: row.project_id,
        canvasId: row.canvas_id,
        baseRevision: row.base_revision,
        revision: row.revision,
        actorId: row.actor_id,
        sessionId: row.session_id,
        clientSeq: row.client_seq,
        type: row.type,
        payload: parseJson(row.payload_json, {}),
        timestamp: row.created_at,
      })),
    };
  }

  listCanvases(projectId = DEFAULT_PROJECT_ID) {
    return this.db.prepare(`
      SELECT canvas_id, project_id, revision, snapshot_json, created_at, updated_at
      FROM canvas_documents WHERE project_id = ? ORDER BY updated_at DESC
    `).all(projectId).map((row) => {
      const snapshot = parseJson(row.snapshot_json, {});
      return {
        id: row.canvas_id,
        projectId: row.project_id,
        revision: row.revision,
        name: String(snapshot.name || snapshot.title || row.canvas_id),
        nodeCount: Array.isArray(snapshot.nodes) ? snapshot.nodes.length : 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  listCanvasAssetIds(projectId, canvasId, limit = 2000) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const normalizedCanvasId = String(canvasId || '');
    const safeLimit = Math.min(10_000, Math.max(1, Math.trunc(Number(limit) || 2000)));
    const ids = new Set(this.db.prepare(`
      SELECT DISTINCT asset_id
      FROM asset_lineage_events
      WHERE project_id = ? AND canvas_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(normalizedProjectId, normalizedCanvasId, safeLimit).map((row) => String(row.asset_id)));
    const outputRows = this.db.prepare(`
      SELECT nr.output_refs_json
      FROM node_runs nr
      JOIN runs r ON r.id = nr.run_id
      WHERE r.project_id = ? AND r.canvas_id = ?
      ORDER BY nr.updated_at DESC
      LIMIT ?
    `).all(normalizedProjectId, normalizedCanvasId, safeLimit);
    for (const row of outputRows) {
      for (const assetId of parseJson(row.output_refs_json, [])) {
        if (ids.size >= safeLimit) break;
        if (assetId != null && String(assetId).trim()) ids.add(String(assetId).trim());
      }
      if (ids.size >= safeLimit) break;
    }
    return [...ids];
  }

  createInvite(record) {
    const canvas = this.getCanvas(record?.canvasId);
    if (!canvas || String(canvas.projectId) !== String(record?.projectId || '')) {
      throw new Error('邀请必须绑定当前项目中的有效画布');
    }
    this.db.prepare(`
      INSERT INTO collaboration_invites(
        id, project_id, canvas_id, code_hash, role, capabilities_json, expires_at, max_uses, use_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      record.id,
      record.projectId,
      record.canvasId,
      record.codeHash,
      record.role,
      JSON.stringify(record.capabilities || []),
      record.expiresAt,
      record.maxUses,
      record.createdAt,
    );
    this.appendAuditEvent({
      projectId: record.projectId,
      canvasId: record.canvasId,
      actorId: record.createdBy,
      sessionId: record.sessionId,
      action: 'collaboration.invite.create',
      targetType: 'invite',
      targetId: record.id,
      metadata: {
        canvasId: record.canvasId,
        role: record.role,
        capabilities: record.capabilities || [],
        expiresAt: record.expiresAt,
        maxUses: record.maxUses,
      },
      createdAt: record.createdAt,
    });
  }

  listInvites(projectId = DEFAULT_PROJECT_ID, options = {}) {
    const canvasId = options.canvasId == null ? null : String(options.canvasId);
    const rows = canvasId == null
      ? this.db.prepare(`
      SELECT id, project_id, canvas_id, role, capabilities_json, expires_at, max_uses, use_count, revoked_at, created_at
      FROM collaboration_invites WHERE project_id = ? ORDER BY created_at DESC
    `).all(String(projectId))
      : this.db.prepare(`
      SELECT id, project_id, canvas_id, role, capabilities_json, expires_at, max_uses, use_count, revoked_at, created_at
      FROM collaboration_invites WHERE project_id = ? AND canvas_id = ? ORDER BY created_at DESC
    `).all(String(projectId), canvasId);
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      canvasId: row.canvas_id,
      role: row.role,
      capabilities: parseJson(row.capabilities_json, []),
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      useCount: row.use_count,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    }));
  }

  revokeInvite(inviteId, options = {}) {
    const invite = this.db.prepare(`
      SELECT id, project_id, canvas_id, role, capabilities_json, expires_at, max_uses, use_count, revoked_at, created_at
      FROM collaboration_invites
      WHERE id = ?
    `).get(String(inviteId));
    if (!invite) return null;
    if (options.expectedProjectId != null && String(options.expectedProjectId) !== String(invite.project_id)) return null;
    if (options.expectedCanvasId != null && String(options.expectedCanvasId) !== String(invite.canvas_id)) return null;
    const revokedAt = invite.revoked_at || Date.now();
    this.db.prepare('UPDATE collaboration_invites SET revoked_at = ? WHERE id = ?').run(revokedAt, invite.id);
    this.appendAuditEvent({
      projectId: invite.project_id,
      canvasId: invite.canvas_id,
      actorId: options.actorId,
      sessionId: options.sessionId,
      action: 'collaboration.invite.revoke',
      targetType: 'invite',
      targetId: invite.id,
      metadata: { revokedAt },
    });
    return {
      id: invite.id,
      projectId: invite.project_id,
      canvasId: invite.canvas_id,
      role: invite.role,
      capabilities: parseJson(invite.capabilities_json, []),
      expiresAt: invite.expires_at,
      maxUses: invite.max_uses,
      useCount: invite.use_count,
      revokedAt,
      createdAt: invite.created_at,
    };
  }

  redeemInvite(codeHash, record) {
    const transaction = this.db.transaction(() => {
      const invite = this.db.prepare('SELECT * FROM collaboration_invites WHERE code_hash = ?').get(codeHash);
      const now = Date.now();
      if (!invite || invite.revoked_at || invite.expires_at <= now || invite.use_count >= invite.max_uses) return null;
      if (record.expectedCanvasId != null
        && String(record.expectedCanvasId) !== String(invite.canvas_id || '')) return null;
      const canvas = this.db.prepare(`
        SELECT d.revision, state.trusted_revision, state.initialized_at
        FROM canvas_documents d
        LEFT JOIN canvas_resource_grant_state state
          ON state.project_id = d.project_id AND state.canvas_id = d.canvas_id
        WHERE d.canvas_id = ? AND d.project_id = ?
      `).get(invite.canvas_id, invite.project_id);
      if (!canvas
        || Number(canvas.initialized_at) <= 0
        || Number(canvas.trusted_revision) !== Number(canvas.revision)) {
        this.db.prepare('UPDATE collaboration_invites SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
          .run(now, invite.id);
        return null;
      }
      const document = this.getCanvas(invite.canvas_id);
      const resolvedResources = document
        ? this.resolveCanvasDocumentResources(document)
        : null;
      if (!resolvedResources
        || resolvedResources.truncated
        || resolvedResources.subflowPinMismatches.length > 0
        || resolvedResources.subflowContentMismatches.length > 0
        || resolvedResources.missingSubflows.length > 0) {
        this.db.prepare('UPDATE collaboration_invites SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
          .run(now, invite.id);
        return null;
      }
      this.db.prepare('UPDATE collaboration_invites SET use_count = use_count + 1 WHERE id = ?').run(invite.id);
      this.db.prepare(`
        INSERT INTO collaboration_members(id, project_id, canvas_id, display_name, role, capabilities_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.memberId,
        invite.project_id,
        invite.canvas_id,
        record.displayName,
        invite.role,
        invite.capabilities_json,
        now,
        now,
      );
      this.db.prepare(`
        INSERT INTO collaboration_sessions(id, project_id, canvas_id, member_id, token_hash, expires_at, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.sessionId, invite.project_id, invite.canvas_id, record.memberId, record.tokenHash, record.sessionExpiresAt, now, now);
      return {
        inviteId: invite.id,
        projectId: invite.project_id,
        canvasId: invite.canvas_id,
        memberId: record.memberId,
        sessionId: record.sessionId,
        displayName: record.displayName,
        role: invite.role,
        capabilities: parseJson(invite.capabilities_json, []),
        expiresAt: record.sessionExpiresAt,
      };
    });
    return transaction();
  }

  getSession(tokenHash) {
    const now = Date.now();
    const row = this.db.prepare(`
      SELECT s.id AS session_id, s.project_id, s.canvas_id, s.member_id, s.expires_at,
             m.display_name, m.role, m.capabilities_json
      FROM collaboration_sessions s
      JOIN collaboration_members m ON m.id = s.member_id
      JOIN canvas_documents d ON d.canvas_id = s.canvas_id AND d.project_id = s.project_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        AND s.canvas_id IS NOT NULL AND TRIM(s.canvas_id) <> ''
        AND m.project_id = s.project_id AND m.canvas_id = s.canvas_id
    `).get(tokenHash, now);
    if (!row) return null;
    this.db.prepare('UPDATE collaboration_sessions SET last_seen_at = ? WHERE id = ?').run(now, row.session_id);
    return {
      id: row.session_id,
      projectId: row.project_id,
      canvasId: row.canvas_id,
      memberId: row.member_id,
      displayName: row.display_name,
      role: row.role,
      capabilities: parseJson(row.capabilities_json, []),
      expiresAt: row.expires_at,
    };
  }

  listCollaborationSessions(projectId = DEFAULT_PROJECT_ID, options = {}) {
    const now = Date.now();
    const canvasId = options.canvasId == null ? null : String(options.canvasId);
    const statement = canvasId == null ? this.db.prepare(`
      SELECT s.id, s.project_id, s.canvas_id, s.member_id, s.expires_at, s.revoked_at, s.created_at, s.last_seen_at,
             m.display_name, m.role,
             CASE WHEN d.canvas_id IS NOT NULL
                    AND m.project_id = s.project_id
                    AND m.canvas_id = s.canvas_id
                  THEN 1 ELSE 0 END AS scope_valid
      FROM collaboration_sessions s
      JOIN collaboration_members m ON m.id = s.member_id
      LEFT JOIN canvas_documents d ON d.canvas_id = s.canvas_id AND d.project_id = s.project_id
      WHERE s.project_id = ?
      ORDER BY s.created_at DESC, s.id ASC
    `) : this.db.prepare(`
      SELECT s.id, s.project_id, s.canvas_id, s.member_id, s.expires_at, s.revoked_at, s.created_at, s.last_seen_at,
             m.display_name, m.role,
             CASE WHEN d.canvas_id IS NOT NULL
                    AND m.project_id = s.project_id
                    AND m.canvas_id = s.canvas_id
                  THEN 1 ELSE 0 END AS scope_valid
      FROM collaboration_sessions s
      JOIN collaboration_members m ON m.id = s.member_id
      LEFT JOIN canvas_documents d ON d.canvas_id = s.canvas_id AND d.project_id = s.project_id
      WHERE s.project_id = ? AND s.canvas_id = ?
      ORDER BY s.created_at DESC, s.id ASC
    `);
    const rows = canvasId == null
      ? statement.all(String(projectId))
      : statement.all(String(projectId), canvasId);
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      canvasId: row.canvas_id,
      memberId: row.member_id,
      displayName: row.display_name,
      role: row.role,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      active: row.revoked_at == null && row.expires_at > now && Number(row.scope_valid) === 1,
    }));
  }

  revokeSession(sessionId, options = {}) {
    const session = this.db.prepare(`
      SELECT s.id, s.project_id, s.canvas_id, s.member_id, s.expires_at, s.revoked_at, s.created_at, s.last_seen_at,
             m.display_name, m.role
      FROM collaboration_sessions s
      JOIN collaboration_members m ON m.id = s.member_id
      WHERE s.id = ?
    `).get(String(sessionId));
    if (!session) return null;
    if (options.expectedProjectId != null && String(options.expectedProjectId) !== String(session.project_id)) return null;
    if (options.expectedCanvasId != null && String(options.expectedCanvasId) !== String(session.canvas_id)) return null;
    const revokedAt = session.revoked_at || Date.now();
    this.db.prepare('UPDATE collaboration_sessions SET revoked_at = ? WHERE id = ?').run(revokedAt, session.id);
    this.appendAuditEvent({
      projectId: session.project_id,
      canvasId: session.canvas_id,
      actorId: options.actorId,
      sessionId: options.sessionId,
      action: 'collaboration.session.revoke',
      targetType: 'session',
      targetId: session.id,
      metadata: { memberId: session.member_id, revokedAt },
    });
    return {
      id: session.id,
      projectId: session.project_id,
      canvasId: session.canvas_id,
      memberId: session.member_id,
      displayName: session.display_name,
      role: session.role,
      expiresAt: session.expires_at,
      revokedAt,
      createdAt: session.created_at,
      lastSeenAt: session.last_seen_at,
      active: false,
    };
  }

  rotateSession(sessionId, record, options = {}) {
    const transaction = this.db.transaction(() => {
      const current = this.db.prepare(`
        SELECT s.*, m.display_name, m.role, m.capabilities_json
        FROM collaboration_sessions s
        JOIN collaboration_members m ON m.id = s.member_id
        JOIN canvas_documents d ON d.canvas_id = s.canvas_id AND d.project_id = s.project_id
        WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
          AND s.canvas_id IS NOT NULL AND TRIM(s.canvas_id) <> ''
          AND m.project_id = s.project_id AND m.canvas_id = s.canvas_id
      `).get(String(sessionId), Date.now());
      if (!current) return null;
      const now = Date.now();
      this.db.prepare('UPDATE collaboration_sessions SET revoked_at = ? WHERE id = ?').run(now, current.id);
      this.db.prepare(`
        INSERT INTO collaboration_sessions(id, project_id, canvas_id, member_id, token_hash, expires_at, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.sessionId, current.project_id, current.canvas_id, current.member_id, record.tokenHash, record.expiresAt, now, now);
      this.appendAuditEvent({
        projectId: current.project_id,
        canvasId: current.canvas_id,
        actorId: current.member_id,
        sessionId: record.sessionId,
        action: 'collaboration.session.rotate',
        targetType: 'session',
        targetId: record.sessionId,
        metadata: { previousSessionId: current.id },
      });
      return {
        id: record.sessionId,
        projectId: current.project_id,
        canvasId: current.canvas_id,
        memberId: current.member_id,
        displayName: current.display_name,
        role: current.role,
        capabilities: parseJson(current.capabilities_json, []),
        expiresAt: record.expiresAt,
      };
    });
    return transaction();
  }

  revokeMemberSessions(memberId, options = {}) {
    const member = this.db.prepare('SELECT id, project_id, canvas_id FROM collaboration_members WHERE id = ?').get(String(memberId));
    if (!member) return 0;
    if (options.expectedProjectId != null && String(options.expectedProjectId) !== String(member.project_id)) return 0;
    if (options.expectedCanvasId != null && String(options.expectedCanvasId) !== String(member.canvas_id)) return 0;
    const result = this.db.prepare('UPDATE collaboration_sessions SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL')
      .run(Date.now(), member.id);
    this.appendAuditEvent({
      projectId: member.project_id,
      canvasId: member.canvas_id,
      actorId: options.actorId,
      sessionId: options.sessionId,
      action: 'collaboration.sessions.revoke-member',
      targetType: 'member',
      targetId: member.id,
      metadata: { revokedSessions: result.changes },
    });
    return result.changes;
  }

  revokeProjectSessions(projectId = DEFAULT_PROJECT_ID, options = {}) {
    const result = this.db.prepare('UPDATE collaboration_sessions SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL')
      .run(Date.now(), String(projectId));
    this.appendAuditEvent({
      projectId,
      actorId: options.actorId,
      sessionId: options.sessionId,
      action: 'collaboration.sessions.revoke-project',
      targetType: 'project',
      targetId: projectId,
      metadata: { revokedSessions: result.changes },
    });
    return result.changes;
  }

  revokeCanvasSessions(projectId, canvasId, options = {}) {
    const result = this.db.prepare(`
      UPDATE collaboration_sessions
      SET revoked_at = ?
      WHERE project_id = ? AND canvas_id = ? AND revoked_at IS NULL
    `).run(Date.now(), String(projectId), String(canvasId));
    this.appendAuditEvent({
      projectId,
      canvasId,
      actorId: options.actorId,
      sessionId: options.sessionId,
      action: 'collaboration.sessions.revoke-canvas',
      targetType: 'canvas',
      targetId: canvasId,
      metadata: { revokedSessions: result.changes },
    });
    return result.changes;
  }

  listMembers(projectId = DEFAULT_PROJECT_ID, options = {}) {
    const canvasId = options.canvasId == null ? null : String(options.canvasId);
    const rows = canvasId == null ? this.db.prepare(`
      SELECT id, project_id, canvas_id, display_name, role, capabilities_json, created_at, updated_at
      FROM collaboration_members WHERE project_id = ? ORDER BY created_at ASC
    `).all(projectId) : this.db.prepare(`
      SELECT id, project_id, canvas_id, display_name, role, capabilities_json, created_at, updated_at
      FROM collaboration_members WHERE project_id = ? AND canvas_id = ? ORDER BY created_at ASC
    `).all(projectId, canvasId);
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      canvasId: row.canvas_id,
      displayName: row.display_name,
      role: row.role,
      capabilities: parseJson(row.capabilities_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getCollaborationMember(memberId) {
    const row = this.db.prepare(`
      SELECT id, project_id, canvas_id, display_name, role, capabilities_json, created_at, updated_at
      FROM collaboration_members WHERE id = ?
    `).get(String(memberId));
    return row ? {
      id: row.id,
      projectId: row.project_id,
      canvasId: row.canvas_id,
      displayName: row.display_name,
      role: row.role,
      capabilities: parseJson(row.capabilities_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  }

  updateMember(memberId, patch = {}, options = {}) {
    const member = this.db.prepare('SELECT * FROM collaboration_members WHERE id = ?').get(String(memberId));
    if (!member) return null;
    if (options.expectedProjectId != null && String(options.expectedProjectId) !== String(member.project_id)) return null;
    if (options.expectedCanvasId != null && String(options.expectedCanvasId) !== String(member.canvas_id)) return null;
    const role = String(patch.role || member.role);
    const capabilities = Array.isArray(patch.capabilities) ? patch.capabilities.map(String) : parseJson(member.capabilities_json, []);
    const displayName = patch.displayName == null ? member.display_name : String(patch.displayName).trim().slice(0, 48);
    const updatedAt = Date.now();
    this.db.prepare('UPDATE collaboration_members SET display_name = ?, role = ?, capabilities_json = ?, updated_at = ? WHERE id = ?')
      .run(displayName || member.display_name, role, JSON.stringify(capabilities), updatedAt, member.id);
    this.appendAuditEvent({
      projectId: member.project_id,
      canvasId: member.canvas_id,
      actorId: options.actorId,
      sessionId: options.sessionId,
      action: 'collaboration.member.update',
      targetType: 'member',
      targetId: member.id,
      metadata: { previousRole: member.role, role, capabilities },
    });
    return this.listMembers(member.project_id, { canvasId: member.canvas_id })
      .find((entry) => entry.id === member.id) || null;
  }

  removeMember(memberId, options = {}) {
    const member = this.db.prepare(`
      SELECT id, project_id, canvas_id, display_name, role, capabilities_json, created_at, updated_at
      FROM collaboration_members
      WHERE id = ?
    `).get(String(memberId));
    if (!member) return null;
    if (options.expectedProjectId != null && String(options.expectedProjectId) !== String(member.project_id)) return null;
    if (options.expectedCanvasId != null && String(options.expectedCanvasId) !== String(member.canvas_id)) return null;
    const transaction = this.db.transaction(() => {
      this.revokeMemberSessions(member.id, options);
      this.db.prepare('DELETE FROM collaboration_members WHERE id = ?').run(member.id);
      this.appendAuditEvent({
        projectId: member.project_id,
        canvasId: member.canvas_id,
        actorId: options.actorId,
        sessionId: options.sessionId,
        action: 'collaboration.member.remove',
        targetType: 'member',
        targetId: member.id,
        metadata: { displayName: member.display_name, role: member.role },
      });
    });
    transaction();
    return {
      id: member.id,
      projectId: member.project_id,
      canvasId: member.canvas_id,
      displayName: member.display_name,
      role: member.role,
      capabilities: parseJson(member.capabilities_json, []),
      createdAt: member.created_at,
      updatedAt: member.updated_at,
    };
  }

  createReviewThread(input) {
    const now = Date.now();
    const thread = {
      id: String(input.id || crypto.randomUUID()),
      projectId: String(input.projectId || DEFAULT_PROJECT_ID),
      canvasId: String(input.canvasId),
      canvasRevision: Math.max(1, Number(input.canvasRevision) || 1),
      anchor: input.anchor && typeof input.anchor === 'object' ? input.anchor : { kind: 'canvas', x: 0, y: 0 },
      status: String(input.status || 'open'),
      severity: String(input.severity || 'normal'),
      createdBy: String(input.createdBy),
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO review_threads(id, project_id, canvas_id, canvas_revision, anchor_json, status, severity, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(thread.id, thread.projectId, thread.canvasId, thread.canvasRevision, JSON.stringify(thread.anchor), thread.status, thread.severity, thread.createdBy, now, now);
    return thread;
  }

  updateReviewThread(threadId, patch = {}) {
    const current = this.getReviewThread(threadId);
    if (!current) return null;
    const status = String(patch.status || current.status);
    const severity = String(patch.severity || current.severity);
    const updatedAt = Date.now();
    this.db.prepare('UPDATE review_threads SET status = ?, severity = ?, updated_at = ? WHERE id = ?')
      .run(status, severity, updatedAt, threadId);
    return this.getReviewThread(threadId);
  }

  getReviewThread(threadId) {
    const row = this.db.prepare('SELECT * FROM review_threads WHERE id = ?').get(String(threadId));
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      canvasId: row.canvas_id,
      canvasRevision: row.canvas_revision,
      anchor: parseJson(row.anchor_json, {}),
      status: row.status,
      severity: row.severity,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listReviewThreads(filters = {}) {
    const projectId = String(filters.projectId || DEFAULT_PROJECT_ID);
    const clauses = ['project_id = ?'];
    const values = [projectId];
    if (filters.canvasId) { clauses.push('canvas_id = ?'); values.push(String(filters.canvasId)); }
    if (filters.status) { clauses.push('status = ?'); values.push(String(filters.status)); }
    return this.db.prepare(`SELECT id FROM review_threads WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT 1000`)
      .all(...values)
      .map((row) => ({ ...this.getReviewThread(row.id), comments: this.listReviewComments(row.id) }));
  }

  createReviewComment(input) {
    const now = Date.now();
    const comment = {
      id: String(input.id || crypto.randomUUID()),
      threadId: String(input.threadId),
      parentId: input.parentId ? String(input.parentId) : null,
      body: String(input.body || '').trim(),
      createdBy: String(input.createdBy),
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO review_comments(id, thread_id, parent_id, body, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(comment.id, comment.threadId, comment.parentId, comment.body, comment.createdBy, now, now);
    return comment;
  }

  listReviewComments(threadId) {
    return this.db.prepare('SELECT * FROM review_comments WHERE thread_id = ? ORDER BY created_at ASC').all(String(threadId)).map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      parentId: row.parent_id,
      body: row.body,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createRunIntent(input) {
    const now = Date.now();
    const estimatedCostKnown = input.estimatedCostKnown === true
      || (input.estimatedCostKnown !== false && input.estimatedCost != null && Number.isFinite(Number(input.estimatedCost)));
    const estimatedCost = estimatedCostKnown
      ? Math.max(0, Number(input.estimatedCost) || 0)
      : null;
    const executionAuthority = input.executionAuthority && typeof input.executionAuthority === 'object'
      ? input.executionAuthority
      : null;
    const intent = {
      id: String(input.id || crypto.randomUUID()),
      projectId: String(input.projectId || DEFAULT_PROJECT_ID),
      canvasId: String(input.canvasId),
      canvasRevision: Math.max(1, Number(input.canvasRevision) || 1),
      nodeIds: Array.isArray(input.nodeIds) ? input.nodeIds.map(String) : [],
      idempotencyKey: String(input.idempotencyKey),
      requestedBy: String(input.requestedBy),
      provider: input.provider ? String(input.provider) : null,
      model: input.model ? String(input.model) : null,
      estimatedCost,
      estimatedCostKnown,
      executionAuthority,
      actualCost: null,
      status: 'pending',
      runId: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.db.prepare(`
        INSERT INTO run_intents(
          id, project_id, canvas_id, canvas_revision, node_ids_json, idempotency_key, requested_by,
          provider, model, estimated_cost, estimated_cost_known, execution_authority_json,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        intent.id, intent.projectId, intent.canvasId, intent.canvasRevision, JSON.stringify(intent.nodeIds),
        intent.idempotencyKey, intent.requestedBy, intent.provider, intent.model, intent.estimatedCost || 0,
        intent.estimatedCostKnown ? 1 : 0, JSON.stringify(intent.executionAuthority || {}),
        intent.status, now, now,
      );
      return intent;
    } catch (error) {
      if (!String(error?.code || '').includes('CONSTRAINT')) throw error;
      return this.getRunIntentByKey(intent.projectId, intent.idempotencyKey);
    }
  }

  getRunIntentByKey(projectId, idempotencyKey) {
    const row = this.db.prepare('SELECT * FROM run_intents WHERE project_id = ? AND idempotency_key = ?').get(String(projectId), String(idempotencyKey));
    return row ? this.mapRunIntent(row) : null;
  }

  getRunIntent(intentId) {
    const row = this.db.prepare('SELECT * FROM run_intents WHERE id = ?').get(String(intentId));
    return row ? this.mapRunIntent(row) : null;
  }

  mapRunIntent(row) {
    return {
      id: row.id,
      projectId: row.project_id,
      canvasId: row.canvas_id,
      canvasRevision: row.canvas_revision,
      nodeIds: parseJson(row.node_ids_json, []),
      idempotencyKey: row.idempotency_key,
      requestedBy: row.requested_by,
      provider: row.provider,
      model: row.model,
      estimatedCost: Number(row.estimated_cost_known) === 1 ? Math.max(0, Number(row.estimated_cost) || 0) : null,
      estimatedCostKnown: Number(row.estimated_cost_known) === 1,
      executionAuthority: parseJson(row.execution_authority_json, null),
      actualCost: row.actual_cost == null ? null : Number(row.actual_cost),
      status: row.status,
      runId: row.run_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listRunIntents(filters = {}) {
    const projectId = String(filters.projectId || DEFAULT_PROJECT_ID);
    const status = filters.status ? String(filters.status) : null;
    const canvasId = filters.canvasId ? String(filters.canvasId) : null;
    const rows = status && canvasId
      ? this.db.prepare('SELECT * FROM run_intents WHERE project_id = ? AND canvas_id = ? AND status = ? ORDER BY created_at ASC, id ASC LIMIT 500').all(projectId, canvasId, status)
      : status
        ? this.db.prepare('SELECT * FROM run_intents WHERE project_id = ? AND status = ? ORDER BY created_at ASC, id ASC LIMIT 500').all(projectId, status)
        : canvasId
          ? this.db.prepare('SELECT * FROM run_intents WHERE project_id = ? AND canvas_id = ? ORDER BY created_at DESC, id DESC LIMIT 500').all(projectId, canvasId)
          : this.db.prepare('SELECT * FROM run_intents WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 500').all(projectId);
    return rows.map((row) => this.mapRunIntent(row));
  }

  updateRunIntent(intentId, patch = {}, options = {}) {
    const expectedProjectId = options.expectedProjectId == null ? null : String(options.expectedProjectId);
    const expectedCanvasId = options.expectedCanvasId == null ? null : String(options.expectedCanvasId);
    const row = expectedProjectId == null && expectedCanvasId == null
      ? this.db.prepare('SELECT * FROM run_intents WHERE id = ?').get(String(intentId))
      : expectedCanvasId == null
        ? this.db.prepare('SELECT * FROM run_intents WHERE id = ? AND project_id = ?').get(String(intentId), expectedProjectId)
        : this.db.prepare('SELECT * FROM run_intents WHERE id = ? AND project_id = ? AND canvas_id = ?')
          .get(String(intentId), expectedProjectId, expectedCanvasId);
    if (!row) return null;
    const actualCost = patch.actualCost == null ? row.actual_cost : Math.max(0, Number(patch.actualCost) || 0);
    const result = expectedProjectId == null && expectedCanvasId == null
      ? this.db.prepare('UPDATE run_intents SET status = ?, run_id = ?, actual_cost = ?, updated_at = ? WHERE id = ?')
        .run(String(patch.status || row.status), patch.runId ?? row.run_id, actualCost, Date.now(), intentId)
      : expectedCanvasId == null
        ? this.db.prepare('UPDATE run_intents SET status = ?, run_id = ?, actual_cost = ?, updated_at = ? WHERE id = ? AND project_id = ?')
          .run(String(patch.status || row.status), patch.runId ?? row.run_id, actualCost, Date.now(), intentId, expectedProjectId)
        : this.db.prepare('UPDATE run_intents SET status = ?, run_id = ?, actual_cost = ?, updated_at = ? WHERE id = ? AND project_id = ? AND canvas_id = ?')
          .run(String(patch.status || row.status), patch.runId ?? row.run_id, actualCost, Date.now(), intentId, expectedProjectId, expectedCanvasId);
    if (result.changes !== 1) return null;
    const updated = expectedProjectId == null && expectedCanvasId == null
      ? this.db.prepare('SELECT * FROM run_intents WHERE id = ?').get(String(intentId))
      : expectedCanvasId == null
        ? this.db.prepare('SELECT * FROM run_intents WHERE id = ? AND project_id = ?').get(String(intentId), expectedProjectId)
        : this.db.prepare('SELECT * FROM run_intents WHERE id = ? AND project_id = ? AND canvas_id = ?')
          .get(String(intentId), expectedProjectId, expectedCanvasId);
    return updated ? this.mapRunIntent(updated) : null;
  }

  claimRunIntent(intentId, run) {
    const intent = this.getRunIntent(intentId);
    if (!intent) throw new Error('运行意图不存在');
    if (!['pending', 'accepted'].includes(intent.status) || intent.runId) {
      throw new Error('运行意图已被处理或已由其他 Run 消费');
    }
    if (intent.projectId !== run.projectId || intent.canvasId !== run.canvasId || intent.canvasRevision !== run.canvasRevision) {
      throw new Error('运行意图与主机 Run 的项目、画布或 revision 不一致');
    }
    const result = this.db.prepare(`
      UPDATE run_intents SET status = 'running', run_id = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'accepted') AND run_id IS NULL
    `).run(run.id, Date.now(), intent.id);
    if (result.changes !== 1) throw new Error('运行意图已被另一主机消费');
    return this.getRunIntent(intent.id);
  }

  finishRunIntentForRun(runId, runStatus, actualCost = null) {
    const row = this.db.prepare('SELECT * FROM run_intents WHERE run_id = ?').get(String(runId));
    if (!row) return null;
    const nextStatus = String(runStatus) === 'succeeded' ? 'completed' : 'failed';
    const normalizedCost = actualCost == null ? row.actual_cost : Math.max(0, Number(actualCost) || 0);
    this.db.prepare(`
      UPDATE run_intents SET status = ?, actual_cost = ?, updated_at = ?
      WHERE id = ? AND status IN ('accepted', 'running')
    `).run(nextStatus, normalizedCost, Date.now(), row.id);
    return this.getRunIntent(row.id);
  }

  getExecutionPolicy(projectId = DEFAULT_PROJECT_ID) {
    const row = this.db.prepare('SELECT * FROM project_execution_policies WHERE project_id = ?').get(String(projectId));
    return row ? {
      projectId: row.project_id,
      allowedModels: parseJson(row.allowed_models_json, []),
      dailyCostLimit: Number(row.daily_cost_limit) || 0,
      perRunCostLimit: Number(row.per_run_cost_limit) || 0,
      concurrencyLimit: Math.max(1, Number(row.concurrency_limit) || 1),
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    } : {
      projectId: String(projectId),
      allowedModels: ['*'],
      dailyCostLimit: 0,
      perRunCostLimit: 0,
      concurrencyLimit: 2,
      updatedBy: null,
      updatedAt: null,
    };
  }

  setExecutionPolicy(projectId = DEFAULT_PROJECT_ID, input = {}, options = {}) {
    const allowedModels = Array.isArray(input.allowedModels)
      ? [...new Set(input.allowedModels.map((value) => String(value).trim()).filter((value) => value && value.length <= 160))].slice(0, 500)
      : [];
    const policy = {
      projectId: String(projectId),
      allowedModels,
      dailyCostLimit: Math.max(0, Number(input.dailyCostLimit) || 0),
      perRunCostLimit: Math.max(0, Number(input.perRunCostLimit) || 0),
      concurrencyLimit: Math.min(64, Math.max(1, Number(input.concurrencyLimit) || 1)),
      updatedBy: String(options.actorId || 'local-owner'),
      updatedAt: Date.now(),
    };
    this.db.prepare(`
      INSERT INTO project_execution_policies(
        project_id, allowed_models_json, daily_cost_limit, per_run_cost_limit, concurrency_limit, updated_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        allowed_models_json=excluded.allowed_models_json, daily_cost_limit=excluded.daily_cost_limit,
        per_run_cost_limit=excluded.per_run_cost_limit, concurrency_limit=excluded.concurrency_limit,
        updated_by=excluded.updated_by, updated_at=excluded.updated_at
    `).run(
      policy.projectId, JSON.stringify(policy.allowedModels), policy.dailyCostLimit, policy.perRunCostLimit,
      policy.concurrencyLimit, policy.updatedBy, policy.updatedAt,
    );
    this.appendAuditEvent({
      projectId: policy.projectId,
      actorId: policy.updatedBy,
      sessionId: options.sessionId,
      action: 'collaboration.execution-policy.update',
      targetType: 'project',
      targetId: policy.projectId,
      metadata: {
        allowedModelCount: policy.allowedModels.length,
        dailyCostLimit: policy.dailyCostLimit,
        perRunCostLimit: policy.perRunCostLimit,
        concurrencyLimit: policy.concurrencyLimit,
      },
    });
    return policy;
  }

  getExecutionUsage(projectId = DEFAULT_PROJECT_ID, now = Date.now(), options = {}) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    const dayStart = date.getTime();
    const normalizedProjectId = String(projectId);
    const excludeIntentId = String(options.excludeIntentId || '').trim();
    if (excludeIntentId) {
      const reservation = this.getRunIntent(excludeIntentId);
      if (!reservation
        || reservation.projectId !== normalizedProjectId
        || !['pending', 'accepted', 'running'].includes(reservation.status)) {
        const error = new Error('无法确认当前运行意图的有效额度预留');
        error.code = 'intent_reservation_invalid';
        error.status = 409;
        throw error;
      }
    }
    const row = this.db.prepare(`
      SELECT
        SUM(CASE
          WHEN id <> ? AND status IN ('pending', 'accepted', 'running') THEN 1 ELSE 0
        END) AS active_count,
        SUM(CASE
          WHEN id <> ?
            AND status NOT IN ('rejected', 'stale')
            AND (status IN ('pending', 'accepted', 'running') OR updated_at >= ?)
          THEN CASE
            WHEN actual_cost IS NOT NULL THEN actual_cost
            WHEN estimated_cost_known = 1 THEN estimated_cost
            ELSE 0
          END ELSE 0
        END) AS daily_cost,
        SUM(CASE
          WHEN id <> ?
            AND status NOT IN ('rejected', 'stale')
            AND (status IN ('pending', 'accepted', 'running') OR updated_at >= ?)
            AND actual_cost IS NULL
            AND estimated_cost_known <> 1
          THEN 1 ELSE 0
        END) AS unknown_cost_count
      FROM run_intents WHERE project_id = ?
    `).get(
      excludeIntentId,
      excludeIntentId,
      dayStart,
      excludeIntentId,
      dayStart,
      normalizedProjectId,
    );
    return {
      activeCount: Number(row?.active_count) || 0,
      dailyCost: Number(row?.daily_cost) || 0,
      unknownCostCount: Number(row?.unknown_cost_count) || 0,
      dayStart,
    };
  }

  saveSubflowDefinition(input, options = {}) {
    const write = this.db.transaction((value) => {
      const id = String(value.id || crypto.randomUUID()).trim() || crypto.randomUUID();
      const projectId = String(value.projectId || DEFAULT_PROJECT_ID);
      const latest = this.db.prepare('SELECT MAX(version) AS version FROM subflow_definitions WHERE id = ? AND project_id = ?').get(id, projectId);
      const head = this.db.prepare('SELECT * FROM subflow_definition_heads WHERE project_id = ? AND id = ?').get(projectId, id);
      const latestVersion = Math.max(0, Number(latest?.version) || 0);
      const currentRevision = Math.max(0, Number(head?.revision) || latestVersion);
      const rawExpectedRevision = options.expectedRevision ?? value.baseRevision;
      if (rawExpectedRevision != null) {
        const expectedRevision = Number(rawExpectedRevision);
        if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error('子工作流 baseRevision 无效');
        if (expectedRevision !== currentRevision) {
          const currentRow = latestVersion
            ? this.db.prepare('SELECT definition_json, created_by, created_at FROM subflow_definitions WHERE project_id = ? AND id = ? AND version = ?').get(projectId, id, latestVersion)
            : null;
          throw new SubflowRevisionConflictError({
            projectId,
            id,
            revision: currentRevision,
            latestVersion,
            definition: normalizeStoredSubflowDefinition(currentRow ? parseJson(currentRow.definition_json, null) : null, currentRow || {}),
          });
        }
      }
      const requestedInitialVersion = Math.max(1, Number(value.version) || 1);
      const version = latestVersion > 0 ? latestVersion + 1 : requestedInitialVersion;
      const revision = currentRevision + 1;
      const now = Date.now();
      const actorId = String(options.actorId || value.createdBy || 'local-owner');
      const sessionId = String(options.sessionId || 'local-session');
      const changeSummary = String(options.changeSummary ?? value.changeSummary ?? '').trim().slice(0, 500)
        || (currentRevision > 0 ? '发布子工作流新版本' : '创建子工作流');
      const {
        baseRevision: _baseRevision,
        revision: _revision,
        publishedBy: _publishedBy,
        publishedAt: _publishedAt,
        changeSummary: _changeSummary,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        createdBy: _createdBy,
        ...content
      } = value;
      const definition = {
        ...content,
        id,
        version,
        revision,
        projectId,
        name: String(value.name || '未命名子工作流').trim().slice(0, 100),
        changeSummary,
        publishedBy: actorId,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      this.db.prepare(`
        INSERT INTO subflow_definitions(id, version, project_id, name, definition_json, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, version, projectId, definition.name, JSON.stringify(definition), actorId, now);
      this.db.prepare(`
        INSERT INTO subflow_definition_heads(project_id, id, revision, latest_version, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, id) DO UPDATE SET
          revision=excluded.revision,
          latest_version=excluded.latest_version,
          updated_by=excluded.updated_by,
          updated_at=excluded.updated_at
      `).run(projectId, id, revision, version, actorId, now);
      this.appendAuditEvent({
        projectId,
        actorId,
        sessionId,
        action: 'subflow.definition.publish',
        targetType: 'subflow-definition',
        targetId: id,
        metadata: { version, revision, previousRevision: currentRevision, changeSummary },
      });
      if (options.grantCanvasId != null) {
        this._grantCanvasSubflowResource(
          projectId,
          String(options.grantCanvasId),
          id,
          version,
          CANVAS_RESOURCE_PUBLISH_SOURCE,
          now,
        );
      }
      return definition;
    });
    return write.immediate(input);
  }

  getSubflowDefinitionHead(id, projectId = DEFAULT_PROJECT_ID) {
    const head = this.db.prepare('SELECT * FROM subflow_definition_heads WHERE project_id = ? AND id = ?').get(String(projectId), String(id));
    if (!head) return null;
    return {
      projectId: head.project_id,
      id: head.id,
      revision: Number(head.revision),
      latestVersion: Number(head.latest_version),
      updatedBy: head.updated_by,
      updatedAt: Number(head.updated_at),
      definition: this.getSubflowDefinition(head.id, head.latest_version, head.project_id),
    };
  }

  getSubflowDefinition(id, version, projectId = DEFAULT_PROJECT_ID) {
    const row = version
      ? this.db.prepare('SELECT definition_json, created_by, created_at FROM subflow_definitions WHERE project_id = ? AND id = ? AND version = ?').get(String(projectId), String(id), Number(version))
      : this.db.prepare('SELECT definition_json, created_by, created_at FROM subflow_definitions WHERE project_id = ? AND id = ? ORDER BY version DESC LIMIT 1').get(String(projectId), String(id));
    return row ? normalizeStoredSubflowDefinition(parseJson(row.definition_json, null), row) : null;
  }

  getSubflowDefinitionsByRefs(refs, projectId = DEFAULT_PROJECT_ID) {
    if (!Array.isArray(refs) || refs.length > 100) throw new Error('子工作流批量引用超过限制');
    const unique = new Map();
    for (const ref of refs) {
      const id = typeof ref?.id === 'string' ? ref.id : '';
      const version = Number(ref?.version);
      if (!id || id.length > 160 || !Number.isSafeInteger(version) || version < 1) {
        throw new Error('子工作流批量引用无效');
      }
      unique.set(`${id}\u0000${version}`, { id, version });
    }
    const requested = [...unique.values()];
    if (requested.length === 0) return [];
    const clauses = requested.map(() => '(id = ? AND version = ?)').join(' OR ');
    const parameters = [String(projectId), ...requested.flatMap((ref) => [ref.id, ref.version])];
    const rows = this.db.prepare(`
      SELECT id, version, project_id, definition_json, created_by, created_at
      FROM subflow_definitions
      WHERE project_id = ? AND (${clauses})
      LIMIT 100
    `).all(...parameters);
    const byRef = new Map();
    for (const row of rows) {
      const definition = normalizeStoredSubflowDefinition(parseJson(row.definition_json, null), row);
      if (!definition) continue;
      const normalized = {
        ...definition,
        id: String(row.id),
        version: Number(row.version),
        projectId: String(row.project_id),
      };
      byRef.set(`${normalized.id}\u0000${normalized.version}`, normalized);
    }
    return requested.map((ref) => byRef.get(`${ref.id}\u0000${ref.version}`)).filter(Boolean);
  }

  listSubflowDefinitions(filters = {}) {
    const projectId = String(filters.projectId || DEFAULT_PROJECT_ID);
    const query = String(filters.query || '').trim().toLowerCase();
    const rows = this.db.prepare(`
      SELECT d.definition_json, d.created_by, d.created_at FROM subflow_definitions d
      INNER JOIN (
        SELECT id, MAX(version) AS version FROM subflow_definitions WHERE project_id = ? GROUP BY id
      ) latest ON latest.id = d.id AND latest.version = d.version
      WHERE d.project_id = ? ORDER BY d.created_at DESC LIMIT 1000
    `).all(projectId, projectId);
    return rows.map((row) => normalizeStoredSubflowDefinition(parseJson(row.definition_json, null), row)).filter((definition) => {
      if (!definition) return false;
      if (!query) return true;
      return `${definition.name || ''} ${definition.description || ''} ${definition.category || ''} ${(definition.tags || []).join(' ')}`.toLowerCase().includes(query);
    });
  }

  listSubflowVersions(id, projectId = DEFAULT_PROJECT_ID) {
    return this.db.prepare('SELECT definition_json, created_by, created_at FROM subflow_definitions WHERE project_id = ? AND id = ? ORDER BY version DESC').all(String(projectId), String(id))
      .map((row) => normalizeStoredSubflowDefinition(parseJson(row.definition_json, null), row)).filter(Boolean);
  }

  createRun(input) {
    const now = Date.now();
    const run = {
      id: String(input.id || crypto.randomUUID()),
      projectId: String(input.projectId || DEFAULT_PROJECT_ID),
      canvasId: String(input.canvasId),
      canvasRevision: Math.max(0, Number(input.canvasRevision) || 0),
      initiatorId: String(input.initiatorId || 'local-owner'),
      status: String(input.status || 'queued'),
      parentRunId: input.parentRunId ? String(input.parentRunId) : null,
      summary: input.summary && typeof input.summary === 'object' ? input.summary : {},
      createdAt: now,
      startedAt: input.startedAt || null,
      finishedAt: input.finishedAt || null,
    };
    this.db.prepare(`
      INSERT INTO runs(id, project_id, canvas_id, canvas_revision, initiator_id, parent_run_id, status, summary_json, created_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, run.projectId, run.canvasId, run.canvasRevision, run.initiatorId, run.parentRunId, run.status, JSON.stringify(run.summary), now, run.startedAt, run.finishedAt);
    return run;
  }

  createNodeRun(input) {
    const now = Date.now();
    const nodeRun = {
      id: String(input.id || crypto.randomUUID()),
      runId: String(input.runId),
      nodeId: String(input.nodeId),
      parentNodeRunId: input.parentNodeRunId ? String(input.parentNodeRunId) : null,
      originalNodeId: input.originalNodeId ? String(input.originalNodeId) : null,
      definitionId: input.definitionId ? String(input.definitionId) : null,
      definitionVersion: input.definitionVersion == null ? null : Math.max(1, Number(input.definitionVersion) || 1),
      subflowPath: Array.isArray(input.subflowPath) ? input.subflowPath.map(String) : [],
      status: String(input.status || 'queued'),
      inputSnapshot: input.inputSnapshot && typeof input.inputSnapshot === 'object' ? input.inputSnapshot : {},
      outputRefs: Array.isArray(input.outputRefs) ? input.outputRefs.map(String) : [],
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO node_runs(id, run_id, node_id, parent_node_run_id, original_node_id, definition_id, definition_version, subflow_path_json, status, input_json, output_refs_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nodeRun.id, nodeRun.runId, nodeRun.nodeId, nodeRun.parentNodeRunId, nodeRun.originalNodeId,
      nodeRun.definitionId, nodeRun.definitionVersion,
      JSON.stringify(nodeRun.subflowPath),
      nodeRun.status,
      JSON.stringify(nodeRun.inputSnapshot),
      JSON.stringify(nodeRun.outputRefs),
      now,
      now,
    );
    return nodeRun;
  }

  updateNodeRun(nodeRunId, patch = {}) {
    const current = this.getNodeRun(nodeRunId);
    if (!current) return null;
    const next = {
      status: String(patch.status || current.status),
      outputRefs: Array.isArray(patch.outputRefs) ? patch.outputRefs.map(String) : current.outputRefs,
      updatedAt: Date.now(),
    };
    this.db.prepare('UPDATE node_runs SET status = ?, output_refs_json = ?, updated_at = ? WHERE id = ?')
      .run(next.status, JSON.stringify(next.outputRefs), next.updatedAt, nodeRunId);
    return this.getNodeRun(nodeRunId);
  }

  getNodeRun(nodeRunId) {
    const row = this.db.prepare('SELECT * FROM node_runs WHERE id = ?').get(String(nodeRunId));
    return row ? this.mapNodeRunRow(row) : null;
  }

  mapNodeRunRow(row) {
    return {
      id: row.id,
      runId: row.run_id,
      nodeId: row.node_id,
      parentNodeRunId: row.parent_node_run_id,
      originalNodeId: row.original_node_id,
      definitionId: row.definition_id,
      definitionVersion: row.definition_version,
      subflowPath: parseJson(row.subflow_path_json, []),
      status: row.status,
      inputSnapshot: parseJson(row.input_json, {}),
      outputRefs: parseJson(row.output_refs_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listNodeRuns(runId) {
    return this.db.prepare('SELECT * FROM node_runs WHERE run_id = ? ORDER BY created_at ASC, id ASC')
      .all(String(runId))
      .map((row) => this.mapNodeRunRow(row));
  }

  createAttempt(input) {
    const now = Date.now();
    const attempt = {
      id: String(input.id || crypto.randomUUID()),
      nodeRunId: String(input.nodeRunId),
      provider: input.provider ? String(input.provider) : null,
      model: input.model ? String(input.model) : null,
      upstreamTaskId: input.upstreamTaskId ? String(input.upstreamTaskId) : null,
      requestId: input.requestId ? String(input.requestId) : null,
      httpStatus: Number.isInteger(Number(input.httpStatus)) && Number(input.httpStatus) >= 100 && Number(input.httpStatus) <= 599 ? Number(input.httpStatus) : null,
      pollCount: Math.max(0, Math.min(1000000, Math.trunc(Number(input.pollCount) || 0))),
      status: String(input.status || 'queued'),
      timestamps: input.timestamps && typeof input.timestamps === 'object' ? input.timestamps : { queuedAt: now },
      usage: input.usage && typeof input.usage === 'object' ? input.usage : {},
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
      error: input.error && typeof input.error === 'object' ? input.error : null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO run_attempts(id, node_run_id, provider, model, upstream_task_id, request_id, http_status, poll_count, status, timestamps_json, usage_json, metadata_json, error_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempt.id, attempt.nodeRunId, attempt.provider, attempt.model, attempt.upstreamTaskId, attempt.requestId,
      attempt.httpStatus, attempt.pollCount, attempt.status, JSON.stringify(attempt.timestamps), JSON.stringify(attempt.usage), JSON.stringify(attempt.metadata),
      attempt.error ? JSON.stringify(attempt.error) : null, now, now,
    );
    return attempt;
  }

  updateAttempt(attemptId, patch = {}, scope = {}) {
    const current = this.getAttempt(attemptId);
    if (!current) return null;
    const expectedNodeRunId = scope?.nodeRunId == null ? null : String(scope.nodeRunId);
    const expectedRunId = scope?.runId == null ? null : String(scope.runId);
    if (expectedNodeRunId || expectedRunId) {
      const relationship = this.db.prepare(`
        SELECT 1
        FROM run_attempts ra
        JOIN node_runs nr ON nr.id = ra.node_run_id
        WHERE ra.id = ?
          AND (? IS NULL OR nr.id = ?)
          AND (? IS NULL OR nr.run_id = ?)
        LIMIT 1
      `).get(
        String(attemptId),
        expectedNodeRunId, expectedNodeRunId,
        expectedRunId, expectedRunId,
      );
      if (!relationship) throw new Error('Attempt 不属于当前 Run/NodeRun');
    }
    const next = {
      provider: patch.provider ?? current.provider,
      model: patch.model ?? current.model,
      upstreamTaskId: patch.upstreamTaskId ?? current.upstreamTaskId,
      requestId: patch.requestId ?? current.requestId,
      httpStatus: patch.httpStatus === undefined
        ? current.httpStatus
        : (Number.isInteger(Number(patch.httpStatus)) && Number(patch.httpStatus) >= 100 && Number(patch.httpStatus) <= 599 ? Number(patch.httpStatus) : current.httpStatus),
      pollCount: patch.pollCount === undefined
        ? current.pollCount
        : Math.max(current.pollCount, Math.max(0, Math.min(1000000, Math.trunc(Number(patch.pollCount) || 0)))),
      status: String(patch.status || current.status),
      timestamps: patch.timestamps && typeof patch.timestamps === 'object' ? { ...current.timestamps, ...patch.timestamps } : current.timestamps,
      usage: patch.usage && typeof patch.usage === 'object' ? { ...current.usage, ...patch.usage } : current.usage,
      metadata: patch.metadata && typeof patch.metadata === 'object' ? { ...current.metadata, ...patch.metadata } : current.metadata,
      error: patch.error === undefined ? current.error : patch.error,
      updatedAt: Date.now(),
    };
    this.db.prepare(`
      UPDATE run_attempts SET provider = ?, model = ?, upstream_task_id = ?, request_id = ?, http_status = ?, poll_count = ?, status = ?,
        timestamps_json = ?, usage_json = ?, metadata_json = ?, error_json = ?, updated_at = ? WHERE id = ?
    `).run(
      next.provider, next.model, next.upstreamTaskId, next.requestId, next.httpStatus, next.pollCount, next.status,
      JSON.stringify(next.timestamps), JSON.stringify(next.usage), JSON.stringify(next.metadata), next.error ? JSON.stringify(next.error) : null,
      next.updatedAt, attemptId,
    );
    return this.getAttempt(attemptId);
  }

  getAttempt(attemptId) {
    const row = this.db.prepare('SELECT * FROM run_attempts WHERE id = ?').get(String(attemptId));
    if (!row) return null;
    const attemptNumber = Number(this.db.prepare('SELECT COUNT(*) AS count FROM run_attempts WHERE node_run_id = ? AND (created_at < ? OR (created_at = ? AND id <= ?))').get(row.node_run_id, row.created_at, row.created_at, row.id)?.count || 1);
    return this.mapAttemptRow(row, attemptNumber);
  }

  mapAttemptRow(row, attemptNumber) {
    return {
      id: row.id,
      nodeRunId: row.node_run_id,
      attemptNumber,
      provider: row.provider,
      model: row.model,
      upstreamTaskId: row.upstream_task_id,
      requestId: row.request_id,
      httpStatus: row.http_status,
      pollCount: Number(row.poll_count) || 0,
      status: row.status,
      timestamps: parseJson(row.timestamps_json, {}),
      usage: parseJson(row.usage_json, {}),
      metadata: parseJson(row.metadata_json, {}),
      error: parseJson(row.error_json, null),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listAttempts(nodeRunId) {
    return this.db.prepare('SELECT * FROM run_attempts WHERE node_run_id = ? ORDER BY created_at ASC, id ASC')
      .all(String(nodeRunId))
      .map((row, index) => this.mapAttemptRow(row, index + 1));
  }

  listRunAttempts(runId) {
    const counts = new Map();
    return this.db.prepare(`
      SELECT ra.* FROM run_attempts ra
      JOIN node_runs nr ON nr.id = ra.node_run_id
      WHERE nr.run_id = ? ORDER BY ra.created_at ASC, ra.id ASC
    `).all(String(runId)).map((row) => {
      const attemptNumber = (counts.get(row.node_run_id) || 0) + 1;
      counts.set(row.node_run_id, attemptNumber);
      return this.mapAttemptRow(row, attemptNumber);
    });
  }

  recordRunOutputAssets(input = {}) {
    const run = this.getRun(input.runId);
    const nodeRun = this.getNodeRun(input.nodeRunId);
    if (!run || !nodeRun || nodeRun.runId !== run.id) throw new Error('输出记录不属于当前 Run');
    const attempt = input.attemptId ? this.getAttempt(input.attemptId) : null;
    if (input.attemptId && (!attempt || attempt.nodeRunId !== nodeRun.id)) throw new Error('输出 Attempt 不属于当前 NodeRun');
    const outputs = Array.isArray(input.outputs) ? input.outputs.slice(0, 100) : [];
    const allowedKinds = new Set(['image', 'video', 'audio', 'model3d', 'text', 'other']);
    const promptSummary = promptSummaryFromSnapshot(nodeRun.inputSnapshot);
    const promptDigest = promptSummary
      ? `sha256:${crypto.createHash('sha256').update(promptSummary).digest('hex')}`
      : null;
    const snapshotNode = nodeRun.inputSnapshot?.node && typeof nodeRun.inputSnapshot.node === 'object'
      ? nodeRun.inputSnapshot.node
      : null;
    const sourceNodeId = String(nodeRun.originalNodeId || snapshotNode?.id || nodeRun.nodeId);
    const sourceNodeType = String(snapshotNode?.type || 'unknown').slice(0, 120);
    const inputAssets = this.findAssetsBySourceUrls(run.projectId, collectSnapshotAssetUrls(nodeRun.inputSnapshot));
    return this.db.transaction(() => {
      const assets = outputs.flatMap((item, index) => {
        if (!item || typeof item !== 'object') return [];
        const kind = allowedKinds.has(String(item.kind)) ? String(item.kind) : 'other';
        const sourceUrl = String(item.sourceUrl || '').trim().slice(0, 16384);
        const text = String(item.text || '').trim().slice(0, 32000);
        if (!sourceUrl && !text) return [];
        if (/^data:/i.test(sourceUrl) || /^blob:/i.test(sourceUrl)) return [];
        const digest = crypto.createHash('sha256')
          .update(JSON.stringify([run.id, nodeRun.id, kind, sourceUrl, text]))
          .digest('hex')
          .slice(0, 32);
        const assetId = `run-output-${digest}`;
        const existing = (sourceUrl ? this.findAssetBySourceUrl(run.projectId, sourceUrl) : null)
          || this.getAsset(assetId);
        const storageMode = normalizeAssetStorageMode(
          item.storageMode,
          item.managedPath,
          sourceUrl || null,
        );
        const asset = this.upsertAsset({
          id: existing?.id || assetId,
          projectId: run.projectId,
          contentHash: item.contentHash || existing?.contentHash || null,
          perceptualHash: item.perceptualHash || item.metadata?.perceptualHash || existing?.perceptualHash || null,
          kind,
          filename: String(item.filename || existing?.filename || `run-output-${index + 1}`).slice(0, 240),
          mimeType: item.mimeType ? String(item.mimeType).slice(0, 160) : existing?.mimeType || null,
          managedPath: item.managedPath || existing?.managedPath || null,
          sourceUrl: sourceUrl || null,
          storageMode,
          availability: item.availability || existing?.availability || (storageMode === 'remote' ? 'unverified' : 'available'),
          metadata: {
            ...(existing?.metadata || {}),
            ...(item.metadata && typeof item.metadata === 'object' ? item.metadata : {}),
            ...(text ? { text } : {}),
          },
          provenance: {
            ...(existing?.provenance || {}),
            source: 'run-output',
            runId: run.id,
            nodeRunId: nodeRun.id,
            attemptId: attempt?.id || null,
            canvasId: run.canvasId,
            sourceNodeId,
            sourceNodeType,
            provider: attempt?.provider || null,
            model: attempt?.model || null,
          },
          createdBy: run.initiatorId,
        });
        const parents = inputAssets.filter((parent) => parent.id !== asset.id);
        const lineageBase = {
          assetId: asset.id,
          sourceType: 'node-output',
          sourceNodeId,
          sourceNodeType,
          runId: run.id,
          nodeRunId: nodeRun.id,
          attemptId: attempt?.id || null,
          canvasId: run.canvasId,
          creatorId: run.initiatorId,
          promptSummary,
          promptDigest,
          derivedOperation: String(item.metadata?.operation || sourceNodeType || 'generated-output').slice(0, 160),
          metadata: {
            outputIndex: index,
            provider: attempt?.provider || null,
            model: attempt?.model || null,
          },
          strictReferences: true,
        };
        if (parents.length) {
          parents.forEach((parent) => this.recordAssetLineageEvent({ ...lineageBase, parentAssetId: parent.id }));
        } else {
          this.recordAssetLineageEvent(lineageBase);
        }
        return asset ? [asset] : [];
      });
      const outputRefs = [...new Set([...nodeRun.outputRefs, ...assets.map((asset) => asset.id)])];
      return { nodeRun: this.updateNodeRun(nodeRun.id, { outputRefs }), assets };
    })();
  }

  updateRun(runId, patch = {}) {
    const current = this.getRun(runId);
    if (!current) return null;
    const status = String(patch.status || current.status);
    const startedAt = patch.startedAt ?? current.startedAt ?? (status === 'running' ? Date.now() : null);
    const finishedAt = patch.finishedAt ?? current.finishedAt ?? (['succeeded', 'failed', 'stopped'].includes(status) ? Date.now() : null);
    const summary = patch.summary && typeof patch.summary === 'object' ? { ...current.summary, ...patch.summary } : current.summary;
    this.db.prepare('UPDATE runs SET status = ?, summary_json = ?, started_at = ?, finished_at = ? WHERE id = ?')
      .run(status, JSON.stringify(summary), startedAt, finishedAt, runId);
    return this.getRun(runId);
  }

  appendRunEvent(runId, event = {}) {
    const now = Math.max(1, Number(event.createdAt) || Date.now());
    const normalizedRunId = String(runId);
    const normalizedNodeRunId = event.nodeRunId == null ? null : String(event.nodeRunId);
    if (normalizedNodeRunId) {
      const relationship = this.db.prepare(`
        SELECT 1 FROM node_runs WHERE id = ? AND run_id = ? LIMIT 1
      `).get(normalizedNodeRunId, normalizedRunId);
      if (!relationship) throw new Error('RunEvent NodeRun 不属于当前 Run');
    }
    const result = this.db.prepare(`
      INSERT INTO run_events(run_id, node_run_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(normalizedRunId, normalizedNodeRunId, String(event.type || 'log'), JSON.stringify(event.payload || {}), now);
    return { id: Number(result.lastInsertRowid), runId: normalizedRunId, nodeRunId: normalizedNodeRunId, type: String(event.type || 'log'), payload: event.payload || {}, createdAt: now };
  }

  getRun(runId) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    return row ? this.mapRunRow(row) : null;
  }

  mapRunRow(row) {
    return {
      id: row.id,
      projectId: row.project_id,
      canvasId: row.canvas_id,
      canvasRevision: row.canvas_revision,
      initiatorId: row.initiator_id,
      parentRunId: row.parent_run_id,
      status: row.status,
      summary: parseJson(row.summary_json, {}),
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  listRuns(filters = {}) {
    const clauses = [];
    const values = [];
    if (filters.projectId) { clauses.push('runs.project_id = ?'); values.push(String(filters.projectId)); }
    if (filters.canvasId) { clauses.push('runs.canvas_id = ?'); values.push(String(filters.canvasId)); }
    if (filters.status) { clauses.push('runs.status = ?'); values.push(String(filters.status)); }
    if (filters.initiatorId) { clauses.push('runs.initiator_id = ?'); values.push(String(filters.initiatorId)); }
    const provider = String(filters.provider || '').trim().slice(0, 160);
    const model = String(filters.model || '').trim().slice(0, 240);
    const providerJoin = provider || model
      ? 'JOIN node_runs filter_nr ON filter_nr.run_id = runs.id JOIN run_attempts filter_ra ON filter_ra.node_run_id = filter_nr.id'
      : '';
    if (provider && model) {
      clauses.push('filter_ra.provider = ? AND filter_ra.model = ?');
      values.push(provider, model);
    } else if (provider) {
      clauses.push('filter_ra.provider = ?');
      values.push(provider);
    } else if (model) {
      clauses.push('filter_ra.model = ?');
      values.push(model);
    }
    const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
    const rows = this.db.prepare(`SELECT ${providerJoin ? 'DISTINCT' : ''} runs.* FROM runs ${providerJoin} ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY runs.created_at DESC, runs.id DESC LIMIT ?`)
      .all(...values, limit);
    return rows.map((row) => this.mapRunRow(row));
  }

  getRunEvidence(input = {}) {
    const projectId = String(input.projectId || DEFAULT_PROJECT_ID);
    const canvasId = String(input.canvasId || '');
    const requestedRunId = input.runId == null ? null : String(input.runId);
    const requestedNodeRunId = input.nodeRunId == null ? null : String(input.nodeRunId);
    const requestedAttemptId = input.attemptId == null ? null : String(input.attemptId);
    const nodeLimit = Math.max(1, Math.min(100, Math.trunc(Number(input.nodeLimit) || 50)));
    const attemptLimit = Math.max(1, Math.min(20, Math.trunc(Number(input.attemptLimit) || 3)));

    const read = this.db.transaction(() => {
      let runRow;
      if (requestedRunId) {
        runRow = this.db.prepare(`
          SELECT r.* FROM runs r
          WHERE r.project_id = ? AND r.canvas_id = ? AND r.id = ?
          LIMIT 1
        `).get(projectId, canvasId, requestedRunId);
      } else if (requestedAttemptId) {
        runRow = this.db.prepare(`
          SELECT r.*
          FROM runs r
          JOIN node_runs selected_nr ON selected_nr.run_id = r.id
          JOIN run_attempts selected_ra ON selected_ra.node_run_id = selected_nr.id
          WHERE r.project_id = ? AND r.canvas_id = ?
            AND selected_ra.id = ?
            AND (? IS NULL OR selected_nr.id = ?)
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 1
        `).get(projectId, canvasId, requestedAttemptId, requestedNodeRunId, requestedNodeRunId);
      } else if (requestedNodeRunId) {
        runRow = this.db.prepare(`
          SELECT r.*
          FROM runs r
          JOIN node_runs selected_nr ON selected_nr.run_id = r.id
          WHERE r.project_id = ? AND r.canvas_id = ? AND selected_nr.id = ?
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 1
        `).get(projectId, canvasId, requestedNodeRunId);
      } else {
        runRow = this.db.prepare(`
          SELECT r.* FROM runs r
          WHERE r.project_id = ? AND r.canvas_id = ?
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 1
        `).get(projectId, canvasId);
      }
      if (!runRow) return null;

      const run = this.mapRunRow(runRow);
      let selectedNodeRunId = requestedNodeRunId;
      let selectedAttemptId = requestedAttemptId;
      if (requestedNodeRunId || requestedAttemptId) {
        const selected = this.db.prepare(`
          SELECT nr.id AS node_run_id, ra.id AS attempt_id
          FROM node_runs nr
          LEFT JOIN run_attempts ra
            ON ra.node_run_id = nr.id AND (? IS NULL OR ra.id = ?)
          WHERE nr.run_id = ?
            AND (? IS NULL OR nr.id = ?)
            AND (? IS NULL OR ra.id IS NOT NULL)
          ORDER BY nr.created_at ASC, nr.id ASC
          LIMIT 1
        `).get(
          requestedAttemptId, requestedAttemptId,
          run.id,
          requestedNodeRunId, requestedNodeRunId,
          requestedAttemptId,
        );
        if (!selected) {
          return {
            run,
            selection: {
              runId: run.id,
              nodeRunId: requestedNodeRunId,
              attemptId: requestedAttemptId,
            },
            totals: { nodeRuns: 0, attempts: 0 },
            returned: { nodeRuns: 0, attempts: 0 },
            hasMore: { nodeRuns: false, attempts: false },
            evidenceComplete: false,
            evidenceReasons: ['selected_evidence_missing_or_retained'],
            nodeRuns: [],
            attemptsByNodeId: new Map(),
          };
        }
        selectedNodeRunId = selected.node_run_id;
        selectedAttemptId = requestedAttemptId ? selected.attempt_id : null;
      }

      const totalsRow = this.db.prepare(`
        SELECT
          COUNT(DISTINCT nr.id) AS node_runs,
          COUNT(ra.id) AS attempts
        FROM node_runs nr
        LEFT JOIN run_attempts ra
          ON ra.node_run_id = nr.id AND (? IS NULL OR ra.id = ?)
        WHERE nr.run_id = ?
          AND (? IS NULL OR nr.id = ?)
          AND (? IS NULL OR ra.id IS NOT NULL)
      `).get(
        selectedAttemptId, selectedAttemptId,
        run.id,
        selectedNodeRunId, selectedNodeRunId,
        selectedAttemptId,
      );
      const totals = {
        nodeRuns: Math.max(0, Number(totalsRow?.node_runs) || 0),
        attempts: Math.max(0, Number(totalsRow?.attempts) || 0),
      };

      const nodeRows = this.db.prepare(`
        SELECT nr.*
        FROM node_runs nr
        WHERE nr.run_id = ?
          AND (? IS NULL OR nr.id = ?)
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM run_attempts selected_ra
            WHERE selected_ra.node_run_id = nr.id AND selected_ra.id = ?
          ))
        ORDER BY nr.created_at ASC, nr.id ASC
        LIMIT ?
      `).all(
        run.id,
        selectedNodeRunId, selectedNodeRunId,
        selectedAttemptId, selectedAttemptId,
        selectedNodeRunId ? 2 : nodeLimit + 1,
      );
      const visibleNodeRows = nodeRows.slice(0, selectedNodeRunId ? 1 : nodeLimit);
      const nodeIds = visibleNodeRows.map((row) => String(row.id));
      const attemptsByNodeId = new Map(nodeIds.map((id) => [id, []]));
      if (nodeIds.length > 0) {
        const placeholders = nodeIds.map(() => '?').join(',');
        const rankedRows = this.db.prepare(`
          WITH ranked_attempts AS (
            SELECT ra.*,
              ROW_NUMBER() OVER (
                PARTITION BY ra.node_run_id
                ORDER BY ra.created_at ASC, ra.id ASC
              ) AS attempt_number,
              ROW_NUMBER() OVER (
                PARTITION BY ra.node_run_id
                ORDER BY ra.created_at DESC, ra.id DESC
              ) AS recent_rank
            FROM run_attempts ra
            WHERE ra.node_run_id IN (${placeholders})
          )
          SELECT * FROM ranked_attempts
          WHERE (? IS NOT NULL AND id = ?)
             OR (? IS NULL AND recent_rank <= ?)
          ORDER BY node_run_id ASC, created_at ASC, id ASC
        `).all(
          ...nodeIds,
          selectedAttemptId, selectedAttemptId,
          selectedAttemptId, attemptLimit,
        );
        rankedRows.forEach((row) => {
          const items = attemptsByNodeId.get(String(row.node_run_id));
          if (items) items.push(this.mapAttemptRow(row, Number(row.attempt_number) || 1));
        });
      }
      const nodeRuns = visibleNodeRows.map((row) => this.mapNodeRunRow(row));
      const returned = {
        nodeRuns: nodeRuns.length,
        attempts: [...attemptsByNodeId.values()].reduce((sum, items) => sum + items.length, 0),
      };
      const hasMore = {
        nodeRuns: totals.nodeRuns > returned.nodeRuns,
        attempts: totals.attempts > returned.attempts,
      };
      const evidenceReasons = [];
      if (hasMore.nodeRuns) evidenceReasons.push('node_runs_truncated');
      if (hasMore.attempts) evidenceReasons.push('attempts_truncated');
      return {
        run,
        selection: {
          runId: run.id,
          nodeRunId: selectedNodeRunId,
          attemptId: selectedAttemptId,
        },
        totals,
        returned,
        hasMore,
        evidenceComplete: evidenceReasons.length === 0,
        evidenceReasons,
        nodeRuns,
        attemptsByNodeId,
      };
    });
    return read();
  }

  recoverInterruptedRuns() {
    const activeStatuses = [...ACTIVE_STATUSES];
    const placeholders = activeStatuses.map(() => '?').join(',');
    const recover = this.db.transaction(() => {
      const activeRunIds = this.db.prepare(`SELECT id FROM runs WHERE status IN (${placeholders})`).all(...activeStatuses).map((row) => row.id);
      if (!activeRunIds.length) return { runs: 0, nodeRuns: 0, attempts: 0, recoverableRuns: 0, recoverableNodeRuns: 0, recoverableAttempts: 0 };
      const recoverableRunIds = [];
      let recoverableNodeRuns = 0;
      let recoverableAttempts = 0;
      for (const runId of activeRunIds) {
        const activeNodes = this.listNodeRuns(runId).filter((nodeRun) => ACTIVE_STATUSES.has(nodeRun.status));
        const tickets = activeNodes.map((nodeRun) => {
          const attempt = [...this.listAttempts(nodeRun.id)].reverse().find((item) => ACTIVE_STATUSES.has(item.status));
          return { nodeRun, attempt };
        });
        if (tickets.length > 0 && tickets.every((ticket) => isRecoverableRunAttempt(ticket.attempt))) {
          recoverableRunIds.push(runId);
          recoverableNodeRuns += tickets.length;
          recoverableAttempts += tickets.length;
        }
      }
      const recoverableSet = new Set(recoverableRunIds);
      const runIds = activeRunIds.filter((runId) => !recoverableSet.has(runId));
      const now = Date.now();
      const insertEvent = this.db.prepare('INSERT INTO run_events(run_id, node_run_id, type, payload_json, created_at) VALUES (?, NULL, ?, ?, ?)');
      recoverableRunIds.forEach((runId) => {
        const exists = this.db.prepare(`SELECT 1 FROM run_events WHERE run_id = ? AND type = 'log' AND payload_json LIKE '%"phase":"recovery.queued"%' LIMIT 1`).get(runId);
        if (!exists) insertEvent.run(runId, 'log', JSON.stringify({ phase: 'recovery.queued', reason: 'application-restart', recoverable: true }), now);
      });
      if (!runIds.length) return { runs: 0, nodeRuns: 0, attempts: 0, recoverableRuns: recoverableRunIds.length, recoverableNodeRuns, recoverableAttempts };
      const runPlaceholders = runIds.map(() => '?').join(',');
      const attempts = this.db.prepare(`UPDATE run_attempts SET status = 'interrupted', error_json = COALESCE(error_json, ?), updated_at = ? WHERE status IN (${placeholders}) AND node_run_id IN (SELECT id FROM node_runs WHERE run_id IN (${runPlaceholders}))`).run(JSON.stringify({ kind: 'protocol', code: 'RUN_RECOVERY_UNAVAILABLE', message: '应用重启后没有可安全恢复的上游轮询描述', retryable: true }), now, ...activeStatuses, ...runIds).changes;
      const nodeRuns = this.db.prepare(`UPDATE node_runs SET status = 'interrupted', updated_at = ? WHERE status IN (${placeholders}) AND run_id IN (${runPlaceholders})`).run(now, ...activeStatuses, ...runIds).changes;
      this.db.prepare(`UPDATE runs SET status = 'interrupted', finished_at = COALESCE(finished_at, ?) WHERE id IN (${runPlaceholders})`).run(now, ...runIds);
      runIds.forEach((runId) => {
        insertEvent.run(runId, 'run.interrupted', JSON.stringify({ reason: 'application-restart', recoverable: false }), now);
        this.finishRunIntentForRun(runId, 'interrupted', explicitRunCost(this.listRunAttempts(runId)));
      });
      return { runs: runIds.length, nodeRuns, attempts, recoverableRuns: recoverableRunIds.length, recoverableNodeRuns, recoverableAttempts };
    });
    return recover.immediate();
  }

  listPendingRunRecoveries() {
    const activeStatuses = [...ACTIVE_STATUSES];
    const placeholders = activeStatuses.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT ra.id AS attempt_id, nr.id AS node_run_id, r.id AS run_id
      FROM runs r
      JOIN node_runs nr ON nr.run_id = r.id
      JOIN run_attempts ra ON ra.node_run_id = nr.id
      WHERE r.status IN (${placeholders}) AND nr.status IN (${placeholders}) AND ra.status IN (${placeholders})
      ORDER BY r.created_at ASC, nr.created_at ASC, ra.created_at DESC, ra.id DESC
    `).all(...activeStatuses, ...activeStatuses, ...activeStatuses);
    const seenNodes = new Set();
    const tickets = [];
    for (const row of rows) {
      if (seenNodes.has(row.node_run_id)) continue;
      seenNodes.add(row.node_run_id);
      const attempt = this.getAttempt(row.attempt_id);
      if (!isRecoverableRunAttempt(attempt)) continue;
      tickets.push({
        run: this.getRun(row.run_id),
        nodeRun: this.getNodeRun(row.node_run_id),
        attempt: { ...attempt, metadata: { ...attempt.metadata, recovery: normalizeRunRecoveryDescriptor(attempt.metadata?.recovery) } },
      });
    }
    return tickets;
  }

  getRunRetentionPolicy(projectId = DEFAULT_PROJECT_ID) {
    const row = this.db.prepare('SELECT * FROM run_retention_policies WHERE project_id = ?').get(String(projectId));
    return row ? {
      projectId: row.project_id,
      maxDays: row.max_days,
      maxRuns: row.max_runs,
      maxAssetRefs: row.max_asset_refs,
      maxDbBytes: row.max_db_bytes,
      keepReferenced: Boolean(row.keep_referenced),
      updatedAt: row.updated_at,
    } : { projectId: String(projectId), maxDays: 30, maxRuns: 5000, maxAssetRefs: 100000, maxDbBytes: 2 * 1024 * 1024 * 1024, keepReferenced: true, updatedAt: 0 };
  }

  setRunRetentionPolicy(projectId = DEFAULT_PROJECT_ID, patch = {}) {
    const current = this.getRunRetentionPolicy(projectId);
    const next = {
      projectId: String(projectId),
      maxDays: Math.min(3650, Math.max(1, Number(patch.maxDays ?? current.maxDays) || 30)),
      maxRuns: Math.min(1000000, Math.max(10, Number(patch.maxRuns ?? current.maxRuns) || 5000)),
      maxAssetRefs: Math.min(10000000, Math.max(0, Math.trunc(Number(patch.maxAssetRefs ?? current.maxAssetRefs) || 0))),
      maxDbBytes: Math.min(1024 ** 4, Math.max(64 * 1024 * 1024, Number(patch.maxDbBytes ?? current.maxDbBytes) || 2 * 1024 ** 3)),
      keepReferenced: patch.keepReferenced == null ? current.keepReferenced : Boolean(patch.keepReferenced),
      updatedAt: Date.now(),
    };
    this.db.prepare(`INSERT INTO run_retention_policies(project_id, max_days, max_runs, max_asset_refs, max_db_bytes, keep_referenced, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET max_days = excluded.max_days, max_runs = excluded.max_runs, max_asset_refs = excluded.max_asset_refs, max_db_bytes = excluded.max_db_bytes, keep_referenced = excluded.keep_referenced, updated_at = excluded.updated_at`).run(next.projectId, next.maxDays, next.maxRuns, next.maxAssetRefs, next.maxDbBytes, next.keepReferenced ? 1 : 0, next.updatedAt);
    return next;
  }

  databaseAllocatedBytes() {
    const pageBytes = Number(this.db.pragma('page_count', { simple: true })) * Number(this.db.pragma('page_size', { simple: true }));
    if (this.filename === ':memory:') return pageBytes;
    let fileBytes = 0;
    for (const filename of [this.filename, `${this.filename}-wal`]) {
      try { fileBytes += fs.statSync(filename).size; } catch (_) {}
    }
    return Math.max(pageBytes, fileBytes);
  }

  runRetentionRows(projectId) {
    const rows = this.db.prepare(`
      SELECT r.id, r.status, r.created_at,
        LENGTH(COALESCE(r.summary_json, '')) + 192
        + COALESCE((SELECT SUM(LENGTH(COALESCE(n.input_json, '')) + LENGTH(COALESCE(n.output_refs_json, '')) + 256) FROM node_runs n WHERE n.run_id = r.id), 0)
        + COALESCE((SELECT SUM(LENGTH(COALESCE(a.timestamps_json, '')) + LENGTH(COALESCE(a.usage_json, '')) + LENGTH(COALESCE(a.metadata_json, '')) + LENGTH(COALESCE(a.error_json, '')) + 320) FROM run_attempts a JOIN node_runs n2 ON n2.id = a.node_run_id WHERE n2.run_id = r.id), 0)
        + COALESCE((SELECT SUM(LENGTH(COALESCE(e.payload_json, '')) + 128) FROM run_events e WHERE e.run_id = r.id), 0)
        AS estimated_bytes
      FROM runs r WHERE r.project_id = ? ORDER BY r.created_at DESC, r.id DESC
    `).all(String(projectId));
    const refRows = this.db.prepare(`
      SELECT nr.run_id, nr.output_refs_json FROM node_runs nr
      JOIN runs r ON r.id = nr.run_id WHERE r.project_id = ?
    `).all(String(projectId));
    const refsByRun = new Map();
    for (const row of refRows) {
      const refs = parseJson(row.output_refs_json, []);
      refsByRun.set(row.run_id, (refsByRun.get(row.run_id) || 0) + (Array.isArray(refs) ? new Set(refs.map(String)).size : 0));
    }
    return rows.map((row) => ({
      ...row,
      estimatedBytes: Math.max(1, Number(row.estimated_bytes) || 1),
      assetRefs: refsByRun.get(row.id) || 0,
    }));
  }

  pruneRuns(projectId = DEFAULT_PROJECT_ID) {
    const policy = this.getRunRetentionPolicy(projectId);
    const cutoff = Date.now() - policy.maxDays * 24 * 60 * 60 * 1000;
    const rows = this.runRetentionRows(projectId);
    const activeStatuses = new Set(['queued', 'running', 'polling']);
    const protectedRuns = new Set(rows.filter((row) => activeStatuses.has(row.status) || (policy.keepReferenced && row.assetRefs > 0)).map((row) => row.id));
    const candidatesOldestFirst = [...rows].reverse().filter((row) => !protectedRuns.has(row.id));
    const selected = new Set();
    const select = (row) => { if (row && !protectedRuns.has(row.id)) selected.add(row.id); };

    rows.filter((row) => row.created_at < cutoff).forEach(select);

    let projectedRuns = rows.length - selected.size;
    for (const row of candidatesOldestFirst) {
      if (projectedRuns <= policy.maxRuns) break;
      if (!selected.has(row.id)) { selected.add(row.id); projectedRuns -= 1; }
    }

    const beforeAssetRefs = rows.reduce((sum, row) => sum + row.assetRefs, 0);
    let projectedAssetRefs = rows.filter((row) => !selected.has(row.id)).reduce((sum, row) => sum + row.assetRefs, 0);
    for (const row of candidatesOldestFirst) {
      if (projectedAssetRefs <= policy.maxAssetRefs) break;
      if (!selected.has(row.id) && row.assetRefs > 0) {
        selected.add(row.id);
        projectedRuns -= 1;
        projectedAssetRefs -= row.assetRefs;
      }
    }

    const beforeBytes = this.databaseAllocatedBytes();
    let estimatedRemainingBytes = beforeBytes - rows.filter((row) => selected.has(row.id)).reduce((sum, row) => sum + row.estimatedBytes, 0);
    for (const row of candidatesOldestFirst) {
      if (estimatedRemainingBytes <= policy.maxDbBytes) break;
      if (!selected.has(row.id)) {
        selected.add(row.id);
        projectedRuns -= 1;
        projectedAssetRefs -= row.assetRefs;
        estimatedRemainingBytes -= row.estimatedBytes;
      }
    }

    const uniqueIds = [...selected];
    const deletedAssetRefs = rows.filter((row) => selected.has(row.id)).reduce((sum, row) => sum + row.assetRefs, 0);
    const beforeAssets = this.db.prepare('SELECT COUNT(*) AS count FROM assets WHERE project_id = ?').get(String(projectId)).count;
    this.db.transaction(() => {
      const remove = this.db.prepare('DELETE FROM runs WHERE id = ? AND project_id = ?');
      uniqueIds.forEach((id) => remove.run(id, String(projectId)));
    })();
    if (uniqueIds.length > 0) {
      try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
      try { this.db.exec('VACUUM'); } catch (_) {}
    }
    const afterBytes = this.databaseAllocatedBytes();
    const afterRows = this.runRetentionRows(projectId);
    const afterAssetRefs = afterRows.reduce((sum, row) => sum + row.assetRefs, 0);
    const afterAssets = this.db.prepare('SELECT COUNT(*) AS count FROM assets WHERE project_id = ?').get(String(projectId)).count;
    const blockedBy = [];
    if (afterRows.length > policy.maxRuns) blockedBy.push('max-runs-protected');
    if (afterAssetRefs > policy.maxAssetRefs) blockedBy.push('max-asset-refs-protected');
    if (afterBytes > policy.maxDbBytes) blockedBy.push('max-db-bytes-protected-or-non-run-data');
    if (afterRows.some((row) => row.created_at < cutoff && protectedRuns.has(row.id))) blockedBy.push('max-days-protected');
    return {
      deletedRuns: uniqueIds.length,
      protectedRuns: protectedRuns.size,
      deletedAssetRefs,
      beforeRuns: rows.length,
      afterRuns: afterRows.length,
      beforeAssetRefs,
      afterAssetRefs,
      beforeBytes,
      afterBytes,
      assetsDeleted: Math.max(0, beforeAssets - afterAssets),
      limitsSatisfied: blockedBy.length === 0,
      blockedBy,
      policy,
    };
  }

  getRunEvents(runId, afterId = 0) {
    return this.db.prepare('SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT 2000')
      .all(runId, Math.max(0, Number(afterId) || 0))
      .map((row) => ({
        id: row.id,
        runId: row.run_id,
        nodeRunId: row.node_run_id,
        type: row.type,
        payload: parseJson(row.payload_json, {}),
        createdAt: row.created_at,
      }));
  }

  getAssetCatalogRevision(projectId = DEFAULT_PROJECT_ID) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const now = Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO asset_catalog_revisions(project_id, revision, updated_at) VALUES (?, 1, ?)
    `).run(normalizedProjectId, now);
    const row = this.db.prepare('SELECT revision FROM asset_catalog_revisions WHERE project_id = ?').get(normalizedProjectId);
    return Math.max(1, Number(row?.revision) || 1);
  }

  _bumpAssetCatalogRevision(projectId, now = Date.now()) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    this.db.prepare(`
      INSERT INTO asset_catalog_revisions(project_id, revision, updated_at) VALUES (?, 2, ?)
      ON CONFLICT(project_id) DO UPDATE SET revision=asset_catalog_revisions.revision + 1, updated_at=excluded.updated_at
    `).run(normalizedProjectId, now);
    return this.getAssetCatalogRevision(normalizedProjectId);
  }

  _bumpAssetOrganizationRevision(assetIds, now = Date.now()) {
    const normalized = [...new Set((Array.isArray(assetIds) ? assetIds : [assetIds]).map(String).filter(Boolean))];
    if (!normalized.length) return {};
    const update = this.db.prepare(`
      UPDATE assets SET organization_revision=organization_revision + 1, updated_at=? WHERE id=?
    `);
    normalized.forEach((id) => update.run(now, id));
    return Object.fromEntries(this.db.prepare(`
      SELECT id, organization_revision FROM assets WHERE id IN (${normalized.map(() => '?').join(',')})
    `).all(...normalized).map((row) => [row.id, Number(row.organization_revision) || 1]));
  }

  _cleanupOrphanAssetBlob(blobId) {
    if (!blobId) return false;
    const referenced = this.db.prepare('SELECT 1 FROM asset_blob_refs WHERE blob_id = ? LIMIT 1').get(String(blobId));
    if (referenced) return false;
    const blob = this.db.prepare('SELECT storage_state FROM asset_blobs WHERE id = ?').get(String(blobId));
    if (!blob) return false;
    if (blob.storage_state === 'ready') {
      return this.db.prepare(`
        UPDATE asset_blobs SET storage_state = 'pending-delete', pending_delete_at = ?, updated_at = ?
        WHERE id = ? AND storage_state = 'ready'
      `).run(Date.now(), Date.now(), String(blobId)).changes === 1;
    }
    return this.db.prepare('DELETE FROM asset_blobs WHERE id = ?').run(String(blobId)).changes === 1;
  }

  _syncAssetBlobReference(asset, input = {}, now = Date.now()) {
    const currentRef = this.db.prepare('SELECT blob_id, verification_state FROM asset_blob_refs WHERE asset_id = ?').get(asset.id);
    const contentHash = normalizeSha256(asset.contentHash);
    if (!contentHash) {
      this.db.prepare('DELETE FROM asset_blob_refs WHERE asset_id = ?').run(asset.id);
      this._cleanupOrphanAssetBlob(currentRef?.blob_id);
      return null;
    }
    const blobId = `blob_${contentHash}`;
    const hasExplicitVerification = Object.hasOwn(input, 'contentHashVerification') || Object.hasOwn(input, 'verificationState');
    // A metadata-only upsert must not wash a verified per-asset reference back
    // to unverified. New content/ref identities remain fail-closed unless the
    // caller explicitly supplies verification evidence.
    const verificationState = String(hasExplicitVerification
      ? (input.contentHashVerification || input.verificationState || 'unverified')
      : (currentRef?.blob_id === blobId ? currentRef.verification_state : 'unverified')).slice(0, 40);
    const byteSize = Number(asset.metadata?.size);
    this.db.prepare(`
      INSERT INTO asset_blobs(id, content_hash, verification_state, byte_size, mime_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_hash) DO UPDATE SET
        verification_state=CASE
          WHEN asset_blobs.verification_state = 'verified' THEN 'verified'
          ELSE excluded.verification_state
        END,
        byte_size=COALESCE(asset_blobs.byte_size, excluded.byte_size),
        mime_type=COALESCE(asset_blobs.mime_type, excluded.mime_type),
        storage_state=CASE WHEN asset_blobs.storage_state = 'pending-delete' THEN 'ready' ELSE asset_blobs.storage_state END,
        pending_delete_at=CASE WHEN asset_blobs.storage_state = 'pending-delete' THEN NULL ELSE asset_blobs.pending_delete_at END,
        updated_at=excluded.updated_at
    `).run(blobId, contentHash, verificationState, Number.isFinite(byteSize) && byteSize >= 0 ? byteSize : null, asset.mimeType || null, Number(asset.createdAt) || now, now);
    this.db.prepare(`
      INSERT INTO asset_blob_refs(project_id, asset_id, blob_id, verification_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_id) DO UPDATE SET project_id=excluded.project_id, blob_id=excluded.blob_id,
        verification_state=excluded.verification_state, updated_at=excluded.updated_at
    `).run(asset.projectId, asset.id, blobId, verificationState, Number(asset.createdAt) || now, now);
    if (currentRef?.blob_id && currentRef.blob_id !== blobId) this._cleanupOrphanAssetBlob(currentRef.blob_id);
    return this.db.prepare('SELECT * FROM asset_blobs WHERE id = ?').get(blobId);
  }

  _replaceAssetFingerprints(asset, input = {}, now = Date.now()) {
    const explicit = input.clearFingerprints === true
      || Object.hasOwn(input, 'perceptualHashes')
      || Object.hasOwn(input, 'fingerprints')
      || Object.hasOwn(input, 'perceptualHash')
      || Object.hasOwn(input, 'perceptualHashAlgorithm')
      || Object.hasOwn(input?.metadata || {}, 'perceptualHashes')
      || Object.hasOwn(input?.metadata || {}, 'perceptualHashAlgorithm');
    this.db.prepare('DELETE FROM asset_fingerprints WHERE asset_id = ? AND content_hash <> ?').run(asset.id, String(asset.contentHash || ''));
    if (!explicit) return this.listAssetFingerprints(asset.id);
    this.db.prepare('DELETE FROM asset_fingerprints WHERE asset_id = ?').run(asset.id);
    if (input.clearFingerprints === true || !normalizeSha256(asset.contentHash)) {
      this.db.prepare('UPDATE assets SET perceptual_hash=NULL, perceptual_hash_algorithm=NULL WHERE id=?').run(asset.id);
      return [];
    }
    const normalized = normalizeFingerprintEntries(input, asset);
    const insert = this.db.prepare(`
      INSERT INTO asset_fingerprints(
        id, project_id, asset_id, content_hash, algorithm, frame_kind, frame_index,
        timestamp_ms, normalized_time, hash_hex,
        band_0, band_1, band_2, band_3, band_4, band_5, band_6, band_7, band_8,
        evidence_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of normalized.entries) {
      const bands = fingerprintBands(entry.hash);
      const id = `fp_${crypto.createHash('sha256').update(stableJson([
        asset.id, asset.contentHash, normalized.algorithm, entry.frameKind, entry.frameIndex,
      ])).digest('hex').slice(0, 32)}`;
      insert.run(
        id, asset.projectId, asset.id, asset.contentHash, normalized.algorithm,
        entry.frameKind, entry.frameIndex, entry.timestampMs, entry.normalizedTime, entry.hash,
        ...bands, JSON.stringify(entry.evidence || {}), now, now,
      );
    }
    const representative = normalized.entries[0]?.hash || null;
    this.db.prepare(`
      UPDATE assets SET perceptual_hash=?, perceptual_hash_algorithm=?, updated_at=? WHERE id=? AND content_hash=?
    `).run(representative, normalized.algorithm, now, asset.id, asset.contentHash);
    return this.listAssetFingerprints(asset.id);
  }

  listAssetFingerprints(assetId, algorithm = null) {
    const rows = algorithm
      ? this.db.prepare('SELECT * FROM asset_fingerprints WHERE asset_id = ? AND algorithm = ? ORDER BY frame_index, id').all(String(assetId), String(algorithm))
      : this.db.prepare('SELECT * FROM asset_fingerprints WHERE asset_id = ? ORDER BY algorithm, frame_index, id').all(String(assetId));
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      assetId: row.asset_id,
      contentHash: row.content_hash,
      algorithm: row.algorithm,
      frameKind: row.frame_kind,
      frameIndex: Number(row.frame_index) || 0,
      timestampMs: row.timestamp_ms == null ? null : Number(row.timestamp_ms),
      normalizedTime: row.normalized_time == null ? null : Number(row.normalized_time),
      hash: row.hash_hex,
      evidence: parseJson(row.evidence_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  upsertAsset(input) {
    const payload = input && typeof input === 'object' ? input : {};
    return this.db.transaction(() => {
      const now = Number(payload.updatedAt) || Date.now();
      const id = String(payload.id || crypto.randomUUID());
      const projectId = String(payload.projectId || DEFAULT_PROJECT_ID);
      const existingRow = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
      if (existingRow && existingRow.project_id !== projectId) throw new Error('assetId 已属于其他项目');
      const existing = existingRow ? this.hydrateAssetRows([existingRow])[0] : null;
      const entityUid = String(payload.entityUid || existing?.entityUid || stableEntityUuid(projectId, 'asset', id));
      const managedPath = Object.hasOwn(payload, 'managedPath') ? (payload.managedPath || null) : (existing?.managedPath || null);
      const sourceUrl = Object.hasOwn(payload, 'sourceUrl') ? (payload.sourceUrl || null) : (existing?.sourceUrl || null);
      const storageMode = normalizeAssetStorageMode(payload.storageMode || existing?.storageMode, managedPath, sourceUrl);
      const availability = normalizeAssetAvailability(payload.availability || existing?.availability, storageMode);
      const payloadMetadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : null;
      let metadata = payloadMetadata || (existing?.metadata || {});
      const provenance = payload.provenance && typeof payload.provenance === 'object' ? payload.provenance : (existing?.provenance || {});
      const rawHash = Object.hasOwn(payload, 'contentHash') ? payload.contentHash : existing?.contentHash;
      const contentHash = normalizeSha256(rawHash) || (rawHash ? String(rawHash).trim().toLowerCase() : null);
      const contentChanged = Boolean(existing && String(existing.contentHash || '') !== String(contentHash || ''));
      const hasFingerprintInput = payload.clearFingerprints === true
        || Object.hasOwn(payload, 'perceptualHashes')
        || Object.hasOwn(payload, 'fingerprints')
        || Object.hasOwn(payload, 'perceptualHash')
        || Object.hasOwn(payload, 'perceptualHashAlgorithm')
        || Object.hasOwn(payloadMetadata || {}, 'perceptualHashes')
        || Object.hasOwn(payloadMetadata || {}, 'perceptualHash')
        || Object.hasOwn(payloadMetadata || {}, 'fingerprints')
        || Object.hasOwn(payloadMetadata || {}, 'perceptualHashAlgorithm')
        || Object.hasOwn(payloadMetadata || {}, 'fingerprintAlgorithm');
      if (contentChanged && !hasFingerprintInput) {
        metadata = { ...metadata };
        delete metadata.perceptualHash;
        delete metadata.perceptualHashes;
        delete metadata.perceptualHashAlgorithm;
        delete metadata.fingerprints;
        delete metadata.fingerprintAlgorithm;
      }
      const normalizedFingerprints = hasFingerprintInput
        ? normalizeFingerprintEntries({ ...payload, metadata: payloadMetadata || {} }, {
            ...(existing || {}), kind: String(payload.kind || existing?.kind || 'other'), metadata,
          })
        : { algorithm: null, entries: [] };
      const perceptualHash = normalizedFingerprints.entries[0]?.hash
        || (!contentChanged && !hasFingerprintInput ? existing?.perceptualHash : null);
      const perceptualHashAlgorithm = normalizedFingerprints.algorithm
        || (!contentChanged && !hasFingerprintInput ? existing?.perceptualHashAlgorithm : null);
      const sourceLocator = opaqueSourceLocator(
        payload.sourceLocator || existing?.sourceLocator || sourceUrl || managedPath || `${projectId}:${id}`,
      );
      this.db.prepare(`
        INSERT INTO assets(
          id, project_id, entity_uid, content_hash, perceptual_hash, perceptual_hash_algorithm,
          organization_revision, source_locator, kind, mime_type, filename, managed_path, source_url,
          storage_mode, availability, metadata_json, provenance_json, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          entity_uid=COALESCE(assets.entity_uid, excluded.entity_uid),
          content_hash=excluded.content_hash,
          perceptual_hash=excluded.perceptual_hash,
          perceptual_hash_algorithm=excluded.perceptual_hash_algorithm,
          source_locator=COALESCE(excluded.source_locator, assets.source_locator),
          kind=excluded.kind,
          mime_type=excluded.mime_type,
          filename=excluded.filename,
          managed_path=excluded.managed_path,
          source_url=excluded.source_url,
          storage_mode=excluded.storage_mode,
          availability=excluded.availability,
          metadata_json=excluded.metadata_json,
          provenance_json=excluded.provenance_json,
          updated_at=excluded.updated_at
      `).run(
        id,
        projectId,
        entityUid,
        contentHash,
        perceptualHash,
        perceptualHashAlgorithm,
        sourceLocator,
        String(payload.kind || existing?.kind || 'other'),
        payload.mimeType ?? existing?.mimeType ?? null,
        String(payload.filename || existing?.filename || id),
        managedPath,
        sourceUrl,
        storageMode,
        availability,
        JSON.stringify(metadata),
        JSON.stringify(provenance),
        String(payload.createdBy || existing?.createdBy || 'local-owner'),
        Number(payload.createdAt) || existing?.createdAt || now,
        now,
      );
      let asset = this.getAsset(id);
      this._syncAssetBlobReference(asset, payload, now);
      this.db.prepare(`
        INSERT OR IGNORE INTO asset_access_policies(project_id, asset_id, scope, revision, updated_by, updated_at)
        VALUES (?, ?, 'project', 1, ?, ?)
      `).run(projectId, id, String(payload.createdBy || existing?.createdBy || 'local-owner'), now);
      if (contentChanged) {
        this.db.prepare('DELETE FROM asset_duplicate_candidates WHERE left_asset_id = ? OR right_asset_id = ?').run(id, id);
      }
      asset = this.getAsset(id);
      this._replaceAssetFingerprints(asset, contentChanged && !hasFingerprintInput ? { clearFingerprints: true } : payload, now);
      this._bumpAssetCatalogRevision(projectId, now);
      return this.getAsset(id);
    })();
  }

  getAsset(assetId) {
    const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(String(assetId));
    return row ? this.hydrateAssetRows([row])[0] : null;
  }

  hydrateAssetRows(rows = []) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const ids = rows.map((row) => String(row.id));
    const placeholders = ids.map(() => '?').join(',');
    const tagsByAsset = new Map();
    const collectionsByAsset = new Map();
    this.db.prepare(`SELECT asset_id, tag FROM asset_tags WHERE asset_id IN (${placeholders}) ORDER BY asset_id, tag`)
      .all(...ids)
      .forEach((item) => {
        const values = tagsByAsset.get(item.asset_id) || [];
        values.push(item.tag);
        tagsByAsset.set(item.asset_id, values);
      });
    this.db.prepare(`SELECT asset_id, collection_id FROM asset_collection_members WHERE asset_id IN (${placeholders}) ORDER BY asset_id, collection_id`)
      .all(...ids)
      .forEach((item) => {
        const values = collectionsByAsset.get(item.asset_id) || [];
        values.push(item.collection_id);
        collectionsByAsset.set(item.asset_id, values);
      });
    return rows.map((row) => ({
      id: row.id,
      entityUid: row.entity_uid || stableEntityUuid(row.project_id, 'asset', row.id),
      projectId: row.project_id,
      contentHash: row.content_hash,
      perceptualHash: row.perceptual_hash,
      perceptualHashAlgorithm: row.perceptual_hash_algorithm || null,
      organizationRevision: Math.max(1, Number(row.organization_revision) || 1),
      sourceLocator: row.source_locator || null,
      kind: row.kind,
      mimeType: row.mime_type,
      filename: row.filename,
      managedPath: row.managed_path,
      sourceUrl: row.source_url,
      storageMode: normalizeAssetStorageMode(row.storage_mode, row.managed_path, row.source_url),
      availability: normalizeAssetAvailability(row.availability, row.storage_mode),
      metadata: parseJson(row.metadata_json, {}),
      provenance: parseJson(row.provenance_json, {}),
      tags: tagsByAsset.get(row.id) || [],
      collectionIds: collectionsByAsset.get(row.id) || [],
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  _assetListQueryParts(filters = {}, accessSubject = null) {
    const projectId = String(filters.projectId || DEFAULT_PROJECT_ID);
    const query = String(filters.query || '').trim().toLowerCase();
    const clauses = ['a.project_id = ?'];
    const values = [projectId];
    if (Array.isArray(filters.assetIds)) {
      const assetIds = [...new Set(filters.assetIds
        .map((value) => String(value || '').trim())
        .filter(Boolean))].slice(0, MAX_ASSET_REFERENCES);
      if (assetIds.length === 0) clauses.push('0 = 1');
      else {
        clauses.push('a.id IN (SELECT value FROM json_each(?))');
        values.push(JSON.stringify(assetIds));
      }
    }
    if (filters.kind) { clauses.push('a.kind = ?'); values.push(String(filters.kind)); }
    if (filters.storageMode) { clauses.push('a.storage_mode = ?'); values.push(String(filters.storageMode)); }
    if (filters.availability) { clauses.push('a.availability = ?'); values.push(String(filters.availability)); }
    if (query) {
      const pattern = `%${escapeLikePattern(query)}%`;
      clauses.push(`(
        LOWER(a.filename || ' ' || a.metadata_json || ' ' || a.provenance_json) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM asset_semantic_profiles sp
          JOIN asset_semantic_documents sd
            ON sd.project_id = sp.project_id AND sd.generation = sp.active_generation
          WHERE sp.project_id = a.project_id AND sp.enabled = 1
            AND sd.asset_id = a.id AND sd.content_hash = a.content_hash
            AND ((sd.document_kind = 'caption' AND sp.caption_enabled = 1)
              OR (sd.document_kind = 'ocr' AND sp.ocr_enabled = 1))
            AND LOWER(sd.text) LIKE ? ESCAPE '\\'
        )
      )`);
      values.push(pattern, pattern);
    }
    if (filters.source) {
      clauses.push("LOWER(COALESCE(json_extract(a.provenance_json, '$.source'), json_extract(a.metadata_json, '$.source'), '')) = LOWER(?)");
      values.push(String(filters.source));
    }
    if (filters.tag) { clauses.push('EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id AND LOWER(t.tag) = LOWER(?))'); values.push(String(filters.tag)); }
    if (filters.collectionId) { clauses.push('EXISTS (SELECT 1 FROM asset_collection_members m WHERE m.asset_id = a.id AND m.collection_id = ?)'); values.push(String(filters.collectionId)); }
    if (accessSubject) {
      const permission = ASSET_ACCESS_PERMISSIONS.has(String(accessSubject.permission || '').toLowerCase())
        ? String(accessSubject.permission).toLowerCase()
        : 'view';
      const memberId = String(accessSubject.memberId || '');
      const role = String(accessSubject.role || '').toLowerCase();
      if (role !== 'owner') {
        const projectDefault = permission === 'view' || permission === 'preview'
          || (permission === 'original' && ['editor', 'reviewer'].includes(role))
          || (permission === 'organize' && role === 'editor');
        const principalClauses = [];
        const principalValues = [];
        if (memberId) {
          principalClauses.push("(g.principal_type = 'member' AND g.principal_id = ?)");
          principalValues.push(memberId);
        }
        if (role) {
          principalClauses.push("(g.principal_type = 'role' AND LOWER(g.principal_id) = ?)");
          principalValues.push(role);
        }
        const granted = principalClauses.length
          ? `EXISTS (
              SELECT 1 FROM asset_access_grants g
              WHERE g.project_id = a.project_id AND g.asset_id = a.id
                AND g.permission = ? AND (${principalClauses.join(' OR ')})
            )`
          : '0';
        clauses.push(`(
          (${projectDefault ? '1' : '0'} = 1 AND COALESCE((
            SELECT p.scope FROM asset_access_policies p
            WHERE p.project_id = a.project_id AND p.asset_id = a.id
          ), 'project') = 'project') OR ${granted}
        )`);
        if (principalClauses.length) values.push(permission, ...principalValues);
      }
    }
    const sortMap = {
      'created-desc': 'a.created_at DESC, a.id DESC',
      'created-asc': 'a.created_at ASC, a.id ASC',
      'updated-desc': 'a.updated_at DESC, a.id DESC',
      'updated-asc': 'a.updated_at ASC, a.id ASC',
      'name-asc': 'LOWER(a.filename) ASC, a.id ASC',
      'name-desc': 'LOWER(a.filename) DESC, a.id DESC',
      'size-desc': "COALESCE(CAST(json_extract(a.metadata_json, '$.size') AS INTEGER), 0) DESC, a.id DESC",
      'size-asc': "COALESCE(CAST(json_extract(a.metadata_json, '$.size') AS INTEGER), 0) ASC, a.id ASC",
    };
    return { projectId, clauses, values, orderBy: sortMap[String(filters.sort || '')] || sortMap['created-desc'] };
  }

  listAssets(filters = {}) {
    const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
    const offset = Math.max(0, Number(filters.offset) || 0);
    const { clauses, values, orderBy } = this._assetListQueryParts(filters);
    const rows = this.db.prepare(`SELECT a.* FROM assets a WHERE ${clauses.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...values, limit, offset);
    return this.hydrateAssetRows(rows);
  }

  countAssets(filters = {}) {
    const { clauses, values } = this._assetListQueryParts(filters);
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM assets a WHERE ${clauses.join(' AND ')}`).get(...values).count);
  }

  mapAssetSemanticModel(row) {
    if (!row) return null;
    return {
      modelKey: row.model_key,
      modelVersion: row.model_version,
      capability: normalizeSemanticCapability(row.capability),
      status: ASSET_SEMANTIC_MODEL_STATUSES.has(row.status) ? row.status : 'failed',
      revision: Math.max(1, Number(row.revision) || 1),
      artifactDigest: row.artifact_digest || null,
      byteSize: row.byte_size == null ? null : Math.max(0, Number(row.byte_size) || 0),
      downloadedBytes: Math.max(0, Number(row.downloaded_bytes) || 0),
      totalBytes: row.total_bytes == null ? null : Math.max(0, Number(row.total_bytes) || 0),
      installPath: row.install_path || null,
      errorCode: row.error_code || null,
      errorMessage: row.error_message || null,
      installedAt: row.installed_at == null ? null : Number(row.installed_at),
      downloadIdempotencyKey: row.download_idempotency_key || null,
      downloadRequestRevision: row.download_request_revision == null ? null : Number(row.download_request_revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  getAssetSemanticModel(modelKey, modelVersion) {
    const key = normalizeSemanticIdentity(modelKey, 'modelKey');
    const version = normalizeSemanticIdentity(modelVersion, 'modelVersion');
    return this.mapAssetSemanticModel(this.db.prepare(`
      SELECT * FROM asset_semantic_models WHERE model_key = ? AND model_version = ?
    `).get(key, version));
  }

  listAssetSemanticModels(filters = {}) {
    const clauses = [];
    const values = [];
    if (filters.capability) { clauses.push('capability = ?'); values.push(normalizeSemanticCapability(filters.capability)); }
    if (filters.status) {
      const status = String(filters.status || '').trim().toLowerCase();
      if (!ASSET_SEMANTIC_MODEL_STATUSES.has(status)) throw new Error('语义模型状态无效');
      clauses.push('status = ?');
      values.push(status);
    }
    return this.db.prepare(`
      SELECT * FROM asset_semantic_models
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY capability, model_key, model_version
    `).all(...values).map((row) => this.mapAssetSemanticModel(row));
  }

  getAssetSemanticModelInUse(modelKey, modelVersion) {
    const key = normalizeSemanticIdentity(modelKey, 'modelKey');
    const version = normalizeSemanticIdentity(modelVersion, 'modelVersion');
    const building = this.db.prepare(`
      SELECT g.project_id, g.generation FROM asset_semantic_generations g
      JOIN asset_semantic_profiles p
        ON p.project_id = g.project_id AND p.building_generation = g.generation
      WHERE g.status IN ('building', 'ready') AND (
        (json_extract(g.profile_snapshot_json, '$.caption.enabled') = 1
          AND json_extract(g.profile_snapshot_json, '$.caption.modelKey') = ?
          AND json_extract(g.profile_snapshot_json, '$.caption.modelVersion') = ?)
        OR (json_extract(g.profile_snapshot_json, '$.ocr.enabled') = 1
          AND json_extract(g.profile_snapshot_json, '$.ocr.modelKey') = ?
          AND json_extract(g.profile_snapshot_json, '$.ocr.modelVersion') = ?)
        OR (json_extract(g.profile_snapshot_json, '$.embedding.enabled') = 1
          AND json_extract(g.profile_snapshot_json, '$.embedding.modelKey') = ?
          AND json_extract(g.profile_snapshot_json, '$.embedding.modelVersion') = ?)
      )
      ORDER BY g.project_id, g.generation LIMIT 20
    `).all(key, version, key, version, key, version);
    const pendingJobs = this.db.prepare(`
      SELECT project_id, generation, id, status FROM asset_semantic_jobs
      WHERE model_key = ? AND model_version = ?
        AND status IN ('queued', 'running', 'retrying')
      ORDER BY project_id, generation, id LIMIT 20
    `).all(key, version);
    return {
      inUse: building.length > 0 || pendingJobs.length > 0,
      building: building.map((row) => ({ projectId: row.project_id, generation: Number(row.generation) })),
      pendingJobs: pendingJobs.map((row) => ({
        projectId: row.project_id,
        generation: Number(row.generation),
        jobId: row.id,
        status: row.status,
      })),
    };
  }

  beginAssetSemanticModelDelete(modelKey, modelVersion, input = {}) {
    const key = normalizeSemanticIdentity(modelKey, 'modelKey');
    const version = normalizeSemanticIdentity(modelVersion, 'modelVersion');
    const expectedRevision = Math.trunc(Number(input.expectedRevision));
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('删除语义模型必须提供 expectedRevision');
    }
    const now = Number(input.now) || Date.now();
    const run = this.db.transaction(() => {
      const existing = this.getAssetSemanticModel(key, version);
      if (!existing || existing.revision !== expectedRevision) {
        throw revisionConflict('asset_semantic_model_revision_conflict', '语义模型状态版本冲突', existing);
      }
      if (existing.status === 'deleting') {
        const error = new Error('语义模型正在删除');
        error.code = 'asset_semantic_model_delete_in_progress';
        error.current = existing;
        throw error;
      }
      const usage = this.getAssetSemanticModelInUse(key, version);
      if (usage.inUse) {
        const error = new Error('模型正被语义索引重建使用，完成或终止重建后才能删除');
        error.code = 'asset_semantic_model_in_use';
        error.current = {
          revision: existing.revision,
          projectId: usage.building[0]?.projectId || usage.pendingJobs[0]?.projectId || '',
          generation: usage.building[0]?.generation || usage.pendingJobs[0]?.generation || 0,
        };
        throw error;
      }
      const changed = this.db.prepare(`
        UPDATE asset_semantic_models SET status = 'deleting', revision = revision + 1,
          error_code = NULL, error_message = NULL, updated_at = ?
        WHERE model_key = ? AND model_version = ? AND revision = ? AND status <> 'deleting'
      `).run(now, key, version, expectedRevision);
      if (changed.changes !== 1) {
        throw revisionConflict('asset_semantic_model_revision_conflict', '语义模型状态版本冲突', this.getAssetSemanticModel(key, version));
      }
      return this.getAssetSemanticModel(key, version);
    });
    return run.immediate();
  }

  setAssetSemanticModelState(input = {}, options = {}) {
    const modelKey = normalizeSemanticIdentity(input.modelKey, 'modelKey');
    const modelVersion = normalizeSemanticIdentity(input.modelVersion, 'modelVersion');
    const capability = normalizeSemanticCapability(input.capability);
    const status = String(input.status || '').trim().toLowerCase();
    if (!ASSET_SEMANTIC_MODEL_STATUSES.has(status)) throw new Error('语义模型状态无效');
    const expectedRevisionValue = options.expectedRevision ?? input.expectedRevision;
    const expectedRevision = Math.trunc(Number(expectedRevisionValue));
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error('更新语义模型状态必须提供 expectedRevision');
    const now = Number(options.now ?? input.updatedAt) || Date.now();
    const run = this.db.transaction(() => {
      const existing = this.getAssetSemanticModel(modelKey, modelVersion);
      if ((existing?.revision || 0) !== expectedRevision) {
        throw revisionConflict('asset_semantic_model_revision_conflict', '语义模型状态版本冲突', existing);
      }
      if (existing?.status === 'deleting' && ['downloading', 'verifying'].includes(status)) {
        const error = new Error('语义模型正在删除，不能启动下载或校验');
        error.code = 'asset_semantic_model_delete_in_progress';
        error.current = existing;
        throw error;
      }
      if (existing && existing.capability !== capability) throw new Error('语义模型 capability 不可变');
      const absent = status === 'not-installed';
      const artifactDigest = absent
        ? null
        : (Object.hasOwn(input, 'artifactDigest')
            ? (input.artifactDigest ? normalizeSemanticIdentity(input.artifactDigest, 'artifactDigest', 256) : null)
            : existing?.artifactDigest || null);
      const byteSizeValue = Object.hasOwn(input, 'byteSize') ? Number(input.byteSize) : existing?.byteSize;
      const byteSize = absent || byteSizeValue == null ? null : Math.max(0, Math.trunc(byteSizeValue));
      if (byteSizeValue != null && (!Number.isFinite(Number(byteSizeValue)) || Number(byteSizeValue) < 0)) throw new Error('模型 byteSize 无效');
      const downloadedValue = absent ? 0 : (Object.hasOwn(input, 'downloadedBytes') ? Number(input.downloadedBytes) : existing?.downloadedBytes || 0);
      const totalValue = absent ? null : (Object.hasOwn(input, 'totalBytes') ? input.totalBytes : existing?.totalBytes);
      const downloadedBytes = Math.max(0, Math.trunc(Number(downloadedValue) || 0));
      const totalBytes = totalValue == null ? null : Math.max(0, Math.trunc(Number(totalValue) || 0));
      if (!Number.isFinite(Number(downloadedValue)) || Number(downloadedValue) < 0
        || (totalValue != null && (!Number.isFinite(Number(totalValue)) || Number(totalValue) < 0))) {
        throw new Error('模型下载字节数无效');
      }
      if (totalBytes != null && downloadedBytes > totalBytes) throw new Error('模型 downloadedBytes 不能超过 totalBytes');
      const installPath = absent
        ? null
        : (Object.hasOwn(input, 'installPath')
            ? (input.installPath ? normalizeSemanticIdentity(input.installPath, 'installPath', 4096) : null)
            : existing?.installPath || null);
      const hasError = status === 'failed';
      const errorCode = hasError ? String(input.error?.code || input.errorCode || 'semantic-model-failed').trim().slice(0, 120) : null;
      const errorMessage = hasError ? String(input.error?.message || input.errorMessage || '语义模型操作失败').trim().slice(0, 600) : null;
      const installedAt = status === 'installed'
        ? Math.max(1, Number(input.installedAt || existing?.installedAt || now))
        : (absent ? null : existing?.installedAt || null);
      const downloadIdempotencyKey = Object.hasOwn(input, 'downloadIdempotencyKey')
        ? (input.downloadIdempotencyKey == null || input.downloadIdempotencyKey === ''
            ? null
            : normalizeSemanticIdentity(input.downloadIdempotencyKey, 'downloadIdempotencyKey', 160))
        : existing?.downloadIdempotencyKey || null;
      const downloadRequestRevisionValue = Object.hasOwn(input, 'downloadRequestRevision')
        ? input.downloadRequestRevision
        : existing?.downloadRequestRevision;
      const downloadRequestRevision = downloadRequestRevisionValue == null
        ? null
        : Math.trunc(Number(downloadRequestRevisionValue));
      if ((downloadIdempotencyKey == null) !== (downloadRequestRevision == null)
        || (downloadRequestRevision != null && (!Number.isInteger(downloadRequestRevision) || downloadRequestRevision < 1))) {
        throw new Error('模型下载幂等身份无效');
      }
      if (!existing) {
        this.db.prepare(`
          INSERT INTO asset_semantic_models(
            model_key, model_version, capability, status, revision, artifact_digest, byte_size,
            downloaded_bytes, total_bytes, install_path, error_code, error_message, installed_at,
            download_idempotency_key, download_request_revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          modelKey, modelVersion, capability, status, artifactDigest, byteSize,
          downloadedBytes, totalBytes, installPath, errorCode, errorMessage, installedAt,
          downloadIdempotencyKey, downloadRequestRevision, now, now,
        );
      } else {
        const changed = this.db.prepare(`
          UPDATE asset_semantic_models SET status = ?, revision = revision + 1,
            artifact_digest = ?, byte_size = ?, downloaded_bytes = ?, total_bytes = ?, install_path = ?,
            error_code = ?, error_message = ?, installed_at = ?, download_idempotency_key = ?,
            download_request_revision = ?, updated_at = ?
          WHERE model_key = ? AND model_version = ? AND revision = ?
        `).run(
          status, artifactDigest, byteSize, downloadedBytes, totalBytes, installPath,
          errorCode, errorMessage, installedAt, downloadIdempotencyKey, downloadRequestRevision,
          now, modelKey, modelVersion, expectedRevision,
        );
        if (changed.changes !== 1) {
          throw revisionConflict('asset_semantic_model_revision_conflict', '语义模型状态版本冲突', this.getAssetSemanticModel(modelKey, modelVersion));
        }
      }
      return this.getAssetSemanticModel(modelKey, modelVersion);
    });
    return run.immediate();
  }

  mapAssetSemanticProfile(row, projectId = DEFAULT_PROJECT_ID) {
    if (!row) {
      return {
        projectId: String(projectId || DEFAULT_PROJECT_ID),
        revision: 0,
        enabled: false,
        caption: { enabled: false, modelKey: null, modelVersion: null },
        ocr: { enabled: false, modelKey: null, modelVersion: null },
        embedding: { enabled: false, modelKey: null, modelVersion: null },
        activeGeneration: null,
        buildingGeneration: null,
        updatedBy: null,
        updatedAt: 0,
      };
    }
    return {
      projectId: row.project_id,
      revision: Math.max(1, Number(row.revision) || 1),
      enabled: Boolean(row.enabled),
      caption: {
        enabled: Boolean(row.caption_enabled),
        modelKey: row.caption_model_key || null,
        modelVersion: row.caption_model_version || null,
      },
      ocr: {
        enabled: Boolean(row.ocr_enabled),
        modelKey: row.ocr_model_key || null,
        modelVersion: row.ocr_model_version || null,
      },
      embedding: {
        enabled: Boolean(row.embedding_enabled),
        modelKey: row.embedding_model_key || null,
        modelVersion: row.embedding_model_version || null,
      },
      activeGeneration: row.active_generation == null ? null : Number(row.active_generation),
      buildingGeneration: row.building_generation == null ? null : Number(row.building_generation),
      updatedBy: row.updated_by,
      updatedAt: Number(row.updated_at),
    };
  }

  getAssetSemanticProfile(projectId = DEFAULT_PROJECT_ID) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    return this.mapAssetSemanticProfile(this.db.prepare(`
      SELECT * FROM asset_semantic_profiles WHERE project_id = ?
    `).get(normalizedProjectId), normalizedProjectId);
  }

  _semanticCapabilityPatch(current, patch, name) {
    const nested = patch?.[name] && typeof patch[name] === 'object' ? patch[name] : {};
    const enabledKey = `${name}Enabled`;
    const modelKeyKey = `${name}ModelKey`;
    const modelVersionKey = `${name}ModelVersion`;
    const enabled = Object.hasOwn(nested, 'enabled')
      ? Boolean(nested.enabled)
      : (Object.hasOwn(patch, enabledKey) ? Boolean(patch[enabledKey]) : Boolean(current.enabled));
    const rawModelKey = Object.hasOwn(nested, 'modelKey')
      ? nested.modelKey
      : (Object.hasOwn(patch, modelKeyKey) ? patch[modelKeyKey] : current.modelKey);
    const rawModelVersion = Object.hasOwn(nested, 'modelVersion')
      ? nested.modelVersion
      : (Object.hasOwn(patch, modelVersionKey) ? patch[modelVersionKey] : current.modelVersion);
    const modelKey = rawModelKey == null || rawModelKey === '' ? null : normalizeSemanticIdentity(rawModelKey, `${name}.modelKey`);
    const modelVersion = rawModelVersion == null || rawModelVersion === '' ? null : normalizeSemanticIdentity(rawModelVersion, `${name}.modelVersion`);
    if (Boolean(modelKey) !== Boolean(modelVersion)) throw new Error(`${name} 模型身份必须同时包含 modelKey 和 modelVersion`);
    if (enabled && !modelKey) throw new Error(`${name} 已启用但未选择固定模型版本`);
    if (modelKey) {
      const model = this.getAssetSemanticModel(modelKey, modelVersion);
      if (!model || model.capability !== name) throw new Error(`${name} 模型身份不存在或 capability 不匹配`);
    }
    return { enabled, modelKey, modelVersion };
  }

  setAssetSemanticProfile(projectId = DEFAULT_PROJECT_ID, patch = {}, options = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const expectedRevisionValue = options.expectedRevision ?? patch.expectedRevision;
    const expectedRevision = Math.trunc(Number(expectedRevisionValue));
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error('更新语义配置必须提供 expectedRevision');
    const updatedBy = String(options.updatedBy || patch.updatedBy || 'local-owner').trim().slice(0, 240) || 'local-owner';
    const now = Number(options.now) || Date.now();
    const run = this.db.transaction(() => {
      const current = this.getAssetSemanticProfile(normalizedProjectId);
      if (current.revision !== expectedRevision) {
        throw revisionConflict('asset_semantic_profile_revision_conflict', '语义配置版本冲突', current);
      }
      const next = {
        projectId: normalizedProjectId,
        enabled: Object.hasOwn(patch, 'enabled') ? Boolean(patch.enabled) : current.enabled,
        caption: this._semanticCapabilityPatch(current.caption, patch, 'caption'),
        ocr: this._semanticCapabilityPatch(current.ocr, patch, 'ocr'),
        embedding: this._semanticCapabilityPatch(current.embedding, patch, 'embedding'),
        activeGeneration: current.activeGeneration,
        buildingGeneration: current.buildingGeneration,
      };
      const capabilityUnchanged = (name) => Boolean(current[name]?.enabled) === Boolean(next[name]?.enabled)
        && (current[name]?.modelKey || null) === (next[name]?.modelKey || null)
        && (current[name]?.modelVersion || null) === (next[name]?.modelVersion || null);
      if (Boolean(current.enabled) === Boolean(next.enabled)
        && capabilityUnchanged('caption')
        && capabilityUnchanged('ocr')
        && capabilityUnchanged('embedding')) {
        return current;
      }
      if (current.revision === 0) {
        this.db.prepare(`
          INSERT INTO asset_semantic_profiles(
            project_id, revision, enabled,
            caption_enabled, caption_model_key, caption_model_version,
            ocr_enabled, ocr_model_key, ocr_model_version,
            embedding_enabled, embedding_model_key, embedding_model_version,
            active_generation, building_generation, updated_by, created_at, updated_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
        `).run(
          normalizedProjectId, next.enabled ? 1 : 0,
          next.caption.enabled ? 1 : 0, next.caption.modelKey, next.caption.modelVersion,
          next.ocr.enabled ? 1 : 0, next.ocr.modelKey, next.ocr.modelVersion,
          next.embedding.enabled ? 1 : 0, next.embedding.modelKey, next.embedding.modelVersion,
          updatedBy, now, now,
        );
      } else {
        const changed = this.db.prepare(`
          UPDATE asset_semantic_profiles SET revision = revision + 1, enabled = ?,
            caption_enabled = ?, caption_model_key = ?, caption_model_version = ?,
            ocr_enabled = ?, ocr_model_key = ?, ocr_model_version = ?,
            embedding_enabled = ?, embedding_model_key = ?, embedding_model_version = ?,
            updated_by = ?, updated_at = ?
          WHERE project_id = ? AND revision = ?
        `).run(
          next.enabled ? 1 : 0,
          next.caption.enabled ? 1 : 0, next.caption.modelKey, next.caption.modelVersion,
          next.ocr.enabled ? 1 : 0, next.ocr.modelKey, next.ocr.modelVersion,
          next.embedding.enabled ? 1 : 0, next.embedding.modelKey, next.embedding.modelVersion,
          updatedBy, now, normalizedProjectId, expectedRevision,
        );
        if (changed.changes !== 1) {
          throw revisionConflict('asset_semantic_profile_revision_conflict', '语义配置版本冲突', this.getAssetSemanticProfile(normalizedProjectId));
        }
      }
      this._bumpAssetCatalogRevision(normalizedProjectId, now);
      return this.getAssetSemanticProfile(normalizedProjectId);
    });
    return run.immediate();
  }

  _assertSemanticProfileModels(profile, options = {}) {
    const enabledCapabilities = [];
    if (!profile.enabled) return enabledCapabilities;
    for (const capability of ASSET_SEMANTIC_CAPABILITIES) {
      const config = profile[capability];
      if (!config?.enabled) continue;
      const model = config.modelKey && config.modelVersion
        ? this.getAssetSemanticModel(config.modelKey, config.modelVersion)
        : null;
      if (!model || model.capability !== capability) throw new Error(`${capability} 模型身份无效`);
      if (options.requireInstalled && model.status !== 'installed') {
        const error = new Error(`${capability} 模型尚未安装并校验`);
        error.code = 'asset_semantic_model_not_installed';
        error.current = model;
        throw error;
      }
      enabledCapabilities.push({ capability, model });
    }
    return enabledCapabilities;
  }

  _assetSemanticGenerationCounts(projectId, generation) {
    const counts = { queued: 0, running: 0, retrying: 0, succeeded: 0, skipped: 0, failed: 0, superseded: 0, total: 0 };
    this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM asset_semantic_jobs
      WHERE project_id = ? AND generation = ? GROUP BY status
    `).all(String(projectId), Number(generation)).forEach((row) => {
      if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.count) || 0;
    });
    counts.total = Object.entries(counts).filter(([key]) => key !== 'total').reduce((sum, [, value]) => sum + value, 0);
    return counts;
  }

  mapAssetSemanticGeneration(row) {
    if (!row) return null;
    return {
      projectId: row.project_id,
      generation: Number(row.generation),
      revision: Math.max(1, Number(row.revision) || 1),
      catalogRevision: Math.max(1, Number(row.catalog_revision) || 1),
      profileRevision: Math.max(1, Number(row.profile_revision) || 1),
      profileDigest: row.profile_digest,
      profileSnapshot: parseJson(row.profile_snapshot_json, {}),
      idempotencyKey: row.idempotency_key || null,
      jobsSealed: Number(row.jobs_sealed) === 1,
      expectedJobCount: Math.max(0, Number(row.expected_job_count) || 0),
      eligibleAssetCount: Math.max(0, Number(row.eligible_asset_count) || 0),
      excludedAssetCount: Math.max(0, Number(row.excluded_asset_count) || 0),
      payloadPrunedAt: row.payload_pruned_at == null ? null : Number(row.payload_pruned_at),
      status: ASSET_SEMANTIC_GENERATION_STATUSES.has(row.status) ? row.status : 'failed',
      counts: this._assetSemanticGenerationCounts(row.project_id, row.generation),
      errorCode: row.error_code || null,
      errorMessage: row.error_message || null,
      createdBy: row.created_by,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    };
  }

  getAssetSemanticGeneration(projectId, generation) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const normalizedGeneration = Math.max(1, Math.trunc(Number(generation) || 0));
    return this.mapAssetSemanticGeneration(this.db.prepare(`
      SELECT * FROM asset_semantic_generations WHERE project_id = ? AND generation = ?
    `).get(normalizedProjectId, normalizedGeneration));
  }

  getAssetSemanticGenerationByIdempotencyKey(projectId, idempotencyKey) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const normalizedKey = String(idempotencyKey || '').normalize('NFKC').trim().slice(0, 160);
    if (!normalizedKey) return null;
    return this.mapAssetSemanticGeneration(this.db.prepare(`
      SELECT * FROM asset_semantic_generations WHERE project_id = ? AND idempotency_key = ?
    `).get(normalizedProjectId, normalizedKey));
  }

  listAssetSemanticGenerations(projectId = DEFAULT_PROJECT_ID, options = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(options.limit) || 20)));
    return this.db.prepare(`
      SELECT * FROM asset_semantic_generations WHERE project_id = ?
      ORDER BY generation DESC LIMIT ?
    `).all(normalizedProjectId, limit).map((row) => this.mapAssetSemanticGeneration(row));
  }

  listBuildingAssetSemanticGenerations(options = {}) {
    const limit = Math.min(1_000, Math.max(1, Math.trunc(Number(options.limit) || 200)));
    return this.db.prepare(`
      SELECT g.* FROM asset_semantic_generations g
      JOIN asset_semantic_profiles p
        ON p.project_id = g.project_id AND p.building_generation = g.generation
      WHERE g.status IN ('building', 'ready')
      ORDER BY g.project_id, g.generation LIMIT ?
    `).all(limit).map((row) => this.mapAssetSemanticGeneration(row));
  }

  pruneAssetSemanticGenerationPayloads(projectId = null, options = {}) {
    const normalizedProjectId = projectId == null || projectId === ''
      ? null
      : String(projectId);
    const limitGenerations = Math.min(4, Math.max(1, Math.trunc(Number(options.limitGenerations) || 2)));
    const now = Number(options.now) || Date.now();
    const run = this.db.transaction(() => {
      const params = [];
      const projectFilter = normalizedProjectId == null ? '' : 'AND g.project_id = ?';
      if (normalizedProjectId != null) params.push(normalizedProjectId);
      const rows = this.db.prepare(`
        SELECT g.*, p.active_generation, p.building_generation,
          COALESCE(c.revision, 1) AS current_catalog_revision,
          (SELECT MAX(latest.generation)
             FROM asset_semantic_generations latest
            WHERE latest.project_id = g.project_id) AS latest_generation,
          (SELECT MAX(rollback.generation)
             FROM asset_semantic_generations rollback
            WHERE rollback.project_id = g.project_id
              AND rollback.status = 'superseded'
              AND rollback.error_code IS NULL) AS rollback_generation,
          EXISTS(
            SELECT 1 FROM asset_semantic_jobs retry_job
             WHERE retry_job.project_id = g.project_id
               AND retry_job.generation = g.generation
               AND retry_job.status = 'failed'
          ) AS has_failed_job
        FROM asset_semantic_generations g
        JOIN asset_semantic_profiles p ON p.project_id = g.project_id
        LEFT JOIN asset_catalog_revisions c ON c.project_id = g.project_id
        WHERE g.status IN ('failed', 'superseded')
          ${projectFilter}
          AND (p.active_generation IS NULL OR p.active_generation <> g.generation)
          AND (p.building_generation IS NULL OR p.building_generation <> g.generation)
          AND NOT EXISTS(
            SELECT 1 FROM asset_semantic_jobs pending
             WHERE pending.project_id = g.project_id
               AND pending.generation = g.generation
               AND pending.status IN ('queued', 'running', 'retrying')
          )
          AND (
            EXISTS(SELECT 1 FROM asset_semantic_jobs j WHERE j.project_id = g.project_id AND j.generation = g.generation)
            OR EXISTS(SELECT 1 FROM asset_semantic_documents d WHERE d.project_id = g.project_id AND d.generation = g.generation)
            OR EXISTS(SELECT 1 FROM asset_semantic_embeddings e WHERE e.project_id = g.project_id AND e.generation = g.generation)
          )
        ORDER BY g.updated_at, g.project_id, g.generation
      `).all(...params);
      const profileDigestByProject = new Map();
      const prunable = [];
      for (const row of rows) {
        const isRollback = row.status === 'superseded'
          && row.error_code == null
          && Number(row.generation) === Number(row.rollback_generation);
        if (isRollback) continue;
        let currentProfileDigest = profileDigestByProject.get(row.project_id);
        if (!currentProfileDigest) {
          currentProfileDigest = semanticProfileDigest(this.getAssetSemanticProfile(row.project_id));
          profileDigestByProject.set(row.project_id, currentProfileDigest);
        }
        const isRetryableLatestFailure = row.status === 'failed'
          && Number(row.jobs_sealed) === 1
          && row.building_generation == null
          && Number(row.generation) === Number(row.latest_generation)
          && row.profile_digest === currentProfileDigest
          && Number(row.catalog_revision) === Number(row.current_catalog_revision)
          && Number(row.has_failed_job) === 1;
        if (!isRetryableLatestFailure) prunable.push(row);
      }

      const selected = prunable.slice(0, limitGenerations);
      const deleted = [];
      const deleteDocuments = this.db.prepare(`
        DELETE FROM asset_semantic_documents WHERE project_id = ? AND generation = ?
      `);
      const deleteEmbeddings = this.db.prepare(`
        DELETE FROM asset_semantic_embeddings WHERE project_id = ? AND generation = ?
      `);
      const deleteJobs = this.db.prepare(`
        DELETE FROM asset_semantic_jobs WHERE project_id = ? AND generation = ?
      `);
      const markPruned = this.db.prepare(`
        UPDATE asset_semantic_generations
           SET payload_pruned_at = ?, revision = revision + 1, updated_at = ?
         WHERE project_id = ? AND generation = ?
           AND status IN ('failed', 'superseded')
      `);
      for (const row of selected) {
        const documents = deleteDocuments.run(row.project_id, row.generation).changes;
        const embeddings = deleteEmbeddings.run(row.project_id, row.generation).changes;
        const jobs = deleteJobs.run(row.project_id, row.generation).changes;
        const marked = markPruned.run(now, now, row.project_id, row.generation);
        if (marked.changes !== 1) {
          throw revisionConflict(
            'asset_semantic_generation_conflict',
            '语义索引历史载荷回收时代次状态已变化',
            this.getAssetSemanticGeneration(row.project_id, row.generation),
          );
        }
        deleted.push({
          projectId: row.project_id,
          generation: Number(row.generation),
          jobs,
          documents,
          embeddings,
        });
      }
      return {
        prunedGenerationCount: deleted.length,
        prunedGenerations: deleted,
        deletedJobs: deleted.reduce((sum, entry) => sum + entry.jobs, 0),
        deletedDocuments: deleted.reduce((sum, entry) => sum + entry.documents, 0),
        deletedEmbeddings: deleted.reduce((sum, entry) => sum + entry.embeddings, 0),
        hasMore: prunable.length > selected.length,
      };
    });
    return run.immediate();
  }

  beginAssetSemanticRebuild(projectId = DEFAULT_PROJECT_ID, input = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const expectedProfileRevision = Math.trunc(Number(input.expectedProfileRevision));
    if (!Number.isInteger(expectedProfileRevision) || expectedProfileRevision < 1) {
      throw new Error('开始语义重建必须提供 expectedProfileRevision');
    }
    const now = Number(input.now) || Date.now();
    const createdBy = String(input.createdBy || 'local-owner').trim().slice(0, 240) || 'local-owner';
    const idempotencyKey = String(input.idempotencyKey || '').normalize('NFKC').trim().slice(0, 160) || null;
    const enrollAssets = input.enrollAssets === true;
    const maximumAssets = Math.max(0, Math.trunc(Number(input.maximumAssets) || 50_000));
    const maxAttempts = Math.max(1, Math.min(5, Math.trunc(Number(input.maxAttempts) || 3)));
    const run = this.db.transaction(() => {
      if (idempotencyKey) {
        const existing = this.getAssetSemanticGenerationByIdempotencyKey(normalizedProjectId, idempotencyKey);
        if (existing) {
          if (existing.profileRevision !== expectedProfileRevision) {
            throw revisionConflict('asset_semantic_idempotency_conflict', '语义重建幂等键已绑定其他配置 revision', existing);
          }
          return { ...existing, idempotent: true };
        }
      }
      const profile = this.getAssetSemanticProfile(normalizedProjectId);
      if (profile.revision !== expectedProfileRevision) {
        throw revisionConflict('asset_semantic_profile_revision_conflict', '语义配置版本冲突', profile);
      }
      const enabled = this._assertSemanticProfileModels(profile, { requireInstalled: true });
      if (!profile.enabled || !enabled.length) throw new Error('至少启用并安装一个语义能力后才能重建索引');
      if (profile.buildingGeneration != null) {
        if (input.supersedeBuilding !== true) {
          throw revisionConflict('asset_semantic_rebuild_in_progress', '已有语义索引正在重建', this.getAssetSemanticGeneration(normalizedProjectId, profile.buildingGeneration));
        }
        const reason = String(input.reason || '新的重建已取代旧代次').slice(0, 600);
        this.db.prepare(`
          UPDATE asset_semantic_jobs SET status = 'superseded', revision = revision + 1, claim_token = NULL,
            next_attempt_at = NULL, error_code = 'semantic-rebuild-superseded', error_message = ?,
            updated_at = ?, finished_at = ?
          WHERE project_id = ? AND generation = ? AND status IN ('queued', 'retrying')
        `).run(reason, now, now, normalizedProjectId, profile.buildingGeneration);
        this.db.prepare(`
          UPDATE asset_semantic_generations SET status = 'superseded', revision = revision + 1,
            error_code = 'semantic-rebuild-superseded', error_message = ?, updated_at = ?, finished_at = ?
          WHERE project_id = ? AND generation = ? AND status = 'building'
        `).run(reason, now, now, normalizedProjectId, profile.buildingGeneration);
      }
      const generation = Number(this.db.prepare(`
        SELECT COALESCE(MAX(generation), 0) + 1 AS generation
        FROM asset_semantic_generations WHERE project_id = ?
      `).get(normalizedProjectId).generation);
      const snapshot = semanticProfileConfig(profile);
      const digest = semanticProfileDigest(snapshot);
      const catalogRevision = this.getAssetCatalogRevision(normalizedProjectId);
      this.db.prepare(`
        INSERT INTO asset_semantic_generations(
          project_id, generation, revision, catalog_revision, profile_revision, profile_digest,
          profile_snapshot_json, idempotency_key, jobs_sealed, expected_job_count,
          eligible_asset_count, excluded_asset_count,
          status, error_code, error_message,
          created_by, created_at, updated_at, finished_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'building', NULL, NULL, ?, ?, ?, NULL)
      `).run(
        normalizedProjectId, generation, catalogRevision, profile.revision, digest,
        JSON.stringify(snapshot), idempotencyKey, createdBy, now, now,
      );
      const changed = this.db.prepare(`
        UPDATE asset_semantic_profiles SET building_generation = ?, revision = revision + 1,
          updated_by = ?, updated_at = ? WHERE project_id = ? AND revision = ?
      `).run(generation, createdBy, now, normalizedProjectId, expectedProfileRevision);
      if (changed.changes !== 1) {
        throw revisionConflict('asset_semantic_profile_revision_conflict', '语义配置版本冲突', this.getAssetSemanticProfile(normalizedProjectId));
      }
      if (enrollAssets) {
        const assetTotal = Number(this.db.prepare(`
          SELECT COUNT(*) AS count FROM assets WHERE project_id = ?
        `).get(normalizedProjectId).count) || 0;
        if (assetTotal > maximumAssets) {
          const error = new Error(`本地语义重建最多处理 ${maximumAssets} 个素材`);
          error.code = 'asset_semantic_rebuild_limit';
          error.current = { projectId: normalizedProjectId, assetTotal, maximumAssets };
          throw error;
        }
        const eligibleAssetTotal = Number(this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM assets a
          JOIN asset_blob_refs r ON r.project_id = a.project_id AND r.asset_id = a.id
          JOIN asset_blobs b ON b.id = r.blob_id
          WHERE a.project_id = ?
            AND r.verification_state = 'verified' AND b.verification_state = 'verified'
            AND length(a.content_hash) = 64
            AND lower(a.content_hash) NOT GLOB '*[^0-9a-f]*'
            AND b.content_hash = lower(a.content_hash)
        `).get(normalizedProjectId).count) || 0;
        const excludedUnverified = Math.max(0, assetTotal - eligibleAssetTotal);
        let insertedJobs = 0;
        for (const { capability, model } of enabled) {
          const inserted = this.db.prepare(`
            INSERT INTO asset_semantic_jobs(
              id, project_id, asset_id, generation, content_hash, job_kind, model_key, model_version,
              status, revision, attempt_count, max_attempts, next_attempt_at, claim_token,
              error_code, error_message, result_json, created_at, started_at, updated_at, finished_at
            )
            SELECT 'asset-semantic-' || lower(hex(randomblob(16))), a.project_id, a.id, ?, a.content_hash,
              ?, ?, ?, 'queued', 1, 0, ?, NULL, NULL, NULL, NULL, '{}', ?, NULL, ?, NULL
            FROM assets a
            JOIN asset_blob_refs r ON r.project_id = a.project_id AND r.asset_id = a.id
            JOIN asset_blobs b ON b.id = r.blob_id
            WHERE a.project_id = ?
              AND r.verification_state = 'verified' AND b.verification_state = 'verified'
              AND length(a.content_hash) = 64
              AND lower(a.content_hash) NOT GLOB '*[^0-9a-f]*'
              AND b.content_hash = lower(a.content_hash)
          `).run(
            generation, capability, model.modelKey, model.modelVersion,
            maxAttempts, now, now, normalizedProjectId,
          );
          if (inserted.changes !== eligibleAssetTotal) {
            throw new Error(`语义任务批量登记不完整: ${capability}`);
          }
          insertedJobs += inserted.changes;
        }
        const expectedJobCount = eligibleAssetTotal * enabled.length;
        if (insertedJobs !== expectedJobCount) throw new Error('语义任务批量登记数量不一致');
        const sealed = this.db.prepare(`
          UPDATE asset_semantic_generations SET jobs_sealed = 1, expected_job_count = ?,
            eligible_asset_count = ?, excluded_asset_count = ?,
            revision = revision + 1, updated_at = ?
          WHERE project_id = ? AND generation = ? AND revision = 1 AND status = 'building' AND jobs_sealed = 0
        `).run(expectedJobCount, eligibleAssetTotal, excludedUnverified, now, normalizedProjectId, generation);
        if (sealed.changes !== 1) {
          throw revisionConflict('asset_semantic_generation_conflict', '语义任务登记封存失败', this.getAssetSemanticGeneration(normalizedProjectId, generation));
        }
      }
      return this.getAssetSemanticGeneration(normalizedProjectId, generation);
    });
    return run.immediate();
  }

  sealAssetSemanticRebuild(projectId = DEFAULT_PROJECT_ID, generation, input = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const normalizedGeneration = Math.max(1, Math.trunc(Number(generation) || 0));
    const expectedProfileRevision = Math.trunc(Number(input.expectedProfileRevision));
    const expectedGenerationRevision = Math.trunc(Number(input.expectedGenerationRevision));
    if (!Number.isInteger(expectedProfileRevision) || expectedProfileRevision < 1
      || !Number.isInteger(expectedGenerationRevision) || expectedGenerationRevision < 1) {
      throw new Error('封存语义任务登记必须提供 profile 与 generation 的 expectedRevision');
    }
    const now = Number(input.now) || Date.now();
    const run = this.db.transaction(() => {
      const profile = this.getAssetSemanticProfile(normalizedProjectId);
      const current = this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration);
      if (profile.revision !== expectedProfileRevision) {
        throw revisionConflict('asset_semantic_profile_revision_conflict', '语义配置版本冲突', profile);
      }
      if (!current || current.revision !== expectedGenerationRevision || current.status !== 'building'
        || current.jobsSealed || profile.buildingGeneration !== normalizedGeneration
        || semanticProfileDigest(profile) !== current.profileDigest) {
        throw revisionConflict('asset_semantic_generation_conflict', '语义任务登记代次已变化', current);
      }
      const liveCatalogRevision = this.getAssetCatalogRevision(normalizedProjectId);
      if (liveCatalogRevision !== current.catalogRevision) {
        throw revisionConflict('asset_catalog_revision_conflict', '素材目录在语义任务登记期间已变化', {
          projectId: normalizedProjectId,
          generation: normalizedGeneration,
          revision: current.revision,
          expectedCatalogRevision: current.catalogRevision,
          catalogRevision: liveCatalogRevision,
        });
      }
      const assetCounts = this.db.prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN r.verification_state = 'verified' AND b.verification_state = 'verified'
            AND length(a.content_hash) = 64
            AND lower(a.content_hash) NOT GLOB '*[^0-9a-f]*'
            AND b.content_hash = lower(a.content_hash) THEN 1 ELSE 0 END) AS eligible
        FROM assets a
        LEFT JOIN asset_blob_refs r ON r.project_id = a.project_id AND r.asset_id = a.id
        LEFT JOIN asset_blobs b ON b.id = r.blob_id
        WHERE a.project_id = ?
      `).get(normalizedProjectId);
      const assetTotal = Number(assetCounts?.total) || 0;
      const eligibleAssetTotal = Number(assetCounts?.eligible) || 0;
      const enabledCapabilityCount = [...ASSET_SEMANTIC_CAPABILITIES]
        .filter((capability) => current.profileSnapshot?.enabled && current.profileSnapshot?.[capability]?.enabled).length;
      const expectedJobCount = eligibleAssetTotal * enabledCapabilityCount;
      const actualJobCount = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM asset_semantic_jobs WHERE project_id = ? AND generation = ?
      `).get(normalizedProjectId, normalizedGeneration).count) || 0;
      if (actualJobCount !== expectedJobCount) {
        const error = new Error(`语义任务登记不完整: 预期 ${expectedJobCount}，实际 ${actualJobCount}`);
        error.code = 'asset_semantic_enrollment_incomplete';
        error.current = {
          projectId: normalizedProjectId,
          generation: normalizedGeneration,
          revision: current.revision,
          expectedJobCount,
          actualJobCount,
        };
        throw error;
      }
      const sealed = this.db.prepare(`
        UPDATE asset_semantic_generations SET jobs_sealed = 1, expected_job_count = ?,
          eligible_asset_count = ?, excluded_asset_count = ?, revision = revision + 1, updated_at = ?
        WHERE project_id = ? AND generation = ? AND revision = ? AND status = 'building' AND jobs_sealed = 0
      `).run(
        expectedJobCount, eligibleAssetTotal, Math.max(0, assetTotal - eligibleAssetTotal), now,
        normalizedProjectId, normalizedGeneration, expectedGenerationRevision,
      );
      if (sealed.changes !== 1) {
        throw revisionConflict('asset_semantic_generation_conflict', '语义任务登记封存冲突', this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration));
      }
      return this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration);
    });
    return run.immediate();
  }

  finishAssetSemanticRebuild(projectId = DEFAULT_PROJECT_ID, generation, input = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const normalizedGeneration = Math.max(1, Math.trunc(Number(generation) || 0));
    const expectedProfileRevision = Math.trunc(Number(input.expectedProfileRevision));
    const expectedGenerationRevision = Math.trunc(Number(input.expectedGenerationRevision));
    if (!Number.isInteger(expectedProfileRevision) || expectedProfileRevision < 1
      || !Number.isInteger(expectedGenerationRevision) || expectedGenerationRevision < 1) {
      throw new Error('结束语义重建必须提供 profile 与 generation 的 expectedRevision');
    }
    const now = Number(input.now) || Date.now();
    const run = this.db.transaction(() => {
      const profile = this.getAssetSemanticProfile(normalizedProjectId);
      const current = this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration);
      if (profile.revision !== expectedProfileRevision) {
        throw revisionConflict('asset_semantic_profile_revision_conflict', '语义配置版本冲突', profile);
      }
      if (!current || current.revision !== expectedGenerationRevision || current.status !== 'building'
        || profile.buildingGeneration !== normalizedGeneration) {
        throw revisionConflict('asset_semantic_generation_conflict', '语义索引代次已变化', current);
      }
      const counts = current.counts;
      const enrollmentInvalid = !current.jobsSealed || counts.total !== current.expectedJobCount;
      const suppliedError = input.error && typeof input.error === 'object' ? input.error : null;
      const explicitError = enrollmentInvalid
        ? {
            code: 'asset-semantic-enrollment-incomplete',
            message: `语义任务登记未封存或数量不一致（预期 ${current.expectedJobCount}，实际 ${counts.total}）`,
          }
        : suppliedError;
      if (!explicitError && counts.queued + counts.running + counts.retrying > 0) {
        throw revisionConflict('asset_semantic_generation_incomplete', '语义索引仍有未完成任务', current);
      }
      const digestMatches = semanticProfileDigest(profile) === current.profileDigest;
      if (!explicitError && !digestMatches) {
        throw revisionConflict('asset_semantic_generation_conflict', '语义配置已变化，旧代次不能就绪', current);
      }
      const terminalFailure = Boolean(explicitError || counts.failed || counts.superseded);
      const status = explicitError?.superseded === true ? 'superseded' : (terminalFailure ? 'failed' : 'ready');
      const errorCode = terminalFailure
        ? String(explicitError?.code || (counts.superseded ? 'semantic-jobs-superseded' : 'semantic-jobs-failed')).slice(0, 120)
        : null;
      const errorMessage = terminalFailure
        ? String(explicitError?.message || (counts.superseded ? '语义任务已被新配置取代' : '一个或多个语义任务失败')).slice(0, 600)
        : null;
      if (terminalFailure) {
        this.db.prepare(`
          UPDATE asset_semantic_jobs SET status = 'superseded', revision = revision + 1, claim_token = NULL,
            next_attempt_at = NULL, error_code = COALESCE(error_code, ?),
            error_message = COALESCE(error_message, ?), updated_at = ?, finished_at = ?
          WHERE project_id = ? AND generation = ? AND status IN ('queued', 'retrying')
        `).run(errorCode, errorMessage, now, now, normalizedProjectId, normalizedGeneration);
      }
      const changed = this.db.prepare(`
        UPDATE asset_semantic_generations SET status = ?, revision = revision + 1,
          error_code = ?, error_message = ?, updated_at = ?, finished_at = ?
        WHERE project_id = ? AND generation = ? AND revision = ? AND status = 'building'
      `).run(status, errorCode, errorMessage, now, now, normalizedProjectId, normalizedGeneration, expectedGenerationRevision);
      if (changed.changes !== 1) {
        throw revisionConflict('asset_semantic_generation_conflict', '语义索引代次已变化', this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration));
      }
      if (terminalFailure) {
        const cleared = this.db.prepare(`
          UPDATE asset_semantic_profiles SET building_generation = NULL, revision = revision + 1,
            updated_by = ?, updated_at = ?
          WHERE project_id = ? AND revision = ? AND building_generation = ?
        `).run(String(input.updatedBy || 'semantic-worker').slice(0, 240), now, normalizedProjectId, expectedProfileRevision, normalizedGeneration);
        if (cleared.changes !== 1) {
          throw revisionConflict('asset_semantic_profile_revision_conflict', '语义配置版本冲突', this.getAssetSemanticProfile(normalizedProjectId));
        }
      }
      return this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration);
    });
    return run.immediate();
  }

  supersedeBuildingAssetSemanticGeneration(projectId = DEFAULT_PROJECT_ID, generation, input = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const normalizedGeneration = Math.max(1, Math.trunc(Number(generation) || 0));
    const expectedProfileRevision = Math.trunc(Number(input.expectedProfileRevision));
    const expectedGenerationRevision = Math.trunc(Number(input.expectedGenerationRevision));
    if (!Number.isInteger(expectedProfileRevision) || expectedProfileRevision < 1
      || !Number.isInteger(expectedGenerationRevision) || expectedGenerationRevision < 1) {
      throw new Error('终止语义代次必须提供 profile 与 generation 的 expectedRevision');
    }
    const now = Number(input.now) || Date.now();
    const code = String(input.code || 'asset-semantic-profile-changed').slice(0, 120);
    const message = String(input.message || '语义配置已变化，旧代次已终止').slice(0, 600);
    const updatedBy = String(input.updatedBy || 'semantic-profile-change').slice(0, 240);
    const run = this.db.transaction(() => {
      const profile = this.getAssetSemanticProfile(normalizedProjectId);
      const current = this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration);
      if (profile.revision !== expectedProfileRevision) {
        throw revisionConflict('asset_semantic_profile_revision_conflict', '语义配置版本冲突', profile);
      }
      if (!current || current.revision !== expectedGenerationRevision
        || !['building', 'ready'].includes(current.status)
        || profile.buildingGeneration !== normalizedGeneration) {
        throw revisionConflict('asset_semantic_generation_conflict', '语义索引代次已变化', current);
      }
      this.db.prepare(`
        UPDATE asset_semantic_jobs SET status = 'superseded', revision = revision + 1,
          claim_token = NULL, next_attempt_at = NULL, error_code = ?, error_message = ?,
          updated_at = ?, finished_at = ?
        WHERE project_id = ? AND generation = ? AND status IN ('queued', 'running', 'retrying')
      `).run(code, message, now, now, normalizedProjectId, normalizedGeneration);
      const stopped = this.db.prepare(`
        UPDATE asset_semantic_generations SET status = 'superseded', revision = revision + 1,
          error_code = ?, error_message = ?, updated_at = ?, finished_at = COALESCE(finished_at, ?)
        WHERE project_id = ? AND generation = ? AND revision = ? AND status IN ('building', 'ready')
      `).run(code, message, now, now, normalizedProjectId, normalizedGeneration, expectedGenerationRevision);
      if (stopped.changes !== 1) {
        throw revisionConflict('asset_semantic_generation_conflict', '语义索引代次已变化', this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration));
      }
      const cleared = this.db.prepare(`
        UPDATE asset_semantic_profiles SET building_generation = NULL, revision = revision + 1,
          updated_by = ?, updated_at = ?
        WHERE project_id = ? AND revision = ? AND building_generation = ?
      `).run(updatedBy, now, normalizedProjectId, expectedProfileRevision, normalizedGeneration);
      if (cleared.changes !== 1) {
        throw revisionConflict('asset_semantic_profile_revision_conflict', '语义配置版本冲突', this.getAssetSemanticProfile(normalizedProjectId));
      }
      return {
        profile: this.getAssetSemanticProfile(normalizedProjectId),
        generation: this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration),
      };
    });
    return run.immediate();
  }

  promoteAssetSemanticGeneration(projectId = DEFAULT_PROJECT_ID, generation, input = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const normalizedGeneration = Math.max(1, Math.trunc(Number(generation) || 0));
    const expectedProfileRevision = Math.trunc(Number(input.expectedProfileRevision));
    const expectedGenerationRevision = Math.trunc(Number(input.expectedGenerationRevision));
    if (!Number.isInteger(expectedProfileRevision) || expectedProfileRevision < 1
      || !Number.isInteger(expectedGenerationRevision) || expectedGenerationRevision < 1) {
      throw new Error('提升语义索引必须提供 profile 与 generation 的 expectedRevision');
    }
    const now = Number(input.now) || Date.now();
    const updatedBy = String(input.updatedBy || 'semantic-worker').slice(0, 240);
    const run = this.db.transaction(() => {
      const profile = this.getAssetSemanticProfile(normalizedProjectId);
      const current = this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration);
      if (profile.revision !== expectedProfileRevision) {
        throw revisionConflict('asset_semantic_profile_revision_conflict', '语义配置版本冲突', profile);
      }
      if (!current || current.revision !== expectedGenerationRevision || current.status !== 'ready' || !current.jobsSealed
        || profile.buildingGeneration !== normalizedGeneration) {
        throw revisionConflict('asset_semantic_generation_conflict', '语义索引代次尚未就绪或已变化', current);
      }
      if (semanticProfileDigest(profile) !== current.profileDigest) {
        throw revisionConflict('asset_semantic_generation_conflict', '语义配置已变化，旧代次不能提升', current);
      }
      const previousGeneration = profile.activeGeneration;
      const currentCatalogRevision = this.getAssetCatalogRevision(normalizedProjectId);
      if (Number(current.catalogRevision) !== currentCatalogRevision) {
        const errorCode = 'asset_catalog_revision_conflict';
        const errorMessage = '素材目录在语义重建期间发生变化，新索引代次未提升；请重新重建';
        const rejected = this.db.prepare(`
          UPDATE asset_semantic_generations SET status = 'failed', revision = revision + 1,
            error_code = ?, error_message = ?, updated_at = ?, finished_at = COALESCE(finished_at, ?)
          WHERE project_id = ? AND generation = ? AND revision = ? AND status = 'ready'
        `).run(
          errorCode, errorMessage, now, now,
          normalizedProjectId, normalizedGeneration, expectedGenerationRevision,
        );
        if (rejected.changes !== 1) {
          throw revisionConflict('asset_semantic_generation_conflict', '语义索引代次已变化', this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration));
        }
        const cleared = this.db.prepare(`
          UPDATE asset_semantic_profiles SET building_generation = NULL, revision = revision + 1,
            updated_by = ?, updated_at = ?
          WHERE project_id = ? AND revision = ? AND building_generation = ?
        `).run(updatedBy, now, normalizedProjectId, expectedProfileRevision, normalizedGeneration);
        if (cleared.changes !== 1) {
          throw revisionConflict('asset_semantic_profile_revision_conflict', '语义配置版本冲突', this.getAssetSemanticProfile(normalizedProjectId));
        }
        return {
          catalogConflict: true,
          profile: this.getAssetSemanticProfile(normalizedProjectId),
          generation: this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration),
          previousGeneration,
          expectedCatalogRevision: Number(current.catalogRevision),
          catalogRevision: currentCatalogRevision,
        };
      }
      const catalogRevision = this._bumpAssetCatalogRevision(normalizedProjectId, now);
      const promoted = this.db.prepare(`
        UPDATE asset_semantic_generations SET status = 'active', revision = revision + 1,
          catalog_revision = ?, error_code = NULL, error_message = NULL,
          updated_at = ?, finished_at = COALESCE(finished_at, ?)
        WHERE project_id = ? AND generation = ? AND revision = ? AND status = 'ready'
      `).run(catalogRevision, now, now, normalizedProjectId, normalizedGeneration, expectedGenerationRevision);
      if (promoted.changes !== 1) {
        throw revisionConflict('asset_semantic_generation_conflict', '语义索引代次已变化', this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration));
      }
      if (previousGeneration != null && previousGeneration !== normalizedGeneration) {
        this.db.prepare(`
          UPDATE asset_semantic_generations SET status = 'superseded', revision = revision + 1,
            updated_at = ?, finished_at = COALESCE(finished_at, ?)
          WHERE project_id = ? AND generation = ? AND status = 'active'
        `).run(now, now, normalizedProjectId, previousGeneration);
      }
      const changed = this.db.prepare(`
        UPDATE asset_semantic_profiles SET active_generation = ?, building_generation = NULL,
          revision = revision + 1, updated_by = ?, updated_at = ?
        WHERE project_id = ? AND revision = ? AND building_generation = ?
      `).run(normalizedGeneration, updatedBy, now, normalizedProjectId, expectedProfileRevision, normalizedGeneration);
      if (changed.changes !== 1) {
        throw revisionConflict('asset_semantic_profile_revision_conflict', '语义配置版本冲突', this.getAssetSemanticProfile(normalizedProjectId));
      }
      return {
        profile: this.getAssetSemanticProfile(normalizedProjectId),
        generation: this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration),
        previousGeneration,
        catalogRevision,
      };
    });
    const outcome = run.immediate();
    if (outcome?.catalogConflict) {
      const error = revisionConflict(
        'asset_catalog_revision_conflict',
        '素材目录在语义重建期间发生变化，新索引代次未提升',
        {
          projectId: normalizedProjectId,
          generation: normalizedGeneration,
          revision: outcome.generation?.revision,
          status: outcome.generation?.status,
          expectedCatalogRevision: outcome.expectedCatalogRevision,
          catalogRevision: outcome.catalogRevision,
          activeGeneration: outcome.profile?.activeGeneration,
        },
      );
      error.outcome = outcome;
      throw error;
    }
    return outcome;
  }

  mapAssetSemanticJob(row, options = {}) {
    if (!row) return null;
    const mapped = {
      id: row.id,
      projectId: row.project_id,
      assetId: row.asset_id,
      contentHash: row.content_hash,
      generation: Number(row.generation),
      jobKind: normalizeSemanticCapability(row.job_kind),
      modelKey: row.model_key,
      modelVersion: row.model_version,
      status: ASSET_SEMANTIC_JOB_STATUSES.has(row.status) ? row.status : 'failed',
      revision: Math.max(1, Number(row.revision) || 1),
      attemptCount: Math.max(0, Number(row.attempt_count) || 0),
      maxAttempts: Math.max(1, Number(row.max_attempts) || 3),
      nextAttemptAt: row.next_attempt_at == null ? null : Number(row.next_attempt_at),
      errorCode: row.error_code || null,
      errorMessage: row.error_message || null,
      result: parseJson(row.result_json, {}),
      createdAt: Number(row.created_at),
      startedAt: row.started_at == null ? null : Number(row.started_at),
      updatedAt: Number(row.updated_at),
      finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    };
    if (options.includeClaimToken && row.status === 'running') mapped.claimToken = row.claim_token;
    return mapped;
  }

  getAssetSemanticJob(jobId) {
    return this.mapAssetSemanticJob(this.db.prepare(`
      SELECT * FROM asset_semantic_jobs WHERE id = ?
    `).get(String(jobId || '')));
  }

  listAssetSemanticJobs(filters = {}) {
    const clauses = [];
    const values = [];
    if (filters.projectId) { clauses.push('project_id = ?'); values.push(String(filters.projectId)); }
    if (filters.assetId) { clauses.push('asset_id = ?'); values.push(String(filters.assetId)); }
    if (filters.generation != null) {
      clauses.push('generation = ?');
      values.push(Math.max(1, Math.trunc(Number(filters.generation) || 0)));
    }
    if (filters.jobKind) { clauses.push('job_kind = ?'); values.push(normalizeSemanticCapability(filters.jobKind)); }
    if (filters.status) {
      const status = String(filters.status).trim().toLowerCase();
      if (!ASSET_SEMANTIC_JOB_STATUSES.has(status)) throw new Error('语义任务状态无效');
      clauses.push('status = ?');
      values.push(status);
    }
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(filters.limit) || 100)));
    return this.db.prepare(`
      SELECT * FROM asset_semantic_jobs
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...values, limit).map((row) => this.mapAssetSemanticJob(row));
  }

  getAssetSemanticJobStatus(filters = {}) {
    const clauses = [];
    const values = [];
    if (filters.projectId) { clauses.push('project_id = ?'); values.push(String(filters.projectId)); }
    if (filters.generation != null) {
      clauses.push('generation = ?');
      values.push(Math.max(1, Math.trunc(Number(filters.generation) || 0)));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const counts = { queued: 0, running: 0, retrying: 0, succeeded: 0, skipped: 0, failed: 0, superseded: 0, total: 0 };
    this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM asset_semantic_jobs ${where} GROUP BY status
    `).all(...values).forEach((row) => {
      if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.count) || 0;
    });
    counts.total = Object.entries(counts).filter(([key]) => key !== 'total').reduce((sum, [, value]) => sum + value, 0);
    const emptyCapabilityCounts = () => ({ queued: 0, running: 0, retrying: 0, succeeded: 0, skipped: 0, failed: 0, superseded: 0, total: 0 });
    const byCapability = {
      caption: emptyCapabilityCounts(),
      ocr: emptyCapabilityCounts(),
      embedding: emptyCapabilityCounts(),
    };
    this.db.prepare(`
      SELECT job_kind, status, COUNT(*) AS count FROM asset_semantic_jobs ${where}
      GROUP BY job_kind, status
    `).all(...values).forEach((row) => {
      if (byCapability[row.job_kind] && Object.hasOwn(byCapability[row.job_kind], row.status)) {
        byCapability[row.job_kind][row.status] = Number(row.count) || 0;
      }
    });
    Object.values(byCapability).forEach((capabilityCounts) => {
      capabilityCounts.total = Object.entries(capabilityCounts)
        .filter(([key]) => key !== 'total')
        .reduce((sum, [, value]) => sum + value, 0);
    });
    const retryClauses = [...clauses, "status = 'retrying'"];
    const next = this.db.prepare(`
      SELECT MIN(next_attempt_at) AS next_attempt_at FROM asset_semantic_jobs
      WHERE ${retryClauses.join(' AND ')}
    `).get(...values);
    return { counts, byCapability, nextAttemptAt: next?.next_attempt_at == null ? null : Number(next.next_attempt_at) };
  }

  enqueueAssetSemanticJob(input = {}) {
    const asset = this.getAsset(input.assetId);
    if (!asset) throw new Error('素材不存在，无法创建语义任务');
    const projectId = String(input.projectId || asset.projectId);
    if (projectId !== asset.projectId) throw new Error('语义任务素材不属于当前项目');
    const contentHash = normalizeSha256(input.contentHash || asset.contentHash);
    if (!contentHash || contentHash !== normalizeSha256(asset.contentHash)) throw new Error('语义任务内容哈希与素材不一致');
    const generation = Math.max(1, Math.trunc(Number(input.generation) || 0));
    const jobKind = normalizeSemanticCapability(input.jobKind);
    const modelKey = normalizeSemanticIdentity(input.modelKey, 'modelKey');
    const modelVersion = normalizeSemanticIdentity(input.modelVersion, 'modelVersion');
    const now = Number(input.createdAt) || Date.now();
    const run = this.db.transaction(() => {
      const profile = this.getAssetSemanticProfile(projectId);
      const generationRow = this.getAssetSemanticGeneration(projectId, generation);
      if (!generationRow || generationRow.status !== 'building' || generationRow.jobsSealed
        || profile.buildingGeneration !== generation
        || semanticProfileDigest(profile) !== generationRow.profileDigest) {
        throw revisionConflict('asset_semantic_generation_conflict', '语义任务代次不是当前重建代次', generationRow);
      }
      const config = generationRow.profileSnapshot?.[jobKind];
      if (!generationRow.profileSnapshot?.enabled || !config?.enabled
        || config.modelKey !== modelKey || config.modelVersion !== modelVersion) {
        throw new Error('语义任务 capability 或模型身份与重建快照不一致');
      }
      const model = this.getAssetSemanticModel(modelKey, modelVersion);
      if (!model || model.capability !== jobKind || model.status !== 'installed') {
        const error = new Error('语义任务模型尚未安装并校验');
        error.code = 'asset_semantic_model_not_installed';
        error.current = model;
        throw error;
      }
      const trustedAsset = this.db.prepare(`
        SELECT 1 FROM asset_blob_refs r
        JOIN asset_blobs b ON b.id = r.blob_id
        WHERE r.project_id = ? AND r.asset_id = ?
          AND r.verification_state = 'verified' AND b.verification_state = 'verified'
          AND b.content_hash = ?
        LIMIT 1
      `).get(projectId, asset.id, contentHash);
      if (!trustedAsset) {
        const error = new Error('素材缺少可信内容哈希，不纳入语义任务');
        error.code = 'asset_semantic_asset_unverified';
        error.current = { projectId, assetId: asset.id, generation };
        throw error;
      }
      const id = String(input.id || `asset-semantic-${crypto.randomUUID()}`);
      const maxAttempts = Math.max(1, Math.min(5, Math.trunc(Number(input.maxAttempts) || 3)));
      this.db.prepare(`
        INSERT OR IGNORE INTO asset_semantic_jobs(
          id, project_id, asset_id, generation, content_hash, job_kind, model_key, model_version,
          status, revision, attempt_count, max_attempts, next_attempt_at, claim_token,
          error_code, error_message, result_json, created_at, started_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, 0, ?, NULL, NULL, NULL, NULL, '{}', ?, NULL, ?, NULL)
      `).run(id, projectId, asset.id, generation, contentHash, jobKind, modelKey, modelVersion, maxAttempts, now, now);
      const row = this.db.prepare(`
        SELECT * FROM asset_semantic_jobs
        WHERE project_id = ? AND asset_id = ? AND generation = ? AND job_kind = ?
          AND model_key = ? AND model_version = ?
      `).get(projectId, asset.id, generation, jobKind, modelKey, modelVersion);
      if (!row) throw new Error('语义任务 ID 与既有任务冲突');
      return this.mapAssetSemanticJob(row);
    });
    return run.immediate();
  }

  claimNextAssetSemanticJob(input = {}) {
    const now = Number(input.now) || Date.now();
    const clauses = [
      "j.status IN ('queued', 'retrying')",
      '(j.next_attempt_at IS NULL OR j.next_attempt_at <= ?)',
      "g.status = 'building'",
      'g.jobs_sealed = 1',
      'p.building_generation = j.generation',
      "m.status = 'installed'",
      `(j.job_kind <> 'embedding' OR NOT EXISTS (
        SELECT 1 FROM asset_semantic_jobs dependency
        WHERE dependency.project_id = j.project_id
          AND dependency.asset_id = j.asset_id
          AND dependency.generation = j.generation
          AND dependency.job_kind IN ('caption', 'ocr')
          AND dependency.status NOT IN ('succeeded', 'skipped')
      ))`,
    ];
    const values = [now];
    if (input.projectId) { clauses.push('j.project_id = ?'); values.push(String(input.projectId)); }
    if (input.jobKind) { clauses.push('j.job_kind = ?'); values.push(normalizeSemanticCapability(input.jobKind)); }
    const run = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT j.*, g.profile_digest FROM asset_semantic_jobs j
        JOIN asset_semantic_generations g
          ON g.project_id = j.project_id AND g.generation = j.generation
        JOIN asset_semantic_profiles p ON p.project_id = j.project_id
        JOIN asset_semantic_models m
          ON m.model_key = j.model_key AND m.model_version = j.model_version
        WHERE ${clauses.join(' AND ')}
        ORDER BY CASE j.job_kind WHEN 'embedding' THEN 1 ELSE 0 END,
          CASE j.status WHEN 'queued' THEN 0 ELSE 1 END, j.created_at ASC, j.id ASC
        LIMIT 100
      `).all(...values);
      for (const row of rows) {
        const profile = this.getAssetSemanticProfile(row.project_id);
        if (semanticProfileDigest(profile) !== row.profile_digest) {
          this.db.prepare(`
            UPDATE asset_semantic_jobs SET status = 'superseded', revision = revision + 1, claim_token = NULL,
              next_attempt_at = NULL, error_code = 'semantic-profile-changed',
              error_message = '语义配置已变化，任务未执行', updated_at = ?, finished_at = ?
            WHERE id = ? AND revision = ? AND status IN ('queued', 'retrying')
          `).run(now, now, row.id, row.revision);
          continue;
        }
        const claimToken = crypto.randomUUID();
        const changed = this.db.prepare(`
          UPDATE asset_semantic_jobs SET status = 'running', revision = revision + 1, attempt_count = attempt_count + 1,
            next_attempt_at = NULL, claim_token = ?, error_code = NULL, error_message = NULL,
            started_at = ?, updated_at = ?, finished_at = NULL
          WHERE id = ? AND revision = ? AND status IN ('queued', 'retrying')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND EXISTS (
              SELECT 1 FROM asset_semantic_models m
              WHERE m.model_key = asset_semantic_jobs.model_key
                AND m.model_version = asset_semantic_jobs.model_version AND m.status = 'installed'
            )
        `).run(claimToken, now, now, row.id, row.revision, now);
        if (changed.changes !== 1) continue;
        const claimed = this.db.prepare('SELECT * FROM asset_semantic_jobs WHERE id = ?').get(row.id);
        return this.mapAssetSemanticJob(claimed, { includeClaimToken: true });
      }
      return null;
    });
    return run.immediate();
  }

  _semanticRunningJobGuard(row) {
    const asset = this.db.prepare(`
      SELECT id, project_id, content_hash FROM assets WHERE id = ? AND project_id = ?
    `).get(row.asset_id, row.project_id);
    if (!asset || normalizeSha256(asset.content_hash) !== normalizeSha256(row.content_hash)) {
      return { valid: false, reason: 'source-content-changed', status: 'failed', asset };
    }
    const generation = this.getAssetSemanticGeneration(row.project_id, row.generation);
    const profile = this.getAssetSemanticProfile(row.project_id);
    if (!generation || generation.status !== 'building' || !generation.jobsSealed
      || profile.buildingGeneration !== Number(row.generation)
      || semanticProfileDigest(profile) !== generation.profileDigest) {
      return { valid: false, reason: 'semantic-generation-stale', status: 'superseded', asset, generation, profile };
    }
    const model = this.getAssetSemanticModel(row.model_key, row.model_version);
    if (!model || model.capability !== row.job_kind || model.status !== 'installed') {
      return { valid: false, reason: 'semantic-model-disabled', status: 'superseded', asset, generation, profile, model };
    }
    return { valid: true, asset, generation, profile, model };
  }

  _invalidateSemanticEmbeddingDependency(row, now, terminalStatus = 'failed') {
    if (!row || !['caption', 'ocr'].includes(row.job_kind)) return 0;
    const status = terminalStatus === 'superseded' ? 'superseded' : 'failed';
    const code = status === 'superseded' ? 'semantic-dependency-superseded' : 'semantic-dependency-failed';
    const changed = this.db.prepare(`
      UPDATE asset_semantic_jobs SET status = ?, revision = revision + 1,
        claim_token = NULL, next_attempt_at = NULL, error_code = ?,
        error_message = ?, result_json = '{}', updated_at = ?, finished_at = ?
      WHERE project_id = ? AND asset_id = ? AND generation = ? AND job_kind = 'embedding'
        AND status IN ('queued', 'retrying', 'running', 'succeeded', 'skipped')
    `).run(
      status, code, `${row.job_kind} 任务未成功，下游 Embedding 已失效`, now, now,
      row.project_id, row.asset_id, row.generation,
    );
    this.db.prepare(`
      DELETE FROM asset_semantic_embeddings
      WHERE project_id = ? AND asset_id = ? AND generation = ?
    `).run(row.project_id, row.asset_id, row.generation);
    return changed.changes;
  }

  _finishStaleSemanticRunningJob(row, claimToken, guard, now) {
    const code = guard.reason;
    const messageMap = {
      'source-content-changed': '素材内容已变化，旧语义结果未写回',
      'semantic-generation-stale': '语义配置或重建代次已变化，旧结果未写回',
      'semantic-model-disabled': '语义模型已禁用或版本身份失效，旧结果未写回',
    };
    this.db.prepare(`
      UPDATE asset_semantic_jobs SET status = ?, revision = revision + 1, claim_token = NULL, next_attempt_at = NULL,
        error_code = ?, error_message = ?, updated_at = ?, finished_at = ?
      WHERE id = ? AND revision = ? AND status = 'running' AND claim_token = ?
    `).run(guard.status, code, messageMap[code] || '语义任务已失效', now, now, row.id, row.revision, claimToken);
    this._invalidateSemanticEmbeddingDependency(row, now, guard.status);
    return { applied: false, reason: code, job: this.getAssetSemanticJob(row.id) };
  }

  completeAssetSemanticJob(jobId, input = {}, options = {}) {
    const now = Number(options.now ?? input.now) || Date.now();
    const claimToken = normalizeSemanticIdentity(input.claimToken, 'claimToken', 200);
    const contentHash = normalizeSha256(input.contentHash);
    const generation = Math.max(1, Math.trunc(Number(input.generation) || 0));
    const expectedRevision = Math.trunc(Number(input.expectedRevision));
    const modelKey = normalizeSemanticIdentity(input.modelKey, 'modelKey');
    const modelVersion = normalizeSemanticIdentity(input.modelVersion, 'modelVersion');
    if (!contentHash || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('完成语义任务必须提供有效 contentHash 与 expectedRevision');
    }
    const run = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM asset_semantic_jobs WHERE id = ?').get(String(jobId || ''));
      if (!row) return { applied: false, reason: 'job-missing', job: null };
      if (row.status !== 'running' || row.claim_token !== claimToken) {
        return { applied: false, reason: 'stale-claim', job: this.mapAssetSemanticJob(row) };
      }
      if (Number(row.revision) !== expectedRevision) {
        throw revisionConflict('asset_semantic_job_revision_conflict', '语义任务版本冲突', this.mapAssetSemanticJob(row));
      }
      if (row.content_hash !== contentHash || Number(row.generation) !== generation
        || row.model_key !== modelKey || row.model_version !== modelVersion) {
        return { applied: false, reason: 'semantic-identity-mismatch', job: this.mapAssetSemanticJob(row) };
      }
      const guard = this._semanticRunningJobGuard(row);
      if (!guard.valid) return this._finishStaleSemanticRunningJob(row, claimToken, guard, now);
      const skipped = input.skipped && typeof input.skipped === 'object' ? input.skipped : null;
      if (skipped) {
        const metadata = normalizeSemanticMetadata(skipped.metadata);
        const code = String(skipped.code || 'semantic-unsupported').trim().slice(0, 120) || 'semantic-unsupported';
        const message = String(skipped.message || '素材不适用于此语义能力').trim().slice(0, 600);
        const result = { skipped: true, code, metadata: metadata.value };
        const changed = this.db.prepare(`
          UPDATE asset_semantic_jobs SET status = 'skipped', revision = revision + 1, claim_token = NULL,
            error_code = ?, error_message = ?, result_json = ?, updated_at = ?, finished_at = ?
          WHERE id = ? AND revision = ? AND status = 'running' AND claim_token = ?
        `).run(code, message, JSON.stringify(result), now, now, row.id, expectedRevision, claimToken);
        if (changed.changes !== 1) throw revisionConflict('asset_semantic_job_claim_conflict', '语义任务 claim 已失效', this.getAssetSemanticJob(row.id));
        return { applied: true, reason: 'skipped', job: this.getAssetSemanticJob(row.id) };
      }

      const rawMetadata = normalizeSemanticMetadata(input.metadata);
      let document = null;
      let embeddingSummary = null;
      let result = {};
      if (row.job_kind === 'caption' || row.job_kind === 'ocr') {
        const rawDocument = input[row.job_kind];
        const documentInput = rawDocument && typeof rawDocument === 'object' ? rawDocument : {};
        const text = normalizeSemanticText(
          typeof rawDocument === 'string' ? rawDocument : (documentInput.text ?? input.text),
          row.job_kind === 'caption' ? 'Caption' : 'OCR 文本',
        );
        const languageValue = documentInput.language ?? input.language;
        const language = languageValue == null || languageValue === ''
          ? null
          : normalizeSemanticIdentity(languageValue, 'language', 40);
        const documentMetadata = documentInput.metadata
          && typeof documentInput.metadata === 'object'
          && !Array.isArray(documentInput.metadata)
          ? documentInput.metadata
          : {};
        const metadata = normalizeSemanticMetadata({ ...rawMetadata.value, ...documentMetadata });
        result = { documentKind: row.job_kind, textLength: text.length, language };
        const changed = this.db.prepare(`
          UPDATE asset_semantic_jobs SET status = 'succeeded', revision = revision + 1, claim_token = NULL,
            error_code = NULL, error_message = NULL, result_json = ?, updated_at = ?, finished_at = ?
          WHERE id = ? AND revision = ? AND status = 'running' AND claim_token = ?
        `).run(JSON.stringify(result), now, now, row.id, expectedRevision, claimToken);
        if (changed.changes !== 1) throw revisionConflict('asset_semantic_job_claim_conflict', '语义任务 claim 已失效', this.getAssetSemanticJob(row.id));
        this.db.prepare(`
          INSERT INTO asset_semantic_documents(
            project_id, asset_id, generation, content_hash, document_kind,
            model_key, model_version, text, language, metadata_json, source_job_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, asset_id, generation, document_kind) DO UPDATE SET
            content_hash = excluded.content_hash, model_key = excluded.model_key,
            model_version = excluded.model_version, text = excluded.text, language = excluded.language,
            metadata_json = excluded.metadata_json, source_job_id = excluded.source_job_id,
            updated_at = excluded.updated_at
        `).run(
          row.project_id, row.asset_id, row.generation, row.content_hash, row.job_kind,
          row.model_key, row.model_version, text, language, metadata.serialized, row.id, now, now,
        );
        document = this.listAssetSemanticDocuments(row.project_id, {
          assetId: row.asset_id, generation: row.generation, kind: row.job_kind, limit: 1,
        })[0] || null;
      } else {
        const rawEmbedding = input.embedding && typeof input.embedding === 'object' && !ArrayBuffer.isView(input.embedding) && !Array.isArray(input.embedding)
          ? (input.embedding.vector ?? input.embedding.values)
          : input.embedding;
        const encoded = encodeFloat32LE(rawEmbedding);
        const claimedDimensions = Number(input.embedding?.dimensions ?? input.dimensions);
        if (Number.isFinite(claimedDimensions) && claimedDimensions > 0 && Math.trunc(claimedDimensions) !== encoded.dimensions) {
          throw new Error('Embedding 声明维度与向量长度不一致');
        }
        result = { dimensions: encoded.dimensions, norm: encoded.norm };
        const changed = this.db.prepare(`
          UPDATE asset_semantic_jobs SET status = 'succeeded', revision = revision + 1, claim_token = NULL,
            error_code = NULL, error_message = NULL, result_json = ?, updated_at = ?, finished_at = ?
          WHERE id = ? AND revision = ? AND status = 'running' AND claim_token = ?
        `).run(JSON.stringify(result), now, now, row.id, expectedRevision, claimToken);
        if (changed.changes !== 1) throw revisionConflict('asset_semantic_job_claim_conflict', '语义任务 claim 已失效', this.getAssetSemanticJob(row.id));
        this.db.prepare(`
          INSERT INTO asset_semantic_embeddings(
            project_id, asset_id, generation, content_hash, model_key, model_version,
            dimensions, vector_blob, vector_norm, metadata_json, source_job_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, asset_id, generation, model_key, model_version) DO UPDATE SET
            content_hash = excluded.content_hash, dimensions = excluded.dimensions,
            vector_blob = excluded.vector_blob, vector_norm = excluded.vector_norm,
            metadata_json = excluded.metadata_json, source_job_id = excluded.source_job_id,
            updated_at = excluded.updated_at
        `).run(
          row.project_id, row.asset_id, row.generation, row.content_hash, row.model_key, row.model_version,
          encoded.dimensions, encoded.blob, encoded.norm, rawMetadata.serialized, row.id, now, now,
        );
        embeddingSummary = result;
      }
      return {
        applied: true,
        reason: null,
        job: this.getAssetSemanticJob(row.id),
        document,
        embedding: embeddingSummary,
      };
    });
    return run.immediate();
  }

  rescheduleAssetSemanticJob(jobId, error = {}, input = {}) {
    const now = Number(input.now) || Date.now();
    const claimToken = normalizeSemanticIdentity(input.claimToken, 'claimToken', 200);
    const expectedRevision = Math.trunc(Number(input.expectedRevision));
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('重排语义任务必须提供 expectedRevision');
    }
    const run = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM asset_semantic_jobs WHERE id = ?').get(String(jobId || ''));
      if (!row) return null;
      if (row.status !== 'running' || row.claim_token !== claimToken) return this.mapAssetSemanticJob(row);
      if (Number(row.revision) !== expectedRevision) {
        throw revisionConflict('asset_semantic_job_revision_conflict', '语义任务版本冲突', this.mapAssetSemanticJob(row));
      }
      const guard = this._semanticRunningJobGuard(row);
      if (!guard.valid) return this._finishStaleSemanticRunningJob(row, claimToken, guard, now).job;
      const retryable = input.retryable !== false && Number(row.attempt_count) < Number(row.max_attempts);
      const status = retryable ? 'retrying' : 'failed';
      const nextAttemptAt = retryable ? Math.max(now, Number(input.nextAttemptAt) || now) : null;
      const code = String(error.code || (retryable ? 'semantic-retry' : 'semantic-failed')).trim().slice(0, 120);
      const message = String(error.message || '语义处理失败').trim().slice(0, 600);
      const changed = this.db.prepare(`
        UPDATE asset_semantic_jobs SET status = ?, revision = revision + 1, claim_token = NULL, next_attempt_at = ?,
          error_code = ?, error_message = ?, updated_at = ?, finished_at = ?
        WHERE id = ? AND revision = ? AND status = 'running' AND claim_token = ?
      `).run(status, nextAttemptAt, code, message, now, retryable ? null : now, row.id, expectedRevision, claimToken);
      if (changed.changes !== 1) return this.getAssetSemanticJob(row.id);
      if (status === 'failed' && ['caption', 'ocr'].includes(row.job_kind)) {
        this._invalidateSemanticEmbeddingDependency(row, now, status);
      }
      return this.getAssetSemanticJob(row.id);
    });
    return run.immediate();
  }

  retryAssetSemanticJob(projectId = DEFAULT_PROJECT_ID, jobId, input = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const normalizedJobId = String(jobId || '');
    const expectedRevision = Math.trunc(Number(input.expectedRevision));
    if (!normalizedJobId || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('重试语义任务必须提供 jobId 与 expectedRevision');
    }
    const now = Number(input.now) || Date.now();
    const updatedBy = String(input.updatedBy || 'semantic-retry').slice(0, 240);
    const run = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM asset_semantic_jobs WHERE project_id = ? AND id = ?
      `).get(normalizedProjectId, normalizedJobId);
      if (!row) throw new Error('语义任务不存在或不属于当前项目');
      if (Number(row.revision) !== expectedRevision || row.status !== 'failed') {
        throw revisionConflict('asset_semantic_job_revision_conflict', '语义任务版本或状态冲突', this.mapAssetSemanticJob(row));
      }
      let profile = this.getAssetSemanticProfile(normalizedProjectId);
      let generationRow = this.getAssetSemanticGeneration(normalizedProjectId, row.generation);
      const asset = this.db.prepare(`
        SELECT content_hash FROM assets WHERE project_id = ? AND id = ?
      `).get(normalizedProjectId, row.asset_id);
      const model = this.getAssetSemanticModel(row.model_key, row.model_version);
      if (!asset || normalizeSha256(asset.content_hash) !== normalizeSha256(row.content_hash)) {
        throw revisionConflict('asset_semantic_job_content_conflict', '素材内容已变化，旧语义任务不能重试', this.mapAssetSemanticJob(row));
      }
      if (!model || model.capability !== row.job_kind || model.status !== 'installed') {
        const error = new Error('语义模型尚未安装并校验，不能重试');
        error.code = 'asset_semantic_model_not_installed';
        error.current = model;
        throw error;
      }
      for (const capability of ASSET_SEMANTIC_CAPABILITIES) {
        const configured = profile[capability];
        if (!profile.enabled || !configured?.enabled) continue;
        const configuredModel = this.getAssetSemanticModel(configured.modelKey, configured.modelVersion);
        if (!configuredModel || configuredModel.capability !== capability || configuredModel.status !== 'installed') {
          const error = new Error(`${capability} 语义模型尚未安装并校验，失败代次不能重开`);
          error.code = 'asset_semantic_model_not_installed';
          error.current = configuredModel;
          throw error;
        }
      }
      const normalizedGeneration = Number(row.generation);
      const digestMatches = generationRow
        && semanticProfileDigest(profile) === generationRow.profileDigest;
      const configuredCapability = profile[row.job_kind];
      const jobIdentityMatches = Boolean(
        profile.enabled
        && configuredCapability?.enabled
        && configuredCapability.modelKey === row.model_key
        && configuredCapability.modelVersion === row.model_version,
      );
      const stillBuilding = generationRow?.status === 'building'
        && generationRow.jobsSealed
        && profile.buildingGeneration === normalizedGeneration
        && digestMatches
        && jobIdentityMatches;
      const mayReopenFailedReplacement = generationRow?.status === 'failed'
        && generationRow.jobsSealed
        && profile.buildingGeneration == null
        && digestMatches
        && jobIdentityMatches;
      if (!stillBuilding && !mayReopenFailedReplacement) {
        throw revisionConflict('asset_semantic_generation_conflict', '语义索引代次已变化', generationRow);
      }
      if (mayReopenFailedReplacement) {
        const latestGeneration = Number(this.db.prepare(`
          SELECT COALESCE(MAX(generation), 0) AS generation
          FROM asset_semantic_generations WHERE project_id = ?
        `).get(normalizedProjectId).generation);
        if (latestGeneration !== normalizedGeneration) {
          throw revisionConflict('asset_semantic_generation_conflict', '已有更新的语义索引代次，旧失败代次不能重试', generationRow);
        }
        const catalogRevision = this.getAssetCatalogRevision(normalizedProjectId);
        if (Number(generationRow.catalogRevision) !== catalogRevision) {
          throw revisionConflict('asset_catalog_revision_conflict', '素材目录已变化，旧失败代次不能重试', {
            generation: normalizedGeneration,
            revision: generationRow.revision,
            expectedCatalogRevision: Number(generationRow.catalogRevision),
            catalogRevision,
          });
        }
        const reopened = this.db.prepare(`
          UPDATE asset_semantic_generations SET status = 'building', revision = revision + 1,
            error_code = NULL, error_message = NULL, updated_at = ?, finished_at = NULL
          WHERE project_id = ? AND generation = ? AND revision = ? AND status = 'failed'
        `).run(
          now, normalizedProjectId, normalizedGeneration, generationRow.revision,
        );
        if (reopened.changes !== 1) {
          throw revisionConflict('asset_semantic_generation_conflict', '语义索引代次已变化', this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration));
        }
        const rebound = this.db.prepare(`
          UPDATE asset_semantic_profiles SET building_generation = ?, revision = revision + 1,
            updated_by = ?, updated_at = ?
          WHERE project_id = ? AND revision = ? AND building_generation IS NULL
        `).run(normalizedGeneration, updatedBy, now, normalizedProjectId, profile.revision);
        if (rebound.changes !== 1) {
          throw revisionConflict('asset_semantic_profile_revision_conflict', '语义配置版本冲突', this.getAssetSemanticProfile(normalizedProjectId));
        }
        profile = this.getAssetSemanticProfile(normalizedProjectId);
        generationRow = this.getAssetSemanticGeneration(normalizedProjectId, normalizedGeneration);
      }
      if (['caption', 'ocr'].includes(row.job_kind)) {
        const downstreamJobs = this.db.prepare(`
          SELECT * FROM asset_semantic_jobs
          WHERE project_id = ? AND asset_id = ? AND generation = ? AND job_kind = 'embedding'
        `).all(normalizedProjectId, row.asset_id, normalizedGeneration);
        for (const downstream of downstreamJobs) {
          const configuredEmbedding = profile.embedding;
          if (!profile.enabled || !configuredEmbedding?.enabled
            || configuredEmbedding.modelKey !== downstream.model_key
            || configuredEmbedding.modelVersion !== downstream.model_version) {
            throw revisionConflict('asset_semantic_generation_conflict', '下游 Embedding 身份已变化，视觉任务不能重试', generationRow);
          }
        }
        this.db.prepare(`
          UPDATE asset_semantic_jobs SET status = 'queued', revision = revision + 1,
            attempt_count = 0, next_attempt_at = NULL, claim_token = NULL,
            error_code = NULL, error_message = NULL, result_json = '{}',
            started_at = NULL, updated_at = ?, finished_at = NULL
          WHERE project_id = ? AND asset_id = ? AND generation = ? AND job_kind = 'embedding'
        `).run(now, normalizedProjectId, row.asset_id, normalizedGeneration);
        this.db.prepare(`
          DELETE FROM asset_semantic_embeddings
          WHERE project_id = ? AND asset_id = ? AND generation = ?
        `).run(normalizedProjectId, row.asset_id, normalizedGeneration);
      }
      const reset = this.db.prepare(`
        UPDATE asset_semantic_jobs SET status = 'queued', revision = revision + 1,
          attempt_count = 0, next_attempt_at = NULL,
          claim_token = NULL, error_code = NULL, error_message = NULL, result_json = '{}',
          started_at = NULL, updated_at = ?, finished_at = NULL
        WHERE project_id = ? AND id = ? AND revision = ? AND status = 'failed'
      `).run(now, normalizedProjectId, normalizedJobId, expectedRevision);
      if (reset.changes !== 1) {
        throw revisionConflict('asset_semantic_job_revision_conflict', '语义任务版本或状态冲突', this.getAssetSemanticJob(normalizedJobId));
      }
      return this.getAssetSemanticJob(normalizedJobId);
    });
    return run.immediate();
  }

  retryAssetSemanticJobs(projectId = DEFAULT_PROJECT_ID, input = {}) {
    return [this.retryAssetSemanticJob(projectId, input.jobId, input)];
  }

  recoverInterruptedAssetSemanticJobs(input = {}) {
    const now = Number(input.now) || Date.now();
    let recovered = 0;
    let failed = 0;
    let superseded = 0;
    let enrollmentFailed = 0;
    const run = this.db.transaction(() => {
      const unsealedGenerations = this.db.prepare(`
        SELECT * FROM asset_semantic_generations
        WHERE status = 'building' AND jobs_sealed = 0
        ORDER BY project_id, generation
      `).all();
      for (const generation of unsealedGenerations) {
        const code = 'asset-semantic-enrollment-incomplete';
        const message = '应用重启时发现语义任务登记未封存，该代次已安全终止';
        this.db.prepare(`
          UPDATE asset_semantic_jobs SET status = 'superseded', revision = revision + 1,
            claim_token = NULL, next_attempt_at = NULL, error_code = ?, error_message = ?,
            updated_at = ?, finished_at = ?
          WHERE project_id = ? AND generation = ? AND status IN ('queued', 'running', 'retrying')
        `).run(code, message, now, now, generation.project_id, generation.generation);
        const stopped = this.db.prepare(`
          UPDATE asset_semantic_generations SET status = 'failed', revision = revision + 1,
            error_code = ?, error_message = ?, updated_at = ?, finished_at = ?
          WHERE project_id = ? AND generation = ? AND revision = ? AND status = 'building' AND jobs_sealed = 0
        `).run(
          code, message, now, now,
          generation.project_id, generation.generation, generation.revision,
        );
        if (stopped.changes !== 1) continue;
        this.db.prepare(`
          UPDATE asset_semantic_profiles SET building_generation = NULL, revision = revision + 1,
            updated_by = 'semantic-enrollment-recovery', updated_at = ?
          WHERE project_id = ? AND building_generation = ?
        `).run(now, generation.project_id, generation.generation);
        enrollmentFailed += 1;
      }
      const rows = this.db.prepare("SELECT * FROM asset_semantic_jobs WHERE status = 'running'").all();
      for (const row of rows) {
        const guard = this._semanticRunningJobGuard(row);
        let status;
        let code;
        let message;
        let nextAttemptAt = null;
        if (!guard.valid) {
          status = guard.status;
          code = guard.reason;
          message = '应用重启时发现语义任务身份已失效';
          if (status === 'superseded') superseded += 1; else failed += 1;
        } else if (Number(row.attempt_count) < Number(row.max_attempts)) {
          status = 'retrying';
          code = 'semantic-worker-restarted';
          message = '应用重启后重新排队语义任务';
          nextAttemptAt = now;
          recovered += 1;
        } else {
          status = 'failed';
          code = 'semantic-worker-restarted';
          message = '语义任务已达到最大尝试次数';
          failed += 1;
        }
        this.db.prepare(`
          UPDATE asset_semantic_jobs SET status = ?, revision = revision + 1, claim_token = NULL, next_attempt_at = ?,
            error_code = ?, error_message = ?, updated_at = ?, finished_at = ?
          WHERE id = ? AND status = 'running'
        `).run(status, nextAttemptAt, code, message, now, status === 'retrying' ? null : now, row.id);
        if (status !== 'retrying') this._invalidateSemanticEmbeddingDependency(row, now, status);
      }
      return { recovered, failed, superseded, enrollmentFailed };
    });
    return run.immediate();
  }

  supersedeAssetSemanticJobs(projectId = DEFAULT_PROJECT_ID, input = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const now = Number(input.now) || Date.now();
    const reason = String(input.reason || '语义任务已被新配置取代').trim().slice(0, 600);
    const clauses = ['project_id = ?', "status IN ('queued', 'retrying')"];
    const values = [normalizedProjectId];
    if (input.generation != null) {
      clauses.push('generation = ?');
      values.push(Math.max(1, Math.trunc(Number(input.generation) || 0)));
    }
    if (input.capabilities != null) {
      const capabilities = [...new Set((Array.isArray(input.capabilities) ? input.capabilities : [input.capabilities])
        .map((value) => normalizeSemanticCapability(value)))];
      if (!capabilities.length) return { superseded: 0, jobs: [] };
      clauses.push(`job_kind IN (${capabilities.map(() => '?').join(',')})`);
      values.push(...capabilities);
    }
    const run = this.db.transaction(() => {
      const ids = this.db.prepare(`
        SELECT id FROM asset_semantic_jobs WHERE ${clauses.join(' AND ')} ORDER BY created_at, id
      `).all(...values).map((row) => row.id);
      if (ids.length) {
        this.db.prepare(`
          UPDATE asset_semantic_jobs SET status = 'superseded', revision = revision + 1, claim_token = NULL,
            next_attempt_at = NULL, error_code = 'semantic-job-superseded', error_message = ?,
            updated_at = ?, finished_at = ? WHERE ${clauses.join(' AND ')}
        `).run(reason, now, now, ...values);
      }
      const jobs = ids.slice(0, 500).map((id) => this.getAssetSemanticJob(id)).filter(Boolean);
      return { superseded: ids.length, jobs };
    });
    return run.immediate();
  }

  mapAssetSemanticDocument(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      projectId: row.project_id,
      assetId: row.asset_id,
      generation: Number(row.generation),
      contentHash: row.content_hash,
      kind: row.document_kind,
      modelKey: row.model_key,
      modelVersion: row.model_version,
      text: row.text,
      language: row.language || null,
      metadata: parseJson(row.metadata_json, {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  listAssetSemanticDocuments(projectId = DEFAULT_PROJECT_ID, filters = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const clauses = ['project_id = ?'];
    const values = [normalizedProjectId];
    if (filters.assetId) { clauses.push('asset_id = ?'); values.push(String(filters.assetId)); }
    if (filters.generation != null) {
      clauses.push('generation = ?');
      values.push(Math.max(1, Math.trunc(Number(filters.generation) || 0)));
    }
    if (filters.kind) {
      const kind = String(filters.kind).trim().toLowerCase();
      if (!['caption', 'ocr'].includes(kind)) throw new Error('语义文档 kind 无效');
      clauses.push('document_kind = ?');
      values.push(kind);
    }
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(filters.limit) || 100)));
    return this.db.prepare(`
      SELECT * FROM asset_semantic_documents WHERE ${clauses.join(' AND ')}
      ORDER BY generation DESC, asset_id, document_kind LIMIT ?
    `).all(...values, limit).map((row) => this.mapAssetSemanticDocument(row));
  }

  _activeSemanticDocumentKinds(profile) {
    if (!profile?.enabled || profile.activeGeneration == null) return [];
    return ['caption', 'ocr'].filter((kind) => profile[kind]?.enabled);
  }

  _searchAssetSemanticDocumentRows(projectId, profile, query, options = {}) {
    const normalizedQuery = String(query || '').normalize('NFKC').trim().slice(0, 500);
    if (!normalizedQuery) return { rows: [], strategy: 'none' };
    const configuredKinds = this._activeSemanticDocumentKinds(profile);
    const requestedKinds = options.kinds == null
      ? configuredKinds
      : [...new Set((Array.isArray(options.kinds) ? options.kinds : [options.kinds]).map((kind) => {
          const normalized = String(kind || '').trim().toLowerCase();
          if (!['caption', 'ocr'].includes(normalized)) throw new Error('语义文档 kind 无效');
          return normalized;
        }))].filter((kind) => configuredKinds.includes(kind));
    if (!requestedKinds.length) return { rows: [], strategy: 'none' };
    const generation = options.generation == null
      ? profile.activeGeneration
      : Math.max(1, Math.trunc(Number(options.generation) || 0));
    if (generation !== profile.activeGeneration) {
      throw revisionConflict('asset_semantic_generation_conflict', '只能搜索当前激活的语义索引代次', {
        generation: profile.activeGeneration,
      });
    }
    const limit = Math.min(ASSET_SEMANTIC_SEARCH_HARD_LIMIT, Math.max(1, Math.trunc(Number(options.limit) || 100)));
    const kindSql = requestedKinds.map(() => '?').join(',');
    const characters = Array.from(normalizedQuery).length;
    if (characters >= 3) {
      const ftsQuery = `"${normalizedQuery.replace(/"/g, '""')}"`;
      try {
        const rows = this.db.prepare(`
          SELECT d.*, bm25(asset_semantic_fts) AS fts_rank
          FROM asset_semantic_fts
          JOIN asset_semantic_documents d ON d.id = asset_semantic_fts.rowid
          JOIN assets a ON a.project_id = d.project_id AND a.id = d.asset_id
          WHERE asset_semantic_fts MATCH ?
            AND d.project_id = ? AND d.generation = ?
            AND d.document_kind IN (${kindSql})
            AND d.content_hash = a.content_hash
          ORDER BY fts_rank ASC, d.asset_id ASC, d.document_kind ASC
          LIMIT ?
        `).all(ftsQuery, projectId, generation, ...requestedKinds, limit);
        return { rows, strategy: 'fts5-trigram' };
      } catch (error) {
        if (!/fts5|match|syntax|malformed/i.test(String(error?.message || ''))) throw error;
      }
    }
    const pattern = `%${escapeLikePattern(normalizedQuery.toLowerCase())}%`;
    const rows = this.db.prepare(`
      SELECT d.*, NULL AS fts_rank
      FROM asset_semantic_documents d
      JOIN assets a ON a.project_id = d.project_id AND a.id = d.asset_id
      WHERE d.project_id = ? AND d.generation = ?
        AND d.document_kind IN (${kindSql})
        AND d.content_hash = a.content_hash
        AND LOWER(d.text) LIKE ? ESCAPE '\\'
      ORDER BY d.asset_id ASC, d.document_kind ASC
      LIMIT ?
    `).all(projectId, generation, ...requestedKinds, pattern, limit);
    return { rows, strategy: characters < 3 ? 'like-short-query' : 'like-fallback' };
  }

  searchAssetSemanticDocuments(projectId = DEFAULT_PROJECT_ID, input = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const profile = this.getAssetSemanticProfile(normalizedProjectId);
    const result = this._searchAssetSemanticDocumentRows(normalizedProjectId, profile, input.query, {
      generation: input.generation,
      kinds: input.kinds,
      limit: Math.min(5000, Math.max(1, Math.trunc(Number(input.limit) || 100))),
    });
    return {
      items: result.rows.map((row) => ({
        ...this.mapAssetSemanticDocument(row),
        keywordScore: row.fts_rank == null ? 1 : 1 / (1 + Math.abs(Number(row.fts_rank) || 0)),
      })),
      strategy: result.strategy,
      generation: profile.activeGeneration,
      profileRevision: profile.revision,
    };
  }

  searchAssetSemantics(projectId = DEFAULT_PROJECT_ID, input = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const profile = this.getAssetSemanticProfile(normalizedProjectId);
    const catalogRevision = this.getAssetCatalogRevision(normalizedProjectId);
    if (input.expectedCatalogRevision != null && Number(input.expectedCatalogRevision) !== catalogRevision) {
      throw revisionConflict('asset_catalog_revision_conflict', '素材目录版本已变化', { catalogRevision });
    }
    if (input.expectedProfileRevision != null && Number(input.expectedProfileRevision) !== profile.revision) {
      throw revisionConflict('asset_semantic_profile_revision_conflict', '语义配置版本已变化', profile);
    }
    if (input.expectedGeneration != null
      && (profile.activeGeneration == null || Number(input.expectedGeneration) !== profile.activeGeneration)) {
      throw revisionConflict('asset_semantic_generation_conflict', '激活的语义索引代次已变化', {
        generation: profile.activeGeneration,
      });
    }
    const query = String(input.query || '').normalize('NFKC').trim().slice(0, 500);
    const queryEmbeddingInput = input.queryEmbedding;
    const hasQueryEmbedding = queryEmbeddingInput != null;
    const filters = input.filters && typeof input.filters === 'object' ? input.filters : {};
    const { clauses, values } = this._assetListQueryParts({ ...filters, projectId: normalizedProjectId, query: '' });
    const candidateTotal = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM assets a WHERE ${clauses.join(' AND ')}
    `).get(...values).count);
    if (candidateTotal > ASSET_SEMANTIC_SEARCH_HARD_LIMIT) {
      const error = new Error(`本地语义搜索候选超过 ${ASSET_SEMANTIC_SEARCH_HARD_LIMIT} 条，请缩小筛选范围或使用外部向量库`);
      error.code = 'asset_semantic_local_search_limit';
      error.current = { candidateTotal, hardLimit: ASSET_SEMANTIC_SEARCH_HARD_LIMIT };
      throw error;
    }
    const candidateRows = this.db.prepare(`
      SELECT a.* FROM assets a WHERE ${clauses.join(' AND ')} ORDER BY a.id ASC
    `).all(...values);
    const assets = [];
    for (let offset = 0; offset < candidateRows.length; offset += 500) {
      assets.push(...this.hydrateAssetRows(candidateRows.slice(offset, offset + 500)));
    }
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const documentSearch = query
      ? this._searchAssetSemanticDocumentRows(normalizedProjectId, profile, query, { limit: ASSET_SEMANTIC_SEARCH_HARD_LIMIT })
      : { rows: [], strategy: 'none' };
    const documentsByAsset = new Map();
    for (const row of documentSearch.rows) {
      if (!assetById.has(row.asset_id)) continue;
      const entries = documentsByAsset.get(row.asset_id) || [];
      entries.push(row);
      documentsByAsset.set(row.asset_id, entries);
    }

    let normalizedQueryEmbedding = null;
    let embeddingModelKey = null;
    let embeddingModelVersion = null;
    let embeddingGeneration = null;
    let activeGenerationRow = null;
    if (profile.activeGeneration != null) {
      activeGenerationRow = this.getAssetSemanticGeneration(normalizedProjectId, profile.activeGeneration);
    }
    const activeEmbeddingConfig = activeGenerationRow?.profileSnapshot?.embedding;
    if (hasQueryEmbedding && profile.enabled && profile.embedding?.enabled && activeEmbeddingConfig?.enabled) {
      normalizedQueryEmbedding = normalizeEmbeddingValues(queryEmbeddingInput);
      embeddingModelKey = input.modelKey == null
        ? activeEmbeddingConfig.modelKey
        : normalizeSemanticIdentity(input.modelKey, 'modelKey');
      embeddingModelVersion = input.modelVersion == null
        ? activeEmbeddingConfig.modelVersion
        : normalizeSemanticIdentity(input.modelVersion, 'modelVersion');
      if (embeddingModelKey !== activeEmbeddingConfig.modelKey || embeddingModelVersion !== activeEmbeddingConfig.modelVersion) {
        throw revisionConflict('asset_semantic_generation_conflict', '查询 Embedding 模型身份与激活索引不一致', {
          generation: profile.activeGeneration,
          modelKey: activeEmbeddingConfig.modelKey,
          modelVersion: activeEmbeddingConfig.modelVersion,
        });
      }
      embeddingGeneration = profile.activeGeneration;
    }
    const vectorScoreByAsset = new Map();
    if (normalizedQueryEmbedding) {
      const rows = this.db.prepare(`
        SELECT e.* FROM asset_semantic_embeddings e
        JOIN assets a ON a.project_id = e.project_id AND a.id = e.asset_id
        WHERE e.project_id = ? AND e.generation = ? AND e.model_key = ? AND e.model_version = ?
          AND e.content_hash = a.content_hash
        ORDER BY e.asset_id
      `).all(normalizedProjectId, embeddingGeneration, embeddingModelKey, embeddingModelVersion);
      for (const row of rows) {
        if (!assetById.has(row.asset_id)) continue;
        if (Number(row.dimensions) !== normalizedQueryEmbedding.dimensions) {
          const error = new Error('索引 Embedding 维度与查询模型输出不一致');
          error.code = 'asset_semantic_vector_corrupt';
          error.current = { assetId: row.asset_id, dimensions: row.dimensions, expectedDimensions: normalizedQueryEmbedding.dimensions };
          throw error;
        }
        const valuesFromBlob = decodeFloat32LE(Buffer.from(row.vector_blob), row.dimensions);
        const score = cosineSimilarity(normalizedQueryEmbedding.values, valuesFromBlob);
        vectorScoreByAsset.set(row.asset_id, score);
      }
    }

    const lowerQuery = query.toLocaleLowerCase('und');
    const eligible = [];
    for (const asset of assets) {
      let keywordScore = null;
      if (query) {
        const filename = String(asset.filename || '').normalize('NFKC').toLocaleLowerCase('und');
        const metadataText = `${JSON.stringify(asset.metadata || {})} ${JSON.stringify(asset.provenance || {})} ${(asset.tags || []).join(' ')}`
          .normalize('NFKC').toLocaleLowerCase('und');
        if (filename.includes(lowerQuery)) keywordScore = 1;
        else if (metadataText.includes(lowerQuery)) keywordScore = 0.7;
        const matchedDocuments = documentsByAsset.get(asset.id) || [];
        for (const document of matchedDocuments) {
          const documentScore = document.fts_rank == null ? 0.9 : 0.9 / (1 + Math.abs(Number(document.fts_rank) || 0));
          keywordScore = Math.max(keywordScore ?? 0, documentScore);
        }
        if (keywordScore == null && !normalizedQueryEmbedding) continue;
      }
      const vectorScore = vectorScoreByAsset.has(asset.id) ? vectorScoreByAsset.get(asset.id) : null;
      if (!query && normalizedQueryEmbedding && vectorScore == null) continue;
      if (query && normalizedQueryEmbedding && keywordScore == null && vectorScore == null) continue;
      const matches = (documentsByAsset.get(asset.id) || []).slice(0, 3).map((row) => ({
        kind: row.document_kind,
        text: String(row.text || '').slice(0, 600),
        language: row.language || null,
        modelKey: row.model_key,
        modelVersion: row.model_version,
      }));
      eligible.push({ asset, keywordScore, vectorScore, matches });
    }
    const stableScoreSort = (field) => [...eligible]
      .filter((item) => item[field] != null)
      .sort((left, right) => {
        const difference = Number(right[field]) - Number(left[field]);
        if (Math.abs(difference) > Number.EPSILON) return difference;
        return left.asset.id < right.asset.id ? -1 : (left.asset.id > right.asset.id ? 1 : 0);
      });
    const keywordRanks = new Map(stableScoreSort('keywordScore').map((item, index) => [item.asset.id, index + 1]));
    const vectorRanks = new Map(stableScoreSort('vectorScore').map((item, index) => [item.asset.id, index + 1]));
    const isHybrid = Boolean(query && normalizedQueryEmbedding);
    const ranked = eligible.map((item) => {
      const keywordRank = keywordRanks.get(item.asset.id) || null;
      const vectorRank = vectorRanks.get(item.asset.id) || null;
      const score = isHybrid
        ? (keywordRank ? 1 / (60 + keywordRank) : 0) + (vectorRank ? 1 / (60 + vectorRank) : 0)
        : (normalizedQueryEmbedding ? (item.vectorScore ?? -1) : (query ? (item.keywordScore ?? 0) : 0));
      return { ...item, score, keywordRank, vectorRank };
    });
    ranked.sort((left, right) => {
      const scoreDifference = right.score - left.score;
      if (Math.abs(scoreDifference) > Number.EPSILON) return scoreDifference;
      return left.asset.id < right.asset.id ? -1 : (left.asset.id > right.asset.id ? 1 : 0);
    });
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(input.limit) || 50)));
    const offset = Math.min(100_000, Math.max(0, Math.trunc(Number(input.offset) || 0)));
    const pageItems = ranked.slice(offset, offset + limit);
    const evidenceAssetIds = pageItems.filter((item) => item.matches.length === 0).map((item) => item.asset.id);
    if (evidenceAssetIds.length && profile.activeGeneration != null) {
      const activeEvidenceKinds = this._activeSemanticDocumentKinds(profile);
      const documentRows = activeEvidenceKinds.length
        ? this.db.prepare(`
            SELECT d.document_kind, d.text, d.language, d.model_key, d.model_version, d.asset_id
            FROM asset_semantic_documents d
            JOIN assets a ON a.project_id = d.project_id AND a.id = d.asset_id
            WHERE d.project_id = ? AND d.generation = ?
              AND d.document_kind IN (${activeEvidenceKinds.map(() => '?').join(',')})
              AND d.asset_id IN (${evidenceAssetIds.map(() => '?').join(',')})
              AND d.content_hash = a.content_hash
            ORDER BY d.asset_id ASC,
              CASE d.document_kind WHEN 'caption' THEN 0 ELSE 1 END,
              d.id ASC
          `).all(normalizedProjectId, profile.activeGeneration, ...activeEvidenceKinds, ...evidenceAssetIds)
        : [];
      const evidenceByAsset = new Map();
      for (const row of documentRows) {
        const entries = evidenceByAsset.get(row.asset_id) || [];
        if (entries.length >= 3) continue;
        entries.push({
          kind: row.document_kind,
          text: String(row.text || '').slice(0, 600),
          language: row.language || null,
          modelKey: row.model_key,
          modelVersion: row.model_version,
        });
        evidenceByAsset.set(row.asset_id, entries);
      }
      for (const item of pageItems) {
        if (item.matches.length) continue;
        const documents = evidenceByAsset.get(item.asset.id) || [];
        if (documents.length) {
          item.matches = documents;
          continue;
        }
        const tags = (Array.isArray(item.asset.tags) ? item.asset.tags : []).map(String).filter(Boolean).slice(0, 20);
        item.matches = tags.length
          ? [{ kind: 'tag', text: tags.join(', ').slice(0, 600) }]
          : [{ kind: 'filename', text: String(item.asset.filename || item.asset.id).slice(0, 600) }];
      }
    }
    const latestProfile = this.getAssetSemanticProfile(normalizedProjectId);
    const latestCatalogRevision = this.getAssetCatalogRevision(normalizedProjectId);
    if (latestProfile.revision !== profile.revision || latestProfile.activeGeneration !== profile.activeGeneration) {
      throw revisionConflict('asset_semantic_profile_revision_conflict', '语义配置在搜索期间已变化', latestProfile);
    }
    if (latestCatalogRevision !== catalogRevision) {
      throw revisionConflict('asset_catalog_revision_conflict', '素材目录在搜索期间已变化', { catalogRevision: latestCatalogRevision });
    }
    return {
      items: pageItems,
      total: ranked.length,
      limit,
      offset,
      mode: normalizedQueryEmbedding ? (query ? 'hybrid' : 'vector') : (query ? 'keyword' : 'basic'),
      scoreMetric: normalizedQueryEmbedding ? (query ? 'rrf-k60' : 'cosine') : (query ? 'keyword' : 'none'),
      catalogRevision,
      profileRevision: profile.revision,
      generation: profile.activeGeneration,
      documentStrategy: documentSearch.strategy,
    };
  }

  getAssetAccessPolicy(projectId, assetId) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const normalizedAssetId = String(assetId || '');
    const asset = this.db.prepare('SELECT id FROM assets WHERE project_id = ? AND id = ?').get(normalizedProjectId, normalizedAssetId);
    if (!asset) return null;
    const now = Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO asset_access_policies(project_id, asset_id, scope, revision, updated_by, updated_at)
      VALUES (?, ?, 'project', 1, 'system-default', ?)
    `).run(normalizedProjectId, normalizedAssetId, now);
    const policy = this.db.prepare(`
      SELECT * FROM asset_access_policies WHERE project_id = ? AND asset_id = ?
    `).get(normalizedProjectId, normalizedAssetId);
    const grantRows = this.db.prepare(`
      SELECT * FROM asset_access_grants WHERE project_id = ? AND asset_id = ?
      ORDER BY principal_type, LOWER(principal_id), principal_id, permission
    `).all(normalizedProjectId, normalizedAssetId);
    const grouped = new Map();
    for (const row of grantRows) {
      const key = `${row.principal_type}\u0000${row.principal_id}`;
      const current = grouped.get(key) || {
        principalType: row.principal_type,
        principalId: row.principal_id,
        permissions: [],
        grantedBy: row.granted_by,
        createdAt: row.created_at,
      };
      current.permissions.push(row.permission);
      current.createdAt = Math.min(Number(current.createdAt) || row.created_at, Number(row.created_at) || current.createdAt);
      grouped.set(key, current);
    }
    return {
      projectId: policy.project_id,
      assetId: policy.asset_id,
      scope: ASSET_ACCESS_SCOPES.has(policy.scope) ? policy.scope : 'project',
      revision: Math.max(1, Number(policy.revision) || 1),
      grants: [...grouped.values()].map((grant) => ({ ...grant, permissions: [...new Set(grant.permissions)].sort() })),
      updatedBy: policy.updated_by,
      updatedAt: policy.updated_at,
    };
  }

  setAssetAccessPolicy(projectId, assetId, input = {}, options = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const normalizedAssetId = String(assetId || '');
    const scope = String(input.scope || 'project').toLowerCase();
    if (!ASSET_ACCESS_SCOPES.has(scope)) throw new Error('素材访问范围无效');
    const rawGrants = Array.isArray(input.grants) ? input.grants : [];
    const grants = rawGrants.map((grant) => {
      const principalType = String(grant?.principalType || '').toLowerCase();
      const principalId = String(grant?.principalId || '').trim().slice(0, 240);
      const requestedPermissions = Array.isArray(grant?.permissions) ? grant.permissions : [];
      const permissions = normalizeAccessPermissions(requestedPermissions);
      if (!ASSET_ACCESS_PRINCIPALS.has(principalType) || !principalId || !permissions.length
        || permissions.length !== new Set(requestedPermissions.map((permission) => String(permission || '').trim().toLowerCase())).size) {
        throw new Error('素材授权主体或权限无效');
      }
      return { principalType, principalId, permissions };
    });
    const actorId = String(options.actorId || input.updatedBy || 'local-owner').slice(0, 240);
    const requestedRevision = input.expectedRevision == null ? null : Math.max(1, Math.trunc(Number(input.expectedRevision) || 0));
    const now = Date.now();
    const run = this.db.transaction(() => {
      const asset = this.db.prepare('SELECT id FROM assets WHERE project_id = ? AND id = ?').get(normalizedProjectId, normalizedAssetId);
      if (!asset) throw new Error('素材不存在或不属于当前项目');
      const current = this.getAssetAccessPolicy(normalizedProjectId, normalizedAssetId);
      const expectedRevision = requestedRevision == null ? current.revision : requestedRevision;
      if (current.revision !== expectedRevision) {
        throw revisionConflict('asset_access_revision_conflict', '素材访问策略版本冲突', current);
      }
      const updated = this.db.prepare(`
        UPDATE asset_access_policies SET scope = ?, revision = revision + 1, updated_by = ?, updated_at = ?
        WHERE project_id = ? AND asset_id = ? AND revision = ?
      `).run(scope, actorId, now, normalizedProjectId, normalizedAssetId, expectedRevision);
      if (updated.changes !== 1) {
        throw revisionConflict('asset_access_revision_conflict', '素材访问策略版本冲突', this.getAssetAccessPolicy(normalizedProjectId, normalizedAssetId));
      }
      this.db.prepare('DELETE FROM asset_access_grants WHERE project_id = ? AND asset_id = ?').run(normalizedProjectId, normalizedAssetId);
      const insert = this.db.prepare(`
        INSERT INTO asset_access_grants(project_id, asset_id, principal_type, principal_id, permission, granted_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const grant of grants) {
        for (const permission of grant.permissions) {
          insert.run(normalizedProjectId, normalizedAssetId, grant.principalType, grant.principalId, permission, actorId, now);
        }
      }
      this._bumpAssetOrganizationRevision(normalizedAssetId, now);
      this._bumpAssetCatalogRevision(normalizedProjectId, now);
      return this.getAssetAccessPolicy(normalizedProjectId, normalizedAssetId);
    });
    return run.immediate();
  }

  canAccessAsset(projectId, assetId, subject = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const normalizedAssetId = String(assetId || '');
    const { clauses, values } = this._assetListQueryParts({ projectId: normalizedProjectId }, subject);
    clauses.push('a.id = ?');
    values.push(normalizedAssetId);
    return Boolean(this.db.prepare(`SELECT 1 FROM assets a WHERE ${clauses.join(' AND ')} LIMIT 1`).get(...values));
  }

  filterAccessibleAssets(projectId, assets, subject = {}) {
    const candidates = (Array.isArray(assets) ? assets : []).filter(Boolean).slice(0, 1000);
    const ids = [...new Set(candidates.map((asset) => String(asset.id || '')).filter(Boolean))];
    if (!ids.length) return [];
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const { clauses, values } = this._assetListQueryParts({ projectId: normalizedProjectId }, subject);
    clauses.push(`a.id IN (${ids.map(() => '?').join(',')})`);
    const allowed = new Set(this.db.prepare(`SELECT a.id FROM assets a WHERE ${clauses.join(' AND ')}`).all(...values, ...ids).map((row) => row.id));
    return candidates.filter((asset) => String(asset.projectId) === normalizedProjectId && allowed.has(String(asset.id)));
  }

  listAccessibleAssets(filters = {}, subject = {}) {
    const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
    const offset = Math.max(0, Number(filters.offset) || 0);
    const { clauses, values, orderBy } = this._assetListQueryParts(filters, subject);
    const rows = this.db.prepare(`SELECT a.* FROM assets a WHERE ${clauses.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...values, limit, offset);
    return this.hydrateAssetRows(rows);
  }

  countAccessibleAssets(filters = {}, subject = {}) {
    const { clauses, values } = this._assetListQueryParts(filters, subject);
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM assets a WHERE ${clauses.join(' AND ')}`).get(...values).count);
  }

  mapAssetPreviewJob(row) {
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      assetId: row.asset_id,
      contentHash: row.content_hash,
      jobKind: row.job_kind,
      pipelineVersion: row.pipeline_version,
      status: ASSET_PREVIEW_JOB_STATUSES.has(row.status) ? row.status : 'failed',
      attemptCount: Number(row.attempt_count) || 0,
      maxAttempts: Number(row.max_attempts) || 3,
      nextAttemptAt: row.next_attempt_at,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      result: parseJson(row.result_json, {}),
      createdAt: row.created_at,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
    };
  }

  enqueueAssetPreviewJob(input = {}) {
    const asset = this.getAsset(input.assetId);
    if (!asset) throw new Error('素材不存在，无法创建预览任务');
    const contentHash = String(input.contentHash || asset.contentHash || '').trim();
    if (!contentHash || contentHash !== asset.contentHash) throw new Error('预览任务内容哈希与素材不一致');
    const jobKind = String(input.jobKind || '').trim().slice(0, 80);
    const pipelineVersion = String(input.pipelineVersion || '').trim().slice(0, 80);
    if (!jobKind || !pipelineVersion) throw new Error('预览任务缺少 jobKind 或 pipelineVersion');
    const now = Number(input.createdAt) || Date.now();
    const id = String(input.id || `asset-preview-${crypto.randomUUID()}`);
    const maxAttempts = Math.max(1, Math.min(3, Math.trunc(Number(input.maxAttempts) || 3)));
    this.db.prepare(`
      INSERT OR IGNORE INTO asset_preview_jobs(
        id, project_id, asset_id, content_hash, job_kind, pipeline_version, status,
        attempt_count, max_attempts, next_attempt_at, error_code, error_message,
        result_json, created_at, started_at, updated_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL, '{}', ?, NULL, ?, NULL)
    `).run(id, asset.projectId, asset.id, contentHash, jobKind, pipelineVersion, maxAttempts, now, now);
    const row = this.db.prepare(`
      SELECT * FROM asset_preview_jobs
      WHERE asset_id = ? AND content_hash = ? AND job_kind = ? AND pipeline_version = ?
    `).get(asset.id, contentHash, jobKind, pipelineVersion);
    return this.mapAssetPreviewJob(row);
  }

  getAssetPreviewJob(jobId) {
    return this.mapAssetPreviewJob(this.db.prepare('SELECT * FROM asset_preview_jobs WHERE id = ?').get(String(jobId)));
  }

  listAssetPreviewJobs(filters = {}) {
    const clauses = [];
    const values = [];
    if (filters.projectId) { clauses.push('project_id = ?'); values.push(String(filters.projectId)); }
    if (filters.assetId) { clauses.push('asset_id = ?'); values.push(String(filters.assetId)); }
    if (filters.contentHash) { clauses.push('content_hash = ?'); values.push(String(filters.contentHash)); }
    if (filters.jobKind) { clauses.push('job_kind = ?'); values.push(String(filters.jobKind)); }
    if (filters.status) { clauses.push('status = ?'); values.push(String(filters.status)); }
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(filters.limit) || 100)));
    const rows = this.db.prepare(`
      SELECT * FROM asset_preview_jobs
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...values, limit);
    return rows.map((row) => this.mapAssetPreviewJob(row));
  }

  claimNextAssetPreviewJob(input = {}) {
    const now = Number(input.now) || Date.now();
    const excludeJobKind = String(input.excludeJobKind || '').trim().slice(0, 80);
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM asset_preview_jobs
        WHERE status IN ('queued', 'retrying')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ${excludeJobKind ? 'AND job_kind <> ?' : ''}
        ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END, created_at ASC, id ASC
        LIMIT 1
      `).get(...(excludeJobKind ? [now, excludeJobKind] : [now]));
      if (!row) return null;
      const claimed = this.db.prepare(`
        UPDATE asset_preview_jobs
        SET status = 'running', attempt_count = attempt_count + 1, next_attempt_at = NULL,
            error_code = NULL, error_message = NULL, started_at = ?, updated_at = ?, finished_at = NULL
        WHERE id = ? AND status IN ('queued', 'retrying')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      `).run(now, now, row.id, now);
      if (claimed.changes !== 1) return null;
      const assetRow = this.db.prepare('SELECT project_id, content_hash, metadata_json FROM assets WHERE id = ?').get(row.asset_id);
      if (assetRow?.content_hash === row.content_hash) {
        const metadata = { ...parseJson(assetRow.metadata_json, {}), previewStatus: 'running' };
        delete metadata.previewError;
        this.db.prepare('UPDATE assets SET metadata_json = ?, updated_at = ? WHERE id = ? AND content_hash = ?')
          .run(JSON.stringify(metadata), now, row.asset_id, row.content_hash);
        this._bumpAssetCatalogRevision(assetRow.project_id, now);
      }
      return this.getAssetPreviewJob(row.id);
    })();
  }

  patchAssetPreviewState(assetId, contentHash, patch = {}) {
    const expectedContentHash = String(contentHash || '');
    const safePatch = patch && typeof patch === 'object' ? patch : {};
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT project_id, content_hash, metadata_json FROM assets WHERE id = ?').get(String(assetId));
      if (!row || row.content_hash !== expectedContentHash) return null;
      const now = Date.now();
      const metadata = { ...parseJson(row.metadata_json, {}), ...safePatch };
      if (safePatch.previewError == null) delete metadata.previewError;
      const changed = this.db.prepare(`
        UPDATE assets SET metadata_json = ?, updated_at = ? WHERE id = ? AND content_hash = ?
      `).run(JSON.stringify(metadata), now, String(assetId), expectedContentHash);
      if (changed.changes !== 1) return null;
      const asset = this.getAsset(assetId);
      this._replaceAssetFingerprints(asset, safePatch, now);
      this._bumpAssetCatalogRevision(row.project_id, now);
      return this.getAsset(assetId);
    })();
  }

  completeAssetPreviewJob(jobId, result = {}, input = {}) {
    const now = Number(input.now) || Date.now();
    return this.db.transaction(() => {
      const jobRow = this.db.prepare('SELECT * FROM asset_preview_jobs WHERE id = ?').get(String(jobId));
      if (!jobRow) return { applied: false, reason: 'job-missing', job: null };
      if (jobRow.status !== 'running') {
        return { applied: false, reason: 'stale-job-state', job: this.mapAssetPreviewJob(jobRow) };
      }
      const assetRow = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(jobRow.asset_id);
      if (!assetRow) return { applied: false, reason: 'asset-missing', job: null };
      if (assetRow.content_hash !== jobRow.content_hash) {
        const failed = this.db.prepare(`
          UPDATE asset_preview_jobs SET status = 'failed', error_code = 'source-content-changed',
            error_message = '素材内容已变化，旧预览结果未写回', updated_at = ?, finished_at = ?
          WHERE id = ? AND status = 'running'
        `).run(now, now, jobRow.id);
        if (failed.changes !== 1) return { applied: false, reason: 'stale-job-state', job: this.getAssetPreviewJob(jobRow.id) };
        return { applied: false, reason: 'source-content-changed', job: this.getAssetPreviewJob(jobRow.id) };
      }
      const safeResult = result && typeof result === 'object' ? result : {};
      const completed = this.db.prepare(`
        UPDATE asset_preview_jobs SET status = 'succeeded', result_json = ?, error_code = NULL,
          error_message = NULL, next_attempt_at = NULL, updated_at = ?, finished_at = ?
        WHERE id = ? AND status = 'running'
      `).run(JSON.stringify(safeResult), now, now, jobRow.id);
      if (completed.changes !== 1) {
        return { applied: false, reason: 'stale-job-state', job: this.getAssetPreviewJob(jobRow.id) };
      }
      const metadata = { ...parseJson(assetRow.metadata_json, {}), ...safeResult, previewStatus: 'ready' };
      delete metadata.previewError;
      this.db.prepare(`
        UPDATE assets SET metadata_json = ?, updated_at = ? WHERE id = ? AND content_hash = ?
      `).run(JSON.stringify(metadata), now, assetRow.id, jobRow.content_hash);
      this._replaceAssetFingerprints(this.getAsset(assetRow.id), safeResult, now);
      this._bumpAssetCatalogRevision(assetRow.project_id, now);
      return { applied: true, reason: null, job: this.getAssetPreviewJob(jobRow.id), asset: this.getAsset(assetRow.id) };
    })();
  }

  rescheduleAssetPreviewJob(jobId, error = {}, input = {}) {
    const now = Number(input.now) || Date.now();
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM asset_preview_jobs WHERE id = ?').get(String(jobId));
      if (!row) return null;
      if (row.status !== 'running') return this.mapAssetPreviewJob(row);
      const retryable = input.retryable !== false && Number(row.attempt_count) < Number(row.max_attempts);
      const status = retryable ? 'retrying' : 'failed';
      const nextAttemptAt = retryable ? Math.max(now, Number(input.nextAttemptAt) || now) : null;
      const code = String(error.code || (retryable ? 'preview-retry' : 'preview-failed')).slice(0, 120);
      const message = String(error.message || '预览生成失败').slice(0, 600);
      const changed = this.db.prepare(`
        UPDATE asset_preview_jobs SET status = ?, next_attempt_at = ?, error_code = ?, error_message = ?,
          updated_at = ?, finished_at = ? WHERE id = ? AND status = 'running'
      `).run(status, nextAttemptAt, code, message, now, retryable ? null : now, row.id);
      if (changed.changes !== 1) return this.getAssetPreviewJob(row.id);
      const assetRow = this.db.prepare('SELECT project_id, content_hash, metadata_json FROM assets WHERE id = ?').get(row.asset_id);
      if (assetRow?.content_hash === row.content_hash) {
        const metadata = { ...parseJson(assetRow.metadata_json, {}), previewStatus: status, previewError: message };
        this.db.prepare('UPDATE assets SET metadata_json = ?, updated_at = ? WHERE id = ? AND content_hash = ?')
          .run(JSON.stringify(metadata), now, row.asset_id, row.content_hash);
        if (status === 'failed') this._replaceAssetFingerprints(this.getAsset(row.asset_id), { clearFingerprints: true }, now);
        this._bumpAssetCatalogRevision(assetRow.project_id, now);
      }
      return this.getAssetPreviewJob(row.id);
    })();
  }

  retryAssetPreviewJobs(assetId, contentHash = null, input = {}) {
    const asset = this.getAsset(assetId);
    if (!asset) return [];
    const expectedHash = String(contentHash || asset.contentHash || '');
    if (!expectedHash || expectedHash !== asset.contentHash) return [];
    const now = Number(input.now) || Date.now();
    this.db.prepare(`
      UPDATE asset_preview_jobs SET status = 'queued', attempt_count = 0, next_attempt_at = NULL,
        error_code = NULL, error_message = NULL, result_json = '{}', started_at = NULL,
        updated_at = ?, finished_at = NULL
      WHERE asset_id = ? AND content_hash = ? AND status = 'failed'
    `).run(now, asset.id, expectedHash);
    this.patchAssetPreviewState(asset.id, expectedHash, { previewStatus: 'queued', previewError: null });
    return this.listAssetPreviewJobs({ assetId: asset.id, contentHash: expectedHash, limit: 100 });
  }

  recoverAssetPreviewJobs(input = {}) {
    const now = Number(input.now) || Date.now();
    let retrying = 0;
    let failed = 0;
    this.db.transaction(() => {
      const changedProjects = new Set();
      const rows = this.db.prepare("SELECT * FROM asset_preview_jobs WHERE status = 'running'").all();
      for (const row of rows) {
        const canRetry = Number(row.attempt_count) < Number(row.max_attempts);
        const status = canRetry ? 'retrying' : 'failed';
        const message = '应用重启后重新排队预览任务';
        this.db.prepare(`
          UPDATE asset_preview_jobs SET status = ?, next_attempt_at = ?, error_code = 'preview-worker-restarted',
            error_message = '应用重启后重新排队预览任务', updated_at = ?, finished_at = ? WHERE id = ?
        `).run(status, canRetry ? now : null, now, canRetry ? null : now, row.id);
        const assetRow = this.db.prepare('SELECT project_id, content_hash, metadata_json FROM assets WHERE id = ?').get(row.asset_id);
        if (assetRow?.content_hash === row.content_hash) {
          const metadata = { ...parseJson(assetRow.metadata_json, {}), previewStatus: status, previewError: message };
          this.db.prepare('UPDATE assets SET metadata_json = ?, updated_at = ? WHERE id = ? AND content_hash = ?')
            .run(JSON.stringify(metadata), now, row.asset_id, row.content_hash);
          if (status === 'failed') this._replaceAssetFingerprints(this.getAsset(row.asset_id), { clearFingerprints: true }, now);
          changedProjects.add(assetRow.project_id);
        }
        if (canRetry) retrying += 1; else failed += 1;
      }
      changedProjects.forEach((projectId) => this._bumpAssetCatalogRevision(projectId, now));
    })();
    return { recovered: retrying, failed };
  }

  getAssetPreviewJobStatus(filters = {}) {
    const where = filters.projectId ? 'WHERE project_id = ?' : '';
    const values = filters.projectId ? [String(filters.projectId)] : [];
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS count FROM asset_preview_jobs ${where} GROUP BY status`).all(...values);
    const counts = { queued: 0, running: 0, retrying: 0, succeeded: 0, failed: 0 };
    rows.forEach((row) => { if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.count) || 0; });
    const next = this.db.prepare(`
      SELECT MIN(next_attempt_at) AS next_attempt_at FROM asset_preview_jobs
      ${filters.projectId ? "WHERE project_id = ? AND status = 'retrying'" : "WHERE status = 'retrying'"}
    `).get(...values);
    return { counts, nextAttemptAt: next?.next_attempt_at || undefined };
  }

  removeAssetIndex(assetId) {
    return this.db.transaction(() => {
      const current = this.getAsset(assetId);
      if (!current) return null;
      const now = Date.now();
      const blobRef = this.db.prepare('SELECT blob_id FROM asset_blob_refs WHERE asset_id = ?').get(current.id);
      this.db.prepare(`
        INSERT INTO asset_lineage_tombstones(id, project_id, entity_uid, filename, kind, mime_type, content_hash, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_id=excluded.project_id, entity_uid=excluded.entity_uid, filename=excluded.filename,
          kind=excluded.kind, mime_type=excluded.mime_type, content_hash=excluded.content_hash,
          deleted_at=excluded.deleted_at
      `).run(
        current.id, current.projectId, current.entityUid || null, current.filename,
        current.kind, current.mimeType || null, normalizeSha256(current.contentHash), now,
      );
      this.db.prepare('DELETE FROM assets WHERE id = ?').run(current.id);
      this._cleanupOrphanAssetBlob(blobRef?.blob_id);
      this._bumpAssetCatalogRevision(current.projectId, now);
      return current;
    })();
  }

  findAssetBySourceLocator(projectId, sourceLocator, options = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const normalizedLocator = opaqueSourceLocator(sourceLocator);
    if (!normalizedLocator) return null;
    const clauses = ['project_id = ?', 'source_locator = ?'];
    const values = [normalizedProjectId, normalizedLocator];
    if (options.contentHash) {
      const contentHash = normalizeSha256(options.contentHash);
      if (!contentHash) return null;
      clauses.push('content_hash = ?');
      values.push(contentHash);
    }
    if (options.includeReplaced !== true) {
      clauses.push("COALESCE(json_extract(metadata_json, '$.sourceState'), 'current') <> 'replaced'");
    }
    const row = this.db.prepare(`
      SELECT * FROM assets WHERE ${clauses.join(' AND ')}
      ORDER BY CASE WHEN COALESCE(json_extract(metadata_json, '$.sourceState'), 'current') = 'replaced' THEN 1 ELSE 0 END,
        updated_at DESC, id DESC LIMIT 1
    `).get(...values);
    return row ? this.hydrateAssetRows([row])[0] : null;
  }

  findAssetBySourceUrl(projectId, sourceUrl) {
    const row = this.db.prepare(`
      SELECT * FROM assets WHERE project_id = ? AND source_url = ?
        AND COALESCE(json_extract(metadata_json, '$.sourceState'), 'current') <> 'replaced'
      ORDER BY updated_at DESC, id DESC LIMIT 1
    `)
      .get(String(projectId || DEFAULT_PROJECT_ID), String(sourceUrl || ''));
    return row ? this.hydrateAssetRows([row])[0] : null;
  }

  findAssetsBySourceUrls(projectId, sourceUrls = []) {
    const normalized = [...new Set((Array.isArray(sourceUrls) ? sourceUrls : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean))].slice(0, MAX_ASSET_REFERENCES);
    if (!normalized.length) return [];
    const rows = [];
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    for (let index = 0; index < normalized.length; index += 400) {
      const batch = normalized.slice(index, index + 400);
      rows.push(...this.db.prepare(`
        SELECT * FROM assets WHERE project_id = ? AND source_url IN (${batch.map(() => '?').join(',')})
          AND COALESCE(json_extract(metadata_json, '$.sourceState'), 'current') <> 'replaced'
      `).all(normalizedProjectId, ...batch));
    }
    rows.sort((left, right) => (
      Number(right.updated_at) - Number(left.updated_at)
      || String(right.id).localeCompare(String(left.id))
    ));
    return this.hydrateAssetRows(rows);
  }

  replaceAssetAtSource(oldAssetId, nextInput = {}, lineageInput = {}) {
    const run = this.db.transaction(() => {
      const previousAsset = this.getAsset(oldAssetId);
      if (!previousAsset) throw new Error('待替换的来源素材不存在');
      const projectId = String(nextInput.projectId || previousAsset.projectId);
      if (projectId !== previousAsset.projectId) throw new Error('来源替换不能跨项目');
      const sourceLocator = opaqueSourceLocator(nextInput.sourceLocator || previousAsset.sourceLocator);
      if (!sourceLocator || (previousAsset.sourceLocator && sourceLocator !== previousAsset.sourceLocator)) {
        throw new Error('来源替换的 locator 不一致');
      }
      const contentHash = normalizeSha256(nextInput.contentHash);
      if (!contentHash) throw new Error('来源替换需要完整 SHA-256');
      const now = Number(nextInput.updatedAt) || Date.now();
      const currentMetadata = previousAsset.metadata && typeof previousAsset.metadata === 'object' ? previousAsset.metadata : {};
      if (normalizeSha256(previousAsset.contentHash) === contentHash) {
        const metadata = { ...currentMetadata, ...(nextInput.metadata || {}), sourceState: 'current' };
        delete metadata.replacedAt;
        delete metadata.replacedByAssetId;
        const asset = this.upsertAsset({ ...nextInput, id: previousAsset.id, projectId, sourceLocator, contentHash, metadata });
        return { asset, previousAsset, changed: false, reusedHistorical: false };
      }

      let historical = this.findAssetBySourceLocator(projectId, sourceLocator, { contentHash, includeReplaced: true });
      if (historical?.id === previousAsset.id) historical = null;
      const targetId = String(historical?.id || nextInput.id || `asset_${crypto.createHash('sha256').update(stableJson([
        projectId, sourceLocator, contentHash,
      ])).digest('hex').slice(0, 32)}`);
      const replacedMetadata = {
        ...currentMetadata,
        sourceState: 'replaced',
        replacedAt: now,
        replacedByAssetId: targetId,
      };
      this.db.prepare(`
        UPDATE assets SET managed_path = NULL, source_url = NULL, availability = 'missing',
          metadata_json = ?, updated_at = ? WHERE project_id = ? AND id = ?
      `).run(JSON.stringify(replacedMetadata), now, projectId, previousAsset.id);
      this._bumpAssetOrganizationRevision(previousAsset.id, now);

      const historicalMetadata = historical?.metadata && typeof historical.metadata === 'object' ? historical.metadata : {};
      const metadata = { ...historicalMetadata, ...(nextInput.metadata || {}), sourceState: 'current' };
      delete metadata.replacedAt;
      delete metadata.replacedByAssetId;
      const asset = this.upsertAsset({
        ...(historical || {}),
        ...nextInput,
        id: targetId,
        projectId,
        sourceLocator,
        contentHash,
        metadata,
        availability: nextInput.availability || 'available',
      });
      const lineageMetadata = {
        ...(lineageInput.metadata && typeof lineageInput.metadata === 'object' ? lineageInput.metadata : {}),
        sourceLocator,
        replacedAssetId: previousAsset.id,
        reusedHistorical: Boolean(historical),
      };
      this.recordAssetLineageEvent({
        ...lineageInput,
        id: undefined,
        assetId: asset.id,
        // Re-activating an older version (A -> B -> A) must not introduce a
        // lineage cycle. The replacement source remains in safe metadata.
        parentAssetId: historical ? null : previousAsset.id,
        sourceType: lineageInput.sourceType || 'source-replacement',
        derivedOperation: lineageInput.derivedOperation || 'replace-at-source',
        metadata: lineageMetadata,
        strictReferences: true,
      });
      return { asset: this.getAsset(asset.id), previousAsset, changed: true, reusedHistorical: Boolean(historical) };
    });
    return run.immediate();
  }

  updateAssetAvailability(assetId, availability, metadataPatch = null) {
    return this.db.transaction(() => {
      const current = this.getAsset(assetId);
      if (!current) return null;
      const nextAvailability = normalizeAssetAvailability(availability, current.storageMode);
      const metadata = metadataPatch && typeof metadataPatch === 'object'
        ? { ...current.metadata, ...metadataPatch }
        : current.metadata;
      if (nextAvailability === current.availability && stableJson(metadata) === stableJson(current.metadata)) return current;
      const now = Date.now();
      this.db.prepare('UPDATE assets SET availability = ?, metadata_json = ?, updated_at = ? WHERE id = ?')
        .run(nextAvailability, JSON.stringify(metadata), now, current.id);
      this._bumpAssetOrganizationRevision(current.id, now);
      this._bumpAssetCatalogRevision(current.projectId, now);
      return this.getAsset(current.id);
    })();
  }

  refreshAssetAvailability(projectId = DEFAULT_PROJECT_ID) {
    const rows = this.db.prepare(`
      SELECT id, managed_path, storage_mode, availability, metadata_json
      FROM assets WHERE project_id = ? AND storage_mode IN ('managed', 'linked')
    `).all(String(projectId));
    let missing = 0;
    let restored = 0;
    const update = this.db.prepare('UPDATE assets SET availability = ?, metadata_json = ?, updated_at = ? WHERE id = ?');
    this.db.transaction(() => {
      const changedIds = [];
      const now = Date.now();
      for (const row of rows) {
        if (!row.managed_path) continue;
        const exists = fs.existsSync(row.managed_path);
        const metadata = parseJson(row.metadata_json, {});
        if (!exists && row.availability !== 'missing') {
          update.run('missing', JSON.stringify({ ...metadata, health: 'missing', missingSince: now }), now, row.id);
          changedIds.push(row.id);
          missing += 1;
        } else if (exists && row.availability === 'missing') {
          const { missingSince: _missingSince, ...restoredMetadata } = metadata;
          update.run('available', JSON.stringify({ ...restoredMetadata, health: restoredMetadata.health === 'missing' ? 'ok' : restoredMetadata.health }), now, row.id);
          changedIds.push(row.id);
          restored += 1;
        }
      }
      if (changedIds.length) {
        this._bumpAssetOrganizationRevision(changedIds, now);
        this._bumpAssetCatalogRevision(String(projectId), now);
      }
    })();
    return { checked: rows.length, missing, restored };
  }

  setAssetTags(assetId, tags = [], options = {}) {
    const normalized = normalizeTags(tags);
    const normalizedAssetId = String(assetId || '');
    const run = this.db.transaction(() => {
      const asset = this.getAsset(normalizedAssetId);
      if (!asset) throw new Error('素材不存在');
      const expectedRevision = options.expectedRevision == null
        ? asset.organizationRevision
        : Math.max(1, Math.trunc(Number(options.expectedRevision) || 0));
      if (asset.organizationRevision !== expectedRevision) {
        throw revisionConflict('asset_organization_revision_conflict', '素材组织版本冲突', asset);
      }
      const now = Date.now();
      this.db.prepare('DELETE FROM asset_tags WHERE asset_id = ?').run(normalizedAssetId);
      const insert = this.db.prepare('INSERT INTO asset_tags(asset_id, tag, created_at) VALUES (?, ?, ?)');
      normalized.forEach((tag) => insert.run(normalizedAssetId, tag, now));
      const updated = this.db.prepare(`
        UPDATE assets SET organization_revision = organization_revision + 1, updated_at = ?
        WHERE id = ? AND project_id = ? AND organization_revision = ?
      `).run(now, normalizedAssetId, asset.projectId, expectedRevision);
      if (updated.changes !== 1) {
        throw revisionConflict('asset_organization_revision_conflict', '素材组织版本冲突', this.getAsset(normalizedAssetId));
      }
      this._bumpAssetCatalogRevision(asset.projectId, now);
      return this.getAsset(normalizedAssetId);
    });
    return run.immediate();
  }

  listAssetTags(projectId = DEFAULT_PROJECT_ID, options = {}) {
    const limit = Math.min(1000, Math.max(1, Math.trunc(Number(options.limit) || 500)));
    return this.db.prepare(`
      SELECT t.tag, COUNT(*) AS count
      FROM asset_tags t JOIN assets a ON a.id = t.asset_id
      WHERE a.project_id = ?
      GROUP BY LOWER(t.tag)
      ORDER BY count DESC, LOWER(t.tag) ASC, t.tag ASC
      LIMIT ?
    `).all(String(projectId || DEFAULT_PROJECT_ID), limit).map((row) => ({ tag: row.tag, count: Number(row.count) || 0 }));
  }

  _mapAssetCollectionRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      description: row.description,
      revision: Math.max(1, Number(row.revision) || 1),
      createdBy: row.created_by,
      assetCount: Number(row.asset_count) || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getAssetCollection(collectionId, projectId = null) {
    const clauses = ['c.id = ?'];
    const values = [String(collectionId || '')];
    if (projectId != null) { clauses.push('c.project_id = ?'); values.push(String(projectId)); }
    return this._mapAssetCollectionRow(this.db.prepare(`
      SELECT c.*, COUNT(m.asset_id) AS asset_count
      FROM asset_collections c LEFT JOIN asset_collection_members m ON m.collection_id = c.id
      WHERE ${clauses.join(' AND ')} GROUP BY c.id
    `).get(...values));
  }

  createAssetCollection(input = {}) {
    const now = Date.now();
    const collection = { id: String(input.id || crypto.randomUUID()), projectId: String(input.projectId || DEFAULT_PROJECT_ID), name: String(input.name || '').trim().slice(0, 160), description: String(input.description || '').trim().slice(0, 2000), createdBy: String(input.createdBy || 'local-owner'), createdAt: now, updatedAt: now };
    if (!collection.name) throw new Error('集合名称不能为空');
    const run = this.db.transaction(() => {
      this.db.prepare('INSERT INTO asset_collections(id, project_id, name, description, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)').run(collection.id, collection.projectId, collection.name, collection.description, collection.createdBy, now, now);
      this._bumpAssetCatalogRevision(collection.projectId, now);
      return this.getAssetCollection(collection.id, collection.projectId);
    });
    return run.immediate();
  }

  listAssetCollections(projectId = DEFAULT_PROJECT_ID) {
    return this.db.prepare(`SELECT c.*, COUNT(m.asset_id) AS asset_count FROM asset_collections c LEFT JOIN asset_collection_members m ON m.collection_id = c.id WHERE c.project_id = ? GROUP BY c.id ORDER BY c.updated_at DESC, c.id DESC`).all(String(projectId)).map((row) => this._mapAssetCollectionRow(row));
  }

  updateAssetCollection(collectionId, patch = {}, options = {}) {
    const run = this.db.transaction(() => {
      const current = this.getAssetCollection(collectionId, options.projectId);
      if (!current) throw new Error('素材集合不存在');
      const requestedRevision = patch.expectedRevision ?? options.expectedRevision;
      const expectedRevision = requestedRevision == null ? current.revision : Math.trunc(Number(requestedRevision));
      if (current.revision !== expectedRevision) {
        throw revisionConflict('asset_collection_revision_conflict', '素材集合版本冲突', current);
      }
      const name = Object.hasOwn(patch, 'name') ? String(patch.name || '').trim().slice(0, 160) : current.name;
      const description = Object.hasOwn(patch, 'description') ? String(patch.description || '').trim().slice(0, 2000) : current.description;
      if (!name) throw new Error('集合名称不能为空');
      const now = Date.now();
      const updated = this.db.prepare(`
        UPDATE asset_collections SET name = ?, description = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND project_id = ? AND revision = ?
      `).run(name, description, now, current.id, current.projectId, expectedRevision);
      if (updated.changes !== 1) {
        throw revisionConflict('asset_collection_revision_conflict', '素材集合版本冲突', this.getAssetCollection(current.id, current.projectId));
      }
      this._bumpAssetCatalogRevision(current.projectId, now);
      return this.getAssetCollection(current.id, current.projectId);
    });
    return run.immediate();
  }

  deleteAssetCollection(collectionId, options = {}) {
    const run = this.db.transaction(() => {
      const current = this.getAssetCollection(collectionId, options.projectId);
      if (!current) return null;
      const expectedRevision = options.expectedRevision == null ? current.revision : Math.trunc(Number(options.expectedRevision));
      if (current.revision !== expectedRevision) {
        throw revisionConflict('asset_collection_revision_conflict', '素材集合版本冲突', current);
      }
      const memberIds = this.db.prepare('SELECT asset_id FROM asset_collection_members WHERE collection_id = ?').all(current.id).map((row) => row.asset_id);
      const removed = this.db.prepare('DELETE FROM asset_collections WHERE id = ? AND project_id = ? AND revision = ?')
        .run(current.id, current.projectId, expectedRevision);
      if (removed.changes !== 1) {
        throw revisionConflict('asset_collection_revision_conflict', '素材集合版本冲突', this.getAssetCollection(current.id, current.projectId));
      }
      const now = Date.now();
      if (memberIds.length) this._bumpAssetOrganizationRevision(memberIds, now);
      this._bumpAssetCatalogRevision(current.projectId, now);
      return current;
    });
    return run.immediate();
  }

  setAssetCollectionMembers(collectionId, assetIds = [], options = {}) {
    const normalized = [...new Set((Array.isArray(assetIds) ? assetIds : []).map(String))];
    const run = this.db.transaction(() => {
      const collection = this.db.prepare('SELECT * FROM asset_collections WHERE id = ?').get(String(collectionId));
      if (!collection) throw new Error('素材集合不存在');
      const currentRevision = Math.max(1, Number(collection.revision) || 1);
      const expectedRevision = options.expectedRevision == null ? currentRevision : Math.trunc(Number(options.expectedRevision));
      if (currentRevision !== expectedRevision) {
        throw revisionConflict('asset_collection_revision_conflict', '素材集合版本冲突', this.getAssetCollection(collection.id));
      }
      const existing = normalized.length ? this.db.prepare(`SELECT id FROM assets WHERE project_id = ? AND id IN (${normalized.map(() => '?').join(',')})`).all(collection.project_id, ...normalized).map((row) => row.id) : [];
      if (existing.length !== normalized.length) throw new Error('集合包含不存在或跨项目素材');
      const now = Date.now();
      const previous = this.db.prepare('SELECT asset_id FROM asset_collection_members WHERE collection_id = ?').all(collection.id).map((row) => row.asset_id);
      this.db.prepare('DELETE FROM asset_collection_members WHERE collection_id = ?').run(collection.id);
      const insert = this.db.prepare('INSERT INTO asset_collection_members(collection_id, asset_id, added_at) VALUES (?, ?, ?)');
      existing.forEach((assetId) => insert.run(collection.id, assetId, now));
      const updated = this.db.prepare('UPDATE asset_collections SET revision = revision + 1, updated_at = ? WHERE id = ? AND project_id = ? AND revision = ?')
        .run(now, collection.id, collection.project_id, expectedRevision);
      if (updated.changes !== 1) {
        throw revisionConflict('asset_collection_revision_conflict', '素材集合版本冲突', this.getAssetCollection(collection.id, collection.project_id));
      }
      this._bumpAssetOrganizationRevision([...previous, ...existing], now);
      this._bumpAssetCatalogRevision(collection.project_id, now);
      return this.listAssets({ projectId: collection.project_id, collectionId: collection.id, limit: 500 });
    });
    return run.immediate();
  }

  addAssetCollectionMember(collectionId, assetId, options = {}) {
    const run = this.db.transaction(() => {
      const collection = this.db.prepare('SELECT * FROM asset_collections WHERE id = ?').get(String(collectionId));
      const asset = this.getAsset(assetId);
      if (!collection || !asset || collection.project_id !== asset.projectId) throw new Error('集合或素材不存在，或不属于同一项目');
      const currentRevision = Math.max(1, Number(collection.revision) || 1);
      const expectedRevision = options.expectedRevision == null ? currentRevision : Math.trunc(Number(options.expectedRevision));
      if (currentRevision !== expectedRevision) {
        throw revisionConflict('asset_collection_revision_conflict', '素材集合版本冲突', this.getAssetCollection(collection.id));
      }
      const now = Date.now();
      const change = this.db.prepare('INSERT OR IGNORE INTO asset_collection_members(collection_id, asset_id, added_at) VALUES (?, ?, ?)').run(collection.id, asset.id, now);
      if (change.changes) {
        const updated = this.db.prepare('UPDATE asset_collections SET revision = revision + 1, updated_at = ? WHERE id = ? AND project_id = ? AND revision = ?')
          .run(now, collection.id, collection.project_id, expectedRevision);
        if (updated.changes !== 1) {
          throw revisionConflict('asset_collection_revision_conflict', '素材集合版本冲突', this.getAssetCollection(collection.id, collection.project_id));
        }
        this._bumpAssetOrganizationRevision(asset.id, now);
        this._bumpAssetCatalogRevision(collection.project_id, now);
      }
      return this.getAsset(asset.id);
    });
    return run.immediate();
  }

  removeAssetCollectionMember(collectionId, assetId, options = {}) {
    const run = this.db.transaction(() => {
      const collection = this.db.prepare('SELECT * FROM asset_collections WHERE id = ?').get(String(collectionId));
      const asset = this.getAsset(assetId);
      if (!collection || !asset || collection.project_id !== asset.projectId) throw new Error('集合或素材不存在，或不属于同一项目');
      const currentRevision = Math.max(1, Number(collection.revision) || 1);
      const expectedRevision = options.expectedRevision == null ? currentRevision : Math.trunc(Number(options.expectedRevision));
      if (currentRevision !== expectedRevision) {
        throw revisionConflict('asset_collection_revision_conflict', '素材集合版本冲突', this.getAssetCollection(collection.id));
      }
      const now = Date.now();
      const change = this.db.prepare('DELETE FROM asset_collection_members WHERE collection_id = ? AND asset_id = ?').run(collection.id, asset.id);
      if (change.changes) {
        const updated = this.db.prepare('UPDATE asset_collections SET revision = revision + 1, updated_at = ? WHERE id = ? AND project_id = ? AND revision = ?')
          .run(now, collection.id, collection.project_id, expectedRevision);
        if (updated.changes !== 1) {
          throw revisionConflict('asset_collection_revision_conflict', '素材集合版本冲突', this.getAssetCollection(collection.id, collection.project_id));
        }
        this._bumpAssetOrganizationRevision(asset.id, now);
        this._bumpAssetCatalogRevision(collection.project_id, now);
      }
      return this.getAsset(asset.id);
    });
    return run.immediate();
  }

  _mapAssetLineageRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      eventId: row.id,
      childAssetId: row.asset_id,
      targetAssetId: row.asset_id,
      parentAssetId: row.parent_asset_id,
      sourceAssetId: row.parent_asset_id,
      relation: row.derived_operation || row.source_type,
      sourceType: row.source_type,
      sourceNodeId: row.source_node_id,
      sourceNodeType: row.source_node_type,
      runId: row.run_id,
      nodeRunId: row.node_run_id,
      attemptId: row.attempt_id,
      canvasId: row.canvas_id,
      creatorId: row.creator_id,
      promptSummary: row.prompt_summary,
      promptDigest: row.prompt_digest,
      derivedOperation: row.derived_operation,
      metadata: parseJson(row.metadata_json, {}),
      createdAt: row.created_at,
    };
  }

  _assetLineageWouldCycle(projectId, childAssetId, parentAssetId, maxNodes = ASSET_SOURCE_GRAPH_HARD_LIMIT) {
    const childId = String(childAssetId || '');
    const parentId = String(parentAssetId || '');
    if (!childId || !parentId) return false;
    if (childId === parentId) return true;
    const visited = new Set([childId]);
    let frontier = [childId];
    while (frontier.length && visited.size <= maxNodes) {
      const next = [];
      for (let offset = 0; offset < frontier.length; offset += 400) {
        const chunk = frontier.slice(offset, offset + 400);
        const rows = this.db.prepare(`
          SELECT DISTINCT asset_id FROM asset_lineage_events
          WHERE project_id = ? AND parent_asset_id IN (${chunk.map(() => '?').join(',')})
          ORDER BY asset_id
        `).all(String(projectId), ...chunk);
        for (const row of rows) {
          if (row.asset_id === parentId) return true;
          if (!visited.has(row.asset_id)) {
            visited.add(row.asset_id);
            next.push(row.asset_id);
            if (visited.size > maxNodes) throw new Error('lineage 图过大，无法安全验证环');
          }
        }
      }
      frontier = next;
    }
    return false;
  }

  recordAssetLineageEvent(input = {}) {
    const run = this.db.transaction(() => {
      const asset = this.getAsset(input.assetId || input.childAssetId);
      const parent = input.parentAssetId ? this.getAsset(input.parentAssetId) : null;
      if (!asset || (input.parentAssetId && (!parent || parent.projectId !== asset.projectId))) {
        throw new Error('lineage 素材不存在或不属于同一项目');
      }
      if (parent && this._assetLineageWouldCycle(asset.projectId, asset.id, parent.id)) {
        throw new Error(parent.id === asset.id ? 'lineage 不允许素材引用自身' : 'lineage 不允许形成循环');
      }

      let attempt = input.attemptId ? this.getAttempt(input.attemptId) : null;
      if (input.attemptId && !attempt) throw new Error('lineage Attempt 不存在');
      let nodeRun = input.nodeRunId ? this.getNodeRun(input.nodeRunId) : null;
      if (!nodeRun && attempt) nodeRun = this.getNodeRun(attempt.nodeRunId);
      if (input.nodeRunId && !nodeRun) throw new Error('lineage NodeRun 不存在');
      if (attempt && (!nodeRun || attempt.nodeRunId !== nodeRun.id)) throw new Error('lineage Attempt 不属于当前 NodeRun');
      let run = input.runId ? this.getRun(input.runId) : null;
      if (!run && nodeRun) run = this.getRun(nodeRun.runId);
      if (input.runId && !run) throw new Error('lineage Run 不存在');
      if (nodeRun && (!run || nodeRun.runId !== run.id)) throw new Error('lineage NodeRun 不属于当前 Run');
      if (run && run.projectId !== asset.projectId) throw new Error('lineage Run 不属于当前项目');
      const canvasId = String(input.canvasId || run?.canvasId || '').slice(0, 240) || null;
      if (canvasId) {
        if (run?.canvasId && run.canvasId !== canvasId) throw new Error('lineage Canvas 与 Run 不一致');
        const canvas = this.getCanvas(canvasId);
        if (!canvas || canvas.projectId !== asset.projectId) throw new Error('lineage Canvas 不存在或不属于当前项目');
      }

      const sourceType = String(input.sourceType || input.relation || 'derived-from').trim().slice(0, 120) || 'derived-from';
      const sourceNodeId = input.sourceNodeId ? String(input.sourceNodeId).slice(0, 240) : null;
      const sourceNodeType = input.sourceNodeType ? String(input.sourceNodeType).slice(0, 120) : null;
      const derivedOperation = String(input.derivedOperation || input.relation || '').slice(0, 160) || null;
      const promptSummary = String(input.promptSummary || '').replace(/\s+/g, ' ').trim().slice(0, 1200) || null;
      const promptDigest = String(input.promptDigest || (promptSummary ? `sha256:${crypto.createHash('sha256').update(promptSummary).digest('hex')}` : '')).slice(0, 100) || null;
      const createdAt = Number(input.createdAt) || Date.now();
      const identity = stableJson([
        asset.projectId, asset.id, parent?.id || null, sourceType, sourceNodeId, sourceNodeType,
        run?.id || null, nodeRun?.id || null, attempt?.id || null, canvasId, derivedOperation,
      ]);
      // Caller-provided IDs are intentionally ignored. Identity is owned by
      // the service and retries are immutable/idempotent.
      const id = `lineage_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
      this.db.prepare(`
        INSERT OR IGNORE INTO asset_lineage_events(
          id, project_id, asset_id, parent_asset_id, source_type, source_node_id, source_node_type,
          run_id, node_run_id, attempt_id, canvas_id, creator_id, prompt_summary, prompt_digest,
          derived_operation, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        asset.projectId,
        asset.id,
        parent?.id || null,
        sourceType,
        sourceNodeId,
        sourceNodeType,
        run?.id || null,
        nodeRun?.id || null,
        attempt?.id || null,
        canvasId,
        String(input.creatorId || run?.initiatorId || asset.createdBy || 'local-owner').slice(0, 240),
        promptSummary,
        promptDigest,
        derivedOperation,
        JSON.stringify(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
        createdAt,
      );
      if (canvasId) {
        this._upsertCanvasResourceGrant(
          asset.projectId,
          canvasId,
          'asset',
          asset.id,
          0,
          CANVAS_RESOURCE_LINEAGE_SOURCE,
          createdAt,
        );
      }
      // Keep the historical array-shaped return value for internal callers,
      // but never let a write hydrate another project's tombstoned history or
      // grow an unbounded response when a source accumulates many events.
      return this.listAssetLineage(asset.id, { limit: 100 })?.items || [];
    });
    return run.immediate();
  }

  addAssetLineage(input = {}) {
    return this.recordAssetLineageEvent({
      ...input,
      assetId: input.childAssetId,
      sourceType: input.sourceType || input.relation || 'derived-from',
      derivedOperation: input.derivedOperation || input.relation || 'derived-from',
    });
  }

  getAssetLineage(assetId) {
    const rootId = String(assetId || '');
    const asset = this.getAsset(rootId);
    const tombstone = asset ? null : this.db.prepare('SELECT project_id FROM asset_lineage_tombstones WHERE id = ?').get(rootId);
    const projectId = asset?.projectId || tombstone?.project_id;
    if (!projectId) return [];
    return this.db.prepare(`
      SELECT * FROM asset_lineage_events
      WHERE project_id = ? AND (asset_id = ? OR parent_asset_id = ?)
      ORDER BY created_at DESC, id DESC
    `).all(projectId, rootId, rootId).map((row) => this._mapAssetLineageRow(row));
  }

  listAssetLineage(assetId, options = {}) {
    const rootId = String(assetId || '');
    const asset = this.getAsset(rootId);
    if (!asset) return null;
    const requestedLimit = Number(options.limit);
    const limit = Math.max(1, Math.min(100, Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 50));
    const readPage = this.db.transaction(() => {
      const revisionRow = this.db.prepare(`
      SELECT COUNT(*) AS count,
        COALESCE(MAX(created_at), 0) AS max_created,
        COALESCE(MAX(id), '') AS max_id
      FROM asset_lineage_events
      WHERE project_id = ? AND (asset_id = ? OR parent_asset_id = ?)
      `).get(asset.projectId, rootId, rootId);
      const total = Number(revisionRow.count) || 0;
      const lineageRevision = `${total}:${Number(revisionRow.max_created) || 0}:${revisionRow.max_id || ''}`;
      const cursor = decodeCursor(options.cursor, {});
      const cursorCreatedAt = Number(cursor.createdAt);
      const cursorId = typeof cursor.id === 'string' ? cursor.id : '';
      const cursorValid = cursor.assetId === rootId
        && cursor.projectId === asset.projectId
        && cursor.lineageRevision === lineageRevision
        && Number(cursor.limit) === limit
        && Number.isFinite(cursorCreatedAt)
        && Boolean(cursorId);
      if (options.cursor && !cursorValid) {
        throw revisionConflict('asset_lineage_revision_conflict', '素材来源事件已变化，请重新加载', {
          assetId: rootId,
          projectId: asset.projectId,
          lineageRevision,
        });
      }
      const rows = cursorValid
        ? this.db.prepare(`
          SELECT * FROM asset_lineage_events
          WHERE project_id = ? AND (asset_id = ? OR parent_asset_id = ?)
            AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `).all(asset.projectId, rootId, rootId, cursorCreatedAt, cursorCreatedAt, cursorId, limit + 1)
        : this.db.prepare(`
          SELECT * FROM asset_lineage_events
          WHERE project_id = ? AND (asset_id = ? OR parent_asset_id = ?)
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `).all(asset.projectId, rootId, rootId, limit + 1);
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const lastRow = pageRows.at(-1);
      return {
        items: pageRows.map((row) => this._mapAssetLineageRow(row)),
        total,
        limit,
        hasMore,
        nextCursor: hasMore && lastRow ? encodeCursor({
          assetId: rootId,
          projectId: asset.projectId,
          lineageRevision,
          limit,
          createdAt: Number(lastRow.created_at),
          id: lastRow.id,
        }) : null,
        lineageRevision,
      };
    });
    return readPage();
  }

  getAssetSourceGraph(assetId, options = {}) {
    const rootId = String(assetId || '');
    const rootAsset = this.getAsset(rootId);
    const rootTombstone = rootAsset ? null : this.db.prepare('SELECT * FROM asset_lineage_tombstones WHERE id = ?').get(rootId);
    if (!rootAsset && !rootTombstone) return null;
    const projectId = rootAsset?.projectId || rootTombstone.project_id;
    const direction = ['ancestors', 'descendants', 'both'].includes(String(options.direction)) ? String(options.direction) : 'both';
    const requestedDepth = Number(options.maxDepth);
    const maxDepth = Math.max(0, Math.min(50, Number.isFinite(requestedDepth) ? Math.trunc(requestedDepth) : 8));
    const requestedNodes = Number(options.maxNodes);
    // An edge needs two endpoint nodes; a one-node budget cannot represent a
    // graph page without silently losing the edge.
    const maxNodes = Math.max(2, Math.min(500, Number.isFinite(requestedNodes) ? Math.trunc(requestedNodes) : 100));
    const graphRevisionRow = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(MAX(created_at), 0) AS max_created, COALESCE(MAX(id), '') AS max_id
      FROM asset_lineage_events WHERE project_id = ?
    `).get(projectId);
    const graphRevision = `${Number(graphRevisionRow.count) || 0}:${Number(graphRevisionRow.max_created) || 0}:${graphRevisionRow.max_id || ''}`;
    const cursor = decodeCursor(options.cursor, {});
    const cursorValid = cursor.rootAssetId === rootId
      && cursor.direction === direction
      && Number(cursor.maxDepth) === maxDepth
      && Number(cursor.maxNodes) === maxNodes
      && cursor.graphRevision === graphRevision;
    if (options.cursor && !cursorValid) {
      throw revisionConflict('asset_source_graph_revision_conflict', '素材来源图已变化，请重新加载', { graphRevision });
    }
    const nodeOffset = cursorValid ? Math.max(0, Math.trunc(Number(cursor.nodeOffset) || 0)) : 0;
    const edgeOffset = cursorValid ? Math.max(0, Math.trunc(Number(cursor.edgeOffset) || 0)) : 0;
    const nodeState = new Map([[rootId, { id: rootId, depth: 0, direction: 'root' }]]);
    const edges = new Map();
    const queue = [];
    if (direction === 'ancestors' || direction === 'both') queue.push({ id: rootId, depth: 0, direction: 'ancestors' });
    if (direction === 'descendants' || direction === 'both') queue.push({ id: rootId, depth: 0, direction: 'descendants' });
    const expanded = new Set();
    let hardTruncated = false;
    while (queue.length) {
      const seed = queue.shift();
      if (seed.depth >= maxDepth) continue;
      const batch = [seed];
      for (let index = 0; index < queue.length && batch.length < 400;) {
        const candidate = queue[index];
        if (candidate.direction === seed.direction && candidate.depth === seed.depth) {
          batch.push(candidate);
          queue.splice(index, 1);
        } else index += 1;
      }
      const currentById = new Map();
      for (const current of batch) {
        const expansionKey = `${current.direction}:${current.id}`;
        if (expanded.has(expansionKey)) continue;
        expanded.add(expansionKey);
        currentById.set(current.id, current);
      }
      const currentIds = [...currentById.keys()];
      if (!currentIds.length) continue;
      const rows = seed.direction === 'ancestors'
        ? this.db.prepare(`
            SELECT * FROM asset_lineage_events WHERE project_id = ?
              AND asset_id IN (${currentIds.map(() => '?').join(',')})
            ORDER BY asset_id, created_at ASC, id ASC
          `).all(projectId, ...currentIds)
        : this.db.prepare(`
            SELECT * FROM asset_lineage_events WHERE project_id = ?
              AND parent_asset_id IN (${currentIds.map(() => '?').join(',')})
            ORDER BY parent_asset_id, created_at ASC, id ASC
          `).all(projectId, ...currentIds);
      for (const row of rows) {
        const currentId = seed.direction === 'ancestors' ? row.asset_id : row.parent_asset_id;
        const current = currentById.get(currentId);
        if (!current) continue;
        edges.set(row.id, row);
        const nextId = seed.direction === 'ancestors' ? row.parent_asset_id : row.asset_id;
        if (!nextId) continue;
        const depth = current.depth + 1;
        const existing = nodeState.get(nextId);
        if (!existing || depth < existing.depth) nodeState.set(nextId, { id: nextId, depth, direction: seed.direction });
        if (nodeState.size > ASSET_SOURCE_GRAPH_HARD_LIMIT) {
          hardTruncated = true;
          queue.length = 0;
          break;
        }
        queue.push({ id: nextId, depth, direction: seed.direction });
      }
    }
    const allNodes = [...nodeState.values()].sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id));
    const allEdges = [...edges.values()].sort((left, right) => Number(left.created_at) - Number(right.created_at) || left.id.localeCompare(right.id));
    const adjacency = new Map();
    const indegree = new Map(allNodes.map((node) => [node.id, 0]));
    for (const row of allEdges) {
      if (!row.parent_asset_id) continue;
      const values = adjacency.get(row.parent_asset_id) || new Set();
      if (!values.has(row.asset_id)) {
        values.add(row.asset_id);
        adjacency.set(row.parent_asset_id, values);
        indegree.set(row.parent_asset_id, indegree.get(row.parent_asset_id) || 0);
        indegree.set(row.asset_id, (indegree.get(row.asset_id) || 0) + 1);
      }
    }
    const zero = [...indegree.entries()].filter(([, value]) => value === 0).map(([id]) => id);
    let removedCount = 0;
    while (zero.length) {
      const id = zero.pop();
      removedCount += 1;
      for (const childId of adjacency.get(id) || []) {
        const next = (indegree.get(childId) || 0) - 1;
        indegree.set(childId, next);
        if (next === 0) zero.push(childId);
      }
    }
    const cycleDetected = removedCount < indegree.size;
    const primaryBudget = maxNodes <= 1 ? 1 : Math.max(1, Math.floor(maxNodes / 2));
    const primaryNodes = allNodes.slice(nodeOffset, nodeOffset + primaryBudget);
    const primaryIds = new Set(primaryNodes.map((node) => node.id));
    // Every lineage event is owned by its child endpoint for pagination. An
    // endpoint may be repeated as context, but an edge is emitted exactly once
    // when its owner is in the primary node slice.
    const relevantEdges = allEdges.filter((row) => primaryIds.has(row.asset_id));
    const contextIds = new Set(primaryIds);
    const edgePage = [];
    for (let index = edgeOffset; index < relevantEdges.length && edgePage.length < ASSET_SOURCE_GRAPH_EDGE_PAGE_LIMIT; index += 1) {
      const row = relevantEdges[index];
      const nextIds = new Set(contextIds);
      nextIds.add(row.asset_id);
      if (row.parent_asset_id) nextIds.add(row.parent_asset_id);
      if (nextIds.size > maxNodes) break;
      nextIds.forEach((id) => contextIds.add(id));
      edgePage.push(row);
    }
    const nodeById = new Map(allNodes.map((node) => [node.id, node]));
    const nodePage = [...contextIds].map((id) => nodeById.get(id) || { id, depth: null, direction: 'context' })
      .sort((left, right) => (Number(left.depth) || 0) - (Number(right.depth) || 0) || left.id.localeCompare(right.id));
    const ids = nodePage.map((node) => node.id);
    const assetRows = ids.length ? this.db.prepare(`SELECT * FROM assets WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(projectId, ...ids) : [];
    const assetsById = new Map(this.hydrateAssetRows(assetRows).map((asset) => [asset.id, asset]));
    const tombstoneRows = ids.length ? this.db.prepare(`SELECT * FROM asset_lineage_tombstones WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(projectId, ...ids) : [];
    const tombstonesById = new Map(tombstoneRows.map((row) => [row.id, {
      id: row.id,
      filename: row.filename,
      kind: row.kind,
      mimeType: row.mime_type,
      contentHash: row.content_hash || undefined,
      deletedAt: row.deleted_at,
    }]));
    const moreEdgesForPage = edgePage.length > 0 && edgeOffset + edgePage.length < relevantEdges.length;
    const moreKnownNodes = nodeOffset + primaryNodes.length < allNodes.length;
    const nextCursor = moreEdgesForPage
      ? encodeCursor({ rootAssetId: rootId, direction, maxDepth, maxNodes, graphRevision, nodeOffset, edgeOffset: edgeOffset + edgePage.length })
      : (moreKnownNodes
          ? encodeCursor({ rootAssetId: rootId, direction, maxDepth, maxNodes, graphRevision, nodeOffset: nodeOffset + primaryNodes.length, edgeOffset: 0 })
          : null);
    return {
      rootAssetId: rootId,
      nodes: nodePage.map((node) => ({
        ...node,
        asset: assetsById.get(node.id),
        tombstone: assetsById.has(node.id) ? undefined : tombstonesById.get(node.id),
      })),
      edges: edgePage.map((row) => this._mapAssetLineageRow(row)),
      direction,
      maxDepth,
      maxNodes,
      nextCursor,
      truncated: Boolean(nextCursor) || hardTruncated,
      cycleDetected,
      totalNodes: allNodes.length,
      totalEdges: allEdges.length,
    };
  }

  _hydrateAssetIdsOrdered(ids = []) {
    const normalized = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
    if (!normalized.length) return [];
    const rows = this.db.prepare(`SELECT * FROM assets WHERE id IN (${normalized.map(() => '?').join(',')})`).all(...normalized);
    const byId = new Map(this.hydrateAssetRows(rows).map((asset) => [asset.id, asset]));
    return normalized.map((id) => byId.get(id)).filter(Boolean);
  }

  _nearDuplicateEvidence(sourceAsset, targetAsset, sourceFingerprints, targetFingerprints, maxDistance) {
    if (!sourceFingerprints.length || !targetFingerprints.length) return null;
    const algorithm = sourceFingerprints[0].algorithm;
    if (!algorithm || targetFingerprints.some((entry) => entry.algorithm !== algorithm)) return null;
    const evidenceFor = (source, target, distance) => ({
      sourceFingerprintId: source.id,
      targetFingerprintId: target.id,
      sourceFrameIndex: source.frameIndex,
      targetFrameIndex: target.frameIndex,
      sourceTimestampMs: source.timestampMs,
      targetTimestampMs: target.timestampMs,
      sourceNormalizedTime: source.normalizedTime,
      targetNormalizedTime: target.normalizedTime,
      distance,
    });
    if (sourceAsset.kind !== 'video' || targetAsset.kind !== 'video') {
      let best = null;
      for (const source of sourceFingerprints) {
        for (const target of targetFingerprints) {
          const distance = hammingDistanceHex(source.hash, target.hash);
          if (!best || distance < best.distance || (distance === best.distance && target.id < best.target.id)) best = { source, target, distance };
        }
      }
      if (!best || best.distance > maxDistance) return null;
      return {
        algorithm,
        distance: best.distance,
        aggregateDistance: best.distance,
        evidence: [evidenceFor(best.source, best.target, best.distance)],
        evidenceCount: 1,
        coverage: 1,
        confidence: 'low',
      };
    }
    const sourceSorted = [...sourceFingerprints].sort((left, right) => left.frameIndex - right.frameIndex || left.id.localeCompare(right.id));
    const targetSorted = [...targetFingerprints].sort((left, right) => left.frameIndex - right.frameIndex || left.id.localeCompare(right.id));
    const normalizedTime = (entry, index, length) => entry.normalizedTime == null
      ? (length <= 1 ? 0.5 : index / (length - 1))
      : Math.max(0, Math.min(1, Number(entry.normalizedTime)));
    const candidates = [];
    sourceSorted.forEach((source, sourceIndex) => {
      targetSorted.forEach((target, targetIndex) => {
        const sourceTime = normalizedTime(source, sourceIndex, sourceSorted.length);
        const targetTime = normalizedTime(target, targetIndex, targetSorted.length);
        const timeDelta = Math.abs(sourceTime - targetTime);
        if (timeDelta > 0.15) return;
        candidates.push({ source, target, sourceTime, targetTime, timeDelta, distance: hammingDistanceHex(source.hash, target.hash) });
      });
    });
    candidates.sort((left, right) => left.timeDelta - right.timeDelta || left.distance - right.distance || left.source.id.localeCompare(right.source.id) || left.target.id.localeCompare(right.target.id));
    const usedSource = new Set();
    const usedTarget = new Set();
    const matched = [];
    for (const candidate of candidates) {
      if (usedSource.has(candidate.source.id) || usedTarget.has(candidate.target.id)) continue;
      usedSource.add(candidate.source.id);
      usedTarget.add(candidate.target.id);
      matched.push(candidate);
    }
    const shorterLength = Math.min(sourceSorted.length, targetSorted.length);
    const longerLength = Math.max(sourceSorted.length, targetSorted.length);
    const minimumEvidence = Math.min(3, shorterLength);
    const coverage = longerLength ? matched.length / longerLength : 0;
    const distances = matched.map((entry) => entry.distance);
    const medianDistance = median(distances);
    const aggregateDistance = distances.length ? distances.reduce((sum, value) => sum + value, 0) / distances.length : Infinity;
    const inlierCoverage = longerLength ? distances.filter((distance) => distance <= maxDistance).length / longerLength : 0;
    if (matched.length < minimumEvidence || coverage < 0.6 || inlierCoverage < 0.8
      || medianDistance > maxDistance || aggregateDistance > maxDistance) return null;
    return {
      algorithm,
      distance: aggregateDistance,
      aggregateDistance,
      evidence: matched.slice(0, 64).map((entry) => ({
        ...evidenceFor(entry.source, entry.target, entry.distance),
        sourceNormalizedTime: entry.sourceTime,
        targetNormalizedTime: entry.targetTime,
      })),
      evidenceCount: matched.length,
      coverage,
      confidence: shorterLength === 1 && longerLength === 1 ? 'low' : (matched.length >= 3 && coverage >= 0.8 && inlierCoverage >= 0.8 ? 'high' : 'medium'),
    };
  }

  _refreshAssetDuplicateCandidates(asset, catalogRevision) {
    const scan = this.db.prepare(`
      SELECT catalog_revision FROM asset_duplicate_scans WHERE project_id = ? AND asset_id = ?
    `).get(asset.projectId, asset.id);
    if (Number(scan?.catalog_revision) === catalogRevision) return false;

    const exactIds = new Set();
    const sourceRef = this.db.prepare(`
      SELECT blob_id FROM asset_blob_refs WHERE project_id = ? AND asset_id = ? AND verification_state = 'verified'
    `).get(asset.projectId, asset.id);
    if (sourceRef) {
      const exactRows = this.db.prepare(`
        SELECT asset_id FROM asset_blob_refs
        WHERE project_id = ? AND blob_id = ? AND verification_state = 'verified' AND asset_id <> ?
        ORDER BY asset_id LIMIT ?
      `).all(asset.projectId, sourceRef.blob_id, asset.id, ASSET_BATCH_QUERY_LIMIT + 1);
      if (exactRows.length > ASSET_BATCH_QUERY_LIMIT) throw new Error(`精确重复候选超过 ${ASSET_BATCH_QUERY_LIMIT}，请缩小项目范围`);
      exactRows.forEach((row) => exactIds.add(row.asset_id));
    }

    const computed = [];
    const sourceFingerprints = this.listAssetFingerprints(asset.id).filter((entry) => normalizeFingerprintAlgorithm(entry.algorithm));
    const algorithms = [...new Set(sourceFingerprints.map((entry) => entry.algorithm))];
    for (const algorithm of algorithms) {
      const sourceForAlgorithm = sourceFingerprints.filter((entry) => entry.algorithm === algorithm);
      const candidateIds = new Set();
      for (const source of sourceForAlgorithm) {
        const bands = fingerprintBands(source.hash);
        const rows = this.db.prepare(`
          SELECT candidate.asset_id FROM (
            SELECT asset_id FROM asset_fingerprints WHERE project_id = ? AND algorithm = ? AND band_0 = ?
            UNION SELECT asset_id FROM asset_fingerprints WHERE project_id = ? AND algorithm = ? AND band_1 = ?
            UNION SELECT asset_id FROM asset_fingerprints WHERE project_id = ? AND algorithm = ? AND band_2 = ?
            UNION SELECT asset_id FROM asset_fingerprints WHERE project_id = ? AND algorithm = ? AND band_3 = ?
            UNION SELECT asset_id FROM asset_fingerprints WHERE project_id = ? AND algorithm = ? AND band_4 = ?
            UNION SELECT asset_id FROM asset_fingerprints WHERE project_id = ? AND algorithm = ? AND band_5 = ?
            UNION SELECT asset_id FROM asset_fingerprints WHERE project_id = ? AND algorithm = ? AND band_6 = ?
            UNION SELECT asset_id FROM asset_fingerprints WHERE project_id = ? AND algorithm = ? AND band_7 = ?
            UNION SELECT asset_id FROM asset_fingerprints WHERE project_id = ? AND algorithm = ? AND band_8 = ?
          ) candidate JOIN assets a ON a.id = candidate.asset_id
          WHERE candidate.asset_id <> ? AND a.kind = ?
          ORDER BY candidate.asset_id LIMIT ?
        `).all(...bands.flatMap((band) => [asset.projectId, algorithm, band]), asset.id, asset.kind, ASSET_BATCH_QUERY_LIMIT + 1);
        if (rows.length > ASSET_BATCH_QUERY_LIMIT) throw new Error(`近似重复候选超过 ${ASSET_BATCH_QUERY_LIMIT}，请缩小项目范围`);
        rows.forEach((row) => { if (!exactIds.has(row.asset_id)) candidateIds.add(row.asset_id); });
        if (candidateIds.size > ASSET_BATCH_QUERY_LIMIT) throw new Error(`近似重复候选超过 ${ASSET_BATCH_QUERY_LIMIT}，请缩小项目范围`);
      }
      const boundedIds = [...candidateIds].sort();
      if (!boundedIds.length) continue;
      const targetAssets = this._hydrateAssetIdsOrdered(boundedIds);
      const fingerprintRows = this.db.prepare(`
        SELECT * FROM asset_fingerprints WHERE project_id = ? AND algorithm = ?
          AND asset_id IN (${boundedIds.map(() => '?').join(',')})
        ORDER BY asset_id, frame_index, id
      `).all(asset.projectId, algorithm, ...boundedIds);
      const targetFingerprints = new Map();
      fingerprintRows.forEach((row) => {
        const values = targetFingerprints.get(row.asset_id) || [];
        values.push({
          id: row.id, assetId: row.asset_id, algorithm: row.algorithm, frameIndex: Number(row.frame_index) || 0,
          timestampMs: row.timestamp_ms == null ? null : Number(row.timestamp_ms),
          normalizedTime: row.normalized_time == null ? null : Number(row.normalized_time), hash: row.hash_hex,
        });
        targetFingerprints.set(row.asset_id, values);
      });
      for (const target of targetAssets) {
        const targetForAlgorithm = targetFingerprints.get(target.id) || [];
        const aggregate = this._nearDuplicateEvidence(asset, target, sourceForAlgorithm, targetForAlgorithm, 8);
        if (!aggregate) continue;
        let minimumDistance = 8;
        for (let distance = 0; distance <= 8; distance += 1) {
          if (this._nearDuplicateEvidence(asset, target, sourceForAlgorithm, targetForAlgorithm, distance)) {
            minimumDistance = distance;
            break;
          }
        }
        const [leftAssetId, rightAssetId] = [asset.id, target.id].sort();
        const candidateId = `duplicate_${crypto.createHash('sha256').update(stableJson([asset.projectId, leftAssetId, rightAssetId, algorithm])).digest('hex').slice(0, 32)}`;
        computed.push({ candidateId, leftAssetId, rightAssetId, algorithm, minimumDistance, aggregate });
      }
    }

    const persist = this.db.transaction(() => {
      const currentRevision = Number(this.db.prepare('SELECT revision FROM asset_catalog_revisions WHERE project_id = ?').get(asset.projectId)?.revision) || 1;
      if (currentRevision !== catalogRevision) {
        throw revisionConflict('asset_catalog_revision_conflict', '重复候选目录版本已变化，请重新加载', { revision: currentRevision });
      }
      const now = Date.now();
      const upsert = this.db.prepare(`
        INSERT INTO asset_duplicate_candidates(
          id, project_id, left_asset_id, right_asset_id, algorithm, distance, minimum_distance,
          catalog_revision, confidence, evidence_json, decision, revision, decided_by, decided_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, NULL, NULL, ?, ?)
        ON CONFLICT(project_id, left_asset_id, right_asset_id, algorithm) DO UPDATE SET
          distance=excluded.distance, minimum_distance=excluded.minimum_distance,
          catalog_revision=excluded.catalog_revision, confidence=excluded.confidence,
          evidence_json=excluded.evidence_json, updated_at=excluded.updated_at
      `);
      computed.forEach((candidate) => upsert.run(
        candidate.candidateId, asset.projectId, candidate.leftAssetId, candidate.rightAssetId,
        candidate.algorithm, candidate.aggregate.aggregateDistance, candidate.minimumDistance,
        catalogRevision, candidate.aggregate.confidence, JSON.stringify(candidate.aggregate), now, now,
      ));
      this.db.prepare(`
        DELETE FROM asset_duplicate_candidates
        WHERE project_id = ? AND (left_asset_id = ? OR right_asset_id = ?) AND catalog_revision <> ?
      `).run(asset.projectId, asset.id, asset.id, catalogRevision);
      this.db.prepare(`
        INSERT INTO asset_duplicate_scans(project_id, asset_id, catalog_revision, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET project_id=excluded.project_id,
          catalog_revision=excluded.catalog_revision, updated_at=excluded.updated_at
      `).run(asset.projectId, asset.id, catalogRevision, now);
    });
    persist.immediate();
    return true;
  }

  listAssetDuplicates(assetId, options = {}) {
    const asset = this.getAsset(assetId);
    if (!asset) throw new Error('素材不存在');
    const mode = ['all', 'exact', 'near'].includes(String(options.mode)) ? String(options.mode) : 'all';
    const parsedDistance = Number(options.maxDistance);
    const maxDistance = Math.max(0, Math.min(8, Number.isFinite(parsedDistance) ? Math.trunc(parsedDistance) : 8));
    const limit = Math.min(ASSET_DUPLICATE_PAGE_LIMIT, Math.max(1, Math.trunc(Number(options.limit) || 50)));
    const catalogRevision = this.getAssetCatalogRevision(asset.projectId);
    const cursor = decodeCursor(options.cursor, {});
    const cursorValid = cursor.assetId === asset.id && cursor.mode === mode
      && Number(cursor.maxDistance) === maxDistance && Number(cursor.catalogRevision) === catalogRevision;
    if (options.cursor && !cursorValid) {
      throw revisionConflict('asset_catalog_revision_conflict', '重复候选目录版本已变化，请重新加载', { revision: catalogRevision });
    }
    let phase = cursorValid && ['exact', 'near'].includes(cursor.phase)
      ? cursor.phase
      : (mode === 'near' ? 'near' : 'exact');
    if (mode === 'exact') phase = 'exact';
    if (mode === 'near') phase = 'near';
    const items = [];
    const sourceRef = this.db.prepare(`
      SELECT blob_id FROM asset_blob_refs WHERE project_id = ? AND asset_id = ? AND verification_state = 'verified'
    `).get(asset.projectId, asset.id);

    if (phase === 'exact' && mode !== 'near') {
      const exactCount = sourceRef ? Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM asset_blob_refs
        WHERE project_id = ? AND blob_id = ? AND verification_state = 'verified' AND asset_id <> ?
      `).get(asset.projectId, sourceRef.blob_id, asset.id).count) || 0 : 0;
      if (exactCount > ASSET_BATCH_QUERY_LIMIT) throw new Error(`精确重复候选超过 ${ASSET_BATCH_QUERY_LIMIT}，请缩小项目范围`);
      const afterId = cursorValid ? String(cursor.exactAfterId || '') : '';
      const remaining = limit - items.length;
      const exactRows = sourceRef && remaining > 0 ? this.db.prepare(`
        SELECT a.id FROM asset_blob_refs r JOIN assets a ON a.id = r.asset_id
        WHERE r.project_id = ? AND r.blob_id = ? AND r.verification_state = 'verified'
          AND a.id <> ? AND a.id > ?
        ORDER BY a.id ASC LIMIT ?
      `).all(asset.projectId, sourceRef.blob_id, asset.id, afterId, remaining + 1) : [];
      const exactPageRows = exactRows.slice(0, remaining);
      const exactAssets = this._hydrateAssetIdsOrdered(exactPageRows.map((row) => row.id));
      exactAssets.forEach((target) => items.push({
        id: `exact_${crypto.createHash('sha256').update(stableJson([asset.projectId, asset.id, target.id, asset.contentHash])).digest('hex').slice(0, 32)}`,
        type: 'exact', match: 'exact', asset: target, algorithm: 'sha256-v1', distance: 0,
        evidence: { contentHash: asset.contentHash, verification: 'verified' }, decision: 'confirmed',
        decisionRevision: 1, confidence: 'exact', evidenceCount: 1, coverage: 1, aggregateDistance: 0,
      }));
      if (exactRows.length > remaining) {
        const last = exactPageRows.at(-1);
        return {
          items,
          nextCursor: encodeCursor({ assetId: asset.id, mode, maxDistance, catalogRevision, phase: 'exact', exactAfterId: last.id }),
          hasMore: true,
        };
      }
      if (mode === 'exact') return { items, nextCursor: null, hasMore: false };
      phase = 'near';
    }

    this._refreshAssetDuplicateCandidates(asset, catalogRevision);
    const remaining = limit - items.length;
    const hasNearCursor = cursorValid && phase === 'near' && cursor.nearCandidateId;
    const afterDistance = hasNearCursor ? Number(cursor.nearDistance) : -1;
    const afterTargetId = hasNearCursor ? String(cursor.nearTargetId || '') : '';
    const afterCandidateId = hasNearCursor ? String(cursor.nearCandidateId || '') : '';
    const nearRows = this.db.prepare(`
      SELECT * FROM (
        SELECT c.*, c.right_asset_id AS target_asset_id
        FROM asset_duplicate_candidates c
        WHERE c.project_id = ? AND c.left_asset_id = ? AND c.catalog_revision = ? AND c.minimum_distance <= ?
        UNION ALL
        SELECT c.*, c.left_asset_id AS target_asset_id
        FROM asset_duplicate_candidates c
        WHERE c.project_id = ? AND c.right_asset_id = ? AND c.catalog_revision = ? AND c.minimum_distance <= ?
      ) candidates
      WHERE distance > ?
        OR (distance = ? AND target_asset_id > ?)
        OR (distance = ? AND target_asset_id = ? AND id > ?)
      ORDER BY distance ASC, target_asset_id ASC, id ASC
      LIMIT ?
    `).all(
      asset.projectId, asset.id, catalogRevision, maxDistance,
      asset.projectId, asset.id, catalogRevision, maxDistance,
      afterDistance, afterDistance, afterTargetId, afterDistance, afterTargetId, afterCandidateId,
      remaining + 1,
    );
    const nearPageRows = nearRows.slice(0, remaining);
    const targetsById = new Map(this._hydrateAssetIdsOrdered(nearPageRows.map((row) => row.target_asset_id)).map((target) => [target.id, target]));
    nearPageRows.forEach((row) => {
      const aggregate = parseJson(row.evidence_json, {});
      const target = targetsById.get(row.target_asset_id);
      if (!target) return;
      items.push({
        id: row.id,
        type: 'near',
        match: 'perceptual',
        asset: target,
        algorithm: row.algorithm,
        distance: Number(row.distance),
        evidence: Array.isArray(aggregate.evidence) ? aggregate.evidence : [],
        decision: row.decision,
        decisionRevision: Number(row.revision) || 1,
        confidence: row.confidence,
        evidenceCount: Number(aggregate.evidenceCount) || 0,
        coverage: Number(aggregate.coverage) || 0,
        aggregateDistance: Number(row.distance),
      });
    });
    const hasMore = nearRows.length > remaining;
    const last = nearPageRows.at(-1);
    const nextCursor = hasMore ? encodeCursor({
      assetId: asset.id,
      mode,
      maxDistance,
      catalogRevision,
      phase: 'near',
      nearDistance: last ? Number(last.distance) : undefined,
      nearTargetId: last?.target_asset_id || undefined,
      nearCandidateId: last?.id || undefined,
    }) : null;
    return { items, nextCursor, hasMore };
  }

  findAssetDuplicates(assetId, maxDistance = 8) {
    return this.listAssetDuplicates(assetId, { mode: 'all', maxDistance, limit: ASSET_DUPLICATE_PAGE_LIMIT }).items
      .map((item) => ({ ...item, match: item.type === 'exact' ? 'exact' : 'perceptual' }));
  }

  setAssetDuplicateDecision(projectId, candidateId, input = {}, options = {}) {
    const decision = String(input.decision || '').toLowerCase();
    if (!ASSET_DUPLICATE_DECISIONS.has(decision)) throw new Error('重复候选决策无效');
    let normalizedProjectId = projectId == null ? null : String(projectId || DEFAULT_PROJECT_ID);
    const expectedRevision = input.expectedRevision == null ? null : Math.max(1, Math.trunc(Number(input.expectedRevision) || 0));
    const run = this.db.transaction(() => {
      const current = normalizedProjectId
        ? this.db.prepare('SELECT * FROM asset_duplicate_candidates WHERE project_id = ? AND id = ?').get(normalizedProjectId, String(candidateId))
        : this.db.prepare('SELECT * FROM asset_duplicate_candidates WHERE id = ?').get(String(candidateId));
      if (!current) return null;
      normalizedProjectId = current.project_id;
      const catalogRevision = Number(this.db.prepare('SELECT revision FROM asset_catalog_revisions WHERE project_id = ?').get(normalizedProjectId)?.revision) || 1;
      if (Number(current.catalog_revision) !== catalogRevision) {
        throw revisionConflict('asset_catalog_revision_conflict', '重复候选证据已失效，请重新加载', { revision: catalogRevision, catalogRevision });
      }
      if (expectedRevision != null && Number(current.revision) !== expectedRevision) {
        throw revisionConflict('asset_duplicate_revision_conflict', '重复候选决策版本冲突', {
          id: current.id, decision: current.decision, revision: Number(current.revision), updatedAt: current.updated_at,
        });
      }
      const now = Date.now();
      const actorId = String(options.actorId || input.actorId || 'local-owner').slice(0, 240);
      const update = this.db.prepare(`
        UPDATE asset_duplicate_candidates SET decision = ?, revision = revision + 1,
          decided_by = ?, decided_at = ?, updated_at = ?
        WHERE project_id = ? AND id = ? AND revision = ?
      `).run(decision, actorId, now, now, normalizedProjectId, current.id, current.revision);
      if (update.changes !== 1) throw revisionConflict('asset_duplicate_revision_conflict', '重复候选决策版本冲突');
      const row = this.db.prepare('SELECT * FROM asset_duplicate_candidates WHERE project_id = ? AND id = ?').get(normalizedProjectId, current.id);
      return { id: row.id, projectId: row.project_id, decision: row.decision, revision: Number(row.revision), decidedBy: row.decided_by, decidedAt: row.decided_at, updatedAt: row.updated_at };
    });
    return run.immediate();
  }

  listExactDuplicateGroups(projectId = DEFAULT_PROJECT_ID, options = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(options.limit) || 50)));
    const catalogRevision = this.getAssetCatalogRevision(normalizedProjectId);
    const cursor = decodeCursor(options.cursor, {});
    const cursorValid = cursor.projectId === normalizedProjectId && Number(cursor.catalogRevision) === catalogRevision;
    if (options.cursor && !cursorValid) throw revisionConflict('asset_catalog_revision_conflict', '精确重复组目录版本已变化，请重新加载', { revision: catalogRevision });
    const afterHash = cursorValid ? String(cursor.contentHash || '') : '';
    const groupRows = this.db.prepare(`
      SELECT b.content_hash, COUNT(*) AS member_count
      FROM asset_blob_refs r JOIN asset_blobs b ON b.id = r.blob_id JOIN assets a ON a.id = r.asset_id
      WHERE r.project_id = ? AND r.verification_state = 'verified' AND b.content_hash > ?
      GROUP BY b.content_hash HAVING COUNT(*) > 1
      ORDER BY b.content_hash ASC LIMIT ?
    `).all(normalizedProjectId, afterHash, limit + 1);
    const pageRows = groupRows.slice(0, limit);
    const hashes = pageRows.map((row) => row.content_hash);
    const memberRows = hashes.length ? this.db.prepare(`
      WITH ranked AS (
        SELECT a.*, b.content_hash,
          ROW_NUMBER() OVER (PARTITION BY b.content_hash ORDER BY a.created_at ASC, a.id ASC) AS member_rank
        FROM asset_blob_refs r JOIN asset_blobs b ON b.id = r.blob_id JOIN assets a ON a.id = r.asset_id
        WHERE r.project_id = ? AND r.verification_state = 'verified'
          AND b.content_hash IN (${hashes.map(() => '?').join(',')})
      ) SELECT * FROM ranked WHERE member_rank <= 20 ORDER BY content_hash, member_rank
    `).all(normalizedProjectId, ...hashes) : [];
    const hydratedMembers = this.hydrateAssetRows(memberRows);
    const membersByHash = new Map();
    hydratedMembers.forEach((asset, index) => {
      const hash = memberRows[index].content_hash;
      const values = membersByHash.get(hash) || [];
      values.push(asset);
      membersByHash.set(hash, values);
    });
    const hasMore = groupRows.length > limit;
    return {
      items: pageRows.map((row) => ({
        id: `exact_${row.content_hash}`,
        type: 'exact',
        contentHash: row.content_hash,
        memberCount: Number(row.member_count) || 0,
        members: membersByHash.get(row.content_hash) || [],
        membersTruncated: Number(row.member_count) > 20,
      })),
      nextCursor: hasMore ? encodeCursor({ projectId: normalizedProjectId, catalogRevision, contentHash: pageRows.at(-1).content_hash }) : null,
      hasMore,
    };
  }

  getExactDuplicateGroup(projectId, groupId, options = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const contentHash = normalizeSha256(String(groupId || '').replace(/^exact_/, ''));
    if (!contentHash) return null;
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(options.limit) || 100)));
    const catalogRevision = this.getAssetCatalogRevision(normalizedProjectId);
    const cursor = decodeCursor(options.cursor, {});
    const cursorValid = cursor.projectId === normalizedProjectId && cursor.contentHash === contentHash && Number(cursor.catalogRevision) === catalogRevision;
    if (options.cursor && !cursorValid) throw revisionConflict('asset_catalog_revision_conflict', '精确重复组成员版本已变化，请重新加载', { revision: catalogRevision });
    const afterId = cursorValid ? String(cursor.assetId || '') : '';
    const rows = this.db.prepare(`
      SELECT a.* FROM asset_blob_refs r JOIN asset_blobs b ON b.id = r.blob_id JOIN assets a ON a.id = r.asset_id
      WHERE r.project_id = ? AND r.verification_state = 'verified' AND b.content_hash = ? AND a.id > ?
      ORDER BY a.id ASC LIMIT ?
    `).all(normalizedProjectId, contentHash, afterId, limit + 1);
    const pageRows = rows.slice(0, limit);
    if (!pageRows.length && !afterId) return null;
    const count = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM asset_blob_refs r JOIN asset_blobs b ON b.id = r.blob_id
      WHERE r.project_id = ? AND r.verification_state = 'verified' AND b.content_hash = ?
    `).get(normalizedProjectId, contentHash).count) || 0;
    if (count < 2) return null;
    const hasMore = rows.length > limit;
    return {
      id: `exact_${contentHash}`,
      type: 'exact',
      contentHash,
      memberCount: count,
      members: this.hydrateAssetRows(pageRows),
      nextCursor: hasMore ? encodeCursor({ projectId: normalizedProjectId, catalogRevision, contentHash, assetId: pageRows.at(-1).id }) : null,
      hasMore,
    };
  }

  applyAssetBatch(projectId, input = {}, options = {}) {
    const normalizedProjectId = String(projectId || input.projectId || DEFAULT_PROJECT_ID);
    const actorId = String(options.actorId || input.actorId || 'local-owner').slice(0, 240);
    const idempotencyKey = String(input.idempotencyKey || '').trim().slice(0, 240);
    if (!idempotencyKey) throw new Error('批处理缺少 idempotencyKey');
    const requestDigest = `sha256:${crypto.createHash('sha256').update(stableJson({
      projectId: normalizedProjectId,
      selection: input.selection,
      expectedRevisions: input.expectedRevisions || {},
      operation: input.operation,
    })).digest('hex')}`;
    const run = this.db.transaction(() => {
      const existingRequest = this.db.prepare(`
        SELECT * FROM asset_batch_requests WHERE project_id = ? AND actor_id = ? AND idempotency_key = ?
      `).get(normalizedProjectId, actorId, idempotencyKey);
      if (existingRequest) {
        if (existingRequest.request_digest !== requestDigest) {
          throw revisionConflict('asset_batch_idempotency_conflict', '幂等键已被不同批处理请求使用');
        }
        return { ...parseJson(existingRequest.result_json, {}), idempotent: true };
      }

      const selection = input.selection && typeof input.selection === 'object' ? input.selection : {};
      let selectionMode;
      let assetIds;
      if (Array.isArray(selection.assetIds)) {
        selectionMode = 'explicit';
        assetIds = [...new Set(selection.assetIds.map((value) => String(value || '').trim()).filter(Boolean))];
        if (!assetIds.length || assetIds.length > ASSET_BATCH_EXPLICIT_LIMIT) throw new Error(`显式批处理素材数量必须为 1-${ASSET_BATCH_EXPLICIT_LIMIT}`);
        const rows = this.db.prepare(`
          SELECT id FROM assets WHERE project_id = ? AND id IN (${assetIds.map(() => '?').join(',')})
        `).all(normalizedProjectId, ...assetIds);
        if (rows.length !== assetIds.length) throw new Error('批处理包含不存在或跨项目素材');
      } else if (selection.query && typeof selection.query === 'object') {
        selectionMode = 'query';
        const expectedCatalogRevision = Math.max(1, Math.trunc(Number(selection.catalogRevision) || 0));
        const currentCatalogRevision = this.getAssetCatalogRevision(normalizedProjectId);
        if (expectedCatalogRevision !== currentCatalogRevision) {
          throw revisionConflict('asset_catalog_revision_conflict', '素材目录版本已变化，请重新选择', { revision: currentCatalogRevision });
        }
        const exclusions = [...new Set((Array.isArray(selection.exclusions) ? selection.exclusions : []).map(String).filter(Boolean))];
        if (exclusions.length > ASSET_BATCH_QUERY_LIMIT) throw new Error('批处理排除列表超过上限');
        const queryFilters = { ...selection.query, projectId: normalizedProjectId };
        delete queryFilters.limit;
        delete queryFilters.offset;
        const { clauses, values, orderBy } = this._assetListQueryParts(queryFilters);
        if (exclusions.length) {
          clauses.push(`a.id NOT IN (${exclusions.map(() => '?').join(',')})`);
          values.push(...exclusions);
        }
        const rows = this.db.prepare(`
          SELECT a.id FROM assets a WHERE ${clauses.join(' AND ')} ORDER BY ${orderBy} LIMIT ?
        `).all(...values, ASSET_BATCH_QUERY_LIMIT + 1);
        if (rows.length > ASSET_BATCH_QUERY_LIMIT) throw new Error(`查询批处理素材数量超过 ${ASSET_BATCH_QUERY_LIMIT}`);
        assetIds = rows.map((row) => row.id);
      } else {
        throw new Error('批处理 selection 无效');
      }

      const expectedRevisions = input.expectedRevisions && typeof input.expectedRevisions === 'object' ? input.expectedRevisions : {};
      if (selectionMode === 'explicit') {
        const revisionKeys = Object.keys(expectedRevisions).sort();
        const selectedKeys = [...assetIds].sort();
        if (revisionKeys.length !== selectedKeys.length || revisionKeys.some((key, index) => key !== selectedKeys[index])) {
          throw new Error('显式批处理必须为每个素材提供且仅提供一个 expectedRevision');
        }
      }
      if (assetIds.length) {
        const assetRows = this.db.prepare(`
          SELECT id, organization_revision FROM assets WHERE project_id = ? AND id IN (${assetIds.map(() => '?').join(',')})
        `).all(normalizedProjectId, ...assetIds);
        const revisionsById = new Map(assetRows.map((row) => [row.id, Math.max(1, Number(row.organization_revision) || 1)]));
        for (const [assetId, expected] of Object.entries(expectedRevisions)) {
          if (!assetIds.includes(assetId)) throw new Error('expectedRevisions 包含选集外素材');
          if (revisionsById.get(assetId) !== Math.trunc(Number(expected))) {
            throw revisionConflict('asset_organization_revision_conflict', '批处理素材组织版本冲突', { assetId, revision: revisionsById.get(assetId) });
          }
        }
      }

      const operation = input.operation && typeof input.operation === 'object' ? input.operation : {};
      const type = String(operation.type || '').trim().toLowerCase();
      const now = Date.now();
      const placeholders = assetIds.map(() => '?').join(',');
      const readCollections = (ids) => {
        const normalized = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
        if (!normalized.length) return [];
        const rows = this.db.prepare(`SELECT * FROM asset_collections WHERE project_id = ? AND id IN (${normalized.map(() => '?').join(',')})`).all(normalizedProjectId, ...normalized);
        if (rows.length !== normalized.length) throw new Error('批处理集合不存在或不属于当前项目');
        return rows;
      };
      const touchedCollections = new Set();
      if (type.startsWith('tags.')) {
        const tags = normalizeTags(operation.tags);
        if (!tags.length && type !== 'tags.replace') throw new Error('批处理标签不能为空');
        const selectTags = assetIds.length ? this.db.prepare(`SELECT asset_id, tag FROM asset_tags WHERE asset_id IN (${placeholders})`).all(...assetIds) : [];
        const existingByAsset = new Map();
        selectTags.forEach((row) => {
          const values = existingByAsset.get(row.asset_id) || [];
          values.push(row.tag);
          existingByAsset.set(row.asset_id, values);
        });
        const insertTag = this.db.prepare('INSERT OR IGNORE INTO asset_tags(asset_id, tag, created_at) VALUES (?, ?, ?)');
        const deleteTag = this.db.prepare('DELETE FROM asset_tags WHERE asset_id = ? AND LOWER(tag) = LOWER(?)');
        for (const assetId of assetIds) {
          if (type === 'tags.replace') {
            this.db.prepare('DELETE FROM asset_tags WHERE asset_id = ?').run(assetId);
            tags.forEach((tag) => insertTag.run(assetId, tag, now));
          } else if (type === 'tags.add') {
            const existingKeys = new Set((existingByAsset.get(assetId) || []).map((tag) => tag.toLocaleLowerCase('und')));
            tags.forEach((tag) => { if (!existingKeys.has(tag.toLocaleLowerCase('und'))) insertTag.run(assetId, tag, now); });
          } else if (type === 'tags.remove') {
            tags.forEach((tag) => deleteTag.run(assetId, tag));
          } else throw new Error('批处理标签操作无效');
        }
      } else if (type.startsWith('collection.')) {
        if (type === 'collection.add' || type === 'collection.remove') {
          const collectionIds = operation.collectionIds || (operation.collectionId ? [operation.collectionId] : []);
          const collections = readCollections(collectionIds);
          if (!collections.length) throw new Error('批处理集合不能为空');
          for (const collection of collections) {
            touchedCollections.add(collection.id);
            for (const assetId of assetIds) {
              if (type === 'collection.add') this.db.prepare('INSERT OR IGNORE INTO asset_collection_members(collection_id, asset_id, added_at) VALUES (?, ?, ?)').run(collection.id, assetId, now);
              else this.db.prepare('DELETE FROM asset_collection_members WHERE collection_id = ? AND asset_id = ?').run(collection.id, assetId);
            }
          }
        } else if (type === 'collection.replace') {
          const collections = readCollections(operation.collectionIds || []);
          collections.forEach((collection) => touchedCollections.add(collection.id));
          if (assetIds.length) {
            const oldRows = this.db.prepare(`
              SELECT DISTINCT m.collection_id FROM asset_collection_members m JOIN asset_collections c ON c.id = m.collection_id
              WHERE c.project_id = ? AND m.asset_id IN (${placeholders})
            `).all(normalizedProjectId, ...assetIds);
            oldRows.forEach((row) => touchedCollections.add(row.collection_id));
            this.db.prepare(`DELETE FROM asset_collection_members WHERE asset_id IN (${placeholders})`).run(...assetIds);
          }
          for (const collection of collections) for (const assetId of assetIds) {
            this.db.prepare('INSERT INTO asset_collection_members(collection_id, asset_id, added_at) VALUES (?, ?, ?)').run(collection.id, assetId, now);
          }
        } else if (type === 'collection.move') {
          const fromCollections = readCollections(operation.fromCollectionIds || []);
          const toCollections = readCollections(operation.toCollectionId ? [operation.toCollectionId] : []);
          if (toCollections.length !== 1) throw new Error('批处理移动缺少目标集合');
          [...fromCollections, ...toCollections].forEach((collection) => touchedCollections.add(collection.id));
          for (const assetId of assetIds) {
            fromCollections.forEach((collection) => this.db.prepare('DELETE FROM asset_collection_members WHERE collection_id = ? AND asset_id = ?').run(collection.id, assetId));
            this.db.prepare('INSERT OR IGNORE INTO asset_collection_members(collection_id, asset_id, added_at) VALUES (?, ?, ?)').run(toCollections[0].id, assetId, now);
          }
        } else throw new Error('批处理集合操作无效');
      } else if (type.startsWith('access.')) {
        const normalizeGrant = (grant) => {
          const principalType = String(grant?.principalType || '').toLowerCase();
          const principalId = String(grant?.principalId || '').trim().slice(0, 240);
          const requested = Array.isArray(grant?.permissions) ? grant.permissions : [];
          const permissions = normalizeAccessPermissions(requested);
          if (!ASSET_ACCESS_PRINCIPALS.has(principalType) || !principalId || !permissions.length
            || permissions.length !== new Set(requested.map((permission) => String(permission || '').trim().toLowerCase())).size) {
            throw new Error('批处理授权主体或权限无效');
          }
          return { principalType, principalId, permissions };
        };
        const ensurePolicies = this.db.prepare(`
          INSERT OR IGNORE INTO asset_access_policies(project_id, asset_id, scope, revision, updated_by, updated_at)
          VALUES (?, ?, 'project', 1, ?, ?)
        `);
        assetIds.forEach((assetId) => ensurePolicies.run(normalizedProjectId, assetId, actorId, now));
        if (type === 'access.replace') {
          const scope = String(operation.scope || '').toLowerCase();
          if (!ASSET_ACCESS_SCOPES.has(scope)) throw new Error('批处理访问范围无效');
          const grants = (Array.isArray(operation.grants) ? operation.grants : []).map(normalizeGrant);
          if (scope === 'restricted' && !grants.length) throw new Error('受限素材必须至少保留一条授权');
          const insertGrant = this.db.prepare(`
            INSERT INTO asset_access_grants(project_id, asset_id, principal_type, principal_id, permission, granted_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);
          for (const assetId of assetIds) {
            this.db.prepare('DELETE FROM asset_access_grants WHERE project_id = ? AND asset_id = ?').run(normalizedProjectId, assetId);
            grants.forEach((grant) => grant.permissions.forEach((permission) => insertGrant.run(normalizedProjectId, assetId, grant.principalType, grant.principalId, permission, actorId, now)));
            this.db.prepare(`UPDATE asset_access_policies SET scope = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE project_id = ? AND asset_id = ?`).run(scope, actorId, now, normalizedProjectId, assetId);
          }
        } else if (type === 'access.set-scope') {
          const scope = String(operation.scope || '').toLowerCase();
          if (!ASSET_ACCESS_SCOPES.has(scope)) throw new Error('批处理访问范围无效');
          if (scope === 'restricted') {
            for (const assetId of assetIds) {
              const grant = this.db.prepare('SELECT 1 FROM asset_access_grants WHERE project_id = ? AND asset_id = ? LIMIT 1').get(normalizedProjectId, assetId);
              if (!grant) throw new Error('受限素材必须至少保留一条授权');
            }
          }
          assetIds.forEach((assetId) => this.db.prepare(`UPDATE asset_access_policies SET scope = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE project_id = ? AND asset_id = ?`).run(scope, actorId, now, normalizedProjectId, assetId));
        } else if (type === 'access.grant' || type === 'access.revoke') {
          const grant = normalizeGrant(operation);
          for (const assetId of assetIds) for (const permission of grant.permissions) {
            if (type === 'access.grant') this.db.prepare(`
              INSERT OR IGNORE INTO asset_access_grants(project_id, asset_id, principal_type, principal_id, permission, granted_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(normalizedProjectId, assetId, grant.principalType, grant.principalId, permission, actorId, now);
            else this.db.prepare(`
              DELETE FROM asset_access_grants WHERE project_id = ? AND asset_id = ? AND principal_type = ? AND principal_id = ? AND permission = ?
            `).run(normalizedProjectId, assetId, grant.principalType, grant.principalId, permission);
          }
          assetIds.forEach((assetId) => this.db.prepare(`UPDATE asset_access_policies SET revision = revision + 1, updated_by = ?, updated_at = ? WHERE project_id = ? AND asset_id = ?`).run(actorId, now, normalizedProjectId, assetId));
        } else throw new Error('批处理授权操作无效');
      } else {
        throw new Error('批处理 operation 无效');
      }

      if (touchedCollections.size) {
        const updateCollection = this.db.prepare('UPDATE asset_collections SET revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ?');
        touchedCollections.forEach((collectionId) => updateCollection.run(now, normalizedProjectId, collectionId));
      }
      const organizationRevisions = this._bumpAssetOrganizationRevision(assetIds, now);
      const catalogRevision = this._bumpAssetCatalogRevision(normalizedProjectId, now);
      const result = {
        idempotent: false,
        selectionMode,
        affectedCount: assetIds.length,
        assetIds,
        organizationRevisions,
        catalogRevision,
      };
      this.db.prepare(`
        INSERT INTO asset_batch_requests(project_id, actor_id, idempotency_key, request_digest, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(normalizedProjectId, actorId, idempotencyKey, requestDigest, JSON.stringify(result), now);
      return result;
    });
    return run.immediate();
  }

  mapAssetBlob(row) {
    if (!row) return null;
    return {
      id: row.id,
      contentHash: row.content_hash,
      verificationState: row.verification_state,
      byteSize: row.byte_size == null ? null : Math.max(0, Number(row.byte_size) || 0),
      mimeType: row.mime_type || null,
      storageKey: row.storage_key || null,
      storageState: row.storage_state || 'logical',
      verifiedAt: row.verified_at == null ? null : Number(row.verified_at),
      pendingDeleteAt: row.pending_delete_at == null ? null : Number(row.pending_delete_at),
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
    };
  }

  getAssetBlob(contentHashOrId) {
    const value = String(contentHashOrId || '').trim().toLowerCase();
    const row = value.startsWith('blob_')
      ? this.db.prepare('SELECT * FROM asset_blobs WHERE id = ?').get(value)
      : this.db.prepare('SELECT * FROM asset_blobs WHERE content_hash = ?').get(normalizeSha256(value) || '');
    return this.mapAssetBlob(row);
  }

  markAssetBlobStored(input = {}) {
    const contentHash = normalizeSha256(input.contentHash);
    const storageKey = String(input.storageKey || '').replace(/\\/g, '/').trim();
    const byteSize = Math.max(0, Math.trunc(Number(input.byteSize) || 0));
    if (!contentHash || !storageKey || !byteSize) throw new Error('CAS blob 身份、存储键或大小无效');
    if (storageKey.startsWith('/') || storageKey.includes('..') || /^[a-z]:/i.test(storageKey)) throw new Error('CAS storageKey 必须是安全相对路径');
    const now = Number(input.verifiedAt) || Date.now();
    const id = `blob_${contentHash}`;
    this.db.prepare(`
      INSERT INTO asset_blobs(
        id, content_hash, verification_state, byte_size, mime_type, storage_key,
        storage_state, verified_at, pending_delete_at, created_at, updated_at
      ) VALUES (?, ?, 'verified', ?, ?, ?, 'ready', ?, NULL, ?, ?)
      ON CONFLICT(content_hash) DO UPDATE SET
        verification_state='verified', byte_size=excluded.byte_size,
        mime_type=COALESCE(excluded.mime_type, asset_blobs.mime_type), storage_key=excluded.storage_key,
        storage_state='ready', verified_at=excluded.verified_at, pending_delete_at=NULL,
        updated_at=excluded.updated_at
    `).run(id, contentHash, byteSize, input.mimeType || null, storageKey, now, now, now);
    return this.getAssetBlob(contentHash);
  }

  assetBlobReferenceCount(contentHash) {
    const normalized = normalizeSha256(contentHash);
    if (!normalized) return 0;
    return Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM asset_blob_refs r
      JOIN asset_blobs b ON b.id = r.blob_id WHERE b.content_hash = ?
    `).get(normalized)?.count) || 0;
  }

  markAssetBlobDeleted(contentHash) {
    const normalized = normalizeSha256(contentHash);
    if (!normalized || this.assetBlobReferenceCount(normalized) > 0) return false;
    return this.db.prepare('DELETE FROM asset_blobs WHERE content_hash = ?').run(normalized).changes === 1;
  }

  listPendingAssetBlobDeletes(limit = 100) {
    return this.db.prepare(`
      SELECT b.* FROM asset_blobs b
      WHERE b.storage_state = 'pending-delete'
        AND NOT EXISTS (SELECT 1 FROM asset_blob_refs r WHERE r.blob_id = b.id)
      ORDER BY b.pending_delete_at ASC, b.id ASC LIMIT ?
    `).all(Math.min(1000, Math.max(1, Math.trunc(Number(limit) || 100)))).map((row) => this.mapAssetBlob(row));
  }

  _assetStorageUsageQuery(projectId, memberId = null) {
    const memberClause = memberId
      ? "AND (a.created_by = ? OR json_extract(a.provenance_json, '$.memberId') = ?)"
      : '';
    const values = memberId
      ? [String(projectId), String(memberId), String(memberId), String(projectId), String(memberId), String(memberId)]
      : [String(projectId), String(projectId)];
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(bytes), 0) AS bytes FROM (
        SELECT MAX(COALESCE(b.byte_size, CAST(json_extract(a.metadata_json, '$.size') AS INTEGER), 0)) AS bytes
        FROM assets a
        JOIN asset_blob_refs r ON r.project_id = a.project_id AND r.asset_id = a.id
        JOIN asset_blobs b ON b.id = r.blob_id
        WHERE a.project_id = ? ${memberClause}
          AND r.verification_state = 'verified' AND b.verification_state = 'verified'
        GROUP BY b.id
        UNION ALL
        SELECT COALESCE(CAST(json_extract(a.metadata_json, '$.size') AS INTEGER), 0) AS bytes
        FROM assets a
        WHERE a.project_id = ? ${memberClause}
          AND NOT EXISTS (
            SELECT 1 FROM asset_blob_refs r JOIN asset_blobs b ON b.id = r.blob_id
            WHERE r.project_id = a.project_id AND r.asset_id = a.id
              AND r.verification_state = 'verified' AND b.verification_state = 'verified'
          )
      )
    `).get(...values);
    return Math.max(0, Number(row?.bytes) || 0);
  }

  getAssetStorageUsage(projectId = DEFAULT_PROJECT_ID, memberId = null) {
    return this._assetStorageUsageQuery(String(projectId), memberId == null ? null : String(memberId));
  }

  getAssetUploadQuotaStatus(projectId = DEFAULT_PROJECT_ID, memberId = null, options = {}) {
    const normalizedProjectId = String(projectId || DEFAULT_PROJECT_ID);
    const normalizedMemberId = memberId == null ? null : String(memberId);
    const now = Number(options.now) || Date.now();
    const projectLimit = Math.max(1, Math.trunc(Number(options.projectLimit) || Number.MAX_SAFE_INTEGER));
    const memberLimit = Math.max(1, Math.trunc(Number(options.memberLimit) || Number.MAX_SAFE_INTEGER));
    const projectUsed = this.getAssetStorageUsage(normalizedProjectId);
    const memberUsed = normalizedMemberId ? this.getAssetStorageUsage(normalizedProjectId, normalizedMemberId) : 0;
    const active = [...ASSET_UPLOAD_ACTIVE_STATUSES];
    const placeholders = active.map(() => '?').join(',');
    const projectReserved = Number(this.db.prepare(`
      SELECT COALESCE(SUM(reserved_bytes), 0) AS bytes FROM asset_upload_sessions
      WHERE project_id = ? AND status IN (${placeholders}) AND expires_at > ?
    `).get(normalizedProjectId, ...active, now)?.bytes) || 0;
    const memberReserved = normalizedMemberId ? Number(this.db.prepare(`
      SELECT COALESCE(SUM(reserved_bytes), 0) AS bytes FROM asset_upload_sessions
      WHERE project_id = ? AND member_id = ? AND status IN (${placeholders}) AND expires_at > ?
    `).get(normalizedProjectId, normalizedMemberId, ...active, now)?.bytes) || 0 : 0;
    return {
      project: {
        usedBytes: projectUsed,
        reservedBytes: projectReserved,
        limitBytes: projectLimit,
        availableBytes: Math.max(0, projectLimit - projectUsed - projectReserved),
      },
      member: normalizedMemberId ? {
        usedBytes: memberUsed,
        reservedBytes: memberReserved,
        limitBytes: memberLimit,
        availableBytes: Math.max(0, memberLimit - memberUsed - memberReserved),
      } : null,
    };
  }

  mapAssetUploadSession(row, options = {}) {
    if (!row) return null;
    const result = {
      id: row.id,
      projectId: row.project_id,
      memberId: row.member_id,
      sourceKind: row.source_kind,
      filename: row.filename,
      mimeType: row.mime_type || 'application/octet-stream',
      expectedSize: Math.max(0, Number(row.expected_size) || 0),
      expectedHash: row.expected_hash || null,
      chunkSize: Math.max(1, Number(row.chunk_size) || 1),
      chunkCount: Math.max(1, Number(row.chunk_count) || 1),
      receivedBytes: Math.max(0, Number(row.received_bytes) || 0),
      reservedBytes: Math.max(0, Number(row.reserved_bytes) || 0),
      status: ASSET_UPLOAD_STATUSES.has(row.status) ? row.status : 'failed',
      revision: Math.max(1, Number(row.revision) || 1),
      assetId: row.asset_id || null,
      contentHash: row.content_hash || null,
      deduplicated: Boolean(row.deduplicated),
      errorCode: row.error_code || null,
      errorMessage: row.error_message || null,
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
      expiresAt: Number(row.expires_at) || 0,
      completedAt: row.completed_at == null ? null : Number(row.completed_at),
    };
    if (options.includeChunks !== false) result.receivedChunks = this.listAssetUploadChunks(row.id);
    return result;
  }

  listAssetUploadChunks(sessionId) {
    return this.db.prepare(`
      SELECT chunk_index, byte_start, byte_end, byte_size, content_hash, created_at, updated_at
      FROM asset_upload_chunks WHERE session_id = ? ORDER BY chunk_index ASC
    `).all(String(sessionId || '')).map((row) => ({
      index: Number(row.chunk_index),
      start: Number(row.byte_start),
      end: Number(row.byte_end),
      size: Number(row.byte_size),
      contentHash: row.content_hash,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  getAssetUploadSession(sessionId, options = {}) {
    return this.mapAssetUploadSession(
      this.db.prepare('SELECT * FROM asset_upload_sessions WHERE id = ?').get(String(sessionId || '')),
      options,
    );
  }

  createAssetUploadSession(input = {}, limits = {}) {
    const projectId = String(input.projectId || DEFAULT_PROJECT_ID);
    const memberId = String(input.memberId || '').trim().slice(0, 240);
    const sourceKind = String(input.sourceKind || 'collaboration').trim().slice(0, 40);
    const idempotencyKey = String(input.idempotencyKey || '').trim();
    const filename = path.basename(String(input.filename || '')).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300);
    const mimeType = String(input.mimeType || 'application/octet-stream').trim().slice(0, 160);
    const expectedSize = Math.trunc(Number(input.expectedSize));
    const expectedHash = input.expectedHash ? normalizeSha256(input.expectedHash) : null;
    const chunkSize = Math.trunc(Number(input.chunkSize));
    const chunkCount = Math.ceil(expectedSize / chunkSize);
    if (!memberId || !filename || !/^[a-zA-Z0-9._:-]{8,160}$/.test(idempotencyKey)) throw assetUploadError('asset_upload_request_invalid', '上传成员、文件名或幂等键无效', null, 400);
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 || !Number.isSafeInteger(chunkCount) || chunkCount <= 0) throw assetUploadError('asset_upload_size_invalid', '上传大小或分片大小无效', null, 400);
    if (input.expectedHash && !expectedHash) throw assetUploadError('asset_upload_hash_invalid', '文件 SHA-256 格式无效', null, 422);
    const requestDigest = crypto.createHash('sha256').update(stableJson({ filename, mimeType, expectedSize, expectedHash, chunkSize, sourceKind })).digest('hex');
    const now = Number(input.now) || Date.now();
    const expiresAt = Math.max(now + 60_000, Math.trunc(Number(input.expiresAt) || now + 24 * 60 * 60 * 1000));
    const id = String(input.id || `asset-upload-${crypto.randomUUID()}`);
    const run = this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM asset_upload_sessions WHERE project_id = ? AND member_id = ? AND idempotency_key = ?
      `).get(projectId, memberId, idempotencyKey);
      if (existing) {
        if (existing.request_digest !== requestDigest) throw assetUploadError('asset_upload_idempotency_conflict', '上传幂等键已用于不同文件', this.mapAssetUploadSession(existing), 409);
        return { ...this.mapAssetUploadSession(existing), idempotentReplay: true };
      }
      const quota = this.getAssetUploadQuotaStatus(projectId, memberId, {
        now,
        projectLimit: limits.projectLimit,
        memberLimit: limits.memberLimit,
      });
      if (expectedSize > quota.project.availableBytes) {
        throw assetUploadError('asset_upload_project_quota_exceeded', 'project quota 不足，无法预留上传空间', quota, 413);
      }
      if (expectedSize > quota.member.availableBytes) {
        throw assetUploadError('asset_upload_member_quota_exceeded', 'member quota 不足，无法预留上传空间', quota, 413);
      }
      this.db.prepare(`
        INSERT INTO asset_upload_sessions(
          id, project_id, member_id, source_kind, idempotency_key, request_digest,
          filename, mime_type, expected_size, expected_hash, chunk_size, chunk_count,
          received_bytes, reserved_bytes, status, revision, asset_id, content_hash,
          deduplicated, error_code, error_message, created_at, updated_at, expires_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'uploading', 1, NULL, NULL, 0, NULL, NULL, ?, ?, ?, NULL)
      `).run(
        id, projectId, memberId, sourceKind, idempotencyKey, requestDigest,
        filename, mimeType, expectedSize, expectedHash, chunkSize, chunkCount,
        expectedSize, now, now, expiresAt,
      );
      return this.getAssetUploadSession(id);
    });
    return run.immediate();
  }

  recordAssetUploadChunk(sessionId, input = {}) {
    const id = String(sessionId || '');
    const index = Math.trunc(Number(input.index));
    const start = Math.trunc(Number(input.start));
    const end = Math.trunc(Number(input.end));
    const size = Math.trunc(Number(input.size));
    const contentHash = normalizeSha256(input.contentHash);
    const now = Number(input.now) || Date.now();
    if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(start) || start < 0
      || !Number.isSafeInteger(end) || end < start || size !== end - start + 1 || !contentHash) {
      throw assetUploadError('asset_upload_chunk_invalid', '上传分片范围、大小或 SHA-256 无效', null, 422);
    }
    const run = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM asset_upload_sessions WHERE id = ?').get(id);
      if (!row) throw assetUploadError('asset_upload_session_missing', '上传会话不存在', null, 404);
      const session = this.mapAssetUploadSession(row, { includeChunks: false });
      if (session.expiresAt <= now) throw assetUploadError('asset_upload_session_expired', '上传会话已过期', session, 410);
      if (session.status !== 'uploading') throw assetUploadError('asset_upload_state_conflict', '上传会话当前不能接收分片', session, 409);
      const expectedStart = index * session.chunkSize;
      const expectedEnd = Math.min(session.expectedSize - 1, expectedStart + session.chunkSize - 1);
      if (index >= session.chunkCount || start !== expectedStart || end !== expectedEnd || size !== expectedEnd - expectedStart + 1) {
        throw assetUploadError('asset_upload_range_invalid', '分片 Content-Range 与会话不一致', session, 416);
      }
      const existing = this.db.prepare('SELECT * FROM asset_upload_chunks WHERE session_id = ? AND chunk_index = ?').get(id, index);
      if (existing) {
        if (existing.byte_start !== start || existing.byte_end !== end || existing.byte_size !== size || existing.content_hash !== contentHash) {
          throw assetUploadError('asset_upload_chunk_conflict', '该分片序号已写入不同内容', session, 409);
        }
        return this.getAssetUploadSession(id);
      }
      this.db.prepare(`
        INSERT INTO asset_upload_chunks(session_id, chunk_index, byte_start, byte_end, byte_size, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, index, start, end, size, contentHash, now, now);
      this.db.prepare(`
        UPDATE asset_upload_sessions SET
          received_bytes=(SELECT COALESCE(SUM(byte_size), 0) FROM asset_upload_chunks WHERE session_id = ?),
          revision=revision + 1, updated_at=? WHERE id=?
      `).run(id, now, id);
      return this.getAssetUploadSession(id);
    });
    return run.immediate();
  }

  transitionAssetUploadSession(sessionId, action, options = {}) {
    const id = String(sessionId || '');
    const now = Number(options.now) || Date.now();
    const transitions = {
      pause: { from: ['uploading'], to: 'paused' },
      resume: { from: ['paused'], to: 'uploading' },
      cancel: { from: [...ASSET_UPLOAD_ACTIVE_STATUSES], to: 'cancelled' },
    };
    const transition = transitions[String(action || '')];
    if (!transition) throw assetUploadError('asset_upload_action_invalid', '上传会话操作无效', null, 400);
    const run = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM asset_upload_sessions WHERE id = ?').get(id);
      if (!row) throw assetUploadError('asset_upload_session_missing', '上传会话不存在', null, 404);
      const current = this.mapAssetUploadSession(row);
      if (current.status === transition.to) return current;
      if (!transition.from.includes(current.status)) throw assetUploadError('asset_upload_state_conflict', '上传会话状态冲突', current, 409);
      this.db.prepare(`
        UPDATE asset_upload_sessions SET status=?, revision=revision + 1, updated_at=?,
          error_code=NULL, error_message=NULL WHERE id=?
      `).run(transition.to, now, id);
      return this.getAssetUploadSession(id);
    });
    return run.immediate();
  }

  claimAssetUploadCompletion(sessionId, options = {}) {
    const id = String(sessionId || '');
    const now = Number(options.now) || Date.now();
    const run = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM asset_upload_sessions WHERE id = ?').get(id);
      if (!row) throw assetUploadError('asset_upload_session_missing', '上传会话不存在', null, 404);
      const current = this.mapAssetUploadSession(row);
      if (current.status === 'completed') return current;
      if (current.expiresAt <= now) throw assetUploadError('asset_upload_session_expired', '上传会话已过期', current, 410);
      if (current.status !== 'uploading') throw assetUploadError('asset_upload_state_conflict', '上传会话当前不能完成', current, 409);
      if (current.receivedBytes !== current.expectedSize || current.receivedChunks.length !== current.chunkCount) {
        throw assetUploadError('asset_upload_incomplete', '上传分片尚未完整', current, 409);
      }
      this.db.prepare(`
        UPDATE asset_upload_sessions SET status='assembling', revision=revision + 1, updated_at=? WHERE id=? AND status='uploading'
      `).run(now, id);
      return this.getAssetUploadSession(id);
    });
    return run.immediate();
  }

  completeAssetUploadSession(sessionId, input = {}) {
    const id = String(sessionId || '');
    const contentHash = normalizeSha256(input.contentHash);
    const assetId = String(input.assetId || '').trim();
    const now = Number(input.now) || Date.now();
    if (!contentHash || !assetId) throw assetUploadError('asset_upload_commit_invalid', '上传提交缺少素材或内容身份', null, 422);
    const run = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM asset_upload_sessions WHERE id = ?').get(id);
      if (!row) throw assetUploadError('asset_upload_session_missing', '上传会话不存在', null, 404);
      const current = this.mapAssetUploadSession(row);
      if (current.status === 'completed') {
        if (current.assetId !== assetId || current.contentHash !== contentHash) throw assetUploadError('asset_upload_commit_conflict', '上传会话已提交为不同素材', current, 409);
        return current;
      }
      if (current.status !== 'assembling') throw assetUploadError('asset_upload_state_conflict', '上传会话不在提交状态', current, 409);
      this.db.prepare(`
        UPDATE asset_upload_sessions SET status='completed', asset_id=?, content_hash=?, deduplicated=?,
          revision=revision + 1, updated_at=?, completed_at=?, error_code=NULL, error_message=NULL WHERE id=?
      `).run(assetId, contentHash, input.deduplicated ? 1 : 0, now, now, id);
      return this.getAssetUploadSession(id);
    });
    return run.immediate();
  }

  commitAssetUpload(input = {}) {
    const sessionId = String(input.sessionId || '');
    const blob = input.blob && typeof input.blob === 'object' ? input.blob : {};
    const assetInput = input.asset && typeof input.asset === 'object' ? input.asset : {};
    const lineageInput = input.lineage && typeof input.lineage === 'object' ? input.lineage : {};
    const contentHash = normalizeSha256(blob.contentHash || assetInput.contentHash);
    const assetId = String(assetInput.id || '').trim();
    if (!sessionId || !contentHash || !assetId) {
      throw assetUploadError('asset_upload_commit_invalid', '上传原子提交缺少会话、素材或内容身份', null, 422);
    }
    const run = this.db.transaction(() => {
      const current = this.getAssetUploadSession(sessionId);
      if (!current) throw assetUploadError('asset_upload_session_missing', '上传会话不存在', null, 404);
      if (current.status === 'completed') {
        if (current.assetId !== assetId || current.contentHash !== contentHash) {
          throw assetUploadError('asset_upload_commit_conflict', '上传会话已提交为不同素材', current, 409);
        }
        const existing = this.getAsset(assetId);
        if (!existing) throw assetUploadError('asset_upload_commit_missing', '已完成上传缺少素材记录', current, 409);
        return { asset: existing, session: current };
      }
      if (current.status !== 'assembling') {
        throw assetUploadError('asset_upload_state_conflict', '上传会话不在原子提交状态', current, 409);
      }
      this.markAssetBlobStored({
        ...blob,
        contentHash,
      });
      const asset = this.upsertAsset({
        ...assetInput,
        id: assetId,
        contentHash,
        contentHashVerification: 'verified',
      });
      if (normalizeSha256(asset?.contentHash) !== contentHash) {
        throw assetUploadError('asset_upload_commit_conflict', '素材内容身份与 CAS blob 不一致', current, 409);
      }
      this.recordAssetLineageEvent({
        ...lineageInput,
        assetId,
      });
      const session = this.completeAssetUploadSession(sessionId, {
        assetId,
        contentHash,
        deduplicated: Boolean(input.deduplicated),
      });
      return { asset: this.getAsset(assetId), session };
    });
    return run.immediate();
  }

  failAssetUploadSession(sessionId, input = {}) {
    const id = String(sessionId || '');
    const now = Number(input.now) || Date.now();
    const code = String(input.code || 'asset_upload_failed').slice(0, 120);
    const message = String(input.message || '上传处理失败').replace(/[\r\n]+/g, ' ').slice(0, 500);
    this.db.prepare(`
      UPDATE asset_upload_sessions SET status='failed', revision=revision + 1, updated_at=?,
        error_code=?, error_message=? WHERE id=? AND status IN ('uploading', 'paused', 'assembling')
    `).run(now, code, message, id);
    return this.getAssetUploadSession(id);
  }

  recoverInterruptedAssetUploadSessions(now = Date.now()) {
    const rows = this.db.prepare("SELECT id FROM asset_upload_sessions WHERE status = 'assembling'").all();
    this.db.prepare(`
      UPDATE asset_upload_sessions SET status='uploading', revision=revision + 1, updated_at=?,
        error_code='asset_upload_recovered', error_message='主机重启后已恢复，可重新提交完成请求'
      WHERE status='assembling'
    `).run(Number(now) || Date.now());
    return rows.map((row) => row.id);
  }

  expireAssetUploadSessions(now = Date.now()) {
    const timestamp = Number(now) || Date.now();
    const active = [...ASSET_UPLOAD_ACTIVE_STATUSES];
    const placeholders = active.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT id FROM asset_upload_sessions WHERE status IN (${placeholders}) AND expires_at <= ?
    `).all(...active, timestamp);
    this.db.prepare(`
      UPDATE asset_upload_sessions SET status='expired', revision=revision + 1, updated_at=?,
        error_code='asset_upload_expired', error_message='上传会话已过期'
      WHERE status IN (${placeholders}) AND expires_at <= ?
    `).run(timestamp, ...active, timestamp);
    return rows.map((row) => row.id);
  }

  purgeAssetUploadChunks(sessionId) {
    return this.db.prepare('DELETE FROM asset_upload_chunks WHERE session_id = ?').run(String(sessionId || '')).changes;
  }

  getCollaborativeTextDocument(input = {}) {
    const row = this.db.prepare(`
      SELECT * FROM collaboration_text_documents
      WHERE project_id = ? AND canvas_id = ? AND target_type = ? AND target_id = ? AND field_name = ?
    `).get(
      String(input.projectId || DEFAULT_PROJECT_ID),
      String(input.canvasId || ''),
      String(input.targetType || ''),
      String(input.targetId || ''),
      String(input.field || ''),
    );
    return row ? {
      projectId: row.project_id,
      canvasId: row.canvas_id,
      targetType: row.target_type,
      targetId: row.target_id,
      field: row.field_name,
      state: Buffer.from(row.state_blob),
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    } : null;
  }

  saveCollaborativeTextDocument(input = {}) {
    const now = Date.now();
    const state = Buffer.isBuffer(input.state) ? input.state : Buffer.from(input.state || []);
    this.db.prepare(`
      INSERT INTO collaboration_text_documents(
        project_id, canvas_id, target_type, target_id, field_name, state_blob, updated_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, canvas_id, target_type, target_id, field_name) DO UPDATE SET
        state_blob=excluded.state_blob, updated_by=excluded.updated_by, updated_at=excluded.updated_at
    `).run(
      String(input.projectId || DEFAULT_PROJECT_ID),
      String(input.canvasId || ''),
      String(input.targetType || ''),
      String(input.targetId || ''),
      String(input.field || ''),
      state,
      String(input.updatedBy || 'local-owner'),
      now,
    );
    return this.getCollaborativeTextDocument(input);
  }

  appendAuditEvent(input = {}) {
    const createdAt = Math.max(1, Number(input.createdAt) || Date.now());
    const result = this.db.prepare(`
      INSERT INTO audit_events(project_id, canvas_id, actor_id, session_id, action, target_type, target_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(input.projectId || DEFAULT_PROJECT_ID),
      input.canvasId ? String(input.canvasId) : null,
      String(input.actorId || 'local-owner'),
      String(input.sessionId || 'local-session'),
      String(input.action || 'unknown').slice(0, 120),
      input.targetType ? String(input.targetType).slice(0, 80) : null,
      input.targetId ? String(input.targetId).slice(0, 240) : null,
      JSON.stringify(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
      createdAt,
    );
    return { id: Number(result.lastInsertRowid), createdAt };
  }

  listAuditEvents(filters = {}) {
    const clauses = ['project_id = ?'];
    const values = [String(filters.projectId || DEFAULT_PROJECT_ID)];
    if (filters.canvasId) { clauses.push('canvas_id = ?'); values.push(String(filters.canvasId)); }
    if (filters.action) { clauses.push('action = ?'); values.push(String(filters.action)); }
    const limit = Math.min(1000, Math.max(1, Number(filters.limit) || 100));
    return this.db.prepare(`
      SELECT * FROM audit_events WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...values, limit).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      canvasId: row.canvas_id,
      actorId: row.actor_id,
      sessionId: row.session_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: parseJson(row.metadata_json, {}),
      createdAt: row.created_at,
    }));
  }
}

let singleton = null;

function getProjectDatabase(config) {
  if (!singleton) singleton = new ProjectDatabase(config.PROJECT_DB_FILE, {
    backupFilename: config.PROJECT_DB_BACKUP_FILE,
  });
  return singleton;
}

module.exports = {
  PROJECT_DATABASE_SCHEMA_VERSION,
  OPERATION_SNAPSHOT_INTERVAL,
  stableAssetSourceLocator,
  encodeFloat32LE,
  decodeFloat32LE,
  cosineSimilarity,
  semanticProfileDigest,
  ProjectDatabase,
  RevisionConflictError,
  OperationIdConflictError,
  OperationIdReservedError,
  SubflowRevisionConflictError,
  CanvasPatchConflictError,
  CanvasPatchConfirmationError,
  CanvasPatchNotFoundError,
  CanvasPatchPermissionError,
  CanvasPatchRevertConflictError,
  CanvasPatchValidationError,
  getProjectDatabase,
};
