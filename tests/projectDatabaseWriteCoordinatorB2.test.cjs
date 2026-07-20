'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');

function rowCount(database) {
  return Number(database.db.prepare('SELECT COUNT(*) AS count FROM b2_write_coordinator_rows').get().count);
}

function installRunWriterCapacityFault(database) {
  let armedOperation = null;
  let failNextMatchingWrite = false;
  const observations = [];

  database.db.function('b2_run_writer_capacity_fault', (operation) => {
    const normalizedOperation = String(operation);
    observations.push({
      operation: normalizedOperation,
      coordinatorActive: database.isProjectDatabaseWriteCoordinatorActive(),
    });
    if (failNextMatchingWrite && normalizedOperation === armedOperation) {
      failNextMatchingWrite = false;
      throw Object.assign(new Error(`controlled ${normalizedOperation} ENOSPC`), { code: 'ENOSPC' });
    }
    return 1;
  });
  database.db.exec(`
    CREATE TRIGGER b2_run_node_create_capacity
    BEFORE INSERT ON node_runs
    BEGIN
      SELECT b2_run_writer_capacity_fault('run.node-create');
    END;
    CREATE TRIGGER b2_run_node_update_capacity
    BEFORE UPDATE ON node_runs
    BEGIN
      SELECT b2_run_writer_capacity_fault('run.node-update');
    END;
    CREATE TRIGGER b2_run_attempt_create_capacity
    BEFORE INSERT ON run_attempts
    BEGIN
      SELECT b2_run_writer_capacity_fault('run.attempt-create');
    END;
    CREATE TRIGGER b2_run_attempt_update_capacity
    BEFORE UPDATE ON run_attempts
    BEGIN
      SELECT b2_run_writer_capacity_fault('run.attempt-update');
    END;
  `);

  return {
    arm(operation) {
      armedOperation = String(operation);
      failNextMatchingWrite = true;
      observations.length = 0;
    },
    observations,
  };
}

function seedRunWriterFixture(database, suffix) {
  const run = database.createRun({
    id: `b2-run-writer-run-${suffix}`,
    projectId: `b2-run-writer-project-${suffix}`,
    canvasId: `b2-run-writer-canvas-${suffix}`,
    canvasRevision: 0,
    initiatorId: 'local-owner',
    status: 'running',
  });
  const nodeRun = database.createNodeRun({
    id: `b2-run-writer-node-${suffix}`,
    runId: run.id,
    nodeId: `node-${suffix}`,
    status: 'queued',
  });
  const attempt = database.createAttempt({
    id: `b2-run-writer-attempt-${suffix}`,
    nodeRunId: nodeRun.id,
    provider: 'capacity-test',
    status: 'queued',
  });
  return { run, nodeRun, attempt };
}

function isStorageCapacityErrorForOperation(error, operation) {
  return error instanceof ProjectDatabaseStorageCapacityError
    && error.code === 'project_database_storage_capacity_exceeded'
    && error.status === 507
    && error.reason === 'filesystem-reserve'
    && error.details?.operation === operation;
}

function assertCoordinatedFaultAndRetry(fault, operation) {
  assert.deepEqual(fault.observations, [
    { operation, coordinatorActive: true },
    { operation, coordinatorActive: true },
  ]);
}

