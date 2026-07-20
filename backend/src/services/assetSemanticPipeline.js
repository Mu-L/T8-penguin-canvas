'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { hashFile } = require('./assetIndexer');
const {
  createVerifiedSourceSnapshot,
  isRetryablePreviewError,
  sanitizePreviewError,
} = require('./assetPreviewPipeline');
const { redactRunValue } = require('./runRedaction');
const {
  DEFAULT_SEMANTIC_MODEL_BY_TASK,
  SEMANTIC_TASKS,
  assertSemanticModelId,
  getPublicSemanticModelManifest,
  getTrustedSemanticModelSpec,
} = require('./assetSemanticModels');
const { AssetSemanticWorker } = require('./assetSemanticWorker');

const SEMANTIC_TASK_ORDER = Object.freeze([
  SEMANTIC_TASKS.CAPTION,
  SEMANTIC_TASKS.OCR,
  SEMANTIC_TASKS.EMBEDDING,
]);
const VISION_SEMANTIC_TASKS = new Set([SEMANTIC_TASKS.CAPTION, SEMANTIC_TASKS.OCR]);
const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'skipped', 'superseded']);
const SUCCESSFUL_DEPENDENCY_STATUSES = new Set(['succeeded', 'skipped']);
const MAX_SEMANTIC_TEXT = 64 * 1024;
const MAX_EMBEDDING_TEXT = 8_192;
const MAX_QUERY_TEXT = 2_000;
const MAX_REBUILD_ASSETS = 50_000;
const MODEL_PROGRESS_WRITE_INTERVAL_MS = 500;

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function semanticError(code, message, current = null) {
  const error = new Error(message);
  error.code = code;
  if (current) error.current = current;
  return error;
}

function semanticAbortError(message = '语义任务已取消') {
  const error = semanticError('asset-semantic-aborted', message);
  error.name = 'AbortError';
  return error;
}

function combineAbortSignals(...values) {
  const signals = values.filter((signal) => signal && typeof signal.addEventListener === 'function');
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof globalThis.AbortSignal?.any === 'function') return globalThis.AbortSignal.any(signals);
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeSemanticText(value, maximum = MAX_SEMANTIC_TEXT) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function safeScalar(value, maximum = 300) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return '';
  return normalizeSemanticText(value, maximum);
}

function semanticMetadataFragments(asset) {
  const metadata = asset?.metadata && typeof asset.metadata === 'object' ? asset.metadata : {};
  const provenance = asset?.provenance && typeof asset.provenance === 'object' ? asset.provenance : {};
  const fragments = [];
  const add = (label, value, maximum = 300) => {
    const text = safeScalar(value, maximum);
    if (text) fragments.push(`${label}: ${text}`);
  };
  add('type', asset?.kind);
  add('mime', asset?.mimeType);
  add('width', metadata.width);
  add('height', metadata.height);
  add('duration', metadata.duration);
  add('format', metadata.format || metadata.extension);
  add('codec', metadata.codec || metadata.videoCodec || metadata.audioCodec);
  add('color', metadata.colorSpace || metadata.space);
  add('title', metadata.title);
  add('description', metadata.description, 1_000);
  add('artist', metadata.artist);
  add('album', metadata.album);
  add('camera', metadata.cameraModel || metadata.model);
  add('source', provenance.source);
  add('provider', provenance.provider);
  add('model', provenance.model);
  if (asset?.kind === 'text') add('text', metadata.preview, 8_000);
  return fragments;
}

function buildAssetSemanticText(asset, documents = []) {
  const fragments = [];
  const filename = normalizeSemanticText(asset?.filename, 1_000);
  if (filename) fragments.push(`filename: ${filename}`);
  const tags = [...new Set((Array.isArray(asset?.tags) ? asset.tags : [])
    .map((tag) => normalizeSemanticText(tag, 120)).filter(Boolean))].slice(0, 100);
  if (tags.length) fragments.push(`tags: ${tags.join(', ')}`);
  fragments.push(...semanticMetadataFragments(asset));
  for (const document of Array.isArray(documents) ? documents : []) {
    const kind = String(document?.sourceKind || document?.source_kind || document?.kind || '');
    if (!['caption', 'ocr'].includes(kind)) continue;
    const text = normalizeSemanticText(document?.text, kind === 'ocr' ? 32_000 : 8_000);
    if (text) fragments.push(`${kind}: ${text}`);
  }
  return normalizeSemanticText(fragments.join('\n'), MAX_EMBEDDING_TEXT);
}

function effectiveCapability(profile, task) {
  const raw = profile?.[task] && typeof profile[task] === 'object' ? profile[task] : {};
  const modelId = String(raw.modelKey || DEFAULT_SEMANTIC_MODEL_BY_TASK[task] || '');
  assertSemanticModelId(modelId, task);
  const spec = getTrustedSemanticModelSpec(modelId, task);
  const modelVersion = String(raw.modelVersion || spec.revision);
  if (modelVersion !== spec.revision) {
    throw semanticError('asset-semantic-model-version-not-allowed', '语义模型版本不在固定清单中');
  }
  return {
    task,
    enabled: Boolean(profile?.enabled && raw.enabled),
    modelKey: modelId,
    modelVersion,
    spec,
  };
}

function effectiveProfile(profile) {
  return {
    ...profile,
    caption: effectiveCapability(profile, SEMANTIC_TASKS.CAPTION),
    ocr: effectiveCapability(profile, SEMANTIC_TASKS.OCR),
    embedding: effectiveCapability(profile, SEMANTIC_TASKS.EMBEDDING),
  };
}

function semanticProfileConfigIdentity(profile) {
  const effective = effectiveProfile(profile);
  return {
    enabled: Boolean(effective.enabled),
    caption: { enabled: effective.caption.enabled, modelKey: effective.caption.modelKey, modelVersion: effective.caption.modelVersion },
    ocr: { enabled: effective.ocr.enabled, modelKey: effective.ocr.modelKey, modelVersion: effective.ocr.modelVersion },
    embedding: { enabled: effective.embedding.enabled, modelKey: effective.embedding.modelKey, modelVersion: effective.embedding.modelVersion },
  };
}

function isPathWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveVerifiedVideoPreview(asset, config) {
  const metadata = asset?.metadata && typeof asset.metadata === 'object' ? asset.metadata : {};
  const rawUrl = String(metadata.firstFrameUrl || metadata.thumbnailUrl || '');
  const prefix = '/files/thumbnails/';
  if (!rawUrl.startsWith(prefix)) throw semanticError('asset-semantic-preview-unavailable', '视频尚无可验证首帧预览');
  let segments;
  try {
    segments = rawUrl.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent);
  } catch (_) {
    throw semanticError('asset-semantic-preview-invalid', '视频预览地址无效');
  }
  if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\\/]/.test(segment))) {
    throw semanticError('asset-semantic-preview-invalid', '视频预览地址无效');
  }
  const target = path.resolve(config.THUMBNAILS_DIR, ...segments);
  if (!isPathWithin(config.THUMBNAILS_DIR, target)) throw semanticError('asset-semantic-preview-invalid', '视频预览越过允许目录');
  const contentHash = String(asset.contentHash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw semanticError('asset-semantic-preview-stale', '视频预览缺少有效的素材内容身份');
  }
  const expectedPrefix = `asset-${contentHash.slice(0, 24)}-`;
  if (!path.basename(target).startsWith(expectedPrefix)) {
    throw semanticError('asset-semantic-preview-stale', '视频预览与当前素材内容不一致');
  }
  let targetStat;
  try {
    targetStat = fs.lstatSync(target);
  } catch (_) {
    throw semanticError('asset-semantic-preview-unavailable', '视频尚无可验证首帧预览');
  }
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw semanticError('asset-semantic-preview-invalid', '视频预览文件不可用');
  }
  let realRoot;
  let realTarget;
  try {
    realRoot = fs.realpathSync(config.THUMBNAILS_DIR);
    realTarget = fs.realpathSync(target);
  } catch (_) {
    throw semanticError('asset-semantic-preview-invalid', '视频预览文件不可验证');
  }
  if (!isPathWithin(realRoot, realTarget)) {
    throw semanticError('asset-semantic-preview-invalid', '视频预览越过允许目录');
  }
  if (targetStat.size <= 0 || targetStat.size > 64 * 1024 * 1024) {
    throw semanticError('asset-semantic-preview-invalid', '视频预览文件不可用');
  }
  return target;
}

async function createSemanticImageSnapshot(asset, config, options = {}) {
  if (!asset || asset.availability !== 'available' || String(asset?.metadata?.health || '') === 'corrupt') {
    throw semanticError('asset-semantic-source-unavailable', '素材不可用或已损坏');
  }
  fs.mkdirSync(config.ASSET_SEMANTIC_SNAPSHOTS_DIR, { recursive: true });
  if (asset.kind === 'video') {
    const source = resolveVerifiedVideoPreview(asset, config);
    const extension = /^\.(?:webp|png|jpe?g)$/i.test(path.extname(source)) ? path.extname(source).toLowerCase() : '.webp';
    const target = path.join(config.ASSET_SEMANTIC_SNAPSHOTS_DIR, `.asset-semantic.snapshot-${process.pid}-${crypto.randomUUID()}${extension}`);
    let copied = false;
    try {
      const before = fs.statSync(source);
      await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL | (fs.constants.COPYFILE_FICLONE || 0));
      const after = fs.statSync(source);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw semanticError('asset-semantic-preview-changed', '视频预览在复制期间发生变化');
      }
      copied = true;
      return { path: target, cleanup: () => { try { fs.rmSync(target, { force: true }); } catch (_) {} } };
    } finally {
      if (!copied) { try { fs.rmSync(target, { force: true }); } catch (_) {} }
    }
  }
  if (asset.kind !== 'image') throw semanticError('asset-semantic-kind-unsupported', '当前任务只支持图像或视频首帧');
  const sourcePath = path.resolve(String(asset.managedPath || ''));
  if (!asset.managedPath || !path.isAbsolute(sourcePath) || !fs.existsSync(sourcePath)) {
    throw semanticError('asset-semantic-source-unavailable', '素材没有可读取的本地源文件');
  }
  const expectedStat = fs.statSync(sourcePath);
  const snapshot = await createVerifiedSourceSnapshot({
    sourcePath,
    expectedHash: String(asset.contentHash || ''),
    expectedStat,
    snapshotRoot: config.ASSET_SEMANTIC_SNAPSHOTS_DIR,
    hashFile: options.hashFile || hashFile,
  });
  return { path: snapshot.path, cleanup: () => { try { fs.rmSync(snapshot.path, { force: true }); } catch (_) {} } };
}

function sanitizeSemanticError(error) {
  const sanitized = sanitizePreviewError(error);
  return {
    code: sanitized.code.replace(/^preview-/, 'asset-semantic-'),
    message: normalizeSemanticText(redactRunValue(sanitized.message), 600) || '语义任务失败',
  };
}

function isRetryableSemanticError(error) {
  const code = String(error?.code || '').toLowerCase();
  if (/model-(?:not-installed|version-not-allowed)|kind-unsupported|source-unavailable|preview-(?:invalid|stale|unavailable)|content-changed|config|generation/.test(code)) return false;
  return isRetryablePreviewError(error);
}

function isSkippableVisionSourceError(error) {
  const code = String(error?.code || '').toLowerCase();
  return /(?:kind-unsupported|source-unavailable|preview-unavailable)$/.test(code);
}

function isSemanticRevisionConflict(error) {
  return /revision[_-]conflict$/.test(String(error?.code || ''));
}

function semanticModelStateMatches(current, next) {
  if (!current) return false;
  const status = String(next.status || 'not-installed');
  const absent = status === 'not-installed';
  const failed = status === 'failed';
  const expected = {
    status,
    artifactDigest: absent ? null : (next.artifactDigest || null),
    byteSize: absent ? null : (next.byteSize == null ? current.byteSize : Number(next.byteSize)),
    downloadedBytes: absent ? 0 : Math.max(0, Number(next.downloadedBytes) || 0),
    totalBytes: absent ? null : (next.totalBytes == null ? null : Math.max(0, Number(next.totalBytes) || 0)),
    installPath: absent ? null : (next.installPath || null),
    errorCode: failed ? String(next.error?.code || next.errorCode || 'semantic-model-failed').slice(0, 120) : null,
    errorMessage: failed ? String(next.error?.message || next.errorMessage || '语义模型操作失败').slice(0, 600) : null,
  };
  return current.status === expected.status
    && (current.artifactDigest || null) === expected.artifactDigest
    && (current.byteSize == null ? null : Number(current.byteSize)) === expected.byteSize
    && Number(current.downloadedBytes || 0) === expected.downloadedBytes
    && (current.totalBytes == null ? null : Number(current.totalBytes)) === expected.totalBytes
    && (current.installPath || null) === expected.installPath
    && (current.errorCode || null) === expected.errorCode
    && (current.errorMessage || null) === expected.errorMessage;
}

