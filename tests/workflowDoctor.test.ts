import test from 'node:test';
import assert from 'node:assert/strict';
import type { Edge, Node } from '@xyflow/react';
import {
  WORKFLOW_DOCTOR_RULE_COUNT,
  WORKFLOW_DOCTOR_RULES,
  analyzeWorkflow,
  applyCanvasPatch,
  buildWorkflowDoctorCanvasHighlights,
  collectWorkflowAssetIds,
  planCanvasAgentRequest,
  workflowIssuesFromCanvasAgentValidation,
} from '../src/utils/workflowDoctor.ts';
import { CANVAS_NODE_SCHEMA_MANIFEST } from '../src/config/nodeRegistry.ts';

test('E1 exposes exactly 30 independently countable rules with a complete evidence contract', () => {
  assert.equal(WORKFLOW_DOCTOR_RULE_COUNT, 30);
  assert.equal(new Set(WORKFLOW_DOCTOR_RULES.map((rule) => rule.id)).size, 30);
  for (const rule of WORKFLOW_DOCTOR_RULES) {
    assert.match(rule.id, /^[a-z]+(?:[.-][a-z0-9]+)+$/);
    assert.ok(['error', 'warning', 'info'].includes(rule.severity));
    assert.ok(['automatic', 'manual', 'none'].includes(rule.fixability));
    assert.equal(rule.applicableVersion.minAppVersion, '2.5.5');
    assert.equal(rule.applicableVersion.doctorSchema, 1);
  }
});

test('doctor recognizes every production type plus persisted groupBox while still rejecting an actual unknown type', () => {
  const nodes: Node[] = [
    ...CANVAS_NODE_SCHEMA_MANIFEST.types.map((item, index) => ({
      id: `known-${index}`,
      type: item.type,
      position: { x: index, y: 0 },
      data: {},
    } as Node)),
    { id: 'group', type: 'groupBox', position: { x: 0, y: 100 }, data: { memberIds: [] } } as Node,
    { id: 'unknown', type: 'missing-plugin-node', position: { x: 0, y: 200 }, data: {} } as Node,
  ];

  const unknownIssues = analyzeWorkflow(nodes, [])
    .filter((issue) => issue.ruleId === 'registry.unknown-node-type');

  assert.deepEqual(unknownIssues.map((issue) => issue.nodeIds), [['unknown']]);
});

test('doctor reports dangling and duplicate edges with previewable repairs', () => {
  const nodes: Node[] = [
    { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { text: 'hello' } },
    { id: 'b', type: 'image', position: { x: 200, y: 0 }, data: { prompt: 'x' } },
  ];
  const edges: Edge[] = [
    { id: 'one', source: 'a', target: 'b', sourceHandle: 'text', targetHandle: 'text' },
    { id: 'two', source: 'a', target: 'b', sourceHandle: 'text', targetHandle: 'text' },
    { id: 'lost', source: 'missing', target: 'b' },
  ];
  const issues = analyzeWorkflow(nodes, edges);
  assert.ok(issues.some((item) => item.title === '悬空连线'));
  const duplicate = issues.find((item) => item.title === '重复连线');
  assert.ok(duplicate?.patch);
  assert.deepEqual(duplicate!.patch!.diagnosticsResolved, ['topology.duplicate-edge']);
  const fixed = applyCanvasPatch(nodes, edges.filter((edge) => edge.id !== 'lost'), duplicate!.patch!);
  assert.equal(fixed.edges.length, 1);
});

test('patch application is atomic and rejects dangling results', () => {
  const nodes: Node[] = [
    { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {} },
    { id: 'b', type: 'image', position: { x: 100, y: 0 }, data: {} },
  ];
  const edges: Edge[] = [{ id: 'ab', source: 'a', target: 'b' }];
  assert.throws(() => applyCanvasPatch(nodes, edges, {
    id: 'bad', title: 'bad', description: '', operations: [{ type: 'node.patch', nodeId: 'missing', patch: { position: { x: 1, y: 1 } } }],
  }), /目标节点不存在/);
  assert.equal(nodes.length, 2);
  assert.equal(edges.length, 1);
});

test('canvas agent only composes deterministic fixable issues', () => {
  const nodes: Node[] = [
    { id: 'a', type: 'text', position: { x: Number.NaN, y: 0 }, data: {} },
  ];
  const issues = analyzeWorkflow(nodes, []);
  const proposal = planCanvasAgentRequest('修复全部可自动修复的问题', issues);
  assert.ok(proposal);
  assert.ok(proposal!.operations.some((operation) => operation.type === 'node.patch'));
  assert.deepEqual(proposal!.diagnosticsResolved, ['layout.invalid-position']);
  assert.equal(planCanvasAgentRequest('创建一个新模型节点', issues), null);
});

