const assert = require('node:assert/strict');
const test = require('node:test');

const {
  clone,
  createFixture,
  getCanvas,
  getSync,
  joinSocket,
  openSocketProbe,
  operationCounts,
  postOperation,
  reconstructFromSync,
  redeemActor,
} = require('./helpers/collaborationF2Fixture.cjs');

function batchBody(baseRevision, operations) {
  return JSON.stringify({ baseRevision, operations });
}

function expectedAcknowledgement(actor, baseRevision, operation, index, duplicate) {
  return {
    opId: operation.opId,
    projectId: actor.projectId,
    canvasId: actor.canvasId,
    baseRevision,
    revision: baseRevision + index + 1,
    actorId: actor.memberId,
    clientSeq: operation.clientSeq,
    type: operation.type,
    payload: operation.payload,
    timestamp: operation.timestamp,
    duplicate,
  };
}

function assertNoPublicSessionId(value, label) {
  assert.doesNotMatch(JSON.stringify(value), /"sessionId"/, `${label} leaked sessionId`);
}

async function redeemThreeEditors(fixture, prefix) {
  const editorA = await redeemActor(fixture, 'editor', `${prefix} A`);
  const editorB = await redeemActor(fixture, 'editor', `${prefix} B`);
  const editorC = await redeemActor(fixture, 'editor', `${prefix} C`);
  return [editorA, editorB, editorC];
}

async function joinThreeEditors(fixture, editors, revision) {
  const probes = [];
  for (const [index, editor] of editors.entries()) {
    const probe = await openSocketProbe(fixture, editor, { label: `F3 editor ${index + 1}` });
    await joinSocket(probe, fixture.canvasId, revision);
    probes.push(probe);
  }
  return probes;
}

function moveOperation(opId, clientSeq, timestamp, nodeId, position) {
  return {
    opId,
    clientSeq,
    timestamp,
    type: 'node.move',
    payload: { nodeId, position },
  };
}

function edgeAddOperation(opId, clientSeq, timestamp, edge) {
  return {
    opId,
    clientSeq,
    timestamp,
    type: 'edge.add',
    payload: { edge },
  };
}

