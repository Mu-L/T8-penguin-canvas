const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');

function seed() {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  database.ensureCanvas('canvas-f3-batch', {
    nodes: [
      { id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: {} },
      { id: 'node-b', type: 'text', position: { x: 100, y: 0 }, data: {} },
    ],
    edges: [],
  }, 'project-f3-batch');
  return database;
}

function batch() {
  return [
    {
      opId: 'f3-batch-move-a',
      projectId: 'project-f3-batch',
      canvasId: 'canvas-f3-batch',
      actorId: 'member-f3',
      sessionId: 'session-f3',
      baseRevision: 1,
      clientSeq: 10,
      timestamp: 1_700_000_000_010,
      type: 'node.move',
      payload: { nodeId: 'node-a', position: { x: 20, y: 30 } },
    },
    {
      opId: 'f3-batch-move-b',
      projectId: 'project-f3-batch',
      canvasId: 'canvas-f3-batch',
      actorId: 'member-f3',
      sessionId: 'session-f3',
      baseRevision: 1,
      clientSeq: 11,
      timestamp: 1_700_000_000_011,
      type: 'node.move',
      payload: { nodeId: 'node-b', position: { x: 120, y: 40 } },
    },
  ];
}

test('F3 ordered operation batch accepts only the complete exact retry', () => {
  const database = seed();
  try {
    const operations = batch();
    const first = database.applyOperations('canvas-f3-batch', operations, {
      expectedRevision: 1,
      requireTimestampIdentity: true,
    });
    assert.deepEqual(first.acknowledgements.map((item) => [item.revision, item.duplicate]), [
      [2, false],
      [3, false],
    ]);
    const exact = database.applyOperations('canvas-f3-batch', operations, {
      expectedRevision: 1,
      requireTimestampIdentity: true,
    });
    assert.deepEqual(exact.acknowledgements.map((item) => [item.revision, item.duplicate]), [
      [2, true],
      [3, true],
    ]);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM canvas_operation_batches').get().count, 1);

    for (const changed of [
      [...operations].reverse(),
      operations.slice(0, 1),
      [...operations, {
        ...operations[1],
        opId: 'f3-batch-extra',
        clientSeq: 12,
        timestamp: 1_700_000_000_012,
        payload: { nodeId: 'node-b', position: { x: 130, y: 50 } },
      }],
      [
        operations[0],
        {
          ...operations[1],
          opId: 'f3-batch-new-tail',
          clientSeq: 12,
          timestamp: 1_700_000_000_012,
        },
      ],
      operations.map((operation, index) => index === 0
        ? { ...operation, timestamp: operation.timestamp + 100 }
        : operation),
    ]) {
      assert.throws(() => database.applyOperations('canvas-f3-batch', changed, {
        expectedRevision: 1,
        requireTimestampIdentity: true,
      }), (error) => ['operation_batch_conflict', 'operation_id_conflict'].includes(error?.code));
    }
    assert.equal(database.getCanvas('canvas-f3-batch').revision, 3);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM canvas_operation_batches').get().count, 1);
  } finally {
    database.close();
  }
});

test('F3 batch identity and every mutation side effect roll back together', () => {
  const database = seed();
  try {
    const operations = batch();
    const before = database.getCanvas('canvas-f3-batch');
    const beforeCounts = Object.fromEntries([
      'canvas_operations',
      'canvas_operation_idempotency',
      'canvas_operation_batches',
      'canvas_mutation_provenance',
      'audit_events',
    ].map((table) => [table, database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
    assert.throws(() => database.applyOperations('canvas-f3-batch', operations, {
      expectedRevision: 1,
      requireTimestampIdentity: true,
      syncResourceGrants: false,
      assertResultingDocument: () => {
        const error = new Error('injected F3 authority rejection');
        error.code = 'collaboration_structure_invalid';
        error.status = 422;
        throw error;
      },
    }), /injected F3 authority rejection/);
    assert.deepEqual(database.getCanvas('canvas-f3-batch'), before);
    for (const [table, count] of Object.entries(beforeCounts)) {
      assert.equal(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, count, table);
    }

    const applied = database.applyOperations('canvas-f3-batch', operations, {
      expectedRevision: 1,
      requireTimestampIdentity: true,
    });
    assert.equal(applied.document.revision, 3);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM canvas_operation_batches').get().count, 1);
  } finally {
    database.close();
  }
});