test('doctor validates subflow handles, types, capacity, required inputs, and defaults deterministically', () => {
  const source = {
    id: 'source', type: 'subflow', position: { x: 0, y: 0 },
    data: { definitionId: 'source-flow', definitionVersion: 1, definition: { id: 'source-flow', version: 1, inputs: [], outputs: [{ id: 'image-out', kind: 'image', required: false }] } },
  } as Node;
  const target = {
    id: 'target', type: 'subflow', position: { x: 200, y: 0 },
    data: { definitionId: 'target-flow', definitionVersion: 1, definition: { id: 'target-flow', version: 1, inputs: [{ id: 'video-in', kind: 'video', required: true, maxConnections: 1 }], outputs: [] } },
  } as Node;
  const required = {
    id: 'required', type: 'subflow', position: { x: 400, y: 0 },
    data: { definitionId: 'required-flow', definitionVersion: 1, definition: { id: 'required-flow', version: 1, inputs: [{ id: 'must', kind: 'text', required: true }], outputs: [] } },
  } as Node;
  const defaulted = {
    id: 'defaulted', type: 'subflow', position: { x: 600, y: 0 },
    data: { definitionId: 'default-flow', definitionVersion: 1, definition: { id: 'default-flow', version: 1, inputs: [{ id: 'optional-by-default', kind: 'text', required: true, defaultValue: '' }], outputs: [] } },
  } as Node;
  const edges: Edge[] = [
    { id: 'mismatch-one', source: 'source', target: 'target', sourceHandle: 'image-out', targetHandle: 'video-in' },
    { id: 'mismatch-two', source: 'source', target: 'target', sourceHandle: 'image-out', targetHandle: 'video-in' },
    { id: 'unknown', source: 'source', target: 'target', sourceHandle: 'removed-output', targetHandle: 'video-in' },
  ];
  const issues = analyzeWorkflow([source, target, required, defaulted], edges);
  const ruleIds = new Set(issues.map((item) => item.ruleId));
  assert.ok(ruleIds.has('ports.handle-unknown'));
  assert.ok(ruleIds.has('ports.type-incompatible'));
  assert.ok(ruleIds.has('ports.capacity-exceeded'));
  assert.ok(issues.some((item) => item.ruleId === 'ports.required-input-missing' && item.nodeIds.includes('required')));
  assert.equal(issues.some((item) => item.ruleId === 'ports.required-input-missing' && item.nodeIds.includes('defaulted')), false);
});

test('doctor uses an explicit provider inventory for availability, regional credential, and model capability', () => {
  const nodes: Node[] = [
    { id: 'image', type: 'image', position: { x: 0, y: 0 }, data: { prompt: 'x', providerSource: 'volcengine', providerId: 'volc', providerModel: 'video-only' } },
    { id: 'llm', type: 'llm', position: { x: 100, y: 0 }, data: { providerSource: 'modelscope', providerId: 'removed', providerModel: 'qwen' } },
  ];
  const issues = analyzeWorkflow(nodes, [], {
    providersComplete: true,
    providers: [{
      id: 'volc', source: 'volcengine', enabled: true,
      models: { image: ['image-ok'] }, configuredRegion: '', regionCredentialConfigured: false,
    }],
  });
  assert.ok(issues.some((item) => item.ruleId === 'provider.region-credential-missing' && item.nodeIds.includes('image')));
  assert.ok(issues.some((item) => item.ruleId === 'model.capability-mismatch' && item.nodeIds.includes('image')));
  assert.ok(issues.some((item) => item.ruleId === 'provider.selection-unavailable' && item.nodeIds.includes('llm')));

  const incomplete = analyzeWorkflow([nodes[1]], [], { providersComplete: false, providers: [] });
  assert.equal(incomplete.some((item) => item.ruleId === 'provider.selection-unavailable'), false);
});

test('doctor treats an unannotated MiniMax H3 node as the default domestic provider without hiding explicit extensions', () => {
  const defaultH3: Node = {
    id: 'h3-default',
    type: 'minimax-h3-prompt-enhancer',
    position: { x: 0, y: 0 },
    data: { providerSource: 'zhenzhen', providerModel: 'bytedance/doubao-seed-2.1-pro' },
  };
  const defaultIssues = analyzeWorkflow([defaultH3], [], {
    limits: { allowedModels: ['seedance-nz:bytedance/doubao-seed-2.1-pro'] },
  });
  assert.equal(defaultIssues.some((item) => item.ruleId === 'model.capability-mismatch'), false);

  const externalH3: Node = {
    ...defaultH3,
    id: 'h3-external',
    data: {
      providerSource: 'openai-compatible',
      providerId: 'custom-openai',
      providerModel: 'vision-model',
    },
  };
  const externalIssues = analyzeWorkflow([externalH3], [], {
    providersComplete: true,
    providers: [],
  });
  assert.equal(
    externalIssues.some((item) => item.ruleId === 'provider.selection-unavailable' && item.nodeIds.includes('h3-external')),
    true,
  );
});

test('doctor only treats top-level sourceAssetId as a project AssetRef', () => {
  const nodes: Node[] = [
    { id: 'project-asset', type: 'image', position: { x: 0, y: 0 }, data: { prompt: 'x', sourceAssetId: 'asset-project' } },
    { id: 'timeline-asset', type: 'video-edit', position: { x: 100, y: 0 }, data: { timelineV2: { items: [{ assetId: 'asset-internal' }] } } },
  ];
  assert.deepEqual(collectWorkflowAssetIds(nodes), ['asset-project']);
  const issues = analyzeWorkflow(nodes, [], {
    assets: [
      { id: 'asset-project', availability: 'corrupt', kind: 'image' },
      { id: 'asset-internal', availability: 'missing', kind: 'video' },
    ],
  });
  assert.ok(issues.some((item) => item.ruleId === 'asset.invalid' && item.evidence.facts.assetId === 'asset-project'));
  assert.equal(issues.some((item) => item.ruleId === 'asset.invalid' && item.evidence.facts.assetId === 'asset-internal'), false);
});

test('doctor validates immutable subflow identity and version without guessing latest version', () => {
  const node = {
    id: 'subflow', type: 'subflow', position: { x: 0, y: 0 },
    data: {
      definitionId: 'flow-a', definitionVersion: 3, definitionProjectId: 'project-a',
      definition: { id: 'flow-b', version: 2, projectId: 'project-b', inputs: [], outputs: [] },
    },
  } as Node;
  const issue = analyzeWorkflow([node], []).find((item) => item.ruleId === 'subflow.version-invalid');
  assert.ok(issue);
  assert.equal(issue!.location.field, 'definitionVersion');
  assert.equal(issue!.evidence.facts.version, 3);
  assert.equal(issue!.evidence.facts.embeddedVersion, 2);
});

