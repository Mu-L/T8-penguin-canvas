const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');

const {
  ProjectDatabase,
  PROJECT_DATABASE_SCHEMA_VERSION,
  encodeFloat32LE,
  decodeFloat32LE,
  cosineSimilarity,
} = require('../backend/src/services/projectDatabase');

function addAsset(db, projectId, id, input = {}) {
  return db.upsertAsset({
    id,
    projectId,
    kind: input.kind || 'image',
    mimeType: input.mimeType || 'image/png',
    filename: input.filename || `${id}.png`,
    contentHash: input.contentHash || id.replace(/[^a-f0-9]/gi, 'a').padEnd(64, 'a').slice(0, 64).toLowerCase(),
    contentHashVerification: input.contentHashVerification || 'verified',
    storageMode: input.storageMode || 'managed',
    availability: input.availability || 'available',
    metadata: input.metadata || {},
    provenance: input.provenance || {},
  });
}

function installModel(db, capability, key = `${capability}-test-model`, version = 'fixture-v1') {
  return db.setAssetSemanticModelState({
    modelKey: key,
    modelVersion: version,
    capability,
    status: 'installed',
    artifactDigest: `sha256:${capability.padEnd(64, '0').slice(0, 64)}`,
    downloadedBytes: 1024,
    totalBytes: 1024,
    byteSize: 1024,
    installPath: `semantic-models/${capability}/${version}`,
  }, { expectedRevision: 0 });
}

function configureProfile(db, projectId, capabilities = ['caption', 'ocr', 'embedding']) {
  const patch = { enabled: true };
  for (const capability of ['caption', 'ocr', 'embedding']) {
    patch[capability] = capabilities.includes(capability)
      ? { enabled: true, modelKey: `${capability}-test-model`, modelVersion: 'fixture-v1' }
      : { enabled: false };
  }
  return db.setAssetSemanticProfile(projectId, patch, { expectedRevision: 0, updatedBy: 'd4-test' });
}

function completeClaim(db, job, result) {
  return db.completeAssetSemanticJob(job.id, {
    claimToken: job.claimToken,
    expectedRevision: job.revision,
    contentHash: job.contentHash,
    generation: job.generation,
    modelKey: job.modelKey,
    modelVersion: job.modelVersion,
    ...result,
  });
}

function sealGeneration(db, projectId, generation) {
  const profile = db.getAssetSemanticProfile(projectId);
  const current = db.getAssetSemanticGeneration(projectId, generation);
  return db.sealAssetSemanticRebuild(projectId, generation, {
    expectedProfileRevision: profile.revision,
    expectedGenerationRevision: current.revision,
  });
}

function buildReadyEmbeddingGeneration(db, projectId, profileRevision, assets, idempotencyKey) {
  const generation = db.beginAssetSemanticRebuild(projectId, {
    expectedProfileRevision: profileRevision,
    idempotencyKey,
    createdBy: 'd4-generation-test',
  });
  const buildingProfile = db.getAssetSemanticProfile(projectId);
  for (const [index, asset] of assets.entries()) {
    db.enqueueAssetSemanticJob({
      projectId,
      assetId: asset.id,
      contentHash: asset.contentHash,
      generation: generation.generation,
      jobKind: 'embedding',
      modelKey: 'embedding-test-model',
      modelVersion: 'fixture-v1',
      createdAt: 1_000 + index,
    });
  }
  sealGeneration(db, projectId, generation.generation);
  while (true) {
    const job = db.claimNextAssetSemanticJob({ projectId });
    if (!job) break;
    completeClaim(db, job, { embedding: job.assetId === assets[0]?.id ? [1, 0] : [0, 1] });
  }
  const current = db.getAssetSemanticGeneration(projectId, generation.generation);
  const ready = db.finishAssetSemanticRebuild(projectId, generation.generation, {
    expectedProfileRevision: buildingProfile.revision,
    expectedGenerationRevision: current.revision,
  });
  return { profile: buildingProfile, ready };
}

function buildCaptionEmbeddingGeneration(db, projectId, profileRevision, asset, idempotencyKey, options = {}) {
  const generation = db.beginAssetSemanticRebuild(projectId, {
    expectedProfileRevision: profileRevision,
    idempotencyKey,
    createdBy: 'd4-payload-gc-test',
  });
  for (const jobKind of ['caption', 'embedding']) {
    db.enqueueAssetSemanticJob({
      projectId,
      assetId: asset.id,
      contentHash: asset.contentHash,
      generation: generation.generation,
      jobKind,
      modelKey: `${jobKind}-test-model`,
      modelVersion: 'fixture-v1',
      createdAt: 10_000 + generation.generation,
    });
  }
  sealGeneration(db, projectId, generation.generation);
  const captionJob = db.claimNextAssetSemanticJob({ projectId });
  assert.equal(captionJob.jobKind, 'caption');
  completeClaim(db, captionJob, { caption: `caption generation ${generation.generation}`, language: 'en' });
  const embeddingJob = db.claimNextAssetSemanticJob({ projectId });
  assert.equal(embeddingJob.jobKind, 'embedding');
  if (options.failEmbedding) {
    db.rescheduleAssetSemanticJob(embeddingJob.id, {
      code: 'fixture-terminal-failure',
      message: 'fixture terminal failure',
    }, {
      claimToken: embeddingJob.claimToken,
      expectedRevision: embeddingJob.revision,
      retryable: false,
    });
  } else {
    completeClaim(db, embeddingJob, { embedding: [1, Math.max(1, generation.generation)] });
  }
  const profile = db.getAssetSemanticProfile(projectId);
  const current = db.getAssetSemanticGeneration(projectId, generation.generation);
  const finished = db.finishAssetSemanticRebuild(projectId, generation.generation, {
    expectedProfileRevision: profile.revision,
    expectedGenerationRevision: current.revision,
    error: options.failEmbedding
      ? { code: 'fixture-generation-failed', message: 'fixture generation failed' }
      : null,
  });
  return { generation: finished, failedJobId: options.failEmbedding ? embeddingJob.id : null };
}

function stripLatestSchemaToSchema16(filename) {
  const raw = new BetterSqlite3(filename);
  try {
    raw.pragma('foreign_keys = OFF');
    raw.exec(`
      DROP TABLE asset_upload_chunks;
      DROP TABLE asset_upload_sessions;
      DROP INDEX idx_asset_blobs_storage_state;
      DROP INDEX idx_assets_project_created_id;
      DROP TABLE asset_semantic_fts;
      DROP TABLE asset_semantic_embeddings;
      DROP TABLE asset_semantic_documents;
      DROP TABLE asset_semantic_jobs;
      DROP TABLE asset_semantic_generations;
      DROP TABLE asset_semantic_profiles;
      DROP TABLE asset_semantic_models;
      ALTER TABLE asset_blobs DROP COLUMN pending_delete_at;
      ALTER TABLE asset_blobs DROP COLUMN verified_at;
      ALTER TABLE asset_blobs DROP COLUMN storage_state;
      ALTER TABLE asset_blobs DROP COLUMN storage_key;
      DELETE FROM schema_migrations WHERE version >= 17;
    `);
  } finally {
    raw.close();
  }
}

function seedSchema16(filename) {
  const database = new ProjectDatabase(filename, { autoBackup: false });
  try {
    addAsset(database, 'schema17-project', 'schema16-preserved-asset', {
      contentHash: 'a'.repeat(64),
      filename: 'preserved.png',
      metadata: { legacyMarker: true },
    });
  } finally {
    database.close();
  }
  stripLatestSchemaToSchema16(filename);
}

