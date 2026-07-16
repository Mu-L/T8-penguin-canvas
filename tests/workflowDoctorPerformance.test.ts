import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { Edge, Node } from '@xyflow/react';
import { analyzeWorkflow } from '../src/utils/workflowDoctor.ts';

const LARGE_CANVAS_NODE_COUNT = 20_000;
const LARGE_CANVAS_BUDGET_MS = 5_000;

test('E5 Doctor validates a 20,000-node chain within the large-canvas budget', (t) => {
  const nodes: Node[] = Array.from({ length: LARGE_CANVAS_NODE_COUNT }, (_, index) => ({
    id: `e5-perf-node-${index}`,
    type: 'text',
    position: { x: index, y: index % 17 },
    data: { text: `step ${index}` },
  }));
  const edges: Edge[] = Array.from({ length: LARGE_CANVAS_NODE_COUNT - 1 }, (_, index) => ({
    id: `e5-perf-edge-${index}`,
    source: nodes[index].id,
    target: nodes[index + 1].id,
  }));

  const startedAt = performance.now();
  const issues = analyzeWorkflow(nodes, edges);
  const elapsedMs = performance.now() - startedAt;

  t.diagnostic(JSON.stringify({
    schema: 't8-workflow-doctor-e5-performance-v1',
    nodes: nodes.length,
    edges: edges.length,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    budgetMs: LARGE_CANVAS_BUDGET_MS,
  }));
  assert.equal(issues.some((issue) => issue.ruleId === 'topology.cycle'), false);
  assert.equal(issues.some((issue) => issue.ruleId.startsWith('ports.')), false);
  assert.ok(
    elapsedMs < LARGE_CANVAS_BUDGET_MS,
    `20,000 节点诊断耗时 ${elapsedMs.toFixed(2)}ms，超过 ${LARGE_CANVAS_BUDGET_MS}ms 闸门`,
  );
});
