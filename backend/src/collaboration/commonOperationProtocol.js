const crypto = require('crypto');

const COMMON_OPERATION_BATCH_CONTRACT = 't8-common-operation-batch-v1';
const COMMON_OPERATION_MAX_OPERATIONS = 500;
const COMMON_OPERATION_MAX_BATCH_BYTES = 1024 * 1024;
const COMMON_OPERATION_MAX_JSON_DEPTH = 32;
const COMMON_OPERATION_MAX_JSON_NODES = 100_000;
const MAX_CANVAS_COORDINATE = 10_000_000;
const MAX_CANVAS_ZOOM = 64;
const MAX_REVIEW_MENTIONS = 20;
const MAX_REVIEW_ATTACHMENTS = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/i;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,79}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,79}$/i;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const COMMON_OPERATION_TYPES = Object.freeze([
  'node.add',
  'node.patch',
  'node.move',
  'node.delete',
  'node.restore',
  'edge.add',
  'edge.delete',
  'edge.restore',
  'viewport.set',
  'review.thread.create',
  'review.comment.add',
  'review.thread.update',
  'subflow.instance.upgrade',
  'host.artifact.commit',
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

const COMMON_OPERATION_CONTRACTS = deepFreeze({
  'node.add': {
    domain: 'graph', identityFields: ['nodeUid'], casFields: ['expectedAbsent'], revisionScope: 'canvas-base',
  },
  'node.patch': {
    domain: 'graph', identityFields: ['nodeUid'], casFields: ['expectedEntityRevision'], revisionScope: 'canvas-base',
  },
  'node.move': {
    domain: 'graph', identityFields: ['nodeUid'], casFields: ['expectedEntityRevision'], revisionScope: 'canvas-base',
  },
  'node.delete': {
    domain: 'graph', identityFields: ['nodeUid'], casFields: ['expectedEntityRevision'], revisionScope: 'canvas-base',
  },
  'node.restore': {
    domain: 'graph', identityFields: ['nodeUid'], casFields: ['expectedTombstoneRevision'], revisionScope: 'canvas-base',
  },
  'edge.add': {
    domain: 'graph', identityFields: ['edgeUid', 'sourceNodeUid', 'targetNodeUid'], casFields: ['expectedAbsent'], revisionScope: 'canvas-base',
  },
  'edge.delete': {
    domain: 'graph', identityFields: ['edgeUid'], casFields: ['expectedEntityRevision'], revisionScope: 'canvas-base',
  },
  'edge.restore': {
    domain: 'graph', identityFields: ['edgeUid', 'sourceNodeUid', 'targetNodeUid'], casFields: ['expectedTombstoneRevision'], revisionScope: 'canvas-base',
  },
  'viewport.set': {
    domain: 'graph', identityFields: [], casFields: ['expectedViewportRevision'], revisionScope: 'canvas-base',
  },
  'review.thread.create': {
    domain: 'review', identityFields: ['threadUid', 'initialComment.commentUid'], casFields: ['expectedCanvasRevision'], revisionScope: 'canvas-base',
  },
  'review.comment.add': {
    domain: 'review', identityFields: ['threadUid', 'commentUid', 'parentCommentUid'], casFields: ['expectedCanvasRevision', 'expectedThreadRevision'], revisionScope: 'canvas-and-thread',
  },
  'review.thread.update': {
    domain: 'review', identityFields: ['threadUid'], casFields: ['expectedCanvasRevision', 'expectedThreadRevision', 'decisionCanvasRevision'], revisionScope: 'canvas-and-thread',
  },
  'subflow.instance.upgrade': {
    domain: 'subflow', identityFields: ['instanceUid', 'definitionUid'], casFields: ['expectedCanvasRevision', 'expectedInstanceRevision', 'expectedDefinitionVersion', 'expectedDefinitionRevision', 'targetDefinitionVersion', 'targetDefinitionRevision', 'upgradePlanDigest'], revisionScope: 'canvas-instance-definition',
  },
  'host.artifact.commit': {
    domain: 'host-artifact', identityFields: ['artifactUid', 'blobUid', 'runUid', 'nodeRunUid', 'attemptUid', 'nodeUid'], casFields: ['expectedCanvasRevision', 'expectedRunRevision', 'expectedNodeRunRevision', 'expectedAttemptRevision'], revisionScope: 'canvas-run-attempt',
  },
});

class CommonOperationProtocolError extends Error {
  constructor(code, message, path = '') {
    super(message);
    this.name = 'CommonOperationProtocolError';
    this.code = code;
    this.path = path;
    this.status = 400;
  }
}

function fail(code, path, message) {
  throw new CommonOperationProtocolError(code, `${path}: ${message}`, path);
}

function ownDataKeys(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('common_operation_unsafe_object', path, '必须是普通对象');
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== 'string' || UNSAFE_OBJECT_KEYS.has(key)) {
      fail('common_operation_unsafe_object', path, '包含不安全字段或 Symbol');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('common_operation_unsafe_object', `${path}.${key}`, '只允许可枚举数据字段');
    }
  }
  return keys;
}

