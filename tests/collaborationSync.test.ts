import assert from 'node:assert/strict';
import test from 'node:test';

import type { CanvasSyncOperation, VersionedCanvasData } from '../src/types/project.ts';
import {
  COLLABORATION_SYNC_MAX_OPERATION_BYTES,
  COLLABORATION_SYNC_MAX_OPERATIONS,
  CollaborationSyncFallbackError,
  acceptCollaborationMutationResult,
  acceptCollaborationSnapshot,
  acceptCollaborationMoveMutationResult,
  applyCollaborationMoveDelta,
  applyCollaborationOperationsDelta,
  applyCollaborationSync,
  collaborationDeltaAcknowledgesQueuedMove,
  type CollaborationMutationBatchIdentity,
  type QueuedMoveIdentity,
} from '../src/utils/collaborationSync.ts';

const NODE_UID_1 = '11111111-1111-4111-8111-111111111111';
const NODE_UID_2 = '22222222-2222-4222-8222-222222222222';
const NODE_UID_3 = '33333333-3333-4333-8333-333333333333';
const EDGE_UID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EDGE_UID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CANVAS_UID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function document(revision = 1, overrides: Partial<VersionedCanvasData> = {}): VersionedCanvasData {
  return {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: 'project-1',
    canvasId: 'canvas-1',
    entityUid: CANVAS_UID,
    revision,
    viewportRevision: 1,
    nodes: [
      { id: 'node-1', entityUid: NODE_UID_1, entityRevision: 1, position: { x: 0, y: 0 }, data: {} },
      { id: 'node-2', entityUid: NODE_UID_2, entityRevision: 1, position: { x: 5, y: 6 }, data: {} },
    ],
    edges: [
      { id: 'edge-1', entityUid: EDGE_UID_1, entityRevision: 1, source: 'node-1', target: 'node-2' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    subflowInstances: [],
    tombstones: { nodes: {}, edges: {} },
    updatedAt: 100,
    ...overrides,
  } as VersionedCanvasData;
}

function operation(
  revision: number,
  overrides: Partial<CanvasSyncOperation> & Record<string, unknown> = {},
): CanvasSyncOperation {
  return {
    opId: `op-${revision}`,
    projectId: 'project-1',
    canvasId: 'canvas-1',
    actorId: 'member-1',
    baseRevision: 1,
    clientSeq: revision - 1,
    timestamp: 100 + revision,
    type: 'node.move',
    payload: { nodeId: 'node-1', position: { x: revision, y: revision + 1 } },
    revision,
    ...overrides,
  } as CanvasSyncOperation;
}

function structuralDocument(revision = 1, overrides: Partial<VersionedCanvasData> = {}): VersionedCanvasData {
  return document(revision, {
    nodes: [
      { id: 'node-1', entityUid: NODE_UID_1, entityRevision: 1, type: 'text', position: { x: 0, y: 0 }, data: { text: 'one' } },
      { id: 'node-2', entityUid: NODE_UID_2, entityRevision: 1, type: 'output', position: { x: 5, y: 6 }, data: {} },
    ],
    edges: [
      { id: 'edge-1', entityUid: EDGE_UID_1, entityRevision: 1, source: 'node-1', target: 'node-2' },
    ],
    ...overrides,
  });
}

function structuralOperation(
  revision: number,
  type: CanvasSyncOperation['type'],
  payload: Record<string, unknown>,
  overrides: Partial<CanvasSyncOperation> & Record<string, unknown> = {},
): CanvasSyncOperation {
  return operation(revision, {
    opId: `structural-${revision}`,
    clientSeq: revision - 1,
    type,
    payload,
    ...overrides,
  });
}

function mutationIdentity(
  index: number,
  type: CanvasSyncOperation['type'],
  payload: Record<string, unknown>,
): CollaborationMutationBatchIdentity['operations'][number] {
  return {
    opId: `mutation-${index}`,
    clientSeq: index,
    timestamp: 1_000 + index,
    type,
    payload,
  };
}

function mutationAcknowledgement(
  operationIdentity: CollaborationMutationBatchIdentity['operations'][number],
  revision: number,
  duplicate = false,
) {
  return {
    ...operationIdentity,
    projectId: 'project-1',
    canvasId: 'canvas-1',
    actorId: 'member-1',
    baseRevision: 1,
    revision,
    duplicate,
  };
}

function operationsEnvelope(
  base: VersionedCanvasData,
  operations: unknown[],
  overrides: Record<string, unknown> = {},
) {
  return {
    mode: 'operations',
    canvasId: base.canvasId,
    afterRevision: base.revision,
    revision: base.revision + operations.length,
    operations,
    ...overrides,
  };
}

function snapshotEnvelope(
  base: VersionedCanvasData,
  snapshot: VersionedCanvasData,
  overrides: Record<string, unknown> = {},
) {
  return {
    mode: 'snapshot',
    canvasId: base.canvasId,
    afterRevision: base.revision,
    revision: snapshot.revision,
    reason: 'history_gap',
    document: snapshot,
    ...overrides,
  };
}

function assertFallback(code: string | null, action: () => unknown) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CollaborationSyncFallbackError);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test('delta applies zero, one, and multiple node.move operations without mutating inputs', () => {
  const base = document();
  const before = structuredClone(base);
  const empty = applyCollaborationSync(base, operationsEnvelope(base, []));
  assert.deepEqual(empty, base);
  assert.notEqual(empty, base);

  const one = applyCollaborationMoveDelta(base, operationsEnvelope(base, [operation(2)]));
  assert.equal(one.revision, 2);
  assert.deepEqual(one.nodes[0].position, { x: 2, y: 3 });
  assert.equal(one.updatedAt, 102);

  const byEntityUid = operation(3, {
    opId: 'op-entity',
    baseRevision: 1,
    payload: { nodeId: NODE_UID_2, position: { x: 30, y: 31 } },
  });
  const two = applyCollaborationSync(base, operationsEnvelope(base, [operation(2), byEntityUid]));
  assert.equal(two.revision, 3);
  assert.deepEqual(two.nodes[1].position, { x: 30, y: 31 });
  assert.deepEqual(base, before);
});

test('delta accepts a legal shared batch base even when sync begins mid-batch', () => {
  const base = document(2);
  const midBatch = operation(3, {
    opId: 'op-mid-batch',
    baseRevision: 1,
    payload: { nodeId: 'node-2', position: { x: 33, y: 34 } },
  });
  const next = applyCollaborationSync(base, operationsEnvelope(base, [midBatch]));
  assert.equal(next.revision, 3);
  assert.deepEqual(next.nodes[1].position, { x: 33, y: 34 });
});

test('delta enforces envelope scope, revision continuity, count, and stable error codes', () => {
  const base = document();
  assertFallback('operations_envelope_invalid', () => applyCollaborationMoveDelta(base, null));
  assertFallback('sync_mode_invalid', () => applyCollaborationSync(base, { mode: 'unknown' }));
  assertFallback('canvas_mismatch', () => applyCollaborationSync(base, operationsEnvelope(base, [], { canvasId: 'canvas-2' })));
  assertFallback('base_revision_mismatch', () => applyCollaborationSync(base, operationsEnvelope(base, [], { afterRevision: 0 })));
  assertFallback('base_revision_mismatch', () => applyCollaborationSync(base, operationsEnvelope(base, [], { afterRevision: 1.5 })));
  assertFallback('revision_regression', () => applyCollaborationSync(base, operationsEnvelope(base, [], { revision: 0 })));
  assertFallback('operations_invalid', () => applyCollaborationSync(base, operationsEnvelope(base, [], { operations: null })));
  assertFallback('revision_count_gap', () => applyCollaborationSync(base, operationsEnvelope(base, [operation(2)], { revision: 3 })));
  assertFallback('revision_count_gap', () => applyCollaborationSync(base, operationsEnvelope(base, [operation(2), operation(3)], { revision: 2 })));
  assertFallback('operation_identity_invalid', () => (
    applyCollaborationSync(base, operationsEnvelope(base, [operation(3)]))
  ));
});

test('delta requires exact public operation identity and payload shape', () => {
  const base = document();
  const invalidOperations: unknown[] = [
    operation(2, { projectId: undefined }),
    operation(2, { canvasId: undefined }),
    operation(2, { actorId: '' }),
    operation(2, { sessionId: 'private-session-id' } as any),
    operation(2, { baseRevision: null }),
    operation(2, { baseRevision: 2 }),
    operation(2, { baseRevision: 3 }),
    operation(2, { clientSeq: -1 }),
    operation(2, { timestamp: Number.POSITIVE_INFINITY }),
    operation(2, { payload: { nodeId: '', position: { x: 1, y: 2 } } }),
    operation(2, { payload: { nodeId: 'node-1', position: { x: Number.NaN, y: 2 } } }),
    operation(2, { payload: { nodeId: 'node-1', position: { x: 1, y: 2, z: 3 } } }),
  ];
  for (const invalid of invalidOperations) {
    assertFallback('operation_identity_invalid', () => (
      applyCollaborationSync(base, operationsEnvelope(base, [invalid]))
    ));
  }
  assertFallback('operation_requires_snapshot', () => applyCollaborationSync(base, operationsEnvelope(base, [
    operation(2, { type: 'node.teleport', payload: { nodeId: 'node-1' } } as any),
  ])));
  assertFallback('operation_requires_snapshot', () => applyCollaborationMoveDelta(base, operationsEnvelope(base, [
    operation(2, { type: 'node.patch', payload: { nodeId: 'node-1', patch: {} } } as any),
  ])));
  assertFallback('move_target_missing', () => applyCollaborationSync(base, operationsEnvelope(base, [
    operation(2, { payload: { nodeId: 'missing', position: { x: 1, y: 2 } } }),
  ])));
});

test('delta rejects unknown top-level operation fields instead of silently trusting them', () => {
  const base = document();
  assertFallback('operation_identity_invalid', () => applyCollaborationSync(base, operationsEnvelope(base, [
    { ...operation(2), unexpected: 'field' },
  ])));
});

test('delta rejects duplicate opIds and cross-namespace node identity ambiguity', () => {
  const base = document();
  assertFallback('operation_id_duplicate', () => applyCollaborationSync(base, operationsEnvelope(base, [
    operation(2, { opId: 'duplicate' }),
    operation(3, { opId: 'duplicate' }),
  ])));
  const ambiguous = document(1, {
    nodes: [
      { id: 'shared-id', entityUid: NODE_UID_1, entityRevision: 1, position: { x: 0, y: 0 }, data: {} },
      { id: NODE_UID_1, entityUid: NODE_UID_2, entityRevision: 1, position: { x: 1, y: 1 }, data: {} },
    ],
    edges: [],
  });
  assertFallback('snapshot_node_identity_conflict', () => applyCollaborationSync(ambiguous, operationsEnvelope(ambiguous, [
    operation(2, { payload: { nodeId: 'shared-id', position: { x: 2, y: 2 } } }),
  ])));
});

test('delta application is atomic when a later structural operation cannot be applied', () => {
  const base = document();
  const before = structuredClone(base);
  assertFallback('edge_target_missing', () => applyCollaborationSync(base, operationsEnvelope(base, [
    operation(2),
    operation(3, { type: 'edge.delete', payload: { edgeId: 'missing-edge' } } as any),
  ])));
  assert.deepEqual(base, before);
});

test('generic delta atomically applies all nine structural operation types', () => {
  const base = structuralDocument();
  const before = structuredClone(base);
  const restoredNode = {
    id: 'node-3',
    entityUid: NODE_UID_3,
    type: 'text',
    position: { x: 30, y: 31 },
    data: { text: 'three' },
  };
  const restoredEdge = {
    id: 'edge-2',
    entityUid: EDGE_UID_2,
    source: 'node-1',
    target: 'node-3',
    sourceHandle: null,
    targetHandle: null,
  };
  const operations = [
    structuralOperation(2, 'node.add', { node: restoredNode }),
    structuralOperation(3, 'node.patch', { nodeId: 'node-1', dataPatch: { label: 'patched' } }),
    structuralOperation(4, 'node.move', { nodeId: NODE_UID_2, position: { x: 40, y: 41 } }),
    structuralOperation(5, 'edge.add', { edge: restoredEdge }),
    structuralOperation(6, 'viewport.set', { viewport: { x: 10, y: 11, zoom: 1.5 } }),
    structuralOperation(7, 'edge.delete', { edgeId: EDGE_UID_2 }),
    structuralOperation(8, 'node.delete', { nodeId: NODE_UID_3 }),
    structuralOperation(9, 'node.restore', { node: restoredNode }),
    structuralOperation(10, 'edge.restore', { edge: restoredEdge }),
  ];
  const applied = applyCollaborationOperationsDelta(base, operationsEnvelope(base, operations));
  assert.equal(applied.revision, 10);
  assert.deepEqual(applied.viewport, { x: 10, y: 11, zoom: 1.5 });
  assert.deepEqual(applied.nodes.find((node) => node.id === 'node-1')?.data, {
    text: 'one',
    label: 'patched',
  });
  assert.deepEqual(applied.nodes.find((node) => node.id === 'node-2')?.position, { x: 40, y: 41 });
  assert.equal(applied.nodes.some((node) => node.id === 'node-3'), true);
  assert.equal(applied.edges.some((edge) => edge.id === 'edge-2'), true);
  assert.deepEqual(applied.tombstones, { nodes: {}, edges: {} });
  assert.deepEqual(base, before);
});

test('delete deltas create public tombstones, cascade edges, and require explicit restore', () => {
  const base = structuralDocument();
  const deleted = applyCollaborationSync(base, operationsEnvelope(base, [
    structuralOperation(2, 'node.delete', { nodeId: NODE_UID_1 }),
  ]));
  assert.equal(deleted.nodes.some((node) => node.id === 'node-1'), false);
  assert.equal(deleted.edges.some((edge) => edge.id === 'edge-1'), false);
  assert.deepEqual(deleted.tombstones.nodes['node-1'], {
    opId: 'structural-2',
    actorId: 'member-1',
    deletedAt: 102,
    revision: 2,
    entityUid: NODE_UID_1,
    entityType: 'text',
    source: null,
    target: null,
  });
  assert.equal(Object.hasOwn(deleted.tombstones.nodes['node-1'], 'sessionId'), false);
  assert.equal(deleted.tombstones.edges['edge-1'].entityUid, EDGE_UID_1);

  assertFallback('operation_object_deleted', () => applyCollaborationSync(
    deleted,
    operationsEnvelope(deleted, [
      structuralOperation(3, 'node.move', { nodeId: 'node-1', position: { x: 1, y: 2 } }, { baseRevision: 2 }),
    ]),
  ));

  const restoredNode = {
    id: 'node-1',
    entityUid: NODE_UID_1,
    type: 'text',
    position: { x: 0, y: 0 },
    data: { text: 'one' },
  };
  const restoredEdge = {
    id: 'edge-1',
    entityUid: EDGE_UID_1,
    source: 'node-1',
    target: 'node-2',
  };
  const restored = applyCollaborationSync(deleted, operationsEnvelope(deleted, [
    structuralOperation(3, 'node.restore', { node: restoredNode }, { baseRevision: 2 }),
    structuralOperation(4, 'edge.restore', { edge: restoredEdge }, { baseRevision: 2 }),
  ]));
  assert.equal(restored.nodes.some((node) => node.id === 'node-1'), true);
  assert.equal(restored.edges.some((edge) => edge.id === 'edge-1'), true);
  assert.deepEqual(restored.tombstones, { nodes: {}, edges: {} });
});

test('edge tombstone deltas bind named handles while legacy tombstones remain restorable', () => {
  const namedEdge = {
    id: 'edge-1',
    entityUid: EDGE_UID_1,
    entityRevision: 1,
    source: 'node-1',
    target: 'node-2',
    sourceHandle: 'text-out',
    targetHandle: 'text-in',
  };
  const base = structuralDocument(1, { edges: [namedEdge] });
  const deleted = applyCollaborationSync(base, operationsEnvelope(base, [
    structuralOperation(2, 'edge.delete', { edgeId: 'edge-1' }),
  ]));
  assert.equal(deleted.tombstones.edges['edge-1'].sourceHandle, 'text-out');
  assert.equal(deleted.tombstones.edges['edge-1'].targetHandle, 'text-in');

  assertFallback('operation_restore_invalid', () => applyCollaborationSync(deleted, operationsEnvelope(deleted, [
    structuralOperation(3, 'edge.restore', {
      edge: { ...namedEdge, sourceHandle: 'forged-output' },
    }, { baseRevision: 2 }),
  ])));
  assertFallback('operation_restore_invalid', () => applyCollaborationSync(deleted, operationsEnvelope(deleted, [
    structuralOperation(3, 'edge.restore', {
      edge: {
        id: namedEdge.id,
        entityUid: namedEdge.entityUid,
        source: namedEdge.source,
        target: namedEdge.target,
        sourceHandle: namedEdge.sourceHandle,
      },
    }, { baseRevision: 2 }),
  ])));

  const restored = applyCollaborationSync(deleted, operationsEnvelope(deleted, [
    structuralOperation(3, 'edge.restore', { edge: namedEdge }, { baseRevision: 2 }),
  ]));
  assert.equal(restored.edges[0].sourceHandle, 'text-out');
  assert.equal(restored.edges[0].targetHandle, 'text-in');

  const legacy = structuredClone(deleted);
  delete legacy.tombstones.edges['edge-1'].sourceHandle;
  delete legacy.tombstones.edges['edge-1'].targetHandle;
  const legacyRestored = applyCollaborationSync(legacy, operationsEnvelope(legacy, [
    structuralOperation(3, 'edge.restore', { edge: namedEdge }, { baseRevision: 2 }),
  ]));
  assert.equal(legacyRestored.edges[0].sourceHandle, 'text-out');

  const unnamedBase = structuralDocument();
  const unnamedDeleted = applyCollaborationSync(unnamedBase, operationsEnvelope(unnamedBase, [
    structuralOperation(2, 'edge.delete', { edgeId: 'edge-1' }),
  ]));
  assert.equal(Object.hasOwn(unnamedDeleted.tombstones.edges['edge-1'], 'sourceHandle'), true);
  assert.equal(unnamedDeleted.tombstones.edges['edge-1'].sourceHandle, null);
  assertFallback('operation_restore_invalid', () => applyCollaborationSync(
    unnamedDeleted,
    operationsEnvelope(unnamedDeleted, [
      structuralOperation(3, 'edge.restore', { edge: namedEdge }, { baseRevision: 2 }),
    ]),
  ));
});

test('edge restore deltas bind source/targetEntityUid and reject display-ID ABA substitution', () => {
  const base = structuralDocument();
  const deleted = applyCollaborationSync(base, operationsEnvelope(base, [
    structuralOperation(2, 'edge.delete', { edgeId: 'edge-1' }),
  ]));
  assert.equal(deleted.tombstones.edges['edge-1'].sourceEntityUid, NODE_UID_1);
  assert.equal(deleted.tombstones.edges['edge-1'].targetEntityUid, NODE_UID_2);

  const abaBase = structuredClone(deleted);
  const replacement = abaBase.nodes.find((node) => node.id === 'node-1')!;
  replacement.entityUid = NODE_UID_3;
  assertFallback('snapshot_edge_endpoint_identity_conflict', () => applyCollaborationSync(
    abaBase,
    operationsEnvelope(abaBase, []),
  ));

  assertFallback('operation_restore_invalid', () => applyCollaborationSync(
    deleted,
    operationsEnvelope(deleted, [
      structuralOperation(3, 'edge.restore', {
        edge: {
          id: 'edge-1',
          entityUid: EDGE_UID_1,
          source: 'node-1',
          target: 'node-2',
          sourceEntityUid: NODE_UID_3,
          targetEntityUid: NODE_UID_2,
        },
      }, { baseRevision: 2 }),
    ]),
  ));

  const restored = applyCollaborationSync(deleted, operationsEnvelope(deleted, [
    structuralOperation(3, 'edge.restore', {
      edge: { id: 'edge-1', entityUid: EDGE_UID_1, source: 'node-1', target: 'node-2' },
    }, { baseRevision: 2 }),
  ]));
  assert.equal(restored.edges[0].sourceEntityUid, NODE_UID_1);
  assert.equal(restored.edges[0].targetEntityUid, NODE_UID_2);
});

test('all structural payloads use exact allowlists and incomplete or redacted deltas fail closed', () => {
  const base = structuralDocument();
  const validPayloads: Array<[CanvasSyncOperation['type'], Record<string, unknown>]> = [
    ['node.add', { node: { id: 'node-3', entityUid: NODE_UID_3, type: 'text', position: { x: 1, y: 2 }, data: {} } }],
    ['node.patch', { nodeId: 'node-1', patch: {} }],
    ['node.move', { nodeId: 'node-1', position: { x: 1, y: 2 } }],
    ['node.delete', { nodeId: 'node-1' }],
    ['node.restore', { node: { id: 'node-3', entityUid: NODE_UID_3, type: 'text', position: { x: 1, y: 2 }, data: {} } }],
    ['edge.add', { edge: { id: 'edge-2', entityUid: EDGE_UID_2, source: 'node-1', target: 'node-2' } }],
    ['edge.delete', { edgeId: 'edge-1' }],
    ['edge.restore', { edge: { id: 'edge-2', entityUid: EDGE_UID_2, source: 'node-1', target: 'node-2' } }],
    ['viewport.set', { viewport: { x: 1, y: 2, zoom: 1 } }],
  ];
  for (const [type, payload] of validPayloads) {
    assertFallback(null, () => applyCollaborationSync(base, operationsEnvelope(base, [
      structuralOperation(2, type, { ...payload, unexpected: true }),
    ])));
  }
  for (const payload of [
    { nodeId: 'node-1', patch: { legacyAliases: ['forged-alias'] } },
    { nodeId: 'node-1', unsetKeys: ['legacyAliases'] },
    { nodeId: 'node-1', unsetKeys: ['entityRevision'] },
  ]) {
    assertFallback('operation_payload_invalid', () => applyCollaborationSync(base, operationsEnvelope(base, [
      structuralOperation(2, 'node.patch', payload),
    ])));
  }
  const incompletePayloads: Array<[CanvasSyncOperation['type'], Record<string, unknown>]> = [
    ['node.add', {}],
    ['node.patch', { patch: {} }],
    ['node.move', { nodeId: 'node-1' }],
    ['node.delete', {}],
    ['node.restore', {}],
    ['edge.add', {}],
    ['edge.delete', {}],
    ['edge.restore', {}],
    ['viewport.set', {}],
  ];
  for (const [type, payload] of incompletePayloads) {
    assertFallback(null, () => applyCollaborationSync(base, operationsEnvelope(base, [
      structuralOperation(2, type, payload),
    ])));
  }
  assertFallback('operation_payload_invalid', () => applyCollaborationSync(base, operationsEnvelope(base, [
    structuralOperation(2, 'node.add', {
      node: { id: 'node-3', type: 'text', position: { x: 1, y: 2 }, data: {} },
    }),
  ])));
  assertFallback('operation_payload_invalid', () => applyCollaborationSync(base, operationsEnvelope(base, [
    structuralOperation(2, 'edge.add', {
      edge: { id: 'edge-2', source: 'node-1', target: 'node-2' },
    }),
  ])));
  assertFallback('operation_redacted', () => applyCollaborationSync(base, operationsEnvelope(base, [
    structuralOperation(2, 'node.patch', { nodeId: 'node-1', dataPatch: { token: '[redacted]' } }),
  ])));
  assertFallback('operation_redacted', () => applyCollaborationSync(base, operationsEnvelope(base, [
    structuralOperation(2, 'node.patch', { nodeId: 'node-1', dataPatch: { source: 'file [local-path]' } }),
  ])));
  assertFallback('operation_private_field', () => applyCollaborationSync(base, operationsEnvelope(base, [
    structuralOperation(2, 'node.patch', { nodeId: 'node-1', dataPatch: { sessionId: 'private' } }),
  ])));
});

test('delta accepts 500 operations and rejects 501 or a lower negotiated maximum', () => {
  const base = document();
  const fiveHundred = Array.from({ length: COLLABORATION_SYNC_MAX_OPERATIONS }, (_, index) => (
    operation(base.revision + index + 1, {
      opId: `bulk-${index}`,
      clientSeq: index,
      timestamp: 1_000 + index,
    })
  ));
  const applied = applyCollaborationSync(base, operationsEnvelope(base, fiveHundred));
  assert.equal(applied.revision, 501);
  assert.deepEqual(applied.nodes[0].position, { x: 501, y: 502 });

  const fiveHundredOne = [...fiveHundred, operation(502, { opId: 'bulk-500', clientSeq: 500 })];
  assertFallback('operations_limit_exceeded', () => applyCollaborationSync(
    base,
    operationsEnvelope(base, fiveHundredOne),
  ));
  assertFallback('operations_limit_exceeded', () => applyCollaborationSync(
    base,
    operationsEnvelope(base, fiveHundred.slice(0, 4)),
    { maxOperations: 3 },
  ));
});

test('delta rejects an oversized response before applying any operation', () => {
  const base = document();
  const oversized = {
    ...operation(2),
    padding: 'x'.repeat(COLLABORATION_SYNC_MAX_OPERATION_BYTES),
  };
  assertFallback('operations_bytes_exceeded', () => applyCollaborationSync(
    base,
    operationsEnvelope(base, [oversized]),
  ));
  assert.equal(base.revision, 1);
  assert.deepEqual(base.nodes[0].position, { x: 0, y: 0 });
});

test('snapshot validates envelope, project/canvas scope, revision, and document shape', () => {
  const base = document();
  const snapshot = document(3, { updatedAt: 300 });
  const accepted = acceptCollaborationSnapshot(base, snapshotEnvelope(base, snapshot));
  assert.deepEqual(accepted, snapshot);
  assert.notEqual(accepted, snapshot);

  assertFallback('snapshot_envelope_invalid', () => acceptCollaborationSnapshot(base, snapshotEnvelope(base, snapshot, {
    canvasId: 'canvas-2',
  })));
  assertFallback('snapshot_envelope_invalid', () => acceptCollaborationSnapshot(base, snapshotEnvelope(base, snapshot, {
    afterRevision: 0,
  })));
  assertFallback('snapshot_envelope_invalid', () => acceptCollaborationSnapshot(base, snapshotEnvelope(base, snapshot, {
    reason: 'untrusted_reason',
  })));
  assertFallback('snapshot_revision_mismatch', () => acceptCollaborationSnapshot(base, snapshotEnvelope(base, snapshot, {
    revision: 4,
  })));
  assertFallback('snapshot_document_invalid', () => acceptCollaborationSnapshot(base, snapshotEnvelope(base, {
    ...snapshot, projectId: 'project-2',
  })));
  assertFallback('snapshot_document_invalid', () => acceptCollaborationSnapshot(base, snapshotEnvelope(base, {
    ...snapshot, schemaVersion: 1,
  } as any)));
  assertFallback('snapshot_document_private_field', () => acceptCollaborationSnapshot(base, snapshotEnvelope(base, {
    ...snapshot,
    sessionId: 'private-session',
  } as any)));
  assertFallback('snapshot_node_invalid', () => acceptCollaborationSnapshot(base, snapshotEnvelope(base, {
    ...snapshot,
    nodes: [{ id: 'node-1', entityUid: 'node-uid-1', position: { x: 0, y: 0, z: 1 }, data: {} }],
  })));
});

test('snapshot permits only an explicit client_ahead authority reset to regress revision', () => {
  const base = document(5);
  const older = document(3, { updatedAt: 300 });
  assertFallback('snapshot_revision_regression', () => acceptCollaborationSnapshot(
    base,
    snapshotEnvelope(base, older, { reason: 'history_gap' }),
  ));
  assert.deepEqual(acceptCollaborationSnapshot(
    base,
    snapshotEnvelope(base, older, { reason: 'client_ahead' }),
  ), older);
});

test('snapshot rejects duplicate edge identities', () => {
  const base = document();
  const duplicateEdges = document(2, {
    edges: [
      { id: 'edge-1', source: 'node-1', target: 'node-2' },
      { id: 'edge-1', source: 'node-2', target: 'node-1' },
    ],
  });
  assertFallback(null, () => acceptCollaborationSnapshot(base, snapshotEnvelope(base, duplicateEdges)));
});

test('snapshot rejects dangling edge endpoints', () => {
  const base = document();
  const dangling = document(2, {
    edges: [{ id: 'edge-1', source: 'node-1', target: 'missing-node' }],
  });
  assertFallback(null, () => acceptCollaborationSnapshot(base, snapshotEnvelope(base, dangling)));
});

test('acknowledgement requires an exact ambiguous retry identity and payload', () => {
  const wireOperation = operation(2);
  const queued: QueuedMoveIdentity = {
    operation: {
      opId: wireOperation.opId,
      clientSeq: wireOperation.clientSeq,
      timestamp: wireOperation.timestamp,
      type: 'node.move',
      payload: structuredClone(wireOperation.payload) as QueuedMoveIdentity['operation']['payload'],
    },
    baseRevision: wireOperation.baseRevision ?? null,
  };
  assert.equal(collaborationDeltaAcknowledgesQueuedMove(wireOperation, queued, 'member-1'), true);
  for (const changed of [
    { ...wireOperation, opId: 'other-op' },
    { ...wireOperation, actorId: 'other-member' },
    { ...wireOperation, baseRevision: 2 },
    { ...wireOperation, clientSeq: 99 },
    { ...wireOperation, timestamp: wireOperation.timestamp + 1 },
    { ...wireOperation, payload: { nodeId: 'node-2', position: { x: 2, y: 3 } } },
    { ...wireOperation, payload: { nodeId: 'node-1', position: { x: 999, y: 3 } } },
  ]) assert.equal(collaborationDeltaAcknowledgesQueuedMove(changed, queued, 'member-1'), false);
  assert.equal(collaborationDeltaAcknowledgesQueuedMove(wireOperation, { ...queued, baseRevision: null }, 'member-1'), false);
});

test('acknowledgement rejects payload extensions instead of treating them as the exact retry', () => {
  const wireOperation = operation(2);
  const queued: QueuedMoveIdentity = {
    operation: {
      opId: wireOperation.opId,
      clientSeq: wireOperation.clientSeq,
      timestamp: wireOperation.timestamp,
      type: 'node.move',
      payload: structuredClone(wireOperation.payload) as QueuedMoveIdentity['operation']['payload'],
    },
    baseRevision: wireOperation.baseRevision ?? null,
  };
  assert.equal(collaborationDeltaAcknowledgesQueuedMove({
    ...wireOperation,
    payload: { ...wireOperation.payload, unexpected: true },
  }, queued, 'member-1'), false);
});

test('mutation response requires one exact public acknowledgement before deleting a queued move', () => {
  const wireOperation = operation(2);
  const queued: QueuedMoveIdentity = {
    operation: {
      opId: wireOperation.opId,
      clientSeq: wireOperation.clientSeq,
      timestamp: wireOperation.timestamp,
      type: 'node.move',
      payload: structuredClone(wireOperation.payload) as QueuedMoveIdentity['operation']['payload'],
    },
    baseRevision: wireOperation.baseRevision ?? null,
  };
  const acknowledgement = { ...wireOperation, duplicate: false };
  const accepted = acceptCollaborationMoveMutationResult({
    document: document(2),
    acknowledgements: [acknowledgement],
  }, queued, {
    projectId: 'project-1',
    canvasId: 'canvas-1',
    memberId: 'member-1',
  });
  assert.equal(accepted.acknowledgement.opId, wireOperation.opId);
  assert.equal(accepted.document.revision, 2);

  const duplicate = acceptCollaborationMoveMutationResult({
    document: document(3),
    acknowledgements: [{ ...acknowledgement, duplicate: true }],
  }, queued, {
    projectId: 'project-1',
    canvasId: 'canvas-1',
    memberId: 'member-1',
  });
  assert.equal(duplicate.acknowledgement.duplicate, true);
  assert.equal(duplicate.document.revision, 3);
});

test('mutation response rejects missing, mismatched, extended, or revision-invalid acknowledgements', () => {
  const wireOperation = operation(2);
  const queued: QueuedMoveIdentity = {
    operation: {
      opId: wireOperation.opId,
      clientSeq: wireOperation.clientSeq,
      timestamp: wireOperation.timestamp,
      type: 'node.move',
      payload: structuredClone(wireOperation.payload) as QueuedMoveIdentity['operation']['payload'],
    },
    baseRevision: wireOperation.baseRevision ?? null,
  };
  const acknowledgement = { ...wireOperation, duplicate: false };
  const scope = { projectId: 'project-1', canvasId: 'canvas-1', memberId: 'member-1' };
  for (const invalid of [
    { document: document(2), acknowledgements: [] },
    { document: document(2), acknowledgements: [{ ...acknowledgement, opId: 'other-op' }] },
    { document: document(2), acknowledgements: [{ ...acknowledgement, baseRevision: 2 }] },
    { document: document(2), acknowledgements: [{ ...acknowledgement, clientSeq: 99 }] },
    { document: document(2), acknowledgements: [{ ...acknowledgement, unexpected: true }] },
    { document: document(3), acknowledgements: [acknowledgement] },
  ]) assertFallback(null, () => acceptCollaborationMoveMutationResult(invalid, queued, scope));
  assertFallback(null, () => acceptCollaborationMoveMutationResult({
    document: document(2),
    acknowledgements: [acknowledgement],
  }, { ...queued, baseRevision: null }, scope));
});

test('generic mutation response accepts an exact fresh batch or an exact all-duplicate retry', () => {
  const operations = [
    mutationIdentity(1, 'node.move', { nodeId: 'node-1', position: { x: 7, y: 8 } }),
    mutationIdentity(2, 'viewport.set', { viewport: { x: 10, y: 11, zoom: 1.25 } }),
  ];
  const batch: CollaborationMutationBatchIdentity = { baseRevision: 1, operations };
  const scope = { projectId: 'project-1', canvasId: 'canvas-1', memberId: 'member-1' };
  const fresh = acceptCollaborationMutationResult({
    document: document(3),
    acknowledgements: [
      mutationAcknowledgement(operations[0], 2),
      mutationAcknowledgement(operations[1], 3),
    ],
  }, batch, scope);
  assert.deepEqual(fresh.acknowledgements.map((acknowledgement) => acknowledgement.revision), [2, 3]);
  assert.deepEqual(fresh.acknowledgements.map((acknowledgement) => acknowledgement.duplicate), [false, false]);
  assert.equal(fresh.document.revision, 3);

  const duplicate = acceptCollaborationMutationResult({
    document: document(6),
    acknowledgements: [
      mutationAcknowledgement(operations[0], 2, true),
      mutationAcknowledgement(operations[1], 3, true),
    ],
  }, batch, scope);
  assert.deepEqual(duplicate.acknowledgements.map((acknowledgement) => acknowledgement.duplicate), [true, true]);
  assert.equal(duplicate.document.revision, 6);
});

test('mutation ACK accepts pre-authority add payloads while the document carries generated UUIDs', () => {
  const operations = [
    mutationIdentity(1, 'node.add', {
      node: {
        id: 'node-created',
        type: 'text',
        position: { x: 40, y: 50 },
        data: { text: '', label: '协作文本' },
      },
    }),
    mutationIdentity(2, 'edge.add', {
      edge: {
        id: 'edge-created',
        source: 'node-1',
        target: 'node-created',
        sourceHandle: null,
        targetHandle: null,
        type: 'default',
      },
    }),
  ];
  const resultDocument = document(3, {
    nodes: [
      ...document().nodes,
      {
        ...(operations[0].payload.node as Record<string, unknown>),
        entityUid: 'bb802078-42e1-5a49-bc4f-d9ba7d8f584e',
        entityRevision: 2,
      },
    ],
    edges: [{
      ...(operations[1].payload.edge as Record<string, unknown>),
      entityUid: 'd73005b2-ae6e-5d63-9bf4-8172a93cd785',
      entityRevision: 3,
    }],
  });
  const accepted = acceptCollaborationMutationResult({
    document: resultDocument,
    acknowledgements: [
      mutationAcknowledgement(operations[0], 2),
      mutationAcknowledgement(operations[1], 3),
    ],
  }, { baseRevision: 1, operations }, {
    projectId: 'project-1',
    canvasId: 'canvas-1',
    memberId: 'member-1',
  });
  assert.equal(accepted.document.nodes.some((node) => node.id === 'node-created'), true);
  assert.equal(accepted.document.edges.some((edge) => edge.id === 'edge-created'), true);

  assertFallback('operation_payload_invalid', () => acceptCollaborationMutationResult({
    document: document(2),
    acknowledgements: [mutationAcknowledgement({
      ...operations[0],
      payload: {
        node: {
          ...(operations[0].payload.node as Record<string, unknown>),
          entityUid: 'not-a-uuid',
        },
      },
    }, 2)],
  }, {
    baseRevision: 1,
    operations: [{
      ...operations[0],
      payload: {
        node: {
          ...(operations[0].payload.node as Record<string, unknown>),
          entityUid: 'not-a-uuid',
        },
      },
    }],
  }, {
    projectId: 'project-1',
    canvasId: 'canvas-1',
    memberId: 'member-1',
  }));
});

test('generic mutation response rejects count, order, revision, identity, and mixed duplicate ambiguity', () => {
  const operations = [
    mutationIdentity(1, 'node.move', { nodeId: 'node-1', position: { x: 7, y: 8 } }),
    mutationIdentity(2, 'viewport.set', { viewport: { x: 10, y: 11, zoom: 1.25 } }),
  ];
  const batch: CollaborationMutationBatchIdentity = { baseRevision: 1, operations };
  const scope = { projectId: 'project-1', canvasId: 'canvas-1', memberId: 'member-1' };
  const acknowledgements = [
    mutationAcknowledgement(operations[0], 2),
    mutationAcknowledgement(operations[1], 3),
  ];
  const invalidResponses = [
    { document: document(3), acknowledgements: acknowledgements.slice(0, 1) },
    { document: document(3), acknowledgements: [acknowledgements[1], acknowledgements[0]] },
    { document: document(3), acknowledgements: [acknowledgements[0], { ...acknowledgements[1], revision: 4 }] },
    { document: document(3), acknowledgements: [{ ...acknowledgements[0], actorId: 'member-2' }, acknowledgements[1]] },
    { document: document(3), acknowledgements: [{ ...acknowledgements[0], payload: { nodeId: 'node-1', position: { x: 999, y: 8 } } }, acknowledgements[1]] },
    { document: document(3), acknowledgements: [{ ...acknowledgements[0], sessionId: 'private' }, acknowledgements[1]] },
    { document: document(3), acknowledgements: [{ ...acknowledgements[0], duplicate: true }, acknowledgements[1]] },
    { document: document(4), acknowledgements },
  ];
  for (const response of invalidResponses) {
    assertFallback(null, () => acceptCollaborationMutationResult(response, batch, scope));
  }
  assertFallback('mutation_acknowledgement_revision_invalid', () => acceptCollaborationMutationResult({
    document: document(2),
    acknowledgements: acknowledgements.map((acknowledgement) => ({ ...acknowledgement, duplicate: true })),
  }, batch, scope));
  assertFallback('mutation_acknowledgement_invalid', () => acceptCollaborationMutationResult({
    document: document(3),
    acknowledgements,
  }, { baseRevision: 1, operations: [operations[0], { ...operations[0] }] }, scope));
});

test('generic mutation exactness rejects redacted payloads and private or extended request identities', () => {
  const operationIdentity = mutationIdentity(1, 'node.patch', {
    nodeId: 'node-1',
    dataPatch: { label: 'safe' },
  });
  const batch: CollaborationMutationBatchIdentity = { baseRevision: 1, operations: [operationIdentity] };
  const scope = { projectId: 'project-1', canvasId: 'canvas-1', memberId: 'member-1' };
  const acknowledgement = mutationAcknowledgement(operationIdentity, 2);
  assertFallback('operation_redacted', () => acceptCollaborationMutationResult({
    document: document(2),
    acknowledgements: [{
      ...acknowledgement,
      payload: { nodeId: 'node-1', dataPatch: { label: '[redacted]' } },
    }],
  }, batch, scope));
  assertFallback('mutation_acknowledgement_invalid', () => acceptCollaborationMutationResult({
    document: document(2),
    acknowledgements: [acknowledgement],
  }, {
    baseRevision: 1,
    operations: [{ ...operationIdentity, sessionId: 'private' } as any],
  }, scope));
  assertFallback('mutation_acknowledgement_invalid', () => acceptCollaborationMutationResult({
    document: document(2),
    acknowledgements: [acknowledgement],
  }, {
    baseRevision: 1,
    operations: [{ ...operationIdentity, unexpected: true } as any],
  }, scope));
});
