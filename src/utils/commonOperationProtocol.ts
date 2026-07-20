export const COMMON_OPERATION_BATCH_CONTRACT = 't8-common-operation-batch-v1' as const;
export const COMMON_OPERATION_MAX_OPERATIONS = 500;
export const COMMON_OPERATION_MAX_BATCH_BYTES = 1024 * 1024;

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

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

export const COMMON_OPERATION_TYPES = Object.freeze([
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
] as const);

export type CommonOperationType = typeof COMMON_OPERATION_TYPES[number];
export type CommonOperationRetryClassification =
  | 'exact'
  | 'distinct'
  | 'scope-collision'
  | 'identity-collision'
  | 'base-revision-collision'
  | 'reordered'
  | 'subset'
  | 'superset'
  | 'operation-collision';

export type CommonJsonValue = null | boolean | number | string | CommonJsonValue[] | CommonJsonObject;
export interface CommonJsonObject { [key: string]: CommonJsonValue }

export interface CommonPosition { x: number; y: number }
export interface CommonViewport extends CommonPosition { zoom: number }

export interface CommonNodeCreatePayload {
  nodeUid: string;
  displayId: string;
  nodeType: string;
  position: CommonPosition;
  data: CommonJsonObject;
  expectedAbsent: true;
}

export interface CommonNodeRestorePayload extends Omit<CommonNodeCreatePayload, 'expectedAbsent'> {
  expectedTombstoneRevision: number;
}

export interface CommonNodePatchPayload {
  nodeUid: string;
  expectedEntityRevision: number;
  fields: CommonJsonObject;
  unsetFields: string[];
}

export interface CommonNodeMovePayload {
  nodeUid: string;
  expectedEntityRevision: number;
  position: CommonPosition;
}

export interface CommonNodeDeletePayload {
  nodeUid: string;
  expectedEntityRevision: number;
}

export interface CommonEdgeCreatePayload {
  edgeUid: string;
  displayId: string;
  sourceNodeUid: string;
  targetNodeUid: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  edgeType: string;
  data: CommonJsonObject;
  expectedAbsent: true;
}

export interface CommonEdgeRestorePayload extends Omit<CommonEdgeCreatePayload, 'expectedAbsent'> {
  expectedTombstoneRevision: number;
}

export interface CommonEdgeDeletePayload {
  edgeUid: string;
  expectedEntityRevision: number;
}

export interface CommonViewportSetPayload {
  expectedViewportRevision: number;
  viewport: CommonViewport;
}

export type CommonReviewAnchor =
  | { kind: 'canvas'; x: number; y: number }
  | { kind: 'node' | 'edge' | 'asset'; targetUid: string }
  | { kind: 'video'; targetUid: string; frameMs: number; assetRevision: number }
  | {
    kind: 'video';
    targetUid: string;
    frameMs: number;
    assetContentRevision: number;
    contentHash: string;
  };

export interface CommonReviewAttachment {
  assetUid: string;
  assetContentRevision: number;
  contentHash: string;
}

export interface CommonReviewCommentReferences {
  mentions?: string[];
  attachments?: CommonReviewAttachment[];
}

export interface CommonReviewThreadCreatePayload {
  threadUid: string;
  expectedCanvasRevision: number;
  anchor: CommonReviewAnchor;
  severity: 'low' | 'normal' | 'high' | 'blocking';
  reviewStatus?: 'draft';
  initialComment: { commentUid: string; body: string } & CommonReviewCommentReferences;
}

export interface CommonReviewCommentAddPayload extends CommonReviewCommentReferences {
  threadUid: string;
  commentUid: string;
  parentCommentUid: string | null;
  expectedCanvasRevision: number;
  expectedThreadRevision: number;
  body: string;
}

interface CommonReviewThreadUpdateBasePayload {
  threadUid: string;
  expectedCanvasRevision: number;
  expectedThreadRevision: number;
  severity: 'low' | 'normal' | 'high' | 'blocking';
}

export type CommonReviewThreadUpdatePayload = CommonReviewThreadUpdateBasePayload & (
  | {
    status: 'open' | 'resolved' | 'approved' | 'changes_requested';
    decisionCanvasRevision: number | null;
  }
  | { resolutionStatus: 'open' | 'resolved' }
  | {
    reviewStatus: 'draft' | 'in_review' | 'approved' | 'changes_requested';
    decisionCanvasRevision: number | null;
  }
);

export interface CommonSubflowInstanceUpgradePayload {
  instanceUid: string;
  definitionUid: string;
  expectedCanvasRevision: number;
  expectedInstanceRevision: number;
  expectedDefinitionVersion: number;
  expectedDefinitionRevision: number;
  targetDefinitionVersion: number;
  targetDefinitionRevision: number;
  upgradePlanDigest: string;
}

