import { create } from 'zustand';
import { taskCompletionSound } from './taskCompletionSound';
import type { RunContext } from '../types/project';

/**
 * 批量运行总线
 * - currentRunId：单点模式指示，内部使用 canvasId + nodeId 作用域键
 * - runningIds：并发运行中的作用域节点集合
 * - executionTokens：每个作用域节点当前唯一的执行令牌；同画布 nodeId 重触发也必须换新令牌
 * - lastDone：最后一次被当前令牌接受的完成信息
 * - triggerRun(id)：单点调度并返回本次 execution token
 * - triggerRunMany(ids)：并发调度并返回每个节点的 execution token
 * - markDone(id, token, ok)：仅当前 token 可完成节点，旧任务完成会被忽略
 * - cancelAll()：取消全部 (广播本轮 cancelTargets/cancelSeq，再清空运行节点和令牌)
 *
 * 调用兼容保证：triggerRun/triggerRunMany 仍接收画布内 nodeId，批量返回值仍以原 nodeId 索引。
 */

export interface LastDoneInfo {
  id: string;
  executionToken: string;
  ok: boolean;
  ts: number;
  error?: string;
}

const CANVAS_NODE_EXECUTION_KEY_SEPARATOR = '\u001f';

/**
 * Run-bus state is process-global while display node ids are only unique inside
 * one canvas. Scope provider execution state so Story #1 on two canvases does
 * not share a lock, token, completion or cancellation target.
 */
export function createCanvasNodeExecutionKey(canvasId: string | null | undefined, nodeId: string): string {
  const normalizedNodeId = String(nodeId || '').trim();
  const normalizedCanvasId = String(canvasId || '').trim();
  return normalizedCanvasId
    ? `${normalizedCanvasId}${CANVAS_NODE_EXECUTION_KEY_SEPARATOR}${normalizedNodeId}`
    : normalizedNodeId;
}

export function parseCanvasNodeExecutionKey(executionNodeId: string): {
  canvasId: string | null;
  nodeId: string;
} {
  const normalizedExecutionNodeId = String(executionNodeId || '');
  const separatorIndex = normalizedExecutionNodeId.indexOf(CANVAS_NODE_EXECUTION_KEY_SEPARATOR);
  if (separatorIndex < 0) return { canvasId: null, nodeId: normalizedExecutionNodeId };
  return {
    canvasId: normalizedExecutionNodeId.slice(0, separatorIndex) || null,
    nodeId: normalizedExecutionNodeId.slice(separatorIndex + CANVAS_NODE_EXECUTION_KEY_SEPARATOR.length),
  };
}

export function runContextNodeExecutionKey(nodeId: string, context: RunContext | null | undefined): string {
  return createCanvasNodeExecutionKey(context?.canvasId, nodeId);
}

interface RunBusState {
  activeRunId: string | null;
  activeRunContext: RunContext | null;
  activeNodeRunIds: Record<string, string>;
  activeNodeRunTokens: Record<string, string>;
  currentRunId: string | null;
  runningIds: string[];
  executionTokens: Record<string, string>;
  lastDone: LastDoneInfo | null;
  cancelSeq: number;
  cancelTargets: string[];
  // 0=空闲, 1=单节点运行中, 2=批量运行中
  mode: 'idle' | 'single' | 'batch';
  batchTotal: number;
  batchDoneCount: number;
  triggerRun: (id: string, mode?: 'single' | 'batch', runContext?: RunContext | null) => string;
  triggerRunMany: (ids: string[], mode?: 'single' | 'batch', runContext?: RunContext | null) => Record<string, string>;
  markDone: (id: string, executionToken: string, ok: boolean, error?: string) => boolean;
  cancelAll: () => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  setBatchProgress: (total: number, done: number) => void;
  setActiveRun: (runId: string | null) => void;
  setActiveRunContext: (context: RunContext | null) => void;
  clearActiveRunContext: (runId: string) => void;
  setActiveNodeRun: (nodeId: string, nodeRunId: string | undefined, executionToken: string) => void;
}

let executionTokenSequence = 0;
const executionTokenSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function createRunExecutionToken(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `run-${randomUuid}`;
  executionTokenSequence += 1;
  return `run-${executionTokenSession}-${executionTokenSequence.toString(36)}`;
}

export function matchesRunCompletion(
  completion: LastDoneInfo | null | undefined,
  nodeId: string,
  executionToken: string | null | undefined,
): completion is LastDoneInfo {
  return Boolean(
    executionToken
    && completion
    && completion.id === nodeId
    && completion.executionToken === executionToken,
  );
}

export interface RunNodeExecutionContext {
  subflowPath: string[];
  originalNodeId: string;
  runNodeId?: string;
  definitionId?: string;
  definitionVersion?: number;
  inputSnapshot: Record<string, unknown>;
  parentNodeRunId?: string;
}

