'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'project-asset-upload-writers-capacity-b2';
const MEMBER_ID = 'member-asset-upload-writers-capacity-b2';
const TEST_NOW = 2_000_000_000_000;
const LIMITS = Object.freeze({
  projectLimit: 1024 * 1024,
  memberLimit: 1024 * 1024,
});
const OUTER_OPERATION = 'asset.upload.outer-capacity-test';
let fixtureSequence = 0;

function createUploadSession(database, suffix, overrides = {}) {
  return database.createAssetUploadSession({
    id: `upload-writer-${suffix}`,
    projectId: PROJECT_ID,
    memberId: MEMBER_ID,
    sourceKind: 'collaboration',
    idempotencyKey: `upload-writer-${suffix}-0001`,
    filename: `${suffix}.bin`,
    mimeType: 'application/octet-stream',
    expectedSize: 4,
    expectedHash: 'a'.repeat(64),
    chunkSize: 4,
    now: TEST_NOW,
    expiresAt: TEST_NOW + 60 * 60 * 1000,
    ...overrides,
  }, LIMITS);
}

function recordOnlyChunk(database, sessionId, overrides = {}) {
  return database.recordAssetUploadChunk(sessionId, {
    index: 0,
    start: 0,
    end: 3,
    size: 4,
    contentHash: 'b'.repeat(64),
    now: TEST_NOW + 1,
    ...overrides,
  });
}

function uploadState(database, sessionId) {
  return {
    session: database.db.prepare(`
      SELECT * FROM asset_upload_sessions WHERE id = ?
    `).get(sessionId) || null,
    chunks: database.db.prepare(`
      SELECT * FROM asset_upload_chunks WHERE session_id = ? ORDER BY chunk_index
    `).all(sessionId),
  };
}

function blobState(database, contentHash) {
  return database.db.prepare(`
    SELECT * FROM asset_blobs WHERE content_hash = ?
  `).get(contentHash) || null;
}

function installLateRawCapacityFault(database, triggerClause) {
  fixtureSequence += 1;
  const prefix = `upload_writer_capacity_b2_${fixtureSequence}`;
  const functionName = `${prefix}_fault`;
  const markerTable = `${prefix}_markers`;
  const triggerName = `${prefix}_trigger`;
  let failNext = true;
  const observations = [];

  database.db.function(functionName, () => {
    observations.push({
      coordinatorActive: database.isProjectDatabaseWriteCoordinatorActive(),
      inTransaction: database.db.inTransaction,
    });
    if (failNext) {
      failNext = false;
      throw Object.assign(new Error('controlled late raw upload ENOSPC'), { code: 'ENOSPC' });
    }
    return 1;
  });
  database.db.exec(`
    CREATE TABLE ${markerTable} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reached_at INTEGER NOT NULL
    );
    CREATE TRIGGER ${triggerName}
    ${triggerClause}
    BEGIN
      INSERT INTO ${markerTable}(reached_at) VALUES (unixepoch());
      SELECT ${functionName}();
    END;
  `);

  return {
    observations,
    markerCount() {
      return Number(database.db.prepare(`SELECT COUNT(*) AS count FROM ${markerTable}`).get().count);
    },
  };
}

function isCapacityErrorForOperation(error, operation) {
  return error instanceof ProjectDatabaseStorageCapacityError
    && error.code === 'project_database_storage_capacity_exceeded'
    && error.status === 507
    && error.statusCode === 507
    && error.reason === 'filesystem-reserve'
    && error.details?.operation === operation;
}

function exerciseLateCapacityCase({
  database,
  fault,
  operation,
  invoke,
  snapshot,
  verify,
}) {
  const before = snapshot();
  assert.throws(invoke, (error) => isCapacityErrorForOperation(error, operation));
  assert.equal(database.db.inTransaction, false);
  assert.deepEqual(snapshot(), before);
  assert.equal(fault.markerCount(), 0, 'the late marker must roll back with the target write');

  const result = invoke();
  verify(result, before);
  assert.equal(fault.markerCount(), 1, 'retry must execute and commit exactly one target write');
  assert.deepEqual(fault.observations, [
    { coordinatorActive: true, inTransaction: true },
    { coordinatorActive: true, inTransaction: true },
  ]);
  assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.db.pragma('foreign_key_check'), []);
}

