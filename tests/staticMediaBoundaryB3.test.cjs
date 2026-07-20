'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.T8_FIGMA_BRIDGE_AUTOSTART = '0';
process.env.T8_COLLAB_MANAGEMENT_TOKEN = 'A'.repeat(43);

function request(server, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.once('error', reject);
  });
}

test('user media static routes serve normal media with nosniff and block active extensions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-static-media-b3-'));
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
  fs.writeFileSync(path.join(config.OUTPUT_DIR, 'normal.png'), Buffer.from('png-body'));
  fs.writeFileSync(path.join(config.OUTPUT_DIR, 'normal.mp4'), Buffer.from('mp4-body'));
  fs.writeFileSync(path.join(config.OUTPUT_DIR, 'normal.mp3'), Buffer.from('mp3-body'));
  fs.writeFileSync(path.join(config.OUTPUT_DIR, 'active.html'), '<script>globalThis.pwned=true</script>');
  fs.writeFileSync(path.join(config.OUTPUT_DIR, 'active.svg'), '<svg onload="globalThis.pwned=true"/>');
  fs.writeFileSync(path.join(config.INPUT_DIR, 'active.js'), 'globalThis.pwned=true');
  fs.mkdirSync(path.join(config.OUTPUT_DIR, 'active-directory'));
  fs.writeFileSync(path.join(config.OUTPUT_DIR, 'active-directory', 'index.html'), '<script>globalThis.pwned=true</script>');

  const backend = require('../backend/src/server');
  if (!backend.server.listening) await new Promise((resolve) => backend.server.once('listening', resolve));
  try {
    for (const name of ['normal.png', 'normal.mp4', 'normal.mp3']) {
      const response = await request(backend.server, `/files/output/${name}`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
    for (const pathname of [
      '/files/output/active.html',
      '/output/active.svg',
      '/files/input/active.js',
      '/files/output/active%2ehtml',
      '/files/output/active-directory/',
    ]) {
      const response = await request(backend.server, pathname);
      assert.equal(response.status, 404, pathname);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.body.includes(Buffer.from('pwned')), false);
    }
  } finally {
    await backend.gracefulShutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
