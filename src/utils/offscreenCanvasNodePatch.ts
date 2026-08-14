import type { CanvasData } from '../types/canvas.ts';
import type { CanvasOperation } from '../types/project.ts';
import { authoritativeCanvasRevision } from './canvasLoadAuthority.ts';
import { createCanvasEntityUid, isCanonicalEntityUid } from './canvasEntityIdentity.ts';

type CanvasNodeLike = {
  id?: unknown;
  entityUid?: unknown;
};

export interface OffscreenCanvasNodePatchClient {
  getCanvasData(canvasId: string): Promise<CanvasData>;
  applyCanvasOperations(
    canvasId: string,
    operations: CanvasOperation[],
    baseRevision: number,
  ): Promise<{ document: CanvasData }>;
  isRevisionConflict(error: unknown): boolean;
}

export interface OffscreenCanvasNodePatchInput {
  canvasId: string;
  nodeId: string;
  entityUid?: string | null;
  dataPatch: Record<string, unknown>;
}

export interface OffscreenCanvasNodePatchResult {
  applied: boolean;
  document: CanvasData | null;
  operation: CanvasOperation | null;
}

function cloneDataPatch(dataPatch: Record<string, unknown>): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(dataPatch)) as unknown;
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new Error('离屏节点更新必须是可序列化对象');
  }
  return cloned as Record<string, unknown>;
}

function findTargetNode(
  document: CanvasData,
  nodeId: string,
  capturedEntityUid?: string | null,
): CanvasNodeLike | null {
  const nodes = Array.isArray(document.nodes) ? document.nodes as CanvasNodeLike[] : [];
  if (isCanonicalEntityUid(capturedEntityUid)) {
    return nodes.find((node) => node?.entityUid === capturedEntityUid) || null;
  }
  return nodes.find((node) => node?.id === nodeId) || null;
}

function createPatchOperation(
  input: OffscreenCanvasNodePatchInput,
  target: CanvasNodeLike,
): CanvasOperation {
  const operationUid = createCanvasEntityUid();
  const targetIdentity = isCanonicalEntityUid(input.entityUid)
    ? input.entityUid
    : isCanonicalEntityUid(target.entityUid)
      ? target.entityUid
      : input.nodeId;
  return {
    opId: `background-node-patch-${operationUid}`,
    canvasId: input.canvasId,
    actorId: 'local-owner',
    sessionId: `background-node-run-${operationUid}`,
    clientSeq: 0,
    timestamp: Date.now(),
    type: 'node.patch',
    payload: {
      nodeId: targetIdentity,
      dataPatch: cloneDataPatch(input.dataPatch),
    },
  };
}

function requireRevision(document: CanvasData): number {
  const revision = authoritativeCanvasRevision(document.revision);
  if (revision === null) throw new Error('离屏节点更新缺少权威画布 revision');
  return revision;
}

/**
 * Applies a background node result to its origin canvas without replacing the
 * whole document. The operation identity and dataPatch stay stable across the
 * single allowed CAS retry. A captured entityUid prevents an old run from
 * patching a newly-created node that reused the same visible id.
 */
export async function applyOffscreenCanvasNodePatch(
  input: OffscreenCanvasNodePatchInput,
  client: OffscreenCanvasNodePatchClient,
): Promise<OffscreenCanvasNodePatchResult> {
  const firstDocument = await client.getCanvasData(input.canvasId);
  const firstTarget = findTargetNode(firstDocument, input.nodeId, input.entityUid);
  if (!firstTarget) return { applied: false, document: null, operation: null };

  const operation = createPatchOperation(input, firstTarget);
  const frozenEntityUid = isCanonicalEntityUid(input.entityUid)
    ? input.entityUid
    : isCanonicalEntityUid(firstTarget.entityUid)
      ? firstTarget.entityUid
      : null;

  try {
    const result = await client.applyCanvasOperations(
      input.canvasId,
      [operation],
      requireRevision(firstDocument),
    );
    return { applied: true, document: result.document, operation };
  } catch (error) {
    if (!client.isRevisionConflict(error)) throw error;
  }

  const latestDocument = await client.getCanvasData(input.canvasId);
  const latestTarget = findTargetNode(latestDocument, input.nodeId, frozenEntityUid);
  if (!latestTarget) return { applied: false, document: null, operation };
  const retried = await client.applyCanvasOperations(
    input.canvasId,
    [operation],
    requireRevision(latestDocument),
  );
  return { applied: true, document: retried.document, operation };
}
