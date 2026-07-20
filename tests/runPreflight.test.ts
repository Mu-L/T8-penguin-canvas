import test from 'node:test';
import assert from 'node:assert/strict';
import type { Edge, Node } from '@xyflow/react';
import {
  RUN_ACTION_PREVIEW_DIGEST_ALGORITHM,
  RUN_ACTION_PREVIEW_SCHEMA,
  prepareRunAction,
  type PrepareRunActionInput,
  type RunActionKind,
  type RunCostEstimateInput,
  type RunEvidenceRefInput,
  type RunPreflightDiagnosticDomain,
} from '../src/utils/runPreflight.ts';

const nodes: Node[] = [
  { id: 'source', type: 'text', position: { x: 0, y: 0 }, data: { text: 'safe' } },
  { id: 'target', type: 'image', position: { x: 100, y: 0 }, data: { prompt: 'safe' } },
];
const edges: Edge[] = [{ id: 'source-target', source: 'source', target: 'target' }];

function emptyDiagnostics() {
  return { structure: [], capability: [], asset: [], policy: [] };
}

function input(overrides: Partial<PrepareRunActionInput> = {}): PrepareRunActionInput {
  return {
    actionKind: 'run-all',
    projectId: 'project-a',
    canvasId: 'canvas-a',
    currentRevision: 7,
    expectedRevision: 7,
    nodes,
    edges,
    selectedNodeIds: ['source', 'target'],
    diagnostics: emptyDiagnostics(),
    cost: { known: true, amount: 0.25, currency: 'USD' },
    hostContextDigest: `sha256:${'a'.repeat(64)}`,
    ...overrides,
  };
}

test('run-all, run-group, and run-single can be ready only with exact revision and authoritative cost', () => {
  const cases: Array<{ kind: RunActionKind; selectedNodeIds: string[] }> = [
    { kind: 'run-all', selectedNodeIds: ['source', 'target'] },
    { kind: 'run-group', selectedNodeIds: ['source', 'target'] },
    { kind: 'run-single', selectedNodeIds: ['target'] },
  ];
  for (const item of cases) {
    const preview = prepareRunAction(input({ actionKind: item.kind, selectedNodeIds: item.selectedNodeIds }));
    assert.equal(preview.schema, RUN_ACTION_PREVIEW_SCHEMA, item.kind);
    assert.equal(preview.status, 'ready', item.kind);
    assert.equal(preview.requiresExplicitConfirmation, false, item.kind);
    assert.equal(preview.blockers.length, 0, item.kind);
    assert.equal(preview.warnings.length, 0, item.kind);
    assert.equal(preview.scope.selectedNodeCount, item.selectedNodeIds.length, item.kind);
    assert.deepEqual(preview.cost, { known: true, amount: 0.25, currency: 'USD' }, item.kind);
    assert.equal(preview.digestAlgorithm, RUN_ACTION_PREVIEW_DIGEST_ALGORITHM, item.kind);
    assert.match(preview.digest, /^fnv1a32:[0-9a-f]{8}$/i, item.kind);
  }
});

test('every Run, NodeRun, Attempt, subflow replay/retry and RunIntent requires explicit confirmation', () => {
  const runRef: RunEvidenceRefInput[] = [{ runId: 'run-a' }];
  const nodeRunRef: RunEvidenceRefInput[] = [{ runId: 'run-a', nodeRunId: 'node-run-a' }];
  const attemptRef: RunEvidenceRefInput[] = [{ runId: 'run-a', nodeRunId: 'node-run-a', attemptId: 'attempt-a' }];
  const cases: Array<{ kind: RunActionKind; refs?: RunEvidenceRefInput[]; requestId?: string }> = [
    { kind: 'replay-run', refs: runRef },
    { kind: 'retry-run', refs: runRef },
    { kind: 'replay-node-run', refs: nodeRunRef },
    { kind: 'retry-node-run', refs: nodeRunRef },
    { kind: 'replay-attempt', refs: attemptRef },
    { kind: 'retry-attempt', refs: attemptRef },
    { kind: 'replay-subflow', refs: nodeRunRef },
    { kind: 'retry-subflow', refs: nodeRunRef },
    { kind: 'run-intent', requestId: 'intent-a' },
  ];
  for (const item of cases) {
    const preview = prepareRunAction(input({
      actionKind: item.kind,
      evidenceRefs: item.refs,
      requestId: item.requestId,
    }));
    assert.equal(preview.status, 'confirmation-required', item.kind);
    assert.equal(preview.requiresExplicitConfirmation, true, item.kind);
    assert.equal(preview.blockers.length, 0, item.kind);
    assert.ok(preview.warnings.some((warning) => warning.code === 'action.explicit-confirmation-required'), item.kind);
  }
});

