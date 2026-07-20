import type { CanvasOperationType, WorkspaceRole } from '../types/project';

export const COLLABORATION_QUEUE_MAX_OPERATIONS = 200;
export const COLLABORATION_QUEUE_MAX_BYTES = 256 * 1024;
export const COLLABORATION_QUEUE_STORAGE_VERSION = 3;

const RECOVERY_GENERATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CollaborationQueueScope {
  projectId: string;
  canvasId: string;
  memberId: string;
  sessionId: string;
  role: WorkspaceRole;
  authorizationEpoch: number;
  recoveryGeneration: string;
}

export interface QueuedCollaborationOperation {
  opId: string;
  clientSeq: number;
  timestamp: number;
  type: 'node.move';
  payload: {
    nodeId: string;
    position: { x: number; y: number };
  };
}

export interface CollaborationQueueItem {
  id: string;
  operation: QueuedCollaborationOperation;
  baseRevision: number | null;
  status: 'pending' | 'inflight' | 'blocked';
  ambiguous: boolean;
  attempts: number;
  rebaseAttempts: number;
  error?: string;
}

export interface CollaborationQueueStats {
  operations: number;
  bytes: number;
  blocked: number;
  inflight: number;
}

export interface CollaborationQueueEnqueueResult {
  queue: CollaborationQueueItem[];
  accepted: boolean;
  coalesced: boolean;
  reason?: 'unsupported' | 'duplicate' | 'operation_limit' | 'byte_limit';
}

interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const SUPPORTED_TYPES = new Set<CanvasOperationType>(['node.move']);
const WORKSPACE_ROLES = new Set<WorkspaceRole>(['owner', 'editor', 'reviewer', 'viewer']);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function finiteCoordinate(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000;
}

function validScopeIdentity(value: unknown) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function validCollaborationQueueScope(value: unknown): value is CollaborationQueueScope {
  if (!isRecord(value)) return false;
  return hasOnlyKeys(value, [
    'projectId',
    'canvasId',
    'memberId',
    'sessionId',
    'role',
    'authorizationEpoch',
    'recoveryGeneration',
  ])
    && validScopeIdentity(value.projectId)
    && validScopeIdentity(value.canvasId)
    && validScopeIdentity(value.memberId)
    && validScopeIdentity(value.sessionId)
    && WORKSPACE_ROLES.has(value.role as WorkspaceRole)
    && Number.isSafeInteger(value.authorizationEpoch)
    && Number(value.authorizationEpoch) >= 1
    && typeof value.recoveryGeneration === 'string'
    && RECOVERY_GENERATION_PATTERN.test(value.recoveryGeneration)
    && value.recoveryGeneration === value.recoveryGeneration.toLowerCase();
}

function validOperation(value: unknown): value is QueuedCollaborationOperation {
  if (!isRecord(value) || value.type !== 'node.move' || !SUPPORTED_TYPES.has(value.type)) return false;
  if (!hasOnlyKeys(value, ['opId', 'clientSeq', 'timestamp', 'type', 'payload'])) return false;
  if (typeof value.opId !== 'string' || !value.opId || value.opId.length > 240) return false;
  if (!Number.isSafeInteger(value.clientSeq) || Number(value.clientSeq) < 0) return false;
  if (!Number.isSafeInteger(value.timestamp) || Number(value.timestamp) < 1) return false;
  if (!isRecord(value.payload)
    || !hasOnlyKeys(value.payload, ['nodeId', 'position'])
    || typeof value.payload.nodeId !== 'string'
    || !value.payload.nodeId
    || value.payload.nodeId.length > 240) return false;
  const position = value.payload.position;
  return isRecord(position)
    && hasOnlyKeys(position, ['x', 'y'])
    && finiteCoordinate(position.x)
    && finiteCoordinate(position.y);
}

function validQueueItem(value: unknown): value is CollaborationQueueItem {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || value.id.length > 240) return false;
  if (!hasOnlyKeys(value, [
    'id',
    'operation',
    'baseRevision',
    'status',
    'ambiguous',
    'attempts',
    'rebaseAttempts',
    'error',
  ])) return false;
  if (!validOperation(value.operation)) return false;
  if (value.id !== value.operation.opId) return false;
  if (value.baseRevision !== null
    && (!Number.isSafeInteger(value.baseRevision) || Number(value.baseRevision) < 1)) return false;
  if (!['pending', 'inflight', 'blocked'].includes(String(value.status))) return false;
  if (typeof value.ambiguous !== 'boolean') return false;
  if ((value.status === 'inflight' || value.ambiguous) && value.baseRevision === null) return false;
  if (value.error != null && (typeof value.error !== 'string' || value.error.length > 1000)) return false;
  return Number.isSafeInteger(value.attempts)
    && Number(value.attempts) >= 0
    && Number.isSafeInteger(value.rebaseAttempts)
    && Number(value.rebaseAttempts) >= 0;
}

