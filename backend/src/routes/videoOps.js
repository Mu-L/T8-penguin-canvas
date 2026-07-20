/**
 * Lightweight video editing operations.
 *
 * The frontend owns clip ordering / trimming UI. This route uses the bundled
 * ffmpeg runtime to probe sources and stitch normalized MP4 segments.
 */
const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const config = require('../config');
const { resolveBundledFfmpeg, resolveBundledFfprobe } = require('../providers/llmMedia');
const {
  getProjectDatabase,
  translateProjectDatabaseStorageCapacityError,
} = require('../services/projectDatabase');
const {
  PROJECT_DATABASE_STORAGE_CAPACITY_CODE,
  sendProjectDatabaseStorageCapacityError,
} = require('../services/projectDatabasePublicError');
const { isLoopbackAddress, safeRemoteMediaDownload } = require('../utils/safeRemoteMediaFetch');

function loadVideoTransitionCatalog() {
  const candidates = [];
  const resRoot = process.env.T8PC_RES;
  if (resRoot) {
    candidates.push(path.join(resRoot, 'shared', 'videoTransitions.json'));
  }
  // source fallback for dev / test runs outside the Electron resources folder
  candidates.push(path.resolve(__dirname, '..', '..', '..', 'shared', 'videoTransitions.json'));
  for (const file of candidates) {
    try {
      if (!file || !fs.existsSync(file)) continue;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      console.warn('[videoOps] failed to load transition catalog:', file, error?.message || error);
    }
  }
  return { transitions: [] };
}

const videoTransitionCatalog = loadVideoTransitionCatalog();

const router = express.Router();
const jobs = new Map();
const MAX_CLIPS = 80;
const MAX_REMOTE_VIDEO_BYTES = Math.max(20 * 1024 * 1024, Number(process.env.T8_VIDEO_OPS_MAX_REMOTE_BYTES) || 512 * 1024 * 1024);
const REMOTE_VIDEO_DEADLINE_MS = Math.max(30_000, Number(process.env.T8_VIDEO_OPS_REMOTE_DEADLINE_MS) || 5 * 60 * 1000);
const REMOTE_VIDEO_IDLE_TIMEOUT_MS = Math.max(5_000, Number(process.env.T8_VIDEO_OPS_REMOTE_IDLE_TIMEOUT_MS) || 30_000);
const FFMPEG_TIMEOUT_MS = Math.max(30_000, Number(process.env.T8_VIDEO_OPS_TIMEOUT_MS || 15 * 60 * 1000));
const JOB_TTL_MS = Math.max(60_000, Number(process.env.T8_VIDEO_OPS_JOB_TTL_MS || 30 * 60 * 1000));
const MAX_RETAINED_JOBS = Math.max(20, Number(process.env.T8_VIDEO_OPS_MAX_JOBS || 200));
const VIDEO_OPS_SHUTDOWN_TIMEOUT_MS = Math.max(
  100,
  Math.min(30_000, Number(process.env.T8_VIDEO_OPS_SHUTDOWN_TIMEOUT_MS) || 5_000),
);
const VIDEO_TRANSITIONS = Array.isArray(videoTransitionCatalog.transitions) ? videoTransitionCatalog.transitions : [];
const VIDEO_TRANSITIONS_BY_ID = new Map(VIDEO_TRANSITIONS.map((item) => [item.id, item]));
const NO_TRANSITION_DEFINITION = { id: 'none', label: '无转场', category: 'basic', quality: 'cut' };
const AUDIO_VOLUME_CURVES = new Set(['flat', 'linear-up', 'linear-down', 'duck']);
let nativeXfadeSupportCache = null;

const TERMINAL_JOB_STATUSES = new Set(['done', 'failed', 'cancelled']);
const VIDEO_OPERATION_EXECUTION_SCHEMA = 't8-video-operation-execution-v1';
const VIDEO_OPERATION_EVIDENCE_SCHEMA = 't8-video-operation-run-evidence-v1';
const VIDEO_OPERATION_INPUT_SCHEMA = 't8-video-operation-input-v1';
const VIDEO_OPERATION_ACTIONS = new Map([
  ['video-edit.compose', 'compose'],
  ['video-edit.platform-export', 'platform-export'],
  ['video-edit.separate-audio', 'separate-audio'],
  ['video-edit.snapshot', 'snapshot'],
]);
const SYNTHETIC_VIDEO_OPERATION_SCOPE = Object.freeze({
  projectId: 'system-local-video-ops',
  canvasId: 'system-local-video-ops',
  nodeId: 'system-local-video-edit',
  initiatorId: 'local-owner',
});
let executionDatabaseOverride;
let asyncComposeExecutorOverride;
const operationExecutorOverrides = new Map();
let videoOperationsShutdownRequested = false;
let videoOperationsShutdownPromise = null;
const activeAsyncVideoOperations = new Set();
const asyncVideoOperationDrainWaiters = new Set();

function executionDatabase() {
  return executionDatabaseOverride === undefined
    ? getProjectDatabase(config)
    : executionDatabaseOverride;
}

function withVideoOperationDatabaseWrite(database, operation, callback) {
  try {
    return database.withProjectDatabaseWrite(operation, callback);
  } catch (error) {
    throw translateProjectDatabaseStorageCapacityError(error, { operation });
  }
}

function rethrowVideoOperationStorageCapacityError(error, operation) {
  const translated = translateProjectDatabaseStorageCapacityError(error, { operation });
  if (translated?.code === PROJECT_DATABASE_STORAGE_CAPACITY_CODE) throw translated;
}

function hasOwn(value, key) {
  return !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

function isLoopbackVideoOpsRequest(req) {
  const address = String(req?.socket?.remoteAddress || '').trim().toLowerCase();
  return address === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(address)
    || /^::ffff:127(?:\.\d{1,3}){3}$/.test(address);
}

function cloneCanonicalJson(value, fallback) {
  const selected = value === undefined ? fallback : value;
  return JSON.parse(JSON.stringify(selected));
}

function fnv1a32Hex(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(String(value), 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function syntheticExecutionError(message, statusCode = 503) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function durableExecutionConflict(message = '视频任务持久执行证据发生碰撞') {
  const error = syntheticExecutionError(message, 409);
  error.code = 'video_operation_execution_conflict';
  return error;
}

function evidenceString(value, pattern, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || !pattern.test(text)) throw new Error(`视频任务缺少有效 ${label}`);
  return text;
}

function normalizeVideoOperationExecutionEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('视频操作必须绑定持久 Run 执行证据');
  }
  const actionId = evidenceString(value.actionId, /^video-edit\.(?:compose|platform-export|separate-audio|snapshot)$/, 'actionId');
  const actionTarget = evidenceString(value.actionTarget, /^(?:compose|platform-export|separate-audio|snapshot)$/, 'actionTarget');
  if (VIDEO_OPERATION_ACTIONS.get(actionId) !== actionTarget) throw new Error('视频任务 actionId/target 不匹配');
  const operationIndex = Number(value.operationIndex);
  if (!Number.isSafeInteger(operationIndex) || operationIndex < 0 || operationIndex > 63) {
    throw new Error('视频任务 operationIndex 无效');
  }
  return {
    schema: evidenceString(value.schema, /^t8-video-operation-execution-v1$/, 'schema'),
    projectId: evidenceString(value.projectId, /^[^\u0000-\u001f\u007f]{1,256}$/, 'projectId'),
    canvasId: evidenceString(value.canvasId, /^[^\u0000-\u001f\u007f]{1,256}$/, 'canvasId'),
    runId: evidenceString(value.runId, /^[^\u0000-\u001f\u007f]{1,256}$/, 'runId'),
    nodeRunId: evidenceString(value.nodeRunId, /^[^\u0000-\u001f\u007f]{1,256}$/, 'nodeRunId'),
    attemptId: evidenceString(value.attemptId, /^[^\u0000-\u001f\u007f]{1,256}$/, 'attemptId'),
    nodeId: evidenceString(value.nodeId, /^[^\u0000-\u001f\u007f]{1,256}$/, 'nodeId'),
    requestId: evidenceString(value.requestId, /^[a-zA-Z0-9._:-]{8,160}$/, 'requestId'),
    actionId,
    actionTarget,
    actionDigest: evidenceString(value.actionDigest, /^fnv1a32:[a-f0-9]{8}$/, 'actionDigest'),
    inputDigest: evidenceString(value.inputDigest, /^sha256:[a-f0-9]{64}$/, 'inputDigest'),
    operationIndex,
  };
}

function requireVideoOperationExecutionAuthority(evidence, options = {}) {
  const database = executionDatabase();
  if (!database) throw new Error('视频任务持久执行存储不可用');
  const run = database.getRun(evidence.runId);
  const nodeRun = database.getNodeRun(evidence.nodeRunId);
  const attempt = database.getAttempt(evidence.attemptId);
  if (!run || !nodeRun || !attempt) throw new Error('视频任务引用的 Run/NodeRun/Attempt 不存在');
  if (run.projectId !== evidence.projectId || run.canvasId !== evidence.canvasId
    || nodeRun.runId !== run.id || nodeRun.nodeId !== evidence.nodeId
    || attempt.nodeRunId !== nodeRun.id) {
    throw new Error('视频任务 Run/NodeRun/Attempt 关系不匹配');
  }
  if (options.allowTerminalRun !== true && ['succeeded', 'failed', 'stopped', 'interrupted'].includes(String(run.status))) {
    throw new Error('视频任务不能绑定已终止 Run');
  }
  const summary = run.summary && typeof run.summary === 'object' ? run.summary : {};
  if (summary.runRequestId !== evidence.requestId
    || summary.secondaryProviderActionId !== evidence.actionId
    || summary.secondaryProviderActionTarget !== evidence.actionTarget
    || summary.secondaryProviderActionDigest !== evidence.actionDigest
    || summary.secondaryProviderActionInputDigest !== evidence.inputDigest
    || !Array.isArray(summary.plannedNodeIds) || summary.plannedNodeIds.length !== 1
    || summary.plannedNodeIds[0] !== evidence.nodeId
    || !Array.isArray(summary.authorizedNodeIds) || summary.authorizedNodeIds.length !== 1
    || summary.authorizedNodeIds[0] !== evidence.nodeId) {
    throw new Error('视频任务未绑定当前已确认的不可篡改 action');
  }
  return database;
}

function stableVideoOperationJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableVideoOperationJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableVideoOperationJson(value[key])}`).join(',')}}`;
}

function normalizeSeparateAudioMode(value) {
  return ['audio-only', 'mute-video', 'both'].includes(value) ? value : 'both';
}

function normalizeSnapshotTime(value) {
  const time = Number(value);
  return Number.isFinite(time) ? Math.max(0, time) : 0;
}

function normalizeSnapshotFormat(value) {
  return String(value || 'png').toLowerCase() === 'jpg' ? 'jpg' : 'png';
}

function buildVideoOperationBinding(action, body = {}) {
  if (action === 'compose') {
    const renderPlan = cloneCanonicalJson(resolveVideoEditRenderPlanPayload(body), {});
    const clips = cloneCanonicalJson(resolveVideoEditClipPayload({ ...body, renderPlan }), []);
    const settings = cloneCanonicalJson(body?.settings, {});
    const timelineV2 = cloneCanonicalJson(body?.timelineV2, null);
    return {
      action,
      clips,
      settings,
      timelineV2,
      renderPlan,
      executionInput: {
        schema: 't8-video-edit-execution-input-v1',
        mode: 'compose',
        clips,
        settings,
        timelineV2,
        renderPlan,
        packageIds: [],
        operationSettings: [settings],
      },
    };
  }
  if (action === 'separate-audio') {
    const renderPlan = cloneCanonicalJson(resolveVideoEditRenderPlanPayload(body), {});
    const clips = cloneCanonicalJson(resolveVideoEditClipPayload({ ...body, renderPlan }), []);
    const settings = cloneCanonicalJson(body?.settings, {});
    const timelineV2 = cloneCanonicalJson(body?.timelineV2, null);
    const mode = normalizeSeparateAudioMode(body?.mode);
    return {
      action,
      clips,
      settings,
      timelineV2,
      renderPlan,
      mode,
      executionInput: {
        schema: VIDEO_OPERATION_INPUT_SCHEMA,
        action,
        clips,
        settings,
        timelineV2,
        renderPlan,
        mode,
      },
    };
  }
  if (action === 'snapshot') {
    const clip = cloneCanonicalJson(body?.clip, null);
    const time = normalizeSnapshotTime(body?.time);
    const format = normalizeSnapshotFormat(body?.format);
    const sourceLabel = String(body?.sourceLabel || clip?.name || clip?.sourceLabel || '视频截图');
    return {
      action,
      clip,
      time,
      format,
      sourceLabel,
      executionInput: {
        schema: VIDEO_OPERATION_INPUT_SCHEMA,
        action,
        clip,
        time,
        format,
        sourceLabel,
      },
    };
  }
  throw new Error(`不支持持久执行的视频操作：${action}`);
}

function createSyntheticVideoOperationExecution(actionOrBody, maybeBody) {
  const action = typeof actionOrBody === 'string' ? actionOrBody : 'compose';
  const body = typeof actionOrBody === 'string' ? (maybeBody || {}) : (actionOrBody || {});
  let database;
  try {
    database = executionDatabase();
  } catch (error) {
    rethrowVideoOperationStorageCapacityError(error, 'video.execution.open');
    throw syntheticExecutionError(`本地视频任务持久执行存储不可用：${error?.message || String(error)}`);
  }
  if (!database) throw syntheticExecutionError('本地视频任务持久执行存储不可用');

  // The compatibility bridge deliberately ignores every client-supplied
  // identity. It binds a fixed local-system scope to the exact canonical
  // ffmpeg input that this route will execute.
  const binding = buildVideoOperationBinding(action, body);
  const executionInput = binding.executionInput;
  const inputDigest = `sha256:${crypto.createHash('sha256').update(stableVideoOperationJson(executionInput), 'utf8').digest('hex')}`;
  const requestId = `video-edit-local:${action}:${crypto.randomUUID()}`;
  const actionId = `video-edit.${action}`;
  const actionTarget = action;
  if (VIDEO_OPERATION_ACTIONS.get(actionId) !== actionTarget) {
    throw syntheticExecutionError(`本地视频任务 action 不受支持：${action}`);
  }
  const actionDigest = `fnv1a32:${fnv1a32Hex(stableVideoOperationJson({
    schema: VIDEO_OPERATION_EXECUTION_SCHEMA,
    requestId,
    actionId,
    actionTarget,
    inputDigest,
  }))}`;
  const runId = crypto.randomUUID();
  const nodeRunId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const evidence = {
    schema: VIDEO_OPERATION_EXECUTION_SCHEMA,
    ...SYNTHETIC_VIDEO_OPERATION_SCOPE,
    runId,
    nodeRunId,
    attemptId,
    requestId,
    actionId,
    actionTarget,
    actionDigest,
    inputDigest,
    operationIndex: 0,
  };
  const now = Date.now();

  try {
    withVideoOperationDatabaseWrite(database, 'video.execution.synthetic-create', () => {
      database.createRun({
        id: runId,
        projectId: SYNTHETIC_VIDEO_OPERATION_SCOPE.projectId,
        canvasId: SYNTHETIC_VIDEO_OPERATION_SCOPE.canvasId,
        canvasRevision: 0,
        initiatorId: SYNTHETIC_VIDEO_OPERATION_SCOPE.initiatorId,
        status: 'running',
        startedAt: now,
        summary: {
          runRequestId: requestId,
          plannedNodeIds: [SYNTHETIC_VIDEO_OPERATION_SCOPE.nodeId],
          authorizedNodeIds: [SYNTHETIC_VIDEO_OPERATION_SCOPE.nodeId],
          secondaryProviderActionId: actionId,
          secondaryProviderActionTarget: actionTarget,
          secondaryProviderActionDigest: actionDigest,
          secondaryProviderActionInputDigest: inputDigest,
          syntheticVideoOperation: true,
          syntheticScope: 'system/local-video-ops',
        },
      });
      database.createNodeRun({
        id: nodeRunId,
        runId,
        nodeId: SYNTHETIC_VIDEO_OPERATION_SCOPE.nodeId,
        status: 'running',
        inputSnapshot: executionInput,
      });
      database.createAttempt({
        id: attemptId,
        nodeRunId,
        provider: 'local-video-ops',
        model: `ffmpeg-${action}`,
        requestId,
        status: 'running',
        timestamps: { queuedAt: now, startedAt: now },
        metadata: {
          syntheticVideoOperation: true,
          actionDigest,
          inputDigest,
        },
      });
      return evidence;
    });
  } catch (error) {
    rethrowVideoOperationStorageCapacityError(error, 'video.execution.synthetic-create');
    throw syntheticExecutionError(
      `无法原子建立本地视频 Run/NodeRun/Attempt，已停止 ffmpeg：${error?.message || String(error)}`,
    );
  }

  return { evidence, ...binding };
}