class AssetSemanticPipeline {
  constructor(config, database, options = {}) {
    this.config = config;
    this.database = database;
    this.worker = options.worker || new AssetSemanticWorker(config, options.workerOptions || {});
    this.concurrency = 1;
    this.maxAttempts = clampInteger(options.maxAttempts ?? config.ASSET_SEMANTIC_MAX_ATTEMPTS, 1, 3, 3);
    this.retryBaseMs = clampInteger(options.retryBaseMs ?? config.ASSET_SEMANTIC_RETRY_BASE_MS, 100, 60_000, 1_500);
    this.jobTimeoutMs = clampInteger(options.jobTimeoutMs ?? config.ASSET_SEMANTIC_JOB_TIMEOUT_MS, 30_000, 30 * 60_000, 10 * 60_000);
    this.pipelineVersion = String(options.pipelineVersion || config.ASSET_SEMANTIC_PIPELINE_VERSION || 'asset-semantic-v1').slice(0, 80);
    this.hashFile = options.hashFile || hashFile;
    this.active = 0;
    this.pumpHandle = null;
    this.closed = false;
    this.downloads = new Map();
    this.removals = new Set();
    this.modelVerifications = new Map();
    this.modelVerificationTail = Promise.resolve();
    this.lifecycleAbortController = new AbortController();
    this.queryEmbeddingCache = new Map();
    this.recovery = options.recover === false
      ? { recovered: 0, failed: 0, superseded: 0, enrollmentFailed: 0 }
      : this.database.recoverInterruptedAssetSemanticJobs({ now: Date.now() });
    [config.ASSET_SEMANTIC_MODELS_DIR, config.ASSET_SEMANTIC_WORK_DIR, config.ASSET_SEMANTIC_SNAPSHOTS_DIR]
      .filter(Boolean).forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
    if (options.autoStart !== false) this.schedulePump();
  }

  schedulePump(delayMs = 0) {
    if (this.closed || this.pumpHandle) return;
    const run = () => {
      this.pumpHandle = null;
      void this.pump().catch((error) => console.warn('[asset-semantic] pump failed:', sanitizeSemanticError(error).message));
    };
    this.pumpHandle = delayMs > 0 ? setTimeout(run, delayMs) : setImmediate(run);
  }

  async pump() {
    if (this.closed || this.active >= this.concurrency) return;
    const job = this.database.claimNextAssetSemanticJob({ now: Date.now() });
    if (!job) {
      const sweep = await this.reconcileIdleGenerations();
      const status = this.database.getAssetSemanticJobStatus?.() || {};
      if (status.nextAttemptAt) this.schedulePump(Math.max(10, Number(status.nextAttemptAt) - Date.now()));
      else if (sweep.failures > 0) this.schedulePump(100);
      return;
    }
    this.active += 1;
    void this.processJob(job).finally(() => {
      this.active -= 1;
      this.schedulePump();
    });
  }

  async reconcileIdleGenerations() {
    const generations = this.database.listBuildingAssetSemanticGenerations({ limit: 1_000 });
    let failures = 0;
    for (const generation of generations) {
      try {
        await this.reconcileGeneration(generation.projectId, generation.generation);
      } catch (error) {
        failures += 1;
        console.warn('[asset-semantic] generation reconciliation failed:', sanitizeSemanticError(error).message);
      }
    }
    let cleanup = {
      prunedGenerationCount: 0,
      prunedGenerations: [],
      deletedJobs: 0,
      deletedDocuments: 0,
      deletedEmbeddings: 0,
      hasMore: false,
    };
    try {
      cleanup = this.database.pruneAssetSemanticGenerationPayloads(null, { limitGenerations: 2 });
      if (cleanup.hasMore) this.schedulePump();
    } catch (error) {
      failures += 1;
      console.warn('[asset-semantic] generation payload cleanup failed:', sanitizeSemanticError(error).message);
    }
    return { checked: generations.length, failures, cleanup };
  }

  async processJob(job) {
    let snapshot = null;
    try {
      const asset = this.database.getAsset(job.assetId);
      if (!asset || asset.projectId !== job.projectId || asset.contentHash !== job.contentHash) {
        throw semanticError('asset-semantic-content-changed', '素材内容或项目身份已变化');
      }
      const profile = effectiveProfile(this.database.getAssetSemanticProfile(job.projectId));
      const capability = profile[job.jobKind];
      if (!capability?.enabled || capability.modelKey !== job.modelKey || capability.modelVersion !== job.modelVersion) {
        throw semanticError('asset-semantic-config-changed', '当前项目的语义能力配置已变化');
      }
      if (VISION_SEMANTIC_TASKS.has(job.jobKind)) {
        try {
          snapshot = await createSemanticImageSnapshot(asset, this.config, { hashFile: this.hashFile });
        } catch (error) {
          if (!isSkippableVisionSourceError(error)) throw error;
          const safe = sanitizeSemanticError(error);
          this.database.completeAssetSemanticJob(job.id, {
            claimToken: job.claimToken,
            expectedRevision: job.revision,
            contentHash: job.contentHash,
            generation: job.generation,
            modelKey: job.modelKey,
            modelVersion: job.modelVersion,
            skipped: { code: safe.code, message: safe.message, metadata: { kind: asset.kind } },
          }, { now: Date.now() });
          await this.reconcileGeneration(job.projectId, job.generation, profile);
          return;
        }
      }
      let result;
      if (job.jobKind === SEMANTIC_TASKS.EMBEDDING) {
        const documents = this.database.listAssetSemanticDocuments(job.projectId, {
          assetId: asset.id,
          generation: job.generation,
          limit: 100,
        });
        const text = buildAssetSemanticText(asset, documents);
        if (!text) {
          this.database.completeAssetSemanticJob(job.id, {
            claimToken: job.claimToken,
            expectedRevision: job.revision,
            contentHash: job.contentHash,
            generation: job.generation,
            modelKey: job.modelKey,
            modelVersion: job.modelVersion,
            skipped: { code: 'asset-semantic-empty-text', message: '素材没有可用于向量化的安全文本' },
          }, { now: Date.now() });
          await this.reconcileGeneration(job.projectId, job.generation, profile);
          return;
        }
        result = await this.worker.execute({
          modelId: job.modelKey,
          task: SEMANTIC_TASKS.EMBEDDING,
          text,
        }, {
          signal: this.lifecycleAbortController.signal,
          timeoutMs: this.jobTimeoutMs,
        });
        if (this.closed) throw semanticAbortError('应用正在关闭，语义任务已取消');
        this.database.completeAssetSemanticJob(job.id, {
          claimToken: job.claimToken,
          expectedRevision: job.revision,
          contentHash: job.contentHash,
          generation: job.generation,
          modelKey: job.modelKey,
          modelVersion: job.modelVersion,
          embedding: result.embedding || result.vector,
          inputDigest: sha256(text),
          metadata: { dimensions: result.dimensions || result.dimension },
        }, { now: Date.now() });
      } else {
        result = await this.worker.execute({
          modelId: job.modelKey,
          task: job.jobKind,
          sourcePath: snapshot.path,
        }, {
          signal: this.lifecycleAbortController.signal,
          timeoutMs: this.jobTimeoutMs,
        });
        if (this.closed) throw semanticAbortError('应用正在关闭，语义任务已取消');
        const text = normalizeSemanticText(result.text || result.caption, job.jobKind === SEMANTIC_TASKS.OCR ? 64 * 1024 : 8 * 1024);
        if (!text) {
          this.database.completeAssetSemanticJob(job.id, {
            claimToken: job.claimToken,
            expectedRevision: job.revision,
            contentHash: job.contentHash,
            generation: job.generation,
            modelKey: job.modelKey,
            modelVersion: job.modelVersion,
            skipped: { code: 'asset-semantic-empty-result', message: '模型未返回可索引文本' },
          }, { now: Date.now() });
        } else {
          const metadata = redactRunValue({
            lines: Array.isArray(result.lines) ? result.lines.slice(0, 16) : undefined,
            frameKind: asset.kind === 'video' ? 'video-first-frame' : 'image',
          });
          this.database.completeAssetSemanticJob(job.id, {
            claimToken: job.claimToken,
            expectedRevision: job.revision,
            contentHash: job.contentHash,
            generation: job.generation,
            modelKey: job.modelKey,
            modelVersion: job.modelVersion,
            [job.jobKind]: text,
            language: normalizeSemanticText(result.language, 40) || null,
            metadata,
          }, { now: Date.now() });
        }
      }
      await this.reconcileGeneration(job.projectId, job.generation, profile);
    } catch (error) {
      if (this.closed) return;
      const safe = sanitizeSemanticError(error);
      this.database.rescheduleAssetSemanticJob(job.id, safe, {
        claimToken: job.claimToken,
        expectedRevision: job.revision,
        retryable: isRetryableSemanticError(error),
        nextAttemptAt: Date.now() + this.retryBaseMs * Math.max(1, 2 ** Math.max(0, Number(job.attemptCount || 1) - 1)),
        now: Date.now(),
      });
      await this.reconcileGeneration(job.projectId, job.generation).catch(() => {});
    } finally {
      snapshot?.cleanup?.();
    }
  }

