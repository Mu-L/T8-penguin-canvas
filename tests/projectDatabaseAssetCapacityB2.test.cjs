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

const PROJECT_ID = 'project-asset-capacity-b2';

function assertStorageCapacity(error, reason, operation) {
  assert.ok(error instanceof ProjectDatabaseStorageCapacityError);
  assert.equal(error.code, 'project_database_storage_capacity_exceeded');
  assert.equal(error.status, 507);
  assert.equal(error.statusCode, 507);
  assert.equal(error.reason, reason);
  assert.deepEqual(error.details, {
    reason,
    retryable: false,
    operation,
  });
  return true;
}

function installControlledCapacityFailure(database, functionName, code, state) {
  database.db.function(functionName, () => {
    if (!state.enabled) return 1;
    const error = new Error(`controlled ${code} capacity failure`);
    error.code = code;
    throw error;
  });
}

function count(database, sql, ...values) {
  return Number(database.db.prepare(sql).get(...values)?.count || 0);
}

test('B2 upsertAsset translates controlled ENOSPC only after rollback and preserves ordinary asset conflicts', async () => {
  const database = new ProjectDatabase(':memory:');
  const state = { enabled: true };
  const assetId = 'asset-upsert-capacity-b2';
  try {
    installControlledCapacityFailure(database, 'asset_capacity_b2_enospc', 'ENOSPC', state);
    database.db.exec(`
      CREATE TRIGGER asset_capacity_b2_upsert_enospc
      BEFORE INSERT ON asset_access_policies
      WHEN NEW.asset_id = '${assetId}'
      BEGIN
        SELECT asset_capacity_b2_enospc();
      END;
    `);

    assert.throws(() => database.upsertAsset({
      id: assetId,
      projectId: PROJECT_ID,
      kind: 'image',
      mimeType: 'image/png',
      filename: 'capacity.png',
      contentHash: 'a'.repeat(64),
      contentHashVerification: 'verified',
      metadata: { size: 4 },
    }), (error) => assertStorageCapacity(error, 'filesystem-reserve', 'asset.upsert'));

    assert.equal(database.getAsset(assetId), null);
    assert.equal(count(database, 'SELECT COUNT(*) AS count FROM asset_blobs WHERE content_hash = ?', 'a'.repeat(64)), 0);
    assert.equal(count(database, 'SELECT COUNT(*) AS count FROM asset_blob_refs WHERE asset_id = ?', assetId), 0);
    assert.equal(count(database, 'SELECT COUNT(*) AS count FROM asset_access_policies WHERE asset_id = ?', assetId), 0);
    assert.equal(count(database, 'SELECT COUNT(*) AS count FROM asset_catalog_revisions WHERE project_id = ?', PROJECT_ID), 0);

    state.enabled = false;
    const created = database.upsertAsset({
      id: assetId,
      projectId: PROJECT_ID,
      kind: 'image',
      mimeType: 'image/png',
      filename: 'capacity.png',
      contentHash: 'a'.repeat(64),
      contentHashVerification: 'verified',
      metadata: { size: 4 },
    });
    assert.equal(created.id, assetId);

    assert.throws(() => database.upsertAsset({
      id: assetId,
      projectId: 'different-project',
      kind: 'image',
      filename: 'conflict.png',
    }), (error) => {
      assert.equal(error instanceof ProjectDatabaseStorageCapacityError, false);
      assert.match(error.message, /其他项目/);
      return true;
    });
  } finally {
    await database.close();
  }
});

