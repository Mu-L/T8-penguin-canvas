const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function requestJson(baseUrl, pathname, options = {}) {
  const hasBody = Object.hasOwn(options, 'body');
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: hasBody ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  return { response, payload, text };
}

async function requestWithHost(baseUrl, pathname, host) {
  const target = new URL(`${baseUrl}${pathname}`);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { Host: host },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({
        response: { status: response.statusCode },
        payload: text ? JSON.parse(text) : null,
        text,
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

function collectObjectKeys(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjectKeys(item, output));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      output.push(key);
      collectObjectKeys(item, output);
    });
  }
  return output;
}

function assertPublicSemanticSafe(payload, forbiddenValues = []) {
  const serialized = JSON.stringify(payload);
  for (const value of forbiddenValues.filter(Boolean)) {
    assert.equal(serialized.includes(String(value)), false, `semantic response leaked ${value}`);
    assert.equal(serialized.includes(String(value).replace(/\\/g, '/')), false, `semantic response leaked normalized ${value}`);
  }
  for (const marker of [
    'sk-http-d4-super-secret',
    'Bearer http-d4-secret',
    'http-d4-signed-secret',
    'private-model-repository.invalid',
  ]) assert.equal(serialized.includes(marker), false, `semantic response leaked ${marker}`);
  const keys = new Set(collectObjectKeys(payload).map((key) => key.toLowerCase()));
  for (const forbiddenKey of [
    'repo', 'repoid', 'repository', 'downloadurl', 'installpath', 'modelpath', 'weight', 'weights',
    'sha256', 'vector', 'embeddingvector', 'claimtoken', 'managedpath', 'sourcepath', 'sourcelocator',
    'apikey', 'authorization', 'credential', 'password', 'secret',
  ]) assert.equal(keys.has(forbiddenKey), false, `semantic response exposed ${forbiddenKey}`);
}

function profileBody(projectId, embeddingModel, expectedRevision = 0) {
  return {
    projectId,
    expectedRevision,
    enabled: true,
    embedding: {
      enabled: true,
      modelKey: embeddingModel.modelId,
      modelVersion: embeddingModel.revision,
    },
    updatedBy: `C:\\private\\semantic-owner-${projectId} sk-http-d4-super-secret`,
  };
}

class InstalledSemanticWorker {
  constructor(getPublicSemanticModel) {
    this.getPublicSemanticModel = getPublicSemanticModel;
    this.closed = false;
    this.indexGate = null;
    this.nextIndexFailure = null;
  }

  status(modelId) {
    const model = this.getPublicSemanticModel(modelId);
    return {
      ...model,
      installed: true,
      verified: true,
      state: 'installed',
      downloadedBytes: model.downloadBytes,
      totalBytes: model.downloadBytes,
      installPath: `C:\\private\\models\\${modelId}`,
      repository: 'https://private-model-repository.invalid/repo?token=http-d4-signed-secret',
      apiKey: 'sk-http-d4-super-secret',
    };
  }

  getModelStatus(modelId) { return this.status(modelId); }
  getDownloadProgress(modelId) { return this.status(modelId); }
  verifyModel(modelId) { return Promise.resolve(this.status(modelId)); }
  downloadModel() { throw new Error('installed HTTP fixture must not download models'); }
  removeModel(modelId) { return Promise.resolve({ ...this.status(modelId), installed: false, state: 'not-installed' }); }

  gateNextIndexing() {
    let markStarted;
    let release;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const released = new Promise((resolve) => { release = resolve; });
    this.indexGate = { markStarted, released };
    return { started, release };
  }

  failNextIndexing() {
    this.nextIndexFailure = {
      code: 'asset-semantic-model-not-installed',
      message: 'fixture terminal indexing failure C:\\private\\semantic-worker.log apiKey=sk-http-d4-super-secret',
    };
  }

  async execute(input) {
    if (input.task !== 'embedding') throw new Error('HTTP fixture enables only embedding');
    const text = String(input.text || '').toLowerCase();
    const isIndexing = text.includes('filename:');
    if (isIndexing && this.indexGate) {
      const gate = this.indexGate;
      this.indexGate = null;
      gate.markStarted();
      await gate.released;
    }
    if (isIndexing && this.nextIndexFailure) {
      const failure = this.nextIndexFailure;
      this.nextIndexFailure = null;
      const error = new Error(failure.message);
      error.code = failure.code;
      throw error;
    }
    const vector = new Array(384).fill(0);
    if (text.includes('alpha')) vector[0] = 1;
    else vector[1] = 1;
    return { vector, dimension: vector.length };
  }

