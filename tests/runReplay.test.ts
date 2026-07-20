import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Edge, Node } from '@xyflow/react';
import type { NodeRunSummary, RunDetail } from '../src/types/project.ts';
import {
  RUN_NODE_INPUT_SNAPSHOT_SCHEMA,
  buildRunAttemptOriginalReplayRuntime,
  buildRunOriginalReplayRuntime,
  buildSubflowNodeRunOriginalReplayRuntime,
  captureRunNodeInputSnapshot,
  isReplayableRunNodeInputSnapshot,
  validateSubflowNodeRunOriginalReplay,
  validateRunAttemptOriginalReplay,
  validateRunOriginalReplay,
} from '../src/utils/runReplay.ts';

function node(id: string, type: string, data: Record<string, unknown> = {}): Node {
  return { id, type, position: { x: id.charCodeAt(0), y: id.length }, data };
}

function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string,
  targetHandle?: string,
): Edge {
  return { id, source, target, sourceHandle, targetHandle, data: { label: id } };
}

function nodeRun(
  runId: string,
  nodeId: string,
  status: string,
  inputSnapshot: Record<string, unknown>,
  extras: Partial<NodeRunSummary> = {},
): NodeRunSummary {
  return {
    id: `${runId}-${nodeId}`,
    runId,
    nodeId,
    subflowPath: [],
    status,
    inputSnapshot,
    outputRefs: [],
    createdAt: 100,
    updatedAt: 120,
    ...extras,
  };
}

function run(nodeRuns: NodeRunSummary[]): RunDetail {
  return {
    id: 'source-run',
    projectId: 'project-default',
    canvasId: 'canvas-a',
    canvasRevision: 7,
    initiatorId: 'owner',
    status: 'failed',
    createdAt: 100,
    startedAt: 100,
    finishedAt: 130,
    summary: {
      plannedNodeIds: ['a', 'b', 'c'],
      plannedEdges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
    },
    nodeRuns,
  };
}

test('capture stores the target and only its recursive upstream graph with exact handles', () => {
  const nodes = [
    node('a', 'upload', { images: ['https://example.com/a.png'] }),
    node('b', 'text', { text: 'upstream prompt' }),
    node('c', 'image', { prompt: 'target prompt', model: 'demo-model' }),
    node('side', 'video', { prompt: 'unrelated' }),
  ];
  const edges = [
    edge('a-b', 'a', 'b', 'image', 'reference'),
    edge('b-c', 'b', 'c', 'text', 'prompt'),
    edge('side-candidate', 'a', 'side', 'image', 'first-frame'),
  ];

  const snapshot = captureRunNodeInputSnapshot(nodes, edges, 'c');
  assert.equal(isReplayableRunNodeInputSnapshot(snapshot), true);
  if (!isReplayableRunNodeInputSnapshot(snapshot)) return;
  assert.equal(snapshot.schema, RUN_NODE_INPUT_SNAPSHOT_SCHEMA);
  assert.equal(snapshot.node.id, 'c');
  assert.deepEqual(snapshot.upstreamNodes.map((item) => item.id).sort(), ['a', 'b']);
  assert.deepEqual(snapshot.incomingEdges.map((item) => ({
    id: item.id,
    source: item.source,
    target: item.target,
    sourceHandle: item.sourceHandle,
    targetHandle: item.targetHandle,
  })).sort((left, right) => left.id.localeCompare(right.id)), [
    { id: 'a-b', source: 'a', target: 'b', sourceHandle: 'image', targetHandle: 'reference' },
    { id: 'b-c', source: 'b', target: 'c', sourceHandle: 'text', targetHandle: 'prompt' },
  ]);
});

