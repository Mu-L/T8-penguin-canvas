import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Grid2X2,
  Link2,
  List,
  Loader2,
  Play,
  RefreshCw,
  ScanSearch,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import * as api from '../../services/api';
import type {
  AssetAvailabilityRefreshInput,
  AssetBatchMutationSet,
  AssetCollection,
  AssetDuplicateCandidate,
  AssetDuplicateKind,
  AssetDuplicatePage,
  AssetExactDuplicateGroup,
  AssetExactDuplicateGroupPage,
  AssetLineagePage,
  AssetPermissionRecord,
  AssetPermissionWireGrant,
  AssetPipelineStatus,
  AssetRef,
  AssetRevision,
  AssetSearchMode,
  AssetSemanticDocument,
  AssetSemanticStatus,
  AssetSourceTree,
} from '../../types/project';
import { previewImageUrl } from '../../utils/mediaPreview';
import {
  assetPipelineSignature,
  isCurrentAssetSelection,
  shouldInvalidateAssetCatalog,
} from '../../utils/assetCenterState';
import { decideInteractiveAssetModel, resolveSameOriginAssetUrl } from '../../utils/assetModelPreviewSecurity';
import {
  ASSET_PAGE_CACHE_LIMIT,
  ASSET_PAGE_REQUEST_LIMIT,
  ASSET_PAGE_SIZE,
  assetPageOffsetsForRange,
  readAssetPageItem,
  updateAssetPageLru,
  type AssetBrowserViewMode,
} from '../../utils/assetVirtualization';
import AssetVirtualBrowser from './AssetVirtualBrowser';
import AssetSemanticSettingsPanel from './AssetSemanticSettingsPanel';
import useAssetSemanticCatalog from './useAssetSemanticCatalog';
import {
  assetSemanticEmptyState,
  canUseAssetQuerySelection,
  normalizeAssetSemanticQuery,
} from './assetD4State';
import {
  ASSET_SOURCE_EDGE_LIMIT,
  ASSET_SOURCE_NODE_LIMIT,
  EMPTY_ASSET_SELECTION,
  assetOrganizationRevision,
  assetBatchSelectionCount,
  assetSelectionCatalogIsCurrent,
  buildAssetBatchTarget,
  formatAssetTimecode,
  isAssetBatchSelected,
  normalizeAssetSourceTree,
  deleteAssetSavedFilterView,
  loadAssetSavedFilterViews,
  saveAssetSavedFilterView,
  queryAssetSelection,
  selectAssetBatchRange,
  toggleAssetBatchSelection,
  type AssetBatchSelectionState,
  type AssetSavedFilterView,
} from './assetD3State';

const AssetModel3DPreview = lazy(() => import('./AssetModel3DPreview'));

interface AssetCenterProps {
  canvasId?: string | null;
  projectId: string;
  onInsertAsset: (asset: AssetRef) => void;
}

interface AssetCatalogFilters {
  projectId: string;
  kind?: string;
  storageMode?: AssetRef['storageMode'];
  availability?: AssetRef['availability'];
  collectionId?: string;
  tag?: string;
  source?: string;
  sort?: 'created-desc' | 'created-asc' | 'updated-desc' | 'updated-asc' | 'name-asc' | 'name-desc' | 'size-desc' | 'size-asc';
  query?: string;
  limit: number;
  offset: number;
}

const EMPTY_PREVIEW_COUNTS = { queued: 0, running: 0, retrying: 0, succeeded: 0, failed: 0 };
const EXPLICIT_SELECTION_LIMIT = 500;
const QUERY_SELECTION_LIMIT = 10_000;
const LINEAGE_PAGE_CACHE_LIMIT = 8;

interface AssetDuplicateGroupMemberPage {
  items: AssetRef[];
  cursor: string | null;
  hasMore: boolean;
}

function idempotencyKey(prefix: string): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function parseValues(value: string): string[] {
  return [...new Set(value.split(/[,，\n]/).map((entry) => entry.trim()).filter(Boolean))];
}

function permissionsForAssetRole(role: 'owner' | 'editor' | 'viewer'): string[] {
  if (role === 'owner') return ['view', 'preview', 'original', 'organize', 'manage_acl'];
  if (role === 'editor') return ['view', 'preview', 'original', 'organize'];
  return ['view', 'preview'];
}

function roleForAssetGrant(grant: AssetPermissionWireGrant): 'owner' | 'editor' | 'viewer' {
  if (grant.permissions.includes('manage_acl')) return 'owner';
  if (grant.permissions.includes('organize') || grant.permissions.includes('original')) return 'editor';
  return 'viewer';
}

function safeLocalStorage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; }
  catch { return null; }
}

