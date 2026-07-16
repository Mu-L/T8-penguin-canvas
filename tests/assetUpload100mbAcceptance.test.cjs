const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const { CollaborationGateway } = require('../backend/src/collaboration/gateway');
const { resolveBundledFfmpeg, resolveBundledFfprobe } = require('../backend/src/providers/llmMedia');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'asset-upload-100mb-acceptance';
const MiB = 1024 * 1024;
const TARGET_BYTES = 101 * MiB + 123;
const CHUNK_BYTES = 8 * MiB;

function memoryTracker() {
  const baseline = process.memoryUsage();
  const peak = { ...baseline };
  return {
    baseline,
    peak,
    sample() {
      const current = process.memoryUsage();
      for (const key of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']) {
        peak[key] = Math.max(Number(peak[key]) || 0, Number(current[key]) || 0);
      }
    },
  };
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(filename);
      else if (entry.isFile()) output.push(filename);
    }
  }
  return output.sort();
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function sha256File(filename) {
  const digest = crypto.createHash('sha256');
  for await (const block of fs.createReadStream(filename)) digest.update(block);
  return digest.digest('hex');
}

function probeVideo(filename, ffprobe) {
  const output = execFileSync(ffprobe, [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', filename,
  ], { encoding: 'utf8', maxBuffer: 4 * MiB, timeout: 120_000, windowsHide: true });
  const probe = JSON.parse(output);
  const video = (Array.isArray(probe.streams) ? probe.streams : []).find((stream) => stream.codec_type === 'video');
  assert.ok(video, `ffprobe found no video stream in ${path.basename(filename)}`);
  assert.match(String(probe.format?.format_name || ''), /(?:mov|mp4)/i);
  assert.equal(Number(probe.format?.duration) > 0, true);
  return {
    codec: video.codec_name,
    width: Number(video.width),
    height: Number(video.height),
    duration: Number(probe.format.duration),
    streamCount: probe.streams.length,
    formatName: probe.format.format_name,
  };
}

function writeAllSync(fd, buffer, length = buffer.length) {
  let offset = 0;
  while (offset < length) {
    const written = fs.writeSync(fd, buffer, offset, length - offset);
    if (!written) throw new Error('file write made no progress');
    offset += written;
  }
}

