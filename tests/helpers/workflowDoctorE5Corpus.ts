import type { Edge, Node } from '@xyflow/react';
import type {
  WorkflowDoctorContext,
  WorkflowIssue,
  WorkflowLocationScope,
} from '../../src/utils/workflowDoctor.ts';

export const WORKFLOW_DOCTOR_E5_CORPUS_SCHEMA = 't8-workflow-doctor-e5-corpus-v1' as const;

export interface WorkflowDoctorE5ExpectedDiagnostic {
  ruleId: string;
  location: {
    scope: WorkflowLocationScope;
    nodeId?: string;
    edgeId?: string;
    entityId?: string;
    field?: string;
  };
  targetNodeIds?: string[];
  targetEdgeIds?: string[];
}

export interface WorkflowDoctorE5Graph {
  nodes: Node[];
  edges: Edge[];
}

export interface WorkflowDoctorE5RepairExpectation {
  diagnostic: WorkflowDoctorE5ExpectedDiagnostic;
  expectedGraph: WorkflowDoctorE5Graph;
  expectedRemainingDiagnostics: WorkflowDoctorE5ExpectedDiagnostic[];
}

export interface WorkflowDoctorE5Case extends WorkflowDoctorE5Graph {
  schema: typeof WORKFLOW_DOCTOR_E5_CORPUS_SCHEMA;
  id: string;
  kind: 'bad' | 'clean';
  family: 'invalid-position' | 'dangling-edge' | 'self-edge' | 'duplicate-edge' | 'clean-text';
  context: WorkflowDoctorContext;
  expectedDiagnostics: WorkflowDoctorE5ExpectedDiagnostic[];
  repair?: WorkflowDoctorE5RepairExpectation;
}

function sorted(values: readonly string[] | undefined) {
  return [...new Set(values || [])].sort((left, right) => left.localeCompare(right));
}

export function workflowDoctorE5ExpectedDiagnosticKey(
  diagnostic: WorkflowDoctorE5ExpectedDiagnostic,
) {
  return JSON.stringify({
    ruleId: diagnostic.ruleId,
    location: {
      scope: diagnostic.location.scope,
      nodeId: diagnostic.location.nodeId || '',
      edgeId: diagnostic.location.edgeId || '',
      entityId: diagnostic.location.entityId || '',
      field: diagnostic.location.field || '',
    },
    targetNodeIds: sorted(diagnostic.targetNodeIds),
    targetEdgeIds: sorted(diagnostic.targetEdgeIds),
  });
}

export function workflowDoctorE5IssueKey(issue: WorkflowIssue) {
  return workflowDoctorE5ExpectedDiagnosticKey({
    ruleId: issue.ruleId,
    location: {
      scope: issue.location.scope,
      nodeId: issue.location.nodeId,
      edgeId: issue.location.edgeId,
      entityId: issue.location.entityId,
      field: issue.location.field,
    },
    targetNodeIds: issue.targetNodeIds || issue.nodeIds,
    targetEdgeIds: issue.targetEdgeIds || issue.edgeIds,
  });
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    if (Number.isNaN(value)) return '[number:NaN]';
    return value > 0 ? '[number:Infinity]' : '[number:-Infinity]';
  }
  if (value === undefined) return '[undefined]';
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function canonicalWorkflowDoctorE5Graph(graph: WorkflowDoctorE5Graph) {
  const nodes = [...graph.nodes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node) => canonicalValue(node));
  const edges = [...graph.edges]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((edge) => canonicalValue(edge));
  return JSON.stringify({ nodes, edges });
}

function sequence(index: number) {
  return String(index + 1).padStart(3, '0');
}

function textNode(
  id: string,
  position: { x: number; y: number },
  text = `content-${id}`,
): Node {
  return {
    id,
    type: 'text',
    position,
    data: { text },
  };
}

