const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCanvasDocument } = require('../backend/src/collaboration/protocol');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const {
  CollaborationStructureAuthorityError,
  assertCollaborationStructureAuthority,
  createCollaborationStructureAuthorityAssertion,
} = require('../backend/src/services/collaborationStructureAuthority');

function node(id, type, data = {}) {
  return { id, type, data, position: { x: 0, y: 0 } };
}

function document(nodes, edges = [], canvasId = 'canvas-f3') {
  return normalizeCanvasDocument(canvasId, { nodes, edges });
}

function addedEdgeOperation(edge, suffix = edge.id) {
  return {
    opId: `edge-add-${suffix}`,
    type: 'edge.add',
    payload: { edge },
  };
}

function assertAuthorityError(run, code, status) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof CollaborationStructureAuthorityError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.doesNotMatch(error.message, /node-|edge-|canvas-|definition-/);
    return true;
  });
}

test('unrelated move does not revalidate legacy required inputs, cycles, or self edges', () => {
  const legacyDocument = document(
    [node('node-a', 'text'), node('node-b', 'drawing-board')],
    [
      { id: 'edge-cycle-a', source: 'node-a', target: 'node-b' },
      { id: 'edge-cycle-b', source: 'node-b', target: 'node-a' },
      { id: 'edge-self', source: 'node-a', target: 'node-a' },
    ],
  );
  assert.equal(assertCollaborationStructureAuthority(legacyDocument, [{
    opId: 'move-only',
    type: 'node.move',
    payload: { nodeId: 'node-b', position: { x: 20, y: 30 } },
  }]), true);
});

test('rejects a self edge with a stable safe error', () => {
  const edge = { id: 'edge-self', source: 'node-text', target: 'node-text' };
  const resultingDocument = document([node('node-text', 'text')], [edge]);
  assertAuthorityError(
    () => assertCollaborationStructureAuthority(resultingDocument, [addedEdgeOperation(edge)]),
    'collaboration_structure_self_edge',
    422,
  );
});

test('rejects duplicate signatures after UUID endpoints are normalized to node IDs', () => {
  const base = document([node('node-source', 'text'), node('node-target', 'text')]);
  const sourceUid = base.nodes.find((item) => item.id === 'node-source').entityUid;
  const targetUid = base.nodes.find((item) => item.id === 'node-target').entityUid;
  const duplicate = { id: 'edge-duplicate', source: sourceUid, target: targetUid };
  const resultingDocument = normalizeCanvasDocument(base.canvasId, {
    ...base,
    edges: [
      { id: 'edge-original', source: 'node-source', target: 'node-target' },
      duplicate,
    ],
  });
  assertAuthorityError(
    () => assertCollaborationStructureAuthority(resultingDocument, [addedEdgeOperation(duplicate)]),
    'collaboration_structure_duplicate_edge',
    409,
  );
});

test('rejects unknown and unresolved authoritative port contracts', async (t) => {
  await t.test('disconnected added node with unknown type', () => {
    const unknownNode = node('node-disconnected-unknown', 'vendor-unknown');
    const resultingDocument = document([unknownNode]);
    assertAuthorityError(
      () => assertCollaborationStructureAuthority(resultingDocument, [{
        opId: 'add-disconnected-unknown',
        type: 'node.add',
        payload: { node: unknownNode },
      }]),
      'collaboration_structure_port_contract_unresolved',
      422,
    );
  });

  await t.test('unknown node type', () => {
    const edge = { id: 'edge-unknown-contract', source: 'node-unknown', target: 'node-target' };
    const resultingDocument = document([
      node('node-unknown', 'vendor-unknown'),
      node('node-target', 'text'),
    ], [edge]);
    assertAuthorityError(
      () => assertCollaborationStructureAuthority(resultingDocument, [addedEdgeOperation(edge)]),
      'collaboration_structure_port_contract_unresolved',
      422,
    );
  });

  await t.test('missing pinned subflow definition', () => {
    const edge = {
      id: 'edge-unresolved-subflow',
      source: 'node-source',
      target: 'node-subflow',
      targetHandle: 'prompt',
    };
    const resultingDocument = document([
      node('node-source', 'text'),
      node('node-subflow', 'subflow', { definitionId: 'definition-missing', definitionVersion: 1 }),
    ], [edge]);
    assertAuthorityError(
      () => assertCollaborationStructureAuthority(resultingDocument, [addedEdgeOperation(edge)], {
        resolveSubflow: () => null,
      }),
      'collaboration_structure_port_contract_unresolved',
      422,
    );
  });
});

