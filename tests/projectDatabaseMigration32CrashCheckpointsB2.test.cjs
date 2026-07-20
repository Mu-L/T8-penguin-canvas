'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BetterSqlite3 = require('better-sqlite3');
const {
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');
const {
  PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
} = require('../backend/src/services/projectDatabaseMigration23');
const {
  PROJECT_DATABASE_MIGRATION_31,
  PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES,
} = require('../backend/src/services/projectDatabaseMigration31');
const {
  PROJECT_DATABASE_MIGRATION_32,
  PROJECT_DATABASE_MIGRATION_32_HARD_EXIT_CHECKPOINTS,
  PROJECT_DATABASE_SCHEMA_32_ACCEPTED_SCHEMA_31_FINGERPRINTS,
  PROJECT_DATABASE_SCHEMA_32_LINEAGE,
  PROJECT_DATABASE_SCHEMA_32_LINEAGE_DIGEST,
  PROJECT_DATABASE_SCHEMA_32_OWNED_OBJECT_NAMES,
} = require('../backend/src/services/projectDatabaseMigration32');
const {
  inspectProjectDatabaseSchemaManifest,
} = require('./helpers/projectDatabaseSchemaManifest.cjs');

function databaseOptions(preMigration32BackupFilename) {
  return {
    autoBackup: false,
    preMigrationBackup: false,
    preMigration30Backup: false,
    preMigration32BackupFilename,
  };
}

function migrationVersions(database) {
  return database.prepare(`
    SELECT version FROM schema_migrations ORDER BY version ASC
  `).all().map((row) => Number(row.version));
}

function migrationReceipt(database, version) {
  return database.prepare(`
    SELECT version, name, checksum, from_fingerprint, to_fingerprint,
           down_policy, applied_at
    FROM schema_migration_receipts
    WHERE version = ?
  `).get(Number(version)) || null;
}

function schemaObjects(database) {
  return database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type ASC, name ASC
  `).all();
}

function ownedObjectNames(database, expectedNames) {
  const expected = new Set(expectedNames);
  return database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC
  `).all()
    .map((row) => String(row.name))
    .filter((name) => expected.has(name));
}

function normalizeSqlValue(value) {
  if (Buffer.isBuffer(value)) return { blobHex: value.toString('hex') };
  return value;
}

function logicalDatabaseSnapshot(database) {
  const tables = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC
  `).all().map((row) => String(row.name));
  return {
    userVersion: Number(database.pragma('user_version', { simple: true })),
    applicationId: Number(database.pragma('application_id', { simple: true })),
    tables: tables.map((tableName) => {
      const quotedName = `"${tableName.replaceAll('"', '""')}"`;
      const rows = database.prepare(`SELECT * FROM ${quotedName}`).all()
        .map((row) => Object.fromEntries(Object.entries(row).map(
          ([key, value]) => [key, normalizeSqlValue(value)],
        )))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      return { tableName, rows };
    }),
  };
}

function assertIntegrity(database) {
  assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
}

function schema31Manifest(database) {
  return inspectProjectDatabaseSchemaManifest(database, {
    descriptorVersion: PROJECT_DATABASE_MIGRATION_31.version,
    excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
  });
}

function schema32Manifest(database) {
  return inspectProjectDatabaseSchemaManifest(database, {
    descriptorVersion: PROJECT_DATABASE_MIGRATION_32.version,
    excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
  });
}

function captureExactSchema31(database) {
  assert.deepEqual(
    migrationVersions(database),
    Array.from({ length: PROJECT_DATABASE_MIGRATION_31.version }, (_, index) => index + 1),
  );
  assert.deepEqual(
    ownedObjectNames(database, PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES),
    [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES].sort(),
  );
  assert.deepEqual(ownedObjectNames(database, PROJECT_DATABASE_SCHEMA_32_OWNED_OBJECT_NAMES), []);
  const receipt = migrationReceipt(database, PROJECT_DATABASE_MIGRATION_31.version);
  const manifest = schema31Manifest(database);
  assert.ok(receipt);
  assert.equal(receipt.name, PROJECT_DATABASE_MIGRATION_31.name);
  assert.equal(receipt.checksum, PROJECT_DATABASE_MIGRATION_31.checksum);
  assert.equal(receipt.to_fingerprint, manifest.fingerprint);
  assert.equal(
    PROJECT_DATABASE_SCHEMA_32_ACCEPTED_SCHEMA_31_FINGERPRINTS.includes(manifest.fingerprint),
    true,
  );
  assertIntegrity(database);
  return Object.freeze({
    receipt,
    manifest,
    schemaObjects: schemaObjects(database),
    logicalSnapshot: logicalDatabaseSnapshot(database),
  });
}

