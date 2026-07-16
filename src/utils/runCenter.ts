import type { NodeRunSummary, RunDetail, RunEventRecord } from '../types/project';

export interface RunPlanEdge {
  source: string;
  target: string;
}

export interface RunTimelineItem {
  nodeRun: NodeRunSummary;
  queuedAt: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  activeDurationMs: number;
  waitMs: number;
  runMs: number;
  pollMs: number;
  pollCount: number;
  attemptCount: number;
  retryCount: number;
  lane: number;
  dependencyDepth: number;
  dependencies: string[];
  dependents: string[];
  offsetPercent: number;
  widthPercent: number;
  critical: boolean;
  segments: RunTimelineSegment[];
}

export type RunTimelinePhase = 'waiting' | 'running' | 'polling';

export interface RunTimelineSegment {
  kind: RunTimelinePhase;
  startAt: number;
  endAt: number;
  durationMs: number;
  offsetPercent: number;
  widthPercent: number;
}

export interface RunTimelineAnalysis {
  items: RunTimelineItem[];
  runStart: number;
  runEnd: number;
  maxConcurrency: number;
  totalWaitMs: number;
  totalRunMs: number;
  totalPollMs: number;
  pollingNodeCount: number;
  retryNodeCount: number;
  criticalPathMs: number;
  dagLevels: Array<{ depth: number; nodeIds: string[] }>;
}

export interface BoundedJsonText {
  text: string;
  truncated: boolean;
  originalLength: number;
}

export interface RunComparison {
  leftDurationMs: number;
  rightDurationMs: number;
  durationDeltaMs: number;
  leftOutputs: number;
  rightOutputs: number;
  outputDelta: number;
  inputChangedNodes: number;
  providerChangedNodes: number;
  usageMetrics: RunUsageMetricComparison[];
  costMetrics: RunUsageMetricComparison[];
  changedNodes: Array<{
    nodeId: string;
    leftStatus?: string;
    rightStatus?: string;
    leftDurationMs?: number;
    rightDurationMs?: number;
    inputChanged: boolean;
    providerChanged: boolean;
    usageChanged: boolean;
    leftProviders: string[];
    rightProviders: string[];
    leftInput?: unknown;
    rightInput?: unknown;
  }>;
}

export interface RunUsageMetricComparison {
  key: string;
  provider: string;
  model: string;
  metric: string;
  leftValue: number;
  rightValue: number;
  delta: number;
}

function topLevelNodeRuns(run: RunDetail) {
  return run.nodeRuns.filter((item) => !item.parentNodeRunId);
}

export function runNodeIdentity(nodeRun: NodeRunSummary) {
  return String(nodeRun.originalNodeId || nodeRun.nodeId);
}

export function getRunPlannedNodeIds(run: RunDetail) {
  if (Array.isArray(run.summary?.plannedNodeIds)) {
    return [...new Set((run.summary.plannedNodeIds as unknown[]).map(String).filter(Boolean))];
  }
  return [...new Set(topLevelNodeRuns(run).map(runNodeIdentity))];
}

export function getRunPlannedEdges(run: RunDetail): RunPlanEdge[] {
  if (!Array.isArray(run.summary?.plannedEdges)) return [];
  return (run.summary.plannedEdges as unknown[]).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const source = (value as { source?: unknown }).source;
    const target = (value as { target?: unknown }).target;
    return typeof source === 'string' && typeof target === 'string' ? [{ source, target }] : [];
  });
}

function runDuration(run: RunDetail) {
  const start = run.startedAt || run.createdAt;
  const end = run.finishedAt || Math.max(start, ...run.nodeRuns.map((item) => item.updatedAt || item.createdAt));
  return Math.max(0, end - start);
}

