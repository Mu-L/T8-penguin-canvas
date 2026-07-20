const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clone,
  createFixture,
  getCanvas,
  getSync,
  joinSocket,
  moveRequest,
  openSocketProbe,
  operationCounts,
  postOperation,
  reconstructFromSync,
  redeemActor,
  requestJson,
} = require('./helpers/collaborationF2Fixture.cjs');

function expectedPublicAcknowledgement(actor, serializedBody, revision, duplicate) {
  const request = JSON.parse(serializedBody);
  const operation = request.operations[0];
  return {
    opId: operation.opId,
    projectId: actor.projectId,
    canvasId: actor.canvasId,
    baseRevision: request.baseRevision,
    revision,
    actorId: actor.memberId,
    clientSeq: operation.clientSeq,
    type: operation.type,
    payload: operation.payload,
    timestamp: operation.timestamp,
    duplicate,
  };
}

test('F2 ambiguous exact retry applies once and does not rebroadcast a duplicate invalidation', async (t) => {
  const fixture = await createFixture(t);
  const actorA = await redeemActor(fixture, 'editor', 'Ambiguous replay A');
  const actorB = await redeemActor(fixture, 'editor', 'Ambiguous replay B');
  const observer = await openSocketProbe(fixture, actorB, { label: 'ambiguous replay observer' });
  await joinSocket(observer, fixture.canvasId, 1);

  const exactBody = moveRequest(1, {
    opId: 'f2-ambiguous-exact-move',
    clientSeq: 17,
    timestamp: 1_800_000_100_017,
    nodeId: 'node-a',
    position: { x: 111, y: 222 },
  });
  const first = await postOperation(fixture, actorA, exactBody);
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.deepEqual(first.payload.data.acknowledgements, [
    expectedPublicAcknowledgement(actorA, exactBody, 2, false),
  ]);
  assert.doesNotMatch(JSON.stringify(first.payload.data.acknowledgements), /sessionId/);
  assert.equal(first.payload.data.document.revision, 2);
  await observer.nextMessage(
    (message) => message.type === 'canvas.operations' && message.revision === 2,
    'first ambiguous operation invalidation timed out',
  );

  const remote = await postOperation(fixture, actorB, moveRequest(2, {
    opId: 'f2-ambiguous-remote-advance',
    clientSeq: 18,
    timestamp: 1_800_000_100_018,
    nodeId: 'node-b',
    position: { x: 333, y: 444 },
  }));
  assert.equal(remote.response.status, 200, JSON.stringify(remote.payload));
  assert.equal(remote.payload.data.document.revision, 3);
  await observer.nextMessage(
    (message) => message.type === 'canvas.operations' && message.revision === 3,
    'remote advance invalidation timed out',
  );

  // Reuse the exact serialized envelope: opId, clientSeq, baseRevision, timestamp, and payload.
  const retried = await postOperation(fixture, actorA, exactBody);
  assert.equal(retried.response.status, 200, JSON.stringify(retried.payload));
  assert.deepEqual(retried.payload.data.acknowledgements, [
    expectedPublicAcknowledgement(actorA, exactBody, 2, true),
  ]);
  assert.equal(retried.payload.data.document.revision, 3);
  await observer.expectNoMessage(
    (message) => message.type === 'canvas.operations',
    250,
    'exact duplicate replay emitted a second invalidation',
  );

  const changedTimestampRequest = JSON.parse(exactBody);
  changedTimestampRequest.operations[0].timestamp += 1;
  const changedTimestamp = await postOperation(
    fixture,
    actorA,
    JSON.stringify(changedTimestampRequest),
  );
  assert.equal(changedTimestamp.response.status, 409, JSON.stringify(changedTimestamp.payload));
  assert.equal(changedTimestamp.payload.code, 'operation_id_conflict');

  assert.deepEqual(operationCounts(fixture.database, 'f2-ambiguous-exact-move'), {
    operation: 1,
    idempotency: 1,
    audits: 1,
  });
  const current = fixture.database.getCanvas(fixture.canvasId);
  assert.equal(current.revision, 3);
  assert.deepEqual(current.nodes.find((node) => node.id === 'node-a').position, { x: 111, y: 222 });
  assert.deepEqual(current.nodes.find((node) => node.id === 'node-b').position, { x: 333, y: 444 });
});

