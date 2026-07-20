import type {
  CanvasOperationType,
  CanvasSyncOperation,
  CanvasSyncSnapshotReason,
  CanvasTombstoneRecord,
  VersionedCanvasData,
} from '../types/project';
import {
  normalizeCommonOperationBatch,
  serializeCommonOperationBatch,
  type CommonOperationBatch,
} from './commonOperationProtocol.ts';

export const COLLABORATION_SYNC_MAX_OPERATIONS = 500;
export const COLLABORATION_SYNC_MAX_OPERATION_BYTES = 1024 * 1024;

const COLLABORATION_OPERATION_TYPES = new Set<CanvasOperationType>([
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

const OPERATION_KEYS = [
  'opId',
  'projectId',
  'canvasId',
  'baseRevision',
  'revision',
  'actorId',
  'clientSeq',
  'type',
  'payload',
  'timestamp',
] as const;

const ACKNOWLEDGEMENT_KEYS = [...OPERATION_KEYS, 'duplicate'] as const;
const MUTATION_IDENTITY_KEYS = ['opId', 'clientSeq', 'type', 'payload', 'timestamp'] as const;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PUBLIC_REDACTION_MARKERS = new Set([
  '[binary]',
  '[cycle]',
  '[local-path]',
  '[redacted]',
  '[redacted-field]',
  '[truncated]',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PUBLIC_JSON_DEPTH = 32;
const MAX_PUBLIC_JSON_NODES = 100_000;

export class CollaborationSyncFallbackError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CollaborationSyncFallbackError';
    this.code = code;
  }
}

export interface CollaborationSyncEnvelopeOperations {
  mode: 'operations';
  canvasId: string;
  afterRevision: number;
  revision: number;
  generation?: string;
  operations: CanvasSyncOperation[];
}

export type CollaborationSnapshotReason = CanvasSyncSnapshotReason;

export interface CollaborationSyncEnvelopeSnapshot {
  mode: 'snapshot';
  canvasId: string;
  afterRevision: number;
  revision: number;
  generation?: string;
  reason: CollaborationSnapshotReason;
  document: VersionedCanvasData;
}

export type CollaborationSyncEnvelope =
  | CollaborationSyncEnvelopeOperations
  | CollaborationSyncEnvelopeSnapshot;

export interface QueuedMoveIdentity {
  operation: {
    opId: string;
    clientSeq: number;
    timestamp: number;
    type: 'node.move';
    payload: {
      nodeId: string;
      position: { x: number; y: number };
    };
  };
  baseRevision: number | null;
}

export interface CollaborationMoveAcknowledgement {
  opId: string;
  projectId: string;
  canvasId: string;
  baseRevision: number;
  revision: number;
  actorId: string;
  clientSeq: number;
  type: 'node.move';
  payload: {
    nodeId: string;
    position: { x: number; y: number };
  };
  timestamp: number;
  duplicate: boolean;
}

export interface CollaborationMutationOperationIdentity {
  opId: string;
  clientSeq: number;
  timestamp: number;
  type: CanvasOperationType;
  payload: Record<string, unknown>;
}

export interface CollaborationMutationBatchIdentity {
  operations: CollaborationMutationOperationIdentity[];
  baseRevision: number | null;
}

export interface CollaborationOperationAcknowledgement {
  opId: string;
  projectId: string;
  canvasId: string;
  baseRevision: number;
  revision: number;
  actorId: string;
  clientSeq: number;
  type: CanvasOperationType;
  payload: Record<string, unknown>;
  timestamp: number;
  duplicate: boolean;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function containsPublicRedactionMarker(value: string) {
  for (const marker of PUBLIC_REDACTION_MARKERS) {
    if (value.includes(marker)) return true;
  }
  return false;
}

function isPrivateSessionKey(value: string) {
  return value.normalize('NFKC').replace(/[^a-z0-9]/gi, '').toLowerCase() === 'sessionid';
}

function safeIdentity(value: unknown) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !containsPublicRedactionMarker(value)
    && !UNSAFE_OBJECT_KEYS.has(value);
}

function safeRevision(value: unknown, minimum = 0) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function validPosition(value: unknown): value is { x: number; y: number } {
  if (!isRecord(value) || !hasOnlyKeys(value, ['x', 'y'])) return false;
  return typeof value.x === 'number'
    && Number.isFinite(value.x)
    && Math.abs(value.x) <= 10_000_000
    && typeof value.y === 'number'
    && Number.isFinite(value.y)
    && Math.abs(value.y) <= 10_000_000;
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function safeEntityType(value: unknown) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 160
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !UNSAFE_OBJECT_KEYS.has(value);
}

function validEntityUid(value: unknown) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validViewport(value: unknown): value is { x: number; y: number; zoom: number } {
  return isRecord(value)
    && hasOnlyKeys(value, ['x', 'y', 'zoom'])
    && typeof value.x === 'number'
    && Number.isFinite(value.x)
    && Math.abs(value.x) <= 10_000_000
    && typeof value.y === 'number'
    && Number.isFinite(value.y)
    && Math.abs(value.y) <= 10_000_000
    && typeof value.zoom === 'number'
    && Number.isFinite(value.zoom)
    && value.zoom >= 0.01
    && value.zoom <= 64;
}

interface PublicJsonBudget {
  nodes: number;
  seen: WeakSet<object>;
}

function assertBoundedPublicJson(
  value: unknown,
  path: string,
  budget: PublicJsonBudget = { nodes: 0, seen: new WeakSet<object>() },
  depth = 0,
) {
  budget.nodes += 1;
  if (budget.nodes > MAX_PUBLIC_JSON_NODES || depth > MAX_PUBLIC_JSON_DEPTH) {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', `${path} 超过安全 JSON 上限`);
  }
  if (value == null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CollaborationSyncFallbackError('operation_payload_invalid', `${path} 包含非有限数字`);
    }
    return;
  }
  if (typeof value === 'string') {
    if (containsPublicRedactionMarker(value)) {
      throw new CollaborationSyncFallbackError('operation_redacted', `${path} 已被公开协议脱敏，必须使用权威快照`);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', `${path} 不是安全 JSON`);
  }
  if (budget.seen.has(value)) {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', `${path} 包含循环引用`);
  }
  budget.seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 10_000) {
      throw new CollaborationSyncFallbackError('operation_payload_invalid', `${path} 数组过大`);
    }
    value.forEach((item, index) => assertBoundedPublicJson(item, `${path}[${index}]`, budget, depth + 1));
  } else {
    const keys = Object.keys(value);
    if (keys.length > 1_000) {
      throw new CollaborationSyncFallbackError('operation_payload_invalid', `${path} 字段过多`);
    }
    for (const key of keys) {
      if (!key
        || key.length > 240
        || /[\u0000-\u001f\u007f]/.test(key)
        || UNSAFE_OBJECT_KEYS.has(key)) {
        throw new CollaborationSyncFallbackError('operation_payload_invalid', `${path} 包含不安全字段`);
      }
      if (isPrivateSessionKey(key)) {
        throw new CollaborationSyncFallbackError('operation_private_field', `${path} 不得包含 sessionId`);
      }
      assertBoundedPublicJson((value as Record<string, unknown>)[key], `${path}.${key}`, budget, depth + 1);
    }
  }
  budget.seen.delete(value);
}

function assertPatchKey(value: unknown, label: string, protectedKeys: ReadonlySet<string> | null = null) {
  if (typeof value !== 'string'
    || !value
    || value.length > 160
    || /[\u0000-\u001f\u007f]/.test(value)
    || UNSAFE_OBJECT_KEYS.has(value)
    || isPrivateSessionKey(value)
    || protectedKeys?.has(value)) {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', `${label} 包含无效字段`);
  }
  return value;
}

