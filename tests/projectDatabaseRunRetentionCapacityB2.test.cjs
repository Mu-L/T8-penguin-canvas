'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'project-run-retention-capacity-b2';
const CANVAS_ID = 'canvas-run-retention-capacity-b2';
const MAX_PAGE_COUNT_RESET = 1073741823;

function seedPrunableRun(database, id) {
  const canvas = database.ensureCanvas(CANVAS_ID, {
    projectId: PROJECT_ID,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }, PROJECT_ID);
  const run = database.createRun({
    id,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    canvasRevision: canvas.revision,
    status: 'succeeded',
  });
  database.db.prepare('UPDATE runs SET created_at = 1 WHERE id = ?').run(run.id);
  database.setRunRetentionPolicy(PROJECT_ID, {
    maxDays: 1,
    maxRuns: 100,
    maxAssetRefs: 100,
    keepReferenced: true,
  });
  return run;
}

function runPinCount(database, runId) {
  return Number(database.db.prepare(`
    SELECT COUNT(*) AS count FROM canvas_snapshot_pins
    WHERE project_id = ? AND canvas_id = ?
      AND pin_kind = 'run' AND owner_id = ? AND slot = 'canvas'
  `).get(PROJECT_ID, CANVAS_ID, runId)?.count || 0);
}

test('B2 Run retention uses the outer write boundary for real late FULL rollback and exact retry', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-run-retention-capacity-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const database = new ProjectDatabase(filename, { autoBackup: false });
  const run = seedPrunableRun(database, 'run-retention-real-full-b2');
  let deleteTriggerHits = 0;

  try {
    database.db.function('b2_run_retention_delete_mark', () => {
      deleteTriggerHits += 1;
      return 1;
    });
    database.db.exec(`
      CREATE TABLE b2_run_retention_capacity_filler (
        id INTEGER PRIMARY KEY,
        payload BLOB NOT NULL
      );
      CREATE TRIGGER b2_run_retention_force_late_full
      BEFORE DELETE ON runs
      WHEN OLD.id = '${run.id}'
      BEGIN
        SELECT b2_run_retention_delete_mark();
        INSERT INTO b2_run_retention_capacity_filler(payload) VALUES (zeroblob(16777216));
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

    assert.throws(
      () => database.pruneRuns(PROJECT_ID),
      (error) => error instanceof ProjectDatabaseStorageCapacityError
        && error.code === 'project_database_storage_capacity_exceeded'
        && error.status === 507
        && error.reason === 'sqlite-full'
        && error.details?.operation === 'run.retention-prune',
    );
    assert.equal(deleteTriggerHits, 1);
    assert.equal(database.db.inTransaction, false);
    assert.equal(database.getRun(run.id)?.id, run.id);
    assert.equal(runPinCount(database, run.id), 1);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM b2_run_retention_capacity_filler
    `).get().count, 0);

    database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
    database.db.exec('DROP TRIGGER b2_run_retention_force_late_full');
    const retried = database.pruneRuns(PROJECT_ID);
    assert.equal(retried.deletedRuns, 1);
    assert.equal(database.getRun(run.id), null);
    assert.equal(runPinCount(database, run.id), 0);
    assert.equal(retried.maintenance.checkpoint.attempted, true);
    assert.equal(retried.maintenance.checkpoint.mode, 'passive');
    assert.equal(retried.maintenance.vacuum.attempted, false);
    assert.equal(
      retried.maintenance.vacuum.reason,
      'requires-explicit-free-space-admission',
    );
  } finally {
    try { database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`); } catch (_) {}
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('B2 Run retention reports post-commit checkpoint failure without hiding the committed delete or running VACUUM', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const run = seedPrunableRun(database, 'run-retention-checkpoint-failure-b2');
  const originalPragma = database.db.pragma.bind(database.db);
  const originalExec = database.db.exec.bind(database.db);
  let checkpointCalls = 0;
  let vacuumCalls = 0;

  try {
    database.db.pragma = (source, options) => {
      if (String(source).trim().toLowerCase() === 'wal_checkpoint(passive)') {
        checkpointCalls += 1;
        throw Object.assign(new Error('C:\\private\\database\\checkpoint.sqlite3'), {
          code: 'SQLITE_BUSY',
        });
      }
      return originalPragma(source, options);
    };
    database.db.exec = (source) => {
      if (/^\s*VACUUM\b/i.test(String(source))) {
        vacuumCalls += 1;
        throw new Error('VACUUM must require explicit admission');
      }
      return originalExec(source);
    };

    const result = database.pruneRuns(PROJECT_ID);
    assert.equal(result.deletedRuns, 1);
    assert.equal(database.getRun(run.id), null);
    assert.equal(runPinCount(database, run.id), 0);
    assert.equal(checkpointCalls, 1);
    assert.equal(vacuumCalls, 0);
    assert.deepEqual(result.maintenance, {
      checkpoint: {
        attempted: true,
        mode: 'passive',
        ok: false,
        busy: null,
        logFrames: null,
        checkpointedFrames: null,
        failure: {
          code: 'project_database_checkpoint_failed',
          retryable: true,
        },
      },
      vacuum: {
        attempted: false,
        reason: 'requires-explicit-free-space-admission',
      },
    });
    assert.equal(JSON.stringify(result).includes('private'), false);
  } finally {
    database.db.pragma = originalPragma;
    database.db.exec = originalExec;
    await database.close();
  }
});
