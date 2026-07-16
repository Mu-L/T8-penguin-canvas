import type {
  AssetBatchTarget,
  AssetCatalogFilterSnapshot,
  AssetDuplicateCandidate,
  AssetRef,
  AssetRevision,
  AssetSourceTree,
  AssetSourceTreeEdge,
  AssetSourceTreeNode,
} from '../../types/project';

export const ASSET_SOURCE_NODE_LIMIT = 120;
export const ASSET_SOURCE_EDGE_LIMIT = 240;
export const ASSET_SAVED_VIEW_LIMIT = 20;
export const ASSET_SAVED_VIEW_NAME_LIMIT = 60;

export interface AssetSavedFilterView {
  id: string;
  projectId: string;
  name: string;
  filters: AssetCatalogFilterSnapshot;
  createdAt: number;
  updatedAt: number;
}

interface AssetSavedFilterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type AssetBatchSelectionState = {
  mode: 'explicit';
  ids: string[];
  expectedRevisions: Record<string, AssetRevision>;
} | {
  mode: 'query';
  query: AssetCatalogFilterSnapshot;
  filterKey: string;
  catalogRevision: AssetRevision;
  exclusions: string[];
  totalAtSelection: number;
};

export const EMPTY_ASSET_SELECTION: AssetBatchSelectionState = Object.freeze({
  mode: 'explicit' as const,
  ids: [],
  expectedRevisions: {},
});

function uniqueIds(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push(id);
  });
  return result;
}

export function assetOrganizationRevision(asset: Pick<AssetRef, 'organizationRevision' | 'updatedAt'>): AssetRevision {
  return asset.organizationRevision ?? asset.updatedAt ?? 0;
}

export function explicitAssetSelection(assets: readonly AssetRef[]): AssetBatchSelectionState {
  const ids = uniqueIds(assets.map((asset) => asset.id));
  const revisions: Record<string, AssetRevision> = {};
  assets.forEach((asset) => {
    if (ids.includes(asset.id)) revisions[asset.id] = assetOrganizationRevision(asset);
  });
  return { mode: 'explicit', ids, expectedRevisions: revisions };
}

export function queryAssetSelection(input: {
  query: AssetCatalogFilterSnapshot;
  filterKey: string;
  catalogRevision: AssetRevision;
  total: number;
}): AssetBatchSelectionState {
  return {
    mode: 'query',
    query: { ...input.query },
    filterKey: input.filterKey,
    catalogRevision: input.catalogRevision,
    exclusions: [],
    totalAtSelection: Math.max(0, Math.trunc(input.total)),
  };
}

export function isAssetBatchSelected(selection: AssetBatchSelectionState, assetId: string): boolean {
  return selection.mode === 'query'
    ? !selection.exclusions.includes(assetId)
    : selection.ids.includes(assetId);
}

export function assetBatchSelectionCount(selection: AssetBatchSelectionState): number {
  return selection.mode === 'query'
    ? Math.max(0, selection.totalAtSelection - selection.exclusions.length)
    : selection.ids.length;
}

export function toggleAssetBatchSelection(selection: AssetBatchSelectionState, asset: AssetRef): AssetBatchSelectionState {
  if (selection.mode === 'query') {
    const excluded = new Set(selection.exclusions);
    if (excluded.has(asset.id)) excluded.delete(asset.id);
    else excluded.add(asset.id);
    return { ...selection, exclusions: [...excluded] };
  }
  const ids = new Set(selection.ids);
  const expectedRevisions = { ...selection.expectedRevisions };
  if (ids.has(asset.id)) {
    ids.delete(asset.id);
    delete expectedRevisions[asset.id];
  } else {
    ids.add(asset.id);
    expectedRevisions[asset.id] = assetOrganizationRevision(asset);
  }
  return { mode: 'explicit', ids: [...ids], expectedRevisions };
}

export function selectAssetBatchRange(
  selection: AssetBatchSelectionState,
  assets: readonly AssetRef[],
  additive: boolean,
): AssetBatchSelectionState {
  if (!additive) return explicitAssetSelection(assets);
  if (selection.mode === 'query') {
    const includedIds = new Set(assets.map((asset) => asset.id));
    return { ...selection, exclusions: selection.exclusions.filter((id) => !includedIds.has(id)) };
  }
  const ids = new Set(selection.ids);
  const expectedRevisions = { ...selection.expectedRevisions };
  assets.forEach((asset) => {
    ids.add(asset.id);
    expectedRevisions[asset.id] = assetOrganizationRevision(asset);
  });
  return { mode: 'explicit', ids: [...ids], expectedRevisions };
}

