import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Edge, Node } from '@xyflow/react';
import { analyzeSubflowBoundary, compileSubflow, detachSubflowInstance, diffSubflowDefinitions, loadSubflowDependencyDefinitions, prepareSubflowRootInputs, subflowDependencyMapKey, upgradeSubflowInstances, validateSubflowDefinition, type SubflowDefinition } from '../src/utils/subflows.ts';
import { getConnectionPortType, getNodeInputs, getNodeOutputs, isConnectionValid } from '../src/config/portTypes.ts';

function read(rel: string) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

const nodes: Node[] = [
  { id: 'outside-in', type: 'text', position: { x: 0, y: 0 }, data: {} },
  { id: 'inside-a', type: 'image', position: { x: 100, y: 100 }, data: { prompt: 'a' } },
  { id: 'inside-b', type: 'video', position: { x: 500, y: 100 }, data: {} },
  { id: 'outside-out', type: 'output', position: { x: 900, y: 100 }, data: {} },
];
const edges: Edge[] = [
  { id: 'enter', source: 'outside-in', target: 'inside-a', targetHandle: 'text-in' },
  { id: 'internal', source: 'inside-a', target: 'inside-b', sourceHandle: 'image-out', targetHandle: 'image-in' },
  { id: 'leave', source: 'inside-b', target: 'outside-out', sourceHandle: 'video-out' },
];

test('boundary analysis keeps every crossing edge as an explicit typed port', () => {
  const result = analyzeSubflowBoundary(nodes.slice(1, 3), edges, { name: '图生视频' });
  assert.equal(result.definition.nodes.length, 2);
  assert.equal(result.definition.edges.length, 1);
  assert.equal(result.definition.inputs.length, 1);
  assert.equal(result.definition.inputs[0].kind, 'text');
  assert.equal(result.definition.outputs[0].kind, 'video');
  assert.equal(result.definition.nodes[0].position.x, 0);
});

test('compiler namespaces nodes, applies exposed overrides and maps ports', () => {
  const analysis = analyzeSubflowBoundary(nodes.slice(1, 3), edges);
  const definition: SubflowDefinition = {
    ...analysis.definition,
    id: 'flow-a',
    version: 1,
    exposedParameters: [{ id: 'prompt', name: '提示词', nodeId: 'inside-a', dataKey: 'prompt' }],
  };
  assert.equal(validateSubflowDefinition(definition), true);
  const compiled = compileSubflow(definition, 'instance-7', { prompt: 'updated' });
  assert.deepEqual(compiled.order, ['instance-7::inside-a', 'instance-7::inside-b']);
  assert.equal((compiled.nodes[0].data as any).prompt, 'updated');
  assert.equal(compiled.edges[0].source, 'instance-7::inside-a');
  assert.equal(compiled.inputTargets[definition.inputs[0].id].nodeId, 'instance-7::inside-a');
});

test('root input bindings enforce capacity and materialize typed defaults', () => {
  const definition: SubflowDefinition = {
    id: 'root-inputs', version: 1, name: 'root inputs', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], outputs: [], edges: [],
    inputs: [{ id: 'prompt', name: 'Prompt', kind: 'text', required: true, minConnections: 1, maxConnections: 1, defaultValue: 'fallback', schema: { type: 'string', minLength: 2 }, internalNodeId: 'leaf', internalHandle: 'text-in' }],
    nodes: [{ id: 'leaf', type: 'image', position: { x: 0, y: 0 }, data: {} }],
  };
  const compiled = compileSubflow(definition, 'root::instance');
  const prepared = prepareSubflowRootInputs(definition, 'root::instance', [], [], compiled.inputTargets);
  assert.equal(prepared.nodes.length, 1);
  assert.equal(prepared.edges.length, 1);
  assert.deepEqual(prepared.nodes[0].data, {
    text: 'fallback', outputText: 'fallback', prompt: 'fallback', __subflowRuntime: true, __subflowDefaultInput: 'prompt',
  });
  assert.equal(prepared.edges[0].target, 'root%3A%3Ainstance::leaf');
  assert.deepEqual(prepared.snapshot.prompt, { mode: 'default', value: 'fallback' });

  const source: Node = { id: 'source', type: 'text', position: { x: 0, y: 0 }, data: { text: 'connected' } };
  const inputEdge: Edge = { id: 'edge::one', source: 'source', sourceHandle: 'text-out', target: 'root::instance', targetHandle: 'prompt' };
  const connected = prepareSubflowRootInputs(definition, 'root::instance', [source], [inputEdge], compiled.inputTargets);
  assert.equal(connected.nodes.length, 0);
  assert.equal(connected.edges[0].id, 'root%3A%3Ainstance::__input_edge__::edge%3A%3Aone');
  assert.equal((connected.snapshot.prompt as any).values[0].data.text, 'connected');
  assert.throws(() => prepareSubflowRootInputs(definition, 'root::instance', [source], [inputEdge, { ...inputEdge, id: 'edge-2' }], compiled.inputTargets), /最多允许 1 条连接/);
});

