const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  extensionInfo,
  hashFile,
  previewStatePatchForJob,
  readMetadata,
  stableAssetId,
} = require('./assetIndexer');
const { getAssetBlobStore } = require('./assetBlobStore');
const {
  translateProjectDatabaseStorageCapacityError,
} = require('./projectDatabase');
const {
  PUBLIC_PROJECT_DATABASE_CAPACITY_REASONS,
} = require('./projectDatabasePublicError');
const { validateUploadedAsset } = require('../collaboration/gatewaySecurity');

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_UPLOAD_ERROR_CODE_PATTERN = /^(?:asset_upload_[a-z0-9_]+|CAS_[A-Z0-9_]+)$/;
const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9._:-]{8,160}$/;
const COLLABORATION_UPLOAD_SESSION_PREFIX = 'asset-upload-';
const UPLOAD_SESSION_ID_PATTERN = /^asset-upload-[a-f0-9-]{20,80}$/i;
const ACTIVE_UPLOAD_SESSION_STATUSES = new Set(['uploading', 'paused', 'assembling']);
const TERMINAL_UPLOAD_SESSION_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired']);
const TERMINAL_UPLOAD_FINALIZATION_STATES = new Set(['completed', 'failed']);
const PREVIEW_ASSET_KINDS = new Set(['image', 'video', 'audio', 'model3d']);

const FILESYSTEM_UPLOAD_ERRORS = Object.freeze({
  ENOENT: {
    code: 'asset_upload_storage_missing',
    message: '上传暂存数据缺失，请重新开始本次上传',
  },
  EACCES: {
    code: 'asset_upload_storage_forbidden',
    message: '主机暂存文件无法读写，请联系主机管理员后重试',
  },
  EPERM: {
    code: 'asset_upload_storage_forbidden',
    message: '主机暂存文件无法读写，请联系主机管理员后重试',
  },
  EBUSY: {
    code: 'asset_upload_storage_busy',
    message: '主机暂存文件正在被占用，请稍后重试',
  },
  ENOSPC: {
    code: 'asset_upload_storage_full',
    message: '主机存储空间不足，请释放空间后重新上传',
  },
  EDQUOT: {
    code: 'asset_upload_storage_full',
    message: '主机存储配额已用尽，请释放空间后重新上传',
  },
  EIO: {
    code: 'asset_upload_storage_io_failed',
    message: '主机存储读写失败，请稍后重新上传',
  },
});

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function boundedScopePart(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 240 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw uploadError('asset_upload_scope_invalid', '上传会话授权作用域无效', 403);
  }
  return normalized;
}

function collaborationUploadScope(context = {}, options = {}) {
  const sourceKind = String(context.sourceKind || 'collaboration');
  if (sourceKind !== 'collaboration') return null;
  const projectId = boundedScopePart(context.projectId);
  const canvasId = boundedScopePart(context.canvasId);
  const memberId = boundedScopePart(context.memberId);
  const sessionId = boundedScopePart(context.sessionId);
  const authorizationEpoch = options.requireEpoch === false
    ? ''
    : boundedScopePart(context.authorizationEpoch);
  const sessionDigest = sha256Buffer(Buffer.from(JSON.stringify({
    projectId,
    canvasId,
    memberId,
    sessionId,
  }), 'utf8')).slice(0, 16);
  const epochDigest = authorizationEpoch
    ? sha256Buffer(Buffer.from(JSON.stringify({
      projectId,
      canvasId,
      memberId,
      sessionId,
      authorizationEpoch,
    }), 'utf8')).slice(0, 12)
    : null;
  return {
    projectId,
    canvasId,
    memberId,
    sessionId,
    authorizationEpoch,
    sessionPrefix: `${COLLABORATION_UPLOAD_SESSION_PREFIX}${sessionDigest}-`,
    fullPrefix: epochDigest
      ? `${COLLABORATION_UPLOAD_SESSION_PREFIX}${sessionDigest}-${epochDigest}-`
      : null,
  };
}

function containsHostAbsolutePath(value) {
  const candidates = [String(value || '')];
  try {
    const decoded = decodeURIComponent(candidates[0]);
    if (decoded !== candidates[0]) candidates.push(decoded);
  } catch (_) {}
  return candidates.some((candidate) => (
    /(?:^|[^a-z0-9])[a-z]:[\\/]/i.test(candidate)
    || /\\\\(?:\?\\)?[^\\/\s]+[\\/][^\s]/.test(candidate)
    || /(^|[\s("'`=,:;?&#])\/(?!\/)[^\s"'`<>]+/.test(candidate)
  ));
}

function safeUploadErrorCode(error, fallback = 'asset_upload_failed') {
  const rawCode = String(error?.code || '').trim();
  if (SAFE_UPLOAD_ERROR_CODE_PATTERN.test(rawCode)) return rawCode.slice(0, 160);
  return FILESYSTEM_UPLOAD_ERRORS[rawCode]?.code || fallback;
}

function safeUploadErrorMessage(error, fallback = '上传处理失败，请稍后重试') {
  const rawCode = String(error?.code || '').trim();
  const filesystemMessage = FILESYSTEM_UPLOAD_ERRORS[rawCode]?.message;
  if (filesystemMessage) return filesystemMessage;
  const message = String(error?.message || fallback).replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!message || containsHostAbsolutePath(message)) return fallback;
  return message.slice(0, 500);
}

function safeError(error, fallback = '上传处理失败，请稍后重试') {
  return safeUploadErrorMessage(error, fallback);
}

function uploadError(code, message, status = 400, current = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.current = current;
  return error;
}

function translateAssetUploadStorageCapacityError(error, operation, current = null) {
  const alreadyTranslated = error?.code === 'asset_upload_storage_full' && Number(error?.status) === 507;
  const translated = alreadyTranslated
    ? error
    : translateProjectDatabaseStorageCapacityError(error, { operation });
  if (!alreadyTranslated && translated?.code !== 'project_database_storage_capacity_exceeded') return error;
  const rawReason = String(translated?.reason || translated?.details?.reason || '');
  const reason = PUBLIC_PROJECT_DATABASE_CAPACITY_REASONS.has(rawReason)
    ? rawReason
    : 'sqlite-full';
  const retryable = translated?.retryable === true || translated?.details?.retryable === true;
  const capacityError = uploadError(
    'asset_upload_storage_full',
    '主机存储空间或数据库容量不足，本次上传操作未完成，请释放空间后重试',
    507,
    current || error?.current || null,
  );
  capacityError.statusCode = 507;
  capacityError.reason = reason;
  capacityError.retryable = retryable;
  capacityError.details = Object.freeze({
    reason,
    retryable,
  });
  return capacityError;
}

function isAssetUploadStorageCapacityError(error) {
  return error?.code === 'asset_upload_storage_full' && Number(error?.status) === 507;
}

function normalizeHash(value, optional = false) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized && optional) return null;
  if (!SHA256_PATTERN.test(normalized)) throw uploadError('asset_upload_hash_invalid', 'SHA-256 格式无效', 422);
  return normalized;
}

function safeFilename(value) {
  const filename = path.basename(String(value || '')).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300);
  if (!filename || filename === '.' || filename === '..') throw uploadError('asset_upload_filename_invalid', '上传文件名无效', 400);
  return filename;
}

