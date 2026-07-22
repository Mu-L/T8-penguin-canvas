import test from 'node:test';
import assert from 'node:assert/strict';
import type { Edge, Node } from '@xyflow/react';
import {
  buildLoopCustomIterationInputs,
  buildLoopParallelCloneGraph,
  collectLoopCustomMaterialBuckets,
  collectLoopIterationMaterials,
  loopParallelCloneEdgeId,
  loopParallelCloneInputEdgeId,
  loopParallelCloneNodeId,
  normalizeLoopCustomMaterialConfig,
} from '../src/utils/loopDerivedExecution.ts';

function node(id: string, type: string, data: Record<string, unknown> = {}): Node {
  return { id, type, position: { x: 0, y: 0 }, data };
}

function edge(id: string, source: string, target: string, sourceHandle?: string, targetHandle?: string): Edge {
  return { id, source, target, sourceHandle, targetHandle };
}

test('loop material snapshot preserves text dedupe, material-set order and source identity', () => {
  const loop = node('loop', 'loop', { kind: 'text' });
  const text = node('text', 'text', {
    outputText: 'hello',
    reply: 'world',
    prompt: 'hello',
    text: 'hello',
  });
  const materialSet = node('set', 'material-set', {
    materialSetKind: 'text',
    materialSetItems: [
      { id: 'a', kind: 'text', text: 'same' },
      { id: 'b', kind: 'text', text: 'same' },
    ],
  });
  const result = collectLoopIterationMaterials(loop, [loop, text, materialSet], [
    edge('text-loop', 'text', 'loop'),
    edge('set-loop', 'set', 'loop'),
  ]);

  assert.deepEqual(result.map((item) => [item.url, item.sourceNodeId]), [
    ['hello', 'text'],
    ['world', 'text'],
    ['same', 'set'],
    ['same', 'set'],
  ]);
});

test('loop material snapshot honors source handles, subflow outputs and media fallback classification', () => {
  const imageLoop = node('image-loop', 'loop', { kind: 'image' });
  const videoLoop = node('video-loop', 'loop', { kind: 'video' });
  const frames = node('frames', 'frame-pair', {
    firstFrameUrl: 'first.png',
    lastFrameUrl: 'last.png',
  });
  const subflow = node('subflow', 'subflow', {
    subflowOutputs: {
      selected: { imageUrl: 'selected.png' },
      ignored: { imageUrl: 'ignored.png' },
    },
  });
  const mislabeled = node('mislabeled', 'upload', { imageUrl: 'clip.mp4' });
  const nodes = [imageLoop, videoLoop, frames, subflow, mislabeled];
  const edges = [
    edge('last-image', 'frames', 'image-loop', 'last'),
    edge('subflow-image', 'subflow', 'image-loop', 'selected'),
    edge('mislabeled-video', 'mislabeled', 'video-loop'),
  ];

  assert.deepEqual(
    collectLoopIterationMaterials(imageLoop, nodes, edges).map((item) => item.url),
    ['last.png', 'selected.png'],
  );
  assert.deepEqual(
    collectLoopIterationMaterials(videoLoop, nodes, edges).map((item) => item.url),
    ['clip.mp4'],
  );
});

test('parallel clone graph uses request-bound stable IDs and preserves the entry target handle', () => {
  const requestId = 'run:clone-test:12345678';
  const sourceNodes = [node('entry', 'image'), node('sink', 'video')];
  const sourceEdges = [edge('entry-sink', 'entry', 'sink', 'image-out', 'image-in')];
  const items = [
    { id: 'one', kind: 'image' as const, url: 'one.png', sourceNodeId: 'source-a' },
    { id: 'two', kind: 'image' as const, url: 'two.png', sourceNodeId: 'source-b' },
  ];
  const entryEdge = edge('loop-entry', 'loop', 'entry', undefined, 'image-in');

  const first = buildLoopParallelCloneGraph({
    loopId: 'loop',
    requestId,
    sourceNodes,
    sourceEdges,
    entryEdge,
    items,
  });
  const second = buildLoopParallelCloneGraph({
    loopId: 'loop',
    requestId,
    sourceNodes,
    sourceEdges,
    entryEdge,
    items,
  });
  const entryClone = loopParallelCloneNodeId('loop', requestId, 1, 0);
  const sinkClone = loopParallelCloneNodeId('loop', requestId, 1, 1);

  assert.deepEqual(first, second);
  assert.deepEqual(first.cloneNodeIds, [entryClone, sinkClone]);
  assert.equal(first.edges[0].id, loopParallelCloneEdgeId('loop', requestId, 1, 0));
  assert.deepEqual([first.edges[0].source, first.edges[0].target], [entryClone, sinkClone]);
  assert.equal(first.edges[1].id, loopParallelCloneInputEdgeId('loop', requestId, 1));
  assert.deepEqual(
    [first.edges[1].source, first.edges[1].target, first.edges[1].targetHandle],
    ['source-b', entryClone, 'image-in'],
  );
  assert.equal(first.nodes[0].data.__loopCloneRequestId, requestId);
  assert.equal(first.nodes[0].data.__loopCloneSourceNodeId, 'entry');
  assert.equal(Object.hasOwn(first.nodes[0].data, '__loopCustomInput'), false);
});

