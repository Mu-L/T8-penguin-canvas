import type { Edge, Node } from '@xyflow/react';

export type SubflowPortKind = 'text' | 'image' | 'video' | 'audio' | 'model3d' | 'metadata' | 'config' | 'any';

export interface SubflowValueSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface SubflowPort {
  id: string;
  name: string;
  kind: SubflowPortKind;
  required: boolean;
  defaultValue?: unknown;
  description?: string;
  order?: number;
  minConnections?: number;
  maxConnections?: number | null;
  schema?: SubflowValueSchema;
  internalNodeId: string;
  internalHandle?: string | null;
  boundaryEdgeId?: string;
}

export interface SubflowParameter {
  id: string;
  name: string;
  nodeId: string;
  dataKey: string;
  required?: boolean;
  defaultValue?: unknown;
  description?: string;
  order?: number;
  schema?: SubflowValueSchema;
}

export interface SubflowDependencyRef {
  definitionId: string;
  version: number;
  projectId?: string;
}

export interface SubflowDefinition {
  id: string;
  version: number;
  revision?: number;
  projectId?: string;
  name: string;
  description: string;
  category?: string;
  tags: string[];
  nodes: Node[];
  edges: Edge[];
  inputs: SubflowPort[];
  outputs: SubflowPort[];
  exposedParameters: SubflowParameter[];
  dependencies?: SubflowDependencyRef[];
  requiredCapabilities: string[];
  assetRefs: string[];
  changeSummary?: string;
  publishedBy?: string;
  publishedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface SubflowBoundaryAnalysis {
  definition: Omit<SubflowDefinition, 'id' | 'version'>;
  incomingEdges: Edge[];
  outgoingEdges: Edge[];
  bounds: { x: number; y: number; width: number; height: number };
}

export interface SubflowEndpoint {
  nodeId: string;
  handle?: string | null;
}

export interface SubflowExecutionNode {
  runtimeNodeId: string;
  originalNodeId: string;
  externalInstanceId: string;
  instancePath: string[];
  definitionId: string;
  definitionVersion: number;
  projectId?: string;
  inputSnapshot: Record<string, unknown>;
}

export interface SubflowExecutionPlan {
  planVersion: 1;
  externalInstanceId: string;
  rootDefinition: SubflowDependencyRef;
  nodes: Node[];
  edges: Edge[];
  order: string[];
  batches: string[][];
  inputTargets: Record<string, SubflowEndpoint>;
  outputSources: Record<string, SubflowEndpoint>;
  trace: Record<string, SubflowExecutionNode>;
  dependencies: SubflowDependencyRef[];
}

export interface CompiledSubflow extends SubflowExecutionPlan {
  nodeIdMap: Record<string, string>;
}

export interface SubflowNodePortContract {
  inputs: SubflowPortKind[];
  outputs: SubflowPortKind[];
  inputHandles?: string[];
  outputHandles?: string[];
}

export interface SubflowCompilationOptions {
  stack?: string[];
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
  resolveDefinition?: (reference: SubflowDependencyRef) => SubflowDefinition | null | undefined;
  resolveNodePorts?: (node: Node) => SubflowNodePortContract | null | undefined;
  knownNodeTypes?: ReadonlySet<string>;
}

export function subflowDependencyMapKey(reference: SubflowDependencyRef): string {
  const projectId = String(reference.projectId || 'project-local').trim() || 'project-local';
  const definitionId = String(reference.definitionId || '').trim();
  const version = Math.max(1, Math.trunc(Number(reference.version) || 1));
  return `${projectId}:${definitionId}:${version}`;
}

export async function loadSubflowDependencyDefinitions(
  root: SubflowDefinition,
  loader: (reference: SubflowDependencyRef) => Promise<SubflowDefinition>,
  maxDepth = 8,
) {
  const loaded = new Map<string, SubflowDefinition>();
  const visit = async (definition: SubflowDefinition, stack: string[]) => {
    if (stack.length > maxDepth) throw new Error(`子工作流嵌套超过 ${maxDepth} 层`);
    for (const node of definition.nodes || []) {
      if (node.type !== 'subflow') continue;
      const data = (node.data || {}) as Record<string, any>;
      const embedded = data.definition && typeof data.definition === 'object' ? data.definition as SubflowDefinition : null;
      const reference: SubflowDependencyRef = {
        definitionId: String(data.definitionId || embedded?.id || ''),
        version: Number(data.definitionVersion || embedded?.version || 0),
        projectId: String(data.definitionProjectId || embedded?.projectId || definition.projectId || root.projectId || '') || undefined,
      };
      if (!reference.definitionId || !reference.version) throw new Error(`嵌套子工作流节点 ${node.id} 缺少固定版本`);
      const key = subflowDependencyMapKey(reference);
      if (stack.includes(key)) throw new Error(`子工作流递归引用: ${[...stack, key].join(' -> ')}`);
      if (loaded.has(key)) continue;
      const resolved = embedded || await loader(reference);
      if (!resolved || resolved.id !== reference.definitionId || Number(resolved.version) !== reference.version) throw new Error(`嵌套子工作流解析版本不匹配: ${key}`);
      if (reference.projectId && resolved.projectId && resolved.projectId !== reference.projectId) throw new Error(`嵌套子工作流跨项目引用被拒绝: ${key}`);
      loaded.set(key, resolved);
      await visit(resolved, [...stack, key]);
    }
  };
  await visit(root, []);
  return loaded;
}

export interface SubflowDiffSection {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface SubflowDefinitionDiff {
  fromVersion: number;
  toVersion: number;
  nodes: SubflowDiffSection;
  edges: SubflowDiffSection;
  inputs: SubflowDiffSection;
  outputs: SubflowDiffSection;
  parameters: SubflowDiffSection;
}

export interface DetachedSubflowResult {
  nodes: Node[];
  edges: Edge[];
  detachedNodeIds: string[];
}

export interface SubflowUpgradeResult {
  nodes: Node[];
  edges: Edge[];
  upgradedNodeIds: string[];
  disconnectedEdges: Edge[];
  removedPortIds: string[];
  changedPortIds: string[];
  removedParameterIds: string[];
  changedParameterIds: string[];
  discardedOverrides: Array<{ nodeId: string; parameterId: string; value: unknown; reason: 'removed' | 'incompatible' }>;
}

export interface PreparedSubflowRootInputs {
  nodes: Node[];
  edges: Edge[];
  snapshot: Record<string, unknown>;
}

interface InternalCompilationContext {
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
  resolveDefinition?: SubflowCompilationOptions['resolveDefinition'];
  resolveNodePorts?: SubflowCompilationOptions['resolveNodePorts'];
  knownNodeTypes?: ReadonlySet<string>;
  nodes: Node[];
  edges: Edge[];
  trace: Record<string, SubflowExecutionNode>;
  dependencies: Map<string, SubflowDependencyRef>;
}

interface InternalCompiledDefinition {
  inputTargets: Record<string, SubflowEndpoint>;
  outputSources: Record<string, SubflowEndpoint>;
  nodeIdMap: Record<string, string>;
}

const clone = <T,>(value: T): T => {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const SUBFLOW_PRIVATE_KEY_PATTERN = /(?:api[_-]?key|authorization|cookie|password|passwd|passphrase|private[_-]?key|client[_-]?secret|app[_-]?secret|secret[_-]?key|secret[_-]?access[_-]?key|access[_-]?key[_-]?secret|credential|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|signature|signed[_-]?token)$/i;
const SUBFLOW_SECRET_QUERY_KEY_PATTERN = /^(?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|signature|sig|x-amz-signature|x-goog-signature)$/i;

function containsSensitiveUrl(value: unknown) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return true;
    for (const key of url.searchParams.keys()) if (SUBFLOW_SECRET_QUERY_KEY_PATTERN.test(key)) return true;
    return /(?:^|[&#])(?:token|signature|sig|api[_-]?key)=/i.test(url.hash);
  } catch (_) {
    return /[?&#](?:token|signature|sig|api[_-]?key)=/i.test(value);
  }
}

export function isPrivateSubflowDataKey(key: unknown) {
  const normalized = String(key || '').trim();
  if (!normalized) return false;
  return SUBFLOW_PRIVATE_KEY_PATTERN.test(normalized);
}

export function sanitizeSubflowNodeData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSubflowNodeData);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, item]) => !isPrivateSubflowDataKey(key) && !containsSensitiveUrl(item))
    .map(([key, item]) => [key, sanitizeSubflowNodeData(item)]));
}

