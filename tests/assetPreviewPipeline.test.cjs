const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const { hashFile } = require('../backend/src/services/assetIndexer');
const {
  AssetPreviewPipeline,
  cleanupOrphanedPreviewTemps,
  isRetryablePreviewError,
  sanitizePreviewError,
} = require('../backend/src/services/assetPreviewPipeline');

function createConfig(directory, overrides = {}) {
  const thumbnails = path.join(directory, 'thumbnails');
  const config = {
    INPUT_DIR: path.join(directory, 'input'),
    OUTPUT_DIR: path.join(directory, 'output'),
    THUMBNAILS_DIR: thumbnails,
    ASSET_PREVIEWS_DIR: path.join(thumbnails, 'asset-previews'),
    ASSET_PREVIEW_CONCURRENCY: 2,
    ASSET_PREVIEW_MAX_ATTEMPTS: 3,
    ASSET_PREVIEW_RETRY_BASE_MS: 10,
    ASSET_PREVIEW_PIPELINE_VERSION: 'asset-preview-v1',
    ...overrides,
  };
  [config.INPUT_DIR, config.OUTPUT_DIR, config.THUMBNAILS_DIR, config.ASSET_PREVIEWS_DIR]
    .forEach((item) => fs.mkdirSync(item, { recursive: true }));
  return config;
}

function insertAsset(database, input = {}) {
  const id = input.id || `asset-${Math.random().toString(16).slice(2)}`;
  return database.upsertAsset({
    id,
    projectId: input.projectId || 'project-preview-test',
    contentHash: input.contentHash || 'a'.repeat(64),
    kind: input.kind || 'image',
    mimeType: input.mimeType || 'image/png',
    filename: input.filename || `${id}.png`,
    managedPath: input.managedPath || null,
    sourceUrl: input.sourceUrl || `/files/input/${id}.png`,
    storageMode: input.storageMode || 'managed',
    availability: input.availability || 'available',
    metadata: input.metadata || { previewStatus: 'queued' },
  });
}

function targetFromUrl(config, url) {
  const relative = String(url).replace(/^\/files\/thumbnails\//, '');
  return path.join(config.THUMBNAILS_DIR, ...relative.split('/').map(decodeURIComponent));
}

test('preview jobs are unique and expose queued, running, retrying, ready, failed and retry states', () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const asset = insertAsset(database, { id: 'asset-state-machine', contentHash: '1'.repeat(64) });
    const first = database.enqueueAssetPreviewJob({
      assetId: asset.id,
      contentHash: asset.contentHash,
      jobKind: 'image-preview',
      pipelineVersion: 'asset-preview-v1',
      maxAttempts: 3,
    });
    const duplicate = database.enqueueAssetPreviewJob({
      assetId: asset.id,
      contentHash: asset.contentHash,
      jobKind: 'image-preview',
      pipelineVersion: 'asset-preview-v1',
      maxAttempts: 3,
    });
    assert.equal(duplicate.id, first.id);
    assert.equal(database.getAssetPreviewJobStatus().counts.queued, 1);

    const attemptOne = database.claimNextAssetPreviewJob({ now: 100 });
    assert.equal(attemptOne.status, 'running');
    assert.equal(attemptOne.attemptCount, 1);
    assert.equal(database.getAsset(asset.id).metadata.previewStatus, 'running');
    assert.equal(Object.hasOwn(database.getAsset(asset.id).metadata, 'previewError'), false);

    const retrying = database.rescheduleAssetPreviewJob(first.id, {
      code: 'transient-preview-error',
      message: '上游暂时不可用',
    }, { retryable: true, now: 110, nextAttemptAt: 210 });
    assert.equal(retrying.status, 'retrying');
    assert.equal(database.getAsset(asset.id).metadata.previewStatus, 'retrying');
    assert.equal(database.claimNextAssetPreviewJob({ now: 209 }), null);

    const attemptTwo = database.claimNextAssetPreviewJob({ now: 210 });
    assert.equal(attemptTwo.attemptCount, 2);
    assert.equal(database.getAsset(asset.id).metadata.previewStatus, 'running');
    const completed = database.completeAssetPreviewJob(first.id, {
      thumbnailUrl: '/files/thumbnails/asset-previews/ready.webp',
      perceptualHash: '0123456789abcdef',
    }, { now: 220 });
    assert.equal(completed.applied, true);
    assert.equal(database.getAssetPreviewJob(first.id).status, 'succeeded');
    assert.equal(database.getAsset(asset.id).metadata.previewStatus, 'ready');

    const failing = database.enqueueAssetPreviewJob({
      assetId: asset.id,
      contentHash: asset.contentHash,
      jobKind: 'image-preview-failure',
      pipelineVersion: 'asset-preview-v1',
      maxAttempts: 1,
    });
    database.claimNextAssetPreviewJob({ now: 300 });
    const failed = database.rescheduleAssetPreviewJob(failing.id, {
      code: 'permanent-preview-error',
      message: '无法解析素材',
    }, { retryable: true, now: 310, nextAttemptAt: 400 });
    assert.equal(failed.status, 'failed');
    assert.equal(database.getAsset(asset.id).metadata.previewStatus, 'failed');
    const retried = database.retryAssetPreviewJobs(asset.id, asset.contentHash, { now: 320 });
    assert.equal(retried.find((item) => item.id === failing.id).status, 'queued');
    assert.equal(database.getAsset(asset.id).metadata.previewStatus, 'queued');

    database.removeAssetIndex(asset.id);
    assert.equal(database.getAssetPreviewJob(first.id), null);
    assert.equal(database.getAssetPreviewJob(failing.id), null);
  } finally {
    database.close();
  }
});