function validateUnsetKeys(
  value: unknown,
  label: string,
  protectedKeys: ReadonlySet<string> | null = null,
) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 500) {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', `${label} 必须是最多 500 项的数组`);
  }
  return value.map((item) => assertPatchKey(item, label, protectedKeys));
}

const PROTECTED_NODE_PATCH_KEYS = new Set([
  'id', 'entityUid', 'entityRevision', 'legacyAliases', 'type',
]);

function validateNodeValue(value: unknown, label: string) {
  if (!isRecord(value)) {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', `${label} 必须是对象`);
  }
  assertBoundedPublicJson(value, label);
  if (!safeIdentity(value.id)
    || !validEntityUid(value.entityUid)
    || !safeEntityType(value.type)
    || !validPosition(value.position)
    || (hasOwn(value, 'data') && !isRecord(value.data))) {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', `${label} 缺少完整节点身份或位置`);
  }
  const node = cloneJson(value);
  node.entityUid = String(node.entityUid).toLowerCase();
  return node;
}

function validateEdgeValue(value: unknown, label: string) {
  if (!isRecord(value)) {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', `${label} 必须是对象`);
  }
  assertBoundedPublicJson(value, label);
  if (!safeIdentity(value.id)
    || !validEntityUid(value.entityUid)
    || !safeIdentity(value.source)
    || !safeIdentity(value.target)
    || (hasOwn(value, 'sourceEntityUid') && value.sourceEntityUid != null && !validEntityUid(value.sourceEntityUid))
    || (hasOwn(value, 'targetEntityUid') && value.targetEntityUid != null && !validEntityUid(value.targetEntityUid))
    || (value.type != null && !safeEntityType(value.type))
    || (value.sourceHandle != null && !safeIdentity(value.sourceHandle))
    || (value.targetHandle != null && !safeIdentity(value.targetHandle))
    || (hasOwn(value, 'data') && !isRecord(value.data))) {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', `${label} 缺少完整连线身份或端点`);
  }
  const edge = cloneJson(value);
  edge.entityUid = String(edge.entityUid).toLowerCase();
  if (edge.sourceEntityUid != null) edge.sourceEntityUid = String(edge.sourceEntityUid).toLowerCase();
  if (edge.targetEntityUid != null) edge.targetEntityUid = String(edge.targetEntityUid).toLowerCase();
  return edge;
}

function validatePatchObject(
  value: unknown,
  label: string,
  protectedKeys: ReadonlySet<string> | null = null,
) {
  if (value == null) return null;
  if (!isRecord(value)) {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', `${label} 必须是对象`);
  }
  for (const key of Object.keys(value)) assertPatchKey(key, label, protectedKeys);
  assertBoundedPublicJson(value, label);
  return cloneJson(value);
}

function validateOperationPayload(type: CanvasOperationType, rawPayload: unknown) {
  if (!isRecord(rawPayload)) {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', `${type}.payload 必须是对象`);
  }
  if (type === 'node.move') {
    if (!hasOnlyKeys(rawPayload, ['nodeId', 'position'])
      || !hasOwn(rawPayload, 'nodeId')
      || !hasOwn(rawPayload, 'position')
      || !safeIdentity(rawPayload.nodeId)
      || !validPosition(rawPayload.position)) {
      throw new CollaborationSyncFallbackError('operation_identity_invalid', '增量同步移动 payload 无效');
    }
    assertBoundedPublicJson(rawPayload, `${type}.payload`);
    return cloneJson(rawPayload);
  }
  assertBoundedPublicJson(rawPayload, `${type}.payload`);
  if (type === 'node.add' || type === 'node.restore') {
    if (!hasOnlyKeys(rawPayload, ['node']) || !hasOwn(rawPayload, 'node')) {
      throw new CollaborationSyncFallbackError('operation_payload_invalid', `${type}.payload 字段不完整`);
    }
    return { node: validateNodeValue(rawPayload.node, `${type}.node`) };
  }
  if (type === 'node.patch') {
    if (!hasOnlyKeys(rawPayload, ['nodeId', 'patch', 'dataPatch', 'unsetKeys', 'dataUnsetKeys'])
      || !hasOwn(rawPayload, 'nodeId')
      || !safeIdentity(rawPayload.nodeId)) {
      throw new CollaborationSyncFallbackError('operation_payload_invalid', 'node.patch.payload 字段不完整');
    }
    const patch = validatePatchObject(rawPayload.patch, 'node.patch.patch', PROTECTED_NODE_PATCH_KEYS);
    if (patch && hasOwn(patch, 'position') && !validPosition(patch.position)) {
      throw new CollaborationSyncFallbackError('operation_payload_invalid', 'node.patch.patch.position 无效');
    }
    if (patch && hasOwn(patch, 'data') && !isRecord(patch.data)) {
      throw new CollaborationSyncFallbackError('operation_payload_invalid', 'node.patch.patch.data 必须是对象');
    }
    const dataPatch = validatePatchObject(rawPayload.dataPatch, 'node.patch.dataPatch');
    const payload: Record<string, unknown> = { nodeId: rawPayload.nodeId };
    if (hasOwn(rawPayload, 'patch')) payload.patch = patch;
    if (hasOwn(rawPayload, 'dataPatch')) payload.dataPatch = dataPatch;
    if (hasOwn(rawPayload, 'unsetKeys')) {
      payload.unsetKeys = validateUnsetKeys(rawPayload.unsetKeys, 'node.patch.unsetKeys', PROTECTED_NODE_PATCH_KEYS);
    }
    if (hasOwn(rawPayload, 'dataUnsetKeys')) {
      payload.dataUnsetKeys = validateUnsetKeys(rawPayload.dataUnsetKeys, 'node.patch.dataUnsetKeys');
    }
    return payload;
  }
  if (type === 'node.delete') {
    if (!hasOnlyKeys(rawPayload, ['nodeId']) || !hasOwn(rawPayload, 'nodeId') || !safeIdentity(rawPayload.nodeId)) {
      throw new CollaborationSyncFallbackError('operation_payload_invalid', 'node.delete.payload 字段不完整');
    }
    return cloneJson(rawPayload);
  }
  if (type === 'edge.add' || type === 'edge.restore') {
    if (!hasOnlyKeys(rawPayload, ['edge']) || !hasOwn(rawPayload, 'edge')) {
      throw new CollaborationSyncFallbackError('operation_payload_invalid', `${type}.payload 字段不完整`);
    }
    return { edge: validateEdgeValue(rawPayload.edge, `${type}.edge`) };
  }
  if (type === 'edge.delete') {
    if (!hasOnlyKeys(rawPayload, ['edgeId']) || !hasOwn(rawPayload, 'edgeId') || !safeIdentity(rawPayload.edgeId)) {
      throw new CollaborationSyncFallbackError('operation_payload_invalid', 'edge.delete.payload 字段不完整');
    }
    return cloneJson(rawPayload);
  }
  if (!hasOnlyKeys(rawPayload, ['viewport'])
    || !hasOwn(rawPayload, 'viewport')
    || !validViewport(rawPayload.viewport)) {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', 'viewport.set.payload 字段不完整');
  }
  return cloneJson(rawPayload);
}

