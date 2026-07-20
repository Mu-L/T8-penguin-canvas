'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'project-run-retention-policy-capacity-b2';
const MAX_PAGE_COUNT_RESET = 1073741823;
const RETRY_PATCH = Object.freeze({
  maxDays: 91,
  maxRuns: 1234,
  maxAssetRefs: 4567,
  maxDbBytes: 256 * 1024 * 1024,
  keepReferenced: false,
});

function scalarCount(database, sql, ...values) {
  return Number(database.db.prepare(sql).get(...values)?.count || 0);
}

function retentionRow(database) {
  return database.db.prepare(`
    SELECT
      project_id AS projectId,
      max_days AS maxDays,
      max_runs AS maxRuns,
      max_asset_refs AS maxAssetRefs,
      max_db_bytes AS maxDbBytes,
      keep_referenced AS keepReferenced,
      updated_at AS updatedAt
    FROM run_retention_policies
    WHERE project_id = ?
  `).get(PROJECT_ID) || null;
}

function assertCapacityError(error, operation) {
  assert.ok(error instanceof ProjectDatabaseStorageCapacityError);
  assert.equal(error.code, 'project_database_storage_capacity_exceeded');
  assert.equal(error.status, 507);
  assert.equal(error.statusCode, 507);
  assert.equal(error.reason, 'sqlite-full');
  assert.equal(error.retryable, false);
  assert.deepEqual(error.details, {
    reason: 'sqlite-full',
    retryable: false,
    operation,
  });
  return true;
}

function installLateRetentionPolicyFull(database) {
  const attemptedRows = [];
  database.db.function(
    'run_retention_policy_capacity_b2_mark_late',
    (maxDays, maxRuns, maxAssetRefs, maxDbBytes, keepReferenced, updatedAt) => {
      attemptedRows.push({
        maxDays,
        maxRuns,
        maxAssetRefs,
        maxDbBytes,
        keepReferenced,
        updatedAt,
      });
      return 1;
    },
  );
  database.db.exec(`
    CREATE TABLE run_retention_policy_capacity_b2_filler (
      id INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
    CREATE TRIGGER run_retention_policy_capacity_b2_force_late_full
    AFTER UPDATE OF max_days, max_runs, max_asset_refs, max_db_bytes, keep_referenced, updated_at
    ON run_retention_policies
    WHEN OLD.project_id = '${PROJECT_ID}'
    BEGIN
      SELECT run_retention_policy_capacity_b2_mark_late(
        NEW.max_days,
        NEW.max_runs,
        NEW.max_asset_refs,
        NEW.max_db_bytes,
        NEW.keep_referenced,
        NEW.updated_at
      );
      INSERT INTO run_retention_policy_capacity_b2_filler(payload)
      VALUES (zeroblob(4194304));
    END;
  `);

  database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
  database.db.pragma('wal_checkpoint(TRUNCATE)');
  database.db.exec('VACUUM');
  database.db.pragma('wal_checkpoint(TRUNCATE)');
  const pageCount = Number(database.db.pragma('page_count', { simple: true }));
  const constrainedPageCount = pageCount + 64;
  assert.equal(
    Number(database.db.pragma(`max_page_count = ${constrainedPageCount}`, { simple: true })),
    constrainedPageCount,
  );

  return {
    attemptedRows,
    release() {
      database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
    },
  };
}

test('B2 setRunRetentionPolicy declares the unified operation and preserves upstream error identity', () => {
  for (const source of [
    Object.assign(new Error('retention writer remains busy'), { code: 'SQLITE_BUSY_TIMEOUT' }),
    Object.assign(new Error('retention policy conflict'), {
      code: 'run_retention_policy_conflict',
      status: 409,
    }),
    new ProjectDatabaseStorageCapacityError('wal-pressure', {
      operation: 'upstream.retention-policy',
    }),
  ]) {
    let operation = null;
    let caught = null;
    try {
      ProjectDatabase.prototype.setRunRetentionPolicy.call({
        withProjectDatabaseWrite(candidateOperation) {
          operation = candidateOperation;
          throw source;
        },
      }, PROJECT_ID, RETRY_PATCH);
    } catch (error) {
      caught = error;
    }
    assert.equal(operation, 'run.retention-policy');
    assert.strictEqual(caught, source);
  }
});

test('B2 setRunRetentionPolicy reads and normalizes the current policy under its IMMEDIATE boundary', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const originalBoundary = database.withProjectDatabaseWrite.bind(database);
  const originalGetPolicy = database.getRunRetentionPolicy.bind(database);
  const operations = [];
  let reads = 0;

  try {
    database.withProjectDatabaseWrite = (operation, callback) => {
      operations.push(operation);
      return originalBoundary(operation, () => {
        assert.equal(database.db.inTransaction, true);
        return callback();
      });
    };
    database.getRunRetentionPolicy = (projectId) => {
      reads += 1;
      assert.equal(database.db.inTransaction, true, 'current policy must not be read before BEGIN IMMEDIATE');
      return originalGetPolicy(projectId);
    };

    const result = database.setRunRetentionPolicy(PROJECT_ID, {
      maxDays: 99999,
      maxRuns: 1,
      maxAssetRefs: 12.9,
      maxDbBytes: 1,
      keepReferenced: false,
    });

    assert.deepEqual(operations, ['run.retention-policy']);
    assert.equal(reads, 1);
    assert.deepEqual(result, {
      projectId: PROJECT_ID,
      maxDays: 3650,
      maxRuns: 10,
      maxAssetRefs: 12,
      maxDbBytes: 64 * 1024 * 1024,
      keepReferenced: false,
      updatedAt: result.updatedAt,
    });
    assert.ok(result.updatedAt > 0);
    assert.deepEqual(retentionRow(database), {
      ...result,
      keepReferenced: 0,
    });
    assert.equal(database.db.inTransaction, false);
  } finally {
    await database.close();
  }
});

