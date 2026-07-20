const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const BetterSqlite3 = require('better-sqlite3');

const {
  PROJECT_DATABASE_MIGRATION_23,
  PROJECT_DATABASE_MIGRATION_23_IMPERATIVE_CONTRACT,
  PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT,
} = require('../backend/src/services/projectDatabaseMigration23');
const {
  PROJECT_DATABASE_MIGRATION_29,
  PROJECT_DATABASE_MIGRATION_29_DOWN_SQL,
  PROJECT_DATABASE_MIGRATION_29_IMPERATIVE_CONTRACT,
  PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES,
} = require('../backend/src/services/projectDatabaseMigration29');
const {
  PROJECT_DATABASE_MIGRATION_30,
  PROJECT_DATABASE_MIGRATION_30_DOWN_SQL,
  PROJECT_DATABASE_MIGRATION_30_IMPERATIVE_CONTRACT,
  PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES,
} = require('../backend/src/services/projectDatabaseMigration30');
const {
  PROJECT_DATABASE_MIGRATION_31,
  PROJECT_DATABASE_MIGRATION_31_COMPONENT_CHECKSUMS,
  PROJECT_DATABASE_MIGRATION_31_IMPERATIVE_CONTRACT,
  PROJECT_DATABASE_SCHEMA_31_EXTENSION_FINGERPRINT,
  PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES,
} = require('../backend/src/services/projectDatabaseMigration31');
const {
  PROJECT_DATABASE_MIGRATION_32,
} = require('../backend/src/services/projectDatabaseMigration32');
const {
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration31LegacyGaps');
const {
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS,
} = require('../backend/src/services/projectDatabaseMigration31DurableLedgers');
const {
  PROJECT_DATABASE_MIGRATIONS,
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');
const {
  stripSchema32ForSyntheticSchema31,
} = require('./helpers/projectDatabaseVersion.cjs');

const LEGACY_BRIDGE_VERSION = 28;

function migrationChecksum(migration) {
  const normalizeSql = (sql) => String(sql).replace(/\r\n?/g, '\n').trim();
  return crypto.createHash('sha256').update(JSON.stringify({
    format: migration.checksumCanonicalization,
    version: migration.version,
    fromVersion: migration.fromVersion,
    name: migration.name,
    downPolicy: migration.downPolicy,
    UP_SQL: normalizeSql(migration.UP_SQL),
    DOWN_SQL: normalizeSql(migration.DOWN_SQL),
    ownedObjectNames: migration.ownedObjectNames,
    imperativeContract: migration.imperativeContract,
  }), 'utf8').digest('hex');
}

function migrationVersions(database) {
  const exists = database.prepare(`
    SELECT 1 AS found FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get();
  if (!exists) return [];
  return database.prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
    .all().map((row) => Number(row.version));
}

function v29OwnedObjects(database) {
  const expected = new Set(PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES);
  return database.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type ASC, name ASC
  `).all().filter((row) => expected.has(row.name));
}

function v30OwnedObjects(database) {
  const expected = new Set(PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES);
  return database.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type ASC, name ASC
  `).all().filter((row) => expected.has(row.name));
}

// Production schema31 DOWN is intentionally backup-only. These tests remove
// only the empty schema31 component objects to reconstruct an isolated schema30
// fixture and exercise the older schema30/schema29 maintenance contracts.
function stripSchema31ForSchema30Test(database) {
  stripSchema32ForSyntheticSchema31(database);
  database.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DOWN_SQL);
  const drop = (type, name) => database.exec(`DROP ${type} IF EXISTS "${name}"`);
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.triggers
    .forEach((name) => drop('TRIGGER', name));
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.views
    .forEach((name) => drop('VIEW', name));
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.indexes
    .forEach((name) => drop('INDEX', name));
  [...PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.tables]
    .reverse()
    .forEach((name) => drop('TABLE', name));
  database.prepare('DELETE FROM schema_migration_receipts WHERE version = ?')
    .run(PROJECT_DATABASE_MIGRATION_31.version);
  database.prepare('DELETE FROM schema_migrations WHERE version = ?')
    .run(PROJECT_DATABASE_MIGRATION_31.version);
  assert.equal(migrationVersions(database).at(-1), PROJECT_DATABASE_MIGRATION_30.version);
}

test('B2 migration registry distinguishes legacy bridges, exact-endpoint v23, and the complete executable tail', () => {
  assert.equal(Object.isFrozen(PROJECT_DATABASE_MIGRATIONS), true);
  assert.equal(PROJECT_DATABASE_MIGRATIONS.length, PROJECT_DATABASE_SCHEMA_VERSION);
  assert.deepEqual(
    PROJECT_DATABASE_MIGRATIONS.map((migration) => migration.version),
    Array.from({ length: PROJECT_DATABASE_SCHEMA_VERSION }, (_, index) => index + 1),
  );
  assert.equal(new Set(PROJECT_DATABASE_MIGRATIONS.map((migration) => migration.name)).size, PROJECT_DATABASE_SCHEMA_VERSION);
  const legacyVersions = [
    ...Array.from({ length: PROJECT_DATABASE_MIGRATION_23.fromVersion }, (_, index) => index + 1),
    ...Array.from(
      { length: LEGACY_BRIDGE_VERSION - PROJECT_DATABASE_MIGRATION_23.version },
      (_, index) => PROJECT_DATABASE_MIGRATION_23.version + index + 1,
    ),
  ];
  assert.deepEqual(legacyVersions, [
    ...Array.from({ length: 22 }, (_, index) => index + 1),
    24, 25, 26, 27, 28,
  ]);
  for (const version of legacyVersions) {
    const migration = PROJECT_DATABASE_MIGRATIONS[version - 1];
    assert.equal(Object.isFrozen(migration), true);
    assert.equal(migration.version, version);
    assert.match(migration.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(migration.mode, 'legacy-bridge');
    assert.deepEqual(Object.keys(migration).sort(), ['mode', 'name', 'version']);
    for (const property of ['checksum', 'fromVersion', 'downPolicy', 'UP_SQL', 'DOWN_SQL', 'up', 'down']) {
      assert.equal(Object.hasOwn(migration, property), false);
    }
  }

  const schema23 = PROJECT_DATABASE_MIGRATIONS[PROJECT_DATABASE_MIGRATION_23.version - 1];
  assert.equal(Object.isFrozen(schema23), true);
  assert.deepEqual(Object.keys(schema23).sort(), [
    'checksum',
    'downPolicy',
    'fromVersion',
    'mode',
    'name',
    'version',
  ]);
  assert.deepEqual(schema23, {
    version: PROJECT_DATABASE_MIGRATION_23.version,
    name: PROJECT_DATABASE_MIGRATION_23.name,
    mode: 'executable-exact-endpoint-with-legacy-fallback',
    fromVersion: PROJECT_DATABASE_MIGRATION_23.fromVersion,
    checksum: PROJECT_DATABASE_MIGRATION_23.checksum,
    downPolicy: PROJECT_DATABASE_MIGRATION_23.downPolicy,
  });

  const executableDefinitions = [
    PROJECT_DATABASE_MIGRATION_29,
    PROJECT_DATABASE_MIGRATION_30,
    PROJECT_DATABASE_MIGRATION_31,
    PROJECT_DATABASE_MIGRATION_32,
  ].filter((migration) => migration.version <= PROJECT_DATABASE_SCHEMA_VERSION);
  const executables = PROJECT_DATABASE_MIGRATIONS.slice(LEGACY_BRIDGE_VERSION);
  assert.equal(executables.length, executableDefinitions.length);
  assert.deepEqual(
    executables.map((executable) => {
      assert.equal(Object.isFrozen(executable), true);
      assert.deepEqual(Object.keys(executable).sort(), [
        'checksum',
        'downPolicy',
        'fromVersion',
        'mode',
        'name',
        'version',
      ]);
      assert.equal(executable.mode, 'executable');
      assert.match(executable.checksum, /^[0-9a-f]{64}$/);
      return [
        executable.version,
        executable.fromVersion,
        executable.name,
        executable.checksum,
        executable.downPolicy,
      ];
    }),
    executableDefinitions.map((migration) => [
      migration.version,
      migration.fromVersion,
      migration.name,
      migration.checksum,
      migration.downPolicy,
    ]),
  );
  assert.equal(PROJECT_DATABASE_MIGRATION_23.checksum, migrationChecksum(PROJECT_DATABASE_MIGRATION_23));
  assert.equal(PROJECT_DATABASE_MIGRATION_29.checksum, migrationChecksum(PROJECT_DATABASE_MIGRATION_29));
  assert.equal(PROJECT_DATABASE_MIGRATION_30.checksum, migrationChecksum(PROJECT_DATABASE_MIGRATION_30));
  assert.equal(PROJECT_DATABASE_MIGRATION_31.checksum, migrationChecksum(PROJECT_DATABASE_MIGRATION_31));
  if (PROJECT_DATABASE_SCHEMA_VERSION >= PROJECT_DATABASE_MIGRATION_32.version) {
    assert.equal(PROJECT_DATABASE_MIGRATION_32.checksum, migrationChecksum(PROJECT_DATABASE_MIGRATION_32));
  }
});

test('B2 v23 checksum freezes the released schema22-to-schema23 imperative contract', () => {
  assert.equal(PROJECT_DATABASE_MIGRATION_23.fromVersion, 22);
  assert.equal(PROJECT_DATABASE_MIGRATION_23.name, 'room-resource-scope');
  assert.equal(PROJECT_DATABASE_MIGRATION_23.downPolicy, 'backup-only');
  assert.equal(PROJECT_DATABASE_MIGRATION_23.checksumCanonicalization, 't8-project-database-migration-v2');
  assert.equal(PROJECT_DATABASE_MIGRATION_23.checksum, 'a4b823ba46bc23817f9986c1a24618ec5372ff9365b100df95588c939e44ceca');
  assert.equal(PROJECT_DATABASE_MIGRATION_23.imperativeContract, PROJECT_DATABASE_MIGRATION_23_IMPERATIVE_CONTRACT);
  assert.equal(PROJECT_DATABASE_MIGRATION_23_IMPERATIVE_CONTRACT.lineage, PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT);
  assert.equal(Object.isFrozen(PROJECT_DATABASE_MIGRATION_23_IMPERATIVE_CONTRACT), true);
  assert.equal(Object.isFrozen(PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT), true);
  assert.deepEqual(
    PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT.provenance.map((source) => [
      source.tag,
      source.commit,
      source.sourceBlob,
    ]),
    [
      ['v2.5.6', 'affdaa07c04262746a4b65af96af7835d8d6744e', 'ecb279b2a012b11790b86c5bbed72a72e99925e6'],
      ['v2.5.7', 'a0934fb761cb725c53dbd4c704a0c4013005e778', 'af00452ea459867bf616d3ea6a9d376109158be9'],
      ['v2.5.8', '5aba6f7fdfeeca9f313afee3b9846f3958ed64f0', '8147dbe9fa218552d4d1164252e8918a1480e51e'],
    ],
  );
  assert.deepEqual({
    from: PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT.from,
    target: PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT.target,
    downstream: PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT.downstream,
  }, {
    from: {
      version: 22,
      fingerprint: '912a9d8633ccf9c52de9bcd39d94e15ad2f055a6bfc21496be09aa5f6c21e140',
      counts: { tables: 54, indexes: 68, triggers: 36, views: 0 },
    },
    target: {
      version: 23,
      fingerprint: '9507c7c9d50ed8df6bc1d8bbf33cd9a4b941abc49cf3b40885a5091a241b7c45',
      counts: { tables: 56, indexes: 72, triggers: 36, views: 0 },
    },
    downstream: {
      version: 28,
      fingerprint: '51f63a4ab1cdb07945e2b6975d78f7a718a4004dc1bf17ad03f7e82060e673b9',
    },
  });
  assert.equal(Object.isFrozen(PROJECT_DATABASE_MIGRATION_23_IMPERATIVE_CONTRACT.phases), true);
  assert.deepEqual(
    PROJECT_DATABASE_MIGRATION_23_IMPERATIVE_CONTRACT.phases.map((phase) => {
      assert.equal(Object.isFrozen(phase), true);
      assert.equal(Object.isFrozen(phase.invariants), true);
      assert.ok(phase.invariants.length >= 2);
      return [phase.id, phase.algorithmVersion];
    }),
    [
      ['locked-schema22-gate', 'released-full-fingerprint-data-version-v2'],
      ['canvas-scope-schema', 'released-v2.5.8-ddl-v1'],
      ['single-canvas-scope-backfill', 'released-single-canvas-min-count-v1'],
      ['invalid-scope-credential-revocation', 'released-invalid-scope-revocation-v1'],
      ['run-intent-scope-stale-audit', 'released-requester-canvas-scope-v1'],
      ['untrusted-resource-state-and-final-credential-revocation', 'released-resource-state-zero-v1'],
      ['post-migration-integrity', 'historical-receipt-fk-quick-v1'],
      ['lineage-receipt-commit', 'separate-historical-receipt-v2'],
    ],
  );
  assert.equal(PROJECT_DATABASE_MIGRATION_23.checksum, migrationChecksum(PROJECT_DATABASE_MIGRATION_23));
  const mutatedLineage = {
    ...PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT,
    from: {
      ...PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT.from,
      fingerprint: '0'.repeat(64),
    },
  };
  assert.notEqual(migrationChecksum({
    ...PROJECT_DATABASE_MIGRATION_23,
    imperativeContract: {
      ...PROJECT_DATABASE_MIGRATION_23_IMPERATIVE_CONTRACT,
      lineage: mutatedLineage,
    },
  }), PROJECT_DATABASE_MIGRATION_23.checksum);
});

test('B2 v29 checksum freezes the ordered imperative data-migration contract', () => {
  assert.equal(PROJECT_DATABASE_MIGRATION_29.checksumCanonicalization, 't8-project-database-migration-v2');
  assert.equal(PROJECT_DATABASE_MIGRATION_29.checksum, 'a8f05a9c0029fc29d08037216ea0a58b686714daa3fb9bc616f658f97800b7d8');
  assert.equal(PROJECT_DATABASE_MIGRATION_29.imperativeContract, PROJECT_DATABASE_MIGRATION_29_IMPERATIVE_CONTRACT);
  assert.equal(Object.isFrozen(PROJECT_DATABASE_MIGRATION_29_IMPERATIVE_CONTRACT), true);
  assert.equal(Object.isFrozen(PROJECT_DATABASE_MIGRATION_29_IMPERATIVE_CONTRACT.phases), true);
  assert.deepEqual(
    PROJECT_DATABASE_MIGRATION_29_IMPERATIVE_CONTRACT.phases.map((phase) => {
      assert.equal(Object.isFrozen(phase), true);
      assert.equal(Object.isFrozen(phase.invariants), true);
      assert.ok(phase.invariants.length >= 2);
      return [phase.id, phase.algorithmVersion];
    }),
    [
      ['locked-schema28-gate', 'fingerprint-data-version-v2'],
      ['initialize-history-policy-usage', 'project-scoped-exact-accounting-v2'],
      ['snapshot-pin-owner-backfill', 'project-scoped-owner-index-v3'],
      ['common-batch-keyset', 'batch-id-keyset-v1'],
      ['domain-batch-classifier', 'review-host-base-subflow-advancing-v2'],
      ['graph-evidence-binding', 'base-clientseq-actor-session-digest-timestamp-global-v5'],
      ['post-backfill-integrity', 'accounting-owner-pins-fk-quick-v2'],
      ['lineage-receipt-commit', 'locked-fingerprint-mapping-v2'],
    ],
  );
  assert.equal(PROJECT_DATABASE_MIGRATION_29.checksum, migrationChecksum(PROJECT_DATABASE_MIGRATION_29));
});

test('B2 v30 checksum freezes the seven-ledger capacity contract', () => {
  assert.equal(PROJECT_DATABASE_MIGRATION_30.checksumCanonicalization, 't8-project-database-migration-v2');
  assert.equal(PROJECT_DATABASE_MIGRATION_30.checksum, 'd3a817bae5cae028e8c13885180a6be23c5e3f08564827fc3397571a9275d69a');
  assert.equal(PROJECT_DATABASE_MIGRATION_30.imperativeContract, PROJECT_DATABASE_MIGRATION_30_IMPERATIVE_CONTRACT);
  assert.equal(Object.isFrozen(PROJECT_DATABASE_MIGRATION_30_IMPERATIVE_CONTRACT), true);
  assert.equal(Object.isFrozen(PROJECT_DATABASE_MIGRATION_30_IMPERATIVE_CONTRACT.phases), true);
  assert.deepEqual(
    PROJECT_DATABASE_MIGRATION_30_IMPERATIVE_CONTRACT.phases.map((phase) => {
      assert.equal(Object.isFrozen(phase), true);
      assert.equal(Object.isFrozen(phase.invariants), true);
      assert.ok(phase.invariants.length >= 2);
      return [phase.id, phase.algorithmVersion];
    }),
    [
      ['locked-schema29-gate', 'fingerprint-data-version-v1'],
      ['initialize-permanent-ledger-policy-usage', 'seven-kind-project-canvas-accounting-v1'],
      ['permanent-ledger-write-guards', 'after-insert-total-capacity-and-immutable-evidence-v1'],
      ['post-backfill-integrity', 'seven-kind-accounting-fk-quick-v1'],
      ['lineage-receipt-commit', 'schema29-base-plus-schema30-extension-v1'],
    ],
  );
  assert.equal(PROJECT_DATABASE_MIGRATION_30.checksum, migrationChecksum(PROJECT_DATABASE_MIGRATION_30));
});

test('B2 v31 checksum and extension fingerprint freeze the strict durable evidence boundary', () => {
  assert.equal(PROJECT_DATABASE_MIGRATION_31.fromVersion, 30);
  assert.equal(PROJECT_DATABASE_MIGRATION_31.name, 'strict-durable-evidence-boundaries');
  assert.equal(PROJECT_DATABASE_MIGRATION_31.downPolicy, 'backup-only');
  assert.equal(PROJECT_DATABASE_MIGRATION_31.checksumCanonicalization, 't8-project-database-migration-v2');
  assert.equal(
    PROJECT_DATABASE_MIGRATION_31.checksum,
    '33922f67c1f2d5126728f4cd74db10c2e1f381b37685935564031e85d898f444',
  );
  assert.equal(
    PROJECT_DATABASE_SCHEMA_31_EXTENSION_FINGERPRINT,
    '2ac8af2dfa9ec92cdf1f2a978dc9a924ad147efbb8ad2fa749df6b522628e658',
  );
  assert.deepEqual(PROJECT_DATABASE_MIGRATION_31_COMPONENT_CHECKSUMS, {
    legacySnapshotGaps: 'f1f131eb6f6b98ccd41d4ca50e4a72baf69d42ac2cc2f7101b6242aae2da5436',
    durableLedgers: '8b35400377b4e12b4d34618e09ca10165b2fd9c1242671e445d14e1a7f9cea00',
  });
  assert.equal(PROJECT_DATABASE_MIGRATION_31.ownedObjectNames, PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES);
  assert.equal(PROJECT_DATABASE_MIGRATION_31_IMPERATIVE_CONTRACT.extensionFingerprint,
    PROJECT_DATABASE_SCHEMA_31_EXTENSION_FINGERPRINT);
  assert.equal(PROJECT_DATABASE_MIGRATION_31.imperativeContract,
    PROJECT_DATABASE_MIGRATION_31_IMPERATIVE_CONTRACT);
  assert.equal(Object.isFrozen(PROJECT_DATABASE_MIGRATION_31_IMPERATIVE_CONTRACT), true);
  assert.equal(Object.isFrozen(PROJECT_DATABASE_MIGRATION_31_IMPERATIVE_CONTRACT.phases), true);
  assert.deepEqual(
    PROJECT_DATABASE_MIGRATION_31_IMPERATIVE_CONTRACT.phases.map((phase) => {
      assert.equal(Object.isFrozen(phase), true);
      assert.equal(Object.isFrozen(phase.invariants), true);
      assert.ok(phase.invariants.length >= 2);
      return [phase.id, phase.algorithmVersion];
    }),
    [
      ['locked-schema30-gate', 'fingerprint-data-version-backup-v1'],
      ['create-composed-schema31-extension', 'legacy-gap-plus-durable-state-v1'],
      ['initialize-durable-ledger-accounting', 'four-kind-project-database-accounting-v1'],
      ['repair-or-classify-owner-snapshot-gaps', 'current-head-repair-terminalize-exact-gap-v1'],
      ['install-schema31-runtime-guards', 'capacity-owner-identity-fail-close-v1'],
      ['verify-composed-schema31-state', 'owner-partition-accounting-fk-quick-v1'],
      ['lineage-receipt-commit', 'schema30-base-plus-schema31-extension-v1'],
    ],
  );
  assert.equal(PROJECT_DATABASE_MIGRATION_31.checksum, migrationChecksum(PROJECT_DATABASE_MIGRATION_31));
});

test('B2 fresh legacy fallback checkpoints 1-28 are ordered and share one rollback boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-ledger-checkpoints-'));
  try {
    const legacyBridge = PROJECT_DATABASE_MIGRATIONS.slice(0, LEGACY_BRIDGE_VERSION);
    for (const target of legacyBridge) {
      const directory = path.join(root, String(target.version));
      fs.mkdirSync(directory);
      const filename = path.join(directory, 'projects.sqlite3');
      const observed = [];
      assert.throws(
        () => new ProjectDatabase(filename, {
          autoBackup: false,
          beforeMigrationCommit(_database, version, migration, runtime) {
            observed.push([version, migration.name, runtime?.executionMode]);
            if (version === target.version) throw new Error(`b2-ledger-failure-${version}`);
          },
        }),
        new RegExp(`b2-ledger-failure-${target.version}`),
      );
      assert.deepEqual(
        observed,
        legacyBridge
          .slice(0, target.version)
          .map((migration) => [
            migration.version,
            migration.name,
            migration.version === PROJECT_DATABASE_MIGRATION_23.version
              ? 'legacy-fallback'
              : 'legacy-bridge',
          ]),
      );

      const raw = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
      try {
        assert.equal(raw.pragma('quick_check', { simple: true }), 'ok');
        assert.deepEqual(migrationVersions(raw), []);
        assert.equal(raw.prepare(`
          SELECT COUNT(*) AS count FROM sqlite_master
          WHERE type IN ('table', 'index', 'trigger', 'view')
            AND name NOT LIKE 'sqlite_%'
        `).get().count, 0);
      } finally {
        raw.close();
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('B2 executable v29 failure rolls back independently to the committed legacy bridge', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-ledger-v29-rollback-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const observed = [];
  try {
    assert.throws(
      () => new ProjectDatabase(filename, {
        autoBackup: false,
        beforeMigrationCommit(_database, version, migration) {
          observed.push([version, migration.name, migration.mode]);
          if (version === PROJECT_DATABASE_MIGRATION_29.version) {
            throw new Error('b2-ledger-failure-29');
          }
        },
      }),
      /b2-ledger-failure-29/,
    );
    assert.deepEqual(
      observed,
      PROJECT_DATABASE_MIGRATIONS
        .slice(0, PROJECT_DATABASE_MIGRATION_29.version)
        .map((migration) => [migration.version, migration.name, migration.mode]),
    );

    const raw = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(
        migrationVersions(raw),
        Array.from({ length: LEGACY_BRIDGE_VERSION }, (_, index) => index + 1),
      );
      assert.deepEqual(v29OwnedObjects(raw), []);
      assert.deepEqual(v30OwnedObjects(raw), []);
      assert.equal(raw.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(raw.pragma('foreign_key_check'), []);
    } finally {
      raw.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('B2 executable v30 failure rolls back independently to committed strict v29', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-ledger-v30-rollback-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const observed = [];
  try {
    assert.throws(
      () => new ProjectDatabase(filename, {
        autoBackup: false,
        beforeMigrationCommit(_database, version, migration) {
          observed.push([version, migration.name, migration.mode]);
          if (version === PROJECT_DATABASE_MIGRATION_30.version) {
            throw new Error('b2-ledger-failure-30');
          }
        },
      }),
      /b2-ledger-failure-30/,
    );
    assert.deepEqual(
      observed,
      PROJECT_DATABASE_MIGRATIONS
        .slice(0, PROJECT_DATABASE_MIGRATION_30.version)
        .map((migration) => [migration.version, migration.name, migration.mode]),
    );

    const raw = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(
        migrationVersions(raw),
        Array.from({ length: PROJECT_DATABASE_MIGRATION_29.version }, (_, index) => index + 1),
      );
      assert.equal(v29OwnedObjects(raw).length, PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES.length);
      assert.deepEqual(v30OwnedObjects(raw), []);
      assert.equal(raw.prepare(`
        SELECT COUNT(*) AS count FROM schema_migration_receipts WHERE version = ?
      `).get(PROJECT_DATABASE_MIGRATION_29.version).count, 1);
      assert.equal(raw.prepare(`
        SELECT COUNT(*) AS count FROM schema_migration_receipts WHERE version = ?
      `).get(PROJECT_DATABASE_MIGRATION_30.version).count, 0);
      assert.equal(raw.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(raw.pragma('foreign_key_check'), []);
    } finally {
      raw.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('B2 successful ledger application runs once and a second migrate is a no-op', () => {
  const observed = [];
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    beforeMigrationCommit(_database, version, migration) {
      observed.push([version, migration.name, migration.mode]);
    },
  });
  try {
    assert.deepEqual(
      observed,
      PROJECT_DATABASE_MIGRATIONS.map((migration) => [
        migration.version,
        migration.name,
        migration.mode,
      ]),
    );
    const ledgerBeforeNoOp = database.db.prepare(`
      SELECT version, applied_at FROM schema_migrations ORDER BY version ASC
    `).all();
    const receiptBeforeNoOp = database.db.prepare(`
      SELECT * FROM schema_migration_receipts ORDER BY version ASC
    `).all();
    database.migrate();
    assert.equal(observed.length, PROJECT_DATABASE_SCHEMA_VERSION);
    assert.deepEqual(
      database.db.prepare(`
        SELECT version, applied_at FROM schema_migrations ORDER BY version ASC
      `).all(),
      ledgerBeforeNoOp,
    );
    assert.deepEqual(database.db.prepare(`
      SELECT * FROM schema_migration_receipts ORDER BY version ASC
    `).all(), receiptBeforeNoOp);
  } finally {
    database.close();
  }
});

test('B2 v29/v30/v31/v32 receipts bind executable checksums and fast reopen is a no-op', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-ledger-v29-receipt-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const firstObserved = [];
  let database = null;
  try {
    database = new ProjectDatabase(filename, {
      autoBackup: false,
      beforeMigrationCommit(_database, version, migration) {
        firstObserved.push([version, migration.mode]);
      },
    });
    assert.deepEqual(
      firstObserved,
      PROJECT_DATABASE_MIGRATIONS.map((migration) => [migration.version, migration.mode]),
    );
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migration_receipts
    `).get().count, PROJECT_DATABASE_SCHEMA_VERSION - LEGACY_BRIDGE_VERSION);
    const receipt29 = database.db.prepare(`
      SELECT version, name, checksum, from_fingerprint, to_fingerprint,
             down_policy, applied_at
      FROM schema_migration_receipts WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_29.version);
    const receipt30 = database.db.prepare(`
      SELECT version, name, checksum, from_fingerprint, to_fingerprint,
             down_policy, applied_at
      FROM schema_migration_receipts WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_30.version);
    const receipt31 = database.db.prepare(`
      SELECT version, name, checksum, from_fingerprint, to_fingerprint,
             down_policy, applied_at
      FROM schema_migration_receipts WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_31.version);
    const receipt32 = database.db.prepare(`
      SELECT version, name, checksum, from_fingerprint, to_fingerprint,
             down_policy, applied_at
      FROM schema_migration_receipts WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_32.version);
    const ledger29 = database.db.prepare(`
      SELECT version, applied_at FROM schema_migrations WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_29.version);
    const ledger30 = database.db.prepare(`
      SELECT version, applied_at FROM schema_migrations WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_30.version);
    const ledger31 = database.db.prepare(`
      SELECT version, applied_at FROM schema_migrations WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_31.version);
    const ledger32 = database.db.prepare(`
      SELECT version, applied_at FROM schema_migrations WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_32.version);
    assert.equal(receipt29.version, PROJECT_DATABASE_MIGRATION_29.version);
    assert.equal(receipt29.name, PROJECT_DATABASE_MIGRATION_29.name);
    assert.equal(receipt29.checksum, migrationChecksum(PROJECT_DATABASE_MIGRATION_29));
    assert.equal(receipt29.checksum, PROJECT_DATABASE_MIGRATION_29.checksum);
    assert.equal(receipt29.down_policy, PROJECT_DATABASE_MIGRATION_29.downPolicy);
    assert.equal(receipt30.version, PROJECT_DATABASE_MIGRATION_30.version);
    assert.equal(receipt30.name, PROJECT_DATABASE_MIGRATION_30.name);
    assert.equal(receipt30.checksum, migrationChecksum(PROJECT_DATABASE_MIGRATION_30));
    assert.equal(receipt30.checksum, PROJECT_DATABASE_MIGRATION_30.checksum);
    assert.equal(receipt30.down_policy, PROJECT_DATABASE_MIGRATION_30.downPolicy);
    assert.equal(receipt30.from_fingerprint, receipt29.to_fingerprint);
    assert.equal(receipt31.version, PROJECT_DATABASE_MIGRATION_31.version);
    assert.equal(receipt31.name, PROJECT_DATABASE_MIGRATION_31.name);
    assert.equal(receipt31.checksum, migrationChecksum(PROJECT_DATABASE_MIGRATION_31));
    assert.equal(receipt31.checksum, PROJECT_DATABASE_MIGRATION_31.checksum);
    assert.equal(receipt31.down_policy, PROJECT_DATABASE_MIGRATION_31.downPolicy);
    assert.equal(receipt31.from_fingerprint, receipt30.to_fingerprint);
    assert.equal(receipt32.version, PROJECT_DATABASE_MIGRATION_32.version);
    assert.equal(receipt32.name, PROJECT_DATABASE_MIGRATION_32.name);
    assert.equal(receipt32.checksum, migrationChecksum(PROJECT_DATABASE_MIGRATION_32));
    assert.equal(receipt32.checksum, PROJECT_DATABASE_MIGRATION_32.checksum);
    assert.equal(receipt32.down_policy, PROJECT_DATABASE_MIGRATION_32.downPolicy);
    assert.equal(receipt32.from_fingerprint, receipt31.to_fingerprint);
    for (const receipt of [receipt29, receipt30, receipt31, receipt32]) {
      assert.match(receipt.from_fingerprint, /^[0-9a-f]{64}$/);
      assert.match(receipt.to_fingerprint, /^[0-9a-f]{64}$/);
      assert.notEqual(receipt.from_fingerprint, receipt.to_fingerprint);
    }
    assert.deepEqual(ledger29, {
      version: PROJECT_DATABASE_MIGRATION_29.version,
      applied_at: receipt29.applied_at,
    });
    assert.deepEqual(ledger30, {
      version: PROJECT_DATABASE_MIGRATION_30.version,
      applied_at: receipt30.applied_at,
    });
    assert.deepEqual(ledger31, {
      version: PROJECT_DATABASE_MIGRATION_31.version,
      applied_at: receipt31.applied_at,
    });
    assert.deepEqual(ledger32, {
      version: PROJECT_DATABASE_MIGRATION_32.version,
      applied_at: receipt32.applied_at,
    });
    await database.close();
    database = null;

    const reopenObserved = [];
    database = new ProjectDatabase(filename, {
      autoBackup: false,
      beforeMigrationCommit(_database, version, migration) {
        reopenObserved.push([version, migration.mode]);
      },
    });
    assert.deepEqual(reopenObserved, []);
    assert.deepEqual(database.db.prepare(`
      SELECT version, name, checksum, from_fingerprint, to_fingerprint,
             down_policy, applied_at
      FROM schema_migration_receipts WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_29.version), receipt29);
    assert.deepEqual(database.db.prepare(`
      SELECT version, name, checksum, from_fingerprint, to_fingerprint,
             down_policy, applied_at
      FROM schema_migration_receipts WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_30.version), receipt30);
    assert.deepEqual(database.db.prepare(`
      SELECT version, name, checksum, from_fingerprint, to_fingerprint,
             down_policy, applied_at
      FROM schema_migration_receipts WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_31.version), receipt31);
    assert.deepEqual(database.db.prepare(`
      SELECT version, name, checksum, from_fingerprint, to_fingerprint,
             down_policy, applied_at
      FROM schema_migration_receipts WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_32.version), receipt32);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    if (database) await database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('B2 schema-10 operation history receives its global identity before idempotency backfill', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-schema10-operation-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const canvasId = 'b2-schema10-operation-canvas';
  let database = null;
  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    const initial = database.ensureCanvas(canvasId, {
      nodes: [{ id: 'node-a', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    }, 'b2-schema10-operation-project');
    database.applyOperations(canvasId, [{
      opId: 'b2-schema10-operation-op',
      actorId: 'b2-schema10-actor',
      sessionId: 'b2-schema10-session',
      clientSeq: 1,
      type: 'node.move',
      payload: { nodeId: 'node-a', position: { x: 12, y: 34 } },
    }], { expectedRevision: initial.revision });
    await database.close();
    database = null;

    const legacy = new BetterSqlite3(filename);
    try {
      stripSchema31ForSchema30Test(legacy);
      legacy.exec(PROJECT_DATABASE_MIGRATION_30_DOWN_SQL);
      legacy.exec(PROJECT_DATABASE_MIGRATION_29_DOWN_SQL);
      legacy.exec(`
        DROP TRIGGER trg_canvas_operation_global_identity_insert;
        DROP TRIGGER trg_domain_operation_global_identity_insert;
        DROP TRIGGER trg_text_operation_global_identity_insert;
        DROP TRIGGER trg_run_output_commit_global_identity_insert;
        DELETE FROM canvas_operation_idempotency;
        DELETE FROM collaboration_operation_identities;
        DELETE FROM schema_migrations WHERE version >= 11;
      `);
      assert.equal(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 10);
      assert.equal(legacy.prepare('SELECT COUNT(*) AS count FROM canvas_operations').get().count, 1);
      assert.deepEqual(v29OwnedObjects(legacy), []);
    } finally {
      legacy.close();
    }
    fs.rmSync(`${filename}.pre-migration-v30.sqlite3`, { force: true });

    database = new ProjectDatabase(filename, { autoBackup: false });
    assert.deepEqual(
      database.db.prepare(`
        SELECT identity.project_id, identity.canvas_id, identity.domain, identity.type,
               identity.identity_digest, idempotency.payload_digest
        FROM collaboration_operation_identities identity
        JOIN canvas_operation_idempotency idempotency ON idempotency.op_id = identity.op_id
        WHERE identity.op_id = ?
      `).get('b2-schema10-operation-op'),
      {
        project_id: 'b2-schema10-operation-project',
        canvas_id: canvasId,
        domain: 'canvas',
        type: 'node.move',
        identity_digest: database.db.prepare(`
          SELECT payload_digest FROM canvas_operation_idempotency WHERE op_id = ?
        `).get('b2-schema10-operation-op').payload_digest,
        payload_digest: database.db.prepare(`
          SELECT payload_digest FROM canvas_operation_idempotency WHERE op_id = ?
        `).get('b2-schema10-operation-op').payload_digest,
      },
    );
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, PROJECT_DATABASE_SCHEMA_VERSION);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
  } finally {
    if (database) await database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('B2 isolated schema30 then schema29 DOWN are explicit offline, empty-only, exact, and can upgrade again', () => {
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    allowOfflineSchemaMigrationDown: true,
  });
  try {
    stripSchema31ForSchema30Test(database.db);
    assert.throws(
      () => database.migrateSchema29Down(),
      (error) => error?.code === 'project_database_migration_down_offline_required'
        && error?.status === 409,
    );
    assert.throws(
      () => database.migrateSchema29Down({ offline: true }),
      (error) => error?.code === 'project_database_migration_down_version_mismatch'
        && error?.status === 409
        && error?.details?.expectedVersion === PROJECT_DATABASE_MIGRATION_29.version
        && error?.details?.actualVersion === PROJECT_DATABASE_MIGRATION_30.version,
    );

    const manifest29 = database.migrateSchema30Down({ offline: true });
    assert.match(manifest29.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      migrationVersions(database.db),
      Array.from({ length: PROJECT_DATABASE_MIGRATION_29.version }, (_, index) => index + 1),
    );
    assert.equal(v29OwnedObjects(database.db).length, PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES.length);
    assert.deepEqual(v30OwnedObjects(database.db), []);

    const manifest28 = database.migrateSchema29Down({ offline: true });
    assert.match(manifest28.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      migrationVersions(database.db),
      Array.from({ length: LEGACY_BRIDGE_VERSION }, (_, index) => index + 1),
    );
    assert.deepEqual(v29OwnedObjects(database.db), []);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    database.migrate();
    assert.equal(migrationVersions(database.db).at(-1), PROJECT_DATABASE_SCHEMA_VERSION);
    assert.equal(v29OwnedObjects(database.db).length, PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES.length);
    assert.equal(v30OwnedObjects(database.db).length, PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES.length);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migration_receipts WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_29.version).count, 1);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migration_receipts WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_30.version).count, 1);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migration_receipts WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_31.version).count, 1);
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});

