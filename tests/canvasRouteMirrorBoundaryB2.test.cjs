const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const COMMITTED_MIRROR_WARNING = Object.freeze({
  code: 'legacy_canvas_mirror_failed',
  message: '画布已由 SQLite 成功提交，但兼容画布镜像暂未同步；后续读取会重试修复。',
});

test('canvas CRUD commits SQLite before best-effort legacy mirrors and never reports a committed mutation as failed', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-canvas-mirror-boundary-'));
  const dataDir = path.join(directory, 'data');
  const canvasId = 'canvas-boundary';
  const canvasFile = path.join(dataDir, `canvas_${canvasId}.json`);
  const listFile = path.join(dataDir, 'canvas_list.json');
  fs.mkdirSync(dataDir, { recursive: true });

  const initialDocument = {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: 'project-boundary',
    canvasId,
    revision: 1,
    updatedAt: 10,
    nodes: [{ id: 'node-initial', type: 'text', position: { x: 0, y: 0 }, data: { text: 'initial' } }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  fs.writeFileSync(canvasFile, JSON.stringify(initialDocument, null, 2), 'utf8');
  fs.writeFileSync(listFile, JSON.stringify([{
    id: canvasId,
    name: 'Boundary QA',
    nodeCount: 1,
    revision: 1,
    createdAt: 1,
    updatedAt: 10,
  }], null, 2), 'utf8');

  let currentDocument = clone(initialDocument);
  let failDelete = false;
  let failedCreateId = null;
  const commits = [];
  const database = {
    getCanvas(requestedCanvasId) {
      return requestedCanvasId === canvasId ? clone(currentDocument) : null;
    },
    ensureCanvas(requestedCanvasId) {
      if (requestedCanvasId !== canvasId) {
        failedCreateId = requestedCanvasId;
        throw new Error(`SQLITE_FULL at ${directory} token=create-private-token`);
      }
      return clone(currentDocument);
    },
    saveCanvasSnapshot(requestedCanvasId, snapshot) {
      assert.equal(requestedCanvasId, canvasId);
      currentDocument = {
        ...clone(currentDocument),
        ...clone(snapshot),
        schema: 't8-canvas-document',
        schemaVersion: 2,
        projectId: 'project-boundary',
        canvasId,
        revision: 2,
        updatedAt: 20,
      };
      commits.push('save:2');
      return clone(currentDocument);
    },
    applyOperations(requestedCanvasId) {
      assert.equal(requestedCanvasId, canvasId);
      currentDocument = {
        ...clone(currentDocument),
        revision: 3,
        updatedAt: 30,
        nodes: [...clone(currentDocument.nodes), {
          id: 'node-operation', type: 'text', position: { x: 10, y: 10 }, data: { text: 'operation' },
        }],
      };
      commits.push('operations:3');
      return { revision: 3, document: clone(currentDocument), operations: [{ opId: 'operation-1' }] };
    },
    restoreCanvasSnapshot(requestedCanvasId) {
      assert.equal(requestedCanvasId, canvasId);
      currentDocument = {
        ...clone(currentDocument),
        revision: 4,
        updatedAt: 40,
        nodes: [{ id: 'node-restored', type: 'text', position: { x: 20, y: 20 }, data: { text: 'restored' } }],
      };
      commits.push('restore:4');
      return clone(currentDocument);
    },
    deleteCanvas(requestedCanvasId) {
      assert.equal(requestedCanvasId, canvasId);
      if (failDelete) throw new Error(`delete failed at ${directory} token=delete-private-token`);
      currentDocument = null;
      commits.push('delete');
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
    DATA_DIR: dataDir,
    CANVAS_FILE: listFile,
    SETTINGS_FILE: path.join(directory, 'settings.json'),
  });

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/canvas', require(routePath));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/canvas`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(config, previousConfig);
    delete require.cache[routePath];
    if (previousRouteModule) require.cache[routePath] = previousRouteModule;
    if (previousServiceModule) require.cache[servicePath] = previousServiceModule;
    else delete require.cache[servicePath];
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const listBeforeCreate = fs.readFileSync(listFile, 'utf8');
  const createResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Must not be mirrored' }),
  });
  const createPayload = await createResponse.json();
  assert.equal(createResponse.status, 500, JSON.stringify(createPayload));
  assert.equal(createPayload.code, 'canvas_create_failed');
  assert.doesNotMatch(JSON.stringify(createPayload), /t8-canvas-mirror-boundary|create-private-token|Users|AppData/i);
  assert.match(failedCreateId, /^canvas-\d+-[a-z0-9]+$/);
  assert.equal(fs.existsSync(path.join(dataDir, `canvas_${failedCreateId}.json`)), false);
  assert.equal(fs.readFileSync(listFile, 'utf8'), listBeforeCreate, 'a failed SQLite create must write zero legacy mirrors');

  async function requestWithCanvasMirrorFailure(url, options) {
    const originalRenameSync = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (path.resolve(String(target)) === path.resolve(canvasFile)) {
        throw new Error(`EACCES: ${directory} private-mirror-path`);
      }
      return originalRenameSync(source, target);
    };
    try {
      return await fetch(url, options);
    } finally {
      fs.renameSync = originalRenameSync;
    }
  }

  const saveResponse = await requestWithCanvasMirrorFailure(`${baseUrl}/${canvasId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseRevision: 1,
      nodes: [{ id: 'node-save', type: 'text', position: { x: 5, y: 5 }, data: { text: 'saved' } }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }),
  });
  const savePayload = await saveResponse.json();
  assert.equal(saveResponse.status, 200, JSON.stringify(savePayload));
  assert.equal(savePayload.data.revision, 2);
  assert.deepEqual(savePayload.warnings, [COMMITTED_MIRROR_WARNING]);
  assert.doesNotMatch(JSON.stringify(savePayload), /t8-canvas-mirror-boundary|private-mirror-path|Users|AppData/i);
  assert.equal(currentDocument.revision, 2);
  assert.equal(JSON.parse(fs.readFileSync(canvasFile, 'utf8')).revision, 1);
  assert.equal(JSON.parse(fs.readFileSync(listFile, 'utf8'))[0].revision, 2);

  const operationResponse = await requestWithCanvasMirrorFailure(`${baseUrl}/${canvasId}/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: 2, operations: [{ opId: 'operation-1' }] }),
  });
  const operationPayload = await operationResponse.json();
  assert.equal(operationResponse.status, 200, JSON.stringify(operationPayload));
  assert.equal(operationPayload.data.document.revision, 3);
  assert.deepEqual(operationPayload.warnings, [COMMITTED_MIRROR_WARNING]);
  assert.equal(currentDocument.revision, 3);
  assert.equal(JSON.parse(fs.readFileSync(canvasFile, 'utf8')).revision, 1);
  assert.equal(JSON.parse(fs.readFileSync(listFile, 'utf8'))[0].revision, 3);

  const restoreResponse = await requestWithCanvasMirrorFailure(`${baseUrl}/${canvasId}/history/1/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: 3 }),
  });
  const restorePayload = await restoreResponse.json();
  assert.equal(restoreResponse.status, 200, JSON.stringify(restorePayload));
  assert.equal(restorePayload.data.revision, 4);
  assert.deepEqual(restorePayload.warnings, [COMMITTED_MIRROR_WARNING]);
  assert.equal(currentDocument.revision, 4);
  assert.equal(JSON.parse(fs.readFileSync(canvasFile, 'utf8')).revision, 1);
  assert.equal(JSON.parse(fs.readFileSync(listFile, 'utf8'))[0].revision, 4);
  assert.deepEqual(commits, ['save:2', 'operations:3', 'restore:4']);

  const canvasBeforeFailedDelete = fs.readFileSync(canvasFile, 'utf8');
  const listBeforeFailedDelete = fs.readFileSync(listFile, 'utf8');
  failDelete = true;
  const failedDeleteResponse = await fetch(`${baseUrl}/${canvasId}`, { method: 'DELETE' });
  const failedDeletePayload = await failedDeleteResponse.json();
  assert.equal(failedDeleteResponse.status, 500, JSON.stringify(failedDeletePayload));
  assert.equal(failedDeletePayload.code, 'canvas_delete_failed');
  assert.doesNotMatch(JSON.stringify(failedDeletePayload), /t8-canvas-mirror-boundary|delete-private-token|Users|AppData/i);
  assert.equal(currentDocument.revision, 4);
  assert.equal(fs.readFileSync(canvasFile, 'utf8'), canvasBeforeFailedDelete);
  assert.equal(fs.readFileSync(listFile, 'utf8'), listBeforeFailedDelete);

  failDelete = false;
  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = (target) => {
    if (path.resolve(String(target)) === path.resolve(canvasFile)) {
      throw new Error(`EPERM: ${directory} private-delete-path`);
    }
    return originalUnlinkSync(target);
  };
  let committedDeleteResponse;
  try {
    committedDeleteResponse = await fetch(`${baseUrl}/${canvasId}`, { method: 'DELETE' });
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
  const committedDeletePayload = await committedDeleteResponse.json();
  assert.equal(committedDeleteResponse.status, 200, JSON.stringify(committedDeletePayload));
  assert.deepEqual(committedDeletePayload.warnings, [{
    code: 'legacy_canvas_mirror_cleanup_failed',
    committed: true,
    message: '画布删除已由 SQLite 成功提交，但兼容画布文件暂未清理。',
  }]);
  assert.doesNotMatch(JSON.stringify(committedDeletePayload), /t8-canvas-mirror-boundary|private-delete-path|Users|AppData/i);
  assert.equal(currentDocument, null, 'SQLite delete must remain committed');
  assert.equal(fs.existsSync(canvasFile), true, 'failed legacy cleanup must not be reported as a rolled-back DB delete');
  assert.deepEqual(JSON.parse(fs.readFileSync(listFile, 'utf8')), []);
  assert.deepEqual(commits, ['save:2', 'operations:3', 'restore:4', 'delete']);
});

test('real SQLite canvas save, operation, and restore remain committed when compatibility mirrors fail', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-canvas-real-mirror-boundary-'));
  const dataDir = path.join(directory, 'data');
  const listFile = path.join(dataDir, 'canvas_list.json');
  fs.mkdirSync(dataDir, { recursive: true });

  const config = require('../backend/src/config.js');
  const previousConfig = {
    DATA_DIR: config.DATA_DIR,
    CANVAS_FILE: config.CANVAS_FILE,
    SETTINGS_FILE: config.SETTINGS_FILE,
    PROJECT_DB_FILE: config.PROJECT_DB_FILE,
    PROJECT_DB_BACKUP_FILE: config.PROJECT_DB_BACKUP_FILE,
  };
  Object.assign(config, {
    DATA_DIR: dataDir,
    CANVAS_FILE: listFile,
    SETTINGS_FILE: path.join(directory, 'settings.json'),
    PROJECT_DB_FILE: path.join(dataDir, 'projects.sqlite3'),
    PROJECT_DB_BACKUP_FILE: path.join(dataDir, 'projects.sqlite3.backup'),
  });

  const servicePath = require.resolve('../backend/src/services/projectDatabase.js');
  const routePath = require.resolve('../backend/src/routes/canvas.js');
  delete require.cache[servicePath];
  delete require.cache[routePath];
  const { getProjectDatabase } = require(servicePath);
  const database = getProjectDatabase(config);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/canvas', require(routePath));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/canvas`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.close();
    Object.assign(config, previousConfig);
    delete require.cache[routePath];
    delete require.cache[servicePath];
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const createResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Real mirror boundary' }),
  });
  const createPayload = await createResponse.json();
  assert.equal(createResponse.status, 200, JSON.stringify(createPayload));
  assert.equal(createPayload.warnings, undefined);
  const canvasId = createPayload.data.id;
  const canvasFile = path.join(dataDir, `canvas_${canvasId}.json`);
  assert.equal(database.getCanvas(canvasId).revision, 1);
  assert.equal(JSON.parse(fs.readFileSync(canvasFile, 'utf8')).revision, 1);

  async function requestWithCanvasMirrorFailure(url, options) {
    const originalRenameSync = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (path.resolve(String(target)) === path.resolve(canvasFile)) {
        throw new Error(`EACCES: ${directory} real-private-mirror-path`);
      }
      return originalRenameSync(source, target);
    };
    try {
      return await fetch(url, options);
    } finally {
      fs.renameSync = originalRenameSync;
    }
  }

  const saveResponse = await requestWithCanvasMirrorFailure(`${baseUrl}/${encodeURIComponent(canvasId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseRevision: 1,
      nodes: [{ id: 'real-node', type: 'text', position: { x: 0, y: 0 }, data: { text: 'saved' } }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }),
  });
  const savePayload = await saveResponse.json();
  assert.equal(saveResponse.status, 200, JSON.stringify(savePayload));
  assert.equal(savePayload.data.revision, 2);
  assert.deepEqual(savePayload.warnings, [COMMITTED_MIRROR_WARNING]);
  assert.equal(database.getCanvas(canvasId).revision, 2);
  assert.equal(JSON.parse(fs.readFileSync(canvasFile, 'utf8')).revision, 1);

  const staleMirrorEmptyOverwrite = await fetch(`${baseUrl}/${encodeURIComponent(canvasId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseRevision: 2,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }),
  });
  const staleMirrorEmptyPayload = await staleMirrorEmptyOverwrite.json();
  assert.equal(staleMirrorEmptyOverwrite.status, 400, JSON.stringify(staleMirrorEmptyPayload));
  assert.equal(staleMirrorEmptyPayload.error, '拒绝空数据覆盖');
  assert.equal(database.getCanvas(canvasId).revision, 2, 'the stale empty JSON mirror must not override the non-empty SQLite document');

  const projectId = database.getCanvas(canvasId).projectId;
  const operationResponse = await requestWithCanvasMirrorFailure(
    `${baseUrl}/${encodeURIComponent(canvasId)}/operations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 2,
        operations: [{
          opId: crypto.randomUUID(),
          projectId,
          canvasId,
          actorId: 'local-owner',
          sessionId: 'local-session',
          baseRevision: 2,
          clientSeq: 1,
          timestamp: Date.now(),
          type: 'node.move',
          payload: { nodeId: 'real-node', position: { x: 25, y: 30 } },
        }],
      }),
    },
  );
  const operationPayload = await operationResponse.json();
  assert.equal(operationResponse.status, 200, JSON.stringify(operationPayload));
  assert.equal(operationPayload.data.document.revision, 3);
  assert.deepEqual(operationPayload.warnings, [COMMITTED_MIRROR_WARNING]);
  assert.equal(database.getCanvas(canvasId).revision, 3);
  assert.deepEqual(database.getCanvas(canvasId).nodes[0].position, { x: 25, y: 30 });
  assert.equal(JSON.parse(fs.readFileSync(canvasFile, 'utf8')).revision, 1);

  const restoreResponse = await requestWithCanvasMirrorFailure(
    `${baseUrl}/${encodeURIComponent(canvasId)}/history/1/restore`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: 3 }),
    },
  );
  const restorePayload = await restoreResponse.json();
  assert.equal(restoreResponse.status, 200, JSON.stringify(restorePayload));
  assert.equal(restorePayload.data.revision, 4);
  assert.deepEqual(restorePayload.warnings, [COMMITTED_MIRROR_WARNING]);
  assert.equal(database.getCanvas(canvasId).revision, 4);
  assert.deepEqual(database.getCanvas(canvasId).nodes, []);
  assert.equal(JSON.parse(fs.readFileSync(canvasFile, 'utf8')).revision, 1);
  assert.equal(JSON.parse(fs.readFileSync(listFile, 'utf8'))[0].revision, 4);
});
