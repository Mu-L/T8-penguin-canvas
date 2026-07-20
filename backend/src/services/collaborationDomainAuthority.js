const crypto = require('crypto');
const {
  COMMON_OPERATION_BATCH_CONTRACT,
  isCommonOperationUuid,
  normalizeCommonOperationBatch,
} = require('../collaboration/commonOperationProtocol');
const {
  canTransitionReviewLifecycle,
  decodeReviewThreadStorageStatus,
  isReviewDecisionStatus,
  isReviewLifecycleStatus,
  isReviewResolutionStatus,
  reviewCompatibilityStatus,
  reviewLifecycleTransitionCapability,
} = require('../collaboration/reviewLifecycle');

const MAX_OPERATION_BYTES = 64 * 1024;
const MAX_COMMENT_LENGTH = 5_000;
const MAX_REVIEW_MENTIONS = 20;
const MAX_REVIEW_ATTACHMENTS = 20;
const MAX_CANVAS_COORDINATE = 10_000_000;
const MAX_VIDEO_FRAME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_MAPPING_ITEMS = 500;
const MAX_COLLECTION_ITEMS = 10_000;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,79}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,79}$/i;

const REVIEW_STATUSES = new Set([
  'open',
  'resolved',
  'changes_requested',
  'approved',
]);
const REVIEW_SEVERITIES = new Set(['low', 'normal', 'high', 'blocking']);
const HOST_ARTIFACT_KINDS = new Set(['image', 'video', 'audio', 'model3d', 'text', 'other']);
const DOMAIN_OPERATION_TYPES = new Set([
  'review.thread.create',
  'review.thread.update',
  'review.comment.add',
  'subflow.instance.upgrade',
  'host.artifact.commit',
]);

const ENVELOPE_KEYS = new Set(['opId', 'type', 'payload']);

const ERROR_DEFINITIONS = Object.freeze({
  unsafeValue: ['collaboration_domain_unsafe_value', 400, '领域操作包含不安全或过深的数据'],
  operationTooLarge: ['collaboration_domain_operation_too_large', 413, '领域操作超过 64 KiB 上限'],
  operationInvalid: ['collaboration_domain_operation_invalid', 400, '领域操作信封无效'],
  operationUnsupported: ['collaboration_domain_operation_unsupported', 400, '不支持的领域操作'],
  scopeMismatch: ['collaboration_domain_scope_mismatch', 409, '领域操作与权威 project/canvas 作用域不一致'],
  revisionMismatch: ['collaboration_domain_revision_mismatch', 409, '领域操作 baseRevision 与权威版本不一致'],
  capabilityMissing: ['collaboration_domain_capability_missing', 403, '已认证成员缺少领域操作能力'],
  targetMissing: ['collaboration_domain_target_missing', 404, '领域操作目标不存在'],
  targetDeleted: ['collaboration_domain_target_deleted', 409, '领域操作目标已删除'],
  targetAmbiguous: ['collaboration_domain_target_ambiguous', 409, '领域操作目标身份不唯一'],
  reviewInvalid: ['collaboration_domain_review_invalid', 422, '评论或审片操作无效'],
  reviewTransitionInvalid: ['collaboration_domain_review_transition_invalid', 409, '评审生命周期转换无效'],
  reviewCasConflict: ['collaboration_domain_review_cas_conflict', 409, '评论线程 CAS 版本冲突'],
  subflowInvalid: ['collaboration_domain_subflow_invalid', 422, '子工作流升级操作无效'],
  artifactInvalid: ['collaboration_domain_artifact_invalid', 422, '权威产物提交无效'],
});

class CollaborationDomainAuthorityError extends Error {
  constructor(definition, details = null) {
    super(definition[2]);
    this.name = 'CollaborationDomainAuthorityError';
    this.code = definition[0];
    this.status = definition[1];
    if (details != null) this.details = details;
  }
}

function fail(key, details = null) {
  throw new CollaborationDomainAuthorityError(ERROR_DEFINITIONS[key], details);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertPlainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) {
    fail('unsafeValue', { label });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype) fail('unsafeValue', { label });
  return value;
}

function assertAllowedKeys(value, allowed, label) {
  assertPlainRecord(value, label);
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key) || !allowed.has(key)) fail('unsafeValue', { label, key });
  }
}

function assertExactKeys(value, expected, label, errorKey = 'operationInvalid') {
  assertAllowedKeys(value, expected, label);
  for (const key of expected) {
    if (!hasOwn(value, key)) fail(errorKey, { label, key, reason: 'missing' });
  }
}

function assertAllowedRequiredKeys(value, allowed, required, label, errorKey = 'operationInvalid') {
  assertAllowedKeys(value, allowed, label);
  for (const key of required) {
    if (!hasOwn(value, key)) fail(errorKey, { label, key, reason: 'missing' });
  }
}

function assertSafeJson(value, options = {}) {
  const maxDepth = Number(options.maxDepth) || 16;
  const maxNodes = Number(options.maxNodes) || 10_000;
  const seen = new Set();
  let nodes = 0;
  const visit = (item, depth, label) => {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) fail('unsafeValue', { label });
    if (item === null || typeof item === 'boolean') return;
    if (item === undefined) fail('unsafeValue', { label });
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('unsafeValue', { label });
      return;
    }
    if (typeof item === 'string') {
      if (item.length > 32_000 || /[\u0000]/.test(item)) fail('unsafeValue', { label });
      return;
    }
    if (typeof item !== 'object' || Buffer.isBuffer(item)) fail('unsafeValue', { label });
    if (seen.has(item)) fail('unsafeValue', { label });
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > MAX_COLLECTION_ITEMS) fail('unsafeValue', { label });
      if (Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertySymbols(item).length > 0) {
        fail('unsafeValue', { label });
      }
      const descriptors = Object.getOwnPropertyDescriptors(item);
      for (const key of Object.keys(descriptors)) {
        if (key === 'length') continue;
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= item.length) {
          fail('unsafeValue', { label, key });
        }
      }
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, 'value')
          || descriptor.get || descriptor.set) fail('unsafeValue', { label: `${label}[${index}]` });
        visit(descriptor.value, depth + 1, `${label}[${index}]`);
      }
    } else {
      assertPlainRecord(item, label);
      if (Object.getOwnPropertySymbols(item).length > 0) fail('unsafeValue', { label });
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Object.keys(descriptors);
      if (keys.length > MAX_COLLECTION_ITEMS) fail('unsafeValue', { label });
      for (const key of keys) {
        if (UNSAFE_KEYS.has(key)) fail('unsafeValue', { label, key });
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
          fail('unsafeValue', { label, key });
        }
        visit(descriptor.value, depth + 1, `${label}.${key}`);
      }
    }
    seen.delete(item);
  };
  visit(value, 0, options.label || 'value');
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (_) {
    fail('unsafeValue', { label: options.label || 'value' });
  }
  if (Buffer.byteLength(serialized, 'utf8') > (Number(options.maxBytes) || MAX_OPERATION_BYTES)) {
    fail('operationTooLarge');
  }
  return value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digestSubflowUpgradePlan(rawPlan) {
  const plan = assertPlainRecord(rawPlan, 'subflowUpgradePlan');
  assertSafeJson(plan, { label: 'subflowUpgradePlan', maxBytes: MAX_OPERATION_BYTES });
  const allowed = new Set([
    'upgradePlanDigest', 'digest', 'instanceUid', 'definitionUid', 'expectedCanvasRevision',
    'expectedInstanceRevision', 'expectedDefinitionVersion', 'expectedDefinitionRevision',
    'targetDefinitionVersion', 'targetDefinitionRevision', 'portMappings', 'parameterMappings',
  ]);
  assertAllowedKeys(plan, allowed, 'subflowUpgradePlan');
  if (hasOwn(plan, 'upgradePlanDigest') && hasOwn(plan, 'digest')
    && String(plan.upgradePlanDigest).toLowerCase() !== String(plan.digest).toLowerCase()) {
    fail('subflowInvalid', { label: 'upgradePlan.declaredDigest' });
  }
  const canonical = Object.fromEntries(Object.entries(plan)
    .filter(([key]) => key !== 'upgradePlanDigest' && key !== 'digest'));
  assertSafeJson(canonical, { label: 'subflowUpgradePlan', maxBytes: MAX_OPERATION_BYTES });
  return crypto.createHash('sha256').update(stableJson(canonical), 'utf8').digest('hex');
}

function requiredUuid(value, label, errorKey = 'operationInvalid') {
  if (!isCommonOperationUuid(value)) fail(errorKey, { label });
  return String(value).toLowerCase();
}

function boundedIdentity(value, label, errorKey = 'operationInvalid') {
  if (typeof value !== 'string' || !value || value.length > 240
    || /[\u0000-\u001f\u007f]/.test(value) || UNSAFE_KEYS.has(value)) {
    fail(errorKey, { label });
  }
  return value;
}

function boundedScopeIdentity(value, label) {
  const identity = boundedIdentity(value, label);
  if (identity.trim() !== identity) fail('operationInvalid', { label });
  return identity;
}

function requiredPositiveInteger(value, label, errorKey = 'operationInvalid') {
  if (!Number.isSafeInteger(value) || value < 1) fail(errorKey, { label });
  return value;
}

