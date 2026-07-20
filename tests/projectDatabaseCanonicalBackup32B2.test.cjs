const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const {
  ProjectDatabaseCanonicalBackup32Error,
  sealProjectDatabaseCanonicalBackup32,
  verifyProjectDatabaseCanonicalBackup32,
} = require('../backend/src/services/projectDatabaseCanonicalBackup32');
const {
  PROJECT_DATABASE_MIGRATION_32,
  PROJECT_DATABASE_MIGRATION_32_CREATE_SQL,
  PROJECT_DATABASE_MIGRATION_32_RUNTIME_GUARDS_SQL,
  PROJECT_DATABASE_SCHEMA_32_ACCEPTED_SCHEMA_31_FINGERPRINTS,
  PROJECT_DATABASE_SCHEMA_32_CANONICAL_SHA256,
  PROJECT_DATABASE_SCHEMA_32_LINEAGE,
  PROJECT_DATABASE_SCHEMA_32_LINEAGE_DIGEST,
} = require('../backend/src/services/projectDatabaseMigration32');

const DATABASE_UUID = '11111111-1111-4111-8111-111111111111';
const RECOVERY_GENERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECEIPT_UUID_0 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RECEIPT_UUID_1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SOURCE_FINGERPRINT = PROJECT_DATABASE_SCHEMA_32_ACCEPTED_SCHEMA_31_FINGERPRINTS[0];
const TARGET_FINGERPRINT = 'd'.repeat(64);