function sameScope(left: unknown, right: CollaborationQueueScope) {
  if (!validCollaborationQueueScope(left)) return false;
  return left.projectId === right.projectId
    && left.canvasId === right.canvasId
    && left.memberId === right.memberId
    && left.sessionId === right.sessionId
    && left.role === right.role
    && left.authorizationEpoch === right.authorizationEpoch
    && left.recoveryGeneration === right.recoveryGeneration;
}

export function sameCollaborationQueueScope(
  left: CollaborationQueueScope | null | undefined,
  right: CollaborationQueueScope | null | undefined,
) {
  if (!validCollaborationQueueScope(left) || !validCollaborationQueueScope(right)) return false;
  return sameScope(left, right) && sameScope(right, left);
}

export function collaborationQueueStorageKey(scope: CollaborationQueueScope) {
  if (!validCollaborationQueueScope(scope)) throw new Error('协作队列作用域无效');
  const encoded = [
    scope.projectId,
    scope.canvasId,
    scope.memberId,
    scope.sessionId,
    scope.role,
    scope.authorizationEpoch,
    scope.recoveryGeneration,
  ].map((value) => encodeURIComponent(String(value)));
  return `t8-collaboration-queue:v${COLLABORATION_QUEUE_STORAGE_VERSION}:${encoded.join(':')}`;
}

export function collaborationQueueBytes(queue: CollaborationQueueItem[]) {
  return new TextEncoder().encode(JSON.stringify(queue)).byteLength;
}

export function collaborationQueueStats(queue: CollaborationQueueItem[]): CollaborationQueueStats {
  return {
    operations: queue.length,
    bytes: collaborationQueueBytes(queue),
    blocked: queue.filter((item) => item.status === 'blocked').length,
    inflight: queue.filter((item) => item.status === 'inflight').length,
  };
}