test('root input bindings reject missing required and stale ports', () => {
  const definition: SubflowDefinition = {
    id: 'required-input', version: 1, name: 'required input', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], outputs: [], edges: [],
    inputs: [{ id: 'image', name: 'Image', kind: 'image', required: true, minConnections: 1, maxConnections: 1, internalNodeId: 'leaf', internalHandle: 'image-in' }],
    nodes: [{ id: 'leaf', type: 'image', position: { x: 0, y: 0 }, data: {} }],
  };
  const compiled = compileSubflow(definition, 'instance');
  assert.throws(() => prepareSubflowRootInputs(definition, 'instance', [], [], compiled.inputTargets), /至少需要 1 条连接/);
  assert.throws(() => prepareSubflowRootInputs(definition, 'instance', [], [{ id: 'stale', source: 'source', target: 'instance', targetHandle: 'removed' }], compiled.inputTargets), /不存在的端口/);
});

test('runtime namespaces are bijective when source IDs contain delimiters', () => {
  const definition: SubflowDefinition = {
    id: 'delimiter-ids', version: 1, name: 'delimiter-ids', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], inputs: [], outputs: [], edges: [],
    nodes: [
      { id: 'a::b', type: 'text', position: { x: 0, y: 0 }, data: {} },
      { id: 'a--b', type: 'text', position: { x: 1, y: 0 }, data: {} },
    ],
  };
  const compiled = compileSubflow(definition, 'instance::root');
  assert.deepEqual(compiled.nodes.map((node) => node.id), [
    'instance%3A%3Aroot::a%3A%3Ab',
    'instance%3A%3Aroot::a--b',
  ]);
  assert.equal(new Set(compiled.nodes.map((node) => node.id)).size, 2);
});

test('compiler rejects cycles and recursive/deep nesting guard', () => {
  const definition: SubflowDefinition = {
    id: 'flow-loop', version: 1, name: 'bad', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], inputs: [], outputs: [],
    nodes: [{ id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {} }, { id: 'b', type: 'text', position: { x: 1, y: 1 }, data: {} }],
    edges: [{ id: 'ab', source: 'a', target: 'b' }, { id: 'ba', source: 'b', target: 'a' }],
  };
  assert.throws(() => compileSubflow(definition, 'x'), /循环依赖/);
  definition.edges = [];
  assert.throws(() => compileSubflow(definition, 'x', {}, { stack: ['flow-loop'] }), /递归引用/);
  assert.throws(() => compileSubflow(definition, 'x', {}, { stack: Array(8).fill('other') }), /超过 8 层/);
});