function validateMutationNodeValue(value: unknown, label: string) {
  if (!isRecord(value)) {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', `${label} 必须是对象`);
  }
  assertBoundedPublicJson(value, label);
  if (!safeIdentity(value.id)
    || !safeEntityType(value.type)
    || !validPosition(value.position)
    || (hasOwn(value, 'entityUid') && value.entityUid != null && !validEntityUid(value.entityUid))
    || (hasOwn(value, 'data') && !isRecord(value.data))) {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', `${label} 缺少安全节点身份、类型或位置`);
  }
  const node = cloneJson(value);
  if (node.entityUid != null) node.entityUid = String(node.entityUid).toLowerCase();
  return node;
}

function validateMutationEdgeValue(value: unknown, label: string) {
  if (!isRecord(value)) {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', `${label} 必须是对象`);
  }
  assertBoundedPublicJson(value, label);
  if (!safeIdentity(value.id)
    || !safeIdentity(value.source)
    || !safeIdentity(value.target)
    || (hasOwn(value, 'entityUid') && value.entityUid != null && !validEntityUid(value.entityUid))
    || (hasOwn(value, 'sourceEntityUid') && value.sourceEntityUid != null && !validEntityUid(value.sourceEntityUid))
    || (hasOwn(value, 'targetEntityUid') && value.targetEntityUid != null && !validEntityUid(value.targetEntityUid))
    || (value.type != null && !safeEntityType(value.type))
    || (value.sourceHandle != null && !safeIdentity(value.sourceHandle))
    || (value.targetHandle != null && !safeIdentity(value.targetHandle))
    || (hasOwn(value, 'data') && !isRecord(value.data))) {
    throw new CollaborationSyncFallbackError('operation_payload_invalid', `${label} 缺少安全连线身份或端点`);
  }
  const edge = cloneJson(value);
  if (edge.entityUid != null) edge.entityUid = String(edge.entityUid).toLowerCase();
  if (edge.sourceEntityUid != null) edge.sourceEntityUid = String(edge.sourceEntityUid).toLowerCase();
  if (edge.targetEntityUid != null) edge.targetEntityUid = String(edge.targetEntityUid).toLowerCase();
  return edge;
}

/** Request/ACK payloads predate server-generated entityUid; public deltas do not. */
function validateMutationOperationPayload(type: CanvasOperationType, rawPayload: unknown) {
  if (type === 'node.add' || type === 'node.restore') {
    if (!isRecord(rawPayload)
      || !hasOnlyKeys(rawPayload, ['node'])
      || !hasOwn(rawPayload, 'node')) {
      throw new CollaborationSyncFallbackError('operation_payload_invalid', `${type}.payload 字段不完整`);
    }
    return { node: validateMutationNodeValue(rawPayload.node, `${type}.node`) };
  }
  if (type === 'edge.add' || type === 'edge.restore') {
    if (!isRecord(rawPayload)
      || !hasOnlyKeys(rawPayload, ['edge'])
      || !hasOwn(rawPayload, 'edge')) {
      throw new CollaborationSyncFallbackError('operation_payload_invalid', `${type}.payload 字段不完整`);
    }
    return { edge: validateMutationEdgeValue(rawPayload.edge, `${type}.edge`) };
  }
  return validateOperationPayload(type, rawPayload);
}

function matchingEntityIndexes(values: unknown[], identity: string) {
  return values.flatMap((value, index) => (
    isRecord(value) && (String(value.id || '') === identity || String(value.entityUid || '') === identity)
      ? [index]
      : []
  ));
}

function bindEdgeEndpointIdentities(
  document: VersionedCanvasData,
  edge: Record<string, unknown>,
  code: string,
  message: string,
) {
  const endpoints = [
    ['source', 'sourceEntityUid'],
    ['target', 'targetEntityUid'],
  ] as const;
  const resolved: Record<'source' | 'target', Record<string, unknown>> = {} as Record<
    'source' | 'target',
    Record<string, unknown>
  >;
  for (const [displayKey, stableKey] of endpoints) {
    const indexes = matchingEntityIndexes(document.nodes, String(edge[displayKey] || ''));
    if (indexes.length !== 1) {
      throw new CollaborationSyncFallbackError('edge_endpoint_missing', '增量连线端点不存在或身份冲突');
    }
    const node = document.nodes[indexes[0]] as Record<string, unknown>;
    if (!validEntityUid(node.entityUid)) {
      throw new CollaborationSyncFallbackError(code, message);
    }
    const nodeUid = String(node.entityUid).toLowerCase();
    if (edge[stableKey] != null
      && (!validEntityUid(edge[stableKey]) || String(edge[stableKey]).toLowerCase() !== nodeUid)) {
      throw new CollaborationSyncFallbackError(code, message);
    }
    edge[stableKey] = nodeUid;
    resolved[displayKey] = node;
  }
  return resolved;
}

function tombstoneEntry(records: Record<string, CanvasTombstoneRecord>, identity: unknown) {
  const target = String(identity || '');
  if (!target) return null;
  const entries = Object.entries(records).filter(([key, record]) => (
    key === target || String(record?.entityUid || '') === target
  ));
  if (entries.length > 1) {
    throw new CollaborationSyncFallbackError('operation_tombstone_ambiguous', '增量同步 tombstone 身份冲突');
  }
  return entries.length === 1 ? { key: entries[0][0], record: entries[0][1] } : null;
}

