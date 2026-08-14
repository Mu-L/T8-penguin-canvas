import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

test('canvas completion notices mark only other canvases and clear when activated', () => {
  const store = read('../src/stores/canvas.ts');

  assert.match(store, /completionNoticeCanvasIds:\s*string\[\]/);
  assert.match(store, /markCanvasCompletionNotice:\s*\(id:\s*string\)\s*=>\s*void/);
  assert.match(store, /clearCanvasCompletionNotice:\s*\(id:\s*string\)\s*=>\s*void/);
  assert.match(store, /completionNoticeCanvasIds:\s*\[\]/);
  assert.match(store, /if \(!id \|\| id === state\.activeId \|\| state\.completionNoticeCanvasIds\.includes\(id\)\) return state/);
  assert.match(store, /completionNoticeCanvasIds:\s*\[\.{3}state\.completionNoticeCanvasIds,\s*id\]/);
  assert.match(store, /completionNoticeCanvasIds:\s*state\.completionNoticeCanvasIds\.filter\(\(noticeId\)\s*=>\s*noticeId !== id\)/);
  assert.match(store, /setActive\(id\)\s*\{[\s\S]*completionNoticeCanvasIds:/);
});

test('offscreen generation completion is wired to the sidebar canvas badge', () => {
  const store = read('../src/stores/canvas.ts');
  const hook = read('../src/components/nodes/useUpdateNodeData.ts');
  const sidebar = read('../src/components/Sidebar.tsx');
  const css = read('../src/styles/index.css');

  assert.match(store, /completionNoticeCanvasIds/);
  assert.match(store, /markCanvasCompletionNotice/);
  assert.match(store, /clearCanvasCompletionNotice/);
  assert.match(store, /setActive\(id\)\s*\{[\s\S]*completionNoticeCanvasIds:/);

  assert.match(hook, /function isCompletedCanvasPatch/);
  assert.match(hook, /markCanvasCompletionNotice\(canvasId\)/);
  assert.match(hook, /\(originProviderDetached \|\| activeCanvasId !== originCanvasId\) && isCompletedCanvasPatch\(patch\)/);

  assert.match(sidebar, /completionNoticeCanvasIds/);
  assert.match(sidebar, /hasCompletionNotice=\{!isActive && completionNoticeSet\.has\(canvas\.id\)\}/);
  assert.match(sidebar, /t8-sidebar-canvas-update-dot/);
  assert.match(sidebar, /这个画布有新生成完成，切换后自动清除/);

  assert.match(css, /\.t8-sidebar-canvas-update-dot\s*\{/);
});
