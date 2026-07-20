const assert = require('node:assert/strict');
const test = require('node:test');

const {
  COMMON_OPERATION_BATCH_CONTRACT,
} = require('../backend/src/collaboration/commonOperationProtocol');
const {
  createFixture,
  redeemActor,
  requestJson,
} = require('./helpers/collaborationF2Fixture.cjs');

const PRIVATE_API_KEY = 'sk-proj-B1ReviewGatewaySyntheticSecret';
const PRIVATE_LOCAL_PATH = 'C:\\Users\\Administrator\\private-review-gateway.txt';

const IDS = Object.freeze({
  accepted: Object.freeze({
    batch: '81000000-0000-4000-8000-000000000001',
    client: '81000000-0000-4000-8000-000000000002',
    thread: '81000000-0000-4000-8000-000000000003',
    initialComment: '81000000-0000-4000-8000-000000000004',
    replyComment: '81000000-0000-4000-8000-000000000005',
    createOp: '81000000-0000-4000-8000-000000000006',
    replyOp: '81000000-0000-4000-8000-000000000007',
    approveOp: '81000000-0000-4000-8000-000000000008',
  }),
  forbidden: Object.freeze({
    batch: '82000000-0000-4000-8000-000000000001',
    client: '82000000-0000-4000-8000-000000000002',
    thread: '82000000-0000-4000-8000-000000000003',
    initialComment: '82000000-0000-4000-8000-000000000004',
    replyComment: '82000000-0000-4000-8000-000000000005',
    createOp: '82000000-0000-4000-8000-000000000006',
    replyOp: '82000000-0000-4000-8000-000000000007',
    approveOp: '82000000-0000-4000-8000-000000000008',
  }),
  commentReplay: Object.freeze({
    batch: '83000000-0000-4000-8000-000000000001',
    client: '83000000-0000-4000-8000-000000000002',
    thread: '83000000-0000-4000-8000-000000000003',
    initialComment: '83000000-0000-4000-8000-000000000004',
    createOp: '83000000-0000-4000-8000-000000000005',
  }),
});

function reviewBatch(fixture, identities, baseRevision) {
  return {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    baseRevision,
    batchId: identities.batch,
    clientId: identities.client,
    clientSeq: 1,
    operations: [
      {
        opId: identities.createOp,
        type: 'review.thread.create',
        payload: {
          threadUid: identities.thread,
          expectedCanvasRevision: baseRevision,
          anchor: { kind: 'canvas', x: 32, y: 48 },
          severity: 'high',
          initialComment: {
            commentUid: identities.initialComment,
            body: '请复核这一版画布',
          },
        },
      },
      {
        opId: identities.replyOp,
        type: 'review.comment.add',
        payload: {
          threadUid: identities.thread,
          commentUid: identities.replyComment,
          parentCommentUid: identities.initialComment,
          expectedCanvasRevision: baseRevision,
          expectedThreadRevision: 1,
          body: '复核完成，可以审批',
        },
      },
      {
        opId: identities.approveOp,
        type: 'review.thread.update',
        payload: {
          threadUid: identities.thread,
          expectedCanvasRevision: baseRevision,
          expectedThreadRevision: 2,
          status: 'approved',
          severity: 'normal',
          decisionCanvasRevision: baseRevision,
        },
      },
    ],
  };
}

function createOnlyReviewBatch(fixture, identities, baseRevision) {
  return {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    baseRevision,
    batchId: identities.batch,
    clientId: identities.client,
    clientSeq: 2,
    operations: [{
      opId: identities.createOp,
      type: 'review.thread.create',
      payload: {
        threadUid: identities.thread,
        expectedCanvasRevision: baseRevision,
        anchor: { kind: 'canvas', x: 8, y: 16 },
        severity: 'normal',
        initialComment: {
          commentUid: identities.initialComment,
          body: '仅评论权限的精确重放',
        },
      },
    }],
  };
}

