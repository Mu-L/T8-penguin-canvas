'use strict';

// TEMP-only source-lineage probe. It never opens a retained project database:
// v2.5.6 creates a new schema22 database, the current core source applies its
// prerelease CREATE/ADD COLUMN history, and the release worktree upgrades that
// synthetic file through the current executable chain.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const coreProjectDatabase = path.resolve(
  root,
  '..',
  'T8-penguin-canvas',
  'backend',
  'src',
  'services',
  'projectDatabase.js',
);

function compileProjectDatabase(source, suffix) {
  const filename = path.join(root, 'backend', 'src', 'services', 'projectDatabase.js');
  const loaded = new Module(`${filename}#${suffix}`, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(source, filename);
  return loaded.exports;
}

async function closeDatabase(database) {
  const result = database?.close();
  if (result && typeof result.then === 'function') await result;
}

async function main() {
  const historicalSource = childProcess.execFileSync(
    'git',
    [
      '-c',
      'safe.directory=E:/PenguinPravite/T8-penguin-canvas-release-2.5.7',
      'show',
      'v2.5.6:backend/src/services/projectDatabase.js',
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  const historical = compileProjectDatabase(historicalSource, 'v2.5.6');
  const core = compileProjectDatabase(
    fs.readFileSync(coreProjectDatabase, 'utf8'),
    'current-core-source',
  );
  const current = require('../backend/src/services/projectDatabase');
  const BetterSqlite3 = require('better-sqlite3');
  const {
    PROJECT_DATABASE_MIGRATION_32_CREATE_SQL,
    PROJECT_DATABASE_MIGRATION_32_RUNTIME_GUARDS_SQL,
  } = require('../backend/src/services/projectDatabaseMigration32');
  const {
    PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
  } = require('../backend/src/services/projectDatabaseMigration23');
  const {
    inspectProjectDatabaseSchemaManifest,
  } = require('../tests/helpers/projectDatabaseSchemaManifest.cjs');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-schema32-core-source-probe-'));
  const filename = path.join(directory, 'project.sqlite3');
  let database = null;
  try {
    database = new historical.ProjectDatabase(filename, { autoBackup: false });
    await closeDatabase(database);
    database = null;

    database = new core.ProjectDatabase(filename, { autoBackup: false });
    await closeDatabase(database);
    database = null;

    database = new current.ProjectDatabase(filename, {
      autoBackup: false,
      preMigrationBackup: false,
      preMigration30Backup: false,
    });
    await closeDatabase(database);
    database = null;

    const raw = new BetterSqlite3(filename);
    try {
      const schema31 = inspectProjectDatabaseSchemaManifest(raw, {
        descriptorVersion: 31,
        excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
      });
      raw.exec(PROJECT_DATABASE_MIGRATION_32_CREATE_SQL);
      raw.exec(PROJECT_DATABASE_MIGRATION_32_RUNTIME_GUARDS_SQL);
      const schema32 = inspectProjectDatabaseSchemaManifest(raw, {
        descriptorVersion: 32,
        excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
      });
      process.stdout.write(`${JSON.stringify({
        source: 'v2.5.6-fresh-then-current-core-source-then-current-release-chain',
        schema31Fingerprint: schema31.fingerprint,
        schema32Fingerprint: schema32.fingerprint,
      }, null, 2)}\n`);
    } finally {
      raw.close();
    }
  } finally {
    await closeDatabase(database);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
