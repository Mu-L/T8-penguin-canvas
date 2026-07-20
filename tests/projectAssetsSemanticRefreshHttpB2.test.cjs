'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: options.headers,
    ...(Object.hasOwn(options, 'body')
      ? { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }
      : {}),
  });
  const payload = JSON.parse(await response.text());
  return { response, payload };
}

function rawStatus(projectId) {
  const capability = (modelKey) => ({ enabled: false, modelKey, modelVersion: 'fixed-v1' });
  return {
    projectId,
    profile: {
      projectId,
      revision: 0,
      enabled: false,
      caption: capability('caption-blip-base'),
      ocr: capability('ocr-paddleocr-v4'),
      embedding: capability('embedding-multilingual-minilm-l12-v2'),
      activeGeneration: 0,
      buildingGeneration: null,
      updatedAt: null,
    },
    models: [],
    building: null,
    failedGeneration: null,
    activeGenerationRecord: null,
    currentCatalogRevision: 1,
    indexStale: false,
    jobs: { byCapability: {} },
  };
}

test('B2 semantic model refresh is one trusted JSON POST while status remains pure GET', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-semantic-refresh-http-'));
  const previousPackaged = process.env.T8PC_PACKAGED;
  const previousUserData = process.env.T8PC_USER_DATA;
  const previousManagementToken = process.env.T8_COLLAB_MANAGEMENT_TOKEN;
  const previousDevPort = process.env.T8_DEV_FRONTEND_PORT;
  process.env.T8PC_PACKAGED = '1';
  process.env.T8PC_USER_DATA = directory;
  process.env.T8_COLLAB_MANAGEMENT_TOKEN = 'A'.repeat(43);
  process.env.T8_DEV_FRONTEND_PORT = '11422';

  const config = require('../backend/src/config');
  const originalConfigPackaged = config.IS_PACKAGED;
  const router = require('../backend/src/routes/projectAssets');
  const { getProjectDatabase } = require('../backend/src/services/projectDatabase');
  const database = getProjectDatabase(config);
  const pipeline = router.semanticPipeline;
  const originalRefresh = pipeline.refreshModelStates;
  const originalStatus = pipeline.status;
  let refreshCalls = 0;
  let statusCalls = 0;
  pipeline.refreshModelStates = async () => { refreshCalls += 1; };
  pipeline.status = async (projectId) => {
    statusCalls += 1;
    return rawStatus(projectId);
  };

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/project-assets', router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/project-assets`;

  try {
    const read = await requestJson(baseUrl, '/semantic/status?projectId=project%2Fread');
    assert.equal(read.response.status, 200);
    assert.equal(read.payload.data.project.projectId, 'project/read');
    assert.equal(refreshCalls, 0, 'GET status must never invoke maintenance');
    assert.equal(statusCalls, 1);

    const form = await requestJson(baseUrl, '/semantic/models/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: new URL(baseUrl).origin,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: 'projectId=project%2Fform',
    });
    assert.equal(form.response.status, 415);
    assert.equal(form.payload.code, 'semantic_json_required');
    assert.equal(refreshCalls, 0);

    const hostile = await requestJson(baseUrl, '/semantic/models/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: { projectId: 'project/hostile' },
    });
    assert.equal(hostile.response.status, 403);
    assert.equal(hostile.payload.code, 'trusted_loopback_required');
    assert.equal(refreshCalls, 0);

    const hostileLoopbackOrigin = await requestJson(baseUrl, '/semantic/models/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:59999',
        'Sec-Fetch-Site': 'same-site',
      },
      body: { projectId: 'project/hostile-loopback' },
    });
    assert.equal(hostileLoopbackOrigin.response.status, 403);
    assert.equal(hostileLoopbackOrigin.payload.code, 'trusted_loopback_required');
    assert.equal(refreshCalls, 0, 'an unrelated localhost page is not a trusted management origin');

    const packagedDevOrigin = await requestJson(baseUrl, '/semantic/models/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:11422',
        'Sec-Fetch-Site': 'same-site',
      },
      body: { projectId: 'project/dev-origin' },
    });
    assert.equal(packagedDevOrigin.response.status, 403);
    assert.equal(packagedDevOrigin.payload.code, 'trusted_loopback_required');
    assert.equal(refreshCalls, 0, 'packaged builds must not trust the known Vite port');

    config.IS_PACKAGED = false;
    const configuredDevOrigin = await requestJson(baseUrl, '/semantic/models/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:11422',
        'Sec-Fetch-Site': 'same-site',
      },
      body: { projectId: 'project/dev-origin' },
    });
    config.IS_PACKAGED = originalConfigPackaged;
    assert.equal(configuredDevOrigin.response.status, 200);
    assert.equal(configuredDevOrigin.payload.data.project.projectId, 'project/dev-origin');
    assert.equal(refreshCalls, 1);
    assert.equal(statusCalls, 2);

    const refreshed = await requestJson(baseUrl, '/semantic/models/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { projectId: 'project/explicit' },
    });
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshCalls, 2);
    assert.equal(statusCalls, 3);
    assert.equal(refreshed.payload.data.project.projectId, 'project/explicit');
    assert.deepEqual(Object.keys(refreshed.payload.data).sort(), ['models', 'project', 'rebuild', 'worker']);

    pipeline.refreshModelStates = async () => {
      refreshCalls += 1;
      throw Object.assign(new Error('C:\\private\\semantic.sqlite3 token=never-expose'), { code: 'SQLITE_FULL' });
    };
    const full = await requestJson(baseUrl, '/semantic/models/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { projectId: 'project/full' },
    });
    assert.equal(full.response.status, 507);
    assert.equal(full.payload.code, 'project_database_storage_capacity_exceeded');
    assert.equal(refreshCalls, 3);
    assert.equal(statusCalls, 3, 'failed maintenance must not publish a mixed status response');
    assert.doesNotMatch(JSON.stringify(full.payload), /private|semantic\.sqlite3|token/i);

    pipeline.refreshModelStates = async () => {
      refreshCalls += 1;
      throw Object.assign(new Error('stale observation'), { code: 'asset_semantic_models_sync_conflict' });
    };
    const conflict = await requestJson(baseUrl, '/semantic/models/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { projectId: 'project/conflict' },
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(refreshCalls, 4, 'the HTTP boundary must not replay a conflicting maintenance POST');
    assert.equal(statusCalls, 3);

    const routeSource = fs.readFileSync(path.resolve(__dirname, '../backend/src/routes/projectAssets.js'), 'utf8');
    assert.match(routeSource, /sendProjectDatabaseStorageCapacityError\(res, error, \{ operation: 'asset\.semantic\.models\.sync' \}\)/);
  } finally {
    config.IS_PACKAGED = originalConfigPackaged;
    pipeline.status = originalStatus;
    if (originalRefresh) pipeline.refreshModelStates = originalRefresh;
    else delete pipeline.refreshModelStates;
    await new Promise((resolve) => server.close(resolve));
    pipeline.close();
    if (database?.db?.open) await database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    if (previousPackaged == null) delete process.env.T8PC_PACKAGED;
    else process.env.T8PC_PACKAGED = previousPackaged;
    if (previousUserData == null) delete process.env.T8PC_USER_DATA;
    else process.env.T8PC_USER_DATA = previousUserData;
    if (previousManagementToken == null) delete process.env.T8_COLLAB_MANAGEMENT_TOKEN;
    else process.env.T8_COLLAB_MANAGEMENT_TOKEN = previousManagementToken;
    if (previousDevPort == null) delete process.env.T8_DEV_FRONTEND_PORT;
    else process.env.T8_DEV_FRONTEND_PORT = previousDevPort;
  }
});

test('server starts semantic maintenance once after listen without awaiting it on the listen path', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../backend/src/server.js'), 'utf8');
  assert.match(
    source,
    /const server = app\.listen\([\s\S]*setImmediate\(\(\) => \{[\s\S]*startupSemanticModelRefreshPromise = Promise\.resolve\(\)[\s\S]*semanticPipeline\.refreshModelStates\(\)/,
  );
  assert.match(source, /await Promise\.resolve\(startupSemanticModelRefreshPromise\);[\s\S]*await closeProjectDatabaseLifecycle\(\);/);
  assert.doesNotMatch(source, /await\s+projectAssetsRouter\.semanticPipeline\.refreshModelStates\(\)/);
});