test('rejects unknown handles and incompatible port kinds', async (t) => {
  await t.test('unknown source handle', () => {
    const edge = {
      id: 'edge-unknown-handle',
      source: 'node-source',
      sourceHandle: 'missing-output',
      target: 'node-target',
    };
    const resultingDocument = document([
      node('node-source', 'text'),
      node('node-target', 'text'),
    ], [edge]);
    assertAuthorityError(
      () => assertCollaborationStructureAuthority(resultingDocument, [addedEdgeOperation(edge)]),
      'collaboration_structure_handle_unknown',
      422,
    );
  });

  await t.test('text output to image-only input', () => {
    const edge = { id: 'edge-incompatible', source: 'node-source', target: 'node-target' };
    const resultingDocument = document([
      node('node-source', 'text'),
      node('node-target', 'drawing-board'),
    ], [edge]);
    assertAuthorityError(
      () => assertCollaborationStructureAuthority(resultingDocument, [addedEdgeOperation(edge)]),
      'collaboration_structure_port_type_incompatible',
      422,
    );
  });
});

test('node patch revalidates its related edges without scanning unrelated graph defects', () => {
  const affectedEdge = { id: 'edge-upload-board', source: 'node-upload', target: 'node-board' };
  const unrelatedSelfEdge = { id: 'edge-unrelated-self', source: 'node-unrelated', target: 'node-unrelated' };
  const resultingDocument = document([
    node('node-upload', 'upload', { uploadType: 'video' }),
    node('node-board', 'drawing-board'),
    node('node-unrelated', 'text'),
  ], [affectedEdge, unrelatedSelfEdge]);
  assertAuthorityError(
    () => assertCollaborationStructureAuthority(resultingDocument, [{
      opId: 'patch-upload-kind',
      type: 'node.patch',
      payload: { nodeId: 'node-upload', dataPatch: { uploadType: 'video' } },
    }]),
    'collaboration_structure_port_type_incompatible',
    422,
  );
});

test('node patch cannot change text-authority fields but may change unrelated data', () => {
  const previousDocument = document([
    node('node-text-managed', 'text', { title: 'before', prompt: 'prompt', keep: true }),
  ]);
  const changedText = normalizeCanvasDocument(previousDocument.canvasId, {
    ...previousDocument,
    nodes: [{
      ...previousDocument.nodes[0],
      data: { ...previousDocument.nodes[0].data, prompt: 'structural overwrite' },
    }],
  });
  const textPatch = {
    opId: 'patch-managed-text',
    type: 'node.patch',
    payload: { nodeId: 'node-text-managed', dataPatch: { prompt: 'structural overwrite' } },
  };
  assertAuthorityError(
    () => assertCollaborationStructureAuthority(changedText, [textPatch], { previousDocument }),
    'collaboration_structure_text_field_managed',
    422,
  );

  const changedMetadata = normalizeCanvasDocument(previousDocument.canvasId, {
    ...previousDocument,
    nodes: [{
      ...previousDocument.nodes[0],
      data: { ...previousDocument.nodes[0].data, keep: false },
    }],
  });
  assert.equal(assertCollaborationStructureAuthority(changedMetadata, [{
    opId: 'patch-unmanaged-data',
    type: 'node.patch',
    payload: { nodeId: 'node-text-managed', dataPatch: { keep: false } },
  }], { previousDocument }), true);
});

