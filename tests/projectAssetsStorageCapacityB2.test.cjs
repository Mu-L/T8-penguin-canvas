'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');

const {
  ProjectDatabaseStorageCapacityError,
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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('B2 Project Asset write routes redact raw and typed capacity failures while preserving asset conflicts', async (t) => {
  const privateMessage = 'database full at C:\\Users\\private-user\\projects.sqlite3 token=never-expose';
  const capacityOperations = [];

  const rawFullError = () => Object.assign(new Error(privateMessage), {
    code: 'SQLITE_FULL',
    path: 'C:\\Users\\private-user\\projects.sqlite3',
  });
  const typedCapacityError = () => Object.assign(
    new ProjectDatabaseStorageCapacityError('filesystem-reserve', {
      operation: 'private.asset.service.operation',
    }),
    {
      path: 'C:\\Users\\private-user\\projects.sqlite3',
      privateToken: 'never-expose',
    },
  );

  const database = {
    createAssetCollection(input) {
      if (input?.fixture === 'raw-full') throw rawFullError();
      throw new Error(`unexpected collection fixture ${String(input?.fixture)}`);
    },
    applyAssetBatch(projectId, input) {
      if (input?.fixture === 'typed-capacity') throw typedCapacityError();
      if (input?.fixture === 'asset-conflict') {
        const error = new Error('素材批次幂等键已绑定其他请求');
        error.code = 'asset_batch_idempotency_conflict';
        error.current = { projectId, catalogRevision: 7, privatePath: 'C:\\Users\\private-user' };
        throw error;
      }
      throw new Error(`unexpected batch fixture ${String(input?.fixture)}`);
    },
    refreshAssetDuplicateCandidates() {
      throw rawFullError();
    },
    listAssetDuplicates() {
      throw rawFullError();
    },
  };

  const restores = [
    installModuleMock('../backend/src/config', {
      INPUT_DIR: 'C:\\t8-test-input',
      OUTPUT_DIR: 'C:\\t8-test-output',
    }),
    installModuleMock('../backend/src/services/projectDatabase', {
      getProjectDatabase: () => database,
      ProjectDatabaseStorageCapacityError,
      translateProjectDatabaseStorageCapacityError(error, details) {
        capacityOperations.push(details?.operation);
        return translateProjectDatabaseStorageCapacityError(error, details);
      },
    }),
    installModuleMock('../backend/src/services/assetPreviewPipeline', {
      getAssetPreviewPipeline: () => ({ status: () => ({}) }),
    }),
    installModuleMock('../backend/src/services/assetIndexer', {
      getBackgroundAssetIndexer: () => ({ status: () => ({}) }),
    }),
    installModuleMock('../backend/src/services/assetBlobStore', {
      getAssetBlobStore: () => ({ isBlobPath: () => false }),
    }),
    installModuleMock('../backend/src/services/assetSemanticPipeline', {
      getAssetSemanticPipeline: () => ({}),
      normalizeSemanticText: (value) => String(value || ''),
    }),
  ];

  const publicErrorPath = require.resolve('../backend/src/services/projectDatabasePublicError');
  const routePath = require.resolve('../backend/src/routes/projectAssets');
  const previousPublicError = require.cache[publicErrorPath];
  const previousRoute = require.cache[routePath];
  delete require.cache[publicErrorPath];
  delete require.cache[routePath];
  const router = require(routePath);

  const app = express();
  app.use(express.json({ strict: true }));
  app.use('/api/project-assets', router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/project-assets`;

  t.after(async () => {
    await closeServer(server);
    delete require.cache[routePath];
    delete require.cache[publicErrorPath];
    restores.reverse().forEach((restore) => restore());
    if (previousRoute) require.cache[routePath] = previousRoute;
    if (previousPublicError) require.cache[publicErrorPath] = previousPublicError;
  });

  const raw = await postJson(`${baseUrl}/collections`, { fixture: 'raw-full' });
  assert.equal(raw.response.status, 507, JSON.stringify(raw.body));
  assert.deepEqual(raw.body, {
    success: false,
    code: 'project_database_storage_capacity_exceeded',
    error: '项目数据库或 SQLite 临时存储空间不足，本次写入已回滚',
    reason: 'sqlite-full',
    retryable: false,
  });

  const typed = await postJson(`${baseUrl}/batch`, {
    projectId: 'project-asset-route-capacity-b2',
    fixture: 'typed-capacity',
  });
  assert.equal(typed.response.status, 507, JSON.stringify(typed.body));
  assert.deepEqual(typed.body, {
    success: false,
    code: 'project_database_storage_capacity_exceeded',
    error: '项目数据库所在文件系统空间或配额不足，本次操作未完成',
    reason: 'filesystem-reserve',
    retryable: false,
  });

  const conflict = await postJson(`${baseUrl}/batch`, {
    projectId: 'project-asset-route-capacity-b2',
    fixture: 'asset-conflict',
  });
  assert.equal(conflict.response.status, 409, JSON.stringify(conflict.body));
  assert.deepEqual(conflict.body, {
    success: false,
    error: '素材批次幂等键已绑定其他请求',
    code: 'asset_batch_idempotency_conflict',
    current: {
      projectId: 'project-asset-route-capacity-b2',
      catalogRevision: 7,
    },
  });

  const duplicateRefresh = await postJson(`${baseUrl}/asset-capacity/duplicates/refresh`, {
    expectedCatalogRevision: 7,
  });
  assert.equal(duplicateRefresh.response.status, 507, JSON.stringify(duplicateRefresh.body));
  assert.deepEqual(duplicateRefresh.body, {
    success: false,
    code: 'project_database_storage_capacity_exceeded',
    error: '项目数据库或 SQLite 临时存储空间不足，本次写入已回滚',
    reason: 'sqlite-full',
    retryable: false,
  });

  const duplicateListResponse = await fetch(`${baseUrl}/asset-capacity/duplicates?mode=exact`);
  const duplicateListBody = await duplicateListResponse.json();
  assert.equal(duplicateListResponse.status, 507, JSON.stringify(duplicateListBody));
  assert.deepEqual(duplicateListBody, {
    success: false,
    code: 'project_database_storage_capacity_exceeded',
    error: '项目数据库或 SQLite 临时存储空间不足，本次写入已回滚',
    reason: 'sqlite-full',
    retryable: false,
  });

  for (const body of [raw.body, typed.body]) {
    assert.doesNotMatch(
      JSON.stringify(body),
      /Users|private-user|projects\.sqlite3|token|never-expose|private\.asset\.service/i,
    );
  }
  assert.deepEqual(capacityOperations, [
    'asset.collection.create',
    'asset.batch',
    'asset.batch',
    'asset.duplicate.refresh',
    'asset.duplicate.list',
  ]);
});
