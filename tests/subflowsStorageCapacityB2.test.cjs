'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  translateProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');

function installModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  const previous = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
  return () => {
    if (previous) require.cache[resolved] = previous;
    else delete require.cache[resolved];
  };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function definition(id) {
  return {
    id,
    projectId: 'project-subflow-route-capacity-b2',
    name: id,
    description: '',
    tags: [],
    nodes: [{
      id: `${id}-text`,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { text: id },
    }],
    edges: [],
    inputs: [],
    outputs: [],
    exposedParameters: [],
    requiredCapabilities: [],
    assetRefs: [],
    changeSummary: `publish ${id}`,
  };
}

test('B2 subflow write routes redact raw SQLITE_FULL after compensation and preserve legacy 400/409 responses', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-subflow-route-capacity-b2-'));
  const runtimeConfig = {
    INPUT_DIR: path.join(directory, 'input'),
    OUTPUT_DIR: path.join(directory, 'output'),
    THUMBNAILS_DIR: path.join(directory, 'thumbnails'),
    THUMBNAIL_SIZE: 160,
    THUMBNAIL_QUALITY: 80,
  };
  for (const item of [runtimeConfig.INPUT_DIR, runtimeConfig.OUTPUT_DIR, runtimeConfig.THUMBNAILS_DIR]) {
    fs.mkdirSync(item, { recursive: true });
  }

  const privateMessage = 'database full at C:\\Users\\private-user\\projects.sqlite3 token=never-expose';
  const archiveSha256 = 'a'.repeat(64);
  const assetContent = Buffer.from('portable imported asset');
  const assetSha256 = crypto.createHash('sha256').update(assetContent).digest('hex');
  const capacityOperations = [];
  const assetMutations = [];

  class FakeSubflowRevisionConflictError extends Error {
    constructor() {
      super('子工作流已被其他编辑更新');
      this.code = 'subflow_revision_conflict';
      this.current = { revision: 7 };
    }
  }

  function rawFullError() {
    return Object.assign(new Error(privateMessage), {
      code: 'SQLITE_FULL',
      path: 'C:\\Users\\private-user\\projects.sqlite3',
    });
  }

  const database = {
    getSubflowDefinitionHead() {
      return null;
    },
    saveSubflowDefinition(value) {
      if (value.id === 'publish-full' || value.id === 'import-full') throw rawFullError();
      if (value.id === 'publish-ordinary') throw new Error('ordinary subflow publish failure');
      if (value.id === 'publish-conflict') throw new FakeSubflowRevisionConflictError();
      if (value.id === 'publish-broadcast-fail') {
        return {
          ...value,
          version: 1,
          revision: 1,
          publishedBy: 'local-owner',
          publishedAt: 1,
        };
      }
      throw new Error(`unexpected definition ${String(value.id)}`);
    },
    getAsset() {
      return null;
    },
    upsertAsset(value) {
      assetMutations.push(`upsert:${value.id}`);
      return { ...value };
    },
    removeAssetIndex(id) {
      assetMutations.push(`remove:${id}`);
      return true;
    },
  };

  const restores = [
    installModuleMock('../backend/src/config', runtimeConfig),
    installModuleMock('../backend/src/services/projectDatabase', {
      getProjectDatabase: () => database,
      SubflowRevisionConflictError: FakeSubflowRevisionConflictError,
      translateProjectDatabaseStorageCapacityError(error, details) {
        capacityOperations.push(details?.operation);
        return translateProjectDatabaseStorageCapacityError(error, details);
      },
    }),
    installModuleMock('../backend/src/collaboration/gateway', {
      getCollaborationGateway: () => ({
        broadcastSubflowPublication(_projectId, id) {
          if (id === 'publish-broadcast-fail') {
            throw new Error('C:\\Users\\private-user\\broadcast-secret must not alter commit truth');
          }
        },
      }),
    }),
    installModuleMock('../backend/src/services/assetPreviewPipeline', {
      getAssetPreviewPipeline: () => null,
    }),
    installModuleMock('../backend/src/services/assetIndexer', {
      createDerivedMedia: async () => ({}),
      extensionInfo: () => ({ extension: '.txt', kind: 'document', mimeType: 'text/plain' }),
      previewStatePatchForJob: () => ({}),
      readMetadata: async (_filename, _kind, stat) => ({ health: 'healthy', size: stat.size }),
      stableAssetId: () => 'imported-asset-capacity-b2',
    }),
    installModuleMock('../backend/src/services/subflowPackage', {
      DEFAULT_LIMITS: { archiveBytes: 1024 * 1024 },
      containsPlaintextSecret: () => false,
      createSubflowPackage: async () => Buffer.alloc(0),
      hydrateDependencyDefinitions: (value) => value,
      importSubflowPackage: async () => ({
        archiveSha256,
        definition: definition('import-full'),
        dependencies: [],
        assets: [{
          path: 'assets/reference.txt',
          assetRef: 'portable-asset',
          content: assetContent,
          sha256: assetSha256,
          license: 'CC0-1.0',
          redistributable: true,
        }],
      }),
      inspectSubflowPackage: async () => ({}),
    }),
  ];

  const publicErrorPath = require.resolve('../backend/src/services/projectDatabasePublicError');
  const routePath = require.resolve('../backend/src/routes/subflows');
  const previousPublicError = require.cache[publicErrorPath];
  const previousRoute = require.cache[routePath];
  delete require.cache[publicErrorPath];
  delete require.cache[routePath];
  const router = require(routePath);

  const app = express();
  app.use(express.json({ strict: true }));
  app.use('/api/subflows', router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/subflows`;

  t.after(async () => {
    await closeServer(server);
    delete require.cache[routePath];
    delete require.cache[publicErrorPath];
    restores.reverse().forEach((restore) => restore());
    if (previousRoute) require.cache[routePath] = previousRoute;
    if (previousPublicError) require.cache[publicErrorPath] = previousPublicError;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const fullResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(definition('publish-full')),
  });
  const fullBody = await fullResponse.json();
  assert.equal(fullResponse.status, 507, JSON.stringify(fullBody));
  assert.deepEqual(fullBody, {
    success: false,
    code: 'project_database_storage_capacity_exceeded',
    error: '项目数据库或 SQLite 临时存储空间不足，本次写入已回滚',
    reason: 'sqlite-full',
    retryable: false,
  });
  assert.doesNotMatch(JSON.stringify(fullBody), /Users|private-user|projects\.sqlite3|token|never-expose/i);

  const ordinaryResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(definition('publish-ordinary')),
  });
  assert.equal(ordinaryResponse.status, 400);
  assert.deepEqual(await ordinaryResponse.json(), {
    success: false,
    error: 'ordinary subflow publish failure',
  });

  const conflictResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(definition('publish-conflict')),
  });
  assert.equal(conflictResponse.status, 409);
  assert.deepEqual(await conflictResponse.json(), {
    success: false,
    code: 'subflow_revision_conflict',
    error: '子工作流已被其他编辑更新',
    data: { revision: 7 },
  });

  const broadcastFailureResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(definition('publish-broadcast-fail')),
  });
  const broadcastFailureBody = await broadcastFailureResponse.json();
  assert.equal(broadcastFailureResponse.status, 201, JSON.stringify(broadcastFailureBody));
  assert.equal(broadcastFailureBody.success, true);
  assert.equal(broadcastFailureBody.data.id, 'publish-broadcast-fail');
  assert.deepEqual(broadcastFailureBody.warnings, [{
    code: 'subflow_publication_broadcast_failed',
    message: '子工作流已成功保存，但实时协作通知暂未送达；客户端可通过版本列表重新同步。',
  }]);
  assert.doesNotMatch(JSON.stringify(broadcastFailureBody), /Users|private-user|broadcast-secret/i);

  const form = new FormData();
  form.append('archiveSha256', archiveSha256);
  form.append('projectId', 'project-subflow-route-capacity-b2');
  form.append('file', new Blob([Buffer.from('mock t8flow archive')]), 'portable.t8flow');
  const importResponse = await fetch(`${baseUrl}/package/import`, {
    method: 'POST',
    body: form,
  });
  const importBody = await importResponse.json();
  assert.equal(importResponse.status, 507, JSON.stringify(importBody));
  assert.equal(importBody.code, 'project_database_storage_capacity_exceeded');
  assert.equal(importBody.reason, 'sqlite-full');
  assert.doesNotMatch(JSON.stringify(importBody), /Users|private-user|projects\.sqlite3|token|never-expose/i);
  assert.deepEqual(assetMutations, [
    'upsert:imported-asset-capacity-b2',
    'remove:imported-asset-capacity-b2',
  ]);
  const importedRoot = path.join(runtimeConfig.INPUT_DIR, 'subflows', archiveSha256.slice(0, 16));
  assert.deepEqual(fs.readdirSync(importedRoot), []);
  assert.deepEqual(capacityOperations, [
    'subflow.definition.publish',
    'subflow.definition.publish',
    'subflow.definition.publish',
    'subflow.package.import',
  ]);
});
