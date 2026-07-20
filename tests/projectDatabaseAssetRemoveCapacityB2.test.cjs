'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');
const { AssetBlobStore } = require('../backend/src/services/assetBlobStore');
const { AssetUploadManager } = require('../backend/src/services/assetUploadManager');

const PROJECT_ID = 'project-asset-remove-capacity-b2';
const MAX_PAGE_COUNT_RESET = 1073741823;

function hashFor(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function createTempDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-remove-capacity-b2-'));
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
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
}

function createAsset(database, suffix, input = {}) {
  const contentHash = input.contentHash || hashFor(suffix);
  const asset = database.upsertAsset({
    id: `asset-remove-capacity-${suffix}`,
    projectId: PROJECT_ID,
    contentHash,
    contentHashVerification: 'verified',
    kind: 'image',
    mimeType: 'image/png',
    filename: `${suffix}.png`,
    sourceUrl: `/files/input/${suffix}.png`,
    storageMode: 'managed',
    availability: 'available',
    createdBy: 'asset-remove-capacity-owner',
    createdAt: 100,
    updatedAt: 100,
    metadata: { size: 64, fixture: suffix },
    perceptualHash: '0123456789abcdef',
    perceptualHashAlgorithm: 'dhash-64',
  });
  database.markAssetBlobStored({
    contentHash,
    storageKey: `sha256/${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}`,
    byteSize: 64,
    mimeType: 'image/png',
    verifiedAt: 100,
  });
  return database.getAsset(asset.id);
}

function scalarCount(database, sql, ...values) {
  return Number(database.db.prepare(sql).get(...values)?.count || 0);
}

function assetRemovalState(database, assetId, contentHash) {
  const one = (sql, ...values) => database.db.prepare(sql).get(...values) || null;
  return {
    asset: one('SELECT * FROM assets WHERE id = ?', assetId),
    accessPolicy: one('SELECT * FROM asset_access_policies WHERE asset_id = ?', assetId),
    blobRef: one('SELECT * FROM asset_blob_refs WHERE asset_id = ?', assetId),
    blob: one('SELECT * FROM asset_blobs WHERE content_hash = ?', contentHash),
    collectionMember: one('SELECT * FROM asset_collection_members WHERE asset_id = ?', assetId),
    fingerprint: one('SELECT * FROM asset_fingerprints WHERE asset_id = ?', assetId),
    previewJob: one('SELECT * FROM asset_preview_jobs WHERE asset_id = ?', assetId),
    tag: one('SELECT * FROM asset_tags WHERE asset_id = ?', assetId),
    tombstone: one('SELECT * FROM asset_lineage_tombstones WHERE id = ?', assetId),
    catalog: one('SELECT * FROM asset_catalog_revisions WHERE project_id = ?', PROJECT_ID),
    fillerCount: scalarCount(database, 'SELECT COUNT(*) AS count FROM asset_remove_capacity_b2_filler'),
  };
}

function seedCascadeRows(database, asset) {
  database.db.prepare(`
    INSERT INTO asset_collections(id, project_id, name, description, created_by, created_at, updated_at)
    VALUES ('collection-asset-remove-capacity', ?, 'capacity fixture', '', 'owner', 100, 100)
  `).run(PROJECT_ID);
  database.db.prepare(`
    INSERT INTO asset_collection_members(collection_id, asset_id, added_at)
    VALUES ('collection-asset-remove-capacity', ?, 100)
  `).run(asset.id);
  database.db.prepare('INSERT INTO asset_tags(asset_id, tag, created_at) VALUES (?, ?, 100)')
    .run(asset.id, 'capacity-fixture');
  database.db.prepare(`
    INSERT INTO asset_preview_jobs(
      id, project_id, asset_id, content_hash, job_kind, pipeline_version, status,
      attempt_count, max_attempts, next_attempt_at, error_code, error_message,
      result_json, created_at, started_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, 'image-preview', 'asset-remove-capacity-v1', 'queued',
      0, 3, NULL, NULL, NULL, '{}', 100, NULL, 100, NULL)
  `).run(`preview-${asset.id}`, PROJECT_ID, asset.id, asset.contentHash);
  database.db.prepare(`
    INSERT INTO asset_lineage_tombstones(
      id, project_id, entity_uid, filename, kind, mime_type, content_hash, deleted_at
    ) VALUES (?, ?, NULL, 'old-private-name.png', 'other', NULL, NULL, 7)
  `).run(asset.id, PROJECT_ID);
}