function invalidPositionCases(): WorkflowDoctorE5Case[] {
  return Array.from({ length: 30 }, (_, index) => {
    const suffix = sequence(index);
    const nodeId = `e5-layout-node-${suffix}`;
    const invalidPosition = index % 3 === 0
      ? { x: Number.NaN, y: index * 11 }
      : index % 3 === 1
        ? { x: index * 13, y: Number.POSITIVE_INFINITY }
        : { x: Number.NEGATIVE_INFINITY, y: index * -17 };
    const node = textNode(nodeId, invalidPosition);
    const fixedNode = textNode(nodeId, { x: 80, y: 80 });
    const diagnostic: WorkflowDoctorE5ExpectedDiagnostic = {
      ruleId: 'layout.invalid-position',
      location: { scope: 'node', nodeId, field: 'position' },
      targetNodeIds: [nodeId],
      targetEdgeIds: [],
    };
    return {
      schema: WORKFLOW_DOCTOR_E5_CORPUS_SCHEMA,
      id: `bad-invalid-position-${suffix}`,
      kind: 'bad',
      family: 'invalid-position',
      nodes: [node],
      edges: [],
      context: {},
      expectedDiagnostics: [diagnostic],
      repair: {
        diagnostic,
        expectedGraph: { nodes: [fixedNode], edges: [] },
        expectedRemainingDiagnostics: [],
      },
    };
  });
}

function danglingEdgeCases(): WorkflowDoctorE5Case[] {
  return Array.from({ length: 30 }, (_, index) => {
    const suffix = sequence(index);
    const nodeId = `e5-dangling-node-${suffix}`;
    const missingNodeId = `e5-missing-node-${suffix}`;
    const edgeId = `e5-dangling-edge-${suffix}`;
    const node = textNode(nodeId, { x: index * 19, y: index * -7 });
    const edge: Edge = index % 2 === 0
      ? { id: edgeId, source: missingNodeId, target: nodeId }
      : { id: edgeId, source: nodeId, target: missingNodeId };
    const diagnostic: WorkflowDoctorE5ExpectedDiagnostic = {
      ruleId: 'topology.dangling-edge',
      location: { scope: 'edge', edgeId },
      targetNodeIds: [],
      targetEdgeIds: [edgeId],
    };
    return {
      schema: WORKFLOW_DOCTOR_E5_CORPUS_SCHEMA,
      id: `bad-dangling-edge-${suffix}`,
      kind: 'bad',
      family: 'dangling-edge',
      nodes: [node],
      edges: [edge],
      context: {},
      expectedDiagnostics: [diagnostic],
      repair: {
        diagnostic,
        expectedGraph: { nodes: [textNode(nodeId, { x: index * 19, y: index * -7 })], edges: [] },
        expectedRemainingDiagnostics: [],
      },
    };
  });
}

function selfEdgeCases(): WorkflowDoctorE5Case[] {
  return Array.from({ length: 30 }, (_, index) => {
    const suffix = sequence(index);
    const nodeId = `e5-self-node-${suffix}`;
    const edgeId = `e5-self-edge-${suffix}`;
    const node = textNode(nodeId, { x: index * 23, y: index * 5 });
    const edge: Edge = { id: edgeId, source: nodeId, target: nodeId };
    const cycleDiagnostic: WorkflowDoctorE5ExpectedDiagnostic = {
      ruleId: 'topology.cycle',
      location: { scope: 'canvas', nodeId },
      targetNodeIds: [nodeId],
      targetEdgeIds: [],
    };
    const selfDiagnostic: WorkflowDoctorE5ExpectedDiagnostic = {
      ruleId: 'topology.self-edge',
      location: { scope: 'edge', nodeId, edgeId },
      targetNodeIds: [nodeId],
      targetEdgeIds: [edgeId],
    };
    return {
      schema: WORKFLOW_DOCTOR_E5_CORPUS_SCHEMA,
      id: `bad-self-edge-${suffix}`,
      kind: 'bad',
      family: 'self-edge',
      nodes: [node],
      edges: [edge],
      context: {},
      expectedDiagnostics: [cycleDiagnostic, selfDiagnostic],
      repair: {
        diagnostic: selfDiagnostic,
        expectedGraph: {
          nodes: [textNode(nodeId, { x: index * 23, y: index * 5 })],
          edges: [],
        },
        expectedRemainingDiagnostics: [],
      },
    };
  });
}