function syntheticTerminalStatus(job) {
  if (job?.status === 'done') return 'succeeded';
  if (job?.status === 'cancelled') return 'stopped';
  if (job?.status === 'interrupted') return 'interrupted';
  return 'failed';
}

function finalizeSyntheticVideoOperationExecution(job, persistenceError, phase = 'terminal-fallback') {
  if (!job?.syntheticExecution || !job.executionEvidence) return null;
  const database = requireVideoOperationExecutionAuthority(job.executionEvidence, { allowTerminalRun: true });
  const evidence = job.executionEvidence;
  const status = syntheticTerminalStatus(job);
  const now = Date.now();
  const message = String(
    job.error
      || persistenceError?.message
      || (status === 'succeeded' ? '本地视频任务完成' : '本地视频任务失败'),
  ).slice(0, 2048);
  const error = status === 'succeeded' ? null : {
    kind: status === 'stopped' ? 'cancelled' : status === 'interrupted' ? 'protocol' : 'persistence',
    code: status === 'stopped'
      ? 'VIDEO_OPERATION_STOPPED'
      : status === 'interrupted'
        ? 'VIDEO_OPERATION_INTERRUPTED'
        : 'VIDEO_OPERATION_EVIDENCE_FAILED',
    message,
    retryable: status !== 'succeeded',
  };
  withVideoOperationDatabaseWrite(database, 'video.execution.synthetic-finalize', () => {
    database.updateAttempt(evidence.attemptId, {
      status,
      timestamps: { finishedAt: now, respondedAt: now },
      error,
      metadata: { lastProviderEvent: 'provider.response', syntheticTerminalFallback: phase },
    }, { runId: evidence.runId, nodeRunId: evidence.nodeRunId });
    database.updateNodeRun(evidence.nodeRunId, { status });
    database.updateRun(evidence.runId, {
      status,
      finishedAt: now,
      summary: {
        syntheticVideoOperationTerminal: phase,
        ...(error ? { syntheticVideoOperationError: error } : {}),
      },
    });
  });

  // Status durability has priority. Preserve a reconstructable job event when
  // the event writer itself was only transiently unavailable, without rolling
  // the terminal trio back if that second write also fails.
  let eventPersistence = { ok: true };
  try {
    withVideoOperationDatabaseWrite(database, 'video.execution.synthetic-fallback-event', () => {
      database.appendRunEvent(evidence.runId, {
        nodeRunId: evidence.nodeRunId,
        type: 'log',
        payload: videoOperationEventPayload(job, phase, {
          persistenceError: persistenceError?.message || String(persistenceError || ''),
        }),
      });
    });
  } catch (eventError) {
    const translated = translateProjectDatabaseStorageCapacityError(eventError, {
      operation: 'video.execution.synthetic-fallback-event',
    });
    eventPersistence = translated?.code === PROJECT_DATABASE_STORAGE_CAPACITY_CODE
      ? {
        ok: false,
        code: translated.code,
        reason: translated.reason,
        retryable: translated.retryable,
      }
      : {
        ok: false,
        code: 'video_operation_fallback_event_failed',
        retryable: true,
      };
    job.persistenceWarning = eventPersistence;
  }
  return {
    status,
    runId: evidence.runId,
    nodeRunId: evidence.nodeRunId,
    attemptId: evidence.attemptId,
    eventPersistence,
  };
}

function validateVideoOperationInputBinding(body, rawEvidence, expectedAction = null) {
  const evidence = normalizeVideoOperationExecutionEvidence(rawEvidence);
  const evidenceAction = evidence.actionTarget === 'platform-export' ? 'compose' : evidence.actionTarget;
  if (expectedAction && evidenceAction !== expectedAction) {
    throw new Error('视频任务 executionEvidence 与当前路由 action 不匹配');
  }
  const snapshot = body?.executionInput;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('视频任务缺少不可篡改 executionInput');
  }
  const digest = `sha256:${crypto.createHash('sha256').update(stableVideoOperationJson(snapshot), 'utf8').digest('hex')}`;
  if (digest !== evidence.inputDigest) throw new Error('视频任务 executionInput 摘要不匹配');
  if (evidenceAction === 'separate-audio' || evidenceAction === 'snapshot') {
    if (snapshot.schema !== VIDEO_OPERATION_INPUT_SCHEMA || snapshot.action !== evidenceAction) {
      throw new Error('视频任务 executionInput 结构与 action 不匹配');
    }
    const canonical = buildVideoOperationBinding(evidenceAction, body).executionInput;
    if (stableVideoOperationJson(snapshot) !== stableVideoOperationJson(canonical)) {
      throw new Error('视频任务实际操作参数与已确认输入快照不一致');
    }
    return evidence;
  }
  if (snapshot.schema !== 't8-video-edit-execution-input-v1') {
    throw new Error('视频任务 executionInput 结构与 action 不匹配');
  }
  const expectedMode = evidence.actionId === 'video-edit.compose' ? 'compose' : 'platform-export';
  if (snapshot.mode !== expectedMode || !Array.isArray(snapshot.clips)
    || !Array.isArray(snapshot.packageIds) || !Array.isArray(snapshot.operationSettings)
    || snapshot.operationSettings.length !== (expectedMode === 'compose' ? 1 : snapshot.packageIds.length)
    || evidence.operationIndex >= snapshot.operationSettings.length) {
    throw new Error('视频任务 executionInput 结构与 action 不匹配');
  }
  if (stableVideoOperationJson(body?.clips) !== stableVideoOperationJson(snapshot.clips)
    || stableVideoOperationJson(body?.settings) !== stableVideoOperationJson(snapshot.operationSettings[evidence.operationIndex])
    || stableVideoOperationJson(body?.timelineV2) !== stableVideoOperationJson(snapshot.timelineV2)
    || stableVideoOperationJson(body?.renderPlan) !== stableVideoOperationJson(snapshot.renderPlan)) {
    throw new Error('视频任务实际合成参数与已确认输入快照不一致');
  }
  return evidence;
}

function videoOperationEventPayload(job, phase, patch = {}) {
  return {
    schema: VIDEO_OPERATION_EVIDENCE_SCHEMA,
    phase,
    videoOperation: {
      jobId: job.id,
      action: job.action,
      status: job.status,
      progress: Number(job.progress || 0),
      message: job.message || '',
      syntheticExecution: job.syntheticExecution === true,
      executionEvidence: job.executionEvidence,
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error, errorCode: job.errorCode || 'video-ops-failed' } : {}),
      ...patch,
    },
  };
}

function persistVideoOperationEvent(job, phase, patch = {}) {
  if (!job?.executionEvidence) return null;
  const database = requireVideoOperationExecutionAuthority(job.executionEvidence, {
    allowTerminalRun: phase !== 'accepted',
  });
  const evidence = job.executionEvidence;
  const event = withVideoOperationDatabaseWrite(database, 'video.execution.event-persist', () => {
    const event = database.appendRunEvent(evidence.runId, {
      nodeRunId: evidence.nodeRunId,
      type: 'log',
      payload: videoOperationEventPayload(job, phase, patch),
    });
    const currentAttempt = database.getAttempt(evidence.attemptId);
    const terminalStatus = job.syntheticExecution && (phase === 'terminal' || phase === 'interrupted')
      ? syntheticTerminalStatus(job)
      : null;
    const terminalError = terminalStatus && terminalStatus !== 'succeeded'
      ? {
          kind: terminalStatus === 'stopped' ? 'cancelled' : terminalStatus === 'interrupted' ? 'protocol' : 'execution',
          code: terminalStatus === 'stopped'
            ? 'VIDEO_OPERATION_STOPPED'
            : terminalStatus === 'interrupted'
              ? 'VIDEO_OPERATION_INTERRUPTED'
              : 'VIDEO_OPERATION_FAILED',
          message: String(job.error || job.message || '本地视频任务失败').slice(0, 2048),
          retryable: terminalStatus !== 'succeeded',
        }
      : undefined;
    database.updateAttempt(evidence.attemptId, {
      provider: 'local-video-ops',
      model: `ffmpeg-${job.action}`,
      upstreamTaskId: job.id,
      requestId: evidence.requestId,
      pollCount: phase === 'progress' ? Number(currentAttempt?.pollCount || 0) + 1 : undefined,
      status: terminalStatus || undefined,
      timestamps: {
        ...(phase === 'accepted' ? { submittedAt: Date.now() } : {}),
        ...(phase === 'progress' ? { lastPolledAt: Date.now() } : {}),
        ...(phase === 'terminal' || phase === 'interrupted' ? { respondedAt: Date.now(), finishedAt: Date.now() } : {}),
      },
      ...(terminalError !== undefined ? { error: terminalError } : {}),
      metadata: {
        lastProviderEvent: phase === 'accepted' ? 'provider.submitted' : phase === 'progress' ? 'provider.polling' : 'provider.response',
        videoOperationBridge: {
          schema: VIDEO_OPERATION_EVIDENCE_SCHEMA,
          jobId: job.id,
          action: job.action,
          status: job.status,
          operationIndex: evidence.operationIndex,
          actionDigest: evidence.actionDigest,
          inputDigest: evidence.inputDigest,
        },
      },
    }, { runId: evidence.runId, nodeRunId: evidence.nodeRunId });
    if (terminalStatus) {
      const finishedAt = Date.now();
      database.updateNodeRun(evidence.nodeRunId, { status: terminalStatus });
      database.updateRun(evidence.runId, {
        status: terminalStatus,
        finishedAt,
        summary: {
          syntheticVideoOperationTerminal: phase,
          ...(terminalError ? { syntheticVideoOperationError: terminalError } : {}),
        },
      });
    }
    return event;
  });
  job._lastDurableFingerprint = `${job.status}:${Math.round(Number(job.progress || 0))}:${job.message || ''}`;
  return event;
}

function persistVideoOperationEventFailClosed(job, phase, patch = {}) {
  try {
    return persistVideoOperationEvent(job, phase, patch);
  } catch (error) {
    if (job?.syntheticExecution && (phase === 'terminal' || phase === 'interrupted')) {
      job.status = 'failed';
      job.message = `视频任务终态证据写入失败：${error?.message || String(error)}`;
      job.error = job.message;
      job.errorCode = 'video-ops-failed';
      job.finishedAt = Date.now();
      job.updatedAt = job.finishedAt;
      delete job.result;
      finalizeSyntheticVideoOperationExecution(job, error, 'terminal-persistence-failed');
    }
    throw error;
  }
}

function isTerminalJob(job) {
  return !!job && TERMINAL_JOB_STATUSES.has(job.status);
}

function cleanupFinishedJobs(now = Date.now(), ttlMs = JOB_TTL_MS) {
  let removed = 0;
  for (const [id, job] of jobs.entries()) {
    if (!isTerminalJob(job)) continue;
    const finishedAt = Number(job.finishedAt || job.updatedAt || job.createdAt || 0);
    if (finishedAt > 0 && now - finishedAt > ttlMs) {
      jobs.delete(id);
      removed += 1;
    }
  }
  if (jobs.size > MAX_RETAINED_JOBS) {
    const terminalJobs = Array.from(jobs.entries())
      .filter(([, job]) => isTerminalJob(job))
      .sort((a, b) => Number(a[1].finishedAt || a[1].updatedAt || a[1].createdAt || 0) - Number(b[1].finishedAt || b[1].updatedAt || b[1].createdAt || 0));
    for (const [id] of terminalJobs) {
      if (jobs.size <= MAX_RETAINED_JOBS) break;
      jobs.delete(id);
      removed += 1;
    }
  }
  return removed;
}

function classifyJobError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (/取消|cancel/.test(message)) return 'cancelled';
  if (/download|下载/.test(message)) return 'download-failed';
  if (/ffprobe|探测|probe/.test(message)) return 'probe-failed';
  if (/ffmpeg|xfade|concat|filter|codec|encoder|decoder|合成|标准化|抽取|处理/.test(message)) return 'ffmpeg-failed';
  if (/至少|没有|不支持|不存在|不可用|未知|太短|超过|不是视频|需要|invalid|unsupported|missing/.test(message)) return 'invalid-input';
  return 'video-ops-failed';
}

function finishJob(job, message = '完成', result = undefined, now = Date.now()) {
  if (!job) return null;
  job.status = 'done';
  job.progress = 100;
  job.message = message;
  job.result = result;
  job.finishedAt = now;
  job.updatedAt = now;
  job.child = null;
  delete job.error;
  delete job.errorCode;
  persistVideoOperationEventFailClosed(job, 'terminal');
  return job;
}

function videoOperationLifecycleError() {
  const error = new Error('视频处理服务正在关闭，请稍后重试');
  error.code = 'video_operations_shutting_down';
  error.statusCode = 503;
  return error;
}

function asyncVideoOperationStatus() {
  return { activeTasks: activeAsyncVideoOperations.size };
}

