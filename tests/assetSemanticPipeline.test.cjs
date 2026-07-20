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

class MutableInterruptedDownloadWorker extends InterruptedDownloadWorker {
  constructor() {
    super();
    this.statuses = new Map();
  }

  setModelStatus(modelId, status) {
    this.statuses.set(modelId, status);
  }

  getModelStatus(modelId) {
    return this.statuses.get(modelId) || super.getModelStatus(modelId);
  }

  getDownloadProgress(modelId) { return this.getModelStatus(modelId); }
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

class DelayedAbortVerificationWorker extends ColdVerificationWorker {
  constructor(modelId) {
    super(null);
    this.modelId = modelId;
    this.abortReportedFailure = false;
    this.reportFailure = false;
    this.verifyStarted = new Promise((resolve) => { this.resolveVerifyStarted = resolve; });
    this.abortObserved = new Promise((resolve) => { this.resolveAbortObserved = resolve; });
    this.abortRelease = new Promise((resolve) => { this.resolveAbortRelease = resolve; });
  }

  getModelStatus(modelId) {
    if (modelId !== this.modelId) return notInstalledStatus(modelId);
    if (!this.abortReportedFailure && !this.reportFailure) return super.getModelStatus(modelId);
    return {
      ...notInstalledStatus(modelId),
      state: 'failed',
      error: {
        code: 'asset-semantic-aborted-verification-reported-failed',
        message: 'cancelled verification reported a late failure',
      },
    };
  }

  verifyModel(modelId, options = {}) {
    this.verifyCalls.push(modelId);
    this.resolveVerifyStarted();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.abortReportedFailure = true;
        this.resolveAbortObserved();
        void this.abortRelease.then(() => {
          const error = new Error('verification cancellation settled late');
          error.name = 'AbortError';
          reject(error);
        });
      };
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
    });
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