test('B2 write boundary rolls a compound write back, translates once at the outer operation, and retries', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    database.db.exec(`
      CREATE TABLE b2_write_coordinator_rows (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    let fail = true;
    const request = () => database.withProjectDatabaseWrite('coordinator.outer', () => {
      database.db.prepare(`
        INSERT INTO b2_write_coordinator_rows(id, value) VALUES ('first', 'committed together')
      `).run();
      return database.withProjectDatabaseWrite('coordinator.inner', () => {
        database.db.prepare(`
          INSERT INTO b2_write_coordinator_rows(id, value) VALUES ('second', 'committed together')
        `).run();
        if (fail) throw Object.assign(new Error('late raw full'), { code: 'SQLITE_FULL' });
        return 'done';
      });
    });

    assert.throws(request, (error) => error instanceof ProjectDatabaseStorageCapacityError
      && error.code === 'project_database_storage_capacity_exceeded'
      && error.status === 507
      && error.reason === 'sqlite-full'
      && error.details?.operation === 'coordinator.outer');
    assert.equal(database.db.inTransaction, false);
    assert.equal(rowCount(database), 0);

    fail = false;
    assert.equal(request(), 'done');
    assert.equal(rowCount(database), 2);
  } finally {
    await database.close();
  }
});

test('B2 public coordinator rejects caller-owned transactions before invoking business writes', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    database.db.exec(`
      CREATE TABLE b2_write_coordinator_rows (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      BEGIN IMMEDIATE;
      INSERT INTO b2_write_coordinator_rows(id, value)
      VALUES ('outer', 'owned by the external transaction');
    `);

    let invoked = false;
    assert.throws(
      () => database.withProjectDatabaseWrite('coordinator.external-conflict', () => {
        invoked = true;
        database.db.prepare(`
          INSERT INTO b2_write_coordinator_rows(id, value)
          VALUES ('failed-business-write', 'must never run inside the caller transaction')
        `).run();
      }),
      (error) => error?.code === 'project_database_write_sequence_external_transaction_forbidden'
        && error.reason === 'external-transaction-forbidden'
        && error.committed === false
        && error.details?.operation === 'coordinator.external-conflict',
    );
    assert.equal(invoked, false);
    assert.equal(database.db.inTransaction, true);
    assert.equal(database.isProjectDatabaseWriteCoordinatorActive(), false);
    assert.deepEqual(database.db.prepare(`
      SELECT id FROM b2_write_coordinator_rows ORDER BY id
    `).all().map((row) => row.id), ['outer']);

    database.db.exec('ROLLBACK');
    assert.equal(database.db.inTransaction, false);
    assert.equal(rowCount(database), 0);
  } finally {
    if (database.db.inTransaction) database.db.exec('ROLLBACK');
    await database.close();
  }
});

test('B2 write boundary rejects Promise callbacks before commit', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    database.db.exec(`
      CREATE TABLE b2_write_coordinator_rows (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    let nativeAsyncInvoked = false;
    assert.throws(
      () => database.withProjectDatabaseWrite('coordinator.native-async-rejected', async () => {
        nativeAsyncInvoked = true;
        database.db.prepare(`
          INSERT INTO b2_write_coordinator_rows(id, value) VALUES ('native-async', 'must never start')
        `).run();
      }),
      (error) => error instanceof TypeError
        && error.code === 'project_database_write_callback_async',
    );
    assert.equal(nativeAsyncInvoked, false);
    assert.equal(rowCount(database), 0);

    let pending = null;
    assert.throws(
      () => database.withProjectDatabaseWrite('coordinator.async-rejected', () => {
        database.db.prepare(`
          INSERT INTO b2_write_coordinator_rows(id, value) VALUES ('async', 'must roll back')
        `).run();
        pending = Promise.resolve('too late');
        return pending;
      }),
      (error) => error instanceof TypeError
        && error.code === 'project_database_write_callback_async',
    );
    await pending;
    assert.equal(database.db.inTransaction, false);
    assert.equal(rowCount(database), 0);
  } finally {
    await database.close();
  }
});

test('B2 read snapshots reject async callbacks and cannot upgrade an uncoordinated DEFERRED transaction to write', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    database.db.exec(`
      CREATE TABLE b2_write_coordinator_rows (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    assert.equal(database.isProjectDatabaseWriteCoordinatorActive(), false);
    const count = database.withProjectDatabaseReadSnapshot('coordinator.read-only', () => {
      assert.equal(database.db.inTransaction, true);
      assert.equal(database.isProjectDatabaseWriteCoordinatorActive(), false);
      assert.throws(
        () => database.withProjectDatabaseWrite('coordinator.illegal-upgrade', () => {
          database.db.prepare(`
            INSERT INTO b2_write_coordinator_rows(id, value) VALUES ('illegal', 'must never commit')
          `).run();
        }),
        (error) => error?.code === 'project_database_read_snapshot_write_forbidden'
          && error?.operation === 'coordinator.illegal-upgrade',
      );
      return rowCount(database);
    });
    assert.equal(count, 0);
    assert.equal(database.db.inTransaction, false);

    let asyncInvoked = false;
    assert.throws(
      () => database.withProjectDatabaseReadSnapshot('coordinator.async-read', async () => {
        asyncInvoked = true;
      }),
      (error) => error?.code === 'project_database_read_callback_async',
    );
    assert.equal(asyncInvoked, false);

    database.withProjectDatabaseWrite('coordinator.outer-write', () => (
      database.withProjectDatabaseReadSnapshot('coordinator.nested-read', () => {
        assert.equal(database.isProjectDatabaseWriteCoordinatorActive(), true);
        return database.withProjectDatabaseWrite('coordinator.nested-write', () => (
          database.db.prepare(`
            INSERT INTO b2_write_coordinator_rows(id, value) VALUES ('nested', 'same outer write')
          `).run().changes
        ));
      })
    ));
    assert.equal(rowCount(database), 1);
  } finally {
    await database.close();
  }
});

test('B2 write boundary preserves unrelated business errors by identity', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const conflict = Object.assign(new Error('business conflict'), {
    code: 'business_conflict',
    status: 409,
  });
  try {
    let caught = null;
    try {
      database.withProjectDatabaseWrite('coordinator.business', () => {
        throw conflict;
      });
    } catch (error) {
      caught = error;
    }
    assert.strictEqual(caught, conflict);
    assert.equal(database.db.inTransaction, false);
  } finally {
    await database.close();
  }
});

test('B2 standalone audit append uses the outer write boundary for capacity rollback and retry', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const projectId = 'project-coordinator-audit';
  let fail = true;
  try {
    database.db.function('b2_coordinator_audit_capacity', () => {
      if (!fail) return 1;
      throw Object.assign(new Error('controlled audit ENOSPC'), { code: 'ENOSPC' });
    });
    database.db.exec(`
      CREATE TRIGGER b2_coordinator_audit_capacity_trigger
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'coordinator.capacity'
      BEGIN
        SELECT b2_coordinator_audit_capacity();
      END;
    `);
    const input = {
      projectId,
      action: 'coordinator.capacity',
      targetType: 'test',
      targetId: 'audit-capacity',
    };

    assert.throws(
      () => database.appendAuditEvent(input),
      (error) => error instanceof ProjectDatabaseStorageCapacityError
        && error.reason === 'filesystem-reserve'
        && error.details?.operation === 'audit.append',
    );
    assert.equal(database.listAuditEvents({ projectId, action: input.action }).length, 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM project_durable_ledger_usage WHERE project_id = ?
    `).get(projectId).count, 0);

    fail = false;
    const appended = database.appendAuditEvent(input);
    assert.ok(appended.id > 0);
    assert.equal(database.listAuditEvents({ projectId, action: input.action }).length, 1);
  } finally {
    await database.close();
  }
});

