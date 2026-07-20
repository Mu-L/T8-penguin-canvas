const crypto = require('crypto');
const Y = require('yjs');

const COLLABORATION_TEXT_UPDATE_CONTRACT = 't8-collaboration-text-update-v1';
const COLLABORATION_TEXT_BINDING_CONTRACT = 't8-collaboration-text-binding-v1';
const CANVAS_DOCUMENT_CONTRACT = 't8-canvas-document';
const CANVAS_DOCUMENT_VERSION = 2;
const MAX_TEXT_UPDATE_BYTES = 256 * 1024;
const MAX_TEXT_STATE_BYTES = 1024 * 1024;
const MAX_TEXT_ENVELOPE_BYTES = 384 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ENVELOPE_KEYS = Object.freeze([
  'contractVersion',
  'updateId',
  'clientSeq',
  'projectId',
  'canvasId',
  'baseRevision',
  'targetType',
  'targetEntityUid',
  'bindingEpoch',
  'field',
  'update',
]);

function fieldPolicy(path, capability, maxChars, maxBytes) {
  return Object.freeze({ path: Object.freeze(path), capability, maxChars, maxBytes });
}

const TEXT_FIELD_POLICIES = Object.freeze({
  canvas: Object.freeze({
    title: fieldPolicy(['title'], 'editGraph', 512, 2 * 1024),
    description: fieldPolicy(['description'], 'editGraph', 50_000, 200 * 1024),
  }),
  node: Object.freeze({
    title: fieldPolicy(['data', 'title'], 'editGraph', 512, 2 * 1024),
    label: fieldPolicy(['data', 'label'], 'editGraph', 512, 2 * 1024),
    prompt: fieldPolicy(['data', 'prompt'], 'editGraph', 200_000, 512 * 1024),
    negativePrompt: fieldPolicy(['data', 'negativePrompt'], 'editGraph', 200_000, 512 * 1024),
    notes: fieldPolicy(['data', 'notes'], 'editGraph', 50_000, 200 * 1024),
    description: fieldPolicy(['data', 'description'], 'editGraph', 50_000, 200 * 1024),
  }),
  edge: Object.freeze({
    label: fieldPolicy(['label'], 'editGraph', 512, 2 * 1024),
    notes: fieldPolicy(['data', 'notes'], 'editGraph', 50_000, 200 * 1024),
  }),
  review: Object.freeze({
    body: fieldPolicy(['body'], 'comment', 5_000, 20 * 1024),
  }),
  subflow: Object.freeze({
    name: fieldPolicy(['name'], 'editGraph', 256, 1024),
    description: fieldPolicy(['description'], 'editGraph', 50_000, 200 * 1024),
  }),
});

