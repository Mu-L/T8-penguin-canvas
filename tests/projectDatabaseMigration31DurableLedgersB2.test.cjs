'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');

const {
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGERS,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_DEFAULTS,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS,
  PROJECT_DATABASE_MIGRATION_31_RUN_EVENT_DURABLE_BINDINGS,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_CREATE_STATE_SQL,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_BACKFILL_USAGE_SQL,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_RUNTIME_GUARDS_SQL,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_INITIALIZATION_SQL,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS,
  projectDatabaseDurableLedgerLogicalBytes,
} = require('../backend/src/services/projectDatabaseMigration31DurableLedgers');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const BASE_SCHEMA_SQL = String.raw`
CREATE TABLE canvas_documents (
  canvas_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  entity_uid TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL
);

CREATE TABLE node_runs (
  id TEXT PRIMARY KEY,
  entity_uid TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_entity_uid TEXT,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE run_attempts (
  id TEXT PRIMARY KEY,
  entity_uid TEXT NOT NULL,
  node_run_id TEXT NOT NULL,
  FOREIGN KEY(node_run_id) REFERENCES node_runs(id) ON DELETE CASCADE
);

CREATE TABLE collaboration_common_operation_batches (
  batch_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  FOREIGN KEY(canvas_id) REFERENCES canvas_documents(canvas_id) ON DELETE CASCADE
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_uid TEXT,
  project_id TEXT NOT NULL,
  canvas_id TEXT,
  actor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

-- This is the frozen pre-schema31 shape. It intentionally has no project_id.
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_uid TEXT,
  run_id TEXT NOT NULL,
  node_run_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE run_output_commits (
  op_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  operation_index INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  canvas_revision INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  run_entity_uid TEXT NOT NULL,
  node_run_id TEXT NOT NULL,
  node_run_entity_uid TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempt_entity_uid TEXT NOT NULL,
  node_entity_uid TEXT NOT NULL,
  output_ordinal INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  asset_entity_uid TEXT NOT NULL,
  asset_revision INTEGER NOT NULL,
  blob_id TEXT NOT NULL,
  blob_entity_uid TEXT NOT NULL,
  run_revision_before INTEGER NOT NULL,
  run_revision_after INTEGER NOT NULL,
  node_run_revision_before INTEGER NOT NULL,
  node_run_revision_after INTEGER NOT NULL,
  attempt_revision_before INTEGER NOT NULL,
  attempt_revision_after INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_descriptor_digest TEXT,
  byte_size INTEGER NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  event_entity_uid TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  UNIQUE(batch_id, operation_index),
  UNIQUE(attempt_id, output_ordinal),
  FOREIGN KEY(canvas_id) REFERENCES canvas_documents(canvas_id) ON DELETE CASCADE,
  FOREIGN KEY(batch_id) REFERENCES collaboration_common_operation_batches(batch_id) ON DELETE CASCADE,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY(node_run_id) REFERENCES node_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(attempt_id) REFERENCES run_attempts(id) ON DELETE CASCADE
);

CREATE TABLE run_output_slot_reservations (
  attempt_entity_uid TEXT NOT NULL,
  output_ordinal INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  run_entity_uid TEXT NOT NULL,
  node_run_id TEXT NOT NULL,
  node_run_entity_uid TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  node_entity_uid TEXT,
  asset_id TEXT,
  asset_entity_uid TEXT,
  content_hash TEXT,
  source_descriptor_digest TEXT,
  reservation_state TEXT NOT NULL,
  evidence_source TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  evidence_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(attempt_entity_uid, output_ordinal)
);
`;

