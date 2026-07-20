'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const {
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
  ProjectDatabaseRecoveryGenerationUnavailableError,
} = require('../backend/src/services/projectDatabase');
const {
  PROJECT_DATABASE_MIGRATION_32_CREATE_SQL,
  PROJECT_DATABASE_MIGRATION_32_RUNTIME_GUARDS_SQL,
  PROJECT_DATABASE_SCHEMA_32_CANONICAL_JSON,
  PROJECT_DATABASE_SCHEMA_32_LINEAGE,
  PROJECT_DATABASE_SCHEMA_32_LINEAGE_DIGEST,
} = require('../backend/src/services/projectDatabaseMigration32');
const {
  classifyProjectDatabasePrimaryAgainstFreshnessFence32,
  createProjectDatabaseFreshnessFence32,
  rotateProjectDatabaseFreshnessFenceAfterRecovery32,
} = require('../backend/src/services/projectDatabaseFreshnessFence32');
const {
  ProjectDatabaseWriteSequence32Error,
  readProjectDatabaseWriteAcknowledgement32,
  serializeProjectDatabaseWriteAcknowledgement32,
  writeProjectDatabaseWriteAcknowledgementAtomically32,
} = require('../backend/src/services/projectDatabaseWriteSequence32');

const DATABASE_UUID = '11111111-1111-4111-8111-111111111111';
const INITIAL_GENERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEXT_GENERATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TRANSITION_ACTION = 'project-database.recovery-generation-transition.v1';
const TRANSITION_FORMAT = 't8-project-database-recovery-generation-transition-v1';

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.equal(
    `${resolved}${path.sep}`.startsWith(temporaryRoot),
    true,
    `refusing to remove non-temporary directory: ${resolved}`,
  );
  fs.rmSync(resolved, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function initialAcknowledgement() {
  return createProjectDatabaseFreshnessFence32({
    databaseUuid: DATABASE_UUID,
    generation: INITIAL_GENERATION,
    previousGeneration: null,
    acknowledgedWriteSequence: 0,
    reason: 'initialize',
    requiresSnapshot: false,
    updatedAt: 1000,
  });
}

function createProtocolFixture(prefix) {
  const directory = temporaryDirectory(prefix);
  const filename = path.join(directory, 'project.sqlite3');
  const acknowledgementFilename = path.join(
    directory,
    'project.sqlite3.recovery-generation.json',
  );
  const database = new BetterSqlite3(filename);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.exec(`
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mutation_uid TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      canvas_id TEXT,
      actor_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      metadata_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    ${PROJECT_DATABASE_MIGRATION_32_CREATE_SQL}
    ${PROJECT_DATABASE_MIGRATION_32_RUNTIME_GUARDS_SQL}
  `);
  database.prepare(`
    INSERT INTO project_database_identity (
      singleton_id, database_uuid, recovery_generation, write_sequence,
      schema_version, schema_lineage, schema_lineage_digest,
      created_at, updated_at
    ) VALUES (1, ?, ?, 0, 32, ?, ?, 1000, 1000)
  `).run(
    DATABASE_UUID,
    INITIAL_GENERATION,
    PROJECT_DATABASE_SCHEMA_32_LINEAGE,
    PROJECT_DATABASE_SCHEMA_32_LINEAGE_DIGEST,
  );
  fs.writeFileSync(
    acknowledgementFilename,
    serializeProjectDatabaseWriteAcknowledgement32(initialAcknowledgement()),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  return { directory, filename, acknowledgementFilename, database };
}

function closeAndCleanup(fixture) {
  try { if (fixture.database?.open) fixture.database.close(); } catch (_) {}
  cleanupTemporaryDirectory(fixture.directory);
}

function readPrimaryIdentity(database) {
  const row = database.prepare(`
    SELECT database_uuid, recovery_generation, write_sequence, updated_at
    FROM project_database_identity
    WHERE singleton_id = 1
  `).get();
  return Object.freeze({
    databaseUuid: row.database_uuid,
    recoveryGeneration: row.recovery_generation,
    writeSequence: Number(row.write_sequence),
    updatedAt: Number(row.updated_at),
  });
}

function readTransitionRows(database, generation) {
  return database.prepare(`
    SELECT mutation_uid, project_id, canvas_id, actor_id, session_id,
           action, target_type, target_id, metadata_json, created_at
    FROM audit_events
    WHERE action = ? AND target_id = ?
    ORDER BY id DESC
    LIMIT 2
  `).all(TRANSITION_ACTION, generation);
}

function exactTransition(input) {
  const value = {
    format: TRANSITION_FORMAT,
    transitionId: input.transitionId,
    kind: 'live-rotation',
    databaseUuid: DATABASE_UUID,
    previousGeneration: INITIAL_GENERATION,
    generation: NEXT_GENERATION,
    previousWriteSequence: 0,
    writeSequence: 1,
    previousAcknowledgementDigest: input.previousAcknowledgementDigest,
    reason: 'b2-transition-test',
    requiresSnapshot: true,
    sourceReceiptEvidenceDigest: null,
    createdAt: 2000,
  };
  return Object.freeze(value);
}

function commitLiveRotation(fixture, options = {}) {
  const observation = readProjectDatabaseWriteAcknowledgement32(
    fixture.acknowledgementFilename,
  );
  const previousDigest = sha256(observation.serialized);
  const transition = exactTransition({
    transitionId: options.transitionId || '22222222-2222-4222-8222-222222222222',
    previousAcknowledgementDigest: previousDigest,
  });
  const nextAcknowledgement = rotateProjectDatabaseFreshnessFenceAfterRecovery32(
    observation.value,
    createProjectDatabaseFreshnessFence32({
      databaseUuid: transition.databaseUuid,
      generation: transition.generation,
      previousGeneration: transition.previousGeneration,
      acknowledgedWriteSequence: transition.writeSequence,
      reason: transition.reason,
      requiresSnapshot: transition.requiresSnapshot,
      updatedAt: transition.createdAt,
    }),
    {
      databaseUuid: transition.databaseUuid,
      recoveryGeneration: transition.generation,
      writeSequence: transition.writeSequence,
    },
  );
  const rotate = fixture.database.transaction(() => {
    const updated = fixture.database.prepare(`
      UPDATE project_database_identity
      SET recovery_generation = ?,
          write_sequence = write_sequence + 1,
          updated_at = ?
      WHERE singleton_id = 1
        AND database_uuid = ?
        AND recovery_generation = ?
        AND write_sequence = ?
        AND updated_at = ?
    `).run(
      transition.generation,
      transition.createdAt,
      transition.databaseUuid,
      transition.previousGeneration,
      transition.previousWriteSequence,
      1000,
    );
    assert.equal(updated.changes, 1);
    fixture.database.prepare(`
      INSERT INTO audit_events(
        mutation_uid, project_id, canvas_id, actor_id, session_id,
        action, target_type, target_id, metadata_json, created_at
      ) VALUES (?, 'project-local', NULL, 'project-database',
                'schema32-lifecycle', ?,
                'project-database-recovery-generation', ?, ?, ?)
    `).run(
      transition.transitionId,
      TRANSITION_ACTION,
      transition.generation,
      PROJECT_DATABASE_SCHEMA_32_CANONICAL_JSON(transition),
      transition.createdAt,
    );
  });
  rotate.immediate();

  options.afterCommitBeforeAcknowledgement?.(Object.freeze({
    transition,
    nextAcknowledgement,
  }));
  writeProjectDatabaseWriteAcknowledgementAtomically32(
    fixture.acknowledgementFilename,
    nextAcknowledgement,
    { expectedSerialized: observation.serialized },
  );
  return Object.freeze({ transition, nextAcknowledgement });
}

function repairExactPendingTransition(fixture) {
  const observation = readProjectDatabaseWriteAcknowledgement32(
    fixture.acknowledgementFilename,
  );
  const primary = readPrimaryIdentity(fixture.database);
  const startingClassification = classifyProjectDatabasePrimaryAgainstFreshnessFence32(
    {
      databaseUuid: primary.databaseUuid,
      recoveryGeneration: primary.recoveryGeneration,
      writeSequence: primary.writeSequence,
    },
    observation.value,
  );
  assert.equal(startingClassification.databasePrimaryAuthoritative, false);

  const rows = readTransitionRows(fixture.database, primary.recoveryGeneration);
  assert.equal(rows.length, 1);
  const row = rows[0];
  const transition = JSON.parse(row.metadata_json);
  assert.deepEqual(Object.keys(transition).sort(), [
    'createdAt',
    'databaseUuid',
    'format',
    'generation',
    'kind',
    'previousAcknowledgementDigest',
    'previousGeneration',
    'previousWriteSequence',
    'reason',
    'requiresSnapshot',
    'sourceReceiptEvidenceDigest',
    'transitionId',
    'writeSequence',
  ]);
  assert.equal(row.mutation_uid, transition.transitionId);
  assert.equal(row.project_id, 'project-local');
  assert.equal(row.canvas_id, null);
  assert.equal(row.actor_id, 'project-database');
  assert.equal(row.session_id, 'schema32-lifecycle');
  assert.equal(row.action, TRANSITION_ACTION);
  assert.equal(row.target_type, 'project-database-recovery-generation');
  assert.equal(row.target_id, transition.generation);
  assert.equal(Number(row.created_at), transition.createdAt);
  assert.equal(
    row.metadata_json,
    PROJECT_DATABASE_SCHEMA_32_CANONICAL_JSON(transition),
  );
  assert.equal(transition.format, TRANSITION_FORMAT);
  assert.equal(transition.kind, 'live-rotation');
  assert.equal(transition.databaseUuid, primary.databaseUuid);
  assert.equal(transition.previousGeneration, observation.value.generation);
  assert.equal(transition.generation, primary.recoveryGeneration);
  assert.equal(
    transition.previousWriteSequence,
    observation.value.acknowledgedWriteSequence,
  );
  assert.equal(transition.writeSequence, primary.writeSequence);
  assert.equal(
    transition.previousAcknowledgementDigest,
    sha256(observation.serialized),
  );
  assert.equal(transition.writeSequence, transition.previousWriteSequence + 1);
  assert.equal(transition.requiresSnapshot, true);
  assert.equal(transition.sourceReceiptEvidenceDigest, null);
  assert.equal(transition.createdAt, primary.updatedAt);

  const repaired = rotateProjectDatabaseFreshnessFenceAfterRecovery32(
    observation.value,
    createProjectDatabaseFreshnessFence32({
      databaseUuid: transition.databaseUuid,
      generation: transition.generation,
      previousGeneration: transition.previousGeneration,
      acknowledgedWriteSequence: transition.writeSequence,
      reason: transition.reason,
      requiresSnapshot: transition.requiresSnapshot,
      updatedAt: transition.createdAt,
    }),
    {
      databaseUuid: primary.databaseUuid,
      recoveryGeneration: primary.recoveryGeneration,
      writeSequence: primary.writeSequence,
    },
  );
  writeProjectDatabaseWriteAcknowledgementAtomically32(
    fixture.acknowledgementFilename,
    repaired,
    { expectedSerialized: observation.serialized },
  );
  return repaired;
}

function assertProductionSourceTransitionContract() {
  const rotateSource = ProjectDatabase.prototype.rotateRecoveryGeneration.toString();
  const bootstrapSource = ProjectDatabase.prototype.bootstrapRecoveryGeneration.toString();

  assert.match(rotateSource, /UPDATE project_database_identity/);
  assert.match(rotateSource, /write_sequence = write_sequence \+ 1/);
  assert.match(rotateSource, /INSERT INTO audit_events/);
  assert.match(rotateSource, /normalizeProjectDatabaseRecoveryTransition32/);
  assert.match(rotateSource, /previousAcknowledgementDigest: acknowledgementDigest/);
  assert.match(rotateSource, /sourceReceiptEvidenceDigest: null/);
  assert.match(rotateSource, /rotateIdentity\.immediate\(\)/);
  assert.match(
    rotateSource,
    /afterProjectDatabaseRecoveryRotationCommitBeforeAcknowledgement32/,
  );
  assert.match(rotateSource, /writeProjectDatabaseWriteAcknowledgementAtomically32/);
  assert.ok(
    rotateSource.indexOf('INSERT INTO audit_events')
      < rotateSource.indexOf('rotateIdentity.immediate()'),
  );
  assert.ok(
    rotateSource.indexOf('rotateIdentity.immediate()')
      < rotateSource.indexOf('writeProjectDatabaseWriteAcknowledgementAtomically32'),
  );

  assert.match(bootstrapSource, /FROM audit_events/);
  assert.match(bootstrapSource, /LIMIT 2/);
  assert.match(bootstrapSource, /transitionRows\.length === 1/);
  assert.match(bootstrapSource, /normalizeProjectDatabaseRecoveryTransition32/);
  assert.match(
    bootstrapSource,
    /transition\.previousAcknowledgementDigest === observed\.digest/,
  );
  assert.match(bootstrapSource, /String\(row\.metadata_json\) === stableJson\(transition\)/);
  assert.match(bootstrapSource, /writeProjectDatabaseWriteAcknowledgementAtomically32/);
  assert.match(bootstrapSource, /expectedSerialized: observed\.raw/);
  assert.match(bootstrapSource, /schema32-transition-ack-repair-failed/);
  assert.match(bootstrapSource, /schema32-legacy-sidecar-unproven/);
  assert.match(bootstrapSource, /schema32-freshness-fence-unproven/);
  assert.match(bootstrapSource, /this\.filename === ':memory:'/);
}

test('B2 production schema32 transition source contract is DB-first, audit-bound, ACK-second, and exact on restart', () => {
  assertProductionSourceTransitionContract();
});

test('B2 executable live-rotation protocol advances generation and write sequence exactly once before publishing ACK', () => {
  const fixture = createProtocolFixture('t8-b2-schema32-transition-happy-');
  try {
    const result = commitLiveRotation(fixture);
    const primary = readPrimaryIdentity(fixture.database);
    const acknowledgement = readProjectDatabaseWriteAcknowledgement32(
      fixture.acknowledgementFilename,
    ).value;
    assert.deepEqual(primary, {
      databaseUuid: DATABASE_UUID,
      recoveryGeneration: NEXT_GENERATION,
      writeSequence: 1,
      updatedAt: 2000,
    });
    assert.deepEqual(acknowledgement, result.nextAcknowledgement);
    assert.equal(acknowledgement.previousGeneration, INITIAL_GENERATION);
    assert.equal(acknowledgement.requiresSnapshot, true);
    const rows = readTransitionRows(fixture.database, NEXT_GENERATION);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mutation_uid, result.transition.transitionId);
    assert.equal(rows[0].metadata_json, PROJECT_DATABASE_SCHEMA_32_CANONICAL_JSON(
      result.transition,
    ));
  } finally {
    closeAndCleanup(fixture);
  }
});

test('B2 DB-commit to ACK failure leaves the old watermark, and a cold-open protocol repairs only the exact durable audit transition', () => {
  const fixture = createProtocolFixture('t8-b2-schema32-transition-crash-');
  try {
    assert.throws(
      () => commitLiveRotation(fixture, {
        afterCommitBeforeAcknowledgement() {
          throw Object.assign(new Error('controlled crash window'), { code: 'EIO' });
        },
      }),
      /controlled crash window/,
    );
    assert.equal(readPrimaryIdentity(fixture.database).recoveryGeneration, NEXT_GENERATION);
    assert.equal(readPrimaryIdentity(fixture.database).writeSequence, 1);
    assert.equal(
      readProjectDatabaseWriteAcknowledgement32(fixture.acknowledgementFilename)
        .value.generation,
      INITIAL_GENERATION,
    );
    assert.equal(
      readProjectDatabaseWriteAcknowledgement32(fixture.acknowledgementFilename)
        .value.acknowledgedWriteSequence,
      0,
    );

    fixture.database.close();
    fixture.database = new BetterSqlite3(fixture.filename);
    const repaired = repairExactPendingTransition(fixture);
    const durable = readProjectDatabaseWriteAcknowledgement32(
      fixture.acknowledgementFilename,
    ).value;
    assert.deepEqual(durable, repaired);
    assert.equal(durable.generation, NEXT_GENERATION);
    assert.equal(durable.previousGeneration, INITIAL_GENERATION);
    assert.equal(durable.acknowledgedWriteSequence, 1);
    assert.equal(readTransitionRows(fixture.database, NEXT_GENERATION).length, 1);
  } finally {
    closeAndCleanup(fixture);
  }
});

test('B2 strict v3 ACK reader rejects missing and legacy disk sidecars while production bootstrap freezes both fail-close phases', () => {
  assertProductionSourceTransitionContract();
  const directory = temporaryDirectory('t8-b2-schema32-transition-ack-reject-');
  const missing = path.join(directory, 'missing.json');
  const legacy = path.join(directory, 'legacy.json');
  try {
    assert.throws(
      () => readProjectDatabaseWriteAcknowledgement32(missing),
      (error) => error instanceof ProjectDatabaseWriteSequence32Error
        && error.reason === 'acknowledgement-read-failed',
    );
    fs.writeFileSync(legacy, `${JSON.stringify({
      version: 2,
      generation: INITIAL_GENERATION,
      previousGeneration: null,
      reason: 'initialize',
      requiresSnapshot: false,
      updatedAt: 1000,
    })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    assert.throws(
      () => readProjectDatabaseWriteAcknowledgement32(legacy),
      (error) => error instanceof ProjectDatabaseWriteSequence32Error
        && error.reason === 'acknowledgement-invalid',
    );
  } finally {
    cleanupTemporaryDirectory(directory);
  }
});

test('B2 wired schema32 lifecycle uses the real ProjectDatabase rotation and cold-open audit repair', {
  skip: PROJECT_DATABASE_SCHEMA_VERSION === 32
    ? false
    : 'production schema remains 31; standalone protocol and source contract above stay active',
  timeout: 180_000,
}, async () => {
  const directory = temporaryDirectory('t8-b2-schema32-transition-wired-');
  const filename = path.join(directory, 'project.sqlite3');
  const acknowledgementFilename = `${filename}.recovery-generation.json`;
  let database = null;
  try {
    database = new ProjectDatabase(filename, {
      autoBackup: false,
      afterProjectDatabaseRecoveryRotationCommitBeforeAcknowledgement32() {
        throw Object.assign(new Error('controlled production crash window'), { code: 'EIO' });
      },
    });
    const previousGeneration = database.getRecoveryGeneration();
    const previousAcknowledgement = readProjectDatabaseWriteAcknowledgement32(
      acknowledgementFilename,
    ).value;
    assert.throws(
      () => database.rotateRecoveryGeneration('b2-wired-transition'),
      (error) => error instanceof ProjectDatabaseRecoveryGenerationUnavailableError
        && error.details?.committed === true,
    );
    const committedIdentity = readPrimaryIdentity(database.db);
    assert.notEqual(committedIdentity.recoveryGeneration, previousGeneration);
    assert.equal(
      committedIdentity.writeSequence,
      previousAcknowledgement.acknowledgedWriteSequence + 1,
    );
    assert.equal(
      readProjectDatabaseWriteAcknowledgement32(acknowledgementFilename).value.generation,
      previousGeneration,
    );
    await database.close();
    database = null;

    database = new ProjectDatabase(filename, { autoBackup: false });
    const repaired = readProjectDatabaseWriteAcknowledgement32(
      acknowledgementFilename,
    ).value;
    const reopenedIdentity = readPrimaryIdentity(database.db);
    assert.equal(database.getRecoveryGeneration(), committedIdentity.recoveryGeneration);
    assert.equal(repaired.generation, committedIdentity.recoveryGeneration);
    assert.equal(repaired.previousGeneration, previousGeneration);
    assert.equal(reopenedIdentity.recoveryGeneration, committedIdentity.recoveryGeneration);
    assert.equal(reopenedIdentity.writeSequence, committedIdentity.writeSequence);
    assert.equal(repaired.acknowledgedWriteSequence, reopenedIdentity.writeSequence);
    assert.equal(
      readTransitionRows(database.db, committedIdentity.recoveryGeneration).length,
      1,
    );
  } finally {
    try { if (database) await database.close(); } catch (_) {}
    cleanupTemporaryDirectory(directory);
  }
});
