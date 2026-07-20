const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const { COMMON_OPERATION_BATCH_CONTRACT } = require('../backend/src/collaboration/commonOperationProtocol');
const { stableEntityUuid } = require('../backend/src/collaboration/protocol');
const {
  PROJECT_DATABASE_MIGRATIONS,
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');
const {
  PROJECT_DATABASE_MIGRATION_29_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration29');
const {
  PROJECT_DATABASE_MIGRATION_30_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration30');
const {
  PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS,
} = require('../backend/src/services/projectDatabaseMigration31');
const {
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS,
} = require('../backend/src/services/projectDatabaseMigration31DurableLedgers');
const {
  assertCurrentProjectDatabaseRegistry,
  stripSchema32ForSyntheticSchema31,
} = require('./helpers/projectDatabaseVersion.cjs');

const PROJECT_ID = 'project-f7';
const CANVAS_ID = 'canvas-f7';
const OTHER_CANVAS_ID = 'canvas-f7-other';
const HOST_IDENTITY = Object.freeze({ actorId: 'host-executor', sessionId: 'host-authority' });
const NODE_UID = '28000000-0000-4000-8000-000000000001';

function ensureCanvas(database, canvasId = CANVAS_ID, projectId = PROJECT_ID) {
  return database.ensureCanvas(canvasId, {
    projectId,
    nodes: [{
      id: 'node-f7',
      entityUid: NODE_UID,
      entityRevision: 1,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { prompt: 'F7 authoritative output' },
    }],
    edges: [],
  }, projectId);
}

let intentSequence = 0;
function createIntent(database, overrides = {}) {
  intentSequence += 1;
  const canvas = overrides.canvas || database.getCanvas(overrides.canvasId || CANVAS_ID) || ensureCanvas(database);
  return database.createRunIntent({
    id: overrides.id,
    projectId: overrides.projectId || canvas.projectId,
    canvasId: overrides.canvasId || canvas.canvasId,
    canvasRevision: overrides.canvasRevision || canvas.revision,
    nodeIds: ['node-f7'],
    idempotencyKey: overrides.idempotencyKey || `f7-intent-${intentSequence}`,
    requestedBy: overrides.requestedBy || 'member-f7',
    confirmationRequired: overrides.confirmationRequired,
    estimatedCost: overrides.estimatedCost,
    estimatedCostKnown: overrides.estimatedCostKnown,
  });
}

function createRunForIntent(database, intent, suffix) {
  return database.createRun({
    id: `run-f7-${suffix}`,
    projectId: intent.projectId,
    canvasId: intent.canvasId,
    canvasRevision: intent.canvasRevision,
    initiatorId: intent.requestedBy,
    status: 'running',
  });
}

function queueScope(intent, extra = {}) {
  return {
    projectId: intent.projectId,
    canvasId: intent.canvasId,
    expectedQueueRevision: intent.queueRevision,
    ...extra,
  };
}

function addAuditFailureTrigger(database, name, action) {
  database.db.exec(`
    CREATE TRIGGER ${name}
    BEFORE INSERT ON audit_events
    WHEN NEW.action = '${action}'
    BEGIN
      SELECT RAISE(ABORT, 'f7 injected audit failure');
    END;
  `);
}

function quoteSqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

// TEST-ONLY fixture teardown. Production schema31 DOWN remains backup-only;
// this helper removes only source-controlled schema31 extension objects from
// a disposable database before the older schema30/schema29 test teardowns run.
function removeSchema31ExtensionForSyntheticSchema30(database) {
  stripSchema32ForSyntheticSchema31(database);
  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      for (const name of [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS.triggers].reverse()) {
        database.exec(`DROP TRIGGER IF EXISTS ${quoteSqlIdentifier(name)}`);
      }
      for (const name of [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS.views].reverse()) {
        database.exec(`DROP VIEW IF EXISTS ${quoteSqlIdentifier(name)}`);
      }
      for (const name of [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS.indexes].reverse()) {
        database.exec(`DROP INDEX IF EXISTS ${quoteSqlIdentifier(name)}`);
      }
      for (const name of [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS.tables].reverse()) {
        database.exec(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(name)}`);
      }
      database.prepare('DELETE FROM schema_migration_receipts WHERE version = 31').run();
      database.prepare('DELETE FROM schema_migrations WHERE version = 31').run();
    }).immediate();
  } finally {
    database.pragma('foreign_keys = ON');
  }
  const ownedNames = Object.values(PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS).flat();
  const placeholders = ownedNames.map(() => '?').join(', ');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN (${placeholders})
  `).get(...ownedNames).count, 0);
  assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 30);
  assert.deepEqual(database.pragma('foreign_key_check'), []);
}

function downgradeCurrentSchemaTo27(database) {
  removeSchema31ExtensionForSyntheticSchema30(database);
  database.pragma('foreign_keys = ON');
  database.prepare('DELETE FROM schema_migration_receipts WHERE version = 30').run();
  database.prepare('DELETE FROM schema_migrations WHERE version = 30').run();
  database.exec(PROJECT_DATABASE_MIGRATION_30_DOWN_SQL);
  database.exec(PROJECT_DATABASE_MIGRATION_29_DOWN_SQL);
  database.exec(`
    DROP TRIGGER IF EXISTS trg_audit_events_mutation_uid_insert;
    DROP TRIGGER IF EXISTS trg_audit_events_append_only_update;
    DROP TRIGGER IF EXISTS trg_audit_events_append_only_delete;
    DROP INDEX IF EXISTS idx_audit_events_mutation_uid;
    DROP TRIGGER IF EXISTS trg_room_execution_policies_scope_insert;
    DROP TRIGGER IF EXISTS trg_room_execution_policies_scope_immutable;
    DROP TABLE IF EXISTS room_execution_policies;
    DROP INDEX IF EXISTS idx_run_intents_dispatch_queue;
    DROP INDEX IF EXISTS idx_run_intents_dispatch_lease;
    DROP INDEX IF EXISTS idx_run_intents_requester_created;
    ALTER TABLE run_intents DROP COLUMN last_error_message;
    ALTER TABLE run_intents DROP COLUMN last_error_code;
    ALTER TABLE run_intents DROP COLUMN cancelled_at;
    ALTER TABLE run_intents DROP COLUMN cancel_requested_at;
    ALTER TABLE run_intents DROP COLUMN last_heartbeat_at;
    ALTER TABLE run_intents DROP COLUMN lease_expires_at;
    ALTER TABLE run_intents DROP COLUMN lease_token;
    ALTER TABLE run_intents DROP COLUMN lease_owner;
    ALTER TABLE run_intents DROP COLUMN next_attempt_at;
    ALTER TABLE run_intents DROP COLUMN dispatch_attempts;
    ALTER TABLE run_intents DROP COLUMN confirmed_by;
    ALTER TABLE run_intents DROP COLUMN confirmed_at;
    ALTER TABLE run_intents DROP COLUMN confirmation_required;
    ALTER TABLE run_intents DROP COLUMN queue_revision;
    ALTER TABLE audit_events DROP COLUMN mutation_uid;
    DELETE FROM schema_migrations WHERE version >= 28;
  `);
  assert.deepEqual(database.pragma('foreign_key_check'), []);
}

test('F7 current schema migrates schema 27 through the committed bridge, backfills identity, and cold-opens', async () => {
  assertCurrentProjectDatabaseRegistry(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATIONS);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-f7-schema-'));
  const filename = path.join(directory, 'project.sqlite');
  const schema30RecoveryFilename = `${filename}.pre-migration-v30.sqlite3`;
  try {
    const initial = new ProjectDatabase(filename, { autoBackup: false });
    ensureCanvas(initial);
    const legacyIntent = createIntent(initial, {
      id: 'legacy-intent-f7',
      idempotencyKey: 'legacy-intent-key-f7',
    });
    const legacyAudit = initial.appendAuditEvent({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      action: 'legacy.audit.f7',
    });
    await initial.close();

    // The fresh schema31 bootstrap owns a schema30 recovery point for that
    // original lineage. This test rewrites the primary into a synthetic v27
    // fixture, so its next v30 boundary must create a new exact recovery point.
    fs.rmSync(schema30RecoveryFilename, { force: true });

    const downgraded = new BetterSqlite3(filename);
    downgraded.prepare("UPDATE run_intents SET status = 'pending' WHERE id = ?").run(legacyIntent.id);
    downgradeCurrentSchemaTo27(downgraded);
    downgraded.close();

    assert.throws(() => new ProjectDatabase(filename, {
      autoBackup: false,
      beforeMigrationCommit(_database, version) {
        if (version === 29) throw new Error('f7 migration rollback');
      },
    }), /f7 migration rollback/);
    const rolledBack = new BetterSqlite3(filename);
    assert.equal(rolledBack.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 28);
    assert.equal(rolledBack.pragma('table_info(run_intents)').some((column) => column.name === 'queue_revision'), true);
    assert.equal(rolledBack.pragma('table_info(audit_events)').some((column) => column.name === 'mutation_uid'), true);
    assert.equal(rolledBack.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='room_execution_policies'").get().count, 1);
    assert.equal(rolledBack.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_migration_receipts'").get().count, 0);
    assert.deepEqual(rolledBack.pragma('foreign_key_check'), []);
    rolledBack.close();

    const migrated = new ProjectDatabase(filename, { autoBackup: false });
    const migratedIntent = migrated.getRunIntent(legacyIntent.id);
    assert.equal(migratedIntent.status, 'accepted');
    assert.equal(migratedIntent.confirmationRequired, false);
    assert.equal(migratedIntent.queueRevision, 1);
    const migratedAudit = migrated.listAuditEvents({ projectId: PROJECT_ID, action: 'legacy.audit.f7' })[0];
    assert.equal(migratedAudit.id, legacyAudit.id);
    assert.match(migratedAudit.mutationUid, /^[0-9a-f-]{36}$/);
    assert.equal(migrated.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(migrated.db.pragma('foreign_key_check'), []);
    await migrated.close();

    const reopened = new ProjectDatabase(filename, { autoBackup: false });
    assert.equal(
      reopened.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      PROJECT_DATABASE_SCHEMA_VERSION,
    );
    assert.equal(reopened.getRunIntent(legacyIntent.id).status, 'accepted');
    assert.equal(reopened.listAuditEvents({ projectId: PROJECT_ID, action: 'legacy.audit.f7' })[0].mutationUid, migratedAudit.mutationUid);
    await reopened.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('F7 intent creation and confirmation preserve idempotency and audit the strict CAS transition', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    ensureCanvas(database);
    const pending = createIntent(database, { idempotencyKey: 'confirmation-f7' });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.confirmationRequired, true);
    assert.equal(pending.queueRevision, 1);
    assert.equal(Object.hasOwn(pending, 'leaseToken'), false);
    const replay = createIntent(database, {
      idempotencyKey: 'confirmation-f7',
      confirmationRequired: false,
    });
    assert.equal(replay.id, pending.id);
    assert.equal(replay.status, 'pending');
    assert.throws(() => database.acceptRunIntentForDispatch(pending.id, {
      ...queueScope(pending),
      canvasId: OTHER_CANVAS_ID,
      confirmedBy: 'owner-f7',
    }), (error) => error.code === 'run_intent_not_found');
    assert.throws(() => database.acceptRunIntentForDispatch(pending.id, {
      ...queueScope(pending),
      expectedQueueRevision: 99,
      confirmedBy: 'owner-f7',
    }), (error) => error.code === 'run_intent_queue_cas_conflict');
    const accepted = database.acceptRunIntentForDispatch(pending.id, {
      ...queueScope(pending),
      confirmedBy: 'owner-f7',
      now: 10_000,
    });
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.queueRevision, 2);
    assert.equal(accepted.confirmedAt, 10_000);
    assert.equal(accepted.confirmedBy, 'owner-f7');
    assert.equal(database.listAuditEvents({ projectId: PROJECT_ID, action: 'run-intent.confirm' }).length, 1);

    const automatic = createIntent(database, {
      idempotencyKey: 'automatic-f7',
      confirmationRequired: false,
    });
    assert.equal(automatic.status, 'accepted');
    assert.equal(automatic.confirmationRequired, false);
  } finally {
    database.close();
  }
});

test('F7 management invalidation is scoped, CAS-audited, atomic, and cannot touch active work', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    ensureCanvas(database);
    const pending = createIntent(database, { id: 'invalidate-pending-f7' });
    const stale = database.transitionRunIntentQueueState(pending.id, {
      ...queueScope(pending),
      status: 'stale',
      actorId: 'owner-f7',
      sessionId: 'management-f7',
      now: 15_000,
    });
    assert.equal(stale.status, 'stale');
    assert.equal(stale.queueRevision, 2);
    assert.equal(Object.hasOwn(stale, 'leaseOwner'), false);
    assert.equal(Object.hasOwn(stale, 'leaseToken'), false);

    const accepted = createIntent(database, {
      id: 'invalidate-accepted-f7',
      confirmationRequired: false,
    });
    addAuditFailureTrigger(database, 'f7_fail_invalidate_audit', 'run-intent.queue.invalidate');
    assert.throws(() => database.transitionRunIntentQueueState(accepted.id, {
      ...queueScope(accepted),
      status: 'rejected',
      now: 16_000,
    }), /injected audit failure/);
    assert.equal(database.getRunIntent(accepted.id).status, 'accepted');
    assert.equal(database.getRunIntent(accepted.id).queueRevision, accepted.queueRevision);
    database.db.exec('DROP TRIGGER f7_fail_invalidate_audit');
    const rejected = database.transitionRunIntentQueueState(accepted.id, {
      ...queueScope(accepted),
      status: 'rejected',
      now: 16_000,
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.queueRevision, 2);
    assert.throws(() => database.transitionRunIntentQueueState(rejected.id, {
      ...queueScope(rejected),
      status: 'failed',
      now: 16_001,
    }), (error) => error.code === 'run_intent_queue_transition_invalid');

    const active = createIntent(database, {
      id: 'invalidate-active-f7',
      confirmationRequired: false,
    });
    const lease = database.leaseRunIntentForDispatch({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
    }, {
      workerId: 'invalidate-worker-f7',
      now: 17_000,
      leaseDurationMs: 5_000,
    });
    assert.equal(lease.intent.id, active.id);
    assert.throws(() => database.transitionRunIntentQueueState(active.id, {
      ...queueScope(lease.intent),
      status: 'stale',
      now: 17_001,
    }), (error) => error.code === 'run_intent_queue_transition_invalid_state');
    const run = createRunForIntent(database, active, 'invalidate-running');
    const running = database.claimRunIntent(active.id, run, {
      expectedQueueRevision: lease.intent.queueRevision,
      workerId: 'invalidate-worker-f7',
      leaseToken: lease.leaseToken,
      now: 17_002,
    });
    assert.throws(() => database.transitionRunIntentQueueState(active.id, {
      ...queueScope(running),
      status: 'rejected',
      now: 17_003,
    }), (error) => error.code === 'run_intent_queue_transition_invalid_state');

    const audits = database.listAuditEvents({
      projectId: PROJECT_ID,
      action: 'run-intent.queue.invalidate',
    });
    assert.equal(audits.length, 2);
    assert.deepEqual(audits.find((event) => event.targetId === pending.entityUid)?.metadata, {
      previousStatus: 'pending',
      status: 'stale',
      previousQueueRevision: 1,
      queueRevision: 2,
    });
  } finally {
    database.close();
  }
});

test('F7 leased policy drift returns exactly to pending confirmation without leaking lease authority', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    ensureCanvas(database);
    const automatic = createIntent(database, {
      id: 'confirmation-drift-f7',
      confirmationRequired: false,
    });
    const lease = database.leaseRunIntentForDispatch({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
    }, {
      workerId: 'confirmation-worker-f7',
      now: 19_000,
      leaseDurationMs: 5_000,
    });
    assert.equal(lease.intent.id, automatic.id);
    assert.equal(Object.hasOwn(lease.intent, 'leaseOwner'), false);
    assert.equal(Object.hasOwn(lease.intent, 'leaseToken'), false);
    assert.throws(() => database.returnRunIntentToPendingConfirmation(automatic.id, {
      ...queueScope(lease.intent),
      expectedQueueRevision: 99,
      workerId: 'confirmation-worker-f7',
      leaseToken: lease.leaseToken,
      now: 19_100,
    }), (error) => error.code === 'run_intent_queue_cas_conflict');
    assert.throws(() => database.returnRunIntentToPendingConfirmation(automatic.id, {
      ...queueScope(lease.intent),
      workerId: 'confirmation-worker-f7',
      leaseToken: '28000000-0000-4000-8000-000000000097',
      now: 19_100,
    }), (error) => error.code === 'run_intent_lease_invalid');
    assert.throws(() => database.returnRunIntentToPendingConfirmation(automatic.id, {
      ...queueScope(lease.intent),
      workerId: 'confirmation-worker-f7',
      leaseToken: lease.leaseToken,
      now: 24_000,
    }), (error) => error.code === 'run_intent_lease_invalid');

    addAuditFailureTrigger(database, 'f7_fail_confirmation_requeue_audit', 'run-intent.confirmation.requeue');
    assert.throws(() => database.returnRunIntentToPendingConfirmation(automatic.id, {
      ...queueScope(lease.intent),
      workerId: 'confirmation-worker-f7',
      leaseToken: lease.leaseToken,
      now: 19_500,
    }), /injected audit failure/);
    assert.equal(database.getRunIntent(automatic.id).status, 'dispatching');
    assert.equal(database.getRunIntent(automatic.id).queueRevision, lease.intent.queueRevision);
    database.db.exec('DROP TRIGGER f7_fail_confirmation_requeue_audit');

    const pending = database.returnRunIntentToPendingConfirmation(automatic.id, {
      ...queueScope(lease.intent),
      workerId: 'confirmation-worker-f7',
      leaseToken: lease.leaseToken,
      actorId: 'host-owner-f7',
      sessionId: 'host-policy-f7',
      now: 19_600,
    });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.confirmationRequired, true);
    assert.equal(pending.confirmedAt, null);
    assert.equal(pending.confirmedBy, null);
    assert.equal(pending.leaseExpiresAt, null);
    assert.equal(pending.lastHeartbeatAt, null);
    assert.equal(pending.nextAttemptAt, 0);
    assert.equal(pending.queueRevision, lease.intent.queueRevision + 1);
    assert.equal(Object.hasOwn(pending, 'leaseOwner'), false);
    assert.equal(Object.hasOwn(pending, 'leaseToken'), false);
    assert.equal(JSON.stringify(pending).includes(lease.leaseToken), false);

    const audit = database.listAuditEvents({
      projectId: PROJECT_ID,
      action: 'run-intent.confirmation.requeue',
    });
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].metadata, {
      previousStatus: 'dispatching',
      status: 'pending',
      previousQueueRevision: lease.intent.queueRevision,
      queueRevision: pending.queueRevision,
      confirmationRequired: true,
    });
    assert.equal(JSON.stringify(audit).includes(lease.leaseToken), false);
    assert.equal(Object.hasOwn(audit[0].metadata, 'leaseOwner'), false);
    assert.equal(Object.hasOwn(audit[0].metadata, 'leaseToken'), false);

    const confirmed = database.acceptRunIntentForDispatch(pending.id, {
      ...queueScope(pending),
      confirmedBy: 'host-owner-f7',
      now: 19_700,
    });
    assert.equal(confirmed.status, 'accepted');
    assert.equal(confirmed.confirmationRequired, true);
    assert.equal(confirmed.confirmedAt, 19_700);
    assert.equal(confirmed.confirmedBy, 'host-owner-f7');
  } finally {
    database.close();
  }
});