test('recursive compiler expands fixed nested versions into a deterministic execution plan', () => {
  const child: SubflowDefinition = {
    id: 'child', version: 3, projectId: 'project-a', name: 'child', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [],
    inputs: [{ id: 'prompt-in', name: '提示词', kind: 'text', required: true, minConnections: 1, maxConnections: 1, internalNodeId: 'image', internalHandle: 'text-in' }],
    outputs: [{ id: 'video-out', name: '视频', kind: 'video', required: false, internalNodeId: 'video', internalHandle: 'video-out' }],
    nodes: [
      { id: 'image', type: 'image', position: { x: 0, y: 0 }, data: { prompt: 'child' } },
      { id: 'video', type: 'video', position: { x: 300, y: 0 }, data: {} },
    ],
    edges: [{ id: 'child-edge', source: 'image', sourceHandle: 'image-out', target: 'video', targetHandle: 'image-in' }],
  };
  const parent: SubflowDefinition = {
    id: 'parent', version: 2, projectId: 'project-a', name: 'parent', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [],
    inputs: [],
    outputs: [{ id: 'result', name: '结果', kind: 'video', required: false, internalNodeId: 'nested', internalHandle: 'video-out' }],
    nodes: [
      { id: 'source', type: 'text', position: { x: 0, y: 0 }, data: { text: 'hello' } },
      { id: 'nested', type: 'subflow', position: { x: 300, y: 0 }, data: { definitionId: 'child', definitionVersion: 3, definitionProjectId: 'project-a' } },
    ],
    edges: [{ id: 'parent-edge', source: 'source', sourceHandle: 'text-out', target: 'nested', targetHandle: 'prompt-in' }],
  };
  const options = { resolveDefinition: () => child };
  const first = compileSubflow(parent, 'instance-1', {}, options);
  const second = compileSubflow(parent, 'instance-1', {}, options);
  assert.deepEqual(first, second);
  assert.deepEqual(first.order, [
    'instance-1::source',
    'instance-1::nested::image',
    'instance-1::nested::video',
  ]);
  assert.deepEqual(first.batches, [
    ['instance-1::source'],
    ['instance-1::nested::image'],
    ['instance-1::nested::video'],
  ]);
  assert.equal(first.nodes.length, 3);
  assert.equal(first.edges.length, 2);
  assert.equal(first.outputSources.result.nodeId, 'instance-1::nested::video');
  assert.deepEqual(first.trace['instance-1::nested::video'].instancePath, ['instance-1', 'nested', 'video']);
  assert.deepEqual(first.dependencies, [{ definitionId: 'child', version: 3, projectId: 'project-a' }]);
});

test('parent exposed parameters override fixed child parameters through the nested instance', () => {
  const child: SubflowDefinition = {
    id: 'child-param', version: 2, projectId: 'project-a', name: 'child', description: '', tags: [], requiredCapabilities: [], assetRefs: [], inputs: [], outputs: [],
    exposedParameters: [{ id: 'child-prompt', name: 'Child prompt', nodeId: 'leaf', dataKey: 'prompt', required: true, schema: { type: 'string' } }],
    nodes: [{ id: 'leaf', type: 'text', position: { x: 0, y: 0 }, data: {} }], edges: [],
  };
  const parent: SubflowDefinition = {
    id: 'parent-param', version: 1, projectId: 'project-a', name: 'parent', description: '', tags: [], requiredCapabilities: [], assetRefs: [], inputs: [], outputs: [],
    exposedParameters: [{ id: 'public-prompt', name: 'Prompt', nodeId: 'nested', dataKey: 'child-prompt', required: true, schema: { type: 'string' } }],
    nodes: [{ id: 'nested', type: 'subflow', position: { x: 0, y: 0 }, data: { definition: child, definitionId: child.id, definitionVersion: child.version, definitionProjectId: child.projectId, parameterOverrides: { 'child-prompt': 'stored' } } }], edges: [],
  };
  const compiled = compileSubflow(parent, 'instance', { 'public-prompt': 'from-parent' });
  assert.equal((compiled.nodes[0].data as any).prompt, 'from-parent');
});

test('runtime dependency preloader resolves reference-only descendants by exact project and version', async () => {
  const child: SubflowDefinition = {
    id: 'runtime-child', version: 3, projectId: 'project-a', name: 'child', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], inputs: [], outputs: [],
    nodes: [{ id: 'leaf', type: 'text', position: { x: 0, y: 0 }, data: {} }], edges: [],
  };
  const parent: SubflowDefinition = {
    id: 'runtime-parent', version: 1, projectId: 'project-a', name: 'parent', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], inputs: [], outputs: [],
    nodes: [{ id: 'nested', type: 'subflow', position: { x: 0, y: 0 }, data: { definitionId: child.id, definitionVersion: child.version, definitionProjectId: child.projectId } }], edges: [],
  };
  const calls: string[] = [];
  const loaded = await loadSubflowDependencyDefinitions(parent, async (reference) => {
    calls.push(`${reference.projectId}:${reference.definitionId}:${reference.version}`);
    return child;
  });
  assert.deepEqual(calls, ['project-a:runtime-child:3']);
  const compiled = compileSubflow(parent, 'instance', {}, { resolveDefinition: (reference) => loaded.get(`${reference.projectId}:${reference.definitionId}:${reference.version}`) });
  assert.equal(compiled.nodes[0].id, 'instance::nested::leaf');
});