function finiteNumber(value, label, minimum, maximum, errorKey) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(errorKey, { label });
  }
  return Object.is(value, -0) ? 0 : value;
}

function normalizedEntityUid(value) {
  return isCommonOperationUuid(value) ? String(value).toLowerCase() : null;
}

function entityUidOf(value) {
  return normalizedEntityUid(value?.entityUid) || normalizedEntityUid(value?.id);
}

function safeArray(value, label, maximum = MAX_COLLECTION_ITEMS, errorKey = 'operationInvalid') {
  if (!Array.isArray(value) || value.length > maximum) fail(errorKey, { label });
  return value;
}

function normalizeOperationEnvelope(rawOperation, expectedType, authority) {
  assertSafeJson(rawOperation, { label: 'operation', maxBytes: MAX_OPERATION_BYTES });
  assertExactKeys(rawOperation, ENVELOPE_KEYS, 'operation');
  const type = boundedIdentity(rawOperation.type, 'operation.type');
  if (!DOMAIN_OPERATION_TYPES.has(type) || (expectedType && type !== expectedType)) fail('operationUnsupported', { type });
  const batch = assertPlainRecord(authority?.batch, 'authority.batch');
  if (batch.contractVersion !== COMMON_OPERATION_BATCH_CONTRACT) fail('operationInvalid', { label: 'authority.batch.contractVersion' });
  requiredUuid(batch.batchId, 'authority.batch.batchId');
  requiredUuid(batch.clientId, 'authority.batch.clientId');
  if (!Number.isSafeInteger(batch.clientSeq) || batch.clientSeq < 0) {
    fail('operationInvalid', { label: 'authority.batch.clientSeq' });
  }
  return {
    opId: requiredUuid(rawOperation.opId, 'operation.opId'),
    // The frozen common envelope intentionally preserves legacy project/canvas
    // lookup IDs while every operation-level entity identity is UUID-only.
    projectId: boundedScopeIdentity(batch.projectId, 'authority.batch.projectId'),
    canvasId: boundedScopeIdentity(batch.canvasId, 'authority.batch.canvasId'),
    baseRevision: requiredPositiveInteger(batch.baseRevision, 'authority.batch.baseRevision'),
    type,
    payload: assertPlainRecord(rawOperation.payload, 'operation.payload'),
  };
}

function assertDocumentScope(operation, authority, options = {}) {
  const document = assertPlainRecord(authority?.document, 'authority.document');
  if (String(document.projectId || '') !== operation.projectId || String(document.canvasId || '') !== operation.canvasId) {
    fail('scopeMismatch');
  }
  const revision = requiredPositiveInteger(document.revision, 'authority.document.revision');
  if (options.exactRevision !== false && revision !== operation.baseRevision) fail('revisionMismatch', { currentRevision: revision });
  return document;
}

function trustedPrincipal(authority, key = 'principal') {
  const principal = assertPlainRecord(authority?.[key], `authority.${key}`);
  const actorId = boundedIdentity(principal.memberId || principal.actorId, `authority.${key}.actorId`);
  const sessionId = boundedIdentity(principal.sessionId, `authority.${key}.sessionId`);
  if (!Array.isArray(principal.capabilities)) fail('capabilityMissing');
  return { actorId, sessionId, capabilities: new Set(principal.capabilities.map(String)) };
}

function requireCapability(principal, capability) {
  if (!principal.capabilities.has(capability)) fail('capabilityMissing', { capability });
}

function findUniqueByEntityUid(items, entityUid, options = {}) {
  const matches = (Array.isArray(items) ? items : []).filter((item) => entityUidOf(item) === entityUid);
  if (matches.length > 1) fail('targetAmbiguous', { kind: options.kind });
  return matches[0] || null;
}

function tombstoneHasUid(records, entityUid) {
  if (!records || typeof records !== 'object' || Array.isArray(records)) return false;
  return Object.values(records).some((record) => normalizedEntityUid(record?.entityUid) === entityUid);
}

function assertActiveLifecycle(value, kind) {
  const lifecycle = String(value?.lifecycle || value?.state || '').toLowerCase();
  const status = String(value?.status || '').toLowerCase();
  if (value?.deletedAt != null || value?.tombstone === true
    || ['deleted', 'tombstoned', 'purged'].includes(lifecycle)
    || ['deleted', 'tombstoned', 'purged'].includes(status)) {
    fail('targetDeleted', { kind });
  }
  return value;
}

function allowedAssetUidSet(authority) {
  const source = authority?.allowedAssetEntityUids;
  if (!(source instanceof Set) && !Array.isArray(source)) fail('reviewInvalid', { label: 'allowedAssetEntityUids' });
  const result = new Set();
  for (const value of source) result.add(requiredUuid(value, 'allowedAssetEntityUids', 'reviewInvalid'));
  return result;
}

function resolveScopedReviewAsset(authority, document, targetEntityUid, kind = 'asset') {
  const allowedAssets = allowedAssetUidSet(authority);
  if (!allowedAssets.has(targetEntityUid)) fail('targetMissing', { kind, reason: 'canvas_asset_scope' });
  const asset = findUniqueByEntityUid(authority?.assets, targetEntityUid, { kind: 'asset' });
  if (!asset) fail('targetMissing', { kind: 'asset' });
  if (String(asset.projectId || '') !== String(document.projectId || '')) fail('scopeMismatch');
  assertActiveLifecycle(asset, 'asset');
  if (asset.availability != null && !['available', 'ready'].includes(String(asset.availability))) {
    fail('targetDeleted', { kind: 'asset', reason: 'unavailable' });
  }
  return asset;
}

function authoritativeAssetContentPin(asset) {
  const assetContentRevision = requiredPositiveInteger(
    asset?.contentRevision,
    'asset.contentRevision',
    'reviewInvalid',
  );
  const contentHash = String(asset?.contentHash || '');
  if (!/^[a-f0-9]{64}$/.test(contentHash)) fail('reviewInvalid', { label: 'asset.contentHash' });
  return { assetContentRevision, contentHash };
}

function assertAssetContentPin(rawPin, asset) {
  const requestedRevision = requiredPositiveInteger(
    rawPin.assetContentRevision,
    'assetContentRevision',
    'reviewInvalid',
  );
  if (typeof rawPin.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(rawPin.contentHash)) {
    fail('reviewInvalid', { label: 'contentHash' });
  }
  const current = authoritativeAssetContentPin(asset);
  if (requestedRevision !== current.assetContentRevision || rawPin.contentHash !== current.contentHash) {
    fail('reviewCasConflict', { currentAssetContentRevision: current.assetContentRevision });
  }
  return current;
}

function reviewMemberIdentity(member) {
  return normalizedEntityUid(member?.id)
    || normalizedEntityUid(member?.memberId)
    || normalizedEntityUid(member?.entityUid);
}

function resolveReviewMember(authority, operation, memberId) {
  const matches = (Array.isArray(authority?.reviewMembers) ? authority.reviewMembers : [])
    .filter((member) => reviewMemberIdentity(member) === memberId);
  if (matches.length > 1) fail('targetAmbiguous', { kind: 'review-member' });
  const member = matches[0];
  if (!member) fail('targetMissing', { kind: 'review-member' });
  if (String(member.projectId || '') !== operation.projectId
    || String(member.canvasId || '') !== operation.canvasId) fail('scopeMismatch');
  assertActiveLifecycle(member, 'review-member');
  if (member.revokedAt != null || member.active === false) fail('targetDeleted', { kind: 'review-member' });
  return member;
}

function normalizeReviewReferences(raw, operation, document, authority, threadId, commentId, actorId) {
  const hasMentions = hasOwn(raw, 'mentions');
  const hasAttachments = hasOwn(raw, 'attachments');
  const mentions = [];
  const attachments = [];
  const writes = [];

  if (hasMentions) {
    const supplied = safeArray(raw.mentions, 'mentions', MAX_REVIEW_MENTIONS, 'reviewInvalid');
    const seen = new Set();
    for (const value of supplied) {
      const memberId = requiredUuid(value, 'mentions', 'reviewInvalid');
      if (seen.has(memberId)) continue;
      seen.add(memberId);
      resolveReviewMember(authority, operation, memberId);
      mentions.push(memberId);
      writes.push({ kind: 'review.mention.insert', record: { threadId, commentId, memberId } });
    }
  }

  if (hasAttachments) {
    const supplied = safeArray(raw.attachments, 'attachments', MAX_REVIEW_ATTACHMENTS, 'reviewInvalid');
    const seenAssets = new Set();
    for (const rawAttachment of supplied) {
      assertExactKeys(
        rawAttachment,
        new Set(['assetUid', 'assetContentRevision', 'contentHash']),
        'attachment',
        'reviewInvalid',
      );
      const assetEntityUid = requiredUuid(rawAttachment.assetUid, 'attachment.assetUid', 'reviewInvalid');
      if (seenAssets.has(assetEntityUid)) fail('reviewInvalid', { label: 'attachments', reason: 'duplicate_asset' });
      seenAssets.add(assetEntityUid);
      const asset = resolveScopedReviewAsset(authority, document, assetEntityUid, 'attachment');
      const pin = assertAssetContentPin(rawAttachment, asset);
      const attachment = {
        assetUid: assetEntityUid,
        assetContentRevision: pin.assetContentRevision,
        contentHash: pin.contentHash,
      };
      attachments.push(attachment);
      writes.push({
        kind: 'review.attachment.insert',
        record: {
          threadId,
          commentId,
          assetId: boundedIdentity(String(asset.id || assetEntityUid), 'asset.id', 'reviewInvalid'),
          assetEntityUid,
          assetContentRevision: pin.assetContentRevision,
          contentHash: pin.contentHash,
        },
      });
    }
  }

  return {
    hasMentions,
    hasAttachments,
    mentions,
    attachments,
    notificationRecipients: mentions.filter((memberId) => memberId !== actorId),
    writes,
  };
}

