const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const {
  SubflowRevisionConflictError,
  getProjectDatabase,
  translateProjectDatabaseStorageCapacityError,
} = require('../services/projectDatabase');
const { getAssetPreviewPipeline } = require('../services/assetPreviewPipeline');
const { createHttpApplicationLifecycle } = require('../services/httpApplicationLifecycle');
const { publicAsset } = require('../services/assetPublicView');
const {
  assertCanvasOperationCredentialAuthority,
  mapCanvasMutationError,
} = require('../services/canvasPatch');
const {
  publicCanvasDocument,
  publicCanvasMutationResult,
  publicCanvasSync,
  publicCollaborationCanvasValue,
  publicSubflowDefinition,
} = require('../services/collaborationCanvasPublicView');
const { executeCanvasAgentTool } = require('../services/canvasAgentTools');
const {
  authorizeSubflowInstanceUpgrade,
  digestSubflowUpgradePlan,
  resolveReviewAnchor,
} = require('../services/collaborationDomainAuthority');
const { assertCollaborationStructureAuthority } = require('../services/collaborationStructureAuthority');
const {
  AssetUploadManager,
  collaborationUploadScope,
  safeUploadErrorCode,
  safeUploadErrorMessage,
  uploadError,
} = require('../services/assetUploadManager');
const {
  PUBLIC_PROJECT_DATABASE_CAPACITY_REASONS,
  sendProjectDatabaseStorageCapacityError,
} = require('../services/projectDatabasePublicError');
const {
  normalizeSubflowChangeSummary,
  publicSubflowPublication,
  validateSubflowDefinition,
} = require('../services/subflowDefinition');
const { CollaborationAuth, parseCookies } = require('./auth');
const {
  classifyCollaborationWebSocketMessage,
  consumeTieredWindowBudget,
  createTieredBandwidthThrottle,
  createWeightedWindowLimiter,
  retryAfterSeconds,
  sendCollaborationRateLimit,
} = require('./abuseLimits');
const { adaptCommonGraphBatch } = require('./commonOperationAdapter');
const {
  COMMON_OPERATION_BATCH_CONTRACT,
  isCommonOperationUuid,
  normalizeCommonOperationBatch,
} = require('./commonOperationProtocol');
const {
  decodeReviewThreadStorageStatus,
  isReviewDecisionStatus,
  isReviewLifecycleStatus,
  isReviewResolutionStatus,
  reviewCompatibilityStatus,
  reviewLifecycleTransitionCapability,
} = require('./reviewLifecycle');
const { CollaborationTextPersistence } = require('../services/collaborationTextPersistence');
const { ExecutionPolicyError, HostExecutionPolicy } = require('./executionPolicy');
const {
  buildCollaborationAllowedOrigins,
  inspectJsonComplexity,
  normalizeRequestOrigin,
  originAllowed,
} = require('./gatewaySecurity');
const {
  listNetworkInterfaces,
  normalizeBindHost,
  shareUrlsForHost,
  validateBindHost,
} = require('./hostManagement');
const {
  PUBLIC_SELF_CHECK_HEADER,
  PUBLIC_SELF_CHECK_INVITE_CODE,
  PUBLIC_SELF_CHECK_MAX_UPLOAD_BYTES,
  PublicSelfCheckChallenges,
  isInsecurePublicRequest,
  normalizePublicBaseUrl,
  runPublicSelfCheck,
  safeConfiguredPublicExposure,
} = require('./publicExposure');
const { PublicExposureStore } = require('./publicExposureStore');
const { requireOperationBatchRevision, validateOperation } = require('./protocol');
const {
  RunIntentAuthorityError,
  deriveRunIntentAuthority,
  normalizeRequestedRunNodeIds,
  stableJson,
  summarizeRunIntentAuthority,
} = require('./runIntentAuthority');

const SESSION_COOKIE = 't8_collab_session';
const MAX_WS_MESSAGE_BYTES = 64 * 1024;
const MAX_CANVAS_AGENT_REQUEST_BYTES = 64 * 1024;
const MAX_COLLABORATION_SESSION_HEARTBEAT_BYTES = 4 * 1024;
const COLLABORATION_CORS_ALLOWED_HEADERS = Object.freeze([
  'content-type',
  'x-t8-canvas-generation',
]);
const COLLABORATION_CORS_HEADER_NAMES = Object.freeze({
  'content-type': 'Content-Type',
  'x-t8-canvas-generation': 'X-T8-Canvas-Generation',
});
const COLLABORATION_SESSION_HEARTBEAT_FIELDS = Object.freeze([
  'sessionId',
  'projectId',
  'canvasId',
  'memberId',
  'authorizationEpoch',
]);
const WS_CLOSE_GRACE_MS = 500;
const SERVER_CLOSE_GRACE_MS = 2000;
const SERVER_CLOSE_SETTLE_MS = 250;
const COLLABORATION_PROTOCOL_VERSION = 2;
const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_WS_HEARTBEAT_TIMEOUT_MS = 15_000;
const WS_CLOSE_HEARTBEAT_TIMEOUT = 4000;
const WS_CLOSE_SESSION_REVOKED = 4001;
const WS_CLOSE_SESSION_CHANGED = 4002;
const WS_CLOSE_RESOURCE_SCOPE = 4003;
const WS_CLOSE_HOST_STOPPED = 4004;
const WS_CLOSE_SESSION_REFRESH_UNAVAILABLE = 1013;
const WS_CLOSE_RECOVERY_GENERATION_UNAVAILABLE = 1013;
const RECOVERY_GENERATION_UNAVAILABLE_CODE = 'project_database_recovery_generation_unavailable';
const RECOVERY_GENERATION_RETRY_AFTER_MS = 1_000;
const RECOVERY_GENERATION_WS_REASON = 'recovery generation temporarily unavailable';
const SUBFLOW_UPGRADE_PLAN_TTL_MS = 2 * 60 * 1000;
const SUBFLOW_UPGRADE_PLAN_CACHE_LIMIT = 256;
const DEFAULT_RATE_LIMIT_MAX_BUCKETS = 4_096;
const DEFAULT_WS_MAX_CONNECTIONS_PER_IP = 64;
const DEFAULT_WS_MAX_CONNECTIONS_PER_SESSION = 8;
const DEFAULT_WS_HANDSHAKES_PER_MINUTE_PER_IP = 120;
const DEFAULT_WS_HANDSHAKES_PER_MINUTE_PER_SESSION = 60;
const DEFAULT_WS_MESSAGES_PER_WINDOW = 240;
const DEFAULT_WS_MESSAGE_WINDOW_MS = 10_000;
const DEFAULT_INVITE_REDEEMS_PER_MINUTE_PER_IP = 12;
const DEFAULT_INVITE_REDEEMS_PER_MINUTE_PER_CODE = 12;
const DEFAULT_UPLOAD_REQUESTS_PER_MINUTE_PER_IP = 600;
const DEFAULT_UPLOAD_REQUESTS_PER_MINUTE_PER_SESSION = 300;
const DEFAULT_UPLOAD_BYTES_PER_MINUTE_PER_IP = 1024 * 1024 * 1024;
const DEFAULT_UPLOAD_BYTES_PER_MINUTE_PER_SESSION = 512 * 1024 * 1024;
const DEFAULT_DOWNLOAD_REQUESTS_PER_MINUTE_PER_IP = 600;
const DEFAULT_DOWNLOAD_REQUESTS_PER_MINUTE_PER_SESSION = 300;
const DEFAULT_DOWNLOAD_BYTES_PER_SECOND_PER_IP = 64 * 1024 * 1024;
const DEFAULT_DOWNLOAD_BYTES_PER_SECOND_PER_SESSION = 32 * 1024 * 1024;
const WS_CLOSE_MESSAGE_RATE_LIMITED = 1013;
const WS_MESSAGE_RATE_LIMIT_REASON = 'message rate exceeded';
const DEFAULT_WS_MESSAGE_CLASS_LIMITS = Object.freeze({
  presence: Object.freeze({ ip: 1_200, session: 600 }),
  heartbeat: Object.freeze({ ip: 600, session: 120 }),
  join: Object.freeze({ ip: 120, session: 30 }),
  unknown: Object.freeze({ ip: 120, session: 60 }),
});
const ASSET_UPLOAD_POST_COMMIT_PHASES = new Set([
  'finalization',
  'chunk-purge',
  'quota-refresh',
]);
const ACTIVE_COLLABORATION_UPLOAD_STATES = new Set(['uploading', 'paused', 'assembling']);
const COLLABORATION_UPLOAD_DISCOVERY_LIMIT = 64;
const COLLABORATION_UPLOAD_DISCOVERY_SCAN_LIMIT = 512;
const COMMON_REVIEW_OPERATION_TYPES = new Set([
  'review.thread.create',
  'review.comment.add',
  'review.thread.update',
]);

function safeCommittedNotificationLabel(value) {
  const normalized = String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return normalized || 'unknown';
}

function runCommittedNotification(label, callback) {
  try {
    callback();
    return true;
  } catch (_) {
    // A live notification happens only after its durable mutation returned.
    // Log a bounded operation label, never the socket/DB error or its message.
    try {
      console.warn(
        `[collaboration-gateway] committed notification failed (${safeCommittedNotificationLabel(label)})`,
      );
    } catch (_) { /* logging is best effort too */ }
    return false;
  }
}

function requiredReviewReplayCapability(operation) {
  if (operation?.type !== 'review.thread.update') return 'comment';
  const status = String(operation?.payload?.reviewStatus || operation?.payload?.status || '');
  return ['approved', 'changes_requested'].includes(status) ? 'approve' : 'comment';
}

function assertCurrentReviewReplayCapabilities(auth, session, batch) {
  for (const operation of batch.operations) {
    const capability = requiredReviewReplayCapability(operation);
    if (auth.hasCapability(session, capability)) continue;
    throw collaborationGatewayError(
      'collaboration_domain_capability_missing',
      '已认证成员缺少领域操作能力',
      403,
    );
  }
}

function collaborationGatewayError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function requiredReviewRevision(value, label) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw collaborationGatewayError(
      'collaboration_review_revision_invalid',
      `${label}必须是正整数`,
      400,
    );
  }
  return revision;
}

function optionalBooleanQuery(value, label) {
  if (value == null || value === '') return undefined;
  if (value === true || String(value) === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === false || String(value) === '0' || String(value).toLowerCase() === 'false') return false;
  throw collaborationGatewayError(
    'collaboration_review_filter_invalid',
    `${label}必须是 true 或 false`,
    400,
  );
}

function boundedReviewPagination(query = {}) {
  const rawLimit = query.limit == null || query.limit === '' ? 50 : Number(query.limit);
  const rawOffset = query.offset == null || query.offset === '' ? 0 : Number(query.offset);
  if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 100
    || !Number.isSafeInteger(rawOffset) || rawOffset < 0 || rawOffset > 10_000) {
    throw collaborationGatewayError(
      'collaboration_review_pagination_invalid',
      '评论分页范围无效',
      400,
    );
  }
  return { limit: rawLimit, offset: rawOffset };
}

function reviewFiltersFromQuery(query, session) {
  const { limit, offset } = boundedReviewPagination(query);
  const status = query.status == null || query.status === '' ? undefined : String(query.status);
  const resolutionStatus = query.resolutionStatus == null || query.resolutionStatus === ''
    ? undefined
    : String(query.resolutionStatus);
  const reviewStatus = query.reviewStatus == null || query.reviewStatus === ''
    ? undefined
    : String(query.reviewStatus);
  const severity = query.severity == null || query.severity === '' ? undefined : String(query.severity);
  const anchorKind = query.anchorKind == null || query.anchorKind === ''
    ? undefined
    : String(query.anchorKind);
  if (status && !['open', 'resolved', 'approved', 'changes_requested', 'expired'].includes(status)) {
    throw collaborationGatewayError('collaboration_review_filter_invalid', '评论状态筛选无效', 400);
  }
  if (resolutionStatus && !isReviewResolutionStatus(resolutionStatus)) {
    throw collaborationGatewayError('collaboration_review_filter_invalid', '评论解决状态筛选无效', 400);
  }
  if (reviewStatus && !isReviewLifecycleStatus(reviewStatus)) {
    throw collaborationGatewayError('collaboration_review_filter_invalid', '评审生命周期筛选无效', 400);
  }
  if (severity && !['low', 'normal', 'high', 'blocking'].includes(severity)) {
    throw collaborationGatewayError('collaboration_review_filter_invalid', '评论严重度筛选无效', 400);
  }
  if (anchorKind && !['canvas', 'node', 'edge', 'asset', 'video'].includes(anchorKind)) {
    throw collaborationGatewayError('collaboration_review_filter_invalid', '评论锚点筛选无效', 400);
  }
  const createdBy = query.createdBy == null || query.createdBy === ''
    ? undefined
    : String(query.createdBy).toLowerCase();
  const mentionedMemberId = query.mentionedMemberId == null || query.mentionedMemberId === ''
    ? undefined
    : String(query.mentionedMemberId).toLowerCase();
  if ((createdBy && !isCommonOperationUuid(createdBy))
    || (mentionedMemberId && !isCommonOperationUuid(mentionedMemberId))) {
    throw collaborationGatewayError('collaboration_review_filter_invalid', '评论成员筛选无效', 400);
  }
  return {
    projectId: session.projectId,
    canvasId: session.canvasId,
    ...(status && status !== 'expired' ? { status } : {}),
    ...(resolutionStatus ? { resolutionStatus } : {}),
    ...(reviewStatus ? { reviewStatus } : {}),
    ...(status === 'expired' ? { approvalExpired: true } : {}),
    ...(severity ? { severity } : {}),
    ...(anchorKind ? { anchorKind } : {}),
    ...(createdBy ? { createdBy } : {}),
    ...(mentionedMemberId ? { mentionedMemberId } : {}),
    ...(optionalBooleanQuery(query.unresolved, '未解决筛选') === undefined
      ? {}
      : { unresolved: optionalBooleanQuery(query.unresolved, '未解决筛选') }),
    ...(status === 'expired' || optionalBooleanQuery(query.approvalExpired, '审批过期筛选') === undefined
      ? {}
      : { approvalExpired: optionalBooleanQuery(query.approvalExpired, '审批过期筛选') }),
    limit,
    offset,
  };
}

function sendPublicHostArtifactForbidden(res) {
  return res.status(403).json({
    success: false,
    code: 'collaboration_host_artifact_forbidden',
    error: '主机产物提交不可通过公开协作端点执行',
  });
}

function sendCollaborationTextError(res, error) {
  const capacityError = translateProjectDatabaseStorageCapacityError(error, {
    operation: 'collaboration.text',
  });
  if (capacityError?.code === 'project_database_storage_capacity_exceeded') {
    return sendCanvasPatchError(res, capacityError, {
      fallbackCode: 'collaboration_text_internal_error',
      fallbackMessage: '协同文本请求处理失败',
    });
  }
  const status = Number.isInteger(Number(error?.status))
    && Number(error.status) >= 400 && Number(error.status) <= 599
    ? Number(error.status)
    : 500;
  const safeCode = typeof error?.code === 'string'
    && /^collaboration_text_[a-z0-9_]+$/.test(error.code)
    ? error.code
    : 'collaboration_text_internal_error';
  const body = {
    success: false,
    code: safeCode,
    error: status < 500 && typeof error?.message === 'string'
      ? error.message.slice(0, 500)
      : '协同文本请求处理失败',
  };
  if (status < 500 && error?.details && typeof error.details === 'object') {
    body.details = publicCollaborationCanvasValue(error.details);
  }
  return res.status(status).json(body);
}

function exactObjectKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw collaborationGatewayError(
      'collaboration_subflow_plan_intent_invalid',
      `${label} 必须是普通对象`,
      400,
    );
  }
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => !expectedKeys.includes(key))
    || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw collaborationGatewayError(
      'collaboration_subflow_plan_intent_invalid',
      `${label} 字段无效`,
      400,
    );
  }
  return value;
}

function compareCanonicalText(left, right) {
  const first = String(left);
  const second = String(right);
  return first < second ? -1 : first > second ? 1 : 0;
}

function canonicalSubflowMappingIntent(raw) {
  const intent = exactObjectKeys(raw, [
    'instanceUid',
    'targetDefinitionVersion',
    'portMappings',
    'parameterMappings',
  ], '子工作流升级映射意图');
  if (!isCommonOperationUuid(intent.instanceUid)) {
    throw collaborationGatewayError(
      'collaboration_subflow_plan_intent_invalid',
      '子工作流实例稳定身份无效',
      400,
    );
  }
  if (!Number.isSafeInteger(intent.targetDefinitionVersion)
    || intent.targetDefinitionVersion < 1) {
    throw collaborationGatewayError(
      'collaboration_subflow_plan_intent_invalid',
      '目标子工作流版本无效',
      400,
    );
  }
  if (!Array.isArray(intent.portMappings) || intent.portMappings.length > 500
    || !Array.isArray(intent.parameterMappings) || intent.parameterMappings.length > 500) {
    throw collaborationGatewayError(
      'collaboration_subflow_plan_intent_invalid',
      '子工作流升级映射超过安全上限',
      400,
    );
  }
  const portMappings = intent.portMappings.map((rawMapping) => {
    const mapping = exactObjectKeys(rawMapping, [
      'direction',
      'fromPortEntityUid',
      'toPortEntityUid',
    ], '端口映射');
    if (!['input', 'output'].includes(mapping.direction)
      || !isCommonOperationUuid(mapping.fromPortEntityUid)
      || (mapping.toPortEntityUid !== null && !isCommonOperationUuid(mapping.toPortEntityUid))) {
      throw collaborationGatewayError(
        'collaboration_subflow_plan_intent_invalid',
        '端口映射无效',
        400,
      );
    }
    return {
      direction: mapping.direction,
      fromPortEntityUid: String(mapping.fromPortEntityUid).toLowerCase(),
      toPortEntityUid: mapping.toPortEntityUid == null
        ? null
        : String(mapping.toPortEntityUid).toLowerCase(),
    };
  }).sort((left, right) => (
    compareCanonicalText(left.direction, right.direction)
      || compareCanonicalText(left.fromPortEntityUid, right.fromPortEntityUid)
      || compareCanonicalText(left.toPortEntityUid || '', right.toPortEntityUid || '')
  ));
  const parameterMappings = intent.parameterMappings.map((rawMapping) => {
    const mapping = exactObjectKeys(rawMapping, [
      'fromParameterEntityUid',
      'toParameterEntityUid',
    ], '参数映射');
    if (!isCommonOperationUuid(mapping.fromParameterEntityUid)
      || (mapping.toParameterEntityUid !== null && !isCommonOperationUuid(mapping.toParameterEntityUid))) {
      throw collaborationGatewayError(
        'collaboration_subflow_plan_intent_invalid',
        '参数映射无效',
        400,
      );
    }
    return {
      fromParameterEntityUid: String(mapping.fromParameterEntityUid).toLowerCase(),
      toParameterEntityUid: mapping.toParameterEntityUid == null
        ? null
        : String(mapping.toParameterEntityUid).toLowerCase(),
    };
  }).sort((left, right) => (
    compareCanonicalText(left.fromParameterEntityUid, right.fromParameterEntityUid)
      || compareCanonicalText(left.toParameterEntityUid || '', right.toParameterEntityUid || '')
  ));
  return {
    instanceUid: String(intent.instanceUid).toLowerCase(),
    targetDefinitionVersion: intent.targetDefinitionVersion,
    portMappings,
    parameterMappings,
  };
}

function publicCommonDomainMutationResult(result) {
  if (!result || !Array.isArray(result.results) || !Array.isArray(result.commonBatch?.operations)) {
    return publicCanvasMutationResult(result);
  }
  const results = result.results.map((item, index) => {
    if (result.commonBatch.operations[index]?.type !== 'subflow.instance.upgrade'
      || !item || typeof item !== 'object' || Array.isArray(item)) return item;
    return {
      instanceEntityUid: item.instanceEntityUid,
      definitionEntityUid: item.definitionEntityUid,
      fromVersion: item.fromVersion,
      toVersion: item.toVersion,
      fromDefinitionRevision: item.fromDefinitionRevision,
      toDefinitionRevision: item.toDefinitionRevision,
      upgradePlanDigest: item.upgradePlanDigest,
      revision: item.revision,
      instanceEntityRevision: item.instanceEntityRevision,
      edgePatches: Array.isArray(item.edgePatches) ? item.edgePatches : [],
      disconnectedEdgeEntityUids: Array.isArray(item.disconnectedEdgeEntityUids)
        ? item.disconnectedEdgeEntityUids
        : [],
      disconnectedEdges: Array.isArray(item.disconnectedEdges) ? item.disconnectedEdges : [],
      discardedOverrides: Array.isArray(item.discardedOverrides) ? item.discardedOverrides : [],
    };
  });
  return publicCanvasMutationResult({ ...result, results });
}

function reviewEntityIdentity(entity) {
  return String(entity?.entityUid || entity?.id || '');
}

function reviewEntityDigest(entity) {
  return crypto.createHash('sha256')
    .update(stableJson(publicCollaborationCanvasValue(entity)), 'utf8')
    .digest('hex');
}

function boundedReviewDocumentDiff(before, after) {
  const compareCollection = (beforeItems, afterItems) => {
    const beforeMap = new Map((Array.isArray(beforeItems) ? beforeItems : [])
      .map((entity) => [reviewEntityIdentity(entity), entity])
      .filter(([identity]) => identity));
    const afterMap = new Map((Array.isArray(afterItems) ? afterItems : [])
      .map((entity) => [reviewEntityIdentity(entity), entity])
      .filter(([identity]) => identity));
    const added = [...afterMap.keys()].filter((identity) => !beforeMap.has(identity)).sort();
    const removed = [...beforeMap.keys()].filter((identity) => !afterMap.has(identity)).sort();
    const changed = [...beforeMap.keys()].filter((identity) => (
      afterMap.has(identity)
        && reviewEntityDigest(beforeMap.get(identity)) !== reviewEntityDigest(afterMap.get(identity))
    )).sort();
    const limit = 500;
    return {
      added: added.slice(0, limit),
      removed: removed.slice(0, limit),
      changed: changed.slice(0, limit),
      counts: { added: added.length, removed: removed.length, changed: changed.length },
      truncated: added.length > limit || removed.length > limit || changed.length > limit,
    };
  };
  return {
    fromRevision: Number(before?.revision) || null,
    toRevision: Number(after?.revision) || null,
    nodes: compareCollection(before?.nodes, after?.nodes),
    edges: compareCollection(before?.edges, after?.edges),
    viewportChanged: reviewEntityDigest(before?.viewport || {}) !== reviewEntityDigest(after?.viewport || {}),
  };
}

const REVIEW_PROMPT_FIELD_PATTERN = /(?:prompt|instruction)/i;
const REVIEW_VISIBILITY_MAX_DEPTH = 32;
// The public canvas sanitizer accepts up to 1,000,000 visited values. Review
// redaction runs after that sanitizer and must not silently replace an otherwise
// valid large canvas merely because its historical local budget was smaller.
const REVIEW_VISIBILITY_MAX_NODES = 1_000_000;
const REVIEW_PARAMETER_CONTEXT_NONE = 0;
const REVIEW_PARAMETER_CONTEXT_DIRECT = 1;
const REVIEW_PARAMETER_CONTEXT_EXPLICIT = 2;
const REVIEW_PARAMETER_CONTEXT_OUTPUT_METADATA = 3;
const REVIEW_MODEL_IDENTITY_FIELDS = new Set([
  'apimodel',
  'checkpoint',
  'checkpointname',
  'ckpt',
  'ckptname',
  'clipname',
  'clipvisionname',
  'controlnetname',
  'lora',
  'loraname',
  'model',
  'modelid',
  'modelname',
  'provider',
  'providerid',
  'providermodel',
  'providername',
  'providersource',
  'sampler',
  'samplername',
  'stylemodelname',
  'unetname',
  'upscalemodel',
  'vae',
  'vaename',
]);
const REVIEW_MODEL_PARAMETER_CONTAINER_PATTERN = /^(?:parameters?|parameteroverrides?|providerparams?|modelparams?|generation(?:config|settings|options|params|parameters)?|inference(?:config|settings|options|params|parameters)?|sampling(?:config|settings|options|params|parameters)?)$/i;
const REVIEW_MODEL_PARAMETER_CONTEXT_PATTERN = /^(?:config|generation|inference|input|options|params|parameters|providerparams|request|settings)$/i;
const REVIEW_OUTPUT_METADATA_CONTEXT_FIELDS = new Set([
  'assetmetadata',
  'filemetadata',
  'mediametadata',
  'outputmetadata',
  'resultmetadata',
]);
// Direct node.data fields are intentionally exact and bounded. Ambiguous media
// facts such as width/height/duration/format are excluded here because real
// canvas nodes also store their rendered-output metadata alongside inputs.
// Those same names are still hidden inside explicit request/config/params
// contexts below.
const REVIEW_DIRECT_MODEL_PARAMETER_FIELDS = new Set([
  'algorithm',
  'aspectratio',
  'batchsize',
  'beamsearch',
  'cfg',
  'cfgscale',
  'count',
  'creativity',
  'denoise',
  'denoisestrength',
  'dosample',
  'earlystopping',
  'enhance',
  'frequencypenalty',
  'guidance',
  'guidancescale',
  'imagemode',
  'inferencesteps',
  'language',
  'lengthpenalty',
  'loop',
  'loras',
  'lorastrength',
  'maxcompletiontokens',
  'maxnewtokens',
  'maxoutputtokens',
  'maxtokens',
  'minp',
  'motion',
  'n',
  'norepeatngramsize',
  'numbeams',
  'numframes',
  'numimages',
  'numinferencesteps',
  'numoutputs',
  'numsteps',
  'pitch',
  'presencepenalty',
  'quality',
  'ratio',
  'repetitionpenalty',
  'resolution',
  'responseformat',
  'safety',
  'safetytolerance',
  'sampleshift',
  'scheduler',
  'seed',
  'size',
  'sizelevel',
  'speed',
  'steps',
  'stop',
  'stopsequence',
  'stopsequences',
  'strength',
  'style',
  'stylization',
  'temperature',
  'topk',
  'topp',
  'upsample',
  'voice',
  'watermark',
  'weight',
]);
const REVIEW_EXPLICIT_MODEL_PARAMETER_FIELDS = new Set([
  ...REVIEW_DIRECT_MODEL_PARAMETER_FIELDS,
  'duration',
  'format',
  'fps',
  'framerate',
  'frames',
  'height',
  'outputformat',
  'seconds',
  'width',
]);

function normalizedReviewVisibilityKey(key) {
  return String(key || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function reviewModelParameterFieldHidden(field, parameterContext = REVIEW_PARAMETER_CONTEXT_NONE) {
  const normalized = normalizedReviewVisibilityKey(field);
  if (!normalized) return false;
  if (REVIEW_MODEL_IDENTITY_FIELDS.has(normalized)
    || REVIEW_MODEL_PARAMETER_CONTAINER_PATTERN.test(normalized)) return true;
  if (parameterContext === REVIEW_PARAMETER_CONTEXT_EXPLICIT) {
    return REVIEW_EXPLICIT_MODEL_PARAMETER_FIELDS.has(normalized);
  }
  if (parameterContext === REVIEW_PARAMETER_CONTEXT_DIRECT) {
    return REVIEW_DIRECT_MODEL_PARAMETER_FIELDS.has(normalized);
  }
  return false;
}

function reviewValueLooksLikeCanvasNode(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && value.data
      && typeof value.data === 'object'
      && !Array.isArray(value.data)
      && typeof value.type === 'string'
      && (typeof value.id === 'string' || typeof value.entityUid === 'string'),
  );
}

function reviewValueLooksLikeNodeOperation(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && ['node.add', 'node.patch', 'node.restore'].includes(String(value.type || ''))
      && value.payload
      && typeof value.payload === 'object'
      && !Array.isArray(value.payload),
  );
}

function reviewValueCarriesModelIdentity(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).some((key) => {
        const normalized = normalizedReviewVisibilityKey(key);
        return REVIEW_MODEL_IDENTITY_FIELDS.has(normalized)
          || REVIEW_MODEL_PARAMETER_CONTAINER_PATTERN.test(normalized);
      }),
  );
}

function redactReviewVisibility(
  value,
  policy,
  depth = 0,
  state = null,
  parameterContext = REVIEW_PARAMETER_CONTEXT_NONE,
) {
  const context = state || { remaining: REVIEW_VISIBILITY_MAX_NODES, seen: new WeakSet() };
  if (context.remaining <= 0 || depth > REVIEW_VISIBILITY_MAX_DEPTH) return '[truncated]';
  context.remaining -= 1;
  if (value == null || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  if (context.seen.has(value)) return '[cycle]';
  context.seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => redactReviewVisibility(
      item,
      policy,
      depth + 1,
      context,
      parameterContext,
    ));
    context.seen.delete(value);
    return output;
  }
  const output = {};
  const currentParameterContext = parameterContext === REVIEW_PARAMETER_CONTEXT_NONE
    && reviewValueCarriesModelIdentity(value)
    ? REVIEW_PARAMETER_CONTEXT_EXPLICIT
    : parameterContext;
  const canvasNode = reviewValueLooksLikeCanvasNode(value);
  const nodeOperation = reviewValueLooksLikeNodeOperation(value);
  const declaredField = normalizedReviewVisibilityKey(
    value.field ?? value.fieldName ?? value.parameterKey ?? '',
  );
  const hideDeclaredField = (policy.hidePrompts === true
      && REVIEW_PROMPT_FIELD_PATTERN.test(declaredField))
    || (policy.hideModelParameters === true
      && reviewModelParameterFieldHidden(declaredField, REVIEW_PARAMETER_CONTEXT_EXPLICIT));
  const declaredFieldContentKeys = new Set([
    'body',
    'content',
    'data',
    'payload',
    'snapshot',
    'text',
    'update',
    'value',
  ]);
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizedReviewVisibilityKey(key);
    const hidePrompt = policy.hidePrompts === true
      && REVIEW_PROMPT_FIELD_PATTERN.test(normalized);
    const hideModel = policy.hideModelParameters === true
      && reviewModelParameterFieldHidden(normalized, currentParameterContext);
    let childParameterContext = currentParameterContext;
    if (REVIEW_OUTPUT_METADATA_CONTEXT_FIELDS.has(normalized)) {
      childParameterContext = REVIEW_PARAMETER_CONTEXT_OUTPUT_METADATA;
    }
    if (REVIEW_MODEL_PARAMETER_CONTEXT_PATTERN.test(normalized)) {
      childParameterContext = REVIEW_PARAMETER_CONTEXT_EXPLICIT;
    } else if ((canvasNode && normalized === 'data')
      || (nodeOperation && normalized === 'payload')) {
      childParameterContext = REVIEW_PARAMETER_CONTEXT_DIRECT;
    }
    output[key] = hidePrompt || hideModel
      || (hideDeclaredField && declaredFieldContentKeys.has(normalized))
      ? '[由主机隐藏]'
      : redactReviewVisibility(item, policy, depth + 1, context, childParameterContext);
  }
  context.seen.delete(value);
  return output;
}

