const test = require('node:test');
const assert = require('node:assert/strict');
const yazl = require('yazl');
const {
  containsPlaintextSecret,
  createSubflowPackage,
  hydrateDependencyDefinitions,
  importSubflowPackage,
  inspectSubflowPackage,
  sha256,
} = require('../backend/src/services/subflowPackage');

const definition = {
  id: 'flow-a', version: 2, projectId: 'project-a', name: '安全子工作流', description: '', tags: [],
  nodes: [{ id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: { prompt: 'hello' } }],
  edges: [], inputs: [], outputs: [], exposedParameters: [], requiredCapabilities: [], assetRefs: [],
};

function zipEntries(entries) {
  const zip = new yazl.ZipFile();
  const chunks = [];
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.content), entry.path, { mtime: new Date('1980-01-01T00:00:00Z'), mode: 0o100644 });
  return new Promise((resolve, reject) => {
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.once('error', reject);
    zip.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

test('t8flow export is deterministic and round-trips a validated definition', async () => {
  const first = await createSubflowPackage(definition);
  const second = await createSubflowPackage(definition);
  assert.equal(sha256(first), sha256(second));
  const inspected = await inspectSubflowPackage(first);
  assert.equal(inspected.manifest.schema, 't8-subflow-package');
  assert.deepEqual(inspected.definition, definition);
  assert.equal(inspected.files.some((entry) => entry.path === 'definition.json'), true);
  const imported = await importSubflowPackage(first, { expectedArchiveSha256: inspected.archiveSha256, projectId: 'project-b' });
  assert.equal(imported.definition.projectId, 'project-b');
});

test('t8flow import rejects check/use archive hash changes and plaintext credentials', async () => {
  const archive = await createSubflowPackage(definition);
  await assert.rejects(() => importSubflowPackage(archive, { expectedArchiveSha256: '0'.repeat(64) }), /检查后发生变化/);
  await assert.rejects(() => createSubflowPackage({ ...definition, nodes: [{ ...definition.nodes[0], data: { apiKey: 'sk-secret' } }] }), /明文凭据/);
  for (const data of [
    { rhApiKey: 'rh-secret' },
    { appSecret: 'app-secret' },
    { secretKey: 'secret-key' },
    { accessKeySecret: 'access-secret' },
    { sourceUrl: 'https://example.com/media.png?X-Amz-Signature=private' },
  ]) await assert.rejects(() => createSubflowPackage({ ...definition, nodes: [{ ...definition.nodes[0], data }] }), /明文凭据/);

  for (const plaintext of [
    ['sk-', 'abcdefghijklmnopqrstuvwxyz123456'].join(''),
    'Bearer test-bearer-token-value',
    ['ghp_', 'A'.repeat(36)].join(''),
    ['github_pat_', 'A'.repeat(32)].join(''),
    ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
    ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'c2lnbmF0dXJl'].join('.'),
    'data:image/png;base64,QUJDREVGRw==',
  ]) {
    const unsafeDefinition = {
      ...definition,
      nodes: [{
        ...definition.nodes[0],
        data: { prompt: plaintext },
      }],
    };
    assert.equal(containsPlaintextSecret(unsafeDefinition), true, plaintext);
    await assert.rejects(() => createSubflowPackage(unsafeDefinition), /明文凭据/);

    const definitionBuffer = Buffer.from(`${JSON.stringify(unsafeDefinition)}\n`);
    const manifest = {
      schema: 't8-subflow-package',
      version: 1,
      definition: 'definition.json',
      files: [{
        path: 'definition.json',
        size: definitionBuffer.length,
        sha256: sha256(definitionBuffer),
        kind: 'definition',
      }],
    };
    const unsafeArchive = await zipEntries([
      { path: 'manifest.json', content: `${JSON.stringify(manifest)}\n` },
      { path: 'definition.json', content: definitionBuffer },
    ]);
    await assert.rejects(() => inspectSubflowPackage(unsafeArchive), /明文凭据/);
    await assert.rejects(() => importSubflowPackage(unsafeArchive), /明文凭据/);
  }
});

test('t8flow preflight rejects traversal, undeclared files and abnormal compression ratios', async () => {
  const safeArchive = await createSubflowPackage(definition, [{
    path: 'assets/a.txt', content: Buffer.from('safe'), license: 'CC0-1.0', redistributable: true,
  }]);
  const traversal = Buffer.from(safeArchive);
  const from = Buffer.from('assets/a.txt');
  const to = Buffer.from('../evil!.txt');
  let replacements = 0;
  for (let offset = 0; offset <= traversal.length - from.length; offset += 1) {
    if (traversal.subarray(offset, offset + from.length).equals(from)) {
      to.copy(traversal, offset);
      replacements += 1;
    }
  }
  assert.equal(replacements >= 2, true);
  await assert.rejects(() => inspectSubflowPackage(traversal), /路径穿越|路径层级|绝对|invalid relative path/);

  const definitionBuffer = Buffer.from(`${JSON.stringify(definition)}\n`);
  const manifest = {
    schema: 't8-subflow-package', version: 1, definition: 'definition.json', files: [
      { path: 'definition.json', size: definitionBuffer.length, sha256: sha256(definitionBuffer), kind: 'definition' },
    ],
  };
  const undeclared = await zipEntries([
    { path: 'manifest.json', content: `${JSON.stringify(manifest)}\n` },
    { path: 'definition.json', content: definitionBuffer },
    { path: 'licenses/extra.txt', content: 'undeclared' },
  ]);
  await assert.rejects(() => inspectSubflowPackage(undeclared), /未声明文件/);

  const compressed = await createSubflowPackage(definition, [{
    path: 'assets/repeat.txt', content: Buffer.alloc(512 * 1024, 65), license: 'CC0-1.0', redistributable: true,
  }]);
  await assert.rejects(() => inspectSubflowPackage(compressed), /压缩比异常/);
});

test('t8flow export requires explicit redistribution rights for bundled assets', async () => {
  await assert.rejects(() => createSubflowPackage(definition, [{ path: 'assets/a.png', content: Buffer.from('x') }]), /可再分发许可/);
});

test('t8flow round-trips licensed assets and hydrates reference-only nested definitions for a new project', async () => {
  const child = {
    ...definition, id: 'child-flow', version: 4, projectId: 'project-a',
    nodes: [{ id: 'child-text', type: 'text', position: { x: 0, y: 0 }, data: { text: 'nested' } }],
  };
  const parent = {
    ...definition,
    id: 'parent-flow', version: 2, projectId: 'project-a', assetRefs: ['asset-original'],
    nodes: [{
      id: 'nested', type: 'subflow', position: { x: 0, y: 0 },
      data: { definitionId: child.id, definitionVersion: child.version, definitionProjectId: child.projectId },
    }],
  };
  const archive = await createSubflowPackage(parent, [{
    path: 'assets/reference.png', assetRef: 'asset-original', content: Buffer.from('licensed-image'), license: 'CC0-1.0', redistributable: true,
  }], [child]);
  const imported = await importSubflowPackage(archive, { projectId: 'project-b' });
  assert.equal(imported.assets.length, 1);
  assert.equal(imported.assets[0].assetRef, 'asset-original');
  assert.equal(imported.assets[0].content.toString(), 'licensed-image');
  assert.equal(imported.dependencies.length, 1);
  const hydrated = hydrateDependencyDefinitions(imported.definition, imported.dependencies, { projectId: 'project-b' });
  const nested = hydrated.nodes[0].data.definition;
  assert.equal(hydrated.projectId, 'project-b');
  assert.equal(hydrated.nodes[0].data.definitionProjectId, 'project-b');
  assert.equal(nested.projectId, 'project-b');
  assert.equal(nested.id, 'child-flow');
  assert.equal(nested.version, 4);
});

test('t8flow rejects deep JSON, dangerous keys and oversized definition collections', async () => {
  let deep = 'leaf';
  for (let index = 0; index < 70; index += 1) deep = { child: deep };
  await assert.rejects(() => createSubflowPackage({ ...definition, nodes: [{ ...definition.nodes[0], data: deep }] }), /嵌套层级/);

  const dangerous = JSON.parse(JSON.stringify(definition));
  dangerous.nodes[0].data = JSON.parse('{"__proto__":{"polluted":true}}');
  await assert.rejects(() => createSubflowPackage(dangerous), /危险字段/);

  const archive = await createSubflowPackage(definition);
  await assert.rejects(() => inspectSubflowPackage(archive, { limits: { definitionNodes: 0 } }), /nodes 超过 0 项/);
});

test('t8flow export caps reference-only dependency fanout', async () => {
  const dependencies = Array.from({ length: 129 }, (_, index) => ({ ...definition, id: `dependency-${index}`, version: 1 }));
  await assert.rejects(() => createSubflowPackage(definition, [], dependencies), /依赖超过 128 项/);
});
