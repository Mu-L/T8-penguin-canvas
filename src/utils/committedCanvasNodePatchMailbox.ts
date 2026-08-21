import { isCanonicalEntityUid } from './canvasEntityIdentity.ts';

const COMMITTED_CANVAS_NODE_PATCH_LIMIT = 200;
const UNSAFE_PATCH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface CommittedCanvasNodePatch {
  canvasId: string;
  nodeId: string;
  entityUid: string;
  revision: number;
  dataPatch: Record<string, unknown>;
}

type PatchableCanvasNode = {
  entityUid?: unknown;
  data?: unknown;
};

const committedPatches = new Map<string, CommittedCanvasNodePatch>();

function mailboxKey(canvasId: string, entityUid: string) {
  return `${canvasId}::${entityUid}`;
}

function cloneDataPatch(value: Record<string, unknown>) {
  const serialized = JSON.parse(JSON.stringify(value)) as unknown;
  if (!serialized || typeof serialized !== 'object' || Array.isArray(serialized)) {
    throw new Error('后台节点结果必须是可序列化对象');
  }
  return Object.fromEntries(
    Object.entries(serialized as Record<string, unknown>)
      .filter(([key]) => !UNSAFE_PATCH_KEYS.has(key)),
  );
}

export function recordCommittedCanvasNodePatch(
  input: CommittedCanvasNodePatch,
): CommittedCanvasNodePatch | null {
  const canvasId = String(input.canvasId || '').trim();
  const nodeId = String(input.nodeId || '').trim();
  if (!canvasId || !nodeId || !isCanonicalEntityUid(input.entityUid)) return null;
  const revision = Number(input.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  const entityUid = input.entityUid.toLowerCase();
  const key = mailboxKey(canvasId, entityUid);
  const previous = committedPatches.get(key);
  if (previous && revision < previous.revision) return previous;
  const entry: CommittedCanvasNodePatch = {
    canvasId,
    nodeId,
    entityUid,
    revision,
    dataPatch: {
      ...(previous?.dataPatch || {}),
      ...cloneDataPatch(input.dataPatch),
    },
  };
  committedPatches.delete(key);
  committedPatches.set(key, entry);
  while (committedPatches.size > COMMITTED_CANVAS_NODE_PATCH_LIMIT) {
    const oldestKey = committedPatches.keys().next().value as string | undefined;
    if (!oldestKey) break;
    committedPatches.delete(oldestKey);
  }
  return entry;
}

export function readCommittedCanvasNodePatches(canvasId: string): CommittedCanvasNodePatch[] {
  const targetCanvasId = String(canvasId || '').trim();
  if (!targetCanvasId) return [];
  return [...committedPatches.values()]
    .filter((entry) => entry.canvasId === targetCanvasId)
    .sort((left, right) => left.revision - right.revision);
}

export function consumeCommittedCanvasNodePatches(
  canvasId: string,
  throughRevision: number,
) {
  for (const [key, entry] of committedPatches) {
    if (entry.canvasId === canvasId && entry.revision <= throughRevision) {
      committedPatches.delete(key);
    }
  }
}

export function applyCommittedCanvasNodePatches<TNode extends PatchableCanvasNode>(
  nodes: TNode[],
  patches: CommittedCanvasNodePatch[],
): { nodes: TNode[]; appliedEntityUids: string[] } {
  if (patches.length === 0) return { nodes, appliedEntityUids: [] };
  const patchByEntityUid = new Map(patches.map((entry) => [entry.entityUid, entry.dataPatch]));
  const appliedEntityUids: string[] = [];
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (!isCanonicalEntityUid(node.entityUid)) return node;
    const entityUid = node.entityUid.toLowerCase();
    const dataPatch = patchByEntityUid.get(entityUid);
    if (!dataPatch) return node;
    changed = true;
    appliedEntityUids.push(entityUid);
    const currentData = node.data && typeof node.data === 'object' && !Array.isArray(node.data)
      ? node.data as Record<string, unknown>
      : {};
    return {
      ...node,
      data: { ...currentData, ...dataPatch },
    };
  });
  return {
    nodes: changed ? nextNodes : nodes,
    appliedEntityUids,
  };
}

export function resetCommittedCanvasNodePatchMailboxForTests() {
  committedPatches.clear();
}
