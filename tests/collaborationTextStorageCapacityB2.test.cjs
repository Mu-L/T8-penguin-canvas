'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Y = require('yjs');

const {
  CollaborationTextPersistence,
} = require('../backend/src/services/collaborationTextPersistence');
const {
  CollaborativeTextStore,
} = require('../backend/src/collaboration/textCrdt');
const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'project-collaboration-text-storage-b2';
const CANVAS_ID = 'canvas-collaboration-text-storage-b2';
const NODE_UID = '71000000-0000-4000-8000-000000000001';
const UPDATE_ID = '71000000-0000-4000-8000-000000000002';
const MAX_PAGE_COUNT_RESET = 1_073_741_823;

function principal() {
  return {
    memberId: 'collaboration-text-storage-writer',
    actorId: 'collaboration-text-storage-writer',
    sessionId: 'collaboration-text-storage-session',
    role: 'editor',
    capabilities: ['editGraph', 'comment'],
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
  };
}

function appendTextUpdate(state, value) {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, Buffer.from(state, 'base64'));
    const before = Y.encodeStateVector(document);
    const text = document.getText('content');
    text.insert(text.length, value);
    return Buffer.from(Y.encodeStateAsUpdate(document, before)).toString('base64');
  } finally {
    document.destroy();
  }
}

function normalizedValue(value) {
  if (Buffer.isBuffer(value)) return { bufferHex: value.toString('hex') };
  if (Array.isArray(value)) return value.map(normalizedValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizedValue(child)]));
  }
  return value;
}

function tableRows(database, table) {
  return database.db.prepare(`SELECT * FROM ${table}`).all()
    .map(normalizedValue)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function textWriteState(database) {
  const tables = [
    'canvas_documents',
    'canvas_resource_grants',
    'canvas_resource_grant_state',
    'collaboration_text_documents',
    'collaboration_text_update_idempotency',
    'collaboration_text_noop_idempotency',
    'collaboration_text_client_sequences',
    'collaboration_operation_identities',
    'canvas_operation_idempotency',
    'canvas_operations',
    'canvas_permanent_ledger_policies',
    'canvas_permanent_ledger_usage',
    'project_durable_ledger_policies',
    'project_durable_ledger_usage',
    'database_durable_ledger_policy',
    'database_durable_ledger_usage',
    'audit_events',
  ];
  return Object.fromEntries(tables.map((table) => [table, tableRows(database, table)]));
}

function assertStorageCapacityError(error, operation) {
  return error instanceof ProjectDatabaseStorageCapacityError
    && error.code === 'project_database_storage_capacity_exceeded'
    && error.status === 507
    && error.statusCode === 507
    && error.reason === 'sqlite-full'
    && error.details?.reason === 'sqlite-full'
    && error.details?.operation === operation;
}

test('B2 collaboration text requires the unified ProjectDatabase writer without a raw fallback', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    assert.throws(
      () => new CollaborationTextPersistence({ db: database.db }),
      /统一写事务边界/,
    );
    assert.throws(
      () => new CollaborativeTextStore({}),
      /统一 ProjectDatabase 写事务边界/,
    );
    const persistence = new CollaborationTextPersistence(database);
    for (const writeOutsideTransaction of [
      () => persistence._archiveReusedDisplayBindingsInTransaction({}, ''),
      () => persistence._writeBindingInTransaction({}),
      () => persistence._ensureBindingInTransaction({}, {}),
      () => persistence._recordNoOpInTransaction({}, {}, {}, {}, {}),
      () => persistence._materializeInTransaction({}, {}, '', 0, 1),
    ]) {
      assert.throws(
        writeOutsideTransaction,
        (error) => error?.code === 'collaboration_text_write_transaction_required',
      );
    }
  } finally {
    await database.close();
  }
});

test('B2 legacy text update rolls its saved state back when the later audit write hits FULL', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    database.ensureCanvas(CANVAS_ID, {
      nodes: [{ id: 'legacy-node', type: 'text', data: { prompt: '' } }],
      edges: [],
    }, PROJECT_ID);
    const store = new CollaborativeTextStore(database);
    const key = {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      targetType: 'node',
      targetId: 'legacy-node',
      field: 'prompt',
    };
    const update = appendTextUpdate(store.read(key).state, 'legacy atomic update');
    const before = textWriteState(database);
    const appendAuditEvent = database.appendAuditEvent.bind(database);
    database.appendAuditEvent = () => {
      const error = new Error('private late audit capacity detail');
      error.code = 'SQLITE_FULL';
      throw error;
    };

    assert.throws(
      () => store.apply(key, update, {
        actorId: 'legacy-capacity-writer',
        sessionId: 'legacy-capacity-session',
      }),
      (error) => assertStorageCapacityError(error, 'collaboration.text.legacy-update'),
    );
    assert.equal(database.db.inTransaction, false);
    assert.deepEqual(textWriteState(database), before);
    assert.equal(database.getCollaborativeTextDocument(key), null);

    database.appendAuditEvent = appendAuditEvent;
    const committed = store.apply(key, update, {
      actorId: 'legacy-capacity-writer',
      sessionId: 'legacy-capacity-session',
    });
    assert.equal(committed.text, 'legacy atomic update');
    assert.equal(database.listAuditEvents({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      action: 'collaboration.text.update',
    }).length, 1);
  } finally {
    await database.close();
  }
});

