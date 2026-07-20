import type { Edge, Node } from '@xyflow/react';
import { workflowDisplayId } from './workflowDoctor.ts';

export const RUN_ACTION_PREVIEW_SCHEMA = 't8-run-action-preview-v1' as const;
export const RUN_ACTION_PREVIEW_DIGEST_ALGORITHM = 'fnv1a32-stable-json-v1' as const;

export type RunActionKind =
  | 'run-all'
  | 'run-group'
  | 'run-single'
  | 'replay-run'
  | 'replay-node-run'
  | 'replay-attempt'
  | 'replay-subflow'
  | 'retry-run'
  | 'retry-node-run'
  | 'retry-attempt'
  | 'retry-subflow'
  | 'run-intent'
  | 'run-intent-auto-approved';

/**
 * A persisted evidence identity. The union deliberately prevents an Attempt
 * from being cited without its owning NodeRun, or a NodeRun without its Run.
 */
export type RunEvidenceRef =
  | { runId: string; nodeRunId?: undefined; attemptId?: undefined }
  | { runId: string; nodeRunId: string; attemptId?: undefined }
  | { runId: string; nodeRunId: string; attemptId: string };

export type RunPreflightDiagnosticDomain = 'structure' | 'capability' | 'asset' | 'policy';
export type RunActionPreviewStatus = 'blocked' | 'confirmation-required' | 'ready';
export type RunPreflightNoticeDomain = RunPreflightDiagnosticDomain | 'action' | 'scope' | 'revision' | 'evidence' | 'cost';

export interface RunPreflightDiagnosticInput {
  id?: unknown;
  ruleId?: unknown;
  code?: unknown;
  severity: string;
  title?: unknown;
  message?: unknown;
  detail?: unknown;
  nodeIds?: readonly unknown[];
}

export interface RunPreflightDiagnosticsInput {
  structure: readonly RunPreflightDiagnosticInput[];
  capability: readonly RunPreflightDiagnosticInput[];
  asset: readonly RunPreflightDiagnosticInput[];
  policy: readonly RunPreflightDiagnosticInput[];
}

export type RunCostEstimateInput =
  | { known: true; amount: number; currency: string }
  | { known: false };

export type RunActionPreviewCost =
  | { known: true; amount: number; currency: string }
  | { known: false; reason: 'not-authoritatively-known' };

export interface RunEvidenceRefInput {
  runId?: unknown;
  nodeRunId?: unknown;
  attemptId?: unknown;
}

export interface PrepareRunActionInput {
  actionKind: RunActionKind;
  projectId: string;
  canvasId: string;
  currentRevision: number | null | undefined;
  expectedRevision: number | null | undefined;
  nodes: readonly Node[];
  edges: readonly Edge[];
  /** Caller supplies the exact executable scope after expanding all/group/single. */
  selectedNodeIds: readonly string[];
  /** Diagnostics must already be scoped to the proposed execution graph. */
  diagnostics: RunPreflightDiagnosticsInput;
  /** Optional completeness flags. An explicitly incomplete inventory fails closed. */
  diagnosticCoverage?: Partial<Record<RunPreflightDiagnosticDomain, boolean>>;
  cost: RunCostEstimateInput;
  evidenceRefs?: readonly RunEvidenceRefInput[];
  /** Required for every run-intent so authorization binds one persisted request. */
  requestId?: string | null;
  /** Safe SHA-256 projection of the freshly read host capability/asset/policy state. */
  hostContextDigest: string;
}

export interface RunPreflightNotice {
  domain: RunPreflightNoticeDomain;
  code: string;
  message: string;
  nodeIds: string[];
}

export interface RunActionPreviewScope {
  projectId: string;
  canvasId: string;
  currentRevision: number | null;
  expectedRevision: number | null;
  requestId: string | null;
  hostContextDigest: string | null;
  nodeIds: string[];
  selectedNodeCount: number;
  canvasNodeCount: number;
  canvasEdgeCount: number;
  nodeIdsTruncated: boolean;
  nodeSetDigest: string;
  executionGraphDigest: string;
}

