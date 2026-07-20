const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const {
  PROJECT_DATABASE_MIGRATIONS,
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');
const {
  assertCurrentProjectDatabaseRegistry,
} = require('./helpers/projectDatabaseVersion.cjs');
const {
  AssetUploadManager,
  safeUploadErrorCode,
  safeUploadErrorMessage,
} = require('../backend/src/services/assetUploadManager');
const { CollaborationGateway } = require('../backend/src/collaboration/gateway');

const PROJECT_ID = 'project-local';
const MiB = 1024 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deterministicBytes(size, seed = 37) {
  const output = Buffer.allocUnsafe(size);
  // Keep the fixture valid UTF-8 text so successful completion exercises the
  // real upload validator instead of relying on a fake media extension.
  for (let offset = 0; offset < size; offset += 1) output[offset] = 33 + ((seed + offset * 31) % 94);
  return output;
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) output.push(full);
    }
  }
  return output.sort();
}

function filesWithHash(root, digest) {
  return walkFiles(root).filter((filename) => sha256(fs.readFileSync(filename)) === digest);
}

function sessionData(payload) {
  return payload?.data?.session || payload?.data;
}

function assetData(payload) {
  return payload?.data?.asset || payload?.data;
}

async function responseBody(response) {
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_) {}
  return { response, payload, text };
}

function assertNoHostPath(value, fixture) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const candidates = [
    fixture.root,
    fixture.root.replace(/\\/g, '/'),
    encodeURIComponent(fixture.root),
    encodeURIComponent(fixture.root.replace(/\\/g, '/')),
    fixture.blobDir,
    fixture.tempDir,
  ].map((item) => String(item).toLowerCase());
  for (const candidate of candidates) {
    assert.equal(serialized.toLowerCase().includes(candidate), false, `response leaked host path: ${candidate}`);
  }
  assert.doesNotMatch(serialized, /(?:^|[^a-z0-9])[a-z]:[\\/]/i, 'response leaked a Windows drive path or 8.3 alias');
  assert.doesNotMatch(serialized, /\\\\(?:\?\\)?[^\\/\s]+[\\/][^\s]/, 'response leaked a UNC or extended Windows path');
  assert.doesNotMatch(
    serialized,
    /(^|[\s("'`=,:;?&#])\/(?:Users|home|tmp|var|private|mnt|workspace|opt|srv)(?:\/|$)/i,
    'response leaked a host POSIX/temp path',
  );
  assert.doesNotMatch(serialized, /(?:managed|absolute|temporary|temp|blob)(?:_|-)?path/i);
}

function createFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-d5-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  const thumbnails = path.join(root, 'thumbnails');
  const previews = path.join(thumbnails, 'asset-previews');
  const blobDir = path.join(root, 'asset-blobs');
  const tempDir = path.join(root, 'upload-parts');
  const dbFile = path.join(root, 'data', 'projects.sqlite3');
  for (const directory of [input, output, thumbnails, previews, blobDir, tempDir, path.dirname(dbFile)]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const config = {
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    COLLAB_ALLOWED_ORIGINS: [],
    COLLAB_PROJECT_QUOTA_BYTES: 64 * MiB,
    COLLAB_MEMBER_QUOTA_BYTES: 32 * MiB,
    COLLAB_UPLOAD_CHUNK_BYTES: MiB,
    COLLAB_UPLOAD_SESSION_TTL_MS: 60 * 60 * 1000,
    INPUT_DIR: input,
    OUTPUT_DIR: output,
    THUMBNAILS_DIR: thumbnails,
    ASSET_PREVIEWS_DIR: previews,
    ASSET_BLOB_DIR: blobDir,
    COLLAB_UPLOAD_TEMP_DIR: tempDir,
    FRONTEND_DIST: '',
    ...overrides,
  };
  const fixture = {
    root,
    input,
    output,
    thumbnails,
    previews,
    blobDir,
    tempDir,
    dbFile,
    config,
    database: new ProjectDatabase(dbFile),
    gateway: null,
    baseUrl: '',
  };
  fixture.database.ensureCanvas('canvas-d5', {
    projectId: PROJECT_ID,
    name: 'D5 upload fixture',
    nodes: [],
    edges: [],
  });
  return fixture;
}

async function startFixture(fixture) {
  fixture.gateway = new CollaborationGateway(fixture.config, fixture.database);
  const status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  fixture.baseUrl = `http://127.0.0.1:${status.port}`;
  return fixture;
}

async function restartFixture(fixture, databaseOptions = undefined) {
  await fixture.gateway.stop();
  await fixture.database.close();
  fixture.database = new ProjectDatabase(fixture.dbFile, databaseOptions);
  fixture.gateway = new CollaborationGateway(fixture.config, fixture.database);
  const status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  fixture.baseUrl = `http://127.0.0.1:${status.port}`;
  return fixture;
}

async function disposeFixture(fixture) {
  try { await fixture.gateway?.stop(); } catch (_) {}
  try { await fixture.database?.close(); } catch (_) {}
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

async function redeem(fixture, role = 'editor', displayName = role) {
  const invite = fixture.gateway.auth.createInvite({
    projectId: PROJECT_ID,
    canvasId: 'canvas-d5',
    role,
    maxUses: 1,
  });
  const result = await responseBody(await fetch(`${fixture.baseUrl}/api/collab/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, displayName }),
  }));
  assert.equal(result.response.status, 200, result.text);
  return {
    cookie: result.response.headers.get('set-cookie').split(';')[0],
    member: result.payload.data,
    recoveryGeneration: fixture.database.getRecoveryGeneration(),
  };
}

function uploadMutationHeaders(actor, headers = {}) {
  return {
    cookie: actor.cookie,
    'x-t8-canvas-generation': actor.recoveryGeneration,
    ...headers,
  };
}

async function beginUpload(fixture, actor, input) {
  return responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/uploads`, {
    method: 'POST',
    headers: uploadMutationHeaders(actor, { 'content-type': 'application/json' }),
    body: JSON.stringify(input),
  }));
}

async function putChunk(fixture, actor, session, index, bytes, options = {}) {
  const start = options.start ?? index * session.chunkSize;
  const end = options.end ?? start + bytes.length - 1;
  const total = options.total ?? session.expectedSize ?? session.size;
  return responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/uploads/${encodeURIComponent(session.id)}/chunks/${index}`, {
    method: 'PUT',
    headers: uploadMutationHeaders(actor, {
      'content-type': 'application/octet-stream',
      'content-range': options.contentRange || `bytes ${start}-${end}/${total}`,
      'x-chunk-sha256': options.chunkHash || sha256(bytes),
    }),
    body: bytes,
  }));
}

async function readUpload(fixture, actor, uploadId) {
  return responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/uploads/${encodeURIComponent(uploadId)}`, {
    headers: { cookie: actor.cookie },
  }));
}

async function completeUpload(fixture, actor, uploadId, digest) {
  return responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/uploads/${encodeURIComponent(uploadId)}/complete`, {
    method: 'POST',
    headers: uploadMutationHeaders(actor, { 'content-type': 'application/json' }),
    body: JSON.stringify({ sha256: digest }),
  }));
}

async function cancelUpload(fixture, actor, uploadId) {
  return responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/uploads/${encodeURIComponent(uploadId)}`, {
    method: 'DELETE',
    headers: uploadMutationHeaders(actor),
  }));
}