function armLateRealFull(database) {
  let hits = 0;
  database.db.function('asset_remove_capacity_b2_mark_late', () => {
    hits += 1;
    return 1;
  });
  database.db.exec(`
    CREATE TABLE asset_remove_capacity_b2_filler (
      id INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
    CREATE TRIGGER asset_remove_capacity_b2_force_late_full
    AFTER UPDATE OF revision ON asset_catalog_revisions
    WHEN OLD.project_id = '${PROJECT_ID}'
    BEGIN
      SELECT asset_remove_capacity_b2_mark_late();
      INSERT INTO asset_remove_capacity_b2_filler(payload) VALUES (zeroblob(8388608));
    END;
  `);
  database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
  database.db.pragma('wal_checkpoint(TRUNCATE)');
  database.db.exec('VACUUM');
  database.db.pragma('wal_checkpoint(TRUNCATE)');
  const pageCount = Number(database.db.pragma('page_count', { simple: true }));
  const constrained = pageCount + 64;
  assert.equal(Number(database.db.pragma(`max_page_count = ${constrained}`, { simple: true })), constrained);
  return {
    hits: () => hits,
    release() {
      if (!database.db.open) return;
      database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
      database.db.exec('DROP TRIGGER IF EXISTS asset_remove_capacity_b2_force_late_full');
    },
  };
}

function assertStorageCapacity(error, operation) {
  assert.ok(error instanceof ProjectDatabaseStorageCapacityError);
  assert.equal(error.code, 'project_database_storage_capacity_exceeded');
  assert.equal(error.status, 507);
  assert.equal(error.reason, 'sqlite-full');
  assert.equal(error.retryable, false);
  assert.deepEqual(error.details, {
    reason: 'sqlite-full',
    retryable: false,
    operation,
  });
  return true;
}

