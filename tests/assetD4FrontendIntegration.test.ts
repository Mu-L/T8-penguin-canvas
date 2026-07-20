import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canUseAssetQuerySelection } from '../src/components/assets/assetD4State.ts';

const read = (relativePath: string) => readFileSync(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8',
).replace(/\r\n?/g, '\n');

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('keyword keeps its isolated 250ms debounce while semantic text commits only by Enter or button', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const keywordEffect = between(
    center,
    "useEffect(() => {\n    if (searchMode !== 'keyword') return undefined;",
    '  const filterKey = useMemo',
  );
  const semanticSubmit = between(
    center,
    '  const submitSemanticSearch = useCallback(() => {',
    '  const refreshSelectedAsset = useCallback',
  );
  const searchControls = between(
    center,
    "        {searchMode === 'keyword'",
    '        <label><span className="sr-only">素材类型</span>',
  );

  assert.match(keywordEffect, /window\.setTimeout\(\(\) => setQuery\(queryInput\.trim\(\)\), 250\)/);
  assert.match(keywordEffect, /window\.clearTimeout\(timer\)/);
  assert.match(keywordEffect, /\[queryInput, searchMode\]/);
  assert.doesNotMatch(keywordEffect, /semanticQueryInput|setSemanticQuery/);

  assert.match(semanticSubmit, /normalizeAssetSemanticQuery\(semanticQueryInput\)/);
  assert.match(semanticSubmit, /else setSemanticQuery\(normalized\)/);
  assert.match(searchControls, /onChange=\{\(event\) => setSemanticQueryInput\(event\.target\.value\)\}/);
  assert.match(searchControls, /event\.key === 'Enter' && !event\.nativeEvent\.isComposing/);
  assert.match(searchControls, /onClick=\{submitSemanticSearch\}>检索<\/button>/);
  assert.doesNotMatch(searchControls, /onChange=\{[^}]*submitSemanticSearch/);
});