async function postUploadAction(fixture, actor, uploadId, action) {
  return responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/uploads/${encodeURIComponent(uploadId)}/${action}`, {
    method: 'POST',
    headers: uploadMutationHeaders(actor),
  }));
}

async function rotateSession(fixture, actor) {
  const result = await responseBody(await fetch(`${fixture.baseUrl}/api/collab/session/rotate`, {
    method: 'POST',
    headers: { cookie: actor.cookie },
  }));
  return {
    ...result,
    actor: {
      ...actor,
      cookie: result.response.headers.get('set-cookie')?.split(';')[0] || '',
    },
  };
}

async function eventually(assertion, attempts = 50) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

function chunkAt(bytes, session, index) {
  const start = index * session.chunkSize;
  return bytes.subarray(start, Math.min(bytes.length, start + session.chunkSize));
}

async function uploadWholeAsset(fixture, actor, bytes, options = {}) {
  const digest = sha256(bytes);
  const begin = await beginUpload(fixture, actor, {
    filename: options.filename || 'fixture.txt',
    mimeType: options.mimeType || 'text/plain',
    size: bytes.length,
    sha256: digest,
    chunkSize: options.chunkSize || MiB,
    idempotencyKey: options.idempotencyKey || crypto.randomUUID(),
  });
  assert.equal(begin.response.status, 201, begin.text);
  const session = sessionData(begin.payload);
  for (const index of session.missingChunks || Array.from({ length: session.chunkCount }, (_, item) => item)) {
    const uploaded = await putChunk(fixture, actor, session, index, chunkAt(bytes, session, index));
    assert.ok([200, 201].includes(uploaded.response.status), uploaded.text);
  }
  const complete = await completeUpload(fixture, actor, session.id, digest);
  assert.equal(complete.response.status, 201, complete.text);
  return { begin, session, complete, asset: assetData(complete.payload) };
}

test('schema 18 records the durable D5 upload migration', () => {
  assertCurrentProjectDatabaseRegistry(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATIONS);
  const database = new ProjectDatabase(':memory:');
  try {
    assert.equal(database.db.prepare('SELECT 1 AS ok FROM schema_migrations WHERE version = 18').get()?.ok, 1);
    const tables = new Set(database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    assert.equal(tables.has('asset_upload_sessions'), true);
    assert.equal(tables.has('asset_upload_chunks'), true);
    const blobColumns = new Set(database.db.prepare('PRAGMA table_info(asset_blobs)').all().map((row) => row.name));
    assert.equal(blobColumns.has('storage_key'), true);
    assert.equal(blobColumns.has('storage_state'), true);
  } finally {
    database.close();
  }
});

test('upload error sanitization maps raw filesystem errors and rejects drive, 8.3, UNC, and arbitrary POSIX paths', () => {
  assert.equal(safeUploadErrorCode({ code: 'ENOENT' }), 'asset_upload_storage_missing');
  assert.equal(safeUploadErrorMessage({ code: 'ENOENT', message: String.raw`open C:\Users\ADMINI~1\Temp\chunk.part` }), '上传暂存数据缺失，请重新开始本次上传');

  const fallback = '安全的上传失败提示';
  const unsafeMessages = [
    String.raw`open C:\Users\ADMINI~1\AppData\Local\Temp\chunk.part`,
    String.raw`open \\fileserver\private-share\chunk.part`,
    `open '/data/custom-upload-root/chunk.part'`,
  ];
  for (const message of unsafeMessages) {
    const error = Object.assign(new Error(message), { code: 'UNKNOWN_FILESYSTEM_ERROR' });
    assert.equal(safeUploadErrorCode(error), 'asset_upload_failed');
    assert.equal(safeUploadErrorMessage(error, fallback), fallback);
  }
});

test('out-of-order chunks survive a cold gateway restart and complete only after exact chunk and whole-file hashes match', async () => {
  const fixture = createFixture();
  try {
    await startFixture(fixture);
    const editor = await redeem(fixture, 'editor', 'resume editor');
    const bytes = deterministicBytes(3 * MiB + 733, 19);
    const digest = sha256(bytes);
    const begin = await beginUpload(fixture, editor, {
      filename: 'resume-payload.txt',
      mimeType: 'text/plain',
      size: bytes.length,
      sha256: digest,
      chunkSize: MiB,
      idempotencyKey: 'd5-resume-0001',
    });
    assert.equal(begin.response.status, 201, begin.text);
    const session = sessionData(begin.payload);
    assert.equal(session.status, 'uploading');
    assert.equal(session.chunkCount, 4);
    assert.equal(session.receivedBytes, 0);
    assertNoHostPath(begin.payload, fixture);

    const chunkTwo = await putChunk(fixture, editor, session, 2, chunkAt(bytes, session, 2));
    assert.ok([200, 201].includes(chunkTwo.response.status), chunkTwo.text);
    const chunkZero = await putChunk(fixture, editor, session, 0, chunkAt(bytes, session, 0));
    assert.ok([200, 201].includes(chunkZero.response.status), chunkZero.text);

    const badHash = await putChunk(fixture, editor, session, 1, chunkAt(bytes, session, 1), {
      chunkHash: '0'.repeat(64),
    });
    assert.equal(badHash.response.status, 422, badHash.text);
    assert.match(String(badHash.payload?.code || badHash.payload?.error), /chunk.*hash|hash.*chunk/i);
    assertNoHostPath(badHash.payload || badHash.text, fixture);

    const badRange = await putChunk(fixture, editor, session, 1, chunkAt(bytes, session, 1), {
      start: 0,
      end: session.chunkSize - 1,
    });
    assert.equal(badRange.response.status, 416, badRange.text);
    assert.match(String(badRange.payload?.code || badRange.payload?.error), /range/i);

    const beforeRestart = await readUpload(fixture, editor, session.id);
    assert.equal(beforeRestart.response.status, 200, beforeRestart.text);
    assert.deepEqual(sessionData(beforeRestart.payload).receivedChunks, [0, 2]);
    assert.deepEqual(sessionData(beforeRestart.payload).missingChunks, [1, 3]);
    assert.equal(sessionData(beforeRestart.payload).receivedBytes, 2 * MiB);

    const incomplete = await completeUpload(fixture, editor, session.id, digest);
    assert.equal(incomplete.response.status, 409, incomplete.text);
    assert.match(String(incomplete.payload?.code || incomplete.payload?.error), /incomplete|missing/i);

    await restartFixture(fixture);
    const resumed = await readUpload(fixture, editor, session.id);
    assert.equal(resumed.response.status, 200, resumed.text);
    assert.deepEqual(sessionData(resumed.payload).receivedChunks, [0, 2]);
    assert.deepEqual(sessionData(resumed.payload).missingChunks, [1, 3]);
    assertNoHostPath(resumed.payload, fixture);

    const idempotent = await putChunk(fixture, editor, session, 0, chunkAt(bytes, session, 0));
    assert.equal(idempotent.response.status, 200, idempotent.text);
    assert.equal(sessionData(idempotent.payload).receivedBytes, 2 * MiB, 'retrying an accepted chunk must not consume quota twice');

    for (const index of [3, 1]) {
      const uploaded = await putChunk(fixture, editor, session, index, chunkAt(bytes, session, index));
      assert.ok([200, 201].includes(uploaded.response.status), uploaded.text);
    }
    const completed = await completeUpload(fixture, editor, session.id, digest);
    assert.equal(completed.response.status, 201, completed.text);
    const asset = assetData(completed.payload);
    assert.equal(asset.contentHash, digest);
    assert.equal(asset.storageMode, 'managed');
    assert.equal(asset.availability, 'available');
    assertNoHostPath(completed.payload, fixture);

    const internal = fixture.database.getAsset(asset.id);
    const relativeToBlobRoot = path.relative(
      fs.realpathSync.native(fixture.blobDir),
      fs.realpathSync.native(internal.managedPath),
    );
    assert.ok(relativeToBlobRoot && relativeToBlobRoot !== '..' && !relativeToBlobRoot.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToBlobRoot));
    assert.equal(sha256(fs.readFileSync(internal.managedPath)), digest);
    assert.equal(filesWithHash(fixture.blobDir, digest).length, 1);
    assert.equal(walkFiles(fixture.tempDir).length, 0, 'completed sessions must remove all part files');
  } finally {
    await disposeFixture(fixture);
  }
});

test('a missing recorded chunk returns and persists only a stable pathless upload error', async () => {
  const fixture = createFixture();
  try {
    await startFixture(fixture);
    const editor = await redeem(fixture, 'editor', 'missing chunk editor');
    const bytes = deterministicBytes(4097, 41);
    const digest = sha256(bytes);
    const begin = await beginUpload(fixture, editor, {
      filename: 'missing-recorded-chunk.txt',
      mimeType: 'text/plain',
      size: bytes.length,
      sha256: digest,
      chunkSize: MiB,
      idempotencyKey: 'd5-missing-recorded-chunk-0001',
    });
    assert.equal(begin.response.status, 201, begin.text);
    const session = sessionData(begin.payload);
    const uploaded = await putChunk(fixture, editor, session, 0, bytes);
    assert.equal(uploaded.response.status, 200, uploaded.text);

    const recordedChunk = path.join(fixture.tempDir, session.id, 'chunk-00000000.part');
    assert.equal(fs.existsSync(recordedChunk), true);
    fs.unlinkSync(recordedChunk);

    const completed = await completeUpload(fixture, editor, session.id, digest);
    assert.equal(completed.response.status, 409, completed.text);
    assert.equal(completed.payload?.code, 'asset_upload_chunk_disk_missing');
    assert.match(String(completed.payload?.error || ''), /分片.*缺失.*重新开始/);
    assertNoHostPath(completed.payload || completed.text, fixture);

    const reread = await readUpload(fixture, editor, session.id);
    assert.equal(reread.response.status, 200, reread.text);
    const failedSession = sessionData(reread.payload);
    assert.equal(failedSession.status, 'failed');
    assert.equal(failedSession.errorCode, 'asset_upload_chunk_disk_missing');
    assert.match(String(failedSession.errorMessage || ''), /分片.*缺失.*重新开始/);
    assertNoHostPath(reread.payload || reread.text, fixture);
  } finally {
    await disposeFixture(fixture);
  }
});

test('whole-file hash mismatch fails closed without publishing an asset or a physical CAS blob', async () => {
  const fixture = createFixture();
  try {
    await startFixture(fixture);
    const editor = await redeem(fixture, 'editor', 'hash editor');
    const bytes = deterministicBytes(MiB + 17, 73);
    const actualDigest = sha256(bytes);
    const declaredDigest = sha256(Buffer.from('different complete file'));
    const begin = await beginUpload(fixture, editor, {
      filename: 'wrong-whole-hash.txt',
      mimeType: 'text/plain',
      size: bytes.length,
      sha256: declaredDigest,
      chunkSize: MiB,
      idempotencyKey: 'd5-whole-hash-0001',
    });
    assert.equal(begin.response.status, 201, begin.text);
    const session = sessionData(begin.payload);
    for (let index = 0; index < session.chunkCount; index += 1) {
      const uploaded = await putChunk(fixture, editor, session, index, chunkAt(bytes, session, index));
      assert.ok([200, 201].includes(uploaded.response.status), uploaded.text);
    }
    const completed = await completeUpload(fixture, editor, session.id, declaredDigest);
    assert.equal(completed.response.status, 422, completed.text);
    assert.match(String(completed.payload?.code || completed.payload?.error), /upload.*hash|hash.*mismatch|whole.*hash/i);
    assertNoHostPath(completed.payload || completed.text, fixture);
    assert.equal(filesWithHash(fixture.blobDir, actualDigest).length, 0);
    assert.equal(fixture.database.countAssets({ projectId: PROJECT_ID }), 0);
  } finally {
    await disposeFixture(fixture);
  }
});

test('cold startup removes completed, failed, and orphaned upload parts while preserving terminal records', async () => {
  const fixture = createFixture();
  let originalCleanup = null;
  let originalPurge = null;
  try {
    await startFixture(fixture);
    const editor = await redeem(fixture, 'editor', 'terminal cleanup editor');
    const manager = fixture.gateway.uploadManager;
    originalCleanup = manager._cleanupSessionFiles;
    originalPurge = fixture.database.purgeAssetUploadChunks;
    manager._cleanupSessionFiles = () => {};
    fixture.database.purgeAssetUploadChunks = () => 0;

    const completedBytes = deterministicBytes(32 * 1024 + 9, 57);
    const completedDigest = sha256(completedBytes);
    const completedBegin = await beginUpload(fixture, editor, {
      filename: 'terminal-completed.txt', mimeType: 'text/plain', size: completedBytes.length,
      sha256: completedDigest, chunkSize: MiB, idempotencyKey: 'f5-terminal-cleanup-completed',
    });
    const completedSession = sessionData(completedBegin.payload);
    assert.equal((await putChunk(fixture, editor, completedSession, 0, completedBytes)).response.status, 200);
    assert.equal((await completeUpload(fixture, editor, completedSession.id, completedDigest)).response.status, 201);

    const failedBytes = deterministicBytes(40 * 1024 + 13, 59);
    const failedDigest = sha256(Buffer.from('different terminal file'));
    const failedBegin = await beginUpload(fixture, editor, {
      filename: 'terminal-failed.txt', mimeType: 'text/plain', size: failedBytes.length,
      sha256: failedDigest, chunkSize: MiB, idempotencyKey: 'f5-terminal-cleanup-failed',
    });
    const failedSession = sessionData(failedBegin.payload);
    assert.equal((await putChunk(fixture, editor, failedSession, 0, failedBytes)).response.status, 200);
    assert.equal((await completeUpload(fixture, editor, failedSession.id, failedDigest)).response.status, 422);

    const orphanId = `asset-upload-${crypto.randomUUID()}`;
    const orphanDirectory = path.join(fixture.tempDir, orphanId);
    fs.mkdirSync(orphanDirectory, { recursive: true });
    fs.writeFileSync(path.join(orphanDirectory, 'chunk-00000000.part'), 'orphaned upload bytes');
    assert.equal(fixture.database.listAssetUploadChunks(completedSession.id).length, 1);
    assert.equal(fixture.database.listAssetUploadChunks(failedSession.id).length, 1);
    assert.equal(fs.existsSync(path.join(fixture.tempDir, completedSession.id)), true);
    assert.equal(fs.existsSync(path.join(fixture.tempDir, failedSession.id)), true);

    manager._cleanupSessionFiles = originalCleanup;
    fixture.database.purgeAssetUploadChunks = originalPurge;
    originalCleanup = null;
    originalPurge = null;
    await restartFixture(fixture, { autoBackup: false });

    assert.equal(fixture.database.getAssetUploadSession(completedSession.id).status, 'completed');
    assert.equal(fixture.database.getAssetUploadSession(failedSession.id).status, 'failed');
    assert.equal(fixture.database.listAssetUploadChunks(completedSession.id).length, 0);
    assert.equal(fixture.database.listAssetUploadChunks(failedSession.id).length, 0);
    assert.equal(fs.existsSync(orphanDirectory), false);
    assert.equal(walkFiles(fixture.tempDir).length, 0);
  } finally {
    if (originalCleanup && fixture.gateway?.uploadManager) fixture.gateway.uploadManager._cleanupSessionFiles = originalCleanup;
    if (originalPurge && fixture.database) fixture.database.purgeAssetUploadChunks = originalPurge;
    await disposeFixture(fixture);
  }
});

test('verified duplicate uploads create independent assets while reusing one physical CAS object', async () => {
  const fixture = createFixture();
  try {
    await startFixture(fixture);
    const firstEditor = await redeem(fixture, 'editor', 'first editor');
    const secondEditor = await redeem(fixture, 'editor', 'second editor');
    const bytes = deterministicBytes(2 * MiB + 101, 121);
    const digest = sha256(bytes);
    const first = await uploadWholeAsset(fixture, firstEditor, bytes, {
      filename: 'first-name.txt',
      idempotencyKey: 'd5-cas-first-0001',
    });
    const second = await uploadWholeAsset(fixture, secondEditor, bytes, {
      filename: 'second-name.txt',
      idempotencyKey: 'd5-cas-second-0001',
    });
    assert.notEqual(first.asset.id, second.asset.id, 'permissions and lineage require independent asset refs');
    assert.equal(first.asset.contentHash, digest);
    assert.equal(second.asset.contentHash, digest);
    assert.equal(Boolean(sessionData(second.begin.payload).deduplicated || second.complete.payload?.data?.deduplicated), true);
    assertNoHostPath(first.complete.payload, fixture);
    assertNoHostPath(second.complete.payload, fixture);

    const firstInternal = fixture.database.getAsset(first.asset.id);
    const secondInternal = fixture.database.getAsset(second.asset.id);
    assert.equal(firstInternal.managedPath, secondInternal.managedPath);
    assert.equal(filesWithHash(fixture.blobDir, digest).length, 1);
    assert.equal(fixture.database.db.prepare('SELECT COUNT(*) AS count FROM asset_blobs WHERE content_hash = ? AND storage_state = ?').get(digest, 'ready').count, 1);
    assert.equal(fixture.database.db.prepare(`
      SELECT COUNT(*) AS count FROM asset_blob_refs r
      JOIN asset_blobs b ON b.id = r.blob_id
      WHERE b.content_hash = ? AND r.verification_state = 'verified'
    `).get(digest).count, 2);
  } finally {
    await disposeFixture(fixture);
  }
});

test('project quota reservation is atomic across concurrent members and cancellation releases it', async () => {
  const fixture = createFixture({
    COLLAB_PROJECT_QUOTA_BYTES: 3 * MiB,
    COLLAB_MEMBER_QUOTA_BYTES: 16 * MiB,
  });
  try {
    await startFixture(fixture);
    const editorA = await redeem(fixture, 'editor', 'quota A');
    const editorB = await redeem(fixture, 'editor', 'quota B');
    const bytes = deterministicBytes(2 * MiB, 7);
    const request = (actor, key) => beginUpload(fixture, actor, {
      filename: `${key}.txt`, mimeType: 'text/plain', size: bytes.length, sha256: sha256(bytes),
      chunkSize: MiB, idempotencyKey: key,
    });
    const attempts = await Promise.all([
      request(editorA, 'd5-project-quota-a'),
      request(editorB, 'd5-project-quota-b'),
    ]);
    const accepted = attempts.filter((item) => item.response.status === 201);
    const rejected = attempts.filter((item) => item.response.status === 413);
    assert.equal(accepted.length, 1, attempts.map((item) => `${item.response.status}:${item.text}`).join('\n'));
    assert.equal(rejected.length, 1, attempts.map((item) => `${item.response.status}:${item.text}`).join('\n'));
    assert.match(String(rejected[0].payload?.code || rejected[0].payload?.error), /project.*quota|quota.*project/i);
    assertNoHostPath(rejected[0].payload || rejected[0].text, fixture);

    const winner = sessionData(accepted[0].payload);
    assert.equal(winner.reservedBytes, bytes.length);
    const winnerActor = attempts[0] === accepted[0] ? editorA : editorB;
    const cancelled = await cancelUpload(fixture, winnerActor, winner.id);
    assert.equal(cancelled.response.status, 200, cancelled.text);
    assert.equal(sessionData(cancelled.payload).status, 'cancelled');
    assert.equal(walkFiles(fixture.tempDir).length, 0);

    const afterCancel = await request(editorB, 'd5-project-quota-after-cancel');
    assert.equal(afterCancel.response.status, 201, afterCancel.text);
    await cancelUpload(fixture, editorB, sessionData(afterCancel.payload).id);
  } finally {
    await disposeFixture(fixture);
  }
});

test('member quota reservation is atomic and an idempotent begin request does not double reserve', async () => {
  const fixture = createFixture({
    COLLAB_PROJECT_QUOTA_BYTES: 16 * MiB,
    COLLAB_MEMBER_QUOTA_BYTES: 3 * MiB,
  });
  try {
    await startFixture(fixture);
    const editor = await redeem(fixture, 'editor', 'member quota');
    const bytes = deterministicBytes(2 * MiB, 43);
    const input = {
      filename: 'member-quota.txt', mimeType: 'text/plain', size: bytes.length, sha256: sha256(bytes),
      chunkSize: MiB, idempotencyKey: 'd5-member-quota-idempotent',
    };
    const first = await beginUpload(fixture, editor, input);
    assert.equal(first.response.status, 201, first.text);
    const replay = await beginUpload(fixture, editor, input);
    assert.equal(replay.response.status, 200, replay.text);
    assert.equal(sessionData(replay.payload).id, sessionData(first.payload).id);
    assert.equal(sessionData(replay.payload).reservedBytes, bytes.length);

    const competing = await beginUpload(fixture, editor, { ...input, filename: 'competing.txt', idempotencyKey: 'd5-member-quota-competing' });
    assert.equal(competing.response.status, 413, competing.text);
    assert.match(String(competing.payload?.code || competing.payload?.error), /member.*quota|quota.*member/i);
    await cancelUpload(fixture, editor, sessionData(first.payload).id);
  } finally {
    await disposeFixture(fixture);
  }
});

test('same-session chunk replay is idempotent and a different replay conflicts without replacing durable bytes', async () => {
  const fixture = createFixture();
  try {
    await startFixture(fixture);
    const editor = await redeem(fixture, 'editor', 'chunk replay editor');
    const bytes = deterministicBytes(64 * 1024 + 19, 67);
    const digest = sha256(bytes);
    const begin = await beginUpload(fixture, editor, {
      filename: 'chunk-replay.txt',
      mimeType: 'text/plain',
      size: bytes.length,
      sha256: digest,
      chunkSize: MiB,
      idempotencyKey: 'f5-chunk-replay-0001',
    });
    assert.equal(begin.response.status, 201, begin.text);
    const session = sessionData(begin.payload);
    const exact = await Promise.all([
      putChunk(fixture, editor, session, 0, bytes),
      putChunk(fixture, editor, session, 0, bytes),
    ]);
    assert.deepEqual(exact.map((item) => item.response.status), [200, 200]);
    assert.equal(fixture.database.db.prepare('SELECT COUNT(*) AS count FROM asset_upload_chunks WHERE session_id = ?').get(session.id).count, 1);
    assert.equal(fixture.database.getAssetUploadSession(session.id).receivedBytes, bytes.length);

    const different = Buffer.from(bytes);
    different[0] = different[0] === 33 ? 34 : 33;
    const conflict = await putChunk(fixture, editor, session, 0, different);
    assert.equal(conflict.response.status, 409, conflict.text);
    assert.equal(conflict.payload?.code, 'asset_upload_chunk_conflict');
    assert.deepEqual(fs.readFileSync(path.join(fixture.tempDir, session.id, 'chunk-00000000.part')), bytes);
    assert.equal(fixture.database.listAssetUploadChunks(session.id)[0].contentHash, digest);
    assertNoHostPath(conflict.payload || conflict.text, fixture);
  } finally {
    await disposeFixture(fixture);
  }
});

test('concurrent exact completion commits once, replays once, and immediately grants the asset to the canvas', async () => {
  const fixture = createFixture();
  try {
    await startFixture(fixture);
    const editor = await redeem(fixture, 'editor', 'complete replay editor');
    const bytes = Buffer.alloc(96 * 1024 + 7, 65);
    const digest = sha256(bytes);
    const begin = await beginUpload(fixture, editor, {
      filename: 'complete-replay.txt',
      mimeType: 'text/plain',
      size: bytes.length,
      sha256: digest,
      chunkSize: MiB,
      idempotencyKey: 'f5-complete-replay-0001',
    });
    assert.equal(begin.response.status, 201, begin.text);
    const session = sessionData(begin.payload);
    const chunk = await putChunk(fixture, editor, session, 0, bytes);
    assert.equal(chunk.response.status, 200, chunk.text);

    const completed = await Promise.all([
      completeUpload(fixture, editor, session.id, digest),
      completeUpload(fixture, editor, session.id, digest),
    ]);
    assert.deepEqual(completed.map((item) => item.response.status).sort(), [200, 201]);
    const created = completed.find((item) => item.response.status === 201);
    const replay = completed.find((item) => item.response.status === 200);
    assert.equal(replay.payload?.data?.idempotentReplay, true);
    assert.equal(created.payload?.data?.idempotentReplay, false);
    assert.ok(created.payload?.data?.asset?.id);
    assert.equal(replay.payload?.data?.asset?.id, created.payload.data.asset.id);
    const assetId = created.payload.data.asset.id;
    assert.equal(fixture.database.db.prepare('SELECT COUNT(*) AS count FROM assets WHERE id = ?').get(assetId).count, 1);
    assert.equal(fixture.database.db.prepare('SELECT COUNT(*) AS count FROM asset_lineage_events WHERE asset_id = ?').get(assetId).count, 1);
    assert.equal(filesWithHash(fixture.blobDir, digest).length, 1);
    assert.equal(fixture.database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_resource_grants
      WHERE project_id = ? AND canvas_id = ? AND resource_type = 'asset' AND resource_id = ?
    `).get(PROJECT_ID, 'canvas-d5', assetId).count, 1);

    const list = await responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets`, { headers: { cookie: editor.cookie } }));
    assert.equal(list.response.status, 200, list.text);
    assert.equal(list.payload?.data?.some((asset) => asset.id === assetId), true);
    const detail = await responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/${encodeURIComponent(assetId)}`, { headers: { cookie: editor.cookie } }));
    assert.equal(detail.response.status, 200, detail.text);
    assert.equal(detail.payload?.data?.sourceUrl, null, 'text without a derived preview must not advertise preview bytes');
    assert.equal(Object.hasOwn(detail.payload?.data?.representations || {}, 'preview'), false);
    assertNoHostPath(completed.map((item) => item.payload), fixture);
  } finally {
    await disposeFixture(fixture);
  }
});

