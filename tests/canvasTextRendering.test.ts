import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function cssRuleBody(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

test('global UI font rendering does not force grayscale smoothing', () => {
  const css = read('../src/styles/index.css');
  const userFontRule = cssRuleBody(css, 'html[data-ui-font]:not([data-ui-font="theme"])');
  const rootRule = cssRuleBody(css, ':root');

  for (const body of [userFontRule, rootRule]) {
    assert.match(body, /text-rendering:\s*optimizeLegibility/);
    assert.match(body, /-webkit-font-smoothing:\s*subpixel-antialiased/);
    assert.match(body, /-moz-osx-font-smoothing:\s*auto/);
    assert.doesNotMatch(body, /-webkit-font-smoothing:\s*antialiased/);
    assert.doesNotMatch(body, /-moz-osx-font-smoothing:\s*grayscale/);
    assert.doesNotMatch(body, /text-rendering:\s*geometricPrecision/);
  }
});

test('canvas nodes strip decorative text blur across themes', () => {
  const css = read('../src/styles/index.css');

  assert.match(css, /Canvas node crisp text contract/);
  assert.match(
    css,
    /#root \.t8-canvas-shell \.react-flow__node,\s*#root \.t8-canvas-shell \.react-flow__node \* \{[\s\S]*-webkit-font-smoothing:\s*subpixel-antialiased !important;[\s\S]*-moz-osx-font-smoothing:\s*auto !important;[\s\S]*text-rendering:\s*optimizeLegibility !important;[\s\S]*\}/,
  );
  assert.match(
    css,
    /#root \.t8-canvas-shell \.react-flow__node,\s*#root \.t8-canvas-shell \.react-flow__node :where\([\s\S]*button,[\s\S]*span,[\s\S]*textarea,[\s\S]*th[\s\S]*\) \{[\s\S]*-webkit-text-stroke:\s*0 !important;[\s\S]*text-shadow:\s*none !important;[\s\S]*\}/,
  );
});

test('low zoom canvas nodes disable compositor filters that resample text', () => {
  const css = read('../src/styles/index.css');
  const canvas = read('../src/components/Canvas.tsx');

  assert.match(css, /data-canvas-zoom-readability="compact"/);
  assert.match(css, /data-canvas-zoom-readability="overview"/);
  assert.match(css, /react-flow__node:not\(\.react-flow__node-groupBox\)[\s\S]*filter:\s*none !important;/);
  assert.match(css, /-webkit-backdrop-filter:\s*none !important;/);
  assert.match(css, /backdrop-filter:\s*none !important;/);
  assert.match(css, /text-rendering:\s*geometricPrecision !important;/);
  assert.match(canvas, /data-canvas-zoom-readability=\{canvasZoomReadability\}/);
  assert.match(canvas, /onMove=\{handleViewportMove\}/);
});