function formatTime(value?: number | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function isAbortError(error: unknown): boolean {
  return (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')
    || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
}

function storageModeLabel(value: AssetRef['storageMode']): string {
  return { managed: '受管副本', linked: '本机链接', remote: '远程外链', embedded: '内嵌内容' }[value];
}

function availabilityLabel(value: AssetRef['availability']): string {
  return { available: '可用', missing: '已丢失', corrupt: '已损坏', unverified: '未验证' }[value];
}

function frozenAssetAvailabilityInput(
  asset: AssetRef | null,
  projectId: string,
  catalogRevision: AssetRevision | null,
): AssetAvailabilityRefreshInput | null {
  if (!asset
    || asset.projectId !== projectId
    || (asset.storageMode !== 'managed' && asset.storageMode !== 'linked')) return null;
  const expectedCatalogRevision = Number(catalogRevision);
  const contentRevision = Number(asset.contentRevision);
  const organizationRevision = Number(asset.organizationRevision);
  const entityUid = String(asset.entityUid || '').trim().toLowerCase();
  const contentHash = String(asset.contentHash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entityUid)
    || !/^[a-f0-9]{64}$/.test(contentHash)
    || !Number.isSafeInteger(expectedCatalogRevision) || expectedCatalogRevision < 1
    || !Number.isSafeInteger(contentRevision) || contentRevision < 1
    || !Number.isSafeInteger(organizationRevision) || organizationRevision < 1) return null;
  return {
    projectId,
    expectedCatalogRevision,
    entityUid,
    contentRevision,
    organizationRevision,
    contentHash,
  };
}

function semanticEmptyMessage(
  state: ReturnType<typeof assetSemanticEmptyState>,
  availabilityMessage: string,
  error: string,
): string {
  if (state === 'network-error') return error || '自然语言检索暂不可用，请刷新状态后重试。';
  if (state === 'query-empty') return '输入自然语言描述后按 Enter 或点击“检索”；输入过程不会自动提交。';
  if (state === 'no-results') return '当前索引中没有匹配的自然语言结果。';
  if (state === 'model-missing') return 'Embedding 模型尚未下载；应用不会自动下载大模型。';
  if (state === 'model-downloading') return 'Embedding 模型仍在下载或校验，完成后还需显式重建项目索引。';
  if (state === 'model-error') return availabilityMessage || 'Embedding 模型不可用，请检查安装状态。';
  if (state === 'project-disabled') return '当前项目未启用 Embedding；关键词搜索仍可正常使用。';
  if (state === 'index-empty') return availabilityMessage || '当前项目还没有可用的语义索引。';
  if (state === 'index-building') return availabilityMessage || '语义索引正在构建。';
  if (state === 'index-stale') return availabilityMessage || '素材目录已变化，当前结果来自上一个索引代次。';
  if (state === 'index-error') return availabilityMessage || '语义索引构建失败。';
  return '';
}

function normalizePipelineStatus(value: AssetPipelineStatus): AssetPipelineStatus {
  const raw = value as AssetPipelineStatus & { running?: boolean; lastResult?: AssetPipelineStatus['scan']['lastResult'] };
  const scan = raw.scan;
  const preview = raw.previews;
  const pending = preview?.pending && typeof preview.pending === 'object'
    ? preview.pending
    : { completions: 0, reschedules: 0, reruns: 0 };
  const storagePressure = preview?.storagePressure && typeof preview.storagePressure === 'object'
    && preview.storagePressure.scope === 'global'
    ? {
        active: preview.storagePressure.active === true,
        reason: String(preview.storagePressure.reason || 'storage-pressure').slice(0, 80),
        retryable: preview.storagePressure.retryable === true,
        nextRetryAt: Number.isFinite(Number(preview.storagePressure.nextRetryAt))
          ? Number(preview.storagePressure.nextRetryAt)
          : null,
        scope: 'global' as const,
      }
    : null;
  const databaseBusy = preview?.databaseBusy && typeof preview.databaseBusy === 'object'
    && preview.databaseBusy.scope === 'global'
    ? {
        active: preview.databaseBusy.active === true,
        code: String(preview.databaseBusy.code || 'project_database_busy').slice(0, 80),
        nextRetryAt: Number.isFinite(Number(preview.databaseBusy.nextRetryAt))
          ? Number(preview.databaseBusy.nextRetryAt)
          : null,
        scope: 'global' as const,
      }
    : null;
  return {
    projectId: String(raw.projectId || ''),
    scan: {
      projectId: String(scan?.projectId || ''),
      running: scan?.running === true || Boolean(raw.running),
      lastResult: scan?.lastResult || raw.lastResult || null,
    },
    previews: {
      projectId: String(preview?.projectId || ''),
      active: Number(preview?.active || 0),
      activeModel3d: Number(preview?.activeModel3d || 0),
      concurrency: Math.max(1, Number(preview?.concurrency || 1)),
      concurrencyScope: 'global',
      counts: { ...EMPTY_PREVIEW_COUNTS, ...(preview?.counts || {}) },
      pending: {
        completions: Math.max(0, Number(pending.completions || 0)),
        reschedules: Math.max(0, Number(pending.reschedules || 0)),
        reruns: Math.max(0, Number(pending.reruns || 0)),
      },
      nextAttemptAt: preview?.nextAttemptAt || null,
      ...(preview?.databaseStatusStale === true ? { databaseStatusStale: true } : {}),
      ...(preview?.shuttingDown === true
        ? { shuttingDown: true, shuttingDownScope: 'global' as const }
        : {}),
      ...(preview?.globalRecoveryPending === true ? { globalRecoveryPending: true } : {}),
      ...(storagePressure?.active ? { storagePressure } : {}),
      ...(databaseBusy?.active ? { databaseBusy } : {}),
    },
  };
}

function pipelineIsActive(status: AssetPipelineStatus | null): boolean {
  if (!status) return false;
  const counts = status.previews.counts;
  const pending = status.previews.pending;
  return status.scan.running
    || Number(status.previews.active || 0) > 0
    || counts.queued > 0
    || counts.running > 0
    || counts.retrying > 0
    || status.previews.databaseStatusStale === true
    || pending.completions > 0
    || pending.reschedules > 0
    || pending.reruns > 0;
}

function AssetDetailPreview({ asset }: { asset: AssetRef }) {
  const metadata = asset.metadata || {};
  if (asset.availability === 'missing' || asset.availability === 'corrupt') {
    return <div className="grid h-full place-items-center px-4 text-center text-xs font-semibold text-red-500">{asset.availability === 'missing' ? '源文件已丢失；重新连接后可恢复预览' : '素材已损坏，不能安全预览'}</div>;
  }
  if (asset.kind === 'image' && asset.sourceUrl) {
    return <img src={String(metadata.thumbnailUrl || previewImageUrl(asset.sourceUrl, 1024))} alt={asset.filename} className="h-full w-full object-contain" />;
  }
  if (asset.kind === 'video' && asset.sourceUrl) {
    const source = String(metadata.proxyUrl || metadata.videoProxyUrl || asset.sourceUrl);
    return <video key={source} src={source} poster={String(metadata.thumbnailUrl || metadata.firstFrameUrl || '') || undefined} controls preload="metadata" className="h-full w-full object-contain" aria-label={`${asset.filename} 视频预览`} />;
  }
  if (asset.kind === 'audio' && asset.sourceUrl) {
    return <div className="flex h-full flex-col items-center justify-center gap-3 p-3">{metadata.waveformUrl && <img src={String(metadata.waveformUrl)} alt={`${asset.filename} 波形`} className="min-h-0 w-full flex-1 object-contain" />}<audio key={asset.sourceUrl} src={asset.sourceUrl} controls preload="metadata" className="w-full" aria-label={`${asset.filename} 音频预览`} /></div>;
  }
  if (asset.kind === 'model3d') {
    const pageUrl = typeof window !== 'undefined' ? window.location.href : 'about:blank';
    const fallbackImageUrl = resolveSameOriginAssetUrl(String(metadata.modelPreviewUrl || ''), pageUrl) || undefined;
    const decision = decideInteractiveAssetModel(asset.sourceUrl, metadata, pageUrl, asset.availability, asset.contentHash);
    if (!decision.allowed) {
      return <div className="relative h-full w-full" data-asset-model-static-preview>
        {fallbackImageUrl
          ? <img src={fallbackImageUrl} alt={`${asset.filename} 静态 3D 预览`} className="h-full w-full object-contain" />
          : <div className="grid h-full place-items-center px-4 text-center text-xs opacity-55">暂无后端静态 3D 预览</div>}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/70 px-2 py-1 text-center text-[9px] text-white">安全限制：{decision.reason}</div>
      </div>;
    }
    return <Suspense fallback={<div className="grid h-full place-items-center text-xs opacity-60"><Loader2 size={18} className="animate-spin" />加载 3D 预览器…</div>}><AssetModel3DPreview url={decision.url} format={decision.format} expectedContentHash={asset.contentHash!} fallbackImageUrl={fallbackImageUrl} /></Suspense>;
  }
  if (metadata.thumbnailUrl || metadata.modelPreviewUrl) {
    return <img src={String(metadata.thumbnailUrl || metadata.modelPreviewUrl)} alt={asset.filename} className="h-full w-full object-contain" />;
  }
  return <div className="grid h-full place-items-center text-xs opacity-55">暂无可用预览</div>;
}

export default function AssetCenter({ canvasId, projectId, onInsertAsset }: AssetCenterProps) {
  const assetProjectId = String(projectId || 'project-local').trim() || 'project-local';
  const pagesRef = useRef<Map<number, readonly AssetRef[]>>(new Map());
  const pageControllersRef = useRef(new Map<number, AbortController>());
  const visiblePageOffsetsRef = useRef<Set<number>>(new Set([0]));
  const catalogGenerationRef = useRef(0);
  const catalogRevisionRef = useRef<AssetRevision | null>(null);
  const activeFiltersRef = useRef<Omit<AssetCatalogFilters, 'offset'>>({ projectId: assetProjectId, limit: ASSET_PAGE_SIZE });
  const detailGenerationRef = useRef(0);
  const detailControllerRef = useRef<AbortController | null>(null);
  const detailRefreshControllerRef = useRef<AbortController | null>(null);
  const selectedAssetIdRef = useRef<string | null>(null);
  const selectedMutationSequenceRef = useRef(0);
  const selectedMutationTokensRef = useRef<Map<string, Set<number>>>(new Map());
  const selectionAnchorIndexRef = useRef<number | null>(null);
  const rangeSelectionGenerationRef = useRef(0);
  const rangeSelectionControllerRef = useRef<AbortController | null>(null);
  const duplicateGenerationRef = useRef(0);
  const duplicateControllerRef = useRef<AbortController | null>(null);
  const duplicatePagesRef = useRef<AssetDuplicatePage[]>([]);
  const duplicatePageIndexRef = useRef(0);
  const duplicateGroupControllerRef = useRef<AbortController | null>(null);
  const duplicateGroupMemberControllerRef = useRef<AbortController | null>(null);
  const sourceTreeControllerRef = useRef<AbortController | null>(null);
  const lineageControllerRef = useRef<AbortController | null>(null);
  const semanticDocumentControllerRef = useRef<AbortController | null>(null);
  const semanticStatusRefreshEpochRef = useRef(0);
  const semanticStatusProjectRef = useRef(assetProjectId);
  semanticStatusProjectRef.current = assetProjectId;
  const semanticConflictSeenRef = useRef(0);
  const pipelineSignatureRef = useRef('');
  const pipelineProjectRef = useRef(assetProjectId);
  pipelineProjectRef.current = assetProjectId;
  const pipelineRequestEpochRef = useRef(0);
  const pipelineCatalogRefreshTimerRef = useRef<number | null>(null);
  const scanRequestEpochRef = useRef(0);
  const scanControllerRef = useRef<AbortController | null>(null);
  const availabilityRefreshEpochRef = useRef(0);
  const availabilityRefreshControllerRef = useRef<AbortController | null>(null);
  const [cacheRevision, setCacheRevision] = useState(0);
  const [total, setTotal] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [message, setMessage] = useState('');
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<AssetSearchMode>('keyword');
  const [semanticQueryInput, setSemanticQueryInput] = useState('');
  const [semanticQuery, setSemanticQuery] = useState('');
  const [semanticStatus, setSemanticStatus] = useState<AssetSemanticStatus | null>(null);
  const [semanticStatusRefreshToken, setSemanticStatusRefreshToken] = useState(0);
  const [semanticDocuments, setSemanticDocuments] = useState<AssetSemanticDocument[]>([]);
  const [semanticDocumentsLoading, setSemanticDocumentsLoading] = useState(false);
  const [semanticDocumentsError, setSemanticDocumentsError] = useState('');
  const [kind, setKind] = useState('');
  const [storageMode, setStorageMode] = useState('');
  const [availability, setAvailability] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [sortOrder, setSortOrder] = useState<NonNullable<AssetCatalogFilters['sort']>>('created-desc');
  const [catalogRevision, setCatalogRevision] = useState<AssetRevision>(0);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<AssetBrowserViewMode>('grid');
  const [collections, setCollections] = useState<AssetCollection[]>([]);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
  const [activeAsset, setActiveAsset] = useState<AssetRef | null>(null);
  // D1 detail mutation helpers keep their established local names, while the
  // canonical detail state is explicitly independent from batchSelection.
  const selectedAssetId = activeAssetId;
  const selectedAsset = activeAsset;
  const setSelectedAssetId = setActiveAssetId;
  const setSelectedAsset = setActiveAsset;
  const [batchSelection, setBatchSelection] = useState<AssetBatchSelectionState>(EMPTY_ASSET_SELECTION);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [batchConflict, setBatchConflict] = useState('');
  const [batchTagMode, setBatchTagMode] = useState<'add' | 'remove' | 'replace'>('add');
  const [batchTagDraft, setBatchTagDraft] = useState('');
  const [batchCollectionMode, setBatchCollectionMode] = useState<'add' | 'remove' | 'replace' | 'move'>('add');
  const [batchCollectionSourceId, setBatchCollectionSourceId] = useState('');
  const [batchCollectionId, setBatchCollectionId] = useState('');
  const [batchVisibility, setBatchVisibility] = useState<'project' | 'restricted'>('project');
  const [grantMemberDraft, setGrantMemberDraft] = useState('');
  const [grantPrincipalType, setGrantPrincipalType] = useState<'member' | 'role'>('member');
  const [grantRoleDraft, setGrantRoleDraft] = useState<'owner' | 'editor' | 'viewer'>('viewer');
  const [batchGrants, setBatchGrants] = useState<Array<{ principalType: 'member' | 'role'; principalId: string; role: 'owner' | 'editor' | 'viewer' }>>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [duplicates, setDuplicates] = useState<AssetDuplicateCandidate[]>([]);
  const [duplicateMode, setDuplicateMode] = useState<'all' | AssetDuplicateKind>('all');
  const [duplicateHasMore, setDuplicateHasMore] = useState(false);
  const [duplicatePages, setDuplicatePages] = useState<AssetDuplicatePage[]>([]);
  const [duplicatePageIndex, setDuplicatePageIndex] = useState(0);
  const [duplicateGroups, setDuplicateGroups] = useState<AssetExactDuplicateGroup[]>([]);
  const [duplicateGroupHasMore, setDuplicateGroupHasMore] = useState(false);
  const [duplicateGroupPages, setDuplicateGroupPages] = useState<AssetExactDuplicateGroupPage[]>([]);
  const [duplicateGroupPageIndex, setDuplicateGroupPageIndex] = useState(0);
  const [duplicateGroupMemberState, setDuplicateGroupMemberState] = useState<{
    groupId: string;
    pages: AssetDuplicateGroupMemberPage[];
    pageIndex: number;
  } | null>(null);
  const [sourceTree, setSourceTree] = useState<AssetSourceTree | null>(null);
  const [sourceTreePages, setSourceTreePages] = useState<AssetSourceTree[]>([]);
  const [sourceTreePageIndex, setSourceTreePageIndex] = useState(0);
  const [lineagePages, setLineagePages] = useState<AssetLineagePage[]>([]);
  const [lineagePageIndex, setLineagePageIndex] = useState(0);
  const [lineagePageOffset, setLineagePageOffset] = useState(0);
  const [lineageLoading, setLineageLoading] = useState(false);
  const [assetPermissions, setAssetPermissions] = useState<AssetPermissionRecord | null>(null);
  const [permissionScopeDraft, setPermissionScopeDraft] = useState<'project' | 'restricted'>('project');
  const [permissionGrantsDraft, setPermissionGrantsDraft] = useState<AssetPermissionWireGrant[]>([]);
  const [permissionPrincipalType, setPermissionPrincipalType] = useState<'member' | 'role'>('member');
  const [permissionPrincipalId, setPermissionPrincipalId] = useState('');
  const [permissionRole, setPermissionRole] = useState<'owner' | 'editor' | 'viewer'>('viewer');
  const [deleteDraft, setDeleteDraft] = useState<{ asset: AssetRef; confirmation: string } | null>(null);
  const [mutation, setMutation] = useState('');
  const [pipelineStatus, setPipelineStatus] = useState<AssetPipelineStatus | null>(null);
  const [pipelineError, setPipelineError] = useState('');
  const [collectionDrafts, setCollectionDrafts] = useState<Record<string, string>>({});
  const [savedViews, setSavedViews] = useState<AssetSavedFilterView[]>([]);
  const [savedViewName, setSavedViewName] = useState('');

  useEffect(() => {
    if (searchMode !== 'keyword') return undefined;
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [queryInput, searchMode]);

  useEffect(() => {
    duplicatePagesRef.current = duplicatePages;
  }, [duplicatePages]);

  const filterKey = useMemo(() => JSON.stringify({ projectId: assetProjectId, query, kind, storageMode, availability, collectionId, tag: tagFilter, source: sourceFilter, sort: sortOrder }), [assetProjectId, availability, collectionId, kind, query, sortOrder, sourceFilter, storageMode, tagFilter]);
  const filters = useMemo<Omit<AssetCatalogFilters, 'offset'>>(() => ({
    projectId: assetProjectId,
    query: query || undefined,
    kind: kind || undefined,
    storageMode: (storageMode || undefined) as AssetRef['storageMode'] | undefined,
    availability: (availability || undefined) as AssetRef['availability'] | undefined,
    collectionId: collectionId || undefined,
    tag: tagFilter || undefined,
    source: sourceFilter || undefined,
    sort: sortOrder,
    limit: ASSET_PAGE_SIZE,
  }), [assetProjectId, availability, collectionId, kind, query, sortOrder, sourceFilter, storageMode, tagFilter]);
  const batchFilterSnapshot = useMemo(() => ({
    projectId: assetProjectId,
    query: query || undefined,
    kind: kind || undefined,
    storageMode: (storageMode || undefined) as AssetRef['storageMode'] | undefined,
    availability: (availability || undefined) as AssetRef['availability'] | undefined,
    collectionId: collectionId || undefined,
    tag: tagFilter || undefined,
    source: sourceFilter || undefined,
    sort: sortOrder,
  }), [assetProjectId, availability, collectionId, kind, query, sortOrder, sourceFilter, storageMode, tagFilter]);
  const semanticFilters = useMemo(() => ({
    kind: kind || undefined,
    storageMode: (storageMode || undefined) as AssetRef['storageMode'] | undefined,
    availability: (availability || undefined) as AssetRef['availability'] | undefined,
    collectionId: collectionId || undefined,
    tag: tagFilter || undefined,
    source: sourceFilter || undefined,
  }), [availability, collectionId, kind, sourceFilter, storageMode, tagFilter]);
  const requestSemanticStatusRefresh = useCallback(() => {
    // AssetSemanticSettingsPanel is the single status I/O owner. Clearing the
    // mirrored parent value prevents semantic search from reusing a stale
    // identity while the panel aborts its old GET and reads a fresh snapshot.
    const nextEpoch = semanticStatusRefreshEpochRef.current + 1;
    semanticStatusRefreshEpochRef.current = nextEpoch;
    setSemanticStatus(null);
    setSemanticStatusRefreshToken(nextEpoch);
  }, []);
  const acceptSemanticStatus = useCallback((next: AssetSemanticStatus, refreshEpoch: number) => {
    if (refreshEpoch !== semanticStatusRefreshEpochRef.current
      || next.project.projectId !== semanticStatusProjectRef.current) return;
    setSemanticStatus(next);
  }, []);
  const semanticCatalog = useAssetSemanticCatalog({
    active: searchMode === 'semantic',
    projectId: assetProjectId,
    query: semanticQuery,
    filters: semanticFilters,
    status: semanticStatus,
    onConflict: requestSemanticStatusRefresh,
  });
  const browserTotal = searchMode === 'semantic' ? semanticCatalog.total : total;
  const browserLoading = searchMode === 'semantic' ? semanticCatalog.loading : catalogLoading;
  const browserError = searchMode === 'semantic' ? semanticCatalog.error : catalogError;
  const browserCacheRevision = searchMode === 'semantic' ? semanticCatalog.cacheRevision : cacheRevision;
  const browserResetKey = searchMode === 'semantic' ? semanticCatalog.resetKey : filterKey;

  const updateCachedAsset = useCallback((asset: AssetRef) => {
    let changed = false;
    const next = new Map<number, readonly AssetRef[]>();
    pagesRef.current.forEach((items, offset) => {
      const updated = items.map((item) => item.id === asset.id ? asset : item);
      if (updated.some((item, index) => item !== items[index])) changed = true;
      next.set(offset, updated);
    });
    if (changed) {
      pagesRef.current = next;
      setCacheRevision((revision) => revision + 1);
    }
  }, []);

  useEffect(() => {
    setCollectionDrafts((current) => Object.fromEntries(collections.map((collection) => [
      collection.id,
      current[collection.id] ?? collection.name,
    ])));
    if (batchCollectionSourceId && !collections.some((collection) => collection.id === batchCollectionSourceId)) setBatchCollectionSourceId('');
    if (batchCollectionId && !collections.some((collection) => collection.id === batchCollectionId)) setBatchCollectionId('');
  }, [batchCollectionId, batchCollectionSourceId, collections]);

  useEffect(() => {
    pipelineRequestEpochRef.current += 1;
    scanRequestEpochRef.current += 1;
    scanControllerRef.current?.abort();
    scanControllerRef.current = null;
    availabilityRefreshEpochRef.current += 1;
    availabilityRefreshControllerRef.current?.abort();
    availabilityRefreshControllerRef.current = null;
    pipelineSignatureRef.current = '';
    if (pipelineCatalogRefreshTimerRef.current != null) {
      window.clearTimeout(pipelineCatalogRefreshTimerRef.current);
      pipelineCatalogRefreshTimerRef.current = null;
    }
    detailGenerationRef.current += 1;
    duplicateGenerationRef.current += 1;
    rangeSelectionGenerationRef.current += 1;
    detailControllerRef.current?.abort();
    detailRefreshControllerRef.current?.abort();
    duplicateControllerRef.current?.abort();
    duplicateGroupControllerRef.current?.abort();
    duplicateGroupMemberControllerRef.current?.abort();
    sourceTreeControllerRef.current?.abort();
    lineageControllerRef.current?.abort();
    semanticDocumentControllerRef.current?.abort();
    rangeSelectionControllerRef.current?.abort();
    selectedAssetIdRef.current = null;
    selectionAnchorIndexRef.current = null;
    setQueryInput('');
    setQuery('');
    setSearchMode('keyword');
    setSemanticQueryInput('');
    setSemanticQuery('');
    setSemanticStatus(null);
    setSemanticDocuments([]);
    setSemanticDocumentsLoading(false);
    setSemanticDocumentsError('');
    setKind('');
    setStorageMode('');
    setAvailability('');
    setCollectionId('');
    setTagFilter('');
    setSourceFilter('');
    setSortOrder('created-desc');
    setCatalogRevision(0);
    setAvailableTags([]);
    setCollections([]);
    setCollectionDrafts({});
    setNewCollectionName('');
    setBatchCollectionSourceId('');
    setBatchCollectionId('');
    setSelectedAssetId(null);
    setSelectedAsset(null);
    setTagDraft('');
    setBatchSelection(EMPTY_ASSET_SELECTION);
    setBatchConflict('');
    setDuplicates([]);
    setDuplicateMode('all');
    setDuplicateHasMore(false);
    setDuplicatePages([]);
    setDuplicatePageIndex(0);
    const storage = safeLocalStorage();
    setSavedViews(loadAssetSavedFilterViews(storage, assetProjectId));
    setDuplicateGroups([]);
    setDuplicateGroupHasMore(false);
    setDuplicateGroupPages([]);
    setDuplicateGroupPageIndex(0);
    setDuplicateGroupMemberState(null);
    setLineagePages([]);
    setLineagePageIndex(0);
    setLineagePageOffset(0);
    setLineageLoading(false);
    setSourceTree(null);
    setSourceTreePages([]);
    setSourceTreePageIndex(0);
    setAssetPermissions(null);
    setPermissionScopeDraft('project');
    setPermissionGrantsDraft([]);
    setDeleteDraft(null);
    setPipelineStatus(null);
    setPipelineError('');
    setMutation((current) => current === 'scan' || current === 'availability-refresh' ? '' : current);
  }, [assetProjectId]);

  useEffect(() => {
    if (semanticCatalog.conflictRevision === semanticConflictSeenRef.current) return;
    semanticConflictSeenRef.current = semanticCatalog.conflictRevision;
    rangeSelectionGenerationRef.current += 1;
    rangeSelectionControllerRef.current?.abort();
    selectionAnchorIndexRef.current = null;
    setBatchSelection(EMPTY_ASSET_SELECTION);
    setBatchConflict('语义搜索身份已变化，旧结果、证据与选择已清空。');
    selectedAssetIdRef.current = null;
    setSelectedAssetId(null);
    setSelectedAsset(null);
    setSemanticDocuments([]);
    setSemanticDocumentsError('');
  }, [semanticCatalog.conflictRevision]);

  const requestPage = useCallback(async (
    offset: number,
    generation: number,
    requestFilters: Omit<AssetCatalogFilters, 'offset'>,
    force = false,
  ): Promise<void> => {
    const cached = pagesRef.current.get(offset);
    if (cached && !force) {
      pagesRef.current = updateAssetPageLru(pagesRef.current, offset, cached, ASSET_PAGE_CACHE_LIMIT);
      return;
    }
    if (!visiblePageOffsetsRef.current.has(offset)) return;
    if (pageControllersRef.current.has(offset)) return;
    if (pageControllersRef.current.size >= ASSET_PAGE_REQUEST_LIMIT) return;
    const controller = new AbortController();
    pageControllersRef.current.set(offset, controller);
    setCatalogLoading(true);
    try {
      const result = await api.listProjectAssets({ ...requestFilters, offset }, { signal: controller.signal });
      if (catalogGenerationRef.current !== generation || !visiblePageOffsetsRef.current.has(result.offset)
        || pageControllersRef.current.get(offset) !== controller) return;
      if (catalogRevisionRef.current != null && String(catalogRevisionRef.current) !== String(result.catalogRevision)) {
        const nextGeneration = catalogGenerationRef.current + 1;
        catalogGenerationRef.current = nextGeneration;
        pageControllersRef.current.forEach((pending) => pending.abort());
        pageControllersRef.current.clear();
        pagesRef.current = new Map();
        visiblePageOffsetsRef.current = new Set([0]);
        catalogRevisionRef.current = null;
        duplicateGenerationRef.current += 1;
        duplicateControllerRef.current?.abort();
        duplicateControllerRef.current = null;
        setDuplicatePages([]);
        setDuplicatePageIndex(0);
        setDuplicates([]);
        setDuplicateHasMore(false);
        setMutation((current) => current === 'duplicates' ? '' : current);
        setTotal(0);
        setCacheRevision((revision) => revision + 1);
        setCatalogError('素材目录 revision 已变化，正在重新加载一致快照。');
        void requestPage(0, nextGeneration, requestFilters);
        return;
      }
      catalogRevisionRef.current = result.catalogRevision;
      pagesRef.current = updateAssetPageLru(pagesRef.current, result.offset, result.items, ASSET_PAGE_CACHE_LIMIT);
      setTotal(result.total);
      setCatalogRevision(result.catalogRevision);
      setAvailableTags(result.tags);
      setCatalogError('');
      setCacheRevision((revision) => revision + 1);
    } catch (error) {
      if (!isAbortError(error) && catalogGenerationRef.current === generation) setCatalogError(error instanceof Error ? error.message : String(error));
    } finally {
      if (pageControllersRef.current.get(offset) === controller) pageControllersRef.current.delete(offset);
      if (catalogGenerationRef.current === generation) setCatalogLoading(pageControllersRef.current.size > 0);
    }
  }, []);

  const resetCatalog = useCallback((requestFilters = activeFiltersRef.current) => {
    const generation = catalogGenerationRef.current + 1;
    catalogGenerationRef.current = generation;
    pageControllersRef.current.forEach((controller) => controller.abort());
    pageControllersRef.current.clear();
    pagesRef.current = new Map();
    visiblePageOffsetsRef.current = new Set([0]);
    activeFiltersRef.current = requestFilters;
    catalogRevisionRef.current = null;
    duplicateGenerationRef.current += 1;
    duplicateControllerRef.current?.abort();
    duplicateControllerRef.current = null;
    setDuplicatePages([]);
    setDuplicatePageIndex(0);
    setDuplicates([]);
    setDuplicateHasMore(false);
    setMutation((current) => current === 'duplicates' ? '' : current);
    setTotal(0);
    setCatalogError('');
    setCatalogLoading(true);
    setCacheRevision((revision) => revision + 1);
    void requestPage(0, generation, requestFilters);
  }, [requestPage]);

  useEffect(() => {
    rangeSelectionGenerationRef.current += 1;
    rangeSelectionControllerRef.current?.abort();
    selectionAnchorIndexRef.current = null;
    setBatchSelection(EMPTY_ASSET_SELECTION);
    setBatchConflict('');
    setSelectionLoading(false);
    if (searchMode !== 'keyword') {
      catalogGenerationRef.current += 1;
      pageControllersRef.current.forEach((controller) => controller.abort());
      pageControllersRef.current.clear();
      setCatalogLoading(false);
      return undefined;
    }
    resetCatalog(filters);
    return () => {
      catalogGenerationRef.current += 1;
      pageControllersRef.current.forEach((controller) => controller.abort());
      pageControllersRef.current.clear();
      visiblePageOffsetsRef.current.clear();
    };
  }, [filterKey, filters, resetCatalog, searchMode]);

  useEffect(() => {
    let cancelled = false;
    void api.listAssetCollections(assetProjectId).then((items) => { if (!cancelled) setCollections(items); }).catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [assetProjectId]);

  useEffect(() => {
    semanticDocumentControllerRef.current?.abort();
    setSemanticDocuments([]);
    setSemanticDocumentsError('');
    setSemanticDocumentsLoading(false);
    if (searchMode !== 'semantic' || !selectedAssetId || !semanticStatus?.project.activeGeneration) return undefined;
    const controller = new AbortController();
    semanticDocumentControllerRef.current = controller;
    const expectedAssetId = selectedAssetId;
    setSemanticDocumentsLoading(true);
    void api.getProjectAssetSemanticDocuments(expectedAssetId, assetProjectId, { signal: controller.signal }).then((documents) => {
      if (controller.signal.aborted || selectedAssetIdRef.current !== expectedAssetId) return;
      setSemanticDocuments(documents);
    }).catch((error) => {
      if (!controller.signal.aborted && !isAbortError(error) && selectedAssetIdRef.current === expectedAssetId) {
        setSemanticDocumentsError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (!controller.signal.aborted && selectedAssetIdRef.current === expectedAssetId) setSemanticDocumentsLoading(false);
    });
    return () => controller.abort();
  }, [assetProjectId, searchMode, selectedAssetId, semanticStatus?.project.activeGeneration]);

  const ensureRange = useCallback((startIndex: number, endIndex: number) => {
    const generation = catalogGenerationRef.current;
    const requestFilters = activeFiltersRef.current;
    const offsets = assetPageOffsetsForRange(startIndex, endIndex, ASSET_PAGE_SIZE);
    if (!offsets.length) return;
    const visibleOffsets = new Set(offsets);
    visiblePageOffsetsRef.current = visibleOffsets;
    pageControllersRef.current.forEach((controller, offset) => {
      if (visibleOffsets.has(offset)) return;
      controller.abort();
      pageControllersRef.current.delete(offset);
    });
    const anchor = (Math.max(0, startIndex) + Math.max(startIndex, endIndex - 1)) / 2;
    offsets.sort((left, right) => Math.abs(left + ASSET_PAGE_SIZE / 2 - anchor) - Math.abs(right + ASSET_PAGE_SIZE / 2 - anchor));
    offsets.forEach((offset) => {
      void requestPage(offset, generation, requestFilters);
    });
  }, [requestPage]);

  const getItem = useCallback((index: number) => readAssetPageItem(pagesRef.current, index, ASSET_PAGE_SIZE), [cacheRevision]);
  const browserGetItem = searchMode === 'semantic' ? semanticCatalog.getItem : getItem;
  const browserEnsureRange = searchMode === 'semantic' ? semanticCatalog.ensureRange : ensureRange;

  const isBatchSelected = useCallback((assetId: string) => isAssetBatchSelected(batchSelection, assetId), [batchSelection]);

  const toggleBatchSelection = useCallback((asset: AssetRef, index: number) => {
    selectionAnchorIndexRef.current = index;
    setBatchConflict('');
    setBatchSelection((current) => toggleAssetBatchSelection(current, asset));
  }, []);

  const selectBatchRange = useCallback(async (targetIndex: number, additive: boolean, keyboardAnchorIndex?: number) => {
    if (selectionAnchorIndexRef.current == null && keyboardAnchorIndex != null) selectionAnchorIndexRef.current = keyboardAnchorIndex;
    const anchor = selectionAnchorIndexRef.current ?? targetIndex;
    const startIndex = Math.max(0, Math.min(anchor, targetIndex));
    const endIndex = Math.min(browserTotal - 1, Math.max(anchor, targetIndex));
    if (endIndex < startIndex) return;
    const length = endIndex - startIndex + 1;
    if (length > EXPLICIT_SELECTION_LIMIT) {
      setBatchConflict(`范围选择最多 ${EXPLICIT_SELECTION_LIMIT} 项；如需处理 ${length} 项，请使用“全选当前筛选”。`);
      return;
    }
    const generation = rangeSelectionGenerationRef.current + 1;
    rangeSelectionGenerationRef.current = generation;
    rangeSelectionControllerRef.current?.abort();
    const controller = new AbortController();
    rangeSelectionControllerRef.current = controller;
    const catalogGeneration = catalogGenerationRef.current;
    const expectedCatalogRevision = catalogRevision;
    const requestFilters = activeFiltersRef.current;
    setSelectionLoading(true);
    setBatchConflict('');
    try {
      if (searchMode === 'semantic') {
        const assets: AssetRef[] = [];
        for (let index = startIndex; index <= endIndex; index += 1) {
          const asset = browserGetItem(index);
          if (!asset) throw new Error('语义范围中仍有未加载项；请先滚动到该范围后重试。');
          assets.push(asset);
        }
        if (controller.signal.aborted || generation !== rangeSelectionGenerationRef.current) return;
        setBatchSelection((current) => selectAssetBatchRange(current, assets, additive));
        selectionAnchorIndexRef.current = anchor;
        return;
      }
      const offsets = assetPageOffsetsForRange(startIndex, endIndex + 1, ASSET_PAGE_SIZE);
      const pages = new Map<number, readonly AssetRef[]>();
      for (let offsetIndex = 0; offsetIndex < offsets.length; offsetIndex += ASSET_PAGE_REQUEST_LIMIT) {
        const group = offsets.slice(offsetIndex, offsetIndex + ASSET_PAGE_REQUEST_LIMIT);
        const results = await Promise.all(group.map(async (offset) => {
          const cached = pagesRef.current.get(offset);
          if (cached) return { offset, items: cached, catalogRevision: expectedCatalogRevision };
          return api.listProjectAssets({ ...requestFilters, offset }, { signal: controller.signal });
        }));
        if (controller.signal.aborted || generation !== rangeSelectionGenerationRef.current
          || catalogGeneration !== catalogGenerationRef.current) return;
        results.forEach((result) => {
          if (String(result.catalogRevision) !== String(expectedCatalogRevision)) {
            throw new api.ApiRequestError('素材目录已变化，请重新范围选择', 409, { expectedCatalogRevision, actualCatalogRevision: result.catalogRevision });
          }
          pages.set(result.offset, result.items);
        });
      }
      const assets: AssetRef[] = [];
      for (let index = startIndex; index <= endIndex; index += 1) {
        const asset = readAssetPageItem(pages, index, ASSET_PAGE_SIZE) || getItem(index);
        if (!asset) throw new Error(`无法读取范围内第 ${index + 1} 项`);
        assets.push(asset);
      }
      if (generation !== rangeSelectionGenerationRef.current || catalogGeneration !== catalogGenerationRef.current) return;
      setBatchSelection((current) => selectAssetBatchRange(current, assets, additive));
      selectionAnchorIndexRef.current = anchor;
    } catch (error) {
      if (!isAbortError(error)) setBatchConflict(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === rangeSelectionGenerationRef.current) setSelectionLoading(false);
    }
  }, [browserGetItem, browserTotal, catalogRevision, getItem, searchMode]);

  const selectCurrentFilter = useCallback(() => {
    if (!canUseAssetQuerySelection(searchMode)) {
      setBatchConflict('自然语言结果绑定具体索引代次，只支持逐项或已加载范围的显式选择。');
      return;
    }
    if (!browserTotal) return;
    if (browserTotal > QUERY_SELECTION_LIMIT) {
      setBatchConflict(`当前筛选有 ${browserTotal} 项，单次查询批量上限为 ${QUERY_SELECTION_LIMIT} 项；请继续缩小筛选范围。`);
      return;
    }
    setBatchSelection(queryAssetSelection({
      query: batchFilterSnapshot,
      filterKey,
      catalogRevision,
      total: browserTotal,
    }));
    setBatchConflict('');
  }, [batchFilterSnapshot, browserTotal, catalogRevision, filterKey, searchMode]);

  const clearBatchSelection = useCallback(() => {
    rangeSelectionGenerationRef.current += 1;
    rangeSelectionControllerRef.current?.abort();
    selectionAnchorIndexRef.current = null;
    setBatchSelection(EMPTY_ASSET_SELECTION);
    setBatchConflict('');
    setSelectionLoading(false);
  }, []);

  const changeSearchMode = useCallback((mode: AssetSearchMode) => {
    if (mode === searchMode) return;
    clearBatchSelection();
    setSearchMode(mode);
    setCatalogError('');
    setSemanticDocuments([]);
    setSemanticDocumentsError('');
  }, [clearBatchSelection, searchMode]);

  const submitSemanticSearch = useCallback(() => {
    const normalized = normalizeAssetSemanticQuery(semanticQueryInput);
    clearBatchSelection();
    selectedAssetIdRef.current = null;
    setSelectedAssetId(null);
    setSelectedAsset(null);
    setSemanticDocuments([]);
    setSemanticDocumentsError('');
    if (normalized === semanticQuery) semanticCatalog.reset();
    else setSemanticQuery(normalized);
  }, [clearBatchSelection, semanticCatalog, semanticQuery, semanticQueryInput]);

  const refreshSelectedAsset = useCallback(async () => {
    const assetId = selectedAssetIdRef.current;
    if (!assetId) return;
    if (selectedMutationTokensRef.current.get(assetId)?.size) return;
    const revision = detailGenerationRef.current;
    detailRefreshControllerRef.current?.abort();
    const controller = new AbortController();
    detailRefreshControllerRef.current = controller;
    try {
      const freshAsset = await api.getProjectAsset(assetId, { signal: controller.signal });
      if (selectedAssetIdRef.current !== assetId || detailGenerationRef.current !== revision
        || selectedMutationTokensRef.current.get(assetId)?.size) return;
      setSelectedAsset(freshAsset);
      setTagDraft((freshAsset.tags || []).join(', '));
      updateCachedAsset(freshAsset);
    } catch (error) {
      if (!isAbortError(error) && selectedAssetIdRef.current === assetId && detailGenerationRef.current === revision) setDetailError(error instanceof Error ? error.message : String(error));
    }
  }, [updateCachedAsset]);

  const runSelectedMutationRequest = useCallback(async <T,>(targetId: string, work: () => Promise<T>): Promise<{ value: T; revision: number }> => {
    const token = selectedMutationSequenceRef.current + 1;
    selectedMutationSequenceRef.current = token;
    const tokens = selectedMutationTokensRef.current.get(targetId) || new Set<number>();
    tokens.add(token);
    selectedMutationTokensRef.current.set(targetId, tokens);
    let revision = detailGenerationRef.current;
    if (isCurrentAssetSelection(selectedAssetIdRef.current, targetId)) {
      revision = detailGenerationRef.current + 1;
      detailGenerationRef.current = revision;
      detailControllerRef.current?.abort();
      detailRefreshControllerRef.current?.abort();
      setDetailLoading(false);
    }
    try {
      return { value: await work(), revision };
    } finally {
      const current = selectedMutationTokensRef.current.get(targetId);
      current?.delete(token);
      if (current && !current.size) {
        selectedMutationTokensRef.current.delete(targetId);
        if (isCurrentAssetSelection(selectedAssetIdRef.current, targetId) && detailGenerationRef.current === revision) {
          window.queueMicrotask(() => { void refreshSelectedAsset(); });
        }
      }
    }
  }, [refreshSelectedAsset]);

  const canApplySelectedMutation = useCallback((targetId: string, revision: number) => (
    isCurrentAssetSelection(selectedAssetIdRef.current, targetId) && detailGenerationRef.current === revision
  ), []);

  const refreshVisibleCatalogPages = useCallback(() => {
    const generation = catalogGenerationRef.current;
    const requestFilters = activeFiltersRef.current;
    const offsets = [...visiblePageOffsetsRef.current].slice(0, ASSET_PAGE_REQUEST_LIMIT);
    const retainedPages = new Map<number, readonly AssetRef[]>();
    offsets.forEach((offset) => {
      const cached = pagesRef.current.get(offset);
      if (cached) retainedPages.set(offset, cached);
    });
    if (retainedPages.size !== pagesRef.current.size) {
      pagesRef.current = retainedPages;
      setCacheRevision((revision) => revision + 1);
    }
    offsets.forEach((offset) => {
      const existing = pageControllersRef.current.get(offset);
      if (existing) {
        existing.abort();
        pageControllersRef.current.delete(offset);
      }
      void requestPage(offset, generation, requestFilters, true);
    });
  }, [requestPage]);

  const schedulePipelineCatalogRefresh = useCallback(() => {
    if (pipelineCatalogRefreshTimerRef.current != null) window.clearTimeout(pipelineCatalogRefreshTimerRef.current);
    pipelineCatalogRefreshTimerRef.current = window.setTimeout(() => {
      pipelineCatalogRefreshTimerRef.current = null;
      refreshVisibleCatalogPages();
    }, 200);
  }, [refreshVisibleCatalogPages]);

  const loadPipelineStatus = useCallback(async (signal?: AbortSignal) => {
    const expectedProjectId = assetProjectId;
    const requestEpoch = pipelineRequestEpochRef.current + 1;
    pipelineRequestEpochRef.current = requestEpoch;
    const next = normalizePipelineStatus(await api.getProjectAssetPipelineStatus(expectedProjectId, { signal }));
    if (signal?.aborted
      || requestEpoch !== pipelineRequestEpochRef.current
      || pipelineProjectRef.current !== expectedProjectId
      || next.projectId !== expectedProjectId
      || next.scan.projectId !== expectedProjectId
      || next.previews.projectId !== expectedProjectId) return null;
    setPipelineStatus(next);
    setPipelineError('');
    const signature = assetPipelineSignature(next);
    if (shouldInvalidateAssetCatalog(pipelineSignatureRef.current, signature)) {
      void refreshSelectedAsset();
      schedulePipelineCatalogRefresh();
    }
    pipelineSignatureRef.current = signature;
    return next;
  }, [assetProjectId, refreshSelectedAsset, schedulePipelineCatalogRefresh]);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let controller: AbortController | null = null;
    const poll = async () => {
      controller?.abort();
      controller = new AbortController();
      let delay = document.visibilityState === 'visible' ? 2500 : 5000;
      try {
        const status = await loadPipelineStatus(controller.signal);
        if (status && pipelineIsActive(status)) delay = document.visibilityState === 'visible' ? 750 : 3000;
      } catch (error) {
        if (!isAbortError(error)) setPipelineError(error instanceof Error ? error.message : String(error));
        delay = 5000;
      }
      if (!stopped) timer = window.setTimeout(poll, delay);
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [loadPipelineStatus]);

  useEffect(() => () => {
    detailGenerationRef.current += 1;
    detailControllerRef.current?.abort();
    detailRefreshControllerRef.current?.abort();
    rangeSelectionControllerRef.current?.abort();
    duplicateControllerRef.current?.abort();
    duplicateGroupControllerRef.current?.abort();
    duplicateGroupMemberControllerRef.current?.abort();
    sourceTreeControllerRef.current?.abort();
    lineageControllerRef.current?.abort();
    semanticDocumentControllerRef.current?.abort();
    pipelineRequestEpochRef.current += 1;
    scanRequestEpochRef.current += 1;
    scanControllerRef.current?.abort();
    availabilityRefreshEpochRef.current += 1;
    availabilityRefreshControllerRef.current?.abort();
    if (pipelineCatalogRefreshTimerRef.current != null) window.clearTimeout(pipelineCatalogRefreshTimerRef.current);
  }, []);

  const selectAsset = useCallback((asset: AssetRef) => {
    const generation = detailGenerationRef.current + 1;
    detailGenerationRef.current = generation;
    detailControllerRef.current?.abort();
    availabilityRefreshEpochRef.current += 1;
    availabilityRefreshControllerRef.current?.abort();
    availabilityRefreshControllerRef.current = null;
    duplicateGenerationRef.current += 1;
    duplicateControllerRef.current?.abort();
    duplicateControllerRef.current = null;
    sourceTreeControllerRef.current?.abort();
    lineageControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    selectedAssetIdRef.current = asset.id;
    setSelectedAssetId(asset.id);
    setSelectedAsset(asset);
    setTagDraft((asset.tags || []).join(', '));
    setDuplicates([]);
    setDuplicateHasMore(false);
    setDuplicatePages([]);
    setDuplicatePageIndex(0);
    setMutation((current) => current === 'duplicates' ? '' : current);
    setMutation((current) => current === 'availability-refresh' ? '' : current);
    setLineagePages([]);
    setLineagePageIndex(0);
    setLineagePageOffset(0);
    setLineageLoading(false);
    setSourceTree(null);
    setSourceTreePages([]);
    setSourceTreePageIndex(0);
    setAssetPermissions(null);
    setPermissionScopeDraft('project');
    setPermissionGrantsDraft([]);
    setDetailError('');
    setDetailLoading(true);
    void Promise.all([
      api.getProjectAsset(asset.id, { signal: controller.signal }),
      api.listProjectAssetLineage(asset.id, { limit: 50, signal: controller.signal }),
      api.getProjectAssetSourceTree(asset.id, { direction: 'both', maxDepth: 8, maxNodes: ASSET_SOURCE_NODE_LIMIT, signal: controller.signal }),
      api.getProjectAssetPermissions(asset.id, { signal: controller.signal }),
    ]).then(([freshAsset, freshLineage, freshSourceTree, freshPermissions]) => {
      if (detailGenerationRef.current !== generation) return;
      const normalizedSourceTree = normalizeAssetSourceTree(freshSourceTree);
      setSelectedAsset(freshAsset);
      setTagDraft((freshAsset.tags || []).join(', '));
      setLineagePages([freshLineage]);
      setLineagePageIndex(0);
      setLineagePageOffset(0);
      setSourceTree(normalizedSourceTree);
      setSourceTreePages([normalizedSourceTree]);
      setSourceTreePageIndex(0);
      setAssetPermissions(freshPermissions);
      setPermissionScopeDraft(freshPermissions.scope);
      setPermissionGrantsDraft(freshPermissions.grants);
      updateCachedAsset(freshAsset);
    }).catch((error) => {
      if (!isAbortError(error) && detailGenerationRef.current === generation) setDetailError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (detailGenerationRef.current === generation) setDetailLoading(false);
    });
  }, [updateCachedAsset]);

  const activateAssetAtIndex = useCallback((asset: AssetRef, index: number, selectionModified: boolean) => {
    if (!selectionModified) selectionAnchorIndexRef.current = index;
    selectAsset(asset);
  }, [selectAsset]);

  const runMutation = useCallback(async (name: string, work: () => Promise<void>) => {
    setMutation(name);
    setMessage('');
    try { await work(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setMutation((current) => current === name ? '' : current); }
  }, []);

  const reloadCollections = useCallback(async (): Promise<AssetCollection[]> => {
    const items = await api.listAssetCollections(assetProjectId);
    setCollections(items);
    return items;
  }, [assetProjectId]);

  const saveCurrentFilterView = () => {
    if (searchMode === 'semantic') {
      setMessage('自然语言结果绑定当前索引代次，不写入关键词筛选视图。');
      return;
    }
    const storage = safeLocalStorage();
    if (!storage) return;
    try {
      const next = saveAssetSavedFilterView(storage, assetProjectId, {
        name: savedViewName,
        filters: batchFilterSnapshot,
      });
      setSavedViews(next);
      setSavedViewName('');
      setMessage('已保存当前筛选视图；批量选择不会写入视图。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const applySavedFilterView = (view: AssetSavedFilterView) => {
    const next = view.filters;
    setSearchMode('keyword');
    setQueryInput(next.query || '');
    setQuery(next.query || '');
    setKind(next.kind || '');
    setStorageMode(next.storageMode || '');
    setAvailability(next.availability || '');
    setCollectionId(next.collectionId || '');
    setTagFilter(next.tag || '');
    setSourceFilter(next.source || '');
    setSortOrder(next.sort || 'created-desc');
    setMessage(`已应用筛选视图“${view.name}”；选择状态已清空。`);
  };

  const removeSavedFilterView = (view: AssetSavedFilterView) => {
    const storage = safeLocalStorage();
    if (!storage) return;
    try {
      setSavedViews(deleteAssetSavedFilterView(storage, assetProjectId, view.id));
      setMessage(`已删除筛选视图“${view.name}”。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const selectedBatchCount = assetBatchSelectionCount(batchSelection);
  const batchSelectionStale = !assetSelectionCatalogIsCurrent(batchSelection, catalogRevision);

  const applyBatchMutation = useCallback(async (name: string, mutations: AssetBatchMutationSet) => {
    if (!assetBatchSelectionCount(batchSelection)) {
      setBatchConflict('请先勾选素材或全选当前筛选。');
      return;
    }
    if (batchSelection.mode === 'explicit' && batchSelection.ids.length > EXPLICIT_SELECTION_LIMIT) {
      setBatchConflict(`显式批量操作最多 ${EXPLICIT_SELECTION_LIMIT} 项，请改用当前筛选全选。`);
      return;
    }
    setMutation(`batch:${name}`);
    setBatchConflict('');
    setMessage('');
    try {
      const result = await api.applyProjectAssetBatch({
        projectId: assetProjectId,
        target: buildAssetBatchTarget(batchSelection),
        mutations,
        idempotencyKey: idempotencyKey(`asset-batch-${name}`),
      });
      clearBatchSelection();
      setMessage(`批量操作完成：已更新 ${result.affected} 项；不会自动合并或删除素材。`);
      resetCatalog(activeFiltersRef.current);
      void refreshSelectedAsset();
      if (mutations.collections) setCollections(await api.listAssetCollections(assetProjectId));
    } catch (error) {
      if (error instanceof api.ApiRequestError && error.status === 409) {
        setBatchConflict(`409 版本冲突：${error.message}。目录或素材已变化，请刷新后重新选择。`);
      } else setBatchConflict(error instanceof Error ? error.message : String(error));
    } finally {
      setMutation('');
    }
  }, [assetProjectId, batchSelection, clearBatchSelection, refreshSelectedAsset, resetCatalog]);

  const applyBatchTags = () => {
    const values = parseValues(batchTagDraft);
    if (!values.length && batchTagMode !== 'replace') {
      setBatchConflict('追加或移除标签时至少输入一个标签。');
      return;
    }
    void applyBatchMutation('tags', { tags: { mode: batchTagMode, values } });
  };

  const applyBatchCollection = () => {
    if (batchCollectionMode === 'move') {
      if (!batchCollectionSourceId || !batchCollectionId) {
        setBatchConflict('移动集合时必须同时选择来源集合和目标集合。');
        return;
      }
      if (batchCollectionSourceId === batchCollectionId) {
        setBatchConflict('来源集合和目标集合不能相同。');
        return;
      }
      void applyBatchMutation('collections', {
        collections: {
          mode: 'move',
          fromCollectionIds: [batchCollectionSourceId],
          toCollectionId: batchCollectionId,
        },
      });
      return;
    }
    if (!batchCollectionId) {
      setBatchConflict('请选择集合。');
      return;
    }
    void applyBatchMutation('collections', { collections: { mode: batchCollectionMode, values: [batchCollectionId] } });
  };

  const addBatchGrant = () => {
    const principalId = grantMemberDraft.trim();
    if (!principalId) {
      setBatchConflict(`${grantPrincipalType === 'member' ? '成员' : '角色'} ID 不能为空。`);
      return;
    }
    setBatchGrants((current) => [
      ...current.filter((grant) => grant.principalType !== grantPrincipalType || grant.principalId !== principalId),
      { principalType: grantPrincipalType, principalId, role: grantRoleDraft },
    ]);
    setGrantMemberDraft('');
    setBatchConflict('');
  };

  const applyBatchAccess = () => {
    if (batchVisibility === 'restricted' && !batchGrants.length) {
      setBatchConflict('受限权限至少需要一个成员/角色授权，避免创建不可访问素材。');
      return;
    }
    void applyBatchMutation('access', { access: { visibility: batchVisibility, grants: batchGrants } });
  };

  const saveTags = () => runMutation('tags', async () => {
    const targetAsset = selectedAsset;
    if (!targetAsset) return;
    const targetId = targetAsset.id;
    const targetTags = tagDraft.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean);
    const { value: updated, revision } = await runSelectedMutationRequest(targetId, () => api.setProjectAssetTags(
      targetId,
      targetTags,
      assetOrganizationRevision(targetAsset),
    ));
    if (canApplySelectedMutation(targetId, revision)) {
      updateCachedAsset(updated);
      setSelectedAsset(updated);
      setTagDraft((updated.tags || []).join(', '));
      setMessage('素材标签已保存。');
    }
    clearBatchSelection();
    resetCatalog(activeFiltersRef.current);
  });

  const createCollection = () => runMutation('collection-create', async () => {
    const name = newCollectionName.trim();
    if (!name) throw new Error('集合名称不能为空');
    const collection = await api.createAssetCollection({ projectId: assetProjectId, name });
    setNewCollectionName('');
    await reloadCollections();
    setBatchCollectionId(collection.id);
    clearBatchSelection();
    resetCatalog(activeFiltersRef.current);
    setMessage(`已创建集合“${collection.name}”。`);
  });

  const renameCollection = (collection: AssetCollection) => runMutation(`collection-rename:${collection.id}`, async () => {
    const name = String(collectionDrafts[collection.id] || '').trim();
    if (!name) throw new Error('集合名称不能为空');
    try {
      const updated = await api.updateAssetCollection(collection.id, {
        projectId: assetProjectId,
        name,
        expectedRevision: collection.revision,
      });
      setCollections((current) => current.map((item) => item.id === updated.id ? updated : item));
      clearBatchSelection();
      resetCatalog(activeFiltersRef.current);
      setMessage(`已将集合改名为“${updated.name}”。`);
    } catch (error) {
      if (error instanceof api.ApiRequestError && error.status === 409) {
        await reloadCollections();
        clearBatchSelection();
        resetCatalog(activeFiltersRef.current);
        throw new Error(`409 集合版本冲突：${error.message}；已载入最新集合版本`);
      }
      throw error;
    }
  });

  const removeCollection = (collection: AssetCollection) => runMutation(`collection-delete:${collection.id}`, async () => {
    try {
      await api.deleteAssetCollection(collection.id, collection.revision, assetProjectId);
    } catch (error) {
      if (error instanceof api.ApiRequestError && error.status === 409) {
        await reloadCollections();
        clearBatchSelection();
        resetCatalog(activeFiltersRef.current);
        throw new Error(`409 集合版本冲突：${error.message}；已载入最新集合版本`);
      }
      throw error;
    }
    if (collectionId === collection.id) setCollectionId('');
    if (batchCollectionId === collection.id) setBatchCollectionId('');
    await reloadCollections();
    clearBatchSelection();
    resetCatalog(activeFiltersRef.current);
    setMessage(`已删除集合“${collection.name}”；素材本身未删除。`);
  });

  const toggleCollection = (targetCollectionId: string) => runMutation(`collection:${targetCollectionId}`, async () => {
    const targetAsset = selectedAsset;
    if (!targetAsset) return;
    const targetCollection = collections.find((collection) => collection.id === targetCollectionId);
    if (!targetCollection) throw new Error('集合已不存在，请刷新后重试');
    const targetId = targetAsset.id;
    const removing = Boolean(targetAsset.collectionIds?.includes(targetCollectionId));
    const expectedRevision = targetCollection.revision;
    try {
      const { value: updated, revision } = await runSelectedMutationRequest(targetId, () => removing
        ? api.removeAssetFromCollection(targetCollectionId, targetId, expectedRevision)
        : api.addAssetToCollection(targetCollectionId, targetId, expectedRevision));
      if (canApplySelectedMutation(targetId, revision)) {
        updateCachedAsset(updated);
        setSelectedAsset(updated);
      }
    } catch (error) {
      if (error instanceof api.ApiRequestError && error.status === 409) {
        await reloadCollections();
        clearBatchSelection();
        resetCatalog(activeFiltersRef.current);
        throw new Error(`409 集合版本冲突：${error.message}；已载入最新集合版本`);
      }
      throw error;
    }
    await reloadCollections();
    clearBatchSelection();
    resetCatalog(activeFiltersRef.current);
  });

  const linkLocalAssets = () => runMutation('link', async () => {
    const picker = typeof window !== 'undefined' ? window.t8pc?.pickMediaFiles : undefined;
    if (!picker) throw new Error('链接本机素材仅在 Electron 桌面版可用');
    const picked = await picker({ multiple: true, kinds: ['image', 'video', 'audio', 'model3d'] });
    if (!picked?.success) throw new Error(picked?.message || '选择本机素材失败');
    const paths = (picked.files || []).map((file) => file.path).filter(Boolean);
    if (!paths.length) return;
    const linked = await api.linkProjectAssets({ paths, projectId: assetProjectId, canvasId: canvasId || undefined });
    setMessage(`已链接 ${linked.length} 个本机素材；不会复制或删除源文件。`);
    resetCatalog();
    await loadPipelineStatus();
  });

  const scanAssets = () => runMutation('scan', async () => {
    const expectedProjectId = assetProjectId;
    const requestEpoch = scanRequestEpochRef.current + 1;
    scanRequestEpochRef.current = requestEpoch;
    scanControllerRef.current?.abort();
    const controller = new AbortController();
    scanControllerRef.current = controller;
    setMessage('扫描已开始；可继续浏览素材，进度与预览队列显示在上方。');
    void loadPipelineStatus();
    try {
      const result = await api.scanProjectAssets(expectedProjectId, { signal: controller.signal });
      if (controller.signal.aborted
        || requestEpoch !== scanRequestEpochRef.current
        || pipelineProjectRef.current !== expectedProjectId
        || result.projectId !== expectedProjectId) return;
      setMessage(`扫描完成：${result.indexed}/${result.total}，失败 ${result.failed}，新增缺失 ${result.availability?.missing || 0}，恢复 ${result.availability?.restored || 0}，源内容变化 ${result.availability?.sourceChanged || 0}，暂不能判定 ${result.availability?.indeterminate || 0}`);
      resetCatalog();
      await loadPipelineStatus();
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)
        || requestEpoch !== scanRequestEpochRef.current
        || pipelineProjectRef.current !== expectedProjectId) return;
      if (error instanceof api.ApiRequestError && error.status === 507) {
        throw new Error('项目数据库存储空间不足，扫描结果未完整提交；清理空间后可再次手动扫描。');
      }
      throw error;
    } finally {
      if (scanControllerRef.current === controller) scanControllerRef.current = null;
    }
  });

  const refreshSelectedAssetAvailability = () => runMutation('availability-refresh', async () => {
    const targetAsset = selectedAsset;
    const expectedProjectId = assetProjectId;
    const input = frozenAssetAvailabilityInput(targetAsset, expectedProjectId, catalogRevisionRef.current);
    if (!targetAsset || !input) throw new Error('当前素材缺少可校验的本机源文件冻结身份，请先刷新素材详情。');
    const targetId = targetAsset.id;
    const expectedSelectionRevision = detailGenerationRef.current + 1;
    const requestEpoch = availabilityRefreshEpochRef.current + 1;
    availabilityRefreshEpochRef.current = requestEpoch;
    availabilityRefreshControllerRef.current?.abort();
    const controller = new AbortController();
    availabilityRefreshControllerRef.current = controller;
    try {
      const { value: result, revision } = await runSelectedMutationRequest(targetId, () => (
        api.refreshProjectAssetAvailability(targetId, input, { signal: controller.signal })
      ));
      if (controller.signal.aborted
        || requestEpoch !== availabilityRefreshEpochRef.current
        || pipelineProjectRef.current !== expectedProjectId
        || result.projectId !== expectedProjectId
        || !canApplySelectedMutation(targetId, revision)) return;
      if (result.changed) resetCatalog(activeFiltersRef.current);
      const corruptionPreserved = !result.changed
        && (targetAsset.availability === 'corrupt'
          || String(targetAsset.metadata?.health || '').toLowerCase() === 'corrupt');
      if (corruptionPreserved) setMessage('校验完成：已保留既有素材损坏判定；只有显式重新索引新的内容版本才能替换该判定。');
      else if (result.state === 'missing') setMessage('校验完成：本机源文件不存在，素材已标记为缺失。');
      else if (result.state === 'source-changed') setMessage('校验完成：源文件内容已变化，旧素材保持缺失；请重新索引以创建新的内容版本。');
      else if (result.state === 'indeterminate') setMessage('暂时无法可靠判定源文件状态，未修改素材记录；请检查权限或稍后再次手动校验。');
      else setMessage(result.changed ? '校验完成：冻结内容一致，素材已恢复为可用。' : '校验完成：冻结内容一致，素材状态无需修改。');
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)
        || requestEpoch !== availabilityRefreshEpochRef.current
        || pipelineProjectRef.current !== expectedProjectId
        || !canApplySelectedMutation(targetId, expectedSelectionRevision)) return;
      if (error instanceof api.ApiRequestError && error.status === 409) {
        resetCatalog(activeFiltersRef.current);
        throw new Error('素材或目录已变化，已刷新当前只读快照；请确认后再次手动校验，系统不会自动重放写请求。');
      }
      if (error instanceof api.ApiRequestError && error.status === 507) {
        throw new Error('项目数据库存储空间不足，源文件状态未更新；清理空间后可再次手动校验。');
      }
      throw error;
    } finally {
      if (availabilityRefreshControllerRef.current === controller) availabilityRefreshControllerRef.current = null;
    }
  });

  const retryPreview = () => runMutation('preview-retry', async () => {
    const targetAsset = selectedAsset;
    if (!targetAsset) return;
    const targetId = targetAsset.id;
    const { revision } = await runSelectedMutationRequest(targetId, () => api.retryProjectAssetPreview(targetId));
    const updated: AssetRef = { ...targetAsset, metadata: { ...(targetAsset.metadata || {}), previewStatus: 'queued', previewError: '' } };
    if (canApplySelectedMutation(targetId, revision)) {
      updateCachedAsset(updated);
      setSelectedAsset(updated);
      setMessage('预览重试已进入有界后台队列。');
    }
    refreshVisibleCatalogPages();
    await loadPipelineStatus();
  });

  const removeIndex = () => runMutation('remove-index', async () => {
    const targetAsset = selectedAsset;
    if (!targetAsset) return;
    const targetId = targetAsset.id;
    const { revision } = await runSelectedMutationRequest(targetId, () => api.removeProjectAssetIndex(targetId));
    setMessage(`已移除 ${targetAsset.filename} 的索引；原文件未删除。`);
    if (canApplySelectedMutation(targetId, revision)) {
      selectedAssetIdRef.current = null;
      setSelectedAssetId(null);
      setSelectedAsset(null);
      setLineagePages([]);
      setLineagePageIndex(0);
      setLineagePageOffset(0);
      setLineageLoading(false);
      setSourceTree(null);
      setSourceTreePages([]);
      setSourceTreePageIndex(0);
      setAssetPermissions(null);
    }
    refreshVisibleCatalogPages();
  });

  const confirmDeleteFile = () => runMutation('delete-file', async () => {
    const targetDraft = deleteDraft;
    if (!targetDraft || targetDraft.confirmation !== targetDraft.asset.filename) throw new Error('请输入完整文件名确认删除原文件');
    const targetId = targetDraft.asset.id;
    const { value: result, revision } = await runSelectedMutationRequest(targetId, () => api.deleteProjectAssetFile(
      targetId,
      targetDraft.confirmation,
      {
        entityUid: targetDraft.asset.entityUid,
        contentRevision: Number(targetDraft.asset.contentRevision),
        contentHash: String(targetDraft.asset.contentHash || ''),
      },
    ));
    if (result.persistenceWarning?.phase === 'cas-record-finalize') {
      setMessage(`索引已移除，原文件记录对账待完成：${targetDraft.asset.filename}`);
    } else if (result.persistenceWarning) {
      setMessage(`索引已移除，原文件清理待完成：${targetDraft.asset.filename}`);
    } else if (result.blobRetained) {
      setMessage(`索引已移除，共享原文件仍被其他素材使用：${targetDraft.asset.filename}`);
    } else {
      setMessage(`已删除原文件并移除索引：${targetDraft.asset.filename}`);
    }
    setDeleteDraft((current) => current?.asset.id === targetId ? null : current);
    if (canApplySelectedMutation(targetId, revision)) {
      selectedAssetIdRef.current = null;
      setSelectedAssetId(null);
      setSelectedAsset(null);
      setLineagePages([]);
      setLineagePageIndex(0);
      setLineagePageOffset(0);
      setLineageLoading(false);
      setSourceTree(null);
      setSourceTreePages([]);
      setSourceTreePageIndex(0);
      setAssetPermissions(null);
    }
    refreshVisibleCatalogPages();
  });

  const showDuplicatePage = useCallback((index: number) => {
    const page = duplicatePages[index];
    if (!page) return;
    duplicatePageIndexRef.current = index;
    setDuplicatePageIndex(index);
    setDuplicates(page.items);
    setDuplicateHasMore(page.hasMore);
  }, [duplicatePages]);

  const loadDuplicates = useCallback(async (mode: 'all' | AssetDuplicateKind = duplicateMode, nextPage = false) => {
    const targetAsset = selectedAsset;
    if (!targetAsset) return;
    const targetId = targetAsset.id;
    const sameMode = mode === duplicateMode;
    if (nextPage && sameMode) {
      const cached = duplicatePages[duplicatePageIndex + 1];
      if (cached) {
        duplicatePageIndexRef.current = duplicatePageIndex + 1;
        setDuplicatePageIndex(duplicatePageIndex + 1);
        setDuplicates(cached.items);
        setDuplicateHasMore(cached.hasMore);
        return;
      }
    }
    const currentPage = sameMode ? duplicatePages[duplicatePageIndex] : undefined;
    const requestCursor = nextPage ? currentPage?.cursor : undefined;
    if (nextPage && !requestCursor) return;
    const targetRevision = detailGenerationRef.current;
    const generation = duplicateGenerationRef.current + 1;
    duplicateGenerationRef.current = generation;
    duplicateControllerRef.current?.abort();
    const controller = new AbortController();
    duplicateControllerRef.current = controller;
    setMutation('duplicates');
    setMessage('');
    try {
      if (!nextPage && mode !== 'exact') {
        const expectedCatalogRevision = catalogRevisionRef.current;
        if (expectedCatalogRevision == null) {
          throw new Error('素材目录正在同步，请稍后重新检测重复候选。');
        }
        await api.refreshProjectAssetDuplicates(targetId, {
          expectedCatalogRevision,
          signal: controller.signal,
        });
      }
      const page = await api.listProjectAssetDuplicates(targetId, {
        mode,
        limit: 25,
        cursor: requestCursor || undefined,
        signal: controller.signal,
      });
      if (catalogRevisionRef.current == null
        || String(page.catalogRevision) !== String(catalogRevisionRef.current)) {
        throw new api.ApiRequestError('素材目录已变化，请重新加载重复候选。', 409, {
          expectedCatalogRevision: catalogRevisionRef.current,
          actualCatalogRevision: page.catalogRevision,
        });
      }
      if (generation !== duplicateGenerationRef.current || !canApplySelectedMutation(targetId, targetRevision)) return;
      setDuplicateMode(mode);
      if (nextPage) {
        setDuplicatePages((current) => [...current.slice(0, duplicatePageIndex + 1), page]);
        duplicatePageIndexRef.current = duplicatePageIndex + 1;
        setDuplicatePageIndex(duplicatePageIndex + 1);
      } else {
        setDuplicatePages([page]);
        duplicatePageIndexRef.current = 0;
        setDuplicatePageIndex(0);
      }
      setDuplicates(page.items);
      setDuplicateHasMore(page.hasMore);
    } catch (error) {
      if (!isAbortError(error)) {
        if (generation !== duplicateGenerationRef.current || !canApplySelectedMutation(targetId, targetRevision)) return;
        if (error instanceof api.ApiRequestError && error.status === 409) {
          setDuplicatePages([]);
          setDuplicatePageIndex(0);
          setDuplicates([]);
          setDuplicateHasMore(false);
          resetCatalog(activeFiltersRef.current);
        }
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation === duplicateGenerationRef.current) setMutation('');
    }
  }, [canApplySelectedMutation, duplicateMode, duplicatePageIndex, duplicatePages, resetCatalog, selectedAsset]);

  const decideDuplicate = (candidate: AssetDuplicateCandidate, decision: 'pending' | 'confirmed' | 'dismissed') => runMutation(`duplicate:${candidate.id}`, async () => {
    const targetId = selectedAssetIdRef.current;
    const targetRevision = detailGenerationRef.current;
    const decisionDuplicateGeneration = duplicateGenerationRef.current;
    const candidatePageIndex = duplicatePageIndexRef.current;
    try {
      const candidatePage = duplicatePagesRef.current[candidatePageIndex];
      const expectedCatalogRevision = candidatePage?.items.some((item) => item.id === candidate.id)
        ? candidatePage.catalogRevision
        : null;
      if (expectedCatalogRevision == null) throw new Error('重复候选目录版本缺失，请重新检测。');
      const updated = await api.decideProjectAssetDuplicate(
        candidate.id,
        decision,
        {
          expectedRevision: candidate.revision ?? 0,
          expectedCatalogRevision,
          projectId: assetProjectId,
        },
      );
      const currentCandidatePage = duplicatePagesRef.current[candidatePageIndex];
      if (decisionDuplicateGeneration !== duplicateGenerationRef.current
        || !targetId
        || !canApplySelectedMutation(targetId, targetRevision)
        || String(currentCandidatePage?.catalogRevision) !== String(expectedCatalogRevision)
        || !currentCandidatePage?.items.some((item) => item.id === candidate.id)) return;
      const candidatePageIsActive = duplicatePageIndexRef.current === candidatePageIndex;
      // The decision endpoint owns only the persisted decision row. Preserve
      // the selected-asset-relative target/evidence already loaded by the
      // duplicate query instead of replacing it with a partial wire record.
      if (candidatePageIsActive) {
        setDuplicates((current) => current.map((item) => item.id === candidate.id ? {
          ...item,
          decision: updated.decision,
          revision: updated.revision,
          updatedAt: updated.updatedAt,
        } : item));
      }
      setDuplicatePages((current) => current.map((page, index) => index !== candidatePageIndex ? page : {
        ...page,
        items: page.items.map((item) => item.id === candidate.id ? {
          ...item,
          decision: updated.decision,
          revision: updated.revision,
          updatedAt: updated.updatedAt,
        } : item),
      }));
      setMessage(decision === 'pending' ? '已撤销重复判断。' : decision === 'confirmed' ? '已确认重复关系；素材仍保持独立，未合并或删除。' : '已忽略该候选。');
    } catch (error) {
      const decisionStillCurrent = decisionDuplicateGeneration === duplicateGenerationRef.current
        && Boolean(targetId)
        && canApplySelectedMutation(targetId || '', targetRevision);
      if (!decisionStillCurrent) return;
      if (error instanceof api.ApiRequestError && error.status === 409) {
        setDuplicatePages([]);
        setDuplicatePageIndex(0);
        setDuplicates([]);
        setDuplicateHasMore(false);
        resetCatalog(activeFiltersRef.current);
        throw new Error(`409 候选版本冲突：${error.message}`);
      }
      throw error;
    }
  });

  const showDuplicateGroupPage = useCallback((index: number) => {
    const page = duplicateGroupPages[index];
    if (!page) return;
    setDuplicateGroupPageIndex(index);
    setDuplicateGroups(page.items);
    setDuplicateGroupHasMore(page.hasMore);
    setDuplicateGroupMemberState(null);
  }, [duplicateGroupPages]);

  const loadDuplicateGroups = useCallback(async (nextPage = false) => {
    if (nextPage) {
      const cached = duplicateGroupPages[duplicateGroupPageIndex + 1];
      if (cached) {
        setDuplicateGroupPageIndex(duplicateGroupPageIndex + 1);
        setDuplicateGroups(cached.items);
        setDuplicateGroupHasMore(cached.hasMore);
        setDuplicateGroupMemberState(null);
        return;
      }
    }
    const currentPage = duplicateGroupPages[duplicateGroupPageIndex];
    const requestCursor = nextPage ? currentPage?.cursor : undefined;
    if (nextPage && !requestCursor) return;
    duplicateGroupControllerRef.current?.abort();
    const controller = new AbortController();
    duplicateGroupControllerRef.current = controller;
    setMutation('duplicate-groups');
    setMessage('');
    try {
      const page = await api.listProjectAssetDuplicateGroups({
        projectId: assetProjectId,
        limit: 25,
        cursor: requestCursor || undefined,
        signal: controller.signal,
      });
      if (duplicateGroupControllerRef.current !== controller) return;
      if (nextPage) {
        setDuplicateGroupPages((current) => [...current.slice(0, duplicateGroupPageIndex + 1), page]);
        setDuplicateGroupPageIndex(duplicateGroupPageIndex + 1);
      } else {
        setDuplicateGroupPages([page]);
        setDuplicateGroupPageIndex(0);
      }
      setDuplicateGroups(page.items);
      setDuplicateGroupHasMore(page.hasMore);
      setDuplicateGroupMemberState(null);
    } catch (error) {
      if (!isAbortError(error)) setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (duplicateGroupControllerRef.current === controller) setMutation('');
    }
  }, [assetProjectId, duplicateGroupPageIndex, duplicateGroupPages]);

  const loadDuplicateGroupMembers = (group: AssetExactDuplicateGroup, nextPage = false) => runMutation(`duplicate-group-members:${group.id}`, async () => {
    const currentState = duplicateGroupMemberState?.groupId === group.id ? duplicateGroupMemberState : null;
    if (nextPage && currentState?.pages[currentState.pageIndex + 1]) {
      setDuplicateGroupMemberState({ ...currentState, pageIndex: currentState.pageIndex + 1 });
      return;
    }
    const currentPage = currentState?.pages[currentState.pageIndex];
    const requestCursor = nextPage ? currentPage?.cursor : undefined;
    if (nextPage && !requestCursor) return;
    duplicateGroupMemberControllerRef.current?.abort();
    const controller = new AbortController();
    duplicateGroupMemberControllerRef.current = controller;
    const page = await api.listProjectAssetDuplicateGroupMembers(group.id, {
      projectId: assetProjectId,
      limit: 100,
      cursor: requestCursor || undefined,
      signal: controller.signal,
    });
    if (duplicateGroupMemberControllerRef.current !== controller) return;
    setDuplicateGroupMemberState((current) => {
      const sameGroup = current?.groupId === group.id ? current : null;
      if (!nextPage || !sameGroup) return { groupId: group.id, pages: [page], pageIndex: 0 };
      return {
        groupId: group.id,
        pages: [...sameGroup.pages.slice(0, sameGroup.pageIndex + 1), page],
        pageIndex: sameGroup.pageIndex + 1,
      };
    });
  });

  const showDuplicateGroupMemberPage = (index: number) => {
    setDuplicateGroupMemberState((current) => current && current.pages[index]
      ? { ...current, pageIndex: index }
      : current);
  };

  const activateSourceNode = (assetId: string) => runMutation(`source:${assetId}`, async () => {
    const node = sourceTree?.nodes.find((item) => item.assetId === assetId);
    const asset = node?.asset || await api.getProjectAsset(assetId);
    selectAsset(asset);
  });

  const showSourceTreePage = (index: number) => {
    const page = sourceTreePages[index];
    if (!page) return;
    setSourceTreePageIndex(index);
    setSourceTree(page);
  };

  const loadNextSourceTreePage = () => runMutation('source-tree', async () => {
    const targetAsset = selectedAsset;
    const currentPage = sourceTreePages[sourceTreePageIndex] || sourceTree;
    if (!targetAsset || !currentPage?.cursor || !currentPage.hasMore) return;
    const cached = sourceTreePages[sourceTreePageIndex + 1];
    if (cached) {
      showSourceTreePage(sourceTreePageIndex + 1);
      return;
    }
    const targetId = targetAsset.id;
    const targetGeneration = detailGenerationRef.current;
    sourceTreeControllerRef.current?.abort();
    const controller = new AbortController();
    sourceTreeControllerRef.current = controller;
    try {
      const next = normalizeAssetSourceTree(await api.getProjectAssetSourceTree(targetId, {
        direction: 'both',
        maxDepth: 8,
        maxNodes: ASSET_SOURCE_NODE_LIMIT,
        cursor: currentPage.cursor,
        signal: controller.signal,
      }));
      if (sourceTreeControllerRef.current !== controller || !canApplySelectedMutation(targetId, targetGeneration)) return;
      setSourceTreePages((current) => [...current.slice(0, sourceTreePageIndex + 1), next]);
      setSourceTreePageIndex(sourceTreePageIndex + 1);
      setSourceTree(next);
    } catch (error) {
      if (error instanceof api.ApiRequestError && error.status === 409) {
        const refreshed = normalizeAssetSourceTree(await api.getProjectAssetSourceTree(targetId, {
          direction: 'both', maxDepth: 8, maxNodes: ASSET_SOURCE_NODE_LIMIT, signal: controller.signal,
        }));
        if (sourceTreeControllerRef.current !== controller || !canApplySelectedMutation(targetId, targetGeneration)) return;
        setSourceTreePages([refreshed]);
        setSourceTreePageIndex(0);
        setSourceTree(refreshed);
        setMessage('来源图在分页期间发生变化，已回到最新第一页。');
        return;
      }
      throw error;
    }
  });

  const showLineagePage = (index: number) => {
    if (!lineagePages[index]) return;
    setLineagePageIndex(index);
  };

  const reloadFirstLineagePage = () => {
    const targetAsset = selectedAsset;
    if (!targetAsset) return;
    const targetId = targetAsset.id;
    const targetGeneration = detailGenerationRef.current;
    lineageControllerRef.current?.abort();
    const controller = new AbortController();
    lineageControllerRef.current = controller;
    setLineageLoading(true);
    setMessage('');
    void api.listProjectAssetLineage(targetId, { limit: 50, signal: controller.signal }).then((first) => {
      if (lineageControllerRef.current !== controller || !canApplySelectedMutation(targetId, targetGeneration)) return;
      setLineagePages([first]);
      setLineagePageIndex(0);
      setLineagePageOffset(0);
    }).catch((error) => {
      if (!isAbortError(error) && lineageControllerRef.current === controller && canApplySelectedMutation(targetId, targetGeneration)) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (lineageControllerRef.current === controller) setLineageLoading(false);
    });
  };

  const loadNextLineagePage = () => {
    const currentPage = lineagePages[lineagePageIndex];
    const targetAsset = selectedAsset;
    if (!targetAsset || !currentPage?.cursor || !currentPage.hasMore) return;
    const cached = lineagePages[lineagePageIndex + 1];
    if (cached) {
      showLineagePage(lineagePageIndex + 1);
      return;
    }
    const targetId = targetAsset.id;
    const targetGeneration = detailGenerationRef.current;
    lineageControllerRef.current?.abort();
    const controller = new AbortController();
    lineageControllerRef.current = controller;
    setLineageLoading(true);
    setMessage('');
    void (async () => {
      try {
        const next = await api.listProjectAssetLineage(targetId, {
          limit: currentPage.limit,
          cursor: currentPage.cursor || undefined,
          signal: controller.signal,
        });
        if (lineageControllerRef.current !== controller || !canApplySelectedMutation(targetId, targetGeneration)) return;
        const appended = [...lineagePages.slice(0, lineagePageIndex + 1), next];
        const overflow = Math.max(0, appended.length - LINEAGE_PAGE_CACHE_LIMIT);
        setLineagePages(appended.slice(overflow));
        setLineagePageIndex(lineagePageIndex + 1 - overflow);
        if (overflow) setLineagePageOffset((offset) => offset + overflow);
      } catch (error) {
        if (isAbortError(error)) return;
        if (error instanceof api.ApiRequestError && error.status === 409) {
          try {
            const refreshed = await api.listProjectAssetLineage(targetId, { limit: 50, signal: controller.signal });
            if (lineageControllerRef.current !== controller || !canApplySelectedMutation(targetId, targetGeneration)) return;
            setLineagePages([refreshed]);
            setLineagePageIndex(0);
            setLineagePageOffset(0);
            setMessage('来源事件在分页期间发生变化，已回到最新第一页。');
          } catch (refreshError) {
            if (!isAbortError(refreshError) && lineageControllerRef.current === controller && canApplySelectedMutation(targetId, targetGeneration)) {
              setMessage(refreshError instanceof Error ? refreshError.message : String(refreshError));
            }
          }
          return;
        }
        if (lineageControllerRef.current === controller && canApplySelectedMutation(targetId, targetGeneration)) {
          setMessage(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (lineageControllerRef.current === controller) setLineageLoading(false);
      }
    })();
  };

  const addPermissionGrant = () => {
    const principalId = permissionPrincipalId.trim();
    if (!principalId) {
      setMessage(`${permissionPrincipalType === 'member' ? '成员' : '角色'} ID 不能为空。`);
      return;
    }
    const next: AssetPermissionWireGrant = {
      principalType: permissionPrincipalType,
      principalId,
      permissions: permissionsForAssetRole(permissionRole),
    };
    setPermissionGrantsDraft((current) => [
      ...current.filter((grant) => grant.principalType !== permissionPrincipalType || grant.principalId !== principalId),
      next,
    ]);
    setPermissionPrincipalId('');
    setMessage('');
  };

  const reconcileSelectedAssetGovernance = async (targetId: string): Promise<boolean> => {
    if (!isCurrentAssetSelection(selectedAssetIdRef.current, targetId)) return false;
    const generation = detailGenerationRef.current;
    const [freshAsset, freshPolicy] = await Promise.all([
      api.getProjectAsset(targetId),
      api.getProjectAssetPermissions(targetId),
    ]);
    if (!canApplySelectedMutation(targetId, generation)) return false;
    setSelectedAsset(freshAsset);
    setTagDraft((freshAsset.tags || []).join(', '));
    setAssetPermissions(freshPolicy);
    setPermissionScopeDraft(freshPolicy.scope);
    setPermissionGrantsDraft(freshPolicy.grants);
    updateCachedAsset(freshAsset);
    clearBatchSelection();
    resetCatalog(activeFiltersRef.current);
    return true;
  };

  const tryReconcileSelectedAssetGovernance = async (targetId: string): Promise<boolean> => {
    try {
      return await reconcileSelectedAssetGovernance(targetId);
    } catch {
      return false;
    }
  };

  const saveAssetPermissions = () => runMutation('permissions', async () => {
    const targetAsset = selectedAsset;
    const currentPolicy = assetPermissions;
    if (!targetAsset || !currentPolicy) return;
    if (permissionScopeDraft === 'restricted' && !permissionGrantsDraft.length) {
      throw new Error('受限权限至少需要一个成员或角色授权，避免素材不可访问');
    }
    const targetId = targetAsset.id;
    const mutationGeneration = detailGenerationRef.current + 1;
    try {
      const { value, revision } = await runSelectedMutationRequest(targetId, async () => {
        const policy = await api.setProjectAssetPermissions(targetId, {
          scope: permissionScopeDraft,
          grants: permissionGrantsDraft.map((grant) => ({
            principalType: grant.principalType,
            principalId: grant.principalId,
            permissions: [...new Set(grant.permissions)],
          })),
          expectedRevision: currentPolicy.revision,
        });
        let freshAsset: AssetRef | null = null;
        let refreshError: unknown = null;
        try {
          freshAsset = await api.getProjectAsset(targetId);
        } catch (error) {
          refreshError = error;
        }
        return { policy, freshAsset, refreshError };
      });
      if (!canApplySelectedMutation(targetId, revision)) {
        const reconciled = await tryReconcileSelectedAssetGovernance(targetId);
        if (reconciled) setMessage('权限保存响应已过期；已重新载入当前服务端权限。');
        return;
      }
      setAssetPermissions(value.policy);
      setPermissionScopeDraft(value.policy.scope);
      setPermissionGrantsDraft(value.policy.grants);
      if (value.freshAsset) {
        setSelectedAsset(value.freshAsset);
        setTagDraft((value.freshAsset.tags || []).join(', '));
        updateCachedAsset(value.freshAsset);
      }
      clearBatchSelection();
      resetCatalog(activeFiltersRef.current);
      if (value.refreshError) {
        const reconciled = await tryReconcileSelectedAssetGovernance(targetId);
        if (!canApplySelectedMutation(targetId, revision)) return;
        setMessage(reconciled
          ? `素材权限已保存（revision ${value.policy.revision}）；已重新载入最新素材版本。`
          : `素材权限已保存（revision ${value.policy.revision}），但最新素材版本暂未刷新；后台将继续重试。`);
      } else {
        setMessage(`素材权限已保存（revision ${value.policy.revision}）。`);
      }
    } catch (error) {
      if (error instanceof api.ApiRequestError && error.status === 409) {
        const reconciled = await tryReconcileSelectedAssetGovernance(targetId);
        if (!canApplySelectedMutation(targetId, mutationGeneration)) return;
        throw new Error(reconciled
          ? `409 权限版本冲突：${error.message}；已载入最新权限与素材版本，请重新确认`
          : `409 权限版本冲突：${error.message}；最新服务端权限暂时无法读取，请稍后刷新并重新确认`);
      }
      if (!(error instanceof api.ApiRequestError) || error.status >= 500) {
        const reconciled = await tryReconcileSelectedAssetGovernance(targetId);
        if (!canApplySelectedMutation(targetId, mutationGeneration)) return;
        if (reconciled) throw new Error(`权限保存结果未确认：${error instanceof Error ? error.message : String(error)}；已重新载入服务端权限，请核对后再操作`);
      }
      if (!canApplySelectedMutation(targetId, mutationGeneration)) return;
      throw error;
    }
  });

  const counts = pipelineStatus?.previews.counts || EMPTY_PREVIEW_COUNTS;
  const activePreviewCount = Number(pipelineStatus?.previews.active || 0);
  const tasksActive = pipelineIsActive(pipelineStatus);
  const lineagePage = lineagePages[lineagePageIndex] || null;
  const lineage = lineagePage?.items || [];
  const selectedSemanticHit = searchMode === 'semantic' && selectedAssetId
    ? semanticCatalog.getHitByAssetId(selectedAssetId)
    : undefined;
  const selectedAvailabilityRefreshInput = frozenAssetAvailabilityInput(selectedAsset, assetProjectId, catalogRevision);
  const semanticEmpty = searchMode === 'semantic'
    ? assetSemanticEmptyState({
      availability: semanticCatalog.availability,
      query: semanticQuery,
      loading: semanticCatalog.loading,
      total: semanticCatalog.total,
      error: semanticCatalog.error,
    })
    : null;
  const semanticStateMessage = semanticEmptyMessage(
    semanticEmpty,
    semanticCatalog.availability.message,
    semanticCatalog.error,
  );

  return <section className="relative flex h-full min-h-0 flex-col p-5" data-asset-center>
    <div className="shrink-0">
      <div className="flex flex-wrap gap-2">
        <div className="flex h-10 shrink-0 overflow-hidden rounded border border-[var(--border-primary)]" role="group" aria-label="素材搜索模式">
          <button type="button" aria-pressed={searchMode === 'keyword'} className={`px-3 text-xs font-bold ${searchMode === 'keyword' ? 'bg-[var(--accent-primary)] text-white' : 'bg-[var(--bg-secondary)]'}`} onClick={() => changeSearchMode('keyword')}>关键词</button>
          <button type="button" aria-pressed={searchMode === 'semantic'} className={`border-l border-[var(--border-primary)] px-3 text-xs font-bold ${searchMode === 'semantic' ? 'bg-[var(--accent-primary)] text-white' : 'bg-[var(--bg-secondary)]'}`} onClick={() => changeSearchMode('semantic')}>自然语言</button>
        </div>
        {searchMode === 'keyword'
          ? <label className="min-w-48 flex-1"><span className="sr-only">关键词搜索素材</span><input value={queryInput} className="h-10 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 text-sm" placeholder="按文件名、尺寸、来源搜索（250ms）" onChange={(event) => setQueryInput(event.target.value)} /></label>
          : <div className="flex min-w-64 flex-1 gap-1"><label className="min-w-0 flex-1"><span className="sr-only">自然语言检索素材</span><input value={semanticQueryInput} maxLength={2000} className="h-10 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 text-sm" placeholder="例如：海边日落中的红色汽车" onChange={(event) => setSemanticQueryInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) submitSemanticSearch(); }} /></label><button type="button" className="h-10 rounded border border-[var(--accent-primary)] px-3 text-xs font-bold text-[var(--accent-primary)] disabled:opacity-40" disabled={!normalizeAssetSemanticQuery(semanticQueryInput) || !semanticCatalog.availability.searchable} onClick={submitSemanticSearch}>检索</button></div>}
        <label><span className="sr-only">素材类型</span><select aria-label="素材类型" value={kind} className="h-10 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 text-sm" onChange={(event) => setKind(event.target.value)}><option value="">全部类型</option>{['image', 'video', 'audio', 'model3d', 'text', 'other'].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span className="sr-only">素材存储模式</span><select aria-label="素材存储模式" value={storageMode} className="h-10 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 text-sm" onChange={(event) => setStorageMode(event.target.value)}><option value="">全部存储</option><option value="managed">受管副本</option><option value="linked">本机链接</option><option value="remote">远程外链</option><option value="embedded">内嵌内容</option></select></label>
        <label><span className="sr-only">素材可用状态</span><select aria-label="素材可用状态" value={availability} className="h-10 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 text-sm" onChange={(event) => setAvailability(event.target.value)}><option value="">全部状态</option><option value="available">可用</option><option value="missing">源文件丢失</option><option value="corrupt">损坏</option><option value="unverified">未验证</option></select></label>
        <label><span className="sr-only">标签筛选</span><input list="asset-tag-filter-options" aria-label="标签筛选" value={tagFilter} className="h-10 w-32 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 text-sm" placeholder="全部标签" onChange={(event) => setTagFilter(event.target.value.trimStart())} /><datalist id="asset-tag-filter-options">{availableTags.map((tag) => <option key={tag} value={tag} />)}</datalist></label>
        <label><span className="sr-only">素材来源筛选</span><input aria-label="素材来源筛选" value={sourceFilter} className="h-10 w-32 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 text-sm" placeholder="全部来源" onChange={(event) => setSourceFilter(event.target.value.trimStart())} /></label>
        {searchMode === 'semantic'
          ? <label><span className="sr-only">自然语言结果排序</span><select aria-label="自然语言结果排序" value="semantic-relevance" disabled className="h-10 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 text-sm opacity-70"><option value="semantic-relevance">语义相关度</option></select></label>
          : <label><span className="sr-only">素材排序</span><select aria-label="素材排序" value={sortOrder} className="h-10 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 text-sm" onChange={(event) => setSortOrder(event.target.value as typeof sortOrder)}><option value="created-desc">最新创建</option><option value="created-asc">最早创建</option><option value="updated-desc">最近更新</option><option value="updated-asc">最早更新</option><option value="name-asc">名称 A-Z</option><option value="name-desc">名称 Z-A</option><option value="size-desc">大小降序</option><option value="size-asc">大小升序</option></select></label>}
        <label><span className="sr-only">素材集合</span><select aria-label="素材集合" value={collectionId} className="h-10 max-w-52 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 text-sm" onChange={(event) => setCollectionId(event.target.value)}><option value="">全部集合</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name} ({collection.assetCount})</option>)}</select></label>
        <button type="button" disabled={mutation === 'link'} className="flex h-10 items-center gap-2 rounded border border-[var(--border-primary)] px-3 text-xs font-bold disabled:opacity-40" onClick={() => void linkLocalAssets()}>{mutation === 'link' ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />}链接本机素材</button>
        <button type="button" disabled={mutation === 'scan' || pipelineStatus?.scan.running} className="flex h-10 items-center gap-2 rounded border border-[var(--border-primary)] px-3 text-xs font-bold disabled:opacity-40" onClick={() => void scanAssets()}>{mutation === 'scan' || pipelineStatus?.scan.running ? <Loader2 size={15} className="animate-spin" /> : <ScanSearch size={15} />}重新索引</button>
      </div>
      {searchMode === 'semantic' && <div className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded border px-3 py-2 text-[10px] ${semanticCatalog.availability.searchable ? 'border-[var(--border-primary)] bg-[var(--bg-secondary)]' : 'border-amber-500/50 bg-amber-500/10 text-amber-700'}`} role="status" aria-live="polite" data-asset-semantic-mode-status>
        {(semanticCatalog.loading || semanticStatus?.project.indexState === 'building' || semanticStatus?.project.indexState === 'queued') && <Loader2 size={12} className="animate-spin" />}
        <strong>自然语言检索</strong>
        <span>{semanticCatalog.availability.message}</span>
        {semanticStatus && <span className="opacity-65">代次 {semanticStatus.project.activeGeneration || '—'} · 目录 revision {String(semanticStatus.project.currentCatalogRevision)}</span>}
      </div>}
      <div className="mt-2 flex gap-2 border-b border-[var(--border-primary)] pb-2">
        <label className="min-w-0 flex-1"><span className="sr-only">新集合名称</span><input value={newCollectionName} maxLength={60} className="h-9 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 text-xs" placeholder="新集合名称" onChange={(event) => setNewCollectionName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createCollection(); }} /></label>
        <button type="button" disabled={!newCollectionName.trim() || mutation === 'collection-create'} className="h-9 rounded border border-[var(--border-primary)] px-3 text-xs font-bold disabled:opacity-40" onClick={() => void createCollection()}>新建集合</button>
      </div>
      {collections.length > 0 && <details className="mt-2 rounded border border-[var(--border-primary)] px-3 py-2 text-xs" data-asset-collection-manager>
        <summary className="cursor-pointer font-semibold">管理集合（改名 / 删除）</summary>
        <div className="mt-2 grid max-h-36 gap-2 overflow-auto">{collections.map((collection) => <div key={collection.id} className="flex items-center gap-2">
          <input aria-label={`集合 ${collection.name} 名称`} value={collectionDrafts[collection.id] ?? collection.name} maxLength={60} className="h-8 min-w-0 flex-1 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 text-[11px]" onChange={(event) => setCollectionDrafts((current) => ({ ...current, [collection.id]: event.target.value }))} />
          <button type="button" disabled={mutation === `collection-rename:${collection.id}`} className="h-8 rounded border border-[var(--border-primary)] px-2 text-[10px] font-bold disabled:opacity-40" onClick={() => void renameCollection(collection)}>改名</button>
          <button type="button" disabled={mutation === `collection-delete:${collection.id}`} className="h-8 rounded border border-red-500 px-2 text-[10px] font-bold text-red-500 disabled:opacity-40" onClick={() => void removeCollection(collection)}>删除</button>
        </div>)}</div>
      </details>}
      <details className="mt-2 rounded border border-[var(--border-primary)] px-3 py-2 text-xs" data-asset-saved-filter-views>
        <summary className="cursor-pointer font-semibold">保存的筛选视图（{savedViews.length}）</summary>
        <div className="mt-2 flex gap-2"><input aria-label="筛选视图名称" value={savedViewName} maxLength={60} disabled={searchMode === 'semantic'} className="h-8 min-w-0 flex-1 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 text-[11px] disabled:opacity-45" placeholder={searchMode === 'semantic' ? '自然语言结果不保存为关键词筛选' : '当前筛选视图名称'} onChange={(event) => setSavedViewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveCurrentFilterView(); }} /><button type="button" disabled={searchMode === 'semantic' || !savedViewName.trim()} title={searchMode === 'semantic' ? '自然语言结果绑定具体索引代次，不能保存为关键词筛选视图' : undefined} className="h-8 rounded border border-[var(--border-primary)] px-2 text-[10px] font-bold disabled:opacity-40" onClick={saveCurrentFilterView}>保存当前筛选</button></div>
        <p className="mt-1 text-[9px] opacity-55">关键词模式按项目保存搜索、类型、来源、存储、状态、标签、集合和排序；自然语言结果绑定索引代次，不保存 activeAsset 或批量选择。</p>
        {savedViews.length > 0 && <div className="mt-2 grid max-h-28 gap-1 overflow-auto">{savedViews.map((view) => <div key={view.id} className="flex items-center gap-1"><button type="button" className="h-7 min-w-0 flex-1 truncate rounded border border-[var(--border-primary)] px-2 text-left text-[10px]" title={view.name} onClick={() => applySavedFilterView(view)}>{view.name}</button><button type="button" aria-label={`删除筛选视图 ${view.name}`} className="h-7 rounded border border-red-500 px-2 text-[10px] text-red-500" onClick={() => removeSavedFilterView(view)}>删除</button></div>)}</div>}
      </details>
      <div className="mt-2 flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[10px]" role="status" aria-live="polite" data-asset-pipeline-status>
        {tasksActive && <Loader2 size={13} className="animate-spin text-[var(--accent-primary)]" />}
        <strong>{pipelineStatus?.scan.running ? '正在扫描' : '媒体预览队列'}</strong>
        <span>本项目活动 {activePreviewCount}</span><span>全局槽位上限 {pipelineStatus?.previews.concurrency || 1}</span><span>排队 {counts.queued}</span><span>重试 {counts.retrying}</span><span>成功 {counts.succeeded}</span><span className={counts.failed ? 'font-bold text-red-500' : ''}>失败 {counts.failed}</span>
        {pipelineStatus?.previews.nextAttemptAt ? <span>下次重试 {formatTime(pipelineStatus.previews.nextAttemptAt)}</span> : null}
        {pipelineStatus?.previews.databaseStatusStale && <span className="font-bold text-amber-600">数据库状态为缓存值，当前计数不能视为空闲</span>}
        {pipelineStatus?.previews.storagePressure?.active && <span className="font-bold text-amber-600">全局存储压力，预览写入等待恢复</span>}
        {pipelineStatus?.previews.databaseBusy?.active && <span className="font-bold text-amber-600">全局数据库忙，预览队列正在退避</span>}
        {pipelineStatus?.previews.globalRecoveryPending && <span className="font-bold text-amber-600">全局预览恢复等待数据库可写</span>}
        {pipelineStatus?.previews.shuttingDown && <span className="font-bold text-amber-600">全局预览管线正在关闭</span>}
        {!pipelineStatus && !pipelineError && <span className="opacity-55">读取任务状态…</span>}
        {pipelineError && <span className="text-red-500">状态暂不可用：{pipelineError}</span>}
      </div>
      <div className="mt-2"><AssetSemanticSettingsPanel projectId={assetProjectId} externalRefreshToken={semanticStatusRefreshToken} onStatusChange={acceptSemanticStatus} /></div>
      {(message || browserError) && <div className={`mt-2 rounded border px-3 py-2 text-xs ${browserError ? 'border-red-500/50 text-red-500' : 'border-[var(--border-primary)]'}`} role={browserError ? 'alert' : 'status'}>{browserError || message}</div>}
      <div className="mt-2 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2" data-asset-batch-toolbar>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <strong>批量选择：{selectedBatchCount} 项</strong>
          {batchSelection.mode === 'query' && <span className="opacity-60">当前筛选全选 · 排除 {batchSelection.exclusions.length}</span>}
          {selectionLoading && <span className="flex items-center gap-1"><Loader2 size={12} className="animate-spin" />读取范围 revision…</span>}
          <button type="button" disabled={searchMode === 'semantic' || !browserTotal || browserTotal > QUERY_SELECTION_LIMIT || selectionLoading} title={searchMode === 'semantic' ? '自然语言结果绑定具体索引代次，只支持逐项或已加载范围选择' : browserTotal > QUERY_SELECTION_LIMIT ? `请将筛选缩小到 ${QUERY_SELECTION_LIMIT} 项以内` : undefined} className="h-7 rounded border border-[var(--border-primary)] px-2 font-bold disabled:opacity-40" onClick={selectCurrentFilter}>全选当前筛选（≤{QUERY_SELECTION_LIMIT}）</button>
          <button type="button" disabled={!selectedBatchCount && !selectionLoading} className="h-7 rounded border border-[var(--border-primary)] px-2 font-bold disabled:opacity-40" onClick={clearBatchSelection}>清空选择</button>
          <span className="opacity-55">卡片点击仅切换详情；checkbox、Space、Ctrl/Cmd、Shift 用于批量选择。</span>
        </div>
        {(batchConflict || batchSelectionStale) && <div role="alert" className="mt-2 rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-600">
          {batchConflict || '目录 revision 已变化；提交会由服务端进行 409 冲突校验，请刷新并重新选择。'}
        </div>}
        <div className="mt-2 grid gap-2 text-[10px] xl:grid-cols-3">
          <div className="rounded border border-[var(--border-primary)] p-2" data-asset-batch-tags>
            <div className="mb-1 font-bold">批量标签</div>
            <div className="flex gap-1"><select aria-label="批量标签模式" value={batchTagMode} className="h-8 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1" onChange={(event) => setBatchTagMode(event.target.value as typeof batchTagMode)}><option value="add">追加</option><option value="remove">移除</option><option value="replace">替换</option></select><input aria-label="批量标签值" value={batchTagDraft} className="h-8 min-w-0 flex-1 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2" placeholder="标签，逗号分隔" onChange={(event) => setBatchTagDraft(event.target.value)} /><button type="button" disabled={!selectedBatchCount || mutation === 'batch:tags'} className="h-8 rounded border border-[var(--border-primary)] px-2 font-bold disabled:opacity-40" onClick={applyBatchTags}>应用</button></div>
          </div>
          <div className="rounded border border-[var(--border-primary)] p-2" data-asset-batch-collections>
            <div className="mb-1 font-bold">批量集合</div>
            <div className="flex flex-wrap gap-1"><select aria-label="批量集合模式" value={batchCollectionMode} className="h-8 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1" onChange={(event) => setBatchCollectionMode(event.target.value as typeof batchCollectionMode)}><option value="add">加入</option><option value="remove">移出</option><option value="replace">替换全部</option><option value="move">从集合移动</option></select>{batchCollectionMode === 'move' && <select aria-label="批量来源集合" value={batchCollectionSourceId} className="h-8 min-w-28 flex-1 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1" onChange={(event) => setBatchCollectionSourceId(event.target.value)}><option value="">来源集合</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select>}<select aria-label="批量目标集合" value={batchCollectionId} className="h-8 min-w-28 flex-1 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1" onChange={(event) => setBatchCollectionId(event.target.value)}><option value="">{batchCollectionMode === 'move' ? '目标集合' : '选择集合'}</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select><button type="button" disabled={!selectedBatchCount || !batchCollectionId || (batchCollectionMode === 'move' && (!batchCollectionSourceId || batchCollectionSourceId === batchCollectionId)) || mutation === 'batch:collections'} className="h-8 rounded border border-[var(--border-primary)] px-2 font-bold disabled:opacity-40" onClick={applyBatchCollection}>应用</button></div>
            {batchCollectionMode === 'move' && <p className="mt-1 opacity-55">仅从所选来源集合移出，再加入目标集合；不会清除素材仍属于的其他集合。</p>}
          </div>
          <div className="rounded border border-[var(--border-primary)] p-2" data-asset-batch-access>
            <div className="mb-1 flex items-center justify-between gap-2"><strong>批量授权</strong><select aria-label="素材访问范围" value={batchVisibility} className="h-7 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1" onChange={(event) => setBatchVisibility(event.target.value as typeof batchVisibility)}><option value="project">项目可见</option><option value="restricted">受限</option></select></div>
            <div className="flex gap-1"><select aria-label="授权主体类型" value={grantPrincipalType} className="h-8 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1" onChange={(event) => setGrantPrincipalType(event.target.value as typeof grantPrincipalType)}><option value="member">成员</option><option value="role">项目角色</option></select><input aria-label="授权主体 ID" value={grantMemberDraft} className="h-8 min-w-0 flex-1 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2" placeholder={grantPrincipalType === 'member' ? '成员 ID' : '角色 ID'} onChange={(event) => setGrantMemberDraft(event.target.value)} /><select aria-label="授权级别" value={grantRoleDraft} className="h-8 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1" onChange={(event) => setGrantRoleDraft(event.target.value as typeof grantRoleDraft)}><option value="viewer">查看</option><option value="editor">整理</option><option value="owner">管理 ACL</option></select><button type="button" className="h-8 rounded border border-[var(--border-primary)] px-2 font-bold" onClick={addBatchGrant}>添加</button></div>
            {batchGrants.length > 0 && <div className="mt-1 flex max-h-14 flex-wrap gap-1 overflow-auto">{batchGrants.map((grant) => <button key={`${grant.principalType}:${grant.principalId}`} type="button" title="点击移除授权草稿" className="rounded border border-[var(--border-primary)] px-1.5 py-0.5" onClick={() => setBatchGrants((current) => current.filter((item) => item.principalType !== grant.principalType || item.principalId !== grant.principalId))}>{grant.principalType}:{grant.principalId} · {grant.role} ×</button>)}</div>}
            <button type="button" disabled={!selectedBatchCount || mutation === 'batch:access'} className="mt-1 h-8 w-full rounded border border-[var(--border-primary)] font-bold disabled:opacity-40" onClick={applyBatchAccess}>应用访问范围与授权</button>
          </div>
        </div>
      </div>
      <details className="mt-2 rounded border border-[var(--border-primary)] px-3 py-2 text-[10px]" data-asset-exact-duplicate-groups>
        <summary className="cursor-pointer font-semibold">项目精确重复组（共享逻辑 blob，仅 SHA-256 等值）</summary>
        <div className="mt-2 flex items-center justify-between gap-2"><span className="opacity-60">近似候选不会形成传递组；组操作也不会自动合并或删除。</span><button type="button" disabled={mutation === 'duplicate-groups'} className="h-7 rounded border border-[var(--border-primary)] px-2 font-bold disabled:opacity-40" onClick={() => void loadDuplicateGroups(false)}>{mutation === 'duplicate-groups' ? '读取中…' : '加载精确组'}</button></div>
        {duplicateGroups.length > 0 && <div className="mt-2 grid max-h-64 gap-2 overflow-auto">{duplicateGroups.map((group) => {
          const memberState = duplicateGroupMemberState?.groupId === group.id ? duplicateGroupMemberState : null;
          const memberPage = memberState?.pages[memberState.pageIndex];
          return <article key={group.id} className="rounded border border-[var(--border-primary)] p-2">
            <div className="flex justify-between gap-2"><strong>{group.memberCount} 个成员</strong><span className="truncate font-mono opacity-55" title={group.contentHash}>{group.contentHash.slice(0, 16)}…</span></div>
            <div className="mt-1 flex flex-wrap gap-1">{group.members.slice(0, 20).map((asset) => <button key={asset.id} type="button" className="max-w-40 truncate rounded border border-[var(--border-primary)] px-1.5 py-0.5" title={asset.filename} onClick={() => selectAsset(asset)}>{asset.filename}</button>)}</div>
            {group.membersTruncated && <button type="button" disabled={mutation === `duplicate-group-members:${group.id}`} className="mt-1 h-7 w-full rounded border border-[var(--border-primary)] font-bold disabled:opacity-40" onClick={() => void loadDuplicateGroupMembers(group, false)}>{memberState ? '刷新完整成员页' : '分页查看全部成员'}</button>}
            {memberPage && <div className="mt-2 rounded bg-[var(--bg-secondary)] p-1"><div className="flex max-h-24 flex-wrap gap-1 overflow-auto">{memberPage.items.map((asset) => <button key={asset.id} type="button" className="max-w-40 truncate rounded border border-[var(--border-primary)] px-1.5 py-0.5" title={asset.filename} onClick={() => selectAsset(asset)}>{asset.filename}</button>)}</div><div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-center gap-1"><button type="button" disabled={!memberState || memberState.pageIndex === 0} className="h-6 rounded border border-[var(--border-primary)] disabled:opacity-35" onClick={() => showDuplicateGroupMemberPage((memberState?.pageIndex || 0) - 1)}>上一页</button><span className="text-center opacity-55">成员页 {(memberState?.pageIndex || 0) + 1}</span><button type="button" disabled={!memberState || (!memberPage.hasMore && !memberState.pages[memberState.pageIndex + 1]) || mutation === `duplicate-group-members:${group.id}`} className="h-6 rounded border border-[var(--border-primary)] disabled:opacity-35" onClick={() => void loadDuplicateGroupMembers(group, true)}>下一页</button></div></div>}
          </article>;
        })}</div>}
        {duplicateGroupPages.length > 0 && <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-1"><button type="button" disabled={duplicateGroupPageIndex === 0 || mutation === 'duplicate-groups'} className="h-7 rounded border border-[var(--border-primary)] font-bold disabled:opacity-35" onClick={() => showDuplicateGroupPage(duplicateGroupPageIndex - 1)}>上一页</button><span className="px-1 text-center opacity-60">组页 {duplicateGroupPageIndex + 1}</span><button type="button" disabled={(!duplicateGroupHasMore && !duplicateGroupPages[duplicateGroupPageIndex + 1]) || mutation === 'duplicate-groups'} className="h-7 rounded border border-[var(--border-primary)] font-bold disabled:opacity-35" onClick={() => void loadDuplicateGroups(true)}>下一页</button></div>}
      </details>
    </div>

    <div className="mt-3 grid min-h-0 flex-1 grid-rows-[minmax(280px,1fr)_minmax(220px,0.8fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:grid-rows-1">
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="mb-2 flex shrink-0 items-center justify-between gap-2 text-xs"><span>{browserTotal} 项{browserLoading ? ' · 正在加载可见页' : ''}{searchMode === 'semantic' && semanticQuery ? ` · “${semanticQuery}”` : ''}</span><div className="flex gap-1" role="group" aria-label="素材显示方式"><button type="button" aria-label="网格视图" aria-pressed={viewMode === 'grid'} className={`grid h-8 w-8 place-items-center rounded border ${viewMode === 'grid' ? 'border-[var(--accent-primary)] text-[var(--accent-primary)]' : 'border-[var(--border-primary)]'}`} onClick={() => setViewMode('grid')}><Grid2X2 size={14} /></button><button type="button" aria-label="列表视图" aria-pressed={viewMode === 'list'} className={`grid h-8 w-8 place-items-center rounded border ${viewMode === 'list' ? 'border-[var(--accent-primary)] text-[var(--accent-primary)]' : 'border-[var(--border-primary)]'}`} onClick={() => setViewMode('list')}><List size={14} /></button><button type="button" aria-label="刷新素材" className="grid h-8 w-8 place-items-center rounded border border-[var(--border-primary)]" onClick={() => { if (searchMode === 'semantic') semanticCatalog.reset(); else resetCatalog(); }}><RefreshCw size={14} /></button></div></div>
        {searchMode === 'semantic' && browserTotal > 0 && semanticCatalog.availability.reason !== 'ready' && <div className="mb-2 rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700" role="status">{semanticCatalog.availability.message}</div>}
        <div className="relative min-h-0 flex-1 border-y border-[var(--border-primary)] py-2">
          <AssetVirtualBrowser total={browserTotal} viewMode={viewMode} activeAssetId={activeAssetId} resetKey={browserResetKey} cacheRevision={browserCacheRevision} getItem={browserGetItem} getSemanticHit={searchMode === 'semantic' ? semanticCatalog.getHit : undefined} isSelected={isBatchSelected} onActivateAsset={activateAssetAtIndex} onToggleSelection={toggleBatchSelection} onRangeSelection={(index, additive, keyboardAnchorIndex) => { void selectBatchRange(index, additive, keyboardAnchorIndex); }} onRangeChange={browserEnsureRange} />
          {!browserTotal && browserLoading && <div className="pointer-events-none absolute inset-0 grid place-items-center gap-2 text-xs opacity-60"><Loader2 size={18} className="animate-spin" />{searchMode === 'semantic' ? '正在检索当前索引…' : '读取素材索引…'}</div>}
          {!browserTotal && !browserLoading && !browserError && <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-xs opacity-60">{searchMode === 'semantic' ? semanticStateMessage : '没有匹配的索引素材'}</div>}
        </div>
      </div>

      <aside className="min-h-0 min-w-0 overflow-auto border-l border-[var(--border-primary)] pl-4" aria-label="素材详情" data-asset-detail-panel>
        {selectedAsset ? <>
          <div className="relative mb-3 h-44 overflow-hidden rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)]"><AssetDetailPreview asset={selectedAsset} />{detailLoading && <span className="absolute right-2 top-2 rounded bg-black/70 p-1 text-white"><Loader2 size={13} className="animate-spin" /></span>}</div>
          <h3 className="break-all text-sm font-bold">{selectedAsset.filename}</h3>
          {selectedSemanticHit && <section className="mt-2 rounded border border-[var(--accent-primary)]/50 bg-[var(--bg-secondary)] p-2 text-[10px]" data-asset-semantic-evidence>
            <div className="flex items-center justify-between gap-2"><strong>自然语言相关度 #{selectedSemanticHit.rank}</strong><span className="font-mono text-[var(--accent-primary)]">{selectedSemanticHit.metric === 'rrf' ? 'RRF(k=60)' : selectedSemanticHit.metric === 'cosine' ? 'Cosine' : selectedSemanticHit.metric} {selectedSemanticHit.score.toFixed(4)}</span></div>
            <p className="mt-1 opacity-60">这是检索评分，不是置信度百分比；不同评分方式之间不能直接比较。</p>
            {selectedSemanticHit.evidence.length > 0 && <div className="mt-2 space-y-1">{selectedSemanticHit.evidence.slice(0, 3).map((evidence, index) => <div key={`${evidence.source}:${index}`} className="rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-1.5"><div className="mb-0.5 flex justify-between gap-2 font-semibold"><span>{evidence.source.toUpperCase()}</span>{(evidence.modelKey || evidence.modelVersion) && <span className="max-w-40 truncate font-normal opacity-55" title={`${evidence.modelKey || ''} ${evidence.modelVersion || ''}`}>{evidence.modelKey || '内建字段'}{evidence.modelVersion ? ` · ${evidence.modelVersion}` : ''}</span>}</div><p className="break-words leading-4">{evidence.snippet}</p></div>)}</div>}
          </section>}
          {searchMode === 'semantic' && <details className="mt-2 rounded border border-[var(--border-primary)] p-2 text-[10px]" data-asset-semantic-documents>
            <summary className="cursor-pointer font-semibold">当前索引的 Caption / OCR 证据（{semanticDocuments.length}）</summary>
            {semanticDocumentsLoading && <div className="mt-2 flex items-center gap-1 opacity-60"><Loader2 size={12} className="animate-spin" />读取证据…</div>}
            {semanticDocumentsError && <div className="mt-2 text-red-500" role="alert">{semanticDocumentsError}</div>}
            {!semanticDocumentsLoading && !semanticDocumentsError && semanticDocuments.length === 0 && <div className="mt-2 opacity-55">当前素材在活动索引代次中没有 Caption/OCR 文档；文件名、标签或元数据仍可能参与检索。</div>}
            {semanticDocuments.length > 0 && <div className="mt-2 max-h-60 space-y-2 overflow-auto">{semanticDocuments.slice(0, 8).map((document) => <article key={String(document.id)} className="rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2"><div className="flex justify-between gap-2 font-semibold"><span>{document.source === 'caption' ? 'Caption' : 'OCR'}{document.language ? ` · ${document.language}` : ''}</span><span className="max-w-40 truncate font-normal opacity-55" title={`${document.modelKey} ${document.modelVersion}`}>{document.modelKey} · {document.modelVersion}</span></div><p className="mt-1 whitespace-pre-wrap break-words leading-4">{document.text.slice(0, 1200)}{document.text.length > 1200 ? '…' : ''}</p></article>)}</div>}
          </details>}
          {detailError && <div role="alert" className="mt-2 flex gap-2 text-[10px] text-red-500"><AlertTriangle size={13} className="shrink-0" />{detailError}</div>}
          <dl className="mt-3 grid grid-cols-2 gap-y-2 text-xs"><dt className="opacity-60">类型</dt><dd className="text-right">{selectedAsset.kind}</dd><dt className="opacity-60">尺寸 / 时长</dt><dd className="text-right">{selectedAsset.metadata?.width || '—'}×{selectedAsset.metadata?.height || '—'}{selectedAsset.metadata?.duration ? ` · ${Number(selectedAsset.metadata.duration).toFixed(1)}s` : ''}</dd><dt className="opacity-60">存储模式</dt><dd className="text-right">{storageModeLabel(selectedAsset.storageMode)}</dd><dt className="opacity-60">源文件状态</dt><dd className={`text-right ${selectedAsset.availability === 'missing' || selectedAsset.availability === 'corrupt' ? 'text-red-500' : ''}`}>{availabilityLabel(selectedAsset.availability)}</dd><dt className="opacity-60">预览任务</dt><dd className={`text-right ${selectedAsset.metadata?.previewStatus === 'failed' ? 'text-red-500' : ''}`}>{selectedAsset.metadata?.previewStatus || 'ready'}</dd><dt className="opacity-60">健康</dt><dd className={`text-right ${selectedAsset.metadata?.health === 'corrupt' ? 'text-red-500' : ''}`}>{String(selectedAsset.metadata?.health || '未知')}</dd><dt className="opacity-60">来源</dt><dd className="truncate text-right" title={String(selectedAsset.provenance?.source || '')}>{String(selectedAsset.provenance?.source || '未知')}</dd><dt className="opacity-60">颜色 / 帧 / 音频</dt><dd className="truncate text-right" title={String(selectedAsset.metadata?.colorSpace || selectedAsset.metadata?.space || selectedAsset.metadata?.sampleRate || '')}>{String(selectedAsset.metadata?.colorSpace || selectedAsset.metadata?.space || (selectedAsset.metadata?.frameCount ? `${selectedAsset.metadata.frameCount} 帧` : '') || (selectedAsset.metadata?.sampleRate ? `${selectedAsset.metadata.sampleRate} Hz` : '—'))}</dd><dt className="opacity-60">感知哈希</dt><dd className="truncate text-right font-mono" title={`${selectedAsset.perceptualHashAlgorithm || selectedAsset.metadata?.perceptualHashAlgorithm || ''} ${selectedAsset.perceptualHash || ''}`}>{selectedAsset.perceptualHash ? `${selectedAsset.perceptualHashAlgorithm || selectedAsset.metadata?.perceptualHashAlgorithm || 'legacy'} · ${selectedAsset.perceptualHash}` : '—'}</dd></dl>
          {selectedAvailabilityRefreshInput && <button type="button" data-asset-availability-refresh disabled={Boolean(mutation)} className="mt-3 flex h-8 w-full items-center justify-center gap-1 rounded border border-[var(--border-primary)] text-[10px] font-bold disabled:opacity-40" onClick={() => void refreshSelectedAssetAvailability()}>{mutation === 'availability-refresh' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}校验源文件状态</button>}
          {selectedAsset.kind === 'video' && (selectedAsset.metadata?.contactSheetUrl || selectedAsset.metadata?.keyframeUrls?.length || selectedAsset.metadata?.firstFrameUrl || selectedAsset.metadata?.lastFrameUrl) && <details className="mt-3 border-y border-[var(--border-primary)] py-2 text-[10px]" data-asset-video-derived-preview>
            <summary className="cursor-pointer font-bold">关键帧与联系表</summary>
            {selectedAsset.metadata.contactSheetUrl && <img src={selectedAsset.metadata.contactSheetUrl} alt={`${selectedAsset.filename} 联系表`} className="mt-2 max-h-40 w-full rounded object-contain" loading="lazy" />}
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">{[...new Set([...(selectedAsset.metadata.keyframeUrls || []), selectedAsset.metadata.firstFrameUrl || '', selectedAsset.metadata.lastFrameUrl || ''].filter(Boolean))].slice(0, 12).map((url, index) => <img key={url} src={url} alt={`${selectedAsset.filename} 关键帧 ${index + 1}`} className="h-16 w-24 shrink-0 rounded object-cover" loading="lazy" />)}</div>
            {(selectedAsset.metadata.keyframeUrls?.length || 0) > 12 && <div className="mt-1 opacity-55">仅显示前 12 / {selectedAsset.metadata.keyframeUrls?.length} 张，避免详情面板一次挂载过多图片。</div>}
          </details>}
          {selectedAsset.metadata?.previewStatus === 'failed' && <div className="mt-3 rounded border border-red-500/40 bg-red-500/10 p-2 text-[10px] text-red-500"><div className="mb-2 break-words">{selectedAsset.metadata.previewError || '预览生成失败'}</div><button type="button" disabled={mutation === 'preview-retry'} className="h-8 w-full rounded border border-red-500 font-bold disabled:opacity-40" onClick={() => void retryPreview()}>{mutation === 'preview-retry' ? '正在提交…' : '重试预览任务'}</button></div>}
          <label className="mt-4 block text-xs font-semibold">标签<input value={tagDraft} className="mt-1 h-9 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 text-xs" placeholder="逗号分隔" onChange={(event) => setTagDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveTags(); }} /></label>
          <button type="button" disabled={mutation === 'tags'} className="mt-2 h-8 w-full rounded border border-[var(--border-primary)] text-[11px] font-bold disabled:opacity-40" onClick={() => void saveTags()}><Tags size={13} className="mr-1 inline" />保存标签</button>
          <div className="mt-4"><div className="mb-1 text-xs font-semibold">所属集合</div><div className="flex max-h-24 flex-wrap gap-1 overflow-auto">{collections.map((collection) => <button key={collection.id} type="button" disabled={mutation === `collection:${collection.id}`} aria-pressed={selectedAsset.collectionIds?.includes(collection.id)} className={`rounded border px-2 py-1 text-[10px] disabled:opacity-40 ${selectedAsset.collectionIds?.includes(collection.id) ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white' : 'border-[var(--border-primary)]'}`} onClick={() => void toggleCollection(collection.id)}>{collection.name}</button>)}{!collections.length && <span className="text-[10px] opacity-55">尚未创建集合</span>}</div></div>
          <details className="mt-3 rounded border border-[var(--border-primary)] p-2 text-[10px]" data-asset-permissions>
            <summary className="cursor-pointer font-semibold">素材授权 · {assetPermissions ? `${assetPermissions.scope === 'project' ? '项目可见' : '受限'} · revision ${assetPermissions.revision}` : '读取中'}</summary>
            {assetPermissions && <div className="mt-2 space-y-2">
              <label className="flex items-center justify-between gap-2"><span>访问范围</span><select aria-label="素材访问范围" value={permissionScopeDraft} className="h-7 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-1" onChange={(event) => setPermissionScopeDraft(event.target.value as 'project' | 'restricted')}><option value="project">项目成员</option><option value="restricted">仅授权主体</option></select></label>
              <div className="max-h-24 space-y-1 overflow-auto">{permissionGrantsDraft.map((grant) => <div key={`${grant.principalType}:${grant.principalId}`} className="flex items-center gap-1 rounded bg-[var(--bg-secondary)] px-1.5 py-1"><span className="min-w-0 flex-1 truncate" title={grant.principalId}>{grant.principalType === 'member' ? '成员' : '角色'} · {grant.principalId}</span><span className="opacity-55">{roleForAssetGrant(grant)}</span><button type="button" aria-label={`移除授权 ${grant.principalId}`} className="h-5 rounded border border-[var(--border-primary)] px-1" onClick={() => setPermissionGrantsDraft((current) => current.filter((item) => item.principalType !== grant.principalType || item.principalId !== grant.principalId))}>移除</button></div>)}{!permissionGrantsDraft.length && <div className="opacity-55">暂无单独授权</div>}</div>
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-1"><select aria-label="授权主体类型" value={permissionPrincipalType} className="h-7 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-1" onChange={(event) => setPermissionPrincipalType(event.target.value as 'member' | 'role')}><option value="member">成员</option><option value="role">角色</option></select><input aria-label="授权主体 ID" value={permissionPrincipalId} className="h-7 min-w-0 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-1" placeholder="主体 ID" onChange={(event) => setPermissionPrincipalId(event.target.value)} /><select aria-label="授权角色" value={permissionRole} className="h-7 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-1" onChange={(event) => setPermissionRole(event.target.value as 'owner' | 'editor' | 'viewer')}><option value="viewer">viewer</option><option value="editor">editor</option><option value="owner">owner</option></select></div>
              <div className="grid grid-cols-2 gap-1"><button type="button" className="h-7 rounded border border-[var(--border-primary)] font-semibold" onClick={addPermissionGrant}>添加 / 更新授权</button><button type="button" disabled={mutation === 'permissions'} className="h-7 rounded border border-[var(--accent-primary)] font-semibold text-[var(--accent-primary)] disabled:opacity-40" onClick={() => void saveAssetPermissions()}>保存权限</button></div>
              <p className="opacity-55">受限模式至少保留一个主体；保存使用独立权限 revision，冲突时不会静默覆盖。</p>
            </div>}
          </details>
          <button type="button" className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded bg-[var(--accent-primary)] text-xs font-bold text-white" onClick={() => onInsertAsset(selectedAsset)}><Play size={14} />添加到画布</button>
          <div className="mt-3 rounded border border-[var(--border-primary)] p-2 text-[10px]" data-asset-duplicates-panel>
            <div className="flex items-center justify-between gap-2"><strong>重复候选</strong><button type="button" disabled={mutation === 'duplicates'} className="h-7 rounded border border-[var(--border-primary)] px-2 font-bold disabled:opacity-40" onClick={() => void loadDuplicates(duplicateMode, false)}><ScanSearch size={12} className="mr-1 inline" />检测</button></div>
            <p className="mt-1 leading-4 opacity-60">候选关系只供人工确认，绝不会自动合并、删除或复用项目权限记录。</p>
            <div className="mt-1 flex gap-1" role="group" aria-label="重复候选类型">{(['all', 'exact', 'near'] as const).map((mode) => <button key={mode} type="button" aria-pressed={duplicateMode === mode} className={`h-7 flex-1 rounded border ${duplicateMode === mode ? 'border-[var(--accent-primary)] text-[var(--accent-primary)]' : 'border-[var(--border-primary)]'}`} onClick={() => void loadDuplicates(mode, false)}>{mode === 'all' ? '全部' : mode === 'exact' ? '精确 SHA-256' : '近似 pHash'}</button>)}</div>
            {duplicates.length > 0 && <div className="mt-2 max-h-64 space-y-2 overflow-auto border-y border-[var(--border-primary)] py-2">{duplicates.map((candidate) => <article key={candidate.id} className="rounded border border-[var(--border-primary)] p-2" data-asset-duplicate-kind={candidate.kind}>
              <button type="button" className="flex w-full justify-between gap-2 text-left font-semibold" onClick={() => selectAsset(candidate.asset)}><span className="truncate">{candidate.asset.filename}</span><span className="shrink-0">{candidate.kind === 'exact' ? '精确' : `距离 ${candidate.distance}`}</span></button>
              <div className="mt-1 flex flex-wrap gap-x-2 opacity-60"><span>算法 {candidate.algorithm || '—'}</span><span>状态 {candidate.decision}</span>{candidate.confidence && <span>置信 {candidate.confidence}</span>}{candidate.evidenceCount != null && <span>证据 {candidate.evidenceCount}</span>}{candidate.coverage != null && <span>覆盖 {(candidate.coverage * 100).toFixed(0)}%</span>}</div>
              {candidate.frameMatches.length > 0 && <div className="mt-1 max-h-16 overflow-auto font-mono opacity-70">{candidate.frameMatches.slice(0, 12).map((frame, index) => <div key={`${frame.sourceIndex}:${frame.targetIndex}:${index}`}>帧 {frame.sourceIndex} {formatAssetTimecode(frame.sourceTime)} ↔ {frame.targetIndex} {formatAssetTimecode(frame.targetTime)} · d={frame.distance} · {frame.algorithm}</div>)}</div>}
              {candidate.kind === 'near' ? <div className="mt-2 flex gap-1">{candidate.decision === 'pending' ? <><button type="button" disabled={mutation === `duplicate:${candidate.id}`} className="h-7 flex-1 rounded border border-[var(--accent-primary)] font-bold" onClick={() => void decideDuplicate(candidate, 'confirmed')}>确认重复</button><button type="button" disabled={mutation === `duplicate:${candidate.id}`} className="h-7 flex-1 rounded border border-[var(--border-primary)] font-bold" onClick={() => void decideDuplicate(candidate, 'dismissed')}>忽略</button></> : <button type="button" disabled={mutation === `duplicate:${candidate.id}`} className="h-7 w-full rounded border border-[var(--border-primary)] font-bold" onClick={() => void decideDuplicate(candidate, 'pending')}>撤销判断</button>}</div> : <div className="mt-2 rounded bg-[var(--bg-secondary)] px-2 py-1 text-center opacity-65">已由验证后的 SHA-256 确认，无需人工决策</div>}
            </article>)}</div>}
            {!duplicates.length && mutation !== 'duplicates' && <div className="mt-2 py-2 text-center opacity-55">尚未加载候选或当前没有匹配项</div>}
            {duplicatePages.length > 0 && <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-1"><button type="button" disabled={duplicatePageIndex === 0 || mutation === 'duplicates'} className="h-7 rounded border border-[var(--border-primary)] font-bold disabled:opacity-35" onClick={() => showDuplicatePage(duplicatePageIndex - 1)}>上一页</button><span className="px-1 text-center opacity-60">第 {duplicatePageIndex + 1} 页</span><button type="button" disabled={(!duplicateHasMore && !duplicatePages[duplicatePageIndex + 1]) || mutation === 'duplicates'} className="h-7 rounded border border-[var(--border-primary)] font-bold disabled:opacity-35" onClick={() => void loadDuplicates(duplicateMode, true)}>下一页</button></div>}
          </div>
          <div className="mt-4" data-asset-source-graph>
            <div className="flex items-center justify-between gap-2 text-xs font-semibold"><span>来源图</span>{sourceTree && <span className="text-[9px] opacity-55">本页 {sourceTree.nodes.length} 节点 / {sourceTree.edges.length} 边{sourceTree.totalNodes != null ? ` · 全图 ${sourceTree.totalNodes}/${sourceTree.totalEdges ?? '—'}` : ''}</span>}</div>
            {sourceTree && <>
              {(sourceTree.truncated || sourceTree.cycleDetected) && <div className="mt-1 flex flex-wrap gap-1 text-[9px]">{sourceTree.hasMore && <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-blue-600">还有后续分页</span>}{sourceTree.truncated && !sourceTree.hasMore && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600">达到来源图安全上限</span>}{sourceTree.cycleDetected && <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">检测到来源环</span>}</div>}
              <div className="mt-1 max-h-40 overflow-auto border-y border-[var(--border-primary)] py-1 text-[10px]" role="list" aria-label="素材祖先与后代">{sourceTree.nodes.map((node) => <button key={node.assetId} type="button" role="listitem" disabled={node.tombstone} className={`flex w-full items-center gap-2 py-1 text-left disabled:cursor-not-allowed disabled:opacity-45 ${node.assetId === sourceTree.rootAssetId ? 'font-bold text-[var(--accent-primary)]' : ''}`} style={{ paddingLeft: Math.min(6, node.depth) * 8 }} onClick={() => void activateSourceNode(node.assetId)}><span className="w-12 shrink-0 opacity-55">{node.direction === 'ancestor' ? '祖先' : node.direction === 'descendant' ? '后代' : '当前'}</span><span className="truncate">{node.asset?.filename || node.filename || node.assetId}{node.tombstone ? '（已删除）' : ''}</span></button>)}</div>
              <details className="mt-1 text-[9px]"><summary className="cursor-pointer font-semibold">显示 {sourceTree.edges.length} 条来源边</summary><div className="mt-1 max-h-24 overflow-auto font-mono opacity-60">{sourceTree.edges.map((edge) => <div key={edge.id} className="truncate" title={`${edge.fromAssetId} -> ${edge.toAssetId}`}>{edge.fromAssetId.slice(0, 8)} → {edge.toAssetId.slice(0, 8)} · {edge.relation}</div>)}</div></details>
              <div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-center gap-1 text-[9px]"><button type="button" disabled={sourceTreePageIndex === 0 || mutation === 'source-tree'} className="h-7 rounded border border-[var(--border-primary)] font-semibold disabled:opacity-35" onClick={() => showSourceTreePage(sourceTreePageIndex - 1)}>上一页</button><span className="px-1 opacity-60">第 {sourceTreePageIndex + 1} 页</span><button type="button" disabled={(!sourceTree.hasMore && !sourceTreePages[sourceTreePageIndex + 1]) || mutation === 'source-tree'} className="h-7 rounded border border-[var(--border-primary)] font-semibold disabled:opacity-35" onClick={() => void loadNextSourceTreePage()}>{mutation === 'source-tree' ? '读取中…' : '下一页'}</button></div>
            </>}
            {!sourceTree && !detailLoading && <div className="mt-1 py-2 text-[10px] opacity-55">未找到有界祖先/后代来源图</div>}
            {lineagePage && lineage.length > 0 && <details className="mt-1 text-[10px]"><summary className="cursor-pointer font-semibold">来源事件（本页 {lineage.length} / 共 {lineagePage.total}）</summary><div className="mt-1 max-h-28 overflow-auto border-y border-[var(--border-primary)]">{lineage.map((item) => <div key={item.id} className="py-1"><span className="font-semibold">{item.sourceType || item.relation}</span>{item.sourceNodeId ? ` · 节点 ${item.sourceNodeId.slice(0, 12)}` : ''}{item.parentAssetId ? ` · 父素材 ${item.parentAssetId.slice(0, 10)}` : ''}{item.runId ? ` · Run ${item.runId.slice(0, 8)}` : ''}</div>)}</div><div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-center gap-1 text-[9px]"><button type="button" disabled={(lineagePageIndex === 0 && lineagePageOffset === 0) || lineageLoading} className="h-7 rounded border border-[var(--border-primary)] font-semibold disabled:opacity-35" onClick={() => lineagePageIndex > 0 ? showLineagePage(lineagePageIndex - 1) : reloadFirstLineagePage()}>{lineagePageIndex === 0 && lineagePageOffset > 0 ? '回第一页' : '上一页'}</button><span className="px-1 opacity-60">第 {lineagePageOffset + lineagePageIndex + 1} / {Math.max(1, Math.ceil(lineagePage.total / lineagePage.limit))} 页</span><button type="button" disabled={(!lineagePage.hasMore && !lineagePages[lineagePageIndex + 1]) || lineageLoading} className="h-7 rounded border border-[var(--border-primary)] font-semibold disabled:opacity-35" onClick={loadNextLineagePage}>{lineageLoading ? '读取中…' : '下一页'}</button></div></details>}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[var(--border-primary)] pt-3"><button type="button" disabled={mutation === 'remove-index'} className="h-9 rounded border border-[var(--border-primary)] text-[10px] font-bold disabled:opacity-40" onClick={() => void removeIndex()}>移除索引</button><button type="button" disabled={selectedAsset.storageMode !== 'managed' || selectedAsset.availability === 'missing'} className="flex h-9 items-center justify-center gap-1 rounded border border-red-500 text-[10px] font-bold text-red-500 disabled:cursor-not-allowed disabled:opacity-30" onClick={() => setDeleteDraft({ asset: selectedAsset, confirmation: '' })}><Trash2 size={13} />删除原文件</button></div>
          <p className="mt-1 text-[9px] leading-4 opacity-55">移除索引始终保留源文件；删除原文件只对受管 input/output 副本开放并需输入完整文件名。链接素材和远程外链永不通过此入口删除。</p>
        </> : <div className="grid min-h-56 place-items-center text-xs opacity-60">选择素材查看详情；滚动和切换视图不会清空选择</div>}
      </aside>
    </div>

    {deleteDraft && <div className="absolute inset-0 z-20 grid place-items-center bg-black/60 p-4"><div className="w-full max-w-md rounded-md border-2 border-red-500 bg-[var(--bg-secondary)] p-5 text-[var(--text-primary)]"><div className="flex items-center gap-3"><Trash2 size={20} className="text-red-500" /><div className="min-w-0 flex-1"><h3 className="text-sm font-bold">永久删除原文件</h3><p className="text-xs text-[var(--text-secondary)]">此操作同时移除索引，无法撤销。</p></div><button type="button" aria-label="关闭删除确认" className="grid h-8 w-8 place-items-center" onClick={() => setDeleteDraft(null)}><X size={16} /></button></div><p className="mt-4 break-all rounded border border-red-500/40 bg-red-500/10 p-3 text-xs">请输入完整文件名：<strong>{deleteDraft.asset.filename}</strong></p><input autoFocus aria-label="输入完整文件名确认删除" value={deleteDraft.confirmation} className="mt-3 h-10 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 text-sm" onChange={(event) => setDeleteDraft({ ...deleteDraft, confirmation: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter' && deleteDraft.confirmation === deleteDraft.asset.filename) void confirmDeleteFile(); }} /><div className="mt-5 flex justify-end gap-2"><button type="button" className="h-9 rounded border border-[var(--border-primary)] px-4 text-xs font-bold" onClick={() => setDeleteDraft(null)}>取消</button><button type="button" className="h-9 rounded bg-red-500 px-4 text-xs font-bold text-white disabled:opacity-40" disabled={deleteDraft.confirmation !== deleteDraft.asset.filename || mutation === 'delete-file'} onClick={() => void confirmDeleteFile()}>永久删除</button></div></div></div>}
  </section>;
}
