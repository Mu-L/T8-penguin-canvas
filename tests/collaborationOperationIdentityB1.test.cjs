const assert = require('node:assert/strict');
const test = require('node:test');

const { COMMON_OPERATION_BATCH_CONTRACT } = require('../backend/src/collaboration/commonOperationProtocol');
const {
  OperationBatchConflictError,
  OperationIdConflictError,
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');

const U = Object.freeze({
  canvas: '91000000-0000-4000-8000-000000000001',
  node: '91000000-0000-4000-8000-000000000002',
  graphOp: '91000000-0000-4000-8000-000000000003',
  reviewOp: '91000000-0000-4000-8000-000000000004',
  thread: '91000000-0000-4000-8000-000000000005',
  comment: '91000000-0000-4000-8000-000000000006',
  batch: '91000000-0000-4000-8000-000000000007',
  batch2: '91000000-0000-4000-8000-000000000008',
  client: '91000000-0000-4000-8000-000000000009',
  client2: '91000000-0000-4000-8000-00000000000a',
  hostOp: '91000000-0000-4000-8000-00000000000b',
  hostBatch: '91000000-0000-4000-8000-00000000000c',
});

function createDatabase() {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  database.ensureCanvas('canvas-operation-identity', {
    projectId: 'project-operation-identity',
    entityUid: U.canvas,
    nodes: [{
      id: 'node-a',
      entityUid: U.node,
      entityRevision: 1,
      type: 'text',
      position: { x: 0, y: 0 },
      data: {},
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }, 'project-operation-identity');
  return database;
}

function move(database, opId, x) {
  const document = database.getCanvas('canvas-operation-identity');
  return database.applyOperations(document.canvasId, [{
    opId,
    projectId: document.projectId,
    canvasId: document.canvasId,
    actorId: 'editor-operation-identity',
    sessionId: 'session-operation-identity',
    baseRevision: document.revision,
    clientSeq: document.revision,
    timestamp: 1_900_000_000_000 + document.revision,
    type: 'node.move',
    payload: { nodeId: 'node-a', position: { x, y: 0 } },
  }], { expectedRevision: document.revision });
}

function reviewBatch(database, opId, ids = {}) {
  const document = database.getCanvas('canvas-operation-identity');
  return {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: document.projectId,
    canvasId: document.canvasId,
    baseRevision: document.revision,
    batchId: ids.batchId || U.batch,
    clientId: ids.clientId || U.client,
    clientSeq: ids.clientSeq || 1,
    operations: [{
      opId,
      type: 'review.thread.create',
      payload: {
        threadUid: ids.threadUid || U.thread,
        expectedCanvasRevision: document.revision,
        anchor: { kind: 'canvas', x: 0, y: 0 },
        severity: 'normal',
        initialComment: { commentUid: ids.commentUid || U.comment, body: '全局 operation 身份测试' },
      },
    }],
  };
}

const principal = {
  memberId: 'reviewer-operation-identity',
  sessionId: 'review-session-operation-identity',
  capabilities: ['comment'],
};

test('B1 global operation registry rejects graph -> review and review -> graph UUID reuse atomically', () => {
  const database = createDatabase();
  try {
    move(database, U.graphOp, 10);
    const graphIdentity = database.getCollaborationOperationIdentity(U.graphOp);
    assert.equal(graphIdentity.domain, 'canvas');
    assert.equal(graphIdentity.type, 'node.move');

    assert.throws(
      () => database.applyCommonReviewBatch(reviewBatch(database, U.graphOp), { principal }),
      (error) => error instanceof OperationBatchConflictError,
    );
    assert.equal(database.listReviewThreads({ projectId: 'project-operation-identity' }).length, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_domain_operation_idempotency').get().count, 0);

    database.applyCommonReviewBatch(reviewBatch(database, U.reviewOp, {
      batchId: U.batch2,
      clientId: U.client2,
      clientSeq: 2,
      threadUid: '91000000-0000-4000-8000-00000000000d',
      commentUid: '91000000-0000-4000-8000-00000000000e',
    }), { principal });
    const reviewIdentity = database.getCollaborationOperationIdentity(U.reviewOp);
    assert.equal(reviewIdentity.domain, 'review');
    assert.equal(reviewIdentity.type, 'review.thread.create');

    const before = database.getCanvas('canvas-operation-identity');
    assert.throws(() => move(database, U.reviewOp, 20), (error) => error instanceof OperationIdConflictError);
    assert.deepEqual(database.getCanvas('canvas-operation-identity'), before);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});

test('B1 domain ledgers require a matching immutable global identity reservation', () => {
  const database = createDatabase();
  try {
    assert.throws(() => database.db.prepare(`
      INSERT INTO collaboration_domain_operation_idempotency(
        op_id, batch_id, operation_index, project_id, canvas_id, type,
        payload_digest, actor_id, session_id, result_json, created_at
      ) VALUES (?, ?, 0, ?, ?, 'host.artifact.commit', ?, 'host-executor', 'host-authority', '{}', ?)
    `).run(
      U.hostOp,
      U.hostBatch,
      'project-operation-identity',
      'canvas-operation-identity',
      '0'.repeat(64),
      Date.now(),
    ), /global identity missing|FOREIGN KEY/);

    const fakeBatch = {
      projectId: 'project-operation-identity',
      canvasId: 'canvas-operation-identity',
      batchId: U.hostBatch,
      operations: [{
        opId: U.hostOp,
        type: 'host.artifact.commit',
        payload: { identityOnly: true },
      }],
    };
    database.reserveCommonOperationIdentities(fakeBatch, 'host-artifact', database.getCanvas(fakeBatch.canvasId));
    assert.equal(database.getCollaborationOperationIdentity(U.hostOp).domain, 'host-artifact');
    assert.throws(() => database.db.prepare(`
      UPDATE collaboration_operation_identities SET domain = 'review' WHERE op_id = ?
    `).run(U.hostOp), /immutable/);
  } finally {
    database.close();
  }
});
