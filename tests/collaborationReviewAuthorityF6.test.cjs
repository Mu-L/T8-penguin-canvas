const assert = require('node:assert/strict');
const test = require('node:test');

const {
  authorizeCollaborationDomainOperation,
  authorizeReviewThreadCreate,
  authorizeReviewThreadUpdate,
} = require('../backend/src/services/collaborationDomainAuthority');

const ID = Object.freeze({
  op: '00000000-0000-4000-8000-000000000001',
  project: '10000000-0000-4000-8000-000000000001',
  canvas: '20000000-0000-4000-8000-000000000001',
  canvasEntity: '30000000-0000-4000-8000-000000000001',
  thread: '40000000-0000-4000-8000-000000000001',
  comment: '50000000-0000-4000-8000-000000000001',
  comment2: '50000000-0000-4000-8000-000000000002',
  video: '60000000-0000-4000-8000-000000000001',
  image: '60000000-0000-4000-8000-000000000002',
  actor: '70000000-0000-4000-8000-000000000001',
  memberA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  memberB: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  foreignMember: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  inactiveMember: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
  unknownMember: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
});

const VIDEO_HASH = 'a'.repeat(64);
const IMAGE_HASH = 'b'.repeat(64);

function operation(type, payload, overrides = {}) {
  return { opId: ID.op, type, payload, ...overrides };
}

function documentFixture(overrides = {}) {
  return {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: ID.project,
    canvasId: ID.canvas,
    entityUid: ID.canvasEntity,
    revision: 7,
    nodes: [],
    edges: [],
    tombstones: { nodes: {}, edges: {} },
    ...overrides,
  };
}

function threadFixture(overrides = {}) {
  return {
    id: ID.thread,
    entityUid: ID.thread,
    projectId: ID.project,
    canvasId: ID.canvas,
    canvasRevision: 7,
    revision: 3,
    status: 'open',
    severity: 'normal',
    createdBy: ID.actor,
    comments: [],
    ...overrides,
  };
}

function memberFixture(id, overrides = {}) {
  return {
    id,
    projectId: ID.project,
    canvasId: ID.canvas,
    role: 'reviewer',
    ...overrides,
  };
}

function authorityFixture(overrides = {}) {
  return {
    batch: {
      contractVersion: 't8-common-operation-batch-v1',
      projectId: ID.project,
      canvasId: ID.canvas,
      baseRevision: 7,
      batchId: '80000000-0000-4000-8000-000000000001',
      clientId: '90000000-0000-4000-8000-000000000001',
      clientSeq: 1,
    },
    document: documentFixture(),
    principal: {
      memberId: ID.actor,
      sessionId: 'session-authority-f6',
      capabilities: ['comment', 'approve'],
    },
    reviewThreads: [],
    reviewComments: [],
    reviewMembers: [
      memberFixture(ID.actor),
      memberFixture(ID.memberA),
      memberFixture(ID.memberB),
      memberFixture(ID.foreignMember, { projectId: 'foreign-project' }),
      memberFixture(ID.inactiveMember, { active: false }),
    ],
    assets: [
      {
        id: 'video-row',
        entityUid: ID.video,
        projectId: ID.project,
        kind: 'video',
        availability: 'available',
        revision: 3,
        organizationRevision: 999,
        contentRevision: 7,
        contentHash: VIDEO_HASH,
        metadata: { durationMs: 10_000 },
      },
      {
        id: 'image-row',
        entityUid: ID.image,
        projectId: ID.project,
        kind: 'image',
        availability: 'available',
        revision: 2,
        organizationRevision: 888,
        contentRevision: 5,
        contentHash: IMAGE_HASH,
        metadata: {},
      },
    ],
    allowedAssetEntityUids: new Set([ID.video, ID.image]),
    ...overrides,
  };
}

function threadUpdate(status, overrides = {}) {
  return operation('review.thread.update', {
    threadUid: ID.thread,
    expectedCanvasRevision: 7,
    expectedThreadRevision: 3,
    status,
    severity: 'normal',
    decisionCanvasRevision: ['approved', 'changes_requested'].includes(status) ? 7 : null,
    ...overrides,
  });
}