function finiteTimestamp(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function timestampFromAttempts(nodeRun: NodeRunSummary, key: string, mode: 'first' | 'last') {
  const values = (nodeRun.attempts || [])
    .map((attempt) => finiteTimestamp(attempt.timestamps?.[key]))
    .filter((value): value is number => value !== null);
  if (!values.length) return null;
  return mode === 'first' ? Math.min(...values) : Math.max(...values);
}

function firstEventTime(events: RunEventRecord[], types: Set<string>) {
  let first: number | null = null;
  events.forEach((event) => {
    if (!types.has(event.type)) return;
    const value = finiteTimestamp(event.createdAt);
    if (value !== null && (first === null || value < first)) first = value;
  });
  return first;
}

function lastEventTime(events: RunEventRecord[], types: Set<string>) {
  let last: number | null = null;
  events.forEach((event) => {
    if (!types.has(event.type)) return;
    const value = finiteTimestamp(event.createdAt);
    if (value !== null && (last === null || value > last)) last = value;
  });
  return last;
}

function clampTimestamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function phaseSegment(kind: RunTimelinePhase, startAt: number, endAt: number): Omit<RunTimelineSegment, 'offsetPercent' | 'widthPercent'> | null {
  const durationMs = Math.max(0, endAt - startAt);
  return durationMs > 0 ? { kind, startAt, endAt, durationMs } : null;
}

function calculateDependencyDepths(nodeIds: string[], edges: RunPlanEdge[]) {
  const known = new Set(nodeIds);
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(nodeIds.map((nodeId) => [nodeId, 0]));
  const depths = new Map(nodeIds.map((nodeId) => [nodeId, 0]));
  edges.forEach(({ source, target }) => {
    if (!known.has(source) || !known.has(target) || source === target) return;
    const targets = outgoing.get(source) || [];
    if (targets.includes(target)) return;
    targets.push(target);
    outgoing.set(source, targets);
    indegree.set(target, (indegree.get(target) || 0) + 1);
  });
  const queue = nodeIds.filter((nodeId) => indegree.get(nodeId) === 0).sort();
  while (queue.length) {
    const current = queue.shift()!;
    (outgoing.get(current) || []).sort().forEach((target) => {
      depths.set(target, Math.max(depths.get(target) || 0, (depths.get(current) || 0) + 1));
      const nextIndegree = (indegree.get(target) || 0) - 1;
      indegree.set(target, nextIndegree);
      if (nextIndegree === 0) {
        queue.push(target);
        queue.sort();
      }
    });
  }
  return depths;
}

export function formatBoundedJson(value: unknown, maxCharacters = 64 * 1024): BoundedJsonText {
  const limit = Math.max(256, Math.floor(Number(maxCharacters) || 0));
  const seen = new WeakSet<object>();
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (_key, nested) => {
      if (typeof nested === 'bigint') return `${nested.toString()}n`;
      if (nested && typeof nested === 'object') {
        if (seen.has(nested)) return '[Circular]';
        seen.add(nested);
      }
      return nested;
    }, 2) ?? 'null';
  } catch (error) {
    serialized = `[无法序列化：${error instanceof Error ? error.message : String(error)}]`;
  }
  const originalLength = serialized.length;
  if (originalLength <= limit) return { text: serialized, truncated: false, originalLength };
  return { text: `${serialized.slice(0, limit)}\n…`, truncated: true, originalLength };
}

