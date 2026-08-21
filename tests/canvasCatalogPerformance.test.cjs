const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const express = require('express');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function waitFor(predicate, timeoutMs = 5_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const value = predicate();
        if (value) return resolve(value);
      } catch {}
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('timed out waiting for canvas catalog recovery'));
      setTimeout(tick, 40);
    };
    tick();
  });
}

test('5000-item catalog paginates/searches while corrupt index recovery stays off the request hot path', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-canvas-catalog-performance-'));
  const healthyDir = path.join(directory, 'healthy');
  const recoveryDir = path.join(directory, 'recovery');
  fs.mkdirSync(healthyDir, { recursive: true });
  fs.mkdirSync(recoveryDir, { recursive: true });
  const healthyListFile = path.join(healthyDir, 'canvas_list.json');
  const recoveryListFile = path.join(recoveryDir, 'canvas_list.json');

  const catalog = Array.from({ length: 5_000 }, (_, index) => ({
    id: `canvas-${String(index).padStart(5, '0')}`,
    name: index === 4_321 ? 'Special Target Canvas' : `Canvas ${index}`,
    nodeCount: index % 17,
    revision: 1,
    createdAt: index + 1,
    updatedAt: 10_000 - index,
  }));
  fs.writeFileSync(healthyListFile, JSON.stringify(catalog), 'utf8');
  fs.writeFileSync(recoveryListFile, '{broken-json', 'utf8');

  const legacyCount = 24;
  const deletedDuringRecoveryId = 'canvas-legacy-000';
  for (let index = 0; index < legacyCount; index += 1) {
    const id = `canvas-legacy-${String(index).padStart(3, '0')}`;
    fs.writeFileSync(path.join(recoveryDir, `canvas_${id}.json`), JSON.stringify({
      schema: 't8-canvas-document',
      schemaVersion: 2,
      canvasId: id,
      revision: 1,
      updatedAt: 20_000 + index,
      nodes: [{ id: `node-${index}`, type: 'text', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }), 'utf8');
  }

  const documents = new Map();
  let databaseGetterCalls = 0;
  const database = {
    listCanvasesPage(_projectId, options = {}) {
      const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
      return { items: clone(catalog.slice(0, limit)), hasMore: false, nextCursor: null };
    },
    getCanvas(id) {
      if (documents.has(id)) return clone(documents.get(id));
      const item = catalog.find((entry) => entry.id === id);
      if (!item) return null;
      return {
        schema: 't8-canvas-document', schemaVersion: 2, projectId: 'project-default', canvasId: id,
        revision: 1, createdAt: item.createdAt, updatedAt: item.updatedAt, nodes: [], edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      };
    },
    ensureCanvas(id, snapshot) {
      const document = {
        schema: 't8-canvas-document', schemaVersion: 2, projectId: 'project-default', canvasId: id,
        revision: 1, createdAt: Date.now(), updatedAt: Date.now(), ...clone(snapshot),
      };
      documents.set(id, document);
      return clone(document);
    },
    updateCanvasCatalogMetadata(id, metadata = {}) {
      const document = documents.get(id);
      if (!document) return null;
      document.name = String(metadata.name || document.name || id);
      document.nodeCount = Array.isArray(document.nodes) ? document.nodes.length : 0;
      document.updatedAt = Date.now();
      return {
        id, projectId: document.projectId, revision: document.revision,
        name: document.name, nodeCount: document.nodeCount,
        createdAt: document.createdAt, updatedAt: document.updatedAt,
      };
    },
    deleteCanvas(id) {
      documents.delete(id);
      return true;
    },
  };

  const servicePath = require.resolve('../backend/src/services/projectDatabase.js');
  const routePath = require.resolve('../backend/src/routes/canvas.js');
  const previousServiceModule = require.cache[servicePath];
  const previousRouteModule = require.cache[routePath];
  require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: {
      getProjectDatabase: () => {
        databaseGetterCalls += 1;
        return database;
      },
    },
  };
  delete require.cache[routePath];

  const config = require('../backend/src/config.js');
  const previousConfig = {
    DATA_DIR: config.DATA_DIR,
    CANVAS_FILE: config.CANVAS_FILE,
    SETTINGS_FILE: config.SETTINGS_FILE,
  };
  Object.assign(config, {
    DATA_DIR: healthyDir,
    CANVAS_FILE: healthyListFile,
    SETTINGS_FILE: path.join(directory, 'settings.json'),
  });

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/canvas', require(routePath));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/canvas`;
  const originalAsyncReadFile = fs.promises.readFile;

  t.after(async () => {
    fs.promises.readFile = originalAsyncReadFile;
    await new Promise((resolve) => server.close(resolve));
    Object.assign(config, previousConfig);
    delete require.cache[routePath];
    if (previousRouteModule) require.cache[routePath] = previousRouteModule;
    if (previousServiceModule) require.cache[servicePath] = previousServiceModule;
    else delete require.cache[servicePath];
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const legacyResponse = await fetch(baseUrl);
  const legacyPayload = await legacyResponse.json();
  assert.equal(legacyResponse.status, 200);
  assert.equal(Array.isArray(legacyPayload.data), true);
  assert.equal(legacyPayload.data.length, 5_000, 'legacy ABI must remain an array without pagination params');
  assert.equal(legacyPayload.meta, undefined);

  const firstResponse = await fetch(`${baseUrl}?limit=50&activeId=canvas-04999`);
  const firstPayload = await firstResponse.json();
  assert.equal(firstResponse.status, 200, JSON.stringify(firstPayload));
  assert.equal(firstPayload.data.length, 50);
  assert.equal(firstPayload.data[0].id, 'canvas-00000');
  assert.equal(firstPayload.meta.total, 5_000);
  assert.equal(firstPayload.meta.hasMore, true);
  assert.equal(firstPayload.meta.activeItem.id, 'canvas-04999', 'persisted active canvas outside page 1 must be included');
  assert.equal(typeof firstPayload.meta.nextCursor, 'string');

  const secondResponse = await fetch(`${baseUrl}?limit=50&cursor=${encodeURIComponent(firstPayload.meta.nextCursor)}`);
  const secondPayload = await secondResponse.json();
  assert.equal(secondPayload.data.length, 50);
  assert.equal(secondPayload.data[0].id, 'canvas-00050');
  assert.equal(new Set([...firstPayload.data, ...secondPayload.data].map((item) => item.id)).size, 100);

  const searchResponse = await fetch(`${baseUrl}?limit=50&q=${encodeURIComponent('special target')}`);
  const searchPayload = await searchResponse.json();
  assert.deepEqual(searchPayload.data.map((item) => item.id), ['canvas-04321']);
  assert.equal(searchPayload.meta.total, 1);
  assert.equal(searchPayload.meta.searchUnavailable, false);

  Object.assign(config, { DATA_DIR: recoveryDir, CANVAS_FILE: recoveryListFile });
  let slowBodyReads = 0;
  fs.promises.readFile = async (file, ...args) => {
    if (path.dirname(String(file)) === recoveryDir && path.basename(String(file)).startsWith('canvas_canvas-')) {
      slowBodyReads += 1;
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    return originalAsyncReadFile.call(fs.promises, file, ...args);
  };

  const recoveryStartedAt = performance.now();
  const degradedLegacyResponse = await fetch(baseUrl);
  const degradedLegacyPayload = await degradedLegacyResponse.json();
  const recoveryResponseMs = performance.now() - recoveryStartedAt;
  assert.equal(degradedLegacyResponse.status, 503);
  assert.equal(degradedLegacyPayload.success, false);
  assert.equal(degradedLegacyPayload.code, 'canvas_catalog_recovering');
  assert.equal(degradedLegacyPayload.retryable, true);
  assert.equal(degradedLegacyResponse.headers.get('retry-after'), '1');
  assert.ok(recoveryResponseMs < 800, `degraded catalog response took ${recoveryResponseMs.toFixed(1)}ms`);
  assert.ok(slowBodyReads <= 2, `request waited for too many body reads: ${slowBodyReads}`);

  const databaseGetterCallsBeforeDegradedPage = databaseGetterCalls;
  const degradedPageResponse = await fetch(`${baseUrl}?limit=50`);
  const degradedPagePayload = await degradedPageResponse.json();
  assert.equal(degradedPageResponse.status, 200);
  assert.equal(degradedPagePayload.meta.partial, true);
  assert.equal(degradedPagePayload.meta.recovery.status, 'running');
  assert.equal(databaseGetterCalls, databaseGetterCallsBeforeDegradedPage, 'degraded bootstrap must not cold-open project DB');

  let firstVisiblePartial = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${baseUrl}?limit=50`);
    const payload = await response.json();
    if (
      payload.meta?.recovery?.status === 'running'
      && payload.meta.recovery.scanned < payload.meta.recovery.total
      && payload.data.length > 0
    ) {
      firstVisiblePartial = payload;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.ok(firstVisiblePartial, 'the first recovered batch must become visible before the full scan completes');
  assert.ok(firstVisiblePartial.data.length < legacyCount);
  assert.equal(databaseGetterCalls, databaseGetterCallsBeforeDegradedPage);
  const degradedSearchResponse = await fetch(`${baseUrl}?limit=50&q=legacy`);
  const degradedSearchPayload = await degradedSearchResponse.json();
  assert.equal(degradedSearchPayload.meta.searchUnavailable, true);

  const createResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Created During Recovery' }),
  });
  const createPayload = await createResponse.json();
  assert.equal(createResponse.status, 200, JSON.stringify(createPayload));
  const createdDuringRecoveryId = createPayload.data.id;

  const renameResponse = await fetch(`${baseUrl}/${createdDuringRecoveryId}/name`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed During Recovery' }),
  });
  const renamePayload = await renameResponse.json();
  assert.equal(renameResponse.status, 200, JSON.stringify(renamePayload));
  assert.equal(renamePayload.data.name, 'Renamed During Recovery');

  const deleteResponse = await fetch(`${baseUrl}/${deletedDuringRecoveryId}`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200, await deleteResponse.text());
  fs.promises.readFile = originalAsyncReadFile;

  const recoveredList = await waitFor(() => {
    const value = JSON.parse(fs.readFileSync(recoveryListFile, 'utf8'));
    if (!Array.isArray(value) || value.length < legacyCount) return null;
    return value;
  });
  const recoveredCreated = recoveredList.find((item) => item.id === createdDuringRecoveryId);
  assert.equal(Boolean(recoveredCreated), true, 'new canvas must survive recovery merge');
  assert.equal(recoveredCreated.name, 'Renamed During Recovery', 'rename must survive recovery final commit');
  assert.equal(recoveredList.some((item) => item.id === deletedDuringRecoveryId), false, 'deleted canvas must not be resurrected');
});
const CANVAS_MIRROR_RETRY_DRAIN_MS = 2_100;

test('rename stays committed when the legacy list mirror fails and authoritative metadata survives route restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-canvas-rename-mirror-'));
  const listFile = path.join(directory, 'canvas_list.json');
  const id = 'canvas-rename-authority';
  const originalItem = {
    id,
    name: 'Old Name',
    nodeCount: 0,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  fs.writeFileSync(listFile, JSON.stringify([originalItem]), 'utf8');

  const document = {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: 'project-default',
    canvasId: id,
    revision: 1,
    name: originalItem.name,
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const database = {
    getCanvas(canvasId) {
      return canvasId === id ? clone(document) : null;
    },
    updateCanvasCatalogMetadata(canvasId, metadata = {}) {
      if (canvasId !== id) return null;
      document.name = String(metadata.name || document.name);
      document.updatedAt = Date.now();
      return {
        id,
        projectId: document.projectId,
        revision: document.revision,
        name: document.name,
        nodeCount: document.nodes.length,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      };
    },
  };

  const servicePath = require.resolve('../backend/src/services/projectDatabase.js');
  const routePath = require.resolve('../backend/src/routes/canvas.js');
  const previousServiceModule = require.cache[servicePath];
  const previousRouteModule = require.cache[routePath];
  require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: { getProjectDatabase: () => database },
  };
  delete require.cache[routePath];

  const config = require('../backend/src/config.js');
  const previousConfig = {
    DATA_DIR: config.DATA_DIR,
    CANVAS_FILE: config.CANVAS_FILE,
    SETTINGS_FILE: config.SETTINGS_FILE,
  };
  Object.assign(config, {
    DATA_DIR: directory,
    CANVAS_FILE: listFile,
    SETTINGS_FILE: path.join(directory, 'settings.json'),
  });

  const originalRenameSync = fs.renameSync;
  let server = null;
  let restartedServer = null;
  try {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/canvas', require(routePath));
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/canvas`;

    let failListMirrorOnce = true;
    fs.renameSync = function injectedRenameFailure(source, destination) {
      if (failListMirrorOnce && path.resolve(String(destination)) === path.resolve(listFile)) {
        failListMirrorOnce = false;
        const error = new Error('injected list mirror failure');
        error.code = 'EACCES';
        throw error;
      }
      return originalRenameSync.call(fs, source, destination);
    };
    const renameResponse = await fetch(`${baseUrl}/${id}/name`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Authoritative New Name' }),
    });
    fs.renameSync = originalRenameSync;
    const renamePayload = await renameResponse.json();
    assert.equal(renameResponse.status, 200, JSON.stringify(renamePayload));
    assert.equal(renamePayload.success, true);
    assert.equal(renamePayload.committed, true);
    assert.equal(renamePayload.data.name, 'Authoritative New Name');
    assert.equal(renamePayload.warnings?.[0]?.code, 'legacy_canvas_list_mirror_failed');
    assert.equal(renamePayload.warnings?.[0]?.committed, true);
    assert.equal(JSON.parse(fs.readFileSync(listFile, 'utf8'))[0].name, 'Old Name');
    const recoveryDocument = JSON.parse(
      fs.readFileSync(path.join(directory, `canvas_${id}.json`), 'utf8'),
    );
    assert.equal(recoveryDocument.name, 'Authoritative New Name');

    const metadataResponse = await fetch(`${baseUrl}/${id}/metadata`);
    const metadataPayload = await metadataResponse.json();
    assert.equal(metadataResponse.status, 200);
    assert.equal(metadataPayload.data.name, 'Authoritative New Name');

    delete require.cache[routePath];
    const restartedApp = express();
    restartedApp.use(express.json({ limit: '2mb' }));
    restartedApp.use('/api/canvas', require(routePath));
    restartedServer = await new Promise((resolve) => {
      const instance = restartedApp.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const restartedMetadataResponse = await fetch(
      `http://127.0.0.1:${restartedServer.address().port}/api/canvas/${id}/metadata`,
    );
    const restartedMetadataPayload = await restartedMetadataResponse.json();
    assert.equal(restartedMetadataResponse.status, 200);
    assert.equal(restartedMetadataPayload.data.name, 'Authoritative New Name');

    const repairedList = await waitFor(() => {
      const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
      return list[0]?.name === 'Authoritative New Name' ? list : null;
    });
    assert.equal(repairedList[0].name, 'Authoritative New Name');
  } finally {
    fs.renameSync = originalRenameSync;
    await new Promise((resolve) => setTimeout(resolve, CANVAS_MIRROR_RETRY_DRAIN_MS));
    if (restartedServer) await new Promise((resolve) => restartedServer.close(resolve));
    if (server) await new Promise((resolve) => server.close(resolve));
    Object.assign(config, previousConfig);
    delete require.cache[routePath];
    if (previousRouteModule) require.cache[routePath] = previousRouteModule;
    if (previousServiceModule) require.cache[servicePath] = previousServiceModule;
    else delete require.cache[servicePath];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
