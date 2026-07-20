'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { stableEntityUuid } = require('../backend/src/collaboration/protocol');
const {
  ProjectDatabase,
  ProjectDatabaseDurableLedgerError,
  ProjectDatabaseHistoryCapacityError,
  ProjectDatabaseStorageCapacityError,
  SubflowRevisionConflictError,
} = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'project-run-subflow-capacity-b2';
const CANVAS_ID = 'canvas-run-subflow-capacity-b2';
const NODE_ID = 'node-run-subflow-capacity-b2';
const NODE_ENTITY_UID = stableEntityUuid('t8-b2-run-subflow-capacity-node-v1', NODE_ID);
const MAX_PAGE_COUNT_RESET = 1073741823;

function ensureCanvas(database) {
  return database.ensureCanvas(CANVAS_ID, {
    projectId: PROJECT_ID,
    nodes: [{
      id: NODE_ID,
      entityUid: NODE_ENTITY_UID,
      entityRevision: 1,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { prompt: 'B2 transaction rollback' },
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }, PROJECT_ID);
}

function createTempDatabase(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-run-subflow-capacity-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  return {
    directory,
    database: new ProjectDatabase(filename, { autoBackup: false, ...options }),
  };
}

async function closeTempDatabase(database, directory) {
  try {
    if (database?.db?.open) database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
  } catch (_) {}
  try { await database?.close(); } catch (_) {}
  fs.rmSync(directory, { recursive: true, force: true });
}

function armRealAuditFull(database, { triggerName, action }) {
  const markerName = `${triggerName}_mark`;
  let hitCount = 0;
  database.db.function(markerName, () => {
    hitCount += 1;
    return 1;
  });
  database.db.exec(`
    CREATE TABLE IF NOT EXISTS b2_run_subflow_capacity_filler (
      id INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT ON audit_events
    WHEN NEW.action = '${action}'
    BEGIN
      SELECT ${markerName}();
      INSERT INTO b2_run_subflow_capacity_filler(payload) VALUES (zeroblob(16777216));
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

function assertStorageCapacityError(error, operation, reason = 'sqlite-full') {
  return error instanceof ProjectDatabaseStorageCapacityError
    && error.code === 'project_database_storage_capacity_exceeded'
    && error.status === 507
    && error.statusCode === 507
    && error.reason === reason
    && error.details?.reason === reason
    && error.details?.operation === operation;
}

function auditCount(database, action) {
  return Number(database.db.prepare(`
    SELECT COUNT(*) AS count FROM audit_events
    WHERE project_id = ? AND action = ?
  `).get(PROJECT_ID, action)?.count || 0);
}

function createActiveRecovery(database) {
  const canvas = ensureCanvas(database);
  const run = database.createRun({
    id: 'run-recovery-capacity-b2',
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    canvasRevision: canvas.revision,
    initiatorId: 'recovery-member-b2',
    status: 'running',
  });
  const nodeRun = database.createNodeRun({
    id: 'node-run-recovery-capacity-b2',
    runId: run.id,
    nodeId: NODE_ID,
    status: 'polling',
  });
  const attempt = database.createAttempt({
    id: 'attempt-recovery-capacity-b2',
    nodeRunId: nodeRun.id,
    provider: 'seedance-nz',
    model: 'wan-2.7-spicy-i2v',
    upstreamTaskId: 'task-recovery-capacity-b2',
    status: 'polling',
    pollCount: 2,
  });
  const createdIntent = database.createRunIntent({
    id: 'intent-recovery-capacity-b2',
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    canvasRevision: canvas.revision,
    nodeIds: [NODE_ID],
    idempotencyKey: 'intent-recovery-capacity-b2',
    requestedBy: 'recovery-member-b2',
    confirmationRequired: false,
    estimatedCostKnown: false,
  });
  const intent = database.updateRunIntent(createdIntent.id, {
    status: 'running',
    runId: run.id,
  });
  return {
    run,
    nodeRun,
    attempt,
    intent,
    terminal: {
      runId: run.id,
      runEntityUid: run.entityUid,
      nodeRunId: nodeRun.id,
      nodeRunEntityUid: nodeRun.entityUid,
      attemptId: attempt.id,
      attemptEntityUid: attempt.entityUid,
      status: 'succeeded',
      usage: { costUsd: 0.75 },
      finishedAt: 1234,
      recoveredAt: 1234,
    },
  };
}

function recoveryState(database, fixture) {
  return {
    run: database.getRun(fixture.run.id),
    nodeRun: database.getNodeRun(fixture.nodeRun.id),
    attempt: database.getAttempt(fixture.attempt.id),
    intent: database.getRunIntent(fixture.intent.id),
    events: database.getRunEvents(fixture.run.id),
    finishAudits: auditCount(database, 'run-intent.finish'),
  };
}

test('B2 completeRecoveredRunAttempt translates capacity only after rollback and preserves BUSY/durable/history errors', async () => {
  let injected = null;
  const { database, directory } = createTempDatabase({
    beforeRunRecoveryTerminalStep: ({ step }) => {
      if (step === 'before-node-run' && injected) throw injected;
    },
  });
  try {
    const fixture = createActiveRecovery(database);
    const before = recoveryState(database, fixture);
    const preservedErrors = [
      Object.assign(new Error('busy must remain busy'), { code: 'SQLITE_BUSY_TIMEOUT' }),
      new ProjectDatabaseDurableLedgerError(
        'project_durable_ledger_capacity_exceeded',
        'durable capacity',
        507,
      ),
      new ProjectDatabaseHistoryCapacityError(
        'canvas_snapshot_history_capacity_exceeded',
        'history capacity',
      ),
    ];
    for (const source of preservedErrors) {
      injected = source;
      let caught = null;
      try {
        database.completeRecoveredRunAttempt(fixture.terminal);
      } catch (error) {
        caught = error;
      }
      assert.strictEqual(caught, source);
      assert.deepEqual(recoveryState(database, fixture), before);
    }

    for (const [code, reason] of [
      ['SQLITE_FULL_SNAPSHOT', 'sqlite-full'],
      ['ENOSPC', 'filesystem-reserve'],
      ['EDQUOT', 'filesystem-reserve'],
    ]) {
      injected = Object.assign(new Error(`injected ${code}`), { code });
      assert.throws(
        () => database.completeRecoveredRunAttempt(fixture.terminal),
        (error) => assertStorageCapacityError(error, 'run.recovery.complete', reason),
      );
      assert.deepEqual(recoveryState(database, fixture), before);
    }

    injected = null;
    const full = armRealAuditFull(database, {
      triggerName: 'b2_recovery_terminal_real_full',
      action: 'run-intent.finish',
    });
    assert.throws(
      () => database.completeRecoveredRunAttempt(fixture.terminal),
      (error) => assertStorageCapacityError(error, 'run.recovery.complete'),
    );
    assert.equal(full.hitCount, 1);
    assert.deepEqual(recoveryState(database, fixture), before);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM b2_run_subflow_capacity_filler
    `).get().count, 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    full.disarm();
    const completed = database.completeRecoveredRunAttempt(fixture.terminal);
    assert.equal(completed.duplicate, false);
    assert.equal(completed.run.status, 'succeeded');
    assert.equal(completed.nodeRun.status, 'succeeded');
    assert.equal(completed.attempt.status, 'succeeded');
    assert.equal(completed.intent.status, 'completed');
    assert.equal(auditCount(database, 'run-intent.finish'), 1);
    const replay = database.completeRecoveredRunAttempt(fixture.terminal);
    assert.equal(replay.duplicate, true);
    assert.equal(auditCount(database, 'run-intent.finish'), 1);
  } finally {
    await closeTempDatabase(database, directory);
  }
});

