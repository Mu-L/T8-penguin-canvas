'use strict';

const { randomUUID } = require('node:crypto');

const {
  PROJECT_DATABASE_MIGRATION_32,
  PROJECT_DATABASE_SCHEMA_32_ACCEPTED_SCHEMA_31_FINGERPRINTS,
  PROJECT_DATABASE_SCHEMA_32_CANONICAL_SHA256,
  PROJECT_DATABASE_SCHEMA_32_LINEAGE,
  PROJECT_DATABASE_SCHEMA_32_LINEAGE_DIGEST,
  PROJECT_DATABASE_SCHEMA_32_LOGICAL_CONTENT_DIGEST_SCOPE,
} = require('./projectDatabaseMigration32');
const {
  LOGICAL_DIGEST_ALGORITHM_32,
  projectDatabaseLogicalContentDigest32,
} = require('./projectDatabaseLogicalDigest32');

const PROJECT_DATABASE_CANONICAL_BACKUP_32_INTEGRATION_STATUS = 'standalone-unwired';
const RECEIPT_FORMAT_VERSION = 1;
const BACKUP_KIND = 'canonical';
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const ACCEPTED_SOURCE_FINGERPRINTS = new Set(
  PROJECT_DATABASE_SCHEMA_32_ACCEPTED_SCHEMA_31_FINGERPRINTS,
);

const RECEIPT_COLUMNS = Object.freeze([
  'receipt_uuid',
  'receipt_format_version',
  'backup_kind',
  'database_uuid',
  'recovery_generation',
  'captured_write_sequence',
  'storage_policy_revision',
  'schema_version',
  'schema_lineage',
  'schema_lineage_digest',
  'from_schema_fingerprint',
  'schema_fingerprint',
  'migration_name',
  'migration_checksum',
  'migration_down_policy',
  'migration_applied_at',
  'migration_receipt_digest',
  'identity_digest',
  'logical_content_digest_algorithm',
  'logical_content_digest_scope',
  'logical_content_digest',
  'created_at',
  'sealed_at',
]);

const RECEIPT_SEMANTIC_COLUMNS = Object.freeze(
  RECEIPT_COLUMNS.filter((column) => !['receipt_uuid', 'created_at', 'sealed_at'].includes(column)),
);

class ProjectDatabaseCanonicalBackup32Error extends Error {
  constructor(reason, message, details = {}, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProjectDatabaseCanonicalBackup32Error';
    this.code = 'project_database_canonical_backup_32_invalid';
    this.reason = String(reason || 'invalid');
    this.details = Object.freeze({ reason: this.reason, ...details });
  }
}

function fail(reason, message, details = {}, cause = undefined) {
  throw new ProjectDatabaseCanonicalBackup32Error(reason, message, details, cause);
}

function assertDatabase(database) {
  if (!database
    || typeof database.prepare !== 'function'
    || typeof database.exec !== 'function'
    || typeof database.pragma !== 'function') {
    fail('database-required', 'schema32 canonical backup requires an open SQLite candidate');
  }
}

function safeInteger(value, field, minimum = 0) {
  if (typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > MAX_SAFE_INTEGER) {
    fail('safe-integer-invalid', `${field} must be a safe integer >= ${minimum}`, { field });
  }
  return value;
}

function canonicalUuid(value, field) {
  if (typeof value !== 'string'
    || value !== value.toLowerCase()
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(value)) {
    fail('uuid-invalid', `${field} must be a canonical lowercase RFC 4122 UUID`, { field });
  }
  return value;
}

function canonicalSha256(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    fail('sha256-invalid', `${field} must be a canonical lowercase SHA-256 digest`, { field });
  }
  return value;
}

function requireSingleRow(rows, reason, label) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    fail(reason, `${label} must contain exactly one row`, {
      actualCount: Array.isArray(rows) ? rows.length : null,
    });
  }
  return rows[0];
}

