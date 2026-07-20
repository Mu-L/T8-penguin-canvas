const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');
const { hashFile } = require('../backend/src/services/assetIndexer');
const { AssetPreviewPipeline } = require('../backend/src/services/assetPreviewPipeline');

function createConfig(directory) {
  const thumbnails = path.join(directory, 'thumbnails');
  const config = {
    INPUT_DIR: path.join(directory, 'input'),
    OUTPUT_DIR: path.join(directory, 'output'),
    THUMBNAILS_DIR: thumbnails,
    ASSET_PREVIEWS_DIR: path.join(thumbnails, 'asset-previews'),
    ASSET_PREVIEW_CONCURRENCY: 1,
    ASSET_PREVIEW_MAX_ATTEMPTS: 3,
    ASSET_PREVIEW_RETRY_BASE_MS: 10,
    ASSET_PREVIEW_PIPELINE_VERSION: 'asset-preview-capacity-b2',
  };
  Object.values(config)
    .filter((value) => typeof value === 'string' && path.isAbsolute(value))
    .forEach((directoryPath) => fs.mkdirSync(directoryPath, { recursive: true }));
  return config;
}

function rawCapacity(code, message = 'capacity failed at C:\\Users\\Alice\\private\\project.sqlite') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rawBusy(code = 'SQLITE_BUSY_TIMEOUT') {
  const error = new Error('database is locked at C:\\Users\\Alice\\private\\project.sqlite; SELECT secret FROM audit_events');
  error.code = code;
  return error;
}

function emptyCounts(overrides = {}) {
  return {
    queued: 0,
    running: 0,
    retrying: 0,
    succeeded: 0,
    failed: 0,
    ...overrides,
  };
}

function minimalDatabase(overrides = {}) {
  return {
    recoverAssetPreviewJobs: () => ({ recovered: 0, failed: 0 }),
    claimNextAssetPreviewJob: () => null,
    getAssetPreviewJobStatus: () => ({ counts: emptyCounts() }),
    ...overrides,
  };
}

function insertAsset(database, input) {
  return database.upsertAsset({
    id: input.id,
    projectId: 'asset-preview-capacity-b2',
    contentHash: input.contentHash,
    kind: input.kind || 'image',
    mimeType: input.mimeType || 'image/png',
    filename: path.basename(input.managedPath),
    managedPath: input.managedPath,
    sourceUrl: `/files/input/${path.basename(input.managedPath)}`,
    storageMode: 'managed',
    availability: 'available',
    metadata: { previewStatus: 'queued' },
  });
}