test('distinct sessions completing identical content concurrently keep independent assets on one physical CAS object', async () => {
  const fixture = createFixture();
  try {
    await startFixture(fixture);
    const editorA = await redeem(fixture, 'editor', 'parallel CAS A');
    const editorB = await redeem(fixture, 'editor', 'parallel CAS B');
    const bytes = Buffer.alloc(80 * 1024 + 13, 66);
    const digest = sha256(bytes);
    const prepare = async (actor, filename, idempotencyKey) => {
      const begin = await beginUpload(fixture, actor, {
        filename, mimeType: 'text/plain', size: bytes.length, sha256: digest,
        chunkSize: MiB, idempotencyKey,
      });
      assert.equal(begin.response.status, 201, begin.text);
      const session = sessionData(begin.payload);
      const chunk = await putChunk(fixture, actor, session, 0, bytes);
      assert.equal(chunk.response.status, 200, chunk.text);
      return session;
    };
    const [sessionA, sessionB] = await Promise.all([
      prepare(editorA, 'parallel-a.txt', 'f5-parallel-cas-a'),
      prepare(editorB, 'parallel-b.txt', 'f5-parallel-cas-b'),
    ]);
    const [completeA, completeB] = await Promise.all([
      completeUpload(fixture, editorA, sessionA.id, digest),
      completeUpload(fixture, editorB, sessionB.id, digest),
    ]);
    assert.equal(completeA.response.status, 201, completeA.text);
    assert.equal(completeB.response.status, 201, completeB.text);
    const assetA = completeA.payload?.data?.asset;
    const assetB = completeB.payload?.data?.asset;
    assert.ok(assetA?.id && assetB?.id);
    assert.notEqual(assetA.id, assetB.id);
    assert.equal(assetA.contentHash, digest);
    assert.equal(assetB.contentHash, digest);
    assert.equal(filesWithHash(fixture.blobDir, digest).length, 1);
    assert.equal(fixture.database.db.prepare('SELECT COUNT(*) AS count FROM asset_blobs WHERE content_hash = ?').get(digest).count, 1);
    assert.equal(fixture.database.db.prepare(`
      SELECT COUNT(*) AS count FROM asset_blob_refs r
      JOIN asset_blobs b ON b.id = r.blob_id
      WHERE b.content_hash = ? AND r.verification_state = 'verified'
    `).get(digest).count, 2);
  } finally {
    await disposeFixture(fixture);
  }
});