function inspectIdentity(database) {
  const row = requireSingleRow(database.prepare(`
    SELECT singleton_id, database_uuid, recovery_generation, write_sequence,
           schema_version, schema_lineage, schema_lineage_digest,
           created_at, updated_at
    FROM project_database_identity
  `).all(), 'identity-invalid', 'project_database_identity');
  const identity = Object.freeze({
    singletonId: safeInteger(row.singleton_id, 'identity.singletonId', 1),
    databaseUuid: canonicalUuid(row.database_uuid, 'identity.databaseUuid'),
    recoveryGeneration: canonicalUuid(
      row.recovery_generation,
      'identity.recoveryGeneration',
    ),
    writeSequence: safeInteger(row.write_sequence, 'identity.writeSequence'),
    schemaVersion: safeInteger(row.schema_version, 'identity.schemaVersion', 1),
    schemaLineage: String(row.schema_lineage || ''),
    schemaLineageDigest: canonicalSha256(
      row.schema_lineage_digest,
      'identity.schemaLineageDigest',
    ),
    createdAt: safeInteger(row.created_at, 'identity.createdAt', 1),
    updatedAt: safeInteger(row.updated_at, 'identity.updatedAt', 1),
  });
  if (identity.singletonId !== 1
    || identity.schemaVersion !== PROJECT_DATABASE_MIGRATION_32.version
    || identity.schemaLineage !== PROJECT_DATABASE_SCHEMA_32_LINEAGE
    || identity.schemaLineageDigest !== PROJECT_DATABASE_SCHEMA_32_LINEAGE_DIGEST
    || identity.updatedAt < identity.createdAt) {
    fail('identity-invalid', 'schema32 database identity is not the exact current contract');
  }
  return identity;
}

function inspectPolicy(database) {
  const row = requireSingleRow(database.prepare(`
    SELECT singleton_id, policy_revision, active_storage_budget_bytes,
           main_max_bytes, wal_checkpoint_target_bytes,
           maximum_single_transaction_wal_bytes, wal_pressure_bytes,
           wal_reserve_bytes, wal_residual_limit_bytes, shm_reserve_bytes,
           hot_journal_reserve_bytes, sqlite_temp_reserve_bytes,
           minimum_filesystem_free_bytes, backup_candidate_reserve_bytes,
           recovery_evidence_reserve_bytes, synchronous_mode, updated_at
    FROM project_database_storage_policy
  `).all(), 'policy-invalid', 'project_database_storage_policy');
  const integerFields = {
    singletonId: [row.singleton_id, 1],
    policyRevision: [row.policy_revision, 1],
    activeStorageBudgetBytes: [row.active_storage_budget_bytes, 1],
    mainMaxBytes: [row.main_max_bytes, 1],
    walCheckpointTargetBytes: [row.wal_checkpoint_target_bytes, 1],
    maximumSingleTransactionWalBytes: [row.maximum_single_transaction_wal_bytes, 1],
    walPressureBytes: [row.wal_pressure_bytes, 1],
    walReserveBytes: [row.wal_reserve_bytes, 1],
    walResidualLimitBytes: [row.wal_residual_limit_bytes, 0],
    shmReserveBytes: [row.shm_reserve_bytes, 1],
    hotJournalReserveBytes: [row.hot_journal_reserve_bytes, 1],
    sqliteTempReserveBytes: [row.sqlite_temp_reserve_bytes, 1],
    minimumFilesystemFreeBytes: [row.minimum_filesystem_free_bytes, 1],
    backupCandidateReserveBytes: [row.backup_candidate_reserve_bytes, 1],
    recoveryEvidenceReserveBytes: [row.recovery_evidence_reserve_bytes, 1],
    updatedAt: [row.updated_at, 1],
  };
  const policy = {};
  for (const [field, [value, minimum]] of Object.entries(integerFields)) {
    policy[field] = safeInteger(value, `policy.${field}`, minimum);
  }
  policy.synchronousMode = String(row.synchronous_mode || '');
  const activeBudget = policy.mainMaxBytes
    + policy.walReserveBytes
    + policy.shmReserveBytes
    + policy.hotJournalReserveBytes
    + policy.sqliteTempReserveBytes
    + policy.minimumFilesystemFreeBytes;
  const minimumBackupReserve = policy.mainMaxBytes
    + policy.walResidualLimitBytes
    + policy.shmReserveBytes
    + policy.hotJournalReserveBytes;
  const totalReserve = activeBudget
    + policy.backupCandidateReserveBytes
    + policy.recoveryEvidenceReserveBytes;
  if (policy.singletonId !== 1
    || policy.synchronousMode !== 'FULL'
    || policy.walResidualLimitBytes > policy.walCheckpointTargetBytes
    || policy.walCheckpointTargetBytes + policy.maximumSingleTransactionWalBytes
      >= policy.walPressureBytes
    || policy.walPressureBytes >= policy.walReserveBytes
    || !Number.isSafeInteger(activeBudget)
    || activeBudget !== policy.activeStorageBudgetBytes
    || policy.backupCandidateReserveBytes < minimumBackupReserve
    || !Number.isSafeInteger(totalReserve)) {
    fail('policy-invalid', 'schema32 storage policy arithmetic or ordering is invalid');
  }
  return Object.freeze(policy);
}