test('capture is deeply isolated from later canvas mutations', () => {
  const source = node('a', 'text', { nested: { prompt: 'original' }, values: [1, 2] });
  const target = node('b', 'image', { prompt: 'original target' });
  const nodes = [source, target];
  const edges = [edge('a-b', 'a', 'b', 'text', 'prompt')];
  const snapshot = captureRunNodeInputSnapshot(nodes, edges, 'b');
  assert.equal(isReplayableRunNodeInputSnapshot(snapshot), true);
  if (!isReplayableRunNodeInputSnapshot(snapshot)) return;

  (source.data.nested as { prompt: string }).prompt = 'changed';
  (source.data.values as number[]).push(3);
  (target.data as { prompt: string }).prompt = 'changed target';
  (edges[0].data as { label: string }).label = 'changed edge';

  assert.deepEqual(snapshot.upstreamNodes[0].data, { nested: { prompt: 'original' }, values: [1, 2] });
  assert.equal(snapshot.node.data.prompt, 'original target');
  assert.deepEqual(snapshot.incomingEdges[0].data, { label: 'a-b' });
});

test('capture fails closed for values that backend redaction would alter', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['secret field', { apiKey: 'never-store-me' }],
    ['base64', { image: 'data:image/png;base64,AAAA' }],
    ['signed URL', { image: 'https://example.com/a.png?signature=abc&expires=1' }],
    ['oversized string', { prompt: 'x'.repeat(4001) }],
    ['oversized array', { items: Array.from({ length: 101 }, (_, index) => index) }],
    ['undefined', { prompt: undefined }],
    ['non-finite number', { seed: Number.POSITIVE_INFINITY }],
    ['special object', { createdAt: new Date() }],
  ];
  for (const [name, data] of cases) {
    const snapshot = captureRunNodeInputSnapshot([node('target', 'image', data)], [], 'target');
    assert.equal(snapshot.replayable, false, name);
    assert.match(snapshot.replayable ? '' : snapshot.reason, /私密字段|base64|签名查询参数|4000|100|undefined|非有限数字|普通 JSON 对象/, name);
  }
});

test('empty credential placeholders are omitted while non-empty secrets remain unreplayable', () => {
  const snapshot = captureRunNodeInputSnapshot([node('target', 'aggregate-parser', {
    aggregateParserCookie: '',
    apiKey: null,
    nested: { accessToken: undefined, prompt: 'safe' },
  })], [], 'target');
  assert.equal(isReplayableRunNodeInputSnapshot(snapshot), true);
  if (!isReplayableRunNodeInputSnapshot(snapshot)) return;
  assert.deepEqual(snapshot.node.data, { nested: { prompt: 'safe' } });

  const blocked = captureRunNodeInputSnapshot([node('target', 'aggregate-parser', {
    aggregateParserCookie: 'session=secret',
  })], [], 'target');
  assert.equal(blocked.replayable, false);
  assert.match(blocked.replayable ? '' : blocked.reason, /私密字段/);
});

test('runtime graph merges stored inputs, keeps succeeded upstream passive, and executes only requested nodes', () => {
  const graphNodes = [
    node('a', 'text', { text: 'old source' }),
    node('b', 'combine', { separator: ' / ', marker: 'old b' }),
    node('c', 'image', { prompt: 'old c' }),
  ];
  const graphEdges = [edge('a-b', 'a', 'b', 'text', 'text-0'), edge('b-c', 'b', 'c', 'text', 'prompt')];
  const snapshotA = captureRunNodeInputSnapshot(graphNodes, graphEdges, 'a');
  const snapshotB = captureRunNodeInputSnapshot(graphNodes, graphEdges, 'b');
  const snapshotC = captureRunNodeInputSnapshot(graphNodes, graphEdges, 'c');
  assert.equal(snapshotA.replayable && snapshotB.replayable && snapshotC.replayable, true);
  const sourceRun = run([
    nodeRun('source-run', 'a', 'succeeded', snapshotA as unknown as Record<string, unknown>),
    nodeRun('source-run', 'b', 'failed', snapshotB as unknown as Record<string, unknown>),
    nodeRun('source-run', 'c', 'stopped', snapshotC as unknown as Record<string, unknown>),
    nodeRun('source-run', 'inner', 'failed', snapshotC as unknown as Record<string, unknown>, { parentNodeRunId: 'source-run-b' }),
  ]);
  const before = structuredClone(sourceRun);

  const runtime = buildRunOriginalReplayRuntime(sourceRun, ['b', 'c'], 'test nonce');
  assert.equal(runtime.nodes.length, 3);
  assert.equal(runtime.edges.length, 2);
  assert.equal(runtime.executionNodeIds.length, 2);
  assert.deepEqual(runtime.executionNodeIds.map((id) => runtime.originalNodeIdByRuntimeId[id]), ['b', 'c']);
  assert.equal(Object.values(runtime.originalNodeIdByRuntimeId).includes('a'), true);
  assert.equal(runtime.executionNodeIds.some((id) => runtime.originalNodeIdByRuntimeId[id] === 'a'), false);
  assert.equal(new Set(runtime.nodes.map((item) => item.id)).size, runtime.nodes.length);
  assert.equal(runtime.nodes.every((item) => item.style?.opacity === 0 && item.selectable === false), true);
  assert.equal(runtime.edges.every((item) => item.style?.opacity === 0 && item.selectable === false), true);
  for (const runtimeId of runtime.executionNodeIds) {
    const originalId = runtime.originalNodeIdByRuntimeId[runtimeId];
    assert.equal(runtime.executionContexts[runtimeId].originalNodeId, originalId);
    assert.equal(runtime.executionContexts[runtimeId].runNodeId, originalId);
    assert.equal(runtime.executionContexts[runtimeId].subflowPath.length, 0);
  }
  assert.deepEqual(sourceRun, before);
});

