const crypto = require('crypto');
const { containsPlaintextSecret } = require('./subflowPackage');
const { safeIdentifier, safePatchValue, stableJson } = require('./canvasPatch');
const { diagnosePublicRunEvidence, insufficientDiagnosis } = require('./runEvidenceDiagnosis');

const AGENT_TOOL_OUTPUT_BYTES = 64 * 1024;
const AGENT_CANVAS_NODE_LIMIT = 100;
const AGENT_CANVAS_EDGE_LIMIT = 200;
const AGENT_RUN_NODE_LIMIT = 50;
const AGENT_RUN_ATTEMPT_LIMIT = 3;
const AGENT_SEARCH_LIMIT = 20;
const AGENT_PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const AGENT_RUN_EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const AGENT_PLAN_PORT_KINDS = new Set(['text', 'image', 'video', 'audio', 'model3d', 'metadata', 'config', 'any']);

function boundedNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeText(value, field, maximum = 500) {
  const safe = safePatchValue(String(value ?? ''), field);
  return typeof safe === 'string' ? safe.slice(0, maximum) : '[redacted]';
}

function safePublicId(value, field = 'id') {
  return safeText(safeIdentifier(value), field, 240);
}

function publicEvidenceId(value, field = 'id') {
  if (typeof value !== 'string' || !AGENT_RUN_EVIDENCE_ID_PATTERN.test(value)) return null;
  const safe = safePublicId(value, field);
  return safe === value ? safe : null;
}

function safeStringList(value, field, maximumItems = 20, maximumLength = 160) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximumItems).map((item) => safeText(item, field, maximumLength));
}

function publicCanvasNode(node) {
  const data = node?.data && typeof node.data === 'object' && !Array.isArray(node.data) ? node.data : {};
  const dataKeys = Object.keys(data)
    .filter((key) => !['__proto__', 'constructor', 'prototype'].includes(key))
    .sort()
    .slice(0, 50)
    .map((key) => safeText(key, 'dataField', 120));
  const subflowId = node?.type === 'subflow' ? data.definitionId || data.definition?.id : null;
  const subflowVersion = node?.type === 'subflow' ? data.definitionVersion || data.definition?.version : null;
  return {
    id: safePublicId(node?.id, 'nodeId'),
    type: safePublicId(node?.type, 'nodeType'),
    position: {
      x: boundedNumber(node?.position?.x),
      y: boundedNumber(node?.position?.y),
    },
    dataFields: dataKeys,
    ...(subflowId ? {
      subflow: {
        definitionId: safePublicId(subflowId, 'definitionId'),
        version: Math.max(1, Math.trunc(boundedNumber(subflowVersion, 1))),
      },
    } : {}),
  };
}

function publicCanvasEdge(edge) {
  return {
    id: safePublicId(edge?.id, 'edgeId'),
    source: safePublicId(edge?.source, 'sourceNodeId'),
    target: safePublicId(edge?.target, 'targetNodeId'),
    sourceHandle: edge?.sourceHandle == null ? null : safePublicId(edge.sourceHandle, 'sourceHandle'),
    targetHandle: edge?.targetHandle == null ? null : safePublicId(edge.targetHandle, 'targetHandle'),
  };
}

