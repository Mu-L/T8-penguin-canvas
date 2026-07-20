import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { AlertTriangle, CheckCircle2, HardDrive, Loader2, Pause, Play, Trash2, Upload, WifiOff } from 'lucide-react';
import type {
  AssetRef,
  CollaborationAssetQuota,
  CollaborationAssetQuotaScope,
  CollaborationAssetUploadCompleteResult,
  CollaborationAssetUploadPolicy,
  CollaborationAssetUploadSession,
} from '../types/project';
import { IncrementalSha256, sha256Hex } from '../utils/incrementalSha256';
import {
  collaborationAssetUploadConnectivityAction,
  collaborationAssetUploadErrorCode,
  collaborationAssetUploadErrorKind,
  collaborationAssetUploadRecoveryBinding,
  collaborationAssetUploadRecoveryMetadataMatches,
  type CollaborationAssetUploadErrorKind,
} from '../utils/collaborationAssetUploadState';

export const COLLABORATION_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const MIN_COLLABORATION_UPLOAD_CHUNK_SIZE = 1024 * 1024;
const MAX_COLLABORATION_UPLOAD_CHUNK_SIZE = 16 * 1024 * 1024;

type UploadPhase =
  | 'hashing'
  | 'creating'
  | 'checking'
  | 'uploading'
  | 'completing'
  | 'pausing'
  | 'paused'
  | 'offline'
  | 'scope-conflict'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'error';

interface UploadIdentity {
  sessionId: string | null;
  generation: number;
}

interface UploadTask extends UploadIdentity {
  file: File;
  scopeKey: string;
  chunkSize: number;
  idempotencyKey: string;
  sessionRequested: boolean;
  phase: UploadPhase;
  contentHash?: string;
  chunkHashes: string[];
  hashProgress: number;
  uploadedBytes: number;
  receivedChunks: number[];
  serverGeneration?: number;
  quota?: CollaborationAssetQuota;
  asset?: AssetRef;
  reused?: boolean;
  error?: string;
  errorCode?: string;
  errorKind?: CollaborationAssetUploadErrorKind;
  recoverySessionId?: string;
  recoveryExpectedHash?: string;
}

interface CollaborationAssetUploadProps {
  online: boolean;
  scopeKey: string;
  recoveryGeneration?: string | null;
  onStatus?: (message: string) => void;
}

const ACTIVE_PHASES = new Set<UploadPhase>(['hashing', 'creating', 'checking', 'uploading', 'completing']);
const TERMINAL_SERVER_STATES = new Set(['failed', 'cancelled', 'aborted', 'expired']);
const RECOVERABLE_SERVER_STATES = new Set(['uploading', 'paused', 'assembling']);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function nullableFiniteNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return finiteNumber(value);
}

function normalizeQuotaScope(value: unknown): CollaborationAssetQuotaScope | undefined {
  const source = asRecord(value);
  const hasQuota = ['limitBytes', 'usedBytes', 'reservedBytes', 'availableBytes', 'remainingBytes', 'limit', 'used', 'reserved']
    .some((key) => Object.prototype.hasOwnProperty.call(source, key));
  if (!hasQuota) return undefined;
  const limitBytes = nullableFiniteNumber(source.limitBytes ?? source.limit) ?? null;
  const usedBytes = finiteNumber(source.usedBytes ?? source.used) ?? 0;
  const reservedBytes = finiteNumber(source.reservedBytes ?? source.reserved) ?? 0;
  const explicitAvailable = nullableFiniteNumber(source.availableBytes ?? source.remainingBytes);
  const availableBytes = explicitAvailable === undefined
    ? (limitBytes === null ? null : Math.max(0, limitBytes - usedBytes - reservedBytes))
    : explicitAvailable;
  return { limitBytes, usedBytes, reservedBytes, availableBytes };
}

function normalizeQuota(value: unknown): CollaborationAssetQuota | undefined {
  const outer = asRecord(value);
  const source = asRecord(outer.quota || outer.storageQuota || value);
  const direct = normalizeQuotaScope(source);
  const project = normalizeQuotaScope(source.project);
  const member = source.member === null ? null : normalizeQuotaScope(source.member);
  if (!direct && !project && !member) return undefined;
  const fallback = direct || project || member!;
  const availableValues = [project?.availableBytes, member?.availableBytes]
    .filter((item): item is number => item !== null && item !== undefined);
  return {
    ...fallback,
    availableBytes: direct?.availableBytes ?? (availableValues.length ? Math.min(...availableValues) : fallback.availableBytes),
    project,
    member,
  };
}

function normalizePolicy(value: unknown): CollaborationAssetUploadPolicy {
  const outer = asRecord(value);
  const source = asRecord(outer.policy || value);
  const advertisedChunkSize = finiteNumber(source.chunkSize ?? outer.chunkSize);
  const chunkSize = advertisedChunkSize === undefined
    ? COLLABORATION_UPLOAD_CHUNK_SIZE
    : Math.trunc(advertisedChunkSize);
  if ((advertisedChunkSize !== undefined && !Number.isSafeInteger(advertisedChunkSize))
    || !Number.isSafeInteger(chunkSize)
    || chunkSize < MIN_COLLABORATION_UPLOAD_CHUNK_SIZE
    || chunkSize > MAX_COLLABORATION_UPLOAD_CHUNK_SIZE) {
    throw new Error(`协作网关返回了不受支持的分片大小：${formatBytes(advertisedChunkSize)}`);
  }
  return {
    chunkSize,
    maxFileBytes: nullableFiniteNumber(source.maxFileBytes ?? source.maxUploadBytes ?? outer.maxFileBytes) ?? null,
    quota: normalizeQuota(source.quota || outer.quota || value) || {
      limitBytes: null,
      usedBytes: 0,
      reservedBytes: 0,
      availableBytes: null,
    },
  };
}

function normalizeSession(value: unknown): CollaborationAssetUploadSession {
  const outer = asRecord(value);
  const source = asRecord(outer.session || outer.upload || value);
  const sessionId = String(source.sessionId || source.id || outer.sessionId || '');
  if (!sessionId) throw new Error('协作网关未返回上传 sessionId');
  const state = String(source.state || source.status || '').toLowerCase() || undefined;
  const normalized: CollaborationAssetUploadSession = {
    ...(source as unknown as CollaborationAssetUploadSession),
    sessionId,
    generation: finiteNumber(source.generation ?? outer.generation),
    state: state as CollaborationAssetUploadSession['state'],
    status: state as CollaborationAssetUploadSession['status'],
    quota: normalizeQuota(source.quota || outer.quota),
    asset: (source.asset || outer.asset) as AssetRef | undefined,
    reused: Boolean(source.reused ?? source.deduplicated ?? outer.reused ?? outer.deduplicated),
    deduplicated: Boolean(source.deduplicated ?? outer.deduplicated),
  };
  return normalized;
}

function normalizeRecoverySessions(value: unknown): CollaborationAssetUploadSession[] {
  const source = asRecord(value);
  const sessions = Array.isArray(source.sessions) ? source.sessions : Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const normalized: CollaborationAssetUploadSession[] = [];
  for (const item of sessions) {
    try {
      const session = normalizeSession(item);
      const state = String(session.state || session.status || '').toLowerCase();
      if (!RECOVERABLE_SERVER_STATES.has(state) || seen.has(session.sessionId)) continue;
      seen.add(session.sessionId);
      normalized.push(session);
    } catch {
      // Ignore malformed individual cards; the collection remains usable.
    }
  }
  return normalized;
}