test('a retryable preview job stops honestly after exactly three attempts', () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const asset = insertAsset(database, { id: 'asset-three-attempts', contentHash: '9'.repeat(64) });
    const job = database.enqueueAssetPreviewJob({
      assetId: asset.id,
      contentHash: asset.contentHash,
      jobKind: 'image-preview',
      pipelineVersion: 'asset-preview-v1',
      maxAttempts: 3,
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const now = attempt * 100;
      const claimed = database.claimNextAssetPreviewJob({ now });
      assert.equal(claimed.id, job.id);
      assert.equal(claimed.attemptCount, attempt);
      const result = database.rescheduleAssetPreviewJob(job.id, {
        code: 'transient-preview-error',
        message: `第 ${attempt} 次失败`,
      }, { retryable: true, now: now + 1, nextAttemptAt: now + 50 });
      assert.equal(result.status, attempt < 3 ? 'retrying' : 'failed');
    }
    assert.equal(database.getAssetPreviewJob(job.id).attemptCount, 3);
    assert.equal(database.getAssetPreviewJob(job.id).status, 'failed');
    assert.equal(database.claimNextAssetPreviewJob({ now: 10_000 }), null);
    assert.equal(database.getAsset(asset.id).metadata.previewStatus, 'failed');
  } finally {
    database.close();
  }
});