  async maybeEnqueueEmbedding(projectId, generation, assetId, suppliedProfile = null) {
    const profile = suppliedProfile || effectiveProfile(this.database.getAssetSemanticProfile(projectId));
    if (!profile.embedding.enabled) return null;
    const asset = this.database.getAsset(assetId);
    if (!asset || asset.projectId !== projectId) return null;
    const jobs = this.database.listAssetSemanticJobs({ projectId, generation, assetId, limit: 20 });
    const existing = jobs.find((job) => job.jobKind === SEMANTIC_TASKS.EMBEDDING);
    if (existing) return existing;
    const required = [profile.caption, profile.ocr].filter((entry) => entry.enabled);
    for (const capability of required) {
      const dependency = jobs.find((job) => job.jobKind === capability.task);
      if (!dependency || !TERMINAL_JOB_STATUSES.has(dependency.status)) return null;
      if (!SUCCESSFUL_DEPENDENCY_STATUSES.has(dependency.status)) return null;
    }
    return this.database.enqueueAssetSemanticJob({
      projectId,
      assetId,
      contentHash: asset.contentHash,
      generation,
      jobKind: SEMANTIC_TASKS.EMBEDDING,
      modelKey: profile.embedding.modelKey,
      modelVersion: profile.embedding.modelVersion,
      pipelineVersion: this.pipelineVersion,
      maxAttempts: this.maxAttempts,
      inputDigest: 'pending',
    });
  }

  async reconcileGeneration(projectId, generation, suppliedProfile = null) {
    const profile = effectiveProfile(this.database.getAssetSemanticProfile(projectId));
    const currentGeneration = this.database.getAssetSemanticGeneration(projectId, generation);
    if (!currentGeneration || profile.buildingGeneration !== Number(generation)) {
      return currentGeneration;
    }
    const profileMatches = stableJson(semanticProfileConfigIdentity(profile))
      === stableJson(semanticProfileConfigIdentity(currentGeneration.profileSnapshot));
    if (!profileMatches && ['building', 'ready'].includes(currentGeneration.status)) {
      try {
        return this.database.supersedeBuildingAssetSemanticGeneration(projectId, generation, {
          expectedProfileRevision: profile.revision,
          expectedGenerationRevision: currentGeneration.revision,
          code: 'asset-semantic-profile-changed',
          message: '语义配置已变化，旧索引代次已安全终止',
        });
      } catch (error) {
        if (/(?:_|-)conflict$/.test(String(error?.code || ''))) {
          return this.database.getAssetSemanticGeneration(projectId, generation);
        }
        throw error;
      }
    }
    const promoteReady = (readyGeneration) => {
      const latestProfile = effectiveProfile(this.database.getAssetSemanticProfile(projectId));
      if (latestProfile.buildingGeneration !== Number(generation)) {
        return this.database.getAssetSemanticGeneration(projectId, generation);
      }
      try {
        return this.database.promoteAssetSemanticGeneration(projectId, generation, {
          expectedProfileRevision: latestProfile.revision,
          expectedGenerationRevision: readyGeneration.revision,
        });
      } catch (error) {
        if (error?.code === 'asset_catalog_revision_conflict') {
          return this.database.getAssetSemanticGeneration(projectId, generation);
        }
        throw error;
      }
    };
    if (currentGeneration.status === 'ready') return promoteReady(currentGeneration);
    if (currentGeneration.status !== 'building') return currentGeneration;
    const status = this.database.getAssetSemanticJobStatus({ projectId, generation });
    const counts = status?.counts || {};
    const pending = Number(counts.queued || 0) + Number(counts.running || 0) + Number(counts.retrying || 0);
    if (pending > 0) return { status: 'building', counts };
    const finished = this.database.finishAssetSemanticRebuild(projectId, generation, {
      expectedProfileRevision: profile.revision,
      expectedGenerationRevision: currentGeneration.revision,
      error: Number(counts.failed || 0) || Number(counts.superseded || 0)
        ? { code: 'asset-semantic-generation-incomplete', message: '语义索引存在失败或已过期任务' }
        : null,
    });
    if (finished?.status === 'ready') {
      return promoteReady(finished);
    }
    return finished;
  }

  async rebuild(projectId, input = {}) {
    const normalizedProjectId = String(projectId || 'project-local');
    const requestKey = normalizeSemanticText(input.idempotencyKey, 160);
    if (!requestKey) throw semanticError('asset-semantic-idempotency-required', '语义索引重建必须提供幂等键');
    const previousRequest = this.database.getAssetSemanticGenerationByIdempotencyKey(normalizedProjectId, requestKey);
    if (previousRequest) {
      if (String(previousRequest.profileRevision) !== String(input.expectedRevision)) {
        throw semanticError('asset-semantic-idempotency-conflict', '语义重建幂等键已绑定其他配置 revision', previousRequest);
      }
      return { ...previousRequest, idempotent: true };
    }
    const profile = effectiveProfile(this.database.getAssetSemanticProfile(normalizedProjectId));
    if (String(profile.revision) !== String(input.expectedRevision)) {
      throw semanticError('asset-semantic-profile-revision-conflict', '语义配置 revision 已变化', { revision: profile.revision });
    }
    const enabledCapabilities = SEMANTIC_TASK_ORDER.map((task) => profile[task]).filter((entry) => entry.enabled);
    if (!enabledCapabilities.length) throw semanticError('asset-semantic-profile-disabled', '请先启用至少一项语义能力');
    for (const capability of enabledCapabilities) {
      const status = await this.worker.verifyModel(capability.modelKey, {
        signal: this.lifecycleAbortController.signal,
      });
      if (this.closed || this.lifecycleAbortController.signal.aborted) {
        throw semanticAbortError('应用正在关闭，语义索引重建已取消');
      }
      if (!status?.installed || !status?.verified) {
        throw semanticError('asset-semantic-model-not-installed', `${capability.spec.displayName} 尚未安装`);
      }
      await this.syncModelState(capability.modelKey, { status: 'installed' });
    }
    const generation = this.database.beginAssetSemanticRebuild(normalizedProjectId, {
      expectedProfileRevision: profile.revision,
      idempotencyKey: requestKey,
      createdBy: String(input.createdBy || 'local-owner'),
      enrollAssets: true,
      maximumAssets: MAX_REBUILD_ASSETS,
      maxAttempts: this.maxAttempts,
    });
    if (generation.idempotent) return generation;
    await this.reconcileGeneration(normalizedProjectId, generation.generation);
    this.schedulePump();
    return this.database.getAssetSemanticGeneration(normalizedProjectId, generation.generation);
  }

