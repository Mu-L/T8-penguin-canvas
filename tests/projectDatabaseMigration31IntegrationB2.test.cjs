'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const {
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
  ProjectDatabaseDurableLedgerError,
  ProjectDatabaseSchemaInvalidError,
} = require('../backend/src/services/projectDatabase');
const {
  PROJECT_DATABASE_MIGRATION_31,
  PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES,
} = require('../backend/src/services/projectDatabaseMigration31');
const {
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS,
  projectDatabaseDurableLedgerLogicalBytes,
} = require('../backend/src/services/projectDatabaseMigration31DurableLedgers');

const PROJECT_ID = 'project-schema31-integration-b2';
const CANVAS_ID = 'canvas-schema31-integration-b2';

function temporaryProject(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    directory,
    filename: path.join(directory, 'projects.sqlite3'),
  };
}

function cleanupTemporaryDirectory(directory) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(directory);
  assert.equal(
    resolved.startsWith(`${temporaryRoot}${path.sep}`),
    true,
    `refusing to remove non-temporary directory: ${resolved}`,
  );
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function schemaVersion(database) {
  return Number(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version);
}

function migration31Receipt(database) {
  return database.prepare(`
    SELECT version, name, checksum, from_fingerprint, to_fingerprint,
           down_policy, applied_at
    FROM schema_migration_receipts
    WHERE version = 31
  `).get();
}

