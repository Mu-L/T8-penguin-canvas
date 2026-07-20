'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.T8_FIGMA_BRIDGE_AUTOSTART = '0';
process.env.T8_COLLAB_MANAGEMENT_TOKEN = 'A'.repeat(43);

function request(server, pathname, options = {}) {
  const body = options.body == null ? null : Buffer.from(String(options.body));
  const headers = { ...(options.headers || {}) };
  if (body && headers['content-length'] == null && headers['Content-Length'] == null) {
    headers['content-length'] = String(body.length);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method: options.method || 'GET',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

test('local backend rejects untrusted browser origins before parsing while preserving native and trusted CORS clients', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-server-origin-b3-'));
  const config = require('../backend/src/config');
  Object.assign(config, {
    HOST: '127.0.0.1',
    PORT: 0,
    DATA_DIR: path.join(root, 'data'),
    INPUT_DIR: path.join(root, 'input'),
    OUTPUT_DIR: path.join(root, 'output'),
    THUMBNAILS_DIR: path.join(root, 'thumbnails'),
    ASSET_PREVIEWS_DIR: path.join(root, 'thumbnails', 'asset-previews'),
    ASSET_BLOB_DIR: path.join(root, 'data', 'asset-blobs'),
    COLLAB_UPLOAD_TEMP_DIR: path.join(root, 'data', 'collaboration-uploads'),
    PROJECT_DB_FILE: path.join(root, 'data', 'projects.sqlite3'),
    PROJECT_DB_BACKUP_FILE: path.join(root, 'data', 'projects.sqlite3.backup'),
  });
  for (const directory of [config.DATA_DIR, config.INPUT_DIR, config.OUTPUT_DIR, config.THUMBNAILS_DIR]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const backend = require('../backend/src/server');
  if (!backend.server.listening) await new Promise((resolve) => backend.server.once('listening', resolve));
  try {
    const evil = await request(backend.server, '/api/status', {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(evil.status, 403);

    const opaque = await request(backend.server, '/api/status', {
      headers: { Origin: 'null' },
    });
    assert.equal(opaque.status, 403);

    const crossSiteWithoutOrigin = await request(backend.server, '/api/status', {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(crossSiteWithoutOrigin.status, 403);

    const crossSiteWithSpoofedLocalOrigin = await request(backend.server, '/api/status', {
      headers: {
        Origin: 'http://127.0.0.1:43123',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    assert.equal(crossSiteWithSpoofedLocalOrigin.status, 403);

    const rejectedBeforeJsonParsing = await request(backend.server, '/api/status', {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    assert.equal(rejectedBeforeJsonParsing.status, 403);

    const nativeClient = await request(backend.server, '/api/status');
    assert.equal(nativeClient.status, 200);
    assert.equal(nativeClient.headers['access-control-allow-origin'], undefined);

    for (const origin of ['http://127.0.0.1:43123', 'https://localhost:43124', 'uxp://t8-photoshop-link']) {
      const trusted = await request(backend.server, '/api/status', { headers: { Origin: origin } });
      assert.equal(trusted.status, 200, origin);
      assert.equal(trusted.headers['access-control-allow-origin'], origin, origin);
    }

    const preflight = await request(backend.server, '/api/status', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:43123',
        'Access-Control-Request-Method': 'GET',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'http://127.0.0.1:43123');
    assert.match(String(preflight.headers['access-control-allow-methods'] || ''), /GET/);
  } finally {
    await backend.gracefulShutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