test('B2 TEMP retention policy write rolls back real late FULL, retries exactly, and leaves BUSY distinct', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-run-retention-policy-capacity-b2-'));
  const filename = path.join(directory, 'project.sqlite3');
  const database = new ProjectDatabase(filename, { autoBackup: false });
  let blocker = null;
  let fault = null;

  try {
    database.setRunRetentionPolicy(PROJECT_ID, {
      maxDays: 30,
      maxRuns: 500,
      maxAssetRefs: 900,
      maxDbBytes: 128 * 1024 * 1024,
      keepReferenced: true,
    });
    database.db.prepare(`
      UPDATE run_retention_policies SET updated_at = 1 WHERE project_id = ?
    `).run(PROJECT_ID);
    const before = retentionRow(database);
    fault = installLateRetentionPolicyFull(database);

    assert.throws(
      () => database.setRunRetentionPolicy(PROJECT_ID, RETRY_PATCH),
      (error) => assertCapacityError(error, 'run.retention-policy'),
    );
    assert.equal(fault.attemptedRows.length, 1, 'FULL must occur after SQLite has formed the complete new row');
    assert.deepEqual(fault.attemptedRows[0], {
      ...RETRY_PATCH,
      keepReferenced: 0,
      updatedAt: fault.attemptedRows[0].updatedAt,
    });
    assert.ok(fault.attemptedRows[0].updatedAt > before.updatedAt);
    assert.deepEqual(retentionRow(database), before, 'all policy columns and updated_at must roll back together');
    assert.equal(
      scalarCount(database, 'SELECT COUNT(*) AS count FROM run_retention_policy_capacity_b2_filler'),
      0,
    );

    assert.throws(
      () => database.withProjectDatabaseWrite('run.retention-policy.outer-test', () => (
        database.setRunRetentionPolicy(PROJECT_ID, RETRY_PATCH)
      )),
      (error) => assertCapacityError(error, 'run.retention-policy.outer-test'),
    );
    assert.equal(fault.attemptedRows.length, 2);
    assert.deepEqual(retentionRow(database), before);
    assert.equal(
      scalarCount(database, 'SELECT COUNT(*) AS count FROM run_retention_policy_capacity_b2_filler'),
      0,
    );
    assert.equal(database.db.inTransaction, false);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    fault.release();
    const retried = database.setRunRetentionPolicy(PROJECT_ID, RETRY_PATCH);
    assert.deepEqual(retried, {
      projectId: PROJECT_ID,
      ...RETRY_PATCH,
      updatedAt: retried.updatedAt,
    });
    assert.ok(retried.updatedAt > before.updatedAt);
    assert.deepEqual(retentionRow(database), {
      ...retried,
      keepReferenced: 0,
    });
    assert.deepEqual(database.getRunRetentionPolicy(PROJECT_ID), retried);
    assert.equal(fault.attemptedRows.length, 3);
    assert.equal(
      scalarCount(database, 'SELECT COUNT(*) AS count FROM run_retention_policy_capacity_b2_filler'),
      1,
    );

    database.db.pragma('busy_timeout = 1');
    blocker = new BetterSqlite3(filename);
    blocker.exec('BEGIN IMMEDIATE');
    const beforeBusy = retentionRow(database);
    const fillerBeforeBusy = scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM run_retention_policy_capacity_b2_filler',
    );
    let busy = null;
    try {
      database.setRunRetentionPolicy(PROJECT_ID, {
        ...RETRY_PATCH,
        maxDays: RETRY_PATCH.maxDays + 1,
      });
    } catch (error) {
      busy = error;
    }
    assert.ok(busy);
    assert.match(String(busy.code || ''), /^SQLITE_BUSY/);
    assert.equal(busy instanceof ProjectDatabaseStorageCapacityError, false);
    assert.deepEqual(retentionRow(database), beforeBusy);
    assert.equal(
      scalarCount(database, 'SELECT COUNT(*) AS count FROM run_retention_policy_capacity_b2_filler'),
      fillerBeforeBusy,
    );
    assert.equal(fault.attemptedRows.length, 3, 'BEGIN IMMEDIATE must fail before the current-row read and trigger');

    blocker.exec('ROLLBACK');
    blocker.close();
    blocker = null;
    database.db.pragma('busy_timeout = 5000');
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try { blocker?.exec('ROLLBACK'); } catch (_) {}
    try { blocker?.close(); } catch (_) {}
    try { fault?.release(); } catch (_) {}
    try { await database.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