function assertExactSchema31(database, expected) {
  assert.deepEqual(
    migrationVersions(database),
    Array.from({ length: PROJECT_DATABASE_MIGRATION_31.version }, (_, index) => index + 1),
  );
  assert.deepEqual(
    migrationReceipt(database, PROJECT_DATABASE_MIGRATION_31.version),
    expected.receipt,
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count FROM schema_migration_receipts WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_32.version).count,
    0,
  );
  assert.deepEqual(
    ownedObjectNames(database, PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES),
    [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES].sort(),
  );
  assert.deepEqual(ownedObjectNames(database, PROJECT_DATABASE_SCHEMA_32_OWNED_OBJECT_NAMES), []);
  assert.equal(schema31Manifest(database).fingerprint, expected.manifest.fingerprint);
  assert.deepEqual(schemaObjects(database), expected.schemaObjects);
  assert.deepEqual(logicalDatabaseSnapshot(database), expected.logicalSnapshot);
  assertIntegrity(database);
}

function assertCompleteSchema32(database, exactSchema31) {
  assert.deepEqual(
    migrationVersions(database),
    Array.from({ length: PROJECT_DATABASE_MIGRATION_32.version }, (_, index) => index + 1),
  );
  assert.deepEqual(
    ownedObjectNames(database, PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES),
    [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES].sort(),
  );
  assert.deepEqual(
    ownedObjectNames(database, PROJECT_DATABASE_SCHEMA_32_OWNED_OBJECT_NAMES),
    [...PROJECT_DATABASE_SCHEMA_32_OWNED_OBJECT_NAMES].sort(),
  );
  const receipt = migrationReceipt(database, PROJECT_DATABASE_MIGRATION_32.version);
  const targetManifest = schema32Manifest(database);
  assert.ok(receipt);
  assert.deepEqual(receipt, {
    version: PROJECT_DATABASE_MIGRATION_32.version,
    name: PROJECT_DATABASE_MIGRATION_32.name,
    checksum: PROJECT_DATABASE_MIGRATION_32.checksum,
    from_fingerprint: exactSchema31.manifest.fingerprint,
    to_fingerprint: targetManifest.fingerprint,
    down_policy: PROJECT_DATABASE_MIGRATION_32.downPolicy,
    applied_at: receipt.applied_at,
  });
  const identityRows = database.prepare(`
    SELECT singleton_id, database_uuid, recovery_generation, write_sequence,
           schema_version, schema_lineage, schema_lineage_digest,
           created_at, updated_at
    FROM project_database_identity
  `).all();
  assert.equal(identityRows.length, 1);
  assert.equal(identityRows[0].singleton_id, 1);
  assert.equal(identityRows[0].schema_version, PROJECT_DATABASE_MIGRATION_32.version);
  assert.equal(identityRows[0].schema_lineage, PROJECT_DATABASE_SCHEMA_32_LINEAGE);
  assert.equal(identityRows[0].schema_lineage_digest, PROJECT_DATABASE_SCHEMA_32_LINEAGE_DIGEST);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM project_database_storage_policy').get().count,
    1,
  );
  assertIntegrity(database);
  return receipt;
}

