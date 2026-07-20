import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Node } from '@xyflow/react';
import type { SubflowDefinition } from '../src/utils/subflows.ts';
import {
  buildSubflowThumbnailLayout,
  createIndependentSubflowDraft,
  normalizeSubflowLibraryMetadata,
  parseSubflowFavoriteIds,
  toggleSubflowFavorite,
} from '../src/utils/subflowLibrary.ts';

function definition(overrides: Partial<SubflowDefinition> = {}): SubflowDefinition {
  return {
    id: 'library-source',
    version: 7,
    revision: 11,
    projectId: 'project-library',
    name: '本地库源流程',
    description: 'library test',
    category: '图像流程',
    tags: ['portrait', 'stable'],
    nodes: [
      { id: 'left', type: 'text', position: { x: -100, y: 40 }, data: { label: '左节点' } },
      { id: 'right', type: 'image', position: { x: 500, y: 440 }, data: { label: '右节点' } },
    ],
    edges: [{ id: 'left-right', source: 'left', target: 'right' }],
    inputs: [],
    outputs: [],
    exposedParameters: [],
    requiredCapabilities: [],
    assetRefs: [],
    changeSummary: 'source summary',
    publishedBy: 'owner-a',
    publishedAt: 100,
    createdAt: 90,
    updatedAt: 100,
    ...overrides,
  };
}

test('stable thumbnail layout is deterministic, bounded and resilient to invalid coordinates', () => {
  const nodes: Node[] = Array.from({ length: 30 }, (_, index) => ({
    id: `node-${index}`,
    type: index % 2 ? 'image' : 'text',
    position: {
      x: index === 2 ? Number.NaN : index * 20,
      y: index === 3 ? Number.POSITIVE_INFINITY : index * -15,
    },
    data: { label: `节点 ${index}` },
  }));
  const source = definition({ nodes });
  const first = buildSubflowThumbnailLayout(source);
  const second = buildSubflowThumbnailLayout(structuredClone(source));
  assert.deepEqual(first, second);
  assert.equal(first.nodes.length, 24);
  assert.equal(first.totalNodes, 30);
  assert.equal(first.totalEdges, 1);
  first.nodes.forEach((node) => {
    assert.equal(Number.isFinite(node.leftPercent), true);
    assert.equal(Number.isFinite(node.topPercent), true);
    assert.equal(node.leftPercent >= 8 && node.leftPercent <= 80, true);
    assert.equal(node.topPercent >= 10 && node.topPercent <= 75, true);
  });
  assert.deepEqual(buildSubflowThumbnailLayout(definition({ nodes: [], edges: [] })), {
    nodes: [], totalNodes: 0, totalEdges: 0,
  });
});

test('library metadata normalizes category and tags without unstable duplicates', () => {
  const normalized = normalizeSubflowLibraryMetadata(
    '  图像\u0000 流程  ',
    ' portrait，portrait, 角色\n 角色 , ' + 'x'.repeat(80),
  );
  assert.equal(normalized.category, '图像 流程');
  assert.deepEqual(normalized.tags.slice(0, 3), ['portrait', '角色', 'x'.repeat(60)]);
  assert.equal(normalized.tags.length, 3);
  assert.equal(normalizeSubflowLibraryMetadata('', Array.from({ length: 40 }, (_, index) => `t${index}`)).tags.length, 30);
});

test('favorites recover from corrupt storage, deduplicate and toggle by stable definition id', () => {
  assert.deepEqual(parseSubflowFavoriteIds('{broken'), []);
  assert.deepEqual(parseSubflowFavoriteIds('["flow-a","flow-a","",7]'), ['flow-a', '7']);
  assert.deepEqual(toggleSubflowFavorite(['flow-a'], 'flow-b'), ['flow-a', 'flow-b']);
  assert.deepEqual(toggleSubflowFavorite(['flow-a', 'flow-b'], 'flow-a'), ['flow-b']);
});

test('independent copy resets immutable publication identity and deep-clones graph content', () => {
  const source = definition();
  const copy = createIndependentSubflowDraft(source, { id: 'library-copy', projectId: 'project-target' });
  assert.equal(copy.id, 'library-copy');
  assert.equal(copy.projectId, 'project-target');
  assert.equal(copy.name, '本地库源流程 副本');
  assert.equal(copy.baseRevision, 0);
  assert.equal(copy.changeSummary, '从 本地库源流程 v7 另存独立副本');
  assert.equal('version' in copy, false);
  assert.equal('revision' in copy, false);
  assert.equal('publishedBy' in copy, false);
  assert.equal('publishedAt' in copy, false);
  assert.equal('createdAt' in copy, false);
  assert.equal('updatedAt' in copy, false);
  assert.notEqual(copy.nodes, source.nodes);
  assert.notEqual(copy.nodes[0].data, source.nodes[0].data);
  (copy.nodes[0].data as Record<string, unknown>).label = 'copy-only';
  assert.equal((source.nodes[0].data as Record<string, unknown>).label, '左节点');
});

test('project workbench wires the pure library contracts into visible controls', () => {
  const source = fs.readFileSync(new URL('../src/components/ProjectWorkbench.tsx', import.meta.url), 'utf8');
  assert.match(source, /buildSubflowThumbnailLayout\(definition\)/);
  assert.match(source, /parseSubflowFavoriteIds\(localStorage\.getItem\(favoriteStorageKey\)\)/);
  assert.match(source, /toggleSubflowFavoriteId\(current, definitionId\)/);
  assert.match(source, /createIndependentSubflowDraft\(definition/);
  assert.match(source, /normalizeSubflowLibraryMetadata\(subflowLibraryEdit\.category, subflowLibraryEdit\.tags\)/);
  assert.match(source, /编辑分类\/标签（创建新版本）/);
  assert.match(source, /另存独立副本/);
  assert.match(source, /稳定缩略图/);
});