function threadCreate(anchor, initialComment = {}) {
  return operation('review.thread.create', {
    threadUid: ID.thread,
    expectedCanvasRevision: 7,
    anchor,
    severity: 'high',
    initialComment: {
      commentUid: ID.comment,
      body: '请复核当前产物',
      ...initialComment,
    },
  });
}

function commentAdd(overrides = {}) {
  return operation('review.comment.add', {
    threadUid: ID.thread,
    commentUid: ID.comment2,
    parentCommentUid: null,
    expectedCanvasRevision: 7,
    expectedThreadRevision: 3,
    body: '补充审片证据',
    ...overrides,
  });
}

function hasCode(code) {
  return (error) => error?.code === code;
}

test('F6 legacy status keeps resolution independent and cannot bypass lifecycle authority', () => {
  for (const [from, to] of [['open', 'resolved'], ['resolved', 'open']]) {
    const plan = authorizeReviewThreadUpdate(threadUpdate(to), authorityFixture({
      principal: { memberId: ID.actor, sessionId: 'comment-only', capabilities: ['comment'] },
      reviewThreads: [threadFixture({ status: from })],
    }));
    assert.equal(plan.result.thread.status, to);
    assert.deepEqual(plan.preconditions.map((item) => item.kind), [
      'canvas.revision.equals',
      'review.thread.revision.equals',
    ]);
  }

  for (const [from, to] of [['open', 'approved'], ['resolved', 'changes_requested']]) {
    assert.throws(
      () => authorizeReviewThreadUpdate(threadUpdate(to), authorityFixture({
        principal: { memberId: ID.actor, sessionId: 'comment-only', capabilities: ['comment'] },
        reviewThreads: [threadFixture({ status: from })],
      })),
      hasCode('collaboration_domain_capability_missing'),
      `${from} -> ${to} must require approve`,
    );
    const approved = authorizeReviewThreadUpdate(threadUpdate(to), authorityFixture({
      principal: { memberId: ID.actor, sessionId: 'approve-only', capabilities: ['approve'] },
      reviewThreads: [threadFixture({ status: from })],
    }));
    assert.equal(approved.result.thread.status, to);
  }

  for (const [from, to, expectedResolution, expectedReviewStatus] of [
    ['approved', 'open', 'open', 'approved'],
    ['changes_requested', 'resolved', 'resolved', 'changes_requested'],
  ]) {
    const resolutionOnly = authorizeReviewThreadUpdate(threadUpdate(to), authorityFixture({
      principal: { memberId: ID.actor, sessionId: 'comment-only', capabilities: ['comment'] },
      reviewThreads: [threadFixture({ status: from, decisionCanvasRevision: 7 })],
    }));
    assert.equal(resolutionOnly.result.thread.resolutionStatus, expectedResolution);
    assert.equal(resolutionOnly.result.thread.reviewStatus, expectedReviewStatus);
    assert.equal(resolutionOnly.result.thread.decisionCanvasRevision, 7);
  }

  assert.throws(
    () => authorizeReviewThreadUpdate(threadUpdate('approved'), authorityFixture({
      reviewThreads: [threadFixture({
        resolutionStatus: 'open',
        reviewStatus: 'draft',
      })],
    })),
    hasCode('collaboration_domain_review_transition_invalid'),
    'legacy approved must not bypass draft -> in_review',
  );
  assert.throws(
    () => authorizeReviewThreadUpdate(threadUpdate('changes_requested'), authorityFixture({
      reviewThreads: [threadFixture({
        resolutionStatus: 'resolved',
        reviewStatus: 'approved',
        decisionCanvasRevision: 7,
      })],
    })),
    hasCode('collaboration_domain_review_transition_invalid'),
    'legacy decisions must not bypass an approved terminal state',
  );

  const independentDecision = authorizeReviewThreadUpdate(
    threadUpdate('changes_requested'),
    authorityFixture({
      reviewThreads: [threadFixture({ resolutionStatus: 'resolved', reviewStatus: 'in_review' })],
    }),
  );
  assert.equal(independentDecision.result.thread.resolutionStatus, 'resolved');
  assert.equal(independentDecision.result.thread.reviewStatus, 'changes_requested');

  assert.throws(
    () => authorizeReviewThreadUpdate(threadUpdate('resolved'), authorityFixture({
      principal: { memberId: ID.actor, sessionId: 'approve-only', capabilities: ['approve'] },
      reviewThreads: [threadFixture({ status: 'open' })],
    })),
    hasCode('collaboration_domain_capability_missing'),
  );
  assert.throws(
    () => authorizeReviewThreadUpdate(threadUpdate('resolved', { expectedThreadRevision: 2 }), authorityFixture({
      reviewThreads: [threadFixture()],
    })),
    hasCode('collaboration_domain_review_cas_conflict'),
  );
  assert.throws(
    () => authorizeReviewThreadUpdate(threadUpdate('resolved'), authorityFixture({
      document: documentFixture({ revision: 8 }),
      reviewThreads: [threadFixture()],
    })),
    hasCode('collaboration_domain_revision_mismatch'),
  );
});

