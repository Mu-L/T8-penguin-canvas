import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCanvasZoomReadabilityTier,
  snapCanvasViewportToDevicePixels,
} from '../src/utils/canvasZoomReadability.ts';

test('canvas zoom readability tiers preserve detail styling only near 1:1', () => {
  assert.equal(resolveCanvasZoomReadabilityTier(1), 'detail');
  assert.equal(resolveCanvasZoomReadabilityTier(0.9), 'detail');
  assert.equal(resolveCanvasZoomReadabilityTier(0.899), 'compact');
  assert.equal(resolveCanvasZoomReadabilityTier(0.45), 'compact');
  assert.equal(resolveCanvasZoomReadabilityTier(0.449), 'overview');
  assert.equal(resolveCanvasZoomReadabilityTier(Number.NaN), 'detail');
});

test('canvas viewport translation snaps to physical pixels without changing zoom', () => {
  assert.deepEqual(
    snapCanvasViewportToDevicePixels({ x: 10.26, y: -4.74, zoom: 0.625 }, 2),
    { x: 10.5, y: -4.5, zoom: 0.625 },
  );
  assert.deepEqual(
    snapCanvasViewportToDevicePixels({ x: 10.49, y: -4.49, zoom: 0.8 }, 0),
    { x: 10, y: -4, zoom: 0.8 },
  );
});
