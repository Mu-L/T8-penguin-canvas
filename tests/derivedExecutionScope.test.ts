import test from 'node:test';
import assert from 'node:assert/strict';
import type { Edge, Node } from '@xyflow/react';
import {
  buildPossibleDerivedExecutionScope,
  type PossibleDerivedExecutionScope,
} from '../src/utils/derivedExecutionScope.ts';
import { loopParallelCloneNodeId } from '../src/utils/loopDerivedExecution.ts';
import type { SubflowDefinition } from '../src/utils/subflows.ts';

function node(id: string, type: string, data: Record<string, unknown> = {}): Node {
  return { id, type, position: { x: 0, y: 0 }, data };
}

function edge(id: string, source: string, target: string, sourceHandle?: string, targetHandle?: string): Edge {
  return { id, source, target, sourceHandle, targetHandle };
}

function definition(
  id: string,
  nodes: Node[],
  edges: Edge[] = [],
  extra: Partial<SubflowDefinition> = {},
): SubflowDefinition {
  return {
    id,
    version: 1,
    projectId: 'project-a',
    name: id,
    description: '',
    tags: [],
    nodes,
    edges,
    inputs: [],
    outputs: [],
    exposedParameters: [],
    requiredCapabilities: [],
    assetRefs: [],
    ...extra,
  };
}

function blockerCodes(scope: PossibleDerivedExecutionScope) {
  return scope.blockers.map((blocker) => blocker.code);
}

test('random route scope conservatively covers every connected branch and nested scheduler', () => {
  const nodes = [
    node('route', 'random-route', { randomRouteTotalOutputs: 2, randomRoutePassCount: 1 }),
    node('image-a', 'image'),
    node('video-b', 'video'),
    node('nested-route', 'random-route', { randomRouteTotalOutputs: 1, randomRoutePassCount: 1 }),
    node('nested-llm', 'llm'),
    node('branch-output', 'output'),
    node('unrelated', 'image'),
  ];
  const edges = [
    edge('route-a', 'route', 'image-a', 'output_1'),
    edge('route-b', 'route', 'video-b', 'output_2'),
    edge('a-nested', 'image-a', 'nested-route'),
    edge('nested-llm', 'nested-route', 'nested-llm', 'output_1'),
    edge('video-output', 'video-b', 'branch-output'),
  ];

  const scope = buildPossibleDerivedExecutionScope({ nodes, edges, executionNodeIds: ['route'] });

  assert.equal(scope.coverageComplete, true);
  assert.deepEqual(scope.requiredAuthorizationNodeIds, [
    'image-a',
    'nested-llm',
    'nested-route',
    'route',
    'video-b',
  ]);
  assert.deepEqual(scope.derivedRuntimeNodeIds, ['image-a', 'nested-llm', 'nested-route', 'video-b']);
  assert.deepEqual(scope.expandedSchedulerNodeIds, ['nested-route', 'route']);
  assert.deepEqual(scope.nodes.map((item) => item.id), [
    'branch-output',
    'image-a',
    'nested-llm',
    'nested-route',
    'route',
    'video-b',
  ]);
  assert.equal(scope.nodes.some((item) => item.id === 'unrelated'), false);
  assert.deepEqual(scope.edges.map((item) => item.id), ['a-nested', 'nested-llm', 'route-a', 'route-b', 'video-output']);
});

test('loop scope includes every reachable downstream executable and direct input context without promoting the input', () => {
  const requestId = 'run:test-loop:12345678';
  const nodes = [
    node('source', 'text', { textSegments: ['one', 'two'] }),
    node('loop', 'loop', { mode: 'parallel', kind: 'text' }),
    node('split', 'text-split'),
    node('provider', 'image'),
    node('output', 'output'),
    node('unrelated', 'video'),
  ];
  const edges = [
    edge('source-loop', 'source', 'loop'),
    edge('loop-split', 'loop', 'split'),
    edge('split-provider', 'split', 'provider'),
    edge('provider-output', 'provider', 'output'),
  ];

  const scope = buildPossibleDerivedExecutionScope({ nodes, edges, executionNodeIds: ['loop'], requestId });
  const cloneSplit = loopParallelCloneNodeId('loop', requestId, 1, 0);
  const cloneProvider = loopParallelCloneNodeId('loop', requestId, 1, 1);
  const cloneOutput = loopParallelCloneNodeId('loop', requestId, 1, 2);

  assert.equal(scope.coverageComplete, true);
  assert.deepEqual(scope.requiredAuthorizationNodeIds, [cloneProvider, 'loop', 'provider'].sort());
  assert.deepEqual(scope.loopParallelCloneGroups, [{
    schedulerNodeId: 'loop',
    itemCount: 2,
    cloneCount: 1,
    cloneNodeIds: [cloneOutput, cloneProvider, cloneSplit].sort(),
  }]);
  assert.deepEqual(scope.diagnosticContextNodeIds, [cloneOutput, cloneSplit, 'output', 'source', 'split'].sort());
  assert.deepEqual(scope.nodes.map((item) => item.id), [
    cloneOutput,
    cloneProvider,
    cloneSplit,
    'loop',
    'output',
    'provider',
    'source',
    'split',
  ].sort());
  assert.equal(scope.edges.length, 7);
  assert.ok(scope.edges.some((item) => item.source === 'source' && item.target === cloneSplit));
  assert.ok(scope.edges.some((item) => item.source === cloneSplit && item.target === cloneProvider));
  assert.ok(scope.edges.some((item) => item.source === cloneProvider && item.target === cloneOutput));
  assert.equal(scope.nodes.some((item) => item.id === 'unrelated'), false);
});