function withDatabase(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-schema31-durable-'));
  const filename = path.join(directory, 'fixture.sqlite3');
  const db = new BetterSqlite3(filename);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.exec(BASE_SCHEMA_SQL);
    return callback(db, filename);
  } finally {
    try { db.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function seedScope(db, suffix = 'a', projectId = `project-${suffix}`) {
  const scope = {
    projectId,
    canvasId: `canvas-${suffix}`,
    runId: `run-${suffix}`,
    runEntityUid: `run-uid-${suffix}`,
    nodeRunId: `node-run-${suffix}`,
    nodeRunEntityUid: `node-run-uid-${suffix}`,
    nodeEntityUid: `node-uid-${suffix}`,
    attemptId: `attempt-${suffix}`,
    attemptEntityUid: `attempt-uid-${suffix}`,
    batchId: `batch-${suffix}`,
  };
  db.prepare('INSERT INTO canvas_documents(canvas_id, project_id) VALUES (?, ?)')
    .run(scope.canvasId, scope.projectId);
  db.prepare('INSERT INTO runs(id, entity_uid, project_id, canvas_id) VALUES (?, ?, ?, ?)')
    .run(scope.runId, scope.runEntityUid, scope.projectId, scope.canvasId);
  db.prepare('INSERT INTO node_runs(id, entity_uid, run_id, node_entity_uid) VALUES (?, ?, ?, ?)')
    .run(scope.nodeRunId, scope.nodeRunEntityUid, scope.runId, scope.nodeEntityUid);
  db.prepare('INSERT INTO run_attempts(id, entity_uid, node_run_id) VALUES (?, ?, ?)')
    .run(scope.attemptId, scope.attemptEntityUid, scope.nodeRunId);
  db.prepare(`
    INSERT INTO collaboration_common_operation_batches(batch_id, project_id, canvas_id)
    VALUES (?, ?, ?)
  `).run(scope.batchId, scope.projectId, scope.canvasId);
  return scope;
}

function applyComponent(db, options = {}) {
  db.exec(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_CREATE_STATE_SQL);
  db.exec(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_BACKFILL_USAGE_SQL);
  if (options.installGuards !== false) {
    db.exec(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_RUNTIME_GUARDS_SQL);
  }
}

function initializeProjectState(db, projectId, updatedAt = 1) {
  db.prepare(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_INITIALIZATION_SQL.projectPolicySql)
    .run({ projectId, updatedAt });
  db.prepare(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_INITIALIZATION_SQL.projectUsageSql)
    .run({ projectId, updatedAt });
}

function insertObject(db, table, row, mode = '') {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => '?').join(', ');
  return db.prepare(`INSERT ${mode} INTO ${table}(${columns.join(', ')}) VALUES (${placeholders})`)
    .run(...columns.map((column) => row[column]));
}

function auditRow(scope, ordinal = 1, overrides = {}) {
  return {
    id: 1_000 + ordinal,
    mutation_uid: `audit-mutation-${ordinal}`,
    project_id: scope.projectId,
    canvas_id: scope.canvasId,
    actor_id: '成员-企鹅',
    session_id: 'session-a',
    action: 'host.artifact.commit',
    target_type: 'run-output',
    target_id: `target-${ordinal}`,
    metadata_json: JSON.stringify({ label: `企鹅-${ordinal}` }),
    created_at: 10_000 + ordinal,
    ...overrides,
  };
}

function runEventRow(scope, ordinal = 1, overrides = {}) {
  return {
    id: 2_000 + ordinal,
    entity_uid: `event-uid-${ordinal}`,
    run_id: scope.runId,
    node_run_id: scope.nodeRunId,
    type: 'node.output',
    payload_json: JSON.stringify({ label: `运行事件-企鹅-${ordinal}` }),
    created_at: 20_000 + ordinal,
    ...overrides,
  };
}

function commitRow(scope, ordinal = 1, overrides = {}) {
  return {
    op_id: `op-${scope.runId}-${ordinal}`,
    batch_id: scope.batchId,
    operation_index: ordinal - 1,
    project_id: scope.projectId,
    canvas_id: scope.canvasId,
    canvas_revision: 1,
    run_id: scope.runId,
    run_entity_uid: scope.runEntityUid,
    node_run_id: scope.nodeRunId,
    node_run_entity_uid: scope.nodeRunEntityUid,
    attempt_id: scope.attemptId,
    attempt_entity_uid: scope.attemptEntityUid,
    node_entity_uid: scope.nodeEntityUid,
    output_ordinal: ordinal - 1,
    asset_id: `asset-${scope.runId}-${ordinal}`,
    asset_entity_uid: `asset-uid-${scope.runId}-${ordinal}`,
    asset_revision: 1,
    blob_id: `blob-${scope.runId}-${ordinal}`,
    blob_entity_uid: `blob-uid-${scope.runId}-${ordinal}`,
    run_revision_before: 1,
    run_revision_after: 2,
    node_run_revision_before: 1,
    node_run_revision_after: 2,
    attempt_revision_before: 1,
    attempt_revision_after: 2,
    kind: 'image',
    content_hash: HASH_A,
    source_descriptor_digest: HASH_B,
    byte_size: 4096,
    filename: `企鹅-${ordinal}.png`,
    mime_type: 'image/png',
    event_entity_uid: `commit-event-${scope.runId}-${ordinal}`,
    created_at: 30_000 + ordinal,
    ...overrides,
  };
}

function slotRow(scope, ordinal = 1, overrides = {}) {
  return {
    attempt_entity_uid: scope.attemptEntityUid,
    output_ordinal: ordinal - 1,
    project_id: scope.projectId,
    canvas_id: scope.canvasId,
    run_id: scope.runId,
    run_entity_uid: scope.runEntityUid,
    node_run_id: scope.nodeRunId,
    node_run_entity_uid: scope.nodeRunEntityUid,
    attempt_id: scope.attemptId,
    node_entity_uid: scope.nodeEntityUid,
    asset_id: `asset-${scope.runId}-${ordinal}`,
    asset_entity_uid: `asset-uid-${scope.runId}-${ordinal}`,
    content_hash: HASH_A,
    source_descriptor_digest: HASH_B,
    reservation_state: 'host-verified',
    evidence_source: 'host-commit',
    evidence_digest: HASH_A,
    evidence_count: 1,
    // Runtime host reservations are committed in the same authoritative
    // operation and therefore carry the exact commit timestamp.
    created_at: 30_000 + ordinal,
    ...overrides,
  };
}

function projectUsage(db, projectId) {
  return new Map(db.prepare(`
    SELECT ledger_kind, row_count, logical_bytes
    FROM project_durable_ledger_usage
    WHERE project_id = ?
    ORDER BY ledger_kind
  `).all(projectId).map((row) => [row.ledger_kind, {
    rows: Number(row.row_count),
    bytes: Number(row.logical_bytes),
  }]));
}

function globalUsage(db) {
  return new Map(db.prepare(`
    SELECT ledger_kind, row_count, logical_bytes
    FROM database_durable_ledger_usage
    WHERE singleton_id = 1
    ORDER BY ledger_kind
  `).all().map((row) => [row.ledger_kind, {
    rows: Number(row.row_count),
    bytes: Number(row.logical_bytes),
  }]));
}

function authoritativeRows(db, spec, projectId) {
  if (spec.kind === 'run-event') {
    return db.prepare(`
      SELECT event.*, binding.project_id
      FROM run_events event
      JOIN run_event_durable_bindings binding ON binding.event_id = event.id
      WHERE binding.project_id = ?
      ORDER BY event.id
    `).all(projectId);
  }
  return db.prepare(`SELECT * FROM ${spec.table} WHERE project_id = ?`).all(projectId);
}

function assertExactUsage(db, projectIds) {
  const expectedGlobal = new Map(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS
    .map((spec) => [spec.kind, { rows: 0, bytes: 0 }]));
  for (const projectId of projectIds) {
    const actual = projectUsage(db, projectId);
    assert.equal(actual.size, 4);
    for (const spec of PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS) {
      const rows = authoritativeRows(db, spec, projectId);
      const expected = {
        rows: rows.length,
        bytes: rows.reduce(
          (sum, row) => sum + projectDatabaseDurableLedgerLogicalBytes(spec, row),
          0,
        ),
      };
      assert.deepEqual(actual.get(spec.kind), expected, `${projectId}/${spec.kind}`);
      expectedGlobal.get(spec.kind).rows += expected.rows;
      expectedGlobal.get(spec.kind).bytes += expected.bytes;
    }
  }
  assert.deepEqual(globalUsage(db), expectedGlobal);
}

function assertSqliteMessage(action, message) {
  assert.throws(action, (error) => {
    assert.match(String(error?.message || ''), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
}

function setProjectPolicy(db, projectId, maxRows, maxBytes) {
  const totals = db.prepare(`
    SELECT total_rows, total_bytes FROM project_durable_ledger_totals WHERE project_id = ?
  `).get(projectId);
  const pressure = Number(totals.total_rows) > maxRows || Number(totals.total_bytes) > maxBytes
    ? 'over-capacity'
    : 'normal';
  db.prepare(`
    UPDATE project_durable_ledger_policies
    SET max_rows = ?, max_bytes = ?, pressure_state = ?, updated_at = updated_at + 1
    WHERE project_id = ?
  `).run(maxRows, maxBytes, pressure, projectId);
}

function setDatabasePolicy(db, maxRows, maxBytes) {
  const totals = db.prepare(`
    SELECT total_rows, total_bytes FROM database_durable_ledger_totals WHERE singleton_id = 1
  `).get();
  const pressure = Number(totals.total_rows) > maxRows || Number(totals.total_bytes) > maxBytes
    ? 'over-capacity'
    : 'normal';
  db.prepare(`
    UPDATE database_durable_ledger_policy
    SET max_rows = ?, max_bytes = ?, pressure_state = ?, updated_at = updated_at + 1
    WHERE singleton_id = 1
  `).run(maxRows, maxBytes, pressure);
}

test('schema31 durable-ledger component freezes the four-kind/default/error ABI without altering run_events', () => {
  assert.equal(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGERS.version, 31);
  assert.equal(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGERS.fromVersion, 30);
  assert.equal(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGERS.downPolicy, 'backup-only');
  assert.match(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGERS.checksum, /^[0-9a-f]{64}$/);
  assert.equal(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS.length, 4);
  assert.ok(Object.isFrozen(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS));
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS.forEach((spec) => {
    assert.ok(Object.isFrozen(spec));
    assert.ok(Object.isFrozen(spec.textColumns));
    assert.ok(Object.isFrozen(spec.integerColumns));
  });
  assert.deepEqual(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_DEFAULTS, {
    projectMaxRows: 500_000,
    projectMaxBytes: 512 * 1024 * 1024,
    databaseMaxRows: 2_000_000,
    databaseMaxBytes: 2 * 1024 * 1024 * 1024,
    maxRowBytesByKind: {
      'audit-event': 256 * 1024,
      'run-event': 1024 * 1024,
      'run-output-commit': 64 * 1024,
      'run-output-slot-reservation': 32 * 1024,
    },
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS)
      .slice(0, 3).map(([key, value]) => [key, [value.code, value.status, value.sqliteMessage]])),
    {
      recordTooLarge: ['durable_ledger_record_too_large', 413, 'durable ledger record too large'],
      projectCapacity: ['project_durable_ledger_capacity_exceeded', 507, 'project durable ledger capacity exceeded'],
      databaseCapacity: ['database_durable_ledger_capacity_exceeded', 507, 'database durable ledger capacity exceeded'],
    },
  );
  const allSql = JSON.stringify(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGERS.ddl);
  assert.doesNotMatch(allSql, /ALTER\s+TABLE\s+run_events/i);
  assert.ok(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.tables
    .includes('run_event_durable_bindings'));
  assert.ok(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.indexes
    .includes('idx_run_event_durable_bindings_project'));
  assert.ok(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGERS.imperativeContract.phases
    .find((phase) => phase.id === 'install-durable-ledger-runtime-gates')
    .invariants.includes(
      'new-slot-reservations-require-one-exact-host-commit-and-never-accept-legacy-states',
    ));

  withDatabase((db) => {
    seedScope(db);
    applyComponent(db);
    applyComponent(db);
    const columns = db.pragma('table_info(run_events)').map((row) => row.name);
    assert.equal(columns.includes('project_id'), false);
    assert.equal(db.prepare(PROJECT_DATABASE_MIGRATION_31_RUN_EVENT_DURABLE_BINDINGS.validateSql)
      .get().invalid_count, 0);
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  });
});

test('legacy RunEvents backfill to exact one-to-one project/byte bindings and cold validation detects gaps', () => {
  withDatabase((db) => {
    const scope = seedScope(db, 'legacy');
    const event = runEventRow(scope, 1);
    insertObject(db, 'run_events', event);

    applyComponent(db, { installGuards: false });
    const binding = db.prepare('SELECT * FROM run_event_durable_bindings WHERE event_id = ?')
      .get(event.id);
    const spec = PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS
      .find((candidate) => candidate.kind === 'run-event');
    assert.deepEqual(binding, {
      event_id: event.id,
      project_id: scope.projectId,
      logical_bytes: projectDatabaseDurableLedgerLogicalBytes(spec, {
        ...event,
        project_id: scope.projectId,
      }),
      created_at: event.created_at,
    });
    assert.equal(db.prepare(PROJECT_DATABASE_MIGRATION_31_RUN_EVENT_DURABLE_BINDINGS.validateSql)
      .get().invalid_count, 0);
    assert.deepEqual(
      db.prepare(PROJECT_DATABASE_MIGRATION_31_RUN_EVENT_DURABLE_BINDINGS.validateRowsSql).all(),
      [],
    );

    db.prepare('DELETE FROM run_event_durable_bindings WHERE event_id = ?').run(event.id);
    assert.equal(db.prepare(PROJECT_DATABASE_MIGRATION_31_RUN_EVENT_DURABLE_BINDINGS.validateSql)
      .get().invalid_count, 1);
    db.exec(PROJECT_DATABASE_MIGRATION_31_RUN_EVENT_DURABLE_BINDINGS.backfillSql);
    assert.equal(db.prepare(PROJECT_DATABASE_MIGRATION_31_RUN_EVENT_DURABLE_BINDINGS.validateSql)
      .get().invalid_count, 0);
    db.exec(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_BACKFILL_USAGE_SQL);
    db.exec(PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_RUNTIME_GUARDS_SQL);
    assertExactUsage(db, [scope.projectId]);
    assertSqliteMessage(
      () => db.prepare('UPDATE run_event_durable_bindings SET logical_bytes = logical_bytes + 1 WHERE event_id = ?')
        .run(event.id),
      PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.immutable.sqliteMessage,
    );
  });
});

test('four ledgers account exact frozen UTF-8 logical bytes at project and database scope', () => {
  withDatabase((db) => {
    const scope = seedScope(db, 'utf8');
    applyComponent(db);
    insertObject(db, 'audit_events', auditRow(scope, 1));
    insertObject(db, 'run_events', runEventRow(scope, 1));
    insertObject(db, 'run_output_commits', commitRow(scope, 1));
    insertObject(db, 'run_output_slot_reservations', slotRow(scope, 1));
    assertExactUsage(db, [scope.projectId]);
    const binding = db.prepare('SELECT * FROM run_event_durable_bindings').get();
    assert.equal(binding.project_id, scope.projectId);
    assert.equal(db.pragma('foreign_key_check').length, 0);
  });
});

test('row byte boundary is exact and a late project gate rolls the whole transaction back', () => {
  withDatabase((db) => {
    const scope = seedScope(db, 'row-boundary');
    applyComponent(db);
    const spec = PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS
      .find((candidate) => candidate.kind === 'audit-event');
    const exact = auditRow(scope, 1, { canvas_id: null, metadata_json: '' });
    const fixedBytes = projectDatabaseDurableLedgerLogicalBytes(spec, exact);
    const contentLength = spec.maxRowBytes - fixedBytes - 2;
    assert.ok(contentLength > 0);
    exact.metadata_json = JSON.stringify('x'.repeat(contentLength));
    assert.equal(projectDatabaseDurableLedgerLogicalBytes(spec, exact), spec.maxRowBytes);
    insertObject(db, 'audit_events', exact);

    const tooLarge = auditRow(scope, 2, {
      canvas_id: null,
      metadata_json: JSON.stringify('x'.repeat(contentLength + 1)),
    });
    assert.equal(projectDatabaseDurableLedgerLogicalBytes(spec, tooLarge), spec.maxRowBytes + 1);
    assertSqliteMessage(
      () => insertObject(db, 'audit_events', tooLarge),
      PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.recordTooLarge.sqliteMessage,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 1);

    const before = db.prepare('SELECT * FROM project_durable_ledger_totals WHERE project_id = ?')
      .get(scope.projectId);
    setProjectPolicy(
      db,
      scope.projectId,
      Number(before.total_rows) + 1,
      PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_DEFAULTS.projectMaxBytes,
    );
    const write = db.transaction(() => {
      insertObject(db, 'audit_events', auditRow(scope, 3, { canvas_id: null }));
      insertObject(db, 'audit_events', auditRow(scope, 4, { canvas_id: null }));
    });
    assertSqliteMessage(
      () => write.immediate(),
      PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.projectCapacity.sqliteMessage,
    );
    const after = db.prepare('SELECT * FROM project_durable_ledger_totals WHERE project_id = ?')
      .get(scope.projectId);
    assert.equal(after.total_rows, before.total_rows);
    assert.equal(after.total_bytes, before.total_bytes);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 1);
  });
});

test('project and database byte/row limits are isolated and ignored exact replay consumes nothing', () => {
  withDatabase((db) => {
    const scopeA = seedScope(db, 'limit-a');
    const scopeB = seedScope(db, 'limit-b');
    applyComponent(db);
    const spec = PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS
      .find((candidate) => candidate.kind === 'audit-event');
    const firstA = auditRow(scopeA, 1, { canvas_id: null });
    const bytesA = projectDatabaseDurableLedgerLogicalBytes(spec, firstA);
    setProjectPolicy(db, scopeA.projectId, 1, bytesA);
    insertObject(db, 'audit_events', firstA);
    const replay = insertObject(db, 'audit_events', firstA, 'OR IGNORE');
    assert.equal(replay.changes, 0);
    assertSqliteMessage(
      () => insertObject(db, 'audit_events', auditRow(scopeA, 2, { canvas_id: null })),
      PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.projectCapacity.sqliteMessage,
    );

    const firstB = auditRow(scopeB, 3, { canvas_id: null });
    const bytesB = projectDatabaseDurableLedgerLogicalBytes(spec, firstB);
    const globalBefore = db.prepare('SELECT * FROM database_durable_ledger_totals').get();
    setDatabasePolicy(
      db,
      Number(globalBefore.total_rows) + 1,
      Number(globalBefore.total_bytes) + bytesB,
    );
    insertObject(db, 'audit_events', firstB);
    assertSqliteMessage(
      () => insertObject(db, 'audit_events', auditRow(scopeB, 4, { canvas_id: null })),
      PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.databaseCapacity.sqliteMessage,
    );
    assertExactUsage(db, [scopeA.projectId, scopeB.projectId]);
  });
});

test('state and authoritative scope gates fail closed before durable accounting changes', () => {
  withDatabase((db) => {
    const valid = seedScope(db, 'scope-valid');
    const foreign = seedScope(db, 'scope-foreign');
    applyComponent(db);

    const missingProject = 'project-missing-usage';
    db.prepare(`
      INSERT INTO project_durable_ledger_policies(
        project_id, max_rows, max_bytes, pressure_state, updated_at
      ) VALUES (?, 100, 1000000, 'normal', 1)
    `).run(missingProject);
    db.prepare(`
      INSERT INTO project_durable_ledger_usage(
        project_id, ledger_kind, row_count, logical_bytes, updated_at
      ) VALUES (?, 'audit-event', 0, 0, 1)
    `).run(missingProject);
    assertSqliteMessage(
      () => insertObject(db, 'audit_events', {
        ...auditRow(valid, 1, { canvas_id: null }),
        project_id: missingProject,
      }),
      PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.stateInvalid.sqliteMessage,
    );

    assertSqliteMessage(
      () => insertObject(db, 'audit_events', {
        ...auditRow(valid, 2),
        canvas_id: foreign.canvasId,
      }),
      PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.scopeMismatch.sqliteMessage,
    );

    const mismatchedCommit = commitRow(valid, 1, {
      project_id: foreign.projectId,
      canvas_id: foreign.canvasId,
    });
    assertSqliteMessage(
      () => insertObject(db, 'run_output_commits', mismatchedCommit),
      PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.scopeMismatch.sqliteMessage,
    );
    assertExactUsage(db, [valid.projectId, foreign.projectId]);
  });
});

test('runtime output-slot reservations require one exact host commit and reject every legacy state', () => {
  withDatabase((db) => {
    const missingCommitScope = seedScope(db, 'slot-missing-commit');
    applyComponent(db);
    assertSqliteMessage(
      () => insertObject(db, 'run_output_slot_reservations', slotRow(missingCommitScope, 1)),
      PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.scopeMismatch.sqliteMessage,
    );

    for (const [index, legacy] of [
      ['legacy-unverified', 'legacy-lineage'],
      ['legacy-ambiguous', 'legacy-mixed'],
    ].entries()) {
      const scope = seedScope(db, `slot-legacy-${index}`);
      initializeProjectState(db, scope.projectId, 45_000 + index);
      assertSqliteMessage(
        () => insertObject(db, 'run_output_slot_reservations', slotRow(scope, 1, {
          reservation_state: legacy[0],
          evidence_source: legacy[1],
          asset_id: null,
          asset_entity_uid: null,
          content_hash: null,
        })),
        PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.scopeMismatch.sqliteMessage,
      );
    }

    const cases = [
      ['project_id', (scope) => `${scope.projectId}-forged`],
      ['canvas_id', (scope) => `${scope.canvasId}-forged`],
      ['run_id', (scope) => `${scope.runId}-forged`],
      ['run_entity_uid', (scope) => `${scope.runEntityUid}-forged`],
      ['node_run_id', (scope) => `${scope.nodeRunId}-forged`],
      ['node_run_entity_uid', (scope) => `${scope.nodeRunEntityUid}-forged`],
      ['attempt_id', (scope) => `${scope.attemptId}-forged`],
      ['attempt_entity_uid', (scope) => `${scope.attemptEntityUid}-forged`],
      ['node_entity_uid', (scope) => `${scope.nodeEntityUid}-forged`],
      ['output_ordinal', () => 99],
      ['asset_id', () => 'asset-forged'],
      ['asset_entity_uid', () => 'asset-uid-forged'],
      ['content_hash', () => HASH_B],
      ['source_descriptor_digest', () => null],
      ['created_at', (_scope, commit) => commit.created_at + 1],
      ['evidence_count', () => 2],
      ['evidence_source', () => 'legacy-lineage'],
    ];
    cases.forEach(([field, forgedValue], index) => {
      const scope = seedScope(db, `slot-exact-${index}`);
      initializeProjectState(db, scope.projectId, 50_000 + index);
      const commit = commitRow(scope, 1, {
        op_id: `slot-exact-op-${index}`,
        event_entity_uid: `slot-exact-event-${index}`,
      });
      insertObject(db, 'run_output_commits', commit);
      if (field === 'project_id') {
        initializeProjectState(db, forgedValue(scope, commit), 60_000 + index);
      }
      assertSqliteMessage(
        () => insertObject(db, 'run_output_slot_reservations', slotRow(scope, 1, {
          [field]: forgedValue(scope, commit),
        })),
        PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.scopeMismatch.sqliteMessage,
      );
    });

    const validScope = seedScope(db, 'slot-exact-valid');
    initializeProjectState(db, validScope.projectId, 70_000);
    const validCommit = commitRow(validScope, 1, {
      op_id: 'slot-exact-valid-op',
      event_entity_uid: 'slot-exact-valid-event',
      source_descriptor_digest: null,
    });
    insertObject(db, 'run_output_commits', validCommit);
    const validSlot = slotRow(validScope, 1, {
      source_descriptor_digest: null,
      created_at: validCommit.created_at,
    });
    assert.equal(insertObject(db, 'run_output_slot_reservations', validSlot).changes, 1);
    assertExactUsage(db, [
      missingCommitScope.projectId,
      ...cases.map((_, index) => `project-slot-exact-${index}`),
      validScope.projectId,
    ]);
  });
});

test('direct mutation is denied; Run and batch cascades release only event/commit accounting', () => {
  withDatabase((db) => {
    const scope = seedScope(db, 'cascade');
    applyComponent(db);
    const audit = auditRow(scope, 1);
    const event = runEventRow(scope, 1);
    const commit = commitRow(scope, 1);
    const slot = slotRow(scope, 1);
    insertObject(db, 'audit_events', audit);
    insertObject(db, 'run_events', event);
    insertObject(db, 'run_output_commits', commit);
    insertObject(db, 'run_output_slot_reservations', slot);

    for (const action of [
      () => db.prepare('UPDATE audit_events SET action = ? WHERE id = ?').run('changed', audit.id),
      () => db.prepare('UPDATE run_events SET type = ? WHERE id = ?').run('changed', event.id),
      () => db.prepare('UPDATE run_output_commits SET kind = ? WHERE op_id = ?').run('video', commit.op_id),
      () => db.prepare(`
        UPDATE run_output_slot_reservations SET evidence_count = 2
        WHERE attempt_entity_uid = ? AND output_ordinal = ?
      `).run(slot.attempt_entity_uid, slot.output_ordinal),
    ]) {
      assertSqliteMessage(
        action,
        PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.immutable.sqliteMessage,
      );
    }

    for (const action of [
      () => db.prepare('DELETE FROM audit_events WHERE id = ?').run(audit.id),
      () => db.prepare('DELETE FROM run_events WHERE id = ?').run(event.id),
      () => db.prepare('DELETE FROM run_output_commits WHERE op_id = ?').run(commit.op_id),
      () => db.prepare(`
        DELETE FROM run_output_slot_reservations
        WHERE attempt_entity_uid = ? AND output_ordinal = ?
      `).run(slot.attempt_entity_uid, slot.output_ordinal),
    ]) {
      assertSqliteMessage(
        action,
        PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.directDelete.sqliteMessage,
      );
    }

    db.prepare('DELETE FROM runs WHERE id = ?').run(scope.runId);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM run_events').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM run_event_durable_bindings').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM run_output_commits').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM run_output_slot_reservations').get().count, 1);
    const usage = projectUsage(db, scope.projectId);
    assert.deepEqual(usage.get('audit-event'), {
      rows: 1,
      bytes: projectDatabaseDurableLedgerLogicalBytes(
        PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS.find((spec) => spec.kind === 'audit-event'),
        audit,
      ),
    });
    assert.deepEqual(usage.get('run-event'), { rows: 0, bytes: 0 });
    assert.deepEqual(usage.get('run-output-commit'), { rows: 0, bytes: 0 });
    assert.deepEqual(usage.get('run-output-slot-reservation'), {
      rows: 1,
      bytes: projectDatabaseDurableLedgerLogicalBytes(
        PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS
          .find((spec) => spec.kind === 'run-output-slot-reservation'),
        slot,
      ),
    });

    const batchScope = seedScope(db, 'batch-cascade', scope.projectId);
    const batchCommit = commitRow(batchScope, 2, { operation_index: 0, output_ordinal: 0 });
    insertObject(db, 'run_output_commits', batchCommit);
    db.prepare('DELETE FROM collaboration_common_operation_batches WHERE batch_id = ?')
      .run(batchScope.batchId);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM run_output_commits WHERE op_id = ?')
      .get(batchCommit.op_id).count, 0);
    assertExactUsage(db, [scope.projectId]);
    assert.equal(db.pragma('foreign_key_check').length, 0);
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  });
});