test('B2 applyAssetBatch translates controlled EDQUOT after its late idempotency write rolls the whole batch back', async () => {
  const database = new ProjectDatabase(':memory:');
  const state = { enabled: true };
  const idempotencyKey = 'asset-capacity-batch-001';
  try {
    const first = database.upsertAsset({
      id: 'asset-capacity-batch-a',
      projectId: PROJECT_ID,
      kind: 'image',
      filename: 'a.png',
    });
    const second = database.upsertAsset({
      id: 'asset-capacity-batch-b',
      projectId: PROJECT_ID,
      kind: 'image',
      filename: 'b.png',
    });
    const beforeCatalogRevision = database.getAssetCatalogRevision(PROJECT_ID);
    const beforeRevisions = {
      [first.id]: first.organizationRevision,
      [second.id]: second.organizationRevision,
    };
    const request = {
      idempotencyKey,
      selection: { assetIds: [first.id, second.id] },
      expectedRevisions: beforeRevisions,
      operation: { type: 'tags.add', tags: ['capacity-checked'] },
    };

    installControlledCapacityFailure(database, 'asset_capacity_b2_edquot', 'EDQUOT', state);
    database.db.exec(`
      CREATE TRIGGER asset_capacity_b2_batch_edquot
      BEFORE INSERT ON asset_batch_requests
      WHEN NEW.idempotency_key = '${idempotencyKey}'
      BEGIN
        SELECT asset_capacity_b2_edquot();
      END;
    `);

    assert.throws(
      () => database.applyAssetBatch(PROJECT_ID, request, { actorId: 'asset-capacity-writer' }),
      (error) => assertStorageCapacity(error, 'filesystem-reserve', 'asset.batch'),
    );
    assert.equal(count(database, 'SELECT COUNT(*) AS count FROM asset_tags WHERE tag = ?', 'capacity-checked'), 0);
    assert.equal(count(database, 'SELECT COUNT(*) AS count FROM asset_batch_requests WHERE idempotency_key = ?', idempotencyKey), 0);
    assert.equal(database.getAsset(first.id).organizationRevision, beforeRevisions[first.id]);
    assert.equal(database.getAsset(second.id).organizationRevision, beforeRevisions[second.id]);
    assert.equal(database.getAssetCatalogRevision(PROJECT_ID), beforeCatalogRevision);

    state.enabled = false;
    const applied = database.applyAssetBatch(PROJECT_ID, request, { actorId: 'asset-capacity-writer' });
    assert.equal(applied.idempotent, false);
    assert.equal(applied.affectedCount, 2);
    assert.equal(count(database, 'SELECT COUNT(*) AS count FROM asset_tags WHERE tag = ?', 'capacity-checked'), 2);
    const replay = database.applyAssetBatch(PROJECT_ID, request, { actorId: 'asset-capacity-writer' });
    assert.equal(replay.idempotent, true);

    assert.throws(() => database.applyAssetBatch(PROJECT_ID, {
      ...request,
      operation: { type: 'tags.add', tags: ['different-request'] },
    }, { actorId: 'asset-capacity-writer' }), (error) => {
      assert.equal(error instanceof ProjectDatabaseStorageCapacityError, false);
      assert.equal(error.code, 'asset_batch_idempotency_conflict');
      return true;
    });
  } finally {
    await database.close();
  }
});

function uploadCommitState(database, sessionId, assetId, contentHash) {
  return {
    session: database.db.prepare(`
      SELECT status, revision, asset_id, content_hash, deduplicated, completed_at
      FROM asset_upload_sessions WHERE id = ?
    `).get(sessionId),
    asset: database.db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) || null,
    blob: database.db.prepare('SELECT * FROM asset_blobs WHERE content_hash = ?').get(contentHash) || null,
    blobRef: database.db.prepare('SELECT * FROM asset_blob_refs WHERE asset_id = ?').get(assetId) || null,
    accessPolicy: database.db.prepare('SELECT * FROM asset_access_policies WHERE asset_id = ?').get(assetId) || null,
    lineage: database.db.prepare('SELECT * FROM asset_lineage_events WHERE asset_id = ? ORDER BY id').all(assetId),
    catalog: database.db.prepare('SELECT * FROM asset_catalog_revisions WHERE project_id = ?').get(PROJECT_ID) || null,
    fillerCount: count(database, 'SELECT COUNT(*) AS count FROM asset_capacity_b2_filler'),
  };
}