test('F7 leases are FIFO, exclusive per canvas, expire safely, retry exponentially, and never expose secrets', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    ensureCanvas(database);
    const first = createIntent(database, { id: 'intent-a-f7', confirmationRequired: false });
    const second = createIntent(database, { id: 'intent-b-f7', confirmationRequired: false });
    database.db.prepare('UPDATE run_intents SET created_at = ? WHERE id = ?').run(100, first.id);
    database.db.prepare('UPDATE run_intents SET created_at = ? WHERE id = ?').run(200, second.id);

    const firstLease = database.leaseRunIntentForDispatch({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
    }, {
      workerId: 'worker-a',
      now: 10_000,
      leaseDurationMs: 1_000,
    });
    assert.equal(firstLease.intent.id, first.id);
    assert.match(firstLease.leaseToken, /^[0-9a-f-]{36}$/);
    assert.equal(Object.hasOwn(firstLease.intent, 'leaseToken'), false);
    assert.equal(JSON.stringify(firstLease.intent).includes(firstLease.leaseToken), false);
    assert.equal(database.leaseRunIntentForDispatch({ projectId: PROJECT_ID, canvasId: CANVAS_ID }, {
      workerId: 'worker-b', now: 10_500, leaseDurationMs: 1_000,
    }), null, 'default room policy permits only one live dispatch/running intent');

    const auditCount = database.listAuditEvents({ projectId: PROJECT_ID }).length;
    assert.throws(() => database.renewRunIntentDispatchLease(first.id, {
      ...queueScope(firstLease.intent),
      workerId: 'worker-a',
      leaseToken: '28000000-0000-4000-8000-000000000099',
      now: 10_500,
      leaseDurationMs: 1_000,
    }), (error) => error.code === 'run_intent_lease_invalid');
    assert.equal(database.getRunIntent(first.id).queueRevision, firstLease.intent.queueRevision);
    assert.equal(database.listAuditEvents({ projectId: PROJECT_ID }).length, auditCount);

    const reclaimed = database.leaseRunIntentForDispatch({ projectId: PROJECT_ID, canvasId: CANVAS_ID }, {
      workerId: 'worker-b', now: 11_000, leaseDurationMs: 1_000,
    });
    assert.equal(reclaimed.intent.id, first.id);
    assert.equal(reclaimed.intent.dispatchAttempts, 2);
    assert.notEqual(reclaimed.leaseToken, firstLease.leaseToken);
    const retried = database.releaseRunIntentDispatchLease(first.id, {
      ...queueScope(reclaimed.intent),
      workerId: 'worker-b',
      leaseToken: reclaimed.leaseToken,
      now: 11_500,
      retryable: true,
      errorCode: 'provider timeout',
      errorMessage: `Authorization=very-secret Bearer abcdefghijklmnop sk-secretvalue1234 ${reclaimed.leaseToken} {"leaseToken":"${reclaimed.leaseToken}"}`,
    });
    assert.equal(retried.status, 'accepted');
    assert.equal(retried.nextAttemptAt, 13_500);
    assert.equal(retried.lastErrorCode, 'provider_timeout');
    assert.equal(/very-secret|abcdefghijklmnop|secretvalue/.test(retried.lastErrorMessage), false);
    assert.equal(retried.lastErrorMessage.includes(reclaimed.leaseToken), false);

    const secondLease = database.leaseRunIntentForDispatch({ projectId: PROJECT_ID, canvasId: CANVAS_ID }, {
      workerId: 'worker-c', now: 12_000, leaseDurationMs: 1_000,
    });
    assert.equal(secondLease.intent.id, second.id, 'backoff makes the next eligible FIFO item dispatchable');
    const failed = database.releaseRunIntentDispatchLease(second.id, {
      ...queueScope(secondLease.intent),
      workerId: 'worker-c',
      leaseToken: secondLease.leaseToken,
      now: 12_500,
      retryable: false,
      errorCode: secondLease.leaseToken,
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.lastErrorCode.includes(secondLease.leaseToken), false);
    const releaseEvidence = JSON.stringify(database.listAuditEvents({
      projectId: PROJECT_ID,
      action: 'run-intent.dispatch.release',
    }));
    assert.equal(releaseEvidence.includes(reclaimed.leaseToken), false);
    assert.equal(releaseEvidence.includes(secondLease.leaseToken), false);
    assert.equal(database.leaseRunIntentForDispatch({ projectId: PROJECT_ID, canvasId: CANVAS_ID }, {
      workerId: 'worker-d', now: 13_499, leaseDurationMs: 1_000,
    }), null);
    assert.equal(database.leaseRunIntentForDispatch({ projectId: PROJECT_ID, canvasId: CANVAS_ID }, {
      workerId: 'worker-d', now: 13_500, leaseDurationMs: 1_000,
    }).intent.id, first.id);
  } finally {
    database.close();
  }
});