test('F3 three editors receive a valid structural transaction, complete ACKs, one broadcast, and one audit per operation', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-f3-structural-batch',
    canvasId: 'canvas-f3-structural-batch',
  });
  const editors = await redeemThreeEditors(fixture, 'Structural batch editor');
  const probes = await joinThreeEditors(fixture, editors, 1);
  const operations = [
    {
      opId: 'f3-valid-node-add',
      clientSeq: 101,
      timestamp: 1_900_000_000_101,
      type: 'node.add',
      payload: {
        node: {
          id: 'node-f3-new',
          type: 'text',
          position: { x: 480, y: 120 },
          data: { text: 'new' },
        },
      },
    },
    {
      opId: 'f3-valid-node-patch',
      clientSeq: 102,
      timestamp: 1_900_000_000_102,
      type: 'node.patch',
      payload: { nodeId: 'node-f3-new', dataPatch: { sharedColor: '#4f46e5' } },
    },
    edgeAddOperation('f3-valid-edge-add', 103, 1_900_000_000_103, {
      id: 'edge-f3-valid',
      source: 'node-a',
      target: 'node-f3-new',
      type: 'default',
    }),
  ];
  const exactBody = batchBody(1, operations);

  const applied = await postOperation(fixture, editors[0], exactBody);
  assert.equal(applied.response.status, 200, JSON.stringify(applied.payload));
  assert.deepEqual(
    applied.payload.data.acknowledgements,
    operations.map((operation, index) => expectedAcknowledgement(
      editors[0],
      1,
      operation,
      index,
      false,
    )),
  );
  assert.deepEqual(applied.payload.data.acknowledgements.map((item) => item.revision), [2, 3, 4]);
  assertNoPublicSessionId(applied.payload.data.acknowledgements, 'operation ACKs');
  assert.equal(applied.payload.data.document.revision, 4);
  assert.equal(applied.payload.data.document.nodes.some((node) => node.id === 'node-f3-new'), true);
  assert.equal(applied.payload.data.document.edges.some((edge) => edge.id === 'edge-f3-valid'), true);

  for (const probe of probes.slice(1)) {
    const event = await probe.nextMessage(
      (message) => message.type === 'canvas.operations' && message.revision === 4,
      'valid structural batch broadcast timed out',
    );
    assert.deepEqual(event.operations.map((item) => [item.opId, item.revision]), [
      ['f3-valid-node-add', 2],
      ['f3-valid-node-patch', 3],
      ['f3-valid-edge-add', 4],
    ]);
    assertNoPublicSessionId(event, 'canvas.operations broadcast');
  }

  const sync = await getSync(fixture, editors[2], 1);
  assert.equal(sync.response.status, 200, JSON.stringify(sync.payload));
  assert.equal(sync.payload.data.mode, 'operations');
  assert.deepEqual(sync.payload.data.operations.map((item) => [item.opId, item.revision]), [
    ['f3-valid-node-add', 2],
    ['f3-valid-node-patch', 3],
    ['f3-valid-edge-add', 4],
  ]);
  assert.equal(
    sync.payload.data.operations[0].payload.node.entityUid,
    applied.payload.data.document.nodes.find((node) => node.id === 'node-f3-new').entityUid,
    'node.add delta must carry the generated authoritative entityUid',
  );
  assert.equal(
    sync.payload.data.operations[2].payload.edge.entityUid,
    applied.payload.data.document.edges.find((edge) => edge.id === 'edge-f3-valid').entityUid,
    'edge.add delta must carry the generated authoritative entityUid',
  );
  assertNoPublicSessionId(sync.payload, 'incremental sync');

  const retried = await postOperation(fixture, editors[0], exactBody);
  assert.equal(retried.response.status, 200, JSON.stringify(retried.payload));
  assert.deepEqual(
    retried.payload.data.acknowledgements,
    operations.map((operation, index) => expectedAcknowledgement(
      editors[0],
      1,
      operation,
      index,
      true,
    )),
  );
  assert.equal(retried.payload.data.document.revision, 4);
  await Promise.all(probes.slice(1).map((probe) => probe.expectNoMessage(
    (message) => message.type === 'canvas.operations',
    250,
    'exact ordered-batch retry emitted a second broadcast',
  )));
  for (const operation of operations) {
    assert.deepEqual(operationCounts(fixture.database, operation.opId), {
      operation: 1,
      idempotency: 1,
      audits: 1,
    });
  }
  assert.equal(
    fixture.database.db.prepare('SELECT COUNT(*) AS count FROM canvas_operation_batches').get().count,
    1,
  );

  probes[0].send({
    type: 'presence.update',
    presence: {
      cursor: { x: 12, y: 34 },
      selectedNodeIds: ['node-f3-new'],
      drag: {
        nodeId: 'node-f3-new',
        dragId: 'drag-f3-public',
        seq: 7,
        position: { x: 500, y: 140 },
      },
    },
  });
  for (const probe of probes.slice(1)) {
    const presence = await probe.nextMessage(
      (message) => message.type === 'presence.update'
        && message.memberId === editors[0].memberId,
      'F3 drag Presence update timed out',
    );
    assert.deepEqual(presence.presence.drag, {
      nodeId: 'node-f3-new',
      dragId: 'drag-f3-public',
      seq: 7,
      position: { x: 500, y: 140 },
    });
    assertNoPublicSessionId(presence, 'Presence update');
  }
});

