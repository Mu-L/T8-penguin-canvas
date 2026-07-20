import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssetRef } from '../src/types/project.ts';
import {
  assetSemanticAvailability,
  assetSemanticEmptyState,
  assetSemanticSearchIdentityMatches,
  buildAssetD4FilterKey,
  canUseAssetQuerySelection,
  normalizeAssetSemanticEvidence,
  normalizeAssetSemanticQuery,
  normalizeAssetSemanticSavedSearch,
  readAssetSemanticPageHit,
  shouldInvalidateAssetD4Search,
  updateAssetSemanticPageLru,
  type AssetSemanticProjectStatus,
  type AssetSemanticSearchIdentity,
  type AssetSemanticSearchPage,
} from '../src/components/assets/assetD4State.ts';

const embeddingModel = {
  key: 'embedding-model',
  capability: 'embedding' as const,
  label: 'Embedding',
  repoId: 'public-id',
  version: 'fixed-v1',
  revision: 1,
  installState: 'installed' as const,
  installed: true,
  downloadedBytes: 100,
  totalBytes: 100,
};

function status(overrides: Partial<AssetSemanticProjectStatus> = {}): AssetSemanticProjectStatus {
  const capability = (name: 'caption' | 'ocr' | 'embedding') => ({
    capability: name,
    enabled: name === 'embedding',
    modelKey: `${name}-model`,
    modelVersion: 'fixed-v1',
    model: name === 'embedding' ? embeddingModel : null,
    eligible: 2,
    queued: 0,
    running: 0,
    succeeded: 2,
    skipped: 0,
    failed: 0,
  });
  return {
    projectId: 'project-a',
    revision: 2,
    activeGeneration: 3,
    activeIndexRevision: 'index-3',
    activeCatalogRevision: 9,
    currentCatalogRevision: 9,
    buildingGeneration: null,
    indexState: 'ready',
    indexStale: false,
    capabilities: {
      caption: capability('caption'),
      ocr: capability('ocr'),
      embedding: capability('embedding'),
    },
    ...overrides,
  };
}

function identity(overrides: Partial<AssetSemanticSearchIdentity> = {}): AssetSemanticSearchIdentity {
  return {
    projectId: 'project-a',
    queryDigest: 'query-a',
    catalogRevision: 9,
    semanticIndexRevision: 'index-3',
    activeGeneration: 3,
    modelKey: 'embedding-model',
    modelVersion: 'fixed-v1',
    ...overrides,
  };
}

function asset(id: string): AssetRef {
  return {
    id,
    entityUid: `entity-${id}`,
    projectId: 'project-a',
    kind: 'image',
    filename: `${id}.png`,
    storageMode: 'managed',
    availability: 'available',
    createdAt: 1,
  };
}

function page(offset: number, id: string, pageIdentity = identity()): AssetSemanticSearchPage {
  return {
    offset,
    limit: 120,
    total: 1_000,
    identity: pageIdentity,
    hits: [{ asset: asset(id), rank: offset + 1, score: 0.75, metric: 'cosine', evidence: [] }],
  };
}

test('semantic availability keeps model, project enablement, and index lifecycle orthogonal', () => {
  assert.deepEqual(assetSemanticAvailability(status()), {
    searchable: true,
    reason: 'ready',
    message: '语义索引可用。',
  });

  const disabled = status();
  disabled.capabilities.embedding.enabled = false;
  assert.equal(assetSemanticAvailability(disabled).reason, 'project-disabled');

  const missing = status();
  missing.capabilities.embedding.model = { ...embeddingModel, installed: false, installState: 'not-installed' };
  assert.equal(assetSemanticAvailability(missing).reason, 'model-missing');

  const downloading = status();
  downloading.capabilities.embedding.model = { ...embeddingModel, installed: false, installState: 'downloading' };
  assert.equal(assetSemanticAvailability(downloading).reason, 'model-downloading');

  const firstBuild = status({ activeGeneration: 0, activeIndexRevision: '', buildingGeneration: 1, indexState: 'building' });
  assert.deepEqual(assetSemanticAvailability(firstBuild), {
    searchable: false,
    reason: 'index-building',
    message: '语义索引正在首次构建。',
  });

  const doubleBuffer = status({ buildingGeneration: 4, indexState: 'building' });
  assert.equal(assetSemanticAvailability(doubleBuffer).searchable, true);
  assert.match(assetSemanticAvailability(doubleBuffer).message, /上一个成功代次/);

  const stale = status({ currentCatalogRevision: 10, indexStale: true, indexState: 'stale' });
  assert.deepEqual(assetSemanticAvailability(stale), {
    searchable: true,
    reason: 'index-stale',
    message: '素材目录已变化；查询使用上一个索引，建议重建。',
  });
});

test('search identity rejects project, query, catalog, model and generation drift including A-B-A races', () => {
  const current = identity();
  assert.equal(assetSemanticSearchIdentityMatches(current, identity()), true);
  for (const changed of [
    identity({ projectId: 'project-b' }),
    identity({ queryDigest: 'query-b' }),
    identity({ catalogRevision: 10 }),
    identity({ semanticIndexRevision: 'index-4' }),
    identity({ activeGeneration: 4 }),
    identity({ modelKey: 'other-model' }),
    identity({ modelVersion: 'fixed-v2' }),
  ]) assert.equal(assetSemanticSearchIdentityMatches(current, changed), false);

  const firstAKey = buildAssetD4FilterKey({ mode: 'semantic', projectId: 'project-a', semanticQuery: '夜晚 城市', semanticIdentity: current });
  const bKey = buildAssetD4FilterKey({ mode: 'semantic', projectId: 'project-a', semanticQuery: '白天 海边', semanticIdentity: current });
  const secondAKey = buildAssetD4FilterKey({ mode: 'semantic', projectId: 'project-a', semanticQuery: '夜晚 城市', semanticIdentity: current });
  assert.equal(firstAKey, secondAKey, 'same logical identity is stable, while request generation remains the race guard');
  assert.equal(shouldInvalidateAssetD4Search(firstAKey, bKey), true);
  assert.equal(shouldInvalidateAssetD4Search(bKey, secondAKey), true);
});

