import test from 'node:test';
import assert from 'node:assert/strict';
import type { Edge, Node } from '@xyflow/react';
import type { ApiSettings } from '../src/types/canvas.ts';
import {
  buildRunPreflightDiagnosticScope,
  buildRunPreflightDiagnostics,
  collectRunPreflightAssetIds,
  scopeRunPreflightIssues,
} from '../src/utils/runPreflightContext.ts';
import { buildPossibleDerivedExecutionScope } from '../src/utils/derivedExecutionScope.ts';
import { analyzeWorkflow } from '../src/utils/workflowDoctor.ts';

const settings: ApiSettings = {
  zhenzhenApiKey: '',
  zhenzhenBaseUrl: 'https://ai.t8star.org',
  zhenzhenSd2ApiKey: '',
  zhenzhenSd2BaseUrl: 'https://api.seedance.nz',
  rhApiKey: '',
  rhBaseUrl: 'https://www.runninghub.cn',
  rhIntlApiKey: '',
  rhIntlBaseUrl: 'https://www.runninghub.ai',
  llmApiKey: '',
  llmBaseUrl: 'https://ai.t8star.org',
  advancedProviders: [],
};

function textNode(id: string, data: Record<string, unknown> = {}): Node {
  return { id, type: 'text', position: { x: 0, y: 0 }, data: { text: id, ...data } };
}

function subflowNode(
  id: string,
  inputs: Array<{ id: string; kind: string; required?: boolean }> = [],
  outputs: Array<{ id: string; kind: string; required?: boolean }> = [],
): Node {
  return {
    id,
    type: 'subflow',
    position: { x: 0, y: 0 },
    data: {
      definitionId: `${id}-definition`,
      definitionVersion: 1,
      definition: {
        id: `${id}-definition`,
        version: 1,
        inputs,
        outputs,
      },
    },
  };
}

test('selection scope adds exactly the direct inbound sources read by the selected node', () => {
  const nodes = [
    textNode('ancestor'),
    textNode('upstream'),
    textNode('selected'),
    textNode('downstream'),
    textNode('unrelated'),
  ];
  const edges: Edge[] = [
    { id: 'ancestor-upstream', source: 'ancestor', target: 'upstream' },
    { id: 'upstream-selected', source: 'upstream', target: 'selected' },
    { id: 'missing-selected', source: 'missing', target: 'selected' },
    { id: 'selected-downstream', source: 'selected', target: 'downstream' },
    { id: 'unrelated-downstream', source: 'unrelated', target: 'downstream' },
  ];
  const before = JSON.stringify({ nodes, edges });

  const scope = buildRunPreflightDiagnosticScope({
    nodes,
    edges,
    executionNodeIds: ['selected', 'selected'],
    mode: 'selection-input-context',
  });

  assert.deepEqual(scope.executionNodeIds, ['selected']);
  assert.deepEqual(scope.inputContextNodeIds, ['upstream']);
  assert.deepEqual(scope.nodes.map((node) => node.id), ['upstream', 'selected']);
  assert.deepEqual(scope.edges.map((edge) => edge.id), ['upstream-selected', 'missing-selected']);
  assert.equal(scope.nodes.some((node) => node.id === 'ancestor'), false, 'an unexecuted upstream is not recursively run');
  assert.equal(scope.nodes.some((node) => node.id === 'unrelated'), false);
  assert.equal(scope.edges.some((edge) => edge.id === 'selected-downstream'), false);
  assert.equal(JSON.stringify({ nodes, edges }), before, 'scope construction is pure');
});

test('exact-plan scope preserves the caller supplied run-all/replay graph without expansion', () => {
  const nodes = [textNode('planned-source'), textNode('planned-target')];
  const edges: Edge[] = [{ id: 'planned', source: 'planned-source', target: 'planned-target' }];
  const scope = buildRunPreflightDiagnosticScope({
    nodes,
    edges,
    executionNodeIds: ['planned-target'],
    mode: 'exact-plan',
  });

  assert.notEqual(scope.nodes, nodes);
  assert.notEqual(scope.edges, edges);
  assert.deepEqual(scope.nodes, nodes);
  assert.deepEqual(scope.edges, edges);
  assert.deepEqual(scope.inputContextNodeIds, ['planned-source']);
});