test('recursive compiler rejects missing versions, cross-project definitions and reference cycles', () => {
  const nestedNode = (definitionId: string, version: number): Node => ({
    id: `use-${definitionId}`,
    type: 'subflow',
    position: { x: 0, y: 0 },
    data: { definitionId, definitionVersion: version, definitionProjectId: 'project-a' },
  });
  const make = (id: string, childId: string): SubflowDefinition => ({
    id, version: 1, projectId: 'project-a', name: id, description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], inputs: [], outputs: [],
    nodes: [nestedNode(childId, 1)], edges: [],
  });
  const a = make('a', 'b');
  const b = make('b', 'a');
  assert.throws(() => compileSubflow(a, 'x', {}, { resolveDefinition: (ref) => ref.definitionId === 'b' ? b : a }), /递归引用/);
  assert.throws(() => compileSubflow(a, 'x'), /找不到嵌套子工作流/);
  const foreign = { ...b, projectId: 'project-b' };
  assert.throws(() => compileSubflow(a, 'x', {}, { resolveDefinition: () => foreign }), /跨项目引用/);
});

test('compiler validates parameter schemas and expansion limits', () => {
  const definition: SubflowDefinition = {
    id: 'params', version: 1, name: 'params', description: '', tags: [], requiredCapabilities: [], assetRefs: [], inputs: [], outputs: [],
    exposedParameters: [{ id: 'steps', name: '步数', nodeId: 'a', dataKey: 'steps', required: true, schema: { type: 'integer', minimum: 1, maximum: 8 } }],
    nodes: [
      { id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} },
      { id: 'b', type: 'output', position: { x: 300, y: 0 }, data: {} },
    ], edges: [],
  };
  assert.equal((compileSubflow(definition, 'x', { steps: 4 }).nodes[0].data as any).steps, 4);
  assert.throws(() => compileSubflow(definition, 'x', { steps: 9 }), /参数类型或范围无效/);
  assert.throws(() => compileSubflow(definition, 'x'), /缺少必填参数/);
  assert.throws(() => compileSubflow(definition, 'x', { steps: 4 }, { maxNodes: 1 }), /展开节点超过/);
  definition.exposedParameters = [{ id: 'secret', name: 'API Key', nodeId: 'a', dataKey: 'apiKey' }];
  assert.throws(() => compileSubflow(definition, 'x'), /私密字段不能公开/);
});

test('boundary analysis strips private credentials but preserves provider selection fields', () => {
  const sensitive: Node = {
    id: 'private-node', type: 'image', position: { x: 0, y: 0 },
    data: { apiKey: 'sk-private', apiKeySource: 'global', nested: { cookie: 'private', model: 'safe' } },
  };
  const result = analyzeSubflowBoundary([sensitive], []);
  assert.equal((result.definition.nodes[0].data as any).apiKey, undefined);
  assert.equal((result.definition.nodes[0].data as any).apiKeySource, 'global');
  assert.equal((result.definition.nodes[0].data as any).nested.cookie, undefined);
  assert.equal((result.definition.nodes[0].data as any).nested.model, 'safe');
  const extended = analyzeSubflowBoundary([{
    ...sensitive,
    data: {
      rhApiKey: 'rh-private', appSecret: 'private', secretKey: 'private', accessKeySecret: 'private',
      sourceUrl: 'https://example.com/file.png?signature=private',
      safeUrl: 'https://example.com/file.png?width=100',
    },
  }], []);
  const sanitized = extended.definition.nodes[0].data as any;
  assert.equal(sanitized.rhApiKey, undefined);
  assert.equal(sanitized.appSecret, undefined);
  assert.equal(sanitized.secretKey, undefined);
  assert.equal(sanitized.accessKeySecret, undefined);
  assert.equal(sanitized.sourceUrl, undefined);
  assert.equal(sanitized.safeUrl, 'https://example.com/file.png?width=100');
});

