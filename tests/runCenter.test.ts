import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRunTimeline, buildRunTimelineAnalysis, collectFailedDownstreamNodeIds, compareRuns, formatBoundedJson } from '../src/utils/runCenter.ts';
import type { RunDetail, RunEventRecord } from '../src/types/project.ts';

test('run workbench exposes provider transport trace, usage and AssetRefs', () => {
  const source = readFileSync(new URL('../src/components/ProjectWorkbench.tsx', import.meta.url), 'utf8');
  assert.match(source, /HTTP \{attempt\.httpStatus \?\? '—'\}/);
  assert.match(source, /轮询 \{attempt\.pollCount \|\| 0\}/);
  assert.match(source, /展开用量详情/);
  assert.match(source, /展开 AssetRef（\$\{nodeRun\.outputRefs\.length\}）/);
  assert.match(source, /buildRunTimelineAnalysis\(runDetail, runEvents\)/);
  assert.match(source, /DAG 依赖/);
  assert.match(source, /峰值并发/);
  assert.match(source, /应用筛选/);
  assert.match(source, /open \? formatBoundedJson\(value, maxCharacters\) : null/);
  assert.doesNotMatch(source, /JSON\.stringify\(attempt\.(?:usage|error)/);
});

function makeRun(id: string, nodes: Array<{ id: string; status: string; start: number; end: number; outputs?: string[] }>, edges: Array<{ source: string; target: string }> = []): RunDetail {
  return {
    id, projectId: 'p', canvasId: 'c', canvasRevision: 1, initiatorId: 'owner', status: 'succeeded',
    createdAt: 100, startedAt: 100, finishedAt: Math.max(...nodes.map((item) => item.end)), summary: { plannedEdges: edges },
    nodeRuns: nodes.map((item) => ({ id: `${id}-${item.id}`, runId: id, nodeId: item.id, subflowPath: [], status: item.status, inputSnapshot: {}, outputRefs: item.outputs || [], createdAt: item.start, updatedAt: item.end })),
  };
}

test('timeline marks the longest dependency chain as critical', () => {
  const run = makeRun('a', [
    { id: 'source', status: 'succeeded', start: 100, end: 110 },
    { id: 'slow', status: 'succeeded', start: 110, end: 150 },
    { id: 'fast', status: 'succeeded', start: 110, end: 120 },
    { id: 'merge', status: 'succeeded', start: 150, end: 160 },
  ], [{ source: 'source', target: 'slow' }, { source: 'source', target: 'fast' }, { source: 'slow', target: 'merge' }, { source: 'fast', target: 'merge' }]);
  const timeline = buildRunTimeline(run);
  assert.deepEqual(timeline.filter((item) => item.critical).map((item) => item.nodeRun.nodeId).sort(), ['merge', 'slow', 'source']);
  assert.equal(timeline.every((item) => item.widthPercent >= 1.5), true);
});

test('timeline phases use persisted lifecycle events and do not invent wait reasons', () => {
  const run = makeRun('phases', [{ id: 'image', status: 'succeeded', start: 100, end: 200 }]);
  run.nodeRuns[0].attempts = [{
    id: 'attempt-1', nodeRunId: run.nodeRuns[0].id, attemptNumber: 1, provider: 'seedance-nz', model: 'seedream-v5-pro-t2i',
    pollCount: 3, status: 'succeeded', timestamps: { queuedAt: 100, startedAt: 120, lastPolledAt: 180, finishedAt: 200 },
    usage: {}, metadata: {}, createdAt: 100, updatedAt: 200,
  }];
  const events: RunEventRecord[] = [
    { id: 1, runId: run.id, nodeRunId: run.nodeRuns[0].id, type: 'node.queued', payload: {}, createdAt: 100 },
    { id: 2, runId: run.id, nodeRunId: run.nodeRuns[0].id, type: 'node.started', payload: {}, createdAt: 120 },
    { id: 3, runId: run.id, nodeRunId: run.nodeRuns[0].id, type: 'node.polling', payload: {}, createdAt: 150 },
    { id: 4, runId: run.id, nodeRunId: run.nodeRuns[0].id, type: 'node.succeeded', payload: {}, createdAt: 200 },
  ];
  const analysis = buildRunTimelineAnalysis(run, events);
  assert.equal(analysis.totalWaitMs, 20);
  assert.equal(analysis.totalRunMs, 30);
  assert.equal(analysis.totalPollMs, 50);
  assert.equal(analysis.pollingNodeCount, 1);
  assert.equal(analysis.items[0].pollCount, 3);
  assert.deepEqual(analysis.items[0].segments.map((segment) => segment.kind), ['waiting', 'running', 'polling']);
  assert.equal('waitReason' in analysis.items[0], false);
});

test('timeline assigns stable lanes and counts only overlapping active intervals', () => {
  const run = makeRun('parallel', [
    { id: 'a', status: 'succeeded', start: 100, end: 200 },
    { id: 'b', status: 'succeeded', start: 120, end: 160 },
    { id: 'c', status: 'succeeded', start: 160, end: 180 },
  ]);
  const analysis = buildRunTimelineAnalysis(run);
  const byId = new Map(analysis.items.map((item) => [item.nodeRun.nodeId, item]));
  assert.equal(analysis.maxConcurrency, 2);
  assert.equal(byId.get('a')?.lane, 0);
  assert.equal(byId.get('b')?.lane, 1);
  assert.equal(byId.get('c')?.lane, 1);
});

test('timeline reports attempts, retries, dependency levels and critical duration', () => {
  const run = makeRun('dag', [
    { id: 'source', status: 'succeeded', start: 100, end: 120 },
    { id: 'left', status: 'succeeded', start: 120, end: 160 },
    { id: 'right', status: 'succeeded', start: 120, end: 140 },
    { id: 'merge', status: 'succeeded', start: 160, end: 180 },
  ], [
    { source: 'source', target: 'left' }, { source: 'source', target: 'right' },
    { source: 'left', target: 'merge' }, { source: 'right', target: 'merge' },
  ]);
  run.nodeRuns[1].attempts = [1, 2].map((attemptNumber) => ({
    id: `attempt-${attemptNumber}`, nodeRunId: run.nodeRuns[1].id, attemptNumber, pollCount: 0,
    status: attemptNumber === 1 ? 'failed' : 'succeeded', timestamps: {}, usage: {}, metadata: {}, createdAt: 120, updatedAt: 160,
  }));
  const analysis = buildRunTimelineAnalysis(run);
  const left = analysis.items.find((item) => item.nodeRun.nodeId === 'left')!;
  const merge = analysis.items.find((item) => item.nodeRun.nodeId === 'merge')!;
  assert.equal(left.attemptCount, 2);
  assert.equal(left.retryCount, 1);
  assert.equal(analysis.retryNodeCount, 1);
  assert.equal(merge.dependencyDepth, 2);
  assert.deepEqual(merge.dependencies, ['left', 'right']);
  assert.deepEqual(analysis.dagLevels, [
    { depth: 0, nodeIds: ['source'] },
    { depth: 1, nodeIds: ['left', 'right'] },
    { depth: 2, nodeIds: ['merge'] },
  ]);
  assert.equal(analysis.criticalPathMs, 80);
});

test('timeline degrades safely for cyclic plans and missing lifecycle events', () => {
  const run = makeRun('cycle', [
    { id: 'a', status: 'queued', start: 100, end: 110 },
    { id: 'b', status: 'succeeded', start: 110, end: 130 },
  ], [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }]);
  const analysis = buildRunTimelineAnalysis(run);
  assert.equal(analysis.items.length, 2);
  assert.equal(analysis.items.every((item) => Number.isFinite(item.offsetPercent) && Number.isFinite(item.widthPercent)), true);
  assert.equal(analysis.items.find((item) => item.nodeRun.nodeId === 'a')?.waitMs, 10);
});

