import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ASSET_PAGE_CACHE_LIMIT,
  ASSET_PAGE_REQUEST_LIMIT,
  ASSET_PAGE_SIZE,
  ASSET_VIRTUAL_OVERSCAN_ROWS,
  assetIndexScrollTop,
  assetPageOffsetsForRange,
  assetScrollAnchorIndex,
  calculateAssetVirtualWindow,
  readAssetPageItem,
  updateAssetPageLru,
} from '../src/utils/assetVirtualization.ts';
import {
  assetPipelineSignature,
  isCurrentAssetSelection,
  shouldInvalidateAssetCatalog,
} from '../src/utils/assetCenterState.ts';
import {
  MAX_INTERACTIVE_MODEL_BYTES,
  decideInteractiveAssetModel,
} from '../src/utils/assetModelPreviewSecurity.ts';

const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('10,000 item grid renders only visible and overscan rows at top, middle, and bottom', () => {
  const top = calculateAssetVirtualWindow({
    itemCount: 10_000,
    viewportWidth: 640,
    viewportHeight: 600,
    scrollTop: 0,
    mode: 'grid',
  });
  assert.equal(top.columns, 3);
  assert.equal(top.startIndex, 0);
  assert.ok(top.endIndex < 100);
  assert.ok(top.renderedItemLimit < 100);
  assert.ok(top.totalHeight > 600_000);

  const middle = calculateAssetVirtualWindow({
    itemCount: 10_000,
    viewportWidth: 640,
    viewportHeight: 600,
    scrollTop: top.totalHeight / 2,
    mode: 'grid',
  });
  assert.ok(middle.startIndex > 4_000);
  assert.ok(middle.endIndex < 6_000);
  assert.ok(middle.endIndex - middle.startIndex <= middle.renderedItemLimit);
  assert.ok(middle.renderedItemLimit < 100);

  const bottom = calculateAssetVirtualWindow({
    itemCount: 10_000,
    viewportWidth: 640,
    viewportHeight: 600,
    scrollTop: Number.MAX_SAFE_INTEGER,
    mode: 'grid',
  });
  assert.equal(bottom.endIndex, 10_000);
  assert.ok(bottom.startIndex > 9_900);
  assert.ok(bottom.renderedItemLimit < 100);
});

test('list mode is independently virtualized and empty catalogs are safe', () => {
  const list = calculateAssetVirtualWindow({
    itemCount: 10_000,
    viewportWidth: 900,
    viewportHeight: 720,
    scrollTop: 200_000,
    mode: 'list',
  });
  assert.equal(list.columns, 1);
  assert.ok(list.endIndex - list.startIndex <= 16);
  assert.equal(list.startRow, list.startIndex);
  assert.equal(list.endIndex, list.endRow + 1);

  const empty = calculateAssetVirtualWindow({ itemCount: 0, viewportWidth: 0, viewportHeight: 0, scrollTop: -1, mode: 'grid' });
  assert.equal(empty.totalHeight, 0);
  assert.equal(empty.endRow, -1);
  assert.deepEqual([empty.startIndex, empty.endIndex, empty.renderedItemLimit], [0, 0, 0]);
});

test('visible ranges map to bounded 120-item server pages', () => {
  assert.equal(ASSET_PAGE_SIZE, 120);
  assert.equal(ASSET_PAGE_CACHE_LIMIT, 8);
  assert.equal(ASSET_PAGE_REQUEST_LIMIT, 6);
  assert.equal(ASSET_VIRTUAL_OVERSCAN_ROWS, 3);
  assert.deepEqual(assetPageOffsetsForRange(0, 1), [0]);
  assert.deepEqual(assetPageOffsetsForRange(119, 121), [0, 120]);
  assert.deepEqual(assetPageOffsetsForRange(7_199, 7_441), [7_080, 7_200, 7_320, 7_440]);
  assert.deepEqual(assetPageOffsetsForRange(10, 10), []);
});

test('idle-to-idle pipeline terminal changes invalidate catalog and selection guards reject stale mutations', () => {
  const idle = {
    scan: { running: false, lastResult: null },
    previews: {
      active: 0,
      concurrency: 2,
      counts: { queued: 0, running: 0, retrying: 0, succeeded: 9, failed: 1 },
      nextAttemptAt: null,
    },
  };
  const completedBetweenPolls = {
    ...idle,
    previews: { ...idle.previews, counts: { ...idle.previews.counts, succeeded: 10 } },
  };
  const previousSignature = assetPipelineSignature(idle);
  const nextSignature = assetPipelineSignature(completedBetweenPolls);
  assert.equal(shouldInvalidateAssetCatalog('', previousSignature), false, 'first status sample must not churn the catalog');
  assert.equal(shouldInvalidateAssetCatalog(previousSignature, nextSignature), true, 'a queued-to-terminal job may finish entirely between polls');
  assert.equal(shouldInvalidateAssetCatalog(previousSignature, assetPipelineSignature({
    ...idle,
    previews: { ...idle.previews, counts: { ...idle.previews.counts, queued: 1 } },
  })), false, 'queued-only churn must not reset or refetch the virtual catalog');
  assert.equal(isCurrentAssetSelection('asset-b', 'asset-a'), false);
  assert.equal(isCurrentAssetSelection('asset-a', 'asset-a'), true);
});