test('F2 explicit 409 proves the queued opId is absent before delta sync and safe rebase', async (t) => {
  const fixture = await createFixture(t);
  const offlineActor = await redeemActor(fixture, 'editor', 'Offline rebase actor');
  const remoteActor = await redeemActor(fixture, 'editor', 'Remote rebase actor');
  const baseDocument = clone(await getCanvas(fixture, offlineActor));
  const remote = await postOperation(fixture, remoteActor, moveRequest(1, {
    opId: 'f2-rebase-remote-move',
    clientSeq: 1,
    timestamp: 1_800_000_200_001,
    nodeId: 'node-b',
    position: { x: 500, y: 600 },
  }));
  assert.equal(remote.response.status, 200, JSON.stringify(remote.payload));

  const queuedOperation = {
    opId: 'f2-rebase-queued-move',
    clientSeq: 91,
    timestamp: 1_800_000_200_091,
    nodeId: 'node-a',
    position: { x: 700, y: 800 },
  };
  const staleBody = moveRequest(1, queuedOperation);
  const stale = await postOperation(fixture, offlineActor, staleBody);
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
  assert.equal(stale.payload.code, 'revision_conflict');
  assert.equal(stale.payload.currentRevision, 2);
  assert.deepEqual(operationCounts(fixture.database, queuedOperation.opId), {
    operation: 0,
    idempotency: 0,
    audits: 0,
  });

  const sync = await getSync(fixture, offlineActor, baseDocument.revision);
  assert.equal(sync.response.status, 200, JSON.stringify(sync.payload));
  assert.equal(sync.payload.data.mode, 'operations');
  assert.deepEqual(sync.payload.data.operations.map((operation) => operation.opId), [
    'f2-rebase-remote-move',
  ]);
  const recovered = reconstructFromSync(baseDocument, sync.payload.data);
  assert.equal(recovered.revision, 2);
  assert.deepEqual(recovered.nodes.find((node) => node.id === 'node-b').position, {
    x: 500,
    y: 600,
  });

  // Only baseRevision changes after the explicit 409; operation identity and payload stay exact.
  const rebasedBody = moveRequest(recovered.revision, queuedOperation);
  const applied = await postOperation(fixture, offlineActor, rebasedBody);
  assert.equal(applied.response.status, 200, JSON.stringify(applied.payload));
  assert.equal(applied.payload.data.acknowledgements[0].duplicate, false);
  assert.equal(applied.payload.data.document.revision, 3);

  const duplicate = await postOperation(fixture, offlineActor, rebasedBody);
  assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.payload));
  assert.equal(duplicate.payload.data.acknowledgements[0].duplicate, true);
  assert.equal(duplicate.payload.data.document.revision, 3);
  assert.deepEqual(operationCounts(fixture.database, queuedOperation.opId), {
    operation: 1,
    idempotency: 1,
    audits: 1,
  });
  assert.deepEqual(
    fixture.database.getCanvas(fixture.canvasId).nodes.find((node) => node.id === 'node-a').position,
    { x: 700, y: 800 },
  );
});

