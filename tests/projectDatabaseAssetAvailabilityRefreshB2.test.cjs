'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');
const {
  observeAssetAvailabilitySnapshot,
} = require('../backend/src/services/assetAvailability');

const PROJECT_ID = 'project-asset-availability-refresh-b2';
const MAX_PAGE_COUNT_RESET = 1073741823;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function createTempDatabase(prefix = 't8-asset-availability-b2-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filename = path.join(directory, 'projects.sqlite3');
  return {
    directory,
    filename,
    database: new ProjectDatabase(filename, { autoBackup: false }),
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
  const metadata = {
    fixture: suffix,
    ...(input.metadata || {}),
  };
  return database.upsertAsset({
    id: `asset-availability-${suffix}`,
    projectId: PROJECT_ID,
    contentHash: input.contentHash || sha256(`content:${suffix}`),
    contentHashVerification: 'verified',
    kind: 'image',
    mimeType: 'image/png',
    filename: `${suffix}.png`,
    managedPath: input.managedPath || path.join(os.tmpdir(), `t8-availability-${suffix}.png`),
    sourceUrl: `/files/input/${suffix}.png`,
    storageMode: input.storageMode || 'managed',
    availability: input.availability || 'available',
    metadata,
    ...(input.entityUid ? { entityUid: input.entityUid } : {}),
    ...(input.perceptualHash ? {
      perceptualHash: input.perceptualHash,
      perceptualHashAlgorithm: 'dhash-64',
    } : {}),
  });
}

function observation(expected, state, observedContentHash = null, reason = null) {
  const reasons = {
    available: 'source-content-verified',
    missing: 'source-missing',
    'source-changed': 'source-content-changed',
    indeterminate: 'source-io-indeterminate',
  };
  return {
    expected,
    state,
    reason: reason || reasons[state],
    ...(observedContentHash == null ? {} : { observedContentHash }),
  };
}

function sync(database, expected, state, input = {}) {
  return database.syncAssetAvailabilityObservations([
    observation(expected, state, input.observedContentHash, input.reason),
  ], {
    expectedCatalogRevision: expected.catalogRevision,
    ...(input.now == null ? {} : { now: input.now }),
  });
}

function previewMutationInput(claimed, input = {}) {
  return {
    ...input,
    expectedAttempt: claimed,
    expectedAssetSnapshot: claimed.availabilitySnapshot,
  };
}

function rawAssetState(database, assetId) {
  return database.db.prepare(`
    SELECT id, project_id, entity_uid, content_hash, content_revision,
      organization_revision, managed_path, storage_mode, availability,
      metadata_json, created_at, updated_at
    FROM assets WHERE id = ?
  `).get(assetId);
}

function previewDurableState(database, jobId, assetId) {
  return {
    job: database.db.prepare('SELECT * FROM asset_preview_jobs WHERE id = ?').get(jobId),
    asset: rawAssetState(database, assetId),
    catalogRevision: database.getAssetCatalogRevision(PROJECT_ID),
    fingerprints: database.db.prepare(`
      SELECT * FROM asset_fingerprints WHERE asset_id = ? ORDER BY id
    `).all(assetId),
  };
}

test('B2 availability snapshot getters remain pure under PRAGMA query_only', async () => {
  const database = new ProjectDatabase(':memory:');
  let queryOnly = false;
  try {
    const managed = createAsset(database, 'pure-managed');
    createAsset(database, 'pure-linked', { storageMode: 'linked' });
    database.upsertAsset({
      id: 'asset-availability-pure-remote',
      projectId: PROJECT_ID,
      contentHash: sha256('pure-remote'),
      kind: 'image',
      filename: 'remote.png',
      sourceUrl: 'https://example.invalid/remote.png',
      storageMode: 'remote',
      availability: 'unverified',
      metadata: { fixture: 'pure-remote' },
    });
    database.db.prepare(`
      INSERT INTO asset_catalog_revisions(project_id, revision, updated_at)
      VALUES (?, ?, ?)
    `).run('empty-project', 7, 1);
    const beforeChanges = Number(database.db.prepare('SELECT total_changes() AS value').get().value);
    database.db.pragma('query_only = ON');
    queryOnly = true;

    const single = database.getAssetAvailabilitySnapshot(managed.id);
    assert.equal(single.id, managed.id);
    assert.match(single.rowDigest, /^[a-f0-9]{64}$/);
    const listed = database.listAssetAvailabilitySnapshots(PROJECT_ID);
    assert.equal(listed.projectId, PROJECT_ID);
    assert.deepEqual(listed.snapshots.map((item) => item.storageMode), ['linked', 'managed']);
    const originalCatalogGetter = database.getAssetCatalogRevision;
    database.getAssetCatalogRevision = () => {
      throw new Error('availability list must not perform a second catalog read');
    };
    try {
      const empty = database.listAssetAvailabilitySnapshots('empty-project');
      assert.equal(empty.catalogRevision, 7);
      assert.deepEqual(empty.snapshots, []);
    } finally {
      database.getAssetCatalogRevision = originalCatalogGetter;
    }
    assert.equal(Number(database.db.prepare('SELECT total_changes() AS value').get().value), beforeChanges);
  } finally {
    if (queryOnly) database.db.pragma('query_only = OFF');
    await database.close();
  }
});

test('B2 availability lifecycle preserves continuous timestamps, rejects changed bytes, and restores only exact content', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-availability-lifecycle-b2-'));
  const source = path.join(directory, 'source.bin');
  const originalBytes = Buffer.from('availability-original-content');
  fs.writeFileSync(source, originalBytes);
  const database = new ProjectDatabase(':memory:');
  try {
    const asset = createAsset(database, 'lifecycle', {
      contentHash: sha256(originalBytes),
      managedPath: source,
    });

    let expected = database.getAssetAvailabilitySnapshot(asset.id);
    let result = sync(database, expected, 'missing', { now: 1_000 });
    assert.deepEqual(
      { changed: result.changed, missing: result.missing, catalogRevision: result.catalogRevision },
      { changed: 1, missing: 1, catalogRevision: expected.catalogRevision + 1 },
    );
    let current = database.getAsset(asset.id);
    assert.equal(current.availability, 'missing');
    assert.equal(current.metadata.health, 'missing');
    assert.equal(current.metadata.missingSince, 1_000);
    assert.equal(current.organizationRevision, expected.organizationRevision + 1);

    expected = database.getAssetAvailabilitySnapshot(asset.id);
    result = sync(database, expected, 'missing', { now: 2_000 });
    assert.equal(result.changed, 0);
    assert.equal(result.catalogRevision, expected.catalogRevision);
    assert.equal(database.getAsset(asset.id).metadata.missingSince, 1_000);

    fs.writeFileSync(source, 'availability-different-content');
    expected = database.getAssetAvailabilitySnapshot(asset.id);
    const changedObservation = await observeAssetAvailabilitySnapshot(expected);
    assert.equal(changedObservation.state, 'source-changed');
    assert.notEqual(changedObservation.observedContentHash, expected.contentHash);
    result = database.syncAssetAvailabilityObservations([
      { expected, ...changedObservation },
    ], { expectedCatalogRevision: expected.catalogRevision, now: 3_000 });
    assert.equal(result.changed, 1);
    assert.equal(result.sourceChanged, 1);
    current = database.getAsset(asset.id);
    assert.equal(current.availability, 'missing');
    assert.equal(current.metadata.health, 'source-changed');
    assert.equal(current.metadata.availabilityNeedsReindex, true);
    assert.equal(current.metadata.sourceChangedSince, 3_000);
    assert.equal(Object.hasOwn(current.metadata, 'missingSince'), false);

    expected = database.getAssetAvailabilitySnapshot(asset.id);
    result = sync(database, expected, 'source-changed', {
      observedContentHash: changedObservation.observedContentHash,
      now: 3_500,
    });
    assert.equal(result.changed, 0);
    assert.equal(result.sourceChanged, 1);
    assert.equal(database.getAsset(asset.id).metadata.sourceChangedSince, 3_000);

    fs.writeFileSync(source, originalBytes);
    expected = database.getAssetAvailabilitySnapshot(asset.id);
    const restoredObservation = await observeAssetAvailabilitySnapshot(expected);
    assert.equal(restoredObservation.state, 'available');
    result = database.syncAssetAvailabilityObservations([
      { expected, ...restoredObservation },
    ], { expectedCatalogRevision: expected.catalogRevision, now: 4_000 });
    assert.equal(result.changed, 1);
    assert.equal(result.restored, 1);
    current = database.getAsset(asset.id);
    assert.equal(current.availability, 'available');
    assert.equal(current.metadata.health, 'ok');
    assert.equal(Object.hasOwn(current.metadata, 'observedContentHash'), false);
    assert.equal(Object.hasOwn(current.metadata, 'availabilityNeedsReindex'), false);
  } finally {
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('B2 exact verification restores unverified but never overwrites corrupt; indeterminate is zero-write', async () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const unverified = createAsset(database, 'unverified', { availability: 'unverified' });
    let expected = database.getAssetAvailabilitySnapshot(unverified.id);
    let result = sync(database, expected, 'available', {
      observedContentHash: expected.contentHash,
      now: 10_000,
    });
    assert.equal(result.changed, 1);
    assert.equal(database.getAsset(unverified.id).availability, 'available');

    const corrupt = createAsset(database, 'corrupt', {
      availability: 'corrupt',
      metadata: { health: 'corrupt', corruptionReason: 'fixture' },
    });
    expected = database.getAssetAvailabilitySnapshot(corrupt.id);
    const corruptBefore = rawAssetState(database, corrupt.id);
    const catalogBefore = expected.catalogRevision;
    for (const [index, [state, input]] of [
      ['available', { observedContentHash: expected.contentHash }],
      ['missing', {}],
      ['source-changed', { observedContentHash: sha256('corrupt-source-changed') }],
      ['indeterminate', { reason: 'source-permission-denied' }],
    ].entries()) {
      result = sync(database, expected, state, { ...input, now: 11_000 + index });
      assert.equal(result.changed, 0, state);
      assert.equal(result.catalogRevision, catalogBefore, state);
      assert.deepEqual(rawAssetState(database, corrupt.id), corruptBefore, state);
    }

    const legacyCorrupt = createAsset(database, 'legacy-corrupt-unverified', {
      availability: 'unverified',
      metadata: { health: 'corrupt', corruptionReason: 'legacy-fixture' },
    });
    expected = database.getAssetAvailabilitySnapshot(legacyCorrupt.id);
    const legacyCorruptBefore = rawAssetState(database, legacyCorrupt.id);
    for (const [index, [state, input]] of [
      ['available', { observedContentHash: expected.contentHash }],
      ['missing', {}],
      ['source-changed', { observedContentHash: sha256('legacy-corrupt-source-changed') }],
      ['indeterminate', { reason: 'source-permission-denied' }],
    ].entries()) {
      result = sync(database, expected, state, { ...input, now: 11_500 + index });
      assert.equal(result.changed, 0, state);
      assert.equal(result.catalogRevision, expected.catalogRevision, state);
      assert.deepEqual(rawAssetState(database, legacyCorrupt.id), legacyCorruptBefore, state);
    }
    assert.equal(database.getAsset(legacyCorrupt.id).availability, 'unverified');
    assert.equal(database.getAsset(legacyCorrupt.id).metadata.health, 'corrupt');

    const indeterminate = createAsset(database, 'indeterminate');
    expected = database.getAssetAvailabilitySnapshot(indeterminate.id);
    const indeterminateBefore = rawAssetState(database, indeterminate.id);
    result = sync(database, expected, 'indeterminate', {
      reason: 'source-permission-denied',
      now: 12_000,
    });
    assert.equal(result.changed, 0);
    assert.equal(result.indeterminate, 1);
    assert.equal(result.catalogRevision, expected.catalogRevision);
    assert.deepEqual(rawAssetState(database, indeterminate.id), indeterminateBefore);
  } finally {
    await database.close();
  }
});

test('B2 availability batch bumps each organization revision once, catalog once, and repeats as a no-op', async () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const first = createAsset(database, 'batch-first');
    const second = createAsset(database, 'batch-second');
    let batch = database.listAssetAvailabilitySnapshots(PROJECT_ID);
    assert.deepEqual(batch.snapshots.map((item) => item.id), [first.id, second.id]);
    const beforeOrganizations = new Map(batch.snapshots.map((item) => [item.id, item.organizationRevision]));
    const result = database.syncAssetAvailabilityObservations(
      batch.snapshots.map((expected) => observation(expected, 'missing')),
      { expectedCatalogRevision: batch.catalogRevision, now: 20_000 },
    );
    assert.equal(result.checked, 2);
    assert.equal(result.changed, 2);
    assert.equal(result.missing, 2);
    assert.equal(result.catalogRevision, batch.catalogRevision + 1);
    for (const item of result.items) {
      assert.equal(item.organizationRevision, beforeOrganizations.get(item.assetId) + 1);
    }

    batch = database.listAssetAvailabilitySnapshots(PROJECT_ID);
    const repeated = database.syncAssetAvailabilityObservations(
      batch.snapshots.map((expected) => observation(expected, 'missing')),
      { expectedCatalogRevision: batch.catalogRevision, now: 21_000 },
    );
    assert.equal(repeated.changed, 0);
    assert.equal(repeated.missing, 0);
    assert.equal(repeated.catalogRevision, batch.catalogRevision);
  } finally {
    await database.close();
  }
});