export function buildRunTimelineAnalysis(run: RunDetail, events: RunEventRecord[] = []): RunTimelineAnalysis {
  const nodeRuns = topLevelNodeRuns(run);
  if (!nodeRuns.length) {
    const fallback = finiteTimestamp(run.startedAt) ?? finiteTimestamp(run.createdAt) ?? 0;
    return { items: [], runStart: fallback, runEnd: fallback, maxConcurrency: 0, totalWaitMs: 0, totalRunMs: 0, totalPollMs: 0, pollingNodeCount: 0, retryNodeCount: 0, criticalPathMs: 0, dagLevels: [] };
  }
  const byNodeRunId = new Map<string, RunEventRecord[]>();
  events.forEach((event) => {
    if (event.runId !== run.id || !event.nodeRunId) return;
    const nodeEvents = byNodeRunId.get(event.nodeRunId);
    if (nodeEvents) nodeEvents.push(event);
    else byNodeRunId.set(event.nodeRunId, [event]);
  });
  const timings = new Map<string, {
    queuedAt: number;
    startedAt: number;
    finishedAt: number;
    pollStartedAt: number | null;
    pollCount: number;
    attemptCount: number;
  }>();
  const queuedTypes = new Set(['node.queued']);
  const startedTypes = new Set(['node.started']);
  const terminalTypes = new Set(['node.succeeded', 'node.failed', 'node.stopped', 'node.interrupted', 'node.cancelled']);
  const terminalStatuses = new Set(['succeeded', 'failed', 'stopped', 'interrupted', 'cancelled']);
  const pollingTypes = new Set(['node.polling', 'provider.polling']);
  nodeRuns.forEach((nodeRun) => {
    const nodeEvents = byNodeRunId.get(nodeRun.id) || [];
    const createdAt = finiteTimestamp(nodeRun.createdAt) ?? 0;
    const updatedAt = Math.max(createdAt, finiteTimestamp(nodeRun.updatedAt) ?? createdAt);
    const lastObservedEventAt = nodeEvents.reduce((latest, event) => Math.max(latest, finiteTimestamp(event.createdAt) ?? 0), 0);
    const lastObservedAttemptAt = (nodeRun.attempts || []).reduce((latest, attempt) => Math.max(latest, finiteTimestamp(attempt.updatedAt) ?? 0), 0);
    const observedAt = Math.max(updatedAt, lastObservedEventAt, lastObservedAttemptAt);
    const queuedAt = firstEventTime(nodeEvents, queuedTypes) ?? timestampFromAttempts(nodeRun, 'queuedAt', 'first') ?? createdAt;
    const explicitStartedAt = firstEventTime(nodeEvents, startedTypes) ?? timestampFromAttempts(nodeRun, 'startedAt', 'first');
    const explicitFinishedAt = lastEventTime(nodeEvents, terminalTypes)
      ?? (terminalStatuses.has(nodeRun.status) ? timestampFromAttempts(nodeRun, 'finishedAt', 'last') : null);
    const finishedAt = Math.max(queuedAt, explicitFinishedAt ?? observedAt);
    const startedAt = clampTimestamp(explicitStartedAt ?? (nodeRun.status === 'queued' ? finishedAt : createdAt), queuedAt, finishedAt);
    const rawPollStartedAt = firstEventTime(nodeEvents, pollingTypes) ?? timestampFromAttempts(nodeRun, 'lastPolledAt', 'first');
    const pollStartedAt = rawPollStartedAt === null ? null : clampTimestamp(rawPollStartedAt, startedAt, finishedAt);
    const nodePollCount = nodeEvents.filter((event) => event.type === 'node.polling').length;
    const providerPollCount = nodeEvents.filter((event) => event.type === 'provider.polling').length;
    const eventPollCount = nodePollCount || providerPollCount;
    const attemptPollCount = (nodeRun.attempts || []).reduce((sum, attempt) => sum + Math.max(0, Number(attempt.pollCount) || 0), 0);
    timings.set(nodeRun.id, { queuedAt, startedAt, finishedAt, pollStartedAt, pollCount: Math.max(eventPollCount, attemptPollCount), attemptCount: nodeRun.attempts?.length || 0 });
  });
  const runStart = Math.min(
    finiteTimestamp(run.startedAt) ?? finiteTimestamp(run.createdAt) ?? Number.POSITIVE_INFINITY,
    ...[...timings.values()].map((item) => item.queuedAt),
  );
  const runEnd = Math.max(
    finiteTimestamp(run.finishedAt) ?? runStart,
    ...[...timings.values()].map((item) => item.finishedAt),
  );
  const span = Math.max(1, runEnd - runStart);
  const byNodeId = new Map(nodeRuns.map((item) => [runNodeIdentity(item), item]));
  const planEdges = getRunPlannedEdges(run);
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  planEdges.forEach((edge) => {
    if (!byNodeId.has(edge.source) || !byNodeId.has(edge.target)) return;
    if (!(incoming.get(edge.target) || []).includes(edge.source)) incoming.set(edge.target, [...(incoming.get(edge.target) || []), edge.source]);
    if (!(outgoing.get(edge.source) || []).includes(edge.target)) outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge.target]);
  });
  const nodeIds = nodeRuns.map(runNodeIdentity);
  const dependencyDepths = calculateDependencyDepths(nodeIds, planEdges);
  const scores = new Map<string, number>();
  const previous = new Map<string, string>();
  const visiting = new Set<string>();
  const score = (nodeId: string): number => {
    if (scores.has(nodeId)) return scores.get(nodeId)!;
    if (visiting.has(nodeId)) return 0;
    visiting.add(nodeId);
    const nodeRun = byNodeId.get(nodeId)!;
    const timing = timings.get(nodeRun.id)!;
    const duration = Math.max(1, timing.finishedAt - timing.queuedAt);
    let bestParent = '';
    let bestScore = 0;
    (incoming.get(nodeId) || []).forEach((parentId) => {
      const parentScore = score(parentId);
      if (parentScore > bestScore) { bestScore = parentScore; bestParent = parentId; }
    });
    visiting.delete(nodeId);
    scores.set(nodeId, bestScore + duration);
    if (bestParent) previous.set(nodeId, bestParent);
    return bestScore + duration;
  };
  nodeRuns.forEach((item) => score(runNodeIdentity(item)));
  let tail = runNodeIdentity(nodeRuns[0]);
  nodeRuns.forEach((item) => {
    const nodeId = runNodeIdentity(item);
    if ((scores.get(nodeId) || 0) > (scores.get(tail) || 0)) tail = nodeId;
  });
  const critical = new Set<string>();
  while (tail && !critical.has(tail)) { critical.add(tail); tail = previous.get(tail) || ''; }
  const laneEnds: number[] = [];
  const lanes = new Map<string, number>();
  [...nodeRuns].sort((left, right) => {
    const leftTiming = timings.get(left.id)!;
    const rightTiming = timings.get(right.id)!;
    return leftTiming.startedAt - rightTiming.startedAt || leftTiming.finishedAt - rightTiming.finishedAt || runNodeIdentity(left).localeCompare(runNodeIdentity(right));
  }).forEach((nodeRun) => {
    const timing = timings.get(nodeRun.id)!;
    let lane = laneEnds.findIndex((endAt) => endAt <= timing.startedAt);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(timing.finishedAt); }
    else laneEnds[lane] = timing.finishedAt;
    lanes.set(nodeRun.id, lane);
  });
  const concurrencyPoints = [...timings.values()].flatMap((timing) => timing.finishedAt > timing.startedAt
    ? [{ at: timing.startedAt, delta: 1 }, { at: timing.finishedAt, delta: -1 }]
    : []);
  concurrencyPoints.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let concurrency = 0;
  let maxConcurrency = 0;
  concurrencyPoints.forEach((point) => {
    concurrency += point.delta;
    maxConcurrency = Math.max(maxConcurrency, concurrency);
  });
  const items = nodeRuns.map((nodeRun) => {
    const nodeId = runNodeIdentity(nodeRun);
    const timing = timings.get(nodeRun.id)!;
    const waitMs = Math.max(0, timing.startedAt - timing.queuedAt);
    const runUntil = timing.pollStartedAt ?? timing.finishedAt;
    const runMs = Math.max(0, runUntil - timing.startedAt);
    const pollMs = timing.pollStartedAt === null ? 0 : Math.max(0, timing.finishedAt - timing.pollStartedAt);
    const durationMs = Math.max(0, timing.finishedAt - timing.queuedAt);
    const rawSegments = [
      phaseSegment('waiting', timing.queuedAt, timing.startedAt),
      phaseSegment('running', timing.startedAt, runUntil),
      timing.pollStartedAt === null ? null : phaseSegment('polling', timing.pollStartedAt, timing.finishedAt),
    ].filter((segment): segment is Omit<RunTimelineSegment, 'offsetPercent' | 'widthPercent'> => Boolean(segment));
    return {
      nodeRun,
      queuedAt: timing.queuedAt,
      startedAt: timing.startedAt,
      finishedAt: timing.finishedAt,
      durationMs,
      activeDurationMs: Math.max(0, timing.finishedAt - timing.startedAt),
      waitMs,
      runMs,
      pollMs,
      pollCount: timing.pollCount,
      attemptCount: timing.attemptCount,
      retryCount: Math.max(0, timing.attemptCount - 1),
      lane: lanes.get(nodeRun.id) || 0,
      dependencyDepth: dependencyDepths.get(nodeId) || 0,
      dependencies: [...(incoming.get(nodeId) || [])].sort(),
      dependents: [...(outgoing.get(nodeId) || [])].sort(),
      offsetPercent: Math.max(0, Math.min(100, ((timing.queuedAt - runStart) / span) * 100)),
      widthPercent: Math.max(1.5, Math.min(100, (Math.max(1, durationMs) / span) * 100)),
      critical: critical.has(nodeId),
      segments: rawSegments.map((segment) => ({
        ...segment,
        offsetPercent: Math.max(0, Math.min(100, ((segment.startAt - runStart) / span) * 100)),
        widthPercent: Math.max(0.6, Math.min(100, (segment.durationMs / span) * 100)),
      })),
    };
  });
  const dagLevels = [...new Set(items.map((item) => item.dependencyDepth))].sort((left, right) => left - right).map((depth) => ({
    depth,
    nodeIds: items.filter((item) => item.dependencyDepth === depth).map((item) => runNodeIdentity(item.nodeRun)).sort(),
  }));
  return {
    items,
    runStart,
    runEnd,
    maxConcurrency,
    totalWaitMs: items.reduce((sum, item) => sum + item.waitMs, 0),
    totalRunMs: items.reduce((sum, item) => sum + item.runMs, 0),
    totalPollMs: items.reduce((sum, item) => sum + item.pollMs, 0),
    pollingNodeCount: items.filter((item) => item.pollCount > 0 || item.pollMs > 0).length,
    retryNodeCount: items.filter((item) => item.retryCount > 0).length,
    criticalPathMs: Math.max(0, ...scores.values()),
    dagLevels,
  };
}