function resolveReviewAnchor(rawAnchor, document, authority) {
  const allowed = {
    canvas: new Set(['kind', 'x', 'y']),
    node: new Set(['kind', 'targetUid']),
    edge: new Set(['kind', 'targetUid']),
    asset: new Set(['kind', 'targetUid']),
    video: new Set([
      'kind', 'targetUid', 'frameMs', 'assetRevision', 'assetContentRevision', 'contentHash',
    ]),
  };
  assertPlainRecord(rawAnchor, 'review.anchor');
  if (typeof rawAnchor.kind !== 'string') fail('reviewInvalid', { label: 'anchor.kind' });
  const kind = rawAnchor.kind;
  if (!allowed[kind]) fail('reviewInvalid', { label: 'anchor.kind' });
  if (kind === 'video') {
    const contentPin = hasOwn(rawAnchor, 'assetContentRevision') || hasOwn(rawAnchor, 'contentHash');
    assertExactKeys(
      rawAnchor,
      contentPin
        ? new Set(['kind', 'targetUid', 'frameMs', 'assetContentRevision', 'contentHash'])
        : new Set(['kind', 'targetUid', 'frameMs', 'assetRevision']),
      'review.anchor',
      'reviewInvalid',
    );
  } else {
    assertExactKeys(rawAnchor, allowed[kind], 'review.anchor', 'reviewInvalid');
  }

  if (kind === 'canvas') {
    const targetEntityUid = requiredUuid(document.entityUid, 'document.entityUid', 'reviewInvalid');
    return {
      kind,
      targetEntityUid,
      x: finiteNumber(rawAnchor.x, 'review.anchor.x', -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE, 'reviewInvalid'),
      y: finiteNumber(rawAnchor.y, 'review.anchor.y', -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE, 'reviewInvalid'),
    };
  }

  const targetEntityUid = requiredUuid(rawAnchor.targetUid, 'review.anchor.targetUid', 'reviewInvalid');

  if (kind === 'node' || kind === 'edge') {
    const tombstones = document.tombstones?.[`${kind}s`];
    if (tombstoneHasUid(tombstones, targetEntityUid)) fail('targetDeleted', { kind });
    const target = findUniqueByEntityUid(document[`${kind}s`], targetEntityUid, { kind });
    if (!target) fail('targetMissing', { kind });
    assertActiveLifecycle(target, kind);
    return { kind, targetEntityUid };
  }

  const asset = resolveScopedReviewAsset(authority, document, targetEntityUid, kind);
  if (kind === 'asset') return { kind, targetEntityUid };
  if (String(asset.kind || '') !== 'video') fail('reviewInvalid', { label: 'video.asset.kind' });
  const durationMs = Number.isFinite(Number(asset.metadata?.durationMs))
    ? Number(asset.metadata.durationMs)
    : Number.isFinite(Number(asset.metadata?.duration)) ? Number(asset.metadata.duration) * 1000 : null;
  if (!(durationMs > 0)) fail('reviewInvalid', { label: 'video.durationMs' });
  if (!Number.isSafeInteger(rawAnchor.frameMs) || rawAnchor.frameMs < 0
    || rawAnchor.frameMs > MAX_VIDEO_FRAME_MS || rawAnchor.frameMs > durationMs) {
    fail('reviewInvalid', { label: 'review.anchor.frameMs' });
  }
  if (hasOwn(rawAnchor, 'assetContentRevision') || hasOwn(rawAnchor, 'contentHash')) {
    const pin = assertAssetContentPin(rawAnchor, asset);
    return { kind, targetEntityUid, frameMs: rawAnchor.frameMs, ...pin };
  }
  // Frozen v1 compatibility only. In particular, never map organizationRevision
  // into this legacy field; old exact retries continue to compare asset.revision.
  const assetRevision = requiredPositiveInteger(rawAnchor.assetRevision, 'review.anchor.assetRevision', 'reviewInvalid');
  const currentAssetRevision = requiredPositiveInteger(asset.revision, 'asset.revision', 'reviewInvalid');
  if (assetRevision !== currentAssetRevision) fail('reviewCasConflict', { currentAssetRevision });
  return { kind, targetEntityUid, frameMs: rawAnchor.frameMs, assetRevision };
}

function normalizeReviewStatus(value) {
  if (typeof value !== 'string') fail('reviewInvalid', { label: 'status' });
  const status = value;
  if (!REVIEW_STATUSES.has(status)) fail('reviewInvalid', { label: 'status' });
  return status;
}

function normalizeReviewResolutionStatus(value) {
  if (!isReviewResolutionStatus(value)) fail('reviewInvalid', { label: 'resolutionStatus' });
  return value;
}

function normalizeReviewLifecycleStatus(value) {
  if (!isReviewLifecycleStatus(value)) fail('reviewInvalid', { label: 'reviewStatus' });
  return value;
}

function reviewThreadState(thread) {
  if (isReviewResolutionStatus(thread?.resolutionStatus) && isReviewLifecycleStatus(thread?.reviewStatus)) {
    return {
      resolutionStatus: thread.resolutionStatus,
      reviewStatus: thread.reviewStatus,
    };
  }
  try {
    return decodeReviewThreadStorageStatus(thread?.status);
  } catch {
    fail('reviewInvalid', { label: 'thread.status' });
  }
}

function normalizeReviewSeverity(value) {
  if (typeof value !== 'string') fail('reviewInvalid', { label: 'severity' });
  const severity = value;
  if (!REVIEW_SEVERITIES.has(severity)) fail('reviewInvalid', { label: 'severity' });
  return severity;
}

function normalizeCommentBody(value) {
  if (typeof value !== 'string') fail('reviewInvalid', { label: 'body' });
  const body = value.trim();
  if (!body || body !== value || body.length > MAX_COMMENT_LENGTH || UNSAFE_KEYS.has(body)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)
    || Buffer.byteLength(body, 'utf8') > 20_000) {
    fail('reviewInvalid', { label: 'body' });
  }
  return body;
}

function allReviewComments(authority) {
  const threads = Array.isArray(authority?.reviewThreads) ? authority.reviewThreads : [];
  const comments = Array.isArray(authority?.reviewComments) ? authority.reviewComments : [];
  return [
    ...comments,
    ...threads.flatMap((thread) => Array.isArray(thread?.comments) ? thread.comments : []),
  ];
}

function reviewIdentityCollision(authority, identity) {
  const threads = Array.isArray(authority?.reviewThreads) ? authority.reviewThreads : [];
  const comments = allReviewComments(authority);
  return [...threads, ...comments].some((item) => (
    normalizedEntityUid(item?.entityUid) === identity
      || normalizedEntityUid(item?.id) === identity
  ));
}

function reviewCommentThreadBinding(authority, comment) {
  const stableBinding = normalizedEntityUid(comment?.threadEntityUid)
    || normalizedEntityUid(comment?.threadUid);
  if (stableBinding) return stableBinding;
  const legacyThreadId = String(comment?.threadId || '');
  if (!legacyThreadId) return '';
  const matches = (Array.isArray(authority?.reviewThreads) ? authority.reviewThreads : [])
    .filter((thread) => String(thread?.id || '') === legacyThreadId);
  if (matches.length > 1) fail('targetAmbiguous', { kind: 'review-thread' });
  if (matches[0]) return entityUidOf(matches[0]) || legacyThreadId;
  return normalizedEntityUid(comment?.threadId) || legacyThreadId;
}

function resolveReviewComment(authority, commentId) {
  const matches = allReviewComments(authority).filter((item) => entityUidOf(item) === commentId);
  if (matches.length === 0) return null;
  const threadBindings = new Set(matches.map((comment) => reviewCommentThreadBinding(authority, comment)));
  if (threadBindings.size > 1) fail('targetAmbiguous', { kind: 'review-comment' });
  for (const match of matches) assertActiveLifecycle(match, 'review-comment');
  return matches[0];
}

