const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createDerivedMedia, hashFile } = require('./assetIndexer');
const { observeAssetAvailabilitySnapshot } = require('./assetAvailability');
const {
  mapProjectDatabaseStorageCapacityPublicError,
} = require('./projectDatabasePublicError');

const JOB_KIND_BY_ASSET_KIND = Object.freeze({
  image: 'image-preview',
  video: 'video-preview',
  audio: 'audio-preview',
  model3d: 'model3d-preview',
});

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

const PREVIEW_STATUS_COUNT_KEYS = Object.freeze([
  'queued',
  'running',
  'retrying',
  'succeeded',
  'failed',
]);

function emptyPreviewStatusCounts() {
  return Object.fromEntries(PREVIEW_STATUS_COUNT_KEYS.map((key) => [key, 0]));
}

function sanitizePersistedPreviewStatus(value) {
  const sourceCounts = value?.counts && typeof value.counts === 'object' ? value.counts : {};
  const counts = Object.fromEntries(PREVIEW_STATUS_COUNT_KEYS.map((key) => {
    const numeric = Math.trunc(Number(sourceCounts[key]));
    return [key, Number.isFinite(numeric) && numeric > 0 ? numeric : 0];
  }));
  const nextAttemptAt = Number(value?.nextAttemptAt);
  return {
    counts,
    ...(Number.isFinite(nextAttemptAt) && nextAttemptAt > 0 ? { nextAttemptAt } : {}),
  };
}

function safeStoragePressure(error, operation) {
  const mapped = mapProjectDatabaseStorageCapacityPublicError(error, { operation });
  if (!mapped) return null;
  return Object.freeze({
    active: true,
    reason: mapped.body.reason,
    retryable: mapped.body.retryable === true,
  });
}

function isDatabaseBusyError(error) {
  return /^SQLITE_BUSY(?:_|$)/.test(String(error?.code || '').toUpperCase());
}

function isRecoverableDatabasePressure(error, operation) {
  return Boolean(safeStoragePressure(error, operation) || isDatabaseBusyError(error));
}