  close() { this.closed = true; }
}

test('D4 project-assets HTTP is loopback-managed, CAS-bound, project-isolated and public-safe', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-project-assets-d4-http-'));
  const previousPackaged = process.env.T8PC_PACKAGED;
  const previousUserData = process.env.T8PC_USER_DATA;
  const previousManagementToken = process.env.T8_COLLAB_MANAGEMENT_TOKEN;
  process.env.T8PC_PACKAGED = '1';
  process.env.T8PC_USER_DATA = directory;
  process.env.T8_COLLAB_MANAGEMENT_TOKEN = 'A'.repeat(43);
  fs.mkdirSync(path.join(directory, 'input'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'output'), { recursive: true });

  const config = require('../backend/src/config');
  const router = require('../backend/src/routes/projectAssets');
  const { getProjectDatabase } = require('../backend/src/services/projectDatabase');
  const { getPublicSemanticModel, getPublicSemanticModelManifest } = require('../backend/src/services/assetSemanticModels');
  const database = getProjectDatabase(config);
  const pipeline = router.semanticPipeline;
  pipeline.worker.close();
  const worker = new InstalledSemanticWorker(getPublicSemanticModel);
  pipeline.worker = worker;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/project-assets', router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/project-assets`;
  const projectA = 'd4-http-project-a';
  const projectB = 'd4-http-project-b';
  const emptyProject = 'd4-http-empty-project';
  const retryProject = 'd4-http-retry-project';
  const privateRoot = path.join(directory, 'private-semantic-assets');
  const models = getPublicSemanticModelManifest();
  const embeddingModel = models.find((model) => model.task === 'embedding');
  assert.ok(embeddingModel);

  const addAsset = (id, projectId, label) => database.upsertAsset({
    id,
    projectId,
    kind: 'image',
    mimeType: 'image/png',
    filename: `${label}.png`,
    managedPath: path.join(privateRoot, `${id}.png`),
    sourceUrl: `/api/project-assets/${encodeURIComponent(id)}/media`,
    storageMode: 'linked',
    availability: 'available',
    contentHash: sha256(`${projectId}:${id}`),
    contentHashVerification: 'verified',
    metadata: {
      description: `${label} semantic fixture`,
      sourcePath: path.join(privateRoot, `${id}-metadata.png`),
      apiKey: 'sk-http-d4-super-secret',
      authorization: 'Bearer http-d4-secret',
      signedUrl: 'https://example.invalid/private?token=http-d4-signed-secret',
    },
    provenance: {
      source: 'd4-http-fixture',
      localPath: path.join(privateRoot, `${id}-provenance.png`),
      credential: 'http-d4-signed-secret',
    },
  });

  try {
    await t.test('initial status is revision zero and public model fields are fixed', async () => {
      assert.equal(router.isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } }), true);
      assert.equal(router.isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
      assert.equal(router.isLoopbackRequest({ socket: { remoteAddress: '203.0.113.9' } }), false);

      const initial = await requestJson(baseUrl, `/semantic/status?projectId=${encodeURIComponent(projectA)}`);
      assert.equal(initial.response.status, 200);
      assert.equal(initial.payload.data.project.projectId, projectA);
      assert.equal(initial.payload.data.project.revision, 0);
      assert.equal(initial.payload.data.project.indexState, 'disabled');
      assert.equal(initial.payload.data.models.length, 3);
      for (const model of initial.payload.data.models) {
        assert.deepEqual(Object.keys(model).sort(), [
          'capability', 'downloadedBytes', 'error', 'installState', 'installed', 'key', 'label',
          'revision', 'totalBytes', 'updatedAt', 'version',
        ].sort());
      }
      assertPublicSemanticSafe(initial.payload, [privateRoot]);

      const embeddingStatus = initial.payload.data.models.find((model) => model.key === embeddingModel.modelId);
      const hostileOrigin = await requestJson(baseUrl, `/semantic/status?projectId=${encodeURIComponent(projectA)}`, {
        headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
      });
      assert.equal(hostileOrigin.response.status, 403);
      assert.equal(hostileOrigin.payload.code, 'trusted_loopback_required');
      const reboundHost = await requestWithHost(
        baseUrl,
        `/semantic/status?projectId=${encodeURIComponent(projectA)}`,
        'evil.example:18766',
      );
      assert.equal(reboundHost.response.status, 403);
      assert.equal(reboundHost.payload.code, 'trusted_loopback_required');
      const formAttemptResponse = await fetch(
        `${baseUrl}/semantic/models/${encodeURIComponent(embeddingModel.modelId)}/download`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: new URL(baseUrl).origin,
            'Sec-Fetch-Site': 'same-origin',
          },
          body: `expectedRevision=${embeddingStatus.revision}&idempotencyKey=csrf-form-download`,
        },
      );
      const formAttempt = await formAttemptResponse.json();
      assert.equal(formAttemptResponse.status, 415);
      assert.equal(formAttempt.code, 'semantic_json_required');
      assert.equal(
        database.getAssetSemanticModel(embeddingModel.modelId, embeddingModel.revision),
        null,
        'status GET and a rejected form mutation must not materialize semantic model rows',
      );
      const refreshedModels = await requestJson(baseUrl, '/semantic/models/refresh', {
        method: 'POST',
        body: { projectId: projectA },
      });
      assert.equal(refreshedModels.response.status, 200);
      assert.equal(refreshedModels.payload.data.project.projectId, projectA);
      const refreshedEmbedding = refreshedModels.payload.data.models.find((model) => model.key === embeddingModel.modelId);
      assert.equal(refreshedEmbedding.installed, true);
      assert.equal(
        database.getAssetSemanticModel(embeddingModel.modelId, embeddingModel.revision).revision,
        refreshedEmbedding.revision,
        'the explicit model refresh may atomically materialize observed model state',
      );
      const localManagement = await requestJson(
        baseUrl,
        `/semantic/models/${encodeURIComponent(embeddingModel.modelId)}/download`,
        { method: 'POST', body: { expectedRevision: refreshedEmbedding.revision, idempotencyKey: 'd4-http-installed-model' } },
      );
      assert.equal(localManagement.response.status, 202);
      assert.equal(localManagement.payload.data.key, embeddingModel.modelId);
      assert.equal(
        database.getAssetSemanticModel(embeddingModel.modelId, embeddingModel.revision).revision,
        localManagement.payload.data.revision,
        'the explicit download mutation may materialize its model row',
      );
      assertPublicSemanticSafe(localManagement.payload, [privateRoot]);

      const missingCas = await requestJson(baseUrl, '/semantic/profile', {
        method: 'PUT', body: { projectId: projectA, enabled: true },
      });
      assert.equal(missingCas.response.status, 400);
      assert.equal(missingCas.payload.code, 'expected_revision_required');
    });

    const assetA = addAsset('d4-http-alpha', projectA, 'alpha-cat');
    const assetB = addAsset('d4-http-beta', projectB, 'beta-dog');

    await t.test('profile revision zero is accepted once and stale CAS returns a sanitized 409', async () => {
      const savedA = await requestJson(baseUrl, '/semantic/profile', {
        method: 'PUT', body: profileBody(projectA, embeddingModel, 0),
      });
      assert.equal(savedA.response.status, 200);
      assert.equal(savedA.payload.data.project.revision, 1);
      assert.equal(savedA.payload.data.project.capabilities.embedding.enabled, true);
      assertPublicSemanticSafe(savedA.payload, [privateRoot, `C:\\private\\semantic-owner-${projectA}`]);

      const staleA = await requestJson(baseUrl, '/semantic/profile', {
        method: 'PUT', body: { ...profileBody(projectA, embeddingModel, 0), enabled: false },
      });
      assert.equal(staleA.response.status, 409);
      assert.equal(staleA.payload.code, 'asset_semantic_profile_revision_conflict');
      assert.equal(staleA.payload.current.revision, 1);
      assertPublicSemanticSafe(staleA.payload, [privateRoot, `C:\\private\\semantic-owner-${projectA}`]);

      const savedB = await requestJson(baseUrl, '/semantic/profile', {
        method: 'PUT', body: profileBody(projectB, embeddingModel, 0),
      });
      assert.equal(savedB.response.status, 200);
      assert.equal(savedB.payload.data.project.revision, 1);
    });

    await t.test('an active empty embedding generation reports empty rather than ready', async () => {
      const configured = await requestJson(baseUrl, '/semantic/profile', {
        method: 'PUT', body: profileBody(emptyProject, embeddingModel, 0),
      });
      assert.equal(configured.response.status, 200);
      const rebuilt = await requestJson(baseUrl, '/semantic/rebuild', {
        method: 'POST',
        body: {
          projectId: emptyProject,
          expectedRevision: configured.payload.data.project.revision,
          idempotencyKey: 'rebuild-empty-project',
        },
      });
      assert.equal(rebuilt.response.status, 202, JSON.stringify(rebuilt.payload));
      assert.equal(rebuilt.payload.data.status, 'active');
      assert.equal(rebuilt.payload.status.project.indexState, 'empty');
      assert.equal(rebuilt.payload.status.project.capabilities.embedding.succeeded, 0);
      assert.deepEqual(Object.keys(rebuilt.payload.data).sort(), [
        'catalogRevision', 'counts', 'createdAt', 'eligibleAssetCount', 'error', 'excludedAssetCount',
        'expectedJobCount', 'finishedAt', 'generation', 'jobsSealed', 'profileRevision',
        'payloadPrunedAt', 'projectId', 'revision', 'status', 'updatedAt',
      ].sort());
      assertPublicSemanticSafe(rebuilt.payload, [privateRoot, `C:\\private\\semantic-owner-${emptyProject}`]);
    });

    let statusA;
    let statusB;
    await t.test('real rebuild and search stay project-scoped and revision-bound', async () => {
      const rebuildA = await requestJson(baseUrl, '/semantic/rebuild', {
        method: 'POST', body: { projectId: projectA, expectedRevision: 1, idempotencyKey: 'rebuild-a' },
      });
      const rebuildB = await requestJson(baseUrl, '/semantic/rebuild', {
        method: 'POST', body: { projectId: projectB, expectedRevision: 1, idempotencyKey: 'rebuild-b' },
      });
      assert.equal(rebuildA.response.status, 202);
      assert.equal(rebuildB.response.status, 202);
      assertPublicSemanticSafe(rebuildA.payload, [privateRoot]);
      assertPublicSemanticSafe(rebuildB.payload, [privateRoot]);
      assert.equal(await pipeline.waitForIdle(10_000), true);

      statusA = (await requestJson(baseUrl, `/semantic/status?projectId=${encodeURIComponent(projectA)}`)).payload.data;
      statusB = (await requestJson(baseUrl, `/semantic/status?projectId=${encodeURIComponent(projectB)}`)).payload.data;
      assert.equal(statusA.project.indexState, 'ready');
      assert.equal(statusB.project.indexState, 'ready');
      assert.equal(statusA.project.capabilities.embedding.succeeded, 1);
      assert.equal(statusB.project.capabilities.embedding.succeeded, 1);

      const searchA = await requestJson(baseUrl, '/semantic/search', {
        method: 'POST',
        body: {
          projectId: projectA,
          query: 'alpha cat',
          limit: 10,
          offset: 0,
          expectedCatalogRevision: statusA.project.currentCatalogRevision,
          expectedProfileRevision: statusA.project.revision,
          expectedGeneration: statusA.project.activeGeneration,
        },
      });
      assert.equal(searchA.response.status, 200);
      assert.deepEqual(searchA.payload.data.map((hit) => hit.asset.id), [assetA.id]);
      assert.equal(searchA.payload.data.some((hit) => hit.asset.id === assetB.id), false);
      assert.equal(searchA.payload.meta.projectId, projectA);
      assertPublicSemanticSafe(searchA.payload, [privateRoot]);

      const searchB = await requestJson(baseUrl, '/semantic/search', {
        method: 'POST',
        body: {
          projectId: projectB,
          query: 'alpha cat',
          expectedCatalogRevision: statusB.project.currentCatalogRevision,
          expectedProfileRevision: statusB.project.revision,
          expectedGeneration: statusB.project.activeGeneration,
        },
      });
      assert.equal(searchB.response.status, 200);
      assert.equal(searchB.payload.data.every((hit) => hit.asset.projectId === projectB), true);
      assert.equal(searchB.payload.data.some((hit) => hit.asset.id === assetA.id), false);

      const crossProjectDocuments = await requestJson(
        baseUrl,
        `/semantic/assets/${encodeURIComponent(assetA.id)}?projectId=${encodeURIComponent(projectB)}`,
      );
      assert.equal(crossProjectDocuments.response.status, 404);

      const staleSearch = await requestJson(baseUrl, '/semantic/search', {
        method: 'POST',
        body: {
          projectId: projectA,
          query: 'alpha cat',
          expectedCatalogRevision: Number(statusA.project.currentCatalogRevision) + 1,
          expectedProfileRevision: statusA.project.revision,
          expectedGeneration: statusA.project.activeGeneration,
        },
      });
      assert.equal(staleSearch.response.status, 409);
      assert.equal(staleSearch.payload.code, 'asset_catalog_revision_conflict');
      assertPublicSemanticSafe(staleSearch.payload, [privateRoot]);
    });

    await t.test('disabled Caption/OCR documents stay private in details and vector evidence', async () => {
      const captionModel = models.find((model) => model.task === 'caption');
      const hiddenText = 'disabled caption must never be returned';
      database.db.prepare(`
        INSERT INTO asset_semantic_documents(
          project_id, asset_id, generation, content_hash, document_kind,
          model_key, model_version, text, language, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'caption', ?, ?, ?, 'en', '{}', ?, ?)
      `).run(
        projectA, assetA.id, statusA.project.activeGeneration, assetA.contentHash,
        captionModel.modelId, captionModel.revision, hiddenText, Date.now(), Date.now(),
      );
      const details = await requestJson(
        baseUrl,
        `/semantic/assets/${encodeURIComponent(assetA.id)}?projectId=${encodeURIComponent(projectA)}`,
      );
      assert.equal(details.response.status, 200);
      assert.deepEqual(details.payload.data, []);
      const search = await requestJson(baseUrl, '/semantic/search', {
        method: 'POST',
        body: {
          projectId: projectA,
          query: 'alpha',
          expectedCatalogRevision: statusA.project.currentCatalogRevision,
          expectedProfileRevision: statusA.project.revision,
          expectedGeneration: statusA.project.activeGeneration,
        },
      });
      assert.equal(search.response.status, 200, JSON.stringify(search.payload));
      assert.equal(JSON.stringify(search.payload).includes(hiddenText), false);
      assert.equal(search.payload.data.every((hit) => hit.evidence.every((entry) => !['caption', 'ocr'].includes(entry.source))), true);
    });

    await t.test('search evidence is bounded and strips repository, path, vector and credential internals', async () => {
      const originalSearch = pipeline.search;
      pipeline.search = async () => ({
        items: [{
          asset: database.getAsset(assetA.id),
          score: 0.75,
          vector: [1, 2, 3],
          embeddingVector: new Float32Array([1, 2, 3]),
          repository: 'https://private-model-repository.invalid/repo',
          matches: [{
            sourceKind: 'ocr',
            snippet: 'alpha visible evidence',
            language: 'en',
            modelKey: embeddingModel.modelId,
            modelVersion: embeddingModel.revision,
            vector: [9, 9],
            metadata: {
              frameIndex: 2,
              time: 1.5,
              bbox: [1, 2, 3, 4],
              sourcePath: path.join(privateRoot, 'evidence.png'),
              apiKey: 'sk-http-d4-super-secret',
            },
          }],
        }],
        total: 1,
        offset: 0,
        limit: 10,
        scoreMetric: 'rrf-k60',
        queryDigest: sha256('public-probe'),
        catalogRevision: statusA.project.currentCatalogRevision,
        semanticIndexRevision: statusA.project.activeIndexRevision,
        profileRevision: statusA.project.revision,
        activeGeneration: statusA.project.activeGeneration,
        modelKey: embeddingModel.modelId,
        modelVersion: embeddingModel.revision,
        stale: false,
      });
      try {
        const probe = await requestJson(baseUrl, '/semantic/search', {
          method: 'POST', body: { projectId: projectA, query: 'public probe' },
        });
        assert.equal(probe.response.status, 200);
        assert.equal(probe.payload.data[0].evidence[0].source, 'ocr');
        assert.equal(probe.payload.data[0].evidence[0].modelKey, embeddingModel.modelId);
        assert.equal(probe.payload.data[0].evidence[0].modelVersion, embeddingModel.revision);
        assert.equal(probe.payload.data[0].evidence[0].frameIndex, 2);
        assert.equal(probe.payload.data[0].evidence[0].time, 1.5);
        assert.deepEqual(probe.payload.data[0].evidence[0].bbox, [1, 2, 3, 4]);
        assertPublicSemanticSafe(probe.payload, [privateRoot]);
      } finally {
        pipeline.search = originalSearch;
      }
    });

    await t.test('catalog drift during a real HTTP rebuild rejects promotion and keeps the old active searchable', async () => {
      const oldActiveGeneration = statusA.project.activeGeneration;
      const gate = worker.gateNextIndexing();
      const replacement = await requestJson(baseUrl, '/semantic/rebuild', {
        method: 'POST',
        body: {
          projectId: projectA,
          expectedRevision: statusA.project.revision,
          idempotencyKey: 'rebuild-a-catalog-drift',
        },
      });
      assert.equal(replacement.response.status, 202, JSON.stringify(replacement.payload));
      assert.equal(replacement.payload.data.status, 'building');
      let gateTimeout = null;
      try {
        await Promise.race([
          gate.started,
          new Promise((_, reject) => {
            gateTimeout = setTimeout(() => reject(new Error('indexing gate did not start')), 5_000);
          }),
        ]);
        const embeddingState = statusA.models.find((model) => model.key === embeddingModel.modelId);
        const modelInUse = await requestJson(baseUrl, `/semantic/models/${encodeURIComponent(embeddingModel.modelId)}`, {
          method: 'DELETE', body: { expectedRevision: embeddingState.revision },
        });
        assert.equal(modelInUse.response.status, 409, JSON.stringify(modelInUse.payload));
        assert.equal(modelInUse.payload.code, 'asset_semantic_model_in_use');
        addAsset('d4-http-added-during-rebuild', projectA, 'catalog-added-during-rebuild');
      } finally {
        if (gateTimeout) clearTimeout(gateTimeout);
        gate.release();
      }
      assert.equal(await pipeline.waitForIdle(10_000), true);

      const driftStatusResponse = await requestJson(baseUrl, `/semantic/status?projectId=${encodeURIComponent(projectA)}`);
      assert.equal(driftStatusResponse.response.status, 200);
      statusA = driftStatusResponse.payload.data;
      assert.equal(statusA.project.indexState, 'stale');
      assert.equal(statusA.project.indexStale, true);
      assert.equal(statusA.project.activeGeneration, oldActiveGeneration);
      assert.equal(statusA.project.buildingGeneration, null);
      assert.equal(statusA.rebuild.generation, replacement.payload.data.generation);
      assert.equal(statusA.rebuild.status, 'failed');
      assert.equal(database.getAssetSemanticGeneration(projectA, oldActiveGeneration).status, 'active');
      assert.equal(database.getAssetSemanticGeneration(projectA, replacement.payload.data.generation).status, 'failed');
      assertPublicSemanticSafe(driftStatusResponse.payload, [privateRoot]);

      const retainedSearch = await requestJson(baseUrl, '/semantic/search', {
        method: 'POST',
        body: {
          projectId: projectA,
          query: 'alpha cat',
          expectedCatalogRevision: statusA.project.currentCatalogRevision,
          expectedProfileRevision: statusA.project.revision,
          expectedGeneration: oldActiveGeneration,
        },
      });
      assert.equal(retainedSearch.response.status, 200, JSON.stringify(retainedSearch.payload));
      assert.equal(retainedSearch.payload.data.some((hit) => hit.asset.id === assetA.id), true);
      assert.equal(retainedSearch.payload.data.some((hit) => hit.asset.id === 'd4-http-added-during-rebuild'), false);
      assert.equal(retainedSearch.payload.meta.stale, true);
    });

    await t.test('a real terminal worker failure is visible, retryable by exact CAS, and promotes through HTTP', async () => {
      const oldActiveGeneration = statusB.project.activeGeneration;
      worker.failNextIndexing();
      const replacement = await requestJson(baseUrl, '/semantic/rebuild', {
        method: 'POST',
        body: {
          projectId: projectB,
          expectedRevision: statusB.project.revision,
          idempotencyKey: 'rebuild-b-terminal-failure',
        },
      });
      assert.equal(replacement.response.status, 202, JSON.stringify(replacement.payload));
      assert.equal(await pipeline.waitForIdle(10_000), true);

      const failedStatusResponse = await requestJson(baseUrl, `/semantic/status?projectId=${encodeURIComponent(projectB)}`);
      assert.equal(failedStatusResponse.response.status, 200);
      const failedStatus = failedStatusResponse.payload.data;
      assert.equal(failedStatus.project.indexState, 'degraded');
      assert.equal(failedStatus.project.indexStale, false);
      assert.equal(failedStatus.project.activeGeneration, oldActiveGeneration);
      assert.equal(failedStatus.project.buildingGeneration, null);
      assert.equal(failedStatus.rebuild.generation, replacement.payload.data.generation);
      assert.equal(failedStatus.rebuild.status, 'failed');
      assert.equal(failedStatus.project.capabilities.embedding.failed, 1);
      assertPublicSemanticSafe(failedStatusResponse.payload, [privateRoot]);

      const oldActiveSearch = await requestJson(baseUrl, '/semantic/search', {
        method: 'POST',
        body: {
          projectId: projectB,
          query: 'beta dog',
          expectedCatalogRevision: failedStatus.project.currentCatalogRevision,
          expectedProfileRevision: failedStatus.project.revision,
          expectedGeneration: oldActiveGeneration,
        },
      });
      assert.equal(oldActiveSearch.response.status, 200, JSON.stringify(oldActiveSearch.payload));
      assert.equal(oldActiveSearch.payload.data.some((hit) => hit.asset.id === assetB.id), true);

      const failedJob = database.listAssetSemanticJobs({
        projectId: projectB,
        generation: replacement.payload.data.generation,
        limit: 20,
      }).find((job) => job.status === 'failed');
      assert.ok(failedJob);
      const retried = await requestJson(baseUrl, `/semantic/jobs/${encodeURIComponent(failedJob.id)}/retry`, {
        method: 'POST', body: { projectId: projectB, expectedRevision: failedJob.revision },
      });
      assert.equal(retried.response.status, 200, JSON.stringify(retried.payload));
      assert.equal(retried.payload.data[0].status, 'queued');
      assertPublicSemanticSafe(retried.payload, [privateRoot]);
      assert.equal(await pipeline.waitForIdle(10_000), true);

      const recoveredStatusResponse = await requestJson(baseUrl, `/semantic/status?projectId=${encodeURIComponent(projectB)}`);
      statusB = recoveredStatusResponse.payload.data;
      assert.equal(statusB.project.indexState, 'ready');
      assert.equal(statusB.project.indexStale, false);
      assert.equal(statusB.project.activeGeneration, replacement.payload.data.generation);
      assert.equal(statusB.project.buildingGeneration, null);
      assert.equal(statusB.rebuild.status, 'active');
      assert.equal(database.getAssetSemanticGeneration(projectB, oldActiveGeneration).status, 'superseded');
      assert.equal(database.getAssetSemanticGeneration(projectB, replacement.payload.data.generation).status, 'active');

      const recoveredSearch = await requestJson(baseUrl, '/semantic/search', {
        method: 'POST',
        body: {
          projectId: projectB,
          query: 'beta dog',
          expectedCatalogRevision: statusB.project.currentCatalogRevision,
          expectedProfileRevision: statusB.project.revision,
          expectedGeneration: statusB.project.activeGeneration,
        },
      });
      assert.equal(recoveredSearch.response.status, 200, JSON.stringify(recoveredSearch.payload));
      assert.equal(recoveredSearch.payload.data.some((hit) => hit.asset.id === assetB.id), true);
    });

    await t.test('retry requires exact project ownership and CAS without leaking persisted errors', async () => {
      const retryAsset = addAsset('d4-http-retry-asset', retryProject, 'retry-private');
      const configured = await requestJson(baseUrl, '/semantic/profile', {
        method: 'PUT', body: profileBody(retryProject, embeddingModel, 0),
      });
      assert.equal(configured.response.status, 200);
      const generation = database.beginAssetSemanticRebuild(retryProject, {
        expectedProfileRevision: configured.payload.data.project.revision,
        createdBy: 'http-retry-owner',
      });
      const queued = database.enqueueAssetSemanticJob({
        projectId: retryProject,
        assetId: retryAsset.id,
        contentHash: retryAsset.contentHash,
        generation: generation.generation,
        jobKind: 'embedding',
        modelKey: embeddingModel.modelId,
        modelVersion: embeddingModel.revision,
        pipelineVersion: 'd4-http-test-v1',
        maxAttempts: 3,
        inputDigest: 'pending',
      });
      database.sealAssetSemanticRebuild(retryProject, generation.generation, {
        expectedProfileRevision: database.getAssetSemanticProfile(retryProject).revision,
        expectedGenerationRevision: database.getAssetSemanticGeneration(retryProject, generation.generation).revision,
      });
      const claimed = database.claimNextAssetSemanticJob({ projectId: retryProject, now: Date.now() });
      assert.equal(claimed.id, queued.id);
      const privateErrorPath = path.join(privateRoot, 'worker-crash.log');
      const failed = database.rescheduleAssetSemanticJob(claimed.id, {
        code: 'asset-semantic-private-worker-failure',
        message: `${privateErrorPath} Authorization: Bearer http-d4-secret apiKey=sk-http-d4-super-secret`,
      }, {
        claimToken: claimed.claimToken,
        expectedRevision: claimed.revision,
        retryable: false,
        now: Date.now(),
      });
      assert.equal(failed.status, 'failed');

      const wrongProject = await requestJson(baseUrl, `/semantic/jobs/${encodeURIComponent(failed.id)}/retry`, {
        method: 'POST', body: { projectId: projectB, expectedRevision: failed.revision },
      });
      assert.equal(wrongProject.response.status, 400);
      assert.equal(wrongProject.payload.code, 'asset_semantic_job_not_found');
      assert.equal(database.getAssetSemanticJob(failed.id).status, 'failed');
      assertPublicSemanticSafe(wrongProject.payload, [privateRoot, privateErrorPath]);

      const stale = await requestJson(baseUrl, `/semantic/jobs/${encodeURIComponent(failed.id)}/retry`, {
        method: 'POST', body: { projectId: retryProject, expectedRevision: failed.revision - 1 },
      });
      assert.equal(stale.response.status, 409);
      assert.equal(stale.payload.code, 'asset_semantic_job_revision_conflict');
      assert.equal(stale.payload.current.revision, failed.revision);
      assertPublicSemanticSafe(stale.payload, [privateRoot, privateErrorPath]);

      const retried = await requestJson(baseUrl, `/semantic/jobs/${encodeURIComponent(failed.id)}/retry`, {
        method: 'POST', body: { projectId: retryProject, expectedRevision: failed.revision },
      });
      assert.equal(retried.response.status, 200);
      assert.equal(retried.payload.data.length, 1);
      assert.equal(retried.payload.data[0].projectId, retryProject);
      assert.equal(retried.payload.data[0].status, 'queued');
      assert.deepEqual(Object.keys(retried.payload.data[0]).sort(), [
        'assetId', 'attemptCount', 'createdAt', 'error', 'finishedAt', 'generation', 'id', 'jobKind',
        'maxAttempts', 'modelKey', 'modelVersion', 'nextAttemptAt', 'projectId', 'revision', 'startedAt',
        'status', 'updatedAt',
      ].sort());
      assertPublicSemanticSafe(retried.payload, [privateRoot, privateErrorPath]);
      assert.equal(await pipeline.waitForIdle(10_000), true);
    });
  } finally {
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
  }
  assert.equal(worker.closed, true);
});

