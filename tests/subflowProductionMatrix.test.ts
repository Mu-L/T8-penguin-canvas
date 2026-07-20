import test from 'node:test';
import assert from 'node:assert/strict';
import type { Edge, Node } from '@xyflow/react';
import {
  analyzeSubflowBoundary,
  compileSubflow,
  detachSubflowInstance,
  prepareSubflowRootInputs,
  type SubflowDefinition,
} from '../src/utils/subflows.ts';

function canvasNode(id: string, type: string, x: number, data: Record<string, unknown> = {}): Node {
  return { id, type, position: { x, y: 0 }, data };
}

test('production matrix preserves multiple same-kind entries and exits through encapsulation, execution and detachment', () => {
  const sourceA = canvasNode('source-a', 'text', 0, { text: 'left input' });
  const sourceB = canvasNode('source-b', 'text', 0, { text: 'right input' });
  const insideA = canvasNode('inside-a', 'image', 300, { prompt: 'left' });
  const insideB = canvasNode('inside-b', 'image', 300, { prompt: 'right' });
  const sinkA = canvasNode('sink-a', 'output', 900);
  const sinkB = canvasNode('sink-b', 'output', 900);
  const boundaryEdges: Edge[] = [
    { id: 'enter-a', source: sourceA.id, sourceHandle: 'text-out', target: insideA.id, targetHandle: 'text-in' },
    { id: 'enter-b', source: sourceB.id, sourceHandle: 'text-out', target: insideB.id, targetHandle: 'text-in' },
    { id: 'leave-a', source: insideA.id, sourceHandle: 'image-out', target: sinkA.id, targetHandle: 'image-in' },
    { id: 'leave-b', source: insideB.id, sourceHandle: 'image-out', target: sinkB.id, targetHandle: 'image-in' },
  ];

  const analysis = analyzeSubflowBoundary([insideA, insideB], boundaryEdges, { name: '双路同类型矩阵' });
  const definition: SubflowDefinition = {
    ...analysis.definition,
    id: 'matrix-multi-port',
    version: 7,
    projectId: 'project-matrix',
  };
  assert.deepEqual(definition.inputs.map((port) => port.kind), ['text', 'text']);
  assert.deepEqual(definition.outputs.map((port) => port.kind), ['image', 'image']);
  assert.equal(new Set(definition.inputs.map((port) => port.id)).size, 2);
  assert.equal(new Set(definition.outputs.map((port) => port.id)).size, 2);
  assert.deepEqual(definition.inputs.map((port) => port.internalNodeId), ['inside-a', 'inside-b']);
  assert.deepEqual(definition.outputs.map((port) => port.internalNodeId), ['inside-a', 'inside-b']);

  const instanceId = 'matrix-instance';
  const compiled = compileSubflow(definition, instanceId);
  const inputA = definition.inputs[0];
  const inputB = definition.inputs[1];
  const outputA = definition.outputs[0];
  const outputB = definition.outputs[1];
  assert.equal(compiled.inputTargets[inputA.id].nodeId, `${instanceId}::inside-a`);
  assert.equal(compiled.inputTargets[inputB.id].nodeId, `${instanceId}::inside-b`);
  assert.equal(compiled.outputSources[outputA.id].nodeId, `${instanceId}::inside-a`);
  assert.equal(compiled.outputSources[outputB.id].nodeId, `${instanceId}::inside-b`);

  const instanceInputEdges: Edge[] = [
    { id: 'canvas-enter-a', source: sourceA.id, sourceHandle: 'text-out', target: instanceId, targetHandle: inputA.id },
    { id: 'canvas-enter-b', source: sourceB.id, sourceHandle: 'text-out', target: instanceId, targetHandle: inputB.id },
  ];
  const prepared = prepareSubflowRootInputs(definition, instanceId, [sourceA, sourceB], instanceInputEdges, compiled.inputTargets);
  assert.equal(prepared.nodes.length, 0);
  assert.deepEqual(prepared.edges.map((edge) => [edge.source, edge.target]), [
    [sourceA.id, `${instanceId}::inside-a`],
    [sourceB.id, `${instanceId}::inside-b`],
  ]);
  assert.equal((prepared.snapshot[inputA.id] as any).values[0].data.text, 'left input');
  assert.equal((prepared.snapshot[inputB.id] as any).values[0].data.text, 'right input');

  const instance = canvasNode(instanceId, 'subflow', 300, {
    definition,
    definitionId: definition.id,
    definitionVersion: definition.version,
    definitionProjectId: definition.projectId,
    parameterOverrides: {},
  });
  const detached = detachSubflowInstance(
    [sourceA, sourceB, instance, sinkA, sinkB],
    [
      ...instanceInputEdges,
      { id: 'canvas-leave-a', source: instanceId, sourceHandle: outputA.id, target: sinkA.id, targetHandle: 'image-in' },
      { id: 'canvas-leave-b', source: instanceId, sourceHandle: outputB.id, target: sinkB.id, targetHandle: 'image-in' },
    ],
    instanceId,
  );
  assert.equal(detached.nodes.some((node) => node.id === instanceId), false);
  assert.equal(detached.edges.find((edge) => edge.id === 'canvas-enter-a')?.target, `${instanceId}::inside-a`);
  assert.equal(detached.edges.find((edge) => edge.id === 'canvas-enter-b')?.target, `${instanceId}::inside-b`);
  assert.equal(detached.edges.find((edge) => edge.id === 'canvas-leave-a')?.source, `${instanceId}::inside-a`);
  assert.equal(detached.edges.find((edge) => edge.id === 'canvas-leave-b')?.source, `${instanceId}::inside-b`);
});