test('B2 asset remove and blob-finalize writers enter exact coordinators and preserve non-capacity identities', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const operations = [];
    const originalBoundary = database.withProjectDatabaseWrite.bind(database);
    database.withProjectDatabaseWrite = (operation, callback) => {
      operations.push(operation);
      return originalBoundary(operation, () => {
        assert.equal(database.db.inTransaction, true);
        return callback();
      });
    };

    const preserved = createAsset(database, 'index-only-operation-contract');
    const preservedRemoval = database.removeAssetIndex(preserved.id);
    assert.equal(preservedRemoval.id, preserved.id);
    assert.equal(database.getAssetBlob(preserved.contentHash).storageState, 'ready');

    const logicalHash = hashFor('logical-index-only-operation-contract');
    const logical = database.upsertAsset({
      id: 'asset-remove-capacity-logical-index-only',
      projectId: PROJECT_ID,
      contentHash: logicalHash,
      contentHashVerification: 'verified',
      kind: 'image',
      filename: 'logical-index-only.png',
      storageMode: 'linked',
      availability: 'available',
    });
    assert.equal(database.getAssetBlob(logicalHash).storageState, 'logical');
    assert.equal(database.removeAssetIndex(logical.id).id, logical.id);
    assert.equal(database.getAssetBlob(logicalHash), null, 'index-only removal must not leak DB-only logical blobs');

    const asset = createAsset(database, 'file-delete-operation-contract');
    const removed = database.removeAssetIndex(asset.id, { scheduleBlobDelete: true });
    assert.equal(removed.id, asset.id);
    assert.equal(database.getAssetBlob(asset.contentHash).storageState, 'pending-delete');
    assert.equal(originalBoundary('asset.blob.orphan-cleanup.test', () => (
      database._cleanupOrphanAssetBlob(`blob_${asset.contentHash}`, { scheduleDelete: false })
    )), false);
    assert.equal(database.getAssetBlob(asset.contentHash).storageState, 'pending-delete');
    assert.equal(database.markAssetBlobDeleted(asset.contentHash), true);
    assert.deepEqual(operations, [
      'asset.upsert',
      'asset.blob.store',
      'asset.index.remove',
      'asset.upsert',
      'asset.index.remove',
      'asset.upsert',
      'asset.blob.store',
      'asset.index.remove',
      'asset.blob.delete-mark',
    ]);

    const identityAsset = createAsset(database, 'identity-contract');
    const originalGetAsset = database.getAsset.bind(database);
    for (const code of ['SQLITE_BUSY', 'asset_remove_business_conflict']) {
      const sentinel = Object.assign(new Error(`private-${code}`), { code });
      database.getAsset = (assetId) => {
        if (assetId === identityAsset.id) throw sentinel;
        return originalGetAsset(assetId);
      };
      assert.throws(() => database.removeAssetIndex(identityAsset.id), (error) => error === sentinel);
    }
    database.getAsset = originalGetAsset;
    assert.ok(database.getAsset(identityAsset.id));

    const staleAsset = createAsset(database, 'stale-delete-identity');
    database.db.prepare(`
      UPDATE assets
      SET filename = 'stale-delete-identity-new.png', managed_path = 'E:/private/new.png',
          content_revision = content_revision + 1, updated_at = updated_at + 1
      WHERE id = ?
    `).run(staleAsset.id);
    assert.throws(
      () => database.removeAssetIndex(staleAsset.id, {
        expectedIdentity: {
          entityUid: staleAsset.entityUid,
          contentRevision: staleAsset.contentRevision,
          contentHash: staleAsset.contentHash,
          filename: staleAsset.filename,
          managedPath: staleAsset.managedPath,
          storageMode: staleAsset.storageMode,
        },
      }),
      (error) => error?.code === 'asset_delete_identity_conflict'
        && error?.current?.id === staleAsset.id,
    );
    assert.equal(database.getAsset(staleAsset.id).filename, 'stale-delete-identity-new.png');
    assert.equal(database.getAssetBlob(staleAsset.contentHash).storageState, 'ready');
  } finally {
    database.close();
  }
});