test('E5 maps authoritative recursive-subflow diagnostics to local fixed instances without trusting remote node ids', () => {
  const nodes: Node[] = [
    {
      id: 'local-root-instance',
      type: 'subflow',
      position: { x: 0, y: 0 },
      data: {
        definitionId: 'root',
        definitionVersion: 1,
        definitionProjectId: 'project-a',
        definition: { id: 'root', version: 1, projectId: 'project-a', inputs: [], outputs: [] },
      },
    } as Node,
  ];
  const issues = workflowIssuesFromCanvasAgentValidation({
    valid: false,
    diagnostics: [
      {
        ruleId: 'topology.cycle',
        severity: 'error',
        targetType: 'subflow',
        targetId: 'forged-remote-node-id',
        detail: '固定版本子工作流依赖形成循环',
        facts: {
          variant: 'subflow-dependency',
          rootRefs: ['root@1'],
          cycleRefs: ['child@2', 'leaf@4', 'child@2'],
          definitionCount: 3,
          maxDepth: 8,
        },
      },
      {
        ruleId: 'subflow.version-invalid',
        severity: 'error',
        targetType: 'subflow',
        targetId: 'forged-missing-node-id',
        detail: '不要信任远端详情',
        facts: {
          variant: 'subflow-dependency-unavailable',
          rootRefs: ['root@1'],
          dependencyRef: 'missing@7',
        },
      },
      {
        ruleId: 'subflow.version-invalid',
        severity: 'error',
        targetType: 'subflow',
        targetId: 'forged-pin-node-id',
        detail: '不要信任远端详情',
        facts: {
          variant: 'subflow-dependency-pin-mismatch',
          rootRefs: ['root@1'],
          definitionRef: 'child@2',
        },
      },
      {
        ruleId: 'subflow.version-invalid',
        severity: 'error',
        targetType: 'subflow',
        targetId: 'forged-depth-node-id',
        detail: '不要信任远端详情',
        facts: {
          variant: 'subflow-dependency-depth-limit',
          rootRefs: ['root@1'],
          definitionRef: 'deep@8',
          maximum: 8,
        },
      },
      {
        ruleId: 'subflow.version-invalid',
        severity: 'error',
        targetType: 'subflow',
        targetId: 'forged-limit-node-id',
        detail: '不要信任远端详情',
        facts: {
          variant: 'subflow-dependency-limit',
          rootRefs: ['root@1'],
          maximum: 100,
        },
      },
      {
        ruleId: 'subflow.version-invalid',
        severity: 'error',
        targetType: 'subflow',
        targetId: 'forged-invalid-node-id',
        detail: '畸形远端诊断必须忽略',
        facts: {
          variant: 'subflow-dependency-depth-limit',
          rootRefs: ['root@1'],
          definitionRef: 'not a fixed ref',
          maximum: 0,
        },
      },
    ],
  }, nodes, 'project-a');

  assert.equal(issues.length, 5);
  assert.deepEqual(issues.map((item) => item.ruleId), [
    'topology.cycle',
    'subflow.version-invalid',
    'subflow.version-invalid',
    'subflow.version-invalid',
    'subflow.version-invalid',
  ]);
  for (const issue of issues) {
    assert.deepEqual(issue.targetNodeIds, ['local-root-instance']);
    assert.deepEqual(issue.nodeIds, ['local-root-instance']);
  }
  assert.equal(issues[0].evidence.facts.variant, 'subflow-dependency');
  assert.deepEqual(issues.slice(1).map((item) => item.evidence.facts.variant), [
    'subflow-dependency-unavailable',
    'subflow-dependency-pin-mismatch',
    'subflow-dependency-depth-limit',
    'subflow-dependency-limit',
  ]);
  assert.match(issues[1].detail, /missing@7/);
  assert.match(issues[2].detail, /child@2/);
  assert.match(issues[3].detail, /8 层/);
  assert.match(issues[4].detail, /100 项/);
  assert.doesNotMatch(JSON.stringify(issues), /forged-|不要信任|畸形远端/);
});

test('E5 non-invasive Doctor highlights aggregate severity and exact input/output handles', () => {
  const nodes: Node[] = [
    {
      id: 'source',
      type: 'subflow',
      position: { x: 0, y: 0 },
      data: {
        definitionId: 'source-flow',
        definitionVersion: 1,
        definition: {
          id: 'source-flow',
          version: 1,
          inputs: [],
          outputs: [{ id: 'image-out', kind: 'image', required: false }],
        },
      },
    } as Node,
    {
      id: 'target',
      type: 'subflow',
      position: { x: 200, y: 0 },
      data: {
        definitionId: 'target-flow',
        definitionVersion: 1,
        definition: {
          id: 'target-flow',
          version: 1,
          inputs: [{ id: 'video-in', kind: 'video', required: true }],
          outputs: [],
        },
      },
    } as Node,
  ];
  const edges: Edge[] = [{
    id: 'bad-port-edge',
    source: 'source',
    target: 'target',
    sourceHandle: 'image-out',
    targetHandle: 'video-in',
  }];
  const highlights = buildWorkflowDoctorCanvasHighlights(analyzeWorkflow(nodes, edges), edges);
  const source = highlights.find((item) => item.nodeId === 'source');
  const target = highlights.find((item) => item.nodeId === 'target');

  assert.equal(source?.severity, 'error');
  assert.ok(source?.outputPortIds.includes('image-out'));
  assert.ok(target?.inputPortIds.includes('video-in'));
  assert.ok((source?.issueCount || 0) >= 1);
  assert.ok((target?.issueCount || 0) >= 1);
});

