'use strict';

const { explicitRunCost } = require('./runUsage');

const ACTIVE_STATUSES = new Set(['queued', 'running', 'polling']);
const RECOVERY_KINDS = new Set([
  'runninghub',
  'seedance',
  'seedream-nz',
  'wan',
  'happyhorse',
  'seed-audio',
  'suno',
  'image',
  'mj',
  'video',
  'image-fal',
  'video-fal',
]);

function boundedText(value, maxLength = 2048) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeRunRecoveryDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = boundedText(value.kind, 80).toLowerCase();
  if (!RECOVERY_KINDS.has(kind)) return null;
  const descriptor = {
    version: 1,
    kind,
    taskId: boundedText(value.taskId, 512) || null,
    taskIds: Array.isArray(value.taskIds) ? [...new Set(value.taskIds.map((item) => boundedText(item, 512)).filter(Boolean))].slice(0, 20) : [],
    requestId: boundedText(value.requestId, 512) || null,
    responseUrl: boundedText(value.responseUrl, 4096) || null,
    statusUrl: boundedText(value.statusUrl, 4096) || null,
    endpoint: boundedText(value.endpoint, 1024) || null,
    model: boundedText(value.model, 240) || null,
    site: ['cn', 'intl'].includes(boundedText(value.site, 20).toLowerCase()) ? boundedText(value.site, 20).toLowerCase() : null,
    taskProvider: ['seedance-nz', 'zhenzhen-legacy'].includes(boundedText(value.taskProvider, 80)) ? boundedText(value.taskProvider, 80) : null,
    speed: ['relax', 'fast', 'turbo'].includes(boundedText(value.speed, 20).toLowerCase()) ? boundedText(value.speed, 20).toLowerCase() : null,
    pollIntervalMs: Math.max(250, Math.min(30000, Math.trunc(Number(value.pollIntervalMs) || 3000))),
    maxPolls: Math.max(1, Math.min(7200, Math.trunc(Number(value.maxPolls) || 1200))),
  };
  if (kind === 'suno') return descriptor.taskIds.length ? descriptor : null;
  if (kind === 'image-fal' || kind === 'video-fal') {
    return descriptor.requestId && (descriptor.responseUrl || descriptor.endpoint) ? descriptor : null;
  }
  return descriptor.taskId ? descriptor : null;
}