function publicCanvasInspection(document, input = {}) {
  const nodes = Array.isArray(document?.nodes) ? document.nodes : [];
  const edges = Array.isArray(document?.edges) ? document.edges : [];
  const nodeOffset = Math.max(0, Math.trunc(boundedNumber(input.nodeOffset)));
  const edgeOffset = Math.max(0, Math.trunc(boundedNumber(input.edgeOffset)));
  const nodeLimit = Math.min(AGENT_CANVAS_NODE_LIMIT, Math.max(1, Math.trunc(boundedNumber(input.nodeLimit, 50))));
  const edgeLimit = Math.min(AGENT_CANVAS_EDGE_LIMIT, Math.max(1, Math.trunc(boundedNumber(input.edgeLimit, 100))));
  return {
    canvasId: safePublicId(document?.canvasId, 'canvasId'),
    revision: Math.max(1, Math.trunc(boundedNumber(document?.revision, 1))),
    schemaVersion: Math.max(1, Math.trunc(boundedNumber(document?.schemaVersion, 1))),
    totals: { nodes: nodes.length, edges: edges.length },
    nodes: nodes.slice(nodeOffset, nodeOffset + nodeLimit).map(publicCanvasNode),
    edges: edges.slice(edgeOffset, edgeOffset + edgeLimit).map(publicCanvasEdge),
    page: {
      nodeOffset,
      edgeOffset,
      nodeLimit,
      edgeLimit,
      hasMoreNodes: nodeOffset + nodeLimit < nodes.length,
      hasMoreEdges: edgeOffset + edgeLimit < edges.length,
    },
  };
}

function publicAttempt(attempt) {
  const rawError = attempt?.error && typeof attempt.error === 'object' && !Array.isArray(attempt.error)
    ? attempt.error
    : {};
  const persistedKind = [
    'authentication', 'quota', 'rate_limit', 'network', 'protocol',
    'upstream', 'cancelled', 'local_io', 'unknown',
  ].includes(String(rawError.kind || '').trim().toLowerCase())
    ? String(rawError.kind).trim().toLowerCase()
    : 'unknown';
  const attemptNumber = Math.max(1, Math.trunc(boundedNumber(attempt?.attemptNumber, 1)));
  const httpStatus = Number.isInteger(attempt?.httpStatus) && attempt.httpStatus >= 100 && attempt.httpStatus <= 599
    ? attempt.httpStatus
    : (Number.isInteger(rawError.httpStatus) && rawError.httpStatus >= 100 && rawError.httpStatus <= 599
      ? rawError.httpStatus
      : null);
  return {
    id: publicEvidenceId(attempt?.id, 'attemptId'),
    attemptNumber,
    status: safeText(attempt?.status, 'attemptStatus', 80),
    provider: attempt?.provider == null ? null : safeText(attempt.provider, 'provider', 160),
    model: attempt?.model == null ? null : safeText(attempt.model, 'model', 240),
    httpStatus,
    error: {
      kind: persistedKind,
      code: rawError.code == null ? '' : safeText(rawError.code, 'errorCode', 160),
      httpStatus,
      retryable: rawError.retryable === true,
    },
    createdAt: Math.max(0, Math.trunc(boundedNumber(attempt?.createdAt))),
    updatedAt: Math.max(0, Math.trunc(boundedNumber(attempt?.updatedAt))),
  };
}