test('F2 snapshot recovery turns a removed queued move into a deterministic blocked result', async (t) => {
  const fixture = await createFixture(t);
  const actor = await redeemActor(fixture, 'editor', 'Snapshot blocked actor');
  const replacement = clone(fixture.database.getCanvas(fixture.canvasId));
  replacement.nodes = replacement.nodes.filter((node) => node.id !== 'node-b');
  fixture.database.saveCanvasSnapshot(fixture.canvasId, replacement, {
    expectedRevision: 1,
    actorId: 'local-owner',
    sessionId: 'local-management',
  });
  const queued = {
    opId: 'f2-snapshot-removed-node-move',
    clientSeq: 31,
    timestamp: 1_800_000_300_031,
    nodeId: 'node-b',
    position: { x: 900, y: 900 },
  };

  const stale = await postOperation(fixture, actor, moveRequest(1, queued));
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
  assert.equal(stale.payload.currentRevision, 2);
  const sync = await getSync(fixture, actor, 1, actor.recoveryGeneration);
  assert.equal(sync.response.status, 200, JSON.stringify(sync.payload));
  assert.equal(sync.payload.data.mode, 'snapshot');
  assert.equal(sync.payload.data.reason, 'snapshot_required');
  assert.equal(sync.payload.data.document.nodes.some((node) => node.id === 'node-b'), false);

  const blocked = await postOperation(fixture, actor, moveRequest(2, queued));
  assert.equal(blocked.response.status, 400, JSON.stringify(blocked.payload));
  assert.equal(blocked.payload.code, 'canvas_operation_invalid');
  assert.match(blocked.payload.error, /节点不存在/);
  assert.equal(fixture.database.getCanvas(fixture.canvasId).revision, 2);
  assert.deepEqual(operationCounts(fixture.database, queued.opId), {
    operation: 0,
    idempotency: 0,
    audits: 0,
  });
});

test('F2 strict FIFO replay stops at the first blocked node.move and never sends later items', async (t) => {
  const fixture = await createFixture(t);
  fixture.database.applyOperations(fixture.canvasId, [{
    opId: 'f2-fifo-host-delete',
    actorId: 'local-owner',
    sessionId: 'local-management',
    clientSeq: 1,
    type: 'node.delete',
    payload: { nodeId: 'node-b' },
  }], { expectedRevision: 1 });
  const actor = await redeemActor(fixture, 'editor', 'FIFO actor');
  const queue = [
    {
      opId: 'f2-fifo-first-move',
      clientSeq: 41,
      timestamp: 1_800_000_400_041,
      nodeId: 'node-a',
      position: { x: 10, y: 20 },
    },
    {
      opId: 'f2-fifo-blocked-move',
      clientSeq: 42,
      timestamp: 1_800_000_400_042,
      nodeId: 'node-b',
      position: { x: 30, y: 40 },
    },
    {
      opId: 'f2-fifo-must-not-run',
      clientSeq: 43,
      timestamp: 1_800_000_400_043,
      nodeId: 'node-c',
      position: { x: 50, y: 60 },
    },
  ];

  let revision = 2;
  const results = [];
  for (const item of queue) {
    const result = await postOperation(fixture, actor, moveRequest(revision, item));
    results.push({ opId: item.opId, status: result.response.status, payload: result.payload });
    if (!result.response.ok) break;
    revision = result.payload.data.document.revision;
  }

  assert.deepEqual(results.map((result) => [result.opId, result.status]), [
    ['f2-fifo-first-move', 200],
    ['f2-fifo-blocked-move', 400],
  ]);
  assert.equal(results[1].payload.code, 'object_deleted');
  assert.deepEqual(operationCounts(fixture.database, 'f2-fifo-first-move'), {
    operation: 1,
    idempotency: 1,
    audits: 1,
  });
  assert.deepEqual(operationCounts(fixture.database, 'f2-fifo-blocked-move'), {
    operation: 0,
    idempotency: 0,
    audits: 0,
  });
  assert.deepEqual(operationCounts(fixture.database, 'f2-fifo-must-not-run'), {
    operation: 0,
    idempotency: 0,
    audits: 0,
  });
  const document = fixture.database.getCanvas(fixture.canvasId);
  assert.equal(document.revision, 3);
  assert.deepEqual(document.nodes.find((node) => node.id === 'node-a').position, { x: 10, y: 20 });
  assert.deepEqual(document.nodes.find((node) => node.id === 'node-c').position, { x: 320, y: 0 });
});

