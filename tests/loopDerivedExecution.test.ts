import test from 'node:test';
import assert from 'node:assert/strict';
import type { Edge, Node } from '@xyflow/react';
import {
  buildLoopParallelCloneGraph,
  collectLoopIterationMaterials,
  loopParallelCloneEdgeId,
  loopParallelCloneInputEdgeId,
  loopParallelCloneNodeId,
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
});