export interface CommonHostArtifactCommitPayload {
  artifactUid: string;
  blobUid: string;
  runUid: string;
  nodeRunUid: string;
  attemptUid: string;
  nodeUid: string;
  expectedCanvasRevision: number;
  expectedRunRevision: number;
  expectedNodeRunRevision: number;
  expectedAttemptRevision: number;
  outputOrdinal: number;
  kind: 'image' | 'video' | 'audio' | 'model3d' | 'text' | 'other';
  contentHash: string;
  byteSize: number;
  filename: string;
  mimeType: string;
}

export interface CommonOperationPayloadByType {
  'node.add': CommonNodeCreatePayload;
  'node.patch': CommonNodePatchPayload;
  'node.move': CommonNodeMovePayload;
  'node.delete': CommonNodeDeletePayload;
  'node.restore': CommonNodeRestorePayload;
  'edge.add': CommonEdgeCreatePayload;
  'edge.delete': CommonEdgeDeletePayload;
  'edge.restore': CommonEdgeRestorePayload;
  'viewport.set': CommonViewportSetPayload;
  'review.thread.create': CommonReviewThreadCreatePayload;
  'review.comment.add': CommonReviewCommentAddPayload;
  'review.thread.update': CommonReviewThreadUpdatePayload;
  'subflow.instance.upgrade': CommonSubflowInstanceUpgradePayload;
  'host.artifact.commit': CommonHostArtifactCommitPayload;
}

export type CommonOperation = {
  [Type in CommonOperationType]: {
    opId: string;
    type: Type;
    payload: CommonOperationPayloadByType[Type];
  }
}[CommonOperationType];

export interface CommonOperationBatch {
  contractVersion: typeof COMMON_OPERATION_BATCH_CONTRACT;
  projectId: string;
  canvasId: string;
  baseRevision: number;
  batchId: string;
  clientId: string;
  clientSeq: number;
  operations: CommonOperation[];
}

export const COMMON_OPERATION_CONTRACTS = deepFreeze({
  'node.add': { domain: 'graph', identityFields: ['nodeUid'], casFields: ['expectedAbsent'], revisionScope: 'canvas-base' },
  'node.patch': { domain: 'graph', identityFields: ['nodeUid'], casFields: ['expectedEntityRevision'], revisionScope: 'canvas-base' },
  'node.move': { domain: 'graph', identityFields: ['nodeUid'], casFields: ['expectedEntityRevision'], revisionScope: 'canvas-base' },
  'node.delete': { domain: 'graph', identityFields: ['nodeUid'], casFields: ['expectedEntityRevision'], revisionScope: 'canvas-base' },
  'node.restore': { domain: 'graph', identityFields: ['nodeUid'], casFields: ['expectedTombstoneRevision'], revisionScope: 'canvas-base' },
  'edge.add': { domain: 'graph', identityFields: ['edgeUid', 'sourceNodeUid', 'targetNodeUid'], casFields: ['expectedAbsent'], revisionScope: 'canvas-base' },
  'edge.delete': { domain: 'graph', identityFields: ['edgeUid'], casFields: ['expectedEntityRevision'], revisionScope: 'canvas-base' },
  'edge.restore': { domain: 'graph', identityFields: ['edgeUid', 'sourceNodeUid', 'targetNodeUid'], casFields: ['expectedTombstoneRevision'], revisionScope: 'canvas-base' },
  'viewport.set': { domain: 'graph', identityFields: [], casFields: ['expectedViewportRevision'], revisionScope: 'canvas-base' },
  'review.thread.create': { domain: 'review', identityFields: ['threadUid', 'initialComment.commentUid'], casFields: ['expectedCanvasRevision'], revisionScope: 'canvas-base' },
  'review.comment.add': { domain: 'review', identityFields: ['threadUid', 'commentUid', 'parentCommentUid'], casFields: ['expectedCanvasRevision', 'expectedThreadRevision'], revisionScope: 'canvas-and-thread' },
  'review.thread.update': { domain: 'review', identityFields: ['threadUid'], casFields: ['expectedCanvasRevision', 'expectedThreadRevision', 'decisionCanvasRevision'], revisionScope: 'canvas-and-thread' },
  'subflow.instance.upgrade': { domain: 'subflow', identityFields: ['instanceUid', 'definitionUid'], casFields: ['expectedCanvasRevision', 'expectedInstanceRevision', 'expectedDefinitionVersion', 'expectedDefinitionRevision', 'targetDefinitionVersion', 'targetDefinitionRevision', 'upgradePlanDigest'], revisionScope: 'canvas-instance-definition' },
  'host.artifact.commit': { domain: 'host-artifact', identityFields: ['artifactUid', 'blobUid', 'runUid', 'nodeRunUid', 'attemptUid', 'nodeUid'], casFields: ['expectedCanvasRevision', 'expectedRunRevision', 'expectedNodeRunRevision', 'expectedAttemptRevision'], revisionScope: 'canvas-run-attempt' },
} as const);

export class CommonOperationProtocolError extends Error {
  code: string;
  path: string;
  status: number;

  constructor(code: string, message: string, path = '') {
    super(message);
    this.name = 'CommonOperationProtocolError';
    this.code = code;
    this.path = path;
    this.status = 400;
  }
}

