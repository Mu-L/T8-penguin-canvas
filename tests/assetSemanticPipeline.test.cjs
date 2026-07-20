const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const {
  AssetSemanticPipeline,
  isSkippableVisionSourceError,
  resolveVerifiedVideoPreview,
} = require('../backend/src/services/assetSemanticPipeline');
const {
  getPublicSemanticModel,
  getPublicSemanticModelManifest,
} = require('../backend/src/services/assetSemanticModels');

function installedStatus(modelId) {
  const model = getPublicSemanticModel(modelId);
  return {
    ...model,
    installed: true,
    verified: true,
    state: 'installed',
    downloadedBytes: model.downloadBytes,
    totalBytes: model.downloadBytes,
    percent: 100,
  };
}

function notInstalledStatus(modelId) {
  const model = getPublicSemanticModel(modelId);
  return {
    ...model,
    installed: false,
    verified: false,
    state: 'not-installed',
    downloadedBytes: 0,
    totalBytes: model.downloadBytes,
    percent: 0,
  };
}

class FakeSemanticWorker {
  constructor() {
    this.downloadCalls = 0;
    this.embeddingTexts = [];
    this.taskCalls = [];
    this.nextFailures = new Map();
    this.removedModels = new Set();
    this.closed = false;
  }

  getModelStatus(modelId) {
    return this.removedModels.has(modelId) ? notInstalledStatus(modelId) : installedStatus(modelId);
  }
  getDownloadProgress(modelId) { return this.getModelStatus(modelId); }
  verifyModel(modelId) {
    const status = this.getModelStatus(modelId);
    if (!status.installed) {
      const error = new Error('test model is not installed');
      error.code = 'asset-semantic-model-not-installed';
      return Promise.reject(error);
    }
    return Promise.resolve(status);
  }
  downloadModel() { this.downloadCalls += 1; throw new Error('test must never auto-download'); }
  removeModel(modelId) {
    this.removedModels.add(modelId);
    return Promise.resolve({ ...notInstalledStatus(modelId), removed: true });
  }

  failNext(task, code = 'asset-semantic-model-not-installed') {
    this.nextFailures.set(task, code);
  }

  async execute(input) {
    this.taskCalls.push(input.task);
    if (this.nextFailures.has(input.task)) {
      const code = this.nextFailures.get(input.task);
      this.nextFailures.delete(input.task);
      const error = new Error(`${input.task} terminal fixture failure`);
      error.code = code;
      throw error;
    }
    if (input.task === 'caption') return { text: 'a red cat on a poster', language: 'en' };
    if (input.task === 'ocr') return { text: 'SUMMER SALE', lines: ['SUMMER SALE'], language: 'en' };
    this.embeddingTexts.push(input.text);
    const vector = new Array(384).fill(0);
    vector[0] = 1;
    return { vector, dimension: 384 };
  }

  close() { this.closed = true; }
}

class InterruptedDownloadWorker {
  constructor() {
    this.downloadCalls = 0;
    this.closed = false;
  }

  getModelStatus(modelId) {
    const model = getPublicSemanticModel(modelId);
    return {
      ...model,
      installed: false,
      verified: false,
      state: 'not-installed',
      downloadedBytes: 0,
      totalBytes: model.downloadBytes,
      percent: 0,
    };
  }

  getDownloadProgress(modelId) { return this.getModelStatus(modelId); }
  downloadModel() {
    this.downloadCalls += 1;
    return new Promise(() => {});
  }
  removeModel(modelId) { return Promise.resolve(this.getModelStatus(modelId)); }
  close() { this.closed = true; }
}

class ColdVerificationWorker extends FakeSemanticWorker {
  constructor(failingModelId) {
    super();
    this.failingModelId = failingModelId;
    this.verifiedModels = new Set();
    this.verifyCalls = [];
  }

  getModelStatus(modelId) {
    if (this.verifiedModels.has(modelId)) return installedStatus(modelId);
    const model = getPublicSemanticModel(modelId);
    return {
      ...model,
      installed: false,
      verified: false,
      state: 'verifying',
      downloadedBytes: model.downloadBytes,
      totalBytes: model.downloadBytes,
      percent: 99,
    };
  }

  async verifyModel(modelId) {
    this.verifyCalls.push(modelId);
    if (modelId === this.failingModelId) {
      const error = new Error('cold model digest mismatch');
      error.code = 'asset-semantic-model-hash-mismatch';
      throw error;
    }
    this.verifiedModels.add(modelId);
    return installedStatus(modelId);
  }
}

class GatedColdVerificationWorker extends ColdVerificationWorker {
  constructor(failingModelId = null) {
    super(failingModelId);
    this.verificationGates = new Map();
  }

  verifyModel(modelId, options = {}) {
    this.verifyCalls.push(modelId);
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      const finish = (callback) => {
        signal?.removeEventListener('abort', onAbort);
        this.verificationGates.delete(modelId);
        callback();
      };
      const onAbort = () => finish(() => {
        const error = new Error('cold verification aborted');
        error.name = 'AbortError';
        reject(error);
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.verificationGates.set(modelId, {
        release: () => finish(() => {
          if (modelId === this.failingModelId) {
            const error = new Error('cold model digest mismatch');
            error.code = 'asset-semantic-model-hash-mismatch';
            reject(error);
            return;
          }
          this.verifiedModels.add(modelId);
          resolve(installedStatus(modelId));
        }),
      });
    });
  }

  releaseVerification(modelId) {
    this.verificationGates.get(modelId)?.release();
  }

  downloadModel(modelId) {
    this.downloadCalls += 1;
    this.verifiedModels.add(modelId);
    return Promise.resolve(installedStatus(modelId));
  }
}

class DelayedRemovalWorker extends FakeSemanticWorker {
  constructor() {
    super();
    this.removeCalls = 0;
    this.removeStarted = new Promise((resolve) => { this.resolveRemoveStarted = resolve; });
    this.removeRelease = new Promise((resolve) => { this.resolveRemoveRelease = resolve; });
  }

  async removeModel(modelId) {
    this.removeCalls += 1;
    this.resolveRemoveStarted();
    await this.removeRelease;
    return super.removeModel(modelId);
  }
}

class LateProgressDownloadWorker extends FakeSemanticWorker {
  constructor() {
    super();
    this.downloadedModels = new Set();
    this.progressCallbacks = new Map();
    this.downloadResolvers = new Map();
  }

  getModelStatus(modelId) {
    return this.downloadedModels.has(modelId) ? installedStatus(modelId) : notInstalledStatus(modelId);
  }

  downloadModel(modelId, options = {}) {
    this.downloadCalls += 1;
    this.progressCallbacks.set(modelId, options.onProgress);
    return new Promise((resolve) => {
      this.downloadResolvers.set(modelId, () => {
        this.downloadedModels.add(modelId);
        resolve(installedStatus(modelId));
      });
    });
  }

  emitProgress(modelId, progress) {
    this.progressCallbacks.get(modelId)?.(progress);
  }

  resolveDownload(modelId) {
    this.downloadResolvers.get(modelId)?.();
  }
}