test('missing or changed revision fails closed before execution', () => {
  const missing = prepareRunAction(input({ currentRevision: undefined }));
  assert.equal(missing.status, 'blocked');
  assert.ok(missing.blockers.some((blocker) => blocker.code === 'revision.missing'));

  const changed = prepareRunAction(input({ currentRevision: 8, expectedRevision: 7 }));
  assert.equal(changed.status, 'blocked');
  assert.ok(changed.blockers.some((blocker) => blocker.code === 'revision.changed'));
  assert.notEqual(missing.digest, changed.digest);
});

test('missing or malformed host context digest fails closed and a changed digest changes authorization', () => {
  const missing = prepareRunAction(input({ hostContextDigest: '' }));
  assert.equal(missing.status, 'blocked');
  assert.ok(missing.blockers.some((blocker) => blocker.code === 'scope.host-context-digest-missing'));

  const malformed = prepareRunAction(input({ hostContextDigest: 'sha256:not-a-digest' }));
  assert.equal(malformed.status, 'blocked');
  assert.ok(malformed.blockers.some((blocker) => blocker.code === 'scope.host-context-digest-invalid'));

  const baseline = prepareRunAction(input());
  const changed = prepareRunAction(input({ hostContextDigest: `sha256:${'b'.repeat(64)}` }));
  assert.notEqual(changed.scope.hostContextDigest, baseline.scope.hostContextDigest);
  assert.notEqual(changed.digest, baseline.digest);
});

test('structure, capability, asset, and policy errors block; advisory warnings do not interrupt ordinary runs', () => {
  const domains: RunPreflightDiagnosticDomain[] = ['structure', 'capability', 'asset', 'policy'];
  for (const domain of domains) {
    const diagnostics = emptyDiagnostics();
    diagnostics[domain] = [{
      id: `${domain}-error`,
      severity: 'error',
      title: `${domain} explicit failure`,
      nodeIds: ['target'],
    }];
    const preview = prepareRunAction(input({ diagnostics }));
    assert.equal(preview.status, 'blocked', domain);
    assert.ok(preview.blockers.some((blocker) => blocker.domain === domain && blocker.nodeIds.includes('target')), domain);
  }

  const diagnostics = emptyDiagnostics();
  diagnostics.capability = [{ id: 'capability-warning', severity: 'warning', title: 'capability not independently verified' }];
  const warning = prepareRunAction(input({ diagnostics }));
  assert.equal(warning.status, 'ready');
  assert.equal(warning.requiresExplicitConfirmation, false);
  assert.equal(warning.warnings.length, 1);
});

test('explicitly incomplete capability, asset, policy, or structure coverage blocks', () => {
  for (const domain of ['structure', 'capability', 'asset', 'policy'] as const) {
    const preview = prepareRunAction(input({ diagnosticCoverage: { [domain]: false } }));
    assert.equal(preview.status, 'blocked', domain);
    assert.ok(preview.blockers.some((blocker) => blocker.code === `${domain}.inventory-incomplete`), domain);
  }
});

test('incomplete or cross-Run evidence never authorizes replay/retry', () => {
  const incomplete = prepareRunAction(input({
    actionKind: 'retry-attempt',
    evidenceRefs: [{ runId: 'run-a', attemptId: 'attempt-a' }],
  }));
  assert.equal(incomplete.status, 'blocked');
  assert.ok(incomplete.blockers.some((blocker) => blocker.code === 'evidence.incomplete-ref'));
  assert.ok(incomplete.blockers.some((blocker) => blocker.code === 'evidence.required-ref-missing'));
  assert.deepEqual(incomplete.evidenceRefs, []);

  const wrongLevel = prepareRunAction(input({ actionKind: 'replay-attempt', evidenceRefs: [{ runId: 'run-a' }] }));
  assert.equal(wrongLevel.status, 'blocked');
  assert.ok(wrongLevel.blockers.some((blocker) => blocker.code === 'evidence.level-mismatch'));

  const crossRun = prepareRunAction(input({
    actionKind: 'retry-run',
    evidenceRefs: [{ runId: 'run-a' }, { runId: 'run-b', nodeRunId: 'node-run-b' }],
  }));
  assert.equal(crossRun.status, 'blocked');
  assert.ok(crossRun.blockers.some((blocker) => blocker.code === 'evidence.cross-run'));

  const missingIntent = prepareRunAction(input({ actionKind: 'run-intent' }));
  assert.equal(missingIntent.status, 'blocked');
  assert.ok(missingIntent.blockers.some((blocker) => blocker.code === 'run-intent.request-id-missing'));
});