export interface RunActionPreview {
  schema: typeof RUN_ACTION_PREVIEW_SCHEMA;
  actionKind: RunActionKind;
  status: RunActionPreviewStatus;
  requiresExplicitConfirmation: boolean;
  scope: RunActionPreviewScope;
  evidenceRefs: RunEvidenceRef[];
  cost: RunActionPreviewCost;
  blockers: RunPreflightNotice[];
  warnings: RunPreflightNotice[];
  digestAlgorithm: typeof RUN_ACTION_PREVIEW_DIGEST_ALGORITHM;
  digest: string;
}

const DIAGNOSTIC_DOMAINS = ['structure', 'capability', 'asset', 'policy'] as const;
const CONTROLLED_ACTIONS = new Set<RunActionKind>([
  'replay-run',
  'replay-node-run',
  'replay-attempt',
  'replay-subflow',
  'retry-run',
  'retry-node-run',
  'retry-attempt',
  'retry-subflow',
  'run-intent',
]);
const RUN_EVIDENCE_ACTIONS = new Set<RunActionKind>(['replay-run', 'retry-run']);
const NODE_RUN_EVIDENCE_ACTIONS = new Set<RunActionKind>([
  'replay-node-run',
  'replay-subflow',
  'retry-node-run',
  'retry-subflow',
]);
const ATTEMPT_EVIDENCE_ACTIONS = new Set<RunActionKind>(['replay-attempt', 'retry-attempt']);
const DOMAIN_LABELS: Record<RunPreflightDiagnosticDomain, string> = {
  structure: '画布结构',
  capability: 'Provider 能力与配置',
  asset: '素材',
  policy: '主机执行策略',
};

const MAX_SCOPE_NODE_IDS = 80;
const MAX_EVIDENCE_REFS = 20;
const MAX_DIAGNOSTICS_PER_DOMAIN = 100;
const MAX_NOTICES_PER_KIND = 32;
const MAX_GRAPH_ITEMS = 20_000;
const MAX_EVIDENCE_ID_LENGTH = 240;
const MAX_GRAPH_DATA_DEPTH = 10;
const MAX_GRAPH_DATA_FIELDS = 8_192;
const MAX_GRAPH_DATA_KEYS = 512;
const MAX_GRAPH_DATA_ARRAY_ITEMS = 2_048;
const MAX_GRAPH_DATA_URL_LENGTH = 4_096;

const SENSITIVE_DATA_KEY = /(?:api[-_ ]?key|access[-_ ]?key|secret|token|credential|password|passwd|authorization|cookie|session|signature|private[-_ ]?key|client[-_ ]?secret)/i;
const EXPLICIT_SECRET_VALUE = /^(?:bearer\s+|basic\s+|sk[-_]|sk-proj-|gh[opusr]_|AIza|AKIA|ASIA|xox[baprs]-)/i;
const ABSOLUTE_LOCAL_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/Users\/|\/home\/|\/var\/|\/tmp\/|\/etc\/)/;
const BASE64_OR_DATA_URL = /^(?:data:[^;,]{1,120}(?:;[^;,]{1,80})*;base64,|[A-Za-z0-9+/]{512,}={0,2}$)/i;

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

function fnv1a32(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function digestValue(value: unknown) {
  return `fnv1a32:${fnv1a32(stableSerialize(value))}`;
}

function looksLikeOpaqueCredential(value: string) {
  return value.length >= 24
    && /[a-z]/.test(value)
    && /[A-Z]/.test(value)
    && /\d/.test(value)
    && /^[A-Za-z0-9._~+/=-]+$/.test(value);
}

function safeStringSummary(value: string, sensitiveField: boolean): unknown {
  const trimmed = value.trim();
  if (sensitiveField || EXPLICIT_SECRET_VALUE.test(trimmed) || looksLikeOpaqueCredential(trimmed)) {
    return { kind: 'credential', configured: trimmed.length > 0 };
  }
  if (BASE64_OR_DATA_URL.test(trimmed)) {
    const mime = /^data:([^;,]{1,120})/i.exec(trimmed)?.[1]?.toLowerCase() || null;
    return {
      kind: 'binary',
      mime,
      length: value.length,
    };
  }
  if (ABSOLUTE_LOCAL_PATH.test(trimmed)) {
    return {
      kind: 'local-path',
      length: value.length,
      fingerprint: fnv1a32(value),
    };
  }
  if (/^https?:\/\//i.test(trimmed) && trimmed.length <= MAX_GRAPH_DATA_URL_LENGTH) {
    try {
      const parsed = new URL(trimmed);
      const query = [...parsed.searchParams.entries()]
        .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
          leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
        ))
        .slice(0, MAX_GRAPH_DATA_KEYS)
        .map(([key, queryValue]) => [
          safeDisplay(key),
          safeStringSummary(queryValue, SENSITIVE_DATA_KEY.test(key)),
        ]);
      return {
        kind: 'url',
        protocol: parsed.protocol.toLowerCase(),
        host: parsed.host.toLowerCase(),
        pathname: {
          length: parsed.pathname.length,
          fingerprint: fnv1a32(parsed.pathname),
        },
        query,
        queryCount: [...parsed.searchParams.keys()].length,
      };
    } catch {
      // Fall through to an opaque text fingerprint. The raw URL is never
      // inserted into the stable canonical form.
    }
  }
  return {
    kind: 'text',
    length: value.length,
    fingerprint: fnv1a32(value),
  };
}

