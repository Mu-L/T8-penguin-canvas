import type { Edge, Node } from '@xyflow/react';
import { EXECUTABLE_NODE_TYPES } from '../config/executableNodeTypes.ts';
import {
  buildLoopParallelCloneGraph,
  collectLoopIterationMaterials,
  isLoopRunRequestId,
} from './loopDerivedExecution.ts';
import {
  compileSubflow,
  prepareSubflowRootInputs,
  subflowDependencyMapKey,
  type SubflowDefinition,
  type SubflowDependencyRef,
} from './subflows.ts';

export const DERIVED_EXECUTION_SCOPE_DEFAULT_LIMITS = Object.freeze({
  maxNodes: 20_000,
  maxEdges: 20_000,
  maxSubflowDepth: 8,
  maxSubflowDependencies: 256,
});

export interface DerivedExecutionScopeLimits {
  maxNodes: number;
  maxEdges: number;
  maxSubflowDepth: number;
  maxSubflowDependencies: number;
}

export type DerivedExecutionScopeBlockerCode =
  | 'graph-node-limit'
  | 'graph-edge-limit'
  | 'graph-node-id-invalid'
  | 'graph-node-id-duplicate'
  | 'graph-edge-id-invalid'
  | 'graph-edge-id-duplicate'
  | 'requested-node-missing'
  | 'derived-edge-endpoint-missing'
  | 'loop-input-empty'
  | 'loop-input-unstable'
  | 'loop-downstream-missing'
  | 'loop-request-id-invalid'
  | 'loop-clone-node-limit'
  | 'loop-clone-edge-limit'
  | 'loop-runtime-node-id-collision'
  | 'loop-runtime-edge-id-collision'
  | 'loop-clone-build-invalid'
  | 'subflow-definition-missing'
  | 'subflow-definition-pin-mismatch'
  | 'subflow-parameter-overrides-invalid'
  | 'subflow-dependency-unavailable'
  | 'subflow-dependency-pin-mismatch'
  | 'subflow-dependency-project-mismatch'
  | 'subflow-dependency-cycle'
  | 'subflow-depth-limit'
  | 'subflow-dependency-limit'
  | 'subflow-node-limit'
  | 'subflow-edge-limit'
  | 'subflow-input-invalid'
  | 'subflow-compile-invalid'
  | 'subflow-runtime-node-id-collision'
  | 'subflow-runtime-edge-id-collision';

export interface DerivedExecutionScopeBlocker {
  code: DerivedExecutionScopeBlockerCode;
  /** Stable, non-secret summary. Never contains the caught loader/compiler error. */
  title: string;
  nodeIds: string[];
  /** Present only when the caller must prefetch this exact pinned dependency and rerun. */
  dependency?: SubflowDependencyRef;
}

export interface BuildPossibleDerivedExecutionScopeInput {
  nodes: readonly Node[];
  edges: readonly Edge[];
  /** Nodes the root Canvas action intends to trigger. */
  executionNodeIds: readonly string[];
  /** Stable per-Run request ID used to derive parallel Loop clone identities. */
  requestId?: string;
  /**
   * Synchronous, already-prefetched lookup for fixed subflow dependencies.
   * It must never perform network I/O. A missing dependency makes coverage
   * incomplete; callers must fetch it before preflight and rerun this function.
   */
  resolveSubflowDefinition?: (reference: SubflowDependencyRef) => SubflowDefinition | null | undefined;
  limits?: Partial<DerivedExecutionScopeLimits>;
}

export interface LoopParallelCloneAuthorizationGroup {
  schedulerNodeId: string;
  itemCount: number;
  cloneCount: number;
  cloneNodeIds: string[];
}

export interface PossibleDerivedExecutionScope {
  /** False means callers must not authorize any ID or execute the partial graph. */
  coverageComplete: boolean;
  /** Exact root request, kept separate so run-single cardinality remains one. */
  requestedExecutionNodeIds: string[];
  /**
   * Every currently materialized stable node that may receive an execution
   * token, including hidden subflow runtime nodes and every conservative
   * random/loop branch and exact request-bound parallel Loop clones. This list
   * becomes an allowlist only after the complete scope has passed preflight.
   */
  requiredAuthorizationNodeIds: string[];
  loopParallelCloneGroups: LoopParallelCloneAuthorizationGroup[];
  derivedRuntimeNodeIds: string[];
  diagnosticContextNodeIds: string[];
  expandedSchedulerNodeIds: string[];
  expandedSubflowInstanceIds: string[];
  nodes: Node[];
  edges: Edge[];
  blockers: DerivedExecutionScopeBlocker[];
}