test('old or explicitly unreplayable NodeRuns are rejected with an honest reason', () => {
  const oldRun = run([nodeRun('source-run', 'b', 'failed', { trigger: 'canvas-run-bus' })]);
  assert.deepEqual(validateRunOriginalReplay(oldRun, ['b']), { ok: false, reason: '节点 b 没有可重放输入快照' });
  assert.throws(() => buildRunOriginalReplayRuntime(oldRun, ['b'], 'old'), /没有可重放输入快照/);

  const unavailable = run([nodeRun('source-run', 'b', 'failed', {
    schema: RUN_NODE_INPUT_SNAPSHOT_SCHEMA,
    replayable: false,
    nodeId: 'b',
    nodeType: 'image',
    reason: 'inputGraph.apiKey 是私密字段',
  })]);
  assert.deepEqual(validateRunOriginalReplay(unavailable, ['b']), { ok: false, reason: 'inputGraph.apiKey 是私密字段' });
});

test('malformed stored graph cannot inject mismatched or missing node identities', () => {
  const valid = captureRunNodeInputSnapshot(
    [node('a', 'text', { text: 'a' }), node('b', 'combine', { separator: ',' })],
    [edge('a-b', 'a', 'b')],
    'b',
  );
  assert.equal(valid.replayable, true);
  const mismatched = structuredClone(valid) as Record<string, any>;
  mismatched.node.id = 'other';
  assert.deepEqual(
    validateRunOriginalReplay(run([nodeRun('source-run', 'b', 'failed', mismatched)]), ['b']),
    { ok: false, reason: '节点 b 的输入快照身份不一致' },
  );

  const missingEndpoint = structuredClone(valid) as Record<string, any>;
  missingEndpoint.incomingEdges[0].source = 'missing';
  assert.deepEqual(
    validateRunOriginalReplay(run([nodeRun('source-run', 'b', 'failed', missingEndpoint)]), ['b']),
    { ok: false, reason: '节点 b 的输入快照连线引用了缺失节点' },
  );
});