test('F6 explicit lifecycle is strict while thread resolution stays independent', () => {
  const explicitUpdate = (reviewStatus, decisionCanvasRevision = null) => operation('review.thread.update', {
    threadUid: ID.thread,
    expectedCanvasRevision: 7,
    expectedThreadRevision: 3,
    reviewStatus,
    severity: 'normal',
    decisionCanvasRevision,
  });
  const draft = threadFixture({ resolutionStatus: 'open', reviewStatus: 'draft' });
  const submitted = authorizeReviewThreadUpdate(
    explicitUpdate('in_review'),
    authorityFixture({ principal: { memberId: ID.actor, sessionId: 'editor', capabilities: ['comment'] }, reviewThreads: [draft] }),
  );
  assert.equal(submitted.result.thread.reviewStatus, 'in_review');
  assert.equal(submitted.result.thread.resolutionStatus, 'open');
  assert.throws(
    () => authorizeReviewThreadUpdate(
      explicitUpdate('approved', 7),
      authorityFixture({ reviewThreads: [draft] }),
    ),
    hasCode('collaboration_domain_review_transition_invalid'),
  );

  const inReview = threadFixture({ resolutionStatus: 'resolved', reviewStatus: 'in_review' });
  const changes = authorizeReviewThreadUpdate(
    explicitUpdate('changes_requested', 7),
    authorityFixture({ reviewThreads: [inReview] }),
  );
  assert.equal(changes.result.thread.reviewStatus, 'changes_requested');
  assert.equal(changes.result.thread.resolutionStatus, 'resolved');
  assert.throws(
    () => authorizeReviewThreadUpdate(
      explicitUpdate('in_review'),
      authorityFixture({
        principal: { memberId: ID.actor, sessionId: 'viewer', capabilities: [] },
        reviewThreads: [threadFixture({ resolutionStatus: 'resolved', reviewStatus: 'changes_requested', decisionCanvasRevision: 7 })],
      }),
    ),
    hasCode('collaboration_domain_capability_missing'),
  );
  const resubmitted = authorizeReviewThreadUpdate(
    explicitUpdate('in_review'),
    authorityFixture({
      principal: { memberId: ID.actor, sessionId: 'editor', capabilities: ['comment'] },
      reviewThreads: [threadFixture({ resolutionStatus: 'resolved', reviewStatus: 'changes_requested', decisionCanvasRevision: 7 })],
    }),
  );
  assert.equal(resubmitted.result.thread.reviewStatus, 'in_review');
  assert.equal(resubmitted.result.thread.resolutionStatus, 'resolved');
  assert.equal(resubmitted.result.thread.decisionCanvasRevision, null);

  const resolution = authorizeReviewThreadUpdate(operation('review.thread.update', {
    threadUid: ID.thread,
    expectedCanvasRevision: 7,
    expectedThreadRevision: 3,
    resolutionStatus: 'resolved',
    severity: 'normal',
  }), authorityFixture({
    principal: { memberId: ID.actor, sessionId: 'editor', capabilities: ['comment'] },
    reviewThreads: [threadFixture({ resolutionStatus: 'open', reviewStatus: 'approved', decisionCanvasRevision: 7 })],
  }));
  assert.equal(resolution.result.thread.resolutionStatus, 'resolved');
  assert.equal(resolution.result.thread.reviewStatus, 'approved');
  assert.equal(resolution.result.thread.decisionCanvasRevision, 7);

  const expiredApproval = threadFixture({
    resolutionStatus: 'resolved',
    reviewStatus: 'approved',
    decisionCanvasRevision: 6,
  });
  assert.throws(
    () => authorizeReviewThreadUpdate(
      explicitUpdate('approved', 7),
      authorityFixture({
        principal: { memberId: ID.actor, sessionId: 'editor', capabilities: ['comment'] },
        reviewThreads: [expiredApproval],
      }),
    ),
    hasCode('collaboration_domain_capability_missing'),
    'comment-only members cannot renew an expired approval by resending the same state',
  );
  const renewedApproval = authorizeReviewThreadUpdate(
    explicitUpdate('approved', 7),
    authorityFixture({ reviewThreads: [expiredApproval] }),
  );
  assert.equal(renewedApproval.result.thread.reviewStatus, 'approved');
  assert.equal(renewedApproval.result.thread.decisionCanvasRevision, 7);

  const expiredChangesRequest = threadFixture({
    resolutionStatus: 'open',
    reviewStatus: 'changes_requested',
    decisionCanvasRevision: 6,
  });
  assert.throws(
    () => authorizeReviewThreadUpdate(
      explicitUpdate('changes_requested', 7),
      authorityFixture({
        principal: { memberId: ID.actor, sessionId: 'editor', capabilities: ['comment'] },
        reviewThreads: [expiredChangesRequest],
      }),
    ),
    hasCode('collaboration_domain_capability_missing'),
  );
  assert.equal(authorizeReviewThreadUpdate(
    explicitUpdate('changes_requested', 7),
    authorityFixture({ reviewThreads: [expiredChangesRequest] }),
  ).result.thread.decisionCanvasRevision, 7);
});