function inspectMigrationReceipt(database, targetSchemaFingerprint) {
  const row = requireSingleRow(database.prepare(`
    SELECT version, name, checksum, from_fingerprint, to_fingerprint,
           down_policy, applied_at
    FROM schema_migration_receipts
    WHERE version = ?
  `).all(PROJECT_DATABASE_MIGRATION_32.version), 'migration-receipt-invalid',
  'schema_migration_receipts v32');
  const fromSchemaFingerprint = canonicalSha256(
    row.from_fingerprint,
    'migration.fromSchemaFingerprint',
  );
  const toSchemaFingerprint = canonicalSha256(
    row.to_fingerprint,
    'migration.toSchemaFingerprint',
  );
  const appliedAt = safeInteger(row.applied_at, 'migration.appliedAt', 1);
  if (safeInteger(row.version, 'migration.version', 1) !== PROJECT_DATABASE_MIGRATION_32.version
    || row.name !== PROJECT_DATABASE_MIGRATION_32.name
    || row.checksum !== PROJECT_DATABASE_MIGRATION_32.checksum
    || row.down_policy !== PROJECT_DATABASE_MIGRATION_32.downPolicy
    || !ACCEPTED_SOURCE_FINGERPRINTS.has(fromSchemaFingerprint)
    || toSchemaFingerprint !== targetSchemaFingerprint) {
    fail('migration-receipt-invalid', 'schema32 migration receipt is not the exact frozen contract');
  }
  const ledgerRows = database.prepare(`
    SELECT version, applied_at
    FROM schema_migrations
    WHERE version = ?
  `).all(PROJECT_DATABASE_MIGRATION_32.version);
  const ledger = requireSingleRow(
    ledgerRows,
    'migration-ledger-invalid',
    'schema_migrations v32',
  );
  if (safeInteger(ledger.version, 'migrationLedger.version', 1)
      !== PROJECT_DATABASE_MIGRATION_32.version
    || safeInteger(ledger.applied_at, 'migrationLedger.appliedAt', 1) !== appliedAt) {
    fail('migration-ledger-invalid', 'schema32 migration ledger and receipt do not agree');
  }
  return Object.freeze({
    schemaVersion: PROJECT_DATABASE_MIGRATION_32.version,
    migrationName: PROJECT_DATABASE_MIGRATION_32.name,
    migrationChecksum: PROJECT_DATABASE_MIGRATION_32.checksum,
    fromSchemaFingerprint,
    schemaFingerprint: toSchemaFingerprint,
    downPolicy: PROJECT_DATABASE_MIGRATION_32.downPolicy,
    appliedAt,
  });
}

