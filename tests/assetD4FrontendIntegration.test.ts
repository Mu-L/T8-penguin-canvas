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

test('AssetCenter wires the settings panel without introducing any automatic model download path', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const settings = read('src/components/assets/AssetSemanticSettingsPanel.tsx');
  const beforeExplicitDownloadHandler = settings.slice(0, settings.indexOf('  const downloadModel ='));

  assert.match(center, /import AssetSemanticSettingsPanel from '\.\/AssetSemanticSettingsPanel'/);
  assert.match(center, /<AssetSemanticSettingsPanel projectId=\{assetProjectId\} onStatusChange=\{setSemanticStatus\} \/>/);
  assert.doesNotMatch(center, /downloadProjectAssetSemanticModel/);
  assert.doesNotMatch(beforeExplicitDownloadHandler, /downloadProjectAssetSemanticModel\(/);
  assert.match(settings, /window\.confirm\([\s\S]*本机大模型[\s\S]*绝不会自动下载模型/);
  assert.match(settings, /const downloadModel = \(model: AssetSemanticModelStatus\) => \{[\s\S]*downloadProjectAssetSemanticModel\(model\.key/);
});
