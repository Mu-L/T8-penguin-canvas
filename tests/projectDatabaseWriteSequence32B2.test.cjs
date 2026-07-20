'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const {
  PROJECT_DATABASE_MIGRATION_32_CREATE_SQL,
  PROJECT_DATABASE_MIGRATION_32_RUNTIME_GUARDS_SQL,
  PROJECT_DATABASE_SCHEMA_32_LINEAGE,
  PROJECT_DATABASE_SCHEMA_32_LINEAGE_DIGEST,
} = require('../backend/src/services/projectDatabaseMigration32');
const {
  PROJECT_DATABASE_WRITE_SEQUENCE_32_ADVANCE_SQL,
  PROJECT_DATABASE_WRITE_SEQUENCE_32_CONTRACT,
  PROJECT_DATABASE_WRITE_SEQUENCE_32_INTEGRATION_STATUS,
  ProjectDatabaseWriteSequence32CommittedError,
  ProjectDatabaseWriteSequence32Error,
  assertProjectDatabaseWriteTransactionContext32,
  createProjectDatabaseWriteSequenceCoordinator32,
  normalizeProjectDatabaseWriteAcknowledgement32,
  parseProjectDatabaseWriteAcknowledgement32,
  readProjectDatabaseWriteAcknowledgement32,
  serializeProjectDatabaseWriteAcknowledgement32,
} = require('../backend/src/services/projectDatabaseWriteSequence32');

const DATABASE_UUID = '11111111-1111-4111-8111-111111111111';
const GENERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function acknowledgement(overrides = {}) {
  return {
    version: 3,
    databaseUuid: DATABASE_UUID,
    generation: GENERATION,
    previousGeneration: null,
    acknowledgedWriteSequence: 0,
    reason: 'initialize',
    requiresSnapshot: false,
    updatedAt: 1000,
    ...overrides,
  };
}