export function buildRunTimeline(run: RunDetail, events: RunEventRecord[] = []): RunTimelineItem[] {
  return buildRunTimelineAnalysis(run, events).items;
}

function comparisonNodeIdentity(nodeRun: NodeRunSummary) {
  const identity = runNodeIdentity(nodeRun);
  if (!nodeRun.parentNodeRunId) return identity;
  return `${nodeRun.subflowPath.join(' / ') || 'subflow'} :: ${identity}`;
}

function stableComparableJson(value: unknown) {
  const seen = new WeakSet<object>();
  const normalize = (item: unknown): unknown => {
    if (!item || typeof item !== 'object') return item;
    if (seen.has(item)) return '[circular]';
    seen.add(item);
    if (Array.isArray(item)) {
      const output = item.map(normalize);
      seen.delete(item);
      return output;
    }
    const output = Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map((key) => [key, normalize((item as Record<string, unknown>)[key])]));
    seen.delete(item);
    return output;
  };
  try { return JSON.stringify(normalize(value)); } catch (_) { return String(value); }
}

function attemptProviderLabels(nodeRun?: NodeRunSummary) {
  return [...new Set((nodeRun?.attempts || []).map((attempt) => {
    const provider = String(attempt.provider || 'unknown');
    const model = String(attempt.model || '').trim();
    return model ? `${provider} / ${model}` : provider;
  }))].sort();
}