export function validCollaborationQueue(queue: unknown): queue is CollaborationQueueItem[] {
  if (!Array.isArray(queue) || queue.length > COLLABORATION_QUEUE_MAX_OPERATIONS) return false;
  const ids = new Set<string>();
  for (const item of queue) {
    if (!validQueueItem(item) || ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return collaborationQueueBytes(queue) <= COLLABORATION_QUEUE_MAX_BYTES;
}

export function enqueueCollaborationOperation(
  current: CollaborationQueueItem[],
  item: CollaborationQueueItem,
): CollaborationQueueEnqueueResult {
  if (!validCollaborationQueue(current)
    || !validQueueItem(item)
    || item.operation.type !== 'node.move') {
    return { queue: current, accepted: false, coalesced: false, reason: 'unsupported' };
  }
  if (current.some((entry) => entry.operation.opId === item.operation.opId)) {
    return { queue: current, accepted: false, coalesced: false, reason: 'duplicate' };
  }
  const tail = current[current.length - 1];
  const coalescibleIndex = tail
    && tail.status === 'pending'
    && tail.baseRevision === null
    && !tail.ambiguous
    && tail.operation.type === 'node.move'
    && tail.operation.payload.nodeId === item.operation.payload.nodeId
    ? current.length - 1
    : -1;
  const next = current.map((entry) => cloneJson(entry));
  if (coalescibleIndex >= 0) {
    next[coalescibleIndex] = cloneJson(item);
    if (collaborationQueueBytes(next) > COLLABORATION_QUEUE_MAX_BYTES) {
      return { queue: current, accepted: false, coalesced: false, reason: 'byte_limit' };
    }
    return { queue: next, accepted: true, coalesced: true };
  }
  if (next.length >= COLLABORATION_QUEUE_MAX_OPERATIONS) {
    return { queue: current, accepted: false, coalesced: false, reason: 'operation_limit' };
  }
  next.push(cloneJson(item));
  if (collaborationQueueBytes(next) > COLLABORATION_QUEUE_MAX_BYTES) {
    return { queue: current, accepted: false, coalesced: false, reason: 'byte_limit' };
  }
  return { queue: next, accepted: true, coalesced: false };
}

export function updateCollaborationQueueItem(
  queue: CollaborationQueueItem[],
  itemId: string,
  patch: Partial<Omit<CollaborationQueueItem, 'id' | 'operation'>>,
) {
  const next = queue.map((item) => {
    if (item.id !== itemId) return item;
    const candidate = {
      ...item,
      ...patch,
      ...(typeof patch.error === 'string' ? { error: patch.error.slice(0, 1000) } : {}),
    };
    return validQueueItem(candidate) ? candidate : item;
  });
  return validCollaborationQueue(next) ? next : queue;
}

export function removeCollaborationQueueItem(queue: CollaborationQueueItem[], itemId: string) {
  if (!validCollaborationQueue(queue) || typeof itemId !== 'string') return queue;
  return queue.filter((item) => item.id !== itemId);
}

export function firstCollaborationQueueItemForReplay(queue: CollaborationQueueItem[]) {
  if (!validCollaborationQueue(queue)) return null;
  const first = queue[0];
  return first?.status === 'pending' ? first : null;
}

export function freezeCollaborationQueue(
  queue: CollaborationQueueItem[],
  reason: string,
) {
  const error = String(reason || '协作队列作用域已经变化，操作已冻结。').slice(0, 1000);
  return queue.map((item) => item.status === 'blocked' ? cloneJson(item) : {
    ...cloneJson(item),
    status: 'blocked' as const,
    ambiguous: item.ambiguous || item.status === 'inflight',
    error,
  });
}

export function loadCollaborationQueue(
  storage: QueueStorage | null,
  key: string,
  scope: CollaborationQueueScope,
) {
  if (!storage) return { queue: [] as CollaborationQueueItem[], rejected: 0 };
  if (!validCollaborationQueueScope(scope) || key !== collaborationQueueStorageKey(scope)) {
    return { queue: [] as CollaborationQueueItem[], rejected: 1 };
  }
  try {
    const raw = storage.getItem(key);
    if (!raw) return { queue: [] as CollaborationQueueItem[], rejected: 0 };
    if (new TextEncoder().encode(raw).byteLength > COLLABORATION_QUEUE_MAX_BYTES * 2) {
      return { queue: [] as CollaborationQueueItem[], rejected: 1 };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)
      || !hasOnlyKeys(parsed, ['version', 'scope', 'items'])
      || parsed.version !== COLLABORATION_QUEUE_STORAGE_VERSION
      || !validCollaborationQueueScope(parsed.scope)
      || !sameScope(parsed.scope, scope)
      || !Array.isArray(parsed.items)) {
      return { queue: [] as CollaborationQueueItem[], rejected: 1 };
    }
    const seen = new Set<string>();
    const accepted: CollaborationQueueItem[] = [];
    let rejected = 0;
    for (const rawItem of parsed.items) {
      if (!validQueueItem(rawItem)
        || seen.has(rawItem.operation.opId)
        || accepted.length >= COLLABORATION_QUEUE_MAX_OPERATIONS) {
        rejected += 1;
        continue;
      }
      const restored = cloneJson(rawItem);
      if (restored.status === 'inflight') {
        restored.status = 'pending';
        restored.ambiguous = true;
      }
      const candidate = [...accepted, restored];
      if (collaborationQueueBytes(candidate) > COLLABORATION_QUEUE_MAX_BYTES) {
        rejected += 1;
        continue;
      }
      seen.add(restored.operation.opId);
      accepted.push(restored);
    }
    return { queue: accepted, rejected };
  } catch {
    return { queue: [] as CollaborationQueueItem[], rejected: 1 };
  }
}

export function saveCollaborationQueue(
  storage: QueueStorage | null,
  key: string,
  scope: CollaborationQueueScope,
  queue: CollaborationQueueItem[],
) {
  if (!storage
    || !validCollaborationQueueScope(scope)
    || key !== collaborationQueueStorageKey(scope)
    || !validCollaborationQueue(queue)) return false;
  try {
    if (!queue.length) {
      storage.removeItem(key);
      return true;
    }
    storage.setItem(key, JSON.stringify({
      version: COLLABORATION_QUEUE_STORAGE_VERSION,
      scope,
      items: queue,
    }));
    return true;
  } catch {
    return false;
  }
}

export function pendingNodeMoveOverrides(queue: CollaborationQueueItem[]) {
  const positions = new Map<string, { x: number; y: number }>();
  for (const item of queue) {
    if (item.status === 'blocked') continue;
    positions.set(item.operation.payload.nodeId, cloneJson(item.operation.payload.position));
  }
  return positions;
}