test('groupBox aggregate output is valid direct input context for a selected generation node', () => {
  const group = {
    id: 'group',
    type: 'groupBox',
    position: { x: 0, y: 0 },
    data: { memberIds: ['member'], prompt: 'group prompt' },
  } as Node;
  const selected = {
    id: 'selected-image',
    type: 'image',
    position: { x: 400, y: 0 },
    data: { prompt: 'generate from group' },
  } as Node;
  const edge: Edge = {
    id: 'group-to-image',
    source: group.id,
    target: selected.id,
    sourceHandle: 'group-out',
    targetHandle: null,
  };
  const scope = buildRunPreflightDiagnosticScope({
    nodes: [group, selected],
    edges: [edge],
    executionNodeIds: [selected.id],
    mode: 'selection-input-context',
  });

  assert.deepEqual(scope.inputContextNodeIds, [group.id]);
  const structureIssues = scopeRunPreflightIssues(analyzeWorkflow(scope.nodes, scope.edges), scope)
    .filter((issue) => issue.severity === 'error' || issue.severity === 'warning');
  assert.equal(structureIssues.some((issue) => issue.ruleId === 'registry.unknown-node-type'), false);
  assert.equal(structureIssues.some((issue) => issue.ruleId === 'ports.handle-unknown'), false);
  assert.equal(structureIssues.some((issue) => issue.ruleId === 'ports.type-incompatible'), false);

  const derived = buildPossibleDerivedExecutionScope({
    nodes: [group, selected],
    edges: [edge],
    executionNodeIds: [selected.id],
  });
  assert.equal(derived.coverageComplete, true);
  assert.deepEqual(derived.requiredAuthorizationNodeIds, [selected.id]);
  assert.deepEqual(derived.diagnosticContextNodeIds, [group.id]);

  const exactScope = buildRunPreflightDiagnosticScope({
    nodes: derived.nodes,
    edges: derived.edges,
    executionNodeIds: derived.requiredAuthorizationNodeIds,
    mode: 'exact-plan',
  });
  const exactStructureIssues = scopeRunPreflightIssues(
    analyzeWorkflow(exactScope.nodes, exactScope.edges),
    exactScope,
  );
  assert.equal(exactStructureIssues.some((issue) => issue.ruleId === 'registry.unknown-node-type'), false);
  assert.equal(exactStructureIssues.some((issue) => issue.ruleId === 'ports.handle-unknown'), false);
  assert.equal(exactStructureIssues.some((issue) => issue.ruleId === 'ports.type-incompatible'), false);
});

test('a truly unknown direct source still blocks the derived exact execution plan', () => {
  const unknownSource = {
    id: 'missing-plugin-source',
    type: 'missing-plugin-node',
    position: { x: 0, y: 0 },
    data: {},
  } as Node;
  const selected = {
    id: 'selected-image',
    type: 'image',
    position: { x: 400, y: 0 },
    data: { prompt: 'generate from plugin output' },
  } as Node;
  const edge: Edge = {
    id: 'unknown-to-image',
    source: unknownSource.id,
    target: selected.id,
  };
  const derived = buildPossibleDerivedExecutionScope({
    nodes: [unknownSource, selected],
    edges: [edge],
    executionNodeIds: [selected.id],
  });
  assert.equal(derived.coverageComplete, true);

  const exactScope = buildRunPreflightDiagnosticScope({
    nodes: derived.nodes,
    edges: derived.edges,
    executionNodeIds: derived.requiredAuthorizationNodeIds,
    mode: 'exact-plan',
  });
  const issues = scopeRunPreflightIssues(
    analyzeWorkflow(exactScope.nodes, exactScope.edges),
    exactScope,
  );
  assert.ok(issues.some((issue) => (
    issue.ruleId === 'registry.unknown-node-type'
    && issue.targetNodeIds?.includes(unknownSource.id)
  )));
});

