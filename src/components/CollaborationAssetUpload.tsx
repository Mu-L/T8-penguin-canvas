import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { CheckCircle2, HardDrive, Loader2, Pause, Play, Trash2, Upload } from 'lucide-react';
import type {
  AssetRef,
  CollaborationAssetQuota,
  CollaborationAssetQuotaScope,
  CollaborationAssetUploadCompleteResult,
  CollaborationAssetUploadPolicy,
  CollaborationAssetUploadSession,
} from '../types/project';
import { IncrementalSha256, sha256Hex } from '../utils/incrementalSha256';

export const COLLABORATION_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

type UploadPhase =
  | 'hashing'
  | 'creating'
  | 'checking'
  | 'uploading'
  | 'completing'
  | 'pausing'
  | 'paused'
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
}

interface CollaborationAssetUploadProps {
  onStatus?: (message: string) => void;
}

const ACTIVE_PHASES = new Set<UploadPhase>(['hashing', 'creating', 'checking', 'uploading', 'completing']);
const TERMINAL_SERVER_STATES = new Set(['failed', 'cancelled', 'aborted', 'expired']);

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
  if (advertisedChunkSize !== undefined && advertisedChunkSize !== COLLABORATION_UPLOAD_CHUNK_SIZE) {
    throw new Error(`协作网关要求 ${formatBytes(advertisedChunkSize)} 分片，当前客户端仅支持 8 MiB`);
  }
  return {
    chunkSize: COLLABORATION_UPLOAD_CHUNK_SIZE,
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

function extractCompleteResult(value: unknown): CollaborationAssetUploadCompleteResult & { session?: CollaborationAssetUploadSession } {
  const outer = asRecord(value);
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
  };
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

function uploadedBytesForChunks(indexes: Iterable<number>, fileSize: number): number {
  let uploaded = 0;
  for (const index of indexes) {
    const start = index * COLLABORATION_UPLOAD_CHUNK_SIZE;
    uploaded += Math.max(0, Math.min(COLLABORATION_UPLOAD_CHUNK_SIZE, fileSize - start));
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

function createIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() || `collab-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createSessionRequest(task: UploadTask) {
  return {
    filename: task.file.name,
    size: task.file.size,
    mimeType: task.file.type || 'application/octet-stream',
    contentHash: task.contentHash,
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

async function collaborationUploadRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
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
    throw Object.assign(new Error(message), { status: response.status, data: payload });
  }
  const record = asRecord(payload);
  return (Object.prototype.hasOwnProperty.call(record, 'data') ? record.data : payload) as T;
}

async function hashFileByChunks(
  file: File,
  identity: UploadIdentity,
  isCurrent: (identity: UploadIdentity) => boolean,
  onProgress: (progress: number) => void,
): Promise<{ contentHash: string; chunkHashes: string[] }> {
  const wholeFileHash = new IncrementalSha256();
  const chunkHashes: string[] = [];
  for (let start = 0; start < file.size; start += COLLABORATION_UPLOAD_CHUNK_SIZE) {
    const end = Math.min(file.size, start + COLLABORATION_UPLOAD_CHUNK_SIZE);
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
    case 'cancelling': return '正在取消服务器会话';
    case 'cancelled': return '已取消';
    case 'completed': return task.reused ? '上传完成 · 已复用相同内容' : '上传完成';
    case 'error': return '上传出错';
  }
}

export default function CollaborationAssetUpload({ onStatus }: CollaborationAssetUploadProps) {
  const [policy, setPolicy] = useState<CollaborationAssetUploadPolicy | null>(null);
  const [policyError, setPolicyError] = useState('');
  const [policyRevision, setPolicyRevision] = useState(0);
  const [task, setTask] = useState<UploadTask | null>(null);
  const taskRef = useRef<UploadTask | null>(null);
  const generationRef = useRef(0);
  const runControllerRef = useRef<{ identity: UploadIdentity; controller: AbortController } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setPolicyError('');
    void collaborationUploadRequest<unknown>('/api/collab/assets/uploads/policy', { signal: controller.signal })
      .then((value) => setPolicy(normalizePolicy(value)))
      .catch((error) => { if (!controller.signal.aborted) setPolicyError(errorMessage(error)); });
    return () => controller.abort();
  }, [policyRevision]);

  useEffect(() => () => runControllerRef.current?.controller.abort(), []);

  const isCurrent = useCallback((identity: UploadIdentity) => sameIdentity(taskRef.current, identity), []);

  const replaceTask = useCallback((next: UploadTask | null) => {
    taskRef.current = next;
    setTask(next);
  }, []);

  const updateTask = useCallback((identity: UploadIdentity, update: (current: UploadTask) => UploadTask): boolean => {
    const current = taskRef.current;
    if (!current || !sameIdentity(current, identity)) return false;
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

      if (!current.contentHash || current.chunkHashes.length !== Math.ceil(current.file.size / COLLABORATION_UPLOAD_CHUNK_SIZE)) {
        updateTask(identity, (value) => ({ ...value, phase: 'hashing', error: undefined, hashProgress: 0 }));
        const hashes = await hashFileByChunks(current.file, identity, isCurrent, (progress) => {
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
        if (!acceptServerSnapshot(identity, snapshot)) return;
      } else {
        if (!updateTask(identity, (value) => ({ ...value, phase: 'creating', sessionRequested: true, error: undefined }))) return;
        current = taskRef.current;
        if (!current || !sameIdentity(current, identity)) return;
        snapshot = normalizeSession(await collaborationUploadRequest<unknown>('/api/collab/assets/uploads', {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify(createSessionRequest(current)),
        }));
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
          ));
        } catch (error) {
          if ((error as { status?: number })?.status !== 409) throw error;
          snapshot = normalizeSession(await collaborationUploadRequest<unknown>(
            `/api/collab/assets/uploads/${encodeURIComponent(identity.sessionId!)}`,
            { signal: controller.signal },
          ));
        }
        if (!acceptServerSnapshot(identity, snapshot)) return;
        serverState = String(snapshot.state || snapshot.status || '').toLowerCase();
      }
      if (serverState === 'paused') throw new Error('服务器上传会话仍处于暂停状态，请重试继续');
      if (serverState === 'completed' || (snapshot.reused && snapshot.asset)) {
        updateTask(identity, (value) => ({
          ...value,
          phase: 'completed',
          uploadedBytes: value.file.size,
          asset: snapshot.asset,
          reused: snapshot.reused,
          quota: snapshot.quota || value.quota,
        }));
        onStatus?.(`素材 ${current.file.name} 已加入项目${snapshot.reused ? '（复用已有内容）' : ''}`);
        setPolicyRevision((value) => value + 1);
        return;
      }
      if (TERMINAL_SERVER_STATES.has(serverState)) throw new Error(`上传会话已${serverState}`);

      current = taskRef.current;
      if (!current || !sameIdentity(current, identity)) return;
      const totalChunks = Math.ceil(current.file.size / COLLABORATION_UPLOAD_CHUNK_SIZE);
      const received = new Set(extractReceivedChunks(snapshot, totalChunks));
      const reconciledBytes = Math.max(
        uploadedBytesForChunks(received, current.file.size),
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
        const start = index * COLLABORATION_UPLOAD_CHUNK_SIZE;
        const end = Math.min(current.file.size, start + COLLABORATION_UPLOAD_CHUNK_SIZE);
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
        );
        if (!isCurrent(identity)) return;
        received.add(index);
        updateTask(identity, (value) => ({
          ...value,
          phase: 'uploading',
          receivedChunks: [...received].sort((left, right) => left - right),
          uploadedBytes: uploadedBytesForChunks(received, value.file.size),
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
      ));
      if (!isCurrent(identity)) return;
      if (complete.session && !acceptServerSnapshot(identity, complete.session)) return;
      updateTask(identity, (value) => ({
        ...value,
        phase: 'completed',
        uploadedBytes: value.file.size,
        asset: complete.asset,
        quota: complete.quota || value.quota,
        reused: complete.reused,
      }));
      onStatus?.(`素材 ${current.file.name} 上传完成${complete.reused ? '（复用已有内容）' : ''}`);
      setPolicyRevision((value) => value + 1);
    } catch (error) {
      if (controller.signal.aborted || !isCurrent(identity)) return;
      updateTask(identity, (value) => ({ ...value, phase: 'error', error: errorMessage(error) }));
      onStatus?.(`素材上传失败：${errorMessage(error)}`);
    } finally {
      if (runControllerRef.current === controllerEntry) runControllerRef.current = null;
    }
  }, [acceptServerSnapshot, isCurrent, onStatus, replaceTask, updateTask]);

  const selectFile = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const previous = taskRef.current;
    runControllerRef.current?.controller.abort();
    if (previous?.sessionId && !['completed', 'cancelled'].includes(previous.phase)) {
      void collaborationUploadRequest(`/api/collab/assets/uploads/${encodeURIComponent(previous.sessionId)}`, { method: 'DELETE' }).catch(() => undefined);
    }
    const generation = ++generationRef.current;
    const next: UploadTask = {
      file,
      sessionId: null,
      generation,
      idempotencyKey: createIdempotencyKey(),
      sessionRequested: false,
      phase: 'hashing',
      chunkHashes: [],
      hashProgress: 0,
      uploadedBytes: 0,
      receivedChunks: [],
      quota: policy?.quota,
    };
    if (file.size <= 0) {
      next.phase = 'error';
      next.error = '不能上传空文件';
    } else if (policy?.maxFileBytes !== null && policy?.maxFileBytes !== undefined && file.size > policy.maxFileBytes) {
      next.phase = 'error';
      next.error = `文件超过网关上限 ${formatBytes(policy.maxFileBytes)}`;
    }
    replaceTask(next);
    if (next.phase !== 'error') void executeUpload({ sessionId: null, generation });
  }, [executeUpload, policy, replaceTask]);

  const pauseUpload = useCallback(async () => {
    const current = taskRef.current;
    if (!current || !ACTIVE_PHASES.has(current.phase)) return;
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
        ));
      } catch (error) {
        if (controller.signal.aborted || !isCurrent(identity)) return;
        pauseFailure = error;
        snapshot = normalizeSession(await collaborationUploadRequest<unknown>(
          `/api/collab/assets/uploads/${encodeURIComponent(identity.sessionId)}`,
          { signal: controller.signal },
        ));
      }
      if (!isCurrent(identity) || !acceptServerSnapshot(identity, snapshot)) return;
      const serverState = String(snapshot.state || snapshot.status || '').toLowerCase();
      if (serverState === 'paused') {
        updateTask(identity, (value) => ({ ...value, phase: 'paused', quota: snapshot.quota || value.quota }));
        onStatus?.(`已暂停 ${current.file.name}`);
        return;
      }
      if (serverState === 'completed') {
        updateTask(identity, (value) => ({
          ...value,
          phase: 'completed',
          uploadedBytes: value.file.size,
          asset: snapshot.asset,
          reused: snapshot.reused,
          quota: snapshot.quota || value.quota,
        }));
        onStatus?.(`素材 ${current.file.name} 已完成，无法再暂停`);
        setPolicyRevision((value) => value + 1);
        return;
      }
      const reason = pauseFailure ? errorMessage(pauseFailure) : `服务器会话状态为 ${serverState || 'unknown'}`;
      updateTask(identity, (value) => ({ ...value, phase: 'error', error: `暂停失败：${reason}` }));
    } catch (error) {
      if (controller.signal.aborted || !isCurrent(identity)) return;
      updateTask(identity, (value) => ({ ...value, phase: 'error', error: `暂停失败：${errorMessage(pauseFailure || error)}` }));
    } finally {
      if (runControllerRef.current === controllerEntry) runControllerRef.current = null;
    }
  }, [acceptServerSnapshot, isCurrent, onStatus, replaceTask, updateTask]);

  const resumeUpload = useCallback(() => {
    const current = taskRef.current;
    if (!current || !['paused', 'error'].includes(current.phase)) return;
    const generation = ++generationRef.current;
    const next = { ...current, generation, phase: current.sessionId ? 'checking' : 'hashing', error: undefined } as UploadTask;
    replaceTask(next);
    void executeUpload({ sessionId: next.sessionId, generation });
  }, [executeUpload, replaceTask]);

  const cancelUpload = useCallback(async () => {
    const current = taskRef.current;
    if (!current || ['completed', 'cancelled', 'cancelling'].includes(current.phase)) return;
    runControllerRef.current?.controller.abort();
    const generation = ++generationRef.current;
    const identity = { sessionId: current.sessionId, generation };
    replaceTask({ ...current, generation, phase: 'cancelling', error: undefined });
    try {
      let sessionId = identity.sessionId;
      if (!sessionId && current.sessionRequested && current.contentHash) {
        const recovered = normalizeSession(await collaborationUploadRequest<unknown>('/api/collab/assets/uploads', {
          method: 'POST',
          body: JSON.stringify(createSessionRequest(current)),
        }));
        sessionId = recovered.sessionId;
      }
      if (sessionId) {
        await collaborationUploadRequest(`/api/collab/assets/uploads/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      }
      if (!isCurrent(identity)) return;
      updateTask(identity, (value) => ({ ...value, phase: 'cancelled', uploadedBytes: 0, receivedChunks: [] }));
      onStatus?.(`已取消 ${current.file.name}`);
      setPolicyRevision((value) => value + 1);
    } catch (error) {
      if (!isCurrent(identity)) return;
      updateTask(identity, (value) => ({ ...value, phase: 'error', error: `取消失败：${errorMessage(error)}` }));
    }
  }, [isCurrent, onStatus, replaceTask, updateTask]);

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
        <span className="ml-auto text-[9px] opacity-55">8 MiB 分片</span>
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
      {policyError && <div role="alert" className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[9px] leading-4 text-amber-600">上传策略读取失败：{policyError}</div>}
      <input ref={fileInputRef} type="file" className="sr-only" onChange={selectFile} aria-label="选择要上传到项目的文件" />
      <button
        type="button"
        className="flex h-9 w-full items-center justify-center gap-2 rounded border border-[var(--border-primary)] text-[10px] font-bold"
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload size={13} />{task ? '选择其他文件' : '选择文件'}
      </button>
      {task && (
        <article className="mt-3 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
          <div className="flex items-start gap-2">
            {task.phase === 'completed' ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-green-500" /> : ACTIVE_PHASES.has(task.phase) || ['pausing', 'cancelling'].includes(task.phase) ? <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin" /> : <HardDrive size={15} className="mt-0.5 shrink-0" />}
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
          {task.error && <div role="alert" className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-[9px] leading-4 text-red-500">{task.error}</div>}
          <div className="mt-3 flex gap-2">
            {ACTIVE_PHASES.has(task.phase) && <button type="button" className="flex h-8 flex-1 items-center justify-center gap-1 rounded border border-[var(--border-primary)] text-[9px] font-bold" onClick={() => void pauseUpload()}><Pause size={11} />暂停</button>}
            {['paused', 'error'].includes(task.phase) && <button type="button" className="flex h-8 flex-1 items-center justify-center gap-1 rounded border border-[var(--accent-primary)] text-[9px] font-bold text-[var(--accent-primary)]" onClick={resumeUpload}><Play size={11} />继续</button>}
            {!['completed', 'cancelled', 'cancelling'].includes(task.phase) && <button type="button" className="flex h-8 flex-1 items-center justify-center gap-1 rounded border border-red-500/40 text-[9px] font-bold text-red-500" onClick={() => void cancelUpload()}><Trash2 size={11} />取消</button>}
            {['completed', 'cancelled'].includes(task.phase) && <button type="button" className="h-8 flex-1 rounded border border-[var(--border-primary)] text-[9px] font-bold" onClick={clearTask}>清除</button>}
          </div>
        </article>
      )}
    </section>
  );
}
