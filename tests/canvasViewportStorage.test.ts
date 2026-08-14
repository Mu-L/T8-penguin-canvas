import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANVAS_VIEWPORT_STORAGE_KEY,
  CANVAS_VIEWPORT_STORAGE_LIMIT,
  resolveCanvasInitialViewport,
  stageCanvasViewportWrite,
  validCanvasViewport,
  writeCanvasViewport,
  type CanvasViewportStorage,
} from '../src/utils/canvasViewportStorage.ts';

class MemoryViewportStorage implements CanvasViewportStorage {
  private readonly values: Map<string, string>;

  constructor(initial?: ReadonlyMap<string, string>) {
    this.values = new Map(initial);
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  snapshot(): ReadonlyMap<string, string> {
    return new Map(this.values);
  }
}

test('canvas viewport survives a cold restart and beats the backend placeholder', () => {
  const firstSession = new MemoryViewportStorage();
  assert.equal(writeCanvasViewport(firstSession, 'canvas-a', { x: -420, y: 180, zoom: 0.72 }, 10), true);

  const restartedSession = new MemoryViewportStorage(firstSession.snapshot());
  assert.deepEqual(
    resolveCanvasInitialViewport(restartedSession, 'canvas-a', { x: 0, y: 0, zoom: 1 }),
    { x: -420, y: 180, zoom: 0.72 },
  );
});

test('bad local values and legacy default backend viewports fall back to fit', () => {
  const storage = new MemoryViewportStorage();
  storage.setItem(CANVAS_VIEWPORT_STORAGE_KEY, '{"version":1,"entries":[{"canvasId":"canvas-a","viewport":{"x":0,"y":0,"zoom":99}}]}');

  assert.equal(resolveCanvasInitialViewport(storage, 'canvas-a', { x: 0, y: 0, zoom: 1 }), null);
  assert.equal(resolveCanvasInitialViewport(storage, 'canvas-a', { x: 'bad', y: 0, zoom: 1 }), null);
  assert.deepEqual(
    resolveCanvasInitialViewport(storage, 'canvas-a', { x: 120, y: -80, zoom: 1.2 }),
    { x: 120, y: -80, zoom: 1.2 },
  );
  assert.equal(validCanvasViewport({ x: Number.POSITIVE_INFINITY, y: 0, zoom: 1 }), null);
});

test('canvas viewport storage keeps only the 100 most recent canvases', () => {
  const storage = new MemoryViewportStorage();
  for (let index = 0; index <= CANVAS_VIEWPORT_STORAGE_LIMIT; index += 1) {
    writeCanvasViewport(storage, `canvas-${index}`, { x: index, y: -index, zoom: 1 }, index);
  }

  const stored = JSON.parse(storage.getItem(CANVAS_VIEWPORT_STORAGE_KEY) || '{}') as {
    entries?: Array<{ canvasId: string }>;
  };
  assert.equal(stored.entries?.length, CANVAS_VIEWPORT_STORAGE_LIMIT);
  assert.equal(stored.entries?.[0]?.canvasId, `canvas-${CANVAS_VIEWPORT_STORAGE_LIMIT}`);
  assert.equal(stored.entries?.some((entry) => entry.canvasId === 'canvas-0'), false);
});


test('staging canvas B flushes canvas A before the pending slot is replaced', () => {
  const stagedA = stageCanvasViewportWrite(null, 'canvas-a', { x: 10, y: 20, zoom: 0.8 });
  assert.ok(stagedA);
  const stagedB = stageCanvasViewportWrite(stagedA.pending, 'canvas-b', { x: -30, y: 40, zoom: 1.3 });
  assert.ok(stagedB);
  assert.equal(stagedB.displaced?.canvasId, 'canvas-a');
  assert.equal(stagedB.pending.canvasId, 'canvas-b');

  const storage = new MemoryViewportStorage();
  assert.equal(
    writeCanvasViewport(storage, stagedB.displaced?.canvasId || '', stagedB.displaced?.viewport),
    true,
  );
  assert.equal(writeCanvasViewport(storage, stagedB.pending.canvasId, stagedB.pending.viewport), true);
  assert.deepEqual(resolveCanvasInitialViewport(storage, 'canvas-a', null), { x: 10, y: 20, zoom: 0.8 });
  assert.deepEqual(resolveCanvasInitialViewport(storage, 'canvas-b', null), { x: -30, y: 40, zoom: 1.3 });
});
