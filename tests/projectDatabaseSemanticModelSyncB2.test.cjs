'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');

function modelState(modelKey, capability, status = 'not-installed', overrides = {}) {
  const installed = status === 'installed';
  return {
    modelKey,
    modelVersion: 'fixture-v1',
    capability,
    status,
    ...(installed ? {
      artifactDigest: `${modelKey}-digest`,
      byteSize: 100,
      downloadedBytes: 100,
      totalBytes: 100,
      installPath: `models/${modelKey}`,
      installedAt: 1_700_000_000_000,
    } : {}),
    ...overrides,
  };
}

function absentObservation(state) {
  return { expected: null, state };
}

test('B2 semantic observation getter is pure and batch materializes logical revisions atomically', async () => {
  const database = new ProjectDatabase(':memory:');
  let queryOnly = false;
  try {
    const missing = database.getAssetSemanticModelObservation('semantic-caption-b2', 'fixture-v1');
    assert.deepEqual(missing, {
      model: null,
      present: false,
      revision: 0,
      rowDigest: null,
    });
    const beforeRead = Number(database.db.prepare('SELECT total_changes() AS value').get().value);
    database.db.pragma('query_only = ON');
    queryOnly = true;
    assert.deepEqual(
      database.getAssetSemanticModelObservation('semantic-caption-b2', 'fixture-v1'),
      missing,
    );
    assert.equal(Number(database.db.prepare('SELECT total_changes() AS value').get().value), beforeRead);
    database.db.pragma('query_only = OFF');
    queryOnly = false;

    const result = database.syncAssetSemanticModelObservations([
      absentObservation(modelState('semantic-caption-b2', 'caption')),
      absentObservation(modelState('semantic-ocr-b2', 'ocr', 'installed')),
      absentObservation(modelState('semantic-embedding-b2', 'embedding', 'failed', {
        error: { code: 'fixture-failed', message: 'fixture failed' },
      })),
    ], { now: 1_700_000_000_100 });
    assert.equal(result.changedCount, 3);
    assert.deepEqual(result.changed, [true, true, true]);
    assert.deepEqual(result.models.map((model) => model.revision), [1, 2, 2]);
    assert.deepEqual(result.models.map((model) => model.status), ['not-installed', 'installed', 'failed']);
    assert.equal(result.observations.every((observation) => /^[a-f0-9]{64}$/.test(observation.rowDigest)), true);
    assert.deepEqual(
      database.getAssetSemanticModelObservation('semantic-ocr-b2', 'fixture-v1'),
      result.observations[1],
    );

    const unchanged = database.syncAssetSemanticModelObservations(result.observations.map((expected) => ({
      expected,
      state: expected.model,
    })), { now: 1_700_000_000_200 });
    assert.equal(unchanged.changedCount, 0);
    assert.deepEqual(unchanged.changed, [false, false, false]);
    assert.deepEqual(unchanged.observations, result.observations);
    const flatUnchanged = database.syncAssetSemanticModelObservations([{
      expectedPresent: result.observations[0].present,
      expectedRevision: result.observations[0].revision,
      expectedRowDigest: result.observations[0].rowDigest,
      state: result.models[0],
    }], { now: 1_700_000_000_300 });
    assert.equal(flatUnchanged.changedCount, 0);
    assert.deepEqual(flatUnchanged.changed, [false]);
    assert.deepEqual(flatUnchanged.observations[0], result.observations[0]);

    assert.throws(
      () => database.syncAssetSemanticModelObservations([]),
      /必须包含 1-3 项/,
    );
    assert.throws(
      () => database.syncAssetSemanticModelObservations([
        { expected: result.observations[0], state: result.models[0] },
        { expected: result.observations[0], state: result.models[0] },
      ]),
      /重复身份/,
    );
  } finally {
    if (queryOnly) database.db.pragma('query_only = OFF');
    await database.close();
  }
});