async function writeFileAtomic(filename, buffer) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.part-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx');
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.write(buffer, offset, buffer.length - offset, null);
      if (!result.bytesWritten) throw new Error('分片写入未取得进展');
      offset += result.bytesWritten;
    }
    await handle.sync();
    await handle.close();
    handle = null;
    if (fs.existsSync(filename)) {
      const existingHash = await hashFile(filename);
      if (existingHash !== sha256Buffer(buffer)) throw uploadError('asset_upload_chunk_disk_conflict', '已有分片与提交内容不一致', 409);
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, filename);
    }
  } catch (error) {
    try { await handle?.close(); } catch (_) {}
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

class AssetUploadManager {
  constructor(config, database, options = {}) {
    this.config = config;
    this.database = database;
    this.previewPipeline = options.previewPipeline || null;
    this.beforeLiveFinalizationGrant = typeof options.beforeLiveFinalizationGrant === 'function'
      ? options.beforeLiveFinalizationGrant
      : null;
    this.blobStore = options.blobStore || getAssetBlobStore(config);
    const fallbackDataRoot = config.DATA_DIR
      || (config.INPUT_DIR ? path.join(path.dirname(path.resolve(config.INPUT_DIR)), 'data') : path.join(process.cwd(), 'data'));
    this.tempRoot = path.resolve(config.COLLAB_UPLOAD_TEMP_DIR || path.join(fallbackDataRoot, 'collaboration-uploads'));
    this.chunkSize = Math.max(1024 * 1024, Math.min(16 * 1024 * 1024, Number(config.COLLAB_UPLOAD_CHUNK_BYTES) || 8 * 1024 * 1024));
    this.maxUploadBytes = Math.max(this.chunkSize, Number(config.COLLAB_MAX_UPLOAD_BYTES) || 512 * 1024 * 1024);
    this.sessionTtlMs = Math.max(5 * 60 * 1000, Number(config.COLLAB_UPLOAD_SESSION_TTL_MS) || 24 * 60 * 60 * 1000);
    this.locks = new Map();
    fs.mkdirSync(this.tempRoot, { recursive: true });
    const recovered = typeof database.recoverInterruptedAssetUploadSessions === 'function'
      ? this._withStorageCapacityBoundary(
        'asset.upload.recover-interrupted',
        () => database.recoverInterruptedAssetUploadSessions(),
      )
      : [];
    this._reconcileSessionStorage(recovered);
    this.sweepExpired();
    this._reconcilePendingUploadFinalizations();
    this.startupGcPromise = this.gcPendingBlobs().catch(() => {});
  }

  _withDatabaseWrite(operation, callback, current = null) {
    try {
      if (typeof this.database.withProjectDatabaseWrite === 'function') {
        return this.database.withProjectDatabaseWrite(operation, callback);
      }
      return callback(this.database);
    } catch (error) {
      throw translateAssetUploadStorageCapacityError(error, operation, current);
    }
  }

  _withStorageCapacityBoundary(operation, callback, current = null) {
    try {
      const result = callback();
      if (result && typeof result.then === 'function') {
        return result.catch((error) => {
          throw translateAssetUploadStorageCapacityError(error, operation, current);
        });
      }
      return result;
    } catch (error) {
      throw translateAssetUploadStorageCapacityError(error, operation, current);
    }
  }

  async _withLock(key, task) {
    const previous = this.locks.get(key) || Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }

  _sessionLockKey(sessionId) {
    return `session:${String(sessionId || '')}`;
  }

  _lockedSessionIds() {
    const locked = new Set();
    for (const key of this.locks.keys()) {
      const normalized = String(key || '');
      if (!normalized.startsWith('session:')) continue;
      const sessionId = normalized.slice('session:'.length);
      if (sessionId) locked.add(sessionId);
    }
    return locked;
  }

  _scopedSessionIdentity(context = {}) {
    return collaborationUploadScope(context);
  }

  _newScopedSessionId(scope) {
    return `${scope.fullPrefix}${crypto.randomUUID()}`;
  }

  _scopedIdempotencyKey(rawKey, scope) {
    const idempotencyKey = String(rawKey || '').trim();
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw uploadError('asset_upload_request_invalid', '上传幂等键无效', 400);
    }
    if (!scope) return idempotencyKey;
    const digest = sha256Buffer(Buffer.from(JSON.stringify({
      projectId: scope.projectId,
      canvasId: scope.canvasId,
      memberId: scope.memberId,
      sessionId: scope.sessionId,
      authorizationEpoch: scope.authorizationEpoch,
      idempotencyKey,
    }), 'utf8'));
    return `upload-v2-${digest}`;
  }

  _sessionDirectory(sessionId) {
    const normalized = String(sessionId || '');
    if (!UPLOAD_SESSION_ID_PATTERN.test(normalized)) throw uploadError('asset_upload_session_invalid', '上传会话 ID 无效', 400);
    const target = path.resolve(this.tempRoot, normalized);
    if (target === this.tempRoot || !target.startsWith(`${this.tempRoot}${path.sep}`)) throw uploadError('asset_upload_path_invalid', '上传会话路径无效', 400);
    return target;
  }

  _chunkPath(sessionId, index) {
    return path.join(this._sessionDirectory(sessionId), `chunk-${String(index).padStart(8, '0')}.part`);
  }

  _removeAssemblyFiles(sessionIds = []) {
    for (const sessionId of sessionIds) {
      let directory;
      try { directory = this._sessionDirectory(sessionId); } catch (_) { continue; }
      if (!fs.existsSync(directory)) continue;
      try {
        if (fs.lstatSync(directory).isSymbolicLink()) {
          fs.rmSync(directory, { force: true });
          continue;
        }
      } catch (_) { continue; }
      let entries = [];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { continue; }
      for (const entry of entries) {
        if (entry.isFile() && /^assembly-.*\.part$/i.test(entry.name)) {
          try { fs.unlinkSync(path.join(directory, entry.name)); } catch (_) {}
        }
      }
    }
  }

  _cleanupSessionFiles(sessionId) {
    const directory = this._sessionDirectory(sessionId);
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch (_) {}
  }

  sweepExpired(now = Date.now()) {
    if (typeof this.database.expireAssetUploadSessions !== 'function') return [];
    const timestamp = Number(now) || Date.now();
    const lockedSessionIds = this._lockedSessionIds();
    let expired = [];
    if (typeof this.database.expireUnlockedAssetUploadSessions === 'function') {
      expired = this._withStorageCapacityBoundary('asset.upload.expire', () => (
        this.database.expireUnlockedAssetUploadSessions(timestamp, lockedSessionIds)
      ));
    } else {
      // Conservative compatibility for test doubles/older repositories that
      // do not expose the atomic storage API: never expire a locked session.
      if (lockedSessionIds.size > 0) return [];
      expired = this._withDatabaseWrite('asset.upload.expire', () => {
        const applied = this.database.expireAssetUploadSessions(timestamp);
        for (const id of applied) this.database.purgeAssetUploadChunks?.(id);
        return applied;
      });
    }
    for (const id of expired) {
      this._cleanupSessionFiles(id);
    }
    return expired;
  }

  async gcPendingBlobs(limit = 100) {
    if (typeof this.database.listPendingAssetBlobDeletes !== 'function') return { inspected: 0, removed: 0 };
    const pending = this.database.listPendingAssetBlobDeletes(limit);
    let removed = 0;
    for (const blob of pending) {
      if (this.database.assetBlobReferenceCount(blob.contentHash) > 0) continue;
      try {
        await this.blobStore.removeVerifiedBlob(blob.contentHash, {
          expectedSize: blob.byteSize,
          beforeDelete: () => this.database.assetBlobReferenceCount(blob.contentHash) === 0,
        });
        if (this._withDatabaseWrite('asset.upload.blob-delete-mark', () => (
          this.database.markAssetBlobDeleted(blob.contentHash)
        ))) removed += 1;
      } catch (_) {
        // Corrupt or busy blobs remain pending for an explicit later audit; never
        // delete bytes that no longer match their content-addressed identity.
      }
    }
    return { inspected: pending.length, removed };
  }

  _authorize(session, context = {}) {
    if (!session) throw uploadError('asset_upload_session_missing', '上传会话不存在', 404);
    if (context.projectId != null && String(session.projectId) !== String(context.projectId)) throw uploadError('asset_upload_session_missing', '上传会话不存在', 404);
    if (context.memberId != null && String(session.memberId) !== String(context.memberId)) throw uploadError('asset_upload_session_missing', '上传会话不存在', 404);
    const scope = this._scopedSessionIdentity(context);
    if (scope && !String(session.id || '').startsWith(scope.fullPrefix)) {
      throw uploadError(
        'asset_upload_session_scope_mismatch',
        '上传会话不属于当前协作授权作用域，请重新选择文件',
        404,
      );
    }
    return session;
  }

  _requireCurrentUploadAuthorization(session, context = {}) {
    if (session?.sourceKind !== 'collaboration') return { projectId: session?.projectId };
    let scope;
    try {
      scope = collaborationUploadScope(context);
    } catch (_) {
      throw uploadError(
        'asset_upload_authorization_changed',
        '上传授权已经变化，请重新选择文件并开始上传',
        409,
        session,
      );
    }
    if (!scope
      || String(session?.projectId || '') !== scope.projectId
      || String(session?.memberId || '') !== scope.memberId
      || !String(session?.id || '').startsWith(scope.fullPrefix)) {
      throw uploadError(
        'asset_upload_authorization_changed',
        '上传授权已经变化，请重新选择文件并开始上传',
        409,
        session,
      );
    }
    let row = null;
    try {
      row = this.database.db.prepare(`
        SELECT s.id, s.project_id, s.canvas_id, s.member_id,
               m.updated_at AS authorization_epoch, m.capabilities_json
        FROM collaboration_sessions s
        JOIN collaboration_members m ON m.id = s.member_id
        JOIN canvas_documents d ON d.canvas_id = s.canvas_id AND d.project_id = s.project_id
        WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
          AND m.project_id = s.project_id AND m.canvas_id = s.canvas_id
      `).get(scope.sessionId, Date.now());
    } catch (error) {
      if (String(error?.code || '').startsWith('SQLITE_')) throw error;
      throw uploadError(
        'asset_upload_authorization_unavailable',
        '暂时无法复核上传授权，请稍后重试完成请求',
        503,
        session,
      );
    }
    let capabilities = [];
    try { capabilities = JSON.parse(row?.capabilities_json || '[]'); } catch (_) {}
    if (!row
      || String(row.id) !== scope.sessionId
      || String(row.project_id) !== scope.projectId
      || String(row.canvas_id) !== scope.canvasId
      || String(row.member_id) !== scope.memberId
      || String(row.authorization_epoch) !== scope.authorizationEpoch
      || !Array.isArray(capabilities)
      || !capabilities.includes('uploadAsset')) {
      throw uploadError(
        'asset_upload_authorization_changed',
        '上传授权已经变化，请重新选择文件并开始上传',
        409,
        session,
      );
    }
    return {
      projectId: row.project_id,
      canvasId: row.canvas_id,
      memberId: row.member_id,
      sessionId: row.id,
      authorizationEpoch: row.authorization_epoch,
      sourceKind: 'collaboration',
    };
  }

  _requireCurrentFinalizationAuthorization(session, asset, context = {}) {
    if (session?.sourceKind !== 'collaboration') return context;
    const active = this._activeFinalizationContext(session, asset);
    let requestedScope = null;
    let activeScope = null;
    try {
      requestedScope = collaborationUploadScope(context);
      activeScope = collaborationUploadScope(active || {});
    } catch (_) {}
    if (!active || !requestedScope || !activeScope
      || requestedScope.fullPrefix !== activeScope.fullPrefix) {
      throw uploadError(
        'asset_upload_authorization_changed',
        '上传授权已经变化，已停止发布素材预览',
        409,
        session,
      );
    }
    return active;
  }

  _runBeforeLiveFinalizationGrantHook(session, asset, context = {}) {
    if (session?.sourceKind !== 'collaboration'
      || TERMINAL_UPLOAD_FINALIZATION_STATES.has(String(asset?.metadata?.uploadFinalization || ''))
      || typeof this.beforeLiveFinalizationGrant !== 'function') return;
    // This synchronous hook exists only to freeze the otherwise unobservable
    // commit-to-finalization race in node:test. A production instance must not
    // execute an injected callback even if an internal caller mutates the field.
    if (!process.env.NODE_TEST_CONTEXT) return;
    const result = this.beforeLiveFinalizationGrant(Object.freeze({
      uploadSessionId: String(session.id || ''),
      assetId: String(asset?.id || ''),
      projectId: String(context.projectId || ''),
      canvasId: String(context.canvasId || ''),
      memberId: String(context.memberId || ''),
      authenticationSessionId: String(context.sessionId || ''),
      authorizationEpoch: String(context.authorizationEpoch || ''),
    }));
    if (result && typeof result.then === 'function') {
      throw uploadError(
        'asset_upload_finalization_hook_invalid',
        '上传最终化检查必须同步完成',
        500,
        session,
      );
    }
  }

  policy(context = {}) {
    this.sweepExpired();
    const projectId = String(context.projectId || 'local-project');
    const memberId = String(context.memberId || 'local-owner');
    const quota = this.database.getAssetUploadQuotaStatus(projectId, memberId, {
      projectLimit: this.config.COLLAB_PROJECT_QUOTA_BYTES,
      memberLimit: this.config.COLLAB_MEMBER_QUOTA_BYTES,
    });
    return {
      chunkSize: this.chunkSize,
      maxUploadBytes: this.maxUploadBytes,
      sessionTtlMs: this.sessionTtlMs,
      quota,
    };
  }

  createSession(input = {}, context = {}) {
    this.sweepExpired();
    const scope = this._scopedSessionIdentity(context);
    const filename = safeFilename(input.filename);
    const info = extensionInfo(filename);
    if (info.kind === 'other') throw uploadError('asset_upload_type_unsupported', '不支持的文件类型', 415);
    const expectedSize = Math.trunc(Number(input.size ?? input.expectedSize));
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > this.maxUploadBytes) {
      throw uploadError('asset_upload_size_invalid', `上传文件必须在 1-${this.maxUploadBytes} 字节之间`, 413);
    }
    const requestedChunkSize = Number(input.chunkSize);
    const chunkSize = Number.isSafeInteger(requestedChunkSize) && requestedChunkSize > 0
      ? Math.max(1024 * 1024, Math.min(this.chunkSize, requestedChunkSize))
      : this.chunkSize;
    const expectedHash = normalizeHash(input.contentHash || input.sha256, true);
    const session = this._withDatabaseWrite('asset.upload.session-create', () => (
      this.database.createAssetUploadSession({
        ...(scope ? { id: this._newScopedSessionId(scope) } : {}),
        projectId: context.projectId,
        memberId: context.memberId,
        sourceKind: context.sourceKind || 'collaboration',
        idempotencyKey: this._scopedIdempotencyKey(input.idempotencyKey, scope),
        filename,
        mimeType: info.mimeType,
        expectedSize,
        expectedHash,
        chunkSize,
        expiresAt: Date.now() + this.sessionTtlMs,
      }, {
        projectLimit: this.config.COLLAB_PROJECT_QUOTA_BYTES,
        memberLimit: this.config.COLLAB_MEMBER_QUOTA_BYTES,
      })
    ));
    return this._authorize(session, context);
  }

  getSession(sessionId, context = {}) {
    this.sweepExpired();
    return this._authorize(this.database.getAssetUploadSession(sessionId), context);
  }

  async writeChunk(sessionId, input = {}, context = {}) {
    this.sweepExpired();
    return this._withStorageCapacityBoundary('asset.upload.chunk', () => (
      this._withLock(this._sessionLockKey(sessionId), async () => {
      const session = this.getSession(sessionId, context);
      const operationNow = Date.now();
      if (session.expiresAt <= operationNow) {
        throw uploadError('asset_upload_session_expired', '上传会话已过期', 410, session);
      }
      if (session.status !== 'uploading') {
        throw uploadError('asset_upload_state_conflict', '上传会话当前不能接收分片', 409, session);
      }
      const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer || []);
      const index = Math.trunc(Number(input.index));
      const start = Math.trunc(Number(input.start));
      const end = Math.trunc(Number(input.end));
      const total = Math.trunc(Number(input.total));
      const expectedChunkHash = normalizeHash(input.contentHash);
      if (total !== session.expectedSize || buffer.length <= 0 || buffer.length > session.chunkSize
        || buffer.length !== end - start + 1 || sha256Buffer(buffer) !== expectedChunkHash) {
        throw uploadError('asset_upload_chunk_hash_mismatch', '分片范围、大小或 SHA-256 校验失败', 422, session);
      }
      const expectedStart = index * session.chunkSize;
      const expectedEnd = Math.min(session.expectedSize - 1, expectedStart + session.chunkSize - 1);
      if (!Number.isSafeInteger(index)
        || index < 0
        || index >= session.chunkCount
        || start !== expectedStart
        || end !== expectedEnd) {
        throw uploadError('asset_upload_range_invalid', '分片 Content-Range 与会话不一致', 416, session);
      }
      const target = this._chunkPath(session.id, index);
      const existing = session.receivedChunks.find((chunk) => chunk.index === index);
      if (existing) {
        if (Number(existing.start) !== start
          || Number(existing.end) !== end
          || Number(existing.size) !== buffer.length
          || String(existing.contentHash) !== expectedChunkHash) {
          throw uploadError('asset_upload_chunk_conflict', '该分片序号已绑定不同内容', 409, session);
        }
        if (!fs.existsSync(target)) {
          // A crash or external cleanup may leave the durable chunk record but
          // not its bytes. Only an exact replay may restore that file.
          await writeFileAtomic(target, buffer);
          return this.database.getAssetUploadSession(session.id);
        }
        const stat = fs.statSync(target);
        const diskHash = await hashFile(target);
        if (!stat.isFile() || diskHash !== existing.contentHash || Number(stat.size) !== Number(existing.size)) {
          throw uploadError('asset_upload_chunk_disk_corrupt', '已保存分片校验失败', 409, session);
        }
        return session;
      }
      await writeFileAtomic(target, buffer);
      return this._withDatabaseWrite('asset.upload.chunk-record', () => (
        this.database.recordAssetUploadChunk(session.id, {
          index, start, end, size: buffer.length, contentHash: expectedChunkHash, now: operationNow,
        })
      ), session);
      })
    ));
  }

  async pause(sessionId, context = {}) {
    this.sweepExpired();
    return this._withStorageCapacityBoundary('asset.upload.pause', () => this._withLock(this._sessionLockKey(sessionId), async () => {
      const session = this.getSession(sessionId, context);
      return this._withDatabaseWrite('asset.upload.pause', () => (
        this.database.transitionAssetUploadSession(session.id, 'pause')
      ), session);
    }));
  }

  async resume(sessionId, context = {}) {
    this.sweepExpired();
    return this._withStorageCapacityBoundary('asset.upload.resume', () => this._withLock(this._sessionLockKey(sessionId), async () => {
      const session = this.getSession(sessionId, context);
      return this._withDatabaseWrite('asset.upload.resume', () => (
        this.database.transitionAssetUploadSession(session.id, 'resume')
      ), session);
    }));
  }

  async cancel(sessionId, context = {}) {
    this.sweepExpired();
    return this._withStorageCapacityBoundary('asset.upload.cancel', () => this._withLock(this._sessionLockKey(sessionId), async () => {
      const session = this.getSession(sessionId, context);
      const result = this._withDatabaseWrite('asset.upload.cancel', () => {
        const cancelled = this.database.transitionAssetUploadSession(session.id, 'cancel');
        this.database.purgeAssetUploadChunks?.(session.id);
        return cancelled;
      }, session);
      this._cleanupSessionFiles(session.id);
      return result;
    }));
  }

  async _cancelUploadSessionIds(sessionIds = []) {
    const cancelledSessionIds = [];
    let cancelled = 0;
    // Authorization revocation must win before yielding to a completion that is
    // already awaiting disk/CAS work. The later lock pass only removes files.
    for (const sessionId of new Set(sessionIds.map(String).filter(Boolean))) {
      const current = this.database.getAssetUploadSession(sessionId);
      if (!current || !ACTIVE_UPLOAD_SESSION_STATUSES.has(current.status)) continue;
      try {
        const result = this._withDatabaseWrite('asset.upload.authorization-cancel', () => {
          const cancelledSession = this.database.transitionAssetUploadSession(sessionId, 'cancel');
          this.database.purgeAssetUploadChunks?.(sessionId);
          return cancelledSession;
        }, current);
        if (result?.status === 'cancelled') {
          cancelled += 1;
          cancelledSessionIds.push(sessionId);
        }
      } catch (error) {
        const latest = this.database.getAssetUploadSession(sessionId);
        if (latest && ACTIVE_UPLOAD_SESSION_STATUSES.has(latest.status)) throw error;
      }
    }
    for (const sessionId of cancelledSessionIds) {
      await this._withLock(this._sessionLockKey(sessionId), async () => {
        const latest = this.database.getAssetUploadSession(sessionId);
        if (latest?.status === 'completed') return;
        this._cleanupSessionFiles(sessionId);
      });
    }
    return cancelled;
  }

  _authenticationSessionUploadIds(rows = []) {
    const prefixes = new Set();
    for (const row of rows) {
      try {
        const scope = collaborationUploadScope({
          sourceKind: 'collaboration',
          projectId: row.project_id,
          canvasId: row.canvas_id,
          memberId: row.member_id,
          sessionId: row.id,
        }, { requireEpoch: false });
        prefixes.add(scope.sessionPrefix);
      } catch (_) {
        // Historical invalid auth rows cannot own a valid scoped upload ID.
      }
    }
    if (prefixes.size === 0) return [];
    const active = this.database.db.prepare(`
      SELECT id FROM asset_upload_sessions
      WHERE source_kind = 'collaboration'
        AND status IN ('uploading', 'paused', 'assembling')
    `).all();
    return active
      .map((row) => String(row.id || ''))
      .filter((id) => [...prefixes].some((prefix) => id.startsWith(prefix)));
  }

  async _cancelAuthenticationRows(rows = []) {
    return this._cancelUploadSessionIds(this._authenticationSessionUploadIds(rows));
  }

  async cancelAuthenticationSession(sessionId) {
    const row = this.database.db.prepare(`
      SELECT id, project_id, canvas_id, member_id
      FROM collaboration_sessions WHERE id = ?
    `).get(String(sessionId || ''));
    return this._cancelAuthenticationRows(row ? [row] : []);
  }

  async cancelMemberAuthenticationSessions(memberId) {
    const uploads = this.database.db.prepare(`
      SELECT id FROM asset_upload_sessions
      WHERE member_id = ? AND source_kind = 'collaboration'
        AND status IN ('uploading', 'paused', 'assembling')
    `).all(String(memberId || ''));
    return this._cancelUploadSessionIds(uploads.map((row) => row.id));
  }

  async cancelCanvasAuthenticationSessions(projectId, canvasId) {
    const rows = this.database.db.prepare(`
      SELECT id, project_id, canvas_id, member_id
      FROM collaboration_sessions WHERE project_id = ? AND canvas_id = ?
    `).all(String(projectId || ''), String(canvasId || ''));
    return this._cancelAuthenticationRows(rows);
  }

  async cancelProjectAuthenticationSessions(projectId) {
    const uploads = this.database.db.prepare(`
      SELECT id FROM asset_upload_sessions
      WHERE project_id = ? AND source_kind = 'collaboration'
        AND status IN ('uploading', 'paused', 'assembling')
    `).all(String(projectId || ''));
    return this._cancelUploadSessionIds(uploads.map((row) => row.id));
  }

  _grantCompletedAsset(session, asset, context = {}) {
    if (session.sourceKind !== 'collaboration' || typeof this.database.grantCanvasAssetResource !== 'function') return;
    const projectId = boundedScopePart(context.projectId);
    const canvasId = boundedScopePart(context.canvasId);
    if (String(session.projectId) !== projectId || String(asset?.projectId || '') !== projectId) {
      throw uploadError('asset_upload_scope_invalid', '上传素材与协作项目作用域不一致', 409, session);
    }
    try {
      this._withDatabaseWrite('asset.upload.resource-grant', () => (
        this.database.grantCanvasAssetResource(projectId, canvasId, asset.id)
      ), session);
    } catch (error) {
      if (isAssetUploadStorageCapacityError(error)) throw error;
      throw uploadError('asset_upload_resource_grant_failed', '上传已校验，但无法加入当前画布素材作用域，请重试完成请求', 409, session);
    }
  }

  _ensureAssetPreview(asset) {
    if (!PREVIEW_ASSET_KINDS.has(String(asset?.kind || '')) || asset?.metadata?.health === 'corrupt') {
      return { asset, settled: true, failed: false };
    }
    let existingJob = null;
    try {
      existingJob = this.database.listAssetPreviewJobs?.({
        assetId: asset.id,
        contentHash: asset.contentHash,
        limit: 100,
      })?.[0] || null;
    } catch (_) {}
    if (existingJob) {
      const statePatch = previewStatePatchForJob(existingJob);
      const current = this._withDatabaseWrite('asset.upload.preview-state', () => (
        this.database.patchAssetPreviewState(
          asset.id,
          asset.contentHash,
          statePatch,
        )
      )) || asset;
      return {
        asset: current,
        settled: true,
        failed: String(statePatch?.previewStatus || existingJob.status || '') === 'failed',
      };
    }
    if (!this.previewPipeline) return { asset, settled: false, failed: false };
    try {
      const job = this.previewPipeline.enqueueAsset(asset);
      if (!job) {
        const current = this._withDatabaseWrite('asset.upload.preview-state', () => (
          this.database.patchAssetPreviewState(asset.id, asset.contentHash, {
            previewStatus: 'failed',
            previewError: '素材不满足预览任务排队条件，可由主机在素材中心重试',
          })
        )) || asset;
        return { asset: current, settled: true, failed: true };
      }
      const statePatch = previewStatePatchForJob(job);
      const current = this._withDatabaseWrite('asset.upload.preview-state', () => (
        this.database.patchAssetPreviewState(
          asset.id,
          asset.contentHash,
          statePatch,
        )
      )) || asset;
      return {
        asset: current,
        settled: true,
        failed: String(statePatch?.previewStatus || job.status || '') === 'failed',
      };
    } catch (error) {
      const capacityError = translateAssetUploadStorageCapacityError(error, 'asset.upload.preview-enqueue');
      if (isAssetUploadStorageCapacityError(capacityError)) throw capacityError;
      const current = this._withDatabaseWrite('asset.upload.preview-state', () => (
        this.database.patchAssetPreviewState(asset.id, asset.contentHash, {
          previewStatus: 'failed',
          previewError: '预览任务排队失败，可由主机在素材中心重试',
        })
      )) || asset;
      return { asset: current, settled: true, failed: true };
    }
  }

  _settleAssetPreviewFinalization(session, asset) {
    if (!asset) throw uploadError('asset_upload_commit_missing', '已完成上传缺少素材记录', 409, session);
    if (TERMINAL_UPLOAD_FINALIZATION_STATES.has(String(asset.metadata?.uploadFinalization || ''))) return asset;
    const preview = this._ensureAssetPreview(asset);
    if (!preview.settled) return preview.asset;
    return this._withDatabaseWrite('asset.upload.preview-finalize', () => (
      this.database.patchAssetPreviewState(asset.id, asset.contentHash, {
        uploadFinalization: preview.failed ? 'failed' : 'completed',
      })
    ), session) || preview.asset;
  }

  _finalizeCompletedAsset(session, asset, context = {}) {
    if (!asset) throw uploadError('asset_upload_commit_missing', '已完成上传缺少素材记录', 409, session);
    if (TERMINAL_UPLOAD_FINALIZATION_STATES.has(String(asset.metadata?.uploadFinalization || ''))) return asset;
    return this._withDatabaseWrite('asset.upload.finalize', () => {
      const currentSession = this.database.getAssetUploadSession(session.id);
      const currentAsset = this.database.getAsset(asset.id);
      if (!currentSession || currentSession.status !== 'completed'
        || String(currentSession.assetId || '') !== String(asset.id || '')
        || !currentAsset
        || String(currentAsset.projectId || '') !== String(currentSession.projectId || '')
        || String(currentAsset.contentHash || '') !== String(currentSession.contentHash || '')) {
        throw uploadError('asset_upload_commit_missing', '已完成上传的素材身份不一致', 409, currentSession || session);
      }
      if (TERMINAL_UPLOAD_FINALIZATION_STATES.has(String(currentAsset.metadata?.uploadFinalization || ''))) {
        return currentAsset;
      }
      const currentContext = this._requireCurrentFinalizationAuthorization(
        currentSession,
        currentAsset,
        context,
      );
      this._grantCompletedAsset(currentSession, currentAsset, currentContext);
      return this._settleAssetPreviewFinalization(currentSession, currentAsset);
    }, session);
  }

  _verifiedCommittedPreviewContext(session, asset) {
    if (!session || !asset || session.sourceKind !== 'collaboration' || session.status !== 'completed') return null;
    const projectId = String(session.projectId || '');
    const memberId = String(session.memberId || '');
    const canvasId = String(asset.provenance?.canvasId || '');
    const contentHash = String(session.contentHash || '').toLowerCase();
    const authorizationSessionId = String(asset.metadata?.uploadAuthorization?.sessionId || '');
    const authorizationEpoch = String(asset.metadata?.uploadAuthorization?.authorizationEpoch || '');
    if (!projectId || !memberId || !canvasId || !SHA256_PATTERN.test(contentHash)
      || String(session.assetId || '') !== String(asset.id || '')
      || String(asset.projectId || '') !== projectId
      || String(asset.contentHash || '').toLowerCase() !== contentHash
      || (session.expectedHash && String(session.expectedHash).toLowerCase() !== contentHash)
      || asset.storageMode !== 'managed'
      || asset.metadata?.blobStorage !== 'cas'
      || asset.provenance?.source !== 'collaboration-upload'
      || String(asset.provenance?.memberId || '') !== memberId
      || String(asset.provenance?.uploadSessionId || '') !== String(session.id || '')
      || String(asset.createdBy || '') !== memberId
      || !authorizationSessionId
      || !authorizationEpoch) return null;
    try {
      const scope = collaborationUploadScope({
        sourceKind: 'collaboration',
        projectId,
        canvasId,
        memberId,
        sessionId: authorizationSessionId,
        authorizationEpoch,
      });
      if (!String(session.id || '').startsWith(scope.fullPrefix)) return null;
    } catch (_) { return null; }
    let evidence = null;
    try {
      evidence = this.database.db.prepare(`
        SELECT
          EXISTS(
            SELECT 1 FROM collaboration_sessions s
            WHERE s.id = ? AND s.project_id = ? AND s.canvas_id = ? AND s.member_id = ?
          ) AS auth_session_matches,
          EXISTS(
            SELECT 1 FROM canvas_documents d
            WHERE d.project_id = ? AND d.canvas_id = ?
          ) AS canvas_matches,
          EXISTS(
            SELECT 1 FROM canvas_resource_grants g
            WHERE g.project_id = ? AND g.canvas_id = ?
              AND g.resource_type = 'asset' AND g.resource_id = ? AND g.resource_version = 0
          ) AS grant_exists,
          EXISTS(
            SELECT 1 FROM asset_blob_refs r
            JOIN asset_blobs b ON b.id = r.blob_id
            WHERE r.project_id = ? AND r.asset_id = ?
              AND r.verification_state = 'verified'
              AND b.content_hash = ? AND b.verification_state = 'verified'
              AND b.storage_state = 'ready' AND b.byte_size = ?
          ) AS verified_cas_exists,
          EXISTS(
            SELECT 1 FROM asset_lineage_events l
            WHERE l.project_id = ? AND l.asset_id = ? AND l.canvas_id = ?
              AND l.source_type = 'collaboration-upload' AND l.creator_id = ?
          ) AS lineage_matches
      `).get(
        authorizationSessionId, projectId, canvasId, memberId,
        projectId, canvasId,
        projectId, canvasId, asset.id,
        projectId, asset.id, contentHash, session.expectedSize,
        projectId, asset.id, canvasId, memberId,
      );
    } catch (_) { return null; }
    if (!evidence?.auth_session_matches || !evidence?.canvas_matches || !evidence?.grant_exists
      || !evidence?.verified_cas_exists || !evidence?.lineage_matches) return null;
    return { projectId, canvasId, memberId, contentHash };
  }

  _reconcilePendingUploadFinalizations() {
    if (!this.database.db?.prepare || typeof this.database.getAsset !== 'function') return;
    let rows = [];
    try {
      rows = this.database.db.prepare(`
        SELECT s.id, s.project_id, s.asset_id
        FROM asset_upload_sessions s
        JOIN assets a ON a.id = s.asset_id AND a.project_id = s.project_id
        WHERE s.status = 'completed'
          AND json_extract(a.metadata_json, '$.uploadFinalization') = 'pending'
        ORDER BY s.completed_at ASC, s.id ASC
      `).all();
    } catch (_) { return; }
    for (const row of rows) {
      const session = this.database.getAssetUploadSession(row.id);
      const asset = row.asset_id ? this.database.getAsset(row.asset_id) : null;
      if (!session || !asset) continue;
      const context = this._activeFinalizationContext(session, asset);
      if (context) {
        try {
          this._finalizeCompletedAsset(session, asset, context);
          continue;
        } catch (_) {
          // A verified, already-granted commit may still be reconciled below
          // without expanding the stale authorization scope.
        }
      }
      if (!this._verifiedCommittedPreviewContext(session, asset)) continue;
      try { this._settleAssetPreviewFinalization(session, asset); } catch (_) {}
      // Invalid evidence or a missing preview service keeps the durable pending
      // marker for an exact later retry; no grant is created on this path.
    }
  }

  _activeFinalizationContext(session, asset) {
    if (session.sourceKind !== 'collaboration') return { projectId: session.projectId };
    const authorization = asset?.metadata?.uploadAuthorization;
    const authorizationSessionId = String(authorization?.sessionId || '');
    const authorizationEpoch = String(authorization?.authorizationEpoch || '');
    const canvasId = String(asset?.provenance?.canvasId || '');
    if (!authorizationSessionId || !authorizationEpoch || !canvasId) return null;
    let row;
    try {
      row = this.database.db.prepare(`
        SELECT s.id, s.project_id, s.canvas_id, s.member_id, s.expires_at,
               m.updated_at AS authorization_epoch, m.capabilities_json
        FROM collaboration_sessions s
        JOIN collaboration_members m ON m.id = s.member_id
        JOIN canvas_documents d ON d.canvas_id = s.canvas_id AND d.project_id = s.project_id
        WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
          AND m.project_id = s.project_id AND m.canvas_id = s.canvas_id
      `).get(authorizationSessionId, Date.now());
    } catch (_) { return null; }
    let capabilities = [];
    try { capabilities = JSON.parse(row?.capabilities_json || '[]'); } catch (_) {}
    if (!row
      || String(row.project_id) !== String(session.projectId)
      || String(row.project_id) !== String(asset.projectId)
      || String(row.canvas_id) !== canvasId
      || String(row.member_id) !== String(session.memberId)
      || String(row.authorization_epoch) !== authorizationEpoch
      || !Array.isArray(capabilities)
      || !capabilities.includes('uploadAsset')) return null;
    const context = {
      projectId: row.project_id,
      canvasId: row.canvas_id,
      memberId: row.member_id,
      sessionId: row.id,
      authorizationEpoch: row.authorization_epoch,
      sourceKind: 'collaboration',
    };
    try {
      const scope = collaborationUploadScope(context);
      if (!String(session.id || '').startsWith(scope.fullPrefix)) return null;
    } catch (_) { return null; }
    return context;
  }

  _reconcileSessionStorage(recoveredSessionIds = []) {
    let rows;
    try {
      rows = this.database.db.prepare('SELECT id, status FROM asset_upload_sessions').all();
    } catch (_) {
      this._removeAssemblyFiles(recoveredSessionIds);
      return;
    }
    const activeIds = new Set();
    const knownIds = new Set();
    const statusById = new Map();
    const terminalIds = [];
    for (const row of rows) {
      const id = String(row.id || '');
      if (!UPLOAD_SESSION_ID_PATTERN.test(id)) continue;
      knownIds.add(id);
      statusById.set(id, row.status);
      if (ACTIVE_UPLOAD_SESSION_STATUSES.has(row.status)) activeIds.add(id);
      if (TERMINAL_UPLOAD_SESSION_STATUSES.has(row.status)) terminalIds.push(id);
    }
    this._removeAssemblyFiles(new Set([...recoveredSessionIds, ...activeIds]));
    for (const sessionId of terminalIds) {
      this._cleanupSessionFiles(sessionId);
      try {
        this._withDatabaseWrite('asset.upload.chunk-purge', () => (
          this.database.purgeAssetUploadChunks?.(sessionId)
        ));
      } catch (_) {}
    }
    let entries = [];
    try { entries = fs.readdirSync(this.tempRoot, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (!UPLOAD_SESSION_ID_PATTERN.test(entry.name)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (activeIds.has(entry.name)) continue;
      if (knownIds.has(entry.name) && !TERMINAL_UPLOAD_SESSION_STATUSES.has(statusById.get(entry.name))) continue;
      this._cleanupSessionFiles(entry.name);
    }
  }

  async _assemble(session) {
    const chunks = this.database.listAssetUploadChunks(session.id);
    if (chunks.length !== session.chunkCount) throw uploadError('asset_upload_incomplete', '上传分片尚未完整', 409, session);
    const directory = this._sessionDirectory(session.id);
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, `assembly-${crypto.randomBytes(8).toString('hex')}.part`);
    const finalHash = crypto.createHash('sha256');
    let handle;
    let total = 0;
    try {
      handle = await fs.promises.open(target, 'wx');
      for (let index = 0; index < chunks.length; index += 1) {
        const record = chunks[index];
        if (record.index !== index) throw uploadError('asset_upload_chunk_sequence_invalid', '上传分片序列不连续', 409, session);
        const filename = this._chunkPath(session.id, record.index);
        let stat;
        let diskHash;
        try {
          stat = fs.statSync(filename);
          diskHash = await hashFile(filename);
        } catch (error) {
          if (error?.code === 'ENOENT') {
            throw uploadError(
              'asset_upload_chunk_disk_missing',
              `已登记的上传分片 ${record.index} 在主机暂存区缺失，请重新开始本次上传`,
              409,
              session,
            );
          }
          throw uploadError(
            'asset_upload_chunk_disk_unreadable',
            `已登记的上传分片 ${record.index} 无法读取，请稍后重试或重新开始上传`,
            409,
            session,
          );
        }
        if (!stat.isFile() || stat.size !== record.size || diskHash !== record.contentHash) {
          throw uploadError('asset_upload_chunk_disk_corrupt', `分片 ${record.index} 校验失败`, 422, session);
        }
        for await (const block of fs.createReadStream(filename)) {
          finalHash.update(block);
          let offset = 0;
          while (offset < block.length) {
            const result = await handle.write(block, offset, block.length - offset, null);
            if (!result.bytesWritten) throw new Error('文件组装未取得进展');
            offset += result.bytesWritten;
          }
          total += block.length;
        }
      }
      await handle.sync();
      await handle.close();
      handle = null;
      if (total !== session.expectedSize) throw uploadError('asset_upload_assembled_size_mismatch', '组装后文件大小不一致', 422, session);
      return { filename: target, contentHash: finalHash.digest('hex'), byteSize: total };
    } catch (error) {
      try { await handle?.close(); } catch (_) {}
      try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch (_) {}
      throw error;
    }
  }

  async complete(sessionId, input = {}, context = {}) {
    this.sweepExpired();
    return this._withStorageCapacityBoundary('asset.upload.complete', () => this._withLock(this._sessionLockKey(sessionId), async () => {
      let claimed = false;
      let installed = null;
      let durableCompletedSession = null;
      let durableCompletedAsset = null;
      let idempotentReplay = false;
      let postCommitPhase = 'finalization';
      try {
        const authorized = this.getSession(sessionId, context);
        const submittedHash = normalizeHash(input.contentHash || input.sha256, true);
        if (authorized.status === 'completed') {
          if (submittedHash && submittedHash !== authorized.contentHash) {
            throw uploadError('asset_upload_completion_conflict', '该上传会话已用不同文件 SHA-256 完成', 409, authorized);
          }
          let asset = authorized.assetId ? this.database.getAsset(authorized.assetId) : null;
          if (!asset) throw uploadError('asset_upload_commit_missing', '已完成上传缺少素材记录', 409, authorized);
          durableCompletedSession = authorized;
          durableCompletedAsset = asset;
          idempotentReplay = true;
          this._runBeforeLiveFinalizationGrantHook(authorized, asset, context);
          asset = this._finalizeCompletedAsset(authorized, asset, context);
          durableCompletedAsset = asset;
          postCommitPhase = 'chunk-purge';
          this._withDatabaseWrite('asset.upload.chunk-purge', () => (
            this.database.purgeAssetUploadChunks?.(authorized.id)
          ), authorized);
          this._cleanupSessionFiles(authorized.id);
          postCommitPhase = 'quota-refresh';
          return {
            session: authorized,
            asset,
            deduplicated: authorized.deduplicated,
            blobId: authorized.contentHash ? `blob_${authorized.contentHash}` : null,
            quota: this.policy(context).quota,
            idempotentReplay: true,
          };
        }
        const session = authorized.status === 'assembling'
          ? authorized
          : this._withDatabaseWrite('asset.upload.completion-claim', () => (
            this.database.claimAssetUploadCompletion(authorized.id)
          ), authorized);
        claimed = true;
        const assembled = await this._assemble(session);
        if ((session.expectedHash && session.expectedHash !== assembled.contentHash)
          || (submittedHash && submittedHash !== assembled.contentHash)) {
          throw uploadError('asset_upload_file_hash_mismatch', '完整文件 SHA-256 与声明不一致', 422, session);
        }
        const info = extensionInfo(session.filename);
        const verified = await validateUploadedAsset(assembled.filename, info);
        let mediaMetadata;
        try {
          mediaMetadata = await readMetadata(assembled.filename, info.kind, fs.statSync(assembled.filename), {
            sourceExtension: path.extname(session.filename),
          });
        } catch (metadataError) {
          mediaMetadata = {
            size: assembled.byteSize,
            health: 'corrupt',
            metadataError: safeError(metadataError, '素材元数据读取失败'),
          };
        }
        const supportsPreview = ['image', 'video', 'audio', 'model3d'].includes(info.kind);
        const previewRequired = supportsPreview && mediaMetadata.health !== 'corrupt';
        const previewMetadata = supportsPreview && mediaMetadata.health === 'corrupt'
          ? { previewStatus: 'failed', previewError: '素材损坏，未加入预览队列' }
          : (previewRequired ? { previewStatus: 'pending' } : {});
        const assetId = stableAssetId(`${session.projectId}:cas-upload`, session.id);
        let asset = null;
        let completed = null;
        installed = await this.blobStore.installVerifiedFile(assembled.filename, {
          expectedHash: assembled.contentHash,
          expectedSize: session.expectedSize,
          mimeType: info.mimeType,
          removeSource: true,
          onInstalled: async (lockedInstalled) => {
            const committed = this._withDatabaseWrite('asset.upload.commit', () => {
              // The live collaboration identity is re-read after this process
              // owns the write lock. The lineage grant below therefore commits
              // either before a later revocation or not at all.
              const commitSession = this.database.getAssetUploadSession(session.id);
              if (commitSession?.status === 'assembling') {
                this._requireCurrentUploadAuthorization(commitSession, context);
              }
              return this.database.commitAssetUpload({
                sessionId: session.id,
                blob: {
                  contentHash: lockedInstalled.contentHash,
                  storageKey: lockedInstalled.storageKey,
                  byteSize: lockedInstalled.byteSize,
                  mimeType: info.mimeType,
                },
                asset: {
                  id: assetId,
                  projectId: session.projectId,
                  contentHash: lockedInstalled.contentHash,
                  contentHashVerification: 'verified',
                  kind: info.kind,
                  mimeType: info.mimeType,
                  filename: session.filename,
                  managedPath: lockedInstalled.path,
                  sourceUrl: `/api/project-assets/${encodeURIComponent(assetId)}/media`,
                  storageMode: 'managed',
                  availability: mediaMetadata.health === 'corrupt' ? 'corrupt' : 'available',
                  metadata: {
                    ...mediaMetadata,
                    size: lockedInstalled.byteSize,
                    root: 'cas',
                    verified,
                    blobStorage: 'cas',
                    uploadFinalization: 'pending',
                    ...(session.sourceKind === 'collaboration' ? {
                      uploadAuthorization: {
                        sessionId: String(context.sessionId || ''),
                        authorizationEpoch: String(context.authorizationEpoch || ''),
                      },
                    } : {}),
                    ...previewMetadata,
                  },
                  provenance: {
                    source: session.sourceKind === 'collaboration' ? 'collaboration-upload' : 'project-upload',
                    memberId: session.memberId,
                    canvasId: context.canvasId || null,
                    uploadSessionId: session.id,
                  },
                  createdBy: session.memberId,
                },
                lineage: {
                  sourceType: session.sourceKind === 'collaboration' ? 'collaboration-upload' : 'project-upload',
                  canvasId: context.canvasId || null,
                  creatorId: session.memberId,
                  metadata: {
                    memberId: session.memberId,
                    canvasId: context.canvasId || null,
                    storageMode: 'managed',
                    blobStorage: 'cas',
                  },
                },
                deduplicated: lockedInstalled.reused,
              });
            }, session);
            asset = committed.asset;
            completed = committed.session;
            durableCompletedAsset = asset;
            durableCompletedSession = completed;
          },
        });
        if (!asset || !completed) throw uploadError('asset_upload_commit_missing', '上传原子提交未返回素材或会话', 500, session);
        // The atomic asset/session/lineage commit leaves a validated durable
        // grant claim. Live grant refresh and preview publication still re-read
        // the current authorization before they settle idempotently.
        this._runBeforeLiveFinalizationGrantHook(completed, asset, context);
        asset = this._finalizeCompletedAsset(completed, asset, context);
        durableCompletedAsset = asset;
        postCommitPhase = 'chunk-purge';
        this._withDatabaseWrite('asset.upload.chunk-purge', () => (
          this.database.purgeAssetUploadChunks?.(session.id)
        ), completed);
        this._cleanupSessionFiles(session.id);
        postCommitPhase = 'quota-refresh';
        return {
          session: completed,
          asset,
          deduplicated: Boolean(installed.reused),
          blobId: `blob_${installed.contentHash}`,
          quota: this.policy(context).quota,
          idempotentReplay: false,
        };
      } catch (error) {
        const capacityError = translateAssetUploadStorageCapacityError(error, 'asset.upload.complete');
        if (durableCompletedSession && durableCompletedAsset && isAssetUploadStorageCapacityError(capacityError)) {
          let committedSession = durableCompletedSession;
          let committedAsset = durableCompletedAsset;
          let quota = null;
          try { committedSession = this.database.getAssetUploadSession(sessionId) || committedSession; } catch (_) {}
          try { committedAsset = this.database.getAsset(committedAsset.id) || committedAsset; } catch (_) {}
          try {
            quota = this.database.getAssetUploadQuotaStatus(
              committedSession.projectId,
              committedSession.memberId,
              {
                projectLimit: this.config.COLLAB_PROJECT_QUOTA_BYTES,
                memberLimit: this.config.COLLAB_MEMBER_QUOTA_BYTES,
              },
            );
          } catch (_) {}
          return {
            session: committedSession,
            asset: committedAsset,
            deduplicated: Boolean(committedSession.deduplicated ?? installed?.reused),
            blobId: committedSession.contentHash ? `blob_${committedSession.contentHash}` : null,
            quota,
            idempotentReplay,
            persistenceWarning: Object.freeze({
              code: 'asset_upload_post_commit_capacity',
              committed: true,
              phase: postCommitPhase,
              reason: capacityError.reason,
              retryable: capacityError.retryable === true,
            }),
          };
        }
        if (claimed && !isAssetUploadStorageCapacityError(capacityError)) {
          this._withDatabaseWrite('asset.upload.fail', () => {
            this.database.failAssetUploadSession(sessionId, {
              code: safeUploadErrorCode(error),
              message: safeUploadErrorMessage(error),
            });
            this.database.purgeAssetUploadChunks?.(sessionId);
          });
          this._cleanupSessionFiles(sessionId);
          if (installed?.contentHash && this.database.assetBlobReferenceCount(installed.contentHash) === 0) {
            try {
              this._withDatabaseWrite('asset.upload.orphan-blob-mark', () => (
                this.database._cleanupOrphanAssetBlob?.(`blob_${installed.contentHash}`)
              ));
            } catch (_) {
              // The failed session is already durable. Orphan reconciliation is
              // post-commit maintenance and must not replace the original result.
            }
          }
        }
        throw capacityError;
      }
    }));
  }

  async ingestFile(filename, input = {}, context = {}) {
    const absolute = path.resolve(filename);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw uploadError('asset_upload_file_missing', '待上传文件不存在', 400);
    const session = this.createSession({
      filename: input.filename || path.basename(absolute),
      size: stat.size,
      contentHash: input.contentHash || input.sha256,
      idempotencyKey: input.idempotencyKey || `legacy-${crypto.randomUUID()}`,
    }, context);
    const handle = await fs.promises.open(absolute, 'r');
    try {
      for (let index = 0; index < session.chunkCount; index += 1) {
        const start = index * session.chunkSize;
        const size = Math.min(session.chunkSize, session.expectedSize - start);
        const buffer = Buffer.allocUnsafe(size);
        let offset = 0;
        while (offset < size) {
          const result = await handle.read(buffer, offset, size - offset, start + offset);
          if (!result.bytesRead) throw uploadError('asset_upload_source_truncated', '待上传文件读取中途结束', 422, session);
          offset += result.bytesRead;
        }
        await this.writeChunk(session.id, {
          index,
          start,
          end: start + size - 1,
          total: session.expectedSize,
          contentHash: sha256Buffer(buffer),
          buffer,
        }, context);
      }
      return await this.complete(session.id, { contentHash: input.contentHash || input.sha256 }, context);
    } finally {
      await handle.close();
      if (input.removeSource !== false) {
        try { if (fs.existsSync(absolute)) fs.unlinkSync(absolute); } catch (_) {}
      }
    }
  }
}

module.exports = {
  AssetUploadManager,
  collaborationUploadScope,
  containsHostAbsolutePath,
  normalizeHash,
  safeFilename,
  safeUploadErrorCode,
  safeUploadErrorMessage,
  sha256Buffer,
  uploadError,
};