function assertSchema31Receipt(database) {
  const receipt = migration31Receipt(database);
  assert.equal(receipt.version, 31);
  assert.equal(receipt.name, PROJECT_DATABASE_MIGRATION_31.name);
  assert.equal(receipt.checksum, PROJECT_DATABASE_MIGRATION_31.checksum);
  assert.equal(receipt.down_policy, 'backup-only');
  assert.match(receipt.from_fingerprint, /^[0-9a-f]{64}$/);
  assert.match(receipt.to_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(Number(receipt.applied_at) >= 1, true);
  return receipt;
}

function assertSchema31OwnedObjects(database) {
  const placeholders = PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES.map(() => '?').join(', ');
  const rows = database.prepare(`
    SELECT type, name
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name IN (${placeholders})
    ORDER BY type ASC, name ASC
  `).all(...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES);
  assert.equal(rows.length, PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES.length);
  assert.deepEqual(
    rows.map((row) => row.name).sort(),
    [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES].sort(),
  );
}

function assertDatabaseIntegrity(database) {
  assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
}

function projectUsage(database, projectId, kind) {
  return database.prepare(`
    SELECT row_count, logical_bytes
    FROM project_durable_ledger_usage
    WHERE project_id = ? AND ledger_kind = ?
  `).get(projectId, kind);
}

function globalUsage(database, kind) {
  return database.prepare(`
    SELECT row_count, logical_bytes
    FROM database_durable_ledger_usage
    WHERE singleton_id = 1 AND ledger_kind = ?
  `).get(kind);
}

function ledgerSpec(kind) {
  const spec = PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS.find(
    (candidate) => candidate.kind === kind,
  );
  assert.ok(spec, `missing durable ledger spec: ${kind}`);
  return spec;
}

test('B2 fresh schema31 preserves a normal Run owner partition and accounts audit/RunEvent bytes across cold open', async () => {
  const fixture = temporaryProject('t8-b2-schema31-fresh-');
  let database = null;
  try {
    database = new ProjectDatabase(fixture.filename, {
      autoBackup: false,
      allowOfflineSchemaMigrationDown: true,
    });
    assert.equal(PROJECT_DATABASE_SCHEMA_VERSION, 32);
    assert.equal(schemaVersion(database.db), PROJECT_DATABASE_SCHEMA_VERSION);
    assertSchema31Receipt(database.db);
    assertSchema31OwnedObjects(database.db);

    const document = database.ensureCanvas(CANVAS_ID, {
      name: 'schema31 integration canvas',
      nodes: [],
      edges: [],
    }, PROJECT_ID);
    const run = database.createRun({
      id: 'run-schema31-integration-b2',
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      canvasRevision: document.revision,
      initiatorId: 'owner-schema31-integration-b2',
      status: 'succeeded',
      finishedAt: 1_950_000_000_000,
    });

    const runPin = database.db.prepare(`
      SELECT pin_kind, owner_id, slot, snapshot_revision
      FROM canvas_snapshot_pins
      WHERE project_id = ? AND canvas_id = ?
        AND pin_kind = 'run' AND owner_id = ? AND slot = 'canvas'
    `).get(PROJECT_ID, CANVAS_ID, run.id);
    assert.deepEqual(runPin, {
      pin_kind: 'run',
      owner_id: run.id,
      slot: 'canvas',
      snapshot_revision: document.revision,
    });
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count
      FROM canvas_legacy_snapshot_gaps
      WHERE project_id = ? AND canvas_id = ?
        AND pin_kind = 'run' AND owner_id = ? AND slot = 'canvas'
    `).get(PROJECT_ID, CANVAS_ID, run.id).count, 0);

    const auditBefore = projectUsage(database.db, PROJECT_ID, 'audit-event');
    const eventBefore = projectUsage(database.db, PROJECT_ID, 'run-event');
    const globalAuditBefore = globalUsage(database.db, 'audit-event');
    const globalEventBefore = globalUsage(database.db, 'run-event');
    assert.ok(auditBefore);
    assert.ok(eventBefore);

    const audit = database.appendAuditEvent({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      actorId: 'owner-schema31-integration-b2',
      sessionId: 'session-schema31-integration-b2',
      action: 'schema31.integration.audit',
      targetType: 'canvas',
      targetId: CANVAS_ID,
      metadata: { text: '严格 UTF-8 计费🐧' },
      createdAt: 1_950_000_000_001,
    });
    const runEvent = database.appendRunEvent(run.id, {
      type: 'run.succeeded',
      payload: { status: 'succeeded', text: '事件🐧' },
      createdAt: 1_950_000_000_002,
    });

    const auditRow = database.db.prepare('SELECT * FROM audit_events WHERE id = ?').get(audit.id);
    const eventRow = database.db.prepare(`
      SELECT event.*, run.project_id
      FROM run_events event
      JOIN runs run ON run.id = event.run_id
      WHERE event.id = ?
    `).get(runEvent.id);
    const expectedAuditBytes = projectDatabaseDurableLedgerLogicalBytes(
      ledgerSpec('audit-event'),
      auditRow,
    );
    const expectedEventBytes = projectDatabaseDurableLedgerLogicalBytes(
      ledgerSpec('run-event'),
      eventRow,
    );

    assert.deepEqual(projectUsage(database.db, PROJECT_ID, 'audit-event'), {
      row_count: Number(auditBefore.row_count) + 1,
      logical_bytes: Number(auditBefore.logical_bytes) + expectedAuditBytes,
    });
    assert.deepEqual(projectUsage(database.db, PROJECT_ID, 'run-event'), {
      row_count: Number(eventBefore.row_count) + 1,
      logical_bytes: Number(eventBefore.logical_bytes) + expectedEventBytes,
    });
    assert.deepEqual(globalUsage(database.db, 'audit-event'), {
      row_count: Number(globalAuditBefore.row_count) + 1,
      logical_bytes: Number(globalAuditBefore.logical_bytes) + expectedAuditBytes,
    });
    assert.deepEqual(globalUsage(database.db, 'run-event'), {
      row_count: Number(globalEventBefore.row_count) + 1,
      logical_bytes: Number(globalEventBefore.logical_bytes) + expectedEventBytes,
    });
    assert.deepEqual(database.db.prepare(`
      SELECT event_id, project_id, logical_bytes, created_at
      FROM run_event_durable_bindings WHERE event_id = ?
    `).get(runEvent.id), {
      event_id: runEvent.id,
      project_id: PROJECT_ID,
      logical_bytes: expectedEventBytes,
      created_at: runEvent.createdAt,
    });

    assert.throws(
      () => database.migrateSchema31Down(),
      (error) => error?.code === 'project_database_migration_down_offline_required'
        && error?.status === 409,
    );
    assert.throws(
      () => database.migrateSchema31Down({ offline: true }),
      (error) => error?.code === 'project_database_migration_down_version_mismatch'
        && error?.status === 409
        && error?.details?.expectedVersion === 31
        && error?.details?.actualVersion === PROJECT_DATABASE_SCHEMA_VERSION,
    );
    assert.equal(schemaVersion(database.db), PROJECT_DATABASE_SCHEMA_VERSION);
    assertDatabaseIntegrity(database.db);

    const frozenAuditUsage = projectUsage(database.db, PROJECT_ID, 'audit-event');
    const frozenEventUsage = projectUsage(database.db, PROJECT_ID, 'run-event');
    await database.close();
    database = null;

    database = new ProjectDatabase(fixture.filename, { autoBackup: false });
    assert.equal(schemaVersion(database.db), PROJECT_DATABASE_SCHEMA_VERSION);
    assertSchema31Receipt(database.db);
    assert.deepEqual(projectUsage(database.db, PROJECT_ID, 'audit-event'), frozenAuditUsage);
    assert.deepEqual(projectUsage(database.db, PROJECT_ID, 'run-event'), frozenEventUsage);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_snapshot_pins
      WHERE project_id = ? AND canvas_id = ?
        AND pin_kind = 'run' AND owner_id = ? AND slot = 'canvas'
    `).get(PROJECT_ID, CANVAS_ID, run.id).count, 1);
    assertDatabaseIntegrity(database.db);
  } finally {
    if (database) await database.close();
    cleanupTemporaryDirectory(fixture.directory);
  }
});