function extractCompleteResult(value: unknown): CollaborationAssetUploadCompleteResult & { session?: CollaborationAssetUploadSession } {
  const outer = asRecord(value);
  const rawWarning = asRecord(outer.persistenceWarning);
  let session: CollaborationAssetUploadSession | undefined;
  if (outer.session || outer.upload || outer.sessionId) {
    session = normalizeSession(value);
  }
  const directAsset = outer.projectId && outer.filename ? outer as unknown as AssetRef : undefined;
  return {
    session,
    asset: (outer.asset as AssetRef | undefined) || session?.asset || directAsset,
    quota: normalizeQuota(outer.quota) || session?.quota,
    reused: Boolean(outer.reused ?? outer.deduplicated ?? session?.reused ?? session?.deduplicated),
    deduplicated: Boolean(outer.deduplicated ?? session?.deduplicated),
    persistenceWarning: rawWarning.code === 'asset_upload_post_commit_capacity' && rawWarning.committed === true
      ? {
          code: 'asset_upload_post_commit_capacity',
          committed: true,
          phase: ['finalization', 'chunk-purge', 'quota-refresh'].includes(String(rawWarning.phase))
            ? String(rawWarning.phase) as 'finalization' | 'chunk-purge' | 'quota-refresh'
            : 'finalization',
          reason: String(rawWarning.reason || 'sqlite-full'),
          retryable: rawWarning.retryable === true,
        }
      : undefined,
  };
}

function postCommitCapacityError(result: CollaborationAssetUploadCompleteResult): Error | null {
  if (result.persistenceWarning?.code !== 'asset_upload_post_commit_capacity'
    || result.persistenceWarning.committed !== true) return null;
  return Object.assign(
    new Error('素材文件和数据库主记录已安全保存，但发布收尾因存储容量不足尚未完成。释放空间后请点击“对账并继续”。'),
    {
      code: 'asset_upload_post_commit_capacity',
      status: 507,
      committed: true,
      data: { persistenceWarning: result.persistenceWarning },
    },
  );
}

function extractReceivedChunks(session: CollaborationAssetUploadSession, totalChunks: number): number[] {
  const received = new Set<number>();
  const add = (value: unknown) => {
    const record = asRecord(value);
    const rawIndex = typeof value === 'number' ? value : record.index;
    const index = finiteNumber(rawIndex);
    const status = String(record.status || '').toLowerCase();
    if (index !== undefined && Number.isInteger(index) && index < totalChunks && !['missing', 'failed', 'rejected'].includes(status)) {
      received.add(index);
    }
  };
  for (const value of session.receivedChunks || []) add(value);
  for (const value of session.receivedIndexes || []) add(value);
  for (const value of session.uploadedChunks || []) add(value);
  for (const value of session.chunks || []) add(value);
  if (session.missingChunks?.length) {
    const missing = new Set(session.missingChunks.map(Number));
    for (let index = 0; index < totalChunks; index += 1) if (!missing.has(index)) received.add(index);
  }
  return [...received].sort((left, right) => left - right);
}

function assertSessionChunkSize(session: CollaborationAssetUploadSession, expectedChunkSize: number) {
  const advertised = finiteNumber(session.chunkSize);
  if (advertised !== undefined && advertised !== expectedChunkSize) {
    throw Object.assign(
      new Error(`服务器上传会话分片大小已变为 ${formatBytes(advertised)}，不能混用旧任务`),
      { code: 'asset_upload_chunk_size_conflict', status: 409 },
    );
  }
}

function uploadedBytesForChunks(indexes: Iterable<number>, fileSize: number, chunkSize: number): number {
  let uploaded = 0;
  for (const index of indexes) {
    const start = index * chunkSize;
    uploaded += Math.max(0, Math.min(chunkSize, fileSize - start));
  }
  return Math.min(fileSize, uploaded);
}

function sameIdentity(left: UploadIdentity | null | undefined, right: UploadIdentity | null | undefined) {
  return Boolean(left && right && left.sessionId === right.sessionId && left.generation === right.generation);
}

function abortError(): DOMException {
  return new DOMException('Upload generation is no longer current', 'AbortError');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quotaFromUploadError(error: unknown): CollaborationAssetQuota | undefined {
  const payload = asRecord(asRecord(error).data);
  return normalizeQuota(payload.data ?? payload.quota ?? payload);
}

function createIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() || `collab-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createSessionRequest(task: UploadTask) {
  return {
    filename: task.file.name,
    size: task.file.size,
    mimeType: task.file.type || 'application/octet-stream',
    contentHash: task.contentHash,
    chunkSize: task.chunkSize,
    idempotencyKey: task.idempotencyKey,
  };
}

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '不限';
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unit]}`;
}

function recoveryChunkSize(session: CollaborationAssetUploadSession): number | null {
  const chunkSize = Number(session.chunkSize);
  return Number.isSafeInteger(chunkSize)
    && chunkSize >= MIN_COLLABORATION_UPLOAD_CHUNK_SIZE
    && chunkSize <= MAX_COLLABORATION_UPLOAD_CHUNK_SIZE
    ? chunkSize
    : null;
}

function recoveryExpectedHash(session: CollaborationAssetUploadSession): string {
  const hash = String(session.expectedHash || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : '';
}

async function collaborationUploadRequest<T>(
  url: string,
  init: RequestInit = {},
  recoveryGeneration: string | null = null,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const method = String(init.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)
    && recoveryGeneration
    && !headers.has('X-T8-Canvas-Generation')) {
    headers.set('X-T8-Canvas-Generation', recoveryGeneration);
  }
  const response = await fetch(url, { credentials: 'same-origin', ...init, headers });
  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { error: text.slice(0, 500) }; }
  }
  if (!response.ok) {
    const record = asRecord(payload);
    const nestedError = asRecord(record.error);
    const message = typeof record.error === 'string'
      ? record.error
      : String(nestedError.message || record.message || `HTTP ${response.status}`);
    const code = String(record.code || nestedError.code || '').trim() || undefined;
    throw Object.assign(new Error(message), { status: response.status, code, data: payload });
  }
  const record = asRecord(payload);
  return (Object.prototype.hasOwnProperty.call(record, 'data') ? record.data : payload) as T;
}

