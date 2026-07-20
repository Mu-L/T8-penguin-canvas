'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const express = require('express');

const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

test('production local server marks the exact canvas sync path no-store before CORS and Origin rejection', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../backend/src/server.js'), 'utf8');
  const predicate = source.indexOf('function isLocalCanvasSyncPath(req)');
  const noStore = source.indexOf("if (isLocalCanvasSyncPath(req)) res.set('Cache-Control', 'no-store');");
  const corsBoundary = source.indexOf('app.use(cors({');
  const originBoundary = source.indexOf("const origin = String(req.get('origin') || '').trim();");
  assert.ok(predicate >= 0, 'local canvas sync path predicate is missing');
  assert.ok(noStore > predicate, 'local canvas sync no-store middleware is missing');
  assert.ok(corsBoundary > noStore, 'local sync no-store must run before CORS');
  assert.ok(originBoundary > noStore, 'local sync no-store must run before Origin rejection');
});

function readFileBytes(filename) {
  return fs.existsSync(filename) ? fs.readFileSync(filename) : null;
}

function readSqliteBytes(filename) {
  return {
    main: readFileBytes(filename),
    wal: readFileBytes(`${filename}-wal`),
  };
}

function assertSqliteBytesEqual(actual, expected, message) {
  assert.deepEqual(actual.main, expected.main, `${message}: main database changed`);
  assert.deepEqual(actual.wal, expected.wal, `${message}: WAL changed`);
}

async function createLocalSyncFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-canvas-sync-purity-b2-'));
  const dataDirectory = path.join(directory, 'data');
  const canvasId = options.canvasId || 'canvas-sync-purity-b2';
  const databaseFilename = path.join(dataDirectory, 'projects.sqlite3');
  const generationFilename = `${databaseFilename}.recovery-generation.json`;
  const canvasFilename = path.join(dataDirectory, `canvas_${canvasId}.json`);
  const canvasListFilename = path.join(dataDirectory, 'canvas_list.json');
  fs.mkdirSync(dataDirectory, { recursive: true });

  const database = new ProjectDatabase(databaseFilename, { autoBackup: false });
  const legacyDocument = {
    projectId: 'project-local',
    nodes: [{ id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: { text: 'read only' } }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  let authoritativeDocument = null;
  if (options.materialized === true) {
    authoritativeDocument = database.ensureCanvas(canvasId, legacyDocument, 'project-local');
    fs.writeFileSync(canvasFilename, JSON.stringify(authoritativeDocument), 'utf8');
  } else {
    fs.writeFileSync(canvasFilename, JSON.stringify(legacyDocument), 'utf8');
  }
  fs.writeFileSync(canvasListFilename, JSON.stringify([{
    id: canvasId,
    name: 'Canvas sync purity',
    nodeCount: 1,
    revision: authoritativeDocument?.revision,
    createdAt: 1,
    updatedAt: 1,
  }]), 'utf8');

  assert.equal(fs.existsSync(generationFilename), true, 'persistent startup must bootstrap the sidecar');

  const config = require('../backend/src/config');
  const previousConfig = {
    DATA_DIR: config.DATA_DIR,
    CANVAS_FILE: config.CANVAS_FILE,
    SETTINGS_FILE: config.SETTINGS_FILE,
  };
  Object.assign(config, {
    DATA_DIR: dataDirectory,
    CANVAS_FILE: canvasListFilename,
    SETTINGS_FILE: path.join(dataDirectory, 'settings.json'),
  });

  const servicePath = require.resolve('../backend/src/services/projectDatabase');
  const routePath = require.resolve('../backend/src/routes/canvas');
  const serviceModule = require.cache[servicePath];
  const previousGetProjectDatabase = serviceModule.exports.getProjectDatabase;
  const previousRouteModule = require.cache[routePath];
  serviceModule.exports.getProjectDatabase = () => database;
  delete require.cache[routePath];

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/canvas', require(routePath));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/canvas/${canvasId}/sync`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (database.db?.open) {
      try { database.db.pragma('query_only = OFF'); } catch (_) { /* already closing */ }
    }
    await database.close();
    Object.assign(config, previousConfig);
    serviceModule.exports.getProjectDatabase = previousGetProjectDatabase;
    delete require.cache[routePath];
    if (previousRouteModule) require.cache[routePath] = previousRouteModule;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  return {
    baseUrl,
    canvasFilename,
    canvasId,
    database,
    databaseFilename,
    generationFilename,
  };
}

