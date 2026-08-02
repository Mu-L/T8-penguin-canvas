const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CANVAS_AGENT_REMOTE_TOOLS,
  CanvasAgentToolError,
  executeCanvasAgentTool,
} = require('../backend/src/services/canvasAgentTools');
const { digestAgentResult } = require('../backend/src/services/canvasAgentPublicView');
const nodeSchemaManifest = require('../backend/src/shared/canvasNodeSchema.json');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function definition(overrides = {}) {
  return {
    id: 'flow-a', version: 2, revision: 3, projectId: 'project-a', name: '图像流程', description: 'safe', category: '图像', tags: ['图像'],
    nodes: [{ id: 'inside', type: 'text', position: { x: 0, y: 0 }, data: { text: '' } }], edges: [], inputs: [], outputs: [],
    exposedParameters: [], requiredCapabilities: [], assetRefs: [],
    ...overrides,
  };
}

function createDatabase(overrides = {}) {
  const document = overrides.document || {
    schema: 't8-canvas-document', schemaVersion: 2, projectId: 'project-a', canvasId: 'canvas-a', revision: 4,
    nodes: [
      { id: 'text-a', type: 'text', position: { x: 0, y: 0 }, data: { text: 'not projected', aggregateParserCookie: 'cookie-secret' } },
      { id: 'image-a', type: 'image', position: { x: 300, y: 0 }, data: { model: 'gpt-image-2' } },
    ],
    edges: [{ id: 'edge-a', source: 'text-a', target: 'image-a' }], viewport: { x: 0, y: 0, zoom: 1 },
  };
  let changes = 0;
  let assetSubject = null;
  const safeDefinition = definition();
  const run = {
    id: 'run-a', projectId: 'project-a', canvasId: 'canvas-a', canvasRevision: 4, status: 'failed', initiatorId: 'member-a',
    summary: { localPath: 'C:\\Users\\alice\\private.txt', apiKey: 'plainSecretValue123456' }, createdAt: 10,
  };
  const database = {
    get totalChanges() { return changes; },
    get assetSubject() { return assetSubject; },
    getCanvas: () => clone(document),
    listAccessibleAssets(filters, subject) {
      assetSubject = clone(subject);
      assert.equal(filters.projectId, 'project-a');
      return [{ id: 'asset-a', projectId: 'project-a', kind: 'image', filename: 'poster.png', storageMode: 'managed', availability: 'available', tags: ['safe'], metadata: { width: 100, height: 100, sourcePath: '/home/alice/private.png' }, createdAt: 1, updatedAt: 2 }];
    },
    countAccessibleAssets: () => 1,
    listSubflowDefinitions: ({ projectId }) => projectId === 'project-a' ? [safeDefinition, definition({ id: 'leaky', apiKey: 'plainCredentialValue123456' })] : [],
    getSubflowDefinition: (id, version, projectId) => id === safeDefinition.id && Number(version) === safeDefinition.version && projectId === 'project-a' ? clone(safeDefinition) : null,
    listRuns: () => [clone(run)],
    getRun: (id) => id === run.id ? clone(run) : null,
    listNodeRuns: () => [{ id: 'node-run-a', nodeId: 'image-a', originalNodeId: 'image-a', status: 'failed', outputRefs: [], createdAt: 10, updatedAt: 20 }],
    listRunAttempts: () => [{
      id: 'attempt-a', attemptNumber: 1, status: 'failed', provider: 'safe-provider', model: 'safe-model',
      nodeRunId: 'node-run-a',
      upstreamTaskId: 'private-task-123', requestId: 'private-request-456',
      usage: { input: 1, sourcePath: '/root/private' },
      metadata: { recovery: { url: 'https://provider.invalid/task/private-task-123', token: 'plainSecretValue123456' } },
      error: { code: 'E_FAIL', message: 'failed at C:\\Users\\alice\\private.txt', retryable: false }, createdAt: 10, updatedAt: 20,
    }],
    getExecutionPolicy: () => ({ concurrencyLimit: 2, perRunCostLimit: 0, dailyCostLimit: 0, allowedModels: ['*'], updatedAt: 2 }),
    getExecutionUsage: () => ({ activeCount: 1 }),
    mutateForTest() { changes += 1; },
    ...overrides,
  };
  return database;
}

function request(tool, input = {}, suffix = tool) {
  return { tool, requestId: `request-${suffix}`, projectId: 'project-a', canvasId: 'canvas-a', input };
}

function withoutDigest(result) {
  const copy = { ...result };
  delete copy.digest;
  return copy;
}

function executionProposal(nodes, edges, baseRevision = 4) {
  return {
    schema: 't8-canvas-agent-execution-proposal-v1',
    baseRevision,
    operations: [
      ...nodes.map((node) => ({ type: 'node.add', node })),
      ...edges.map((edge) => ({ type: 'edge.add', edge })),
    ],
  };
}

test('allowlist is exactly eight tools and rejects write, filesystem, shell, and unknown request fields', () => {
  assert.deepEqual(CANVAS_AGENT_REMOTE_TOOLS, [
    'inspectCanvas', 'inspectNodeSchema', 'inspectRun', 'searchAssets',
    'searchSubflows', 'validateCanvas', 'simulateExecutionPlan', 'estimateRun',
  ]);
  const database = createDatabase();
  for (const tool of ['applyPatch', 'readFile', 'shell', 'zustand', 'dom']) {
    assert.throws(() => executeCanvasAgentTool(database, request(tool)), (error) => error instanceof CanvasAgentToolError && error.code === 'agent_tool_forbidden' && error.status === 403);
  }
  assert.throws(() => executeCanvasAgentTool(database, { ...request('inspectCanvas'), extra: true }), /未定义字段/);
  assert.throws(() => executeCanvasAgentTool(database, request('inspectCanvas', { arbitrary: true })), /未定义字段/);
});

test('strict input protocol rejects coercion, negative offsets, unsafe query text, and invalid kinds', () => {
  const database = createDatabase();
  assert.throws(() => executeCanvasAgentTool(database, request('inspectCanvas', { nodeLimit: '10' })), /无效/);
  assert.throws(() => executeCanvasAgentTool(database, request('inspectNodeSchema', { includeHidden: 'true' })), /无效/);
  assert.throws(() => executeCanvasAgentTool(database, request('searchAssets', { offset: -1 })), /无效/);
  assert.throws(() => executeCanvasAgentTool(database, request('searchAssets', { query: 'C:\\Users\\alice\\secret.txt' })), /不可公开内容/);
  assert.throws(() => executeCanvasAgentTool(database, request('searchSubflows', { query: 'sk-testSecret123456789' })), /不可公开内容/);
  assert.throws(() => executeCanvasAgentTool(database, request('searchAssets', { kind: 'executable' })), /白名单/);
  assert.throws(() => executeCanvasAgentTool(database, request('inspectRun', { validationTrusted: true })), /未定义字段/);
  assert.throws(() => executeCanvasAgentTool(database, request('inspectRun', { validation: {} })), /未定义字段/);
});