function readLeadingBytes(filename, length) {
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filename, 'r');
  try {
    assert.equal(fs.readSync(fd, buffer, 0, buffer.length, 0), buffer.length);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

function generateLargeValidMp4(filename) {
  const ffmpeg = resolveBundledFfmpeg();
  const ffprobe = resolveBundledFfprobe();
  assert.equal(fs.existsSync(ffmpeg), true, `bundled ffmpeg missing: ${ffmpeg}`);
  assert.equal(fs.existsSync(ffprobe), true, `bundled ffprobe missing: ${ffprobe}`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });

  let startedAt = performance.now();
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-y', filename,
  ], { stdio: 'pipe', timeout: 120_000, windowsHide: true });
  const ffmpegGenerateMs = performance.now() - startedAt;

  startedAt = performance.now();
  const before = probeVideo(filename, ffprobe);
  const initialProbeMs = performance.now() - startedAt;
  const initialBytes = fs.statSync(filename).size;
  const freeBoxBytes = TARGET_BYTES - initialBytes;
  assert.equal(freeBoxBytes >= 8 && freeBoxBytes <= 0xffffffff, true);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(freeBoxBytes, 0);
  header.write('free', 4, 'ascii');
  const payload = Buffer.alloc(MiB, 0x5a);
  const fd = fs.openSync(filename, 'a');
  startedAt = performance.now();
  try {
    writeAllSync(fd, header);
    let remaining = freeBoxBytes - header.length;
    while (remaining > 0) {
      const length = Math.min(payload.length, remaining);
      writeAllSync(fd, payload, length);
      remaining -= length;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const freeBoxWriteMs = performance.now() - startedAt;
  assert.equal(fs.statSync(filename).size, TARGET_BYTES);

  startedAt = performance.now();
  const after = probeVideo(filename, ffprobe);
  const expandedProbeMs = performance.now() - startedAt;
  assert.deepEqual(after, before, 'a top-level MP4 free box must not change the playable stream');
  return { ffmpeg, ffprobe, before, ffmpegGenerateMs, initialProbeMs, freeBoxWriteMs, expandedProbeMs, initialBytes };
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-upload-100mb-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  const thumbnails = path.join(root, 'thumbnails');
  const previews = path.join(thumbnails, 'asset-previews');
  const blobDir = path.join(root, 'asset-blobs');
  const tempDir = path.join(root, 'upload-parts');
  const dataDir = path.join(root, 'data');
  const dbFile = path.join(dataDir, 'projects.sqlite3');
  const sourceFile = path.join(root, 'source', 'valid-101mb.mp4');
  for (const directory of [input, output, thumbnails, previews, blobDir, tempDir, dataDir, path.dirname(sourceFile)]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const config = {
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    COLLAB_ALLOWED_ORIGINS: [],
    COLLAB_PROJECT_QUOTA_BYTES: 512 * MiB,
    COLLAB_MEMBER_QUOTA_BYTES: 512 * MiB,
    COLLAB_UPLOAD_CHUNK_BYTES: CHUNK_BYTES,
    COLLAB_MAX_UPLOAD_BYTES: 256 * MiB,
    COLLAB_UPLOAD_SESSION_TTL_MS: 60 * 60 * 1000,
    DATA_DIR: dataDir,
    INPUT_DIR: input,
    OUTPUT_DIR: output,
    THUMBNAILS_DIR: thumbnails,
    ASSET_PREVIEWS_DIR: previews,
    ASSET_BLOB_DIR: blobDir,
    COLLAB_UPLOAD_TEMP_DIR: tempDir,
    FRONTEND_DIST: '',
  };
  const database = new ProjectDatabase(dbFile, { autoBackup: false });
  database.ensureCanvas(
    'canvas-100mb',
    { name: '100MB upload acceptance', nodes: [], edges: [] },
    PROJECT_ID,
  );
  return { root, input, output, blobDir, tempDir, dataDir, dbFile, sourceFile, config, database, gateway: null, baseUrl: '' };
}

async function startFixture(fixture) {
  fixture.gateway = new CollaborationGateway(fixture.config, fixture.database);
  const status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  assert.notEqual(status.port, 11_422);
  assert.notEqual(status.port, 18_766);
  fixture.baseUrl = `http://127.0.0.1:${status.port}`;
  return status;
}

async function coldRestartFixture(fixture) {
  await fixture.gateway.stop();
  fixture.gateway = null;
  fixture.database.close();
  fixture.database = new ProjectDatabase(fixture.dbFile, { autoBackup: false });
  return startFixture(fixture);
}

async function disposeFixture(fixture) {
  try { await fixture.gateway?.stop(); } catch (_) {}
  try { fixture.database?.close(); } catch (_) {}
  fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function jsonResponse(response) {
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = null; }
  return { response, payload, text };
}

function assertPathless(value, fixture) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const candidate of [fixture.root, fixture.root.replace(/\\/g, '/'), fixture.blobDir, fixture.tempDir]) {
    assert.equal(text.toLowerCase().includes(String(candidate).toLowerCase()), false, `host path leaked: ${candidate}`);
  }
  assert.doesNotMatch(text, /(?:managed|absolute|temporary|temp|blob)(?:_|-)?path/i);
}