function crashSchema32Migration({ filename, backupFilename, markerFilename, phase }) {
  const childScript = String.raw`
    const fs = require('node:fs');
    const { ProjectDatabase } = require(process.env.T8_PROJECT_DATABASE_MODULE);

    function writeMarker(event) {
      const descriptor = fs.openSync(process.env.T8_MIGRATION_MARKER, 'w');
      try {
        fs.writeFileSync(descriptor, JSON.stringify(event), 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }

    const database = new ProjectDatabase(process.env.T8_MIGRATION_DATABASE, {
      autoBackup: false,
      preMigrationBackup: false,
      preMigration30Backup: false,
      preMigration32BackupFilename: process.env.T8_MIGRATION_BACKUP,
      beforeExecutableMigrationPhase(_database, event) {
        if (process.env.T8_MIGRATION_CRASH_PHASE === 'after-commit-control') return;
        if (event.version === 32
          && event.phase === process.env.T8_MIGRATION_CRASH_PHASE) {
          writeMarker(event);
          process.exit(91);
        }
      },
      afterExecutableMigrationCommit(_database, event) {
        if (process.env.T8_MIGRATION_CRASH_PHASE === 'after-commit-control'
          && event.version === 32) {
          writeMarker({
            phase: 'after-commit-control',
            committedVersion: event.version,
            name: event.name,
            fromFingerprint: event.fromFingerprint,
            toFingerprint: event.toFingerprint,
          });
          process.exit(93);
        }
      },
    });
    database.close();
    process.exit(92);
  `;
  return spawnSync(process.execPath, ['-e', childScript], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      T8_PROJECT_DATABASE_MODULE: path.resolve(
        __dirname,
        '../backend/src/services/projectDatabase.js',
      ),
      T8_MIGRATION_DATABASE: filename,
      T8_MIGRATION_BACKUP: backupFilename,
      T8_MIGRATION_MARKER: markerFilename,
      T8_MIGRATION_CRASH_PHASE: phase,
    },
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function childFailure(result, boundary) {
  return `${boundary} did not terminate at the injected boundary: ${
    result.error?.message || result.stderr || result.stdout || `status=${result.status}`
  }`;
}

async function closeQuietly(database) {
  if (!database) return;
  try { await database.close(); } catch (_) {}
}

function removeTemporaryDirectory(directory) {
  const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  const resolved = path.resolve(directory);
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

test('B2 schema32 hard exits preserve an exact v31/v32 boundary and mandatory recovery point', {
  timeout: 900_000,
}, async (t) => {
  assert.equal(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATION_32.version);
  assert.deepEqual(PROJECT_DATABASE_MIGRATION_32_HARD_EXIT_CHECKPOINTS, [
    'after-from-verify',
    'after-ddl',
    'after-backfill',
    'after-to-verify',
    'after-ledger',
    'after-receipt',
    'before-commit',
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-schema32-crash-checkpoints-'));
  const seedFilename = path.join(root, 'seed-current.sqlite3');
  const exactSchema31Filename = path.join(root, 'seed-exact-v31.sqlite3');
  let seed = null;
  let exactSchema31;
  try {
    seed = new ProjectDatabase(seedFilename, databaseOptions(exactSchema31Filename));
    assert.equal(migrationVersions(seed.db).at(-1), PROJECT_DATABASE_MIGRATION_32.version);
    await seed.close();
    seed = null;
    assert.equal(fs.existsSync(exactSchema31Filename), true);

    const source = new BetterSqlite3(exactSchema31Filename, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      exactSchema31 = captureExactSchema31(source);
    } finally {
      source.close();
    }

    for (const [checkpointIndex, phase] of PROJECT_DATABASE_MIGRATION_32_HARD_EXIT_CHECKPOINTS.entries()) {
      await t.test(phase, { timeout: 120_000 }, async () => {
        const directory = path.join(root, `checkpoint-${checkpointIndex}-${phase}`);
        fs.mkdirSync(directory);
        const filename = path.join(directory, 'projects.sqlite3');
        const backupFilename = `${filename}.pre-migration-v31.sqlite3`;
        const markerFilename = path.join(directory, 'migration-crash-marker.json');
        let database = null;
        try {
          fs.copyFileSync(exactSchema31Filename, filename, fs.constants.COPYFILE_EXCL);
          const crashed = crashSchema32Migration({
            filename,
            backupFilename,
            markerFilename,
            phase,
          });
          assert.equal(crashed.status, 91, childFailure(crashed, `schema32 ${phase}`));
          assert.equal(crashed.signal, null);
          const marker = JSON.parse(fs.readFileSync(markerFilename, 'utf8'));
          assert.equal(marker.version, PROJECT_DATABASE_MIGRATION_32.version);
          assert.equal(marker.name, PROJECT_DATABASE_MIGRATION_32.name);
          assert.equal(marker.phase, phase);
          assert.equal(fs.existsSync(backupFilename), true);

          const primaryAfterCrash = new BetterSqlite3(filename);
          const backupAfterCrash = new BetterSqlite3(backupFilename, {
            readonly: true,
            fileMustExist: true,
          });
          try {
            assertExactSchema31(primaryAfterCrash, exactSchema31);
            assertExactSchema31(backupAfterCrash, exactSchema31);
          } finally {
            primaryAfterCrash.close();
            backupAfterCrash.close();
          }

          database = new ProjectDatabase(filename, databaseOptions(backupFilename));
          assertCompleteSchema32(database.db, exactSchema31);
          await database.close();
          database = null;

          database = new ProjectDatabase(filename, databaseOptions(backupFilename));
          assertCompleteSchema32(database.db, exactSchema31);
          await database.close();
          database = null;

          const finalBackup = new BetterSqlite3(backupFilename, {
            readonly: true,
            fileMustExist: true,
          });
          try {
            assertExactSchema31(finalBackup, exactSchema31);
          } finally {
            finalBackup.close();
          }
        } finally {
          await closeQuietly(database);
          removeTemporaryDirectory(directory);
        }
      });
    }

    await t.test('after-commit-control', { timeout: 120_000 }, async () => {
      const directory = path.join(root, 'after-commit-control');
      fs.mkdirSync(directory);
      const filename = path.join(directory, 'projects.sqlite3');
      const backupFilename = `${filename}.pre-migration-v31.sqlite3`;
      const markerFilename = path.join(directory, 'migration-crash-marker.json');
      let database = null;
      try {
        fs.copyFileSync(exactSchema31Filename, filename, fs.constants.COPYFILE_EXCL);
        const crashed = crashSchema32Migration({
          filename,
          backupFilename,
          markerFilename,
          phase: 'after-commit-control',
        });
        assert.equal(
          crashed.status,
          93,
          childFailure(crashed, 'schema32 after-commit-control'),
        );
        assert.equal(crashed.signal, null);
        const marker = JSON.parse(fs.readFileSync(markerFilename, 'utf8'));
        assert.equal(marker.phase, 'after-commit-control');
        assert.equal(marker.committedVersion, PROJECT_DATABASE_MIGRATION_32.version);
        assert.equal(marker.name, PROJECT_DATABASE_MIGRATION_32.name);
        assert.equal(marker.fromFingerprint, exactSchema31.manifest.fingerprint);
        assert.match(marker.toFingerprint, /^[0-9a-f]{64}$/);
        assert.equal(fs.existsSync(backupFilename), true);

        const primaryAfterCommit = new BetterSqlite3(filename);
        const backupAfterCommit = new BetterSqlite3(backupFilename, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          const receipt = assertCompleteSchema32(primaryAfterCommit, exactSchema31);
          assert.equal(receipt.to_fingerprint, marker.toFingerprint);
          assertExactSchema31(backupAfterCommit, exactSchema31);
        } finally {
          primaryAfterCommit.close();
          backupAfterCommit.close();
        }

        database = new ProjectDatabase(filename, databaseOptions(backupFilename));
        const coldReceipt = assertCompleteSchema32(database.db, exactSchema31);
        assert.equal(coldReceipt.to_fingerprint, marker.toFingerprint);
        await database.close();
        database = null;

        const finalBackup = new BetterSqlite3(backupFilename, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          assertExactSchema31(finalBackup, exactSchema31);
        } finally {
          finalBackup.close();
        }
      } finally {
        await closeQuietly(database);
        removeTemporaryDirectory(directory);
      }
    });
  } finally {
    await closeQuietly(seed);
    removeTemporaryDirectory(root);
  }
});
