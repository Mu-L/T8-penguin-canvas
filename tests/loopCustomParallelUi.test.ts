import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('loop node exposes opt-in custom parallel mapping without changing legacy mode defaults', () => {
  const source = read('../src/components/nodes/LoopNode.tsx');

  assert.match(source, /type LoopMode = 'serial' \| 'parallel' \| 'parallel-custom'/);
  assert.match(source, /并联循环（自定义）/);
  assert.match(source, /按顺序·每个用一次/);
  assert.match(source, /固定·全部用同一个/);
  assert.match(source, /素材不足时留空，不会从头循环/);
  assert.match(source, /d\?\.mode === 'parallel-custom'/);
  assert.match(source, /d\?\.mode === 'parallel'[\s\S]*'serial'/);
});

test('downstream material hook replaces aggregate upstream arrays with isolated custom-loop snapshots', () => {
  const source = read('../src/components/nodes/useUpstreamMaterials.ts');

  assert.match(source, /normalizeLoopCustomIterationInput/);
  assert.match(source, /__loopCustomInput/);
  assert.match(source, /texts: asMaterials\('text', customInput\.texts\)/);
  assert.match(source, /images: asMaterials\('image', customInput\.images\)/);
  assert.match(source, /videos: asMaterials\('video', customInput\.videos\)/);
  assert.match(source, /audios: asMaterials\('audio', customInput\.audios\)/);
});
