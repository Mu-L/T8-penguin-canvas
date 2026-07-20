const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BetterSqlite3 = require('better-sqlite3');
const {
  COMMON_OPERATION_BATCH_CONTRACT,
} = require('../backend/src/collaboration/commonOperationProtocol');
const {
  adaptCommonGraphBatch,
} = require('../backend/src/collaboration/commonOperationAdapter');
const {
  PROJECT_DATABASE_MIGRATION_29,
  PROJECT_DATABASE_MIGRATION_29_DOWN_SQL,
  PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES,
} = require('../backend/src/services/projectDatabaseMigration29');
const {
  PROJECT_DATABASE_MIGRATION_30,
  PROJECT_DATABASE_MIGRATION_30_DOWN_SQL,
  PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES,
} = require('../backend/src/services/projectDatabaseMigration30');
const {
  PROJECT_DATABASE_MIGRATION_31,
} = require('../backend/src/services/projectDatabaseMigration31');
const {
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration31LegacyGaps');
const {
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS,
} = require('../backend/src/services/projectDatabaseMigration31DurableLedgers');
const {
  OperationBatchConflictError,
  PROJECT_DATABASE_MIGRATIONS,
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
  ProjectDatabaseSchemaInvalidError,
} = require('../backend/src/services/projectDatabase');
const {
  assertCurrentProjectDatabaseRegistry,
  stripSchema32ForSyntheticSchema31,
} = require('./helpers/projectDatabaseVersion.cjs');

const PROJECT_ID = 'project-history-integrity-b2';
const CANVAS_ID = 'canvas-history-integrity-b2';
const NODE_ID = 'node-history-integrity-b2';
const ACTOR_ID = 'history-integrity-writer';
const SESSION_ID = 'history-integrity-session';

function databaseOptions(overrides = {}) {
  return {
    autoBackup: false,
    preMigrationBackup: false,
    preMigration30Backup: false,
    ...overrides,
  };
}

function seedCanvas(database, suffix = '') {
  return database.ensureCanvas(`${CANVAS_ID}${suffix}`, {
    name: 'B2 history integrity fixture',
    nodes: [{
      id: NODE_ID,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { prompt: '历史完整性🐧' },
    }],
    edges: [],
  }, `${PROJECT_ID}${suffix}`);
}

function moveNode(database, document, sequence) {
  return database.applyOperations(document.canvasId, [{
    opId: `history-integrity-move-${sequence}-${document.canvasId}`,
    projectId: document.projectId,
    canvasId: document.canvasId,
    actorId: ACTOR_ID,
    sessionId: SESSION_ID,
    clientSeq: sequence,
    baseRevision: document.revision,
    timestamp: 1_920_000_000_000 + sequence,
    type: 'node.move',
    payload: {
      nodeId: NODE_ID,
      position: { x: sequence * 7, y: sequence * 11 },
    },
  }], {
    expectedRevision: document.revision,
  }).document;
}

function createRunIntent(database, document, id) {
  return database.createRunIntent({
    id,
    projectId: document.projectId,
    canvasId: document.canvasId,
    canvasRevision: document.revision,
    nodeIds: [NODE_ID],
    idempotencyKey: `${id}-key`,
    requestedBy: ACTOR_ID,
  });
}

function historyUsage(database, projectId, canvasId) {
  return database.prepare(`
    SELECT snapshot_rows, snapshot_bytes, common_evidence_rows,
           common_evidence_bytes, raw_operation_rows, raw_operation_bytes,
           pin_rows, pin_bytes, updated_at
    FROM canvas_history_usage
    WHERE project_id = ? AND canvas_id = ?
  `).get(projectId, canvasId);
}

function ownedV29Objects(database) {
  const owned = new Set(PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES);
  return database.prepare(`
    SELECT type, name
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type ASC, name ASC
  `).all().filter((row) => owned.has(row.name));
}

function ownedV30Objects(database) {
  const owned = new Set(PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES);
  return database.prepare(`
    SELECT type, name
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type ASC, name ASC
  `).all().filter((row) => owned.has(row.name));
}

function migrationLedger(database) {
  return database.prepare(`
    SELECT version, applied_at FROM schema_migrations ORDER BY version ASC
  `).all();
}

// Production schema31 DOWN remains backup-only. These historical checkpoint
// tests reconstruct schema30/29 fixtures by removing only schema31-owned test
// objects and its exact receipt/checkpoint.
function stripSchema31ForSchema30Test(database) {
  stripSchema32ForSyntheticSchema31(database);
  database.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DOWN_SQL);
  const drop = (type, name) => database.exec(`DROP ${type} IF EXISTS "${name}"`);
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.triggers.forEach((name) => drop('TRIGGER', name));
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.views.forEach((name) => drop('VIEW', name));
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.indexes.forEach((name) => drop('INDEX', name));
  [...PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.tables]
    .reverse()
    .forEach((name) => drop('TABLE', name));
  database.prepare('DELETE FROM schema_migration_receipts WHERE version = ?')
    .run(PROJECT_DATABASE_MIGRATION_31.version);
  database.prepare('DELETE FROM schema_migrations WHERE version = ?')
    .run(PROJECT_DATABASE_MIGRATION_31.version);
}

function removeStaleSchema31FixtureBackup(database) {
  const filename = String(database?.name || '');
  if (!filename || filename === ':memory:') return;
  fs.rmSync(`${filename}.pre-migration-v30.sqlite3`, { force: true });
}

function downgradeToSchema29(database) {
  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      if (migrationLedger(database).at(-1)?.version >= PROJECT_DATABASE_MIGRATION_31.version) {
        stripSchema31ForSchema30Test(database);
      }
      database.prepare('DELETE FROM schema_migration_receipts WHERE version = 30').run();
      database.prepare('DELETE FROM schema_migrations WHERE version = 30').run();
      database.exec(PROJECT_DATABASE_MIGRATION_30_DOWN_SQL);
    }).immediate();
  } finally {
    database.pragma('foreign_keys = ON');
  }
  assert.equal(database.prepare(`
    SELECT MAX(version) AS version FROM schema_migrations
  `).get().version, 29);
  assert.equal(
    ownedV29Objects(database).length,
    PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES.length,
  );
  assert.deepEqual(ownedV30Objects(database), []);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM schema_migration_receipts WHERE version = 29
  `).get().count, 1);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM schema_migration_receipts WHERE version = 30
  `).get().count, 0);
  removeStaleSchema31FixtureBackup(database);
}

