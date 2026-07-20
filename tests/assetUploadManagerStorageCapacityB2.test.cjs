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
  AssetUploadManager,
} = require('../backend/src/services/assetUploadManager');

const MiB = 1024 * 1024;
const PROJECT_ID = 'project-upload-manager-capacity-b2';
const MEMBER_ID = 'member-upload-manager-capacity-b2';
const LOCAL_CONTEXT = Object.freeze({
  projectId: PROJECT_ID,
  memberId: MEMBER_ID,
  sourceKind: 'project',
});

function configFor(root) {
  const data = path.join(root, 'data');
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  const thumbnails = path.join(root, 'thumbnails');
  const blobs = path.join(root, 'asset-blobs');
  const uploads = path.join(root, 'upload-parts');
  for (const directory of [data, input, output, thumbnails, blobs, uploads]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return {
    DATA_DIR: data,
    INPUT_DIR: input,
    OUTPUT_DIR: output,
    THUMBNAILS_DIR: thumbnails,
    ASSET_BLOB_DIR: blobs,
    COLLAB_UPLOAD_TEMP_DIR: uploads,
    COLLAB_UPLOAD_CHUNK_BYTES: MiB,
    COLLAB_MAX_UPLOAD_BYTES: 8 * MiB,
    COLLAB_UPLOAD_SESSION_TTL_MS: 60 * 60 * 1000,
    COLLAB_PROJECT_QUOTA_BYTES: 64 * MiB,
    COLLAB_MEMBER_QUOTA_BYTES: 32 * MiB,
  };
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  return files.sort();
}

function createSession(manager, suffix = crypto.randomUUID()) {
  return manager.createSession({
    filename: `capacity-${suffix}.txt`,
    size: 4,
    contentHash: crypto.createHash('sha256').update('data').digest('hex'),
    idempotencyKey: `capacity-${suffix}`,
  }, LOCAL_CONTEXT);
}

function assertSafeUploadCapacity(error, reason, retryable = false) {
  assert.equal(error.code, 'asset_upload_storage_full');
  assert.equal(error.status, 507);
  assert.equal(error.statusCode, 507);
  assert.equal(error.reason, reason);
  assert.equal(error.retryable, retryable);
  assert.deepEqual(error.details, { reason, retryable });
  assert.match(error.message, /存储空间|数据库容量/);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
}

function assertProjectDatabaseCapacity(error, operation) {
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

function installUploadMaintenanceFull(database, fixtureName, triggerClause) {
  const markerName = `${fixtureName}_mark`;
  const tableName = `${fixtureName}_filler`;
  const triggerName = `${fixtureName}_full`;
  let hits = 0;
  database.db.function(markerName, () => {
    hits += 1;
    return 1;
  });
  database.db.exec(`
    CREATE TABLE ${tableName} (
      id INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
    CREATE TRIGGER ${triggerName}
    ${triggerClause}
    BEGIN
      SELECT ${markerName}();
      INSERT INTO ${tableName}(payload) VALUES (zeroblob(16777216));
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
  return {
    tableName,
    hits: () => hits,
    release() {
      database.db.pragma('max_page_count = 1073741823');
    },
  };
}

async function withUploadDatabase(prefix, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const config = configFor(root);
  const database = new ProjectDatabase(path.join(config.DATA_DIR, 'projects.sqlite3'), { autoBackup: false });
  const manager = new AssetUploadManager(config, database);
  try {
    await run({ root, config, database, manager });
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try { await manager.startupGcPromise; } catch (_) {}
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('B2 upload service maps typed and raw database FULL to one redacted 507 boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-upload-manager-boundary-b2-'));
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const manager = new AssetUploadManager(configFor(root), database);
  const originalCreate = database.createAssetUploadSession;
  try {
    const secretPath = path.join(root, 'private', 'projects.sqlite3');
    database.createAssetUploadSession = () => {
      throw Object.assign(new Error(`raw full at ${secretPath}; token=never-expose`), {
        code: 'SQLITE_FULL',
        path: secretPath,
      });
    };
    assert.throws(() => createSession(manager, 'raw-full-0001'), (error) => {
      assertSafeUploadCapacity(error, 'sqlite-full');
      const serialized = JSON.stringify(error);
      assert.equal(serialized.includes(secretPath), false);
      assert.equal(serialized.includes('never-expose'), false);
      return true;
    });

    database.createAssetUploadSession = () => {
      throw new ProjectDatabaseStorageCapacityError('wal-pressure', {
        operation: 'private.internal.operation',
      });
    };
    assert.throws(
      () => createSession(manager, 'typed-full-0001'),
      (error) => assertSafeUploadCapacity(error, 'wal-pressure', true),
    );

    const conflict = Object.assign(new Error('ordinary upload conflict'), {
      code: 'asset_upload_idempotency_conflict',
      status: 409,
    });
    database.createAssetUploadSession = () => { throw conflict; };
    let caught = null;
    try { createSession(manager, 'business-conflict-0001'); } catch (error) { caught = error; }
    assert.strictEqual(caught, conflict);
  } finally {
    database.createAssetUploadSession = originalCreate;
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('B2 standalone upload maintenance writers use exact coordinator operations and retry after real FULL', async (t) => {
  await t.test('recover interrupted sessions', () => withUploadDatabase(
    't8-upload-recover-writer-b2-',
    async ({ database, manager }) => {
      const session = createSession(manager, 'recover-writer-0001');
      database.db.prepare(`
        UPDATE asset_upload_sessions SET status='assembling' WHERE id=?
      `).run(session.id);
      const before = database.getAssetUploadSession(session.id);
      const fault = installUploadMaintenanceFull(
        database,
        'upload_recover_writer_b2',
        `BEFORE UPDATE OF status ON asset_upload_sessions
         WHEN OLD.id = '${session.id}' AND OLD.status = 'assembling' AND NEW.status = 'uploading'`,
      );
      try {
        assert.throws(
          () => database.recoverInterruptedAssetUploadSessions(Date.now()),
          (error) => assertProjectDatabaseCapacity(error, 'asset.upload.recover-interrupted'),
        );
        assert.equal(fault.hits(), 1);
        assert.deepEqual(database.getAssetUploadSession(session.id), before);
        assert.equal(database.db.prepare(`SELECT COUNT(*) AS count FROM ${fault.tableName}`).get().count, 0);
        assert.equal(database.db.inTransaction, false);

        fault.release();
        const recovered = database.recoverInterruptedAssetUploadSessions(Date.now());
        assert.deepEqual(recovered, [session.id]);
        assert.equal(database.getAssetUploadSession(session.id).status, 'uploading');
        assert.equal(database.db.prepare(`SELECT COUNT(*) AS count FROM ${fault.tableName}`).get().count, 1);
      } finally {
        fault.release();
      }
    },
  ));

  await t.test('expire active sessions', () => withUploadDatabase(
    't8-upload-expire-writer-b2-',
    async ({ database, manager }) => {
      const session = createSession(manager, 'expire-writer-0001');
      const expiredAt = Date.now() - 1;
      database.db.prepare('UPDATE asset_upload_sessions SET expires_at=? WHERE id=?')
        .run(expiredAt, session.id);
      const before = database.getAssetUploadSession(session.id);
      const fault = installUploadMaintenanceFull(
        database,
        'upload_expire_writer_b2',
        `BEFORE UPDATE OF status ON asset_upload_sessions
         WHEN OLD.id = '${session.id}' AND NEW.status = 'expired'`,
      );
      try {
        assert.throws(
          () => database.expireAssetUploadSessions(Date.now()),
          (error) => assertProjectDatabaseCapacity(error, 'asset.upload.expire'),
        );
        assert.equal(fault.hits(), 1);
        assert.deepEqual(database.getAssetUploadSession(session.id), before);
        assert.equal(database.db.prepare(`SELECT COUNT(*) AS count FROM ${fault.tableName}`).get().count, 0);
        assert.equal(database.db.inTransaction, false);

        fault.release();
        const expired = database.expireAssetUploadSessions(Date.now());
        assert.deepEqual(expired, [session.id]);
        assert.equal(database.getAssetUploadSession(session.id).status, 'expired');
        assert.equal(database.db.prepare(`SELECT COUNT(*) AS count FROM ${fault.tableName}`).get().count, 1);
      } finally {
        fault.release();
      }
    },
  ));

  await t.test('purge upload chunks', () => withUploadDatabase(
    't8-upload-purge-writer-b2-',
    async ({ database, manager }) => {
      const session = createSession(manager, 'purge-writer-0001');
      const bytes = Buffer.from('data');
      await manager.writeChunk(session.id, {
        index: 0,
        start: 0,
        end: bytes.length - 1,
        total: bytes.length,
        contentHash: crypto.createHash('sha256').update(bytes).digest('hex'),
        buffer: bytes,
      }, LOCAL_CONTEXT);
      const fault = installUploadMaintenanceFull(
        database,
        'upload_purge_writer_b2',
        `BEFORE DELETE ON asset_upload_chunks WHEN OLD.session_id = '${session.id}'`,
      );
      try {
        assert.throws(
          () => database.purgeAssetUploadChunks(session.id),
          (error) => assertProjectDatabaseCapacity(error, 'asset.upload.chunk-purge'),
        );
        assert.equal(fault.hits(), 1);
        assert.equal(database.listAssetUploadChunks(session.id).length, 1);
        assert.equal(database.db.prepare(`SELECT COUNT(*) AS count FROM ${fault.tableName}`).get().count, 0);
        assert.equal(database.db.inTransaction, false);

        fault.release();
        assert.equal(database.purgeAssetUploadChunks(session.id), 1);
        assert.equal(database.listAssetUploadChunks(session.id).length, 0);
        assert.equal(database.db.prepare(`SELECT COUNT(*) AS count FROM ${fault.tableName}`).get().count, 1);
      } finally {
        fault.release();
      }
    },
  ));

  await t.test('nested purge preserves the outer operation and rollback boundary', () => withUploadDatabase(
    't8-upload-nested-purge-writer-b2-',
    async ({ database, manager }) => {
      const session = createSession(manager, 'nested-purge-writer-0001');
      const bytes = Buffer.from('data');
      await manager.writeChunk(session.id, {
        index: 0,
        start: 0,
        end: bytes.length - 1,
        total: bytes.length,
        contentHash: crypto.createHash('sha256').update(bytes).digest('hex'),
        buffer: bytes,
      }, LOCAL_CONTEXT);
      assert.throws(
        () => database.withProjectDatabaseWrite('asset.upload.outer-maintenance-test', () => {
          assert.equal(database.purgeAssetUploadChunks(session.id), 1);
          throw Object.assign(new Error('late nested full'), { code: 'SQLITE_FULL' });
        }),
        (error) => assertProjectDatabaseCapacity(error, 'asset.upload.outer-maintenance-test'),
      );
      assert.equal(database.listAssetUploadChunks(session.id).length, 1);
      assert.equal(database.db.inTransaction, false);
      assert.equal(database.withProjectDatabaseWrite('asset.upload.outer-maintenance-test', () => (
        database.purgeAssetUploadChunks(session.id)
      )), 1);
      assert.equal(database.listAssetUploadChunks(session.id).length, 0);
    },
  ));
});

test('B2 expired upload sweep rolls a real late SQLITE_FULL back and retries the same request exactly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-upload-manager-full-b2-'));
  const config = configFor(root);
  const filename = path.join(config.DATA_DIR, 'projects.sqlite3');
  const database = new ProjectDatabase(filename, { autoBackup: false });
  const manager = new AssetUploadManager(config, database);
  let capApplied = false;
  try {
    const session = createSession(manager, 'late-full-0001');
    const bytes = Buffer.from('data');
    await manager.writeChunk(session.id, {
      index: 0,
      start: 0,
      end: bytes.length - 1,
      total: bytes.length,
      contentHash: crypto.createHash('sha256').update(bytes).digest('hex'),
      buffer: bytes,
    }, LOCAL_CONTEXT);
    const chunkPath = path.join(config.COLLAB_UPLOAD_TEMP_DIR, session.id, 'chunk-00000000.part');
    const expiredAt = Date.now() - 1;
    database.db.prepare('UPDATE asset_upload_sessions SET expires_at = ? WHERE id = ?')
      .run(expiredAt, session.id);

    let lateDeleteReached = false;
    database.db.function('upload_manager_b2_mark_late_delete', () => {
      lateDeleteReached = true;
      return 1;
    });
    database.db.exec(`
      CREATE TABLE upload_manager_b2_filler (
        id INTEGER PRIMARY KEY,
        payload BLOB NOT NULL
      );
      CREATE TRIGGER upload_manager_b2_force_late_full
      BEFORE DELETE ON asset_upload_chunks
      WHEN OLD.session_id = '${session.id}'
      BEGIN
        SELECT upload_manager_b2_mark_late_delete();
        INSERT INTO upload_manager_b2_filler(payload) VALUES (zeroblob(16777216));
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
    capApplied = true;

    assert.throws(
      () => manager.sweepExpired(Date.now()),
      (error) => assertSafeUploadCapacity(error, 'sqlite-full'),
    );
    assert.equal(lateDeleteReached, true, 'FULL must occur after the session expiration update');
    assert.equal(database.db.inTransaction, false);
    assert.equal(database.getAssetUploadSession(session.id).status, 'uploading');
    assert.equal(database.listAssetUploadChunks(session.id).length, 1);
    assert.equal(fs.existsSync(chunkPath), true, 'filesystem cleanup must wait for the committed DB result');
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM upload_manager_b2_filler').get().count, 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    database.db.pragma('max_page_count = 1073741823');
    capApplied = false;
    lateDeleteReached = false;
    assert.deepEqual(manager.sweepExpired(Date.now()), [session.id]);
    assert.equal(lateDeleteReached, true);
    assert.equal(database.getAssetUploadSession(session.id).status, 'expired');
    assert.equal(database.listAssetUploadChunks(session.id).length, 0);
    assert.equal(fs.existsSync(path.dirname(chunkPath)), false);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM upload_manager_b2_filler').get().count, 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    if (capApplied) {
      try { database.db.pragma('max_page_count = 1073741823'); } catch (_) {}
    }
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('B2 upload completion preserves chunks and CAS compensation across real late FULL for exact request retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-upload-manager-commit-full-b2-'));
  const config = configFor(root);
  const filename = path.join(config.DATA_DIR, 'projects.sqlite3');
  const database = new ProjectDatabase(filename, { autoBackup: false });
  const manager = new AssetUploadManager(config, database);
  let capApplied = false;
  try {
    const bytes = Buffer.from('capacity-safe exact retry payload');
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const session = manager.createSession({
      filename: 'capacity-completion.txt',
      size: bytes.length,
      contentHash,
      idempotencyKey: 'capacity-completion-0001',
    }, LOCAL_CONTEXT);
    await manager.writeChunk(session.id, {
      index: 0,
      start: 0,
      end: bytes.length - 1,
      total: bytes.length,
      contentHash,
      buffer: bytes,
    }, LOCAL_CONTEXT);
    const chunkPath = path.join(config.COLLAB_UPLOAD_TEMP_DIR, session.id, 'chunk-00000000.part');

    let lateCommitReached = false;
    database.db.function('upload_manager_b2_mark_late_commit', () => {
      lateCommitReached = true;
      return 1;
    });
    database.db.exec(`
      CREATE TABLE upload_manager_b2_commit_filler (
        id INTEGER PRIMARY KEY,
        payload BLOB NOT NULL
      );
      CREATE TRIGGER upload_manager_b2_force_commit_full
      BEFORE UPDATE OF status ON asset_upload_sessions
      WHEN OLD.id = '${session.id}' AND OLD.status = 'assembling' AND NEW.status = 'completed'
      BEGIN
        SELECT upload_manager_b2_mark_late_commit();
        INSERT INTO upload_manager_b2_commit_filler(payload) VALUES (zeroblob(16777216));
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
    capApplied = true;

    await assert.rejects(
      manager.complete(session.id, { contentHash }, LOCAL_CONTEXT),
      (error) => assertSafeUploadCapacity(error, 'sqlite-full'),
    );
    assert.equal(lateCommitReached, true, 'FULL must occur at the final session-completion write');
    assert.equal(database.db.inTransaction, false);
    const afterFailure = database.getAssetUploadSession(session.id);
    assert.equal(afterFailure.status, 'assembling');
    assert.equal(afterFailure.assetId, null);
    assert.equal(database.listAssetUploadChunks(session.id).length, 1);
    assert.equal(fs.existsSync(chunkPath), true);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM assets
      WHERE json_extract(provenance_json, '$.uploadSessionId') = ?
    `).get(session.id).count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM upload_manager_b2_commit_filler').get().count, 0);
    assert.deepEqual(walkFiles(config.ASSET_BLOB_DIR), [], 'failed DB commit must not publish an unreferenced CAS blob');
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    database.db.pragma('max_page_count = 1073741823');
    capApplied = false;
    lateCommitReached = false;
    const completed = await manager.complete(session.id, { contentHash }, LOCAL_CONTEXT);
    assert.equal(lateCommitReached, true);
    assert.equal(completed.idempotentReplay, false);
    assert.equal(completed.session.status, 'completed');
    assert.equal(completed.asset.contentHash, contentHash);
    assert.equal(database.listAssetUploadChunks(session.id).length, 0);
    assert.equal(fs.existsSync(path.dirname(chunkPath)), false);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM upload_manager_b2_commit_filler').get().count, 1);
    assert.equal(walkFiles(config.ASSET_BLOB_DIR).length, 1);

    lateCommitReached = false;
    const replay = await manager.complete(session.id, { contentHash }, LOCAL_CONTEXT);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.asset.id, completed.asset.id);
    assert.equal(lateCommitReached, false);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM upload_manager_b2_commit_filler').get().count, 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    if (capApplied) {
      try { database.db.pragma('max_page_count = 1073741823'); } catch (_) {}
    }
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('B2 upload completion reports committed success when post-commit finalization hits capacity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-upload-manager-post-commit-b2-'));
  const config = configFor(root);
  const database = new ProjectDatabase(path.join(config.DATA_DIR, 'projects.sqlite3'), { autoBackup: false });
  const manager = new AssetUploadManager(config, database);
  const originalFinalize = manager._finalizeCompletedAsset;
  try {
    const bytes = Buffer.from('post-commit capacity retry payload');
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const session = manager.createSession({
      filename: 'post-commit-capacity.txt',
      size: bytes.length,
      contentHash,
      idempotencyKey: 'post-commit-capacity-0001',
    }, LOCAL_CONTEXT);
    await manager.writeChunk(session.id, {
      index: 0,
      start: 0,
      end: bytes.length - 1,
      total: bytes.length,
      contentHash,
      buffer: bytes,
    }, LOCAL_CONTEXT);
    const chunkPath = path.join(config.COLLAB_UPLOAD_TEMP_DIR, session.id, 'chunk-00000000.part');

    manager._finalizeCompletedAsset = (completedSession, asset) => {
      assert.equal(completedSession.status, 'completed');
      assert.equal(database.getAssetUploadSession(session.id).assetId, asset.id);
      const error = new ProjectDatabaseStorageCapacityError('wal-pressure', {
        operation: 'private.post-commit.finalization',
      });
      error.message = `private finalization failed at ${path.join(root, 'secret.sqlite3')}`;
      throw error;
    };

    const committed = await manager.complete(session.id, { contentHash }, LOCAL_CONTEXT);
    assert.equal(committed.idempotentReplay, false);
    assert.equal(committed.session.status, 'completed');
    assert.equal(committed.asset.id, committed.session.assetId);
    assert.deepEqual(committed.persistenceWarning, {
      code: 'asset_upload_post_commit_capacity',
      committed: true,
      phase: 'finalization',
      reason: 'wal-pressure',
      retryable: true,
    });
    assert.doesNotMatch(JSON.stringify(committed.persistenceWarning), /private|secret\.sqlite3/i);
    assert.equal(database.getAssetUploadSession(session.id).status, 'completed');
    assert.equal(database.getAsset(committed.asset.id).contentHash, contentHash);
    assert.equal(database.listAssetUploadChunks(session.id).length, 1);
    assert.equal(fs.existsSync(chunkPath), true, 'retry evidence must remain until finalization can settle');
    assert.equal(walkFiles(config.ASSET_BLOB_DIR).length, 1);

    manager._finalizeCompletedAsset = originalFinalize;
    const retried = await manager.complete(session.id, { contentHash }, LOCAL_CONTEXT);
    assert.equal(retried.idempotentReplay, true);
    assert.equal(Object.hasOwn(retried, 'persistenceWarning'), false);
    assert.equal(retried.asset.id, committed.asset.id);
    assert.equal(retried.asset.metadata.uploadFinalization, 'completed');
    assert.equal(database.listAssetUploadChunks(session.id).length, 0);
    assert.equal(fs.existsSync(path.dirname(chunkPath)), false);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    manager._finalizeCompletedAsset = originalFinalize;
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