test('B2 an exact temporary schema30 recovery point upgrades to schema31 with a durable receipt and mandatory backup', async () => {
  const fixture = temporaryProject('t8-b2-schema31-upgrade-');
  const seedFilename = path.join(fixture.directory, 'seed-current.sqlite3');
  const seedSchema30Backup = `${seedFilename}.pre-migration-v30.sqlite3`;
  const upgradeFilename = path.join(fixture.directory, 'upgrade-from-v30.sqlite3');
  const upgradeSchema30Backup = `${upgradeFilename}.pre-migration-v30.sqlite3`;
  let seed = null;
  let upgraded = null;
  let raw = null;
  try {
    seed = new ProjectDatabase(seedFilename, {
      autoBackup: false,
      ownerGuardFilename: `${seedFilename}.owner.sqlite3`,
      recoveryGenerationFilename: `${seedFilename}.generation.json`,
    });
    assert.equal(schemaVersion(seed.db), PROJECT_DATABASE_SCHEMA_VERSION);
    await seed.close();
    seed = null;
    assert.equal(fs.existsSync(seedSchema30Backup), true);

    raw = new BetterSqlite3(seedSchema30Backup, { readonly: true, fileMustExist: true });
    assert.equal(schemaVersion(raw), 30);
    const schema30Receipt = raw.prepare(`
      SELECT to_fingerprint FROM schema_migration_receipts WHERE version = 30
    `).get();
    assert.match(schema30Receipt.to_fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(raw.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE name IN ('canvas_legacy_snapshot_gaps', 'project_durable_ledger_policies')
    `).get().count, 0);
    assertDatabaseIntegrity(raw);
    raw.close();
    raw = null;

    fs.copyFileSync(seedSchema30Backup, upgradeFilename, fs.constants.COPYFILE_EXCL);
    upgraded = new ProjectDatabase(upgradeFilename, {
      autoBackup: false,
      ownerGuardFilename: `${upgradeFilename}.owner.sqlite3`,
      recoveryGenerationFilename: `${upgradeFilename}.generation.json`,
    });
    assert.equal(schemaVersion(upgraded.db), PROJECT_DATABASE_SCHEMA_VERSION);
    const receipt = assertSchema31Receipt(upgraded.db);
    assert.equal(receipt.from_fingerprint, schema30Receipt.to_fingerprint);
    assertSchema31OwnedObjects(upgraded.db);
    assert.equal(fs.existsSync(upgradeSchema30Backup), true);
    assert.equal(upgraded.db.prepare(`
      SELECT COUNT(*) AS count FROM database_durable_ledger_usage WHERE singleton_id = 1
    `).get().count, PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS.length);
    assert.equal(upgraded.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_legacy_snapshot_gaps
    `).get().count, 0);
    assertDatabaseIntegrity(upgraded.db);
    await upgraded.close();
    upgraded = null;

    raw = new BetterSqlite3(upgradeSchema30Backup, { readonly: true, fileMustExist: true });
    assert.equal(schemaVersion(raw), 30);
    assertDatabaseIntegrity(raw);
    raw.close();
    raw = null;

    upgraded = new ProjectDatabase(upgradeFilename, {
      autoBackup: false,
      ownerGuardFilename: `${upgradeFilename}.owner.sqlite3`,
      recoveryGenerationFilename: `${upgradeFilename}.generation.json`,
    });
    assert.equal(schemaVersion(upgraded.db), PROJECT_DATABASE_SCHEMA_VERSION);
    assertSchema31Receipt(upgraded.db);
    assertSchema31OwnedObjects(upgraded.db);
    assertDatabaseIntegrity(upgraded.db);
  } finally {
    try { if (raw?.open) raw.close(); } catch (_) {}
    if (upgraded) await upgraded.close();
    if (seed) await seed.close();
    cleanupTemporaryDirectory(fixture.directory);
  }
});