interface GraphDataBudget {
  remaining: number;
  active: WeakSet<object>;
  complete: boolean;
}

function safeGraphDataSummary(
  value: unknown,
  budget: GraphDataBudget,
  depth = 0,
  sensitiveField = false,
): unknown {
  if (budget.remaining <= 0) {
    budget.complete = false;
    return { kind: 'truncated', reason: 'field-budget' };
  }
  budget.remaining -= 1;
  if (value === null) return null;
  if (typeof value === 'string') return safeStringSummary(value, sensitiveField);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { kind: 'number', value: String(value) };
  if (typeof value === 'bigint') return { kind: 'bigint', value: value.toString() };
  if (typeof value === 'undefined') return { kind: 'undefined' };
  if (typeof value === 'function') return { kind: 'function' };
  if (typeof value === 'symbol') return { kind: 'symbol', description: safeDisplay(value.description || '') };
  if (typeof value !== 'object') return { kind: typeof value };
  if (depth >= MAX_GRAPH_DATA_DEPTH) {
    budget.complete = false;
    return { kind: 'truncated', reason: 'depth' };
  }
  if (value instanceof ArrayBuffer) {
    return { kind: 'binary-buffer', bytes: value.byteLength };
  }
  if (ArrayBuffer.isView(value)) {
    return { kind: 'binary-view', bytes: value.byteLength };
  }
  if (budget.active.has(value)) return { kind: 'cycle' };
  budget.active.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_GRAPH_DATA_ARRAY_ITEMS).map((item) => (
        safeGraphDataSummary(item, budget, depth + 1, sensitiveField)
      ));
      if (value.length > items.length) budget.complete = false;
      return {
        kind: 'array',
        length: value.length,
        items,
        truncated: value.length > items.length,
      };
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort((left, right) => left.localeCompare(right));
    const entries = keys.slice(0, MAX_GRAPH_DATA_KEYS).map((key) => {
      const descriptor = descriptors[key];
      const safeKey = safeDisplay(key);
      if (!descriptor || !('value' in descriptor)) return [safeKey, { kind: 'accessor' }];
      return [
        safeKey,
        safeGraphDataSummary(descriptor.value, budget, depth + 1, sensitiveField || SENSITIVE_DATA_KEY.test(key)),
      ];
    });
    if (keys.length > entries.length) budget.complete = false;
    return {
      kind: 'object',
      keyCount: keys.length,
      entries,
      truncated: keys.length > entries.length || budget.remaining <= 0,
    };
  } catch {
    budget.complete = false;
    return { kind: 'uninspectable-object' };
  } finally {
    budget.active.delete(value);
  }
}

function graphDataDigest(value: unknown) {
  const budget: GraphDataBudget = {
    remaining: MAX_GRAPH_DATA_FIELDS,
    active: new WeakSet<object>(),
    complete: true,
  };
  const summary = safeGraphDataSummary(value, budget);
  return {
    digest: digestValue(summary),
    complete: budget.complete,
  };
}

