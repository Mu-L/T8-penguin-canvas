'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createAgentControlAuthService } = require('../backend/src/services/agentControlAuth.js');
const { createAgentControlApprovalService } = require('../backend/src/services/agentControlApprovals.js');
const {
  AgentControlDeliveryError,
  createAgentControlDeliveryService,
  extractAssetIds,
  manifestDigest,
} = require('../backend/src/services/agentControlDelivery.js');
const agentControlRoute = require('../backend/src/routes/agentControl.js');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcanvas-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imageBytes = Buffer.from('verified-image-fixture');
  const audioBytes = Buffer.from('verified-audio-fixture');
  const imagePath = path.join(root, '角色参考.png');
  const audioPath = path.join(root, '旁白.wav');
  fs.writeFileSync(imagePath, imageBytes);
  fs.writeFileSync(audioPath, audioBytes);
  const assets = new Map([
    ['asset-image', {
      id: 'asset-image',
      projectId: 'project-local',
      kind: 'image',
      filename: '角色参考.png',
      mimeType: 'image/png',
      sizeBytes: imageBytes.length,
      contentHash: hash(imageBytes),
      storageMode: 'managed',
      managedPath: imagePath,
      metadata: {
        deliveryRole: 'master',
        licenseStatus: 'owned',
        licenseName: 'creator-owned',
      },
    }],
    ['asset-audio', {
      id: 'asset-audio',
      projectId: 'project-local',
      kind: 'audio',
      filename: '旁白.wav',
      mimeType: 'audio/wav',
      sizeBytes: audioBytes.length,
      contentHash: hash(audioBytes),
      storageMode: 'managed',
      managedPath: audioPath,
      metadata: {},
    }],
  ]);
  const document = {
    id: 'canvas-a',
    canvasId: 'canvas-a',
    projectId: 'project-local',
    revision: 9,
    nodes: [{
      id: 'image-node',
      type: 'image',
      data: {
        outputAssetId: 'asset-image',
        referenceAssetIds: ['asset-audio'],
        previewUrl: '/api/project-assets/asset-image/media',
        storyProject: {
          assets: [{
            id: 'story-logical-asset',
            sourceAssetId: 'asset-image',
          }],
          shots: [{ assetIds: ['story-logical-asset'] }],
        },
      },
    }],
  };
  const database = {
    getCanvas: (id) => id === 'canvas-a' ? document : null,
    getAsset: (id) => assets.get(String(id)) || null,
    getAssetCatalogRevision: () => 6,
    countAssets: ({ projectId }) => projectId === 'project-local' ? assets.size : 0,
    listAssets: () => [...assets.values()],
  };
  return { root, assets, document, database, imagePath, audioPath };
}

function request(server, options = {}, body = null) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      method: options.method || 'GET',
      path: options.path || '/',
      headers: {
        Host: '127.0.0.1:19031',
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: text ? JSON.parse(text) : null,
      }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function issueSession(auth, scopes) {
  const pairing = auth.createPairing({
    clientName: 'Codex 交付 Agent',
    agentKind: 'codex',
    requestedScopes: scopes,
  });
  auth.approvePairing({
    pairingId: pairing.pairingId,
    userCode: pairing.userCode,
    approvedScopes: scopes,
  });
  return auth.pollPairing({
    pairingId: pairing.pairingId,
    pollSecret: pairing.pollSecret,
  });
}

test('delivery collection resolves canvas asset references and reports every unverifiable item', async (t) => {
  const state = fixture(t);
  const service = createAgentControlDeliveryService({ database: state.database });
  assert.deepEqual(new Set(extractAssetIds(state.document)), new Set(['asset-image', 'asset-audio']));

  const collection = await service.collect(state.document, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    scope: 'canvas',
  });
  assert.equal(collection.ready, true);
  assert.equal(collection.items.length, 2);
  assert.equal(collection.items.find((item) => item.assetId === 'asset-image').renditionRole, 'master');
  assert.equal(collection.items.find((item) => item.assetId === 'asset-image').license.status, 'owned');
  assert.equal(collection.items.find((item) => item.assetId === 'asset-audio').license.status, 'unknown');
  assert.match(collection.selectionDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(collection).includes(state.root), false);

  const incompleteDocument = {
    ...state.document,
    nodes: [{ id: 'missing', type: 'output', data: { assetId: 'missing-asset' } }],
  };
  const incomplete = await service.collect(incompleteDocument, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
  });
  assert.equal(incomplete.ready, false);
  assert.deepEqual(incomplete.exclusions, [{
    assetId: 'missing-asset',
    reasonCode: 'asset-not-found',
    message: '素材不存在或不是项目素材',
  }]);
});

