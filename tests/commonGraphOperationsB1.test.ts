import assert from 'node:assert/strict';
import test from 'node:test';

import type { VersionedCanvasData } from '../src/types/project.ts';
import { buildCommonGraphBatch } from '../src/utils/commonGraphOperations.ts';
import { acceptCommonCollaborationMutationResult } from '../src/utils/collaborationSync.ts';

const U = {
  canvas: '70000000-0000-4000-8000-000000000001',
  nodeA: '70000000-0000-4000-8000-000000000002',
  nodeB: '70000000-0000-4000-8000-000000000003',
  edge: '70000000-0000-4000-8000-000000000004',
  batch: '70000000-0000-4000-8000-000000000005',
  client: '70000000-0000-4000-8000-000000000006',
  op1: '70000000-0000-4000-8000-000000000007',
  op2: '70000000-0000-4000-8000-000000000008',
  op3: '70000000-0000-4000-8000-000000000009',
  op4: '70000000-0000-4000-8000-000000000010',
};

function document(): VersionedCanvasData {
  return {
    schema: 't8-canvas-document', schemaVersion: 2, projectId: 'project-display', canvasId: 'canvas-display',
    entityUid: U.canvas, revision: 4, updatedAt: 1, viewportRevision: 2,
    nodes: [{ id: 'node-a', entityUid: U.nodeA, entityRevision: 3, type: 'text', position: { x: 0, y: 0 }, data: { label: 'A', keep: true } }],
    edges: [], viewport: { x: 0, y: 0, zoom: 1 }, subflowInstances: [],
    tombstones: { nodes: {}, edges: {} },
  } as VersionedCanvasData;
}

test('B1 frontend builds UUID/CAS common operations from authoritative display-ID drafts', () => {
  const generated = [U.nodeB, U.edge];
  const common = buildCommonGraphBatch({
    document: document(), batchId: U.batch, clientId: U.client, clientSeq: 9,
    createEntityUid: () => generated.shift()!,
    drafts: [
      { opId: U.op1, type: 'node.patch', payload: { nodeId: 'node-a', dataPatch: { keep: false } } },
      { opId: U.op2, type: 'node.add', payload: { node: { id: 'node-b', type: 'output', position: { x: 10, y: 20 }, data: {} } } },
      { opId: U.op3, type: 'edge.add', payload: { edge: { id: 'edge-a-b', source: 'node-a', target: 'node-b', type: 'default' } } },
    ],
  });
  assert.equal(common.projectId, 'project-display');
  assert.equal(common.operations[0].payload.nodeUid, U.nodeA);
  assert.equal((common.operations[0].payload.fields as Record<string, unknown>).data && ((common.operations[0].payload.fields as any).data.keep), false);
  assert.equal(common.operations[1].payload.nodeUid, U.nodeB);
  assert.equal(common.operations[2].payload.edgeUid, U.edge);
  assert.equal(common.operations[2].payload.targetNodeUid, U.nodeB);
});

test('B1 frontend refuses missing entity revisions and never converts a tombstone into implicit add', () => {
  const stale = document();
  delete (stale.nodes[0] as Record<string, unknown>).entityRevision;
  assert.throws(() => buildCommonGraphBatch({
    document: stale, batchId: U.batch, clientId: U.client, clientSeq: 1,
    drafts: [{ opId: U.op1, type: 'node.delete', payload: { nodeId: 'node-a' } }],
  }), /entityRevision/);

  const deleted = document();
  deleted.nodes = [];
  deleted.tombstones.nodes['node-a'] = { entityUid: U.nodeA, revision: 4, entityType: 'text' };
  assert.throws(() => buildCommonGraphBatch({
    document: deleted, batchId: U.batch, clientId: U.client, clientSeq: 1,
    drafts: [{ opId: U.op1, type: 'node.add', payload: { node: { id: 'node-a', entityUid: U.nodeA, type: 'text', position: { x: 0, y: 0 }, data: {} } } }],
  }), /已存在或已删除/);
});