test('F6 video anchors bind independent content revision + lowercase SHA-256 and keep legacy assetRevision isolated', () => {
  const modern = authorizeReviewThreadCreate(threadCreate({
    kind: 'video',
    targetUid: ID.video,
    frameMs: 4_500,
    assetContentRevision: 7,
    contentHash: VIDEO_HASH,
  }), authorityFixture());
  assert.deepEqual(modern.result.thread.anchor, {
    kind: 'video',
    targetEntityUid: ID.video,
    frameMs: 4_500,
    assetContentRevision: 7,
    contentHash: VIDEO_HASH,
  });

  assert.throws(
    () => authorizeReviewThreadCreate(threadCreate({
      kind: 'video', targetUid: ID.video, frameMs: 1, assetContentRevision: 6, contentHash: VIDEO_HASH,
    }), authorityFixture()),
    hasCode('collaboration_domain_review_cas_conflict'),
  );
  assert.throws(
    () => authorizeReviewThreadCreate(threadCreate({
      kind: 'video', targetUid: ID.video, frameMs: 1, assetContentRevision: 7, contentHash: VIDEO_HASH.toUpperCase(),
    }), authorityFixture()),
    hasCode('collaboration_domain_review_invalid'),
  );

  const legacy = authorizeReviewThreadCreate(threadCreate({
    kind: 'video', targetUid: ID.video, frameMs: 4_500, assetRevision: 3,
  }), authorityFixture());
  assert.deepEqual(legacy.result.thread.anchor, {
    kind: 'video', targetEntityUid: ID.video, frameMs: 4_500, assetRevision: 3,
  });
  assert.throws(
    () => authorizeReviewThreadCreate(threadCreate({
      kind: 'video', targetUid: ID.video, frameMs: 4_500, assetRevision: 999,
    }), authorityFixture()),
    hasCode('collaboration_domain_review_cas_conflict'),
    'organizationRevision must never satisfy the legacy assetRevision pin',
  );
});

