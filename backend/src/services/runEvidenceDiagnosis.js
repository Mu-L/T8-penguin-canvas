const crypto = require('crypto');

const RUN_EVIDENCE_DIAGNOSIS_SCHEMA = 't8-run-evidence-diagnosis-v1';
const RUN_EVIDENCE_CATEGORIES = Object.freeze([
  'platform',
  'configuration',
  'network',
  'structure',
  'unknown',
]);
const RUN_EVIDENCE_CATEGORY_SET = new Set(RUN_EVIDENCE_CATEGORIES);
const RUN_EVIDENCE_FINDING_LIMIT = 20;
const AUTHORITATIVE_RUN_VALIDATION_SCHEMA = 't8-server-authoritative-run-validation-evidence-v1';
const SERVER_AUTHORITATIVE_VALIDATION_EVIDENCE = new WeakSet();
const PERSISTED_RUN_EVIDENCE_BASIS = 'persisted-run-node-run-attempt';
const COMBINED_STRUCTURE_EVIDENCE_BASIS = `${PERSISTED_RUN_EVIDENCE_BASIS}+server-authoritative-validate-canvas-same-revision`;
const FAILURE_RUN_STATUSES = new Set(['failed', 'interrupted', 'error']);
const FAILURE_NODE_STATUSES = new Set(['failed', 'interrupted', 'error']);
const FAILURE_ATTEMPT_STATUSES = new Set(['failed', 'interrupted', 'error']);
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'polling']);
const PERSISTED_ERROR_KINDS = new Set([
  'authentication',
  'quota',
  'rate_limit',
  'network',
  'protocol',
  'upstream',
  'cancelled',
  'local_io',
  'unknown',
]);
const RUN_EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;

const CATEGORY_SUMMARIES = Object.freeze({
  platform: '平台侧失败证据',
  configuration: '配置侧失败证据',
  network: '网络侧失败证据',
  structure: '画布结构失败证据',
  unknown: '持久化证据无法可靠分类',
});

