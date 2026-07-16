const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');
const {
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

async function restartFixture(fixture) {
  await fixture.gateway.stop();
  fixture.database.close();
  fixture.database = new ProjectDatabase(fixture.dbFile);
  fixture.gateway = new CollaborationGateway(fixture.config, fixture.database);
  const status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  fixture.baseUrl = `http://127.0.0.1:${status.port}`;
  return fixture;
}

async function disposeFixture(fixture) {
  try { await fixture.gateway?.stop(); } catch (_) {}
  try { fixture.database?.close(); } catch (_) {}
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
  };
}

async function beginUpload(fixture, actor, input) {
  return responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/uploads`, {
    method: 'POST',
    headers: { cookie: actor.cookie, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

async function putChunk(fixture, actor, session, index, bytes, options = {}) {
  const start = options.start ?? index * session.chunkSize;
  const end = options.end ?? start + bytes.length - 1;
  const total = options.total ?? session.expectedSize ?? session.size;
  return responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/uploads/${encodeURIComponent(session.id)}/chunks/${index}`, {
    method: 'PUT',
    headers: {
      cookie: actor.cookie,
      'content-type': 'application/octet-stream',
      'content-range': options.contentRange || `bytes ${start}-${end}/${total}`,
      'x-chunk-sha256': options.chunkHash || sha256(bytes),
    },
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
    headers: { cookie: actor.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sha256: digest }),
  }));
}

async function cancelUpload(fixture, actor, uploadId) {
  return responseBody(await fetch(`${fixture.baseUrl}/api/collab/assets/uploads/${encodeURIComponent(uploadId)}`, {
    method: 'DELETE',
    headers: { cookie: actor.cookie },
  }));
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
  assert.equal(PROJECT_DATABASE_SCHEMA_VERSION, 23);
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

test('collaboration media serves the proxy by default and requires both original ACL and role capability for original bytes', async () => {
  const fixture = createFixture();
  try {
    await startFixture(fixture);
    const original = Buffer.from('ORIGINAL-PRIVATE-VIDEO-BYTES');
    const proxy = Buffer.from('PROXY-VIDEO-BYTES');
    const digest = sha256(original);
    const originalPath = path.join(fixture.blobDir, digest.slice(0, 2), digest);
    const proxyPath = path.join(fixture.previews, 'acl-proxy.mp4');
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.writeFileSync(originalPath, original);
    fs.writeFileSync(proxyPath, proxy);
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