async function redeemEditor(fixture) {
  const invite = fixture.gateway.auth.createInvite({
    projectId: PROJECT_ID,
    canvasId: 'canvas-100mb',
    role: 'editor',
    maxUses: 1,
  });
  const result = await jsonResponse(await fetch(`${fixture.baseUrl}/api/collab/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, displayName: '100MB acceptance editor' }),
  }));
  assert.equal(result.response.status, 200, result.text);
  return { cookie: result.response.headers.get('set-cookie').split(';')[0], member: result.payload.data };
}

async function readSlice(handle, start, length) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, start + offset);
    if (!result.bytesRead) throw new Error(`source ended at ${start + offset}`);
    offset += result.bytesRead;
  }
  return buffer;
}

async function putChunk(fixture, actor, sourceHandle, session, index, memory) {
  const start = index * session.chunkSize;
  const length = Math.min(session.chunkSize, session.expectedSize - start);
  const bytes = await readSlice(sourceHandle, start, length);
  memory.sample();
  const result = await jsonResponse(await fetch(
    `${fixture.baseUrl}/api/collab/assets/uploads/${encodeURIComponent(session.id)}/chunks/${index}`,
    {
      method: 'PUT',
      headers: {
        cookie: actor.cookie,
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${start + length - 1}/${session.expectedSize}`,
        'x-chunk-sha256': sha256Buffer(bytes),
      },
      body: bytes,
    },
  ));
  memory.sample();
  assert.equal(result.response.status, 200, result.text);
  assertPathless(result.payload, fixture);
  return { ...result, length };
}

async function getUpload(fixture, actor, sessionId) {
  return jsonResponse(await fetch(`${fixture.baseUrl}/api/collab/assets/uploads/${encodeURIComponent(sessionId)}`, {
    headers: { cookie: actor.cookie },
  }));
}

