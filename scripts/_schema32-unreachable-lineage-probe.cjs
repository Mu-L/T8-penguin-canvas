'use strict';

// TEMP-only probe for historical ProjectDatabase source blobs recovered from
// Git object storage. It creates synthetic databases only and never opens a
// retained database.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const SOURCE_BLOBS = Object.freeze([
  '911bb67dc8afd4b5a176ffcec42c3e6636d37984',
  '5f34adb06fbcf0b74b1c11c718c072fa25ce34cf',
]);

function gitText(...args) {
  return childProcess.execFileSync(
    'git',
    ['-c', 'safe.directory=E:/PenguinPravite/T8-penguin-canvas-release-2.5.7', ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
}

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

async function runSequence(label, modules) {
  const BetterSqlite3 = require('better-sqlite3');
  const current = require('../backend/src/services/projectDatabase');
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

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-schema32-unreachable-probe-'));
  const filename = path.join(directory, 'project.sqlite3');
  let database = null;
  try {
    for (const sourceModule of modules) {
      database = new sourceModule.ProjectDatabase(filename, { autoBackup: false });
      await closeDatabase(database);
      database = null;
    }
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
      return { label, schema31: schema31.fingerprint, schema32: schema32.fingerprint };
    } finally {
      raw.close();
    }
  } finally {
    await closeDatabase(database);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

async function main() {
  const v256 = compileProjectDatabase(
    gitText('show', 'v2.5.6:backend/src/services/projectDatabase.js'),
    'v2.5.6',
  );
  const blobs = SOURCE_BLOBS.map((hash) => ({
    hash,
    module: compileProjectDatabase(gitText('cat-file', '-p', hash), hash),
  }));
  const results = [];
  for (const entry of blobs) {
    for (const [prefix, modules] of [
      ['fresh', [entry.module]],
      ['v2.5.6-then', [v256, entry.module]],
    ]) {
      try {
        results.push(await runSequence(`${prefix}-${entry.hash}`, modules));
      } catch (error) {
        results.push({
          label: `${prefix}-${entry.hash}`,
          error: String(error?.message || error),
          code: error?.code || null,
          stack: String(error?.stack || '').split(/\r?\n/).slice(0, 8),
        });
      }
    }
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
