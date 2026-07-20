const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');
const {
  PROJECT_DATABASE_SCHEMA_VERSION,
  READONLY_SCHEMA_PREFLIGHT_MEMORY_LIMIT_BYTES,
  ProjectDatabase,
  ProjectDatabaseRecoveryError,
  ProjectDatabaseSchemaInvalidError,
  ProjectDatabaseSchemaTooNewError,
} = require('../backend/src/services/projectDatabase');

function temporaryProject(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filename = path.join(directory, 'projects.sqlite3');
  return {
    directory,
    filename,
    backupFilename: `${filename}.backup`,
    generationFilename: `${filename}.recovery-generation.json`,
  };
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function readPreflightTempEntries() {
  return fs.readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('t8-project-db-readonly-preflight-'))
    .sort();
}

function fileSha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function readOwnedBackupTempEntries(backupFilename) {
  const directory = path.dirname(backupFilename);
  const prefix = `.${path.basename(backupFilename)}.owned-`;
  return fs.readdirSync(directory).filter((name) => name.startsWith(prefix)).sort();
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function move(opId, x, actorId = 'member') {
  return {
    opId,
    actorId,
    sessionId: `${actorId}-session`,
    clientSeq: x + 1,
    type: 'node.move',
    payload: { nodeId: 'node-a', position: { x, y: x } },
  };
}

test('future schema fails closed before sidecar creation, migration or interrupted-Run recovery', () => {
  const fixture = temporaryProject('t8-b2-future-schema-');
  try {
    let database = new ProjectDatabase(fixture.filename, { autoBackup: false });
    const canvas = database.ensureCanvas('canvas-a', { nodes: [], edges: [] });
    const run = database.createRun({
      projectId: canvas.projectId,
      canvasId: canvas.canvasId,
      canvasRevision: canvas.revision,
      status: 'running',
    });
    database.close();
    fs.rmSync(fixture.generationFilename, { force: true });

    const raw = new BetterSqlite3(fixture.filename);
    raw.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(PROJECT_DATABASE_SCHEMA_VERSION + 1, Date.now());
    raw.close();
    const protectedArtifacts = [
      fixture.filename,
      `${fixture.filename}-journal`,
      `${fixture.filename}-wal`,
      `${fixture.filename}-shm`,
    ];
    const artifactState = (filename) => {
      if (!fs.existsSync(filename)) return null;
      const stat = fs.statSync(filename, { bigint: true });
      return { size: stat.size, mtimeNs: stat.mtimeNs };
    };
    const artifactsBefore = protectedArtifacts.map(artifactState);
    const tempEntriesBefore = readPreflightTempEntries();

    let migrationReached = false;
    assert.throws(
      () => new ProjectDatabase(fixture.filename, {
        autoBackup: false,
        beforeMigrationCommit: () => { migrationReached = true; },
      }),
      (error) => error instanceof ProjectDatabaseSchemaTooNewError
        && error.code === 'project_database_schema_too_new'
        && error.foundVersion === PROJECT_DATABASE_SCHEMA_VERSION + 1,
    );
    assert.equal(migrationReached, false);
    assert.equal(fs.existsSync(fixture.generationFilename), false);
    assert.deepEqual(protectedArtifacts.map(artifactState), artifactsBefore);
    assert.deepEqual(readPreflightTempEntries(), tempEntriesBefore);

    const verify = new BetterSqlite3(fixture.filename, { readonly: true, fileMustExist: true });
    assert.equal(
      verify.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      PROJECT_DATABASE_SCHEMA_VERSION + 1,
    );
    assert.equal(verify.prepare('SELECT status FROM runs WHERE id = ?').get(run.id).status, 'running');
    verify.close();
  } finally {
    cleanup(fixture.directory);
  }
});

test('future schema committed only in WAL is inspected from an isolated copy and leaves primary artifacts untouched', () => {
  const fixture = temporaryProject('t8-b2-future-schema-wal-');
  let writer = null;
  try {
    const database = new ProjectDatabase(fixture.filename, { autoBackup: false });
    database.close();
    fs.rmSync(fixture.generationFilename, { force: true });

    writer = new BetterSqlite3(fixture.filename);
    writer.pragma('wal_autocheckpoint = 0');
    writer.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(PROJECT_DATABASE_SCHEMA_VERSION + 1, Date.now());
    assert.equal(fs.statSync(`${fixture.filename}-wal`).size > 0, true);
    const protectedArtifacts = [
      fixture.filename,
      `${fixture.filename}-journal`,
      `${fixture.filename}-wal`,
      `${fixture.filename}-shm`,
    ];
    const artifactState = (filename) => {
      if (!fs.existsSync(filename)) return null;
      const stat = fs.statSync(filename, { bigint: true });
      return { size: stat.size, mtimeNs: stat.mtimeNs };
    };
    const artifactsBefore = protectedArtifacts.map(artifactState);
    const tempEntriesBefore = readPreflightTempEntries();

    assert.throws(
      () => new ProjectDatabase(fixture.filename, { autoBackup: false }),
      (error) => error instanceof ProjectDatabaseSchemaTooNewError
        && error.foundVersion === PROJECT_DATABASE_SCHEMA_VERSION + 1,
    );
    assert.equal(fs.existsSync(fixture.generationFilename), false);
    assert.deepEqual(protectedArtifacts.map(artifactState), artifactsBefore);
    assert.deepEqual(readPreflightTempEntries(), tempEntriesBefore);
  } finally {
    try { writer?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('migration ledger gaps fail closed before active open, sidecar creation, or migration repair', () => {
  const fixture = temporaryProject('t8-b2-schema-ledger-gap-');
  try {
    const database = new ProjectDatabase(fixture.filename, { autoBackup: false });
    database.close();
    fs.rmSync(fixture.generationFilename, { force: true });

    const raw = new BetterSqlite3(fixture.filename);
    raw.prepare('DELETE FROM schema_migrations WHERE version = ?').run(10);
    raw.close();
    const protectedArtifacts = [
      fixture.filename,
      `${fixture.filename}-journal`,
      `${fixture.filename}-wal`,
      `${fixture.filename}-shm`,
    ];
    const artifactState = (filename) => {
      if (!fs.existsSync(filename)) return null;
      const stat = fs.statSync(filename, { bigint: true });
      return { size: stat.size, mtimeNs: stat.mtimeNs };
    };
    const artifactsBefore = protectedArtifacts.map(artifactState);
    const tempEntriesBefore = readPreflightTempEntries();
    let migrationReached = false;

    assert.throws(
      () => new ProjectDatabase(fixture.filename, {
        autoBackup: false,
        beforeMigrationCommit: () => { migrationReached = true; },
      }),
      (error) => error instanceof ProjectDatabaseSchemaInvalidError
        && error.code === 'project_database_schema_invalid'
        && error.details?.minimum === 1
        && error.details?.maximum === PROJECT_DATABASE_SCHEMA_VERSION
        && error.details?.count === PROJECT_DATABASE_SCHEMA_VERSION - 1,
    );
    assert.equal(migrationReached, false);
    assert.equal(fs.existsSync(fixture.generationFilename), false);
    assert.deepEqual(protectedArtifacts.map(artifactState), artifactsBefore);
    assert.deepEqual(readPreflightTempEntries(), tempEntriesBefore);

    const verify = new BetterSqlite3(fixture.filename, { readonly: true, fileMustExist: true });
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 10').get().count, 0);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, PROJECT_DATABASE_SCHEMA_VERSION - 1);
    verify.close();
  } finally {
    cleanup(fixture.directory);
  }
});

test('malformed migration ledger contracts and duplicate version sets fail in read-only preflight', () => {
  for (const malformed of ['duplicate-versions', 'missing-applied-at']) {
    const fixture = temporaryProject(`t8-b2-schema-ledger-${malformed}-`);
    try {
      const raw = new BetterSqlite3(fixture.filename);
      if (malformed === 'duplicate-versions') {
        raw.exec(`
          CREATE TABLE schema_migrations(version INTEGER NOT NULL, applied_at INTEGER NOT NULL);
        `);
        const insert = raw.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)');
        insert.run(1, Date.now());
        insert.run(1, Date.now());
        for (let version = 3; version <= PROJECT_DATABASE_SCHEMA_VERSION; version += 1) {
          insert.run(version, Date.now());
        }
      } else {
        raw.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)');
        raw.prepare('INSERT INTO schema_migrations(version) VALUES (1)').run();
      }
      raw.close();

      const primaryBefore = fileSha256(fixture.filename);
      const tempEntriesBefore = readPreflightTempEntries();
      let migrationReached = false;
      assert.throws(
        () => new ProjectDatabase(fixture.filename, {
          autoBackup: false,
          beforeMigrationCommit: () => { migrationReached = true; },
        }),
        (error) => error instanceof ProjectDatabaseSchemaInvalidError
          && error.code === 'project_database_schema_invalid'
          && /表结构/.test(error.message),
      );
      assert.equal(migrationReached, false);
      assert.equal(fs.existsSync(fixture.generationFilename), false);
      assert.equal(fileSha256(fixture.filename), primaryBefore);
      assert.deepEqual(readPreflightTempEntries(), tempEntriesBefore);
    } finally {
      cleanup(fixture.directory);
    }
  }
});

test('large future-schema databases use a bounded-memory isolated snapshot and clean system temp', () => {
  const fixture = temporaryProject('t8-b2-future-schema-large-');
  try {
    const database = new ProjectDatabase(fixture.filename, { autoBackup: false });
    database.close();
    fs.rmSync(fixture.generationFilename, { force: true });

    const raw = new BetterSqlite3(fixture.filename);
    raw.exec('CREATE TABLE b2_large_preflight_fixture(payload BLOB NOT NULL)');
    raw.prepare('INSERT INTO b2_large_preflight_fixture(payload) VALUES (zeroblob(?))')
      .run(READONLY_SCHEMA_PREFLIGHT_MEMORY_LIMIT_BYTES + (1024 * 1024));
    raw.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(PROJECT_DATABASE_SCHEMA_VERSION + 1, Date.now());
    raw.close();
    assert.equal(
      fs.statSync(fixture.filename).size > READONLY_SCHEMA_PREFLIGHT_MEMORY_LIMIT_BYTES,
      true,
    );

    const protectedArtifacts = [
      fixture.filename,
      `${fixture.filename}-journal`,
      `${fixture.filename}-wal`,
      `${fixture.filename}-shm`,
    ];
    const artifactState = (filename) => {
      if (!fs.existsSync(filename)) return null;
      const stat = fs.statSync(filename, { bigint: true });
      return { size: stat.size, mtimeNs: stat.mtimeNs };
    };
    const artifactsBefore = protectedArtifacts.map(artifactState);
    const tempEntriesBefore = readPreflightTempEntries();

    assert.throws(
      () => new ProjectDatabase(fixture.filename, { autoBackup: false }),
      (error) => error instanceof ProjectDatabaseSchemaTooNewError
        && error.foundVersion === PROJECT_DATABASE_SCHEMA_VERSION + 1,
    );
    assert.equal(fs.existsSync(fixture.generationFilename), false);
    assert.deepEqual(protectedArtifacts.map(artifactState), artifactsBefore);
    assert.deepEqual(readPreflightTempEntries(), tempEntriesBefore);
  } finally {
    cleanup(fixture.directory);
  }
});

test('new paths, zero-byte placeholders, and memory databases initialize independently', () => {
  const fresh = temporaryProject('t8-b2-fresh-database-');
  const empty = temporaryProject('t8-b2-empty-database-');
  let freshDatabase = null;
  let emptyDatabase = null;
  let memoryDatabase = null;
  try {
    fs.writeFileSync(empty.filename, Buffer.alloc(0));
    freshDatabase = new ProjectDatabase(fresh.filename, { autoBackup: false });
    emptyDatabase = new ProjectDatabase(empty.filename, { autoBackup: false });
    memoryDatabase = new ProjectDatabase(':memory:');

    freshDatabase.ensureCanvas('fresh-canvas', { nodes: [], edges: [] });
    emptyDatabase.ensureCanvas('empty-canvas', { nodes: [], edges: [] });
    memoryDatabase.ensureCanvas('memory-canvas', { nodes: [], edges: [] });
    for (const database of [freshDatabase, emptyDatabase, memoryDatabase]) {
      assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
      assert.equal(
        database.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
        PROJECT_DATABASE_SCHEMA_VERSION,
      );
    }
    assert.equal(freshDatabase.getCanvas('empty-canvas'), null);
    assert.equal(emptyDatabase.getCanvas('memory-canvas'), null);
    assert.equal(memoryDatabase.getCanvas('fresh-canvas'), null);
  } finally {
    try { freshDatabase?.close(); } catch (_) {}
    try { emptyDatabase?.close(); } catch (_) {}
    try { memoryDatabase?.close(); } catch (_) {}
    cleanup(fresh.directory);
    cleanup(empty.directory);
  }
});

test('invalid primary and invalid backup fail with identifiable recovery evidence and never create an empty database', () => {
  const fixture = temporaryProject('t8-b2-broken-backup-');
  try {
    fs.writeFileSync(fixture.filename, 'broken-primary');
    fs.writeFileSync(fixture.backupFilename, 'broken-backup');
    let failure = null;
    assert.throws(() => new ProjectDatabase(fixture.filename, {
      backupFilename: fixture.backupFilename,
      autoBackup: false,
    }), (error) => {
      failure = error;
      return error instanceof ProjectDatabaseRecoveryError
        && error.code === 'project_database_recovery_failed'
        && error.details?.phase === 'backup_invalid';
    });
    assert.equal(fs.readFileSync(fixture.filename, 'utf8'), 'broken-primary');
    assert.equal(fs.existsSync(failure.details.backupEvidence), true);
    assert.equal(fs.readFileSync(failure.details.backupEvidence, 'utf8'), 'broken-backup');
    assert.equal(failure.details.primaryEvidence.length >= 1, true);
    assert.equal(fs.readFileSync(failure.details.primaryEvidence[0], 'utf8'), 'broken-primary');
  } finally {
    cleanup(fixture.directory);
  }
});

test('quick_check alone is insufficient: an uninitialized SQLite backup is rejected by schema validation', () => {
  const fixture = temporaryProject('t8-b2-backup-schema-');
  try {
    fs.writeFileSync(fixture.filename, 'broken-primary');
    const backup = new BetterSqlite3(fixture.backupFilename);
    backup.exec('CREATE TABLE unrelated(id INTEGER PRIMARY KEY)');
    assert.equal(backup.pragma('quick_check', { simple: true }), 'ok');
    backup.close();
    assert.throws(() => new ProjectDatabase(fixture.filename, {
      backupFilename: fixture.backupFilename,
      autoBackup: false,
    }), (error) => error instanceof ProjectDatabaseRecoveryError
      && error.details?.phase === 'backup_invalid'
      && error.cause?.code === 'project_database_schema_invalid');
  } finally {
    cleanup(fixture.directory);
  }
});

test('schema32 stale canonical backup cannot roll a newer acknowledged revision back', async () => {
  const fixture = temporaryProject('t8-b2-recovery-generation-');
  try {
    let database = new ProjectDatabase(fixture.filename, {
      backupFilename: fixture.backupFilename,
      autoBackup: false,
    });
    const generationBefore = database.getRecoveryGeneration();
    database.ensureCanvas('canvas-a', {
      nodes: [{ id: 'node-a', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    await database.createBackup();
    const staleClient = database.applyOperations('canvas-a', [move('old-revision-2', 10)], {
      expectedRevision: 1,
    }).document;
    assert.equal(staleClient.revision, 2);
    await database.close();
    const generationStateBefore = fs.readFileSync(fixture.generationFilename);
    const backupHashBefore = fileSha256(fixture.backupFilename);
    const brokenPrimary = Buffer.from('broken-primary-after-acknowledged-revision-2');
    fs.writeFileSync(fixture.filename, brokenPrimary);

    let failure = null;
    assert.throws(() => new ProjectDatabase(fixture.filename, {
      backupFilename: fixture.backupFilename,
      autoBackup: false,
    }), (error) => {
      failure = error;
      return error instanceof ProjectDatabaseRecoveryError
        && error.code === 'project_database_recovery_failed'
        && error.status === 503
        && error.details?.phase === 'backup_freshness_rejected'
        && error.details?.freshnessStatus === 'rejected'
        && error.details?.capturedWriteSequence < error.details?.acknowledgedWriteSequence;
    });
    assert.deepEqual(fs.readFileSync(fixture.generationFilename), generationStateBefore);
    assert.equal(JSON.parse(generationStateBefore.toString('utf8')).generation, generationBefore);
    assert.equal(fileSha256(fixture.backupFilename), backupHashBefore);
    assert.deepEqual(fs.readFileSync(fixture.filename), brokenPrimary);
    assert.equal(fs.existsSync(failure.details.restoreTemp), true);
    assert.equal(failure.details.backupEvidence, fixture.backupFilename);
    const candidate = new BetterSqlite3(failure.details.restoreTemp, { readonly: true, fileMustExist: true });
    try {
      assert.equal(candidate.prepare(`
        SELECT revision FROM canvas_documents WHERE canvas_id = ?
      `).get('canvas-a').revision, 1);
      assert.equal(candidate.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      candidate.close();
    }
  } finally {
    cleanup(fixture.directory);
  }
});

test('freshness gate runs before the legacy recovery replace hook and never rotates generation', async () => {
  const fixture = temporaryProject('t8-b2-recovery-interruption-');
  try {
    let database = new ProjectDatabase(fixture.filename, {
      backupFilename: fixture.backupFilename,
      autoBackup: false,
    });
    const firstGeneration = database.getRecoveryGeneration();
    database.ensureCanvas('canvas-a', {
      nodes: [{ id: 'node-a', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    await database.createBackup();
    database.applyOperations('canvas-a', [move('post-backup-revision-2', 20)], {
      expectedRevision: 1,
    });
    await database.close();
    const generationStateBefore = fs.readFileSync(fixture.generationFilename);
    const backupHashBefore = fileSha256(fixture.backupFilename);
    const brokenPrimary = Buffer.from('broken-primary-before-freshness-gate');
    fs.writeFileSync(fixture.filename, brokenPrimary);

    let replaceHookReached = false;
    let failure = null;
    assert.throws(() => new ProjectDatabase(fixture.filename, {
      backupFilename: fixture.backupFilename,
      autoBackup: false,
      beforeDatabaseRecoveryReplace: () => { replaceHookReached = true; },
    }), (error) => {
      failure = error;
      return error instanceof ProjectDatabaseRecoveryError
        && error.details?.phase === 'backup_freshness_rejected'
        && error.details?.freshnessStatus === 'rejected'
        && error.details?.capturedWriteSequence < error.details?.acknowledgedWriteSequence;
    });
    assert.equal(replaceHookReached, false);
    assert.deepEqual(fs.readFileSync(fixture.generationFilename), generationStateBefore);
    assert.equal(JSON.parse(generationStateBefore.toString('utf8')).generation, firstGeneration);
    assert.equal(fileSha256(fixture.backupFilename), backupHashBefore);
    assert.deepEqual(fs.readFileSync(fixture.filename), brokenPrimary);
    assert.equal(fs.existsSync(failure.details.restoreTemp), true);
  } finally {
    cleanup(fixture.directory);
  }
});

test('owned temp backup failures preserve the previous canonical backup and clean only their candidate', async () => {
  const fixture = temporaryProject('t8-b2-atomic-backup-failures-');
  let failurePhase = null;
  let database = null;
  try {
    database = new ProjectDatabase(fixture.filename, {
      backupFilename: fixture.backupFilename,
      autoBackup: false,
      beforeDatabaseBackupWrite: ({ candidateFilename }) => {
        if (failurePhase !== 'write') return;
        fs.writeFileSync(candidateFilename, Buffer.from('partial-backup-before-enospc'));
        throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
      },
      beforeDatabaseBackupValidation: ({ candidateFilename }) => {
        if (failurePhase !== 'validation') return;
        fs.writeFileSync(candidateFilename, Buffer.from('not-a-valid-sqlite-backup'));
      },
      beforeDatabaseBackupReplace: () => {
        if (failurePhase === 'before_replace') throw new Error('simulated interruption before replace');
      },
    });
    let document = database.ensureCanvas('canvas-backup-failure', {
      nodes: [{ id: 'node-a', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    await database.createBackup();
    const knownGoodHash = fileSha256(fixture.backupFilename);
    document = database.applyOperations('canvas-backup-failure', [move('backup-new-state', 10)], {
      expectedRevision: document.revision,
    }).document;
    assert.equal(document.revision, 2);

    for (const scenario of [
      {
        phase: 'write',
        expectedPhase: 'write',
        code: 'project_database_storage_capacity_exceeded',
        reason: 'backup-storage-full',
      },
      { phase: 'validation', expectedPhase: 'validation' },
      { phase: 'before_replace', expectedPhase: 'before_replace' },
    ]) {
      failurePhase = scenario.phase;
      await assert.rejects(database.createBackup(), (error) => (
        error?.projectDatabaseBackupPhase === scenario.expectedPhase
        && (!scenario.code || error?.code === scenario.code)
        && (!scenario.reason || error?.reason === scenario.reason)
      ));
      assert.equal(fileSha256(fixture.backupFilename), knownGoodHash);
      assert.deepEqual(readOwnedBackupTempEntries(fixture.backupFilename), []);
      assert.equal(database.validateRecoveryCandidate(fixture.backupFilename).schemaVersion, PROJECT_DATABASE_SCHEMA_VERSION);
    }

    const canonical = new BetterSqlite3(fixture.backupFilename, { readonly: true, fileMustExist: true });
    const stored = JSON.parse(canonical.prepare(
      'SELECT snapshot_json FROM canvas_documents WHERE canvas_id = ?',
    ).get('canvas-backup-failure').snapshot_json);
    assert.deepEqual(stored.nodes[0].position, { x: 0, y: 0 });
    canonical.close();
  } finally {
    try { await database?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('validated backup atomically replaces the canonical file and leaves no owned temp', async () => {
  const fixture = temporaryProject('t8-b2-atomic-backup-success-');
  let database = null;
  try {
    database = new ProjectDatabase(fixture.filename, {
      backupFilename: fixture.backupFilename,
      autoBackup: false,
    });
    let document = database.ensureCanvas('canvas-backup-success', {
      nodes: [{ id: 'node-a', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    await database.createBackup();
    const oldHash = fileSha256(fixture.backupFilename);

    document = database.applyOperations('canvas-backup-success', [move('backup-success-state', 25)], {
      expectedRevision: document.revision,
    }).document;
    const result = await database.createBackup();
    assert.equal(result.filename, fixture.backupFilename);
    assert.equal(result.schemaVersion, PROJECT_DATABASE_SCHEMA_VERSION);
    assert.notEqual(fileSha256(fixture.backupFilename), oldHash);
    assert.deepEqual(readOwnedBackupTempEntries(fixture.backupFilename), []);

    const canonical = new BetterSqlite3(fixture.backupFilename, { readonly: true, fileMustExist: true });
    const stored = JSON.parse(canonical.prepare(
      'SELECT snapshot_json FROM canvas_documents WHERE canvas_id = ?',
    ).get('canvas-backup-success').snapshot_json);
    assert.deepEqual(stored.nodes[0].position, { x: 25, y: 25 });
    assert.equal(canonical.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(canonical.pragma('foreign_key_check'), []);
    canonical.close();
  } finally {
    try { await database?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('a future-schema backup candidate is rejected before it can replace a known-good backup', async () => {
  const fixture = temporaryProject('t8-b2-backup-future-schema-');
  let injectFutureSchema = false;
  let database = null;
  try {
    database = new ProjectDatabase(fixture.filename, {
      backupFilename: fixture.backupFilename,
      autoBackup: false,
      beforeDatabaseBackupValidation: ({ candidateFilename }) => {
        if (!injectFutureSchema) return;
        const candidate = new BetterSqlite3(candidateFilename);
        candidate.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(PROJECT_DATABASE_SCHEMA_VERSION + 1, Date.now());
        candidate.close();
      },
    });
    database.ensureCanvas('canvas-future-backup', { nodes: [], edges: [] });
    await database.createBackup();
    const knownGoodHash = fileSha256(fixture.backupFilename);

    injectFutureSchema = true;
    await assert.rejects(database.createBackup(), (error) => (
      error instanceof ProjectDatabaseSchemaTooNewError
      && error.foundVersion === PROJECT_DATABASE_SCHEMA_VERSION + 1
      && error.projectDatabaseBackupPhase === 'validation'
    ));
    assert.equal(fileSha256(fixture.backupFilename), knownGoodHash);
    assert.deepEqual(readOwnedBackupTempEntries(fixture.backupFilename), []);
    assert.equal(database.validateRecoveryCandidate(fixture.backupFilename).schemaVersion, PROJECT_DATABASE_SCHEMA_VERSION);
  } finally {
    try { await database?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('close waits for the tracked startup backup before closing the native database handle', async () => {
  const fixture = temporaryProject('t8-b2-backup-close-wait-');
  let releaseBackup;
  let markBackupEntered;
  const backupEntered = new Promise((resolve) => { markBackupEntered = resolve; });
  const backupGate = new Promise((resolve) => { releaseBackup = resolve; });
  let database = null;
  try {
    database = new ProjectDatabase(fixture.filename, {
      backupFilename: fixture.backupFilename,
      beforeDatabaseBackupWrite: async () => {
        markBackupEntered();
        await backupGate;
      },
    });
    await backupEntered;
    assert.equal(database.waitForBackup(), database.backupPromise);

    let closeSettled = false;
    const closePromise = database.close().then(() => { closeSettled = true; });
    await nextTurn();
    assert.equal(closeSettled, false);
    assert.equal(database.db.open, true);

    releaseBackup();
    await closePromise;
    assert.equal(database.db.open, false);
    assert.equal(fs.existsSync(fixture.backupFilename), true);
    const canonical = new BetterSqlite3(fixture.backupFilename, { readonly: true, fileMustExist: true });
    assert.equal(canonical.pragma('quick_check', { simple: true }), 'ok');
    canonical.close();
  } finally {
    releaseBackup?.();
    try { await database?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('close waits for every backup already queued on the instance, not only the active transfer', async () => {
  const fixture = temporaryProject('t8-b2-backup-close-queue-');
  let releaseFirst;
  let releaseSecond;
  let markFirstEntered;
  let markSecondEntered;
  const firstEntered = new Promise((resolve) => { markFirstEntered = resolve; });
  const secondEntered = new Promise((resolve) => { markSecondEntered = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  let invocation = 0;
  let database = null;
  try {
    database = new ProjectDatabase(fixture.filename, {
      backupFilename: fixture.backupFilename,
      autoBackup: false,
      beforeDatabaseBackupWrite: async () => {
        invocation += 1;
        if (invocation === 1) {
          markFirstEntered();
          await firstGate;
        } else if (invocation === 2) {
          markSecondEntered();
          await secondGate;
        }
      },
    });
    database.ensureCanvas('canvas-close-queue', { nodes: [], edges: [] });
    const firstBackup = database.createBackup();
    const secondBackup = database.createBackup();
    await firstEntered;

    let closeSettled = false;
    const closePromise = database.close().then(() => { closeSettled = true; });
    releaseFirst();
    await firstBackup;
    await secondEntered;
    await nextTurn();
    assert.equal(closeSettled, false);
    assert.equal(database.db.open, true);

    releaseSecond();
    await Promise.all([secondBackup, closePromise]);
    assert.equal(database.db.open, false);
    assert.deepEqual(readOwnedBackupTempEntries(fixture.backupFilename), []);
    const canonical = new BetterSqlite3(fixture.backupFilename, { readonly: true, fileMustExist: true });
    assert.equal(canonical.pragma('quick_check', { simple: true }), 'ok');
    canonical.close();
  } finally {
    releaseFirst?.();
    releaseSecond?.();
    try { await database?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('concurrent startup backups use distinct owned temps and serialize canonical replacement', async () => {
  const fixture = temporaryProject('t8-b2-backup-concurrent-startup-');
  let releaseFirst;
  let markFirstEntered;
  let markSecondEntered;
  const firstEntered = new Promise((resolve) => { markFirstEntered = resolve; });
  const secondEntered = new Promise((resolve) => { markSecondEntered = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const candidateFilenames = [];
  let first = null;
  let second = null;
  try {
    first = new ProjectDatabase(fixture.filename, {
      backupFilename: fixture.backupFilename,
      unsafeDisableOwnerGuardForTests: true,
      beforeDatabaseBackupWrite: async ({ candidateFilename }) => {
        candidateFilenames.push(candidateFilename);
        markFirstEntered();
        await firstGate;
      },
    });
    first.ensureCanvas('canvas-concurrent-backup', { nodes: [], edges: [] });
    second = new ProjectDatabase(fixture.filename, {
      backupFilename: fixture.backupFilename,
      unsafeDisableOwnerGuardForTests: true,
      beforeDatabaseBackupWrite: ({ candidateFilename }) => {
        candidateFilenames.push(candidateFilename);
        markSecondEntered();
      },
    });

    await firstEntered;
    await nextTurn();
    assert.equal(candidateFilenames.length, 1);
    assert.equal(readOwnedBackupTempEntries(fixture.backupFilename).length, 1);

    releaseFirst();
    await secondEntered;
    await Promise.all([first.waitForBackup(), second.waitForBackup()]);
    assert.equal(candidateFilenames.length, 2);
    assert.notEqual(candidateFilenames[0], candidateFilenames[1]);
    assert.deepEqual(readOwnedBackupTempEntries(fixture.backupFilename), []);

    const canonical = new BetterSqlite3(fixture.backupFilename, { readonly: true, fileMustExist: true });
    assert.equal(canonical.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(canonical.pragma('foreign_key_check'), []);
    assert.equal(
      canonical.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      PROJECT_DATABASE_SCHEMA_VERSION,
    );
    canonical.close();
  } finally {
    releaseFirst?.();
    try { await first?.close(); } catch (_) {}
    try { await second?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('operation snapshots are based on distance from the last snapshot and cannot be skipped by two-op batches', () => {
  const database = new ProjectDatabase(':memory:');
  try {
    let document = database.ensureCanvas('canvas-snapshot-threshold', {
      nodes: [{ id: 'node-a', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    for (let batch = 0; batch < 100; batch += 1) {
      const operations = [0, 1].map((offset) => ({
        opId: `threshold-${batch}-${offset}`,
        actorId: 'threshold-member',
        sessionId: 'threshold-session',
        clientSeq: batch * 2 + offset + 1,
        type: 'node.patch',
        payload: { nodeId: 'node-a', dataPatch: { marker: batch * 2 + offset } },
      }));
      document = database.applyOperations('canvas-snapshot-threshold', operations, {
        expectedRevision: document.revision,
      }).document;
    }
    assert.equal(document.revision, 201);
    assert.deepEqual(
      database.db.prepare(`
        SELECT revision, reason FROM canvas_snapshots
        WHERE canvas_id = ? AND reason = 'operation-checkpoint'
        ORDER BY revision
      `).all('canvas-snapshot-threshold'),
      [
        { revision: 101, reason: 'operation-checkpoint' },
        { revision: 201, reason: 'operation-checkpoint' },
      ],
    );
  } finally {
    database.close();
  }
});

test('listed and startup-recovery RunEvents always expose stable non-null entityUid values', () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const canvas = database.ensureCanvas('run-event-canvas', {
      nodes: [{ id: 'recoverable-node', type: 'image', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    const run = database.createRun({
      projectId: canvas.projectId,
      canvasId: canvas.canvasId,
      canvasRevision: canvas.revision,
      status: 'running',
    });
    const appended = database.appendRunEvent(run.id, { type: 'provider.request', payload: {} });
    assert.equal(database.getRunEvents(run.id)[0].entityUid, appended.entityUid);

    const nodeRun = database.createNodeRun({ runId: run.id, nodeId: 'recoverable-node', status: 'polling' });
    database.createAttempt({
      nodeRunId: nodeRun.id,
      provider: 'seedance-nz',
      model: 'wan-test',
      upstreamTaskId: 'recoverable-task',
      status: 'polling',
      metadata: { recovery: { kind: 'wan', taskId: 'recoverable-task', model: 'wan-test' } },
    });
    database.recoverInterruptedRuns();
    database.recoverInterruptedRuns();
    const queued = database.db.prepare(`
      SELECT entity_uid FROM run_events
      WHERE run_id = ? AND payload_json LIKE '%"phase":"recovery.queued"%'
    `).all(run.id);
    assert.equal(queued.length, 1);
    assert.match(queued[0].entity_uid, /^[0-9a-f-]{36}$/);

    const interruptedRun = database.createRun({
      projectId: canvas.projectId,
      canvasId: canvas.canvasId,
      canvasRevision: canvas.revision,
      status: 'running',
    });
    const interruptedNode = database.createNodeRun({
      runId: interruptedRun.id,
      nodeId: 'recoverable-node',
      status: 'running',
    });
    database.createAttempt({ nodeRunId: interruptedNode.id, status: 'running' });
    database.recoverInterruptedRuns();
    const interruptedEvent = database.getRunEvents(interruptedRun.id)
      .find((event) => event.type === 'run.interrupted');
    assert.match(interruptedEvent.entityUid, /^[0-9a-f-]{36}$/);
    assert.equal(
      database.db.prepare('SELECT entity_uid FROM run_events WHERE id = ?').get(interruptedEvent.id).entity_uid,
      interruptedEvent.entityUid,
    );
  } finally {
    database.close();
  }
});