test('delivery package copies verified bytes atomically and detects later tampering', async (t) => {
  const state = fixture(t);
  const service = createAgentControlDeliveryService({ database: state.database });
  const target = path.join(state.root, '最终交付包');
  const preview = await service.inspectPackage(state.document, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    scope: 'canvas',
    targetPath: target,
  });
  assert.equal(preview.preview.riskLevel, 'L2');
  assert.equal(preview.preview.providerTransfer.occursNow, false);
  assert.equal(preview.preview.package.itemCount, 2);
  assert.equal(JSON.stringify(preview.preview).includes(state.root), false);

  const result = await service.packageDelivery(state.document, preview);
  assert.equal(result.itemCount, 2);
  assert.equal(fs.existsSync(path.join(target, 'zcanvas-delivery-manifest.json')), true);
  assert.equal(fs.existsSync(path.join(target, 'zcanvas-delivery-licenses.json')), true);
  assert.equal(result.files.some((item) => item.relativePath.startsWith('masters/images/')), true);
  assert.equal(result.files.some((item) => item.relativePath.startsWith('media/audio/')), true);

  const valid = await service.verifyPackage(target, {
    expectedPackageDigest: result.packageDigest,
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.verifiedItems, 2);
  assert.equal(valid.licenseSummary.unknown, 1);

  fs.appendFileSync(path.join(target, result.files[0].relativePath), 'tampered');
  const invalid = await service.verifyPackage(target, {
    expectedPackageDigest: result.packageDigest,
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.failures.some((failure) => failure.reasonCode === 'hash-or-size-mismatch'), true);
  assert.equal(invalid.failures.some((failure) => failure.reasonCode === 'verified-total-bytes-mismatch'), true);
});

test('delivery verify requires an independently pinned package digest', async (t) => {
  const state = fixture(t);
  const service = createAgentControlDeliveryService({ database: state.database });
  const target = path.join(state.root, 'digest-required');
  const preview = await service.inspectPackage(state.document, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    targetPath: target,
  });
  const result = await service.packageDelivery(state.document, preview);

  await assert.rejects(
    service.verifyPackage(target),
    (error) => error instanceof AgentControlDeliveryError
      && error.code === 'DELIVERY_EXPECTED_DIGEST_REQUIRED',
  );
  await assert.rejects(
    service.verifyPackage(target, { expectedPackageDigest: 'a'.repeat(65) }),
    (error) => error instanceof AgentControlDeliveryError
      && error.code === 'DELIVERY_EXPECTED_DIGEST_INVALID',
  );
  await assert.rejects(
    service.verifyPackage(target, { expectedPackageDigest: 'f'.repeat(64) }),
    (error) => error instanceof AgentControlDeliveryError
      && error.code === 'DELIVERY_PACKAGE_DIGEST_MISMATCH',
  );
  const verified = await service.verifyPackage(target, {
    expectedPackageDigest: result.packageDigest,
  });
  assert.equal(verified.valid, true);
});

test('delivery verify rejects rewritten media even when attacker rewrites and re-digests the manifest', async (t) => {
  const state = fixture(t);
  const service = createAgentControlDeliveryService({ database: state.database });
  const target = path.join(state.root, 'self-resigned-tamper');
  const preview = await service.inspectPackage(state.document, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    targetPath: target,
  });
  const result = await service.packageDelivery(state.document, preview);
  const manifestPath = path.join(target, 'zcanvas-delivery-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const rewrittenItem = manifest.items[0];
  const rewrittenBytes = Buffer.from('attacker-replaced-media');
  fs.writeFileSync(path.join(target, ...rewrittenItem.relativePath.split('/')), rewrittenBytes);
  rewrittenItem.size = rewrittenBytes.length;
  rewrittenItem.sha256 = hash(rewrittenBytes);
  manifest.totalBytes = manifest.items.reduce((total, item) => total + item.size, 0);
  manifest.packageDigest = manifestDigest(manifest);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  assert.notEqual(manifest.packageDigest, result.packageDigest);

  await assert.rejects(
    service.verifyPackage(target, { expectedPackageDigest: result.packageDigest }),
    (error) => error instanceof AgentControlDeliveryError
      && error.code === 'DELIVERY_PACKAGE_DIGEST_MISMATCH'
      && error.details?.expectedPackageDigest === result.packageDigest
      && error.details?.actualPackageDigest === manifest.packageDigest,
  );
});