const BLOCKER_TITLES: Record<DerivedExecutionScopeBlockerCode, string> = {
  'graph-node-limit': '执行图节点超过派生体检的有界上限。',
  'graph-edge-limit': '执行图连线超过派生体检的有界上限。',
  'graph-node-id-invalid': '执行图包含缺少稳定 ID 的节点。',
  'graph-node-id-duplicate': '执行图包含重复节点 ID，无法确定派生执行身份。',
  'graph-edge-id-invalid': '执行图包含缺少稳定 ID 的连线。',
  'graph-edge-id-duplicate': '执行图包含重复连线 ID，无法绑定派生执行图。',
  'requested-node-missing': '根执行请求引用了不存在的节点。',
  'derived-edge-endpoint-missing': '派生执行路径包含缺失端点。',
  'loop-input-empty': '并联循环器当前没有可确定的上游迭代素材。',
  'loop-input-unstable': '并联循环器的迭代素材会被本次执行中的上游节点改变。',
  'loop-downstream-missing': '并联循环器没有可克隆的下游执行子图。',
  'loop-request-id-invalid': '并联循环器缺少本次 Run 的有效请求 ID。',
  'loop-clone-node-limit': '并联循环器克隆节点超过派生体检的剩余上限。',
  'loop-clone-edge-limit': '并联循环器克隆连线超过派生体检的剩余上限。',
  'loop-runtime-node-id-collision': '并联循环器克隆节点与当前执行图节点 ID 冲突。',
  'loop-runtime-edge-id-collision': '并联循环器克隆连线与当前执行图连线 ID 冲突。',
  'loop-clone-build-invalid': '并联循环器无法生成确定性的克隆执行图。',
  'subflow-definition-missing': '子工作流实例缺少固定定义。',
  'subflow-definition-pin-mismatch': '子工作流实例与固定定义的身份或版本不一致。',
  'subflow-parameter-overrides-invalid': '子工作流参数覆盖不是有效对象。',
  'subflow-dependency-unavailable': '固定子工作流依赖尚未在预检前解析。',
  'subflow-dependency-pin-mismatch': '解析到的子工作流依赖与固定身份或版本不一致。',
  'subflow-dependency-project-mismatch': '解析到的子工作流依赖不属于固定项目。',
  'subflow-dependency-cycle': '固定子工作流依赖包含递归引用。',
  'subflow-depth-limit': '子工作流嵌套超过派生体检的有界深度。',
  'subflow-dependency-limit': '子工作流依赖数量超过派生体检的有界上限。',
  'subflow-node-limit': '子工作流展开节点超过派生体检的剩余上限。',
  'subflow-edge-limit': '子工作流展开连线超过派生体检的剩余上限。',
  'subflow-input-invalid': '子工作流固定输入无法安全映射到内部运行图。',
  'subflow-compile-invalid': '子工作流固定定义未能通过确定性编译。',
  'subflow-runtime-node-id-collision': '子工作流隐藏运行节点与当前执行图节点 ID 冲突。',
  'subflow-runtime-edge-id-collision': '子工作流隐藏运行连线与当前执行图连线 ID 冲突。',
};

class DerivedScopeFailure extends Error {
  readonly code: DerivedExecutionScopeBlockerCode;
  readonly dependency?: SubflowDependencyRef;

  constructor(
    code: DerivedExecutionScopeBlockerCode,
    dependency?: SubflowDependencyRef,
  ) {
    super(code);
    this.code = code;
    this.dependency = dependency;
  }
}