test('F3 gateway rejects unknown handles, incompatible kinds, self edges, and canonical duplicate signatures atomically', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-f3-static-authority',
    canvasId: 'canvas-f3-static-authority',
    snapshot: {
      nodes: [
        { id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: {} },
        { id: 'node-b', type: 'text', position: { x: 160, y: 0 }, data: {} },
        { id: 'node-board', type: 'drawing-board', position: { x: 320, y: 0 }, data: {} },
      ],
      edges: [{
        id: 'edge-existing',
        type: 'default',
        source: 'node-a',
        target: 'node-b',
      }],
    },
  });
  const editors = await redeemThreeEditors(fixture, 'Static authority editor');
  const sourceUid = fixture.database.getCanvas(fixture.canvasId)
    .nodes.find((node) => node.id === 'node-a').entityUid;
  const targetUid = fixture.database.getCanvas(fixture.canvasId)
    .nodes.find((node) => node.id === 'node-b').entityUid;
  const cases = [
    {
      actor: editors[0],
      operation: edgeAddOperation('f3-reject-unknown-handle', 201, 1_900_000_000_201, {
        id: 'edge-unknown-handle',
        source: 'node-a',
        sourceHandle: 'missing-output',
        target: 'node-b',
      }),
      status: 422,
      code: 'collaboration_structure_handle_unknown',
    },
    {
      actor: editors[1],
      operation: edgeAddOperation('f3-reject-type', 202, 1_900_000_000_202, {
        id: 'edge-type-invalid',
        source: 'node-a',
        target: 'node-board',
      }),
      status: 422,
      code: 'collaboration_structure_port_type_incompatible',
    },
    {
      actor: editors[2],
      operation: edgeAddOperation('f3-reject-self', 203, 1_900_000_000_203, {
        id: 'edge-self-invalid',
        source: 'node-a',
        target: sourceUid,
      }),
      status: 422,
      code: 'collaboration_structure_self_edge',
    },
    {
      actor: editors[0],
      operation: edgeAddOperation('f3-reject-duplicate', 204, 1_900_000_000_204, {
        id: 'edge-duplicate-invalid',
        source: sourceUid,
        target: targetUid,
      }),
      status: 409,
      code: 'collaboration_structure_duplicate_edge',
    },
  ];

  for (const item of cases) {
    const result = await postOperation(
      fixture,
      item.actor,
      batchBody(1, [item.operation]),
    );
    assert.equal(result.response.status, item.status, JSON.stringify(result.payload));
    assert.equal(result.payload.code, item.code);
    assert.equal(result.payload.currentRevision, undefined);
    assert.deepEqual(operationCounts(fixture.database, item.operation.opId), {
      operation: 0,
      idempotency: 0,
      audits: 0,
    });
  }
  assert.equal(fixture.database.getCanvas(fixture.canvasId).revision, 1);
  assert.deepEqual(
    fixture.database.getCanvas(fixture.canvasId).edges.map((edge) => edge.id),
    ['edge-existing'],
  );
  assert.equal(
    fixture.database.db.prepare('SELECT COUNT(*) AS count FROM canvas_operation_batches').get().count,
    0,
  );
});