test('an earlier failed attempt does not terminate a node whose retry is still running', () => {
  const run = makeRun('retry-running', [{ id: 'node', status: 'running', start: 100, end: 200 }]);
  run.status = 'running';
  run.finishedAt = undefined;
  run.nodeRuns[0].attempts = [
    { id: 'failed', nodeRunId: run.nodeRuns[0].id, attemptNumber: 1, pollCount: 0, status: 'failed', timestamps: { queuedAt: 100, startedAt: 110, finishedAt: 150 }, usage: {}, metadata: {}, createdAt: 100, updatedAt: 150 },
    { id: 'retry', nodeRunId: run.nodeRuns[0].id, attemptNumber: 2, pollCount: 0, status: 'running', timestamps: { queuedAt: 155, startedAt: 160 }, usage: {}, metadata: {}, createdAt: 155, updatedAt: 200 },
  ];
  const item = buildRunTimelineAnalysis(run).items[0];
  assert.equal(item.finishedAt, 200);
  assert.equal(item.retryCount, 1);
});

test('large timeline input remains bounded and deterministic', () => {
  const nodes = Array.from({ length: 500 }, (_, index) => ({ id: `n-${index}`, status: 'succeeded', start: 100 + index, end: 2000 + index }));
  const edges = nodes.slice(1).map((node, index) => ({ source: nodes[index].id, target: node.id }));
  const analysis = buildRunTimelineAnalysis(makeRun('large', nodes, edges));
  assert.equal(analysis.items.length, 500);
  assert.equal(analysis.dagLevels.length, 500);
  assert.equal(analysis.maxConcurrency, 500);
});