const CATEGORY_RECOMMENDATIONS = Object.freeze({
  platform: '核验平台状态、额度与限流；仅在 Attempt 明确标记可重试时再发起重试。',
  configuration: '由主机所有者核验凭据、模型或区域配置；Agent 只能看到配置状态，不能读取或修改密钥。',
  network: '核验 DNS、代理、连接与超时设置；保留原 Run，不要用无证据的画布改动替代网络排查。',
  structure: '仅处理同一画布修订的权威 validateCanvas 错误；CanvasPatch 仍需结构化预览和明确确认。',
  unknown: '打开对应 Run/NodeRun/Attempt 核对更多持久化证据；证据不足时只给建议，不生成推测性修复。',
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function finiteTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : 0;
}

function safeStatus(value) {
  return String(value || '').trim().toLowerCase().slice(0, 80);
}

function exactId(value) {
  return typeof value === 'string' && RUN_EVIDENCE_ID_PATTERN.test(value) ? value : null;
}

function validHttpStatus(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 100 && numeric <= 599 ? numeric : null;
}

function persistedError(attempt) {
  const raw = attempt?.error && typeof attempt.error === 'object' && !Array.isArray(attempt.error)
    ? attempt.error
    : {};
  const suppliedKind = String(raw.kind || '').trim().toLowerCase();
  const kind = PERSISTED_ERROR_KINDS.has(suppliedKind) ? suppliedKind : 'unknown';
  return {
    kind,
    code: raw.code == null ? '' : String(raw.code).slice(0, 160),
    httpStatus: validHttpStatus(attempt?.httpStatus ?? raw.httpStatus),
    retryable: raw.retryable === true,
  };
}

function classifyRunAttemptEvidence(attempt) {
  const { kind } = persistedError(attempt);
  if (kind === 'authentication') {
    return { category: 'configuration', confidence: 'high', reasonCode: 'persisted_authentication' };
  }
  if (kind === 'network') {
    return { category: 'network', confidence: 'high', reasonCode: 'persisted_network' };
  }
  if (['quota', 'rate_limit', 'upstream'].includes(kind)) {
    return { category: 'platform', confidence: 'high', reasonCode: `persisted_${kind}` };
  }
  if (kind === 'cancelled') {
    return { category: 'unknown', confidence: 'low', reasonCode: 'persisted_cancelled_non_fault', nonFault: true };
  }
  return {
    category: 'unknown',
    confidence: 'low',
    reasonCode: `persisted_${kind}_not_classifiable`,
  };
}

function attemptHasHistoricalFailure(attempt) {
  const error = persistedError(attempt);
  return FAILURE_ATTEMPT_STATUSES.has(safeStatus(attempt?.status)) && error.kind !== 'cancelled';
}

function latestAttempt(attempts) {
  return [...attempts].sort((left, right) => (
    finiteTimestamp(right?.updatedAt || right?.createdAt) - finiteTimestamp(left?.updatedAt || left?.createdAt)
    || Math.max(0, Number(right?.attemptNumber) || 0) - Math.max(0, Number(left?.attemptNumber) || 0)
    || String(right?.id || '').localeCompare(String(left?.id || ''))
  ))[0] || null;
}

function findingFor(run, nodeRun, attempt, classification = classifyRunAttemptEvidence(attempt), suffix = '') {
  const runId = exactId(run?.id);
  const nodeRunId = exactId(nodeRun?.id);
  const attemptId = exactId(attempt?.id);
  if (!runId || !nodeRunId || !attemptId) return null;
  const error = persistedError(attempt);
  const attemptNumber = Math.max(1, Math.trunc(Number(attempt?.attemptNumber) || 1));
  const timestamp = finiteTimestamp(attempt?.updatedAt || attempt?.createdAt || nodeRun?.updatedAt || run?.finishedAt || run?.createdAt);
  const findingIdentity = `${nodeRunId}:${attemptId}${suffix}`;
  return {
    id: findingIdentity.length <= 360
      ? findingIdentity
      : `finding:${crypto.createHash('sha256').update(findingIdentity, 'utf8').digest('hex')}`,
    ref: { runId, nodeRunId, attemptId },
    runId,
    nodeRunId,
    attemptId,
    nodeId: exactId(nodeRun?.nodeId) || '',
    attemptNumber,
    status: safeStatus(attempt?.status),
    category: classification.category,
    confidence: classification.confidence,
    reasonCode: classification.reasonCode,
    summary: CATEGORY_SUMMARIES[classification.category],
    provider: attempt?.provider == null ? '' : String(attempt.provider).slice(0, 160),
    model: attempt?.model == null ? '' : String(attempt.model).slice(0, 240),
    error,
    timestamp,
  };
}

function sealServerAuthoritativeRunValidation(runScope, validation) {
  const runId = exactId(runScope?.id);
  const projectId = exactId(runScope?.projectId);
  const canvasId = exactId(runScope?.canvasId);
  const canvasRevision = Number(runScope?.canvasRevision);
  if (!runId || !projectId || !canvasId
    || !Number.isSafeInteger(canvasRevision) || canvasRevision < 0) return null;
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) return null;
  if (validation.schema !== 't8-canvas-agent-tool-result-v1'
    || validation.tool !== 'validateCanvas'
    || validation.projectId !== projectId
    || validation.canvasId !== canvasId
    || Number(validation.canvasRevision) !== canvasRevision
    || validation.readOnly !== true
    || validation.truncated !== false
    || !Number.isSafeInteger(validation.canvasRevision)
    || !/^[a-f0-9]{64}$/.test(String(validation.digest || ''))) return null;
  const digestEnvelope = { ...validation };
  delete digestEnvelope.digest;
  if (digest(digestEnvelope) !== validation.digest) return null;
  const data = validation.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || data.basis !== 'current-canvas'
    || data.truncated !== false
    || !Array.isArray(data.diagnostics)) return null;
  const totals = data.totals;
  if (!totals || typeof totals !== 'object' || Array.isArray(totals)
    || !Number.isSafeInteger(totals.nodes) || totals.nodes < 0
    || !Number.isSafeInteger(totals.edges) || totals.edges < 0
    || !Number.isSafeInteger(totals.errors) || totals.errors < 0
    || !Number.isSafeInteger(totals.warnings) || totals.warnings < 0
    || data.diagnostics.length > 200) return null;
  let errorCount = 0;
  let warningCount = 0;
  const nodeErrors = [];
  for (const item of data.diagnostics) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !['error', 'warning'].includes(item.severity)
      || !['canvas', 'node', 'edge'].includes(item.targetType)
      || !exactId(item.targetId)
      || typeof item.ruleId !== 'string'
      || item.ruleId.length < 1
      || item.ruleId.length > 160) return null;
    if (item.severity === 'error') errorCount += 1;
    else warningCount += 1;
    if (item.severity === 'error' && item.targetType === 'node') {
      nodeErrors.push(Object.freeze({
        ruleId: item.ruleId,
        targetId: item.targetId,
      }));
    }
  }
  if (totals.errors !== errorCount
    || totals.warnings !== warningCount
    || data.diagnostics.length !== errorCount + warningCount
    || data.valid !== (errorCount === 0)) return null;
  const evidence = Object.freeze({
    schema: AUTHORITATIVE_RUN_VALIDATION_SCHEMA,
    runId,
    projectId,
    canvasId,
    canvasRevision,
    diagnostics: Object.freeze(nodeErrors),
  });
  SERVER_AUTHORITATIVE_VALIDATION_EVIDENCE.add(evidence);
  return evidence;
}

