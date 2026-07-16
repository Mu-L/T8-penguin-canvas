import { create } from 'zustand';
import { taskCompletionSound } from './taskCompletionSound';
import type { RunContext } from '../types/project';

/**
 * 批量运行总线
 * - currentRunId：单点模式指示 (后兼容 v1.2.7 之前)
 * - runningIds：并发运行中的节点集合 (v1.2.8 新增，为循环器节点并联模式使用)
 * - executionTokens：每个节点当前唯一的执行令牌；同 nodeId 重触发也必须换新令牌
 * - lastDone：最后一次被当前令牌接受的完成信息
 * - triggerRun(id)：单点调度并返回本次 execution token
 * - triggerRunMany(ids)：并发调度并返回每个节点的 execution token
 * - markDone(id, token, ok)：仅当前 token 可完成节点，旧任务完成会被忽略
 * - cancelAll()：取消全部 (广播本轮 cancelTargets/cancelSeq，再清空运行节点和令牌)
 *
 * 向后兼容保证：现有 16 个节点仅依赖 currentRunId 逻辑不变；useRunTrigger 后续会同时检查 runningIds 是否包含自身 id。
 */

export interface LastDoneInfo {
  id: string;
  executionToken: string;
  ok: boolean;
  ts: number;
  error?: string;
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
  triggerRun: (id: string, mode?: 'single' | 'batch') => string;
  triggerRunMany: (ids: string[], mode?: 'single' | 'batch') => Record<string, string>;
  markDone: (id: string, executionToken: string, ok: boolean, error?: string) => boolean;
  cancelAll: () => Promise<void>;
  setBatchProgress: (total: number, done: number) => void;
  setActiveRun: (runId: string | null) => void;
  setActiveRunContext: (context: RunContext | null) => void;
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
  nodeId: string;
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
  cancelledRunExecutionTokens.delete(executionToken);
  runExecutionBindings.set(executionToken, {
    nodeId,
    executionToken,
    mode,
    runContext: cloneRunContext(runContext),
    nodeContext: cloneNodeExecutionContext(getRunNodeExecutionContext(nodeId)),
    issuedAt: Date.now(),
  });
}

export function getRunExecutionBinding(nodeId: string, executionToken: string): RunExecutionBinding | null {
  const binding = runExecutionBindings.get(executionToken);
  if (!binding || binding.nodeId !== nodeId) return null;
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
  const entry = { nodeId, handler };
  runExecutionCancelHandlers.set(executionToken, entry);
  if (cancelledRunExecutionTokens.has(executionToken)) void Promise.resolve().then(handler);
  return () => {
    if (runExecutionCancelHandlers.get(executionToken) === entry) runExecutionCancelHandlers.delete(executionToken);
  };
}

