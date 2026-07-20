import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AssetRef, AssetSourceTree } from '../src/types/project.ts';
import {
  addAssetToCollection,
  applyProjectAssetBatch,
  decideProjectAssetDuplicate,
  deleteProjectAssetFile,
  getProjectAssetPermissions,
  getProjectAssetSourceTree,
  listProjectAssetLineage,
  listProjectAssetDuplicateGroupMembers,
  listProjectAssetDuplicateGroups,
  listProjectAssetDuplicates,
  refreshProjectAssetDuplicates,
  removeAssetFromCollection,
  setProjectAssetPermissions,
  setProjectAssetTags,
} from '../src/services/api.ts';
import {
  ASSET_SAVED_VIEW_LIMIT,
  ASSET_SOURCE_EDGE_LIMIT,
  ASSET_SOURCE_NODE_LIMIT,
  EMPTY_ASSET_SELECTION,
  assetBatchSelectionCount,
  assetSelectionCatalogIsCurrent,
  assetSelectionMatchesFilter,
  buildAssetBatchTarget,
  deleteAssetSavedFilterView,
  explicitAssetSelection,
  formatAssetTimecode,
  isAssetBatchSelected,
  loadAssetSavedFilterViews,
  mergeAssetDuplicateCandidates,
  normalizeAssetSourceTree,
  queryAssetSelection,
  saveAssetSavedFilterView,
  selectAssetBatchRange,
  toggleAssetBatchSelection,
} from '../src/components/assets/assetD3State.ts';

const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

function sourceBlockAfter(source: string, marker: string, from = 0): string {
  const markerIndex = source.indexOf(marker, from);
  assert.ok(markerIndex >= 0, `missing source marker: ${marker}`);
  const openIndex = source.indexOf('{', markerIndex + marker.length - 1);
  assert.ok(openIndex >= 0, `missing opening brace after: ${marker}`);
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  assert.fail(`missing closing brace after: ${marker}`);
}

function asset(id: string, revision: number): AssetRef {
  return {
    id,
    entityUid: `entity-${id}`,
    projectId: 'project-local',
    kind: 'image',
    filename: `${id}.png`,
    storageMode: 'managed',
    availability: 'available',
    organizationRevision: revision,
    createdAt: revision,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  };
}

test('explicit and query batch selections remain assetId/revision based across virtual page eviction', () => {
  const a = asset('a', 11);
  const b = asset('b', 12);
  const c = asset('c', 13);
  let selection = explicitAssetSelection([a, b]);
  assert.equal(assetBatchSelectionCount(selection), 2);
  assert.equal(isAssetBatchSelected(selection, 'a'), true);
  assert.deepEqual(buildAssetBatchTarget(selection), {
    mode: 'ids',
    assetIds: ['a', 'b'],
    expectedRevisions: { a: 11, b: 12 },
  });

  selection = toggleAssetBatchSelection(selection, a);
  selection = selectAssetBatchRange(selection, [b, c], true);
  assert.deepEqual(buildAssetBatchTarget(selection), {
    mode: 'ids',
    assetIds: ['b', 'c'],
    expectedRevisions: { b: 12, c: 13 },
  });

  let querySelection = queryAssetSelection({
    query: { kind: 'image', tag: 'hero', sort: 'name-asc' },
    filterKey: 'filter-v1',
    catalogRevision: 91,
    total: 10_000,
  });
  querySelection = toggleAssetBatchSelection(querySelection, b);
  assert.equal(assetBatchSelectionCount(querySelection), 9_999);
  assert.equal(isAssetBatchSelected(querySelection, 'b'), false);
  assert.equal(isAssetBatchSelected(querySelection, 'offscreen-id'), true);
  assert.equal(assetSelectionMatchesFilter(querySelection, 'filter-v1'), true);
  assert.equal(assetSelectionMatchesFilter(querySelection, 'filter-v2'), false);
  assert.equal(assetSelectionCatalogIsCurrent(querySelection, 91), true);
  assert.equal(assetSelectionCatalogIsCurrent(querySelection, 92), false);
  assert.deepEqual(buildAssetBatchTarget(querySelection), {
    mode: 'query',
    query: { kind: 'image', tag: 'hero', sort: 'name-asc' },
    catalogRevision: 91,
    exclusions: ['b'],
  });
  assert.equal(assetBatchSelectionCount(EMPTY_ASSET_SELECTION), 0);
});

test('saved filter views are project scoped, bounded, fail-safe, and never persist selection', () => {
  const storage = memoryStorage();
  let views = saveAssetSavedFilterView(storage, 'project-a', {
    id: 'view-a',
    name: ' Hero images ',
    filters: {
      query: 'hero', kind: 'image', source: 'node-output', storageMode: 'managed', availability: 'available',
      tag: 'approved', collectionId: 'collection-a', sort: 'updated-desc',
    },
  }, 100);
  assert.equal(views.length, 1);
  assert.equal(views[0].name, 'Hero images');
  assert.deepEqual(views[0].filters, {
    query: 'hero', kind: 'image', source: 'node-output', storageMode: 'managed', availability: 'available',
    tag: 'approved', collectionId: 'collection-a', sort: 'updated-desc',
  });
  assert.equal(JSON.stringify(views).includes('selection'), false);
  assert.deepEqual(loadAssetSavedFilterViews(storage, 'project-b'), []);

  for (let index = 0; index < ASSET_SAVED_VIEW_LIMIT + 5; index += 1) {
    views = saveAssetSavedFilterView(storage, 'project-a', {
      id: `view-${index}`,
      name: `view ${index}`,
      filters: { sort: 'size-desc' },
    }, 200 + index);
  }
  assert.equal(views.length, ASSET_SAVED_VIEW_LIMIT);
  views = deleteAssetSavedFilterView(storage, 'project-a', views[0].id);
  assert.equal(views.length, ASSET_SAVED_VIEW_LIMIT - 1);
  storage.setItem('t8.asset.saved-filter-views.v1:project-a', '{broken');
  assert.deepEqual(loadAssetSavedFilterViews(storage, 'project-a'), []);
});