function isRecoverableRunAttempt(attempt) {
  return Boolean(
    attempt
    && ACTIVE_STATUSES.has(String(attempt.status || ''))
    && normalizeRunRecoveryDescriptor(attempt.metadata?.recovery),
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recoveryRequest(baseUrl, descriptor) {
  const root = String(baseUrl || '').replace(/\/$/, '');
  const get = (path) => ({ url: `${root}${path}`, options: { method: 'GET' } });
  const post = (path, body) => ({
    url: `${root}${path}`,
    options: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  });
  const taskId = encodeURIComponent(descriptor.taskId || '');
  if (descriptor.kind === 'runninghub') return get(`/api/proxy/runninghub/query?taskId=${taskId}&site=${encodeURIComponent(descriptor.site || 'cn')}`);
  if (descriptor.kind === 'seedance') return get(`/api/proxy/seedance/query?taskId=${taskId}&taskProvider=${encodeURIComponent(descriptor.taskProvider || 'seedance-nz')}`);
  if (descriptor.kind === 'seedream-nz') return get(`/api/proxy/image/seedance-nz/status/${taskId}`);
  if (descriptor.kind === 'wan') return get(`/api/proxy/video/wan/status/${taskId}`);
  if (descriptor.kind === 'happyhorse') return get(`/api/proxy/video/happyhorse/status/${taskId}`);
  if (descriptor.kind === 'seed-audio') return get(`/api/proxy/audio/seed-audio/status/${taskId}`);
  if (descriptor.kind === 'suno') return get(`/api/proxy/audio/query?clipIds=${encodeURIComponent(descriptor.taskIds.join(','))}&saveLocal=true`);
  if (descriptor.kind === 'image') return get(`/api/proxy/image/status/${taskId}${descriptor.model ? `?model=${encodeURIComponent(descriptor.model)}` : ''}`);
  if (descriptor.kind === 'mj') return get(`/api/proxy/mj/task/${taskId}?speed=${encodeURIComponent(descriptor.speed || 'fast')}`);
  if (descriptor.kind === 'video') return get(`/api/proxy/video/query?taskId=${taskId}${descriptor.model ? `&model=${encodeURIComponent(descriptor.model)}` : ''}`);
  if (descriptor.kind === 'image-fal') return post('/api/proxy/image/fal/query', descriptor);
  if (descriptor.kind === 'video-fal') return post('/api/proxy/video/fal/query', descriptor);
  throw new Error(`不支持的恢复类型: ${descriptor.kind}`);
}

function normalizedState(value) {
  const state = boundedText(value, 120).toLowerCase();
  if (['success', 'succeeded', 'completed', 'complete', 'done'].includes(state)) return 'succeeded';
  if (['failure', 'failed', 'error', 'cancelled', 'canceled'].includes(state)) return 'failed';
  return 'pending';
}

function outputKindForDescriptor(descriptor) {
  if (descriptor.kind === 'seed-audio' || descriptor.kind === 'suno') return 'audio';
  if (['seedance', 'wan', 'happyhorse', 'video', 'video-fal'].includes(descriptor.kind)) return 'video';
  return 'image';
}

function normalizeRecoveryPayload(payload, descriptor) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  let state = normalizedState(data?.status ?? data?.state ?? data?.task_status ?? data?.code);
  if (descriptor.kind === 'runninghub') {
    if (String(data?.code) === '0') state = 'succeeded';
    else if (String(data?.code) === '805') state = 'failed';
  }
  if (descriptor.kind === 'suno' && Number(data?.total) > 0 && Number(data?.completed) >= Number(data?.total)) state = 'succeeded';
  const rawUrls = [
    ...(Array.isArray(data?.urls) ? data.urls : []),
    ...(Array.isArray(data?.imageUrls) ? data.imageUrls : []),
    data?.imageUrl,
    data?.videoUrl,
    data?.audioUrl,
    ...(Array.isArray(data?.tracks) ? data.tracks.map((track) => track?.audioUrl) : []),
  ].map((item) => boundedText(item, 16384)).filter(Boolean);
  const kind = outputKindForDescriptor(descriptor);
  return {
    state,
    outputs: [...new Set(rawUrls)].map((sourceUrl, index) => ({
      kind,
      sourceUrl,
      filename: `recovered-${descriptor.kind}-${index + 1}`,
    })),
    usage: data?.usage && typeof data.usage === 'object' ? data.usage : {},
    error: boundedText(data?.failReason || data?.error || payload?.error, 4000) || null,
    providerStatus: boundedText(data?.status ?? data?.state ?? data?.task_status ?? data?.code, 160) || null,
  };
}

async function queryRecoveryViaLocalApi(baseUrl, descriptor, fetchImpl = fetch) {
  const request = recoveryRequest(baseUrl, descriptor);
  const response = await fetchImpl(request.url, request.options);
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text.slice(0, 1000) }; }
  if (!response.ok) {
    const error = new Error(boundedText(payload?.error || `恢复查询 HTTP ${response.status}`, 4000));
    error.httpStatus = response.status;
    error.retryable = response.status >= 500 || response.status === 408 || response.status === 429;
    throw error;
  }
  return normalizeRecoveryPayload(payload, descriptor);
}

class RunRecoveryManager {
  constructor(options) {
    this.database = options.database;
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl || fetch;
    this.queryRecovery = options.queryRecovery || ((descriptor) => queryRecoveryViaLocalApi(this.baseUrl, descriptor, this.fetchImpl));
    this.wait = options.wait || wait;
    this.broadcast = options.broadcast || {};
    this.recordRunOutputAssets = options.recordRunOutputAssets
      || ((input) => this.database.recordRunOutputAssets(input));
    this.running = null;
    this.lastResult = { status: 'idle', recovered: 0, failed: 0, interrupted: 0, pending: 0, startedAt: null, finishedAt: null };
  }

  status() {
    return { ...this.lastResult, running: Boolean(this.running) };
  }

  recoverPendingRuns() {
    if (this.running) return this.running;
    this.running = this.runAll().finally(() => { this.running = null; });
    return this.running;
  }