  async setProfile(projectId, patch = {}, options = {}) {
    await this.listModels();
    const current = this.database.getAssetSemanticProfile(projectId);
    const normalizedPatch = {};
    if (Object.hasOwn(patch, 'enabled')) normalizedPatch.enabled = Boolean(patch.enabled);
    for (const task of SEMANTIC_TASK_ORDER) {
      if (!patch[task] || typeof patch[task] !== 'object') continue;
      const raw = patch[task];
      const modelKey = String(raw.modelKey || current?.[task]?.modelKey || DEFAULT_SEMANTIC_MODEL_BY_TASK[task]);
      assertSemanticModelId(modelKey, task);
      const spec = getTrustedSemanticModelSpec(modelKey, task);
      const modelVersion = String(raw.modelVersion || current?.[task]?.modelVersion || spec.revision);
      if (modelVersion !== spec.revision) throw semanticError('asset-semantic-model-version-not-allowed', '语义模型版本不在固定清单中');
      normalizedPatch[task] = {
        ...(Object.hasOwn(raw, 'enabled') ? { enabled: Boolean(raw.enabled) } : {}),
        modelKey,
        modelVersion,
      };
    }
    let updated = this.database.setAssetSemanticProfile(projectId, normalizedPatch, {
      expectedRevision: options.expectedRevision,
      updatedBy: String(options.updatedBy || 'local-owner'),
    });
    const changed = stableJson(semanticProfileConfigIdentity(current)) !== stableJson(semanticProfileConfigIdentity(updated));
    if (changed && current?.buildingGeneration != null) {
      const generation = this.database.getAssetSemanticGeneration(projectId, current.buildingGeneration);
      if (generation && ['building', 'ready'].includes(generation.status)
        && updated.buildingGeneration === current.buildingGeneration) {
        try {
          const stopped = this.database.supersedeBuildingAssetSemanticGeneration(projectId, current.buildingGeneration, {
            expectedProfileRevision: updated.revision,
            expectedGenerationRevision: generation.revision,
            code: 'asset-semantic-profile-changed',
            message: '语义配置已变化，旧索引代次已安全终止',
            updatedBy: String(options.updatedBy || 'local-owner'),
          });
          updated = stopped.profile;
        } catch (error) {
          const latestProfile = this.database.getAssetSemanticProfile(projectId);
          if (!/(?:_|-)conflict$/.test(String(error?.code || ''))
            || latestProfile.buildingGeneration === current.buildingGeneration) throw error;
          updated = latestProfile;
        }
      }
    }
    this.queryEmbeddingCache.clear();
    return updated;
  }