test('doctor reports exact three-layer run failure evidence and rejected stale writeback without exposing tokens', () => {
  const issues = analyzeWorkflow([], [], {
    runs: [{
      runId: 'run-1', nodeRunId: 'node-run-1', attemptId: 'attempt-1', attemptNumber: 2,
      nodeId: 'node-1', status: 'failed', category: 'platform', errorKind: 'upstream',
      errorCode: 'UPSTREAM_FAILED', httpStatus: 503, provider: 'seedance-nz',
      model: 'wan-2.7-spicy-i2v', retryable: true, evidenceComplete: true,
      writebackMatchesCurrent: false,
    }],
  });
  const failure = issues.find((item) => item.ruleId === 'run.failure-evidence');
  assert.deepEqual(failure?.evidence.facts, {
    variant: 'run',
    runId: 'run-1',
    nodeRunId: 'node-run-1',
    attemptId: 'attempt-1',
    attemptNumber: 2,
    nodeId: 'node-1',
    status: 'failed',
    category: 'platform',
    errorKind: 'upstream',
    errorCode: 'UPSTREAM_FAILED',
    httpStatus: 503,
    provider: 'seedance-nz',
    model: 'wan-2.7-spicy-i2v',
    retryable: true,
    errorPresent: true,
    evidenceComplete: true,
  });
  assert.ok(issues.some((item) => item.ruleId === 'run.stale-writeback'));
  const stale = issues.find((item) => item.ruleId === 'run.stale-writeback');
  assert.deepEqual(stale?.evidence.facts, {
    variant: 'writeback-token',
    runId: 'run-1',
    nodeRunId: 'node-run-1',
    attemptId: 'attempt-1',
    nodeId: 'node-1',
    storedStatus: '',
    tokenMatch: false,
    activeInLiveSnapshot: null,
  });
});

test('doctor ignores incomplete, missing, and legacy-forged Run references', () => {
  const issues = analyzeWorkflow([], [], {
    runs: [
      {
        runId: 'run-incomplete', nodeRunId: 'node-run-incomplete', attemptId: 'attempt-incomplete',
        status: 'failed', errorCode: 'FAILED', evidenceComplete: false, writebackMatchesCurrent: false,
      },
      {
        runId: 'run-missing-attempt', nodeRunId: 'node-run-missing-attempt', attemptId: '',
        status: 'failed', errorCode: 'FAILED', evidenceComplete: true, writebackMatchesCurrent: false,
      },
      {
        id: 'legacy-forged-run', nodeId: 'node-1', status: 'failed', errorCode: 'FAILED',
        errorMessage: 'legacy summary must not become evidence', upstreamTaskId: 'task-1',
        writebackMatchesCurrent: false,
      } as never,
    ],
  });

  assert.equal(issues.some((item) => item.ruleId === 'run.failure-evidence'), false);
  assert.equal(issues.some((item) => item.ruleId === 'run.stale-writeback'), false);
});

test('stored running state is stale only with a complete live-run snapshot', () => {
  const node = { id: 'running', type: 'image', position: { x: 0, y: 0 }, data: { prompt: 'x', status: 'running' } } as Node;
  assert.equal(analyzeWorkflow([node], []).some((item) => item.id === 'stale-running-running'), false);
  assert.equal(analyzeWorkflow([node], [], { liveRun: { complete: false, activeNodeIds: [] } }).some((item) => item.id === 'stale-running-running'), false);
  assert.ok(analyzeWorkflow([node], [], { liveRun: { complete: true, activeNodeIds: [] } }).some((item) => item.id === 'stale-running-running'));
  assert.equal(analyzeWorkflow([node], [], { liveRun: { complete: true, activeNodeIds: ['running'] } }).some((item) => item.id === 'stale-running-running'), false);
});

test('doctor checks only explicit cost and concurrency limits', () => {
  const issues = analyzeWorkflow([], [], { limits: { estimatedCost: 12.5, costBudget: 10, activeCount: 4, concurrencyLimit: 2 } });
  assert.ok(issues.some((item) => item.ruleId === 'limits.cost-budget-exceeded'));
  assert.ok(issues.some((item) => item.ruleId === 'limits.concurrency-exceeded'));
  assert.equal(analyzeWorkflow([], []).some((item) => item.ruleId.startsWith('limits.')), false);
});