function authorizeReviewThreadCreate(rawOperation, authority) {
  const operation = normalizeOperationEnvelope(rawOperation, 'review.thread.create', authority);
  const document = assertDocumentScope(operation, authority);
  const principal = trustedPrincipal(authority);
  requireCapability(principal, 'comment');
  const allowed = new Set(['threadUid', 'expectedCanvasRevision', 'anchor', 'severity', 'initialComment', 'reviewStatus']);
  assertAllowedRequiredKeys(
    operation.payload,
    allowed,
    new Set(['threadUid', 'expectedCanvasRevision', 'anchor', 'severity', 'initialComment']),
    'review.thread.create.payload',
    'reviewInvalid',
  );
  if (operation.payload.expectedCanvasRevision !== operation.baseRevision) fail('revisionMismatch');
  const initialComment = assertPlainRecord(operation.payload.initialComment, 'review.thread.create.initialComment');
  assertAllowedRequiredKeys(
    initialComment,
    new Set(['commentUid', 'body', 'mentions', 'attachments']),
    new Set(['commentUid', 'body']),
    'review.thread.create.initialComment',
    'reviewInvalid',
  );
  const threadId = requiredUuid(operation.payload.threadUid, 'threadUid', 'reviewInvalid');
  const commentId = requiredUuid(initialComment.commentUid, 'initialComment.commentUid', 'reviewInvalid');
  if (threadId === commentId || reviewIdentityCollision(authority, threadId) || reviewIdentityCollision(authority, commentId)) {
    fail('reviewCasConflict', { reason: 'identity_collision' });
  }
  const anchor = resolveReviewAnchor(operation.payload.anchor, document, authority);
  const severity = normalizeReviewSeverity(operation.payload.severity);
  const body = normalizeCommentBody(initialComment.body);
  // Pre-lifecycle common-operation clients created a thread that was immediately
  // reviewable. Preserve that semantic as `in_review`; new clients opt into the
  // explicit draft state by sending reviewStatus=draft.
  const reviewStatus = hasOwn(operation.payload, 'reviewStatus')
    ? normalizeReviewLifecycleStatus(operation.payload.reviewStatus)
    : 'in_review';
  if (reviewStatus !== 'draft' && reviewStatus !== 'in_review') fail('reviewInvalid', { label: 'reviewStatus' });
  const thread = {
    id: threadId,
    entityUid: threadId,
    projectId: operation.projectId,
    canvasId: operation.canvasId,
    canvasRevision: operation.baseRevision,
    revision: 1,
    anchor,
    resolutionStatus: 'open',
    reviewStatus,
    status: 'open',
    severity,
    createdBy: principal.actorId,
  };
  const comment = {
    id: commentId,
    entityUid: commentId,
    threadId,
    parentId: null,
    body,
    createdBy: principal.actorId,
  };
  const references = normalizeReviewReferences(
    initialComment,
    operation,
    document,
    authority,
    threadId,
    commentId,
    principal.actorId,
  );
  const resultComment = { ...comment };
  if (references.hasMentions) resultComment.mentions = references.mentions;
  if (references.hasAttachments) resultComment.attachments = references.attachments;
  const plan = {
    type: operation.type,
    opId: operation.opId,
    scope: { projectId: operation.projectId, canvasId: operation.canvasId, baseRevision: operation.baseRevision },
    atomic: true,
    preconditions: [{ kind: 'canvas.revision.equals', revision: operation.baseRevision }],
    writes: [
      { kind: 'review.thread.insert', record: thread },
      { kind: 'review.comment.insert', record: comment },
      ...references.writes,
    ],
    result: { thread: { ...thread, comments: [resultComment] } },
    audit: {
      actorId: principal.actorId,
      sessionId: principal.sessionId,
      action: 'review.thread.create',
      targetType: 'review-thread',
      targetId: threadId,
    },
  };
  if (references.hasMentions) plan.notificationRecipients = references.notificationRecipients;
  return plan;
}

function resolveReviewThread(authority, threadId, operation) {
  const thread = findUniqueByEntityUid(authority?.reviewThreads, threadId, { kind: 'review-thread' });
  if (!thread) fail('targetMissing', { kind: 'review-thread' });
  assertActiveLifecycle(thread, 'review-thread');
  if (String(thread.projectId || '') !== operation.projectId || String(thread.canvasId || '') !== operation.canvasId) {
    fail('scopeMismatch');
  }
  return thread;
}

function authorizeReviewThreadUpdate(rawOperation, authority) {
  const operation = normalizeOperationEnvelope(rawOperation, 'review.thread.update', authority);
  assertDocumentScope(operation, authority);
  const principal = trustedPrincipal(authority);
  const allowed = new Set([
    'threadUid', 'expectedCanvasRevision', 'expectedThreadRevision', 'status', 'resolutionStatus', 'reviewStatus',
    'severity', 'decisionCanvasRevision',
  ]);
  assertAllowedRequiredKeys(
    operation.payload,
    allowed,
    new Set(['threadUid', 'expectedCanvasRevision', 'expectedThreadRevision', 'severity']),
    'review.thread.update.payload',
    'reviewInvalid',
  );
  if (operation.payload.expectedCanvasRevision !== operation.baseRevision) fail('revisionMismatch');
  const threadId = requiredUuid(operation.payload.threadUid, 'threadUid', 'reviewInvalid');
  const thread = resolveReviewThread(authority, threadId, operation);
  const expectedThreadRevision = requiredPositiveInteger(
    operation.payload.expectedThreadRevision,
    'expectedThreadRevision',
    'reviewInvalid',
  );
  const currentRevision = requiredPositiveInteger(thread.revision, 'thread.revision', 'reviewInvalid');
  if (currentRevision !== expectedThreadRevision) fail('reviewCasConflict', { currentRevision });
  const currentState = reviewThreadState(thread);
  const legacyStatus = hasOwn(operation.payload, 'status')
    ? normalizeReviewStatus(operation.payload.status)
    : null;
  const hasResolutionUpdate = hasOwn(operation.payload, 'resolutionStatus');
  const hasLifecycleUpdate = hasOwn(operation.payload, 'reviewStatus');
  if (!legacyStatus && hasResolutionUpdate === hasLifecycleUpdate) {
    fail('reviewInvalid', { label: 'review-state-dimension' });
  }
  let resolutionStatus = currentState.resolutionStatus;
  let reviewStatus = currentState.reviewStatus;
  if (legacyStatus) {
    if (isReviewResolutionStatus(legacyStatus)) resolutionStatus = legacyStatus;
    else reviewStatus = legacyStatus;
  } else if (hasResolutionUpdate) {
    resolutionStatus = normalizeReviewResolutionStatus(operation.payload.resolutionStatus);
  } else {
    reviewStatus = normalizeReviewLifecycleStatus(operation.payload.reviewStatus);
  }
  const updatesLifecycle = hasLifecycleUpdate
    || (legacyStatus != null && isReviewDecisionStatus(legacyStatus));
  if (updatesLifecycle
    && !canTransitionReviewLifecycle(currentState.reviewStatus, reviewStatus)) {
    fail('reviewTransitionInvalid', { from: currentState.reviewStatus, to: reviewStatus });
  }
  const transitionCapability = updatesLifecycle
    ? reviewLifecycleTransitionCapability(currentState.reviewStatus, reviewStatus)
    : null;
  requireCapability(principal, transitionCapability || 'comment');
  const severity = normalizeReviewSeverity(operation.payload.severity);
  let decisionCanvasRevision = thread.decisionCanvasRevision == null ? null : Number(thread.decisionCanvasRevision);
  if (updatesLifecycle && isReviewDecisionStatus(reviewStatus)) {
    decisionCanvasRevision = operation.payload.decisionCanvasRevision;
    if (decisionCanvasRevision !== operation.baseRevision) fail('revisionMismatch');
  } else if (updatesLifecycle) {
    if (operation.payload.decisionCanvasRevision != null) fail('reviewInvalid', { label: 'decisionCanvasRevision' });
    decisionCanvasRevision = null;
  } else if (hasOwn(operation.payload, 'decisionCanvasRevision')
    && operation.payload.decisionCanvasRevision != null) {
    fail('reviewInvalid', { label: 'decisionCanvasRevision' });
  }
  const next = {
    resolutionStatus,
    reviewStatus,
    status: reviewCompatibilityStatus(resolutionStatus, reviewStatus),
    severity,
    decisionCanvasRevision: decisionCanvasRevision == null ? null : decisionCanvasRevision,
    revision: currentRevision + 1,
  };
  return {
    type: operation.type,
    opId: operation.opId,
    scope: { projectId: operation.projectId, canvasId: operation.canvasId, baseRevision: operation.baseRevision },
    atomic: true,
    preconditions: [
      { kind: 'canvas.revision.equals', revision: operation.baseRevision },
      { kind: 'review.thread.revision.equals', threadId, revision: expectedThreadRevision },
    ],
    writes: [{ kind: 'review.thread.update', threadId, expectedRevision: expectedThreadRevision, patch: next }],
    result: { thread: { ...cloneJson(thread), ...next } },
    ...(thread.createdBy && String(thread.createdBy) !== String(principal.actorId)
      ? { notificationRecipients: [String(thread.createdBy)] }
      : {}),
    audit: {
      actorId: principal.actorId,
      sessionId: principal.sessionId,
      action: 'review.thread.update',
      targetType: 'review-thread',
      targetId: threadId,
      metadata: {
        previousResolutionStatus: currentState.resolutionStatus,
        resolutionStatus,
        previousReviewStatus: currentState.reviewStatus,
        reviewStatus,
      },
    },
  };
}