function stableComparable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableComparable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => !['selected', 'dragging', 'measured', 'createdAt', 'updatedAt'].includes(key)).sort().map((key) => `${JSON.stringify(key)}:${stableComparable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function diffById<T>(before: T[], after: T[], getId: (value: T) => string): SubflowDiffSection {
  const previous = new Map(before.map((value) => [getId(value), value]));
  const next = new Map(after.map((value) => [getId(value), value]));
  const added = [...next.keys()].filter((id) => !previous.has(id)).sort();
  const removed = [...previous.keys()].filter((id) => !next.has(id)).sort();
  const changed = [...next.keys()].filter((id) => previous.has(id) && stableComparable(previous.get(id)) !== stableComparable(next.get(id))).sort();
  return { added, removed, changed };
}

export function diffSubflowDefinitions(before: SubflowDefinition, after: SubflowDefinition): SubflowDefinitionDiff {
  if (before.id !== after.id || (before.projectId && after.projectId && before.projectId !== after.projectId)) throw new Error('只能比较同一项目中的同一子工作流');
  return {
    fromVersion: before.version,
    toVersion: after.version,
    nodes: diffById(before.nodes || [], after.nodes || [], (item) => item.id),
    edges: diffById(before.edges || [], after.edges || [], (item) => item.id),
    inputs: diffById(before.inputs || [], after.inputs || [], (item) => item.id),
    outputs: diffById(before.outputs || [], after.outputs || [], (item) => item.id),
    parameters: diffById(before.exposedParameters || [], after.exposedParameters || [], (item) => item.id),
  };
}

function stableRefKey(reference: SubflowDependencyRef) {
  return `${reference.projectId || 'local-project'}:${reference.definitionId}@${reference.version}`;
}

function definitionRef(definition: SubflowDefinition): SubflowDependencyRef {
  return {
    definitionId: String(definition.id),
    version: Math.max(1, Number(definition.version) || 1),
    ...(definition.projectId ? { projectId: String(definition.projectId) } : {}),
  };
}

function runtimePrefix(parts: string[]) {
  return parts.map((part) => encodeURIComponent(String(part))).join('::');
}

function defaultInputData(port: SubflowPort) {
  const value = clone(port.defaultValue);
  if (port.kind === 'text') return { text: value, outputText: value, prompt: value };
  if (port.kind === 'image') return { imageUrl: value, imageUrls: Array.isArray(value) ? value : [value] };
  if (port.kind === 'video') return { videoUrl: value, videoUrls: Array.isArray(value) ? value : [value] };
  if (port.kind === 'audio') return { audioUrl: value, audioUrls: Array.isArray(value) ? value : [value] };
  if (port.kind === 'model3d') return { modelUrl: value, modelUrls: Array.isArray(value) ? value : [value] };
  if (port.kind === 'metadata') return { metadata: value };
  if (port.kind === 'config') return { config: value };
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

export function prepareSubflowRootInputs(
  definition: SubflowDefinition,
  instanceId: string,
  canvasNodes: Node[],
  canvasEdges: Edge[],
  inputTargets: Record<string, SubflowEndpoint>,
): PreparedSubflowRootInputs {
  const normalizedInputs = (definition.inputs || []).map(normalizePort);
  const portIds = new Set(normalizedInputs.map((port) => port.id));
  const incoming = canvasEdges.filter((edge) => edge.target === instanceId);
  const stale = incoming.find((edge) => !portIds.has(String(edge.targetHandle || '')));
  if (stale) throw new Error(`子工作流输入连线指向不存在的端口: ${String(stale.targetHandle || '(空)')}`);
  const sourceById = new Map(canvasNodes.map((node) => [node.id, node]));
  const preparedNodes: Node[] = [];
  const preparedEdges: Edge[] = [];
  const snapshot: Record<string, unknown> = {};

  for (const port of normalizedInputs) {
    const target = inputTargets[port.id];
    if (!target) throw new Error(`子工作流输入端口缺少内部目标: ${port.name || port.id}`);
    const connected = incoming.filter((edge) => edge.targetHandle === port.id);
    if (port.maxConnections != null && connected.length > port.maxConnections) {
      throw new Error(`子工作流输入端口 ${port.name || port.id} 最多允许 ${port.maxConnections} 条连接`);
    }
    const usesDefault = connected.length === 0 && port.defaultValue !== undefined;
    const effectiveCount = connected.length + (usesDefault ? 1 : 0);
    if (effectiveCount < (port.minConnections || 0)) {
      throw new Error(`子工作流输入端口 ${port.name || port.id} 至少需要 ${port.minConnections} 条连接`);
    }
    if (usesDefault && !isValueCompatible(port.defaultValue, port.schema)) {
      throw new Error(`子工作流输入端口默认值类型或范围无效: ${port.name || port.id}`);
    }

    if (usesDefault) {
      const sourceId = runtimePrefix([instanceId, '__default_input__', port.id]);
      preparedNodes.push({
        id: sourceId,
        type: 'output',
        position: { x: -320, y: preparedNodes.length * 60 },
        data: { ...defaultInputData(port), __subflowRuntime: true, __subflowDefaultInput: port.id },
      });
      preparedEdges.push({ id: runtimePrefix([instanceId, '__default_edge__', port.id]), source: sourceId, target: target.nodeId, targetHandle: target.handle });
      snapshot[port.id] = { mode: 'default', value: clone(port.defaultValue) };
      continue;
    }

    const snapshots: unknown[] = [];
    for (const edge of connected) {
      const source = sourceById.get(edge.source);
      if (!source) throw new Error(`子工作流输入连线来源节点不存在: ${edge.source}`);
      preparedEdges.push({
        ...clone(edge),
        id: runtimePrefix([instanceId, '__input_edge__', edge.id]),
        target: target.nodeId,
        targetHandle: target.handle,
      });
      snapshots.push({ sourceNodeId: source.id, sourceHandle: edge.sourceHandle || null, data: sanitizeSubflowNodeData(clone(source.data || {})) });
    }
    snapshot[port.id] = { mode: 'connections', values: snapshots };
  }
  return { nodes: preparedNodes, edges: preparedEdges, snapshot };
}

function normalizePort(port: SubflowPort, index: number): SubflowPort {
  const required = Boolean(port.required);
  const minConnections = Math.max(0, Math.trunc(port.minConnections ?? (required ? 1 : 0)));
  const maxConnections = port.maxConnections == null ? null : Math.max(1, Math.trunc(port.maxConnections));
  if (maxConnections != null && maxConnections < minConnections) {
    throw new Error(`端口 ${port.name || port.id} 的最大连接数小于最小连接数`);
  }
  return {
    ...port,
    id: String(port.id || '').trim(),
    name: String(port.name || port.id || '').trim(),
    kind: port.kind || 'any',
    required,
    order: Number.isFinite(port.order) ? Number(port.order) : index,
    minConnections,
    maxConnections,
  };
}

function isValueCompatible(value: unknown, schema?: SubflowValueSchema) {
  if (!schema) return true;
  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) return false;
  if (schema.type) {
    const typeMatches = schema.type === 'null'
      ? value === null
      : schema.type === 'array'
        ? Array.isArray(value)
        : schema.type === 'integer'
          ? Number.isInteger(value)
          : schema.type === 'object'
            ? Boolean(value) && typeof value === 'object' && !Array.isArray(value)
            : typeof value === schema.type;
    if (!typeMatches) return false;
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) return false;
    if (schema.maximum != null && value > schema.maximum) return false;
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) return false;
    if (schema.maxLength != null && value.length > schema.maxLength) return false;
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) return false;
      } catch (_) {
        return false;
      }
    }
  }
  return true;
}

function kindsCompatible(source: SubflowPortKind, target: SubflowPortKind) {
  return source === 'any' || target === 'any' || source === target;
}

export function inferSubflowPortKind(handle: unknown): SubflowPortKind {
  const text = String(handle || '').toLowerCase();
  if (/image|img|picture/.test(text)) return 'image';
  if (/video|movie/.test(text)) return 'video';
  if (/audio|sound|music/.test(text)) return 'audio';
  if (/model|3d|glb|gltf/.test(text)) return 'model3d';
  if (/metadata|meta|json/.test(text)) return 'metadata';
  if (/config|param|setting/.test(text)) return 'config';
  if (/text|prompt|string/.test(text)) return 'text';
  return 'any';
}

function portId(prefix: 'in' | 'out', edge: Edge, index: number) {
  const raw = `${prefix}-${edge.id || index}-${prefix === 'in' ? edge.target : edge.source}`;
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 120);
}

export function analyzeSubflowBoundary(
  selectedNodes: Node[],
  allEdges: Edge[],
  options: { name?: string; description?: string } = {},
): SubflowBoundaryAnalysis {
  if (!selectedNodes.length) throw new Error('至少选择一个节点');
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const incomingEdges = allEdges.filter((edge) => !selectedIds.has(edge.source) && selectedIds.has(edge.target));
  const outgoingEdges = allEdges.filter((edge) => selectedIds.has(edge.source) && !selectedIds.has(edge.target));
  const internalEdges = allEdges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target));
  const x = Math.min(...selectedNodes.map((node) => node.position.x));
  const y = Math.min(...selectedNodes.map((node) => node.position.y));
  const right = Math.max(...selectedNodes.map((node) => node.position.x + Number(node.measured?.width || node.width || 320)));
  const bottom = Math.max(...selectedNodes.map((node) => node.position.y + Number(node.measured?.height || node.height || 180)));
  const nodes = selectedNodes.map((node) => ({
    ...clone(node),
    selected: false,
    position: { x: node.position.x - x, y: node.position.y - y },
    data: sanitizeSubflowNodeData(clone(node.data || {})) as Record<string, unknown>,
  }));
  const inputs = incomingEdges.map((edge, index): SubflowPort => normalizePort({
    id: portId('in', edge, index),
    name: `输入 ${index + 1}`,
    kind: inferSubflowPortKind(edge.targetHandle || edge.sourceHandle),
    required: true,
    internalNodeId: edge.target,
    internalHandle: edge.targetHandle,
    boundaryEdgeId: edge.id,
    maxConnections: 1,
  }, index));
  const outputs = outgoingEdges.map((edge, index): SubflowPort => normalizePort({
    id: portId('out', edge, index),
    name: `输出 ${index + 1}`,
    kind: inferSubflowPortKind(edge.sourceHandle || edge.targetHandle),
    required: false,
    internalNodeId: edge.source,
    internalHandle: edge.sourceHandle,
    boundaryEdgeId: edge.id,
  }, index));
  const dependencies = nodes
    .filter((node) => node.type === 'subflow')
    .map((node) => ({
      definitionId: String((node.data as Record<string, unknown>)?.definitionId || ''),
      version: Math.max(1, Number((node.data as Record<string, unknown>)?.definitionVersion) || 1),
      projectId: String((node.data as Record<string, unknown>)?.definitionProjectId || '') || undefined,
    }))
    .filter((reference) => reference.definitionId);
  return {
    incomingEdges: clone(incomingEdges),
    outgoingEdges: clone(outgoingEdges),
    bounds: { x, y, width: right - x, height: bottom - y },
    definition: {
      name: options.name || `子工作流 ${selectedNodes.length} 节点`,
      description: options.description || '',
      tags: [],
      nodes,
      edges: clone(internalEdges),
      inputs,
      outputs,
      exposedParameters: [],
      dependencies,
      requiredCapabilities: [],
      assetRefs: [],
    },
  };
}

function topologicalOrder(nodes: Node[], edges: Edge[]) {
  const ids = new Set(nodes.map((node) => node.id));
  const indegree = new Map([...ids].map((id) => [id, 0]));
  const outgoing = new Map([...ids].map((id) => [id, [] as string[]]));
  edges.forEach((edge) => {
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new Error(`悬空内部连线: ${edge.id}`);
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  });
  const queue = nodes.map((node) => node.id).filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const target of outgoing.get(id) || []) {
      indegree.set(target, (indegree.get(target) || 0) - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }
  if (order.length !== nodes.length) throw new Error('子工作流包含循环依赖');
  return order;
}

function topologicalBatches(nodes: Node[], edges: Edge[]) {
  const ids = new Set(nodes.map((node) => node.id));
  const indegree = new Map([...ids].map((id) => [id, 0]));
  const outgoing = new Map([...ids].map((id) => [id, [] as string[]]));
  edges.forEach((edge) => {
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new Error(`悬空内部连线: ${edge.id}`);
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  });
  let frontier = nodes.map((node) => node.id).filter((id) => indegree.get(id) === 0);
  const batches: string[][] = [];
  let visited = 0;
  while (frontier.length) {
    const batch = [...frontier];
    batches.push(batch);
    visited += batch.length;
    const next: string[] = [];
    for (const id of batch) {
      for (const target of outgoing.get(id) || []) {
        indegree.set(target, (indegree.get(target) || 0) - 1);
        if (indegree.get(target) === 0) next.push(target);
      }
    }
    frontier = next;
  }
  if (visited !== nodes.length) throw new Error('子工作流包含循环依赖');
  return batches;
}

function getNestedReference(node: Node, parent: SubflowDefinition): SubflowDependencyRef {
  const data = (node.data || {}) as Record<string, unknown>;
  const embedded = data.definition as SubflowDefinition | undefined;
  const definitionId = String(data.definitionId || embedded?.id || '').trim();
  const version = Math.max(1, Number(data.definitionVersion || embedded?.version) || 1);
  if (!definitionId) throw new Error(`嵌套子工作流节点 ${node.id} 缺少 definitionId`);
  return {
    definitionId,
    version,
    projectId: String(data.definitionProjectId || embedded?.projectId || parent.projectId || '').trim() || undefined,
  };
}

function resolveNestedDefinition(node: Node, parent: SubflowDefinition, context: InternalCompilationContext) {
  const data = (node.data || {}) as Record<string, unknown>;
  const embedded = data.definition as SubflowDefinition | undefined;
  const reference = getNestedReference(node, parent);
  const resolved = embedded && embedded.id === reference.definitionId && Number(embedded.version) === reference.version
    ? embedded
    : context.resolveDefinition?.(reference);
  if (!resolved) throw new Error(`找不到嵌套子工作流 ${stableRefKey(reference)}`);
  if (String(resolved.id) !== reference.definitionId || Number(resolved.version) !== reference.version) {
    throw new Error(`嵌套子工作流解析版本不匹配: ${stableRefKey(reference)}`);
  }
  if (reference.projectId && resolved.projectId && String(resolved.projectId) !== reference.projectId) {
    throw new Error(`嵌套子工作流跨项目引用被拒绝: ${stableRefKey(reference)}`);
  }
  return resolved;
}

function endpointFor(
  node: Node,
  handle: string | null | undefined,
  direction: 'input' | 'output',
  simpleNodeIds: Record<string, string>,
  nested: Map<string, InternalCompiledDefinition>,
): SubflowEndpoint {
  if (node.type !== 'subflow') return { nodeId: simpleNodeIds[node.id], handle };
  const ports = direction === 'input' ? nested.get(node.id)?.inputTargets : nested.get(node.id)?.outputSources;
  const key = String(handle || '');
  if (!key || !ports?.[key]) throw new Error(`嵌套子工作流节点 ${node.id} 缺少${direction === 'input' ? '输入' : '输出'}端口 ${key || '(空)'}`);
  return ports[key];
}

function validateNodeContract(node: Node, context: InternalCompilationContext) {
  if (!node.type) throw new Error(`节点 ${node.id} 缺少类型`);
  if (context.knownNodeTypes && !context.knownNodeTypes.has(node.type) && node.type !== 'subflow') {
    throw new Error(`未知节点类型: ${node.type}`);
  }
}

function validateEndpointContract(node: Node, handle: string | null | undefined, kind: SubflowPortKind, direction: 'input' | 'output', context: InternalCompilationContext) {
  if (node.type === 'subflow') return;
  const contract = context.resolveNodePorts?.(node);
  if (!contract) return;
  const kinds = direction === 'input' ? contract.inputs : contract.outputs;
  if (!kinds.some((candidate) => kindsCompatible(direction === 'input' ? kind : candidate, direction === 'input' ? candidate : kind))) {
    throw new Error(`端口类型不兼容: ${node.id}.${String(handle || '')} 不能${direction === 'input' ? '接收' : '输出'} ${kind}`);
  }
  const handles = direction === 'input' ? contract.inputHandles : contract.outputHandles;
  if (handle && handles && !handles.includes(handle)) throw new Error(`节点 ${node.id} 不存在端口 ${handle}`);
}

function compileDefinition(
  definition: SubflowDefinition,
  instancePath: string[],
  parameterOverrides: Record<string, unknown>,
  stack: string[],
  context: InternalCompilationContext,
  offset: { x: number; y: number } = { x: 0, y: 0 },
): InternalCompiledDefinition {
  const reference = definitionRef(definition);
  const refKey = stableRefKey(reference);
  if (stack.length >= context.maxDepth) throw new Error(`子工作流嵌套超过 ${context.maxDepth} 层`);
  if (stack.includes(refKey) || stack.includes(definition.id)) throw new Error(`子工作流递归引用: ${[...stack, refKey].join(' -> ')}`);
  if (!definition.nodes.length) throw new Error('子工作流定义没有节点');
  context.dependencies.set(refKey, reference);

  const directNodeIds = new Set<string>();
  for (const node of definition.nodes) {
    if (!node.id || directNodeIds.has(node.id)) throw new Error(`子工作流节点 ID 缺失或重复: ${node.id || '(空)'}`);
    directNodeIds.add(node.id);
    validateNodeContract(node, context);
  }

  const simpleNodeIds: Record<string, string> = {};
  const nested = new Map<string, InternalCompiledDefinition>();
  const nodeIdMap: Record<string, string> = {};
  const parametersByNode = new Map<string, SubflowParameter[]>();
  const parameterIds = new Set<string>();
  for (const parameter of definition.exposedParameters || []) {
    if (!parameter.id || parameterIds.has(parameter.id)) throw new Error(`公开参数 ID 缺失或重复: ${parameter.id || '(空)'}`);
    parameterIds.add(parameter.id);
    if (!directNodeIds.has(parameter.nodeId)) throw new Error(`参数 ${parameter.name || parameter.id} 指向不存在的节点`);
    if (isPrivateSubflowDataKey(parameter.dataKey) || isPrivateSubflowDataKey(parameter.name)) {
      throw new Error(`私密字段不能公开为参数: ${parameter.name || parameter.id}`);
    }
    parametersByNode.set(parameter.nodeId, [...(parametersByNode.get(parameter.nodeId) || []), parameter]);
  }

  for (const node of definition.nodes) {
    if (node.type === 'subflow') {
      const childDefinition = resolveNestedDefinition(node, definition, context);
      const storedChildOverrides = ((node.data || {}) as Record<string, unknown>).parameterOverrides;
      const childOverrides = storedChildOverrides && typeof storedChildOverrides === 'object'
        ? clone(storedChildOverrides as Record<string, unknown>)
        : {};
      for (const parameter of parametersByNode.get(node.id) || []) {
        const hasOverride = Object.hasOwn(parameterOverrides, parameter.id);
        const value = hasOverride ? parameterOverrides[parameter.id] : parameter.defaultValue;
        if (value === undefined) {
          if (parameter.required && childOverrides[parameter.dataKey] === undefined) throw new Error(`缺少必填参数: ${parameter.name || parameter.id}`);
          continue;
        }
        if (!isValueCompatible(value, parameter.schema)) throw new Error(`参数类型或范围无效: ${parameter.name || parameter.id}`);
        childOverrides[parameter.dataKey] = clone(value);
      }
      const compiledChild = compileDefinition(
        childDefinition,
        [...instancePath, node.id],
        childOverrides,
        [...stack, refKey],
        context,
        {
          x: offset.x + Number(node.position?.x || 0),
          y: offset.y + Number(node.position?.y || 0),
        },
      );
      nested.set(node.id, compiledChild);
      nodeIdMap[node.id] = runtimePrefix([...instancePath, node.id]);
      continue;
    }

    const runtimeNodeId = runtimePrefix([...instancePath, node.id]);
    simpleNodeIds[node.id] = runtimeNodeId;
    nodeIdMap[node.id] = runtimeNodeId;
    const next = clone(node);
    next.id = runtimeNodeId;
    next.position = {
      x: offset.x + Number(node.position?.x || 0),
      y: offset.y + Number(node.position?.y || 0),
    };
    const data = { ...((next.data || {}) as Record<string, unknown>) };
    for (const parameter of parametersByNode.get(node.id) || []) {
      const hasOverride = Object.hasOwn(parameterOverrides, parameter.id);
      const value = hasOverride ? parameterOverrides[parameter.id] : parameter.defaultValue;
      if (value === undefined) {
        if (parameter.required && data[parameter.dataKey] === undefined) throw new Error(`缺少必填参数: ${parameter.name || parameter.id}`);
        continue;
      }
      if (!isValueCompatible(value, parameter.schema)) throw new Error(`参数类型或范围无效: ${parameter.name || parameter.id}`);
      data[parameter.dataKey] = clone(value);
    }
    next.data = {
      ...data,
      __subflowInstanceId: instancePath[0],
      __subflowInstancePath: [...instancePath],
      __subflowDefinitionId: definition.id,
      __subflowDefinitionVersion: definition.version,
    };
    context.nodes.push(next);
    context.trace[runtimeNodeId] = {
      runtimeNodeId,
      originalNodeId: node.id,
      externalInstanceId: instancePath[0],
      instancePath: [...instancePath, node.id],
      definitionId: definition.id,
      definitionVersion: definition.version,
      projectId: definition.projectId,
      inputSnapshot: clone(data),
    };
    if (context.nodes.length > context.maxNodes) throw new Error(`子工作流展开节点超过 ${context.maxNodes} 个`);
  }

  const edgeIds = new Set<string>();
  const targetConnectionCounts = new Map<string, number>();
  const sourceConnectionCounts = new Map<string, number>();
  for (const edge of definition.edges) {
    if (!edge.id || edgeIds.has(edge.id)) throw new Error(`子工作流连线 ID 缺失或重复: ${edge.id || '(空)'}`);
    edgeIds.add(edge.id);
    const sourceNode = definition.nodes.find((node) => node.id === edge.source);
    const targetNode = definition.nodes.find((node) => node.id === edge.target);
    if (!sourceNode || !targetNode) throw new Error(`悬空内部连线: ${edge.id}`);
    const source = endpointFor(sourceNode, edge.sourceHandle, 'output', simpleNodeIds, nested);
    const target = endpointFor(targetNode, edge.targetHandle, 'input', simpleNodeIds, nested);
    const sourceKind = inferSubflowPortKind(edge.sourceHandle);
    const targetKind = inferSubflowPortKind(edge.targetHandle);
    if (sourceKind !== 'any' && targetKind !== 'any' && !kindsCompatible(sourceKind, targetKind)) {
      throw new Error(`内部连线类型不兼容: ${edge.id} (${sourceKind} -> ${targetKind})`);
    }
    const runtimeEdgeId = runtimePrefix([...instancePath, edge.id]);
    context.edges.push({ ...clone(edge), id: runtimeEdgeId, source: source.nodeId, sourceHandle: source.handle, target: target.nodeId, targetHandle: target.handle });
    const sourceKey = `${edge.source}:${String(edge.sourceHandle || '')}`;
    const targetKey = `${edge.target}:${String(edge.targetHandle || '')}`;
    sourceConnectionCounts.set(sourceKey, (sourceConnectionCounts.get(sourceKey) || 0) + 1);
    targetConnectionCounts.set(targetKey, (targetConnectionCounts.get(targetKey) || 0) + 1);
    if (context.edges.length > context.maxEdges) throw new Error(`子工作流展开连线超过 ${context.maxEdges} 条`);
  }

  for (const port of definition.inputs || []) {
    const key = `${port.internalNodeId}:${String(port.internalHandle || '')}`;
    targetConnectionCounts.set(key, (targetConnectionCounts.get(key) || 0) + 1);
  }
  for (const port of definition.outputs || []) {
    const key = `${port.internalNodeId}:${String(port.internalHandle || '')}`;
    sourceConnectionCounts.set(key, (sourceConnectionCounts.get(key) || 0) + 1);
  }

  for (const node of definition.nodes.filter((candidate) => candidate.type === 'subflow')) {
    const childDefinition = resolveNestedDefinition(node, definition, context);
    for (const port of childDefinition.inputs.map(normalizePort)) {
      const count = targetConnectionCounts.get(`${node.id}:${port.id}`) || 0;
      if (port.defaultValue === undefined && count < (port.minConnections || 0)) throw new Error(`嵌套端口 ${node.id}.${port.name} 至少需要 ${port.minConnections} 条连接`);
      if (port.maxConnections != null && count > port.maxConnections) throw new Error(`嵌套端口 ${node.id}.${port.name} 最多允许 ${port.maxConnections} 条连接`);
    }
    for (const port of childDefinition.outputs.map(normalizePort)) {
      const count = sourceConnectionCounts.get(`${node.id}:${port.id}`) || 0;
      if (count < (port.minConnections || 0)) throw new Error(`嵌套端口 ${node.id}.${port.name} 至少需要 ${port.minConnections} 条连接`);
      if (port.maxConnections != null && count > port.maxConnections) throw new Error(`嵌套端口 ${node.id}.${port.name} 最多允许 ${port.maxConnections} 条连接`);
    }
  }

  const normalizedInputs = (definition.inputs || []).map(normalizePort).sort((a, b) => (a.order || 0) - (b.order || 0) || a.id.localeCompare(b.id));
  const normalizedOutputs = (definition.outputs || []).map(normalizePort).sort((a, b) => (a.order || 0) - (b.order || 0) || a.id.localeCompare(b.id));
  const allPortIds = [...normalizedInputs, ...normalizedOutputs].map((port) => port.id);
  if (allPortIds.some((id) => !id) || new Set(allPortIds).size !== allPortIds.length) throw new Error('子工作流端口 ID 缺失或重复');

  const inputTargets: Record<string, SubflowEndpoint> = {};
  for (const port of normalizedInputs) {
    const node = definition.nodes.find((candidate) => candidate.id === port.internalNodeId);
    if (!node) throw new Error(`端口 ${port.name} 指向不存在的节点`);
    validateEndpointContract(node, port.internalHandle, port.kind, 'input', context);
    inputTargets[port.id] = endpointFor(node, port.internalHandle, 'input', simpleNodeIds, nested);
  }
  const outputSources: Record<string, SubflowEndpoint> = {};
  for (const port of normalizedOutputs) {
    const node = definition.nodes.find((candidate) => candidate.id === port.internalNodeId);
    if (!node) throw new Error(`端口 ${port.name} 指向不存在的节点`);
    validateEndpointContract(node, port.internalHandle, port.kind, 'output', context);
    outputSources[port.id] = endpointFor(node, port.internalHandle, 'output', simpleNodeIds, nested);
  }
  return { inputTargets, outputSources, nodeIdMap };
}

export function compileSubflow(
  definition: SubflowDefinition,
  instanceId: string,
  parameterOverrides: Record<string, unknown> = {},
  options: SubflowCompilationOptions = {},
): CompiledSubflow {
  const context: InternalCompilationContext = {
    maxDepth: Math.max(1, options.maxDepth ?? 8),
    maxNodes: Math.max(1, options.maxNodes ?? 2000),
    maxEdges: Math.max(0, options.maxEdges ?? 5000),
    resolveDefinition: options.resolveDefinition,
    resolveNodePorts: options.resolveNodePorts,
    knownNodeTypes: options.knownNodeTypes,
    nodes: [],
    edges: [],
    trace: {},
    dependencies: new Map(),
  };
  const initialStack = (options.stack || []).map(String);
  const compiled = compileDefinition(definition, [String(instanceId)], parameterOverrides, initialStack, context);
  const order = topologicalOrder(context.nodes, context.edges);
  const batches = topologicalBatches(context.nodes, context.edges);
  const rootReference = definitionRef(definition);
  return {
    planVersion: 1,
    externalInstanceId: String(instanceId),
    rootDefinition: rootReference,
    nodes: context.nodes,
    edges: context.edges,
    order,
    batches,
    inputTargets: compiled.inputTargets,
    outputSources: compiled.outputSources,
    trace: context.trace,
    dependencies: [...context.dependencies.values()].filter((item) => stableRefKey(item) !== stableRefKey(rootReference)),
    nodeIdMap: compiled.nodeIdMap,
  };
}

function stripSubflowRuntimeData(data: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !key.startsWith('__subflow')));
}

export function detachSubflowInstance(
  canvasNodes: Node[],
  canvasEdges: Edge[],
  instanceId: string,
  options: SubflowCompilationOptions = {},
): DetachedSubflowResult {
  const instance = canvasNodes.find((node) => node.id === instanceId && node.type === 'subflow');
  if (!instance) throw new Error('找不到要脱离的子工作流实例');
  if (canvasNodes.some((node) => (node.data as Record<string, unknown> | undefined)?.__subflowRuntime
    && (node.data as Record<string, unknown> | undefined)?.__subflowInstanceId === instanceId)) {
    throw new Error('子工作流运行中，停止后才能脱离定义');
  }
  const data = (instance.data || {}) as Record<string, unknown>;
  const definition = data.definition as SubflowDefinition | undefined;
  if (!definition) throw new Error('子工作流定义缺失，无法脱离');
  const overrides = data.parameterOverrides && typeof data.parameterOverrides === 'object'
    ? data.parameterOverrides as Record<string, unknown>
    : {};
  const compiled = compileSubflow(definition, instanceId, overrides, options);
  const origin = instance.position || { x: 0, y: 0 };
  const detachedNodes = compiled.nodes.map((node) => ({
    ...clone(node),
    selected: true,
    draggable: node.draggable !== false,
    selectable: node.selectable !== false,
    position: {
      x: Number(origin.x || 0) + Number(node.position?.x || 0),
      y: Number(origin.y || 0) + Number(node.position?.y || 0),
    },
    data: stripSubflowRuntimeData({ ...((node.data || {}) as Record<string, unknown>) }),
  }));
  const detachedNodeIds = detachedNodes.map((node) => node.id);
  const occupiedNodeIds = new Set(canvasNodes.filter((node) => node.id !== instanceId).map((node) => node.id));
  const collidingNodeIds = detachedNodeIds.filter((id) => occupiedNodeIds.has(id));
  if (collidingNodeIds.length) throw new Error(`脱离定义会与现有节点 ID 冲突: ${collidingNodeIds.join('、')}`);
  const untouchedNodes = canvasNodes
    .filter((node) => node.id !== instanceId)
    .map((node) => ({ ...node, selected: false }));
  const remappedExternalEdges = canvasEdges
    .filter((edge) => edge.source !== instanceId || edge.target !== instanceId)
    .map((edge) => {
      if (edge.target === instanceId) {
        const target = compiled.inputTargets[String(edge.targetHandle || '')];
        if (!target) throw new Error(`输入端口不存在，无法重接: ${String(edge.targetHandle || '(空)')}`);
        return { ...clone(edge), target: target.nodeId, targetHandle: target.handle, selected: false };
      }
      if (edge.source === instanceId) {
        const source = compiled.outputSources[String(edge.sourceHandle || '')];
        if (!source) throw new Error(`输出端口不存在，无法重接: ${String(edge.sourceHandle || '(空)')}`);
        return { ...clone(edge), source: source.nodeId, sourceHandle: source.handle, selected: false };
      }
      return { ...edge, selected: false };
    });
  const detachedEdges = compiled.edges.map((edge) => ({ ...clone(edge), selected: false }));
  const edgeIds = new Set<string>();
  const collidingEdgeIds = [...remappedExternalEdges, ...detachedEdges]
    .map((edge) => edge.id)
    .filter((id) => {
      if (edgeIds.has(id)) return true;
      edgeIds.add(id);
      return false;
    });
  if (collidingEdgeIds.length) throw new Error(`脱离定义会与现有连线 ID 冲突: ${[...new Set(collidingEdgeIds)].join('、')}`);
  return {
    nodes: [...untouchedNodes, ...detachedNodes],
    edges: [...remappedExternalEdges, ...detachedEdges],
    detachedNodeIds,
  };
}

export function upgradeSubflowInstances(
  canvasNodes: Node[],
  canvasEdges: Edge[],
  fromDefinition: SubflowDefinition,
  toDefinition: SubflowDefinition,
): SubflowUpgradeResult {
  if (fromDefinition.id !== toDefinition.id) throw new Error('只能升级同一子工作流的固定版本');
  const fromProjectId = String(fromDefinition.projectId || 'project-local');
  const toProjectId = String(toDefinition.projectId || 'project-local');
  if (fromProjectId !== toProjectId) {
    throw new Error('不能跨项目升级子工作流实例');
  }
  if (Number(toDefinition.version) <= Number(fromDefinition.version)) throw new Error('目标版本必须高于当前版本');
  validateSubflowDefinition(toDefinition);
  const previousPorts = new Map([...fromDefinition.inputs, ...fromDefinition.outputs].map((port) => [port.id, port]));
  const nextPorts = new Map([...toDefinition.inputs, ...toDefinition.outputs].map((port) => [port.id, port]));
  const removedPortIds = [...previousPorts.keys()].filter((id) => !nextPorts.has(id)).sort();
  const changedPortIds = [...previousPorts.keys()].filter((id) => {
    const before = previousPorts.get(id);
    const after = nextPorts.get(id);
    if (!before || !after) return false;
    const contract = (port: SubflowPort) => ({
      kind: port.kind, required: port.required, defaultValue: port.defaultValue, minConnections: port.minConnections,
      maxConnections: port.maxConnections, schema: port.schema, internalNodeId: port.internalNodeId, internalHandle: port.internalHandle,
    });
    return stableComparable(contract(before)) !== stableComparable(contract(after));
  }).sort();
  const unsafePorts = new Set([
    ...removedPortIds,
    ...[...previousPorts.keys()].filter((id) => {
      const before = previousPorts.get(id);
      const after = nextPorts.get(id);
      return before && after && (before.kind !== after.kind || before.internalNodeId !== after.internalNodeId || before.internalHandle !== after.internalHandle);
    }),
  ]);
  const previousParameters = new Map((fromDefinition.exposedParameters || []).map((parameter) => [parameter.id, parameter]));
  const nextParameters = new Map((toDefinition.exposedParameters || []).map((parameter) => [parameter.id, parameter]));
  const removedParameterIds = [...previousParameters.keys()].filter((id) => !nextParameters.has(id)).sort();
  const changedParameterIds = [...previousParameters.keys()].filter((id) => {
    const before = previousParameters.get(id);
    const after = nextParameters.get(id);
    return before && after && stableComparable(before) !== stableComparable(after);
  }).sort();
  const upgradedNodeIds = canvasNodes.filter((node) => {
    if (node.type !== 'subflow') return false;
    const data = (node.data || {}) as Record<string, unknown>;
    const embedded = data.definition as SubflowDefinition | undefined;
    const instanceProjectId = String(data.definitionProjectId || embedded?.projectId || 'project-local');
    return String(data.definitionId || (data.definition as SubflowDefinition | undefined)?.id || '') === fromDefinition.id
      && Number(data.definitionVersion || embedded?.version) === Number(fromDefinition.version)
      && instanceProjectId === fromProjectId;
  }).map((node) => node.id);
  const upgradedSet = new Set(upgradedNodeIds);
  const disconnectedIds = new Set(canvasEdges.filter((edge) => (
    (upgradedSet.has(edge.target) && unsafePorts.has(String(edge.targetHandle || '')))
    || (upgradedSet.has(edge.source) && unsafePorts.has(String(edge.sourceHandle || '')))
  )).map((edge) => edge.id));

  for (const nodeId of upgradedNodeIds) {
    for (const port of (toDefinition.inputs || []).map(normalizePort)) {
      const candidates = canvasEdges.filter((edge) => edge.target === nodeId && edge.targetHandle === port.id && !disconnectedIds.has(edge.id));
      const effectiveCount = candidates.length + (candidates.length === 0 && port.defaultValue !== undefined ? 1 : 0);
      if (effectiveCount < (port.minConnections || 0) && !unsafePorts.has(port.id)) throw new Error(`升级后输入端口 ${port.name || port.id} 至少需要 ${port.minConnections} 条连接`);
      if (port.maxConnections != null && candidates.length > port.maxConnections) {
        candidates.slice(port.maxConnections).forEach((edge) => disconnectedIds.add(edge.id));
      }
    }
    for (const port of (toDefinition.outputs || []).map(normalizePort)) {
      const candidates = canvasEdges.filter((edge) => edge.source === nodeId && edge.sourceHandle === port.id && !disconnectedIds.has(edge.id));
      if (candidates.length < (port.minConnections || 0) && !unsafePorts.has(port.id)) throw new Error(`升级后输出端口 ${port.name || port.id} 至少需要 ${port.minConnections} 条连接`);
      if (port.maxConnections != null && candidates.length > port.maxConnections) {
        candidates.slice(port.maxConnections).forEach((edge) => disconnectedIds.add(edge.id));
      }
    }
  }
  const disconnectedEdges = canvasEdges.filter((edge) => disconnectedIds.has(edge.id));
  const discardedOverrides: SubflowUpgradeResult['discardedOverrides'] = [];
  const nodes = canvasNodes.map((node) => {
    if (!upgradedSet.has(node.id)) return node;
    const data = (node.data || {}) as Record<string, unknown>;
    const currentOverrides = data.parameterOverrides && typeof data.parameterOverrides === 'object'
      ? data.parameterOverrides as Record<string, unknown>
      : {};
    const overrides = Object.fromEntries(Object.entries(currentOverrides).filter(([id, value]) => {
      const parameter = nextParameters.get(id);
      const reason = !parameter ? 'removed' : !isValueCompatible(value, parameter.schema) ? 'incompatible' : null;
      if (reason) discardedOverrides.push({ nodeId: node.id, parameterId: id, value: clone(value), reason });
      return !reason;
    }));
    return {
      ...node,
      selected: true,
      data: {
        ...data,
        definitionId: toDefinition.id,
        definitionVersion: toDefinition.version,
        definitionProjectId: toDefinition.projectId,
        definition: clone(toDefinition),
        parameterOverrides: overrides,
      },
    };
  });
  return {
    nodes,
    edges: canvasEdges.filter((edge) => !disconnectedIds.has(edge.id)),
    upgradedNodeIds,
    disconnectedEdges: clone(disconnectedEdges),
    removedPortIds,
    changedPortIds,
    removedParameterIds,
    changedParameterIds,
    discardedOverrides,
  };
}

export function validateSubflowDefinition(definition: SubflowDefinition, options: SubflowCompilationOptions = {}) {
  compileSubflow(definition, '__validate__', {}, options);
  return true;
}
