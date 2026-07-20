import type { Edge, Node, NodeChange } from '@xyflow/react';
import type { RunAttemptSummary, RunDetail, NodeRunSummary } from '../types/project';

export const RUN_NODE_INPUT_SNAPSHOT_SCHEMA = 't8-run-node-input-v1' as const;

const MAX_REPLAY_NODES = 80;
const MAX_REPLAY_EDGES = 90;
const MAX_REPLAY_ARRAY_ITEMS = 100;
const MAX_REPLAY_OBJECT_KEYS = 200;
const MAX_REPLAY_STRING_LENGTH = 4000;
const MAX_REPLAY_DEPTH = 7;
const SECRET_KEY_PATTERN = /(?:api[-_]?key|authorization|cookie|token|secret|password|credential|access[-_]?key|refresh[-_]?token)/i;
const SIGNED_QUERY_PATTERN = /(?:signature|sig|token|key|credential|expires)=/i;
const REDACTION_PLACEHOLDER_PATTERN = /(?:\[redacted|%5bredacted%5d|base64 omitted|max depth|\[circular\])/i;

export interface RunReplayNodeSnapshot {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface RunReplayEdgeSnapshot {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  data?: Record<string, unknown>;
}

export interface ReplayableRunNodeInputSnapshot {
  schema: typeof RUN_NODE_INPUT_SNAPSHOT_SCHEMA;
  replayable: true;
  node: RunReplayNodeSnapshot;
  upstreamNodes: RunReplayNodeSnapshot[];
  incomingEdges: RunReplayEdgeSnapshot[];
}

export interface UnreplayableRunNodeInputSnapshot {
  schema: typeof RUN_NODE_INPUT_SNAPSHOT_SCHEMA;
  replayable: false;
  nodeId: string;
  nodeType: string;
  reason: string;
}

export type RunNodeInputSnapshot = ReplayableRunNodeInputSnapshot | UnreplayableRunNodeInputSnapshot;

export interface RunReplayExecutionContext {
  subflowPath: string[];
  originalNodeId: string;
  runNodeId: string;
  definitionId?: string;
  definitionVersion?: number;
  inputSnapshot: Record<string, unknown>;
  parentNodeRunId?: string;
}

export interface RunReplayRuntimeGraph {
  nodes: Node[];
  edges: Edge[];
  executionNodeIds: string[];
  originalNodeIdByRuntimeId: Record<string, string>;
  executionContexts: Record<string, RunReplayExecutionContext>;
}

export interface SubflowNodeRunReplayRuntimeGraph extends RunReplayRuntimeGraph {
  parentNodeRun: NodeRunSummary;
  sourceNodeRun: NodeRunSummary;
}

export interface RunAttemptReplayRuntimeGraph extends RunReplayRuntimeGraph {
  parentNodeRun?: NodeRunSummary;
  sourceNodeRun: NodeRunSummary;
  sourceAttempt: RunAttemptSummary;
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function omitEmptySecretFields(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    value.forEach((item) => output.push(omitEmptySecretFields(item, seen)));
    return output;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key) && (item == null || item === '')) continue;
    output[key] = omitEmptySecretFields(item, seen);
  }
  return output;
}

function originalNodeId(node: Node): string {
  const replayOriginalId = (node as Node & { __runReplayOriginalNodeId?: unknown }).__runReplayOriginalNodeId;
  return typeof replayOriginalId === 'string' && replayOriginalId ? replayOriginalId : node.id;
}

