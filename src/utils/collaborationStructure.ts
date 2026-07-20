import type { Connection, Edge, Node } from '@xyflow/react';
import type { CanvasOperationType, VersionedCanvasData } from '../types/project';

export const COLLABORATION_DRAG_PREVIEW_INTERVAL_MS = 100;

export interface CollaborationOperationDraft {
  type: CanvasOperationType;
  payload: Record<string, unknown>;
}

export interface CollaborationDragPreview {
  nodeId: string;
  dragId: string;
  seq: number;
  position: { x: number; y: number };
}

export interface CollaborationPresenceValue {
  cursor?: { x: number; y: number };
  selectedNodeIds?: string[];
  drag?: CollaborationDragPreview;
}

function safeIdentity(value: unknown) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value);
}

function finitePosition(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const position = value as { x?: unknown; y?: unknown };
  return typeof position.x === 'number'
    && Number.isFinite(position.x)
    && Math.abs(position.x) <= 10_000_000
    && typeof position.y === 'number'
    && Number.isFinite(position.y)
    && Math.abs(position.y) <= 10_000_000;
}

export function shouldSendCollaborationDragPreview(
  lastSentAt: number,
  now: number,
  intervalMs = COLLABORATION_DRAG_PREVIEW_INTERVAL_MS,
) {
  return Number.isFinite(now)
    && now >= 0
    && (!Number.isFinite(lastSentAt) || now - lastSentAt >= Math.max(100, intervalMs));
}

export function collaborationPresenceWithDrag(
  current: CollaborationPresenceValue,
  drag: CollaborationDragPreview | null,
): CollaborationPresenceValue {
  if (!drag) {
    const { drag: _drag, ...rest } = current;
    return rest;
  }
  if (!safeIdentity(drag.nodeId)
    || !safeIdentity(drag.dragId)
    || !Number.isSafeInteger(drag.seq)
    || drag.seq < 0
    || !finitePosition(drag.position)) throw new Error('协作拖动预览无效');
  return {
    ...current,
    drag: {
      nodeId: drag.nodeId,
      dragId: drag.dragId,
      seq: drag.seq,
      position: { x: drag.position.x, y: drag.position.y },
    },
  };
}

export function collaborationEdgeAddDraft(
  connection: Connection,
  edgeId: string,
): CollaborationOperationDraft {
  if (!safeIdentity(edgeId) || !safeIdentity(connection.source) || !safeIdentity(connection.target)) {
    throw new Error('协作连线身份无效');
  }
  return {
    type: 'edge.add',
    payload: {
      edge: {
        id: edgeId,
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle ?? null,
        targetHandle: connection.targetHandle ?? null,
        type: 'default',
      },
    },
  };
}

export function collaborationDeleteDrafts(
  nodes: Array<Pick<Node, 'id'>>,
  edges: Array<Pick<Edge, 'id' | 'source' | 'target'>>,
): CollaborationOperationDraft[] {
  const deletedNodeIds = new Set(nodes.map((node) => String(node.id)).filter(safeIdentity));
  const drafts: CollaborationOperationDraft[] = [...deletedNodeIds].map((nodeId) => ({
    type: 'node.delete',
    payload: { nodeId },
  }));
  const deletedEdgeIds = new Set<string>();
  for (const edge of edges) {
    const edgeId = String(edge.id || '');
    if (!safeIdentity(edgeId)
      || deletedEdgeIds.has(edgeId)
      || deletedNodeIds.has(String(edge.source))
      || deletedNodeIds.has(String(edge.target))) continue;
    deletedEdgeIds.add(edgeId);
    drafts.push({ type: 'edge.delete', payload: { edgeId } });
  }
  return drafts;
}

export function collaborationTextNodeAddDraft(
  nodeId: string,
  position: { x: number; y: number },
): CollaborationOperationDraft {
  if (!safeIdentity(nodeId) || !finitePosition(position)) throw new Error('协作节点身份或位置无效');
  return {
    type: 'node.add',
    payload: {
      node: {
        id: nodeId,
        type: 'text',
        position: { x: position.x, y: position.y },
        data: { text: '', label: '协作文本' },
      },
    },
  };
}

export function collaborationNodeLabelPatchDraft(
  nodeId: string,
  label: string,
): CollaborationOperationDraft {
  if (!safeIdentity(nodeId) || typeof label !== 'string' || label.length > 500) {
    throw new Error('协作节点标题无效');
  }
  return {
    type: 'node.patch',
    payload: { nodeId, dataPatch: { label } },
  };
}

export function collaborationRestoreNodeDraft(
  nodeId: string,
  tombstone: Record<string, unknown>,
  position: { x: number; y: number },
): CollaborationOperationDraft {
  const entityUid = tombstone.entityUid;
  const type = tombstone.entityType;
  if (!safeIdentity(nodeId) || !safeIdentity(entityUid) || !safeIdentity(type) || !finitePosition(position)) {
    throw new Error('节点 tombstone 缺少可验证恢复身份');
  }
  return {
    type: 'node.restore',
    payload: {
      node: {
        id: nodeId,
        entityUid,
        type,
        position: { x: position.x, y: position.y },
        data: {},
      },
    },
  };
}

export function collaborationRestoreEdgeDraft(
  edgeId: string,
  tombstone: Record<string, unknown>,
): CollaborationOperationDraft {
  const entityUid = tombstone.entityUid;
  const source = tombstone.source;
  const target = tombstone.target;
  if (!safeIdentity(edgeId) || !safeIdentity(entityUid) || !safeIdentity(source) || !safeIdentity(target)) {
    throw new Error('连线 tombstone 缺少可验证恢复身份');
  }
  const hasSourceHandle = Object.prototype.hasOwnProperty.call(tombstone, 'sourceHandle');
  const hasTargetHandle = Object.prototype.hasOwnProperty.call(tombstone, 'targetHandle');
  const sourceHandle = tombstone.sourceHandle == null ? null : tombstone.sourceHandle;
  const targetHandle = tombstone.targetHandle == null ? null : tombstone.targetHandle;
  if ((hasSourceHandle && sourceHandle !== null && !safeIdentity(sourceHandle))
    || (hasTargetHandle && targetHandle !== null && !safeIdentity(targetHandle))) {
    throw new Error('连线 tombstone 的 Handle 身份无效');
  }
  return {
    type: 'edge.restore',
    payload: {
      edge: {
        id: edgeId,
        entityUid,
        source,
        target,
        type: tombstone.entityType == null ? 'default' : String(tombstone.entityType),
        ...(hasSourceHandle ? { sourceHandle } : {}),
        ...(hasTargetHandle ? { targetHandle } : {}),
      },
    },
  };
}

export function collaborationRemoteDragPositions(
  document: VersionedCanvasData,
  presences: Iterable<CollaborationPresenceValue>,
  excludedNodeIds: Iterable<string> = [],
) {
  const knownNodeIds = new Set(document.nodes.map((node) => String(node.id)));
  const excluded = new Set(excludedNodeIds);
  const positions = new Map<string, { x: number; y: number }>();
  for (const presence of presences) {
    const drag = presence.drag;
    if (!drag
      || excluded.has(drag.nodeId)
      || !knownNodeIds.has(drag.nodeId)
      || !finitePosition(drag.position)) continue;
    positions.set(drag.nodeId, { x: drag.position.x, y: drag.position.y });
  }
  return positions;
}