test('B2 late real text SQLITE_FULL rolls back Yjs, materialization, revision and ledgers before exact retry', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-collaboration-text-storage-b2-'));
  const filename = path.join(directory, 'project.sqlite3');
  let database = null;

  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    database.ensureCanvas(CANVAS_ID, {
      name: 'B2 collaboration text storage capacity',
      nodes: [{
        id: 'node-text',
        entityUid: NODE_UID,
        entityRevision: 1,
        type: 'text',
        position: { x: 0, y: 0 },
        data: { prompt: 'before' },
      }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }, PROJECT_ID, { initializeResourceScope: false });

    const coordinatorCalls = [];
    const originalWriteBoundary = database.withProjectDatabaseWrite.bind(database);
    database.withProjectDatabaseWrite = (operation, callback) => {
      coordinatorCalls.push({ operation, nested: database.db.inTransaction });
      return originalWriteBoundary(operation, callback);
    };

    const persistence = new CollaborationTextPersistence(database);
    const actor = principal();
    const identity = {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      targetType: 'node',
      targetEntityUid: NODE_UID,
      field: 'prompt',
    };
    const binding = persistence.getBindingSnapshot(identity, actor).binding;
    assert.deepEqual(coordinatorCalls[0], {
      operation: 'collaboration.text.binding.ensure',
      nested: false,
    });

    const envelope = {
      contractVersion: 't8-collaboration-text-update-v1',
      updateId: UPDATE_ID,
      clientSeq: 0,
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      baseRevision: binding.revision,
      targetType: binding.targetType,
      targetEntityUid: binding.targetEntityUid,
      bindingEpoch: binding.bindingEpoch,
      field: binding.field,
      update: appendTextUpdate(binding.state, ' + committed after retry'),
    };

    let lateAuditTriggerCount = 0;
    database.db.function('collaboration_text_b2_mark_late_audit', () => {
      lateAuditTriggerCount += 1;
      return 1;
    });
    database.db.exec(`
      CREATE TABLE collaboration_text_b2_capacity_filler (
        id INTEGER PRIMARY KEY,
        payload BLOB NOT NULL
      );
      CREATE TRIGGER collaboration_text_b2_force_late_full
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'collaboration.text.update'
      BEGIN
        SELECT collaboration_text_b2_mark_late_audit();
        INSERT INTO collaboration_text_b2_capacity_filler(payload) VALUES (zeroblob(16777216));
      END;
    `);
    database.db.pragma('wal_checkpoint(TRUNCATE)');
    database.db.exec('VACUUM');
    database.db.pragma('wal_checkpoint(TRUNCATE)');
    const pageCount = Number(database.db.pragma('page_count', { simple: true }));
    const constrainedPageCount = pageCount + 64;
    assert.equal(
      Number(database.db.pragma(`max_page_count = ${constrainedPageCount}`, { simple: true })),
      constrainedPageCount,
    );

    const before = textWriteState(database);
    assert.throws(
      () => database.withProjectDatabaseWrite('collaboration.text.test-outer', () => (
        persistence.applyUpdate(envelope, { principal: actor })
      )),
      (error) => assertStorageCapacityError(error, 'collaboration.text.test-outer'),
    );
    assert.equal(database.db.inTransaction, false);
    assert.equal(lateAuditTriggerCount, 1);
    assert.deepEqual(textWriteState(database), before);
    assert.equal(tableRows(database, 'collaboration_text_b2_capacity_filler').length, 0);

    assert.throws(
      () => persistence.applyUpdate(envelope, { principal: actor }),
      (error) => assertStorageCapacityError(error, 'collaboration.text.update'),
    );
    assert.equal(database.db.inTransaction, false);
    assert.equal(lateAuditTriggerCount, 2);
    assert.deepEqual(textWriteState(database), before);
    assert.equal(tableRows(database, 'collaboration_text_b2_capacity_filler').length, 0);
    assert.equal(database.getCanvas(CANVAS_ID).revision, binding.revision);
    assert.equal(database.getCanvas(CANVAS_ID).nodes[0].data.prompt, 'before');
    assert.equal(database.getCollaborationOperationIdentity(UPDATE_ID), null);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
    const committed = persistence.applyUpdate(envelope, { principal: actor });
    assert.equal(committed.result.revision, binding.revision + 1);
    assert.equal(committed.result.text, 'before + committed after retry');
    assert.equal(lateAuditTriggerCount, 3);
    assert.equal(database.getCanvas(CANVAS_ID).revision, binding.revision + 1);
    assert.equal(database.getCanvas(CANVAS_ID).nodes[0].data.prompt, committed.result.text);
    assert.equal(tableRows(database, 'collaboration_text_b2_capacity_filler').length, 1);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_text_update_idempotency WHERE update_id = ?
    `).get(UPDATE_ID).count, 1);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_operations WHERE op_id = ? AND type = 'text.update'
    `).get(UPDATE_ID).count, 1);
    assert.equal(database.db.prepare(`
      SELECT last_client_seq FROM collaboration_text_client_sequences
      WHERE project_id = ? AND canvas_id = ? AND actor_id = ? AND session_id = ?
    `).get(PROJECT_ID, CANVAS_ID, actor.actorId, actor.sessionId).last_client_seq, 0);

    const afterCommit = textWriteState(database);
    const replay = persistence.applyUpdate(structuredClone(envelope), { principal: actor });
    assert.equal(replay.duplicate, true);
    assert.deepEqual(replay.result, committed.result);
    assert.deepEqual(textWriteState(database), afterCommit);
    assert.equal(tableRows(database, 'collaboration_text_b2_capacity_filler').length, 1);
    assert.equal(lateAuditTriggerCount, 3, 'exact replay must not reach the late audit write');
    assert.ok(coordinatorCalls.some((call) => (
      call.operation === 'collaboration.text.update' && call.nested === true
    )));
    assert.ok(coordinatorCalls.some((call) => (
      call.operation === 'collaboration.text.update' && call.nested === false
    )));
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try {
      if (database?.db?.open) database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
    } catch (_) {}
    try { await database?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