test('source graph normalization is bounded, de-duplicates nodes/edges, and detects cycles', () => {
  const nodes = Array.from({ length: 130 }, (_, index) => ({
    assetId: index === 0 ? 'root' : `node-${index}`,
    direction: index === 0 ? 'root' as const : 'descendant' as const,
    depth: index,
  }));
  const edges = Array.from({ length: 119 }, (_, index) => ({
    id: `edge-${index}`,
    fromAssetId: index === 0 ? 'root' : `node-${index}`,
    toAssetId: `node-${index + 1}`,
    relation: 'derived',
  }));
  edges.push({ id: 'cycle', fromAssetId: 'node-119', toAssetId: 'root', relation: 'derived' });
  for (let index = 0; index < 300; index += 1) edges.push({ id: `extra-${index}`, fromAssetId: 'root', toAssetId: 'node-1', relation: `extra-${index}` });
  const normalized = normalizeAssetSourceTree({
    rootAssetId: 'root', nodes, edges, cursor: 'next-source-page', hasMore: true, truncated: true, cycleDetected: false,
  } satisfies AssetSourceTree);
  assert.equal(normalized.nodes.length, ASSET_SOURCE_NODE_LIMIT);
  assert.equal(normalized.edges.length <= ASSET_SOURCE_EDGE_LIMIT, true);
  assert.equal(normalized.truncated, true);
  assert.equal(normalized.cycleDetected, true);
  assert.equal(normalized.nodes[0].assetId, 'root');
  assert.equal(normalized.cursor, 'next-source-page');
  assert.equal(normalized.hasMore, true);
});

test('duplicate candidates merge by stable candidate id and video evidence timecodes are deterministic', () => {
  const base = {
    id: 'candidate-a', asset: asset('b', 1), kind: 'near' as const, algorithm: 'phash-dct64-v1',
    distance: 4, frameMatches: [], decision: 'pending' as const,
  };
  const merged = mergeAssetDuplicateCandidates([base], [{ ...base, distance: 3, decision: 'confirmed' }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].distance, 3);
  assert.equal(merged[0].decision, 'confirmed');
  assert.equal(formatAssetTimecode(65.432), '01:05.432');
  assert.equal(formatAssetTimecode(-1), '—');
});