function resolveAsyncVideoOperationDrainWaiters() {
  if (activeAsyncVideoOperations.size !== 0) return;
  for (const waiter of asyncVideoOperationDrainWaiters) {
    clearTimeout(waiter.timer);
    waiter.resolve({ drained: true, ...asyncVideoOperationStatus() });
  }
  asyncVideoOperationDrainWaiters.clear();
}

function trackAsyncVideoOperation(task) {
  activeAsyncVideoOperations.add(task);
  const release = () => {
    activeAsyncVideoOperations.delete(task);
    resolveAsyncVideoOperationDrainWaiters();
  };
  Promise.resolve(task).then(release, release);
  return task;
}

function waitForAsyncVideoOperations(timeoutMs = null) {
  if (activeAsyncVideoOperations.size === 0) {
    return Promise.resolve({ drained: true, ...asyncVideoOperationStatus() });
  }
  const hasTimeout = timeoutMs !== null && timeoutMs !== undefined;
  const requestedTimeout = hasTimeout ? Number(timeoutMs) : Number.NaN;
  if (hasTimeout && Number.isFinite(requestedTimeout) && requestedTimeout <= 0) {
    return Promise.resolve({ drained: false, ...asyncVideoOperationStatus() });
  }
  return new Promise((resolve) => {
    const waiter = { resolve, timer: null };
    if (hasTimeout && Number.isFinite(requestedTimeout)) {
      waiter.timer = setTimeout(() => {
        asyncVideoOperationDrainWaiters.delete(waiter);
        resolve({ drained: false, ...asyncVideoOperationStatus() });
      }, requestedTimeout);
    }
    asyncVideoOperationDrainWaiters.add(waiter);
  });
}

function failJob(job, error, fallbackMessage = '视频处理失败', now = Date.now()) {
  if (!job) return null;
  const message = error?.message || fallbackMessage;
  const cancelled = job.cancelled || classifyJobError(error) === 'cancelled';
  job.status = cancelled ? 'cancelled' : 'failed';
  job.message = message;
  job.error = message;
  job.errorCode = cancelled ? 'cancelled' : classifyJobError(error);
  job.finishedAt = now;
  job.updatedAt = now;
  job.child = null;
  persistVideoOperationEventFailClosed(job, 'terminal');
  return job;
}

function cancelJob(job, message = '已取消', now = Date.now()) {
  if (!job) return null;
  job.cancelled = true;
  try { job.child?.kill('SIGKILL'); } catch (_) {}
  job.status = 'cancelled';
  job.message = message;
  job.error = message;
  job.errorCode = 'cancelled';
  job.finishedAt = now;
  job.updatedAt = now;
  job.child = null;
  persistVideoOperationEventFailClosed(job, 'terminal');
  return job;
}

function makeJob(action, rawExecutionEvidence, options = {}) {
  if (videoOperationsShutdownRequested) throw videoOperationLifecycleError();
  cleanupFinishedJobs();
  const executionEvidence = rawExecutionEvidence == null
    ? null
    : normalizeVideoOperationExecutionEvidence(rawExecutionEvidence);
  if (options.requireExecutionEvidence === true && !executionEvidence) {
    throw new Error('视频操作必须绑定持久 Run 执行证据');
  }
  if (executionEvidence) {
    const durableReplay = resolveDurableVideoOperationReplay(action, executionEvidence);
    if (durableReplay) return durableReplay;
    requireVideoOperationExecutionAuthority(executionEvidence);
  }
  const job = {
    id: `video-edit-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    action,
    status: 'running',
    progress: 0,
    message: '准备处理',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    child: null,
    cancelled: false,
    executionEvidence,
    syntheticExecution: options.syntheticExecution === true,
  };
  jobs.set(job.id, job);
  if (executionEvidence) {
    try {
      persistVideoOperationEvent(job, 'accepted');
    } catch (error) {
      jobs.delete(job.id);
      if (job.syntheticExecution) {
        job.status = 'failed';
        job.message = `视频任务入队证据写入失败：${error?.message || String(error)}`;
        job.error = job.message;
        job.errorCode = 'video-ops-failed';
        job.finishedAt = Date.now();
        job.updatedAt = job.finishedAt;
        finalizeSyntheticVideoOperationExecution(job, error, 'enqueue-persistence-failed');
      }
      throw error;
    }
  }
  return job;
}

function publicJob(job) {
  if (!job) return null;
  const {
    child,
    executionEvidence,
    syntheticExecution,
    _lastDurableFingerprint,
    _reusedDurableExecution,
    ...rest
  } = job;
  return {
    ...rest,
    ...(executionEvidence ? { durableEvidence: executionEvidence } : {}),
  };
}

function durableVideoOperationSlotEvents(evidence) {
  const database = requireVideoOperationExecutionAuthority(evidence, { allowTerminalRun: true });
  const rows = database.db.prepare(`
    SELECT id, payload_json
    FROM run_events
    WHERE run_id = ? AND node_run_id = ? AND type = 'log'
    ORDER BY id ASC
  `).all(evidence.runId, evidence.nodeRunId);
  const matches = [];
  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.payload_json || '{}');
    } catch (_) {
      continue;
    }
    if (payload?.schema !== VIDEO_OPERATION_EVIDENCE_SCHEMA) continue;
    const operation = payload?.videoOperation;
    const storedEvidence = operation?.executionEvidence;
    if (String(storedEvidence?.attemptId || '') !== evidence.attemptId
      || Number(storedEvidence?.operationIndex) !== evidence.operationIndex) continue;
    matches.push({ rowId: row.id, operation, storedEvidence });
  }
  return matches;
}

function resolveDurableVideoOperationReplay(action, evidence) {
  const events = durableVideoOperationSlotEvents(evidence);
  if (!events.length) return null;
  const expectedEvidence = stableVideoOperationJson(evidence);
  const jobIds = new Set();
  for (const event of events) {
    let normalized;
    try {
      normalized = normalizeVideoOperationExecutionEvidence(event.storedEvidence);
    } catch (_) {
      throw durableExecutionConflict('视频任务持久执行槽包含无效证据，已拒绝重放');
    }
    if (stableVideoOperationJson(normalized) !== expectedEvidence
      || String(event.operation?.action || '') !== String(action || '')) {
      throw durableExecutionConflict('同一 Attempt/operationIndex 已绑定不同视频任务');
    }
    const jobId = String(event.operation?.jobId || '');
    if (!jobId) throw durableExecutionConflict('视频任务持久执行槽缺少 jobId');
    jobIds.add(jobId);
  }
  if (jobIds.size !== 1) {
    throw durableExecutionConflict('同一视频执行证据已绑定多个 durable job');
  }
  const jobId = Array.from(jobIds)[0];
  const existing = jobs.get(jobId) || reconstructDurableVideoOperationJob(jobId);
  if (!existing || stableVideoOperationJson(existing.executionEvidence) !== expectedEvidence
    || String(existing.action || '') !== String(action || '')) {
    throw durableExecutionConflict('视频任务持久结果与执行证据不一致');
  }
  existing._reusedDurableExecution = true;
  return existing;
}

function readDurableVideoOperationEvents(jobId) {
  const database = executionDatabase();
  if (!database) return [];
  const rows = database.db.prepare(`
    SELECT id, run_id, node_run_id, payload_json, created_at
    FROM run_events
    WHERE type = 'log' AND payload_json LIKE ?
    ORDER BY id ASC
  `).all(`%${String(jobId)}%`);
  const out = [];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json || '{}');
      if (payload?.schema !== VIDEO_OPERATION_EVIDENCE_SCHEMA
        || payload?.videoOperation?.jobId !== jobId) continue;
      out.push({ ...row, payload });
    } catch (_) {}
  }
  return out;
}

function reconstructDurableVideoOperationJob(jobId) {
  const events = readDurableVideoOperationEvents(jobId);
  if (!events.length) return null;
  const latest = events[events.length - 1].payload.videoOperation;
  const evidence = latest.executionEvidence;
  const reconstructed = {
    id: jobId,
    action: latest.action,
    status: latest.status,
    progress: Number(latest.progress || 0),
    message: latest.message || '',
    createdAt: events[0].created_at,
    updatedAt: events[events.length - 1].created_at,
    finishedAt: TERMINAL_JOB_STATUSES.has(latest.status) || latest.status === 'interrupted'
      ? events[events.length - 1].created_at
      : null,
    ...(latest.result ? { result: latest.result } : {}),
    ...(latest.error ? { error: latest.error, errorCode: latest.errorCode || 'video-ops-failed' } : {}),
    executionEvidence: evidence,
    syntheticExecution: latest.syntheticExecution === true,
    child: null,
    cancelled: false,
  };
  if (!TERMINAL_JOB_STATUSES.has(reconstructed.status) && reconstructed.status !== 'interrupted') {
    reconstructed.status = 'interrupted';
    reconstructed.message = '视频任务在主机重启后中断';
    reconstructed.error = reconstructed.message;
    reconstructed.errorCode = 'video-ops-failed';
    reconstructed.finishedAt = Date.now();
    reconstructed.updatedAt = reconstructed.finishedAt;
    persistVideoOperationEvent(reconstructed, 'interrupted');
  }
  return reconstructed;
}

function persistVideoOperationProgress(job) {
  if (!job?.executionEvidence || isTerminalJob(job)) return;
  const fingerprint = `${job.status}:${Math.round(Number(job.progress || 0))}:${job.message || ''}`;
  if (fingerprint === job._lastDurableFingerprint) return;
  persistVideoOperationEvent(job, 'progress');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeOutputName(prefix, ext = '.mp4') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
}

function filePublicUrl(file) {
  return `/files/output/${path.basename(file)}`;
}

function getTransitionDefinition(value) {
  const id = String(value || 'none').trim();
  if (!id || id === 'none') return VIDEO_TRANSITIONS_BY_ID.get('none') || NO_TRANSITION_DEFINITION;
  const transition = VIDEO_TRANSITIONS_BY_ID.get(id);
  if (transition) return transition;
  if (VIDEO_TRANSITIONS_BY_ID.size === 0) {
    throw new Error(`视频转场目录不可用，无法使用高质量转场：${id}`);
  }
  throw new Error(`未知视频转场：${id}`);
}

function hasNativeXfadeSupport() {
  if (nativeXfadeSupportCache !== null) return nativeXfadeSupportCache;
  try {
    const result = spawnSync(resolveBundledFfmpeg(), ['-hide_banner', '-h', 'filter=xfade'], { encoding: 'utf8' });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    nativeXfadeSupportCache = result.status === 0 && /transition/.test(output) && /wipeleft/.test(output) && /circleopen/.test(output);
  } catch (_) {
    nativeXfadeSupportCache = false;
  }
  return nativeXfadeSupportCache;
}

function transitionDurationSeconds(settings, segments = []) {
  const desired = Math.max(0.1, Math.min(2, Number(settings?.transitionDuration) || 0.8));
  const durations = segments.map((item) => Number(item?.duration)).filter((n) => Number.isFinite(n) && n > 0);
  if (!durations.length) return desired;
  const shortest = Math.min(...durations);
  if (shortest <= 0.12) return 0;
  return Math.max(0.05, Math.min(desired, shortest - 0.05));
}

function nativeXfadeName(settings, transitionDefinition = null) {
  const transition = transitionDefinition || getTransitionDefinition(settings?.transition || 'none');
  if (transition.id === 'none' || !transition.xfade) return '';
  return String(transition.xfade || '').trim();
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function stripQuery(value) {
  return String(value || '').split('?')[0].split('#')[0];
}

function resolveMountedPath(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let clean = url.trim();
  if (isHttpUrl(clean)) {
    try {
      const parsed = new URL(clean);
      if (!isLoopbackAddress(parsed.hostname)) return null;
      clean = parsed.pathname;
    } catch {
      return null;
    }
  }
  clean = stripQuery(clean);
  const mounts = [
    { prefixes: ['/files/input/', '/input/'], dir: config.INPUT_DIR },
    { prefixes: ['/files/output/', '/output/'], dir: config.OUTPUT_DIR },
    { prefixes: ['/files/thumbnails/'], dir: config.THUMBNAILS_DIR },
  ];
  for (const mount of mounts) {
    const prefix = mount.prefixes.find((item) => clean.startsWith(item));
    if (!prefix) continue;
    const rel = decodeURIComponent(clean.slice(prefix.length));
    const base = path.resolve(mount.dir);
    const resolved = path.resolve(base, rel);
    if (resolved === base || !resolved.startsWith(base + path.sep)) return null;
    return resolved;
  }
  return null;
}

async function downloadRemoteVideo(url, targetDir, remoteFetchOptions = {}) {
  const parsed = new URL(url);
  const requestedExt = path.extname(stripQuery(parsed.pathname)).toLowerCase();
  const ext = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mpeg', '.mpg', '.ts', '.mts', '.m2ts']).has(requestedExt)
    ? requestedExt
    : '.mp4';
  const target = path.join(targetDir, safeOutputName('remote_video', ext));
  let keepTarget = false;
  try {
    const remote = await safeRemoteMediaDownload(url, target, {
      maxBytes: MAX_REMOTE_VIDEO_BYTES,
      deadlineMs: REMOTE_VIDEO_DEADLINE_MS,
      idleTimeoutMs: REMOTE_VIDEO_IDLE_TIMEOUT_MS,
      accept: 'video/*,application/octet-stream;q=0.8,*/*;q=0.1',
      userAgent: 'T8-PenguinCanvas-VideoOps/1.0',
      ...remoteFetchOptions,
    });
    const contentType = String(remote.contentType || '');
    if (contentType && !/^video\//i.test(contentType) && !/octet-stream/i.test(contentType)) {
      throw new Error(`远程地址不是视频文件: ${contentType}`);
    }
    keepTarget = true;
    return target;
  } finally {
    if (!keepTarget) await fsp.rm(target, { force: true });
  }
}

async function resolveVideoSource(url, targetDir) {
  const local = resolveMountedPath(url);
  if (local) {
    if (!fs.existsSync(local)) throw new Error(`本地视频不存在: ${path.basename(local)}`);
    return local;
  }
  if (isHttpUrl(url)) return downloadRemoteVideo(url, targetDir);
  throw new Error('不支持的视频地址');
}

function runFfmpeg(args, job, options = {}) {
  const ffmpeg = resolveBundledFfmpeg();
  const timeoutMs = options.timeoutMs || FFMPEG_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    if (job?.cancelled) {
      reject(new Error('任务已取消'));
      return;
    }
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = '';
    let stdout = '';
    let settled = false;
    if (job) job.child = child;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      if (job) job.child = null;
      reject(new Error('ffmpeg 处理超时'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 80_000) stderr = stderr.slice(-80_000);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (job) job.child = null;
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (job) job.child = null;
      if (job?.cancelled) {
        reject(new Error('任务已取消'));
        return;
      }
      if (options.allowFailure || code === 0) {
        resolve({ code, stdout, stderr });
      } else {
        const lastLine = stderr.trim().split(/\r?\n/).slice(-3).join('\n');
        reject(new Error(lastLine || `ffmpeg 失败: ${code}`));
      }
    });
  });
}

function runFfmpegBuffer(args, job, options = {}) {
  const ffmpeg = resolveBundledFfmpeg();
  const timeoutMs = options.timeoutMs || 90_000;
  const maxStdoutBytes = options.maxStdoutBytes || 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    if (job?.cancelled) {
      reject(new Error('任务已取消'));
      return;
    }
    const child = spawn(ffmpeg, args, { windowsHide: true });
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    if (job) job.child = child;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      if (job) job.child = null;
      reject(new Error('ffmpeg 处理超时'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        settled = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch (_) {}
        if (job) job.child = null;
        reject(new Error('音频波形数据过大'));
        return;
      }
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 80_000) stderr = stderr.slice(-80_000);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (job) job.child = null;
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (job) job.child = null;
      if (job?.cancelled) {
        reject(new Error('任务已取消'));
        return;
      }
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
      } else {
        const lastLine = stderr.trim().split(/\r?\n/).slice(-3).join('\n');
        reject(new Error(lastLine || `ffmpeg 失败: ${code}`));
      }
    });
  });
}

function runFfprobeJson(file, job, options = {}) {
  const ffprobe = resolveBundledFfprobe();
  const timeoutMs = options.timeoutMs || 45_000;
  const args = [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    file,
  ];
  return new Promise((resolve, reject) => {
    if (job?.cancelled) {
      reject(new Error('任务已取消'));
      return;
    }
    const child = spawn(ffprobe, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    if (job) job.child = child;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      if (job) job.child = null;
      reject(new Error('ffprobe 探测超时'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (job) job.child = null;
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (job) job.child = null;
      if (job?.cancelled) {
        reject(new Error('任务已取消'));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim().slice(0, 600) || `ffprobe 失败: ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch (error) {
        reject(new Error(`ffprobe JSON 解析失败: ${error?.message || error}`));
      }
    });
  });
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function ratioToNumber(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/);
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : undefined;
  }
  return finiteNumber(text);
}