test('replay and retry evidence is exactly one ref at the action level', () => {
  const exactCases: Array<{ kind: RunActionKind; ref: RunEvidenceRefInput }> = [
    { kind: 'replay-run', ref: { runId: 'run-a' } },
    { kind: 'retry-run', ref: { runId: 'run-a' } },
    { kind: 'replay-node-run', ref: { runId: 'run-a', nodeRunId: 'node-run-a' } },
    { kind: 'retry-node-run', ref: { runId: 'run-a', nodeRunId: 'node-run-a' } },
    { kind: 'replay-subflow', ref: { runId: 'run-a', nodeRunId: 'node-run-a' } },
    { kind: 'retry-subflow', ref: { runId: 'run-a', nodeRunId: 'node-run-a' } },
    { kind: 'replay-attempt', ref: { runId: 'run-a', nodeRunId: 'node-run-a', attemptId: 'attempt-a' } },
    { kind: 'retry-attempt', ref: { runId: 'run-a', nodeRunId: 'node-run-a', attemptId: 'attempt-a' } },
  ];
  for (const item of exactCases) {
    const preview = prepareRunAction(input({ actionKind: item.kind, evidenceRefs: [item.ref] }));
    assert.equal(preview.status, 'confirmation-required', item.kind);
    assert.equal(preview.blockers.length, 0, item.kind);
    assert.deepEqual(preview.evidenceRefs, [item.ref], item.kind);
  }

  const wrongLevels: Array<{ kind: RunActionKind; ref: RunEvidenceRefInput }> = [
    { kind: 'retry-run', ref: { runId: 'run-a', nodeRunId: 'node-run-a' } },
    { kind: 'replay-run', ref: { runId: 'run-a', nodeRunId: 'node-run-a', attemptId: 'attempt-a' } },
    { kind: 'retry-subflow', ref: { runId: 'run-a' } },
    { kind: 'replay-node-run', ref: { runId: 'run-a', nodeRunId: 'node-run-a', attemptId: 'attempt-a' } },
    { kind: 'retry-attempt', ref: { runId: 'run-a', nodeRunId: 'node-run-a' } },
    { kind: 'replay-attempt', ref: { runId: 'run-a' } },
  ];
  for (const item of wrongLevels) {
    const preview = prepareRunAction(input({ actionKind: item.kind, evidenceRefs: [item.ref] }));
    assert.equal(preview.status, 'blocked', item.kind);
    assert.ok(preview.blockers.some((blocker) => blocker.code === 'evidence.level-mismatch'), item.kind);
  }
});

test('duplicate, mixed, extra, and cross-Run evidence is rejected instead of normalized away', () => {
  const exactAttempt = { runId: 'run-a', nodeRunId: 'node-run-a', attemptId: 'attempt-a' };
  const duplicate = prepareRunAction(input({
    actionKind: 'retry-attempt',
    evidenceRefs: [exactAttempt, { ...exactAttempt }],
  }));
  assert.equal(duplicate.status, 'blocked');
  assert.ok(duplicate.blockers.some((blocker) => blocker.code === 'evidence.duplicate-ref'));
  assert.deepEqual(duplicate.evidenceRefs, [exactAttempt]);

  const mixedLevels = prepareRunAction(input({
    actionKind: 'retry-attempt',
    evidenceRefs: [{ runId: 'run-a' }, exactAttempt],
  }));
  assert.equal(mixedLevels.status, 'blocked');
  assert.ok(mixedLevels.blockers.some((blocker) => blocker.code === 'evidence.ambiguous-cardinality'));
  assert.ok(mixedLevels.blockers.some((blocker) => blocker.code === 'evidence.level-mismatch'));

  const extraSameRun = prepareRunAction(input({
    actionKind: 'retry-subflow',
    evidenceRefs: [
      { runId: 'run-a', nodeRunId: 'node-run-a' },
      { runId: 'run-a', nodeRunId: 'node-run-b' },
    ],
  }));
  assert.equal(extraSameRun.status, 'blocked');
  assert.ok(extraSameRun.blockers.some((blocker) => blocker.code === 'evidence.ambiguous-cardinality'));

  const crossRun = prepareRunAction(input({
    actionKind: 'retry-attempt',
    evidenceRefs: [
      exactAttempt,
      { runId: 'run-b', nodeRunId: 'node-run-b', attemptId: 'attempt-b' },
    ],
  }));
  assert.equal(crossRun.status, 'blocked');
  assert.ok(crossRun.blockers.some((blocker) => blocker.code === 'evidence.cross-run'));
  assert.ok(crossRun.blockers.some((blocker) => blocker.code === 'evidence.ambiguous-cardinality'));

  const unexpectedField = prepareRunAction(input({
    actionKind: 'retry-run',
    evidenceRefs: [{ runId: 'run-a', source: 'client-guess' } as RunEvidenceRefInput],
  }));
  assert.equal(unexpectedField.status, 'blocked');
  assert.ok(unexpectedField.blockers.some((blocker) => blocker.code === 'evidence.unexpected-field'));
  assert.ok(unexpectedField.blockers.some((blocker) => blocker.code === 'evidence.required-ref-missing'));

  const unexpectedForAction = prepareRunAction(input({
    actionKind: 'run-all',
    evidenceRefs: [{ runId: 'run-a' }],
  }));
  assert.equal(unexpectedForAction.status, 'blocked');
  assert.ok(unexpectedForAction.blockers.some((blocker) => blocker.code === 'evidence.unexpected-for-action'));
});