test('F7 claim, cancellation, terminal mapping, and audit rollback require exact queue authority', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    ensureCanvas(database);
    const pending = createIntent(database);
    const cancelledPending = database.requestRunIntentCancellation(pending.id, {
      ...queueScope(pending), now: 20_000,
    });
    assert.equal(cancelledPending.status, 'cancelled');
    assert.equal(cancelledPending.cancelledAt, 20_000);

    const dispatch = createIntent(database, { confirmationRequired: false });
    const dispatchLease = database.leaseRunIntentForDispatch({ projectId: PROJECT_ID, canvasId: CANVAS_ID }, {
      workerId: 'worker-cancel', now: 21_000, leaseDurationMs: 5_000,
    });
    assert.equal(dispatchLease.intent.id, dispatch.id);
    const cancellationRequested = database.requestRunIntentCancellation(dispatch.id, {
      ...queueScope(dispatchLease.intent), now: 21_500,
    });
    assert.equal(cancellationRequested.status, 'dispatching');
    assert.equal(cancellationRequested.cancelRequestedAt, 21_500);
    const dispatchRun = createRunForIntent(database, dispatch, 'cancel-dispatch');
    assert.throws(() => database.claimRunIntent(dispatch.id, dispatchRun, {
      expectedQueueRevision: cancellationRequested.queueRevision,
      workerId: 'worker-cancel',
      leaseToken: dispatchLease.leaseToken,
      now: 22_000,
    }), (error) => error.code === 'run_intent_claim_invalid_state');
    const releasedCancelled = database.releaseRunIntentDispatchLease(dispatch.id, {
      ...queueScope(cancellationRequested),
      workerId: 'worker-cancel',
      leaseToken: dispatchLease.leaseToken,
      now: 22_000,
    });
    assert.equal(releasedCancelled.status, 'cancelled');

    const running = createIntent(database, { confirmationRequired: false });
    const runningLease = database.leaseRunIntentForDispatch({ projectId: PROJECT_ID, canvasId: CANVAS_ID }, {
      workerId: 'worker-run', now: 30_000, leaseDurationMs: 5_000,
    });
    const run = createRunForIntent(database, running, 'running-cancel');
    assert.throws(() => database.claimRunIntent(running.id, run, {
      expectedQueueRevision: runningLease.intent.queueRevision,
      workerId: 'worker-run',
      leaseToken: '28000000-0000-4000-8000-000000000098',
      now: 30_500,
    }), (error) => error.code === 'run_intent_lease_invalid');
    addAuditFailureTrigger(database, 'f7_fail_claim_audit', 'run-intent.claim');
    assert.throws(() => database.claimRunIntent(running.id, run, {
      expectedQueueRevision: runningLease.intent.queueRevision,
      workerId: 'worker-run',
      leaseToken: runningLease.leaseToken,
      now: 30_500,
    }), /injected audit failure/);
    assert.equal(database.getRunIntent(running.id).status, 'dispatching');
    assert.equal(database.getRunIntent(running.id).queueRevision, runningLease.intent.queueRevision);
    database.db.exec('DROP TRIGGER f7_fail_claim_audit');
    const claimed = database.claimRunIntent(running.id, run, {
      expectedQueueRevision: runningLease.intent.queueRevision,
      workerId: 'worker-run',
      leaseToken: runningLease.leaseToken,
      now: 30_500,
    });
    assert.equal(claimed.status, 'running');
    assert.equal(Object.hasOwn(claimed, 'leaseOwner'), false);
    const requested = database.requestRunIntentCancellation(running.id, {
      ...queueScope(claimed), now: 31_000,
    });
    assert.equal(requested.status, 'running');
    const terminal = database.finishRunIntentForRun(run.id, 'failed', 0.25, { now: 32_000 });
    assert.equal(terminal.status, 'cancelled');
    assert.equal(terminal.actualCost, 0.25);

    const legacy = createIntent(database);
    const legacyRun = createRunForIntent(database, legacy, 'legacy');
    assert.throws(() => database.claimRunIntent(legacy.id, legacyRun, {
      expectedQueueRevision: legacy.queueRevision,
      now: 40_000,
    }));
    assert.equal(database.claimRunIntent(legacy.id, legacyRun, {
      expectedQueueRevision: legacy.queueRevision,
      allowLegacyUnleased: true,
      now: 40_000,
    }).status, 'running');
  } finally {
    database.close();
  }
});