test('B2 availability validates the complete group before its first write and enforces catalog CAS', async () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const first = createAsset(database, 'atomic-first');
    const second = createAsset(database, 'atomic-second');
    const batch = database.listAssetAvailabilitySnapshots(PROJECT_ID);
    const firstBefore = rawAssetState(database, first.id);
    const catalogBefore = batch.catalogRevision;
    database.db.prepare(`
      UPDATE assets SET metadata_json = ? WHERE id = ?
    `).run(JSON.stringify({ fixture: 'atomic-second', hostileDrift: true }), second.id);

    assert.throws(
      () => database.syncAssetAvailabilityObservations(
        batch.snapshots.map((expected) => observation(expected, 'missing')),
        { expectedCatalogRevision: batch.catalogRevision, now: 30_000 },
      ),
      (error) => error?.code === 'asset_availability_identity_conflict',
    );
    assert.deepEqual(rawAssetState(database, first.id), firstBefore);
    assert.equal(database.getAssetCatalogRevision(PROJECT_ID), catalogBefore);

    const currentFirst = database.getAssetAvailabilitySnapshot(first.id);
    const changedTags = database.setAssetTags(first.id, ['catalog-drift'], {
      expectedRevision: currentFirst.organizationRevision,
    });
    const restoredTags = database.setAssetTags(first.id, [], {
      expectedRevision: changedTags.organizationRevision,
    });
    assert.deepEqual(restoredTags.tags, []);
    assert.equal(database.getAssetCatalogRevision(PROJECT_ID), currentFirst.catalogRevision + 2);
    const afterCatalogDrift = rawAssetState(database, first.id);
    assert.throws(
      () => sync(database, currentFirst, 'missing', { now: 31_000 }),
      (error) => error?.code === 'asset_catalog_revision_conflict',
    );
    assert.deepEqual(rawAssetState(database, first.id), afterCatalogDrift);
  } finally {
    await database.close();
  }
});