test('F6 create/comment plans emit bounded mention, attachment, and recipient records without widening old plans', () => {
  const create = authorizeReviewThreadCreate(threadCreate(
    { kind: 'video', targetUid: ID.video, frameMs: 100, assetContentRevision: 7, contentHash: VIDEO_HASH },
    {
      mentions: [ID.memberA.toUpperCase(), ID.memberA, ID.actor],
      attachments: [{ assetUid: ID.image, assetContentRevision: 5, contentHash: IMAGE_HASH }],
    },
  ), authorityFixture());
  assert.deepEqual(create.writes.map((write) => write.kind), [
    'review.thread.insert',
    'review.comment.insert',
    'review.mention.insert',
    'review.mention.insert',
    'review.attachment.insert',
  ]);
  assert.deepEqual(create.notificationRecipients, [ID.memberA]);
  assert.deepEqual(create.result.thread.comments[0].mentions, [ID.memberA, ID.actor]);
  assert.deepEqual(create.result.thread.comments[0].attachments, [
    { assetUid: ID.image, assetContentRevision: 5, contentHash: IMAGE_HASH },
  ]);
  assert.deepEqual(create.writes.at(-1).record, {
    threadId: ID.thread,
    commentId: ID.comment,
    assetId: 'image-row',
    assetEntityUid: ID.image,
    assetContentRevision: 5,
    contentHash: IMAGE_HASH,
  });

  const thread = threadFixture();
  const comment = authorizeCollaborationDomainOperation(commentAdd({
    mentions: [ID.memberB],
    attachments: [{ assetUid: ID.video, assetContentRevision: 7, contentHash: VIDEO_HASH }],
  }), authorityFixture({ reviewThreads: [thread] }));
  assert.deepEqual(comment.notificationRecipients, [ID.memberB]);
  assert.deepEqual(comment.writes.map((write) => write.kind), [
    'review.comment.insert',
    'review.thread.update',
    'review.mention.insert',
    'review.attachment.insert',
  ]);

  const legacy = authorizeCollaborationDomainOperation(commentAdd(), authorityFixture({ reviewThreads: [thread] }));
  assert.equal(Object.hasOwn(legacy, 'notificationRecipients'), false);
  assert.equal(Object.hasOwn(legacy.result.comment, 'mentions'), false);
  assert.equal(Object.hasOwn(legacy.result.comment, 'attachments'), false);
  assert.deepEqual(legacy.writes.map((write) => write.kind), ['review.comment.insert', 'review.thread.update']);
});

test('F6 mention and attachment authority rejects cross-scope, inactive, stale, duplicate, and over-limit input', () => {
  const thread = threadFixture();
  const run = (payload, overrides = {}) => authorizeCollaborationDomainOperation(
    commentAdd(payload),
    authorityFixture({ reviewThreads: [thread], ...overrides }),
  );

  assert.throws(() => run({ mentions: [ID.unknownMember] }), hasCode('collaboration_domain_target_missing'));
  assert.throws(() => run({ mentions: [ID.foreignMember] }), hasCode('collaboration_domain_scope_mismatch'));
  assert.throws(() => run({ mentions: [ID.inactiveMember] }), hasCode('collaboration_domain_target_deleted'));
  assert.throws(
    () => run({ attachments: [{ assetUid: ID.image, assetContentRevision: 4, contentHash: IMAGE_HASH }] }),
    hasCode('collaboration_domain_review_cas_conflict'),
  );
  assert.throws(
    () => run({ attachments: [
      { assetUid: ID.image, assetContentRevision: 5, contentHash: IMAGE_HASH },
      { assetUid: ID.image, assetContentRevision: 5, contentHash: IMAGE_HASH },
    ] }),
    hasCode('collaboration_domain_review_invalid'),
  );
  assert.throws(
    () => run({ attachments: [{ assetUid: ID.image, assetContentRevision: 5, contentHash: IMAGE_HASH }] }, {
      assets: authorityFixture().assets.map((asset) => (
        asset.entityUid === ID.image ? { ...asset, projectId: 'foreign-project' } : asset
      )),
    }),
    hasCode('collaboration_domain_scope_mismatch'),
  );

  const tooManyMentions = Array.from({ length: 21 }, (_, index) => (
    `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 1).padStart(12, '0')}`
  ));
  const tooManyAttachments = Array.from({ length: 21 }, () => ({
    assetUid: ID.image,
    assetContentRevision: 5,
    contentHash: IMAGE_HASH,
  }));
  assert.throws(() => run({ mentions: tooManyMentions }), hasCode('collaboration_domain_review_invalid'));
  assert.throws(() => run({ attachments: tooManyAttachments }), hasCode('collaboration_domain_review_invalid'));
});