test('concurrent exact image completion enqueues derived preview work only once', async () => {
  const fixture = createFixture();
  try {
    await startFixture(fixture);
    let enqueueCalls = 0;
    fixture.gateway.previewPipeline = {
      enqueueAsset() {
        enqueueCalls += 1;
        return { status: 'queued' };
      },
    };
    const editor = await redeem(fixture, 'editor', 'preview replay editor');
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#336699' },
    }).png().toBuffer();
    const digest = sha256(bytes);
    const begin = await beginUpload(fixture, editor, {
      filename: 'preview-replay.png', mimeType: 'image/png', size: bytes.length, sha256: digest,
      chunkSize: MiB, idempotencyKey: 'f5-preview-replay-0001',
    });
    const session = sessionData(begin.payload);
    assert.equal((await putChunk(fixture, editor, session, 0, bytes)).response.status, 200);
    const responses = await Promise.all([
      completeUpload(fixture, editor, session.id, digest),
      completeUpload(fixture, editor, session.id, digest),
    ]);
    assert.deepEqual(responses.map((item) => item.response.status).sort(), [200, 201]);
    assert.equal(enqueueCalls, 1);
    const assetId = responses[0].payload?.data?.asset?.id;
    assert.equal(fixture.database.getAsset(assetId).metadata.previewStatus, 'queued');
  } finally {
    await disposeFixture(fixture);
  }
});

test('live post-commit finalization revalidates session, authorization epoch, and upload capability before grant refresh or preview publish', async (t) => {
  const scenarios = [
    {
      name: 'revoked authentication session',
      mutate(fixture, editor, hook) {
        const revoked = fixture.gateway.auth.revoke(hook.authenticationSessionId, {
          actorId: 'local-owner',
          sessionId: 'local-management',
          expectedProjectId: PROJECT_ID,
          expectedCanvasId: 'canvas-d5',
        });
        assert.ok(revoked);
      },
    },
    {
      name: 'changed authorization epoch with upload capability retained',
      mutate(fixture, editor) {
        const updated = fixture.gateway.auth.updateMember(editor.member.memberId, { role: 'editor' }, {
          actorId: 'local-owner',
          sessionId: 'local-management',
          expectedProjectId: PROJECT_ID,
          expectedCanvasId: 'canvas-d5',
        });
        assert.ok(updated);
        assert.equal(updated.capabilities.includes('uploadAsset'), true);
      },
    },
    {
      name: 'upload capability removed without borrowing the unchanged epoch',
      mutate(fixture, editor) {
        const before = fixture.database.db.prepare(`
          SELECT updated_at FROM collaboration_members WHERE id = ?
        `).get(editor.member.memberId);
        assert.ok(before);
        assert.equal(fixture.database.db.prepare(`
          UPDATE collaboration_members SET capabilities_json = ? WHERE id = ?
        `).run(JSON.stringify(['editGraph']), editor.member.memberId).changes, 1);
        const after = fixture.database.db.prepare(`
          SELECT updated_at, capabilities_json FROM collaboration_members WHERE id = ?
        `).get(editor.member.memberId);
        assert.equal(after.updated_at, before.updated_at, 'capability-only fixture must preserve the epoch');
        assert.deepEqual(JSON.parse(after.capabilities_json), ['editGraph']);
      },
    },
  ];

  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    await t.test(scenario.name, async () => {
      const fixture = createFixture();
      let originalGrant = null;
      try {
        await startFixture(fixture);
        const editor = await redeem(fixture, 'editor', `post-commit auth ${scenarioIndex}`);
        const bytes = await sharp({
          create: {
            width: 3,
            height: 3,
            channels: 3,
            background: scenarioIndex === 0 ? '#335577' : (scenarioIndex === 1 ? '#557733' : '#773355'),
          },
        }).png().toBuffer();
        const digest = sha256(bytes);
        const begin = await beginUpload(fixture, editor, {
          filename: `post-commit-auth-${scenarioIndex}.png`,
          mimeType: 'image/png',
          size: bytes.length,
          sha256: digest,
          chunkSize: MiB,
          idempotencyKey: `f5-post-commit-auth-${scenarioIndex}-0001`,
        });
        assert.equal(begin.response.status, 201, begin.text);
        const session = sessionData(begin.payload);
        assert.equal((await putChunk(fixture, editor, session, 0, bytes)).response.status, 200);

        let hookCalls = 0;
        let postCommitGrantCalls = 0;
        let previewEnqueueCalls = 0;
        let grantAtHook = null;
        originalGrant = fixture.database.grantCanvasAssetResource;
        fixture.database.grantCanvasAssetResource = function (...args) {
          postCommitGrantCalls += 1;
          return originalGrant.apply(this, args);
        };
        fixture.gateway.previewPipeline = {
          enqueueAsset() {
            previewEnqueueCalls += 1;
            throw new Error('stale live finalization must not enqueue preview work');
          },
        };
        fixture.gateway.uploadManager.beforeLiveFinalizationGrant = (hook) => {
          hookCalls += 1;
          assert.equal(hook.uploadSessionId, session.id);
          assert.equal(hook.memberId, editor.member.memberId);
          const committed = fixture.database.getAssetUploadSession(session.id);
          assert.equal(committed.status, 'completed', 'hook must run after the durable asset/session commit');
          assert.equal(committed.assetId, hook.assetId);
          assert.equal(fixture.database.getAsset(hook.assetId).metadata.uploadFinalization, 'pending');
          assert.equal(fixture.database.listAssetPreviewJobs({ assetId: hook.assetId }).length, 0);
          grantAtHook = fixture.database.db.prepare(`
            SELECT source, created_at, updated_at
            FROM canvas_resource_grants
            WHERE project_id = ? AND canvas_id = ?
              AND resource_type = 'asset' AND resource_id = ? AND resource_version = 0
          `).get(PROJECT_ID, 'canvas-d5', hook.assetId);
          assert.ok(grantAtHook, 'the authorization-checked atomic commit is the durable grant claim');
          scenario.mutate(fixture, editor, hook);
        };

        const completed = await completeUpload(fixture, editor, session.id, digest);
        assert.equal(completed.response.status, 409, completed.text);
        assert.equal(completed.payload?.code, 'asset_upload_authorization_changed');
        assert.equal(hookCalls, 1);
        assert.equal(postCommitGrantCalls, 0, 'stale authorization must stop before post-commit grant refresh');
        assert.equal(previewEnqueueCalls, 0, 'stale authorization must stop before preview publication');
        const durable = fixture.database.getAssetUploadSession(session.id);
        assert.equal(durable.status, 'completed');
        const finalGrant = fixture.database.db.prepare(`
          SELECT source, created_at, updated_at
          FROM canvas_resource_grants
          WHERE project_id = ? AND canvas_id = ?
            AND resource_type = 'asset' AND resource_id = ? AND resource_version = 0
        `).get(PROJECT_ID, 'canvas-d5', durable.assetId);
        assert.deepEqual(finalGrant, grantAtHook, 'revocation must not create or refresh a grant after the hook');
        const asset = fixture.database.getAsset(durable.assetId);
        assert.equal(asset.metadata.uploadFinalization, 'pending');
        assert.equal(asset.metadata.previewStatus, 'pending');
        assert.equal(fixture.database.listAssetPreviewJobs({ assetId: durable.assetId }).length, 0);
        assertNoHostPath(completed.payload || completed.text, fixture);
      } finally {
        if (originalGrant && fixture.database) fixture.database.grantCanvasAssetResource = originalGrant;
        await disposeFixture(fixture);
      }
    });
  }
});