test('backend shutdown owns semantic close and drains preview work before ProjectDatabase close', () => {
  const serverSource = fs.readFileSync(path.resolve(__dirname, '../backend/src/server.js'), 'utf8');
  const routeSource = fs.readFileSync(path.resolve(__dirname, '../backend/src/routes/projectAssets.js'), 'utf8');
  const semanticPipelineSource = fs.readFileSync(path.resolve(__dirname, '../backend/src/services/assetSemanticPipeline.js'), 'utf8');
  const previewPipelineSource = fs.readFileSync(path.resolve(__dirname, '../backend/src/services/assetPreviewPipeline.js'), 'utf8');
  assert.match(routeSource, /module\.exports\.semanticPipeline\s*=\s*semanticPipeline/);
  assert.match(routeSource, /module\.exports\.previewPipeline\s*=\s*previewPipeline/);
  assert.match(serverSource, /projectAssetsRouter\.semanticPipeline\?\.close\?\.\(\)/);
  assert.match(
    serverSource,
    /await shutdownRunRecoveryLifecycle\(\);\s*await shutdownPreviewPipelineLifecycle\(\);\s*await shutdownVideoOperationsLifecycle\(\);\s*await shutdownCollaborationGatewayLifecycle\(\);\s*await videoOpsRouter\.waitForShutdownDrain\?\.\(\);\s*await collaborationGateway\.waitForApplicationRequests\?\.\(\);\s*await closeProjectDatabaseLifecycle\(\);/,
  );
  assert.match(
    serverSource,
    /const previewShutdown = shutdownPreviewPipelineLifecycle\(\);[\s\S]{0,800}const recoveryShutdown = shutdownRunRecoveryLifecycle\(\);/,
  );
  assert.match(serverSource, /await serverStartPromise/);
  assert.match(serverSource, /await closeHttpServerLifecycle\(\);[\s\S]{0,300}await recoveryShutdown;[\s\S]{0,300}await previewShutdown;/);
  assert.match(serverSource, /process\.once\('SIGINT'/);
  assert.match(serverSource, /process\.once\('SIGTERM'/);
  assert.match(serverSource, /process\.once\('exit',\s*closeSemanticPipeline\)/);
  assert.match(semanticPipelineSource, /this\.worker\.close\(\)/);
  assert.match(previewPipelineSource, /shutdown\(options\s*=\s*\{\}\)/);
  assert.match(previewPipelineSource, /!this\.shuttingDown/);
});