test('B2 schema31 durable gates translate row limits atomically and cold-open rejects missing zero-usage project state', async () => {
  const projectLimited = new ProjectDatabase(':memory:', {
    autoBackup: false,
    projectDurableLedgerPolicy: { maxRows: 1, maxBytes: 1024 * 1024 },
  });
  try {
    const document = projectLimited.ensureCanvas(
      'canvas-schema31-project-limit',
      { nodes: [], edges: [] },
      'project-schema31-project-limit',
    );
    projectLimited.appendAuditEvent({
      projectId: document.projectId,
      canvasId: document.canvasId,
      action: 'schema31.limit.first',
    });
    const before = projectUsage(
      projectLimited.db,
      document.projectId,
      'audit-event',
    );
    assert.throws(
      () => projectLimited.appendAuditEvent({
        projectId: document.projectId,
        canvasId: document.canvasId,
        action: 'schema31.limit.second',
      }),
      (error) => error instanceof ProjectDatabaseDurableLedgerError
        && error.code === 'project_durable_ledger_capacity_exceeded'
        && error.status === 507,
    );
    assert.deepEqual(
      projectUsage(projectLimited.db, document.projectId, 'audit-event'),
      before,
    );
    assert.equal(projectLimited.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events WHERE project_id = ?
    `).get(document.projectId).count, 1);
    assertDatabaseIntegrity(projectLimited.db);
  } finally {
    await projectLimited.close();
  }

  const runLimited = new ProjectDatabase(':memory:', {
    autoBackup: false,
    projectDurableLedgerPolicy: { maxRows: 1, maxBytes: 1024 * 1024 },
  });
  try {
    const document = runLimited.ensureCanvas(
      'canvas-schema31-run-limit',
      { nodes: [], edges: [] },
      'project-schema31-run-limit',
    );
    const run = runLimited.createRun({
      id: 'run-schema31-run-limit',
      projectId: document.projectId,
      canvasId: document.canvasId,
      canvasRevision: document.revision,
    });
    runLimited.appendRunEvent(run.id, { type: 'limit.first' });
    const before = projectUsage(runLimited.db, document.projectId, 'run-event');
    assert.throws(
      () => runLimited.appendRunEvent(run.id, { type: 'limit.second' }),
      (error) => error instanceof ProjectDatabaseDurableLedgerError
        && error.code === 'project_durable_ledger_capacity_exceeded'
        && error.status === 507,
    );
    assert.deepEqual(projectUsage(runLimited.db, document.projectId, 'run-event'), before);
    assert.equal(runLimited.db.prepare(`
      SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?
    `).get(run.id).count, 1);
    assertDatabaseIntegrity(runLimited.db);
  } finally {
    await runLimited.close();
  }

  const fixture = temporaryProject('t8-b2-schema31-missing-project-state-');
  let database = null;
  let raw = null;
  try {
    database = new ProjectDatabase(fixture.filename, { autoBackup: false });
    database.ensureCanvas(
      'canvas-schema31-missing-project-state',
      { nodes: [], edges: [] },
      'project-schema31-missing-project-state',
    );
    await database.close();
    database = null;

    raw = new BetterSqlite3(fixture.filename);
    assert.equal(raw.prepare(`
      DELETE FROM project_durable_ledger_policies WHERE project_id = ?
    `).run('project-schema31-missing-project-state').changes, 1);
    assert.equal(raw.prepare(`
      SELECT COUNT(*) AS count FROM project_durable_ledger_usage WHERE project_id = ?
    `).get('project-schema31-missing-project-state').count, 0);
    raw.close();
    raw = null;

    assert.throws(
      () => new ProjectDatabase(fixture.filename, { autoBackup: false }),
      (error) => error instanceof ProjectDatabaseSchemaInvalidError
        && error.code === 'project_database_schema_invalid',
    );
    raw = new BetterSqlite3(fixture.filename, { readonly: true, fileMustExist: true });
    assert.equal(raw.prepare(`
      SELECT COUNT(*) AS count FROM project_durable_ledger_policies WHERE project_id = ?
    `).get('project-schema31-missing-project-state').count, 0);
    assertDatabaseIntegrity(raw);
  } finally {
    try { if (raw?.open) raw.close(); } catch (_) {}
    if (database) await database.close();
    cleanupTemporaryDirectory(fixture.directory);
  }
});

test('B2 schema31 preserves revision-zero synthetic Run compatibility without claiming snapshot authority', async () => {
  const fixture = temporaryProject('t8-b2-schema31-synthetic-run-');
  const projectId = 'project-video-operation-synthetic';
  const canvasId = 'canvas-video-operation-synthetic';
  const runId = 'run-video-operation-synthetic';
  let database = null;
  try {
    database = new ProjectDatabase(fixture.filename, { autoBackup: false });
    const run = database.createRun({
      id: runId,
      projectId,
      canvasId,
      canvasRevision: 0,
      initiatorId: 'video-operation-synthetic',
      status: 'running',
      summary: { syntheticVideoOperation: true },
    });
    assert.equal(run.canvasRevision, 0);
    assert.equal(database.getCanvas(canvasId), null);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_snapshot_pins
      WHERE project_id = ? AND canvas_id = ? AND owner_id = ?
    `).get(projectId, canvasId, runId).count, 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_legacy_snapshot_gaps
      WHERE project_id = ? AND canvas_id = ? AND owner_id = ?
    `).get(projectId, canvasId, runId).count, 0);

    const policy = database.db.prepare(`
      SELECT project_id, pressure_state
      FROM project_durable_ledger_policies WHERE project_id = ?
    `).get(projectId);
    assert.deepEqual(policy, { project_id: projectId, pressure_state: 'normal' });
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM project_durable_ledger_usage WHERE project_id = ?
    `).get(projectId).count, PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS.length);

    database.appendRunEvent(runId, {
      type: 'video-operation.accepted',
      payload: { syntheticVideoOperation: true },
      createdAt: 1_950_000_000_010,
    });
    assert.equal(projectUsage(database.db, projectId, 'run-event').row_count, 1);
    assertDatabaseIntegrity(database.db);
    await database.close();
    database = null;

    database = new ProjectDatabase(fixture.filename, { autoBackup: false });
    const recoveredRun = database.getRun(runId);
    assert.equal(recoveredRun.canvasRevision, 0);
    assert.equal(recoveredRun.status, 'interrupted');
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_snapshot_pins
      WHERE project_id = ? AND canvas_id = ? AND owner_id = ?
    `).get(projectId, canvasId, runId).count, 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_legacy_snapshot_gaps
      WHERE project_id = ? AND canvas_id = ? AND owner_id = ?
    `).get(projectId, canvasId, runId).count, 0);
    assert.equal(projectUsage(database.db, projectId, 'run-event').row_count, 2);
    assert.deepEqual(database.db.prepare(`
      SELECT type FROM run_events WHERE run_id = ? ORDER BY id ASC
    `).all(runId).map((row) => row.type), [
      'video-operation.accepted',
      'run.interrupted',
    ]);
    assertDatabaseIntegrity(database.db);
  } finally {
    if (database) await database.close();
    cleanupTemporaryDirectory(fixture.directory);
  }
});