class AbortableRebuildVerificationWorker extends FakeSemanticWorker {
  constructor() {
    super();
    this.verifyStarted = null;
    this.resolveVerifyStarted = null;
    this.verifyStarted = new Promise((resolve) => { this.resolveVerifyStarted = resolve; });
    this.observedSignal = null;
  }

  verifyModel(modelId, options = {}) {
    this.observedSignal = options.signal || null;
    this.resolveVerifyStarted();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const error = new Error('rebuild verification aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

class AbortableDownloadWorker extends InterruptedDownloadWorker {
  constructor() {
    super();
    this.observedSignal = null;
    this.downloadStarted = new Promise((resolve) => { this.resolveDownloadStarted = resolve; });
  }

  downloadModel(modelId, options = {}) {
    this.downloadCalls += 1;
    this.observedSignal = options.signal || null;
    this.resolveDownloadStarted();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const error = new Error('download aborted by pipeline close');
        error.name = 'AbortError';
        reject(error);
      };
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function testConfig(root) {
  return {
    BASE_DIR: path.resolve(__dirname, '..'),
    DATA_DIR: path.join(root, 'data'),
    THUMBNAILS_DIR: path.join(root, 'thumbnails'),
    ASSET_SEMANTIC_MODELS_DIR: path.join(root, 'semantic-models'),
    ASSET_SEMANTIC_WORK_DIR: path.join(root, 'semantic-work'),
    ASSET_SEMANTIC_SNAPSHOTS_DIR: path.join(root, 'semantic-work', 'snapshots'),
    ASSET_SEMANTIC_MAX_ATTEMPTS: 3,
    ASSET_SEMANTIC_RETRY_BASE_MS: 100,
    ASSET_SEMANTIC_JOB_TIMEOUT_MS: 30_000,
    ASSET_SEMANTIC_PIPELINE_VERSION: 'asset-semantic-test-v1',
  };
}

function finishReadyGeneration(database, projectId, idempotencyKey) {
  const profile = database.getAssetSemanticProfile(projectId);
  const generation = database.beginAssetSemanticRebuild(projectId, {
    expectedProfileRevision: profile.revision,
    idempotencyKey,
    createdBy: 'ready-recovery-test',
  });
  const buildingProfile = database.getAssetSemanticProfile(projectId);
  const sealed = database.sealAssetSemanticRebuild(projectId, generation.generation, {
    expectedProfileRevision: buildingProfile.revision,
    expectedGenerationRevision: generation.revision,
  });
  return database.finishAssetSemanticRebuild(projectId, generation.generation, {
    expectedProfileRevision: buildingProfile.revision,
    expectedGenerationRevision: sealed.revision,
  });
}

test('pipeline persists an opt-in caption/OCR/embedding rebuild and searches the promoted project generation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-pipeline-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const worker = new FakeSemanticWorker();
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker,
    autoStart: false,
    recover: false,
  });
  try {
    const sourcePath = path.join(root, 'red-cat.png');
    const sourceBytes = Buffer.from('bounded semantic test fixture');
    fs.writeFileSync(sourcePath, sourceBytes);
    const contentHash = crypto.createHash('sha256').update(sourceBytes).digest('hex');
    database.upsertAsset({
      id: 'asset-red-cat',
      projectId: 'project-semantic-a',
      kind: 'image',
      mimeType: 'image/png',
      filename: 'red-cat.png',
      managedPath: sourcePath,
      storageMode: 'linked',
      availability: 'available',
      contentHash,
      contentHashVerification: 'verified',
      tags: ['poster'],
      metadata: { width: 640, height: 480, health: 'healthy' },
    });

    const initial = await pipeline.status('project-semantic-a');
    assert.equal(initial.profile.revision, 0);
    assert.equal(worker.downloadCalls, 0, 'reading status must never download an optional model');
    assert.equal(initial.models.length, 3);
    assert.equal(initial.models.every((model) => model.status === 'installed'), true);

    const models = Object.fromEntries(getPublicSemanticModelManifest().map((model) => [model.task, model]));
    const profile = await pipeline.setProfile('project-semantic-a', {
      enabled: true,
      caption: { enabled: true, modelKey: models.caption.modelId, modelVersion: models.caption.revision },
      ocr: { enabled: true, modelKey: models.ocr.modelId, modelVersion: models.ocr.revision },
      embedding: { enabled: true, modelKey: models.embedding.modelId, modelVersion: models.embedding.revision },
    }, { expectedRevision: 0, updatedBy: 'test-owner' });
    assert.equal(profile.revision, 1);

    const generation = await pipeline.rebuild('project-semantic-a', {
      expectedRevision: profile.revision,
      idempotencyKey: 'semantic-rebuild/project-semantic-a/request-1',
      createdBy: 'test-owner',
    });
    assert.equal(generation.status, 'building');
    pipeline.schedulePump();
    assert.equal(await pipeline.waitForIdle(10_000), true);

    const activeProfile = database.getAssetSemanticProfile('project-semantic-a');
    const activeGeneration = database.getAssetSemanticGeneration('project-semantic-a', activeProfile.activeGeneration);
    assert.equal(activeGeneration.status, 'active');
    assert.equal(activeProfile.buildingGeneration, null);
    assert.equal(activeGeneration.catalogRevision, database.getAssetCatalogRevision('project-semantic-a'));
    assert.deepEqual(activeGeneration.counts, {
      queued: 0, running: 0, retrying: 0, succeeded: 3, skipped: 0, failed: 0, superseded: 0, total: 3,
    });
    assert.match(worker.embeddingTexts[0], /caption: a red cat on a poster/);
    assert.match(worker.embeddingTexts[0], /ocr: SUMMER SALE/);

    const result = await pipeline.search('project-semantic-a', {
      query: 'red cat poster',
      expectedCatalogRevision: activeGeneration.catalogRevision,
      expectedProfileRevision: activeProfile.revision,
      expectedGeneration: activeProfile.activeGeneration,
    });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].asset.id, 'asset-red-cat');
    assert.equal(result.scoreMetric, 'rrf-k60');
    assert.equal(result.stale, false);
    assert.equal(result.activeGeneration, activeProfile.activeGeneration);
    assert.equal(Object.hasOwn(result.items[0], 'embedding'), false);
    assert.equal(Object.hasOwn(result.items[0], 'vector'), false);
    assert.equal(worker.embeddingTexts.at(-1), 'red cat poster');

    const status = await pipeline.status('project-semantic-a');
    assert.equal(status.indexStale, false);
    assert.equal(status.activeGenerationRecord.status, 'active');

    const duplicate = await pipeline.rebuild('project-semantic-a', {
      expectedRevision: profile.revision,
      idempotencyKey: 'semantic-rebuild/project-semantic-a/request-1',
      createdBy: 'test-owner',
    });
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.generation, activeProfile.activeGeneration);
    assert.equal(database.listAssetSemanticGenerations('project-semantic-a').length, 1);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(worker.closed, true);
});

