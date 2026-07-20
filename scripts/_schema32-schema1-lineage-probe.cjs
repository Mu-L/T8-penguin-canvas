'use strict';

// TEMP-only reconstruction of the retained core's schema1 -> schema2 ADD
// COLUMN history. This reads source-history evidence and never opens or copies
// either retained project database.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const baseScript = path.join(__dirname, '_schema32-core-prerelease-replay.cjs');

function replayInternals() {
  const source = fs.readFileSync(baseScript, 'utf8').replace(
    /main\(\)\.catch\([\s\S]*$/,
    'module.exports = { reconstructPreSchema3Source, compileProjectDatabase, closeDatabase };\n',
  );
  const loaded = new Module(`${baseScript}#schema1-probe`, module);
  loaded.filename = baseScript;
  loaded.paths = Module._nodeModulePaths(path.dirname(baseScript));
  loaded._compile(source, baseScript);
  return loaded.exports;
}

function gitText(...args) {
  return childProcess.execFileSync(
    'git',
    ['-c', 'safe.directory=E:/PenguinPravite/T8-penguin-canvas-release-2.5.7', ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
}

function schema1SourceFromSchema2(source2) {
  const replacements = [
    ["        parent_id TEXT,\n", ''],
    ["    const reviewCommentColumns = new Set(this.db.pragma('table_info(review_comments)').map((column) => column.name));\n", ''],
    ["    if (!reviewCommentColumns.has('parent_id')) this.db.exec('ALTER TABLE review_comments ADD COLUMN parent_id TEXT');\n", ''],
    ["    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(2, Date.now());\n", ''],
  ];
  let source = source2;
  for (const [from, to] of replacements) {
    if (!source.includes(from)) throw new Error(`schema1 reverse marker missing: ${from.trim()}`);
    source = source.replace(from, to);
  }
  return source;
}

async function openWithSource(replay, source, filename, label) {
  const implementation = replay.compileProjectDatabase(source, label);
  const database = new implementation.ProjectDatabase(filename, { autoBackup: false });
  await replay.closeDatabase(database);
  return implementation.PROJECT_DATABASE_SCHEMA_VERSION ?? label;
}

async function main() {
  const replay = replayInternals();
  const source2 = replay.reconstructPreSchema3Source();
  const source1 = schema1SourceFromSchema2(source2);
  const sources = [
    ['schema1', source1],
    ['schema2', source2],
    ['schema10', fs.readFileSync(path.join(os.tmpdir(), 't8-schema10-source-independent.cjs'), 'utf8')],
    ['schema19', fs.readFileSync(path.join(os.tmpdir(), 't8-schema19-source-independent.cjs'), 'utf8')],
    ['schema22', fs.readFileSync(path.join(os.tmpdir(), 't8-schema22-source-independent.cjs'), 'utf8')],
    ['schema23', gitText('show', 'v2.5.8:backend/src/services/projectDatabase.js')],
  ];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-schema1-lineage-'));
  const filename = path.join(directory, 'project.sqlite3');
  try {
    const opened = [];
    for (const [label, source] of sources) {
      opened.push({ label, version: await openWithSource(replay, source, filename, label) });
    }
    const currentSource = fs.readFileSync(
      path.join(root, 'backend', 'src', 'services', 'projectDatabase.js'),
      'utf8',
    );
    let currentError = null;
    try {
      await openWithSource(replay, currentSource, filename, 'current');
    } catch (error) {
      currentError = {
        name: error?.name,
        code: error?.code,
        message: error?.message,
        details: error?.details,
      };
    }

    const BetterSqlite3 = require('better-sqlite3');
    const { inspectProjectDatabaseSchemaManifest } = require('../tests/helpers/projectDatabaseSchemaManifest.cjs');
    const { PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES } = require('../backend/src/services/projectDatabaseMigration23');
    const {
      PROJECT_DATABASE_MIGRATION_29_UP_SQL,
      PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES,
    } = require('../backend/src/services/projectDatabaseMigration29');
    const {
      PROJECT_DATABASE_MIGRATION_30_UP_SQL,
      PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES,
    } = require('../backend/src/services/projectDatabaseMigration30');
    const {
      PROJECT_DATABASE_MIGRATION_31_UP_SQL,
      PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES,
    } = require('../backend/src/services/projectDatabaseMigration31');
    const { PROJECT_DATABASE_MIGRATION_32_UP_SQL } = require('../backend/src/services/projectDatabaseMigration32');
    const database = new BetterSqlite3(filename);
    try {
      const version = Number(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version || 0);
      const schema28 = inspectProjectDatabaseSchemaManifest(database, {
        descriptorVersion: 28,
        excludedObjectNames: [
          ...PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
          ...PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES,
          ...PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES,
          ...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES,
        ],
      });
      if (currentError) {
        process.stdout.write(`${JSON.stringify({
          opened,
          currentError,
          version,
          schema28: schema28.fingerprint,
        }, null, 2)}\n`);
        return;
      }
      if (version < 29) database.exec(PROJECT_DATABASE_MIGRATION_29_UP_SQL);
      if (version < 30) database.exec(PROJECT_DATABASE_MIGRATION_30_UP_SQL);
      if (version < 31) database.exec(PROJECT_DATABASE_MIGRATION_31_UP_SQL);
      const schema31 = inspectProjectDatabaseSchemaManifest(database, {
        descriptorVersion: 31,
        excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
      });
      database.exec(PROJECT_DATABASE_MIGRATION_32_UP_SQL);
      const schema32 = inspectProjectDatabaseSchemaManifest(database, {
        descriptorVersion: 32,
        excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
      });
      process.stdout.write(`${JSON.stringify({
        opened,
        currentError,
        schema28: schema28.fingerprint,
        schema31: schema31.fingerprint,
        schema32: schema32.fingerprint,
      }, null, 2)}\n`);
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