function concurrentProjectDatabaseTestOptions() {
  return {
    autoBackup: false,
    ...(process.env.NODE_TEST_CONTEXT
      ? { unsafeDisableOwnerGuardForTests: true }
      : {}),
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

test('semantic status and model listing stay pure on a cold database', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-status-pure-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const worker = new FakeSemanticWorker();
  let modelStatusReads = 0;
  let progressReads = 0;
  const originalStatus = worker.getModelStatus.bind(worker);
  worker.getModelStatus = (modelId) => {
    modelStatusReads += 1;
    return originalStatus(modelId);
  };
  worker.getDownloadProgress = (modelId) => {
    progressReads += 1;
    return originalStatus(modelId);
  };
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker,
    autoStart: false,
    recover: false,
  });
  try {
    const beforeChanges = Number(database.db.prepare('SELECT total_changes() AS value').get().value);
    database.db.pragma('query_only = ON');
    const first = await pipeline.status('project-semantic-status-pure');
    const second = await pipeline.status('project-semantic-status-pure');
    const listed = await pipeline.listModels();

    assert.equal(first.models.length, 3);
    assert.deepEqual(first.models, second.models);
    assert.deepEqual(first.models, listed);
    assert.deepEqual(first.models.map((model) => [model.status, model.revision]), [
      ['not-installed', 1],
      ['not-installed', 1],
      ['not-installed', 1],
    ]);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM asset_semantic_models').get().count, 0);
    assert.equal(Number(database.db.prepare('SELECT total_changes() AS value').get().value), beforeChanges);
    assert.equal(modelStatusReads, 0, 'pure status must not inspect mutable model installation state');
    assert.equal(progressReads, 0, 'cold virtual rows have no active progress to read');
    assert.equal(pipeline.modelVerifications.size, 0);
  } finally {
    pipeline.close();
    if (database.db.open) database.db.pragma('query_only = OFF');
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('model listing observes the fixed manifest from one durable SELECT snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-status-model-snapshot-'));
  const config = testConfig(root);
  const filename = path.join(root, 'projects.sqlite3');
  const reader = new ProjectDatabase(filename, concurrentProjectDatabaseTestOptions());
  const writer = new ProjectDatabase(filename, concurrentProjectDatabaseTestOptions());
  const pipeline = new AssetSemanticPipeline(config, reader, {
    worker: new FakeSemanticWorker(),
    autoStart: false,
    recover: false,
  });
  const manifest = getPublicSemanticModelManifest();
  const originalList = reader.listAssetSemanticModels.bind(reader);
  const originalGet = reader.getAssetSemanticModel.bind(reader);
  let listCalls = 0;
  try {
    reader.listAssetSemanticModels = () => {
      listCalls += 1;
      const snapshot = originalList();
      writer.syncAssetSemanticModelObservations(manifest.map((model, index) => ({
        expected: null,
        state: {
          modelKey: model.modelId,
          modelVersion: model.revision,
          capability: model.task,
          status: 'installed',
          artifactDigest: String(index + 1).repeat(64),
          byteSize: model.downloadBytes,
          downloadedBytes: model.downloadBytes,
          totalBytes: model.downloadBytes,
          installPath: path.join(config.ASSET_SEMANTIC_MODELS_DIR, model.modelId),
        },
      })));
      return snapshot;
    };
    reader.getAssetSemanticModel = () => {
      throw new Error('listModels must not perform per-model durable reads');
    };

    const oldSnapshot = await pipeline.listModels();
    assert.equal(listCalls, 1);
    assert.deepEqual(oldSnapshot.map((model) => [model.status, model.revision]), [
      ['not-installed', 1],
      ['not-installed', 1],
      ['not-installed', 1],
    ]);

    reader.listAssetSemanticModels = originalList;
    reader.getAssetSemanticModel = originalGet;
    const newSnapshot = await pipeline.listModels();
    assert.deepEqual(newSnapshot.map((model) => [model.status, model.revision]), [
      ['installed', 2],
      ['installed', 2],
      ['installed', 2],
    ]);
  } finally {
    reader.listAssetSemanticModels = originalList;
    reader.getAssetSemanticModel = originalGet;
    pipeline.close();
    await writer.close();
    await reader.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit model refresh atomically materializes the fixed manifest and is a strict no-op when unchanged', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-model-refresh-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker: new FakeSemanticWorker(),
    autoStart: false,
    recover: false,
  });
  try {
    const first = await pipeline.refreshModelStates();
    assert.equal(first.changedCount, 3);
    assert.equal(first.models.length, 3);
    assert.deepEqual(first.models.map((model) => model.status), ['installed', 'installed', 'installed']);
    assert.deepEqual(first.models.map((model) => model.revision), [2, 2, 2]);
    const before = first.models.map((model) => ({ revision: model.revision, updatedAt: model.updatedAt }));

    const repeated = await pipeline.refreshModelStates();
    assert.equal(repeated.changedCount, 0);
    assert.deepEqual(
      repeated.models.map((model) => ({ revision: model.revision, updatedAt: model.updatedAt })),
      before,
    );
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM asset_semantic_models').get().count, 3);
    assert.equal(pipeline.modelVerifications.size, 0);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit model refresh never retries a stale worker observation over a concurrent download transition', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-model-refresh-stale-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const worker = new InterruptedDownloadWorker();
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker,
    autoStart: false,
    recover: false,
  });
  const models = getPublicSemanticModelManifest();
  try {
    const defaults = await pipeline.refreshModelStates();
    assert.deepEqual(defaults.models.map((model) => [model.status, model.revision]), [
      ['not-installed', 1],
      ['not-installed', 1],
      ['not-installed', 1],
    ]);

    let observations = 0;
    worker.getModelStatus = (modelId) => {
      observations += 1;
      if (observations === 1) {
        const target = models[1];
        database.setAssetSemanticModelState({
          modelKey: target.modelId,
          modelVersion: target.revision,
          capability: target.task,
          status: 'downloading',
          downloadedBytes: 0,
          totalBytes: target.downloadBytes,
          downloadIdempotencyKey: 'semantic-refresh-concurrent-download',
          downloadRequestRevision: 1,
        }, { expectedRevision: 1 });
      }
      return installedStatus(modelId);
    };

    await assert.rejects(
      pipeline.refreshModelStates(),
      (error) => error?.code === 'asset_semantic_model_revision_conflict',
    );
    assert.equal(observations, 3, 'stale observations must not be retried');
    assert.deepEqual(models.map((model) => {
      const state = database.getAssetSemanticModel(model.modelId, model.revision);
      return [state.status, state.revision];
    }), [
      ['not-installed', 1],
      ['downloading', 2],
      ['not-installed', 1],
    ]);
    assert.equal(pipeline.modelVerifications.size, 0);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a second pipeline refresh preserves durable download and delete operations it does not own', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-model-refresh-non-owner-'));
  const config = testConfig(root);
  const filename = path.join(root, 'projects.sqlite3');
  const ownerDatabase = new ProjectDatabase(filename, concurrentProjectDatabaseTestOptions());
  const observerDatabase = new ProjectDatabase(filename, concurrentProjectDatabaseTestOptions());
  const ownerPipeline = new AssetSemanticPipeline(config, ownerDatabase, {
    worker: new InterruptedDownloadWorker(),
    autoStart: false,
    recover: false,
  });
  const observerPipeline = new AssetSemanticPipeline(config, observerDatabase, {
    worker: new InterruptedDownloadWorker(),
    autoStart: false,
    recover: false,
  });
  const models = getPublicSemanticModelManifest();
  try {
    const downloading = await ownerPipeline.startModelDownload(models[0].modelId, {
      expectedRevision: 1,
      idempotencyKey: 'semantic-refresh-owned-by-other-pipeline',
    });
    assert.equal(downloading.status, 'downloading');
    assert.equal(downloading.revision, 2);

    const installed = ownerDatabase.syncAssetSemanticModelObservations([{
      expected: null,
      state: {
        modelKey: models[1].modelId,
        modelVersion: models[1].revision,
        capability: models[1].task,
        status: 'installed',
        artifactDigest: 'a'.repeat(64),
        byteSize: models[1].downloadBytes,
        downloadedBytes: models[1].downloadBytes,
        totalBytes: models[1].downloadBytes,
        installPath: path.join(config.ASSET_SEMANTIC_MODELS_DIR, models[1].modelId),
      },
    }]).models[0];
    const deleting = ownerDatabase.beginAssetSemanticModelDelete(models[1].modelId, models[1].revision, {
      expectedRevision: installed.revision,
    });
    assert.equal(deleting.status, 'deleting');

    const beforeDownload = ownerDatabase.getAssetSemanticModelObservation(models[0].modelId, models[0].revision);
    const beforeDelete = ownerDatabase.getAssetSemanticModelObservation(models[1].modelId, models[1].revision);
    const refreshed = await observerPipeline.refreshModelStates();

    assert.equal(refreshed.changedCount, 1, 'only the third missing manifest row may materialize');
    assert.deepEqual(
      observerDatabase.getAssetSemanticModelObservation(models[0].modelId, models[0].revision),
      beforeDownload,
      'a non-owner not-installed snapshot must not mark another pipeline download interrupted',
    );
    assert.deepEqual(
      observerDatabase.getAssetSemanticModelObservation(models[1].modelId, models[1].revision),
      beforeDelete,
      'a non-owner not-installed snapshot must not complete another pipeline delete early',
    );
    assert.deepEqual(refreshed.models.map((model) => [model.status, model.revision]), [
      ['downloading', beforeDownload.revision],
      ['deleting', beforeDelete.revision],
      ['not-installed', 1],
    ]);
  } finally {
    observerPipeline.close();
    ownerPipeline.close();
    await observerDatabase.close();
    await ownerDatabase.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('non-owner verification is read-only until positive proof and cannot overwrite a concurrent revision', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-model-refresh-readonly-sha-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const model = getPublicSemanticModelManifest()[0];
  let pipeline = null;
  let failurePipeline = null;
  try {
    const seeded = database.syncAssetSemanticModelObservations([{
      expected: null,
      state: {
        modelKey: model.modelId,
        modelVersion: model.revision,
        capability: model.task,
        status: 'verifying',
        byteSize: model.downloadBytes,
        downloadedBytes: model.downloadBytes,
        totalBytes: model.downloadBytes,
        installPath: path.join(config.ASSET_SEMANTIC_MODELS_DIR, model.modelId),
      },
    }]).models[0];
    assert.equal(seeded.revision, 2);
    const before = database.getAssetSemanticModelObservation(model.modelId, model.revision);

    const worker = new GatedColdVerificationWorker();
    const targetStatus = worker.getModelStatus.bind(worker);
    worker.getModelStatus = (modelId) => (
      modelId === model.modelId ? targetStatus(modelId) : notInstalledStatus(modelId)
    );
    pipeline = new AssetSemanticPipeline(config, database, {
      worker,
      autoStart: false,
      recover: false,
    });
    const refreshed = await pipeline.refreshModelStates();
    assert.equal(refreshed.changedCount, 2, 'the durable verifying row must not change before SHA proof');
    assert.deepEqual(
      database.getAssetSemanticModelObservation(model.modelId, model.revision),
      before,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(worker.verifyCalls, [model.modelId]);
    const verification = pipeline.modelVerifications.get(model.modelId);
    assert.ok(verification);
    assert.equal(verification.ownsDurableState, false);

    const concurrent = database.setAssetSemanticModelState({
      modelKey: model.modelId,
      modelVersion: model.revision,
      capability: model.task,
      status: 'downloading',
      downloadedBytes: 0,
      totalBytes: model.downloadBytes,
      downloadIdempotencyKey: 'semantic-readonly-sha-concurrent-download',
      downloadRequestRevision: before.revision,
    }, { expectedRevision: before.revision });
    const concurrentObservation = database.getAssetSemanticModelObservation(model.modelId, model.revision);
    worker.releaseVerification(model.modelId);
    await verification.promise;
    assert.deepEqual(
      database.getAssetSemanticModelObservation(model.modelId, model.revision),
      concurrentObservation,
      'a positive late SHA result must not overwrite a newer download transition',
    );

    pipeline.close();
    pipeline = null;
    const verifyingAgain = database.setAssetSemanticModelState({
      modelKey: model.modelId,
      modelVersion: model.revision,
      capability: model.task,
      status: 'verifying',
      downloadedBytes: model.downloadBytes,
      totalBytes: model.downloadBytes,
      downloadIdempotencyKey: null,
      downloadRequestRevision: null,
    }, { expectedRevision: concurrent.revision });
    const beforeFailure = database.getAssetSemanticModelObservation(model.modelId, model.revision);
    assert.equal(beforeFailure.revision, verifyingAgain.revision);

    const failingWorker = new GatedColdVerificationWorker(model.modelId);
    const failingTargetStatus = failingWorker.getModelStatus.bind(failingWorker);
    failingWorker.getModelStatus = (modelId) => (
      modelId === model.modelId ? failingTargetStatus(modelId) : notInstalledStatus(modelId)
    );
    failurePipeline = new AssetSemanticPipeline(config, database, {
      worker: failingWorker,
      autoStart: false,
      recover: false,
    });
    const failureRefresh = await failurePipeline.refreshModelStates();
    assert.equal(failureRefresh.changedCount, 0);
    await new Promise((resolve) => setImmediate(resolve));
    const failedVerification = failurePipeline.modelVerifications.get(model.modelId);
    assert.ok(failedVerification);
    assert.equal(failedVerification.ownsDurableState, false);
    failingWorker.releaseVerification(model.modelId);
    await failedVerification.promise;
    assert.deepEqual(
      database.getAssetSemanticModelObservation(model.modelId, model.revision),
      beforeFailure,
      'non-owner SHA failure is not authority to mark a durable operation failed',
    );
  } finally {
    failurePipeline?.close();
    pipeline?.close();
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an equivalent concurrent download has one physical owner and external transient state blocks replace or delete', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-download-concurrent-owner-'));
  const config = testConfig(root);
  const filename = path.join(root, 'projects.sqlite3');
  const observerDatabase = new ProjectDatabase(filename, concurrentProjectDatabaseTestOptions());
  const winningDatabase = new ProjectDatabase(filename, concurrentProjectDatabaseTestOptions());
  const worker = new InterruptedDownloadWorker();
  const pipeline = new AssetSemanticPipeline(config, observerDatabase, {
    worker,
    autoStart: false,
    recover: false,
  });
  const model = getPublicSemanticModelManifest()[0];
  const request = {
    expectedRevision: 1,
    idempotencyKey: 'semantic-concurrent-download-owner',
  };
  const originalSync = observerDatabase.syncAssetSemanticModelObservations.bind(observerDatabase);
  let winningTransition = null;
  try {
    observerDatabase.syncAssetSemanticModelObservations = (observations, options) => {
      if (!winningTransition) {
        winningTransition = winningDatabase.syncAssetSemanticModelObservations(observations, options);
        assert.equal(winningTransition.changedCount, 1);
      }
      return originalSync(observations, options);
    };

    const replayed = await pipeline.startModelDownload(model.modelId, request);
    assert.equal(replayed.status, 'downloading');
    assert.equal(replayed.revision, 2);
    assert.equal(worker.downloadCalls, 0, 'the equivalent batch loser must not start a second physical worker');
    assert.equal(pipeline.downloads.has(model.modelId), false);
    const durable = observerDatabase.getAssetSemanticModelObservation(model.modelId, model.revision);

    observerDatabase.syncAssetSemanticModelObservations = originalSync;
    const sameKeyReplay = await pipeline.startModelDownload(model.modelId, request);
    assert.equal(sameKeyReplay.revision, durable.revision);
    assert.equal(worker.downloadCalls, 0);

    await assert.rejects(
      pipeline.startModelDownload(model.modelId, {
        expectedRevision: durable.revision,
        idempotencyKey: 'semantic-concurrent-download-replacement',
      }),
      (error) => error.code === 'asset-semantic-model-download-in-progress',
    );
    await assert.rejects(
      pipeline.removeModel(model.modelId, { expectedRevision: durable.revision }),
      (error) => error.code === 'asset-semantic-model-download-in-progress',
    );
    assert.deepEqual(
      observerDatabase.getAssetSemanticModelObservation(model.modelId, model.revision),
      durable,
    );
    assert.equal(worker.downloadCalls, 0);
  } finally {
    observerDatabase.syncAssetSemanticModelObservations = originalSync;
    pipeline.close();
    await winningDatabase.close();
    await observerDatabase.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an equivalent verification batch loser never gains durable owner authority', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-verification-concurrent-owner-'));
  const config = testConfig(root);
  const filename = path.join(root, 'projects.sqlite3');
  const observerDatabase = new ProjectDatabase(filename, concurrentProjectDatabaseTestOptions());
  const winningDatabase = new ProjectDatabase(filename, concurrentProjectDatabaseTestOptions());
  const worker = new GatedColdVerificationWorker();
  const pipeline = new AssetSemanticPipeline(config, observerDatabase, {
    worker,
    autoStart: false,
    recover: false,
  });
  const model = getPublicSemanticModelManifest()[0];
  const originalSync = observerDatabase.syncAssetSemanticModelObservations.bind(observerDatabase);
  let winningTransition = null;
  let losingChangedCount = null;
  try {
    observerDatabase.syncAssetSemanticModelObservations = (observations, options) => {
      if (!winningTransition) {
        winningTransition = winningDatabase.syncAssetSemanticModelObservations(observations, options);
        assert.equal(winningTransition.changedCount, 1);
      }
      const losingTransition = originalSync(observations, options);
      losingChangedCount = losingTransition.changedCount;
      return losingTransition;
    };

    const replayed = await pipeline.syncModelState(model.modelId);
    assert.equal(replayed.status, 'verifying');
    assert.equal(replayed.revision, 2);
    assert.equal(losingChangedCount, 0);
    await new Promise((resolve) => setImmediate(resolve));

    const verification = pipeline.modelVerifications.get(model.modelId);
    assert.ok(verification, 'the loser may still perform a read-only SHA check');
    assert.equal(verification.ownsDurableState, false, 'an equivalent no-op is not proof of durable ownership');
    await assert.rejects(
      pipeline.startModelDownload(model.modelId, {
        expectedRevision: replayed.revision,
        idempotencyKey: 'semantic-verification-loser-replacement',
      }),
      (error) => error.code === 'asset-semantic-model-download-in-progress',
    );
    await assert.rejects(
      pipeline.removeModel(model.modelId, { expectedRevision: replayed.revision }),
      (error) => error.code === 'asset-semantic-model-download-in-progress',
    );
    assert.equal(
      observerDatabase.getAssetSemanticModel(model.modelId, model.revision).status,
      'verifying',
    );
  } finally {
    observerDatabase.syncAssetSemanticModelObservations = originalSync;
    pipeline.close();
    await winningDatabase.close();
    await observerDatabase.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a new verification revision replaces an incompatible read-only task and retains owner failure authority', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-verification-owner-revision-'));
  const config = testConfig(root);
  const filename = path.join(root, 'projects.sqlite3');
  const databaseA = new ProjectDatabase(filename, concurrentProjectDatabaseTestOptions());
  const databaseB = new ProjectDatabase(filename, concurrentProjectDatabaseTestOptions());
  const model = getPublicSemanticModelManifest()[0];
  const workerA = new GatedColdVerificationWorker(model.modelId);
  const targetStatus = workerA.getModelStatus.bind(workerA);
  workerA.getModelStatus = (modelId) => (
    modelId === model.modelId ? targetStatus(modelId) : installedStatus(modelId)
  );
  const pipelineA = new AssetSemanticPipeline(config, databaseA, {
    worker: workerA,
    autoStart: false,
    recover: false,
  });
  const pipelineB = new AssetSemanticPipeline(config, databaseB, {
    worker: new FakeSemanticWorker(),
    autoStart: false,
    recover: false,
  });
  try {
    const seeded = databaseB.syncAssetSemanticModelObservations([{
      expected: null,
      state: {
        modelKey: model.modelId,
        modelVersion: model.revision,
        capability: model.task,
        status: 'verifying',
        downloadedBytes: model.downloadBytes,
        totalBytes: model.downloadBytes,
      },
    }]).models[0];
    assert.equal(seeded.revision, 2);

    await pipelineA.refreshModelStates();
    await new Promise((resolve) => setImmediate(resolve));
    const oldReadOnlyTask = pipelineA.modelVerifications.get(model.modelId);
    assert.ok(oldReadOnlyTask);
    assert.equal(oldReadOnlyTask.ownsDurableState, false);
    assert.equal(oldReadOnlyTask.expectedRevision, seeded.revision);

    const installed = await pipelineB.refreshModelStates();
    const installedModel = installed.models.find((candidate) => candidate.modelKey === model.modelId);
    assert.equal(installedModel.status, 'installed');
    assert.equal(installedModel.revision, 3);
    const removed = await pipelineB.removeModel(model.modelId, { expectedRevision: installedModel.revision });
    assert.equal(removed.status, 'not-installed');
    assert.equal(removed.revision, 5);

    const refreshed = await pipelineA.refreshModelStates();
    const verifying = refreshed.models.find((candidate) => candidate.modelKey === model.modelId);
    assert.equal(verifying.status, 'verifying');
    assert.equal(verifying.revision, 6);
    const ownerTask = pipelineA.modelVerifications.get(model.modelId);
    assert.ok(ownerTask);
    assert.notEqual(ownerTask, oldReadOnlyTask, 'a stale revision task must not swallow a new durable owner');
    assert.equal(ownerTask.ownsDurableState, true);
    assert.equal(ownerTask.expectedRevision, verifying.revision);

    for (let attempt = 0; attempt < 20 && !workerA.verificationGates.has(model.modelId); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(workerA.verificationGates.has(model.modelId), true);
    workerA.releaseVerification(model.modelId);
    await ownerTask.promise;
    const failed = databaseA.getAssetSemanticModel(model.modelId, model.revision);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.revision, 7);
    assert.equal(failed.errorCode, 'asset-semantic-model-hash-mismatch');
  } finally {
    pipelineB.close();
    pipelineA.close();
    await databaseB.close();
    await databaseA.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stale local download task cannot overwrite a newer durable owner identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-download-owner-replaced-'));
  const config = testConfig(root);
  const filename = path.join(root, 'projects.sqlite3');
  const databaseA = new ProjectDatabase(filename, concurrentProjectDatabaseTestOptions());
  const databaseB = new ProjectDatabase(filename, concurrentProjectDatabaseTestOptions());
  const workerA = new MutableInterruptedDownloadWorker();
  const workerB = new LateProgressDownloadWorker();
  const pipelineA = new AssetSemanticPipeline(config, databaseA, {
    worker: workerA,
    autoStart: false,
    recover: false,
  });
  const pipelineB = new AssetSemanticPipeline(config, databaseB, {
    worker: workerB,
    autoStart: false,
    recover: false,
  });
  const model = getPublicSemanticModelManifest()[0];
  try {
    const firstDownload = await pipelineA.startModelDownload(model.modelId, {
      expectedRevision: 1,
      idempotencyKey: 'semantic-download-old-owner-a',
    });
    assert.equal(firstDownload.status, 'downloading');
    assert.equal(firstDownload.revision, 2);
    assert.equal(pipelineA.downloads.has(model.modelId), true);

    workerB.downloadedModels.add(model.modelId);
    const installed = await pipelineB.refreshModelStates();
    const installedModel = installed.models.find((candidate) => candidate.modelKey === model.modelId);
    assert.equal(installedModel.status, 'installed');
    assert.equal(installedModel.revision, 3);

    const removed = await pipelineB.removeModel(model.modelId, { expectedRevision: installedModel.revision });
    assert.equal(removed.status, 'not-installed');
    assert.equal(removed.revision, 5);
    workerB.downloadedModels.delete(model.modelId);

    const replacement = await pipelineB.startModelDownload(model.modelId, {
      expectedRevision: removed.revision,
      idempotencyKey: 'semantic-download-new-owner-b',
    });
    assert.equal(replacement.status, 'downloading');
    assert.equal(replacement.revision, 6);
    assert.equal(pipelineB.downloads.has(model.modelId), true);
    const beforeStaleRefresh = databaseB.getAssetSemanticModelObservation(model.modelId, model.revision);

    workerA.setModelStatus(model.modelId, {
      ...notInstalledStatus(model.modelId),
      state: 'failed',
      error: { code: 'asset-semantic-old-worker-failed', message: 'old worker failed after replacement' },
    });
    await pipelineA.refreshModelStates();

    assert.deepEqual(
      databaseB.getAssetSemanticModelObservation(model.modelId, model.revision),
      beforeStaleRefresh,
      'a stale in-memory task must not own a durable row with another key/revision identity',
    );
    assert.equal(pipelineA.downloads.has(model.modelId), true);
    assert.equal(pipelineB.downloads.has(model.modelId), true);
  } finally {
    pipelineB.close();
    pipelineA.close();
    await databaseB.close();
    await databaseA.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
    assert.equal(initial.models.every((model) => model.status === 'not-installed' && model.revision === 1), true);
    assert.equal(database.listAssetSemanticModels().length, 0, 'reading status must not materialize model rows');

    const models = Object.fromEntries(getPublicSemanticModelManifest().map((model) => [model.task, model]));
    const profile = await pipeline.setProfile('project-semantic-a', {
      enabled: true,
      caption: { enabled: true, modelKey: models.caption.modelId, modelVersion: models.caption.revision },
      ocr: { enabled: true, modelKey: models.ocr.modelId, modelVersion: models.ocr.revision },
      embedding: { enabled: true, modelKey: models.embedding.modelId, modelVersion: models.embedding.revision },
    }, { expectedRevision: 0, updatedBy: 'test-owner' });
    assert.equal(profile.revision, 1);
    assert.equal((await pipeline.status('project-semantic-a')).models.every((model) => model.status === 'installed'), true);

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

test('an aborted verification loses durable authority before its promise settles', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-aborted-verification-owner-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const model = getPublicSemanticModelManifest().find((candidate) => candidate.task === 'caption');
  const worker = new DelayedAbortVerificationWorker(model.modelId);
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker,
    autoStart: false,
    recover: false,
  });
  try {
    const verifying = await pipeline.syncModelState(model.modelId);
    assert.equal(verifying.status, 'verifying');
    await worker.verifyStarted;

    const removal = pipeline.removeModel(model.modelId, { expectedRevision: verifying.revision });
    await worker.abortObserved;
    const cancelledTask = pipeline.modelVerifications.get(model.modelId);
    assert.ok(cancelledTask);
    assert.equal(cancelledTask.controller.signal.aborted, true);

    const refreshed = await pipeline.refreshModelStates();
    const targetAfterRefresh = database.getAssetSemanticModel(model.modelId, model.revision);
    assert.equal(targetAfterRefresh.status, 'verifying');
    assert.equal(targetAfterRefresh.revision, verifying.revision);
    assert.equal(
      refreshed.models.find((candidate) => candidate.modelKey === model.modelId).revision,
      verifying.revision,
    );

    worker.resolveAbortRelease();
    const removed = await removal;
    assert.equal(removed.status, 'not-installed');
    assert.equal(database.getAssetSemanticModel(model.modelId, model.revision).status, 'not-installed');
  } finally {
    worker.resolveAbortRelease();
    pipeline.close();
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a verification observation loses its exact owner token when cancellation wins before commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-verification-owner-toctou-'));
  const config = testConfig(root);
  const database = new ProjectDatabase(path.join(root, 'projects.sqlite3'), { autoBackup: false });
  const model = getPublicSemanticModelManifest().find((candidate) => candidate.task === 'caption');
  const worker = new DelayedAbortVerificationWorker(model.modelId);
  const pipeline = new AssetSemanticPipeline(config, database, {
    worker,
    autoStart: false,
    recover: false,
  });
  let removal = null;
  try {
    const verifying = await pipeline.syncModelState(model.modelId);
    assert.equal(verifying.status, 'verifying');
    await worker.verifyStarted;
    worker.reportFailure = true;

    const observeModelState = pipeline.observeModelState.bind(pipeline);
    let cancelBeforeCommit = true;
    pipeline.observeModelState = async (...args) => {
      const observation = await observeModelState(...args);
      if (cancelBeforeCommit && args[0] === model.modelId) {
        cancelBeforeCommit = false;
        queueMicrotask(() => {
          removal = pipeline.removeModel(model.modelId, { expectedRevision: verifying.revision });
        });
      }
      return observation;
    };

    const refreshed = await pipeline.syncModelState(model.modelId);
    await worker.abortObserved;
    assert.equal(refreshed.status, 'verifying');
    assert.equal(refreshed.revision, verifying.revision);
    assert.equal(database.getAssetSemanticModel(model.modelId, model.revision).revision, verifying.revision);

    worker.resolveAbortRelease();
    const removed = await removal;
    assert.equal(removed.status, 'not-installed');
    assert.equal(database.getAssetSemanticModel(model.modelId, model.revision).status, 'not-installed');
  } finally {
    worker.resolveAbortRelease();
    pipeline.close();
    if (removal) await removal.catch(() => {});
    await database.close();
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

test('model download idempotency survives restart without treating a missing in-memory owner as proof of interruption', async () => {
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
    assert.equal(restartReplay.status, 'downloading');
    assert.equal(restartReplay.revision, accepted.revision);
    assert.equal(restartReplay.errorCode, null);
    assert.equal(secondWorker.downloadCalls, 0, 'restart replay returns the persisted operation instead of duplicating it');
    assert.equal(restartReplay.downloadIdempotencyKey, 'model-download/response-loss/request-1');
    assert.equal(restartReplay.downloadRequestRevision, initial.revision);

    await assert.rejects(
      secondPipeline.startModelDownload(model.modelId, {
        expectedRevision: accepted.revision,
        idempotencyKey: 'model-download/explicit-retry/request-2',
      }),
      (error) => error.code === 'asset-semantic-model-download-in-progress'
        && error.current.revision === accepted.revision,
    );
    assert.equal(secondWorker.downloadCalls, 0, 'a new key cannot replace a durable operation without owner-death proof');
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