function replaySafetyError(value: unknown, path = 'data', depth = 0, seen = new WeakSet<object>()): string | null {
  if (depth > MAX_REPLAY_DEPTH) return `${path} 层级超过 ${MAX_REPLAY_DEPTH}`;
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path} 含非有限数字`;
  if (typeof value === 'string') {
    if (REDACTION_PLACEHOLDER_PATTERN.test(value)) return `${path} 已被脱敏或截断`;
    if (/^data:[^;,]+;base64,/i.test(value)) return `${path} 含 base64，运行记录不会保存原文`;
    if (value.length > MAX_REPLAY_STRING_LENGTH) return `${path} 超过 ${MAX_REPLAY_STRING_LENGTH} 字符`;
    try {
      const url = new URL(value);
      if (SIGNED_QUERY_PATTERN.test(url.search.slice(1))) return `${path} 含签名查询参数`;
    } catch (_) {
      // 普通文本不是 URL。
    }
    return null;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return `${path} 含不能安全保存的 ${typeof value}`;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_REPLAY_ARRAY_ITEMS) return `${path} 超过 ${MAX_REPLAY_ARRAY_ITEMS} 项`;
    for (let index = 0; index < value.length; index += 1) {
      const error = replaySafetyError(value[index], `${path}[${index}]`, depth + 1, seen);
      if (error) return error;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${path} 不是普通 JSON 对象`;
  if (seen.has(value)) return `${path} 存在循环引用`;
  seen.add(value);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_REPLAY_OBJECT_KEYS) {
    seen.delete(value);
    return `${path} 超过 ${MAX_REPLAY_OBJECT_KEYS} 个字段`;
  }
  for (const [key, item] of entries) {
    if (SECRET_KEY_PATTERN.test(key)) {
      seen.delete(value);
      return `${path}.${key} 是私密字段`;
    }
    const error = replaySafetyError(item, `${path}.${key}`, depth + 1, seen);
    if (error) {
      seen.delete(value);
      return error;
    }
  }
  seen.delete(value);
  return null;
}

function snapshotNode(node: Node): RunReplayNodeSnapshot {
  return {
    id: originalNodeId(node),
    type: String(node.type || 'placeholder'),
    position: {
      x: Number(node.position?.x) || 0,
      y: Number(node.position?.y) || 0,
    },
    data: omitEmptySecretFields(node.data || {}) as Record<string, unknown>,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRunReplayNodeSnapshot(value: unknown): value is RunReplayNodeSnapshot {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.type !== 'string' || !value.type) return false;
  if (!isRecord(value.position) || !Number.isFinite(value.position.x) || !Number.isFinite(value.position.y)) return false;
  return isRecord(value.data);
}

function isRunReplayEdgeSnapshot(value: unknown): value is RunReplayEdgeSnapshot {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.source !== 'string' || typeof value.target !== 'string') return false;
  if (value.sourceHandle != null && typeof value.sourceHandle !== 'string') return false;
  if (value.targetHandle != null && typeof value.targetHandle !== 'string') return false;
  return value.data == null || isRecord(value.data);
}