test('pipeline rejects catalog drift at promotion, reports the failed replacement and keeps the old active searchable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-catalog-cas-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const worker = new FakeSemanticWorker();
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker,
    autoStart: false,
    recover: false,
  });
  const projectId = 'project-semantic-catalog-cas';
  try {
    const model = getPublicSemanticModelManifest().find((candidate) => candidate.task === 'embedding');
    const stableAsset = database.upsertAsset({
      id: 'catalog-cas-stable',
      projectId,
      kind: 'image',
      mimeType: 'image/png',
      filename: 'catalog-cas-stable.png',
      storageMode: 'managed',
      availability: 'available',
      contentHash: crypto.createHash('sha256').update('catalog-cas-stable').digest('hex'),
      contentHashVerification: 'verified',
      metadata: { description: 'stable searchable asset' },
    });
    let profile = await pipeline.setProfile(projectId, {
      enabled: true,
      caption: { enabled: false },
      ocr: { enabled: false },
      embedding: { enabled: true, modelKey: model.modelId, modelVersion: model.revision },
    }, { expectedRevision: 0, updatedBy: 'catalog-cas-test' });

    const first = await pipeline.rebuild(projectId, {
      expectedRevision: profile.revision,
      idempotencyKey: 'catalog-cas/generation-1',
      createdBy: 'catalog-cas-test',
    });
    assert.equal(first.status, 'building');
    assert.equal(await pipeline.waitForIdle(10_000), true);
    profile = database.getAssetSemanticProfile(projectId);
    const firstActiveGeneration = profile.activeGeneration;
    assert.equal(database.getAssetSemanticGeneration(projectId, firstActiveGeneration).status, 'active');

    const replacement = await pipeline.rebuild(projectId, {
      expectedRevision: profile.revision,
      idempotencyKey: 'catalog-cas/generation-2',
      createdBy: 'catalog-cas-test',
    });
    assert.equal(replacement.status, 'building');
    database.upsertAsset({
      id: 'catalog-cas-added-during-rebuild',
      projectId,
      kind: 'image',
      mimeType: 'image/png',
      filename: 'added-during-rebuild.png',
      storageMode: 'managed',
      availability: 'available',
      contentHash: crypto.createHash('sha256').update('added-during-rebuild').digest('hex'),
      contentHashVerification: 'verified',
    });
    assert.equal(await pipeline.waitForIdle(10_000), true);

    const status = await pipeline.status(projectId);
    assert.equal(status.activeGenerationRecord.generation, firstActiveGeneration);
    assert.equal(status.activeGenerationRecord.status, 'active');
    assert.equal(status.building, null);
    assert.equal(status.failedGeneration.generation, replacement.generation);
    assert.equal(status.failedGeneration.status, 'failed');
    assert.equal(status.failedGeneration.errorCode, 'asset_catalog_revision_conflict');
    assert.equal(status.indexStale, true);
    assert.equal(status.jobs.counts.succeeded, 0, 'non-retryable catalog-conflict payload is pruned after terminal reconciliation');
    assert.ok(status.failedGeneration.payloadPrunedAt > 0);
    assert.equal(status.failedGeneration.expectedJobCount, 1, 'historical enrollment metadata remains after payload pruning');

    const retainedSearch = await pipeline.search(projectId, {
      query: 'stable searchable asset',
      expectedCatalogRevision: status.currentCatalogRevision,
      expectedProfileRevision: status.profile.revision,
      expectedGeneration: firstActiveGeneration,
    });
    assert.equal(retainedSearch.items.some((item) => item.asset.id === stableAsset.id), true);
    assert.equal(retainedSearch.stale, true);
    assert.equal(database.getAssetSemanticGeneration(projectId, replacement.generation).status, 'failed');
    assert.equal(database.getAssetSemanticGeneration(projectId, firstActiveGeneration).status, 'active');
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(worker.closed, true);
});