function executionGraphDigest(nodes: readonly Node[], edges: readonly Edge[], nodeCount: number, edgeCount: number) {
  let complete = nodeCount <= nodes.length && edgeCount <= edges.length;
  const nodeDigests = nodes.map((node) => {
    const data = graphDataDigest(node?.data);
    complete = complete && data.complete;
    return digestValue({
      id: safeDisplay(node?.id),
      type: safeDisplay(node?.type || ''),
      data: data.digest,
    });
  }).sort((left, right) => left.localeCompare(right));
  const edgeDigests = edges.map((edge) => {
    const data = graphDataDigest(edge?.data);
    complete = complete && data.complete;
    return digestValue({
      id: safeDisplay(edge?.id),
      source: safeDisplay(edge?.source),
      sourceHandle: edge?.sourceHandle == null ? null : safeDisplay(edge.sourceHandle),
      target: safeDisplay(edge?.target),
      targetHandle: edge?.targetHandle == null ? null : safeDisplay(edge.targetHandle),
      type: safeDisplay(edge?.type || ''),
      data: data.digest,
    });
  }).sort((left, right) => left.localeCompare(right));
  return {
    digest: digestValue({
      nodeCount,
      edgeCount,
      nodes: nodeDigests,
      edges: edgeDigests,
      truncated: !complete,
    }),
    complete,
  };
}

function safeDisplay(value: unknown) {
  return workflowDisplayId(value);
}

function safeCode(value: unknown, fallback: string) {
  return (safeDisplay(value) || fallback)
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || fallback;
}

function safeSortedIds(values: readonly unknown[], limit = Number.POSITIVE_INFINITY) {
  return [...new Set(values
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .map(safeDisplay))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, limit);
}

function notice(
  domain: RunPreflightNoticeDomain,
  code: string,
  message: string,
  nodeIds: readonly unknown[] = [],
): RunPreflightNotice {
  return {
    domain,
    code: safeCode(code, `${domain}.unspecified`),
    message: safeDisplay(message),
    nodeIds: safeSortedIds(nodeIds, MAX_SCOPE_NODE_IDS),
  };
}

function noticeKey(value: RunPreflightNotice) {
  return `${value.domain}\u0000${value.code}\u0000${value.message}\u0000${value.nodeIds.join('\u0001')}`;
}

function boundedNotices(values: RunPreflightNotice[], kind: 'blocker' | 'warning') {
  const sorted = [...new Map(values.map((value) => [noticeKey(value), value])).values()]
    .sort((left, right) => noticeKey(left).localeCompare(noticeKey(right)));
  if (sorted.length <= MAX_NOTICES_PER_KIND) return sorted;
  const omitted = sorted.length - (MAX_NOTICES_PER_KIND - 1);
  return [
    ...sorted.slice(0, MAX_NOTICES_PER_KIND - 1),
    notice(
      'scope',
      `${kind}.notice-list-truncated`,
      `${kind === 'blocker' ? '阻断项' : '警告'}过多，预览已有界省略 ${omitted} 项；不得据此推断被省略内容。`,
    ),
  ];
}

