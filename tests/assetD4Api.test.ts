import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type {
  AssetRef,
  AssetSemanticGenerationSummary,
  AssetSemanticModelStatus,
  AssetSemanticSearchPage,
  AssetSemanticStatus,
} from '../src/types/project.ts';
import {
  deleteProjectAssetSemanticModel,
  downloadProjectAssetSemanticModel,
  getProjectAssetSemanticDocuments,
  getProjectAssetSemanticStatus,
  rebuildProjectAssetSemanticIndex,
  retryProjectAssetSemanticJob,
  searchProjectAssetsSemantic,
  updateProjectAssetSemanticProfile,
} from '../src/services/api.ts';

const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function asset(id = 'asset-a'): AssetRef {
  return {
    id,
    entityUid: `entity-${id}`,
    projectId: 'project/a',
    kind: 'image',
    filename: `${id}.png`,
    storageMode: 'managed',
    availability: 'available',
    createdAt: 1,
  };
}

function model(overrides: Partial<AssetSemanticModelStatus> = {}): AssetSemanticModelStatus {
  return {
    key: 'embedding-multilingual-minilm-l12-v2',
    capability: 'embedding',
    label: 'Multilingual MiniLM L12 v2',
    version: 'fixed-v1',
    revision: 4,
    installState: 'installed',
    installed: true,
    downloadedBytes: 12,
    totalBytes: 12,
    error: null,
    ...overrides,
  };
}

function generation(overrides: Partial<AssetSemanticGenerationSummary> = {}): AssetSemanticGenerationSummary {
  return {
    projectId: 'project/a',
    generation: 3,
    revision: 2,
    profileRevision: 7,
    catalogRevision: 11,
    status: 'building',
    counts: {
      queued: 2,
      running: 1,
      retrying: 0,
      succeeded: 3,
      skipped: 0,
      failed: 0,
      superseded: 0,
      total: 6,
    },
    error: null,
    createdBy: 'local-owner',
    createdAt: 10,
    updatedAt: 11,
    finishedAt: null,
    ...overrides,
  };
}

function statusData(): AssetSemanticStatus {
  const embeddingModel = model();
  const capability = (name: 'caption' | 'ocr' | 'embedding') => ({
    capability: name,
    enabled: name === 'embedding',
    modelKey: name === 'embedding' ? embeddingModel.key : `${name}-model`,
    modelVersion: 'fixed-v1',
    model: name === 'embedding' ? embeddingModel : null,
    eligible: 3,
    queued: 0,
    running: 0,
    succeeded: 3,
    skipped: 0,
    failed: 0,
  });
  return {
    project: {
      projectId: 'project/a',
      revision: 7,
      enabled: true,
      activeGeneration: 2,
      activeIndexRevision: 'semantic-index-2',
      activeCatalogRevision: 11,
      currentCatalogRevision: 11,
      buildingGeneration: 3,
      indexState: 'building',
      indexStale: false,
      capabilities: {
        caption: capability('caption'),
        ocr: capability('ocr'),
        embedding: capability('embedding'),
      },
      updatedAt: 12,
    },
    models: [embeddingModel],
    rebuild: generation(),
  };
}