test('F7 execution usage separates queue from concurrency and room policy is complete CAS-audited', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    ensureCanvas(database);
    const defaultPolicy = database.getRoomExecutionPolicy(PROJECT_ID, CANVAS_ID);
    assert.deepEqual(defaultPolicy, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      allowEditorRuns: true,
      memberDailyRunLimit: 0,
      canvasConcurrencyLimit: 1,
      autoApproveLowRisk: false,
      highCostConfirmationThreshold: 0,
      requireUnknownCostConfirmation: true,
      revision: 0,
      updatedBy: null,
      updatedAt: null,
    });
    const policy = database.setRoomExecutionPolicy(PROJECT_ID, CANVAS_ID, {
      expectedRevision: 0,
      allowEditorRuns: false,
      memberDailyRunLimit: 5,
      canvasConcurrencyLimit: 2,
      autoApproveLowRisk: true,
      highCostConfirmationThreshold: 3.5,
      requireUnknownCostConfirmation: false,
    }, { actorId: 'owner-f7', sessionId: 'policy-f7' });
    assert.equal(policy.revision, 1);
    assert.equal(policy.canvasConcurrencyLimit, 2);
    assert.throws(() => database.setRoomExecutionPolicy(PROJECT_ID, CANVAS_ID, {
      ...policy,
      expectedRevision: 0,
    }), (error) => error.code === 'room_execution_policy_conflict');
    addAuditFailureTrigger(database, 'f7_fail_room_policy_audit', 'collaboration.room-execution-policy.update');
    assert.throws(() => database.setRoomExecutionPolicy(PROJECT_ID, CANVAS_ID, {
      expectedRevision: 1,
      allowEditorRuns: true,
      memberDailyRunLimit: 6,
      canvasConcurrencyLimit: 3,
      autoApproveLowRisk: false,
      highCostConfirmationThreshold: 4,
      requireUnknownCostConfirmation: true,
    }), /injected audit failure/);
    assert.equal(database.getRoomExecutionPolicy(PROJECT_ID, CANVAS_ID).revision, 1);
    database.db.exec('DROP TRIGGER f7_fail_room_policy_audit');

    const pending = createIntent(database, { requestedBy: 'member-f7', estimatedCost: 1 });
    const accepted = createIntent(database, {
      id: 'usage-accepted-f7', requestedBy: 'member-f7', confirmationRequired: false, estimatedCost: 2,
    });
    const dispatching = createIntent(database, {
      requestedBy: 'other-member', confirmationRequired: false, estimatedCost: 3,
    });
    const running = createIntent(database, {
      id: 'usage-running-f7', requestedBy: 'member-f7', confirmationRequired: false, estimatedCost: 4,
    });
    const dispatchLease = database.leaseRunIntentForDispatch({
      projectId: PROJECT_ID, canvasId: CANVAS_ID, requestedBy: dispatching.requestedBy,
    }, { workerId: 'usage-dispatch', now: Date.now(), leaseDurationMs: 30_000 });
    assert.equal(dispatchLease.intent.id, dispatching.id);
    const runningLease = database.leaseRunIntentForDispatch({
      projectId: PROJECT_ID, canvasId: CANVAS_ID, requestedBy: running.requestedBy,
    }, { workerId: 'usage-run', now: Date.now(), leaseDurationMs: 30_000 });
    // The oldest member-f7 accepted intent is selected before `running`.
    assert.equal(runningLease.intent.id, accepted.id);
    const acceptedRun = createRunForIntent(database, accepted, 'usage-running');
    database.claimRunIntent(accepted.id, acceptedRun, {
      expectedQueueRevision: runningLease.intent.queueRevision,
      workerId: 'usage-run',
      leaseToken: runningLease.leaseToken,
      now: Date.now(),
    });
    const usage = database.getExecutionUsage(PROJECT_ID);
    assert.equal(usage.activeCount, 2);
    assert.equal(usage.queuedCount, 2);
    assert.equal(usage.dailyCost, 10);
    const roomUsage = database.getRoomExecutionUsage(PROJECT_ID, CANVAS_ID, 'member-f7');
    assert.equal(roomUsage.activeCount, 2);
    assert.equal(roomUsage.queuedCount, 2);
    assert.equal(roomUsage.requestedByDailyCount, 3);
    assert.equal(pending.status, 'pending');
    assert.equal(running.status, 'accepted');
  } finally {
    database.close();
  }
});

