const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const { createSubflowPackage, importSubflowPackage } = require('../backend/src/services/subflowPackage');
const { collectPackageAssets, persistImportedAssets, replaceAssetReferences, validateDefinition } = require('../backend/src/routes/subflows');

test('subflow revision validation rejects stale graph, port, parameter and nested references', () => {
  const valid = {
    id: 'revision', name: 'Revision', description: '', tags: [], requiredCapabilities: [], assetRefs: [],
    nodes: [{ id: 'source', type: 'text', position: { x: 0, y: 0 }, data: {} }, { id: 'target', type: 'output', position: { x: 100, y: 0 }, data: {} }],
    edges: [{ id: 'edge', source: 'source', target: 'target' }],
    inputs: [{ id: 'in', name: 'Input', kind: 'text', internalNodeId: 'source' }],
    outputs: [{ id: 'out', name: 'Output', kind: 'text', internalNodeId: 'target' }],
    exposedParameters: [{ id: 'prompt', name: 'Prompt', nodeId: 'source', dataKey: 'text' }],
  };
  assert.doesNotThrow(() => validateDefinition(valid));
  assert.throws(() => validateDefinition({ ...valid, edges: [{ id: 'edge', source: 'source', target: 'missing' }] }), /悬空内部连线/);
  assert.throws(() => validateDefinition({ ...valid, edges: [...valid.edges, { ...valid.edges[0] }] }), /连线 ID 缺失或重复/);
  assert.throws(() => validateDefinition({ ...valid, inputs: [{ ...valid.inputs[0], internalNodeId: 'missing' }] }), /端口指向不存在/);
  assert.throws(() => validateDefinition({ ...valid, exposedParameters: [{ ...valid.exposedParameters[0], nodeId: 'missing' }] }), /公开参数指向不存在/);
  assert.throws(() => validateDefinition({
    ...valid,
    nodes: [...valid.nodes, { id: 'nested', type: 'subflow', position: { x: 200, y: 0 }, data: { definitionId: 'child' } }],
  }), /嵌套子工作流节点缺少固定版本/);
});