const ERROR_DEFINITIONS = Object.freeze({
  unsafeEnvelope: ['collaboration_text_unsafe_envelope', 400, '协同文本信封包含不安全字段'],
  contractInvalid: ['collaboration_text_contract_invalid', 400, '协同文本协议版本无效'],
  envelopeInvalid: ['collaboration_text_envelope_invalid', 400, '协同文本信封无效'],
  envelopeTooLarge: ['collaboration_text_envelope_too_large', 413, '协同文本信封超过大小上限'],
  scopeMismatch: ['collaboration_text_scope_mismatch', 409, '协同文本作用域与权威画布不一致'],
  schemaMismatch: ['collaboration_text_schema_mismatch', 409, '协同文本画布 schema 不兼容'],
  revisionConflict: ['collaboration_text_revision_conflict', 409, '协同文本 baseRevision 无效或过期'],
  offlineForbidden: ['collaboration_text_offline_forbidden', 409, '协同文本不允许离线排队或重放'],
  permissionDenied: ['collaboration_text_permission_denied', 403, '当前成员无权修改该协同文本字段'],
  fieldForbidden: ['collaboration_text_field_forbidden', 422, '目标字段不在协同文本白名单中'],
  targetMissing: ['collaboration_text_target_missing', 404, '协同文本目标不存在'],
  targetDeleted: ['collaboration_text_target_deleted', 409, '协同文本目标已删除'],
  targetAmbiguous: ['collaboration_text_target_ambiguous', 409, '协同文本目标身份不唯一'],
  bindingInvalid: ['collaboration_text_binding_invalid', 409, '协同文本绑定状态无效'],
  bindingEpochMismatch: ['collaboration_text_binding_epoch_mismatch', 409, '协同文本绑定 epoch 已失效'],
  updateInvalid: ['collaboration_text_update_invalid', 400, '协同文本 Yjs 更新无效'],
  updateTooLarge: ['collaboration_text_update_too_large', 413, '协同文本 Yjs 更新超过大小上限'],
  stateInvalid: ['collaboration_text_state_invalid', 409, '权威协同文本状态损坏或不兼容'],
  materializationMismatch: ['collaboration_text_materialization_mismatch', 409, 'Y.Text 与物化字段不一致'],
  materializedTooLarge: ['collaboration_text_materialized_too_large', 413, '协同文本物化正文超过字段上限'],
  idempotencyCollision: ['collaboration_text_idempotency_collision', 409, '协同文本 updateId 与既有请求碰撞'],
  clientSeqConflict: ['collaboration_text_client_seq_conflict', 409, '协同文本 clientSeq 不连续'],
  authorityInvalid: ['collaboration_text_authority_invalid', 500, '协同文本权威上下文无效'],
});

class CollaborationTextAuthorityError extends Error {
  constructor(definition, details = null) {
    super(definition[2]);
    this.name = 'CollaborationTextAuthorityError';
    this.code = definition[0];
    this.status = definition[1];
    if (details != null) this.details = details;
  }
}

function fail(key, details = null) {
  throw new CollaborationTextAuthorityError(ERROR_DEFINITIONS[key], details);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function dataKeys(value, label, errorKey = 'unsafeEnvelope') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) {
    fail(errorKey, { label });
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    fail(errorKey, { label });
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : null;
    if (typeof key !== 'string' || UNSAFE_KEYS.has(key) || !descriptor?.enumerable || !hasOwn(descriptor, 'value')) {
      fail(errorKey, { label, key: typeof key === 'string' ? key : 'symbol' });
    }
  }
  return keys;
}

function exactRecord(value, allowedKeys, label) {
  const keys = dataKeys(value, label);
  const allowed = new Set(allowedKeys);
  for (const key of keys) if (!allowed.has(key)) fail('envelopeInvalid', { label, key, reason: 'extra' });
  for (const key of allowedKeys) if (!hasOwn(value, key)) fail('envelopeInvalid', { label, key, reason: 'missing' });
  return value;
}

function canonicalUuid(value, label, errorKey = 'envelopeInvalid') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail(errorKey, { label });
  return value.toLowerCase();
}

function boundedIdentity(value, label, errorKey = 'authorityInvalid') {
  if (typeof value !== 'string' || !value || value.length > 240
    || /[\u0000-\u001f\u007f]/.test(value) || UNSAFE_KEYS.has(value)) {
    fail(errorKey, { label });
  }
  return value;
}

