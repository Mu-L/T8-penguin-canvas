const assert = require('node:assert/strict');
const test = require('node:test');

const { COMMON_OPERATION_BATCH_CONTRACT } = require('../backend/src/collaboration/commonOperationProtocol');
const {
  createFixture,
  getCanvas,
  operationCounts,
  postOperation,
  redeemActor,
} = require('./helpers/collaborationF2Fixture.cjs');

const IDS = {
  batch: '60000000-0000-4000-8000-000000000001',
  client: '60000000-0000-4000-8000-000000000002',
  op: '60000000-0000-4000-8000-000000000003',
};

test('B1 gateway executes and exactly replays the frozen common graph envelope', async (t) => {
  const fixture = await createFixture(t, {
    projectId: 'project-common-gateway',
    canvasId: 'canvas-common-gateway',
  });
  const editor = await redeemActor(fixture, 'editor', 'Common envelope editor');
  const initial = await getCanvas(fixture, editor);
  const node = initial.nodes.find((item) => item.id === 'node-a');
  assert.match(node.entityUid, /^[0-9a-f-]{36}$/);
  assert.equal(node.entityRevision, 1);
  const common = {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    baseRevision: initial.revision,
    batchId: IDS.batch,
    clientId: IDS.client,
    clientSeq: 10,
    operations: [{
      opId: IDS.op,
      type: 'node.move',
      payload: {
        nodeUid: node.entityUid,
        expectedEntityRevision: node.entityRevision,
        position: { x: 45, y: 67 },
      },
    }],
  };
  const serialized = JSON.stringify(common);

  const applied = await postOperation(fixture, editor, serialized);
  assert.equal(applied.response.status, 200, JSON.stringify(applied.payload));
  assert.equal(applied.payload.data.document.revision, 2);
  assert.equal(applied.payload.data.document.nodes.find((item) => item.id === 'node-a').entityRevision, 2);
  assert.equal(applied.payload.data.document.nodes.find((item) => item.id === 'node-a').position.x, 45);
  assert.equal(applied.payload.data.acknowledgements[0].duplicate, false);
  assert.equal(applied.payload.data.acknowledgements[0].payload.nodeId, 'node-a');

  const replay = await postOperation(fixture, editor, serialized);
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.payload.data.document.revision, 2);
  assert.equal(replay.payload.data.acknowledgements[0].duplicate, true);
  assert.deepEqual(operationCounts(fixture.database, IDS.op), { operation: 1, idempotency: 1, audits: 1 });
  assert.equal(fixture.database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_common_operation_batches').get().count, 1);

  const collision = structuredClone(common);
  collision.operations[0].payload.position.x = 999;
  const rejected = await postOperation(fixture, editor, JSON.stringify(collision));
  assert.equal(rejected.response.status, 409, JSON.stringify(rejected.payload));
  assert.equal(rejected.payload.code, 'operation_batch_conflict');
  assert.equal(fixture.database.getCanvas(fixture.canvasId).nodes.find((item) => item.id === 'node-a').position.x, 45);
});
