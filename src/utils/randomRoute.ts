import type { Edge, Node } from '@xyflow/react';

export const RANDOM_ROUTE_NODE_TYPE = 'random-route';
export const RANDOM_ROUTE_MIN_OUTPUTS = 1;
export const RANDOM_ROUTE_MAX_OUTPUTS = 100;
export const RANDOM_ROUTE_DEFAULT_OUTPUTS = 10;
export const RANDOM_ROUTE_DEFAULT_PASS_COUNT = 1;
export const RANDOM_ROUTE_DEFAULT_EXECUTION_MODE = 'parallel';

export type RandomRouteExecutionMode = 'parallel' | 'serial';

export interface RandomRouteSettings {
  totalOutputs: number;
  randomPassCount: number;
  executionMode: RandomRouteExecutionMode;
}

export interface RandomRouteBranchArgs {
  routeId: string;
  activeHandles: string[];
  nodes: Node[];
  edges: Edge[];
}

export interface RandomRouteSubgraph {
  nodes: Node[];
  edges: Edge[];
  nodeIds: Set<string>;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const rounded = Math.round(toFiniteNumber(value, fallback));
  return Math.max(min, Math.min(max, rounded));
}

function firstPresent(...values: unknown[]) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function normalizeExecutionMode(value: unknown): RandomRouteExecutionMode {
  const text = String(value || '').trim().toLowerCase();
  if (['serial', 'sequential', 'sequence', 'single', '顺序', '顺序生成'].includes(text)) return 'serial';
  return 'parallel';
}

export function randomRouteOutputHandle(index: number): string {
  return `output_${clampInteger(index, 1, 1, RANDOM_ROUTE_MAX_OUTPUTS)}`;
}

export function randomRouteHandleIndex(handle: unknown): number | null {
  const match = String(handle || '').match(/^output_(\d+)$/);
  if (!match) return null;
  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < RANDOM_ROUTE_MIN_OUTPUTS || index > RANDOM_ROUTE_MAX_OUTPUTS) {
    return null;
  }
  return index;
}

export function sortRandomRouteHandles(handles: string[]): string[] {
  return [...handles].sort((a, b) => {
    const ai = randomRouteHandleIndex(a) ?? Number.MAX_SAFE_INTEGER;
    const bi = randomRouteHandleIndex(b) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}

export function normalizeRandomRouteSettings(data: Record<string, any> = {}): RandomRouteSettings {
  const totalOutputs = clampInteger(
    firstPresent(data.randomRouteTotalOutputs, data.totalOutputs, data.total_outputs),
    RANDOM_ROUTE_DEFAULT_OUTPUTS,
    RANDOM_ROUTE_MIN_OUTPUTS,
    RANDOM_ROUTE_MAX_OUTPUTS,
  );
  const randomPassCount = clampInteger(
    firstPresent(data.randomRoutePassCount, data.randomPassCount, data.random_pass_count),
    RANDOM_ROUTE_DEFAULT_PASS_COUNT,
    1,
    totalOutputs,
  );
  const executionMode = normalizeExecutionMode(firstPresent(
    data.randomRouteExecutionMode,
    data.executionMode,
    data.execution_mode,
    data.random_route_execution_mode,
  ));
  return { totalOutputs, randomPassCount, executionMode };
}

export function selectRandomRouteHandles(
  totalOutputs: number,
  randomPassCount: number,
  rng: () => number = Math.random,
): string[] {
  const settings = normalizeRandomRouteSettings({
    randomRouteTotalOutputs: totalOutputs,
    randomRoutePassCount: randomPassCount,
  });
  const pool = Array.from({ length: settings.totalOutputs }, (_, index) => randomRouteOutputHandle(index + 1));
  const selected: string[] = [];
  while (selected.length < settings.randomPassCount && pool.length > 0) {
    const raw = rng();
    const safe = Number.isFinite(raw) ? Math.max(0, Math.min(0.999999999, raw)) : 0;
    const index = Math.floor(safe * pool.length);
    const [handle] = pool.splice(index, 1);
    selected.push(handle);
  }
  return sortRandomRouteHandles(selected);
}

function normalizeRouteSourceHandle(handle: unknown): string {
  const parsed = randomRouteHandleIndex(handle);
  return parsed ? randomRouteOutputHandle(parsed) : randomRouteOutputHandle(1);
}

function nodeIdSet(nodes: Node[]): Set<string> {
  return new Set(nodes.map((node) => node.id));
}

export function collectRandomRouteBranchNodeIds({
  routeId,
  activeHandles,
  nodes,
  edges,
}: RandomRouteBranchArgs): Set<string> {
  const knownNodes = nodeIdSet(nodes);
  const active = new Set(activeHandles.map(normalizeRouteSourceHandle));
  const adjacency = new Map<string, string[]>();
  const starts: string[] = [];

  for (const edge of edges) {
    if (!knownNodes.has(edge.source) || !knownNodes.has(edge.target)) continue;
    if (edge.source === routeId) {
      if (!active.has(normalizeRouteSourceHandle(edge.sourceHandle))) continue;
      starts.push(edge.target);
    }
    const list = adjacency.get(edge.source) || [];
    list.push(edge.target);
    adjacency.set(edge.source, list);
  }

  const visited = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current === routeId || visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) || []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return visited;
}

export function createRandomRouteExecutionSubgraph(args: RandomRouteBranchArgs): RandomRouteSubgraph {
  const nodeIds = collectRandomRouteBranchNodeIds(args);
  const nodes = args.nodes.filter((node) => nodeIds.has(node.id));
  const edges = args.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  return { nodes, edges, nodeIds };
}

export function excludeRandomRouteBranchDescendants(nodes: Node[], edges: Edge[]): RandomRouteSubgraph {
  const routeNodes = nodes.filter((node) => node.type === RANDOM_ROUTE_NODE_TYPE);
  const excluded = new Set<string>();

  for (const route of routeNodes) {
    const activeHandles = edges
      .filter((edge) => edge.source === route.id)
      .map((edge) => normalizeRouteSourceHandle(edge.sourceHandle));
    const descendants = collectRandomRouteBranchNodeIds({
      routeId: route.id,
      activeHandles,
      nodes,
      edges,
    });
    descendants.forEach((id) => excluded.add(id));
  }

  const keptNodes = nodes.filter((node) => !excluded.has(node.id));
  const keptNodeIds = nodeIdSet(keptNodes);
  return {
    nodes: keptNodes,
    edges: edges.filter((edge) => keptNodeIds.has(edge.source) && keptNodeIds.has(edge.target)),
    nodeIds: keptNodeIds,
  };
}