test('node add/restore and edge restore all select their final related edge', async (t) => {
  const edge = { id: 'edge-related', source: 'node-source', target: 'node-target' };
  const resultingDocument = document([
    node('node-source', 'text'),
    node('node-target', 'drawing-board'),
  ], [edge]);
  const cases = [
    {
      name: 'node.add',
      operation: { type: 'node.add', payload: { node: resultingDocument.nodes[1] } },
    },
    {
      name: 'node.restore',
      operation: { type: 'node.restore', payload: { node: resultingDocument.nodes[1] } },
    },
    {
      name: 'edge.restore',
      operation: { type: 'edge.restore', payload: { edge: resultingDocument.edges[0] } },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      assertAuthorityError(
        () => assertCollaborationStructureAuthority(resultingDocument, [{
          opId: `select-${item.name}`,
          ...item.operation,
        }]),
        'collaboration_structure_port_type_incompatible',
        422,
      );
    });
  }
});

test('subflow resolution enforces finite input capacity', () => {
  const definition = {
    id: 'definition-capacity',
    version: 3,
    inputs: [{
      id: 'prompt',
      kinds: ['text'],
      required: false,
      minConnections: 0,
      maxConnections: 1,
    }],
    outputs: [],
  };
  const secondEdge = {
    id: 'edge-second',
    source: 'node-source-b',
    target: 'node-subflow',
    targetHandle: 'prompt',
  };
  const resultingDocument = document([
    node('node-source-a', 'text'),
    node('node-source-b', 'text'),
    node('node-subflow', 'subflow', {
      definitionId: definition.id,
      definitionVersion: definition.version,
    }),
  ], [
    {
      id: 'edge-first',
      source: 'node-source-a',
      target: 'node-subflow',
      targetHandle: 'prompt',
    },
    secondEdge,
  ]);
  let resolverCalls = 0;
  assertAuthorityError(
    () => assertCollaborationStructureAuthority(resultingDocument, [addedEdgeOperation(secondEdge)], {
      resolveSubflow: (id, version) => {
        resolverCalls += 1;
        return id === definition.id && version === definition.version ? definition : null;
      },
    }),
    'collaboration_structure_port_capacity_exceeded',
    409,
  );
  assert.equal(resolverCalls, 1);
});

test('assertResultingDocument failure rolls back document, operations, idempotency, audit, and provenance', () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const initial = database.ensureCanvas('canvas-transaction', {
      nodes: [
        node('node-source', 'text'),
        node('node-target', 'drawing-board'),
      ],
      edges: [],
    });
    const operations = [
      {
        opId: 'f3-transaction-move',
        actorId: 'member-f3',
        sessionId: 'session-f3',
        baseRevision: initial.revision,
        clientSeq: 1,
        timestamp: 1_700_000_000_001,
        type: 'node.move',
        payload: { nodeId: 'node-source', position: { x: 80, y: 90 } },
      },
      {
        opId: 'f3-transaction-edge',
        actorId: 'member-f3',
        sessionId: 'session-f3',
        baseRevision: initial.revision,
        clientSeq: 2,
        timestamp: 1_700_000_000_002,
        type: 'edge.add',
        payload: {
          edge: { id: 'edge-invalid', source: 'node-source', target: 'node-target' },
        },
      },
    ];

    assertAuthorityError(
      () => database.applyOperations('canvas-transaction', operations, {
        expectedRevision: initial.revision,
        assertResultingDocument: createCollaborationStructureAuthorityAssertion(operations),
      }),
      'collaboration_structure_port_type_incompatible',
      422,
    );

    const persisted = database.getCanvas('canvas-transaction');
    assert.equal(persisted.revision, initial.revision);
    assert.deepEqual(persisted.nodes.find((item) => item.id === 'node-source').position, { x: 0, y: 0 });
    assert.deepEqual(persisted.edges, []);
    for (const table of [
      'canvas_operations',
      'canvas_operation_idempotency',
      'audit_events',
      'canvas_mutation_provenance',
    ]) {
      const row = database.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE canvas_id = ?`)
        .get('canvas-transaction');
      assert.equal(row.count, 0, `${table} must roll back`);
    }
  } finally {
    database.close();
  }
});