async function hashFileByChunks(
  file: File,
  chunkSize: number,
  identity: UploadIdentity,
  isCurrent: (identity: UploadIdentity) => boolean,
  onProgress: (progress: number) => void,
): Promise<{ contentHash: string; chunkHashes: string[] }> {
  const wholeFileHash = new IncrementalSha256();
  const chunkHashes: string[] = [];
  for (let start = 0; start < file.size; start += chunkSize) {
    const end = Math.min(file.size, start + chunkSize);
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
    if (!isCurrent(identity)) throw abortError();
    wholeFileHash.update(bytes);
    chunkHashes.push(sha256Hex(bytes));
    onProgress(end / file.size);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (!isCurrent(identity)) throw abortError();
  return { contentHash: wholeFileHash.hex(), chunkHashes };
}

function phaseLabel(task: UploadTask): string {
  switch (task.phase) {
    case 'hashing': return `正在计算 SHA-256 · ${Math.round(task.hashProgress * 100)}%`;
    case 'creating': return '正在创建上传会话';
    case 'checking': return '正在与服务器对账分片';
    case 'uploading': return `正在上传 · ${Math.round((task.uploadedBytes / Math.max(1, task.file.size)) * 100)}%`;
    case 'completing': return '正在校验并写入素材库';
    case 'pausing': return '正在暂停服务器会话';
    case 'paused': return '已暂停；继续时会先对账';
    case 'offline': return '连接已中断；服务器确认的分片会在重连后继续';
    case 'scope-conflict': return '协作会话已变化；此任务不会跨会话继续';
    case 'cancelling': return '正在取消服务器会话';
    case 'cancelled': return '已取消';
    case 'completed': return task.reused ? '上传完成 · 已复用相同内容' : '上传完成';
    case 'error': return '上传出错';
  }
}

function uploadErrorHeading(task: UploadTask): string {
  switch (task.errorKind) {
    case 'quota': return '上传配额不足';
    case 'conflict': return '上传会话发生冲突';
    case 'permission': return '上传权限已变化';
    case 'storage': return '主机素材存储不可用';
    default: return '上传未完成';
  }
}

export default function CollaborationAssetUpload({
  online,
  scopeKey: sessionScopeKey,
  recoveryGeneration = null,
  onStatus,
}: CollaborationAssetUploadProps) {
  const scopeKey = `${sessionScopeKey}\u0001${recoveryGeneration || ''}`;
  const [policy, setPolicy] = useState<CollaborationAssetUploadPolicy | null>(null);
  const [policyError, setPolicyError] = useState('');
  const [policyRevision, setPolicyRevision] = useState(0);
  const [task, setTask] = useState<UploadTask | null>(null);
  const [recoverableSessions, setRecoverableSessions] = useState<CollaborationAssetUploadSession[]>([]);
  const [recoveryError, setRecoveryError] = useState('');
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const [recoveryBusySessionId, setRecoveryBusySessionId] = useState<string | null>(null);
  const taskRef = useRef<UploadTask | null>(null);
  const recoverableSessionsRef = useRef<CollaborationAssetUploadSession[]>([]);
  const onlineRef = useRef(online);
  const scopeKeyRef = useRef(scopeKey);
  const generationRef = useRef(0);
  const policyRequestGenerationRef = useRef(0);
  const recoveryRequestGenerationRef = useRef(0);
  const runControllerRef = useRef<{ identity: UploadIdentity; controller: AbortController } | null>(null);
  const recoveryActionControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recoveryFileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingRecoveryRef = useRef<{ session: CollaborationAssetUploadSession; scopeKey: string } | null>(null);
  const mountedRef = useRef(true);

  onlineRef.current = online;
  scopeKeyRef.current = scopeKey;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      policyRequestGenerationRef.current += 1;
      recoveryRequestGenerationRef.current += 1;
      runControllerRef.current?.controller.abort();
      runControllerRef.current = null;
      recoveryActionControllerRef.current?.abort();
      recoveryActionControllerRef.current = null;
      pendingRecoveryRef.current = null;
      taskRef.current = null;
      recoverableSessionsRef.current = [];
    };
  }, []);

  useEffect(() => {
    setPolicy(null);
    if (!online || !scopeKey) {
      setPolicyError('');
      return undefined;
    }
    const controller = new AbortController();
    const requestGeneration = ++policyRequestGenerationRef.current;
    const requestScopeKey = scopeKey;
    const isCurrentPolicyRequest = () => (
      mountedRef.current
      && !controller.signal.aborted
      && onlineRef.current
      && policyRequestGenerationRef.current === requestGeneration
      && scopeKeyRef.current === requestScopeKey
    );
    setPolicyError('');
    void collaborationUploadRequest<unknown>('/api/collab/assets/uploads/policy', { signal: controller.signal })
      .then((value) => {
        if (isCurrentPolicyRequest()) setPolicy(normalizePolicy(value));
      })
      .catch((error) => {
        if (isCurrentPolicyRequest()) setPolicyError(errorMessage(error));
      });
    return () => {
      controller.abort();
      if (policyRequestGenerationRef.current === requestGeneration) {
        policyRequestGenerationRef.current += 1;
      }
    };
  }, [online, policyRevision, scopeKey]);

  useEffect(() => {
    recoverableSessionsRef.current = [];
    setRecoverableSessions([]);
    setRecoveryError('');
    pendingRecoveryRef.current = null;
    recoveryActionControllerRef.current?.abort();
    recoveryActionControllerRef.current = null;
    setRecoveryBusySessionId(null);
    if (!online || !scopeKey) return undefined;
    const controller = new AbortController();
    const requestGeneration = ++recoveryRequestGenerationRef.current;
    const requestScopeKey = scopeKey;
    const isCurrentRecoveryRequest = () => (
      mountedRef.current
      && !controller.signal.aborted
      && onlineRef.current
      && recoveryRequestGenerationRef.current === requestGeneration
      && scopeKeyRef.current === requestScopeKey
    );
    void collaborationUploadRequest<unknown>('/api/collab/assets/uploads', { signal: controller.signal })
      .then((value) => {
        if (!isCurrentRecoveryRequest()) return;
        const sessions = normalizeRecoverySessions(value);
        recoverableSessionsRef.current = sessions;
        setRecoverableSessions(sessions);
      })
      .catch((error) => {
        if (isCurrentRecoveryRequest()) setRecoveryError(`未完成上传读取失败：${errorMessage(error)}`);
      });
    return () => {
      controller.abort();
      if (recoveryRequestGenerationRef.current === requestGeneration) {
        recoveryRequestGenerationRef.current += 1;
      }
    };
  }, [online, recoveryRevision, scopeKey]);

  const isCurrent = useCallback((identity: UploadIdentity) => {
    const current = taskRef.current;
    return Boolean(
      mountedRef.current
      && onlineRef.current
      && current
      && current.scopeKey === scopeKeyRef.current
      && sameIdentity(current, identity),
    );
  }, []);

  const replaceTask = useCallback((next: UploadTask | null) => {
    if (!mountedRef.current) return;
    taskRef.current = next;
    setTask(next);
  }, []);

  const forgetRecoverySession = useCallback((sessionId: string) => {
    if (!mountedRef.current) return;
    const next = recoverableSessionsRef.current.filter((session) => session.sessionId !== sessionId);
    recoverableSessionsRef.current = next;
    setRecoverableSessions(next);
  }, []);

  const updateTask = useCallback((identity: UploadIdentity, update: (current: UploadTask) => UploadTask): boolean => {
    const current = taskRef.current;
    if (!mountedRef.current
      || !current
      || current.scopeKey !== scopeKeyRef.current
      || !sameIdentity(current, identity)) return false;
    replaceTask(update(current));
    return true;
  }, [replaceTask]);

  const acceptServerSnapshot = useCallback((identity: UploadIdentity, snapshot: CollaborationAssetUploadSession): boolean => {
    const current = taskRef.current;
    if (!current || !sameIdentity(current, identity) || snapshot.sessionId !== identity.sessionId) return false;
    if (current.serverGeneration !== undefined && snapshot.generation !== undefined && current.serverGeneration !== snapshot.generation) return false;
    return updateTask(identity, (value) => ({
      ...value,
      serverGeneration: value.serverGeneration ?? snapshot.generation,
      quota: snapshot.quota || value.quota,
    }));
  }, [updateTask]);

  const executeUpload = useCallback(async (initialIdentity: UploadIdentity) => {
    const controller = new AbortController();
    const controllerEntry = { identity: initialIdentity, controller };
    runControllerRef.current = controllerEntry;
    let identity = initialIdentity;
    try {
      let current = taskRef.current;
      if (!current || !sameIdentity(current, identity)) return;

      if (!current.contentHash || current.chunkHashes.length !== Math.ceil(current.file.size / current.chunkSize)) {
        updateTask(identity, (value) => ({ ...value, phase: 'hashing', error: undefined, errorCode: undefined, errorKind: undefined, hashProgress: 0 }));
        const hashes = await hashFileByChunks(current.file, current.chunkSize, identity, isCurrent, (progress) => {
          updateTask(identity, (value) => ({ ...value, hashProgress: progress }));
        });
        if (!updateTask(identity, (value) => ({ ...value, ...hashes, hashProgress: 1 }))) return;
        current = taskRef.current;
        if (!current) return;
      }

      let snapshot: CollaborationAssetUploadSession;
      if (current.sessionId) {
        updateTask(identity, (value) => ({ ...value, phase: 'checking', error: undefined }));
        snapshot = normalizeSession(await collaborationUploadRequest<unknown>(
          `/api/collab/assets/uploads/${encodeURIComponent(current.sessionId)}`,
          { signal: controller.signal },
        ));
        assertSessionChunkSize(snapshot, current.chunkSize);
        if (current.recoverySessionId) {
          const binding = collaborationAssetUploadRecoveryBinding({
            session: snapshot,
            file: {
              name: current.file.name,
              size: current.file.size,
              contentHash: current.contentHash,
            },
            discoveredSessionId: current.recoverySessionId,
            discoveredExpectedHash: current.recoveryExpectedHash || '',
          });
          if (!binding.ok) {
            throw Object.assign(new Error(binding.message), { code: binding.code, status: 409 });
          }
        }
        if (!acceptServerSnapshot(identity, snapshot)) return;
      } else {
        if (!updateTask(identity, (value) => ({ ...value, phase: 'creating', sessionRequested: true, error: undefined }))) return;
        current = taskRef.current;
        if (!current || !sameIdentity(current, identity)) return;
        snapshot = normalizeSession(await collaborationUploadRequest<unknown>('/api/collab/assets/uploads', {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify(createSessionRequest(current)),
        }, recoveryGeneration));
        assertSessionChunkSize(snapshot, current.chunkSize);
        if (!isCurrent(identity)) return;
        const nextIdentity = { sessionId: snapshot.sessionId, generation: identity.generation };
        const adopted: UploadTask = {
          ...taskRef.current!,
          sessionId: snapshot.sessionId,
          serverGeneration: snapshot.generation,
          quota: snapshot.quota || taskRef.current!.quota,
        };
        replaceTask(adopted);
        identity = nextIdentity;
        controllerEntry.identity = nextIdentity;
      }

      let serverState = String(snapshot.state || snapshot.status || '').toLowerCase();
      if (serverState === 'paused') {
        try {
          snapshot = normalizeSession(await collaborationUploadRequest<unknown>(
            `/api/collab/assets/uploads/${encodeURIComponent(identity.sessionId!)}/resume`,
            { method: 'POST', signal: controller.signal },
            recoveryGeneration,
          ));
          assertSessionChunkSize(snapshot, current.chunkSize);
        } catch (error) {
          if ((error as { status?: number })?.status !== 409) throw error;
          snapshot = normalizeSession(await collaborationUploadRequest<unknown>(
            `/api/collab/assets/uploads/${encodeURIComponent(identity.sessionId!)}`,
            { signal: controller.signal },
          ));
          assertSessionChunkSize(snapshot, current.chunkSize);
        }
        if (!acceptServerSnapshot(identity, snapshot)) return;
        serverState = String(snapshot.state || snapshot.status || '').toLowerCase();
      }
      if (serverState === 'paused') throw new Error('服务器上传会话仍处于暂停状态，请重试继续');
      if (serverState === 'completed' || (snapshot.reused && snapshot.asset)) {
        if (!current.contentHash) throw new Error('本地文件哈希缺失，不能校验已完成会话');
        const recovered = extractCompleteResult(await collaborationUploadRequest<unknown>(
          `/api/collab/assets/uploads/${encodeURIComponent(identity.sessionId!)}/complete`,
          {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify({ contentHash: current.contentHash }),
          },
          recoveryGeneration,
        ));
        if (!isCurrent(identity)) return;
        if (recovered.session && !acceptServerSnapshot(identity, recovered.session)) return;
        const committedWarning = postCommitCapacityError(recovered);
        if (committedWarning) {
          updateTask(identity, (value) => ({
            ...value,
            uploadedBytes: value.file.size,
            asset: recovered.asset || snapshot.asset,
            reused: recovered.reused || snapshot.reused,
            quota: recovered.quota || snapshot.quota || value.quota,
          }));
          throw committedWarning;
        }
        updateTask(identity, (value) => ({
          ...value,
          phase: 'completed',
          uploadedBytes: value.file.size,
          asset: recovered.asset || snapshot.asset,
          reused: recovered.reused || snapshot.reused,
          quota: recovered.quota || snapshot.quota || value.quota,
        }));
        onStatus?.(`素材 ${current.file.name} 已加入项目${recovered.reused || snapshot.reused ? '（复用已有内容）' : ''}`);
        if (current.recoverySessionId) forgetRecoverySession(current.recoverySessionId);
        setPolicyRevision((value) => value + 1);
        return;
      }
      if (serverState === 'cancelled' || serverState === 'aborted') {
        updateTask(identity, (value) => ({
          ...value,
          phase: 'cancelled',
          uploadedBytes: 0,
          receivedChunks: [],
          quota: snapshot.quota || value.quota,
        }));
        if (current.recoverySessionId) forgetRecoverySession(current.recoverySessionId);
        setPolicyRevision((value) => value + 1);
        return;
      }
      if (TERMINAL_SERVER_STATES.has(serverState)) {
        const record = snapshot as unknown as Record<string, unknown>;
        throw Object.assign(
          new Error(String(record.errorMessage || `上传会话已${serverState}`)),
          { code: record.errorCode || `asset_upload_session_${serverState}`, status: serverState === 'expired' ? 410 : 409 },
        );
      }

      current = taskRef.current;
      if (!current || !sameIdentity(current, identity)) return;
      const totalChunks = Math.ceil(current.file.size / current.chunkSize);
      const received = new Set(extractReceivedChunks(snapshot, totalChunks));
      const reconciledBytes = Math.max(
        uploadedBytesForChunks(received, current.file.size, current.chunkSize),
        Math.min(current.file.size, finiteNumber(snapshot.receivedBytes) || 0),
      );
      updateTask(identity, (value) => ({
        ...value,
        phase: 'uploading',
        receivedChunks: [...received].sort((left, right) => left - right),
        uploadedBytes: reconciledBytes,
      }));

      for (let index = 0; index < totalChunks; index += 1) {
        if (received.has(index)) continue;
        current = taskRef.current;
        if (!current || !sameIdentity(current, identity)) return;
        const start = index * current.chunkSize;
        const end = Math.min(current.file.size, start + current.chunkSize);
        const chunk = current.file.slice(start, end);
        const chunkHash = current.chunkHashes[index] || sha256Hex(await chunk.arrayBuffer());
        await collaborationUploadRequest<unknown>(
          `/api/collab/assets/uploads/${encodeURIComponent(identity.sessionId!)}/chunks/${index}`,
          {
            method: 'PUT',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Range': `bytes ${start}-${end - 1}/${current.file.size}`,
              'X-Chunk-SHA256': chunkHash,
            },
            body: chunk,
          },
          recoveryGeneration,
        );
        if (!isCurrent(identity)) return;
        received.add(index);
        updateTask(identity, (value) => ({
          ...value,
          phase: 'uploading',
          receivedChunks: [...received].sort((left, right) => left - right),
          uploadedBytes: uploadedBytesForChunks(received, value.file.size, value.chunkSize),
        }));
      }

      current = taskRef.current;
      if (!current || !sameIdentity(current, identity) || !current.contentHash) return;
      updateTask(identity, (value) => ({ ...value, phase: 'completing', uploadedBytes: value.file.size }));
      const complete = extractCompleteResult(await collaborationUploadRequest<unknown>(
        `/api/collab/assets/uploads/${encodeURIComponent(identity.sessionId!)}/complete`,
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({ contentHash: current.contentHash }),
        },
        recoveryGeneration,
      ));
      if (!isCurrent(identity)) return;
      if (complete.session && !acceptServerSnapshot(identity, complete.session)) return;
      const committedWarning = postCommitCapacityError(complete);
      if (committedWarning) {
        updateTask(identity, (value) => ({
          ...value,
          uploadedBytes: value.file.size,
          asset: complete.asset,
          quota: complete.quota || value.quota,
          reused: complete.reused,
        }));
        throw committedWarning;
      }
      updateTask(identity, (value) => ({
        ...value,
        phase: 'completed',
        uploadedBytes: value.file.size,
        asset: complete.asset,
        quota: complete.quota || value.quota,
        reused: complete.reused,
      }));
      onStatus?.(`素材 ${current.file.name} 上传完成${complete.reused ? '（复用已有内容）' : ''}`);
      if (current.recoverySessionId) forgetRecoverySession(current.recoverySessionId);
      setPolicyRevision((value) => value + 1);
    } catch (error) {
      if (controller.signal.aborted || !isCurrent(identity)) return;
      const errorKind = collaborationAssetUploadErrorKind(error);
      const errorCode = collaborationAssetUploadErrorCode(error);
      const quota = errorKind === 'quota' ? quotaFromUploadError(error) : undefined;
      updateTask(identity, (value) => ({
        ...value,
        phase: 'error',
        error: errorMessage(error),
        errorCode,
        errorKind,
        quota: quota || value.quota,
      }));
      onStatus?.(errorCode === 'asset_upload_post_commit_capacity'
        ? `素材已保存，发布收尾待对账：${errorMessage(error)}`
        : `素材上传失败：${errorMessage(error)}`);
    } finally {
      if (runControllerRef.current === controllerEntry) runControllerRef.current = null;
    }
  }, [acceptServerSnapshot, forgetRecoverySession, isCurrent, onStatus, recoveryGeneration, replaceTask, updateTask]);

  useEffect(() => {
    const current = taskRef.current;
    if (!current) return;
    const action = collaborationAssetUploadConnectivityAction({
      online,
      activeScopeKey: scopeKey,
      taskScopeKey: current.scopeKey,
      phase: current.phase,
    });
    if (action === 'continue') return;
    runControllerRef.current?.controller.abort();
    const generation = ++generationRef.current;
    if (action === 'scope-conflict') {
      if (current.phase === 'scope-conflict') return;
      replaceTask({
        ...current,
        generation,
        phase: 'scope-conflict',
        error: '协作项目、画布或授权会话已经变化。旧上传不会在新会话中继续，请重新选择文件。',
        errorCode: 'asset_upload_session_scope_mismatch',
        errorKind: 'conflict',
      });
      onStatus?.(`已冻结 ${current.file.name}：协作会话已变化`);
      return;
    }
    if (action === 'suspend') {
      replaceTask({
        ...current,
        generation,
        phase: 'offline',
        error: undefined,
        errorCode: undefined,
        errorKind: undefined,
      });
      onStatus?.(`连接中断，已保留 ${current.file.name} 的服务器确认进度`);
      return;
    }
    const next: UploadTask = {
      ...current,
      generation,
      phase: current.sessionId ? 'checking' : 'hashing',
      error: undefined,
      errorCode: undefined,
      errorKind: undefined,
    };
    replaceTask(next);
    void executeUpload({ sessionId: next.sessionId, generation });
  }, [executeUpload, online, onStatus, replaceTask, scopeKey]);

  const selectFile = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !onlineRef.current || !policy || !scopeKeyRef.current) return;
    setRecoveryError('');
    const sameMetadata = recoverableSessionsRef.current.filter((session) => (
      String(session.filename || '').normalize('NFKC') === file.name.normalize('NFKC')
      && Number(session.expectedSize) === file.size
    ));
    const matchingRecoveries = sameMetadata.filter((session) => (
      collaborationAssetUploadRecoveryMetadataMatches(session, { name: file.name, size: file.size })
      && recoveryChunkSize(session) !== null
    ));
    if (sameMetadata.length > 1) {
      setRecoveryError('存在多个同名同大小的未完成上传，请在下方选择具体会话后再选择原文件。');
      return;
    }
    if (sameMetadata.length === 1 && matchingRecoveries.length === 0) {
      setRecoveryError('同名旧上传缺少 SHA-256 或分片信息，不能安全自动续传。请显式取消并释放预留空间。');
      return;
    }
    const recovery = matchingRecoveries[0] || null;
    const previous = taskRef.current;
    runControllerRef.current?.controller.abort();
    let previousCleanup: Promise<unknown> = Promise.resolve();
    if (previous?.sessionId
      && previous.scopeKey === scopeKeyRef.current
      && previous.sessionId !== recovery?.sessionId
      && !['completed', 'cancelled', 'scope-conflict'].includes(previous.phase)) {
      previousCleanup = collaborationUploadRequest(
        `/api/collab/assets/uploads/${encodeURIComponent(previous.sessionId)}`,
        { method: 'DELETE' },
        recoveryGeneration,
      ).catch(() => undefined);
    }
    const generation = ++generationRef.current;
    const next: UploadTask = {
      file,
      scopeKey: scopeKeyRef.current,
      chunkSize: recovery ? recoveryChunkSize(recovery)! : policy.chunkSize,
      sessionId: recovery?.sessionId || null,
      generation,
      idempotencyKey: recovery
        ? `existing-session:${recovery.sessionId.slice(-120)}`
        : createIdempotencyKey(),
      sessionRequested: Boolean(recovery),
      phase: 'hashing',
      chunkHashes: [],
      hashProgress: 0,
      uploadedBytes: 0,
      receivedChunks: [],
      quota: policy?.quota,
      recoverySessionId: recovery?.sessionId,
      recoveryExpectedHash: recovery ? recoveryExpectedHash(recovery) : undefined,
    };
    if (file.size <= 0) {
      next.phase = 'error';
      next.error = '不能上传空文件';
    } else if (policy?.maxFileBytes !== null && policy?.maxFileBytes !== undefined && file.size > policy.maxFileBytes) {
      next.phase = 'error';
      next.error = `文件超过网关上限 ${formatBytes(policy.maxFileBytes)}`;
    }
    replaceTask(next);
    if (recovery) onStatus?.(`正在校验并恢复 ${file.name} 的未完成上传`);
    if (next.phase !== 'error') {
      void previousCleanup.then(() => {
        const identity = { sessionId: next.sessionId, generation };
        if (isCurrent(identity)) void executeUpload(identity);
      });
    }
  }, [executeUpload, isCurrent, onStatus, policy, recoveryGeneration, replaceTask]);

  const chooseRecoveryFile = useCallback((session: CollaborationAssetUploadSession) => {
    if (!onlineRef.current || !scopeKeyRef.current || recoveryBusySessionId) return;
    if (!recoveryExpectedHash(session) || recoveryChunkSize(session) === null) {
      setRecoveryError('该旧上传没有完整 SHA-256 或分片信息，不能安全续传；请取消并释放预留空间。');
      return;
    }
    const current = taskRef.current;
    if (current
      && current.sessionId !== session.sessionId
      && !['completed', 'cancelled', 'scope-conflict'].includes(current.phase)) {
      setRecoveryError('请先暂停或取消当前上传，再恢复另一个未完成会话。');
      return;
    }
    setRecoveryError('');
    pendingRecoveryRef.current = { session, scopeKey: scopeKeyRef.current };
    recoveryFileInputRef.current?.click();
  }, [recoveryBusySessionId]);

  const selectRecoveryFile = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    const pending = pendingRecoveryRef.current;
    pendingRecoveryRef.current = null;
    if (!file || !pending || !onlineRef.current || !policy
      || pending.scopeKey !== scopeKeyRef.current) return;
    const session = recoverableSessionsRef.current.find((item) => item.sessionId === pending.session.sessionId);
    if (!session) {
      setRecoveryError('未完成上传列表已经变化，请刷新后重试。');
      return;
    }
    if (!collaborationAssetUploadRecoveryMetadataMatches(session, { name: file.name, size: file.size })) {
      setRecoveryError('所选文件名或大小与该未完成上传不一致；尚未向服务器发送任何分片。');
      return;
    }
    const chunkSize = recoveryChunkSize(session);
    const expectedHash = recoveryExpectedHash(session);
    if (chunkSize === null || !expectedHash) {
      setRecoveryError('该旧上传缺少安全恢复元数据，只能取消并释放预留空间。');
      return;
    }
    const current = taskRef.current;
    if (current
      && current.sessionId !== session.sessionId
      && !['completed', 'cancelled', 'scope-conflict'].includes(current.phase)) {
      setRecoveryError('当前仍有另一个上传任务，未替换或取消任何服务器会话。');
      return;
    }
    runControllerRef.current?.controller.abort();
    const generation = ++generationRef.current;
    const next: UploadTask = {
      file,
      scopeKey: scopeKeyRef.current,
      chunkSize,
      sessionId: session.sessionId,
      generation,
      idempotencyKey: `existing-session:${session.sessionId.slice(-120)}`,
      sessionRequested: true,
      phase: 'hashing',
      chunkHashes: [],
      hashProgress: 0,
      uploadedBytes: 0,
      receivedChunks: [],
      quota: policy.quota,
      recoverySessionId: session.sessionId,
      recoveryExpectedHash: expectedHash,
    };
    if (file.size <= 0) {
      next.phase = 'error';
      next.error = '不能上传空文件';
    } else if (policy.maxFileBytes !== null && file.size > policy.maxFileBytes) {
      next.phase = 'error';
      next.error = `文件超过网关上限 ${formatBytes(policy.maxFileBytes)}`;
    }
    setRecoveryError('');
    replaceTask(next);
    if (next.phase !== 'error') {
      onStatus?.(`正在校验并恢复 ${file.name} 的未完成上传`);
      void executeUpload({ sessionId: session.sessionId, generation });
    }
  }, [executeUpload, onStatus, policy, replaceTask]);

  const cancelRecoverySession = useCallback(async (session: CollaborationAssetUploadSession) => {
    if (!onlineRef.current || !scopeKeyRef.current || recoveryBusySessionId) return;
    const requestScopeKey = scopeKeyRef.current;
    const sessionId = session.sessionId;
    recoveryActionControllerRef.current?.abort();
    const controller = new AbortController();
    recoveryActionControllerRef.current = controller;
    setRecoveryBusySessionId(sessionId);
    setRecoveryError('');
    try {
      await collaborationUploadRequest(
        `/api/collab/assets/uploads/${encodeURIComponent(sessionId)}`,
        { method: 'DELETE', signal: controller.signal },
        recoveryGeneration,
      );
      if (!mountedRef.current || controller.signal.aborted
        || scopeKeyRef.current !== requestScopeKey) return;
      const current = taskRef.current;
      if (current?.sessionId === sessionId) {
        runControllerRef.current?.controller.abort();
        const generation = ++generationRef.current;
        replaceTask({
          ...current,
          generation,
          phase: 'cancelled',
          uploadedBytes: 0,
          receivedChunks: [],
          error: undefined,
          errorCode: undefined,
          errorKind: undefined,
        });
      }
      forgetRecoverySession(sessionId);
      setPolicyRevision((value) => value + 1);
      setRecoveryRevision((value) => value + 1);
      onStatus?.(`已取消 ${session.filename || '未完成上传'} 并释放预留空间`);
    } catch (error) {
      if (mountedRef.current && !controller.signal.aborted
        && scopeKeyRef.current === requestScopeKey) {
        setRecoveryError(`取消未完成上传失败：${errorMessage(error)}`);
      }
    } finally {
      if (recoveryActionControllerRef.current === controller) {
        recoveryActionControllerRef.current = null;
        if (mountedRef.current && scopeKeyRef.current === requestScopeKey) setRecoveryBusySessionId(null);
      }
    }
  }, [forgetRecoverySession, onStatus, recoveryBusySessionId, recoveryGeneration, replaceTask]);

  const pauseUpload = useCallback(async () => {
    const current = taskRef.current;
    if (!current
      || !onlineRef.current
      || current.scopeKey !== scopeKeyRef.current
      || !ACTIVE_PHASES.has(current.phase)) return;
    runControllerRef.current?.controller.abort();
    const generation = ++generationRef.current;
    const identity = { sessionId: current.sessionId, generation };
    if (!identity.sessionId) {
      replaceTask({ ...current, generation, phase: 'paused', error: undefined });
      onStatus?.(`已暂停 ${current.file.name}`);
      return;
    }

    replaceTask({ ...current, generation, phase: 'pausing', error: undefined });
    const controller = new AbortController();
    const controllerEntry = { identity, controller };
    runControllerRef.current = controllerEntry;
    let snapshot: CollaborationAssetUploadSession;
    let pauseFailure: unknown;
    try {
      try {
        snapshot = normalizeSession(await collaborationUploadRequest<unknown>(
          `/api/collab/assets/uploads/${encodeURIComponent(identity.sessionId)}/pause`,
          { method: 'POST', signal: controller.signal },
          recoveryGeneration,
        ));
        assertSessionChunkSize(snapshot, current.chunkSize);
      } catch (error) {
        if (controller.signal.aborted || !isCurrent(identity)) return;
        pauseFailure = error;
        snapshot = normalizeSession(await collaborationUploadRequest<unknown>(
          `/api/collab/assets/uploads/${encodeURIComponent(identity.sessionId)}`,
          { signal: controller.signal },
        ));
        assertSessionChunkSize(snapshot, current.chunkSize);
      }
      if (!isCurrent(identity) || !acceptServerSnapshot(identity, snapshot)) return;
      const serverState = String(snapshot.state || snapshot.status || '').toLowerCase();
      if (serverState === 'paused') {
        updateTask(identity, (value) => ({ ...value, phase: 'paused', quota: snapshot.quota || value.quota }));
        onStatus?.(`已暂停 ${current.file.name}`);
        return;
      }
      if (serverState === 'completed') {
        updateTask(identity, (value) => ({ ...value, phase: 'checking', quota: snapshot.quota || value.quota }));
        void executeUpload(identity);
        return;
      }
      const reason = pauseFailure ? errorMessage(pauseFailure) : `服务器会话状态为 ${serverState || 'unknown'}`;
      const source = pauseFailure || { code: 'asset_upload_state_conflict', status: 409 };
      updateTask(identity, (value) => ({
        ...value,
        phase: 'error',
        error: `暂停失败：${reason}`,
        errorCode: collaborationAssetUploadErrorCode(source),
        errorKind: collaborationAssetUploadErrorKind(source),
      }));
    } catch (error) {
      if (controller.signal.aborted || !isCurrent(identity)) return;
      const source = pauseFailure || error;
      updateTask(identity, (value) => ({
        ...value,
        phase: 'error',
        error: `暂停失败：${errorMessage(source)}`,
        errorCode: collaborationAssetUploadErrorCode(source),
        errorKind: collaborationAssetUploadErrorKind(source),
      }));
    } finally {
      if (runControllerRef.current === controllerEntry) runControllerRef.current = null;
    }
  }, [acceptServerSnapshot, executeUpload, isCurrent, onStatus, recoveryGeneration, replaceTask, updateTask]);

  const resumeUpload = useCallback(() => {
    const current = taskRef.current;
    if (!current
      || !onlineRef.current
      || current.scopeKey !== scopeKeyRef.current
      || !['paused', 'error'].includes(current.phase)) return;
    const generation = ++generationRef.current;
    const next = {
      ...current,
      generation,
      phase: current.sessionId ? 'checking' : 'hashing',
      error: undefined,
      errorCode: undefined,
      errorKind: undefined,
    } as UploadTask;
    replaceTask(next);
    void executeUpload({ sessionId: next.sessionId, generation });
  }, [executeUpload, replaceTask]);

  const cancelUpload = useCallback(async () => {
    const current = taskRef.current;
    if (!current
      || !onlineRef.current
      || current.scopeKey !== scopeKeyRef.current
      || ['completed', 'cancelled', 'cancelling', 'scope-conflict'].includes(current.phase)) return;
    runControllerRef.current?.controller.abort();
    const generation = ++generationRef.current;
    const identity = { sessionId: current.sessionId, generation };
    replaceTask({ ...current, generation, phase: 'cancelling', error: undefined });
    const controller = new AbortController();
    const controllerEntry = { identity, controller };
    runControllerRef.current = controllerEntry;
    try {
      let sessionId = identity.sessionId;
      if (!sessionId && current.sessionRequested && current.contentHash) {
        const recovered = normalizeSession(await collaborationUploadRequest<unknown>('/api/collab/assets/uploads', {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify(createSessionRequest(current)),
        }, recoveryGeneration));
        assertSessionChunkSize(recovered, current.chunkSize);
        sessionId = recovered.sessionId;
      }
      if (sessionId) {
        await collaborationUploadRequest(`/api/collab/assets/uploads/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          signal: controller.signal,
        }, recoveryGeneration);
      }
      if (!isCurrent(identity)) return;
      updateTask(identity, (value) => ({ ...value, phase: 'cancelled', uploadedBytes: 0, receivedChunks: [] }));
      if (current.recoverySessionId) forgetRecoverySession(current.recoverySessionId);
      onStatus?.(`已取消 ${current.file.name}`);
      setPolicyRevision((value) => value + 1);
      setRecoveryRevision((value) => value + 1);
    } catch (error) {
      if (controller.signal.aborted || !isCurrent(identity)) return;
      updateTask(identity, (value) => ({
        ...value,
        phase: 'error',
        error: `取消失败：${errorMessage(error)}`,
        errorCode: collaborationAssetUploadErrorCode(error),
        errorKind: collaborationAssetUploadErrorKind(error),
      }));
    } finally {
      if (runControllerRef.current === controllerEntry) runControllerRef.current = null;
    }
  }, [forgetRecoverySession, isCurrent, onStatus, recoveryGeneration, replaceTask, updateTask]);

  const clearTask = useCallback(() => {
    runControllerRef.current?.controller.abort();
    generationRef.current += 1;
    replaceTask(null);
  }, [replaceTask]);

  const quota = task?.quota || policy?.quota;
  const progress = task
    ? task.phase === 'hashing'
      ? task.hashProgress
      : task.phase === 'completed'
        ? 1
        : task.uploadedBytes / Math.max(1, task.file.size)
    : 0;

  return (
    <section className="mb-5 border-y border-[var(--border-primary)] py-4" aria-label="协作素材上传">
      <div className="mb-3 flex items-center gap-2">
        <HardDrive size={15} />
        <h3 className="text-xs font-bold">项目素材上传</h3>
        <span className="ml-auto text-[9px] opacity-55">{formatBytes(task?.chunkSize || policy?.chunkSize || COLLABORATION_UPLOAD_CHUNK_SIZE)} 分片</span>
      </div>
      {quota && (
        <div className="mb-3 rounded bg-[var(--bg-primary)] p-2 text-[9px] leading-4 text-[var(--text-secondary)]">
          {quota.project ? (
            <>
              <div>项目：{formatBytes(quota.project.usedBytes)} / {formatBytes(quota.project.limitBytes)} · 预留 {formatBytes(quota.project.reservedBytes)}</div>
              <div>项目可用 {formatBytes(quota.project.availableBytes)}</div>
              {quota.member && <div>个人：{formatBytes(quota.member.usedBytes)} / {formatBytes(quota.member.limitBytes)} · 可用 {formatBytes(quota.member.availableBytes)}</div>}
            </>
          ) : (
            <>
              <div>配额：{quota.limitBytes === null ? '不限' : `${formatBytes(quota.usedBytes)} / ${formatBytes(quota.limitBytes)}`}</div>
              <div>预留 {formatBytes(quota.reservedBytes)} · 可用 {formatBytes(quota.availableBytes)}</div>
            </>
          )}
        </div>
      )}
      {!online && <div role="status" className="mb-3 flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[9px] leading-4 text-amber-700"><WifiOff size={12} className="mt-0.5 shrink-0" /><span>协作连接离线。上传 HTTP 已停止，已由服务器确认的分片会在同一会话重连后对账恢复。</span></div>}
      {policyError && <div role="alert" className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[9px] leading-4 text-amber-600">上传策略读取失败：{policyError}</div>}
      {recoveryError && <div role="alert" className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[9px] leading-4 text-amber-700">{recoveryError}</div>}
      <input ref={fileInputRef} type="file" className="sr-only" onChange={selectFile} aria-label="选择要上传到项目的文件" disabled={!online || !policy || !scopeKey} />
      <input ref={recoveryFileInputRef} type="file" className="sr-only" onChange={selectRecoveryFile} aria-label="选择未完成上传的原文件" disabled={!online || !policy || !scopeKey} />
      {recoverableSessions.length > 0 && (
        <div className="mb-3 space-y-2" aria-label="未完成的素材上传">
          <div className="rounded border border-amber-500/35 bg-amber-500/10 p-2 text-[9px] leading-4 text-amber-700">
            发现当前协作会话的未完成上传。刷新页面不会盲目取消服务器预留；选择原文件后会先核对文件名、大小和完整 SHA-256，或显式取消释放空间。
          </div>
          {recoverableSessions.map((session) => {
            const expectedSize = Number(session.expectedSize) || 0;
            const receivedBytes = Math.min(expectedSize, Number(session.receivedBytes) || 0);
            const progressPercent = expectedSize > 0 ? Math.round((receivedBytes / expectedSize) * 100) : 0;
            const resumable = Boolean(recoveryExpectedHash(session) && recoveryChunkSize(session) !== null);
            const otherTaskActive = Boolean(task
              && task.sessionId !== session.sessionId
              && !['completed', 'cancelled', 'scope-conflict'].includes(task.phase));
            const busy = recoveryBusySessionId === session.sessionId;
            return (
              <article key={session.sessionId} className="rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2.5">
                <div className="flex items-start gap-2">
                  {busy ? <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" /> : <HardDrive size={13} className="mt-0.5 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[10px] font-bold" title={session.filename}>{session.filename || '未命名素材'}</div>
                    <div className="mt-1 text-[8px] opacity-60">
                      {formatBytes(expectedSize)} · 已确认 {formatBytes(receivedBytes)}（{progressPercent}%） · {String(session.status || session.state || 'uploading')}
                    </div>
                    {!resumable && <div className="mt-1 text-[8px] text-amber-700">缺少可验证的 SHA-256 或分片信息，只允许取消。</div>}
                  </div>
                </div>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className="h-7 flex-1 rounded border border-[var(--accent-primary)] text-[8px] font-bold text-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => chooseRecoveryFile(session)}
                    disabled={!online || busy || Boolean(recoveryBusySessionId) || !resumable || otherTaskActive}
                  >选择原文件并续传</button>
                  <button
                    type="button"
                    className="h-7 flex-1 rounded border border-red-500/40 text-[8px] font-bold text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => void cancelRecoverySession(session)}
                    disabled={!online || busy || Boolean(recoveryBusySessionId) || otherTaskActive}
                  >取消并释放预留</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <button
        type="button"
        className="flex h-9 w-full items-center justify-center gap-2 rounded border border-[var(--border-primary)] text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => fileInputRef.current?.click()}
        disabled={!online || !policy || !scopeKey}
      >
        <Upload size={13} />{!online ? '等待协作重连' : !policy ? '正在读取上传策略' : task ? '选择其他文件' : recoverableSessions.length ? '选择文件（自动匹配未完成上传）' : '选择文件'}
      </button>
      {task && (
        <article className="mt-3 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
          <div className="flex items-start gap-2">
            {task.phase === 'completed'
              ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-green-500" />
              : task.phase === 'offline'
                ? <WifiOff size={15} className="mt-0.5 shrink-0 text-amber-600" />
                : task.phase === 'scope-conflict' || task.phase === 'error'
                  ? <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />
                  : ACTIVE_PHASES.has(task.phase) || ['pausing', 'cancelling'].includes(task.phase)
                    ? <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin" />
                    : <HardDrive size={15} className="mt-0.5 shrink-0" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[10px] font-bold" title={task.file.name}>{task.file.name}</div>
              <div className="mt-1 text-[9px] opacity-55">{formatBytes(task.file.size)} · {phaseLabel(task)}</div>
            </div>
          </div>
          <div
            className="mt-3 h-1.5 overflow-hidden rounded bg-black/10"
            role="progressbar"
            aria-label={`${task.file.name} 上传进度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.max(0, Math.min(1, progress)) * 100)}
          >
            <div className="h-full bg-[var(--accent-primary)] transition-[width]" style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }} />
          </div>
          {task.sessionId && <div className="mt-2 truncate font-mono text-[8px] opacity-45" title={task.sessionId}>session {task.sessionId}</div>}
          {task.phase === 'scope-conflict' && <div role="alert" className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[9px] leading-4 text-amber-700"><strong className="block">协作作用域冲突</strong>{task.error}</div>}
          {task.phase === 'error' && task.error && (
            <div role="alert" data-error-kind={task.errorKind || 'general'} className={`mt-2 rounded border p-2 text-[9px] leading-4 ${task.errorKind === 'quota' || task.errorKind === 'conflict' ? 'border-amber-500/40 bg-amber-500/10 text-amber-700' : 'border-red-500/40 bg-red-500/10 text-red-500'}`}>
              <strong className="block">{uploadErrorHeading(task)}</strong>
              <span>{task.error}</span>
              {task.errorCode && <span className="mt-1 block font-mono text-[8px] opacity-60">{task.errorCode}</span>}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            {online && task.scopeKey === scopeKey && ACTIVE_PHASES.has(task.phase) && <button type="button" className="flex h-8 flex-1 items-center justify-center gap-1 rounded border border-[var(--border-primary)] text-[9px] font-bold" onClick={() => void pauseUpload()}><Pause size={11} />暂停</button>}
            {online && task.scopeKey === scopeKey && ['paused', 'error'].includes(task.phase) && <button type="button" className="flex h-8 flex-1 items-center justify-center gap-1 rounded border border-[var(--accent-primary)] text-[9px] font-bold text-[var(--accent-primary)]" onClick={resumeUpload}><Play size={11} />对账并继续</button>}
            {online && task.scopeKey === scopeKey && !['completed', 'cancelled', 'cancelling', 'scope-conflict'].includes(task.phase) && <button type="button" className="flex h-8 flex-1 items-center justify-center gap-1 rounded border border-red-500/40 text-[9px] font-bold text-red-500" onClick={() => void cancelUpload()}><Trash2 size={11} />取消</button>}
            {['completed', 'cancelled', 'scope-conflict'].includes(task.phase) && <button type="button" className="h-8 flex-1 rounded border border-[var(--border-primary)] text-[9px] font-bold" onClick={clearTask}>清除</button>}
          </div>
        </article>
      )}
    </section>
  );
}