function previewMutationInput(claimed, input = {}) {
  return {
    ...input,
    expectedAttempt: claimed,
    expectedAssetSnapshot: claimed.availabilitySnapshot,
  };
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

test('project-bound preview status isolates A/B activity and pending work while labeling global worker limits', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-project-status-'));
  const jobs = [
    { id: 'job-project-a', projectId: 'project/a', jobKind: 'image-preview' },
    { id: 'job-project-b', projectId: 'project/b', jobKind: 'model3d-preview' },
  ];
  let claimIndex = 0;
  let releaseA;
  let releaseB;
  const blockedA = new Promise((resolve) => { releaseA = resolve; });
  const blockedB = new Promise((resolve) => { releaseB = resolve; });
  const database = minimalDatabase({
    claimNextAssetPreviewJob() { return jobs[claimIndex++] || null; },
    getAssetPreviewJobStatus(filters = {}) {
      return {
        counts: emptyCounts(filters.projectId === 'project/a'
          ? { succeeded: 1 }
          : filters.projectId === 'project/b'
            ? { failed: 2 }
            : { succeeded: 1, failed: 2 }),
      };
    },
  });
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, {
    autoStart: false,
    recover: false,
    concurrency: 2,
  });
  pipeline.runPersistentJob = (job) => job.projectId === 'project/a' ? blockedA : blockedB;
  try {
    pipeline.pump();
    assert.equal(pipeline.active, 2);
    pipeline.pendingCompletions.set('completion-a', { job: jobs[0], result: {} });
    pipeline.pendingReschedules.set('reschedule-b', { job: jobs[1], error: {}, options: {} });
    pipeline.pendingReruns.set('rerun-a', { ...jobs[0], id: 'rerun-project-a' });
    pipeline.status('project/a');
    pipeline.status('project/b');
    pipeline.recordStoragePressure(rawCapacity('SQLITE_FULL'), 'asset.preview.status', { schedule: false });

    const statusA = pipeline.status('project/a');
    const statusB = pipeline.status('project/b');
    assert.equal(statusA.projectId, 'project/a');
    assert.equal(statusB.projectId, 'project/b');
    assert.equal(statusA.active, 1);
    assert.equal(statusB.active, 1);
    assert.equal(statusA.activeModel3d, 0);
    assert.equal(statusB.activeModel3d, 1);
    assert.deepEqual(statusA.pending, { completions: 1, reschedules: 0, reruns: 1 });
    assert.deepEqual(statusB.pending, { completions: 0, reschedules: 1, reruns: 0 });
    assert.equal(statusA.counts.succeeded, 1);
    assert.equal(statusA.counts.failed, 0);
    assert.equal(statusB.counts.succeeded, 0);
    assert.equal(statusB.counts.failed, 2);
    assert.equal(statusA.concurrency, 2);
    assert.equal(statusA.concurrencyScope, 'global');
    assert.equal(statusA.storagePressure.scope, 'global');
    assert.equal(Object.hasOwn(statusA.pending, 'recovery'), false);
    assert.equal(pipeline.status().active, 2, 'the internal unscoped status remains global');
  } finally {
    pipeline.close();
    releaseA();
    releaseB();
    await waitUntil(() => pipeline.active === 0);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

for (const fixture of [
  {
    name: 'typed capacity',
    error: new ProjectDatabaseStorageCapacityError('wal-pressure', { operation: 'asset.preview.claim' }),
    reason: 'wal-pressure',
  },
  {
    name: 'raw SQLITE_FULL',
    error: rawCapacity('SQLITE_FULL', 'database or disk is full at C:\\Users\\Alice\\private\\project.sqlite'),
    reason: 'sqlite-full',
  },
  {
    name: 'raw ENOSPC',
    error: rawCapacity('ENOSPC'),
    reason: 'filesystem-reserve',
  },
  {
    name: 'raw EDQUOT',
    error: rawCapacity('EDQUOT'),
    reason: 'filesystem-reserve',
  },
]) {
  test(`timer pump contains ${fixture.name} claim failures and exposes only safe storage pressure`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-claim-capacity-'));
    const database = minimalDatabase({
      claimNextAssetPreviewJob() { throw fixture.error; },
    });
    const pipeline = new AssetPreviewPipeline(createConfig(directory), database, {
      autoStart: false,
      recover: false,
      storageRetryBaseMs: 10,
      storageRetryMaxMs: 20,
    });
    try {
      assert.doesNotThrow(() => pipeline.pump());
      const status = pipeline.status();
      assert.equal(status.storagePressure.active, true);
      assert.equal(status.storagePressure.reason, fixture.reason);
      assert.equal(typeof status.storagePressure.retryable, 'boolean');
      assert.equal(Number.isFinite(status.storagePressure.nextRetryAt), true);
      assert.deepEqual(Object.keys(status.storagePressure).sort(), [
        'active',
        'nextRetryAt',
        'reason',
        'retryable',
      ]);
      const serialized = JSON.stringify(status);
      assert.equal(serialized.includes('Alice'), false);
      assert.equal(serialized.includes('project.sqlite'), false);
      assert.equal(serialized.includes(fixture.error.message), false);
    } finally {
      pipeline.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('claim capacity retries use bounded exponential backoff instead of a tight loop', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-claim-backoff-'));
  let claims = 0;
  const database = minimalDatabase({
    claimNextAssetPreviewJob() {
      claims += 1;
      throw rawCapacity('SQLITE_FULL');
    },
  });
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, {
    autoStart: false,
    recover: false,
    storageRetryBaseMs: 10,
    storageRetryMaxMs: 40,
  });
  try {
    pipeline.schedulePump();
    await new Promise((resolve) => setTimeout(resolve, 95));
    assert.equal(claims >= 3, true, 'the background worker should retry after pressure');
    assert.equal(claims <= 6, true, `bounded backoff should not spin (claims=${claims})`);
    assert.equal(pipeline.status().storagePressure.active, true);
  } finally {
    pipeline.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('timer claim BUSY uses a separate safe bounded backoff without becoming storage pressure', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-claim-busy-'));
  let claims = 0;
  const database = minimalDatabase({
    claimNextAssetPreviewJob() {
      claims += 1;
      throw rawBusy(claims % 2 === 0 ? 'SQLITE_BUSY' : 'SQLITE_BUSY_TIMEOUT');
    },
  });
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, {
    autoStart: false,
    recover: false,
    databaseBusyRetryBaseMs: 10,
    databaseBusyRetryMaxMs: 40,
  });
  try {
    pipeline.schedulePump();
    await new Promise((resolve) => setTimeout(resolve, 95));
    assert.equal(claims >= 3, true);
    assert.equal(claims <= 6, true, `BUSY retries must not spin (claims=${claims})`);
    const status = pipeline.status();
    assert.deepEqual(Object.keys(status.databaseBusy).sort(), ['active', 'code', 'nextRetryAt']);
    assert.equal(status.databaseBusy.active, true);
    assert.equal(status.databaseBusy.code, 'project_database_busy');
    assert.equal(Number.isFinite(status.databaseBusy.nextRetryAt), true);
    assert.equal(Object.hasOwn(status, 'storagePressure'), false);
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes('Alice'), false);
    assert.equal(serialized.includes('SELECT'), false);
    assert.equal(serialized.includes('audit_events'), false);
  } finally {
    pipeline.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('pump-tail and public status reads contain BUSY with a cached safe status and bounded retries', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-status-busy-'));
  let locked = true;
  let statusReads = 0;
  const database = minimalDatabase({
    getAssetPreviewJobStatus() {
      statusReads += 1;
      if (locked) throw rawBusy();
      return { counts: emptyCounts({ succeeded: 2 }) };
    },
  });
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, {
    autoStart: false,
    recover: false,
    databaseBusyRetryBaseMs: 40,
    databaseBusyRetryMaxMs: 40,
  });
  try {
    assert.doesNotThrow(() => pipeline.pump(), 'the timer tail must contain a recoverable status read');
    const stale = pipeline.status();
    assert.deepEqual(stale.counts, emptyCounts());
    assert.equal(stale.databaseStatusStale, true);
    assert.equal(stale.databaseBusy.code, 'project_database_busy');
    assert.equal(JSON.stringify(stale).includes('Alice'), false);
    assert.equal(JSON.stringify(stale).includes('audit_events'), false);
    for (let index = 0; index < 8; index += 1) pipeline.status();
    assert.equal(statusReads, 1, 'public polling must reuse the safe cache during backoff');

    locked = false;
    assert.equal(await waitUntil(() => pipeline.status().databaseStatusStale !== true, 1_000), true);
    assert.equal(pipeline.status().counts.succeeded, 2);
    assert.equal(statusReads <= 4, true, `status recovery must remain bounded (reads=${statusReads})`);
  } finally {
    pipeline.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('public status reads contain storage capacity errors without exposing the raw failure', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-status-capacity-'));
  let statusReads = 0;
  const database = minimalDatabase({
    getAssetPreviewJobStatus() {
      statusReads += 1;
      throw rawCapacity('SQLITE_FULL', 'full at C:\\Users\\Alice\\private\\status.sqlite; SELECT secret');
    },
  });
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, {
    autoStart: false,
    recover: false,
    storageRetryBaseMs: 100,
    storageRetryMaxMs: 100,
  });
  try {
    const status = pipeline.status();
    assert.equal(status.databaseStatusStale, true);
    assert.deepEqual(status.counts, emptyCounts());
    assert.equal(status.storagePressure.reason, 'sqlite-full');
    assert.equal(status.storagePressure.active, true);
    assert.equal(JSON.stringify(status).includes('Alice'), false);
    assert.equal(JSON.stringify(status).includes('SELECT secret'), false);
    pipeline.status();
    pipeline.status();
    assert.equal(statusReads, 1, 'capacity backoff must reuse the last safe status');
  } finally {
    pipeline.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('waitForIdle respects BUSY backoff, never reports stale counts as idle, and recovers', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-idle-status-busy-'));
  let statusReads = 0;
  const database = minimalDatabase({
    getAssetPreviewJobStatus() {
      statusReads += 1;
      if (statusReads <= 2) throw rawBusy();
      return { counts: emptyCounts() };
    },
  });
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, {
    autoStart: false,
    recover: false,
    databaseBusyRetryBaseMs: 15,
    databaseBusyRetryMaxMs: 30,
  });
  try {
    const startedAt = Date.now();
    assert.equal(await pipeline.waitForIdle(1_000), true);
    assert.equal(Date.now() - startedAt >= 20, true, 'idle must wait through the BUSY retry window');
    assert.equal(statusReads >= 3, true);
    assert.equal(statusReads <= 6, true, `waitForIdle must not spin on status reads (reads=${statusReads})`);
    assert.equal(Object.hasOwn(pipeline.status(), 'databaseStatusStale'), false);
  } finally {
    pipeline.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('close cancels a pending capacity retry', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-claim-close-'));
  let claims = 0;
  const database = minimalDatabase({
    claimNextAssetPreviewJob() {
      claims += 1;
      throw rawCapacity('SQLITE_FULL');
    },
  });
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, {
    autoStart: false,
    recover: false,
    storageRetryBaseMs: 10,
    storageRetryMaxMs: 20,
  });
  try {
    pipeline.pump();
    assert.equal(claims, 1);
    pipeline.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(claims, 1);
  } finally {
    pipeline.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('non-capacity claim failures still escape the pump boundary', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-claim-fatal-'));
  const fatal = new Error('preview database programming defect');
  fatal.code = 'SQLITE_LOCKED';
  const database = minimalDatabase({
    claimNextAssetPreviewJob() { throw fatal; },
  });
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, {
    autoStart: false,
    recover: false,
  });
  try {
    assert.throws(() => pipeline.pump(), (error) => error === fatal);
    assert.equal(Object.hasOwn(pipeline.status(), 'storagePressure'), false);
  } finally {
    pipeline.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('complete capacity preserves the generated result for exact retry without another attempt', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-complete-capacity-'));
  const config = createConfig(directory);
  const source = path.join(config.INPUT_DIR, 'complete-source.bin');
  fs.writeFileSync(source, 'complete-source-content');
  const contentHash = await hashFile(source);
  const database = new ProjectDatabase(':memory:');
  const result = Object.freeze({
    thumbnailUrl: '/files/thumbnails/asset-previews/exact-result.webp',
    perceptualHash: '0123456789abcdef',
  });
  let generationCalls = 0;
  let pressure = true;
  const completionResults = [];
  const originalComplete = database.completeAssetPreviewJob.bind(database);
  database.completeAssetPreviewJob = (jobId, candidate, input) => {
    completionResults.push(candidate);
    if (pressure) throw rawCapacity('SQLITE_FULL');
    return originalComplete(jobId, candidate, input);
  };
  const pipeline = new AssetPreviewPipeline(config, database, {
    autoStart: false,
    recover: false,
    storageRetryBaseMs: 10,
    storageRetryMaxMs: 20,
    createDerivedMedia: async () => {
      generationCalls += 1;
      return result;
    },
  });
  try {
    const asset = insertAsset(database, { id: 'asset-complete-capacity', contentHash, managedPath: source });
    const job = database.enqueueAssetPreviewJob({
      id: 'job-complete-capacity',
      assetId: asset.id,
      contentHash,
      jobKind: 'image-preview',
      pipelineVersion: pipeline.pipelineVersion,
    });
    const claimed = database.claimNextAssetPreviewJob();
    await pipeline.runPersistentJob(claimed);

    assert.equal(generationCalls, 1);
    assert.equal(database.getAssetPreviewJob(job.id).status, 'running');
    assert.equal(database.getAssetPreviewJob(job.id).attemptCount, 1);
    assert.equal(pipeline.status().pending.completions, 1);
    assert.equal(await pipeline.waitForIdle(110), false, 'pending completion must not report idle');

    pressure = false;
    assert.equal(await waitUntil(() => database.getAssetPreviewJob(job.id).status === 'succeeded'), true);
    assert.equal(generationCalls, 1, 'durable completion retry must not regenerate media');
    assert.equal(database.getAssetPreviewJob(job.id).attemptCount, 1, 'capacity retry must not consume an attempt');
    assert.equal(database.getAsset(asset.id).metadata.thumbnailUrl, result.thumbnailUrl);
    assert.equal(completionResults.length >= 2, true);
    completionResults.forEach((candidate) => assert.strictEqual(candidate, result));
    const status = pipeline.status();
    assert.equal(status.pending.completions, 0);
    assert.equal(Object.hasOwn(status, 'storagePressure'), false);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('complete BUSY preserves the exact generated result and claimed attempt', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-complete-busy-'));
  const config = createConfig(directory);
  const source = path.join(config.INPUT_DIR, 'complete-busy-source.bin');
  fs.writeFileSync(source, 'complete-busy-source-content');
  const contentHash = await hashFile(source);
  const database = new ProjectDatabase(':memory:');
  const result = Object.freeze({
    thumbnailUrl: '/files/thumbnails/asset-previews/exact-busy-result.webp',
    perceptualHash: 'fedcba9876543210',
  });
  let generationCalls = 0;
  let busy = true;
  const completionResults = [];
  const originalComplete = database.completeAssetPreviewJob.bind(database);
  database.completeAssetPreviewJob = (jobId, candidate, input) => {
    completionResults.push(candidate);
    if (busy) throw rawBusy();
    return originalComplete(jobId, candidate, input);
  };
  const pipeline = new AssetPreviewPipeline(config, database, {
    autoStart: false,
    recover: false,
    databaseBusyRetryBaseMs: 10,
    databaseBusyRetryMaxMs: 20,
    createDerivedMedia: async () => {
      generationCalls += 1;
      return result;
    },
  });
  try {
    const asset = insertAsset(database, { id: 'asset-complete-busy', contentHash, managedPath: source });
    const job = database.enqueueAssetPreviewJob({
      id: 'job-complete-busy',
      assetId: asset.id,
      contentHash,
      jobKind: 'image-preview',
      pipelineVersion: pipeline.pipelineVersion,
    });
    await pipeline.runPersistentJob(database.claimNextAssetPreviewJob());

    assert.equal(database.getAssetPreviewJob(job.id).status, 'running');
    assert.equal(database.getAssetPreviewJob(job.id).attemptCount, 1);
    assert.equal(pipeline.status().pending.completions, 1);
    assert.equal(pipeline.status().databaseBusy.code, 'project_database_busy');
    assert.equal(Object.hasOwn(pipeline.status(), 'storagePressure'), false);
    assert.equal(await pipeline.waitForIdle(110), false);

    busy = false;
    assert.equal(await waitUntil(() => database.getAssetPreviewJob(job.id).status === 'succeeded'), true);
    assert.equal(generationCalls, 1);
    assert.equal(database.getAssetPreviewJob(job.id).attemptCount, 1);
    assert.equal(database.getAsset(asset.id).metadata.thumbnailUrl, result.thumbnailUrl);
    assert.equal(completionResults.length >= 2, true);
    completionResults.forEach((candidate) => assert.strictEqual(candidate, result));
    assert.equal(Object.hasOwn(pipeline.status(), 'databaseBusy'), false);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('claim-time asset snapshot read BUSY rolls back the claim without consuming an attempt', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-asset-read-busy-'));
  const config = createConfig(directory);
  const source = path.join(config.INPUT_DIR, 'asset-read-busy-source.bin');
  fs.writeFileSync(source, 'asset-read-busy-source-content');
  const contentHash = await hashFile(source);
  const database = new ProjectDatabase(':memory:');
  const originalGetAsset = database.getAsset.bind(database);
  let assetReads = 0;
  let generationCalls = 0;
  const pipeline = new AssetPreviewPipeline(config, database, {
    autoStart: false,
    recover: false,
    databaseBusyRetryBaseMs: 10,
    databaseBusyRetryMaxMs: 20,
    createDerivedMedia: async () => {
      generationCalls += 1;
      return { thumbnailUrl: '/files/thumbnails/asset-previews/post-claim-busy.webp' };
    },
  });
  try {
    const asset = insertAsset(database, { id: 'asset-post-claim-read-busy', contentHash, managedPath: source });
    const job = database.enqueueAssetPreviewJob({
      id: 'job-post-claim-read-busy',
      assetId: asset.id,
      contentHash,
      jobKind: 'image-preview',
      pipelineVersion: pipeline.pipelineVersion,
    });
    database.getAsset = (assetId) => {
      assetReads += 1;
      if (assetReads === 1) throw rawBusy();
      return originalGetAsset(assetId);
    };
    assert.throws(
      () => database.claimNextAssetPreviewJob(),
      (error) => error?.code === 'SQLITE_BUSY_TIMEOUT',
    );
    assert.equal(database.getAssetPreviewJob(job.id).status, 'queued');
    assert.equal(database.getAssetPreviewJob(job.id).attemptCount, 0);
    const claimed = database.claimNextAssetPreviewJob();
    await pipeline.runPersistentJob(claimed);
    assert.equal(database.getAssetPreviewJob(job.id).status, 'succeeded');
    assert.equal(database.getAssetPreviewJob(job.id).attemptCount, 1);
    assert.equal(generationCalls, 1);
    assert.equal(pipeline.status().pending.reruns, 0);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a claimed job without its frozen asset snapshot is terminally rescheduled without an unfenced read', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-missing-read-busy-'));
  const job = {
    id: 'job-missing-read-busy',
    assetId: 'asset-missing-read-busy',
    attemptCount: 1,
    jobKind: 'image-preview',
  };
  let state = 'running';
  const reschedules = [];
  const database = minimalDatabase({
    rescheduleAssetPreviewJob(jobId, error, options) {
      reschedules.push({ jobId, error, options });
      state = 'failed';
      return { ...job, status: state };
    },
    getAssetPreviewJobStatus: () => ({ counts: emptyCounts({ [state]: 1 }) }),
  });
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, {
    autoStart: false,
    recover: false,
    databaseBusyRetryBaseMs: 10,
    databaseBusyRetryMaxMs: 20,
  });
  try {
    await pipeline.runPersistentJob(job);
    assert.equal(state, 'failed');
    assert.equal(reschedules.length, 1);
    assert.equal(reschedules[0].error.code, 'asset-preview-source-snapshot-missing');
    assert.equal(reschedules[0].options.retryable, true);
    assert.strictEqual(reschedules[0].options.expectedAttempt, job);
    assert.equal(reschedules[0].options.expectedAssetSnapshot, undefined);
  } finally {
    pipeline.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const fixture of [
  {
    name: 'typed',
    error: () => new ProjectDatabaseStorageCapacityError('main-page-limit', {
      operation: 'asset.preview.reschedule',
    }),
    reason: 'main-page-limit',
  },
  {
    name: 'raw',
    error: () => rawCapacity('SQLITE_FULL', 'full at C:\\Users\\Alice\\private\\availability.sqlite'),
    reason: 'sqlite-full',
  },
]) {
  test(`${fixture.name} intermediate writer capacity reruns the same claimed job without another attempt`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-writer-rerun-'));
    const config = createConfig(directory);
    const missingSource = path.join(config.INPUT_DIR, 'missing-source.bin');
    const database = new ProjectDatabase(':memory:');
    let pressure = true;
    let availabilityWrites = 0;
    let generationCalls = 0;
    const originalReschedule = database.rescheduleAssetPreviewJob.bind(database);
    database.rescheduleAssetPreviewJob = (...args) => {
      if (args[2]?.availabilityObservation) {
        availabilityWrites += 1;
        if (pressure) throw fixture.error();
      }
      return originalReschedule(...args);
    };
    const pipeline = new AssetPreviewPipeline(config, database, {
      autoStart: false,
      recover: false,
      storageRetryBaseMs: 10,
      storageRetryMaxMs: 20,
      createDerivedMedia: async () => {
        generationCalls += 1;
        return { thumbnailUrl: '/files/thumbnails/should-not-run.webp' };
      },
    });
    try {
      const asset = insertAsset(database, {
        id: `asset-writer-rerun-${fixture.name}`,
        contentHash: 'a'.repeat(64),
        managedPath: missingSource,
      });
      const job = database.enqueueAssetPreviewJob({
        id: `job-writer-rerun-${fixture.name}`,
        assetId: asset.id,
        contentHash: asset.contentHash,
        jobKind: 'image-preview',
        pipelineVersion: pipeline.pipelineVersion,
      });
      const claimed = database.claimNextAssetPreviewJob();
      await pipeline.runPersistentJob(claimed);
      assert.equal(database.getAssetPreviewJob(job.id).status, 'running');
      assert.equal(database.getAssetPreviewJob(job.id).attemptCount, 1);
      assert.equal(pipeline.status().pending.reschedules, 1);
      assert.equal(pipeline.status().storagePressure.reason, fixture.reason);
      assert.equal(JSON.stringify(pipeline.status()).includes('Alice'), false);
      assert.equal(await pipeline.waitForIdle(110), false);

      pressure = false;
      assert.equal(await waitUntil(() => database.getAssetPreviewJob(job.id).status === 'failed'), true);
      const settled = database.getAssetPreviewJob(job.id);
      assert.equal(settled.attemptCount, 1, 'the exact claimed attempt must be reused');
      assert.equal(settled.errorCode, 'source-missing');
      assert.equal(database.getAsset(asset.id).availability, 'missing');
      assert.equal(generationCalls, 0);
      assert.equal(availabilityWrites >= 2, true);
      assert.equal(pipeline.status().pending.reschedules, 0);
      assert.equal(Object.hasOwn(pipeline.status(), 'storagePressure'), false);
    } finally {
      pipeline.close();
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('an unrelated atomic availability/reschedule writer error escapes and leaves durable state unchanged', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-writer-non-capacity-'));
  const config = createConfig(directory);
  const missingSource = path.join(config.INPUT_DIR, 'missing-source.bin');
  const database = new ProjectDatabase(':memory:');
  const pipeline = new AssetPreviewPipeline(config, database, {
    autoStart: false,
    recover: false,
    createDerivedMedia: async () => {
      throw new Error('generation must not run');
    },
  });
  try {
    const asset = insertAsset(database, {
      id: 'asset-writer-non-capacity',
      contentHash: 'b'.repeat(64),
      managedPath: missingSource,
    });
    const job = database.enqueueAssetPreviewJob({
      id: 'job-writer-non-capacity',
      assetId: asset.id,
      contentHash: asset.contentHash,
      jobKind: 'image-preview',
      pipelineVersion: pipeline.pipelineVersion,
      maxAttempts: 1,
    });
    database.rescheduleAssetPreviewJob = () => {
      const error = new Error('ordinary availability writer failure');
      error.code = 'availability-writer-failed';
      throw error;
    };
    await assert.rejects(
      pipeline.runPersistentJob(database.claimNextAssetPreviewJob()),
      (error) => error?.code === 'availability-writer-failed',
    );
    const settled = database.getAssetPreviewJob(job.id);
    assert.equal(settled.status, 'running');
    assert.equal(settled.errorCode, null);
    assert.equal(settled.attemptCount, 1);
    assert.equal(database.getAsset(asset.id).availability, 'available');
    assert.equal(pipeline.status().pending.reruns, 0);
    assert.equal(Object.hasOwn(pipeline.status(), 'storagePressure'), false);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('pending reruns retain the global concurrency bound and the exclusive model3d slot', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-rerun-slots-'));
  const database = minimalDatabase();
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, {
    concurrency: 3,
    autoStart: false,
    recover: false,
    storageRetryBaseMs: 10,
    storageRetryMaxMs: 40,
  });
  let active = 0;
  let maximumActive = 0;
  let activeModels = 0;
  let maximumModels = 0;
  let imageOverlappedModel = false;
  pipeline.runPersistentJob = async (job) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (job.jobKind === 'model3d-preview') {
      activeModels += 1;
      maximumModels = Math.max(maximumModels, activeModels);
    } else if (activeModels > 0) {
      imageOverlappedModel = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (job.jobKind === 'model3d-preview') activeModels -= 1;
    active -= 1;
  };
  try {
    pipeline.deferRerun({ id: 'rerun-model-one', jobKind: 'model3d-preview' }, rawCapacity('SQLITE_FULL'));
    pipeline.deferRerun({ id: 'rerun-model-two', jobKind: 'model3d-preview' }, rawCapacity('SQLITE_FULL'));
    pipeline.deferRerun({ id: 'rerun-image', jobKind: 'image-preview' }, rawCapacity('SQLITE_FULL'));
    assert.equal(await pipeline.waitForIdle(2_000), true);
    assert.equal(maximumActive <= 3, true);
    assert.equal(maximumModels, 1);
    assert.equal(imageOverlappedModel, true);
    assert.equal(pipeline.status().pending.reruns, 0);
  } finally {
    pipeline.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reschedule capacity retains the exact safe write and eventually releases a running job', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-reschedule-capacity-'));
  const config = createConfig(directory);
  const source = path.join(config.INPUT_DIR, 'reschedule-source.bin');
  fs.writeFileSync(source, 'reschedule-source-content');
  const contentHash = await hashFile(source);
  const database = new ProjectDatabase(':memory:');
  let pressure = true;
  let generationCalls = 0;
  const calls = [];
  const originalReschedule = database.rescheduleAssetPreviewJob.bind(database);
  database.rescheduleAssetPreviewJob = (jobId, error, options) => {
    calls.push({ jobId, error, options });
    if (pressure) throw rawCapacity('ENOSPC');
    return originalReschedule(jobId, error, options);
  };
  const pipeline = new AssetPreviewPipeline(config, database, {
    autoStart: false,
    recover: false,
    retryBaseMs: 60_000,
    storageRetryBaseMs: 10,
    storageRetryMaxMs: 20,
    createDerivedMedia: async () => {
      generationCalls += 1;
      const error = new Error('renderer failed at C:\\Users\\Alice\\private\\frame.png');
      error.code = 'renderer-transient';
      throw error;
    },
  });
  try {
    const asset = insertAsset(database, { id: 'asset-reschedule-capacity', contentHash, managedPath: source });
    const job = database.enqueueAssetPreviewJob({
      id: 'job-reschedule-capacity',
      assetId: asset.id,
      contentHash,
      jobKind: 'image-preview',
      pipelineVersion: pipeline.pipelineVersion,
    });
    await pipeline.runPersistentJob(database.claimNextAssetPreviewJob());
    assert.equal(database.getAssetPreviewJob(job.id).status, 'running');
    assert.equal(pipeline.status().pending.reschedules, 1);
    assert.equal(JSON.stringify(pipeline.status()).includes('Alice'), false);

    pressure = false;
    assert.equal(await waitUntil(() => database.getAssetPreviewJob(job.id).status === 'retrying'), true);
    assert.equal(database.getAssetPreviewJob(job.id).attemptCount, 1);
    assert.equal(generationCalls, 1);
    assert.equal(calls.length >= 2, true);
    assert.strictEqual(calls[0].error, calls.at(-1).error);
    assert.equal(calls[0].options.retryable, calls.at(-1).options.retryable);
    assert.equal(calls[0].options.nextAttemptAt, calls.at(-1).options.nextAttemptAt);
    assert.strictEqual(calls[0].options.expectedAttempt, calls.at(-1).options.expectedAttempt);
    assert.strictEqual(calls[0].options.expectedAssetSnapshot, calls.at(-1).options.expectedAssetSnapshot);
    assert.equal(calls.at(-1).error.message.includes('Alice'), false);
    assert.equal(pipeline.status().pending.reschedules, 0);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('missing-asset reschedule capacity remains pending and replays the exact terminal write', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-missing-capacity-'));
  const job = { id: 'job-missing-capacity', assetId: 'asset-gone', attemptCount: 1 };
  let pressure = true;
  let state = 'running';
  const calls = [];
  const database = minimalDatabase({
    getAsset: () => null,
    getAssetPreviewJob: () => (state === 'missing' ? null : { ...job, status: state }),
    rescheduleAssetPreviewJob(jobId, error, options) {
      calls.push({ jobId, error, options });
      if (pressure) throw rawCapacity('EDQUOT');
      state = 'failed';
      return { ...job, status: state };
    },
    getAssetPreviewJobStatus: () => ({ counts: emptyCounts({ [state]: 1 }) }),
  });
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, {
    autoStart: false,
    recover: false,
    storageRetryBaseMs: 10,
    storageRetryMaxMs: 20,
  });
  try {
    await pipeline.runPersistentJob(job);
    assert.equal(state, 'running');
    assert.equal(pipeline.status().pending.reschedules, 1);
    pressure = false;
    assert.equal(await waitUntil(() => state === 'failed'), true);
    assert.equal(calls.length >= 2, true);
    assert.strictEqual(calls[0].error, calls.at(-1).error);
    assert.equal(calls[0].options.retryable, calls.at(-1).options.retryable);
    assert.equal(calls[0].options.nextAttemptAt, calls.at(-1).options.nextAttemptAt);
    assert.strictEqual(calls[0].options.expectedAttempt, calls.at(-1).options.expectedAttempt);
    assert.strictEqual(calls[0].options.expectedAssetSnapshot, calls.at(-1).options.expectedAssetSnapshot);
    assert.equal(calls.at(-1).error.code, 'asset-preview-source-snapshot-missing');
    assert.equal(calls.at(-1).options.retryable, true);
    assert.equal(pipeline.status().pending.reschedules, 0);
  } finally {
    pipeline.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('startup recovery degrades on capacity and retries, while unrelated failures still throw', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-recovery-capacity-'));
  let recoverCalls = 0;
  const database = minimalDatabase({
    recoverAssetPreviewJobs() {
      recoverCalls += 1;
      if (recoverCalls === 1) {
        throw new ProjectDatabaseStorageCapacityError('temp-storage-full', {
          operation: 'asset.preview.recover',
        });
      }
      return { recovered: 2, failed: 1 };
    },
  });
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, {
    storageRetryBaseMs: 10,
    storageRetryMaxMs: 20,
  });
  try {
    assert.deepEqual(pipeline.recovery, { recovered: 0, failed: 0, pending: true });
    assert.equal(pipeline.status().pending.recovery, true);
    assert.equal(pipeline.status().storagePressure.reason, 'temp-storage-full');
    assert.equal(await waitUntil(() => pipeline.pendingRecovery === false), true);
    assert.deepEqual(pipeline.recovery, { recovered: 2, failed: 1 });
    assert.equal(Object.hasOwn(pipeline.status(), 'storagePressure'), false);
  } finally {
    pipeline.close();
  }

  const fatal = new Error('recovery invariant broken');
  assert.throws(
    () => new AssetPreviewPipeline(createConfig(directory), minimalDatabase({
      recoverAssetPreviewJobs() { throw fatal; },
    }), { autoStart: false }),
    (error) => error === fatal,
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test('graceful shutdown rejects queued/new ephemeral work but drains the active task without new claims', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-shutdown-ephemeral-'));
  let claims = 0;
  const database = minimalDatabase({
    claimNextAssetPreviewJob() {
      claims += 1;
      return null;
    },
  });
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, {
    concurrency: 1,
    autoStart: false,
    recover: false,
  });
  let releaseActive;
  let markActive;
  const activeGate = new Promise((resolve) => { releaseActive = resolve; });
  const activeStarted = new Promise((resolve) => { markActive = resolve; });
  let queuedRan = false;
  try {
    const active = pipeline.runEphemeral(async () => {
      markActive();
      await activeGate;
      return 'active-finished';
    });
    await activeStarted;
    const queued = pipeline.runEphemeral(async () => {
      queuedRan = true;
    });
    const queuedRejection = assert.rejects(
      queued,
      (error) => error?.code === 'asset-preview-shutting-down',
    );
    const claimsBeforeShutdown = claims;
    let shutdownSettled = false;
    const shutdown = pipeline.shutdown().then((result) => {
      shutdownSettled = true;
      return result;
    });
    await queuedRejection;
    await assert.rejects(
      pipeline.runEphemeral(async () => {}),
      (error) => error?.code === 'asset-preview-shutting-down',
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(shutdownSettled, false, 'shutdown must wait for already-active work');
    releaseActive();
    assert.equal(await active, 'active-finished');
    assert.deepEqual(await shutdown, { drained: true });
    assert.equal(pipeline.closed, true);
    assert.equal(queuedRan, false);
    assert.equal(claims, claimsBeforeShutdown, 'shutdown must not claim another persistent job');
  } finally {
    releaseActive();
    pipeline.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('bounded shutdown force-closes a hung renderer and fences every late ProjectDatabase write', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-shutdown-timeout-'));
  const config = createConfig(directory);
  const source = path.join(config.INPUT_DIR, 'hung-renderer-source.bin');
  fs.writeFileSync(source, 'hung-renderer-source-content');
  const contentHash = await hashFile(source);
  const job = {
    id: 'job-hung-renderer-shutdown',
    projectId: 'asset-preview-capacity-b2',
    assetId: 'asset-hung-renderer-shutdown',
    contentHash,
    jobKind: 'image-preview',
    pipelineVersion: config.ASSET_PREVIEW_PIPELINE_VERSION,
    createdAt: 100,
    attemptCount: 1,
    startedAt: 200,
  };
  const asset = {
    id: job.assetId,
    entityUid: '00000000-0000-5000-8000-000000000001',
    projectId: job.projectId,
    contentHash,
    contentRevision: 1,
    organizationRevision: 1,
    kind: 'image',
    mimeType: 'image/png',
    filename: path.basename(source),
    managedPath: source,
    storageMode: 'managed',
    availability: 'available',
    metadata: {},
  };
  job.asset = asset;
  job.availabilitySnapshot = {
    id: asset.id,
    entityUid: asset.entityUid,
    projectId: asset.projectId,
    contentHash: asset.contentHash,
    contentRevision: asset.contentRevision,
    organizationRevision: asset.organizationRevision,
    managedPath: asset.managedPath,
    storageMode: asset.storageMode,
    availability: asset.availability,
    metadata: {},
  };
  let releaseRenderer;
  let rendererStarted;
  let completionCalls = 0;
  let rescheduleCalls = 0;
  const rendererGate = new Promise((resolve) => { releaseRenderer = resolve; });
  const started = new Promise((resolve) => { rendererStarted = resolve; });
  const database = minimalDatabase({
    getAsset: () => asset,
    getAssetPreviewJob: () => job,
    completeAssetPreviewJob: () => { completionCalls += 1; return { applied: true }; },
    rescheduleAssetPreviewJob: () => { rescheduleCalls += 1; return job; },
  });
  const pipeline = new AssetPreviewPipeline(config, database, {
    autoStart: false,
    recover: false,
    shutdownTimeoutMs: 100,
    createDerivedMedia: async () => {
      rendererStarted();
      await rendererGate;
      return { thumbnailUrl: '/files/thumbnails/late-result.webp' };
    },
  });
  try {
    const running = pipeline.runPersistentJob(job);
    await started;
    const result = await pipeline.shutdown();
    assert.equal(result.drained, false);
    assert.equal(result.forced, true);
    assert.equal(result.timedOut, true);
    assert.equal(result.pending.active, 0, 'direct worker ownership is represented by its generation');
    assert.equal(result.pending.generations, 1);
    assert.equal(pipeline.closed, true);
    assert.deepEqual(await pipeline.shutdown(), { drained: true, alreadyClosed: true });

    releaseRenderer();
    await running;
    assert.equal(completionCalls, 0, 'a late successful renderer must not write after forced close');
    assert.equal(rescheduleCalls, 0, 'a late renderer failure must not reschedule after forced close');
  } finally {
    releaseRenderer();
    pipeline.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('graceful shutdown flushes an exact pending completion before close and leaves unclaimed durable work queued', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-shutdown-completion-'));
  const config = createConfig(directory);
  const source = path.join(config.INPUT_DIR, 'shutdown-completion-source.bin');
  fs.writeFileSync(source, 'shutdown-completion-source-content');
  const contentHash = await hashFile(source);
  const database = new ProjectDatabase(':memory:');
  const result = Object.freeze({
    thumbnailUrl: '/files/thumbnails/asset-previews/shutdown-completion.webp',
  });
  let completionBusy = true;
  let generationCalls = 0;
  const completionCandidates = [];
  const originalComplete = database.completeAssetPreviewJob.bind(database);
  database.completeAssetPreviewJob = (jobId, candidate, input) => {
    completionCandidates.push(candidate);
    if (completionBusy) throw rawBusy();
    return originalComplete(jobId, candidate, input);
  };
  const pipeline = new AssetPreviewPipeline(config, database, {
    autoStart: false,
    recover: false,
    databaseBusyRetryBaseMs: 10,
    databaseBusyRetryMaxMs: 20,
    createDerivedMedia: async () => {
      generationCalls += 1;
      return result;
    },
  });
  let releasePressure;
  try {
    const firstAsset = insertAsset(database, {
      id: 'asset-shutdown-completion',
      contentHash,
      managedPath: source,
    });
    const firstJob = database.enqueueAssetPreviewJob({
      id: 'job-shutdown-completion',
      assetId: firstAsset.id,
      contentHash,
      jobKind: 'image-preview',
      pipelineVersion: pipeline.pipelineVersion,
    });
    await pipeline.runPersistentJob(database.claimNextAssetPreviewJob());
    assert.equal(database.getAssetPreviewJob(firstJob.id).status, 'running');
    assert.equal(pipeline.status().pending.completions, 1);

    const queuedAsset = insertAsset(database, {
      id: 'asset-shutdown-left-queued',
      contentHash,
      managedPath: source,
    });
    const queuedJob = database.enqueueAssetPreviewJob({
      id: 'job-shutdown-left-queued',
      assetId: queuedAsset.id,
      contentHash,
      jobKind: 'image-preview',
      pipelineVersion: pipeline.pipelineVersion,
    });
    const shutdown = pipeline.shutdown();
    releasePressure = setTimeout(() => { completionBusy = false; }, 35);
    assert.deepEqual(await shutdown, { drained: true });

    assert.equal(database.getAssetPreviewJob(firstJob.id).status, 'succeeded');
    assert.equal(database.getAssetPreviewJob(firstJob.id).attemptCount, 1);
    assert.equal(database.getAssetPreviewJob(queuedJob.id).status, 'queued');
    assert.equal(database.getAssetPreviewJob(queuedJob.id).attemptCount, 0);
    assert.equal(generationCalls, 1);
    assert.equal(completionCandidates.length >= 2, true);
    completionCandidates.forEach((candidate) => assert.strictEqual(candidate, result));
    assert.equal(pipeline.closed, true);
  } finally {
    if (releasePressure) clearTimeout(releasePressure);
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('graceful shutdown drains pending reschedule and exact rerun work before closing', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-shutdown-pending-writes-'));
  const rerunJob = {
    id: 'job-shutdown-rerun',
    assetId: 'asset-shutdown-rerun-missing',
    attemptCount: 1,
    jobKind: 'image-preview',
  };
  let busy = true;
  const reschedules = [];
  const database = minimalDatabase({
    getAsset: () => null,
    getAssetPreviewJob: () => ({ ...rerunJob, status: 'running' }),
    rescheduleAssetPreviewJob(jobId, error, options) {
      if (busy) throw rawBusy();
      reschedules.push({ jobId, error, options });
      return { id: jobId, status: 'failed' };
    },
  });
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, {
    autoStart: false,
    recover: false,
    databaseBusyRetryBaseMs: 10,
    databaseBusyRetryMaxMs: 20,
  });
  let releasePressure;
  try {
    pipeline.deferReschedule(
      { id: 'job-shutdown-reschedule', assetId: 'asset-shutdown-reschedule', attemptCount: 1 },
      { code: 'renderer-transient', message: 'sanitized renderer failure' },
      { retryable: true, nextAttemptAt: Date.now() + 1_000 },
      null,
      rawBusy(),
    );
    pipeline.deferRerun(rerunJob, rawBusy());
    const shutdown = pipeline.shutdown();
    releasePressure = setTimeout(() => { busy = false; }, 35);
    assert.deepEqual(await shutdown, { drained: true });
    assert.deepEqual(
      reschedules.map((entry) => entry.jobId).sort(),
      ['job-shutdown-rerun', 'job-shutdown-reschedule'],
    );
    const rerunTerminal = reschedules.find((entry) => entry.jobId === rerunJob.id);
    assert.equal(rerunTerminal.error.code, 'asset-preview-source-snapshot-missing');
    assert.equal(rerunTerminal.options.retryable, true);
    assert.equal(pipeline.pendingReschedules.size, 0);
    assert.equal(pipeline.pendingReruns.size, 0);
    assert.equal(pipeline.closed, true);
  } finally {
    if (releasePressure) clearTimeout(releasePressure);
    pipeline.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('retryAsset commits retry and enqueue atomically and schedules only after commit', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-retry-atomic-'));
  const config = createConfig(directory);
  const source = path.join(config.INPUT_DIR, 'retry-source.bin');
  fs.writeFileSync(source, 'retry-source-content');
  const contentHash = await hashFile(source);
  const database = new ProjectDatabase(':memory:');
  const pipeline = new AssetPreviewPipeline(config, database, { autoStart: false, recover: false });
  let scheduled = 0;
  pipeline.schedulePump = () => { scheduled += 1; };
  try {
    const asset = insertAsset(database, { id: 'asset-retry-atomic', contentHash, managedPath: source });
    const failedJob = database.enqueueAssetPreviewJob({
      id: 'job-retry-atomic-old',
      assetId: asset.id,
      contentHash,
      jobKind: 'image-preview',
      pipelineVersion: 'legacy-asset-preview-v0',
      maxAttempts: 1,
    });
    const claimed = database.claimNextAssetPreviewJob();
    database.rescheduleAssetPreviewJob(
      failedJob.id,
      { code: 'legacy-failed', message: 'legacy failed' },
      previewMutationInput(claimed, { retryable: false }),
    );
    assert.equal(database.getAssetPreviewJob(failedJob.id).status, 'failed');
    assert.equal(database.getAsset(asset.id).metadata.previewStatus, 'failed');

    const originalEnqueue = database.enqueueAssetPreviewJob.bind(database);
    database.enqueueAssetPreviewJob = (input) => {
      originalEnqueue(input);
      throw rawCapacity('SQLITE_FULL');
    };
    assert.throws(
      () => pipeline.retryAsset(asset.id),
      (error) => error?.code === 'project_database_storage_capacity_exceeded'
        && error?.details?.operation === 'asset.preview.retry',
    );
    assert.equal(scheduled, 0, 'a rolled-back retry must not start the worker');
    assert.equal(database.getAssetPreviewJob(failedJob.id).status, 'failed');
    assert.equal(database.getAsset(asset.id).metadata.previewStatus, 'failed');
    assert.equal(database.listAssetPreviewJobs({ assetId: asset.id, limit: 100 }).length, 1);

    database.enqueueAssetPreviewJob = originalEnqueue;
    const retried = pipeline.retryAsset(asset.id);
    assert.equal(scheduled, 1);
    assert.equal(retried.length, 2);
    assert.equal(database.getAssetPreviewJob(failedJob.id).status, 'queued');
    assert.equal(database.getAsset(asset.id).metadata.previewStatus, 'queued');
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