export function releaseRunExecutionBinding(nodeId: string, executionToken: string) {
  const binding = runExecutionBindings.get(executionToken);
  if (binding?.nodeId === nodeId) runExecutionBindings.delete(executionToken);
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
  triggerRun: (id, mode = 'single') => {
    assertNodeAuthorizedByRunContext(get().activeRunContext, id);
    const executionToken = createRunExecutionToken();
    bindRunExecution(id, executionToken, mode, get().activeRunContext);
    if (typeof window !== 'undefined') taskCompletionSound.primeAudio();
    set((s) => ({
      currentRunId: id,
      runningIds: s.runningIds.includes(id) ? s.runningIds : [...s.runningIds, id],
      executionTokens: { ...s.executionTokens, [id]: executionToken },
      activeNodeRunIds: Object.fromEntries(Object.entries(s.activeNodeRunIds).filter(([nodeId]) => nodeId !== id)),
      activeNodeRunTokens: Object.fromEntries(Object.entries(s.activeNodeRunTokens).filter(([nodeId]) => nodeId !== id)),
      cancelTargets: [],
      mode: s.mode === 'batch' ? 'batch' : mode,
    }));
    return executionToken;
  },
  triggerRunMany: (ids, mode = 'batch') => {
    const uniqueIds = Array.from(new Set(ids));
    const activeRunContext = get().activeRunContext;
    uniqueIds.forEach((id) => assertNodeAuthorizedByRunContext(activeRunContext, id));
    const issuedTokens = Object.fromEntries(uniqueIds.map((id) => [id, createRunExecutionToken()]));
    for (const [id, executionToken] of Object.entries(issuedTokens)) bindRunExecution(id, executionToken, mode, activeRunContext);
    if (typeof window !== 'undefined') taskCompletionSound.primeAudio();
    set((s) => {
      // 并发模式：runningIds 合并去重，currentRunId 取首个 (仅为向后兼容订阅者)
      const merged = Array.from(new Set([...s.runningIds, ...uniqueIds]));
      const issuedIds = new Set(uniqueIds);
      return {
        runningIds: merged,
        currentRunId: uniqueIds.length > 0 ? uniqueIds[0] : s.currentRunId,
        executionTokens: { ...s.executionTokens, ...issuedTokens },
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
    let acceptedTs = 0;
    set((s) => {
      if (s.executionTokens[id] !== executionToken) return s;
      accepted = true;
      acceptedTs = Math.max(Date.now(), (s.lastDone?.ts || 0) + 1);
      const nextRunningIds = s.runningIds.filter((x) => x !== id);
      const nextExecutionTokens = { ...s.executionTokens };
      delete nextExecutionTokens[id];
      return {
        lastDone: { id, executionToken, ok, ts: acceptedTs, error },
        currentRunId: s.currentRunId === id ? null : s.currentRunId,
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
    if (accepted && ok && typeof window !== 'undefined') taskCompletionSound.notifyComplete(id, undefined, acceptedTs);
    return accepted;
  },
  cancelAll: async () => {
    const state = get();
    const targets = Array.from(new Set([...(state.currentRunId ? [state.currentRunId] : []), ...state.runningIds]));
    const targetSet = new Set(targets);
    const entries = Object.entries(state.executionTokens).filter(([nodeId]) => targetSet.has(nodeId));
    set((s) => ({
      currentRunId: null,
      runningIds: [],
      executionTokens: {},
      activeNodeRunIds: {},
      activeNodeRunTokens: {},
      mode: 'idle',
      batchTotal: 0,
      batchDoneCount: 0,
      cancelSeq: s.cancelSeq + 1,
      cancelTargets: targets,
    }));
    await cancelRunExecutions(entries);
  },
  setBatchProgress: (total, done) =>
    set({ batchTotal: total, batchDoneCount: done, mode: total > 0 ? 'batch' : 'idle' }),
  setActiveRun: (runId) => set((state) => ({
    activeRunId: runId,
    activeRunContext: state.activeRunContext?.runId === runId ? state.activeRunContext : null,
    activeNodeRunIds: {},
    activeNodeRunTokens: {},
  })),
  setActiveRunContext: (context) => set({
    activeRunId: context?.runId || null,
    activeRunContext: cloneRunContext(context),
    activeNodeRunIds: {},
    activeNodeRunTokens: {},
  }),
  setActiveNodeRun: (nodeId, nodeRunId, executionToken) => set((state) => {
    const activeExecutionToken = state.executionTokens[nodeId];
    const registeredExecutionToken = state.activeNodeRunTokens[nodeId];
    if (nodeRunId && activeExecutionToken !== executionToken) return state;
    if (!nodeRunId && registeredExecutionToken !== executionToken) return state;
    const nextIds = { ...state.activeNodeRunIds };
    const nextTokens = { ...state.activeNodeRunTokens };
    if (nodeRunId) {
      nextIds[nodeId] = nodeRunId;
      nextTokens[nodeId] = executionToken;
    } else {
      delete nextIds[nodeId];
      delete nextTokens[nodeId];
    }
    return { activeNodeRunIds: nextIds, activeNodeRunTokens: nextTokens };
  }),
}));
