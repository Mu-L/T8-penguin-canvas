'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'project-asset-preview-capacity-b2';
const MAX_PAGE_COUNT_RESET = 1073741823;
let faultSequence = 0;

function createTempDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-preview-capacity-b2-'));
  return {
    directory,
    filename: path.join(directory, 'projects.sqlite3'),
    database: new ProjectDatabase(path.join(directory, 'projects.sqlite3'), { autoBackup: false }),
  };
}

async function closeTempDatabase(database, directory) {
  try {
    if (database?.db?.open) database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
  } catch (_) {}
  try { await database?.close(); } catch (_) {}
  fs.rmSync(directory, { recursive: true, force: true });
}

function createAsset(database, suffix, input = {}) {
  return database.upsertAsset({
    id: `asset-preview-capacity-${suffix}`,
    projectId: PROJECT_ID,
    contentHash: String(input.contentHash || suffix.padEnd(64, suffix[0] || 'a')).slice(0, 64),
    contentHashVerification: 'verified',
    kind: 'image',
    mimeType: 'image/png',
    filename: `${suffix}.png`,
    sourceUrl: `/files/input/${suffix}.png`,
    storageMode: 'managed',
    availability: 'available',
    metadata: {
      previewStatus: 'queued',
      fixture: suffix,
      ...(input.metadata || {}),
    },
    ...(input.perceptualHash ? {
      perceptualHash: input.perceptualHash,
      perceptualHashAlgorithm: 'dhash-64',
    } : {}),
  });
}

function enqueue(database, asset, suffix, input = {}) {
  return database.enqueueAssetPreviewJob({
    id: `job-preview-capacity-${suffix}`,
    assetId: asset.id,
    contentHash: asset.contentHash,
    jobKind: input.jobKind || 'image-preview',
    pipelineVersion: 'asset-preview-capacity-v1',
    maxAttempts: input.maxAttempts || 3,
    createdAt: input.createdAt || 100,
  });
}

function previewMutationInput(claimed, input = {}) {
  return {
    ...input,
    expectedAttempt: claimed,
    expectedAssetSnapshot: claimed.availabilitySnapshot,
  };
}

function orderedRows(database, sql, ...values) {
  return database.db.prepare(sql).all(...values);
}

function previewState(database) {
  return {
    jobs: orderedRows(database, `
      SELECT * FROM asset_preview_jobs
      WHERE project_id = ? ORDER BY created_at, id
    `, PROJECT_ID),
    assets: orderedRows(database, `
      SELECT id, project_id, content_hash, perceptual_hash, perceptual_hash_algorithm,
        metadata_json, updated_at
      FROM assets WHERE project_id = ? ORDER BY id
    `, PROJECT_ID),
    fingerprints: orderedRows(database, `
      SELECT * FROM asset_fingerprints
      WHERE project_id = ? ORDER BY asset_id, algorithm, frame_index, id
    `, PROJECT_ID),
    catalog: orderedRows(database, `
      SELECT * FROM asset_catalog_revisions
      WHERE project_id = ? ORDER BY project_id
    `, PROJECT_ID),
    fillerCount: Number(database.db.prepare(`
      SELECT COUNT(*) AS count FROM asset_preview_capacity_b2_filler
    `).get()?.count || 0),
  };
}

function constrainDatabase(database) {
  database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
  database.db.pragma('wal_checkpoint(TRUNCATE)');
  database.db.exec('VACUUM');
  database.db.pragma('wal_checkpoint(TRUNCATE)');
  const pageCount = Number(database.db.pragma('page_count', { simple: true }));
  const constrainedPageCount = pageCount + 64;
  assert.equal(
    Number(database.db.pragma(`max_page_count = ${constrainedPageCount}`, { simple: true })),
    constrainedPageCount,
  );
}