const runNodeExecutionContexts = new Map<string, RunNodeExecutionContext>();

export function registerRunNodeExecutionContexts(contexts: Record<string, RunNodeExecutionContext>) {
  for (const [nodeId, context] of Object.entries(contexts)) runNodeExecutionContexts.set(nodeId, context);
  return () => {
    for (const [nodeId, context] of Object.entries(contexts)) {
      if (runNodeExecutionContexts.get(nodeId) === context) runNodeExecutionContexts.delete(nodeId);
    }
  };
}

export function getRunNodeExecutionContext(nodeId: string) {
  return runNodeExecutionContexts.get(nodeId) || null;
}

export interface RunExecutionBinding {
  /** Canvas-scoped runtime key used by the process-global run bus. */
  nodeId: string;
  /** Stable display id recorded in Run/NodeRun evidence. */
  originalNodeId: string;
  executionToken: string;
  mode: 'single' | 'batch';
  runContext: RunContext | null;
  nodeContext: RunNodeExecutionContext | null;
  issuedAt: number;
}

type RunExecutionCancelHandler = () => void | Promise<void>;

const runExecutionBindings = new Map<string, RunExecutionBinding>();
const cancelledRunExecutionTokens = new Set<string>();
const runExecutionCancelHandlers = new Map<string, { nodeId: string; handler: RunExecutionCancelHandler }>();

function cloneRecord(value: Record<string, unknown>) {
  try {
    return structuredClone(value);
  } catch {
    return { ...value };
  }
}

function cloneRunContext(context: RunContext | null): RunContext | null {
  if (!context) return null;
  return {
    ...context,
    plannedNodeIds: [...context.plannedNodeIds],
    authorizedNodeIds: context.authorizedNodeIds ? [...context.authorizedNodeIds] : undefined,
  };
}

function assertNodeAuthorizedByRunContext(context: RunContext | null, nodeId: string) {
  if (!context) return;
  if (!Array.isArray(context.authorizedNodeIds) || !context.authorizedNodeIds.includes(nodeId)) {
    throw new Error(`节点 ${nodeId} 不在最终体检授权范围内，已停止签发执行令牌`);
  }
}

function cloneNodeExecutionContext(context: RunNodeExecutionContext | null): RunNodeExecutionContext | null {
  if (!context) return null;
  return {
    ...context,
    subflowPath: [...context.subflowPath],
    inputSnapshot: cloneRecord(context.inputSnapshot),
  };
}

function bindRunExecution(
  nodeId: string,
  executionToken: string,
  mode: 'single' | 'batch',
  runContext: RunContext | null,
) {
  const executionNodeId = runContextNodeExecutionKey(nodeId, runContext);
  cancelledRunExecutionTokens.delete(executionToken);
  runExecutionBindings.set(executionToken, {
    nodeId: executionNodeId,
    originalNodeId: nodeId,
    executionToken,
    mode,
    runContext: cloneRunContext(runContext),
    nodeContext: cloneNodeExecutionContext(getRunNodeExecutionContext(nodeId)),
    issuedAt: Date.now(),
  });
  return executionNodeId;
}

export function getRunExecutionBinding(nodeId: string, executionToken: string): RunExecutionBinding | null {
  const binding = runExecutionBindings.get(executionToken);
  if (!binding || (binding.nodeId !== nodeId && binding.originalNodeId !== nodeId)) return null;
  return binding;
}

export function isRunExecutionCancelled(executionToken: string) {
  return cancelledRunExecutionTokens.has(executionToken);
}

export function registerRunExecutionCancelHandler(
  nodeId: string,
  executionToken: string,
  handler: RunExecutionCancelHandler,
) {
  const executionNodeId = getRunExecutionBinding(nodeId, executionToken)?.nodeId || nodeId;
  const entry = { nodeId: executionNodeId, handler };
  runExecutionCancelHandlers.set(executionToken, entry);
  if (cancelledRunExecutionTokens.has(executionToken)) {
    void Promise.resolve()
      .then(handler)
      .catch((error) => {
        console.error(`[run-bus] late cancel persistence failed (${executionNodeId}/${executionToken})`, error);
      });
  }
  return () => {
    if (runExecutionCancelHandlers.get(executionToken) === entry) runExecutionCancelHandlers.delete(executionToken);
  };
}

export function releaseRunExecutionBinding(nodeId: string, executionToken: string) {
  const binding = runExecutionBindings.get(executionToken);
  if (binding && (binding.nodeId === nodeId || binding.originalNodeId === nodeId)) runExecutionBindings.delete(executionToken);
  runExecutionCancelHandlers.delete(executionToken);
  cancelledRunExecutionTokens.delete(executionToken);
}