function temporaryFixture(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filename = path.join(directory, 'candidate.sqlite3');
  const database = new BetterSqlite3(filename);
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE schema_migration_receipts (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      from_fingerprint TEXT NOT NULL,
      to_fingerprint TEXT NOT NULL,
      down_policy TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE project_documents (
      id INTEGER PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT;
    ${PROJECT_DATABASE_MIGRATION_32_CREATE_SQL}
    ${PROJECT_DATABASE_MIGRATION_32_RUNTIME_GUARDS_SQL}
  `);
  database.prepare(`
    INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)
  `).run(PROJECT_DATABASE_MIGRATION_32.version, 1500);
  database.prepare(`
    INSERT INTO schema_migration_receipts(
      version, name, checksum, from_fingerprint, to_fingerprint, down_policy, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    PROJECT_DATABASE_MIGRATION_32.version,
    PROJECT_DATABASE_MIGRATION_32.name,
    PROJECT_DATABASE_MIGRATION_32.checksum,
    SOURCE_FINGERPRINT,
    TARGET_FINGERPRINT,
    PROJECT_DATABASE_MIGRATION_32.downPolicy,
    1500,
  );
  database.prepare(`
    INSERT INTO project_database_storage_policy (
      singleton_id, policy_revision, active_storage_budget_bytes,
      main_max_bytes, wal_checkpoint_target_bytes,
      maximum_single_transaction_wal_bytes, wal_pressure_bytes,
      wal_reserve_bytes, wal_residual_limit_bytes, shm_reserve_bytes,
      hot_journal_reserve_bytes, sqlite_temp_reserve_bytes,
      minimum_filesystem_free_bytes, backup_candidate_reserve_bytes,
      recovery_evidence_reserve_bytes, synchronous_mode, updated_at
    ) VALUES (
      1, 1, 1520, 1000, 100, 50, 200, 300, 80, 40, 50, 60, 70, 1170, 100,
      'FULL', 1000
    )
  `).run();
  database.prepare(`
    INSERT INTO project_database_identity (
      singleton_id, database_uuid, recovery_generation, write_sequence,
      schema_version, schema_lineage, schema_lineage_digest, created_at, updated_at
    ) VALUES (1, ?, ?, 0, ?, ?, ?, 1000, 1000)
  `).run(
    DATABASE_UUID,
    RECOVERY_GENERATION,
    PROJECT_DATABASE_MIGRATION_32.version,
    PROJECT_DATABASE_SCHEMA_32_LINEAGE,
    PROJECT_DATABASE_SCHEMA_32_LINEAGE_DIGEST,
  );
  database.prepare('INSERT INTO project_documents(id, value) VALUES (1, ?)').run('initial');
  return { directory, filename, database };
}

function cleanup(directory) {
  const resolved = path.resolve(directory);
  assert.equal(
    `${resolved}${path.sep}`.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`),
    true,
  );
  fs.rmSync(resolved, { recursive: true, force: true });
}

function sealOptions(overrides = {}) {
  return {
    targetSchemaFingerprint: TARGET_FINGERPRINT,
    inspectSchemaFingerprint(database) {
      assert.equal(database.inTransaction, true);
      return TARGET_FINGERPRINT;
    },
    now: () => 2000,
    createReceiptUuid: () => RECEIPT_UUID_0,
    ...overrides,
  };
}

function canonicalError(reason) {
  return (error) => error instanceof ProjectDatabaseCanonicalBackup32Error
    && error.code === 'project_database_canonical_backup_32_invalid'
    && error.reason === reason;
}

function openVerifier(filename, queryOnly = true) {
  const database = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
  database.pragma('foreign_keys = ON');
  if (queryOnly) database.pragma('query_only = ON');
  return database;
}

test('B2 schema32 canonical candidate seals once and verifies every digest read-only', () => {
  const fixture = temporaryFixture('t8-schema32-canonical-first-');
  let verifier = null;
  try {
    const sealed = sealProjectDatabaseCanonicalBackup32(fixture.database, sealOptions());
    assert.equal(sealed.sealed, true);
    assert.equal(sealed.reused, false);
    assert.equal(sealed.receiptUuid, RECEIPT_UUID_0);
    assert.equal(sealed.capturedWriteSequence, 0);
    assert.equal(fixture.database.inTransaction, false);
    assert.equal(fixture.database.prepare(`
      SELECT COUNT(*) AS count FROM project_database_backup_receipts
    `).get().count, 1);
    const stored = fixture.database.prepare(`
      SELECT * FROM project_database_backup_receipts WHERE receipt_uuid = ?
    `).get(RECEIPT_UUID_0);
    assert.equal(stored.migration_receipt_digest, PROJECT_DATABASE_SCHEMA_32_CANONICAL_SHA256({
      schemaVersion: PROJECT_DATABASE_MIGRATION_32.version,
      migrationName: PROJECT_DATABASE_MIGRATION_32.name,
      migrationChecksum: PROJECT_DATABASE_MIGRATION_32.checksum,
      fromSchemaFingerprint: SOURCE_FINGERPRINT,
      schemaFingerprint: TARGET_FINGERPRINT,
      downPolicy: PROJECT_DATABASE_MIGRATION_32.downPolicy,
      appliedAt: 1500,
    }));
    assert.equal(stored.identity_digest, PROJECT_DATABASE_SCHEMA_32_CANONICAL_SHA256({
      databaseUuid: DATABASE_UUID,
      recoveryGeneration: RECOVERY_GENERATION,
      capturedWriteSequence: 0,
      storagePolicyRevision: 1,
      schemaLineageDigest: PROJECT_DATABASE_SCHEMA_32_LINEAGE_DIGEST,
    }));

    fixture.database.close();
    fixture.database = null;
    verifier = openVerifier(fixture.filename);
    const verified = verifyProjectDatabaseCanonicalBackup32(verifier, sealOptions({
      now: undefined,
      createReceiptUuid: undefined,
    }));
    assert.equal(verified.verified, true);
    assert.equal(verified.integrationStatus, 'standalone-unwired');
    assert.equal(verified.receiptUuid, RECEIPT_UUID_0);
    assert.equal(verified.logicalContentDigest, stored.logical_content_digest);
    assert.equal(verifier.inTransaction, false);
  } finally {
    try { verifier?.close(); } catch (_) {}
    try { fixture.database?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('B2 schema32 same identity sequence reuses exact head and never creates an orphan receipt', () => {
  const fixture = temporaryFixture('t8-schema32-canonical-reuse-');
  try {
    const first = sealProjectDatabaseCanonicalBackup32(fixture.database, sealOptions());
    const reused = sealProjectDatabaseCanonicalBackup32(fixture.database, sealOptions({
      now() { throw new Error('idempotent seal must not request a new timestamp'); },
      createReceiptUuid() { throw new Error('idempotent seal must not request a new UUID'); },
    }));
    assert.equal(reused.reused, true);
    assert.equal(reused.receiptUuid, first.receiptUuid);
    assert.equal(fixture.database.prepare(`
      SELECT COUNT(*) AS count FROM project_database_backup_receipts
    `).get().count, 1);
    assert.equal(fixture.database.prepare(`
      SELECT receipt_uuid FROM project_database_canonical_backup_head WHERE singleton_id = 1
    `).get().receipt_uuid, RECEIPT_UUID_0);
  } finally {
    fixture.database.close();
    cleanup(fixture.directory);
  }
});

test('B2 schema32 canonical head advances only after identity sequence advances', () => {
  const fixture = temporaryFixture('t8-schema32-canonical-advance-');
  let verifier = null;
  try {
    sealProjectDatabaseCanonicalBackup32(fixture.database, sealOptions());
    fixture.database.exec('BEGIN IMMEDIATE');
    fixture.database.prepare('UPDATE project_documents SET value = ? WHERE id = 1').run('next');
    fixture.database.prepare(`
      UPDATE project_database_identity
      SET write_sequence = write_sequence + 1, updated_at = 2100
      WHERE singleton_id = 1
    `).run();
    fixture.database.exec('COMMIT');
    const advanced = sealProjectDatabaseCanonicalBackup32(fixture.database, sealOptions({
      now: () => 3000,
      createReceiptUuid: () => RECEIPT_UUID_1,
    }));
    assert.equal(advanced.reused, false);
    assert.equal(advanced.receiptUuid, RECEIPT_UUID_1);
    assert.equal(advanced.capturedWriteSequence, 1);
    assert.deepEqual(fixture.database.prepare(`
      SELECT receipt_uuid, captured_write_sequence
      FROM project_database_canonical_backup_head
    `).get(), {
      receipt_uuid: RECEIPT_UUID_1,
      captured_write_sequence: 1,
    });
    assert.equal(fixture.database.prepare(`
      SELECT COUNT(*) AS count FROM project_database_backup_receipts
    `).get().count, 2);

    fixture.database.close();
    fixture.database = null;
    verifier = openVerifier(fixture.filename);
    assert.equal(verifyProjectDatabaseCanonicalBackup32(verifier, sealOptions()).verified, true);
  } finally {
    try { verifier?.close(); } catch (_) {}
    try { fixture.database?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('B2 schema32 verifier fails closed after logical content changes without sequence evidence', () => {
  const fixture = temporaryFixture('t8-schema32-canonical-logical-tamper-');
  let verifier = null;
  try {
    sealProjectDatabaseCanonicalBackup32(fixture.database, sealOptions());
    fixture.database.prepare('UPDATE project_documents SET value = ? WHERE id = 1').run('tampered');
    assert.throws(
      () => sealProjectDatabaseCanonicalBackup32(fixture.database, sealOptions({
        createReceiptUuid: () => RECEIPT_UUID_1,
      })),
      canonicalError('receipt-digest-mismatch'),
    );
    assert.equal(fixture.database.prepare(`
      SELECT COUNT(*) AS count FROM project_database_backup_receipts
    `).get().count, 1);
    fixture.database.close();
    fixture.database = null;
    verifier = openVerifier(fixture.filename);
    assert.throws(
      () => verifyProjectDatabaseCanonicalBackup32(verifier, sealOptions()),
      canonicalError('receipt-digest-mismatch'),
    );
  } finally {
    try { verifier?.close(); } catch (_) {}
    try { fixture.database?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('B2 schema32 sealer rejects unaccepted source and any implicit or wrong target fingerprint', () => {
  const sourceFixture = temporaryFixture('t8-schema32-canonical-source-');
  const targetFixture = temporaryFixture('t8-schema32-canonical-target-');
  const inspectedFixture = temporaryFixture('t8-schema32-canonical-inspected-');
  const implicitTargetFixture = temporaryFixture('t8-schema32-canonical-implicit-target-');
  const mutatingInspectorFixture = temporaryFixture('t8-schema32-canonical-mutating-inspector-');
  try {
    sourceFixture.database.prepare(`
      UPDATE schema_migration_receipts SET from_fingerprint = ? WHERE version = 32
    `).run('0'.repeat(64));
    assert.throws(
      () => sealProjectDatabaseCanonicalBackup32(sourceFixture.database, sealOptions()),
      canonicalError('migration-receipt-invalid'),
    );
    assert.throws(
      () => sealProjectDatabaseCanonicalBackup32(targetFixture.database, sealOptions({
        targetSchemaFingerprint: 'e'.repeat(64),
      })),
      canonicalError('migration-receipt-invalid'),
    );
    assert.throws(
      () => sealProjectDatabaseCanonicalBackup32(inspectedFixture.database, sealOptions({
        inspectSchemaFingerprint: () => 'e'.repeat(64),
      })),
      canonicalError('schema-fingerprint-mismatch'),
    );
    assert.throws(
      () => sealProjectDatabaseCanonicalBackup32(
        implicitTargetFixture.database,
        sealOptions({ targetSchemaFingerprint: undefined }),
      ),
      canonicalError('sha256-invalid'),
    );
    assert.throws(
      () => sealProjectDatabaseCanonicalBackup32(mutatingInspectorFixture.database, sealOptions({
        inspectSchemaFingerprint(database) {
          database.prepare('UPDATE project_documents SET value = ? WHERE id = 1').run('mutated');
          return TARGET_FINGERPRINT;
        },
      })),
      canonicalError('schema-fingerprint-callback-mutated-candidate'),
    );
    assert.equal(mutatingInspectorFixture.database.prepare(`
      SELECT value FROM project_documents WHERE id = 1
    `).get().value, 'initial');
    for (const fixture of [
      sourceFixture,
      targetFixture,
      inspectedFixture,
      implicitTargetFixture,
      mutatingInspectorFixture,
    ]) {
      assert.equal(fixture.database.prepare(`
        SELECT COUNT(*) AS count FROM project_database_backup_receipts
      `).get().count, 0);
    }
  } finally {
    for (const fixture of [
      sourceFixture,
      targetFixture,
      inspectedFixture,
      implicitTargetFixture,
      mutatingInspectorFixture,
    ]) {
      fixture.database.close();
      cleanup(fixture.directory);
    }
  }
});

test('B2 schema32 verifier requires query-only and rejects stored digest tampering', () => {
  const queryFixture = temporaryFixture('t8-schema32-canonical-query-only-');
  const digestFixture = temporaryFixture('t8-schema32-canonical-digest-tamper-');
  let digestVerifier = null;
  try {
    sealProjectDatabaseCanonicalBackup32(queryFixture.database, sealOptions());
    assert.throws(
      () => verifyProjectDatabaseCanonicalBackup32(queryFixture.database, sealOptions()),
      canonicalError('query-only-required'),
    );

    sealProjectDatabaseCanonicalBackup32(digestFixture.database, sealOptions());
    digestFixture.database.exec(`
      DROP TRIGGER trg_project_database_backup_receipts_update_guard;
    `);
    digestFixture.database.prepare(`
      UPDATE project_database_backup_receipts
      SET identity_digest = ?
      WHERE receipt_uuid = ?
    `).run('9'.repeat(64), RECEIPT_UUID_0);
    digestFixture.database.close();
    digestFixture.database = null;
    digestVerifier = openVerifier(digestFixture.filename);
    assert.throws(
      () => verifyProjectDatabaseCanonicalBackup32(digestVerifier, sealOptions()),
      canonicalError('receipt-digest-mismatch'),
    );
  } finally {
    try { digestVerifier?.close(); } catch (_) {}
    try { queryFixture.database?.close(); } catch (_) {}
    try { digestFixture.database?.close(); } catch (_) {}
    cleanup(queryFixture.directory);
    cleanup(digestFixture.directory);
  }
});