function publicRunInspection(runOrEvidence, legacyNodeRuns, legacyAttemptsByNodeId, options = {}) {
  const evidence = runOrEvidence?.run && typeof runOrEvidence.run === 'object'
    ? runOrEvidence
    : null;
  const run = evidence ? evidence.run : runOrEvidence;
  const nodeRuns = evidence ? evidence.nodeRuns : legacyNodeRuns;
  const attemptsByNodeId = evidence?.attemptsByNodeId instanceof Map
    ? evidence.attemptsByNodeId
    : (legacyAttemptsByNodeId instanceof Map ? legacyAttemptsByNodeId : new Map());
  const rawNodeRuns = Array.isArray(nodeRuns) ? nodeRuns : [];
  const safeNodeRuns = rawNodeRuns.slice(0, AGENT_RUN_NODE_LIMIT);
  const fallbackAttemptTotal = rawNodeRuns.reduce((sum, nodeRun) => (
    sum + (Array.isArray(attemptsByNodeId.get(String(nodeRun?.id)))
      ? attemptsByNodeId.get(String(nodeRun?.id)).length
      : 0)
  ), 0);
  const totals = {
    nodeRuns: Math.max(0, Math.trunc(boundedNumber(evidence?.totals?.nodeRuns, rawNodeRuns.length))),
    attempts: Math.max(0, Math.trunc(boundedNumber(evidence?.totals?.attempts, fallbackAttemptTotal))),
  };
  const evidenceReasons = Array.isArray(evidence?.evidenceReasons)
    ? evidence.evidenceReasons.map((reason) => safeText(reason, 'evidenceReason', 160))
    : [];
  const runId = publicEvidenceId(run?.id, 'runId');
  if (!runId) evidenceReasons.push('missing_real_run_id');
  const publicNodeRuns = safeNodeRuns.map((nodeRun) => {
    const nodeRunId = publicEvidenceId(nodeRun?.id, 'nodeRunId');
    if (!nodeRunId) evidenceReasons.push('missing_real_node_run_id');
    const nodeId = publicEvidenceId(nodeRun?.originalNodeId || nodeRun?.nodeId, 'nodeId');
    if (!nodeId) evidenceReasons.push('missing_real_node_id');
    const rawAttempts = (attemptsByNodeId.get(String(nodeRun?.id)) || [])
      .slice(-AGENT_RUN_ATTEMPT_LIMIT);
    const attempts = rawAttempts.map(publicAttempt);
    if (attempts.some((attempt) => !attempt.id)) evidenceReasons.push('missing_real_attempt_id');
    return {
      id: nodeRunId,
      nodeId: nodeId || '',
      status: safeText(nodeRun?.status, 'nodeRunStatus', 80),
      definitionId: nodeRun?.definitionId == null ? null : publicEvidenceId(nodeRun.definitionId, 'definitionId'),
      definitionVersion: nodeRun?.definitionVersion == null ? null : Math.max(1, Math.trunc(boundedNumber(nodeRun.definitionVersion, 1))),
      subflowDepth: Array.isArray(nodeRun?.subflowPath) ? nodeRun.subflowPath.length : 0,
      outputCount: Array.isArray(nodeRun?.outputRefs) ? nodeRun.outputRefs.length : 0,
      createdAt: Math.max(0, Math.trunc(boundedNumber(nodeRun?.createdAt))),
      updatedAt: Math.max(0, Math.trunc(boundedNumber(nodeRun?.updatedAt))),
      attempts,
    };
  });
  const returned = {
    nodeRuns: publicNodeRuns.length,
    attempts: publicNodeRuns.reduce((sum, nodeRun) => sum + nodeRun.attempts.length, 0),
  };
  const hasMore = {
    nodeRuns: evidence?.hasMore?.nodeRuns === true || safeNodeRuns.length < rawNodeRuns.length || totals.nodeRuns > returned.nodeRuns,
    attempts: evidence?.hasMore?.attempts === true || totals.attempts > returned.attempts,
  };
  if (hasMore.nodeRuns) evidenceReasons.push('node_runs_truncated');
  if (hasMore.attempts) evidenceReasons.push('attempts_truncated');
  const uniqueEvidenceReasons = [...new Set(evidenceReasons)];
  const selectedNodeRunId = evidence?.selection?.nodeRunId == null
    ? null
    : publicEvidenceId(evidence.selection.nodeRunId, 'selectedNodeRunId');
  const selectedAttemptId = evidence?.selection?.attemptId == null
    ? null
    : publicEvidenceId(evidence.selection.attemptId, 'selectedAttemptId');
  if (evidence?.selection?.nodeRunId != null && !selectedNodeRunId) uniqueEvidenceReasons.push('missing_real_node_run_id');
  if (evidence?.selection?.attemptId != null && !selectedAttemptId) uniqueEvidenceReasons.push('missing_real_attempt_id');
  const inspection = {
    schema: 't8-run-evidence-inspection-v1',
    id: runId || '',
    canvasId: safePublicId(run?.canvasId, 'canvasId'),
    canvasRevision: Math.max(0, Math.trunc(boundedNumber(run?.canvasRevision))),
    status: safeText(run?.status, 'runStatus', 80),
    initiatorId: safePublicId(run?.initiatorId, 'initiatorId'),
    parentRunId: run?.parentRunId == null ? null : safePublicId(run.parentRunId, 'parentRunId'),
    createdAt: Math.max(0, Math.trunc(boundedNumber(run?.createdAt))),
    startedAt: run?.startedAt == null ? null : Math.max(0, Math.trunc(boundedNumber(run.startedAt))),
    finishedAt: run?.finishedAt == null ? null : Math.max(0, Math.trunc(boundedNumber(run.finishedAt))),
    summary: safePatchValue(run?.summary || {}, 'runSummary'),
    selection: {
      runId: runId || '',
      nodeRunId: selectedNodeRunId,
      attemptId: selectedAttemptId,
    },
    totals,
    returned,
    hasMore,
    evidenceComplete: evidence?.evidenceComplete !== false
      && uniqueEvidenceReasons.length === 0
      && !hasMore.nodeRuns
      && !hasMore.attempts,
    evidenceReasons: uniqueEvidenceReasons,
    nodeRuns: publicNodeRuns,
    truncated: hasMore.nodeRuns || hasMore.attempts,
  };
  inspection.diagnosis = diagnosePublicRunEvidence(inspection, options);
  if (inspection.diagnosis.truncated === true) inspection.truncated = true;
  if (inspection.diagnosis.outcome === 'insufficient') {
    inspection.evidenceComplete = false;
    inspection.evidenceReasons = [...new Set([
      ...inspection.evidenceReasons,
      ...(inspection.diagnosis.evidenceReasons || []),
    ])];
  }
  return inspection;
}

