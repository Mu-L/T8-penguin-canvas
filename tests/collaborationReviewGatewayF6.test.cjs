const assert = require('node:assert/strict');
const test = require('node:test');

const {
  COMMON_OPERATION_BATCH_CONTRACT,
} = require('../backend/src/collaboration/commonOperationProtocol');
const {
  createFixture,
  joinSocket,
  openSocketProbe,
  redeemActor,
  requestJson,
} = require('./helpers/collaborationF2Fixture.cjs');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const IDS = Object.freeze({
  videoAsset: 'f6000000-0000-4000-8000-000000000001',
  commonBatch: 'f6000000-0000-4000-8000-000000000002',
  commonClient: 'f6000000-0000-4000-8000-000000000003',
  commonThread: 'f6000000-0000-4000-8000-000000000004',
  commonComment: 'f6000000-0000-4000-8000-000000000005',
  commonOperation: 'f6000000-0000-4000-8000-000000000006',
});

function reviewUrl(fixture, suffix = '') {
  return `${fixture.baseUrl}/api/collab/reviews${suffix}`;
}

async function postJson(url, actor, body, method = 'POST') {
  return requestJson(url, {
    method,
    headers: {
      cookie: actor.cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function createReview(fixture, actor, input = {}) {
  return postJson(reviewUrl(fixture), actor, {
    canvasId: fixture.canvasId,
    expectedCanvasRevision: fixture.database.getCanvas(fixture.canvasId).revision,
    anchor: { kind: 'canvas', x: 10, y: 20 },
    body: 'F6 审片意见',
    severity: 'normal',
    ...input,
  });
}

function addCanvasAsset(fixture, input = {}) {
  const asset = fixture.database.upsertAsset({
    id: input.id || 'review-video-f6',
    entityUid: input.entityUid || IDS.videoAsset,
    projectId: fixture.projectId,
    kind: input.kind || 'video',
    mimeType: input.mimeType || 'video/mp4',
    filename: input.filename || 'review.mp4',
    contentHash: input.contentHash || HASH_A,
    metadata: input.metadata || { durationMs: 5_000 },
    createdBy: 'local-owner',
  });
  fixture.database.grantCanvasAssetResource(
    fixture.projectId,
    fixture.canvasId,
    asset.id,
    'f6-review-test',
  );
  return asset;
}

function setRestrictedAssetPolicy(fixture, asset, memberId) {
  return fixture.database.setAssetAccessPolicy(fixture.projectId, asset.id, {
    scope: 'restricted',
    grants: [{
      principalType: 'member',
      principalId: memberId,
      permissions: ['view'],
    }],
  }, { actorId: 'local-owner' });
}

test('F6 legacy review REST requires exact canvas/thread CAS and enforces member, asset ACL, and immutable content pins', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-review-rest-f6',
    canvasId: 'canvas-review-rest-f6',
    snapshot: {
      name: 'F6 review REST canvas',
      nodes: [{
        id: 'node-review',
        entityUid: 'f6100000-0000-4000-8000-000000000001',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { prompt: 'review prompt' },
      }],
      edges: [],
    },
  });
  const author = await redeemActor(fixture, 'reviewer', 'F6 review author');
  const recipient = await redeemActor(fixture, 'reviewer', 'F6 review recipient');
  const asset = addCanvasAsset(fixture);
  setRestrictedAssetPolicy(fixture, asset, author.memberId);
  const canvasRevision = fixture.database.getCanvas(fixture.canvasId).revision;

  const missingCanvasCas = await postJson(reviewUrl(fixture), author, {
    canvasId: fixture.canvasId,
    anchor: { kind: 'canvas', x: 0, y: 0 },
    body: 'missing canvas CAS',
  });
  assert.equal(missingCanvasCas.response.status, 400, JSON.stringify(missingCanvasCas.payload));
  assert.equal(missingCanvasCas.payload.code, 'collaboration_review_revision_invalid');

  const staleCanvasCas = await createReview(fixture, author, {
    expectedCanvasRevision: canvasRevision + 1,
    body: 'stale canvas CAS',
  });
  assert.equal(staleCanvasCas.response.status, 409, JSON.stringify(staleCanvasCas.payload));
  assert.equal(staleCanvasCas.payload.code, 'collaboration_review_canvas_cas_conflict');

  const created = await createReview(fixture, author, {
    anchor: {
      kind: 'video',
      assetId: asset.id,
      frameMs: 1_250,
      assetContentRevision: asset.contentRevision,
      contentHash: asset.contentHash,
    },
    severity: 'blocking',
    mentions: [recipient.memberId, author.memberId, recipient.memberId],
    attachments: [{
      assetEntityUid: asset.entityUid,
      assetContentRevision: asset.contentRevision,
      contentHash: asset.contentHash,
    }],
    body: '视频 1.25 秒需要复核',
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const thread = created.payload.data;
  assert.equal(thread.revision, 1);
  assert.equal(thread.anchor.kind, 'video');
  assert.equal(thread.anchor.frameMs, 1_250);
  const returnedVideoAnchor = thread.anchor;
  assert.equal(thread.comments.length, 1);
  assert.deepEqual(
    thread.comments[0].mentions.map((mention) => mention.memberId).sort(),
    [author.memberId, recipient.memberId].sort(),
    'mentions must be deduplicated and resolved only inside the current canvas',
  );
  assert.equal(thread.comments[0].attachments[0].available, true);
  assert.equal(thread.comments[0].attachments[0].assetUid, asset.entityUid);
  assert.equal(thread.comments[0].attachments[0].assetContentRevision, 1);
  assert.equal(thread.comments[0].attachments[0].asset.sourceUrl, null);
  assert.doesNotMatch(
    JSON.stringify(thread.comments[0].attachments[0]),
    /managedPath|localPath/i,
  );

  const unauthorizedAttachment = await createReview(fixture, recipient, {
    body: 'ACL must reject this attachment',
    attachments: [{
      assetUid: asset.entityUid,
      assetContentRevision: asset.contentRevision,
      contentHash: asset.contentHash,
    }],
  });
  assert.equal(unauthorizedAttachment.response.status, 400, JSON.stringify(unauthorizedAttachment.payload));
  assert.equal(unauthorizedAttachment.payload.code, 'collaboration_review_attachment_invalid');

  const unauthorizedAnchor = await createReview(fixture, recipient, {
    body: 'ACL must reject this anchor',
    anchor: {
      kind: 'video',
      assetId: asset.id,
      frameMs: 100,
      assetContentRevision: asset.contentRevision,
      contentHash: asset.contentHash,
    },
  });
  assert.equal(unauthorizedAnchor.response.status, 400, JSON.stringify(unauthorizedAnchor.payload));
  assert.equal(unauthorizedAnchor.payload.code, 'collaboration_review_create_invalid');

  const stalePin = await createReview(fixture, author, {
    body: 'stale attachment pin',
    attachments: [{
      assetUid: asset.entityUid,
      assetContentRevision: asset.contentRevision,
      contentHash: HASH_B,
    }],
  });
  assert.equal(stalePin.response.status, 409, JSON.stringify(stalePin.payload));
  assert.equal(stalePin.payload.code, 'collaboration_review_attachment_changed');

  const unknownMention = await createReview(fixture, author, {
    body: 'unknown member mention',
    mentions: ['f6200000-0000-4000-8000-000000000099'],
  });
  assert.equal(unknownMention.response.status, 404, JSON.stringify(unknownMention.payload));
  assert.equal(unknownMention.payload.code, 'collaboration_review_mention_not_found');

  const missingThreadCas = await postJson(
    reviewUrl(fixture, `/${encodeURIComponent(thread.id)}/comments`),
    recipient,
    { expectedCanvasRevision: canvasRevision, body: 'missing thread CAS' },
  );
  assert.equal(missingThreadCas.response.status, 400, JSON.stringify(missingThreadCas.payload));
  assert.equal(missingThreadCas.payload.code, 'collaboration_review_revision_invalid');

  const staleThreadCas = await postJson(
    reviewUrl(fixture, `/${encodeURIComponent(thread.id)}/comments`),
    recipient,
    {
      expectedCanvasRevision: canvasRevision,
      expectedThreadRevision: thread.revision + 1,
      body: 'stale thread CAS',
    },
  );
  assert.equal(staleThreadCas.response.status, 409, JSON.stringify(staleThreadCas.payload));
  assert.equal(staleThreadCas.payload.code, 'collaboration_domain_review_cas_conflict');

  const replied = await postJson(
    reviewUrl(fixture, `/${encodeURIComponent(thread.id)}/comments`),
    recipient,
    {
      expectedCanvasRevision: canvasRevision,
      expectedThreadRevision: thread.revision,
      parentId: thread.comments[0].entityUid,
      body: '嵌套回复',
    },
  );
  assert.equal(replied.response.status, 201, JSON.stringify(replied.payload));
  assert.equal(replied.payload.data.revision, 2);
  assert.equal(replied.payload.data.comments[1].parentEntityUid, thread.comments[0].entityUid);

  const staleUpdate = await postJson(
    reviewUrl(fixture, `/${encodeURIComponent(thread.id)}`),
    author,
    {
      expectedCanvasRevision: canvasRevision,
      expectedThreadRevision: 1,
      status: 'resolved',
    },
    'PATCH',
  );
  assert.equal(staleUpdate.response.status, 409, JSON.stringify(staleUpdate.payload));
  assert.equal(staleUpdate.payload.code, 'collaboration_domain_review_cas_conflict');

  const resolved = await postJson(
    reviewUrl(fixture, `/${encodeURIComponent(thread.id)}`),
    author,
    {
      expectedCanvasRevision: canvasRevision,
      expectedThreadRevision: 2,
      status: 'resolved',
    },
    'PATCH',
  );
  assert.equal(resolved.response.status, 200, JSON.stringify(resolved.payload));
  assert.equal(resolved.payload.data.status, 'resolved');
  assert.equal(resolved.payload.data.revision, 3);

  const reopened = await postJson(
    reviewUrl(fixture, `/${encodeURIComponent(thread.id)}`),
    author,
    {
      expectedCanvasRevision: canvasRevision,
      expectedThreadRevision: 3,
      status: 'open',
    },
    'PATCH',
  );
  assert.equal(reopened.response.status, 200, JSON.stringify(reopened.payload));
  assert.equal(reopened.payload.data.status, 'open');
  assert.equal(reopened.payload.data.revision, 4);
  assert.equal(fixture.database.getCanvas(fixture.canvasId).revision, canvasRevision);
  assert.equal(returnedVideoAnchor.assetContentRevision, 1);
  assert.equal(returnedVideoAnchor.contentHash, HASH_A);
  assert.equal(returnedVideoAnchor.contentChanged, false);
});

test('F6 REST legacy status cannot bypass lifecycle and only mutates its compatibility dimension', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-review-legacy-lifecycle-f6',
    canvasId: 'canvas-review-legacy-lifecycle-f6',
  });
  const reviewer = await redeemActor(fixture, 'reviewer', 'F6 legacy lifecycle reviewer');
  const editor = await redeemActor(fixture, 'editor', 'F6 legacy lifecycle editor');
  const canvasRevision = fixture.database.getCanvas(fixture.canvasId).revision;
  const created = await createReview(fixture, reviewer, {
    body: 'legacy lifecycle guard',
    reviewStatus: 'draft',
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.data.reviewStatus, 'draft');

  const skippedSubmission = await postJson(
    reviewUrl(fixture, `/${encodeURIComponent(created.payload.data.id)}`),
    reviewer,
    {
      expectedCanvasRevision: canvasRevision,
      expectedThreadRevision: created.payload.data.revision,
      status: 'approved',
    },
    'PATCH',
  );
  assert.equal(skippedSubmission.response.status, 409, JSON.stringify(skippedSubmission.payload));
  assert.equal(skippedSubmission.payload.code, 'collaboration_domain_review_transition_invalid');

  const submitted = await postJson(
    reviewUrl(fixture, `/${encodeURIComponent(created.payload.data.id)}`),
    editor,
    {
      expectedCanvasRevision: canvasRevision,
      expectedThreadRevision: created.payload.data.revision,
      reviewStatus: 'in_review',
    },
    'PATCH',
  );
  assert.equal(submitted.response.status, 200, JSON.stringify(submitted.payload));

  const requestedChanges = await postJson(
    reviewUrl(fixture, `/${encodeURIComponent(created.payload.data.id)}`),
    reviewer,
    {
      expectedCanvasRevision: canvasRevision,
      expectedThreadRevision: submitted.payload.data.revision,
      status: 'changes_requested',
    },
    'PATCH',
  );
  assert.equal(requestedChanges.response.status, 200, JSON.stringify(requestedChanges.payload));
  assert.equal(requestedChanges.payload.data.resolutionStatus, 'open');
  assert.equal(requestedChanges.payload.data.reviewStatus, 'changes_requested');

  const resolved = await postJson(
    reviewUrl(fixture, `/${encodeURIComponent(created.payload.data.id)}`),
    editor,
    {
      expectedCanvasRevision: canvasRevision,
      expectedThreadRevision: requestedChanges.payload.data.revision,
      status: 'resolved',
    },
    'PATCH',
  );
  assert.equal(resolved.response.status, 200, JSON.stringify(resolved.payload));
  assert.equal(resolved.payload.data.resolutionStatus, 'resolved');
  assert.equal(resolved.payload.data.reviewStatus, 'changes_requested');
  assert.equal(resolved.payload.data.decisionCanvasRevision, canvasRevision);

  const changedDecision = await postJson(
    reviewUrl(fixture, `/${encodeURIComponent(created.payload.data.id)}`),
    reviewer,
    {
      expectedCanvasRevision: canvasRevision,
      expectedThreadRevision: resolved.payload.data.revision,
      status: 'approved',
    },
    'PATCH',
  );
  assert.equal(changedDecision.response.status, 409, JSON.stringify(changedDecision.payload));
  assert.equal(changedDecision.payload.code, 'collaboration_domain_review_transition_invalid');
});

test('F6 review list filters/page, exact comparison/export, and recipient-only notifications stay scoped', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-review-query-f6',
    canvasId: 'canvas-review-query-f6',
    snapshot: {
      name: 'F6 query canvas',
      nodes: [{
        id: 'node-query',
        entityUid: 'f6300000-0000-4000-8000-000000000001',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { prompt: 'source revision prompt' },
      }],
      edges: [],
    },
  });
  const reviewer = await redeemActor(fixture, 'reviewer', 'F6 query reviewer');
  const editor = await redeemActor(fixture, 'editor', 'F6 query editor');
  const recipient = await redeemActor(fixture, 'viewer', 'F6 notification recipient');
  const canvasRevision = fixture.database.getCanvas(fixture.canvasId).revision;

  const created = [];
  for (const input of [
    { severity: 'high', anchor: { kind: 'canvas', x: 1, y: 1 }, body: 'High canvas review' },
    { severity: 'high', anchor: { kind: 'node', nodeId: 'node-query' }, body: 'High node review' },
    { severity: 'normal', anchor: { kind: 'canvas', x: 2, y: 2 }, body: 'Normal canvas review' },
  ]) {
    const result = await createReview(fixture, reviewer, {
      ...input,
      mentions: [recipient.memberId],
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.payload));
    created.push(result.payload.data);
  }

  const severityPage = await requestJson(
    `${reviewUrl(fixture)}?severity=high&unresolved=true&limit=1&offset=1`,
    { headers: { cookie: reviewer.cookie } },
  );
  assert.equal(severityPage.response.status, 200, JSON.stringify(severityPage.payload));
  assert.equal(severityPage.payload.meta.total, 2);
  assert.equal(severityPage.payload.meta.limit, 1);
  assert.equal(severityPage.payload.meta.offset, 1);
  assert.equal(severityPage.payload.data.length, 1);
  assert.equal(severityPage.payload.data[0].severity, 'high');

  const memberAndAnchorFilter = await requestJson(
    `${reviewUrl(fixture)}?anchorKind=canvas&mentionedMemberId=${encodeURIComponent(recipient.memberId)}&limit=100&offset=0`,
    { headers: { cookie: reviewer.cookie } },
  );
  assert.equal(memberAndAnchorFilter.response.status, 200, JSON.stringify(memberAndAnchorFilter.payload));
  assert.equal(memberAndAnchorFilter.payload.meta.total, 2);
  assert.ok(memberAndAnchorFilter.payload.data.every((thread) => thread.anchor.kind === 'canvas'));

  for (const query of ['limit=101', 'offset=10001', 'unresolved=maybe']) {
    const invalid = await requestJson(`${reviewUrl(fixture)}?${query}`, {
      headers: { cookie: reviewer.cookie },
    });
    assert.equal(invalid.response.status, 400, JSON.stringify(invalid.payload));
  }

  const approved = await postJson(
    reviewUrl(fixture, `/${encodeURIComponent(created[0].id)}`),
    reviewer,
    {
      expectedCanvasRevision: canvasRevision,
      expectedThreadRevision: created[0].revision,
      status: 'approved',
    },
    'PATCH',
  );
  assert.equal(approved.response.status, 200, JSON.stringify(approved.payload));
  assert.equal(approved.payload.data.decisionCanvasRevision, canvasRevision);
  assert.equal(approved.payload.data.approvalExpired, false);

  const current = fixture.database.getCanvas(fixture.canvasId);
  const changed = fixture.database.saveCanvasSnapshot(fixture.canvasId, {
    ...current,
    nodes: current.nodes.map((node) => node.id === 'node-query'
      ? { ...node, data: { ...node.data, prompt: 'current revision prompt' } }
      : node),
  }, {
    expectedRevision: current.revision,
    actorId: reviewer.memberId,
    sessionId: reviewer.id,
  });
  assert.equal(changed.revision, canvasRevision + 1);

  const expired = await requestJson(`${reviewUrl(fixture)}?status=expired&limit=100&offset=0`, {
    headers: { cookie: reviewer.cookie },
  });
  assert.equal(expired.response.status, 200, JSON.stringify(expired.payload));
  assert.equal(expired.payload.meta.total, 1);
  assert.equal(expired.payload.data[0].approvalExpired, true);
  assert.equal(expired.payload.data[0].effectiveStatus, 'expired');

  const comparison = await requestJson(
    reviewUrl(fixture, `/${encodeURIComponent(created[0].id)}/compare`),
    { headers: { cookie: reviewer.cookie } },
  );
  assert.equal(comparison.response.status, 200, JSON.stringify(comparison.payload));
  assert.equal(comparison.payload.data.comparison.fromRevision, canvasRevision);
  assert.equal(comparison.payload.data.comparison.toRevision, canvasRevision + 1);
  assert.equal(comparison.payload.data.comparison.nodes.changed.length, 1);

  const jsonExport = await requestJson(
    `${reviewUrl(fixture, '/export')}?status=expired&format=json`,
    { headers: { cookie: reviewer.cookie } },
  );
  assert.equal(jsonExport.response.status, 200, JSON.stringify(jsonExport.payload));
  assert.match(jsonExport.response.headers.get('content-disposition'), /review-.*\.json/);
  assert.equal(jsonExport.payload.meta.total, 1);
  assert.equal(jsonExport.payload.data.threads[0].approvalExpired, true);

  const markdownResponse = await fetch(
    `${reviewUrl(fixture, '/export')}?severity=high&format=markdown`,
    { headers: { cookie: reviewer.cookie } },
  );
  const markdown = await markdownResponse.text();
  assert.equal(markdownResponse.status, 200, markdown);
  assert.match(markdownResponse.headers.get('content-type'), /text\/markdown/);
  assert.match(markdown, /High canvas review|High node review/);

  const invalidExport = await requestJson(
    `${reviewUrl(fixture, '/export')}?format=csv`,
    { headers: { cookie: reviewer.cookie } },
  );
  assert.equal(invalidExport.response.status, 400, JSON.stringify(invalidExport.payload));

  const editorRebind = await postJson(
    reviewUrl(fixture, `/${encodeURIComponent(created[0].id)}`),
    editor,
    {
      expectedCanvasRevision: changed.revision,
      expectedThreadRevision: approved.payload.data.revision,
      reviewStatus: 'approved',
    },
    'PATCH',
  );
  assert.equal(editorRebind.response.status, 403, JSON.stringify(editorRebind.payload));
  assert.equal(fixture.database.getReviewThread(created[0].id).decisionCanvasRevision, canvasRevision);
  assert.equal(fixture.database.getReviewThread(created[0].id).approvalExpired, true);

  const reviewerRebind = await postJson(
    reviewUrl(fixture, `/${encodeURIComponent(created[0].id)}`),
    reviewer,
    {
      expectedCanvasRevision: changed.revision,
      expectedThreadRevision: approved.payload.data.revision,
      reviewStatus: 'approved',
    },
    'PATCH',
  );
  assert.equal(reviewerRebind.response.status, 200, JSON.stringify(reviewerRebind.payload));
  assert.equal(reviewerRebind.payload.data.decisionCanvasRevision, changed.revision);
  assert.equal(reviewerRebind.payload.data.approvalExpired, false);

  const transactionObservations = [];
  const instrument = (owner, name, label) => {
    const original = owner[name];
    owner[name] = function instrumentedReviewRead(...args) {
      transactionObservations.push({ label, inTransaction: fixture.database.db.inTransaction });
      return original.apply(this, args);
    };
    return () => { owner[name] = original; };
  };
  const restoreInstrumentation = [
    instrument(fixture.gateway, 'ensureCanvasAccess', 'access'),
    instrument(fixture.gateway, 'publicReviewThreadForSession', 'public'),
    instrument(fixture.database, 'listReviewThreads', 'list'),
    instrument(fixture.database, 'countReviewThreads', 'count'),
    instrument(fixture.database, 'materializeReviewThreadExport', 'export'),
  ];
  try {
    const snapshotList = await requestJson(`${reviewUrl(fixture)}?reviewStatus=approved&limit=100&offset=0`, {
      headers: { cookie: reviewer.cookie },
    });
    assert.equal(snapshotList.response.status, 200, JSON.stringify(snapshotList.payload));
    const snapshotExport = await requestJson(
      `${reviewUrl(fixture, '/export')}?reviewStatus=approved&format=json`,
      { headers: { cookie: reviewer.cookie } },
    );
    assert.equal(snapshotExport.response.status, 200, JSON.stringify(snapshotExport.payload));
    assert.equal(snapshotExport.payload.data.revision, changed.revision);
    assert.equal(snapshotExport.payload.data.threads[0].approvalExpired, false);
  } finally {
    restoreInstrumentation.reverse().forEach((restore) => restore());
  }
  for (const label of ['access', 'public', 'list', 'count', 'export']) {
    const observations = transactionObservations.filter((item) => item.label === label);
    assert.ok(observations.length > 0, `missing ${label} snapshot observation`);
    if (label === 'access') {
      // Session/resource middleware also performs an independent access check
      // before dispatch; the route's document read must additionally occur in
      // the same transaction as list/export hydration.
      assert.ok(observations.some((item) => item.inTransaction), 'route access escaped the SQLite read snapshot');
    } else {
      assert.ok(observations.every((item) => item.inTransaction), `${label} escaped the SQLite read snapshot`);
    }
  }

  const notificationPage = await requestJson(
    `${fixture.baseUrl}/api/collab/notifications?limit=1&offset=1`,
    { headers: { cookie: recipient.cookie } },
  );
  assert.equal(notificationPage.response.status, 200, JSON.stringify(notificationPage.payload));
  assert.equal(notificationPage.payload.data.length, 1);
  assert.deepEqual(notificationPage.payload.meta, { limit: 1, offset: 1 });

  const allNotifications = await requestJson(
    `${fixture.baseUrl}/api/collab/notifications?limit=100&offset=0`,
    { headers: { cookie: recipient.cookie } },
  );
  assert.equal(allNotifications.response.status, 200, JSON.stringify(allNotifications.payload));
  assert.equal(allNotifications.payload.data.length, 3);
  assert.ok(allNotifications.payload.data.every((notification) => notification.readAt == null));
  const notificationId = allNotifications.payload.data[0].id;

  const actorCannotRead = await postJson(
    `${fixture.baseUrl}/api/collab/notifications/${encodeURIComponent(notificationId)}/read`,
    reviewer,
    {},
    'PATCH',
  );
  assert.equal(actorCannotRead.response.status, 404, JSON.stringify(actorCannotRead.payload));

  const markedRead = await postJson(
    `${fixture.baseUrl}/api/collab/notifications/${encodeURIComponent(notificationId)}/read`,
    recipient,
    {},
    'PATCH',
  );
  assert.equal(markedRead.response.status, 200, JSON.stringify(markedRead.payload));
  assert.ok(Number.isSafeInteger(markedRead.payload.data.readAt));

  const unread = await requestJson(
    `${fixture.baseUrl}/api/collab/notifications?unreadOnly=true&limit=100&offset=0`,
    { headers: { cookie: recipient.cookie } },
  );
  assert.equal(unread.response.status, 200, JSON.stringify(unread.payload));
  assert.equal(unread.payload.data.length, 2);
  assert.ok(unread.payload.data.every((notification) => notification.readAt == null));
});