test('delivery verify rejects files outside the exact manifest allowlist', async (t) => {
  const state = fixture(t);
  const service = createAgentControlDeliveryService({ database: state.database });
  const target = path.join(state.root, 'unexpected-file');
  const preview = await service.inspectPackage(state.document, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    targetPath: target,
  });
  const result = await service.packageDelivery(state.document, preview);
  fs.writeFileSync(path.join(target, 'not-in-manifest.txt'), 'unexpected');

  const verified = await service.verifyPackage(target, {
    expectedPackageDigest: result.packageDigest,
  });
  assert.equal(verified.valid, false);
  assert.equal(verified.failures.some((failure) => (
    failure.relativePath === 'not-in-manifest.txt'
      && failure.reasonCode === 'unexpected-package-file'
  )), true);
});

test('delivery verify recomputes itemCount and totalBytes instead of trusting manifest totals', async (t) => {
  const state = fixture(t);
  const service = createAgentControlDeliveryService({ database: state.database });
  const target = path.join(state.root, 'invalid-totals');
  const preview = await service.inspectPackage(state.document, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    targetPath: target,
  });
  await service.packageDelivery(state.document, preview);
  const manifestPath = path.join(target, 'zcanvas-delivery-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.itemCount += 1;
  manifest.totalBytes += 1;
  manifest.packageDigest = manifestDigest(manifest);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const verified = await service.verifyPackage(target, {
    expectedPackageDigest: manifest.packageDigest,
  });
  assert.equal(verified.valid, false);
  const reasons = new Set(verified.failures.map((failure) => failure.reasonCode));
  assert.equal(reasons.has('manifest-item-count-mismatch'), true);
  assert.equal(reasons.has('manifest-total-bytes-mismatch'), true);
  assert.equal(reasons.has('verified-total-bytes-mismatch'), true);
});

test('delivery refuses source changes and existing output instead of making partial packages', async (t) => {
  const state = fixture(t);
  const service = createAgentControlDeliveryService({ database: state.database });
  const target = path.join(state.root, 'delivery-a');
  const preview = await service.inspectPackage(state.document, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    targetPath: target,
  });
  fs.appendFileSync(state.audioPath, 'changed-after-preview');
  await assert.rejects(
    service.packageDelivery(state.document, preview),
    (error) => error instanceof AgentControlDeliveryError && error.code === 'DELIVERY_SOURCE_CHANGED',
  );
  assert.equal(fs.existsSync(target), false);

  const existing = path.join(state.root, 'existing');
  fs.mkdirSync(existing);
  await assert.rejects(
    service.inspectPackage(state.document, {
      projectId: 'project-local',
      canvasId: 'canvas-a',
      assetIds: ['asset-image'],
      targetPath: existing,
    }),
    (error) => error instanceof AgentControlDeliveryError && error.code === 'DELIVERY_TARGET_EXISTS',
  );
});

test('delivery HTTP route requires one exact approval and never exposes source paths', async (t) => {
  const state = fixture(t);
  const auth = createAgentControlAuthService();
  const approvals = createAgentControlApprovalService();
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/agent-control/v1', agentControlRoute.createAgentControlRouter({
    auth,
    approvals,
    deliveryService: createAgentControlDeliveryService({ database: state.database }),
    config: {
      PORT: 19031,
      APP_VERSION: '2.6.4',
      BACKEND_INSTANCE_ID: 'b'.repeat(43),
    },
    database: state.database,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const session = issueSession(auth, ['asset:read', 'asset:transfer']);
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const collected = await request(server, {
    path: '/api/agent-control/v1/delivery/collect?projectId=project-local&canvasId=canvas-a&scope=canvas',
    headers,
  });
  assert.equal(collected.status, 200);
  assert.equal(collected.body.data.ready, true);

  const target = path.join(state.root, 'route-delivery');
  const created = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/delivery-package-approvals',
    headers,
  }, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    scope: 'canvas',
    targetPath: target,
    operationId: 'delivery-route-a',
  });
  assert.equal(created.status, 202);
  assert.equal(created.body.data.action, 'delivery.package');
  assert.equal(created.body.data.preview.package.itemCount, 2);
  assert.equal(JSON.stringify(created.body).includes(state.root), false);
  assert.equal(fs.existsSync(target), false);

  const pending = await request(server, {
    method: 'POST',
    path: `/api/agent-control/v1/approvals/${created.body.data.approvalRequestId}/complete`,
    headers,
  }, { pollSecret: created.body.data.pollSecret });
  assert.equal(pending.body.data.status, 'pending');
  approvals.approve(created.body.data.approvalRequestId);
  const completed = await request(server, {
    method: 'POST',
    path: `/api/agent-control/v1/approvals/${created.body.data.approvalRequestId}/complete`,
    headers,
  }, { pollSecret: created.body.data.pollSecret });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.data.itemCount, 2);
  assert.equal(JSON.stringify(completed.body).includes(state.root), false);

  const verified = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/delivery/verify',
    headers,
  }, {
    packagePath: target,
    expectedPackageDigest: completed.body.data.packageDigest,
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.valid, true);
});