export function captureRunNodeInputSnapshot(nodes: Node[], edges: Edge[], nodeId: string): RunNodeInputSnapshot {
  const target = nodes.find((node) => node.id === nodeId);
  if (!target) {
    return {
      schema: RUN_NODE_INPUT_SNAPSHOT_SCHEMA,
      replayable: false,
      nodeId,
      nodeType: 'unknown',
      reason: '触发时节点已不在 ReactFlow 运行图中',
    };
  }
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const incomingByTarget = new Map<string, Edge[]>();
  edges.forEach((edge) => incomingByTarget.set(edge.target, [...(incomingByTarget.get(edge.target) || []), edge]));
  const visited = new Set<string>([nodeId]);
  const queue = [nodeId];
  const capturedEdges = new Map<string, Edge>();
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of incomingByTarget.get(current) || []) {
      capturedEdges.set(edge.id, edge);
      if (!visited.has(edge.source) && nodesById.has(edge.source)) {
        visited.add(edge.source);
        queue.push(edge.source);
      }
    }
  }
  const upstream = [...visited].filter((id) => id !== nodeId).map((id) => nodesById.get(id)!).filter(Boolean);
  if (upstream.length + 1 > MAX_REPLAY_NODES || capturedEdges.size > MAX_REPLAY_EDGES) {
    return {
      schema: RUN_NODE_INPUT_SNAPSHOT_SCHEMA,
      replayable: false,
      nodeId: originalNodeId(target),
      nodeType: String(target.type || 'unknown'),
      reason: `输入子图超过可安全保存上限（${upstream.length + 1} 节点 / ${capturedEdges.size} 连线）`,
    };
  }
  const originalIds = new Map(nodes.map((node) => [node.id, originalNodeId(node)]));
  const nodeSnapshots = [target, ...upstream].map(snapshotNode);
  const incomingEdges = [...capturedEdges.values()].map((edge) => {
    const snapshot: RunReplayEdgeSnapshot = {
      id: String(edge.id),
      source: originalIds.get(edge.source) || edge.source,
      target: originalIds.get(edge.target) || edge.target,
    };
    if (edge.sourceHandle !== undefined) snapshot.sourceHandle = edge.sourceHandle;
    if (edge.targetHandle !== undefined) snapshot.targetHandle = edge.targetHandle;
    if (edge.data !== undefined) snapshot.data = omitEmptySecretFields(edge.data) as Record<string, unknown>;
    return snapshot;
  });
  const rawSnapshot: ReplayableRunNodeInputSnapshot = {
    schema: RUN_NODE_INPUT_SNAPSHOT_SCHEMA,
    replayable: true,
    node: nodeSnapshots[0],
    upstreamNodes: nodeSnapshots.slice(1),
    incomingEdges,
  };
  const safetyError = replaySafetyError(rawSnapshot, 'inputSnapshot');
  if (safetyError) {
    return {
      schema: RUN_NODE_INPUT_SNAPSHOT_SCHEMA,
      replayable: false,
      nodeId: originalNodeId(target),
      nodeType: String(target.type || 'unknown'),
      reason: safetyError,
    };
  }
  return cloneValue(rawSnapshot);
}

const RUN_REPLAY_RUNTIME_NODE_ID_PATTERN = /^__t8-(?:run-(?:intent|replay)|subflow-run-replay)-/;

export function runReplayRuntimeNodeChangeId(change: NodeChange): string {
  return change.type === 'add'
    ? String(change.item?.id || '')
    : String(change.id || '');
}

export interface RunReplayRuntimeNodeChangePartition {
  runtimeChanges: NodeChange[];
  visibleChanges: NodeChange[];
  staleRuntimeChanges: NodeChange[];
}

export function partitionRunReplayRuntimeNodeChanges(
  changes: NodeChange[],
  runtimeNodes: Node[],
  visibleNodes: Node[],
): RunReplayRuntimeNodeChangePartition {
  const runtimeIds = new Set(runtimeNodes.map((node) => node.id));
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const partition: RunReplayRuntimeNodeChangePartition = {
    runtimeChanges: [],
    visibleChanges: [],
    staleRuntimeChanges: [],
  };

  for (const change of changes) {
    const id = runReplayRuntimeNodeChangeId(change);
    if (runtimeIds.has(id)) {
      partition.runtimeChanges.push(change);
    } else if (
      visibleIds.has(id)
      || !RUN_REPLAY_RUNTIME_NODE_ID_PATTERN.test(id)
    ) {
      partition.visibleChanges.push(change);
    } else {
      // A reserved runtime ID that belongs to neither the mounted runtime nor
      // the visible graph is a delayed update from a runtime that was cleared.
      partition.staleRuntimeChanges.push(change);
    }
  }

  return partition;
}

export function currentRunReplayRuntimeNodeChanges(
  nodes: Node[],
  changes: NodeChange[],
): NodeChange[] {
  const currentIds = new Set(nodes.map((node) => node.id));
  return changes.filter((change) => currentIds.has(runReplayRuntimeNodeChangeId(change)));
}

function allocateRunReplayRuntimeNodeIds(
  originalIds: readonly string[],
  prefix: string,
  safeNonce: string,
  occupiedNodeIds: readonly string[],
): Map<string, string> {
  const occupiedIds = new Set(occupiedNodeIds.map(String));
  const runtimeIdByOriginalId = new Map<string, string>();
  originalIds.forEach((originalId, index) => {
    const baseId = `${prefix}${safeNonce}-${index}`;
    let runtimeId = baseId;
    let collisionIndex = 1;
    while (occupiedIds.has(runtimeId)) {
      runtimeId = `${baseId}-${collisionIndex}`;
      collisionIndex += 1;
    }
    occupiedIds.add(runtimeId);
    runtimeIdByOriginalId.set(originalId, runtimeId);
  });
  return runtimeIdByOriginalId;
}