test('unknown cost remains honest evidence without interrupting an ordinary creation run', () => {
  const preview = prepareRunAction(input({ cost: { known: false } }));
  assert.equal(preview.status, 'ready');
  assert.equal(preview.requiresExplicitConfirmation, false);
  assert.deepEqual(preview.cost, { known: false, reason: 'not-authoritatively-known' });
  assert.equal('amount' in preview.cost, false);
  assert.ok(preview.warnings.some((warning) => warning.code === 'cost.unknown'));

  const invalid = prepareRunAction(input({
    cost: { known: true, amount: Number.NaN, currency: '' } as RunCostEstimateInput,
  }));
  assert.equal(invalid.status, 'blocked');
  assert.deepEqual(invalid.cost, { known: false, reason: 'not-authoritatively-known' });
  assert.ok(invalid.blockers.some((blocker) => blocker.code === 'cost.authoritative-value-invalid'));
});

test('scope validation blocks missing nodes, dangling edges, and invalid single-node cardinality', () => {
  const missingNode = prepareRunAction(input({ selectedNodeIds: ['missing'] }));
  assert.equal(missingNode.status, 'blocked');
  assert.ok(missingNode.blockers.some((blocker) => blocker.code === 'scope.node-not-in-graph'));

  const dangling = prepareRunAction(input({ edges: [{ id: 'dangling', source: 'source', target: 'missing' }] }));
  assert.equal(dangling.status, 'blocked');
  assert.ok(dangling.blockers.some((blocker) => blocker.code === 'structure.dangling-edge'));

  const multiple = prepareRunAction(input({ actionKind: 'run-single', selectedNodeIds: ['source', 'target'] }));
  assert.equal(multiple.status, 'blocked');
  assert.ok(multiple.blockers.some((blocker) => blocker.code === 'scope.single-node-required'));
});

test('execution graph digest binds node data and edge topology but ignores visual position and input order', () => {
  const baseline = prepareRunAction(input());
  const promptChanged = prepareRunAction(input({
    nodes: nodes.map((node) => node.id === 'target'
      ? { ...node, data: { ...node.data, prompt: 'different safe prompt' } }
      : node),
  }));
  assert.equal(promptChanged.scope.nodeSetDigest, baseline.scope.nodeSetDigest);
  assert.notEqual(promptChanged.scope.executionGraphDigest, baseline.scope.executionGraphDigest);
  assert.notEqual(promptChanged.digest, baseline.digest);

  const edgeHandleChanged = prepareRunAction(input({
    edges: [{ ...edges[0], sourceHandle: 'text-out', targetHandle: 'prompt-in' }],
  }));
  assert.notEqual(edgeHandleChanged.scope.executionGraphDigest, baseline.scope.executionGraphDigest);
  assert.notEqual(edgeHandleChanged.digest, baseline.digest);

  const positionOnly = prepareRunAction(input({
    nodes: nodes.map((node) => ({ ...node, position: { x: node.position.x + 500, y: node.position.y + 500 } })),
  }));
  assert.equal(positionOnly.scope.executionGraphDigest, baseline.scope.executionGraphDigest);
  assert.equal(positionOnly.digest, baseline.digest);

  const reordered = prepareRunAction(input({ nodes: [...nodes].reverse() }));
  assert.equal(reordered.scope.executionGraphDigest, baseline.scope.executionGraphDigest);
  assert.equal(reordered.digest, baseline.digest);
});