function authorizeReviewCommentAdd(rawOperation, authority) {
  const operation = normalizeOperationEnvelope(rawOperation, 'review.comment.add', authority);
  const document = assertDocumentScope(operation, authority);
  const principal = trustedPrincipal(authority);
  requireCapability(principal, 'comment');
  const allowed = new Set([
    'threadUid', 'commentUid', 'parentCommentUid', 'expectedCanvasRevision', 'expectedThreadRevision',
    'body', 'mentions', 'attachments',
  ]);
  assertAllowedRequiredKeys(
    operation.payload,
    allowed,
    new Set(['threadUid', 'commentUid', 'parentCommentUid', 'expectedCanvasRevision', 'expectedThreadRevision', 'body']),
    'review.comment.add.payload',
    'reviewInvalid',
  );
  if (operation.payload.expectedCanvasRevision !== operation.baseRevision) fail('revisionMismatch');
  const threadId = requiredUuid(operation.payload.threadUid, 'threadUid', 'reviewInvalid');
  const commentId = requiredUuid(operation.payload.commentUid, 'commentUid', 'reviewInvalid');
  const thread = resolveReviewThread(authority, threadId, operation);
  const expectedThreadRevision = requiredPositiveInteger(operation.payload.expectedThreadRevision, 'expectedThreadRevision', 'reviewInvalid');
  const currentRevision = requiredPositiveInteger(thread.revision, 'thread.revision', 'reviewInvalid');
  if (expectedThreadRevision !== currentRevision) fail('reviewCasConflict', { currentRevision });
  if (reviewIdentityCollision(authority, commentId)) fail('reviewCasConflict', { reason: 'identity_collision' });
  let parentId = null;
  let parentEntityUid = null;
  if (operation.payload.parentCommentUid != null) {
    parentEntityUid = requiredUuid(operation.payload.parentCommentUid, 'parentCommentUid', 'reviewInvalid');
    const parent = resolveReviewComment(authority, parentEntityUid);
    const sameThread = parent && reviewCommentThreadBinding(authority, parent) === threadId;
    if (!parent || !sameThread) {
      fail('targetMissing', { kind: 'review-comment' });
    }
    parentId = String(parent.id || parentEntityUid);
  }
  const comment = {
    id: commentId,
    entityUid: commentId,
    threadId: String(thread.id || threadId),
    parentId,
    parentEntityUid,
    body: normalizeCommentBody(operation.payload.body),
    createdBy: principal.actorId,
  };
  const references = normalizeReviewReferences(
    operation.payload,
    operation,
    document,
    authority,
    threadId,
    commentId,
    principal.actorId,
  );
  const resultComment = { ...comment };
  if (references.hasMentions) resultComment.mentions = references.mentions;
  if (references.hasAttachments) resultComment.attachments = references.attachments;
  const plan = {
    type: operation.type,
    opId: operation.opId,
    scope: { projectId: operation.projectId, canvasId: operation.canvasId, baseRevision: operation.baseRevision },
    atomic: true,
    preconditions: [
      { kind: 'canvas.revision.equals', revision: operation.baseRevision },
      { kind: 'review.thread.revision.equals', threadId, revision: expectedThreadRevision },
    ],
    writes: [
      { kind: 'review.comment.insert', record: comment },
      { kind: 'review.thread.update', threadId, expectedRevision: expectedThreadRevision, patch: { revision: currentRevision + 1 } },
      ...references.writes,
    ],
    result: { comment: resultComment, threadRevision: currentRevision + 1 },
    audit: {
      actorId: principal.actorId,
      sessionId: principal.sessionId,
      action: 'review.comment.add',
      targetType: 'review-comment',
      targetId: commentId,
    },
  };
  if (references.hasMentions) plan.notificationRecipients = references.notificationRecipients;
  return plan;
}

function definitionEntityUid(definition) {
  return normalizedEntityUid(definition?.entityUid) || normalizedEntityUid(definition?.id);
}

function definitionVersion(definition) {
  const version = Number(definition?.version);
  return Number.isSafeInteger(version) && version >= 1 ? version : null;
}

function indexStableContractItems(items, label, errorKey = 'subflowInvalid') {
  const byUid = new Map();
  const byHandle = new Map();
  for (const item of safeArray(items, label, MAX_MAPPING_ITEMS, errorKey)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(errorKey, { label });
    const uid = normalizedEntityUid(item.entityUid) || normalizedEntityUid(item.id);
    if (!uid || byUid.has(uid)) fail(errorKey, { label, reason: 'stable_uid' });
    const handle = boundedIdentity(String(item.id || ''), `${label}.id`, errorKey);
    if (byHandle.has(handle) && byHandle.get(handle) !== item) fail(errorKey, { label, reason: 'duplicate_id' });
    byUid.set(uid, item);
    byHandle.set(handle, item);
    byHandle.set(uid, item);
  }
  return { byUid, byHandle };
}

function subflowPortContracts(definition) {
  return {
    input: indexStableContractItems(definition.inputs, 'definition.inputs'),
    output: indexStableContractItems(definition.outputs, 'definition.outputs'),
    parameter: indexStableContractItems(definition.exposedParameters || [], 'definition.exposedParameters'),
  };
}

function resolveSubflowDefinition(authority, entityUid, version, projectId, revision = null) {
  const matches = (Array.isArray(authority?.subflowDefinitions) ? authority.subflowDefinitions : []).filter((definition) => (
    definitionEntityUid(definition) === entityUid
      && definitionVersion(definition) === version
      && (revision == null || Number(definition.revision) === revision)
  ));
  if (matches.length > 1) fail('targetAmbiguous', { kind: 'subflow-definition' });
  const definition = matches[0] || null;
  if (!definition) fail('targetMissing', { kind: 'subflow-definition', version });
  assertActiveLifecycle(definition, 'subflow-definition');
  if (String(definition.projectId || '') !== projectId) fail('scopeMismatch');
  return definition;
}

function resolveSubflowInstance(document, instanceEntityUid) {
  if (tombstoneHasUid(document.tombstones?.nodes, instanceEntityUid)) fail('targetDeleted', { kind: 'subflow-instance' });
  const node = findUniqueByEntityUid(document.nodes, instanceEntityUid, { kind: 'subflow-instance' });
  if (!node) fail('targetMissing', { kind: 'subflow-instance' });
  assertActiveLifecycle(node, 'subflow-instance');
  if (String(node.type || '') !== 'subflow') fail('subflowInvalid', { label: 'instance.type' });
  return node;
}

function compatiblePortKinds(fromPort, toPort) {
  const fromKind = String(fromPort?.kind || 'any');
  const toKind = String(toPort?.kind || 'any');
  return fromKind === 'any' || toKind === 'any' || fromKind === toKind;
}

function valueMatchesSchema(value, schema) {
  if (!schema || typeof schema !== 'object') return true;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) return false;
  if (schema.type) {
    const matches = schema.type === 'null' ? value === null
      : schema.type === 'array' ? Array.isArray(value)
        : schema.type === 'integer' ? Number.isInteger(value)
          : schema.type === 'object' ? Boolean(value) && typeof value === 'object' && !Array.isArray(value)
            : typeof value === schema.type;
    if (!matches) return false;
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) return false;
    if (schema.maximum != null && value > schema.maximum) return false;
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) return false;
    if (schema.maxLength != null && value.length > schema.maxLength) return false;
    if (schema.pattern != null) {
      try {
        if (!new RegExp(String(schema.pattern)).test(value)) return false;
      } catch (_) {
        return false;
      }
    }
  }
  return true;
}

function normalizePortMappings(rawMappings, fromContracts, toContracts) {
  const mappings = safeArray(rawMappings, 'portMappings', MAX_MAPPING_ITEMS, 'subflowInvalid');
  const result = new Map();
  const targetUse = new Set();
  for (const raw of mappings) {
    const allowed = new Set(['direction', 'fromPortEntityUid', 'toPortEntityUid']);
    assertExactKeys(raw, allowed, 'portMapping', 'subflowInvalid');
    const direction = String(raw.direction || '');
    if (direction !== 'input' && direction !== 'output') fail('subflowInvalid', { label: 'portMapping.direction' });
    const fromPortEntityUid = requiredUuid(raw.fromPortEntityUid, 'fromPortEntityUid', 'subflowInvalid');
    const toPortEntityUid = raw.toPortEntityUid == null
      ? null
      : requiredUuid(raw.toPortEntityUid, 'toPortEntityUid', 'subflowInvalid');
    const key = `${direction}:${fromPortEntityUid}`;
    if (result.has(key)) fail('subflowInvalid', { label: 'portMappings', reason: 'duplicate_source' });
    const fromPort = fromContracts[direction].byUid.get(fromPortEntityUid);
    if (!fromPort) fail('subflowInvalid', { label: 'fromPortEntityUid' });
    let toPort = null;
    if (toPortEntityUid) {
      toPort = toContracts[direction].byUid.get(toPortEntityUid);
      if (!toPort || !compatiblePortKinds(fromPort, toPort)) fail('subflowInvalid', { label: 'toPortEntityUid' });
      const targetKey = `${direction}:${toPortEntityUid}`;
      if (targetUse.has(targetKey)) fail('subflowInvalid', { label: 'portMappings', reason: 'duplicate_target' });
      targetUse.add(targetKey);
    }
    result.set(key, { direction, fromPortEntityUid, toPortEntityUid, fromPort, toPort });
  }
  return result;
}