test('B2 index-only retention survives same-hash legacy deletion, database reopen, and startup GC', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-index-retention-b2-'));
  const dataRoot = path.join(directory, 'data');
  const blobRoot = path.join(dataRoot, 'asset-blobs');
  const databaseFile = path.join(dataRoot, 'projects.sqlite3');
  const uploadTemp = path.join(dataRoot, 'collaboration-uploads');
  const source = path.join(directory, 'only-managed-source.bin');
  const bytes = Buffer.from('the CAS copy becomes the only managed source before index removal');
  const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const blobStore = new AssetBlobStore(blobRoot);
  let database = null;
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(source, bytes);
    const installed = await blobStore.installVerifiedFile(source, {
      expectedHash: contentHash,
      expectedSize: bytes.length,
      removeSource: true,
    });
    assert.equal(fs.existsSync(source), false, 'the fixture must leave CAS as the unique managed copy');

    database = new ProjectDatabase(databaseFile, { autoBackup: false });
    const asset = database.upsertAsset({
      id: 'asset-index-retention-b2',
      projectId: PROJECT_ID,
      contentHash,
      contentHashVerification: 'verified',
      kind: 'other',
      mimeType: 'application/octet-stream',
      filename: 'only-managed-source.bin',
      managedPath: installed.path,
      sourceUrl: '/api/project-assets/asset-index-retention-b2/media',
      storageMode: 'managed',
      availability: 'available',
      createdBy: 'asset-index-retention-owner',
      metadata: { size: bytes.length, root: 'cas' },
    });
    database.markAssetBlobStored({
      contentHash,
      storageKey: installed.storageKey,
      byteSize: installed.byteSize,
      mimeType: 'application/octet-stream',
    });
    assert.equal(database.assetBlobReferenceCount(contentHash), 1);

    assert.equal(database.removeAssetIndex(asset.id).id, asset.id);
    assert.equal(database.assetBlobReferenceCount(contentHash), 0);
    assert.equal(database.getAssetBlob(contentHash).storageState, 'ready');
    assert.deepEqual(database.listPendingAssetBlobDeletes(), []);
    assert.equal(fs.existsSync(installed.path), true);

    const legacyRoot = path.join(directory, 'input');
    const legacyPath = path.join(legacyRoot, 'same-hash-legacy.bin');
    fs.mkdirSync(legacyRoot, { recursive: true });
    fs.writeFileSync(legacyPath, bytes);
    const legacyAsset = database.upsertAsset({
      id: 'asset-index-retention-same-hash-legacy-b2',
      projectId: PROJECT_ID,
      contentHash,
      contentHashVerification: 'verified',
      kind: 'other',
      mimeType: 'application/octet-stream',
      filename: 'same-hash-legacy.bin',
      managedPath: legacyPath,
      sourceUrl: '/files/input/same-hash-legacy.bin',
      storageMode: 'managed',
      availability: 'available',
      createdBy: 'asset-index-retention-owner',
      metadata: { size: bytes.length, root: 'input' },
    });
    assert.equal(database.assetBlobReferenceCount(contentHash), 1);
    assert.equal(database.removeAssetIndex(legacyAsset.id, { scheduleBlobDelete: false }).id, legacyAsset.id);
    fs.unlinkSync(legacyPath);
    assert.equal(database.assetBlobReferenceCount(contentHash), 0);
    assert.equal(database.getAssetBlob(contentHash).storageState, 'ready');
    assert.deepEqual(database.listPendingAssetBlobDeletes(), []);
    assert.equal(fs.existsSync(installed.path), true, 'legacy deletion must not revoke the retained CAS source');

    await database.close();
    database = new ProjectDatabase(databaseFile, { autoBackup: false });
    const uploadManager = new AssetUploadManager({
      DATA_DIR: dataRoot,
      ASSET_BLOB_DIR: blobRoot,
      COLLAB_UPLOAD_TEMP_DIR: uploadTemp,
    }, database, { blobStore });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await uploadManager.gcPendingBlobs(), { inspected: 0, removed: 0 });
    assert.equal(database.getAssetBlob(contentHash).storageState, 'ready');
    assert.equal(fs.existsSync(installed.path), true, 'startup GC must preserve an index-only source file');
  } finally {
    try { await database?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

test('B2 pending CAS deletion fences DB-only references until a new verified-storage commit', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const original = createAsset(database, 'pending-delete-fence');
    assert.equal(database.removeAssetIndex(original.id, { scheduleBlobDelete: true }).id, original.id);
    assert.equal(database.getAssetBlob(original.contentHash).storageState, 'pending-delete');

    const conflictingInput = {
      id: 'asset-remove-capacity-pending-delete-race',
      projectId: PROJECT_ID,
      contentHash: original.contentHash,
      contentHashVerification: 'verified',
      kind: 'image',
      mimeType: 'image/png',
      filename: 'pending-delete-race.png',
      sourceUrl: '/files/input/pending-delete-race.png',
      storageMode: 'managed',
      availability: 'available',
      createdBy: 'asset-remove-capacity-owner',
      metadata: { size: 64 },
    };
    assert.throws(
      () => database.upsertAsset(conflictingInput),
      (error) => error?.code === 'asset_blob_delete_in_progress' && error?.status === 409,
    );
    assert.equal(database.getAsset(conflictingInput.id), null, 'the rejected upsert must roll back its asset row');
    assert.equal(database.assetBlobReferenceCount(original.contentHash), 0);
    assert.throws(
      () => database.markAssetBlobStored({
        contentHash: original.contentHash,
        storageKey: `sha256/${original.contentHash.slice(0, 2)}/${original.contentHash.slice(2, 4)}/${original.contentHash}`,
        byteSize: 64,
        mimeType: 'image/png',
      }),
      (error) => error?.code === 'asset_blob_delete_in_progress' && error?.status === 409,
    );

    assert.equal(database.markAssetBlobDeleted(original.contentHash), true);
    // A legitimate retry must restart at the physical verify/install boundary;
    // markAssetBlobStored represents that new storage commit and precedes the
    // asset/reference transaction.  Replaying only the old upsert parameters is
    // not a supported CAS recovery contract.
    database.markAssetBlobStored({
      contentHash: original.contentHash,
      storageKey: `sha256/${original.contentHash.slice(0, 2)}/${original.contentHash.slice(2, 4)}/${original.contentHash}`,
      byteSize: 64,
      mimeType: 'image/png',
    });
    const retried = database.upsertAsset(conflictingInput);
    assert.equal(retried.id, conflictingInput.id);
    assert.equal(database.assetBlobReferenceCount(original.contentHash), 1);
  } finally {
    database.close();
  }
});