async function assertOriginalRange(fixture, actor, assetId, sourceHandle, totalBytes, start, end) {
  const response = await fetch(`${fixture.baseUrl}/api/collab/assets/${encodeURIComponent(assetId)}/media?download=1`, {
    headers: { cookie: actor.cookie, range: `bytes=${start}-${end}` },
  });
  const actual = Buffer.from(await response.arrayBuffer());
  const expected = await readSlice(sourceHandle, start, end - start + 1);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${totalBytes}`);
  assert.equal(response.headers.get('content-length'), String(end - start + 1));
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(actual, expected);
  return actual;
}

test('a ffprobe-valid 100MB+ MP4 resumes after a cold restart, commits by full SHA-256, and serves original start/middle/tail ranges', { timeout: 300_000 }, async (t) => {
  const totalStartedAt = performance.now();
  const fixture = createFixture();
  const memory = memoryTracker();
  let sourceHandle;
  try {
    const generation = generateLargeValidMp4(fixture.sourceFile);
    memory.sample();
    assert.equal(fs.statSync(fixture.sourceFile).size, TARGET_BYTES);
    const leadingBytes = readLeadingBytes(fixture.sourceFile, 12);
    assert.equal(leadingBytes.subarray(4, 8).toString('ascii'), 'ftyp');

    let startedAt = performance.now();
    const digest = await sha256File(fixture.sourceFile);
    const sourceHashMs = performance.now() - startedAt;
    assert.match(digest, /^[a-f0-9]{64}$/);
    memory.sample();

    await startFixture(fixture);
    const editor = await redeemEditor(fixture);
    const begin = await jsonResponse(await fetch(`${fixture.baseUrl}/api/collab/assets/uploads`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'valid-101mb.mp4',
        mimeType: 'video/mp4',
        size: TARGET_BYTES,
        sha256: digest,
        chunkSize: CHUNK_BYTES,
        idempotencyKey: 'd5-100mb-acceptance-0001',
      }),
    }));
    assert.equal(begin.response.status, 201, begin.text);
    const session = begin.payload.data;
    assert.equal(session.expectedSize, TARGET_BYTES);
    assert.equal(session.chunkSize, CHUNK_BYTES);
    assert.equal(session.chunkCount, Math.ceil(TARGET_BYTES / CHUNK_BYTES));
    assertPathless(begin.payload, fixture);

    sourceHandle = await fs.promises.open(fixture.sourceFile, 'r');
    const interruptedIndices = [0, Math.floor(session.chunkCount / 2), session.chunkCount - 1];
    startedAt = performance.now();
    let interruptedBytes = 0;
    for (const index of interruptedIndices) interruptedBytes += (await putChunk(fixture, editor, sourceHandle, session, index, memory)).length;
    const interruptedUploadMs = performance.now() - startedAt;

    const beforeRestart = await getUpload(fixture, editor, session.id);
    assert.equal(beforeRestart.response.status, 200, beforeRestart.text);
    assert.deepEqual(beforeRestart.payload.data.receivedChunks, [...interruptedIndices].sort((a, b) => a - b));
    assert.equal(beforeRestart.payload.data.receivedBytes, interruptedBytes);
    assert.equal(walkFiles(fixture.tempDir).length, interruptedIndices.length);
    assertPathless(beforeRestart.payload, fixture);

    startedAt = performance.now();
    await coldRestartFixture(fixture);
    const coldRestartMs = performance.now() - startedAt;
    const resumedStatus = await getUpload(fixture, editor, session.id);
    assert.equal(resumedStatus.response.status, 200, resumedStatus.text);
    assert.deepEqual(resumedStatus.payload.data.receivedChunks, [...interruptedIndices].sort((a, b) => a - b));
    assert.equal(resumedStatus.payload.data.receivedBytes, interruptedBytes);
    assertPathless(resumedStatus.payload, fixture);

    const idempotentRetry = await putChunk(fixture, editor, sourceHandle, session, interruptedIndices[0], memory);
    assert.equal(idempotentRetry.payload.data.receivedBytes, interruptedBytes);
    const missing = resumedStatus.payload.data.missingChunks;
    startedAt = performance.now();
    for (const index of missing) await putChunk(fixture, editor, sourceHandle, session, index, memory);
    const resumedUploadMs = performance.now() - startedAt;
    const ready = await getUpload(fixture, editor, session.id);
    assert.equal(ready.payload.data.receivedBytes, TARGET_BYTES);
    assert.deepEqual(ready.payload.data.missingChunks, []);

    startedAt = performance.now();
    const completed = await jsonResponse(await fetch(
      `${fixture.baseUrl}/api/collab/assets/uploads/${encodeURIComponent(session.id)}/complete`,
      {
        method: 'POST',
        headers: { cookie: editor.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ sha256: digest }),
      },
    ));
    const completeMs = performance.now() - startedAt;
    assert.equal(completed.response.status, 201, completed.text);
    assert.equal(completed.payload.data.session.status, 'completed');
    assert.equal(completed.payload.data.asset.contentHash, digest);
    assert.equal(completed.payload.data.asset.kind, 'video');
    assert.equal(completed.payload.data.asset.mimeType, 'video/mp4');
    assert.equal(completed.payload.data.asset.availability, 'available');
    assert.equal(completed.payload.data.deduplicated, false);
    assert.equal(completed.payload.data.quota.project.reservedBytes, 0);
    assert.equal(completed.payload.data.quota.member.reservedBytes, 0);
    assertPathless(completed.payload, fixture);

    const assetId = completed.payload.data.asset.id;
    const internal = fixture.database.getAsset(assetId);
    assert.ok(internal?.managedPath);
    assert.equal(completed.payload.data.asset.effectivePermissions.original, true, JSON.stringify(completed.payload.data.asset.effectivePermissions));
    const currentSession = fixture.gateway.auth.authenticate(decodeURIComponent(editor.cookie.slice(editor.cookie.indexOf('=') + 1)));
    assert.equal(fixture.gateway.canSessionAccessAsset(currentSession, internal, 'original'), true);
    assert.ok(fixture.gateway._resolveAssetRepresentation(internal, 'original', true), 'CAS original must resolve under its configured private root');
    assert.equal(fs.statSync(internal.managedPath).size, TARGET_BYTES);
    const relativeToBlobRoot = path.relative(fs.realpathSync.native(fixture.blobDir), fs.realpathSync.native(internal.managedPath));
    assert.ok(relativeToBlobRoot && relativeToBlobRoot !== '..' && !relativeToBlobRoot.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToBlobRoot));
    assert.equal(walkFiles(fixture.blobDir).length, 1);
    assert.equal(walkFiles(fixture.tempDir).length, 0);
    assert.equal(fixture.database.getAssetBlob(digest).storageState, 'ready');

    startedAt = performance.now();
    assert.equal(await sha256File(internal.managedPath), digest);
    const casHashMs = performance.now() - startedAt;
    startedAt = performance.now();
    const casProbe = probeVideo(internal.managedPath, generation.ffprobe);
    const casProbeMs = performance.now() - startedAt;
    assert.deepEqual(casProbe, generation.before);

    const rangeSize = 4096;
    const middleStart = Math.floor(TARGET_BYTES / 2);
    const tailStart = TARGET_BYTES - rangeSize;
    startedAt = performance.now();
    const rangeStart = await assertOriginalRange(fixture, editor, assetId, sourceHandle, TARGET_BYTES, 0, rangeSize - 1);
    const rangeMiddle = await assertOriginalRange(fixture, editor, assetId, sourceHandle, TARGET_BYTES, middleStart, middleStart + rangeSize - 1);
    const rangeTail = await assertOriginalRange(fixture, editor, assetId, sourceHandle, TARGET_BYTES, tailStart, TARGET_BYTES - 1);
    const rangeReadMs = performance.now() - startedAt;
    assert.equal(rangeStart.subarray(4, 8).toString('ascii'), 'ftyp');
    assert.equal(rangeMiddle.every((byte) => byte === 0x5a), true);
    assert.equal(rangeTail.every((byte) => byte === 0x5a), true);
    memory.sample();

    const peakRssDelta = memory.peak.rss - memory.baseline.rss;
    const peakHeapDelta = memory.peak.heapUsed - memory.baseline.heapUsed;
    assert.equal(peakRssDelta < 512 * MiB, true, `100MB upload RSS grew by ${(peakRssDelta / MiB).toFixed(1)} MiB`);
    const totalElapsedMs = performance.now() - totalStartedAt;
    t.diagnostic(JSON.stringify({
      sourceBytes: TARGET_BYTES,
      sourceMiB: Number((TARGET_BYTES / MiB).toFixed(3)),
      chunkBytes: CHUNK_BYTES,
      chunkCount: session.chunkCount,
      interruptedChunks: interruptedIndices,
      ffmpegGenerateMs: Number(generation.ffmpegGenerateMs.toFixed(1)),
      initialProbeMs: Number(generation.initialProbeMs.toFixed(1)),
      freeBoxWriteMs: Number(generation.freeBoxWriteMs.toFixed(1)),
      expandedProbeMs: Number(generation.expandedProbeMs.toFixed(1)),
      sourceHashMs: Number(sourceHashMs.toFixed(1)),
      interruptedUploadMs: Number(interruptedUploadMs.toFixed(1)),
      coldRestartMs: Number(coldRestartMs.toFixed(1)),
      resumedUploadMs: Number(resumedUploadMs.toFixed(1)),
      completeMs: Number(completeMs.toFixed(1)),
      casHashMs: Number(casHashMs.toFixed(1)),
      casProbeMs: Number(casProbeMs.toFixed(1)),
      rangeReadMs: Number(rangeReadMs.toFixed(1)),
      totalElapsedMs: Number(totalElapsedMs.toFixed(1)),
      uploadThroughputMiBPerSecond: Number((TARGET_BYTES / MiB / ((interruptedUploadMs + resumedUploadMs) / 1000)).toFixed(1)),
      peakRssMiB: Number((memory.peak.rss / MiB).toFixed(1)),
      peakRssDeltaMiB: Number((peakRssDelta / MiB).toFixed(1)),
      peakHeapUsedMiB: Number((memory.peak.heapUsed / MiB).toFixed(1)),
      peakHeapDeltaMiB: Number((peakHeapDelta / MiB).toFixed(1)),
      sha256: digest,
      ffprobe: casProbe,
    }));
  } finally {
    try { await sourceHandle?.close(); } catch (_) {}
    await disposeFixture(fixture);
  }
});