test('production matrix expands three fixed nested levels with stable identities and two same-kind outputs', () => {
  const projectId = 'project-matrix';
  const inner: SubflowDefinition = {
    id: 'matrix-inner', version: 3, projectId, name: 'inner', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], inputs: [], edges: [],
    nodes: [
      canvasNode('left-leaf', 'text', 0, { text: 'left' }),
      canvasNode('right-leaf', 'text', 200, { text: 'right' }),
    ],
    outputs: [
      { id: 'left', name: '左文本', kind: 'text', required: false, internalNodeId: 'left-leaf', internalHandle: 'text-out' },
      { id: 'right', name: '右文本', kind: 'text', required: false, internalNodeId: 'right-leaf', internalHandle: 'text-out' },
    ],
  };
  const middle: SubflowDefinition = {
    id: 'matrix-middle', version: 5, projectId, name: 'middle', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], inputs: [], edges: [],
    nodes: [canvasNode('inner-use', 'subflow', 0, {
      definition: inner,
      definitionId: inner.id,
      definitionVersion: inner.version,
      definitionProjectId: projectId,
    })],
    outputs: [
      { id: 'left', name: '左文本', kind: 'text', required: false, internalNodeId: 'inner-use', internalHandle: 'left' },
      { id: 'right', name: '右文本', kind: 'text', required: false, internalNodeId: 'inner-use', internalHandle: 'right' },
    ],
  };
  const outer: SubflowDefinition = {
    id: 'matrix-outer', version: 8, projectId, name: 'outer', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], inputs: [], edges: [],
    nodes: [canvasNode('middle-use', 'subflow', 0, {
      definition: middle,
      definitionId: middle.id,
      definitionVersion: middle.version,
      definitionProjectId: projectId,
    })],
    outputs: [
      { id: 'left', name: '左文本', kind: 'text', required: false, internalNodeId: 'middle-use', internalHandle: 'left' },
      { id: 'right', name: '右文本', kind: 'text', required: false, internalNodeId: 'middle-use', internalHandle: 'right' },
    ],
  };

  const first = compileSubflow(outer, 'root-instance');
  const second = compileSubflow(outer, 'root-instance');
  assert.deepEqual(first, second);
  assert.deepEqual(first.order, [
    'root-instance::middle-use::inner-use::left-leaf',
    'root-instance::middle-use::inner-use::right-leaf',
  ]);
  assert.deepEqual(first.trace[first.order[0]].instancePath, ['root-instance', 'middle-use', 'inner-use', 'left-leaf']);
  assert.equal(first.outputSources.left.nodeId, first.order[0]);
  assert.equal(first.outputSources.right.nodeId, first.order[1]);
  assert.equal(first.outputSources.left.handle, 'text-out');
  assert.equal(first.outputSources.right.handle, 'text-out');
  assert.deepEqual(first.dependencies.map((item) => `${item.definitionId}@${item.version}`).sort(), [
    'matrix-inner@3',
    'matrix-middle@5',
  ]);
});