function normalizeParameterMappings(rawMappings, fromContracts, toContracts) {
  const mappings = safeArray(rawMappings, 'parameterMappings', MAX_MAPPING_ITEMS, 'subflowInvalid');
  const result = new Map();
  const targetUse = new Set();
  for (const raw of mappings) {
    const allowed = new Set(['fromParameterEntityUid', 'toParameterEntityUid']);
    assertExactKeys(raw, allowed, 'parameterMapping', 'subflowInvalid');
    const fromParameterEntityUid = requiredUuid(raw.fromParameterEntityUid, 'fromParameterEntityUid', 'subflowInvalid');
    const toParameterEntityUid = raw.toParameterEntityUid == null
      ? null
      : requiredUuid(raw.toParameterEntityUid, 'toParameterEntityUid', 'subflowInvalid');
    if (result.has(fromParameterEntityUid)) fail('subflowInvalid', { label: 'parameterMappings', reason: 'duplicate_source' });
    const fromParameter = fromContracts.parameter.byUid.get(fromParameterEntityUid);
    if (!fromParameter) fail('subflowInvalid', { label: 'fromParameterEntityUid' });
    let toParameter = null;
    if (toParameterEntityUid) {
      toParameter = toContracts.parameter.byUid.get(toParameterEntityUid);
      if (!toParameter || targetUse.has(toParameterEntityUid)) fail('subflowInvalid', { label: 'toParameterEntityUid' });
      targetUse.add(toParameterEntityUid);
    }
    result.set(fromParameterEntityUid, {
      fromParameterEntityUid,
      toParameterEntityUid,
      fromParameter,
      toParameter,
    });
  }
  return result;
}

function nodeMatchesInstance(node, identity) {
  return String(node || '') === String(identity.id || '') || normalizedEntityUid(node) === entityUidOf(identity);
}

function resolveSubflowUpgradePlan(authority, digest) {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/i.test(digest)) fail('subflowInvalid', { label: 'upgradePlanDigest' });
  const matches = (Array.isArray(authority?.subflowUpgradePlans) ? authority.subflowUpgradePlans : []).filter((plan) => {
    const computed = digestSubflowUpgradePlan(plan);
    const declared = plan?.upgradePlanDigest || plan?.digest;
    if (declared != null && String(declared).toLowerCase() !== computed) fail('subflowInvalid', { label: 'upgradePlan.declaredDigest' });
    return computed === digest.toLowerCase();
  });
  if (matches.length > 1) fail('targetAmbiguous', { kind: 'subflow-upgrade-plan' });
  if (!matches[0]) fail('targetMissing', { kind: 'subflow-upgrade-plan' });
  return assertPlainRecord(matches[0], 'subflowUpgradePlan');
}

function authorizeSubflowInstanceUpgrade(rawOperation, authority) {
  const operation = normalizeOperationEnvelope(rawOperation, 'subflow.instance.upgrade', authority);
  const document = assertDocumentScope(operation, authority);
  const principal = trustedPrincipal(authority);
  requireCapability(principal, 'editGraph');
  const allowed = new Set([
    'instanceUid', 'definitionUid', 'expectedCanvasRevision', 'expectedInstanceRevision',
    'expectedDefinitionVersion', 'expectedDefinitionRevision', 'targetDefinitionVersion',
    'targetDefinitionRevision', 'upgradePlanDigest',
  ]);
  assertExactKeys(operation.payload, allowed, 'subflow.instance.upgrade.payload', 'subflowInvalid');
  if (operation.payload.expectedCanvasRevision !== operation.baseRevision) fail('revisionMismatch');
  const instanceEntityUid = requiredUuid(operation.payload.instanceUid, 'instanceUid', 'subflowInvalid');
  const definitionUid = requiredUuid(operation.payload.definitionUid, 'definitionUid', 'subflowInvalid');
  const instanceRevision = requiredPositiveInteger(operation.payload.expectedInstanceRevision, 'expectedInstanceRevision', 'subflowInvalid');
  if (instanceRevision > operation.baseRevision) fail('subflowInvalid', { label: 'expectedInstanceRevision' });
  const fromVersion = requiredPositiveInteger(operation.payload.expectedDefinitionVersion, 'expectedDefinitionVersion', 'subflowInvalid');
  const fromDefinitionRevision = requiredPositiveInteger(operation.payload.expectedDefinitionRevision, 'expectedDefinitionRevision', 'subflowInvalid');
  const toVersion = requiredPositiveInteger(operation.payload.targetDefinitionVersion, 'targetDefinitionVersion', 'subflowInvalid');
  const toDefinitionRevision = requiredPositiveInteger(operation.payload.targetDefinitionRevision, 'targetDefinitionRevision', 'subflowInvalid');
  if (toVersion < fromVersion || (toVersion === fromVersion && toDefinitionRevision <= fromDefinitionRevision)) {
    fail('subflowInvalid', { label: 'targetDefinitionVersion' });
  }
  if (typeof operation.payload.upgradePlanDigest !== 'string') fail('subflowInvalid', { label: 'upgradePlanDigest' });
  const upgradePlanDigest = operation.payload.upgradePlanDigest.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(upgradePlanDigest)) fail('subflowInvalid', { label: 'upgradePlanDigest' });
  const instance = resolveSubflowInstance(document, instanceEntityUid);
  const currentInstanceRevision = requiredPositiveInteger(
    instance.revision ?? instance.entityRevision,
    'instance.revision',
    'subflowInvalid',
  );
  if (currentInstanceRevision !== instanceRevision) fail('subflowInvalid', { label: 'expectedInstanceRevision' });
  const data = instance.data && typeof instance.data === 'object' && !Array.isArray(instance.data) ? instance.data : {};
  const currentDefinitionUid = normalizedEntityUid(data.definitionEntityUid)
    || normalizedEntityUid(data.definitionId)
    || definitionEntityUid(data.definition);
  if (currentDefinitionUid !== definitionUid
    || Number(data.definitionVersion || data.definition?.version) !== fromVersion
    || Number(data.definitionRevision || data.definition?.revision) !== fromDefinitionRevision) {
    fail('subflowInvalid', { label: 'instance.definition_binding' });
  }
  const fromDefinition = resolveSubflowDefinition(authority, definitionUid, fromVersion, operation.projectId, fromDefinitionRevision);
  const toDefinition = resolveSubflowDefinition(authority, definitionUid, toVersion, operation.projectId, toDefinitionRevision);
  if (Number(fromDefinition.revision) !== fromDefinitionRevision || Number(toDefinition.revision) !== toDefinitionRevision) {
    fail('subflowInvalid', { label: 'definition.revision' });
  }
  const upgradePlan = resolveSubflowUpgradePlan(authority, upgradePlanDigest);
  const planBindings = [
    ['instanceUid', instanceEntityUid],
    ['definitionUid', definitionUid],
    ['expectedCanvasRevision', operation.baseRevision],
    ['expectedInstanceRevision', instanceRevision],
    ['expectedDefinitionVersion', fromVersion],
    ['expectedDefinitionRevision', fromDefinitionRevision],
    ['targetDefinitionVersion', toVersion],
    ['targetDefinitionRevision', toDefinitionRevision],
  ];
  for (const [key, expected] of planBindings) {
    const actual = key.endsWith('Uid') ? normalizedEntityUid(upgradePlan[key]) : Number(upgradePlan[key]);
    if (actual !== expected) fail('subflowInvalid', { label: `upgradePlan.${key}` });
  }
  const fromContracts = subflowPortContracts(fromDefinition);
  const toContracts = subflowPortContracts(toDefinition);
  const portMappings = normalizePortMappings(upgradePlan.portMappings, fromContracts, toContracts);
  const parameterMappings = normalizeParameterMappings(upgradePlan.parameterMappings, fromContracts, toContracts);
  const edgePatches = [];
  const disconnectedEdgeEntityUids = [];
  for (const edge of Array.isArray(document.edges) ? document.edges : []) {
    let direction = null;
    let handle = null;
    if (nodeMatchesInstance(edge?.target, instance)) {
      direction = 'input';
      handle = edge?.targetHandle;
    } else if (nodeMatchesInstance(edge?.source, instance)) {
      direction = 'output';
      handle = edge?.sourceHandle;
    }
    if (!direction) continue;
    const edgeEntityUid = requiredUuid(edge?.entityUid, 'edge.entityUid', 'subflowInvalid');
    const oldPort = fromContracts[direction].byHandle.get(String(handle || ''));
    if (!oldPort) fail('subflowInvalid', { label: `${direction}.handle` });
    const oldPortUid = entityUidOf(oldPort);
    const mapping = portMappings.get(`${direction}:${oldPortUid}`);
    if (!mapping) fail('subflowInvalid', { label: 'portMappings', reason: 'connected_port_unmapped' });
    if (!mapping.toPort) {
      disconnectedEdgeEntityUids.push(edgeEntityUid);
    } else {
      edgePatches.push({
        edgeEntityUid,
        direction,
        fromPortEntityUid: oldPortUid,
        toPortEntityUid: entityUidOf(mapping.toPort),
        handle: String(mapping.toPort.id),
      });
    }
  }
  const mappedConnectionCounts = new Map();
  for (const patch of edgePatches) {
    const key = `${patch.direction}:${patch.toPortEntityUid}`;
    mappedConnectionCounts.set(key, (mappedConnectionCounts.get(key) || 0) + 1);
  }
  for (const direction of ['input', 'output']) {
    for (const [portEntityUid, port] of toContracts[direction].byUid) {
      const count = mappedConnectionCounts.get(`${direction}:${portEntityUid}`) || 0;
      const minimum = Math.max(0, Math.trunc(Number(port.minConnections ?? (port.required ? 1 : 0)) || 0));
      const maximum = port.maxConnections == null ? null : Math.max(0, Math.trunc(Number(port.maxConnections) || 0));
      const effectiveCount = direction === 'input' && count === 0 && hasOwn(port, 'defaultValue') ? 1 : count;
      if (effectiveCount < minimum || (maximum != null && count > maximum)) {
        fail('subflowInvalid', { label: `${direction}.connections`, portEntityUid });
      }
    }
  }
  const overrides = data.parameterOverrides && typeof data.parameterOverrides === 'object' && !Array.isArray(data.parameterOverrides)
    ? data.parameterOverrides
    : {};
  const nextOverrides = {};
  const discardedOverrides = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (UNSAFE_KEYS.has(key)) fail('subflowInvalid', { label: 'parameterOverrides' });
    const oldParameter = fromContracts.parameter.byHandle.get(key);
    if (!oldParameter) fail('subflowInvalid', { label: 'parameterOverrides', reason: 'unknown_parameter' });
    const oldParameterUid = entityUidOf(oldParameter);
    const mapping = parameterMappings.get(oldParameterUid);
    if (!mapping) fail('subflowInvalid', { label: 'parameterMappings', reason: 'overridden_parameter_unmapped' });
    if (!mapping.toParameter) {
      discardedOverrides.push({ parameterEntityUid: oldParameterUid, reason: 'removed' });
      continue;
    }
    if (!valueMatchesSchema(value, mapping.toParameter.schema)) {
      fail('subflowInvalid', { label: 'parameterOverrides', reason: 'incompatible_value' });
    }
    nextOverrides[String(mapping.toParameter.id)] = cloneJson(value);
  }
  const nodeDataPatch = {
    definitionEntityUid: definitionUid,
    definitionId: String(toDefinition.id),
    definitionVersion: toVersion,
    definitionRevision: toDefinitionRevision,
    definitionProjectId: operation.projectId,
    definition: cloneJson(toDefinition),
    parameterOverrides: nextOverrides,
  };
  return {
    type: operation.type,
    opId: operation.opId,
    scope: { projectId: operation.projectId, canvasId: operation.canvasId, baseRevision: operation.baseRevision },
    atomic: true,
    preconditions: [
      { kind: 'canvas.revision.equals', revision: operation.baseRevision },
      { kind: 'subflow.instance.binding.equals', instanceEntityUid, instanceRevision, definitionEntityUid: definitionUid, version: fromVersion, definitionRevision: fromDefinitionRevision },
      { kind: 'subflow.definition.exists', definitionEntityUid: definitionUid, version: toVersion, definitionRevision: toDefinitionRevision },
      { kind: 'subflow.upgrade-plan.digest.equals', digest: upgradePlanDigest },
    ],
    writes: [{
      kind: 'subflow.instance.upgrade',
      instanceEntityUid,
      fromVersion,
      toVersion,
      fromDefinitionRevision,
      toDefinitionRevision,
      upgradePlanDigest,
      nodeDataPatch,
      edgePatches,
      disconnectedEdgeEntityUids,
      discardedOverrides,
    }],
    result: {
      instanceEntityUid,
      definitionEntityUid: definitionUid,
      fromVersion,
      toVersion,
      fromDefinitionRevision,
      toDefinitionRevision,
      upgradePlanDigest,
      edgePatches,
      disconnectedEdgeEntityUids,
      discardedOverrides,
    },
    audit: {
      actorId: principal.actorId,
      sessionId: principal.sessionId,
      action: 'subflow.instance.upgrade',
      targetType: 'subflow-instance',
      targetId: instanceEntityUid,
    },
  };
}