function reviewThreadExportRecord(thread) {
  return {
    id: thread.id,
    entityUid: thread.entityUid,
    canvasRevision: thread.canvasRevision,
    currentCanvasRevision: thread.currentCanvasRevision,
    resolutionStatus: thread.resolutionStatus,
    reviewStatus: thread.reviewStatus,
    effectiveReviewStatus: thread.effectiveReviewStatus,
    status: thread.status,
    effectiveStatus: thread.effectiveStatus,
    approvalExpired: thread.approvalExpired,
    severity: thread.severity,
    anchor: thread.anchor,
    author: thread.author,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    comments: (Array.isArray(thread.comments) ? thread.comments : []).map((comment) => ({
      id: comment.id,
      entityUid: comment.entityUid,
      parentEntityUid: comment.parentEntityUid,
      body: comment.body,
      author: comment.author,
      mentions: comment.mentions,
      attachments: (Array.isArray(comment.attachments) ? comment.attachments : []).map((attachment) => (
        attachment.available === true && attachment.asset
          ? {
            available: true,
            assetId: attachment.assetId,
            assetUid: attachment.assetUid,
            assetContentRevision: attachment.assetContentRevision,
            contentHash: attachment.contentHash,
            filename: attachment.asset.filename,
            kind: attachment.asset.kind,
          }
          : { available: false }
      )),
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    })),
  };
}

function publicReviewDomainEventResult(operation, result) {
  return publicCollaborationCanvasValue({
    threadEntityUid: result?.thread?.entityUid || operation?.payload?.threadUid || null,
    commentEntityUid: result?.comment?.entityUid
      || operation?.payload?.commentUid
      || operation?.payload?.initialComment?.commentUid
      || null,
    threadRevision: result?.thread?.revision || result?.threadRevision || null,
  });
}

function reviewThreadsMarkdown(threads, canvasId) {
  const lines = [`# 审片汇总 · ${String(canvasId)}`, ''];
  for (const thread of threads) {
    lines.push(`## ${String(thread.severity || 'normal')} · ${String(thread.effectiveReviewStatus || thread.reviewStatus || 'in_review')}`);
    lines.push('');
    lines.push(`- 锚点：${String(thread.anchor?.kind || 'canvas')}`);
    lines.push(`- 创建者：${String(thread.author?.displayName || thread.createdBy || '未知成员')}`);
    lines.push(`- 画布版本：${Number(thread.canvasRevision) || 0} → ${Number(thread.currentCanvasRevision) || 0}`);
    lines.push(`- 线程：${String(thread.resolutionStatus || 'open')}`);
    if (thread.approvalExpired) lines.push('- 审批：已过期');
    lines.push('');
    for (const comment of Array.isArray(thread.comments) ? thread.comments : []) {
      const author = String(comment.author?.displayName || comment.createdBy || '未知成员');
      const body = String(comment.body || '').replace(/\r?\n/g, '\n  ');
      lines.push(`- **${author}**：${body}`);
    }
    lines.push('');
  }
  return lines.join('\n').slice(0, 2 * 1024 * 1024);
}

function isRecoveryGenerationUnavailable(error) {
  return String(error?.code || '') === RECOVERY_GENERATION_UNAVAILABLE_CODE
    && Number(error?.statusCode ?? error?.status) === 503;
}

function sendRecoveryGenerationUnavailable(res) {
  res.set('Cache-Control', 'no-store');
  res.setHeader('Retry-After', String(RECOVERY_GENERATION_RETRY_AFTER_MS / 1_000));
  return res.status(503).json({
    success: false,
    code: RECOVERY_GENERATION_UNAVAILABLE_CODE,
    error: '项目数据库恢复代次暂时不可用，请稍后重新连接',
    retryable: true,
  });
}

function sendCanvasPatchError(res, error, options = {}) {
  if (isRecoveryGenerationUnavailable(error)) {
    return sendRecoveryGenerationUnavailable(res);
  }
  const mapped = mapCanvasMutationError(error, options);
  return res.status(mapped.status).json(mapped.body);
}

function assertEquivalentRunIntentReplay(existing, expected, options = {}) {
  const conflictingFields = [];
  const compareText = (field) => {
    const left = existing?.[field] == null ? null : String(existing[field]);
    const right = expected?.[field] == null ? null : String(expected[field]);
    if (left !== right) conflictingFields.push(field);
  };
  const compareNumber = (field) => {
    const left = existing?.[field] == null ? null : Number(existing[field]);
    const right = expected?.[field] == null ? null : Number(expected[field]);
    if (left !== right) conflictingFields.push(field);
  };

  for (const field of ['projectId', 'requestedBy', 'canvasId']) compareText(field);
  compareNumber('canvasRevision');
  if (stableJson(existing?.nodeIds) !== stableJson(expected?.nodeIds)) conflictingFields.push('nodeIds');
  if (options.includeAuthority === true) {
    for (const field of ['provider', 'model']) compareText(field);
    compareNumber('estimatedCost');
    if ((existing?.estimatedCostKnown === true) !== (expected?.estimatedCostKnown === true)) {
      conflictingFields.push('estimatedCostKnown');
    }
    if (stableJson(existing?.executionAuthority) !== stableJson(expected?.executionAuthority)) {
      conflictingFields.push('executionAuthority');
    }
  }

  if (conflictingFields.length > 0) {
    throw new RunIntentAuthorityError(
      'intent_idempotency_conflict',
      '运行幂等键已绑定其他运行请求',
      { conflictingFields: [...new Set(conflictingFields)].sort() },
      409,
    );
  }
  return existing;
}

function scopeCanvasPatch(rawPatch, scope) {
  const source = rawPatch && typeof rawPatch === 'object' && !Array.isArray(rawPatch) ? rawPatch : {};
  const patch = {
    ...source,
    operations: Array.isArray(source.operations) ? source.operations.map((rawOperation) => ({
      ...(rawOperation && typeof rawOperation === 'object' && !Array.isArray(rawOperation) ? rawOperation : {}),
      projectId: scope.projectId,
      canvasId: scope.canvasId,
      actorId: scope.actorId,
      sessionId: scope.sessionId,
    })) : source.operations,
  };
  for (const key of ['projectId', 'canvasId', 'actorId', 'sessionId']) delete patch[key];
  return patch;
}

function canvasPatchAuthorityForSession(session) {
  return {
    source: 'collaboration',
    role: String(session?.role || ''),
    capabilities: Array.isArray(session?.capabilities) ? session.capabilities.map(String) : [],
  };
}

function publicCanvasPatchEvent(result, fallbackPatchId, fallbackStatus, actor) {
  const record = result?.patch && typeof result.patch === 'object' ? result.patch : {};
  const patchId = String(record.patchId || result?.patchId || fallbackPatchId || '').slice(0, 160);
  const revisionValue = result?.revision
    ?? result?.document?.revision
    ?? record.revertedRevision
    ?? record.appliedRevision
    ?? record.revision;
  const revision = Number.isSafeInteger(Number(revisionValue)) ? Number(revisionValue) : 0;
  const status = String(record.status || result?.status || fallbackStatus || 'applied').slice(0, 40);
  return { type: 'canvas.patch', patchId, revision, status, actor: String(actor || '').slice(0, 160) };
}

function publicSubflowRevisionConflict(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return publicCollaborationCanvasValue(value);
  }
  const output = publicCollaborationCanvasValue({ ...value, definition: null });
  if (value.definition && typeof value.definition === 'object' && !Array.isArray(value.definition)) {
    output.definition = publicSubflowDefinition(value.definition);
  }
  return output;
}

function comparableFilesystemPath(value) {
  const normalized = path.normalize(String(value || ''));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function filesystemPathWithin(root, candidate) {
  const normalizedRoot = comparableFilesystemPath(root);
  const normalizedCandidate = comparableFilesystemPath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}
const DERIVED_URL_FIELDS = new Set([
  'previewUrl', 'thumbnailUrl', 'firstFrameUrl', 'lastFrameUrl', 'contactSheetUrl',
  'proxyUrl', 'videoProxyUrl', 'audioProxyUrl', 'waveformUrl', 'modelPreviewUrl', 'keyframeUrls',
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function collaborationInviteBudgetKey(value) {
  return crypto.createHash('sha256').update(String(value || '').trim(), 'utf8').digest('hex');
}

function createTieredCollaborationLimiters({
  ipLimit,
  sessionLimit,
  windowMs,
  maxBuckets,
  now,
}) {
  return Object.freeze({
    ip: createWeightedWindowLimiter({ limit: ipLimit, windowMs, maxBuckets, now }),
    session: createWeightedWindowLimiter({ limit: sessionLimit, windowMs, maxBuckets, now }),
  });
}

function normalizeNetworkAddress(value) {
  let address = String(value || '').trim();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  address = address.replace(/^::ffff:/i, '');
  const zoneIndex = address.indexOf('%');
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  return net.isIP(address) ? address.toLowerCase() : '';
}

function normalizeTrustedProxyAddresses(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(',');
  return new Set(entries.map(normalizeNetworkAddress).filter(Boolean));
}

function requestClientAddress(request, trustedProxyAddresses = new Set()) {
  const socketAddress = normalizeNetworkAddress(
    request?.socket?.remoteAddress || request?.connection?.remoteAddress,
  ) || 'unknown';
  if (!trustedProxyAddresses.has(socketAddress)) return socketAddress;
  const chain = String(request?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map(normalizeNetworkAddress)
    .filter(Boolean);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (!trustedProxyAddresses.has(chain[index])) return chain[index];
  }
  return chain[0] || socketAddress;
}

function createFixedWindowLimiter({ limit, windowMs, maxBuckets = DEFAULT_RATE_LIMIT_MAX_BUCKETS, now = Date.now }) {
  const requestLimit = boundedInteger(limit, 1, 1, 1_000_000);
  const duration = boundedInteger(windowMs, 60_000, 1, 24 * 60 * 60 * 1000);
  const capacity = boundedInteger(maxBuckets, DEFAULT_RATE_LIMIT_MAX_BUCKETS, 1, 1_000_000);
  const buckets = new Map();
  let nextSweepAt = 0;

  const prune = (timestamp = now()) => {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= timestamp) buckets.delete(key);
    }
    nextSweepAt = timestamp + Math.min(duration, 60_000);
    return buckets.size;
  };

  const consume = (rawKey) => {
    const key = String(rawKey || 'unknown');
    const timestamp = now();
    if (timestamp >= nextSweepAt || buckets.size >= capacity) prune(timestamp);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= timestamp) {
      if (buckets.size >= capacity) {
        return { allowed: false, retryAfterMs: duration, reason: 'bucket_capacity' };
      }
      bucket = { count: 0, resetAt: timestamp + duration };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= requestLimit,
      retryAfterMs: Math.max(1, bucket.resetAt - timestamp),
      reason: bucket.count <= requestLimit ? null : 'rate_exceeded',
    };
  };

  return {
    consume,
    prune,
    get size() { return buckets.size; },
  };
}

function rateLimiter({ limit, windowMs, maxBuckets, keyResolver, now }) {
  const limiter = createFixedWindowLimiter({ limit, windowMs, maxBuckets, now });
  const middleware = (req, res, next) => {
    const result = limiter.consume(
      typeof keyResolver === 'function'
        ? keyResolver(req)
        : requestClientAddress(req),
    );
    if (result.allowed) return next();
    return sendCollaborationRateLimit(res, { ...result, dimension: 'ip' });
  };
  middleware.limiter = limiter;
  return middleware;
}

function publicRunState(run) {
  return {
    id: String(run.id),
    canvasId: String(run.canvasId),
    canvasRevision: Number(run.canvasRevision) || 0,
    status: String(run.status),
    parentRunId: run.parentRunId ? String(run.parentRunId) : null,
    initiatorId: String(run.initiatorId || 'host'),
    createdAt: Number(run.createdAt) || 0,
    startedAt: run.startedAt == null ? null : Number(run.startedAt),
    finishedAt: run.finishedAt == null ? null : Number(run.finishedAt),
  };
}

function publicNodeRunState(runId, nodeRun, outputRefs = nodeRun.outputRefs) {
  return {
    id: String(nodeRun.id),
    runId: String(runId),
    nodeId: String(nodeRun.originalNodeId || nodeRun.nodeId),
    parentNodeRunId: nodeRun.parentNodeRunId ? String(nodeRun.parentNodeRunId) : null,
    status: String(nodeRun.status),
    outputRefs: Array.isArray(outputRefs) ? outputRefs.map(String).slice(0, 1000) : [],
    updatedAt: Number(nodeRun.updatedAt) || Date.now(),
  };
}

function publicRunOutputAssets(assets) {
  return (assets || []).slice(0, 1000).map((asset) => ({
    id: String(asset.id),
    kind: String(asset.kind || 'other'),
    filename: String(asset.filename || 'asset').slice(0, 300),
    mimeType: String(asset.mimeType || 'application/octet-stream'),
    mediaUrl: `/api/collab/assets/${encodeURIComponent(String(asset.id))}/media`,
  }));
}

function parseRangeHeader(header, size) {
  const match = String(header || '').match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start == null && end != null) {
    start = Math.max(0, size - end);
    end = size - 1;
  }
  if (start == null) return null;
  if (end == null) end = size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function parseUploadContentRange(value) {
  const match = String(value || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  if (!match) throw uploadError('asset_upload_range_invalid', 'Content-Range 格式无效', 416);
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) {
    throw uploadError('asset_upload_range_invalid', 'Content-Range 数值无效', 416);
  }
  return { start, end, total };
}

function publicUploadSession(session) {
  if (!session) return null;
  const receivedRecords = Array.isArray(session.receivedChunks) ? session.receivedChunks : [];
  const receivedChunks = receivedRecords.map((entry) => Number(entry?.index ?? entry)).filter(Number.isSafeInteger).sort((a, b) => a - b);
  const received = new Set(receivedChunks);
  const missingChunks = session.status === 'completed'
    ? []
    : Array.from({ length: Math.max(0, Number(session.chunkCount) || 0) }, (_, index) => index)
      .filter((index) => !received.has(index));
  return {
    id: session.id,
    projectId: session.projectId,
    filename: session.filename,
    mimeType: session.mimeType,
    expectedSize: session.expectedSize,
    expectedHash: session.expectedHash,
    chunkSize: session.chunkSize,
    chunkCount: session.chunkCount,
    receivedBytes: session.receivedBytes,
    reservedBytes: session.reservedBytes,
    receivedChunks,
    missingChunks,
    status: session.status,
    revision: session.revision,
    assetId: session.assetId,
    contentHash: session.contentHash,
    deduplicated: Boolean(session.deduplicated),
    errorCode: session.errorCode ? safeUploadErrorCode({ code: session.errorCode }) : null,
    errorMessage: session.errorMessage
      ? safeUploadErrorMessage({ code: session.errorCode, message: session.errorMessage })
      : null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    completedAt: session.completedAt,
  };
}

function publicUploadPersistenceWarning(warning) {
  if (!warning || warning.code !== 'asset_upload_post_commit_capacity' || warning.committed !== true) return null;
  const rawReason = String(warning.reason || '');
  const rawPhase = String(warning.phase || '');
  return {
    code: 'asset_upload_post_commit_capacity',
    committed: true,
    phase: ASSET_UPLOAD_POST_COMMIT_PHASES.has(rawPhase) ? rawPhase : 'finalization',
    reason: PUBLIC_PROJECT_DATABASE_CAPACITY_REASONS.has(rawReason) ? rawReason : 'sqlite-full',
    retryable: warning.retryable === true,
  };
}

function mimeTypeForFilename(filename, fallback = 'application/octet-stream') {
  const extension = path.extname(String(filename || '')).slice(1).toLowerCase();
  return ({
    mp4: 'video/mp4', webm: 'video/webm', webp: 'image/webp', png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', wav: 'audio/wav',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', txt: 'text/plain', json: 'application/json',
  })[extension] || fallback;
}

function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  });
  next();
}

function secureRequest(req) {
  // Express only derives req.secure from X-Forwarded-Proto when the immediate
  // peer matches the explicitly configured trust-proxy function.
  return Boolean(req.secure);
}