test('API adapter sends atomic ACL replacement and normalizes near-frame/source-tree wire evidence', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/api/project-assets/batch')) {
      return new Response(JSON.stringify({ success: true, data: {
        affectedCount: 2,
        assetIds: ['a', 'b'],
        organizationRevisions: { a: 12, b: 13 },
        catalogRevision: 92,
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/api/project-assets/a/tags')) {
      return new Response(JSON.stringify({ success: true, data: { ...asset('a', 12), tags: ['approved'] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/api/project-assets/collections/collection-a/members/a')) {
      return new Response(JSON.stringify({ success: true, data: { ...asset('a', 13), collectionIds: ['collection-a'] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/api/project-assets/a/permissions')) {
      if (init?.method === 'PUT') return new Response(JSON.stringify({ success: true, data: {
        projectId: 'project-local', assetId: 'a', scope: 'restricted', revision: 3,
        grants: [{ principalType: 'member', principalId: 'member-a', permissions: ['view', 'preview'] }], updatedAt: 3,
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ success: true, data: {
        projectId: 'project-local', assetId: 'a', scope: 'project', revision: 2, grants: [], updatedAt: 2,
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/api/project-assets/a/duplicates/refresh')) {
      return new Response(JSON.stringify({ success: true, data: {
        refreshed: true, assetId: 'a', projectId: 'project-local', catalogRevision: 91, candidateCount: 1,
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/duplicates?')) {
      return new Response(JSON.stringify({ success: true, data: [{
        id: 'near-a-b', type: 'near', asset: asset('b', 13), algorithm: 'phash-dct64-v1', distance: 4,
        evidence: {
          sourceFrameIndex: 2, targetFrameIndex: 3, sourceTimestampMs: 1250, targetTimestampMs: 1500,
          sourceNormalizedTime: 0.25, targetNormalizedTime: 0.3, distance: 4,
        },
        decision: 'pending', decisionRevision: 7, confidence: 'high', evidenceCount: 1, coverage: 0.8,
      }], meta: { nextCursor: 'next', hasMore: true, catalogRevision: 91 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/duplicate-candidates/') && url.endsWith('/decision')) {
      return new Response(JSON.stringify({ success: true, data: {
        id: 'near-a-b', decision: 'confirmed', revision: 8, updatedAt: 1_700_000_000_000,
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/source-tree?')) {
      return new Response(JSON.stringify({ success: true, data: {
        rootAssetId: 'root',
        nodes: [
          { id: 'parent', asset: asset('parent', 1), depth: 1, direction: 'ancestors' },
          { id: 'root', asset: asset('root', 2), depth: 0 },
          { id: 'child', tombstone: { id: 'child', filename: 'deleted.png' }, depth: 1, direction: 'descendants' },
        ],
        edges: [
          { id: 'e1', sourceAssetId: 'parent', targetAssetId: 'root', sourceType: 'node-output' },
          { id: 'e2', sourceAssetId: 'root', targetAssetId: 'child', derivedOperation: 'resize' },
        ],
        truncated: false,
        cycleDetected: false,
        nextCursor: 'tree-next',
        totalNodes: 250,
        totalEdges: 249,
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const batch = await applyProjectAssetBatch({
      target: { mode: 'ids', assetIds: ['a', 'b'], expectedRevisions: { a: 11, b: 12 } },
      mutations: { access: {
        visibility: 'restricted',
        grants: [{ principalType: 'member', principalId: 'member-a', role: 'owner' }],
      } },
      idempotencyKey: 'batch-test',
    });
    assert.equal(batch.affected, 2);
    assert.deepEqual(batch.organizationRevisions, { a: 12, b: 13 });
    const batchCalls = calls.filter((call) => call.url.endsWith('/api/project-assets/batch'));
    assert.equal(batchCalls.length, 1, 'scope and grants must be committed as one atomic backend operation');
    const batchBody = JSON.parse(String(batchCalls[0].init?.body));
    assert.deepEqual(batchBody.selection, { assetIds: ['a', 'b'] });
    assert.deepEqual(batchBody.expectedRevisions, { a: 11, b: 12 });
    assert.deepEqual(batchBody.operation, {
      type: 'access.replace',
      scope: 'restricted',
      grants: [{
        principalType: 'member', principalId: 'member-a',
        permissions: ['view', 'preview', 'original', 'organize', 'manage_acl'],
      }],
    });

    await applyProjectAssetBatch({
      projectId: 'project-local',
      target: { mode: 'ids', assetIds: ['a', 'b'], expectedRevisions: { a: 12, b: 13 } },
      mutations: { collections: {
        mode: 'move', fromCollectionIds: ['collection-from'], toCollectionId: 'collection-to',
      } },
      idempotencyKey: 'batch-move-test',
    });
    const moveBody = JSON.parse(String(calls.filter((call) => call.url.endsWith('/api/project-assets/batch')).at(-1)?.init?.body));
    assert.equal(moveBody.projectId, 'project-local');
    assert.deepEqual(moveBody.operation, {
      type: 'collection.move', fromCollectionIds: ['collection-from'], toCollectionId: 'collection-to',
    });

    const refresh = await refreshProjectAssetDuplicates('a', { expectedCatalogRevision: 91 });
    assert.deepEqual(refresh, {
      refreshed: true,
      assetId: 'a',
      projectId: 'project-local',
      catalogRevision: 91,
      candidateCount: 1,
    });
    const refreshCall = calls.find((call) => call.url.endsWith('/duplicates/refresh'))!;
    assert.equal(refreshCall.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(refreshCall.init?.body)), { expectedCatalogRevision: 91 });

    const duplicates = await listProjectAssetDuplicates('a', { maxDistance: 64 });
    assert.equal(duplicates.hasMore, true);
    assert.equal(duplicates.catalogRevision, 91);
    assert.deepEqual(duplicates.items[0].frameMatches, [{
      sourceIndex: 2, targetIndex: 3, sourceTime: 1.25, targetTime: 1.5,
      distance: 4, algorithm: 'phash-dct64-v1',
    }]);
    assert.equal(duplicates.items[0].confidence, 'high');

    assert.match(calls.find((call) => call.url.includes('/duplicates?'))!.url, /maxDistance=8/);

    const decision = await decideProjectAssetDuplicate('near-a-b', 'confirmed', {
      expectedRevision: 7,
      expectedCatalogRevision: 91,
      projectId: 'project-local',
    });
    assert.equal(decision.decision, 'confirmed');
    assert.equal(decision.revision, 8, 'decision endpoint returns revision, not decisionRevision');
    assert.deepEqual(JSON.parse(String(calls.find((call) => call.url.includes('/duplicate-candidates/'))!.init?.body)), {
      decision: 'confirmed', expectedRevision: 7, expectedCatalogRevision: 91, projectId: 'project-local',
    });

    await setProjectAssetTags('a', ['approved'], 11);
    await addAssetToCollection('collection-a', 'a', 5);
    await removeAssetFromCollection('collection-a', 'a', 6);
    const tagsBody = JSON.parse(String(calls.find((call) => call.url.endsWith('/a/tags'))!.init?.body));
    assert.deepEqual(tagsBody, { tags: ['approved'], expectedRevision: 11 });
    const collectionCalls = calls.filter((call) => call.url.includes('/collections/collection-a/members/a'));
    assert.deepEqual(JSON.parse(String(collectionCalls[0].init?.body)), { expectedRevision: 5 });
    assert.deepEqual(JSON.parse(String(collectionCalls[1].init?.body)), { expectedRevision: 6 });

    const permissions = await getProjectAssetPermissions('a');
    assert.equal(permissions.revision, 2);
    const updatedPermissions = await setProjectAssetPermissions('a', {
      scope: 'restricted', expectedRevision: permissions.revision,
      grants: [{ principalType: 'member', principalId: 'member-a', permissions: ['view', 'preview'] }],
    });
    assert.equal(updatedPermissions.revision, 3);
    assert.equal(JSON.parse(String(calls.find((call) => call.url.endsWith('/a/permissions') && call.init?.method === 'PUT')!.init?.body)).expectedRevision, 2);

    const tree = await getProjectAssetSourceTree('root');
    assert.deepEqual(tree.nodes.map((node) => [node.assetId, node.direction, node.filename]), [
      ['parent', 'ancestor', 'parent.png'],
      ['root', 'root', 'root.png'],
      ['child', 'descendant', 'deleted.png'],
    ]);
    assert.deepEqual(tree.edges.map((edge) => [edge.fromAssetId, edge.toAssetId, edge.relation]), [
      ['parent', 'root', 'node-output'],
      ['root', 'child', 'resize'],
    ]);
    assert.equal(tree.cursor, 'tree-next');
    assert.equal(tree.hasMore, true);
    assert.equal(tree.totalNodes, 250);

    await assert.rejects(() => applyProjectAssetBatch({
      target: { mode: 'ids', assetIds: ['a'], expectedRevisions: { a: 11 } },
      mutations: { tags: { mode: 'add', values: ['x'] }, collections: { mode: 'add', values: ['collection-a'] } },
      idempotencyKey: 'must-be-atomic',
    }), /只能提交一种操作/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('duplicate candidate, exact-group, and group-member adapters keep cursor requests bounded', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/project-assets/a/duplicates?')) {
      return new Response(JSON.stringify({
        success: true,
        data: [{
          id: 'near-a-b',
          type: 'near',
          asset: asset('b', 2),
          algorithm: 'phash-dct64-v1',
          distance: 3,
          evidence: Array.from({ length: 20 }, (_, index) => ({
            sourceFrameIndex: index,
            targetFrameIndex: index,
            distance: 3,
          })),
        }],
        meta: { nextCursor: 'candidate-next', hasMore: true, catalogRevision: 91 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/project-assets/missing-catalog/duplicates?')) {
      return new Response(JSON.stringify({ success: true, data: [], meta: { hasMore: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/project-assets/duplicate-groups/group-a?')) {
      return new Response(JSON.stringify({
        success: true,
        data: [asset('member-a', 4)],
        meta: { nextCursor: 'member-next', hasMore: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/project-assets/duplicate-groups?')) {
      return new Response(JSON.stringify({
        success: true,
        data: [{
          id: 'group-a',
          contentHash: 'a'.repeat(64),
          memberCount: 30,
          members: Array.from({ length: 30 }, (_, index) => asset(`group-member-${index}`, index + 1)),
          membersTruncated: true,
        }],
        meta: { nextCursor: 'group-next', hasMore: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const candidates = await listProjectAssetDuplicates('a', {
      limit: 999,
      cursor: 'candidate-cursor',
    });
    assert.equal(candidates.limit, 100);
    assert.equal(candidates.cursor, 'candidate-next');
    assert.equal(candidates.hasMore, true);
    assert.equal(candidates.catalogRevision, 91);
    assert.equal(candidates.items[0].frameMatches.length, 12, 'per-candidate frame evidence stays bounded');
    await assert.rejects(
      () => listProjectAssetDuplicates('missing-catalog'),
      (error) => error instanceof Error
        && error.name === 'ApiRequestError'
        && 'status' in error
        && error.status === 409,
    );

    const groups = await listProjectAssetDuplicateGroups({
      projectId: 'project-stable',
      limit: 999,
      cursor: 'group-cursor',
    });
    assert.equal(groups.cursor, 'group-next');
    assert.equal(groups.hasMore, true);
    assert.equal(groups.items[0].members.length, 20, 'group previews never expand the full member set');

    const members = await listProjectAssetDuplicateGroupMembers('group-a', {
      projectId: 'project-stable',
      limit: 999,
      cursor: 'member-cursor',
    });
    assert.equal(members.cursor, 'member-next');
    assert.equal(members.hasMore, true);

    const candidateUrl = new URL(calls.find((url) => url.includes('/project-assets/a/duplicates?'))!, 'http://127.0.0.1');
    assert.equal(candidateUrl.searchParams.get('limit'), '100');
    assert.equal(candidateUrl.searchParams.get('cursor'), 'candidate-cursor');
    const groupUrl = new URL(calls.find((url) => url.includes('/project-assets/duplicate-groups?'))!, 'http://127.0.0.1');
    assert.equal(groupUrl.searchParams.get('projectId'), 'project-stable');
    assert.equal(groupUrl.searchParams.get('limit'), '100');
    assert.equal(groupUrl.searchParams.get('cursor'), 'group-cursor');
    const memberUrl = new URL(calls.find((url) => url.includes('/project-assets/duplicate-groups/group-a?'))!, 'http://127.0.0.1');
    assert.equal(memberUrl.searchParams.get('projectId'), 'project-stable');
    assert.equal(memberUrl.searchParams.get('limit'), '200');
    assert.equal(memberUrl.searchParams.get('cursor'), 'member-cursor');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('lineage API adapter preserves the bounded cursor-page metadata and abort signal', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const controller = new AbortController();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return new Response(JSON.stringify({
      success: true,
      data: [{
        id: 'lineage-event-1',
        childAssetId: 'lineage asset/1',
        parentAssetId: null,
        relation: 'node-output',
        sourceType: 'node-output',
        sourceNodeId: 'node-1',
        creatorId: 'member-1',
        metadata: { safeIndex: 1 },
        createdAt: 1_700_000_000_000,
      }],
      meta: {
        total: 125,
        limit: 100,
        nextCursor: 'lineage-next',
        hasMore: true,
        lineageRevision: '125:1700000000000:lineage-event-1',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const page = await listProjectAssetLineage('lineage asset/1', {
      limit: 100,
      cursor: 'lineage-current',
      signal: controller.signal,
    });
    assert.deepEqual(page, {
      items: [{
        id: 'lineage-event-1',
        childAssetId: 'lineage asset/1',
        parentAssetId: null,
        relation: 'node-output',
        sourceType: 'node-output',
        sourceNodeId: 'node-1',
        creatorId: 'member-1',
        metadata: { safeIndex: 1 },
        createdAt: 1_700_000_000_000,
      }],
      total: 125,
      limit: 100,
      cursor: 'lineage-next',
      hasMore: true,
      lineageRevision: '125:1700000000000:lineage-event-1',
    });
    assert.equal(calls.length, 1);
    const requestUrl = new URL(calls[0].url, 'http://127.0.0.1');
    assert.equal(requestUrl.pathname, '/api/project-assets/lineage%20asset%2F1/lineage');
    assert.equal(requestUrl.searchParams.get('limit'), '100');
    assert.equal(requestUrl.searchParams.get('cursor'), 'lineage-current');
    assert.equal(calls[0].init?.signal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('asset file delete adapter binds client-visible identity and fails closed outside the committed result ABI', async () => {
  const originalFetch = globalThis.fetch;
  const responses: unknown[] = [
    { success: true, data: { id: 'asset-normal', indexRemoved: true, fileDeleted: true, blobRetained: false } },
    { success: true, data: { id: 'asset-legacy', fileDeleted: true } },
    { success: true, data: {
      id: 'server-selected-another-asset',
      indexRemoved: true,
      fileDeleted: false,
      persistenceWarning: {
        code: 'asset_delete_cleanup_pending',
        committed: 'true',
        phase: 'C:\\private\\project.sqlite3',
        reconciliationPending: true,
        retryable: false,
        message: 'SQLITE_FULL INSERT secret-token',
      },
    } },
    { success: true, data: {
      id: 'asset-warning',
      indexRemoved: true,
      fileDeleted: true,
      blobRetained: false,
      persistenceWarning: {
        code: 'asset_delete_cleanup_pending',
        committed: true,
        phase: 'cas-record-finalize',
        reconciliationPending: true,
        retryable: false,
        message: 'C:\\private\\project.sqlite3 secret-token',
        privateSql: 'UPDATE asset_blobs SET deleted_at = ? SECRET',
      },
    } },
  ];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const expectedIdentity = {
    entityUid: '019f6d00-0000-7000-8000-000000000001',
    contentRevision: 7,
    contentHash: 'a'.repeat(64),
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    assert.deepEqual(await deleteProjectAssetFile('asset-normal', 'normal.png', expectedIdentity), {
      id: 'asset-normal',
      indexRemoved: true,
      fileDeleted: true,
      blobRetained: false,
    });
    await assert.rejects(
      () => deleteProjectAssetFile('asset-legacy', 'legacy.png', expectedIdentity),
      /素材删除响应无效/,
    );
    await assert.rejects(
      () => deleteProjectAssetFile('asset-forged', 'forged.png', expectedIdentity),
      (error: unknown) => error instanceof Error
        && /素材删除响应无效/.test(error.message)
        && !/private|sqlite|secret|server-selected/i.test(error.message),
    );
    const committed = await deleteProjectAssetFile('asset-warning', 'warning.png', expectedIdentity);
    assert.deepEqual(committed, {
      id: 'asset-warning',
      indexRemoved: true,
      fileDeleted: true,
      blobRetained: false,
      persistenceWarning: {
        code: 'asset_delete_cleanup_pending',
        committed: true,
        phase: 'cas-record-finalize',
        reconciliationPending: true,
        retryable: false,
      },
    });
    assert.doesNotMatch(JSON.stringify(committed), /private|sqlite|secret|message|privateSql/i);
    assert.equal(calls.length, 4);
    assert.ok(calls.every((call) => call.init?.method === 'DELETE'));
    assert.deepEqual(JSON.parse(String(calls[3].init?.body)), {
      deleteFile: true,
      confirmFilename: 'warning.png',
      expectedEntityUid: expectedIdentity.entityUid,
      expectedContentRevision: expectedIdentity.contentRevision,
      expectedContentHash: expectedIdentity.contentHash,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AssetCenter treats a cleanup warning as committed deletion and never asks for a duplicate delete', () => {
  const center = read('src/components/assets/AssetCenter.tsx').replace(/\r\n?/g, '\n');
  const start = center.indexOf("const confirmDeleteFile = () => runMutation('delete-file'");
  const end = center.indexOf('  const showDuplicatePage', start);
  assert.ok(start >= 0 && end > start);
  const deletion = center.slice(start, end);
  assert.match(deletion, /const \{ value: result, revision \} = await runSelectedMutationRequest/);
  assert.match(deletion, /result\.persistenceWarning\?\.phase === 'cas-record-finalize'/);
  assert.match(deletion, /索引已移除，原文件记录对账待完成/);
  assert.match(deletion, /else if \(result\.persistenceWarning\)[\s\S]*索引已移除，原文件清理待完成/);
  assert.match(deletion, /else if \(result\.blobRetained\)[\s\S]*索引已移除，共享原文件仍被其他素材使用/);
  assert.match(deletion, /expectedEntityUid|entityUid: targetDraft\.asset\.entityUid/);
  assert.match(deletion, /contentRevision: Number\(targetDraft\.asset\.contentRevision\)/);
  assert.match(deletion, /contentHash: String\(targetDraft\.asset\.contentHash \|\| ''\)/);
  assert.match(deletion, /else \{[\s\S]*已删除原文件并移除索引/,
    'a valid non-retained response without a warning keeps the success message');
  assert.match(deletion, /setDeleteDraft\(\(current\) => current\?\.asset\.id === targetId \? null : current\)/);
  assert.match(deletion, /setSelectedAssetId\(null\)[\s\S]*setSelectedAsset\(null\)[\s\S]*refreshVisibleCatalogPages\(\)/);
  assert.doesNotMatch(deletion, /重试|再次删除|删除失败|throw result\.persistenceWarning/);
});

test('loaded canvas projectId is the stable D3 scope from Canvas through every asset request', () => {
  const canvas = read('src/components/Canvas.tsx');
  const workbench = read('src/components/ProjectWorkbench.tsx');
  const center = read('src/components/assets/AssetCenter.tsx');

  assert.match(canvas, /const \[activeProjectId, setActiveProjectId\] = useState<string \| null>\(null\);/);
  assert.match(canvas, /const projectId = String\(data\.projectId \|\| 'project-local'\)\.trim\(\) \|\| 'project-local';/);
  assert.match(canvas, /const requestedCanvasId = activeId;[\s\S]{0,180}?setActiveProjectId\(null\);/, 'new canvas must not inherit the prior project for one render');
  assert.match(canvas, /setActiveProjectId\(projectId\);/);
  assert.match(canvas, /<ProjectWorkbench[\s\S]{0,240}?open=\{projectWorkbenchOpen && loaded && loadedCanvasId === activeId && activeProjectId != null\}/);
  assert.match(canvas, /canvasId=\{activeId\}[\s\S]{0,80}?projectId=\{activeProjectId \|\| 'project-local'\}/);

  assert.match(workbench, /interface ProjectWorkbenchProps \{[\s\S]{0,180}?projectId: string;/);
  assert.match(workbench, /<AssetCenter key=\{`\$\{props\.projectId\}:\$\{props\.canvasId \|\| ''\}`\} canvasId=\{props\.canvasId\} projectId=\{props\.projectId\}/);

  assert.match(center, /interface AssetCenterProps \{[\s\S]{0,100}?projectId: string;/);
  assert.match(center, /export default function AssetCenter\(\{ canvasId, projectId, onInsertAsset \}: AssetCenterProps\)/);
  assert.match(center, /const assetProjectId = String\(projectId \|\| 'project-local'\)\.trim\(\) \|\| 'project-local';/);
  assert.doesNotMatch(center, /const assetProjectId[^;]*(?:activeAsset|selectedAsset)/, 'project scope must never be inferred from a selected asset');
  assert.match(center, /const filters = useMemo[\s\S]{0,180}?projectId: assetProjectId/);
  assert.match(center, /const batchFilterSnapshot = useMemo[\s\S]{0,180}?projectId: assetProjectId/);
  assert.match(center, /api\.listAssetCollections\(assetProjectId\)/);
  assert.match(center, /api\.applyProjectAssetBatch\(\{\s*projectId: assetProjectId/);
  assert.match(center, /api\.linkProjectAssets\(\{ paths, projectId: assetProjectId, canvasId:/);
  assert.match(center, /const expectedProjectId = assetProjectId;[\s\S]{0,900}?api\.scanProjectAssets\(expectedProjectId, \{ signal: controller\.signal \}\)/);
  assert.match(center, /api\.listProjectAssetDuplicateGroups\(\{\s*projectId: assetProjectId/);
  assert.match(center, /api\.decideProjectAssetDuplicate\([\s\S]{0,300}?expectedCatalogRevision,[\s\S]{0,100}?projectId: assetProjectId,[\s\S]{0,20}?\)/);
  assert.match(center, /\}, \[assetProjectId\]\);/, 'project changes must reset D3 selection, detail, pagination, and saved-view state');
});

test('permission save is generation guarded and refreshes the post-ACL asset revision before applying UI state', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const helperStart = center.indexOf('const runSelectedMutationRequest');
  const helperEnd = center.indexOf('const canApplySelectedMutation', helperStart);
  const saveStart = center.indexOf('const saveAssetPermissions');
  const saveEnd = center.indexOf('const counts =', saveStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart && saveStart >= 0 && saveEnd > saveStart);
  const helper = center.slice(helperStart, helperEnd);
  const save = center.slice(saveStart, saveEnd);

  assert.match(helper, /selectedMutationSequenceRef\.current \+ 1/);
  assert.match(helper, /detailGenerationRef\.current = revision;/);
  assert.match(helper, /detailControllerRef\.current\?\.abort\(\);/);
  assert.match(helper, /detailRefreshControllerRef\.current\?\.abort\(\);/);
  assert.match(save, /runSelectedMutationRequest\(targetId, async \(\) => \{/);
  const policyWrite = save.indexOf('await api.setProjectAssetPermissions(targetId');
  const freshRead = save.indexOf('await api.getProjectAsset(targetId)');
  const generationGuard = save.indexOf('if (!canApplySelectedMutation(targetId, revision))');
  const freshApply = save.indexOf('setSelectedAsset(value.freshAsset);');
  assert.ok(policyWrite >= 0 && freshRead > policyWrite, 'fresh asset must be fetched after the ACL transaction');
  assert.ok(generationGuard > freshRead && freshApply > generationGuard, 'A→B→A responses must pass the mutation generation before applying');
  assert.match(save, /updateCachedAsset\(value\.freshAsset\);/);
  assert.match(save, /resetCatalog\(activeFiltersRef\.current\);/);
  assert.match(save, /if \([^)]*!canApplySelectedMutation\(targetId, mutationGeneration\)\)/, '409 recovery must also be selection-generation guarded');
  assert.doesNotMatch(save, /setSelectedAsset\(\{\s*\.\.\.targetAsset/, 'ACL success must not synthesize an asset from its stale pre-write revision');
});

test('confirmed ACL writes survive a failed fresh-asset read without applying an unconfirmed draft', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const reconcileStart = center.indexOf('const reconcileSelectedAssetGovernance');
  const saveStart = center.indexOf('const saveAssetPermissions');
  const saveEnd = center.indexOf('const counts =', saveStart);
  assert.ok(reconcileStart >= 0 && saveStart > reconcileStart && saveEnd > saveStart);
  const reconciliation = center.slice(reconcileStart, saveStart);
  const save = center.slice(saveStart, saveEnd);

  assert.match(reconciliation, /const tryReconcileSelectedAssetGovernance = async \(targetId: string\): Promise<boolean> => \{\s*try \{\s*return await reconcileSelectedAssetGovernance\(targetId\);\s*\} catch \{\s*return false;/);
  const put = save.indexOf('const policy = await api.setProjectAssetPermissions(targetId');
  const nullableAsset = save.indexOf('let freshAsset: AssetRef | null = null;', put);
  const nullableRefreshError = save.indexOf('let refreshError: unknown = null;', nullableAsset);
  const freshGet = save.indexOf('freshAsset = await api.getProjectAsset(targetId);', nullableRefreshError);
  const captureRefreshError = save.indexOf('refreshError = error;', freshGet);
  const confirmedReturn = save.indexOf('return { policy, freshAsset, refreshError };', captureRefreshError);
  const confirmedPolicyApply = save.indexOf('setAssetPermissions(value.policy);', confirmedReturn);
  assert.ok(put >= 0 && nullableAsset > put && nullableRefreshError > nullableAsset && freshGet > nullableRefreshError
    && captureRefreshError > freshGet && confirmedReturn > captureRefreshError && confirmedPolicyApply > confirmedReturn,
  'ACL PUT confirmation must be retained even when the following asset GET throws');
  assert.match(save, /if \(value\.freshAsset\) \{\s*setSelectedAsset\(value\.freshAsset\);/,
    'asset state may only be replaced when the post-write GET actually returned an asset');
  assert.match(save, /if \(value\.refreshError\) \{\s*const reconciled = await tryReconcileSelectedAssetGovernance\(targetId\);\s*if \(!canApplySelectedMutation\(targetId, revision\)\) return;/);
  assert.match(save, /素材权限已保存（revision \$\{value\.policy\.revision\}），但最新素材版本暂未刷新/,
    'confirmed write plus failed refresh must be reported as saved, not as a failed save');
  assert.match(save, /setPermissionScopeDraft\(value\.policy\.scope\);/);
  assert.match(save, /setPermissionGrantsDraft\(value\.policy\.grants\);/);
  assert.doesNotMatch(save, /setAssetPermissions\(\s*\{[^}]*permissionScopeDraft/,
    'a rejected or unconfirmed PUT must never copy the local ACL draft into confirmed policy state');
  assert.doesNotMatch(save, /setAssetPermissions\(currentPolicy\)|setPermissionScopeDraft\(permissionScopeDraft\)|setPermissionGrantsDraft\(permissionGrantsDraft\)/,
    'PUT failure paths may only reconcile service state or throw; they cannot mark the submitted draft as persisted');
  const staleConfirmedBranch = sourceBlockAfter(save, 'if (!canApplySelectedMutation(targetId, revision))');
  assert.match(staleConfirmedBranch, /tryReconcileSelectedAssetGovernance\(targetId\)/,
    'a confirmed response from an obsolete A→B→A generation may only trigger safe reconciliation');
  assert.doesNotMatch(staleConfirmedBranch, /setAssetPermissions|setPermissionScopeDraft|setPermissionGrantsDraft|setSelectedAsset/,
    'a failed reconciliation must not apply the obsolete confirmed response merely because the asset id matches again');
  assert.doesNotMatch(staleConfirmedBranch, /else[^]*setMessage/,
    'an obsolete confirmed response may be announced only after safe reconciliation loaded current server truth');
  assert.match(staleConfirmedBranch, /if \(reconciled\) setMessage/);

  const outerCatch = sourceBlockAfter(save, '} catch (error) {', confirmedReturn);
  assert.match(outerCatch, /tryReconcileSelectedAssetGovernance\(targetId\)/);
  assert.doesNotMatch(outerCatch, /setAssetPermissions\(value\.policy\)|setPermissionScopeDraft\(value\.policy\.scope\)|setPermissionGrantsDraft\(value\.policy\.grants\)/,
    'state based on a confirmed value must be unreachable when the PUT itself throws');
  const conflictBranch = sourceBlockAfter(outerCatch, 'if (error instanceof api.ApiRequestError && error.status === 409)');
  const conflictStaleReturn = conflictBranch.search(/if \((?:!reconciled && )?!canApplySelectedMutation\(targetId, mutationGeneration\)\)\s*(?:\{\s*)?return;/);
  const conflictThrow = conflictBranch.indexOf('throw ');
  assert.ok(conflictStaleReturn >= 0 && conflictThrow > conflictStaleReturn,
    'an unreconciled stale 409 must return before runMutation can publish the old conflict');
  const finalStaleReturn = outerCatch.search(/if \(!canApplySelectedMutation\(targetId, mutationGeneration\)\)\s*(?:\{\s*)?return;/);
  const finalThrow = outerCatch.lastIndexOf('throw error;');
  assert.ok(finalStaleReturn >= 0 && finalThrow > finalStaleReturn,
    'an unreconciled stale PUT failure must return before runMutation can publish the old error');
});

test('candidate, exact-group, and exact-member UI renders one bounded cursor page at a time', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const candidateStart = center.indexOf('const loadDuplicates');
  const groupStart = center.indexOf('const loadDuplicateGroups');
  const memberStart = center.indexOf('const loadDuplicateGroupMembers');
  const sourceStart = center.indexOf('const activateSourceNode');
  assert.ok(candidateStart >= 0 && groupStart > candidateStart && memberStart > groupStart && sourceStart > memberStart);
  const candidateLoader = center.slice(candidateStart, groupStart);
  const groupLoader = center.slice(groupStart, memberStart);
  const memberLoader = center.slice(memberStart, sourceStart);

  assert.match(candidateLoader, /limit: 25/);
  assert.match(candidateLoader, /if \(!nextPage && mode !== 'exact'\)/);
  assert.match(candidateLoader, /api\.refreshProjectAssetDuplicates\(targetId/);
  assert.ok(
    candidateLoader.indexOf('api.refreshProjectAssetDuplicates(targetId')
      < candidateLoader.indexOf('api.listProjectAssetDuplicates(targetId'),
    'the explicit first-page refresh must finish before the pure list request',
  );
  assert.match(candidateLoader, /expectedCatalogRevision: catalogRevisionRef\.current|const expectedCatalogRevision = catalogRevisionRef\.current/);
  assert.match(candidateLoader, /page\.catalogRevision/);
  assert.match(candidateLoader, /error instanceof api\.ApiRequestError && error\.status === 409[\s\S]*resetCatalog\(activeFiltersRef\.current\)/);
  assert.match(candidateLoader, /generation !== duplicateGenerationRef\.current \|\| !canApplySelectedMutation\(targetId, targetRevision\)/);
  assert.match(candidateLoader, /decisionDuplicateGeneration !== duplicateGenerationRef\.current/);
  assert.match(candidateLoader, /String\(currentCandidatePage\?\.catalogRevision\) !== String\(expectedCatalogRevision\)/);
  assert.match(candidateLoader, /const candidatePageIsActive = duplicatePageIndexRef\.current === candidatePageIndex/);
  assert.match(candidateLoader, /if \(candidatePageIsActive\) \{[\s\S]*setDuplicates/);
  assert.match(candidateLoader, /decisionStillCurrent[\s\S]*if \(!decisionStillCurrent\) return;/);
  assert.match(candidateLoader, /error instanceof api\.ApiRequestError && error\.status === 409[\s\S]*setDuplicatePages\(\[\]\)[\s\S]*resetCatalog\(activeFiltersRef\.current\)/);
  assert.match(center, /finally \{ setMutation\(\(current\) => current === name \? '' : current\); \}/);
  assert.match(candidateLoader, /setDuplicates\(page\.items\)/);
  assert.doesNotMatch(candidateLoader, /setDuplicates\([^)]*(?:concat|\.\.\.current)/, 'candidate DOM state must not accumulate earlier pages');
  assert.match(groupLoader, /limit: 25/);
  assert.match(groupLoader, /setDuplicateGroups\(page\.items\)/);
  assert.doesNotMatch(groupLoader, /setDuplicateGroups\([^)]*(?:concat|\.\.\.current)/, 'group DOM state must not accumulate earlier pages');
  assert.match(memberLoader, /limit: 100/);
  assert.match(center, /const memberPage = memberState\?\.pages\[memberState\.pageIndex\];/);
  assert.match(center, /group\.members\.slice\(0, 20\)\.map/);
  assert.match(center, /memberPage\.items\.map/);
  assert.match(center, /duplicates\.map/);
  assert.match(center, /duplicateGroups\.map/);
  assert.doesNotMatch(center, /duplicatePages\.flatMap|duplicateGroupPages\.flatMap|memberState\.pages\.flatMap/);
});

test('catalog resets and revision drift invalidate cached duplicate cursor pages before reuse', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const requestStart = center.indexOf('const requestPage');
  const resetStart = center.indexOf('const resetCatalog', requestStart);
  const effectStart = center.indexOf('useEffect(() => {', resetStart);
  assert.ok(requestStart >= 0 && resetStart > requestStart && effectStart > resetStart);
  const requestPage = center.slice(requestStart, resetStart);
  const resetCatalog = center.slice(resetStart, effectStart);
  for (const source of [requestPage, resetCatalog]) {
    assert.match(source, /duplicateGenerationRef\.current \+= 1/);
    assert.match(source, /duplicateControllerRef\.current\?\.abort\(\)/);
    assert.match(source, /setDuplicatePages\(\[\]\)/);
    assert.match(source, /setDuplicatePageIndex\(0\)/);
    assert.match(source, /setDuplicates\(\[\]\)/);
    assert.match(source, /setDuplicateHasMore\(false\)/);
    assert.match(source, /setMutation\(\(current\) => current === 'duplicates' \? '' : current\)/);
  }
  assert.ok(
    requestPage.indexOf('setDuplicatePages([])') < requestPage.indexOf('void requestPage(0, nextGeneration, requestFilters)'),
    'revision drift must discard cached candidate pages before requesting the new catalog snapshot',
  );
  const selectStart = center.indexOf('const selectAsset');
  const selectEnd = center.indexOf('const activateAssetAtIndex', selectStart);
  const selectAsset = center.slice(selectStart, selectEnd);
  assert.match(selectAsset, /duplicateGenerationRef\.current \+= 1/);
  assert.match(selectAsset, /duplicateControllerRef\.current\?\.abort\(\)/);
  assert.match(selectAsset, /setMutation\(\(current\) => current === 'duplicates' \? '' : current\)/);
});

test('lineage UI renders only the current page and rejects stale A→B→A or project-switch responses', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const selectStart = center.indexOf('const selectAsset');
  const selectEnd = center.indexOf('const activateAssetAtIndex', selectStart);
  const lineageStart = center.indexOf('const showLineagePage');
  const lineageEnd = center.indexOf('const addPermissionGrant', lineageStart);
  const projectResetStart = center.indexOf('useEffect(() => {', center.indexOf('setCollectionDrafts'));
  const projectResetEnd = center.indexOf('const requestPage', projectResetStart);
  assert.ok(selectStart >= 0 && selectEnd > selectStart && lineageStart >= 0 && lineageEnd > lineageStart);
  assert.ok(projectResetStart >= 0 && projectResetEnd > projectResetStart);
  const selection = center.slice(selectStart, selectEnd);
  const lineageLoader = center.slice(lineageStart, lineageEnd);
  const projectReset = center.slice(projectResetStart, projectResetEnd);

  assert.match(center, /const lineageControllerRef = useRef<AbortController \| null>\(null\);/);
  assert.match(center, /const \[lineagePages, setLineagePages\] = useState<AssetLineagePage\[]>\(\[]\);/);
  assert.match(center, /const \[lineagePageIndex, setLineagePageIndex\] = useState\(0\);/);
  assert.match(selection, /lineageControllerRef\.current\?\.abort\(\);/);
  assert.match(selection, /api\.listProjectAssetLineage\(asset\.id, \{ limit: 50, signal: controller\.signal \}\)/);
  assert.match(selection, /if \(detailGenerationRef\.current !== generation\) return;/, 'initial lineage response must be generation guarded for A→B→A selection changes');
  assert.match(selection, /setLineagePages\(\[freshLineage\]\);/);
  assert.match(projectReset, /lineageControllerRef\.current\?\.abort\(\);/, 'changing projectId must abort the old project lineage request');
  assert.match(projectReset, /setLineagePages\(\[]\);\s*setLineagePageIndex\(0\);/);

  assert.match(lineageLoader, /const currentPage = lineagePages\[lineagePageIndex\];/);
  assert.match(lineageLoader, /limit: currentPage\.limit/);
  assert.match(lineageLoader, /cursor: currentPage\.cursor \|\| undefined/);
  assert.match(lineageLoader, /lineageControllerRef\.current !== controller \|\| !canApplySelectedMutation\(targetId, targetGeneration\)/);
  assert.match(lineageLoader, /error instanceof api\.ApiRequestError && error\.status === 409/);
  const staleReload = lineageLoader.indexOf("error instanceof api.ApiRequestError && error.status === 409");
  const freshReload = lineageLoader.indexOf('await api.listProjectAssetLineage(targetId', staleReload);
  const staleGuard = lineageLoader.indexOf('!canApplySelectedMutation(targetId, targetGeneration)', freshReload);
  const resetFirst = lineageLoader.indexOf('setLineagePages([refreshed]);', staleGuard);
  assert.ok(staleReload >= 0 && freshReload > staleReload && staleGuard > freshReload && resetFirst > staleGuard,
    '409 may reset to page one only after the refreshed response passes the current selection generation');
  assert.match(lineageLoader, /setLineagePageIndex\(0\);/);
  const innerRefreshCatch = lineageLoader.indexOf('} catch (refreshError) {', freshReload);
  const innerAbortGuard = lineageLoader.indexOf('!isAbortError(refreshError)', innerRefreshCatch);
  const innerControllerGuard = lineageLoader.indexOf('lineageControllerRef.current === controller', innerAbortGuard);
  const innerGenerationGuard = lineageLoader.indexOf('canApplySelectedMutation(targetId, targetGeneration)', innerControllerGuard);
  assert.ok(innerRefreshCatch > freshReload && innerAbortGuard > innerRefreshCatch
    && innerControllerGuard > innerAbortGuard && innerGenerationGuard > innerControllerGuard,
  '409 first-page refresh must catch its own AbortError/network failure and mutate UI only for the same controller/generation');
  assert.match(lineageLoader, /if \(isAbortError\(error\)\) return;/,
    'the original next-page request AbortError must not escape the detached async IIFE');

  assert.match(center, /const lineagePage = lineagePages\[lineagePageIndex\] \|\| null;/);
  assert.match(center, /const lineage = lineagePage\?\.items \|\| \[];/);
  assert.match(center, /lineage\.map\(\(item\) =>/);
  assert.doesNotMatch(center, /lineagePages\.flatMap|lineagePages\.reduce/, 'the DOM must never accumulate every lineage cursor page');
  assert.match(center, /showLineagePage\(lineagePageIndex - 1\)/);
  assert.match(center, /loadNextLineagePage/);
});

test('D3 asset UI/API contracts preserve D2 virtualization while exposing complete governed interactions', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const browser = read('src/components/assets/AssetVirtualBrowser.tsx');
  const state = read('src/components/assets/assetD3State.ts');
  const api = read('src/services/api.ts');
  const types = read('src/types/project.ts');

  assert.match(browser, /aria-multiselectable="true"/);
  assert.match(browser, /data-asset-selection-checkbox/);
  assert.match(browser, /checked=\{selected\}\s*readOnly\s*onClick=\{\(event\) => \{\s*event\.stopPropagation\(\);\s*onToggleSelection\(asset, index\);\s*\}\}/,
    'the controlled selection checkbox must toggle from its click handler while stopping card activation');
  assert.match(browser, /event\.key === ' '/);
  assert.match(browser, /event\.shiftKey/);
  assert.match(browser, /event\.ctrlKey \|\| event\.metaKey/);
  assert.doesNotMatch(browser, /<video\b/);
  assert.match(center, /activeAssetId/);
  assert.match(center, /batchSelection/);
  assert.match(center, /queryAssetSelection/);
  assert.match(center, /expectedCatalogRevision/);
  assert.match(center, /EXPLICIT_SELECTION_LIMIT/);
  assert.match(center, /data-asset-batch-toolbar/);
  assert.match(center, /data-asset-collection-manager/);
  assert.match(center, /data-asset-duplicates-panel/);
  assert.match(center, /data-asset-exact-duplicate-groups/);
  assert.match(center, /data-asset-source-graph/);
  assert.match(center, /sourceTreePageIndex/);
  assert.match(center, /loadNextSourceTreePage/);
  assert.match(center, /data-asset-permissions/);
  assert.match(center, /projectId: assetProjectId/);
  assert.match(center, /mode: 'move'/);
  assert.match(center, /runSelectedMutationRequest\(targetId/);
  assert.match(center, /listProjectAssetDuplicateGroupMembers/);
  assert.match(center, /duplicateGroupMemberState/);
  assert.match(center, /QUERY_SELECTION_LIMIT = 10_000/);
  assert.match(center, /assetOrganizationRevision\(targetAsset\)/);
  assert.match(center, /data-asset-saved-filter-views/);
  assert.match(center, /不会自动合并|绝不会自动合并/);
  assert.match(center, /candidate\.kind === 'near'/);
  assert.match(center, /SHA-256 确认，无需人工决策/);
  assert.match(center, /ASSET_PAGE_REQUEST_LIMIT/);
  assert.match(center, /catalogGenerationRef/);
  assert.match(center, /controller\.abort\(\)/);
  assert.match(state, /ASSET_SOURCE_NODE_LIMIT = 120/);
  assert.match(state, /ASSET_SOURCE_EDGE_LIMIT = 240/);

  assert.match(api, /project-assets\/batch/);
  assert.match(api, /method: 'PATCH'/);
  assert.match(api, /method: 'DELETE'/);
  assert.match(api, /duplicate-candidates\/\$\{encodeURIComponent\(candidateId\)\}\/decision/);
  assert.match(api, /duplicate-groups/);
  assert.match(api, /source-tree/);
  assert.match(api, /\/permissions/);
  assert.match(api, /expectedRevision/);
  assert.match(api, /expectedCatalogRevision/);
  assert.match(api, /fromCollectionIds/);
  assert.match(api, /organizationRevisions/);
  assert.match(api, /Math\.min\(8,/);
  assert.match(types, /organizationRevision\?: AssetRevision/);
  assert.match(types, /catalogRevision: AssetRevision/);
  assert.match(types, /AssetBatchTarget/);
  assert.match(types, /AssetSourceTree/);
});
