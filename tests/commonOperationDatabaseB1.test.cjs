const assert = require('node:assert/strict');
const test = require('node:test');

const { COMMON_OPERATION_BATCH_CONTRACT } = require('../backend/src/collaboration/commonOperationProtocol');
const { adaptCommonGraphBatch } = require('../backend/src/collaboration/commonOperationAdapter');
const { OperationBatchConflictError, ProjectDatabase } = require('../backend/src/services/projectDatabase');

const IDS = {
  batch: '50000000-0000-4000-8000-000000000001',
  client: '50000000-0000-4000-8000-000000000002',
  op: '50000000-0000-4000-8000-000000000003',
  node: '50000000-0000-4000-8000-000000000004',
};

function request(x = 12) {
  return {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: 'project-common-db',
    canvasId: 'canvas-common-db',
    baseRevision: 1,
    batchId: IDS.batch,
    clientId: IDS.client,
    clientSeq: 1,
    operations: [{
      opId: IDS.op,
      type: 'node.move',
      payload: { nodeUid: IDS.node, expectedEntityRevision: 1, position: { x, y: 34 } },
    }],
  };
}

test('B1 common batch ledger atomically binds exact digest, client sequence, and operation revisions', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const initial = database.ensureCanvas('canvas-common-db', {
      projectId: 'project-common-db',
      nodes: [{ id: 'node-display', entityUid: IDS.node, type: 'text', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }, 'project-common-db');
    const commonBatch = request();
    const adapted = adaptCommonGraphBatch(commonBatch, initial, {
      actorId: 'member-common', sessionId: 'session-common', timestamp: 100,
    });
    const applied = database.applyOperations(initial.canvasId, adapted.operations, {
      expectedRevision: commonBatch.baseRevision,
      commonBatch,
      requireTimestampIdentity: false,
    });
    assert.equal(applied.document.revision, 2);
    assert.equal(applied.document.nodes[0].entityRevision, 2);
    assert.equal(applied.document.nodes[0].position.x, 12);

    const replay = database.replayCommonOperationBatch(commonBatch, {
      actorId: 'member-common', sessionId: 'session-common',
    });
    assert.equal(replay.document.revision, 2);
    assert.deepEqual(replay.acknowledgements.map((item) => [item.opId, item.revision, item.duplicate]), [[IDS.op, 2, true]]);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_common_operation_batches').get().count, 1);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations').get().count, 1);

    assert.throws(() => database.replayCommonOperationBatch(request(99), {
      actorId: 'member-common', sessionId: 'session-common',
    }), (error) => error instanceof OperationBatchConflictError);
    const clientCollision = { ...request(), batchId: '50000000-0000-4000-8000-000000000099' };
    assert.throws(() => database.replayCommonOperationBatch(clientCollision), (error) => error instanceof OperationBatchConflictError);
    assert.equal(database.getCanvas(initial.canvasId).nodes[0].position.x, 12);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});
