'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectDatabaseService = require('../backend/src/services/projectDatabase');
const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
  translateProjectDatabaseStorageCapacityError,
} = projectDatabaseService;

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

async function deleteJson(url, body) {
  const response = await fetch(url, {
    method: 'DELETE',
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  return { response, body: await response.json() };
}

function hashFor(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function deleteRequestBody(asset) {
  if (!asset.entityUid) asset.entityUid = `entity-${asset.id}`;
  if (!Number.isSafeInteger(Number(asset.contentRevision))) asset.contentRevision = 1;
  return {
    deleteFile: true,
    confirmFilename: asset.filename,
    expectedEntityUid: asset.entityUid,
    expectedContentRevision: asset.contentRevision,
    expectedContentHash: asset.contentHash,
  };
}

function capacityBody(reason, error) {
  return {
    success: false,
    code: 'project_database_storage_capacity_exceeded',
    error,
    reason,
    retryable: false,
  };
}

function warning(phase, reason) {
  return {
    code: 'asset_delete_cleanup_pending',
    committed: true,
    phase,
    ...(reason ? { reason } : {}),
    retryable: false,
    reconciliationPending: true,
  };
}

test('B2 Project Asset delete routes keep precommit capacity atomic and postcommit cleanup warnings safe', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-project-assets-delete-capacity-b2-'));
  const inputRoot = path.join(directory, 'input');
  const outputRoot = path.join(directory, 'output');
  const casRoot = path.join(directory, 'asset-blobs');
  fs.mkdirSync(inputRoot, { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(casRoot, { recursive: true });

  let currentDatabase = {
    getAsset: () => null,
    removeAssetIndex: () => null,
    assetBlobReferenceCount: () => 0,
    markAssetBlobDeleted: () => false,
  };
  let currentBlobStore = {
    isBlobPath: () => false,
    removeVerifiedBlob: async () => false,
  };
  const database = new Proxy({}, {
    get(_target, property) {
      const value = currentDatabase[property];
      return typeof value === 'function' ? value.bind(currentDatabase) : value;
    },
  });
  const blobStore = new Proxy({}, {
    get(_target, property) {
      const value = currentBlobStore[property];
      return typeof value === 'function' ? value.bind(currentBlobStore) : value;
    },
  });

  const restores = [
    installModuleMock('../backend/src/config', {
      INPUT_DIR: inputRoot,
      OUTPUT_DIR: outputRoot,
      ASSET_BLOB_DIR: casRoot,
    }),
    installModuleMock('../backend/src/services/projectDatabase', {
      getProjectDatabase: () => database,
      ProjectDatabaseStorageCapacityError,
      translateProjectDatabaseStorageCapacityError,
    }),
    installModuleMock('../backend/src/services/assetPreviewPipeline', {
      getAssetPreviewPipeline: () => ({ status: () => ({}), retryAsset: () => null }),
    }),
    installModuleMock('../backend/src/services/assetIndexer', {
      getBackgroundAssetIndexer: () => ({ status: () => ({}) }),
      hashFile: async (filename) => hashFor(fs.readFileSync(filename, 'utf8')),
    }),
    installModuleMock('../backend/src/services/assetBlobStore', {
      getAssetBlobStore: () => blobStore,
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
  const openedDatabases = [];

  t.after(async () => {
    await closeServer(server);
    for (const opened of openedDatabases) {
      try { await opened.close(); } catch (_) {}
    }
    delete require.cache[routePath];
    delete require.cache[publicErrorPath];
    restores.reverse().forEach((restore) => restore());
    if (previousRoute) require.cache[routePath] = previousRoute;
    if (previousPublicError) require.cache[publicErrorPath] = previousPublicError;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });

  await t.test('destructive delete routes require a trusted loopback Host/Origin and JSON body', async () => {
    let removeCalls = 0;
    currentDatabase = {
      getAsset: () => { throw new Error('untrusted requests must not read assets'); },
      removeAssetIndex: () => { removeCalls += 1; return null; },
    };
    const indexResponse = await fetch(`${baseUrl}/remote-index/index`, {
      method: 'DELETE',
      headers: { origin: 'https://attacker.example' },
    });
    assert.equal(indexResponse.status, 403);
    assert.deepEqual(await indexResponse.json(), {
      success: false,
      code: 'trusted_loopback_required',
      error: '删除素材只允许从主机本地操作',
    });
    const fileResponse = await fetch(`${baseUrl}/remote-file/file`, {
      method: 'DELETE',
      headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ deleteFile: true }),
    });
    assert.equal(fileResponse.status, 403);
    assert.equal(removeCalls, 0);
  });

  await t.test('index-only route explicitly retains a zero-reference managed CAS source', async () => {
    let capturedOptions = null;
    currentDatabase = {
      removeAssetIndex: (assetId, options) => {
        capturedOptions = options;
        return { id: assetId };
      },
    };
    const result = await deleteJson(`${baseUrl}/index-retains-source/index`);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.id, 'index-retains-source');
    assert.equal(result.body.data.fileDeleted, false);
    assert.deepEqual(capturedOptions, { scheduleBlobDelete: false });
  });

  await t.test('retained host-output evidence is a fixed 409 business conflict, not a generic 500', async () => {
    currentDatabase = {
      removeAssetIndex: () => {
        throw Object.assign(new Error('private retained run output'), {
          code: 'asset_delete_retained_run_output',
        });
      },
    };
    const result = await deleteJson(`${baseUrl}/retained-host-output/index`);
    assert.equal(result.response.status, 409);
    assert.deepEqual(result.body, {
      success: false,
      code: 'asset_delete_retained_run_output',
      error: '素材仍被运行输出证据引用，不能删除',
    });
  });

  await t.test('client-visible and server-read identity races return 409 before index or file deletion', async () => {
    const fileContents = 'identity-race-file-must-survive';
    const managedPath = path.join(inputRoot, 'identity-race.png');
    fs.writeFileSync(managedPath, fileContents);
    const asset = {
      id: 'asset-delete-identity-race',
      entityUid: 'entity-delete-identity-race',
      contentRevision: 2,
      filename: 'identity-race.png',
      managedPath,
      storageMode: 'managed',
      contentHash: hashFor(fileContents),
      metadata: { size: Buffer.byteLength(fileContents) },
    };
    let removeCalls = 0;
    currentDatabase = {
      getAsset: () => asset,
      removeAssetIndex: () => { removeCalls += 1; return asset; },
    };
    currentBlobStore = { isBlobPath: () => false };
    const stale = await deleteJson(`${baseUrl}/${asset.id}/file`, {
      ...deleteRequestBody(asset),
      expectedContentRevision: 1,
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.code, 'asset_delete_identity_conflict');
    assert.equal(removeCalls, 0);

    currentDatabase.removeAssetIndex = (_assetId, options) => {
      removeCalls += 1;
      assert.equal(options.scheduleBlobDelete, false);
      assert.deepEqual(options.expectedIdentity, {
        entityUid: asset.entityUid,
        contentRevision: asset.contentRevision,
        contentHash: asset.contentHash,
        filename: asset.filename,
        managedPath: asset.managedPath,
        storageMode: asset.storageMode,
      });
      throw Object.assign(new Error('private stale server snapshot'), { code: 'asset_delete_identity_conflict' });
    };
    const raced = await deleteJson(`${baseUrl}/${asset.id}/file`, deleteRequestBody(asset));
    assert.equal(raced.response.status, 409);
    assert.deepEqual(raced.body, {
      success: false,
      code: 'asset_delete_identity_conflict',
      error: '素材已变化，请刷新后重新确认删除',
    });
    assert.equal(removeCalls, 1);
    assert.equal(fs.readFileSync(managedPath, 'utf8'), fileContents);
  });

  await t.test('a CAS path bound to another hash fails closed before index or blob deletion', async () => {
    const asset = {
      id: 'asset-cas-path-hash-mismatch',
      filename: 'mismatch.png',
      managedPath: path.join(casRoot, 'sha256', 'bb', 'bb', 'b'.repeat(64)),
      storageMode: 'managed',
      contentHash: 'a'.repeat(64),
      metadata: { size: 64 },
    };
    let removeCalls = 0;
    let physicalCalls = 0;
    currentDatabase = {
      getAsset: () => asset,
      removeAssetIndex: () => { removeCalls += 1; return asset; },
    };
    currentBlobStore = {
      isBlobPath: () => true,
      resolvePath: () => path.join(casRoot, 'sha256', 'aa', 'aa', 'a'.repeat(64)),
      removeVerifiedBlob: async () => { physicalCalls += 1; return true; },
    };
    const result = await deleteJson(`${baseUrl}/${asset.id}/file`, deleteRequestBody(asset));
    assert.equal(result.response.status, 409);
    assert.equal(result.body.code, 'asset_delete_identity_conflict');
    assert.equal(removeCalls, 0);
    assert.equal(physicalCalls, 0);
  });

  await t.test('a non-ready CAS ledger conflict stays 409 and never begins physical deletion', async () => {
    const asset = {
      id: 'asset-cas-ledger-not-ready',
      filename: 'not-ready.png',
      managedPath: path.join(casRoot, 'sha256', 'cc', 'cc', 'c'.repeat(64)),
      storageMode: 'managed',
      contentHash: 'c'.repeat(64),
      metadata: { size: 64 },
    };
    let physicalCalls = 0;
    currentDatabase = {
      getAsset: () => asset,
      removeAssetIndex: (_assetId, options) => {
        assert.equal(options.requireVerifiedCasBlob, true);
        assert.equal(options.scheduleBlobDelete, true);
        throw Object.assign(new Error('private logical blob state'), {
          code: 'asset_delete_blob_identity_conflict',
        });
      },
    };
    currentBlobStore = {
      isBlobPath: () => true,
      resolvePath: () => asset.managedPath,
      removeVerifiedBlob: async () => { physicalCalls += 1; return true; },
    };
    const result = await deleteJson(`${baseUrl}/${asset.id}/file`, deleteRequestBody(asset));
    assert.equal(result.response.status, 409);
    assert.deepEqual(result.body, {
      success: false,
      code: 'asset_delete_blob_identity_conflict',
      error: 'CAS 素材存储状态已变化，请刷新或完成存储对账后重试',
    });
    assert.equal(physicalCalls, 0);
  });

  await t.test('index and file deletes map raw and typed precommit capacity to safe 507 without touching files', async () => {
    const privateMessage = `${directory}\\private-project.sqlite3 token=never-expose`;
    const raw = Object.assign(new Error(privateMessage), { code: 'SQLITE_FULL', privateToken: 'never-expose' });
    const typed = Object.assign(new ProjectDatabaseStorageCapacityError('filesystem-reserve', {
      operation: 'private.asset.delete',
    }), { privatePath: directory, privateToken: 'never-expose' });
    currentDatabase = {
      removeAssetIndex(assetId) {
        if (assetId === 'raw-index') throw raw;
        if (assetId === 'typed-index') throw typed;
        throw new Error(`unexpected index fixture ${assetId}`);
      },
    };
    const rawIndex = await deleteJson(`${baseUrl}/raw-index/index`);
    assert.equal(rawIndex.response.status, 507);
    assert.deepEqual(rawIndex.body, capacityBody(
      'sqlite-full',
      '项目数据库或 SQLite 临时存储空间不足，本次写入已回滚',
    ));
    const typedIndex = await deleteJson(`${baseUrl}/typed-index/index`);
    assert.equal(typedIndex.response.status, 507);
    assert.deepEqual(typedIndex.body, capacityBody(
      'filesystem-reserve',
      '项目数据库所在文件系统空间或配额不足，本次操作未完成',
    ));

    for (const [assetId, error] of [['raw-file', raw], ['typed-file', typed]]) {
      const filename = `${assetId}.png`;
      const managedPath = path.join(inputRoot, filename);
      fs.writeFileSync(managedPath, `preserve-${assetId}`);
      const asset = {
        id: assetId,
        filename,
        managedPath,
        storageMode: 'managed',
        contentHash: hashFor(`preserve-${assetId}`),
        metadata: { size: fs.statSync(managedPath).size },
      };
      currentDatabase = {
        getAsset: () => asset,
        removeAssetIndex: () => { throw error; },
      };
      currentBlobStore = { isBlobPath: () => false };
      const result = await deleteJson(`${baseUrl}/${assetId}/file`, deleteRequestBody(asset));
      assert.equal(result.response.status, 507, JSON.stringify(result.body));
      assert.equal(fs.readFileSync(managedPath, 'utf8'), `preserve-${assetId}`);
      assert.equal(JSON.stringify(result.body).includes(directory), false);
      assert.doesNotMatch(JSON.stringify(result.body), /private-project|never-expose|private\.asset/i);
    }
  });

  await t.test('real ON DELETE RESTRICT preserves a legacy file and index while the public 500 stays generic', async () => {
    const filename = 'foreign-key-business.png';
    const managedPath = path.join(inputRoot, filename);
    fs.writeFileSync(managedPath, 'foreign-key-file-must-survive');
    const databasePath = path.join(directory, 'foreign-key-project.sqlite3');
    const actual = new ProjectDatabase(databasePath, { autoBackup: false });
    openedDatabases.push(actual);
    const contentHash = hashFor('foreign-key-file-must-survive');
    const asset = actual.upsertAsset({
      id: 'asset-route-foreign-key',
      projectId: 'project-route-foreign-key',
      contentHash,
      contentHashVerification: 'verified',
      kind: 'image',
      mimeType: 'image/png',
      filename,
      managedPath,
      sourceUrl: '/files/input/foreign-key-business.png',
      storageMode: 'managed',
      availability: 'available',
      metadata: { size: fs.statSync(managedPath).size },
    });
    actual.db.exec(`
      CREATE TABLE asset_route_delete_restrict (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT
      );
    `);
    actual.db.prepare('INSERT INTO asset_route_delete_restrict(id, asset_id) VALUES (?, ?)')
      .run('private-restrict-owner', asset.id);
    currentDatabase = actual;
    currentBlobStore = { isBlobPath: () => false };

    const result = await deleteJson(`${baseUrl}/${asset.id}/file`, deleteRequestBody(asset));
    assert.equal(result.response.status, 500, JSON.stringify(result.body));
    assert.deepEqual(result.body, { success: false, error: '删除素材索引失败' });
    assert.equal(fs.readFileSync(managedPath, 'utf8'), 'foreign-key-file-must-survive');
    assert.ok(actual.getAsset(asset.id));
    assert.equal(actual.db.prepare('SELECT * FROM asset_lineage_tombstones WHERE id = ?').get(asset.id), undefined);
    assert.equal(JSON.stringify(result.body).includes(directory), false);
  });

  await t.test('legacy unlink failure is a committed 200 warning with a fixed non-replayable ABI', async () => {
    const managedPath = path.join(inputRoot, 'private-legacy-file-token-never-expose.png');
    const fileContents = 'legacy-file-must-remain-after-injected-unlink-failure';
    fs.writeFileSync(managedPath, fileContents);
    const asset = {
      id: 'asset-legacy-warning',
      filename: 'legacy-warning.png',
      managedPath,
      storageMode: 'managed',
      contentHash: hashFor(fileContents),
      metadata: { size: Buffer.byteLength(fileContents) },
    };
    let indexRemoved = false;
    currentDatabase = {
      getAsset: () => asset,
      removeAssetIndex: () => { indexRemoved = true; return asset; },
    };
    currentBlobStore = { isBlobPath: () => false };

    const originalUnlinkSync = fs.unlinkSync;
    let injectedUnlinkFailure = false;
    fs.unlinkSync = (filename) => {
      if (!injectedUnlinkFailure
        && path.basename(filename) === 'payload'
        && path.basename(path.dirname(filename)).startsWith('.t8-asset-delete-')) {
        injectedUnlinkFailure = true;
        throw Object.assign(new Error(`${directory} injected unlink failure`), { code: 'EPERM' });
      }
      return originalUnlinkSync(filename);
    };
    let result;
    try {
      result = await deleteJson(`${baseUrl}/${asset.id}/file`, deleteRequestBody(asset));
    } finally {
      fs.unlinkSync = originalUnlinkSync;
    }
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(indexRemoved, true);
    assert.deepEqual(result.body, {
      success: true,
      data: {
        id: asset.id,
        indexRemoved: true,
        fileDeleted: false,
        blobRetained: false,
        persistenceWarning: warning('legacy-file-delete'),
      },
    });
    assert.equal(fs.readFileSync(managedPath, 'utf8'), fileContents);
    assert.doesNotMatch(JSON.stringify(result.body), /private-legacy|never-expose|EISDIR|EPERM|Users/i);
  });

  await t.test('a final legacy path replacement is quarantined, reverified, and restored instead of deleted', async () => {
    const managedPath = path.join(inputRoot, 'legacy-final-replacement.png');
    const originalContents = 'legacy-verified-before-final-rename';
    const replacementContents = 'replacement-must-not-be-deleted';
    fs.writeFileSync(managedPath, originalContents);
    const asset = {
      id: 'asset-legacy-final-replacement',
      filename: 'legacy-final-replacement.png',
      managedPath,
      storageMode: 'managed',
      contentHash: hashFor(originalContents),
      metadata: { size: Buffer.byteLength(originalContents) },
    };
    let indexRemoved = false;
    currentDatabase = {
      getAsset: () => asset,
      removeAssetIndex: () => { indexRemoved = true; return asset; },
    };
    currentBlobStore = { isBlobPath: () => false };

    const originalRenameSync = fs.renameSync;
    let injected = false;
    fs.renameSync = (source, target) => {
      if (!injected && path.resolve(source) === path.resolve(managedPath)) {
        injected = true;
        fs.writeFileSync(managedPath, replacementContents);
      }
      return originalRenameSync(source, target);
    };
    let result;
    try {
      result = await deleteJson(`${baseUrl}/${asset.id}/file`, deleteRequestBody(asset));
    } finally {
      fs.renameSync = originalRenameSync;
    }
    assert.equal(result.response.status, 200);
    assert.equal(indexRemoved, true);
    assert.equal(result.body.data.indexRemoved, true);
    assert.equal(result.body.data.fileDeleted, false);
    assert.equal(result.body.data.persistenceWarning.phase, 'legacy-file-delete');
    assert.equal(fs.readFileSync(managedPath, 'utf8'), replacementContents);
    assert.equal(
      fs.readdirSync(inputRoot).some((name) => name.startsWith('.t8-asset-delete-')),
      false,
      'a safely restored replacement must not leave an empty quarantine directory',
    );
  });

  await t.test('quarantine recovery never overwrites a path recreated in the restore window', async () => {
    const managedPath = path.join(inputRoot, 'legacy-restore-race.png');
    const originalContents = 'legacy-object-moved-to-quarantine';
    const replacementContents = 'replacement-that-triggers-recovery';
    const concurrentContents = 'concurrent-file-must-survive';
    fs.writeFileSync(managedPath, originalContents);
    const asset = {
      id: 'asset-legacy-restore-race',
      filename: 'legacy-restore-race.png',
      managedPath,
      storageMode: 'managed',
      contentHash: hashFor(originalContents),
      metadata: { size: Buffer.byteLength(originalContents) },
    };
    currentDatabase = {
      getAsset: () => asset,
      removeAssetIndex: () => asset,
    };
    currentBlobStore = { isBlobPath: () => false };

    const originalRenameSync = fs.renameSync;
    const originalLinkSync = fs.linkSync;
    let replacementInjected = false;
    let competingCreateInjected = false;
    fs.renameSync = (source, target) => {
      if (!replacementInjected && path.resolve(source) === path.resolve(managedPath)) {
        replacementInjected = true;
        fs.writeFileSync(managedPath, replacementContents);
      }
      return originalRenameSync(source, target);
    };
    fs.linkSync = (source, target) => {
      if (!competingCreateInjected && path.resolve(target) === path.resolve(managedPath)) {
        competingCreateInjected = true;
        fs.writeFileSync(managedPath, concurrentContents, { flag: 'wx' });
      }
      return originalLinkSync(source, target);
    };
    let result;
    try {
      result = await deleteJson(`${baseUrl}/${asset.id}/file`, deleteRequestBody(asset));
    } finally {
      fs.renameSync = originalRenameSync;
      fs.linkSync = originalLinkSync;
    }
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.fileDeleted, false);
    assert.equal(result.body.data.persistenceWarning.phase, 'legacy-file-delete');
    assert.equal(fs.readFileSync(managedPath, 'utf8'), concurrentContents);
    const quarantineDirectory = fs.readdirSync(inputRoot)
      .find((name) => name.startsWith('.t8-asset-delete-'));
    assert.ok(quarantineDirectory, 'the displaced object must remain quarantined when no-replace restore loses the race');
    assert.equal(
      fs.readFileSync(path.join(inputRoot, quarantineDirectory, 'payload'), 'utf8'),
      replacementContents,
    );
  });

  await t.test('unsafe or changed legacy targets fail closed before the index transaction', async () => {
    for (const fixture of [
      {
        id: 'legacy-directory',
        prepare(target) { fs.mkdirSync(target, { recursive: true }); },
        contentHash: hashFor('directory-is-not-a-file'),
      },
      {
        id: 'legacy-content-changed',
        prepare(target) { fs.writeFileSync(target, 'new-bytes-at-old-path'); },
        contentHash: hashFor('indexed-old-bytes'),
      },
    ]) {
      const managedPath = path.join(inputRoot, fixture.id);
      fixture.prepare(managedPath);
      const asset = {
        id: `asset-${fixture.id}`,
        filename: fixture.id,
        managedPath,
        storageMode: 'managed',
        contentHash: fixture.contentHash,
        metadata: {},
      };
      let removeCalls = 0;
      currentDatabase = {
        getAsset: () => asset,
        removeAssetIndex: () => { removeCalls += 1; return asset; },
      };
      currentBlobStore = { isBlobPath: () => false };
      const result = await deleteJson(`${baseUrl}/${asset.id}/file`, deleteRequestBody(asset));
      assert.equal(result.response.status, 409, JSON.stringify(result.body));
      assert.deepEqual(result.body, {
        success: false,
        code: 'asset_delete_file_identity_conflict',
        error: '受管素材文件已变化或路径不安全，请刷新或重新索引后再删除',
      });
      assert.equal(removeCalls, 0);
      assert.equal(fs.existsSync(managedPath), true);
    }
  });

  await t.test('shared CAS references retain the blob and never start physical deletion', async () => {
    const asset = {
      id: 'asset-cas-shared',
      filename: 'shared.png',
      managedPath: path.join(casRoot, 'shared-cas-file'),
      storageMode: 'managed',
      contentHash: hashFor('cas-shared'),
      metadata: { size: 64 },
    };
    let references = 2;
    let physicalCalls = 0;
    let markCalls = 0;
    currentDatabase = {
      getAsset: () => asset,
      removeAssetIndex: () => { references -= 1; return asset; },
      assetBlobReferenceCount: () => references,
      markAssetBlobDeleted: () => { markCalls += 1; return true; },
    };
    currentBlobStore = {
      isBlobPath: () => true,
      resolvePath: () => asset.managedPath,
      removeVerifiedBlob: async () => { physicalCalls += 1; return true; },
    };
    const result = await deleteJson(`${baseUrl}/${asset.id}/file`, deleteRequestBody(asset));
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.data, {
      id: asset.id,
      indexRemoved: true,
      fileDeleted: false,
      blobRetained: true,
    });
    assert.equal(physicalCalls, 0);
    assert.equal(markCalls, 0);
  });

  await t.test('last CAS reference verifies the zero-ref guard, deletes bytes, and finalizes the pending record', async () => {
    const asset = {
      id: 'asset-cas-last-reference',
      filename: 'last-reference.png',
      managedPath: path.join(casRoot, 'last-reference-cas-file'),
      storageMode: 'managed',
      contentHash: hashFor('cas-last-reference'),
      metadata: { size: 64 },
    };
    let references = 1;
    let removeCalls = 0;
    let markCalls = 0;
    currentDatabase = {
      getAsset: () => asset,
      removeAssetIndex: () => { references = 0; return asset; },
      assetBlobReferenceCount: () => references,
      markAssetBlobDeleted: (hash) => {
        assert.equal(hash, asset.contentHash);
        markCalls += 1;
        return true;
      },
    };
    currentBlobStore = {
      isBlobPath: () => true,
      resolvePath: () => asset.managedPath,
      async removeVerifiedBlob(hash, options) {
        removeCalls += 1;
        assert.equal(hash, asset.contentHash);
        assert.equal(options.expectedSize, 64);
        assert.equal(await options.beforeDelete(), true);
        return true;
      },
    };
    const result = await deleteJson(`${baseUrl}/${asset.id}/file`, deleteRequestBody(asset));
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.data, {
      id: asset.id,
      indexRemoved: true,
      fileDeleted: true,
      blobRetained: false,
    });
    assert.equal(removeCalls, 1);
    assert.equal(markCalls, 1);
  });

  await t.test('an ambiguous false CAS record finalize stays a committed reconciliation warning', async () => {
    const asset = {
      id: 'asset-cas-finalize-false',
      filename: 'finalize-false.png',
      managedPath: path.join(casRoot, 'finalize-false-cas-file'),
      storageMode: 'managed',
      contentHash: hashFor('cas-finalize-false'),
      metadata: { size: 64 },
    };
    let references = 1;
    currentDatabase = {
      getAsset: () => asset,
      removeAssetIndex: () => { references = 0; return asset; },
      assetBlobReferenceCount: () => references,
      markAssetBlobDeleted: () => false,
      getAssetBlob: () => ({ contentHash: asset.contentHash, storageState: 'pending-delete' }),
    };
    currentBlobStore = {
      isBlobPath: () => true,
      resolvePath: () => asset.managedPath,
      removeVerifiedBlob: async (_hash, options) => {
        assert.equal(await options.beforeDelete(), true);
        return true;
      },
    };
    const result = await deleteJson(`${baseUrl}/${asset.id}/file`, deleteRequestBody(asset));
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.data, {
      id: asset.id,
      indexRemoved: true,
      fileDeleted: true,
      blobRetained: false,
      persistenceWarning: warning('cas-record-finalize'),
    });
  });

  await t.test('an ambiguous CAS false result keeps the pending-delete record for reconciliation', async () => {
    const asset = {
      id: 'asset-cas-ambiguous-false',
      filename: 'ambiguous-false.png',
      managedPath: path.join(casRoot, 'ambiguous-false-cas-file'),
      storageMode: 'managed',
      contentHash: hashFor('cas-ambiguous-false'),
      metadata: { size: 64 },
    };
    let references = 1;
    let markCalls = 0;
    currentDatabase = {
      getAsset: () => asset,
      removeAssetIndex: () => { references = 0; return asset; },
      assetBlobReferenceCount: () => references,
      markAssetBlobDeleted: () => { markCalls += 1; return true; },
    };
    currentBlobStore = {
      isBlobPath: () => true,
      resolvePath: () => asset.managedPath,
      async removeVerifiedBlob(_hash, options) {
        assert.equal(await options.beforeDelete(), true);
        return false;
      },
    };
    const result = await deleteJson(`${baseUrl}/${asset.id}/file`, deleteRequestBody(asset));
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.data, {
      id: asset.id,
      indexRemoved: true,
      fileDeleted: false,
      blobRetained: false,
      persistenceWarning: warning('cas-file-delete'),
    });
    assert.equal(markCalls, 0);
  });

  await t.test('arbitrary CAS cleanup failures are committed, sanitized, and left for reconciliation', async () => {
    const asset = {
      id: 'asset-cas-private-cleanup',
      filename: 'cleanup.png',
      managedPath: path.join(casRoot, 'private-cleanup-cas-file'),
      storageMode: 'managed',
      contentHash: hashFor('cas-private-cleanup'),
      metadata: { size: 64 },
    };
    let references = 1;
    currentDatabase = {
      getAsset: () => asset,
      removeAssetIndex: () => { references = 0; return asset; },
      assetBlobReferenceCount: () => references,
      markAssetBlobDeleted: () => { throw new Error('mark must not run after physical cleanup failure'); },
    };
    currentBlobStore = {
      isBlobPath: () => true,
      resolvePath: () => asset.managedPath,
      async removeVerifiedBlob(_hash, options) {
        assert.equal(await options.beforeDelete(), true);
        throw Object.assign(new Error(`${directory} Authorization: Bearer never-expose`), {
          code: 'EPERM',
          privateToken: 'never-expose',
        });
      },
    };
    const result = await deleteJson(`${baseUrl}/${asset.id}/file`, deleteRequestBody(asset));
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.data, {
      id: asset.id,
      indexRemoved: true,
      fileDeleted: false,
      blobRetained: false,
      persistenceWarning: warning('cas-file-delete'),
    });
    assert.equal(JSON.stringify(result.body).includes(directory), false);
    assert.doesNotMatch(JSON.stringify(result.body), /Authorization|Bearer|never-expose|EPERM/i);
  });

  await t.test('raw and typed CAS record-finalize capacity become safe committed warnings, never a false 507', async () => {
    for (const fixture of [
      {
        id: 'raw-finalize',
        error: Object.assign(new Error(`${directory} private raw finalize`), { code: 'SQLITE_FULL' }),
        reason: 'sqlite-full',
      },
      {
        id: 'typed-finalize',
        error: Object.assign(new ProjectDatabaseStorageCapacityError('filesystem-reserve', {
          operation: 'private.asset.finalize',
        }), { privatePath: directory }),
        reason: 'filesystem-reserve',
      },
    ]) {
      const asset = {
        id: `asset-cas-${fixture.id}`,
        filename: `${fixture.id}.png`,
        managedPath: path.join(casRoot, `${fixture.id}-cas-file`),
        storageMode: 'managed',
        contentHash: hashFor(fixture.id),
        metadata: { size: 64 },
      };
      let references = 1;
      currentDatabase = {
        getAsset: () => asset,
        removeAssetIndex: () => { references = 0; return asset; },
        assetBlobReferenceCount: () => references,
        markAssetBlobDeleted: () => { throw fixture.error; },
      };
      currentBlobStore = {
        isBlobPath: () => true,
        resolvePath: () => asset.managedPath,
        removeVerifiedBlob: async (_hash, options) => {
          assert.equal(await options.beforeDelete(), true);
          return true;
        },
      };
      const result = await deleteJson(`${baseUrl}/${asset.id}/file`, deleteRequestBody(asset));
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      assert.deepEqual(result.body.data, {
        id: asset.id,
        indexRemoved: true,
        fileDeleted: true,
        blobRetained: false,
        persistenceWarning: warning('cas-record-finalize', fixture.reason),
      });
      assert.equal(JSON.stringify(result.body).includes(directory), false);
      assert.doesNotMatch(JSON.stringify(result.body), /private\.asset|private raw/i);
    }
  });
});
