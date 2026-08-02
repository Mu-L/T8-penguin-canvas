'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('bounded-png-fixture'),
]);

async function listenHttp(handler) {
  const server = http.createServer(handler);
  server.on('connection', (socket) => socket.on('error', () => {}));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function readJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch (_) { return { unparsed: text }; }
}

test('B3 file save boundary rejects traversal/SSRF/unbounded media and keeps upload/Duck reads bounded', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-files-save-b3-'));
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'output');
  const saveDir = path.join(root, 'saved');
  const dataDir = path.join(root, 'data');
  const thumbnailDir = path.join(root, 'thumbnails');
  const previewDir = path.join(thumbnailDir, 'asset-previews');
  for (const directory of [inputDir, outputDir, saveDir, dataDir, thumbnailDir, previewDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const config = require('../backend/src/config');
  Object.assign(config, {
    DATA_DIR: dataDir,
    INPUT_DIR: inputDir,
    OUTPUT_DIR: outputDir,
    THUMBNAILS_DIR: thumbnailDir,
    ASSET_PREVIEWS_DIR: previewDir,
    ASSET_BLOB_DIR: path.join(dataDir, 'asset-blobs'),
    PROJECT_DB_FILE: path.join(dataDir, 't8-projects.sqlite3'),
    PROJECT_DB_BACKUP_FILE: path.join(dataDir, 't8-projects.sqlite3.backup'),
    SETTINGS_FILE: path.join(dataDir, 'settings.json'),
    DEFAULT_LOCAL_SAVE_DIR: saveDir,
    FILE_UPLOAD_MAX_BYTES: 64,
  });
  fs.writeFileSync(config.SETTINGS_FILE, `${JSON.stringify({ fileSavePath: saveDir })}\n`);

  // Configure paths and the upload limit before files.js constructs its
  // database/indexer and Multer middleware.
  const filesRouter = require('../backend/src/routes/files');
  filesRouter._test.setFileSaveRouteTestOptions({
    maxBytes: 64,
    duckMaxBytes: 64,
    deadlineMs: 2_000,
    idleTimeoutMs: 500,
    maxRedirects: 3,
    allowPrivateForTests: (hostname) => hostname === 'public.test',
    lookupImpl: async (hostname) => {
      assert.equal(hostname, 'public.test');
      return [{ address: '127.0.0.1', family: 4 }];
    },
  });

  const express = require('express');
  const app = express();
  app.use('/api/files', filesRouter);
  const appServer = await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
  const appBase = `http://127.0.0.1:${appServer.address().port}`;
  const post = async (route, body) => {
    const response = await fetch(`${appBase}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { response, payload: await readJson(response) };
  };

  let privateHits = 0;
  let remoteServer;
  t.after(async () => {
    filesRouter._test.setFileSaveRouteTestOptions();
    await closeServer(remoteServer);
    await closeServer(appServer);
    try {
      const database = require('../backend/src/services/projectDatabase').getProjectDatabase(config);
      await database.close();
    } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  await t.test('copies valid mounted media with a canonical safe exclusive target', async () => {
    const nested = path.join(outputDir, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'valid.png'), PNG);
    const first = await post('/api/files/save-to-disk', {
      url: '/files/output/nested/valid.png?cache=1',
      filename: '../../saved.html',
      kind: 'image',
    });
    assert.equal(first.response.status, 200, JSON.stringify(first.payload));
    assert.equal(first.payload.success, true);
    assert.equal(first.payload.data.filename, 'saved.png');
    assert.equal(first.payload.data.exist, false);
    assert.deepEqual(fs.readFileSync(path.join(saveDir, 'saved.png')), PNG);
    assert.equal(fs.existsSync(path.join(root, 'saved.html')), false);

    const second = await post('/api/files/save-to-disk', {
      url: '/files/output/nested/valid.png',
      filename: 'saved.png',
    });
    assert.equal(second.response.status, 200);
    assert.equal(second.payload.data.exist, true);
    assert.deepEqual(fs.readFileSync(path.join(saveDir, 'saved.png')), PNG);
  });

  await t.test('rejects plain, encoded and double-encoded mounted traversal without leaking host paths', async () => {
    const outsidePath = path.join(root, 'outside.png');
    fs.writeFileSync(outsidePath, PNG);
    const attempts = [
      '/files/output/../outside.png',
      '/files/output/%2e%2e/outside.png',
      '/files/output/%252e%252e/outside.png',
      '/files/output/%2e%2e%2foutside.png',
      '/files/output/..%5coutside.png',
    ];
    for (const url of attempts) {
      const result = await post('/api/files/save-to-disk', { url, filename: 'escaped.png' });
      assert.equal(result.response.status, 400, `${url}: ${JSON.stringify(result.payload)}`);
      assert.equal(result.payload.code, 'unsafe_local_source');
      const serialized = JSON.stringify(result.payload);
      assert.equal(serialized.includes(outsidePath), false);
      assert.equal(serialized.includes(root.replace(/\\/g, '/')), false);
      assert.equal(serialized.includes(url), false);
    }
    assert.equal(fs.existsSync(path.join(saveDir, 'escaped.png')), false);
  });

  await t.test('rejects mounted junction escape and target symlinks', async () => {
    const outsideDir = path.join(root, 'outside-dir');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'secret.png'), PNG);
    const mountedLink = path.join(outputDir, 'escape-link');
    fs.symlinkSync(outsideDir, mountedLink, process.platform === 'win32' ? 'junction' : 'dir');
    const escaped = await post('/api/files/save-to-disk', {
      url: '/files/output/escape-link/secret.png',
      filename: 'junction.png',
    });
    assert.equal(escaped.response.status, 400, JSON.stringify(escaped.payload));
    assert.equal(escaped.payload.code, 'unsafe_local_source');
    assert.equal(fs.existsSync(path.join(saveDir, 'junction.png')), false);

    const targetSource = path.join(root, 'target-source.png');
    fs.writeFileSync(targetSource, Buffer.from('must-not-change'));
    const targetLink = path.join(saveDir, 'target-link.png');
    fs.symlinkSync(targetSource, targetLink, 'file');
    const targetResult = await post('/api/files/save-to-disk', {
      url: '/files/output/nested/valid.png',
      filename: 'target-link.png',
    });
    assert.equal(targetResult.response.status, 409, JSON.stringify(targetResult.payload));
    assert.equal(targetResult.payload.code, 'save_target_unsafe');
    assert.equal(fs.readFileSync(targetSource, 'utf8'), 'must-not-change');
  });

  await t.test('bounds local bytes and rejects extension-only media spoofing', async () => {
    fs.writeFileSync(path.join(inputDir, 'large.png'), Buffer.concat([PNG, Buffer.alloc(96, 1)]));
    fs.writeFileSync(path.join(inputDir, 'fake.png'), Buffer.from('<html>not media</html>'));
    const oversized = await post('/api/files/save-to-disk', {
      url: '/files/input/large.png',
      filename: 'large.png',
    });
    assert.equal(oversized.response.status, 413, JSON.stringify(oversized.payload));
    assert.equal(oversized.payload.code, 'media_too_large');
    assert.equal(fs.existsSync(path.join(saveDir, 'large.png')), false);
    const spoofed = await post('/api/files/save-to-disk', {
      url: '/files/input/fake.png',
      filename: 'fake.png',
    });
    assert.equal(spoofed.response.status, 415, JSON.stringify(spoofed.payload));
    assert.equal(spoofed.payload.code, 'unsupported_media');
    assert.equal(fs.existsSync(path.join(saveDir, 'fake.png')), false);
  });

  await t.test('streams public media, ignores declared-length drift, and rejects private/redirect/oversize/spoofed responses', async () => {
    remoteServer = await listenHttp((req, res) => {
      if (req.url === '/ok.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) });
        res.end(PNG);
        return;
      }
      if (req.url === '/oversize.png') {
        const oversized = Buffer.concat([PNG, Buffer.alloc(96, 2)]);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(oversized.length) });
        res.end(oversized);
        return;
      }
      if (req.url === '/declared-longer.png') {
        res.shouldKeepAlive = false;
        res.writeHead(200, {
          Connection: 'close',
          'Content-Type': 'image/png',
          'Content-Length': String(PNG.length + 10),
        });
        res.end(PNG);
        return;
      }
      if (req.url === '/spoofed.png') {
        const body = Buffer.from('<html>provider error</html>');
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': String(body.length) });
        res.end(body);
        return;
      }
      if (req.url === '/redirect-private') {
        res.writeHead(302, {
          Location: `http://127.0.0.1:${remoteServer.address().port}/private.png?token=redirect-secret`,
        });
        res.end();
        return;
      }
      if (req.url?.startsWith('/private.png')) {
        privateHits += 1;
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) });
        res.end(PNG);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const publicBase = `http://public.test:${remoteServer.address().port}`;

    const positive = await post('/api/files/save-to-disk', {
      url: `${publicBase}/ok.png`,
      filename: 'remote.png',
      kind: 'image',
    });
    assert.equal(positive.response.status, 200, JSON.stringify(positive.payload));
    assert.equal(positive.payload.data.source, 'fetch');
    assert.deepEqual(fs.readFileSync(path.join(saveDir, 'remote.png')), PNG);

    const privateSecret = 'private-route-token-secret';
    const privateResult = await post('/api/files/save-to-disk', {
      url: `http://127.0.0.1:${remoteServer.address().port}/private.png?token=${privateSecret}`,
      filename: 'private.png',
    });
    assert.equal(privateResult.response.status, 400, JSON.stringify(privateResult.payload));
    assert.equal(privateResult.payload.code, 'remote_address_forbidden');
    assert.equal(JSON.stringify(privateResult.payload).includes(privateSecret), false);
    assert.equal(privateHits, 0);

    const redirected = await post('/api/files/save-to-disk', {
      url: `${publicBase}/redirect-private`,
      filename: 'redirected.png',
    });
    assert.equal(redirected.response.status, 400, JSON.stringify(redirected.payload));
    assert.equal(redirected.payload.code, 'remote_address_forbidden');
    assert.equal(JSON.stringify(redirected.payload).includes('redirect-secret'), false);
    assert.equal(privateHits, 0);

    const oversized = await post('/api/files/save-to-disk', {
      url: `${publicBase}/oversize.png`,
      filename: 'remote-large.png',
    });
    assert.equal(oversized.response.status, 413, JSON.stringify(oversized.payload));
    assert.equal(oversized.payload.code, 'media_too_large');

    const mismatched = await post('/api/files/save-to-disk', {
      url: `${publicBase}/declared-longer.png`,
      filename: 'remote-length-drift.png',
    });
    assert.equal(mismatched.response.status, 200, JSON.stringify(mismatched.payload));
    assert.equal(mismatched.payload.data.source, 'fetch');
    assert.deepEqual(fs.readFileSync(path.join(saveDir, 'remote-length-drift.png')), PNG);

    const spoofed = await post('/api/files/save-to-disk', {
      url: `${publicBase}/spoofed.png`,
      filename: 'remote-spoofed.png',
    });
    assert.equal(spoofed.response.status, 415, JSON.stringify(spoofed.payload));
    assert.equal(spoofed.payload.code, 'unsupported_media');

    for (const filename of ['private.png', 'redirected.png', 'remote-large.png', 'remote-spoofed.png']) {
      assert.equal(fs.existsSync(path.join(saveDir, filename)), false, `${filename} must not survive failure`);
    }
    assert.equal(fs.readdirSync(saveDir).some((name) => name.startsWith('.t8-save-')), false);
  });

  await t.test('ordinary upload and Duck decode reject oversized input before downstream processing', async () => {
    const beforeUpload = new Set(fs.readdirSync(inputDir));
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(128, 3)], { type: 'image/png' }), 'oversized.png');
    const uploadResponse = await fetch(`${appBase}/api/files/upload`, { method: 'POST', body: form });
    const uploadPayload = await readJson(uploadResponse);
    assert.equal(uploadResponse.status, 413, JSON.stringify(uploadPayload));
    assert.equal(uploadPayload.code, 'LIMIT_FILE_SIZE');
    assert.deepEqual(new Set(fs.readdirSync(inputDir)), beforeUpload, 'Multer partial file must be removed');

    fs.writeFileSync(path.join(inputDir, 'duck-too-large.png'), Buffer.concat([PNG, Buffer.alloc(96, 4)]));
    const duck = await post('/api/files/duck-decode', { urls: ['/files/input/duck-too-large.png'] });
    assert.equal(duck.response.status, 200, JSON.stringify(duck.payload));
    assert.equal(duck.payload.data.items[0].decoded, false);
    assert.equal(duck.payload.data.items[0].reason, 'file_too_large');
  });
});