test('dynamic subflow handles participate in type and capacity validation', () => {
  const definition: SubflowDefinition = {
    id: 'ports', version: 1, name: 'ports', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], nodes: [], edges: [],
    inputs: [{ id: 'prompt', name: '提示词', kind: 'text', required: true, maxConnections: 1, internalNodeId: 'unused' }],
    outputs: [{ id: 'image', name: '图像', kind: 'image', required: false, maxConnections: 1, internalNodeId: 'unused' }],
  };
  const source: Node = {
    id: 'source-flow', type: 'subflow', position: { x: 0, y: 0 },
    data: { definitionId: definition.id, definitionVersion: definition.version, definition },
  };
  const target: Node = { id: 'target-image', type: 'image', position: { x: 1, y: 0 }, data: {} };
  assert.deepEqual(getNodeInputs(source), ['text']);
  assert.deepEqual(getNodeOutputs(source), ['image']);
  assert.equal(getConnectionPortType(source, target, { sourceHandle: 'image' }), 'image');
  assert.equal(isConnectionValid(source, target, { sourceHandle: 'image' }), true);
  assert.equal(isConnectionValid(source, target, { sourceHandle: 'missing' }), false);
  assert.equal(isConnectionValid(source, target, { sourceHandle: 'image' }, [
    { source: 'source-flow', sourceHandle: 'image', target: 'another' },
  ]), false);
});

test('version diff is deterministic and separates nodes, edges, ports and parameters', () => {
  const first = analyzeSubflowBoundary(nodes.slice(1, 3), edges).definition;
  const before: SubflowDefinition = { ...first, id: 'diff', projectId: 'project-a', version: 1 };
  const after: SubflowDefinition = {
    ...before,
    version: 2,
    nodes: [
      { ...before.nodes[0], data: { prompt: 'changed' } },
      { id: 'new-node', type: 'output', position: { x: 700, y: 0 }, data: {} },
    ],
    edges: [],
    inputs: before.inputs.map((port) => ({ ...port, description: 'updated' })),
    outputs: [],
    exposedParameters: [{ id: 'p1', name: '参数', nodeId: before.nodes[0].id, dataKey: 'prompt' }],
  };
  const diff = diffSubflowDefinitions(before, after);
  assert.deepEqual(diff.nodes, { added: ['new-node'], removed: ['inside-b'], changed: ['inside-a'] });
  assert.deepEqual(diff.edges.removed, ['internal']);
  assert.deepEqual(diff.inputs.changed, [before.inputs[0].id]);
  assert.deepEqual(diff.outputs.removed, [before.outputs[0].id]);
  assert.deepEqual(diff.parameters.added, ['p1']);
  assert.deepEqual(diffSubflowDefinitions(before, after), diff);
});

test('detaching a subflow expands nodes and reconnects every external boundary edge', () => {
  const analysis = analyzeSubflowBoundary(nodes.slice(1, 3), edges);
  const definition: SubflowDefinition = { ...analysis.definition, id: 'detach', version: 1 };
  const instance: Node = {
    id: 'instance', type: 'subflow', position: { x: 1000, y: 500 },
    data: { definition, parameterOverrides: {} },
  };
  const source: Node = { id: 'source', type: 'text', position: { x: 0, y: 500 }, data: {} };
  const target: Node = { id: 'target', type: 'output', position: { x: 1800, y: 500 }, data: {} };
  const result = detachSubflowInstance([source, instance, target], [
    { id: 'outside-in', source: 'source', target: 'instance', targetHandle: definition.inputs[0].id },
    { id: 'outside-out', source: 'instance', sourceHandle: definition.outputs[0].id, target: 'target' },
  ], 'instance');
  assert.equal(result.nodes.some((node) => node.id === 'instance'), false);
  assert.deepEqual(result.detachedNodeIds, ['instance::inside-a', 'instance::inside-b']);
  assert.deepEqual(result.nodes.find((node) => node.id === 'instance::inside-a')?.position, { x: 1000, y: 500 });
  assert.equal((result.nodes.find((node) => node.id === 'instance::inside-a')?.data as any).__subflowInstanceId, undefined);
  assert.equal(result.edges.find((edge) => edge.id === 'outside-in')?.target, 'instance::inside-a');
  assert.equal(result.edges.find((edge) => edge.id === 'outside-out')?.source, 'instance::inside-b');
  assert.ok(result.edges.some((edge) => edge.id === 'instance::internal'));
});

