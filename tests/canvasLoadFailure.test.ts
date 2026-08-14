import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  authoritativeCanvasRevision,
  hasCanvasWriteAuthority,
  requireAuthoritativeCanvasRevision,
} from '../src/utils/canvasLoadAuthority.ts';

test('canvas write authority requires a successful load with a strict server revision', () => {
  assert.equal(authoritativeCanvasRevision(7), 7);
  for (const invalid of [undefined, null, 0, -1, 1.5, '7', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(authoritativeCanvasRevision(invalid), null);
    assert.throws(() => requireAuthoritativeCanvasRevision(invalid), /revision/);
  }

  assert.equal(hasCanvasWriteAuthority({
    activeCanvasId: 'canvas-a',
    loadedCanvasId: null,
    loaded: false,
    revision: undefined,
  }), false);
  assert.equal(hasCanvasWriteAuthority({
    activeCanvasId: 'canvas-a',
    loadedCanvasId: 'canvas-b',
    loaded: true,
    revision: 8,
  }), false);
  assert.equal(hasCanvasWriteAuthority({
    activeCanvasId: 'canvas-a',
    loadedCanvasId: 'canvas-a',
    loaded: true,
    revision: 8,
  }), true);
});

test('GET 500 or timeout keeps edits at zero PUTs until a retry restores the server graph', () => {
  const serverGraph = [{ id: 'server-node', data: { label: 'old graph' } }];
  for (const failure of ['GET 500', 'timeout']) {
    let loaded = false;
    let loadedCanvasId: string | null = null;
    let revision: number | null = null;
    let putCalls = 0;
    let renderedGraph = [...serverGraph, { id: 'unsafe-local-edit', data: { label: failure } }];
    const attemptPut = () => {
      if (hasCanvasWriteAuthority({ activeCanvasId: 'canvas-a', loadedCanvasId, loaded, revision })) {
        putCalls += 1;
      }
    };

    attemptPut();
    assert.equal(putCalls, 0, `${failure} must not authorize a PUT`);

    revision = requireAuthoritativeCanvasRevision(11);
    renderedGraph = structuredClone(serverGraph);
    loadedCanvasId = 'canvas-a';
    loaded = true;

    assert.deepEqual(renderedGraph, serverGraph, `${failure} retry must restore the authoritative graph`);
    assert.equal(putCalls, 0, 'hydration itself must not autosave');
    attemptPut();
    assert.equal(putCalls, 1, 'an explicit post-recovery edit may save');
  }
});

test('Canvas keeps failed loads non-editable and exposes an explicit retry', () => {
  const source = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');
  const loadStart = source.indexOf('.getCanvasData(requestedCanvasId)');
  const catchStart = source.indexOf('.catch((e) =>', loadStart);
  const catchEnd = source.indexOf('return () => {', catchStart);
  assert.ok(loadStart >= 0 && catchStart > loadStart && catchEnd > catchStart);
  const failedLoad = source.slice(catchStart, catchEnd);

  assert.match(failedLoad, /setCanvasLoadFailure\(\{ canvasId: requestedCanvasId, message \}\)/);
  assert.match(failedLoad, /setLoadedCanvasId\(null\)/);
  assert.match(failedLoad, /setLoaded\(false\)/);
  assert.doesNotMatch(failedLoad, /setNodes\(\[\]\)|setEdges\(\[\]\)|setLoaded\(true\)|histReset\(/);
  assert.match(source, /const revision = requireAuthoritativeCanvasRevision\(data\.revision\)/);
  assert.match(source, /if \(!loaded \|\| loadedCanvasId !== activeId\)/);
  assert.match(source, /data-canvas-load-state=\{loadFailure \? 'failed' : 'loading'\}/);
  assert.match(source, /setCanvasLoadAttempt\(\(attempt\) => attempt \+ 1\)/);
  assert.match(source, /hasCanvasWriteAuthority\(\{/);
  assert.match(source, /const putBaseRevision = requireAuthoritativeCanvasRevision/);
});