function authoritativeStructureDiagnostics(run, evidence) {
  if (!evidence || typeof evidence !== 'object'
    || !SERVER_AUTHORITATIVE_VALIDATION_EVIDENCE.has(evidence)
    || evidence.schema !== AUTHORITATIVE_RUN_VALIDATION_SCHEMA
    || evidence.runId !== run?.id
    || evidence.canvasId !== run?.canvasId
    || Number(evidence.canvasRevision) !== Number(run?.canvasRevision)) return [];
  return evidence.diagnostics;
}

function insufficientDiagnosis(reasons = [], totalFindings = 0, truncated = false) {
  return {
    schema: RUN_EVIDENCE_DIAGNOSIS_SCHEMA,
    evidenceBasis: PERSISTED_RUN_EVIDENCE_BASIS,
    outcome: 'insufficient',
    primaryCategory: null,
    categoryCounts: Object.fromEntries(RUN_EVIDENCE_CATEGORIES.map((category) => [category, 0])),
    totalFindings: Math.max(0, Number(totalFindings) || 0),
    truncated: Boolean(truncated),
    evidenceReasons: [...new Set((Array.isArray(reasons) ? reasons : []).map(String))].slice(0, 20),
    findings: [],
    recommendations: [{ category: 'unknown', text: CATEGORY_RECOMMENDATIONS.unknown }],
    repairPolicy: {
      mode: 'suggestion-only',
      agentMayEditCredentials: false,
      requiresStructuredPreview: true,
      requiresExplicitConfirmation: true,
    },
  };
}