test('failed internal node replay keeps the outer NodeRun hierarchy and exact original input graph', () => {
  const parentSnapshot = captureRunNodeInputSnapshot([
    node('outer', 'subflow', { definitionId: 'nested-flow', definitionVersion: 4, parameterOverrides: { prompt: 'old outer' } }),
  ], [], 'outer');
  const internalNodes = [
    node('outer::source', 'text', { text: 'old internal source' }),
    node('outer::nested::leaf', 'image', { prompt: 'old internal target', model: 'old-model' }),
  ];
  const internalEdges = [edge('outer::edge', 'outer::source', 'outer::nested::leaf', 'text', 'prompt')];
  const internalSnapshot = captureRunNodeInputSnapshot(internalNodes, internalEdges, 'outer::nested::leaf');
  assert.equal(parentSnapshot.replayable && internalSnapshot.replayable, true);
  const parent = nodeRun('source-run', 'outer', 'failed', parentSnapshot as unknown as Record<string, unknown>, {
    originalNodeId: 'outer',
    definitionId: 'nested-flow',
    definitionVersion: 4,
  });
  const child = nodeRun('source-run', 'outer::nested::leaf', 'failed', internalSnapshot as unknown as Record<string, unknown>, {
    parentNodeRunId: parent.id,
    originalNodeId: 'leaf',
    definitionId: 'inner-flow',
    definitionVersion: 2,
    subflowPath: ['outer', 'nested'],
  });
  const sourceRun = run([parent, child]);
  const before = structuredClone(sourceRun);

  assert.deepEqual(validateSubflowNodeRunOriginalReplay(sourceRun, child.id), { ok: true });
  const runtime = buildSubflowNodeRunOriginalReplayRuntime(sourceRun, child.id, 'nested retry');
  assert.equal(runtime.nodes.length, 2);
  assert.equal(runtime.edges.length, 1);
  assert.equal(runtime.executionNodeIds.length, 1);
  const runtimeTargetId = runtime.executionNodeIds[0];
  assert.equal(runtime.originalNodeIdByRuntimeId[runtimeTargetId], 'outer::nested::leaf');
  assert.equal(runtime.executionContexts[runtimeTargetId].runNodeId, 'outer::nested::leaf');
  assert.equal(runtime.executionContexts[runtimeTargetId].originalNodeId, 'leaf');
  assert.deepEqual(runtime.executionContexts[runtimeTargetId].subflowPath, ['outer', 'nested']);
  assert.equal(runtime.executionContexts[runtimeTargetId].definitionId, 'inner-flow');
  assert.equal(runtime.executionContexts[runtimeTargetId].definitionVersion, 2);
  assert.equal(runtime.executionContexts[runtimeTargetId].parentNodeRunId, undefined, 'new parent id is injected only after the child Run exists');
  assert.equal(runtime.parentNodeRun.id, parent.id);
  assert.equal(runtime.sourceNodeRun.id, child.id);
  assert.equal(runtime.nodes.every((item) => item.style?.opacity === 0 && item.selectable === false), true);
  assert.equal(runtime.edges.every((item) => item.style?.opacity === 0 && item.selectable === false), true);
  assert.equal(runtime.executionNodeIds.some((id) => runtime.originalNodeIdByRuntimeId[id] === 'outer::source'), false, 'successful upstream stays passive');
  assert.deepEqual(sourceRun, before);
});

test('internal replay rejects roots, successful nodes, missing parents and malformed snapshots honestly', () => {
  const snapshot = captureRunNodeInputSnapshot([node('outer::leaf', 'image', { prompt: 'safe' })], [], 'outer::leaf');
  assert.equal(snapshot.replayable, true);
  const parent = nodeRun('source-run', 'outer', 'failed', snapshot as unknown as Record<string, unknown>);
  const rootResult = validateSubflowNodeRunOriginalReplay(run([parent]), parent.id);
  assert.deepEqual(rootResult, { ok: false, reason: '该节点不是子工作流内部节点' });

  const succeeded = nodeRun('source-run', 'outer::leaf', 'succeeded', snapshot as unknown as Record<string, unknown>, {
    parentNodeRunId: parent.id,
    subflowPath: ['outer'],
  });
  assert.match((validateSubflowNodeRunOriginalReplay(run([parent, succeeded]), succeeded.id) as { reason: string }).reason, /只能重试/);

  const missingParent = { ...succeeded, id: 'missing-parent-child', status: 'failed', parentNodeRunId: 'absent' };
  assert.match((validateSubflowNodeRunOriginalReplay(run([missingParent]), missingParent.id) as { reason: string }).reason, /外层实例记录已缺失/);

  const malformed = structuredClone(snapshot) as Record<string, any>;
  malformed.node.id = 'other-node';
  const malformedChild = nodeRun('source-run', 'outer::leaf', 'failed', malformed, {
    parentNodeRunId: parent.id,
    subflowPath: ['outer'],
  });
  assert.match((validateSubflowNodeRunOriginalReplay(run([parent, malformedChild]), malformedChild.id) as { reason: string }).reason, /身份不一致/);
  assert.throws(() => buildSubflowNodeRunOriginalReplayRuntime(run([parent, malformedChild]), malformedChild.id, 'bad'), /身份不一致/);
});