function inspectSchemaFingerprint(database, callback) {
  if (typeof callback !== 'function') {
    fail('schema-fingerprint-callback-required', 'inspectSchemaFingerprint callback is required');
  }
  const changesBefore = safeInteger(
    database.prepare('SELECT total_changes() AS count').get().count,
    'schemaFingerprint.totalChangesBefore',
  );
  const schemaVersionBefore = safeInteger(
    database.pragma('schema_version', { simple: true }),
    'schemaFingerprint.schemaVersionBefore',
  );
  const inspected = callback(database);
  if (inspected && typeof inspected.then === 'function') {
    fail('schema-fingerprint-invalid', 'inspectSchemaFingerprint must be synchronous');
  }
  const changesAfter = safeInteger(
    database.prepare('SELECT total_changes() AS count').get().count,
    'schemaFingerprint.totalChangesAfter',
  );
  const schemaVersionAfter = safeInteger(
    database.pragma('schema_version', { simple: true }),
    'schemaFingerprint.schemaVersionAfter',
  );
  if (changesAfter !== changesBefore || schemaVersionAfter !== schemaVersionBefore) {
    fail(
      'schema-fingerprint-callback-mutated-candidate',
      'inspectSchemaFingerprint must not mutate candidate data or schema',
    );
  }
  const fingerprint = typeof inspected === 'string' ? inspected : inspected?.fingerprint;
  return canonicalSha256(fingerprint, 'inspectedSchemaFingerprint');
}

function inspectCandidateEvidence(database, options, requireQueryOnly) {
  const targetSchemaFingerprint = canonicalSha256(
    options?.targetSchemaFingerprint,
    'targetSchemaFingerprint',
  );
  const identity = inspectIdentity(database);
  const policy = inspectPolicy(database);
  const migration = inspectMigrationReceipt(database, targetSchemaFingerprint);
  const actualSchemaFingerprint = inspectSchemaFingerprint(
    database,
    options?.inspectSchemaFingerprint,
  );
  if (actualSchemaFingerprint !== targetSchemaFingerprint) {
    fail('schema-fingerprint-mismatch', 'candidate schema fingerprint does not match the explicit target', {
      expected: targetSchemaFingerprint,
      actual: actualSchemaFingerprint,
    });
  }
  const logical = projectDatabaseLogicalContentDigest32(database, { requireQueryOnly });
  if (logical.algorithm !== LOGICAL_DIGEST_ALGORITHM_32
    || logical.scope !== PROJECT_DATABASE_SCHEMA_32_LOGICAL_CONTENT_DIGEST_SCOPE) {
    fail('logical-digest-contract-invalid', 'logical digest returned an unexpected algorithm or scope');
  }
  const migrationReceiptDigest = PROJECT_DATABASE_SCHEMA_32_CANONICAL_SHA256(migration);
  const identityDigest = PROJECT_DATABASE_SCHEMA_32_CANONICAL_SHA256({
    databaseUuid: identity.databaseUuid,
    recoveryGeneration: identity.recoveryGeneration,
    capturedWriteSequence: identity.writeSequence,
    storagePolicyRevision: policy.policyRevision,
    schemaLineageDigest: identity.schemaLineageDigest,
  });
  return Object.freeze({
    identity,
    policy,
    migration,
    actualSchemaFingerprint,
    logical,
    migrationReceiptDigest,
    identityDigest,
  });
}

function expectedReceipt(evidence, timestamps = {}) {
  return Object.freeze({
    receipt_uuid: timestamps.receiptUuid ?? null,
    receipt_format_version: RECEIPT_FORMAT_VERSION,
    backup_kind: BACKUP_KIND,
    database_uuid: evidence.identity.databaseUuid,
    recovery_generation: evidence.identity.recoveryGeneration,
    captured_write_sequence: evidence.identity.writeSequence,
    storage_policy_revision: evidence.policy.policyRevision,
    schema_version: evidence.migration.schemaVersion,
    schema_lineage: PROJECT_DATABASE_SCHEMA_32_LINEAGE,
    schema_lineage_digest: PROJECT_DATABASE_SCHEMA_32_LINEAGE_DIGEST,
    from_schema_fingerprint: evidence.migration.fromSchemaFingerprint,
    schema_fingerprint: evidence.migration.schemaFingerprint,
    migration_name: evidence.migration.migrationName,
    migration_checksum: evidence.migration.migrationChecksum,
    migration_down_policy: evidence.migration.downPolicy,
    migration_applied_at: evidence.migration.appliedAt,
    migration_receipt_digest: evidence.migrationReceiptDigest,
    identity_digest: evidence.identityDigest,
    logical_content_digest_algorithm: evidence.logical.algorithm,
    logical_content_digest_scope: evidence.logical.scope,
    logical_content_digest: evidence.logical.digest,
    created_at: timestamps.now ?? null,
    sealed_at: timestamps.now ?? null,
  });
}