function createFixture(prefix, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filename = path.join(directory, 'project.sqlite3');
  const acknowledgementFilename = path.join(directory, 'project.recovery-generation.json');
  const database = new BetterSqlite3(filename);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.exec(`
    CREATE TABLE b2_write_sequence_rows (
      id TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT;
    ${PROJECT_DATABASE_MIGRATION_32_CREATE_SQL}
    ${PROJECT_DATABASE_MIGRATION_32_RUNTIME_GUARDS_SQL}
  `);
  database.prepare(`
    INSERT INTO project_database_identity (
      singleton_id, database_uuid, recovery_generation, write_sequence,
      schema_version, schema_lineage, schema_lineage_digest, created_at, updated_at
    ) VALUES (1, ?, ?, 0, 32, ?, ?, 1000, 1000)
  `).run(
    DATABASE_UUID,
    GENERATION,
    PROJECT_DATABASE_SCHEMA_32_LINEAGE,
    PROJECT_DATABASE_SCHEMA_32_LINEAGE_DIGEST,
  );
  fs.writeFileSync(
    acknowledgementFilename,
    serializeProjectDatabaseWriteAcknowledgement32(acknowledgement()),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  const coordinator = createProjectDatabaseWriteSequenceCoordinator32({
    database,
    acknowledgementFilename,
    now: options.now ?? (() => 2000),
    acknowledgementFailureMode: options.acknowledgementFailureMode,
    persistenceOptions: {
      // Keep the normal happy-path assertions platform-independent. Dedicated
      // tests exercise the honest directory-unconfirmed branch explicitly.
      syncDirectory: () => true,
      ...(options.persistenceOptions || {}),
    },
    afterCommitBeforeAcknowledgement: options.afterCommitBeforeAcknowledgement,
  });
  return { directory, filename, acknowledgementFilename, database, coordinator };
}

function cleanup(fixture) {
  try { if (fixture.database?.open) fixture.database.close(); } catch (_) {}
  const resolved = path.resolve(fixture.directory);
  assert.equal(
    `${resolved}${path.sep}`.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`),
    true,
  );
  fs.rmSync(resolved, { recursive: true, force: true });
}

function identity(database) {
  return database.prepare(`
    SELECT database_uuid, recovery_generation, write_sequence, created_at, updated_at
    FROM project_database_identity WHERE singleton_id = 1
  `).get();
}

function rows(database) {
  return database.prepare('SELECT id, value FROM b2_write_sequence_rows ORDER BY id').all();
}

test('B2 schema32 write acknowledgement is strict canonical JSON and freezes the SQL contract', () => {
  assert.equal(PROJECT_DATABASE_WRITE_SEQUENCE_32_INTEGRATION_STATUS, 'standalone-unwired');
  assert.equal(PROJECT_DATABASE_WRITE_SEQUENCE_32_CONTRACT.externalTransactionPolicy, 'fail-close');
  assert.equal(
    PROJECT_DATABASE_WRITE_SEQUENCE_32_CONTRACT.nestedPolicy,
    'same-context-no-second-sequence-advance',
  );
  assert.match(PROJECT_DATABASE_WRITE_SEQUENCE_32_ADVANCE_SQL, /write_sequence = write_sequence \+ 1/);
  assert.match(PROJECT_DATABASE_WRITE_SEQUENCE_32_ADVANCE_SQL, /RETURNING singleton_id/);

  const normalized = normalizeProjectDatabaseWriteAcknowledgement32(acknowledgement());
  const serialized = serializeProjectDatabaseWriteAcknowledgement32(normalized);
  assert.equal(serialized.endsWith('\n'), true);
  assert.deepEqual(parseProjectDatabaseWriteAcknowledgement32(serialized), normalized);
  assert.equal(
    serialized,
    '{"acknowledgedWriteSequence":0,"databaseUuid":"11111111-1111-4111-8111-111111111111","generation":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","previousGeneration":null,"reason":"initialize","requiresSnapshot":false,"updatedAt":1000,"version":3}\n',
  );

  assert.throws(
    () => normalizeProjectDatabaseWriteAcknowledgement32({
      ...acknowledgement(),
      generation: GENERATION.toUpperCase(),
    }),
    (error) => error instanceof ProjectDatabaseWriteSequence32Error
      && error.reason === 'uuid-invalid',
  );
  assert.throws(
    () => normalizeProjectDatabaseWriteAcknowledgement32({
      ...acknowledgement(),
      acknowledgedWriteSequence: '0',
    }),
    (error) => error instanceof ProjectDatabaseWriteSequence32Error
      && error.reason === 'acknowledgement-invalid',
  );
  assert.throws(
    () => parseProjectDatabaseWriteAcknowledgement32(`${JSON.stringify(acknowledgement())}\n`),
    (error) => error instanceof ProjectDatabaseWriteSequence32Error
      && error.reason === 'acknowledgement-canonical-invalid',
  );
  assert.throws(
    () => normalizeProjectDatabaseWriteAcknowledgement32({
      ...acknowledgement(),
      unexpected: true,
    }),
    (error) => error instanceof ProjectDatabaseWriteSequence32Error
      && error.reason === 'acknowledgement-invalid',
  );
});

test('B2 outermost writer advances once, nested writers reuse the exact active context, and ACK follows commit', () => {
  const fixture = createFixture('t8-schema32-write-sequence-nested-');
  try {
    const result = fixture.coordinator.withWrite('b2.sequence.outer', (outerContext) => {
      assert.equal(outerContext.outermost, true);
      assert.equal(outerContext.depth, 1);
      assert.equal(outerContext.startingWriteSequence, 0);
      assert.equal(outerContext.writeSequence, 1);
      assert.strictEqual(fixture.coordinator.currentContext(), outerContext);
      assert.strictEqual(
        assertProjectDatabaseWriteTransactionContext32(fixture.database, outerContext),
        outerContext,
      );
      fixture.database.prepare(`
        INSERT INTO b2_write_sequence_rows(id, value) VALUES ('outer', 'same transaction')
      `).run();
      const nested = fixture.coordinator.withWrite('b2.sequence.inner', (innerContext) => {
        assert.equal(innerContext.outermost, false);
        assert.equal(innerContext.depth, 2);
        assert.equal(innerContext.outermostOperation, 'b2.sequence.outer');
        assert.equal(innerContext.startingWriteSequence, 0);
        assert.equal(innerContext.writeSequence, 1);
        assert.strictEqual(fixture.coordinator.currentContext(), innerContext);
        assertProjectDatabaseWriteTransactionContext32(fixture.database, innerContext);
        const deepest = fixture.coordinator.withWrite('b2.sequence.deepest', (deepContext) => {
          assert.equal(deepContext.depth, 3);
          assert.equal(deepContext.writeSequence, 1);
          assertProjectDatabaseWriteTransactionContext32(fixture.database, deepContext);
          return 'deep-value';
        });
        assert.equal(deepest, 'deep-value');
        fixture.database.prepare(`
          INSERT INTO b2_write_sequence_rows(id, value) VALUES ('inner', 'same transaction')
        `).run();
        return 'nested-value';
      });
      assert.equal(nested, 'nested-value');
      assert.strictEqual(fixture.coordinator.currentContext(), outerContext);
      return 'outer-value';
    });

    assert.equal(result.committed, true);
    assert.equal(result.value, 'outer-value');
    assert.equal(result.primaryIdentity.writeSequence, 1);
    assert.equal(result.acknowledgement.status, 'persisted');
    assert.equal(result.acknowledgement.durability, 'confirmed');
    assert.equal(result.acknowledgement.acknowledgedWriteSequence, 1);
    assert.equal(result.persistenceWarning, null);
    assert.equal(result.durabilityWarning, null);
    assert.equal(fixture.database.inTransaction, false);
    assert.equal(fixture.coordinator.currentContext(), null);
    assert.equal(identity(fixture.database).write_sequence, 1);
    assert.deepEqual(rows(fixture.database).map((row) => row.id), ['inner', 'outer']);
    assert.equal(
      readProjectDatabaseWriteAcknowledgement32(fixture.acknowledgementFilename)
        .value.acknowledgedWriteSequence,
      1,
    );

    const second = fixture.coordinator.withWrite('b2.sequence.second', (context) => {
      assert.equal(context.startingWriteSequence, 1);
      assert.equal(context.writeSequence, 2);
      return fixture.database.prepare(`
        INSERT INTO b2_write_sequence_rows(id, value) VALUES ('second', 'next transaction')
      `).run().changes;
    });
    assert.equal(second.value, 1);
    assert.equal(identity(fixture.database).write_sequence, 2);
    assert.equal(
      readProjectDatabaseWriteAcknowledgement32(fixture.acknowledgementFilename)
        .value.acknowledgedWriteSequence,
      2,
    );
  } finally {
    cleanup(fixture);
  }
});

test('B2 callback failure rolls business state and sequence back without changing the ACK watermark', () => {
  const fixture = createFixture('t8-schema32-write-sequence-rollback-');
  const conflict = Object.assign(new Error('controlled business conflict'), {
    code: 'controlled_business_conflict',
  });
  try {
    let caught = null;
    try {
      fixture.coordinator.withWrite('b2.sequence.rollback', () => {
        fixture.database.prepare(`
          INSERT INTO b2_write_sequence_rows(id, value) VALUES ('rolled-back', 'never durable')
        `).run();
        throw conflict;
      });
    } catch (error) {
      caught = error;
    }
    assert.strictEqual(caught, conflict);
    assert.equal(fixture.database.inTransaction, false);
    assert.equal(identity(fixture.database).write_sequence, 0);
    assert.deepEqual(rows(fixture.database), []);
    assert.equal(
      readProjectDatabaseWriteAcknowledgement32(fixture.acknowledgementFilename)
        .value.acknowledgedWriteSequence,
      0,
    );
    assert.equal(fixture.coordinator.isFailStopped(), false);
  } finally {
    cleanup(fixture);
  }
});

test('B2 async callbacks are rejected before acknowledgement and cannot leave partial writes', async () => {
  const fixture = createFixture('t8-schema32-write-sequence-async-');
  try {
    let nativeAsyncInvoked = false;
    assert.throws(
      () => fixture.coordinator.withWrite('b2.sequence.native-async', async () => {
        nativeAsyncInvoked = true;
      }),
      (error) => error?.code === 'project_database_write_callback_async',
    );
    assert.equal(nativeAsyncInvoked, false);

    let pending = null;
    assert.throws(
      () => fixture.coordinator.withWrite('b2.sequence.thenable', () => {
        fixture.database.prepare(`
          INSERT INTO b2_write_sequence_rows(id, value) VALUES ('async', 'must roll back')
        `).run();
        pending = Promise.resolve('late');
        return pending;
      }),
      (error) => error?.code === 'project_database_write_callback_async',
    );
    await pending;
    assert.deepEqual(rows(fixture.database), []);
    assert.equal(identity(fixture.database).write_sequence, 0);
    assert.equal(
      readProjectDatabaseWriteAcknowledgement32(fixture.acknowledgementFilename)
        .value.acknowledgedWriteSequence,
      0,
    );
  } finally {
    cleanup(fixture);
  }
});

test('B2 caller-owned SQLite transactions fail closed and remain owned by their caller', () => {
  const fixture = createFixture('t8-schema32-write-sequence-external-');
  try {
    fixture.database.exec(`
      BEGIN IMMEDIATE;
      INSERT INTO b2_write_sequence_rows(id, value) VALUES ('external', 'caller owned');
    `);
    let invoked = false;
    assert.throws(
      () => fixture.coordinator.withWrite('b2.sequence.external', () => {
        invoked = true;
      }),
      (error) => error instanceof ProjectDatabaseWriteSequence32Error
        && error.code === 'project_database_write_sequence_external_transaction_forbidden'
        && error.reason === 'external-transaction-forbidden'
        && error.committed === false,
    );
    assert.equal(invoked, false);
    assert.equal(fixture.database.inTransaction, true);
    assert.equal(identity(fixture.database).write_sequence, 0);
    assert.deepEqual(rows(fixture.database).map((row) => row.id), ['external']);
    fixture.database.exec('ROLLBACK');
    assert.deepEqual(rows(fixture.database), []);
  } finally {
    if (fixture.database.inTransaction) fixture.database.exec('ROLLBACK');
    cleanup(fixture);
  }
});

test('B2 pre-replace ACK failure throws a committed fail-stop without claiming rollback', () => {
  const fixture = createFixture('t8-schema32-write-sequence-fail-stop-', {
    persistenceOptions: {
      beforeReplace() {
        throw Object.assign(new Error('controlled ACK replace failure'), { code: 'EIO' });
      },
    },
  });
  try {
    assert.throws(
      () => fixture.coordinator.withWrite('b2.sequence.ack-fail-stop', () => {
        fixture.database.prepare(`
          INSERT INTO b2_write_sequence_rows(id, value) VALUES ('committed', 'database won')
        `).run();
        return 'durable-value';
      }),
      (error) => error instanceof ProjectDatabaseWriteSequence32CommittedError
        && error.code === 'project_database_write_acknowledgement_failed'
        && error.status === 503
        && error.committed === true
        && error.failStopped === true
        && error.retryable === false
        && error.automaticReplayAllowed === false
        && error.details.writeSequence === 1
        && error.details.acknowledgementPublished === false,
    );
    assert.equal(identity(fixture.database).write_sequence, 1);
    assert.deepEqual(rows(fixture.database).map((row) => row.id), ['committed']);
    assert.equal(
      readProjectDatabaseWriteAcknowledgement32(fixture.acknowledgementFilename)
        .value.acknowledgedWriteSequence,
      0,
    );
    assert.equal(fixture.coordinator.isFailStopped(), true);
    assert.throws(
      () => fixture.coordinator.withWrite('b2.sequence.must-not-replay', () => {
        throw new Error('must not run');
      }),
      (error) => error instanceof ProjectDatabaseWriteSequence32Error
        && error.reason === 'coordinator-fail-stopped'
        && error.committed === false,
    );
    assert.doesNotMatch(JSON.stringify(fixture.coordinator.failStopWarning), /[A-Z]:\\|project\.sqlite/i);
  } finally {
    cleanup(fixture);
  }
});

test('B2 post-replace durability uncertainty returns an explicit committed warning and then fail-stops', () => {
  const fixture = createFixture('t8-schema32-write-sequence-warning-', {
    acknowledgementFailureMode: 'committed-warning',
    persistenceOptions: {
      afterReplace() {
        throw Object.assign(new Error('controlled post-replace uncertainty'), { code: 'EIO' });
      },
    },
  });
  try {
    const result = fixture.coordinator.withWrite('b2.sequence.ack-warning', () => {
      fixture.database.prepare(`
        INSERT INTO b2_write_sequence_rows(id, value) VALUES ('warning', 'already committed')
      `).run();
      return 'committed-value';
    });
    assert.equal(result.committed, true);
    assert.equal(result.value, 'committed-value');
    assert.equal(result.acknowledgement.status, 'warning');
    assert.equal(result.acknowledgement.published, true);
    assert.equal(result.persistenceWarning.code, 'project_database_write_acknowledgement_failed');
    assert.equal(result.persistenceWarning.committed, true);
    assert.equal(result.persistenceWarning.failStopped, true);
    assert.equal(result.persistenceWarning.automaticReplayAllowed, false);
    assert.equal(identity(fixture.database).write_sequence, 1);
    assert.equal(
      readProjectDatabaseWriteAcknowledgement32(fixture.acknowledgementFilename)
        .value.acknowledgedWriteSequence,
      1,
    );
    assert.equal(fixture.coordinator.isFailStopped(), true);
  } finally {
    cleanup(fixture);
  }
});

test('B2 stale or raced ACK watermarks fail closed with no false sequence continuity', () => {
  const stale = createFixture('t8-schema32-write-sequence-stale-');
  try {
    fs.writeFileSync(
      stale.acknowledgementFilename,
      serializeProjectDatabaseWriteAcknowledgement32(acknowledgement({
        acknowledgedWriteSequence: 1,
        updatedAt: 1001,
      })),
    );
    let invoked = false;
    assert.throws(
      () => stale.coordinator.withWrite('b2.sequence.stale', () => {
        invoked = true;
      }),
      (error) => error instanceof ProjectDatabaseWriteSequence32Error
        && error.reason === 'acknowledged-watermark-mismatch'
        && error.committed === false,
    );
    assert.equal(invoked, false);
    assert.equal(identity(stale.database).write_sequence, 0);
  } finally {
    cleanup(stale);
  }

  let racedFixture;
  racedFixture = createFixture('t8-schema32-write-sequence-race-', {
    persistenceOptions: {
      beforeReplace() {
        fs.writeFileSync(
          racedFixture.acknowledgementFilename,
          serializeProjectDatabaseWriteAcknowledgement32(acknowledgement({ updatedAt: 1001 })),
        );
      },
    },
  });
  try {
    assert.throws(
      () => racedFixture.coordinator.withWrite('b2.sequence.raced', () => {
        racedFixture.database.prepare(`
          INSERT INTO b2_write_sequence_rows(id, value) VALUES ('raced', 'database committed')
        `).run();
      }),
      (error) => error instanceof ProjectDatabaseWriteSequence32CommittedError
        && error.committed === true
        && error.details.acknowledgementPublished === false,
    );
    assert.equal(identity(racedFixture.database).write_sequence, 1);
    assert.deepEqual(rows(racedFixture.database).map((row) => row.id), ['raced']);
    assert.equal(racedFixture.coordinator.isFailStopped(), true);
  } finally {
    cleanup(racedFixture);
  }
});