  async runAll() {
    const tickets = this.database.listPendingRunRecoveries();
    const result = { status: 'running', recovered: 0, failed: 0, interrupted: 0, pending: tickets.length, startedAt: Date.now(), finishedAt: null };
    this.lastResult = result;
    for (let index = 0; index < tickets.length; index += 4) {
      const chunk = tickets.slice(index, index + 4);
      const settled = await Promise.all(chunk.map((ticket) => this.recoverTicket(ticket)));
      for (const state of settled) result[state] += 1;
      result.pending -= chunk.length;
      this.lastResult = { ...result };
    }
    result.status = 'completed';
    result.finishedAt = Date.now();
    this.lastResult = { ...result };
    return this.status();
  }

  async recoverTicket(ticket) {
    const descriptor = normalizeRunRecoveryDescriptor(ticket.attempt.metadata?.recovery);
    if (!descriptor) return this.interruptTicket(ticket, '恢复描述缺失或不受支持');
    const startedAt = Date.now();
    this.database.appendRunEvent(ticket.run.id, {
      nodeRunId: ticket.nodeRun.id,
      type: 'log',
      payload: { phase: 'recovery.started', attemptId: ticket.attempt.id, provider: ticket.attempt.provider, kind: descriptor.kind },
      createdAt: startedAt,
    });
    this.database.updateNodeRun(ticket.nodeRun.id, { status: 'polling' });
    this.database.updateAttempt(ticket.attempt.id, { status: 'polling', timestamps: { recoveryStartedAt: startedAt } });
    this.broadcast.node?.(ticket.run, this.database.getNodeRun(ticket.nodeRun.id));

    let lastError = null;
    for (let index = 0; index < descriptor.maxPolls; index += 1) {
      if (index > 0) await this.wait(descriptor.pollIntervalMs);
      try {
        const probe = await this.queryRecovery(descriptor, ticket, index);
        const pollCount = ticket.attempt.pollCount + index + 1;
        this.database.updateAttempt(ticket.attempt.id, {
          status: 'polling',
          pollCount,
          timestamps: { lastPolledAt: Date.now() },
          usage: probe.usage,
          metadata: { recovery: descriptor, recoveryProviderStatus: probe.providerStatus },
        });
        this.database.appendRunEvent(ticket.run.id, {
          nodeRunId: ticket.nodeRun.id,
          type: 'provider.polling',
          payload: { recovered: true, provider: ticket.attempt.provider, model: ticket.attempt.model, pollCount, status: probe.providerStatus },
        });
        if (probe.state === 'pending') continue;
        if (probe.state === 'failed') return this.failTicket(ticket, probe.error || '上游恢复查询返回失败');
        return await this.succeedTicket(ticket, probe.outputs, probe.usage);
      } catch (error) {
        lastError = error;
        if (error?.retryable === false || (Number(error?.httpStatus) >= 400 && Number(error?.httpStatus) < 500 && Number(error?.httpStatus) !== 408 && Number(error?.httpStatus) !== 429)) break;
      }
    }
    return this.interruptTicket(ticket, lastError?.message || '恢复轮询达到上限');
  }

  async succeedTicket(ticket, outputs, usage) {
    let nodeRun = this.database.getNodeRun(ticket.nodeRun.id);
    if (Array.isArray(outputs) && outputs.length > 0) {
      const recorded = await this.recordRunOutputAssets({
        runId: ticket.run.id,
        nodeRunId: ticket.nodeRun.id,
        attemptId: ticket.attempt.id,
        outputs,
      });
      nodeRun = recorded.nodeRun;
      this.database.appendRunEvent(ticket.run.id, {
        nodeRunId: ticket.nodeRun.id,
        type: 'node.output',
        payload: { recovered: true, outputRefs: nodeRun.outputRefs, assets: recorded.assets.map((asset) => ({ id: asset.id, kind: asset.kind, filename: asset.filename })) },
      });
      this.broadcast.output?.(ticket.run, nodeRun, recorded.assets);
    }
    const now = Date.now();
    this.database.updateAttempt(ticket.attempt.id, { status: 'succeeded', usage, timestamps: { finishedAt: now, recoveredAt: now }, error: null });
    nodeRun = this.database.updateNodeRun(ticket.nodeRun.id, { status: 'succeeded', outputRefs: nodeRun.outputRefs });
    this.database.appendRunEvent(ticket.run.id, { nodeRunId: ticket.nodeRun.id, type: 'provider.response', payload: { recovered: true, status: 'succeeded' } });
    this.database.appendRunEvent(ticket.run.id, { nodeRunId: ticket.nodeRun.id, type: 'node.succeeded', payload: { recovered: true, outputRefs: nodeRun.outputRefs } });
    this.broadcast.node?.(ticket.run, nodeRun);
    this.finalizeRun(ticket.run.id);
    return 'recovered';
  }