function findAuthorityRecord(items, identity, kind, errorKey = 'artifactInvalid') {
  const matches = (Array.isArray(items) ? items : []).filter((item) => entityUidOf(item) === identity);
  if (matches.length > 1) fail('targetAmbiguous', { kind });
  if (!matches[0]) fail('targetMissing', { kind });
  const record = assertActiveLifecycle(matches[0], kind);
  if (!entityUidOf(record)) fail(errorKey, { label: `${kind}.entityUid` });
  return record;
}

function assertArtifactStatus(value, label, allowed) {
  const status = String(value?.status || '');
  if (!allowed.has(status)) fail('artifactInvalid', { label });
}

function authorizeHostArtifactCommit(rawOperation, authority) {
  const operation = normalizeOperationEnvelope(rawOperation, 'host.artifact.commit', authority);
  assertDocumentScope(operation, authority);
  const host = assertPlainRecord(authority?.hostIdentity, 'authority.hostIdentity');
  const actorId = boundedIdentity(host.actorId, 'authority.hostIdentity.actorId', 'artifactInvalid');
  const sessionId = boundedIdentity(host.sessionId, 'authority.hostIdentity.sessionId', 'artifactInvalid');
  const allowed = new Set([
    'artifactUid', 'blobUid', 'runUid', 'nodeRunUid', 'attemptUid', 'nodeUid',
    'expectedCanvasRevision', 'expectedRunRevision', 'expectedNodeRunRevision',
    'expectedAttemptRevision', 'outputOrdinal', 'kind', 'contentHash', 'byteSize',
    'filename', 'mimeType',
  ]);
  assertExactKeys(operation.payload, allowed, 'host.artifact.commit.payload', 'artifactInvalid');
  if (operation.payload.expectedCanvasRevision !== operation.baseRevision) fail('revisionMismatch');
  const runId = requiredUuid(operation.payload.runUid, 'runUid', 'artifactInvalid');
  const nodeRunId = requiredUuid(operation.payload.nodeRunUid, 'nodeRunUid', 'artifactInvalid');
  const attemptId = requiredUuid(operation.payload.attemptUid, 'attemptUid', 'artifactInvalid');
  const assetEntityUid = requiredUuid(operation.payload.artifactUid, 'artifactUid', 'artifactInvalid');
  const blobUid = requiredUuid(operation.payload.blobUid, 'blobUid', 'artifactInvalid');
  const nodeEntityUid = requiredUuid(operation.payload.nodeUid, 'nodeUid', 'artifactInvalid');
  const expectedRunRevision = requiredPositiveInteger(operation.payload.expectedRunRevision, 'expectedRunRevision', 'artifactInvalid');
  const expectedNodeRunRevision = requiredPositiveInteger(operation.payload.expectedNodeRunRevision, 'expectedNodeRunRevision', 'artifactInvalid');
  const expectedAttemptRevision = requiredPositiveInteger(operation.payload.expectedAttemptRevision, 'expectedAttemptRevision', 'artifactInvalid');
  const outputIndex = operation.payload.outputOrdinal;
  if (!Number.isSafeInteger(outputIndex) || outputIndex < 0 || outputIndex > 999) fail('artifactInvalid', { label: 'outputOrdinal' });
  if (typeof operation.payload.kind !== 'string') fail('artifactInvalid', { label: 'kind' });
  const artifactKind = operation.payload.kind;
  if (!HOST_ARTIFACT_KINDS.has(artifactKind)) fail('artifactInvalid', { label: 'kind' });
  if (typeof operation.payload.contentHash !== 'string') fail('artifactInvalid', { label: 'contentHash' });
  const requestedContentHash = operation.payload.contentHash.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(requestedContentHash)) fail('artifactInvalid', { label: 'contentHash' });
  const requestedByteSize = operation.payload.byteSize;
  if (!Number.isSafeInteger(requestedByteSize) || requestedByteSize < 0 || requestedByteSize > MAX_ARTIFACT_BYTES) {
    fail('artifactInvalid', { label: 'byteSize' });
  }
  const filename = operation.payload.filename;
  if (typeof filename !== 'string' || !filename || filename.length > 240 || filename.trim() !== filename
    || /[\u0000-\u001f\u007f]/.test(filename) || UNSAFE_KEYS.has(filename)
    || filename === '.' || filename === '..' || /[\\/]/.test(filename)) {
    fail('artifactInvalid', { label: 'filename' });
  }
  const mimeType = operation.payload.mimeType;
  if (typeof mimeType !== 'string' || mimeType.length > 160 || !MIME_PATTERN.test(mimeType)) {
    fail('artifactInvalid', { label: 'mimeType' });
  }
  const run = findAuthorityRecord(authority?.runs, runId, 'run');
  const nodeRun = findAuthorityRecord(authority?.nodeRuns, nodeRunId, 'node-run');
  const attempt = findAuthorityRecord(authority?.attempts, attemptId, 'attempt');
  const asset = findAuthorityRecord(authority?.assets, assetEntityUid, 'asset');
  const blob = findAuthorityRecord(authority?.blobs, blobUid, 'asset-blob');
  if (String(run.projectId || '') !== operation.projectId || String(run.canvasId || '') !== operation.canvasId) fail('scopeMismatch');
  const runRevision = requiredPositiveInteger(run.revision, 'run.revision', 'artifactInvalid');
  const nodeRunRevision = requiredPositiveInteger(nodeRun.revision, 'nodeRun.revision', 'artifactInvalid');
  const attemptRevision = requiredPositiveInteger(attempt.revision, 'attempt.revision', 'artifactInvalid');
  if (runRevision !== expectedRunRevision
    || nodeRunRevision !== expectedNodeRunRevision
    || attemptRevision !== expectedAttemptRevision) {
    fail('revisionMismatch', { runRevision, nodeRunRevision, attemptRevision });
  }
  const runCanvasRevision = requiredPositiveInteger(run.canvasRevision, 'run.canvasRevision', 'artifactInvalid');
  if (runCanvasRevision > operation.baseRevision) fail('revisionMismatch', { runCanvasRevision });
  if (entityUidOf(nodeRun.runEntityUid ? { entityUid: nodeRun.runEntityUid } : { id: nodeRun.runId }) !== runId
    && String(nodeRun.runId || '') !== String(run.id || '')) {
    fail('artifactInvalid', { label: 'nodeRun.runId' });
  }
  if (entityUidOf(attempt.nodeRunEntityUid ? { entityUid: attempt.nodeRunEntityUid } : { id: attempt.nodeRunId }) !== nodeRunId
    && String(attempt.nodeRunId || '') !== String(nodeRun.id || '')) {
    fail('artifactInvalid', { label: 'attempt.nodeRunId' });
  }
  const boundNodeUid = normalizedEntityUid(nodeRun.nodeEntityUid)
    || normalizedEntityUid(nodeRun.sourceNodeEntityUid)
    || normalizedEntityUid(nodeRun.originalNodeEntityUid);
  if (boundNodeUid !== nodeEntityUid) fail('artifactInvalid', { label: 'nodeRun.nodeEntityUid' });
  if (String(asset.projectId || '') !== operation.projectId) fail('scopeMismatch');
  const assetBlobUid = normalizedEntityUid(asset.blobUid) || normalizedEntityUid(asset.blobEntityUid);
  if (assetBlobUid !== blobUid) fail('artifactInvalid', { label: 'asset.blobUid' });
  const provenance = asset.provenance && typeof asset.provenance === 'object' ? asset.provenance : {};
  const bindings = [
    ['runId', runId, provenance.runEntityUid || provenance.runId],
    ['nodeRunId', nodeRunId, provenance.nodeRunEntityUid || provenance.nodeRunId],
    ['attemptId', attemptId, provenance.attemptEntityUid || provenance.attemptId],
  ];
  for (const [label, expected, actual] of bindings) {
    const actualUid = normalizedEntityUid(actual);
    if (actualUid !== expected && String(actual || '') !== String(
      label === 'runId' ? run.id : label === 'nodeRunId' ? nodeRun.id : attempt.id,
    )) fail('artifactInvalid', { label: `asset.provenance.${label}` });
  }
  if (String(provenance.canvasId || '') !== operation.canvasId) fail('scopeMismatch');
  if (Number(provenance.canvasRevision) !== runCanvasRevision) {
    fail('artifactInvalid', { label: 'asset.provenance.canvasRevision' });
  }
  if (normalizedEntityUid(provenance.sourceNodeEntityUid) !== nodeEntityUid) {
    fail('artifactInvalid', { label: 'asset.provenance.sourceNodeEntityUid' });
  }
  const contentHash = String(asset.contentHash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(contentHash)) fail('artifactInvalid', { label: 'asset.contentHash' });
  if (requestedContentHash !== contentHash
    || String(blob.contentHash || '').toLowerCase() !== contentHash) {
    fail('artifactInvalid', { label: 'contentHash' });
  }
  const blobVerificationState = String(blob.verificationState ?? blob.verification_state ?? '');
  const blobStorageState = String(blob.storageState ?? blob.storage_state ?? '');
  const blobStorageKey = String(blob.storageKey ?? blob.storage_key ?? '');
  const blobVerifiedAt = Number(blob.verifiedAt ?? blob.verified_at);
  if (blobVerificationState !== 'verified' || blobStorageState !== 'ready'
    || !blobStorageKey || blobStorageKey.length > 2_048
    || /[\u0000-\u001f\u007f]/.test(blobStorageKey)
    || !Number.isSafeInteger(blobVerifiedAt) || blobVerifiedAt < 1) {
    fail('artifactInvalid', { label: 'blob.availability' });
  }
  const byteSize = Number(asset.byteSize ?? asset.size ?? asset.metadata?.size);
  const blobByteSize = Number(blob.byteSize ?? blob.size);
  if (byteSize !== requestedByteSize || blobByteSize !== requestedByteSize) {
    fail('artifactInvalid', { label: 'byteSize' });
  }
  if (String(asset.kind || '') !== artifactKind
    || String(asset.filename || '') !== filename
    || String(asset.mimeType || '') !== mimeType
    || (blob.mimeType != null && String(blob.mimeType) !== mimeType)) {
    fail('artifactInvalid', { label: 'artifact.metadata' });
  }
  if (Number(provenance.outputOrdinal) !== outputIndex) {
    fail('artifactInvalid', { label: 'asset.provenance.outputOrdinal' });
  }
  assertArtifactStatus(run, 'run.status', new Set(['running', 'succeeded']));
  assertArtifactStatus(nodeRun, 'nodeRun.status', new Set(['running', 'polling', 'succeeded']));
  assertArtifactStatus(attempt, 'attempt.status', new Set(['running', 'polling', 'succeeded']));
  if (!['available', 'ready'].includes(String(asset.availability || ''))) fail('artifactInvalid', { label: 'asset.availability' });
  return {
    type: operation.type,
    opId: operation.opId,
    scope: { projectId: operation.projectId, canvasId: operation.canvasId, baseRevision: operation.baseRevision },
    atomic: true,
    preconditions: [
      { kind: 'canvas.revision.equals', revision: operation.baseRevision },
      { kind: 'run.binding.equals', runId, runRevision, projectId: operation.projectId, canvasId: operation.canvasId, canvasRevision: runCanvasRevision },
      { kind: 'node-run.belongs-to-run', nodeRunId, nodeRunRevision, runId },
      { kind: 'attempt.belongs-to-node-run', attemptId, attemptRevision, nodeRunId },
      { kind: 'asset.provenance.equals', assetEntityUid, blobUid, runId, nodeRunId, attemptId, nodeEntityUid },
      { kind: 'node.output.absent', runId, nodeRunId, attemptId, outputIndex, assetEntityUid },
    ],
    writes: [{
      kind: 'host.artifact.commit',
      runId,
      nodeRunId,
      attemptId,
      assetId: String(asset.id || assetEntityUid),
      assetEntityUid,
      blobUid,
      nodeEntityUid,
      outputIndex,
      contentHash,
      event: {
        entityUid: operation.opId,
        type: 'node.output',
        runId,
        nodeRunId,
        attemptId,
        assetEntityUid,
        canvasRevision: runCanvasRevision,
        commitCanvasRevision: operation.baseRevision,
      },
    }],
    result: { runId, nodeRunId, attemptId, assetEntityUid, blobUid, nodeEntityUid, outputIndex },
    audit: {
      actorId,
      sessionId,
      action: 'host.artifact.commit',
      targetType: 'asset',
      targetId: assetEntityUid,
      metadata: { runId, nodeRunId, attemptId, nodeEntityUid, outputIndex, canvasRevision: runCanvasRevision, commitCanvasRevision: operation.baseRevision },
    },
  };
}