test('group preflight validates selected inputs but ignores provider and required-input failures of unexecuted sources', () => {
  const providerSource: Node = {
    id: 'provider-source',
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      prompt: 'already generated',
      imageUrl: 'https://example.invalid/already-generated.png',
      sourceAssetId: 'asset-upstream',
      providerSource: 'modelscope',
      providerId: 'missing-provider',
      providerModel: 'image-model',
    },
  };
  const incompleteSource = subflowNode(
    'incomplete-source',
    [{ id: 'must-text', kind: 'text', required: true }],
    [{ id: 'image-out', kind: 'image' }],
  );
  const selected = subflowNode(
    'selected',
    [{ id: 'image-in', kind: 'image', required: true }],
    [],
  );
  const unrelated: Node = {
    id: 'unrelated-provider', type: 'llm', position: { x: 0, y: 0 },
    data: { providerSource: 'modelscope', providerId: 'also-missing', providerModel: 'llm-model' },
  };
  const nodes = [providerSource, incompleteSource, selected, unrelated];
  const edges: Edge[] = [
    { id: 'provider-selected', source: 'provider-source', target: 'selected', targetHandle: 'image-in' },
    { id: 'incomplete-selected', source: 'incomplete-source', target: 'selected', sourceHandle: 'image-out', targetHandle: 'image-in' },
  ];
  const scope = buildRunPreflightDiagnosticScope({
    nodes,
    edges,
    executionNodeIds: ['selected'],
    mode: 'selection-input-context',
  });
  const rawIssues = analyzeWorkflow(scope.nodes, scope.edges, { providersComplete: true, providers: [] });
  assert.ok(rawIssues.some((issue) => issue.ruleId === 'provider.selection-unavailable' && issue.targetNodeIds?.includes('provider-source')));
  assert.ok(rawIssues.some((issue) => issue.ruleId === 'ports.required-input-missing' && issue.targetNodeIds?.includes('incomplete-source')));

  const scopedIssues = scopeRunPreflightIssues(rawIssues, scope);
  assert.equal(scopedIssues.some((issue) => issue.ruleId === 'provider.selection-unavailable'), false);
  assert.equal(scopedIssues.some((issue) => issue.ruleId === 'ports.required-input-missing'), false);
  assert.equal(scopedIssues.some((issue) => issue.targetNodeIds?.includes('unrelated-provider')), false);
  assert.deepEqual(collectRunPreflightAssetIds(scope.nodes), ['asset-upstream']);

  const diagnostics = buildRunPreflightDiagnostics({
    nodes,
    edges,
    executionNodeIds: ['selected'],
    scopeMode: 'selection-input-context',
    projectId: 'project-a',
    settings,
    providersComplete: true,
    assets: [{ id: 'asset-upstream', projectId: 'project-a', availability: 'available' }],
    policy: null,
  });
  assert.equal(diagnostics.capability.some((item) => item.nodeIds?.includes('provider-source')), false);
  assert.equal(diagnostics.structure.some((item) => item.ruleId === 'ports.required-input-missing'), false);
  assert.equal(diagnostics.structure.some((item) => item.nodeIds?.includes('unrelated-provider')), false);
});

test('missing built-in image credentials explain the exact API setting in plain language', () => {
  const image: Node = {
    id: 'image-missing-key',
    type: 'image',
    position: { x: 0, y: 0 },
    data: { model: 'gpt-image-2', apiModel: 'gpt-image-2-all', prompt: 'portrait' },
  };
  const diagnostics = buildRunPreflightDiagnostics({
    nodes: [image],
    edges: [],
    executionNodeIds: [image.id],
    scopeMode: 'exact-plan',
    projectId: 'project-a',
    settings,
    providersComplete: true,
    assets: [],
    policy: null,
  });
  const missing = diagnostics.capability.find((item) => item.ruleId === 'provider.zhenzhen-credential-missing');
  assert.ok(missing);
  assert.match(String(missing.title), /未检测到当前图像模型所需的 API Key/);
  assert.match(String(missing.title), /右上角齿轮/);
  assert.match(String(missing.title), /“API 设置”/);
  assert.match(String(missing.title), /“gpt-image 系列”分类 API Key/);
  assert.match(String(missing.title), /“贞贞的AI工坊（海外） API Key”作为通用后备/);

  const configured = buildRunPreflightDiagnostics({
    nodes: [image], edges: [], executionNodeIds: [image.id], scopeMode: 'exact-plan',
    projectId: 'project-a', settings: { ...settings, gptImageApiKey: 'configured' },
    providersComplete: true, assets: [], policy: null,
  });
  assert.equal(configured.capability.some((item) => item.ruleId === 'provider.zhenzhen-credential-missing'), false);
});