function normalizeReceiptRow(row) {
  if (!row || typeof row !== 'object') fail('receipt-missing', 'canonical receipt is missing');
  const receipt = {
    receipt_uuid: canonicalUuid(row.receipt_uuid, 'receipt.receiptUuid'),
    receipt_format_version: safeInteger(
      row.receipt_format_version,
      'receipt.receiptFormatVersion',
      1,
    ),
    backup_kind: String(row.backup_kind || ''),
    database_uuid: canonicalUuid(row.database_uuid, 'receipt.databaseUuid'),
    recovery_generation: canonicalUuid(
      row.recovery_generation,
      'receipt.recoveryGeneration',
    ),
    captured_write_sequence: safeInteger(
      row.captured_write_sequence,
      'receipt.capturedWriteSequence',
    ),
    storage_policy_revision: safeInteger(
      row.storage_policy_revision,
      'receipt.storagePolicyRevision',
      1,
    ),
    schema_version: safeInteger(row.schema_version, 'receipt.schemaVersion', 1),
    schema_lineage: String(row.schema_lineage || ''),
    schema_lineage_digest: canonicalSha256(
      row.schema_lineage_digest,
      'receipt.schemaLineageDigest',
    ),
    from_schema_fingerprint: canonicalSha256(
      row.from_schema_fingerprint,
      'receipt.fromSchemaFingerprint',
    ),
    schema_fingerprint: canonicalSha256(
      row.schema_fingerprint,
      'receipt.schemaFingerprint',
    ),
    migration_name: String(row.migration_name || ''),
    migration_checksum: canonicalSha256(row.migration_checksum, 'receipt.migrationChecksum'),
    migration_down_policy: String(row.migration_down_policy || ''),
    migration_applied_at: safeInteger(
      row.migration_applied_at,
      'receipt.migrationAppliedAt',
      1,
    ),
    migration_receipt_digest: canonicalSha256(
      row.migration_receipt_digest,
      'receipt.migrationReceiptDigest',
    ),
    identity_digest: canonicalSha256(row.identity_digest, 'receipt.identityDigest'),
    logical_content_digest_algorithm: String(row.logical_content_digest_algorithm || ''),
    logical_content_digest_scope: String(row.logical_content_digest_scope || ''),
    logical_content_digest: canonicalSha256(
      row.logical_content_digest,
      'receipt.logicalContentDigest',
    ),
    created_at: safeInteger(row.created_at, 'receipt.createdAt', 1),
    sealed_at: safeInteger(row.sealed_at, 'receipt.sealedAt', 1),
  };
  if (receipt.receipt_format_version !== RECEIPT_FORMAT_VERSION
    || receipt.backup_kind !== BACKUP_KIND
    || receipt.sealed_at < receipt.created_at) {
    fail('receipt-invalid', 'canonical receipt format, kind or timestamps are invalid');
  }
  return Object.freeze(receipt);
}

function assertReceiptMatchesExpected(receiptRow, expected) {
  const receipt = normalizeReceiptRow(receiptRow);
  for (const column of RECEIPT_SEMANTIC_COLUMNS) {
    if (receipt[column] !== expected[column]) {
      fail('receipt-digest-mismatch', `canonical receipt ${column} does not match candidate evidence`, {
        column,
      });
    }
  }
  return receipt;
}