function safeInteger(value, label, minimum, errorKey = 'envelopeInvalid') {
  if (!Number.isSafeInteger(value) || value < minimum) fail(errorKey, { label });
  return value;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function decodeCanonicalBase64(value, label, options = {}) {
  if (typeof value !== 'string') fail(options.errorKey || 'updateInvalid', { label });
  if (!value.length && options.allowEmpty) return Buffer.alloc(0);
  if (!value.length || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail(options.errorKey || 'updateInvalid', { label });
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) fail(options.errorKey || 'updateInvalid', { label });
  const maximum = Number(options.maximum);
  if (Number.isFinite(maximum) && decoded.length > maximum) fail(options.tooLargeKey || 'updateTooLarge', { label });
  return decoded;
}

function normalizeEnvelope(rawEnvelope) {
  exactRecord(rawEnvelope, ENVELOPE_KEYS, 'envelope');
  if (rawEnvelope.contractVersion !== COLLABORATION_TEXT_UPDATE_CONTRACT) fail('contractInvalid');
  const targetType = String(rawEnvelope.targetType || '');
  if (!hasOwn(TEXT_FIELD_POLICIES, targetType)) fail('fieldForbidden', { targetType });
  const field = String(rawEnvelope.field || '');
  const policy = TEXT_FIELD_POLICIES[targetType][field];
  if (!policy) fail('fieldForbidden', { targetType, field });
  const update = decodeCanonicalBase64(rawEnvelope.update, 'envelope.update', {
    maximum: MAX_TEXT_UPDATE_BYTES,
    errorKey: 'updateInvalid',
    tooLargeKey: 'updateTooLarge',
  });
  const normalized = {
    contractVersion: COLLABORATION_TEXT_UPDATE_CONTRACT,
    updateId: canonicalUuid(rawEnvelope.updateId, 'envelope.updateId'),
    clientSeq: safeInteger(rawEnvelope.clientSeq, 'envelope.clientSeq', 0),
    projectId: boundedIdentity(rawEnvelope.projectId, 'envelope.projectId', 'envelopeInvalid'),
    canvasId: boundedIdentity(rawEnvelope.canvasId, 'envelope.canvasId', 'envelopeInvalid'),
    baseRevision: safeInteger(rawEnvelope.baseRevision, 'envelope.baseRevision', 1),
    targetType,
    targetEntityUid: canonicalUuid(rawEnvelope.targetEntityUid, 'envelope.targetEntityUid'),
    bindingEpoch: canonicalUuid(rawEnvelope.bindingEpoch, 'envelope.bindingEpoch'),
    field,
    update: rawEnvelope.update,
  };
  const serialized = stableJson(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TEXT_ENVELOPE_BYTES) fail('envelopeTooLarge');
  return {
    envelope: normalized,
    update,
    requestDigest: sha256(serialized),
    updateDigest: sha256(update),
    policy,
  };
}

function assertDocument(envelope, authority) {
  const document = authority?.document;
  dataKeys(document, 'authority.document', 'authorityInvalid');
  if (document.schema !== CANVAS_DOCUMENT_CONTRACT || document.schemaVersion !== CANVAS_DOCUMENT_VERSION) {
    fail('schemaMismatch', { schema: document.schema, schemaVersion: document.schemaVersion });
  }
  const projectId = boundedIdentity(document.projectId, 'authority.document.projectId', 'authorityInvalid');
  const canvasId = boundedIdentity(document.canvasId, 'authority.document.canvasId', 'authorityInvalid');
  if (projectId !== envelope.projectId || canvasId !== envelope.canvasId) fail('scopeMismatch');
  const revision = safeInteger(document.revision, 'authority.document.revision', 1, 'authorityInvalid');
  if (envelope.baseRevision > revision) fail('revisionConflict', { currentRevision: revision });
  return { document, revision };
}

function assertPrincipal(envelope, policy, authority) {
  const principal = authority?.principal;
  dataKeys(principal, 'authority.principal', 'authorityInvalid');
  if (principal.projectId != null
    && boundedIdentity(principal.projectId, 'authority.principal.projectId', 'authorityInvalid') !== envelope.projectId) {
    fail('scopeMismatch');
  }
  if (principal.canvasId != null
    && boundedIdentity(principal.canvasId, 'authority.principal.canvasId', 'authorityInvalid') !== envelope.canvasId) {
    fail('scopeMismatch');
  }
  const role = String(principal.role || '');
  if (!['owner', 'editor', 'reviewer', 'viewer'].includes(role)) fail('authorityInvalid', { label: 'authority.principal.role' });
  if (!Array.isArray(principal.capabilities)
    || principal.capabilities.some((item) => typeof item !== 'string' || item.length > 80)) {
    fail('authorityInvalid', { label: 'authority.principal.capabilities' });
  }
  if (!principal.capabilities.includes(policy.capability)) {
    fail('permissionDenied', { requiredCapability: policy.capability, role });
  }
  return {
    actorId: boundedIdentity(principal.memberId || principal.actorId, 'authority.principal.memberId'),
    sessionId: boundedIdentity(principal.sessionId, 'authority.principal.sessionId'),
    role,
  };
}

function assertOnline(authority) {
  const transport = authority?.transport;
  if (!transport || transport.online !== true || transport.mode === 'offline'
    || transport.queued === true || transport.replayedFromOffline === true) {
    fail('offlineForbidden');
  }
}

function entityUid(value) {
  return value && UUID_PATTERN.test(String(value.entityUid || ''))
    ? String(value.entityUid).toLowerCase()
    : null;
}

function collectionForTarget(type, document, authority) {
  if (type === 'canvas') return [document];
  if (type === 'node') return Array.isArray(document.nodes) ? document.nodes : [];
  if (type === 'edge') return Array.isArray(document.edges) ? document.edges : [];
  if (type === 'review') {
    if (Array.isArray(authority.reviewComments)) return authority.reviewComments;
    return Array.isArray(authority.reviewTargets) ? authority.reviewTargets : [];
  }
  if (type === 'subflow') {
    const documentTargets = Array.isArray(document.subflowInstances) ? document.subflowInstances : [];
    return documentTargets.length > 0 ? documentTargets : (Array.isArray(authority.subflows) ? authority.subflows : []);
  }
  return [];
}

function recordsContainTombstone(records, targetEntityUid) {
  if (!records) return false;
  const values = Array.isArray(records)
    ? records
    : (typeof records === 'object' ? Object.values(records) : []);
  return values.some((record) => entityUid(record) === targetEntityUid);
}

function targetTombstoned(type, document, authority, targetEntityUid) {
  const plural = type === 'canvas' ? 'canvases' : type === 'review' ? 'reviews' : `${type}s`;
  return recordsContainTombstone(document.tombstones?.[plural], targetEntityUid)
    || recordsContainTombstone(authority.tombstones?.[plural], targetEntityUid);
}

function lifecycleDeleted(value) {
  const lifecycle = String(value?.lifecycle || value?.state || '').toLowerCase();
  const status = String(value?.status || '').toLowerCase();
  return value?.deletedAt != null || value?.tombstone === true
    || ['deleted', 'tombstoned', 'purged'].includes(lifecycle)
    || ['deleted', 'tombstoned', 'purged'].includes(status);
}

function resolveTarget(envelope, document, authority) {
  const matches = collectionForTarget(envelope.targetType, document, authority)
    .filter((value) => entityUid(value) === envelope.targetEntityUid);
  if (matches.length > 1) fail('targetAmbiguous');
  if (targetTombstoned(envelope.targetType, document, authority, envelope.targetEntityUid)) {
    fail('targetDeleted');
  }
  const target = matches[0];
  if (!target) fail('targetMissing');
  if (lifecycleDeleted(target)) fail('targetDeleted');
  if (target.projectId != null
    && boundedIdentity(target.projectId, 'target.projectId', 'authorityInvalid') !== envelope.projectId) fail('scopeMismatch');
  if (target.canvasId != null
    && boundedIdentity(target.canvasId, 'target.canvasId', 'authorityInvalid') !== envelope.canvasId) fail('scopeMismatch');
  return target;
}

function readPath(value, path) {
  let current = value;
  for (const key of path) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function decodeBindingState(binding) {
  if (Buffer.isBuffer(binding.state)) {
    if (binding.state.length > MAX_TEXT_STATE_BYTES) fail('stateInvalid', { reason: 'state_too_large' });
    return Buffer.from(binding.state);
  }
  return decodeCanonicalBase64(binding.state, 'authority.binding.state', {
    maximum: MAX_TEXT_STATE_BYTES,
    allowEmpty: true,
    errorKey: 'stateInvalid',
    tooLargeKey: 'stateInvalid',
  });
}

function assertPlainYText(document, errorKey) {
  const text = document.getText('content');
  const roots = [...document.share.entries()];
  if (roots.length !== 1 || roots[0][0] !== 'content' || !(roots[0][1] instanceof Y.Text)) {
    fail(errorKey, { reason: 'unexpected_shared_type' });
  }
  const delta = text.toDelta();
  if (delta.some((part) => typeof part?.insert !== 'string'
    || hasOwn(part, 'attributes') || Object.keys(part).some((key) => key !== 'insert'))) {
    fail(errorKey, { reason: 'rich_text_forbidden' });
  }
  return text;
}

function loadAuthoritativeText(binding) {
  const state = decodeBindingState(binding);
  const document = new Y.Doc();
  try {
    if (state.length) Y.applyUpdate(document, state);
  } catch (_) {
    document.destroy();
    fail('stateInvalid', { reason: 'yjs_decode_failed' });
  }
  let text;
  try {
    text = assertPlainYText(document, 'stateInvalid');
  } catch (error) {
    document.destroy();
    throw error;
  }
  return { document, text, state };
}

function assertBinding(envelope, target, policy, documentRevision, authority) {
  const binding = authority?.binding;
  dataKeys(binding, 'authority.binding', 'bindingInvalid');
  if (binding.contractVersion !== COLLABORATION_TEXT_BINDING_CONTRACT) fail('bindingInvalid', { label: 'contractVersion' });
  const checks = [
    ['projectId', envelope.projectId],
    ['canvasId', envelope.canvasId],
    ['targetEntityUid', envelope.targetEntityUid],
    ['bindingEpoch', envelope.bindingEpoch],
  ];
  for (const [key, expected] of checks) {
    const actual = key === 'projectId' || key === 'canvasId'
      ? boundedIdentity(binding[key], `authority.binding.${key}`, 'bindingInvalid')
      : canonicalUuid(binding[key], `authority.binding.${key}`, 'bindingInvalid');
    if (key === 'bindingEpoch' && actual !== expected) fail('bindingEpochMismatch', { currentBindingEpoch: actual });
    if (key !== 'bindingEpoch' && actual !== expected) fail('bindingInvalid', { label: key });
  }
  if (binding.targetType !== envelope.targetType || binding.field !== envelope.field) fail('bindingInvalid', { label: 'target-or-field' });
  if (String(binding.lifecycle || '') !== 'active') fail('targetDeleted');
  const createdRevision = safeInteger(binding.createdRevision, 'authority.binding.createdRevision', 1, 'bindingInvalid');
  const bindingRevision = safeInteger(binding.revision, 'authority.binding.revision', createdRevision, 'bindingInvalid');
  if (bindingRevision > documentRevision || envelope.baseRevision < createdRevision) {
    fail('revisionConflict', { currentRevision: documentRevision, createdRevision });
  }
  if (typeof binding.materializedText !== 'string') fail('bindingInvalid', { label: 'materializedText' });
  const loaded = loadAuthoritativeText(binding);
  const stateText = loaded.text.toString();
  const targetText = readPath(target, policy.path);
  if (stateText !== binding.materializedText
    || (targetText !== undefined && (typeof targetText !== 'string' || targetText !== stateText))
    || (targetText === undefined && stateText !== '')) {
    loaded.document.destroy();
    fail('materializationMismatch');
  }
  return { binding, createdRevision, bindingRevision, ...loaded };
}

function assertMaterializedText(text, policy) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (text.length > policy.maxChars || bytes > policy.maxBytes) {
    fail('materializedTooLarge', { maxChars: policy.maxChars, maxBytes: policy.maxBytes });
  }
  if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    fail('updateInvalid', { reason: 'forbidden_control_character' });
  }
  return bytes;
}