test('post-commit race hook is inert outside node:test even after direct instance mutation', async () => {
  const fixture = createFixture();
  const hadNodeTestContext = Object.prototype.hasOwnProperty.call(process.env, 'NODE_TEST_CONTEXT');
  const nodeTestContext = process.env.NODE_TEST_CONTEXT;
  try {
    await startFixture(fixture);
    let calls = 0;
    fixture.gateway.uploadManager.beforeLiveFinalizationGrant = () => { calls += 1; };
    delete process.env.NODE_TEST_CONTEXT;
    fixture.gateway.uploadManager._runBeforeLiveFinalizationGrantHook(
      { id: 'production-hook-probe', sourceKind: 'collaboration' },
      { id: 'production-hook-asset', metadata: { uploadFinalization: 'pending' } },
      {},
    );
    assert.equal(calls, 0);
  } finally {
    if (hadNodeTestContext) process.env.NODE_TEST_CONTEXT = nodeTestContext;
    else delete process.env.NODE_TEST_CONTEXT;
    await disposeFixture(fixture);
  }
});

test('startup and completed replay recover interrupted post-commit preview finalization exactly once', async () => {
  const fixture = createFixture();
  let originalFinalize = null;
  let patchedManager = null;
  try {
    await startFixture(fixture);
    let enqueueCalls = 0;
    const previewPipeline = {
      enqueueAsset(asset) {
        enqueueCalls += 1;
        return fixture.database.enqueueAssetPreviewJob({
          assetId: asset.id,
          contentHash: asset.contentHash,
          jobKind: 'image-preview',
          pipelineVersion: 'f5-upload-finalization-test-v1',
          maxAttempts: 3,
        });
      },
    };
    fixture.gateway.previewPipeline = previewPipeline;
    const editor = await redeem(fixture, 'editor', 'finalization recovery editor');
    const bytes = await sharp({
      create: { width: 3, height: 2, channels: 3, background: '#224466' },
    }).png().toBuffer();
    const digest = sha256(bytes);
    const begin = await beginUpload(fixture, editor, {
      filename: 'finalization-recovery.png', mimeType: 'image/png', size: bytes.length,
      sha256: digest, chunkSize: MiB, idempotencyKey: 'f5-finalization-recovery-0001',
    });
    const session = sessionData(begin.payload);
    assert.equal((await putChunk(fixture, editor, session, 0, bytes)).response.status, 200);

    patchedManager = fixture.gateway.uploadManager;
    originalFinalize = patchedManager._finalizeCompletedAsset;
    patchedManager._finalizeCompletedAsset = () => {
      const error = new Error('simulated process interruption after atomic commit');
      error.code = 'asset_upload_finalization_interrupted';
      error.status = 503;
      throw error;
    };
    const interrupted = await completeUpload(fixture, editor, session.id, digest);
    assert.equal(interrupted.response.status, 503, interrupted.text);
    assert.equal(interrupted.payload?.code, 'asset_upload_finalization_interrupted');
    const committedSession = fixture.database.getAssetUploadSession(session.id);
    assert.equal(committedSession.status, 'completed');
    const assetId = committedSession.assetId;
    const pendingAsset = fixture.database.getAsset(assetId);
    assert.equal(pendingAsset.metadata.uploadFinalization, 'pending');
    assert.equal(pendingAsset.metadata.previewStatus, 'pending');
    assert.equal(fixture.database.listAssetPreviewJobs({ assetId }).length, 0);
    assert.equal(enqueueCalls, 0);
    assert.equal(fixture.database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_resource_grants
      WHERE project_id = ? AND canvas_id = ? AND resource_type = 'asset' AND resource_id = ?
    `).get(PROJECT_ID, 'canvas-d5', assetId).count, 1, 'lineage commit grants the canvas atomically');

    patchedManager._finalizeCompletedAsset = originalFinalize;
    originalFinalize = null;
    await fixture.gateway.stop();
    await fixture.database.close();
    fixture.database = new ProjectDatabase(fixture.dbFile);
    const recoveredManager = new AssetUploadManager(fixture.config, fixture.database, { previewPipeline });
    assert.ok(recoveredManager);

    const recoveredAsset = fixture.database.getAsset(assetId);
    assert.equal(recoveredAsset.metadata.uploadFinalization, 'completed');
    assert.equal(recoveredAsset.metadata.previewStatus, 'queued');
    assert.equal(fixture.database.listAssetPreviewJobs({ assetId }).length, 1);
    assert.equal(enqueueCalls, 1);
    assert.equal(fixture.database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_resource_grants
      WHERE project_id = ? AND canvas_id = ? AND resource_type = 'asset' AND resource_id = ?
    `).get(PROJECT_ID, 'canvas-d5', assetId).count, 1);

    fixture.gateway = new CollaborationGateway(fixture.config, fixture.database);
    fixture.gateway.previewPipeline = previewPipeline;
    const status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
    fixture.baseUrl = `http://127.0.0.1:${status.port}`;
    const replay = await completeUpload(fixture, editor, session.id, digest);
    assert.equal(replay.response.status, 200, replay.text);
    assert.equal(replay.payload?.data?.idempotentReplay, true);
    assert.equal(Object.hasOwn(replay.payload?.data?.asset?.metadata || {}, 'uploadFinalization'), false);
    assert.equal(Object.hasOwn(replay.payload?.data?.asset?.metadata || {}, 'uploadAuthorization'), false);
    const secondReplay = await completeUpload(fixture, editor, session.id, digest);
    assert.equal(secondReplay.response.status, 200, secondReplay.text);
    assert.equal(fixture.database.listAssetPreviewJobs({ assetId }).length, 1);
    assert.equal(enqueueCalls, 1);
  } finally {
    if (originalFinalize && patchedManager) patchedManager._finalizeCompletedAsset = originalFinalize;
    await disposeFixture(fixture);
  }
});

