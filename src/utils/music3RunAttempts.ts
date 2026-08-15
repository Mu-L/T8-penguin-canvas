import {
  appendProjectRunEvent,
  createProjectRunAttempt,
  updateProjectRunAttempt,
} from '../services/api';
import type { RunNodeLifecycleReporter } from '../types/project';

export interface Music3ChildAttempt {
  attemptId: string;
  submissionKey: string;
  providerRequest(payload?: Record<string, unknown>): Promise<void>;
  providerResponse(payload?: Record<string, unknown>): Promise<void>;
  providerUsage(payload?: Record<string, unknown>): Promise<void>;
  succeed(payload?: Record<string, unknown>): Promise<void>;
  fail(error: unknown, payload?: Record<string, unknown>): Promise<void>;
}

export async function createMusic3ChildAttempt(
  reporter: RunNodeLifecycleReporter,
  input: { provider: string; model: string; stage: string; inputDigest: string },
): Promise<Music3ChildAttempt> {
  const runId = reporter.runContext?.runId;
  const nodeRunId = reporter.nodeRunId;
  if (!runId || !nodeRunId) throw new Error('Music 3 LLM 阶段缺少持久 Run/NodeRun，已停止调用 Provider。');
  const inputDigest = String(input.inputDigest || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(inputDigest)) throw new Error('Music 3 阶段输入摘要无效。');
  const stage = String(input.stage || '').trim();
  if (!/^[a-z][a-z0-9-]{1,48}$/.test(stage)) throw new Error('Music 3 阶段名称无效。');
  const submissionKey = `music3:${nodeRunId}:${stage}:${inputDigest.slice(0, 32)}`;
  const attemptId = `attempt-${crypto.randomUUID()}`;
  const entityUid = crypto.randomUUID();
  const persisted = await createProjectRunAttempt(runId, nodeRunId, {
    id: attemptId,
    entityUid,
    provider: input.provider,
    model: input.model,
    status: 'running',
    timestamps: { queuedAt: Date.now(), startedAt: Date.now() },
    metadata: {
      music3ChildAttempt: true,
      stage,
      inputDigest,
      providerSubmission: { version: 1, slot: stage, submissionKey, state: 'prepared', preparedAt: Date.now() },
    },
  });
  if (persisted.reusedSubmission) {
    const state = String((persisted.metadata?.providerSubmission as Record<string, unknown> | undefined)?.state || persisted.status || 'unknown');
    const error = new Error(`Music 3 阶段“${stage}”已有持久提交账本（${state}）。为避免重复计费，本次不会自动重放；请保留节点缓存或更改输入后明确重试。`);
    (error as Error & { code?: string }).code = 'MUSIC3_SUBMISSION_LEDGER_EXISTS';
    throw error;
  }
  const durableAttemptId = persisted.id;
  const base = { stage, inputDigest, attemptId: durableAttemptId, submissionKey };
  const patch = (value: Record<string, unknown>) => updateProjectRunAttempt(runId, nodeRunId, durableAttemptId, value);
  const event = (type: string, payload: Record<string, unknown> = {}) => appendProjectRunEvent(runId, { nodeRunId, type, payload: { ...base, ...payload } });
  return {
    attemptId: durableAttemptId,
    submissionKey,
    async providerRequest(payload = {}) {
      await patch({ timestamps: { requestedAt: Date.now() }, metadata: { lastProviderEvent: 'provider.request', providerSubmission: { version: 1, slot: stage, submissionKey, state: 'ambiguous', dispatchStartedAt: Date.now() } } });
      await event('provider.request', payload).catch(() => undefined);
    },
    async providerResponse(payload = {}) {
      await patch({
        requestId: payload.requestId ? String(payload.requestId) : undefined,
        httpStatus: Number.isFinite(Number(payload.transportHttpStatus)) ? Number(payload.transportHttpStatus) : undefined,
        usage: payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : undefined,
        timestamps: { respondedAt: Date.now() },
        metadata: { lastProviderEvent: 'provider.response', providerSubmission: { version: 1, slot: stage, submissionKey, state: 'responded', respondedAt: Date.now() } },
      });
      await event('provider.response', payload).catch(() => undefined);
    },
    async providerUsage(payload = {}) {
      await patch({ usage: payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : undefined, metadata: { lastProviderEvent: 'provider.usage' } });
      await event('provider.usage', payload).catch(() => undefined);
    },
    async succeed(payload = {}) {
      if (reporter.signal?.aborted) throw new DOMException('父运行已停止；禁止把迟到的 Music 3 阶段写成成功。', 'AbortError');
      await patch({ status: 'succeeded', timestamps: { finishedAt: Date.now() }, metadata: { music3ChildAttempt: true, stage, inputDigest, providerSubmission: { version: 1, slot: stage, submissionKey, state: 'verified', verifiedAt: Date.now() }, ...payload } });
      await event('log', { level: 'info', message: 'Music 3 child attempt succeeded', ...payload }).catch(() => undefined);
    },
    async fail(error, payload = {}) {
      const message = error instanceof Error ? error.message : String(error);
      await patch({ status: 'failed', timestamps: { finishedAt: Date.now() }, error: { kind: 'provider', message }, metadata: { music3ChildAttempt: true, stage, inputDigest, ...payload } });
      await event('log', { level: 'error', message, ...payload }).catch(() => undefined);
    },
  };
}
