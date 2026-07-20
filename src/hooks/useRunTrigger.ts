import { useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import {
  getRunExecutionBinding,
  getRunNodeExecutionContext,
  isRunExecutionCancelled,
  registerRunExecutionCancelHandler,
  releaseRunExecutionBinding,
  useRunBusStore,
} from '../stores/runBus';
import { registerTaskCompletionSoundNode } from '../stores/taskCompletionSound';
import {
  appendProjectRunEvent,
  createProjectNodeRun,
  createProjectRunAttempt,
  finalizeProjectNodeRunAttempt,
  persistProjectRunOutputAssets,
  updateProjectNodeRun,
  updateProjectRunAttempt,
} from '../services/api';
import { normalizeRunError } from '../utils/runErrors';
import { captureRunNodeInputSnapshot } from '../utils/runReplay';
import { inferRunRecoveryDescriptor } from '../utils/runRecovery';
import {
  createRunNodeLifecycleController,
  executeAfterRunLifecycleBarrier,
  resolveRunExecutionDisposition,
} from '../utils/runLifecycle';
import {
  collectRunOutputAssets,
  extractRunProviderTrace,
  providerTraceAttemptPatch,
} from '../utils/runProviderTrace';
import type { RunNodeLifecycleReporter } from '../types/project';
import type { RunOutputAssetCandidate, RunProviderTrace } from '../utils/runProviderTrace';

/**
 * 节点运行总线监听器
 * 节点在内部调用:`useRunTrigger(id, async () => { await handleGenerate(); })`
 * 每次 triggerRun/triggerRunMany 都为节点签发新的 execution token；完成后仅用捕获的
 * token 回报 markDone。停止前的旧 Promise 即使较晚结束，也不能完成或覆盖新任务。
 *
 * 设计要点:
 * - runFn 通过 ref 保存,避免依赖项导致 effect 反复执行
 * - startedTokensRef 按 token 防重入，避免 React StrictMode 对同一轮重复发起
 * - 同一 nodeId 被连续触发时允许新 token 启动；旧 token 只能归档到原 Run/Attempt
 */
export function useRunTrigger(
  nodeId: string,
  runFn: (() => Promise<void> | void) | ((reporter: RunNodeLifecycleReporter) => Promise<void> | void),
  completionSoundNodeType?: string,
  options: { lifecycleAware?: boolean } = {},
) {
  const { getNodes, getEdges } = useReactFlow();
  const executionToken = useRunBusStore((s) => s.executionTokens[nodeId] || null);
  const markDone = useRunBusStore((s) => s.markDone);
  const runFnRef = useRef(runFn);
  runFnRef.current = runFn;
  const lifecycleAwareRef = useRef(Boolean(options.lifecycleAware));
  lifecycleAwareRef.current = Boolean(options.lifecycleAware);
  const startedTokensRef = useRef(new Set<string>());

  useEffect(
    () => registerTaskCompletionSoundNode(nodeId, completionSoundNodeType),
    [nodeId, completionSoundNodeType],
  );

  useEffect(() => {
    if (!executionToken || startedTokensRef.current.has(executionToken)) return;
    startedTokensRef.current.add(executionToken);
    const capturedExecutionToken = executionToken;
    (async () => {
      const binding = getRunExecutionBinding(nodeId, capturedExecutionToken);
      const runContext = binding?.runContext || null;
      const runId = runContext?.runId || null;
      const executionContext = binding?.nodeContext || getRunNodeExecutionContext(nodeId);
      let nodeRunId: string | undefined;
      let attemptId: string | undefined;
      let executionCallbackStarted = false;
      let terminalWrite: Promise<void> | null = null;
      let acceptLifecycleEvents = true;
      let providerSubmittedRecorded = false;
      let providerResponseRecorded = false;
      let activeProviderTrace: RunProviderTrace = {};
      let unregisterCancelHandler: () => void = () => undefined;
      let resolvePersistenceReady: () => void = () => undefined;
      const persistenceReady = new Promise<void>((resolve) => {
        resolvePersistenceReady = resolve;
      });
      const rememberProviderTrace = (trace: RunProviderTrace): RunProviderTrace => {
        activeProviderTrace = {
          ...activeProviderTrace,
          ...trace,
          ...(activeProviderTrace.usage || trace.usage
            ? { usage: { ...(activeProviderTrace.usage || {}), ...(trace.usage || {}) } }
            : {}),
        };
        return activeProviderTrace;
      };
      const hasProviderIdentity = (trace: RunProviderTrace) => Boolean(
        trace.provider || trace.model || trace.upstreamTaskId || trace.requestId,
      );
      const attemptTimestampsForEvent = (type: string, at: number): Record<string, number> => {
        if (type === 'provider.request') return { requestedAt: at };
        if (type === 'provider.submitted') return { submittedAt: at };
        if (type === 'provider.polling') return { lastPolledAt: at };
        if (type === 'provider.response') return { respondedAt: at };
        return {};
      };
      const lifecycle = createRunNodeLifecycleController({
        runContext,
        executionToken: capturedExecutionToken,
        executionEvidence: () => ({ nodeRunId, attemptId }),
        basePayload: {
          nodeId: executionContext?.runNodeId || nodeId,
          contextId: runContext?.contextId || null,
        },
        sink: {
          write: async (type, payload) => {
            if (!runId || !nodeRunId || !acceptLifecycleEvents) return;
            try {
              if (type === 'node.polling') {
                const trace = rememberProviderTrace(extractRunProviderTrace(payload));
                const recovery = inferRunRecoveryDescriptor(payload);
                if (hasProviderIdentity(trace) && !providerSubmittedRecorded) {
                  await appendProjectRunEvent(runId, {
                    nodeRunId,
                    type: 'provider.submitted',
                    payload: { ...trace, observedFrom: 'first-poll', executionToken: capturedExecutionToken },
                  });
                  providerSubmittedRecorded = true;
                }
                const attemptPatch = providerTraceAttemptPatch(trace);
                await updateProjectNodeRun(runId, nodeRunId, { status: 'polling', eventPayload: payload });
                if (attemptId) {
                  await updateProjectRunAttempt(runId, nodeRunId, attemptId, {
                    ...attemptPatch,
                    status: 'polling',
                    timestamps: { lastPolledAt: Date.now() },
                    metadata: { lastProviderEvent: 'provider.polling', ...(recovery ? { recovery } : {}) },
                  });
                }
                if (hasProviderIdentity(trace)) {
                  await appendProjectRunEvent(runId, {
                    nodeRunId,
                    type: 'provider.polling',
                    payload,
                  });
                }
              } else if (type === 'node.output' && Array.isArray(payload.assets) && payload.assets.length > 0) {
                const { assets, ...eventPayload } = payload;
                await persistProjectRunOutputAssets(runId, nodeRunId, {
                  attemptId,
                  outputs: assets as RunOutputAssetCandidate[],
                  eventPayload,
                });
              } else if (type.startsWith('provider.')) {
                const trace = rememberProviderTrace(extractRunProviderTrace(
                  type === 'provider.usage' && !payload.usage ? { ...payload, usage: payload } : payload,
                ));
                const now = Date.now();
                const attemptPatch = providerTraceAttemptPatch(trace);
                const recovery = type === 'provider.submitted' || type === 'provider.polling'
                  ? inferRunRecoveryDescriptor(payload)
                  : null;
                await appendProjectRunEvent(runId, { nodeRunId, type, payload });
                if (attemptId) {
                  await updateProjectRunAttempt(runId, nodeRunId, attemptId, {
                    ...attemptPatch,
                    timestamps: attemptTimestampsForEvent(type, now),
                    metadata: { lastProviderEvent: type, ...(recovery ? { recovery } : {}) },
                  });
                }
                if (type === 'provider.submitted') providerSubmittedRecorded = true;
                if (type === 'provider.response') providerResponseRecorded = true;
              } else {
                await appendProjectRunEvent(runId, { nodeRunId, type, payload });
              }
            } catch (error) {
              console.warn(`[run-center] failed to persist ${type}:`, error);
              if (!executionCallbackStarted
                || type === 'node.output'
                || type === 'provider.request'
                || type === 'provider.submitted') throw error;
            }
          },
        },
      });

      const disposition = () => resolveRunExecutionDisposition(
        useRunBusStore.getState().executionTokens[nodeId],
        capturedExecutionToken,
        isRunExecutionCancelled(capturedExecutionToken),
      );

      const persistTerminal = (
        status: 'succeeded' | 'failed' | 'stopped',
        error?: unknown,
      ) => {
        if (terminalWrite) return terminalWrite;
        terminalWrite = (async () => {
          const finishedAt = Date.now();
          const normalizedError = status === 'succeeded'
            ? null
            : status === 'stopped'
              ? {
                  kind: 'cancelled',
                  message: error instanceof Error ? error.message : String(error || '节点运行已停止'),
                  code: 'RUN_EXECUTION_STOPPED',
                  retryable: true,
                }
              : normalizeRunError(error) as unknown as Record<string, unknown>;
          const terminalNodeData = getNodes().find((node) => node.id === nodeId)?.data as Record<string, unknown> | undefined;
          const terminalTrace = rememberProviderTrace(extractRunProviderTrace(terminalNodeData));
          if (hasProviderIdentity(terminalTrace) && !providerResponseRecorded) {
            await lifecycle.reporter.providerResponse({
              ...terminalTrace,
              status,
              ...(normalizedError ? { error: normalizedError } : {}),
            });
          }
          try {
            await lifecycle.flush();
          } catch (lifecyclePersistenceError) {
            // A successful run is not allowed to outrun its authoritative
            // output evidence. Failed/stopped runs still need a durable
            // terminal record even when an earlier output write failed.
            if (status === 'succeeded') throw lifecyclePersistenceError;
          }
          acceptLifecycleEvents = false;
          if (!runId || !nodeRunId || !attemptId) return;
          let lastPersistenceError: unknown = null;
          for (let writeAttempt = 0; writeAttempt < 3; writeAttempt += 1) {
            try {
              await finalizeProjectNodeRunAttempt(runId, nodeRunId, attemptId, {
                status,
                timestamps: { finishedAt },
                error: normalizedError,
                eventPayload: {
                  executionToken: capturedExecutionToken,
                  contextId: runContext?.contextId || null,
                },
              });
              return;
            } catch (persistenceError) {
              lastPersistenceError = persistenceError;
              if (writeAttempt < 2) {
                await new Promise<void>((resolve) => window.setTimeout(resolve, 120 * (writeAttempt + 1)));
              }
            }
          }
          throw new Error(
            `无法原子持久化 NodeRun/Attempt 终态：${lastPersistenceError instanceof Error ? lastPersistenceError.message : String(lastPersistenceError)}`,
          );
        })();
        return terminalWrite;
      };

      unregisterCancelHandler = registerRunExecutionCancelHandler(
        nodeId,
        capturedExecutionToken,
        async () => {
          await persistenceReady;
          await persistTerminal('stopped', new Error('节点运行已由用户停止'));
        },
      );

      try {
        // Every Provider-facing execution must be anchored to a durable Run.
        // Continuing without it would create an untraceable operation that the
        // E4 Run/NodeRun/Attempt diagnosis contract cannot cite.
        if (!runId) {
          throw new Error('缺少持久化 Run 上下文，已停止调用 Provider');
        }
        try {
          const inputSnapshot = captureRunNodeInputSnapshot(getNodes(), getEdges(), nodeId);
          const nodeRun = await createProjectNodeRun(runId, {
            nodeId: executionContext?.runNodeId || nodeId,
            parentNodeRunId: executionContext?.parentNodeRunId,
            originalNodeId: executionContext?.originalNodeId,
            definitionId: executionContext?.definitionId,
            definitionVersion: executionContext?.definitionVersion,
            subflowPath: executionContext?.subflowPath || [],
            status: 'queued',
            inputSnapshot: inputSnapshot as unknown as Record<string, unknown>,
          });
          nodeRunId = nodeRun.id;
          useRunBusStore.getState().setActiveNodeRun(nodeId, nodeRunId, capturedExecutionToken);
          const snapshot = inputSnapshot.replayable
            ? inputSnapshot.node.data
            : executionContext?.inputSnapshot || {};
          const initialTrace = rememberProviderTrace(extractRunProviderTrace(snapshot));
          const attempt = await createProjectRunAttempt(runId, nodeRun.id, {
            ...providerTraceAttemptPatch(initialTrace),
            status: 'running',
            timestamps: { queuedAt: Date.now(), startedAt: Date.now() },
          });
          attemptId = attempt.id;
          await updateProjectNodeRun(runId, nodeRun.id, {
            status: 'running',
            eventPayload: {
              executionToken: capturedExecutionToken,
              contextId: runContext?.contextId || null,
            },
          });
          if (initialTrace.provider || initialTrace.model) {
            await lifecycle.reporter.providerRequest({ ...initialTrace, phase: 'request' });
          }
        } catch (error) {
          throw new Error(`无法建立持久化 NodeRun/Attempt，已停止调用 Provider：${error instanceof Error ? error.message : String(error)}`);
        }
        resolvePersistenceReady();

        if (disposition() !== 'active') {
          await persistTerminal('stopped', new Error('节点运行在开始前已停止或被新任务替代'));
          markDone(nodeId, capturedExecutionToken, false, 'stopped');
          return;
        }

        await executeAfterRunLifecycleBarrier(
          async () => {
            // Keep the first executable callback behind an explicit durable
            // lifecycle write. If this write fails, runFn (and therefore the
            // Provider/ffmpeg call it owns) must remain at zero invocations.
            await lifecycle.reporter.progress({ phase: 'executing', progress: 0 });
          },
          async () => {
            executionCallbackStarted = true;
            if (lifecycleAwareRef.current) {
              await (runFnRef.current as (reporter: RunNodeLifecycleReporter) => Promise<void> | void)(lifecycle.reporter);
            } else {
              await (runFnRef.current as () => Promise<void> | void)();
            }
          },
        );
        if (disposition() !== 'active') {
          await persistTerminal('stopped', new Error('节点运行已停止或被新任务替代'));
          markDone(nodeId, capturedExecutionToken, false, 'stopped');
          return;
        }
        const latestNodeData = getNodes().find((node) => node.id === nodeId)?.data as Record<string, unknown> | undefined;
        const latestStatus = String(latestNodeData?.status || latestNodeData?.taskStatus || '').trim().toLowerCase();
        if (latestStatus === 'error' || latestStatus === 'failed' || latestStatus === 'failure') {
          throw new Error(String(latestNodeData?.error || latestNodeData?.failReason || '节点运行失败'));
        }
        const finalTrace = rememberProviderTrace(extractRunProviderTrace(latestNodeData));
        if ((finalTrace.upstreamTaskId || finalTrace.requestId) && !providerSubmittedRecorded) {
          await lifecycle.reporter.providerSubmitted({ ...finalTrace, observedFrom: 'node-result' });
        }
        if (finalTrace.usage && Object.keys(finalTrace.usage).length > 0) {
          await lifecycle.reporter.providerUsage({ ...finalTrace, usage: finalTrace.usage });
        }
        if (hasProviderIdentity(finalTrace) && !providerResponseRecorded) {
          await lifecycle.reporter.providerResponse({ ...finalTrace, status: 'succeeded' });
        }
        await lifecycle.reporter.progress({ phase: 'completed', progress: 100 });
        if (!lifecycle.outputEmitted()) {
          const assets = collectRunOutputAssets(latestNodeData);
          await lifecycle.reporter.output({ status: 'succeeded', outputCount: assets.length, assets });
        }
        await persistTerminal('succeeded');
        markDone(nodeId, capturedExecutionToken, true);
      } catch (error: any) {
        resolvePersistenceReady();
        const stopped = disposition() !== 'active';
        let completionError: unknown = error;
        try {
          if (terminalWrite) await terminalWrite;
          else await persistTerminal(stopped ? 'stopped' : 'failed', error);
        } catch (persistenceError) {
          completionError = new Error(
            `节点执行结果无法写入持久证据：${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`,
          );
          console.error('[run-center] terminal evidence persistence failed:', persistenceError);
        }
        markDone(
          nodeId,
          capturedExecutionToken,
          false,
          stopped ? 'stopped' : completionError instanceof Error ? completionError.message : String(completionError),
        );
      } finally {
        unregisterCancelHandler();
        useRunBusStore.getState().setActiveNodeRun(nodeId, undefined, capturedExecutionToken);
        releaseRunExecutionBinding(nodeId, capturedExecutionToken);
        startedTokensRef.current.delete(capturedExecutionToken);
      }
    })();
  }, [executionToken, getEdges, getNodes, nodeId, markDone]);
}