test('B2 availability row digest rejects path/content/entity/revision/metadata drift and malformed metadata fails closed', async () => {
  const cases = [
    ['managed-path', "managed_path = managed_path || '.drift'"],
    ['content-hash', `content_hash = '${'f'.repeat(64)}'`],
    ['entity-uid', "entity_uid = '11111111-1111-5111-8111-111111111111'"],
    ['content-revision', 'content_revision = content_revision + 1'],
    ['organization-revision', 'organization_revision = organization_revision + 1'],
    ['metadata', "metadata_json = '{\"fixture\":\"raw-drift\"}'"],
  ];
  const database = new ProjectDatabase(':memory:');
  try {
    for (const [name, sql] of cases) {
      const asset = createAsset(database, `digest-${name}`);
      const expected = database.getAssetAvailabilitySnapshot(asset.id);
      const catalogBefore = expected.catalogRevision;
      database.db.prepare(`UPDATE assets SET ${sql} WHERE id = ?`).run(asset.id);
      const driftedBefore = rawAssetState(database, asset.id);
      assert.throws(
        () => sync(database, expected, 'missing', { now: 40_000 }),
        (error) => error?.code === 'asset_availability_identity_conflict',
        name,
      );
      assert.deepEqual(rawAssetState(database, asset.id), driftedBefore, name);
      assert.equal(database.getAssetCatalogRevision(PROJECT_ID), catalogBefore, name);
    }

    const malformed = createAsset(database, 'malformed-metadata');
    const expected = database.getAssetAvailabilitySnapshot(malformed.id);
    database.db.prepare("UPDATE assets SET metadata_json = '{broken' WHERE id = ?").run(malformed.id);
    const malformedBefore = rawAssetState(database, malformed.id);
    assert.throws(
      () => database.getAssetAvailabilitySnapshot(malformed.id),
      (error) => error?.code === 'asset_availability_metadata_invalid'
        && error?.status === 409,
    );
    assert.throws(
      () => sync(database, expected, 'missing', { now: 41_000 }),
      (error) => error?.code === 'asset_availability_metadata_invalid'
        && error?.status === 409,
    );
    assert.deepEqual(rawAssetState(database, malformed.id), malformedBefore);
    assert.equal(database.getAssetCatalogRevision(PROJECT_ID), expected.catalogRevision);
  } finally {
    await database.close();
  }
});

