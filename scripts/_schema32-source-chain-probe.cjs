'use strict';

// TEMP-only schema-lineage reconstruction helper. It compiles historical
// projectDatabase.js source snapshots, applies them in the supplied order to a
// fresh temporary SQLite database, then reports the exact v31 -> v32 manifest
// pair. It never discovers or opens a retained application database.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const serviceFilename = path.join(root, 'backend', 'src', 'services', 'projectDatabase.js');
const {
  PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
} = require('../backend/src/services/projectDatabaseMigration23');
const {
  PROJECT_DATABASE_MIGRATION_32_UP_SQL,
  PROJECT_DATABASE_SCHEMA_32_OWNED_OBJECT_NAMES,
} = require('../backend/src/services/projectDatabaseMigration32');
const {
  inspectProjectDatabaseSchemaManifest,
} = require('../tests/helpers/projectDatabaseSchemaManifest.cjs');

function gitSource(ref) {
  return childProcess.execFileSync('git', [
    '-c',
    'safe.directory=E:/PenguinPravite/T8-penguin-canvas-release-2.5.7',
    'show',
    `${ref}:backend/src/services/projectDatabase.js`,
  ], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function sourceFor(spec) {
  if (spec.startsWith('git:')) return gitSource(spec.slice('git:'.length));
  if (spec.startsWith('gitblob:')) {
    return childProcess.execFileSync('git', [
      '-c',
      'safe.directory=E:/PenguinPravite/T8-penguin-canvas-release-2.5.7',
      'cat-file',
      'blob',
      spec.slice('gitblob:'.length),
    ], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  if (spec.startsWith('replay:')) {
    const output = childProcess.execFileSync('node', [
      path.join(root, 'scripts', '_schema-lineage-replay.cjs'),
      spec.slice('replay:'.length),
      '--print-source',
    ], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    const sourceStart = output.indexOf("const fs = require('fs');");
    if (sourceStart < 0) throw new Error(`replayed source missing for ${spec}`);
    let replayed = output.slice(sourceStart);
    if (!/class OperationBatchConflictError\b/.test(replayed)) {
      replayed = replayed.replace(
        /const PROJECT_DATABASE_SCHEMA_VERSION = \d+;\n/,
        (declaration) => `class OperationBatchConflictError extends Error {}\n\n${declaration}`,
      );
    }
    return replayed;
  }
  if (spec === 'current') return fs.readFileSync(serviceFilename, 'utf8');
  return fs.readFileSync(path.resolve(spec), 'utf8');
}

function compileProjectDatabase(source, suffix) {
  const loaded = new Module(`${serviceFilename}#source-chain-${suffix}`, module);
  loaded.filename = serviceFilename;
  loaded.paths = Module._nodeModulePaths(path.dirname(serviceFilename));
  loaded._compile(source, serviceFilename);
  return loaded.exports;
}

async function closeDatabase(database) {
  const result = database?.close();
  if (result && typeof result.then === 'function') await result;
}

async function main() {
  const specs = process.argv.slice(2);
  if (specs.length === 0) throw new Error('pass one or more source specs');
  const BetterSqlite3 = require('better-sqlite3');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-schema32-source-chain-'));
  const filename = path.join(directory, 'project.sqlite3');
  const observations = [];
  let database = null;
  try {
    for (const [index, spec] of specs.entries()) {
      const implementation = compileProjectDatabase(sourceFor(spec), `${index}`);
      database = new implementation.ProjectDatabase(filename, { autoBackup: false });
      const version = Number(database.db.prepare(
        'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
      ).get().version);
      const schema28Fingerprint = version === 28
        ? inspectProjectDatabaseSchemaManifest(database.db, {
          descriptorVersion: 28,
          excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
        }).fingerprint
        : null;
      const observation = {
        spec,
        exportedVersion: implementation.PROJECT_DATABASE_SCHEMA_VERSION,
        version,
        schema28Fingerprint,
      };
      observations.push(observation);
      process.stdout.write(`${JSON.stringify({ observation })}\n`);
      await closeDatabase(database);
      database = null;
    }
    const raw = new BetterSqlite3(filename);
    try {
      const sourceManifest = inspectProjectDatabaseSchemaManifest(raw, {
        descriptorVersion: 31,
        excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
      });
      raw.exec(PROJECT_DATABASE_MIGRATION_32_UP_SQL);
      const targetManifest = inspectProjectDatabaseSchemaManifest(raw, {
        descriptorVersion: 32,
        excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
      });
      const extensionManifest = inspectProjectDatabaseSchemaManifest(raw, {
        descriptorVersion: 32,
        includedObjectNames: PROJECT_DATABASE_SCHEMA_32_OWNED_OBJECT_NAMES,
      });
      process.stdout.write(`${JSON.stringify({
        observations,
        sourceFingerprint: sourceManifest.fingerprint,
        targetFingerprint: targetManifest.fingerprint,
        extensionFingerprint: extensionManifest.fingerprint,
      }, null, 2)}\n`);
    } finally {
      raw.close();
    }
  } finally {
    await closeDatabase(database);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