test('large JSON fields are bounded and serialization failures stay inspectable', () => {
  const bounded = formatBoundedJson({ payload: 'x'.repeat(10_000) }, 512);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.text.length <= 514, true);
  assert.equal(bounded.originalLength > bounded.text.length, true);
  const circular: { self?: unknown; count: bigint } = { count: 3n };
  circular.self = circular;
  const safe = formatBoundedJson(circular);
  assert.match(safe.text, /\[Circular\]/);
  assert.match(safe.text, /3n/);
});

test('failed downstream collection follows only outgoing dependencies', () => {
  const run = makeRun('a', [{ id: 'a', status: 'succeeded', start: 100, end: 110 }, { id: 'b', status: 'failed', start: 110, end: 120 }, { id: 'c', status: 'stopped', start: 120, end: 130 }, { id: 'side', status: 'succeeded', start: 100, end: 105 }]);
  assert.deepEqual(collectFailedDownstreamNodeIds(run, [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'a', target: 'side' }]).sort(), ['b', 'c']);
});

test('run comparison reports duration, outputs and node changes', () => {
  const left = makeRun('left', [{ id: 'a', status: 'failed', start: 100, end: 140 }]);
  const right = makeRun('right', [{ id: 'a', status: 'succeeded', start: 100, end: 120, outputs: ['asset-a'] }]);
  const comparison = compareRuns(left, right);
  assert.equal(comparison.durationDeltaMs, -20);
  assert.equal(comparison.outputDelta, 1);
  assert.equal(comparison.changedNodes[0].nodeId, 'a');
});

test('run comparison reports exact input and cross-provider usage without merging units', () => {
  const left = makeRun('left-provider', [{ id: 'image', status: 'failed', start: 100, end: 140 }]);
  const right = makeRun('right-provider', [{ id: 'image', status: 'succeeded', start: 100, end: 130 }]);
  left.nodeRuns[0].inputSnapshot = { schema: 't8-run-node-input-v1', node: { data: { prompt: 'left prompt' } } };
  right.nodeRuns[0].inputSnapshot = { schema: 't8-run-node-input-v1', node: { data: { prompt: 'right prompt' } } };
  left.nodeRuns[0].attempts = [{ id: 'left-attempt', nodeRunId: left.nodeRuns[0].id, attemptNumber: 1, provider: 'seedance-nz', model: 'wan-a', pollCount: 1, status: 'failed', timestamps: {}, usage: { inputTokens: 10, costUsd: 0.2, credits: 1 }, metadata: {}, createdAt: 100, updatedAt: 140 }];
  right.nodeRuns[0].attempts = [{ id: 'right-attempt', nodeRunId: right.nodeRuns[0].id, attemptNumber: 1, provider: 'runninghub', model: 'wan-b', pollCount: 2, status: 'succeeded', timestamps: {}, usage: { inputTokens: 12, costUsd: 0.3, credits: 2 }, metadata: {}, createdAt: 100, updatedAt: 130 }];
  const comparison = compareRuns(left, right);
  assert.equal(comparison.inputChangedNodes, 1);
  assert.equal(comparison.providerChangedNodes, 1);
  assert.equal(comparison.changedNodes[0].inputChanged, true);
  assert.deepEqual(comparison.changedNodes[0].leftProviders, ['seedance-nz / wan-a']);
  assert.deepEqual(comparison.changedNodes[0].rightProviders, ['runninghub / wan-b']);
  assert.equal(comparison.usageMetrics.some((item) => item.provider === 'seedance-nz' && item.metric === 'inputTokens' && item.leftValue === 10 && item.rightValue === 0), true);
  assert.equal(comparison.usageMetrics.some((item) => item.provider === 'runninghub' && item.metric === 'inputTokens' && item.leftValue === 0 && item.rightValue === 12), true);
  assert.equal(comparison.costMetrics.length, 4);
  assert.equal(comparison.costMetrics.every((item) => item.key.includes('\u001f')), true);
});

test('replayed runtime ids are compared and traversed by original node identity', () => {
  const replayed = makeRun('replayed', [
    { id: 'runtime-b', status: 'failed', start: 100, end: 120 },
    { id: 'runtime-c', status: 'stopped', start: 120, end: 130 },
  ], [{ source: 'b', target: 'c' }]);
  replayed.nodeRuns[0].originalNodeId = 'b';
  replayed.nodeRuns[1].originalNodeId = 'c';
  assert.deepEqual(collectFailedDownstreamNodeIds(replayed, [{ source: 'b', target: 'c' }]).sort(), ['b', 'c']);
  assert.deepEqual(buildRunTimeline(replayed).map((item) => item.critical), [true, true]);

  const original = makeRun('original', [
    { id: 'b', status: 'succeeded', start: 100, end: 110 },
    { id: 'c', status: 'succeeded', start: 110, end: 120 },
  ]);
  assert.deepEqual(compareRuns(replayed, original).changedNodes.map((item) => item.nodeId).sort(), ['b', 'c']);
});