test('B2 availability late real SQLITE_FULL rolls the whole group back and accepts the exact same observation retry', async () => {
  const { database, directory } = createTempDatabase('t8-availability-full-b2-');
  let lateSecondWriteReached = false;
  try {
    const first = createAsset(database, 'full-first');
    const second = createAsset(database, 'full-second');
    const batch = database.listAssetAvailabilitySnapshots(PROJECT_ID);
    const observations = batch.snapshots.map((expected) => observation(expected, 'missing'));
    database.db.function('availability_b2_mark_second_write', () => {
      lateSecondWriteReached = true;
      return 1;
    });
    database.db.exec(`
      CREATE TABLE availability_b2_filler (
        id INTEGER PRIMARY KEY,
        payload BLOB NOT NULL
      );
      CREATE TRIGGER availability_b2_force_second_full
      BEFORE UPDATE OF availability, metadata_json, organization_revision ON assets
      WHEN NEW.id = '${second.id}'
      BEGIN
        SELECT availability_b2_mark_second_write();
        INSERT INTO availability_b2_filler(payload) VALUES (zeroblob(16777216));
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
    const before = {
      first: rawAssetState(database, first.id),
      second: rawAssetState(database, second.id),
      catalogRevision: database.getAssetCatalogRevision(PROJECT_ID),
    };

    assert.throws(
      () => database.syncAssetAvailabilityObservations(observations, {
        expectedCatalogRevision: batch.catalogRevision,
        now: 50_000,
      }),
      (error) => {
        assert.ok(error instanceof ProjectDatabaseStorageCapacityError);
        assert.equal(error.code, 'project_database_storage_capacity_exceeded');
        assert.equal(error.status, 507);
        assert.equal(error.reason, 'sqlite-full');
        assert.deepEqual(error.details, {
          reason: 'sqlite-full',
          retryable: false,
          operation: 'asset.availability.sync',
        });
        return true;
      },
    );
    assert.equal(lateSecondWriteReached, true);
    assert.deepEqual(rawAssetState(database, first.id), before.first);
    assert.deepEqual(rawAssetState(database, second.id), before.second);
    assert.equal(database.getAssetCatalogRevision(PROJECT_ID), before.catalogRevision);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM availability_b2_filler').get().count, 0);

    database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
    lateSecondWriteReached = false;
    const retried = database.syncAssetAvailabilityObservations(observations, {
      expectedCatalogRevision: batch.catalogRevision,
      now: 50_000,
    });
    assert.equal(lateSecondWriteReached, true);
    assert.equal(retried.changed, 2);
    assert.equal(retried.catalogRevision, batch.catalogRevision + 1);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM availability_b2_filler').get().count, 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    await closeTempDatabase(database, directory);
  }
});

test('B2 preview reschedule rolls availability, job, asset, fingerprints, and catalog back together on late real SQLITE_FULL', async () => {
  const { database, directory } = createTempDatabase('t8-availability-preview-full-b2-');
  let lateAssetWriteReached = false;
  try {
    const asset = createAsset(database, 'preview-full', {
      perceptualHash: '0123456789abcdef',
    });
    const queued = database.enqueueAssetPreviewJob({
      id: 'job-availability-preview-full',
      assetId: asset.id,
      contentHash: asset.contentHash,
      jobKind: 'image-preview',
      pipelineVersion: 'availability-preview-full-v1',
      maxAttempts: 1,
      createdAt: 100,
    });
    const claimed = database.claimNextAssetPreviewJob({ now: 100 });
    assert.equal(claimed.id, queued.id);
    assert.equal(database.listAssetFingerprints(asset.id).length, 1);
    const missingObservation = observation(claimed.availabilitySnapshot, 'missing');
    const input = previewMutationInput(claimed, {
      retryable: false,
      now: 60_000,
      availabilityObservation: missingObservation,
    });
    database.db.function('availability_preview_b2_mark_late_asset_write', () => {
      lateAssetWriteReached = true;
      return 1;
    });
    database.db.exec(`
      CREATE TABLE availability_preview_b2_filler (
        id INTEGER PRIMARY KEY,
        payload BLOB NOT NULL
      );
      CREATE TRIGGER availability_preview_b2_force_late_full
      BEFORE UPDATE OF metadata_json ON assets
      WHEN NEW.id = '${asset.id}'
        AND json_extract(NEW.metadata_json, '$.previewStatus') = 'failed'
      BEGIN
        SELECT availability_preview_b2_mark_late_asset_write();
        INSERT INTO availability_preview_b2_filler(payload) VALUES (zeroblob(16777216));
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
    const before = previewDurableState(database, queued.id, asset.id);

    assert.throws(
      () => database.rescheduleAssetPreviewJob(
        queued.id,
        { code: 'source-missing', message: 'preview source missing' },
        input,
      ),
      (error) => {
        assert.ok(error instanceof ProjectDatabaseStorageCapacityError);
        assert.equal(error.status, 507);
        assert.equal(error.reason, 'sqlite-full');
        assert.equal(error.details.operation, 'asset.preview.reschedule');
        return true;
      },
    );
    assert.equal(lateAssetWriteReached, true);
    assert.deepEqual(previewDurableState(database, queued.id, asset.id), before);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM availability_preview_b2_filler').get().count, 0);

    database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
    lateAssetWriteReached = false;
    const retried = database.rescheduleAssetPreviewJob(
      queued.id,
      { code: 'source-missing', message: 'preview source missing' },
      input,
    );
    assert.equal(lateAssetWriteReached, true);
    assert.equal(retried.applied, true);
    assert.equal(retried.status, 'failed');
    assert.equal(retried.availability.changed, 1);
    assert.equal(database.getAssetPreviewJob(queued.id).status, 'failed');
    const settledAsset = database.getAsset(asset.id);
    assert.equal(settledAsset.availability, 'missing');
    assert.equal(settledAsset.metadata.health, 'missing');
    assert.equal(settledAsset.metadata.previewStatus, 'failed');
    assert.equal(database.listAssetFingerprints(asset.id).length, 0);
    assert.equal(
      database.getAssetCatalogRevision(PROJECT_ID),
      claimed.availabilitySnapshot.catalogRevision + 1,
    );
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM availability_preview_b2_filler').get().count, 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    await closeTempDatabase(database, directory);
  }
});

test('B2 recovered attempt one cannot complete, reschedule, or write availability after attempt two is claimed', async () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const asset = createAsset(database, 'attempt-fence');
    const queued = database.enqueueAssetPreviewJob({
      id: 'job-availability-attempt-fence',
      assetId: asset.id,
      contentHash: asset.contentHash,
      jobKind: 'image-preview',
      pipelineVersion: 'availability-attempt-fence-v1',
      maxAttempts: 3,
      createdAt: 100,
    });
    const attemptOne = database.claimNextAssetPreviewJob({ now: 100 });
    assert.equal(attemptOne.id, queued.id);
    assert.equal(attemptOne.attemptCount, 1);
    assert.deepEqual(database.recoverAssetPreviewJobs({ now: 200 }), { recovered: 1, failed: 0 });
    const attemptTwo = database.claimNextAssetPreviewJob({ now: 200 });
    assert.equal(attemptTwo.id, queued.id);
    assert.equal(attemptTwo.attemptCount, 2);
    assert.equal(attemptTwo.startedAt > attemptOne.startedAt, true);

    const staleObservation = observation(attemptOne.availabilitySnapshot, 'missing');
    const beforeStaleWrites = previewDurableState(database, queued.id, asset.id);
    const staleCompletion = database.completeAssetPreviewJob(
      queued.id,
      { thumbnailUrl: '/files/thumbnails/stale-attempt.webp' },
      previewMutationInput(attemptOne, {
        now: 300,
        availabilityObservation: staleObservation,
      }),
    );
    assert.deepEqual(
      { applied: staleCompletion.applied, reason: staleCompletion.reason },
      { applied: false, reason: 'stale-attempt' },
    );
    const staleReschedule = database.rescheduleAssetPreviewJob(
      queued.id,
      { code: 'stale-attempt-failure', message: 'stale attempt failure' },
      previewMutationInput(attemptOne, {
        now: 301,
        retryable: false,
        availabilityObservation: staleObservation,
      }),
    );
    assert.deepEqual(
      { applied: staleReschedule.applied, reason: staleReschedule.reason },
      { applied: false, reason: 'stale-attempt' },
    );
    assert.deepEqual(previewDurableState(database, queued.id, asset.id), beforeStaleWrites);
    assert.equal(database.getAsset(asset.id).availability, 'available');
  } finally {
    await database.close();
  }
});

