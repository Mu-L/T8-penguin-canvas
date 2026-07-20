const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RUN_EVIDENCE_CATEGORIES,
  classifyRunAttemptEvidence,
  diagnosePublicRunEvidence,
  sealServerAuthoritativeRunValidation,
} = require('../backend/src/services/runEvidenceDiagnosis');
const { digestAgentResult } = require('../backend/src/services/canvasAgentPublicView');

function attempt(overrides = {}) {
  return {
    id: 'attempt-a',
    attemptNumber: 1,
    status: 'failed',
    provider: 'provider-a',
    model: 'model-a',
    httpStatus: null,
    error: { kind: 'unknown', code: 'E_UNKNOWN', httpStatus: null, retryable: false },
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function failedInspection(overrides = {}) {
  return {
    schema: 't8-run-evidence-inspection-v1',
    id: 'run-a',
    canvasId: 'canvas-a',
    canvasRevision: 4,
    status: 'failed',
    evidenceComplete: true,
    evidenceReasons: [],
    truncated: false,
    selection: { runId: 'run-a', nodeRunId: null, attemptId: null },
    nodeRuns: [{
      id: 'node-run-a',
      nodeId: 'image-a',
      status: 'failed',
      attempts: [attempt()],
    }],
    ...overrides,
  };
}

function authoritativeValidation(canvasRevision, diagnostics) {
  const envelope = {
    schema: 't8-canvas-agent-tool-result-v1',
    tool: 'validateCanvas',
    requestId: 'request-validation',
    projectId: 'project-a',
    canvasId: 'canvas-a',
    canvasRevision,
    actorId: 'local-owner',
    role: 'owner',
    readOnly: true,
    truncated: false,
    data: {
      basis: 'current-canvas',
      valid: false,
      diagnostics,
      totals: { nodes: 1, edges: 0, errors: diagnostics.length, warnings: 0 },
      truncated: false,
    },
  };
  return { ...envelope, digest: digestAgentResult(envelope) };
}

test('E4 classifies only persisted error.kind and never guesses from code, message, or HTTP', () => {
  assert.deepEqual(RUN_EVIDENCE_CATEGORIES, ['platform', 'configuration', 'network', 'structure', 'unknown']);
  assert.deepEqual(classifyRunAttemptEvidence(attempt({
    httpStatus: 401,
    error: { kind: 'upstream', code: 'AUTH_FAILED', message: 'API key invalid', retryable: true },
  })), { category: 'platform', confidence: 'high', reasonCode: 'persisted_upstream' });
  assert.deepEqual(classifyRunAttemptEvidence(attempt({
    httpStatus: 503,
    error: { kind: 'authentication', code: 'ETIMEDOUT', message: 'network timeout', retryable: false },
  })), { category: 'configuration', confidence: 'high', reasonCode: 'persisted_authentication' });
  assert.deepEqual(classifyRunAttemptEvidence(attempt({
    httpStatus: 200,
    error: { kind: 'network', code: 'OK', message: 'not a network-looking message', retryable: true },
  })), { category: 'network', confidence: 'high', reasonCode: 'persisted_network' });
  for (const kind of ['quota', 'rate_limit', 'upstream']) {
    assert.equal(classifyRunAttemptEvidence(attempt({ error: { kind, code: '', retryable: true } })).category, 'platform');
  }
  for (const kind of ['protocol', 'local_io', 'unknown']) {
    const classification = classifyRunAttemptEvidence(attempt({
      httpStatus: 503,
      error: { kind, code: 'GRAPH_DANGLING_EDGE_RATE_LIMIT_AUTH', message: 'timeout quota missing input', retryable: false },
    }));
    assert.equal(classification.category, 'unknown');
    assert.equal(classification.reasonCode, `persisted_${kind}_not_classifiable`);
  }
  assert.deepEqual(classifyRunAttemptEvidence(attempt({ error: { kind: 'cancelled', code: 'UPSTREAM_BUSY' } })), {
    category: 'unknown', confidence: 'low', reasonCode: 'persisted_cancelled_non_fault', nonFault: true,
  });
});

test('E4 finding cites exact three-level identities and only the bounded public provider/model/error fields', () => {
  const diagnosis = diagnosePublicRunEvidence(failedInspection({
    nodeRuns: [{
      id: 'node-run-a',
      nodeId: 'image-a',
      status: 'failed',
      attempts: [attempt({
        id: 'attempt-network',
        attemptNumber: 2,
        provider: 'safe-provider',
        model: 'safe-model',
        httpStatus: 504,
        error: { kind: 'network', code: 'ETIMEDOUT', httpStatus: 504, retryable: true },
      })],
    }],
  }));
  assert.equal(diagnosis.outcome, 'failed');
  assert.equal(diagnosis.primaryCategory, 'network');
  assert.equal(diagnosis.totalFindings, 1);
  assert.deepEqual(diagnosis.findings[0], {
    id: 'node-run-a:attempt-network',
    ref: { runId: 'run-a', nodeRunId: 'node-run-a', attemptId: 'attempt-network' },
    runId: 'run-a',
    nodeRunId: 'node-run-a',
    attemptId: 'attempt-network',
    nodeId: 'image-a',
    attemptNumber: 2,
    status: 'failed',
    category: 'network',
    confidence: 'high',
    reasonCode: 'persisted_network',
    summary: '网络侧失败证据',
    provider: 'safe-provider',
    model: 'safe-model',
    error: { kind: 'network', code: 'ETIMEDOUT', httpStatus: 504, retryable: true },
    timestamp: 20,
  });
  assert.equal(diagnosis.repairPolicy.mode, 'suggestion-only');
  assert.equal(diagnosis.repairPolicy.agentMayEditCredentials, false);
});

test('E4 structure category requires an intact same-revision authoritative validateCanvas result', () => {
  const run = failedInspection({
    nodeRuns: [{
      id: 'node-run-a', nodeId: 'image-a', status: 'failed',
      attempts: [attempt({ error: { kind: 'protocol', code: 'GRAPH_DANGLING_EDGE', retryable: false } })],
    }],
  });
  const withoutValidation = diagnosePublicRunEvidence(run);
  assert.deepEqual(withoutValidation.findings.map((item) => item.category), ['unknown']);
  assert.equal(withoutValidation.repairPolicy.mode, 'suggestion-only');

  const staleValidation = authoritativeValidation(3, [{
    ruleId: 'ports.required-input-missing', severity: 'error', targetType: 'node', targetId: 'image-a', detail: 'missing',
  }]);
  assert.equal(sealServerAuthoritativeRunValidation({ ...run, projectId: 'project-a' }, staleValidation), null);

  const forgedValidation = authoritativeValidation(4, [{
    ruleId: 'ports.required-input-missing', severity: 'error', targetType: 'node', targetId: 'image-a', detail: 'missing',
  }]);
  forgedValidation.data.diagnostics[0].targetId = 'other-node';
  assert.equal(sealServerAuthoritativeRunValidation({ ...run, projectId: 'project-a' }, forgedValidation), null);

  const validValidation = authoritativeValidation(4, [{
    ruleId: 'ports.required-input-missing', severity: 'error', targetType: 'node', targetId: 'image-a', detail: 'missing',
  }]);
  assert.deepEqual(diagnosePublicRunEvidence(run, {
    validation: validValidation,
    validationTrusted: true,
    authoritativeValidationEvidence: validValidation,
  }).findings.map((item) => item.category), ['unknown']);
  const evidence = sealServerAuthoritativeRunValidation({ ...run, projectId: 'project-a' }, validValidation);
  assert.ok(evidence);
  validValidation.data.diagnostics[0].targetId = 'other-node';
  const validated = diagnosePublicRunEvidence(run, { authoritativeValidationEvidence: evidence });
  assert.deepEqual(new Set(validated.findings.map((item) => item.category)), new Set(['unknown', 'structure']));
  assert.equal(validated.evidenceBasis, 'persisted-run-node-run-attempt+server-authoritative-validate-canvas-same-revision');
  assert.equal(validated.findings.find((item) => item.category === 'structure').ref.attemptId, 'attempt-a');
  assert.equal(validated.repairPolicy.mode, 'canvas-patch-preview-required');
  assert.match(validated.recommendations.find((item) => item.category === 'structure').text, /CanvasPatch/);

  const crossProject = authoritativeValidation(4, [{
    ruleId: 'ports.required-input-missing', severity: 'error', targetType: 'node', targetId: 'image-a', detail: 'missing',
  }]);
  crossProject.projectId = 'project-b';
  delete crossProject.digest;
  crossProject.digest = digestAgentResult(crossProject);
  assert.equal(sealServerAuthoritativeRunValidation({ ...run, projectId: 'project-a' }, crossProject), null);

  const incomplete = authoritativeValidation(4, [{
    ruleId: 'ports.required-input-missing', severity: 'error', targetType: 'node', targetId: 'image-a', detail: 'missing',
  }]);
  incomplete.data.truncated = true;
  delete incomplete.digest;
  incomplete.digest = digestAgentResult(incomplete);
  assert.equal(sealServerAuthoritativeRunValidation({ ...run, projectId: 'project-a' }, incomplete), null);
});

test('E4 recovered/succeeded terminal state is never misdiagnosed from historical failed Attempts', () => {
  const recovered = diagnosePublicRunEvidence(failedInspection({
    status: 'succeeded',
    nodeRuns: [{
      id: 'node-run-a', nodeId: 'image-a', status: 'succeeded',
      attempts: [
        attempt({ id: 'attempt-old', attemptNumber: 1, error: { kind: 'network', code: 'ETIMEDOUT', retryable: true } }),
        attempt({ id: 'attempt-new', attemptNumber: 2, status: 'succeeded', error: null, updatedAt: 30 }),
      ],
    }],
  }));
  assert.equal(recovered.outcome, 'recovered');
  assert.equal(recovered.primaryCategory, null);
  assert.deepEqual(recovered.findings, []);

  const succeeded = diagnosePublicRunEvidence(failedInspection({
    status: 'succeeded',
    nodeRuns: [{ id: 'node-run-a', nodeId: 'image-a', status: 'succeeded', attempts: [attempt({ status: 'succeeded', error: null })] }],
  }));
  assert.equal(succeeded.outcome, 'succeeded');
  assert.deepEqual(succeeded.findings, []);
});

test('E4 failed terminal diagnosis keeps every current failure category and ignores recovered nodes', () => {
  const diagnosis = diagnosePublicRunEvidence(failedInspection({
    nodeRuns: [
      {
        id: 'node-recovered', nodeId: 'image-recovered', status: 'succeeded',
        attempts: [attempt({ id: 'old-network', error: { kind: 'network', code: 'ETIMEDOUT', retryable: true } })],
      },
      {
        id: 'node-platform', nodeId: 'image-platform', status: 'failed',
        attempts: [attempt({ id: 'current-platform', error: { kind: 'quota', code: 'NO_CREDIT', retryable: false }, updatedAt: 30 })],
      },
      {
        id: 'node-config', nodeId: 'image-config', status: 'failed',
        attempts: [attempt({ id: 'current-config', error: { kind: 'authentication', code: 'AUTH_FAILED', retryable: false }, updatedAt: 25 })],
      },
    ],
  }));
  assert.equal(diagnosis.outcome, 'failed');
  assert.equal(diagnosis.totalFindings, 2);
  assert.deepEqual(new Set(diagnosis.findings.map((item) => item.category)), new Set(['platform', 'configuration']));
  assert.equal(diagnosis.findings.some((item) => item.attemptId === 'old-network'), false);
  assert.equal(diagnosis.categoryCounts.platform, 1);
  assert.equal(diagnosis.categoryCounts.configuration, 1);
  assert.deepEqual(new Set(diagnosis.recommendations.map((item) => item.category)), new Set(['platform', 'configuration']));
});

test('E4 missing IDs, retention gaps, query truncation, and cancelled-only evidence fail closed as insufficient', () => {
  for (const run of [
    failedInspection({ evidenceComplete: false, evidenceReasons: ['attempts_truncated'], truncated: true }),
    failedInspection({ nodeRuns: [{ id: 'node-run-a', nodeId: 'image-a', status: 'failed', attempts: [] }] }),
    failedInspection({ nodeRuns: [{ id: 'node-run-a', nodeId: 'image-a', status: 'failed', attempts: [attempt({ id: null })] }] }),
    failedInspection({ nodeRuns: [{
      id: 'node-run-a', nodeId: 'image-a', status: 'failed',
      attempts: [attempt({ error: { kind: 'cancelled', code: 'ABORTED', retryable: false } })],
    }] }),
  ]) {
    const diagnosis = diagnosePublicRunEvidence(run);
    assert.equal(diagnosis.outcome, 'insufficient');
    assert.equal(diagnosis.primaryCategory, null);
    assert.deepEqual(diagnosis.findings, []);
    assert.equal(diagnosis.repairPolicy.mode, 'suggestion-only');
  }
});

test('E4 diagnosis finding cap is itself insufficient instead of silently returning the first category', () => {
  const diagnosis = diagnosePublicRunEvidence(failedInspection({
    nodeRuns: Array.from({ length: 21 }, (_, index) => ({
      id: `node-run-${index}`,
      nodeId: `node-${index}`,
      status: 'failed',
      attempts: [attempt({
        id: `attempt-${index}`,
        error: { kind: index % 2 ? 'network' : 'quota', code: `E_${index}`, retryable: true },
        updatedAt: 100 + index,
      })],
    })),
  }));
  assert.equal(diagnosis.outcome, 'insufficient');
  assert.equal(diagnosis.primaryCategory, null);
  assert.equal(diagnosis.totalFindings, 21);
  assert.equal(diagnosis.truncated, true);
  assert.deepEqual(diagnosis.findings, []);
  assert.deepEqual(diagnosis.evidenceReasons, ['diagnosis_findings_truncated']);
  assert.equal(diagnosis.repairPolicy.mode, 'suggestion-only');
});