function integerLimit(value: unknown, fallback: number, minimum: number, maximum: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function normalizeLimits(value: Partial<DerivedExecutionScopeLimits> | undefined): DerivedExecutionScopeLimits {
  return {
    maxNodes: integerLimit(value?.maxNodes, DERIVED_EXECUTION_SCOPE_DEFAULT_LIMITS.maxNodes, 1, DERIVED_EXECUTION_SCOPE_DEFAULT_LIMITS.maxNodes),
    maxEdges: integerLimit(value?.maxEdges, DERIVED_EXECUTION_SCOPE_DEFAULT_LIMITS.maxEdges, 0, DERIVED_EXECUTION_SCOPE_DEFAULT_LIMITS.maxEdges),
    maxSubflowDepth: integerLimit(value?.maxSubflowDepth, DERIVED_EXECUTION_SCOPE_DEFAULT_LIMITS.maxSubflowDepth, 1, DERIVED_EXECUTION_SCOPE_DEFAULT_LIMITS.maxSubflowDepth),
    maxSubflowDependencies: integerLimit(
      value?.maxSubflowDependencies,
      DERIVED_EXECUTION_SCOPE_DEFAULT_LIMITS.maxSubflowDependencies,
      0,
      DERIVED_EXECUTION_SCOPE_DEFAULT_LIMITS.maxSubflowDependencies,
    ),
  };
}

function uniqueSortedIds(values: readonly string[]) {
  return [...new Set(values.map((value) => String(value || '')).filter((value) => value.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validDefinition(value: unknown): value is SubflowDefinition {
  if (!isRecord(value)) return false;
  const version = Number(value.version);
  return typeof value.id === 'string'
    && value.id.trim().length > 0
    && Number.isInteger(version)
    && version >= 1
    && Array.isArray(value.nodes)
    && Array.isArray(value.edges);
}

function fixedReference(node: Node, parent: SubflowDefinition, root: SubflowDefinition): SubflowDependencyRef {
  const data = isRecord(node.data) ? node.data : {};
  const embedded = validDefinition(data.definition) ? data.definition : null;
  const definitionId = String(data.definitionId || embedded?.id || '').trim();
  const version = Number(data.definitionVersion || embedded?.version || 0);
  const projectId = String(
    data.definitionProjectId
    || embedded?.projectId
    || parent.projectId
    || root.projectId
    || '',
  ).trim() || undefined;
  if (!definitionId || !Number.isInteger(version) || version < 1) {
    throw new DerivedScopeFailure('subflow-dependency-pin-mismatch');
  }
  return { definitionId, version, ...(projectId ? { projectId } : {}) };
}

function assertDefinitionMatches(reference: SubflowDependencyRef, definition: SubflowDefinition) {
  if (String(definition.id) !== reference.definitionId || Number(definition.version) !== reference.version) {
    throw new DerivedScopeFailure('subflow-dependency-pin-mismatch', reference);
  }
  if (reference.projectId && String(definition.projectId || '') !== reference.projectId) {
    throw new DerivedScopeFailure('subflow-dependency-project-mismatch', reference);
  }
}

function compileFailureCode(error: unknown): DerivedExecutionScopeBlockerCode {
  if (error instanceof DerivedScopeFailure) return error.code;
  const message = error instanceof Error ? error.message : '';
  if (/展开节点超过/.test(message)) return 'subflow-node-limit';
  if (/展开连线超过/.test(message)) return 'subflow-edge-limit';
  if (/嵌套超过/.test(message)) return 'subflow-depth-limit';
  if (/递归引用|循环依赖/.test(message)) return 'subflow-dependency-cycle';
  return 'subflow-compile-invalid';
}

function edgeSort(left: Edge, right: Edge) {
  return left.id.localeCompare(right.id)
    || left.source.localeCompare(right.source)
    || left.target.localeCompare(right.target);
}

/**
 * Builds the conservative graph that must be diagnosed before the root action
 * can be authorized. It is deterministic, synchronous and side-effect free.
 *
 * Random routes include every currently connected branch because branch choice
 * happens only after authorization. Loops include every reachable downstream
 * node once; repeated/parallel invocation count is intentionally not guessed.
 * Subflows are compiled from the pinned definition and already-prefetched fixed
 * dependencies. Any gap makes `coverageComplete` false.
 */
export function buildPossibleDerivedExecutionScope(
  input: BuildPossibleDerivedExecutionScopeInput,
): PossibleDerivedExecutionScope {
  const limits = normalizeLimits(input.limits);
  const blockers: DerivedExecutionScopeBlocker[] = [];
  const blockerKeys = new Set<string>();
  const addBlocker = (
    code: DerivedExecutionScopeBlockerCode,
    nodeIds: readonly string[] = [],
    dependency?: SubflowDependencyRef,
  ) => {
    const normalizedNodeIds = uniqueSortedIds(nodeIds);
    const dependencyKey = dependency ? subflowDependencyMapKey(dependency) : '';
    const key = `${code}|${normalizedNodeIds.join('|')}|${dependencyKey}`;
    if (blockerKeys.has(key)) return;
    blockerKeys.add(key);
    blockers.push({
      code,
      title: BLOCKER_TITLES[code],
      nodeIds: normalizedNodeIds,
      ...(dependency ? { dependency: { ...dependency } } : {}),
    });
  };

  const requestedExecutionNodeIds = uniqueSortedIds(input.executionNodeIds);
  if (input.nodes.length > limits.maxNodes) addBlocker('graph-node-limit');
  if (input.edges.length > limits.maxEdges) addBlocker('graph-edge-limit');

  const rootNodes = input.nodes.slice(0, limits.maxNodes);
  const rootEdges = input.edges.slice(0, limits.maxEdges);
  const nodesById = new Map<string, Node>();
  for (const node of rootNodes) {
    const nodeId = String(node?.id || '');
    if (!nodeId.trim()) {
      addBlocker('graph-node-id-invalid');
      continue;
    }
    if (nodesById.has(nodeId)) {
      addBlocker('graph-node-id-duplicate', [nodeId]);
      continue;
    }
    nodesById.set(nodeId, node);
  }

  const edgesById = new Map<string, Edge>();
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  const indexEdge = (edge: Edge) => {
    const sourceList = outgoing.get(edge.source) || [];
    sourceList.push(edge);
    sourceList.sort(edgeSort);
    outgoing.set(edge.source, sourceList);
    const targetList = incoming.get(edge.target) || [];
    targetList.push(edge);
    targetList.sort(edgeSort);
    incoming.set(edge.target, targetList);
  };
  for (const edge of rootEdges) {
    const edgeId = String(edge?.id || '');
    if (!edgeId.trim()) {
      addBlocker('graph-edge-id-invalid');
      continue;
    }
    if (edgesById.has(edgeId)) {
      addBlocker('graph-edge-id-duplicate');
      continue;
    }
    edgesById.set(edgeId, edge);
    indexEdge(edge);
  }

  const includedNodeIds = new Set<string>();
  const includedEdgeIds = new Set<string>();
  const requiredAuthorizationNodeIds = new Set<string>();
  const schedulerQueue: string[] = [];
  const queuedSchedulers = new Set<string>();
  const processedSchedulers = new Set<string>();
  const expandedSchedulerNodeIds = new Set<string>();
  const expandedSubflowInstanceIds = new Set<string>();
  const loopParallelCloneGroups = new Map<string, LoopParallelCloneAuthorizationGroup>();
  const dependencyKeys = new Set<string>();
  const fetchedDefinitions = new Map<string, SubflowDefinition>();

  const enqueueScheduler = (node: Node | undefined) => {
    if (!node || !['loop', 'random-route', 'subflow'].includes(String(node.type || ''))) return;
    if (queuedSchedulers.has(node.id) || processedSchedulers.has(node.id)) return;
    queuedSchedulers.add(node.id);
    schedulerQueue.push(node.id);
    schedulerQueue.sort((left, right) => left.localeCompare(right));
  };
  const includeNode = (nodeId: string) => {
    const node = nodesById.get(nodeId);
    if (!node) {
      addBlocker('derived-edge-endpoint-missing', [nodeId]);
      return null;
    }
    includedNodeIds.add(nodeId);
    return node;
  };
  const markForExecution = (node: Node, rootRequested = false) => {
    if (rootRequested || (node.type && EXECUTABLE_NODE_TYPES.has(node.type))) {
      requiredAuthorizationNodeIds.add(node.id);
      enqueueScheduler(node);
    }
  };

  for (const nodeId of requestedExecutionNodeIds) {
    const node = nodesById.get(nodeId);
    if (!node) {
      addBlocker('requested-node-missing', [nodeId]);
      continue;
    }
    includedNodeIds.add(node.id);
    markForExecution(node, true);
  }

  const includeForwardReachable = (schedulerId: string) => {
    const visited = new Set<string>([schedulerId]);
    const queue = [schedulerId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of outgoing.get(current) || []) {
        includedEdgeIds.add(edge.id);
        const target = nodesById.get(edge.target);
        if (!target) {
          addBlocker('derived-edge-endpoint-missing', [current, edge.target]);
          continue;
        }
        includedNodeIds.add(target.id);
        markForExecution(target);
        if (!visited.has(target.id)) {
          visited.add(target.id);
          queue.push(target.id);
        }
      }
    }
    visited.delete(schedulerId);
    return visited;
  };

  const hasAuthorizedInputAncestor = (loopId: string) => {
    const visited = new Set<string>();
    const queue = (incoming.get(loopId) || []).map((edge) => edge.source);
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      if (nodeId !== loopId && requiredAuthorizationNodeIds.has(nodeId)) return true;
      for (const edge of incoming.get(nodeId) || []) queue.push(edge.source);
    }
    return false;
  };

  const loopCloneSourceGraph = (loopId: string) => {
    const directEdges = (outgoing.get(loopId) || []).filter((edge) => nodesById.get(edge.target)?.type !== 'output');
    const directNodeIds = directEdges.map((edge) => edge.target);
    if (directNodeIds.length === 0) return null;
    const reachable = new Set<string>();
    const queue = [...directNodeIds];
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (reachable.has(nodeId)) continue;
      reachable.add(nodeId);
      for (const edge of outgoing.get(nodeId) || []) {
        if (!reachable.has(edge.target)) queue.push(edge.target);
      }
    }
    const sourceNodes = [...nodesById.values()].filter((node) => reachable.has(node.id));
    const sourceEdges = [...edgesById.values()].filter((edge) => reachable.has(edge.source) && reachable.has(edge.target));
    return { sourceNodes, sourceEdges, entryEdge: directEdges[0] };
  };

  const expandParallelLoopClones = (loop: Node) => {
    if (hasAuthorizedInputAncestor(loop.id)) {
      addBlocker('loop-input-unstable', [loop.id]);
      return;
    }
    const sourceGraph = loopCloneSourceGraph(loop.id);
    if (!sourceGraph || sourceGraph.sourceNodes.length === 0) {
      addBlocker('loop-downstream-missing', [loop.id]);
      return;
    }
    const remainingNodes = limits.maxNodes - nodesById.size;
    const remainingEdges = limits.maxEdges - edgesById.size;
    const maxItemsByNodes = Math.floor(remainingNodes / sourceGraph.sourceNodes.length) + 1;
    const edgesPerClone = sourceGraph.sourceEdges.length + 1;
    const maxItemsByEdges = Math.floor(remainingEdges / edgesPerClone) + 1;
    const maxItems = Math.max(1, Math.min(maxItemsByNodes, maxItemsByEdges));
    let items;
    try {
      items = collectLoopIterationMaterials(loop, [...nodesById.values()], [...edgesById.values()], maxItems);
    } catch (_) {
      addBlocker(
        maxItemsByNodes <= maxItemsByEdges ? 'loop-clone-node-limit' : 'loop-clone-edge-limit',
        [loop.id],
      );
      return;
    }
    if (items.length === 0) {
      addBlocker('loop-input-empty', [loop.id]);
      return;
    }
    const cloneCount = Math.max(0, items.length - 1);
    if (cloneCount === 0) {
      loopParallelCloneGroups.set(loop.id, {
        schedulerNodeId: loop.id,
        itemCount: items.length,
        cloneCount,
        cloneNodeIds: [],
      });
      return;
    }
    const requestId = String(input.requestId || '');
    if (!isLoopRunRequestId(requestId)) {
      addBlocker('loop-request-id-invalid', [loop.id]);
      return;
    }
    const cloneNodeCount = cloneCount * sourceGraph.sourceNodes.length;
    const cloneEdgeCount = cloneCount * edgesPerClone;
    if (!Number.isSafeInteger(cloneNodeCount) || cloneNodeCount > remainingNodes) {
      addBlocker('loop-clone-node-limit', [loop.id]);
      return;
    }
    if (!Number.isSafeInteger(cloneEdgeCount) || cloneEdgeCount > remainingEdges) {
      addBlocker('loop-clone-edge-limit', [loop.id]);
      return;
    }

    let cloneGraph;
    try {
      cloneGraph = buildLoopParallelCloneGraph({
        loopId: loop.id,
        requestId,
        sourceNodes: sourceGraph.sourceNodes,
        sourceEdges: sourceGraph.sourceEdges,
        entryEdge: sourceGraph.entryEdge,
        items,
      });
    } catch (_) {
      addBlocker('loop-clone-build-invalid', [loop.id]);
      return;
    }
    const candidateNodeIds = new Set<string>();
    for (const node of cloneGraph.nodes) {
      if (!node.id || candidateNodeIds.has(node.id) || nodesById.has(node.id)) {
        addBlocker('loop-runtime-node-id-collision', [loop.id, node.id]);
        return;
      }
      candidateNodeIds.add(node.id);
    }
    const candidateEdgeIds = new Set<string>();
    for (const edge of cloneGraph.edges) {
      if (!edge.id || candidateEdgeIds.has(edge.id) || edgesById.has(edge.id)) {
        addBlocker('loop-runtime-edge-id-collision', [loop.id]);
        return;
      }
      candidateEdgeIds.add(edge.id);
    }
    const allNodeIds = new Set([...nodesById.keys(), ...candidateNodeIds]);
    if (cloneGraph.edges.some((edge) => !allNodeIds.has(edge.source) || !allNodeIds.has(edge.target))) {
      addBlocker('derived-edge-endpoint-missing', [loop.id]);
      return;
    }
    for (const node of cloneGraph.nodes) {
      nodesById.set(node.id, node);
      includedNodeIds.add(node.id);
    }
    for (const edge of cloneGraph.edges) {
      edgesById.set(edge.id, edge);
      indexEdge(edge);
      includedEdgeIds.add(edge.id);
    }
    for (const node of cloneGraph.nodes) markForExecution(node);
    loopParallelCloneGroups.set(loop.id, {
      schedulerNodeId: loop.id,
      itemCount: items.length,
      cloneCount,
      cloneNodeIds: [...cloneGraph.cloneNodeIds].sort((left, right) => left.localeCompare(right)),
    });
  };

  const loadFixedDependencies = (root: SubflowDefinition) => {
    const loaded = new Map<string, SubflowDefinition>();
    const rootReference: SubflowDependencyRef = {
      definitionId: root.id,
      version: root.version,
      ...(root.projectId ? { projectId: root.projectId } : {}),
    };
    const visit = (definition: SubflowDefinition, stack: string[]) => {
      if (stack.length > limits.maxSubflowDepth) throw new DerivedScopeFailure('subflow-depth-limit');
      for (const node of definition.nodes || []) {
        if (node.type !== 'subflow') continue;
        if (stack.length >= limits.maxSubflowDepth) throw new DerivedScopeFailure('subflow-depth-limit');
        const nodeData = isRecord(node.data) ? node.data : {};
        if (nodeData.definition != null && !validDefinition(nodeData.definition)) {
          throw new DerivedScopeFailure('subflow-dependency-pin-mismatch');
        }
        const reference = fixedReference(node, definition, root);
        const key = subflowDependencyMapKey(reference);
        if (stack.includes(key)) throw new DerivedScopeFailure('subflow-dependency-cycle', reference);
        if (!dependencyKeys.has(key)) {
          if (dependencyKeys.size >= limits.maxSubflowDependencies) {
            throw new DerivedScopeFailure('subflow-dependency-limit', reference);
          }
          dependencyKeys.add(key);
        }
        if (loaded.has(key)) continue;
        const embedded = validDefinition(nodeData.definition) ? nodeData.definition : null;
        let resolved = embedded;
        if (!resolved) {
          resolved = fetchedDefinitions.get(key) || null;
          if (!resolved) {
            if (!input.resolveSubflowDefinition) {
              throw new DerivedScopeFailure('subflow-dependency-unavailable', reference);
            }
            try {
              resolved = input.resolveSubflowDefinition(reference) || null;
            } catch (_) {
              throw new DerivedScopeFailure('subflow-dependency-unavailable', reference);
            }
            if (!resolved) throw new DerivedScopeFailure('subflow-dependency-unavailable', reference);
            fetchedDefinitions.set(key, resolved);
          }
        }
        assertDefinitionMatches(reference, resolved);
        loaded.set(key, resolved);
        visit(resolved, [...stack, key]);
      }
    };
    visit(root, [subflowDependencyMapKey(rootReference)]);
    return loaded;
  };

  const expandSubflow = (instance: Node) => {
    const data = isRecord(instance.data) ? instance.data : {};
    const definition = validDefinition(data.definition) ? data.definition : null;
    if (!definition) {
      addBlocker('subflow-definition-missing', [instance.id]);
      return;
    }
    const pinnedId = String(data.definitionId || definition.id).trim();
    const pinnedVersion = Number(data.definitionVersion || definition.version);
    const pinnedProject = String(data.definitionProjectId || definition.projectId || '').trim();
    if (pinnedId !== definition.id
      || pinnedVersion !== Number(definition.version)
      || (pinnedProject && pinnedProject !== String(definition.projectId || ''))) {
      addBlocker('subflow-definition-pin-mismatch', [instance.id]);
      return;
    }
    const rawOverrides = data.parameterOverrides;
    if (rawOverrides != null && !isRecord(rawOverrides)) {
      addBlocker('subflow-parameter-overrides-invalid', [instance.id]);
      return;
    }
    const remainingNodes = limits.maxNodes - nodesById.size;
    const remainingEdges = limits.maxEdges - edgesById.size;
    if (remainingNodes < 1) {
      addBlocker('subflow-node-limit', [instance.id]);
      return;
    }
    if (remainingEdges < 0) {
      addBlocker('subflow-edge-limit', [instance.id]);
      return;
    }

    try {
      const dependencies = loadFixedDependencies(definition);
      const compiled = compileSubflow(definition, instance.id, rawOverrides || {}, {
        maxDepth: limits.maxSubflowDepth,
        maxNodes: remainingNodes,
        maxEdges: remainingEdges,
        resolveDefinition: (reference) => dependencies.get(subflowDependencyMapKey(reference)),
      });
      let prepared;
      try {
        prepared = prepareSubflowRootInputs(
          definition,
          instance.id,
          [...nodesById.values()],
          [...edgesById.values()],
          compiled.inputTargets,
        );
      } catch (_) {
        addBlocker('subflow-input-invalid', [instance.id]);
        return;
      }

      const candidateNodes = [...compiled.nodes, ...prepared.nodes];
      const candidateEdges = [...compiled.edges, ...prepared.edges];
      if (nodesById.size + candidateNodes.length > limits.maxNodes) {
        addBlocker('subflow-node-limit', [instance.id]);
        return;
      }
      if (edgesById.size + candidateEdges.length > limits.maxEdges) {
        addBlocker('subflow-edge-limit', [instance.id]);
        return;
      }
      const candidateNodeIds = new Set<string>();
      for (const node of candidateNodes) {
        if (!node.id || candidateNodeIds.has(node.id) || nodesById.has(node.id)) {
          addBlocker('subflow-runtime-node-id-collision', [instance.id, node.id]);
          return;
        }
        candidateNodeIds.add(node.id);
      }
      const candidateEdgeIds = new Set<string>();
      for (const edge of candidateEdges) {
        if (!edge.id || candidateEdgeIds.has(edge.id) || edgesById.has(edge.id)) {
          addBlocker('subflow-runtime-edge-id-collision', [instance.id]);
          return;
        }
        candidateEdgeIds.add(edge.id);
      }
      const allCandidateNodeIds = new Set([...nodesById.keys(), ...candidateNodeIds]);
      if (candidateEdges.some((edge) => !allCandidateNodeIds.has(edge.source) || !allCandidateNodeIds.has(edge.target))) {
        addBlocker('derived-edge-endpoint-missing', [instance.id]);
        return;
      }

      for (const node of candidateNodes) {
        nodesById.set(node.id, node);
        includedNodeIds.add(node.id);
      }
      for (const edge of candidateEdges) {
        edgesById.set(edge.id, edge);
        indexEdge(edge);
        includedEdgeIds.add(edge.id);
      }
      for (const node of compiled.nodes) markForExecution(node);
      expandedSubflowInstanceIds.add(instance.id);
    } catch (error) {
      const failure = error instanceof DerivedScopeFailure ? error : null;
      addBlocker(compileFailureCode(error), [instance.id], failure?.dependency);
    }
  };

  while (schedulerQueue.length > 0) {
    const schedulerId = schedulerQueue.shift()!;
    queuedSchedulers.delete(schedulerId);
    if (processedSchedulers.has(schedulerId)) continue;
    processedSchedulers.add(schedulerId);
    const scheduler = nodesById.get(schedulerId);
    if (!scheduler) {
      addBlocker('requested-node-missing', [schedulerId]);
      continue;
    }
    expandedSchedulerNodeIds.add(schedulerId);
    if (scheduler.type === 'subflow') expandSubflow(scheduler);
    else if (scheduler.type === 'loop') {
      includeForwardReachable(scheduler.id);
      const schedulerData = isRecord(scheduler.data) ? scheduler.data : {};
      if (schedulerData.mode === 'parallel') expandParallelLoopClones(scheduler);
    } else if (scheduler.type === 'random-route') includeForwardReachable(scheduler.id);
  }

  // Every potential run reads its direct inbound sources. These nodes are data
  // context only and are never promoted to the execution allowlist here.
  for (const nodeId of [...requiredAuthorizationNodeIds].sort((left, right) => left.localeCompare(right))) {
    includeNode(nodeId);
    for (const edge of incoming.get(nodeId) || []) {
      includedEdgeIds.add(edge.id);
      if (!nodesById.has(edge.source)) addBlocker('derived-edge-endpoint-missing', [edge.source, nodeId]);
      else includedNodeIds.add(edge.source);
    }
  }

  const required = [...requiredAuthorizationNodeIds].sort((left, right) => left.localeCompare(right));
  const requestedSet = new Set(requestedExecutionNodeIds);
  const includedNodes = [...includedNodeIds]
    .map((nodeId) => nodesById.get(nodeId))
    .filter((node): node is Node => Boolean(node))
    .sort((left, right) => left.id.localeCompare(right.id));
  const includedEdges = [...includedEdgeIds]
    .map((edgeId) => edgesById.get(edgeId))
    .filter((edge): edge is Edge => Boolean(edge))
    .sort(edgeSort);
  blockers.sort((left, right) => (
    left.code.localeCompare(right.code)
    || left.nodeIds.join('|').localeCompare(right.nodeIds.join('|'))
    || subflowDependencyMapKey(left.dependency || { definitionId: '', version: 1 })
      .localeCompare(subflowDependencyMapKey(right.dependency || { definitionId: '', version: 1 }))
  ));

  return {
    coverageComplete: blockers.length === 0,
    requestedExecutionNodeIds,
    requiredAuthorizationNodeIds: required,
    loopParallelCloneGroups: [...loopParallelCloneGroups.values()]
      .sort((left, right) => left.schedulerNodeId.localeCompare(right.schedulerNodeId)),
    derivedRuntimeNodeIds: required.filter((nodeId) => !requestedSet.has(nodeId)),
    diagnosticContextNodeIds: includedNodes.map((node) => node.id).filter((nodeId) => !requiredAuthorizationNodeIds.has(nodeId)),
    expandedSchedulerNodeIds: [...expandedSchedulerNodeIds].sort((left, right) => left.localeCompare(right)),
    expandedSubflowInstanceIds: [...expandedSubflowInstanceIds].sort((left, right) => left.localeCompare(right)),
    nodes: includedNodes,
    edges: includedEdges,
    blockers,
  };
}