test('detaching resolves a reference-only nested definition by exact project and fixed version', async () => {
  const child: SubflowDefinition = {
    id: 'detach-child', version: 4, projectId: 'project-a', name: 'child', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [],
    nodes: [{ id: 'leaf', type: 'image', position: { x: 10, y: 20 }, data: { model: 'fixed-child-model' } }],
    edges: [],
    inputs: [{ id: 'child-prompt', name: 'Prompt', kind: 'text', required: false, internalNodeId: 'leaf', internalHandle: 'text-in' }],
    outputs: [{ id: 'child-image', name: 'Image', kind: 'image', required: false, internalNodeId: 'leaf', internalHandle: 'image-out' }],
  };
  const root: SubflowDefinition = {
    id: 'detach-root', version: 2, projectId: 'project-a', name: 'root', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [],
    nodes: [{
      id: 'nested', type: 'subflow', position: { x: 40, y: 50 },
      data: { definitionId: child.id, definitionVersion: child.version, definitionProjectId: child.projectId },
    }],
    edges: [],
    inputs: [{ id: 'root-prompt', name: 'Prompt', kind: 'text', required: false, internalNodeId: 'nested', internalHandle: 'child-prompt' }],
    outputs: [{ id: 'root-image', name: 'Image', kind: 'image', required: false, internalNodeId: 'nested', internalHandle: 'child-image' }],
  };
  const instance: Node = {
    id: 'instance', type: 'subflow', position: { x: 1000, y: 500 },
    data: { definitionId: root.id, definitionVersion: root.version, definitionProjectId: root.projectId, definition: root, parameterOverrides: {} },
  };
  const source: Node = { id: 'source', type: 'text', position: { x: 0, y: 500 }, data: {} };
  const target: Node = { id: 'target', type: 'output', position: { x: 1800, y: 500 }, data: {} };
  const canvasNodes = [source, instance, target];
  const canvasEdges: Edge[] = [
    { id: 'outside-in', source: source.id, target: instance.id, targetHandle: 'root-prompt' },
    { id: 'outside-out', source: instance.id, sourceHandle: 'root-image', target: target.id },
  ];
  const before = structuredClone({ nodes: canvasNodes, edges: canvasEdges });

  assert.throws(() => detachSubflowInstance(canvasNodes, canvasEdges, instance.id), /找不到嵌套子工作流/);
  assert.deepEqual({ nodes: canvasNodes, edges: canvasEdges }, before, 'failed resolution must not mutate the live canvas snapshot');

  const calls: string[] = [];
  const dependencies = await loadSubflowDependencyDefinitions(root, async (reference) => {
    calls.push(subflowDependencyMapKey(reference));
    assert.deepEqual(reference, { definitionId: child.id, version: child.version, projectId: child.projectId });
    return child;
  });
  const result = detachSubflowInstance(canvasNodes, canvasEdges, instance.id, {
    resolveDefinition: (reference) => dependencies.get(subflowDependencyMapKey(reference)),
  });

  assert.deepEqual(calls, ['project-a:detach-child:4']);
  assert.deepEqual(result.detachedNodeIds, ['instance::nested::leaf']);
  assert.deepEqual(result.nodes.find((node) => node.id === 'instance::nested::leaf')?.position, { x: 1050, y: 570 });
  assert.equal((result.nodes.find((node) => node.id === 'instance::nested::leaf')?.data as any).model, 'fixed-child-model');
  assert.equal(result.edges.find((edge) => edge.id === 'outside-in')?.target, 'instance::nested::leaf');
  assert.equal(result.edges.find((edge) => edge.id === 'outside-in')?.targetHandle, 'text-in');
  assert.equal(result.edges.find((edge) => edge.id === 'outside-out')?.source, 'instance::nested::leaf');
  assert.equal(result.edges.find((edge) => edge.id === 'outside-out')?.sourceHandle, 'image-out');
});