export function clearRunExecutionBindings() {
  runExecutionBindings.clear();
  runExecutionCancelHandlers.clear();
  cancelledRunExecutionTokens.clear();
}

async function cancelRunExecutions(entries: Array<[string, string]>) {
  for (const [, executionToken] of entries) cancelledRunExecutionTokens.add(executionToken);
  const handlers = entries
    .map(([nodeId, executionToken]) => ({ executionToken, entry: runExecutionCancelHandlers.get(executionToken), nodeId }))
    .filter(({ entry, nodeId }) => entry?.nodeId === nodeId);
  await Promise.allSettled(handlers.map(({ entry }) => Promise.resolve().then(() => entry!.handler())));
}

function removeRunExecutionsFromState(
  state: RunBusState,
  entries: Array<[string, string]>,
) {
  const acceptedEntries = entries.filter(([nodeId, executionToken]) => state.executionTokens[nodeId] === executionToken);
  const targetIds = acceptedEntries.map(([nodeId]) => nodeId);
  const targetSet = new Set(targetIds);
  const nextExecutionTokens = { ...state.executionTokens };
  for (const [nodeId] of acceptedEntries) delete nextExecutionTokens[nodeId];
  const nextRunningIds = state.runningIds.filter((nodeId) => !targetSet.has(nodeId));
  return {
    acceptedEntries,
    patch: {
      currentRunId: state.currentRunId && targetSet.has(state.currentRunId)
        ? nextRunningIds[0] || null
        : state.currentRunId,
      runningIds: nextRunningIds,
      executionTokens: nextExecutionTokens,
      activeNodeRunIds: Object.fromEntries(Object.entries(state.activeNodeRunIds).filter(([nodeId]) => !targetSet.has(nodeId))),
      activeNodeRunTokens: Object.fromEntries(Object.entries(state.activeNodeRunTokens).filter(([nodeId]) => !targetSet.has(nodeId))),
      mode: nextRunningIds.length > 0 ? state.mode : 'idle' as const,
      batchTotal: nextRunningIds.length > 0 ? state.batchTotal : 0,
      batchDoneCount: nextRunningIds.length > 0 ? state.batchDoneCount : 0,
      cancelSeq: state.cancelSeq + 1,
      cancelTargets: targetIds,
    },
  };
}