function readHead(database, required) {
  const rows = database.prepare(`
    SELECT singleton_id, receipt_uuid, database_uuid, recovery_generation,
           captured_write_sequence, selected_at
    FROM project_database_canonical_backup_head
  `).all();
  if (rows.length === 0 && !required) return null;
  const row = requireSingleRow(rows, 'canonical-head-invalid', 'canonical backup head');
  const head = Object.freeze({
    singletonId: safeInteger(row.singleton_id, 'head.singletonId', 1),
    receiptUuid: canonicalUuid(row.receipt_uuid, 'head.receiptUuid'),
    databaseUuid: canonicalUuid(row.database_uuid, 'head.databaseUuid'),
    recoveryGeneration: canonicalUuid(
      row.recovery_generation,
      'head.recoveryGeneration',
    ),
    capturedWriteSequence: safeInteger(
      row.captured_write_sequence,
      'head.capturedWriteSequence',
    ),
    selectedAt: safeInteger(row.selected_at, 'head.selectedAt', 1),
  });
  if (head.singletonId !== 1) fail('canonical-head-invalid', 'canonical head singleton is invalid');
  return head;
}

function readReceiptByUuid(database, receiptUuid) {
  return requireSingleRow(database.prepare(`
    SELECT ${RECEIPT_COLUMNS.join(', ')}
    FROM project_database_backup_receipts
    WHERE receipt_uuid = ?
  `).all(receiptUuid), 'receipt-missing', 'canonical head receipt');
}

function assertHeadReceiptRelationship(head, receipt) {
  if (head.receiptUuid !== receipt.receipt_uuid
    || head.databaseUuid !== receipt.database_uuid
    || head.recoveryGeneration !== receipt.recovery_generation
    || head.capturedWriteSequence !== receipt.captured_write_sequence
    || head.selectedAt < receipt.sealed_at) {
    fail('canonical-head-mismatch', 'canonical head does not exactly select its receipt');
  }
}

function countReceiptsForIdentitySequence(database, identity) {
  return safeInteger(database.prepare(`
    SELECT COUNT(*) AS count
    FROM project_database_backup_receipts
    WHERE database_uuid = ?
      AND recovery_generation = ?
      AND captured_write_sequence = ?
  `).get(identity.databaseUuid, identity.recoveryGeneration, identity.writeSequence).count,
  'receiptIdentitySequenceCount');
}