test('canvas detach waits for dependency loading and resolves against the latest canvas snapshot', () => {
  const canvas = read('src/components/Canvas.tsx');
  assert.match(canvas, /const handleDetachSubflow = useCallback\(async \(\) =>/);
  assert.match(canvas, /await loadSubflowDependencyDefinitions\(/);
  assert.match(canvas, /const current = \{ nodes: nodesRef\.current, edges: edgesRef\.current \};/);
  assert.match(canvas, /resolveDefinition: \(reference\) => dependencyDefinitions\.get\(subflowDependencyMapKey\(reference\)\)/);
  assert.match(canvas, /加载依赖期间子工作流固定版本已变化/);
});

test('subflow publication UI keeps an explicit revision, required summary and recoverable conflict draft', () => {
  const canvas = read('src/components/Canvas.tsx');
  const collaboration = read('src/components/CollaborationWorkspace.tsx');
  const workbench = read('src/components/ProjectWorkbench.tsx');
  const api = read('src/services/api.ts');
  const auth = read('backend/src/collaboration/auth.js');

  assert.match(api, /baseRevision: number;/);
  assert.match(api, /changeSummary: string;/);
  assert.match(canvas, /编辑草稿 · 基于 revision/);
  assert.match(canvas, /变更说明（必填）/);
  assert.match(canvas, /你的草稿仍保留，未覆盖他人版本/);
  assert.match(canvas, /放弃当前草稿并载入最新版本/);
  assert.match(canvas, /error instanceof api\.ApiRequestError && error\.status === 409/);

  assert.match(collaboration, /capabilities\.includes\('publishSubflow'\)/);
  assert.match(collaboration, /\/api\/collab\/subflows\/\$\{encodeURIComponent\(subflowDraft\.definition\.id\)\}\/publish/);
  assert.match(collaboration, /message\.type === 'subflow\.published'/);
  assert.match(collaboration, /当前草稿未丢失/);
  assert.match(collaboration, /放弃草稿并载入最新版本/);
  assert.doesNotMatch(collaboration, /conflict: undefined/);
  assert.match(workbench, /分类和标签草稿仍保留/);
  assert.match(workbench, /loadLatestSubflowLibraryConflict/);
  assert.match(workbench, /baseRevision,/);

  assert.match(auth, /owner: \['editGraph', 'publishSubflow'/);
  assert.match(auth, /editor: \['editGraph', 'publishSubflow'/);
  assert.doesNotMatch(auth, /reviewer: \[[^\]]*publishSubflow/);
  assert.doesNotMatch(auth, /viewer: \[[^\]]*publishSubflow/);
});

test('detaching refuses stale ports and a running projection', () => {
  const analysis = analyzeSubflowBoundary(nodes.slice(1, 3), edges);
  const definition: SubflowDefinition = { ...analysis.definition, id: 'detach-guard', version: 1 };
  const instance: Node = { id: 'instance', type: 'subflow', position: { x: 0, y: 0 }, data: { definition } };
  assert.throws(() => detachSubflowInstance([instance], [{ id: 'bad', source: 'outside', target: 'instance', targetHandle: 'missing' }], 'instance'), /输入端口不存在/);
  const runtime: Node = { id: 'instance::runtime', type: 'image', position: { x: 0, y: 0 }, data: { __subflowRuntime: true, __subflowInstanceId: 'instance' } };
  assert.throws(() => detachSubflowInstance([instance, runtime], [], 'instance'), /运行中/);
});

test('detaching rejects node and edge ID collisions without replacing existing canvas entities', () => {
  const analysis = analyzeSubflowBoundary(nodes.slice(1, 3), edges);
  const definition: SubflowDefinition = { ...analysis.definition, id: 'detach-collision', version: 1 };
  const instance: Node = { id: 'instance', type: 'subflow', position: { x: 0, y: 0 }, data: { definition } };
  const existingNode: Node = { id: 'instance::inside-a', type: 'text', position: { x: 30, y: 30 }, data: { text: 'must survive' } };
  assert.throws(() => detachSubflowInstance([instance, existingNode], [], 'instance'), /节点 ID 冲突/);

  const source: Node = { id: 'source', type: 'text', position: { x: 0, y: 0 }, data: {} };
  const target: Node = { id: 'target', type: 'output', position: { x: 0, y: 0 }, data: {} };
  const existingEdge: Edge = { id: 'instance::internal', source: 'source', target: 'target' };
  assert.throws(() => detachSubflowInstance([instance, source, target], [existingEdge], 'instance'), /连线 ID 冲突/);
});

test('upgrading fixed instances warns and disconnects removed or changed ports only', () => {
  const analysis = analyzeSubflowBoundary(nodes.slice(1, 3), edges);
  const before: SubflowDefinition = { ...analysis.definition, id: 'upgrade', projectId: 'p1', version: 1, exposedParameters: [{ id: 'old', name: '旧参数', nodeId: 'inside-a', dataKey: 'prompt' }] };
  const after: SubflowDefinition = {
    ...before,
    version: 2,
    inputs: before.inputs.map((port) => ({ ...port, kind: 'metadata' })),
    outputs: [],
    exposedParameters: [],
  };
  const instance: Node = { id: 'instance', type: 'subflow', position: { x: 0, y: 0 }, data: { definitionId: before.id, definitionVersion: 1, definition: before, parameterOverrides: { old: 'value' } } };
  const result = upgradeSubflowInstances([instance], [
    { id: 'in', source: 'source', target: 'instance', targetHandle: before.inputs[0].id },
    { id: 'out', source: 'instance', sourceHandle: before.outputs[0].id, target: 'target' },
  ], before, after);
  assert.deepEqual(result.upgradedNodeIds, ['instance']);
  assert.deepEqual(result.changedPortIds, [before.inputs[0].id]);
  assert.deepEqual(result.removedPortIds, [before.outputs[0].id]);
  assert.deepEqual(result.disconnectedEdges.map((edge) => edge.id).sort(), ['in', 'out']);
  assert.equal(result.edges.length, 0);
  assert.equal((result.nodes[0].data as any).definitionVersion, 2);
  assert.deepEqual((result.nodes[0].data as any).parameterOverrides, {});
  assert.deepEqual(result.removedParameterIds, ['old']);
  assert.deepEqual(result.discardedOverrides, [{ nodeId: 'instance', parameterId: 'old', value: 'value', reason: 'removed' }]);
});

test('subflow upgrade rejects project ambiguity and ignores foreign instances', () => {
  const base: SubflowDefinition = {
    id: 'same-id', version: 1, projectId: 'project-a', name: 'base', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], inputs: [], outputs: [],
    nodes: [{ id: 'leaf', type: 'text', position: { x: 0, y: 0 }, data: {} }], edges: [],
  };
  assert.throws(() => upgradeSubflowInstances([], [], base, { ...base, version: 2, projectId: undefined }), /不能跨项目/);
  const foreign: Node = { id: 'foreign', type: 'subflow', position: { x: 0, y: 0 }, data: { definitionId: base.id, definitionVersion: 1, definitionProjectId: 'project-b', definition: { ...base, projectId: 'project-b' } } };
  const result = upgradeSubflowInstances([foreign], [], base, { ...base, version: 2 });
  assert.deepEqual(result.upgradedNodeIds, []);
  assert.equal((result.nodes[0].data as any).definitionVersion, 1);
});

test('subflow upgrade reports invalid overrides and deterministically trims excess connections', () => {
  const before: SubflowDefinition = {
    id: 'capacity', version: 1, projectId: 'project-a', name: 'before', description: '', tags: [], requiredCapabilities: [], assetRefs: [], inputs: [],
    outputs: [{ id: 'result', name: 'Result', kind: 'image', required: false, minConnections: 0, maxConnections: null, internalNodeId: 'leaf', internalHandle: 'image-out' }],
    exposedParameters: [
      { id: 'removed', name: 'Removed', nodeId: 'leaf', dataKey: 'removed' },
      { id: 'steps', name: 'Steps', nodeId: 'leaf', dataKey: 'steps', schema: { type: 'integer', maximum: 20 } },
    ],
    nodes: [{ id: 'leaf', type: 'image', position: { x: 0, y: 0 }, data: {} }], edges: [],
  };
  const after: SubflowDefinition = {
    ...before, version: 2,
    outputs: [{ ...before.outputs[0], maxConnections: 1 }],
    exposedParameters: [{ id: 'steps', name: 'Steps', nodeId: 'leaf', dataKey: 'steps', schema: { type: 'integer', maximum: 5 } }],
  };
  const instance: Node = { id: 'instance', type: 'subflow', position: { x: 0, y: 0 }, data: { definitionId: before.id, definitionVersion: 1, definitionProjectId: before.projectId, definition: before, parameterOverrides: { removed: 'x', steps: 9 } } };
  const result = upgradeSubflowInstances([instance], [
    { id: 'first', source: 'instance', sourceHandle: 'result', target: 'a' },
    { id: 'second', source: 'instance', sourceHandle: 'result', target: 'b' },
  ], before, after);
  assert.deepEqual(result.changedPortIds, ['result']);
  assert.deepEqual(result.disconnectedEdges.map((edge) => edge.id), ['second']);
  assert.deepEqual(result.edges.map((edge) => edge.id), ['first']);
  assert.deepEqual(result.removedParameterIds, ['removed']);
  assert.deepEqual(result.changedParameterIds, ['steps']);
  assert.deepEqual(result.discardedOverrides.map((item) => [item.parameterId, item.reason]), [['removed', 'removed'], ['steps', 'incompatible']]);
  assert.deepEqual((result.nodes[0].data as any).parameterOverrides, {});
});
