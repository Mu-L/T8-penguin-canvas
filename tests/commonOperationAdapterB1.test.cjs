const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyCanvasOperation,
  assertCanvasDocumentInvariants,
  normalizeCanvasDocument,
} = require('../backend/src/collaboration/protocol');
const { COMMON_OPERATION_BATCH_CONTRACT } = require('../backend/src/collaboration/commonOperationProtocol');
const { CommonOperationAdapterError, adaptCommonGraphBatch } = require('../backend/src/collaboration/commonOperationAdapter');

const U = {
  batch: '10000000-0000-4000-8000-000000000001',
  client: '10000000-0000-4000-8000-000000000002',
  op1: '10000000-0000-4000-8000-000000000003',
  op2: '10000000-0000-4000-8000-000000000004',
  op3: '10000000-0000-4000-8000-000000000005',
  nodeA: '20000000-0000-4000-8000-000000000001',
  nodeB: '20000000-0000-4000-8000-000000000002',
  nodeOld: '20000000-0000-4000-8000-000000000003',
  edge: '30000000-0000-4000-8000-000000000001',
};

function document() {
  return normalizeCanvasDocument('canvas-display', {
    projectId: 'project-display',
    revision: 4,
    nodes: [{ id: 'node-a', entityUid: U.nodeA, entityRevision: 3, type: 'text', position: { x: 0, y: 0 }, data: { title: 'A' } }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    viewportRevision: 2,
  }, { projectId: 'project-display', revision: 4 });
}

function batch(operations, overrides = {}) {
  return {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: 'project-display',
    canvasId: 'canvas-display',
    baseRevision: 4,
    batchId: U.batch,
    clientId: U.client,
    clientSeq: 7,
    operations,
    ...overrides,
  };
}

test('B1 common graph adapter resolves UUID targets and advances per-entity revisions', () => {
  const adapted = adaptCommonGraphBatch(batch([
    { opId: U.op1, type: 'node.move', payload: { nodeUid: U.nodeA, expectedEntityRevision: 3, position: { x: 8, y: 9 } } },
    { opId: U.op2, type: 'node.add', payload: { nodeUid: U.nodeB, displayId: 'node-b', nodeType: 'output', position: { x: 20, y: 20 }, data: {}, expectedAbsent: true } },
    { opId: U.op3, type: 'edge.add', payload: { edgeUid: U.edge, displayId: 'edge-a-b', sourceNodeUid: U.nodeA, targetNodeUid: U.nodeB, sourceHandle: null, targetHandle: null, edgeType: 'default', data: {}, expectedAbsent: true } },
  ]), document(), { actorId: 'member-a', sessionId: 'session-a', timestamp: 100 });

  assert.deepEqual(adapted.operations.map((operation) => operation.type), ['node.move', 'node.add', 'edge.add']);
  assert.equal(adapted.operations[0].payload.nodeId, 'node-a');
  assert.equal(adapted.operations[2].payload.edge.source, 'node-a');
  assert.equal(adapted.operations[2].payload.edge.target, 'node-b');
  assert.equal(adapted.resultingDocument.revision, 7);
  assert.equal(adapted.resultingDocument.nodes.find((node) => node.id === 'node-a').entityRevision, 5);
  assert.equal(adapted.resultingDocument.nodes.find((node) => node.id === 'node-b').entityRevision, 6);
  assert.equal(adapted.resultingDocument.edges[0].entityRevision, 7);
});

test('B1 adapter rejects stale CAS, deleted implicit resurrection, scope drift, and mixed domains', () => {
  const stale = batch([{ opId: U.op1, type: 'node.move', payload: { nodeUid: U.nodeA, expectedEntityRevision: 2, position: { x: 1, y: 1 } } }]);
  assert.throws(() => adaptCommonGraphBatch(stale, document()), (error) => error instanceof CommonOperationAdapterError && error.code === 'common_operation_cas_conflict');

  const deleted = document();
  deleted.nodes = [];
  deleted.tombstones.nodes['node-a'] = { entityUid: U.nodeA, revision: 4, entityType: 'text' };
  const add = batch([{ opId: U.op1, type: 'node.add', payload: { nodeUid: U.nodeA, displayId: 'node-a', nodeType: 'text', position: { x: 1, y: 1 }, data: {}, expectedAbsent: true } }]);
  assert.throws(() => adaptCommonGraphBatch(add, deleted), (error) => error.code === 'common_operation_cas_conflict');

  assert.throws(() => adaptCommonGraphBatch(batch(stale.operations, { canvasId: 'other' }), document()), (error) => error.code === 'common_operation_scope_mismatch');

  const review = batch([{ opId: U.op1, type: 'review.thread.create', payload: {
    threadUid: '40000000-0000-4000-8000-000000000001', expectedCanvasRevision: 4,
    anchor: { kind: 'canvas', x: 0, y: 0 }, severity: 'normal',
    initialComment: { commentUid: '40000000-0000-4000-8000-000000000002', body: 'review' },
  } }]);
  assert.throws(() => adaptCommonGraphBatch(review, document()), (error) => error.code === 'common_operation_domain_mismatch');
});

test('B1 graph protocol and adapter reject tombstone ABA endpoint identities', () => {
  const deleted = document();
  deleted.nodes.push({
    id: 'node-b',
    entityUid: U.nodeB,
    entityRevision: 4,
    type: 'output',
    position: { x: 20, y: 20 },
    data: {},
  });
  deleted.tombstones.edges['edge-a-b'] = {
    entityUid: U.edge,
    revision: 4,
    entityType: 'default',
    source: 'node-a',
    target: 'node-b',
    sourceEntityUid: U.nodeA,
    targetEntityUid: U.nodeB,
  };

  assert.throws(() => applyCanvasOperation(deleted, {
    opId: U.op1,
    projectId: deleted.projectId,
    canvasId: deleted.canvasId,
    actorId: 'member-a',
    sessionId: 'session-a',
    baseRevision: deleted.revision,
    clientSeq: 1,
    timestamp: 100,
    type: 'edge.restore',
    payload: { edge: {
      id: 'edge-a-b',
      entityUid: U.edge,
      source: 'node-a',
      target: 'node-b',
      sourceEntityUid: U.nodeOld,
      targetEntityUid: U.nodeB,
      type: 'default',
    } },
  }), /sourceEntityUid/);

  const forgedTombstone = structuredClone(deleted);
  forgedTombstone.tombstones.edges['edge-a-b'].sourceEntityUid = U.nodeOld;
  assert.throws(
    () => adaptCommonGraphBatch(batch([{
      opId: U.op1,
      type: 'edge.restore',
      payload: {
        edgeUid: U.edge,
        displayId: 'edge-a-b',
        sourceNodeUid: U.nodeA,
        targetNodeUid: U.nodeB,
        sourceHandle: null,
        targetHandle: null,
        edgeType: 'default',
        data: {},
        expectedTombstoneRevision: 4,
      },
    }]), forgedTombstone),
    (error) => error instanceof CommonOperationAdapterError && error.code === 'common_operation_identity_collision',
  );

  const lifecycleConflict = document();
  lifecycleConflict.tombstones.nodes['node-a'] = { entityUid: U.nodeA, revision: 4, entityType: 'text' };
  assert.throws(
    () => assertCanvasDocumentInvariants(lifecycleConflict),
    /活动节点与 tombstone 身份冲突/,
  );
});

test('B1 restore inherits tombstone aliases and rejects alias replacement', () => {
  const deleted = document();
  deleted.nodes.push({
    id: 'node-b', entityUid: U.nodeB, entityRevision: 4, legacyAliases: ['node-b-old'],
    type: 'output', position: { x: 20, y: 20 }, data: {},
  });
  deleted.tombstones.nodes['node-old'] = {
    entityUid: U.nodeOld, revision: 4, entityType: 'text', legacyAliases: ['node-very-old'],
  };
  deleted.tombstones.edges['edge-a-b'] = {
    entityUid: U.edge, revision: 4, entityType: 'default', legacyAliases: ['edge-old'],
    source: 'node-a', target: 'node-b', sourceEntityUid: U.nodeA, targetEntityUid: U.nodeB,
  };

  const adapted = adaptCommonGraphBatch(batch([
    { opId: U.op1, type: 'node.restore', payload: {
      nodeUid: U.nodeOld, displayId: 'node-old', nodeType: 'text', position: { x: 1, y: 2 }, data: {},
      expectedTombstoneRevision: 4,
    } },
    { opId: U.op2, type: 'edge.restore', payload: {
      edgeUid: U.edge, displayId: 'edge-a-b', sourceNodeUid: U.nodeA, targetNodeUid: U.nodeB,
      sourceHandle: null, targetHandle: null, edgeType: 'default', data: {}, expectedTombstoneRevision: 4,
    } },
  ]), deleted);
  assert.deepEqual(adapted.resultingDocument.nodes.find((node) => node.id === 'node-old').legacyAliases, ['node-very-old']);
  assert.deepEqual(adapted.resultingDocument.edges.find((edge) => edge.id === 'edge-a-b').legacyAliases, ['edge-old']);

  assert.throws(() => applyCanvasOperation(deleted, {
    opId: U.op1,
    projectId: deleted.projectId,
    canvasId: deleted.canvasId,
    actorId: 'member-a',
    sessionId: 'session-a',
    baseRevision: deleted.revision,
    clientSeq: 1,
    timestamp: 100,
    type: 'node.restore',
    payload: { node: {
      id: 'node-old', entityUid: U.nodeOld, legacyAliases: ['forged-alias'],
      type: 'text', position: { x: 1, y: 2 }, data: {},
    } },
  }), /legacyAliases 与删除记录不一致/);
});