test('all eight tools return a fixed read-only scoped envelope without database changes', () => {
  const database = createDatabase();
  const before = database.totalChanges;
  const inputs = {
    inspectCanvas: { nodeLimit: 100, edgeLimit: 200 },
    inspectNodeSchema: { limit: 100, includeHidden: false },
    inspectRun: {},
    searchAssets: { query: '图像', kind: 'image', limit: 10, offset: 0 },
    searchSubflows: { query: '图像', limit: 10, offset: 0 },
    validateCanvas: {},
    simulateExecutionPlan: {},
    estimateRun: {},
  };
  for (const tool of CANVAS_AGENT_REMOTE_TOOLS) {
    const result = executeCanvasAgentTool(database, request(tool, inputs[tool]));
    assert.equal(result.schema, 't8-canvas-agent-tool-result-v1');
    assert.equal(result.tool, tool);
    assert.equal(result.projectId, 'project-a');
    assert.equal(result.canvasId, 'canvas-a');
    assert.equal(result.canvasRevision, 4);
    assert.equal(result.readOnly, true);
    assert.deepEqual(result.authority, {
      advisoryOnly: true,
      canPreviewCanvasPatch: true,
      canApplyCanvasPatch: false,
      canManageHostCredentials: false,
      credentialVisibility: 'configured-state-only',
    });
    assert.match(result.nodeSchemaDigest, /^[a-f0-9]{64}$/);
    assert.match(result.digest, /^[a-f0-9]{64}$/);
    assert.equal(result.digest, digestAgentResult(withoutDigest(result)));
  }
  assert.equal(database.totalChanges, before);
  assert.deepEqual(database.assetSubject, { memberId: 'local-owner', role: 'owner', permission: 'view' });
});

test('E4 authority keeps reviewers advisory-only, lets editors use only the existing graph patch path, and never manages host credentials', () => {
  const database = createDatabase();
  const reviewer = executeCanvasAgentTool(database, request('inspectRun'), {
    actorId: 'reviewer-a', role: 'reviewer', capabilities: ['comment', 'approve'],
  });
  assert.deepEqual(reviewer.authority, {
    advisoryOnly: true,
    canPreviewCanvasPatch: true,
    canApplyCanvasPatch: false,
    canManageHostCredentials: false,
    credentialVisibility: 'configured-state-only',
  });
  const misconfiguredReviewer = executeCanvasAgentTool(database, request('inspectRun', {}, 'misconfigured-reviewer'), {
    actorId: 'reviewer-misconfigured', role: 'reviewer', capabilities: ['comment', 'approve', 'editGraph'],
  });
  assert.deepEqual(misconfiguredReviewer.authority, {
    advisoryOnly: true,
    canPreviewCanvasPatch: true,
    canApplyCanvasPatch: false,
    canManageHostCredentials: false,
    credentialVisibility: 'configured-state-only',
  });
  const owner = executeCanvasAgentTool(database, request('inspectRun', {}, 'owner-with-edit'), {
    actorId: 'owner-a', role: 'owner', capabilities: ['editGraph', 'manageProviders'],
  });
  assert.deepEqual(owner.authority, {
    advisoryOnly: false,
    canPreviewCanvasPatch: true,
    canApplyCanvasPatch: true,
    canManageHostCredentials: false,
    credentialVisibility: 'configured-state-only',
  });
  const editorWithoutEdit = executeCanvasAgentTool(database, request('inspectRun', {}, 'editor-without-edit'), {
    actorId: 'editor-read-only', role: 'editor', capabilities: ['runWorkflow'],
  });
  assert.deepEqual(editorWithoutEdit.authority, {
    advisoryOnly: true,
    canPreviewCanvasPatch: true,
    canApplyCanvasPatch: false,
    canManageHostCredentials: false,
    credentialVisibility: 'configured-state-only',
  });
  const editor = executeCanvasAgentTool(database, request('inspectRun'), {
    actorId: 'editor-a', role: 'editor', capabilities: ['editGraph', 'runWorkflow'],
  });
  assert.deepEqual(editor.authority, {
    advisoryOnly: false,
    canPreviewCanvasPatch: true,
    canApplyCanvasPatch: true,
    canManageHostCredentials: false,
    credentialVisibility: 'configured-state-only',
  });
  assert.doesNotMatch(
    JSON.stringify([reviewer, misconfiguredReviewer, owner, editorWithoutEdit, editor]),
    /plainSecretValue123456|credentialValue123456|\*{4}[A-Za-z0-9]{4}/i,
  );
});

test('canvas, run, assets, and subflow projections redact values and never expose raw source objects', () => {
  const database = createDatabase();
  const results = [
    executeCanvasAgentTool(database, request('inspectCanvas')),
    executeCanvasAgentTool(database, request('inspectRun')),
    executeCanvasAgentTool(database, request('searchAssets', { query: '图像' })),
    executeCanvasAgentTool(database, request('searchSubflows', { query: '图像' })),
  ];
  const text = JSON.stringify(results);
  assert.doesNotMatch(text, /plainSecret|cookie-secret|C:\\Users|\/home\/alice|\/root\/private|sourceUrl|inputSnapshot|private-task|private-request|provider\.invalid|recovery/);
  const canvas = results[0].data;
  assert.deepEqual(Object.keys(canvas.nodes[0]).sort(), ['dataFields', 'id', 'position', 'type']);
  assert.equal(Object.hasOwn(canvas.nodes[0], 'data'), false);
  assert.equal(results[2].data.items[0].metadata, undefined);
  assert.deepEqual(results[3].data.items.map((item) => item.id), ['flow-a']);
  assert.equal(results[1].data.schema, 't8-run-evidence-inspection-v1');
  assert.deepEqual(results[1].data.selection, { runId: 'run-a', nodeRunId: null, attemptId: null });
  assert.deepEqual(results[1].data.totals, { nodeRuns: 1, attempts: 1 });
  assert.deepEqual(results[1].data.returned, { nodeRuns: 1, attempts: 1 });
  assert.deepEqual(results[1].data.hasMore, { nodeRuns: false, attempts: false });
  assert.equal(results[1].data.evidenceComplete, true);
  assert.equal(results[1].data.diagnosis.schema, 't8-run-evidence-diagnosis-v1');
  assert.deepEqual(results[1].data.diagnosis.findings[0], {
    id: 'node-run-a:attempt-a',
    ref: { runId: 'run-a', nodeRunId: 'node-run-a', attemptId: 'attempt-a' },
    runId: 'run-a',
    nodeRunId: 'node-run-a',
    attemptId: 'attempt-a',
    nodeId: 'image-a',
    attemptNumber: 1,
    status: 'failed',
    category: 'unknown',
    confidence: 'low',
    reasonCode: 'persisted_unknown_not_classifiable',
    summary: '持久化证据无法可靠分类',
    provider: 'safe-provider',
    model: 'safe-model',
    error: { kind: 'unknown', code: 'E_FAIL', httpStatus: null, retryable: false },
    timestamp: 20,
  });
  assert.doesNotMatch(JSON.stringify(results[1].data), /errorMessage|inputSnapshot|metadata|upstreamTask|requestId|recovery|sourceUrl/);
});