test('B2 commitAssetUpload translates a real late SQLITE_FULL, leaves zero partial commit, and retries exactly after cap relief', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-project-asset-capacity-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const sessionId = 'asset-upload-capacity-b2-session';
  const assetId = 'asset-upload-capacity-b2-result';
  const contentHash = 'c'.repeat(64);
  let database = null;
  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    database.createAssetUploadSession({
      id: sessionId,
      projectId: PROJECT_ID,
      memberId: 'asset-capacity-member',
      sourceKind: 'collaboration',
      idempotencyKey: 'asset-capacity-upload-001',
      filename: 'capacity-upload.png',
      mimeType: 'image/png',
      expectedSize: 4,
      expectedHash: contentHash,
      chunkSize: 4,
    }, {
      projectLimit: 1024 * 1024,
      memberLimit: 1024 * 1024,
    });
    database.recordAssetUploadChunk(sessionId, {
      index: 0,
      start: 0,
      end: 3,
      size: 4,
      contentHash: 'd'.repeat(64),
    });
    const assembling = database.claimAssetUploadCompletion(sessionId);
    assert.equal(assembling.status, 'assembling');

    let lateWriteReached = false;
    database.db.function('asset_capacity_b2_mark_late_write', () => {
      lateWriteReached = true;
      return 1;
    });
    database.db.exec(`
      CREATE TABLE asset_capacity_b2_filler (
        id INTEGER PRIMARY KEY,
        payload BLOB NOT NULL
      );
      CREATE TRIGGER asset_capacity_b2_force_late_full
      BEFORE UPDATE OF status ON asset_upload_sessions
      WHEN OLD.id = '${sessionId}' AND OLD.status = 'assembling' AND NEW.status = 'completed'
      BEGIN
        SELECT asset_capacity_b2_mark_late_write();
        INSERT INTO asset_capacity_b2_filler(payload) VALUES (zeroblob(16777216));
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

    const request = {
      sessionId,
      blob: {
        contentHash,
        byteSize: 4,
        mimeType: 'image/png',
        storageKey: 'capacity/b2-upload.png',
      },
      asset: {
        id: assetId,
        projectId: PROJECT_ID,
        kind: 'image',
        mimeType: 'image/png',
        filename: 'capacity-upload.png',
        createdBy: 'asset-capacity-member',
        metadata: { size: 4 },
        provenance: { source: 'capacity-b2-test' },
      },
      lineage: {
        sourceType: 'collaboration-upload',
        creatorId: 'asset-capacity-member',
        metadata: { fixture: 'capacity-b2' },
      },
      deduplicated: false,
    };
    const before = uploadCommitState(database, sessionId, assetId, contentHash);

    assert.throws(
      () => database.commitAssetUpload(request),
      (error) => assertStorageCapacity(error, 'sqlite-full', 'asset.upload.commit'),
    );
    assert.equal(lateWriteReached, true, 'FULL must occur at the final upload-session completion write');
    assert.deepEqual(uploadCommitState(database, sessionId, assetId, contentHash), before);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    database.db.pragma('max_page_count = 1073741823');
    lateWriteReached = false;
    const committed = database.commitAssetUpload(request);
    assert.equal(lateWriteReached, true);
    assert.equal(committed.asset.id, assetId);
    assert.equal(committed.session.status, 'completed');
    assert.equal(committed.session.revision, assembling.revision + 1);
    assert.equal(count(database, 'SELECT COUNT(*) AS count FROM asset_capacity_b2_filler'), 1);
    assert.equal(count(database, 'SELECT COUNT(*) AS count FROM assets WHERE id = ?', assetId), 1);
    assert.equal(count(database, 'SELECT COUNT(*) AS count FROM asset_blobs WHERE content_hash = ?', contentHash), 1);
    assert.equal(count(database, 'SELECT COUNT(*) AS count FROM asset_blob_refs WHERE asset_id = ?', assetId), 1);
    assert.equal(count(database, 'SELECT COUNT(*) AS count FROM asset_lineage_events WHERE asset_id = ?', assetId), 1);

    lateWriteReached = false;
    const replay = database.commitAssetUpload(request);
    assert.equal(replay.session.status, 'completed');
    assert.equal(replay.session.revision, committed.session.revision);
    assert.equal(lateWriteReached, false, 'completed replay must not execute the final write again');
    assert.equal(count(database, 'SELECT COUNT(*) AS count FROM asset_capacity_b2_filler'), 1);
    assert.equal(count(database, 'SELECT COUNT(*) AS count FROM asset_lineage_events WHERE asset_id = ?', assetId), 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try {
      if (database?.db?.open) database.db.pragma('max_page_count = 1073741823');
    } catch (_) {}
    try { await database?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
