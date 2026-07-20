const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BetterSqlite3 = require('better-sqlite3');
const {
  PROJECT_DATABASE_MIGRATION_30,
  PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES,
} = require('../backend/src/services/projectDatabaseMigration30');
const {
  PROJECT_DATABASE_MIGRATION_31,
  PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES,
} = require('../backend/src/services/projectDatabaseMigration31');
const {
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');

const MIGRATION_31_CHECKPOINTS = Object.freeze([
  'after-from-verify',
  'after-ddl',
  'after-backfill',
  'after-to-verify',
  'after-ledger',
  'after-receipt',
  'before-commit',
]);

function databaseOptions(preMigration31BackupFilename) {
  return {
    autoBackup: false,
    preMigrationBackup: false,
    preMigration30Backup: false,
    preMigration31BackupFilename,
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
    FROM schema_migration_receipts WHERE version = ?
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
    SELECT name FROM sqlite_master
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
    SELECT name FROM sqlite_master
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

function captureExactSchema30(database) {
  assert.deepEqual(
    migrationVersions(database),
    Array.from({ length: PROJECT_DATABASE_MIGRATION_30.version }, (_, index) => index + 1),
  );
  assert.equal(
    ownedObjectNames(database, PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES).length,
    PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES.length,
  );
  assert.deepEqual(
    ownedObjectNames(database, PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES),
    [],
  );
  const receipt = migrationReceipt(database, PROJECT_DATABASE_MIGRATION_30.version);
  assert.ok(receipt);
  assert.match(receipt.to_fingerprint, /^[0-9a-f]{64}$/);
  assertIntegrity(database);
  return {
    receipt,
    schemaObjects: schemaObjects(database),
    logicalSnapshot: logicalDatabaseSnapshot(database),
  };
}

function assertExactSchema30(database, expected) {
  assert.deepEqual(
    migrationVersions(database),
    Array.from({ length: PROJECT_DATABASE_MIGRATION_30.version }, (_, index) => index + 1),
  );
  assert.deepEqual(
    migrationReceipt(database, PROJECT_DATABASE_MIGRATION_30.version),
    expected.receipt,
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count FROM schema_migration_receipts WHERE version = ?
    `).get(PROJECT_DATABASE_MIGRATION_31.version).count,
    0,
  );
  assert.equal(
    ownedObjectNames(database, PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES).length,
    PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES.length,
  );
  assert.deepEqual(
    ownedObjectNames(database, PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES),
    [],
  );
  assert.deepEqual(schemaObjects(database), expected.schemaObjects);
  assert.deepEqual(logicalDatabaseSnapshot(database), expected.logicalSnapshot);
  assertIntegrity(database);
}

function assertCompleteSchema31(
  database,
  exactSchema30,
  expectedSchemaVersion = PROJECT_DATABASE_SCHEMA_VERSION,
) {
  assert.deepEqual(
    migrationVersions(database),
    Array.from({ length: expectedSchemaVersion }, (_, index) => index + 1),
  );
  assert.equal(
    ownedObjectNames(database, PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES).length,
    PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES.length,
  );
  assert.deepEqual(
    ownedObjectNames(database, PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES),
    [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES].sort(),
  );
  const receipt = migrationReceipt(database, PROJECT_DATABASE_MIGRATION_31.version);
  assert.ok(receipt);
  assert.equal(receipt.name, PROJECT_DATABASE_MIGRATION_31.name);
  assert.equal(receipt.checksum, PROJECT_DATABASE_MIGRATION_31.checksum);
  assert.equal(receipt.from_fingerprint, exactSchema30.receipt.to_fingerprint);
  assert.match(receipt.to_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(receipt.down_policy, PROJECT_DATABASE_MIGRATION_31.downPolicy);
  assert.equal(Number.isSafeInteger(Number(receipt.applied_at)), true);
  assertIntegrity(database);
  return receipt;
}

function crashSchema31Migration({
  filename,
  backupFilename,
  markerFilename,
  phase,
}) {
  const childScript = String.raw`
    const fs = require('node:fs');
    const { ProjectDatabase } = require(process.env.T8_PROJECT_DATABASE_MODULE);

    function writeMarker(event) {
      const marker = fs.openSync(process.env.T8_MIGRATION_MARKER, 'w');
      try {
        fs.writeFileSync(marker, JSON.stringify(event), 'utf8');
        fs.fsyncSync(marker);
      } finally {
        fs.closeSync(marker);
      }
    }

    const database = new ProjectDatabase(process.env.T8_MIGRATION_DATABASE, {
      autoBackup: false,
      preMigrationBackup: false,
      preMigration30Backup: false,
      preMigration31BackupFilename: process.env.T8_MIGRATION_BACKUP,
      beforeExecutableMigrationPhase(_database, event) {
        if (process.env.T8_MIGRATION_CRASH_PHASE === 'after-commit-control') return;
        if (event.version === 31
          && event.phase === process.env.T8_MIGRATION_CRASH_PHASE) {
          writeMarker(event);
          process.exit(91);
        }
      },
      afterExecutableMigrationCommit(_database, event) {
        if (process.env.T8_MIGRATION_CRASH_PHASE === 'after-commit-control'
          && event.version === 31) {
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
    timeout: 60_000,
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
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(directory);
  assert.equal(
    resolved.startsWith(`${temporaryRoot}${path.sep}`),
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

test('B2 schema31 hard exits preserve an exact v30/v31 boundary and mandatory recovery point', {
  timeout: 600_000,
}, async (t) => {
  assert.equal(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATION_31.version + 1);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-schema31-crash-checkpoints-'));
  const seedFilename = path.join(root, 'seed-current.sqlite3');
  const exactSchema30Filename = path.join(root, 'seed-exact-v30.sqlite3');
  let seed = null;
  let exactSchema30;
  try {
    seed = new ProjectDatabase(seedFilename, databaseOptions(exactSchema30Filename));
    assert.equal(
      migrationVersions(seed.db).at(-1),
      PROJECT_DATABASE_SCHEMA_VERSION,
    );
    await seed.close();
    seed = null;
    assert.equal(fs.existsSync(exactSchema30Filename), true);

    const source = new BetterSqlite3(exactSchema30Filename, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      exactSchema30 = captureExactSchema30(source);
    } finally {
      source.close();
    }

    for (const [checkpointIndex, phase] of MIGRATION_31_CHECKPOINTS.entries()) {
      await t.test(phase, { timeout: 90_000 }, async () => {
        const directory = path.join(root, `checkpoint-${checkpointIndex}-${phase}`);
        fs.mkdirSync(directory);
        const filename = path.join(directory, 'projects.sqlite3');
        const backupFilename = `${filename}.pre-migration-v30.sqlite3`;
        const markerFilename = path.join(directory, 'migration-crash-marker.json');
        let database = null;
        try {
          fs.copyFileSync(
            exactSchema30Filename,
            filename,
            fs.constants.COPYFILE_EXCL,
          );
          const crashed = crashSchema31Migration({
            filename,
            backupFilename,
            markerFilename,
            phase,
          });
          assert.equal(crashed.status, 91, childFailure(crashed, `schema31 ${phase}`));
          assert.equal(crashed.signal, null);
          const marker = JSON.parse(fs.readFileSync(markerFilename, 'utf8'));
          assert.equal(marker.version, PROJECT_DATABASE_MIGRATION_31.version);
          assert.equal(marker.name, PROJECT_DATABASE_MIGRATION_31.name);
          assert.equal(marker.phase, phase);
          assert.equal(fs.existsSync(backupFilename), true);

          const primaryAfterCrash = new BetterSqlite3(filename);
          const backupAfterCrash = new BetterSqlite3(backupFilename, {
            readonly: true,
            fileMustExist: true,
          });
          try {
            assertExactSchema30(primaryAfterCrash, exactSchema30);
            assertExactSchema30(backupAfterCrash, exactSchema30);
          } finally {
            primaryAfterCrash.close();
            backupAfterCrash.close();
          }

          database = new ProjectDatabase(filename, databaseOptions(backupFilename));
          assertCompleteSchema31(database.db, exactSchema30);
          await database.close();
          database = null;

          database = new ProjectDatabase(filename, databaseOptions(backupFilename));
          assertCompleteSchema31(database.db, exactSchema30);
          await database.close();
          database = null;

          const finalBackup = new BetterSqlite3(backupFilename, {
            readonly: true,
            fileMustExist: true,
          });
          try {
            assertExactSchema30(finalBackup, exactSchema30);
          } finally {
            finalBackup.close();
          }
        } finally {
          await closeQuietly(database);
          removeTemporaryDirectory(directory);
        }
      });
    }

    await t.test('after-commit-control', { timeout: 90_000 }, async () => {
      const directory = path.join(root, 'after-commit-control');
      fs.mkdirSync(directory);
      const filename = path.join(directory, 'projects.sqlite3');
      const backupFilename = `${filename}.pre-migration-v30.sqlite3`;
      const markerFilename = path.join(directory, 'migration-crash-marker.json');
      let database = null;
      try {
        fs.copyFileSync(
          exactSchema30Filename,
          filename,
          fs.constants.COPYFILE_EXCL,
        );
        const crashed = crashSchema31Migration({
          filename,
          backupFilename,
          markerFilename,
          phase: 'after-commit-control',
        });
        assert.equal(
          crashed.status,
          93,
          childFailure(crashed, 'schema31 after-commit-control'),
        );
        assert.equal(crashed.signal, null);
        const marker = JSON.parse(fs.readFileSync(markerFilename, 'utf8'));
        assert.equal(marker.phase, 'after-commit-control');
        assert.equal(marker.committedVersion, PROJECT_DATABASE_MIGRATION_31.version);
        assert.equal(marker.name, PROJECT_DATABASE_MIGRATION_31.name);
        assert.equal(marker.fromFingerprint, exactSchema30.receipt.to_fingerprint);
        assert.match(marker.toFingerprint, /^[0-9a-f]{64}$/);
        assert.equal(fs.existsSync(backupFilename), true);

        const primaryAfterCommit = new BetterSqlite3(filename);
        const backupAfterCommit = new BetterSqlite3(backupFilename, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          const receipt = assertCompleteSchema31(
            primaryAfterCommit,
            exactSchema30,
            PROJECT_DATABASE_MIGRATION_31.version,
          );
          assert.equal(receipt.to_fingerprint, marker.toFingerprint);
          assertExactSchema30(backupAfterCommit, exactSchema30);
        } finally {
          primaryAfterCommit.close();
          backupAfterCommit.close();
        }

        database = new ProjectDatabase(filename, databaseOptions(backupFilename));
        const coldReceipt = assertCompleteSchema31(database.db, exactSchema30);
        assert.equal(coldReceipt.to_fingerprint, marker.toFingerprint);
        await database.close();
        database = null;

        const finalBackup = new BetterSqlite3(backupFilename, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          assertExactSchema30(finalBackup, exactSchema30);
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