function transaction(database, mode, operation, callback) {
  if (database.inTransaction === true) {
    fail('transaction-boundary-invalid', `${operation} requires ownership of its SQLite transaction`);
  }
  try {
    database.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (cause) {
    if (database.inTransaction === true) {
      try { database.exec('ROLLBACK'); } catch (_) {}
    }
    if (cause instanceof ProjectDatabaseCanonicalBackup32Error) throw cause;
    fail(`${operation}-failed`, `schema32 canonical backup ${operation} failed closed`, {
      errorCode: cause?.code || null,
    }, cause);
  }
}

function injectedNow(options) {
  const provider = options?.now ?? Date.now;
  if (typeof provider !== 'function') fail('time-provider-invalid', 'now must be a function');
  return safeInteger(provider(), 'now', 1);
}

function injectedReceiptUuid(options) {
  const provider = options?.createReceiptUuid ?? randomUUID;
  if (typeof provider !== 'function') {
    fail('uuid-provider-invalid', 'createReceiptUuid must be a function');
  }
  return canonicalUuid(provider(), 'generatedReceiptUuid');
}

function sealProjectDatabaseCanonicalBackup32(database, options = {}) {
  assertDatabase(database);
  if (Number(database.pragma('query_only', { simple: true })) !== 0) {
    fail('writable-private-candidate-required', 'sealing requires a writable private candidate');
  }
  if (Number(database.pragma('foreign_keys', { simple: true })) !== 1) {
    fail('foreign-keys-required', 'sealing requires PRAGMA foreign_keys=ON');
  }
  return transaction(database, 'immediate', 'seal', () => {
    const evidence = inspectCandidateEvidence(database, options, false);
    const expected = expectedReceipt(evidence);
    const head = readHead(database, false);
    if (head) {
      const headReceipt = normalizeReceiptRow(readReceiptByUuid(database, head.receiptUuid));
      assertHeadReceiptRelationship(head, headReceipt);
      if (head.databaseUuid !== evidence.identity.databaseUuid) {
        fail('canonical-head-database-mismatch', 'canonical head belongs to another database UUID');
      }
      if (head.capturedWriteSequence === evidence.identity.writeSequence) {
        if (head.recoveryGeneration !== evidence.identity.recoveryGeneration) {
          fail('canonical-head-generation-mismatch', 'same sequence cannot identify two generations');
        }
        const currentReceiptCount = countReceiptsForIdentitySequence(database, evidence.identity);
        if (currentReceiptCount !== 1) {
          fail('receipt-identity-sequence-collision', 'current identity sequence has duplicate receipts');
        }
        const reused = assertReceiptMatchesExpected(headReceipt, expected);
        return Object.freeze({
          sealed: true,
          reused: true,
          receiptUuid: reused.receipt_uuid,
          databaseUuid: reused.database_uuid,
          recoveryGeneration: reused.recovery_generation,
          capturedWriteSequence: reused.captured_write_sequence,
          migrationReceiptDigest: reused.migration_receipt_digest,
          identityDigest: reused.identity_digest,
          logicalContentDigest: reused.logical_content_digest,
        });
      }
      if (head.capturedWriteSequence > evidence.identity.writeSequence) {
        fail('canonical-head-sequence-regression', 'candidate sequence is behind canonical head');
      }
      const orphanCount = safeInteger(database.prepare(`
        SELECT COUNT(*) AS count
        FROM project_database_backup_receipts
        WHERE database_uuid = ? AND captured_write_sequence > ?
      `).get(evidence.identity.databaseUuid, head.capturedWriteSequence).count,
      'receiptOrphanCount');
      if (orphanCount !== 0
        || countReceiptsForIdentitySequence(database, evidence.identity) !== 0) {
        fail('orphan-receipt-detected', 'candidate contains a receipt not selected by canonical head');
      }
    } else {
      const receiptCount = safeInteger(database.prepare(`
        SELECT COUNT(*) AS count FROM project_database_backup_receipts
      `).get().count, 'receiptCount');
      if (receiptCount !== 0) {
        fail('orphan-receipt-detected', 'candidate has receipts without a canonical head');
      }
    }

    const now = injectedNow(options);
    const receiptUuid = injectedReceiptUuid(options);
    const receipt = expectedReceipt(evidence, { now, receiptUuid });
    database.prepare(`
      INSERT INTO project_database_backup_receipts (
        ${RECEIPT_COLUMNS.join(', ')}
      ) VALUES (
        ${RECEIPT_COLUMNS.map((column) => `@${column}`).join(', ')}
      )
    `).run(receipt);
    if (!head) {
      database.prepare(`
        INSERT INTO project_database_canonical_backup_head (
          singleton_id, receipt_uuid, database_uuid, recovery_generation,
          captured_write_sequence, selected_at
        ) VALUES (1, ?, ?, ?, ?, ?)
      `).run(
        receipt.receipt_uuid,
        receipt.database_uuid,
        receipt.recovery_generation,
        receipt.captured_write_sequence,
        now,
      );
    } else {
      const update = database.prepare(`
        UPDATE project_database_canonical_backup_head
        SET receipt_uuid = ?, database_uuid = ?, recovery_generation = ?,
            captured_write_sequence = ?, selected_at = ?
        WHERE singleton_id = 1
          AND receipt_uuid = ?
          AND database_uuid = ?
          AND recovery_generation = ?
          AND captured_write_sequence = ?
          AND selected_at = ?
      `).run(
        receipt.receipt_uuid,
        receipt.database_uuid,
        receipt.recovery_generation,
        receipt.captured_write_sequence,
        now,
        head.receiptUuid,
        head.databaseUuid,
        head.recoveryGeneration,
        head.capturedWriteSequence,
        head.selectedAt,
      );
      if (update.changes !== 1) {
        fail('canonical-head-race', 'canonical head changed during sealing');
      }
    }
    const sealedHead = readHead(database, true);
    const sealedReceipt = assertReceiptMatchesExpected(
      readReceiptByUuid(database, receiptUuid),
      receipt,
    );
    assertHeadReceiptRelationship(sealedHead, sealedReceipt);
    return Object.freeze({
      sealed: true,
      reused: false,
      receiptUuid,
      databaseUuid: receipt.database_uuid,
      recoveryGeneration: receipt.recovery_generation,
      capturedWriteSequence: receipt.captured_write_sequence,
      migrationReceiptDigest: receipt.migration_receipt_digest,
      identityDigest: receipt.identity_digest,
      logicalContentDigest: receipt.logical_content_digest,
    });
  });
}

function verifyProjectDatabaseCanonicalBackup32(database, options = {}) {
  assertDatabase(database);
  if (Number(database.pragma('query_only', { simple: true })) !== 1) {
    fail('query-only-required', 'verification requires PRAGMA query_only=ON');
  }
  return transaction(database, 'read', 'verify', () => {
    const quickCheck = database.pragma('quick_check');
    if (!Array.isArray(quickCheck)
      || quickCheck.length !== 1
      || String(quickCheck[0]?.quick_check || '') !== 'ok') {
      fail('quick-check-failed', 'candidate PRAGMA quick_check did not return exactly ok');
    }
    const foreignKeyViolations = database.pragma('foreign_key_check');
    if (!Array.isArray(foreignKeyViolations) || foreignKeyViolations.length !== 0) {
      fail('foreign-key-check-failed', 'candidate PRAGMA foreign_key_check found violations');
    }
    const evidence = inspectCandidateEvidence(database, options, true);
    const expected = expectedReceipt(evidence);
    const head = readHead(database, true);
    if (head.databaseUuid !== evidence.identity.databaseUuid
      || head.recoveryGeneration !== evidence.identity.recoveryGeneration
      || head.capturedWriteSequence !== evidence.identity.writeSequence) {
      fail('canonical-head-not-current', 'canonical head does not match current database identity');
    }
    const receipt = assertReceiptMatchesExpected(
      readReceiptByUuid(database, head.receiptUuid),
      expected,
    );
    assertHeadReceiptRelationship(head, receipt);
    if (countReceiptsForIdentitySequence(database, evidence.identity) !== 1) {
      fail('receipt-identity-sequence-collision', 'current identity sequence is not uniquely sealed');
    }
    const futureReceiptCount = safeInteger(database.prepare(`
      SELECT COUNT(*) AS count
      FROM project_database_backup_receipts
      WHERE database_uuid = ? AND captured_write_sequence > ?
    `).get(evidence.identity.databaseUuid, head.capturedWriteSequence).count,
    'futureReceiptCount');
    if (futureReceiptCount !== 0) {
      fail('orphan-receipt-detected', 'candidate contains a receipt ahead of canonical head');
    }
    return Object.freeze({
      verified: true,
      integrationStatus: PROJECT_DATABASE_CANONICAL_BACKUP_32_INTEGRATION_STATUS,
      receiptUuid: receipt.receipt_uuid,
      databaseUuid: receipt.database_uuid,
      recoveryGeneration: receipt.recovery_generation,
      capturedWriteSequence: receipt.captured_write_sequence,
      storagePolicyRevision: receipt.storage_policy_revision,
      fromSchemaFingerprint: receipt.from_schema_fingerprint,
      schemaFingerprint: receipt.schema_fingerprint,
      migrationReceiptDigest: receipt.migration_receipt_digest,
      identityDigest: receipt.identity_digest,
      logicalContentDigest: receipt.logical_content_digest,
    });
  });
}

module.exports = Object.freeze({
  PROJECT_DATABASE_CANONICAL_BACKUP_32_INTEGRATION_STATUS,
  ProjectDatabaseCanonicalBackup32Error,
  sealProjectDatabaseCanonicalBackup32,
  verifyProjectDatabaseCanonicalBackup32,
});