async function postCommonOperations(fixture, actor, batch) {
  return requestJson(`${fixture.baseUrl}/api/collab/common-operations`, {
    method: 'POST',
    headers: {
      cookie: actor.cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify(batch),
  });
}

function domainTableCounts(database) {
  return {
    threads: database.db.prepare('SELECT COUNT(*) AS count FROM review_threads').get().count,
    comments: database.db.prepare('SELECT COUNT(*) AS count FROM review_comments').get().count,
    commonBatches: database.db.prepare(
      'SELECT COUNT(*) AS count FROM collaboration_common_operation_batches',
    ).get().count,
    domainOperations: database.db.prepare(
      'SELECT COUNT(*) AS count FROM collaboration_domain_operation_idempotency',
    ).get().count,
    canvasOperations: database.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations').get().count,
    audits: database.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count,
  };
}

test('B1 common review gateway atomically creates, replies, approves, replays and rejects collisions/permission escalation', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-common-review-gateway',
    canvasId: 'canvas-common-review-gateway',
    snapshot: {
      name: 'Common review gateway canvas',
      nodes: [{
        id: 'node-private',
        type: 'text',
        position: { x: 0, y: 0 },
        data: {
          text: 'public text',
          apiKey: PRIVATE_API_KEY,
          localPath: PRIVATE_LOCAL_PATH,
        },
      }],
      edges: [],
    },
  });
  const reviewer = await redeemActor(fixture, 'reviewer', 'B1 gateway reviewer');
  const initialDocument = fixture.database.getCanvas(fixture.canvasId);
  const initialRevision = initialDocument.revision;
  assert.equal(initialDocument.nodes[0].data.apiKey, PRIVATE_API_KEY, 'redaction test requires private source data');

  const acceptedBatch = reviewBatch(fixture, IDS.accepted, initialRevision);
  const applied = await postCommonOperations(fixture, reviewer, acceptedBatch);
  assert.equal(applied.response.status, 200, JSON.stringify(applied.payload));
  assert.equal(applied.payload.success, true);
  assert.equal(applied.payload.data.duplicate, false);
  assert.deepEqual(applied.payload.data.commonBatch, acceptedBatch, 'gateway must echo the normalized common envelope');
  assert.equal(applied.payload.data.document.revision, initialRevision);
  assert.equal(
    fixture.database.getCanvas(fixture.canvasId).revision,
    initialRevision,
    'review writes must not forge a graph revision',
  );
  assert.equal(applied.payload.data.results.length, 3);
  assert.equal(applied.payload.data.results[0].thread.revision, 1);
  assert.equal(applied.payload.data.results[0].thread.comments.length, 1);
  assert.equal(applied.payload.data.results[1].threadRevision, 2);
  assert.equal(applied.payload.data.results[2].thread.revision, 3);
  assert.equal(applied.payload.data.results[2].thread.status, 'approved');
  assert.equal(applied.payload.data.results[2].thread.decisionCanvasRevision, initialRevision);

  const publicResponseText = applied.text;
  assert.equal(publicResponseText.includes(PRIVATE_API_KEY), false, 'public response leaked a host API key');
  assert.equal(publicResponseText.includes(PRIVATE_LOCAL_PATH), false, 'public response leaked a host path');
  assert.equal(publicResponseText.includes(reviewer.cookie), false, 'public response leaked a session cookie');
  assert.equal(Object.hasOwn(applied.payload.data.document.nodes[0].data, 'apiKey'), false);
  assert.equal(Object.hasOwn(applied.payload.data.document.nodes[0].data, 'localPath'), false);

  const thread = fixture.database.getReviewThread(IDS.accepted.thread);
  assert.equal(thread.entityUid, IDS.accepted.thread);
  assert.equal(thread.canvasRevision, initialRevision);
  assert.equal(thread.revision, 3);
  assert.equal(thread.status, 'approved');
  assert.equal(thread.severity, 'normal');
  assert.equal(thread.decisionCanvasRevision, initialRevision);
  const comments = fixture.database.listReviewComments(IDS.accepted.thread);
  assert.deepEqual(comments.map((comment) => comment.entityUid), [
    IDS.accepted.initialComment,
    IDS.accepted.replyComment,
  ]);
  assert.equal(comments[0].parentId, null);
  assert.equal(comments[1].parentId, IDS.accepted.initialComment);
  assert.ok(comments.every((comment) => comment.createdBy === reviewer.memberId));

  const commonLedger = fixture.database.db.prepare(`
    SELECT * FROM collaboration_common_operation_batches WHERE batch_id = ?
  `).get(IDS.accepted.batch);
  assert.equal(commonLedger.project_id, fixture.projectId);
  assert.equal(commonLedger.canvas_id, fixture.canvasId);
  assert.equal(commonLedger.base_revision, initialRevision);
  assert.equal(commonLedger.first_revision, initialRevision);
  assert.equal(commonLedger.last_revision, initialRevision);
  assert.equal(commonLedger.actor_id, reviewer.memberId);
  assert.equal(commonLedger.session_id, reviewer.id);
  assert.match(commonLedger.request_digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(commonLedger.operation_ids_json), [
    IDS.accepted.createOp,
    IDS.accepted.replyOp,
    IDS.accepted.approveOp,
  ]);

  const domainLedger = fixture.database.db.prepare(`
    SELECT op_id, operation_index, type, actor_id, session_id
    FROM collaboration_domain_operation_idempotency
    WHERE batch_id = ? ORDER BY operation_index ASC
  `).all(IDS.accepted.batch);
  assert.deepEqual(domainLedger, [
    {
      op_id: IDS.accepted.createOp,
      operation_index: 0,
      type: 'review.thread.create',
      actor_id: reviewer.memberId,
      session_id: reviewer.id,
    },
    {
      op_id: IDS.accepted.replyOp,
      operation_index: 1,
      type: 'review.comment.add',
      actor_id: reviewer.memberId,
      session_id: reviewer.id,
    },
    {
      op_id: IDS.accepted.approveOp,
      operation_index: 2,
      type: 'review.thread.update',
      actor_id: reviewer.memberId,
      session_id: reviewer.id,
    },
  ]);

  const reviewAudits = fixture.database.listAuditEvents({
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    limit: 1000,
  }).filter((event) => event.metadata.batchId === IDS.accepted.batch);
  assert.equal(reviewAudits.length, 3);
  assert.deepEqual(new Set(reviewAudits.map((event) => event.action)), new Set([
    'review.thread.create',
    'review.comment.add',
    'review.thread.update',
  ]));
  assert.ok(reviewAudits.every((event) => (
    event.actorId === reviewer.memberId
      && event.sessionId === reviewer.id
      && acceptedBatch.operations.some((operation) => operation.opId === event.metadata.opId)
  )));

  const replay = await postCommonOperations(fixture, reviewer, acceptedBatch);
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.payload.data.duplicate, true);
  assert.deepEqual(replay.payload.data.commonBatch, applied.payload.data.commonBatch);
  assert.deepEqual(replay.payload.data.results, applied.payload.data.results);
  assert.deepEqual(replay.payload.data.document, applied.payload.data.document);
  assert.equal(fixture.database.listReviewComments(IDS.accepted.thread).length, 2);

  const beforeCollision = domainTableCounts(fixture.database);
  const collision = structuredClone(acceptedBatch);
  collision.operations[1].payload.body = '碰撞请求不得改写回复';
  const rejectedCollision = await postCommonOperations(fixture, reviewer, collision);
  assert.equal(rejectedCollision.response.status, 409, JSON.stringify(rejectedCollision.payload));
  assert.equal(rejectedCollision.payload.code, 'operation_batch_conflict');
  assert.deepEqual(domainTableCounts(fixture.database), beforeCollision);
  assert.equal(
    fixture.database.listReviewComments(IDS.accepted.thread)[1].body,
    acceptedBatch.operations[1].payload.body,
  );

  const editor = await redeemActor(fixture, 'editor', 'B1 no-approve editor');
  assert.equal(editor.capabilities.includes('comment'), true);
  assert.equal(editor.capabilities.includes('approve'), false);
  const beforeForbidden = domainTableCounts(fixture.database);
  const forbiddenBatch = reviewBatch(fixture, IDS.forbidden, initialRevision);
  const rejectedPermission = await postCommonOperations(fixture, editor, forbiddenBatch);
  assert.equal(rejectedPermission.response.status, 403, JSON.stringify(rejectedPermission.payload));
  assert.equal(rejectedPermission.payload.code, 'collaboration_domain_capability_missing');
  assert.deepEqual(
    domainTableCounts(fixture.database),
    beforeForbidden,
    'create/reply writes must roll back when the same batch later attempts unauthorized approval',
  );
  assert.equal(fixture.database.getReviewThread(IDS.forbidden.thread), null);

  const commentReviewer = await redeemActor(fixture, 'reviewer', 'B1 comment replay reviewer');
  const commentReplayBatch = createOnlyReviewBatch(
    fixture,
    IDS.commentReplay,
    initialRevision,
  );
  const appliedCommentBatch = await postCommonOperations(
    fixture,
    commentReviewer,
    commentReplayBatch,
  );
  assert.equal(appliedCommentBatch.response.status, 200, JSON.stringify(appliedCommentBatch.payload));
  assert.equal(appliedCommentBatch.payload.data.duplicate, false);
  const unchangedCommentReplay = await postCommonOperations(
    fixture,
    commentReviewer,
    commentReplayBatch,
  );
  assert.equal(unchangedCommentReplay.response.status, 200, JSON.stringify(unchangedCommentReplay.payload));
  assert.equal(unchangedCommentReplay.payload.data.duplicate, true);

  const downgradedCommentReviewer = fixture.gateway.auth.updateMember(
    commentReviewer.memberId,
    { role: 'viewer' },
    {
      actorId: 'local-owner',
      sessionId: 'local-management',
      expectedProjectId: fixture.projectId,
      expectedCanvasId: fixture.canvasId,
    },
  );
  assert.equal(downgradedCommentReviewer.role, 'viewer');
  assert.deepEqual(downgradedCommentReviewer.capabilities, []);
  const beforeCommentReplayDenied = domainTableCounts(fixture.database);
  const deniedCommentReplay = await postCommonOperations(
    fixture,
    commentReviewer,
    commentReplayBatch,
  );
  assert.equal(deniedCommentReplay.response.status, 403, JSON.stringify(deniedCommentReplay.payload));
  assert.equal(deniedCommentReplay.payload.code, 'collaboration_domain_capability_missing');
  assert.deepEqual(domainTableCounts(fixture.database), beforeCommentReplayDenied);

  const downgradedDecisionReviewer = fixture.gateway.auth.updateMember(
    reviewer.memberId,
    { role: 'editor' },
    {
      actorId: 'local-owner',
      sessionId: 'local-management',
      expectedProjectId: fixture.projectId,
      expectedCanvasId: fixture.canvasId,
    },
  );
  assert.equal(downgradedDecisionReviewer.capabilities.includes('comment'), true);
  assert.equal(downgradedDecisionReviewer.capabilities.includes('approve'), false);
  const beforeDecisionReplayDenied = domainTableCounts(fixture.database);
  const deniedDecisionReplay = await postCommonOperations(fixture, reviewer, acceptedBatch);
  assert.equal(deniedDecisionReplay.response.status, 403, JSON.stringify(deniedDecisionReplay.payload));
  assert.equal(deniedDecisionReplay.payload.code, 'collaboration_domain_capability_missing');
  assert.deepEqual(domainTableCounts(fixture.database), beforeDecisionReplayDenied);

  assert.equal(fixture.database.getCanvas(fixture.canvasId).revision, initialRevision);
  assert.equal(fixture.database.db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(fixture.database.db.pragma('foreign_key_check'), []);
});