test('restart recovery updates both persisted jobs and current-hash asset metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-recovery-'));
  const filename = path.join(directory, 'project.sqlite');
  let database = new ProjectDatabase(filename, { autoBackup: false });
  try {
    const recoverable = insertAsset(database, { id: 'asset-recoverable', contentHash: '2'.repeat(64) });
    const exhausted = insertAsset(database, { id: 'asset-exhausted', contentHash: '3'.repeat(64) });
    const recoverableJob = database.enqueueAssetPreviewJob({ assetId: recoverable.id, contentHash: recoverable.contentHash, jobKind: 'image-preview', pipelineVersion: 'v1', maxAttempts: 3 });
    const exhaustedJob = database.enqueueAssetPreviewJob({ assetId: exhausted.id, contentHash: exhausted.contentHash, jobKind: 'image-preview', pipelineVersion: 'v1', maxAttempts: 1 });
    database.claimNextAssetPreviewJob({ now: 100 });
    database.claimNextAssetPreviewJob({ now: 101 });
    database.close();

    database = new ProjectDatabase(filename, { autoBackup: false });
    const pipeline = new AssetPreviewPipeline(createConfig(directory), database, { autoStart: false });
    try {
      assert.deepEqual(pipeline.recovery, { recovered: 1, failed: 1 });
      assert.equal(database.getAssetPreviewJob(recoverableJob.id).status, 'retrying');
      assert.equal(database.getAsset(recoverable.id).metadata.previewStatus, 'retrying');
      assert.equal(database.getAssetPreviewJob(exhaustedJob.id).status, 'failed');
      assert.equal(database.getAsset(exhausted.id).metadata.previewStatus, 'failed');
    } finally {
      pipeline.close();
    }
  } finally {
    if (database?.db?.open) database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('stale preview completion never writes an old result onto changed asset content', () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const asset = insertAsset(database, { id: 'asset-stale', contentHash: '4'.repeat(64) });
    const job = database.enqueueAssetPreviewJob({ assetId: asset.id, contentHash: asset.contentHash, jobKind: 'image-preview', pipelineVersion: 'v1' });
    database.claimNextAssetPreviewJob();
    database.upsertAsset({
      ...asset,
      contentHash: '5'.repeat(64),
      metadata: { currentMarker: true, previewStatus: 'queued' },
    });
    const result = database.completeAssetPreviewJob(job.id, { thumbnailUrl: '/files/thumbnails/stale.webp' });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'source-content-changed');
    assert.equal(database.getAssetPreviewJob(job.id).status, 'failed');
    const current = database.getAsset(asset.id);
    assert.equal(current.metadata.currentMarker, true);
    assert.equal(Object.hasOwn(current.metadata, 'thumbnailUrl'), false);
  } finally {
    database.close();
  }
});