function validateStoredResult(result, envelope) {
  dataKeys(result, 'authority.idempotencyRecord.result', 'authorityInvalid');
  const checks = [
    ['updateId', envelope.updateId],
    ['projectId', envelope.projectId],
    ['canvasId', envelope.canvasId],
    ['targetEntityUid', envelope.targetEntityUid],
    ['bindingEpoch', envelope.bindingEpoch],
  ];
  for (const [key, expected] of checks) {
    const actual = key === 'projectId' || key === 'canvasId'
      ? boundedIdentity(result[key], `authority.idempotencyRecord.result.${key}`, 'authorityInvalid')
      : canonicalUuid(result[key], `authority.idempotencyRecord.result.${key}`, 'authorityInvalid');
    if (actual !== expected) {
      fail('authorityInvalid', { label: `result.${key}` });
    }
  }
  if (result.contractVersion !== COLLABORATION_TEXT_UPDATE_CONTRACT
    || result.targetType !== envelope.targetType || result.field !== envelope.field) {
    fail('authorityInvalid', { label: 'result.contract-or-target' });
  }
  safeInteger(result.revision, 'authority.idempotencyRecord.result.revision', 1, 'authorityInvalid');
  if (typeof result.text !== 'string' || typeof result.state !== 'string'
    || typeof result.stateVector !== 'string' || !DIGEST_PATTERN.test(String(result.textDigest || ''))) {
    fail('authorityInvalid', { label: 'result.payload' });
  }
  return JSON.parse(JSON.stringify(result));
}