/**
 * Materialize an invisible, deeply cloned execution graph for one accepted
 * remote RunIntent. Collaborators may keep editing the visible next revision
 * while every Provider-facing node in this runtime continues to observe the
 * exact graph that passed host preflight.
 */
export function buildFrozenRunIntentRuntime(
  nodes: Node[],
  edges: Edge[],
  requestedNodeIds: string[],
  nonce: string,
  occupiedNodeIds: readonly string[] = [],
): RunReplayRuntimeGraph {
  const requested = [...new Set(requestedNodeIds.map(String).filter(Boolean))];
  if (!requested.length) throw new Error('远程运行意图没有可冻结的执行节点');

  const snapshots = new Map<string, ReplayableRunNodeInputSnapshot>();
  for (const nodeId of requested) {
    const snapshot = captureRunNodeInputSnapshot(nodes, edges, nodeId);
    if (!isReplayableRunNodeInputSnapshot(snapshot)) {
      throw new Error(`无法冻结远程运行输入：${snapshot.reason}`);
    }
    snapshots.set(nodeId, snapshot);
  }

  const graphNodes = new Map<string, RunReplayNodeSnapshot>();
  const graphEdges = new Map<string, RunReplayEdgeSnapshot>();
  for (const snapshot of snapshots.values()) {
    for (const upstream of snapshot.upstreamNodes) {
      if (!graphNodes.has(upstream.id)) graphNodes.set(upstream.id, cloneValue(upstream));
    }
    for (const edge of snapshot.incomingEdges) {
      const key = `${edge.source}:${edge.sourceHandle || ''}->${edge.target}:${edge.targetHandle || ''}`;
      if (!graphEdges.has(key)) graphEdges.set(key, cloneValue(edge));
    }
  }
  for (const nodeId of requested) {
    graphNodes.set(nodeId, cloneValue(snapshots.get(nodeId)!.node));
  }
  if (graphNodes.size > MAX_REPLAY_NODES || graphEdges.size > MAX_REPLAY_EDGES) {
    throw new Error(`无法冻结远程运行输入：输入图超过上限（${graphNodes.size} 节点 / ${graphEdges.size} 连线）`);
  }

  const safeNonce = String(nonce || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'intent-runtime';
  const runtimeIdByOriginalId = allocateRunReplayRuntimeNodeIds(
    [...graphNodes.keys()],
    '__t8-run-intent-',
    safeNonce,
    [...nodes.map((node) => node.id), ...occupiedNodeIds],
  );
  const originalNodeIdByRuntimeId: Record<string, string> = {};
  const runtimeNodes = [...graphNodes.values()].map((node) => {
    const id = runtimeIdByOriginalId.get(node.id)!;
    originalNodeIdByRuntimeId[id] = node.id;
    return {
      id,
      type: node.type,
      position: cloneValue(node.position),
      data: cloneValue(node.data),
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      style: { opacity: 0, pointerEvents: 'none' },
      __runReplayOriginalNodeId: node.id,
    } as Node & { __runReplayOriginalNodeId: string };
  });
  const runtimeEdges = [...graphEdges.values()].flatMap((edge, index) => {
    const source = runtimeIdByOriginalId.get(edge.source);
    const target = runtimeIdByOriginalId.get(edge.target);
    if (!source || !target) return [];
    return [{
      id: `__t8-run-intent-edge-${safeNonce}-${index}`,
      source,
      target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      data: edge.data ? cloneValue(edge.data) : undefined,
      selectable: false,
      animated: false,
      style: { opacity: 0, pointerEvents: 'none' },
    } as Edge];
  });
  const executionNodeIds = requested.map((id) => runtimeIdByOriginalId.get(id)!).filter(Boolean);
  const executionContexts = Object.fromEntries(executionNodeIds.map((runtimeId) => {
    const originalId = originalNodeIdByRuntimeId[runtimeId];
    const sourceSnapshot = snapshots.get(originalId)!.node;
    return [runtimeId, {
      subflowPath: [],
      originalNodeId: originalId,
      runNodeId: originalId,
      inputSnapshot: {
        schema: RUN_NODE_INPUT_SNAPSHOT_SCHEMA,
        nodeType: sourceSnapshot.type,
        nodeData: cloneValue(sourceSnapshot.data),
      },
    } satisfies RunReplayExecutionContext];
  }));
  return {
    nodes: runtimeNodes,
    edges: runtimeEdges,
    executionNodeIds,
    originalNodeIdByRuntimeId,
    executionContexts,
  };
}

export function isReplayableRunNodeInputSnapshot(value: unknown): value is ReplayableRunNodeInputSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ReplayableRunNodeInputSnapshot>;
  return snapshot.schema === RUN_NODE_INPUT_SNAPSHOT_SCHEMA
    && snapshot.replayable === true
    && isRunReplayNodeSnapshot(snapshot.node)
    && Array.isArray(snapshot.upstreamNodes)
    && snapshot.upstreamNodes.every(isRunReplayNodeSnapshot)
    && Array.isArray(snapshot.incomingEdges)
    && snapshot.incomingEdges.every(isRunReplayEdgeSnapshot);
}