function assertPlainArray(value, path, maximum = 10_000) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    fail('common_operation_unsafe_object', path, `必须是最多 ${maximum} 项的普通数组`);
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      fail('common_operation_unsafe_object', path, '数组包含自定义字段');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('common_operation_unsafe_object', `${path}[${key}]`, '数组只允许可枚举数据项');
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) fail('common_operation_unsafe_object', path, '不允许稀疏数组');
  }
  return value;
}

function exactRecord(value, path, allowedKeys, requiredKeys = allowedKeys) {
  const keys = ownDataKeys(value, path);
  const allowed = new Set(allowedKeys);
  const required = new Set(requiredKeys);
  for (const key of keys) {
    if (!allowed.has(key)) fail('common_operation_extra_field', `${path}.${key}`, '字段不在协议中');
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail('common_operation_missing_field', `${path}.${key}`, '缺少必填字段');
    }
  }
  return value;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function boundedString(value, path, maximum, options = {}) {
  const minimum = options.minimum == null ? 1 : options.minimum;
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    fail('common_operation_string_invalid', path, `必须是 ${minimum}-${maximum} 字符字符串`);
  }
  if (options.trimmed && value.trim() !== value) fail('common_operation_string_invalid', path, '首尾不得含空白');
  const controlPattern = options.allowNewlines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (controlPattern.test(value) || UNSAFE_OBJECT_KEYS.has(value)) {
    fail('common_operation_string_invalid', path, '包含控制字符或保留名称');
  }
  if (options.pattern && !options.pattern.test(value)) fail('common_operation_string_invalid', path, '格式无效');
  return value;
}

function canonicalUuid(value, path) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('common_operation_uuid_invalid', path, '必须是 RFC 4122 UUID');
  }
  return value.toLowerCase();
}

function nullableUuid(value, path) {
  return value === null ? null : canonicalUuid(value, path);
}

function boundedInteger(value, path, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('common_operation_integer_invalid', path, `必须是 ${minimum}-${maximum} 的安全整数`);
  }
  return value;
}

function boundedNumber(value, path, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail('common_operation_number_invalid', path, `必须是 ${minimum}-${maximum} 的有限数值`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function literalTrue(value, path) {
  if (value !== true) fail('common_operation_cas_invalid', path, '必须明确为 true');
  return true;
}

function enumValue(value, path, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail('common_operation_enum_invalid', path, `必须是 ${allowed.join('/')}`);
  }
  return value;
}

function digestValue(value, path) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail('common_operation_digest_invalid', path, '必须是 64 位 SHA-256 十六进制摘要');
  }
  return value.toLowerCase();
}

function cloneSafeJson(value, path, budget = { nodes: 0 }, depth = 0) {
  budget.nodes += 1;
  if (budget.nodes > COMMON_OPERATION_MAX_JSON_NODES || depth > COMMON_OPERATION_MAX_JSON_DEPTH) {
    fail('common_operation_limit_exceeded', path, '超过安全 JSON 深度或节点上限');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (value === undefined) fail('common_operation_json_invalid', path, '不允许 undefined');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('common_operation_json_invalid', path, '数字必须有限');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'string') {
    if (value.length > COMMON_OPERATION_MAX_BATCH_BYTES || /\u0000/.test(value)) {
      fail('common_operation_json_invalid', path, '字符串过大或包含 NUL');
    }
    return value;
  }
  if (Array.isArray(value)) {
    assertPlainArray(value, path, 10_000);
    return value.map((item, index) => cloneSafeJson(item, `${path}[${index}]`, budget, depth + 1));
  }
  const keys = ownDataKeys(value, path);
  if (keys.length > 1000) fail('common_operation_limit_exceeded', path, '对象字段超过 1000');
  const output = {};
  for (const key of keys) {
    boundedString(key, `${path}.[key]`, 240);
    output[key] = cloneSafeJson(value[key], `${path}.${key}`, budget, depth + 1);
  }
  return output;
}

function safeJsonObject(value, path) {
  const cloned = cloneSafeJson(value, path);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    fail('common_operation_json_invalid', path, '必须是 JSON 对象');
  }
  return cloned;
}