async function withDatabase(run) {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    await run(database);
  } finally {
    await database.close();
  }
}

test('B2 standalone upload and blob writers translate late raw capacity with exact operations and retry once', async (t) => {
  await t.test('markAssetBlobStored', () => withDatabase((database) => {
    const contentHash = 'c'.repeat(64);
    const fault = installLateRawCapacityFault(database, `
      AFTER INSERT ON asset_blobs
      WHEN NEW.content_hash = '${contentHash}'
    `);
    const invoke = () => database.markAssetBlobStored({
      contentHash,
      byteSize: 4,
      mimeType: 'application/octet-stream',
      storageKey: `sha256/cc/cc/${contentHash}`,
      verifiedAt: TEST_NOW,
    });
    exerciseLateCapacityCase({
      database,
      fault,
      operation: 'asset.blob.store',
      invoke,
      snapshot: () => blobState(database, contentHash),
      verify(blob) {
        assert.equal(blob.contentHash, contentHash);
        assert.equal(blob.byteSize, 4);
        assert.equal(blob.storageState, 'ready');
      },
    });
  }));

  await t.test('createAssetUploadSession', () => withDatabase((database) => {
    const sessionId = 'upload-writer-session-create';
    const fault = installLateRawCapacityFault(database, `
      AFTER INSERT ON asset_upload_sessions
      WHEN NEW.id = '${sessionId}'
    `);
    const invoke = () => createUploadSession(database, 'session-create');
    exerciseLateCapacityCase({
      database,
      fault,
      operation: 'asset.upload.session-create',
      invoke,
      snapshot: () => uploadState(database, sessionId),
      verify(session) {
        assert.equal(session.id, sessionId);
        assert.equal(session.status, 'uploading');
        assert.equal(session.revision, 1);
      },
    });
  }));

  await t.test('recordAssetUploadChunk', () => withDatabase((database) => {
    const session = createUploadSession(database, 'chunk-record');
    const fault = installLateRawCapacityFault(database, `
      AFTER UPDATE OF received_bytes ON asset_upload_sessions
      WHEN NEW.id = '${session.id}' AND NEW.revision = OLD.revision + 1
    `);
    const invoke = () => recordOnlyChunk(database, session.id);
    exerciseLateCapacityCase({
      database,
      fault,
      operation: 'asset.upload.chunk-record',
      invoke,
      snapshot: () => uploadState(database, session.id),
      verify(updated, before) {
        assert.equal(updated.receivedBytes, 4);
        assert.equal(updated.receivedChunks.length, 1);
        assert.equal(updated.revision, before.session.revision + 1);
        assert.equal(uploadState(database, session.id).chunks.length, 1);
      },
    });
  }));

  for (const transition of [
    { action: 'pause', from: 'uploading', to: 'paused' },
    { action: 'resume', from: 'paused', to: 'uploading' },
    { action: 'cancel', from: 'uploading', to: 'cancelled' },
  ]) {
    await t.test(`transitionAssetUploadSession ${transition.action}`, () => withDatabase((database) => {
      const session = createUploadSession(database, `transition-${transition.action}`);
      if (transition.from === 'paused') {
        database.transitionAssetUploadSession(session.id, 'pause', { now: TEST_NOW + 1 });
      }
      const fault = installLateRawCapacityFault(database, `
        AFTER UPDATE OF status ON asset_upload_sessions
        WHEN OLD.id = '${session.id}' AND OLD.status = '${transition.from}' AND NEW.status = '${transition.to}'
      `);
      const invoke = () => database.transitionAssetUploadSession(session.id, transition.action, {
        now: TEST_NOW + 2,
      });
      exerciseLateCapacityCase({
        database,
        fault,
        operation: `asset.upload.${transition.action}`,
        invoke,
        snapshot: () => uploadState(database, session.id),
        verify(updated, before) {
          assert.equal(updated.status, transition.to);
          assert.equal(updated.revision, before.session.revision + 1);
        },
      });
    }));
  }

  await t.test('claimAssetUploadCompletion', () => withDatabase((database) => {
    const session = createUploadSession(database, 'completion-claim');
    recordOnlyChunk(database, session.id);
    const fault = installLateRawCapacityFault(database, `
      AFTER UPDATE OF status ON asset_upload_sessions
      WHEN OLD.id = '${session.id}' AND OLD.status = 'uploading' AND NEW.status = 'assembling'
    `);
    const invoke = () => database.claimAssetUploadCompletion(session.id, { now: TEST_NOW + 2 });
    exerciseLateCapacityCase({
      database,
      fault,
      operation: 'asset.upload.completion-claim',
      invoke,
      snapshot: () => uploadState(database, session.id),
      verify(updated, before) {
        assert.equal(updated.status, 'assembling');
        assert.equal(updated.revision, before.session.revision + 1);
      },
    });
  }));

  await t.test('completeAssetUploadSession', () => withDatabase((database) => {
    const session = createUploadSession(database, 'session-complete');
    recordOnlyChunk(database, session.id);
    database.claimAssetUploadCompletion(session.id, { now: TEST_NOW + 2 });
    const contentHash = 'd'.repeat(64);
    const assetId = 'upload-writer-completed-asset';
    database.markAssetBlobStored({
      contentHash,
      byteSize: 4,
      mimeType: 'application/octet-stream',
      storageKey: `sha256/dd/dd/${contentHash}`,
      verifiedAt: TEST_NOW + 2,
    });
    database.upsertAsset({
      id: assetId,
      projectId: PROJECT_ID,
      kind: 'file',
      mimeType: 'application/octet-stream',
      filename: 'completed.bin',
      contentHash,
      contentHashVerification: 'verified',
      metadata: { size: 4 },
    });
    const fault = installLateRawCapacityFault(database, `
      AFTER UPDATE OF status ON asset_upload_sessions
      WHEN OLD.id = '${session.id}' AND OLD.status = 'assembling' AND NEW.status = 'completed'
    `);
    const invoke = () => database.completeAssetUploadSession(session.id, {
      assetId,
      contentHash,
      deduplicated: true,
      now: TEST_NOW + 3,
    });
    exerciseLateCapacityCase({
      database,
      fault,
      operation: 'asset.upload.session-complete',
      invoke,
      snapshot: () => uploadState(database, session.id),
      verify(updated, before) {
        assert.equal(updated.status, 'completed');
        assert.equal(updated.assetId, assetId);
        assert.equal(updated.contentHash, contentHash);
        assert.equal(updated.deduplicated, true);
        assert.equal(updated.revision, before.session.revision + 1);
      },
    });
  }));

  await t.test('failAssetUploadSession', () => withDatabase((database) => {
    const session = createUploadSession(database, 'session-fail');
    const fault = installLateRawCapacityFault(database, `
      AFTER UPDATE OF status ON asset_upload_sessions
      WHEN OLD.id = '${session.id}' AND NEW.status = 'failed'
    `);
    const invoke = () => database.failAssetUploadSession(session.id, {
      code: 'controlled_failure',
      message: 'controlled upload failure',
      now: TEST_NOW + 1,
    });
    exerciseLateCapacityCase({
      database,
      fault,
      operation: 'asset.upload.fail',
      invoke,
      snapshot: () => uploadState(database, session.id),
      verify(updated, before) {
        assert.equal(updated.status, 'failed');
        assert.equal(updated.errorCode, 'controlled_failure');
        assert.equal(updated.errorMessage, 'controlled upload failure');
        assert.equal(updated.revision, before.session.revision + 1);
      },
    });
  }));
});

test('B2 nested upload writer leaves late raw capacity translation to the outer operation', () => withDatabase((database) => {
  const session = createUploadSession(database, 'nested-chunk-record');
  const fault = installLateRawCapacityFault(database, `
    AFTER UPDATE OF received_bytes ON asset_upload_sessions
    WHEN NEW.id = '${session.id}' AND NEW.revision = OLD.revision + 1
  `);
  const invoke = () => database.withProjectDatabaseWrite(
    OUTER_OPERATION,
    () => recordOnlyChunk(database, session.id),
  );
  exerciseLateCapacityCase({
    database,
    fault,
    operation: OUTER_OPERATION,
    invoke,
    snapshot: () => uploadState(database, session.id),
    verify(updated, before) {
      assert.equal(updated.receivedBytes, 4);
      assert.equal(updated.receivedChunks.length, 1);
      assert.equal(updated.revision, before.session.revision + 1);
    },
  });
}));