test('subflow import persists licensed assets in managed input and export reads the indexed bytes back', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-subflow-assets-'));
  const runtimeConfig = {
    INPUT_DIR: path.join(root, 'input'),
    OUTPUT_DIR: path.join(root, 'output'),
    THUMBNAILS_DIR: path.join(root, 'thumbnails'),
    THUMBNAIL_SIZE: 160,
    THUMBNAIL_QUALITY: 80,
  };
  for (const directory of [runtimeConfig.INPUT_DIR, runtimeConfig.OUTPUT_DIR, runtimeConfig.THUMBNAILS_DIR]) fs.mkdirSync(directory, { recursive: true });
  const database = new ProjectDatabase(path.join(root, 'project.sqlite3'));
  try {
    const png = await sharp({ create: { width: 24, height: 16, channels: 4, background: '#22aaff' } }).png().toBuffer();
    const definition = {
      id: 'portable', version: 1, projectId: 'project-imported', name: 'portable', description: '', tags: [],
      nodes: [{ id: 'image', type: 'image', position: { x: 0, y: 0 }, data: { assetId: 'old-asset' } }],
      edges: [], inputs: [], outputs: [], exposedParameters: [], requiredCapabilities: [], assetRefs: ['old-asset'],
    };
    const archive = await createSubflowPackage(definition, [{
      path: 'assets/reference.png', assetRef: 'old-asset', content: png, license: 'CC0-1.0', redistributable: true,
    }]);
    const imported = await importSubflowPackage(archive, { projectId: 'project-imported' });
    const persisted = await persistImportedAssets(imported, 'project-imported', { database, config: runtimeConfig });
    assert.equal(persisted.created.length, 1);
    const indexed = database.getAsset(persisted.created[0].id);
    assert.ok(indexed);
    assert.equal(indexed.projectId, 'project-imported');
    assert.equal(indexed.metadata.width, 24);
    assert.equal(indexed.metadata.height, 16);
    assert.equal(indexed.provenance.source, 't8flow-import');
    assert.equal(fs.readFileSync(indexed.managedPath).equals(png), true);

    const replaced = replaceAssetReferences(definition, persisted.replacements);
    assert.deepEqual(replaced.assetRefs, [indexed.id]);
    assert.equal(replaced.nodes[0].data.assetId, indexed.id);
    const bundled = collectPackageAssets({ ...replaced, projectId: 'project-imported' }, { database });
    assert.equal(bundled.length, 1);
    assert.equal(bundled[0].assetRef, indexed.id);
    assert.equal(bundled[0].content.equals(png), true);
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('subflow asset import rolls back files and indexes when a later asset fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-subflow-assets-rollback-'));
  const runtimeConfig = {
    INPUT_DIR: path.join(root, 'input'), OUTPUT_DIR: path.join(root, 'output'), THUMBNAILS_DIR: path.join(root, 'thumbnails'),
    THUMBNAIL_SIZE: 160, THUMBNAIL_QUALITY: 80,
  };
  for (const directory of [runtimeConfig.INPUT_DIR, runtimeConfig.OUTPUT_DIR, runtimeConfig.THUMBNAILS_DIR]) fs.mkdirSync(directory, { recursive: true });
  const database = new ProjectDatabase(path.join(root, 'project.sqlite3'));
  try {
    const first = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff0000' } }).png().toBuffer();
    const second = await sharp({ create: { width: 9, height: 9, channels: 4, background: '#00ff00' } }).png().toBuffer();
    const definition = {
      id: 'rollback', version: 1, projectId: 'project-imported', name: 'rollback', description: '', tags: [], nodes: [], edges: [], inputs: [], outputs: [], exposedParameters: [], requiredCapabilities: [], assetRefs: ['asset-a', 'asset-b'],
    };
    const archive = await createSubflowPackage(definition, [
      { path: 'assets/a.png', assetRef: 'asset-a', content: first, license: 'CC0-1.0', redistributable: true },
      { path: 'assets/b.png', assetRef: 'asset-b', content: second, license: 'CC0-1.0', redistributable: true },
    ]);
    const imported = await importSubflowPackage(archive, { projectId: 'project-imported' });
    let writes = 0;
    const failingDatabase = new Proxy(database, {
      get(target, property) {
        if (property === 'upsertAsset') return (input) => {
          writes += 1;
          if (writes === 2) throw new Error('injected asset index failure');
          return target.upsertAsset(input);
        };
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      persistImportedAssets(imported, 'project-imported', { database: failingDatabase, config: runtimeConfig }),
      /injected asset index failure/,
    );
    assert.equal(database.countAssets({ projectId: 'project-imported' }), 0);
    const importedRoot = path.join(runtimeConfig.INPUT_DIR, 'subflows', imported.archiveSha256.slice(0, 16));
    assert.deepEqual(fs.existsSync(importedRoot) ? fs.readdirSync(importedRoot).filter((name) => !name.startsWith('.')) : [], []);
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt subflow models remain honest failed assets and never enter the preview queue', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-subflow-corrupt-preview-'));
  const runtimeConfig = {
    INPUT_DIR: path.join(root, 'input'), OUTPUT_DIR: path.join(root, 'output'), THUMBNAILS_DIR: path.join(root, 'thumbnails'),
    THUMBNAIL_SIZE: 160, THUMBNAIL_QUALITY: 80,
  };
  for (const directory of [runtimeConfig.INPUT_DIR, runtimeConfig.OUTPUT_DIR, runtimeConfig.THUMBNAILS_DIR]) fs.mkdirSync(directory, { recursive: true });
  const database = new ProjectDatabase(path.join(root, 'project.sqlite3'));
  let enqueueCalls = 0;
  try {
    const content = Buffer.from('#'.repeat(1_048_577));
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const imported = {
      archiveSha256: 'c'.repeat(64),
      assets: [{ path: 'assets/corrupt.obj', assetRef: 'corrupt-model', content, sha256, license: 'CC0-1.0', redistributable: true }],
    };
    const previewPipeline = { enqueueAsset() { enqueueCalls += 1; throw new Error('corrupt asset must not enqueue'); } };
    const persisted = await persistImportedAssets(imported, 'project-corrupt', { database, config: runtimeConfig, previewPipeline });
    const indexed = database.getAsset(persisted.replacements.get('corrupt-model'));
    assert.equal(indexed.availability, 'corrupt');
    assert.equal(indexed.metadata.health, 'corrupt');
    assert.equal(indexed.metadata.previewStatus, 'failed');
    assert.equal(enqueueCalls, 0);
    assert.equal(database.listAssetPreviewJobs({ assetId: indexed.id }).length, 0);
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the same subflow archive imported into two projects keeps distinct asset identities', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-subflow-assets-project-isolation-'));
  const runtimeConfig = {
    INPUT_DIR: path.join(root, 'input'), OUTPUT_DIR: path.join(root, 'output'), THUMBNAILS_DIR: path.join(root, 'thumbnails'),
    THUMBNAIL_SIZE: 160, THUMBNAIL_QUALITY: 80,
  };
  for (const directory of [runtimeConfig.INPUT_DIR, runtimeConfig.OUTPUT_DIR, runtimeConfig.THUMBNAILS_DIR]) fs.mkdirSync(directory, { recursive: true });
  const database = new ProjectDatabase(path.join(root, 'project.sqlite3'));
  try {
    const png = await sharp({ create: { width: 12, height: 10, channels: 4, background: '#663399' } }).png().toBuffer();
    const definition = {
      id: 'portable-projects', version: 1, projectId: 'project-a', name: 'portable', description: '', tags: [],
      nodes: [], edges: [], inputs: [], outputs: [], exposedParameters: [], requiredCapabilities: [], assetRefs: ['shared-asset'],
    };
    const archive = await createSubflowPackage(definition, [{
      path: 'assets/shared.png', assetRef: 'shared-asset', content: png, license: 'CC0-1.0', redistributable: true,
    }]);
    const imported = await importSubflowPackage(archive, { projectId: 'project-a' });
    const completedPreviewPipeline = {
      enqueueAsset() {
        return { status: 'succeeded', result: { thumbnailUrl: '/files/thumbnails/restored-import.webp', perceptualHash: 'fedcba9876543210' } };
      },
    };
    const first = await persistImportedAssets(imported, 'project-a', { database, config: runtimeConfig, previewPipeline: completedPreviewPipeline });
    const second = await persistImportedAssets(imported, 'project-b', { database, config: runtimeConfig, previewPipeline: completedPreviewPipeline });
    const firstId = first.replacements.get('shared-asset');
    const secondId = second.replacements.get('shared-asset');
    assert.notEqual(firstId, secondId);
    assert.equal(database.getAsset(firstId).projectId, 'project-a');
    assert.equal(database.getAsset(secondId).projectId, 'project-b');
    assert.equal(database.countAssets({ projectId: 'project-a' }), 1);
    assert.equal(database.countAssets({ projectId: 'project-b' }), 1);
    assert.equal(database.getAsset(firstId).metadata.previewStatus, 'ready');
    assert.equal(database.getAsset(firstId).metadata.thumbnailUrl, '/files/thumbnails/restored-import.webp');
    assert.equal(database.getAsset(firstId).perceptualHash, 'fedcba9876543210');
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
