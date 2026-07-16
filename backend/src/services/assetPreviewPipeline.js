const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createDerivedMedia, hashFile } = require('./assetIndexer');

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
  return Boolean(left && right && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs);
}

function sourceChangedError(message = '素材源文件在生成预览期间发生变化') {
  const error = new Error(message);
  error.code = 'source-content-changed';
  return error;
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
    this.ephemeralQueueLimit = clampInteger(options.ephemeralQueueLimit ?? config.ASSET_PREVIEW_EPHEMERAL_QUEUE_LIMIT, 1, 256, 64);
    this.pipelineVersion = String(options.pipelineVersion || config.ASSET_PREVIEW_PIPELINE_VERSION || 'asset-preview-v1').slice(0, 80);
    this.createDerivedMedia = options.createDerivedMedia || createDerivedMedia;
    this.hashFile = options.hashFile || hashFile;
    this.active = 0;
    this.activeModel3d = 0;
    this.ephemeralQueue = [];
    this.preferPersistent = true;
    this.inflightGeneration = new Map();
    this.pumpHandle = null;
    this.pumpDueAt = null;
    this.closed = false;
    this.tempCleanup = cleanupOrphanedPreviewTemps([config.ASSET_PREVIEWS_DIR, config.THUMBNAILS_DIR], {
      maxAgeMs: options.tempMaxAgeMs ?? config.ASSET_PREVIEW_TEMP_MAX_AGE_MS,
    });
    this.recovery = options.recover === false ? { recovered: 0, failed: 0 } : this.database.recoverAssetPreviewJobs();
    if (options.autoStart !== false) this.schedulePump();
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
    const asset = this.database.getAsset(assetId);
    if (!asset) return [];
    const eligibilityError = assetPreviewEligibilityError(asset);
    if (eligibilityError) throw eligibilityError;
    this.database.retryAssetPreviewJobs(asset.id, asset.contentHash);
    this.enqueueAsset(asset);
    this.schedulePump();
    return this.database.listAssetPreviewJobs({ assetId: asset.id, contentHash: asset.contentHash, limit: 100 });
  }

  status(projectId = null) {
    const persisted = this.database.getAssetPreviewJobStatus(projectId ? { projectId } : {});
    return {
      active: this.active,
      activeModel3d: this.activeModel3d,
      concurrency: this.concurrency,
      counts: persisted.counts,
      ...(persisted.nextAttemptAt ? { nextAttemptAt: persisted.nextAttemptAt } : {}),
    };
  }

  runEphemeral(task) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('临时预览任务必须是函数'));
    if (this.closed) return Promise.reject(new Error('预览管线已关闭'));
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
    while (this.active < this.concurrency) {
      let ephemeral = null;
      let job = null;
      if (this.preferPersistent) {
        job = this.database.claimNextAssetPreviewJob(this.activeModel3d > 0 ? { excludeJobKind: 'model3d-preview' } : {});
        if (!job) ephemeral = this.ephemeralQueue.shift() || null;
      } else {
        ephemeral = this.ephemeralQueue.shift() || null;
        if (!ephemeral) job = this.database.claimNextAssetPreviewJob(this.activeModel3d > 0 ? { excludeJobKind: 'model3d-preview' } : {});
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
        this.database.rescheduleAssetPreviewJob(job.id, {
          code: 'preview-model-slot-race',
          message: '3D 预览等待独占模型槽位',
        }, { retryable: true, nextAttemptAt: Date.now() + 25 });
        this.schedulePump(25);
        continue;
      }
      this.active += 1;
      if (isModel3d) this.activeModel3d += 1;
      this.runPersistentJob(job)
        .catch(() => {})
        .finally(() => {
          this.active -= 1;
          if (isModel3d) this.activeModel3d -= 1;
          this.schedulePump();
        });
    }
    const status = this.database.getAssetPreviewJobStatus();
    if (this.active === 0 && status.nextAttemptAt) {
      this.schedulePump(Math.max(10, Math.min(60_000, Number(status.nextAttemptAt) - Date.now())));
    }
  }

  async runPersistentJob(job) {
    const asset = this.database.getAsset(job.assetId);
    if (!asset) {
      // The FK normally cascades the job away with its asset. Keep this defensive
      // branch for custom databases or a delete racing immediately after claim.
      if (this.database.getAssetPreviewJob(job.id)) {
        this.database.rescheduleAssetPreviewJob(job.id, {
          code: 'asset-missing',
          message: '素材索引已删除',
        }, { retryable: false });
      }
      return;
    }
    try {
      const eligibilityError = assetPreviewEligibilityError(asset);
      if (eligibilityError) throw eligibilityError;
      if (!asset.managedPath || !fs.existsSync(asset.managedPath)) {
        this.database.updateAssetAvailability(asset.id, 'missing', { health: 'missing' });
        const error = new Error('预览源文件不存在');
        error.code = 'source-missing';
        throw error;
      }
      if (asset.contentHash !== job.contentHash) {
        const error = new Error('素材内容哈希已变化');
        error.code = 'source-content-changed';
        throw error;
      }
      const before = fs.statSync(asset.managedPath);
      const actualHash = await this.hashFile(asset.managedPath);
      const afterInitialHash = fs.statSync(asset.managedPath);
      if (actualHash !== job.contentHash) {
        const error = new Error('素材源文件已在索引后变化');
        error.code = 'source-content-changed';
        throw error;
      }
      if (!sameSourceStat(before, afterInitialHash)) {
        throw sourceChangedError('素材源文件在校验期间发生变化');
      }
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
      const after = fs.statSync(asset.managedPath);
      if (!sameSourceStat(before, after)) {
        throw sourceChangedError('预览生成期间素材源文件发生变化');
      }
      const finalHash = await this.hashFile(asset.managedPath);
      const afterFinalHash = fs.statSync(asset.managedPath);
      if (finalHash !== job.contentHash || !sameSourceStat(after, afterFinalHash)) {
        throw sourceChangedError('预览生成后素材源内容已变化');
      }
      const completed = this.database.completeAssetPreviewJob(job.id, result);
      if (!completed.applied && completed.reason !== 'job-missing' && completed.reason !== 'asset-missing') {
        const error = new Error('旧预览结果未写回当前素材');
        error.code = completed.reason || 'source-content-changed';
        throw error;
      }
    } catch (error) {
      const safe = sanitizePreviewError(error);
      const retryable = isRetryablePreviewError(error);
      const delay = this.retryBaseMs * (2 ** Math.max(0, Number(job.attemptCount) - 1));
      this.database.rescheduleAssetPreviewJob(job.id, safe, {
        retryable,
        nextAttemptAt: Date.now() + delay,
      });
    }
  }

  async waitForIdle(timeoutMs = 30_000) {
    const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 30_000);
    while (Date.now() < deadline) {
      const counts = this.database.getAssetPreviewJobStatus().counts;
      if (this.active === 0 && this.ephemeralQueue.length === 0 && counts.queued === 0 && counts.running === 0 && counts.retrying === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  close() {
    this.closed = true;
    if (this.pumpHandle) {
      clearTimeout(this.pumpHandle);
      clearImmediate(this.pumpHandle);
      this.pumpHandle = null;
      this.pumpDueAt = null;
    }
    const error = new Error('预览管线已关闭');
    this.ephemeralQueue.splice(0).forEach((item) => item.reject(error));
  }
}

let singleton = null;

function getAssetPreviewPipeline(config, database) {
  if (!singleton) singleton = new AssetPreviewPipeline(config, database);
  return singleton;
}

module.exports = {
  AssetPreviewPipeline,
  JOB_KIND_BY_ASSET_KIND,
  getAssetPreviewPipeline,
  isRetryablePreviewError,
  sanitizePreviewError,
  cleanupOrphanedPreviewTemps,
  createVerifiedSourceSnapshot,
  assetPreviewEligibilityError,
};