function parseRevision(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function evidenceLevel(value: RunEvidenceRef) {
  return value.attemptId ? 3 : value.nodeRunId ? 2 : 1;
}

function normalizeEvidenceRefs(input: readonly RunEvidenceRefInput[] | undefined, blockers: RunPreflightNotice[]) {
  if (!Array.isArray(input)) return [] as RunEvidenceRef[];
  if (input.length > MAX_EVIDENCE_REFS) {
    blockers.push(notice('evidence', 'evidence.too-many', `运行证据超过 ${MAX_EVIDENCE_REFS} 条有界上限，无法绑定精确预览。`));
  }
  const output: RunEvidenceRef[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of input.slice(0, MAX_EVIDENCE_REFS).entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      blockers.push(notice('evidence', 'evidence.invalid-ref', `第 ${index + 1} 条运行证据不是有效对象。`));
      continue;
    }
    const unexpectedFields = Object.keys(candidate).filter((key) => (
      key !== 'runId' && key !== 'nodeRunId' && key !== 'attemptId'
    ));
    if (unexpectedFields.length > 0) {
      blockers.push(notice(
        'evidence',
        'evidence.unexpected-field',
        `第 ${index + 1} 条运行证据包含契约外字段，无法证明其身份唯一。`,
      ));
      continue;
    }
    const runProvided = Object.prototype.hasOwnProperty.call(candidate, 'runId');
    const nodeRunProvided = Object.prototype.hasOwnProperty.call(candidate, 'nodeRunId');
    const attemptProvided = Object.prototype.hasOwnProperty.call(candidate, 'attemptId');
    const runId = typeof candidate.runId === 'string' ? candidate.runId.trim() : '';
    const nodeRunId = typeof candidate.nodeRunId === 'string' ? candidate.nodeRunId.trim() : '';
    const attemptId = typeof candidate.attemptId === 'string' ? candidate.attemptId.trim() : '';
    if (!runProvided || !runId || runId.length > MAX_EVIDENCE_ID_LENGTH
      || (nodeRunProvided && (!nodeRunId || nodeRunId.length > MAX_EVIDENCE_ID_LENGTH))
      || (attemptProvided && (!attemptId || attemptId.length > MAX_EVIDENCE_ID_LENGTH))
      || (attemptProvided && !nodeRunProvided)) {
      blockers.push(notice(
        'evidence',
        'evidence.incomplete-ref',
        `第 ${index + 1} 条运行证据不完整：Attempt 必须同时引用所属 NodeRun 与 Run。`,
      ));
      continue;
    }
    const evidenceKey = `${runId}\u0000${nodeRunProvided ? nodeRunId : ''}\u0000${attemptProvided ? attemptId : ''}`;
    if (seen.has(evidenceKey)) {
      blockers.push(notice('evidence', 'evidence.duplicate-ref', `第 ${index + 1} 条运行证据与前项重复。`));
      continue;
    }
    seen.add(evidenceKey);
    if (attemptProvided) {
      output.push({ runId: safeDisplay(runId), nodeRunId: safeDisplay(nodeRunId), attemptId: safeDisplay(attemptId) });
    } else if (nodeRunProvided) {
      output.push({ runId: safeDisplay(runId), nodeRunId: safeDisplay(nodeRunId) });
    } else {
      output.push({ runId: safeDisplay(runId) });
    }
  }
  return output.sort((left, right) => (
    left.runId.localeCompare(right.runId)
    || String(left.nodeRunId || '').localeCompare(String(right.nodeRunId || ''))
    || String(left.attemptId || '').localeCompare(String(right.attemptId || ''))
  ));
}

function validateRequiredEvidence(
  actionKind: RunActionKind,
  refs: RunEvidenceRef[],
  blockers: RunPreflightNotice[],
) {
  const requiredLevel = ATTEMPT_EVIDENCE_ACTIONS.has(actionKind)
    ? 3
    : NODE_RUN_EVIDENCE_ACTIONS.has(actionKind)
      ? 2
      : RUN_EVIDENCE_ACTIONS.has(actionKind)
        ? 1
        : 0;
  const runIds = new Set(refs.map((ref) => ref.runId));
  if (runIds.size > 1) {
    blockers.push(notice('evidence', 'evidence.cross-run', '一次执行预览不能混用多个 Run 的证据。'));
  }
  if (!requiredLevel && refs.length > 0) {
    blockers.push(notice('evidence', 'evidence.unexpected-for-action', '该执行操作不接受额外 Run 证据。'));
    return;
  }
  if (!requiredLevel) return;
  if (refs.length === 0) {
    blockers.push(notice(
      'evidence',
      'evidence.required-ref-missing',
      requiredLevel === 3
        ? '该 Attempt 重试必须绑定精确的 Run / NodeRun / Attempt 证据。'
        : requiredLevel === 2
          ? '该节点或子工作流重试必须绑定精确的 Run / NodeRun 证据。'
          : '该 Run 重放必须绑定精确的 Run 证据。',
    ));
    return;
  }
  if (refs.length !== 1) {
    blockers.push(notice(
      'evidence',
      'evidence.ambiguous-cardinality',
      '一次重试或重放必须只绑定一条精确证据，不得混入高低层级或额外候选。',
    ));
  }
  const mismatched = refs.filter((ref) => evidenceLevel(ref) !== requiredLevel);
  if (mismatched.length > 0) {
    blockers.push(notice(
      'evidence',
      'evidence.level-mismatch',
      requiredLevel === 3
        ? 'Attempt 重试或重放只接受唯一的 Run / NodeRun / Attempt 三元证据。'
        : requiredLevel === 2
          ? 'NodeRun 或子工作流重试/重放只接受唯一的 Run / NodeRun 二元证据。'
          : 'Run 重试或重放只接受唯一的 Run 证据，不得混入 NodeRun 或 Attempt。',
    ));
  }
}