test('custom parallel loop pairs prompts one-by-one while reusing one selected image', () => {
  const loop = node('loop', 'loop', {
    mode: 'parallel-custom',
    kind: 'text',
    parallelCustomStrategies: {
      text: 'sequence',
      image: 'fixed',
      video: 'sequence',
      audio: 'sequence',
    },
    parallelCustomFixedIndexes: { image: 1 },
  });
  const promptValues = Array.from({ length: 16 }, (_, index) => `prompt ${index + 1}`);
  const prompts = node('prompts', 'text-split', { textSegments: promptValues });
  const references = node('references', 'upload', { imageUrls: ['ref-a.png', 'ref-b.png'] });
  const nodes = [loop, prompts, references];
  const edges = [
    edge('prompts-loop', 'prompts', 'loop'),
    edge('references-loop', 'references', 'loop'),
  ];

  const config = normalizeLoopCustomMaterialConfig(loop.data);
  const buckets = collectLoopCustomMaterialBuckets(loop, nodes, edges);
  const iterations = buildLoopCustomIterationInputs(buckets, config);

  assert.equal(iterations.length, 16);
  assert.deepEqual(iterations.map((input) => input.texts[0]?.url), promptValues);
  assert.deepEqual(iterations.map((input) => input.images[0]?.url), Array(16).fill('ref-b.png'));
});

test('custom parallel sequence does not wrap a shorter material pool and clone entries receive isolated snapshots', () => {
  const requestId = 'run:custom-loop:12345678';
  const sourceNodes = [node('entry', 'image'), node('sink', 'output')];
  const sourceEdges = [edge('entry-sink', 'entry', 'sink')];
  const items = ['one', 'two', 'three'].map((url, index) => ({
    id: `prompt-${index}`,
    kind: 'text' as const,
    url,
    sourceNodeId: 'prompts',
  }));
  const iterations = buildLoopCustomIterationInputs({
    texts: items,
    images: [
      { id: 'image-a', kind: 'image', url: 'a.png', sourceNodeId: 'images' },
      { id: 'image-b', kind: 'image', url: 'b.png', sourceNodeId: 'images' },
    ],
    videos: [],
    audios: [],
  }, normalizeLoopCustomMaterialConfig({ kind: 'text' }));

  assert.deepEqual(iterations.map((input) => input.images.map((item) => item.url)), [['a.png'], ['b.png'], []]);

  const graph = buildLoopParallelCloneGraph({
    loopId: 'loop',
    requestId,
    sourceNodes,
    sourceEdges,
    entryEdge: edge('loop-entry', 'loop', 'entry'),
    items,
    iterationInputs: iterations,
  });
  const secondEntry = graph.nodes.find((item) => item.id === loopParallelCloneNodeId('loop', requestId, 1, 0));
  const thirdEntry = graph.nodes.find((item) => item.id === loopParallelCloneNodeId('loop', requestId, 2, 0));
  assert.deepEqual((secondEntry?.data as any).__loopCustomInput.texts.map((item: any) => item.url), ['two']);
  assert.deepEqual((secondEntry?.data as any).__loopCustomInput.images.map((item: any) => item.url), ['b.png']);
  assert.deepEqual((thirdEntry?.data as any).__loopCustomInput.texts.map((item: any) => item.url), ['three']);
  assert.deepEqual((thirdEntry?.data as any).__loopCustomInput.images, []);
});