test('F7 expired dispatch is queued and cancellation accounting releases reservations but keeps actual cost', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    ensureCanvas(database);
    const now = Date.now();
    const reserved = createIntent(database, {
      confirmationRequired: false,
      estimatedCost: 5,
    });
    const expiredLease = database.leaseRunIntentForDispatch({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
    }, {
      workerId: 'usage-expired',
      now,
      leaseDurationMs: 1_000,
    });
    assert.equal(expiredLease.intent.id, reserved.id);
    assert.deepEqual(database.getExecutionUsage(PROJECT_ID, now + 1_000), {
      activeCount: 0,
      queuedCount: 1,
      dailyCost: 5,
      unknownCostCount: 0,
      dayStart: new Date(now + 1_000).setHours(0, 0, 0, 0),
    });

    const cancellationRequested = database.requestRunIntentCancellation(reserved.id, {
      ...queueScope(expiredLease.intent),
      now: now + 1_001,
    });
    assert.equal(cancellationRequested.status, 'dispatching');
    assert.equal(database.leaseRunIntentForDispatch({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
    }, {
      workerId: 'usage-sweeper',
      now: now + 1_001,
      leaseDurationMs: 1_000,
    }), null);
    assert.equal(database.getRunIntent(reserved.id).status, 'cancelled');
    assert.equal(database.getExecutionUsage(PROJECT_ID, now + 1_001).dailyCost, 0);

    const unknown = createIntent(database, { confirmationRequired: false });
    assert.equal(database.getExecutionUsage(PROJECT_ID, now + 2_000).unknownCostCount, 1);
    const unknownCancelled = database.requestRunIntentCancellation(unknown.id, {
      ...queueScope(unknown),
      now: now + 2_001,
    });
    assert.equal(unknownCancelled.status, 'cancelled');
    assert.equal(database.getExecutionUsage(PROJECT_ID, now + 2_001).unknownCostCount, 0);

    const charged = createIntent(database, {
      confirmationRequired: false,
      estimatedCost: 8,
    });
    const chargedLease = database.leaseRunIntentForDispatch({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
    }, {
      workerId: 'usage-charged',
      now: now + 3_000,
      leaseDurationMs: 1_000,
    });
    const run = createRunForIntent(database, charged, 'usage-cancelled-cost');
    const claimed = database.claimRunIntent(charged.id, run, {
      expectedQueueRevision: chargedLease.intent.queueRevision,
      workerId: 'usage-charged',
      leaseToken: chargedLease.leaseToken,
      now: now + 3_001,
    });
    const requested = database.requestRunIntentCancellation(charged.id, {
      ...queueScope(claimed),
      now: now + 3_002,
    });
    assert.equal(requested.status, 'running');
    const cancelled = database.finishRunIntentForRun(run.id, 'failed', 1.25, {
      now: now + 3_003,
    });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(database.getExecutionUsage(PROJECT_ID, now + 3_003).dailyCost, 1.25);

    for (const intent of database.listRunIntents({ projectId: PROJECT_ID, canvasId: CANVAS_ID })) {
      assert.equal(Object.hasOwn(intent, 'leaseOwner'), false);
      assert.equal(Object.hasOwn(intent, 'leaseToken'), false);
    }
    for (const event of database.listAuditEvents({ projectId: PROJECT_ID })) {
      assert.equal(Object.hasOwn(event.metadata, 'leaseOwner'), false);
      assert.equal(Object.hasOwn(event.metadata, 'leaseToken'), false);
    }
  } finally {
    database.close();
  }
});