test('B2 standalone NodeRun and Attempt writers coordinate ENOSPC rollback with exact operations and single-write retry', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const fixture = seedRunWriterFixture(database, 'standalone');
    const fault = installRunWriterCapacityFault(database);

    const nodeCreateInput = {
      id: 'b2-run-writer-node-created',
      runId: fixture.run.id,
      nodeId: 'created-node',
      status: 'queued',
    };
    const createNodeRun = () => database.createNodeRun(nodeCreateInput);
    fault.arm('run.node-create');
    assert.throws(
      createNodeRun,
      (error) => isStorageCapacityErrorForOperation(error, 'run.node-create'),
    );
    assert.equal(database.db.inTransaction, false);
    assert.equal(database.getNodeRun(nodeCreateInput.id), null);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM node_runs WHERE id = ?').get(nodeCreateInput.id).count, 0);
    const createdNodeRun = createNodeRun();
    assert.equal(createdNodeRun.revision, 1);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM node_runs WHERE id = ?').get(nodeCreateInput.id).count, 1);
    assertCoordinatedFaultAndRetry(fault, 'run.node-create');

    const updateNodeRun = () => database.updateNodeRun(fixture.nodeRun.id, { status: 'running' });
    fault.arm('run.node-update');
    assert.throws(
      updateNodeRun,
      (error) => isStorageCapacityErrorForOperation(error, 'run.node-update'),
    );
    assert.equal(database.db.inTransaction, false);
    assert.equal(database.getNodeRun(fixture.nodeRun.id).status, 'queued');
    assert.equal(database.getNodeRun(fixture.nodeRun.id).revision, 1);
    const updatedNodeRun = updateNodeRun();
    assert.equal(updatedNodeRun.status, 'running');
    assert.equal(updatedNodeRun.revision, 2);
    assertCoordinatedFaultAndRetry(fault, 'run.node-update');

    const attemptCreateInput = {
      id: 'b2-run-writer-attempt-created',
      nodeRunId: fixture.nodeRun.id,
      provider: 'capacity-test',
      status: 'queued',
    };
    const createAttempt = () => database.createAttempt(attemptCreateInput);
    fault.arm('run.attempt-create');
    assert.throws(
      createAttempt,
      (error) => isStorageCapacityErrorForOperation(error, 'run.attempt-create'),
    );
    assert.equal(database.db.inTransaction, false);
    assert.equal(database.getAttempt(attemptCreateInput.id), null);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM run_attempts WHERE id = ?').get(attemptCreateInput.id).count, 0);
    const createdAttempt = createAttempt();
    assert.equal(createdAttempt.revision, 1);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM run_attempts WHERE id = ?').get(attemptCreateInput.id).count, 1);
    assertCoordinatedFaultAndRetry(fault, 'run.attempt-create');

    const updateAttempt = () => database.updateAttempt(fixture.attempt.id, {
      status: 'polling',
      pollCount: 1,
      metadata: { capacityRetry: true },
    }, {
      runId: fixture.run.id,
      nodeRunId: fixture.nodeRun.id,
    });
    fault.arm('run.attempt-update');
    assert.throws(
      updateAttempt,
      (error) => isStorageCapacityErrorForOperation(error, 'run.attempt-update'),
    );
    assert.equal(database.db.inTransaction, false);
    assert.equal(database.getAttempt(fixture.attempt.id).status, 'queued');
    assert.equal(database.getAttempt(fixture.attempt.id).pollCount, 0);
    assert.equal(database.getAttempt(fixture.attempt.id).revision, 1);
    const updatedAttempt = updateAttempt();
    assert.equal(updatedAttempt.status, 'polling');
    assert.equal(updatedAttempt.pollCount, 1);
    assert.deepEqual(updatedAttempt.metadata, { capacityRetry: true });
    assert.equal(updatedAttempt.revision, 2);
    assertCoordinatedFaultAndRetry(fault, 'run.attempt-update');
  } finally {
    await database.close();
  }
});

test('B2 nested Run writer leaves capacity translation to the outer operation', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const fixture = seedRunWriterFixture(database, 'nested');
    const fault = installRunWriterCapacityFault(database);
    const updateInOuterBoundary = () => database.withProjectDatabaseWrite('run.writer.atomic-batch', () => (
      database.updateNodeRun(fixture.nodeRun.id, { status: 'running' })
    ));

    fault.arm('run.node-update');
    assert.throws(
      updateInOuterBoundary,
      (error) => isStorageCapacityErrorForOperation(error, 'run.writer.atomic-batch'),
    );
    assert.equal(database.db.inTransaction, false);
    assert.equal(database.getNodeRun(fixture.nodeRun.id).status, 'queued');
    assert.equal(database.getNodeRun(fixture.nodeRun.id).revision, 1);

    const updatedNodeRun = updateInOuterBoundary();
    assert.equal(updatedNodeRun.status, 'running');
    assert.equal(updatedNodeRun.revision, 2);
    assertCoordinatedFaultAndRetry(fault, 'run.node-update');
  } finally {
    await database.close();
  }
});
