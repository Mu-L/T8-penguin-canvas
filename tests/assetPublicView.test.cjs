const test = require('node:test');
const assert = require('node:assert/strict');

const {
  publicAsset,
  publicAssetLineage,
  publicAssetSourceGraph,
  redactLocalPaths,
  sanitizePublicValue,
} = require('../backend/src/services/assetPublicView');

test('public asset views recursively remove private host paths including slash-normalized Windows paths', () => {
  const asset = publicAsset({
    id: 'asset-private-view',
    storageMode: 'linked',
    managedPath: 'E:\\private\\models\\scene.glb',
    sourceUrl: '/api/project-assets/asset-private-view/media',
    metadata: {
      relativePath: 'E:/private/models/scene.glb',
      metadataError: 'failed at E:/private/models/scene.glb while reading',
      nested: { absolutePath: 'E:\\private\\models\\scene.glb' },
    },
    provenance: { debug: 'opened /home/alice/private/scene.glb and /workspace/project/scene.glb' },
    diagnostics: {
      windowsUnc: '\\\\workstation\\alice\\private\\scene.glb',
      auth: 'Authorization: Bearer secret-value-123456',
      upstream: 'https://example.test/result?token=private-token&safe=1',
      signedUrl: 'https://storage.example.test/result?X-Amz-Credential=private-credential&X-Amz-Signature=private-signature',
      previewUrl: '/home/alice/should-not-be-public.png',
      apiKey: `sk-${'A'.repeat(32)}`,
    },
  });

  const serialized = JSON.stringify(asset);
  assert.equal(Object.hasOwn(asset, 'managedPath'), false);
  assert.equal(asset.metadata.relativePath, 'scene.glb');
  assert.equal(serialized.includes('E:/private'), false);
  assert.equal(serialized.includes('E:\\\\private'), false);
  assert.equal(serialized.includes('/home/alice'), false);
  assert.equal(serialized.includes('/workspace/project'), false);
  assert.equal(serialized.includes('workstation'), false);
  assert.equal(serialized.includes('secret-value'), false);
  assert.equal(serialized.includes('private-token'), false);
  assert.equal(serialized.includes('private-credential'), false);
  assert.equal(serialized.includes('private-signature'), false);
  assert.equal(serialized.includes('should-not-be-public'), false);
  assert.equal(serialized.includes(`sk-${'A'.repeat(32)}`), false);
  assert.equal(asset.sourceUrl, '/api/project-assets/asset-private-view/media');
});

test('public URL sanitizing preserves HTTPS while removing signed secrets and encoded local paths', () => {
  const publicView = publicAsset({
    storageMode: 'remote',
    sourceUrl: 'https://cdn.example.test/media/model.glb',
    previewUrl: 'https://cdn.example.test/preview.webp?X-Amz-Signature=very-secret&X-Goog-Security-Token=google-secret&path=E%3A%5CUsers%5Calice%5Cmodel.glb&unix=%2Fhome%2Falice%2Fmodel.glb',
  });
  assert.equal(publicView.sourceUrl, 'https://cdn.example.test/media/model.glb');
  assert.match(publicView.previewUrl, /^https:\/\/cdn\.example\.test\/preview\.webp\?/);
  assert.doesNotMatch(publicView.previewUrl, /very-secret|google-secret|Users|alice|%5Cmodel|%2Fhome/i);
  assert.match(decodeURIComponent(publicView.previewUrl), /X-Amz-Signature=\[redacted\]/);
  assert.equal(redactLocalPaths('https://cdn.example.test/model.glb', { preservePublicUrl: true }), 'https://cdn.example.test/model.glb');
});

test('public views recursively drop sensitive keys regardless of spelling or nesting', () => {
  const view = publicAsset({
    id: 'asset-sensitive-keys',
    blobId: 'global-blob-identity',
    sourceLocator: 'E:\\private\\source-locator.png',
    token: 'top-level-token',
    metadata: {
      api_key: 'nested-api-key',
      awsAccessKeyId: 'nested-access-key',
      Authorization: 'Bearer nested-authorization',
      cookie: 'sid=nested-cookie',
      'Set-Cookie': 'sid=nested-set-cookie',
      password: 'nested-password',
      passphrase: 'nested-passphrase',
      credentials: { username: 'alice', secret: 'nested-secret' },
      clientSignature: 'nested-signature',
      diagnosticLog: '{"apiKey":"logged-api-key","password":"logged-password"}',
      safe: [{ refreshToken: 'array-token', label: 'keep-me' }],
      resultUrl: 'https://cdn.example.test/result.png?signature=signed-value&safe=1',
    },
  });

  assert.equal(Object.hasOwn(view, 'token'), false);
  assert.equal(Object.hasOwn(view, 'blobId'), false);
  assert.equal(Object.hasOwn(view, 'sourceLocator'), false);
  assert.equal(Object.hasOwn(view.metadata, 'api_key'), false);
  assert.equal(Object.hasOwn(view.metadata, 'awsAccessKeyId'), false);
  assert.equal(Object.hasOwn(view.metadata, 'Authorization'), false);
  assert.equal(Object.hasOwn(view.metadata, 'cookie'), false);
  assert.equal(Object.hasOwn(view.metadata, 'Set-Cookie'), false);
  assert.equal(Object.hasOwn(view.metadata, 'password'), false);
  assert.equal(Object.hasOwn(view.metadata, 'passphrase'), false);
  assert.equal(Object.hasOwn(view.metadata, 'credentials'), false);
  assert.equal(Object.hasOwn(view.metadata, 'clientSignature'), false);
  assert.doesNotMatch(view.metadata.diagnosticLog, /logged-api-key|logged-password/);
  assert.deepEqual(view.metadata.safe, [{ label: 'keep-me' }]);
  assert.match(decodeURIComponent(view.metadata.resultUrl), /signature=\[redacted\]/);
  assert.equal(JSON.stringify(view).includes('signed-value'), false);
});