function diagnosePublicRunEvidence(runInspection, options = {}) {
  const run = runInspection && typeof runInspection === 'object' && !Array.isArray(runInspection)
    ? runInspection
    : {};
  const runStatus = safeStatus(run.status);
  const nodeRuns = Array.isArray(run.nodeRuns) ? run.nodeRuns : [];
  const evidenceReasons = Array.isArray(run.evidenceReasons) ? run.evidenceReasons.map(String) : [];
  if (run.evidenceComplete === false || run.truncated === true || !exactId(run.id)) {
    if (!exactId(run.id)) evidenceReasons.push('missing_real_run_id');
    if (run.truncated === true) evidenceReasons.push('run_evidence_truncated');
    return insufficientDiagnosis(evidenceReasons);
  }

  const hasHistoricalFailure = nodeRuns.some((nodeRun) => (
    Array.isArray(nodeRun?.attempts) && nodeRun.attempts.some(attemptHasHistoricalFailure)
  ));
  if (runStatus === 'succeeded') {
    return {
      ...insufficientDiagnosis([], 0, false),
      outcome: hasHistoricalFailure ? 'recovered' : 'succeeded',
      evidenceReasons: [],
      recommendations: [],
    };
  }
  if (ACTIVE_RUN_STATUSES.has(runStatus)) {
    return {
      ...insufficientDiagnosis([], 0, false),
      outcome: 'active',
      evidenceReasons: [],
      recommendations: [],
    };
  }
  if (!FAILURE_RUN_STATUSES.has(runStatus)) {
    return {
      ...insufficientDiagnosis([], 0, false),
      outcome: 'no-failure-evidence',
      evidenceReasons: [],
      recommendations: [],
    };
  }

  const selectedAttemptId = exactId(run.selection?.attemptId);
  const selectedNodeRunId = exactId(run.selection?.nodeRunId);
  const currentFailures = [];
  let missingTerminalEvidence = false;
  for (const nodeRun of nodeRuns) {
    if (!FAILURE_NODE_STATUSES.has(safeStatus(nodeRun?.status))) continue;
    if (selectedNodeRunId && exactId(nodeRun?.id) !== selectedNodeRunId) continue;
    const attempts = Array.isArray(nodeRun?.attempts) ? nodeRun.attempts : [];
    const attempt = selectedAttemptId
      ? attempts.find((item) => exactId(item?.id) === selectedAttemptId) || null
      : latestAttempt(attempts);
    if (!attempt || !exactId(nodeRun?.id) || !exactId(attempt?.id)) {
      missingTerminalEvidence = true;
      continue;
    }
    if (!FAILURE_ATTEMPT_STATUSES.has(safeStatus(attempt.status))) {
      missingTerminalEvidence = true;
      continue;
    }
    const classification = classifyRunAttemptEvidence(attempt);
    if (classification.nonFault === true) continue;
    const finding = findingFor(run, nodeRun, attempt, classification);
    if (finding) currentFailures.push({ finding, nodeRun, attempt });
    else missingTerminalEvidence = true;
  }

  if (missingTerminalEvidence || (!currentFailures.length && !selectedAttemptId)) {
    return insufficientDiagnosis([
      ...evidenceReasons,
      'terminal_failure_evidence_missing_or_retained',
    ]);
  }
  if (!currentFailures.length) {
    return {
      ...insufficientDiagnosis([], 0, false),
      outcome: 'no-failure-evidence',
      evidenceReasons: [],
      recommendations: [],
    };
  }

  const findings = currentFailures.map((item) => item.finding);
  const structureDiagnostics = authoritativeStructureDiagnostics(run, options.authoritativeValidationEvidence);
  for (const diagnostic of structureDiagnostics) {
    const target = currentFailures.find((item) => exactId(item.nodeRun?.nodeId) === diagnostic.targetId);
    if (!target) continue;
    const structureFinding = findingFor(run, target.nodeRun, target.attempt, {
      category: 'structure',
      confidence: 'high',
      reasonCode: `authoritative_validate_${diagnostic.ruleId}`.slice(0, 160),
    }, `:structure:${diagnostic.ruleId}`);
    if (structureFinding) findings.push(structureFinding);
  }
  findings.sort((left, right) => (
    right.timestamp - left.timestamp
    || left.nodeRunId.localeCompare(right.nodeRunId)
    || right.attemptNumber - left.attemptNumber
    || left.attemptId.localeCompare(right.attemptId)
    || left.category.localeCompare(right.category)
  ));

  if (findings.length > RUN_EVIDENCE_FINDING_LIMIT) {
    return insufficientDiagnosis(['diagnosis_findings_truncated'], findings.length, true);
  }
  const categoryCounts = Object.fromEntries(RUN_EVIDENCE_CATEGORIES.map((category) => [category, 0]));
  findings.forEach((finding) => {
    const category = RUN_EVIDENCE_CATEGORY_SET.has(finding.category) ? finding.category : 'unknown';
    categoryCounts[category] += 1;
  });
  const categories = [...new Set(findings.map((finding) => finding.category))];
  return {
    schema: RUN_EVIDENCE_DIAGNOSIS_SCHEMA,
    evidenceBasis: findings.some((finding) => finding.category === 'structure')
      ? COMBINED_STRUCTURE_EVIDENCE_BASIS
      : PERSISTED_RUN_EVIDENCE_BASIS,
    outcome: 'failed',
    primaryCategory: findings[0]?.category || null,
    categoryCounts,
    totalFindings: findings.length,
    truncated: false,
    evidenceReasons: [],
    findings,
    recommendations: categories.map((category) => ({
      category,
      text: CATEGORY_RECOMMENDATIONS[category],
    })),
    repairPolicy: {
      mode: findings.some((finding) => finding.category === 'structure')
        ? 'canvas-patch-preview-required'
        : 'suggestion-only',
      agentMayEditCredentials: false,
      requiresStructuredPreview: true,
      requiresExplicitConfirmation: true,
    },
  };
}

module.exports = {
  RUN_EVIDENCE_CATEGORIES,
  RUN_EVIDENCE_DIAGNOSIS_SCHEMA,
  RUN_EVIDENCE_FINDING_LIMIT,
  classifyRunAttemptEvidence,
  diagnosePublicRunEvidence,
  insufficientDiagnosis,
  sealServerAuthoritativeRunValidation,
};
