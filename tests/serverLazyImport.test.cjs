'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T8_FIGMA_BRIDGE_AUTOSTART = '0';
process.env.T8_COLLAB_MANAGEMENT_TOKEN = 'L'.repeat(43);
process.env.T8PC_STARTUP_MAINTENANCE_FALLBACK_MS = '300000';

test('requiring and listening to the backend does not initialize project storage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-server-lazy-import-'));
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

  const projectDatabase = require('../backend/src/services/projectDatabase');
  const originalGetProjectDatabase = projectDatabase.getProjectDatabase;
  let databaseInitializationCalls = 0;
  projectDatabase.getProjectDatabase = (...args) => {
    databaseInitializationCalls += 1;
    return originalGetProjectDatabase(...args);
  };

  let backend = null;
  try {
    backend = require('../backend/src/server');
    const start = await backend.serverStartPromise;
    assert.equal(start.state, 'listening');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(databaseInitializationCalls, 0);
    assert.equal(
      require('../backend/src/services/projectRuntime').getProjectStorageRuntimeStatus().status,
      'idle',
    );
    assert.equal(
      require('../backend/src/collaboration/gateway').peekCollaborationGateway(),
      null,
    );

    const shutdown = await backend.gracefulShutdown();
    assert.equal(shutdown.storageClosed, true);
    await backend.waitForRuntimeStorageCloseLifecycle();
    assert.equal(databaseInitializationCalls, 0);
    assert.equal(fs.existsSync(config.PROJECT_DB_FILE), false);
  } finally {
    projectDatabase.getProjectDatabase = originalGetProjectDatabase;
    if (backend?.server?.listening) {
      backend.server.closeAllConnections?.();
      await new Promise((resolve) => backend.server.close(() => resolve()));
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});