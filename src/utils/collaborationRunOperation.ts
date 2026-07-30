export interface CollaborationRunOperationScope {
  projectId: string;
  canvasId: string;
  memberId: string;
}

export interface CollaborationRunOperation extends CollaborationRunOperationScope {
  schema: 't8-collaboration-run-operation-v1';
  canvasRevision: number;
  nodeIds: string[];
  idempotencyKey: string;
  createdAt: number;
}

const RUN_OPERATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function normalizedScope(value: CollaborationRunOperationScope): CollaborationRunOperationScope {
  return {
    projectId: String(value.projectId || '').trim(),
    canvasId: String(value.canvasId || '').trim(),
    memberId: String(value.memberId || '').trim(),
  };
}

function normalizedNodeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0 && item.length <= 240))]
    .sort((left, right) => left.localeCompare(right));
}

export function collaborationRunOperationStorageKey(scope: CollaborationRunOperationScope) {
  const normalized = normalizedScope(scope);
  return [
    't8-collab-run-operation-v1',
    encodeURIComponent(normalized.projectId),
    encodeURIComponent(normalized.canvasId),
    encodeURIComponent(normalized.memberId),
  ].join(':');
}

export function readCollaborationRunOperation(
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null,
  scope: CollaborationRunOperationScope,
  now = Date.now(),
): CollaborationRunOperation | null {
  if (!storage) return null;
  const key = collaborationRunOperationStorageKey(scope);
  try {
    const parsed = JSON.parse(String(storage.getItem(key) || 'null')) as Partial<CollaborationRunOperation> | null;
    const normalized = normalizedScope(scope);
    const valid = parsed?.schema === 't8-collaboration-run-operation-v1'
      && parsed.projectId === normalized.projectId
      && parsed.canvasId === normalized.canvasId
      && parsed.memberId === normalized.memberId
      && Number.isSafeInteger(parsed.canvasRevision)
      && Number(parsed.canvasRevision) >= 1
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(String(parsed.idempotencyKey || ''))
      && Number.isFinite(Number(parsed.createdAt))
      && Number(parsed.createdAt) > 0
      && Number(parsed.createdAt) <= now + 60_000
      && now - Number(parsed.createdAt) <= RUN_OPERATION_MAX_AGE_MS
      && Array.isArray(parsed.nodeIds)
      && normalizedNodeIds(parsed.nodeIds).length === parsed.nodeIds.length;
    if (!valid) {
      storage.removeItem(key);
      return null;
    }
    return {
      schema: 't8-collaboration-run-operation-v1',
      ...normalized,
      canvasRevision: Number(parsed.canvasRevision),
      nodeIds: normalizedNodeIds(parsed.nodeIds),
      idempotencyKey: String(parsed.idempotencyKey),
      createdAt: Number(parsed.createdAt),
    };
  } catch {
    try { storage.removeItem(key); } catch { /* storage may be unavailable */ }
    return null;
  }
}

export function beginCollaborationRunOperation(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
  scope: CollaborationRunOperationScope,
  canvasRevision: number,
  nodeIds: string[],
  options: { now?: number; randomUUID?: () => string } = {},
): CollaborationRunOperation {
  const now = Math.max(1, Math.trunc(options.now ?? Date.now()));
  const normalized = normalizedScope(scope);
  const normalizedNodes = normalizedNodeIds(nodeIds);
  const existing = readCollaborationRunOperation(storage, normalized, now);
  if (existing
    && existing.canvasRevision === canvasRevision
    && JSON.stringify(existing.nodeIds) === JSON.stringify(normalizedNodes)) {
    return existing;
  }
  const uuid = String(options.randomUUID?.()
    || globalThis.crypto?.randomUUID?.()
    || `${now.toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`)
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .slice(0, 120);
  const operation: CollaborationRunOperation = {
    schema: 't8-collaboration-run-operation-v1',
    ...normalized,
    canvasRevision,
    nodeIds: normalizedNodes,
    idempotencyKey: `remote:${uuid}`,
    createdAt: now,
  };
  if (storage) {
    storage.setItem(collaborationRunOperationStorageKey(normalized), JSON.stringify(operation));
  }
  return operation;
}

export function completeCollaborationRunOperation(
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null,
  scope: CollaborationRunOperationScope,
  idempotencyKey: string,
) {
  if (!storage) return;
  const current = readCollaborationRunOperation(storage, scope);
  if (current?.idempotencyKey !== idempotencyKey) return;
  storage.removeItem(collaborationRunOperationStorageKey(scope));
}
