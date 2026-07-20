const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');

const { CollaborationGateway } = require('../backend/src/collaboration/gateway');
const {
  createFixture,
  postOperation,
  redeemActor,
  requestJson,
} = require('./helpers/collaborationF2Fixture.cjs');

const PRIVATE_BROADCAST_DETAIL = 'C:\\Users\\private-owner\\broadcast.sqlite token=never-expose';

function assertCommittedResponse(result, status) {
  assert.equal(result.response.status, status, result.text);
  assert.equal(result.payload?.success, true, result.text);
  assert.doesNotMatch(result.text, /private-owner|broadcast\.sqlite|never-expose/i);
}

test('one broken WebSocket cannot stop later recipients during refresh, visibility, JSON, or send', () => {
  const gateway = Object.create(CollaborationGateway.prototype);
  const delivered = [];
  const makeSocket = (kind, send = (value) => delivered.push({ kind, value })) => ({
    readyState: WebSocket.OPEN,
    send,
  });
  const sockets = [
    makeSocket('refresh'),
    makeSocket('visibility'),
    makeSocket('json'),
    makeSocket('send', () => { throw new Error(PRIVATE_BROADCAST_DETAIL); }),
    makeSocket('good'),
  ];
  gateway.connections = new Map(sockets.map((socket) => [socket, {
    kind: socket === sockets[0] ? 'refresh'
      : socket === sockets[1] ? 'visibility'
        : socket === sockets[2] ? 'json'
          : socket === sockets[3] ? 'send'
            : 'good',
    canvasId: 'canvas-safe-broadcast',
  }]));
  gateway.refreshConnectionSession = (_socket, state) => {
    if (state.kind === 'refresh') throw new Error(PRIVATE_BROADCAST_DETAIL);
    return { projectId: 'project-safe-broadcast', memberId: state.kind, role: 'editor' };
  };
  gateway.publicReviewVisibleValue = (session, message) => {
    if (session.memberId === 'visibility') throw new Error(PRIVATE_BROADCAST_DETAIL);
    if (session.memberId === 'json') return { ...message, impossible: 1n };
    return message;
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    assert.equal(gateway.broadcast(
      'project-safe-broadcast',
      'canvas-safe-broadcast',
      { type: 'durable.changed' },
    ), 1);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].kind, 'good');
  assert.equal(JSON.parse(delivered[0].value).type, 'durable.changed');
  assert.equal(warnings.length, 4);
  assert.doesNotMatch(warnings.join('\n'), /private-owner|broadcast\.sqlite|never-expose/i);
});

