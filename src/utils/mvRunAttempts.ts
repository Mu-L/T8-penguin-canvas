import {
  appendProjectRunEvent,
  createProjectRunAttempt,
  persistProjectRunOutputAssets,
  updateProjectRunAttempt,
} from '../services/api';
import type { AssetRef, RunNodeLifecycleReporter } from '../types/project';

export interface MvChildAttempt {
  attemptId: string;
  submissionKey: string;
  priorSubmission?: {
    upstreamTaskId: string;
    requestId?: string;
    state: string;
    recovery?: Record<string, unknown> | null;
  };
  providerRequest(payload?: Record<string, unknown>): Promise<void>;
  providerSubmitted(payload?: Record<string, unknown>): Promise<void>;
  providerPolling(payload?: Record<string, unknown>): Promise<void>;
  providerResponse(payload?: Record<string, unknown>): Promise<void>;
  output(payload?: Record<string, unknown>): Promise<AssetRef[]>;
  succeed(payload?: Record<string, unknown>): Promise<void>;
  interrupt(message: string, payload?: Record<string, unknown>): Promise<void>;
  fail(error: unknown, payload?: Record<string, unknown>): Promise<void>;
}

async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function validatePaidApproval(
  receipt: any,
  task: any,
) {
  if (!receipt && !task) return;
  if (!receipt || !task || receipt.schema !== 't8-mv-paid-approval-receipt-v1' || !Array.isArray(receipt.tasks)) {
    throw new Error('MV 付费 Attempt 缺少精确任务批准，已在 Provider 调用前停止。');
  }
  const digest = await sha256Json({ label: receipt.operation, tasks: receipt.tasks });
  const exact = receipt.tasks.find((item: Record<string, unknown>) => item.id === task.id);
  if (receipt.taskCount !== receipt.tasks.length || receipt.taskSetDigest !== digest || !exact || JSON.stringify(exact) !== JSON.stringify(task)) {
    throw new Error(`MV 付费 Attempt 的批准回执未精确覆盖 ${String(task.id || 'unknown')}，已停止。`);
  }
}