function publicTombstone(
  operation: CanvasSyncOperation,
  identity: {
    entityUid?: unknown;
    entityType?: unknown;
    source?: unknown;
    target?: unknown;
    sourceHandle?: unknown;
    targetHandle?: unknown;
    legacyAliases?: unknown;
    sourceEntityUid?: unknown;
    targetEntityUid?: unknown;
  },
): CanvasTombstoneRecord {
  const tombstone: CanvasTombstoneRecord = {
    opId: operation.opId,
    actorId: operation.actorId,
    deletedAt: operation.timestamp,
    revision: operation.revision,
    entityUid: validEntityUid(identity.entityUid) ? String(identity.entityUid).toLowerCase() : null,
    entityType: identity.entityType == null ? null : String(identity.entityType),
    source: identity.source == null ? null : String(identity.source),
    target: identity.target == null ? null : String(identity.target),
  };
  if (Object.prototype.hasOwnProperty.call(identity, 'sourceHandle')) {
    tombstone.sourceHandle = identity.sourceHandle == null ? null : String(identity.sourceHandle);
  }
  if (Object.prototype.hasOwnProperty.call(identity, 'targetHandle')) {
    tombstone.targetHandle = identity.targetHandle == null ? null : String(identity.targetHandle);
  }
  if (identity.legacyAliases != null) {
    if (!Array.isArray(identity.legacyAliases)
      || identity.legacyAliases.length > 500
      || identity.legacyAliases.some((alias) => !safeIdentity(alias))) {
      throw new CollaborationSyncFallbackError('operation_payload_invalid', 'tombstone legacyAliases 无效');
    }
    tombstone.legacyAliases = [...new Set(identity.legacyAliases.map(String))];
  }
  for (const key of ['sourceEntityUid', 'targetEntityUid'] as const) {
    if (!Object.prototype.hasOwnProperty.call(identity, key)) continue;
    if (identity[key] != null && !validEntityUid(identity[key])) {
      throw new CollaborationSyncFallbackError('operation_payload_invalid', `tombstone ${key} 无效`);
    }
    tombstone[key] = identity[key] == null ? null : String(identity[key]).toLowerCase();
  }
  return tombstone;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameJson(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
}

function assertNoPublicSessionField(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
) {
  if (value == null || typeof value !== 'object') return;
  if (depth > MAX_PUBLIC_JSON_DEPTH || seen.has(value)) {
    throw new CollaborationSyncFallbackError('snapshot_document_invalid', '权威快照包含不安全对象结构');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoPublicSessionField(item, seen, depth + 1);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (isPrivateSessionKey(key)) {
        throw new CollaborationSyncFallbackError('snapshot_document_private_field', '权威快照不得包含 sessionId');
      }
      assertNoPublicSessionField(item, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function validateDocumentShape(value: unknown, projectId: string, canvasId: string) {
  assertNoPublicSessionField(value);
  if (!isRecord(value)
    || value.schema !== 't8-canvas-document'
    || value.schemaVersion !== 2
    || value.projectId !== projectId
    || value.canvasId !== canvasId
    || !safeIdentity(value.entityUid)
    || !safeRevision(value.revision, 1)
    || !safeRevision(value.viewportRevision, 1)
    || Number(value.viewportRevision) > Number(value.revision)
    || !Number.isSafeInteger(value.updatedAt)
    || value.updatedAt < 0
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.edges)
    || !Array.isArray(value.subflowInstances)
    || !isRecord(value.tombstones)
    || !isRecord(value.tombstones.nodes)
    || !isRecord(value.tombstones.edges)
    || !isRecord(value.viewport)
    || typeof value.viewport.x !== 'number'
    || !Number.isFinite(value.viewport.x)
    || typeof value.viewport.y !== 'number'
    || !Number.isFinite(value.viewport.y)
    || typeof value.viewport.zoom !== 'number'
    || !Number.isFinite(value.viewport.zoom)
    || Math.abs(value.viewport.x) > 10_000_000
    || Math.abs(value.viewport.y) > 10_000_000
    || value.viewport.zoom < 0.01
    || value.viewport.zoom > 64) {
    throw new CollaborationSyncFallbackError('snapshot_document_invalid', '权威快照文档结构无效');
  }
  const nodeIdentities = new Map<string, Record<string, unknown>>();
  for (const node of value.nodes) {
    if (!isRecord(node)
      || !safeIdentity(node.id)
      || !validEntityUid(node.entityUid)
      || !safeRevision(node.entityRevision, 1)
      || Number(node.entityRevision) > Number(value.revision)
      || !validPosition(node.position)) {
      throw new CollaborationSyncFallbackError('snapshot_node_invalid', '权威快照包含无效节点');
    }
    if (node.legacyAliases != null
      && (!Array.isArray(node.legacyAliases)
        || node.legacyAliases.length > 500
        || node.legacyAliases.some((alias) => !safeIdentity(alias)))) {
      throw new CollaborationSyncFallbackError('snapshot_node_invalid', '权威快照节点 legacyAliases 无效');
    }
    const identities = new Set([
      String(node.id),
      String(node.entityUid).toLowerCase(),
      ...(Array.isArray(node.legacyAliases) ? node.legacyAliases.map(String) : []),
    ]);
    for (const identity of identities) {
      if (!identity) continue;
      if (!safeIdentity(identity) || nodeIdentities.has(identity)) {
        throw new CollaborationSyncFallbackError('snapshot_node_identity_conflict', '权威快照节点身份冲突');
      }
      nodeIdentities.set(identity, node);
    }
  }

  const allNodeIdentities = new Map(nodeIdentities);
  for (const [key, tombstone] of Object.entries(value.tombstones.nodes)) {
    if (!safeIdentity(key)
      || !isRecord(tombstone)
      || (tombstone.entityUid != null && !validEntityUid(tombstone.entityUid))
      || (tombstone.legacyAliases != null
        && (!Array.isArray(tombstone.legacyAliases)
          || tombstone.legacyAliases.length > 500
          || tombstone.legacyAliases.some((alias) => !safeIdentity(alias))))) {
      throw new CollaborationSyncFallbackError('snapshot_node_tombstone_invalid', '权威快照包含无效节点 tombstone');
    }
    const identities = new Set([
      key,
      ...(tombstone.entityUid == null ? [] : [String(tombstone.entityUid).toLowerCase()]),
      ...(Array.isArray(tombstone.legacyAliases) ? tombstone.legacyAliases.map(String) : []),
    ]);
    for (const identity of identities) {
      if (allNodeIdentities.has(identity)) {
        throw new CollaborationSyncFallbackError('snapshot_node_identity_conflict', '权威快照活动节点与 tombstone 身份冲突');
      }
      allNodeIdentities.set(identity, tombstone);
    }
  }

  const edgeIdentities = new Map<string, Record<string, unknown>>();
  for (const edge of value.edges) {
    if (!isRecord(edge)
      || !safeIdentity(edge.id)
      || !validEntityUid(edge.entityUid)
      || !safeRevision(edge.entityRevision, 1)
      || Number(edge.entityRevision) > Number(value.revision)
      || !safeIdentity(edge.source)
      || !safeIdentity(edge.target)) {
      throw new CollaborationSyncFallbackError('snapshot_edge_invalid', '权威快照包含无效连线');
    }
    if (edge.legacyAliases != null
      && (!Array.isArray(edge.legacyAliases)
        || edge.legacyAliases.length > 500
        || edge.legacyAliases.some((alias) => !safeIdentity(alias)))) {
      throw new CollaborationSyncFallbackError('snapshot_edge_invalid', '权威快照连线 legacyAliases 无效');
    }
    const identities = new Set([
      String(edge.id),
      String(edge.entityUid).toLowerCase(),
      ...(Array.isArray(edge.legacyAliases) ? edge.legacyAliases.map(String) : []),
    ]);
    for (const identity of identities) {
      if (!identity) continue;
      if (!safeIdentity(identity) || edgeIdentities.has(identity)) {
        throw new CollaborationSyncFallbackError('snapshot_edge_identity_conflict', '权威快照连线身份冲突');
      }
      edgeIdentities.set(identity, edge);
    }
    const sourceNode = nodeIdentities.get(String(edge.source));
    const targetNode = nodeIdentities.get(String(edge.target));
    if (!sourceNode || !targetNode) {
      throw new CollaborationSyncFallbackError('snapshot_edge_endpoint_missing', '权威快照连线端点不存在');
    }
    if ((edge.sourceEntityUid != null
      && (!validEntityUid(edge.sourceEntityUid)
        || String(edge.sourceEntityUid).toLowerCase() !== String(sourceNode.entityUid).toLowerCase()))
      || (edge.targetEntityUid != null
        && (!validEntityUid(edge.targetEntityUid)
          || String(edge.targetEntityUid).toLowerCase() !== String(targetNode.entityUid).toLowerCase()))) {
      throw new CollaborationSyncFallbackError('snapshot_edge_endpoint_identity_conflict', '权威快照连线稳定端点身份冲突');
    }
  }

  const allEdgeIdentities = new Map(edgeIdentities);
  for (const [key, tombstone] of Object.entries(value.tombstones.edges)) {
    if (!safeIdentity(key)
      || !isRecord(tombstone)
      || (tombstone.entityUid != null && !validEntityUid(tombstone.entityUid))
      || (tombstone.source != null && !safeIdentity(tombstone.source))
      || (tombstone.target != null && !safeIdentity(tombstone.target))
      || (tombstone.sourceEntityUid != null && !validEntityUid(tombstone.sourceEntityUid))
      || (tombstone.targetEntityUid != null && !validEntityUid(tombstone.targetEntityUid))
      || (tombstone.legacyAliases != null
        && (!Array.isArray(tombstone.legacyAliases)
          || tombstone.legacyAliases.length > 500
          || tombstone.legacyAliases.some((alias) => !safeIdentity(alias))))) {
      throw new CollaborationSyncFallbackError('snapshot_edge_tombstone_invalid', '权威快照包含无效连线 tombstone');
    }
    const identities = new Set([
      key,
      ...(tombstone.entityUid == null ? [] : [String(tombstone.entityUid).toLowerCase()]),
      ...(Array.isArray(tombstone.legacyAliases) ? tombstone.legacyAliases.map(String) : []),
    ]);
    for (const identity of identities) {
      if (allEdgeIdentities.has(identity)) {
        throw new CollaborationSyncFallbackError('snapshot_edge_identity_conflict', '权威快照活动连线与 tombstone 身份冲突');
      }
      allEdgeIdentities.set(identity, tombstone);
    }
    const sourceNode = tombstone.source == null ? null : allNodeIdentities.get(String(tombstone.source));
    const targetNode = tombstone.target == null ? null : allNodeIdentities.get(String(tombstone.target));
    if ((tombstone.sourceEntityUid != null && sourceNode?.entityUid != null
      && String(tombstone.sourceEntityUid).toLowerCase() !== String(sourceNode.entityUid).toLowerCase())
      || (tombstone.targetEntityUid != null && targetNode?.entityUid != null
        && String(tombstone.targetEntityUid).toLowerCase() !== String(targetNode.entityUid).toLowerCase())) {
      throw new CollaborationSyncFallbackError(
        'snapshot_edge_endpoint_identity_conflict',
        '权威快照连线 tombstone 稳定端点身份冲突',
      );
    }
  }
  return value as VersionedCanvasData;
}

function validatePublicOperation(
  raw: unknown,
  base: VersionedCanvasData,
  expectedRevision: number,
  allowedTypes: ReadonlySet<CanvasOperationType>,
) {
  if (!isRecord(raw)) {
    throw new CollaborationSyncFallbackError('operation_invalid', '增量同步包含无效操作');
  }
  if (typeof raw.type !== 'string'
    || !COLLABORATION_OPERATION_TYPES.has(raw.type as CanvasOperationType)
    || !allowedTypes.has(raw.type as CanvasOperationType)) {
    throw new CollaborationSyncFallbackError(
      'operation_requires_snapshot',
      `客户端对 ${String(raw.type || 'unknown')} 使用权威快照恢复`,
    );
  }
  if (!hasOnlyKeys(raw, OPERATION_KEYS)
    || !safeIdentity(raw.opId)
    || raw.projectId !== base.projectId
    || raw.canvasId !== base.canvasId
    || !safeIdentity(raw.actorId)
    || Object.prototype.hasOwnProperty.call(raw, 'sessionId')
    || !safeRevision(raw.baseRevision, 1)
    || !safeRevision(raw.revision, 1)
    || raw.revision !== expectedRevision
    || raw.baseRevision >= raw.revision
    || !safeRevision(raw.clientSeq, 0)
    || !safeRevision(raw.timestamp, 1)
    || !isRecord(raw.payload)) {
    throw new CollaborationSyncFallbackError('operation_identity_invalid', '增量同步操作身份或 payload 无效');
  }
  const type = raw.type as CanvasOperationType;
  const payload = validateOperationPayload(type, raw.payload);
  return { ...raw, type, payload } as CanvasSyncOperation;
}

function applyPublicOperation(document: VersionedCanvasData, operation: CanvasSyncOperation) {
  const payload = operation.payload;
  if (operation.type === 'node.add') {
    const node = cloneJson(payload.node) as Record<string, unknown>;
    node.entityRevision = operation.revision;
    const nodeId = String(node.id);
    const entityUid = String(node.entityUid);
    if (tombstoneEntry(document.tombstones.nodes, nodeId)
      || tombstoneEntry(document.tombstones.nodes, entityUid)) {
      throw new CollaborationSyncFallbackError('operation_object_deleted', '增量新增节点命中 tombstone');
    }
    if (matchingEntityIndexes(document.nodes, nodeId).length > 0
      || matchingEntityIndexes(document.nodes, entityUid).length > 0) {
      throw new CollaborationSyncFallbackError('operation_identity_conflict', '增量新增节点身份冲突');
    }
    document.nodes.push(node);
  } else if (operation.type === 'node.patch') {
    const nodeId = String(payload.nodeId);
    if (tombstoneEntry(document.tombstones.nodes, nodeId)) {
      throw new CollaborationSyncFallbackError('operation_object_deleted', '增量修改节点命中 tombstone');
    }
    const indexes = matchingEntityIndexes(document.nodes, nodeId);
    if (indexes.length !== 1) {
      throw new CollaborationSyncFallbackError('node_target_missing', '增量修改的目标节点不存在或身份冲突');
    }
    const current = document.nodes[indexes[0]] as Record<string, unknown>;
    const patch = isRecord(payload.patch) ? cloneJson(payload.patch) : {};
    const dataPatch = isRecord(payload.dataPatch) ? cloneJson(payload.dataPatch) : null;
    const next: Record<string, unknown> = {
      ...current,
      ...patch,
      id: current.id,
      entityUid: current.entityUid,
      type: current.type,
      entityRevision: operation.revision,
    };
    if (dataPatch) {
      const baseData = isRecord(patch.data)
        ? patch.data
        : (isRecord(current.data) ? current.data : {});
      next.data = { ...baseData, ...dataPatch };
    }
    for (const key of Array.isArray(payload.unsetKeys) ? payload.unsetKeys : []) delete next[String(key)];
    if (Array.isArray(payload.dataUnsetKeys) && payload.dataUnsetKeys.length > 0) {
      const nextData = isRecord(next.data) ? { ...next.data } : {};
      for (const key of payload.dataUnsetKeys) delete nextData[String(key)];
      next.data = nextData;
    }
    document.nodes[indexes[0]] = next;
  } else if (operation.type === 'node.move') {
    const nodeId = String(payload.nodeId);
    if (tombstoneEntry(document.tombstones.nodes, nodeId)) {
      throw new CollaborationSyncFallbackError('operation_object_deleted', '增量移动节点命中 tombstone');
    }
    const indexes = matchingEntityIndexes(document.nodes, nodeId);
    if (indexes.length !== 1) {
      throw new CollaborationSyncFallbackError('move_target_missing', '增量移动的目标节点不存在或身份冲突');
    }
    document.nodes[indexes[0]] = {
      ...document.nodes[indexes[0]],
      position: cloneJson(payload.position),
      entityRevision: operation.revision,
    };
  } else if (operation.type === 'node.delete') {
    const nodeId = String(payload.nodeId);
    const indexes = matchingEntityIndexes(document.nodes, nodeId);
    if (indexes.length !== 1) {
      if (tombstoneEntry(document.tombstones.nodes, nodeId)) {
        throw new CollaborationSyncFallbackError('operation_object_deleted', '增量删除节点已存在 tombstone');
      }
      throw new CollaborationSyncFallbackError('node_target_missing', '增量删除的目标节点不存在或身份冲突');
    }
    const node = document.nodes[indexes[0]] as Record<string, unknown>;
    const canonicalId = String(node.id);
    const entityUid = String(node.entityUid || '');
    const connectedEdgeIndexes = new Set(document.edges.flatMap((edge, edgeIndex) => {
      const source = String(edge?.source || '');
      const target = String(edge?.target || '');
      return source === canonicalId || source === entityUid || target === canonicalId || target === entityUid
        ? [edgeIndex]
        : [];
    }));
    document.tombstones.nodes[canonicalId] = publicTombstone(operation, {
      entityUid: node.entityUid,
      entityType: node.type,
      legacyAliases: node.legacyAliases,
    });
    for (const edgeIndex of connectedEdgeIndexes) {
      const edge = document.edges[edgeIndex] as Record<string, unknown>;
      bindEdgeEndpointIdentities(
        document,
        edge,
        'operation_identity_conflict',
        '增量删除连线的稳定端点身份无效',
      );
      document.tombstones.edges[String(edge.id)] = publicTombstone(operation, {
        entityUid: edge.entityUid,
        entityType: edge.type,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        legacyAliases: edge.legacyAliases,
        sourceEntityUid: edge.sourceEntityUid,
        targetEntityUid: edge.targetEntityUid,
      });
    }
    document.nodes.splice(indexes[0], 1);
    document.edges = document.edges.filter((_edge, edgeIndex) => !connectedEdgeIndexes.has(edgeIndex));
  } else if (operation.type === 'node.restore') {
    const node = cloneJson(payload.node) as Record<string, unknown>;
    node.entityRevision = operation.revision;
    const nodeId = String(node.id);
    const entityUid = String(node.entityUid).toLowerCase();
    const deleted = tombstoneEntry(document.tombstones.nodes, nodeId)
      || tombstoneEntry(document.tombstones.nodes, entityUid);
    if (!deleted
      || deleted.key !== nodeId
      || !validEntityUid(deleted.record.entityUid)
      || String(deleted.record.entityUid).toLowerCase() !== entityUid
      || (deleted.record.entityType == null ? null : String(deleted.record.entityType)) !== String(node.type)) {
      throw new CollaborationSyncFallbackError('operation_restore_invalid', '增量节点恢复与 tombstone 身份不一致');
    }
    if (matchingEntityIndexes(document.nodes, nodeId).length > 0
      || matchingEntityIndexes(document.nodes, entityUid).length > 0) {
      throw new CollaborationSyncFallbackError('operation_identity_conflict', '增量恢复节点身份冲突');
    }
    delete document.tombstones.nodes[deleted.key];
    document.nodes.push(node);
  } else if (operation.type === 'edge.add') {
    const edge = cloneJson(payload.edge) as Record<string, unknown>;
    edge.entityRevision = operation.revision;
    const edgeId = String(edge.id);
    const entityUid = String(edge.entityUid);
    if (tombstoneEntry(document.tombstones.edges, edgeId)
      || tombstoneEntry(document.tombstones.edges, entityUid)) {
      throw new CollaborationSyncFallbackError('operation_object_deleted', '增量新增连线命中 tombstone');
    }
    if (matchingEntityIndexes(document.edges, edgeId).length > 0
      || matchingEntityIndexes(document.edges, entityUid).length > 0) {
      throw new CollaborationSyncFallbackError('operation_identity_conflict', '增量新增连线身份冲突');
    }
    for (const endpoint of [String(edge.source), String(edge.target)]) {
      if (tombstoneEntry(document.tombstones.nodes, endpoint)) {
        throw new CollaborationSyncFallbackError('operation_object_deleted', '增量连线端点命中 tombstone');
      }
    }
    bindEdgeEndpointIdentities(
      document,
      edge,
      'operation_identity_conflict',
      '增量新增连线的稳定端点身份不一致',
    );
    document.edges.push(edge);
  } else if (operation.type === 'edge.delete') {
    const edgeId = String(payload.edgeId);
    const indexes = matchingEntityIndexes(document.edges, edgeId);
    if (indexes.length !== 1) {
      if (tombstoneEntry(document.tombstones.edges, edgeId)) {
        throw new CollaborationSyncFallbackError('operation_object_deleted', '增量删除连线已存在 tombstone');
      }
      throw new CollaborationSyncFallbackError('edge_target_missing', '增量删除的目标连线不存在或身份冲突');
    }
    const edge = document.edges[indexes[0]] as Record<string, unknown>;
    bindEdgeEndpointIdentities(
      document,
      edge,
      'operation_identity_conflict',
      '增量删除连线的稳定端点身份无效',
    );
    document.tombstones.edges[String(edge.id)] = publicTombstone(operation, {
      entityUid: edge.entityUid,
      entityType: edge.type,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      legacyAliases: edge.legacyAliases,
      sourceEntityUid: edge.sourceEntityUid,
      targetEntityUid: edge.targetEntityUid,
    });
    document.edges.splice(indexes[0], 1);
  } else if (operation.type === 'edge.restore') {
    const edge = cloneJson(payload.edge) as Record<string, unknown>;
    edge.entityRevision = operation.revision;
    const edgeId = String(edge.id);
    const entityUid = String(edge.entityUid).toLowerCase();
    const deleted = tombstoneEntry(document.tombstones.edges, edgeId)
      || tombstoneEntry(document.tombstones.edges, entityUid);
    const edgeType = edge.type == null ? null : String(edge.type);
    const sourceHandle = edge.sourceHandle == null ? null : String(edge.sourceHandle);
    const targetHandle = edge.targetHandle == null ? null : String(edge.targetHandle);
    if (!deleted
      || deleted.key !== edgeId
      || !validEntityUid(deleted.record.entityUid)
      || String(deleted.record.entityUid).toLowerCase() !== entityUid
      || (deleted.record.entityType == null ? null : String(deleted.record.entityType)) !== edgeType
      || String(deleted.record.source || '') !== String(edge.source)
      || String(deleted.record.target || '') !== String(edge.target)
      || (Object.prototype.hasOwnProperty.call(deleted.record, 'sourceHandle')
        && deleted.record.sourceHandle !== sourceHandle)
      || (Object.prototype.hasOwnProperty.call(deleted.record, 'targetHandle')
        && deleted.record.targetHandle !== targetHandle)) {
      throw new CollaborationSyncFallbackError('operation_restore_invalid', '增量连线恢复与 tombstone 身份不一致');
    }
    const endpoints = bindEdgeEndpointIdentities(
      document,
      edge,
      'operation_restore_invalid',
      '增量恢复连线的稳定端点身份不一致',
    );
    if ((deleted.record.sourceEntityUid != null
      && String(deleted.record.sourceEntityUid).toLowerCase() !== String(endpoints.source.entityUid).toLowerCase())
      || (deleted.record.targetEntityUid != null
        && String(deleted.record.targetEntityUid).toLowerCase() !== String(endpoints.target.entityUid).toLowerCase())) {
      throw new CollaborationSyncFallbackError('operation_restore_invalid', '增量连线恢复与 tombstone 稳定端点身份不一致');
    }
    if (matchingEntityIndexes(document.edges, edgeId).length > 0
      || matchingEntityIndexes(document.edges, entityUid).length > 0) {
      throw new CollaborationSyncFallbackError('operation_identity_conflict', '增量恢复连线身份冲突');
    }
    delete document.tombstones.edges[deleted.key];
    document.edges.push(edge);
  } else {
    document.viewport = cloneJson(payload.viewport) as VersionedCanvasData['viewport'];
    document.viewportRevision = operation.revision;
  }
  document.revision = operation.revision;
  document.updatedAt = Math.max(document.updatedAt, operation.timestamp);
  validateDocumentShape(document, document.projectId, document.canvasId);
  return document;
}

function applyCollaborationOperationsDeltaInternal(
  base: VersionedCanvasData,
  sync: unknown,
  maxOperations: number,
  allowedTypes: ReadonlySet<CanvasOperationType>,
) {
  if (!isRecord(sync)
    || sync.mode !== 'operations'
    || !hasOnlyKeys(sync, ['mode', 'canvasId', 'afterRevision', 'revision', 'generation', 'operations'])
    || (sync.generation !== undefined && (typeof sync.generation !== 'string' || !UUID_PATTERN.test(sync.generation)))) {
    throw new CollaborationSyncFallbackError('operations_envelope_invalid', '增量同步 envelope 无效');
  }
  validateDocumentShape(base, base.projectId, base.canvasId);
  if (sync.canvasId !== base.canvasId) {
    throw new CollaborationSyncFallbackError('canvas_mismatch', '增量同步画布与当前会话不一致');
  }
  if (!safeRevision(sync.afterRevision) || sync.afterRevision !== base.revision) {
    throw new CollaborationSyncFallbackError('base_revision_mismatch', '增量同步起始 revision 与客户端不一致');
  }
  if (!safeRevision(sync.revision) || sync.revision < base.revision) {
    throw new CollaborationSyncFallbackError('revision_regression', '增量同步 revision 发生回退');
  }
  if (!Array.isArray(sync.operations)) {
    throw new CollaborationSyncFallbackError('operations_invalid', '增量同步 operations 必须是数组');
  }
  const normalizedMaxOperations = Number.isSafeInteger(maxOperations)
    ? Math.max(1, Math.min(COLLABORATION_SYNC_MAX_OPERATIONS, maxOperations))
    : COLLABORATION_SYNC_MAX_OPERATIONS;
  if (sync.operations.length > normalizedMaxOperations) {
    throw new CollaborationSyncFallbackError('operations_limit_exceeded', '增量同步操作数量超过协议上限');
  }
  let encodedBytes = 0;
  try {
    encodedBytes = new TextEncoder().encode(JSON.stringify(sync)).byteLength;
  } catch (_) {
    throw new CollaborationSyncFallbackError('operations_envelope_invalid', '增量同步 envelope 不是安全 JSON');
  }
  if (encodedBytes > COLLABORATION_SYNC_MAX_OPERATION_BYTES) {
    throw new CollaborationSyncFallbackError('operations_bytes_exceeded', '增量同步响应超过 1 MiB 上限');
  }
  const expectedCount = sync.revision - base.revision;
  if (sync.operations.length !== expectedCount) {
    throw new CollaborationSyncFallbackError('revision_count_gap', '增量同步操作数量与 revision 缺口不一致');
  }
  const document = cloneJson(base);
  const seenOpIds = new Set<string>();
  for (let index = 0; index < sync.operations.length; index += 1) {
    const operation = validatePublicOperation(
      sync.operations[index],
      base,
      base.revision + index + 1,
      allowedTypes,
    );
    if (seenOpIds.has(operation.opId)) {
      throw new CollaborationSyncFallbackError('operation_id_duplicate', '增量同步包含重复 opId');
    }
    seenOpIds.add(operation.opId);
    applyPublicOperation(document, operation);
  }
  if (document.revision !== sync.revision) {
    throw new CollaborationSyncFallbackError('revision_tail_gap', '增量同步最终 revision 不一致');
  }
  return document;
}

export function applyCollaborationOperationsDelta(
  base: VersionedCanvasData,
  sync: unknown,
  maxOperations = COLLABORATION_SYNC_MAX_OPERATIONS,
) {
  return applyCollaborationOperationsDeltaInternal(base, sync, maxOperations, COLLABORATION_OPERATION_TYPES);
}

/** F2 compatibility wrapper: callers that explicitly request move-only replay stay fail-closed. */
export function applyCollaborationMoveDelta(
  base: VersionedCanvasData,
  sync: unknown,
  maxOperations = COLLABORATION_SYNC_MAX_OPERATIONS,
) {
  return applyCollaborationOperationsDeltaInternal(
    base,
    sync,
    maxOperations,
    new Set<CanvasOperationType>(['node.move']),
  );
}

export function acceptCollaborationSnapshot(
  base: VersionedCanvasData,
  sync: unknown,
) {
  if (!isRecord(sync)
    || sync.mode !== 'snapshot'
    || !hasOnlyKeys(sync, ['mode', 'canvasId', 'afterRevision', 'revision', 'generation', 'reason', 'document'])
    || (sync.generation !== undefined && (typeof sync.generation !== 'string' || !UUID_PATTERN.test(sync.generation)))
    || sync.canvasId !== base.canvasId
    || !safeRevision(sync.afterRevision)
    || sync.afterRevision !== base.revision
    || !safeRevision(sync.revision, 1)
    || ![
      'initial',
      'client_ahead',
      'range_exceeded',
      'snapshot_required',
      'history_gap',
      'recovery_generation_changed',
      'resource_scope_snapshot',
    ].includes(String(sync.reason))) {
    throw new CollaborationSyncFallbackError('snapshot_envelope_invalid', '权威快照 envelope 无效');
  }
  const document = validateDocumentShape(sync.document, base.projectId, base.canvasId);
  if (sync.revision !== document.revision) {
    throw new CollaborationSyncFallbackError('snapshot_revision_mismatch', '快照 envelope 与文档 revision 不一致');
  }
  if (document.revision < base.revision
    && sync.reason !== 'client_ahead'
    && sync.reason !== 'recovery_generation_changed') {
    throw new CollaborationSyncFallbackError('snapshot_revision_regression', '权威快照 revision 发生非预期回退');
  }
  return cloneJson(document);
}

export function collaborationDeltaAcknowledgesQueuedMove(
  operation: unknown,
  queued: QueuedMoveIdentity,
  memberId: string,
) {
  if (!isRecord(operation)
    || queued.baseRevision == null
    || !hasOnlyKeys(operation, [
      'opId',
      'projectId',
      'canvasId',
      'baseRevision',
      'revision',
      'actorId',
      'clientSeq',
      'type',
      'payload',
      'timestamp',
    ])
    || operation.type !== 'node.move'
    || operation.opId !== queued.operation.opId
    || operation.actorId !== memberId
    || operation.baseRevision !== queued.baseRevision
    || operation.clientSeq !== queued.operation.clientSeq
    || operation.timestamp !== queued.operation.timestamp
    || !isRecord(operation.payload)
    || !hasOnlyKeys(operation.payload, ['nodeId', 'position'])
    || operation.payload.nodeId !== queued.operation.payload.nodeId
    || !validPosition(operation.payload.position)) return false;
  return operation.payload.position.x === queued.operation.payload.position.x
    && operation.payload.position.y === queued.operation.payload.position.y;
}

function validateMutationOperationIdentity(raw: unknown) {
  if (!isRecord(raw)
    || !hasOnlyKeys(raw, MUTATION_IDENTITY_KEYS)
    || !safeIdentity(raw.opId)
    || !safeRevision(raw.clientSeq, 0)
    || !safeRevision(raw.timestamp, 1)
    || typeof raw.type !== 'string'
    || !COLLABORATION_OPERATION_TYPES.has(raw.type as CanvasOperationType)
    || !isRecord(raw.payload)) {
    throw new CollaborationSyncFallbackError(
      'mutation_acknowledgement_invalid',
      '协作保存请求缺少完整操作身份',
    );
  }
  const type = raw.type as CanvasOperationType;
  return {
    opId: raw.opId,
    clientSeq: raw.clientSeq,
    timestamp: raw.timestamp,
    type,
    payload: validateMutationOperationPayload(type, raw.payload),
  } as CollaborationMutationOperationIdentity;
}

export function acceptCollaborationMutationResult(
  result: unknown,
  batch: CollaborationMutationBatchIdentity,
  scope: { projectId: string; canvasId: string; memberId: string },
) {
  if (!isRecord(result)
    || !hasOnlyKeys(result, ['document', 'acknowledgements'])
    || !Array.isArray(result.acknowledgements)
    || !Array.isArray(batch.operations)
    || batch.operations.length < 1
    || batch.operations.length > COLLABORATION_SYNC_MAX_OPERATIONS
    || result.acknowledgements.length !== batch.operations.length
    || !safeRevision(batch.baseRevision, 1)
    || !safeIdentity(scope.projectId)
    || !safeIdentity(scope.canvasId)
    || !safeIdentity(scope.memberId)) {
    throw new CollaborationSyncFallbackError(
      'mutation_acknowledgement_invalid',
      '协作保存响应缺少数量精确的批次确认',
    );
  }
  const expectedOperations = batch.operations.map(validateMutationOperationIdentity);
  if (new Set(expectedOperations.map((operation) => operation.opId)).size !== expectedOperations.length) {
    throw new CollaborationSyncFallbackError(
      'mutation_acknowledgement_invalid',
      '协作保存批次包含重复 opId',
    );
  }
  const acknowledgements = result.acknowledgements.map((raw, index) => {
    const expected = expectedOperations[index];
    const expectedRevision = Number(batch.baseRevision) + index + 1;
    if (!isRecord(raw)
      || !hasOnlyKeys(raw, ACKNOWLEDGEMENT_KEYS)
      || raw.opId !== expected.opId
      || raw.projectId !== scope.projectId
      || raw.canvasId !== scope.canvasId
      || raw.actorId !== scope.memberId
      || raw.baseRevision !== batch.baseRevision
      || raw.revision !== expectedRevision
      || raw.clientSeq !== expected.clientSeq
      || raw.type !== expected.type
      || raw.timestamp !== expected.timestamp
      || typeof raw.duplicate !== 'boolean'
      || !isRecord(raw.payload)) {
      throw new CollaborationSyncFallbackError(
        'mutation_acknowledgement_mismatch',
        '协作保存响应未按顺序精确确认操作身份',
      );
    }
    const payload = validateMutationOperationPayload(expected.type, raw.payload);
    if (!sameJson(payload, expected.payload)) {
      throw new CollaborationSyncFallbackError(
        'mutation_acknowledgement_mismatch',
        '协作保存响应未精确确认原操作 payload',
      );
    }
    return {
      opId: raw.opId,
      projectId: raw.projectId,
      canvasId: raw.canvasId,
      baseRevision: raw.baseRevision,
      revision: raw.revision,
      actorId: raw.actorId,
      clientSeq: raw.clientSeq,
      type: expected.type,
      payload,
      timestamp: raw.timestamp,
      duplicate: raw.duplicate,
    } as CollaborationOperationAcknowledgement;
  });
  const duplicateFlags = new Set(acknowledgements.map((acknowledgement) => acknowledgement.duplicate));
  if (duplicateFlags.size !== 1) {
    throw new CollaborationSyncFallbackError(
      'mutation_acknowledgement_mixed_duplicate',
      '协作保存响应不得混合全新与重复确认',
    );
  }
  const document = validateDocumentShape(result.document, scope.projectId, scope.canvasId);
  const finalRevision = Number(batch.baseRevision) + acknowledgements.length;
  const allDuplicate = acknowledgements[0].duplicate;
  if ((!allDuplicate && document.revision !== finalRevision)
    || (allDuplicate && document.revision < finalRevision)) {
    throw new CollaborationSyncFallbackError(
      'mutation_acknowledgement_revision_invalid',
      '协作保存响应的确认 revision 与权威画布不一致',
    );
  }
  return {
    acknowledgements: cloneJson(acknowledgements),
    document: cloneJson(document),
  };
}

export function acceptCommonCollaborationMutationResult(
  result: unknown,
  rawBatch: CommonOperationBatch,
  scope: { projectId: string; canvasId: string; memberId: string },
) {
  if (!isRecord(result)
    || !hasOnlyKeys(result, ['document', 'acknowledgements', 'commonBatch'])
    || !Array.isArray(result.acknowledgements)) {
    throw new CollaborationSyncFallbackError(
      'common_mutation_acknowledgement_invalid',
      '共同操作保存响应缺少严格信封确认',
    );
  }
  let batch: CommonOperationBatch;
  let echoed: CommonOperationBatch;
  try {
    batch = normalizeCommonOperationBatch(rawBatch);
    echoed = normalizeCommonOperationBatch(result.commonBatch);
    if (serializeCommonOperationBatch(batch) !== serializeCommonOperationBatch(echoed)) {
      throw new Error('common batch echo mismatch');
    }
  } catch {
    throw new CollaborationSyncFallbackError(
      'common_mutation_batch_mismatch',
      '共同操作响应未精确回显原批次',
    );
  }
  if (batch.projectId !== scope.projectId
    || batch.canvasId !== scope.canvasId
    || result.acknowledgements.length !== batch.operations.length) {
    throw new CollaborationSyncFallbackError(
      'common_mutation_scope_mismatch',
      '共同操作响应的作用域或数量不一致',
    );
  }
  const operations = result.acknowledgements.map((raw, index) => {
    const common = batch.operations[index];
    if (!isRecord(raw)
      || raw.opId !== common.opId
      || raw.projectId !== batch.projectId
      || raw.canvasId !== batch.canvasId
      || raw.baseRevision !== batch.baseRevision
      || raw.revision !== batch.baseRevision + index + 1
      || raw.actorId !== scope.memberId
      || raw.clientSeq !== batch.clientSeq + index
      || raw.type !== common.type
      || !safeRevision(raw.timestamp, 1)
      || !isRecord(raw.payload)
      || typeof raw.duplicate !== 'boolean') {
      throw new CollaborationSyncFallbackError(
        'common_mutation_acknowledgement_mismatch',
        '共同操作响应未按顺序确认 UUID、CAS 和操作类型',
      );
    }
    return {
      opId: raw.opId,
      clientSeq: raw.clientSeq,
      timestamp: raw.timestamp,
      type: raw.type,
      payload: raw.payload,
    };
  });
  return acceptCollaborationMutationResult({
    document: result.document,
    acknowledgements: result.acknowledgements,
  }, {
    baseRevision: batch.baseRevision,
    operations,
  }, scope);
}

export function acceptCollaborationMoveMutationResult(
  result: unknown,
  queued: QueuedMoveIdentity,
  scope: { projectId: string; canvasId: string; memberId: string },
) {
  const accepted = acceptCollaborationMutationResult(result, {
    operations: [queued.operation],
    baseRevision: queued.baseRevision,
  }, scope);
  const acknowledgement = accepted.acknowledgements[0];
  if (acknowledgement.type !== 'node.move') {
    throw new CollaborationSyncFallbackError(
      'mutation_acknowledgement_mismatch',
      '协作保存响应未精确确认 node.move',
    );
  }
  return {
    acknowledgement: cloneJson(acknowledgement) as CollaborationMoveAcknowledgement,
    document: accepted.document,
  };
}

export function applyCollaborationSync(
  base: VersionedCanvasData,
  sync: unknown,
  options: { maxOperations?: number } = {},
) {
  if (!isRecord(sync)) {
    throw new CollaborationSyncFallbackError('sync_envelope_invalid', '协作同步响应不是对象');
  }
  if (sync.mode === 'snapshot') return acceptCollaborationSnapshot(base, sync);
  if (sync.mode === 'operations') {
    return applyCollaborationOperationsDelta(base, sync, options.maxOperations);
  }
  throw new CollaborationSyncFallbackError('sync_mode_invalid', '协作同步 mode 无效');
}