function duplicateEdgeCases(): WorkflowDoctorE5Case[] {
  return Array.from({ length: 30 }, (_, index) => {
    const suffix = sequence(index);
    const sourceId = `e5-duplicate-source-${suffix}`;
    const targetId = `e5-duplicate-target-${suffix}`;
    const source = textNode(sourceId, { x: index * 29, y: 0 }, `source-${suffix}`);
    const target = textNode(targetId, { x: index * 29 + 180, y: 0 }, `target-${suffix}`);
    const edgeCount = 2 + (index % 3);
    const edges: Edge[] = Array.from({ length: edgeCount }, (_, edgeIndex) => ({
      id: `e5-duplicate-edge-${suffix}-${edgeIndex + 1}`,
      source: sourceId,
      target: targetId,
    }));
    const redundantEdgeIds = edges.slice(1).map((edge) => edge.id);
    const diagnostic: WorkflowDoctorE5ExpectedDiagnostic = {
      ruleId: 'topology.duplicate-edge',
      location: { scope: 'edge', edgeId: edges[0].id },
      targetNodeIds: [sourceId, targetId],
      targetEdgeIds: redundantEdgeIds,
    };
    return {
      schema: WORKFLOW_DOCTOR_E5_CORPUS_SCHEMA,
      id: `bad-duplicate-edge-${suffix}`,
      kind: 'bad',
      family: 'duplicate-edge',
      nodes: [source, target],
      edges,
      context: {},
      expectedDiagnostics: [diagnostic],
      repair: {
        diagnostic,
        expectedGraph: {
          nodes: [
            textNode(sourceId, { x: index * 29, y: 0 }, `source-${suffix}`),
            textNode(targetId, { x: index * 29 + 180, y: 0 }, `target-${suffix}`),
          ],
          edges: [{ ...edges[0] }],
        },
        expectedRemainingDiagnostics: [],
      },
    };
  });
}

function cleanControlCases(): WorkflowDoctorE5Case[] {
  return Array.from({ length: 20 }, (_, index) => {
    const suffix = sequence(index);
    if (index < 10) {
      return {
        schema: WORKFLOW_DOCTOR_E5_CORPUS_SCHEMA,
        id: `clean-single-text-${suffix}`,
        kind: 'clean',
        family: 'clean-text',
        nodes: [textNode(`e5-clean-node-${suffix}`, { x: index * 31, y: index * -13 })],
        edges: [],
        context: {},
        expectedDiagnostics: [],
      };
    }
    const sourceId = `e5-clean-source-${suffix}`;
    const targetId = `e5-clean-target-${suffix}`;
    return {
      schema: WORKFLOW_DOCTOR_E5_CORPUS_SCHEMA,
      id: `clean-text-chain-${suffix}`,
      kind: 'clean',
      family: 'clean-text',
      nodes: [
        textNode(sourceId, { x: index * 31, y: 0 }),
        textNode(targetId, { x: index * 31 + 180, y: 0 }),
      ],
      edges: [{
        id: `e5-clean-edge-${suffix}`,
        source: sourceId,
        target: targetId,
      }],
      context: {},
      expectedDiagnostics: [],
    };
  });
}

export const WORKFLOW_DOCTOR_E5_BAD_CASES: readonly WorkflowDoctorE5Case[] = Object.freeze([
  ...invalidPositionCases(),
  ...danglingEdgeCases(),
  ...selfEdgeCases(),
  ...duplicateEdgeCases(),
]);

export const WORKFLOW_DOCTOR_E5_CLEAN_CASES: readonly WorkflowDoctorE5Case[] = Object.freeze(
  cleanControlCases(),
);

export const WORKFLOW_DOCTOR_E5_CORPUS: readonly WorkflowDoctorE5Case[] = Object.freeze([
  ...WORKFLOW_DOCTOR_E5_BAD_CASES,
  ...WORKFLOW_DOCTOR_E5_CLEAN_CASES,
]);