test('B2 materialized local canvas sync is no-store and remains pure under SQLite query_only', async (t) => {
  const fixture = await createLocalSyncFixture(t, { materialized: true });
  const generation = fixture.database.getRecoveryGeneration();
  const sqliteBefore = readSqliteBytes(fixture.databaseFilename);
  const generationBefore = fs.readFileSync(fixture.generationFilename);
  const mirrorBefore = fs.readFileSync(fixture.canvasFilename);
  const changesBefore = fixture.database.db.totalChanges;
  let ensureCalls = 0;
  fixture.database.ensureCanvas = () => {
    ensureCalls += 1;
    throw new Error('GET sync must not materialize a canvas');
  };

  fixture.database.db.pragma('query_only = ON');
  const synced = await fetch(`${fixture.baseUrl}?afterRevision=0&generation=${generation}`);
  const syncedPayload = await synced.json();
  assert.equal(synced.status, 200, JSON.stringify(syncedPayload));
  assert.equal(synced.headers.get('cache-control'), 'no-store');
  assert.equal(syncedPayload.data.mode, 'snapshot');
  assert.equal(syncedPayload.data.generation, generation);

  const malformed = await fetch(`${fixture.baseUrl}?afterRevision=0&generation=not-a-uuid`);
  const malformedPayload = await malformed.json();
  assert.equal(malformed.status, 400, JSON.stringify(malformedPayload));
  assert.equal(malformed.headers.get('cache-control'), 'no-store');
  assert.equal(malformedPayload.code, 'canvas_generation_invalid');

  const repeated = await fetch(`${fixture.baseUrl}?generation=${generation}&generation=${generation}`);
  const repeatedPayload = await repeated.json();
  assert.equal(repeated.status, 400, JSON.stringify(repeatedPayload));
  assert.equal(repeatedPayload.code, 'canvas_generation_invalid');
  assert.equal(repeated.headers.get('cache-control'), 'no-store');

  assert.equal(ensureCalls, 0);
  assert.equal(fixture.database.db.totalChanges, changesBefore);
  assert.deepEqual(fs.readFileSync(fixture.canvasFilename), mirrorBefore);
  assert.deepEqual(fs.readFileSync(fixture.generationFilename), generationBefore);
  assertSqliteBytesEqual(readSqliteBytes(fixture.databaseFilename), sqliteBefore, 'materialized GET sync');
});

test('B2 legacy-only local canvas sync fails closed without hydrating or changing durable bytes', async (t) => {
  const fixture = await createLocalSyncFixture(t, { materialized: false });
  const sqliteBefore = readSqliteBytes(fixture.databaseFilename);
  const generationBefore = fs.readFileSync(fixture.generationFilename);
  const mirrorBefore = fs.readFileSync(fixture.canvasFilename);
  const changesBefore = fixture.database.db.totalChanges;
  let ensureCalls = 0;
  fixture.database.ensureCanvas = () => {
    ensureCalls += 1;
    throw new Error('legacy GET sync must not hydrate SQLite');
  };

  fixture.database.db.pragma('query_only = ON');
  const response = await fetch(`${fixture.baseUrl}?afterRevision=0`);
  const payload = await response.json();
  assert.equal(response.status, 409, JSON.stringify(payload));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(payload, {
    success: false,
    code: 'canvas_sync_materialization_required',
    error: '旧画布尚未完成 SQLite 物化，请先通过画布保存流程完成迁移后再同步',
  });
  assert.doesNotMatch(JSON.stringify(payload), /projects\.sqlite3|canvas_sync-purity|[A-Z]:\\|\/tmp\//i);

  const malformed = await fetch(`${fixture.baseUrl}?generation=malformed`);
  const malformedPayload = await malformed.json();
  assert.equal(malformed.status, 400, JSON.stringify(malformedPayload));
  assert.equal(malformed.headers.get('cache-control'), 'no-store');
  assert.equal(malformedPayload.code, 'canvas_generation_invalid');

  assert.equal(ensureCalls, 0);
  assert.equal(fixture.database.getCanvas(fixture.canvasId), null);
  assert.equal(fixture.database.db.totalChanges, changesBefore);
  assert.deepEqual(fs.readFileSync(fixture.canvasFilename), mirrorBefore);
  assert.deepEqual(fs.readFileSync(fixture.generationFilename), generationBefore);
  assertSqliteBytesEqual(readSqliteBytes(fixture.databaseFilename), sqliteBefore, 'legacy-only GET sync');
});
