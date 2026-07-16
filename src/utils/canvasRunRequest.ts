export const CANVAS_NODE_RUN_REQUEST_EVENT = 't8:canvas-node-run-request' as const;

export interface CanvasNodeRunRequestDetail {
  nodeId: string;
  requestId?: string;
}

const RUN_REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,160}$/;

export function createCanvasNodeRunRequestId(nodeId: string, purpose: string): string {
  const safeNodeId = String(nodeId || 'node').replace(/[^a-zA-Z0-9._:-]+/g, '-').slice(0, 48) || 'node';
  const safePurpose = String(purpose || 'run').replace(/[^a-zA-Z0-9._:-]+/g, '-').slice(0, 32) || 'run';
  const entropy = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  return `${safePurpose}:${safeNodeId}:${entropy}`.slice(0, 160);
}

/**
 * Ask the owning Canvas to run one node through its persisted Run + preflight
 * pipeline. Node components must not call the run bus or their provider handler
 * from a primary idle action.
 */
export function requestCanvasNodeRun(nodeId: string, options: { requestId?: string } = {}): boolean {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId || typeof window === 'undefined') return false;
  const requestId = String(options.requestId || '').trim();
  if (requestId && !RUN_REQUEST_ID_PATTERN.test(requestId)) return false;

  window.dispatchEvent(new CustomEvent<CanvasNodeRunRequestDetail>(CANVAS_NODE_RUN_REQUEST_EVENT, {
    detail: { nodeId: normalizedNodeId, ...(requestId ? { requestId } : {}) },
  }));
  return true;
}