test('F7 audit mutation UID is server-owned, unique, listed, append-only, and policy audit rolls back', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    ensureCanvas(database);
    const forged = '28000000-0000-4000-8000-000000000077';
    const appended = database.appendAuditEvent({
      mutationUid: forged,
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      action: 'audit.f7',
    });
    assert.notEqual(appended.mutationUid, forged);
    assert.equal(database.listAuditEvents({ projectId: PROJECT_ID, action: 'audit.f7' })[0].mutationUid, appended.mutationUid);
    assert.throws(
      () => database.db.prepare('UPDATE audit_events SET action = ? WHERE id = ?').run('forged', appended.id),
      (error) => error?.code === 'SQLITE_CONSTRAINT_TRIGGER'
        && error?.message === PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.immutable.sqliteMessage,
    );
    assert.throws(
      () => database.db.prepare('DELETE FROM audit_events WHERE id = ?').run(appended.id),
      (error) => error?.code === 'SQLITE_CONSTRAINT_TRIGGER'
        && error?.message === PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS.directDelete.sqliteMessage,
    );

    addAuditFailureTrigger(database, 'f7_fail_execution_policy_audit', 'collaboration.execution-policy.update');
    assert.throws(() => database.setExecutionPolicy(PROJECT_ID, {
      allowedModels: ['image:test'],
      dailyCostLimit: 5,
      perRunCostLimit: 2,
      concurrencyLimit: 3,
    }), /injected audit failure/);
    assert.deepEqual(database.getExecutionPolicy(PROJECT_ID).allowedModels, ['*']);
  } finally {
    database.close();
  }
});