export async function createMvChildAttempt(
  reporter: RunNodeLifecycleReporter,
  input: { provider: string; model: string; jobId: string; jobKind: string; submissionKey?: string; approvalReceipt?: Record<string, unknown>; approvalTask?: unknown },
): Promise<MvChildAttempt> {
  const runId = reporter.runContext?.runId;
  const nodeRunId = reporter.nodeRunId;
  if (!runId || !nodeRunId) throw new Error('MV 付费操作缺少持久 Run/NodeRun，已停止调用 Provider。');
  const entityUid = crypto.randomUUID();
  const attemptId = `attempt-${crypto.randomUUID()}`;
  const requestedSubmissionKey = String(input.submissionKey || '').trim();
  if (requestedSubmissionKey && !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(requestedSubmissionKey)) {
    throw new Error('MV 稳定提交键格式无效，已在调用 Provider 前停止。');
  }
  const submissionKey = requestedSubmissionKey || entityUid;
  await validatePaidApproval(input.approvalReceipt, input.approvalTask);
  const persistedAttempt = await createProjectRunAttempt(runId, nodeRunId, {
    id: attemptId,
    entityUid,
    provider: input.provider,
    model: input.model,
    status: 'running',
    timestamps: { queuedAt: Date.now(), startedAt: Date.now() },
    metadata: {
      mvChildAttempt: true,
      jobId: input.jobId,
      jobKind: input.jobKind,
      ...(input.approvalReceipt ? { approvalReceipt: input.approvalReceipt } : {}),
      ...(input.approvalTask ? { approvalTask: input.approvalTask } : {}),
      providerSubmission: { version: 1, slot: input.jobId, submissionKey, state: 'prepared', preparedAt: Date.now() },
    },
  });
  if (persistedAttempt.reusedSubmission && !persistedAttempt.upstreamTaskId) {
    const previous = persistedAttempt.metadata?.providerSubmission as Record<string, unknown> | undefined;
    const error = new Error(`提交键 ${submissionKey} 已存在持久账本（${String(previous?.state || persistedAttempt.status || 'unknown')}）；为避免重复计费，本次不会再次调用 Provider。`);
    (error as Error & { code?: string }).code = 'MV_SUBMISSION_LEDGER_EXISTS';
    throw error;
  }
  const durableAttemptId = persistedAttempt.id;
  const priorSubmission = persistedAttempt.reusedSubmission && persistedAttempt.upstreamTaskId
    ? {
      upstreamTaskId: persistedAttempt.upstreamTaskId,
      requestId: persistedAttempt.requestId || undefined,
      state: String((persistedAttempt.metadata?.providerSubmission as Record<string, unknown> | undefined)?.state || persistedAttempt.status || 'submitted'),
      recovery: (persistedAttempt.metadata?.mvRecovery as Record<string, unknown> | null | undefined) || null,
    }
    : undefined;
  const basePayload = { ...input, attemptId: durableAttemptId, submissionKey };

  const event = async (type: string, payload: Record<string, unknown> = {}) => {
    await appendProjectRunEvent(runId, { nodeRunId, type, payload: { ...basePayload, ...payload } });
  };
  const patch = async (value: Record<string, unknown>) => {
    await updateProjectRunAttempt(runId, nodeRunId, durableAttemptId, value);
  };
  return {
    attemptId: durableAttemptId,
    submissionKey,
    priorSubmission,
    async providerRequest(payload = {}) {
      if (priorSubmission) {
        await event('provider.request', { ...payload, resumed: true, upstreamTaskId: priorSubmission.upstreamTaskId }).catch(() => undefined);
        return;
      }
      await patch({ timestamps: { requestedAt: Date.now() }, metadata: { lastProviderEvent: 'provider.request', providerSubmission: { version: 1, slot: input.jobId, submissionKey, state: 'ambiguous', dispatchStartedAt: Date.now() } } });
      await event('provider.request', payload).catch(() => undefined);
    },
    async providerSubmitted(payload = {}) {
      const candidateId = payload.candidateId ? String(payload.candidateId) : '';
      const requestDigest = payload.requestDigest ? String(payload.requestDigest) : '';
      await patch({
        provider: String(payload.provider || input.provider),
        model: String(payload.model || input.model),
        upstreamTaskId: payload.upstreamTaskId ? String(payload.upstreamTaskId) : undefined,
        requestId: payload.requestId ? String(payload.requestId) : undefined,
        httpStatus: Number.isFinite(Number(payload.upstreamHttpStatus ?? payload.transportHttpStatus)) ? Number(payload.upstreamHttpStatus ?? payload.transportHttpStatus) : undefined,
        usage: payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : undefined,
        status: 'polling',
        timestamps: { submittedAt: Date.now() },
        // MV owns several independently resumable child jobs inside one parent
        // NodeRun.  Keep the recovery descriptor durable, but do not expose it
        // through the generic `metadata.recovery` slot: that manager terminalizes
        // the whole parent NodeRun after one recovered Attempt.  The canvas
        // candidate state resumes these child jobs explicitly by taskId.
        metadata: {
          lastProviderEvent: 'provider.submitted',
          mvRecovery: payload.recovery || null,
          mvCandidate: candidateId || requestDigest ? { candidateId: candidateId || undefined, requestDigest: requestDigest || undefined } : undefined,
          providerSubmission: { version: 1, slot: input.jobId, submissionKey, state: 'submitted', submittedAt: Date.now() },
        },
      });
      await event('provider.submitted', payload).catch(() => undefined);
    },
    async providerPolling(payload = {}) {
      await patch({ pollCount: Number(payload.pollCount || 0), status: 'polling', timestamps: { lastPolledAt: Date.now() }, metadata: { lastProviderEvent: 'provider.polling', mvRecovery: payload.recovery || null } });
      await event('provider.polling', payload).catch(() => undefined);
    },
    async providerResponse(payload = {}) {
      await patch({
        requestId: payload.requestId ? String(payload.requestId) : undefined,
        httpStatus: Number.isFinite(Number(payload.upstreamHttpStatus ?? payload.transportHttpStatus)) ? Number(payload.upstreamHttpStatus ?? payload.transportHttpStatus) : undefined,
        usage: payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : undefined,
        timestamps: { respondedAt: Date.now() },
        metadata: { lastProviderEvent: 'provider.response', httpStatusSource: payload.upstreamHttpStatus ? 'upstream' : 'local-backend', providerSubmission: { version: 1, slot: input.jobId, submissionKey, state: 'responded', respondedAt: Date.now() } },
      });
      await event('provider.response', payload).catch(() => undefined);
    },
    async output(payload = {}) {
      if (reporter.signal?.aborted) throw new DOMException('父运行已停止；禁止开始产物下载与持久化。', 'AbortError');
      const assets = Array.isArray(payload.assets) ? payload.assets : [];
      if (assets.length) {
        const { assets: _assets, ...eventPayload } = payload;
        const persisted = await persistProjectRunOutputAssets(runId, nodeRunId, { attemptId: durableAttemptId, outputs: assets as any, eventPayload: { ...basePayload, ...eventPayload } }, { signal: reporter.signal });
        if (reporter.signal?.aborted) throw new DOMException('父运行已停止；产物响应不再被采纳。', 'AbortError');
        return persisted.assets;
      } else {
        throw new Error('MV child output 必须包含至少一个持久产物');
      }
    },
    async succeed(payload = {}) {
      if (reporter.signal?.aborted) throw new DOMException('父运行已停止；禁止把迟到结果写成成功。', 'AbortError');
      await patch({ status: 'succeeded', timestamps: { finishedAt: Date.now() }, metadata: { mvChildAttempt: true, jobId: input.jobId, jobKind: input.jobKind, providerSubmission: { version: 1, slot: input.jobId, submissionKey, state: 'verified', verifiedAt: Date.now() }, ...payload } });
      await event('log', { level: 'info', message: 'MV child attempt succeeded', ...payload }).catch(() => undefined);
    },
    async interrupt(message, payload = {}) {
      await patch({
        status: 'interrupted',
        timestamps: { finishedAt: Date.now() },
        error: { kind: 'cancelled', code: 'MV_CHILD_POLLING_INTERRUPTED', message, retryable: true },
        metadata: { mvChildAttempt: true, jobId: input.jobId, jobKind: input.jobKind, ...payload },
      });
      await event('log', { level: 'warn', message, recoverable: true, ...payload }).catch(() => undefined);
    },
    async fail(error, payload = {}) {
      const message = error instanceof Error ? error.message : String(error);
      await patch({ status: 'failed', timestamps: { finishedAt: Date.now() }, error: { kind: 'provider', message }, metadata: { mvChildAttempt: true, jobId: input.jobId, jobKind: input.jobKind, ...payload } });
      await event('log', { level: 'error', message, ...payload }).catch(() => undefined);
    },
  };
}
