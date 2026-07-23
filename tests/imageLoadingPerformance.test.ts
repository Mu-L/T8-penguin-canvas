import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function read(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('local canvas image previews use cached backend thumbnails', () => {
  const smartImage = read('../src/components/SmartImage.tsx');
  const mediaPreview = read('../src/utils/mediaPreview.ts');
  const filesRoute = read('../backend/src/routes/files.js');

  assert.match(smartImage, /previewImageUrl\(src,\s*thumbSize\)/);
  assert.match(smartImage, /loading = 'lazy'/);
  assert.match(smartImage, /decoding = 'async'/);
  assert.match(smartImage, /data-full-src=\{src\}/);
  assert.match(smartImage, /IntersectionObserver/);
  assert.match(smartImage, /rootMargin:\s*'720px 720px'/);
  assert.match(smartImage, /setFallback\(true\)/);

  assert.match(mediaPreview, /\/api\/files\/thumbnail\?size=\$\{safeSize\}&url=/);
  assert.match(mediaPreview, /LOCAL_FILE_PREFIX_RE/);

  assert.match(filesRoute, /router\.get\('\/thumbnail'/);
  assert.match(filesRoute, /sharp\(sourcePath/);
  assert.match(filesRoute, /thumbnailInflight/);
  assert.match(filesRoute, /function getFilesPreviewPipeline\(\)/);
  assert.match(filesRoute, /getFilesPreviewPipeline\(\)\.runEphemeral/);
  assert.match(filesRoute, /writeAtomicTarget/);
  assert.match(filesRoute, /MAX_IMAGE_INPUT_PIXELS/);
  assert.match(filesRoute, /Cache-Control', 'public, max-age=31536000, immutable'/);
  assert.match(filesRoute, /THUMBNAILS_DIR/);
});

test('local file uploads stay disk-backed and enforce a bounded application limit', () => {
  const config = read('../backend/src/config.js');
  const filesRoute = read('../backend/src/routes/files.js');

  assert.match(config, /MAX_FILE_SIZE:\s*0/);
  assert.match(filesRoute, /const uploadSingleFile = upload\.single\('file'\)/);
  assert.match(filesRoute, /err instanceof multer\.MulterError/);
  assert.match(filesRoute, /multer\.diskStorage/);
  assert.match(filesRoute, /limits:\s*\{[\s\S]*fileSize:\s*FILE_UPLOAD_MAX_BYTES/);
  assert.match(filesRoute, /DEFAULT_FILE_UPLOAD_MAX_BYTES\s*=\s*512\s*\*\s*1024\s*\*\s*1024/);
  assert.match(filesRoute, /LIMIT_FILE_SIZE/);
  assert.doesNotMatch(filesRoute, /multer\.memoryStorage/);
});

test('initial canvas boot keeps heavy nodes behind lazy boundaries', () => {
  const index = read('../index.html');
  const app = read('../src/App.tsx');
  const canvas = read('../src/components/Canvas.tsx');
  const css = read('../src/styles/index.css');
  const runTrigger = read('../src/hooks/useRunTrigger.ts');

  assert.ok(existsSync(new URL('../public/infinite-canvas-loading.png', import.meta.url)));
  assert.match(index, /<div class="t8-boot-screen"/);
  assert.match(index, /src="\/infinite-canvas-loading\.png"/);
  assert.match(index, /t8-boot-progress-fill/);
  assert.match(index, /t8-boot-progress-spark/);
  assert.match(index, /prefers-reduced-motion/);
  assert.match(app, /const Canvas = lazy\(\(\) => import\('\.\/components\/Canvas'\)\)/);
  assert.match(app, /function InfiniteCanvasBootLoading/);
  assert.match(app, /src="\/infinite-canvas-loading\.png"/);
  assert.match(app, /<Suspense fallback=\{<InfiniteCanvasBootLoading \/>}/);
  assert.match(canvas, /function lazyCanvasNode/);
  assert.match(canvas, /const Panorama3DNode = lazyCanvasNode\(\(\) => import\('\.\/nodes\/Panorama3DNode'\)/);
  assert.match(canvas, /const ImageNode = lazyCanvasNode\(\(\) => import\('\.\/nodes\/ImageNode'\)/);
  assert.doesNotMatch(canvas, /import ImageNode from '\.\/nodes\/ImageNode'/);

  assert.match(canvas, /data-canvas-surface-load=\{heavyCanvasSurface \? 'heavy' : 'normal'\}/);
  assert.doesNotMatch(canvas, /onlyRenderVisibleElements/);
  assert.match(runTrigger, /useRunBusStore/);
  assert.match(css, /Large graph rendering guard/);
  assert.match(
    css,
    /\.t8-canvas-shell\[data-canvas-surface-load="heavy"\] \.react-flow__node:not\(\.selected\):not\(:focus-within\) :where\(img, video, iframe, canvas\) \{[\s\S]*content-visibility:\s*auto;[\s\S]*contain-intrinsic-size:\s*320px 260px;/,
  );
  assert.match(
    css,
    /\.t8-canvas-shell\[data-canvas-surface-load="heavy"\]\.t8-viewport-moving \.react-flow__node:not\(\.selected\):not\(:focus-within\) > div:first-child,[\s\S]*\.t8-canvas-shell\[data-canvas-surface-load="heavy"\]\.t8-node-dragging \.react-flow__node:not\(\.selected\):not\(:focus-within\) > div:first-child \{[\s\S]*box-shadow:\s*none !important;[\s\S]*filter:\s*none !important;[\s\S]*backdrop-filter:\s*none !important;/,
  );
  assert.match(css, /Large graph interaction chrome trim/);
  assert.match(
    css,
    /\.t8-canvas-shell\[data-canvas-surface-load="heavy"\]\.t8-viewport-moving \.react-flow__node:not\(\.selected\):not\(:focus-within\) :where\(\.react-flow__handle, \.react-flow__resize-control, \[data-node-action-bar\], \[data-floating-node-action\]\),[\s\S]*\.t8-canvas-shell\[data-canvas-surface-load="heavy"\]\.t8-node-dragging \.react-flow__node:not\(\.selected\):not\(:focus-within\) :where\(\.react-flow__handle, \.react-flow__resize-control, \[data-node-action-bar\], \[data-floating-node-action\]\) \{[\s\S]*opacity:\s*0 !important;[\s\S]*pointer-events:\s*none !important;/,
  );
  assert.match(
    css,
    /\.t8-canvas-shell\[data-canvas-surface-load="heavy"\]\.t8-viewport-moving \.react-flow__node:not\(\.selected\):not\(:focus-within\) \*,[\s\S]*\.t8-canvas-shell\[data-canvas-surface-load="heavy"\]\.t8-node-dragging \.react-flow__node:not\(\.selected\):not\(:focus-within\) \* \{[\s\S]*transition-duration:\s*0s !important;/,
  );
});

test('canvas video previews defer real video sources until near the viewport', () => {
  const loopingVideo = read('../src/components/LoopingVideo.tsx');
  const videoPlayback = read('../src/utils/videoPlayback.ts');

  assert.match(videoPlayback, /preload:\s*'metadata'/);
  assert.match(loopingVideo, /IntersectionObserver/);
  assert.match(loopingVideo, /rootMargin:\s*'720px 720px'/);
  assert.match(loopingVideo, /preload === undefined \? props : \{ \.\.\.props, preload \}/);
  assert.match(loopingVideo, /compatibleVideoPreviewUrl\(src\)/);
  assert.match(loopingVideo, /data-full-src=\{src\}/);
  assert.match(loopingVideo, /src=\{shouldLoad \? playbackSrc : undefined\}/);
  assert.match(loopingVideo, /data-playback-src=\{playbackSrc\}/);
});

test('local MOV previews are transcoded to H.264 MP4 while original material URLs stay unchanged', () => {
  const uploadNode = read('../src/components/nodes/UploadNode.tsx');
  const outputNode = read('../src/components/nodes/OutputNode.tsx');
  const videoPlayback = read('../src/utils/videoPlayback.ts');
  const filesRoute = read('../backend/src/routes/files.js');

  assert.match(uploadNode, /accept:\s*'video\/\*,\.mov,video\/quicktime'/);
  assert.match(uploadNode, /VIDEO_EXT_RE\.test\(name\)/);
  assert.match(uploadNode, /<LoopingVideo[\s\S]*src=\{item\.url\}/);
  assert.match(outputNode, /<LoopingVideo[\s\S]*src=\{u\}/);
  assert.match(videoPlayback, /\/api\/files\/video-preview\?url=/);
  assert.match(filesRoute, /router\.get\('\/video-preview'/);
  assert.match(filesRoute, /'-c:v', 'libx264'/);
  assert.match(filesRoute, /'-pix_fmt', 'yuv420p'/);
  assert.match(filesRoute, /'-threads', '1'/);
  assert.match(filesRoute, /'-c:a', 'aac'/);
  assert.match(filesRoute, /video_preview_\$\{key\}\.mp4/);
  assert.match(filesRoute, /原 MOV URL 不变/);
});

test('high-traffic node previews render through SmartImage', () => {
  const expectedSmartImageNodes = [
    '../src/components/nodes/MaterialThumbnail.tsx',
    '../src/components/nodes/OutputNode.tsx',
    '../src/components/nodes/UploadNode.tsx',
    '../src/components/nodes/ImageNode.tsx',
    '../src/components/nodes/GridEditorNode.tsx',
    '../src/components/nodes/Panorama3DNode.tsx',
    '../src/components/nodes/LoopNode.tsx',
    '../src/components/nodes/MaterialSetNode.tsx',
    '../src/components/nodes/VideoNode.tsx',
    '../src/components/nodes/SeedanceNode.tsx',
    '../src/components/nodes/LLMNode.tsx',
  ];

  for (const file of expectedSmartImageNodes) {
    const source = read(file);
    assert.match(source, /import SmartImage from '\.\.\/SmartImage'/, `${file} imports SmartImage`);
    assert.match(source, /<SmartImage[\s\S]*thumbSize=/, `${file} uses bounded preview size`);
  }
});

test('decorative theme edge motion degrades while the canvas is busy', () => {
  const canvas = read('../src/components/Canvas.tsx');
  const edge = read('../src/components/edges/DeletableEdge.tsx');
  const css = read('../src/styles/index.css');
  const slamCss = read('../src/styles/theme-slamdunk.css');
  const soccerCss = read('../src/styles/theme-soccer.css');
  const dragonCss = read('../src/styles/theme-dragonball.css');
  const main = read('../src/main.tsx');

  assert.match(canvas, /EDGE_MOTION_HEAVY_EDGE_COUNT/);
  assert.match(canvas, /isDecorativeEdgeVisual = isSlamdunk \|\| isSoccer \|\| isDragonBall/);
  assert.match(canvas, /edgeMotionMode = isDecorativeEdgeVisual \? \(edgeMotionReduced \? 'reduced' : 'scoped'\) : undefined/);
  assert.match(canvas, /data-t8-edge-motion/);
  assert.match(canvas, /onMoveStart=\{handleViewportMoveStart\}/);
  assert.match(canvas, /if \(isDraggingRef\.current\) return;/);
  assert.match(canvas, /setDragSaveTick\(\(tick\) => tick \+ 1\)/);

  assert.match(edge, /DECORATIVE_EDGE_MOTION_LIMIT/);
  assert.match(edge, /isNodeSelectedFromStore/);
  assert.match(edge, /countActiveThemeEdges/);
  assert.match(edge, /activeThemeEdgeCount <= DECORATIVE_EDGE_MOTION_LIMIT/);
  assert.match(edge, /t8-edge-theme-active/);
  assert.match(edge, /shouldRenderPassBall/);
  assert.match(edge, /shouldRenderSoccerBall/);
  assert.match(edge, /\{shouldRenderPassBall && \(/);
  assert.match(edge, /\{shouldRenderSoccerBall && \(/);

  assert.match(css, /html\[data-t8-edge-motion="reduced"\]/);
  assert.match(slamCss, /\.react-flow__edge-path\.t8-edge-theme-active/);
  assert.match(slamCss, /\.t8-edge-yyh-red-segment\.t8-edge-theme-active/);
  assert.match(slamCss, /html\[data-theme-visual="slamdunk"\] \.t8-sidebar::after \{\s*content: none;/);
  assert.match(soccerCss, /\.react-flow__edge-path\.t8-edge-theme-active/);
  assert.match(soccerCss, /\.t8-edge-yyh-red-segment\.t8-edge-theme-active/);
  assert.match(css, /theme-dragonball\.css/);
  assert.match(dragonCss, /\.react-flow__edge-path\.t8-edge-theme-active/);
  assert.match(dragonCss, /data-t8-edge-motion="reduced"/);
  assert.match(dragonCss, /\.t8-viewport-moving/);
  assert.match(dragonCss, /\.t8-node-dragging/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(main, /VITE_T8_STRICT_MODE/);
});