export function assetSelectionMatchesFilter(selection: AssetBatchSelectionState, filterKey: string): boolean {
  return selection.mode === 'explicit' || selection.filterKey === filterKey;
}

export function assetSelectionCatalogIsCurrent(selection: AssetBatchSelectionState, revision: AssetRevision): boolean {
  return selection.mode === 'explicit' || String(selection.catalogRevision) === String(revision);
}

export function buildAssetBatchTarget(selection: AssetBatchSelectionState): AssetBatchTarget {
  if (selection.mode === 'query') {
    return {
      mode: 'query',
      query: { ...selection.query },
      catalogRevision: selection.catalogRevision,
      exclusions: uniqueIds(selection.exclusions),
    };
  }
  const assetIds = uniqueIds(selection.ids);
  return {
    mode: 'ids',
    assetIds,
    expectedRevisions: Object.fromEntries(assetIds.map((id) => [id, selection.expectedRevisions[id] ?? 0])),
  };
}

function graphHasCycle(nodes: readonly AssetSourceTreeNode[], edges: readonly AssetSourceTreeEdge[]): boolean {
  const nodeIds = new Set(nodes.map((node) => node.assetId));
  const adjacency = new Map<string, string[]>();
  edges.forEach((edge) => {
    if (!nodeIds.has(edge.fromAssetId) || !nodeIds.has(edge.toAssetId)) return;
    const next = adjacency.get(edge.fromAssetId) || [];
    next.push(edge.toAssetId);
    adjacency.set(edge.fromAssetId, next);
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((adjacency.get(id) || []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return nodes.some((node) => visit(node.assetId));
}

export function normalizeAssetSourceTree(
  tree: AssetSourceTree,
  nodeLimit = ASSET_SOURCE_NODE_LIMIT,
  edgeLimit = ASSET_SOURCE_EDGE_LIMIT,
): AssetSourceTree {
  const safeNodeLimit = Math.max(1, Math.min(ASSET_SOURCE_NODE_LIMIT, Math.trunc(nodeLimit) || ASSET_SOURCE_NODE_LIMIT));
  const safeEdgeLimit = Math.max(1, Math.min(ASSET_SOURCE_EDGE_LIMIT, Math.trunc(edgeLimit) || ASSET_SOURCE_EDGE_LIMIT));
  const seenNodes = new Set<string>();
  const nodes: AssetSourceTreeNode[] = [];
  const orderedNodes = [...tree.nodes].sort((left, right) => {
    if (left.assetId === tree.rootAssetId) return -1;
    if (right.assetId === tree.rootAssetId) return 1;
    return left.depth - right.depth;
  });
  for (const node of orderedNodes) {
    const assetId = String(node.assetId || '').trim();
    if (!assetId || seenNodes.has(assetId) || nodes.length >= safeNodeLimit) continue;
    seenNodes.add(assetId);
    nodes.push({ ...node, assetId, depth: Math.max(0, Math.trunc(Number(node.depth) || 0)) });
  }
  const seenEdges = new Set<string>();
  const edges: AssetSourceTreeEdge[] = [];
  for (const edge of tree.edges) {
    if (edges.length >= safeEdgeLimit || !seenNodes.has(edge.fromAssetId) || !seenNodes.has(edge.toAssetId)) continue;
    const key = `${edge.fromAssetId}\u0000${edge.toAssetId}\u0000${edge.relation}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ ...edge, id: edge.id || key });
  }
  return {
    rootAssetId: tree.rootAssetId,
    nodes,
    edges,
    cursor: tree.cursor || null,
    hasMore: Boolean(tree.hasMore && tree.cursor),
    truncated: Boolean(tree.truncated || nodes.length < tree.nodes.length || edges.length < tree.edges.length),
    cycleDetected: Boolean(tree.cycleDetected || graphHasCycle(nodes, edges)),
    totalNodes: tree.totalNodes,
    totalEdges: tree.totalEdges,
  };
}

export function mergeAssetDuplicateCandidates(
  current: readonly AssetDuplicateCandidate[],
  incoming: readonly AssetDuplicateCandidate[],
): AssetDuplicateCandidate[] {
  const merged = new Map(current.map((candidate) => [candidate.id, candidate]));
  incoming.forEach((candidate) => merged.set(candidate.id, candidate));
  return [...merged.values()];
}

export function formatAssetTimecode(seconds?: number): string {
  if (!Number.isFinite(seconds) || Number(seconds) < 0) return '—';
  const milliseconds = Math.round(Number(seconds) * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function savedFilterStorageKey(projectId: string): string {
  return `t8.asset.saved-filter-views.v1:${encodeURIComponent(projectId)}`;
}

function boundedFilterValue(value: unknown, maximum = 500): string | undefined {
  const normalized = String(value || '').trim().slice(0, maximum);
  return normalized || undefined;
}

export function normalizeAssetSavedFilters(filters: AssetCatalogFilterSnapshot): AssetCatalogFilterSnapshot {
  const sort = ['created-desc', 'created-asc', 'updated-desc', 'updated-asc', 'name-asc', 'name-desc', 'size-desc', 'size-asc'].includes(String(filters.sort))
    ? filters.sort
    : undefined;
  return {
    query: boundedFilterValue(filters.query),
    kind: boundedFilterValue(filters.kind, 60),
    source: boundedFilterValue(filters.source, 100),
    storageMode: ['managed', 'linked', 'remote', 'embedded'].includes(String(filters.storageMode)) ? filters.storageMode : undefined,
    availability: ['available', 'missing', 'corrupt', 'unverified'].includes(String(filters.availability)) ? filters.availability : undefined,
    tag: boundedFilterValue(filters.tag, 100),
    collectionId: boundedFilterValue(filters.collectionId, 100),
    sort,
  };
}

export function loadAssetSavedFilterViews(storage: AssetSavedFilterStorage | null | undefined, projectId: string): AssetSavedFilterView[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(savedFilterStorageKey(projectId)) || '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const views: AssetSavedFilterView[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || views.length >= ASSET_SAVED_VIEW_LIMIT) continue;
      const raw = entry as Partial<AssetSavedFilterView>;
      const id = boundedFilterValue(raw.id, 100);
      const name = boundedFilterValue(raw.name, ASSET_SAVED_VIEW_NAME_LIMIT);
      if (!id || !name || seen.has(id) || String(raw.projectId) !== projectId) continue;
      seen.add(id);
      views.push({
        id,
        projectId,
        name,
        filters: normalizeAssetSavedFilters(raw.filters || {}),
        createdAt: Math.max(0, Number(raw.createdAt) || 0),
        updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
      });
    }
    return views;
  } catch {
    return [];
  }
}

export function saveAssetSavedFilterView(
  storage: AssetSavedFilterStorage,
  projectId: string,
  input: { id?: string; name: string; filters: AssetCatalogFilterSnapshot },
  now = Date.now(),
): AssetSavedFilterView[] {
  const name = boundedFilterValue(input.name, ASSET_SAVED_VIEW_NAME_LIMIT);
  if (!name) throw new Error('筛选视图名称不能为空');
  const existing = loadAssetSavedFilterViews(storage, projectId);
  const id = boundedFilterValue(input.id, 100) || `view-${Math.trunc(now).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const previous = existing.find((view) => view.id === id);
  const next: AssetSavedFilterView = {
    id,
    projectId,
    name,
    filters: normalizeAssetSavedFilters(input.filters),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
  const views = [next, ...existing.filter((view) => view.id !== id)].slice(0, ASSET_SAVED_VIEW_LIMIT);
  storage.setItem(savedFilterStorageKey(projectId), JSON.stringify(views));
  return views;
}

export function deleteAssetSavedFilterView(
  storage: AssetSavedFilterStorage,
  projectId: string,
  id: string,
): AssetSavedFilterView[] {
  const views = loadAssetSavedFilterViews(storage, projectId).filter((view) => view.id !== id);
  storage.setItem(savedFilterStorageKey(projectId), JSON.stringify(views));
  return views;
}