test('B2 schema31 translates global durable capacity and single-record limits without partial writes', async () => {
  const databaseLimited = new ProjectDatabase(':memory:', {
    autoBackup: false,
    projectDurableLedgerPolicy: { maxRows: 100, maxBytes: 4 * 1024 * 1024 },
    databaseDurableLedgerPolicy: { maxRows: 1, maxBytes: 4 * 1024 * 1024 },
  });
  try {
    const first = databaseLimited.ensureCanvas(
      'canvas-schema31-global-first',
      { nodes: [], edges: [] },
      'project-schema31-global-first',
    );
    const second = databaseLimited.ensureCanvas(
      'canvas-schema31-global-second',
      { nodes: [], edges: [] },
      'project-schema31-global-second',
    );
    databaseLimited.appendAuditEvent({
      projectId: first.projectId,
      canvasId: first.canvasId,
      action: 'schema31.global.first',
    });
    const frozenGlobal = globalUsage(databaseLimited.db, 'audit-event');
    assert.throws(
      () => databaseLimited.appendAuditEvent({
        projectId: second.projectId,
        canvasId: second.canvasId,
        action: 'schema31.global.second',
      }),
      (error) => error instanceof ProjectDatabaseDurableLedgerError
        && error.code === 'database_durable_ledger_capacity_exceeded'
        && error.status === 507,
    );
    assert.deepEqual(globalUsage(databaseLimited.db, 'audit-event'), frozenGlobal);
    assert.deepEqual(projectUsage(databaseLimited.db, second.projectId, 'audit-event'), {
      row_count: 0,
      logical_bytes: 0,
    });
    assert.equal(databaseLimited.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events WHERE project_id = ?
    `).get(second.projectId).count, 0);
    assertDatabaseIntegrity(databaseLimited.db);
  } finally {
    await databaseLimited.close();
  }

  const recordLimited = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const document = recordLimited.ensureCanvas(
      'canvas-schema31-record-limit',
      { nodes: [], edges: [] },
      'project-schema31-record-limit',
    );
    const before = projectUsage(recordLimited.db, document.projectId, 'audit-event');
    assert.throws(
      () => recordLimited.appendAuditEvent({
        projectId: document.projectId,
        canvasId: document.canvasId,
        action: 'schema31.record.too-large',
        metadata: { payload: 'x'.repeat(300 * 1024) },
      }),
      (error) => error instanceof ProjectDatabaseDurableLedgerError
        && error.code === 'durable_ledger_record_too_large'
        && error.status === 413,
    );
    assert.deepEqual(projectUsage(recordLimited.db, document.projectId, 'audit-event'), before);
    assert.equal(recordLimited.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events WHERE project_id = ?
    `).get(document.projectId).count, 0);
    assertDatabaseIntegrity(recordLimited.db);
  } finally {
    await recordLimited.close();
  }
});
