import test from 'node:test';
import assert from 'node:assert/strict';
import { EXECUTABLE_NODE_TYPES } from '../src/config/executableNodeTypes.ts';

test('shared executable node list covers nested-only and canvas-only execution types', () => {
  for (const type of [
    'multi-angle-3d', 'panorama-720', 'penguin-portrait', 'codex-image-conjure',
    'multi-angle-visual', 'feishu-bitable-input', 'feishu-bitable-output', 'subflow',
    'director-storyboard', 'artist-style-master', 'anime-tag-master',
  ]) {
    assert.equal(EXECUTABLE_NODE_TYPES.has(type), true, `${type} should be executable in every planner`);
  }
});

test('shared executable node list has 51 explicitly audited production types', () => {
  assert.equal(EXECUTABLE_NODE_TYPES.size, 51);
});

test('shared executable node list excludes passive output nodes', () => {
  assert.equal(EXECUTABLE_NODE_TYPES.has('output'), false);
});
