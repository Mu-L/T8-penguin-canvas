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
  PROJECT_DATABASE_WRITE_SEQUENCE_32_CONTRACT,
  PROJECT_DATABASE_WRITE_SEQUENCE_32_DIRECTORY_DURABILITY_WARNING_CODE,
  ProjectDatabaseWriteSequence32Error,
  createProjectDatabaseWriteSequenceCoordinator32,
  readProjectDatabaseWriteAcknowledgement32,
  serializeProjectDatabaseWriteAcknowledgement32,
  writeProjectDatabaseWriteAcknowledgementAtomically32,
} = require('../backend/src/services/projectDatabaseWriteSequence32');

const DATABASE_UUID = '11111111-1111-4111-8111-111111111111';
const GENERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function acknowledgement(writeSequence, updatedAt) {
  return {
    version: 3,
    databaseUuid: DATABASE_UUID,
    generation: GENERATION,
    previousGeneration: null,
    acknowledgedWriteSequence: writeSequence,
    reason: 'initialize',
    requiresSnapshot: false,
    updatedAt,
  };
}

function createDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDirectory(directory) {
  const resolved = path.resolve(directory);
  assert.equal(
    `${resolved}${path.sep}`.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`),
    true,
  );
  fs.rmSync(resolved, { recursive: true, force: true });
}

test('B2 ACK publish reports directory-unconfirmed without claiming persistence', () => {
  const directory = createDirectory('t8-schema32-ack-directory-unconfirmed-');
  const filename = path.join(directory, 'freshness.json');
  const before = acknowledgement(0, 1000);
  const after = acknowledgement(1, 1001);
  const beforeSerialized = serializeProjectDatabaseWriteAcknowledgement32(before);
  fs.writeFileSync(filename, beforeSerialized, { flag: 'wx', mode: 0o600 });
  try {
    let syncCalls = 0;
    const result = writeProjectDatabaseWriteAcknowledgementAtomically32(
      filename,
      after,
      {
        expectedSerialized: beforeSerialized,
        syncDirectory() {
          syncCalls += 1;
          return false;
        },
      },
    );

    assert.equal(syncCalls, 1);
    assert.equal(result.persisted, false);
    assert.equal(result.published, true);
    assert.equal(result.fileDurable, true);
    assert.equal(result.directoryDurable, false);
    assert.equal(result.status, 'directory-unconfirmed');
    assert.equal(result.durability, 'directory-unconfirmed');
    assert.deepEqual(result.durabilityWarning, {
      code: PROJECT_DATABASE_WRITE_SEQUENCE_32_DIRECTORY_DURABILITY_WARNING_CODE,
      reason: 'directory-fsync-unavailable',
      published: true,
      fileDurable: true,
      directoryDurable: false,
      durability: 'directory-unconfirmed',
      failStopped: false,
    });
    assert.equal(
      readProjectDatabaseWriteAcknowledgement32(filename)
        .value.acknowledgedWriteSequence,
      1,
    );
    assert.equal(
      fs.readdirSync(directory).some((entry) => entry.includes('.tmp-')),
      false,
    );
  } finally {
    cleanupDirectory(directory);
  }
});

test('B2 a thrown directory sync remains a published fail-stop persistence error', () => {
  const directory = createDirectory('t8-schema32-ack-directory-error-');
  const filename = path.join(directory, 'freshness.json');
  const before = acknowledgement(0, 1000);
  const after = acknowledgement(1, 1001);
  const beforeSerialized = serializeProjectDatabaseWriteAcknowledgement32(before);
  fs.writeFileSync(filename, beforeSerialized, { flag: 'wx', mode: 0o600 });
  try {
    assert.throws(
      () => writeProjectDatabaseWriteAcknowledgementAtomically32(filename, after, {
        expectedSerialized: beforeSerialized,
        syncDirectory() {
          throw Object.assign(new Error('controlled directory fsync failure'), { code: 'EIO' });
        },
      }),
      (error) => error instanceof ProjectDatabaseWriteSequence32Error
        && error.reason === 'acknowledgement-persist-failed'
        && error.details.phase === 'directory-fsync'
        && error.details.published === true
        && error.details.errorCode === 'EIO',
    );
    assert.equal(
      readProjectDatabaseWriteAcknowledgement32(filename)
        .value.acknowledgedWriteSequence,
      1,
    );
  } finally {
    cleanupDirectory(directory);
  }
});

test('B2 coordinator surfaces directory-unconfirmed as nonfatal durabilityWarning', () => {
  const directory = createDirectory('t8-schema32-coordinator-directory-unconfirmed-');
  const filename = path.join(directory, 'project.sqlite3');
  const acknowledgementFilename = path.join(directory, 'freshness.json');
  const database = new BetterSqlite3(filename);
  try {
    database.pragma('foreign_keys = ON');
    database.exec(`
      CREATE TABLE durability_probe (
        id INTEGER PRIMARY KEY,
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
      serializeProjectDatabaseWriteAcknowledgement32(acknowledgement(0, 1000)),
      { flag: 'wx', mode: 0o600 },
    );
    const coordinator = createProjectDatabaseWriteSequenceCoordinator32({
      database,
      acknowledgementFilename,
      now: () => 2000,
      persistenceOptions: { syncDirectory: () => false },
    });

    const first = coordinator.withWrite('b2.directory-unconfirmed.first', () => (
      database.prepare("INSERT INTO durability_probe(id, value) VALUES (1, 'first')").run().changes
    ));
    assert.equal(first.committed, true);
    assert.equal(first.value, 1);
    assert.equal(first.acknowledgement.status, 'directory-unconfirmed');
    assert.equal(first.acknowledgement.durability, 'directory-unconfirmed');
    assert.equal(first.acknowledgement.directoryDurable, false);
    assert.equal(first.persistenceWarning, null);
    assert.equal(first.durabilityWarning.code,
      PROJECT_DATABASE_WRITE_SEQUENCE_32_DIRECTORY_DURABILITY_WARNING_CODE);
    assert.equal(first.durabilityWarning.committed, true);
    assert.equal(first.durabilityWarning.failStopped, false);
    assert.equal(first.durabilityWarning.automaticReplayAllowed, false);
    assert.equal(first.durabilityWarning.writeSequence, 1);
    assert.equal(coordinator.isFailStopped(), false);

    const second = coordinator.withWrite('b2.directory-unconfirmed.second', () => (
      database.prepare("INSERT INTO durability_probe(id, value) VALUES (2, 'second')").run().changes
    ));
    assert.equal(second.primaryIdentity.writeSequence, 2);
    assert.equal(second.persistenceWarning, null);
    assert.equal(second.durabilityWarning.failStopped, false);
    assert.equal(coordinator.isFailStopped(), false);
    assert.deepEqual(
      database.prepare('SELECT id, value FROM durability_probe ORDER BY id').all(),
      [{ id: 1, value: 'first' }, { id: 2, value: 'second' }],
    );
    assert.equal(
      readProjectDatabaseWriteAcknowledgement32(acknowledgementFilename)
        .value.acknowledgedWriteSequence,
      2,
    );
    assert.equal(
      PROJECT_DATABASE_WRITE_SEQUENCE_32_CONTRACT.acknowledgementDirectoryDurabilityPolicy,
      'directory-sync-false-is-a-nonfatal-capability-warning-never-a-persisted-claim',
    );
  } finally {
    try { if (database.open) database.close(); } catch (_) {}
    cleanupDirectory(directory);
  }
});