test('semantic status uses the fixed URL, forwards AbortSignal, and whitelists public model fields', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const canonical = statusData();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return json({ success: true, data: {
      ...canonical,
      models: [{
        ...canonical.models[0],
        repository: 'private/repository',
        installPath: 'C:\\private\\models',
        downloadUrl: 'https://private.invalid/model',
        apiKey: 'must-not-cross-wire',
        embeddingVector: [0.1, 0.2],
      }],
      worker: { active: 1, internalQueue: ['secret'] },
    } });
  }) as typeof fetch;
  try {
    const result = await getProjectAssetSemanticStatus('project/a', { signal: controller.signal });
    assert.equal(calls[0].url, '/api/project-assets/semantic/status?projectId=project%2Fa');
    assert.equal(calls[0].init?.signal, controller.signal);
    assert.deepEqual(result.models, [canonical.models[0]]);
    assert.equal(result.project.capabilities.embedding.model?.key, canonical.models[0].key);
    const serialized = JSON.stringify(result);
    for (const forbidden of ['private/repository', 'C:\\private\\models', 'private.invalid', 'must-not-cross-wire', 'embeddingVector', 'internalQueue']) {
      assert.equal(serialized.includes(forbidden), false, `must strip ${forbidden}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('semantic management mutations preserve CAS/idempotency bodies and canonical identities', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const semanticStatus = statusData();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/semantic/profile')) return json({ success: true, data: semanticStatus });
    if (url.endsWith('/download')) return json({ success: true, data: model({ installState: 'downloading', installed: false, downloadedBytes: 0 }) });
    if (init?.method === 'DELETE') return json({ success: true, data: model({ installState: 'not-installed', installed: false, downloadedBytes: 0 }) });
    if (url.endsWith('/semantic/rebuild')) return json({ success: true, data: generation() });
    if (url.endsWith('/retry')) return json({ success: true, data: [{
      id: 'job/a',
      projectId: 'project/a',
      assetId: 'asset-a',
      generation: 3,
      jobKind: 'embedding',
      modelKey: model().key,
      modelVersion: 'fixed-v1',
      status: 'queued',
      revision: 9,
      attemptCount: 1,
      maxAttempts: 3,
      nextAttemptAt: 20,
      error: null,
      createdAt: 10,
      updatedAt: 20,
      claimToken: 'private-claim',
      result: { embeddingVector: [0.3] },
    }] });
    return json({}, 404);
  }) as typeof fetch;
  try {
    const profile = await updateProjectAssetSemanticProfile({
      projectId: 'project/a',
      expectedRevision: 7,
      enabled: true,
      caption: { enabled: true, modelKey: 'caption-blip-base', modelVersion: 'fixed-v1' },
      ocr: { enabled: false },
      embedding: { enabled: true, modelKey: model().key, modelVersion: 'fixed-v1' },
      updatedBy: 'member/a',
    }, { signal: controller.signal });
    assert.equal(profile.project.revision, 7);

    const downloaded = await downloadProjectAssetSemanticModel('embedding/model:v1', {
      expectedRevision: 4,
      idempotencyKey: 'download/request-1',
    }, { signal: controller.signal });
    assert.equal(downloaded.capability, 'embedding');

    const removed = await deleteProjectAssetSemanticModel('embedding/model:v1', {
      expectedRevision: 5,
    }, { signal: controller.signal });
    assert.equal(removed.installState, 'not-installed');

    const rebuilt = await rebuildProjectAssetSemanticIndex({
      projectId: 'project/a', expectedRevision: 7, idempotencyKey: 'rebuild/request-1',
    }, { signal: controller.signal });
    assert.equal(rebuilt.catalogRevision, 11);

    const retried = await retryProjectAssetSemanticJob('job/a', {
      projectId: 'project/a', expectedRevision: 9,
    }, { signal: controller.signal });
    assert.equal(retried.length, 1);
    assert.equal(JSON.stringify(retried).includes('private-claim'), false);
    assert.equal(JSON.stringify(retried).includes('embeddingVector'), false);

    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      projectId: 'project/a',
      expectedRevision: 7,
      enabled: true,
      caption: { enabled: true, modelKey: 'caption-blip-base', modelVersion: 'fixed-v1' },
      ocr: { enabled: false },
      embedding: { enabled: true, modelKey: model().key, modelVersion: 'fixed-v1' },
      updatedBy: 'member/a',
    });
    assert.equal(calls[0].init?.method, 'PUT');
    assert.equal(calls[1].url, '/api/project-assets/semantic/models/embedding%2Fmodel%3Av1/download');
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { expectedRevision: 4, idempotencyKey: 'download/request-1' });
    assert.equal(calls[2].url, '/api/project-assets/semantic/models/embedding%2Fmodel%3Av1');
    assert.equal(calls[2].init?.method, 'DELETE');
    assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { expectedRevision: 5 });
    assert.deepEqual(JSON.parse(String(calls[3].init?.body)), {
      projectId: 'project/a', expectedRevision: 7, idempotencyKey: 'rebuild/request-1',
    });
    assert.equal(calls[4].url, '/api/project-assets/semantic/jobs/job%2Fa/retry');
    assert.deepEqual(JSON.parse(String(calls[4].init?.body)), { projectId: 'project/a', expectedRevision: 9 });
    assert.ok(calls.every((call) => call.init?.signal === controller.signal));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('semantic search clamps paging, sends revision identity, and maps canonical meta to a page', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) return json({
      success: true,
      data: [{
        asset: asset(),
        rank: 1,
        score: 0.81,
        metric: 'rrf',
        evidence: [{ source: 'caption', snippet: '雨夜城市', language: 'zh', modelKey: 'caption-blip-base', modelVersion: 'fixed-v1', embeddingVector: [1] }],
        embeddingVector: [0.1, 0.2],
      }],
      meta: {
        total: 31,
        offset: 0,
        limit: 120,
        projectId: 'project/a',
        queryDigest: 'query-digest-a',
        catalogRevision: 11,
        semanticIndexRevision: 'semantic-index-2',
        activeGeneration: 2,
        modelKey: model().key,
        modelVersion: 'fixed-v1',
        stale: true,
      },
    });
    return json({
      success: true,
      data: {
        items: [{
          asset: asset('asset-b'),
          score: 0.63,
          vectorScore: 0.63,
          matches: [{ kind: 'ocr', text: 'WELCOME', language: 'en' }],
        }],
        total: 1,
        offset: 120,
        limit: 120,
        projectId: 'project/a',
        queryDigest: 'query-digest-b',
        catalogRevision: 11,
        semanticIndexRevision: 'semantic-index-2',
        activeGeneration: 2,
        modelKey: model().key,
        modelVersion: 'fixed-v1',
      },
    });
  }) as typeof fetch;
  try {
    const page = await searchProjectAssetsSemantic({
      projectId: 'project/a',
      query: '雨夜 城市',
      filters: { kind: 'image', tag: '精选' },
      limit: 999,
      offset: -20,
      expectedCatalogRevision: 11,
      expectedProfileRevision: 7,
      expectedGeneration: 2,
    }, { signal: controller.signal });
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      projectId: 'project/a',
      query: '雨夜 城市',
      filters: { kind: 'image', tag: '精选' },
      limit: 120,
      offset: 0,
      expectedCatalogRevision: 11,
      expectedProfileRevision: 7,
      expectedGeneration: 2,
    });
    assert.equal(calls[0].url, '/api/project-assets/semantic/search');
    assert.equal(calls[0].init?.method, 'POST');
    assert.equal(calls[0].init?.signal, controller.signal);
    assert.deepEqual(page.identity, {
      projectId: 'project/a',
      queryDigest: 'query-digest-a',
      catalogRevision: 11,
      semanticIndexRevision: 'semantic-index-2',
      activeGeneration: 2,
      modelKey: model().key,
      modelVersion: 'fixed-v1',
    });
    assert.equal(page.total, 31);
    assert.equal(page.stale, true);
    assert.equal(page.hits[0].metric, 'rrf');
    assert.equal(page.hits[0].evidence[0].snippet, '雨夜城市');
    assert.equal(JSON.stringify(page).includes('embeddingVector'), false);

    const compatible = await searchProjectAssetsSemantic({ projectId: 'project/a', query: 'welcome', offset: 120 });
    assert.equal(compatible.hits[0].rank, 121);
    assert.equal(compatible.hits[0].metric, 'cosine');
    assert.equal(compatible.hits[0].evidence[0].source, 'ocr');
    assert.equal(compatible.hits[0].evidence[0].snippet, 'WELCOME');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('semantic asset documents use project scoping and expose only bounded public document fields', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let call: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    call = { url: String(input), init };
    return json({ success: true, data: [{
      id: 41,
      assetId: 'asset/a',
      source: 'ocr',
      text: 'WELCOME',
      language: 'en',
      modelKey: 'ocr-trocr-small-printed',
      modelVersion: 'fixed-v1',
      metadata: { page: 1 },
      indexedAt: 20,
      installPath: 'C:\\private\\ocr',
      embeddingVector: [0.4],
    }] });
  }) as typeof fetch;
  try {
    const documents = await getProjectAssetSemanticDocuments('asset/a', 'project/a', { signal: controller.signal });
    assert.equal(call && call.url, '/api/project-assets/semantic/assets/asset%2Fa?projectId=project%2Fa');
    assert.equal(call && call.init?.signal, controller.signal);
    assert.deepEqual(documents, [{
      id: 41,
      assetId: 'asset/a',
      source: 'ocr',
      modelKey: 'ocr-trocr-small-printed',
      modelVersion: 'fixed-v1',
      text: 'WELCOME',
      language: 'en',
      metadata: { page: 1 },
      indexedAt: 20,
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('D4 wire types are canonical, deduplicated, and contain no model supply-chain secrets or vectors', () => {
  const projectTypes = read('src/types/project.ts');
  const d4State = read('src/components/assets/assetD4State.ts');
  const api = read('src/services/api.ts');
  const d4Start = projectTypes.indexOf("export type AssetSearchMode = 'keyword' | 'semantic';");
  const d4End = projectTypes.indexOf('export interface CollaborationStatus', d4Start);
  assert.ok(d4Start >= 0 && d4End > d4Start);
  const d4Types = projectTypes.slice(d4Start, d4End);
  for (const name of [
    'AssetSemanticModelStatus',
    'AssetSemanticProfile',
    'AssetSemanticCapabilityCounts',
    'AssetSemanticGenerationSummary',
    'AssetSemanticStatus',
    'AssetSemanticDocument',
    'AssetSemanticEvidence',
    'AssetSemanticSearchHit',
    'AssetSemanticSearchIdentity',
    'AssetSemanticSearchPage',
  ]) assert.match(d4Types, new RegExp(`export (?:interface|type) ${name}\\b`));
  for (const forbidden of ['repoId', 'repository', 'installPath', 'modelPath', 'downloadUrl', 'apiKey', 'embeddingVector', 'queryEmbedding']) {
    assert.doesNotMatch(d4Types, new RegExp(`\\b${forbidden}\\b`, 'i'));
  }
  assert.doesNotMatch(d4Types, /embedding\s*:\s*(?:number|unknown)\[\]/i);
  assert.doesNotMatch(d4State, /export interface AssetSemantic(?:ModelStatus|ProjectStatus|Evidence|SearchHit|SearchPage)\b/);
  assert.match(d4State, /export type \{[\s\S]*AssetSemanticModelStatus[\s\S]*\} from '\.\.\/\.\.\/types\/project';/);
  for (const endpoint of [
    '/project-assets/semantic/status?projectId=',
    '/project-assets/semantic/profile',
    '/project-assets/semantic/models/',
    '/project-assets/semantic/rebuild',
    '/project-assets/semantic/search',
    '/project-assets/semantic/assets/',
    '/project-assets/semantic/jobs/',
  ]) assert.equal(api.includes(endpoint), true, `missing API endpoint ${endpoint}`);

  const typeOnlyPage: AssetSemanticSearchPage = {
    hits: [], total: 0, offset: 0, limit: 120, stale: false,
    identity: {
      projectId: 'project/a', queryDigest: 'digest', catalogRevision: 1,
      semanticIndexRevision: 'index-1', activeGeneration: 1, modelKey: model().key, modelVersion: 'fixed-v1',
    },
  };
  assert.equal(typeOnlyPage.identity.activeGeneration, 1);
});