test('F3 same-revision finite-capacity competition commits one editor and rejects the other before and after rebase', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-f3-capacity-race',
    canvasId: 'canvas-f3-capacity-race',
  });
  const definition = fixture.database.saveSubflowDefinition({
    id: 'subflow-f3-capacity-one',
    projectId: fixture.projectId,
    name: 'Single prompt capacity',
    description: '',
    tags: [],
    nodes: [{
      id: 'subflow-f3-capacity-target',
      type: 'text',
      position: { x: 0, y: 0 },
      data: {},
    }],
    edges: [],
    inputs: [{
      id: 'prompt',
      kinds: ['text'],
      required: false,
      minConnections: 0,
      maxConnections: 1,
      internalNodeId: 'subflow-f3-capacity-target',
      internalHandle: 'text-in',
    }],
    outputs: [],
    exposedParameters: [],
    requiredCapabilities: [],
    assetRefs: [],
  }, {
    expectedRevision: 0,
    actorId: 'local-owner',
    sessionId: 'f3-capacity-setup',
    grantCanvasId: fixture.canvasId,
  });
  const editors = await redeemThreeEditors(fixture, 'Capacity race editor');
  const probes = await joinThreeEditors(fixture, editors, 1);
  const addSubflow = {
    opId: 'f3-capacity-node-add',
    clientSeq: 301,
    timestamp: 1_900_000_000_301,
    type: 'node.add',
    payload: {
      node: {
        id: 'node-capacity-subflow',
        type: 'subflow',
        position: { x: 520, y: 80 },
        data: { definitionId: definition.id, definitionVersion: definition.version },
      },
    },
  };
  const added = await postOperation(fixture, editors[0], batchBody(1, [addSubflow]));
  assert.equal(added.response.status, 200, JSON.stringify(added.payload));
  for (const probe of probes.slice(1)) {
    await probe.nextMessage(
      (message) => message.type === 'canvas.operations' && message.revision === 2,
      'subflow node add broadcast timed out',
    );
  }

  const contenders = [
    {
      actor: editors[1],
      operation: edgeAddOperation('f3-capacity-contender-b', 302, 1_900_000_000_302, {
        id: 'edge-capacity-b',
        source: 'node-a',
        target: 'node-capacity-subflow',
        targetHandle: 'prompt',
      }),
    },
    {
      actor: editors[2],
      operation: edgeAddOperation('f3-capacity-contender-c', 303, 1_900_000_000_303, {
        id: 'edge-capacity-c',
        source: 'node-b',
        target: 'node-capacity-subflow',
        targetHandle: 'prompt',
      }),
    },
  ];
  const results = await Promise.all(contenders.map(async (contender) => ({
    ...contender,
    result: await postOperation(fixture, contender.actor, batchBody(2, [contender.operation])),
  })));
  assert.deepEqual(results.map((item) => item.result.response.status).sort((a, b) => a - b), [200, 409]);
  const winner = results.find((item) => item.result.response.status === 200);
  const loser = results.find((item) => item.result.response.status === 409);
  assert.ok(winner);
  assert.ok(loser);
  assert.equal(loser.result.payload.code, 'revision_conflict');
  assert.equal(loser.result.payload.currentRevision, 3);
  assertNoPublicSessionId(winner.result.payload.data.acknowledgements, 'capacity winner ACK');

  for (const probe of probes) {
    const event = await probe.nextMessage(
      (message) => message.type === 'canvas.operations' && message.revision === 3,
      'capacity winner broadcast timed out',
    );
    assert.deepEqual(event.operations.map((item) => item.opId), [winner.operation.opId]);
    assertNoPublicSessionId(event, 'capacity winner broadcast');
  }

  const current = fixture.database.getCanvas(fixture.canvasId);
  assert.equal(current.revision, 3);
  assert.deepEqual(current.edges.map((edge) => edge.id), [winner.operation.payload.edge.id]);
  assert.deepEqual(operationCounts(fixture.database, winner.operation.opId), {
    operation: 1,
    idempotency: 1,
    audits: 1,
  });
  assert.deepEqual(operationCounts(fixture.database, loser.operation.opId), {
    operation: 0,
    idempotency: 0,
    audits: 0,
  });

  const rebasedLoser = await postOperation(
    fixture,
    loser.actor,
    batchBody(3, [loser.operation]),
  );
  assert.equal(rebasedLoser.response.status, 409, JSON.stringify(rebasedLoser.payload));
  assert.equal(rebasedLoser.payload.code, 'collaboration_structure_port_capacity_exceeded');
  assert.equal(fixture.database.getCanvas(fixture.canvasId).revision, 3);
  assert.deepEqual(operationCounts(fixture.database, loser.operation.opId), {
    operation: 0,
    idempotency: 0,
    audits: 0,
  });
});