test('committed collaboration mutations remain successful when every live notification throws', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-committed-broadcast-b2',
    canvasId: 'canvas-committed-broadcast-b2',
    snapshot: {
      name: 'Committed broadcast boundary',
      nodes: [
        { id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: { text: 'before' } },
        {
          id: 'image-node',
          type: 'image',
          position: { x: 200, y: 0 },
          data: { model: 'gpt-image-2', apiModel: 'gpt-image-2-all' },
        },
        {
          id: 'subflow-node',
          type: 'subflow',
          position: { x: 400, y: 0 },
          data: { definitionId: 'committed-subflow', definitionVersion: 1 },
        },
      ],
      edges: [],
    },
  });
  const definition = {
    id: 'committed-subflow',
    version: 1,
    projectId: fixture.projectId,
    name: 'Committed subflow v1',
    description: '',
    tags: [],
    nodes: [{ id: 'inside', type: 'text', position: { x: 0, y: 0 }, data: { text: 'v1' } }],
    edges: [],
    inputs: [],
    outputs: [],
    exposedParameters: [],
    requiredCapabilities: [],
    assetRefs: [],
  };
  fixture.database.saveSubflowDefinition(definition, {
    expectedRevision: 0,
    actorId: 'local-owner',
    sessionId: 'committed-broadcast-fixture',
    changeSummary: 'create committed subflow',
  });
  fixture.database.initializeCanvasResourceGrantsForSharing(
    fixture.projectId,
    fixture.canvasId,
    { actorId: 'local-owner', sessionId: 'committed-broadcast-fixture' },
  );
  const editor = await redeemActor(fixture, 'editor', 'Committed broadcast editor');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  fixture.gateway.broadcast = () => { throw new Error(PRIVATE_BROADCAST_DETAIL); };
  fixture.gateway.dispatchReviewNotifications = () => { throw new Error(PRIVATE_BROADCAST_DETAIL); };
  try {
    const operations = await postOperation(fixture, editor, JSON.stringify({
      baseRevision: 1,
      operations: [{
        opId: 'committed-broadcast-operation',
        clientSeq: 1,
        timestamp: Date.now(),
        type: 'node.move',
        payload: { nodeId: 'node-a', position: { x: 40, y: 20 } },
      }],
    }));
    assertCommittedResponse(operations, 200);
    assert.equal(fixture.database.getCanvas(fixture.canvasId).revision, 2);

    const patch = {
      schema: 't8-canvas-patch-v1',
      id: 'committed-broadcast-patch',
      baseRevision: 2,
      summary: 'post-commit broadcast failure must not roll back',
      diagnosticsResolved: ['layout.invalid-position'],
      requiresConfirmation: true,
      operations: [{
        type: 'node.move',
        payload: { nodeId: 'node-a', position: { x: 80, y: 40 } },
      }],
    };
    const preview = await requestJson(
      `${fixture.baseUrl}/api/collab/canvases/${fixture.canvasId}/patches/preview`,
      {
        method: 'POST',
        headers: { cookie: editor.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ patch }),
      },
    );
    assertCommittedResponse(preview, 200);
    const appliedPatch = await requestJson(
      `${fixture.baseUrl}/api/collab/canvases/${fixture.canvasId}/patches`,
      {
        method: 'POST',
        headers: { cookie: editor.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ patch, previewDigest: preview.payload.data.previewDigest, confirmed: true }),
      },
    );
    assertCommittedResponse(appliedPatch, 200);
    assert.equal(fixture.database.getCanvas(fixture.canvasId).revision, 3);

    const review = await requestJson(`${fixture.baseUrl}/api/collab/reviews`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        canvasId: fixture.canvasId,
        expectedCanvasRevision: 3,
        anchor: { kind: 'node', nodeId: 'node-a' },
        body: 'durable review survives notification failure',
      }),
    });
    assertCommittedResponse(review, 201);
    assert.equal(fixture.database.getReviewThread(review.payload.data.id)?.id, review.payload.data.id);

    const published = await requestJson(
      `${fixture.baseUrl}/api/collab/subflows/${definition.id}/publish`,
      {
        method: 'POST',
        headers: { cookie: editor.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          baseRevision: 1,
          changeSummary: 'committed v2 survives notification failure',
          definition: { ...definition, name: 'Committed subflow v2' },
        }),
      },
    );
    assertCommittedResponse(published, 201);
    assert.equal(fixture.database.listSubflowVersions(definition.id, fixture.projectId).length, 2);

    const restored = await requestJson(
      `${fixture.baseUrl}/api/collab/canvases/${fixture.canvasId}/history/1/restore`,
      {
        method: 'POST',
        headers: { cookie: editor.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevision: 3 }),
      },
    );
    assertCommittedResponse(restored, 200);
    assert.equal(fixture.database.getCanvas(fixture.canvasId).revision, 4);

    const createdIntent = await requestJson(`${fixture.baseUrl}/api/collab/run-intents`, {
      method: 'POST',
      headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        canvasId: fixture.canvasId,
        canvasRevision: 4,
        nodeIds: ['image-node'],
        idempotencyKey: 'committed-broadcast-intent-create',
      }),
    });
    assertCommittedResponse(createdIntent, 202);
    const durableIntent = fixture.database.getRunIntent(createdIntent.payload.data.id);
    assert.ok(durableIntent);

    const cancelledIntent = await requestJson(
      `${fixture.baseUrl}/api/collab/run-intents/${durableIntent.id}/cancel`,
      {
        method: 'POST',
        headers: { cookie: editor.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ expectedQueueRevision: durableIntent.queueRevision }),
      },
    );
    assertCommittedResponse(cancelledIntent, 200);
    assert.equal(fixture.database.getRunIntent(durableIntent.id).status, 'cancelled');
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.length >= 7);
  assert.doesNotMatch(warnings.join('\n'), /private-owner|broadcast\.sqlite|never-expose/i);
});