test('E4 Run findings redact provider/model/error injections and omit task, request, recovery, usage, and raw metadata', () => {
  const secret = 'sk-runEvidenceLeak123456789';
  const database = createDatabase({
    listRunAttempts: () => [{
      id: 'attempt-a', attemptNumber: 1, status: 'failed',
      nodeRunId: 'node-run-a',
      provider: secret,
      model: 'C:\\Users\\alice\\private-model.bin',
      upstreamTaskId: 'task-private-123',
      requestId: 'request-private-456',
      usage: { prompt: secret },
      metadata: { recovery: { url: `https://provider.invalid/tasks/1?token=${secret}` } },
      error: { kind: 'authentication', code: secret, message: `failed at C:\\Users\\alice\\private.txt`, retryable: false },
      createdAt: 10, updatedAt: 20,
    }],
  });
  const result = executeCanvasAgentTool(database, request('inspectRun'));
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /runEvidenceLeak|C:\\Users|private-model|task-private|request-private|provider\.invalid|"usage"|"metadata"|"recovery"|"message"/i);
  assert.equal(result.data.diagnosis.primaryCategory, 'configuration');
  assert.equal(result.data.diagnosis.findings[0].provider, '[redacted]');
  assert.match(result.data.diagnosis.findings[0].model, /local-path|redacted/i);
  assert.equal(result.data.diagnosis.findings[0].error.kind, 'authentication');
});

test('dynamic subflow schema ignores forged embedded ports and resolves the authoritative fixed project version', () => {
  const safe = definition({
    inputs: [{ id: 'real-input', name: '真实输入', kind: 'text', required: true, internalNodeId: 'inside' }],
    outputs: [{ id: 'real-output', name: '真实输出', kind: 'text', required: false, internalNodeId: 'inside' }],
  });
  const document = {
    projectId: 'project-a', canvasId: 'canvas-a', revision: 4, schemaVersion: 2,
    nodes: [{ id: 'sub-a', type: 'subflow', position: { x: 0, y: 0 }, data: { definitionId: safe.id, definitionVersion: safe.version, definition: { id: safe.id, version: safe.version, inputs: [{ id: 'forged', kind: 'image' }], outputs: [] } } }],
    edges: [],
  };
  const database = createDatabase({
    document,
    getSubflowDefinition: (id, version, projectId) => id === safe.id && Number(version) === safe.version && projectId === 'project-a' ? clone(safe) : null,
  });
  const result = executeCanvasAgentTool(database, request('inspectNodeSchema', { nodeId: 'sub-a' }));
  assert.deepEqual(result.data.item.ports.inputs.map((port) => port.id), ['real-input']);
  assert.deepEqual(result.data.item.ports.outputs.map((port) => port.id), ['real-output']);
  assert.doesNotMatch(JSON.stringify(result), /forged/);
});

test('subflow search never marks non-canonical or duplicate port identities safe for an Agent plan', () => {
  const unsafe = definition({
    id: 'unsafe-flow',
    inputs: [
      { id: 'same', name: 'A', kind: 'text' },
      { id: 'same', name: 'B', kind: 'image' },
    ],
  });
  const unicode = definition({ id: 'unicode-port-flow', inputs: [{ id: '输入', name: '输入', kind: 'text' }] });
  const database = createDatabase({ listSubflowDefinitions: () => [unsafe, unicode] });
  const items = executeCanvasAgentTool(database, request('searchSubflows', { query: '' }, 'unsafe-subflows')).data.items;
  assert.deepEqual(items.map((item) => [item.id, item.safeForPlan]), [
    ['unsafe-flow', false],
    ['unicode-port-flow', false],
  ]);
});

test('validation cannot hide a late error behind the 200-diagnostic response cap', () => {
  const nodes = [
    { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {} },
    { id: 'b', type: 'image', position: { x: 1, y: 0 }, data: {} },
  ];
  const edges = [];
  for (let index = 0; index < 202; index += 1) edges.push({ id: `duplicate-${index}`, source: 'a', target: 'b' });
  edges.push({ id: 'late-dangling', source: 'missing', target: 'b' });
  const database = createDatabase({ document: { projectId: 'project-a', canvasId: 'canvas-a', revision: 4, schemaVersion: 2, nodes, edges } });
  const validation = executeCanvasAgentTool(database, request('validateCanvas')).data;
  const simulation = executeCanvasAgentTool(database, request('simulateExecutionPlan')).data;
  assert.equal(validation.diagnostics.length, 200);
  assert.equal(validation.truncated, true);
  assert.equal(validation.valid, false);
  assert.equal(validation.totals.errors, 1);
  assert.equal(simulation.blocked, true);
});

test('proposal simulation is schema-bound and estimates never guess provider calls or price', () => {
  const database = createDatabase();
  const proposal = executionProposal([
      { id: 'prompt', type: 'text', position: { x: 0, y: 0 } },
      { id: 'image', type: 'image', position: { x: 300, y: 0 } },
      { id: 'output', type: 'output', position: { x: 600, y: 0 } },
    ], [
      { id: 'prompt-image', source: 'prompt', target: 'image' },
      { id: 'image-output', source: 'image', target: 'output' },
    ]);
  const simulation = executeCanvasAgentTool(database, request('simulateExecutionPlan', { proposal })).data;
  assert.equal(simulation.basis, 'post-patch-canvas');
  assert.match(simulation.proposalDigest, /^[a-f0-9]{64}$/);
  assert.equal(simulation.valid, true);
  assert.equal(simulation.blocked, false);
  const estimate = executeCanvasAgentTool(database, request('estimateRun', { proposal })).data;
  assert.deepEqual(estimate.providerCalls, { known: false, minimum: 0, maximum: null, reasonCode: 'provider_call_metadata_unavailable' });
  assert.deepEqual(estimate.cost, { known: false, currency: null, minimum: null, maximum: null, reasonCode: 'pricing_registry_unavailable' });
  assert.throws(() => executeCanvasAgentTool(database, request('simulateExecutionPlan', {
    proposal: executionProposal([{ id: 'x', type: 'codex-cli-agent', position: { x: 0, y: 0 } }], []),
  })), /不可生成/);
  const audioProposal = executionProposal([
      { id: 'audio', type: 'audio', position: { x: 0, y: 0 } },
      { id: 'output', type: 'output', position: { x: 300, y: 0 } },
    ], [{ id: 'audio-output', source: 'audio', target: 'output', sourceHandle: 'audio-0' }]);
  assert.equal(executeCanvasAgentTool(database, request('simulateExecutionPlan', { proposal: audioProposal })).data.valid, true);
  const missingHandle = executeCanvasAgentTool(database, request('simulateExecutionPlan', {
    proposal: executionProposal([
      { id: 'audio', type: 'audio', position: { x: 0, y: 0 } },
      { id: 'output', type: 'output', position: { x: 300, y: 0 } },
    ], [{ id: 'audio-output', source: 'audio', target: 'output' }]),
  }, 'missing-handle')).data;
  assert.equal(missingHandle.blocked, true);
  assert.ok(missingHandle.validation.diagnostics.some((item) => item.ruleId === 'ports.handle-unknown'));
  const unknownHandle = executeCanvasAgentTool(database, request('simulateExecutionPlan', {
    proposal: executionProposal([
      { id: 'audio', type: 'audio', position: { x: 0, y: 0 } },
      { id: 'output', type: 'output', position: { x: 300, y: 0 } },
    ], [{ id: 'audio-output', source: 'audio', target: 'output', sourceHandle: 'audio-missing' }]),
  }, 'unknown-handle')).data;
  assert.equal(unknownHandle.blocked, true);
  assert.ok(unknownHandle.validation.diagnostics.some((item) => item.ruleId === 'ports.handle-unknown'));
});