test('filter key changes only on stable search identity, not mutable progress counts', () => {
  const base = buildAssetD4FilterKey({
    mode: 'semantic',
    projectId: 'project-a',
    semanticQuery: '  夜晚\n城市  ',
    filters: { kind: 'image', tag: '精选', ignored: undefined },
    semanticIdentity: identity(),
  });
  const same = buildAssetD4FilterKey({
    mode: 'semantic',
    projectId: 'project-a',
    semanticQuery: '夜晚 城市',
    filters: { tag: '精选', kind: 'image' },
    semanticIdentity: identity(),
  });
  assert.equal(base, same);
  assert.equal(shouldInvalidateAssetD4Search(base, buildAssetD4FilterKey({
    mode: 'semantic', projectId: 'project-a', semanticQuery: '夜晚 城市', filters: { kind: 'image', tag: '精选' }, semanticIdentity: identity({ semanticIndexRevision: 'index-4' }),
  })), true);
  assert.equal(shouldInvalidateAssetD4Search(base, buildAssetD4FilterKey({
    mode: 'keyword', projectId: 'project-a', keywordQuery: '夜晚 城市', filters: { kind: 'image', tag: '精选' },
  })), true);
});

test('semantic page and evidence cache is bounded by the same eight-page LRU', () => {
  let pages = new Map<number, AssetSemanticSearchPage>();
  for (let index = 0; index < 10; index += 1) {
    const offset = index * 120;
    pages = updateAssetSemanticPageLru(pages, offset, page(offset, `asset-${index}`), 8);
  }
  assert.equal(pages.size, 8);
  assert.equal(pages.has(0), false);
  assert.equal(pages.has(120), false);
  assert.equal(readAssetSemanticPageHit(pages, 240, 120)?.asset.id, 'asset-2');

  pages = updateAssetSemanticPageLru(pages, 240, page(240, 'asset-2-refreshed'), 8);
  pages = updateAssetSemanticPageLru(pages, 1_200, page(1_200, 'asset-10'), 8);
  assert.equal(pages.has(360), false, 'refreshing an existing page moves it to newest position');
  assert.equal(readAssetSemanticPageHit(pages, 240, 120)?.asset.id, 'asset-2-refreshed');
});

test('semantic evidence is bounded and score is never represented as confidence percent', () => {
  const normalized = normalizeAssetSemanticEvidence([
    { source: 'caption', snippet: `  城市\n夜景 ${'x'.repeat(500)}`, modelKey: 'caption', modelVersion: 'v1' },
    { source: 'caption', snippet: `城市 夜景 ${'x'.repeat(500)}` },
    { source: 'ocr', snippet: 'WELCOME', bbox: [1, 2, 3, 4] },
    { source: 'filename', snippet: 'night.png' },
    { source: 'tag', snippet: '不会进入第四条' },
  ]);
  assert.equal(normalized.length, 3);
  assert.ok(normalized.every((entry) => entry.snippet.length <= 320));
  assert.deepEqual(normalized[1].bbox, [1, 2, 3, 4]);
  assert.equal(Object.hasOwn(normalized[0], 'confidence'), false);
});

test('semantic mode forbids unsafe query-wide batch selection and saved views exclude transient results', () => {
  assert.equal(canUseAssetQuerySelection('keyword'), true);
  assert.equal(canUseAssetQuerySelection('semantic'), false);
  assert.deepEqual(normalizeAssetSemanticSavedSearch({ mode: 'semantic', semanticQuery: '  夜景  ' }), {
    mode: 'semantic', semanticQuery: '夜景',
  });
  assert.deepEqual(normalizeAssetSemanticSavedSearch({ mode: 'keyword', semanticQuery: 'must-not-persist' }), { mode: 'keyword' });
});

test('empty states distinguish unavailable, stale, no results, query and network failures', () => {
  const ready = assetSemanticAvailability(status());
  const stale = assetSemanticAvailability(status({ indexState: 'stale', indexStale: true, currentCatalogRevision: 10 }));
  assert.equal(assetSemanticEmptyState({ availability: ready, query: '', loading: false, total: 0 }), 'query-empty');
  assert.equal(assetSemanticEmptyState({ availability: ready, query: 'city', loading: false, total: 0 }), 'no-results');
  assert.equal(assetSemanticEmptyState({ availability: ready, query: 'city', loading: false, total: 0, error: 'offline' }), 'network-error');
  assert.equal(assetSemanticEmptyState({ availability: stale, query: 'city', loading: false, total: 2 }), 'index-stale');
  const unavailable = assetSemanticAvailability(status({ activeGeneration: 0, activeIndexRevision: '', indexState: 'empty' }));
  assert.equal(assetSemanticEmptyState({ availability: unavailable, query: 'city', loading: false, total: 0 }), 'index-empty');
});

test('query normalization is NFKC, bounded and strips unsafe controls without guessing intent', () => {
  assert.equal(normalizeAssetSemanticQuery(' Ａ\u0000\n  B '), 'A B');
  assert.equal(normalizeAssetSemanticQuery('x'.repeat(3_000)).length, 2_000);
});
