import type {
  AssetRevision,
  AssetSearchMode,
  AssetSemanticEvidence,
  AssetSemanticProjectStatus,
  AssetSemanticSearchHit,
  AssetSemanticSearchIdentity,
  AssetSemanticSearchPage,
} from '../../types/project';

export type {
  AssetSearchMode,
  AssetSemanticCapability,
  AssetSemanticCapabilityCounts,
  AssetSemanticCapabilityStatus,
  AssetSemanticEvidence,
  AssetSemanticIndexState,
  AssetSemanticInstallState,
  AssetSemanticModelStatus,
  AssetSemanticProjectStatus,
  AssetSemanticSearchHit,
  AssetSemanticSearchIdentity,
  AssetSemanticSearchPage,
} from '../../types/project';

export type AssetSemanticAvailabilityReason =
  | 'ready'
  | 'model-missing'
  | 'model-downloading'
  | 'model-error'
  | 'project-disabled'
  | 'index-empty'
  | 'index-building'
  | 'index-stale'
  | 'index-error';

export interface AssetSemanticAvailability {
  searchable: boolean;
  reason: AssetSemanticAvailabilityReason;
  message: string;
}

export type AssetSemanticEmptyState =
  | 'model-missing'
  | 'model-downloading'
  | 'model-error'
  | 'project-disabled'
  | 'index-empty'
  | 'index-building'
  | 'index-stale'
  | 'index-error'
  | 'query-empty'
  | 'no-results'
  | 'network-error';

export interface AssetSemanticSavedSearch {
  mode: AssetSearchMode;
  semanticQuery?: string;
}

const MAX_QUERY_LENGTH = 2_000;
const MAX_EVIDENCE = 3;
const MAX_SNIPPET_LENGTH = 320;

function normalizedRevision(value: AssetRevision | null | undefined): string {
  return String(value ?? '');
}

