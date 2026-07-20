'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const {
  ProjectDatabase,
  ProjectDatabaseRecoveryError,
  ProjectDatabaseSchemaInvalidError,
  ProjectDatabaseStorageCapacityError,
  translateProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');
const {
  ProjectDatabasePhysicalCapacityAdmissionError,
  applyProjectDatabasePhysicalPragmas32,
  assertProjectDatabaseWriteAdmission32,
  checkpointProjectDatabaseWal32,
  normalizeProjectDatabaseStoragePolicy32,
  observeProjectDatabasePhysicalStorage32,
  projectDatabaseStoragePolicy32Row,
} = require('../backend/src/services/projectDatabasePhysicalCapacity32');

const MiB = 1024 * 1024;

function temporaryProject(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filename = path.join(directory, 'projects.sqlite3');
  return {
    directory,
    filename,
    backupFilename: `${filename}.backup`,
    acknowledgementFilename: `${filename}.recovery-generation.json`,
  };
}

function cleanup(directory) {
  const resolved = path.resolve(directory);
  assert.equal(
    `${resolved}${path.sep}`.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`),
    true,
  );
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function closeQuietly(database) {
  try { await database?.close(); } catch (_) {}
}

function fileSha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function protectedArtifactDigests(fixture, extraFilenames = []) {
  const filenames = [
    fixture.filename,
    `${fixture.filename}-wal`,
    `${fixture.filename}-shm`,
    `${fixture.filename}-journal`,
    fixture.backupFilename,
    fixture.acknowledgementFilename,
    ...extraFilenames,
  ];
  return Object.fromEntries(filenames.map((filename) => [
    path.resolve(filename),
    fs.existsSync(filename)
      ? Object.freeze({ size: fs.statSync(filename).size, sha256: fileSha256(filename) })
      : null,
  ]));
}

function flipFirstSchemaBtreePageTypeBit(filename) {
  const descriptor = fs.openSync(filename, 'r+');
  try {
    const byte = Buffer.alloc(1);
    assert.equal(fs.readSync(descriptor, byte, 0, 1, 100), 1);
    const before = byte[0];
    assert.equal([0x02, 0x05, 0x0a, 0x0d].includes(before), true,
      'offset 100 must be a valid SQLite page-1 b-tree type');
    byte[0] ^= 0x01;
    assert.equal([0x02, 0x05, 0x0a, 0x0d].includes(byte[0]), false,
      'one-bit fault must make the page type invalid');
    assert.equal(fs.writeSync(descriptor, byte, 0, 1, 100), 1);
    fs.fsyncSync(descriptor);
    return Object.freeze({ offset: 100, before, after: byte[0] });
  } finally {
    fs.closeSync(descriptor);
  }
}

function storagePolicy(overrides = {}) {
  const mainMaxBytes = 64 * MiB;
  const walResidualLimitBytes = 128 * 1024;
  const shmReserveBytes = 1 * MiB;
  const hotJournalReserveBytes = 2 * MiB;
  return {
    policyRevision: 1,
    mainMaxBytes,
    walCheckpointTargetBytes: 512 * 1024,
    maximumSingleTransactionWalBytes: 256 * 1024,
    walPressureBytes: 4 * MiB,
    walReserveBytes: 8 * MiB,
    walResidualLimitBytes,
    shmReserveBytes,
    hotJournalReserveBytes,
    sqliteTempReserveBytes: 8 * MiB,
    minimumFilesystemFreeBytes: 8 * MiB,
    backupCandidateReserveBytes:
      mainMaxBytes + walResidualLimitBytes + shmReserveBytes + hotJournalReserveBytes,
    recoveryEvidenceReserveBytes: 64 * MiB,
    synchronousMode: 'FULL',
    updatedAt: 1000,
    ...overrides,
  };
}

function move(opId, x) {
  return {
    opId,
    actorId: 'physical-fault-member',
    sessionId: 'physical-fault-session',
    clientSeq: x,
    type: 'node.move',
    payload: { nodeId: 'node-a', position: { x, y: x } },
  };
}

function updateStoragePolicyForTest(database, input) {
  const current = database.db.prepare(`
    SELECT policy_revision, updated_at
    FROM project_database_storage_policy
    WHERE singleton_id = 1
  `).get();
  const policy = normalizeProjectDatabaseStoragePolicy32({
    ...input,
    policyRevision: Number(current.policy_revision) + 1,
    updatedAt: Number(current.updated_at) + 1,
  });
  const row = projectDatabaseStoragePolicy32Row(policy);
  const updated = database.db.prepare(`
    UPDATE project_database_storage_policy
    SET policy_revision = @policy_revision,
        active_storage_budget_bytes = @active_storage_budget_bytes,
        main_max_bytes = @main_max_bytes,
        wal_checkpoint_target_bytes = @wal_checkpoint_target_bytes,
        maximum_single_transaction_wal_bytes = @maximum_single_transaction_wal_bytes,
        wal_pressure_bytes = @wal_pressure_bytes,
        wal_reserve_bytes = @wal_reserve_bytes,
        wal_residual_limit_bytes = @wal_residual_limit_bytes,
        shm_reserve_bytes = @shm_reserve_bytes,
        hot_journal_reserve_bytes = @hot_journal_reserve_bytes,
        sqlite_temp_reserve_bytes = @sqlite_temp_reserve_bytes,
        minimum_filesystem_free_bytes = @minimum_filesystem_free_bytes,
        backup_candidate_reserve_bytes = @backup_candidate_reserve_bytes,
        recovery_evidence_reserve_bytes = @recovery_evidence_reserve_bytes,
        synchronous_mode = @synchronous_mode,
        updated_at = @updated_at
    WHERE singleton_id = 1
  `).run(row);
  assert.equal(updated.changes, 1);
  applyProjectDatabasePhysicalPragmas32(database.db, policy);
  return policy;
}

function installFsFault(options = {}) {
  const original = {
    openSync: fs.openSync,
    closeSync: fs.closeSync,
    fsyncSync: fs.fsyncSync,
    renameSync: fs.renameSync,
  };
  const descriptorPaths = new Map();
  let restored = false;
  fs.openSync = function patchedOpenSync(filename, ...args) {
    const descriptor = original.openSync.call(fs, filename, ...args);
    if (typeof filename === 'string' || Buffer.isBuffer(filename)) {
      descriptorPaths.set(descriptor, path.resolve(String(filename)));
    }
    return descriptor;
  };
  fs.closeSync = function patchedCloseSync(descriptor) {
    try {
      return original.closeSync.call(fs, descriptor);
    } finally {
      descriptorPaths.delete(descriptor);
    }
  };
  fs.fsyncSync = function patchedFsyncSync(descriptor) {
    const filename = descriptorPaths.get(descriptor) || null;
    options.beforeFsync?.(filename, descriptor);
    return original.fsyncSync.call(fs, descriptor);
  };
  fs.renameSync = function patchedRenameSync(source, target) {
    if (options.rename) return options.rename(source, target, original.renameSync);
    return original.renameSync.call(fs, source, target);
  };
  return () => {
    if (restored) return;
    restored = true;
    fs.openSync = original.openSync;
    fs.closeSync = original.closeSync;
    fs.fsyncSync = original.fsyncSync;
    fs.renameSync = original.renameSync;
  };
}

async function backupWithFsFault(database, options) {
  const restore = installFsFault(options);
  try {
    return await database.createBackup();
  } finally {
    restore();
  }
}

test('B2 schema32 cold-open reapplies the persisted physical PRAGMA contract', async () => {
  const fixture = temporaryProject('t8-schema32-cold-physical-pragmas-');
  const policy = normalizeProjectDatabaseStoragePolicy32(storagePolicy());
  let database = null;
  try {
    database = new ProjectDatabase(fixture.filename, {
      autoBackup: false,
      projectDatabaseStoragePolicy32: policy,
    });
    const first = database.projectDatabasePhysicalPolicyState32;
    assert.equal(first.maxPageCount, Math.floor(policy.mainMaxBytes / first.pageSize));
    assert.equal(first.synchronousMode, 'FULL');
    assert.equal(first.recursiveTriggers, true);

    database.db.pragma('main.max_page_count = 1073741823');
    database.db.pragma('wal_autocheckpoint = 7777');
    database.db.pragma('journal_size_limit = 777777');
    database.db.pragma('synchronous = NORMAL');
    database.db.pragma('recursive_triggers = OFF');
    assert.notEqual(database.db.pragma('wal_autocheckpoint', { simple: true }),
      first.walAutoCheckpointPages);
    assert.equal(database.db.pragma('synchronous', { simple: true }), 1);
    await database.close();
    database = null;

    database = new ProjectDatabase(fixture.filename, { autoBackup: false });
    const reopened = database.projectDatabasePhysicalPolicyState32;
    assert.deepEqual(reopened, first);
    assert.equal(database.db.pragma('max_page_count', { simple: true }), first.maxPageCount);
    assert.equal(database.db.pragma('wal_autocheckpoint', { simple: true }),
      first.walAutoCheckpointPages);
    assert.equal(database.db.pragma('journal_size_limit', { simple: true }),
      policy.walResidualLimitBytes);
    assert.equal(database.db.pragma('synchronous', { simple: true }), 2);
    assert.equal(database.db.pragma('recursive_triggers', { simple: true }), 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    await closeQuietly(database);
    cleanup(fixture.directory);
  }
});

test('B2 schema32 long reader rejects before the business transaction and recovers after WAL release', async () => {
  const fixture = temporaryProject('t8-schema32-wal-pressure-recovery-');
  let database = null;
  let reader = null;
  try {
    database = new ProjectDatabase(fixture.filename, {
      autoBackup: false,
      projectDatabaseStoragePolicy32: storagePolicy(),
    });
    const document = database.ensureCanvas('physical-wal-canvas', {
      nodes: [{ id: 'node-a', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    assert.equal(document.revision, 1);

    const pressurePolicy = updateStoragePolicyForTest(database, storagePolicy({
      walCheckpointTargetBytes: 64 * 1024,
      maximumSingleTransactionWalBytes: 64 * 1024,
      walPressureBytes: 256 * 1024,
      walReserveBytes: 512 * 1024,
      walResidualLimitBytes: 32 * 1024,
    }));
    checkpointProjectDatabaseWal32(database.db, 'TRUNCATE');

    reader = new BetterSqlite3(fixture.filename, { readonly: true, fileMustExist: true });
    reader.exec('BEGIN');
    assert.equal(reader.prepare(`
      SELECT revision FROM canvas_documents WHERE canvas_id = ?
    `).get('physical-wal-canvas').revision, 1);

    const row = JSON.parse(database.db.prepare(`
      SELECT snapshot_json FROM canvas_documents WHERE canvas_id = ?
    `).get('physical-wal-canvas').snapshot_json);
    const update = database.db.prepare(`
      UPDATE canvas_documents
      SET snapshot_json = ?, updated_at = updated_at + 1
      WHERE canvas_id = ?
    `);
    let walBytes = 0;
    for (let index = 0; index < 128; index += 1) {
      update.run(JSON.stringify({
        ...row,
        physicalFaultPadding: `${index}:${'x'.repeat(64 * 1024)}`,
      }), 'physical-wal-canvas');
      walBytes = fs.statSync(`${fixture.filename}-wal`).size;
      if (walBytes + pressurePolicy.maximumSingleTransactionWalBytes
        >= pressurePolicy.walPressureBytes) break;
    }
    assert.equal(walBytes + pressurePolicy.maximumSingleTransactionWalBytes
      >= pressurePolicy.walPressureBytes, true);
    const blockedCheckpoint = checkpointProjectDatabaseWal32(database.db, 'PASSIVE');
    assert.equal(blockedCheckpoint.complete, false);
    assert.equal(blockedCheckpoint.checkpointedFrames < blockedCheckpoint.logFrames, true);

    const sequenceBefore = database.db.prepare(`
      SELECT write_sequence FROM project_database_identity WHERE singleton_id = 1
    `).get().write_sequence;
    let businessTransactionInvoked = false;
    assert.throws(
      () => database.withProjectDatabaseWrite('b2.wal-pressure.blocked', () => {
        businessTransactionInvoked = true;
        return 1;
      }),
      (error) => error instanceof ProjectDatabasePhysicalCapacityAdmissionError
        && error.code === 'project_database_storage_capacity_exceeded'
        && error.status === 507
        && error.reason === 'wal-pressure'
        && error.retryable === true,
    );
    assert.equal(businessTransactionInvoked, false);
    assert.equal(database.db.prepare(`
      SELECT write_sequence FROM project_database_identity WHERE singleton_id = 1
    `).get().write_sequence, sequenceBefore);

    reader.exec('ROLLBACK');
    reader.close();
    reader = null;
    const released = checkpointProjectDatabaseWal32(database.db, 'TRUNCATE');
    assert.equal(released.complete, true);
    assert.equal(fs.statSync(`${fixture.filename}-wal`).size, 0);
    const releasedSnapshot = observeProjectDatabasePhysicalStorage32(database.db, {
      filename: fixture.filename,
    });
    assert.deepEqual(assertProjectDatabaseWriteAdmission32(
      releasedSnapshot,
      pressurePolicy,
    ), { admitted: true, memory: false });

    const applied = database.withProjectDatabaseWrite('b2.wal-pressure.recovered', () => {
      businessTransactionInvoked = true;
      return database.db.prepare(`
        UPDATE canvas_documents SET updated_at = updated_at + 1 WHERE canvas_id = ?
      `).run('physical-wal-canvas').changes;
    });
    assert.equal(applied, 1);
    assert.equal(businessTransactionInvoked, true);
    assert.equal(database.db.prepare(`
      SELECT write_sequence FROM project_database_identity WHERE singleton_id = 1
    `).get().write_sequence, sequenceBefore + 1);
  } finally {
    try { reader?.exec('ROLLBACK'); } catch (_) {}
    try { reader?.close(); } catch (_) {}
    await closeQuietly(database);
    cleanup(fixture.directory);
  }
});

test('B2 schema32 TEMP exhaustion stays distinct from main-page admission', () => {
  const database = new BetterSqlite3(':memory:');
  try {
    database.pragma('temp_store = FILE');
    database.exec('CREATE TEMP TABLE temp_capacity_probe(payload BLOB NOT NULL)');
    const tempPageCount = database.pragma('temp.page_count', { simple: true });
    assert.equal(database.pragma(
      `temp.max_page_count = ${Math.max(1, tempPageCount)}`,
      { simple: true },
    ), Math.max(1, tempPageCount));
    let sqliteFull = null;
    try {
      database.prepare(`
        INSERT INTO temp_capacity_probe(payload) VALUES (zeroblob(?))
      `).run(MiB);
    } catch (error) {
      sqliteFull = error;
    }
    assert.equal(sqliteFull?.code, 'SQLITE_FULL');
    const translated = translateProjectDatabaseStorageCapacityError(sqliteFull, {
      operation: 'b2.temp-capacity-probe',
    });
    assert.equal(translated instanceof ProjectDatabaseStorageCapacityError, true);
    assert.equal(translated.status, 507);
    assert.equal(translated.reason, 'sqlite-full');
    assert.notEqual(translated.reason, 'main-page-limit');

    const policy = normalizeProjectDatabaseStoragePolicy32(storagePolicy());
    const injectedSeparateTempDisk = {
      memory: false,
      complete: true,
      pageSize: 4096,
      pageCount: 10,
      allocatedPageBytes: 40960,
      mainBytes: 40960,
      walBytes: 0,
      shmBytes: 0,
      hotJournalBytes: 0,
      databaseFilesystemFreeBytes: 1024 * MiB,
      tempFilesystemFreeBytes: policy.sqliteTempReserveBytes - 1,
      databaseFilesystemIdentity: 'dev:database-fixture',
      tempFilesystemIdentity: 'dev:injected-full-temp-fixture',
      databaseAndTempShareFilesystem: false,
    };
    assert.throws(
      () => assertProjectDatabaseWriteAdmission32(injectedSeparateTempDisk, policy),
      (error) => error instanceof ProjectDatabasePhysicalCapacityAdmissionError
        && error.status === 507
        && error.reason === 'temp-storage-full'
        && error.details.requiredTempFreeBytes === policy.sqliteTempReserveBytes
        && error.details.observedTempFreeBytes === policy.sqliteTempReserveBytes - 1,
    );
  } finally {
    database.close();
  }
});

test('B2 schema32 backup fsync, directory sync and rename faults preserve or expose the exact publish boundary', async () => {
  const fixture = temporaryProject('t8-schema32-backup-durability-faults-');
  let database = null;
  let candidateFilename = null;
  let ownedTempDirectory = null;
  try {
    database = new ProjectDatabase(fixture.filename, {
      autoBackup: false,
      projectDatabaseStoragePolicy32: storagePolicy(),
      beforeDatabaseBackupWrite(context) {
        candidateFilename = path.resolve(context.candidateFilename);
        ownedTempDirectory = path.resolve(context.ownedTempDirectory);
      },
    });
    let document = database.ensureCanvas('physical-backup-canvas', {
      nodes: [{ id: 'node-a', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    await database.createBackup();
    const originalBackupHash = fileSha256(fixture.backupFilename);

    document = database.applyOperations(
      'physical-backup-canvas',
      [move('physical-backup-file-fsync', 1)],
      { expectedRevision: document.revision },
    ).document;
    let fired = false;
    await assert.rejects(
      backupWithFsFault(database, {
        beforeFsync(filename) {
          if (!fired && filename === candidateFilename) {
            fired = true;
            throw Object.assign(new Error('controlled candidate fsync failure'), { code: 'EIO' });
          }
        },
      }),
      (error) => error?.code === 'EIO'
        && error.projectDatabaseBackupPhase === 'file_sync',
    );
    assert.equal(fired, true);
    assert.equal(fileSha256(fixture.backupFilename), originalBackupHash);

    document = database.applyOperations(
      'physical-backup-canvas',
      [move('physical-backup-directory-fsync', 2)],
      { expectedRevision: document.revision },
    ).document;
    fired = false;
    await assert.rejects(
      backupWithFsFault(database, {
        beforeFsync(filename) {
          if (!fired && filename === ownedTempDirectory) {
            fired = true;
            throw Object.assign(new Error('controlled candidate directory fsync failure'), {
              code: 'EIO',
            });
          }
        },
      }),
      (error) => error?.code === 'EIO'
        && error.projectDatabaseBackupPhase === 'directory_sync_before_replace',
    );
    assert.equal(fired, true);
    assert.equal(fileSha256(fixture.backupFilename), originalBackupHash);

    document = database.applyOperations(
      'physical-backup-canvas',
      [move('physical-backup-rename', 3)],
      { expectedRevision: document.revision },
    ).document;
    fired = false;
    await assert.rejects(
      backupWithFsFault(database, {
        rename(source, target, originalRename) {
          if (path.resolve(source) === candidateFilename
            && path.resolve(target) === path.resolve(fixture.backupFilename)) {
            fired = true;
            throw Object.assign(new Error('controlled backup rename failure'), { code: 'EIO' });
          }
          return originalRename.call(fs, source, target);
        },
      }),
      (error) => error?.code === 'EIO'
        && error.projectDatabaseBackupPhase === 'replace',
    );
    assert.equal(fired, true);
    assert.equal(fileSha256(fixture.backupFilename), originalBackupHash);

    document = database.applyOperations(
      'physical-backup-canvas',
      [move('physical-backup-post-rename-directory-fsync', 4)],
      { expectedRevision: document.revision },
    ).document;
    let published = false;
    fired = false;
    await assert.rejects(
      backupWithFsFault(database, {
        rename(source, target, originalRename) {
          const result = originalRename.call(fs, source, target);
          if (path.resolve(source) === candidateFilename
            && path.resolve(target) === path.resolve(fixture.backupFilename)) {
            published = true;
          }
          return result;
        },
        beforeFsync(filename) {
          if (!fired && published
            && filename === path.resolve(path.dirname(fixture.backupFilename))) {
            fired = true;
            throw Object.assign(new Error('controlled post-publish directory fsync failure'), {
              code: 'EIO',
            });
          }
        },
      }),
      (error) => error?.code === 'project_database_backup_published_not_durable'
        && error.status === 503
        && error.committed === true
        && error.backupPublished === true
        && error.projectDatabaseBackupPhase === 'replace',
    );
    assert.equal(published, true);
    assert.equal(fired, true);
    assert.notEqual(fileSha256(fixture.backupFilename), originalBackupHash);
    const validation = database.validateRecoveryCandidate(fixture.backupFilename);
    assert.equal(validation.canonicalVerification?.verified, true);
    assert.equal(validation.canonicalVerification?.capturedWriteSequence,
      database.db.prepare(`
        SELECT write_sequence FROM project_database_identity WHERE singleton_id = 1
      `).get().write_sequence);
    assert.equal(fs.readdirSync(fixture.directory).some((entry) => (
      entry.startsWith(`.${path.basename(fixture.backupFilename)}.owned-`)
    )), false);
  } finally {
    await closeQuietly(database);
    cleanup(fixture.directory);
  }
});

test('B2 schema32 active-set truncation rejects stale or unknown recovery while SHM is safely rebuilt', async () => {
  const fixture = temporaryProject('t8-schema32-active-set-faults-');
  const snapshotDirectory = path.join(fixture.directory, 'active-set-snapshot');
  fs.mkdirSync(snapshotDirectory);
  const snapshotNames = new Map([
    ['', 'main.sqlite3'],
    ['-wal', 'main.sqlite3-wal'],
    ['-shm', 'main.sqlite3-shm'],
    ['-journal', 'main.sqlite3-journal'],
    ['.recovery-generation.json', 'freshness.json'],
    ['.backup', 'canonical.sqlite3'],
  ]);
  let database = null;
  try {
    database = new ProjectDatabase(fixture.filename, {
      autoBackup: false,
      projectDatabaseStoragePolicy32: storagePolicy(),
    });
    let document = database.ensureCanvas('physical-active-set-canvas', {
      nodes: [{ id: 'node-a', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    await database.createBackup();
    const staleBackupHash = fileSha256(fixture.backupFilename);
    checkpointProjectDatabaseWal32(database.db, 'TRUNCATE');
    database.db.pragma('wal_autocheckpoint = 0');
    document = database.applyOperations(
      'physical-active-set-canvas',
      [move('physical-active-set-committed-in-wal', 17)],
      { expectedRevision: document.revision },
    ).document;
    assert.equal(document.revision, 2);
    assert.equal(fs.statSync(`${fixture.filename}-wal`).size > 32, true);
    for (const [suffix, snapshotName] of snapshotNames) {
      const source = `${fixture.filename}${suffix}`;
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(snapshotDirectory, snapshotName));
    }
    await database.close();
    database = null;

    const restoreSnapshot = () => {
      for (const [suffix, snapshotName] of snapshotNames) {
        const target = `${fixture.filename}${suffix}`;
        fs.rmSync(target, { force: true });
        const source = path.join(snapshotDirectory, snapshotName);
        if (fs.existsSync(source)) fs.copyFileSync(source, target);
      }
    };
    const expectRejected = (name, mutate, expectedPhase, expectedReason = null) => {
      restoreSnapshot();
      mutate();
      const mainHash = fileSha256(fixture.filename);
      const acknowledgement = fs.existsSync(fixture.acknowledgementFilename)
        ? fs.readFileSync(fixture.acknowledgementFilename)
        : null;
      assert.throws(
        () => new ProjectDatabase(fixture.filename, { autoBackup: false }),
        (error) => error instanceof ProjectDatabaseRecoveryError
          && error.code === 'project_database_recovery_failed'
          && error.details?.phase === expectedPhase
          && (!expectedReason || error.details?.freshnessReasons?.includes(expectedReason))
          && Array.isArray(error.details?.primaryEvidence),
        name,
      );
      assert.equal(fileSha256(fixture.filename), mainHash, `${name}: primary must not be replaced`);
      assert.equal(fileSha256(fixture.backupFilename), staleBackupHash,
        `${name}: canonical backup must not be changed`);
      if (acknowledgement) {
        assert.deepEqual(fs.readFileSync(fixture.acknowledgementFilename), acknowledgement,
          `${name}: acknowledged watermark must not change`);
      }
    };

    expectRejected('truncated main', () => {
      const size = fs.statSync(fixture.filename).size;
      fs.truncateSync(fixture.filename, Math.max(1, Math.floor(size / 2)));
    }, 'backup_freshness_rejected',
    'captured-write-sequence-behind-acknowledged-watermark');

    expectRejected('missing committed WAL', () => {
      fs.rmSync(`${fixture.filename}-wal`, { force: true });
    }, 'backup_freshness_rejected',
    'captured-write-sequence-behind-acknowledged-watermark');

    expectRejected('truncated committed WAL', () => {
      const wal = fs.readFileSync(`${fixture.filename}-wal`);
      assert.equal(wal.length > 132, true);
      fs.writeFileSync(`${fixture.filename}-wal`, wal.subarray(0, wal.length - 100));
    }, 'backup_freshness_rejected',
    'captured-write-sequence-behind-acknowledged-watermark');

    expectRejected('mismatched WAL salt', () => {
      const wal = fs.readFileSync(`${fixture.filename}-wal`);
      assert.equal(wal.length > 24, true);
      wal[16] ^= 0xff;
      fs.writeFileSync(`${fixture.filename}-wal`, wal);
    }, 'backup_freshness_rejected',
    'captured-write-sequence-behind-acknowledged-watermark');

    expectRejected('untrusted hot journal', () => {
      fs.writeFileSync(`${fixture.filename}-journal`, Buffer.alloc(4096, 0x5a));
    }, 'backup_freshness_rejected',
    'captured-write-sequence-behind-acknowledged-watermark');

    expectRejected('missing freshness ACK', () => {
      fs.rmSync(fixture.acknowledgementFilename, { force: true });
      const size = fs.statSync(fixture.filename).size;
      fs.truncateSync(fixture.filename, Math.max(1, Math.floor(size / 2)));
    }, 'backup_freshness_fence_unavailable');

    for (const [name, replacement] of [
      ['missing SHM', null],
      ['zero SHM', Buffer.alloc(0)],
      ['mismatched SHM', Buffer.from('untrusted-shm-bytes')],
    ]) {
      restoreSnapshot();
      if (replacement === null) fs.rmSync(`${fixture.filename}-shm`, { force: true });
      else fs.writeFileSync(`${fixture.filename}-shm`, replacement);
      database = new ProjectDatabase(fixture.filename, { autoBackup: false });
      const reopened = database.getCanvas('physical-active-set-canvas');
      assert.equal(reopened.revision, 2, name);
      assert.deepEqual(reopened.nodes[0].position, { x: 17, y: 17 }, name);
      assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok', name);
      assert.deepEqual(database.db.pragma('foreign_key_check'), [], name);
      await database.close();
      database = null;
    }
  } finally {
    await closeQuietly(database);
    cleanup(fixture.directory);
  }
});

test('B2 schema32 one-bit page corruption rejects stale recovery without rewriting protected evidence', {
  timeout: 120_000,
}, async () => {
  const fixture = temporaryProject('t8-schema32-page-bitflip-');
  let database = null;
  try {
    database = new ProjectDatabase(fixture.filename, {
      autoBackup: false,
      backupFilename: fixture.backupFilename,
      projectDatabaseStoragePolicy32: storagePolicy(),
    });
    let document = database.ensureCanvas('page-bitflip-canvas', {
      nodes: [{ id: 'node-a', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    await database.createBackup();
    document = database.applyOperations(
      'page-bitflip-canvas',
      [move('page-bitflip-newer-primary', 29)],
      { expectedRevision: document.revision },
    ).document;
    assert.equal(document.revision, 2);
    assert.equal(checkpointProjectDatabaseWal32(database.db, 'TRUNCATE').complete, true);
    await database.close();
    database = null;

    const fault = flipFirstSchemaBtreePageTypeBit(fixture.filename);
    assert.equal(fault.offset, 100);
    assert.equal((fault.before ^ fault.after), 0x01);
    const protectedBefore = protectedArtifactDigests(fixture);
    let failure = null;
    assert.throws(
      () => {
        database = new ProjectDatabase(fixture.filename, {
          autoBackup: false,
          backupFilename: fixture.backupFilename,
        });
      },
      (error) => {
        failure = error;
        return error instanceof ProjectDatabaseRecoveryError
          && error.code === 'project_database_recovery_failed'
          && error.details?.phase === 'backup_freshness_rejected'
          && error.details?.freshnessReasons?.includes(
            'captured-write-sequence-behind-acknowledged-watermark',
          );
      },
    );
    database = null;
    assert.ok(failure);
    assert.deepEqual(protectedArtifactDigests(fixture), protectedBefore);
    assert.equal(Array.isArray(failure.details?.primaryEvidence), true);
    assert.equal(failure.details.primaryEvidence.length >= 1, true);
    assert.equal(fs.existsSync(failure.details.restoreTemp), true);
  } finally {
    await closeQuietly(database);
    cleanup(fixture.directory);
  }
});

test('B2 schema32 foreign-key orphan is rejected on cold open and candidate validation without mutation', {
  timeout: 120_000,
}, async () => {
  const fixture = temporaryProject('t8-schema32-foreign-key-orphan-');
  const candidateFilename = path.join(fixture.directory, 'orphan-candidate.sqlite3');
  let database = null;
  let validator = null;
  try {
    database = new ProjectDatabase(fixture.filename, {
      autoBackup: false,
      backupFilename: fixture.backupFilename,
      projectDatabaseStoragePolicy32: storagePolicy(),
    });
    database.ensureCanvas('foreign-key-orphan-canvas', { nodes: [], edges: [] });
    await database.createBackup();
    assert.equal(checkpointProjectDatabaseWal32(database.db, 'TRUNCATE').complete, true);
    await database.close();
    database = null;

    const offline = new BetterSqlite3(fixture.filename);
    try {
      offline.pragma('foreign_keys = OFF');
      offline.prepare(`
        INSERT INTO asset_tags(asset_id, tag, created_at)
        VALUES (?, ?, ?)
      `).run('missing-asset-for-fk-fault', 'offline-orphan', 1_700_000_000_000);
      assert.equal(offline.pragma('foreign_key_check').length, 1);
      offline.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      offline.close();
    }
    fs.copyFileSync(fixture.filename, candidateFilename, fs.constants.COPYFILE_EXCL);
    const protectedBefore = protectedArtifactDigests(fixture, [candidateFilename]);

    assert.throws(
      () => {
        database = new ProjectDatabase(fixture.filename, {
          autoBackup: false,
          backupFilename: fixture.backupFilename,
        });
      },
      (error) => error instanceof ProjectDatabaseSchemaInvalidError
        && error.code === 'project_database_schema_invalid'
        && /外键/.test(String(error.message)),
    );
    database = null;
    assert.deepEqual(protectedArtifactDigests(fixture, [candidateFilename]), protectedBefore);

    validator = new ProjectDatabase(':memory:', { autoBackup: false });
    assert.throws(
      () => validator.validateRecoveryCandidate(candidateFilename),
      (error) => error instanceof ProjectDatabaseSchemaInvalidError
        && error.code === 'project_database_schema_invalid'
        && /foreign_key_check/.test(String(error.message)),
    );
    assert.deepEqual(protectedArtifactDigests(fixture, [candidateFilename]), protectedBefore);
  } finally {
    await closeQuietly(database);
    await closeQuietly(validator);
    cleanup(fixture.directory);
  }
});