test('subflow scope compiles embedded fixed dependencies and maps root input into the hidden runtime graph', () => {
  const inner = definition('inner', [node('provider', 'image', { prompt: 'from input' })], [], {
    inputs: [{
      id: 'inner-prompt',
      name: '提示词',
      kind: 'text',
      required: true,
      minConnections: 1,
      internalNodeId: 'provider',
      internalHandle: 'text-in',
    }],
  });
  const outer = definition('outer', [node('child', 'subflow', {
    definition: inner,
    definitionId: inner.id,
    definitionVersion: inner.version,
    definitionProjectId: inner.projectId,
  })], [], {
    inputs: [{
      id: 'outer-prompt',
      name: '提示词',
      kind: 'text',
      required: true,
      minConnections: 1,
      internalNodeId: 'child',
      internalHandle: 'inner-prompt',
    }],
  });
  const nodes = [
    node('source', 'text', { text: 'hello' }),
    node('instance', 'subflow', {
      definition: outer,
      definitionId: outer.id,
      definitionVersion: outer.version,
      definitionProjectId: outer.projectId,
      parameterOverrides: {},
    }),
  ];
  const edges = [edge('canvas-input', 'source', 'instance', 'text-out', 'outer-prompt')];
  const before = JSON.stringify({ nodes, edges });

  const first = buildPossibleDerivedExecutionScope({ nodes, edges, executionNodeIds: ['instance'] });
  const second = buildPossibleDerivedExecutionScope({ nodes: [...nodes].reverse(), edges, executionNodeIds: ['instance'] });

  assert.equal(first.coverageComplete, true);
  assert.deepEqual(first.requiredAuthorizationNodeIds, ['instance', 'instance::child::provider']);
  assert.deepEqual(first.derivedRuntimeNodeIds, ['instance::child::provider']);
  assert.deepEqual(first.expandedSubflowInstanceIds, ['instance']);
  assert.deepEqual(first.nodes.map((item) => item.id), ['instance', 'instance::child::provider', 'source']);
  assert.ok(first.edges.some((item) => item.id === 'canvas-input'));
  assert.ok(first.edges.some((item) => item.id === 'instance::__input_edge__::canvas-input'));
  assert.deepEqual(first, second, 'scope output must not depend on root array ordering');
  assert.equal(JSON.stringify({ nodes, edges }), before, 'scope construction must not mutate the canvas snapshot');
});

test('parallel loop exact clone graph expands the cloned subflow with request-bound identities', () => {
  const requestId = 'run:subflow-loop:12345678';
  const child = definition('loop-child', [node('provider', 'image')], [], {
    inputs: [{
      id: 'input',
      name: '输入',
      kind: 'any',
      required: false,
      internalNodeId: 'provider',
      internalHandle: 'text-in',
    }],
  });
  const instance = node('child-instance', 'subflow', {
    definition: child,
    definitionId: child.id,
    definitionVersion: child.version,
    definitionProjectId: child.projectId,
  });
  const scope = buildPossibleDerivedExecutionScope({
    nodes: [
      node('source', 'text', { textSegments: ['one', 'two'] }),
      node('loop', 'loop', { mode: 'parallel', kind: 'text' }),
      instance,
    ],
    edges: [
      edge('source-loop', 'source', 'loop'),
      edge('loop-child', 'loop', instance.id, undefined, 'input'),
    ],
    executionNodeIds: ['loop'],
    requestId,
  });

  assert.equal(scope.coverageComplete, true);
  const cloneInstance = loopParallelCloneNodeId('loop', requestId, 1, 0);
  const cloneProvider = `${encodeURIComponent(cloneInstance)}::provider`;
  assert.ok(scope.requiredAuthorizationNodeIds.includes('child-instance'));
  assert.ok(scope.requiredAuthorizationNodeIds.includes('child-instance::provider'));
  assert.ok(scope.requiredAuthorizationNodeIds.includes(cloneInstance));
  assert.ok(scope.requiredAuthorizationNodeIds.includes(cloneProvider));
  assert.deepEqual(scope.loopParallelCloneGroups, [{
    schedulerNodeId: 'loop',
    itemCount: 2,
    cloneCount: 1,
    cloneNodeIds: [cloneInstance],
  }]);
  assert.deepEqual(scope.expandedSubflowInstanceIds, [cloneInstance, 'child-instance'].sort());
});