test('B2 manual retry preserves startedAt history so reset attemptCount cannot create an attempt ABA', async () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const asset = createAsset(database, 'manual-retry-fence');
    const queued = database.enqueueAssetPreviewJob({
      id: 'job-availability-manual-retry-fence',
      assetId: asset.id,
      contentHash: asset.contentHash,
      jobKind: 'image-preview',
      pipelineVersion: 'availability-attempt-fence-v1',
      maxAttempts: 1,
      createdAt: 100,
    });
    const firstAttempt = database.claimNextAssetPreviewJob({ now: 100 });
    const failed = database.rescheduleAssetPreviewJob(
      queued.id,
      { code: 'fixture-failed', message: 'fixture failed' },
      previewMutationInput(firstAttempt, { now: 110, retryable: false }),
    );
    assert.equal(failed.status, 'failed');
    const retried = database.retryAssetPreviewJobs(asset.id, asset.contentHash, { now: 120 });
    assert.equal(retried[0].attemptCount, 0);
    assert.equal(retried[0].startedAt, firstAttempt.startedAt);
    const secondAttempt = database.claimNextAssetPreviewJob({ now: 100 });
    assert.equal(secondAttempt.attemptCount, 1);
    assert.equal(secondAttempt.startedAt, firstAttempt.startedAt + 1);

    const before = previewDurableState(database, queued.id, asset.id);
    const stale = database.completeAssetPreviewJob(
      queued.id,
      { thumbnailUrl: '/files/thumbnails/attempt-aba.webp' },
      previewMutationInput(firstAttempt, { now: 130 }),
    );
    assert.equal(stale.applied, false);
    assert.equal(stale.reason, 'stale-attempt');
    assert.deepEqual(previewDurableState(database, queued.id, asset.id), before);
  } finally {
    await database.close();
  }
});