function downgradeToSchema28(database) {
  if (Number(migrationLedger(database).at(-1)?.version || 0) >= 30) {
    downgradeToSchema29(database);
  }
  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      database.prepare('DELETE FROM schema_migration_receipts WHERE version = 29').run();
      database.prepare('DELETE FROM schema_migrations WHERE version = 29').run();
      database.exec(PROJECT_DATABASE_MIGRATION_29_DOWN_SQL);
    }).immediate();
  } finally {
    database.pragma('foreign_keys = ON');
  }
  assert.equal(database.prepare(`
    SELECT MAX(version) AS version FROM schema_migrations
  `).get().version, 28);
  assert.deepEqual(ownedV29Objects(database), []);
}

function normalizeSqlValue(value) {
  if (Buffer.isBuffer(value)) return { blobHex: value.toString('hex') };
  return value;
}

function logicalDatabaseSnapshot(database) {
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC
  `).all().map((row) => row.name);
  return {
    userVersion: Number(database.pragma('user_version', { simple: true })),
    applicationId: Number(database.pragma('application_id', { simple: true })),
    tables: tables.map((tableName) => {
      const quotedName = `"${String(tableName).replaceAll('"', '""')}"`;
      const rows = database.prepare(`SELECT * FROM ${quotedName}`).all()
        .map((row) => Object.fromEntries(Object.entries(row).map(
          ([key, value]) => [key, normalizeSqlValue(value)],
        )))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      return { tableName, rows };
    }),
  };
}

function buildTwoOperationDomainBatch(document) {
  return {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: document.projectId,
    canvasId: document.canvasId,
    baseRevision: document.revision,
    batchId: '73000000-0000-4000-8000-000000000001',
    clientId: '73000000-0000-4000-8000-000000000002',
    clientSeq: 1,
    operations: [{
      opId: '73000000-0000-4000-8000-000000000003',
      type: 'review.thread.create',
      payload: {
        threadUid: '73000000-0000-4000-8000-000000000004',
        expectedCanvasRevision: document.revision,
        anchor: { kind: 'canvas', x: 10, y: 20 },
        severity: 'high',
        initialComment: {
          commentUid: '73000000-0000-4000-8000-000000000005',
          body: 'domain ledger integrity first comment',
        },
      },
    }, {
      opId: '73000000-0000-4000-8000-000000000006',
      type: 'review.comment.add',
      payload: {
        threadUid: '73000000-0000-4000-8000-000000000004',
        commentUid: '73000000-0000-4000-8000-000000000007',
        parentCommentUid: '73000000-0000-4000-8000-000000000005',
        expectedCanvasRevision: document.revision,
        expectedThreadRevision: 1,
        body: 'domain ledger integrity reply',
      },
    }],
  };
}

function applySingleOperationGraphBatch(database, document) {
  const node = document.nodes.find((item) => item.id === NODE_ID);
  const batch = {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: document.projectId,
    canvasId: document.canvasId,
    baseRevision: document.revision,
    batchId: '74000000-0000-4000-8000-000000000001',
    clientId: '74000000-0000-4000-8000-000000000002',
    clientSeq: 17,
    operations: [{
      opId: '74000000-0000-4000-8000-000000000003',
      type: 'node.move',
      payload: {
        nodeUid: node.entityUid,
        expectedEntityRevision: node.entityRevision,
        position: { x: 70, y: 80 },
      },
    }],
  };
  const adapted = adaptCommonGraphBatch(batch, document, {
    actorId: ACTOR_ID,
    sessionId: SESSION_ID,
    timestamp: 1_920_000_100_000,
  });
  const applied = database.applyOperations(document.canvasId, adapted.operations, {
    expectedRevision: batch.baseRevision,
    commonBatch: batch,
    requireTimestampIdentity: false,
  });
  return { batch, adapted, applied };
}

async function closeQuietly(database) {
  if (!database) return;
  try { await database.close(); } catch (_) {}
}

const MIGRATION_29_CHECKPOINTS = Object.freeze([
  'after-from-verify',
  'after-ddl',
  'after-backfill',
  'after-to-verify',
  'after-ledger',
  'after-receipt',
  'before-commit',
]);

const MIGRATION_30_CHECKPOINTS = MIGRATION_29_CHECKPOINTS;