test('interactive 3D gate only accepts bounded same-origin self-contained verified GLB OBJ STL', () => {
  const pageUrl = 'http://127.0.0.1:11422/workbench';
  const safeGlb = {
    format: 'glb',
    health: 'ok',
    previewStatus: 'ready' as const,
    modelPreviewUrl: '/files/thumbnails/model.webp',
    size: 1024,
    vertices: 3,
    triangles: 1,
    textures: 0,
    references: [],
  };
  const contentHash = 'a'.repeat(64);
  const decide = (
    url: string,
    metadata: Parameters<typeof decideInteractiveAssetModel>[1],
    availability: Parameters<typeof decideInteractiveAssetModel>[3] = 'available',
    hash = contentHash,
  ) => decideInteractiveAssetModel(url, metadata, pageUrl, availability, hash);
  assert.deepEqual(decide('/api/project-assets/model/media', safeGlb), {
    allowed: true,
    format: 'glb',
    url: 'http://127.0.0.1:11422/api/project-assets/model/media',
  });
  assert.equal(decide('https://example.com/model.glb', safeGlb).allowed, false);
  assert.equal(decide('http://127.0.0.1:18766/model.glb', safeGlb).allowed, false, 'other loopback ports are not same-origin');
  assert.equal(decide('/model.glb', safeGlb, 'missing').allowed, false);
  assert.equal(decide('/model.glb', safeGlb, 'available', '').allowed, false, 'interactive bytes must be bound to the indexed SHA-256');
  assert.equal(decide('/model.glb', { ...safeGlb, health: 'corrupt' }).allowed, false);
  assert.equal(decide('/model.glb', { ...safeGlb, modelPreviewUrl: 'https://example.com/preview.webp' }).allowed, false);
  assert.equal(decide('/model.glb', { ...safeGlb, format: 'gltf' }).allowed, false);
  assert.equal(decide('/model.glb', { ...safeGlb, references: [{ reference: 'https://example.com/texture.png' }] }).allowed, false);
  assert.equal(decide('/model.glb', { ...safeGlb, textures: 1 }).allowed, false, 'texture-bearing GLB stays on the static backend preview');
  assert.equal(decide('/model.glb', { ...safeGlb, size: MAX_INTERACTIVE_MODEL_BYTES + 1 }).allowed, false);
  assert.equal(decide('/model.glb', { ...safeGlb, vertices: 999_999 }).allowed, false);
  assert.equal(decide('/model.obj', { ...safeGlb, format: 'obj', references: [{ reference: 'material.mtl', exists: true }] }).allowed, false);
  assert.equal(decide('/model.stl', {
    ...safeGlb,
    format: 'stl',
    health: 'unverified',
    references: [],
    vertices: undefined,
    triangles: undefined,
  }).allowed, true, 'ready static STL output is the bounded backend parser verification');
});

test('page cache is sparse, LRU bounded, touch-aware, and index-addressable', () => {
  let pages = new Map<number, readonly string[]>();
  for (let page = 0; page < 9; page += 1) {
    const offset = page * ASSET_PAGE_SIZE;
    pages = updateAssetPageLru(pages, offset, [`asset-${offset}`, `asset-${offset + 1}`]);
  }
  assert.equal(pages.size, 8);
  assert.equal(pages.has(0), false);
  assert.equal(readAssetPageItem(pages, 120), 'asset-120');
  assert.equal(readAssetPageItem(pages, 121), 'asset-121');
  assert.equal(readAssetPageItem(pages, 122), undefined);

  pages = updateAssetPageLru(pages, 120, pages.get(120) || []);
  pages = updateAssetPageLru(pages, 9 * ASSET_PAGE_SIZE, ['asset-1080']);
  assert.equal(pages.size, 8);
  assert.equal(pages.has(120), true, 'touching a page must keep it in the LRU');
  assert.equal(pages.has(240), false, 'the next oldest page should be evicted');
});

test('scroll anchors preserve the same item when grid columns or view mode change', () => {
  const originalIndex = assetScrollAnchorIndex(4_321, 4, 204);
  assert.equal(originalIndex % 4, 0);
  const nextGridTop = assetIndexScrollTop(originalIndex, 3, 204);
  const nextGridAnchor = assetScrollAnchorIndex(nextGridTop, 3, 204);
  assert.ok(nextGridAnchor <= originalIndex);
  assert.ok(originalIndex - nextGridAnchor < 3);
  const listTop = assetIndexScrollTop(originalIndex, 1, 90);
  assert.equal(assetScrollAnchorIndex(listTop, 1, 90), originalIndex);
});