test('parallel loop fails closed without a Run request ID or when this run can change its input count', () => {
  const source = node('source', 'text', { textSegments: ['one', 'two'] });
  const loop = node('loop', 'loop', { mode: 'parallel', kind: 'text' });
  const provider = node('provider', 'image');
  const nodes = [source, loop, provider];
  const edges = [edge('source-loop', 'source', 'loop'), edge('loop-provider', 'loop', 'provider')];

  const missingRequest = buildPossibleDerivedExecutionScope({
    nodes,
    edges,
    executionNodeIds: ['loop'],
  });
  assert.equal(missingRequest.coverageComplete, false);
  assert.ok(blockerCodes(missingRequest).includes('loop-request-id-invalid'));

  const unstable = buildPossibleDerivedExecutionScope({
    nodes,
    edges,
    executionNodeIds: ['source', 'loop'],
    requestId: 'run:unstable-loop:12345678',
  });
  assert.equal(unstable.coverageComplete, false);
  assert.ok(blockerCodes(unstable).includes('loop-input-unstable'));
  assert.deepEqual(unstable.loopParallelCloneGroups, []);
});

test('custom parallel loop preflight expands isolated per-iteration material snapshots', () => {
  const requestId = 'run:custom-scope:12345678';
  const nodes = [
    node('prompts', 'text-split', { textSegments: ['one', 'two', 'three'] }),
    node('image-source', 'upload', { imageUrls: ['reference.png'] }),
    node('loop', 'loop', {
      mode: 'parallel-custom',
      kind: 'text',
      parallelCustomStrategies: { text: 'sequence', image: 'fixed' },
    }),
    node('provider', 'image'),
  ];
  const edges = [
    edge('prompts-loop', 'prompts', 'loop'),
    edge('image-loop', 'image-source', 'loop'),
    edge('loop-provider', 'loop', 'provider'),
  ];

  const scope = buildPossibleDerivedExecutionScope({ nodes, edges, executionNodeIds: ['loop'], requestId });
  const secondProvider = loopParallelCloneNodeId('loop', requestId, 1, 0);
  const thirdProvider = loopParallelCloneNodeId('loop', requestId, 2, 0);

  assert.equal(scope.coverageComplete, true);
  assert.deepEqual(scope.loopParallelCloneGroups, [{
    schedulerNodeId: 'loop',
    itemCount: 3,
    cloneCount: 2,
    cloneNodeIds: [secondProvider, thirdProvider].sort(),
  }]);
  const secondData = scope.nodes.find((item) => item.id === secondProvider)?.data as any;
  const thirdData = scope.nodes.find((item) => item.id === thirdProvider)?.data as any;
  assert.deepEqual(secondData.__loopCustomInput.texts.map((item: any) => item.url), ['two']);
  assert.deepEqual(secondData.__loopCustomInput.images.map((item: any) => item.url), ['reference.png']);
  assert.deepEqual(thirdData.__loopCustomInput.texts.map((item: any) => item.url), ['three']);
  assert.deepEqual(thirdData.__loopCustomInput.images.map((item: any) => item.url), ['reference.png']);
});