test('retrying a failed vision dependency invalidates and recomputes embedding before promotion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-dependency-retry-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const worker = new FakeSemanticWorker();
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker,
    autoStart: false,
    recover: false,
  });
  const projectId = 'project-semantic-dependency-retry';
  try {
    const sourcePath = path.join(root, 'dependency-retry.png');
    const sourceBytes = Buffer.from('dependency retry semantic fixture');
    fs.writeFileSync(sourcePath, sourceBytes);
    const asset = database.upsertAsset({
      id: 'dependency-retry-asset',
      projectId,
      kind: 'image',
      mimeType: 'image/png',
      filename: 'dependency-retry.png',
      managedPath: sourcePath,
      storageMode: 'linked',
      availability: 'available',
      contentHash: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
      contentHashVerification: 'verified',
    });
    const models = Object.fromEntries(getPublicSemanticModelManifest().map((model) => [model.task, model]));
    const profile = await pipeline.setProfile(projectId, {
      enabled: true,
      caption: { enabled: true, modelKey: models.caption.modelId, modelVersion: models.caption.revision },
      ocr: { enabled: true, modelKey: models.ocr.modelId, modelVersion: models.ocr.revision },
      embedding: { enabled: true, modelKey: models.embedding.modelId, modelVersion: models.embedding.revision },
    }, { expectedRevision: 0, updatedBy: 'dependency-retry-test' });

    worker.failNext('caption');
    const generation = await pipeline.rebuild(projectId, {
      expectedRevision: profile.revision,
      idempotencyKey: 'dependency-retry/generation-1',
      createdBy: 'dependency-retry-test',
    });
    assert.equal(await pipeline.waitForIdle(10_000), true);
    const failedStatus = await pipeline.status(projectId);
    assert.equal(failedStatus.profile.activeGeneration, null);
    assert.equal(failedStatus.profile.buildingGeneration, null);
    assert.equal(failedStatus.failedGeneration.generation, generation.generation);
    assert.equal(failedStatus.failedGeneration.status, 'failed');
    assert.equal(worker.embeddingTexts.length, 0, 'embedding must not run with a failed visual dependency');

    const failedJobs = database.listAssetSemanticJobs({ projectId, generation: generation.generation, limit: 20 });
    const failedCaption = failedJobs.find((job) => job.jobKind === 'caption');
    const invalidatedEmbedding = failedJobs.find((job) => job.jobKind === 'embedding');
    assert.equal(failedCaption.status, 'failed');
    assert.equal(invalidatedEmbedding.status, 'failed');
    assert.equal(invalidatedEmbedding.errorCode, 'semantic-dependency-failed');
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM asset_semantic_embeddings
      WHERE project_id = ? AND asset_id = ? AND generation = ?
    `).get(projectId, asset.id, generation.generation).count, 0);

    const installedOcr = database.getAssetSemanticModel(models.ocr.modelId, models.ocr.revision);
    const unavailableOcr = database.setAssetSemanticModelState({
      modelKey: models.ocr.modelId,
      modelVersion: models.ocr.revision,
      capability: 'ocr',
      status: 'not-installed',
    }, { expectedRevision: installedOcr.revision });
    assert.equal(unavailableOcr.status, 'not-installed');
    assert.throws(
      () => pipeline.retryJob(failedCaption.id, {
        projectId,
        expectedRevision: failedCaption.revision,
      }),
      (error) => error?.code === 'asset_semantic_model_not_installed',
      'reopening a failed generation must validate every enabled model, not only the retried caption model',
    );
    assert.equal(database.getAssetSemanticJob(failedCaption.id).status, 'failed');
    assert.equal(database.getAssetSemanticGeneration(projectId, generation.generation).status, 'failed');
    assert.equal(database.getAssetSemanticProfile(projectId).buildingGeneration, null);
    const restoredOcr = await pipeline.syncModelState(models.ocr.modelId, { status: 'installed' });
    assert.equal(restoredOcr.status, 'installed');

    const [retriedCaption] = pipeline.retryJob(failedCaption.id, {
      projectId,
      expectedRevision: failedCaption.revision,
    });
    assert.equal(retriedCaption.status, 'queued');
    const resetEmbedding = database.listAssetSemanticJobs({
      projectId, generation: generation.generation, assetId: asset.id, limit: 20,
    }).find((job) => job.jobKind === 'embedding');
    assert.equal(resetEmbedding.status, 'queued');
    assert.equal(await pipeline.waitForIdle(10_000), true);

    const recoveredStatus = await pipeline.status(projectId);
    assert.equal(recoveredStatus.profile.activeGeneration, generation.generation);
    assert.equal(recoveredStatus.profile.buildingGeneration, null);
    assert.equal(recoveredStatus.failedGeneration, null);
    assert.equal(recoveredStatus.activeGenerationRecord.status, 'active');
    assert.equal(worker.embeddingTexts.length, 1, 'embedding must be recomputed exactly once after dependency retry');
    assert.match(worker.embeddingTexts[0], /caption: a red cat on a poster/);
    assert.match(worker.embeddingTexts[0], /ocr: SUMMER SALE/);
    assert.equal(database.getAssetSemanticJob(resetEmbedding.id).status, 'succeeded');
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(worker.closed, true);
});

test('startup recovery reconciles a max-attempt running job into a failed replacement while retaining the old active', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-recovery-reconcile-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const firstWorker = new FakeSemanticWorker();
  const firstPipeline = new AssetSemanticPipeline(config, database, {
    worker: firstWorker,
    autoStart: false,
    recover: false,
  });
  let recoveredPipeline = null;
  const projectId = 'project-semantic-recovery-reconcile';
  try {
    const model = getPublicSemanticModelManifest().find((candidate) => candidate.task === 'embedding');
    const asset = database.upsertAsset({
      id: 'recovery-reconcile-asset',
      projectId,
      kind: 'image',
      mimeType: 'image/png',
      filename: 'recovery-reconcile.png',
      storageMode: 'managed',
      availability: 'available',
      contentHash: crypto.createHash('sha256').update('recovery-reconcile').digest('hex'),
      contentHashVerification: 'verified',
    });
    let profile = await firstPipeline.setProfile(projectId, {
      enabled: true,
      caption: { enabled: false },
      ocr: { enabled: false },
      embedding: { enabled: true, modelKey: model.modelId, modelVersion: model.revision },
    }, { expectedRevision: 0, updatedBy: 'recovery-test' });
    await firstPipeline.rebuild(projectId, {
      expectedRevision: profile.revision,
      idempotencyKey: 'recovery/generation-1',
      createdBy: 'recovery-test',
    });
    assert.equal(await firstPipeline.waitForIdle(10_000), true);
    profile = database.getAssetSemanticProfile(projectId);
    const oldActiveGeneration = profile.activeGeneration;
    assert.equal(database.getAssetSemanticGeneration(projectId, oldActiveGeneration).status, 'active');

    const replacement = database.beginAssetSemanticRebuild(projectId, {
      expectedProfileRevision: profile.revision,
      idempotencyKey: 'recovery/generation-2',
      createdBy: 'recovery-test',
    });
    const queued = database.enqueueAssetSemanticJob({
      projectId,
      assetId: asset.id,
      contentHash: asset.contentHash,
      generation: replacement.generation,
      jobKind: 'embedding',
      modelKey: model.modelId,
      modelVersion: model.revision,
      maxAttempts: 1,
      inputDigest: 'pending',
    });
    database.sealAssetSemanticRebuild(projectId, replacement.generation, {
      expectedProfileRevision: database.getAssetSemanticProfile(projectId).revision,
      expectedGenerationRevision: database.getAssetSemanticGeneration(projectId, replacement.generation).revision,
    });
    const interrupted = database.claimNextAssetSemanticJob({ projectId });
    assert.equal(interrupted.id, queued.id);
    assert.equal(interrupted.status, 'running');
    assert.equal(interrupted.attemptCount, 1);
    firstPipeline.close();

    const recoveredWorker = new FakeSemanticWorker();
    recoveredPipeline = new AssetSemanticPipeline(config, database, {
      worker: recoveredWorker,
      autoStart: true,
      recover: true,
    });
    assert.equal(recoveredPipeline.recovery.failed, 1);
    assert.equal(await recoveredPipeline.waitForIdle(10_000), true);

    const status = await recoveredPipeline.status(projectId);
    assert.equal(database.getAssetSemanticJob(interrupted.id).status, 'failed');
    assert.equal(status.profile.activeGeneration, oldActiveGeneration);
    assert.equal(status.profile.buildingGeneration, null);
    assert.equal(status.activeGenerationRecord.status, 'active');
    assert.equal(status.failedGeneration.generation, replacement.generation);
    assert.equal(status.failedGeneration.status, 'failed');
    assert.equal(status.indexStale, false);
    assert.equal(database.getAssetSemanticGeneration(projectId, oldActiveGeneration).status, 'active');
    assert.equal(database.listBuildingAssetSemanticGenerations({ limit: 10 }).length, 0);
  } finally {
    firstPipeline.close();
    recoveredPipeline?.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup recovery promotes a ready generation left between finish and promotion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-ready-recovery-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const setupPipeline = new AssetSemanticPipeline(config, database, {
    worker: new FakeSemanticWorker(),
    autoStart: false,
    recover: false,
  });
  let recoveredPipeline = null;
  const projectId = 'project-ready-recovery';
  try {
    const model = getPublicSemanticModelManifest().find((candidate) => candidate.task === 'embedding');
    await setupPipeline.setProfile(projectId, {
      enabled: true,
      caption: { enabled: false },
      ocr: { enabled: false },
      embedding: { enabled: true, modelKey: model.modelId, modelVersion: model.revision },
    }, { expectedRevision: 0, updatedBy: 'ready-recovery-test' });
    const ready = finishReadyGeneration(database, projectId, 'ready-recovery/generation-1');
    assert.equal(ready.status, 'ready');
    assert.equal(database.getAssetSemanticProfile(projectId).buildingGeneration, ready.generation);
    setupPipeline.close();

    recoveredPipeline = new AssetSemanticPipeline(config, database, {
      worker: new FakeSemanticWorker(),
      autoStart: true,
      recover: true,
    });
    assert.equal(await recoveredPipeline.waitForIdle(10_000), true);
    const status = await recoveredPipeline.status(projectId);
    assert.equal(status.profile.activeGeneration, ready.generation);
    assert.equal(status.profile.buildingGeneration, null);
    assert.equal(status.activeGenerationRecord.status, 'active');
    assert.equal(database.listBuildingAssetSemanticGenerations({ limit: 10 }).length, 0);
  } finally {
    setupPipeline.close();
    recoveredPipeline?.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup recovery rejects a ready generation on catalog drift and preserves the old active', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-ready-drift-recovery-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const setupPipeline = new AssetSemanticPipeline(config, database, {
    worker: new FakeSemanticWorker(),
    autoStart: false,
    recover: false,
  });
  let recoveredPipeline = null;
  const projectId = 'project-ready-drift-recovery';
  try {
    const model = getPublicSemanticModelManifest().find((candidate) => candidate.task === 'embedding');
    await setupPipeline.setProfile(projectId, {
      enabled: true,
      caption: { enabled: false },
      ocr: { enabled: false },
      embedding: { enabled: true, modelKey: model.modelId, modelVersion: model.revision },
    }, { expectedRevision: 0, updatedBy: 'ready-drift-recovery-test' });
    const firstReady = finishReadyGeneration(database, projectId, 'ready-drift-recovery/generation-1');
    const firstPromotion = database.promoteAssetSemanticGeneration(projectId, firstReady.generation, {
      expectedProfileRevision: database.getAssetSemanticProfile(projectId).revision,
      expectedGenerationRevision: firstReady.revision,
    });
    const oldActiveGeneration = firstPromotion.generation.generation;
    const replacement = finishReadyGeneration(database, projectId, 'ready-drift-recovery/generation-2');
    assert.equal(replacement.status, 'ready');
    database.upsertAsset({
      id: 'ready-drift-mutation',
      projectId,
      kind: 'image',
      mimeType: 'image/png',
      filename: 'catalog-mutated-after-finish.png',
      storageMode: 'managed',
      availability: 'available',
      contentHash: crypto.createHash('sha256').update('catalog-mutated-after-finish').digest('hex'),
      contentHashVerification: 'verified',
    });
    const driftCatalogRevision = database.getAssetCatalogRevision(projectId);
    setupPipeline.close();

    recoveredPipeline = new AssetSemanticPipeline(config, database, {
      worker: new FakeSemanticWorker(),
      autoStart: true,
      recover: true,
    });
    assert.equal(await recoveredPipeline.waitForIdle(10_000), true);
    const status = await recoveredPipeline.status(projectId);
    assert.equal(status.profile.activeGeneration, oldActiveGeneration);
    assert.equal(status.profile.buildingGeneration, null);
    assert.equal(status.activeGenerationRecord.status, 'active');
    assert.equal(status.failedGeneration.generation, replacement.generation);
    assert.equal(status.failedGeneration.status, 'failed');
    assert.equal(status.failedGeneration.errorCode, 'asset_catalog_revision_conflict');
    assert.equal(database.getAssetCatalogRevision(projectId), driftCatalogRevision, 'rejection must not bump the live catalog');
    assert.equal(database.getAssetSemanticGeneration(projectId, oldActiveGeneration).status, 'active');
    assert.equal(database.listBuildingAssetSemanticGenerations({ limit: 10 }).length, 0);
  } finally {
    setupPipeline.close();
    recoveredPipeline?.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('changing the profile supersedes a referenced ready generation, keeps the old active, and permits a new rebuild', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-ready-profile-change-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker: new FakeSemanticWorker(),
    autoStart: false,
    recover: false,
  });
  const projectId = 'project-ready-profile-change';
  try {
    const models = Object.fromEntries(getPublicSemanticModelManifest().map((model) => [model.task, model]));
    await pipeline.setProfile(projectId, {
      enabled: true,
      caption: { enabled: false },
      ocr: { enabled: false },
      embedding: { enabled: true, modelKey: models.embedding.modelId, modelVersion: models.embedding.revision },
    }, { expectedRevision: 0, updatedBy: 'ready-profile-change-test' });
    const firstReady = finishReadyGeneration(database, projectId, 'ready-profile-change/generation-1');
    const firstPromotion = database.promoteAssetSemanticGeneration(projectId, firstReady.generation, {
      expectedProfileRevision: database.getAssetSemanticProfile(projectId).revision,
      expectedGenerationRevision: firstReady.revision,
    });
    const oldActiveGeneration = firstPromotion.generation.generation;
    const replacement = finishReadyGeneration(database, projectId, 'ready-profile-change/generation-2');
    assert.equal(replacement.status, 'ready');

    const beforeChange = database.getAssetSemanticProfile(projectId);
    const changed = await pipeline.setProfile(projectId, {
      enabled: true,
      caption: { enabled: true, modelKey: models.caption.modelId, modelVersion: models.caption.revision },
      embedding: { enabled: false },
    }, { expectedRevision: beforeChange.revision, updatedBy: 'ready-profile-change-test' });
    assert.equal(changed.activeGeneration, oldActiveGeneration);
    assert.equal(changed.buildingGeneration, null);
    assert.equal(database.getAssetSemanticGeneration(projectId, oldActiveGeneration).status, 'active');
    assert.equal(database.getAssetSemanticGeneration(projectId, replacement.generation).status, 'superseded');

    const rebuilt = await pipeline.rebuild(projectId, {
      expectedRevision: changed.revision,
      idempotencyKey: 'ready-profile-change/generation-3',
      createdBy: 'ready-profile-change-test',
    });
    assert.equal(rebuilt.status, 'active');
    const finalProfile = database.getAssetSemanticProfile(projectId);
    assert.equal(finalProfile.activeGeneration, rebuilt.generation);
    assert.equal(finalProfile.buildingGeneration, null);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent recovery sweeps terminate a ready generation whose profile digest changed with one stable outcome', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-ready-profile-recovery-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const setupPipeline = new AssetSemanticPipeline(config, database, {
    worker: new FakeSemanticWorker(),
    autoStart: false,
    recover: false,
  });
  let recoveredPipeline = null;
  const projectId = 'project-ready-profile-recovery';
  try {
    const models = Object.fromEntries(getPublicSemanticModelManifest().map((model) => [model.task, model]));
    await setupPipeline.setProfile(projectId, {
      enabled: true,
      caption: { enabled: false },
      ocr: { enabled: false },
      embedding: { enabled: true, modelKey: models.embedding.modelId, modelVersion: models.embedding.revision },
    }, { expectedRevision: 0, updatedBy: 'ready-profile-recovery-test' });
    const firstReady = finishReadyGeneration(database, projectId, 'ready-profile-recovery/generation-1');
    const firstPromotion = database.promoteAssetSemanticGeneration(projectId, firstReady.generation, {
      expectedProfileRevision: database.getAssetSemanticProfile(projectId).revision,
      expectedGenerationRevision: firstReady.revision,
    });
    const oldActiveGeneration = firstPromotion.generation.generation;
    const replacement = finishReadyGeneration(database, projectId, 'ready-profile-recovery/generation-2');
    const beforeChange = database.getAssetSemanticProfile(projectId);
    const changed = database.setAssetSemanticProfile(projectId, {
      caption: { enabled: true, modelKey: models.caption.modelId, modelVersion: models.caption.revision },
      embedding: { enabled: false },
    }, { expectedRevision: beforeChange.revision, updatedBy: 'simulated-crash-after-profile-write' });
    assert.equal(changed.buildingGeneration, replacement.generation, 'simulated crash leaves the ready pointer behind');
    setupPipeline.close();

    recoveredPipeline = new AssetSemanticPipeline(config, database, {
      worker: new FakeSemanticWorker(),
      autoStart: false,
      recover: true,
    });
    const sweeps = await Promise.all([
      recoveredPipeline.reconcileIdleGenerations(),
      recoveredPipeline.reconcileIdleGenerations(),
    ]);
    assert.equal(sweeps.reduce((sum, sweep) => sum + sweep.failures, 0), 0);
    assert.equal(await recoveredPipeline.waitForIdle(5_000), true);
    const finalProfile = database.getAssetSemanticProfile(projectId);
    const finalReplacement = database.getAssetSemanticGeneration(projectId, replacement.generation);
    assert.equal(finalProfile.activeGeneration, oldActiveGeneration);
    assert.equal(finalProfile.buildingGeneration, null);
    assert.equal(database.getAssetSemanticGeneration(projectId, oldActiveGeneration).status, 'active');
    assert.equal(finalReplacement.status, 'superseded');
    assert.equal(finalReplacement.errorCode, 'asset-semantic-profile-changed');
    assert.equal(database.listBuildingAssetSemanticGenerations({ limit: 10 }).length, 0);
  } finally {
    setupPipeline.close();
    recoveredPipeline?.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cold model SHA verification is deduplicated in the background and failures persist without blocking status', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-cold-model-verification-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const models = Object.fromEntries(getPublicSemanticModelManifest().map((model) => [model.task, model]));
  const worker = new GatedColdVerificationWorker(models.ocr.modelId);
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker,
    autoStart: false,
    recover: false,
  });
  try {
    const startedAt = Date.now();
    const verifying = await pipeline.syncModelState(models.caption.modelId);
    assert.equal(verifying.status, 'verifying');
    assert.ok(Date.now() - startedAt < 500, 'status must not await a multi-gigabyte SHA pass');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(worker.verifyCalls.filter((modelId) => modelId === models.caption.modelId).length, 1);
    const repeated = await pipeline.syncModelState(models.caption.modelId);
    assert.equal(repeated.status, 'verifying');
    assert.equal(worker.verifyCalls.filter((modelId) => modelId === models.caption.modelId).length, 1);
    const captionVerification = pipeline.modelVerifications.get(models.caption.modelId).promise;
    worker.releaseVerification(models.caption.modelId);
    await captionVerification;
    assert.equal(database.getAssetSemanticModel(models.caption.modelId, models.caption.revision).status, 'installed');

    const pendingFailure = await pipeline.syncModelState(models.ocr.modelId);
    assert.equal(pendingFailure.status, 'verifying');
    await new Promise((resolve) => setImmediate(resolve));
    const ocrVerification = pipeline.modelVerifications.get(models.ocr.modelId).promise;
    worker.releaseVerification(models.ocr.modelId);
    await ocrVerification;
    const failed = database.getAssetSemanticModel(models.ocr.modelId, models.ocr.revision);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'asset-semantic-model-hash-mismatch');
    assert.equal(worker.verifyCalls.filter((modelId) => modelId === models.ocr.modelId).length, 1);
    const failedAgain = await pipeline.syncModelState(models.ocr.modelId);
    assert.equal(failedAgain.status, 'failed');
    assert.equal(worker.verifyCalls.filter((modelId) => modelId === models.ocr.modelId).length, 1, 'failed verification requires explicit retry');

    const pendingClose = await pipeline.syncModelState(models.embedding.modelId);
    assert.equal(pendingClose.status, 'verifying');
    await new Promise((resolve) => setImmediate(resolve));
    const closeVerification = pipeline.modelVerifications.get(models.embedding.modelId).promise;
    pipeline.close();
    await closeVerification;
    assert.equal(database.getAssetSemanticModel(models.embedding.modelId, models.embedding.revision).status, 'verifying');
    assert.equal(worker.closed, true);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('background model verification cannot overwrite an explicit delete or download transition', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-background-verification-races-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const models = Object.fromEntries(getPublicSemanticModelManifest().map((model) => [model.task, model]));
  const worker = new GatedColdVerificationWorker();
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker,
    autoStart: false,
    recover: false,
  });
  try {
    const deletingCandidate = await pipeline.syncModelState(models.caption.modelId);
    assert.equal(deletingCandidate.status, 'verifying');
    await new Promise((resolve) => setImmediate(resolve));
    const removed = await pipeline.removeModel(models.caption.modelId, {
      expectedRevision: deletingCandidate.revision,
    });
    assert.equal(removed.status, 'not-installed');
    assert.equal(database.getAssetSemanticModel(models.caption.modelId, models.caption.revision).status, 'not-installed');

    const downloadCandidate = await pipeline.syncModelState(models.ocr.modelId);
    assert.equal(downloadCandidate.status, 'verifying');
    await new Promise((resolve) => setImmediate(resolve));
    const downloading = await pipeline.startModelDownload(models.ocr.modelId, {
      expectedRevision: downloadCandidate.revision,
      idempotencyKey: 'background-verification-race/download-1',
    });
    assert.equal(downloading.status, 'downloading');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(database.getAssetSemanticModel(models.ocr.modelId, models.ocr.revision).status, 'installed');
    assert.equal(worker.downloadCalls, 1);
    assert.equal(pipeline.modelVerifications.has(models.caption.modelId), false);
    assert.equal(pipeline.modelVerifications.has(models.ocr.modelId), false);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a queued cold verification can be cancelled without waiting for an unrelated large-model SHA', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-queued-verification-cancel-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const models = Object.fromEntries(getPublicSemanticModelManifest().map((model) => [model.task, model]));
  const worker = new GatedColdVerificationWorker();
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker,
    autoStart: false,
    recover: false,
  });
  try {
    await pipeline.syncModelState(models.caption.modelId);
    const queuedDownload = await pipeline.syncModelState(models.ocr.modelId);
    const queuedDelete = await pipeline.syncModelState(models.embedding.modelId);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(worker.verifyCalls, [models.caption.modelId], 'only the head of the serialized SHA queue may start');

    const downloadStartedAt = Date.now();
    const downloading = await pipeline.startModelDownload(models.ocr.modelId, {
      expectedRevision: queuedDownload.revision,
      idempotencyKey: 'queued-verification/download',
    });
    assert.equal(downloading.status, 'downloading');
    assert.ok(Date.now() - downloadStartedAt < 500, 'queued cancellation must not await the caption SHA gate');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(database.getAssetSemanticModel(models.ocr.modelId, models.ocr.revision).status, 'installed');

    const deleteStartedAt = Date.now();
    const removed = await pipeline.removeModel(models.embedding.modelId, {
      expectedRevision: queuedDelete.revision,
    });
    assert.equal(removed.status, 'not-installed');
    assert.ok(Date.now() - deleteStartedAt < 500, 'queued cancellation must not await the caption SHA gate');
    assert.deepEqual(worker.verifyCalls, [models.caption.modelId]);

    const headVerification = pipeline.modelVerifications.get(models.caption.modelId).promise;
    worker.releaseVerification(models.caption.modelId);
    await headVerification;
    await pipeline.modelVerificationTail;
    assert.deepEqual(worker.verifyCalls, [models.caption.modelId], 'aborted queued models must never begin hashing');
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('late download progress is operation-bound and cannot overwrite an installed model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-late-download-progress-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const worker = new LateProgressDownloadWorker();
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker,
    autoStart: false,
    recover: false,
  });
  const model = getPublicSemanticModelManifest().find((candidate) => candidate.task === 'caption');
  try {
    const initial = await pipeline.syncModelState(model.modelId);
    const accepted = await pipeline.startModelDownload(model.modelId, {
      expectedRevision: initial.revision,
      idempotencyKey: 'late-progress/download',
    });
    assert.equal(accepted.status, 'downloading');
    worker.emitProgress(model.modelId, { state: 'verifying', downloadedBytes: model.downloadBytes });
    await new Promise((resolve) => setImmediate(resolve));
    const operation = pipeline.downloads.get(model.modelId);
    worker.resolveDownload(model.modelId);
    await operation.promise;
    const installed = database.getAssetSemanticModel(model.modelId, model.revision);
    assert.equal(installed.status, 'installed');

    worker.emitProgress(model.modelId, { state: 'verifying', downloadedBytes: model.downloadBytes });
    await new Promise((resolve) => setImmediate(resolve));
    const afterLateProgress = database.getAssetSemanticModel(model.modelId, model.revision);
    assert.equal(afterLateProgress.status, 'installed');
    assert.equal(afterLateProgress.revision, installed.revision);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pipeline close aborts direct rebuild verification before any generation is created', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-rebuild-close-abort-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const worker = new AbortableRebuildVerificationWorker();
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker,
    autoStart: false,
    recover: false,
  });
  const model = getPublicSemanticModelManifest().find((candidate) => candidate.task === 'embedding');
  try {
    await pipeline.listModels();
    const configured = await pipeline.setProfile('rebuild-close-project', {
      enabled: true,
      caption: { enabled: false },
      ocr: { enabled: false },
      embedding: { enabled: true, modelKey: model.modelId, modelVersion: model.revision },
    }, { expectedRevision: 0, updatedBy: 'rebuild-close-test' });
    const beforeModel = database.getAssetSemanticModel(model.modelId, model.revision);
    const rebuild = pipeline.rebuild('rebuild-close-project', {
      expectedRevision: configured.revision,
      idempotencyKey: 'rebuild-close/direct-request',
    });
    await worker.verifyStarted;
    assert.ok(worker.observedSignal, 'direct rebuild verification must receive a lifecycle signal');
    pipeline.close();
    await assert.rejects(rebuild, (error) => error?.name === 'AbortError');
    assert.equal(database.listAssetSemanticGenerations('rebuild-close-project').length, 0);
    assert.equal(database.getAssetSemanticProfile('rebuild-close-project').buildingGeneration, null);
    assert.equal(database.getAssetSemanticModel(model.modelId, model.revision).revision, beforeModel.revision);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pipeline close aborts a model download and prevents a late installed write', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-download-close-abort-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const worker = new AbortableDownloadWorker();
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker,
    autoStart: false,
    recover: false,
  });
  const model = getPublicSemanticModelManifest().find((candidate) => candidate.task === 'caption');
  try {
    const initial = await pipeline.syncModelState(model.modelId);
    const accepted = await pipeline.startModelDownload(model.modelId, {
      expectedRevision: initial.revision,
      idempotencyKey: 'download-close/direct-request',
    });
    assert.equal(accepted.status, 'downloading');
    await worker.downloadStarted;
    const operation = pipeline.downloads.get(model.modelId);
    assert.ok(worker.observedSignal, 'download must receive a lifecycle-bound signal');
    pipeline.close();
    await assert.rejects(operation.promise, (error) => error?.name === 'AbortError');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(database.getAssetSemanticModel(model.modelId, model.revision).status, 'downloading');
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('waitForIdle drains every bounded payload-GC batch before reporting idle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-wait-gc-drain-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker: new FakeSemanticWorker(),
    autoStart: false,
    recover: false,
  });
  const originalPrune = database.pruneAssetSemanticGenerationPayloads.bind(database);
  let cleanupCalls = 0;
  database.pruneAssetSemanticGenerationPayloads = () => {
    cleanupCalls += 1;
    return {
      prunedGenerationCount: cleanupCalls <= 2 ? 2 : 0,
      prunedGenerations: [],
      deletedJobs: 0,
      deletedDocuments: 0,
      deletedEmbeddings: 0,
      hasMore: cleanupCalls < 3,
    };
  };
  pipeline.schedulePump = () => {};
  try {
    assert.equal(await pipeline.waitForIdle(2_000), true);
    assert.equal(cleanupCalls, 3);
  } finally {
    database.pruneAssetSemanticGenerationPayloads = originalPrune;
    pipeline.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a download using the live deleting revision is rejected while physical removal is delayed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-delete-download-race-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const worker = new DelayedRemovalWorker();
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker,
    autoStart: false,
    recover: false,
  });
  const model = getPublicSemanticModelManifest().find((candidate) => candidate.task === 'caption');
  let removal = null;
  try {
    const installed = await pipeline.syncModelState(model.modelId);
    removal = pipeline.removeModel(model.modelId, { expectedRevision: installed.revision });
    await worker.removeStarted;
    const deleting = database.getAssetSemanticModel(model.modelId, model.revision);
    assert.equal(deleting.status, 'deleting');
    await assert.rejects(
      pipeline.startModelDownload(model.modelId, {
        expectedRevision: deleting.revision,
        idempotencyKey: 'delete-download-race/new-download',
      }),
      (error) => error?.code === 'asset-semantic-model-delete-in-progress',
    );
    assert.equal(worker.downloadCalls, 0, 'rejected download must never reach the worker');
    assert.equal(database.getAssetSemanticModel(model.modelId, model.revision).status, 'deleting');
    worker.resolveRemoveRelease();
    const removed = await removal;
    removal = null;
    assert.equal(removed.status, 'not-installed');
    assert.equal(worker.removeCalls, 1);
  } finally {
    worker.resolveRemoveRelease();
    await removal?.catch(() => {});
    pipeline.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('model deletion and rebuild race has one atomic winner and never leaves a building generation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-model-delete-race-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const worker = new FakeSemanticWorker();
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker,
    autoStart: false,
    recover: false,
  });
  const projectId = 'project-model-delete-race';
  try {
    const model = getPublicSemanticModelManifest().find((candidate) => candidate.task === 'embedding');
    database.upsertAsset({
      id: 'model-delete-race-asset',
      projectId,
      kind: 'image',
      mimeType: 'image/png',
      filename: 'model-delete-race.png',
      storageMode: 'managed',
      availability: 'available',
      contentHash: crypto.createHash('sha256').update('model-delete-race').digest('hex'),
      contentHashVerification: 'verified',
    });
    const profile = await pipeline.setProfile(projectId, {
      enabled: true,
      caption: { enabled: false },
      ocr: { enabled: false },
      embedding: { enabled: true, modelKey: model.modelId, modelVersion: model.revision },
    }, { expectedRevision: 0, updatedBy: 'model-delete-race-test' });
    const installed = database.getAssetSemanticModel(model.modelId, model.revision);
    const outcomes = await Promise.allSettled([
      pipeline.removeModel(model.modelId, { expectedRevision: installed.revision }),
      pipeline.rebuild(projectId, {
        expectedRevision: profile.revision,
        idempotencyKey: 'model-delete-race/generation-1',
        createdBy: 'model-delete-race-test',
      }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
    const rejectionCode = outcomes.find((outcome) => outcome.status === 'rejected').reason?.code;
    assert.equal(new Set([
      'asset_semantic_model_in_use',
      'asset_semantic_model_delete_in_progress',
      'asset-semantic-model-delete-in-progress',
      'asset-semantic-model-not-installed',
    ]).has(rejectionCode), true, `unexpected race rejection: ${rejectionCode}`);
    assert.equal(await pipeline.waitForIdle(10_000), true);
    const finalProfile = database.getAssetSemanticProfile(projectId);
    assert.equal(finalProfile.buildingGeneration, null);
    assert.equal(database.listBuildingAssetSemanticGenerations({ limit: 10 }).length, 0);
    const finalModel = database.getAssetSemanticModel(model.modelId, model.revision);
    const rebuildWon = outcomes[1].status === 'fulfilled';
    assert.equal(rebuildWon ? finalProfile.activeGeneration != null : finalModel.status === 'not-installed', true);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('model download idempotency survives the revision bump and a pipeline restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-model-idempotency-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const model = getPublicSemanticModelManifest().find((candidate) => candidate.task === 'caption');
  const firstWorker = new InterruptedDownloadWorker();
  const firstPipeline = new AssetSemanticPipeline(config, database, {
    worker: firstWorker,
    autoStart: false,
    recover: false,
  });
  let secondPipeline = null;
  try {
    const initial = (await firstPipeline.listModels()).find((candidate) => candidate.modelId === model.modelId);
    assert.equal(initial.status, 'not-installed');
    assert.equal(initial.revision, 1);

    const request = {
      expectedRevision: initial.revision,
      idempotencyKey: 'model-download/response-loss/request-1',
    };
    const [accepted, concurrentReplay] = await Promise.all([
      firstPipeline.startModelDownload(model.modelId, request),
      firstPipeline.startModelDownload(model.modelId, request),
    ]);
    assert.equal(accepted.status, 'downloading');
    assert.equal(accepted.revision, 2);
    assert.equal(concurrentReplay.status, 'downloading');
    assert.equal(concurrentReplay.revision, accepted.revision);
    assert.equal(firstWorker.downloadCalls, 1);

    const immediateReplay = await firstPipeline.startModelDownload(model.modelId, {
      expectedRevision: initial.revision,
      idempotencyKey: 'model-download/response-loss/request-1',
    });
    assert.equal(immediateReplay.status, 'downloading');
    assert.equal(immediateReplay.revision, accepted.revision);
    assert.equal(firstWorker.downloadCalls, 1, 'same request must not start a second download');
    await assert.rejects(
      firstPipeline.startModelDownload(model.modelId, {
        expectedRevision: accepted.revision,
        idempotencyKey: 'model-download/response-loss/request-1',
      }),
      (error) => error.code === 'asset-semantic-idempotency-conflict',
    );

    firstPipeline.close();
    const secondWorker = new InterruptedDownloadWorker();
    secondPipeline = new AssetSemanticPipeline(config, database, {
      worker: secondWorker,
      autoStart: false,
      recover: false,
    });
    const restartReplay = await secondPipeline.startModelDownload(model.modelId, {
      expectedRevision: initial.revision,
      idempotencyKey: 'model-download/response-loss/request-1',
    });
    assert.equal(restartReplay.status, 'failed');
    assert.equal(restartReplay.errorCode, 'asset-semantic-download-interrupted');
    assert.equal(secondWorker.downloadCalls, 0, 'restart replay returns the persisted operation instead of duplicating it');
    assert.equal(restartReplay.downloadIdempotencyKey, 'model-download/response-loss/request-1');
    assert.equal(restartReplay.downloadRequestRevision, initial.revision);

    const restarted = await secondPipeline.startModelDownload(model.modelId, {
      expectedRevision: restartReplay.revision,
      idempotencyKey: 'model-download/explicit-retry/request-2',
    });
    assert.equal(restarted.status, 'downloading');
    assert.equal(secondWorker.downloadCalls, 1);
    assert.equal(restarted.downloadIdempotencyKey, 'model-download/explicit-retry/request-2');
    assert.equal(restarted.downloadRequestRevision, restartReplay.revision);
  } finally {
    firstPipeline.close();
    secondPipeline?.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('vision skips only unsupported/unavailable sources and video preview validation fails closed', () => {
  assert.equal(isSkippableVisionSourceError({ code: 'asset-semantic-kind-unsupported' }), true);
  assert.equal(isSkippableVisionSourceError({ code: 'asset-semantic-source-unavailable' }), true);
  assert.equal(isSkippableVisionSourceError({ code: 'asset-semantic-preview-unavailable' }), true);
  assert.equal(isSkippableVisionSourceError({ code: 'asset-semantic-preview-stale' }), false);
  assert.equal(isSkippableVisionSourceError({ code: 'source-content-changed' }), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-preview-'));
  try {
    assert.throws(() => resolveVerifiedVideoPreview({
      kind: 'video',
      contentHash: 'not-a-sha256',
      metadata: { firstFrameUrl: '/files/thumbnails/asset-not-a-sha256-first.webp' },
    }, { THUMBNAILS_DIR: root }), (error) => error.code === 'asset-semantic-preview-stale');
    assert.throws(() => resolveVerifiedVideoPreview({
      kind: 'video',
      contentHash: 'a'.repeat(64),
      metadata: { firstFrameUrl: `/files/thumbnails/asset-${'a'.repeat(24)}-first.webp` },
    }, { THUMBNAILS_DIR: root }), (error) => error.code === 'asset-semantic-preview-unavailable');
    assert.throws(() => resolveVerifiedVideoPreview({
      kind: 'video',
      contentHash: 'a'.repeat(64),
      metadata: { firstFrameUrl: '/files/thumbnails/../outside.webp' },
    }, { THUMBNAILS_DIR: root }), (error) => error.code === 'asset-semantic-preview-invalid');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