test('F3 same-node and different-node stale moves converge through explicit 409, sync, and rebase across three editors', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-f3-move-convergence',
    canvasId: 'canvas-f3-move-convergence',
  });
  const editors = await redeemThreeEditors(fixture, 'Move convergence editor');
  const initial = clone(await getCanvas(fixture, editors[0]));

  const sameWinner = moveOperation(
    'f3-same-node-winner',
    401,
    1_900_000_000_401,
    'node-a',
    { x: 100, y: 110 },
  );
  const sameLoser = moveOperation(
    'f3-same-node-loser',
    402,
    1_900_000_000_402,
    'node-a',
    { x: 200, y: 210 },
  );
  const sameFirst = await postOperation(fixture, editors[0], batchBody(1, [sameWinner]));
  assert.equal(sameFirst.response.status, 200, JSON.stringify(sameFirst.payload));
  const sameStale = await postOperation(fixture, editors[1], batchBody(1, [sameLoser]));
  assert.equal(sameStale.response.status, 409, JSON.stringify(sameStale.payload));
  assert.equal(sameStale.payload.code, 'revision_conflict');
  assert.equal(sameStale.payload.currentRevision, 2);
  assert.deepEqual(operationCounts(fixture.database, sameLoser.opId), {
    operation: 0,
    idempotency: 0,
    audits: 0,
  });

  const sameSync = await getSync(fixture, editors[1], initial.revision);
  assert.equal(sameSync.response.status, 200, JSON.stringify(sameSync.payload));
  assertNoPublicSessionId(sameSync.payload, 'same-node recovery sync');
  const afterWinner = reconstructFromSync(initial, sameSync.payload.data);
  assert.equal(afterWinner.revision, 2);
  const sameRebased = await postOperation(fixture, editors[1], batchBody(2, [sameLoser]));
  assert.equal(sameRebased.response.status, 200, JSON.stringify(sameRebased.payload));
  assert.equal(sameRebased.payload.data.document.revision, 3);
  assert.deepEqual(
    sameRebased.payload.data.document.nodes.find((node) => node.id === 'node-a').position,
    { x: 200, y: 210 },
  );

  const thirdSameSync = await getSync(fixture, editors[2], 1);
  const thirdSameDocument = reconstructFromSync(initial, thirdSameSync.payload.data);
  assert.deepEqual(thirdSameDocument.nodes, sameRebased.payload.data.document.nodes);
  assert.equal(thirdSameDocument.revision, 3);

  const differentBase = clone(sameRebased.payload.data.document);
  const differentWinner = moveOperation(
    'f3-different-node-winner',
    403,
    1_900_000_000_403,
    'node-b',
    { x: 300, y: 310 },
  );
  const differentLoser = moveOperation(
    'f3-different-node-loser',
    404,
    1_900_000_000_404,
    'node-c',
    { x: 400, y: 410 },
  );
  const differentFirst = await postOperation(fixture, editors[0], batchBody(3, [differentWinner]));
  assert.equal(differentFirst.response.status, 200, JSON.stringify(differentFirst.payload));
  const differentStale = await postOperation(fixture, editors[2], batchBody(3, [differentLoser]));
  assert.equal(differentStale.response.status, 409, JSON.stringify(differentStale.payload));
  assert.equal(differentStale.payload.code, 'revision_conflict');
  assert.equal(differentStale.payload.currentRevision, 4);

  const differentSync = await getSync(fixture, editors[2], 3);
  assertNoPublicSessionId(differentSync.payload, 'different-node recovery sync');
  const afterDifferentWinner = reconstructFromSync(differentBase, differentSync.payload.data);
  assert.equal(afterDifferentWinner.revision, 4);
  const differentRebased = await postOperation(fixture, editors[2], batchBody(4, [differentLoser]));
  assert.equal(differentRebased.response.status, 200, JSON.stringify(differentRebased.payload));
  assert.equal(differentRebased.payload.data.document.revision, 5);

  const observerSync = await getSync(fixture, editors[1], 3);
  const converged = reconstructFromSync(differentBase, observerSync.payload.data);
  assert.equal(converged.revision, 5);
  assert.deepEqual(converged.nodes.find((node) => node.id === 'node-a').position, { x: 200, y: 210 });
  assert.deepEqual(converged.nodes.find((node) => node.id === 'node-b').position, { x: 300, y: 310 });
  assert.deepEqual(converged.nodes.find((node) => node.id === 'node-c').position, { x: 400, y: 410 });
  assert.deepEqual(converged.nodes, differentRebased.payload.data.document.nodes);
  for (const operation of [sameWinner, sameLoser, differentWinner, differentLoser]) {
    assert.deepEqual(operationCounts(fixture.database, operation.opId), {
      operation: 1,
      idempotency: 1,
      audits: 1,
    });
  }
});