export function normalizeAssetSemanticQuery(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

export function normalizeAssetSemanticEvidence(values: readonly AssetSemanticEvidence[]): AssetSemanticEvidence[] {
  const result: AssetSemanticEvidence[] = [];
  const seen = new Set<string>();
  for (const raw of values || []) {
    if (!raw || result.length >= MAX_EVIDENCE) break;
    const snippet = normalizeAssetSemanticQuery(raw.snippet).slice(0, MAX_SNIPPET_LENGTH);
    if (!snippet) continue;
    const source = ['filename', 'tag', 'metadata', 'caption', 'ocr', 'text'].includes(raw.source)
      ? raw.source
      : 'metadata';
    const key = `${source}\u0000${snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bbox = Array.isArray(raw.bbox) && raw.bbox.length === 4
      && raw.bbox.every((item) => Number.isFinite(Number(item)))
      ? raw.bbox.map((item) => Number(item)) as [number, number, number, number]
      : undefined;
    result.push({
      source,
      snippet,
      modelKey: raw.modelKey ? String(raw.modelKey).slice(0, 120) : undefined,
      modelVersion: raw.modelVersion ? String(raw.modelVersion).slice(0, 120) : undefined,
      frameIndex: Number.isInteger(raw.frameIndex) && Number(raw.frameIndex) >= 0 ? Number(raw.frameIndex) : undefined,
      time: Number.isFinite(raw.time) && Number(raw.time) >= 0 ? Number(raw.time) : undefined,
      page: Number.isInteger(raw.page) && Number(raw.page) >= 0 ? Number(raw.page) : undefined,
      bbox,
    });
  }
  return result;
}

export function assetSemanticAvailability(status: AssetSemanticProjectStatus | null | undefined): AssetSemanticAvailability {
  if (!status) return { searchable: false, reason: 'index-empty', message: '尚未读取语义能力状态。' };
  const embedding = status.capabilities.embedding;
  if (!embedding.enabled) return { searchable: false, reason: 'project-disabled', message: '当前项目未启用 Embedding；关键词搜索仍可使用。' };
  if (!embedding.model || embedding.model.installState === 'not-installed') {
    return { searchable: false, reason: 'model-missing', message: 'Embedding 模型尚未下载；不会自动下载大模型。' };
  }
  if (embedding.model.installState === 'downloading' || embedding.model.installState === 'verifying') {
    return { searchable: false, reason: 'model-downloading', message: 'Embedding 模型仍在下载或校验，完成后还需重建当前项目索引。' };
  }
  if (embedding.model.installState === 'error' || !embedding.model.installed) {
    return { searchable: false, reason: 'model-error', message: embedding.model.error || 'Embedding 模型安装失败，可重试下载。' };
  }
  const hasActiveIndex = status.activeGeneration > 0 && normalizedRevision(status.activeIndexRevision) !== '';
  if (status.indexState === 'error' || status.indexState === 'degraded') {
    return {
      searchable: hasActiveIndex,
      reason: 'index-error',
      message: hasActiveIndex ? '最近一次重建失败，继续使用上一个成功索引。' : '语义索引构建失败，请检查失败任务后重建。',
    };
  }
  if (status.buildingGeneration != null || status.indexState === 'queued' || status.indexState === 'building') {
    return {
      searchable: hasActiveIndex,
      reason: 'index-building',
      message: hasActiveIndex ? '新索引正在构建，当前查询继续使用上一个成功代次。' : '语义索引正在首次构建。',
    };
  }
  if (!hasActiveIndex || status.indexState === 'empty') {
    return { searchable: false, reason: 'index-empty', message: '模型已安装，但当前项目还没有可用语义索引。' };
  }
  if (status.indexStale || status.indexState === 'stale'
    || normalizedRevision(status.activeCatalogRevision) !== normalizedRevision(status.currentCatalogRevision)) {
    return { searchable: true, reason: 'index-stale', message: '素材目录已变化；查询使用上一个索引，建议重建。' };
  }
  return { searchable: true, reason: 'ready', message: '语义索引可用。' };
}

export function assetSemanticSearchIdentityMatches(
  left: AssetSemanticSearchIdentity | null | undefined,
  right: AssetSemanticSearchIdentity | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left.projectId === right.projectId
    && left.queryDigest === right.queryDigest
    && normalizedRevision(left.catalogRevision) === normalizedRevision(right.catalogRevision)
    && normalizedRevision(left.semanticIndexRevision) === normalizedRevision(right.semanticIndexRevision)
    && left.activeGeneration === right.activeGeneration
    && left.modelKey === right.modelKey
    && left.modelVersion === right.modelVersion;
}

export function buildAssetD4FilterKey(input: {
  mode: AssetSearchMode;
  projectId: string;
  keywordQuery?: string;
  semanticQuery?: string;
  filters?: Record<string, unknown>;
  semanticIdentity?: Pick<AssetSemanticSearchIdentity, 'semanticIndexRevision' | 'activeGeneration' | 'modelKey' | 'modelVersion'> | null;
}): string {
  const filters = Object.fromEntries(Object.entries(input.filters || {})
    .filter(([, value]) => value !== undefined && value !== '')
    .sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify({
    mode: input.mode,
    projectId: String(input.projectId || ''),
    query: normalizeAssetSemanticQuery(input.mode === 'semantic' ? input.semanticQuery : input.keywordQuery),
    filters,
    semanticIndexRevision: input.mode === 'semantic' ? normalizedRevision(input.semanticIdentity?.semanticIndexRevision) : '',
    activeGeneration: input.mode === 'semantic' ? Number(input.semanticIdentity?.activeGeneration || 0) : 0,
    modelKey: input.mode === 'semantic' ? String(input.semanticIdentity?.modelKey || '') : '',
    modelVersion: input.mode === 'semantic' ? String(input.semanticIdentity?.modelVersion || '') : '',
  });
}

export function shouldInvalidateAssetD4Search(previousKey: string, nextKey: string): boolean {
  return previousKey !== nextKey;
}

export function canUseAssetQuerySelection(mode: AssetSearchMode): boolean {
  return mode === 'keyword';
}

export function updateAssetSemanticPageLru(
  pages: ReadonlyMap<number, AssetSemanticSearchPage>,
  offset: number,
  page: AssetSemanticSearchPage,
  limit = 8,
): Map<number, AssetSemanticSearchPage> {
  const next = new Map(pages);
  next.delete(offset);
  next.set(offset, page);
  while (next.size > Math.max(1, Math.trunc(limit) || 8)) {
    const oldest = next.keys().next().value as number | undefined;
    if (oldest == null) break;
    next.delete(oldest);
  }
  return next;
}

export function readAssetSemanticPageHit(
  pages: ReadonlyMap<number, AssetSemanticSearchPage>,
  index: number,
  pageSize: number,
): AssetSemanticSearchHit | undefined {
  const size = Math.max(1, Math.trunc(pageSize) || 1);
  const safeIndex = Math.max(0, Math.trunc(index) || 0);
  const offset = Math.floor(safeIndex / size) * size;
  return pages.get(offset)?.hits[safeIndex - offset];
}

export function assetSemanticEmptyState(input: {
  availability: AssetSemanticAvailability;
  query: string;
  loading: boolean;
  total: number;
  error?: string;
}): AssetSemanticEmptyState | null {
  if (input.error) return 'network-error';
  if (!input.availability.searchable) {
    if (input.availability.reason === 'ready') return null;
    return input.availability.reason;
  }
  if (!normalizeAssetSemanticQuery(input.query)) return 'query-empty';
  if (input.loading) return null;
  if (input.total === 0) return 'no-results';
  if (input.availability.reason === 'index-stale') return 'index-stale';
  if (input.availability.reason === 'index-building') return 'index-building';
  if (input.availability.reason === 'index-error') return 'index-error';
  return null;
}

export function normalizeAssetSemanticSavedSearch(input: AssetSemanticSavedSearch): AssetSemanticSavedSearch {
  const mode: AssetSearchMode = input?.mode === 'semantic' ? 'semantic' : 'keyword';
  return mode === 'semantic'
    ? { mode, semanticQuery: normalizeAssetSemanticQuery(input.semanticQuery) || undefined }
    : { mode };
}