function normalizeCost(input: RunCostEstimateInput, blockers: RunPreflightNotice[], warnings: RunPreflightNotice[]): RunActionPreviewCost {
  if (!input || typeof input !== 'object' || !('known' in input)) {
    blockers.push(notice('cost', 'cost.contract-missing', '费用估算契约缺失；不得猜测价格。'));
    return { known: false, reason: 'not-authoritatively-known' };
  }
  if (input.known !== true) {
    if (input.known !== false) blockers.push(notice('cost', 'cost.contract-invalid', '费用估算状态无效；不得猜测价格。'));
    warnings.push(notice('cost', 'cost.unknown', '未获得权威费用估算，预览不会推断调用次数或价格。'));
    return { known: false, reason: 'not-authoritatively-known' };
  }
  const amount = Number(input.amount);
  const currency = typeof input.currency === 'string' ? input.currency.trim() : '';
  if (!Number.isFinite(amount) || amount < 0 || !/^[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(currency)) {
    blockers.push(notice('cost', 'cost.authoritative-value-invalid', '权威费用估算的数值或币种无效；不得使用默认值替代。'));
    return { known: false, reason: 'not-authoritatively-known' };
  }
  return { known: true, amount, currency };
}

function diagnosticSummary(value: RunPreflightDiagnosticInput) {
  return safeDisplay(value.title ?? value.message ?? value.detail ?? value.ruleId ?? value.code ?? value.id ?? '未提供安全摘要');
}

function appendDiagnostics(
  diagnostics: RunPreflightDiagnosticsInput,
  coverage: PrepareRunActionInput['diagnosticCoverage'],
  blockers: RunPreflightNotice[],
  warnings: RunPreflightNotice[],
) {
  for (const domain of DIAGNOSTIC_DOMAINS) {
    if (coverage?.[domain] === false) {
      blockers.push(notice(
        domain,
        `${domain}.inventory-incomplete`,
        `${DOMAIN_LABELS[domain]}体检上下文不完整，无法证明本次执行安全。`,
      ));
    }
    const items = diagnostics?.[domain];
    if (!Array.isArray(items)) {
      blockers.push(notice(domain, `${domain}.diagnostics-missing`, `${DOMAIN_LABELS[domain]}体检结果缺失。`));
      continue;
    }
    if (items.length > MAX_DIAGNOSTICS_PER_DOMAIN) {
      blockers.push(notice(
        domain,
        `${domain}.diagnostics-overflow`,
        `${DOMAIN_LABELS[domain]}体检结果超过 ${MAX_DIAGNOSTICS_PER_DOMAIN} 条有界上限，无法证明未省略错误。`,
      ));
    }
    for (const [index, item] of items.slice(0, MAX_DIAGNOSTICS_PER_DOMAIN).entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        blockers.push(notice(domain, `${domain}.diagnostic-invalid`, `${DOMAIN_LABELS[domain]}第 ${index + 1} 条体检结果无效。`));
        continue;
      }
      const code = `${domain}.${safeCode(item.ruleId ?? item.code ?? item.id, 'unspecified')}`;
      const nodeIds = Array.isArray(item.nodeIds) ? item.nodeIds : [];
      if (item.severity === 'error') {
        blockers.push(notice(domain, code, `${DOMAIN_LABELS[domain]}阻断：${diagnosticSummary(item)}`, nodeIds));
      } else if (item.severity === 'warning') {
        warnings.push(notice(domain, code, `${DOMAIN_LABELS[domain]}警告：${diagnosticSummary(item)}`, nodeIds));
      } else if (item.severity !== 'info') {
        blockers.push(notice(domain, `${domain}.diagnostic-severity-invalid`, `${DOMAIN_LABELS[domain]}体检严重度无效。`, nodeIds));
      }
    }
  }
}

