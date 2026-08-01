import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveNodeActionBarGeometry } from '../src/utils/nodeActionBarGeometry.ts';

test('node action bar position and size follow the React Flow viewport zoom', () => {
  const fullSize = resolveNodeActionBarGeometry({
    nodeX: 100,
    nodeY: 80,
    nodeWidth: 320,
    viewportX: 20,
    viewportY: 30,
    zoom: 1,
  });
  assert.deepEqual(fullSize, {
    anchorX: 440,
    anchorY: 102,
    scale: 1,
  });

  const overview = resolveNodeActionBarGeometry({
    nodeX: 100,
    nodeY: 80,
    nodeWidth: 320,
    viewportX: 20,
    viewportY: 30,
    zoom: 0.1,
  });
  assert.deepEqual(overview, {
    anchorX: 62,
    anchorY: 37.2,
    scale: 0.1,
  });
});

test('node action bar falls back to a usable transform for invalid viewport zoom', () => {
  const geometry = resolveNodeActionBarGeometry({
    nodeX: 10,
    nodeY: 20,
    nodeWidth: 300,
    viewportX: 4,
    viewportY: 6,
    zoom: 0,
  });
  assert.deepEqual(geometry, {
    anchorX: 314,
    anchorY: 18,
    scale: 1,
  });
});