function armRealFull(database, timing, matchValue) {
  faultSequence += 1;
  const triggerName = `asset_preview_capacity_b2_full_${faultSequence}`;
  const functionName = `asset_preview_capacity_b2_mark_${faultSequence}`;
  let hits = 0;
  database.db.function(functionName, () => {
    hits += 1;
    return 1;
  });
  database.db.exec(`
    CREATE TABLE IF NOT EXISTS asset_preview_capacity_b2_filler (
      id INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
  `);
  if (timing === 'enqueue') {
    database.db.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON asset_preview_jobs
      WHEN NEW.id = '${matchValue}'
      BEGIN
        SELECT ${functionName}();
        INSERT INTO asset_preview_capacity_b2_filler(payload) VALUES (zeroblob(8388608));
      END;
    `);
  } else if (timing === 'catalog') {
    database.db.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OF revision ON asset_catalog_revisions
      WHEN OLD.project_id = '${PROJECT_ID}'
      BEGIN
        SELECT ${functionName}();
        INSERT INTO asset_preview_capacity_b2_filler(payload) VALUES (zeroblob(8388608));
      END;
    `);
  } else if (timing === 'recovery') {
    database.db.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OF status ON asset_preview_jobs
      WHEN OLD.project_id = '${PROJECT_ID}' AND OLD.status = 'running'
      BEGIN
        SELECT ${functionName}();
        INSERT INTO asset_preview_capacity_b2_filler(payload) VALUES (zeroblob(8388608));
      END;
    `);
  } else {
    throw new Error(`unknown preview capacity fault timing: ${timing}`);
  }
  constrainDatabase(database);
  let released = false;
  return {
    hits: () => hits,
    release() {
      if (released || !database.db.open) return;
      database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
      database.db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
      released = true;
    },
  };
}

function assertStorageCapacity(error, operation) {
  assert.ok(error instanceof ProjectDatabaseStorageCapacityError);
  assert.equal(error.code, 'project_database_storage_capacity_exceeded');
  assert.equal(error.status, 507);
  assert.equal(error.statusCode, 507);
  assert.equal(error.reason, 'sqlite-full');
  assert.deepEqual(error.details, {
    reason: 'sqlite-full',
    retryable: false,
    operation,
  });
  return true;
}

test('B2 preview writer methods enter their exact coordinator operation and preserve BUSY/business identities', async () => {
  const asset = {
    id: 'asset-preview-operation-contract',
    projectId: PROJECT_ID,
    contentHash: 'a'.repeat(64),
  };
  const cases = [
    ['enqueueAssetPreviewJob', 'asset.preview.enqueue', [{
      id: 'job-preview-operation-contract',
      assetId: asset.id,
      contentHash: asset.contentHash,
      jobKind: 'image-preview',
      pipelineVersion: 'v1',
    }]],
    ['claimNextAssetPreviewJob', 'asset.preview.claim', [{}]],
    ['patchAssetPreviewState', 'asset.preview.state.patch', [asset.id, asset.contentHash, { previewStatus: 'running' }]],
    ['retryAssetPreviewJobs', 'asset.preview.retry', [asset.id, asset.contentHash]],
    ['recoverAssetPreviewJobs', 'asset.preview.recover', [{}]],
  ];
  const sources = [
    Object.assign(new Error('preview writer remains busy'), { code: 'SQLITE_BUSY_TIMEOUT' }),
    Object.assign(new Error('preview state conflict'), {
      code: 'asset_preview_state_conflict',
      status: 409,
    }),
  ];

  for (const source of sources) {
    for (const [method, expectedOperation, args] of cases) {
      let operation = null;
      let caught = null;
      const receiver = {
        getAsset: () => asset,
        withProjectDatabaseWrite(candidateOperation) {
          operation = candidateOperation;
          throw source;
        },
      };
      try {
        ProjectDatabase.prototype[method].call(receiver, ...args);
      } catch (error) {
        caught = error;
      }
      assert.equal(operation, expectedOperation, method);
      assert.strictEqual(caught, source, method);
      assert.equal(caught instanceof ProjectDatabaseStorageCapacityError, false, method);
    }

    const database = new ProjectDatabase(':memory:');
    const sourceAsset = createAsset(database, `operation-${source.code}`, {
      contentHash: source.code === 'SQLITE_BUSY_TIMEOUT' ? '6'.repeat(64) : '7'.repeat(64),
    });
    const queued = enqueue(database, sourceAsset, `operation-${source.code}`, { createdAt: 123 });
    const claimed = database.claimNextAssetPreviewJob({ now: 200 });
    const originalCoordinator = database.withProjectDatabaseWrite.bind(database);
    try {
      for (const [method, expectedOperation, args] of [
        ['completeAssetPreviewJob', 'asset.preview.complete', [queued.id, {}, previewMutationInput(claimed)]],
        ['rescheduleAssetPreviewJob', 'asset.preview.reschedule', [queued.id, new Error('preview failed'), previewMutationInput(claimed)]],
      ]) {
        let operation = null;
        let caught = null;
        database.withProjectDatabaseWrite = (candidateOperation) => {
          operation = candidateOperation;
          throw source;
        };
        try {
          database[method](...args);
        } catch (error) {
          caught = error;
        }
        assert.equal(operation, expectedOperation, method);
        assert.strictEqual(caught, source, method);
        assert.equal(caught instanceof ProjectDatabaseStorageCapacityError, false, method);
      }
    } finally {
      database.withProjectDatabaseWrite = originalCoordinator;
      await database.close();
    }
  }
});

test('B2 preview enqueue rolls back real SQLITE_FULL, retries idempotently, and leaves real BUSY unchanged', async () => {
  const { database, directory, filename } = createTempDatabase();
  let blocker = null;
  let fault = null;
  try {
    const asset = createAsset(database, 'enqueue', { contentHash: '1'.repeat(64) });
    const request = {
      id: 'job-preview-capacity-enqueue',
      assetId: asset.id,
      contentHash: asset.contentHash,
      jobKind: 'image-preview',
      pipelineVersion: 'asset-preview-capacity-v1',
      maxAttempts: 3,
      createdAt: 100,
    };
    fault = armRealFull(database, 'enqueue', request.id);
    const before = previewState(database);

    assert.throws(
      () => database.enqueueAssetPreviewJob(request),
      (error) => assertStorageCapacity(error, 'asset.preview.enqueue'),
    );
    assert.equal(fault.hits(), 1);
    assert.deepEqual(previewState(database), before);
    assert.equal(database.getAssetPreviewJob(request.id), null);

    fault.release();
    fault = null;
    const queued = database.enqueueAssetPreviewJob(request);
    assert.equal(queued.id, request.id);
    assert.equal(queued.status, 'queued');
    assert.equal(database.enqueueAssetPreviewJob(request).id, request.id);
    assert.equal(database.listAssetPreviewJobs({ assetId: asset.id }).length, 1);

    database.db.pragma('busy_timeout = 1');
    blocker = new BetterSqlite3(filename);
    blocker.exec('BEGIN IMMEDIATE');
    let busy = null;
    try {
      database.claimNextAssetPreviewJob({ now: 200 });
    } catch (error) {
      busy = error;
    }
    assert.ok(busy);
    assert.match(String(busy.code || ''), /^SQLITE_BUSY/);
    assert.equal(busy instanceof ProjectDatabaseStorageCapacityError, false);
    assert.equal(database.getAssetPreviewJob(request.id).status, 'queued');
    blocker.exec('ROLLBACK');
    blocker.close();
    blocker = null;
    database.db.pragma('busy_timeout = 5000');
    assert.equal(database.claimNextAssetPreviewJob({ now: 200 }).status, 'running');
  } finally {
    try { blocker?.exec('ROLLBACK'); } catch (_) {}
    try { blocker?.close(); } catch (_) {}
    try { fault?.release(); } catch (_) {}
    await closeTempDatabase(database, directory);
  }
});

test('B2 claim, patch and nested completion roll back every preview table on late real SQLITE_FULL and retry exactly', async () => {
  const { database, directory } = createTempDatabase();
  let fault = null;
  try {
    const asset = createAsset(database, 'lifecycle', { contentHash: '2'.repeat(64) });
    const job = enqueue(database, asset, 'lifecycle');

    fault = armRealFull(database, 'catalog');
    let before = previewState(database);
    assert.throws(
      () => database.claimNextAssetPreviewJob({ now: 200 }),
      (error) => assertStorageCapacity(error, 'asset.preview.claim'),
    );
    assert.equal(fault.hits(), 1);
    assert.deepEqual(previewState(database), before);
    fault.release();
    fault = null;
    const claimed = database.claimNextAssetPreviewJob({ now: 200 });
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.attemptCount, 1);
    assert.equal(database.getAsset(asset.id).metadata.previewStatus, 'running');

    const patch = {
      previewStatus: 'rendering',
      previewError: null,
      perceptualHash: '0123456789abcdef',
      perceptualHashAlgorithm: 'dhash-64',
    };
    fault = armRealFull(database, 'catalog');
    before = previewState(database);
    assert.throws(
      () => database.patchAssetPreviewState(asset.id, asset.contentHash, patch),
      (error) => assertStorageCapacity(error, 'asset.preview.state.patch'),
    );
    assert.equal(fault.hits(), 1);
    assert.deepEqual(previewState(database), before);
    fault.release();
    fault = null;
    const patched = database.patchAssetPreviewState(asset.id, asset.contentHash, patch);
    assert.equal(patched.metadata.previewStatus, 'rendering');
    assert.equal(database.listAssetFingerprints(asset.id).length, 1);

    const result = {
      thumbnailUrl: '/files/thumbnails/asset-preview-capacity/lifecycle.webp',
      perceptualHash: 'fedcba9876543210',
      perceptualHashAlgorithm: 'dhash-64',
    };
    fault = armRealFull(database, 'catalog');
    before = previewState(database);
    assert.throws(
      () => database.withProjectDatabaseWrite('asset.preview.outer-test', () => (
        database.completeAssetPreviewJob(job.id, result, previewMutationInput(claimed, { now: 300 }))
      )),
      (error) => assertStorageCapacity(error, 'asset.preview.outer-test'),
    );
    assert.equal(fault.hits(), 1);
    assert.deepEqual(previewState(database), before);
    assert.equal(database.getAssetPreviewJob(job.id).status, 'running');
    fault.release();
    fault = null;
    const completed = database.withProjectDatabaseWrite('asset.preview.outer-test', () => (
      database.completeAssetPreviewJob(job.id, result, previewMutationInput(claimed, { now: 300 }))
    ));
    assert.equal(completed.applied, true);
    assert.equal(completed.job.status, 'succeeded');
    assert.equal(completed.asset.metadata.previewStatus, 'ready');
    assert.equal(completed.asset.metadata.thumbnailUrl, result.thumbnailUrl);
    assert.deepEqual(database.listAssetFingerprints(asset.id).map((item) => item.hash), [result.perceptualHash]);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try { fault?.release(); } catch (_) {}
    await closeTempDatabase(database, directory);
  }
});

test('B2 preview reschedule and retry keep job, asset, fingerprints and catalog atomic under late real SQLITE_FULL', async () => {
  const { database, directory } = createTempDatabase();
  let fault = null;
  try {
    const asset = createAsset(database, 'retry', {
      contentHash: '3'.repeat(64),
      perceptualHash: '0011223344556677',
    });
    const job = enqueue(database, asset, 'retry', { maxAttempts: 1 });
    const claimed = database.claimNextAssetPreviewJob({ now: 200 });
    assert.equal(database.listAssetFingerprints(asset.id).length, 1);

    const failure = { code: 'preview-capacity-fixture', message: '预览失败需重试' };
    const rescheduleInput = previewMutationInput(claimed, {
      retryable: true,
      now: 210,
      nextAttemptAt: 310,
    });
    fault = armRealFull(database, 'catalog');
    let before = previewState(database);
    assert.throws(
      () => database.rescheduleAssetPreviewJob(job.id, failure, rescheduleInput),
      (error) => assertStorageCapacity(error, 'asset.preview.reschedule'),
    );
    assert.equal(fault.hits(), 1);
    assert.deepEqual(previewState(database), before);
    fault.release();
    fault = null;
    const failed = database.rescheduleAssetPreviewJob(job.id, failure, rescheduleInput);
    assert.equal(failed.status, 'failed');
    assert.equal(database.getAsset(asset.id).metadata.previewStatus, 'failed');
    assert.equal(database.listAssetFingerprints(asset.id).length, 0);

    fault = armRealFull(database, 'catalog');
    before = previewState(database);
    assert.throws(
      () => database.retryAssetPreviewJobs(asset.id, asset.contentHash, { now: 320 }),
      (error) => assertStorageCapacity(error, 'asset.preview.retry'),
    );
    assert.equal(fault.hits(), 1);
    assert.deepEqual(previewState(database), before);
    assert.equal(database.getAssetPreviewJob(job.id).status, 'failed');
    fault.release();
    fault = null;
    const retried = database.retryAssetPreviewJobs(asset.id, asset.contentHash, { now: 320 });
    assert.equal(retried.length, 1);
    assert.equal(retried[0].status, 'queued');
    assert.equal(retried[0].attemptCount, 0);
    assert.equal(database.getAsset(asset.id).metadata.previewStatus, 'queued');
    assert.equal(Object.hasOwn(database.getAsset(asset.id).metadata, 'previewError'), false);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try { fault?.release(); } catch (_) {}
    await closeTempDatabase(database, directory);
  }
});

test('B2 preview recovery rolls back all running jobs on one late real SQLITE_FULL, then retries job-only exactly', async () => {
  const { database, directory } = createTempDatabase();
  let fault = null;
  try {
    const recoverableAsset = createAsset(database, 'recoverable', {
      contentHash: '4'.repeat(64),
      perceptualHash: '1111222233334444',
    });
    const exhaustedAsset = createAsset(database, 'exhausted', {
      contentHash: '5'.repeat(64),
      perceptualHash: 'aaaabbbbccccdddd',
    });
    const recoverableJob = enqueue(database, recoverableAsset, 'recoverable', {
      maxAttempts: 3,
      createdAt: 100,
    });
    const exhaustedJob = enqueue(database, exhaustedAsset, 'exhausted', {
      maxAttempts: 1,
      createdAt: 101,
    });
    assert.equal(database.claimNextAssetPreviewJob({ now: 200 }).id, recoverableJob.id);
    assert.equal(database.claimNextAssetPreviewJob({ now: 201 }).id, exhaustedJob.id);

    fault = armRealFull(database, 'recovery');
    const before = previewState(database);
    assert.throws(
      () => database.recoverAssetPreviewJobs({ now: 300 }),
      (error) => assertStorageCapacity(error, 'asset.preview.recover'),
    );
    assert.equal(fault.hits(), 1);
    assert.deepEqual(previewState(database), before);
    assert.equal(database.getAssetPreviewJob(recoverableJob.id).status, 'running');
    assert.equal(database.getAssetPreviewJob(exhaustedJob.id).status, 'running');
    assert.equal(database.listAssetFingerprints(exhaustedAsset.id).length, 1);

    const catalogBeforeRetry = database.getAssetCatalogRevision(PROJECT_ID);
    fault.release();
    fault = null;
    assert.deepEqual(database.recoverAssetPreviewJobs({ now: 300 }), { recovered: 1, failed: 1 });
    assert.equal(database.getAssetPreviewJob(recoverableJob.id).status, 'retrying');
    assert.equal(database.getAsset(recoverableAsset.id).metadata.previewStatus, 'running');
    assert.equal(database.getAssetPreviewJob(exhaustedJob.id).status, 'failed');
    assert.equal(database.getAsset(exhaustedAsset.id).metadata.previewStatus, 'running');
    assert.equal(database.listAssetFingerprints(recoverableAsset.id).length, 1);
    assert.equal(database.listAssetFingerprints(exhaustedAsset.id).length, 1);
    assert.equal(database.getAssetCatalogRevision(PROJECT_ID), catalogBeforeRetry);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try { fault?.release(); } catch (_) {}
    await closeTempDatabase(database, directory);
  }
});