function compactRunInspectionForBudget(value) {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const totals = {
    nodeRuns: Math.max(0, Math.trunc(boundedNumber(data?.totals?.nodeRuns))),
    attempts: Math.max(0, Math.trunc(boundedNumber(data?.totals?.attempts))),
  };
  const evidenceReasons = [...new Set([
    ...(Array.isArray(data.evidenceReasons) ? data.evidenceReasons.map(String) : []),
    'agent_tool_output_budget_exceeded',
  ])].slice(0, 20);
  return {
    schema: 't8-run-evidence-inspection-v1',
    id: typeof data.id === 'string' ? data.id : '',
    canvasId: typeof data.canvasId === 'string' ? data.canvasId : '',
    canvasRevision: Math.max(0, Math.trunc(boundedNumber(data.canvasRevision))),
    status: typeof data.status === 'string' ? data.status : '',
    selection: {
      runId: typeof data?.selection?.runId === 'string' ? data.selection.runId : '',
      nodeRunId: typeof data?.selection?.nodeRunId === 'string' ? data.selection.nodeRunId : null,
      attemptId: typeof data?.selection?.attemptId === 'string' ? data.selection.attemptId : null,
    },
    totals,
    returned: { nodeRuns: 0, attempts: 0 },
    hasMore: { nodeRuns: totals.nodeRuns > 0, attempts: totals.attempts > 0 },
    evidenceComplete: false,
    evidenceReasons,
    diagnosis: insufficientDiagnosis(evidenceReasons),
    nodeRuns: [],
    truncated: true,
    omitted: true,
    reason: 'agent_tool_output_budget_exceeded',
    originalDigest: digestAgentResult(data),
  };
}

function publicAssetSearchItem(asset) {
  const metadata = asset?.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
    ? asset.metadata
    : {};
  return {
    id: safePublicId(asset?.id, 'assetId'),
    kind: safeText(asset?.kind, 'assetKind', 80),
    filename: safeText(asset?.filename, 'filename', 240),
    storageMode: safeText(asset?.storageMode, 'storageMode', 40),
    availability: safeText(asset?.availability, 'availability', 40),
    tags: safeStringList(asset?.tags, 'tag', 20, 80),
    media: {
      width: metadata.width == null ? null : boundedNumber(metadata.width),
      height: metadata.height == null ? null : boundedNumber(metadata.height),
      duration: metadata.duration == null ? null : boundedNumber(metadata.duration),
      size: metadata.size == null ? null : Math.max(0, boundedNumber(metadata.size)),
    },
    createdAt: Math.max(0, Math.trunc(boundedNumber(asset?.createdAt))),
    updatedAt: Math.max(0, Math.trunc(boundedNumber(asset?.updatedAt))),
  };
}