function parseRotation(stream) {
  const values = [
    stream?.tags?.rotate,
    stream?.rotation,
    ...(Array.isArray(stream?.side_data_list) ? stream.side_data_list.map((item) => item?.rotation) : []),
  ];
  for (const value of values) {
    const n = finiteNumber(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function parseProbeJson(payload) {
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video') || {};
  const audio = streams.find((stream) => stream?.codec_type === 'audio') || {};
  const duration = finiteNumber(payload?.format?.duration)
    ?? finiteNumber(video.duration)
    ?? finiteNumber(audio.duration);
  const fps = ratioToNumber(video.avg_frame_rate) ?? ratioToNumber(video.r_frame_rate);
  return {
    duration,
    width: finiteNumber(video.width),
    height: finiteNumber(video.height),
    fps,
    rotation: parseRotation(video),
    hasVideo: !!video.codec_type,
    hasAudio: !!audio.codec_type,
    videoCodec: video.codec_name || '',
    audioCodec: audio.codec_name || '',
    audioSampleRate: finiteNumber(audio.sample_rate),
    audioChannels: finiteNumber(audio.channels),
    formatName: payload?.format?.format_name || '',
    size: finiteNumber(payload?.format?.size),
    bitRate: finiteNumber(payload?.format?.bit_rate),
    probeSource: 'ffprobe-json',
  };
}

function parseProbe(stderr) {
  const text = String(stderr || '');
  const durationMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : undefined;
  const videoMatch = text.match(/Video:\s*[^,\n]+(?:,[^,\n]+)*,\s*(\d{2,5})x(\d{2,5})/i);
  const audio = /Audio:\s*/i.test(text);
  return {
    duration: Number.isFinite(duration) ? duration : undefined,
    width: videoMatch ? Number(videoMatch[1]) : undefined,
    height: videoMatch ? Number(videoMatch[2]) : undefined,
    hasAudio: audio,
    probeSource: 'ffmpeg-stderr',
  };
}

async function probeFile(file, job) {
  try {
    return parseProbeJson(await runFfprobeJson(file, job));
  } catch (error) {
    console.warn('[videoOps] ffprobe JSON failed, falling back to ffmpeg stderr:', error?.message || error);
  }
  const result = await runFfmpeg(['-hide_banner', '-i', file], job, {
    allowFailure: true,
    timeoutMs: 45_000,
  });
  return parseProbe(result.stderr);
}

function even(value) {
  const n = Math.max(2, Math.round(Number(value) || 2));
  return n % 2 === 0 ? n : n + 1;
}

function aspectRatio(settings, firstProbe) {
  const raw = settings?.aspect || 'first';
  if (raw === '9:16') return { w: 9, h: 16 };
  if (raw === '1:1') return { w: 1, h: 1 };
  if (raw === '16:9') return { w: 16, h: 9 };
  if (raw === '3:4') return { w: 3, h: 4 };
  if (raw === '4:3') return { w: 4, h: 3 };
  if (raw === '21:9') return { w: 21, h: 9 };
  if (raw === '2:1') return { w: 2, h: 1 };
  const w = Number(firstProbe?.width) || 16;
  const h = Number(firstProbe?.height) || 9;
  return { w, h };
}

function targetSize(settings, firstProbe) {
  const ratio = aspectRatio(settings, firstProbe);
  const resolution = settings?.resolution || 'first';
  if (resolution === 'first' || resolution === 'source') {
    return {
      width: even(Number(firstProbe?.width) || 1280),
      height: even(Number(firstProbe?.height) || 720),
    };
  }
  const longEdge = {
    '720p': 1280,
    '1080p': 1920,
    '2k': 2560,
    '4k': 3840,
  }[resolution] || 1280;
  if (ratio.w === ratio.h) return { width: even(Math.min(longEdge, 2160)), height: even(Math.min(longEdge, 2160)) };
  if (ratio.w >= ratio.h) {
    return { width: even(longEdge), height: even(longEdge * ratio.h / ratio.w) };
  }
  return { width: even(longEdge * ratio.w / ratio.h), height: even(longEdge) };
}

function colorFilterSteps(settings) {
  const base = [];
  const filter = settings?.filter || 'none';
  if (filter === 'bright') base.push('eq=brightness=0.05:saturation=1.04');
  if (filter === 'contrast') base.push('eq=contrast=1.18:saturation=1.05');
  if (filter === 'warm') base.push('colorbalance=rs=0.04:gs=0.015:bs=-0.035');
  if (filter === 'cool') base.push('colorbalance=rs=-0.035:gs=0.005:bs=0.045');
  if (filter === 'mono') base.push('hue=s=0');
  if (filter === 'cinematic') base.push('eq=contrast=1.12:saturation=0.95:gamma=0.96');
  return base;
}

function filterChain(settings, width, height, duration) {
  const base = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    'format=yuv420p',
    ...colorFilterSteps(settings),
  ];
  return base.join(',');
}

function overlayContentFilterChain(settings) {
  const base = [
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    'setsar=1',
    'format=yuv420p',
    ...colorFilterSteps(settings),
  ];
  return base.join(',');
}

function shouldKeepAudio(settings, clip, index, probe) {
  if (clip?.muted || !probe?.hasAudio) return false;
  const audio = settings?.audio || 'keep';
  if (audio === 'mute') return false;
  if (audio === 'first' && index > 0) return false;
  return true;
}

function hasAudibleEnvelopeControls(segment) {
  if (!segment || typeof segment !== 'object') return false;
  return Math.abs(safeRenderPlanNumber(segment.volume, 1) - 1) > 0.0001
    || normalizeTimelineAudioFade(segment.audioFadeIn, segment.duration) > 0
    || normalizeTimelineAudioFade(segment.audioFadeOut, segment.duration) > 0
    || normalizeTimelineAudioVolumeCurve(segment.volumeCurve) !== 'flat';
}

function sourceAudioEnvelopeFilterChain(envelope, duration) {
  const safeDuration = Math.max(0.05, safeRenderPlanNumber(duration, 0.05));
  if (!hasAudibleEnvelopeControls({ ...(envelope || {}), duration: safeDuration })) return '';
  return buildTimelineAudioEnvelopeFilters({ ...(envelope || {}), duration: safeDuration }).join(',');
}

async function makeSegment({ source, clip, index, probe, settings, width, height, targetDir, job, forceMuteAudio = false, audioEnvelope = null }) {
  const start = Math.max(0, Number(clip.trimStart) || 0);
  const rawEnd = Number(clip.trimEnd);
  const sourceDuration = Number(probe.duration) || 0;
  const end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : sourceDuration;
  const duration = Math.max(0.1, (end || start + 1) - start);
  const keepAudio = !forceMuteAudio && shouldKeepAudio(settings, clip, index, probe);
  const output = path.join(targetDir, `segment_${String(index).padStart(3, '0')}.mp4`);
  const args = ['-y'];
  if (start > 0) args.push('-ss', start.toFixed(3));
  args.push('-i', source);
  if (!keepAudio) {
    args.push('-f', 'lavfi', '-t', duration.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }
  const isTimelineOverlay = Math.max(0, Math.round(safeRenderPlanNumber(clip?.layerIndex, 0))) > 0;
  args.push('-t', duration.toFixed(3));
  args.push('-map', '0:v:0');
  args.push('-map', keepAudio ? '0:a:0' : '1:a:0');
  args.push('-vf', isTimelineOverlay ? overlayContentFilterChain(settings) : filterChain(settings, width, height, duration));
  args.push('-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20');
  const audioFilter = keepAudio ? sourceAudioEnvelopeFilterChain(audioEnvelope, duration) : '';
  if (audioFilter) args.push('-af', audioFilter);
  args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2');
  args.push('-shortest', '-movflags', '+faststart', output);
  await runFfmpeg(args, job);
  return {
    file: output,
    duration,
    clip,
    index,
    sourceWidth: Number(probe?.width) || undefined,
    sourceHeight: Number(probe?.height) || undefined,
  };
}

async function concatSegments(files, output, job) {
  const listFile = path.join(path.dirname(output), 'concat.txt');
  const body = files
    .map((file) => file.replace(/\\/g, '/'))
    .map((file) => `file '${file.replace(/'/g, "'\\''")}'`)
    .join('\n');
  await fsp.writeFile(listFile, body, 'utf8');
  await runFfmpeg([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    '-movflags', '+faststart',
    output,
  ], job);
}

function buildXfadeFilterGraph(segments, transitionName, duration) {
  if (!Array.isArray(segments) || segments.length < 2) throw new Error('xfade 至少需要 2 段视频');
  const safeDuration = Math.max(0.05, Number(duration) || 0.5);
  const transition = String(transitionName || 'fade').trim() || 'fade';
  const filters = [];
  let videoPrev = '0:v';
  let audioPrev = '0:a';
  let elapsed = Math.max(safeDuration + 0.05, Number(segments[0]?.duration) || safeDuration + 0.05);

  for (let i = 1; i < segments.length; i += 1) {
    const videoLabel = `vxf${i}`;
    const audioLabel = `axf${i}`;
    const offset = Math.max(0, elapsed - safeDuration);
    filters.push(`[${videoPrev}][${i}:v]xfade=transition=${transition}:duration=${safeDuration.toFixed(3)}:offset=${offset.toFixed(3)}[${videoLabel}]`);
    filters.push(`[${audioPrev}][${i}:a]acrossfade=d=${safeDuration.toFixed(3)}:c1=tri:c2=tri[${audioLabel}]`);
    videoPrev = videoLabel;
    audioPrev = audioLabel;
    elapsed = Math.max(0, elapsed + (Number(segments[i]?.duration) || safeDuration + 0.05) - safeDuration);
  }

  return {
    filterComplex: filters.join(';'),
    videoLabel: videoPrev,
    audioLabel: audioPrev,
    estimatedDuration: elapsed,
  };
}

async function concatSegmentsWithXfade(segments, output, transitionName, duration, job) {
  const graph = buildXfadeFilterGraph(segments, transitionName, duration);
  const args = ['-y'];
  for (const segment of segments) args.push('-i', segment.file);
  args.push(
    '-filter_complex', graph.filterComplex,
    '-map', `[${graph.videoLabel}]`,
    '-map', `[${graph.audioLabel}]`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    output,
  );
  await runFfmpeg(args, job);
  return graph;
}

function timelineSegmentStart(segment) {
  return Math.max(0, safeRenderPlanNumber(segment?.clip?.timelineStart, 0));
}

function timelineSegmentEnd(segment) {
  const start = timelineSegmentStart(segment);
  const fallbackEnd = start + Math.max(0.05, safeRenderPlanNumber(segment?.duration, 0));
  return Math.max(start + 0.05, safeRenderPlanNumber(segment?.clip?.timelineEnd, fallbackEnd));
}

function timelineSegmentLayer(segment) {
  return Math.max(0, Math.round(safeRenderPlanNumber(segment?.clip?.layerIndex, 0)));
}

function timelineSegmentTrackOrder(segment) {
  return Math.round(safeRenderPlanNumber(segment?.clip?.trackOrder, timelineSegmentLayer(segment)));
}

function timelineSegmentPercent(segment, key, fallback = 0) {
  const raw = segment?.clip && Object.prototype.hasOwnProperty.call(segment.clip, key)
    ? segment.clip[key]
    : segment?.[key];
  const next = safeRenderPlanNumber(raw, fallback);
  return Math.max(0, Math.min(100, next));
}

function timelineSegmentScale(segment) {
  const raw = segment?.clip && Object.prototype.hasOwnProperty.call(segment.clip, 'scale')
    ? segment.clip.scale
    : segment?.scale;
  const next = safeRenderPlanNumber(raw, 1);
  return Math.max(0.1, Math.min(2, next));
}

function timelineSegmentOpacity(segment) {
  const raw = segment?.clip && Object.prototype.hasOwnProperty.call(segment.clip, 'opacity')
    ? segment.clip.opacity
    : segment?.opacity;
  const next = safeRenderPlanNumber(raw, 1);
  return Math.max(0, Math.min(1, next));
}

function timelineSegmentHasVisualTransform(segment) {
  return Math.abs(timelineSegmentScale(segment) - 1) > 0.0001
    || timelineSegmentPercent(segment, 'x', 0) > 0.0001
    || timelineSegmentPercent(segment, 'y', 0) > 0.0001
    || timelineSegmentOpacity(segment) < 0.999;
}

function timelineSegmentSourceAspect(segment) {
  const width = safeRenderPlanNumber(segment?.clip?.width, safeRenderPlanNumber(segment?.sourceWidth, 0));
  const height = safeRenderPlanNumber(segment?.clip?.height, safeRenderPlanNumber(segment?.sourceHeight, 0));
  if (width > 0 && height > 0) return width / height;
  return 16 / 9;
}

function timelineSegmentScaleFilters(segment, size, scale) {
  if (timelineSegmentLayer(segment) > 0) {
    const aspect = timelineSegmentSourceAspect(segment);
    if (aspect >= 1) {
      return [`scale=${even(size.width * scale)}:-2`];
    }
    return [`scale=-2:${even(size.height * scale)}`];
  }
  if (Math.abs(scale - 1) > 0.0001) {
    return [`scale=trunc(iw*${scale.toFixed(4)}/2)*2:trunc(ih*${scale.toFixed(4)}/2)*2`];
  }
  return [];
}

function timelineComposeDuration(renderPlan, segments) {
  const fromPlan = safeRenderPlanNumber(renderPlan?.duration, 0);
  const fromSegments = segments.reduce((max, segment) => Math.max(max, timelineSegmentEnd(segment)), 0);
  return Math.max(0.1, fromPlan, fromSegments);
}

function shouldComposeTimelineVideoLayers(renderPlan, segments) {
  const planClips = Array.isArray(renderPlan?.clips) ? renderPlan.clips : [];
  if (!planClips.length || !Array.isArray(segments) || segments.length === 0) return false;
  const layers = new Set(planClips.map((clip) => Math.max(0, Math.round(safeRenderPlanNumber(clip?.layerIndex, 0)))));
  if (layers.size > 1) return true;
  const hasVisualTransform = segments.some(timelineSegmentHasVisualTransform);
  if (hasVisualTransform) return true;

  const sorted = segments
    .slice()
    .sort((a, b) => timelineSegmentStart(a) - timelineSegmentStart(b) || safeRenderPlanNumber(a?.index, 0) - safeRenderPlanNumber(b?.index, 0));
  let cursor = 0;
  for (const segment of sorted) {
    const start = timelineSegmentStart(segment);
    const end = timelineSegmentEnd(segment);
    if (Math.abs(start - cursor) > 0.05) return true;
    cursor = Math.max(cursor, end);
  }
  return safeRenderPlanNumber(renderPlan?.duration, cursor) - cursor > 0.05;
}

function sortTimelineSegments(segments) {
  return segments
    .slice()
    .sort((a, b) => timelineSegmentLayer(a) - timelineSegmentLayer(b)
      || timelineSegmentStart(a) - timelineSegmentStart(b)
      || timelineSegmentTrackOrder(a) - timelineSegmentTrackOrder(b)
      || safeRenderPlanNumber(a?.index, 0) - safeRenderPlanNumber(b?.index, 0));
}

function timelineDurationFromSegments(segments) {
  return Math.max(0.1, segments.reduce((max, segment) => Math.max(max, timelineSegmentEnd(segment)), 0));
}

async function prepareTimelineLayerTransitionSegments(sorted, renderPlan, size, job, transitionOptions = {}) {
  const xfadeName = String(transitionOptions.xfadeName || '').trim();
  const transitionDuration = Math.max(0, Number(transitionOptions.transitionDuration) || 0);
  if (!xfadeName || transitionDuration <= 0) {
    return { segments: sorted, applied: false, skippedReason: 'disabled' };
  }

  const primarySegments = sorted
    .filter((segment) => timelineSegmentLayer(segment) === 0)
    .sort((a, b) => timelineSegmentStart(a) - timelineSegmentStart(b) || safeRenderPlanNumber(a?.index, 0) - safeRenderPlanNumber(b?.index, 0));
  if (primarySegments.length < 2) {
    return { segments: sorted, applied: false, skippedReason: 'single-primary-track-clip' };
  }
  if (primarySegments.some(timelineSegmentHasVisualTransform)) {
    return { segments: sorted, applied: false, skippedReason: 'primary-track-transform' };
  }

  const baseOutput = path.join(path.dirname(primarySegments[0].file), `timeline_primary_xfade_${crypto.randomBytes(4).toString('hex')}.mp4`);
  job.message = '合成主轨高质量转场';
  const graph = await concatSegmentsWithXfade(primarySegments, baseOutput, xfadeName, transitionDuration, job);
  const baseProbe = await probeFile(baseOutput, job).catch(() => ({}));
  const estimatedDuration = Math.max(
    0.1,
    safeRenderPlanNumber(baseProbe.duration, 0),
    safeRenderPlanNumber(graph?.estimatedDuration, 0),
    primarySegments.reduce((sum, segment) => sum + Math.max(0.05, safeRenderPlanNumber(segment?.duration, 0)), 0)
      - transitionDuration * Math.max(0, primarySegments.length - 1),
  );
  const baseSegment = {
    file: baseOutput,
    duration: estimatedDuration,
    index: -1,
    sourceWidth: size.width,
    sourceHeight: size.height,
    clip: {
      id: 'timeline-primary-xfade',
      sourceItemId: 'timeline-primary-xfade',
      assetId: 'timeline-primary-xfade',
      layerIndex: 0,
      trackOrder: 0,
      timelineStart: 0,
      timelineEnd: estimatedDuration,
      x: 0,
      y: 0,
      scale: 1,
      opacity: 1,
      width: size.width,
      height: size.height,
    },
  };

  return {
    segments: sortTimelineSegments([
      baseSegment,
      ...sorted.filter((segment) => timelineSegmentLayer(segment) > 0),
    ]),
    applied: true,
    primaryClipCount: primarySegments.length,
    primaryDuration: Number(estimatedDuration.toFixed(3)),
    renderPlanDuration: safeRenderPlanNumber(renderPlan?.duration, 0),
  };
}

async function composeSegmentsByTimelineLayers(segments, output, renderPlan, size, job, transitionOptions = {}) {
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('时间线合成至少需要 1 段视频');
  const originalSorted = sortTimelineSegments(segments);
  const transitionPrepared = await prepareTimelineLayerTransitionSegments(originalSorted, renderPlan, size, job, transitionOptions);
  const sorted = transitionPrepared.segments;
  const duration = transitionPrepared.applied
    ? timelineDurationFromSegments(sorted)
    : timelineComposeDuration(renderPlan, sorted);

  const args = [
    '-y',
    '-f', 'lavfi',
    '-t', duration.toFixed(3),
    '-i', `color=c=black:s=${Math.max(2, size.width)}x${Math.max(2, size.height)}:r=30:d=${duration.toFixed(3)}`,
  ];
  for (const segment of sorted) args.push('-i', segment.file);

  const filters = ['[0:v]format=rgba[tlbase0]'];
  let previousVideo = 'tlbase0';
  const audioLabels = [];

  sorted.forEach((segment, index) => {
    const inputIndex = index + 1;
    const start = timelineSegmentStart(segment);
    const end = Math.min(duration, timelineSegmentEnd(segment));
    const x = timelineSegmentPercent(segment, 'x', 0);
    const y = timelineSegmentPercent(segment, 'y', 0);
    const scale = timelineSegmentScale(segment);
    const opacity = timelineSegmentOpacity(segment);
    const videoLabel = `tlsegv${index}`;
    const nextVideo = `tlbase${index + 1}`;
    const segmentFilters = [
      `setpts=PTS-STARTPTS+${start.toFixed(3)}/TB`,
      'format=rgba',
      ...timelineSegmentScaleFilters(segment, size, scale),
    ];
    if (opacity < 0.999) {
      segmentFilters.push(`colorchannelmixer=aa=${opacity.toFixed(4)}`);
    }
    filters.push(`[${inputIndex}:v:0]${segmentFilters.join(',')}[${videoLabel}]`);
    filters.push(
      `[${previousVideo}][${videoLabel}]` +
      `overlay=x=(main_w-overlay_w)*${(x / 100).toFixed(4)}:y=(main_h-overlay_h)*${(y / 100).toFixed(4)}` +
      `:eof_action=pass:shortest=0:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${nextVideo}]`,
    );
    previousVideo = nextVideo;

    const delayMs = Math.max(0, Math.round(start * 1000));
    const audioLabel = `tlsega${index}`;
    filters.push(
      `[${inputIndex}:a:0]asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1,` +
      `apad=whole_dur=${duration.toFixed(3)},atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS[${audioLabel}]`,
    );
    audioLabels.push(audioLabel);
  });

  filters.push(`[${previousVideo}]format=yuv420p[vout]`);
  filters.push(
    `${audioLabels.map((label) => `[${label}]`).join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0,` +
    `apad=whole_dur=${duration.toFixed(3)},atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS[aout]`,
  );

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    '-t', duration.toFixed(3),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    output,
  );
  await runFfmpeg(args, job);
  return {
    timelineVideoComposited: true,
    timelineVideoClipCount: originalSorted.length,
    timelineVideoLayerCount: new Set(originalSorted.map(timelineSegmentLayer)).size,
    timelineVideoPipCount: originalSorted.filter((segment) => (
      timelineSegmentLayer(segment) > 0
      && (
        timelineSegmentHasVisualTransform(segment)
      )
    )).length,
    timelineVideoDuration: Number(duration.toFixed(3)),
    timelineVideoTransitionApplied: !!transitionPrepared.applied,
    timelineVideoTransitionClipCount: transitionPrepared.primaryClipCount || 0,
    timelineVideoTransitionSkippedReason: transitionPrepared.skippedReason || '',
  };
}

function normalizeTimelineAudioSegments(renderPlan, settings) {
  const audioPolicy = settings?.audio || 'keep';
  if (audioPolicy === 'mute') return [];
  const rawSegments = Array.isArray(renderPlan?.audio) ? renderPlan.audio : [];
  const segments = rawSegments
    .filter((segment) => segment && typeof segment === 'object')
    .filter((segment) => !segment.muted && typeof segment.url === 'string' && segment.url.trim())
    .map((segment, index) => {
      const timelineStart = Math.max(0, safeRenderPlanNumber(segment.timelineStart, 0));
      const timelineEnd = Math.max(timelineStart, safeRenderPlanNumber(segment.timelineEnd, timelineStart));
      const trimStart = Math.max(0, safeRenderPlanNumber(segment.trimStart, 0));
      const trimEnd = Math.max(trimStart, safeRenderPlanNumber(segment.trimEnd, trimStart + Math.max(0.05, timelineEnd - timelineStart)));
      const duration = Math.max(0.05, timelineEnd - timelineStart, trimEnd - trimStart);
      return {
        ...segment,
        index,
        timelineStart,
        timelineEnd,
        trimStart,
        trimEnd,
        volume: Math.max(0, Math.min(4, safeRenderPlanNumber(segment.volume, 1))),
        audioFadeIn: normalizeTimelineAudioFade(segment.audioFadeIn, duration),
        audioFadeOut: normalizeTimelineAudioFade(segment.audioFadeOut, duration),
        volumeCurve: normalizeTimelineAudioVolumeCurve(segment.volumeCurve),
      };
    })
    .filter((segment) => segment.timelineEnd - segment.timelineStart > 0.05 && segment.trimEnd - segment.trimStart > 0.05)
    .sort((a, b) => a.timelineStart - b.timelineStart || a.index - b.index);
  if (audioPolicy === 'first') return segments.slice(0, 1);
  return segments;
}

function isLinkedVideoAudioSegment(segment) {
  return typeof segment?.linkedVideoItemId === 'string' && segment.linkedVideoItemId.trim().length > 0;
}

function independentTimelineAudioSegments(renderPlan, settings) {
  return normalizeTimelineAudioSegments(renderPlan, settings)
    .filter((segment) => !isLinkedVideoAudioSegment(segment));
}

function sourceAudioEnvelopeByVideoItemId(renderPlan, settings) {
  const map = new Map();
  if (settings?.audio === 'mute') return map;
  for (const segment of normalizeTimelineAudioSegments(renderPlan, { ...(settings || {}), audio: 'keep' })) {
    if (!isLinkedVideoAudioSegment(segment)) continue;
    map.set(segment.linkedVideoItemId, segment);
  }
  return map;
}

function normalizeTimelineAudioVolumeCurve(value) {
  return AUDIO_VOLUME_CURVES.has(value) ? value : 'flat';
}

function normalizeTimelineAudioFade(value, duration = 0) {
  const maxDuration = Math.max(0, safeRenderPlanNumber(duration, 0));
  const maxFade = Math.min(maxDuration, 10);
  return Number(Math.max(0, Math.min(maxFade, safeRenderPlanNumber(value, 0))).toFixed(3));
}

function buildTimelineAudioEnvelopeFilters(segment) {
  const duration = Math.max(0.05, safeRenderPlanNumber(segment?.duration, (
    safeRenderPlanNumber(segment?.trimEnd, 0) - safeRenderPlanNumber(segment?.trimStart, 0)
  )));
  const volume = Math.max(0, Math.min(4, safeRenderPlanNumber(segment?.volume, 1)));
  const curve = normalizeTimelineAudioVolumeCurve(segment?.volumeCurve);
  const fadeIn = normalizeTimelineAudioFade(segment?.audioFadeIn, duration);
  const fadeOut = normalizeTimelineAudioFade(segment?.audioFadeOut, duration);
  const filters = [`volume=${volume.toFixed(3)}`];
  if (curve === 'linear-up') {
    filters.push(`afade=t=in:st=0:d=${duration.toFixed(3)}`);
  } else if (curve === 'linear-down') {
    filters.push(`afade=t=out:st=0:d=${duration.toFixed(3)}`);
  } else if (curve === 'duck') {
    filters.push('volume=0.550');
  }
  if (fadeIn > 0) {
    filters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
  }
  if (fadeOut > 0) {
    filters.push(`afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  }
  return filters;
}

async function mixTimelineAudioIntoVideo(input, output, renderPlan, settings, workDir, job) {
  const audioSegments = independentTimelineAudioSegments(renderPlan, settings);
  if (!audioSegments.length) return { timelineAudioMixed: false, timelineAudioCount: 0 };

  const videoProbe = await probeFile(input, job);
  const probedDuration = safeRenderPlanNumber(videoProbe.duration, 0);
  const plannedDuration = safeRenderPlanNumber(renderPlan?.duration, 0);
  const targetDuration = Math.max(0.1, probedDuration > 0 ? probedDuration : plannedDuration);
  const audioInputs = [];
  for (const segment of audioSegments) {
    const source = await resolveVideoSource(segment.directUrl || segment.url, workDir);
    const probe = await probeFile(source, job);
    if (!probe.hasAudio) continue;
    const sourceDuration = Math.max(0, safeRenderPlanNumber(probe.duration, 0));
    const trimEnd = sourceDuration > 0 ? Math.min(segment.trimEnd, sourceDuration) : segment.trimEnd;
    const trimStart = sourceDuration > 0 ? Math.min(segment.trimStart, Math.max(0, sourceDuration - 0.02)) : segment.trimStart;
    const duration = Math.max(0.05, trimEnd - trimStart);
    audioInputs.push({
      source,
      timelineStart: segment.timelineStart,
      trimStart,
      trimEnd: trimStart + duration,
      duration,
      volume: segment.volume,
      audioFadeIn: normalizeTimelineAudioFade(segment.audioFadeIn, duration),
      audioFadeOut: normalizeTimelineAudioFade(segment.audioFadeOut, duration),
      volumeCurve: normalizeTimelineAudioVolumeCurve(segment.volumeCurve),
    });
  }
  if (!audioInputs.length) return { timelineAudioMixed: false, timelineAudioCount: 0 };

  const filters = [];
  const mixLabels = [];
  if (videoProbe.hasAudio) {
    filters.push(
      `[0:a:0]apad=whole_dur=${targetDuration.toFixed(3)},` +
      `atrim=0:${targetDuration.toFixed(3)},asetpts=PTS-STARTPTS[baseaud]`,
    );
    mixLabels.push('baseaud');
  }
  audioInputs.forEach((segment, index) => {
    const inputIndex = index + 1;
    const delayMs = Math.max(0, Math.round(segment.timelineStart * 1000));
    filters.push([
      `[${inputIndex}:a:0]atrim=start=${segment.trimStart.toFixed(3)}:end=${segment.trimEnd.toFixed(3)}`,
      'asetpts=PTS-STARTPTS',
      ...buildTimelineAudioEnvelopeFilters(segment),
      `adelay=${delayMs}:all=1`,
      `apad=whole_dur=${targetDuration.toFixed(3)}`,
      `atrim=0:${targetDuration.toFixed(3)}`,
      `asetpts=PTS-STARTPTS[aud${index}]`,
    ].join(','));
    mixLabels.push(`aud${index}`);
  });
  filters.push(
    `${mixLabels.map((label) => `[${label}]`).join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0,` +
    `apad=whole_dur=${targetDuration.toFixed(3)},atrim=0:${targetDuration.toFixed(3)},asetpts=PTS-STARTPTS[aout]`,
  );

  const args = ['-y', '-i', input];
  for (const audioInput of audioInputs) args.push('-i', audioInput.source);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '0:v:0',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '44100',
    '-ac', '2',
    '-t', targetDuration.toFixed(3),
    '-movflags', '+faststart',
    output,
  );
  await runFfmpeg(args, job);
  return { timelineAudioMixed: true, timelineAudioCount: audioInputs.length };
}

async function muteVideoFile(source, job) {
  const filename = safeOutputName('video_edit_muted', '.mp4');
  const output = path.join(config.OUTPUT_DIR, filename);
  await runFfmpeg([
    '-y',
    '-i', source,
    '-map', '0:v:0',
    '-c:v', 'copy',
    '-an',
    '-movflags', '+faststart',
    output,
  ], job);
  const probe = await probeFile(output, job);
  const stat = fs.statSync(output);
  return {
    videoUrl: filePublicUrl(output),
    directVideoUrl: filePublicUrl(output),
    fileName: filename,
    duration: probe.duration,
    width: probe.width,
    height: probe.height,
    size: stat.size,
    mime: 'video/mp4',
  };
}

async function extractAudioFile(source, job) {
  const mp3Name = safeOutputName('video_edit_audio', '.mp3');
  const mp3Output = path.join(config.OUTPUT_DIR, mp3Name);
  try {
    await runFfmpeg([
      '-y',
      '-i', source,
      '-vn',
      '-c:a', 'libmp3lame',
      '-q:a', '2',
      mp3Output,
    ], job);
    const stat = fs.statSync(mp3Output);
    return {
      audioUrl: filePublicUrl(mp3Output),
      directAudioUrl: filePublicUrl(mp3Output),
      audioFileName: mp3Name,
      audioSize: stat.size,
      audioMime: 'audio/mpeg',
    };
  } catch (error) {
    try { await fsp.rm(mp3Output, { force: true }); } catch (_) {}
    const aacName = safeOutputName('video_edit_audio', '.aac');
    const aacOutput = path.join(config.OUTPUT_DIR, aacName);
    await runFfmpeg([
      '-y',
      '-i', source,
      '-vn',
      '-c:a', 'aac',
      '-b:a', '192k',
      aacOutput,
    ], job);
    const stat = fs.statSync(aacOutput);
    return {
      audioUrl: filePublicUrl(aacOutput),
      directAudioUrl: filePublicUrl(aacOutput),
      audioFileName: aacName,
      audioSize: stat.size,
      audioMime: 'audio/aac',
    };
  }
}

async function separateVideoAudio(clips, settings, mode = 'both', job = makeJob('separate-audio'), options = {}) {
  const normalizedMode = ['audio-only', 'mute-video', 'both'].includes(mode) ? mode : 'both';
  job.message = '合成时间线用于音频分离';
  job.progress = 3;
  const composed = await composeVideoEdit(clips, { ...(settings || {}), audio: 'keep' }, job, { markComplete: false, renderPlan: options?.renderPlan });
  const composedFile = path.join(config.OUTPUT_DIR, path.basename(composed.videoUrl || ''));
  if (!fs.existsSync(composedFile)) throw new Error('音频分离前的合成视频不存在');

  const result = {
    jobId: job.id,
    mode: normalizedMode,
    videoUrl: '',
    directVideoUrl: '',
    fileName: '',
    size: 0,
    mime: 'video/mp4',
    audioUrl: '',
    directAudioUrl: '',
    audioFileName: '',
    audioSize: 0,
    audioMime: '',
  };
  try {
    if (normalizedMode === 'mute-video' || normalizedMode === 'both') {
      job.message = normalizedMode === 'both' ? '导出无声视频 1/2' : '导出无声视频';
      job.progress = 72;
      Object.assign(result, await muteVideoFile(composedFile, job));
    }
    if (normalizedMode === 'audio-only' || normalizedMode === 'both') {
      job.message = normalizedMode === 'both' ? '提取独立音频 2/2' : '提取独立音频';
      job.progress = normalizedMode === 'both' ? 86 : 72;
      Object.assign(result, await extractAudioFile(composedFile, job));
    }
  } finally {
    try { await fsp.rm(composedFile, { force: true }); } catch (_) {}
  }
  finishJob(job, '音频处理完成', result);
  return result;
}

async function createThumbnail(source, probe, prefix = 'video_edit_thumb') {
  const filename = safeOutputName(prefix, '.jpg');
  const target = path.join(config.THUMBNAILS_DIR, filename);
  const seek = Math.max(0, Math.min(1, (Number(probe?.duration) || 2) / 2));
  await runFfmpeg([
    '-y',
    '-ss', seek.toFixed(2),
    '-i', source,
    '-frames:v', '1',
    '-vf', 'scale=320:-1',
    '-q:v', '4',
    target,
  ], null, { timeoutMs: 45_000 });
  return `/files/thumbnails/${filename}`;
}

function clampInteger(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function waveformPeaksFromPcm16(buffer, peakCount) {
  const sampleCount = Math.floor(buffer.length / 2);
  const count = clampInteger(peakCount, 16, 160, 64);
  if (sampleCount <= 0) return [];
  const bucketSize = Math.max(1, Math.ceil(sampleCount / count));
  const peaks = [];
  for (let bucket = 0; bucket < count; bucket += 1) {
    const start = bucket * bucketSize;
    const end = Math.min(sampleCount, start + bucketSize);
    let max = 0;
    for (let i = start; i < end; i += 1) {
      const value = Math.abs(buffer.readInt16LE(i * 2));
      if (value > max) max = value;
    }
    peaks.push(Number(Math.min(1, max / 32768).toFixed(4)));
  }
  return peaks;
}

async function extractWaveformPeaks(source, options = {}, job) {
  const start = Math.max(0, Number(options.start) || 0);
  const duration = Math.max(0, Number(options.duration) || 0);
  const peakCount = clampInteger(options.peakCount, 16, 160, 64);
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (start > 0) args.push('-ss', start.toFixed(3));
  args.push('-i', source);
  if (duration > 0) args.push('-t', duration.toFixed(3));
  args.push('-vn', '-ac', '1', '-ar', '2000', '-f', 's16le', 'pipe:1');
  try {
    const pcm = await runFfmpegBuffer(args, job, { timeoutMs: 90_000, maxStdoutBytes: 16 * 1024 * 1024 });
    return waveformPeaksFromPcm16(pcm, peakCount);
  } catch (error) {
    console.warn('[videoOps] waveform failed:', error?.message || error);
    return [];
  }
}

async function createFilmstripFrames(source, probe, options = {}, job) {
  ensureDir(config.THUMBNAILS_DIR);
  const frameCount = clampInteger(options.frameCount, 3, 12, 8);
  const sourceDuration = Math.max(0, Number(probe?.duration) || 0);
  const start = Math.max(0, Number(options.start) || 0);
  const requestedDuration = Math.max(0, Number(options.duration) || 0);
  const duration = requestedDuration || Math.max(0.1, sourceDuration - start);
  const maxTime = sourceDuration > 0 ? Math.max(0, sourceDuration - 0.02) : start + duration;
  const urls = [];
  const times = [];
  for (let i = 0; i < frameCount; i += 1) {
    const relative = duration > 0 ? ((i + 0.5) / frameCount) * duration : 0;
    const time = Math.max(0, Math.min(maxTime, start + relative));
    const filename = safeOutputName(`video_edit_strip_${String(i + 1).padStart(2, '0')}`, '.jpg');
    const target = path.join(config.THUMBNAILS_DIR, filename);
    await runFfmpeg([
      '-y',
      '-ss', time.toFixed(3),
      '-i', source,
      '-frames:v', '1',
      '-vf', 'scale=180:-2',
      '-q:v', '4',
      target,
    ], job, { timeoutMs: 45_000 });
    urls.push(`/files/thumbnails/${filename}`);
    times.push(Number(time.toFixed(3)));
  }
  return { urls, times };
}

async function createTimelinePreview(clip, options = {}, job = makeJob('timeline-preview')) {
  if (!clip || typeof clip.url !== 'string' || !clip.url.trim()) {
    throw new Error('时间线预览需要一个可用的视频片段');
  }
  const workDir = ensureDir(path.join(os.tmpdir(), `t8-video-timeline-${job.id || crypto.randomBytes(4).toString('hex')}`));
  try {
    job.message = '读取片段信息';
    job.progress = 10;
    const source = await resolveVideoSource(clip.directUrl || clip.url, workDir);
    const probe = await probeFile(source, job);
    const sourceDuration = Math.max(0, Number(probe?.duration) || 0);
    const start = Math.max(0, Number(clip.trimStart) || 0);
    const rawEnd = Number(clip.trimEnd);
    const end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : sourceDuration;
    const duration = Math.max(0.1, (end || start + 1) - start);
    job.message = '生成帧条';
    job.progress = 35;
    const filmstrip = await createFilmstripFrames(source, probe, {
      start,
      duration,
      frameCount: options.frameCount,
    }, job);
    job.message = '分析音频波形';
    job.progress = 70;
    const waveformPeaks = probe.hasAudio
      ? await extractWaveformPeaks(source, { start, duration, peakCount: options.peakCount }, job)
      : [];
    const result = {
      jobId: job.id,
      duration,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      rotation: probe.rotation,
      hasAudio: probe.hasAudio,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      filmstripUrls: filmstrip.urls,
      filmstripTimes: filmstrip.times,
      waveformPeaks,
    };
    finishJob(job, '时间线预览完成', result);
    return result;
  } catch (error) {
    failJob(job, error, '时间线预览失败');
    throw error;
  } finally {
    fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function probeVideoUrl(url, job) {
  const tmp = ensureDir(path.join(os.tmpdir(), `t8-video-probe-${crypto.randomBytes(4).toString('hex')}`));
  try {
    const source = await resolveVideoSource(url, tmp);
    const probe = await probeFile(source, job);
    let thumbnailUrl = '';
    try {
      thumbnailUrl = await createThumbnail(source, probe);
    } catch (error) {
      console.warn('[videoOps] thumbnail failed:', error?.message || error);
    }
    const stat = fs.existsSync(source) ? fs.statSync(source) : null;
    return {
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      rotation: probe.rotation,
      hasVideo: probe.hasVideo,
      hasAudio: probe.hasAudio,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      audioSampleRate: probe.audioSampleRate,
      audioChannels: probe.audioChannels,
      formatName: probe.formatName,
      bitRate: probe.bitRate,
      probeSource: probe.probeSource,
      size: stat?.size,
      mime: 'video/mp4',
      thumbnailUrl,
    };
  } finally {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function snapshotVideoFrame(clip, time = 0, options = {}, job = makeJob('snapshot')) {
  if (!clip || typeof clip.url !== 'string' || !clip.url.trim()) {
    throw new Error('截图需要一个可用的视频片段');
  }
  ensureDir(config.OUTPUT_DIR);
  const workDir = ensureDir(path.join(os.tmpdir(), `t8-video-snapshot-${job.id || crypto.randomBytes(4).toString('hex')}`));
  const format = String(options?.format || 'png').toLowerCase() === 'jpg' ? 'jpg' : 'png';
  const ext = format === 'jpg' ? '.jpg' : '.png';
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const requestedTime = Math.max(0, Number(time) || 0);
  try {
    job.message = '读取截图视频';
    job.progress = 15;
    const source = await resolveVideoSource(clip.directUrl || clip.url, workDir);
    const probe = await probeFile(source, job);
    const duration = Number(probe?.duration) || 0;
    const safeTime = duration > 0 ? Math.min(requestedTime, Math.max(0, duration - 0.02)) : requestedTime;
    const filename = safeOutputName('video_snapshot', ext);
    const output = path.join(config.OUTPUT_DIR, filename);
    job.message = '抽取当前帧';
    job.progress = 55;
    const args = [
      '-y',
      '-ss', safeTime.toFixed(3),
      '-i', source,
      '-frames:v', '1',
    ];
    if (format === 'jpg') {
      args.push('-q:v', '3');
    }
    args.push(output);
    await runFfmpeg(args, job, { timeoutMs: 90_000 });
    const imageProbe = await probeFile(output, job).catch(() => ({}));
    const stat = fs.statSync(output);
    const result = {
      jobId: job.id,
      imageUrl: filePublicUrl(output),
      directImageUrl: filePublicUrl(output),
      fileName: filename,
      size: stat.size,
      mime,
      time: Number(safeTime.toFixed(3)),
      sourceLabel: String(options?.sourceLabel || clip.name || clip.sourceLabel || '视频截图'),
      sourceName: String(clip.name || ''),
      sourceUrl: clip.url,
      width: imageProbe.width,
      height: imageProbe.height,
    };
    finishJob(job, '截图完成', result);
    return result;
  } catch (error) {
    failJob(job, error, '视频截图失败');
    throw error;
  } finally {
    fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function composeVideoEdit(clips, settings, job = makeJob('compose'), options = {}) {
  if (!Array.isArray(clips) || clips.length === 0) throw new Error('至少需要 1 段视频');
  const normalizedClips = clips
    .filter((clip) => clip && typeof clip.url === 'string' && clip.url.trim())
    .slice(0, MAX_CLIPS);
  if (normalizedClips.length === 0) throw new Error('没有可用的视频片段');
  assertRenderPlanSupported(options?.renderPlan);
  const linkedSourceAudioEnvelopes = sourceAudioEnvelopeByVideoItemId(options?.renderPlan, settings);

  const workDir = ensureDir(path.join(os.tmpdir(), `t8-video-compose-${job.id}`));
  let outputToCleanOnFailure = '';
  try {
    job.message = '读取视频素材';
    const sources = [];
    for (let i = 0; i < normalizedClips.length; i += 1) {
      job.progress = Math.round((i / normalizedClips.length) * 15);
      const clip = normalizedClips[i];
      const source = await resolveVideoSource(clip.directUrl || clip.url, workDir);
      const probe = await probeFile(source, job);
      sources.push({ clip, source, probe });
    }
    const size = targetSize(settings, sources[0]?.probe);
    const segmentInfos = [];
    const transitionDefinition = getTransitionDefinition(settings?.transition || 'none');
    const xfadeName = nativeXfadeName(settings, transitionDefinition);
    let useNativeXfade = Boolean(xfadeName && sources.length > 1);
    if (useNativeXfade && !hasNativeXfadeSupport()) {
      throw new Error('当前 ffmpeg 不支持高质量 xfade 转场，请更新内置 ffmpeg');
    }
    for (let i = 0; i < sources.length; i += 1) {
      job.message = `标准化片段 ${i + 1}/${sources.length}`;
      job.progress = 15 + Math.round((i / Math.max(1, sources.length)) * 55);
      const segment = await makeSegment({
        ...sources[i],
        index: i,
        settings,
        width: size.width,
        height: size.height,
        targetDir: workDir,
        job,
        audioEnvelope: linkedSourceAudioEnvelopes.get(sources[i].clip?.sourceItemId) || null,
      });
      segmentInfos.push(segment);
    }

    const timelineLayerCompose = shouldComposeTimelineVideoLayers(options?.renderPlan, segmentInfos);
    job.message = '合成最终视频';
    job.progress = 78;
    const filename = safeOutputName('video_edit', '.mp4');
    const output = path.join(config.OUTPUT_DIR, filename);
    outputToCleanOnFailure = output;
    let appliedTransitionDuration = 0;
    let transitionEngine = 'concat';
    let transitionName = 'none';
    let transitionQuality = 'cut';
    let timelineVideoResult = {
      timelineVideoComposited: false,
      timelineVideoClipCount: 0,
      timelineVideoLayerCount: 0,
      timelineVideoPipCount: 0,
      timelineVideoDuration: 0,
      timelineVideoTransitionApplied: false,
      timelineVideoTransitionClipCount: 0,
      timelineVideoTransitionSkippedReason: '',
    };
    if (timelineLayerCompose) {
      transitionEngine = 'timeline-layer';
      transitionName = 'timeline';
      transitionQuality = 'timeline-overlay';
      const primaryTransitionSegments = segmentInfos.filter((segment) => timelineSegmentLayer(segment) === 0);
      const duration = useNativeXfade ? transitionDurationSeconds(settings, primaryTransitionSegments) : 0;
      timelineVideoResult = await composeSegmentsByTimelineLayers(
        segmentInfos,
        output,
        options?.renderPlan,
        size,
        job,
        {
          xfadeName: useNativeXfade && duration > 0 ? xfadeName : '',
          transitionDuration: duration,
        },
      );
      if (timelineVideoResult.timelineVideoTransitionApplied) {
        appliedTransitionDuration = Number(duration.toFixed(3));
        transitionEngine = 'timeline-layer-xfade';
        transitionName = xfadeName;
        transitionQuality = 'native-xfade+timeline-overlay';
      }
    } else if (useNativeXfade) {
      const duration = transitionDurationSeconds(settings, segmentInfos);
      if (duration <= 0) throw new Error('片段太短，无法应用高质量转场');
      appliedTransitionDuration = Number(duration.toFixed(3));
      transitionEngine = 'ffmpeg-xfade';
      transitionName = xfadeName;
      transitionQuality = transitionDefinition?.quality || 'native-xfade';
      await concatSegmentsWithXfade(segmentInfos, output, xfadeName, duration, job);
    } else {
      await concatSegments(segmentInfos.map((item) => item.file), output, job);
    }
    const subtitleTempOutput = path.join(config.OUTPUT_DIR, `.${path.basename(filename, '.mp4')}_subtitled.mp4`);
    let subtitleResult = { subtitleBurnedIn: false, subtitleCount: 0 };
    try {
      subtitleResult = await burnSubtitleTextIntoVideo(output, subtitleTempOutput, options?.renderPlan?.text, size, job);
      if (subtitleResult.subtitleBurnedIn) {
        await fsp.rm(output, { force: true });
        await fsp.rename(subtitleTempOutput, output);
      }
    } finally {
      fsp.rm(subtitleTempOutput, { force: true }).catch(() => {});
    }
    const audioTempOutput = path.join(config.OUTPUT_DIR, `.${path.basename(filename, '.mp4')}_timeline_audio.mp4`);
    let timelineAudioResult = { timelineAudioMixed: false, timelineAudioCount: 0 };
    try {
      job.message = '混合时间线音轨';
      job.progress = Math.max(job.progress || 0, 88);
      timelineAudioResult = await mixTimelineAudioIntoVideo(output, audioTempOutput, options?.renderPlan, settings, workDir, job);
      if (timelineAudioResult.timelineAudioMixed) {
        await fsp.rm(output, { force: true });
        await fsp.rename(audioTempOutput, output);
      }
    } finally {
      fsp.rm(audioTempOutput, { force: true }).catch(() => {});
    }
    const finalProbe = await probeFile(output, job);
    const stat = fs.statSync(output);
    const result = {
      jobId: job.id,
      videoUrl: `/files/output/${filename}`,
      directVideoUrl: `/files/output/${filename}`,
      fileName: filename,
      duration: finalProbe.duration,
      width: finalProbe.width || size.width,
      height: finalProbe.height || size.height,
      size: stat.size,
      mime: 'video/mp4',
      transitionEngine,
      transitionName,
      transitionQuality,
      transitionDuration: appliedTransitionDuration,
      timelineVideoComposited: timelineVideoResult.timelineVideoComposited,
      timelineVideoClipCount: timelineVideoResult.timelineVideoClipCount,
      timelineVideoLayerCount: timelineVideoResult.timelineVideoLayerCount,
      timelineVideoPipCount: timelineVideoResult.timelineVideoPipCount,
      timelineVideoDuration: timelineVideoResult.timelineVideoDuration,
      timelineVideoTransitionApplied: timelineVideoResult.timelineVideoTransitionApplied,
      timelineVideoTransitionClipCount: timelineVideoResult.timelineVideoTransitionClipCount,
      timelineVideoTransitionSkippedReason: timelineVideoResult.timelineVideoTransitionSkippedReason,
      subtitleBurnedIn: subtitleResult.subtitleBurnedIn,
      subtitleCount: subtitleResult.subtitleCount,
      timelineAudioMixed: timelineAudioResult.timelineAudioMixed,
      timelineAudioCount: timelineAudioResult.timelineAudioCount,
    };
    if (options.markComplete !== false) {
      finishJob(job, '合成完成', result);
    }
    return result;
  } catch (error) {
    if (outputToCleanOnFailure) {
      await fsp.rm(outputToCleanOnFailure, { force: true }).catch(() => {});
    }
    failJob(job, error, '视频合成失败');
    throw error;
  } finally {
    fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function resolveVideoEditClipPayload(body) {
  const renderPlanClips = Array.isArray(body?.renderPlan?.clips) ? body.renderPlan.clips : [];
  if (renderPlanClips.length > 0) return renderPlanClips;
  return body?.clips;
}

function safeRenderPlanNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function renderPlanUnsupportedList(renderPlan) {
  if (!renderPlan || typeof renderPlan !== 'object' || !Array.isArray(renderPlan.unsupported)) return [];
  return renderPlan.unsupported
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function assertRenderPlanSupported(renderPlan) {
  const unsupported = renderPlanUnsupportedList(renderPlan);
  if (unsupported.length === 0) return;
  const visibleItems = unsupported.slice(0, 5).join('、');
  const suffix = unsupported.length > 5 ? ` 等 ${unsupported.length} 项` : '';
  throw new Error(`当前视频剪辑导出暂不支持：${visibleItems}${suffix}`);
}

function sanitizeRenderPlanCapabilities(value) {
  const capabilities = value && typeof value === 'object' ? value : {};
  return {
    timelineLayerCompose: !!capabilities.timelineLayerCompose,
    timelineLayerCount: Math.max(0, Math.round(safeRenderPlanNumber(capabilities.timelineLayerCount, 0))),
    timelineGaps: !!capabilities.timelineGaps,
    timelineAudioMix: !!capabilities.timelineAudioMix,
    sourceAudioMix: !!capabilities.sourceAudioMix,
    subtitleBurnIn: !!capabilities.subtitleBurnIn,
  };
}

function sanitizeRenderPlanSegment(segment) {
  if (!segment || typeof segment !== 'object') return null;
  const timelineStart = Math.max(0, safeRenderPlanNumber(segment.timelineStart, 0));
  const timelineEnd = Math.max(timelineStart, safeRenderPlanNumber(segment.timelineEnd, timelineStart));
  return {
    ...segment,
    timelineStart,
    timelineEnd,
  };
}

function resolveVideoEditRenderPlanPayload(body) {
  const plan = body && typeof body === 'object' && body.renderPlan && typeof body.renderPlan === 'object'
    ? body.renderPlan
    : {};
  const clips = Array.isArray(plan.clips) ? plan.clips.map(sanitizeRenderPlanSegment).filter(Boolean) : [];
  const audio = Array.isArray(plan.audio) ? plan.audio.map(sanitizeRenderPlanSegment).filter(Boolean) : [];
  const text = Array.isArray(plan.text) ? plan.text.map(sanitizeRenderPlanSegment).filter(Boolean) : [];
  const tracks = Array.isArray(plan.tracks) ? plan.tracks.filter((track) => track && typeof track === 'object') : [];
  const warnings = Array.isArray(plan.warnings) ? plan.warnings.filter((item) => typeof item === 'string') : [];
  const unsupported = renderPlanUnsupportedList(plan);
  const capabilities = sanitizeRenderPlanCapabilities(plan.capabilities);
  return {
    version: 1,
    duration: Math.max(0, safeRenderPlanNumber(plan.duration, 0)),
    tracks,
    clips,
    audio,
    text,
    capabilities,
    unsupported,
    warnings,
  };
}

function escapeDrawtextValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, '\\n')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function normalizeDrawtextColor(value, fallback = '#ffffff') {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  if (/^[a-zA-Z]+$/.test(raw)) return raw.toLowerCase();
  return fallback;
}

function normalizeDrawtextBoxColor(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const rgba = raw.match(/^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*([01](?:\.\d+)?)\s*\)$/i);
  if (rgba) {
    const [r, g, b] = rgba.slice(1, 4).map((item) => Math.max(0, Math.min(255, Number(item))));
    const alpha = Math.max(0, Math.min(1, Number(rgba[4])));
    const hex = [r, g, b].map((item) => Math.round(item).toString(16).padStart(2, '0')).join('');
    return `0x${hex}@${alpha.toFixed(2)}`;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  if (/^[a-zA-Z]+(?:@[0-9.]+)?$/.test(raw)) return raw.toLowerCase();
  return 'black@0.45';
}

function subtitleYExpression(position) {
  const normalized = String(position || 'bottom').toLowerCase();
  if (normalized === 'top') return '58';
  if (normalized === 'middle' || normalized === 'center') return '(h-th)/2';
  return 'h-th-58';
}

function subtitleStyleValue(segment, key, fallback) {
  if (!segment || typeof segment !== 'object') return fallback;
  if (segment[key] !== undefined) return segment[key];
  const style = segment.style && typeof segment.style === 'object' ? segment.style : null;
  if (style && style[key] !== undefined) return style[key];
  if (key === 'background' && style?.backgroundColor !== undefined) return style.backgroundColor;
  return fallback;
}

function subtitleTextUnit(char) {
  if (!char) return 0;
  if (/[\u1100-\u11ff\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char)) return 1;
  if (/\s/.test(char)) return 0.28;
  return 0.54;
}

function subtitleTextUnits(value) {
  return Array.from(String(value || '')).reduce((sum, char) => sum + subtitleTextUnit(char), 0);
}

function wrapSubtitleDrawtextText(value, size = {}, fontSize = 42) {
  const source = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!source) return '';
  const width = Math.max(1, Math.round(safeRenderPlanNumber(size.width, 1280)));
  const safeFontSize = Math.max(12, Math.min(160, Math.round(safeRenderPlanNumber(fontSize, 42))));
  const maxUnits = Math.max(8, Math.floor((width * 0.82) / Math.max(8, safeFontSize * 0.56)));
  const lines = [];
  const flushLine = (line) => {
    const clean = String(line || '').trim();
    if (clean) lines.push(clean);
  };

  for (const paragraph of source.split('\n')) {
    let line = '';
    for (const char of Array.from(paragraph)) {
      const next = `${line}${char}`;
      if (line && subtitleTextUnits(next) > maxUnits) {
        flushLine(line);
        line = char.trimStart();
      } else {
        line = next;
      }
    }
    flushLine(line);
  }
  return lines.join('\n');
}

function buildSubtitleDrawtextFilters(textSegments = [], size = {}) {
  if (!Array.isArray(textSegments)) return [];
  const height = Math.max(1, Math.round(safeRenderPlanNumber(size.height, 720)));
  const defaultFontSize = Math.max(18, Math.min(96, Math.round(height * 0.058)));
  return textSegments.flatMap((segment) => {
    if (!segment || typeof segment !== 'object') return [];
    const text = typeof segment.text === 'string' ? segment.text.trim() : '';
    if (!text) return [];
    const start = Math.max(0, safeRenderPlanNumber(segment.timelineStart, 0));
    const end = Math.max(start + 0.05, safeRenderPlanNumber(segment.timelineEnd, start + 0.05));
    const fontSize = Math.max(12, Math.min(160, Math.round(safeRenderPlanNumber(subtitleStyleValue(segment, 'fontSize', defaultFontSize), defaultFontSize))));
    const wrappedText = wrapSubtitleDrawtextText(text, size, fontSize);
    const color = normalizeDrawtextColor(subtitleStyleValue(segment, 'color', '#ffffff'));
    const boxColor = normalizeDrawtextBoxColor(subtitleStyleValue(segment, 'background', 'rgba(0,0,0,0.45)'));
    const y = subtitleYExpression(subtitleStyleValue(segment, 'position', 'bottom'));
    const options = [
      `text='${escapeDrawtextValue(wrappedText)}'`,
      'expansion=none',
      `fontsize=${fontSize}`,
      `fontcolor=${color}`,
      'x=(w-tw)/2',
      `y=${y}`,
      'box=1',
      `boxcolor=${boxColor}`,
      'boxborderw=18',
      `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`,
    ];
    return [`drawtext=${options.join(':')}`];
  });
}

async function burnSubtitleTextIntoVideo(input, output, textSegments, size, job) {
  const filters = buildSubtitleDrawtextFilters(textSegments, size);
  if (filters.length === 0) {
    return { subtitleBurnedIn: false, subtitleCount: 0 };
  }
  job.message = '烧录字幕轨';
  job.progress = Math.max(Number(job.progress) || 0, 90);
  await runFfmpeg([
    '-y',
    '-i', input,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', filters.join(','),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    output,
  ], job);
  return { subtitleBurnedIn: true, subtitleCount: filters.length };
}

router.post('/probe', async (req, res) => {
  // Probe is an internal diagnostic trace. It must never mint a standalone
  // durable Run/NodeRun/Attempt; the owning execution records it when needed.
  const job = makeJob('probe');
  try {
    const url = req.body?.videoUrl || req.body?.url;
    const data = await probeVideoUrl(url, job);
    finishJob(job, '探测完成', data);
    res.json({ success: true, data });
  } catch (error) {
    failJob(job, error, '读取视频信息失败');
    res.status(400).json({ success: false, error: job.error, job: publicJob(job) });
  }
});

router.post('/timeline-preview', async (req, res) => {
  // Timeline preview is an internal UI trace, not an independently executable
  // workflow action and therefore intentionally has no durable Run evidence.
  const job = makeJob('timeline-preview');
  try {
    const data = await createTimelinePreview(req.body?.clip, req.body?.options || {}, job);
    res.json({ success: true, data });
  } catch (error) {
    const status = job.cancelled ? 499 : 500;
    res.status(status).json({ success: false, error: error?.message || '时间线预览失败', job: publicJob(job) });
  }
});

function scheduleAsyncVideoCompose(clips, settings, job, renderPlan) {
  const executor = asyncComposeExecutorOverride || composeVideoEdit;
  return scheduleAsyncVideoOperation(job, () => executor(clips, settings, job, { renderPlan }), '视频合成失败');
}

function scheduleAsyncVideoOperation(job, executor, fallbackMessage) {
  if (videoOperationsShutdownRequested) {
    if (!isTerminalJob(job)) {
      try { cancelJob(job, '应用正在退出，视频任务已取消'); } catch (_) {}
    }
    return Promise.resolve();
  }
  const task = new Promise((resolve) => {
    setImmediate(async () => {
      try {
        if (videoOperationsShutdownRequested) throw videoOperationLifecycleError();
        await executor();
      } catch (error) {
        // Normal executors record their own terminal failure. Keep the scheduling
        // boundary fail-closed for injected executors and pre-executor failures.
        if (!isTerminalJob(job)) {
          try { failJob(job, error, fallbackMessage); } catch (_) {}
        }
      } finally {
        resolve();
      }
    });
  });
  return trackAsyncVideoOperation(task);
}

function shutdownVideoOperationsLifecycle(options = {}) {
  if (!videoOperationsShutdownPromise) {
    videoOperationsShutdownRequested = true;
    const cancelledJobIds = [];
    const persistenceFailures = [];
    for (const job of jobs.values()) {
      if (isTerminalJob(job)) continue;
      cancelledJobIds.push(job.id);
      try {
        cancelJob(job, '应用正在退出，视频任务已取消');
      } catch (error) {
        persistenceFailures.push({ jobId: job.id, code: String(error?.code || 'terminal-persistence-failed') });
      }
    }
    const timeoutMs = Math.max(
      100,
      Math.min(30_000, Number(options.timeoutMs) || VIDEO_OPS_SHUTDOWN_TIMEOUT_MS),
    );
    videoOperationsShutdownPromise = waitForAsyncVideoOperations(timeoutMs).then((tasks) => ({
      tasks,
      cancelledJobIds,
      persistenceFailures,
      forced: !tasks.drained,
    }));
  }
  return videoOperationsShutdownPromise;
}

function resetVideoOperationsLifecycleForTests() {
  if (activeAsyncVideoOperations.size !== 0) throw new Error('仍有视频任务运行，不能重置 lifecycle');
  videoOperationsShutdownRequested = false;
  videoOperationsShutdownPromise = null;
  asyncVideoOperationDrainWaiters.clear();
}

function prepareDurableVideoOperationRequest(req, action) {
  const body = req?.body || {};
  const hasEvidence = hasOwn(body, 'executionEvidence');
  const hasExecutionInput = hasOwn(body, 'executionInput');
  if (!hasEvidence && !hasExecutionInput) {
    if (!isLoopbackVideoOpsRequest(req)) {
      throw syntheticExecutionError('无持久证据的兼容视频任务仅允许私有 loopback 路由', 403);
    }
    const synthetic = createSyntheticVideoOperationExecution(action, body);
    const evidence = validateVideoOperationInputBinding({
      ...body,
      ...synthetic,
      executionInput: synthetic.executionInput,
    }, synthetic.evidence, action);
    return {
      binding: synthetic,
      job: makeJob(action, evidence, {
        requireExecutionEvidence: true,
        syntheticExecution: true,
      }),
    };
  }
  // A single supplied field is never treated as compatibility mode.
  const evidence = validateVideoOperationInputBinding(body, body.executionEvidence, action);
  return {
    binding: buildVideoOperationBinding(action, body),
    job: makeJob(action, evidence, { requireExecutionEvidence: true }),
  };
}

function sendDurableReplayResponse(res, job, fallbackMessage) {
  if (job?._reusedDurableExecution !== true) return false;
  if (job.status === 'done' && job.result) {
    res.json({ success: true, data: job.result, job: publicJob(job) });
    return true;
  }
  if (!isTerminalJob(job) && job.status !== 'interrupted') {
    res.status(202).json({ success: true, data: publicJob(job) });
    return true;
  }
  const status = job.status === 'cancelled' ? 499 : job.status === 'interrupted' ? 503 : 500;
  res.status(status).json({
    success: false,
    error: job.error || job.message || fallbackMessage,
    job: publicJob(job),
  });
  return true;
}

async function executeSeparateAudioBinding(binding, job) {
  try {
    const override = operationExecutorOverrides.get('separate-audio');
    const result = override
      ? await override(binding, job)
      : await separateVideoAudio(binding.clips, binding.settings, binding.mode, job, { renderPlan: binding.renderPlan });
    if (!isTerminalJob(job)) finishJob(job, '音频处理完成', result);
    return result;
  } catch (error) {
    if (!isTerminalJob(job)) failJob(job, error, '音频处理失败');
    throw error;
  }
}

async function executeSnapshotBinding(binding, job) {
  try {
    const override = operationExecutorOverrides.get('snapshot');
    const result = override
      ? await override(binding, job)
      : await snapshotVideoFrame(binding.clip, binding.time, {
          format: binding.format,
          sourceLabel: binding.sourceLabel,
        }, job);
    if (!isTerminalJob(job)) finishJob(job, '截图完成', result);
    return result;
  } catch (error) {
    if (!isTerminalJob(job)) failJob(job, error, '视频截图失败');
    throw error;
  }
}

router.post('/compose', async (req, res) => {
  let job;
  let renderPlan;
  let composeClips;
  let composeSettings;
  let syntheticBridgeAttempted = false;
  try {
    if (req.body?.async === true) {
      const hasEvidence = hasOwn(req.body, 'executionEvidence');
      const hasExecutionInput = hasOwn(req.body, 'executionInput');
      if (!hasEvidence && !hasExecutionInput) {
        if (!isLoopbackVideoOpsRequest(req)) {
          throw syntheticExecutionError('无持久证据的兼容视频任务仅允许私有 loopback 路由', 403);
        }
        syntheticBridgeAttempted = true;
        const synthetic = createSyntheticVideoOperationExecution(req.body || {});
        const executionEvidence = validateVideoOperationInputBinding({
          clips: synthetic.clips,
          settings: synthetic.settings,
          timelineV2: synthetic.timelineV2,
          renderPlan: synthetic.renderPlan,
          executionInput: synthetic.executionInput,
        }, synthetic.evidence, 'compose');
        job = makeJob('compose', executionEvidence, {
          requireExecutionEvidence: true,
          syntheticExecution: true,
        });
        renderPlan = synthetic.renderPlan;
        composeClips = synthetic.clips;
        composeSettings = synthetic.settings;
      } else {
        // Partial evidence is never treated as legacy compatibility. Both
        // fields must validate against an already-authoritative action.
        const executionEvidence = validateVideoOperationInputBinding(req.body, req.body?.executionEvidence, 'compose');
        job = makeJob('compose', executionEvidence, { requireExecutionEvidence: true });
        renderPlan = resolveVideoEditRenderPlanPayload(req.body);
        composeClips = resolveVideoEditClipPayload(req.body);
        composeSettings = req.body?.settings || {};
      }
    } else {
      job = makeJob('compose', req.body?.executionEvidence);
      renderPlan = resolveVideoEditRenderPlanPayload(req.body);
      composeClips = resolveVideoEditClipPayload(req.body);
      composeSettings = req.body?.settings || {};
    }
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'video.compose.prepare' })) return;
    const status = Number(error?.statusCode) || (syntheticBridgeAttempted ? 503 : 400);
    return res.status(status).json({ success: false, error: error?.message || '视频任务执行证据无效' });
  }
  if (req.body?.async === true) {
    if (job._reusedDurableExecution !== true) {
      const task = scheduleAsyncVideoCompose(composeClips, composeSettings, job, renderPlan);
      res.locals?.trackApplicationTask?.(task);
    }
    return res.json({ success: true, data: publicJob(job) });
  }
  if (sendDurableReplayResponse(res, job, '视频合成未成功完成')) return;
  try {
    const data = await composeVideoEdit(composeClips, composeSettings, job, { renderPlan });
    res.json({ success: true, data });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'video.compose.execute' })) return;
    const status = job.cancelled ? 499 : 500;
    res.status(status).json({ success: false, error: error?.message || '视频合成失败', job: publicJob(job) });
  }
});

router.post('/separate-audio', async (req, res) => {
  let prepared;
  try {
    prepared = prepareDurableVideoOperationRequest(req, 'separate-audio');
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'video.separate-audio.prepare' })) return;
    const status = Number(error?.statusCode) || 400;
    return res.status(status).json({ success: false, error: error?.message || '音频任务执行证据无效' });
  }
  const { binding, job } = prepared;
  if (req.body?.async === true) {
    if (job._reusedDurableExecution !== true) {
      const task = scheduleAsyncVideoOperation(job, () => executeSeparateAudioBinding(binding, job), '音频处理失败');
      res.locals?.trackApplicationTask?.(task);
    }
    return res.json({ success: true, data: publicJob(job) });
  }
  if (sendDurableReplayResponse(res, job, '音频处理未成功完成')) return;
  try {
    const data = await executeSeparateAudioBinding(binding, job);
    res.json({ success: true, data, job: publicJob(job) });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'video.separate-audio.execute' })) return;
    const status = job.cancelled ? 499 : 500;
    res.status(status).json({ success: false, error: error?.message || '音频处理失败', job: publicJob(job) });
  }
});

router.post('/snapshot', async (req, res) => {
  let prepared;
  try {
    prepared = prepareDurableVideoOperationRequest(req, 'snapshot');
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'video.snapshot.prepare' })) return;
    const status = Number(error?.statusCode) || 400;
    return res.status(status).json({ success: false, error: error?.message || '截图任务执行证据无效' });
  }
  const { binding, job } = prepared;
  if (sendDurableReplayResponse(res, job, '视频截图未成功完成')) return;
  try {
    const data = await executeSnapshotBinding(binding, job);
    res.json({ success: true, data, job: publicJob(job) });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'video.snapshot.execute' })) return;
    const status = job.cancelled ? 499 : 500;
    res.status(status).json({ success: false, error: error?.message || '视频截图失败', job: publicJob(job) });
  }
});

router.get('/jobs/:id', (req, res) => {
  try {
    cleanupFinishedJobs();
    const job = jobs.get(req.params.id) || reconstructDurableVideoOperationJob(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: '任务不存在' });
    if (jobs.has(req.params.id)) persistVideoOperationProgress(job);
    return res.json({ success: true, data: publicJob(job) });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'video.job.read-progress' })) return;
    return res.status(503).json({ success: false, error: error?.message || '读取视频任务持久证据失败' });
  }
});

router.post('/jobs/:id/cancel', (req, res) => {
  try {
    cleanupFinishedJobs();
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: '任务不存在' });
    cancelJob(job);
    return res.json({ success: true, data: publicJob(job) });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'video.job.cancel' })) return;
    throw error;
  }
});

router._test = {
  JOB_TTL_MS,
  MAX_REMOTE_VIDEO_BYTES,
  REMOTE_VIDEO_DEADLINE_MS,
  REMOTE_VIDEO_IDLE_TIMEOUT_MS,
  makeJob,
  finishJob,
  failJob,
  cancelJob,
  cleanupFinishedJobs,
  normalizeVideoOperationExecutionEvidence,
  buildVideoOperationBinding,
  validateVideoOperationInputBinding,
  requireVideoOperationExecutionAuthority,
  createSyntheticVideoOperationExecution,
  finalizeSyntheticVideoOperationExecution,
  isLoopbackVideoOpsRequest,
  persistVideoOperationEvent,
  readDurableVideoOperationEvents,
  reconstructDurableVideoOperationJob,
  resolveDurableVideoOperationReplay,
  prepareDurableVideoOperationRequest,
  scheduleAsyncVideoOperation,
  shutdownVideoOperationsLifecycle,
  waitForAsyncVideoOperations,
  asyncVideoOperationStatus,
  resetVideoOperationsLifecycleForTests,
  setExecutionDatabaseForTests: (database) => { executionDatabaseOverride = database; },
  resetExecutionDatabaseForTests: () => { executionDatabaseOverride = undefined; },
  setAsyncComposeExecutorForTests: (executor) => { asyncComposeExecutorOverride = executor; },
  resetAsyncComposeExecutorForTests: () => { asyncComposeExecutorOverride = undefined; },
  setOperationExecutorForTests: (action, executor) => { operationExecutorOverrides.set(action, executor); },
  resetOperationExecutorsForTests: () => { operationExecutorOverrides.clear(); },
  clearJobsForTests: () => jobs.clear(),
  jobCountForTests: () => jobs.size,
  getJobForTest: (id) => publicJob(jobs.get(id)) || null,
  parseProbe,
  parseProbeJson,
  runFfprobeJson,
  probeFile,
  targetSize,
  filterChain,
  getTransitionDefinition,
  hasNativeXfadeSupport,
  transitionDurationSeconds,
  buildXfadeFilterGraph,
  normalizeTimelineAudioSegments,
  normalizeTimelineAudioVolumeCurve,
  normalizeTimelineAudioFade,
  buildTimelineAudioEnvelopeFilters,
  muteVideoFile,
  extractAudioFile,
  separateVideoAudio,
  snapshotVideoFrame,
  createTimelinePreview,
  resolveVideoEditRenderPlanPayload,
  assertRenderPlanSupported,
  wrapSubtitleDrawtextText,
  buildSubtitleDrawtextFilters,
  shouldComposeTimelineVideoLayers,
  extractWaveformPeaks,
  createFilmstripFrames,
  downloadRemoteVideo,
  resolveMountedPath,
  resolveVideoSource,
  composeVideoEdit,
  probeVideoUrl,
};

router.shutdownLifecycle = shutdownVideoOperationsLifecycle;
router.waitForShutdownDrain = waitForAsyncVideoOperations;

module.exports = router;