function fail(code: string, path: string, message: string): never {
  throw new CommonOperationProtocolError(code, `${path}: ${message}`, path);
}

function ownDataKeys(value: unknown, path: string): string[] {
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
  return keys as string[];
}

function assertPlainArray(value: unknown, path: string, maximum = 10_000): asserts value is unknown[] {
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
}

function exactRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys,
): Record<string, unknown> {
  const keys = ownDataKeys(value, path);
  const allowed = new Set(allowedKeys);
  for (const key of keys) {
    if (!allowed.has(key)) fail('common_operation_extra_field', `${path}.${key}`, '字段不在协议中');
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail('common_operation_missing_field', `${path}.${key}`, '缺少必填字段');
    }
  }
  return value as Record<string, unknown>;
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function boundedString(
  value: unknown,
  path: string,
  maximum: number,
  options: { minimum?: number; trimmed?: boolean; allowNewlines?: boolean; pattern?: RegExp } = {},
) {
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

function canonicalUuid(value: unknown, path: string) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('common_operation_uuid_invalid', path, '必须是 RFC 4122 UUID');
  }
  return value.toLowerCase();
}

function nullableUuid(value: unknown, path: string) {
  return value === null ? null : canonicalUuid(value, path);
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail('common_operation_integer_invalid', path, `必须是 ${minimum}-${maximum} 的安全整数`);
  }
  return value as number;
}

function boundedNumber(value: unknown, path: string, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail('common_operation_number_invalid', path, `必须是 ${minimum}-${maximum} 的有限数值`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function literalTrue(value: unknown, path: string): true {
  if (value !== true) fail('common_operation_cas_invalid', path, '必须明确为 true');
  return true;
}

function enumValue<const Values extends readonly string[]>(value: unknown, path: string, allowed: Values): Values[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail('common_operation_enum_invalid', path, `必须是 ${allowed.join('/')}`);
  }
  return value as Values[number];
}

function digestValue(value: unknown, path: string) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail('common_operation_digest_invalid', path, '必须是 64 位 SHA-256 十六进制摘要');
  }
  return value.toLowerCase();
}

function cloneSafeJson(
  value: unknown,
  path: string,
  budget: { nodes: number } = { nodes: 0 },
  depth = 0,
): CommonJsonValue {
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
  const input = value as Record<string, unknown>;
  const output: CommonJsonObject = {};
  for (const key of keys) {
    boundedString(key, `${path}.[key]`, 240);
    output[key] = cloneSafeJson(input[key], `${path}.${key}`, budget, depth + 1);
  }
  return output;
}

function safeJsonObject(value: unknown, path: string): CommonJsonObject {
  const cloned = cloneSafeJson(value, path);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    fail('common_operation_json_invalid', path, '必须是 JSON 对象');
  }
  return cloned;
}