test('B1 frontend shadow state blocks same-batch node/edge resurrection and advances viewport CAS', () => {
  const lifecycleConflict = document();
  lifecycleConflict.tombstones.nodes['node-a'] = { entityUid: U.nodeA, revision: 4, entityType: 'text' };
  assert.throws(() => buildCommonGraphBatch({
    document: lifecycleConflict, batchId: U.batch, clientId: U.client, clientSeq: 1,
    drafts: [{ opId: U.op1, type: 'viewport.set', payload: { viewport: { x: 1, y: 1, zoom: 1 } } }],
  }), /活动实体与 tombstone 身份冲突/);

  assert.throws(() => buildCommonGraphBatch({
    document: document(), batchId: U.batch, clientId: U.client, clientSeq: 1,
    drafts: [
      { opId: U.op1, type: 'node.delete', payload: { nodeId: 'node-a' } },
      { opId: U.op2, type: 'node.add', payload: {
        node: { id: 'node-a', entityUid: U.nodeA, type: 'text', position: { x: 0, y: 0 }, data: {} },
      } },
    ],
  }), /已存在或已删除/);

  const withEdge = document();
  withEdge.nodes.push({
    id: 'node-b', entityUid: U.nodeB, entityRevision: 4, type: 'output', position: { x: 10, y: 10 }, data: {},
  });
  withEdge.edges = [{
    id: 'edge-a-b', entityUid: U.edge, entityRevision: 4,
    source: 'node-a', target: 'node-b', sourceEntityUid: U.nodeA, targetEntityUid: U.nodeB,
  }];
  assert.throws(() => buildCommonGraphBatch({
    document: withEdge, batchId: U.batch, clientId: U.client, clientSeq: 1,
    drafts: [
      { opId: U.op1, type: 'edge.delete', payload: { edgeId: 'edge-a-b' } },
      { opId: U.op2, type: 'edge.add', payload: {
        edge: { id: 'edge-a-b', entityUid: U.edge, source: 'node-a', target: 'node-b', type: 'default' },
      } },
    ],
  }), /已存在或已删除/);

  assert.throws(() => buildCommonGraphBatch({
    document: document(), batchId: U.batch, clientId: U.client, clientSeq: 1,
    drafts: [
      { opId: U.op1, type: 'viewport.set', payload: { viewport: { x: 1, y: 1, zoom: 1 } } },
      { opId: U.op2, type: 'viewport.set', payload: { viewport: { x: 2, y: 2, zoom: 1 } } },
    ],
  }), /baseRevision/);
});

test('B1 frontend restore shadow preserves tombstone aliases for later endpoint resolution in the same batch', () => {
  const deleted = document();
  deleted.tombstones.nodes['node-b'] = {
    entityUid: U.nodeB, revision: 4, entityType: 'output', legacyAliases: ['node-b-old'],
  };
  deleted.tombstones.edges['edge-a-b'] = {
    entityUid: U.edge, revision: 4, entityType: 'default', legacyAliases: ['edge-a-b-old'],
    source: 'node-a', target: 'node-b', sourceEntityUid: U.nodeA, targetEntityUid: U.nodeB,
  };
  const common = buildCommonGraphBatch({
    document: deleted,
    batchId: U.batch,
    clientId: U.client,
    clientSeq: 14,
    drafts: [
      { opId: U.op1, type: 'node.restore', payload: {
        node: { id: 'node-b', entityUid: U.nodeB, type: 'output', position: { x: 10, y: 20 }, data: {} },
      } },
      { opId: U.op2, type: 'edge.restore', payload: {
        edge: { id: 'edge-a-b', entityUid: U.edge, source: 'node-a', target: 'node-b-old', type: 'default' },
      } },
    ],
  });
  assert.equal(common.operations[1].payload.targetNodeUid, U.nodeB);
  assert.equal(common.operations[1].payload.edgeUid, U.edge);
});

test('B1 frontend accepts only an exact echoed common batch and ordered authority ACK', () => {
  const initial = document();
  const common = buildCommonGraphBatch({
    document: initial, batchId: U.batch, clientId: U.client, clientSeq: 12,
    drafts: [{ opId: U.op1, type: 'node.move', payload: { nodeId: 'node-a', position: { x: 11, y: 12 } } }],
  });
  const resultDocument = document();
  resultDocument.revision = 5;
  resultDocument.nodes[0] = { ...resultDocument.nodes[0], position: { x: 11, y: 12 }, entityRevision: 5 };
  const acknowledgement = {
    opId: U.op1, projectId: initial.projectId, canvasId: initial.canvasId,
    baseRevision: 4, revision: 5, actorId: 'member-a', clientSeq: 12,
    type: 'node.move', payload: { nodeId: 'node-a', position: { x: 11, y: 12 } },
    timestamp: 100, duplicate: false,
  };
  const accepted = acceptCommonCollaborationMutationResult({
    document: resultDocument, acknowledgements: [acknowledgement], commonBatch: common,
  }, common, { projectId: initial.projectId, canvasId: initial.canvasId, memberId: 'member-a' });
  assert.equal(accepted.document.revision, 5);

  const changedEcho = structuredClone(common);
  (changedEcho.operations[0].payload.position as { x: number }).x = 99;
  assert.throws(() => acceptCommonCollaborationMutationResult({
    document: resultDocument, acknowledgements: [acknowledgement], commonBatch: changedEcho,
  }, common, { projectId: initial.projectId, canvasId: initial.canvasId, memberId: 'member-a' }), /精确回显/);
});