test('B2 semantic batch freezes all CAS before writes and accepts only equivalent concurrent no-op', async () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const seeded = database.syncAssetSemanticModelObservations([
      absentObservation(modelState('semantic-cas-caption-b2', 'caption')),
      absentObservation(modelState('semantic-cas-ocr-b2', 'ocr')),
      absentObservation(modelState('semantic-cas-embedding-b2', 'embedding')),
    ], { now: 1_700_000_001_000 });
    const before = seeded.observations;
    const concurrentTarget = modelState('semantic-cas-embedding-b2', 'embedding', 'installed');
    database.setAssetSemanticModelState(concurrentTarget, {
      expectedRevision: before[2].revision,
      now: 1_700_000_001_100,
    });
    const firstBeforeConflict = database.getAssetSemanticModelObservation('semantic-cas-caption-b2', 'fixture-v1');
    const secondBeforeConflict = database.getAssetSemanticModelObservation('semantic-cas-ocr-b2', 'fixture-v1');

    assert.throws(
      () => database.syncAssetSemanticModelObservations([
        {
          expected: before[0],
          state: modelState('semantic-cas-caption-b2', 'caption', 'failed', {
            error: { code: 'should-rollback', message: 'should rollback' },
          }),
        },
        { expected: before[1], state: modelState('semantic-cas-ocr-b2', 'ocr', 'installed') },
        { expected: before[2], state: modelState('semantic-cas-embedding-b2', 'embedding') },
      ], { now: 1_700_000_001_200 }),
      (error) => error.code === 'asset_semantic_model_revision_conflict'
        && error.current.modelKey === 'semantic-cas-embedding-b2'
        && error.current.revision === 2,
    );
    assert.deepEqual(
      database.getAssetSemanticModelObservation('semantic-cas-caption-b2', 'fixture-v1'),
      firstBeforeConflict,
    );
    assert.deepEqual(
      database.getAssetSemanticModelObservation('semantic-cas-ocr-b2', 'fixture-v1'),
      secondBeforeConflict,
    );

    database.db.prepare(`
      UPDATE asset_semantic_models SET artifact_digest = 'tampered-without-revision'
      WHERE model_key = 'semantic-cas-ocr-b2' AND model_version = 'fixture-v1'
    `).run();
    assert.throws(
      () => database.syncAssetSemanticModelObservations([{
        expected: secondBeforeConflict,
        state: secondBeforeConflict.model,
      }]),
      (error) => error.code === 'asset_semantic_model_revision_conflict'
        && error.current.revision === secondBeforeConflict.revision
        && error.current.rowDigest !== secondBeforeConflict.rowDigest,
    );
    database.db.prepare(`
      UPDATE asset_semantic_models SET artifact_digest = NULL
      WHERE model_key = 'semantic-cas-ocr-b2' AND model_version = 'fixture-v1'
    `).run();

    const equivalentExpected = database.getAssetSemanticModelObservation('semantic-cas-caption-b2', 'fixture-v1');
    const equivalentTarget = modelState('semantic-cas-caption-b2', 'caption', 'installed');
    const concurrent = database.setAssetSemanticModelState(equivalentTarget, {
      expectedRevision: equivalentExpected.revision,
      now: 1_700_000_001_300,
    });
    const equivalent = database.syncAssetSemanticModelObservations([{
      expected: equivalentExpected,
      state: equivalentTarget,
    }], { now: 1_700_000_001_400 });
    assert.equal(equivalent.changedCount, 0);
    assert.deepEqual(equivalent.changed, [false]);
    assert.equal(equivalent.models[0].revision, concurrent.revision);
    assert.equal(equivalent.models[0].updatedAt, concurrent.updatedAt);
  } finally {
    await database.close();
  }
});

test('B2 semantic batch translates real third-write SQLITE_FULL and rolls the whole group back for exact retry', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-sync-full-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  let database = null;
  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    let lateThirdWriteReached = false;
    database.db.function('semantic_sync_b2_mark_third_write', () => {
      lateThirdWriteReached = true;
      return 1;
    });
    database.db.exec(`
      CREATE TABLE semantic_sync_b2_filler (
        id INTEGER PRIMARY KEY,
        payload BLOB NOT NULL
      );
      CREATE TRIGGER semantic_sync_b2_force_third_full
      BEFORE INSERT ON asset_semantic_models
      WHEN NEW.model_key = 'semantic-full-3-b2'
      BEGIN
        SELECT semantic_sync_b2_mark_third_write();
        INSERT INTO semantic_sync_b2_filler(payload) VALUES (zeroblob(16777216));
      END;
    `);
    database.db.pragma('wal_checkpoint(TRUNCATE)');
    database.db.exec('VACUUM');
    database.db.pragma('wal_checkpoint(TRUNCATE)');
    const pageCount = Number(database.db.pragma('page_count', { simple: true }));
    const constrainedPageCount = pageCount + 64;
    assert.equal(
      Number(database.db.pragma(`max_page_count = ${constrainedPageCount}`, { simple: true })),
      constrainedPageCount,
    );

    const observations = [
      absentObservation(modelState('semantic-full-1-b2', 'caption')),
      absentObservation(modelState('semantic-full-2-b2', 'ocr', 'installed')),
      absentObservation(modelState('semantic-full-3-b2', 'embedding', 'failed', {
        error: { code: 'fixture-full', message: 'fixture full' },
      })),
    ];
    assert.throws(
      () => database.syncAssetSemanticModelObservations(observations, { now: 1_700_000_002_000 }),
      (error) => {
        assert.ok(error instanceof ProjectDatabaseStorageCapacityError);
        assert.equal(error.code, 'project_database_storage_capacity_exceeded');
        assert.equal(error.status, 507);
        assert.equal(error.reason, 'sqlite-full');
        assert.deepEqual(error.details, {
          reason: 'sqlite-full',
          retryable: false,
          operation: 'asset.semantic.models.sync',
        });
        return true;
      },
    );
    assert.equal(lateThirdWriteReached, true);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM asset_semantic_models').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM semantic_sync_b2_filler').get().count, 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');

    database.db.pragma('max_page_count = 1073741823');
    lateThirdWriteReached = false;
    const retried = database.syncAssetSemanticModelObservations(observations, { now: 1_700_000_002_000 });
    assert.equal(lateThirdWriteReached, true);
    assert.equal(retried.changedCount, 3);
    assert.deepEqual(retried.models.map((model) => model.revision), [1, 2, 2]);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM asset_semantic_models').get().count, 3);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM semantic_sync_b2_filler').get().count, 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
  } finally {
    try {
      if (database?.db?.open) database.db.pragma('max_page_count = 1073741823');
    } catch (_) {}
    try { await database?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