export const useRunBusStore = create<RunBusState>((set, get) => ({
  activeRunId: null,
  activeRunContext: null,
  activeNodeRunIds: {},
  activeNodeRunTokens: {},
  currentRunId: null,
  runningIds: [],
  executionTokens: {},
  lastDone: null,
  cancelSeq: 0,
  cancelTargets: [],
  mode: 'idle',
  batchTotal: 0,
  batchDoneCount: 0,
  triggerRun: (id, mode = 'single', explicitRunContext) => {
    const runContext = explicitRunContext === undefined ? get().activeRunContext : explicitRunContext;
    assertNodeAuthorizedByRunContext(runContext, id);
    const executionToken = createRunExecutionToken();
    const executionNodeId = bindRunExecution(id, executionToken, mode, runContext);
    if (typeof window !== 'undefined') taskCompletionSound.primeAudio();
    set((s) => ({
      currentRunId: executionNodeId,
      runningIds: s.runningIds.includes(executionNodeId) ? s.runningIds : [...s.runningIds, executionNodeId],
      executionTokens: { ...s.executionTokens, [executionNodeId]: executionToken },
      activeNodeRunIds: Object.fromEntries(Object.entries(s.activeNodeRunIds).filter(([nodeId]) => nodeId !== executionNodeId)),
      activeNodeRunTokens: Object.fromEntries(Object.entries(s.activeNodeRunTokens).filter(([nodeId]) => nodeId !== executionNodeId)),
      cancelTargets: [],
      mode: s.mode === 'batch' ? 'batch' : mode,
    }));
    return executionToken;
  },
  triggerRunMany: (ids, mode = 'batch', explicitRunContext) => {
    const uniqueIds = Array.from(new Set(ids));
    const runContext = explicitRunContext === undefined ? get().activeRunContext : explicitRunContext;
    uniqueIds.forEach((id) => assertNodeAuthorizedByRunContext(runContext, id));
    const issuedTokens = Object.fromEntries(uniqueIds.map((id) => [id, createRunExecutionToken()]));
    const issuedExecutions = uniqueIds.map((id) => ({
      executionNodeId: bindRunExecution(id, issuedTokens[id], mode, runContext),
      executionToken: issuedTokens[id],
    }));
    if (typeof window !== 'undefined') taskCompletionSound.primeAudio();
    set((s) => {
      // 并发模式：runningIds 合并去重，currentRunId 取首个 (仅为向后兼容订阅者)
      const executionNodeIds = issuedExecutions.map((item) => item.executionNodeId);
      const merged = Array.from(new Set([...s.runningIds, ...executionNodeIds]));
      const issuedIds = new Set(executionNodeIds);
      const scopedTokens = Object.fromEntries(issuedExecutions.map((item) => [item.executionNodeId, item.executionToken]));
      return {
        runningIds: merged,
        currentRunId: executionNodeIds.length > 0 ? executionNodeIds[0] : s.currentRunId,
        executionTokens: { ...s.executionTokens, ...scopedTokens },
        activeNodeRunIds: Object.fromEntries(Object.entries(s.activeNodeRunIds).filter(([nodeId]) => !issuedIds.has(nodeId))),
        activeNodeRunTokens: Object.fromEntries(Object.entries(s.activeNodeRunTokens).filter(([nodeId]) => !issuedIds.has(nodeId))),
        cancelTargets: [],
        mode: s.mode === 'batch' ? 'batch' : mode,
      };
    });
    return issuedTokens;
  },
  markDone: (id, executionToken, ok, error) => {
    let accepted = false;
    const executionNodeId = getRunExecutionBinding(id, executionToken)?.nodeId || id;
    let acceptedTs = 0;
    set((s) => {
      if (s.executionTokens[executionNodeId] !== executionToken) return s;
      accepted = true;
      acceptedTs = Math.max(Date.now(), (s.lastDone?.ts || 0) + 1);
      const nextRunningIds = s.runningIds.filter((x) => x !== executionNodeId);
      const nextExecutionTokens = { ...s.executionTokens };
      delete nextExecutionTokens[executionNodeId];
      return {
        lastDone: { id: executionNodeId, executionToken, ok, ts: acceptedTs, error },
        currentRunId: s.currentRunId === executionNodeId ? null : s.currentRunId,
        runningIds: nextRunningIds,
        executionTokens: nextExecutionTokens,
        // 单节点模式且无其他运行中节点时回到 idle;批量模式由 Canvas 控制
        mode:
          s.mode === 'batch'
            ? 'batch'
            : nextRunningIds.length > 0
              ? s.mode
              : 'idle',
      };
    });
    if (accepted && ok && typeof window !== 'undefined') taskCompletionSound.notifyComplete(executionNodeId, undefined, acceptedTs);
    return accepted;
  },
  cancelAll: async () => {
    const state = get();
    const targets = Array.from(new Set([...(state.currentRunId ? [state.currentRunId] : []), ...state.runningIds]));
    const requestedEntries = Object.entries(state.executionTokens).filter(([nodeId]) => targets.includes(nodeId));
    const { acceptedEntries, patch } = removeRunExecutionsFromState(state, requestedEntries);
    set(patch);
    await cancelRunExecutions(acceptedEntries);
  },
  cancelRun: async (runId) => {
    const state = get();
    const requestedEntries = Object.entries(state.executionTokens).filter(([nodeId, executionToken]) => {
      const binding = getRunExecutionBinding(nodeId, executionToken);
      return binding?.runContext?.runId === runId;
    });
    const { acceptedEntries, patch } = removeRunExecutionsFromState(state, requestedEntries);
    if (acceptedEntries.length === 0) return;
    set(patch);
    await cancelRunExecutions(acceptedEntries);
  },
  setBatchProgress: (total, done) =>
    set({ batchTotal: total, batchDoneCount: done, mode: total > 0 ? 'batch' : 'idle' }),
  setActiveRun: (runId) => set((state) => ({
    activeRunId: runId,
    activeRunContext: state.activeRunContext?.runId === runId ? state.activeRunContext : null,
  })),
  setActiveRunContext: (context) => set({
    activeRunId: context?.runId || null,
    activeRunContext: cloneRunContext(context),
  }),
  clearActiveRunContext: (runId) => set((state) => (
    state.activeRunContext?.runId === runId
      ? { activeRunId: null, activeRunContext: null }
      : state
  )),
  setActiveNodeRun: (nodeId, nodeRunId, executionToken) => set((state) => {
    const executionNodeId = getRunExecutionBinding(nodeId, executionToken)?.nodeId || nodeId;
    const activeExecutionToken = state.executionTokens[executionNodeId];
    const registeredExecutionToken = state.activeNodeRunTokens[executionNodeId];
    if (nodeRunId && activeExecutionToken !== executionToken) return state;
    if (!nodeRunId && registeredExecutionToken !== executionToken) return state;
    const nextIds = { ...state.activeNodeRunIds };
    const nextTokens = { ...state.activeNodeRunTokens };
    if (nodeRunId) {
      nextIds[executionNodeId] = nodeRunId;
      nextTokens[executionNodeId] = executionToken;
    } else {
      delete nextIds[executionNodeId];
      delete nextTokens[executionNodeId];
    }
    return { activeNodeRunIds: nextIds, activeNodeRunTokens: nextTokens };
  }),
}));