test('F7 canvas run-event cursor is globally ordered, bounded, and strictly project/canvas scoped', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    ensureCanvas(database);
    ensureCanvas(database, OTHER_CANVAS_ID, PROJECT_ID);
    ensureCanvas(database, 'canvas-f7-cross-project', 'project-f7-other');
    const runA = database.createRun({
      id: 'run-events-a', projectId: PROJECT_ID, canvasId: CANVAS_ID, canvasRevision: 1, status: 'running',
    });
    const runB = database.createRun({
      id: 'run-events-b', projectId: PROJECT_ID, canvasId: CANVAS_ID, canvasRevision: 1, status: 'running',
    });
    const runOther = database.createRun({
      id: 'run-events-other', projectId: PROJECT_ID, canvasId: OTHER_CANVAS_ID, canvasRevision: 1, status: 'running',
    });
    database.appendRunEvent(runA.id, { type: 'a.1', payload: { value: 1 }, createdAt: 100 });
    database.appendRunEvent(runOther.id, { type: 'other', createdAt: 101 });
    database.appendRunEvent(runB.id, { type: 'b.1', payload: { value: 2 }, createdAt: 102 });
    database.appendRunEvent(runA.id, { type: 'a.2', payload: { value: 3 }, createdAt: 103 });
    const firstPage = database.listCanvasRunEvents(PROJECT_ID, CANVAS_ID, { limit: 2 });
    assert.deepEqual(firstPage.map((event) => event.type), ['a.1', 'b.1']);
    const nextPage = database.listCanvasRunEvents(PROJECT_ID, CANVAS_ID, {
      afterId: firstPage.at(-1).id,
      limit: 5000,
    });
    assert.deepEqual(nextPage.map((event) => event.type), ['a.2']);
    assert.deepEqual(
      database.getRunEvents(runA.id).map((event) => event.entityUid),
      database.listCanvasRunEvents(PROJECT_ID, CANVAS_ID).filter((event) => event.runId === runA.id).map((event) => event.entityUid),
    );
    assert.deepEqual(database.listCanvasRunEvents('project-f7-other', CANVAS_ID), []);
  } finally {
    database.close();
  }
});

