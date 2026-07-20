'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { stableEntityUuid } = require('../backend/src/collaboration/protocol');
const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');
const { RunRecoveryManager } = require('../backend/src/services/runRecovery');

const PROJECT_ID = 'run-recovery-storage-project-b2';
const CANVAS_ID = 'run-recovery-storage-canvas-b2';
const NODE_ID = 'run-recovery-storage-node-b2';
const MAX_PAGE_COUNT_RESET = 1073741823;

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-run-recovery-storage-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  return {
    directory,
    database: new ProjectDatabase(filename, { autoBackup: false }),
  };
}

async function cleanupDatabase(database, directory) {
  try {
    if (database?.db?.open) database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
  } catch (_) {}
  try { await database?.close(); } catch (_) {}
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function createActiveRecovery(database, suffix) {
  const nodeEntityUid = stableEntityUuid('t8-run-recovery-storage-node-v1', `${NODE_ID}:${suffix}`);
  const canvas = database.ensureCanvas(CANVAS_ID, {
    projectId: PROJECT_ID,
    nodes: [{
      id: NODE_ID,
      entityUid: nodeEntityUid,
      entityRevision: 1,
      type: 'image',
      position: { x: 0, y: 0 },
      data: {},
    }],
    edges: [],
  }, PROJECT_ID);
  const run = database.createRun({
    id: `run-recovery-storage-${suffix}`,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    canvasRevision: canvas.revision,
    status: 'running',
  });
  const nodeRun = database.createNodeRun({
    id: `node-run-recovery-storage-${suffix}`,
    runId: run.id,
    nodeId: NODE_ID,
    status: 'running',
  });
  const attempt = database.createAttempt({
    id: `attempt-recovery-storage-${suffix}`,
    nodeRunId: nodeRun.id,
    provider: 'seedance-nz',
    model: 'wan-2.7-spicy-i2v',
    upstreamTaskId: `task-recovery-storage-${suffix}`,
    status: 'running',
    pollCount: 2,
    metadata: {
      recovery: {
        kind: 'wan',
        taskId: `task-recovery-storage-${suffix}`,
        model: 'wan-2.7-spicy-i2v',
        pollIntervalMs: 250,
        maxPolls: 1,
      },
    },
  });
  return { run, nodeRun, attempt };
}

function durableUsageState(database) {
  return {
    project: database.db.prepare(`
      SELECT ledger_kind, row_count, logical_bytes
      FROM project_durable_ledger_usage
      WHERE project_id = ?
      ORDER BY ledger_kind ASC
    `).all(PROJECT_ID),
    global: database.db.prepare(`
      SELECT ledger_kind, row_count, logical_bytes
      FROM database_durable_ledger_usage
      WHERE singleton_id = 1
      ORDER BY ledger_kind ASC
    `).all(),
  };
}

function recoveryState(database, fixture) {
  return {
    nodeRun: database.getNodeRun(fixture.nodeRun.id),
    attempt: database.getAttempt(fixture.attempt.id),
    events: database.getRunEvents(fixture.run.id),
    durableUsage: durableUsageState(database),
  };
}

function armRealFull(database, { triggerName, table, whenSql }) {
  const markerName = `${triggerName}_mark`;
  let hitCount = 0;
  database.db.function(markerName, () => {
    hitCount += 1;
    return 1;
  });
  database.db.exec(`
    CREATE TABLE IF NOT EXISTS b2_run_recovery_storage_filler (
      id INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
    CREATE TRIGGER ${triggerName}
    BEFORE ${table}
    WHEN ${whenSql}
    BEGIN
      SELECT ${markerName}();
      INSERT INTO b2_run_recovery_storage_filler(payload) VALUES (zeroblob(16777216));
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
  return {
    get hitCount() { return hitCount; },
    disarm() {
      database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
      database.db.exec(`DROP TRIGGER ${triggerName}`);
    },
  };
}

function assertStorageError(error, operation) {
  return error instanceof ProjectDatabaseStorageCapacityError
    && error.code === 'project_database_storage_capacity_exceeded'
    && error.status === 507
    && error.reason === 'sqlite-full'
    && error.details?.operation === operation;
}

function fillerRows(database) {
  return Number(database.db.prepare(`
    SELECT COUNT(*) AS count FROM b2_run_recovery_storage_filler
  `).get().count);
}

function recoveryStartedEvents(database, runId) {
  return database.getRunEvents(runId).filter(
    (event) => event.type === 'log' && event.payload?.phase === 'recovery.started',
  );
}

test('B2 RunRecovery start event, NodeRun, and Attempt share one real-FULL rollback boundary', async () => {
  const { database, directory } = temporaryDatabase();
  try {
    const fixture = createActiveRecovery(database, 'start');
    const before = recoveryState(database, fixture);
    let queryCalls = 0;
    const transactionStates = [];
    const manager = new RunRecoveryManager({
      database,
      baseUrl: 'http://127.0.0.1:1',
      queryRecovery: async () => {
        queryCalls += 1;
        transactionStates.push(database.db.inTransaction);
        return { state: 'failed', outputs: [], usage: {}, error: 'expected retry terminal', providerStatus: 'failed' };
      },
      broadcast: {
        node: () => transactionStates.push(database.db.inTransaction),
        run: () => transactionStates.push(database.db.inTransaction),
      },
    });
    const attemptId = fixture.attempt.id.replaceAll("'", "''");
    const full = armRealFull(database, {
      triggerName: 'b2_run_recovery_start_real_full',
      table: 'UPDATE ON run_attempts',
      whenSql: `OLD.id = '${attemptId}'
        AND json_extract(OLD.timestamps_json, '$.recoveryStartedAt') IS NULL
        AND json_extract(NEW.timestamps_json, '$.recoveryStartedAt') IS NOT NULL`,
    });

    await assert.rejects(
      manager.recoverPendingRuns(),
      (error) => assertStorageError(error, 'run.recovery.start'),
    );
    assert.equal(full.hitCount, 1);
    assert.equal(queryCalls, 0);
    assert.deepEqual(transactionStates, []);
    assert.deepEqual(recoveryState(database, fixture), before);
    assert.equal(fillerRows(database), 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    full.disarm();
    const retry = await manager.recoverPendingRuns();
    assert.equal(retry.failed, 1);
    assert.equal(recoveryStartedEvents(database, fixture.run.id).length, 1);
    assert.equal(database.getNodeRun(fixture.nodeRun.id).status, 'failed');
    assert.equal(database.getAttempt(fixture.attempt.id).status, 'failed');
    assert.equal(queryCalls, 1);
    assert.equal(transactionStates.every((state) => state === false), true);
  } finally {
    await cleanupDatabase(database, directory);
  }
});

test('B2 RunRecovery poll progress and provider event share one real-FULL rollback boundary', async () => {
  const { database, directory } = temporaryDatabase();
  try {
    const fixture = createActiveRecovery(database, 'poll');
    let stateAfterStart = null;
    const transactionStates = [];
    const manager = new RunRecoveryManager({
      database,
      baseUrl: 'http://127.0.0.1:1',
      queryRecovery: async () => {
        transactionStates.push(database.db.inTransaction);
        stateAfterStart = recoveryState(database, fixture);
        return {
          state: 'pending',
          outputs: [],
          usage: { credits: 7 },
          error: null,
          providerStatus: 'running',
        };
      },
      broadcast: {
        node: () => transactionStates.push(database.db.inTransaction),
      },
    });
    const full = armRealFull(database, {
      triggerName: 'b2_run_recovery_poll_real_full',
      table: 'INSERT ON run_events',
      whenSql: "NEW.type = 'provider.polling'",
    });

    await assert.rejects(
      manager.recoverPendingRuns(),
      (error) => assertStorageError(error, 'run.recovery.poll'),
    );
    assert.equal(full.hitCount, 1);
    assert.ok(stateAfterStart);
    assert.deepEqual(recoveryState(database, fixture), stateAfterStart);
    assert.equal(database.getAttempt(fixture.attempt.id).pollCount, 2);
    assert.equal(database.getRunEvents(fixture.run.id).some((event) => event.type === 'provider.polling'), false);
    assert.equal(fillerRows(database), 0);
    assert.equal(transactionStates.every((state) => state === false), true);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    full.disarm();
    const retry = new RunRecoveryManager({
      database,
      baseUrl: 'http://127.0.0.1:1',
      queryRecovery: async () => {
        assert.equal(database.db.inTransaction, false);
        return { state: 'failed', outputs: [], usage: { credits: 7 }, error: 'retry terminal', providerStatus: 'failed' };
      },
    });
    const result = await retry.recoverPendingRuns();
    assert.equal(result.failed, 1);
    assert.equal(database.getRunEvents(fixture.run.id).filter((event) => event.type === 'provider.polling').length, 1);
    assert.equal(database.getAttempt(fixture.attempt.id).pollCount, 3);
  } finally {
    await cleanupDatabase(database, directory);
  }
});

test('B2 RunRecovery poll CAS cannot revive a hierarchy terminalized during provider query', async () => {
  const { database, directory } = temporaryDatabase();
  try {
    const fixture = createActiveRecovery(database, 'poll-cas');
    const manager = new RunRecoveryManager({
      database,
      baseUrl: 'http://127.0.0.1:1',
      queryRecovery: async () => {
        assert.equal(database.db.inTransaction, false);
        database.updateRun(fixture.run.id, { status: 'failed', finishedAt: Date.now() });
        database.updateNodeRun(fixture.nodeRun.id, { status: 'failed' });
        database.updateAttempt(fixture.attempt.id, {
          status: 'failed',
          error: { kind: 'cancelled', code: 'CONCURRENT_TERMINAL', message: 'terminalized during query' },
        }, { runId: fixture.run.id, nodeRunId: fixture.nodeRun.id });
        return {
          state: 'pending',
          outputs: [],
          usage: { credits: 99 },
          error: null,
          providerStatus: 'running',
        };
      },
    });

    await assert.rejects(
      manager.recoverPendingRuns(),
      (error) => error?.code === 'run_recovery_state_conflict'
        && error?.status === 409
        && error?.retryable === false,
    );
    assert.equal(database.getRun(fixture.run.id).status, 'failed');
    assert.equal(database.getNodeRun(fixture.nodeRun.id).status, 'failed');
    const attempt = database.getAttempt(fixture.attempt.id);
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.pollCount, 2);
    assert.equal(attempt.usage.credits, undefined);
    assert.equal(attempt.metadata.recoveryProviderStatus, undefined);
    assert.equal(database.getRunEvents(fixture.run.id).some((event) => event.type === 'provider.polling'), false);
    assert.equal(manager.status().status, 'failed');
    assert.equal(manager.status().running, false);
  } finally {
    await cleanupDatabase(database, directory);
  }
});

test('B2 RunRecovery keeps its singleton fence until every ticket in a failed chunk settles', async () => {
  const { database, directory } = temporaryDatabase();
  try {
    const fullFixture = createActiveRecovery(database, 'fence-full');
    const blockedFixture = createActiveRecovery(database, 'fence-blocked');
    const attemptId = fullFixture.attempt.id.replaceAll("'", "''");
    const full = armRealFull(database, {
      triggerName: 'b2_run_recovery_fence_real_full',
      table: 'UPDATE ON run_attempts',
      whenSql: `OLD.id = '${attemptId}'
        AND json_extract(OLD.timestamps_json, '$.recoveryStartedAt') IS NULL
        AND json_extract(NEW.timestamps_json, '$.recoveryStartedAt') IS NOT NULL`,
    });
    let releaseQuery;
    let queryCalls = 0;
    let markQueryEntered;
    const queryEntered = new Promise((resolve) => { markQueryEntered = resolve; });
    const queryGate = new Promise((resolve) => { releaseQuery = resolve; });
    const manager = new RunRecoveryManager({
      database,
      baseUrl: 'http://127.0.0.1:1',
      queryRecovery: async (_descriptor, ticket) => {
        assert.equal(ticket.attempt.id, blockedFixture.attempt.id);
        assert.equal(database.db.inTransaction, false);
        queryCalls += 1;
        markQueryEntered();
        return queryGate;
      },
    });

    const first = manager.recoverPendingRuns();
    await queryEntered;
    const second = manager.recoverPendingRuns();
    assert.strictEqual(second, first);
    let settled = false;
    first.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(manager.status().running, true);

    releaseQuery({
      state: 'failed',
      outputs: [],
      usage: {},
      error: 'blocked ticket released',
      providerStatus: 'failed',
    });
    await assert.rejects(first, (error) => assertStorageError(error, 'run.recovery.start'));
    await assert.rejects(second, (error) => assertStorageError(error, 'run.recovery.start'));
    assert.equal(full.hitCount, 1);
    assert.equal(queryCalls, 1);
    assert.equal(recoveryStartedEvents(database, fullFixture.run.id).length, 0);
    assert.equal(recoveryStartedEvents(database, blockedFixture.run.id).length, 1);
    assert.equal(database.getRunEvents(blockedFixture.run.id).filter((event) => event.type === 'provider.polling').length, 1);
    assert.equal(database.getRun(blockedFixture.run.id).status, 'failed');
    assert.equal(manager.status().status, 'failed');
    assert.equal(manager.status().running, false);
    full.disarm();
  } finally {
    await cleanupDatabase(database, directory);
  }
});