function validateGraphScope(input: PrepareRunActionInput, blockers: RunPreflightNotice[], warnings: RunPreflightNotice[]) {
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const edges = Array.isArray(input.edges) ? input.edges : [];
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    blockers.push(notice('scope', 'scope.graph-missing', '执行图节点或连线契约缺失。'));
  }
  if (nodes.length > MAX_GRAPH_ITEMS || edges.length > MAX_GRAPH_ITEMS) {
    blockers.push(notice('scope', 'scope.graph-overflow', `执行图超过 ${MAX_GRAPH_ITEMS} 项有界体检上限。`));
  }
  const consideredNodes = nodes.slice(0, MAX_GRAPH_ITEMS);
  const rawNodeIds = consideredNodes.map((node) => typeof node?.id === 'string' ? node.id : '');
  if (rawNodeIds.some((id) => !id)) blockers.push(notice('structure', 'structure.node-id-missing', '执行图包含缺少稳定 ID 的节点。'));
  const nodeIdSet = new Set(rawNodeIds.filter(Boolean));
  if (nodeIdSet.size !== rawNodeIds.filter(Boolean).length) {
    blockers.push(notice('structure', 'structure.duplicate-node-id', '执行图包含重复节点 ID。'));
  }

  const selectedInput = Array.isArray(input.selectedNodeIds) ? input.selectedNodeIds : [];
  const selectedRaw = Array.isArray(input.selectedNodeIds)
    ? [...new Set(selectedInput
      .slice(0, MAX_GRAPH_ITEMS)
      .map((id) => String(id ?? '').trim())
      .filter(Boolean))]
    : [];
  if (!Array.isArray(input.selectedNodeIds) || selectedRaw.length === 0) {
    blockers.push(notice('scope', 'scope.no-executable-node', '本次操作没有明确的可执行节点范围。'));
  }
  if (selectedInput.length > MAX_GRAPH_ITEMS) {
    blockers.push(notice('scope', 'scope.selection-overflow', `执行范围超过 ${MAX_GRAPH_ITEMS} 个节点有界上限。`));
  }
  const selectedConsidered = selectedRaw;
  const missing = selectedConsidered.filter((id) => !nodeIdSet.has(id));
  if (missing.length) {
    blockers.push(notice('scope', 'scope.node-not-in-graph', '执行范围引用了当前执行图中不存在的节点。', missing));
  }
  if (input.actionKind === 'run-single' && selectedRaw.length !== 1) {
    blockers.push(notice('scope', 'scope.single-node-required', '单节点运行必须精确选择 1 个节点。'));
  }

  for (const edge of edges.slice(0, MAX_GRAPH_ITEMS)) {
    const source = typeof edge?.source === 'string' ? edge.source : '';
    const target = typeof edge?.target === 'string' ? edge.target : '';
    if (!source || !target || !nodeIdSet.has(source) || !nodeIdSet.has(target)) {
      blockers.push(notice('structure', 'structure.dangling-edge', '执行图包含缺失端点或引用不存在节点的连线。', [source, target]));
      break;
    }
  }

  const allSafeSelected = safeSortedIds(selectedConsidered);
  if (allSafeSelected.length > MAX_SCOPE_NODE_IDS) {
    warnings.push(notice(
      'scope',
      'scope.node-list-truncated',
      `执行范围共 ${allSafeSelected.length} 个节点，预览只展示前 ${MAX_SCOPE_NODE_IDS} 个；摘要仍绑定完整节点集。`,
    ));
  }
  const graphDigest = executionGraphDigest(
    consideredNodes,
    edges.slice(0, MAX_GRAPH_ITEMS),
    nodes.length,
    edges.length,
  );
  if (!graphDigest.complete) {
    blockers.push(notice(
      'scope',
      'scope.graph-data-overflow',
      '执行相关节点 data 或连线摘要超过有界上限，必须缩小/持久化输入后重新体检。',
    ));
  }
  return {
    nodeIds: allSafeSelected.slice(0, MAX_SCOPE_NODE_IDS),
    selectedNodeCount: selectedInput.length,
    canvasNodeCount: nodes.length,
    canvasEdgeCount: edges.length,
    nodeIdsTruncated: allSafeSelected.length > MAX_SCOPE_NODE_IDS,
    nodeSetDigest: digestValue({
      selectedNodeCount: selectedInput.length,
      nodeIds: allSafeSelected,
      truncated: selectedInput.length > selectedRaw.length,
    }),
    executionGraphDigest: graphDigest.digest,
  };
}

/**
 * Deterministic, synchronous and side-effect-free run gate. It performs no
 * Provider request, network call or persistence; callers may execute only
 * after interpreting the returned status and, when required, confirming the
 * exact preview digest.
 */