function publicSubflowSearchItem(definition) {
  if (!definition || containsPlaintextSecret(definition)) return null;
  const rawInputs = Array.isArray(definition.inputs) ? definition.inputs : [];
  const rawOutputs = Array.isArray(definition.outputs) ? definition.outputs : [];
  const portIds = [...rawInputs, ...rawOutputs].map((port) => String(port?.id || ''));
  const safeForPlan = Array.isArray(definition.inputs)
    && Array.isArray(definition.outputs)
    && AGENT_PLAN_ID_PATTERN.test(String(definition.id || ''))
    && rawInputs.length <= 50
    && rawOutputs.length <= 50
    && portIds.every((id) => AGENT_PLAN_ID_PATTERN.test(id))
    && new Set(portIds).size === portIds.length
    && [...rawInputs, ...rawOutputs].every((port) => AGENT_PLAN_PORT_KINDS.has(String(port?.kind || '')));
  const safePorts = (ports, direction) => ports.slice(0, 50).map((port) => ({
    id: safePublicId(port?.id, `${direction}PortId`),
    name: safeText(port?.name, `${direction}PortName`, 120),
    kind: safeText(port?.kind, `${direction}PortKind`, 40),
    required: port?.required === true,
  }));
  return {
    id: safePublicId(definition.id, 'definitionId'),
    version: Math.max(1, Math.trunc(boundedNumber(definition.version, 1))),
    revision: Math.max(1, Math.trunc(boundedNumber(definition.revision || definition.version, 1))),
    name: safeText(definition.name, 'subflowName', 240),
    description: safeText(definition.description, 'subflowDescription', 500),
    category: safeText(definition.category, 'subflowCategory', 120),
    tags: safeStringList(definition.tags, 'subflowTag', 30, 80),
    inputs: safePorts(rawInputs, 'input'),
    outputs: safePorts(rawOutputs, 'output'),
    requiredCapabilities: safeStringList(definition.requiredCapabilities, 'requiredCapability', 30, 120),
    nodeCount: Array.isArray(definition.nodes) ? definition.nodes.length : 0,
    edgeCount: Array.isArray(definition.edges) ? definition.edges.length : 0,
    safeForPlan,
  };
}

function digestAgentResult(value) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function boundAgentToolResult(result) {
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, 'utf8') <= AGENT_TOOL_OUTPUT_BYTES) return result;
  const bounded = {
    ...result,
    data: result?.tool === 'inspectRun' ? compactRunInspectionForBudget(result.data) : {
      omitted: true,
      reason: 'agent_tool_output_budget_exceeded',
      originalDigest: digestAgentResult(result.data),
    },
    truncated: true,
  };
  delete bounded.digest;
  bounded.digest = digestAgentResult(bounded);
  return bounded;
}

module.exports = {
  AGENT_CANVAS_EDGE_LIMIT,
  AGENT_CANVAS_NODE_LIMIT,
  AGENT_RUN_ATTEMPT_LIMIT,
  AGENT_RUN_NODE_LIMIT,
  AGENT_SEARCH_LIMIT,
  AGENT_TOOL_OUTPUT_BYTES,
  boundAgentToolResult,
  digestAgentResult,
  publicAssetSearchItem,
  publicCanvasInspection,
  compactRunInspectionForBudget,
  publicEvidenceId,
  publicRunInspection,
  publicSubflowSearchItem,
  safePublicId,
  safeText,
};