test('F2 operation idempotency and session identity survive SQLite plus gateway restart', async (t) => {
  const fixture = await createFixture(t, {
    persistent: true,
    projectId: 'project-f2-persistent-replay',
    canvasId: 'canvas-f2-persistent-replay',
  });
  const actor = await redeemActor(fixture, 'editor', 'Persistent replay actor');
  const exactBody = moveRequest(1, {
    opId: 'f2-persistent-exact-move',
    clientSeq: 51,
    timestamp: 1_800_000_500_051,
    nodeId: 'node-c',
    position: { x: 1234, y: 5678 },
  });
  const first = await postOperation(fixture, actor, exactBody);
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.data.document.revision, 2);

  await fixture.restart();
  const session = await requestJson(`${fixture.baseUrl}/api/collab/session`, {
    headers: { cookie: actor.cookie },
  });
  assert.equal(session.response.status, 200, JSON.stringify(session.payload));
  assert.equal(session.payload.data.id, actor.id);
  assert.equal(session.payload.data.memberId, actor.memberId);

  const duplicate = await postOperation(fixture, actor, exactBody);
  assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.payload));
  assert.deepEqual(duplicate.payload.data.acknowledgements, [
    expectedPublicAcknowledgement(actor, exactBody, 2, true),
  ]);
  assert.equal(duplicate.payload.data.document.revision, 2);
  assert.deepEqual(operationCounts(fixture.database, 'f2-persistent-exact-move'), {
    operation: 1,
    idempotency: 1,
    audits: 1,
  });

  const sync = await getSync(fixture, actor, 1, actor.recoveryGeneration);
  assert.equal(sync.response.status, 200, JSON.stringify(sync.payload));
  assert.equal(sync.payload.data.mode, 'operations');
  assert.deepEqual(sync.payload.data.operations.map((operation) => operation.opId), [
    'f2-persistent-exact-move',
  ]);
  assert.doesNotMatch(JSON.stringify(sync.payload), /"sessionId"/);
});

test('F2 exact replay identity cannot cross session, canvas, or capability scope', async (t) => {
  const fixture = await createFixture(t);
  const actorA = await redeemActor(fixture, 'editor', 'Scoped replay A');
  const actorB = await redeemActor(fixture, 'editor', 'Scoped replay B');
  const viewer = await redeemActor(fixture, 'viewer', 'Scoped replay viewer');
  const exactBody = moveRequest(1, {
    opId: 'f2-session-scoped-move',
    clientSeq: 61,
    timestamp: 1_800_000_600_061,
    nodeId: 'node-a',
    position: { x: 77, y: 88 },
  });
  const first = await postOperation(fixture, actorA, exactBody);
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));

  const crossSession = await postOperation(fixture, actorB, exactBody);
  assert.equal(crossSession.response.status, 409, JSON.stringify(crossSession.payload));
  assert.equal(crossSession.payload.code, 'operation_id_conflict');
  assert.equal(crossSession.payload.currentRevision, 2);

  const wrongCanvas = await postOperation(fixture, actorA, moveRequest(2, {
    opId: 'f2-wrong-canvas-move',
    clientSeq: 62,
    timestamp: 1_800_000_600_062,
    nodeId: 'node-a',
    position: { x: 99, y: 100 },
  }), 'canvas-outside-session');
  assert.equal(wrongCanvas.response.status, 404, JSON.stringify(wrongCanvas.payload));

  const viewerDenied = await postOperation(fixture, viewer, moveRequest(2, {
    opId: 'f2-viewer-offline-move',
    clientSeq: 63,
    timestamp: 1_800_000_600_063,
    nodeId: 'node-c',
    position: { x: 101, y: 102 },
  }));
  assert.equal(viewerDenied.response.status, 403, JSON.stringify(viewerDenied.payload));

  assert.deepEqual(operationCounts(fixture.database, 'f2-session-scoped-move'), {
    operation: 1,
    idempotency: 1,
    audits: 1,
  });
  assert.deepEqual(operationCounts(fixture.database, 'f2-wrong-canvas-move'), {
    operation: 0,
    idempotency: 0,
    audits: 0,
  });
  assert.deepEqual(operationCounts(fixture.database, 'f2-viewer-offline-move'), {
    operation: 0,
    idempotency: 0,
    audits: 0,
  });
  const current = fixture.database.getCanvas(fixture.canvasId);
  assert.equal(current.revision, 2);
  assert.deepEqual(current.nodes.find((node) => node.id === 'node-a').position, { x: 77, y: 88 });
});
