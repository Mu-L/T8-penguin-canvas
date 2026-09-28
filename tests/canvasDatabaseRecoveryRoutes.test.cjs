const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const config = require('../backend/src/config');
const {
  ProjectDatabase,
  closeProjectDatabase,
} = require('../backend/src/services/projectDatabase');

test('Canvas HTTP recovery requires a server-held plan and restores only after confirmation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-canvas-explicit-recovery-http-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const backupFilename = `${filename}.backup`;
  const dataDir = path.join(directory, 'data');
  fs.mkdirSync(dataDir);
  const previousConfig = {
    PROJECT_DB_FILE: config.PROJECT_DB_FILE,
    PROJECT_DB_BACKUP_FILE: config.PROJECT_DB_BACKUP_FILE,
    DATA_DIR: config.DATA_DIR,
    CANVAS_FILE: config.CANVAS_FILE,
  };
  let seed = null;
  let server = null;
  try {
    seed = new ProjectDatabase(filename, { backupFilename, autoBackup: false });
    seed.ensureCanvas('canvas-a', {
      nodes: [{ id: 'node-a', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    await seed.createBackup();
    const newer = seed.applyOperations('canvas-a', [{
      opId: 'newer-revision', actorId: 'member', sessionId: 'member-session',
      clientSeq: 1, type: 'node.move',
      payload: { nodeId: 'node-a', position: { x: 25, y: 25 } },
    }], { expectedRevision: 1 }).document;
    assert.equal(newer.revision, 2);
    await seed.close();
    seed = null;
    fs.writeFileSync(filename, 'broken-primary-after-acknowledged-write');

    config.PROJECT_DB_FILE = filename;
    config.PROJECT_DB_BACKUP_FILE = backupFilename;
    config.DATA_DIR = dataDir;
    config.CANVAS_FILE = path.join(dataDir, 'canvas_list.json');
    const app = express();
    app.use(express.json());
    app.use('/api/canvas', require('../backend/src/routes/canvas'));
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const origin = `http://127.0.0.1:${server.address().port}/api/canvas`;

    const blocked = await fetch(`${origin}/canvas-a`);
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 503);
    assert.equal(blockedBody.success, false);
    assert.equal(blockedBody.recovery.available, true);
    assert.ok(blockedBody.recovery.potentiallyDiscardedWriteCount > 0);
    assert.equal(Object.hasOwn(blockedBody.recovery, 'authorization'), false);
    const planId = blockedBody.recovery.planId;

    const wrongConfirmation = await fetch(`${origin}/recovery/restore-canonical-backup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId, confirmation: 'wrong' }),
    });
    assert.equal(wrongConfirmation.status, 400);
    assert.equal((await fetch(`${origin}/canvas-a`)).status, 503);

    const restored = await fetch(`${origin}/recovery/restore-canonical-backup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId, confirmation: 'restore-verified-canonical-backup' }),
    });
    const restoredBody = await restored.json();
    assert.equal(restored.status, 200);
    assert.equal(restoredBody.data.recovered, true);
    assert.equal(restoredBody.data.backupRefreshed, true);
    const loaded = await fetch(`${origin}/canvas-a`);
    assert.equal(loaded.status, 200);
    const loadedBody = await loaded.json();
    assert.equal(loadedBody.data.revision, 1);
    assert.deepEqual(loadedBody.data.nodes[0].position, { x: 0, y: 0 });

    const reused = await fetch(`${origin}/recovery/restore-canonical-backup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId, confirmation: 'restore-verified-canonical-backup' }),
    });
    assert.equal(reused.status, 409);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await seed?.close().catch(() => undefined);
    await closeProjectDatabase();
    Object.assign(config, previousConfig);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
