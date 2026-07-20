const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const {
  DEFAULT_PROJECT_DATABASE_STORAGE_POLICY_32,
  ProjectDatabasePhysicalCapacityAdmissionError,
  applyProjectDatabasePhysicalPragmas32,
  assertProjectDatabaseMigrationAdmission32,
  assertProjectDatabaseWriteAdmission32,
  checkpointProjectDatabaseWal32,
  normalizeProjectDatabaseStoragePolicy32,
  observeProjectDatabasePhysicalStorage32,
  projectDatabaseStoragePolicy32FromRow,
  projectDatabaseStoragePolicy32Row,
} = require('../backend/src/services/projectDatabasePhysicalCapacity32');

function temporaryDatabase(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { directory, filename: path.join(directory, 'projects.sqlite3') };
}

function cleanup(directory) {
  const resolved = path.resolve(directory);
  assert.equal(
    `${resolved}${path.sep}`.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`),
    true,
  );
  fs.rmSync(resolved, { recursive: true, force: true });
}

function tinyPolicy(overrides = {}) {
  return {
    policyRevision: 1,
    mainMaxBytes: 32 * 1024 * 1024,
    walCheckpointTargetBytes: 256 * 1024,
    maximumSingleTransactionWalBytes: 256 * 1024,
    walPressureBytes: 768 * 1024,
    walReserveBytes: 1024 * 1024,
    walResidualLimitBytes: 128 * 1024,
    shmReserveBytes: 64 * 1024,
    hotJournalReserveBytes: 128 * 1024,
    sqliteTempReserveBytes: 1024 * 1024,
    minimumFilesystemFreeBytes: 1024 * 1024,
    backupCandidateReserveBytes: 34 * 1024 * 1024,
    recoveryEvidenceReserveBytes: 34 * 1024 * 1024,
    synchronousMode: 'FULL',
    updatedAt: 1000,
    ...overrides,
  };
}

test('B2 schema32 physical policy freezes safe arithmetic and exact row mapping', () => {
  const policy = normalizeProjectDatabaseStoragePolicy32(
    DEFAULT_PROJECT_DATABASE_STORAGE_POLICY_32,
    { updatedAt: 1000 },
  );
  assert.equal(policy.synchronousMode, 'FULL');
  assert.equal(
    policy.activeStorageBudgetBytes,
    policy.mainMaxBytes
      + policy.walReserveBytes
      + policy.shmReserveBytes
      + policy.hotJournalReserveBytes
      + policy.sqliteTempReserveBytes
      + policy.minimumFilesystemFreeBytes,
  );
  assert.equal(
    policy.walCheckpointTargetBytes + policy.maximumSingleTransactionWalBytes
      < policy.walPressureBytes,
    true,
  );
  assert.equal(policy.walPressureBytes < policy.walReserveBytes, true);
  assert.equal(Object.isFrozen(policy), true);

  const row = projectDatabaseStoragePolicy32Row(tinyPolicy());
  const roundTrip = projectDatabaseStoragePolicy32FromRow(row);
  assert.equal(roundTrip.mainMaxBytes, tinyPolicy().mainMaxBytes);
  assert.equal(roundTrip.activeStorageBudgetBytes, row.active_storage_budget_bytes);
  assert.throws(
    () => normalizeProjectDatabaseStoragePolicy32(tinyPolicy({ walPressureBytes: 512 * 1024 })),
    /WAL policy ordering/,
  );
  assert.throws(
    () => normalizeProjectDatabaseStoragePolicy32(tinyPolicy({ synchronousMode: 'NORMAL' })),
    /must be FULL/,
  );
  assert.throws(
    () => normalizeProjectDatabaseStoragePolicy32(tinyPolicy({ mainMaxBytes: Number.MAX_SAFE_INTEGER })),
    /reserve arithmetic/,
  );
});

test('B2 schema32 applies and re-reads max-page, WAL, FULL and recursive-trigger pragmas', () => {
  const fixture = temporaryDatabase('t8-b2-schema32-physical-pragmas-');
  let database = null;
  try {
    database = new BetterSqlite3(fixture.filename);
    database.pragma('journal_mode = WAL');
    database.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
    const applied = applyProjectDatabasePhysicalPragmas32(database, tinyPolicy());
    assert.equal(applied.maxPageCount, Math.floor(tinyPolicy().mainMaxBytes / applied.pageSize));
    assert.equal(database.pragma('max_page_count', { simple: true }), applied.maxPageCount);
    assert.equal(database.pragma('wal_autocheckpoint', { simple: true }), applied.walAutoCheckpointPages);
    assert.equal(database.pragma('journal_size_limit', { simple: true }), tinyPolicy().walResidualLimitBytes);
    assert.equal(database.pragma('synchronous', { simple: true }), 2);
    assert.equal(database.pragma('recursive_triggers', { simple: true }), 1);
    database.close();
    database = new BetterSqlite3(fixture.filename);
    database.pragma('journal_mode = WAL');
    const reopened = applyProjectDatabasePhysicalPragmas32(database, tinyPolicy());
    assert.equal(reopened.maxPageCount, applied.maxPageCount);
    assert.equal(database.pragma('synchronous', { simple: true }), 2);
  } finally {
    try { database?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('B2 schema32 physical observation fails closed for unknown disk or TEMP measurements', () => {
  const fixture = temporaryDatabase('t8-b2-schema32-physical-observe-');
  const database = new BetterSqlite3(fixture.filename);
  try {
    database.pragma('journal_mode = WAL');
    database.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
    database.prepare('INSERT INTO records(payload) VALUES (?)').run('observed');
    const observed = observeProjectDatabasePhysicalStorage32(database, {
      filename: fixture.filename,
    });
    assert.equal(observed.complete, true);
    assert.equal(observed.mainBytes > 0, true);
    assert.equal(observed.pageSize > 0, true);
    assert.equal(observed.databaseFilesystemFreeBytes > 0, true);
    assert.equal(observed.tempFilesystemFreeBytes > 0, true);
    assert.equal(typeof observed.databaseFilesystemIdentity, 'string');
    assert.equal(typeof observed.tempFilesystemIdentity, 'string');
    assert.equal(typeof observed.databaseAndTempShareFilesystem, 'boolean');
    assert.deepEqual(assertProjectDatabaseWriteAdmission32(observed, tinyPolicy()), {
      admitted: true,
      memory: false,
    });

    const unknown = observeProjectDatabasePhysicalStorage32(database, {
      filename: fixture.filename,
      statfs() { throw Object.assign(new Error('unknown'), { code: 'EIO' }); },
    });
    assert.equal(unknown.complete, false);
    assert.throws(
      () => assertProjectDatabaseWriteAdmission32(unknown, tinyPolicy()),
      (error) => error instanceof ProjectDatabasePhysicalCapacityAdmissionError
        && error.reason === 'measurement-unknown'
        && error.status === 507,
    );
  } finally {
    database.close();
    cleanup(fixture.directory);
  }
});

test('B2 schema32 admission distinguishes main, WAL, disk, TEMP and migration reserves', () => {
  const policy = normalizeProjectDatabaseStoragePolicy32(tinyPolicy());
  const base = {
    memory: false,
    complete: true,
    pageSize: 4096,
    pageCount: 10,
    allocatedPageBytes: 40960,
    mainBytes: 40960,
    walBytes: 0,
    shmBytes: 0,
    hotJournalBytes: 0,
    databaseFilesystemFreeBytes: 1024 * 1024 * 1024,
    tempFilesystemFreeBytes: 1024 * 1024 * 1024,
    databaseAndTempShareFilesystem: true,
  };
  const rejected = (patch, reason, migration = false) => assert.throws(
    () => (migration
      ? assertProjectDatabaseMigrationAdmission32({ ...base, ...patch }, policy)
      : assertProjectDatabaseWriteAdmission32({ ...base, ...patch }, policy)),
    (error) => error instanceof ProjectDatabasePhysicalCapacityAdmissionError
      && error.code === 'project_database_storage_capacity_exceeded'
      && error.reason === reason,
  );
  rejected({ mainBytes: policy.mainMaxBytes + 1 }, 'main-page-limit');
  rejected({
    walBytes: policy.walPressureBytes - policy.maximumSingleTransactionWalBytes,
  }, 'wal-pressure');
  rejected({ databaseFilesystemFreeBytes: 1 }, 'filesystem-reserve');
  rejected({
    databaseAndTempShareFilesystem: false,
    tempFilesystemFreeBytes: 1,
  }, 'temp-storage-full');
  rejected({
    databaseFilesystemFreeBytes: policy.minimumFilesystemFreeBytes
      + policy.backupCandidateReserveBytes
      + policy.recoveryEvidenceReserveBytes
      - 1,
  }, 'filesystem-reserve', true);

  const consumedMainBytes = Math.max(base.mainBytes, base.allocatedPageBytes);
  const activeDatabaseHeadroom = Math.max(0, policy.mainMaxBytes - consumedMainBytes)
    + Math.max(0, policy.walReserveBytes - base.walBytes)
    + Math.max(0, policy.shmReserveBytes - base.shmBytes)
    + Math.max(0, policy.hotJournalReserveBytes - base.hotJournalBytes)
    + policy.minimumFilesystemFreeBytes;
  rejected({
    databaseAndTempShareFilesystem: true,
    databaseFilesystemFreeBytes: activeDatabaseHeadroom + policy.sqliteTempReserveBytes - 1,
    tempFilesystemFreeBytes: activeDatabaseHeadroom + policy.sqliteTempReserveBytes - 1,
  }, 'filesystem-reserve');
  rejected({
    databaseAndTempShareFilesystem: false,
    databaseFilesystemFreeBytes: activeDatabaseHeadroom,
    tempFilesystemFreeBytes: policy.sqliteTempReserveBytes - 1,
  }, 'temp-storage-full');
  rejected({ databaseAndTempShareFilesystem: null }, 'measurement-unknown');
});

test('B2 schema32 PASSIVE checkpoint reports reader starvation without deleting WAL state', () => {
  const fixture = temporaryDatabase('t8-b2-schema32-wal-starvation-');
  const writer = new BetterSqlite3(fixture.filename);
  let reader = null;
  try {
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
    writer.prepare('INSERT INTO records(payload) VALUES (?)').run('seed');
    checkpointProjectDatabaseWal32(writer, 'TRUNCATE');

    reader = new BetterSqlite3(fixture.filename, { readonly: true, fileMustExist: true });
    reader.exec('BEGIN');
    assert.equal(reader.prepare('SELECT payload FROM records WHERE id = 1').get().payload, 'seed');
    const update = writer.prepare('UPDATE records SET payload = ? WHERE id = 1');
    for (let index = 0; index < 80; index += 1) {
      update.run(`${index}-${'x'.repeat(4096)}`);
    }
    const walBefore = fs.statSync(`${fixture.filename}-wal`).size;
    const blocked = checkpointProjectDatabaseWal32(writer, 'PASSIVE');
    assert.equal(blocked.logFrames > 0, true);
    assert.equal(blocked.checkpointedFrames < blocked.logFrames, true);
    assert.equal(blocked.complete, false);
    assert.equal(fs.statSync(`${fixture.filename}-wal`).size >= walBefore, true);

    reader.exec('ROLLBACK');
    reader.close();
    reader = null;
    const released = checkpointProjectDatabaseWal32(writer, 'TRUNCATE');
    assert.equal(released.busy, 0);
    assert.equal(released.complete, true);
    assert.equal(fs.statSync(`${fixture.filename}-wal`).size, 0);
  } finally {
    try { reader?.exec('ROLLBACK'); } catch (_) {}
    try { reader?.close(); } catch (_) {}
    writer.close();
    cleanup(fixture.directory);
  }
});