test('asset center wiring enforces virtual DOM, async ordering, derived previews, and D1 actions', () => {
  const center = read('src/components/assets/AssetCenter.tsx');
  const browser = read('src/components/assets/AssetVirtualBrowser.tsx');
  const modelPreview = read('src/components/assets/AssetModel3DPreview.tsx');
  const workbench = read('src/components/ProjectWorkbench.tsx');
  const api = read('src/services/api.ts');
  const types = read('src/types/project.ts');

  assert.match(center, /ASSET_PAGE_SIZE/);
  assert.match(center, /ASSET_PAGE_CACHE_LIMIT/);
  assert.match(center, /window\.setTimeout\(\(\) => setQuery\(queryInput\.trim\(\)\), 250\)/);
  assert.match(center, /catalogGenerationRef/);
  assert.match(center, /new AbortController\(\)/);
  assert.match(center, /selectedAssetIdRef/);
  assert.match(center, /refreshSelectedAsset/);
  assert.match(center, /pipelineSignatureRef/);
  assert.match(center, /schedulePipelineCatalogRefresh/);
  assert.match(center, /ASSET_PAGE_REQUEST_LIMIT/);
  assert.match(center, /visiblePageOffsetsRef/);
  assert.match(center, /retainedPages/);
  assert.match(center, /controller\.abort\(\)/);
  assert.match(center, /!visiblePageOffsetsRef\.current\.has\(result\.offset\)/);
  assert.ok((center.match(/const targetId =/g) || []).length >= 6, 'selected-asset async mutations must capture their target id');
  assert.match(center, /runSelectedMutationRequest/);
  assert.ok((center.match(/await runSelectedMutationRequest\(/g) || []).length >= 5, 'active-asset writes must invalidate old detail reads before awaiting the API; collection creation is intentionally selection-independent');
  assert.ok((center.match(/canApplySelectedMutation\(targetId,/g) || []).length >= 7, 'write results must match both target id and per-selection revision');
  assert.match(center, /detailControllerRef\.current\?\.abort\(\)/);
  assert.match(center, /detailRefreshControllerRef\.current\?\.abort\(\)/);
  assert.match(center, /metadata\.proxyUrl \|\| metadata\.videoProxyUrl \|\| asset\.sourceUrl/);
  assert.match(center, /contactSheetUrl/);
  assert.match(center, /keyframeUrls/);
  assert.match(center, /retryProjectAssetPreview/);
  assert.match(center, /setProjectAssetTags/);
  assert.match(center, /addAssetToCollection/);
  assert.match(center, /removeProjectAssetIndex/);
  assert.match(center, /deleteProjectAssetFile/);
  assert.match(center, /onInsertAsset\(selectedAsset\)/);

  assert.match(browser, /data-asset-card/);
  assert.match(browser, /calculateAssetVirtualWindow/);
  assert.match(browser, /ResizeObserver/);
  assert.match(browser, /layout\.startRow/);
  assert.match(browser, /layout\.endRow/);
  assert.match(browser, /focusRequestToken/);
  assert.match(browser, /\[activeIndex, focusRequestToken,/);
  assert.doesNotMatch(browser, /<video\b/);
  assert.doesNotMatch(browser, /Array\.from\(\{ length: props\.total/);

  assert.match(modelPreview, /OrbitControls/);
  assert.match(modelPreview, /ResizeObserver/);
  assert.match(modelPreview, /fetchSameOriginModel/);
  assert.match(modelPreview, /redirect:\s*'error'/);
  assert.match(modelPreview, /setURLModifier/);
  assert.match(modelPreview, /subtle\.digest\('SHA-256'/);
  assert.match(modelPreview, /assertTexturelessSelfContainedGlb/);
  assert.match(modelPreview, /response\.body\?\.getReader\(\)/);
  assert.match(modelPreview, /reader\.cancel/);
  assert.doesNotMatch(modelPreview, /response\.arrayBuffer\(\)/);
  assert.match(modelPreview, /parseAsync\(bytes/);
  assert.match(modelPreview, /\.parse\(bytes\)/);
  assert.doesNotMatch(modelPreview, /FBXLoader|USDLoader/);
  assert.doesNotMatch(modelPreview, /\.load\(/);
  assert.doesNotMatch(modelPreview, /requestAnimationFrame/);
  assert.match(center, /data-asset-model-static-preview/);
  assert.match(workbench, /<AssetCenter key=\{`\$\{props\.projectId\}:\$\{props\.canvasId \|\| ''\}`\} canvasId=\{props\.canvasId\} projectId=\{props\.projectId\} onInsertAsset=\{props\.onInsertAsset\}/);
  assert.match(workbench, /tab === 'assets' \? 'overflow-hidden'/);
  assert.doesNotMatch(workbench, /limit:\s*36/);
  assert.doesNotMatch(workbench, /assets\.map\(/);

  assert.match(api, /project-assets\/status/);
  assert.match(api, /project-assets\/\$\{encodeURIComponent\(assetId\)\}\/preview\/retry/);
  assert.match(api, /options: \{ signal\?: AbortSignal \}/);
  assert.match(types, /active:\s*number/);
  assert.match(types, /previewStatus\?: AssetPreviewStatus/);
  assert.match(types, /modelPreviewUrl\?: string/);
});