test('stopped internal node retries from its stored input instead of current canvas data', () => {
  const parentSnapshot = captureRunNodeInputSnapshot([node('outer', 'subflow', { definitionId: 'flow', definitionVersion: 6 })], [], 'outer');
  const storedSnapshot = captureRunNodeInputSnapshot([
    node('outer::leaf', 'aggregate-parser', { aggregateParserInput: 'https://example.com/stored-before-stop', aggregateParserAcceptedCompliance: false }),
  ], [], 'outer::leaf');
  assert.equal(parentSnapshot.replayable && storedSnapshot.replayable, true);
  const parent = nodeRun('source-run', 'outer', 'stopped', parentSnapshot as unknown as Record<string, unknown>, {
    originalNodeId: 'outer', definitionId: 'flow', definitionVersion: 6,
  });
  const child = nodeRun('source-run', 'outer::leaf', 'stopped', storedSnapshot as unknown as Record<string, unknown>, {
    parentNodeRunId: parent.id,
    originalNodeId: 'leaf',
    definitionId: 'flow',
    definitionVersion: 6,
    subflowPath: ['outer'],
  });
  const sourceRun = run([parent, child]);
  assert.deepEqual(validateSubflowNodeRunOriginalReplay(sourceRun, child.id), { ok: true });

  const runtime = buildSubflowNodeRunOriginalReplayRuntime(sourceRun, child.id, 'stopped-original');
  const target = runtime.nodes.find((item) => runtime.executionNodeIds.includes(item.id));
  assert.equal((target?.data as any).aggregateParserInput, 'https://example.com/stored-before-stop');
  assert.equal((target?.data as any).aggregateParserAcceptedCompliance, false);
  assert.deepEqual(runtime.executionContexts[runtime.executionNodeIds[0]].subflowPath, ['outer']);
  assert.equal(runtime.executionContexts[runtime.executionNodeIds[0]].definitionVersion, 6);
});

test('one failed Attempt can be retried from the exact stored input even after a later Attempt succeeded', () => {
  const snapshot = captureRunNodeInputSnapshot([
    node('a', 'upload', { image: 'https://example.com/source.png' }),
    node('b', 'image', { prompt: 'attempt-original', provider: 'provider-a' }),
  ], [edge('a-b', 'a', 'b', 'image', 'image')], 'b');
  assert.equal(snapshot.replayable, true);
  const sourceNodeRun = nodeRun('source-run', 'b', 'succeeded', snapshot as unknown as Record<string, unknown>, {
    attempts: [
      { id: 'attempt-failed', nodeRunId: 'source-run-b', attemptNumber: 1, provider: 'provider-a', model: 'model-a', pollCount: 1, status: 'failed', timestamps: { startedAt: 101, finishedAt: 110 }, usage: { costUsd: 0.2 }, metadata: {}, createdAt: 101, updatedAt: 110 },
      { id: 'attempt-success', nodeRunId: 'source-run-b', attemptNumber: 2, provider: 'provider-b', model: 'model-b', pollCount: 0, status: 'succeeded', timestamps: { startedAt: 111, finishedAt: 120 }, usage: { costUsd: 0.3 }, metadata: {}, createdAt: 111, updatedAt: 120 },
    ],
  });
  const sourceRun = run([sourceNodeRun]);
  assert.deepEqual(validateRunAttemptOriginalReplay(sourceRun, sourceNodeRun.id, 'attempt-failed'), { ok: true });
  assert.match((validateRunAttemptOriginalReplay(sourceRun, sourceNodeRun.id, 'attempt-success') as { reason: string }).reason, /只能重试/);
  const runtime = buildRunAttemptOriginalReplayRuntime(sourceRun, sourceNodeRun.id, 'attempt-failed', 'attempt-retry');
  assert.equal(runtime.sourceAttempt.id, 'attempt-failed');
  assert.equal(runtime.executionNodeIds.length, 1);
  const target = runtime.nodes.find((item) => runtime.executionNodeIds.includes(item.id));
  assert.equal((target?.data as any).prompt, 'attempt-original');
  assert.equal(runtime.nodes.some((item) => (item.data as any).image === 'https://example.com/source.png'), true);
});