test('post-patch simulation keeps current errors, repairs deletes and positions in memory, and rejects collisions', () => {
  const invalidDocument = {
    schema: 't8-canvas-document', schemaVersion: 2, projectId: 'project-a', canvasId: 'canvas-a', revision: 4,
    nodes: [{ id: 'text-a', type: 'text', position: { x: Number.NaN, y: 0 }, data: {} }],
    edges: [{ id: 'dangling', source: 'missing', target: 'text-a' }], viewport: { x: 0, y: 0, zoom: 1 },
  };
  const database = createDatabase({ document: invalidDocument });
  const appendOnly = executionProposal([{ id: 'output-new', type: 'output', position: { x: 300, y: 0 } }], []);
  const stillInvalid = executeCanvasAgentTool(database, request('simulateExecutionPlan', { proposal: appendOnly }, 'append-invalid')).data;
  assert.equal(stillInvalid.basis, 'post-patch-canvas');
  assert.equal(stillInvalid.valid, false);
  assert.equal(stillInvalid.blocked, true);

  const repair = {
    schema: 't8-canvas-agent-execution-proposal-v1', baseRevision: 4,
    operations: [
      { type: 'edge.delete', edgeId: 'dangling' },
      { type: 'node.patch', nodeId: 'text-a', position: { x: 0, y: 0 } },
    ],
  };
  const repaired = executeCanvasAgentTool(database, request('simulateExecutionPlan', { proposal: repair }, 'repair')).data;
  assert.equal(repaired.valid, true);
  assert.equal(repaired.blocked, false);
  assert.equal(database.totalChanges, 0);
  assert.throws(
    () => executeCanvasAgentTool(database, request('simulateExecutionPlan', {
      proposal: executionProposal([{ id: 'text-a', type: 'text', position: { x: 0, y: 0 } }], []),
    }, 'collision')),
    (error) => error.code === 'agent_execution_plan_invalid' && error.status === 422,
  );
});

test('authoritative exact ports reject unknown handles and enforce required subflow inputs', () => {
  const invalidHandleDocument = {
    schema: 't8-canvas-document', schemaVersion: 2, projectId: 'project-a', canvasId: 'canvas-a', revision: 4,
    nodes: [
      { id: 'audio-a', type: 'audio', position: { x: 0, y: 0 }, data: {} },
      { id: 'output-a', type: 'output', position: { x: 300, y: 0 }, data: {} },
    ],
    edges: [{ id: 'bad-handle', source: 'audio-a', target: 'output-a', sourceHandle: 'audio-does-not-exist' }],
  };
  const invalidHandle = executeCanvasAgentTool(createDatabase({ document: invalidHandleDocument }), request('validateCanvas')).data;
  assert.equal(invalidHandle.valid, false);
  assert.ok(invalidHandle.diagnostics.some((item) => item.ruleId === 'ports.handle-unknown'));

  const required = definition({
    inputs: [{ id: 'prompt-in', name: '提示词', kind: 'text', required: true, minConnections: 1, internalNodeId: 'inside' }],
  });
  const requiredDatabase = createDatabase({
    getSubflowDefinition: (id, version, projectId) => id === required.id && Number(version) === required.version && projectId === 'project-a' ? clone(required) : null,
  });
  const isolated = executionProposal([{
    id: 'subflow-a', type: 'subflow', position: { x: 0, y: 0 },
    subflowRef: { definitionId: required.id, version: required.version, revision: required.revision },
  }], []);
  const blocked = executeCanvasAgentTool(requiredDatabase, request('simulateExecutionPlan', { proposal: isolated }, 'required-isolated')).data;
  assert.equal(blocked.valid, false);
  assert.ok(blocked.validation.diagnostics.some((item) => item.ruleId === 'ports.required-input-missing'));
  const connected = executionProposal([
    { id: 'prompt-a', type: 'text', position: { x: 0, y: 0 } },
    {
      id: 'subflow-a', type: 'subflow', position: { x: 300, y: 0 },
      subflowRef: { definitionId: required.id, version: required.version, revision: required.revision },
    },
  ], [{ id: 'prompt-subflow', source: 'prompt-a', target: 'subflow-a', targetHandle: 'prompt-in' }]);
  assert.equal(executeCanvasAgentTool(requiredDatabase, request('simulateExecutionPlan', { proposal: connected }, 'required-connected')).data.valid, true);
});