function exactRetryPlan(envelope, requestDigest, principal, authority) {
  const record = authority?.idempotencyRecord;
  if (record == null) return null;
  dataKeys(record, 'authority.idempotencyRecord', 'authorityInvalid');
  const recordUpdateId = canonicalUuid(record.updateId, 'authority.idempotencyRecord.updateId', 'authorityInvalid');
  if (recordUpdateId !== envelope.updateId) fail('authorityInvalid', { label: 'idempotencyRecord.updateId' });
  if (String(record.requestDigest || '').toLowerCase() !== requestDigest
    || String(record.actorId || '') !== principal.actorId
    || String(record.sessionId || '') !== principal.sessionId
    || String(record.projectId || '') !== envelope.projectId
    || String(record.canvasId || '') !== envelope.canvasId) {
    fail('idempotencyCollision');
  }
  const result = validateStoredResult(record.result, envelope);
  return {
    contractVersion: COLLABORATION_TEXT_UPDATE_CONTRACT,
    type: 'text.update',
    updateId: envelope.updateId,
    requestDigest,
    duplicate: true,
    atomic: true,
    scope: { projectId: envelope.projectId, canvasId: envelope.canvasId, baseRevision: envelope.baseRevision },
    preconditions: [],
    writes: [],
    operation: null,
    audit: null,
    idempotencyRecord: JSON.parse(JSON.stringify(record)),
    result,
  };
}

