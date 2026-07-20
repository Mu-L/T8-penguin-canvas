const assert = require('node:assert/strict');
const test = require('node:test');

const { COMMON_OPERATION_BATCH_CONTRACT } = require('../backend/src/collaboration/commonOperationProtocol');
const { OperationBatchConflictError, ProjectDatabase } = require('../backend/src/services/projectDatabase');

const U = {
  canvas: '80000000-0000-4000-8000-000000000001',
  batch: '80000000-0000-4000-8000-000000000002',
  client: '80000000-0000-4000-8000-000000000003',
  thread: '80000000-0000-4000-8000-000000000004',
  comment1: '80000000-0000-4000-8000-000000000005',
  comment2: '80000000-0000-4000-8000-000000000006',
  op1: '80000000-0000-4000-8000-000000000007',
  op2: '80000000-0000-4000-8000-000000000008',
  op3: '80000000-0000-4000-8000-000000000009',
  legacyThreadId: '80000000-0000-4000-8000-000000000010',
  legacyThreadUid: '80000000-0000-4000-8000-000000000011',
  legacyCommentId: '80000000-0000-4000-8000-000000000012',
  legacyCommentUid: '80000000-0000-4000-8000-000000000013',
  legacyReplyUid: '80000000-0000-4000-8000-000000000014',
  legacyBatch: '80000000-0000-4000-8000-000000000015',
  legacyClient: '80000000-0000-4000-8000-000000000016',
  legacyOp1: '80000000-0000-4000-8000-000000000017',
  legacyOp2: '80000000-0000-4000-8000-000000000018',
};

function batch() {
  return {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: 'project-review-b1', canvasId: 'canvas-review-b1', baseRevision: 1,
    batchId: U.batch, clientId: U.client, clientSeq: 1,
    operations: [
      { opId: U.op1, type: 'review.thread.create', payload: {
        threadUid: U.thread, expectedCanvasRevision: 1,
        anchor: { kind: 'canvas', x: 10, y: 20 }, severity: 'high',
        initialComment: { commentUid: U.comment1, body: '初始审片意见' },
      } },
      { opId: U.op2, type: 'review.comment.add', payload: {
        threadUid: U.thread, commentUid: U.comment2, parentCommentUid: U.comment1,
        expectedCanvasRevision: 1, expectedThreadRevision: 1, body: '补充说明',
      } },
      { opId: U.op3, type: 'review.thread.update', payload: {
        threadUid: U.thread, expectedCanvasRevision: 1, expectedThreadRevision: 2,
        status: 'approved', severity: 'normal', decisionCanvasRevision: 1,
      } },
    ],
  };
}

test('B1 review common batch applies create/comment/decision sequentially in one exact transaction', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    database.ensureCanvas('canvas-review-b1', {
      projectId: 'project-review-b1', entityUid: U.canvas,
      nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    }, 'project-review-b1');
    const principal = {
      memberId: 'reviewer-b1', sessionId: 'session-review-b1', capabilities: ['comment', 'approve'],
    };
    const applied = database.applyCommonReviewBatch(batch(), { principal });
    assert.equal(applied.duplicate, false);
    assert.equal(applied.document.revision, 1, 'review domain does not forge a graph revision');
    const thread = database.getReviewThread(U.thread);
    assert.equal(thread.revision, 3);
    assert.equal(thread.status, 'approved');
    assert.equal(thread.decisionCanvasRevision, 1);
    assert.deepEqual(database.listReviewComments(U.thread).map((comment) => comment.entityUid), [U.comment1, U.comment2]);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_common_operation_batches').get().count, 1);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_domain_operation_idempotency').get().count, 3);
    assert.equal(database.listAuditEvents({ projectId: 'project-review-b1' }).length, 3);

    const replay = database.replayCommonDomainBatch(batch(), {
      actorId: principal.memberId, sessionId: principal.sessionId,
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.results.length, 3);
    assert.equal(database.listReviewComments(U.thread).length, 2);

    const collision = structuredClone(batch());
    collision.operations[1].payload.body = '篡改后的补充说明';
    assert.throws(() => database.replayCommonDomainBatch(collision, {
      actorId: principal.memberId, sessionId: principal.sessionId,
    }), (error) => error instanceof OperationBatchConflictError);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});

test('B1 review thread/comment CAS and parent scope fail without partial rows', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    database.ensureCanvas('canvas-review-b1', { projectId: 'project-review-b1', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, 'project-review-b1');
    const invalid = batch();
    invalid.operations[1].payload.expectedThreadRevision = 2;
    assert.throws(() => database.applyCommonReviewBatch(invalid, {
      principal: { memberId: 'reviewer-b1', sessionId: 'session-review-b1', capabilities: ['comment', 'approve'] },
    }), /CAS|版本|冲突/);
    assert.equal(database.listReviewThreads({ projectId: 'project-review-b1' }).length, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_common_operation_batches').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_domain_operation_idempotency').get().count, 0);
  } finally {
    database.close();
  }
});

test('B1 common review resolves stable UIDs onto distinct legacy thread/comment primary keys', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    database.ensureCanvas('canvas-review-b1', {
      projectId: 'project-review-b1', entityUid: U.canvas,
      nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    }, 'project-review-b1');
    const thread = database.createReviewThread({
      id: U.legacyThreadId,
      entityUid: U.legacyThreadUid,
      projectId: 'project-review-b1',
      canvasId: 'canvas-review-b1',
      canvasRevision: 1,
      anchor: { kind: 'canvas', targetEntityUid: U.canvas, x: 0, y: 0 },
      createdBy: 'legacy-reviewer',
    });
    database.createReviewComment({
      id: U.legacyCommentId,
      entityUid: U.legacyCommentUid,
      threadId: thread.id,
      body: '旧主键首评',
      createdBy: 'legacy-reviewer',
    });
    const legacyBatch = {
      contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
      projectId: 'project-review-b1', canvasId: 'canvas-review-b1', baseRevision: 1,
      batchId: U.legacyBatch, clientId: U.legacyClient, clientSeq: 2,
      operations: [
        { opId: U.legacyOp1, type: 'review.comment.add', payload: {
          threadUid: U.legacyThreadUid,
          commentUid: U.legacyReplyUid,
          parentCommentUid: U.legacyCommentUid,
          expectedCanvasRevision: 1,
          expectedThreadRevision: 1,
          body: '稳定 UID 回复旧主键',
        } },
        { opId: U.legacyOp2, type: 'review.thread.update', payload: {
          threadUid: U.legacyThreadUid,
          expectedCanvasRevision: 1,
          expectedThreadRevision: 2,
          status: 'resolved', severity: 'normal', decisionCanvasRevision: null,
        } },
      ],
    };
    const applied = database.applyCommonReviewBatch(legacyBatch, {
      principal: { memberId: 'reviewer-b1', sessionId: 'legacy-session', capabilities: ['comment'] },
    });
    assert.equal(applied.results[0].threadRevision, 2);
    assert.equal(database.getReviewThread(U.legacyThreadUid).id, U.legacyThreadId);
    assert.equal(database.getReviewThread(U.legacyThreadId).revision, 3);
    const reply = database.listReviewComments(U.legacyThreadUid)
      .find((comment) => comment.entityUid === U.legacyReplyUid);
    assert.equal(reply.threadId, U.legacyThreadId);
    assert.equal(reply.parentId, U.legacyCommentId);
    assert.equal(reply.parentEntityUid, U.legacyCommentUid);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});
