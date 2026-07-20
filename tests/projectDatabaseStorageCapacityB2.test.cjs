'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProjectDatabase,
  ProjectDatabaseDurableLedgerError,
  ProjectDatabaseHistoryCapacityError,
  ProjectDatabaseStorageCapacityError,
  translateProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');
const {
  mapCanvasMutationError,
} = require('../backend/src/services/canvasPatch');

const PROJECT_ID = 'project-storage-capacity-b2';
const CANVAS_ID = 'canvas-storage-capacity-b2';
const OPERATION_ID = 'storage-capacity-b2-snapshot-replace';

function publicErrorState(error) {
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    status: error.status,
    statusCode: error.statusCode,
    reason: error.reason,
    retryable: error.retryable,
    details: error.details,
  };
}

function canonicalRows(rows) {
  return rows
    .map((row) => Object.fromEntries(Object.entries(row)
      .sort(([left], [right]) => left.localeCompare(right))))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function scopedRows(database, table, projectId, canvasId) {
  return canonicalRows(database.db.prepare(`
    SELECT * FROM ${table}
    WHERE project_id = ? AND canvas_id = ?
  `).all(projectId, canvasId));
}

function projectRows(database, table, projectId) {
  return canonicalRows(database.db.prepare(`
    SELECT * FROM ${table} WHERE project_id = ?
  `).all(projectId));
}

function tableRows(database, table) {
  return canonicalRows(database.db.prepare(`SELECT * FROM ${table}`).all());
}

function canvasTransactionState(database, projectId, canvasId) {
  const canvasTables = [
    'canvas_documents',
    'canvas_resource_grants',
    'canvas_resource_grant_state',
    'collaboration_operation_identities',
    'canvas_operation_idempotency',
    'canvas_operation_batches',
    'canvas_operations',
    'canvas_mutation_provenance',
    'canvas_snapshots',
    'canvas_snapshot_pins',
    'canvas_history_policies',
    'canvas_history_usage',
    'canvas_permanent_ledger_policies',
    'canvas_permanent_ledger_usage',
    'audit_events',
  ];
  return {
    canvas: Object.fromEntries(canvasTables.map((table) => [
      table,
      scopedRows(database, table, projectId, canvasId),
    ])),
    permanentTotals: scopedRows(
      database,
      'canvas_permanent_ledger_totals',
      projectId,
      canvasId,
    ),
    projectDurablePolicies: projectRows(database, 'project_durable_ledger_policies', projectId),
    projectDurableUsage: projectRows(database, 'project_durable_ledger_usage', projectId),
    projectDurableTotals: projectRows(database, 'project_durable_ledger_totals', projectId),
    databaseDurablePolicy: tableRows(database, 'database_durable_ledger_policy'),
    databaseDurableUsage: tableRows(database, 'database_durable_ledger_usage'),
    databaseDurableTotals: tableRows(database, 'database_durable_ledger_totals'),
    auditSequence: canonicalRows(database.db.prepare(`
      SELECT name, seq FROM sqlite_sequence WHERE name = 'audit_events'
    `).all()),
  };
}

function usageRow(database, table, projectId, ledgerKind) {
  const projectScoped = table === 'project_durable_ledger_usage';
  const row = database.db.prepare(projectScoped
    ? `SELECT row_count, logical_bytes FROM ${table} WHERE project_id = ? AND ledger_kind = ?`
    : `SELECT row_count, logical_bytes FROM ${table} WHERE singleton_id = 1 AND ledger_kind = ?`)
    .get(...(projectScoped ? [projectId, ledgerKind] : [ledgerKind]));
  return {
    rowCount: Number(row?.row_count || 0),
    logicalBytes: Number(row?.logical_bytes || 0),
  };
}

function permanentUsageRow(database, projectId, canvasId, ledgerKind) {
  const row = database.db.prepare(`
    SELECT row_count, logical_bytes
    FROM canvas_permanent_ledger_usage
    WHERE project_id = ? AND canvas_id = ? AND ledger_kind = ?
  `).get(projectId, canvasId, ledgerKind);
  return {
    rowCount: Number(row?.row_count || 0),
    logicalBytes: Number(row?.logical_bytes || 0),
  };
}

test('B2 storage capacity translation is stable, redacted, and preserves existing typed errors', () => {
  const secretPath = 'C:\\Users\\private-user\\AppData\\secret-project.sqlite3';
  const cases = [
    { code: 'SQLITE_FULL', operation: 'write', reason: 'sqlite-full' },
    { code: 'SQLITE_FULL_SNAPSHOT', operation: 'canvas.snapshot', reason: 'sqlite-full' },
    { code: 'ENOSPC', operation: 'write', reason: 'filesystem-reserve' },
    { code: 'EDQUOT', operation: 'write', reason: 'filesystem-reserve' },
    { code: 'EDQUOT', operation: 'backup', reason: 'backup-storage-full' },
  ];

  for (const fixture of cases) {
    const source = Object.assign(
      new Error(`disk capacity failure at ${secretPath}; token=never-expose-me`),
      {
        code: fixture.code,
        path: secretPath,
        privateDetails: { token: 'never-expose-me' },
      },
    );
    const translated = translateProjectDatabaseStorageCapacityError(source, {
      operation: fixture.operation,
      path: secretPath,
      token: 'never-expose-me',
    });

    assert.ok(translated instanceof ProjectDatabaseStorageCapacityError);
    assert.deepEqual(publicErrorState(translated), {
      name: 'ProjectDatabaseStorageCapacityError',
      message: fixture.reason === 'filesystem-reserve' || fixture.reason === 'backup-storage-full'
        ? '项目数据库所在文件系统空间或配额不足，本次操作未完成'
        : '项目数据库或 SQLite 临时存储空间不足，本次写入已回滚',
      code: 'project_database_storage_capacity_exceeded',
      status: 507,
      statusCode: 507,
      reason: fixture.reason,
      retryable: false,
      details: {
        reason: fixture.reason,
        retryable: false,
        operation: fixture.operation,
      },
    });
    const serialized = JSON.stringify(publicErrorState(translated));
    assert.equal(serialized.includes(secretPath), false);
    assert.equal(serialized.includes('private-user'), false);
    assert.equal(serialized.includes('never-expose-me'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(translated, 'cause'), false);
  }

  const invalidOperation = translateProjectDatabaseStorageCapacityError(
    Object.assign(new Error(secretPath), { code: 'ENOSPC' }),
    { operation: `write:${secretPath}` },
  );
  assert.deepEqual(invalidOperation.details, {
    reason: 'filesystem-reserve',
    retryable: false,
  });

  const history = new ProjectDatabaseHistoryCapacityError(
    'canvas_snapshot_history_capacity_exceeded',
    'history capacity',
    { retained: true },
  );
  const durable = new ProjectDatabaseDurableLedgerError(
    'project_durable_ledger_capacity_exceeded',
    'durable capacity',
    507,
    { retained: true },
  );
  const storage = new ProjectDatabaseStorageCapacityError('wal-pressure', { operation: 'checkpoint' });
  assert.strictEqual(translateProjectDatabaseStorageCapacityError(history), history);
  assert.strictEqual(translateProjectDatabaseStorageCapacityError(durable), durable);
  assert.strictEqual(translateProjectDatabaseStorageCapacityError(storage), storage);
  const unrelated = Object.assign(new Error('unrelated'), { code: 'EACCES' });
  assert.strictEqual(translateProjectDatabaseStorageCapacityError(unrelated), unrelated);
});

test('B2 canvas mutation mapping preserves storage capacity HTTP 507', () => {
  const error = new ProjectDatabaseStorageCapacityError('sqlite-full', {
    operation: 'canvas.snapshot',
  });
  const mapped = mapCanvasMutationError(error, {
    fallbackCode: 'canvas_snapshot_save_failed',
    fallbackMessage: '画布快照保存失败',
    defaultStatus: 500,
  });

  assert.equal(mapped.status, 507);
  assert.deepEqual(mapped.body, {
    success: false,
    code: 'project_database_storage_capacity_exceeded',
    error: '项目数据库或 SQLite 临时存储空间不足,本次写入已回滚',
    reason: 'sqlite-full',
    retryable: false,
  });
});

test('B2 saveCanvasSnapshot translates a late real SQLITE_FULL and rolls every table back before exact retry', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-project-storage-capacity-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  let database = null;

  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    const initial = database.ensureCanvas(CANVAS_ID, {
      name: 'Storage capacity B2',
      nodes: [{
        id: 'node-a',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { prompt: 'before' },
      }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }, PROJECT_ID);

    let lateAuditTriggerReached = false;
    database.db.function('storage_capacity_b2_mark_late_write', () => {
      lateAuditTriggerReached = true;
      return 1;
    });
    database.db.exec(`
      CREATE TABLE storage_capacity_b2_filler (
        id INTEGER PRIMARY KEY,
        payload BLOB NOT NULL
      );
      CREATE TRIGGER storage_capacity_b2_force_late_full
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'canvas.snapshot.replace'
      BEGIN
        SELECT storage_capacity_b2_mark_late_write();
        INSERT INTO storage_capacity_b2_filler(payload) VALUES (zeroblob(16777216));
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

    const requestSnapshot = {
      name: 'Storage capacity B2',
      nodes: [{
        id: 'node-a',
        type: 'text',
        position: { x: 32, y: 64 },
        data: { prompt: 'after' },
      }],
      edges: [],
      viewport: { x: 4, y: 8, zoom: 1.25 },
    };
    const requestOptions = {
      expectedRevision: initial.revision,
      opId: OPERATION_ID,
      actorId: 'storage-capacity-b2-writer',
      sessionId: 'storage-capacity-b2-session',
      clientSeq: 1,
    };
    const before = canvasTransactionState(database, PROJECT_ID, CANVAS_ID);
    const beforeAuditProject = usageRow(
      database,
      'project_durable_ledger_usage',
      PROJECT_ID,
      'audit-event',
    );
    const beforeAuditDatabase = usageRow(
      database,
      'database_durable_ledger_usage',
      PROJECT_ID,
      'audit-event',
    );
    const beforeOperationIdentity = permanentUsageRow(
      database,
      PROJECT_ID,
      CANVAS_ID,
      'operation-identity',
    );
    const beforeCanvasIdempotency = permanentUsageRow(
      database,
      PROJECT_ID,
      CANVAS_ID,
      'canvas-idempotency',
    );
    let capacityError = null;

    assert.throws(
      () => database.saveCanvasSnapshot(CANVAS_ID, requestSnapshot, requestOptions),
      (error) => {
        capacityError = error;
        return error instanceof ProjectDatabaseStorageCapacityError
          && error.code === 'project_database_storage_capacity_exceeded'
          && error.status === 507
          && error.statusCode === 507
          && error.reason === 'sqlite-full'
          && error.details?.reason === 'sqlite-full'
          && error.details?.operation === 'canvas.snapshot-save';
      },
    );
    assert.ok(capacityError);
    assert.equal(lateAuditTriggerReached, true, 'failure must occur at the late audit write');
    assert.deepEqual(canvasTransactionState(database, PROJECT_ID, CANVAS_ID), before);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM storage_capacity_b2_filler
    `).get().count, 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_operations WHERE op_id = ?
    `).get(OPERATION_ID).count, 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE project_id = ? AND canvas_id = ? AND action = 'canvas.snapshot.replace'
    `).get(PROJECT_ID, CANVAS_ID).count, 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    database.db.pragma('max_page_count = 1073741823');
    lateAuditTriggerReached = false;
    const recovered = database.saveCanvasSnapshot(CANVAS_ID, requestSnapshot, requestOptions);
    assert.equal(lateAuditTriggerReached, true);
    assert.equal(recovered.revision, initial.revision + 1);
    assert.equal(database.getCanvas(CANVAS_ID).revision, initial.revision + 1);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_operations WHERE op_id = ?
    `).get(OPERATION_ID).count, 1);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE project_id = ? AND canvas_id = ? AND action = 'canvas.snapshot.replace'
    `).get(PROJECT_ID, CANVAS_ID).count, 1);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_snapshots
      WHERE project_id = ? AND canvas_id = ? AND revision = ?
    `).get(PROJECT_ID, CANVAS_ID, initial.revision + 1).count, 1);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM storage_capacity_b2_filler
    `).get().count, 1);
    assert.equal(
      usageRow(database, 'project_durable_ledger_usage', PROJECT_ID, 'audit-event').rowCount,
      beforeAuditProject.rowCount + 1,
    );
    assert.equal(
      usageRow(database, 'database_durable_ledger_usage', PROJECT_ID, 'audit-event').rowCount,
      beforeAuditDatabase.rowCount + 1,
    );
    assert.equal(
      permanentUsageRow(database, PROJECT_ID, CANVAS_ID, 'operation-identity').rowCount,
      beforeOperationIdentity.rowCount + 1,
    );
    assert.equal(
      permanentUsageRow(database, PROJECT_ID, CANVAS_ID, 'canvas-idempotency').rowCount,
      beforeCanvasIdempotency.rowCount + 1,
    );
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try {
      if (database?.db?.open) database.db.pragma('max_page_count = 1073741823');
    } catch (_) {}
    try { await database?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