test('B2 schema30 DOWN refuses populated permanent-ledger state atomically and requires backup', () => {
  const database = new ProjectDatabase(':memory:', {
    autoBackup: false,
    allowOfflineSchemaMigrationDown: true,
  });
  try {
    database.ensureCanvas('b2-schema29-down-populated', {
      nodes: [],
      edges: [],
    }, 'b2-schema29-down-project');
    stripSchema31ForSchema30Test(database.db);
    const before = {
      versions: migrationVersions(database.db),
      ownedObjects: v29OwnedObjects(database.db),
      receipt: database.db.prepare(`
        SELECT * FROM schema_migration_receipts WHERE version = ?
      `).get(PROJECT_DATABASE_MIGRATION_30.version),
      canvasCount: database.db.prepare('SELECT COUNT(*) AS count FROM canvas_documents').get().count,
    };

    assert.throws(
      () => database.migrateSchema30Down({ offline: true }),
      (error) => error?.code === 'project_database_migration_down_requires_backup'
        && error?.status === 409
        && Number(error?.details?.canvasDocuments) === 1,
    );

    assert.deepEqual({
      versions: migrationVersions(database.db),
      ownedObjects: v29OwnedObjects(database.db),
      receipt: database.db.prepare(`
        SELECT * FROM schema_migration_receipts WHERE version = ?
      `).get(PROJECT_DATABASE_MIGRATION_30.version),
      canvasCount: database.db.prepare('SELECT COUNT(*) AS count FROM canvas_documents').get().count,
    }, before);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});