  failTicket(ticket, message) {
    const now = Date.now();
    const error = { kind: 'upstream', code: 'RUN_RECOVERY_UPSTREAM_FAILED', message: boundedText(message, 4000), retryable: false };
    this.database.updateAttempt(ticket.attempt.id, { status: 'failed', timestamps: { finishedAt: now, recoveryFailedAt: now }, error });
    const nodeRun = this.database.updateNodeRun(ticket.nodeRun.id, { status: 'failed' });
    this.database.appendRunEvent(ticket.run.id, { nodeRunId: ticket.nodeRun.id, type: 'provider.response', payload: { recovered: true, status: 'failed', error } });
    this.database.appendRunEvent(ticket.run.id, { nodeRunId: ticket.nodeRun.id, type: 'node.failed', payload: { recovered: true, error } });
    this.broadcast.node?.(ticket.run, nodeRun);
    this.finalizeRun(ticket.run.id);
    return 'failed';
  }

  interruptTicket(ticket, message) {
    const now = Date.now();
    const error = { kind: 'protocol', code: 'RUN_RECOVERY_UNAVAILABLE', message: boundedText(message, 4000), retryable: true };
    this.database.updateAttempt(ticket.attempt.id, { status: 'interrupted', timestamps: { finishedAt: now, recoveryInterruptedAt: now }, error });
    const nodeRun = this.database.updateNodeRun(ticket.nodeRun.id, { status: 'interrupted' });
    this.database.appendRunEvent(ticket.run.id, { nodeRunId: ticket.nodeRun.id, type: 'node.interrupted', payload: { recovered: true, error } });
    this.broadcast.node?.(ticket.run, nodeRun);
    this.finalizeRun(ticket.run.id);
    return 'interrupted';
  }

  finalizeRun(runId) {
    const finalize = this.database.db.transaction(() => {
      const run = this.database.getRun(runId);
      if (!run || !ACTIVE_STATUSES.has(run.status)) {
        return { run, intent: null, finalized: false };
      }
      const nodeRuns = this.database.listNodeRuns(run.id);
      if (nodeRuns.some((nodeRun) => ACTIVE_STATUSES.has(nodeRun.status))) {
        return { run, intent: null, finalized: false };
      }
      const statuses = new Set(nodeRuns.map((nodeRun) => nodeRun.status));
      const status = statuses.has('failed') ? 'failed' : statuses.has('interrupted') ? 'interrupted' : statuses.has('stopped') ? 'stopped' : 'succeeded';
      const finished = this.database.updateRun(run.id, {
        status,
        finishedAt: Date.now(),
        summary: { recoveredAfterRestart: true },
      });
      this.database.appendRunEvent(run.id, {
        type: `run.${status}`,
        payload: { status, recoveredAfterRestart: true },
      });
      const intent = this.database.finishRunIntentForRun(
        run.id,
        status,
        explicitRunCost(this.database.listRunAttempts(run.id)),
      );
      return { run: finished, intent, finalized: true };
    });
    const result = finalize.immediate();
    if (result.finalized) {
      this.broadcast.run?.(result.run);
      if (result.intent) this.broadcast.intent?.(result.intent);
    }
    return result.run;
  }
}

let singleton = null;

function getRunRecoveryManager(options) {
  if (!singleton) singleton = new RunRecoveryManager(options);
  return singleton;
}

module.exports = {
  ACTIVE_STATUSES,
  RECOVERY_KINDS,
  normalizeRunRecoveryDescriptor,
  isRecoverableRunAttempt,
  recoveryRequest,
  normalizeRecoveryPayload,
  queryRecoveryViaLocalApi,
  RunRecoveryManager,
  getRunRecoveryManager,
};