test('B2 claimRunIntent translates late real SQLITE_FULL, rolls back claim/audit/pin state, and preserves lease errors', async () => {
  const { database, directory } = createTempDatabase();
  try {
    const canvas = ensureCanvas(database);
    const intent = database.createRunIntent({
      id: 'intent-claim-capacity-b2',
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      canvasRevision: canvas.revision,
      nodeIds: [NODE_ID],
      idempotencyKey: 'intent-claim-capacity-b2',
      requestedBy: 'claim-member-b2',
      confirmationRequired: false,
      estimatedCostKnown: false,
    });
    const run = database.createRun({
      id: 'run-claim-capacity-b2',
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      canvasRevision: canvas.revision,
      initiatorId: intent.requestedBy,
      status: 'running',
    });
    const before = database.getRunIntent(intent.id);
    const full = armRealAuditFull(database, {
      triggerName: 'b2_claim_run_intent_real_full',
      action: 'run-intent.claim',
    });
    const claimOptions = {
      expectedQueueRevision: intent.queueRevision,
      allowLegacyUnleased: true,
      actorId: 'host-executor',
      sessionId: 'host-dispatch',
      now: 2345,
    };
    assert.throws(
      () => database.claimRunIntent(intent.id, run, claimOptions),
      (error) => assertStorageCapacityError(error, 'run-intent.claim'),
    );
    assert.equal(full.hitCount, 1);
    assert.deepEqual(database.getRunIntent(intent.id), before);
    assert.equal(auditCount(database, 'run-intent.claim'), 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM b2_run_subflow_capacity_filler
    `).get().count, 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    full.disarm();
    const claimed = database.claimRunIntent(intent.id, run, claimOptions);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.runId, run.id);
    assert.equal(claimed.queueRevision, intent.queueRevision + 1);
    assert.equal(auditCount(database, 'run-intent.claim'), 1);

    const leaseIntent = database.createRunIntent({
      id: 'intent-lease-error-capacity-b2',
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      canvasRevision: canvas.revision,
      nodeIds: [NODE_ID],
      idempotencyKey: 'intent-lease-error-capacity-b2',
      requestedBy: 'claim-member-b2',
      confirmationRequired: false,
      estimatedCostKnown: false,
    });
    const leaseRun = database.createRun({
      id: 'run-lease-error-capacity-b2',
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      canvasRevision: canvas.revision,
      initiatorId: leaseIntent.requestedBy,
      status: 'running',
    });
    assert.throws(
      () => database.claimRunIntent(leaseIntent.id, leaseRun, {
        expectedQueueRevision: leaseIntent.queueRevision,
        workerId: 'wrong-worker-b2',
        leaseToken: '10000000-0000-4000-8000-000000000001',
        now: 3456,
      }),
      (error) => error.code === 'run_intent_lease_invalid' && error.status === 409,
    );
    assert.deepEqual(database.getRunIntent(leaseIntent.id), leaseIntent);
  } finally {
    await closeTempDatabase(database, directory);
  }
});

test('B2 saveSubflowDefinition translates late real SQLITE_FULL, rolls back version/head/audit, and preserves revision conflicts', async () => {
  const { database, directory } = createTempDatabase();
  try {
    const definition = {
      id: 'subflow-capacity-b2',
      projectId: PROJECT_ID,
      name: 'Subflow capacity B2',
      description: '',
      tags: [],
      nodes: [],
      edges: [],
      inputs: [],
      outputs: [],
      exposedParameters: [],
      requiredCapabilities: [],
      assetRefs: [],
    };
    const options = {
      expectedRevision: 0,
      actorId: 'subflow-owner-b2',
      sessionId: 'subflow-session-b2',
    };
    const full = armRealAuditFull(database, {
      triggerName: 'b2_save_subflow_real_full',
      action: 'subflow.definition.publish',
    });
    assert.throws(
      () => database.saveSubflowDefinition(definition, options),
      (error) => assertStorageCapacityError(error, 'subflow.definition.save'),
    );
    assert.equal(full.hitCount, 1);
    assert.equal(database.getSubflowDefinition(definition.id, null, PROJECT_ID), null);
    assert.equal(database.getSubflowDefinitionHead(definition.id, PROJECT_ID), null);
    assert.equal(auditCount(database, 'subflow.definition.publish'), 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM b2_run_subflow_capacity_filler
    `).get().count, 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    full.disarm();
    const saved = database.saveSubflowDefinition(definition, options);
    assert.equal(saved.version, 1);
    assert.equal(saved.revision, 1);
    assert.equal(database.getSubflowDefinitionHead(definition.id, PROJECT_ID).revision, 1);
    assert.equal(auditCount(database, 'subflow.definition.publish'), 1);

    assert.throws(
      () => database.saveSubflowDefinition({ ...definition, name: 'stale overwrite' }, options),
      (error) => error instanceof SubflowRevisionConflictError
        && error.code === 'subflow_revision_conflict'
        && error.current?.revision === 1,
    );
    assert.equal(database.getSubflowDefinitionHead(definition.id, PROJECT_ID).revision, 1);
    assert.equal(database.listSubflowVersions(definition.id, PROJECT_ID).length, 1);
    assert.equal(auditCount(database, 'subflow.definition.publish'), 1);
  } finally {
    await closeTempDatabase(database, directory);
  }
});