function topLevelNodeRunIdentity(nodeRun: NodeRunSummary): string {
  return String(nodeRun.originalNodeId || nodeRun.nodeId);
}

function replayNodeRuns(run: RunDetail) {
  const byNodeId = new Map<string, NodeRunSummary>();
  run.nodeRuns.filter((nodeRun) => !nodeRun.parentNodeRunId).forEach((nodeRun) => {
    byNodeId.set(topLevelNodeRunIdentity(nodeRun), nodeRun);
  });
  return byNodeId;
}

function validateReplayNodeRunSnapshot(nodeRun: NodeRunSummary, expectedNodeId: string) {
  const snapshot = nodeRun.inputSnapshot;
  if (!isReplayableRunNodeInputSnapshot(snapshot)) {
    const storedReason = snapshot && typeof snapshot === 'object' && 'reason' in snapshot
      ? String((snapshot as { reason?: unknown }).reason || '')
      : '';
    return { ok: false as const, reason: storedReason || `节点 ${expectedNodeId} 没有可重放输入快照` };
  }
  if (snapshot.node.id !== expectedNodeId) return { ok: false as const, reason: `节点 ${expectedNodeId} 的输入快照身份不一致` };
  if (snapshot.upstreamNodes.length + 1 > MAX_REPLAY_NODES || snapshot.incomingEdges.length > MAX_REPLAY_EDGES) {
    return { ok: false as const, reason: `节点 ${expectedNodeId} 的输入子图超过安全上限` };
  }
  const snapshotNodeIds = new Set([snapshot.node.id, ...snapshot.upstreamNodes.map((node) => node.id)]);
  if (snapshotNodeIds.size !== snapshot.upstreamNodes.length + 1) return { ok: false as const, reason: `节点 ${expectedNodeId} 的输入快照含重复节点` };
  if (snapshot.incomingEdges.some((edge) => !snapshotNodeIds.has(edge.source) || !snapshotNodeIds.has(edge.target))) {
    return { ok: false as const, reason: `节点 ${expectedNodeId} 的输入快照连线引用了缺失节点` };
  }
  const safetyError = replaySafetyError(snapshot, `nodeRuns.${expectedNodeId}.inputSnapshot`);
  return safetyError ? { ok: false as const, reason: safetyError } : { ok: true as const };
}