test('E5 authoritative validation detects recursive fixed-version subflow dependencies and keeps shared DAGs valid', () => {
  const nestedNode = (id, definitionId, version = 1) => ({
    id,
    type: 'subflow',
    position: { x: 0, y: 0 },
    data: { definitionId, definitionVersion: version, definitionProjectId: 'project-a' },
  });
  const flow = (id, nodes = []) => definition({
    id,
    version: 1,
    revision: 1,
    nodes,
    edges: [],
    inputs: [],
    outputs: [],
  });
  const definitions = new Map([
    ['root\u00001', flow('root', [nestedNode('root-to-child', 'child')])],
    ['child\u00001', flow('child', [nestedNode('child-to-leaf', 'leaf')])],
    ['leaf\u00001', flow('leaf', [nestedNode('leaf-to-child', 'child')])],
  ]);
  const document = {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: 'project-a',
    canvasId: 'canvas-a',
    revision: 4,
    nodes: [nestedNode('root-instance', 'root')],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const batches = [];
  const recursiveDatabase = createDatabase({
    document,
    getSubflowDefinitionsByRefs(refs, projectId) {
      assert.equal(projectId, 'project-a');
      batches.push(clone(refs));
      return refs.map((ref) => definitions.get(`${ref.id}\u0000${ref.version}`)).filter(Boolean).map(clone);
    },
    getSubflowDefinition() {
      throw new Error('recursive validation must use bounded batch dependency loading');
    },
  });
  const validation = executeCanvasAgentTool(recursiveDatabase, request('validateCanvas', {}, 'recursive-subflow')).data;
  const recursiveCycle = validation.diagnostics.find((item) => (
    item.ruleId === 'topology.cycle' && item.facts?.variant === 'subflow-dependency'
  ));
  assert.ok(recursiveCycle);
  assert.equal(validation.valid, false);
  assert.deepEqual(recursiveCycle.facts.rootRefs, ['root@1']);
  assert.deepEqual(recursiveCycle.facts.cycleRefs, ['child@1', 'leaf@1', 'child@1']);
  assert.deepEqual(batches, [
    [{ id: 'root', version: 1 }],
    [{ id: 'child', version: 1 }],
    [{ id: 'leaf', version: 1 }],
  ]);
  const simulation = executeCanvasAgentTool(recursiveDatabase, request('simulateExecutionPlan', {}, 'recursive-simulation')).data;
  assert.equal(simulation.blocked, true);
  assert.equal(simulation.reasonCode, 'canvas_validation_failed');

  const sharedDefinitions = new Map([
    ['root\u00001', flow('root', [
      nestedNode('root-to-left', 'left'),
      nestedNode('root-to-right', 'right'),
    ])],
    ['left\u00001', flow('left', [nestedNode('left-to-shared', 'shared')])],
    ['right\u00001', flow('right', [nestedNode('right-to-shared', 'shared')])],
    ['shared\u00001', flow('shared', [{ id: 'inside', type: 'text', position: { x: 0, y: 0 }, data: { text: 'ok' } }])],
  ]);
  const shared = executeCanvasAgentTool(createDatabase({
    document,
    getSubflowDefinitionsByRefs(refs) {
      return refs.map((ref) => sharedDefinitions.get(`${ref.id}\u0000${ref.version}`)).filter(Boolean).map(clone);
    },
  }), request('validateCanvas', {}, 'shared-subflow-dag')).data;
  assert.equal(shared.diagnostics.some((item) => (
    item.ruleId === 'topology.cycle' && item.facts?.variant === 'subflow-dependency'
  )), false);
});

test('all 71 production node instances resolve one authoritative connection contract', () => {
  const safe = definition();
  const dynamicData = {
    upload: { uploadType: 'image' },
    'material-set': { materialSetKind: 'image', materialSetItems: [{ id: 'm1', kind: 'image', url: '/files/input/a.png' }] },
    loop: { kind: 'video' },
    'pick-from-set': { pickKind: 'audio' },
    'random-route': { randomRouteTotalOutputs: 3 },
    subflow: { definitionId: safe.id, definitionVersion: safe.version, definition: { inputs: [{ id: 'forged', kind: 'image' }] } },
    cinematic: { kind: 'cinematic' },
    'video-motion': { kind: 'video-motion' },
    'multi-angle-visual': { kind: 'multi-angle-visual' },
  };
  const nodes = nodeSchemaManifest.types.map((item, index) => ({
    id: `node-${item.type}`,
    type: item.type,
    position: { x: index * 10, y: 0 },
    data: dynamicData[item.type] || {},
  }));
  const document = {
    schema: 't8-canvas-document', schemaVersion: 2, projectId: 'project-a', canvasId: 'canvas-a', revision: 4,
    nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  };
  const database = createDatabase({
    document,
    getSubflowDefinition: (id, version, projectId) => id === safe.id && Number(version) === safe.version && projectId === safe.projectId ? clone(safe) : null,
  });
  assert.equal(nodeSchemaManifest.types.length, 71);
  assert.equal(Object.keys(nodeSchemaManifest.connectionPorts).length, 71);
  const validation = executeCanvasAgentTool(database, request('validateCanvas', {}, 'all-contracts')).data;
  assert.equal(validation.diagnostics.some((item) => item.ruleId === 'ports.contract-unresolved'), false);
  for (const node of nodes) {
    const inspected = executeCanvasAgentTool(database, request('inspectNodeSchema', { nodeId: node.id }, `inspect-${node.type}`)).data.item;
    assert.equal(inspected.type, node.type);
    assert.ok(Array.isArray(inspected.ports.inputs));
    assert.ok(Array.isArray(inspected.ports.outputs));
  }
});

test('static named and null handles plus dynamic resolvers fail closed without aggregate fallbacks', () => {
  const validate = (nodes, edges, overrides = {}) => executeCanvasAgentTool(createDatabase({
    document: {
      schema: 't8-canvas-document', schemaVersion: 2, projectId: 'project-a', canvasId: 'canvas-a', revision: 4,
      nodes, edges, viewport: { x: 0, y: 0, zoom: 1 },
    },
    ...overrides,
  }), request('validateCanvas', {}, 'ports-check')).data;
  const positioned = (id, type, data = {}, x = 0) => ({ id, type, position: { x, y: 0 }, data });
  const output = positioned('out', 'output', {}, 300);

  for (const [source, sourceHandle] of [
    [positioned('tagger', 'batch-tagger'), 'video'],
    [positioned('text', 'text'), 'text'],
    [positioned('audio', 'audio'), null],
  ]) {
    const result = validate([source, output], [{ id: `bad-${source.id}`, source: source.id, target: output.id, sourceHandle }]);
    assert.ok(result.diagnostics.some((item) => item.ruleId === 'ports.handle-unknown'));
  }
  const noInput = validate(
    [positioned('text', 'text'), positioned('bp', 'bp', {}, 300)],
    [{ id: 'bp-has-no-target', source: 'text', target: 'bp' }],
  );
  assert.ok(noInput.diagnostics.some((item) => item.ruleId === 'ports.handle-unknown'));

  const routeValid = validate(
    [positioned('route', 'random-route', { total_outputs: 3 }), output],
    [{ id: 'route-3', source: 'route', target: 'out', sourceHandle: 'output_3' }],
  );
  assert.equal(routeValid.valid, true);
  const routeInvalid = validate(
    [positioned('route', 'random-route', { total_outputs: 3 }), output],
    [{ id: 'route-4', source: 'route', target: 'out', sourceHandle: 'output_4' }],
  );
  assert.ok(routeInvalid.diagnostics.some((item) => item.ruleId === 'ports.handle-unknown'));

  const emptyUpload = validate(
    [positioned('upload', 'upload'), output],
    [{ id: 'empty-upload', source: 'upload', target: 'out' }],
  );
  assert.ok(emptyUpload.diagnostics.some((item) => item.ruleId === 'ports.type-incompatible'));
  const emptyUploadDatabase = createDatabase({
    document: {
      schema: 't8-canvas-document', schemaVersion: 2, projectId: 'project-a', canvasId: 'canvas-a', revision: 4,
      nodes: [positioned('upload', 'upload')], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    },
  });
  const emptyUploadSchema = executeCanvasAgentTool(
    emptyUploadDatabase,
    request('inspectNodeSchema', { nodeId: 'upload' }, 'inspect-empty-upload'),
  ).data.item.ports;
  assert.deepEqual(emptyUploadSchema.outputs.map((port) => ({ id: port.id, kinds: port.kinds })), [{ id: null, kinds: [] }]);
  const imageUpload = validate(
    [positioned('upload', 'upload', { uploadType: 'image' }), output],
    [{ id: 'image-upload', source: 'upload', target: 'out' }],
  );
  assert.equal(imageUpload.valid, true);

  const wrongToolbox = validate([positioned('motion', 'video-motion', { kind: 'cinematic' })], []);
  assert.ok(wrongToolbox.diagnostics.some((item) => item.ruleId === 'ports.contract-unresolved'));
  const dirtyMaterial = validate(
    [positioned('set', 'material-set', { materialSetKind: 'image', materialSetItems: [{ kind: 'video', url: '/files/input/a.mp4' }] }), output],
    [{ id: 'dirty-set', source: 'set', target: 'out' }],
  );
  assert.ok(dirtyMaterial.diagnostics.some((item) => item.ruleId === 'ports.type-incompatible'));
});

test('persisted groupBox uses its internal exact port contract without becoming a public generatable node', () => {
  const document = {
    schema: 't8-canvas-document', schemaVersion: 2, projectId: 'project-a', canvasId: 'canvas-a', revision: 4,
    nodes: [
      { id: 'group', type: 'groupBox', position: { x: 0, y: 0 }, data: {} },
      { id: 'out', type: 'output', position: { x: 300, y: 0 }, data: {} },
    ],
    edges: [{ id: 'group-edge', source: 'group', target: 'out', sourceHandle: 'group-out' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const database = createDatabase({ document });
  const validation = executeCanvasAgentTool(database, request('validateCanvas', {}, 'group-box')).data;
  assert.equal(validation.valid, true);
  assert.equal(validation.diagnostics.some((item) => item.ruleId === 'registry.unknown-node-type'), false);

  const inspected = executeCanvasAgentTool(
    database,
    request('inspectNodeSchema', { nodeId: 'group' }, 'inspect-group-box'),
  ).data.item;
  assert.equal(inspected.type, 'groupBox');
  assert.equal(inspected.hidden, true);
  assert.equal(inspected.generatable, false);
  assert.deepEqual(inspected.ports.inputs, []);
  assert.deepEqual(inspected.ports.outputs.map((port) => ({ id: port.id, kinds: port.kinds })), [
    { id: 'group-out', kinds: ['any'] },
  ]);

  const invalid = createDatabase({
    document: { ...document, edges: [{ ...document.edges[0], sourceHandle: null }] },
  });
  const invalidValidation = executeCanvasAgentTool(invalid, request('validateCanvas', {}, 'group-box-invalid')).data;
  assert.ok(invalidValidation.diagnostics.some((item) => item.ruleId === 'ports.handle-unknown'));

  assert.equal(nodeSchemaManifest.types.some((item) => item.type === 'groupBox'), false);
  assert.equal(Object.hasOwn(nodeSchemaManifest.connectionPorts, 'groupBox'), false);
  assert.throws(
    () => executeCanvasAgentTool(database, request('simulateExecutionPlan', {
      proposal: executionProposal([
        { id: 'group-new', type: 'groupBox', position: { x: 500, y: 0 } },
      ], []),
    }, 'generate-group-box')),
    (error) => error instanceof CanvasAgentToolError
      && error.code === 'agent_node_type_forbidden'
      && error.status === 403,
  );
});

test('persisted development toolbox makers validate without becoming public generatable nodes', () => {
  for (const type of ['rh-toolbox-maker', 'fal-toolbox-maker']) {
    const document = {
      schema: 't8-canvas-document',
      schemaVersion: 2,
      projectId: 'project-a',
      canvasId: 'canvas-a',
      revision: 4,
      nodes: [
        { id: 'maker', type, position: { x: 0, y: 0 }, data: {} },
        { id: 'out', type: 'output', position: { x: 300, y: 0 }, data: {} },
      ],
      edges: [{ id: 'maker-edge', source: 'maker', target: 'out' }],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const database = createDatabase({ document });
    const validation = executeCanvasAgentTool(database, request('validateCanvas', {}, `validate-${type}`)).data;
    assert.equal(validation.valid, true);
    assert.equal(validation.diagnostics.some((item) => item.ruleId === 'registry.unknown-node-type'), false);

    const inspected = executeCanvasAgentTool(
      database,
      request('inspectNodeSchema', { nodeId: 'maker' }, `inspect-${type}`),
    ).data.item;
    assert.equal(inspected.type, type);
    assert.equal(inspected.hidden, true);
    assert.equal(inspected.generatable, false);
    assert.deepEqual(inspected.ports.outputs.map((port) => ({ id: port.id, kinds: port.kinds })), [
      { id: null, kinds: ['text'] },
    ]);

    assert.equal(nodeSchemaManifest.types.some((item) => item.type === type), false);
    assert.throws(
      () => executeCanvasAgentTool(database, request('simulateExecutionPlan', {
        proposal: executionProposal([
          { id: 'maker-new', type, position: { x: 500, y: 0 } },
        ], []),
      }, `generate-${type}`)),
      (error) => error instanceof CanvasAgentToolError
        && error.code === 'agent_node_type_forbidden'
        && error.status === 403,
    );
  }
});

test('subflow contracts ignore embedded data and reject duplicate authoritative port ids', () => {
  const duplicate = definition({
    inputs: [
      { id: 'same', name: 'A', kind: 'text' },
      { id: 'same', name: 'B', kind: 'image' },
    ],
  });
  const document = {
    schema: 't8-canvas-document', schemaVersion: 2, projectId: 'project-a', canvasId: 'canvas-a', revision: 4,
    nodes: [{
      id: 'sub', type: 'subflow', position: { x: 0, y: 0 },
      data: { definitionId: duplicate.id, definitionVersion: duplicate.version, definition: { inputs: [{ id: 'forged', kind: 'text' }] } },
    }],
    edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  };
  const database = createDatabase({
    document,
    getSubflowDefinition: (id, version, projectId) => id === duplicate.id && Number(version) === duplicate.version && projectId === duplicate.projectId ? clone(duplicate) : null,
  });
  const validation = executeCanvasAgentTool(database, request('validateCanvas', {}, 'duplicate-subflow-ports')).data;
  assert.ok(validation.diagnostics.some((item) => item.ruleId === 'ports.contract-unresolved'));
  assert.throws(
    () => executeCanvasAgentTool(database, request('inspectNodeSchema', { nodeId: 'sub' }, 'inspect-duplicate-subflow')),
    (error) => error.code === 'agent_node_schema_unresolved' && error.status === 422,
  );
});

test('revision TOCTOU changes fail with 409 and oversized responses remain self-verifying', () => {
  const document = { projectId: 'project-a', canvasId: 'canvas-a', revision: 4, schemaVersion: 2, nodes: [], edges: [] };
  let reads = 0;
  const changing = createDatabase({ getCanvas: () => ({ ...clone(document), revision: ++reads === 1 ? 4 : 5 }) });
  assert.throws(() => executeCanvasAgentTool(changing, request('inspectCanvas')), (error) => error.code === 'agent_snapshot_changed' && error.status === 409);

  const data = {};
  for (let index = 0; index < 50; index += 1) data[`field_${String(index).padStart(3, '0')}_${'x'.repeat(90)}`] = 'not-projected';
  const large = createDatabase({
    document: {
      ...document,
      nodes: Array.from({ length: 100 }, (_, index) => ({ id: `node-${index}`, type: 'text', position: { x: index, y: 0 }, data })),
      edges: [],
    },
  });
  const result = executeCanvasAgentTool(large, request('inspectCanvas', { nodeLimit: 100, edgeLimit: 200 }));
  assert.equal(result.truncated, true);
  assert.equal(result.data.omitted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 64 * 1024);
  assert.equal(result.digest, digestAgentResult(withoutDigest(result)));
});

test('E4 inspectRun forwards exact selectors and a 64 KiB downgrade remains an explicit insufficient diagnosis', () => {
  let selectedInput = null;
  const run = {
    id: 'run-exact', projectId: 'project-a', canvasId: 'canvas-a', canvasRevision: 4,
    status: 'failed', initiatorId: 'member-a', summary: {}, createdAt: 1, finishedAt: 2,
  };
  const exactNode = { id: 'node-run-exact', nodeId: 'image-a', status: 'failed', outputRefs: [], createdAt: 1, updatedAt: 2 };
  const exactAttempt = {
    id: 'attempt-exact', attemptNumber: 7, status: 'failed', provider: 'provider-a', model: 'model-a',
    error: { kind: 'network', code: 'ETIMEDOUT', retryable: true }, createdAt: 1, updatedAt: 2,
  };
  const exactDatabase = createDatabase({
    getRunEvidence(input) {
      selectedInput = clone(input);
      return {
        run,
        selection: { runId: run.id, nodeRunId: exactNode.id, attemptId: exactAttempt.id },
        totals: { nodeRuns: 1, attempts: 1 }, returned: { nodeRuns: 1, attempts: 1 },
        hasMore: { nodeRuns: false, attempts: false }, evidenceComplete: true, evidenceReasons: [],
        nodeRuns: [exactNode], attemptsByNodeId: new Map([[exactNode.id, [exactAttempt]]]),
      };
    },
  });
  const exact = executeCanvasAgentTool(exactDatabase, request('inspectRun', {
    runId: run.id, nodeRunId: exactNode.id, attemptId: exactAttempt.id,
  }, 'exact-evidence'));
  assert.deepEqual(selectedInput, {
    projectId: 'project-a', canvasId: 'canvas-a', runId: 'run-exact',
    nodeRunId: 'node-run-exact', attemptId: 'attempt-exact', nodeLimit: 50, attemptLimit: 3,
  });
  assert.deepEqual(exact.data.selection, { runId: 'run-exact', nodeRunId: 'node-run-exact', attemptId: 'attempt-exact' });
  assert.equal(exact.data.evidenceComplete, true);
  assert.deepEqual(exact.data.diagnosis.findings[0].ref, {
    runId: 'run-exact', nodeRunId: 'node-run-exact', attemptId: 'attempt-exact',
  });

  const wide = 'x'.repeat(200);
  const nodeRuns = Array.from({ length: 50 }, (_, nodeIndex) => ({
    id: `node-run-${nodeIndex}`, nodeId: `image-${nodeIndex}`, status: 'failed', outputRefs: [], createdAt: 1, updatedAt: 2,
  }));
  const attemptsByNodeId = new Map(nodeRuns.map((nodeRun, nodeIndex) => [
    nodeRun.id,
    Array.from({ length: 3 }, (_, attemptIndex) => ({
      id: `attempt-${nodeIndex}-${attemptIndex}`, attemptNumber: attemptIndex + 1, status: 'failed',
      provider: `provider-${wide}`, model: `model-${wide}`,
      error: { kind: 'network', code: `ETIMEDOUT-${wide}`, retryable: true }, createdAt: 1, updatedAt: 2,
    })),
  ]));
  const largeDatabase = createDatabase({
    getRunEvidence() {
      return {
        run,
        selection: { runId: run.id, nodeRunId: null, attemptId: null },
        totals: { nodeRuns: 50, attempts: 150 }, returned: { nodeRuns: 50, attempts: 150 },
        hasMore: { nodeRuns: false, attempts: false }, evidenceComplete: true, evidenceReasons: [],
        nodeRuns, attemptsByNodeId,
      };
    },
  });
  const bounded = executeCanvasAgentTool(largeDatabase, request('inspectRun', { runId: run.id }, 'bounded-evidence'));
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.data.omitted, true);
  assert.equal(bounded.data.evidenceComplete, false);
  assert.equal(bounded.data.diagnosis.outcome, 'insufficient');
  assert.ok(bounded.data.evidenceReasons.includes('agent_tool_output_budget_exceeded'));
  assert.deepEqual(bounded.data.selection, { runId: 'run-exact', nodeRunId: null, attemptId: null });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= 64 * 1024);
  assert.equal(bounded.digest, digestAgentResult(withoutDigest(bounded)));
});

test('E4 inspectRun composes only server-authoritative complete same-revision validateCanvas evidence without N+1', () => {
  const flow = definition();
  const document = {
    schema: 't8-canvas-document', schemaVersion: 2, projectId: 'project-a', canvasId: 'canvas-a', revision: 4,
    nodes: [
      { id: 'image-a', type: 'image', position: { x: null, y: 0 }, data: {} },
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `subflow-${index}`, type: 'subflow', position: { x: index * 100, y: 200 },
        data: { definitionId: flow.id, definitionVersion: flow.version },
      })),
    ],
    edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  };
  const run = {
    id: 'run-structure', projectId: 'project-a', canvasId: 'canvas-a', canvasRevision: 4,
    status: 'failed', initiatorId: 'member-a', summary: {}, createdAt: 1, finishedAt: 2,
  };
  const nodeRun = { id: 'node-run-structure', nodeId: 'image-a', status: 'failed', outputRefs: [], createdAt: 1, updatedAt: 2 };
  const attempt = {
    id: 'attempt-structure', attemptNumber: 1, status: 'failed', provider: 'provider-a', model: 'model-a',
    error: { kind: 'protocol', code: 'GRAPH_INVALID', retryable: false }, createdAt: 1, updatedAt: 2,
  };
  const evidenceFor = (selectedRun) => ({
    run: selectedRun,
    selection: { runId: selectedRun.id, nodeRunId: nodeRun.id, attemptId: attempt.id },
    totals: { nodeRuns: 1, attempts: 1 }, returned: { nodeRuns: 1, attempts: 1 },
    hasMore: { nodeRuns: false, attempts: false }, evidenceComplete: true, evidenceReasons: [],
    nodeRuns: [nodeRun], attemptsByNodeId: new Map([[nodeRun.id, [attempt]]]),
  });
  let batchCalls = 0;
  let singleCalls = 0;
  const database = createDatabase({
    document,
    getRunEvidence: () => evidenceFor(run),
    getSubflowDefinitionsByRefs(refs, projectId) {
      batchCalls += 1;
      assert.equal(projectId, 'project-a');
      assert.deepEqual(refs, [{ id: flow.id, version: flow.version }]);
      return [clone(flow)];
    },
    getSubflowDefinition() {
      singleCalls += 1;
      throw new Error('inspectRun structure composition must not query subflows per node');
    },
  });
  const result = executeCanvasAgentTool(database, request('inspectRun', {
    runId: run.id, nodeRunId: nodeRun.id, attemptId: attempt.id,
  }, 'server-validation'));
  assert.equal(batchCalls, 1);
  assert.equal(singleCalls, 0);
  assert.equal(result.truncated, false);
  assert.equal(result.data.evidenceComplete, true);
  assert.deepEqual(new Set(result.data.diagnosis.findings.map((item) => item.category)), new Set(['unknown', 'structure']));
  const structure = result.data.diagnosis.findings.find((item) => item.category === 'structure');
  assert.deepEqual(structure.ref, {
    runId: run.id, nodeRunId: nodeRun.id, attemptId: attempt.id,
  });
  assert.equal(structure.reasonCode, 'authoritative_validate_layout.invalid-position');
  assert.equal(result.data.diagnosis.repairPolicy.mode, 'canvas-patch-preview-required');
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 64 * 1024);
  assert.equal(result.digest, digestAgentResult(withoutDigest(result)));

  batchCalls = 0;
  const staleRun = { ...run, id: 'run-stale', canvasRevision: 3 };
  const stale = executeCanvasAgentTool(createDatabase({
    document,
    getRunEvidence: () => evidenceFor(staleRun),
    getSubflowDefinitionsByRefs() {
      batchCalls += 1;
      return [clone(flow)];
    },
  }), request('inspectRun', {
    runId: staleRun.id, nodeRunId: nodeRun.id, attemptId: attempt.id,
  }, 'stale-validation'));
  assert.equal(batchCalls, 0);
  assert.deepEqual(stale.data.diagnosis.findings.map((item) => item.category), ['unknown']);
  assert.equal(stale.data.diagnosis.repairPolicy.mode, 'suggestion-only');

  const truncatedDocument = {
    ...document,
    nodes: Array.from({ length: 201 }, (_, index) => ({
      id: `node-${index}`, type: 'text', position: { x: null, y: 0 }, data: {},
    })),
  };
  const truncatedRun = { ...run, id: 'run-validation-truncated' };
  const truncatedNodeRun = { ...nodeRun, id: 'node-run-validation-truncated', nodeId: 'node-0' };
  const truncatedAttempt = { ...attempt, id: 'attempt-validation-truncated' };
  const truncatedValidation = executeCanvasAgentTool(createDatabase({
    document: truncatedDocument,
    getRunEvidence: () => ({
      run: truncatedRun,
      selection: { runId: truncatedRun.id, nodeRunId: truncatedNodeRun.id, attemptId: truncatedAttempt.id },
      totals: { nodeRuns: 1, attempts: 1 }, returned: { nodeRuns: 1, attempts: 1 },
      hasMore: { nodeRuns: false, attempts: false }, evidenceComplete: true, evidenceReasons: [],
      nodeRuns: [truncatedNodeRun], attemptsByNodeId: new Map([[truncatedNodeRun.id, [truncatedAttempt]]]),
    }),
  }), request('inspectRun', {
    runId: truncatedRun.id, nodeRunId: truncatedNodeRun.id, attemptId: truncatedAttempt.id,
  }, 'truncated-validation'));
  assert.deepEqual(truncatedValidation.data.diagnosis.findings.map((item) => item.category), ['unknown']);
  assert.equal(truncatedValidation.data.diagnosis.repairPolicy.mode, 'suggestion-only');

  const budgetNodes = Array.from({ length: 100 }, (_, index) => ({
    id: `node-${String(index).padStart(3, '0')}-${'x'.repeat(231)}`,
    type: 'unknown-node',
    position: { x: null, y: 0 },
    data: {},
  }));
  const budgetDocument = { ...document, nodes: budgetNodes };
  const budgetRun = { ...run, id: 'run-validation-budget' };
  const budgetNodeRun = { ...nodeRun, id: 'node-run-validation-budget', nodeId: budgetNodes[0].id };
  const budgetAttempt = { ...attempt, id: 'attempt-validation-budget' };
  const budgetDatabase = createDatabase({
    document: budgetDocument,
    getRunEvidence: () => ({
      run: budgetRun,
      selection: { runId: budgetRun.id, nodeRunId: budgetNodeRun.id, attemptId: budgetAttempt.id },
      totals: { nodeRuns: 1, attempts: 1 }, returned: { nodeRuns: 1, attempts: 1 },
      hasMore: { nodeRuns: false, attempts: false }, evidenceComplete: true, evidenceReasons: [],
      nodeRuns: [budgetNodeRun], attemptsByNodeId: new Map([[budgetNodeRun.id, [budgetAttempt]]]),
    }),
  });
  const publicValidation = executeCanvasAgentTool(budgetDatabase, request('validateCanvas', {}, 'validation-budget-proof'));
  assert.equal(publicValidation.truncated, true);
  assert.equal(publicValidation.data.omitted, true);
  const budgetValidation = executeCanvasAgentTool(budgetDatabase, request('inspectRun', {
    runId: budgetRun.id, nodeRunId: budgetNodeRun.id, attemptId: budgetAttempt.id,
  }, 'budget-validation'));
  assert.deepEqual(budgetValidation.data.diagnosis.findings.map((item) => item.category), ['unknown']);
  assert.equal(budgetValidation.data.diagnosis.repairPolicy.mode, 'suggestion-only');
});