function normalizePosition(value: unknown, path: string): CommonPosition {
  const record = exactRecord(value, path, ['x', 'y']);
  return {
    x: boundedNumber(record.x, `${path}.x`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
    y: boundedNumber(record.y, `${path}.y`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
  };
}

function normalizeViewport(value: unknown, path: string): CommonViewport {
  const record = exactRecord(value, path, ['x', 'y', 'zoom']);
  return {
    x: boundedNumber(record.x, `${path}.x`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
    y: boundedNumber(record.y, `${path}.y`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
    zoom: boundedNumber(record.zoom, `${path}.zoom`, 0.01, MAX_CANVAS_ZOOM),
  };
}

function revisionAtOrBefore(value: unknown, path: string, baseRevision: number) {
  const revision = boundedInteger(value, path, 1);
  if (revision > baseRevision) fail('common_operation_cas_invalid', path, '不能超过批次 baseRevision');
  return revision;
}

function exactCanvasRevision(value: unknown, path: string, baseRevision: number) {
  const revision = boundedInteger(value, path, 1);
  if (revision !== baseRevision) fail('common_operation_cas_invalid', path, '必须精确等于批次 baseRevision');
  return revision;
}

function nullableHandle(value: unknown, path: string) {
  return value === null ? null : boundedString(value, path, 160);
}

function normalizePatchFields(value: unknown, path: string) {
  const result = safeJsonObject(value, path);
  const protectedFields = new Set(['id', 'displayId', 'type', 'nodeType', 'nodeUid', 'entityUid', 'entityRevision']);
  const keys = Object.keys(result);
  if (keys.length > 500) fail('common_operation_limit_exceeded', path, '修改字段超过 500');
  for (const key of keys) {
    if (protectedFields.has(key)) fail('common_operation_payload_invalid', `${path}.${key}`, '身份字段不可修改');
  }
  return result;
}

function normalizeUnsetFields(value: unknown, path: string) {
  assertPlainArray(value, path, 500);
  const protectedFields = new Set(['id', 'displayId', 'type', 'nodeType', 'nodeUid', 'entityUid', 'entityRevision']);
  const result = value.map((item, index) => boundedString(item, `${path}[${index}]`, 160));
  if (new Set(result).size !== result.length) fail('common_operation_payload_invalid', path, '字段不得重复');
  if (result.some((key) => protectedFields.has(key))) fail('common_operation_payload_invalid', path, '身份字段不可删除');
  return result;
}

function graphNodeCreatePayload(
  value: unknown,
  path: string,
  baseRevision: number,
  restoring: boolean,
): CommonNodeCreatePayload | CommonNodeRestorePayload {
  const common = ['nodeUid', 'displayId', 'nodeType', 'position', 'data'];
  const casField = restoring ? 'expectedTombstoneRevision' : 'expectedAbsent';
  const record = exactRecord(value, path, [...common, casField]);
  const output = {
    nodeUid: canonicalUuid(record.nodeUid, `${path}.nodeUid`),
    displayId: boundedString(record.displayId, `${path}.displayId`, 240),
    nodeType: boundedString(record.nodeType, `${path}.nodeType`, 160),
    position: normalizePosition(record.position, `${path}.position`),
    data: safeJsonObject(record.data, `${path}.data`),
  };
  return restoring
    ? { ...output, expectedTombstoneRevision: revisionAtOrBefore(record.expectedTombstoneRevision, `${path}.expectedTombstoneRevision`, baseRevision) }
    : { ...output, expectedAbsent: literalTrue(record.expectedAbsent, `${path}.expectedAbsent`) };
}

function graphEdgeCreatePayload(
  value: unknown,
  path: string,
  baseRevision: number,
  restoring: boolean,
): CommonEdgeCreatePayload | CommonEdgeRestorePayload {
  const common = ['edgeUid', 'displayId', 'sourceNodeUid', 'targetNodeUid', 'sourceHandle', 'targetHandle', 'edgeType', 'data'];
  const casField = restoring ? 'expectedTombstoneRevision' : 'expectedAbsent';
  const record = exactRecord(value, path, [...common, casField]);
  const output = {
    edgeUid: canonicalUuid(record.edgeUid, `${path}.edgeUid`),
    displayId: boundedString(record.displayId, `${path}.displayId`, 240),
    sourceNodeUid: canonicalUuid(record.sourceNodeUid, `${path}.sourceNodeUid`),
    targetNodeUid: canonicalUuid(record.targetNodeUid, `${path}.targetNodeUid`),
    sourceHandle: nullableHandle(record.sourceHandle, `${path}.sourceHandle`),
    targetHandle: nullableHandle(record.targetHandle, `${path}.targetHandle`),
    edgeType: boundedString(record.edgeType, `${path}.edgeType`, 160),
    data: safeJsonObject(record.data, `${path}.data`),
  };
  return restoring
    ? { ...output, expectedTombstoneRevision: revisionAtOrBefore(record.expectedTombstoneRevision, `${path}.expectedTombstoneRevision`, baseRevision) }
    : { ...output, expectedAbsent: literalTrue(record.expectedAbsent, `${path}.expectedAbsent`) };
}

function reviewBody(value: unknown, path: string) {
  return boundedString(value, path, 5000, { trimmed: true, allowNewlines: true });
}

function normalizeReviewMentions(value: unknown, path: string) {
  assertPlainArray(value, path, MAX_REVIEW_MENTIONS);
  const normalized = value.map((item, index) => canonicalUuid(item, `${path}[${index}]`));
  return [...new Set(normalized)];
}

function normalizeReviewAttachments(value: unknown, path: string): CommonReviewAttachment[] {
  assertPlainArray(value, path, MAX_REVIEW_ATTACHMENTS);
  const normalized = value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = exactRecord(item, itemPath, ['assetUid', 'assetContentRevision', 'contentHash']);
    return {
      assetUid: canonicalUuid(record.assetUid, `${itemPath}.assetUid`),
      assetContentRevision: boundedInteger(record.assetContentRevision, `${itemPath}.assetContentRevision`, 1),
      contentHash: boundedString(record.contentHash, `${itemPath}.contentHash`, 64, {
        pattern: /^[a-f0-9]{64}$/,
      }),
    };
  });
  const assetUids = normalized.map((item) => item.assetUid);
  if (new Set(assetUids).size !== assetUids.length) {
    fail('common_operation_payload_invalid', path, '同一评论的附件 assetUid 不得重复');
  }
  return normalized;
}

function addOptionalReviewReferences<T extends Record<string, unknown>>(
  input: Record<string, unknown>,
  path: string,
  output: T,
): T & CommonReviewCommentReferences {
  const references = output as T & CommonReviewCommentReferences;
  if (hasOwn(input, 'mentions')) references.mentions = normalizeReviewMentions(input.mentions, `${path}.mentions`);
  if (hasOwn(input, 'attachments')) {
    references.attachments = normalizeReviewAttachments(input.attachments, `${path}.attachments`);
  }
  return references;
}

function normalizeReviewAnchor(value: unknown, path: string): CommonReviewAnchor {
  const initial = exactRecord(
    value,
    path,
    ['kind', 'x', 'y', 'targetUid', 'frameMs', 'assetRevision', 'assetContentRevision', 'contentHash'],
    ['kind'],
  );
  const kind = enumValue(initial.kind, `${path}.kind`, ['canvas', 'node', 'edge', 'asset', 'video'] as const);
  if (kind === 'canvas') {
    const record = exactRecord(value, path, ['kind', 'x', 'y']);
    return {
      kind,
      x: boundedNumber(record.x, `${path}.x`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
      y: boundedNumber(record.y, `${path}.y`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
    };
  }
  if (kind === 'video') {
    if (hasOwn(initial, 'assetContentRevision') || hasOwn(initial, 'contentHash')) {
      const record = exactRecord(value, path, [
        'kind', 'targetUid', 'frameMs', 'assetContentRevision', 'contentHash',
      ]);
      return {
        kind,
        targetUid: canonicalUuid(record.targetUid, `${path}.targetUid`),
        frameMs: boundedInteger(record.frameMs, `${path}.frameMs`, 0, 7 * 24 * 60 * 60 * 1000),
        assetContentRevision: boundedInteger(record.assetContentRevision, `${path}.assetContentRevision`, 1),
        contentHash: boundedString(record.contentHash, `${path}.contentHash`, 64, {
          pattern: /^[a-f0-9]{64}$/,
        }),
      };
    }
    // Frozen v1 compatibility only; never reinterpret assetRevision as the
    // independent asset content revision used by new review pins.
    const record = exactRecord(value, path, ['kind', 'targetUid', 'frameMs', 'assetRevision']);
    return {
      kind,
      targetUid: canonicalUuid(record.targetUid, `${path}.targetUid`),
      frameMs: boundedInteger(record.frameMs, `${path}.frameMs`, 0, 7 * 24 * 60 * 60 * 1000),
      assetRevision: boundedInteger(record.assetRevision, `${path}.assetRevision`, 1),
    };
  }
  const record = exactRecord(value, path, ['kind', 'targetUid']);
  return { kind, targetUid: canonicalUuid(record.targetUid, `${path}.targetUid`) };
}

function normalizePayload(
  type: CommonOperationType,
  value: unknown,
  baseRevision: number,
  path: string,
): CommonOperationPayloadByType[CommonOperationType] {
  if (type === 'node.add') {
    return graphNodeCreatePayload(value, path, baseRevision, false) as CommonNodeCreatePayload;
  }
  if (type === 'node.restore') {
    return graphNodeCreatePayload(value, path, baseRevision, true) as CommonNodeRestorePayload;
  }
  if (type === 'node.patch') {
    const record = exactRecord(value, path, ['nodeUid', 'expectedEntityRevision', 'fields', 'unsetFields']);
    const fields = normalizePatchFields(record.fields, `${path}.fields`);
    const unset = normalizeUnsetFields(record.unsetFields, `${path}.unsetFields`);
    if (Object.keys(fields).length === 0 && unset.length === 0) {
      fail('common_operation_payload_invalid', path, '修改不得为空');
    }
    if (unset.some((key) => Object.prototype.hasOwnProperty.call(fields, key))) {
      fail('common_operation_payload_invalid', path, '同一字段不能同时设置和删除');
    }
    return {
      nodeUid: canonicalUuid(record.nodeUid, `${path}.nodeUid`),
      expectedEntityRevision: revisionAtOrBefore(record.expectedEntityRevision, `${path}.expectedEntityRevision`, baseRevision),
      fields,
      unsetFields: unset,
    };
  }
  if (type === 'node.move') {
    const record = exactRecord(value, path, ['nodeUid', 'expectedEntityRevision', 'position']);
    return {
      nodeUid: canonicalUuid(record.nodeUid, `${path}.nodeUid`),
      expectedEntityRevision: revisionAtOrBefore(record.expectedEntityRevision, `${path}.expectedEntityRevision`, baseRevision),
      position: normalizePosition(record.position, `${path}.position`),
    };
  }
  if (type === 'node.delete') {
    const record = exactRecord(value, path, ['nodeUid', 'expectedEntityRevision']);
    return {
      nodeUid: canonicalUuid(record.nodeUid, `${path}.nodeUid`),
      expectedEntityRevision: revisionAtOrBefore(record.expectedEntityRevision, `${path}.expectedEntityRevision`, baseRevision),
    };
  }
  if (type === 'edge.add') {
    return graphEdgeCreatePayload(value, path, baseRevision, false) as CommonEdgeCreatePayload;
  }
  if (type === 'edge.restore') {
    return graphEdgeCreatePayload(value, path, baseRevision, true) as CommonEdgeRestorePayload;
  }
  if (type === 'edge.delete') {
    const record = exactRecord(value, path, ['edgeUid', 'expectedEntityRevision']);
    return {
      edgeUid: canonicalUuid(record.edgeUid, `${path}.edgeUid`),
      expectedEntityRevision: revisionAtOrBefore(record.expectedEntityRevision, `${path}.expectedEntityRevision`, baseRevision),
    };
  }
  if (type === 'viewport.set') {
    const record = exactRecord(value, path, ['expectedViewportRevision', 'viewport']);
    return {
      expectedViewportRevision: revisionAtOrBefore(record.expectedViewportRevision, `${path}.expectedViewportRevision`, baseRevision),
      viewport: normalizeViewport(record.viewport, `${path}.viewport`),
    };
  }
  if (type === 'review.thread.create') {
    const record = exactRecord(
      value,
      path,
      ['threadUid', 'expectedCanvasRevision', 'anchor', 'severity', 'initialComment', 'reviewStatus'],
      ['threadUid', 'expectedCanvasRevision', 'anchor', 'severity', 'initialComment'],
    );
    const initialComment = exactRecord(
      record.initialComment,
      `${path}.initialComment`,
      ['commentUid', 'body', 'mentions', 'attachments'],
      ['commentUid', 'body'],
    );
    const normalizedInitialComment = addOptionalReviewReferences(
      initialComment,
      `${path}.initialComment`,
      {
        commentUid: canonicalUuid(initialComment.commentUid, `${path}.initialComment.commentUid`),
        body: reviewBody(initialComment.body, `${path}.initialComment.body`),
      },
    );
    return {
      threadUid: canonicalUuid(record.threadUid, `${path}.threadUid`),
      expectedCanvasRevision: exactCanvasRevision(record.expectedCanvasRevision, `${path}.expectedCanvasRevision`, baseRevision),
      anchor: normalizeReviewAnchor(record.anchor, `${path}.anchor`),
      severity: enumValue(record.severity, `${path}.severity`, ['low', 'normal', 'high', 'blocking'] as const),
      ...(hasOwn(record, 'reviewStatus')
        ? { reviewStatus: enumValue(record.reviewStatus, `${path}.reviewStatus`, ['draft'] as const) }
        : {}),
      initialComment: normalizedInitialComment,
    };
  }
  if (type === 'review.comment.add') {
    const record = exactRecord(value, path, [
      'threadUid', 'commentUid', 'parentCommentUid', 'expectedCanvasRevision', 'expectedThreadRevision',
      'body', 'mentions', 'attachments',
    ], [
      'threadUid', 'commentUid', 'parentCommentUid', 'expectedCanvasRevision', 'expectedThreadRevision', 'body',
    ]);
    return addOptionalReviewReferences(record, path, {
      threadUid: canonicalUuid(record.threadUid, `${path}.threadUid`),
      commentUid: canonicalUuid(record.commentUid, `${path}.commentUid`),
      parentCommentUid: nullableUuid(record.parentCommentUid, `${path}.parentCommentUid`),
      expectedCanvasRevision: exactCanvasRevision(record.expectedCanvasRevision, `${path}.expectedCanvasRevision`, baseRevision),
      expectedThreadRevision: boundedInteger(record.expectedThreadRevision, `${path}.expectedThreadRevision`, 1),
      body: reviewBody(record.body, `${path}.body`),
    });
  }
  if (type === 'review.thread.update') {
    const commonKeys = ['threadUid', 'expectedCanvasRevision', 'expectedThreadRevision', 'severity'] as const;
    if (hasOwn(value as object, 'status')) {
      const record = exactRecord(value, path, [...commonKeys, 'status', 'decisionCanvasRevision']);
      const status = enumValue(record.status, `${path}.status`, ['open', 'resolved', 'approved', 'changes_requested'] as const);
      const decisionCanvasRevision = record.decisionCanvasRevision === null
        ? null
        : exactCanvasRevision(record.decisionCanvasRevision, `${path}.decisionCanvasRevision`, baseRevision);
      if (['approved', 'changes_requested'].includes(status) ? decisionCanvasRevision == null : decisionCanvasRevision != null) {
        fail(
          'common_operation_cas_invalid',
          `${path}.decisionCanvasRevision`,
          '审批状态必须绑定当前 canvas revision，非审批状态必须为 null',
        );
      }
      return {
        threadUid: canonicalUuid(record.threadUid, `${path}.threadUid`),
        expectedCanvasRevision: exactCanvasRevision(record.expectedCanvasRevision, `${path}.expectedCanvasRevision`, baseRevision),
        expectedThreadRevision: boundedInteger(record.expectedThreadRevision, `${path}.expectedThreadRevision`, 1),
        status,
        severity: enumValue(record.severity, `${path}.severity`, ['low', 'normal', 'high', 'blocking'] as const),
        decisionCanvasRevision,
      };
    }
    const record = exactRecord(
      value,
      path,
      [...commonKeys, 'resolutionStatus', 'reviewStatus', 'decisionCanvasRevision'],
      commonKeys,
    );
    const hasResolutionStatus = hasOwn(record, 'resolutionStatus');
    const hasReviewStatus = hasOwn(record, 'reviewStatus');
    if (hasResolutionStatus === hasReviewStatus) {
      fail('common_operation_payload_invalid', path, '必须且只能更新 resolutionStatus 或 reviewStatus 之一');
    }
    const normalizedBase = {
      threadUid: canonicalUuid(record.threadUid, `${path}.threadUid`),
      expectedCanvasRevision: exactCanvasRevision(record.expectedCanvasRevision, `${path}.expectedCanvasRevision`, baseRevision),
      expectedThreadRevision: boundedInteger(record.expectedThreadRevision, `${path}.expectedThreadRevision`, 1),
      severity: enumValue(record.severity, `${path}.severity`, ['low', 'normal', 'high', 'blocking'] as const),
    };
    if (hasResolutionStatus) {
      if (hasOwn(record, 'decisionCanvasRevision')) {
        fail('common_operation_payload_invalid', `${path}.decisionCanvasRevision`, '解决状态更新不得覆盖评审决定 revision');
      }
      return {
        ...normalizedBase,
        resolutionStatus: enumValue(record.resolutionStatus, `${path}.resolutionStatus`, ['open', 'resolved'] as const),
      };
    }
    const reviewStatus = enumValue(
      record.reviewStatus,
      `${path}.reviewStatus`,
      ['draft', 'in_review', 'approved', 'changes_requested'] as const,
    );
    if (!hasOwn(record, 'decisionCanvasRevision')) {
      fail('common_operation_missing_field', `${path}.decisionCanvasRevision`, '缺少必填字段');
    }
    const decisionCanvasRevision = record.decisionCanvasRevision === null
      ? null
      : exactCanvasRevision(record.decisionCanvasRevision, `${path}.decisionCanvasRevision`, baseRevision);
    if (['approved', 'changes_requested'].includes(reviewStatus) ? decisionCanvasRevision == null : decisionCanvasRevision != null) {
      fail(
        'common_operation_cas_invalid',
        `${path}.decisionCanvasRevision`,
        '审批状态必须绑定当前 canvas revision，非审批状态必须为 null',
      );
    }
    return {
      ...normalizedBase,
      reviewStatus,
      decisionCanvasRevision,
    };
  }
  if (type === 'subflow.instance.upgrade') {
    const record = exactRecord(value, path, [
      'instanceUid', 'definitionUid', 'expectedCanvasRevision', 'expectedInstanceRevision',
      'expectedDefinitionVersion', 'expectedDefinitionRevision', 'targetDefinitionVersion',
      'targetDefinitionRevision', 'upgradePlanDigest',
    ]);
    const expectedDefinitionVersion = boundedInteger(record.expectedDefinitionVersion, `${path}.expectedDefinitionVersion`, 1);
    const expectedDefinitionRevision = boundedInteger(record.expectedDefinitionRevision, `${path}.expectedDefinitionRevision`, 1);
    const targetDefinitionVersion = boundedInteger(record.targetDefinitionVersion, `${path}.targetDefinitionVersion`, 1);
    const targetDefinitionRevision = boundedInteger(record.targetDefinitionRevision, `${path}.targetDefinitionRevision`, 1);
    if (targetDefinitionVersion < expectedDefinitionVersion
      || (targetDefinitionVersion === expectedDefinitionVersion && targetDefinitionRevision <= expectedDefinitionRevision)) {
      fail('common_operation_cas_invalid', path, '目标定义必须严格晚于当前固定定义');
    }
    return {
      instanceUid: canonicalUuid(record.instanceUid, `${path}.instanceUid`),
      definitionUid: canonicalUuid(record.definitionUid, `${path}.definitionUid`),
      expectedCanvasRevision: exactCanvasRevision(record.expectedCanvasRevision, `${path}.expectedCanvasRevision`, baseRevision),
      expectedInstanceRevision: revisionAtOrBefore(record.expectedInstanceRevision, `${path}.expectedInstanceRevision`, baseRevision),
      expectedDefinitionVersion,
      expectedDefinitionRevision,
      targetDefinitionVersion,
      targetDefinitionRevision,
      upgradePlanDigest: digestValue(record.upgradePlanDigest, `${path}.upgradePlanDigest`),
    };
  }
  const record = exactRecord(value, path, [
    'artifactUid', 'blobUid', 'runUid', 'nodeRunUid', 'attemptUid', 'nodeUid',
    'expectedCanvasRevision', 'expectedRunRevision', 'expectedNodeRunRevision',
    'expectedAttemptRevision', 'outputOrdinal', 'kind', 'contentHash', 'byteSize',
    'filename', 'mimeType',
  ]);
  const filename = boundedString(record.filename, `${path}.filename`, 240, { trimmed: true });
  if (filename === '.' || filename === '..' || /[\\/]/.test(filename)) {
    fail('common_operation_string_invalid', `${path}.filename`, '只能是文件名，不能包含路径');
  }
  return {
    artifactUid: canonicalUuid(record.artifactUid, `${path}.artifactUid`),
    blobUid: canonicalUuid(record.blobUid, `${path}.blobUid`),
    runUid: canonicalUuid(record.runUid, `${path}.runUid`),
    nodeRunUid: canonicalUuid(record.nodeRunUid, `${path}.nodeRunUid`),
    attemptUid: canonicalUuid(record.attemptUid, `${path}.attemptUid`),
    nodeUid: canonicalUuid(record.nodeUid, `${path}.nodeUid`),
    expectedCanvasRevision: exactCanvasRevision(record.expectedCanvasRevision, `${path}.expectedCanvasRevision`, baseRevision),
    expectedRunRevision: boundedInteger(record.expectedRunRevision, `${path}.expectedRunRevision`, 1),
    expectedNodeRunRevision: boundedInteger(record.expectedNodeRunRevision, `${path}.expectedNodeRunRevision`, 1),
    expectedAttemptRevision: boundedInteger(record.expectedAttemptRevision, `${path}.expectedAttemptRevision`, 1),
    outputOrdinal: boundedInteger(record.outputOrdinal, `${path}.outputOrdinal`, 0, 999),
    kind: enumValue(record.kind, `${path}.kind`, ['image', 'video', 'audio', 'model3d', 'text', 'other'] as const),
    contentHash: digestValue(record.contentHash, `${path}.contentHash`),
    byteSize: boundedInteger(record.byteSize, `${path}.byteSize`, 0, 4 * 1024 * 1024 * 1024),
    filename,
    mimeType: boundedString(record.mimeType, `${path}.mimeType`, 160, { pattern: MIME_PATTERN }),
  };
}

function normalizeOperation(raw: unknown, baseRevision: number, index: number): CommonOperation {
  const path = `batch.operations[${index}]`;
  const record = exactRecord(raw, path, ['opId', 'type', 'payload']);
  const type = enumValue(record.type, `${path}.type`, COMMON_OPERATION_TYPES);
  return {
    opId: canonicalUuid(record.opId, `${path}.opId`),
    type,
    payload: normalizePayload(type, record.payload, baseRevision, `${path}.payload`),
  } as CommonOperation;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function normalizeCommonOperationBatch(raw: unknown): CommonOperationBatch {
  const record = exactRecord(raw, 'batch', [
    'contractVersion', 'projectId', 'canvasId', 'baseRevision', 'batchId', 'clientId', 'clientSeq', 'operations',
  ]);
  if (record.contractVersion !== COMMON_OPERATION_BATCH_CONTRACT) {
    fail('common_operation_contract_invalid', 'batch.contractVersion', `必须是 ${COMMON_OPERATION_BATCH_CONTRACT}`);
  }
  const baseRevision = boundedInteger(record.baseRevision, 'batch.baseRevision', 1);
  if (!Array.isArray(record.operations)
    || record.operations.length < 1 || record.operations.length > COMMON_OPERATION_MAX_OPERATIONS) {
    fail(
      'common_operation_limit_exceeded',
      'batch.operations',
      `必须包含 1-${COMMON_OPERATION_MAX_OPERATIONS} 个操作`,
    );
  }
  assertPlainArray(record.operations, 'batch.operations', COMMON_OPERATION_MAX_OPERATIONS);
  const normalized: CommonOperationBatch = {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    // Scope lookup IDs remain compatible with existing persisted projects;
    // operation target identities below are still canonical UUIDs.
    projectId: boundedString(record.projectId, 'batch.projectId', 240, { trimmed: true }),
    canvasId: boundedString(record.canvasId, 'batch.canvasId', 240, { trimmed: true }),
    baseRevision,
    batchId: canonicalUuid(record.batchId, 'batch.batchId'),
    clientId: canonicalUuid(record.clientId, 'batch.clientId'),
    clientSeq: boundedInteger(record.clientSeq, 'batch.clientSeq', 0),
    operations: record.operations.map((operation, index) => normalizeOperation(operation, baseRevision, index)),
  };
  const opIds = normalized.operations.map((operation) => operation.opId);
  if (new Set(opIds).size !== opIds.length) {
    fail('common_operation_duplicate_op', 'batch.operations', 'opId 必须在批次内唯一');
  }
  if (utf8Bytes(stableJson(normalized)) > COMMON_OPERATION_MAX_BATCH_BYTES) {
    fail(
      'common_operation_limit_exceeded',
      'batch',
      `规范序列化后不得超过 ${COMMON_OPERATION_MAX_BATCH_BYTES} bytes`,
    );
  }
  return normalized;
}

export function serializeCommonOperationBatch(raw: unknown) {
  return stableJson(normalizeCommonOperationBatch(raw));
}

function bytesToHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function digestCommonOperationBatch(raw: unknown) {
  const serialized = serializeCommonOperationBatch(raw);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前运行环境不支持 Web Crypto SHA-256');
  return bytesToHex(await subtle.digest('SHA-256', new TextEncoder().encode(serialized)));
}

function sameHeader(left: CommonOperationBatch, right: CommonOperationBatch) {
  return left.contractVersion === right.contractVersion
    && left.projectId === right.projectId
    && left.canvasId === right.canvasId
    && left.baseRevision === right.baseRevision
    && left.batchId === right.batchId
    && left.clientId === right.clientId
    && left.clientSeq === right.clientSeq;
}

export function classifyCommonOperationBatchRetry(
  originalRaw: unknown,
  candidateRaw: unknown,
): CommonOperationRetryClassification {
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

export function isCommonOperationUuid(value: unknown) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