test('background image jobs finish from persistent queue and duplicate enqueue stays idempotent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-pipeline-'));
  const config = createConfig(directory);
  const source = path.join(config.INPUT_DIR, 'source.png');
  await sharp({ create: { width: 320, height: 180, channels: 3, background: '#275f8f' } }).png().toFile(source);
  const database = new ProjectDatabase(':memory:');
  const pipeline = new AssetPreviewPipeline(config, database, { autoStart: false, recover: false });
  try {
    const contentHash = await hashFile(source);
    const firstAsset = insertAsset(database, { id: 'asset-image-one', contentHash, managedPath: source });
    const secondAsset = insertAsset(database, { id: 'asset-image-two', contentHash, managedPath: source, sourceUrl: '/files/input/source-copy.png' });
    const firstJob = pipeline.enqueueAsset(firstAsset);
    const duplicate = pipeline.enqueueAsset(firstAsset);
    const secondJob = pipeline.enqueueAsset(secondAsset);
    assert.equal(duplicate.id, firstJob.id);
    assert.notEqual(secondJob.id, firstJob.id);
    assert.equal(await pipeline.waitForIdle(10_000), true);
    assert.equal(database.getAssetPreviewJob(firstJob.id).status, 'succeeded');
    assert.equal(database.getAssetPreviewJob(secondJob.id).status, 'succeeded');
    const ready = database.getAsset(firstAsset.id);
    assert.equal(ready.metadata.previewStatus, 'ready');
    assert.match(ready.metadata.thumbnailUrl, /asset-preview-v1-thumb\.webp$/);
    assert.equal(fs.existsSync(targetFromUrl(config, ready.metadata.thumbnailUrl)), true);
    assert.deepEqual(pipeline.status().counts, { queued: 0, running: 0, retrying: 0, succeeded: 2, failed: 0 });
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('missing sources fail permanently and asset deletion after claim cannot write back', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-missing-'));
  const config = createConfig(directory);
  const database = new ProjectDatabase(':memory:');
  const pipeline = new AssetPreviewPipeline(config, database, { autoStart: false, recover: false });
  try {
    const missing = insertAsset(database, {
      id: 'asset-missing-source',
      contentHash: '6'.repeat(64),
      managedPath: path.join(config.INPUT_DIR, 'gone.png'),
    });
    const missingJob = database.enqueueAssetPreviewJob({ assetId: missing.id, contentHash: missing.contentHash, jobKind: 'image-preview', pipelineVersion: pipeline.pipelineVersion });
    pipeline.schedulePump();
    assert.equal(await pipeline.waitForIdle(5_000), true);
    assert.equal(database.getAssetPreviewJob(missingJob.id).status, 'failed');
    assert.equal(database.getAsset(missing.id).availability, 'missing');
    assert.equal(database.getAsset(missing.id).metadata.previewStatus, 'failed');

    const source = path.join(config.INPUT_DIR, 'delete-race.png');
    await sharp({ create: { width: 24, height: 24, channels: 3, background: '#fff' } }).png().toFile(source);
    const contentHash = await hashFile(source);
    const raced = insertAsset(database, { id: 'asset-delete-race', contentHash, managedPath: source });
    const racedJob = database.enqueueAssetPreviewJob({ assetId: raced.id, contentHash, jobKind: 'image-preview', pipelineVersion: pipeline.pipelineVersion });
    const claimed = database.claimNextAssetPreviewJob();
    assert.equal(claimed.id, racedJob.id);
    database.removeAssetIndex(raced.id);
    await pipeline.runPersistentJob(claimed);
    assert.equal(database.getAssetPreviewJob(racedJob.id), null);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('unavailable and corrupt assets are rejected at enqueue, retry and persistent execution boundaries', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-eligibility-'));
  const config = createConfig(directory);
  const source = path.join(config.INPUT_DIR, 'corrupt.png');
  fs.writeFileSync(source, 'not-an-image');
  const contentHash = await hashFile(source);
  const database = new ProjectDatabase(':memory:');
  let generationCalls = 0;
  const pipeline = new AssetPreviewPipeline(config, database, {
    autoStart: false,
    recover: false,
    createDerivedMedia: async () => {
      generationCalls += 1;
      return { thumbnailUrl: '/files/thumbnails/forbidden.webp' };
    },
  });
  try {
    const corrupt = insertAsset(database, {
      id: 'asset-corrupt-boundary',
      contentHash,
      managedPath: source,
      availability: 'corrupt',
      metadata: { health: 'corrupt', previewStatus: 'failed' },
    });
    assert.equal(pipeline.enqueueAsset(corrupt), null);
    assert.equal(database.getAssetPreviewJobStatus().counts.queued, 0);

    const legacyJob = database.enqueueAssetPreviewJob({
      id: 'job-corrupt-legacy',
      assetId: corrupt.id,
      contentHash,
      jobKind: 'image-preview',
      pipelineVersion: pipeline.pipelineVersion,
    });
    const claimed = database.claimNextAssetPreviewJob();
    await pipeline.runPersistentJob(claimed);
    assert.equal(generationCalls, 0, 'an old queued job must fail before createDerivedMedia');
    assert.equal(database.getAssetPreviewJob(legacyJob.id).status, 'failed');
    assert.equal(database.getAssetPreviewJob(legacyJob.id).errorCode, 'asset-corrupt');
    assert.equal(database.getAssetPreviewJob(legacyJob.id).attemptCount, 1);

    const retrySource = path.join(config.INPUT_DIR, 'missing-after-failure.png');
    fs.writeFileSync(retrySource, 'retry-source');
    const retryHash = await hashFile(retrySource);
    const retryAsset = insertAsset(database, {
      id: 'asset-retry-unavailable',
      contentHash: retryHash,
      managedPath: retrySource,
    });
    const retryJob = database.enqueueAssetPreviewJob({
      id: 'job-retry-unavailable',
      assetId: retryAsset.id,
      contentHash: retryHash,
      jobKind: 'image-preview',
      pipelineVersion: pipeline.pipelineVersion,
      maxAttempts: 1,
    });
    database.claimNextAssetPreviewJob();
    database.rescheduleAssetPreviewJob(retryJob.id, { code: 'preview-failed', message: 'failed' }, { retryable: false });
    database.updateAssetAvailability(retryAsset.id, 'missing', { health: 'missing' });
    assert.throws(
      () => pipeline.retryAsset(retryAsset.id),
      (error) => error?.code === 'asset-unavailable' && !String(error.message).includes(directory),
    );
    assert.equal(database.getAssetPreviewJob(retryJob.id).status, 'failed', 'rejected retry must not mutate the old job');
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('ephemeral thumbnail work shares the hard global concurrency bound and errors are sanitized', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-concurrency-'));
  const database = new ProjectDatabase(':memory:');
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, { concurrency: 2, autoStart: false, recover: false });
  let running = 0;
  let maximum = 0;
  try {
    const values = await Promise.all(Array.from({ length: 8 }, (_, index) => pipeline.runEphemeral(async () => {
      running += 1;
      maximum = Math.max(maximum, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running -= 1;
      return index;
    })));
    assert.deepEqual(values, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(maximum, 2);
    assert.equal(pipeline.active, 0);

    const secret = `sk-${'A'.repeat(32)}`;
    const safe = sanitizePreviewError({ code: 'preview-test', message: `${secret} at C:\\Users\\Alice\\private\\source.png` });
    assert.equal(safe.code, 'preview-test');
    assert.equal(safe.message.includes(secret), false);
    assert.equal(safe.message.includes('Alice'), false);
    assert.equal(safe.message.length <= 600, true);
    assert.equal(sanitizePreviewError({ message: 'failed at /home/alice/private/source.png' }).message.includes('/home/alice'), false);
    assert.equal(sanitizePreviewError({ code: secret, message: 'failed' }).code, 'preview-generation-failed');
    assert.equal(isRetryablePreviewError({ code: 'source-content-changed' }), false);
    assert.equal(isRetryablePreviewError({ code: 'ffmpeg-busy' }), true);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('persistent jobs and ephemeral thumbnails share one active concurrency ceiling', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-mixed-concurrency-'));
  const database = new ProjectDatabase(':memory:');
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, { concurrency: 2, autoStart: false, recover: false });
  const asset = insertAsset(database, { id: 'asset-mixed-concurrency', contentHash: '8'.repeat(64) });
  database.enqueueAssetPreviewJob({
    assetId: asset.id,
    contentHash: asset.contentHash,
    jobKind: 'image-preview',
    pipelineVersion: pipeline.pipelineVersion,
  });
  let running = 0;
  let maximum = 0;
  let persistentRunning = false;
  let overlapped = false;
  let releasePersistent;
  let markPersistentStarted;
  const persistentGate = new Promise((resolve) => { releasePersistent = resolve; });
  const persistentStarted = new Promise((resolve) => { markPersistentStarted = resolve; });
  const enter = (kind) => {
    running += 1;
    maximum = Math.max(maximum, running);
    if (kind === 'persistent') persistentRunning = true;
    if (kind === 'ephemeral' && persistentRunning) overlapped = true;
  };
  const leave = (kind) => {
    if (kind === 'persistent') persistentRunning = false;
    running -= 1;
  };
  pipeline.runPersistentJob = async (job) => {
    enter('persistent');
    markPersistentStarted();
    await persistentGate;
    database.completeAssetPreviewJob(job.id, {});
    leave('persistent');
  };
  try {
    pipeline.schedulePump();
    await persistentStarted;
    const ephemeral = await Promise.all(Array.from({ length: 5 }, (_, index) => pipeline.runEphemeral(async () => {
      enter('ephemeral');
      await new Promise((resolve) => setTimeout(resolve, 10));
      leave('ephemeral');
      return index;
    })));
    assert.deepEqual(ephemeral, [0, 1, 2, 3, 4]);
    assert.equal(overlapped, true);
    assert.equal(maximum, 2);
    assert.equal(pipeline.active, 1);
    releasePersistent();
    assert.equal(await pipeline.waitForIdle(5_000), true);
    assert.equal(pipeline.active, 0);
  } finally {
    releasePersistent();
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('persistent preview jobs are not starved by ephemeral work and the ephemeral queue is bounded', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-fairness-'));
  const database = new ProjectDatabase(':memory:');
  const pipeline = new AssetPreviewPipeline(createConfig(directory), database, { concurrency: 1, ephemeralQueueLimit: 2, autoStart: false, recover: false });
  const asset = insertAsset(database, { id: 'asset-fairness', contentHash: '7'.repeat(64) });
  let job;
  const order = [];
  let releaseFirst;
  let firstStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const started = new Promise((resolve) => { firstStarted = resolve; });
  pipeline.runPersistentJob = async (claimed) => {
    order.push('persistent');
    database.completeAssetPreviewJob(claimed.id, {});
  };
  try {
    const first = pipeline.runEphemeral(async () => {
      order.push('ephemeral-1');
      firstStarted();
      await firstGate;
    });
    await started;
    job = database.enqueueAssetPreviewJob({ assetId: asset.id, contentHash: asset.contentHash, jobKind: 'image-preview', pipelineVersion: pipeline.pipelineVersion });
    const second = pipeline.runEphemeral(async () => { order.push('ephemeral-2'); });
    const third = pipeline.runEphemeral(async () => { order.push('ephemeral-3'); });
    await assert.rejects(
      pipeline.runEphemeral(async () => {}),
      (error) => error?.code === 'preview-queue-full',
    );
    releaseFirst();
    await Promise.all([first, second, third]);
    assert.equal(await pipeline.waitForIdle(5_000), true);
    assert.equal(database.getAssetPreviewJob(job.id).status, 'succeeded');
    assert.deepEqual(order, ['ephemeral-1', 'persistent', 'ephemeral-2', 'ephemeral-3']);
  } finally {
    releaseFirst();
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('persistent model3d previews use one dedicated slot while ordinary previews keep the global queue moving', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-model-slot-'));
  const config = createConfig(directory, { ASSET_PREVIEW_CONCURRENCY: 2 });
  const database = new ProjectDatabase(':memory:');
  let active = 0;
  let maximumActive = 0;
  let activeModels = 0;
  let maximumModels = 0;
  let imageOverlappedModel = false;
  let signalImageStarted;
  const imageStarted = new Promise((resolve) => { signalImageStarted = resolve; });
  let signalModelStarted;
  const modelStarted = new Promise((resolve) => { signalModelStarted = resolve; });
  const pipeline = new AssetPreviewPipeline(config, database, {
    concurrency: 2,
    autoStart: false,
    recover: false,
    createDerivedMedia: async (_snapshotPath, kind, _metadata, _config, contentHash) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (kind === 'model3d') {
        activeModels += 1;
        maximumModels = Math.max(maximumModels, activeModels);
        signalModelStarted();
        await Promise.race([imageStarted, new Promise((resolve) => setTimeout(resolve, 500))]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeModels -= 1;
      } else {
        signalImageStarted();
        await Promise.race([modelStarted, new Promise((resolve) => setTimeout(resolve, 500))]);
        if (activeModels > 0) imageOverlappedModel = true;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      active -= 1;
      return { thumbnailUrl: `/files/thumbnails/${kind}-${contentHash.slice(0, 8)}.webp` };
    },
  });
  try {
    const sources = [
      { id: 'model-slot-one', kind: 'model3d', ext: 'obj', body: 'model-one' },
      { id: 'model-slot-two', kind: 'model3d', ext: 'obj', body: 'model-two' },
      { id: 'image-slot-one', kind: 'image', ext: 'png', body: 'image-one' },
    ];
    const jobs = [];
    for (let index = 0; index < sources.length; index += 1) {
      const item = sources[index];
      const filename = path.join(config.INPUT_DIR, `${item.id}.${item.ext}`);
      fs.writeFileSync(filename, item.body);
      const contentHash = await hashFile(filename);
      const asset = insertAsset(database, {
        id: item.id,
        kind: item.kind,
        mimeType: item.kind === 'model3d' ? 'model/obj' : 'image/png',
        filename: path.basename(filename),
        managedPath: filename,
        contentHash,
      });
      jobs.push(database.enqueueAssetPreviewJob({
        id: `job-${item.id}`,
        assetId: asset.id,
        contentHash,
        jobKind: item.kind === 'model3d' ? 'model3d-preview' : 'image-preview',
        pipelineVersion: pipeline.pipelineVersion,
        createdAt: 100 + index,
      }));
    }
    pipeline.schedulePump();
    assert.equal(await pipeline.waitForIdle(5_000), true);
    assert.equal(maximumModels, 1, 'no two model3d renderers may overlap');
    assert.equal(maximumActive <= 2, true, 'the existing global concurrency ceiling remains authoritative');
    assert.equal(imageOverlappedModel, true, 'a queued image must not wait behind the second model3d job');
    jobs.forEach((job) => assert.equal(database.getAssetPreviewJob(job.id).status, 'succeeded'));
    assert.equal(pipeline.activeModel3d, 0);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('same-hash jobs generate from a verified private snapshot when the owner source changes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-snapshot-race-'));
  const config = createConfig(directory);
  const ownerSource = path.join(config.INPUT_DIR, 'owner.png');
  const stableSource = path.join(config.INPUT_DIR, 'stable.png');
  const original = Buffer.from('old-content-0001');
  const replacement = Buffer.from('new-content-0002');
  fs.writeFileSync(ownerSource, original);
  fs.writeFileSync(stableSource, original);
  const contentHash = await hashFile(ownerSource);
  const database = new ProjectDatabase(':memory:');
  let generationCalls = 0;
  let snapshotPath = '';
  let signalGenerationStarted;
  const generationStarted = new Promise((resolve) => { signalGenerationStarted = resolve; });
  let releaseGeneration;
  const generationGate = new Promise((resolve) => { releaseGeneration = resolve; });
  let signalStableValidated;
  const stableValidated = new Promise((resolve) => { signalStableValidated = resolve; });
  let stableHashCalls = 0;
  const guardedHashFile = async (filename) => {
    if (path.resolve(filename) === path.resolve(stableSource) && stableHashCalls === 0) {
      await generationStarted;
      stableHashCalls += 1;
      const value = await hashFile(filename);
      signalStableValidated();
      return value;
    }
    return hashFile(filename);
  };
  const derived = path.join(config.ASSET_PREVIEWS_DIR, 'shared-old-content.bin');
  const pipeline = new AssetPreviewPipeline(config, database, {
    concurrency: 2,
    autoStart: false,
    recover: false,
    hashFile: guardedHashFile,
    createDerivedMedia: async (privateSource) => {
      generationCalls += 1;
      snapshotPath = privateSource;
      assert.notEqual(path.resolve(privateSource), path.resolve(ownerSource));
      assert.notEqual(path.resolve(privateSource), path.resolve(stableSource));
      assert.equal(path.dirname(path.resolve(privateSource)), path.resolve(config.ASSET_PREVIEWS_DIR));
      assert.deepEqual(fs.readFileSync(privateSource), original);
      signalGenerationStarted();
      await generationGate;
      assert.deepEqual(fs.readFileSync(privateSource), original, 'owner mutation must not alter the private snapshot');
      fs.copyFileSync(privateSource, derived);
      return { thumbnailUrl: '/files/thumbnails/shared-old-content.webp' };
    },
  });
  try {
    const owner = insertAsset(database, { id: 'snapshot-owner', contentHash, managedPath: ownerSource });
    const stable = insertAsset(database, { id: 'snapshot-stable', contentHash, managedPath: stableSource });
    const ownerJob = database.enqueueAssetPreviewJob({ id: 'job-snapshot-owner', assetId: owner.id, contentHash, jobKind: 'image-preview', pipelineVersion: pipeline.pipelineVersion, createdAt: 100 });
    const stableJob = database.enqueueAssetPreviewJob({ id: 'job-snapshot-stable', assetId: stable.id, contentHash, jobKind: 'image-preview', pipelineVersion: pipeline.pipelineVersion, createdAt: 101 });
    pipeline.schedulePump();
    await generationStarted;
    await stableValidated;
    await new Promise((resolve) => setImmediate(resolve));
    fs.writeFileSync(ownerSource, replacement);
    releaseGeneration();
    assert.equal(await pipeline.waitForIdle(5_000), true);
    assert.equal(generationCalls, 1, 'same-hash work should share the verified snapshot generation');
    assert.deepEqual(fs.readFileSync(derived), original, 'the hash-keyed cache artifact must contain only the old verified bytes');
    assert.equal(database.getAssetPreviewJob(ownerJob.id).status, 'failed');
    assert.equal(database.getAssetPreviewJob(ownerJob.id).errorCode, 'source-content-changed');
    assert.equal(Object.hasOwn(database.getAsset(owner.id).metadata, 'thumbnailUrl'), false);
    assert.equal(database.getAssetPreviewJob(stableJob.id).status, 'succeeded');
    assert.equal(database.getAsset(stable.id).metadata.thumbnailUrl, '/files/thumbnails/shared-old-content.webp');
    assert.equal(fs.existsSync(snapshotPath), false, 'private snapshots must be deleted in finally');
    assert.deepEqual(
      fs.readdirSync(config.ASSET_PREVIEWS_DIR).filter((name) => name.includes('.snapshot-')),
      [],
    );
  } finally {
    releaseGeneration();
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('physical source replacement with identical size and restored mtime cannot write stale preview results', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-physical-race-'));
  const config = createConfig(directory);
  const source = path.join(config.INPUT_DIR, 'same-size.png');
  fs.writeFileSync(source, Buffer.from('first-content!'));
  const originalTimes = fs.statSync(source);
  const contentHash = await hashFile(source);
  const database = new ProjectDatabase(':memory:');
  const pipeline = new AssetPreviewPipeline(config, database, {
    autoStart: false,
    recover: false,
    createDerivedMedia: async () => {
      fs.writeFileSync(source, Buffer.from('other-content!'));
      fs.utimesSync(source, originalTimes.atime, originalTimes.mtime);
      return { thumbnailUrl: '/files/thumbnails/should-not-apply.webp' };
    },
  });
  try {
    const asset = insertAsset(database, { id: 'asset-physical-race', contentHash, managedPath: source });
    const job = database.enqueueAssetPreviewJob({ assetId: asset.id, contentHash, jobKind: 'image-preview', pipelineVersion: pipeline.pipelineVersion });
    const claimed = database.claimNextAssetPreviewJob();
    await pipeline.runPersistentJob(claimed);
    assert.equal(database.getAssetPreviewJob(job.id).status, 'failed');
    assert.equal(database.getAssetPreviewJob(job.id).errorCode, 'source-content-changed');
    assert.equal(Object.hasOwn(database.getAsset(asset.id).metadata, 'thumbnailUrl'), false);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('startup cleanup removes only stale preview temp files with owned names', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-preview-temp-cleanup-'));
  try {
    const stalePart = path.join(directory, 'asset-preview.part-1234-aabbccddee.webp');
    const staleRenderer = path.join(directory, '.asset-model.webp.tmp-1234-12345678-1234-1234-1234-123456789abc.webp');
    const staleSnapshot = path.join(directory, '.asset-preview.snapshot-1234-12345678-1234-1234-1234-123456789abc.obj');
    const freshPart = path.join(directory, 'fresh.part-1234-aabbccddee.webp');
    const unrelated = path.join(directory, 'user-file.tmp-1234-not-owned.webp');
    [stalePart, staleRenderer, staleSnapshot, freshPart, unrelated].forEach((filename) => fs.writeFileSync(filename, 'temp'));
    const now = Date.now();
    const old = new Date(now - 8 * 60 * 60 * 1000);
    fs.utimesSync(stalePart, old, old);
    fs.utimesSync(staleRenderer, old, old);
    fs.utimesSync(staleSnapshot, old, old);
    const result = cleanupOrphanedPreviewTemps(directory, { now, maxAgeMs: 6 * 60 * 60 * 1000 });
    assert.equal(result.removed, 3);
    assert.equal(fs.existsSync(stalePart), false);
    assert.equal(fs.existsSync(staleRenderer), false);
    assert.equal(fs.existsSync(staleSnapshot), false);
    assert.equal(fs.existsSync(freshPart), true);
    assert.equal(fs.existsSync(unrelated), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});