test('F6 common review exact replay rechecks current capabilities and never resends notifications', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-review-replay-f6',
    canvasId: 'canvas-review-replay-f6',
  });
  const reviewer = await redeemActor(fixture, 'reviewer', 'F6 common reviewer');
  const recipient = await redeemActor(fixture, 'viewer', 'F6 common recipient');
  const recipientSocket = await openSocketProbe(fixture, recipient, {
    label: 'F6 common review recipient socket',
  });
  await joinSocket(
    recipientSocket,
    fixture.canvasId,
    fixture.database.getCanvas(fixture.canvasId).revision,
  );
  const revision = fixture.database.getCanvas(fixture.canvasId).revision;
  const batch = {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    baseRevision: revision,
    batchId: IDS.commonBatch,
    clientId: IDS.commonClient,
    clientSeq: 1,
    operations: [{
      opId: IDS.commonOperation,
      type: 'review.thread.create',
      payload: {
        threadUid: IDS.commonThread,
        expectedCanvasRevision: revision,
        anchor: { kind: 'canvas', x: 5, y: 6 },
        severity: 'high',
        initialComment: {
          commentUid: IDS.commonComment,
          body: 'common review notification',
          mentions: [recipient.memberId],
        },
      },
    }],
  };

  const first = await postJson(
    `${fixture.baseUrl}/api/collab/common-operations`,
    reviewer,
    batch,
  );
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.data.duplicate, false);
  const pushed = await recipientSocket.nextMessage(
    (message) => message.type === 'review.notification',
    'first common review did not push its notification',
  );
  assert.equal(pushed.notifications.length, 1);
  const pushedNotification = pushed.notifications[0];
  assert.equal(
    fixture.database.listCollaborationNotifications({
      projectId: fixture.projectId,
      canvasId: fixture.canvasId,
      recipientMemberId: recipient.memberId,
    }).length,
    1,
  );

  const replay = await postJson(
    `${fixture.baseUrl}/api/collab/common-operations`,
    reviewer,
    structuredClone(batch),
  );
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.payload.data.duplicate, true);
  assert.equal(
    fixture.database.listCollaborationNotifications({
      projectId: fixture.projectId,
      canvasId: fixture.canvasId,
      recipientMemberId: recipient.memberId,
    }).length,
    1,
  );
  await recipientSocket.expectNoMessage(
    (message) => message.type === 'review.notification',
    200,
    'an exact common review replay resent a notification',
  );

  const downgraded = fixture.gateway.auth.updateMember(
    reviewer.memberId,
    { role: 'viewer' },
    {
      actorId: 'local-owner',
      sessionId: 'local-management',
      expectedProjectId: fixture.projectId,
      expectedCanvasId: fixture.canvasId,
    },
  );
  assert.equal(downgraded.role, 'viewer');
  assert.deepEqual(downgraded.capabilities, []);
  const deniedReplay = await postJson(
    `${fixture.baseUrl}/api/collab/common-operations`,
    reviewer,
    structuredClone(batch),
  );
  assert.equal(deniedReplay.response.status, 403, JSON.stringify(deniedReplay.payload));
  assert.equal(deniedReplay.payload.code, 'collaboration_domain_capability_missing');
  assert.equal(
    fixture.database.listCollaborationNotifications({
      projectId: fixture.projectId,
      canvasId: fixture.canvasId,
      recipientMemberId: recipient.memberId,
    }).length,
    1,
  );
  assert.equal(pushedNotification.threadEntityUid, IDS.commonThread);
});

