import { useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useRef } from 'react';
import * as api from '../../services/api';
import { useCanvasStore } from '../../stores/canvas';
import { isCanonicalEntityUid } from '../../utils/canvasEntityIdentity';
import { isCanvasNodeDeleted } from '../../utils/deletedNodeRegistry';
import { applyOffscreenCanvasNodePatch } from '../../utils/offscreenCanvasNodePatch';
import { recordCommittedCanvasNodePatch } from '../../utils/committedCanvasNodePatchMailbox';

const offscreenPatchQueues = new Map<string, Promise<void>>();

function reportOffscreenCanvasPatchFailure(canvasId: string, nodeId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  console.error(`离屏画布节点结果保存失败 (${canvasId}/${nodeId})`, error);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('penguin:canvas-background-save-error', {
      detail: { canvasId, nodeId, message },
    }));
  }
}

function enqueueOffscreenCanvasPatch(
  canvasId: string,
  nodeId: string,
  entityUid: string | null,
  patch: Record<string, any>,
  notifyCompletion = false,
) {
  const key = `${canvasId}::${entityUid || nodeId}`;
  const prev = offscreenPatchQueues.get(key) || Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      if (isCanvasNodeDeleted(canvasId, nodeId)) return;
      const result = await applyOffscreenCanvasNodePatch({
        canvasId,
        nodeId,
        entityUid,
        dataPatch: patch,
      }, {
        getCanvasData: api.getCanvasData,
        applyCanvasOperations: api.applyCanvasOperations,
        isRevisionConflict: (error) => error instanceof api.ApiRequestError && error.status === 409,
      });
      if (!result.applied || !result.document) return;
      const committedDataPatch = result.operation?.payload?.dataPatch;
      const mailboxEntry = recordCommittedCanvasNodePatch({
        canvasId,
        nodeId,
        entityUid: entityUid || '',
        revision: Number(result.document.revision),
        dataPatch: committedDataPatch && typeof committedDataPatch === 'object' && !Array.isArray(committedDataPatch)
          ? committedDataPatch as Record<string, unknown>
          : patch,
      });
      if (mailboxEntry && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('penguin:canvas-background-node-patched', {
          detail: {
            canvasId,
            nodeId,
            entityUid,
            revision: result.document.revision,
            dataPatch: mailboxEntry.dataPatch,
            document: result.document,
          },
        }));
      }
      api.autoSaveCanvasData(canvasId, result.document).catch((e) => {
        console.warn('离屏画布自动保存到本地路径失败', e);
      });
      if (notifyCompletion) {
        useCanvasStore.getState().markCanvasCompletionNotice(canvasId);
      }
    });
  const settled = next.catch((error) => {
    reportOffscreenCanvasPatchFailure(canvasId, nodeId, error);
  });
  const queued = settled.finally(() => {
    if (offscreenPatchQueues.get(key) === queued) {
      offscreenPatchQueues.delete(key);
    }
  });
  offscreenPatchQueues.set(key, queued);
}

function isCompletedCanvasPatch(patch: Record<string, any>) {
  const status = typeof patch?.status === 'string' ? patch.status.toLowerCase() : '';
  const taskStatus = typeof patch?.taskStatus === 'string' ? patch.taskStatus.toLowerCase() : '';
  return status === 'success' || status === 'completed' || taskStatus === 'completed';
}

/**
 * 用于在节点内部更新自身 data 的 hook
 * 通过 reactflow 的 setNodes 接口更新指定 id 的节点
 * 如果节点运行期间用户切换到其他画布，则按节点挂载时的画布 id
 * 用 node.patch CAS 写回原画布，并同步保留原 provider 的终态。
 */
export function useUpdateNodeData(nodeId: string) {
  const { getNode, setNodes } = useReactFlow();
  const originCanvasIdRef = useRef(useCanvasStore.getState().activeId);
  const originNodeEntityUidRef = useRef<string | null>(null);
  const originProviderMountedRef = useRef(true);

  useEffect(() => {
    originProviderMountedRef.current = true;
    return () => { originProviderMountedRef.current = false; };
  }, []);

  return useCallback(
    (patch: Record<string, any>) => {
      const originCanvasId = originCanvasIdRef.current;
      const activeCanvasId = useCanvasStore.getState().activeId;
      const mountedNode = getNode(nodeId) as { entityUid?: unknown } | undefined;
      if (!originNodeEntityUidRef.current && isCanonicalEntityUid(mountedNode?.entityUid)) {
        originNodeEntityUidRef.current = mountedNode.entityUid.toLowerCase();
      }
      const entityUid = originNodeEntityUidRef.current;
      const queueKey = originCanvasId ? `${originCanvasId}::${entityUid || nodeId}` : '';
      const hasPendingOffscreenPatch = queueKey ? offscreenPatchQueues.has(queueKey) : false;
      const originProviderDetached = !originProviderMountedRef.current;

      // This hook stays alive with the origin ReactFlow provider while an async
      // run finishes. Keep that provider's node state current so terminal status
      // checks never read the newly-active canvas with the same visible node id.
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...(n.data as any), ...patch } }
            : n
        )
      );
      if (originCanvasId && (
        originProviderDetached
        || activeCanvasId !== originCanvasId
        || hasPendingOffscreenPatch
      )) {
        enqueueOffscreenCanvasPatch(
          originCanvasId,
          nodeId,
          entityUid,
          patch,
          (originProviderDetached || activeCanvasId !== originCanvasId) && isCompletedCanvasPatch(patch),
        );
      }
    },
    [getNode, nodeId, setNodes]
  );
}