function createHostFixture(database, suffix = '') {
  const document = ensureCanvas(database, `${CANVAS_ID}-host${suffix}`, `${PROJECT_ID}-host${suffix}`);
  const run = database.createRun({
    id: `run-host-f7${suffix}`,
    projectId: document.projectId,
    canvasId: document.canvasId,
    canvasRevision: document.revision,
    initiatorId: 'owner-f7',
    status: 'running',
  });
  const nodeRun = database.createNodeRun({
    id: `node-run-host-f7${suffix}`,
    runId: run.id,
    nodeId: 'node-f7',
    originalNodeId: 'node-f7',
    status: 'running',
    inputSnapshot: {
      node: { id: 'node-f7', entityUid: NODE_UID, type: 'text', data: { prompt: 'host F7' } },
      upstreamNodes: [],
      incomingEdges: [],
    },
  });
  const attempt = database.createAttempt({
    id: `attempt-host-f7${suffix}`,
    nodeRunId: nodeRun.id,
    provider: 'host-local',
    model: 'host-model',
    status: 'running',
  });
  const contentHash = suffix ? 'b'.repeat(64) : 'a'.repeat(64);
  const artifactUid = stableEntityUuid('f7-host-artifact', attempt.entityUid, 0);
  const blobUid = stableEntityUuid('t8-asset-blob-v1', 'sha256', contentHash);
  const opId = stableEntityUuid('f7-host-operation', attempt.entityUid, 0);
  const artifact = {
    opId,
    artifactUid,
    blobUid,
    contentHash,
    byteSize: 12,
    kind: 'image',
    filename: 'f7.png',
    mimeType: 'image/png',
    storageKey: `sha256/${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}`,
    managedPath: path.join('C:\\host-private-cas', contentHash),
    outputOrdinal: 0,
    metadata: { size: 12, health: 'ok' },
  };
  const batch = {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: run.projectId,
    canvasId: run.canvasId,
    baseRevision: document.revision,
    batchId: stableEntityUuid('f7-host-batch', attempt.entityUid),
    clientId: stableEntityUuid('f7-host-client', run.entityUid),
    clientSeq: 1,
    operations: [{
      opId,
      type: 'host.artifact.commit',
      payload: {
        artifactUid,
        blobUid,
        runUid: run.entityUid,
        nodeRunUid: nodeRun.entityUid,
        attemptUid: attempt.entityUid,
        nodeUid: NODE_UID,
        expectedCanvasRevision: document.revision,
        expectedRunRevision: run.revision,
        expectedNodeRunRevision: nodeRun.revision,
        expectedAttemptRevision: attempt.revision,
        outputOrdinal: 0,
        kind: artifact.kind,
        contentHash,
        byteSize: artifact.byteSize,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
      },
    }],
  };
  return { document, run, nodeRun, attempt, artifact, batch };
}

test('F7 host artifact grants the exact canvas atomically and exact replay never duplicates the grant', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const fixture = createHostFixture(database);
    const applied = database.applyCommonHostArtifactBatch(fixture.batch, {
      hostIdentity: HOST_IDENTITY,
      verifiedArtifacts: [fixture.artifact],
    });
    assert.equal(applied.duplicate, false);
    const grant = database.db.prepare(`
      SELECT * FROM canvas_resource_grants
      WHERE project_id = ? AND canvas_id = ? AND resource_type = 'asset' AND source = 'host-run-output'
    `).get(fixture.run.projectId, fixture.run.canvasId);
    assert.equal(grant.resource_id, applied.results[0].assetId);
    const grantUpdatedAt = grant.updated_at;
    const replay = database.applyCommonHostArtifactBatch(structuredClone(fixture.batch), {
      hostIdentity: HOST_IDENTITY,
      verifiedArtifacts: [fixture.artifact],
    });
    assert.equal(replay.duplicate, true);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_resource_grants
      WHERE project_id = ? AND canvas_id = ? AND resource_type = 'asset' AND source = 'host-run-output'
    `).get(fixture.run.projectId, fixture.run.canvasId).count, 1);
    assert.equal(database.db.prepare(`
      SELECT updated_at FROM canvas_resource_grants
      WHERE project_id = ? AND canvas_id = ? AND resource_type = 'asset' AND source = 'host-run-output'
    `).get(fixture.run.projectId, fixture.run.canvasId).updated_at, grantUpdatedAt);

    const rollbackFixture = createHostFixture(database, '-rollback');
    const originalGrant = database.grantCanvasAssetResource.bind(database);
    database.grantCanvasAssetResource = (...args) => {
      originalGrant(...args);
      throw new Error('f7 grant rollback');
    };
    assert.throws(() => database.applyCommonHostArtifactBatch(rollbackFixture.batch, {
      hostIdentity: HOST_IDENTITY,
      verifiedArtifacts: [rollbackFixture.artifact],
    }), /f7 grant rollback/);
    database.grantCanvasAssetResource = originalGrant;
    assert.equal(database.getAssetByEntityUid(rollbackFixture.artifact.artifactUid, rollbackFixture.run.projectId), null);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_resource_grants
      WHERE project_id = ? AND canvas_id = ? AND source = 'host-run-output'
    `).get(rollbackFixture.run.projectId, rollbackFixture.run.canvasId).count, 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM run_output_commits WHERE project_id = ? AND canvas_id = ?
    `).get(rollbackFixture.run.projectId, rollbackFixture.run.canvasId).count, 0);
    assert.throws(() => database.grantCanvasAssetResource(
      fixture.run.projectId,
      rollbackFixture.run.canvasId,
      applied.results[0].assetId,
      'host-run-output',
    ), /同一项目/);
  } finally {
    database.close();
  }
});
