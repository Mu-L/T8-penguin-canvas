import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  collectRandomRouteBranchNodeIds,
  excludeRandomRouteBranchDescendants,
  normalizeRandomRouteSettings,
  randomRouteOutputHandle,
  selectRandomRouteHandles,
} from '../src/utils/randomRoute.ts';
import { topologicalLayers } from '../src/utils/topologicalSort.ts';
import { assertProductionNodeSchema } from './helpers/canvasNodeSchema.ts';

function read(rel: string) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

function node(id: string, type = 'image') {
  return { id, type, data: {}, position: { x: 0, y: 0 } } as any;
}

function edge(source: string, target: string, sourceHandle?: string) {
  return { id: `${source}-${sourceHandle || 'out'}-${target}`, source, target, sourceHandle } as any;
}

test('random route normalizes output count and random pass count within supported ranges', () => {
  assert.deepEqual(normalizeRandomRouteSettings({}), {
    totalOutputs: 10,
    randomPassCount: 1,
    executionMode: 'parallel',
  });

  assert.deepEqual(
    normalizeRandomRouteSettings({ total_outputs: 200, random_pass_count: 2 }),
    {
      totalOutputs: 100,
      randomPassCount: 2,
      executionMode: 'parallel',
    },
  );

  assert.deepEqual(
    normalizeRandomRouteSettings({ randomRouteTotalOutputs: -8, randomRoutePassCount: 0 }),
    {
      totalOutputs: 1,
      randomPassCount: 1,
      executionMode: 'parallel',
    },
  );

  assert.deepEqual(
    normalizeRandomRouteSettings({ totalOutputs: 5, randomPassCount: 99 }),
    {
      totalOutputs: 5,
      randomPassCount: 5,
      executionMode: 'parallel',
    },
  );

  assert.deepEqual(
    normalizeRandomRouteSettings({ totalOutputs: 5, randomPassCount: 2, randomRouteExecutionMode: 'serial' }),
    {
      totalOutputs: 5,
      randomPassCount: 2,
      executionMode: 'serial',
    },
  );
});

test('random route selects the requested number of distinct output handles every run', () => {
  const sequence = [0.1, 0.1, 0.9, 0.4];
  let index = 0;
  const rng = () => sequence[index++ % sequence.length];

  assert.equal(randomRouteOutputHandle(3), 'output_3');
  assert.deepEqual(selectRandomRouteHandles(4, 2, rng), ['output_1', 'output_2']);

  for (let i = 0; i < 20; i++) {
    const handles = selectRandomRouteHandles(10, 6);
    assert.equal(handles.length, 6);
    assert.equal(new Set(handles).size, 6);
    assert.ok(handles.every((handle) => /^output_\d+$/.test(handle)));
  }
});

test('random route branch collection keeps only nodes behind active output handles', () => {
  const nodes = [
    node('route', 'random-route'),
    node('image-a'),
    node('video-a', 'video'),
    node('image-b'),
    node('output-b', 'output'),
    node('unrelated', 'text'),
  ];
  const edges = [
    edge('route', 'image-a', 'output_2'),
    edge('image-a', 'video-a'),
    edge('route', 'image-b', 'output_3'),
    edge('image-b', 'output-b'),
    edge('unrelated', 'output-b'),
  ];

  assert.deepEqual(
    [...collectRandomRouteBranchNodeIds({ routeId: 'route', activeHandles: ['output_2'], nodes, edges })].sort(),
    ['image-a', 'video-a'],
  );

  assert.deepEqual(
    [...collectRandomRouteBranchNodeIds({ routeId: 'route', activeHandles: ['output_2', 'output_3'], nodes, edges })].sort(),
    ['image-a', 'image-b', 'output-b', 'video-a'],
  );
});

test('outer canvas execution lets random route own its downstream branch nodes', () => {
  const nodes = [
    node('route', 'random-route'),
    node('image-a'),
    node('video-a', 'video'),
    node('image-b'),
    node('other', 'llm'),
  ];
  const edges = [
    edge('route', 'image-a', 'output_1'),
    edge('image-a', 'video-a'),
    edge('route', 'image-b', 'output_2'),
    edge('other', 'image-b'),
  ];

  const pruned = excludeRandomRouteBranchDescendants(nodes, edges);
  assert.deepEqual(pruned.nodes.map((item) => item.id).sort(), ['other', 'route']);
  assert.deepEqual(pruned.edges, []);
});

test('topological layers allow independent random route branches to run together', () => {
  const nodes = [
    node('image-a'),
    node('image-b'),
    node('video-c', 'video'),
    node('llm-d', 'llm'),
    node('note', 'text'),
  ];
  const edges = [
    edge('image-a', 'video-c'),
    edge('image-b', 'video-c'),
    edge('video-c', 'llm-d'),
    edge('note', 'llm-d'),
  ];

  assert.deepEqual(
    topologicalLayers(nodes, edges, new Set(['image', 'video', 'llm'])),
    [['image-a', 'image-b'], ['video-c'], ['llm-d']],
  );
});

test('random route is a pass-through router and does not auto-output input materials', () => {
  const canvas = read('src/components/Canvas.tsx');

  assert.match(
    canvas,
    /const SKIP_TYPES = new Set\(\[[^\]]*'random-route'[^\]]*\]\);/,
    'random-route should be skipped by the generic auto-output material effect',
  );
});

test('random route removes stale auto-output nodes created by older builds', () => {
  const canvas = read('src/components/Canvas.tsx');

  assert.match(canvas, /source\?\.type === 'random-route'/);
  assert.match(canvas, /target\?\.type === 'output'/);
  assert.match(canvas, /target\.id\.startsWith\('output-auto-'\)/);
  assert.match(canvas, /edge\.id\.startsWith\('e-auto-'\)/);
  assert.match(canvas, /td\.userMoved !== true/);
});

test('random route node is registered as a dynamic utility node with run support', () => {
  const types = read('src/types/canvas.ts');
  const canvas = read('src/components/Canvas.tsx');
  const nodeSource = read('src/components/nodes/RandomRouteNode.tsx');
  const features = read('features.json');

  assertProductionNodeSchema('random-route', {
    label: '随机路由',
    category: 'utility',
    inputs: ['any'],
    outputs: ['any'],
    executable: true,
  });
  assert.match(types, /\|\s*'random-route'/);
  assert.match(canvas, /const RandomRouteNode = lazyCanvasNode\(\(\) => import\('\.\/nodes\/RandomRouteNode'\)/);
  assert.match(canvas, /'random-route':\s*RandomRouteNode/);
  assert.match(canvas, /'random-route'/);
  assert.match(features, /"nodeType":\s*"random-route"/);
  assert.match(features, /"type":\s*"random-route"/);
  assert.match(nodeSource, /data-random-route-node/);
  assert.match(nodeSource, /RANDOM_ROUTE_MAX_OUTPUTS/);
  assert.match(nodeSource, /random_pass_count/);
  assert.match(nodeSource, /randomRouteExecutionMode/);
  assert.match(nodeSource, /并发生成/);
  assert.match(nodeSource, /顺序生成/);
  assert.match(nodeSource, /topologicalLayers/);
  assert.match(nodeSource, /Promise\.all/);
});