test('F3 delete wins after stale move sync, publishes safe tombstones, and requires explicit node plus edge restore', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-f3-delete-restore',
    canvasId: 'canvas-f3-delete-restore',
    snapshot: {
      nodes: [
        { id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: { text: 'A' } },
        { id: 'node-b', type: 'text', position: { x: 160, y: 0 }, data: { text: 'B' } },
        { id: 'node-c', type: 'text', position: { x: 320, y: 0 }, data: { text: 'C' } },
      ],
      edges: [{
        id: 'edge-a-b',
        type: 'default',
        source: 'node-a',
        target: 'node-b',
      }],
    },
  });
  const editors = await redeemThreeEditors(fixture, 'Delete restore editor');
  const initial = clone(await getCanvas(fixture, editors[0]));
  const move = moveOperation(
    'f3-delete-race-move',
    501,
    1_900_000_000_501,
    'node-a',
    { x: 50, y: 60 },
  );
  const deletion = {
    opId: 'f3-delete-race-delete',
    clientSeq: 502,
    timestamp: 1_900_000_000_502,
    type: 'node.delete',
    payload: { nodeId: 'node-a' },
  };
  const moved = await postOperation(fixture, editors[0], batchBody(1, [move]));
  assert.equal(moved.response.status, 200, JSON.stringify(moved.payload));
  const afterMove = clone(moved.payload.data.document);
  const staleDelete = await postOperation(fixture, editors[1], batchBody(1, [deletion]));
  assert.equal(staleDelete.response.status, 409, JSON.stringify(staleDelete.payload));
  assert.equal(staleDelete.payload.code, 'revision_conflict');
  assert.deepEqual(operationCounts(fixture.database, deletion.opId), {
    operation: 0,
    idempotency: 0,
    audits: 0,
  });

  const deleteSync = await getSync(fixture, editors[1], 1);
  const deleteBase = reconstructFromSync(initial, deleteSync.payload.data);
  assert.equal(deleteBase.revision, 2);
  const deleted = await postOperation(fixture, editors[1], batchBody(deleteBase.revision, [deletion]));
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.data.document.revision, 3);
  assert.equal(deleted.payload.data.document.nodes.some((node) => node.id === 'node-a'), false);
  assert.equal(deleted.payload.data.document.edges.some((edge) => edge.id === 'edge-a-b'), false);
  const nodeTombstone = deleted.payload.data.document.tombstones.nodes['node-a'];
  const edgeTombstone = deleted.payload.data.document.tombstones.edges['edge-a-b'];
  assert.ok(nodeTombstone?.entityUid);
  assert.equal(nodeTombstone.entityType, 'text');
  assert.ok(edgeTombstone?.entityUid);
  assert.equal(edgeTombstone.entityType, 'default');
  assert.equal(edgeTombstone.source, 'node-a');
  assert.equal(edgeTombstone.target, 'node-b');
  assertNoPublicSessionId(deleted.payload.data.document.tombstones, 'public tombstones');
  assert.equal(
    fixture.database.getCanvas(fixture.canvasId).tombstones.nodes['node-a'].sessionId,
    editors[1].id,
    'internal tombstone should retain its transaction identity',
  );
  const deletionSync = await getSync(fixture, editors[0], deleteBase.revision);
  assert.equal(deletionSync.response.status, 200, JSON.stringify(deletionSync.payload));
  assert.equal(deletionSync.payload.data.mode, 'operations');
  const convergedDeletion = reconstructFromSync(deleteBase, deletionSync.payload.data);
  assert.deepEqual(convergedDeletion.nodes, deleted.payload.data.document.nodes);
  assert.deepEqual(convergedDeletion.edges, deleted.payload.data.document.edges);
  const convergedPublicTombstones = clone(convergedDeletion.tombstones);
  for (const records of [convergedPublicTombstones.nodes, convergedPublicTombstones.edges]) {
    for (const tombstone of Object.values(records)) delete tombstone.sessionId;
  }
  assert.deepEqual(convergedPublicTombstones, deleted.payload.data.document.tombstones);

  const blockedMove = moveOperation(
    'f3-move-after-delete',
    503,
    1_900_000_000_503,
    'node-a',
    { x: 70, y: 80 },
  );
  const blocked = await postOperation(fixture, editors[2], batchBody(3, [blockedMove]));
  assert.equal(blocked.response.status, 400, JSON.stringify(blocked.payload));
  assert.equal(blocked.payload.code, 'object_deleted');
  assert.deepEqual(operationCounts(fixture.database, blockedMove.opId), {
    operation: 0,
    idempotency: 0,
    audits: 0,
  });

  const restoreOperations = [
    {
      opId: 'f3-explicit-node-restore',
      clientSeq: 504,
      timestamp: 1_900_000_000_504,
      type: 'node.restore',
      payload: {
        node: {
          id: 'node-a',
          type: nodeTombstone.entityType,
          position: { x: 90, y: 100 },
          data: { text: 'restored' },
        },
      },
    },
    {
      opId: 'f3-explicit-edge-restore',
      clientSeq: 505,
      timestamp: 1_900_000_000_505,
      type: 'edge.restore',
      payload: {
        edge: {
          id: 'edge-a-b',
          type: edgeTombstone.entityType,
          source: edgeTombstone.source,
          target: edgeTombstone.target,
        },
      },
    },
  ];
  const restored = await postOperation(fixture, editors[2], batchBody(3, restoreOperations));
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.deepEqual(restored.payload.data.acknowledgements.map((item) => item.revision), [4, 5]);
  assertNoPublicSessionId(restored.payload.data.acknowledgements, 'restore ACKs');
  assert.equal(restored.payload.data.document.revision, 5);
  assert.equal(restored.payload.data.document.nodes.some((node) => node.id === 'node-a'), true);
  assert.equal(restored.payload.data.document.edges.some((edge) => edge.id === 'edge-a-b'), true);
  assert.equal(restored.payload.data.document.tombstones.nodes['node-a'], undefined);
  assert.equal(restored.payload.data.document.tombstones.edges['edge-a-b'], undefined);

  const recovery = await getSync(fixture, editors[0], afterMove.revision);
  assert.equal(recovery.response.status, 200, JSON.stringify(recovery.payload));
  assert.deepEqual(recovery.payload.data.operations.map((item) => [item.type, item.revision]), [
    ['node.delete', 3],
    ['node.restore', 4],
    ['edge.restore', 5],
  ]);
  assert.equal(
    recovery.payload.data.operations[1].payload.node.entityUid,
    nodeTombstone.entityUid,
    'node.restore delta must restore the authoritative tombstone entityUid even when the request omitted it',
  );
  assert.equal(
    recovery.payload.data.operations[2].payload.edge.entityUid,
    edgeTombstone.entityUid,
    'edge.restore delta must restore the authoritative tombstone entityUid even when the request omitted it',
  );
  assert.deepEqual(
    recovery.payload.data.operations[1].payload.node.legacyAliases,
    ['node-a'],
    'node.restore delta must carry the canonical project identity aliases',
  );
  assert.deepEqual(
    recovery.payload.data.operations[2].payload.edge.legacyAliases,
    ['edge-a-b'],
    'edge.restore delta must carry the canonical project identity aliases',
  );
  const restoredNodeA = restored.payload.data.document.nodes.find((node) => node.id === 'node-a');
  const restoredNodeB = restored.payload.data.document.nodes.find((node) => node.id === 'node-b');
  assert.equal(recovery.payload.data.operations[2].payload.edge.sourceEntityUid, restoredNodeA.entityUid);
  assert.equal(recovery.payload.data.operations[2].payload.edge.targetEntityUid, restoredNodeB.entityUid);
  assertNoPublicSessionId(recovery.payload, 'delete and restore sync');
  const converged = reconstructFromSync(afterMove, recovery.payload.data);
  assert.deepEqual(converged.nodes, restored.payload.data.document.nodes);
  assert.deepEqual(converged.edges, restored.payload.data.document.edges);
  assert.deepEqual(converged.tombstones, restored.payload.data.document.tombstones);

  const viewer = await redeemActor(fixture, 'viewer', 'F3 denied viewer');
  const reviewer = await redeemActor(fixture, 'reviewer', 'F3 denied reviewer');
  for (const [actor, suffix] of [[viewer, 'viewer'], [reviewer, 'reviewer']]) {
    const deniedOperation = moveOperation(
      `f3-role-denied-${suffix}`,
      suffix === 'viewer' ? 506 : 507,
      suffix === 'viewer' ? 1_900_000_000_506 : 1_900_000_000_507,
      'node-b',
      { x: 600, y: 610 },
    );
    const denied = await postOperation(fixture, actor, batchBody(5, [deniedOperation]));
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.deepEqual(operationCounts(fixture.database, deniedOperation.opId), {
      operation: 0,
      idempotency: 0,
      audits: 0,
    });
  }
  assert.equal(fixture.database.getCanvas(fixture.canvasId).revision, 5);
});