test('B2 CAS file deletion requires a verified ready blob/ref before the index can commit', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const contentHash = hashFor('logical-row-cannot-authorize-cas-unlink');
    const logical = database.upsertAsset({
      id: 'asset-remove-capacity-logical-cas',
      projectId: PROJECT_ID,
      contentHash,
      contentHashVerification: 'verified',
      kind: 'image',
      mimeType: 'image/png',
      filename: 'logical-cas.png',
      managedPath: `E:/private/asset-blobs/sha256/${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}`,
      sourceUrl: '/api/project-assets/asset-remove-capacity-logical-cas/media',
      storageMode: 'managed',
      availability: 'available',
      metadata: { size: 64, root: 'cas' },
    });
    assert.equal(database.getAssetBlob(contentHash).storageState, 'logical');
    assert.throws(
      () => database.removeAssetIndex(logical.id, {
        requireVerifiedCasBlob: true,
        scheduleBlobDelete: true,
      }),
      (error) => error?.code === 'asset_delete_blob_identity_conflict',
    );
    assert.ok(database.getAsset(logical.id));
    assert.equal(database.assetBlobReferenceCount(contentHash), 1);

    database.markAssetBlobStored({
      contentHash,
      storageKey: `sha256/${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}`,
      byteSize: 64,
      mimeType: 'image/png',
    });
    assert.equal(database.removeAssetIndex(logical.id, {
      requireVerifiedCasBlob: true,
      scheduleBlobDelete: true,
    }).id, logical.id);
    assert.equal(database.getAssetBlob(contentHash).storageState, 'pending-delete');
  } finally {
    database.close();
  }
});

test('B2 real late SQLITE_FULL rolls back tombstone, cascades, pending-delete, catalog revision, and filler before exact retry', async () => {
  const { database, directory } = createTempDatabase();
  let fault;
  try {
    const asset = createAsset(database, 'real-late-full');
    seedCascadeRows(database, asset);
    fault = armLateRealFull(database);
    const before = assetRemovalState(database, asset.id, asset.contentHash);

    assert.throws(
      () => database.removeAssetIndex(asset.id, { scheduleBlobDelete: true }),
      (error) => assertStorageCapacity(error, 'asset.index.remove'),
    );
    assert.ok(fault.hits() >= 1, 'fault must run after tombstone/delete/pending-delete work reaches the catalog bump');
    assert.deepEqual(assetRemovalState(database, asset.id, asset.contentHash), before);
    assert.equal(database.db.inTransaction, false);

    fault.release();
    const removed = database.removeAssetIndex(asset.id, { scheduleBlobDelete: true });
    assert.equal(removed.id, asset.id);
    assert.equal(database.getAsset(asset.id), null);
    assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM asset_access_policies WHERE asset_id = ?', asset.id), 0);
    assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM asset_blob_refs WHERE asset_id = ?', asset.id), 0);
    assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM asset_collection_members WHERE asset_id = ?', asset.id), 0);
    assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM asset_fingerprints WHERE asset_id = ?', asset.id), 0);
    assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM asset_preview_jobs WHERE asset_id = ?', asset.id), 0);
    assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM asset_tags WHERE asset_id = ?', asset.id), 0);
    const tombstone = database.db.prepare('SELECT * FROM asset_lineage_tombstones WHERE id = ?').get(asset.id);
    assert.equal(tombstone.filename, asset.filename);
    assert.equal(tombstone.content_hash, asset.contentHash);
    assert.notEqual(tombstone.deleted_at, 7);
    const blob = database.getAssetBlob(asset.contentHash);
    assert.equal(blob.storageState, 'pending-delete');
    assert.ok(blob.pendingDeleteAt > 0);
    assert.equal(database.getAssetCatalogRevision(PROJECT_ID), Number(before.catalog.revision) + 1);
    assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM asset_remove_capacity_b2_filler'), 0);

    const afterRetry = assetRemovalState(database, asset.id, asset.contentHash);
    assert.equal(database.removeAssetIndex(asset.id, { scheduleBlobDelete: true }), null, 'replaying the exact delete after commit is a stable no-op');
    assert.deepEqual(assetRemovalState(database, asset.id, asset.contentHash), afterRetry);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    fault?.release();
    await closeTempDatabase(database, directory);
  }
});