function authorizeCollaborationTextUpdate(rawEnvelope, authority = {}) {
  const normalized = normalizeEnvelope(rawEnvelope);
  const { envelope, update, requestDigest, updateDigest, policy } = normalized;
  const { document, revision: currentRevision } = assertDocument(envelope, authority);
  assertOnline(authority);
  const principal = assertPrincipal(envelope, policy, authority);
  const retry = exactRetryPlan(envelope, requestDigest, principal, authority);
  if (retry) return retry;

  const lastClientSeq = safeInteger(authority.lastClientSeq, 'authority.lastClientSeq', -1, 'authorityInvalid');
  if (envelope.clientSeq !== lastClientSeq + 1) {
    fail('clientSeqConflict', { lastClientSeq, suppliedClientSeq: envelope.clientSeq });
  }

    const target = resolveTarget(envelope, document, authority);
    if (envelope.targetType === 'review' && envelope.field === 'body'
      && String(target.createdBy || '') !== principal.actorId) {
      fail('permissionDenied', {
        requiredCapability: policy.capability,
        role: principal.role,
        reason: 'review_body_author_only',
      });
    }
    const loaded = assertBinding(envelope, target, policy, currentRevision, authority);
  const { binding, state, document: yDocument } = loaded;
  try {
    try {
      Y.applyUpdate(yDocument, update);
    } catch (_) {
      fail('updateInvalid', { reason: 'yjs_decode_failed' });
    }
    const yText = assertPlainYText(yDocument, 'updateInvalid');
    const text = yText.toString();
    const textBytes = assertMaterializedText(text, policy);
    const nextStateBuffer = Buffer.from(Y.encodeStateAsUpdate(yDocument));
    if (nextStateBuffer.length > MAX_TEXT_STATE_BYTES) fail('materializedTooLarge', { reason: 'state_too_large' });
    const verification = new Y.Doc();
    try {
      Y.applyUpdate(verification, nextStateBuffer);
      if (assertPlainYText(verification, 'stateInvalid').toString() !== text) fail('stateInvalid', { reason: 'roundtrip_mismatch' });
    } finally {
      verification.destroy();
    }

    const nextState = nextStateBuffer.toString('base64');
    const stateVector = Buffer.from(Y.encodeStateVector(yDocument)).toString('base64');
    const previousStateDigest = sha256(state);
    const stateDigest = sha256(nextStateBuffer);
    const textDigest = sha256(Buffer.from(text, 'utf8'));
    const nextRevision = currentRevision + 1;
    const timestamp = Number.isSafeInteger(authority.now) && authority.now > 0 ? authority.now : Date.now();
    const result = {
      contractVersion: COLLABORATION_TEXT_UPDATE_CONTRACT,
      updateId: envelope.updateId,
      projectId: envelope.projectId,
      canvasId: envelope.canvasId,
      baseRevision: envelope.baseRevision,
      revision: nextRevision,
      targetType: envelope.targetType,
      targetEntityUid: envelope.targetEntityUid,
      bindingEpoch: envelope.bindingEpoch,
      field: envelope.field,
      state: nextState,
      stateVector,
      text,
      textDigest,
      updatedBy: principal.actorId,
    };
    const operation = {
      opId: envelope.updateId,
      projectId: envelope.projectId,
      canvasId: envelope.canvasId,
      baseRevision: envelope.baseRevision,
      revision: nextRevision,
      actorId: principal.actorId,
      sessionId: principal.sessionId,
      clientSeq: envelope.clientSeq,
      type: 'text.update',
      payload: {
        contractVersion: COLLABORATION_TEXT_UPDATE_CONTRACT,
        targetType: envelope.targetType,
        targetEntityUid: envelope.targetEntityUid,
        bindingEpoch: envelope.bindingEpoch,
        field: envelope.field,
        update: envelope.update,
        updateDigest,
        stateVector,
        textDigest,
      },
      createdAt: timestamp,
    };
    const audit = {
      projectId: envelope.projectId,
      canvasId: envelope.canvasId,
      actorId: principal.actorId,
      sessionId: principal.sessionId,
      action: 'collaboration.text.update',
      targetType: envelope.targetType,
      targetId: envelope.targetEntityUid,
      metadata: {
        updateId: envelope.updateId,
        field: envelope.field,
        bindingEpoch: envelope.bindingEpoch,
        baseRevision: envelope.baseRevision,
        revision: nextRevision,
        updateBytes: update.length,
        stateBytes: nextStateBuffer.length,
        textBytes,
        updateDigest,
        stateDigest,
        textDigest,
      },
      createdAt: timestamp,
    };
    const idempotencyRecord = {
      updateId: envelope.updateId,
      requestDigest,
      projectId: envelope.projectId,
      canvasId: envelope.canvasId,
      actorId: principal.actorId,
      sessionId: principal.sessionId,
      clientSeq: envelope.clientSeq,
      revision: nextRevision,
      result,
      createdAt: timestamp,
    };
    const bindingRecord = {
      contractVersion: COLLABORATION_TEXT_BINDING_CONTRACT,
      projectId: envelope.projectId,
      canvasId: envelope.canvasId,
      targetType: envelope.targetType,
      targetEntityUid: envelope.targetEntityUid,
      bindingEpoch: envelope.bindingEpoch,
      field: envelope.field,
      lifecycle: 'active',
      createdRevision: loaded.createdRevision,
      revision: nextRevision,
      state: nextState,
      stateVector,
      stateDigest,
      materializedText: text,
      textDigest,
      updatedBy: principal.actorId,
      updatedAt: timestamp,
    };
    return {
      contractVersion: COLLABORATION_TEXT_UPDATE_CONTRACT,
      type: 'text.update',
      updateId: envelope.updateId,
      requestDigest,
      updateDigest,
      duplicate: false,
      atomic: true,
      scope: { projectId: envelope.projectId, canvasId: envelope.canvasId, baseRevision: envelope.baseRevision },
      preconditions: [
        { kind: 'canvas.schema.equals', schema: CANVAS_DOCUMENT_CONTRACT, schemaVersion: CANVAS_DOCUMENT_VERSION },
        { kind: 'canvas.revision.equals', revision: currentRevision },
        { kind: 'text.target.active', targetType: envelope.targetType, targetEntityUid: envelope.targetEntityUid },
        {
          kind: 'text.binding.equals',
          targetType: envelope.targetType,
          targetEntityUid: envelope.targetEntityUid,
          field: envelope.field,
          bindingEpoch: envelope.bindingEpoch,
          stateDigest: previousStateDigest,
          revision: loaded.bindingRevision,
        },
        { kind: 'text.update-id.absent', updateId: envelope.updateId },
        { kind: 'collaboration.client-seq.equals', actorId: principal.actorId, sessionId: principal.sessionId, value: lastClientSeq },
      ],
      writes: [
        { kind: 'collaboration.text.document.upsert', record: bindingRecord },
        {
          kind: 'canvas.materialized-text.update',
          targetType: envelope.targetType,
          targetEntityUid: envelope.targetEntityUid,
          field: envelope.field,
          path: [...policy.path],
          value: text,
          bindingEpoch: envelope.bindingEpoch,
        },
        { kind: 'canvas.document.revision.cas', expectedRevision: currentRevision, revision: nextRevision },
        { kind: 'canvas.operation.insert', record: operation },
        { kind: 'collaboration.text.idempotency.insert', record: idempotencyRecord },
        {
          kind: 'collaboration.client-sequence.cas',
          actorId: principal.actorId,
          sessionId: principal.sessionId,
          expectedClientSeq: lastClientSeq,
          clientSeq: envelope.clientSeq,
        },
        { kind: 'audit.event.insert', record: audit },
      ],
      operation,
      audit,
      bindingRecord,
      idempotencyRecord,
      result,
    };
  } finally {
    yDocument.destroy();
  }
}

function digestCollaborationTextEnvelope(rawEnvelope) {
  return normalizeEnvelope(rawEnvelope).requestDigest;
}

module.exports = {
  CANVAS_DOCUMENT_CONTRACT,
  CANVAS_DOCUMENT_VERSION,
  COLLABORATION_TEXT_BINDING_CONTRACT,
  COLLABORATION_TEXT_UPDATE_CONTRACT,
  MAX_TEXT_ENVELOPE_BYTES,
  MAX_TEXT_STATE_BYTES,
  MAX_TEXT_UPDATE_BYTES,
  TEXT_FIELD_POLICIES,
  CollaborationTextAuthorityError,
  authorizeCollaborationTextUpdate,
  digestCollaborationTextEnvelope,
};