test('B2 notification read maps raw storage exhaustion to one redacted 507 boundary', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-notification-capacity-b2',
    canvasId: 'canvas-notification-capacity-b2',
  });
  const reviewer = await redeemActor(fixture, 'reviewer', 'Notification capacity reviewer');
  const recipient = await redeemActor(fixture, 'viewer', 'Notification capacity recipient');
  const created = await createReview(fixture, reviewer, {
    body: 'notification capacity boundary',
    mentions: [recipient.memberId],
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const notifications = fixture.database.listCollaborationNotifications({
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    recipientMemberId: recipient.memberId,
  });
  assert.equal(notifications.length, 1);

  const original = fixture.database.markCollaborationNotificationRead;
  fixture.database.markCollaborationNotificationRead = () => {
    throw Object.assign(
      new Error('SQLITE_FULL at C:\\Users\\private-owner\\projects.sqlite3 UPDATE collaboration_notifications'),
      { code: 'SQLITE_FULL' },
    );
  };
  try {
    const result = await postJson(
      `${fixture.baseUrl}/api/collab/notifications/${encodeURIComponent(notifications[0].id)}/read`,
      recipient,
      {},
      'PATCH',
    );
    assert.equal(result.response.status, 507, JSON.stringify(result.payload));
    assert.equal(result.payload.code, 'project_database_storage_capacity_exceeded');
    assert.equal(result.payload.reason, 'sqlite-full');
    assert.equal(result.payload.retryable, false);
    assert.doesNotMatch(result.text, /private-owner|projects\.sqlite3|collaboration_notifications/i);
  } finally {
    fixture.database.markCollaborationNotificationRead = original;
  }
});