test('startup reconciles already-granted verified previews after epoch rotation without expanding grants', async () => {
  const fixture = createFixture();
  let originalFinalize = null;
  let patchedManager = null;
  try {
    await startFixture(fixture);
    const editor = await redeem(fixture, 'editor', 'stale finalization editor');
    patchedManager = fixture.gateway.uploadManager;
    originalFinalize = patchedManager._finalizeCompletedAsset;
    patchedManager._finalizeCompletedAsset = () => {
      const error = new Error('simulated process interruption after atomic commit');
      error.code = 'asset_upload_finalization_interrupted';
      error.status = 503;
      throw error;
    };
    const preparePending = async (label, color) => {
      const bytes = await sharp({
        create: { width: 4, height: 3, channels: 3, background: color },
      }).png().toBuffer();
      const digest = sha256(bytes);
      const begin = await beginUpload(fixture, editor, {
        filename: `stale-finalization-${label}.png`,
        mimeType: 'image/png',
        size: bytes.length,
        sha256: digest,
        chunkSize: MiB,
        idempotencyKey: `f5-stale-finalization-${label}-0001`,
      });
      assert.equal(begin.response.status, 201, begin.text);
      const session = sessionData(begin.payload);
      assert.equal((await putChunk(fixture, editor, session, 0, bytes)).response.status, 200);
      const interrupted = await completeUpload(fixture, editor, session.id, digest);
      assert.equal(interrupted.response.status, 503, interrupted.text);
      const committed = fixture.database.getAssetUploadSession(session.id);
      assert.equal(committed.status, 'completed');
      assert.equal(fixture.database.getAsset(committed.assetId).metadata.uploadFinalization, 'pending');
      return committed;
    };
    const queuedCommit = await preparePending('queued', '#335577');
    const failedCommit = await preparePending('failed', '#773355');

    const updated = fixture.gateway.auth.updateMember(editor.member.memberId, { role: 'editor' }, {
      actorId: 'local-owner',
      sessionId: 'local-management',
      expectedProjectId: PROJECT_ID,
      expectedCanvasId: 'canvas-d5',
    });
    assert.ok(updated);
    patchedManager._finalizeCompletedAsset = originalFinalize;
    originalFinalize = null;
    await fixture.gateway.stop();
    await fixture.database.close();
    fixture.database = new ProjectDatabase(fixture.dbFile, { autoBackup: false });
    let startupGrantCalls = 0;
    const reopenedGrant = fixture.database.grantCanvasAssetResource;
    fixture.database.grantCanvasAssetResource = function (...args) {
      startupGrantCalls += 1;
      return reopenedGrant.apply(this, args);
    };
    const enqueueCalls = new Map();
    const previewPipeline = {
      enqueueAsset(asset) {
        enqueueCalls.set(asset.id, (enqueueCalls.get(asset.id) || 0) + 1);
        if (asset.id === failedCommit.assetId) throw new Error('simulated preview enqueue failure');
        return fixture.database.enqueueAssetPreviewJob({
          assetId: asset.id,
          contentHash: asset.contentHash,
          jobKind: 'image-preview',
          pipelineVersion: 'f5-stale-epoch-reconcile-v1',
          maxAttempts: 3,
        });
      },
    };
    const recoveredManager = new AssetUploadManager(fixture.config, fixture.database, { previewPipeline });
    assert.ok(recoveredManager);

    const queuedAsset = fixture.database.getAsset(queuedCommit.assetId);
    const failedAsset = fixture.database.getAsset(failedCommit.assetId);
    assert.equal(queuedAsset.metadata.uploadFinalization, 'completed');
    assert.equal(queuedAsset.metadata.previewStatus, 'queued');
    assert.equal(fixture.database.listAssetPreviewJobs({ assetId: queuedCommit.assetId }).length, 1);
    assert.equal(failedAsset.metadata.uploadFinalization, 'failed');
    assert.equal(failedAsset.metadata.previewStatus, 'failed');
    assert.equal(fixture.database.listAssetPreviewJobs({ assetId: failedCommit.assetId }).length, 0);
    assert.equal(enqueueCalls.get(queuedCommit.assetId), 1);
    assert.equal(enqueueCalls.get(failedCommit.assetId), 1);
    assert.equal(startupGrantCalls, 0);
    for (const committed of [queuedCommit, failedCommit]) {
      assert.equal(fixture.database.db.prepare(`
        SELECT COUNT(*) AS count FROM canvas_resource_grants
        WHERE project_id = ? AND canvas_id = ? AND resource_type = 'asset' AND resource_id = ?
      `).get(PROJECT_ID, 'canvas-d5', committed.assetId).count, 1);
    }

    const secondRecovery = new AssetUploadManager(fixture.config, fixture.database, { previewPipeline });
    assert.ok(secondRecovery);
    assert.equal(enqueueCalls.get(queuedCommit.assetId), 1);
    assert.equal(enqueueCalls.get(failedCommit.assetId), 1);
    assert.equal(startupGrantCalls, 0);
    fixture.database.grantCanvasAssetResource = reopenedGrant;
  } finally {
    if (originalFinalize && patchedManager) patchedManager._finalizeCompletedAsset = originalFinalize;
    await disposeFixture(fixture);
  }
});

test('startup preview reconcile rejects missing grants and forged upload-session provenance', async () => {
  const fixture = createFixture();
  let originalFinalize = null;
  let patchedManager = null;
  try {
    await startFixture(fixture);
    const editor = await redeem(fixture, 'editor', 'forged finalization editor');
    patchedManager = fixture.gateway.uploadManager;
    originalFinalize = patchedManager._finalizeCompletedAsset;
    patchedManager._finalizeCompletedAsset = () => {
      const error = new Error('simulated process interruption after atomic commit');
      error.code = 'asset_upload_finalization_interrupted';
      error.status = 503;
      throw error;
    };
    const bytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#446688' },
    }).png().toBuffer();
    const digest = sha256(bytes);
    const begin = await beginUpload(fixture, editor, {
      filename: 'forged-finalization.png',
      mimeType: 'image/png',
      size: bytes.length,
      sha256: digest,
      chunkSize: MiB,
      idempotencyKey: 'f5-forged-finalization-0001',
    });
    const session = sessionData(begin.payload);
    assert.equal((await putChunk(fixture, editor, session, 0, bytes)).response.status, 200);
    const interrupted = await completeUpload(fixture, editor, session.id, digest);
    assert.equal(interrupted.response.status, 503, interrupted.text);
    const committed = fixture.database.getAssetUploadSession(session.id);
    assert.equal(committed.status, 'completed');
    assert.equal(fixture.database.getAsset(committed.assetId).metadata.uploadFinalization, 'pending');

    const updated = fixture.gateway.auth.updateMember(editor.member.memberId, { role: 'editor' }, {
      actorId: 'local-owner',
      sessionId: 'local-management',
      expectedProjectId: PROJECT_ID,
      expectedCanvasId: 'canvas-d5',
    });
    assert.ok(updated);
    patchedManager._finalizeCompletedAsset = originalFinalize;
    originalFinalize = null;
    await fixture.gateway.stop();
    await fixture.database.close();
    fixture.database = new ProjectDatabase(fixture.dbFile, { autoBackup: false });

    const grant = fixture.database.db.prepare(`
      SELECT * FROM canvas_resource_grants
      WHERE project_id = ? AND canvas_id = ? AND resource_type = 'asset' AND resource_id = ?
      LIMIT 1
    `).get(PROJECT_ID, 'canvas-d5', committed.assetId);
    assert.ok(grant);
    fixture.database.db.prepare(`
      DELETE FROM canvas_resource_grants
      WHERE project_id = ? AND canvas_id = ? AND resource_type = 'asset' AND resource_id = ?
    `).run(PROJECT_ID, 'canvas-d5', committed.assetId);
    let enqueueCalls = 0;
    let grantCalls = 0;
    const originalGrant = fixture.database.grantCanvasAssetResource;
    fixture.database.grantCanvasAssetResource = function (...args) {
      grantCalls += 1;
      return originalGrant.apply(this, args);
    };
    const previewPipeline = {
      enqueueAsset(asset) {
        enqueueCalls += 1;
        return fixture.database.enqueueAssetPreviewJob({
          assetId: asset.id,
          contentHash: asset.contentHash,
          jobKind: 'image-preview',
          pipelineVersion: 'f5-forged-reconcile-v1',
          maxAttempts: 3,
        });
      },
    };
    const missingGrantRecovery = new AssetUploadManager(fixture.config, fixture.database, { previewPipeline });
    assert.ok(missingGrantRecovery);
    assert.equal(enqueueCalls, 0);
    assert.equal(grantCalls, 0);
    assert.equal(fixture.database.getAsset(committed.assetId).metadata.uploadFinalization, 'pending');
    assert.equal(fixture.database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_resource_grants
      WHERE project_id = ? AND canvas_id = ? AND resource_type = 'asset' AND resource_id = ?
    `).get(PROJECT_ID, 'canvas-d5', committed.assetId).count, 0);

    fixture.database.db.prepare(`
      INSERT INTO canvas_resource_grants(
        project_id, canvas_id, resource_type, resource_id, resource_version, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      grant.project_id,
      grant.canvas_id,
      grant.resource_type,
      grant.resource_id,
      grant.resource_version,
      grant.source,
      grant.created_at,
      grant.updated_at,
    );
    const assetRow = fixture.database.db.prepare('SELECT provenance_json FROM assets WHERE id = ?').get(committed.assetId);
    const forgedProvenance = JSON.parse(assetRow.provenance_json);
    forgedProvenance.uploadSessionId = 'asset-upload-forged-session-provenance';
    fixture.database.db.prepare('UPDATE assets SET provenance_json = ? WHERE id = ?')
      .run(JSON.stringify(forgedProvenance), committed.assetId);
    const forgedRecovery = new AssetUploadManager(fixture.config, fixture.database, { previewPipeline });
    assert.ok(forgedRecovery);
    assert.equal(enqueueCalls, 0);
    assert.equal(grantCalls, 0);
    assert.equal(fixture.database.getAsset(committed.assetId).metadata.uploadFinalization, 'pending');
    assert.equal(fixture.database.listAssetPreviewJobs({ assetId: committed.assetId }).length, 0);
    fixture.database.grantCanvasAssetResource = originalGrant;
  } finally {
    if (originalFinalize && patchedManager) patchedManager._finalizeCompletedAsset = originalFinalize;
    await disposeFixture(fixture);
  }
});

test('corrupt collaboration models remain indexed through resumable upload without entering the preview queue', async () => {
  const fixture = createFixture();
  try {
    await startFixture(fixture);
    let enqueueCalls = 0;
    fixture.gateway.previewPipeline = {
      enqueueAsset() {
        enqueueCalls += 1;
        throw new Error('corrupt assets must not enqueue');
      },
    };
    const editor = await redeem(fixture, 'editor', 'corrupt resumable editor');
    const bytes = Buffer.from('#'.repeat(1_048_577));
    const uploaded = await uploadWholeAsset(fixture, editor, bytes, {
      filename: 'oversized-line.obj',
      mimeType: 'model/obj',
      idempotencyKey: 'f5-corrupt-model-resumable-0001',
    });
    assert.equal(uploaded.asset.availability, 'corrupt');
    assert.equal(uploaded.asset.metadata.health, 'corrupt');
    assert.equal(uploaded.asset.metadata.previewStatus, 'failed');
    assert.equal(Object.hasOwn(uploaded.asset.metadata, 'uploadFinalization'), false);
    assert.equal(enqueueCalls, 0);
    assert.equal(fixture.database.listAssetPreviewJobs({ assetId: uploaded.asset.id }).length, 0);
    assert.equal(fixture.database.getAsset(uploaded.asset.id).metadata.uploadFinalization, 'completed');
  } finally {
    await disposeFixture(fixture);
  }
});