  async syncModelState(modelId, override = {}) {
    const spec = getTrustedSemanticModelSpec(modelId);
    const workerStatus = await Promise.resolve(this.worker.getModelStatus(modelId));
    const existing = this.database.getAssetSemanticModel(modelId, spec.revision);
    if (existing?.status === 'deleting' && override.status === 'installed') {
      throw semanticError('asset-semantic-model-delete-in-progress', '模型正在删除，不能用于语义索引重建', { revision: existing.revision });
    }
    if (override.status === 'installed' && (!workerStatus?.installed || !workerStatus?.verified)) {
      throw semanticError('asset-semantic-model-not-installed', '语义模型尚未安装并校验，不能标记为已安装', { revision: existing?.revision || 0 });
    }
    const workerState = String(workerStatus?.state || '').toLowerCase();
    const scheduleColdVerification = !override.status
      && workerState === 'verifying'
      && !this.downloads.has(modelId)
      && !this.removals.has(modelId)
      && !['failed', 'deleting'].includes(existing?.status);
    const verificationTargetStatus = existing?.status === 'disabled' ? 'disabled' : 'installed';
    let status = override.status;
    let error = override.error || null;
    if (scheduleColdVerification) status = 'verifying';
    if (!status) {
      if (existing?.status === 'disabled' && workerStatus?.installed) status = 'disabled';
      else if (existing?.status === 'deleting' && this.removals.has(modelId)) status = 'deleting';
      else if (workerStatus?.installed) status = 'installed';
      else if (this.downloads.has(modelId)
        && ['downloading', 'verifying'].includes(existing?.status)
        && !['invalid', 'failed', 'cancelled'].includes(workerState)) {
        status = ['downloading', 'verifying'].includes(workerState) ? workerState : existing.status;
      }
      else if (['invalid', 'failed', 'cancelled'].includes(workerState)) {
        status = 'failed';
        error = workerStatus?.error || { code: `asset-semantic-model-${workerState}`, message: '语义模型安装无效或未完成' };
      } else if (['downloading', 'verifying'].includes(existing?.status)) {
        status = 'failed';
        error = { code: 'asset-semantic-download-interrupted', message: '上次模型下载被应用退出中断，请重新下载' };
      } else if (existing?.status === 'failed') {
        status = 'failed';
        error = {
          code: existing.errorCode || 'asset-semantic-model-failed',
          message: existing.errorMessage || '语义模型安装失败，请显式重试',
        };
      } else if (existing?.status === 'deleting') {
        status = 'not-installed';
      } else {
        status = 'not-installed';
      }
    }
    const installed = status === 'installed' || status === 'disabled';
    const activeTransfer = ['downloading', 'verifying', 'deleting'].includes(status);
    const state = {
      modelKey: modelId,
      modelVersion: spec.revision,
      capability: spec.task,
      status,
      artifactDigest: installed ? spec.weight.sha256 : (activeTransfer ? existing?.artifactDigest || null : null),
      byteSize: installed ? spec.downloadBytes : Number(override.byteSize ?? (activeTransfer ? existing?.byteSize : 0) ?? 0),
      installPath: installed
        ? path.join(this.config.ASSET_SEMANTIC_MODELS_DIR || this.worker.modelRoot || path.join(this.config.DATA_DIR, 'semantic-models'), modelId)
        : (activeTransfer ? existing?.installPath || null : null),
      error,
      downloadedBytes: installed
        ? spec.downloadBytes
        : Number(override.downloadedBytes ?? workerStatus?.downloadedBytes ?? existing?.downloadedBytes ?? 0),
      totalBytes: spec.downloadBytes || spec.weight.size,
    };
    const finalize = (persisted) => {
      if (scheduleColdVerification && persisted?.status === 'verifying') {
        this.scheduleModelVerification(modelId, verificationTargetStatus, persisted.revision);
      }
      return persisted;
    };
    if (semanticModelStateMatches(existing, state)) return finalize(existing);
    const explicitRevision = override.expectedRevision;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = attempt === 0 ? existing : this.database.getAssetSemanticModel(modelId, spec.revision);
      const expectedRevision = explicitRevision == null ? (current?.revision || 0) : explicitRevision;
      if (current?.status === 'deleting' && state.status === 'installed') {
        if (override.status === 'installed') {
          throw semanticError('asset-semantic-model-delete-in-progress', '模型正在删除，不能用于语义索引重建', { revision: current.revision });
        }
        if (this.removals.has(modelId)) return finalize(current);
      }
      if (semanticModelStateMatches(current, state)) return finalize(current);
      try {
        return finalize(this.database.setAssetSemanticModelState(state, { expectedRevision }));
      } catch (writeError) {
        if (explicitRevision != null || !isSemanticRevisionConflict(writeError) || attempt === 2) throw writeError;
      }
    }
    return finalize(this.database.getAssetSemanticModel(modelId, spec.revision));
  }

  scheduleModelVerification(modelId, targetStatus = 'installed', expectedRevision = null) {
    if (this.closed || this.downloads.has(modelId) || this.removals.has(modelId)) return null;
    const existingTask = this.modelVerifications.get(modelId);
    if (existingTask) return existingTask.promise;
    const controller = new AbortController();
    const task = { controller, promise: null, started: false };
    const operation = async () => {
      task.started = true;
      if (controller.signal.aborted || this.closed) return null;
      try {
        const verified = await this.worker.verifyModel(modelId, { signal: controller.signal });
        if (!verified?.installed || !verified?.verified) {
          throw semanticError('asset-semantic-model-not-installed', '语义模型尚未安装或校验失败');
        }
        if (this.closed || controller.signal.aborted || this.downloads.has(modelId) || this.removals.has(modelId)) return null;
        const spec = getTrustedSemanticModelSpec(modelId);
        const current = this.database.getAssetSemanticModel(modelId, spec.revision);
        if (!current || current.status !== 'verifying' || Number(current.revision) !== Number(expectedRevision)) return current;
        return await this.syncModelState(modelId, {
          status: targetStatus === 'disabled' ? 'disabled' : 'installed',
          downloadedBytes: spec.downloadBytes || spec.weight.size,
          error: null,
          expectedRevision: current.revision,
        });
      } catch (verificationError) {
        if (this.closed || controller.signal.aborted || verificationError?.name === 'AbortError') return null;
        const safe = sanitizeSemanticError(verificationError);
        try {
          const spec = getTrustedSemanticModelSpec(modelId);
          const current = this.database.getAssetSemanticModel(modelId, spec.revision);
          if (!current || current.status !== 'verifying' || Number(current.revision) !== Number(expectedRevision)
            || this.downloads.has(modelId) || this.removals.has(modelId)) return current;
          return await this.syncModelState(modelId, {
            status: 'failed',
            downloadedBytes: Number(this.worker.getDownloadProgress(modelId)?.downloadedBytes || current.downloadedBytes || 0),
            error: safe,
            expectedRevision: current.revision,
          });
        } catch (persistenceError) {
          console.warn('[asset-semantic] model verification state update failed:', sanitizeSemanticError(persistenceError).message);
          return null;
        }
      }
    };
    const promise = this.modelVerificationTail.then(operation, operation).finally(() => {
      const currentTask = this.modelVerifications.get(modelId);
      if (currentTask?.promise === promise) this.modelVerifications.delete(modelId);
    });
    task.promise = promise;
    this.modelVerificationTail = promise.catch(() => {});
    this.modelVerifications.set(modelId, task);
    promise.catch(() => {});
    return promise;
  }

  cancelModelVerification(modelId) {
    const current = this.modelVerifications.get(modelId);
    if (!current) return null;
    current?.controller.abort();
    if (!current.started) return null;
    return current.promise.catch(() => {});
  }

  async listModels() {
    const result = [];
    for (const model of getPublicSemanticModelManifest()) {
      const persisted = await this.syncModelState(model.modelId);
      const progress = await Promise.resolve(this.worker.getDownloadProgress(model.modelId));
      result.push({
        ...model,
        version: model.revision,
        status: persisted.status,
        installed: persisted.status === 'installed',
        revision: persisted.revision,
        downloadedBytes: Number(progress?.downloadedBytes ?? persisted.downloadedBytes ?? 0),
        totalBytes: Number(progress?.totalBytes ?? model.downloadBytes),
        error: persisted.errorMessage || null,
        updatedAt: persisted.updatedAt,
      });
    }
    return result;
  }

  async startModelDownload(modelId, input = {}) {
    assertSemanticModelId(modelId);
    const spec = getTrustedSemanticModelSpec(modelId);
    const requestKey = normalizeSemanticText(input.idempotencyKey, 160);
    if (!requestKey) throw semanticError('asset-semantic-idempotency-required', '语义模型下载必须提供幂等键');
    const requestRevision = Math.trunc(Number(input.expectedRevision));
    if (!Number.isInteger(requestRevision) || requestRevision < 1) {
      throw semanticError('asset-semantic-model-revision-invalid', '模型安装状态 expectedRevision 必须为正整数');
    }
    const assertNotDeleting = (candidate) => {
      if (this.removals.has(modelId) || candidate?.status === 'deleting') {
        throw semanticError('asset-semantic-model-delete-in-progress', '模型正在删除，不能同时启动下载', {
          revision: candidate?.revision || requestRevision,
        });
      }
    };
    const replayPersistedDownload = async (candidate) => {
      assertNotDeleting(candidate);
      if (!candidate || candidate.downloadIdempotencyKey !== requestKey) return null;
      if (candidate.downloadRequestRevision !== requestRevision) {
        throw semanticError('asset-semantic-idempotency-conflict', '模型下载幂等键已绑定其他状态 revision', {
          revision: candidate.revision,
        });
      }
      const synchronized = await this.syncModelState(modelId);
      assertNotDeleting(synchronized);
      return synchronized;
    };
    const persistedReplay = await replayPersistedDownload(
      this.database.getAssetSemanticModel(modelId, spec.revision),
    );
    if (persistedReplay) return persistedReplay;
    const current = await this.syncModelState(modelId);
    assertNotDeleting(current);
    const synchronizedReplay = await replayPersistedDownload(current);
    if (synchronizedReplay) return synchronizedReplay;
    const inflight = this.downloads.get(modelId);
    if (inflight) {
      const concurrentReplay = await replayPersistedDownload(
        this.database.getAssetSemanticModel(modelId, spec.revision),
      );
      if (concurrentReplay) return concurrentReplay;
      throw semanticError('asset-semantic-model-download-in-progress', '该模型正在下载');
    }
    if (current.revision !== requestRevision) {
      throw semanticError('asset-semantic-model-revision-conflict', '模型安装状态 revision 已变化', { revision: current.revision });
    }
    if (current.status === 'installed') return current;
    const verificationCancellation = this.cancelModelVerification(modelId);
    if (verificationCancellation) await verificationCancellation;
    const concurrentAfterVerification = this.downloads.get(modelId);
    if (concurrentAfterVerification) {
      const concurrentReplay = await replayPersistedDownload(
        this.database.getAssetSemanticModel(modelId, spec.revision),
      );
      if (concurrentReplay) return concurrentReplay;
      throw semanticError('asset-semantic-model-download-in-progress', '该模型正在下载');
    }
    const downloading = this.database.setAssetSemanticModelState({
      modelKey: modelId,
      modelVersion: spec.revision,
      capability: spec.task,
      status: 'downloading',
      byteSize: 0,
      downloadedBytes: 0,
      totalBytes: spec.downloadBytes || spec.weight.size,
      downloadIdempotencyKey: requestKey,
      downloadRequestRevision: requestRevision,
    }, { expectedRevision: current.revision });
    let lastProgressWrite = 0;
    const operation = {
      token: Symbol(`asset-semantic-download:${modelId}`),
      requestKey,
      requestRevision,
      controller: new AbortController(),
      promise: null,
    };
    this.downloads.set(modelId, operation);
    const onProgress = (progress) => {
        const progressState = String(progress?.state || progress?.phase || '').toLowerCase();
        if (!['downloading', 'verifying'].includes(progressState)) return;
        const now = Date.now();
        if (now - lastProgressWrite < MODEL_PROGRESS_WRITE_INTERVAL_MS && Number(progress?.downloadedBytes) < (spec.downloadBytes || spec.weight.size)) return;
        lastProgressWrite = now;
        const persistProgress = async () => {
          if (this.closed || this.downloads.get(modelId) !== operation) return;
          const currentState = this.database.getAssetSemanticModel(modelId, spec.revision);
          if (!currentState
            || !['downloading', 'verifying'].includes(currentState.status)
            || currentState.downloadIdempotencyKey !== requestKey
            || Number(currentState.downloadRequestRevision) !== requestRevision) return;
          await this.syncModelState(modelId, {
            status: progressState,
            downloadedBytes: Math.max(0, Number(progress?.downloadedBytes) || 0),
            expectedRevision: currentState.revision,
          });
        };
        void persistProgress().catch(() => {});
      };
    let workerDownload;
    try {
      workerDownload = Promise.resolve(this.worker.downloadModel(modelId, {
        onProgress,
        signal: combineAbortSignals(operation.controller.signal, this.lifecycleAbortController.signal),
      }));
    } catch (error) {
      workerDownload = Promise.reject(error);
    }
    const promise = workerDownload.then(async () => {
      if (this.closed || this.downloads.get(modelId) !== operation) return this.database.getAssetSemanticModel(modelId, spec.revision);
      return this.syncModelState(modelId, {
        status: 'installed',
        downloadedBytes: spec.downloadBytes || spec.weight.size,
        error: null,
      });
    }).catch(async (error) => {
      const safe = sanitizeSemanticError(error);
      if (!this.closed && this.downloads.get(modelId) === operation) {
        await this.syncModelState(modelId, {
          status: 'failed',
          downloadedBytes: Number(this.worker.getDownloadProgress(modelId)?.downloadedBytes || 0),
          error: safe,
        }).catch(() => {});
      }
      throw error;
    }).finally(() => {
      if (this.downloads.get(modelId) === operation) this.downloads.delete(modelId);
    });
    operation.promise = promise;
    promise.catch((error) => console.warn(`[asset-semantic] model download ${modelId} failed:`, sanitizeSemanticError(error).message));
    return downloading;
  }

  async removeModel(modelId, input = {}) {
    assertSemanticModelId(modelId);
    const spec = getTrustedSemanticModelSpec(modelId);
    const current = await this.syncModelState(modelId);
    if (String(current.revision) !== String(input.expectedRevision)) {
      throw semanticError('asset-semantic-model-revision-conflict', '模型安装状态 revision 已变化', { revision: current.revision });
    }
    if (this.downloads.has(modelId)) throw semanticError('asset-semantic-model-download-in-progress', '模型下载期间不能删除');
    const verificationCancellation = this.cancelModelVerification(modelId);
    if (verificationCancellation) await verificationCancellation;
    this.database.beginAssetSemanticModelDelete(modelId, spec.revision, {
      expectedRevision: current.revision,
      now: Date.now(),
    });
    this.removals.add(modelId);
    try {
      await this.worker.removeModel(modelId);
      this.queryEmbeddingCache.clear();
      return await this.syncModelState(modelId, { status: 'not-installed', downloadedBytes: 0, error: null });
    } catch (error) {
      const safe = sanitizeSemanticError(error);
      await this.syncModelState(modelId, {
        status: 'failed',
        downloadedBytes: current.downloadedBytes,
        error: safe,
      }).catch(() => {});
      throw error;
    } finally {
      this.removals.delete(modelId);
    }
  }

  async status(projectId) {
    const profile = effectiveProfile(this.database.getAssetSemanticProfile(projectId));
    const models = await this.listModels();
    const active = profile.activeGeneration > 0
      ? this.database.getAssetSemanticGeneration(projectId, profile.activeGeneration)
      : null;
    const building = profile.buildingGeneration != null
      ? this.database.getAssetSemanticGeneration(projectId, profile.buildingGeneration)
      : null;
    const latest = this.database.listAssetSemanticGenerations(projectId, { limit: 1 })[0] || null;
    const failedGeneration = !building
      && latest?.status === 'failed'
      && latest.generation !== active?.generation
      ? latest
      : null;
    const generation = building?.generation || failedGeneration?.generation || active?.generation || null;
    const jobs = this.database.getAssetSemanticJobStatus({
      projectId,
      ...(generation ? { generation } : {}),
    });
    const catalogRevision = this.database.getAssetCatalogRevision(projectId);
    return {
      projectId: String(projectId),
      profile,
      models,
      jobs,
      activeGenerationRecord: active,
      building,
      failedGeneration,
      currentCatalogRevision: catalogRevision,
      indexStale: Boolean(active && String(active.catalogRevision) !== String(catalogRevision)),
      workerActive: this.active,
      concurrency: this.concurrency,
      recovery: this.recovery,
    };
  }

  async queryEmbedding(modelKey, modelVersion, query, signal) {
    const normalized = normalizeSemanticText(query, MAX_QUERY_TEXT);
    if (!normalized) throw semanticError('asset-semantic-query-empty', '请输入自然语言检索内容');
    const cacheKey = sha256(stableJson([modelKey, modelVersion, normalized]));
    if (this.queryEmbeddingCache.has(cacheKey)) {
      const value = this.queryEmbeddingCache.get(cacheKey);
      this.queryEmbeddingCache.delete(cacheKey);
      this.queryEmbeddingCache.set(cacheKey, value);
      return { embedding: value, queryDigest: sha256(normalized) };
    }
    const result = await this.worker.execute({ modelId: modelKey, task: SEMANTIC_TASKS.EMBEDDING, text: normalized }, {
      signal: combineAbortSignals(signal, this.lifecycleAbortController.signal),
      timeoutMs: this.jobTimeoutMs,
    });
    if (this.closed || this.lifecycleAbortController.signal.aborted) {
      throw semanticAbortError('应用正在关闭，语义检索已取消');
    }
    const embedding = Array.isArray(result?.embedding)
      ? result.embedding
      : (Array.isArray(result?.vector) ? result.vector : []);
    if (!embedding.length) throw semanticError('asset-semantic-query-embedding-empty', '查询向量生成失败');
    this.queryEmbeddingCache.set(cacheKey, embedding);
    while (this.queryEmbeddingCache.size > 32) this.queryEmbeddingCache.delete(this.queryEmbeddingCache.keys().next().value);
    return { embedding, queryDigest: sha256(normalized) };
  }

  async search(projectId, input = {}, options = {}) {
    const profile = effectiveProfile(this.database.getAssetSemanticProfile(projectId));
    if (!profile.embedding.enabled || profile.activeGeneration <= 0) {
      throw semanticError('asset-semantic-unavailable', '当前项目没有可用的 Embedding 索引');
    }
    const catalogRevision = this.database.getAssetCatalogRevision(projectId);
    const expectedCatalogRevision = input.expectedCatalogRevision ?? catalogRevision;
    const expectedProfileRevision = input.expectedProfileRevision ?? profile.revision;
    const expectedGeneration = input.expectedGeneration ?? profile.activeGeneration;
    if (Number(expectedCatalogRevision) !== Number(catalogRevision)) {
      throw semanticError('asset_catalog_revision_conflict', '素材目录版本已变化', { catalogRevision });
    }
    if (Number(expectedProfileRevision) !== Number(profile.revision)) {
      throw semanticError('asset_semantic_profile_revision_conflict', '语义配置版本已变化', profile);
    }
    if (Number(expectedGeneration) !== Number(profile.activeGeneration)) {
      throw semanticError('asset_semantic_generation_conflict', '激活的语义索引代次已变化', {
        generation: profile.activeGeneration,
      });
    }
    const modelStatus = await Promise.resolve(this.worker.getModelStatus(profile.embedding.modelKey));
    if (!modelStatus?.installed) throw semanticError('asset-semantic-model-not-installed', 'Embedding 模型尚未安装');
    const active = this.database.getAssetSemanticGeneration(projectId, profile.activeGeneration);
    if (!active || !['ready', 'active'].includes(active.status)) throw semanticError('asset-semantic-unavailable', '当前项目没有成功的语义索引代次');
    const query = normalizeSemanticText(input.query, MAX_QUERY_TEXT);
    const { embedding, queryDigest } = await this.queryEmbedding(profile.embedding.modelKey, profile.embedding.modelVersion, query, options.signal);
    const result = this.database.searchAssetSemantics(projectId, {
      query,
      queryEmbedding: embedding,
      modelKey: profile.embedding.modelKey,
      modelVersion: profile.embedding.modelVersion,
      generation: profile.activeGeneration,
      filters: input.filters || {},
      limit: Math.min(120, Math.max(1, Number(input.limit) || 120)),
      offset: Math.max(0, Number(input.offset) || 0),
      expectedCatalogRevision,
      expectedProfileRevision,
      expectedGeneration,
    });
    return {
      ...result,
      queryDigest,
      semanticIndexRevision: active.revision || `${profile.activeGeneration}:${active.updatedAt || active.createdAt || 0}`,
      activeGeneration: profile.activeGeneration,
      modelKey: profile.embedding.modelKey,
      modelVersion: profile.embedding.modelVersion,
      stale: String(active.catalogRevision) !== String(result.catalogRevision),
    };
  }

  retryJob(jobId, input = {}) {
    const job = this.database.getAssetSemanticJob(jobId);
    if (!job || (input.projectId && job.projectId !== input.projectId)) throw semanticError('asset-semantic-job-not-found', '语义任务不存在');
    if (String(job.revision) !== String(input.expectedRevision)) {
      throw semanticError('asset-semantic-job-revision-conflict', '语义任务 revision 已变化', { revision: job.revision });
    }
    const retried = this.database.retryAssetSemanticJob(job.projectId, job.id, {
      expectedRevision: job.revision,
      now: Date.now(),
    });
    this.schedulePump();
    return retried ? [retried] : [];
  }

  async waitForIdle(timeoutMs = 30_000) {
    const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 30_000);
    while (Date.now() < deadline) {
      const counts = this.database.getAssetSemanticJobStatus().counts || {};
      const pending = Number(counts.queued || 0) + Number(counts.running || 0) + Number(counts.retrying || 0);
      if (this.active === 0 && !pending) {
        const sweep = await this.reconcileIdleGenerations();
        const afterCounts = this.database.getAssetSemanticJobStatus().counts || {};
        const afterPending = Number(afterCounts.queued || 0) + Number(afterCounts.running || 0) + Number(afterCounts.retrying || 0);
        if (!afterPending
          && sweep.failures === 0
          && !sweep.cleanup?.hasMore
          && this.database.listBuildingAssetSemanticGenerations({ limit: 1 }).length === 0) return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  close() {
    this.closed = true;
    this.lifecycleAbortController.abort();
    for (const download of this.downloads.values()) download.controller?.abort();
    for (const verification of this.modelVerifications.values()) verification.controller.abort();
    if (this.pumpHandle) {
      clearTimeout(this.pumpHandle);
      clearImmediate(this.pumpHandle);
      this.pumpHandle = null;
    }
    this.worker.close();
  }
}

let singleton = null;

function getAssetSemanticPipeline(config, database) {
  if (!singleton) singleton = new AssetSemanticPipeline(config, database);
  return singleton;
}

module.exports = {
  AssetSemanticPipeline,
  buildAssetSemanticText,
  createSemanticImageSnapshot,
  effectiveProfile,
  getAssetSemanticPipeline,
  isRetryableSemanticError,
  isSkippableVisionSourceError,
  normalizeSemanticText,
  resolveVerifiedVideoPreview,
  sanitizeSemanticError,
  semanticError,
};