export function prepareRunAction(input: PrepareRunActionInput): RunActionPreview {
  const blockers: RunPreflightNotice[] = [];
  const warnings: RunPreflightNotice[] = [];
  const currentRevision = parseRevision(input.currentRevision);
  const expectedRevision = parseRevision(input.expectedRevision);
  if (currentRevision === null || expectedRevision === null) {
    blockers.push(notice('revision', 'revision.missing', '当前与预期画布 revision 必须都是明确的非负整数。'));
  } else if (currentRevision !== expectedRevision) {
    blockers.push(notice('revision', 'revision.changed', '画布 revision 已变化，必须重新体检并生成新预览。'));
  }
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
  const canvasId = typeof input.canvasId === 'string' ? input.canvasId.trim() : '';
  if (!projectId || !canvasId) blockers.push(notice('scope', 'scope.identity-missing', '项目或画布身份缺失，无法绑定执行预览。'));

  const graphScope = validateGraphScope(input, blockers, warnings);
  appendDiagnostics(input.diagnostics, input.diagnosticCoverage, blockers, warnings);
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs, blockers);
  validateRequiredEvidence(input.actionKind, evidenceRefs, blockers);

  const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
  if ((input.actionKind === 'run-intent' || input.actionKind === 'run-intent-auto-approved') && !requestId) {
    blockers.push(notice('evidence', 'run-intent.request-id-missing', '接受远程运行意图必须绑定精确的请求 ID。'));
  }

  const hostContextDigest = typeof input.hostContextDigest === 'string'
    ? input.hostContextDigest.trim().toLowerCase()
    : '';
  if (!hostContextDigest) {
    blockers.push(notice('scope', 'scope.host-context-digest-missing', '主机能力、素材与策略摘要缺失，无法绑定执行预览。'));
  } else if (!/^sha256:[a-f0-9]{64}$/.test(hostContextDigest)) {
    blockers.push(notice('scope', 'scope.host-context-digest-invalid', '主机上下文摘要格式无效，已停止执行。'));
  }

  const cost = normalizeCost(input.cost, blockers, warnings);
  if (CONTROLLED_ACTIONS.has(input.actionKind)) {
    warnings.push(notice(
      'action',
      'action.explicit-confirmation-required',
      input.actionKind === 'run-intent'
        ? '这是远程运行意图；必须核对请求、revision、节点范围与费用后明确确认。'
        : '这是重放或重试操作；必须核对原证据、revision、节点范围与费用后明确确认。',
    ));
  }

  const boundedBlockers = boundedNotices(blockers, 'blocker');
  const boundedWarnings = boundedNotices(warnings, 'warning');
  // Advisory diagnostics remain visible in the durable preview, but ordinary
  // creation runs must not be interrupted for notices such as cost.unknown or
  // a credential that can only be resolved by the host at dispatch time.
  // Replay/retry and remote RunIntent actions retain explicit digest-bound
  // confirmation because they act on historical or remote authority.
  const requiresExplicitConfirmation = CONTROLLED_ACTIONS.has(input.actionKind);
  const status: RunActionPreviewStatus = boundedBlockers.length
    ? 'blocked'
    : requiresExplicitConfirmation
      ? 'confirmation-required'
      : 'ready';
  const previewWithoutDigest = {
    schema: RUN_ACTION_PREVIEW_SCHEMA,
    actionKind: input.actionKind,
    status,
    requiresExplicitConfirmation,
    scope: {
      projectId: safeDisplay(projectId),
      canvasId: safeDisplay(canvasId),
      currentRevision,
      expectedRevision,
      requestId: requestId ? safeDisplay(requestId) : null,
      hostContextDigest: /^sha256:[a-f0-9]{64}$/.test(hostContextDigest) ? hostContextDigest : null,
      ...graphScope,
    },
    evidenceRefs,
    cost,
    blockers: boundedBlockers,
    warnings: boundedWarnings,
    digestAlgorithm: RUN_ACTION_PREVIEW_DIGEST_ALGORITHM,
  } satisfies Omit<RunActionPreview, 'digest'>;
  return {
    ...previewWithoutDigest,
    digest: digestValue(previewWithoutDigest),
  };
}