function position(value, path) {
  exactRecord(value, path, ['x', 'y']);
  return {
    x: boundedNumber(value.x, `${path}.x`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
    y: boundedNumber(value.y, `${path}.y`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
  };
}

function viewport(value, path) {
  exactRecord(value, path, ['x', 'y', 'zoom']);
  return {
    x: boundedNumber(value.x, `${path}.x`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
    y: boundedNumber(value.y, `${path}.y`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
    zoom: boundedNumber(value.zoom, `${path}.zoom`, 0.01, MAX_CANVAS_ZOOM),
  };
}

function revisionAtOrBefore(value, path, baseRevision) {
  const revision = boundedInteger(value, path, 1);
  if (revision > baseRevision) fail('common_operation_cas_invalid', path, '不能超过批次 baseRevision');
  return revision;
}

function exactCanvasRevision(value, path, baseRevision) {
  const revision = boundedInteger(value, path, 1);
  if (revision !== baseRevision) fail('common_operation_cas_invalid', path, '必须精确等于批次 baseRevision');
  return revision;
}

function nullableHandle(value, path) {
  return value === null ? null : boundedString(value, path, 160);
}

function patchFields(value, path) {
  const result = safeJsonObject(value, path);
  const protectedFields = new Set(['id', 'displayId', 'type', 'nodeType', 'nodeUid', 'entityUid', 'entityRevision']);
  const keys = Object.keys(result);
  if (keys.length > 500) fail('common_operation_limit_exceeded', path, '修改字段超过 500');
  for (const key of keys) {
    if (protectedFields.has(key)) fail('common_operation_payload_invalid', `${path}.${key}`, '身份字段不可修改');
  }
  return result;
}

function unsetFields(value, path) {
  assertPlainArray(value, path, 500);
  const protectedFields = new Set(['id', 'displayId', 'type', 'nodeType', 'nodeUid', 'entityUid', 'entityRevision']);
  const result = value.map((item, index) => boundedString(item, `${path}[${index}]`, 160));
  if (new Set(result).size !== result.length) fail('common_operation_payload_invalid', path, '字段不得重复');
  if (result.some((key) => protectedFields.has(key))) fail('common_operation_payload_invalid', path, '身份字段不可删除');
  return result;
}

function graphNodeCreatePayload(value, path, baseRevision, restoring) {
  const common = ['nodeUid', 'displayId', 'nodeType', 'position', 'data'];
  const casField = restoring ? 'expectedTombstoneRevision' : 'expectedAbsent';
  exactRecord(value, path, [...common, casField]);
  const output = {
    nodeUid: canonicalUuid(value.nodeUid, `${path}.nodeUid`),
    displayId: boundedString(value.displayId, `${path}.displayId`, 240),
    nodeType: boundedString(value.nodeType, `${path}.nodeType`, 160),
    position: position(value.position, `${path}.position`),
    data: safeJsonObject(value.data, `${path}.data`),
  };
  if (restoring) output.expectedTombstoneRevision = revisionAtOrBefore(value.expectedTombstoneRevision, `${path}.expectedTombstoneRevision`, baseRevision);
  else output.expectedAbsent = literalTrue(value.expectedAbsent, `${path}.expectedAbsent`);
  return output;
}

function graphEdgeCreatePayload(value, path, baseRevision, restoring) {
  const common = ['edgeUid', 'displayId', 'sourceNodeUid', 'targetNodeUid', 'sourceHandle', 'targetHandle', 'edgeType', 'data'];
  const casField = restoring ? 'expectedTombstoneRevision' : 'expectedAbsent';
  exactRecord(value, path, [...common, casField]);
  const output = {
    edgeUid: canonicalUuid(value.edgeUid, `${path}.edgeUid`),
    displayId: boundedString(value.displayId, `${path}.displayId`, 240),
    sourceNodeUid: canonicalUuid(value.sourceNodeUid, `${path}.sourceNodeUid`),
    targetNodeUid: canonicalUuid(value.targetNodeUid, `${path}.targetNodeUid`),
    sourceHandle: nullableHandle(value.sourceHandle, `${path}.sourceHandle`),
    targetHandle: nullableHandle(value.targetHandle, `${path}.targetHandle`),
    edgeType: boundedString(value.edgeType, `${path}.edgeType`, 160),
    data: safeJsonObject(value.data, `${path}.data`),
  };
  if (restoring) output.expectedTombstoneRevision = revisionAtOrBefore(value.expectedTombstoneRevision, `${path}.expectedTombstoneRevision`, baseRevision);
  else output.expectedAbsent = literalTrue(value.expectedAbsent, `${path}.expectedAbsent`);
  return output;
}

function reviewBody(value, path) {
  return boundedString(value, path, 5000, { trimmed: true, allowNewlines: true });
}

function reviewMentions(value, path) {
  assertPlainArray(value, path, MAX_REVIEW_MENTIONS);
  const normalized = value.map((item, index) => canonicalUuid(item, `${path}[${index}]`));
  return [...new Set(normalized)];
}

function reviewAttachments(value, path) {
  assertPlainArray(value, path, MAX_REVIEW_ATTACHMENTS);
  const normalized = value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    exactRecord(item, itemPath, ['assetUid', 'assetContentRevision', 'contentHash']);
    const contentHash = boundedString(item.contentHash, `${itemPath}.contentHash`, 64, {
      pattern: /^[a-f0-9]{64}$/,
    });
    return {
      assetUid: canonicalUuid(item.assetUid, `${itemPath}.assetUid`),
      assetContentRevision: boundedInteger(item.assetContentRevision, `${itemPath}.assetContentRevision`, 1),
      contentHash,
    };
  });
  const assetUids = normalized.map((item) => item.assetUid);
  if (new Set(assetUids).size !== assetUids.length) {
    fail('common_operation_payload_invalid', path, '同一评论的附件 assetUid 不得重复');
  }
  return normalized;
}

function addOptionalReviewReferences(input, path, output) {
  if (hasOwn(input, 'mentions')) output.mentions = reviewMentions(input.mentions, `${path}.mentions`);
  if (hasOwn(input, 'attachments')) output.attachments = reviewAttachments(input.attachments, `${path}.attachments`);
  return output;
}

function reviewAnchor(value, path) {
  exactRecord(value, path, [
    'kind', 'x', 'y', 'targetUid', 'frameMs', 'assetRevision', 'assetContentRevision', 'contentHash',
  ], ['kind']);
  const kind = enumValue(value.kind, `${path}.kind`, ['canvas', 'node', 'edge', 'asset', 'video']);
  if (kind === 'canvas') {
    exactRecord(value, path, ['kind', 'x', 'y']);
    return {
      kind,
      x: boundedNumber(value.x, `${path}.x`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
      y: boundedNumber(value.y, `${path}.y`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
    };
  }
  if (kind === 'video') {
    if (hasOwn(value, 'assetContentRevision') || hasOwn(value, 'contentHash')) {
      exactRecord(value, path, ['kind', 'targetUid', 'frameMs', 'assetContentRevision', 'contentHash']);
      return {
        kind,
        targetUid: canonicalUuid(value.targetUid, `${path}.targetUid`),
        frameMs: boundedInteger(value.frameMs, `${path}.frameMs`, 0, 7 * 24 * 60 * 60 * 1000),
        assetContentRevision: boundedInteger(value.assetContentRevision, `${path}.assetContentRevision`, 1),
        contentHash: boundedString(value.contentHash, `${path}.contentHash`, 64, {
          pattern: /^[a-f0-9]{64}$/,
        }),
      };
    }
    // Frozen v1 compatibility only. This legacy pin remains byte-for-byte
    // stable for exact retry/digest and is never reinterpreted as a content pin.
    exactRecord(value, path, ['kind', 'targetUid', 'frameMs', 'assetRevision']);
    return {
      kind,
      targetUid: canonicalUuid(value.targetUid, `${path}.targetUid`),
      frameMs: boundedInteger(value.frameMs, `${path}.frameMs`, 0, 7 * 24 * 60 * 60 * 1000),
      assetRevision: boundedInteger(value.assetRevision, `${path}.assetRevision`, 1),
    };
  }
  exactRecord(value, path, ['kind', 'targetUid']);
  return { kind, targetUid: canonicalUuid(value.targetUid, `${path}.targetUid`) };
}

function normalizePayload(type, value, baseRevision, path) {
  if (type === 'node.add') return graphNodeCreatePayload(value, path, baseRevision, false);
  if (type === 'node.restore') return graphNodeCreatePayload(value, path, baseRevision, true);
  if (type === 'node.patch') {
    exactRecord(value, path, ['nodeUid', 'expectedEntityRevision', 'fields', 'unsetFields']);
    const fields = patchFields(value.fields, `${path}.fields`);
    const unset = unsetFields(value.unsetFields, `${path}.unsetFields`);
    if (Object.keys(fields).length === 0 && unset.length === 0) fail('common_operation_payload_invalid', path, '修改不得为空');
    if (unset.some((key) => Object.prototype.hasOwnProperty.call(fields, key))) fail('common_operation_payload_invalid', path, '同一字段不能同时设置和删除');
    return {
      nodeUid: canonicalUuid(value.nodeUid, `${path}.nodeUid`),
      expectedEntityRevision: revisionAtOrBefore(value.expectedEntityRevision, `${path}.expectedEntityRevision`, baseRevision),
      fields,
      unsetFields: unset,
    };
  }
  if (type === 'node.move') {
    exactRecord(value, path, ['nodeUid', 'expectedEntityRevision', 'position']);
    return {
      nodeUid: canonicalUuid(value.nodeUid, `${path}.nodeUid`),
      expectedEntityRevision: revisionAtOrBefore(value.expectedEntityRevision, `${path}.expectedEntityRevision`, baseRevision),
      position: position(value.position, `${path}.position`),
    };
  }
  if (type === 'node.delete') {
    exactRecord(value, path, ['nodeUid', 'expectedEntityRevision']);
    return {
      nodeUid: canonicalUuid(value.nodeUid, `${path}.nodeUid`),
      expectedEntityRevision: revisionAtOrBefore(value.expectedEntityRevision, `${path}.expectedEntityRevision`, baseRevision),
    };
  }
  if (type === 'edge.add') return graphEdgeCreatePayload(value, path, baseRevision, false);
  if (type === 'edge.restore') return graphEdgeCreatePayload(value, path, baseRevision, true);
  if (type === 'edge.delete') {
    exactRecord(value, path, ['edgeUid', 'expectedEntityRevision']);
    return {
      edgeUid: canonicalUuid(value.edgeUid, `${path}.edgeUid`),
      expectedEntityRevision: revisionAtOrBefore(value.expectedEntityRevision, `${path}.expectedEntityRevision`, baseRevision),
    };
  }
  if (type === 'viewport.set') {
    exactRecord(value, path, ['expectedViewportRevision', 'viewport']);
    return {
      expectedViewportRevision: revisionAtOrBefore(value.expectedViewportRevision, `${path}.expectedViewportRevision`, baseRevision),
      viewport: viewport(value.viewport, `${path}.viewport`),
    };
  }
  if (type === 'review.thread.create') {
    exactRecord(
      value,
      path,
      ['threadUid', 'expectedCanvasRevision', 'anchor', 'severity', 'initialComment', 'reviewStatus'],
      ['threadUid', 'expectedCanvasRevision', 'anchor', 'severity', 'initialComment'],
    );
    exactRecord(
      value.initialComment,
      `${path}.initialComment`,
      ['commentUid', 'body', 'mentions', 'attachments'],
      ['commentUid', 'body'],
    );
    const initialComment = addOptionalReviewReferences(
      value.initialComment,
      `${path}.initialComment`,
      {
        commentUid: canonicalUuid(value.initialComment.commentUid, `${path}.initialComment.commentUid`),
        body: reviewBody(value.initialComment.body, `${path}.initialComment.body`),
      },
    );
    const result = {
      threadUid: canonicalUuid(value.threadUid, `${path}.threadUid`),
      expectedCanvasRevision: exactCanvasRevision(value.expectedCanvasRevision, `${path}.expectedCanvasRevision`, baseRevision),
      anchor: reviewAnchor(value.anchor, `${path}.anchor`),
      severity: enumValue(value.severity, `${path}.severity`, ['low', 'normal', 'high', 'blocking']),
      initialComment,
    };
    if (hasOwn(value, 'reviewStatus')) {
      result.reviewStatus = enumValue(value.reviewStatus, `${path}.reviewStatus`, ['draft']);
    }
    return result;
  }
  if (type === 'review.comment.add') {
    exactRecord(
      value,
      path,
      [
        'threadUid', 'commentUid', 'parentCommentUid', 'expectedCanvasRevision', 'expectedThreadRevision',
        'body', 'mentions', 'attachments',
      ],
      ['threadUid', 'commentUid', 'parentCommentUid', 'expectedCanvasRevision', 'expectedThreadRevision', 'body'],
    );
    return addOptionalReviewReferences(value, path, {
      threadUid: canonicalUuid(value.threadUid, `${path}.threadUid`),
      commentUid: canonicalUuid(value.commentUid, `${path}.commentUid`),
      parentCommentUid: nullableUuid(value.parentCommentUid, `${path}.parentCommentUid`),
      expectedCanvasRevision: exactCanvasRevision(value.expectedCanvasRevision, `${path}.expectedCanvasRevision`, baseRevision),
      expectedThreadRevision: boundedInteger(value.expectedThreadRevision, `${path}.expectedThreadRevision`, 1),
      body: reviewBody(value.body, `${path}.body`),
    });
  }
  if (type === 'review.thread.update') {
    const commonKeys = ['threadUid', 'expectedCanvasRevision', 'expectedThreadRevision', 'severity'];
    if (hasOwn(value, 'status')) {
      exactRecord(value, path, [...commonKeys, 'status', 'decisionCanvasRevision']);
      const status = enumValue(value.status, `${path}.status`, ['open', 'resolved', 'approved', 'changes_requested']);
      const decisionCanvasRevision = value.decisionCanvasRevision === null
        ? null
        : exactCanvasRevision(value.decisionCanvasRevision, `${path}.decisionCanvasRevision`, baseRevision);
      if (['approved', 'changes_requested'].includes(status) ? decisionCanvasRevision == null : decisionCanvasRevision != null) {
        fail('common_operation_cas_invalid', `${path}.decisionCanvasRevision`, '审批状态必须绑定当前 canvas revision，非审批状态必须为 null');
      }
      return {
        threadUid: canonicalUuid(value.threadUid, `${path}.threadUid`),
        expectedCanvasRevision: exactCanvasRevision(value.expectedCanvasRevision, `${path}.expectedCanvasRevision`, baseRevision),
        expectedThreadRevision: boundedInteger(value.expectedThreadRevision, `${path}.expectedThreadRevision`, 1),
        status,
        severity: enumValue(value.severity, `${path}.severity`, ['low', 'normal', 'high', 'blocking']),
        decisionCanvasRevision,
      };
    }
    exactRecord(
      value,
      path,
      [...commonKeys, 'resolutionStatus', 'reviewStatus', 'decisionCanvasRevision'],
      commonKeys,
    );
    const hasResolutionStatus = hasOwn(value, 'resolutionStatus');
    const hasReviewStatus = hasOwn(value, 'reviewStatus');
    if (hasResolutionStatus === hasReviewStatus) {
      fail('common_operation_payload_invalid', path, '必须且只能更新 resolutionStatus 或 reviewStatus 之一');
    }
    const result = {
      threadUid: canonicalUuid(value.threadUid, `${path}.threadUid`),
      expectedCanvasRevision: exactCanvasRevision(value.expectedCanvasRevision, `${path}.expectedCanvasRevision`, baseRevision),
      expectedThreadRevision: boundedInteger(value.expectedThreadRevision, `${path}.expectedThreadRevision`, 1),
      severity: enumValue(value.severity, `${path}.severity`, ['low', 'normal', 'high', 'blocking']),
    };
    if (hasResolutionStatus) {
      if (hasOwn(value, 'decisionCanvasRevision')) {
        fail('common_operation_payload_invalid', `${path}.decisionCanvasRevision`, '解决状态更新不得覆盖评审决定 revision');
      }
      result.resolutionStatus = enumValue(value.resolutionStatus, `${path}.resolutionStatus`, ['open', 'resolved']);
      return result;
    }
    const reviewStatus = enumValue(value.reviewStatus, `${path}.reviewStatus`, ['draft', 'in_review', 'approved', 'changes_requested']);
    if (!hasOwn(value, 'decisionCanvasRevision')) {
      fail('common_operation_missing_field', `${path}.decisionCanvasRevision`, '缺少必填字段');
    }
    const decisionCanvasRevision = value.decisionCanvasRevision === null
      ? null
      : exactCanvasRevision(value.decisionCanvasRevision, `${path}.decisionCanvasRevision`, baseRevision);
    if (['approved', 'changes_requested'].includes(reviewStatus) ? decisionCanvasRevision == null : decisionCanvasRevision != null) {
      fail('common_operation_cas_invalid', `${path}.decisionCanvasRevision`, '审批状态必须绑定当前 canvas revision，非审批状态必须为 null');
    }
    return {
      ...result,
      reviewStatus,
      decisionCanvasRevision,
    };
  }
  if (type === 'subflow.instance.upgrade') {
    exactRecord(value, path, [
      'instanceUid', 'definitionUid', 'expectedCanvasRevision', 'expectedInstanceRevision',
      'expectedDefinitionVersion', 'expectedDefinitionRevision', 'targetDefinitionVersion',
      'targetDefinitionRevision', 'upgradePlanDigest',
    ]);
    const expectedDefinitionVersion = boundedInteger(value.expectedDefinitionVersion, `${path}.expectedDefinitionVersion`, 1);
    const expectedDefinitionRevision = boundedInteger(value.expectedDefinitionRevision, `${path}.expectedDefinitionRevision`, 1);
    const targetDefinitionVersion = boundedInteger(value.targetDefinitionVersion, `${path}.targetDefinitionVersion`, 1);
    const targetDefinitionRevision = boundedInteger(value.targetDefinitionRevision, `${path}.targetDefinitionRevision`, 1);
    if (targetDefinitionVersion < expectedDefinitionVersion
      || (targetDefinitionVersion === expectedDefinitionVersion && targetDefinitionRevision <= expectedDefinitionRevision)) {
      fail('common_operation_cas_invalid', path, '目标定义必须严格晚于当前固定定义');
    }
    return {
      instanceUid: canonicalUuid(value.instanceUid, `${path}.instanceUid`),
      definitionUid: canonicalUuid(value.definitionUid, `${path}.definitionUid`),
      expectedCanvasRevision: exactCanvasRevision(value.expectedCanvasRevision, `${path}.expectedCanvasRevision`, baseRevision),
      expectedInstanceRevision: revisionAtOrBefore(value.expectedInstanceRevision, `${path}.expectedInstanceRevision`, baseRevision),
      expectedDefinitionVersion,
      expectedDefinitionRevision,
      targetDefinitionVersion,
      targetDefinitionRevision,
      upgradePlanDigest: digestValue(value.upgradePlanDigest, `${path}.upgradePlanDigest`),
    };
  }
  if (type === 'host.artifact.commit') {
    exactRecord(value, path, [
      'artifactUid', 'blobUid', 'runUid', 'nodeRunUid', 'attemptUid', 'nodeUid',
      'expectedCanvasRevision', 'expectedRunRevision', 'expectedNodeRunRevision',
      'expectedAttemptRevision', 'outputOrdinal', 'kind', 'contentHash', 'byteSize',
      'filename', 'mimeType',
    ]);
    const filename = boundedString(value.filename, `${path}.filename`, 240, { trimmed: true });
    if (filename === '.' || filename === '..' || /[\\/]/.test(filename)) {
      fail('common_operation_string_invalid', `${path}.filename`, '只能是文件名，不能包含路径');
    }
    return {
      artifactUid: canonicalUuid(value.artifactUid, `${path}.artifactUid`),
      blobUid: canonicalUuid(value.blobUid, `${path}.blobUid`),
      runUid: canonicalUuid(value.runUid, `${path}.runUid`),
      nodeRunUid: canonicalUuid(value.nodeRunUid, `${path}.nodeRunUid`),
      attemptUid: canonicalUuid(value.attemptUid, `${path}.attemptUid`),
      nodeUid: canonicalUuid(value.nodeUid, `${path}.nodeUid`),
      expectedCanvasRevision: exactCanvasRevision(value.expectedCanvasRevision, `${path}.expectedCanvasRevision`, baseRevision),
      expectedRunRevision: boundedInteger(value.expectedRunRevision, `${path}.expectedRunRevision`, 1),
      expectedNodeRunRevision: boundedInteger(value.expectedNodeRunRevision, `${path}.expectedNodeRunRevision`, 1),
      expectedAttemptRevision: boundedInteger(value.expectedAttemptRevision, `${path}.expectedAttemptRevision`, 1),
      outputOrdinal: boundedInteger(value.outputOrdinal, `${path}.outputOrdinal`, 0, 999),
      kind: enumValue(value.kind, `${path}.kind`, ['image', 'video', 'audio', 'model3d', 'text', 'other']),
      contentHash: digestValue(value.contentHash, `${path}.contentHash`),
      byteSize: boundedInteger(value.byteSize, `${path}.byteSize`, 0, 4 * 1024 * 1024 * 1024),
      filename,
      mimeType: boundedString(value.mimeType, `${path}.mimeType`, 160, { pattern: MIME_PATTERN }),
    };
  }
  fail('common_operation_type_invalid', path, `不支持 operation type: ${type}`);
}

function normalizeOperation(raw, baseRevision, index) {
  const path = `batch.operations[${index}]`;
  exactRecord(raw, path, ['opId', 'type', 'payload']);
  const type = enumValue(raw.type, `${path}.type`, COMMON_OPERATION_TYPES);
  return {
    opId: canonicalUuid(raw.opId, `${path}.opId`),
    type,
    payload: normalizePayload(type, raw.payload, baseRevision, `${path}.payload`),
  };
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function normalizeCommonOperationBatch(raw) {
  exactRecord(raw, 'batch', [
    'contractVersion', 'projectId', 'canvasId', 'baseRevision', 'batchId', 'clientId', 'clientSeq', 'operations',
  ]);
  if (raw.contractVersion !== COMMON_OPERATION_BATCH_CONTRACT) {
    fail('common_operation_contract_invalid', 'batch.contractVersion', `必须是 ${COMMON_OPERATION_BATCH_CONTRACT}`);
  }
  const baseRevision = boundedInteger(raw.baseRevision, 'batch.baseRevision', 1);
  if (!Array.isArray(raw.operations) || raw.operations.length < 1 || raw.operations.length > COMMON_OPERATION_MAX_OPERATIONS) {
    fail('common_operation_limit_exceeded', 'batch.operations', `必须包含 1-${COMMON_OPERATION_MAX_OPERATIONS} 个操作`);
  }
  assertPlainArray(raw.operations, 'batch.operations', COMMON_OPERATION_MAX_OPERATIONS);
  const normalized = {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    // Project/canvas are persisted lookup scopes in existing projects and may
    // still be human-readable legacy IDs. Entity identity inside every
    // operation is UUID-only; rejecting legacy scope IDs would make an
    // in-flight F2 queue impossible to upgrade safely.
    projectId: boundedString(raw.projectId, 'batch.projectId', 240, { trimmed: true }),
    canvasId: boundedString(raw.canvasId, 'batch.canvasId', 240, { trimmed: true }),
    baseRevision,
    batchId: canonicalUuid(raw.batchId, 'batch.batchId'),
    clientId: canonicalUuid(raw.clientId, 'batch.clientId'),
    clientSeq: boundedInteger(raw.clientSeq, 'batch.clientSeq', 0),
    operations: raw.operations.map((operation, index) => normalizeOperation(operation, baseRevision, index)),
  };
  const opIds = normalized.operations.map((operation) => operation.opId);
  if (new Set(opIds).size !== opIds.length) fail('common_operation_duplicate_op', 'batch.operations', 'opId 必须在批次内唯一');
  const bytes = Buffer.byteLength(stableJson(normalized), 'utf8');
  if (bytes > COMMON_OPERATION_MAX_BATCH_BYTES) {
    fail('common_operation_limit_exceeded', 'batch', `规范序列化后不得超过 ${COMMON_OPERATION_MAX_BATCH_BYTES} bytes`);
  }
  return normalized;
}

function serializeCommonOperationBatch(raw) {
  return stableJson(normalizeCommonOperationBatch(raw));
}

function digestCommonOperationBatch(raw) {
  return crypto.createHash('sha256').update(serializeCommonOperationBatch(raw), 'utf8').digest('hex');
}

function sameHeader(left, right) {
  return left.contractVersion === right.contractVersion
    && left.projectId === right.projectId
    && left.canvasId === right.canvasId
    && left.baseRevision === right.baseRevision
    && left.batchId === right.batchId
    && left.clientId === right.clientId
    && left.clientSeq === right.clientSeq;
}

function classifyCommonOperationBatchRetry(originalRaw, candidateRaw) {
  const original = normalizeCommonOperationBatch(originalRaw);
  const candidate = normalizeCommonOperationBatch(candidateRaw);
  const sameBatchId = original.batchId === candidate.batchId;
  const sameClientSequence = original.clientId === candidate.clientId && original.clientSeq === candidate.clientSeq;
  if (!sameBatchId && !sameClientSequence) return 'distinct';
  if (original.projectId !== candidate.projectId || original.canvasId !== candidate.canvasId) return 'scope-collision';
  if (!sameBatchId || !sameClientSequence) return 'identity-collision';
  if (original.baseRevision !== candidate.baseRevision) return 'base-revision-collision';
  if (stableJson(original) === stableJson(candidate)) return 'exact';
  if (!sameHeader(original, candidate)) return 'identity-collision';

  const originalById = new Map(original.operations.map((operation) => [operation.opId, stableJson(operation)]));
  const candidateById = new Map(candidate.operations.map((operation) => [operation.opId, stableJson(operation)]));
  const sharedExact = [...candidateById.entries()].every(([opId, serialized]) => (
    !originalById.has(opId) || originalById.get(opId) === serialized
  ));
  const candidateSubset = candidate.operations.length < original.operations.length
    && [...candidateById.entries()].every(([opId, serialized]) => originalById.get(opId) === serialized);
  if (candidateSubset) return 'subset';
  const candidateSuperset = candidate.operations.length > original.operations.length
    && [...originalById.entries()].every(([opId, serialized]) => candidateById.get(opId) === serialized);
  if (candidateSuperset) return 'superset';
  const sameExactSet = candidate.operations.length === original.operations.length
    && sharedExact
    && [...originalById.entries()].every(([opId, serialized]) => candidateById.get(opId) === serialized);
  if (sameExactSet) return 'reordered';
  return 'operation-collision';
}

module.exports = {
  COMMON_OPERATION_BATCH_CONTRACT,
  COMMON_OPERATION_MAX_BATCH_BYTES,
  COMMON_OPERATION_MAX_OPERATIONS,
  COMMON_OPERATION_CONTRACTS,
  COMMON_OPERATION_TYPES,
  CommonOperationProtocolError,
  classifyCommonOperationBatchRetry,
  digestCommonOperationBatch,
  isCommonOperationUuid: (value) => typeof value === 'string' && UUID_PATTERN.test(value),
  normalizeCommonOperationBatch,
  serializeCommonOperationBatch,
};