function sessionCookie(token, req) {
  const secure = secureRequest(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}${secure}`;
}

function clearSessionCookie(req) {
  const secure = secureRequest(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function sameOriginUpgrade(request, allowedOrigins) {
  const origin = String(request.headers.origin || '');
  return originAllowed(origin, allowedOrigins);
}

function normalizeCollaborationPresence(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const presence = {};
  const cursor = source.cursor && typeof source.cursor === 'object' && !Array.isArray(source.cursor)
    ? source.cursor
    : null;
  if (cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) {
    presence.cursor = {
      x: Math.max(-10_000_000, Math.min(10_000_000, Number(cursor.x))),
      y: Math.max(-10_000_000, Math.min(10_000_000, Number(cursor.y))),
    };
  }
  if (Array.isArray(source.selectedNodeIds)) {
    presence.selectedNodeIds = [...new Set(source.selectedNodeIds
      .filter((item) => typeof item === 'string' && item.length > 0 && item.length <= 240)
      .slice(0, 100))];
  }
  const drag = source.drag && typeof source.drag === 'object' && !Array.isArray(source.drag)
    ? source.drag
    : null;
  if (drag
    && typeof drag.nodeId === 'string'
    && drag.nodeId.length > 0
    && drag.nodeId.length <= 240
    && typeof drag.dragId === 'string'
    && drag.dragId.length > 0
    && drag.dragId.length <= 240
    && Number.isSafeInteger(drag.seq)
    && drag.seq >= 0
    && drag.position
    && typeof drag.position === 'object'
    && !Array.isArray(drag.position)
    && Number.isFinite(drag.position.x)
    && Number.isFinite(drag.position.y)) {
    presence.drag = {
      nodeId: drag.nodeId,
      dragId: drag.dragId,
      seq: drag.seq,
      position: {
        x: Math.max(-10_000_000, Math.min(10_000_000, Number(drag.position.x))),
        y: Math.max(-10_000_000, Math.min(10_000_000, Number(drag.position.y))),
      },
    };
  }
  return presence;
}

function parseHttpAfterRevision(value) {
  if (value == null || value === '') return 0;
  if (Array.isArray(value) || typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function parseRecoveryGeneration(value) {
  if (value == null || value === '') return { valid: true, generation: null };
  if (Array.isArray(value) || typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return { valid: false, generation: null };
  }
  return { valid: true, generation: value.toLowerCase() };
}

function collaborationSessionHeartbeatIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw collaborationGatewayError(
      'collaboration_session_heartbeat_invalid',
      '协作会话心跳必须提供精确身份对象',
      400,
    );
  }
  const keys = Object.keys(value);
  if (keys.length !== COLLABORATION_SESSION_HEARTBEAT_FIELDS.length
    || keys.some((key) => !COLLABORATION_SESSION_HEARTBEAT_FIELDS.includes(key))
    || COLLABORATION_SESSION_HEARTBEAT_FIELDS.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw collaborationGatewayError(
      'collaboration_session_heartbeat_invalid',
      '协作会话心跳身份字段不完整',
      400,
    );
  }
  for (const field of ['sessionId', 'projectId', 'canvasId', 'memberId']) {
    if (typeof value[field] !== 'string'
      || value[field].length < 1
      || value[field].length > 240
      || value[field].trim() !== value[field]
      || /[\u0000-\u001f\u007f]/.test(value[field])) {
      throw collaborationGatewayError(
        'collaboration_session_heartbeat_invalid',
        '协作会话心跳身份字段无效',
        400,
      );
    }
  }
  if (!Number.isSafeInteger(value.authorizationEpoch) || value.authorizationEpoch < 1) {
    throw collaborationGatewayError(
      'collaboration_session_heartbeat_invalid',
      '协作会话心跳授权版本无效',
      400,
    );
  }
  return {
    sessionId: value.sessionId,
    projectId: value.projectId,
    canvasId: value.canvasId,
    memberId: value.memberId,
    authorizationEpoch: value.authorizationEpoch,
  };
}

function collaborationSessionHeartbeatIdentityMatches(session, expected) {
  return Boolean(session)
    && String(session.id || '') === expected.sessionId
    && String(session.projectId || '') === expected.projectId
    && String(session.canvasId || '') === expected.canvasId
    && String(session.memberId || '') === expected.memberId
    && Number(session.authorizationEpoch) === expected.authorizationEpoch;
}

function isCollaborationSessionHeartbeatPath(req) {
  // `req.path` becomes `/session/heartbeat` while Express is inside the
  // `/api/collab` mounted middleware. `originalUrl` retains the authoritative
  // application path in both mounted and top-level phases.
  const pathname = String(req?.originalUrl || req?.url || req?.path || '')
    .split('?')[0]
    .replace(/\/+$/, '');
  return pathname === '/api/collab/session/heartbeat';
}

function isCollaborationCanvasSyncPath(req) {
  const pathname = String(req?.originalUrl || req?.url || req?.path || '')
    .split('?')[0]
    .replace(/\/+$/, '');
  return /^\/api\/collab\/canvases\/[^/]+\/sync$/.test(pathname);
}

function isSqliteBusyOrLocked(error) {
  return /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/.test(String(error?.code || ''));
}

function sendCollaborationSessionHeartbeatError(res, error) {
  if (sendProjectDatabaseStorageCapacityError(res, error, {
    operation: 'collaboration.session.heartbeat',
  })) return res;
  if (isSqliteBusyOrLocked(error)) {
    res.setHeader('Retry-After', '1');
    return res.status(503).json({
      success: false,
      code: 'collaboration_session_heartbeat_busy',
      error: '协作会话活动时间暂时无法保存，请稍后重试',
      retryable: true,
    });
  }
  if (error?.status === 409
    && error?.code === 'collaboration_session_heartbeat_identity_conflict') {
    return res.status(409).json({
      success: false,
      code: 'collaboration_session_heartbeat_conflict',
      error: '协作会话身份或授权版本已经变化，请先刷新会话',
    });
  }
  if (error?.status === 400 && error?.code === 'collaboration_session_heartbeat_invalid') {
    return res.status(400).json({
      success: false,
      code: error.code,
      error: error.message,
    });
  }
  return res.status(500).json({
    success: false,
    code: 'collaboration_session_heartbeat_failed',
    error: '协作会话活动时间暂未保存',
  });
}

function recoveryGenerationExemptMutationRequest(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
  const pathname = String(req.originalUrl || req.url || '')
    .split('?')[0]
    .replace(/\/+$/, '');
  return pathname === '/api/collab/session/heartbeat'
    || pathname === '/api/collab/session/rotate'
    || pathname === '/api/collab/logout'
    || pathname === '/api/collab/subflow-upgrade-plans'
    || /^\/api\/collab\/canvases\/[^/]+\/agent\/tools$/.test(pathname)
    || /^\/api\/collab\/canvases\/[^/]+\/patches\/preview$/.test(pathname);
}

function exactPublicOperationAcknowledgements(acknowledgements, operations) {
  if (!Array.isArray(acknowledgements)
    || !Array.isArray(operations)
    || acknowledgements.length !== operations.length) {
    throw new Error('canvas operation acknowledgement count mismatch');
  }
  const duplicateStates = new Set(acknowledgements.map((acknowledgement) => acknowledgement?.duplicate));
  if (duplicateStates.size !== 1 || !duplicateStates.has(true) && !duplicateStates.has(false)) {
    throw new Error('canvas operation acknowledgement batch state mismatch');
  }
  return operations.map((operation, index) => {
    const acknowledgement = acknowledgements[index];
    if (!acknowledgement
      || acknowledgement.opId !== operation.opId
      || !Number.isSafeInteger(Number(acknowledgement.revision))
      || Number(acknowledgement.revision) < 1
      || Number(acknowledgement.revision) !== Number(operation.baseRevision) + index + 1
      || typeof acknowledgement.duplicate !== 'boolean') {
      throw new Error('canvas operation acknowledgement identity mismatch');
    }
    return {
      opId: operation.opId,
      projectId: operation.projectId,
      canvasId: operation.canvasId,
      baseRevision: operation.baseRevision,
      revision: Number(acknowledgement.revision),
      actorId: operation.actorId,
      clientSeq: operation.clientSeq,
      type: operation.type,
      payload: operation.payload,
      timestamp: operation.timestamp,
      duplicate: acknowledgement.duplicate,
    };
  });
}

class CollaborationGateway {
  constructor(config, database = null, options = {}) {
    this.config = config;
    this.database = database || getProjectDatabase(config);
    this.applicationLifecycle = createHttpApplicationLifecycle();
    this.previewPipeline = database ? null : getAssetPreviewPipeline(config, this.database);
    this.uploadManager = new AssetUploadManager(config, this.database, { previewPipeline: this.previewPipeline });
    this.applicationLifecycle.trackStandaloneTask(this.uploadManager.startupGcPromise);
    this.auth = new CollaborationAuth(this.database);
    this.textPersistence = new CollaborationTextPersistence(this.database);
    this.executionPolicy = new HostExecutionPolicy(this.database);
    this.server = null;
    this.webSocketServer = null;
    this.connections = new Map();
    this.startedAt = null;
    this.host = null;
    this.port = null;
    this.lifecycleTail = Promise.resolve();
    this.lastLifecycleRequest = null;
    this.runtimeShutdownRequested = false;
    this.webSocketTerminationTimers = new WeakMap();
    this.webSocketHeartbeatTimers = new WeakMap();
    this.subflowUpgradePlans = new Map();
    this.subflowUpgradePlanTtlMs = SUBFLOW_UPGRADE_PLAN_TTL_MS;
    this.subflowUpgradePlanCacheLimit = SUBFLOW_UPGRADE_PLAN_CACHE_LIMIT;
    this.publicSelfCheckChallenges = new PublicSelfCheckChallenges();
    this.lastPublicSelfCheck = null;
    this.publicSelfCheckPromise = null;
    // Derive from an overridden DATA_DIR first so isolated test/runtime configs
    // cannot accidentally inherit the main process' absolute sidecar path.
    const publicExposureFile = config.DATA_DIR
      ? path.join(config.DATA_DIR, 'collaboration-public-exposure.json')
      : String(config.COLLAB_PUBLIC_EXPOSURE_FILE || '').trim()
        || (config.COLLAB_UPLOAD_TEMP_DIR
          ? path.join(path.dirname(config.COLLAB_UPLOAD_TEMP_DIR), 'collaboration-public-exposure.json')
          : '');
    this.publicExposureStore = options.publicExposureStore || new PublicExposureStore({
      filePath: publicExposureFile,
      environmentBaseUrl: config.COLLAB_PUBLIC_BASE_URL,
      fs: options.publicExposureFileSystem,
      now: options.publicExposureNow,
      randomId: options.publicExposureRandomId,
    });
    try {
      this.applyPublicExposureState(this.publicExposureStore.load());
    } catch (_) {
      this.publicBaseUrl = '';
      this.publicExposureState = Object.freeze({
        status: 'invalid',
        source: 'persisted',
        baseUrl: '',
        durable: true,
        failClosed: true,
        canClearPersisted: Boolean(publicExposureFile),
        updatedAt: null,
        errorCode: 'collaboration_public_exposure_store_unreadable',
        warning: '公网配置文件损坏或无法读取；远程请求已进入安全降级，请清除后重新配置。',
      });
    }
    this.trustedProxyAddresses = normalizeTrustedProxyAddresses(
      options.trustedProxyAddresses ?? config.COLLAB_TRUST_PROXY_ADDRESSES,
    );
    this.rateLimitMaxBuckets = boundedInteger(
      options.rateLimitMaxBuckets ?? config.COLLAB_RATE_LIMIT_MAX_BUCKETS,
      DEFAULT_RATE_LIMIT_MAX_BUCKETS,
      1,
      1_000_000,
    );
    this.rateLimitNow = typeof options.rateLimitNow === 'function' ? options.rateLimitNow : Date.now;
    this.inviteRedeemLimiters = Object.freeze({
      ip: createWeightedWindowLimiter({
        limit: boundedInteger(
          options.inviteRedeemsPerMinutePerIp ?? config.COLLAB_INVITE_REDEEMS_PER_MINUTE_PER_IP,
          DEFAULT_INVITE_REDEEMS_PER_MINUTE_PER_IP,
          1,
          1_000_000,
        ),
        windowMs: 60_000,
        maxBuckets: this.rateLimitMaxBuckets,
        now: this.rateLimitNow,
      }),
      code: createWeightedWindowLimiter({
        limit: boundedInteger(
          options.inviteRedeemsPerMinutePerCode ?? config.COLLAB_INVITE_REDEEMS_PER_MINUTE_PER_CODE,
          DEFAULT_INVITE_REDEEMS_PER_MINUTE_PER_CODE,
          1,
          1_000_000,
        ),
        windowMs: 60_000,
        maxBuckets: this.rateLimitMaxBuckets,
        now: this.rateLimitNow,
      }),
    });
    this.uploadRequestLimiters = createTieredCollaborationLimiters({
      ipLimit: boundedInteger(
        options.uploadRequestsPerMinutePerIp ?? config.COLLAB_UPLOAD_REQUESTS_PER_MINUTE_PER_IP,
        DEFAULT_UPLOAD_REQUESTS_PER_MINUTE_PER_IP,
        1,
        1_000_000,
      ),
      sessionLimit: boundedInteger(
        options.uploadRequestsPerMinutePerSession ?? config.COLLAB_UPLOAD_REQUESTS_PER_MINUTE_PER_SESSION,
        DEFAULT_UPLOAD_REQUESTS_PER_MINUTE_PER_SESSION,
        1,
        1_000_000,
      ),
      windowMs: 60_000,
      maxBuckets: this.rateLimitMaxBuckets,
      now: this.rateLimitNow,
    });
    this.uploadByteLimiters = createTieredCollaborationLimiters({
      ipLimit: boundedInteger(
        options.uploadBytesPerMinutePerIp ?? config.COLLAB_UPLOAD_BYTES_PER_MINUTE_PER_IP,
        DEFAULT_UPLOAD_BYTES_PER_MINUTE_PER_IP,
        1,
        64 * 1024 * 1024 * 1024,
      ),
      sessionLimit: boundedInteger(
        options.uploadBytesPerMinutePerSession ?? config.COLLAB_UPLOAD_BYTES_PER_MINUTE_PER_SESSION,
        DEFAULT_UPLOAD_BYTES_PER_MINUTE_PER_SESSION,
        1,
        32 * 1024 * 1024 * 1024,
      ),
      windowMs: 60_000,
      maxBuckets: this.rateLimitMaxBuckets,
      now: this.rateLimitNow,
    });
    this.downloadRequestLimiters = createTieredCollaborationLimiters({
      ipLimit: boundedInteger(
        options.downloadRequestsPerMinutePerIp ?? config.COLLAB_DOWNLOAD_REQUESTS_PER_MINUTE_PER_IP,
        DEFAULT_DOWNLOAD_REQUESTS_PER_MINUTE_PER_IP,
        1,
        1_000_000,
      ),
      sessionLimit: boundedInteger(
        options.downloadRequestsPerMinutePerSession ?? config.COLLAB_DOWNLOAD_REQUESTS_PER_MINUTE_PER_SESSION,
        DEFAULT_DOWNLOAD_REQUESTS_PER_MINUTE_PER_SESSION,
        1,
        1_000_000,
      ),
      windowMs: 60_000,
      maxBuckets: this.rateLimitMaxBuckets,
      now: this.rateLimitNow,
    });
    this.downloadBandwidthLimiters = createTieredCollaborationLimiters({
      ipLimit: boundedInteger(
        options.downloadBytesPerSecondPerIp ?? config.COLLAB_DOWNLOAD_BYTES_PER_SECOND_PER_IP,
        DEFAULT_DOWNLOAD_BYTES_PER_SECOND_PER_IP,
        1,
        4 * 1024 * 1024 * 1024,
      ),
      sessionLimit: boundedInteger(
        options.downloadBytesPerSecondPerSession ?? config.COLLAB_DOWNLOAD_BYTES_PER_SECOND_PER_SESSION,
        DEFAULT_DOWNLOAD_BYTES_PER_SECOND_PER_SESSION,
        1,
        2 * 1024 * 1024 * 1024,
      ),
      windowMs: 1_000,
      maxBuckets: this.rateLimitMaxBuckets,
      now: this.rateLimitNow,
    });
    this.downloadBandwidthThrottleOptions = Object.freeze({
      ...(typeof options.bandwidthThrottleSchedule === 'function'
        ? { schedule: options.bandwidthThrottleSchedule }
        : {}),
      ...(typeof options.bandwidthThrottleCancel === 'function'
        ? { cancel: options.bandwidthThrottleCancel }
        : {}),
      ...(Number.isFinite(Number(options.downloadBandwidthSegmentBytes))
        ? {
            maximumSegmentBytes: boundedInteger(
              options.downloadBandwidthSegmentBytes,
              64 * 1024,
              1,
              1024 * 1024,
            ),
          }
        : {}),
    });
    this.webSocketMaxConnectionsPerIp = boundedInteger(
      options.webSocketMaxConnectionsPerIp ?? config.COLLAB_WS_MAX_CONNECTIONS_PER_IP,
      DEFAULT_WS_MAX_CONNECTIONS_PER_IP,
      1,
      10_000,
    );
    this.webSocketMaxConnectionsPerSession = boundedInteger(
      options.webSocketMaxConnectionsPerSession ?? config.COLLAB_WS_MAX_CONNECTIONS_PER_SESSION,
      DEFAULT_WS_MAX_CONNECTIONS_PER_SESSION,
      1,
      10_000,
    );
    this.webSocketMessagesPerWindow = boundedInteger(
      options.webSocketMessagesPerWindow ?? config.COLLAB_WS_MESSAGES_PER_WINDOW,
      DEFAULT_WS_MESSAGES_PER_WINDOW,
      1,
      1_000_000,
    );
    this.webSocketMessageWindowMs = boundedInteger(
      options.webSocketMessageWindowMs ?? config.COLLAB_WS_MESSAGE_WINDOW_MS,
      DEFAULT_WS_MESSAGE_WINDOW_MS,
      1,
      60_000,
    );
    const configuredWebSocketMessageLimits = {
      presence: {
        ip: config.COLLAB_WS_PRESENCE_MESSAGES_PER_WINDOW_PER_IP,
        session: config.COLLAB_WS_PRESENCE_MESSAGES_PER_WINDOW_PER_SESSION,
      },
      heartbeat: {
        ip: config.COLLAB_WS_HEARTBEAT_MESSAGES_PER_WINDOW_PER_IP,
        session: config.COLLAB_WS_HEARTBEAT_MESSAGES_PER_WINDOW_PER_SESSION,
      },
      join: {
        ip: config.COLLAB_WS_JOIN_MESSAGES_PER_WINDOW_PER_IP,
        session: config.COLLAB_WS_JOIN_MESSAGES_PER_WINDOW_PER_SESSION,
      },
      unknown: {
        ip: config.COLLAB_WS_UNKNOWN_MESSAGES_PER_WINDOW_PER_IP,
        session: config.COLLAB_WS_UNKNOWN_MESSAGES_PER_WINDOW_PER_SESSION,
      },
    };
    this.webSocketMessageLimiters = Object.freeze(Object.fromEntries(
      Object.entries(DEFAULT_WS_MESSAGE_CLASS_LIMITS).map(([messageClass, defaults]) => {
        const overrides = options.webSocketMessageLimits?.[messageClass] || {};
        return [messageClass, createTieredCollaborationLimiters({
          ipLimit: boundedInteger(
            overrides.ip ?? configuredWebSocketMessageLimits[messageClass]?.ip,
            defaults.ip,
            1,
            1_000_000,
          ),
          sessionLimit: boundedInteger(
            overrides.session ?? configuredWebSocketMessageLimits[messageClass]?.session,
            defaults.session,
            1,
            1_000_000,
          ),
          windowMs: this.webSocketMessageWindowMs,
          maxBuckets: this.rateLimitMaxBuckets,
          now: this.rateLimitNow,
        })];
      }),
    ));
    this.webSocketHandshakeIpLimiter = createFixedWindowLimiter({
      limit: boundedInteger(
        options.webSocketHandshakesPerMinutePerIp
          ?? config.COLLAB_WS_HANDSHAKES_PER_MINUTE_PER_IP,
        DEFAULT_WS_HANDSHAKES_PER_MINUTE_PER_IP,
        1,
        1_000_000,
      ),
      windowMs: 60_000,
      maxBuckets: this.rateLimitMaxBuckets,
    });
    this.webSocketHandshakeSessionLimiter = createFixedWindowLimiter({
      limit: boundedInteger(
        options.webSocketHandshakesPerMinutePerSession
          ?? config.COLLAB_WS_HANDSHAKES_PER_MINUTE_PER_SESSION,
        DEFAULT_WS_HANDSHAKES_PER_MINUTE_PER_SESSION,
        1,
        1_000_000,
      ),
      windowMs: 60_000,
      maxBuckets: this.rateLimitMaxBuckets,
    });
    const requestedHeartbeatInterval = Number(options.webSocketHeartbeatIntervalMs);
    this.webSocketHeartbeatIntervalMs = Number.isFinite(requestedHeartbeatInterval)
      ? Math.max(25, Math.trunc(requestedHeartbeatInterval))
      : DEFAULT_WS_HEARTBEAT_INTERVAL_MS;
    const requestedHeartbeatTimeout = Number(options.webSocketHeartbeatTimeoutMs);
    this.webSocketHeartbeatTimeoutMs = Number.isFinite(requestedHeartbeatTimeout)
      ? Math.max(this.webSocketHeartbeatIntervalMs * 2, Math.trunc(requestedHeartbeatTimeout))
      : Math.max(this.webSocketHeartbeatIntervalMs * 2, DEFAULT_WS_HEARTBEAT_TIMEOUT_MS);
    this.networkInterfacesProvider = typeof options.listNetworkInterfaces === 'function'
      ? options.listNetworkInterfaces
      : listNetworkInterfaces;
  }

  requestRateLimitEntries(request, limiters) {
    return [
      {
        dimension: 'ip',
        limiter: limiters.ip,
        key: requestClientAddress(request, this.trustedProxyAddresses),
      },
      {
        dimension: 'session',
        limiter: limiters.session,
        key: String(request?.collaborationSession?.id || 'invalid-session'),
      },
    ];
  }

  webSocketMessageRateLimit(state, messageType) {
    const messageClass = classifyCollaborationWebSocketMessage(messageType);
    const limiters = this.webSocketMessageLimiters[messageClass]
      || this.webSocketMessageLimiters.unknown;
    const result = consumeTieredWindowBudget([
      {
        dimension: 'ip',
        limiter: limiters.ip,
        key: String(state?.clientIp || 'unknown'),
      },
      {
        dimension: 'session',
        limiter: limiters.session,
        key: String(state?.session?.id || 'invalid-session'),
      },
    ]);
    return Object.freeze({ ...result, messageClass });
  }

  closeWebSocketForMessageRateLimit(webSocket, result) {
    const state = this.connections.get(webSocket);
    if (state?.rateLimitClosing) return;
    if (state) state.rateLimitClosing = true;
    const closeRateLimitedSocket = () => {
      try {
        webSocket.close(WS_CLOSE_MESSAGE_RATE_LIMITED, WS_MESSAGE_RATE_LIMIT_REASON);
      } catch (_) { /* already closed */ }
      this.scheduleWebSocketTermination(webSocket);
    };
    try {
      webSocket.send(JSON.stringify({
        type: 'connection.rate-limited',
        code: 'collaboration_ws_message_rate_limited',
        retryable: true,
        retryAfterMs: Math.max(1, Number(result?.retryAfterMs) || 1),
        retryAfterSeconds: retryAfterSeconds(result?.retryAfterMs),
        messageClass: String(result?.messageClass || 'unknown'),
        limitDimension: String(result?.dimension || 'unknown'),
        timestamp: Date.now(),
      }), closeRateLimitedSocket);
    } catch (_) {
      closeRateLimitedSocket();
    }
  }

  subflowUpgradePlanCacheKey(session, digest) {
    return [
      String(session?.projectId || ''),
      String(session?.canvasId || ''),
      String(session?.id || ''),
      String(digest || '').toLowerCase(),
    ].join('\u0000');
  }

  pruneSubflowUpgradePlans(now = Date.now()) {
    for (const [key, entry] of this.subflowUpgradePlans) {
      if (Number(entry?.expiresAt) <= now) this.subflowUpgradePlans.delete(key);
    }
    while (this.subflowUpgradePlans.size > this.subflowUpgradePlanCacheLimit) {
      const oldestKey = this.subflowUpgradePlans.keys().next().value;
      if (oldestKey == null) break;
      this.subflowUpgradePlans.delete(oldestKey);
    }
  }

  clearSubflowUpgradePlans() {
    this.subflowUpgradePlans.clear();
  }

  cacheSubflowUpgradePlan(session, plan, operationPayload) {
    const now = Date.now();
    this.pruneSubflowUpgradePlans(now);
    const digest = String(operationPayload.upgradePlanDigest).toLowerCase();
    const planJson = stableJson(plan);
    for (const entry of this.subflowUpgradePlans.values()) {
      if (entry.digest === digest && entry.planJson !== planJson) {
        throw collaborationGatewayError(
          'collaboration_subflow_plan_digest_collision',
          '子工作流升级计划摘要发生冲突',
          409,
        );
      }
    }
    const key = this.subflowUpgradePlanCacheKey(session, digest);
    const expiresAt = now + this.subflowUpgradePlanTtlMs;
    if (this.subflowUpgradePlans.has(key)) this.subflowUpgradePlans.delete(key);
    this.subflowUpgradePlans.set(key, {
      digest,
      projectId: String(session.projectId),
      canvasId: String(session.canvasId),
      memberId: String(session.memberId),
      sessionId: String(session.id),
      expiresAt,
      plan,
      planJson,
      operationPayload: JSON.parse(JSON.stringify(operationPayload)),
    });
    this.pruneSubflowUpgradePlans(now);
    return expiresAt;
  }

  issuedSubflowUpgradePlan(session, batch, operation) {
    this.pruneSubflowUpgradePlans();
    const digest = String(operation?.payload?.upgradePlanDigest || '').toLowerCase();
    const entry = this.subflowUpgradePlans.get(this.subflowUpgradePlanCacheKey(session, digest));
    if (!entry
      || entry.projectId !== String(batch.projectId)
      || entry.canvasId !== String(batch.canvasId)
      || entry.memberId !== String(session.memberId)
      || entry.sessionId !== String(session.id)
      || stableJson(entry.operationPayload) !== stableJson(operation.payload)) {
      throw collaborationGatewayError(
        'collaboration_subflow_plan_required',
        '子工作流升级计划未签发、已过期或不属于当前会话，请重新规划',
        409,
      );
    }
    return entry.plan;
  }

  consumeSubflowUpgradePlans(session, operations) {
    for (const operation of operations) {
      this.subflowUpgradePlans.delete(this.subflowUpgradePlanCacheKey(
        session,
        operation?.payload?.upgradePlanDigest,
      ));
    }
  }

  createSubflowUpgradePlan(session, rawIntent) {
    const intent = canonicalSubflowMappingIntent(rawIntent);
    const document = this.ensureCanvasAccess(session, session.canvasId);
    if (!document) {
      throw collaborationGatewayError('canvas_not_found', '画布不存在或无权访问', 404);
    }
    this.assertDocumentResourcesGranted(session, document);
    const tombstoned = Object.values(document.tombstones?.nodes || {}).some((record) => (
      String(record?.entityUid || '').toLowerCase() === intent.instanceUid
    ));
    if (tombstoned) {
      throw collaborationGatewayError(
        'collaboration_domain_target_deleted',
        '子工作流实例已删除',
        409,
      );
    }
    const matches = document.nodes.filter((node) => (
      String(node?.entityUid || '').toLowerCase() === intent.instanceUid
    ));
    if (matches.length !== 1) {
      throw collaborationGatewayError(
        matches.length ? 'collaboration_domain_target_ambiguous' : 'collaboration_domain_target_missing',
        matches.length ? '子工作流实例稳定身份不唯一' : '子工作流实例不存在',
        matches.length ? 409 : 404,
      );
    }
    const instance = matches[0];
    if (String(instance.type || '') !== 'subflow') {
      throw collaborationGatewayError(
        'collaboration_domain_subflow_invalid',
        '目标节点不是子工作流实例',
        422,
      );
    }
    const data = instance.data && typeof instance.data === 'object' && !Array.isArray(instance.data)
      ? instance.data
      : {};
    const definitionUid = [
      data.definitionEntityUid,
      data.definition?.entityUid,
      data.definitionId,
    ].find((value) => isCommonOperationUuid(value));
    const expectedInstanceRevision = Number(instance.entityRevision ?? instance.revision);
    const expectedDefinitionVersion = Number(data.definitionVersion ?? data.definition?.version);
    const expectedDefinitionRevision = Number(data.definitionRevision ?? data.definition?.revision);
    if (!definitionUid
      || !Number.isSafeInteger(expectedInstanceRevision) || expectedInstanceRevision < 1
      || !Number.isSafeInteger(expectedDefinitionVersion) || expectedDefinitionVersion < 1
      || !Number.isSafeInteger(expectedDefinitionRevision) || expectedDefinitionRevision < 1) {
      throw collaborationGatewayError(
        'collaboration_domain_subflow_invalid',
        '子工作流实例缺少权威定义或修订绑定',
        422,
      );
    }
    const canonicalDefinitionUid = String(definitionUid).toLowerCase();
    const sourceDefinition = this.database.getSubflowDefinitionByEntityUid(
      canonicalDefinitionUid,
      expectedDefinitionVersion,
      document.projectId,
    );
    const targetDefinition = this.database.getSubflowDefinitionByEntityUid(
      canonicalDefinitionUid,
      intent.targetDefinitionVersion,
      document.projectId,
    );
    if (!sourceDefinition || !targetDefinition) {
      throw collaborationGatewayError(
        'collaboration_domain_target_missing',
        '子工作流权威定义版本不存在',
        404,
      );
    }
    if (Number(sourceDefinition.revision) !== expectedDefinitionRevision
      || (data.definitionId != null && String(data.definitionId) !== String(sourceDefinition.id))
      || (data.definitionProjectId != null
        && String(data.definitionProjectId) !== String(document.projectId))) {
      throw collaborationGatewayError(
        'collaboration_domain_subflow_invalid',
        '子工作流实例与权威定义绑定不一致',
        422,
      );
    }
    const targetDefinitionRevision = Number(targetDefinition.revision);
    if (!Number.isSafeInteger(targetDefinitionRevision) || targetDefinitionRevision < 1
      || intent.targetDefinitionVersion < expectedDefinitionVersion
      || (intent.targetDefinitionVersion === expectedDefinitionVersion
        && targetDefinitionRevision <= expectedDefinitionRevision)) {
      throw collaborationGatewayError(
        'collaboration_domain_subflow_invalid',
        '目标子工作流定义必须严格晚于当前定义',
        422,
      );
    }
    const resourceScope = this.canvasResourceScope(session);
    if (!resourceScope.subflowReferences
      .get(String(sourceDefinition.id))?.has(expectedDefinitionVersion)
      || !resourceScope.subflowReferences
        .get(String(targetDefinition.id))?.has(intent.targetDefinitionVersion)) {
      throw collaborationGatewayError(
        'canvas_resource_access_denied',
        '目标子工作流版本未获当前协作房间授权',
        403,
      );
    }
    const plan = {
      instanceUid: intent.instanceUid,
      definitionUid: canonicalDefinitionUid,
      expectedCanvasRevision: Number(document.revision),
      expectedInstanceRevision,
      expectedDefinitionVersion,
      expectedDefinitionRevision,
      targetDefinitionVersion: intent.targetDefinitionVersion,
      targetDefinitionRevision,
      portMappings: intent.portMappings,
      parameterMappings: intent.parameterMappings,
    };
    const upgradePlanDigest = digestSubflowUpgradePlan(plan);
    const operationPayload = {
      instanceUid: plan.instanceUid,
      definitionUid: plan.definitionUid,
      expectedCanvasRevision: plan.expectedCanvasRevision,
      expectedInstanceRevision: plan.expectedInstanceRevision,
      expectedDefinitionVersion: plan.expectedDefinitionVersion,
      expectedDefinitionRevision: plan.expectedDefinitionRevision,
      targetDefinitionVersion: plan.targetDefinitionVersion,
      targetDefinitionRevision: plan.targetDefinitionRevision,
      upgradePlanDigest,
    };
    const authorityPlan = { ...plan, upgradePlanDigest };
    const validationBatch = normalizeCommonOperationBatch({
      contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
      projectId: document.projectId,
      canvasId: document.canvasId,
      baseRevision: document.revision,
      batchId: crypto.randomUUID(),
      clientId: crypto.randomUUID(),
      clientSeq: 0,
      operations: [{
        opId: crypto.randomUUID(),
        type: 'subflow.instance.upgrade',
        payload: operationPayload,
      }],
    });
    const authorized = authorizeSubflowInstanceUpgrade(validationBatch.operations[0], {
      batch: validationBatch,
      document,
      principal: {
        memberId: session.memberId,
        sessionId: session.id,
        capabilities: session.capabilities,
      },
      subflowDefinitions: [sourceDefinition, targetDefinition],
      subflowUpgradePlans: [authorityPlan],
    });
    if (!authorized?.atomic || authorized.writes?.length !== 1
      || authorized.writes[0]?.kind !== 'subflow.instance.upgrade') {
      throw collaborationGatewayError(
        'collaboration_domain_subflow_invalid',
        '子工作流升级计划未通过权威校验',
        422,
      );
    }
    const expiresAt = this.cacheSubflowUpgradePlan(session, authorityPlan, operationPayload);
    return {
      contractVersion: 't8-subflow-upgrade-plan-ticket-v1',
      expiresAt,
      operationPayload,
    };
  }

  networkInterfaces() {
    return this.networkInterfacesProvider();
  }

  collaborationAllowedOrigins(host = this.host, port = this.port) {
    const networkInterfaces = this.networkInterfaces();
    return buildCollaborationAllowedOrigins({
      shareUrls: shareUrlsForHost(host, port, networkInterfaces),
      configuredOrigins: this.config.COLLAB_ALLOWED_ORIGINS,
      publicBaseUrl: this.publicBaseUrl,
    });
  }

  publicExposurePolicy() {
    return safeConfiguredPublicExposure(this.publicBaseUrl);
  }

  applyPublicExposureState(state) {
    let nextState = null;
    if (state && typeof state === 'object' && state.status === 'configured') {
      try {
        const baseUrl = normalizePublicBaseUrl(state.baseUrl);
        const source = ['persisted', 'environment', 'runtime'].includes(state.source)
          ? state.source
          : 'runtime';
        nextState = Object.freeze({
          ...state,
          status: 'configured',
          source,
          baseUrl,
          durable: source !== 'runtime',
          failClosed: false,
        });
      } catch (_) {
        nextState = null;
      }
    } else if (state && typeof state === 'object' && state.status === 'unconfigured') {
      nextState = Object.freeze({
        ...state,
        status: 'unconfigured',
        source: 'none',
        baseUrl: '',
        durable: true,
        failClosed: true,
      });
    } else if (state && typeof state === 'object' && state.status === 'invalid') {
      nextState = Object.freeze({
        ...state,
        status: 'invalid',
        source: state.source === 'environment' ? 'environment' : 'persisted',
        baseUrl: '',
        durable: true,
        failClosed: true,
      });
    }
    this.publicExposureState = nextState || Object.freeze({
      status: 'invalid',
      source: 'persisted',
      baseUrl: '',
      durable: true,
      failClosed: true,
      canClearPersisted: true,
      updatedAt: null,
      errorCode: 'collaboration_public_exposure_store_invalid',
      warning: '公网配置文件损坏或无法读取；远程请求已进入安全降级，请清除后重新配置。',
    });
    this.publicBaseUrl = String(this.publicExposureState.baseUrl || '');
    return this.publicExposureState;
  }

  publicExposureConfiguration() {
    const state = this.publicExposureState;
    return {
      status: state.status,
      source: state.source,
      durable: state.durable === true,
      failClosed: state.failClosed === true,
      canClearPersisted: state.canClearPersisted === true,
      updatedAt: Number.isSafeInteger(state.updatedAt) ? state.updatedAt : null,
      errorCode: state.errorCode || null,
      warning: state.warning || null,
    };
  }

  setPublicBaseUrl(value) {
    const normalized = normalizePublicBaseUrl(value);
    const nextState = this.publicExposureStore.save(normalized);
    this.applyPublicExposureState(nextState);
    this.lastPublicSelfCheck = null;
    return this.publicExposurePolicy();
  }

  clearPublicBaseUrl() {
    if (this.publicSelfCheckPromise) {
      throw collaborationGatewayError(
        'collaboration_public_self_check_in_progress',
        '公网自检进行中，暂时不能清除配置',
        409,
      );
    }
    this.applyPublicExposureState(this.publicExposureStore.clear());
    this.lastPublicSelfCheck = null;
    return this.managementStatus();
  }

  async checkPublicBaseUrl(value, options = {}) {
    if (!this.server?.listening) {
      throw collaborationGatewayError(
        'collaboration_public_self_check_gateway_stopped',
        '请先启动协作网关，再执行公网自检',
        409,
      );
    }
    if (this.publicSelfCheckPromise) {
      throw collaborationGatewayError(
        'collaboration_public_self_check_in_progress',
        '已有一轮公网自检正在进行',
        409,
      );
    }
    const policy = this.setPublicBaseUrl(value);
    const interfaces = this.networkInterfaces();
    const pending = runPublicSelfCheck({
      baseUrl: policy.baseUrl,
      challenges: this.publicSelfCheckChallenges,
      timeoutMs: options.timeoutMs,
      lookup: options.lookup,
      allowedLocalOrigins: shareUrlsForHost(this.host, this.port, interfaces),
      allowedLocalAddresses: interfaces.map((entry) => entry.address),
    });
    this.publicSelfCheckPromise = pending;
    try {
      const result = await pending;
      this.lastPublicSelfCheck = result;
      return result;
    } finally {
      if (this.publicSelfCheckPromise === pending) this.publicSelfCheckPromise = null;
    }
  }

  status() {
    return {
      running: Boolean(this.server?.listening),
      host: this.host,
      port: this.port,
      startedAt: this.startedAt,
      connectionCount: this.connections.size,
      privateBackendExposed: false,
    };
  }

  managementStatus() {
    const status = this.status();
    const networkInterfaces = this.networkInterfaces();
    return {
      ...status,
      networkInterfaces,
      shareUrls: status.running ? shareUrlsForHost(this.host, this.port, networkInterfaces) : [],
      defaultHost: normalizeBindHost(this.config.COLLAB_HOST || '127.0.0.1'),
      defaultPort: Number(this.config.COLLAB_PORT) || 18767,
      publicBaseUrl: this.publicBaseUrl || null,
      publicExposure: this.publicExposurePolicy(),
      publicExposureConfiguration: this.publicExposureConfiguration(),
      lastPublicSelfCheck: this.lastPublicSelfCheck,
    };
  }

  managementResourceScope(projectId, canvasId) {
    const canvas = this.database.getCanvas(canvasId);
    if (!canvas || String(canvas.projectId) !== String(projectId)) return null;
    const state = this.database.getCanvasResourceGrantState(projectId, canvasId);
    const grants = state
      ? this.database.listCanvasResourceGrants(projectId, canvasId)
      : { assetIds: new Set(), subflowReferences: new Map() };
    const subflowCount = [...grants.subflowReferences.values()]
      .reduce((total, versions) => total + versions.size, 0);
    const initialized = Boolean(state) && Number(state.initializedAt) > 0;
    const revisionCurrent = Boolean(state)
      && Number(state.trustedRevision) === Number(canvas.revision);
    return {
      status: !initialized
        ? 'confirmation-required'
        : revisionCurrent ? 'ready' : 'stale',
      ready: initialized && revisionCurrent,
      canvasRevision: Number(canvas.revision),
      trustedRevision: state ? Number(state.trustedRevision) : null,
      initializedAt: initialized ? Number(state.initializedAt) : null,
      assetCount: grants.assetIds.size,
      subflowCount,
    };
  }

  connectionCountForProject(projectId) {
    const expectedProjectId = String(projectId || '');
    let count = 0;
    for (const state of this.connections.values()) {
      if (String(state?.session?.projectId || '') === expectedProjectId) count += 1;
    }
    return count;
  }

  connectionCountForCanvas(projectId, canvasId) {
    const expectedProjectId = String(projectId || '');
    const expectedCanvasId = String(canvasId || '');
    let count = 0;
    for (const state of this.connections.values()) {
      if (String(state?.session?.projectId || '') === expectedProjectId
        && String(state?.session?.canvasId || '') === expectedCanvasId) count += 1;
    }
    return count;
  }

  connectionCountForSession(sessionId) {
    const expectedSessionId = String(sessionId || '');
    let count = 0;
    for (const state of this.connections.values()) {
      if (String(state?.session?.id || '') === expectedSessionId) count += 1;
    }
    return count;
  }

  scheduleWebSocketTermination(webSocket, delayMs = WS_CLOSE_GRACE_MS) {
    if (!webSocket || webSocket.readyState === WebSocket.CLOSED) return;
    if (this.webSocketTerminationTimers.has(webSocket)) return;
    const timer = setTimeout(() => {
      this.webSocketTerminationTimers.delete(webSocket);
      if (webSocket.readyState === WebSocket.CLOSED) return;
      try { webSocket.terminate(); } catch (_) { /* already closed */ }
    }, delayMs);
    timer.unref?.();
    this.webSocketTerminationTimers.set(webSocket, timer);
    webSocket.once('close', () => {
      const pendingTimer = this.webSocketTerminationTimers.get(webSocket);
      if (!pendingTimer) return;
      clearTimeout(pendingTimer);
      this.webSocketTerminationTimers.delete(webSocket);
    });
  }

  closeConnections(predicate, reason = 'session revoked', options = {}) {
    const closeCode = Number.isInteger(Number(options.code)) ? Number(options.code) : WS_CLOSE_SESSION_REVOKED;
    const messageType = String(options.messageType || 'session.revoked');
    let closed = 0;
    for (const [webSocket, state] of this.connections.entries()) {
      if (!predicate(state)) continue;
      closed += 1;
      if (webSocket.readyState === WebSocket.OPEN) {
        try {
          webSocket.send(JSON.stringify({ type: messageType, reason, timestamp: Date.now() }));
        } catch (_) {
          // The close below remains authoritative even if the final notice cannot be delivered.
        }
        webSocket.close(closeCode, String(reason).slice(0, 120));
      } else if (webSocket.readyState === WebSocket.CONNECTING) {
        webSocket.terminate();
      }
      this.scheduleWebSocketTermination(webSocket);
    }
    return closed;
  }

  closeSessionConnections(sessionId, reason = 'session revoked') {
    const expectedSessionId = String(sessionId || '');
    this.applicationLifecycle.trackStandaloneTask(
      this.uploadManager.cancelAuthenticationSession(expectedSessionId).catch(() => undefined),
    );
    return this.closeConnections((state) => String(state?.session?.id || '') === expectedSessionId, reason);
  }

  closeMemberConnections(memberId, reason = 'member access changed', options = {}) {
    const expectedMemberId = String(memberId || '');
    this.applicationLifecycle.trackStandaloneTask(
      this.uploadManager.cancelMemberAuthenticationSessions(expectedMemberId).catch(() => undefined),
    );
    return this.closeConnections(
      (state) => String(state?.session?.memberId || '') === expectedMemberId,
      reason,
      options,
    );
  }

  closeProjectConnections(projectId, reason = 'project sessions revoked') {
    const expectedProjectId = String(projectId || '');
    this.applicationLifecycle.trackStandaloneTask(
      this.uploadManager.cancelProjectAuthenticationSessions(expectedProjectId).catch(() => undefined),
    );
    return this.closeConnections((state) => String(state?.session?.projectId || '') === expectedProjectId, reason);
  }

  closeCanvasConnections(projectId, canvasId, reason = 'canvas sessions revoked') {
    const expectedProjectId = String(projectId || '');
    const expectedCanvasId = String(canvasId || '');
    this.applicationLifecycle.trackStandaloneTask(
      this.uploadManager.cancelCanvasAuthenticationSessions(expectedProjectId, expectedCanvasId).catch(() => undefined),
    );
    return this.closeConnections(
      (state) => String(state?.session?.projectId || '') === expectedProjectId
        && String(state?.session?.canvasId || '') === expectedCanvasId,
      reason,
    );
  }

  enqueueLifecycle(type, key, operation) {
    const previous = this.lastLifecycleRequest;
    if (previous?.type === type && previous.key === key) return previous.promise;
    const promise = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = promise.then(() => undefined, () => undefined);
    const request = { type, key, promise };
    this.lastLifecycleRequest = request;
    promise.then(
      () => {
        if (this.lastLifecycleRequest === request) this.lastLifecycleRequest = null;
      },
      () => {
        if (this.lastLifecycleRequest === request) this.lastLifecycleRequest = null;
      },
    );
    return promise;
  }

  requireSession(req, res, next) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    let session = null;
    try {
      session = this.auth.authenticate(token);
    } catch (error) {
      if (isCollaborationSessionHeartbeatPath(req)) {
        return sendCollaborationSessionHeartbeatError(res, error);
      }
      return next(error);
    }
    if (!session) return res.status(401).json({ success: false, error: '协作会话无效或已过期' });
    req.collaborationSession = session;
    next();
  }

  requireCapability(capability) {
    return (req, res, next) => {
      if (['manageMembers', 'manageProviders'].includes(capability)
        && isInsecurePublicRequest(req, this.publicBaseUrl)) {
        return res.status(403).json({
          success: false,
          code: 'collaboration_public_http_owner_management_disabled',
          error: '公网连接未通过可信 HTTPS 验证，已禁用 owner 管理能力',
        });
      }
      if (!this.auth.hasCapability(req.collaborationSession, capability)) {
        return res.status(403).json({ success: false, error: `缺少权限: ${capability}` });
      }
      next();
    };
  }

  requireDurableMutationGeneration(req, res, next) {
    if (recoveryGenerationExemptMutationRequest(req)) return next();
    const requested = parseRecoveryGeneration(req.get('x-t8-canvas-generation'));
    if (!requested.valid) {
      res.set('Cache-Control', 'no-store');
      return res.status(400).json({
        success: false,
        code: 'canvas_generation_invalid',
        error: 'X-T8-Canvas-Generation 必须是 UUID',
      });
    }
    let generation = null;
    let generationRequired = false;
    try {
      generation = this.database.getRecoveryGeneration();
      generationRequired = this.database.requiresRecoveryGeneration();
    } catch (error) {
      if (isRecoveryGenerationUnavailable(error)) {
        return sendRecoveryGenerationUnavailable(res);
      }
      return next(error);
    }
    if (requested.generation == null && generationRequired) {
      res.set('Cache-Control', 'no-store');
      return res.status(409).json({
        success: false,
        code: 'canvas_generation_required',
        error: '数据库已恢复到新的 generation，请先同步权威快照再提交',
      });
    }
    if (requested.generation != null && requested.generation !== generation) {
      res.set('Cache-Control', 'no-store');
      return res.status(409).json({
        success: false,
        code: 'canvas_generation_changed',
        error: '数据库 generation 已变化，请先同步权威快照再提交',
      });
    }
    req.collaborationRecoveryGeneration = generation;
    return next();
  }

  ensureCanvasAccess(session, canvasId) {
    const document = this.database.getCanvas(canvasId);
    if (!document
      || document.projectId !== session?.projectId
      || String(document.canvasId) !== String(session?.canvasId || '')) return null;
    return document;
  }

  canvasResourceScope(session) {
    const document = this.ensureCanvasAccess(session, session?.canvasId);
    if (!document) {
      return {
        document: null,
        state: null,
        ready: false,
        assetIds: new Set(),
        subflowReferences: new Map(),
      };
    }
    const state = this.database.getCanvasResourceGrantState(document.projectId, document.canvasId);
    const ready = Boolean(state)
      && Number(state.initializedAt) > 0
      && Number(state.trustedRevision) === Number(document.revision);
    const grants = ready
      ? this.database.listCanvasResourceGrants(document.projectId, document.canvasId)
      : { assetIds: new Set(), subflowReferences: new Map() };
    return {
      document,
      state,
      ready,
      assetIds: grants.assetIds,
      subflowReferences: grants.subflowReferences,
    };
  }

  resolveLegacyReviewAnchor(session, document, rawAnchor) {
    if (!rawAnchor || typeof rawAnchor !== 'object' || Array.isArray(rawAnchor)) {
      throw new Error('评论锚点无效');
    }
    const kind = String(rawAnchor.kind || '');
    let commonAnchor;
    const assets = [];
    const allowedAssetEntityUids = new Set();
    if (kind === 'canvas') {
      commonAnchor = {
        kind,
        x: Number.isFinite(Number(rawAnchor.x)) ? Number(rawAnchor.x) : 0,
        y: Number.isFinite(Number(rawAnchor.y)) ? Number(rawAnchor.y) : 0,
      };
    } else if (kind === 'node' || kind === 'edge') {
      const identity = String(
        rawAnchor.targetUid
        || rawAnchor[`${kind}EntityUid`]
        || rawAnchor[`${kind}Id`]
        || '',
      );
      const records = Array.isArray(document[`${kind}s`]) ? document[`${kind}s`] : [];
      const target = records.find((record) => String(record?.entityUid || '') === identity)
        || records.find((record) => String(record?.id || '') === identity);
      if (!target?.entityUid) throw new Error('评论锚点目标不存在');
      commonAnchor = { kind, targetUid: target.entityUid };
    } else if (kind === 'asset' || kind === 'video') {
      const resourceScope = this.canvasResourceScope(session);
      const grantedAssets = [];
      for (const assetId of resourceScope.assetIds) {
        const asset = this.database.getAsset(assetId);
        if (!asset) continue;
        grantedAssets.push(asset);
      }
      assets.push(...this.filterSessionAssets(
        session,
        grantedAssets,
        'view',
        resourceScope.assetIds,
      ));
      for (const asset of assets) {
        if (asset.entityUid) allowedAssetEntityUids.add(asset.entityUid);
      }
      const identity = String(rawAnchor.targetUid || rawAnchor.assetEntityUid || rawAnchor.assetId || '');
      const asset = assets.find((record) => String(record.entityUid || '') === identity)
        || assets.find((record) => String(record.id || '') === identity);
      if (!asset?.entityUid) throw new Error('评论素材锚点不存在或未授权');
      if (kind === 'video') {
        const hasExplicitContentRevision = rawAnchor.assetContentRevision != null;
        const hasExplicitContentHash = rawAnchor.contentHash != null;
        const explicitLegacyPin = rawAnchor.assetRevision != null;
        if (hasExplicitContentRevision !== hasExplicitContentHash
          || ((hasExplicitContentRevision || hasExplicitContentHash) && explicitLegacyPin)) {
          throw collaborationGatewayError(
            'collaboration_review_video_pin_invalid',
            '视频评论必须完整提供同一种素材内容版本凭据',
            400,
          );
        }
        const explicitContentPin = hasExplicitContentRevision && hasExplicitContentHash;
        const assetHasContentPin = Number.isSafeInteger(Number(asset.contentRevision))
          && Number(asset.contentRevision) >= 1
          && /^[a-f0-9]{64}$/.test(String(asset.contentHash || '').toLowerCase());
        const hasContentPin = explicitContentPin || (!explicitLegacyPin && assetHasContentPin);
        const frameMs = Number(rawAnchor.frameMs ?? rawAnchor.timecodeMs);
        commonAnchor = hasContentPin
          ? {
            kind,
            targetUid: asset.entityUid,
            frameMs,
            assetContentRevision: Number(rawAnchor.assetContentRevision ?? asset.contentRevision),
            contentHash: String(rawAnchor.contentHash ?? asset.contentHash ?? '').toLowerCase(),
          }
          : {
            kind,
            targetUid: asset.entityUid,
            frameMs,
            assetRevision: Number(rawAnchor.assetRevision ?? asset.revision),
          };
      } else {
        commonAnchor = { kind, targetUid: asset.entityUid };
      }
    } else {
      throw new Error('评论锚点无效');
    }
    return resolveReviewAnchor(commonAnchor, document, {
      assets,
      allowedAssetEntityUids,
    });
  }

  reviewMembersForSession(session) {
    return this.database.listMembers(session.projectId, { canvasId: session.canvasId })
      .filter((member) => (String(member.projectId) === String(session.projectId)
        && String(member.canvasId || '') === String(session.canvasId || '')))
      .slice(0, 1000);
  }

  resolveLegacyReviewReferences(session, rawMentions, rawAttachments) {
    const mentionsInput = rawMentions == null ? [] : rawMentions;
    const attachmentsInput = rawAttachments == null ? [] : rawAttachments;
    if (!Array.isArray(mentionsInput) || mentionsInput.length > 20) {
      throw collaborationGatewayError(
        'collaboration_review_mentions_invalid',
        '@成员必须是最多 20 项的数组',
        400,
      );
    }
    if (!Array.isArray(attachmentsInput) || attachmentsInput.length > 20) {
      throw collaborationGatewayError(
        'collaboration_review_attachments_invalid',
        '评论附件必须是最多 20 项的数组',
        400,
      );
    }
    const members = new Map(this.reviewMembersForSession(session)
      .map((member) => [String(member.id || '').toLowerCase(), member]));
    const mentions = [];
    const seenMembers = new Set();
    for (const rawMemberId of mentionsInput) {
      const memberId = String(rawMemberId || '').toLowerCase();
      if (!isCommonOperationUuid(memberId) || !members.has(memberId)) {
        throw collaborationGatewayError(
          'collaboration_review_mention_not_found',
          '@成员不存在或不属于当前画布',
          404,
        );
      }
      if (seenMembers.has(memberId)) continue;
      seenMembers.add(memberId);
      mentions.push(memberId);
    }

    const resourceScope = this.canvasResourceScope(session);
    const grantedAssets = [...resourceScope.assetIds]
      .map((assetId) => this.database.getAsset(assetId))
      .filter(Boolean);
    const assets = this.filterSessionAssets(
      session,
      grantedAssets,
      'view',
      resourceScope.assetIds,
    );
    const assetsByUid = new Map(assets
      .filter((asset) => isCommonOperationUuid(asset?.entityUid))
      .map((asset) => [String(asset.entityUid).toLowerCase(), asset]));
    const attachments = [];
    const seenAssets = new Set();
    for (const rawAttachment of attachmentsInput) {
      if (!rawAttachment || typeof rawAttachment !== 'object' || Array.isArray(rawAttachment)) {
        throw collaborationGatewayError(
          'collaboration_review_attachment_invalid',
          '评论附件无效',
          400,
        );
      }
      const assetUid = String(
        rawAttachment.assetUid || rawAttachment.assetEntityUid || '',
      ).toLowerCase();
      const asset = assetsByUid.get(assetUid);
      const assetContentRevision = Number(rawAttachment.assetContentRevision);
      const contentHash = String(rawAttachment.contentHash || '').toLowerCase();
      if (!isCommonOperationUuid(assetUid)
        || !asset
        || !Number.isSafeInteger(assetContentRevision)
        || assetContentRevision < 1
        || !/^[a-f0-9]{64}$/.test(contentHash)) {
        throw collaborationGatewayError(
          'collaboration_review_attachment_invalid',
          '评论附件不存在、未授权或内容凭据无效',
          400,
        );
      }
      if (assetContentRevision !== Number(asset.contentRevision)
        || contentHash !== String(asset.contentHash || '').toLowerCase()) {
        throw collaborationGatewayError(
          'collaboration_review_attachment_changed',
          '评论附件内容已经变化，请刷新后重新选择',
          409,
        );
      }
      if (seenAssets.has(assetUid)) continue;
      seenAssets.add(assetUid);
      attachments.push({
        assetId: String(asset.id),
        assetUid,
        assetEntityUid: assetUid,
        assetContentRevision,
        contentHash,
      });
    }
    return {
      mentions,
      attachments,
      notificationRecipients: mentions.filter((memberId) => (
        memberId !== String(session.memberId || '').toLowerCase()
      )),
    };
  }

  reviewVisibilityPolicyForSession(session) {
    const role = String(session?.role || '').toLowerCase();
    if (!['reviewer', 'viewer'].includes(role)) return null;
    const policy = this.database.getProjectReviewVisibilityPolicy(session.projectId);
    if (!policy || (policy.hidePrompts !== true && policy.hideModelParameters !== true)) return null;
    return policy;
  }

  publicReviewVisibleValue(session, value) {
    const policy = this.reviewVisibilityPolicyForSession(session);
    return policy ? redactReviewVisibility(value, policy) : value;
  }

  reviewTextFieldHiddenForSession(session, field) {
    const policy = this.reviewVisibilityPolicyForSession(session);
    if (!policy) return false;
    const normalized = normalizedReviewVisibilityKey(field);
    return (policy.hidePrompts === true && REVIEW_PROMPT_FIELD_PATTERN.test(normalized))
      || (policy.hideModelParameters === true
        && reviewModelParameterFieldHidden(normalized, REVIEW_PARAMETER_CONTEXT_DIRECT));
  }

  publicRunAssetForSession(session, asset, scopedAssetIds = null) {
    if (!asset || !this.canSessionAccessAsset(session, asset, 'view', scopedAssetIds)) return null;
    const safe = this.publicAssetForSession(session, asset, scopedAssetIds);
    return safe ? {
      id: String(asset.id),
      kind: String(asset.kind || 'other'),
      filename: String(asset.filename || 'asset').slice(0, 300),
      mimeType: String(asset.mimeType || 'application/octet-stream'),
      contentRevision: Math.max(1, Number(asset.contentRevision) || 1),
      mediaUrl: safe.representations?.preview || null,
      thumbnailUrl: safe.representations?.thumbnail || null,
    } : null;
  }

  publicRunDetailForSession(session, run, options = {}) {
    if (!run
      || String(run.projectId || '') !== String(session.projectId || '')
      || String(run.canvasId || '') !== String(session.canvasId || '')) return null;
    const scopedAssetIds = this.canvasResourceScope(session).assetIds;
    const nodeRuns = this.database.listNodeRuns(run.id).slice(0, 500);
    const assetsById = new Map();
    for (const nodeRun of nodeRuns) {
      for (const assetId of Array.isArray(nodeRun.outputRefs) ? nodeRun.outputRefs : []) {
        if (assetsById.has(String(assetId))) continue;
        const asset = this.database.getAsset(assetId);
        const visible = this.publicRunAssetForSession(session, asset, scopedAssetIds);
        if (visible) assetsById.set(String(assetId), visible);
      }
    }
    const includeAttempts = options.includeAttempts === true;
    const nodes = nodeRuns.map((nodeRun) => ({
      ...publicNodeRunState(
        run.id,
        nodeRun,
        (Array.isArray(nodeRun.outputRefs) ? nodeRun.outputRefs : [])
          .map(String)
          .filter((assetId) => assetsById.has(assetId)),
      ),
      ...(includeAttempts ? {
        attempts: this.database.listAttempts(nodeRun.id).slice(-200).map((attempt) => ({
          id: String(attempt.id),
          nodeRunId: String(nodeRun.id),
          status: String(attempt.status),
          provider: attempt.provider || null,
          model: attempt.model || null,
          httpStatus: attempt.httpStatus == null ? null : Number(attempt.httpStatus),
          pollCount: Math.max(0, Number(attempt.pollCount) || 0),
          timestamps: attempt.timestamps || {},
          usage: attempt.usage || {},
          error: attempt.error || null,
          createdAt: Number(attempt.createdAt) || 0,
          updatedAt: Number(attempt.updatedAt) || 0,
        })),
      } : {}),
    }));
    return this.publicReviewVisibleValue(
      session,
      publicCollaborationCanvasValue({
        ...publicRunState(run),
        nodes,
        assets: [...assetsById.values()],
      }),
    );
  }

  publicRunEventForSession(session, event) {
    if (!event || !Number.isSafeInteger(Number(event.id)) || Number(event.id) < 1) return null;
    return this.publicReviewVisibleValue(
      session,
      publicCollaborationCanvasValue({
        id: Number(event.id),
        runId: String(event.runId || ''),
        nodeRunId: event.nodeRunId ? String(event.nodeRunId) : null,
        type: String(event.type || '').slice(0, 120),
        payload: event.payload && typeof event.payload === 'object' ? event.payload : {},
        createdAt: Number(event.createdAt) || 0,
      }),
    );
  }

  publicReviewThreadForSession(session, input, document = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    if (String(input.projectId || '') !== String(session.projectId || '')
      || String(input.canvasId || '') !== String(session.canvasId || '')) return null;
    const currentDocument = document || this.ensureCanvasAccess(session, input.canvasId);
    if (!currentDocument) return null;
    const scopedAssetIds = this.canvasResourceScope(session).assetIds;
    const members = new Map(this.reviewMembersForSession(session)
      .map((member) => [String(member.id || '').toLowerCase(), member]));
    const publicMention = (rawMemberId) => {
      const memberId = String(rawMemberId?.memberId || rawMemberId || '').toLowerCase();
      const member = members.get(memberId);
      return member
        ? { memberId, displayName: member.displayName, role: member.role }
        : { memberId, displayName: '已离开成员', role: null };
    };
    const publicAttachment = (rawAttachment) => {
      const assetUid = String(
        rawAttachment?.assetUid || rawAttachment?.assetEntityUid || '',
      ).toLowerCase();
      const asset = rawAttachment?.assetId
        ? this.database.getAsset(rawAttachment.assetId)
        : this.database.getAssetByEntityUid(assetUid, session.projectId);
      const allowed = asset
        && String(asset.entityUid || '').toLowerCase() === assetUid
        && this.canSessionAccessAsset(session, asset, 'view', scopedAssetIds);
      const pinnedRevision = Number(rawAttachment?.assetContentRevision);
      const pinnedHash = String(rawAttachment?.contentHash || '').toLowerCase();
      const exactContent = allowed
        && Number(asset.contentRevision) === pinnedRevision
        && String(asset.contentHash || '').toLowerCase() === pinnedHash;
      if (!exactContent) return { available: false };
      return {
        available: true,
        assetId: String(asset.id),
        assetUid,
        assetContentRevision: pinnedRevision,
        contentHash: pinnedHash,
        asset: this.publicAssetForSession(session, asset, scopedAssetIds),
      };
    };
    const rawAnchor = input.anchor && typeof input.anchor === 'object' ? input.anchor : {};
    let anchor = { ...rawAnchor };
    if (['asset', 'video'].includes(String(rawAnchor.kind))) {
      const assetUid = String(
        rawAnchor.targetEntityUid || rawAnchor.targetUid || '',
      ).toLowerCase();
      const asset = this.database.getAssetByEntityUid(assetUid, session.projectId);
      const allowed = asset && this.canSessionAccessAsset(session, asset, 'view', scopedAssetIds);
      if (!allowed) {
        anchor = {
          kind: String(rawAnchor.kind),
          unavailable: true,
          ...(rawAnchor.kind === 'video' && Number.isFinite(Number(rawAnchor.frameMs))
            ? { frameMs: Number(rawAnchor.frameMs) }
            : {}),
        };
      } else if (rawAnchor.assetContentRevision != null) {
        anchor = {
          ...rawAnchor,
          contentChanged: Number(rawAnchor.assetContentRevision) !== Number(asset.contentRevision)
            || String(rawAnchor.contentHash || '').toLowerCase()
              !== String(asset.contentHash || '').toLowerCase(),
          asset: this.publicAssetForSession(session, asset, scopedAssetIds),
        };
      } else {
        anchor = {
          ...rawAnchor,
          asset: this.publicAssetForSession(session, asset, scopedAssetIds),
        };
      }
    }
    let state;
    if (isReviewResolutionStatus(input.resolutionStatus) && isReviewLifecycleStatus(input.reviewStatus)) {
      state = { resolutionStatus: input.resolutionStatus, reviewStatus: input.reviewStatus };
    } else {
      try { state = decodeReviewThreadStorageStatus(input.status || 'open'); } catch {
        state = { resolutionStatus: 'open', reviewStatus: 'in_review' };
      }
    }
    const status = reviewCompatibilityStatus(state.resolutionStatus, state.reviewStatus);
    const approvalExpired = isReviewDecisionStatus(state.reviewStatus)
      && Number(input.decisionCanvasRevision) !== Number(currentDocument.revision);
    const comments = (Array.isArray(input.comments) ? input.comments : [])
      .slice(0, 5000)
      .map((comment) => ({
        id: comment.id,
        entityUid: comment.entityUid,
        threadId: comment.threadId,
        parentId: comment.parentId || null,
        parentEntityUid: comment.parentEntityUid || null,
        body: comment.body,
        createdBy: comment.createdBy,
        author: publicMention(comment.createdBy),
        mentions: (Array.isArray(comment.mentions) ? comment.mentions : []).map(publicMention),
        attachments: (Array.isArray(comment.attachments) ? comment.attachments : [])
          .map(publicAttachment),
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      }));
    return publicCollaborationCanvasValue({
      id: input.id,
      entityUid: input.entityUid,
      projectId: input.projectId,
      canvasId: input.canvasId,
      canvasRevision: input.canvasRevision,
      currentCanvasRevision: currentDocument.revision,
      anchor,
      resolutionStatus: state.resolutionStatus,
      reviewStatus: state.reviewStatus,
      effectiveReviewStatus: approvalExpired ? 'expired' : state.reviewStatus,
      status,
      effectiveStatus: approvalExpired ? 'expired' : status,
      approvalExpired,
      severity: input.severity,
      revision: input.revision,
      decisionCanvasRevision: input.decisionCanvasRevision,
      createdBy: input.createdBy,
      author: publicMention(input.createdBy),
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      comments,
    });
  }

  publicReviewNotification(notification) {
    if (!notification) return null;
    const thread = notification.threadId
      ? this.database.getReviewThread(notification.threadId)
      : null;
    const comment = thread && notification.commentId
      ? this.database.listReviewComments(thread.id).find((item) => (
        String(item.id) === String(notification.commentId)
      ))
      : null;
    return publicCollaborationCanvasValue({
      id: notification.id,
      kind: notification.kind,
      sourceOperationId: notification.sourceOperationId || null,
      threadEntityUid: notification.threadEntityUid
        || notification.threadUid
        || thread?.entityUid
        || null,
      commentEntityUid: notification.commentEntityUid
        || notification.commentUid
        || comment?.entityUid
        || null,
      actorId: notification.actorId || null,
      readAt: notification.readAt || null,
      createdAt: notification.createdAt,
    });
  }

  publicReviewNotificationForSession(session, notification) {
    if (!notification
      || String(notification.projectId || '') !== String(session.projectId || '')
      || String(notification.canvasId || '') !== String(session.canvasId || '')
      || String(notification.recipientMemberId || '') !== String(session.memberId || '')) return null;
    return this.publicReviewNotification(notification);
  }

  dispatchReviewNotifications(projectId, canvasId, notifications) {
    const safeNotifications = (Array.isArray(notifications) ? notifications : [])
      .filter((notification) => notification && notification.recipientMemberId);
    const recipients = new Set(safeNotifications.map((notification) => (
      String(notification.recipientMemberId)
    )));
    for (const recipientMemberId of recipients) {
      this.notifyCommitted('review.notification.dispatch', () => {
        const scoped = safeNotifications
          .filter((notification) => String(notification.recipientMemberId) === recipientMemberId)
          .map((notification) => this.publicReviewNotification(notification))
          .filter(Boolean);
        this.sendMemberScoped(projectId, canvasId, [recipientMemberId], {
          type: 'review.notification',
          notifications: scoped,
        });
      });
    }
    return safeNotifications.length;
  }

  canvasResourceError(code, message, status = 403) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
  }

  canvasResourceScopeFailure(scope) {
    if (!scope?.document) {
      return this.canvasResourceError(
        'canvas_not_found',
        '画布不存在或无权访问',
        404,
      );
    }
    if (!scope.state || Number(scope.state.initializedAt) <= 0) {
      return this.canvasResourceError(
        'canvas_resource_scope_confirmation_required',
        '该画布尚未由主机确认协作资源范围',
        409,
      );
    }
    return this.canvasResourceError(
      'canvas_resource_scope_stale',
      '协作资源授权状态需要主机重新同步',
      409,
    );
  }

  requireReadyResourceScope(req, res, next) {
    const scope = this.canvasResourceScope(req.collaborationSession);
    if (!scope.ready) {
      const error = this.canvasResourceScopeFailure(scope);
      return res.status(error.status).json({
        success: false,
        code: error.code,
        error: error.message,
      });
    }
    req.collaborationResourceScope = scope;
    next();
  }

  assertDocumentResourcesGranted(session, candidateDocument, options = {}) {
    const scope = this.canvasResourceScope(session);
    if (!scope.document || !scope.ready) {
      throw this.canvasResourceScopeFailure(scope);
    }
    const candidate = {
      ...(candidateDocument && typeof candidateDocument === 'object' ? candidateDocument : {}),
      projectId: scope.document.projectId,
      canvasId: scope.document.canvasId,
    };
    const resolved = this.database.resolveCanvasDocumentResources(candidate, {
      validateRootSubflowDefinition: options.validateRootSubflowDefinition,
    });
    if (resolved.truncated) {
      throw this.canvasResourceError(
        'canvas_resource_scope_too_large',
        '画布资源引用超过协作授权安全上限',
        422,
      );
    }
    if (resolved.subflowPinMismatches.length > 0) {
      throw this.canvasResourceError(
        'canvas_resource_subflow_pin_mismatch',
        '画布包含身份或固定版本不一致的内嵌子工作流',
        422,
      );
    }
    if (resolved.subflowContentMismatches.length > 0) {
      throw this.canvasResourceError(
        'canvas_resource_subflow_content_mismatch',
        '画布包含与权威固定版本内容不一致的内嵌子工作流',
        422,
      );
    }
    if (resolved.missingSubflows.length > 0) {
      throw this.canvasResourceError(
        'canvas_resource_subflow_missing',
        '画布引用的固定版本子工作流不存在',
        422,
      );
    }
    for (const assetId of resolved.grantAssetIds) {
      if (!scope.assetIds.has(String(assetId))) {
        throw this.canvasResourceError(
          'canvas_resource_access_denied',
          '画布引用了未获当前协作房间授权的素材或子工作流',
        );
      }
    }
    for (const [definitionId, versions] of resolved.requestedSubflowReferences) {
      const allowedVersions = scope.subflowReferences.get(String(definitionId));
      for (const version of versions) {
        if (!allowedVersions?.has(Number(version))) {
          throw this.canvasResourceError(
            'canvas_resource_access_denied',
            '画布引用了未获当前协作房间授权的素材或子工作流',
          );
        }
      }
    }
    return resolved;
  }

  canvasScopedSubflowDefinitions(session, query = '', scope = null) {
    const resourceScope = scope || this.canvasResourceScope(session);
    if (!resourceScope.ready) return [];
    const references = [];
    for (const [id, versions] of resourceScope.subflowReferences) {
      for (const version of versions) references.push({ id, version });
    }
    const definitions = [];
    for (let index = 0; index < references.length; index += 100) {
      definitions.push(...this.database.getSubflowDefinitionsByRefs(
        references.slice(index, index + 100),
        session.projectId,
      ));
    }
    const normalizedQuery = String(query || '').trim().toLowerCase();
    return definitions
      .filter((definition) => {
        if (!normalizedQuery) return true;
        return `${definition?.name || ''} ${definition?.description || ''} ${definition?.category || ''} ${(definition?.tags || []).join(' ')}`
          .toLowerCase()
          .includes(normalizedQuery);
      })
      .sort((left, right) => (
        Number(right?.publishedAt || right?.updatedAt || right?.createdAt || 0)
        - Number(left?.publishedAt || left?.updatedAt || left?.createdAt || 0)
        || String(left?.id || '').localeCompare(String(right?.id || ''))
        || Number(right?.version || 0) - Number(left?.version || 0)
      ));
  }

  collaborationAgentDatabase(session, scope = null) {
    const resourceScope = scope || this.canvasResourceScope(session);
    const database = this.database;
    const facade = Object.create(database);
    const assetIds = [...resourceScope.assetIds];
    const projectId = String(session.projectId);
    const canvasId = String(session.canvasId);
    facade.getCanvas = (requestedCanvasId) => (
      String(requestedCanvasId) === canvasId
        ? database.getCanvas(canvasId)
        : null
    );
    facade.listAccessibleAssets = (filters = {}, subject = {}) => database.listAccessibleAssets({
      ...filters,
      projectId,
      assetIds,
    }, subject);
    facade.countAccessibleAssets = (filters = {}, subject = {}) => database.countAccessibleAssets({
      ...filters,
      projectId,
      assetIds,
    }, subject);
    facade.getSubflowDefinition = (definitionId, version, requestedProjectId = projectId) => {
      if (String(requestedProjectId) !== projectId) return null;
      const versions = resourceScope.subflowReferences.get(String(definitionId || ''));
      if (!versions?.size) return null;
      const selectedVersion = version == null
        ? Math.max(...versions)
        : Number(version);
      if (!versions.has(selectedVersion)) return null;
      return database.getSubflowDefinition(definitionId, selectedVersion, projectId);
    };
    facade.getSubflowDefinitionsByRefs = (refs, requestedProjectId = projectId) => {
      if (String(requestedProjectId) !== projectId || !Array.isArray(refs)) return [];
      const allowed = refs.filter((reference) => (
        resourceScope.subflowReferences
          .get(String(reference?.id || ''))
          ?.has(Number(reference?.version))
      ));
      const definitions = [];
      for (let index = 0; index < allowed.length; index += 100) {
        definitions.push(...database.getSubflowDefinitionsByRefs(
          allowed.slice(index, index + 100),
          projectId,
        ));
      }
      return definitions;
    };
    facade.listSubflowDefinitions = (filters = {}) => this.canvasScopedSubflowDefinitions(
      session,
      filters.query,
      resourceScope,
    );
    facade.listSubflowVersions = (definitionId, requestedProjectId = projectId) => {
      if (String(requestedProjectId) !== projectId) return [];
      const versions = resourceScope.subflowReferences.get(String(definitionId || ''));
      if (!versions?.size) return [];
      return database.listSubflowVersions(definitionId, projectId)
        .filter((definition) => versions.has(Number(definition.version)));
    };
    return facade;
  }

  sessionCanAccessSubflow(session, definitionId, version = null) {
    const versions = this.canvasResourceScope(session).subflowReferences.get(String(definitionId || ''));
    if (!versions) return false;
    return version == null || versions.has(Number(version));
  }

  assetAccessSubject(session, permission) {
    return {
      memberId: String(session?.memberId || ''),
      role: String(session?.role || ''),
      permission: String(permission || 'view'),
    };
  }

  canSessionAccessAsset(session, asset, permission = 'view', scopedAssetIds = null) {
    if (!session || !asset || String(asset.projectId) !== String(session.projectId)) return false;
    const allowedAssetIds = scopedAssetIds instanceof Set
      ? scopedAssetIds
      : this.canvasResourceScope(session).assetIds;
    if (!allowedAssetIds.has(String(asset.id))) return false;
    if (typeof this.database.canAccessAsset !== 'function') return false;
    try {
      return Boolean(this.database.canAccessAsset(
        session.projectId,
        asset.id,
        this.assetAccessSubject(session, permission),
      ));
    } catch (_) {
      return false;
    }
  }

  filterSessionAssets(session, assets, permission = 'view', scopedAssetIds = null) {
    const allowedAssetIds = scopedAssetIds instanceof Set
      ? scopedAssetIds
      : this.canvasResourceScope(session).assetIds;
    const candidates = (Array.isArray(assets) ? assets : [])
      .filter((asset) => asset
        && String(asset.projectId) === String(session?.projectId)
        && allowedAssetIds.has(String(asset.id)))
      .slice(0, 1000);
    if (!session || typeof this.database.filterAccessibleAssets !== 'function') return [];
    try {
      const filtered = this.database.filterAccessibleAssets(
        session.projectId,
        candidates,
        this.assetAccessSubject(session, permission),
      );
      return Array.isArray(filtered) ? filtered : [];
    } catch (_) {
      return [];
    }
  }

  publicAssetForSession(session, asset, scopedAssetIds = null) {
    const safe = publicAsset(asset);
    if (!safe) return null;
    const allowedAssetIds = scopedAssetIds instanceof Set
      ? scopedAssetIds
      : this.canvasResourceScope(session).assetIds;
    const canPreview = this.canSessionAccessAsset(session, asset, 'preview', allowedAssetIds);
    const canOriginal = this.canSessionAccessAsset(session, asset, 'original', allowedAssetIds)
      && this.auth.hasCapability(session, 'downloadOriginal');
    const base = `/api/collab/assets/${encodeURIComponent(String(asset.id))}/media`;
    const metadata = safe.metadata && typeof safe.metadata === 'object' ? { ...safe.metadata } : {};
    for (const key of DERIVED_URL_FIELDS) delete metadata[key];
    delete metadata.uploadFinalization;
    delete metadata.uploadAuthorization;
    const hasThumbnail = Boolean(asset.metadata?.thumbnailUrl || asset.metadata?.firstFrameUrl
      || asset.metadata?.waveformUrl || asset.metadata?.modelPreviewUrl);
    const hasPreview = Boolean(asset.metadata?.proxyUrl || asset.metadata?.videoProxyUrl
      || asset.metadata?.audioProxyUrl || hasThumbnail);
    if (canPreview && hasPreview) {
      metadata.previewUrl = `${base}?representation=preview`;
      if (hasThumbnail) metadata.thumbnailUrl = `${base}?representation=thumbnail`;
    }
    const publicValue = {
      ...safe,
      metadata,
      sourceUrl: canPreview && hasPreview ? base : null,
      effectivePermissions: {
        view: this.canSessionAccessAsset(session, asset, 'view', allowedAssetIds),
        preview: canPreview,
        original: canOriginal,
        organize: this.canSessionAccessAsset(session, asset, 'organize', allowedAssetIds),
      },
      representations: {
        ...(canPreview && hasPreview ? { preview: base } : {}),
        ...(canPreview && hasThumbnail ? { thumbnail: `${base}?representation=thumbnail` } : {}),
        ...(canOriginal ? { original: `${base}?download=1` } : {}),
      },
    };
    return this.publicReviewVisibleValue(session, publicValue);
  }

  _resolveSafeFile(candidate, roots) {
    if (!candidate) return null;
    try {
      const requested = path.resolve(String(candidate));
      if (!fs.existsSync(requested)) return null;
      const filename = fs.realpathSync.native(requested);
      const allowed = roots
        .filter(Boolean)
        .filter((root) => fs.existsSync(root))
        .map((root) => fs.realpathSync.native(path.resolve(root)));
      if (!allowed.some((root) => filesystemPathWithin(root, filename))) return null;
      const stat = fs.statSync(filename);
      return stat.isFile() ? { filename, stat } : null;
    } catch (_) {
      return null;
    }
  }

  _derivedUrlToFile(value) {
    const raw = String(value || '').split(/[?#]/)[0];
    const prefixes = ['/files/thumbnails/', '/thumbnails/'];
    const prefix = prefixes.find((entry) => raw.startsWith(entry));
    if (!prefix) return null;
    try {
      const segments = raw.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent);
      if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'))) return null;
      return this._resolveSafeFile(path.join(this.config.THUMBNAILS_DIR, ...segments), [this.config.THUMBNAILS_DIR, this.config.ASSET_PREVIEWS_DIR]);
    } catch (_) {
      return null;
    }
  }

  _resolveAssetRepresentation(asset, representation, allowOriginalFallback = false) {
    const metadata = asset?.metadata && typeof asset.metadata === 'object' ? asset.metadata : {};
    if (representation === 'original') {
      const original = this._resolveSafeFile(asset?.managedPath, [this.config.INPUT_DIR, this.config.OUTPUT_DIR, this.config.ASSET_BLOB_DIR]);
      return original ? { ...original, mimeType: asset.mimeType || mimeTypeForFilename(original.filename) } : null;
    }
    const thumbnailKeys = ['thumbnailUrl', 'firstFrameUrl', 'waveformUrl', 'modelPreviewUrl', 'contactSheetUrl'];
    const previewKeys = asset?.kind === 'video'
      ? ['proxyUrl', 'videoProxyUrl', ...thumbnailKeys]
      : asset?.kind === 'audio'
        ? ['audioProxyUrl', 'proxyUrl', 'waveformUrl']
        : asset?.kind === 'model3d'
          ? ['modelPreviewUrl', 'thumbnailUrl']
          : ['previewUrl', 'thumbnailUrl', 'modelPreviewUrl', 'firstFrameUrl'];
    const keys = representation === 'thumbnail' ? thumbnailKeys : previewKeys;
    for (const key of keys) {
      const resolved = this._derivedUrlToFile(metadata[key]);
      if (resolved) return { ...resolved, mimeType: mimeTypeForFilename(resolved.filename) };
    }
    if (!allowOriginalFallback) return null;
    const resolved = this._resolveSafeFile(asset?.managedPath, [this.config.INPUT_DIR, this.config.OUTPUT_DIR, this.config.ASSET_BLOB_DIR]);
    return resolved ? { ...resolved, mimeType: asset.mimeType || mimeTypeForFilename(resolved.filename) } : null;
  }

  readConnectionRecoveryGeneration(state) {
    try {
      return Object.freeze({
        generation: this.database.getRecoveryGeneration(),
        requiresSnapshot: this.database.requiresRecoveryGeneration(),
      });
    } catch (_) {
      // Generation reads run inside a WebSocket EventEmitter callback. Never
      // let a sidecar durability failure escape that callback: fail only this
      // connection closed with a public retry signal and no internal details.
      this.closeConnections((candidate) => candidate === state, RECOVERY_GENERATION_WS_REASON, {
        code: WS_CLOSE_RECOVERY_GENERATION_UNAVAILABLE,
        messageType: 'canvas.generation-unavailable',
      });
      return null;
    }
  }

  refreshConnectionSession(webSocket, state) {
    if (!state?.sessionToken) {
      this.closeConnections((candidate) => candidate === state, 'session unavailable', {
        code: WS_CLOSE_SESSION_REVOKED,
        messageType: 'session.revoked',
      });
      return null;
    }
    let session = null;
    try {
      session = this.auth.authenticate(state.sessionToken);
    } catch (_) {
      // Authentication refresh runs inside WebSocket EventEmitter listeners
      // and broadcast loops. A database read failure must close only this
      // connection with a safe retry signal, never escape and terminate the
      // host process or expose the underlying SQLite error.
      this.closeConnections((candidate) => candidate === state, 'session refresh temporarily unavailable', {
        code: WS_CLOSE_SESSION_REFRESH_UNAVAILABLE,
        messageType: 'session.refresh-unavailable',
      });
      return null;
    }
    if (!session) {
      this.closeConnections((candidate) => candidate === state, 'session revoked', {
        code: WS_CLOSE_SESSION_REVOKED,
        messageType: 'session.revoked',
      });
      return null;
    }
    if (state.canvasId && String(state.canvasId) !== String(session.canvasId || '')) {
      this.closeConnections((candidate) => candidate === state, 'canvas scope changed', {
        code: WS_CLOSE_SESSION_CHANGED,
        messageType: 'session.changed',
      });
      return null;
    }
    let resourceScope = null;
    try {
      resourceScope = this.canvasResourceScope(session);
    } catch (_) {
      this.closeConnections((candidate) => candidate === state, 'session refresh temporarily unavailable', {
        code: WS_CLOSE_SESSION_REFRESH_UNAVAILABLE,
        messageType: 'session.refresh-unavailable',
      });
      return null;
    }
    if (!resourceScope.ready) {
      this.closeConnections((candidate) => candidate === state, 'resource scope unavailable', {
        code: WS_CLOSE_RESOURCE_SCOPE,
        messageType: 'resource.scope-unavailable',
      });
      return null;
    }
    state.session = session;
    return session;
  }

  notifyCommitted(label, callback) {
    return runCommittedNotification(label, callback);
  }

  sendSocketJsonBestEffort(webSocket, label, buildMessage) {
    let sent = false;
    this.notifyCommitted(`socket.${label}`, () => {
      const message = buildMessage();
      if (!message) return;
      webSocket.send(JSON.stringify({ ...message, timestamp: Date.now() }));
      sent = true;
    });
    return sent;
  }

  sendAssetScoped(projectId, canvasId, buildMessage) {
    let sent = 0;
    for (const [webSocket, state] of this.connections.entries()) {
      if (this.sendSocketJsonBestEffort(webSocket, 'asset-scoped', () => {
        if (webSocket.readyState !== WebSocket.OPEN || state.canvasId !== canvasId) return null;
        const session = this.refreshConnectionSession(webSocket, state);
        if (!session || String(session.projectId) !== String(projectId)) return null;
        return buildMessage(session);
      })) sent += 1;
    }
    return sent;
  }

  createApp(allowedOriginsProvider = null) {
    const app = express();
    this.applicationLifecycle.install(app);
    const resolveAllowedOrigins = typeof allowedOriginsProvider === 'function'
      ? allowedOriginsProvider
      : () => this.collaborationAllowedOrigins();
    app.disable('x-powered-by');
    app.set('trust proxy', this.trustedProxyAddresses.size > 0
      ? (address) => this.trustedProxyAddresses.has(normalizeNetworkAddress(address))
      : false);
    const collaborationRateLimiter = (options) => rateLimiter({
      ...options,
      maxBuckets: this.rateLimitMaxBuckets,
      keyResolver: (req) => requestClientAddress(req, this.trustedProxyAddresses),
    });
    const tieredRequestRateLimiter = ({ limiters, code, message, units = () => 1 }) => (
      (req, res, next) => {
        const result = consumeTieredWindowBudget(
          this.requestRateLimitEntries(req, limiters),
          units(req),
        );
        if (result.allowed) return next();
        return sendCollaborationRateLimit(res, result, { code, message });
      }
    );
    const inviteRedeemRateLimiter = (req, res, next) => {
      const result = consumeTieredWindowBudget([
        {
          dimension: 'ip',
          limiter: this.inviteRedeemLimiters.ip,
          key: requestClientAddress(req, this.trustedProxyAddresses),
        },
        {
          dimension: 'invite',
          limiter: this.inviteRedeemLimiters.code,
          key: collaborationInviteBudgetKey(req.body?.code),
        },
      ]);
      if (result.allowed) return next();
      return sendCollaborationRateLimit(res, result, {
        code: 'collaboration_invite_redeem_rate_limited',
        message: '邀请兑换请求过于频繁，请稍后再试',
      });
    };
    const uploadRequestRateLimiter = tieredRequestRateLimiter({
      limiters: this.uploadRequestLimiters,
      code: 'collaboration_upload_request_rate_limited',
      message: '素材上传请求过于频繁，请稍后再试',
    });
    const uploadByteRateLimiter = tieredRequestRateLimiter({
      limiters: this.uploadByteLimiters,
      code: 'collaboration_upload_bytes_rate_limited',
      message: '素材上传流量超过当前预算，请稍后继续',
      units: (req) => Math.max(1, Buffer.isBuffer(req.body) ? req.body.length : 1),
    });
    const downloadRequestRateLimiter = tieredRequestRateLimiter({
      limiters: this.downloadRequestLimiters,
      code: 'collaboration_download_request_rate_limited',
      message: '素材下载请求过于频繁，请稍后再试',
    });
    const collaborationSessionHeartbeatLimiter = createFixedWindowLimiter({
      limit: 12,
      windowMs: 60_000,
      maxBuckets: this.rateLimitMaxBuckets,
    });
    const collaborationSessionHeartbeatRateLimiter = (req, res, next) => {
      const result = collaborationSessionHeartbeatLimiter.consume(
        String(req.collaborationSession?.id || 'invalid-session'),
      );
      if (result.allowed) return next();
      return sendCollaborationRateLimit(res, { ...result, dimension: 'session' }, {
        code: 'collaboration_session_heartbeat_rate_limited',
        message: '协作会话心跳请求过于频繁，请稍后再试',
      });
    };
    app.use(securityHeaders);
    app.use((req, res, next) => {
      if (isCollaborationCanvasSyncPath(req)) res.set('Cache-Control', 'no-store');
      next();
    });
    app.use((req, res, next) => {
      if (!isCollaborationSessionHeartbeatPath(req)) return next();
      res.set('Cache-Control', 'no-store');
      if (String(req.get('sec-fetch-site') || '').trim().toLowerCase() === 'cross-site') {
        return res.status(403).json({
          success: false,
          code: 'collaboration_session_heartbeat_cross_site_forbidden',
          error: '跨站协作会话心跳请求已被拒绝',
        });
      }
      return next();
    });
    app.use((req, res, next) => {
      const origin = String(req.get('origin') || '').trim();
      if (!originAllowed(origin, resolveAllowedOrigins())) {
        return res.status(403).json({ success: false, error: '请求 Origin 不在协作白名单中' });
      }
      if (origin) {
        const normalizedOrigin = normalizeRequestOrigin(origin);
        res.vary('Origin');
        res.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
        res.locals.collaborationCorsOrigin = normalizedOrigin;
      }
      next();
    });
    app.use((req, res, next) => {
      if (!isCollaborationSessionHeartbeatPath(req)) return next();
      const method = String(req.method || '').toUpperCase();
      if (method !== 'POST' && method !== 'OPTIONS') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({
          success: false,
          code: 'collaboration_session_heartbeat_method_not_allowed',
          error: '协作会话心跳只接受 POST',
        });
      }
      return next();
    });
    app.use('/api/collab', collaborationRateLimiter({ limit: 600, windowMs: 60_000 }));
    app.options('/api/collab/session/heartbeat', (req, res) => {
      const requestedMethod = String(req.get('access-control-request-method') || '').trim().toUpperCase();
      if (requestedMethod && requestedMethod !== 'POST') {
        return res.status(403).json({
          success: false,
          code: 'collaboration_session_heartbeat_preflight_forbidden',
          error: '预检请求方法未获允许',
        });
      }
      const requestedHeaders = String(req.get('access-control-request-headers') || '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (requestedHeaders.some((header) => header !== 'content-type')) {
        return res.status(403).json({
          success: false,
          code: 'collaboration_session_heartbeat_preflight_forbidden',
          error: '预检请求头未获允许',
        });
      }
      res.setHeader('Allow', 'POST');
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      if (requestedHeaders.length) res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    });
    app.options(['/api/collab', '/api/collab/*'], (req, res, next) => {
      if (!res.locals.collaborationCorsOrigin) return next();
      const requestedMethod = String(req.get('access-control-request-method') || '').trim().toUpperCase();
      const allowedMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
      if (!allowedMethods.has(requestedMethod)) {
        return res.status(403).json({ success: false, error: '预检请求方法未获允许' });
      }
      const requestedHeaders = String(req.get('access-control-request-headers') || '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (requestedHeaders.some((header) => !COLLABORATION_CORS_ALLOWED_HEADERS.includes(header))) {
        return res.status(403).json({ success: false, error: '预检请求头未获允许' });
      }
      res.setHeader('Access-Control-Allow-Methods', [...allowedMethods].join(', '));
      if (requestedHeaders.length) {
        const requestedHeaderSet = new Set(requestedHeaders);
        res.setHeader(
          'Access-Control-Allow-Headers',
          COLLABORATION_CORS_ALLOWED_HEADERS
            .filter((header) => requestedHeaderSet.has(header))
            .map((header) => COLLABORATION_CORS_HEADER_NAMES[header])
            .join(', '),
        );
      }
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    });
    const collaborationSessionHeartbeatJsonParser = express.json({
      limit: MAX_COLLABORATION_SESSION_HEARTBEAT_BYTES,
      strict: true,
      type: 'application/json',
    });
    app.use((req, res, next) => {
      if (req.method !== 'POST' || !isCollaborationSessionHeartbeatPath(req)) return next();
      const contentEncoding = String(req.get('content-encoding') || '').trim().toLowerCase();
      if (contentEncoding && contentEncoding !== 'identity') {
        return res.status(415).json({
          success: false,
          code: 'collaboration_session_heartbeat_encoding_unsupported',
          error: '协作会话心跳不接受压缩请求体',
        });
      }
      const contentType = String(req.get('content-type') || '').trim();
      const supportedContentType = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i
        .test(contentType);
      if (!supportedContentType) {
        return res.status(415).json({
          success: false,
          code: 'collaboration_session_heartbeat_content_type_unsupported',
          error: '协作会话心跳必须使用 application/json（UTF-8）',
        });
      }
      const contentLength = Number(req.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_COLLABORATION_SESSION_HEARTBEAT_BYTES) {
        return res.status(413).json({
          success: false,
          code: 'collaboration_session_heartbeat_too_large',
          error: '协作会话心跳请求超过 4 KiB',
        });
      }
      return collaborationSessionHeartbeatJsonParser(req, res, (error) => {
        if (!error) return next();
        const tooLarge = error?.type === 'entity.too.large';
        const unsupportedCharset = error?.type === 'charset.unsupported';
        return res.status(tooLarge ? 413 : unsupportedCharset ? 415 : 400).json({
          success: false,
          code: tooLarge
            ? 'collaboration_session_heartbeat_too_large'
            : unsupportedCharset
              ? 'collaboration_session_heartbeat_content_type_unsupported'
              : 'collaboration_session_heartbeat_invalid',
          error: tooLarge
            ? '协作会话心跳请求超过 4 KiB'
            : unsupportedCharset
              ? '协作会话心跳必须使用 application/json（UTF-8）'
              : '协作会话心跳请求格式无效',
        });
      });
    });
    const collaborationAgentJsonParser = express.json({ limit: '64kb', strict: true });
    app.use((req, res, next) => {
      if (req.method !== 'POST' || !/^\/api\/collab\/canvases\/[^/]+\/agent\/tools\/?$/.test(req.path)) return next();
      const contentLength = Number(req.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_CANVAS_AGENT_REQUEST_BYTES) {
        return res.status(413).json({ success: false, code: 'agent_request_too_large', error: 'Agent 工具请求超过 64 KiB' });
      }
      return collaborationAgentJsonParser(req, res, (error) => {
        if (!error) return next();
        const tooLarge = error?.type === 'entity.too.large';
        return res.status(tooLarge ? 413 : 400).json({
          success: false,
          code: tooLarge ? 'agent_request_too_large' : 'agent_request_invalid',
          error: tooLarge ? 'Agent 工具请求超过 64 KiB' : 'Agent 工具请求格式无效',
        });
      });
    });
    app.use(express.json({ limit: '2mb', strict: true }));
    app.use((req, res, next) => {
      try {
        inspectJsonComplexity(req.body);
        next();
      } catch (error) {
        res.status(400).json({ success: false, error: error?.message || String(error) });
      }
    });

    app.get('/api/collab/status', (_req, res) => {
      res.json({
        success: true,
        data: {
          service: 't8-collaboration-gateway',
          running: Boolean(this.server?.listening),
          privateBackendExposed: false,
        },
      });
    });

    app.get('/api/collab/health', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        success: true,
        data: {
          service: 't8-collaboration-gateway',
          running: Boolean(this.server?.listening),
        },
      });
    });

    app.put(
      '/api/collab/self-check/upload',
      express.raw({ type: 'application/octet-stream', limit: PUBLIC_SELF_CHECK_MAX_UPLOAD_BYTES }),
      (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const challenge = this.publicSelfCheckChallenges.consume(
          req.get(PUBLIC_SELF_CHECK_HEADER),
          'upload',
        );
        if (!challenge || !Buffer.isBuffer(req.body)) return res.status(404).end();
        const sha256 = crypto.createHash('sha256').update(req.body).digest('hex');
        if (req.body.length !== Number(challenge.payload?.bytes)
          || sha256 !== String(challenge.payload?.sha256 || '')) return res.status(422).end();
        return res.json({ success: true, data: { bytes: req.body.length } });
      },
    );

    app.get('/api/collab/self-check/range', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const challenge = this.publicSelfCheckChallenges.consume(
        req.get(PUBLIC_SELF_CHECK_HEADER),
        'range',
      );
      const body = challenge?.payload?.body;
      if (!Buffer.isBuffer(body)) return res.status(404).end();
      const range = parseRangeHeader(req.get('range'), body.length);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', 'application/octet-stream');
      if (!range) {
        res.setHeader('Content-Range', `bytes */${body.length}`);
        return res.status(416).end();
      }
      const selected = body.subarray(range.start, range.end + 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${body.length}`);
      res.setHeader('Content-Length', selected.length);
      return res.end(selected);
    });

    app.post('/api/collab/invites/redeem', inviteRedeemRateLimiter, (req, res) => {
        const selfCheckToken = req.get(PUBLIC_SELF_CHECK_HEADER);
        if (selfCheckToken) {
          res.setHeader('Cache-Control', 'no-store');
          const challenge = this.publicSelfCheckChallenges.consume(selfCheckToken, 'invite');
          if (!challenge || req.body?.code !== PUBLIC_SELF_CHECK_INVITE_CODE) return res.status(404).end();
          return res.json({ success: true, data: { selfCheck: true } });
        }
        const redeemed = this.auth.redeemInvite(req.body?.code, req.body?.displayName, {
          canvasId: req.body?.canvasId,
        });
        if (!redeemed) return res.status(400).json({ success: false, error: '邀请无效、已过期或使用次数已满' });
        res.setHeader('Set-Cookie', sessionCookie(redeemed.token, req));
        res.json({
          success: true,
          data: {
            projectId: redeemed.projectId,
            canvasId: redeemed.canvasId,
            memberId: redeemed.memberId,
            displayName: redeemed.displayName,
            role: redeemed.role,
            capabilities: redeemed.capabilities,
            authorizationEpoch: redeemed.authorizationEpoch,
            expiresAt: redeemed.expiresAt,
          },
        });
    });

    app.use('/api/collab', this.requireSession.bind(this));

    app.post(
      '/api/collab/session/heartbeat',
      collaborationSessionHeartbeatRateLimiter,
      (req, res) => {
        try {
          const expectedIdentity = collaborationSessionHeartbeatIdentity(req.body);
          if (!collaborationSessionHeartbeatIdentityMatches(req.collaborationSession, expectedIdentity)) {
            throw collaborationGatewayError(
              'collaboration_session_heartbeat_identity_conflict',
              '协作会话身份或授权版本已经变化，请先刷新会话',
              409,
            );
          }
          const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
          const result = this.auth.heartbeat(token, expectedIdentity);
          if (!result) {
            return res.status(401).json({
              success: false,
              code: 'collaboration_session_heartbeat_unauthorized',
              error: '协作会话无效、已撤销或已过期',
            });
          }
          if (typeof result.touched !== 'boolean'
            || !Number.isSafeInteger(result.lastSeenAt)
            || !Number.isSafeInteger(result.nextHeartbeatAt)
            || result.lastSeenAt < 1
            || result.nextHeartbeatAt <= result.lastSeenAt) {
            throw collaborationGatewayError(
              'collaboration_session_heartbeat_state_invalid',
              '协作会话活动时间状态无效',
              500,
            );
          }
          return res.json({
            success: true,
            data: {
              touched: result.touched,
              lastSeenAt: result.lastSeenAt,
              nextHeartbeatAt: result.nextHeartbeatAt,
            },
          });
        } catch (error) {
          return sendCollaborationSessionHeartbeatError(res, error);
        }
      },
    );

    app.get('/api/collab/session', (req, res) => {
      res.json({ success: true, data: req.collaborationSession });
    });

    app.post('/api/collab/logout', async (req, res) => {
      this.auth.revoke(req.collaborationSession.id, {
        actorId: req.collaborationSession.memberId,
        sessionId: req.collaborationSession.id,
        expectedProjectId: req.collaborationSession.projectId,
      });
      await this.uploadManager.cancelAuthenticationSession(req.collaborationSession.id).catch(() => 0);
      this.closeSessionConnections(req.collaborationSession.id, 'signed out');
      res.setHeader('Set-Cookie', clearSessionCookie(req));
      res.json({ success: true });
    });

    // Host artifact authority never exists on the public collaboration
    // surface. Deny a single-domain host batch before resource-scope state can
    // turn the response into an oracle or a non-deterministic status.
    app.use('/api/collab/common-operations', (req, res, next) => {
      const operations = req.method === 'POST' && Array.isArray(req.body?.operations)
        ? req.body.operations
        : [];
      if (operations.length > 0
        && operations.every((operation) => operation?.type === 'host.artifact.commit')) {
        return sendPublicHostArtifactForbidden(res);
      }
      return next();
    });

    app.use('/api/collab', this.requireReadyResourceScope.bind(this));
    app.use('/api/collab', this.requireDurableMutationGeneration.bind(this));

    app.post('/api/collab/session/rotate', async (req, res) => {
      const previousSessionId = req.collaborationSession.id;
      const rotated = this.auth.rotate(req.collaborationSession);
      if (!rotated) return res.status(401).json({ success: false, error: '协作会话无法轮换' });
      res.setHeader('Set-Cookie', sessionCookie(rotated.token, req));
      const { token: _token, ...session } = rotated;
      await this.uploadManager.cancelAuthenticationSession(previousSessionId).catch(() => 0);
      this.closeConnections(
        (state) => String(state?.session?.id || '') === String(previousSessionId),
        'session rotated',
        { code: WS_CLOSE_SESSION_CHANGED, messageType: 'session.changed' },
      );
      res.json({ success: true, data: session });
    });

    app.get('/api/collab/canvases', (req, res) => {
      const document = this.ensureCanvasAccess(
        req.collaborationSession,
        req.collaborationSession.canvasId,
      );
      const canvases = document
        ? this.database.listCanvases(req.collaborationSession.projectId)
          .filter((canvas) => String(canvas.id) === String(document.canvasId))
        : [];
      res.json({
        success: true,
        data: publicCollaborationCanvasValue(canvases),
      });
    });

    app.get('/api/collab/canvases/:canvasId', (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
      try {
        this.assertDocumentResourcesGranted(req.collaborationSession, document);
        res.set('ETag', `"${document.revision}"`);
        res.json({
          success: true,
          data: this.publicReviewVisibleValue(
            req.collaborationSession,
            publicCanvasDocument(document),
          ),
        });
      } catch (error) {
        return sendCanvasPatchError(res, error);
      }
    });

    app.get('/api/collab/canvases/:canvasId/sync', (req, res) => {
      res.set('Cache-Control', 'no-store');
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) {
        return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
      }
      const afterRevision = parseHttpAfterRevision(req.query?.afterRevision);
      if (afterRevision == null) {
        return res.status(400).json({
          success: false,
          code: 'canvas_revision_invalid',
          error: 'afterRevision 必须是非负安全整数',
        });
      }
      const requestedGeneration = parseRecoveryGeneration(req.query?.generation);
      if (!requestedGeneration.valid) {
        return res.status(400).json({
          success: false,
          code: 'canvas_generation_invalid',
          error: 'generation 必须是 UUID',
        });
      }
      try {
        this.assertDocumentResourcesGranted(req.collaborationSession, document);
        let sync = this.database.syncCanvas(
          req.params.canvasId,
          afterRevision,
          500,
          requestedGeneration.generation,
        );
        if (sync?.mode === 'operations' && Array.isArray(sync.operations)) {
          try {
            this.assertDocumentResourcesGranted(req.collaborationSession, {
              projectId: document.projectId,
              canvasId: document.canvasId,
              revision: document.revision,
              nodes: [],
              edges: [],
              collaborationOperations: sync.operations,
            });
          } catch (_) {
            sync = {
              mode: 'snapshot',
              canvasId: document.canvasId,
              afterRevision,
              revision: document.revision,
              generation: sync.generation,
              reason: 'resource_scope_snapshot',
              document,
            };
          }
        }
        res.json({
          success: true,
          data: this.publicReviewVisibleValue(
            req.collaborationSession,
            publicCanvasSync(sync, document),
          ),
        });
      } catch (error) {
        return sendCanvasPatchError(res, error);
      }
    });

    app.post('/api/collab/canvases/:canvasId/agent/tools', collaborationRateLimiter({ limit: 60, windowMs: 60_000 }), (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, code: 'agent_scope_not_found', error: 'Agent 工具目标不存在或不属于当前项目' });
      try {
        const raw = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_CANVAS_AGENT_REQUEST_BYTES) {
          return res.status(413).json({ success: false, code: 'agent_request_too_large', error: 'Agent 工具请求超过 64 KiB' });
        }
        const resourceScope = this.canvasResourceScope(req.collaborationSession);
        if (!resourceScope.ready) {
          throw this.canvasResourceError(
            'canvas_resource_scope_stale',
            '协作资源授权状态尚未初始化或需要主机重新同步',
            409,
          );
        }
        const data = executeCanvasAgentTool(
          this.collaborationAgentDatabase(req.collaborationSession, resourceScope),
          {
          ...raw,
          projectId: req.collaborationSession.projectId,
          canvasId: document.canvasId,
          },
          {
            projectId: req.collaborationSession.projectId,
            canvasId: document.canvasId,
            actorId: req.collaborationSession.memberId,
            sessionId: req.collaborationSession.id,
            role: req.collaborationSession.role,
            capabilities: req.collaborationSession.capabilities,
          },
        );
        return res.json({
          success: true,
          data: this.publicReviewVisibleValue(req.collaborationSession, data),
        });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'agent_tool_failed',
          fallbackMessage: 'Agent 只读工具执行失败',
        });
      }
    });

    app.post('/api/collab/canvases/:canvasId/patches/preview', (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, code: 'canvas_not_found', error: '画布不存在或无权访问' });
      try {
        const context = {
          projectId: req.collaborationSession.projectId,
          canvasId: document.canvasId,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
        };
        const patch = scopeCanvasPatch(req.body?.patch, context);
        const preview = this.database.previewCanvasPatch(document.canvasId, patch, {
          actorId: context.actorId,
          sessionId: context.sessionId,
          projectId: context.projectId,
          authority: canvasPatchAuthorityForSession(req.collaborationSession),
          assertResultingDocument: (resultingDocument) => this.assertDocumentResourcesGranted(
            req.collaborationSession,
            resultingDocument,
          ),
        });
        res.json({ success: true, data: preview });
      } catch (error) {
        return sendCanvasPatchError(res, error);
      }
    });

    app.get('/api/collab/canvases/:canvasId/patches', (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, code: 'canvas_not_found', error: '画布不存在或无权访问' });
      try {
        const limit = Math.min(100, Math.max(1, Math.trunc(Number(req.query?.limit) || 50)));
        const patches = this.database.listCanvasPatches(document.canvasId, {
          actorId: req.collaborationSession.memberId,
          limit,
        });
        res.json({ success: true, data: patches });
      } catch (error) {
        return sendCanvasPatchError(res, error);
      }
    });

    app.post('/api/collab/canvases/:canvasId/patches', this.requireCapability('editGraph'), (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, code: 'canvas_not_found', error: '画布不存在或无权访问' });
      try {
        const context = {
          projectId: req.collaborationSession.projectId,
          canvasId: document.canvasId,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
        };
        const patch = scopeCanvasPatch(req.body?.patch, context);
        const result = this.database.applyCanvasPatch(document.canvasId, patch, {
          previewDigest: req.body?.previewDigest,
          confirmed: req.body?.confirmed === true,
          actorId: context.actorId,
          sessionId: context.sessionId,
          projectId: context.projectId,
          authority: canvasPatchAuthorityForSession(req.collaborationSession),
          syncResourceGrants: false,
          assertResultingDocument: (resultingDocument) => this.assertDocumentResourcesGranted(
            req.collaborationSession,
            resultingDocument,
          ),
        });
        this.assertDocumentResourcesGranted(req.collaborationSession, result.document);
        if (!result.duplicate) {
          this.notifyCommitted('canvas.patch.applied', () => {
            this.broadcast(context.projectId, document.canvasId, publicCanvasPatchEvent(
              result,
              patch.id,
              'applied',
              context.actorId,
            ));
          });
        }
        res.json({ success: true, data: publicCanvasMutationResult(result) });
      } catch (error) {
        return sendCanvasPatchError(res, error);
      }
    });

    app.post('/api/collab/canvases/:canvasId/patches/:patchId/revert', this.requireCapability('editGraph'), (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, code: 'canvas_not_found', error: '画布不存在或无权访问' });
      try {
        const result = this.database.revertCanvasPatch(document.canvasId, req.params.patchId, {
          expectedRevision: req.body?.expectedRevision ?? req.body?.baseRevision,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
          projectId: req.collaborationSession.projectId,
          authority: canvasPatchAuthorityForSession(req.collaborationSession),
          syncResourceGrants: false,
          assertResultingDocument: (resultingDocument) => this.assertDocumentResourcesGranted(
            req.collaborationSession,
            resultingDocument,
          ),
        });
        if (!result.duplicate) {
          this.notifyCommitted('canvas.patch.reverted', () => {
            this.broadcast(req.collaborationSession.projectId, document.canvasId, publicCanvasPatchEvent(
              result,
              req.params.patchId,
              'reverted',
              req.collaborationSession.memberId,
            ));
          });
        }
        res.json({ success: true, data: publicCanvasMutationResult(result) });
      } catch (error) {
        return sendCanvasPatchError(res, error);
      }
    });

    app.get('/api/collab/subflows', (req, res) => {
      const scope = this.canvasResourceScope(req.collaborationSession);
      const definitions = this.canvasScopedSubflowDefinitions(
        req.collaborationSession,
        req.query?.query,
        scope,
      );
      res.json({
        success: true,
        data: this.publicReviewVisibleValue(
          req.collaborationSession,
          definitions.map((definition) => publicSubflowDefinition(definition)),
        ),
      });
    });

    app.get('/api/collab/subflows/:id/versions', (req, res) => {
      if (!this.sessionCanAccessSubflow(req.collaborationSession, req.params.id)) {
        return res.status(404).json({ success: false, error: '子工作流定义不存在或无权访问' });
      }
      const allowedVersions = this.canvasResourceScope(req.collaborationSession)
        .subflowReferences.get(String(req.params.id)) || new Set();
      const definitions = this.database.listSubflowVersions(
        req.params.id,
        req.collaborationSession.projectId,
      ).filter((definition) => allowedVersions.has(Number(definition.version)));
      res.json({
        success: true,
        data: this.publicReviewVisibleValue(
          req.collaborationSession,
          definitions.map((definition) => publicSubflowDefinition(definition)),
        ),
      });
    });

    app.get('/api/collab/subflows/:id/:version', (req, res) => {
      if (!this.sessionCanAccessSubflow(req.collaborationSession, req.params.id, req.params.version)) {
        return res.status(404).json({ success: false, error: '子工作流定义不存在或无权访问' });
      }
      const definition = this.database.getSubflowDefinition(req.params.id, req.params.version, req.collaborationSession.projectId);
      if (!definition) return res.status(404).json({ success: false, error: '子工作流定义不存在或无权访问' });
      res.json({
        success: true,
        data: this.publicReviewVisibleValue(
          req.collaborationSession,
          publicSubflowDefinition(definition),
        ),
      });
    });

    app.post('/api/collab/subflow-upgrade-plans', this.requireCapability('editGraph'), (req, res) => {
      try {
        const ticket = this.createSubflowUpgradePlan(req.collaborationSession, req.body);
        return res.json({
          success: true,
          data: publicCollaborationCanvasValue(ticket),
        });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'collaboration_subflow_plan_invalid',
          fallbackMessage: '子工作流升级规划请求无效',
        });
      }
    });

    app.post('/api/collab/subflows/:id/publish', this.requireCapability('publishSubflow'), (req, res) => {
      try {
        if (!this.sessionCanAccessSubflow(req.collaborationSession, req.params.id)) {
          return res.status(404).json({ success: false, error: '子工作流定义不存在或无权访问' });
        }
        const baseRevision = Number(req.body?.baseRevision);
        if (!Number.isInteger(baseRevision) || baseRevision < 0) throw new Error('发布子工作流必须提供有效 baseRevision');
        const changeSummary = normalizeSubflowChangeSummary(req.body?.changeSummary, { required: true });
        const source = req.body?.definition;
        if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('子工作流定义无效');
        const definition = {
          ...source,
          id: String(req.params.id),
          projectId: req.collaborationSession.projectId,
        };
        validateSubflowDefinition(definition);
        this.assertDocumentResourcesGranted(req.collaborationSession, {
          ...definition,
          canvasId: req.collaborationSession.canvasId,
          revision: this.ensureCanvasAccess(
            req.collaborationSession,
            req.collaborationSession.canvasId,
          )?.revision,
        }, {
          validateRootSubflowDefinition: false,
        });
        const saved = this.database.saveSubflowDefinition(definition, {
          expectedRevision: baseRevision,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
          changeSummary,
          grantCanvasId: req.collaborationSession.canvasId,
        });
        const publication = publicCollaborationCanvasValue(publicSubflowPublication(saved));
        this.notifyCommitted('subflow.published', () => {
          this.broadcast(saved.projectId, req.collaborationSession.canvasId, {
            type: 'subflow.published',
            canvasId: req.collaborationSession.canvasId,
            publication,
          });
        });
        res.status(201).json({ success: true, data: publicSubflowDefinition(saved) });
      } catch (error) {
        if (error instanceof SubflowRevisionConflictError) {
          return res.status(409).json({
            success: false,
            code: error.code,
            error: error.message,
            data: publicSubflowRevisionConflict(error.current),
          });
        }
        res.status(400).json({ success: false, error: error?.message || String(error) });
      }
    });

    app.get('/api/collab/canvases/:canvasId/history', (req, res) => {
      if (!this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId)) {
        return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
      }
      res.json({
        success: true,
        data: this.publicReviewVisibleValue(
          req.collaborationSession,
          publicCollaborationCanvasValue(
            this.database.listCanvasSnapshots(req.params.canvasId, req.query?.limit),
          ),
        ),
      });
    });

    app.post('/api/collab/canvases/:canvasId/history/:revision/restore', this.requireCapability('editGraph'), (req, res) => {
      try {
        if (!this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId)) {
          return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
        }
        const document = this.database.restoreCanvasSnapshot(req.params.canvasId, req.params.revision, {
          expectedRevision: req.body?.baseRevision,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
          authority: canvasPatchAuthorityForSession(req.collaborationSession),
          syncResourceGrants: false,
          assertResultingDocument: (resultingDocument) => this.assertDocumentResourcesGranted(
            req.collaborationSession,
            resultingDocument,
          ),
        });
        this.notifyCommitted('canvas.snapshot-restored', () => {
          this.broadcast(document.projectId, document.canvasId, {
            type: 'canvas.snapshot-restored',
            canvasId: document.canvasId,
            revision: document.revision,
            sourceRevision: Number(req.params.revision),
            actorId: req.collaborationSession.memberId,
          });
        });
        res.json({ success: true, data: publicCanvasDocument(document) });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'snapshot_restore_invalid',
          fallbackMessage: '历史快照恢复请求无效',
        });
      }
    });

    app.get('/api/collab/canvases/:canvasId/text', (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
      if (this.reviewTextFieldHiddenForSession(req.collaborationSession, req.query?.field)) {
        return res.status(403).json({
          success: false,
          code: 'collaboration_review_visibility_hidden',
          error: '该协同文本字段已由主机对审阅成员隐藏',
        });
      }
      try {
        const result = this.textPersistence.getBindingSnapshot({
          projectId: document.projectId,
          canvasId: document.canvasId,
          targetType: req.query?.targetType,
          targetEntityUid: req.query?.targetEntityUid,
          field: req.query?.field,
        }, {
          memberId: req.collaborationSession.memberId,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
          role: req.collaborationSession.role,
          capabilities: req.collaborationSession.capabilities,
          projectId: req.collaborationSession.projectId,
          canvasId: req.collaborationSession.canvasId,
        });
        res.set('Cache-Control', 'no-store');
        res.set('X-T8-Text-Next-Client-Seq', String(result.nextClientSeq));
        res.json({ success: true, data: result.binding });
      } catch (error) {
        return sendCollaborationTextError(res, error);
      }
    });

    app.get('/api/collab/canvases/:canvasId/text/recovery', (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
      if (this.reviewTextFieldHiddenForSession(req.collaborationSession, req.query?.field)) {
        return res.status(403).json({
          success: false,
          code: 'collaboration_review_visibility_hidden',
          error: '该协同文本恢复内容已由主机对审阅成员隐藏',
        });
      }
      const requiredCapability = String(req.query?.targetType || '') === 'review'
        ? 'comment'
        : 'editGraph';
      if (!this.auth.hasCapability(req.collaborationSession, requiredCapability)) {
        return res.status(403).json({
          success: false,
          code: 'collaboration_text_permission_denied',
          error: '当前成员无权读取该协同文本恢复内容',
        });
      }
      try {
        const recovery = this.textPersistence.getLegacyRecoveryModel({
          projectId: document.projectId,
          canvasId: document.canvasId,
          targetType: req.query?.targetType,
          targetEntityUid: req.query?.targetEntityUid,
          field: req.query?.field,
        }, {
          memberId: req.collaborationSession.memberId,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
          role: req.collaborationSession.role,
          capabilities: req.collaborationSession.capabilities,
          projectId: req.collaborationSession.projectId,
          canvasId: req.collaborationSession.canvasId,
        });
        res.set('Cache-Control', 'no-store');
        return res.json({ success: true, data: recovery });
      } catch (error) {
        return sendCollaborationTextError(res, error);
      }
    });

    app.post('/api/collab/canvases/:canvasId/text/updates', (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
      try {
        if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          && ((Object.prototype.hasOwnProperty.call(req.body, 'projectId')
              && String(req.body.projectId) !== document.projectId)
            || (Object.prototype.hasOwnProperty.call(req.body, 'canvasId')
              && String(req.body.canvasId) !== document.canvasId))) {
          throw collaborationGatewayError(
            'collaboration_text_scope_mismatch',
            '协同文本作用域与当前会话不一致',
            403,
          );
        }
        const result = this.textPersistence.applyUpdate(req.body, {
          principal: {
            memberId: req.collaborationSession.memberId,
            actorId: req.collaborationSession.memberId,
            sessionId: req.collaborationSession.id,
            role: req.collaborationSession.role,
            capabilities: req.collaborationSession.capabilities,
            projectId: req.collaborationSession.projectId,
            canvasId: req.collaborationSession.canvasId,
          },
          syncResourceGrants: false,
          assertResultingDocument: (resultingDocument) => this.assertDocumentResourcesGranted(
            req.collaborationSession,
            resultingDocument,
          ),
        });
        if (!result.duplicate) {
          const operation = result.operation;
          this.notifyCommitted('collaboration.text-update', () => {
            this.broadcast(operation.projectId, operation.canvasId, {
              type: 'collaboration.text-update',
              contractVersion: operation.payload.contractVersion,
              updateId: operation.opId,
              clientSeq: operation.clientSeq,
              projectId: operation.projectId,
              canvasId: operation.canvasId,
              baseRevision: operation.baseRevision,
              revision: result.result.revision,
              targetType: operation.payload.targetType,
              targetEntityUid: operation.payload.targetEntityUid,
              bindingEpoch: operation.payload.bindingEpoch,
              field: operation.payload.field,
              update: operation.payload.update,
              actorId: operation.actorId,
              timestamp: operation.createdAt,
            });
          });
        }
        res.set('Cache-Control', 'no-store');
        res.set('X-T8-Collaboration-Text-Noop', result.noOp === true ? '1' : '0');
        return res.json({ success: true, data: result.result });
      } catch (error) {
        return sendCollaborationTextError(res, error);
      }
    });

    app.post('/api/collab/canvases/:canvasId/operations', this.requireCapability('editGraph'), (req, res) => {
      try {
        const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
        if (!document) {
          return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
        }
        if (req.body?.contractVersion != null) {
          const principal = {
            actorId: req.collaborationSession.memberId,
            sessionId: req.collaborationSession.id,
          };
          const replay = this.database.replayCommonOperationBatch(req.body, principal);
          if (replay) {
            const replayAcknowledgements = exactPublicOperationAcknowledgements(
              replay.acknowledgements,
              replay.operations,
            );
            return res.json({
              success: true,
              data: publicCanvasMutationResult({
                document: replay.document,
                acknowledgements: replayAcknowledgements,
                commonBatch: replay.commonBatch,
              }),
            });
          }
          const adapted = adaptCommonGraphBatch(req.body, document, {
            ...principal,
            timestamp: Date.now(),
          });
          assertCanvasOperationCredentialAuthority(document, adapted.operations, {
            authority: canvasPatchAuthorityForSession(req.collaborationSession),
          });
          const operations = adapted.operations.map((operation) => validateOperation(operation));
          const result = this.database.applyOperations(req.params.canvasId, operations, {
            expectedRevision: adapted.batch.baseRevision,
            commonBatch: adapted.batch,
            requireTimestampIdentity: false,
            syncResourceGrants: false,
            assertResultingDocument: (resultingDocument) => {
              this.assertDocumentResourcesGranted(req.collaborationSession, resultingDocument);
              assertCollaborationStructureAuthority(resultingDocument, operations, {
                previousDocument: document,
                resolveSubflow: (definitionId, version) => this.database.getSubflowDefinition(
                  definitionId,
                  version,
                  req.collaborationSession.projectId,
                ),
              });
            },
          });
          const responseAcknowledgements = exactPublicOperationAcknowledgements(
            result.acknowledgements,
            operations,
          );
          const appliedAcknowledgements = result.acknowledgements.filter((item) => item.duplicate !== true);
          if (appliedAcknowledgements.length > 0) {
            this.notifyCommitted('canvas.operations', () => {
              this.broadcast(req.collaborationSession.projectId, req.params.canvasId, {
                type: 'canvas.operations',
                canvasId: req.params.canvasId,
                revision: result.document.revision,
                operations: appliedAcknowledgements,
                actorId: req.collaborationSession.memberId,
              });
            });
          }
          return res.json({
            success: true,
            data: publicCanvasMutationResult({
              ...result,
              acknowledgements: responseAcknowledgements,
              commonBatch: adapted.batch,
            }),
          });
        }
        const rawOperations = Array.isArray(req.body?.operations) ? req.body.operations : [];
        const baseRevision = requireOperationBatchRevision(req.body?.baseRevision, rawOperations);
        const scopedOperations = rawOperations.map((operation, index) => ({
          ...operation,
          projectId: req.collaborationSession.projectId,
          canvasId: req.params.canvasId,
          baseRevision,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
          clientSeq: Number(operation?.clientSeq) || index,
        }));
        assertCanvasOperationCredentialAuthority(document, scopedOperations, {
          authority: canvasPatchAuthorityForSession(req.collaborationSession),
        });
        const operations = scopedOperations.map((operation) => validateOperation(operation));
        const result = this.database.applyOperations(req.params.canvasId, operations, {
          expectedRevision: baseRevision,
          requireTimestampIdentity: true,
          syncResourceGrants: false,
          assertResultingDocument: (resultingDocument) => {
            this.assertDocumentResourcesGranted(req.collaborationSession, resultingDocument);
            assertCollaborationStructureAuthority(resultingDocument, operations, {
              previousDocument: document,
              resolveSubflow: (definitionId, version) => this.database.getSubflowDefinition(
                definitionId,
                version,
                req.collaborationSession.projectId,
              ),
            });
          },
        });
        const responseAcknowledgements = exactPublicOperationAcknowledgements(
          result.acknowledgements,
          operations,
        );
        const appliedAcknowledgements = result.acknowledgements.filter((item) => item.duplicate !== true);
        if (appliedAcknowledgements.length > 0) {
          this.notifyCommitted('canvas.operations', () => {
            this.broadcast(req.collaborationSession.projectId, req.params.canvasId, {
              type: 'canvas.operations',
              canvasId: req.params.canvasId,
              revision: result.document.revision,
              operations: appliedAcknowledgements,
              actorId: req.collaborationSession.memberId,
            });
          });
        }
        res.json({
          success: true,
          data: publicCanvasMutationResult({
            ...result,
            acknowledgements: responseAcknowledgements,
          }),
        });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'canvas_operation_invalid',
          fallbackMessage: '画布操作请求无效',
        });
      }
    });

    app.post('/api/collab/common-operations', (req, res) => {
      try {
        const batch = normalizeCommonOperationBatch(req.body);
        const domains = new Set(batch.operations.map((operation) => {
          if (COMMON_REVIEW_OPERATION_TYPES.has(operation.type)) return 'review';
          if (operation.type === 'subflow.instance.upgrade') return 'subflow';
          if (operation.type === 'host.artifact.commit') return 'host-artifact';
          return 'graph';
        }));
        if (domains.size !== 1) {
          throw collaborationGatewayError(
            'collaboration_domain_mixed_batch',
            '共同领域操作批次必须全部属于同一领域',
            400,
          );
        }
        const [domain] = domains;
        if (domain === 'host-artifact') {
          return sendPublicHostArtifactForbidden(res);
        }
        const document = this.ensureCanvasAccess(req.collaborationSession, batch.canvasId);
        if (!document) return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
        if (domain === 'graph') {
          throw collaborationGatewayError(
            'collaboration_domain_operation_unsupported',
            '画布结构 common operations 必须使用画布操作端点',
            400,
          );
        }
        if (domain === 'subflow'
          && !this.auth.hasCapability(req.collaborationSession, 'editGraph')) {
          throw collaborationGatewayError(
            'collaboration_domain_capability_missing',
            '已认证成员缺少子工作流升级权限',
            403,
          );
        }
        const principal = {
          memberId: req.collaborationSession.memberId,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
          capabilities: req.collaborationSession.capabilities,
        };
        let result = this.database.replayCommonDomainBatch(batch, principal, domain);
        if (!result && domain === 'review') {
          const scopedAssetIds = this.canvasResourceScope(req.collaborationSession).assetIds;
          const grantedAssets = [...scopedAssetIds]
            .map((assetId) => this.database.getAsset(assetId))
            .filter(Boolean);
          const assets = this.filterSessionAssets(
            req.collaborationSession,
            grantedAssets,
            'view',
            scopedAssetIds,
          );
          result = this.database.applyCommonReviewBatch(batch, {
            principal,
            assets,
            allowedAssetEntityUids: new Set(assets.map((asset) => asset.entityUid).filter(Boolean)),
            reviewMembers: this.database.listMembers(req.collaborationSession.projectId, {
              canvasId: req.collaborationSession.canvasId,
            }),
          });
        } else if (!result && domain === 'subflow') {
          const subflowUpgradePlans = batch.operations.map((operation) => (
            this.issuedSubflowUpgradePlan(req.collaborationSession, batch, operation)
          ));
          result = this.database.applyCommonSubflowBatch(batch, {
            principal,
            subflowUpgradePlans,
            syncResourceGrants: false,
            assertResultingDocument: (resultingDocument) => this.assertDocumentResourcesGranted(
              req.collaborationSession,
              resultingDocument,
            ),
          });
          if (!result.duplicate) {
            this.consumeSubflowUpgradePlans(req.collaborationSession, batch.operations);
          }
        }
        if (domain === 'review' && result.duplicate) {
          // An exact idempotent replay may skip the domain authority's CAS and
          // write validation, but it must never inherit the actor's historical
          // capabilities. Recheck only the operation's minimum current
          // capability so a legitimate replay does not collide with old CAS.
          assertCurrentReviewReplayCapabilities(
            this.auth,
            req.collaborationSession,
            batch,
          );
        }
        const publicResult = domain === 'review'
          ? this.publicReviewVisibleValue(
            req.collaborationSession,
            publicCommonDomainMutationResult(result),
          )
          : publicCommonDomainMutationResult(result);
        if (!result.duplicate) {
          result.commonBatch.operations.forEach((operation, index) => {
            this.notifyCommitted(`collaboration.domain-operation.${domain}`, () => {
              this.broadcast(result.commonBatch.projectId, result.commonBatch.canvasId, {
                type: 'collaboration.domain-operation',
                operationType: operation.type,
                opId: operation.opId,
                result: domain === 'review'
                  ? publicReviewDomainEventResult(operation, result.results[index])
                  : publicResult.results[index],
                ...(domain === 'subflow' ? {
                  revision: publicResult.document.revision,
                  document: publicResult.document,
                } : {}),
                actorId: req.collaborationSession.memberId,
              });
            });
          });
        }
        if (domain === 'review' && !result.duplicate) {
          this.notifyCommitted('review.notification.batch', () => {
            this.dispatchReviewNotifications(
              result.commonBatch.projectId,
              result.commonBatch.canvasId,
              result.notifications,
            );
          });
        }
        return res.json({ success: true, data: publicResult });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'collaboration_domain_operation_invalid',
          fallbackMessage: '共同领域操作请求无效',
        });
      }
    });

    app.get('/api/collab/members', (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({
        success: true,
        data: this.reviewMembersForSession(req.collaborationSession).map((member) => ({
          memberId: member.id,
          displayName: member.displayName,
          role: member.role,
        })),
      });
    });

    app.get('/api/collab/reviews/export', (req, res) => {
      try {
        const requestedCanvasId = String(req.query?.canvasId || req.collaborationSession.canvasId || '');
        const filters = reviewFiltersFromQuery(
          { ...req.query, limit: 100, offset: 0 },
          req.collaborationSession,
        );
        const countFilters = { ...filters };
        delete countFilters.limit;
        delete countFilters.offset;
        const snapshot = this.database.withProjectDatabaseReadSnapshot(
          'collaboration.review.export',
          () => {
            const document = this.ensureCanvasAccess(req.collaborationSession, requestedCanvasId);
            if (!document) return null;
            const materialized = this.database.materializeReviewThreadExport(countFilters, 1000);
            return {
              document,
              tooLarge: materialized.tooLarge,
              threads: materialized.threads
                .map((thread) => this.publicReviewThreadForSession(
                  req.collaborationSession,
                  thread,
                  document,
                ))
                .filter(Boolean)
                .map(reviewThreadExportRecord),
            };
          },
        );
        if (!snapshot) return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
        if (snapshot.tooLarge) {
          return res.status(413).json({
            success: false,
            code: 'collaboration_review_export_too_large',
            error: '审片汇总超过 1000 条，请先缩小筛选范围',
          });
        }
        const { document, threads } = snapshot;
        const format = String(req.query?.format || 'json').toLowerCase();
        res.set('Cache-Control', 'no-store');
        res.set('Content-Disposition', `attachment; filename="review-${encodeURIComponent(document.canvasId)}.${format === 'markdown' ? 'md' : 'json'}"`);
        if (format === 'markdown') {
          return res.type('text/markdown; charset=utf-8').send(reviewThreadsMarkdown(threads, document.canvasId));
        }
        if (format !== 'json') {
          return res.status(400).json({ success: false, error: '导出格式只支持 json 或 markdown' });
        }
        return res.json({
          success: true,
          data: { canvasId: document.canvasId, revision: document.revision, threads },
          meta: { total: threads.length },
        });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'collaboration_review_export_invalid',
          fallbackMessage: '审片汇总导出失败',
        });
      }
    });

    app.get('/api/collab/reviews', (req, res) => {
      try {
        const requestedCanvasId = String(req.query?.canvasId || req.collaborationSession.canvasId || '');
        const filters = reviewFiltersFromQuery(req.query, req.collaborationSession);
        const countFilters = { ...filters };
        delete countFilters.limit;
        delete countFilters.offset;
        const snapshot = this.database.withProjectDatabaseReadSnapshot(
          'collaboration.review.list',
          () => {
            const document = this.ensureCanvasAccess(req.collaborationSession, requestedCanvasId);
            if (!document) return null;
            const records = this.database.listReviewThreads(filters);
            return {
              total: this.database.countReviewThreads(countFilters),
              threads: records
                .map((thread) => this.publicReviewThreadForSession(
                  req.collaborationSession,
                  thread,
                  document,
                ))
                .filter(Boolean),
            };
          },
        );
        if (!snapshot) return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
        res.set('Cache-Control', 'no-store');
        return res.json({
          success: true,
          data: snapshot.threads,
          meta: {
            total: snapshot.total,
            limit: filters.limit,
            offset: filters.offset,
          },
        });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'collaboration_review_query_invalid',
          fallbackMessage: '评论筛选请求无效',
        });
      }
    });

    app.get('/api/collab/reviews/:threadId/compare', (req, res) => {
      try {
        const thread = this.database.getReviewThread(req.params.threadId);
        const document = thread ? this.ensureCanvasAccess(req.collaborationSession, thread.canvasId) : null;
        if (!thread || !document) {
          return res.status(404).json({ success: false, error: '评论线程不存在' });
        }
        const sourceRevision = Number(thread.decisionCanvasRevision || thread.canvasRevision);
        const source = this.database.getCanvasSnapshotDocument(thread.canvasId, sourceRevision);
        if (!source) {
          return res.status(409).json({
            success: false,
            code: 'collaboration_review_snapshot_unavailable',
            error: '该评论对应的精确画布版本已不在本机保留范围内',
          });
        }
        res.set('Cache-Control', 'no-store');
        return res.json({
          success: true,
          data: {
            thread: this.publicReviewThreadForSession(req.collaborationSession, {
              ...thread,
              comments: this.database.listReviewComments(thread.id),
            }, document),
            comparison: boundedReviewDocumentDiff(source, document),
          },
        });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'collaboration_review_compare_invalid',
          fallbackMessage: '评论版本对比失败',
        });
      }
    });

    app.post('/api/collab/reviews', this.requireCapability('comment'), (req, res) => {
      try {
        const document = this.ensureCanvasAccess(req.collaborationSession, req.body?.canvasId);
        if (!document) return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
        const expectedCanvasRevision = requiredReviewRevision(
          req.body?.expectedCanvasRevision,
          'expectedCanvasRevision',
        );
        if (expectedCanvasRevision !== Number(document.revision)) {
          throw collaborationGatewayError(
            'collaboration_review_canvas_cas_conflict',
            '画布版本已经变化，请刷新后重新发布评论',
            409,
          );
        }
        const anchor = req.body?.anchor;
        if (!anchor || typeof anchor !== 'object'
          || !['canvas', 'node', 'edge', 'asset', 'video'].includes(String(anchor.kind))) {
          return res.status(400).json({ success: false, error: '评论锚点无效' });
        }
        const body = String(req.body?.body || '').trim();
        if (!body || body.length > 5000) {
          return res.status(400).json({ success: false, error: '评论正文应为 1-5000 字' });
        }
        if (req.body?.reviewStatus != null && req.body.reviewStatus !== 'draft') {
          return res.status(400).json({ success: false, error: '新建评论只能保存为 draft' });
        }
        const stableAnchor = this.resolveLegacyReviewAnchor(
          req.collaborationSession,
          document,
          anchor,
        );
        const references = this.resolveLegacyReviewReferences(
          req.collaborationSession,
          req.body?.mentions,
          req.body?.attachments,
        );
        const created = this.database.createReviewThreadWithComment({
          projectId: req.collaborationSession.projectId,
          canvasId: document.canvasId,
          canvasRevision: expectedCanvasRevision,
          anchor: stableAnchor,
          severity: req.body?.severity,
          ...(req.body?.reviewStatus === 'draft' ? { reviewStatus: 'draft' } : {}),
          createdBy: req.collaborationSession.memberId,
        }, {
          body,
          mentions: references.mentions,
          attachments: references.attachments,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
          sourceOperationId: crypto.randomUUID(),
          notificationRecipients: references.notificationRecipients,
        });
        const hydratedThread = created.thread || created;
        const publicThread = this.publicReviewThreadForSession(
          req.collaborationSession,
          { ...hydratedThread, comments: created.comments || hydratedThread.comments || [created.comment] },
          document,
        );
        this.notifyCommitted('review.created', () => {
          this.broadcast(hydratedThread.projectId, hydratedThread.canvasId, {
            type: 'review.created',
            threadId: hydratedThread.id,
            threadRevision: hydratedThread.revision,
          });
        });
        this.notifyCommitted('review.notification.created', () => {
          this.dispatchReviewNotifications(
            hydratedThread.projectId,
            hydratedThread.canvasId,
            created.notifications,
          );
        });
        return res.status(201).json({ success: true, data: publicThread });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'collaboration_review_create_invalid',
          fallbackMessage: '评论创建失败',
        });
      }
    });

    app.post('/api/collab/reviews/:threadId/comments', this.requireCapability('comment'), (req, res) => {
      try {
        const thread = this.database.getReviewThread(req.params.threadId);
        const document = thread ? this.ensureCanvasAccess(req.collaborationSession, thread.canvasId) : null;
        if (!thread || !document) {
          return res.status(404).json({ success: false, error: '评论线程不存在' });
        }
        const expectedCanvasRevision = requiredReviewRevision(
          req.body?.expectedCanvasRevision,
          'expectedCanvasRevision',
        );
        const expectedThreadRevision = requiredReviewRevision(
          req.body?.expectedThreadRevision,
          'expectedThreadRevision',
        );
        if (expectedCanvasRevision !== Number(document.revision)) {
          throw collaborationGatewayError(
            'collaboration_review_canvas_cas_conflict',
            '画布版本已经变化，请刷新后重新回复',
            409,
          );
        }
        const body = String(req.body?.body || '').trim();
        if (!body || body.length > 5000) {
          return res.status(400).json({ success: false, error: '评论正文应为 1-5000 字' });
        }
        const references = this.resolveLegacyReviewReferences(
          req.collaborationSession,
          req.body?.mentions,
          req.body?.attachments,
        );
        const comments = this.database.listReviewComments(thread.id);
        const parent = req.body?.parentId == null
          ? null
          : comments.find((comment) => (
            String(comment.id) === String(req.body.parentId)
              || String(comment.entityUid) === String(req.body.parentId)
          ));
        if (req.body?.parentId != null && !parent) {
          return res.status(400).json({ success: false, error: '父评论不属于当前线程' });
        }
        const notificationRecipients = new Set(references.notificationRecipients);
        for (const memberId of [thread.createdBy, parent?.createdBy]) {
          if (memberId && String(memberId) !== String(req.collaborationSession.memberId)) {
            notificationRecipients.add(String(memberId));
          }
        }
        const created = this.database.createReviewCommentWithThreadRevision({
          threadId: thread.id,
          parentId: parent?.id || null,
          body,
          createdBy: req.collaborationSession.memberId,
          mentions: references.mentions,
          attachments: references.attachments,
        }, {
          expectedRevision: expectedThreadRevision,
          expectedCanvasRevision,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
          sourceOperationId: crypto.randomUUID(),
          notificationRecipients: [...notificationRecipients],
        });
        const publicThread = this.publicReviewThreadForSession(
          req.collaborationSession,
          { ...created.thread, comments: this.database.listReviewComments(thread.id) },
          document,
        );
        this.notifyCommitted('review.comment', () => {
          this.broadcast(thread.projectId, thread.canvasId, {
            type: 'review.comment',
            threadId: thread.id,
            threadRevision: created.thread.revision,
          });
        });
        this.notifyCommitted('review.notification.comment', () => {
          this.dispatchReviewNotifications(thread.projectId, thread.canvasId, created.notifications);
        });
        return res.status(201).json({ success: true, data: publicThread });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'collaboration_review_comment_invalid',
          fallbackMessage: '评论回复失败',
        });
      }
    });

    app.patch('/api/collab/reviews/:threadId', (req, res) => {
      try {
        const thread = this.database.getReviewThread(req.params.threadId);
        const document = thread ? this.ensureCanvasAccess(req.collaborationSession, thread.canvasId) : null;
        if (!thread || !document) {
          return res.status(404).json({ success: false, error: '评论线程不存在' });
        }
        const expectedCanvasRevision = requiredReviewRevision(
          req.body?.expectedCanvasRevision,
          'expectedCanvasRevision',
        );
        const expectedThreadRevision = requiredReviewRevision(
          req.body?.expectedThreadRevision,
          'expectedThreadRevision',
        );
        if (expectedCanvasRevision !== Number(document.revision)) {
          throw collaborationGatewayError(
            'collaboration_review_canvas_cas_conflict',
            '画布版本已经变化，请刷新后重新更新审片状态',
            409,
          );
        }
        const stateKeys = ['status', 'resolutionStatus', 'reviewStatus']
          .filter((key) => Object.prototype.hasOwnProperty.call(req.body || {}, key));
        if (stateKeys.length > 1) {
          throw collaborationGatewayError(
            'collaboration_domain_review_invalid',
            '一次只能更新一种评论状态维度',
            400,
          );
        }
        const legacyStatus = stateKeys[0] === 'status' ? String(req.body.status) : null;
        if (legacyStatus && !['open', 'resolved', 'approved', 'changes_requested'].includes(legacyStatus)) {
          throw collaborationGatewayError('collaboration_domain_review_invalid', '评论 status 无效', 400);
        }
        const resolutionStatus = stateKeys[0] === 'resolutionStatus'
          ? String(req.body.resolutionStatus)
          : null;
        if (resolutionStatus && !isReviewResolutionStatus(resolutionStatus)) {
          throw collaborationGatewayError('collaboration_domain_review_invalid', '评论 resolutionStatus 无效', 400);
        }
        const reviewStatus = stateKeys[0] === 'reviewStatus' ? String(req.body.reviewStatus) : null;
        if (reviewStatus && !isReviewLifecycleStatus(reviewStatus)) {
          throw collaborationGatewayError('collaboration_domain_review_invalid', '评论 reviewStatus 无效', 400);
        }
        let capability = 'comment';
        const requestedReviewStatus = reviewStatus
          || (legacyStatus && isReviewDecisionStatus(legacyStatus) ? legacyStatus : null);
        if (requestedReviewStatus) {
          const transitionCapability = reviewLifecycleTransitionCapability(
            thread.reviewStatus,
            requestedReviewStatus,
          );
          if (transitionCapability == null
            && thread.reviewStatus !== requestedReviewStatus) {
            throw collaborationGatewayError(
              'collaboration_domain_review_transition_invalid',
              `评审生命周期不能从 ${thread.reviewStatus} 转为 ${requestedReviewStatus}`,
              409,
            );
          }
          capability = transitionCapability || 'comment';
        }
        if (!this.auth.hasCapability(req.collaborationSession, capability)) {
          return res.status(403).json({ success: false, error: `缺少权限: ${capability}` });
        }
        const notificationRecipients = String(thread.createdBy) === String(req.collaborationSession.memberId)
          ? []
          : [String(thread.createdBy)];
        const updated = this.database.updateReviewThreadWithAudit({
          threadId: thread.id,
          expectedCanvasRevision,
          expectedThreadRevision,
          ...(legacyStatus ? { status: legacyStatus } : {}),
          ...(resolutionStatus ? { resolutionStatus } : {}),
          ...(reviewStatus ? { reviewStatus } : {}),
          severity: req.body?.severity ?? thread.severity,
          ...(reviewStatus
            ? { decisionCanvasRevision: isReviewDecisionStatus(reviewStatus) ? document.revision : null }
            : legacyStatus && isReviewDecisionStatus(legacyStatus)
              ? { decisionCanvasRevision: document.revision }
              : {}),
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
          sourceOperationId: crypto.randomUUID(),
          notificationRecipients,
        }, {
          decisionRebindAuthorized: capability === 'approve',
        });
        const publicThread = this.publicReviewThreadForSession(
          req.collaborationSession,
          { ...updated.thread, comments: this.database.listReviewComments(thread.id) },
          document,
        );
        this.notifyCommitted('review.updated', () => {
          this.broadcast(thread.projectId, thread.canvasId, {
            type: 'review.updated',
            threadId: thread.id,
            threadRevision: updated.thread.revision,
          });
        });
        this.notifyCommitted('review.notification.updated', () => {
          this.dispatchReviewNotifications(thread.projectId, thread.canvasId, updated.notifications);
        });
        return res.json({ success: true, data: publicThread });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'collaboration_review_update_invalid',
          fallbackMessage: '评论状态更新失败',
        });
      }
    });

    app.get('/api/collab/notifications', (req, res) => {
      try {
        const { limit, offset } = boundedReviewPagination(req.query);
        const unreadOnly = optionalBooleanQuery(req.query?.unreadOnly, '未读通知筛选');
        const notifications = this.database.listCollaborationNotifications({
          projectId: req.collaborationSession.projectId,
          canvasId: req.collaborationSession.canvasId,
          recipientMemberId: req.collaborationSession.memberId,
          ...(unreadOnly === undefined ? {} : { unreadOnly }),
          limit,
          offset,
        }).map((notification) => this.publicReviewNotificationForSession(
          req.collaborationSession,
          notification,
        )).filter(Boolean);
        res.set('Cache-Control', 'no-store');
        return res.json({ success: true, data: notifications, meta: { limit, offset } });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'collaboration_notification_query_invalid',
          fallbackMessage: '通知查询失败',
        });
      }
    });

    app.patch('/api/collab/notifications/:notificationId/read', (req, res) => {
      try {
        const notification = this.database.markCollaborationNotificationRead({
          recipientMemberId: req.collaborationSession.memberId,
          notificationId: req.params.notificationId,
          readAt: Date.now(),
        });
        const safe = this.publicReviewNotificationForSession(req.collaborationSession, notification);
        if (!safe) return res.status(404).json({ success: false, error: '通知不存在' });
        res.set('Cache-Control', 'no-store');
        return res.json({ success: true, data: safe });
      } catch (error) {
        if (sendProjectDatabaseStorageCapacityError(res, error, {
          operation: 'collaboration.notification.read',
        })) return res;
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'collaboration_notification_update_invalid',
          fallbackMessage: '通知更新失败',
        });
      }
    });

    app.get('/api/collab/runs/sync', (req, res) => {
      try {
        const afterEventId = Number(req.query?.afterEventId ?? 0);
        const limit = Number(req.query?.limit ?? 500);
        if (!Number.isSafeInteger(afterEventId) || afterEventId < 0
          || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
          return res.status(400).json({
            success: false,
            code: 'collaboration_run_sync_query_invalid',
            error: '运行事件游标或分页参数无效',
          });
        }
        const events = this.database.listCanvasRunEvents(
          req.collaborationSession.projectId,
          req.collaborationSession.canvasId,
          { afterId: afterEventId, limit },
        ).map((event) => this.publicRunEventForSession(req.collaborationSession, event))
          .filter(Boolean);
        const nextCursor = events.length > 0
          ? Number(events[events.length - 1].id)
          : afterEventId;
        res.set('Cache-Control', 'no-store');
        return res.json({
          success: true,
          data: events,
          meta: {
            afterEventId,
            nextCursor,
            limit,
            hasMore: events.length === limit,
          },
        });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'collaboration_run_sync_failed',
          fallbackMessage: '运行事件同步失败',
        });
      }
    });

    app.get('/api/collab/runs', (req, res) => {
      try {
        const limit = Number(req.query?.limit ?? 20);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
          return res.status(400).json({
            success: false,
            code: 'collaboration_run_query_invalid',
            error: '运行快照 limit 必须是 1-50 的整数',
          });
        }
        const runs = this.database.listRuns({
          projectId: req.collaborationSession.projectId,
          canvasId: req.collaborationSession.canvasId,
          limit,
        }).map((run) => this.publicRunDetailForSession(req.collaborationSession, run))
          .filter(Boolean);
        res.set('Cache-Control', 'no-store');
        return res.json({ success: true, data: runs, meta: { limit, total: runs.length } });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'collaboration_run_query_failed',
          fallbackMessage: '运行快照读取失败',
        });
      }
    });

    app.get('/api/collab/runs/:runId', (req, res) => {
      try {
        const run = this.database.getRun(req.params.runId);
        const data = this.publicRunDetailForSession(req.collaborationSession, run, {
          includeAttempts: true,
        });
        if (!data) return res.status(404).json({ success: false, error: '运行记录不存在' });
        res.set('Cache-Control', 'no-store');
        return res.json({ success: true, data });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'collaboration_run_detail_failed',
          fallbackMessage: '运行详情读取失败',
        });
      }
    });

    app.post('/api/collab/run-intents/:intentId/cancel', (req, res) => {
      try {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
          || Object.keys(req.body).some((key) => key !== 'expectedQueueRevision')) {
          return res.status(400).json({
            success: false,
            code: 'collaboration_run_cancel_invalid',
            error: '取消运行请求必须提供精确队列 revision',
          });
        }
        const expectedQueueRevision = Number(req.body.expectedQueueRevision);
        if (!Number.isSafeInteger(expectedQueueRevision) || expectedQueueRevision < 1) {
          return res.status(400).json({
            success: false,
            code: 'collaboration_run_cancel_invalid',
            error: 'expectedQueueRevision 必须是正安全整数',
          });
        }
        const intent = this.database.getRunIntent(req.params.intentId);
        if (!intent
          || String(intent.projectId) !== String(req.collaborationSession.projectId)
          || String(intent.canvasId) !== String(req.collaborationSession.canvasId)
          || String(intent.requestedBy) !== String(req.collaborationSession.memberId)) {
          return res.status(404).json({ success: false, error: '运行请求不存在' });
        }
        const cancelled = this.database.requestRunIntentCancellation(intent.id, {
          projectId: req.collaborationSession.projectId,
          canvasId: req.collaborationSession.canvasId,
          expectedQueueRevision,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
        });
        this.notifyCommitted('run-intent.cancelled', () => {
          this.broadcastHostRunIntent(cancelled);
        });
        return res.json({ success: true, data: cancelled });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'collaboration_run_cancel_failed',
          fallbackMessage: '运行取消请求失败',
        });
      }
    });

    app.get('/api/collab/assets', (req, res) => {
      const scopedAssetIds = this.canvasResourceScope(req.collaborationSession).assetIds;
      const filters = {
        projectId: req.collaborationSession.projectId,
        kind: req.query?.kind,
        query: req.query?.query,
        limit: req.query?.limit,
        offset: req.query?.offset,
        assetIds: [...scopedAssetIds],
      };
      const subject = this.assetAccessSubject(req.collaborationSession, 'view');
      const assets = typeof this.database.listAccessibleAssets === 'function'
        ? this.database.listAccessibleAssets(filters, subject)
        : [];
      const scopedAssets = this.filterSessionAssets(req.collaborationSession, assets, 'view', scopedAssetIds);
      const total = typeof this.database.countAccessibleAssets === 'function'
        ? this.database.countAccessibleAssets(
          { ...filters, limit: undefined, offset: undefined },
          subject,
        )
        : scopedAssets.length;
      res.json({
        success: true,
        data: scopedAssets
          .map((asset) => this.publicAssetForSession(req.collaborationSession, asset, scopedAssetIds))
          .filter(Boolean),
        meta: { total },
      });
    });

    app.use('/api/collab/assets/uploads', uploadRequestRateLimiter);

    // Keep this exact collection route ahead of /api/collab/assets/:assetId.
    // Express otherwise treats "uploads" as an asset id and hides recovery discovery.
    app.get('/api/collab/assets/uploads', this.requireCapability('uploadAsset'), collaborationRateLimiter({ limit: 120, windowMs: 60_000 }), (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const context = uploadContext(req);
        const scope = collaborationUploadScope(context);
        const now = Date.now();
        const candidates = this.database.listActiveAssetUploadSessionIds({
          projectId: context.projectId,
          memberId: context.memberId,
          sourceKind: 'collaboration',
          idPrefix: scope.fullPrefix,
          now,
          limit: COLLABORATION_UPLOAD_DISCOVERY_SCAN_LIMIT,
        });
        const sessions = [];
        for (const sessionId of candidates) {
          if (sessions.length >= COLLABORATION_UPLOAD_DISCOVERY_LIMIT) break;
          try {
            const session = this.uploadManager.getSession(sessionId, context);
            if (!ACTIVE_COLLABORATION_UPLOAD_STATES.has(String(session.status))
              || Number(session.expiresAt) <= now) continue;
            sessions.push(publicUploadSession(session));
          } catch (error) {
            const code = safeUploadErrorCode(error);
            if (code === 'asset_upload_session_missing'
              || code === 'asset_upload_session_scope_mismatch') continue;
            throw error;
          }
        }
        res.json({
          success: true,
          data: {
            sessions,
            truncated: candidates.length >= COLLABORATION_UPLOAD_DISCOVERY_SCAN_LIMIT
              || sessions.length >= COLLABORATION_UPLOAD_DISCOVERY_LIMIT,
          },
        });
      } catch (error) { sendUploadFailure(res, error); }
    });

    app.get('/api/collab/assets/:assetId', (req, res) => {
      const asset = this.database.getAsset(req.params.assetId);
      const scopedAssetIds = this.canvasResourceScope(req.collaborationSession).assetIds;
      if (!asset || !this.canSessionAccessAsset(req.collaborationSession, asset, 'view', scopedAssetIds)) return res.status(404).json({ success: false, error: '素材不存在或无权访问' });
      res.json({ success: true, data: this.publicAssetForSession(req.collaborationSession, asset, scopedAssetIds) });
    });

    app.get('/api/collab/assets/:assetId/media', downloadRequestRateLimiter, (req, res) => {
      const asset = this.database.getAsset(req.params.assetId);
      const scopedAssetIds = this.canvasResourceScope(req.collaborationSession).assetIds;
      const downloadOriginal = String(req.query?.download || '') === '1';
      const representation = String(req.query?.representation || 'preview') === 'thumbnail' ? 'thumbnail' : 'preview';
      const insecurePublicRequest = isInsecurePublicRequest(req, this.publicBaseUrl);
      if (!asset) return res.status(404).end();
      if (downloadOriginal) {
        if (insecurePublicRequest) {
          return res.status(403).json({
            success: false,
            code: 'collaboration_public_http_original_download_disabled',
            error: '公网连接未通过可信 HTTPS 验证，已禁用敏感原件下载',
          });
        }
        if (!this.canSessionAccessAsset(req.collaborationSession, asset, 'original', scopedAssetIds)) return res.status(404).end();
        if (!this.auth.hasCapability(req.collaborationSession, 'downloadOriginal')) return res.status(403).end();
      } else if (!this.canSessionAccessAsset(req.collaborationSession, asset, 'preview', scopedAssetIds)) {
        return res.status(404).end();
      }
      const canFallbackToOriginal = !downloadOriginal
        && !insecurePublicRequest
        && this.canSessionAccessAsset(req.collaborationSession, asset, 'original', scopedAssetIds)
        && this.auth.hasCapability(req.collaborationSession, 'downloadOriginal');
      const resolved = downloadOriginal
        ? this._resolveAssetRepresentation(asset, 'original', true)
        : this._resolveAssetRepresentation(asset, representation, canFallbackToOriginal);
      if (!resolved) return res.status(404).end();
      const { filename, stat } = resolved;
      const rangeHeader = req.headers.range;
      const range = parseRangeHeader(rangeHeader, stat.size);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', resolved.mimeType || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.setHeader('Content-Disposition', `${downloadOriginal ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(asset.filename || 'asset')}`);
      if (rangeHeader && !range) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
      }
      if (!range) {
        res.setHeader('Content-Length', stat.size);
      } else {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
        res.setHeader('Content-Length', range.end - range.start + 1);
      }
      if (req.method === 'HEAD') return res.end();
      let stream;
      try {
        stream = fs.createReadStream(filename, range || undefined);
      } catch (_) {
        res.removeHeader('Content-Length');
        res.removeHeader('Content-Range');
        return res.status(404).end();
      }
      const throttle = createTieredBandwidthThrottle(
        this.requestRateLimitEntries(req, this.downloadBandwidthLimiters),
        this.downloadBandwidthThrottleOptions,
      );
      stream.once('error', () => {
        throttle.destroy();
        if (res.headersSent) return res.destroy();
        res.removeHeader('Content-Length');
        res.removeHeader('Content-Range');
        return res.status(404).end();
      });
      throttle.once('error', () => {
        stream.destroy();
        if (!res.destroyed) res.destroy();
      });
      res.once('close', () => {
        if (res.writableEnded) return;
        stream.destroy();
        throttle.destroy();
      });
      return stream.pipe(throttle).pipe(res);
    });

    const uploadContext = (req) => ({
      projectId: req.collaborationSession.projectId,
      canvasId: req.collaborationSession.canvasId,
      memberId: req.collaborationSession.memberId,
      sessionId: req.collaborationSession.id,
      authorizationEpoch: req.collaborationSession.authorizationEpoch,
      sourceKind: 'collaboration',
    });
    const sendUploadFailure = (res, error) => {
      const code = safeUploadErrorCode(error);
      const status = Math.max(400, Math.min(599, Number(error?.status) || (code.startsWith('CAS_') ? 422 : 400)));
      const current = error?.current?.id ? publicUploadSession(error.current) : null;
      const rawCapacityReason = String(error?.reason || error?.details?.reason || '');
      const capacityDetails = code === 'asset_upload_storage_full' && status === 507
        ? {
            reason: PUBLIC_PROJECT_DATABASE_CAPACITY_REASONS.has(rawCapacityReason)
              ? rawCapacityReason
              : 'sqlite-full',
            retryable: error?.retryable === true || error?.details?.retryable === true,
          }
        : null;
      return res.status(status).json({
        success: false,
        code,
        error: safeUploadErrorMessage(error),
        ...(capacityDetails || {}),
        ...(current ? { data: current } : {}),
      });
    };

    app.get('/api/collab/assets/uploads/policy', this.requireCapability('uploadAsset'), (req, res) => {
      try {
        res.json({ success: true, data: this.uploadManager.policy(uploadContext(req)) });
      } catch (error) { sendUploadFailure(res, error); }
    });

    app.post('/api/collab/assets/uploads', this.requireCapability('uploadAsset'), collaborationRateLimiter({ limit: 120, windowMs: 60_000 }), (req, res) => {
      try {
        const session = this.uploadManager.createSession(req.body || {}, uploadContext(req));
        res.status(session.idempotentReplay ? 200 : 201).json({ success: true, data: publicUploadSession(session) });
      } catch (error) { sendUploadFailure(res, error); }
    });

    app.get('/api/collab/assets/uploads/:sessionId', this.requireCapability('uploadAsset'), (req, res) => {
      try {
        res.json({ success: true, data: publicUploadSession(this.uploadManager.getSession(req.params.sessionId, uploadContext(req))) });
      } catch (error) { sendUploadFailure(res, error); }
    });

    app.put(
      '/api/collab/assets/uploads/:sessionId/chunks/:index',
      this.requireCapability('uploadAsset'),
      collaborationRateLimiter({ limit: 600, windowMs: 60_000 }),
      express.raw({ type: 'application/octet-stream', limit: this.uploadManager.chunkSize }),
      uploadByteRateLimiter,
      async (req, res) => {
        try {
          const range = parseUploadContentRange(req.get('content-range'));
          const session = await this.uploadManager.writeChunk(req.params.sessionId, {
            index: req.params.index,
            ...range,
            contentHash: req.get('x-chunk-sha256'),
            buffer: req.body,
          }, uploadContext(req));
          res.json({ success: true, data: publicUploadSession(session) });
        } catch (error) { sendUploadFailure(res, error); }
      },
    );

    app.post('/api/collab/assets/uploads/:sessionId/pause', this.requireCapability('uploadAsset'), async (req, res) => {
      try { res.json({ success: true, data: publicUploadSession(await this.uploadManager.pause(req.params.sessionId, uploadContext(req))) }); }
      catch (error) { sendUploadFailure(res, error); }
    });

    app.post('/api/collab/assets/uploads/:sessionId/resume', this.requireCapability('uploadAsset'), async (req, res) => {
      try { res.json({ success: true, data: publicUploadSession(await this.uploadManager.resume(req.params.sessionId, uploadContext(req))) }); }
      catch (error) { sendUploadFailure(res, error); }
    });

    app.post('/api/collab/assets/uploads/:sessionId/complete', this.requireCapability('uploadAsset'), collaborationRateLimiter({ limit: 60, windowMs: 60_000 }), async (req, res) => {
      try {
        this.uploadManager.previewPipeline = this.previewPipeline;
        const result = await this.uploadManager.complete(req.params.sessionId, req.body || {}, uploadContext(req));
        const persistenceWarning = publicUploadPersistenceWarning(result.persistenceWarning);
        res.status(result.idempotentReplay ? 200 : 201).json({
          success: true,
          data: {
            session: publicUploadSession(result.session),
            asset: this.publicAssetForSession(req.collaborationSession, result.asset),
            deduplicated: Boolean(result.deduplicated),
            blobId: result.blobId,
            quota: result.quota,
            idempotentReplay: Boolean(result.idempotentReplay),
            ...(persistenceWarning ? { persistenceWarning } : {}),
          },
        });
      } catch (error) { sendUploadFailure(res, error); }
    });

    app.delete('/api/collab/assets/uploads/:sessionId', this.requireCapability('uploadAsset'), async (req, res) => {
      try { res.json({ success: true, data: publicUploadSession(await this.uploadManager.cancel(req.params.sessionId, uploadContext(req))) }); }
      catch (error) { sendUploadFailure(res, error); }
    });

    app.post('/api/collab/assets/upload', this.requireCapability('uploadAsset'), collaborationRateLimiter({ limit: 30, windowMs: 60_000 }), (_req, res) => {
      res.status(410).json({
        success: false,
        code: 'asset_upload_legacy_disabled',
        error: '旧版整文件上传已停用，请使用可恢复分片上传接口 /api/collab/assets/uploads',
      });
    });

    app.post('/api/collab/run-intents', this.requireCapability('runWorkflow'), (req, res) => {
      try {
        const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
        if (!/^[a-zA-Z0-9._:-]{8,160}$/.test(idempotencyKey)) return res.status(400).json({ success: false, error: '运行幂等键无效' });
        const result = this.database.withProjectDatabaseWrite('collaboration.run-intent.reserve', () => {
          const document = this.ensureCanvasAccess(req.collaborationSession, req.body?.canvasId);
          if (!document) {
            throw new RunIntentAuthorityError('intent_canvas_not_found', '画布不存在或无权访问', {}, 404);
          }
          const revision = Number(req.body?.canvasRevision);
          const requestedNodeIds = normalizeRequestedRunNodeIds(req.body?.nodeIds);
          const existing = this.database.getRunIntentByKey(
            req.collaborationSession.projectId,
            idempotencyKey,
          );
          if (existing) {
            return {
              intent: assertEquivalentRunIntentReplay(existing, {
                projectId: req.collaborationSession.projectId,
                canvasId: document.canvasId,
                canvasRevision: revision,
                nodeIds: requestedNodeIds,
                requestedBy: req.collaborationSession.memberId,
              }),
              created: false,
            };
          }
          if (revision !== document.revision) {
            throw new RunIntentAuthorityError(
              'intent_canvas_stale',
              '画布版本已变化，请同步后重试',
              { revision: document.revision },
              409,
            );
          }
          const authority = deriveRunIntentAuthority(document, requestedNodeIds);
          const summary = summarizeRunIntentAuthority(authority);
          const authorization = this.executionPolicy.authorize({
            projectId: document.projectId,
            canvasId: document.canvasId,
            requestedBy: req.collaborationSession.memberId,
            requesterRole: req.collaborationSession.role,
            declarations: authority.declarations,
            estimatedCost: summary.estimatedCost,
            estimatedCostKnown: summary.estimatedCostKnown,
            enforceConcurrency: false,
          });
          const intent = this.database.createRunIntent({
            projectId: req.collaborationSession.projectId,
            canvasId: document.canvasId,
            canvasRevision: document.revision,
            nodeIds: authority.requestedNodeIds,
            idempotencyKey,
            requestedBy: req.collaborationSession.memberId,
            provider: summary.provider,
            model: summary.model,
            estimatedCost: summary.estimatedCost,
            estimatedCostKnown: summary.estimatedCostKnown,
            executionAuthority: authority,
            confirmationRequired: authorization.confirmation.required,
          });
          return { intent, created: true };
        });
        if (result.created) {
          this.notifyCommitted('run-intent.created', () => {
            this.broadcastHostRunIntent(result.intent);
          });
        }
        res.status(202).json({ success: true, data: result.intent });
      } catch (error) {
        if (error instanceof ExecutionPolicyError || error instanceof RunIntentAuthorityError) {
          return res.status(error.httpStatus || 429).json({
            success: false,
            code: error.code,
            error: error.message,
            data: error.details,
          });
        }
        const capacityError = translateProjectDatabaseStorageCapacityError(error, {
          operation: 'collaboration.run-intent.reserve',
        });
        if (capacityError?.code === 'project_database_storage_capacity_exceeded') {
          return sendCanvasPatchError(res, capacityError, {
            fallbackCode: 'run_intent_reservation_failed',
            fallbackMessage: '运行请求处理失败',
          });
        }
        res.status(400).json({ success: false, error: error?.message || String(error) });
      }
    });

    const frontend = this.config.FRONTEND_DIST;
    if (frontend && fs.existsSync(path.join(frontend, 'index.html'))) {
      app.use(express.static(frontend, { index: false, fallthrough: true }));
      app.get(/^\/collab(?:\/.*)?$/, (_req, res) => res.sendFile(path.join(frontend, 'index.html')));
    } else {
      app.get(/^\/collab(?:\/.*)?$/, (_req, res) => {
        res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><title>T8 协作</title><p>T8 协作前端尚未构建，请先运行 npm run build。</p>');
      });
    }

    app.use((_req, res) => res.status(404).json({ success: false, error: '协作网关未开放此接口' }));
    app.use((error, _req, res, _next) => {
      if (res.headersSent) return res.end();
      if (isRecoveryGenerationUnavailable(error)) {
        return sendRecoveryGenerationUnavailable(res);
      }
      const isTooLarge = error?.type === 'entity.too.large' || error?.code === 'LIMIT_FILE_SIZE';
      const isMalformedBody = error?.type === 'entity.parse.failed';
      const status = isTooLarge ? 413 : (isMalformedBody ? 400 : 500);
      const code = isTooLarge ? 'asset_upload_chunk_too_large' : (isMalformedBody ? 'request_body_invalid' : 'collaboration_request_failed');
      return res.status(status).json({
        success: false,
        code,
        error: isTooLarge ? '上传内容超过允许大小' : (isMalformedBody ? '请求内容格式无效' : '协作请求处理失败'),
      });
    });
    return app;
  }

  async start(options = {}) {
    if (this.runtimeShutdownRequested) {
      const error = new Error('协作网关正在关闭，不能重新启动');
      error.code = 'collaboration_gateway_shutting_down';
      throw error;
    }
    const requestedHost = validateBindHost(
      options.host || this.config.COLLAB_HOST || '127.0.0.1',
      this.networkInterfaces(),
    );
    const requestedPort = Number(options.port ?? this.config.COLLAB_PORT);
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('协作端口无效');
    const requestKey = `${requestedHost}:${requestedPort}`;
    return this.enqueueLifecycle(
      'start',
      requestKey,
      () => this.startInternal({ host: requestedHost, port: requestedPort }),
    );
  }

  async startInternal(options = {}) {
    if (this.runtimeShutdownRequested) {
      const error = new Error('协作网关正在关闭，不能重新启动');
      error.code = 'collaboration_gateway_shutting_down';
      throw error;
    }
    const networkInterfaces = this.networkInterfaces();
    const requestedHost = validateBindHost(options.host || this.config.COLLAB_HOST || '127.0.0.1', networkInterfaces);
    const requestedPort = Number(options.port ?? this.config.COLLAB_PORT);
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('协作端口无效');
    if (this.server?.listening) {
      if (this.host === requestedHost && this.port === requestedPort) return this.managementStatus();
    }

    const listenerOriginContext = { host: requestedHost, port: requestedPort };
    const allowedOriginsProvider = () => this.collaborationAllowedOrigins(
      listenerOriginContext.host,
      listenerOriginContext.port,
    );
    const app = this.createApp(allowedOriginsProvider);
    const server = http.createServer(app);
    const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });
    server.on('upgrade', (request, socket, head) => {
      try {
        const url = new URL(request.url, 'http://collaboration.local');
        if (url.pathname !== '/ws/collab' || !sameOriginUpgrade(request, allowedOriginsProvider())) {
          this.rejectWebSocketUpgrade(socket, 403, 'Forbidden');
          return;
        }
        const clientIp = requestClientAddress(request, this.trustedProxyAddresses);
        const ipHandshake = this.webSocketHandshakeIpLimiter.consume(clientIp);
        if (!ipHandshake.allowed) {
          this.rejectWebSocketUpgrade(socket, 429, 'Too Many Requests', ipHandshake.retryAfterMs);
          return;
        }
        const selfCheckToken = Array.isArray(request.headers[PUBLIC_SELF_CHECK_HEADER])
          ? request.headers[PUBLIC_SELF_CHECK_HEADER][0]
          : request.headers[PUBLIC_SELF_CHECK_HEADER];
        if (selfCheckToken) {
          const challenge = this.publicSelfCheckChallenges.consume(selfCheckToken, 'websocket');
          if (!challenge) {
            this.rejectWebSocketUpgrade(socket, 404, 'Not Found');
            return;
          }
          webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
            webSocket.send(JSON.stringify({ type: 'self-check.ready' }), () => {
              try { webSocket.close(1000, 'self-check complete'); } catch (_) {}
            });
          });
          return;
        }
        const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        const session = this.auth.authenticate(token);
        if (!session) {
          this.rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        const sessionHandshake = this.webSocketHandshakeSessionLimiter.consume(session.id);
        if (!sessionHandshake.allowed) {
          this.rejectWebSocketUpgrade(socket, 429, 'Too Many Requests', sessionHandshake.retryAfterMs);
          return;
        }
        if (this.connectionCountForClientIp(clientIp) >= this.webSocketMaxConnectionsPerIp
          || this.connectionCountForSession(session.id) >= this.webSocketMaxConnectionsPerSession) {
          this.rejectWebSocketUpgrade(socket, 429, 'Too Many Requests', 1_000);
          return;
        }
        const resourceScope = this.canvasResourceScope(session);
        if (!resourceScope.ready) {
          this.rejectWebSocketUpgrade(socket, 409, 'Conflict');
          return;
        }
        // Authenticate and resolve the resource scope before exposing service
        // availability, then fail the upgrade explicitly if this process has
        // lost its durable recovery-generation fence.
        this.database.getRecoveryGeneration();
        this.database.requiresRecoveryGeneration();
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit('connection', webSocket, request, session, token, clientIp);
        });
      } catch (error) {
        if (isRecoveryGenerationUnavailable(error)) {
          this.rejectWebSocketUpgrade(
            socket,
            503,
            'Service Unavailable',
            RECOVERY_GENERATION_RETRY_AFTER_MS,
          );
          return;
        }
        socket.destroy();
      }
    });
    webSocketServer.on('connection', (webSocket, _request, session, token, clientIp) => (
      this.attachWebSocket(webSocket, session, token, server, clientIp)
    ));

    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(requestedPort, requestedHost, () => resolve());
      });
    } catch (error) {
      webSocketServer.close();
      try {
        server.close();
      } catch (_) {
        // A bind failure can occur before Node marks the temporary server as running.
      }
      throw error;
    }
    const address = server.address();
    listenerOriginContext.port = typeof address === 'object' && address ? address.port : requestedPort;
    // Upgrade plans are intentionally process-lifetime capabilities. A new
    // listener generation must never inherit an uncommitted ticket.
    this.clearSubflowUpgradePlans();
    const previousServer = this.server;
    const previousWebSocketServer = this.webSocketServer;
    this.server = server;
    this.webSocketServer = webSocketServer;
    this.host = requestedHost;
    this.port = listenerOriginContext.port;
    this.startedAt = Date.now();
    this.startWebSocketHeartbeat(server);
    if (previousServer && previousServer !== server) {
      await this.closeServerResources(previousServer, previousWebSocketServer, 'gateway restarted', {
        closeCode: 1012,
        noticeReason: 'gateway_restarted',
        retryable: true,
        retryAfterMs: 500,
      });
    }
    return this.managementStatus();
  }

  rejectWebSocketUpgrade(socket, status, reason, retryAfterMs = 0) {
    const retryAfter = retryAfterMs > 0
      ? `Retry-After: ${Math.max(1, Math.ceil(retryAfterMs / 1000))}\r\n`
      : '';
    try {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n${retryAfter}Content-Length: 0\r\n\r\n`);
    } catch (_) { /* socket may already be closed */ }
    socket.destroy();
  }

  connectionCountForClientIp(clientIp) {
    const expected = String(clientIp || 'unknown');
    let count = 0;
    for (const state of this.connections.values()) {
      if (String(state?.clientIp || 'unknown') === expected) count += 1;
    }
    return count;
  }

  attachWebSocket(webSocket, session, token, server = this.server, clientIp = 'unknown') {
    const connectionId = crypto.randomUUID();
    this.connections.set(webSocket, {
      connectionId,
      clientIp: String(clientIp || 'unknown'),
      session,
      sessionToken: token,
      server,
      canvasId: null,
      presence: {},
      lastSeenAt: Date.now(),
      awaitingNativePong: false,
      lastNativePingAt: null,
      messageWindowAt: Date.now(),
      messageCount: 0,
      rateLimitClosing: false,
    });
    webSocket.send(JSON.stringify({
      type: 'session.ready',
      connectionId,
      session,
      protocol: {
        version: COLLABORATION_PROTOCOL_VERSION,
        heartbeatIntervalMs: this.webSocketHeartbeatIntervalMs,
        heartbeatTimeoutMs: this.webSocketHeartbeatTimeoutMs,
        maxSyncOperations: 500,
      },
      timestamp: Date.now(),
    }));
    webSocket.on('pong', () => {
      const state = this.connections.get(webSocket);
      if (!state) return;
      state.awaitingNativePong = false;
      state.lastSeenAt = Date.now();
    });
    webSocket.on('message', (raw) => {
      const state = this.connections.get(webSocket);
      if (!state) return;
      if (state.rateLimitClosing) return;
      const now = Date.now();
      if (now - state.messageWindowAt >= this.webSocketMessageWindowMs) {
        state.messageWindowAt = now;
        state.messageCount = 0;
      }
      state.messageCount += 1;
      if (state.messageCount > this.webSocketMessagesPerWindow) {
        return webSocket.close(1008, 'message rate exceeded');
      }
      if (raw.length > MAX_WS_MESSAGE_BYTES) return webSocket.close(1009, 'message too large');
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch (_) {
        const malformedRateLimit = this.webSocketMessageRateLimit(state, '');
        if (!malformedRateLimit.allowed) {
          this.closeWebSocketForMessageRateLimit(webSocket, malformedRateLimit);
        }
        return;
      }
      const messageRateLimit = this.webSocketMessageRateLimit(state, message?.type);
      if (!messageRateLimit.allowed) {
        this.closeWebSocketForMessageRateLimit(webSocket, messageRateLimit);
        return;
      }
      const currentSession = this.refreshConnectionSession(webSocket, state);
      if (!currentSession) return;
      state.lastSeenAt = Date.now();
      try { inspectJsonComplexity(message, { maxDepth: 16, maxKeys: 4000 }); } catch (_) { return webSocket.close(1008, 'message too complex'); }
      const recoveryGenerationState = this.readConnectionRecoveryGeneration(state);
      if (!recoveryGenerationState) return;
      if (message.type === 'ping') {
        const nonce = typeof message.nonce === 'string' ? message.nonce.slice(0, 120) : null;
        let revision = null;
        if (state.canvasId) {
          const document = this.ensureCanvasAccess(currentSession, state.canvasId);
          revision = document ? Number(document.revision) : null;
        }
        return webSocket.send(JSON.stringify({
          type: 'pong',
          ...(nonce ? { nonce } : {}),
          ...(state.canvasId ? { canvasId: state.canvasId } : {}),
          ...(revision == null ? {} : { revision }),
          ...(state.canvasId ? { generation: recoveryGenerationState.generation } : {}),
          timestamp: Date.now(),
        }));
      }
      if (typeof message.type === 'string' && (message.type.startsWith('run.') || message.type.startsWith('node.') || message.type.startsWith('provider.'))) {
        return webSocket.send(JSON.stringify({ type: 'error', code: 'host_authoritative_message', message: '运行状态和产物只能由主机广播' }));
      }
      if (message.type === 'canvas.join') {
        const document = this.ensureCanvasAccess(currentSession, message.canvasId);
        if (!document) return webSocket.send(JSON.stringify({ type: 'error', code: 'canvas_forbidden' }));
        const resourceScope = this.canvasResourceScope(currentSession);
        if (!resourceScope.ready) {
          webSocket.send(JSON.stringify({
            type: 'error',
            code: this.canvasResourceScopeFailure(resourceScope).code,
          }));
          return webSocket.close(WS_CLOSE_RESOURCE_SCOPE, 'resource scope unavailable');
        }
        const hasAfterRevision = Object.prototype.hasOwnProperty.call(message, 'afterRevision');
        const afterRevision = hasAfterRevision ? message.afterRevision : 0;
        if (hasAfterRevision && (typeof afterRevision !== 'number'
          || !Number.isSafeInteger(afterRevision)
          || afterRevision < 0)) {
          return webSocket.send(JSON.stringify({ type: 'error', code: 'canvas_revision_invalid' }));
        }
        const requestedGeneration = parseRecoveryGeneration(message.generation);
        if (!requestedGeneration.valid) {
          return webSocket.send(JSON.stringify({ type: 'error', code: 'canvas_generation_invalid' }));
        }
        const generation = recoveryGenerationState.generation;
        state.canvasId = document.canvasId;
        webSocket.send(JSON.stringify({
          type: 'canvas.joined',
          canvasId: document.canvasId,
          revision: document.revision,
          afterRevision,
          generation,
          syncRequired: afterRevision !== Number(document.revision)
            || (requestedGeneration.generation == null
              ? recoveryGenerationState.requiresSnapshot
              : requestedGeneration.generation !== generation),
        }));
        const members = [];
        for (const [peerWebSocket, peerState] of this.connections.entries()) {
          if (peerWebSocket === webSocket
            || peerWebSocket.readyState !== WebSocket.OPEN
            || peerState.server !== state.server
            || peerState.canvasId !== document.canvasId) continue;
          const peerSession = this.refreshConnectionSession(peerWebSocket, peerState);
          if (!peerSession || peerSession.projectId !== currentSession.projectId) continue;
          members.push({
            memberId: peerSession.memberId,
            displayName: peerSession.displayName,
            connectionId: peerState.connectionId,
            presence: peerState.presence || {},
          });
        }
        return webSocket.send(JSON.stringify({
          type: 'presence.snapshot',
          canvasId: document.canvasId,
          members,
          timestamp: Date.now(),
        }));
      }
      if (message.type === 'presence.update' && state.canvasId) {
        const presence = normalizeCollaborationPresence(message.presence);
        state.presence = presence;
        this.broadcast(currentSession.projectId, state.canvasId, {
          type: 'presence.update',
          canvasId: state.canvasId,
          memberId: currentSession.memberId,
          displayName: currentSession.displayName,
          connectionId: state.connectionId,
          presence,
        }, webSocket, state.server);
      }
      if (message.type === 'awareness.update' && state.canvasId) {
        const awareness = message.awareness && typeof message.awareness === 'object' ? message.awareness : {};
        if (Buffer.byteLength(JSON.stringify(awareness), 'utf8') > 16 * 1024) return;
        this.broadcast(currentSession.projectId, state.canvasId, {
          type: 'awareness.update',
          canvasId: state.canvasId,
          memberId: currentSession.memberId,
          displayName: currentSession.displayName,
          awareness,
        }, webSocket, state.server);
      }
    });
    webSocket.on('close', () => {
      const state = this.connections.get(webSocket);
      this.connections.delete(webSocket);
      if (state?.canvasId) {
        this.broadcast(session.projectId, state.canvasId, {
          type: 'presence.left',
          canvasId: state.canvasId,
          memberId: session.memberId,
          connectionId: state.connectionId,
        }, null, state.server);
      }
    });
  }

  broadcast(projectId, canvasId, message, except = null, targetServer = null) {
    let sent = 0;
    for (const [webSocket, state] of this.connections.entries()) {
      if (this.sendSocketJsonBestEffort(webSocket, 'canvas-broadcast', () => {
        if (webSocket === except || webSocket.readyState !== WebSocket.OPEN) return null;
        if (targetServer && state.server !== targetServer) return null;
        if (state.canvasId !== canvasId) return null;
        const session = this.refreshConnectionSession(webSocket, state);
        if (!session || session.projectId !== projectId) return null;
        return this.publicReviewVisibleValue(session, message);
      })) sent += 1;
    }
    return sent;
  }

  sendMemberScoped(projectId, canvasId, memberIds, message) {
    const recipients = memberIds instanceof Set
      ? memberIds
      : new Set(Array.isArray(memberIds) ? memberIds.map(String) : []);
    if (recipients.size === 0) return 0;
    let sent = 0;
    for (const [webSocket, state] of this.connections.entries()) {
      if (this.sendSocketJsonBestEffort(webSocket, 'member-scoped', () => {
        if (webSocket.readyState !== WebSocket.OPEN || state.canvasId !== canvasId) return null;
        const session = this.refreshConnectionSession(webSocket, state);
        if (!session
          || String(session.projectId) !== String(projectId)
          || !recipients.has(String(session.memberId))) return null;
        return this.publicReviewVisibleValue(session, message);
      })) sent += 1;
    }
    return sent;
  }

  broadcastProject(projectId, message, except = null) {
    let sent = 0;
    for (const [webSocket, state] of this.connections.entries()) {
      if (this.sendSocketJsonBestEffort(webSocket, 'project-broadcast', () => {
        if (webSocket === except || webSocket.readyState !== WebSocket.OPEN) return null;
        const session = this.refreshConnectionSession(webSocket, state);
        if (!session || session.projectId !== projectId) return null;
        return this.publicReviewVisibleValue(session, message);
      })) sent += 1;
    }
    return sent;
  }

  broadcastSubflowPublication(projectId, definitionId, version, message, except = null) {
    const normalizedProjectId = String(projectId || '');
    const normalizedDefinitionId = String(definitionId || '').trim();
    const normalizedVersion = Number(version);
    if (!normalizedProjectId
      || !normalizedDefinitionId
      || !Number.isInteger(normalizedVersion)
      || normalizedVersion < 1) return 0;
    let sent = 0;
    for (const [webSocket, state] of this.connections.entries()) {
      if (this.sendSocketJsonBestEffort(webSocket, 'subflow-publication', () => {
        if (webSocket === except || webSocket.readyState !== WebSocket.OPEN) return null;
        const session = this.refreshConnectionSession(webSocket, state);
        if (!session || String(session.projectId) !== normalizedProjectId) return null;
        if (!this.sessionCanAccessSubflow(
          session,
          normalizedDefinitionId,
          normalizedVersion,
        )) return null;
        return this.publicReviewVisibleValue(session, message);
      })) sent += 1;
    }
    return sent;
  }

  broadcastHostRunIntent(intent) {
    if (!intent) return false;
    return this.notifyCommitted('host.run-intent', () => {
      this.broadcast(intent.projectId, intent.canvasId, {
        type: 'run.intent-state',
        intent: {
          id: intent.id,
          canvasId: intent.canvasId,
          canvasRevision: intent.canvasRevision,
          requestedBy: intent.requestedBy,
          status: intent.status,
          runId: intent.runId || null,
          provider: intent.provider || null,
          model: intent.model || null,
          estimatedCost: intent.estimatedCostKnown === true ? Math.max(0, Number(intent.estimatedCost) || 0) : null,
          estimatedCostKnown: intent.estimatedCostKnown === true,
          actualCost: intent.actualCost == null ? null : Number(intent.actualCost),
          queueRevision: Math.max(1, Number(intent.queueRevision) || 1),
          confirmationRequired: intent.confirmationRequired !== false,
          confirmedAt: intent.confirmedAt == null ? null : Number(intent.confirmedAt),
          dispatchAttempts: Math.max(0, Number(intent.dispatchAttempts) || 0),
          nextAttemptAt: intent.nextAttemptAt == null ? null : Number(intent.nextAttemptAt),
          leaseExpiresAt: intent.leaseExpiresAt == null ? null : Number(intent.leaseExpiresAt),
          cancelRequestedAt: intent.cancelRequestedAt == null ? null : Number(intent.cancelRequestedAt),
          cancelledAt: intent.cancelledAt == null ? null : Number(intent.cancelledAt),
          lastError: intent.lastErrorCode || intent.lastErrorMessage
            ? publicCollaborationCanvasValue({
                code: intent.lastErrorCode || 'dispatch_failed',
                message: intent.lastErrorMessage || '运行派发失败',
              })
            : null,
          createdAt: intent.createdAt,
          updatedAt: intent.updatedAt,
        },
      });
    });
  }

  broadcastHostRunState(run) {
    if (!run) return false;
    return this.notifyCommitted('host.run-state', () => {
      this.broadcast(run.projectId, run.canvasId, { type: 'run.state', run: publicRunState(run) });
    });
  }

  broadcastHostNodeRunState(run, nodeRun) {
    if (!run || !nodeRun) return false;
    return this.notifyCommitted('host.node-state', () => {
      const outputRefs = Array.isArray(nodeRun.outputRefs) ? nodeRun.outputRefs.map(String).slice(0, 1000) : [];
      const assets = outputRefs.map((assetId) => this.database.getAsset(assetId)).filter(Boolean);
      this.sendAssetScoped(run.projectId, run.canvasId, (session) => {
        const accessibleIds = new Set(this.filterSessionAssets(session, assets, 'view').map((asset) => String(asset.id)));
        return {
          type: 'run.node-state',
          runId: run.id,
          node: publicNodeRunState(run.id, nodeRun, outputRefs.filter((assetId) => accessibleIds.has(assetId))),
        };
      });
    });
  }

  broadcastHostRunOutput(run, nodeRun, assets) {
    if (!run || !nodeRun) return false;
    return this.notifyCommitted('host.run-output', () => {
      const canonicalAssets = (Array.isArray(assets) ? assets : [])
        .slice(0, 1000)
        .map((asset) => this.database.getAsset(asset?.id))
        .filter((asset) => asset && String(asset.projectId) === String(run.projectId));
      this.sendAssetScoped(run.projectId, run.canvasId, (session) => {
        const visible = this.filterSessionAssets(session, canonicalAssets, 'preview');
        return {
          type: 'run.output',
          runId: run.id,
          nodeRunId: nodeRun.id,
          nodeId: String(nodeRun.originalNodeId || nodeRun.nodeId),
          assets: visible.map((asset) => {
            const safe = this.publicAssetForSession(session, asset);
            return {
              id: String(asset.id),
              kind: String(asset.kind || 'other'),
              filename: String(asset.filename || 'asset').slice(0, 300),
              mimeType: String(asset.mimeType || 'application/octet-stream'),
              mediaUrl: safe?.representations?.preview || null,
            };
          }),
        };
      });
    });
  }

  startWebSocketHeartbeat(server) {
    if (!server || this.webSocketHeartbeatTimers.has(server)) return;
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [webSocket, state] of this.connections.entries()) {
        if (state?.server !== server || webSocket.readyState !== WebSocket.OPEN) continue;
        const pongTimedOut = state.awaitingNativePong
          && Number.isFinite(state.lastNativePingAt)
          && now - state.lastNativePingAt >= this.webSocketHeartbeatTimeoutMs;
        const idleTimedOut = now - Number(state.lastSeenAt || 0) >= this.webSocketHeartbeatTimeoutMs;
        if (pongTimedOut || idleTimedOut) {
          try {
            webSocket.send(JSON.stringify({
              type: 'connection.timeout',
              reason: 'heartbeat_timeout',
              timestamp: now,
            }));
          } catch (_) { /* close remains authoritative */ }
          try { webSocket.close(WS_CLOSE_HEARTBEAT_TIMEOUT, 'heartbeat timeout'); } catch (_) { /* already closed */ }
          this.scheduleWebSocketTermination(webSocket);
          continue;
        }
        if (state.awaitingNativePong) continue;
        state.awaitingNativePong = true;
        state.lastNativePingAt = now;
        try { webSocket.ping(); } catch (_) {
          try { webSocket.terminate(); } catch (_) { /* already closed */ }
        }
      }
    }, this.webSocketHeartbeatIntervalMs);
    timer.unref?.();
    this.webSocketHeartbeatTimers.set(server, timer);
  }

  clearWebSocketHeartbeat(server) {
    const timer = server ? this.webSocketHeartbeatTimers.get(server) : null;
    if (!timer) return;
    clearInterval(timer);
    this.webSocketHeartbeatTimers.delete(server);
  }

  async closeServerResources(server, webSocketServer, reason, options = {}) {
    this.clearWebSocketHeartbeat(server);
    const serverWebSockets = new Set(webSocketServer?.clients || []);
    const closeCode = Number.isInteger(Number(options.closeCode))
      ? Number(options.closeCode)
      : WS_CLOSE_HOST_STOPPED;
    const noticeReason = String(options.noticeReason || 'host_stopped');
    const retryable = options.retryable === true;
    const retryAfterMs = Math.max(0, Math.trunc(Number(options.retryAfterMs) || 0));
    for (const [webSocket, state] of this.connections.entries()) {
      if (state?.server !== server) continue;
      serverWebSockets.add(webSocket);
      if (webSocket.readyState === WebSocket.OPEN) {
        try {
          webSocket.send(JSON.stringify({
            type: 'gateway.stopping',
            reason: noticeReason,
            retryable,
            retryAfterMs,
            timestamp: Date.now(),
          }));
        } catch (_) { /* close remains authoritative */ }
      }
      this.connections.delete(webSocket);
      try { webSocket.close(closeCode, reason); } catch (_) { /* already closed */ }
      this.scheduleWebSocketTermination(webSocket, SERVER_CLOSE_GRACE_MS);
    }
    await new Promise((resolve) => {
      let settled = false;
      let forceTimer = null;
      let settleTimer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        clearTimeout(settleTimer);
        resolve();
      };
      forceTimer = setTimeout(() => {
        for (const webSocket of serverWebSockets) {
          if (webSocket.readyState === WebSocket.CLOSED) continue;
          try { webSocket.terminate(); } catch (_) { /* already closed */ }
        }
        try { server.closeIdleConnections?.(); } catch (_) { /* best effort */ }
        try { server.closeAllConnections?.(); } catch (_) { /* best effort */ }
        settleTimer = setTimeout(finish, SERVER_CLOSE_SETTLE_MS);
      }, SERVER_CLOSE_GRACE_MS);
      try {
        server.close(finish);
      } catch (_) {
        finish();
      }
    });
    try { webSocketServer?.close(); } catch (_) { /* already closed */ }
  }

  async stopInternal() {
    this.clearSubflowUpgradePlans();
    this.publicSelfCheckChallenges.clear();
    const server = this.server;
    const webSocketServer = this.webSocketServer;
    if (server) {
      await this.closeServerResources(server, webSocketServer, 'gateway stopped', {
        closeCode: WS_CLOSE_HOST_STOPPED,
        noticeReason: 'host_stopped',
        retryable: false,
      });
    }
    if (this.server === server) {
      this.server = null;
      this.webSocketServer = null;
      this.startedAt = null;
      this.host = null;
      this.port = null;
    }
    return {
      ...this.managementStatus(),
      applicationRequests: await this.applicationLifecycle.waitForDrain(0),
    };
  }

  stop() {
    return this.enqueueLifecycle('stop', 'gateway', () => this.stopInternal());
  }

  shutdown() {
    this.runtimeShutdownRequested = true;
    return this.enqueueLifecycle('shutdown', 'gateway', () => this.stopInternal());
  }

  applicationRequestStatus() {
    return this.applicationLifecycle.status();
  }

  waitForApplicationRequests(timeoutMs = null) {
    return this.applicationLifecycle.waitForDrain(timeoutMs);
  }
}

let singleton = null;

function getCollaborationGateway(config) {
  if (!singleton) singleton = new CollaborationGateway(config);
  return singleton;
}

function peekCollaborationGateway() {
  return singleton;
}

module.exports = {
  CollaborationGateway,
  SESSION_COOKIE,
  createFixedWindowLimiter,
  getCollaborationGateway,
  peekCollaborationGateway,
  publicNodeRunState,
  publicRunOutputAssets,
  publicRunState,
  requestClientAddress,
};