test('completion serializes later pause and cancel without deleting the committed asset or CAS bytes', async () => {
  const fixture = createFixture();
  let originalInstall = null;
  let releaseInstall;
  try {
    await startFixture(fixture);
    const editor = await redeem(fixture, 'editor', 'lifecycle race editor');
    const bytes = deterministicBytes(48 * 1024 + 5, 91);
    const digest = sha256(bytes);
    const begin = await beginUpload(fixture, editor, {
      filename: 'lifecycle-race.txt', mimeType: 'text/plain', size: bytes.length, sha256: digest,
      chunkSize: MiB, idempotencyKey: 'f5-lifecycle-race-0001',
    });
    const session = sessionData(begin.payload);
    assert.equal((await putChunk(fixture, editor, session, 0, bytes)).response.status, 200);

    const enteredInstall = new Promise((resolve) => {
      const blobStore = fixture.gateway.uploadManager.blobStore;
      originalInstall = blobStore.installVerifiedFile.bind(blobStore);
      blobStore.installVerifiedFile = async (...args) => {
        resolve();
        await new Promise((release) => { releaseInstall = release; });
        return originalInstall(...args);
      };
    });
    const completionPromise = completeUpload(fixture, editor, session.id, digest);
    await enteredInstall;
    const pausePromise = postUploadAction(fixture, editor, session.id, 'pause');
    const cancelPromise = cancelUpload(fixture, editor, session.id);
    await new Promise((resolve) => setImmediate(resolve));
    releaseInstall();
    const [completion, paused, cancelled] = await Promise.all([completionPromise, pausePromise, cancelPromise]);
    assert.equal(completion.response.status, 201, completion.text);
    assert.equal(paused.response.status, 409, paused.text);
    assert.equal(cancelled.response.status, 409, cancelled.text);
    assert.equal(fixture.database.getAssetUploadSession(session.id).status, 'completed');
    assert.ok(fixture.database.getAsset(completion.payload?.data?.asset?.id));
    assert.equal(filesWithHash(fixture.blobDir, digest).length, 1);
    assert.equal(walkFiles(fixture.tempDir).length, 0);
    assert.equal(fixture.database.db.prepare('SELECT COUNT(*) AS count FROM asset_upload_chunks WHERE session_id = ?').get(session.id).count, 0);
  } finally {
    if (originalInstall && fixture.gateway?.uploadManager?.blobStore) {
      fixture.gateway.uploadManager.blobStore.installVerifiedFile = originalInstall;
    }
    if (releaseInstall) releaseInstall();
    await disposeFixture(fixture);
  }
});

test('authorization revocation cancels an assembling upload before its delayed CAS commit can publish', async () => {
  const fixture = createFixture();
  let originalInstall = null;
  let releaseInstall = null;
  try {
    await startFixture(fixture);
    const editor = await redeem(fixture, 'editor', 'revocation race editor');
    const bytes = deterministicBytes(56 * 1024 + 17, 101);
    const digest = sha256(bytes);
    const begin = await beginUpload(fixture, editor, {
      filename: 'revocation-race.txt', mimeType: 'text/plain', size: bytes.length, sha256: digest,
      chunkSize: MiB, idempotencyKey: 'f5-revocation-race-0001',
    });
    const session = sessionData(begin.payload);
    assert.equal((await putChunk(fixture, editor, session, 0, bytes)).response.status, 200);

    const enteredInstall = new Promise((resolve) => {
      const blobStore = fixture.gateway.uploadManager.blobStore;
      originalInstall = blobStore.installVerifiedFile.bind(blobStore);
      blobStore.installVerifiedFile = async (...args) => {
        resolve();
        await new Promise((release) => { releaseInstall = release; });
        return originalInstall(...args);
      };
    });
    const completionPromise = completeUpload(fixture, editor, session.id, digest);
    await enteredInstall;
    assert.equal(fixture.database.getAssetUploadSession(session.id).status, 'assembling');

    const updated = fixture.gateway.auth.updateMember(editor.member.memberId, { role: 'editor' }, {
      actorId: 'local-owner',
      sessionId: 'local-management',
      expectedProjectId: PROJECT_ID,
      expectedCanvasId: 'canvas-d5',
    });
    assert.ok(updated);
    fixture.gateway.closeMemberConnections(editor.member.memberId, 'member role changed');
    assert.equal(fixture.database.getAssetUploadSession(session.id).status, 'cancelled');

    releaseInstall();
    releaseInstall = null;
    const completion = await completionPromise;
    assert.equal(completion.response.status, 409, completion.text);
    assert.equal(completion.payload?.code, 'asset_upload_state_conflict');
    assert.equal(fixture.database.getAssetUploadSession(session.id).status, 'cancelled');
    assert.equal(fixture.database.getAssetUploadSession(session.id).assetId, null);
    assert.equal(fixture.database.db.prepare(`
      SELECT COUNT(*) AS count FROM assets
      WHERE json_extract(provenance_json, '$.uploadSessionId') = ?
    `).get(session.id).count, 0);
    assert.equal(filesWithHash(fixture.blobDir, digest).length, 0);
    await eventually(() => {
      assert.equal(fixture.database.listAssetUploadChunks(session.id).length, 0);
      assert.equal(fs.existsSync(path.join(fixture.tempDir, session.id)), false);
    });
  } finally {
    if (originalInstall && fixture.gateway?.uploadManager?.blobStore) {
      fixture.gateway.uploadManager.blobStore.installVerifiedFile = originalInstall;
    }
    if (releaseInstall) releaseInstall();
    await disposeFixture(fixture);
  }
});

test('session rotation cancels durable upload state and a new cookie cannot adopt the old scoped session', async () => {
  const fixture = createFixture();
  try {
    await startFixture(fixture);
    const editor = await redeem(fixture, 'editor', 'rotation editor');
    const bytes = deterministicBytes(MiB + 17, 103);
    const digest = sha256(bytes);
    const input = {
      filename: 'rotate-scope.txt', mimeType: 'text/plain', size: bytes.length, sha256: digest,
      chunkSize: MiB, idempotencyKey: 'f5-rotate-scope-0001',
    };
    const begin = await beginUpload(fixture, editor, input);
    assert.equal(begin.response.status, 201, begin.text);
    const session = sessionData(begin.payload);
    assert.equal((await putChunk(fixture, editor, session, 0, chunkAt(bytes, session, 0))).response.status, 200);

    const rotated = await rotateSession(fixture, editor);
    assert.equal(rotated.response.status, 200, rotated.text);
    assert.ok(rotated.actor.cookie);
    assert.equal((await readUpload(fixture, editor, session.id)).response.status, 401);
    const crossScope = await readUpload(fixture, rotated.actor, session.id);
    assert.equal(crossScope.response.status, 404, crossScope.text);
    assert.equal(crossScope.payload?.code, 'asset_upload_session_scope_mismatch');
    assert.equal(fixture.database.getAssetUploadSession(session.id).status, 'cancelled');
    assert.equal(fixture.database.listAssetUploadChunks(session.id).length, 0);
    assert.equal(walkFiles(fixture.tempDir).length, 0);
    const quota = fixture.database.getAssetUploadQuotaStatus(PROJECT_ID, editor.member.memberId, {
      projectLimit: fixture.config.COLLAB_PROJECT_QUOTA_BYTES,
      memberLimit: fixture.config.COLLAB_MEMBER_QUOTA_BYTES,
    });
    assert.equal(quota.project.reservedBytes, 0);
    assert.equal(quota.member.reservedBytes, 0);

    const fresh = await beginUpload(fixture, rotated.actor, input);
    assert.equal(fresh.response.status, 201, fresh.text);
    assert.notEqual(sessionData(fresh.payload).id, session.id);
    await cancelUpload(fixture, rotated.actor, sessionData(fresh.payload).id);
  } finally {
    await disposeFixture(fixture);
  }
});

test('authorization epoch changes isolate and asynchronously cancel uploads owned by the old member grant', async () => {
  const fixture = createFixture();
  try {
    await startFixture(fixture);
    const editor = await redeem(fixture, 'editor', 'epoch editor');
    const bytes = deterministicBytes(72 * 1024 + 11, 107);
    const input = {
      filename: 'epoch-scope.txt', mimeType: 'text/plain', size: bytes.length, sha256: sha256(bytes),
      chunkSize: MiB, idempotencyKey: 'f5-epoch-scope-0001',
    };
    const begin = await beginUpload(fixture, editor, input);
    const session = sessionData(begin.payload);
    assert.equal((await putChunk(fixture, editor, session, 0, bytes)).response.status, 200);
    const updated = fixture.gateway.auth.updateMember(editor.member.memberId, { role: 'editor' }, {
      actorId: 'local-owner',
      sessionId: 'local-management',
      expectedProjectId: PROJECT_ID,
      expectedCanvasId: 'canvas-d5',
    });
    assert.ok(updated);
    fixture.gateway.closeMemberConnections(editor.member.memberId, 'member role changed');
    await eventually(() => assert.equal(fixture.database.getAssetUploadSession(session.id).status, 'cancelled'));

    const oldScope = await readUpload(fixture, editor, session.id);
    assert.equal(oldScope.response.status, 404, oldScope.text);
    assert.equal(oldScope.payload?.code, 'asset_upload_session_scope_mismatch');
    assert.equal(fixture.database.listAssetUploadChunks(session.id).length, 0);
    assert.equal(walkFiles(fixture.tempDir).length, 0);
    const fresh = await beginUpload(fixture, editor, input);
    assert.equal(fresh.response.status, 201, fresh.text);
    assert.notEqual(sessionData(fresh.payload).id, session.id);
    await cancelUpload(fixture, editor, sessionData(fresh.payload).id);
  } finally {
    await disposeFixture(fixture);
  }
});