test('execution graph canonicalization summarizes credentials and large Base64 without ingesting plaintext', () => {
  const firstSecret = 'sk-first-abcdefghijklmnopqrstuvwxyz123456';
  const secondSecret = 'sk-second-zyxwvutsrqponmlkjihgfedcba654321';
  const firstDataUrl = `data:image/png;base64,${'A'.repeat(8192)}`;
  const secondDataUrl = `data:image/png;base64,${'B'.repeat(8192)}`;
  const withSensitiveData = (apiKey: string, image: string, model = 'model-a'): Node[] => nodes.map((node) => (
    node.id === 'target'
      ? { ...node, data: { ...node.data, model, apiKey, authorization: `Bearer ${apiKey}`, image } }
      : node
  ));

  const first = prepareRunAction(input({ nodes: withSensitiveData(firstSecret, firstDataUrl) }));
  const sameSafeSummary = prepareRunAction(input({ nodes: withSensitiveData(secondSecret, secondDataUrl) }));
  assert.equal(first.scope.executionGraphDigest, sameSafeSummary.scope.executionGraphDigest);
  assert.equal(first.digest, sameSafeSummary.digest);

  const safeModelChanged = prepareRunAction(input({ nodes: withSensitiveData(secondSecret, secondDataUrl, 'model-b') }));
  assert.notEqual(first.scope.executionGraphDigest, safeModelChanged.scope.executionGraphDigest);
  assert.notEqual(first.digest, safeModelChanged.digest);

  const unconfigured = prepareRunAction(input({ nodes: withSensitiveData('', secondDataUrl) }));
  assert.notEqual(first.scope.executionGraphDigest, unconfigured.scope.executionGraphDigest);

  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /first-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(serialized, /AAAA{100}/);
  assert.equal(serialized.length < 64 * 1024, true);
});

test('execution graph data that exceeds the safe summary bound fails closed', () => {
  const oversizedNodes = nodes.map((node) => node.id === 'target'
    ? { ...node, data: { ...node.data, frames: Array.from({ length: 2_049 }, (_, index) => index) } }
    : node);
  const preview = prepareRunAction(input({ nodes: oversizedNodes }));
  assert.equal(preview.status, 'blocked');
  assert.ok(preview.blockers.some((blocker) => blocker.code === 'scope.graph-data-overflow'));
  assert.match(preview.scope.executionGraphDigest, /^fnv1a32:[0-9a-f]{8}$/i);
  assert.equal(JSON.stringify(preview).length < 64 * 1024, true);
});

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  Object.values(value).forEach((child) => deepFreeze(child, seen));
  Object.freeze(value);
}

test('prepareRunAction is deterministic, does not mutate input, and makes no network call', () => {
  const frozen = input({ cost: { known: false } });
  const before = JSON.stringify(frozen);
  deepFreeze(frozen);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('network must not be used');
  }) as typeof fetch;
  try {
    const first = prepareRunAction(frozen);
    const second = prepareRunAction(frozen);
    assert.deepEqual(first, second);
    assert.equal(first.digest, second.digest);
    assert.equal(fetchCalls, 0);
    assert.equal(JSON.stringify(frozen), before);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('preview remains bounded and redacts credentials, absolute paths, and base64', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const path = 'C:\\Users\\private\\secret.txt';
  const dataUrl = `data:image/png;base64,${'A'.repeat(4000)}`;
  const manyNodes: Node[] = Array.from({ length: 140 }, (_, index) => ({
    id: index === 0 ? `node-${secret}` : index === 1 ? path : `node-${index}`,
    type: 'text',
    position: { x: index, y: 0 },
    data: { untouchedSecret: secret },
  }));
  const diagnostics = emptyDiagnostics();
  diagnostics.structure = Array.from({ length: 120 }, (_, index) => ({
    id: `warning-${index}`,
    severity: 'warning',
    detail: `${secret} ${path} ${dataUrl}`,
    nodeIds: [manyNodes[index % manyNodes.length].id],
  }));
  const preview = prepareRunAction(input({
    nodes: manyNodes,
    edges: [],
    selectedNodeIds: manyNodes.map((node) => node.id),
    diagnostics,
    evidenceRefs: [{ runId: secret, nodeRunId: path, attemptId: dataUrl }],
  }));
  const serialized = JSON.stringify(preview);
  assert.equal(preview.status, 'blocked');
  assert.equal(preview.scope.nodeIds.length, 80);
  assert.equal(preview.scope.nodeIdsTruncated, true);
  assert.equal(preview.blockers.length <= 32, true);
  assert.equal(preview.warnings.length <= 32, true);
  assert.equal(serialized.length < 64 * 1024, true);
  assert.doesNotMatch(serialized, /abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(serialized, /Users\\\\private/);
  assert.doesNotMatch(serialized, /AAAA{100}/);
  assert.match(serialized, /credential|sensitive-id|path|base64/i);
});