function authorizeCollaborationDomainOperation(rawOperation, authority) {
  assertSafeJson(rawOperation, { label: 'operation', maxBytes: MAX_OPERATION_BYTES });
  const type = rawOperation.type;
  if (type === 'review.thread.create') return authorizeReviewThreadCreate(rawOperation, authority);
  if (type === 'review.thread.update') return authorizeReviewThreadUpdate(rawOperation, authority);
  if (type === 'review.comment.add') return authorizeReviewCommentAdd(rawOperation, authority);
  if (type === 'subflow.instance.upgrade') return authorizeSubflowInstanceUpgrade(rawOperation, authority);
  if (type === 'host.artifact.commit') return authorizeHostArtifactCommit(rawOperation, authority);
  fail('operationUnsupported', { type: String(type || '') });
}

function authorizeCollaborationDomainBatch(rawBatch, authority) {
  const batch = normalizeCommonOperationBatch(rawBatch);
  const scopedAuthority = { ...authority, batch };
  const operations = batch.operations
    .filter((operation) => DOMAIN_OPERATION_TYPES.has(operation.type))
    .map((operation) => authorizeCollaborationDomainOperation(operation, scopedAuthority));
  return {
    batch,
    atomic: true,
    operations,
    preconditions: operations.flatMap((operation) => operation.preconditions),
    writes: operations.flatMap((operation) => operation.writes),
    audits: operations.map((operation) => operation.audit),
  };
}

module.exports = {
  CollaborationDomainAuthorityError,
  DOMAIN_OPERATION_TYPES,
  REVIEW_SEVERITIES,
  REVIEW_STATUSES,
  authorizeCollaborationDomainBatch,
  authorizeCollaborationDomainOperation,
  authorizeHostArtifactCommit,
  authorizeReviewCommentAdd,
  authorizeReviewThreadCreate,
  authorizeReviewThreadUpdate,
  authorizeSubflowInstanceUpgrade,
  digestSubflowUpgradePlan,
  resolveReviewAnchor,
};