function crashMigrationAtCheckpoint({
  filename,
  backupFilename,
  markerFilename,
  phase,
  version,
}) {
  const childScript = String.raw`
    const fs = require('node:fs');
    const { ProjectDatabase } = require(process.env.T8_PROJECT_DATABASE_MODULE);
    const targetVersion = Number(process.env.T8_MIGRATION_VERSION);
    function writeMarker(event) {
      const marker = fs.openSync(process.env.T8_MIGRATION_MARKER, 'w');
      try {
        fs.writeFileSync(marker, JSON.stringify(event), 'utf8');
        fs.fsyncSync(marker);
      } finally {
        fs.closeSync(marker);
      }
    }
    const database = new ProjectDatabase(process.env.T8_MIGRATION_DATABASE, {
      autoBackup: false,
      preMigrationBackup: targetVersion === 29,
      preMigrationBackupFilename: process.env.T8_MIGRATION_BACKUP,
      preMigration30Backup: targetVersion === 30,
      preMigration30BackupFilename: process.env.T8_MIGRATION_BACKUP,
      beforeExecutableMigrationPhase(_database, event) {
        if (process.env.T8_MIGRATION_CRASH_PHASE === 'after-commit-control') {
          if (targetVersion === 29 && event.version === 30 && event.phase === 'after-from-verify') {
            writeMarker({
              phase: 'after-commit-control',
              committedVersion: 29,
              interceptedVersion: 30,
              interceptedPhase: event.phase,
            });
            process.exit(93);
          }
          return;
        }
        if (event.version === targetVersion
          && event.phase === process.env.T8_MIGRATION_CRASH_PHASE) {
          writeMarker(event);
          process.exit(91);
        }
      },
    });
    if (process.env.T8_MIGRATION_CRASH_PHASE === 'after-commit-control'
      && targetVersion === 30) {
      writeMarker({ phase: 'after-commit-control', committedVersion: 30 });
      process.exit(93);
    }
    database.close();
    process.exit(92);
  `;
  return spawnSync(process.execPath, ['-e', childScript], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      T8_PROJECT_DATABASE_MODULE: path.resolve(
        __dirname,
        '../backend/src/services/projectDatabase.js',
      ),
      T8_MIGRATION_DATABASE: filename,
      T8_MIGRATION_BACKUP: backupFilename,
      T8_MIGRATION_MARKER: markerFilename,
      T8_MIGRATION_CRASH_PHASE: phase,
      T8_MIGRATION_VERSION: String(version),
    },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

test('B2 cold reopen rejects offline canvas_history_usage tampering without repairing it', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-history-usage-tamper-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const suffix = '-usage-tamper';
  const projectId = `${PROJECT_ID}${suffix}`;
  const canvasId = `${CANVAS_ID}${suffix}`;
  let database = null;
  try {
    database = new ProjectDatabase(filename, databaseOptions());
    let document = seedCanvas(database, suffix);
    document = moveNode(database, document, 1);
    assert.equal(document.revision, 2);
    const valid = historyUsage(database.db, projectId, canvasId);
    assert.ok(Number(valid.pin_rows) >= 1);
    assert.ok(Number(valid.pin_bytes) >= 1);
    assert.ok(Number(valid.raw_operation_bytes) >= 1);
    await database.close();
    database = null;

    const offline = new BetterSqlite3(filename);
    let tampered;
    try {
      offline.prepare(`
        UPDATE canvas_history_usage
        SET pin_rows = pin_rows + 1,
            pin_bytes = pin_bytes + 17,
            raw_operation_bytes = raw_operation_bytes + 23
        WHERE project_id = ? AND canvas_id = ?
      `).run(projectId, canvasId);
      tampered = historyUsage(offline, projectId, canvasId);
      assert.equal(Number(tampered.pin_rows), Number(valid.pin_rows) + 1);
      assert.equal(Number(tampered.pin_bytes), Number(valid.pin_bytes) + 17);
      assert.equal(Number(tampered.raw_operation_bytes), Number(valid.raw_operation_bytes) + 23);
      offline.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      offline.close();
    }

    assert.throws(
      () => new ProjectDatabase(filename, databaseOptions()),
      (error) => error instanceof ProjectDatabaseSchemaInvalidError
        && /history usage|usage|计数/i.test(String(error.message || '')),
    );

    const verify = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(historyUsage(verify, projectId, canvasId), tampered);
      assert.equal(verify.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(verify.pragma('foreign_key_check'), []);
    } finally {
      verify.close();
    }
  } finally {
    await closeQuietly(database);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('B2 cold reopen rejects a missing per-canvas history policy without recreating defaults', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-history-policy-missing-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const suffix = '-policy-missing';
  const projectId = `${PROJECT_ID}${suffix}`;
  const canvasId = `${CANVAS_ID}${suffix}`;
  let database = null;
  try {
    database = new ProjectDatabase(filename, databaseOptions());
    seedCanvas(database, suffix);
    await database.close();
    database = null;

    const offline = new BetterSqlite3(filename);
    try {
      assert.equal(offline.prepare(`
        DELETE FROM canvas_history_policies WHERE project_id = ? AND canvas_id = ?
      `).run(projectId, canvasId).changes, 1);
      offline.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      offline.close();
    }

    assert.throws(
      () => new ProjectDatabase(filename, databaseOptions()),
      (error) => error instanceof ProjectDatabaseSchemaInvalidError
        && /history policy|policy|策略/i.test(String(error.message || '')),
    );

    const verify = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
    try {
      assert.equal(verify.prepare(`
        SELECT COUNT(*) AS count FROM canvas_history_policies
        WHERE project_id = ? AND canvas_id = ?
      `).get(projectId, canvasId).count, 0);
      assert.equal(verify.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(verify.pragma('foreign_key_check'), []);
    } finally {
      verify.close();
    }
  } finally {
    await closeQuietly(database);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('B2 cold reopen rejects a trigger-accounted managed pin deletion while its owner remains authoritative', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-managed-pin-tamper-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const suffix = '-managed-pin';
  const projectId = `${PROJECT_ID}${suffix}`;
  const canvasId = `${CANVAS_ID}${suffix}`;
  const intentId = 'history-integrity-managed-pin-intent';
  let database = null;
  try {
    database = new ProjectDatabase(filename, databaseOptions());
    let document = seedCanvas(database, suffix);
    document = moveNode(database, document, 2);
    const intent = createRunIntent(database, document, intentId);
    assert.equal(intent.canvasRevision, 2);
    assert.ok(database.db.prepare(`
      SELECT 1 FROM canvas_snapshot_pins
      WHERE project_id = ? AND canvas_id = ? AND pin_kind = 'run_intent'
        AND owner_id = ? AND slot = 'canvas'
    `).get(projectId, canvasId, intentId));
    await database.close();
    database = null;

    const offline = new BetterSqlite3(filename);
    let usageAfterDelete;
    try {
      offline.pragma('foreign_keys = ON');
      const usageBeforeDelete = historyUsage(offline, projectId, canvasId);
      const deleted = offline.prepare(`
        DELETE FROM canvas_snapshot_pins
        WHERE project_id = ? AND canvas_id = ? AND pin_kind = 'run_intent'
          AND owner_id = ? AND slot = 'canvas'
      `).run(projectId, canvasId, intentId);
      assert.equal(deleted.changes, 1);
      usageAfterDelete = historyUsage(offline, projectId, canvasId);
      assert.equal(Number(usageAfterDelete.pin_rows), Number(usageBeforeDelete.pin_rows) - 1);
      assert.ok(Number(usageAfterDelete.pin_bytes) < Number(usageBeforeDelete.pin_bytes));
      assert.ok(offline.prepare('SELECT 1 FROM run_intents WHERE id = ?').get(intentId));
      offline.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      offline.close();
    }

    assert.throws(
      () => new ProjectDatabase(filename, databaseOptions()),
      (error) => error instanceof ProjectDatabaseSchemaInvalidError
        && /owner pin|snapshot owner pin|pin 集合/i.test(String(error.message || '')),
    );

    const verify = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
    try {
      assert.ok(verify.prepare('SELECT 1 FROM run_intents WHERE id = ?').get(intentId));
      assert.equal(verify.prepare(`
        SELECT COUNT(*) AS count FROM canvas_snapshot_pins
        WHERE project_id = ? AND canvas_id = ? AND pin_kind = 'run_intent'
          AND owner_id = ? AND slot = 'canvas'
      `).get(projectId, canvasId, intentId).count, 0);
      assert.deepEqual(historyUsage(verify, projectId, canvasId), usageAfterDelete);
      assert.equal(verify.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(verify.pragma('foreign_key_check'), []);
    } finally {
      verify.close();
    }
  } finally {
    await closeQuietly(database);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('B2 schema 28 domain ledger order tampering fails v29 backfill and rolls every owned object back', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-domain-order-tamper-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const suffix = '-domain-order';
  let database = null;
  try {
    database = new ProjectDatabase(filename, databaseOptions());
    const document = seedCanvas(database, suffix);
    const batch = buildTwoOperationDomainBatch(document);
    const applied = database.applyCommonReviewBatch(batch, {
      principal: {
        memberId: ACTOR_ID,
        sessionId: SESSION_ID,
        capabilities: ['comment'],
      },
    });
    assert.equal(applied.results.length, 2);
    await database.close();
    database = null;

    const legacy = new BetterSqlite3(filename);
    let ledgerBeforeFailure;
    let tamperedDomainRows;
    try {
      downgradeToSchema28(legacy);
      legacy.transaction(() => {
        legacy.prepare(`
          UPDATE collaboration_domain_operation_idempotency
          SET operation_index = 2
          WHERE batch_id = ? AND operation_index = 0
        `).run(batch.batchId);
        legacy.prepare(`
          UPDATE collaboration_domain_operation_idempotency
          SET operation_index = 0
          WHERE batch_id = ? AND operation_index = 1
        `).run(batch.batchId);
        legacy.prepare(`
          UPDATE collaboration_domain_operation_idempotency
          SET operation_index = 1
          WHERE batch_id = ? AND operation_index = 2
        `).run(batch.batchId);
      }).immediate();
      tamperedDomainRows = legacy.prepare(`
        SELECT operation_index, op_id, batch_id, project_id, canvas_id, type,
               payload_digest, actor_id, session_id, result_json, created_at
        FROM collaboration_domain_operation_idempotency
        WHERE batch_id = ? ORDER BY operation_index ASC
      `).all(batch.batchId);
      assert.equal(tamperedDomainRows.length, 2);
      assert.deepEqual(tamperedDomainRows.map((row) => row.op_id), [
        batch.operations[1].opId,
        batch.operations[0].opId,
      ]);
      ledgerBeforeFailure = migrationLedger(legacy);
      assert.equal(ledgerBeforeFailure.length, 28);
      legacy.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      legacy.close();
    }

    assert.throws(
      () => new ProjectDatabase(filename, databaseOptions()),
      (error) => error instanceof ProjectDatabaseSchemaInvalidError
        && error.code === 'common_operation_evidence_backfill_invalid_domain',
    );

    const verify = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(migrationLedger(verify), ledgerBeforeFailure);
      assert.equal(migrationLedger(verify).at(-1).version, 28);
      assert.deepEqual(ownedV29Objects(verify), []);
      assert.deepEqual(verify.prepare(`
        SELECT operation_index, op_id, batch_id, project_id, canvas_id, type,
               payload_digest, actor_id, session_id, result_json, created_at
        FROM collaboration_domain_operation_idempotency
        WHERE batch_id = ? ORDER BY operation_index ASC
      `).all(batch.batchId), tamperedDomainRows);
      assert.equal(verify.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(verify.pragma('foreign_key_check'), []);
    } finally {
      verify.close();
    }
  } finally {
    await closeQuietly(database);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('B2 schema 28 graph evidence binding drift fails v29 backfill and preserves the tampered v28 database', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-graph-binding-tamper-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const suffix = '-graph-binding';
  let database = null;
  try {
    database = new ProjectDatabase(filename, databaseOptions());
    const document = seedCanvas(database, suffix);
    const graph = applySingleOperationGraphBatch(database, document);
    assert.equal(graph.applied.document.revision, document.revision + 1);
    await database.close();
    database = null;

    const legacy = new BetterSqlite3(filename);
    let tamperedSnapshot;
    let ledgerBeforeFailure;
    try {
      downgradeToSchema28(legacy);
      const opId = graph.batch.operations[0].opId;
      const forged = {
        baseRevision: graph.batch.baseRevision + 9,
        actorId: `${ACTOR_ID}-forged`,
        sessionId: `${SESSION_ID}-forged`,
        clientSeq: graph.batch.clientSeq + 13,
      };
      const updateRaw = legacy.prepare(`
        UPDATE canvas_operations
        SET base_revision = ?, actor_id = ?, session_id = ?, client_seq = ?
        WHERE op_id = ?
      `).run(forged.baseRevision, forged.actorId, forged.sessionId, forged.clientSeq, opId);
      const updateIdentity = legacy.prepare(`
        UPDATE canvas_operation_idempotency
        SET base_revision = ?, actor_id = ?, session_id = ?, client_seq = ?
        WHERE op_id = ?
      `).run(forged.baseRevision, forged.actorId, forged.sessionId, forged.clientSeq, opId);
      assert.equal(updateRaw.changes, 1);
      assert.equal(updateIdentity.changes, 1);
      ledgerBeforeFailure = migrationLedger(legacy);
      tamperedSnapshot = logicalDatabaseSnapshot(legacy);
      assert.equal(legacy.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(legacy.pragma('foreign_key_check'), []);
      legacy.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      legacy.close();
    }

    assert.throws(
      () => new ProjectDatabase(filename, databaseOptions()),
      (error) => error instanceof ProjectDatabaseSchemaInvalidError
        && error.code === 'common_operation_evidence_backfill_missing_raw',
    );

    const verify = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(migrationLedger(verify), ledgerBeforeFailure);
      assert.equal(migrationLedger(verify).at(-1).version, 28);
      assert.deepEqual(ownedV29Objects(verify), []);
      assert.deepEqual(logicalDatabaseSnapshot(verify), tamperedSnapshot);
      assert.equal(verify.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(verify.pragma('foreign_key_check'), []);
    } finally {
      verify.close();
    }
  } finally {
    await closeQuietly(database);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('B2 schema29 Common domain replay rejects record scope, revision-range, and global-identity drift', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-v29-domain-replay-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const suffix = '-domain-replay';
  const database = new ProjectDatabase(filename, databaseOptions());
  try {
    const document = seedCanvas(database, suffix);
    const batch = buildTwoOperationDomainBatch(document);
    const principal = {
      memberId: ACTOR_ID,
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
      capabilities: ['comment'],
    };
    const applied = database.applyCommonReviewBatch(batch, { principal });
    assert.equal(applied.duplicate, false);
    downgradeToSchema29(database.db);

    const firstOpId = batch.operations[0].opId;
    assert.equal(database.db.prepare(`
      UPDATE collaboration_domain_operation_idempotency
      SET project_id = ? WHERE op_id = ?
    `).run(`${batch.projectId}-forged`, firstOpId).changes, 1);
    assert.throws(
      () => database.replayCommonDomainBatch(batch, principal, 'review'),
      (error) => error instanceof OperationBatchConflictError,
    );
    database.db.prepare(`
      UPDATE collaboration_domain_operation_idempotency
      SET project_id = ? WHERE op_id = ?
    `).run(batch.projectId, firstOpId);

    assert.equal(database.db.prepare(`
      UPDATE collaboration_common_operation_batches
      SET first_revision = base_revision + 1,
          last_revision = base_revision + 1
      WHERE batch_id = ?
    `).run(batch.batchId).changes, 1);
    assert.throws(
      () => database.replayCommonDomainBatch(batch, principal, 'review'),
      (error) => error instanceof OperationBatchConflictError,
    );
    database.db.prepare(`
      UPDATE collaboration_common_operation_batches
      SET first_revision = base_revision,
          last_revision = base_revision
      WHERE batch_id = ?
    `).run(batch.batchId);

    assert.equal(database.db.prepare(`
      DELETE FROM collaboration_operation_identities WHERE op_id = ?
    `).run(firstOpId).changes, 1);
    assert.throws(
      () => database.replayCommonDomainBatch(batch, principal, 'review'),
      (error) => error instanceof OperationBatchConflictError,
    );
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('B2 pre-migration backup race fails before v29 DDL and preserves the exact pre-race schema 28 copy', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-prebackup-race-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const backupFilename = path.join(directory, 'projects.pre-migration-v28.sqlite3');
  const suffix = '-prebackup-race';
  const canvasId = `${CANVAS_ID}${suffix}`;
  let database = null;
  try {
    database = new ProjectDatabase(filename, databaseOptions());
    seedCanvas(database, suffix);
    await database.close();
    database = null;

    const legacy = new BetterSqlite3(filename);
    let beforeRaceSnapshot;
    let beforeRaceUpdatedAt;
    let ledgerBeforeRace;
    try {
      downgradeToSchema28(legacy);
      beforeRaceSnapshot = logicalDatabaseSnapshot(legacy);
      beforeRaceUpdatedAt = Number(legacy.prepare(`
        SELECT updated_at FROM canvas_documents WHERE canvas_id = ?
      `).get(canvasId).updated_at);
      ledgerBeforeRace = migrationLedger(legacy);
      legacy.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      legacy.close();
    }

    const executablePhases = [];
    let replaceHookCalls = 0;
    assert.throws(
      () => new ProjectDatabase(filename, {
        autoBackup: false,
        preMigrationBackupFilename: backupFilename,
        beforePreMigrationBackupReplace(context) {
          replaceHookCalls += 1;
          assert.equal(path.resolve(context.target), path.resolve(backupFilename));
          assert.equal(context.fromVersion, 28);
          assert.equal(context.beforeDataVersion, context.afterDataVersion);
          const concurrent = new BetterSqlite3(filename);
          try {
            concurrent.pragma('foreign_keys = ON');
            const changed = concurrent.prepare(`
              UPDATE canvas_documents SET updated_at = updated_at + 17
              WHERE canvas_id = ?
            `).run(canvasId);
            assert.equal(changed.changes, 1);
          } finally {
            concurrent.close();
          }
        },
        beforeExecutableMigrationPhase(_database, event) {
          executablePhases.push(event.phase);
        },
      }),
      (error) => error instanceof ProjectDatabaseSchemaInvalidError
        && /并发变化|过期恢复点|data.version/i.test(String(error.message || '')),
    );
    assert.equal(replaceHookCalls, 1);
    assert.deepEqual(executablePhases, [], 'the data_version gate must fail before the first v29 phase');
    assert.equal(fs.existsSync(backupFilename), true);

    const primary = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
    const backup = new BetterSqlite3(backupFilename, { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(migrationLedger(primary), ledgerBeforeRace);
      assert.deepEqual(migrationLedger(backup), ledgerBeforeRace);
      assert.equal(migrationLedger(primary).at(-1).version, 28);
      assert.equal(migrationLedger(backup).at(-1).version, 28);
      assert.deepEqual(ownedV29Objects(primary), []);
      assert.deepEqual(ownedV29Objects(backup), []);
      assert.equal(Number(primary.prepare(`
        SELECT updated_at FROM canvas_documents WHERE canvas_id = ?
      `).get(canvasId).updated_at), beforeRaceUpdatedAt + 17);
      assert.equal(Number(backup.prepare(`
        SELECT updated_at FROM canvas_documents WHERE canvas_id = ?
      `).get(canvasId).updated_at), beforeRaceUpdatedAt);
      assert.deepEqual(logicalDatabaseSnapshot(backup), beforeRaceSnapshot);
      assert.equal(primary.pragma('quick_check', { simple: true }), 'ok');
      assert.equal(backup.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(primary.pragma('foreign_key_check'), []);
      assert.deepEqual(backup.pragma('foreign_key_check'), []);
    } finally {
      primary.close();
      backup.close();
    }
  } finally {
    await closeQuietly(database);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('B2 retry safely replaces an existing pre-migration backup after a rolled-back v29 attempt', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-prebackup-retry-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const backupFilename = path.join(directory, 'projects.pre-migration-v28.sqlite3');
  const suffix = '-prebackup-retry';
  let database = null;
  try {
    database = new ProjectDatabase(filename, databaseOptions());
    seedCanvas(database, suffix);
    await database.close();
    database = null;

    const legacy = new BetterSqlite3(filename);
    let expectedBackupSnapshot;
    let schema28Ledger;
    try {
      downgradeToSchema28(legacy);
      expectedBackupSnapshot = logicalDatabaseSnapshot(legacy);
      schema28Ledger = migrationLedger(legacy);
      legacy.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      legacy.close();
    }

    const firstAttemptPhases = [];
    assert.throws(
      () => new ProjectDatabase(filename, {
        autoBackup: false,
        preMigrationBackupFilename: backupFilename,
        preMigration30Backup: false,
        beforeExecutableMigrationPhase(_database, event) {
          assert.equal(event.version, 29);
          firstAttemptPhases.push(event.phase);
          if (event.phase === 'after-ddl') throw new Error('b2-v29-first-attempt-fault');
        },
      }),
      /b2-v29-first-attempt-fault/,
    );
    assert.deepEqual(firstAttemptPhases, ['after-from-verify', 'after-ddl']);
    assert.equal(fs.existsSync(backupFilename), true);

    const rolledBack = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
    const firstBackup = new BetterSqlite3(backupFilename, { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(migrationLedger(rolledBack), schema28Ledger);
      assert.deepEqual(ownedV29Objects(rolledBack), []);
      assert.deepEqual(logicalDatabaseSnapshot(firstBackup), expectedBackupSnapshot);
      assert.equal(firstBackup.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(firstBackup.pragma('foreign_key_check'), []);
    } finally {
      rolledBack.close();
      firstBackup.close();
    }

    database = new ProjectDatabase(filename, {
      autoBackup: false,
      preMigrationBackupFilename: backupFilename,
      preMigration30Backup: false,
    });
    assert.equal(database.db.prepare(`
      SELECT MAX(version) AS version FROM schema_migrations
    `).get().version, PROJECT_DATABASE_SCHEMA_VERSION);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
    await database.close();
    database = null;

    const finalBackup = new BetterSqlite3(backupFilename, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      assert.equal(migrationLedger(finalBackup).at(-1).version, 28);
      assert.deepEqual(migrationLedger(finalBackup), schema28Ledger);
      assert.deepEqual(ownedV29Objects(finalBackup), []);
      assert.deepEqual(logicalDatabaseSnapshot(finalBackup), expectedBackupSnapshot);
      assert.equal(finalBackup.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(finalBackup.pragma('foreign_key_check'), []);
    } finally {
      finalBackup.close();
    }
  } finally {
    await closeQuietly(database);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('B2 hard process exit at every v29 checkpoint rolls back exactly and preserves revision continuity', async (t) => {
  for (const [checkpointIndex, phase] of MIGRATION_29_CHECKPOINTS.entries()) {
    await t.test(phase, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `t8-b2-v29-crash-${checkpointIndex}-`));
      const filename = path.join(directory, 'projects.sqlite3');
      const backupFilename = path.join(directory, 'projects.pre-migration-v28.sqlite3');
      const markerFilename = path.join(directory, 'migration-crash-marker.json');
      const suffix = `-crash-${checkpointIndex}`;
      const canvasId = `${CANVAS_ID}${suffix}`;
      let database = null;
      try {
        database = new ProjectDatabase(filename, databaseOptions());
        let document = seedCanvas(database, suffix);
        document = moveNode(database, document, checkpointIndex + 1);
        assert.equal(document.revision, 2);
        await database.close();
        database = null;

        const legacy = new BetterSqlite3(filename);
        let schema28Snapshot;
        let schema28Ledger;
        try {
          downgradeToSchema28(legacy);
          schema28Snapshot = logicalDatabaseSnapshot(legacy);
          schema28Ledger = migrationLedger(legacy);
          assert.equal(schema28Ledger.at(-1).version, 28);
          assert.equal(legacy.pragma('quick_check', { simple: true }), 'ok');
          assert.deepEqual(legacy.pragma('foreign_key_check'), []);
          legacy.pragma('wal_checkpoint(TRUNCATE)');
        } finally {
          legacy.close();
        }

        const crashed = crashMigrationAtCheckpoint({
          filename,
          backupFilename,
          markerFilename,
          phase,
          version: 29,
        });
        assert.equal(
          crashed.status,
          91,
          `checkpoint ${phase} did not terminate at the injected boundary: ${crashed.error?.message || crashed.stderr || crashed.stdout}`,
        );
        assert.equal(crashed.signal, null);
        const crashMarker = JSON.parse(fs.readFileSync(markerFilename, 'utf8'));
        assert.equal(crashMarker.version, PROJECT_DATABASE_MIGRATION_29.version);
        assert.equal(crashMarker.name, PROJECT_DATABASE_MIGRATION_29.name);
        assert.equal(crashMarker.phase, phase);
        assert.equal(fs.existsSync(backupFilename), true);

        const primaryAfterCrash = new BetterSqlite3(filename);
        const backupAfterCrash = new BetterSqlite3(backupFilename, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          primaryAfterCrash.pragma('foreign_keys = ON');
          assert.deepEqual(migrationLedger(primaryAfterCrash), schema28Ledger);
          assert.deepEqual(ownedV29Objects(primaryAfterCrash), []);
          assert.deepEqual(ownedV30Objects(primaryAfterCrash), []);
          assert.deepEqual(logicalDatabaseSnapshot(primaryAfterCrash), schema28Snapshot);
          assert.equal(primaryAfterCrash.pragma('quick_check', { simple: true }), 'ok');
          assert.deepEqual(primaryAfterCrash.pragma('foreign_key_check'), []);

          assert.deepEqual(migrationLedger(backupAfterCrash), schema28Ledger);
          assert.deepEqual(ownedV29Objects(backupAfterCrash), []);
          assert.deepEqual(ownedV30Objects(backupAfterCrash), []);
          assert.deepEqual(logicalDatabaseSnapshot(backupAfterCrash), schema28Snapshot);
          assert.equal(backupAfterCrash.pragma('quick_check', { simple: true }), 'ok');
          assert.deepEqual(backupAfterCrash.pragma('foreign_key_check'), []);
        } finally {
          primaryAfterCrash.close();
          backupAfterCrash.close();
        }

        database = new ProjectDatabase(filename, {
          autoBackup: false,
          preMigrationBackupFilename: backupFilename,
          preMigration30Backup: false,
        });
        document = database.getCanvas(canvasId);
        assert.equal(document.revision, 2);
        assert.equal(database.db.prepare(`
          SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?
        `).get(canvasId).count, 1);
        assert.equal(database.db.prepare(`
          SELECT COUNT(*) AS count FROM canvas_operation_idempotency WHERE canvas_id = ?
        `).get(canvasId).count, 1);
        document = moveNode(database, document, 100 + checkpointIndex);
        assert.equal(document.revision, 3);
        assert.equal(database.db.prepare(`
          SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?
        `).get(canvasId).count, 2);
        assert.equal(database.db.prepare(`
          SELECT COUNT(*) AS count FROM canvas_operation_idempotency WHERE canvas_id = ?
        `).get(canvasId).count, 2);
        assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
        assert.deepEqual(database.db.pragma('foreign_key_check'), []);
        await database.close();
        database = null;

        database = new ProjectDatabase(filename, databaseOptions());
        assert.equal(database.getCanvas(canvasId).revision, 3);
        assert.equal(database.db.prepare(`
          SELECT MAX(version) AS version FROM schema_migrations
        `).get().version, PROJECT_DATABASE_SCHEMA_VERSION);
        assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
        assert.deepEqual(database.db.pragma('foreign_key_check'), []);
      } finally {
        await closeQuietly(database);
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });
  }

  await t.test('after-commit-control', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-v29-crash-commit-'));
    const filename = path.join(directory, 'projects.sqlite3');
    const backupFilename = path.join(directory, 'projects.pre-migration-v28.sqlite3');
    const markerFilename = path.join(directory, 'migration-crash-marker.json');
    const suffix = '-crash-after-commit';
    const canvasId = `${CANVAS_ID}${suffix}`;
    let database = null;
    try {
      database = new ProjectDatabase(filename, databaseOptions());
      let document = seedCanvas(database, suffix);
      document = moveNode(database, document, 700);
      assert.equal(document.revision, 2);
      await database.close();
      database = null;

      const legacy = new BetterSqlite3(filename);
      let schema28Snapshot;
      let schema28Ledger;
      try {
        downgradeToSchema28(legacy);
        schema28Snapshot = logicalDatabaseSnapshot(legacy);
        schema28Ledger = migrationLedger(legacy);
        legacy.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        legacy.close();
      }

      const crashed = crashMigrationAtCheckpoint({
        filename,
        backupFilename,
        markerFilename,
        phase: 'after-commit-control',
        version: 29,
      });
      assert.equal(
        crashed.status,
        93,
        `committed control did not terminate after v29 commit: ${crashed.error?.message || crashed.stderr || crashed.stdout}`,
      );
      assert.equal(crashed.signal, null);
      assert.deepEqual(JSON.parse(fs.readFileSync(markerFilename, 'utf8')), {
        phase: 'after-commit-control',
        committedVersion: 29,
        interceptedVersion: 30,
        interceptedPhase: 'after-from-verify',
      });

      const primaryAfterCommit = new BetterSqlite3(filename);
      const backupAfterCommit = new BetterSqlite3(backupFilename, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        primaryAfterCommit.pragma('foreign_keys = ON');
        assert.equal(migrationLedger(primaryAfterCommit).at(-1).version, 29);
        assert.equal(
          ownedV29Objects(primaryAfterCommit).length,
          PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES.length,
        );
        assert.deepEqual(ownedV30Objects(primaryAfterCommit), []);
        assert.equal(primaryAfterCommit.prepare(`
          SELECT COUNT(*) AS count FROM schema_migration_receipts WHERE version = 29
        `).get().count, 1);
        assert.equal(primaryAfterCommit.prepare(`
          SELECT revision FROM canvas_documents WHERE canvas_id = ?
        `).get(canvasId).revision, 2);
        assert.equal(primaryAfterCommit.prepare(`
          SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?
        `).get(canvasId).count, 1);
        assert.equal(primaryAfterCommit.prepare(`
          SELECT COUNT(*) AS count FROM canvas_operation_idempotency WHERE canvas_id = ?
        `).get(canvasId).count, 1);
        assert.equal(primaryAfterCommit.pragma('quick_check', { simple: true }), 'ok');
        assert.deepEqual(primaryAfterCommit.pragma('foreign_key_check'), []);

        assert.deepEqual(migrationLedger(backupAfterCommit), schema28Ledger);
        assert.deepEqual(ownedV29Objects(backupAfterCommit), []);
        assert.deepEqual(ownedV30Objects(backupAfterCommit), []);
        assert.deepEqual(logicalDatabaseSnapshot(backupAfterCommit), schema28Snapshot);
        assert.equal(backupAfterCommit.pragma('quick_check', { simple: true }), 'ok');
        assert.deepEqual(backupAfterCommit.pragma('foreign_key_check'), []);
      } finally {
        primaryAfterCommit.close();
        backupAfterCommit.close();
      }

      database = new ProjectDatabase(filename, databaseOptions());
      document = database.getCanvas(canvasId);
      assert.equal(document.revision, 2);
      assert.equal(migrationLedger(database.db).at(-1).version, PROJECT_DATABASE_SCHEMA_VERSION);
      assert.equal(
        ownedV30Objects(database.db).length,
        PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES.length,
      );
      document = moveNode(database, document, 701);
      assert.equal(document.revision, 3);
      assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(database.db.pragma('foreign_key_check'), []);
    } finally {
      await closeQuietly(database);
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

test('B2 hard process exit at every v30 checkpoint rolls back exactly and preserves revision continuity', async (t) => {
  for (const [checkpointIndex, phase] of MIGRATION_30_CHECKPOINTS.entries()) {
    await t.test(phase, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `t8-b2-v30-crash-${checkpointIndex}-`));
      const filename = path.join(directory, 'projects.sqlite3');
      const backupFilename = path.join(directory, 'projects.pre-migration-v29.sqlite3');
      const markerFilename = path.join(directory, 'migration-crash-marker.json');
      const suffix = `-v30-crash-${checkpointIndex}`;
      const canvasId = `${CANVAS_ID}${suffix}`;
      let database = null;
      try {
        database = new ProjectDatabase(filename, databaseOptions());
        let document = seedCanvas(database, suffix);
        document = moveNode(database, document, 800 + checkpointIndex);
        assert.equal(document.revision, 2);
        await database.close();
        database = null;

        const legacy = new BetterSqlite3(filename);
        let schema29Snapshot;
        let schema29Ledger;
        try {
          downgradeToSchema29(legacy);
          schema29Snapshot = logicalDatabaseSnapshot(legacy);
          schema29Ledger = migrationLedger(legacy);
          assert.equal(schema29Ledger.at(-1).version, PROJECT_DATABASE_MIGRATION_29.version);
          assert.equal(
            ownedV29Objects(legacy).length,
            PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES.length,
          );
          assert.deepEqual(ownedV30Objects(legacy), []);
          assert.equal(legacy.pragma('quick_check', { simple: true }), 'ok');
          assert.deepEqual(legacy.pragma('foreign_key_check'), []);
          legacy.pragma('wal_checkpoint(TRUNCATE)');
        } finally {
          legacy.close();
        }

        const crashed = crashMigrationAtCheckpoint({
          filename,
          backupFilename,
          markerFilename,
          phase,
          version: PROJECT_DATABASE_MIGRATION_30.version,
        });
        assert.equal(
          crashed.status,
          91,
          `v30 checkpoint ${phase} did not terminate at the injected boundary: ${crashed.error?.message || crashed.stderr || crashed.stdout}`,
        );
        assert.equal(crashed.signal, null);
        const crashMarker = JSON.parse(fs.readFileSync(markerFilename, 'utf8'));
        assert.equal(crashMarker.version, PROJECT_DATABASE_MIGRATION_30.version);
        assert.equal(crashMarker.name, PROJECT_DATABASE_MIGRATION_30.name);
        assert.equal(crashMarker.phase, phase);
        assert.equal(fs.existsSync(backupFilename), true);

        const primaryAfterCrash = new BetterSqlite3(filename);
        const backupAfterCrash = new BetterSqlite3(backupFilename, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          primaryAfterCrash.pragma('foreign_keys = ON');
          assert.deepEqual(migrationLedger(primaryAfterCrash), schema29Ledger);
          assert.equal(
            ownedV29Objects(primaryAfterCrash).length,
            PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES.length,
          );
          assert.deepEqual(ownedV30Objects(primaryAfterCrash), []);
          assert.equal(primaryAfterCrash.prepare(`
            SELECT COUNT(*) AS count FROM schema_migration_receipts WHERE version = 29
          `).get().count, 1);
          assert.equal(primaryAfterCrash.prepare(`
            SELECT COUNT(*) AS count FROM schema_migration_receipts WHERE version = 30
          `).get().count, 0);
          assert.deepEqual(logicalDatabaseSnapshot(primaryAfterCrash), schema29Snapshot);
          assert.equal(primaryAfterCrash.pragma('quick_check', { simple: true }), 'ok');
          assert.deepEqual(primaryAfterCrash.pragma('foreign_key_check'), []);

          assert.deepEqual(migrationLedger(backupAfterCrash), schema29Ledger);
          assert.equal(
            ownedV29Objects(backupAfterCrash).length,
            PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES.length,
          );
          assert.deepEqual(ownedV30Objects(backupAfterCrash), []);
          assert.deepEqual(logicalDatabaseSnapshot(backupAfterCrash), schema29Snapshot);
          assert.equal(backupAfterCrash.pragma('quick_check', { simple: true }), 'ok');
          assert.deepEqual(backupAfterCrash.pragma('foreign_key_check'), []);
        } finally {
          primaryAfterCrash.close();
          backupAfterCrash.close();
        }

        database = new ProjectDatabase(filename, databaseOptions({
          preMigration30Backup: true,
          preMigration30BackupFilename: backupFilename,
        }));
        assert.equal(migrationLedger(database.db).at(-1).version, PROJECT_DATABASE_SCHEMA_VERSION);
        assert.equal(
          ownedV30Objects(database.db).length,
          PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES.length,
        );
        document = database.getCanvas(canvasId);
        assert.equal(document.revision, 2);
        assert.equal(database.db.prepare(`
          SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?
        `).get(canvasId).count, 1);
        assert.equal(database.db.prepare(`
          SELECT COUNT(*) AS count FROM canvas_operation_idempotency WHERE canvas_id = ?
        `).get(canvasId).count, 1);
        document = moveNode(database, document, 900 + checkpointIndex);
        assert.equal(document.revision, 3);
        assert.equal(database.db.prepare(`
          SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?
        `).get(canvasId).count, 2);
        assert.equal(database.db.prepare(`
          SELECT COUNT(*) AS count FROM canvas_operation_idempotency WHERE canvas_id = ?
        `).get(canvasId).count, 2);
        assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
        assert.deepEqual(database.db.pragma('foreign_key_check'), []);
        await database.close();
        database = null;

        database = new ProjectDatabase(filename, databaseOptions());
        assert.equal(database.getCanvas(canvasId).revision, 3);
        assert.equal(migrationLedger(database.db).at(-1).version, PROJECT_DATABASE_SCHEMA_VERSION);
        assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
        assert.deepEqual(database.db.pragma('foreign_key_check'), []);
      } finally {
        await closeQuietly(database);
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });
  }

  await t.test('after-commit-control', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-v30-crash-commit-'));
    const filename = path.join(directory, 'projects.sqlite3');
    const backupFilename = path.join(directory, 'projects.pre-migration-v29.sqlite3');
    const markerFilename = path.join(directory, 'migration-crash-marker.json');
    const suffix = '-v30-crash-after-commit';
    const canvasId = `${CANVAS_ID}${suffix}`;
    let database = null;
    try {
      database = new ProjectDatabase(filename, databaseOptions());
      let document = seedCanvas(database, suffix);
      document = moveNode(database, document, 950);
      assert.equal(document.revision, 2);
      await database.close();
      database = null;

      const legacy = new BetterSqlite3(filename);
      let schema29Snapshot;
      let schema29Ledger;
      try {
        downgradeToSchema29(legacy);
        schema29Snapshot = logicalDatabaseSnapshot(legacy);
        schema29Ledger = migrationLedger(legacy);
        assert.equal(schema29Ledger.at(-1).version, PROJECT_DATABASE_MIGRATION_29.version);
        legacy.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        legacy.close();
      }

      const crashed = crashMigrationAtCheckpoint({
        filename,
        backupFilename,
        markerFilename,
        phase: 'after-commit-control',
        version: PROJECT_DATABASE_MIGRATION_30.version,
      });
      assert.equal(
        crashed.status,
        93,
        `committed control did not terminate after v30 commit: ${crashed.error?.message || crashed.stderr || crashed.stdout}`,
      );
      assert.equal(crashed.signal, null);
      assert.deepEqual(JSON.parse(fs.readFileSync(markerFilename, 'utf8')), {
        phase: 'after-commit-control',
        committedVersion: PROJECT_DATABASE_MIGRATION_30.version,
      });

      const primaryAfterCommit = new BetterSqlite3(filename);
      const backupAfterCommit = new BetterSqlite3(backupFilename, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        primaryAfterCommit.pragma('foreign_keys = ON');
        assert.equal(migrationLedger(primaryAfterCommit).at(-1).version, PROJECT_DATABASE_SCHEMA_VERSION);
        assert.equal(
          ownedV29Objects(primaryAfterCommit).length,
          PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES.length,
        );
        assert.equal(
          ownedV30Objects(primaryAfterCommit).length,
          PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES.length,
        );
        assert.equal(primaryAfterCommit.prepare(`
          SELECT COUNT(*) AS count FROM schema_migration_receipts WHERE version = 30
        `).get().count, 1);
        assert.equal(primaryAfterCommit.prepare(`
          SELECT revision FROM canvas_documents WHERE canvas_id = ?
        `).get(canvasId).revision, 2);
        assert.equal(primaryAfterCommit.prepare(`
          SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?
        `).get(canvasId).count, 1);
        assert.equal(primaryAfterCommit.prepare(`
          SELECT COUNT(*) AS count FROM canvas_operation_idempotency WHERE canvas_id = ?
        `).get(canvasId).count, 1);
        assert.equal(primaryAfterCommit.pragma('quick_check', { simple: true }), 'ok');
        assert.deepEqual(primaryAfterCommit.pragma('foreign_key_check'), []);

        assert.deepEqual(migrationLedger(backupAfterCommit), schema29Ledger);
        assert.equal(
          ownedV29Objects(backupAfterCommit).length,
          PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES.length,
        );
        assert.deepEqual(ownedV30Objects(backupAfterCommit), []);
        assert.deepEqual(logicalDatabaseSnapshot(backupAfterCommit), schema29Snapshot);
        assert.equal(backupAfterCommit.pragma('quick_check', { simple: true }), 'ok');
        assert.deepEqual(backupAfterCommit.pragma('foreign_key_check'), []);
      } finally {
        primaryAfterCommit.close();
        backupAfterCommit.close();
      }

      database = new ProjectDatabase(filename, databaseOptions());
      document = database.getCanvas(canvasId);
      assert.equal(document.revision, 2);
      document = moveNode(database, document, 951);
      assert.equal(document.revision, 3);
      assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(database.db.pragma('foreign_key_check'), []);
    } finally {
      await closeQuietly(database);
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

assertCurrentProjectDatabaseRegistry(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATIONS);