function flattenNumericUsage(value: unknown, prefix = '', output = new Map<string, number>(), depth = 0) {
  if (output.size >= 1000 || depth > 8) return output;
  if (typeof value === 'number') {
    if (Number.isFinite(value) && prefix) output.set(prefix, (output.get(prefix) || 0) + value);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenNumericUsage(item, `${prefix}[${index}]`, output, depth + 1));
    return output;
  }
  Object.keys(value as Record<string, unknown>).sort().forEach((key) => {
    flattenNumericUsage((value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key, output, depth + 1);
  });
  return output;
}

function aggregateRunUsage(run: RunDetail) {
  const totals = new Map<string, { provider: string; model: string; metric: string; value: number }>();
  run.nodeRuns.forEach((nodeRun) => (nodeRun.attempts || []).forEach((attempt) => {
    const provider = String(attempt.provider || 'unknown');
    const model = String(attempt.model || 'unknown');
    flattenNumericUsage(attempt.usage).forEach((value, metric) => {
      const key = `${provider}\u001f${model}\u001f${metric}`;
      const current = totals.get(key);
      totals.set(key, { provider, model, metric, value: (current?.value || 0) + value });
    });
  }));
  return totals;
}

function compareUsage(left: RunDetail, right: RunDetail) {
  const leftUsage = aggregateRunUsage(left);
  const rightUsage = aggregateRunUsage(right);
  return [...new Set([...leftUsage.keys(), ...rightUsage.keys()])].sort().map((key) => {
    const leftMetric = leftUsage.get(key);
    const rightMetric = rightUsage.get(key);
    const descriptor = leftMetric || rightMetric!;
    const leftValue = leftMetric?.value || 0;
    const rightValue = rightMetric?.value || 0;
    return {
      key,
      provider: descriptor.provider,
      model: descriptor.model,
      metric: descriptor.metric,
      leftValue,
      rightValue,
      delta: rightValue - leftValue,
    };
  });
}