test('a missing or invalid inbound connection on the selected node still blocks in selection scope', () => {
  const source = subflowNode('source', [], [{ id: 'image-out', kind: 'image' }]);
  const selected = subflowNode('selected', [{ id: 'image-in', kind: 'image', required: true }], []);
  const nodes = [source, selected];
  const invalidEdges: Edge[] = [{
    id: 'invalid-inbound',
    source: 'source',
    target: 'selected',
    sourceHandle: 'removed-output',
    targetHandle: 'image-in',
  }];
  const invalidScope = buildRunPreflightDiagnosticScope({
    nodes,
    edges: invalidEdges,
    executionNodeIds: ['selected'],
    mode: 'selection-input-context',
  });
  const invalidIssues = scopeRunPreflightIssues(
    analyzeWorkflow(invalidScope.nodes, invalidScope.edges),
    invalidScope,
  );
  assert.ok(invalidIssues.some((issue) => issue.ruleId === 'ports.handle-unknown'));
  assert.ok(invalidIssues.some((issue) => issue.ruleId === 'ports.required-input-missing' && issue.targetNodeIds?.includes('selected')));

  const missingScope = buildRunPreflightDiagnosticScope({
    nodes,
    edges: [],
    executionNodeIds: ['selected'],
    mode: 'selection-input-context',
  });
  const missingIssues = scopeRunPreflightIssues(
    analyzeWorkflow(missingScope.nodes, missingScope.edges),
    missingScope,
  );
  assert.ok(missingIssues.some((issue) => issue.ruleId === 'ports.required-input-missing' && issue.targetNodeIds?.includes('selected')));
});

test('invalid assets on consumed input context remain in scope while unrelated assets do not', () => {
  const upstream = textNode('upstream', { sourceAssetId: 'consumed-asset' });
  const selected = textNode('selected');
  const unrelated = textNode('unrelated', { sourceAssetId: 'unrelated-asset' });
  const nodes = [upstream, selected, unrelated];
  const edges: Edge[] = [{ id: 'upstream-selected', source: 'upstream', target: 'selected' }];
  const scope = buildRunPreflightDiagnosticScope({
    nodes,
    edges,
    executionNodeIds: ['selected'],
    mode: 'selection-input-context',
  });
  const issues = scopeRunPreflightIssues(analyzeWorkflow(scope.nodes, scope.edges, {
    projectId: 'project-a',
    assets: [
      { id: 'consumed-asset', projectId: 'project-a', availability: 'missing' },
      { id: 'unrelated-asset', projectId: 'project-a', availability: 'missing' },
    ],
  }), scope);

  assert.ok(issues.some((issue) => issue.ruleId === 'asset.invalid' && issue.evidence.facts.assetId === 'consumed-asset'));
  assert.equal(issues.some((issue) => issue.ruleId === 'asset.invalid' && issue.evidence.facts.assetId === 'unrelated-asset'), false);
});

test('RunIntent estimated cost participates in per-run and projected daily policy diagnostics', () => {
  const diagnostics = buildRunPreflightDiagnostics({
    nodes: [textNode('selected')],
    edges: [],
    executionNodeIds: ['selected'],
    scopeMode: 'exact-plan',
    projectId: 'project-a',
    settings,
    providersComplete: true,
    assets: [],
    estimatedCost: 1.5,
    policy: {
      policy: {
        projectId: 'project-a', allowedModels: [], dailyCostLimit: 10,
        perRunCostLimit: 2, concurrencyLimit: 2, updatedAt: 1,
      },
      usage: { activeCount: 0, dailyCost: 9, unknownCostCount: 0, dayStart: 1 },
    },
  });
  const projected = diagnostics.policy.find((item) => item.id === 'daily-cost-limit-reached');
  assert.ok(projected);
  assert.match(String(projected.detail), /10\.5/);
  assert.equal(projected.severity, 'error');

  const perRun = buildRunPreflightDiagnostics({
    nodes: [textNode('selected')], edges: [], executionNodeIds: ['selected'], scopeMode: 'exact-plan',
    projectId: 'project-a', settings, providersComplete: true, assets: [], estimatedCost: 2.5,
    policy: {
      policy: { projectId: 'project-a', allowedModels: [], dailyCostLimit: 0, perRunCostLimit: 2, concurrencyLimit: 0 },
      usage: { activeCount: 0, dailyCost: 0, unknownCostCount: 0, dayStart: 1 },
    },
  });
  assert.ok(perRun.policy.some((item) => item.ruleId === 'limits.cost-budget-exceeded'));
});