function sanitizePreviewError(error) {
  const codeCandidate = String(error?.code || 'preview-generation-failed').trim().slice(0, 120);
  const rawCode = (/^(?:sk-|bearer\b)/i.test(codeCandidate) ? '' : codeCandidate)
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'preview-generation-failed';
  const rawMessage = String(error?.message || error || '预览生成失败');
  const message = rawMessage
    .replace(/\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})\b/gi, '[redacted]')
    .replace(/[A-Za-z]:\\[^\r\n"'`]+/g, '[local-path]')
    .replace(/\\\\[^\r\n"'`]+/g, '[local-path]')
    .replace(/(^|\s)\/(?:Users|home|tmp|var|private|mnt)\/[^\r\n"'`]+/gi, '$1[local-path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600) || '预览生成失败';
  return { code: rawCode, message };
}

function isRetryablePreviewError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  if (/source-content-changed|source-missing|asset-unavailable|enoent|unsupported|invalid|corrupt|too[_-]?complex|external[_-]?resource/.test(`${code} ${message}`)) return false;
  return true;
}

const PREVIEW_TEMP_FILE_RE = /(?:\.part-\d+-[a-f0-9]{10}|\.tmp-\d+-[0-9a-f-]{20,}|\.snapshot-\d+-[0-9a-f-]{20,})\.[a-z0-9]+$/i;

function cleanupOrphanedPreviewTemps(roots, options = {}) {
  const now = Number(options.now) || Date.now();
  const maxAgeMs = clampInteger(options.maxAgeMs, 60_000, 7 * 24 * 60 * 60 * 1000, 6 * 60 * 60 * 1000);
  const maximumFiles = clampInteger(options.maximumFiles, 1, 100_000, 10_000);
  const queue = [...new Set((Array.isArray(roots) ? roots : [roots]).filter(Boolean).map((item) => path.resolve(String(item))))];
  let inspected = 0;
  let removed = 0;
  while (queue.length && inspected < maximumFiles) {
    const directory = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (inspected >= maximumFiles) break;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(filename);
        continue;
      }
      inspected += 1;
      if (!entry.isFile() || !PREVIEW_TEMP_FILE_RE.test(entry.name)) continue;
      try {
        const stat = fs.statSync(filename);
        if (stat.mtimeMs > now - maxAgeMs) continue;
        fs.rmSync(filename, { force: true });
        removed += 1;
      } catch (_) {}
    }
  }
  return { inspected, removed };
}

function sameSourceStat(left, right) {
  return Boolean(left && right
    && (Number(left.dev) || 0) === (Number(right.dev) || 0)
    && (Number(left.ino) || 0) === (Number(right.ino) || 0)
    && (Number(left.mode) || 0) === (Number(right.mode) || 0)
    && (Number(left.size) || 0) === (Number(right.size) || 0)
    && (Number(left.mtimeMs) || 0) === (Number(right.mtimeMs) || 0)
    && (Number(left.ctimeMs) || 0) === (Number(right.ctimeMs) || 0));
}

function sourceChangedError(message = '素材源文件在生成预览期间发生变化') {
  const error = new Error(message);
  error.code = 'source-content-changed';
  return error;
}

function previewAttemptKey(job) {
  return [job?.id, job?.createdAt, job?.attemptCount, job?.startedAt].map((value) => String(value ?? '')).join(':');
}

function previewDatabaseMutationInput(job, options = {}) {
  return {
    ...options,
    expectedAttempt: job,
    expectedAssetSnapshot: job?.availabilitySnapshot,
  };
}

function shouldPersistVerifiedAvailability(snapshot) {
  const metadata = snapshot?.metadata && typeof snapshot.metadata === 'object' ? snapshot.metadata : {};
  return ['missing', 'unverified'].includes(String(snapshot?.availability || '').toLowerCase())
    || ['missing', 'source-changed'].includes(String(metadata.health || '').toLowerCase())
    || metadata.availabilityNeedsReindex === true
    || Object.hasOwn(metadata, 'missingSince')
    || Object.hasOwn(metadata, 'sourceChangedSince')
    || Object.hasOwn(metadata, 'observedContentHash');
}

function isAvailabilityObservationConflict(error) {
  return ['asset_catalog_revision_conflict', 'asset_availability_identity_conflict']
    .includes(String(error?.code || ''));
}

function assetPreviewEligibilityError(asset) {
  if (String(asset?.metadata?.health || '').toLowerCase() === 'corrupt') {
    const error = new Error('素材已损坏，无法生成预览');
    error.code = 'asset-corrupt';
    return error;
  }
  if (!asset || String(asset.availability || '') !== 'available') {
    const error = new Error('素材当前不可用，无法生成预览');
    error.code = 'asset-unavailable';
    return error;
  }
  return null;
}

function safeSnapshotExtension(filename) {
  const extension = path.extname(String(filename || '')).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '.bin';
}

async function createVerifiedSourceSnapshot(input = {}) {
  const sourcePath = path.resolve(String(input.sourcePath || ''));
  const expectedHash = String(input.expectedHash || '');
  const expectedStat = input.expectedStat;
  const rawSnapshotRoot = String(input.snapshotRoot || '').trim();
  const calculateHash = input.hashFile;
  if (!expectedHash || typeof calculateHash !== 'function') throw new TypeError('预览快照缺少内容哈希校验器');
  if (!rawSnapshotRoot) throw new Error('预览快照目录不可用');
  const snapshotRoot = path.resolve(rawSnapshotRoot);
  fs.mkdirSync(snapshotRoot, { recursive: true });
  const targetPath = path.join(
    snapshotRoot,
    `.asset-preview.snapshot-${process.pid}-${crypto.randomUUID()}${safeSnapshotExtension(input.sourceFilename || sourcePath)}`,
  );
  let completed = false;
  try {
    const beforeCopy = fs.statSync(sourcePath);
    if (expectedStat && !sameSourceStat(expectedStat, beforeCopy)) throw sourceChangedError('素材源文件在建立快照前发生变化');
    // COPYFILE_FICLONE is advisory: use CoW where supported and an independent
    // copy elsewhere. Never hard-link a mutable source into the cache pipeline.
    await fs.promises.copyFile(
      sourcePath,
      targetPath,
      fs.constants.COPYFILE_EXCL | (fs.constants.COPYFILE_FICLONE || 0),
    );
    const snapshotBeforeHash = fs.statSync(targetPath);
    const snapshotHash = await calculateHash(targetPath);
    const snapshotAfterHash = fs.statSync(targetPath);
    if (snapshotHash !== expectedHash || !sameSourceStat(snapshotBeforeHash, snapshotAfterHash)) {
      throw sourceChangedError('素材快照内容与任务哈希不一致');
    }
    const sourceBeforeHash = fs.statSync(sourcePath);
    const sourceHash = await calculateHash(sourcePath);
    const sourceAfterHash = fs.statSync(sourcePath);
    if (sourceHash !== expectedHash
      || !sameSourceStat(expectedStat || beforeCopy, sourceBeforeHash)
      || !sameSourceStat(sourceBeforeHash, sourceAfterHash)) {
      throw sourceChangedError('素材源文件在建立快照期间发生变化');
    }
    completed = true;
    return { path: targetPath, stat: snapshotAfterHash, contentHash: snapshotHash };
  } finally {
    if (!completed) {
      try { fs.rmSync(targetPath, { force: true }); } catch (_) {}
    }
  }
}

class AssetPreviewPipeline {
  constructor(config, database, options = {}) {
    this.config = config;
    this.database = database;
    this.concurrency = clampInteger(options.concurrency ?? config.ASSET_PREVIEW_CONCURRENCY, 1, 4, 2);
    this.maxAttempts = clampInteger(options.maxAttempts ?? config.ASSET_PREVIEW_MAX_ATTEMPTS, 1, 3, 3);
    this.retryBaseMs = clampInteger(options.retryBaseMs ?? config.ASSET_PREVIEW_RETRY_BASE_MS, 10, 60_000, 750);
    this.storageRetryBaseMs = clampInteger(options.storageRetryBaseMs, 10, 60_000, 250);
    this.storageRetryMaxMs = clampInteger(
      options.storageRetryMaxMs,
      this.storageRetryBaseMs,
      120_000,
      Math.max(this.storageRetryBaseMs, 30_000),
    );
    this.databaseBusyRetryBaseMs = clampInteger(options.databaseBusyRetryBaseMs, 10, 60_000, 100);
    this.databaseBusyRetryMaxMs = clampInteger(
      options.databaseBusyRetryMaxMs,
      this.databaseBusyRetryBaseMs,
      120_000,
      Math.max(this.databaseBusyRetryBaseMs, 5_000),
    );
    this.shutdownTimeoutMs = clampInteger(
      options.shutdownTimeoutMs ?? config.ASSET_PREVIEW_SHUTDOWN_TIMEOUT_MS,
      100,
      120_000,
      10_000,
    );
    this.ephemeralQueueLimit = clampInteger(options.ephemeralQueueLimit ?? config.ASSET_PREVIEW_EPHEMERAL_QUEUE_LIMIT, 1, 256, 64);
    this.pendingRerunLimit = clampInteger(
      options.pendingRerunLimit,
      this.concurrency,
      256,
      Math.max(this.concurrency, 16),
    );
    this.pipelineVersion = String(options.pipelineVersion || config.ASSET_PREVIEW_PIPELINE_VERSION || 'asset-preview-v1').slice(0, 80);
    this.createDerivedMedia = options.createDerivedMedia || createDerivedMedia;
    this.hashFile = options.hashFile || hashFile;
    this.active = 0;
    this.activeModel3d = 0;
    this.activeByProject = new Map();
    this.activeModel3dByProject = new Map();
    this.ephemeralQueue = [];
    this.preferPersistent = true;
    this.inflightGeneration = new Map();
    this.pendingCompletions = new Map();
    this.pendingReschedules = new Map();
    this.pendingReruns = new Map();
    this.pendingRecovery = false;
    this.activeReruns = 0;
    this.storagePressure = null;
    this.storagePressureFailures = 0;
    this.storageRetryAt = null;
    this.databaseBusy = null;
    this.databaseBusyFailures = 0;
    this.databaseBusyRetryAt = null;
    this.persistedStatusCache = new Map();
    this.onUnexpectedError = typeof options.onUnexpectedError === 'function'
      ? options.onUnexpectedError
      : null;
    this.pumpHandle = null;
    this.pumpDueAt = null;
    this.closed = false;
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.lifecycleEpoch = 0;
    this.tempCleanup = cleanupOrphanedPreviewTemps([config.ASSET_PREVIEWS_DIR, config.THUMBNAILS_DIR], {
      maxAgeMs: options.tempMaxAgeMs ?? config.ASSET_PREVIEW_TEMP_MAX_AGE_MS,
    });
    this.recovery = { recovered: 0, failed: 0 };
    if (options.recover !== false) {
      try {
        this.recovery = this.database.recoverAssetPreviewJobs();
      } catch (error) {
        const pressure = this.recordDatabasePressure(error, 'asset.preview.recover', { schedule: false });
        if (!pressure) throw error;
        this.pendingRecovery = true;
        this.recovery = { recovered: 0, failed: 0, pending: true };
      }
    }
    if (options.autoStart !== false) this.schedulePump();
  }

  recordStoragePressure(error, operation, options = {}) {
    const pressure = safeStoragePressure(error, operation);
    if (!pressure) return null;
    this.clearDatabaseBusy();
    this.storagePressureFailures += 1;
    const delay = Math.min(
      this.storageRetryMaxMs,
      this.storageRetryBaseMs * (2 ** Math.min(12, this.storagePressureFailures - 1)),
    );
    this.storageRetryAt = Date.now() + delay;
    this.storagePressure = Object.freeze({
      ...pressure,
      nextRetryAt: this.storageRetryAt,
    });
    if (options.schedule !== false) this.schedulePump(delay);
    return this.storagePressure;
  }

  clearStoragePressure() {
    this.storagePressure = null;
    this.storagePressureFailures = 0;
    this.storageRetryAt = null;
  }

  recordDatabaseBusy(error, options = {}) {
    if (!isDatabaseBusyError(error)) return null;
    this.clearStoragePressure();
    this.databaseBusyFailures += 1;
    const delay = Math.min(
      this.databaseBusyRetryMaxMs,
      this.databaseBusyRetryBaseMs * (2 ** Math.min(12, this.databaseBusyFailures - 1)),
    );
    this.databaseBusyRetryAt = Date.now() + delay;
    this.databaseBusy = Object.freeze({
      code: 'project_database_busy',
      active: true,
      nextRetryAt: this.databaseBusyRetryAt,
    });
    if (options.schedule !== false) this.schedulePump(delay);
    return this.databaseBusy;
  }

  clearDatabaseBusy() {
    this.databaseBusy = null;
    this.databaseBusyFailures = 0;
    this.databaseBusyRetryAt = null;
  }

  recordDatabasePressure(error, operation, options = {}) {
    return this.recordStoragePressure(error, operation, options)
      || this.recordDatabaseBusy(error, options);
  }

  clearDatabasePressure() {
    this.clearStoragePressure();
    this.clearDatabaseBusy();
  }

  databaseRetryAt() {
    return Math.max(
      Number(this.storageRetryAt) || 0,
      Number(this.databaseBusyRetryAt) || 0,
    );
  }

  readPersistedStatus(projectId = null, options = {}) {
    const cacheKey = projectId ? `project:${String(projectId)}` : 'all';
    const cached = this.persistedStatusCache.get(cacheKey)
      || { counts: emptyPreviewStatusCounts() };
    const retryAt = this.databaseRetryAt();
    if (retryAt && Date.now() < retryAt && options.ignoreBackoff !== true) {
      return { ...cached, counts: { ...cached.counts }, stale: true };
    }
    try {
      const persisted = sanitizePersistedPreviewStatus(
        this.database.getAssetPreviewJobStatus(projectId ? { projectId } : {}),
      );
      this.persistedStatusCache.set(cacheKey, persisted);
      return { ...persisted, counts: { ...persisted.counts }, stale: false };
    } catch (error) {
      if (!this.recordDatabasePressure(error, 'asset.preview.status', {
        schedule: options.schedule !== false,
      })) throw error;
      return { ...cached, counts: { ...cached.counts }, stale: true };
    }
  }

  reportUnexpectedError(error) {
    if (this.onUnexpectedError) {
      this.onUnexpectedError(error);
      return;
    }
    queueMicrotask(() => { throw error; });
  }

  deferCompletion(job, result, availabilityObservation, error) {
    if (this.closed) return false;
    this.pendingCompletions.set(previewAttemptKey(job), { job, result, availabilityObservation });
    this.recordDatabasePressure(error, 'asset.preview.complete');
    return true;
  }

  deferReschedule(job, errorDetails, options, availabilityObservation, capacityError) {
    if (this.closed) return false;
    this.pendingReschedules.set(previewAttemptKey(job), {
      job,
      error: errorDetails,
      options,
      availabilityObservation,
    });
    this.recordDatabasePressure(capacityError, 'asset.preview.reschedule');
    return true;
  }

  deferRerun(job, capacityError) {
    if (this.closed) return false;
    const attemptKey = previewAttemptKey(job);
    if (!this.pendingReruns.has(attemptKey) && this.pendingReruns.size >= this.pendingRerunLimit) {
      const overflow = new Error('预览容量恢复队列超过内部上限');
      overflow.code = 'asset-preview-capacity-rerun-overflow';
      throw overflow;
    }
    this.pendingReruns.set(attemptKey, job);
    this.recordDatabasePressure(capacityError, 'asset.preview.worker');
    return true;
  }

  completionError(completed) {
    if (completed?.applied
      || completed?.reason === 'job-missing'
      || completed?.reason === 'asset-missing'
      || completed?.reason === 'source-content-changed'
      || completed?.reason === 'stale-attempt'
      || completed?.reason === 'stale-job-state') return null;
    const error = new Error('旧预览结果未写回当前素材');
    error.code = completed?.reason || 'source-content-changed';
    return error;
  }

  attemptCompletion(job, result, availabilityObservation = null) {
    if (this.closed) return false;
    let completed;
    try {
      completed = this.database.completeAssetPreviewJob(job.id, result, previewDatabaseMutationInput(job, {
        ...(availabilityObservation ? { availabilityObservation } : {}),
      }));
    } catch (error) {
      if (availabilityObservation && isAvailabilityObservationConflict(error)) {
        return this.attemptCompletion(job, result, null);
      }
      if (isRecoverableDatabasePressure(error, 'asset.preview.complete')) {
        this.deferCompletion(job, result, availabilityObservation, error);
        return false;
      }
      throw error;
    }
    const completionError = this.completionError(completed);
    if (completionError) throw completionError;
    return true;
  }

  attemptReschedule(job, errorDetails, options, availabilityObservation = null) {
    if (this.closed) return false;
    try {
      this.database.rescheduleAssetPreviewJob(job.id, errorDetails, previewDatabaseMutationInput(job, {
        ...options,
        ...(availabilityObservation ? { availabilityObservation } : {}),
      }));
      return true;
    } catch (error) {
      if (availabilityObservation && isAvailabilityObservationConflict(error)) {
        return this.attemptReschedule(job, errorDetails, options, null);
      }
      if (isRecoverableDatabasePressure(error, 'asset.preview.reschedule')) {
        this.deferReschedule(job, errorDetails, options, availabilityObservation, error);
        return false;
      }
      throw error;
    }
  }

  flushPendingDatabaseWork() {
    if (this.closed) return false;
    if (this.pendingRecovery) {
      try {
        this.recovery = this.database.recoverAssetPreviewJobs();
        this.pendingRecovery = false;
      } catch (error) {
        if (this.recordDatabasePressure(error, 'asset.preview.recover')) return false;
        throw error;
      }
    }

    for (const [attemptKey, pending] of this.pendingCompletions) {
      let completed;
      try {
        completed = this.database.completeAssetPreviewJob(
          pending.job.id,
          pending.result,
          previewDatabaseMutationInput(pending.job, {
            ...(pending.availabilityObservation ? { availabilityObservation: pending.availabilityObservation } : {}),
          }),
        );
      } catch (error) {
        if (pending.availabilityObservation && isAvailabilityObservationConflict(error)) {
          pending.availabilityObservation = null;
          continue;
        }
        if (this.recordDatabasePressure(error, 'asset.preview.complete')) return false;
        throw error;
      }
      this.pendingCompletions.delete(attemptKey);
      const completionError = this.completionError(completed);
      if (completionError) {
        const safe = sanitizePreviewError(completionError);
        const delay = this.retryBaseMs * (2 ** Math.max(0, Number(pending.job.attemptCount) - 1));
        const rescheduleOptions = {
          retryable: isRetryablePreviewError(completionError),
          nextAttemptAt: Date.now() + delay,
        };
        if (!this.attemptReschedule(pending.job, safe, rescheduleOptions)) return false;
      }
    }

    for (const [attemptKey, pending] of this.pendingReschedules) {
      try {
        this.database.rescheduleAssetPreviewJob(
          pending.job.id,
          pending.error,
          previewDatabaseMutationInput(pending.job, {
            ...pending.options,
            ...(pending.availabilityObservation ? { availabilityObservation: pending.availabilityObservation } : {}),
          }),
        );
      } catch (error) {
        if (pending.availabilityObservation && isAvailabilityObservationConflict(error)) {
          pending.availabilityObservation = null;
          continue;
        }
        if (this.recordDatabasePressure(error, 'asset.preview.reschedule')) return false;
        throw error;
      }
      this.pendingReschedules.delete(attemptKey);
    }

    this.clearDatabasePressure();
    return true;
  }

  hasPendingDatabaseWork() {
    return this.pendingRecovery
      || this.pendingCompletions.size > 0
      || this.pendingReschedules.size > 0;
  }

  hasPendingWork() {
    return this.hasPendingDatabaseWork() || this.pendingReruns.size > 0;
  }

  takePendingRerun() {
    for (const [attemptKey, job] of this.pendingReruns) {
      if (job.jobKind === 'model3d-preview' && this.activeModel3d > 0) continue;
      this.pendingReruns.delete(attemptKey);
      return job;
    }
    return null;
  }

  enqueueAsset(asset) {
    const jobKind = JOB_KIND_BY_ASSET_KIND[asset?.kind];
    if (!jobKind || !asset?.id || !asset?.contentHash || !asset?.managedPath || assetPreviewEligibilityError(asset)) return null;
    const job = this.database.enqueueAssetPreviewJob({
      assetId: asset.id,
      contentHash: asset.contentHash,
      jobKind,
      pipelineVersion: this.pipelineVersion,
      maxAttempts: this.maxAttempts,
    });
    this.schedulePump();
    return job;
  }

  retryAsset(assetId) {
    let shouldSchedule = false;
    const jobs = this.database.withProjectDatabaseWrite('asset.preview.retry', () => {
      const asset = this.database.getAsset(assetId);
      if (!asset) return [];
      const eligibilityError = assetPreviewEligibilityError(asset);
      if (eligibilityError) throw eligibilityError;
      const jobKind = JOB_KIND_BY_ASSET_KIND[asset.kind];
      this.database.retryAssetPreviewJobs(asset.id, asset.contentHash);
      if (jobKind && asset.id && asset.contentHash && asset.managedPath) {
        this.database.enqueueAssetPreviewJob({
          assetId: asset.id,
          contentHash: asset.contentHash,
          jobKind,
          pipelineVersion: this.pipelineVersion,
          maxAttempts: this.maxAttempts,
        });
      }
      shouldSchedule = true;
      return this.database.listAssetPreviewJobs({ assetId: asset.id, contentHash: asset.contentHash, limit: 100 });
    });
    if (shouldSchedule) this.schedulePump();
    return jobs;
  }

  status(projectId = null) {
    const persisted = this.readPersistedStatus(projectId);
    const projectKey = projectId == null ? null : String(projectId);
    const projectPendingCount = (items, readJob) => {
      if (projectKey == null) return items.size;
      let count = 0;
      for (const item of items.values()) {
        const job = readJob(item);
        if (String(job?.projectId || '') === projectKey) count += 1;
      }
      return count;
    };
    const projectScoped = projectKey != null;
    return {
      ...(projectScoped ? { projectId: projectKey } : {}),
      active: projectScoped ? (this.activeByProject.get(projectKey) || 0) : this.active,
      activeModel3d: projectScoped
        ? (this.activeModel3dByProject.get(projectKey) || 0)
        : this.activeModel3d,
      concurrency: this.concurrency,
      ...(projectScoped ? { concurrencyScope: 'global' } : {}),
      counts: persisted.counts,
      ...(persisted.nextAttemptAt ? { nextAttemptAt: persisted.nextAttemptAt } : {}),
      ...(persisted.stale ? { databaseStatusStale: true } : {}),
      ...(this.shuttingDown ? {
        shuttingDown: true,
        ...(projectScoped ? { shuttingDownScope: 'global' } : {}),
      } : {}),
      pending: {
        ...(projectScoped ? {} : { recovery: this.pendingRecovery }),
        completions: projectPendingCount(this.pendingCompletions, (item) => item?.job),
        reschedules: projectPendingCount(this.pendingReschedules, (item) => item?.job),
        reruns: projectPendingCount(this.pendingReruns, (job) => job),
      },
      ...(projectScoped && this.pendingRecovery ? { globalRecoveryPending: true } : {}),
      ...(this.storagePressure ? {
        storagePressure: {
          ...this.storagePressure,
          ...(projectScoped ? { scope: 'global' } : {}),
        },
      } : {}),
      ...(this.databaseBusy ? {
        databaseBusy: {
          ...this.databaseBusy,
          ...(projectScoped ? { scope: 'global' } : {}),
        },
      } : {}),
    };
  }

  changeProjectActiveCount(map, projectId, delta) {
    const key = String(projectId || '');
    if (!key) return;
    const next = Math.max(0, (map.get(key) || 0) + delta);
    if (next > 0) map.set(key, next);
    else map.delete(key);
  }

  runEphemeral(task) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('临时预览任务必须是函数'));
    if (this.closed) return Promise.reject(new Error('预览管线已关闭'));
    if (this.shuttingDown) {
      const error = new Error('预览管线正在关闭');
      error.code = 'asset-preview-shutting-down';
      return Promise.reject(error);
    }
    if (this.ephemeralQueue.length >= this.ephemeralQueueLimit) {
      const error = new Error('临时预览队列已满，请稍后重试');
      error.code = 'preview-queue-full';
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this.ephemeralQueue.push({ task, resolve, reject });
      this.schedulePump();
    });
  }

  schedulePump(delayMs = 0) {
    if (this.closed) return;
    const dueAt = Date.now() + Math.max(0, Number(delayMs) || 0);
    if (this.pumpHandle && this.pumpDueAt != null && this.pumpDueAt <= dueAt) return;
    if (this.pumpHandle) {
      clearTimeout(this.pumpHandle);
      clearImmediate(this.pumpHandle);
      this.pumpHandle = null;
    }
    const invoke = () => {
      this.pumpHandle = null;
      this.pumpDueAt = null;
      this.pump();
    };
    this.pumpDueAt = dueAt;
    this.pumpHandle = delayMs > 0 ? setTimeout(invoke, delayMs) : setImmediate(invoke);
    // A delayed retry should not keep a CLI/process alive indefinitely. Immediate
    // work must stay referenced because runEphemeral callers can be awaiting it
    // while no other event-loop handle exists.
    if (delayMs > 0) this.pumpHandle?.unref?.();
  }

  pump() {
    if (this.closed) return;
    let allowPersistent = true;
    const databaseRetryAt = this.databaseRetryAt();
    if (databaseRetryAt && Date.now() < databaseRetryAt) {
      allowPersistent = false;
      this.schedulePump(Math.max(1, databaseRetryAt - Date.now()));
    } else if (this.hasPendingDatabaseWork()) {
      allowPersistent = this.flushPendingDatabaseWork();
    }

    while (this.active < this.concurrency) {
      let ephemeral = null;
      let job = null;
      let isRerun = false;
      const claimPersistent = () => {
        try {
          const claimed = this.database.claimNextAssetPreviewJob(
            this.activeModel3d > 0 ? { excludeJobKind: 'model3d-preview' } : {},
          );
          this.clearDatabasePressure();
          return claimed;
        } catch (error) {
          if (!this.recordDatabasePressure(error, 'asset.preview.claim')) throw error;
          allowPersistent = false;
          return null;
        }
      };
      if (allowPersistent) {
        job = this.takePendingRerun();
        isRerun = Boolean(job);
      }
      const canClaim = allowPersistent
        && !this.shuttingDown
        && !isRerun
        && this.pendingReruns.size === 0
        && this.activeReruns === 0;
      if (canClaim && this.preferPersistent) {
        job = claimPersistent();
        if (!job) ephemeral = this.ephemeralQueue.shift() || null;
      } else if (!isRerun) {
        ephemeral = this.ephemeralQueue.shift() || null;
        if (!ephemeral && canClaim) job = claimPersistent();
      }
      if (ephemeral) {
        this.preferPersistent = true;
        this.active += 1;
        Promise.resolve()
          .then(ephemeral.task)
          .then(ephemeral.resolve, ephemeral.reject)
          .finally(() => {
            this.active -= 1;
            this.schedulePump();
          });
        continue;
      }
      if (!job) break;
      this.preferPersistent = false;
      const isModel3d = job.jobKind === 'model3d-preview';
      if (isModel3d && this.activeModel3d > 0) {
        // claimNextAssetPreviewJob excludes this kind while a model is active;
        // keep the assertion defensive for custom database implementations.
        const raceError = {
          code: 'preview-model-slot-race',
          message: '3D 预览等待独占模型槽位',
        };
        const raceOptions = { retryable: true, nextAttemptAt: Date.now() + 25 };
        if (!this.attemptReschedule(job, raceError, raceOptions)) allowPersistent = false;
        this.schedulePump(25);
        continue;
      }
      this.active += 1;
      this.changeProjectActiveCount(this.activeByProject, job.projectId, 1);
      if (isRerun) this.activeReruns += 1;
      if (isModel3d) {
        this.activeModel3d += 1;
        this.changeProjectActiveCount(this.activeModel3dByProject, job.projectId, 1);
      }
      this.runPersistentJob(job)
        .catch((error) => this.reportUnexpectedError(error))
        .finally(() => {
          this.active -= 1;
          this.changeProjectActiveCount(this.activeByProject, job.projectId, -1);
          if (isRerun) this.activeReruns -= 1;
          if (isModel3d) {
            this.activeModel3d -= 1;
            this.changeProjectActiveCount(this.activeModel3dByProject, job.projectId, -1);
          }
          if (this.activeReruns === 0 && !this.hasPendingWork()) this.clearDatabasePressure();
          this.schedulePump();
        });
    }
    if (allowPersistent && !this.shuttingDown) {
      const status = this.readPersistedStatus();
      if (!status.stale && this.active === 0 && status.nextAttemptAt) {
        this.schedulePump(Math.max(10, Math.min(60_000, Number(status.nextAttemptAt) - Date.now())));
      }
    }
  }

  async runPersistentJob(job) {
    const lifecycleEpoch = this.lifecycleEpoch;
    const isCurrent = () => !this.closed && this.lifecycleEpoch === lifecycleEpoch;
    if (!isCurrent()) return;
    let availabilityObservation = null;
    const frozenSnapshot = job?.availabilitySnapshot || null;
    try {
      const asset = job?.asset;
      if (!asset || !frozenSnapshot) {
        const error = new Error('预览任务缺少 claim-time 素材快照');
        error.code = 'asset-preview-source-snapshot-missing';
        throw error;
      }
      if (asset.id !== job.assetId
        || asset.projectId !== job.projectId
        || asset.contentHash !== job.contentHash
        || frozenSnapshot.id !== job.assetId
        || frozenSnapshot.projectId !== job.projectId
        || frozenSnapshot.contentHash !== job.contentHash
        || frozenSnapshot.entityUid !== asset.entityUid
        || frozenSnapshot.contentRevision !== asset.contentRevision
        || frozenSnapshot.organizationRevision !== asset.organizationRevision
        || frozenSnapshot.managedPath !== asset.managedPath
        || frozenSnapshot.storageMode !== asset.storageMode) {
        throw sourceChangedError('预览任务的 claim-time 素材身份不一致');
      }
      const eligibilityError = assetPreviewEligibilityError(asset);
      if (eligibilityError) throw eligibilityError;
      const observed = await observeAssetAvailabilitySnapshot(frozenSnapshot, { hashFile: this.hashFile });
      if (!isCurrent()) return;
      availabilityObservation = { expected: frozenSnapshot, ...observed };
      if (observed.state === 'missing') {
        const error = new Error('预览源文件不存在');
        error.code = 'source-missing';
        throw error;
      }
      if (observed.state === 'source-changed') {
        const error = new Error('素材源文件已在索引后变化');
        error.code = 'source-content-changed';
        throw error;
      }
      if (observed.state !== 'available' || !observed.sourceStat) {
        availabilityObservation = null;
        const error = new Error('预览源文件当前无法安全校验');
        error.code = 'asset-unavailable';
        throw error;
      }
      if (!shouldPersistVerifiedAvailability(frozenSnapshot)) availabilityObservation = null;
      const before = observed.sourceStat;
      const generationKey = `${job.contentHash}:${job.jobKind}:${job.pipelineVersion}`;
      let generation = this.inflightGeneration.get(generationKey);
      if (!generation) {
        const snapshotRoot = this.config.ASSET_PREVIEWS_DIR || this.config.THUMBNAILS_DIR;
        const snapshot = await createVerifiedSourceSnapshot({
          sourcePath: asset.managedPath,
          sourceFilename: asset.filename,
          expectedHash: job.contentHash,
          expectedStat: before,
          snapshotRoot,
          hashFile: this.hashFile,
        });
        if (!isCurrent()) {
          try { fs.rmSync(snapshot.path, { force: true }); } catch (_) {}
          return;
        }
        // A same-hash job may have installed a generation while this async copy
        // was in flight. Prefer it and discard our now-unneeded private snapshot.
        generation = this.inflightGeneration.get(generationKey);
        if (generation) {
          try { fs.rmSync(snapshot.path, { force: true }); } catch (_) {}
        } else {
          let ownedGeneration;
          ownedGeneration = Promise.resolve()
            .then(() => this.createDerivedMedia(snapshot.path, asset.kind, asset.metadata || {}, this.config, job.contentHash))
            .then(async (result) => {
              const snapshotBeforeFinalHash = fs.statSync(snapshot.path);
              const finalSnapshotHash = await this.hashFile(snapshot.path);
              const snapshotAfterFinalHash = fs.statSync(snapshot.path);
              if (finalSnapshotHash !== job.contentHash
                || !sameSourceStat(snapshot.stat, snapshotBeforeFinalHash)
                || !sameSourceStat(snapshotBeforeFinalHash, snapshotAfterFinalHash)) {
                throw sourceChangedError('素材快照在预览生成期间发生变化');
              }
              return result;
            })
            .finally(() => {
              try { fs.rmSync(snapshot.path, { force: true }); } catch (_) {}
              if (this.inflightGeneration.get(generationKey) === ownedGeneration) this.inflightGeneration.delete(generationKey);
            });
          generation = ownedGeneration;
          this.inflightGeneration.set(generationKey, generation);
        }
      }
      const result = await generation;
      if (!isCurrent()) return;
      const after = fs.statSync(asset.managedPath);
      if (!sameSourceStat(before, after)) {
        throw sourceChangedError('预览生成期间素材源文件发生变化');
      }
      const finalHash = await this.hashFile(asset.managedPath);
      if (!isCurrent()) return;
      const afterFinalHash = fs.statSync(asset.managedPath);
      if (finalHash !== job.contentHash || !sameSourceStat(after, afterFinalHash)) {
        throw sourceChangedError('预览生成后素材源内容已变化');
      }
      this.attemptCompletion(job, result, availabilityObservation);
    } catch (error) {
      // A bounded forced close deliberately leaves the durable running job for
      // startup recovery. Never touch ProjectDatabase after its lifecycle may
      // have closed, even if a native renderer settles much later.
      if (!isCurrent()) return;
      if (this.pendingCompletions.has(previewAttemptKey(job))) return;
      if (isRecoverableDatabasePressure(error, 'asset.preview.worker')) {
        this.deferRerun(job, error);
        return;
      }
      if (frozenSnapshot && /(?:source|asset).*(?:missing|changed|unavailable)|ENOENT|ENOTDIR|EACCES|EPERM/i.test(
        `${String(error?.code || '')} ${String(error?.message || '')}`,
      )) {
        const observed = await observeAssetAvailabilitySnapshot(frozenSnapshot, { hashFile: this.hashFile });
        if (!isCurrent()) return;
        availabilityObservation = ['missing', 'source-changed'].includes(observed.state)
          ? { expected: frozenSnapshot, ...observed }
          : null;
      }
      const safe = sanitizePreviewError(error);
      const retryable = isRetryablePreviewError(error);
      const delay = this.retryBaseMs * (2 ** Math.max(0, Number(job.attemptCount) - 1));
      const rescheduleOptions = {
        retryable,
        nextAttemptAt: Date.now() + delay,
      };
      this.attemptReschedule(job, safe, rescheduleOptions, availabilityObservation);
    }
  }

  async waitForIdle(timeoutMs = 30_000) {
    const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 30_000);
    this.schedulePump();
    while (Date.now() < deadline) {
      const persisted = this.readPersistedStatus();
      const counts = persisted.counts;
      if (!persisted.stale
        && this.active === 0
        && this.ephemeralQueue.length === 0
        && !this.hasPendingWork()
        && counts.queued === 0
        && counts.running === 0
        && counts.retrying === 0) return true;
      const now = Date.now();
      const retryAt = this.databaseRetryAt();
      const persistedWakeAt = Number(persisted.nextAttemptAt) || 0;
      const nextWakeAt = Math.max(retryAt, persistedWakeAt);
      const delay = nextWakeAt > now
        ? Math.max(10, Math.min(1_000, nextWakeAt - now))
        : 25;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(1, deadline - now))));
    }
    return false;
  }

  isShutdownDrained() {
    return this.active === 0
      && this.activeModel3d === 0
      && this.activeReruns === 0
      && this.ephemeralQueue.length === 0
      && this.inflightGeneration.size === 0
      && !this.hasPendingWork();
  }

  shutdown(options = {}) {
    if (this.closed) return Promise.resolve({ drained: true, alreadyClosed: true });
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    const closingError = new Error('预览管线正在关闭');
    closingError.code = 'asset-preview-shutting-down';
    this.ephemeralQueue.splice(0).forEach((item) => item.reject(closingError));
    const requestedTimeout = Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.max(100, requestedTimeout)
      : this.shutdownTimeoutMs;
    const deadline = Date.now() + timeoutMs;

    this.shutdownPromise = (async () => {
      // Pull a delayed timer forward once so it can re-evaluate the current
      // pressure deadline. Subsequent retries keep the existing bounded backoff.
      this.schedulePump();
      while (!this.closed) {
        if (this.isShutdownDrained()) {
          this.close();
          return { drained: true };
        }
        const now = Date.now();
        if (now >= deadline) {
          const pending = {
            active: this.active,
            activeModel3d: this.activeModel3d,
            ephemeral: this.ephemeralQueue.length,
            generations: this.inflightGeneration.size,
            completions: this.pendingCompletions.size,
            reschedules: this.pendingReschedules.size,
            reruns: this.pendingReruns.size,
            recovery: this.pendingRecovery,
          };
          // Never make SIGINT/SIGTERM wait forever on a hung renderer or
          // permanent storage pressure. close() fences every later DB write;
          // durable running jobs remain recoverable on the next startup.
          this.close();
          return { drained: false, forced: true, timedOut: true, pending };
        }
        const retryAt = this.databaseRetryAt();
        const delay = retryAt > now
          ? Math.max(10, Math.min(250, retryAt - now))
          : 25;
        await new Promise((resolve) => setTimeout(
          resolve,
          Math.min(delay, Math.max(1, deadline - now)),
        ));
      }
      return { drained: this.isShutdownDrained(), alreadyClosed: true };
    })().finally(() => {
      this.shutdownPromise = null;
    });
    return this.shutdownPromise;
  }

  close() {
    if (this.closed) return;
    this.shuttingDown = true;
    this.closed = true;
    this.lifecycleEpoch += 1;
    if (this.pumpHandle) {
      clearTimeout(this.pumpHandle);
      clearImmediate(this.pumpHandle);
      this.pumpHandle = null;
      this.pumpDueAt = null;
    }
    this.pendingCompletions.clear();
    this.pendingReschedules.clear();
    this.pendingReruns.clear();
    this.pendingRecovery = false;
    this.inflightGeneration.clear();
    const error = new Error('预览管线已关闭');
    this.ephemeralQueue.splice(0).forEach((item) => item.reject(error));
  }
}

let singleton = null;

function getAssetPreviewPipeline(config, database) {
  if (!singleton) singleton = new AssetPreviewPipeline(config, database);
  return singleton;
}

function peekAssetPreviewPipeline() {
  return singleton;
}

module.exports = {
  AssetPreviewPipeline,
  JOB_KIND_BY_ASSET_KIND,
  getAssetPreviewPipeline,
  peekAssetPreviewPipeline,
  isRetryablePreviewError,
  sanitizePreviewError,
  cleanupOrphanedPreviewTemps,
  createVerifiedSourceSnapshot,
  assetPreviewEligibilityError,
};
