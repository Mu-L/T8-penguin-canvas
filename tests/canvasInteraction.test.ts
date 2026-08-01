import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAltModifierActive } from '../src/utils/canvasInteraction.ts';

test('Alt drag accepts direct, native modifier-state, and latched gesture signals', () => {
  assert.equal(isAltModifierActive({ altKey: true }), true);
  assert.equal(isAltModifierActive({ getModifierState: (key) => key === 'Alt' }), true);
  assert.equal(isAltModifierActive({ altKey: false }, true), true);
  assert.equal(isAltModifierActive({ altKey: false, getModifierState: () => false }), false);
});

test('Alt modifier lookup fails closed when a browser event rejects the query', () => {
  assert.equal(isAltModifierActive({
    getModifierState: () => {
      throw new Error('unsupported');
    },
  }), false);
});

test('canvas captures clipboard shortcuts before focused node internals consume them', () => {
  const canvas = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');

  assert.match(canvas, /addEventListener\('keydown', onClipboardKeyCapture, true\)/);
  assert.match(canvas, /clipboardHandledEvents\.has\(e\)/);
  assert.match(canvas, /altNodeDragIntentRef\.current \|\| altKeyPressedRef\.current/);
});

test('CanvasInner keeps creator context hook before the empty-canvas early return', () => {
  const canvas = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');
  const componentStart = canvas.indexOf('function CanvasInner(');
  const hookIndex = canvas.indexOf('const creatorCanvasContext = useMemo', componentStart);
  const earlyReturnIndex = canvas.lastIndexOf('  if (!activeId) {');

  assert.notEqual(componentStart, -1);
  assert.notEqual(hookIndex, -1);
  assert.notEqual(earlyReturnIndex, -1);
  assert.ok(hookIndex < earlyReturnIndex, 'all CanvasInner hooks must run before an activeId early return');
  assert.equal(canvas.indexOf('const creatorCanvasContext = useMemo', hookIndex + 1), -1);
});