export function compareRuns(left: RunDetail, right: RunDetail): RunComparison {
  const leftNodes = new Map(left.nodeRuns.map((item) => [comparisonNodeIdentity(item), item]));
  const rightNodes = new Map(right.nodeRuns.map((item) => [comparisonNodeIdentity(item), item]));
  const changedNodes = [...new Set([...leftNodes.keys(), ...rightNodes.keys()])].sort().flatMap((nodeId) => {
    const leftNode = leftNodes.get(nodeId);
    const rightNode = rightNodes.get(nodeId);
    const leftDurationMs = leftNode ? Math.max(0, leftNode.updatedAt - leftNode.createdAt) : undefined;
    const rightDurationMs = rightNode ? Math.max(0, rightNode.updatedAt - rightNode.createdAt) : undefined;
    const inputChanged = stableComparableJson(leftNode?.inputSnapshot) !== stableComparableJson(rightNode?.inputSnapshot);
    const leftProviders = attemptProviderLabels(leftNode);
    const rightProviders = attemptProviderLabels(rightNode);
    const providerChanged = stableComparableJson(leftProviders) !== stableComparableJson(rightProviders);
    const usageChanged = stableComparableJson((leftNode?.attempts || []).map((attempt) => attempt.usage))
      !== stableComparableJson((rightNode?.attempts || []).map((attempt) => attempt.usage));
    if (leftNode?.status === rightNode?.status
      && leftDurationMs === rightDurationMs
      && leftNode?.outputRefs.length === rightNode?.outputRefs.length
      && !inputChanged && !providerChanged && !usageChanged) return [];
    return [{
      nodeId,
      leftStatus: leftNode?.status,
      rightStatus: rightNode?.status,
      leftDurationMs,
      rightDurationMs,
      inputChanged,
      providerChanged,
      usageChanged,
      leftProviders,
      rightProviders,
      leftInput: leftNode?.inputSnapshot,
      rightInput: rightNode?.inputSnapshot,
    }];
  });
  const leftOutputs = topLevelNodeRuns(left).reduce((sum, item) => sum + item.outputRefs.length, 0);
  const rightOutputs = topLevelNodeRuns(right).reduce((sum, item) => sum + item.outputRefs.length, 0);
  const leftDurationMs = runDuration(left);
  const rightDurationMs = runDuration(right);
  const usageMetrics = compareUsage(left, right);
  const costMetrics = usageMetrics.filter((item) => /(?:cost|price|credit|amount|usd|cny|rmb)/i.test(item.metric));
  return {
    leftDurationMs,
    rightDurationMs,
    durationDeltaMs: rightDurationMs - leftDurationMs,
    leftOutputs,
    rightOutputs,
    outputDelta: rightOutputs - leftOutputs,
    inputChangedNodes: changedNodes.filter((item) => item.inputChanged).length,
    providerChangedNodes: changedNodes.filter((item) => item.providerChanged).length,
    usageMetrics,
    costMetrics,
    changedNodes,
  };
}

export function collectFailedDownstreamNodeIds(run: RunDetail, edges: RunPlanEdge[]) {
  const failed = new Set(topLevelNodeRuns(run).filter((item) => ['failed', 'interrupted', 'stopped'].includes(item.status)).map(runNodeIdentity));
  const outgoing = new Map<string, string[]>();
  edges.forEach((edge) => outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge.target]));
  const queue = [...failed];
  while (queue.length) {
    const current = queue.shift()!;
    (outgoing.get(current) || []).forEach((next) => {
      if (failed.has(next)) return;
      failed.add(next);
      queue.push(next);
    });
  }
  return [...failed];
}
