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
const { validateUploadedAsset } = require('../collaboration/gatewaySecurity');

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_UPLOAD_ERROR_CODE_PATTERN = /^(?:asset_upload_[a-z0-9_]+|CAS_[A-Z0-9_]+)$/;

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
      ? database.recoverInterruptedAssetUploadSessions()
      : [];
    this._removeAssemblyFiles(recovered);
    this.sweepExpired();
    void this.gcPendingBlobs().catch(() => {});
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

  _sessionDirectory(sessionId) {
    const normalized = String(sessionId || '');
    if (!/^asset-upload-[a-f0-9-]{20,80}$/i.test(normalized)) throw uploadError('asset_upload_session_invalid', '上传会话 ID 无效', 400);
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
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
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
    const expired = this.database.expireAssetUploadSessions(now);
    for (const id of expired) {
      this._cleanupSessionFiles(id);
      this.database.purgeAssetUploadChunks?.(id);
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
        if (this.database.markAssetBlobDeleted(blob.contentHash)) removed += 1;
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
    return session;
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
    return this.database.createAssetUploadSession({
      projectId: context.projectId,
      memberId: context.memberId,
      sourceKind: context.sourceKind || 'collaboration',
      idempotencyKey: input.idempotencyKey,
      filename,
      mimeType: info.mimeType,
      expectedSize,
      expectedHash,
      chunkSize,
      expiresAt: Date.now() + this.sessionTtlMs,
    }, {
      projectLimit: this.config.COLLAB_PROJECT_QUOTA_BYTES,
      memberLimit: this.config.COLLAB_MEMBER_QUOTA_BYTES,
    });
  }

  getSession(sessionId, context = {}) {
    this.sweepExpired();
    return this._authorize(this.database.getAssetUploadSession(sessionId), context);
  }

  async writeChunk(sessionId, input = {}, context = {}) {
    return this._withLock(`${sessionId}:chunk:${input.index}`, async () => {
      const session = this.getSession(sessionId, context);
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
      const target = this._chunkPath(session.id, index);
      const existing = session.receivedChunks.find((chunk) => chunk.index === index);
      if (existing && fs.existsSync(target)) {
        const diskHash = await hashFile(target);
        if (diskHash !== expectedChunkHash || Number(fs.statSync(target).size) !== buffer.length) {
          throw uploadError('asset_upload_chunk_disk_corrupt', '已保存分片校验失败', 409, session);
        }
        return session;
      }
      await writeFileAtomic(target, buffer);
      return this.database.recordAssetUploadChunk(session.id, {
        index, start, end, size: buffer.length, contentHash: expectedChunkHash,
      });
    });
  }

  pause(sessionId, context = {}) {
    const session = this.getSession(sessionId, context);
    return this.database.transitionAssetUploadSession(session.id, 'pause');
  }

  resume(sessionId, context = {}) {
    const session = this.getSession(sessionId, context);
    return this.database.transitionAssetUploadSession(session.id, 'resume');
  }

  cancel(sessionId, context = {}) {
    const session = this.getSession(sessionId, context);
    const result = this.database.transitionAssetUploadSession(session.id, 'cancel');
    this._cleanupSessionFiles(session.id);
    this.database.purgeAssetUploadChunks?.(session.id);
    return result;
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
    return this._withLock(`${sessionId}:complete`, async () => {
      let claimed = false;
      let installed = null;
      try {
        const authorized = this.getSession(sessionId, context);
        if (authorized.status === 'completed') {
          return {
            session: authorized,
            asset: authorized.assetId ? this.database.getAsset(authorized.assetId) : null,
            deduplicated: authorized.deduplicated,
            blobId: authorized.contentHash ? `blob_${authorized.contentHash}` : null,
            quota: this.policy(context).quota,
          };
        }
        const session = this.database.claimAssetUploadCompletion(authorized.id);
        claimed = true;
        const submittedHash = normalizeHash(input.contentHash || input.sha256, true);
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
        const previewEligible = Boolean(this.previewPipeline && supportsPreview && mediaMetadata.health !== 'corrupt');
        const previewMetadata = supportsPreview && mediaMetadata.health === 'corrupt'
          ? { previewStatus: 'failed', previewError: '素材损坏，未加入预览队列' }
          : (previewEligible ? { previewStatus: 'queued' } : {});
        const assetId = stableAssetId(`${session.projectId}:cas-upload`, session.id);
        let asset = null;
        let completed = null;
        installed = await this.blobStore.installVerifiedFile(assembled.filename, {
          expectedHash: assembled.contentHash,
          expectedSize: session.expectedSize,
          mimeType: info.mimeType,
          removeSource: true,
          onInstalled: async (lockedInstalled) => {
            const committed = this.database.commitAssetUpload({
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
            asset = committed.asset;
            completed = committed.session;
          },
        });
        if (!asset || !completed) throw uploadError('asset_upload_commit_missing', '上传原子提交未返回素材或会话', 500, session);
        if (previewEligible) {
          try {
            const job = this.previewPipeline.enqueueAsset(asset);
            asset = this.database.patchAssetPreviewState(asset.id, asset.contentHash, previewStatePatchForJob(job)) || asset;
          } catch (_) {
            asset = this.database.patchAssetPreviewState(asset.id, asset.contentHash, {
              previewStatus: 'failed',
              previewError: '预览任务排队失败，可由主机在素材中心重试',
            }) || asset;
          }
        }
        this._cleanupSessionFiles(session.id);
        this.database.purgeAssetUploadChunks?.(session.id);
        return {
          session: completed,
          asset,
          deduplicated: Boolean(installed.reused),
          blobId: `blob_${installed.contentHash}`,
          quota: this.policy(context).quota,
        };
      } catch (error) {
        if (claimed) {
          this.database.failAssetUploadSession(sessionId, {
            code: safeUploadErrorCode(error),
            message: safeUploadErrorMessage(error),
          });
          this._cleanupSessionFiles(sessionId);
          this.database.purgeAssetUploadChunks?.(sessionId);
          if (installed?.contentHash && this.database.assetBlobReferenceCount(installed.contentHash) === 0) {
            this.database._cleanupOrphanAssetBlob?.(`blob_${installed.contentHash}`);
          }
        }
        throw error;
      }
    });
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
  containsHostAbsolutePath,
  normalizeHash,
  safeFilename,
  safeUploadErrorCode,
  safeUploadErrorMessage,
  sha256Buffer,
  uploadError,
};