export function validateRunOriginalReplay(run: RunDetail, requestedNodeIds: string[]): { ok: true } | { ok: false; reason: string } {
  const requested = [...new Set(requestedNodeIds.map(String).filter(Boolean))];
  if (!requested.length) return { ok: false, reason: '没有可重放节点' };
  const byNodeId = replayNodeRuns(run);
  for (const nodeId of requested) {
    const nodeRun = byNodeId.get(nodeId);
    if (!nodeRun) return { ok: false, reason: `节点 ${nodeId} 没有原始 NodeRun` };
    const validation = validateReplayNodeRunSnapshot(nodeRun, nodeId);
    if (!validation.ok) return validation;
  }
  return { ok: true };
}

export function validateSubflowNodeRunOriginalReplay(
  run: RunDetail,
  nodeRunId: string,
): { ok: true } | { ok: false; reason: string } {
  const nodeRun = run.nodeRuns.find((item) => item.id === nodeRunId);
  if (!nodeRun) return { ok: false, reason: '找不到内部 NodeRun' };
  if (!nodeRun.parentNodeRunId) return { ok: false, reason: '该节点不是子工作流内部节点' };
  if (!['failed', 'stopped', 'interrupted'].includes(nodeRun.status)) return { ok: false, reason: '只能重试失败、停止或异常中断的内部节点' };
  const parent = run.nodeRuns.find((item) => item.id === nodeRun.parentNodeRunId);
  if (!parent) return { ok: false, reason: '内部 NodeRun 的外层实例记录已缺失' };
  if (!nodeRun.subflowPath.length) return { ok: false, reason: '内部 NodeRun 缺少子工作流路径' };
  return validateReplayNodeRunSnapshot(nodeRun, nodeRun.nodeId);
}

export function validateRunAttemptOriginalReplay(
  run: RunDetail,
  nodeRunId: string,
  attemptId: string,
): { ok: true } | { ok: false; reason: string } {
  const nodeRun = run.nodeRuns.find((item) => item.id === nodeRunId);
  if (!nodeRun) return { ok: false, reason: '找不到该 Attempt 所属的 NodeRun' };
  const attempt = (nodeRun.attempts || []).find((item) => item.id === attemptId);
  if (!attempt || attempt.nodeRunId !== nodeRun.id) return { ok: false, reason: 'Attempt 与 NodeRun 身份不一致' };
  if (!['failed', 'stopped', 'interrupted'].includes(attempt.status)) {
    return { ok: false, reason: '只能重试失败、停止或异常中断的 Attempt' };
  }
  if (nodeRun.parentNodeRunId) {
    const parent = run.nodeRuns.find((item) => item.id === nodeRun.parentNodeRunId);
    if (!parent) return { ok: false, reason: '内部 Attempt 的外层实例记录已缺失' };
    if (!nodeRun.subflowPath.length) return { ok: false, reason: '内部 Attempt 缺少子工作流路径' };
  }
  return validateReplayNodeRunSnapshot(nodeRun, nodeRun.parentNodeRunId ? nodeRun.nodeId : topLevelNodeRunIdentity(nodeRun));
}