test('large data URLs and errors produce bounded redacted evidence, never payload or secrets', () => {
  const secret = ['sk-', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
  const payload = 'A'.repeat(100_000);
  const node = {
    id: 'large', type: 'image', position: { x: 0, y: 0 },
    data: { prompt: 'x', imageUrl: `data:image/png;base64,${payload}`, error: `${secret} C:\\Users\\private\\secret.txt` },
  } as Node;
  const issues = analyzeWorkflow([node], [], { largeBase64Bytes: 64 * 1024 });
  const large = issues.find((item) => item.ruleId === 'payload.large-base64');
  assert.ok(large);
  assert.deepEqual(large!.evidence.facts.fields, ['data.imageUrl']);
  assert.equal(typeof large!.evidence.facts.maxBytes, 'number');
  const serialized = JSON.stringify(issues);
  assert.doesNotMatch(serialized, new RegExp(payload.slice(0, 200)));
  assert.doesNotMatch(serialized, /abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(serialized, /Users\\\\private/);
  for (const issue of issues) {
    assert.equal(issue.evidence.code, issue.ruleId);
    assert.ok(issue.location.scope);
    assert.ok(issue.fixability);
    assert.equal(issue.applicableVersion.doctorSchema, 1);
  }
});

test('doctor handles a 10,000-node acyclic chain without recursive stack overflow', () => {
  const nodes: Node[] = Array.from({ length: 10_000 }, (_, index) => ({
    id: `chain-${index}`,
    type: 'text',
    position: { x: index, y: 0 },
    data: { text: `step ${index}` },
  }));
  const edges: Edge[] = Array.from({ length: nodes.length - 1 }, (_, index) => ({
    id: `chain-edge-${index}`,
    source: nodes[index].id,
    target: nodes[index + 1].id,
  }));

  let issues: ReturnType<typeof analyzeWorkflow> = [];
  assert.doesNotThrow(() => { issues = analyzeWorkflow(nodes, edges); });
  assert.equal(issues.some((item) => item.ruleId === 'topology.cycle'), false);
});

test('an unuploaded upload node connected to an image input is type-incompatible', () => {
  const nodes: Node[] = [
    { id: 'empty-upload', type: 'upload', position: { x: 0, y: 0 }, data: {} },
    { id: 'image-target', type: 'image', position: { x: 200, y: 0 }, data: { prompt: 'render' } },
  ];
  const edge: Edge = { id: 'empty-upload-edge', source: 'empty-upload', target: 'image-target' };
  const issue = analyzeWorkflow(nodes, [edge]).find((item) => item.ruleId === 'ports.type-incompatible');

  assert.ok(issue);
  assert.deepEqual(issue.edgeIds, ['empty-upload-edge']);
  assert.deepEqual(issue.evidence.facts.sourceKinds, []);
  assert.deepEqual(issue.evidence.facts.targetKinds, ['text', 'image']);
});

test('dangling and incompatible edges do not satisfy a required subflow input', () => {
  const nodes: Node[] = [
    { id: 'text-source', type: 'text', position: { x: 0, y: 0 }, data: { text: 'hello' } },
    {
      id: 'required-image',
      type: 'subflow',
      position: { x: 200, y: 0 },
      data: {
        definitionId: 'required-image-flow',
        definitionVersion: 1,
        definition: {
          id: 'required-image-flow', version: 1,
          inputs: [{ id: 'image-in', kind: 'image', required: true }], outputs: [],
        },
      },
    } as Node,
  ];
  const edges: Edge[] = [
    { id: 'dangling-required', source: 'missing-source', target: 'required-image', targetHandle: 'image-in' },
    { id: 'incompatible-required', source: 'text-source', target: 'required-image', targetHandle: 'image-in' },
  ];
  const issues = analyzeWorkflow(nodes, edges);
  const required = issues.find((item) => item.ruleId === 'ports.required-input-missing');

  assert.ok(required);
  assert.equal(required.evidence.facts.actual, 0);
  assert.equal(required.evidence.facts.attached, 2);
  assert.ok(issues.some((item) => item.ruleId === 'ports.type-incompatible' && item.edgeIds.includes('incompatible-required')));
});

test('one edge with invalid subflow handles on both ends reports both invalid sides', () => {
  const nodes: Node[] = [
    {
      id: 'source-flow', type: 'subflow', position: { x: 0, y: 0 },
      data: {
        definitionId: 'source-definition', definitionVersion: 1,
        definition: { id: 'source-definition', version: 1, inputs: [], outputs: [{ id: 'real-out', kind: 'image' }] },
      },
    } as Node,
    {
      id: 'target-flow', type: 'subflow', position: { x: 200, y: 0 },
      data: {
        definitionId: 'target-definition', definitionVersion: 1,
        definition: { id: 'target-definition', version: 1, inputs: [{ id: 'real-in', kind: 'image' }], outputs: [] },
      },
    } as Node,
  ];
  const issues = analyzeWorkflow(nodes, [{
    id: 'both-handles-removed',
    source: 'source-flow', sourceHandle: 'removed-out',
    target: 'target-flow', targetHandle: 'removed-in',
  }]);
  const invalidHandles = issues.filter((item) => item.ruleId === 'ports.handle-unknown');

  assert.equal(invalidHandles.length, 2);
  assert.deepEqual(new Set(invalidHandles.map((item) => item.evidence.facts.side)), new Set(['source', 'target']));
  assert.deepEqual(new Set(invalidHandles.map((item) => item.location.field)), new Set(['sourceHandle', 'targetHandle']));
});

test('batch tagger uses its dedicated provider fields and host allowed-model policy', () => {
  const node = {
    id: 'batch', type: 'batch-tagger', position: { x: 0, y: 0 },
    data: {
      providerSource: 'zhenzhen',
      providerId: 'wrong-generic-provider',
      providerModel: 'wrong-generic-model',
      batchTagProviderSource: 'openai-compatible',
      batchTagProviderId: 'batch-provider',
      batchTagProviderModel: 'provider-model',
    },
  } as Node;
  const issues = analyzeWorkflow([node], [], {
    providersComplete: true,
    providers: [{
      id: 'batch-provider', source: 'openai-compatible', enabled: true,
      models: { llm: ['provider-model'] },
    }],
    limits: { allowedModels: ['host-approved-model'] },
  });
  const policyIssue = issues.find((item) => item.ruleId === 'model.capability-mismatch');

  assert.ok(policyIssue);
  assert.equal(policyIssue.evidence.facts.providerId, 'batch-provider');
  assert.equal(policyIssue.evidence.facts.selectedModel, 'provider-model');
  assert.equal(policyIssue.evidence.facts.policy, 'host-execution');
  assert.equal(policyIssue.location.field, 'batchTagProviderModel');
  assert.equal(issues.some((item) => item.ruleId === 'provider.selection-unavailable'), false);

  const allowed = analyzeWorkflow([node], [], {
    providersComplete: true,
    providers: [{
      id: 'batch-provider', source: 'openai-compatible', enabled: true,
      models: { llm: ['provider-model'] },
    }],
    limits: { allowedModels: ['provider-model'] },
  });
  assert.equal(allowed.some((item) => item.ruleId === 'model.capability-mismatch'), false);
});

test('an available AssetRef from another project is invalid in the current project', () => {
  const node = {
    id: 'asset-node', type: 'image', position: { x: 0, y: 0 },
    data: { prompt: 'use asset', sourceAssetId: 'asset-cross-project' },
  } as Node;
  const issue = analyzeWorkflow([node], [], {
    projectId: 'project-a',
    assets: [{ id: 'asset-cross-project', availability: 'available', projectId: 'project-b', kind: 'image' }],
  }).find((item) => item.ruleId === 'asset.invalid');

  assert.ok(issue);
  assert.equal(issue.evidence.facts.availability, 'project-mismatch');
  assert.equal(issue.evidence.facts.projectMatch, false);
  assert.equal(issue.evidence.facts.assetId, 'asset-cross-project');
});

test('daily cost and active concurrency diagnose equality as capacity reached', () => {
  const issues = analyzeWorkflow([], [], {
    limits: {
      dailyCost: 25,
      dailyCostLimit: 25,
      activeCount: 4,
      concurrencyLimit: 4,
    },
  });
  const daily = issues.find((item) => item.id === 'daily-cost-limit-reached');
  const concurrency = issues.find((item) => item.ruleId === 'limits.concurrency-exceeded');

  assert.ok(daily);
  assert.equal(daily.ruleId, 'limits.cost-budget-exceeded');
  assert.equal(daily.evidence.facts.atCapacity, true);
  assert.ok(concurrency);
  assert.equal(concurrency.evidence.facts.atCapacity, true);
  assert.equal(concurrency.evidence.facts.excess, 0);
});

test('ordinary node errors cannot forge Run evidence and enumerable diagnostics remain redacted', () => {
  const nodeId = 'sk-NodeCredentialABC123456789';
  const edgeId = 'apiKey=EdgeCredentialABC123456789';
  const plainApiKey = 'UnprefixedCredentialABC123456789';
  const payload = 'Q'.repeat(120_000);
  const node = {
    id: nodeId,
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      prompt: 'x',
      imageUrl: `data:image/png;base64,${payload}`,
      error: `provider rejected apiKey=${plainApiKey}; body=data:image/png;base64,${payload}`,
    },
  } as Node;
  const issues = analyzeWorkflow([node], [{ id: edgeId, source: nodeId, target: 'missing-target' }], {
    largeBase64Bytes: 64 * 1024,
  });
  const serialized = JSON.stringify(issues);

  assert.ok(issues.some((item) => item.ruleId === 'topology.dangling-edge'));
  assert.equal(issues.some((item) => item.ruleId === 'run.failure-evidence'), false);
  assert.ok(issues.some((item) => item.ruleId === 'payload.large-base64'));
  assert.doesNotMatch(serialized, new RegExp(nodeId));
  assert.doesNotMatch(serialized, /EdgeCredentialABC123456789/);
  assert.doesNotMatch(serialized, new RegExp(plainApiKey));
  assert.doesNotMatch(serialized, new RegExp(payload.slice(0, 200)));
  assert.match(serialized, /\[credential\]/);

  const wrappedPayload = `${'A'.repeat(40)}\r\n  ${'B'.repeat(100_000)}`;
  const wrappedIssues = analyzeWorkflow([{
    id: 'wrapped-error', type: 'image', position: { x: 0, y: 0 },
    data: { prompt: 'x', error: `body=data:image/png;base64,${wrappedPayload}` },
  } as Node], []);
  const wrapped = JSON.stringify(wrappedIssues);
  assert.equal(wrappedIssues.some((item) => item.ruleId === 'run.failure-evidence'), false);
  assert.doesNotMatch(wrapped, /B{200}/);
});

test('three duplicate node ids keep issue ids unique and disable ambiguous coordinate repair', () => {
  const nodes: Node[] = Array.from({ length: 3 }, (_, index) => ({
    id: 'duplicate-node',
    type: 'text',
    position: { x: Number.NaN, y: index },
    data: { text: `node ${index}` },
  }));
  const issues = analyzeWorkflow(nodes, []);
  const duplicateIds = issues.filter((item) => item.ruleId === 'identity.duplicate-node-id');
  const invalidPositions = issues.filter((item) => item.ruleId === 'layout.invalid-position');

  assert.equal(new Set(issues.map((item) => item.id)).size, issues.length);
  assert.equal(duplicateIds.length, 2);
  assert.equal(new Set(duplicateIds.map((item) => item.id)).size, duplicateIds.length);
  assert.equal(invalidPositions.length, 3);
  assert.equal(new Set(invalidPositions.map((item) => item.id)).size, invalidPositions.length);
  assert.ok(invalidPositions.every((item) => item.fixability === 'none' && item.patch === undefined));
});

test('edge tuple delimiters cannot collapse distinct connections into a duplicate signature', () => {
  const nodes: Node[] = [
    { id: 'a|b', type: 'text', position: { x: 0, y: 0 }, data: { text: 'one' } },
    { id: 'a', type: 'text', position: { x: 0, y: 100 }, data: { text: 'two' } },
    { id: 'd', type: 'text', position: { x: 200, y: 0 }, data: { text: 'target' } },
  ];
  const edges: Edge[] = [
    { id: 'tuple-one', source: 'a|b', sourceHandle: 'c', target: 'd', targetHandle: 'e' },
    { id: 'tuple-two', source: 'a', sourceHandle: 'b|c', target: 'd', targetHandle: 'e' },
  ];

  assert.equal(analyzeWorkflow(nodes, edges).some((item) => item.ruleId === 'topology.duplicate-edge'), false);
});

test('duplicate edge ids disable automatic deletion and patch application rejects ambiguity', () => {
  const nodes: Node[] = [
    { id: 'source', type: 'text', position: { x: 0, y: 0 }, data: { text: 'x' } },
    { id: 'target', type: 'text', position: { x: 200, y: 0 }, data: { text: 'y' } },
  ];
  const edges: Edge[] = [
    { id: 'same-edge-id', source: 'source', target: 'target' },
    { id: 'same-edge-id', source: 'source', target: 'target' },
  ];
  const duplicate = analyzeWorkflow(nodes, edges).find((item) => item.ruleId === 'topology.duplicate-edge');

  assert.ok(duplicate);
  assert.equal(duplicate.fixability, 'none');
  assert.equal(duplicate.patch, undefined);
  assert.throws(() => applyCanvasPatch(nodes, edges, {
    id: 'ambiguous-edge-delete',
    title: 'ambiguous',
    description: '',
    operations: [{ type: 'edge.delete', edgeId: 'same-edge-id' }],
  }), /修复目标连线不唯一/);
});

test('canvas agent honors an explicit request to repair coordinates without modifying edges', () => {
  const nodes: Node[] = [
    { id: 'bad-position', type: 'text', position: { x: Number.NaN, y: 0 }, data: { text: 'x' } },
  ];
  const edges: Edge[] = [{ id: 'dangling', source: 'bad-position', target: 'missing' }];
  const proposal = planCanvasAgentRequest(
    '修复全部可自动修复问题，只修复节点坐标，不要修改连线',
    analyzeWorkflow(nodes, edges),
  );

  assert.ok(proposal);
  assert.ok(proposal.operations.length > 0);
  assert.ok(proposal.operations.every((operation) => operation.type === 'node.patch'));
});

test('emitted severity follows the rule catalog and run variants keep aligned evidence shapes', () => {
  const node = {
    id: 'stored-run', type: 'image', position: { x: 0, y: 0 },
    data: { prompt: 'x', status: 'running', error: 'node failed' },
  } as Node;
  const issues = analyzeWorkflow([node], [], {
    liveRun: { complete: true, activeNodeIds: [] },
    runs: [{
      runId: 'run-failed', nodeRunId: 'node-run-failed', attemptId: 'attempt-failed',
      attemptNumber: 1, nodeId: 'stored-run', status: 'failed', category: 'platform',
      errorKind: 'provider', errorCode: 'FAILED', httpStatus: 502, provider: 'seedance-nz',
      model: 'wan-2.7-spicy-i2v', retryable: false, evidenceComplete: true,
      writebackMatchesCurrent: false,
    }],
  });
  const rules = new Map(WORKFLOW_DOCTOR_RULES.map((rule) => [rule.id, rule]));
  for (const issue of issues) {
    assert.equal(issue.severity, rules.get(issue.ruleId)?.severity);
    assert.equal(issue.evidence.code, issue.ruleId);
  }

  const failures = issues.filter((item) => item.ruleId === 'run.failure-evidence');
  assert.equal(failures.length, 1);
  assert.deepEqual(
    Object.keys(failures[0].evidence.facts).sort(),
    [
      'attemptId', 'attemptNumber', 'category', 'errorCode', 'errorKind', 'errorPresent',
      'evidenceComplete', 'httpStatus', 'model', 'nodeId', 'nodeRunId', 'provider',
      'retryable', 'runId', 'status', 'variant',
    ],
  );

  const stale = issues.filter((item) => item.ruleId === 'run.stale-writeback');
  assert.equal(stale.length, 2);
  const writebackStale = stale.find((item) => item.evidence.facts.variant === 'writeback-token');
  const storedStatusStale = stale.find((item) => item.evidence.facts.variant === 'stored-status');
  assert.deepEqual(
    Object.keys(writebackStale!.evidence.facts).sort(),
    ['activeInLiveSnapshot', 'attemptId', 'nodeId', 'nodeRunId', 'runId', 'storedStatus', 'tokenMatch', 'variant'],
  );
  assert.deepEqual(
    Object.keys(storedStatusStale!.evidence.facts).sort(),
    ['activeInLiveSnapshot', 'nodeId', 'runId', 'storedStatus', 'tokenMatch', 'upstreamTaskPresent', 'variant'],
  );
});

test('host allowed-model policy matches wildcard, provider:model, and explicit deny-all semantics', () => {
  const node = {
    id: 'policy-node', type: 'batch-tagger', position: { x: 0, y: 0 },
    data: {
      batchTagProviderSource: 'openai-compatible',
      batchTagProviderId: 'provider-a',
      batchTagProviderModel: 'vision-model',
    },
  } as Node;
  const context = {
    providersComplete: true,
    providers: [{ id: 'provider-a', source: 'openai-compatible', enabled: true, models: { llm: ['vision-model'] } }],
  };
  for (const allowedModels of [['*'], ['provider-a:vision-model'], ['vision-model']]) {
    const issues = analyzeWorkflow([node], [], { ...context, limits: { allowedModels: [...allowedModels] } });
    assert.equal(issues.some((item) => item.id === 'host-model-policy-policy-node'), false);
  }
  const denied = analyzeWorkflow([node], [], { ...context, limits: { allowedModels: [] } });
  const issue = denied.find((item) => item.id === 'host-model-policy-policy-node');
  assert.ok(issue);
  assert.equal(issue.evidence.facts.allowedModelCount, 0);
});

test('model and cost multi-variant rules keep a stable evidence key contract', () => {
  const nodes: Node[] = [
    { id: 'host-model', type: 'image', position: { x: 0, y: 0 }, data: { prompt: 'x', providerSource: 'custom', providerId: 'host', providerModel: 'blocked' } },
    { id: 'provider-model', type: 'image', position: { x: 100, y: 0 }, data: { prompt: 'x', providerSource: 'custom', providerId: 'provider', providerModel: 'wrong' } },
  ];
  const modelIssues = analyzeWorkflow(nodes, [], {
    providersComplete: true,
    providers: [
      { id: 'host', source: 'custom', enabled: true, models: { image: ['blocked'] } },
      { id: 'provider', source: 'custom', enabled: true, models: { image: ['allowed'] } },
    ],
    limits: { allowedModels: ['host:other', 'provider:wrong'] },
  }).filter((item) => item.ruleId === 'model.capability-mismatch');
  assert.equal(modelIssues.length, 2);
  assert.deepEqual(
    modelIssues.map((item) => Object.keys(item.evidence.facts).sort()),
    Array.from({ length: 2 }, () => [
      'allowedModelCount', 'configured', 'enabled', 'kind', 'nodeId', 'policy', 'providerId', 'selectedModel', 'source', 'variant',
    ]),
  );

  const costIssues = analyzeWorkflow([], [], {
    limits: { estimatedCost: 12, costBudget: 10, dailyCost: 20, dailyCostLimit: 20 },
  }).filter((item) => item.ruleId === 'limits.cost-budget-exceeded');
  assert.equal(costIssues.length, 2);
  assert.deepEqual(
    costIssues.map((item) => Object.keys(item.evidence.facts).sort()),
    Array.from({ length: 2 }, () => [
      'atCapacity', 'costBudget', 'dailyCost', 'dailyCostLimit', 'estimatedCost', 'excess', 'projectedDailyCost', 'variant',
    ]),
  );
});

test('automatic patches reject stale previews while keeping preconditions out of JSON', () => {
  const nodes: Node[] = [
    { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { text: 'a' } },
    { id: 'b', type: 'text', position: { x: 100, y: 0 }, data: { text: 'b' } },
    { id: 'c', type: 'text', position: { x: 200, y: 0 }, data: { text: 'c' } },
  ];
  const edges: Edge[] = [
    { id: 'kept', source: 'a', target: 'b' },
    { id: 'candidate', source: 'a', target: 'b' },
  ];
  const patch = analyzeWorkflow(nodes, edges).find((item) => item.ruleId === 'topology.duplicate-edge')?.patch;
  assert.ok(patch);
  const operation = patch!.operations[0];
  assert.equal(operation.type, 'edge.delete');
  assert.ok(operation.type === 'edge.delete' && operation.expectedEdge);
  assert.doesNotMatch(JSON.stringify(patch), /expectedEdge|"source":"a"/);
  const changed = edges.map((edge) => edge.id === 'candidate' ? { ...edge, target: 'c' } : edge);
  assert.throws(() => applyCanvasPatch(nodes, changed, patch!), /修复预览已过期/);

  const badPosition = { id: 'position', type: 'text', position: { x: Number.NaN, y: 0 }, data: { text: 'x' } } as Node;
  const positionPatch = analyzeWorkflow([badPosition], []).find((item) => item.ruleId === 'layout.invalid-position')?.patch;
  assert.ok(positionPatch);
  assert.throws(() => applyCanvasPatch([{ ...badPosition, position: { x: 12, y: 0 } }], [], positionPatch!), /修复预览已过期/);
});

test('one automatic repair may leave unrelated pre-existing dangling edges without creating new ones', () => {
  const node = { id: 'target', type: 'text', position: { x: 0, y: 0 }, data: { text: 'x' } } as Node;
  const edges: Edge[] = [
    { id: 'lost-one', source: 'missing-one', target: 'target' },
    { id: 'lost-two', source: 'missing-two', target: 'target' },
  ];
  const patch = analyzeWorkflow([node], edges).find((item) => item.id === 'dangling-edge-lost-one')?.patch;
  assert.ok(patch);
  const result = applyCanvasPatch([node], edges, patch!);
  assert.deepEqual(result.edges.map((edge) => edge.id), ['lost-two']);
});

test('canvas agent gives explicit only/except scopes priority over all-language', () => {
  const nodes: Node[] = [
    { id: 'bad-position', type: 'text', position: { x: Number.NaN, y: 0 }, data: { text: 'a' } },
    { id: 'target', type: 'text', position: { x: 100, y: 0 }, data: { text: 'b' } },
  ];
  const edges: Edge[] = [
    { id: 'duplicate-one', source: 'bad-position', target: 'target' },
    { id: 'duplicate-two', source: 'bad-position', target: 'target' },
    { id: 'dangling', source: 'bad-position', target: 'missing' },
  ];
  const issues = analyzeWorkflow(nodes, edges);
  const onlyDuplicate = planCanvasAgentRequest('不要修复所有问题，只修复重复连线', issues);
  assert.deepEqual(onlyDuplicate?.operations.map((operation) => 'edgeId' in operation ? operation.edgeId : operation.nodeId), ['duplicate-two']);

  for (const prompt of ['不要修复节点位置以外的问题', '不要修改除节点坐标之外的任何内容']) {
    const onlyPosition = planCanvasAgentRequest(prompt, issues);
    assert.ok(onlyPosition?.operations.length);
    assert.ok(onlyPosition!.operations.every((operation) => operation.type === 'node.patch'));
  }

  for (const prompt of ['修复全部，除了重复连线', '修复除了重复连线之外的所有问题', '修复全部，重复连线除外']) {
    const exceptDuplicate = planCanvasAgentRequest(prompt, issues);
    assert.ok(exceptDuplicate?.operations.length);
    assert.equal(exceptDuplicate!.operations.some((operation) => operation.type === 'edge.delete' && operation.edgeId === 'duplicate-two'), false);
    assert.ok(exceptDuplicate!.operations.some((operation) => operation.type === 'node.patch'));
  }

  const exceptPosition = planCanvasAgentRequest('修复所有问题，节点坐标除外', issues);
  assert.ok(exceptPosition?.operations.length);
  assert.equal(exceptPosition!.operations.some((operation) => operation.type === 'node.patch'), false);
});
