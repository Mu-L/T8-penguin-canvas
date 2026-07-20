const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  COMMON_OPERATION_BATCH_CONTRACT,
} = require('../backend/src/collaboration/commonOperationProtocol');

const {
  WebSocket,
  clone,
  closeSocket,
  createFixture,
  eventually,
  getCanvas,
  getSync,
  joinSocket,
  moveRequest,
  openSocketProbe,
  postOperation,
  reconstructFromSync,
  redeemActor,
  requestJson,
} = require('./helpers/collaborationF2Fixture.cjs');

test('F2 session.ready advertises protocol v2 and join plus application pong stay revision scoped', async (t) => {
  const fixture = await createFixture(t);
  const viewer = await redeemActor(fixture, 'viewer', 'Protocol viewer');
  const probe = await openSocketProbe(fixture, viewer);
  const initial = fixture.database.getCanvas(fixture.canvasId);
  const { ready, joined, presence } = await joinSocket(
    probe,
    fixture.canvasId,
    initial.revision,
  );

  assert.match(
    ready.connectionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(ready.session.id, viewer.id);
  assert.equal(ready.protocol.version, 2);
  assert.equal(ready.protocol.heartbeatIntervalMs, fixture.gateway.webSocketHeartbeatIntervalMs);
  assert.equal(ready.protocol.heartbeatTimeoutMs, fixture.gateway.webSocketHeartbeatTimeoutMs);
  assert.ok(ready.protocol.heartbeatIntervalMs >= 1_000);
  assert.ok(ready.protocol.heartbeatTimeoutMs >= ready.protocol.heartbeatIntervalMs * 2);
  assert.equal(ready.protocol.maxSyncOperations, 500);
  assert.deepEqual(joined, {
    type: 'canvas.joined',
    canvasId: fixture.canvasId,
    revision: initial.revision,
    afterRevision: initial.revision,
    generation: fixture.database.getRecoveryGeneration(),
    syncRequired: false,
  });
  assert.equal(presence.canvasId, fixture.canvasId);
  assert.deepEqual(presence.members, []);

  probe.send({ type: 'ping', nonce: 'f2-revision-ping' });
  const pong = await probe.nextMessage(
    (message) => message.type === 'pong' && message.nonce === 'f2-revision-ping',
    'revision-scoped application pong timed out',
  );
  assert.equal(pong.canvasId, fixture.canvasId);
  assert.equal(pong.revision, initial.revision);
  assert.equal(pong.generation, fixture.database.getRecoveryGeneration());
  assert.ok(Number.isSafeInteger(pong.timestamp));
});

test('F2 protocol v2 rejects non-numeric or unsafe WebSocket afterRevision values', async (t) => {
  const fixture = await createFixture(t);
  const viewer = await redeemActor(fixture, 'viewer', 'Strict WebSocket revision viewer');
  const invalidValues = [null, true, '1', -1, 1.5, Number.MAX_SAFE_INTEGER + 1];

  for (const value of invalidValues) {
    const probe = await openSocketProbe(fixture, viewer, { label: `invalid revision ${String(value)}` });
    await probe.nextMessage(
      (message) => message.type === 'session.ready',
      'session.ready missing before invalid join',
    );
    probe.send({ type: 'canvas.join', canvasId: fixture.canvasId, afterRevision: value });
    const error = await probe.nextMessage(
      (message) => message.type === 'error' && message.code === 'canvas_revision_invalid',
      `WebSocket afterRevision ${String(value)} was not rejected`,
      750,
    );
    assert.equal(error.code, 'canvas_revision_invalid');
    await probe.expectNoMessage(
      (message) => message.type === 'canvas.joined',
      50,
      `invalid afterRevision ${String(value)} joined the canvas`,
    );
    await closeSocket(probe.socket);
  }
});

test('F2 sync HTTP rejects malformed afterRevision instead of coercing it into a snapshot', async (t) => {
  const fixture = await createFixture(t);
  const viewer = await redeemActor(fixture, 'viewer', 'Strict HTTP revision viewer');
  const invalidQueries = [
    'afterRevision=abc',
    'afterRevision=-1',
    'afterRevision=1.5',
    'afterRevision=1e309',
    'afterRevision=1&afterRevision=2',
  ];

  for (const query of invalidQueries) {
    const result = await requestJson(
      `${fixture.baseUrl}/api/collab/canvases/${fixture.canvasId}/sync?${query}`,
      { headers: { cookie: viewer.cookie } },
    );
    assert.equal(result.response.status, 400, `${query}: ${JSON.stringify(result.payload)}`);
    assert.equal(result.payload.code, 'canvas_revision_invalid', query);
  }

  const valid = await getSync(fixture, viewer, 1);
  assert.equal(valid.response.status, 200, JSON.stringify(valid.payload));
  assert.equal(valid.payload.data.afterRevision, 1);
});

test('F2 sync responses remain no-store when Origin, authentication, or canvas scope rejects before the route body', async (t) => {
  const fixture = await createFixture(t);
  const viewer = await redeemActor(fixture, 'viewer', 'No-store precondition viewer');
  const syncUrl = `${fixture.baseUrl}/api/collab/canvases/${encodeURIComponent(fixture.canvasId)}/sync?afterRevision=0`;

  const hostileOrigin = await requestJson(syncUrl, {
    headers: {
      cookie: viewer.cookie,
      origin: 'https://hostile.example',
    },
  });
  assert.equal(hostileOrigin.response.status, 403, JSON.stringify(hostileOrigin.payload));
  assert.equal(hostileOrigin.response.headers.get('cache-control'), 'no-store');

  const unauthenticated = await requestJson(syncUrl);
  assert.equal(unauthenticated.response.status, 401, JSON.stringify(unauthenticated.payload));
  assert.equal(unauthenticated.response.headers.get('cache-control'), 'no-store');

  const wrongCanvas = await requestJson(
    `${fixture.baseUrl}/api/collab/canvases/not-this-canvas/sync?afterRevision=0`,
    { headers: { cookie: viewer.cookie } },
  );
  assert.equal(wrongCanvas.response.status, 404, JSON.stringify(wrongCanvas.payload));
  assert.equal(wrongCanvas.response.headers.get('cache-control'), 'no-store');
});

test('F2 persistent restart fails closed instead of applying a schema32 freshness-rejected stale backup', async (t) => {
  const fixture = await createFixture(t, { persistent: true });
  const editor = await redeemActor(fixture, 'editor', 'Recovery freshness editor');
  await fixture.database.createBackup();
  const acknowledged = await postOperation(fixture, editor, moveRequest(1, {
    opId: 'f2-freshness-unknown-revision-2',
    clientSeq: 1,
    nodeId: 'node-a',
    position: { x: 10, y: 10 },
  }));
  assert.equal(acknowledged.response.status, 200, JSON.stringify(acknowledged.payload));
  assert.equal(acknowledged.payload.data.document.revision, 2);

  const backupFilename = `${fixture.databaseFilename}.backup`;
  const generationFilename = `${fixture.databaseFilename}.recovery-generation.json`;
  const backupBefore = fs.readFileSync(backupFilename);
  const generationBefore = fs.readFileSync(generationFilename);
  const brokenPrimary = Buffer.from('f2-broken-primary-after-acknowledged-write');
  let failure = null;
  await assert.rejects(fixture.restart({
    beforeOpen: () => fs.writeFileSync(fixture.databaseFilename, brokenPrimary),
  }), (error) => {
    failure = error;
    return error?.code === 'project_database_recovery_failed'
      && error?.status === 503
      && error?.details?.phase === 'backup_freshness_rejected'
      && error?.details?.freshnessStatus === 'rejected'
      && Array.isArray(error?.details?.freshnessReasons)
      && error.details.freshnessReasons.length > 0
      && Number.isSafeInteger(error?.details?.acknowledgedWriteSequence)
      && Number.isSafeInteger(error?.details?.capturedWriteSequence)
      && error.details.capturedWriteSequence < error.details.acknowledgedWriteSequence;
  });
  assert.deepEqual(fs.readFileSync(fixture.databaseFilename), brokenPrimary);
  assert.deepEqual(fs.readFileSync(backupFilename), backupBefore);
  assert.deepEqual(fs.readFileSync(generationFilename), generationBefore);
  assert.equal(fs.existsSync(failure.details.restoreTemp), true);
});

test('F2 persistent restart keeps a valid generation byte-stable and HTTP plus WebSocket sync stay pure under query_only', async (t) => {
  const fixture = await createFixture(t, { persistent: true });
  const viewer = await redeemActor(fixture, 'viewer', 'Persistent generation purity viewer');
  const generationFilename = `${fixture.databaseFilename}.recovery-generation.json`;
  const generationBeforeRestart = fs.readFileSync(generationFilename);
  const generationStatBeforeRestart = fs.statSync(generationFilename, { bigint: true });
  const generation = fixture.database.getRecoveryGeneration();

  await fixture.restart();
  assert.equal(fixture.database.getRecoveryGeneration(), generation);
  assert.deepEqual(fs.readFileSync(generationFilename), generationBeforeRestart);
  const generationStatAfterRestart = fs.statSync(generationFilename, { bigint: true });
  assert.equal(generationStatAfterRestart.mtimeNs, generationStatBeforeRestart.mtimeNs);
  assert.equal(generationStatAfterRestart.ctimeNs, generationStatBeforeRestart.ctimeNs);

  const readOptional = (filename) => (fs.existsSync(filename) ? fs.readFileSync(filename) : null);
  fixture.database.db.pragma('query_only = ON');
  const changesBefore = fixture.database.db.totalChanges;
  const durableBefore = {
    main: readOptional(fixture.databaseFilename),
    wal: readOptional(`${fixture.databaseFilename}-wal`),
    shm: readOptional(`${fixture.databaseFilename}-shm`),
    generation: fs.readFileSync(generationFilename),
  };
  try {
    const document = fixture.database.getCanvas(fixture.canvasId);
    const sync = await getSync(fixture, viewer, document.revision, generation);
    assert.equal(sync.response.status, 200, JSON.stringify(sync.payload));
    assert.equal(sync.response.headers.get('cache-control'), 'no-store');
    assert.equal(sync.payload.data.mode, 'operations');
    assert.equal(sync.payload.data.generation, generation);
    assert.deepEqual(sync.payload.data.operations, []);

    const malformed = await requestJson(
      `${fixture.baseUrl}/api/collab/canvases/${encodeURIComponent(fixture.canvasId)}/sync?afterRevision=bad`,
      { headers: { cookie: viewer.cookie } },
    );
    assert.equal(malformed.response.status, 400, JSON.stringify(malformed.payload));
    assert.equal(malformed.response.headers.get('cache-control'), 'no-store');

    const missing = await requestJson(
      `${fixture.baseUrl}/api/collab/canvases/missing-canvas/sync?afterRevision=0`,
      { headers: { cookie: viewer.cookie } },
    );
    assert.equal(missing.response.status, 404, JSON.stringify(missing.payload));
    assert.equal(missing.response.headers.get('cache-control'), 'no-store');

    const originalSyncCanvas = fixture.database.syncCanvas;
    try {
      fixture.database.syncCanvas = () => {
        throw Object.assign(new Error('simulated sync read failure'), {
          code: 'project_database_recovery_generation_unavailable',
          status: 503,
        });
      };
      const unavailable = await getSync(fixture, viewer, document.revision, generation);
      assert.equal(unavailable.response.status, 503, JSON.stringify(unavailable.payload));
      assert.equal(unavailable.response.headers.get('cache-control'), 'no-store');
    } finally {
      fixture.database.syncCanvas = originalSyncCanvas;
    }

    const probe = await openSocketProbe(fixture, viewer, { label: 'persistent generation purity socket' });
    const { joined } = await joinSocket(probe, fixture.canvasId, document.revision, { generation });
    assert.equal(joined.generation, generation);
    assert.equal(joined.syncRequired, false);
    probe.send({ type: 'ping', nonce: 'persistent-generation-purity' });
    const pong = await probe.nextMessage(
      (message) => message.type === 'pong' && message.nonce === 'persistent-generation-purity',
      'persistent generation purity pong timed out',
    );
    assert.equal(pong.generation, generation);

    assert.equal(fixture.database.db.totalChanges, changesBefore);
    assert.deepEqual(readOptional(fixture.databaseFilename), durableBefore.main);
    assert.deepEqual(readOptional(`${fixture.databaseFilename}-wal`), durableBefore.wal);
    assert.deepEqual(readOptional(`${fixture.databaseFilename}-shm`), durableBefore.shm);
    assert.deepEqual(fs.readFileSync(generationFilename), durableBefore.generation);
  } finally {
    fixture.database.db.pragma('query_only = OFF');
  }
});

test('F2 explicit generation rotation forces legacy and stale-generation clients onto a snapshot even when revision is equal', async (t) => {
  const fixture = await createFixture(t, { persistent: true });
  const editor = await redeemActor(fixture, 'editor', 'Recovery generation editor');
  const generationBefore = fixture.database.getRecoveryGeneration();
  const generationAfter = fixture.database.rotateRecoveryGeneration('f2-test-explicit-rotation');
  assert.notEqual(generationAfter, generationBefore);
  const replacement = fixture.database.applyOperations(fixture.canvasId, [{
    opId: 'f2-generation-replacement-revision-2',
    actorId: editor.memberId,
    sessionId: editor.id,
    clientSeq: 2,
    type: 'node.move',
    payload: { nodeId: 'node-a', position: { x: 20, y: 20 } },
  }], { expectedRevision: 1 });
  assert.equal(replacement.document.revision, 2);

  const legacy = await getSync(fixture, editor, 2);
  assert.equal(legacy.response.status, 200, JSON.stringify(legacy.payload));
  assert.equal(legacy.payload.data.mode, 'snapshot');
  assert.equal(legacy.payload.data.reason, 'recovery_generation_changed');
  assert.equal(legacy.payload.data.generation, generationAfter);
  assert.deepEqual(legacy.payload.data.document.nodes.find((node) => node.id === 'node-a').position, { x: 20, y: 20 });

  const stale = await getSync(fixture, editor, 2, generationBefore);
  assert.equal(stale.payload.data.mode, 'snapshot');
  assert.equal(stale.payload.data.reason, 'recovery_generation_changed');
  const current = await getSync(fixture, editor, 2, generationAfter);
  assert.equal(current.payload.data.mode, 'operations');
  assert.deepEqual(current.payload.data.operations, []);

  const probe = await openSocketProbe(fixture, editor, { label: 'stale generation socket' });
  const { joined } = await joinSocket(probe, fixture.canvasId, 2, { generation: generationBefore });
  assert.equal(joined.generation, generationAfter);
  assert.equal(joined.syncRequired, true);

  const staleWrite = await postOperation(fixture, editor, moveRequest(2, {
    opId: 'f2-generation-stale-aba-write',
    clientSeq: 3,
    nodeId: 'node-a',
    position: { x: 30, y: 30 },
  }), fixture.canvasId, { generation: generationBefore });
  assert.equal(staleWrite.response.status, 409, JSON.stringify(staleWrite.payload));
  assert.equal(staleWrite.payload.code, 'canvas_generation_changed');

  const legacyWrite = await postOperation(fixture, editor, moveRequest(2, {
    opId: 'f2-generation-missing-aba-write',
    clientSeq: 4,
    nodeId: 'node-a',
    position: { x: 40, y: 40 },
  }), fixture.canvasId, { generation: null });
  assert.equal(legacyWrite.response.status, 409, JSON.stringify(legacyWrite.payload));
  assert.equal(legacyWrite.payload.code, 'canvas_generation_required');
  assert.equal(fixture.database.getCanvas(fixture.canvasId).revision, 2);
  assert.deepEqual(
    fixture.database.getCanvas(fixture.canvasId).nodes.find((node) => node.id === 'node-a').position,
    { x: 20, y: 20 },
  );

  const currentWrite = await postOperation(fixture, editor, moveRequest(2, {
    opId: 'f2-generation-current-write',
    clientSeq: 5,
    nodeId: 'node-a',
    position: { x: 50, y: 50 },
  }), fixture.canvasId, { generation: generationAfter });
  assert.equal(currentWrite.response.status, 200, JSON.stringify(currentWrite.payload));
  assert.equal(currentWrite.payload.data.document.revision, 3);

  const reviewBatch = {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    baseRevision: 3,
    batchId: 'f2000000-0000-4000-8000-000000000101',
    clientId: 'f2000000-0000-4000-8000-000000000102',
    clientSeq: 6,
    operations: [{
      opId: 'f2000000-0000-4000-8000-000000000103',
      type: 'review.thread.create',
      payload: {
        threadUid: 'f2000000-0000-4000-8000-000000000104',
        expectedCanvasRevision: 3,
        anchor: { kind: 'canvas', x: 32, y: 48 },
        severity: 'normal',
        initialComment: {
          commentUid: 'f2000000-0000-4000-8000-000000000105',
          body: 'generation ABA boundary',
        },
      },
    }],
  };
  const postCommon = (generation) => requestJson(`${fixture.baseUrl}/api/collab/common-operations`, {
    method: 'POST',
    headers: {
      cookie: editor.cookie,
      'content-type': 'application/json',
      ...(generation == null ? {} : { 'x-t8-canvas-generation': generation }),
    },
    body: JSON.stringify(reviewBatch),
  });
  const reviewCountBefore = fixture.database.db.prepare(
    'SELECT COUNT(*) AS count FROM review_threads',
  ).get().count;
  const staleCommon = await postCommon(generationBefore);
  assert.equal(staleCommon.response.status, 409, JSON.stringify(staleCommon.payload));
  assert.equal(staleCommon.payload.code, 'canvas_generation_changed');
  const legacyCommon = await postCommon(null);
  assert.equal(legacyCommon.response.status, 409, JSON.stringify(legacyCommon.payload));
  assert.equal(legacyCommon.payload.code, 'canvas_generation_required');
  assert.equal(fixture.database.db.prepare(
    'SELECT COUNT(*) AS count FROM review_threads',
  ).get().count, reviewCountBefore);
  const currentCommon = await postCommon(generationAfter);
  assert.equal(currentCommon.response.status, 200, JSON.stringify(currentCommon.payload));
  assert.equal(fixture.database.db.prepare(
    'SELECT COUNT(*) AS count FROM review_threads',
  ).get().count, reviewCountBefore + 1);

  const durableState = {
    revision: fixture.database.getCanvas(fixture.canvasId).revision,
    operations: fixture.database.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations').get().count,
    reviews: fixture.database.db.prepare('SELECT COUNT(*) AS count FROM review_threads').get().count,
    runIntents: fixture.database.db.prepare('SELECT COUNT(*) AS count FROM run_intents').get().count,
  };
  const durableMutationProbes = [
    ['POST', `/api/collab/canvases/${fixture.canvasId}/text/updates`],
    ['POST', `/api/collab/canvases/${fixture.canvasId}/patches`],
    ['POST', `/api/collab/canvases/${fixture.canvasId}/patches/unknown/revert`],
    ['POST', `/api/collab/canvases/${fixture.canvasId}/history/1/restore`],
    ['POST', '/api/collab/reviews'],
    ['POST', '/api/collab/reviews/unknown/comments'],
    ['PATCH', '/api/collab/reviews/unknown'],
    ['POST', '/api/collab/subflows/unknown/publish'],
    ['POST', '/api/collab/run-intents'],
    ['POST', '/api/collab/assets/uploads'],
    ['PUT', '/api/collab/assets/uploads/unknown/chunks/0'],
    ['POST', '/api/collab/assets/uploads/unknown/pause'],
    ['POST', '/api/collab/assets/uploads/unknown/resume'],
    ['POST', '/api/collab/assets/uploads/unknown/complete'],
    ['DELETE', '/api/collab/assets/uploads/unknown'],
  ];
  for (const [method, pathname] of durableMutationProbes) {
    const guarded = await requestJson(`${fixture.baseUrl}${pathname}`, {
      method,
      headers: {
        cookie: editor.cookie,
        'content-type': 'application/json',
        'x-t8-canvas-generation': generationBefore,
      },
      ...(method === 'DELETE' ? {} : { body: '{}' }),
    });
    assert.equal(guarded.response.status, 409, `${method} ${pathname}: ${JSON.stringify(guarded.payload)}`);
    assert.equal(guarded.payload.code, 'canvas_generation_changed', `${method} ${pathname}`);
  }
  assert.deepEqual({
    revision: fixture.database.getCanvas(fixture.canvasId).revision,
    operations: fixture.database.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations').get().count,
    reviews: fixture.database.db.prepare('SELECT COUNT(*) AS count FROM review_threads').get().count,
    runIntents: fixture.database.db.prepare('SELECT COUNT(*) AS count FROM run_intents').get().count,
  }, durableState);

  const malformedGeneration = await postOperation(fixture, editor, moveRequest(3, {
    opId: 'f2-generation-malformed-write',
    clientSeq: 7,
    nodeId: 'node-a',
    position: { x: 60, y: 60 },
  }), fixture.canvasId, { generation: 'not-a-uuid' });
  assert.equal(malformedGeneration.response.status, 400, JSON.stringify(malformedGeneration.payload));
  assert.equal(malformedGeneration.payload.code, 'canvas_generation_invalid');

  for (const [pathname, body] of [
    [`/api/collab/canvases/${fixture.canvasId}/agent/tools`, {}],
    [`/api/collab/canvases/${fixture.canvasId}/patches/preview`, {}],
    ['/api/collab/subflow-upgrade-plans', {}],
  ]) {
    const exempt = await requestJson(`${fixture.baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        cookie: editor.cookie,
        'content-type': 'application/json',
        'x-t8-canvas-generation': generationBefore,
      },
      body: JSON.stringify(body),
    });
    assert.notEqual(exempt.payload.code, 'canvas_generation_changed', pathname);
    assert.notEqual(exempt.payload.code, 'canvas_generation_required', pathname);
  }

  const logoutActor = await redeemActor(fixture, 'viewer', 'Recovery generation logout actor');
  const loggedOut = await requestJson(`${fixture.baseUrl}/api/collab/logout`, {
    method: 'POST',
    headers: {
      cookie: logoutActor.cookie,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(loggedOut.response.status, 200, JSON.stringify(loggedOut.payload));
  assert.notEqual(loggedOut.payload.code, 'canvas_generation_required');

  const rotated = await requestJson(`${fixture.baseUrl}/api/collab/session/rotate`, {
    method: 'POST',
    headers: {
      cookie: editor.cookie,
      'content-type': 'application/json',
      'x-t8-canvas-generation': generationBefore,
    },
    body: '{}',
  });
  assert.equal(rotated.response.status, 200, JSON.stringify(rotated.payload));
});

test('F2 sync exposes contiguous metadata-rich deltas without cache or session identity leaks', async (t) => {
  const fixture = await createFixture(t);
  const editor = await redeemActor(fixture, 'editor', 'Delta editor');
  const initial = clone(await getCanvas(fixture, editor));
  const first = await postOperation(fixture, editor, moveRequest(1, {
    opId: 'f2-delta-move-a',
    clientSeq: 1,
    timestamp: 1_800_000_000_001,
    nodeId: 'node-a',
    position: { x: 40, y: 60 },
  }));
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  const second = await postOperation(fixture, editor, moveRequest(2, {
    opId: 'f2-delta-move-b',
    clientSeq: 2,
    timestamp: 1_800_000_000_002,
    nodeId: 'node-b',
    position: { x: 220, y: 80 },
  }));
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));

  const delta = await getSync(fixture, editor, initial.revision);
  assert.equal(delta.response.status, 200, JSON.stringify(delta.payload));
  assert.match(delta.response.headers.get('cache-control') || '', /no-store/i);
  assert.equal(delta.payload.data.mode, 'operations');
  assert.equal(delta.payload.data.canvasId, fixture.canvasId);
  assert.equal(delta.payload.data.afterRevision, 1);
  assert.equal(delta.payload.data.revision, 3);
  assert.deepEqual(delta.payload.data.operations.map((operation) => operation.revision), [2, 3]);
  assert.equal(delta.payload.data.operations.some((operation) => Object.hasOwn(operation, 'sessionId')), false);
  assert.doesNotMatch(JSON.stringify(delta.payload), /"sessionId"/);

  const reconstructed = reconstructFromSync(initial, delta.payload.data);
  const current = await getCanvas(fixture, editor);
  assert.deepEqual(reconstructed.nodes, current.nodes);
  assert.deepEqual(reconstructed.edges, current.edges);
  assert.equal(reconstructed.revision, current.revision);

  const empty = await getSync(fixture, editor, current.revision);
  assert.equal(empty.payload.data.mode, 'operations');
  assert.equal(empty.payload.data.afterRevision, current.revision);
  assert.equal(empty.payload.data.revision, current.revision);
  assert.deepEqual(empty.payload.data.operations, []);
});

test('F2 sync preserves a legal shared batch base across full and mid-batch deltas', async (t) => {
  const fixture = await createFixture(t);
  const actor = await redeemActor(fixture, 'editor', 'Shared batch base editor');
  const submitted = await postOperation(fixture, actor, JSON.stringify({
    baseRevision: 1,
    operations: [
      {
        opId: 'f2-shared-base-a',
        baseRevision: 1,
        clientSeq: 1,
        timestamp: 1_800_000_050_001,
        type: 'node.move',
        payload: { nodeId: 'node-a', position: { x: 101, y: 102 } },
      },
      {
        opId: 'f2-shared-base-b',
        baseRevision: 1,
        clientSeq: 2,
        timestamp: 1_800_000_050_002,
        type: 'node.move',
        payload: { nodeId: 'node-b', position: { x: 201, y: 202 } },
      },
    ],
  }));
  assert.equal(submitted.response.status, 200, JSON.stringify(submitted.payload));
  assert.equal(submitted.payload.data.document.revision, 3);

  const full = await getSync(fixture, actor, 1);
  assert.equal(full.response.status, 200, JSON.stringify(full.payload));
  assert.deepEqual(full.payload.data.operations.map((operation) => ({
    opId: operation.opId,
    baseRevision: operation.baseRevision,
    revision: operation.revision,
  })), [
    { opId: 'f2-shared-base-a', baseRevision: 1, revision: 2 },
    { opId: 'f2-shared-base-b', baseRevision: 1, revision: 3 },
  ]);

  const middle = await getSync(fixture, actor, 2);
  assert.equal(middle.response.status, 200, JSON.stringify(middle.payload));
  assert.deepEqual(middle.payload.data.operations.map((operation) => ({
    opId: operation.opId,
    baseRevision: operation.baseRevision,
    revision: operation.revision,
  })), [
    { opId: 'f2-shared-base-b', baseRevision: 1, revision: 3 },
  ]);
});

test('F2 SQLite sync reports every authoritative snapshot fallback reason', async (t) => {
  const fixture = await createFixture(t);
  const database = fixture.database;
  database.applyOperations(fixture.canvasId, [{
    opId: 'f2-snapshot-reason-move-a',
    actorId: 'host',
    sessionId: 'host-session',
    clientSeq: 1,
    type: 'node.move',
    payload: { nodeId: 'node-a', position: { x: 10, y: 10 } },
  }], { expectedRevision: 1 });
  database.applyOperations(fixture.canvasId, [{
    opId: 'f2-snapshot-reason-move-b',
    actorId: 'host',
    sessionId: 'host-session',
    clientSeq: 2,
    type: 'node.move',
    payload: { nodeId: 'node-b', position: { x: 20, y: 20 } },
  }], { expectedRevision: 2 });

  assert.equal(database.syncCanvas(fixture.canvasId, 0).reason, 'initial');
  assert.equal(database.syncCanvas(fixture.canvasId, 99).reason, 'client_ahead');
  assert.equal(database.syncCanvas(fixture.canvasId, 1, 1).reason, 'range_exceeded');

  const beforeSnapshot = database.getCanvas(fixture.canvasId);
  database.saveCanvasSnapshot(fixture.canvasId, beforeSnapshot, {
    expectedRevision: beforeSnapshot.revision,
    actorId: 'host',
    sessionId: 'host-session',
  });
  const requiresSnapshot = database.syncCanvas(fixture.canvasId, beforeSnapshot.revision);
  assert.equal(requiresSnapshot.mode, 'snapshot');
  assert.equal(requiresSnapshot.reason, 'snapshot_required');
  assert.equal(requiresSnapshot.afterRevision, beforeSnapshot.revision);
  assert.equal(requiresSnapshot.revision, beforeSnapshot.revision + 1);

  const gapFixture = await createFixture(t, {
    projectId: 'project-f2-gap',
    canvasId: 'canvas-f2-gap',
  });
  gapFixture.database.applyOperations(gapFixture.canvasId, [{
    opId: 'f2-gap-move-a',
    type: 'node.move',
    payload: { nodeId: 'node-a', position: { x: 1, y: 1 } },
  }], { expectedRevision: 1 });
  gapFixture.database.applyOperations(gapFixture.canvasId, [{
    opId: 'f2-gap-move-b',
    type: 'node.move',
    payload: { nodeId: 'node-b', position: { x: 2, y: 2 } },
  }], { expectedRevision: 2 });
  gapFixture.database.db.prepare(
    'DELETE FROM canvas_operations WHERE canvas_id = ? AND revision = ?',
  ).run(gapFixture.canvasId, 2);
  const historyGap = gapFixture.database.syncCanvas(gapFixture.canvasId, 1);
  assert.equal(historyGap.mode, 'snapshot');
  assert.equal(historyGap.reason, 'history_gap');
  assert.equal(historyGap.document.revision, 3);
});

test('F2 Presence is normalized, connection-scoped, ephemeral, and restored only after resend', async (t) => {
  const fixture = await createFixture(t);
  const actorA = await redeemActor(fixture, 'editor', 'Presence A');
  const actorB = await redeemActor(fixture, 'viewer', 'Presence B');
  const actorC = await redeemActor(fixture, 'viewer', 'Presence C');
  const actorD = await redeemActor(fixture, 'viewer', 'Presence D');
  const probeA = await openSocketProbe(fixture, actorA);
  const probeB = await openSocketProbe(fixture, actorB);
  const joinedA = await joinSocket(probeA, fixture.canvasId, 1);
  await joinSocket(probeB, fixture.canvasId, 1);

  probeA.send({
    type: 'presence.update',
    presence: {
      cursor: { x: 20_000_000, y: -20_000_000 },
      selectedNodeIds: ['node-a', 'node-a', '', 'node-b', 'x'.repeat(241)],
      ignored: 'must not survive',
    },
  });
  const update = await probeB.nextMessage(
    (message) => message.type === 'presence.update' && message.memberId === actorA.memberId,
    'normalized Presence update timed out',
  );
  assert.equal(update.connectionId, joinedA.ready.connectionId);
  assert.deepEqual(update.presence, {
    cursor: { x: 10_000_000, y: -10_000_000 },
    selectedNodeIds: ['node-a', 'node-b'],
  });

  const probeC = await openSocketProbe(fixture, actorC);
  const joinedC = await joinSocket(probeC, fixture.canvasId, 1);
  const snapshotA = joinedC.presence.members.find(
    (member) => member.connectionId === joinedA.ready.connectionId,
  );
  assert.equal(snapshotA.memberId, actorA.memberId);
  assert.deepEqual(snapshotA.presence, update.presence);

  const leftPromise = probeB.nextMessage(
    (message) => message.type === 'presence.left'
      && message.connectionId === joinedA.ready.connectionId,
    'connection-scoped Presence leave timed out',
  );
  await closeSocket(probeA.socket);
  const left = await leftPromise;
  assert.equal(left.memberId, actorA.memberId);

  const probeA2 = await openSocketProbe(fixture, actorA, { label: 'Presence A reconnect' });
  const joinedA2 = await joinSocket(probeA2, fixture.canvasId, 1);
  assert.notEqual(joinedA2.ready.connectionId, joinedA.ready.connectionId);
  const probeD = await openSocketProbe(fixture, actorD);
  const joinedD = await joinSocket(probeD, fixture.canvasId, 1);
  const reconnectedA = joinedD.presence.members.find(
    (member) => member.connectionId === joinedA2.ready.connectionId,
  );
  assert.ok(reconnectedA);
  assert.deepEqual(reconnectedA.presence, {});
  assert.equal(
    joinedD.presence.members.some((member) => member.connectionId === joinedA.ready.connectionId),
    false,
  );

  probeA2.send({
    type: 'presence.update',
    presence: { cursor: { x: 7, y: 9 }, selectedNodeIds: ['node-c'] },
  });
  const restored = await probeB.nextMessage(
    (message) => message.type === 'presence.update'
      && message.connectionId === joinedA2.ready.connectionId,
    'reconnected Presence update timed out',
  );
  assert.deepEqual(restored.presence, {
    cursor: { x: 7, y: 9 },
    selectedNodeIds: ['node-c'],
  });
});

test('F2 native heartbeat requires pong even when non-pong application traffic continues', {
  timeout: 8_000,
}, async (t) => {
  const fixture = await createFixture(t, {
    heartbeatIntervalMs: 40,
    heartbeatTimeoutMs: 120,
  });
  const healthy = await redeemActor(fixture, 'viewer', 'Healthy heartbeat');
  const unhealthy = await redeemActor(fixture, 'viewer', 'No native pong');
  const healthyProbe = await openSocketProbe(fixture, healthy);
  await healthyProbe.nextMessage(
    (message) => message.type === 'session.ready',
    'healthy heartbeat session.ready timed out',
  );
  await new Promise((resolve) => setTimeout(resolve, 360));
  assert.equal(healthyProbe.socket.readyState, WebSocket.OPEN);
  healthyProbe.send({ type: 'ping', nonce: 'healthy-app-ping' });
  await healthyProbe.nextMessage(
    (message) => message.type === 'pong' && message.nonce === 'healthy-app-ping',
    'healthy application pong timed out',
  );

  const unhealthyProbe = await openSocketProbe(fixture, unhealthy, {
    autoPong: false,
    label: 'native pong suppressed socket',
  });
  await unhealthyProbe.nextMessage(
    (message) => message.type === 'session.ready',
    'unhealthy heartbeat session.ready timed out',
  );
  const keepApplicationTrafficAlive = setInterval(() => {
    if (unhealthyProbe.socket.readyState === WebSocket.OPEN) {
      unhealthyProbe.send({ type: 'ping', nonce: `traffic-${Date.now()}` });
    }
  }, 20);
  try {
    const [notice, closed] = await Promise.all([
      unhealthyProbe.nextMessage(
        (message) => message.type === 'connection.timeout'
          && message.reason === 'heartbeat_timeout',
        'missing native pong did not emit connection.timeout',
        1_500,
      ),
      unhealthyProbe.waitForClose(1_500, 'missing native pong did not close the socket'),
    ]);
    assert.equal(notice.reason, 'heartbeat_timeout');
    assert.deepEqual(closed, { code: 4000, reason: 'heartbeat timeout' });
    await eventually(
      () => fixture.gateway.connectionCountForSession(unhealthy.id) === 0,
      500,
      'heartbeat-closed socket remained registered',
    );
  } finally {
    clearInterval(keepApplicationTrafficAlive);
  }
});

test('F2 refreshed session invalidation emits session.revoked and closes with 4001', async (t) => {
  const fixture = await createFixture(t);
  const actor = await redeemActor(fixture, 'editor', 'Naturally revoked session');
  const probe = await openSocketProbe(fixture, actor);
  await joinSocket(probe, fixture.canvasId, 1);
  const revoked = fixture.gateway.auth.revoke(actor.id, {
    actorId: 'local-owner',
    sessionId: 'local-management',
    expectedProjectId: fixture.projectId,
  });
  assert.ok(revoked);
  probe.send({ type: 'ping', nonce: 'discover-revocation' });
  const [notice, closed] = await Promise.all([
    probe.nextMessage(
      (message) => message.type === 'session.revoked',
      'refreshed revoked session did not receive session.revoked',
      1_000,
    ),
    probe.waitForClose(1_000, 'refreshed revoked session did not close'),
  ]);
  assert.match(notice.reason, /revok|expired|session/i);
  assert.equal(closed.code, 4001);
});

test('F2 role refresh and resource-scope invalidation use close codes 4002 and 4003', async (t) => {
  const fixture = await createFixture(t);
  const roleActor = await redeemActor(fixture, 'editor', 'Role changed actor');
  const roleProbe = await openSocketProbe(fixture, roleActor);
  await joinSocket(roleProbe, fixture.canvasId, 1);
  const roleClosed = roleProbe.waitForClose(1_000, 'role-changed socket did not close');
  const roleNotice = roleProbe.nextMessage(
    (message) => message.type === 'session.changed',
    'role-changed socket did not receive session.changed',
    1_000,
  );
  assert.equal(fixture.gateway.closeMemberConnections(
    roleActor.memberId,
    'member role changed',
    { code: 4002, messageType: 'session.changed' },
  ), 1);
  assert.equal((await roleNotice).reason, 'member role changed');
  assert.deepEqual(await roleClosed, { code: 4002, reason: 'member role changed' });

  const scopeActor = await redeemActor(fixture, 'viewer', 'Resource scope actor');
  const scopeProbe = await openSocketProbe(fixture, scopeActor);
  await joinSocket(scopeProbe, fixture.canvasId, 1);
  fixture.database.db.prepare(`
    UPDATE canvas_resource_grant_state
    SET trusted_revision = 0
    WHERE project_id = ? AND canvas_id = ?
  `).run(fixture.projectId, fixture.canvasId);
  scopeProbe.send({ type: 'ping', nonce: 'discover-resource-scope' });
  const scopeClosed = await scopeProbe.waitForClose(
    1_000,
    'resource-scope-invalid socket did not close',
  );
  assert.deepEqual(scopeClosed, { code: 4003, reason: 'resource scope unavailable' });
});

test('F2 session rotation closes the old socket with 4002 and the rotated cookie reconnects', async (t) => {
  const fixture = await createFixture(t);
  const actor = await redeemActor(fixture, 'editor', 'Rotating session');
  const probe = await openSocketProbe(fixture, actor);
  await joinSocket(probe, fixture.canvasId, 1);
  const rotation = await requestJson(`${fixture.baseUrl}/api/collab/session/rotate`, {
    method: 'POST',
    headers: { cookie: actor.cookie },
  });
  assert.equal(rotation.response.status, 200, JSON.stringify(rotation.payload));
  const setCookie = rotation.response.headers.get('set-cookie');
  assert.ok(setCookie);
  const rotatedCookie = setCookie.split(';')[0];
  assert.notEqual(rotatedCookie, actor.cookie);

  const [notice, closed] = await Promise.all([
    probe.nextMessage(
      (message) => message.type === 'session.changed',
      'rotated session did not receive session.changed',
      1_000,
    ),
    probe.waitForClose(1_000, 'rotated session old socket did not close'),
  ]);
  assert.match(notice.reason, /rotat|session/i);
  assert.equal(closed.code, 4002);

  const current = await requestJson(`${fixture.baseUrl}/api/collab/session`, {
    headers: { cookie: rotatedCookie },
  });
  assert.equal(current.response.status, 200, JSON.stringify(current.payload));
  assert.equal(current.payload.data.memberId, actor.memberId);
  assert.equal(current.payload.data.canvasId, actor.canvasId);
  assert.notEqual(current.payload.data.id, actor.id);

  const rotatedProbe = await openSocketProbe(fixture, {
    ...current.payload.data,
    cookie: rotatedCookie,
  });
  const joined = await joinSocket(rotatedProbe, fixture.canvasId, 1);
  assert.equal(joined.ready.session.id, current.payload.data.id);
});

test('F2 host stop sends a non-retryable notice and closes WebSockets with 4004', async (t) => {
  const fixture = await createFixture(t);
  const actor = await redeemActor(fixture, 'viewer', 'Host stop viewer');
  const probe = await openSocketProbe(fixture, actor);
  await joinSocket(probe, fixture.canvasId, 1);
  const stopPromise = fixture.gateway.stop();
  const [notice, closed, status] = await Promise.all([
    probe.nextMessage(
      (message) => message.type === 'gateway.stopping',
      'host stop notice timed out',
    ),
    probe.waitForClose(3_000, 'host stop close timed out'),
    stopPromise,
  ]);
  assert.equal(notice.reason, 'host_stopped');
  assert.equal(notice.retryable, false);
  assert.equal(notice.retryAfterMs, 0);
  assert.deepEqual(closed, { code: 4004, reason: 'gateway stopped' });
  assert.equal(status.running, false);
});

test('F2 gateway restart sends a retryable notice and closes old WebSockets with 1012', async (t) => {
  const fixture = await createFixture(t);
  const actor = await redeemActor(fixture, 'viewer', 'Gateway restart viewer');
  const probe = await openSocketProbe(fixture, actor);
  await joinSocket(probe, fixture.canvasId, 1);
  const oldPort = fixture.status.port;
  const restartPromise = fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  const [notice, closed, restarted] = await Promise.all([
    probe.nextMessage(
      (message) => message.type === 'gateway.stopping',
      'gateway restart notice timed out',
    ),
    probe.waitForClose(3_000, 'gateway restart close timed out'),
    restartPromise,
  ]);
  assert.equal(notice.reason, 'gateway_restarted');
  assert.equal(notice.retryable, true);
  assert.equal(notice.retryAfterMs, 500);
  assert.deepEqual(closed, { code: 1012, reason: 'gateway restarted' });
  assert.notEqual(restarted.port, oldPort);

  fixture.status = restarted;
  fixture.baseUrl = `http://127.0.0.1:${restarted.port}`;
  const reconnected = await openSocketProbe(fixture, actor, { label: 'post-restart socket' });
  const joined = await joinSocket(reconnected, fixture.canvasId, 1);
  assert.equal(joined.joined.canvasId, fixture.canvasId);
});

test('F2 Presence never crosses overlapping gateway server generations during restart', async (t) => {
  const fixture = await createFixture(t);
  const oldActor = await redeemActor(fixture, 'viewer', 'Old generation actor');
  const newActor = await redeemActor(fixture, 'viewer', 'New generation actor');
  const observerActor = await redeemActor(fixture, 'viewer', 'New generation observer');
  const oldProbe = await openSocketProbe(fixture, oldActor, { label: 'old generation socket' });
  const oldJoin = await joinSocket(oldProbe, fixture.canvasId, 1);
  oldProbe.send({
    type: 'presence.update',
    presence: { cursor: { x: 10, y: 20 }, selectedNodeIds: ['node-a'] },
  });

  const oldPort = fixture.status.port;
  const originalCloseServerResources = fixture.gateway.closeServerResources;
  let releaseCloseGate;
  let closeGateReleased = false;
  const closeGate = new Promise((resolve) => { releaseCloseGate = resolve; });
  const releaseGate = () => {
    if (closeGateReleased) return;
    closeGateReleased = true;
    releaseCloseGate();
  };
  fixture.gateway.closeServerResources = async function gatedCloseServerResources(...args) {
    await closeGate;
    return originalCloseServerResources.call(this, ...args);
  };
  const restartPromise = fixture.gateway.start({ host: '127.0.0.1', port: 0 });

  try {
    await eventually(
      () => fixture.gateway.port && fixture.gateway.port !== oldPort,
      2_000,
      'new gateway listener was not published before old generation cleanup',
    );
    fixture.status = { ...fixture.status, port: fixture.gateway.port };
    fixture.baseUrl = `http://127.0.0.1:${fixture.gateway.port}`;

    const newProbe = await openSocketProbe(fixture, newActor, { label: 'new generation socket' });
    const newJoin = await joinSocket(newProbe, fixture.canvasId, 1);
    assert.deepEqual(newJoin.presence.members, []);

    const observer = await openSocketProbe(fixture, observerActor, { label: 'new generation observer' });
    const observerJoin = await joinSocket(observer, fixture.canvasId, 1);
    assert.deepEqual(observerJoin.presence.members.map((member) => member.connectionId), [
      newJoin.ready.connectionId,
    ]);
    assert.doesNotMatch(JSON.stringify(observerJoin.presence), new RegExp(oldJoin.ready.connectionId));

    const noOldGenerationPresence = observer.expectNoMessage(
      (message) => ['presence.update', 'presence.left'].includes(message.type)
        && message.connectionId === oldJoin.ready.connectionId,
      400,
      'old gateway generation leaked Presence into the new generation',
    );
    oldProbe.send({
      type: 'presence.update',
      presence: { cursor: { x: 30, y: 40 }, selectedNodeIds: ['node-b'] },
    });

    newProbe.send({
      type: 'presence.update',
      presence: { cursor: { x: 50, y: 60 }, selectedNodeIds: ['node-a'] },
    });
    const newPresence = await observer.nextMessage(
      (message) => message.type === 'presence.update'
        && message.connectionId === newJoin.ready.connectionId,
      'new generation Presence update timed out',
    );
    assert.deepEqual(newPresence.presence.cursor, { x: 50, y: 60 });

    await closeSocket(newProbe.socket);
    const newLeft = await observer.nextMessage(
      (message) => message.type === 'presence.left'
        && message.connectionId === newJoin.ready.connectionId,
      'new generation Presence leave timed out',
    );
    assert.equal(newLeft.memberId, newActor.memberId);

    const oldNoticePromise = oldProbe.nextMessage(
      (message) => message.type === 'gateway.stopping',
      'old generation restart notice timed out',
    );
    const oldClosePromise = oldProbe.waitForClose(3_000, 'old generation did not close');
    releaseGate();
    const [oldNotice, oldClosed, restarted] = await Promise.all([
      oldNoticePromise,
      oldClosePromise,
      restartPromise,
      noOldGenerationPresence,
    ]);
    assert.equal(oldNotice.reason, 'gateway_restarted');
    assert.deepEqual(oldClosed, { code: 1012, reason: 'gateway restarted' });
    assert.equal(observer.socket.readyState, WebSocket.OPEN);

    fixture.status = restarted;
    fixture.baseUrl = `http://127.0.0.1:${restarted.port}`;
    const finalActor = await redeemActor(fixture, 'viewer', 'Post-restart actor');
    const finalProbe = await openSocketProbe(fixture, finalActor, { label: 'post-restart Presence probe' });
    const finalJoin = await joinSocket(finalProbe, fixture.canvasId, 1);
    const finalConnectionIds = finalJoin.presence.members.map((member) => member.connectionId);
    assert.ok(!finalConnectionIds.includes(oldJoin.ready.connectionId));
    assert.ok(!finalConnectionIds.includes(newJoin.ready.connectionId));
    assert.equal(finalConnectionIds.length, 1);
    assert.ok([...fixture.gateway.connections.values()].every((state) => (
      state.server === fixture.gateway.server
    )));
  } finally {
    releaseGate();
    await restartPromise.catch(() => {});
    fixture.gateway.closeServerResources = originalCloseServerResources;
  }
});
