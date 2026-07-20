'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const {
  LOGICAL_DIGEST_HEADER_32,
  PROJECT_DATABASE_LOGICAL_DIGEST_IMPLEMENTATION_CONTRACT_32,
  ProjectDatabaseLogicalDigest32Error,
  encodeProjectDatabaseSqliteTuple32,
  encodeProjectDatabaseSqliteValue32,
  projectDatabaseLogicalContentDigest32,
} = require('../backend/src/services/projectDatabaseLogicalDigest32');
const {
  PROJECT_DATABASE_SCHEMA_32_LOGICAL_CONTENT_DIGEST_CONTRACT,
  PROJECT_DATABASE_SCHEMA_32_LOGICAL_CONTENT_DIGEST_SCOPE,
} = require('../backend/src/services/projectDatabaseMigration32');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(directory) {
  const resolved = path.resolve(directory);
  assert.equal(
    `${resolved}${path.sep}`.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`),
    true,
  );
  fs.rmSync(resolved, { recursive: true, force: true });
}

function createLogicalFixture(filename, reverse = false) {
  const database = new BetterSqlite3(filename);
  database.exec(`
    CREATE TABLE alpha (
      key_part TEXT,
      nullable_part TEXT,
      value INTEGER NOT NULL,
      note TEXT NOT NULL,
      PRIMARY KEY (key_part, nullable_part)
    );
    CREATE TABLE omega (
      label TEXT NOT NULL,
      score REAL NOT NULL,
      payload BLOB,
      marker
    );
    CREATE TABLE project_database_backup_receipts (ignored TEXT NOT NULL);
    CREATE TABLE project_database_canonical_backup_head (ignored TEXT NOT NULL);
  `);
  const alphaRows = [
    ['b', null, 2n, 'second-null'],
    ['a', 'x', 10n, 'first'],
    ['b', null, 1n, 'first-null'],
    ['😀', 'z', 9223372036854775807n, 'unicode'],
  ];
  const omegaRows = [
    ['ten', 10, Buffer.from([0, 255]), null],
    ['two', 2, null, 'text'],
    ['negative-zero', -0, Buffer.alloc(0), 7n],
  ];
  const insertAlpha = database.prepare(
    'INSERT INTO alpha(key_part, nullable_part, value, note) VALUES (?, ?, ?, ?)',
  );
  const insertOmega = database.prepare(
    'INSERT INTO omega(label, score, payload, marker) VALUES (?, ?, ?, ?)',
  );
  for (const row of reverse ? [...alphaRows].reverse() : alphaRows) insertAlpha.run(...row);
  for (const row of reverse ? [...omegaRows].reverse() : omegaRows) insertOmega.run(...row);
  database.prepare('INSERT INTO project_database_backup_receipts(ignored) VALUES (?)')
    .run(reverse ? 'different-receipt-b' : 'receipt-a');
  database.prepare('INSERT INTO project_database_canonical_backup_head(ignored) VALUES (?)')
    .run(reverse ? 'different-head-b' : 'head-a');
  return database;
}

test('B2 schema32 SQLite value framing is exact and type preserving', () => {
  assert.deepEqual(
    PROJECT_DATABASE_LOGICAL_DIGEST_IMPLEMENTATION_CONTRACT_32,
    PROJECT_DATABASE_SCHEMA_32_LOGICAL_CONTENT_DIGEST_CONTRACT,
  );
  assert.equal(
    LOGICAL_DIGEST_HEADER_32.toString('hex'),
    Buffer.from('t8-project-database-logical-content-digest-v2\0', 'utf8').toString('hex'),
  );
  assert.equal(encodeProjectDatabaseSqliteValue32(null).toString('hex'), '6e0000000000000000');
  assert.equal(
    encodeProjectDatabaseSqliteValue32(-12n).toString('hex'),
    '6900000000000000032d3132',
  );
  assert.equal(
    encodeProjectDatabaseSqliteValue32('鸭').toString('hex'),
    '740000000000000003e9b8ad',
  );
  assert.equal(
    encodeProjectDatabaseSqliteValue32(Buffer.from([0, 255])).toString('hex'),
    '62000000000000000200ff',
  );
  assert.equal(encodeProjectDatabaseSqliteValue32(-0).subarray(9).toString('hex'), '8000000000000000');
  assert.throws(
    () => encodeProjectDatabaseSqliteValue32(undefined),
    (error) => error instanceof ProjectDatabaseLogicalDigest32Error
      && error.reason === 'sqlite-value-invalid',
  );
  assert.throws(() => encodeProjectDatabaseSqliteTuple32('not-an-array'), /tuple must be an array/);
});

test('B2 schema32 logical digest ignores layout, insertion order and receipt objects', () => {
  const directory = temporaryDirectory('t8-b2-schema32-logical-equality-');
  let first = null;
  let second = null;
  try {
    first = createLogicalFixture(path.join(directory, 'first.sqlite3'), false);
    second = createLogicalFixture(path.join(directory, 'second.sqlite3'), true);
    first.pragma('journal_mode = WAL');
    second.exec('VACUUM');
    const left = projectDatabaseLogicalContentDigest32(first);
    const right = projectDatabaseLogicalContentDigest32(second);
    assert.equal(left.algorithm, 'sha256');
    assert.equal(left.scope, PROJECT_DATABASE_SCHEMA_32_LOGICAL_CONTENT_DIGEST_SCOPE);
    assert.equal(left.digest, right.digest);
    assert.equal(left.digest.length, 64);
    assert.equal(left.tableCount, 2);
    assert.equal(left.rowCount, 7n);
    assert.deepEqual(left.tables.map((table) => table.name), ['alpha', 'omega']);
    assert.deepEqual(left.tables[0].primaryKeyColumns, ['key_part', 'nullable_part']);
  } finally {
    try { first?.close(); } catch (_) {}
    try { second?.close(); } catch (_) {}
    cleanup(directory);
  }
});

test('B2 schema32 logical digest changes for one logical value and requires query-only on verification', () => {
  const directory = temporaryDirectory('t8-b2-schema32-logical-change-');
  let database = null;
  try {
    database = createLogicalFixture(path.join(directory, 'projects.sqlite3'));
    const before = projectDatabaseLogicalContentDigest32(database);
    database.prepare('UPDATE omega SET score = ? WHERE label = ?').run(3, 'two');
    const after = projectDatabaseLogicalContentDigest32(database);
    assert.notEqual(before.digest, after.digest);
    assert.throws(
      () => projectDatabaseLogicalContentDigest32(database, { requireQueryOnly: true }),
      (error) => error instanceof ProjectDatabaseLogicalDigest32Error
        && error.reason === 'query-only-required',
    );
    database.pragma('query_only = ON');
    assert.equal(
      projectDatabaseLogicalContentDigest32(database, { requireQueryOnly: true }).digest,
      after.digest,
    );
  } finally {
    try { database?.close(); } catch (_) {}
    cleanup(directory);
  }
});

test('B2 schema32 row ordering supports more than one SQLite function argument chunk', () => {
  const directory = temporaryDirectory('t8-b2-schema32-logical-wide-');
  let first = null;
  let second = null;
  try {
    const columns = Array.from({ length: 130 }, (_, index) => `c${index}`);
    const ddl = `CREATE TABLE wide (${columns.map((name) => `"${name}"`).join(', ')})`;
    const insert = `INSERT INTO wide VALUES (${columns.map(() => '?').join(', ')})`;
    first = new BetterSqlite3(path.join(directory, 'wide-a.sqlite3'));
    second = new BetterSqlite3(path.join(directory, 'wide-b.sqlite3'));
    first.exec(ddl);
    second.exec(ddl);
    const rowA = columns.map((_, index) => `a-${index}`);
    const rowB = columns.map((_, index) => `b-${index}`);
    first.prepare(insert).run(...rowB);
    first.prepare(insert).run(...rowA);
    second.prepare(insert).run(...rowA);
    second.prepare(insert).run(...rowB);
    assert.equal(
      projectDatabaseLogicalContentDigest32(first).digest,
      projectDatabaseLogicalContentDigest32(second).digest,
    );
  } finally {
    try { first?.close(); } catch (_) {}
    try { second?.close(); } catch (_) {}
    cleanup(directory);
  }
});