test('search mode is explicit and semantic empty states report the real lifecycle', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const emptyMessages = between(center, 'function semanticEmptyMessage(', 'function normalizePipelineStatus');
  const modeControls = between(
    center,
    '<div className="flex h-10 shrink-0 overflow-hidden rounded border border-[var(--border-primary)]" role="group" aria-label="素材搜索模式">',
    "        {searchMode === 'keyword'",
  );

  assert.match(modeControls, /aria-pressed=\{searchMode === 'keyword'\}[\s\S]*changeSearchMode\('keyword'\)[\s\S]*>关键词<\/button>/);
  assert.match(modeControls, /aria-pressed=\{searchMode === 'semantic'\}[\s\S]*changeSearchMode\('semantic'\)[\s\S]*>自然语言<\/button>/);

  assert.match(emptyMessages, /query-empty'[\s\S]*按 Enter 或点击“检索”[\s\S]*不会自动提交/);
  assert.match(emptyMessages, /no-results'[\s\S]*没有匹配/);
  assert.match(emptyMessages, /model-missing'[\s\S]*不会自动下载大模型/);
  assert.match(emptyMessages, /model-downloading'[\s\S]*下载或校验/);
  assert.match(emptyMessages, /project-disabled'[\s\S]*关键词搜索仍可正常使用/);
  assert.match(emptyMessages, /index-empty'[\s\S]*没有可用的语义索引/);
  assert.match(emptyMessages, /index-building'[\s\S]*正在构建/);
  assert.match(emptyMessages, /index-stale'[\s\S]*上一个索引代次/);
  assert.match(emptyMessages, /index-error'[\s\S]*构建失败/);
  assert.match(emptyMessages, /network-error'[\s\S]*暂不可用/);
});

test('preview status preserves pressure evidence and never presents cached zero counts as idle', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const types = read('src/types/project.ts');
  const normalizer = between(center, 'function normalizePipelineStatus(', 'function AssetDetailPreview(');
  const statusUi = between(center, 'data-asset-pipeline-status>', '      <div className="mt-2"><AssetSemanticSettingsPanel');

  assert.match(types, /databaseStatusStale\?: boolean/);
  assert.match(types, /previews: \{[\s\S]*projectId: string;[\s\S]*concurrencyScope: 'global'/);
  assert.match(types, /storagePressure\?: \{/);
  assert.match(types, /databaseBusy\?: \{/);
  assert.match(normalizer, /preview\?\.databaseStatusStale === true/);
  assert.match(normalizer, /storagePressure\?\.active/);
  assert.match(normalizer, /databaseBusy\?\.active/);
  assert.match(normalizer, /status\.previews\.databaseStatusStale === true/);
  assert.match(statusUi, /数据库状态为缓存值，当前计数不能视为空闲/);
  assert.match(statusUi, /全局存储压力，预览写入等待恢复/);
  assert.match(statusUi, /全局数据库忙，预览队列正在退避/);
  assert.match(statusUi, /本项目活动/);
  assert.match(statusUi, /全局槽位上限/);
  assert.doesNotMatch(normalizer, /\|\| status\.previews\.storagePressure\?\.active === true[\s\S]*\|\| status\.previews\.databaseBusy\?\.active === true/);
});

test('availability repair is one explicit frozen-identity mutation with selection, project, and request-epoch guards', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const types = read('src/types/project.ts');
  const frozenIdentity = between(center, 'function frozenAssetAvailabilityInput(', 'function semanticEmptyMessage(');
  const handler = between(
    center,
    "  const refreshSelectedAssetAvailability = () => runMutation('availability-refresh', async () => {",
    "  const retryPreview = () => runMutation('preview-retry', async () => {",
  );
  const preview = between(center, 'function AssetDetailPreview(', 'export default function AssetCenter(');
  const button = between(center, 'selectedAvailabilityRefreshInput &&', "{selectedAsset.kind === 'video'");

  assert.match(types, /export interface AssetAvailabilityRefreshInput \{[\s\S]*projectId: string;[\s\S]*expectedCatalogRevision: AssetRevision;[\s\S]*entityUid: string;[\s\S]*contentRevision: number;[\s\S]*organizationRevision: AssetRevision;[\s\S]*contentHash: string;/);
  assert.match(types, /state: 'available' \| 'missing' \| 'source-changed' \| 'indeterminate'/);
  assert.match(frozenIdentity, /asset\.storageMode !== 'managed' && asset\.storageMode !== 'linked'/);
  assert.match(frozenIdentity, /\[1-8\]\[0-9a-f\]\{3\}/, 'UUIDv7 frozen identities must be accepted');
  assert.match(frozenIdentity, /\^\[a-f0-9\]\{64\}\$/);
  assert.match(frozenIdentity, /Number\.isSafeInteger\(expectedCatalogRevision\)/);
  assert.match(handler, /catalogRevisionRef\.current/);
  assert.match(handler, /runSelectedMutationRequest\(targetId/);
  assert.match(handler, /api\.refreshProjectAssetAvailability\(targetId, input, \{ signal: controller\.signal \}\)/);
  assert.match(handler, /corruptionPreserved[\s\S]*保留既有素材损坏判定/);
  assert.match(handler, /requestEpoch !== availabilityRefreshEpochRef\.current/);
  assert.match(handler, /pipelineProjectRef\.current !== expectedProjectId/);
  assert.match(handler, /!canApplySelectedMutation\(targetId, revision\)/);
  assert.match(handler, /error instanceof api\.ApiRequestError && error\.status === 409[\s\S]*resetCatalog\(activeFiltersRef\.current\)[\s\S]*不会自动重放写请求/);
  assert.match(handler, /error instanceof api\.ApiRequestError && error\.status === 507[\s\S]*源文件状态未更新/);
  assert.equal((handler.match(/api\.refreshProjectAssetAvailability\(/g) || []).length, 1, 'no automatic POST replay path');
  assert.doesNotMatch(preview, /refreshProjectAssetAvailability|availability\/refresh/);
  assert.match(button, /data-asset-availability-refresh/);
  assert.match(button, /校验源文件状态/);
  assert.match(button, /disabled=\{Boolean\(mutation\)\}/);
});

test('pipeline polling and scanning stay bound to one project and discard stale response epochs', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const types = read('src/types/project.ts');
  const pipeline = between(center, '  const loadPipelineStatus = useCallback(async (signal?: AbortSignal) => {', '  useEffect(() => {\n    let stopped = false;');
  const scan = between(
    center,
    "  const scanAssets = () => runMutation('scan', async () => {",
    "  const refreshSelectedAssetAvailability = () => runMutation('availability-refresh', async () => {",
  );

  assert.match(types, /export interface AssetIndexResult \{[\s\S]*projectId: string;[\s\S]*catalogRevision: AssetRevision;/);
  assert.match(types, /export interface AssetPipelineStatus \{[\s\S]*projectId: string;[\s\S]*scan: \{[\s\S]*projectId: string;[\s\S]*running: boolean;/);
  assert.match(pipeline, /api\.getProjectAssetPipelineStatus\(expectedProjectId, \{ signal \}\)/);
  assert.match(pipeline, /requestEpoch !== pipelineRequestEpochRef\.current/);
  assert.match(pipeline, /pipelineProjectRef\.current !== expectedProjectId/);
  assert.match(pipeline, /next\.projectId !== expectedProjectId/);
  assert.match(pipeline, /next\.scan\.projectId !== expectedProjectId/);
  assert.match(pipeline, /next\.previews\.projectId !== expectedProjectId/);
  assert.match(scan, /api\.scanProjectAssets\(expectedProjectId, \{ signal: controller\.signal \}\)/);
  assert.match(scan, /requestEpoch !== scanRequestEpochRef\.current/);
  assert.match(scan, /result\.projectId !== expectedProjectId/);
  assert.match(scan, /sourceChanged/);
  assert.match(scan, /indeterminate/);
  assert.doesNotMatch(pipeline, /refreshProjectAssetAvailability|availability\/refresh/);
});

test('semantic virtual pages are pinned to one identity and a 409 clears cached UI evidence and selection', () => {
  const hook = read('src/components/assets/useAssetSemanticCatalog.ts');
  const center = read('src/components/assets/AssetCenter.tsx');
  const invalidation = between(hook, '  const invalidate = useCallback((message = \'\') => {', '  const recoverConflict = useCallback');
  const requestPage = between(hook, '  const requestPage = useCallback(async (', '  useEffect(() => {');
  const conflictUi = between(
    center,
    '  useEffect(() => {\n    if (semanticCatalog.conflictRevision === semanticConflictSeenRef.current) return;',
    '  const requestPage = useCallback(async (',
  );

  assert.match(requestPage, /const expectedIdentity = identityRef\.current/);
  assert.match(requestPage, /expectedCatalogRevision: expectedIdentity\?\.catalogRevision \?\? status\.project\.currentCatalogRevision/);
  assert.match(requestPage, /expectedProfileRevision: Number\(status\.project\.revision\)/);
  assert.match(requestPage, /expectedGeneration: expectedIdentity\?\.activeGeneration \?\? status\.project\.activeGeneration/);
  assert.match(requestPage, /page\.offset !== offset \|\| !page\.identity\.queryDigest \|\| page\.identity\.projectId !== options\.projectId/);
  assert.match(requestPage, /assetSemanticSearchIdentityMatches\(identityRef\.current, page\.identity\)/);
  assert.match(requestPage, /if \(!identityRef\.current\) identityRef\.current = page\.identity/);
  assert.match(requestPage, /caught instanceof api\.ApiRequestError && caught\.status === 409\) recoverConflict\(\)/);

  assert.match(invalidation, /controllersRef\.current\.forEach\(\(controller\) => controller\.abort\(\)\)/);
  assert.match(invalidation, /pagesRef\.current = new Map\(\)/);
  assert.match(invalidation, /identityRef\.current = null/);
  assert.match(invalidation, /setTotal\(0\)/);
  assert.match(conflictUi, /setBatchSelection\(EMPTY_ASSET_SELECTION\)/);
  assert.match(conflictUi, /setSelectedAssetId\(null\)/);
  assert.match(conflictUi, /setSelectedAsset\(null\)/);
  assert.match(conflictUi, /setSemanticDocuments\(\[\]\)/);
  assert.match(conflictUi, /旧结果、证据与选择已清空/);
});

test('semantic selection forbids query-wide selection and allows only an already loaded explicit range', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const semanticRange = between(
    center,
    "      if (searchMode === 'semantic') {",
    '      const offsets = assetPageOffsetsForRange',
  );
  const selectCurrentFilter = between(
    center,
    '  const selectCurrentFilter = useCallback(() => {',
    '  const clearBatchSelection = useCallback',
  );

  assert.equal(canUseAssetQuerySelection('semantic'), false);
  assert.equal(canUseAssetQuerySelection('keyword'), true);
  assert.match(semanticRange, /const asset = browserGetItem\(index\)/);
  assert.match(semanticRange, /未加载项；请先滚动到该范围后重试/);
  assert.match(semanticRange, /selectAssetBatchRange\(current, assets, additive\)/);
  assert.doesNotMatch(semanticRange, /listProjectAssets|queryAssetSelection/);
  assert.match(selectCurrentFilter, /if \(!canUseAssetQuerySelection\(searchMode\)\)[\s\S]*只支持逐项或已加载范围的显式选择[\s\S]*return/);
  assert.match(center, /disabled=\{searchMode === 'semantic' \|\| !browserTotal[\s\S]*onClick=\{selectCurrentFilter\}>全选当前筛选/);
});

test('semantic cards and details render raw RRF or Cosine scores and keep Caption/OCR evidence bounded', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const browser = read('src/components/assets/AssetVirtualBrowser.tsx');
  const cardScore = between(browser, '  const semanticLabel = semanticHit', '  const handleCardClick =');
  const detailEvidence = between(center, 'data-asset-semantic-evidence>', '          </section>}');
  const indexedDocuments = between(center, 'data-asset-semantic-documents>', '          </details>}');

  assert.match(cardScore, /metric === 'rrf' \? 'RRF'/);
  assert.match(cardScore, /metric === 'cosine' \? 'Cosine'/);
  assert.match(cardScore, /semanticHit\.score\.toFixed\(4\)/);
  assert.doesNotMatch(cardScore, /score\s*\*\s*100|score\s*\/\s*100|score[^\n]*%/);

  assert.match(detailEvidence, /metric === 'rrf' \? 'RRF\(k=60\)'/);
  assert.match(detailEvidence, /metric === 'cosine' \? 'Cosine'/);
  assert.match(detailEvidence, /selectedSemanticHit\.score\.toFixed\(4\)/);
  assert.match(detailEvidence, /这是检索评分，不是置信度百分比/);
  assert.match(detailEvidence, /selectedSemanticHit\.evidence\.slice\(0, 3\)/);
  assert.doesNotMatch(detailEvidence, /score\s*\*\s*100|score\s*\/\s*100/);

  assert.match(indexedDocuments, /Caption \/ OCR 证据/);
  assert.match(indexedDocuments, /semanticDocuments\.slice\(0, 8\)/);
  assert.match(indexedDocuments, /document\.text\.slice\(0, 1200\)/);
  assert.match(indexedDocuments, /document\.text\.length > 1200 \? '…'/);
});

test('AssetCenter gives the settings panel sole semantic status I/O ownership without automatic model downloads', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const settings = read('src/components/assets/AssetSemanticSettingsPanel.tsx');
  const beforeExplicitDownloadHandler = settings.slice(0, settings.indexOf('  const downloadModel ='));
  const conflictRefresh = between(
    center,
    '  const requestSemanticStatusRefresh = useCallback(() => {',
    '  const semanticCatalog = useAssetSemanticCatalog({',
  );

  assert.match(center, /import AssetSemanticSettingsPanel from '\.\/AssetSemanticSettingsPanel'/);
  assert.match(center, /<AssetSemanticSettingsPanel projectId=\{assetProjectId\} externalRefreshToken=\{semanticStatusRefreshToken\} onStatusChange=\{acceptSemanticStatus\} \/>/);
  assert.match(center, /onConflict: requestSemanticStatusRefresh/);
  assert.match(conflictRefresh, /setSemanticStatus\(null\)/);
  assert.match(conflictRefresh, /semanticStatusRefreshEpochRef\.current = nextEpoch/);
  assert.match(conflictRefresh, /setSemanticStatusRefreshToken\(nextEpoch\)/);
  assert.match(center, /refreshEpoch !== semanticStatusRefreshEpochRef\.current[\s\S]*next\.project\.projectId !== semanticStatusProjectRef\.current[\s\S]*setSemanticStatus\(next\)/);
  assert.doesNotMatch(center, /getProjectAssetSemanticStatus|semanticStatusRefreshControllerRef|assetProjectIdRef/);
  assert.match(settings, /externalRefreshToken = 0/);
  assert.match(settings, /\[acceptStatus, externalRefreshToken, projectId, refreshToken\]/);
  assert.match(settings, /const sourceRefreshToken = externalRefreshToken;[\s\S]*acceptStatus\(next, false, sourceRefreshToken\)/);
  assert.match(settings, /const sourceRefreshToken = externalRefreshTokenRef\.current;[\s\S]*applyResult\(result, sourceRefreshToken\)/);
  assert.match(settings, /onStatusChangeRef\.current\?\.\(next, sourceRefreshToken\)/);
  assert.doesNotMatch(center, /downloadProjectAssetSemanticModel/);
  assert.doesNotMatch(beforeExplicitDownloadHandler, /downloadProjectAssetSemanticModel\(/);
  assert.match(settings, /window\.confirm\([\s\S]*本机大模型[\s\S]*绝不会自动下载模型/);
  assert.match(settings, /const downloadModel = \(model: AssetSemanticModelStatus\) => \{[\s\S]*downloadProjectAssetSemanticModel\(model\.key/);
});