test('Canvas mounts replay clones only in rendered graph, never in persisted nodes or edges state', () => {
  const source = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');
  assert.match(source, /return runReplayRuntime \? \[\.\.\.themedNodes, \.\.\.runReplayRuntime\.nodes\] : themedNodes/);
  assert.match(source, /runReplayRuntime \? \[\.\.\.edges, \.\.\.runReplayRuntime\.edges\] : edges/);
  assert.match(source, /nodes=\{renderedNodes\}[\s\S]*?edges=\{renderedEdges\}/);
  assert.doesNotMatch(source, /setNodes\([^\n]*runReplayRuntime/);
  assert.doesNotMatch(source, /setEdges\([^\n]*runReplayRuntime/);
});

test('actual trigger capture, original identity, and replay actions stay wired together', () => {
  const triggerSource = readFileSync(new URL('../src/hooks/useRunTrigger.ts', import.meta.url), 'utf8');
  assert.match(triggerSource, /captureRunNodeInputSnapshot\(getNodes\(\), getEdges\(\), nodeId\)/);
  assert.match(triggerSource, /nodeId:\s*executionContext\?\.runNodeId \|\| nodeId/);
  assert.match(triggerSource, /inputSnapshot:\s*inputSnapshot as unknown as Record<string, unknown>/);

  const canvasSource = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');
  assert.match(canvasSource, /type ProjectRunReplayMode = 'full-current' \| 'failed-original' \| 'full-original'/);
  assert.match(canvasSource, /parentRunId:\s*run\.id,\s*replayMode:\s*mode,\s*replaySourceRunId:\s*run\.id/);
  assert.match(canvasSource, /executionOrder:\s*runtime\.executionNodeIds/);
  assert.match(canvasSource, /executionContexts:\s*runtime\.executionContexts/);
  assert.match(canvasSource, /buildSubflowNodeRunOriginalReplayRuntime/);
  assert.match(canvasSource, /sourceAttempt \? 'attempt-original' : 'subflow-node-original'/);
  assert.match(canvasSource, /replaySourceAttemptId: sourceAttempt\?\.id/);
  assert.match(canvasSource, /buildRunAttemptOriginalReplayRuntime/);
  assert.match(canvasSource, /prepareRunExecution: async \(runId\) =>/);
  assert.match(canvasSource, /parentNodeRunId: parent\.id/);
  assert.match(canvasSource, /if \(runId\) \{[\s\S]*await api\.updateProjectRun\(runId,/);
  assert.match(canvasSource, /SUBFLOW_RETRY_FAILED/);

  const workbenchSource = readFileSync(new URL('../src/components/ProjectWorkbench.tsx', import.meta.url), 'utf8');
  assert.match(workbenchSource, />失败节点按原输入继续<\/button>/);
  assert.match(workbenchSource, />用原输入另开 Run<\/button>/);
  assert.match(workbenchSource, />按当前画布重跑<\/button>/);
  assert.match(workbenchSource, />按原输入重试内部节点<\/button>/);
  assert.match(workbenchSource, />按此 Attempt 原输入重试<\/button>/);
  assert.match(workbenchSource, /validateRunAttemptOriginalReplay/);
  assert.match(workbenchSource, /validateSubflowNodeRunOriginalReplay/);
  assert.match(workbenchSource, /旧记录或被安全脱敏\/截断的输入不会伪装成原输入/);
});