function stripLateSchema17IdempotencyColumns(filename) {
  const raw = new BetterSqlite3(filename);
  try {
    raw.pragma('foreign_keys = OFF');
    raw.exec(`
      DROP TABLE asset_semantic_generations;
      DROP TABLE asset_semantic_models;
      CREATE TABLE asset_semantic_models (
        model_key TEXT NOT NULL,
        model_version TEXT NOT NULL,
        capability TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        artifact_digest TEXT,
        byte_size INTEGER,
        downloaded_bytes INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER,
        install_path TEXT,
        error_code TEXT,
        error_message TEXT,
        installed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(model_key, model_version)
      );
      CREATE TABLE asset_semantic_generations (
        project_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        catalog_revision INTEGER NOT NULL,
        profile_revision INTEGER NOT NULL,
        profile_digest TEXT NOT NULL,
        profile_snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER,
        PRIMARY KEY(project_id, generation)
      );
    `);
  } finally {
    raw.close();
  }
}

test('latest schema migrates schema 16 data in one idempotent transaction with FTS, upload, and ownership constraints', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-schema17-upgrade-'));
  const filename = path.join(directory, 'projects.sqlite3');
  try {
    seedSchema16(filename);
    const database = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(PROJECT_DATABASE_SCHEMA_VERSION, 23);
      assert.equal(database.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, PROJECT_DATABASE_SCHEMA_VERSION);
      assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, PROJECT_DATABASE_SCHEMA_VERSION);
      assert.equal(database.getAsset('schema16-preserved-asset').metadata.legacyMarker, true);
      for (const table of [
        'asset_semantic_models',
        'asset_semantic_profiles',
        'asset_semantic_generations',
        'asset_semantic_jobs',
        'asset_semantic_documents',
        'asset_semantic_embeddings',
        'asset_semantic_fts',
      ]) {
        assert.ok(database.db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table), table);
      }
      assert.equal(database.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'asset_semantic_fts'").get().sql.includes("tokenize='trigram'"), true);
      assert.equal(database.db.pragma('table_info(asset_semantic_jobs)').some((column) => column.name === 'revision'), true);
      assert.equal(database.db.pragma('table_info(asset_semantic_models)').some((column) => column.name === 'downloaded_bytes'), true);
      assert.equal(database.db.pragma('table_info(asset_semantic_models)').some((column) => column.name === 'download_idempotency_key'), true);
      assert.equal(database.db.pragma('table_info(asset_semantic_models)').some((column) => column.name === 'download_request_revision'), true);
      assert.equal(database.db.pragma('table_info(asset_semantic_generations)').some((column) => column.name === 'catalog_revision'), true);
      for (const column of ['jobs_sealed', 'expected_job_count', 'eligible_asset_count', 'excluded_asset_count', 'payload_pruned_at']) {
        assert.equal(database.db.pragma('table_info(asset_semantic_generations)').some((entry) => entry.name === column), true);
      }
      assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(database.db.pragma('foreign_key_check'), []);
      assert.doesNotThrow(() => database.migrate());
      assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, PROJECT_DATABASE_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema 17 repairs local prerelease databases missing the final idempotency columns before creating indexes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-schema17-prerelease-repair-'));
  const filename = path.join(directory, 'projects.sqlite3');
  try {
    new ProjectDatabase(filename, { autoBackup: false }).close();
    stripLateSchema17IdempotencyColumns(filename);
    const database = new ProjectDatabase(filename, { autoBackup: false });
    try {
      const modelColumns = new Set(database.db.pragma('table_info(asset_semantic_models)').map((column) => column.name));
      const generationColumns = new Set(database.db.pragma('table_info(asset_semantic_generations)').map((column) => column.name));
      assert.equal(modelColumns.has('download_idempotency_key'), true);
      assert.equal(modelColumns.has('download_request_revision'), true);
      assert.equal(generationColumns.has('idempotency_key'), true);
      assert.equal(generationColumns.has('jobs_sealed'), true);
      assert.equal(generationColumns.has('expected_job_count'), true);
      assert.equal(generationColumns.has('eligible_asset_count'), true);
      assert.equal(generationColumns.has('excluded_asset_count'), true);
      assert.equal(generationColumns.has('payload_pruned_at'), true);
      assert.ok(database.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_asset_semantic_generations_idempotency'").get());
      const model = database.setAssetSemanticModelState({
        modelKey: 'caption-prerelease-repair',
        modelVersion: 'fixed-v1',
        capability: 'caption',
        status: 'downloading',
        totalBytes: 100,
        downloadIdempotencyKey: 'repair/download/request-1',
        downloadRequestRevision: 1,
      }, { expectedRevision: 0 });
      assert.equal(model.downloadIdempotencyKey, 'repair/download/request-1');
      assert.equal(model.downloadRequestRevision, 1);
      assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('latest migration failure rolls every semantic/upload table, trigger, column, and version back to schema 16', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-schema17-rollback-'));
  const filename = path.join(directory, 'projects.sqlite3');
  try {
    seedSchema16(filename);
    assert.throws(() => new ProjectDatabase(filename, {
      autoBackup: false,
      beforeMigrationCommit: () => { throw new Error('schema17-injected-failure'); },
    }), /schema17-injected-failure/);
    const raw = new BetterSqlite3(filename, { readonly: true });
    try {
      assert.equal(raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 16);
      assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);
      assert.deepEqual(raw.prepare(`
        SELECT name FROM sqlite_master
        WHERE name LIKE 'asset_semantic_%' OR name LIKE 'trg_asset_semantic_%' OR name LIKE 'asset_upload_%'
        ORDER BY name
      `).all(), []);
      const blobColumns = new Set(raw.pragma('table_info(asset_blobs)').map((column) => column.name));
      for (const column of ['storage_key', 'storage_state', 'verified_at', 'pending_delete_at']) {
        assert.equal(blobColumns.has(column), false, column);
      }
      assert.equal(raw.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      raw.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('model and profile state use strict CAS, exact identities, progress fields and immutable capabilities', () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const downloading = database.setAssetSemanticModelState({
      modelKey: 'caption-fixed',
      modelVersion: 'version-a',
      capability: 'caption',
      status: 'downloading',
      downloadedBytes: 25,
      totalBytes: 100,
    }, { expectedRevision: 0 });
    assert.equal(downloading.revision, 1);
    assert.equal(downloading.downloadedBytes, 25);
    assert.equal(downloading.totalBytes, 100);
    assert.throws(
      () => database.setAssetSemanticModelState({
        modelKey: 'caption-fixed', modelVersion: 'version-a', capability: 'caption', status: 'verifying',
      }, { expectedRevision: 0 }),
      (error) => error.code === 'asset_semantic_model_revision_conflict',
    );
    const verifying = database.setAssetSemanticModelState({
      modelKey: 'caption-fixed', modelVersion: 'version-a', capability: 'caption', status: 'verifying',
      downloadedBytes: 100, totalBytes: 100,
    }, { expectedRevision: downloading.revision });
    const installed = database.setAssetSemanticModelState({
      modelKey: 'caption-fixed', modelVersion: 'version-a', capability: 'caption', status: 'installed',
      downloadedBytes: 100, totalBytes: 100, installPath: 'models/caption-fixed/version-a',
    }, { expectedRevision: verifying.revision });
    assert.equal(installed.status, 'installed');
    assert.equal(installed.revision, 3);
    assert.throws(
      () => database.setAssetSemanticModelState({
        modelKey: 'caption-fixed', modelVersion: 'version-a', capability: 'ocr', status: 'installed',
      }, { expectedRevision: installed.revision }),
      /capability 不可变|model mismatch/,
    );

    const profile = database.setAssetSemanticProfile('cas-project', {
      enabled: true,
      caption: { enabled: true, modelKey: 'caption-fixed', modelVersion: 'version-a' },
    }, { expectedRevision: 0, updatedBy: 'owner' });
    assert.equal(profile.revision, 1);
    assert.equal(profile.caption.enabled, true);
    assert.equal(profile.ocr.enabled, false);
    assert.throws(
      () => database.setAssetSemanticProfile('cas-project', { enabled: false }, { expectedRevision: 0 }),
      (error) => error.code === 'asset_semantic_profile_revision_conflict',
    );
    assert.throws(
      () => database.setAssetSemanticProfile('cas-project', {
        embedding: { enabled: true, modelKey: 'caption-fixed', modelVersion: 'version-a' },
      }, { expectedRevision: profile.revision }),
      /capability|身份不存在/,
    );
    assert.throws(
      () => database.db.prepare(`
        UPDATE asset_semantic_models SET capability = 'ocr'
        WHERE model_key = 'caption-fixed' AND model_version = 'version-a'
      `).run(),
      /identity is immutable/,
    );
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});

test('FTS5 Chinese search, short-query fallback, true RRF, filters and double-buffer promotion stay honest', () => {
  const database = new ProjectDatabase(':memory:');
  try {
    ['caption', 'ocr', 'embedding'].forEach((capability) => installModel(database, capability));
    let profile = configureProfile(database, 'semantic-project');
    const coast = addAsset(database, 'semantic-project', 'semantic-coast', {
      contentHash: '1'.repeat(64), filename: 'coast.png', metadata: { width: 1024 },
    });
    const city = addAsset(database, 'semantic-project', 'semantic-city', {
      contentHash: '2'.repeat(64), filename: 'city.png', metadata: { width: 768 },
    });
    addAsset(database, 'foreign-project', 'foreign-private-coast', {
      contentHash: '3'.repeat(64), filename: '海边日落-private.png',
    });

    const firstRebuildProfileRevision = profile.revision;
    let generation = database.beginAssetSemanticRebuild('semantic-project', {
      expectedProfileRevision: firstRebuildProfileRevision,
      idempotencyKey: 'semantic-project/rebuild/request-1',
      createdBy: 'owner',
    });
    const repeatedGeneration = database.beginAssetSemanticRebuild('semantic-project', {
      expectedProfileRevision: firstRebuildProfileRevision,
      idempotencyKey: 'semantic-project/rebuild/request-1',
      createdBy: 'owner',
    });
    assert.equal(repeatedGeneration.idempotent, true);
    assert.equal(repeatedGeneration.generation, generation.generation);
    assert.equal(database.listAssetSemanticGenerations('semantic-project').length, 1);
    profile = database.getAssetSemanticProfile('semantic-project');
    const buildingCatalogBeforeNoop = database.getAssetCatalogRevision('semantic-project');
    const buildingProfileRevisionBeforeNoop = profile.revision;
    const buildingGenerationBeforeNoop = profile.buildingGeneration;
    const buildingNoOpProfile = database.setAssetSemanticProfile('semantic-project', {
      enabled: profile.enabled,
      caption: { ...profile.caption },
      ocr: { ...profile.ocr },
      embedding: { ...profile.embedding },
    }, { expectedRevision: profile.revision, updatedBy: 'building-no-op-save' });
    assert.equal(buildingNoOpProfile.revision, buildingProfileRevisionBeforeNoop);
    assert.equal(buildingNoOpProfile.buildingGeneration, buildingGenerationBeforeNoop);
    assert.equal(database.getAssetCatalogRevision('semantic-project'), buildingCatalogBeforeNoop);
    profile = buildingNoOpProfile;
    const planned = [
      [coast, 'embedding'],
      [coast, 'caption'],
      [coast, 'ocr'],
      [city, 'embedding'],
      [city, 'caption'],
      [city, 'ocr'],
    ];
    for (const [asset, capability] of planned) {
      database.enqueueAssetSemanticJob({
        projectId: asset.projectId,
        assetId: asset.id,
        contentHash: asset.contentHash,
        generation: generation.generation,
        jobKind: capability,
        modelKey: `${capability}-test-model`,
        modelVersion: 'fixture-v1',
      });
    }
    const sealedGeneration = sealGeneration(database, 'semantic-project', generation.generation);
    assert.equal(sealedGeneration.jobsSealed, true);
    assert.equal(sealedGeneration.expectedJobCount, planned.length);
    assert.throws(
      () => database.enqueueAssetSemanticJob({
        projectId: coast.projectId,
        assetId: coast.id,
        contentHash: coast.contentHash,
        generation: generation.generation,
        jobKind: 'caption',
        modelKey: 'caption-test-model',
        modelVersion: 'fixture-v1',
        id: 'must-not-append-after-seal',
      }),
      (error) => error?.code === 'asset_semantic_generation_conflict',
    );
    const sealedAfterRejectedAppend = database.getAssetSemanticGeneration('semantic-project', generation.generation);
    assert.equal(sealedAfterRejectedAppend.expectedJobCount, planned.length);
    assert.equal(sealedAfterRejectedAppend.counts.total, planned.length);
    const claimedKinds = [];
    while (true) {
      const job = database.claimNextAssetSemanticJob({ projectId: 'semantic-project' });
      if (!job) break;
      claimedKinds.push(job.jobKind);
      if (job.jobKind === 'caption' && job.assetId === coast.id) completeClaim(database, job, { caption: '海边日落与企鹅散步' });
      else if (job.jobKind === 'caption') completeClaim(database, job, { caption: '城市夜景与霓虹灯' });
      else if (job.jobKind === 'ocr') completeClaim(database, job, {
        skipped: { code: 'ocr-no-text', message: '画面没有可识别文字', metadata: { honest: true } },
      });
      else completeClaim(database, job, { embedding: job.assetId === coast.id ? [1, 0, 0] : [0, 1, 0] });
    }
    const firstEmbedding = claimedKinds.indexOf('embedding');
    assert.equal(firstEmbedding > claimedKinds.lastIndexOf('caption'), true, 'upfront embedding jobs wait for caption/OCR terminal states');
    assert.equal(firstEmbedding > claimedKinds.lastIndexOf('ocr'), true);
    const status = database.getAssetSemanticJobStatus({ projectId: 'semantic-project', generation: generation.generation });
    assert.equal(status.counts.succeeded, 4);
    assert.equal(status.counts.skipped, 2);
    assert.equal(status.byCapability.caption.succeeded, 2);
    assert.equal(status.byCapability.ocr.skipped, 2);
    assert.equal(status.byCapability.embedding.succeeded, 2);

    generation = database.getAssetSemanticGeneration('semantic-project', generation.generation);
    generation = database.finishAssetSemanticRebuild('semantic-project', generation.generation, {
      expectedProfileRevision: profile.revision,
      expectedGenerationRevision: generation.revision,
    });
    const promoted = database.promoteAssetSemanticGeneration('semantic-project', generation.generation, {
      expectedProfileRevision: profile.revision,
      expectedGenerationRevision: generation.revision,
    });
    profile = promoted.profile;
    assert.equal(promoted.generation.catalogRevision, promoted.catalogRevision, 'promotion cannot be stale immediately after its own catalog bump');
    const catalogBeforeNoop = database.getAssetCatalogRevision('semantic-project');
    const noOpProfile = database.setAssetSemanticProfile('semantic-project', {
      enabled: profile.enabled,
      caption: { ...profile.caption },
      ocr: { ...profile.ocr },
      embedding: { ...profile.embedding },
    }, { expectedRevision: profile.revision, updatedBy: 'no-op-save' });
    assert.equal(noOpProfile.revision, profile.revision, 'saving identical semantic configuration must be a no-op');
    assert.equal(database.getAssetCatalogRevision('semantic-project'), catalogBeforeNoop);
    assert.equal(database.getAssetSemanticGeneration('semantic-project', generation.generation).catalogRevision, catalogBeforeNoop);

    const chinese = database.searchAssetSemanticDocuments('semantic-project', { query: '海边日落' });
    assert.equal(chinese.strategy, 'fts5-trigram');
    assert.deepEqual(chinese.items.map((item) => item.assetId), [coast.id]);
    const short = database.searchAssetSemanticDocuments('semantic-project', { query: '企鹅' });
    assert.equal(short.strategy, 'like-short-query');
    assert.deepEqual(short.items.map((item) => item.assetId), [coast.id]);
    assert.deepEqual(database.listAssets({ projectId: 'semantic-project', query: '企鹅' }).map((asset) => asset.id), [coast.id]);
    assert.equal(database.countAssets({ projectId: 'semantic-project', query: '企鹅' }), 1);

    const hybrid = database.searchAssetSemantics('semantic-project', {
      query: '海边',
      queryEmbedding: [1, 0, 0],
      modelKey: 'embedding-test-model',
      modelVersion: 'fixture-v1',
      filters: { kind: 'image', availability: 'available' },
      expectedCatalogRevision: promoted.catalogRevision,
      expectedProfileRevision: profile.revision,
      expectedGeneration: generation.generation,
      limit: 10,
    });
    assert.equal(hybrid.mode, 'hybrid');
    assert.equal(hybrid.scoreMetric, 'rrf-k60');
    assert.equal(hybrid.items[0].asset.id, coast.id);
    assert.equal(hybrid.items[0].score, 2 / 61);
    assert.equal(hybrid.items[0].vectorScore, 1);
    assert.equal(hybrid.items[0].matches.length <= 3, true);
    assert.equal(Object.hasOwn(hybrid.items[0], 'embedding'), false);
    assert.equal(Object.hasOwn(hybrid.items[0].matches[0], 'embedding'), false);
    assert.equal(hybrid.items.some((item) => item.asset.projectId === 'foreign-project'), false);

    const vector = database.searchAssetSemantics('semantic-project', { queryEmbedding: [1, 0, 0], limit: 10 });
    assert.equal(vector.mode, 'vector');
    assert.equal(vector.scoreMetric, 'cosine');
    assert.deepEqual(vector.items.map((item) => [item.asset.id, item.score]), [[coast.id, 1], [city.id, 0]]);
    assert.deepEqual(vector.items.map((item) => item.matches[0].kind), ['caption', 'caption']);
    assert.equal(vector.items.every((item) => item.matches.length >= 1 && item.matches.length <= 3), true, 'pure vector hits retain bounded human-readable evidence');
    assert.equal(vector.items.every((item) => item.matches.every((match) => !Object.hasOwn(match, 'embedding') && !Object.hasOwn(match, 'vector'))), true);
    const evidenceDisabledProfile = database.setAssetSemanticProfile('semantic-project', {
      caption: { enabled: false },
      ocr: { enabled: false },
    }, { expectedRevision: profile.revision, updatedBy: 'privacy-disable' });
    const disabledEvidenceVector = database.searchAssetSemantics('semantic-project', { queryEmbedding: [1, 0, 0], limit: 10 });
    assert.equal(disabledEvidenceVector.items.every((item) => item.matches.every((match) => !['caption', 'ocr'].includes(match.kind))), true);
    assert.deepEqual(disabledEvidenceVector.items.map((item) => item.matches[0].kind), ['filename', 'filename']);
    profile = database.setAssetSemanticProfile('semantic-project', {
      caption: { enabled: true },
      ocr: { enabled: true },
    }, { expectedRevision: evidenceDisabledProfile.revision, updatedBy: 'privacy-reenable' });
    assert.throws(
      () => database.searchAssetSemantics('semantic-project', {
        query: '海边', expectedCatalogRevision: promoted.catalogRevision - 1,
      }),
      (error) => error.code === 'asset_catalog_revision_conflict',
    );

    const generationTwo = database.beginAssetSemanticRebuild('semantic-project', {
      expectedProfileRevision: profile.revision,
      createdBy: 'owner',
    });
    let buildingProfile = database.getAssetSemanticProfile('semantic-project');
    for (const asset of [coast, city]) {
      for (const capability of ['embedding', 'caption', 'ocr']) {
        database.enqueueAssetSemanticJob({
          projectId: asset.projectId,
          assetId: asset.id,
          contentHash: asset.contentHash,
          generation: generationTwo.generation,
          jobKind: capability,
          modelKey: `${capability}-test-model`,
          modelVersion: 'fixture-v1',
        });
      }
    }
    sealGeneration(database, 'semantic-project', generationTwo.generation);
    while (true) {
      const job = database.claimNextAssetSemanticJob({ projectId: 'semantic-project' });
      if (!job) break;
      if (job.jobKind === 'caption') completeClaim(database, job, {
        caption: job.assetId === coast.id ? '雪山极光与海豹' : '城市夜景与霓虹灯',
      });
      else if (job.jobKind === 'ocr') completeClaim(database, job, { skipped: { code: 'ocr-no-text', message: '无文字' } });
      else completeClaim(database, job, { embedding: job.assetId === coast.id ? [1, 0, 0] : [0, 1, 0] });
    }
    assert.equal(database.searchAssetSemanticDocuments('semantic-project', { query: '海边日落' }).items.length, 1);
    assert.equal(database.searchAssetSemanticDocuments('semantic-project', { query: '雪山极光' }).items.length, 0, 'building generation must stay invisible');
    let readyTwo = database.getAssetSemanticGeneration('semantic-project', generationTwo.generation);
    readyTwo = database.finishAssetSemanticRebuild('semantic-project', readyTwo.generation, {
      expectedProfileRevision: buildingProfile.revision,
      expectedGenerationRevision: readyTwo.revision,
    });
    assert.equal(database.searchAssetSemanticDocuments('semantic-project', { query: '海边日落' }).items.length, 1, 'ready but unpromoted generation stays invisible');
    const promotedTwo = database.promoteAssetSemanticGeneration('semantic-project', readyTwo.generation, {
      expectedProfileRevision: buildingProfile.revision,
      expectedGenerationRevision: readyTwo.revision,
    });
    assert.equal(promotedTwo.previousGeneration, 1);
    assert.equal(database.getAssetSemanticGeneration('semantic-project', 1).status, 'superseded');
    assert.equal(database.searchAssetSemanticDocuments('semantic-project', { query: '海边日落' }).items.length, 0);
    assert.deepEqual(database.searchAssetSemanticDocuments('semantic-project', { query: '雪山极光' }).items.map((item) => item.assetId), [coast.id]);
    assert.equal(promotedTwo.generation.catalogRevision, promotedTwo.catalogRevision);

    assert.throws(() => database.db.prepare(`
      INSERT INTO asset_semantic_documents(
        project_id, asset_id, generation, content_hash, document_kind, model_key, model_version,
        text, metadata_json, created_at, updated_at
      ) VALUES ('semantic-project', 'foreign-private-coast', ?, ?, 'caption',
        'caption-test-model', 'fixture-v1', 'forbidden', '{}', 1, 1)
    `).run(promotedTwo.generation.generation, '3'.repeat(64)), /project mismatch|FOREIGN KEY/);

    const rowsBeforeDelete = database.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM asset_semantic_documents WHERE asset_id = ?) AS documents,
        (SELECT COUNT(*) FROM asset_semantic_embeddings WHERE asset_id = ?) AS embeddings,
        (SELECT COUNT(*) FROM asset_semantic_jobs WHERE asset_id = ?) AS jobs
    `).get(coast.id, coast.id, coast.id);
    assert.equal(rowsBeforeDelete.documents > 0 && rowsBeforeDelete.embeddings > 0 && rowsBeforeDelete.jobs > 0, true);
    database.removeAssetIndex(coast.id);
    assert.deepEqual(database.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM asset_semantic_documents WHERE asset_id = ?) AS documents,
        (SELECT COUNT(*) FROM asset_semantic_embeddings WHERE asset_id = ?) AS embeddings,
        (SELECT COUNT(*) FROM asset_semantic_jobs WHERE asset_id = ?) AS jobs,
        (SELECT COUNT(*) FROM asset_semantic_fts WHERE asset_id = ?) AS fts
    `).get(coast.id, coast.id, coast.id, coast.id), { documents: 0, embeddings: 0, jobs: 0, fts: 0 });
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});

for (const mutation of ['add', 'modify', 'delete']) {
  test(`promotion rejects ${mutation} catalog drift without replacing the active generation`, () => {
    const database = new ProjectDatabase(':memory:');
    const projectId = `catalog-drift-${mutation}`;
    try {
      installModel(database, 'embedding');
      let profile = configureProfile(database, projectId, ['embedding']);
      const stableAsset = addAsset(database, projectId, `${mutation}-stable`, {
        contentHash: '1'.repeat(64), filename: `${mutation}-stable.png`,
      });
      const mutationTarget = addAsset(database, projectId, `${mutation}-target`, {
        contentHash: '2'.repeat(64), filename: `${mutation}-target.png`,
      });

      const first = buildReadyEmbeddingGeneration(
        database, projectId, profile.revision, [stableAsset, mutationTarget], `${mutation}/generation-1`,
      );
      const firstPromotion = database.promoteAssetSemanticGeneration(projectId, first.ready.generation, {
        expectedProfileRevision: first.profile.revision,
        expectedGenerationRevision: first.ready.revision,
      });
      profile = firstPromotion.profile;
      assert.equal(firstPromotion.generation.status, 'active', 'a stable catalog must still promote normally');

      const replacement = buildReadyEmbeddingGeneration(
        database, projectId, profile.revision, [stableAsset, mutationTarget], `${mutation}/generation-2`,
      );
      const boundCatalogRevision = replacement.ready.catalogRevision;
      if (mutation === 'add') {
        addAsset(database, projectId, `${mutation}-new`, {
          contentHash: '3'.repeat(64), filename: `${mutation}-new.png`,
        });
      } else if (mutation === 'modify') {
        database.upsertAsset({
          ...mutationTarget,
          contentHash: '4'.repeat(64),
          metadata: { ...mutationTarget.metadata, changedDuringRebuild: true },
        });
      } else {
        database.removeAssetIndex(mutationTarget.id);
      }
      const liveCatalogRevision = database.getAssetCatalogRevision(projectId);
      assert.notEqual(liveCatalogRevision, boundCatalogRevision);

      assert.throws(
        () => database.promoteAssetSemanticGeneration(projectId, replacement.ready.generation, {
          expectedProfileRevision: replacement.profile.revision,
          expectedGenerationRevision: replacement.ready.revision,
        }),
        (error) => error.code === 'asset_catalog_revision_conflict'
          && error.current.catalogRevision === liveCatalogRevision,
      );
      assert.equal(
        database.getAssetCatalogRevision(projectId),
        liveCatalogRevision,
        'rejected promotion must not overwrite or bump the newer catalog revision',
      );

      const failedReplacement = database.getAssetSemanticGeneration(projectId, replacement.ready.generation);
      const retainedProfile = database.getAssetSemanticProfile(projectId);
      const retainedActive = database.getAssetSemanticGeneration(projectId, firstPromotion.generation.generation);
      assert.equal(failedReplacement.status, 'failed');
      assert.equal(failedReplacement.errorCode, 'asset_catalog_revision_conflict');
      assert.equal(failedReplacement.catalogRevision, boundCatalogRevision);
      assert.equal(retainedProfile.activeGeneration, firstPromotion.generation.generation);
      assert.equal(retainedProfile.buildingGeneration, null);
      assert.equal(retainedActive.status, 'active');

      const oldActiveSearch = database.searchAssetSemantics(projectId, {
        queryEmbedding: [1, 0],
        modelKey: 'embedding-test-model',
        modelVersion: 'fixture-v1',
        expectedCatalogRevision: liveCatalogRevision,
        expectedProfileRevision: retainedProfile.revision,
        expectedGeneration: retainedProfile.activeGeneration,
      });
      assert.equal(oldActiveSearch.items.some((item) => item.asset.id === stableAsset.id), true);
      assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(database.db.pragma('foreign_key_check'), []);
    } finally {
      database.close();
    }
  });
}

test('retry atomically reopens the latest failed replacement and can promote it without replacing the old active early', () => {
  const database = new ProjectDatabase(':memory:');
  const projectId = 'failed-replacement-retry';
  try {
    installModel(database, 'embedding');
    let profile = configureProfile(database, projectId, ['embedding']);
    const asset = addAsset(database, projectId, 'retry-generation-asset', {
      contentHash: '5'.repeat(64), filename: 'retry-generation-asset.png',
    });
    const first = buildReadyEmbeddingGeneration(database, projectId, profile.revision, [asset], 'retry/generation-1');
    const firstPromotion = database.promoteAssetSemanticGeneration(projectId, first.ready.generation, {
      expectedProfileRevision: first.profile.revision,
      expectedGenerationRevision: first.ready.revision,
    });
    profile = firstPromotion.profile;

    const replacement = database.beginAssetSemanticRebuild(projectId, {
      expectedProfileRevision: profile.revision,
      idempotencyKey: 'retry/generation-2',
      createdBy: 'retry-owner',
    });
    const buildingProfile = database.getAssetSemanticProfile(projectId);
    database.enqueueAssetSemanticJob({
      projectId,
      assetId: asset.id,
      contentHash: asset.contentHash,
      generation: replacement.generation,
      jobKind: 'embedding',
      modelKey: 'embedding-test-model',
      modelVersion: 'fixture-v1',
    });
    sealGeneration(database, projectId, replacement.generation);
    const claim = database.claimNextAssetSemanticJob({ projectId });
    const failedJob = database.rescheduleAssetSemanticJob(claim.id, {
      code: 'fixture-terminal-failure', message: 'first attempt failed',
    }, {
      claimToken: claim.claimToken,
      expectedRevision: claim.revision,
      retryable: false,
    });
    let failedGeneration = database.getAssetSemanticGeneration(projectId, replacement.generation);
    failedGeneration = database.finishAssetSemanticRebuild(projectId, replacement.generation, {
      expectedProfileRevision: buildingProfile.revision,
      expectedGenerationRevision: failedGeneration.revision,
    });
    assert.equal(failedGeneration.status, 'failed');
    assert.equal(database.getAssetSemanticProfile(projectId).buildingGeneration, null);
    assert.equal(database.getAssetSemanticGeneration(projectId, firstPromotion.generation.generation).status, 'active');
    const installedEmbedding = database.getAssetSemanticModel('embedding-test-model', 'fixture-v1');
    const unavailableEmbedding = database.setAssetSemanticModelState({
      modelKey: 'embedding-test-model',
      modelVersion: 'fixture-v1',
      capability: 'embedding',
      status: 'not-installed',
    }, { expectedRevision: installedEmbedding.revision });
    assert.throws(
      () => database.retryAssetSemanticJob(projectId, failedJob.id, { expectedRevision: failedJob.revision }),
      (error) => error.code === 'asset_semantic_model_not_installed',
    );
    assert.equal(database.getAssetSemanticProfile(projectId).buildingGeneration, null);
    assert.equal(database.getAssetSemanticGeneration(projectId, replacement.generation).status, 'failed');
    database.setAssetSemanticModelState({
      modelKey: 'embedding-test-model',
      modelVersion: 'fixture-v1',
      capability: 'embedding',
      status: 'installed',
      downloadedBytes: 1024,
      totalBytes: 1024,
      byteSize: 1024,
      installPath: 'semantic-models/embedding/fixture-v1',
    }, { expectedRevision: unavailableEmbedding.revision });
    assert.throws(
      () => database.retryAssetSemanticJob(projectId, failedJob.id, { expectedRevision: failedJob.revision - 1 }),
      (error) => error.code === 'asset_semantic_job_revision_conflict',
    );

    const retried = database.retryAssetSemanticJob(projectId, failedJob.id, {
      expectedRevision: failedJob.revision,
      updatedBy: 'retry-owner',
    });
    const reopenedProfile = database.getAssetSemanticProfile(projectId);
    const reopenedGeneration = database.getAssetSemanticGeneration(projectId, replacement.generation);
    assert.equal(retried.status, 'queued');
    assert.equal(reopenedProfile.activeGeneration, firstPromotion.generation.generation);
    assert.equal(reopenedProfile.buildingGeneration, replacement.generation);
    assert.equal(reopenedGeneration.status, 'building');
    assert.equal(database.getAssetSemanticGeneration(projectId, firstPromotion.generation.generation).status, 'active');

    const retryClaim = database.claimNextAssetSemanticJob({ projectId });
    completeClaim(database, retryClaim, { embedding: [1, 0] });
    const completedGeneration = database.getAssetSemanticGeneration(projectId, replacement.generation);
    const ready = database.finishAssetSemanticRebuild(projectId, replacement.generation, {
      expectedProfileRevision: reopenedProfile.revision,
      expectedGenerationRevision: completedGeneration.revision,
    });
    const promoted = database.promoteAssetSemanticGeneration(projectId, replacement.generation, {
      expectedProfileRevision: reopenedProfile.revision,
      expectedGenerationRevision: ready.revision,
    });
    assert.equal(promoted.profile.activeGeneration, replacement.generation);
    assert.equal(promoted.profile.buildingGeneration, null);
    assert.equal(promoted.generation.status, 'active');
    assert.equal(database.getAssetSemanticGeneration(projectId, firstPromotion.generation.generation).status, 'superseded');
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});

test('stale completions, exact job retry CAS, supersede and restart recovery never write old artifacts', () => {
  const database = new ProjectDatabase(':memory:');
  try {
    installModel(database, 'caption');
    let profile = configureProfile(database, 'stale-project', ['caption']);
    const changed = addAsset(database, 'stale-project', 'stale-content', { contentHash: 'a'.repeat(64) });
    const retryable = addAsset(database, 'stale-project', 'retry-exact', { contentHash: 'b'.repeat(64) });
    const queued = addAsset(database, 'stale-project', 'queued-supersede', { contentHash: 'c'.repeat(64) });
    const generation = database.beginAssetSemanticRebuild('stale-project', { expectedProfileRevision: profile.revision });
    profile = database.getAssetSemanticProfile('stale-project');
    const jobs = [changed, retryable, queued].map((asset, index) => database.enqueueAssetSemanticJob({
      projectId: asset.projectId,
      assetId: asset.id,
      contentHash: asset.contentHash,
      generation: generation.generation,
      jobKind: 'caption',
      modelKey: 'caption-test-model',
      modelVersion: 'fixture-v1',
      createdAt: 100 + index,
    }));
    sealGeneration(database, 'stale-project', generation.generation);

    const staleClaim = database.claimNextAssetSemanticJob({ projectId: 'stale-project' });
    assert.equal(staleClaim.assetId, changed.id);
    database.upsertAsset({ ...changed, contentHash: 'd'.repeat(64), metadata: { changed: true } });
    const staleResult = completeClaim(database, staleClaim, { caption: '不能写回的旧描述' });
    assert.equal(staleResult.applied, false);
    assert.equal(staleResult.reason, 'source-content-changed');
    assert.equal(staleResult.job.status, 'failed');
    assert.equal(database.listAssetSemanticDocuments('stale-project', { assetId: changed.id }).length, 0);
    assert.equal(completeClaim(database, staleClaim, { caption: '重复旧完成' }).reason, 'stale-claim');

    let retryClaim = database.claimNextAssetSemanticJob({ projectId: 'stale-project' });
    assert.equal(retryClaim.assetId, retryable.id);
    const failed = database.rescheduleAssetSemanticJob(retryClaim.id, { code: 'fixture-failure', message: '失败' }, {
      claimToken: retryClaim.claimToken,
      expectedRevision: retryClaim.revision,
      retryable: false,
    });
    assert.equal(failed.status, 'failed');
    const retried = database.retryAssetSemanticJob('stale-project', failed.id, { expectedRevision: failed.revision });
    assert.equal(retried.status, 'queued');
    assert.equal(retried.revision, failed.revision + 1);
    assert.throws(
      () => database.retryAssetSemanticJob('stale-project', failed.id, { expectedRevision: failed.revision }),
      (error) => error.code === 'asset_semantic_job_revision_conflict',
    );
    retryClaim = database.claimNextAssetSemanticJob({ projectId: 'stale-project' });
    assert.equal(retryClaim.id, failed.id);

    const disabledProfile = database.setAssetSemanticProfile('stale-project', { enabled: false }, {
      expectedRevision: profile.revision,
      updatedBy: 'owner',
    });
    const supersededRunning = completeClaim(database, retryClaim, { caption: '配置变化后的旧结果' });
    assert.equal(supersededRunning.applied, false);
    assert.equal(supersededRunning.reason, 'semantic-generation-stale');
    assert.equal(supersededRunning.job.status, 'superseded');
    const bulk = database.supersedeAssetSemanticJobs('stale-project', {
      generation: generation.generation,
      capabilities: ['caption'],
      reason: 'profile disabled',
    });
    assert.equal(bulk.superseded, 1);
    assert.equal(database.getAssetSemanticJob(jobs[2].id).status, 'superseded');

    let failedGeneration = database.getAssetSemanticGeneration('stale-project', generation.generation);
    failedGeneration = database.finishAssetSemanticRebuild('stale-project', generation.generation, {
      expectedProfileRevision: disabledProfile.revision,
      expectedGenerationRevision: failedGeneration.revision,
      error: { code: 'profile-disabled', message: '用户禁用了语义能力' },
    });
    assert.equal(failedGeneration.status, 'failed');
    assert.equal(database.getAssetSemanticProfile('stale-project').buildingGeneration, null);
    assert.deepEqual(database.recoverInterruptedAssetSemanticJobs(), {
      recovered: 0, failed: 0, superseded: 0, enrollmentFailed: 0,
    });
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM asset_semantic_documents').get().count, 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});

test('startup fails unsealed enrollment at zero, partial, and final-job-before-seal crash windows', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-enrollment-crash-'));
  const filename = path.join(directory, 'projects.sqlite3');
  let database = new ProjectDatabase(filename, { autoBackup: false });
  const generations = [];
  try {
    installModel(database, 'embedding');
    for (const enrolledJobs of [0, 1, 2]) {
      const projectId = `enrollment-crash-${enrolledJobs}`;
      const profile = configureProfile(database, projectId, ['embedding']);
      const assets = [
        addAsset(database, projectId, `${projectId}-a`, { contentHash: `${enrolledJobs + 1}`.repeat(64) }),
        addAsset(database, projectId, `${projectId}-b`, { contentHash: `${enrolledJobs + 4}`.repeat(64) }),
      ];
      const generation = database.beginAssetSemanticRebuild(projectId, {
        expectedProfileRevision: profile.revision,
        idempotencyKey: `${projectId}/generation-1`,
      });
      for (const asset of assets.slice(0, enrolledJobs)) {
        database.enqueueAssetSemanticJob({
          projectId,
          assetId: asset.id,
          contentHash: asset.contentHash,
          generation: generation.generation,
          jobKind: 'embedding',
          modelKey: 'embedding-test-model',
          modelVersion: 'fixture-v1',
        });
      }
      const unsealed = database.getAssetSemanticGeneration(projectId, generation.generation);
      assert.equal(unsealed.jobsSealed, false);
      assert.equal(unsealed.counts.total, enrolledJobs);
      assert.equal(database.claimNextAssetSemanticJob({ projectId }), null, 'unsealed jobs must never be claimed');
      generations.push({ projectId, generation: generation.generation, enrolledJobs });
    }
    database.close();
    database = new ProjectDatabase(filename, { autoBackup: false });
    const recovery = database.recoverInterruptedAssetSemanticJobs();
    assert.deepEqual(recovery, { recovered: 0, failed: 0, superseded: 0, enrollmentFailed: 3 });
    for (const item of generations) {
      const generation = database.getAssetSemanticGeneration(item.projectId, item.generation);
      const profile = database.getAssetSemanticProfile(item.projectId);
      assert.equal(generation.status, 'failed');
      assert.equal(generation.errorCode, 'asset-semantic-enrollment-incomplete');
      assert.equal(profile.activeGeneration, null);
      assert.equal(profile.buildingGeneration, null);
      assert.equal(database.listAssetSemanticJobs({
        projectId: item.projectId, generation: item.generation, limit: 10,
      }).every((job) => job.status === 'superseded'), true);
    }
  } finally {
    database?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('atomic enrollment indexes only verified hashes, reports exclusions, and promotes all-unverified projects as empty', () => {
  const database = new ProjectDatabase(':memory:');
  try {
    installModel(database, 'embedding');
    let profile = configureProfile(database, 'mixed-enrollment', ['embedding']);
    const verified = addAsset(database, 'mixed-enrollment', 'mixed-verified', {
      contentHash: '1'.repeat(64), filename: 'verified-searchable.png',
    });
    addAsset(database, 'mixed-enrollment', 'mixed-unverified', {
      contentHash: '2'.repeat(64), contentHashVerification: 'unverified', filename: 'unverified-visible.png',
    });
    database.upsertAsset({
      id: 'mixed-null-hash',
      projectId: 'mixed-enrollment',
      kind: 'image',
      mimeType: 'image/png',
      filename: 'null-hash-visible.png',
      contentHash: null,
      storageMode: 'remote',
      availability: 'available',
    });
    let generation = database.beginAssetSemanticRebuild('mixed-enrollment', {
      expectedProfileRevision: profile.revision,
      idempotencyKey: 'mixed-enrollment/generation-1',
      enrollAssets: true,
      maximumAssets: 50_000,
    });
    assert.equal(generation.jobsSealed, true);
    assert.equal(generation.eligibleAssetCount, 1);
    assert.equal(generation.excludedAssetCount, 2);
    assert.equal(generation.expectedJobCount, 1);
    assert.equal(generation.counts.total, 1);
    assert.deepEqual(database.listAssetSemanticJobs({
      projectId: 'mixed-enrollment', generation: generation.generation, limit: 10,
    }).map((job) => job.assetId), [verified.id]);
    const claim = database.claimNextAssetSemanticJob({ projectId: 'mixed-enrollment' });
    completeClaim(database, claim, { embedding: [1, 0] });
    profile = database.getAssetSemanticProfile('mixed-enrollment');
    generation = database.getAssetSemanticGeneration('mixed-enrollment', generation.generation);
    const ready = database.finishAssetSemanticRebuild('mixed-enrollment', generation.generation, {
      expectedProfileRevision: profile.revision,
      expectedGenerationRevision: generation.revision,
    });
    database.promoteAssetSemanticGeneration('mixed-enrollment', ready.generation, {
      expectedProfileRevision: profile.revision,
      expectedGenerationRevision: ready.revision,
    });
    assert.equal(database.countAssets({ projectId: 'mixed-enrollment' }), 3, 'excluded assets remain in the base catalog');

    profile = configureProfile(database, 'all-unverified-enrollment', ['embedding']);
    addAsset(database, 'all-unverified-enrollment', 'only-unverified', {
      contentHash: '3'.repeat(64), contentHashVerification: 'unverified',
    });
    database.upsertAsset({
      id: 'only-null-hash', projectId: 'all-unverified-enrollment', kind: 'image',
      filename: 'only-null.png', contentHash: null, storageMode: 'remote', availability: 'missing',
    });
    const emptyBuilding = database.beginAssetSemanticRebuild('all-unverified-enrollment', {
      expectedProfileRevision: profile.revision,
      idempotencyKey: 'all-unverified-enrollment/generation-1',
      enrollAssets: true,
    });
    assert.equal(emptyBuilding.jobsSealed, true);
    assert.equal(emptyBuilding.eligibleAssetCount, 0);
    assert.equal(emptyBuilding.excludedAssetCount, 2);
    assert.equal(emptyBuilding.expectedJobCount, 0);
    const emptyProfile = database.getAssetSemanticProfile('all-unverified-enrollment');
    const emptyReady = database.finishAssetSemanticRebuild('all-unverified-enrollment', emptyBuilding.generation, {
      expectedProfileRevision: emptyProfile.revision,
      expectedGenerationRevision: emptyBuilding.revision,
    });
    const emptyActive = database.promoteAssetSemanticGeneration('all-unverified-enrollment', emptyReady.generation, {
      expectedProfileRevision: emptyProfile.revision,
      expectedGenerationRevision: emptyReady.revision,
    });
    assert.equal(emptyActive.generation.status, 'active');
    assert.equal(emptyActive.generation.counts.total, 0);
    assert.equal(database.countAssets({ projectId: 'all-unverified-enrollment' }), 2);
  } finally {
    database.close();
  }
});

test('50k assets x 3 capabilities enroll in one sealed batch transaction', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-enrollment-scale-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const database = new ProjectDatabase(filename, { autoBackup: false });
  const projectId = 'enrollment-scale-50k';
  try {
    for (const capability of ['caption', 'ocr', 'embedding']) installModel(database, capability);
    const now = Date.now();
    database.db.exec(`
      WITH digits(value) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
      sequence(n) AS (
        SELECT ones.value + tens.value * 10 + hundreds.value * 100
          + thousands.value * 1000 + ten_thousands.value * 10000 + 1
        FROM digits ones CROSS JOIN digits tens CROSS JOIN digits hundreds
        CROSS JOIN digits thousands CROSS JOIN digits ten_thousands
        WHERE ones.value + tens.value * 10 + hundreds.value * 100
          + thousands.value * 1000 + ten_thousands.value * 10000 < 50000
      )
      INSERT INTO assets(
        id, project_id, content_hash, kind, mime_type, filename, storage_mode, availability,
        metadata_json, provenance_json, created_by, created_at, updated_at
      )
      SELECT printf('scale-asset-%05d', n), '${projectId}', lower(printf('%064x', n)),
        'image', 'image/png', printf('scale-%05d.png', n), 'managed', 'available',
        '{}', '{}', 'scale-test', ${now}, ${now}
      FROM sequence;
      INSERT INTO asset_blobs(id, content_hash, verification_state, created_at, updated_at)
      SELECT 'blob_' || content_hash, content_hash, 'verified', ${now}, ${now}
      FROM assets WHERE project_id = '${projectId}';
      INSERT INTO asset_blob_refs(project_id, asset_id, blob_id, verification_state, created_at, updated_at)
      SELECT project_id, id, 'blob_' || content_hash, 'verified', ${now}, ${now}
      FROM assets WHERE project_id = '${projectId}';
    `);
    const profile = configureProfile(database, projectId, ['caption', 'ocr', 'embedding']);
    const startedAt = Date.now();
    const generation = database.beginAssetSemanticRebuild(projectId, {
      expectedProfileRevision: profile.revision,
      idempotencyKey: 'enrollment-scale/generation-1',
      enrollAssets: true,
      maximumAssets: 50_000,
      maxAttempts: 3,
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(generation.jobsSealed, true);
    assert.equal(generation.eligibleAssetCount, 50_000);
    assert.equal(generation.excludedAssetCount, 0);
    assert.equal(generation.expectedJobCount, 150_000);
    assert.equal(generation.counts.total, 150_000);
    assert.ok(elapsedMs < 15_000, `bulk enrollment took ${elapsedMs}ms`);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('bounded semantic payload GC preserves active, rollback, retry and building generations while retaining metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-payload-gc-'));
  const database = new ProjectDatabase(path.join(directory, 'projects.sqlite3'), { autoBackup: false });
  const projectId = 'payload-gc-project';
  try {
    installModel(database, 'caption');
    installModel(database, 'embedding');
    const asset = addAsset(database, projectId, 'payload-gc-asset', { contentHash: '9'.repeat(64) });
    let profile = configureProfile(database, projectId, ['caption', 'embedding']);
    const promote = (record) => database.promoteAssetSemanticGeneration(projectId, record.generation, {
      expectedProfileRevision: database.getAssetSemanticProfile(projectId).revision,
      expectedGenerationRevision: record.revision,
    });

    const first = buildCaptionEmbeddingGeneration(
      database, projectId, profile.revision, asset, 'payload-gc/generation-1',
    ).generation;
    promote(first);
    profile = database.getAssetSemanticProfile(projectId);
    const oldFailure = buildCaptionEmbeddingGeneration(
      database, projectId, profile.revision, asset, 'payload-gc/generation-2', { failEmbedding: true },
    );
    profile = database.getAssetSemanticProfile(projectId);
    const rollbackOlder = buildCaptionEmbeddingGeneration(
      database, projectId, profile.revision, asset, 'payload-gc/generation-3',
    ).generation;
    promote(rollbackOlder);
    profile = database.getAssetSemanticProfile(projectId);
    const active = buildCaptionEmbeddingGeneration(
      database, projectId, profile.revision, asset, 'payload-gc/generation-4',
    ).generation;
    promote(active);
    profile = database.getAssetSemanticProfile(projectId);
    const retryableFailure = buildCaptionEmbeddingGeneration(
      database, projectId, profile.revision, asset, 'payload-gc/generation-5', { failEmbedding: true },
    );

    const firstSweep = database.pruneAssetSemanticGenerationPayloads(projectId, {
      limitGenerations: 1,
      now: 20_001,
    });
    assert.equal(firstSweep.prunedGenerationCount, 1);
    assert.equal(firstSweep.hasMore, true);
    const secondSweep = database.pruneAssetSemanticGenerationPayloads(projectId, {
      limitGenerations: 1,
      now: 20_002,
    });
    assert.equal(secondSweep.prunedGenerationCount, 1);
    assert.equal(secondSweep.hasMore, false);
    const prunedIds = [...firstSweep.prunedGenerations, ...secondSweep.prunedGenerations]
      .map((entry) => entry.generation).sort((left, right) => left - right);
    assert.deepEqual(prunedIds, [first.generation, oldFailure.generation.generation]);

    for (const generation of prunedIds) {
      const metadata = database.getAssetSemanticGeneration(projectId, generation);
      assert.ok(metadata, 'generation metadata and idempotency high-water row must remain');
      assert.equal(metadata.jobsSealed, true);
      assert.ok(metadata.expectedJobCount > 0);
      assert.ok(metadata.payloadPrunedAt > 0);
      assert.equal(metadata.counts.total, 0);
      assert.equal(database.db.prepare(`
        SELECT COUNT(*) AS count FROM asset_semantic_fts WHERE project_id = ? AND generation = ?
      `).get(projectId, generation).count, 0);
    }
    for (const generation of [rollbackOlder.generation, active.generation, retryableFailure.generation.generation]) {
      const metadata = database.getAssetSemanticGeneration(projectId, generation);
      assert.equal(metadata.payloadPrunedAt, null);
      assert.ok(metadata.counts.total > 0);
      assert.ok(database.db.prepare(`
        SELECT COUNT(*) AS count FROM asset_semantic_documents WHERE project_id = ? AND generation = ?
      `).get(projectId, generation).count > 0);
    }
    assert.equal(database.searchAssetSemanticDocuments(projectId, { query: 'caption generation' }).items.length, 1);

    const replay = database.beginAssetSemanticRebuild(projectId, {
      expectedProfileRevision: first.profileRevision,
      idempotencyKey: 'payload-gc/generation-1',
    });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.generation, first.generation);
    assert.ok(replay.payloadPrunedAt > 0);

    const failedJob = database.getAssetSemanticJob(retryableFailure.failedJobId);
    const retried = database.retryAssetSemanticJob(projectId, failedJob.id, {
      expectedRevision: failedJob.revision,
      updatedBy: 'payload-gc-retry-test',
    });
    assert.equal(retried.status, 'queued');
    assert.equal(database.getAssetSemanticGeneration(projectId, retryableFailure.generation.generation).status, 'building');
    database.pruneAssetSemanticGenerationPayloads(projectId, { limitGenerations: 4, now: 20_003 });
    assert.ok(database.getAssetSemanticJob(retried.id), 'running retry payload must stay protected');
    const retryClaim = database.claimNextAssetSemanticJob({ projectId });
    completeClaim(database, retryClaim, { embedding: [1, 5] });
    const retryProfile = database.getAssetSemanticProfile(projectId);
    const retryGeneration = database.getAssetSemanticGeneration(projectId, retryableFailure.generation.generation);
    const retryReady = database.finishAssetSemanticRebuild(projectId, retryGeneration.generation, {
      expectedProfileRevision: retryProfile.revision,
      expectedGenerationRevision: retryGeneration.revision,
    });
    promote(retryReady);
    assert.equal(database.getAssetSemanticGeneration(projectId, retryReady.generation).status, 'active');

    const beforeNext = database.getAssetSemanticProfile(projectId);
    const readyNext = buildCaptionEmbeddingGeneration(
      database, projectId, beforeNext.revision, asset, 'payload-gc/generation-6',
    ).generation;
    assert.equal(readyNext.generation, 6, 'pruning must never lower the generation high-water mark');
    database.pruneAssetSemanticGenerationPayloads(projectId, { limitGenerations: 4, now: 20_004 });
    assert.equal(readyNext.status, 'ready');
    assert.equal(database.getAssetSemanticGeneration(projectId, readyNext.generation).status, 'ready');
    assert.ok(database.getAssetSemanticGeneration(projectId, readyNext.generation).counts.total > 0);
    assert.equal(database.getAssetSemanticGeneration(projectId, retryReady.generation).status, 'active');
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
    assert.doesNotThrow(() => database.db.exec("INSERT INTO asset_semantic_fts(asset_semantic_fts) VALUES('integrity-check')"));
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Float32LE encoding, vector constraints and cosine validation fail closed without exposing embeddings', () => {
  const encoded = encodeFloat32LE([1, -2, 0.5]);
  assert.equal(encoded.dimensions, 3);
  assert.equal(encoded.blob.length, 12);
  assert.equal(encoded.blob.readFloatLE(0), 1);
  assert.equal(encoded.blob.readFloatLE(4), -2);
  assert.deepEqual(decodeFloat32LE(encoded.blob, 3), [1, -2, 0.5]);
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  assert.throws(() => encodeFloat32LE(Buffer.alloc(8)), /不能假定 Buffer 字节序/);
  assert.throws(() => encodeFloat32LE([0, 0]), /范数/);
  assert.throws(() => encodeFloat32LE([1, Number.NaN]), /非有限/);
  assert.throws(() => decodeFloat32LE(Buffer.alloc(7), 2), /长度与维度不一致/);
  assert.throws(() => cosineSimilarity([1, 0], [1, 0, 0]), /维度不一致/);

  const database = new ProjectDatabase(':memory:');
  try {
    installModel(database, 'embedding');
    const profile = configureProfile(database, 'vector-project', ['embedding']);
    const asset = addAsset(database, 'vector-project', 'vector-asset', { contentHash: 'e'.repeat(64) });
    const generation = database.beginAssetSemanticRebuild('vector-project', { expectedProfileRevision: profile.revision });
    assert.throws(() => database.db.prepare(`
      INSERT INTO asset_semantic_embeddings(
        project_id, asset_id, generation, content_hash, model_key, model_version,
        dimensions, vector_blob, vector_norm, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'embedding-test-model', 'fixture-v1', 2, ?, 1, '{}', 1, 1)
    `).run('vector-project', asset.id, generation.generation, asset.contentHash, Buffer.alloc(7)), /CHECK constraint/);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});