test('expired upload sweep releases quota and removes confirmed chunk files', async () => {
  const fixture = createFixture();
  try {
    await startFixture(fixture);
    const editor = await redeem(fixture, 'editor', 'expiry editor');
    const bytes = deterministicBytes(128 * 1024 + 3, 109);
    const begin = await beginUpload(fixture, editor, {
      filename: 'expiry.txt', mimeType: 'text/plain', size: bytes.length, sha256: sha256(bytes),
      chunkSize: MiB, idempotencyKey: 'f5-expiry-0001',
    });
    const session = sessionData(begin.payload);
    assert.equal((await putChunk(fixture, editor, session, 0, bytes)).response.status, 200);
    fixture.database.db.prepare('UPDATE asset_upload_sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, session.id);

    const policy = await responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/uploads/policy`, { headers: { cookie: editor.cookie } }));
    assert.equal(policy.response.status, 200, policy.text);
    assert.equal(fixture.database.getAssetUploadSession(session.id).status, 'expired');
    assert.equal(fixture.database.listAssetUploadChunks(session.id).length, 0);
    assert.equal(walkFiles(fixture.tempDir).length, 0);
    assert.equal(policy.payload?.data?.quota?.project?.reservedBytes, 0);
    assert.equal(policy.payload?.data?.quota?.member?.reservedBytes, 0);
    assertNoHostPath(policy.payload, fixture);
  } finally {
    await disposeFixture(fixture);
  }
});

test('expired sweep cleans unlocked session A while locked session B remains untouched', async () => {
  const fixture = createFixture();
  let releaseLock = null;
  let lockedOperation = null;
  try {
    await startFixture(fixture);
    const editor = await redeem(fixture, 'editor', 'per-session expiry lock editor');
    const prepare = async (suffix, seed) => {
      const bytes = deterministicBytes(64 * 1024 + seed, seed);
      const begin = await beginUpload(fixture, editor, {
        filename: `expiry-lock-${suffix}.txt`,
        mimeType: 'text/plain',
        size: bytes.length,
        sha256: sha256(bytes),
        chunkSize: MiB,
        idempotencyKey: `f5-expiry-lock-${suffix}-0001`,
      });
      assert.equal(begin.response.status, 201, begin.text);
      const session = sessionData(begin.payload);
      assert.equal((await putChunk(fixture, editor, session, 0, bytes)).response.status, 200);
      return session;
    };
    const sessionA = await prepare('a', 113);
    const sessionB = await prepare('b', 127);
    fixture.database.db.prepare(`
      UPDATE asset_upload_sessions SET expires_at = ? WHERE id IN (?, ?)
    `).run(Date.now() - 1, sessionA.id, sessionB.id);

    let lockEnteredResolve;
    const lockEntered = new Promise((resolve) => { lockEnteredResolve = resolve; });
    const holdLock = new Promise((resolve) => { releaseLock = resolve; });
    const manager = fixture.gateway.uploadManager;
    lockedOperation = manager._withLock(manager._sessionLockKey(sessionB.id), async () => {
      lockEnteredResolve();
      await holdLock;
    });
    await lockEntered;

    const expired = manager.sweepExpired(Date.now());
    assert.deepEqual(expired, [sessionA.id]);
    assert.equal(fixture.database.getAssetUploadSession(sessionA.id).status, 'expired');
    assert.equal(fixture.database.listAssetUploadChunks(sessionA.id).length, 0);
    assert.equal(fs.existsSync(path.join(fixture.tempDir, sessionA.id)), false);
    assert.equal(fixture.database.getAssetUploadSession(sessionB.id).status, 'uploading');
    assert.equal(fixture.database.listAssetUploadChunks(sessionB.id).length, 1);
    assert.equal(fs.existsSync(path.join(fixture.tempDir, sessionB.id, 'chunk-00000000.part')), true);

    releaseLock();
    releaseLock = null;
    await lockedOperation;
    lockedOperation = null;
  } finally {
    releaseLock?.();
    try { await lockedOperation; } catch (_) {}
    await disposeFixture(fixture);
  }
});

test('collaboration media serves the proxy by default and requires both original ACL and role capability for original bytes', async () => {
  const fixture = createFixture();
  try {
    await startFixture(fixture);
    const original = Buffer.from('ORIGINAL-PRIVATE-VIDEO-BYTES');
    const proxy = Buffer.from('PROXY-VIDEO-BYTES');
    const thumbnail = Buffer.from('THUMBNAIL-JPEG-BYTES');
    const digest = sha256(original);
    const originalPath = path.join(fixture.blobDir, digest.slice(0, 2), digest);
    const proxyPath = path.join(fixture.previews, 'acl-proxy.mp4');
    const thumbnailPath = path.join(fixture.previews, 'acl-thumbnail.jpg');
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.writeFileSync(originalPath, original);
    fs.writeFileSync(proxyPath, proxy);
    fs.writeFileSync(thumbnailPath, thumbnail);
    const asset = fixture.database.upsertAsset({
      id: 'asset-d5-proxy-original',
      projectId: PROJECT_ID,
      contentHash: digest,
      contentHashVerification: 'verified',
      kind: 'video',
      mimeType: 'video/mp4',
      filename: 'private-original.mp4',
      managedPath: originalPath,
      sourceUrl: '/api/collab/assets/asset-d5-proxy-original/media',
      storageMode: 'managed',
      availability: 'available',
      metadata: {
        size: original.length,
        proxyUrl: '/files/thumbnails/asset-previews/acl-proxy.mp4',
        thumbnailUrl: '/files/thumbnails/asset-previews/acl-thumbnail.jpg',
      },
      createdBy: 'local-owner',
    });
    fixture.database.recordAssetLineageEvent({
      assetId: asset.id,
      canvasId: 'canvas-d5',
      sourceType: 'test-fixture',
      creatorId: 'local-owner',
    });
    fixture.database.db.prepare(`
      UPDATE asset_blobs SET storage_key = ?, storage_state = 'ready', verified_at = ? WHERE content_hash = ?
    `).run(path.relative(fixture.blobDir, originalPath).replace(/\\/g, '/'), Date.now(), digest);

    const viewer = await redeem(fixture, 'viewer', 'preview viewer');
    const reviewer = await redeem(fixture, 'reviewer', 'original reviewer');
    const viewerWithOriginalGrant = await redeem(fixture, 'viewer', 'no capability viewer');
    fixture.database.setAssetAccessPolicy(PROJECT_ID, asset.id, {
      scope: 'restricted',
      grants: [
        { principalType: 'member', principalId: viewer.member.memberId, permissions: ['view', 'preview'] },
        { principalType: 'role', principalId: 'reviewer', permissions: ['view', 'preview', 'original'] },
        { principalType: 'member', principalId: viewerWithOriginalGrant.member.memberId, permissions: ['view', 'original'] },
      ],
    }, { actorId: 'local-owner' });

    const detail = await responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/${asset.id}`, { headers: { cookie: viewer.cookie } }));
    assert.equal(detail.response.status, 200, detail.text);
    assertNoHostPath(detail.payload, fixture);

    const inline = await responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/${asset.id}/media`, { headers: { cookie: viewer.cookie } }));
    assert.equal(inline.response.status, 200, inline.text);
    assert.equal(inline.response.headers.get('content-length'), String(proxy.length));
    assert.match(inline.response.headers.get('content-disposition'), /^inline;/);
    assert.deepEqual(Buffer.from(inline.text), proxy);

    const proxyRange = await responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/${asset.id}/media`, {
      headers: { cookie: viewer.cookie, range: 'bytes=2-6' },
    }));
    assert.equal(proxyRange.response.status, 206, proxyRange.text);
    assert.equal(proxyRange.response.headers.get('content-range'), `bytes 2-6/${proxy.length}`);
    assert.deepEqual(Buffer.from(proxyRange.text), proxy.subarray(2, 7));

    const thumbnailResponse = await responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/${asset.id}/media?representation=thumbnail`, {
      headers: { cookie: viewer.cookie },
    }));
    assert.equal(thumbnailResponse.response.status, 200, thumbnailResponse.text);
    assert.deepEqual(Buffer.from(thumbnailResponse.text), thumbnail);

    const thumbnailHead = await responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/${asset.id}/media?representation=thumbnail`, {
      method: 'HEAD',
      headers: { cookie: viewer.cookie, range: 'bytes=1-5' },
    }));
    assert.equal(thumbnailHead.response.status, 206, thumbnailHead.text);
    assert.equal(thumbnailHead.response.headers.get('content-range'), `bytes 1-5/${thumbnail.length}`);
    assert.equal(thumbnailHead.response.headers.get('content-length'), '5');
    assert.equal(thumbnailHead.text, '');

    const viewerOriginalDenied = await responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/${asset.id}/media?download=1`, {
      headers: { cookie: viewer.cookie },
    }));
    assert.equal(viewerOriginalDenied.response.status, 404);
    assertNoHostPath(viewerOriginalDenied.text, fixture);

    const capabilityDenied = await responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/${asset.id}/media?download=1`, {
      headers: { cookie: viewerWithOriginalGrant.cookie },
    }));
    assert.equal(capabilityDenied.response.status, 403);
    assertNoHostPath(capabilityDenied.text, fixture);

    const originalDownload = await responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/${asset.id}/media?download=1`, {
      headers: { cookie: reviewer.cookie },
    }));
    assert.equal(originalDownload.response.status, 200, originalDownload.text);
    assert.equal(originalDownload.response.headers.get('content-length'), String(original.length));
    assert.match(originalDownload.response.headers.get('content-disposition'), /^attachment;/);
    assert.deepEqual(Buffer.from(originalDownload.text), original);

    const originalRange = await responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/${asset.id}/media?download=1`, {
      headers: { cookie: reviewer.cookie, range: 'bytes=9-15' },
    }));
    assert.equal(originalRange.response.status, 206, originalRange.text);
    assert.equal(originalRange.response.headers.get('content-range'), `bytes 9-15/${original.length}`);
    assert.deepEqual(Buffer.from(originalRange.text), original.subarray(9, 16));

    const invalidRange = await responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/${asset.id}/media`, {
      headers: { cookie: viewer.cookie, range: 'bytes=999-' },
    }));
    assert.equal(invalidRange.response.status, 416);
    assert.equal(invalidRange.response.headers.get('content-range'), `bytes */${proxy.length}`);
    assertNoHostPath(invalidRange.text, fixture);
  } finally {
    await disposeFixture(fixture);
  }
});