export function buildSubflowNodeRunOriginalReplayRuntime(
  run: RunDetail,
  nodeRunId: string,
  nonce: string,
  occupiedNodeIds: readonly string[] = [],
): SubflowNodeRunReplayRuntimeGraph {
  const validation = validateSubflowNodeRunOriginalReplay(run, nodeRunId);
  if (!validation.ok) throw new Error(`无法使用原输入重试内部节点：${validation.reason}`);
  const sourceNodeRun = run.nodeRuns.find((item) => item.id === nodeRunId)!;
  const parentNodeRun = run.nodeRuns.find((item) => item.id === sourceNodeRun.parentNodeRunId)!;
  const snapshot = sourceNodeRun.inputSnapshot as unknown as ReplayableRunNodeInputSnapshot;
  const graphNodes = [...snapshot.upstreamNodes, snapshot.node].map(cloneValue);
  const safeNonce = String(nonce || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'subflow-runtime';
  const runtimeIdByOriginalId = allocateRunReplayRuntimeNodeIds(
    graphNodes.map((node) => node.id),
    '__t8-subflow-run-replay-',
    safeNonce,
    occupiedNodeIds,
  );
  const originalNodeIdByRuntimeId: Record<string, string> = {};
  const nodes = graphNodes.map((node) => {
    const id = runtimeIdByOriginalId.get(node.id)!;
    originalNodeIdByRuntimeId[id] = node.id;
    return {
      id,
      type: node.type,
      position: cloneValue(node.position),
      data: cloneValue(node.data),
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      style: { opacity: 0, pointerEvents: 'none' },
      __runReplayOriginalNodeId: node.id,
    } as Node & { __runReplayOriginalNodeId: string };
  });
  const edges = snapshot.incomingEdges.flatMap((edge, index) => {
    const source = runtimeIdByOriginalId.get(edge.source);
    const target = runtimeIdByOriginalId.get(edge.target);
    if (!source || !target) return [];
    return [{
      id: `__t8-subflow-run-replay-edge-${safeNonce}-${index}`,
      source,
      target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      data: edge.data ? cloneValue(edge.data) : undefined,
      selectable: false,
      animated: false,
      style: { opacity: 0, pointerEvents: 'none' },
    } as Edge];
  });
  const executionNodeId = runtimeIdByOriginalId.get(snapshot.node.id)!;
  const executionContexts = {
    [executionNodeId]: {
      subflowPath: [...sourceNodeRun.subflowPath],
      originalNodeId: String(sourceNodeRun.originalNodeId || sourceNodeRun.nodeId),
      runNodeId: sourceNodeRun.nodeId,
      definitionId: sourceNodeRun.definitionId || undefined,
      definitionVersion: sourceNodeRun.definitionVersion || undefined,
      inputSnapshot: {
        schema: RUN_NODE_INPUT_SNAPSHOT_SCHEMA,
        nodeType: snapshot.node.type,
        nodeData: cloneValue(snapshot.node.data),
      },
    } satisfies RunReplayExecutionContext,
  };
  return {
    nodes,
    edges,
    executionNodeIds: [executionNodeId],
    originalNodeIdByRuntimeId,
    executionContexts,
    parentNodeRun: cloneValue(parentNodeRun),
    sourceNodeRun: cloneValue(sourceNodeRun),
  };
}

export function buildRunOriginalReplayRuntime(
  run: RunDetail,
  requestedNodeIds: string[],
  nonce: string,
  occupiedNodeIds: readonly string[] = [],
): RunReplayRuntimeGraph {
  const requested = [...new Set(requestedNodeIds.map(String).filter(Boolean))];
  const validation = validateRunOriginalReplay(run, requested);
  if (!validation.ok) throw new Error(`无法使用原输入重放：${validation.reason}`);
  const byNodeId = replayNodeRuns(run);
  const graphNodes = new Map<string, RunReplayNodeSnapshot>();
  const graphEdges = new Map<string, RunReplayEdgeSnapshot>();
  for (const nodeId of requested) {
    const snapshot = byNodeId.get(nodeId)!.inputSnapshot as unknown as ReplayableRunNodeInputSnapshot;
    for (const upstream of snapshot.upstreamNodes) {
      if (!graphNodes.has(upstream.id)) graphNodes.set(upstream.id, cloneValue(upstream));
    }
    for (const edge of snapshot.incomingEdges) {
      const key = `${edge.source}:${edge.sourceHandle || ''}->${edge.target}:${edge.targetHandle || ''}`;
      if (!graphEdges.has(key)) graphEdges.set(key, cloneValue(edge));
    }
  }
  for (const nodeId of requested) {
    const snapshot = byNodeId.get(nodeId)!.inputSnapshot as unknown as ReplayableRunNodeInputSnapshot;
    graphNodes.set(nodeId, cloneValue(snapshot.node));
  }
  if (graphNodes.size > MAX_REPLAY_NODES || graphEdges.size > MAX_REPLAY_EDGES) {
    throw new Error(`无法使用原输入重放：合并输入图超过上限（${graphNodes.size} 节点 / ${graphEdges.size} 连线）`);
  }
  const safeNonce = String(nonce || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'runtime';
  const runtimeIdByOriginalId = allocateRunReplayRuntimeNodeIds(
    [...graphNodes.keys()],
    '__t8-run-replay-',
    safeNonce,
    occupiedNodeIds,
  );
  const originalNodeIdByRuntimeId: Record<string, string> = {};
  const nodes = [...graphNodes.values()].map((node) => {
    const id = runtimeIdByOriginalId.get(node.id)!;
    originalNodeIdByRuntimeId[id] = node.id;
    return {
      id,
      type: node.type,
      position: cloneValue(node.position),
      data: cloneValue(node.data),
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      style: { opacity: 0, pointerEvents: 'none' },
      __runReplayOriginalNodeId: node.id,
    } as Node & { __runReplayOriginalNodeId: string };
  });
  const edges = [...graphEdges.values()].flatMap((edge, index) => {
    const source = runtimeIdByOriginalId.get(edge.source);
    const target = runtimeIdByOriginalId.get(edge.target);
    if (!source || !target) return [];
    return [{
      id: `__t8-run-replay-edge-${safeNonce}-${index}`,
      source,
      target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      data: edge.data ? cloneValue(edge.data) : undefined,
      selectable: false,
      animated: false,
      style: { opacity: 0, pointerEvents: 'none' },
    } as Edge];
  });
  const executionNodeIds = requested.map((id) => runtimeIdByOriginalId.get(id)!).filter(Boolean);
  const executionContexts = Object.fromEntries(executionNodeIds.map((runtimeId) => {
    const originalId = originalNodeIdByRuntimeId[runtimeId];
    const sourceSnapshot = (byNodeId.get(originalId)!.inputSnapshot as unknown as ReplayableRunNodeInputSnapshot).node;
    return [runtimeId, {
      subflowPath: [],
      originalNodeId: originalId,
      runNodeId: originalId,
      inputSnapshot: {
        schema: RUN_NODE_INPUT_SNAPSHOT_SCHEMA,
        nodeType: sourceSnapshot.type,
        nodeData: cloneValue(sourceSnapshot.data),
      },
    } satisfies RunReplayExecutionContext];
  }));
  return { nodes, edges, executionNodeIds, originalNodeIdByRuntimeId, executionContexts };
}

export function buildRunAttemptOriginalReplayRuntime(
  run: RunDetail,
  nodeRunId: string,
  attemptId: string,
  nonce: string,
  occupiedNodeIds: readonly string[] = [],
): RunAttemptReplayRuntimeGraph {
  const validation = validateRunAttemptOriginalReplay(run, nodeRunId, attemptId);
  if (!validation.ok) throw new Error(`无法重试该 Attempt：${validation.reason}`);
  const sourceNodeRun = run.nodeRuns.find((item) => item.id === nodeRunId)!;
  const sourceAttempt = (sourceNodeRun.attempts || []).find((item) => item.id === attemptId)!;
  if (sourceNodeRun.parentNodeRunId) {
    // 单个 Attempt 的终态可能早于同一 NodeRun 后续成功重试。构造阶段只用
    // 该 Attempt 的真实终态通过既有内部节点安全门禁，不改写持久记录。
    const validationRun: RunDetail = {
      ...run,
      nodeRuns: run.nodeRuns.map((item) => item.id === sourceNodeRun.id ? { ...item, status: sourceAttempt.status } : item),
    };
    const runtime = buildSubflowNodeRunOriginalReplayRuntime(
      validationRun,
      sourceNodeRun.id,
      nonce,
      occupiedNodeIds,
    );
    return {
      ...runtime,
      sourceNodeRun: cloneValue(sourceNodeRun),
      sourceAttempt: cloneValue(sourceAttempt),
    };
  }
  const runtime = buildRunOriginalReplayRuntime(
    run,
    [topLevelNodeRunIdentity(sourceNodeRun)],
    nonce,
    occupiedNodeIds,
  );
  return {
    ...runtime,
    sourceNodeRun: cloneValue(sourceNodeRun),
    sourceAttempt: cloneValue(sourceAttempt),
  };
}