test('public asset views recursively hide observed replacement hashes while preserving canonical content hashes', () => {
  const contentHash = 'a'.repeat(64);
  const observedContentHash = 'b'.repeat(64);
  const view = publicAsset({
    id: 'asset-observed-hash',
    contentHash,
    metadata: {
      observedContentHash,
      nested: {
        observed_content_hash: observedContentHash,
      },
      values: [{ 'Observed-Content-Hash': observedContentHash, label: 'keep-me' }],
    },
  });

  assert.equal(view.contentHash, contentHash);
  assert.equal(Object.hasOwn(view.metadata, 'observedContentHash'), false);
  assert.equal(Object.hasOwn(view.metadata.nested, 'observed_content_hash'), false);
  assert.deepEqual(view.metadata.values, [{ label: 'keep-me' }]);
  assert.equal(JSON.stringify(view).includes(observedContentHash), false);
});

test('public recursive values are bounded and circular references fail closed', () => {
  const circular = { label: 'cycle' };
  circular.self = circular;
  const view = sanitizePublicValue({
    items: Array.from({ length: 250 }, (_, index) => index),
    fields: Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`field${index}`, index])),
    longText: 'x'.repeat(20_000),
    circular,
  });
  assert.equal(view.items.length, 200);
  assert.equal(Object.keys(view.fields).length, 200);
  assert.equal(view.longText.length, 16 * 1024);
  assert.equal(view.circular.self, null);
});

test('lineage and source graph public views are allowlisted, bounded and sanitized', () => {
  const lineage = publicAssetLineage({
    id: 'lineage-1',
    childAssetId: 'asset-child',
    parentAssetId: 'asset-parent',
    relation: 'derived-from',
    promptSummary: 'opened E:\\private\\prompt.txt with Authorization: Bearer lineage-secret',
    metadata: {
      apiKey: 'lineage-api-key',
      sourcePath: 'E:\\private\\source.png',
      resultUrl: 'https://cdn.example.test/result.png?token=lineage-token',
      safe: 'visible',
    },
    debugDump: { password: 'must-not-exist' },
    createdAt: 123,
  });
  assert.equal(Object.hasOwn(lineage, 'debugDump'), false);
  assert.equal(Object.hasOwn(lineage.metadata, 'apiKey'), false);
  assert.equal(Object.hasOwn(lineage.metadata, 'sourcePath'), false);
  assert.equal(lineage.metadata.safe, 'visible');
  assert.doesNotMatch(JSON.stringify(lineage), /lineage-secret|lineage-api-key|lineage-token|private/i);

  const graph = publicAssetSourceGraph({
    rootAssetId: 'asset-root',
    maxNodes: 5000,
    nodes: Array.from({ length: 505 }, (_, index) => ({
      id: `asset-${index}`,
      depth: index,
      tombstone: index === 1,
      ...(index === 1 ? {} : { asset: { id: `asset-${index}`, metadata: { password: `password-${index}`, safe: index } } }),
    })),
    edges: Array.from({ length: 1005 }, (_, index) => ({
      id: `lineage-${index}`,
      eventId: `event-${index}`,
      sourceAssetId: `asset-${index}`,
      targetAssetId: `asset-${index + 1}`,
      from: `asset-${index}`,
      to: `asset-${index + 1}`,
      type: 'derived-from',
      sourceType: 'node-output',
      childAssetId: `asset-${index + 1}`,
      parentAssetId: `asset-${index}`,
      metadata: { cookie: `cookie-${index}`, safe: index },
    })),
    privateDebug: { token: 'graph-token' },
  });
  assert.equal(graph.nodes.length, 500);
  assert.equal(graph.edges.length, 1000);
  assert.equal(graph.truncated, true);
  assert.equal(graph.maxNodes, 5000);
  assert.equal(Object.hasOwn(graph, 'privateDebug'), false);
  assert.equal(Object.hasOwn(graph.nodes[0].asset.metadata, 'password'), false);
  assert.equal(graph.nodes[1].tombstone, true);
  assert.equal(Object.hasOwn(graph.nodes[1], 'asset'), false);
  assert.equal(Object.hasOwn(graph.edges[0].metadata, 'cookie'), false);
  assert.deepEqual({
    eventId: graph.edges[0].eventId,
    sourceAssetId: graph.edges[0].sourceAssetId,
    targetAssetId: graph.edges[0].targetAssetId,
    from: graph.edges[0].from,
    to: graph.edges[0].to,
    type: graph.edges[0].type,
  }, {
    eventId: 'event-0',
    sourceAssetId: 'asset-0',
    targetAssetId: 'asset-1',
    from: 'asset-0',
    to: 'asset-1',
    type: 'derived-from',
  });
});