test('B2 real SQLITE_BUSY remains SQLITE_BUSY and leaves the delete transaction untouched', async () => {
  const { database, directory, filename } = createTempDatabase();
  let blocker;
  try {
    const asset = createAsset(database, 'real-busy');
    database.db.exec('CREATE TABLE asset_remove_capacity_b2_filler(id INTEGER PRIMARY KEY, payload BLOB NOT NULL)');
    const before = assetRemovalState(database, asset.id, asset.contentHash);
    database.db.pragma('busy_timeout = 0');
    blocker = new BetterSqlite3(filename);
    blocker.pragma('busy_timeout = 0');
    blocker.exec('BEGIN IMMEDIATE');

    assert.throws(
      () => database.removeAssetIndex(asset.id, { scheduleBlobDelete: true }),
      (error) => {
        assert.equal(error instanceof ProjectDatabaseStorageCapacityError, false);
        assert.match(String(error.code), /^SQLITE_BUSY/);
        return true;
      },
    );
    assert.deepEqual(assetRemovalState(database, asset.id, asset.contentHash), before);
    blocker.exec('ROLLBACK');
    blocker.close();
    blocker = null;
    assert.equal(database.removeAssetIndex(asset.id, { scheduleBlobDelete: true }).id, asset.id);
  } finally {
    try { blocker?.exec('ROLLBACK'); } catch (_) {}
    try { blocker?.close(); } catch (_) {}
    await closeTempDatabase(database, directory);
  }
});

test('B2 real ON DELETE RESTRICT failure preserves the original business error and every asset row', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const asset = createAsset(database, 'real-foreign-key');
    database.db.exec(`
      CREATE TABLE asset_remove_capacity_b2_restrict (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT
      );
    `);
    database.db.prepare('INSERT INTO asset_remove_capacity_b2_restrict(id, asset_id) VALUES (?, ?)')
      .run('restrict-owner', asset.id);
    database.db.exec('CREATE TABLE asset_remove_capacity_b2_filler(id INTEGER PRIMARY KEY, payload BLOB NOT NULL)');
    const before = assetRemovalState(database, asset.id, asset.contentHash);

    assert.throws(
      () => database.removeAssetIndex(asset.id, { scheduleBlobDelete: true }),
      (error) => {
        assert.equal(error instanceof ProjectDatabaseStorageCapacityError, false);
        // SQLite implements ON DELETE RESTRICT as an immediate trigger and
        // therefore reports the precise extended identity below.
        assert.equal(error.code, 'SQLITE_CONSTRAINT_TRIGGER');
        assert.match(String(error.message), /FOREIGN KEY constraint failed/i);
        return true;
      },
    );
    assert.deepEqual(assetRemovalState(database, asset.id, asset.contentHash), before);
    database.db.prepare('DELETE FROM asset_remove_capacity_b2_restrict WHERE asset_id = ?').run(asset.id);
    assert.equal(database.removeAssetIndex(asset.id, { scheduleBlobDelete: true }).id, asset.id);
    assert.equal(database.getAssetBlob(asset.contentHash).storageState, 'pending-delete');
  } finally {
    database.close();
  }
});