test('non-embedded dependency is fail-closed until the exact fixed definition is prefetched', () => {
  const inner = definition('remote-inner', [node('remote-provider', 'video')], [], { version: 7 });
  const outer = definition('remote-outer', [node('remote-child', 'subflow', {
    definitionId: inner.id,
    definitionVersion: inner.version,
    definitionProjectId: inner.projectId,
  })]);
  const instance = node('remote-instance', 'subflow', {
    definition: outer,
    definitionId: outer.id,
    definitionVersion: outer.version,
    definitionProjectId: outer.projectId,
  });

  const unresolved = buildPossibleDerivedExecutionScope({
    nodes: [instance],
    edges: [],
    executionNodeIds: [instance.id],
  });
  assert.equal(unresolved.coverageComplete, false);
  assert.deepEqual(blockerCodes(unresolved), ['subflow-dependency-unavailable']);
  assert.deepEqual(unresolved.blockers[0].dependency, {
    definitionId: inner.id,
    version: inner.version,
    projectId: inner.projectId,
  });
  assert.deepEqual(unresolved.requiredAuthorizationNodeIds, ['remote-instance']);

  let lookups = 0;
  const resolved = buildPossibleDerivedExecutionScope({
    nodes: [instance],
    edges: [],
    executionNodeIds: [instance.id],
    resolveSubflowDefinition: (reference) => {
      lookups += 1;
      return reference.definitionId === inner.id && reference.version === inner.version ? inner : null;
    },
  });
  assert.equal(resolved.coverageComplete, true);
  assert.equal(lookups, 1, 'prefetched lookup is deterministic and memoized per fixed dependency');
  assert.deepEqual(resolved.requiredAuthorizationNodeIds, [
    'remote-instance',
    'remote-instance::remote-child::remote-provider',
  ]);

  const wrongVersion = { ...inner, version: inner.version + 1 };
  const mismatched = buildPossibleDerivedExecutionScope({
    nodes: [instance],
    edges: [],
    executionNodeIds: [instance.id],
    resolveSubflowDefinition: () => wrongVersion,
  });
  assert.equal(mismatched.coverageComplete, false);
  assert.deepEqual(blockerCodes(mismatched), ['subflow-dependency-pin-mismatch']);
});

test('subflow recursion, runtime identity collision and graph bounds all fail closed', () => {
  const recursive = definition('recursive', []);
  recursive.nodes = [node('self', 'subflow', {
    definitionId: recursive.id,
    definitionVersion: recursive.version,
    definitionProjectId: recursive.projectId,
  })];
  const recursiveInstance = node('recursive-instance', 'subflow', {
    definition: recursive,
    definitionId: recursive.id,
    definitionVersion: recursive.version,
    definitionProjectId: recursive.projectId,
  });
  const recursiveScope = buildPossibleDerivedExecutionScope({
    nodes: [recursiveInstance],
    edges: [],
    executionNodeIds: [recursiveInstance.id],
    resolveSubflowDefinition: () => recursive,
  });
  assert.equal(recursiveScope.coverageComplete, false);
  assert.deepEqual(blockerCodes(recursiveScope), ['subflow-dependency-cycle']);

  const simple = definition('simple', [node('provider', 'image')]);
  const simpleInstance = node('instance', 'subflow', {
    definition: simple,
    definitionId: simple.id,
    definitionVersion: simple.version,
    definitionProjectId: simple.projectId,
  });
  const collision = buildPossibleDerivedExecutionScope({
    nodes: [simpleInstance, node('instance::provider', 'text')],
    edges: [],
    executionNodeIds: [simpleInstance.id],
  });
  assert.equal(collision.coverageComplete, false);
  assert.deepEqual(blockerCodes(collision), ['subflow-runtime-node-id-collision']);

  const bounded = buildPossibleDerivedExecutionScope({
    nodes: [node('loop', 'loop'), node('one', 'image'), node('two', 'video')],
    edges: [edge('loop-one', 'loop', 'one'), edge('one-two', 'one', 'two')],
    executionNodeIds: ['loop'],
    limits: { maxNodes: 2 },
  });
  assert.equal(bounded.coverageComplete, false);
  assert.ok(blockerCodes(bounded).includes('graph-node-limit'));
});

test('ordinary single-node execution does not authorize downstream nodes', () => {
  const nodes = [node('source', 'text'), node('selected', 'image'), node('downstream', 'video')];
  const edges = [edge('source-selected', 'source', 'selected'), edge('selected-downstream', 'selected', 'downstream')];
  const scope = buildPossibleDerivedExecutionScope({ nodes, edges, executionNodeIds: ['selected'] });

  assert.equal(scope.coverageComplete, true);
  assert.deepEqual(scope.requiredAuthorizationNodeIds, ['selected']);
  assert.deepEqual(scope.nodes.map((item) => item.id), ['selected', 'source']);
  assert.deepEqual(scope.edges.map((item) => item.id), ['source-selected']);
});
