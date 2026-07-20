import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function listen(app: any) {
  return new Promise<any>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('web asset import requires a local bridge token and saves validated images to input', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-web-assets-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const config = require('../backend/src/config.js');
  const oldInput = config.INPUT_DIR;
  config.INPUT_DIR = path.join(tmpDir, 'input');
  t.after(() => { config.INPUT_DIR = oldInput; });

  const route = require('../backend/src/routes/webAssets.js');
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/web-assets', route);
  const server = await listen(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const unauthorized = await fetch(`${base}/api/web-assets/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assets: [{ dataUrl: PNG_DATA_URL }] }),
  });
  assert.equal(unauthorized.status, 401);

  const status = await fetch(`${base}/api/web-assets/status`).then((res) => res.json());
  assert.equal(status.success, true);
  assert.equal(typeof status.data.token, 'string');
  assert.equal(status.data.maxItems, 50);

  const imported = await fetch(`${base}/api/web-assets/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-t8-web-assets-token': status.data.token,
    },
    body: JSON.stringify({
      assets: [
        { dataUrl: PNG_DATA_URL, name: '../first.png', pageUrl: 'https://example.com/gallery' },
        { dataUrl: PNG_DATA_URL, name: '../first.png', pageUrl: 'https://example.com/gallery' },
      ],
    }),
  }).then((res) => res.json());

  assert.equal(imported.success, true);
  assert.equal(imported.data.items.length, 2);
  assert.equal(imported.data.items[1].duplicate, true);
  assert.equal(imported.data.items[0].width, 1);
  assert.equal(imported.data.items[0].height, 1);
  assert.equal(imported.data.items[0].mime, 'image/png');
  assert.match(imported.data.items[0].url, /^\/files\/input\/web_/);
  assert.equal(imported.data.items[0].filename.includes('..'), false);
  assert.equal(fs.existsSync(path.join(config.INPUT_DIR, imported.data.items[0].filename)), true);
  assert.equal(fs.readdirSync(config.INPUT_DIR).length, 1);
});

test('web asset import rejects loopback URL fallback before connecting', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-web-assets-private-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const config = require('../backend/src/config.js');
  const oldInput = config.INPUT_DIR;
  config.INPUT_DIR = path.join(tmpDir, 'input');
  t.after(() => { config.INPUT_DIR = oldInput; });

  const route = require('../backend/src/routes/webAssets.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/web-assets', route);
  const server = await listen(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await fetch(`${base}/api/web-assets/status`).then((res) => res.json());

  const response = await fetch(`${base}/api/web-assets/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-t8-web-assets-token': status.data.token },
    body: JSON.stringify({ assets: [{ url: 'http://127.0.0.1/private.png', name: 'private.png' }] }),
  });
  const result = await response.json();
  assert.equal(response.status, 400);
  assert.equal(result.success, false);
  assert.equal(result.data.failures[0].code, 'private_address');
});

test('web asset private-address classifier covers common IPv4 and IPv6 ranges', () => {
  const route = require('../backend/src/routes/webAssets.js');
  assert.equal(route._test.isPrivateAddress('10.1.2.3'), true);
  assert.equal(route._test.isPrivateAddress('172.20.1.2'), true);
  assert.equal(route._test.isPrivateAddress('192.168.1.2'), true);
  assert.equal(route._test.isPrivateAddress('::1'), true);
  assert.equal(route._test.isPrivateAddress('fc00::1'), true);
  assert.equal(route._test.isPrivateAddress('8.8.8.8'), false);
});

test('shared remote media fetch rejects mixed DNS answers and enforces streaming byte limits', async (t) => {
  const remote = require('../backend/src/utils/safeRemoteMediaFetch.js');
  await assert.rejects(
    remote.resolvePublicAddress('example.test', async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    (error: any) => error?.code === 'private_address',
  );

  const app = express();
  app.get('/chunked', (_req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.write(Buffer.alloc(6, 1));
    res.end(Buffer.alloc(6, 2));
  });
  const server = await listen(app);
  t.after(() => server.close());
  await assert.rejects(
    remote.safeRemoteMediaFetch(`http://127.0.0.1:${server.address().port}/chunked`, {
      maxBytes: 8,
      allowPrivateForTests: true,
    }),
    (error: any) => error?.code === 'item_too_large',
  );
});

test('web asset import rejects SVG even when supplied as an image data URL', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-web-assets-svg-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const config = require('../backend/src/config.js');
  const oldInput = config.INPUT_DIR;
  config.INPUT_DIR = path.join(tmpDir, 'input');
  t.after(() => { config.INPUT_DIR = oldInput; });
  const route = require('../backend/src/routes/webAssets.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/web-assets', route);
  const server = await listen(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await fetch(`${base}/api/web-assets/status`).then((res) => res.json());
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>').toString('base64');
  const result = await fetch(`${base}/api/web-assets/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-t8-web-assets-token': status.data.token },
    body: JSON.stringify({ assets: [{ dataUrl: `data:image/svg+xml;base64,${svg}`, name: 'unsafe.svg' }] }),
  }).then((res) => res.json());
  assert.equal(result.success, false);
  assert.equal(result.data.failures[0].code, 'unsupported_image');
});
