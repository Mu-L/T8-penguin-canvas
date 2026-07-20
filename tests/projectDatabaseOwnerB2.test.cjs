const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const helperRole = String(process.env.T8_PROJECT_DB_OWNER_HELPER_ROLE || '');

async function runHelperRole() {
  const {
    ProjectDatabase,
  } = require('../backend/src/services/projectDatabase');
  const filename = process.env.T8_PROJECT_DB_OWNER_HELPER_FILE;
  if (!filename) throw new Error('missing helper database filename');
  let database = null;
  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    process.stdout.write(`${JSON.stringify({ type: 'opened', pid: process.pid })}\n`);
    if (helperRole === 'attempt') {
      await database.close();
      process.stdout.write(`${JSON.stringify({ type: 'closed' })}\n`);
      return;
    }
    process.stdin.setEncoding('utf8');
    await new Promise((resolve) => {
      process.stdin.on('data', (chunk) => {
        if (String(chunk).includes('close')) resolve();
      });
      process.stdin.on('end', resolve);
    });
    await database.close();
    process.stdout.write(`${JSON.stringify({ type: 'closed' })}\n`);
  } catch (error) {
    try { await database?.close(); } catch (_) {}
    process.stdout.write(`${JSON.stringify({
      type: 'error',
      code: String(error?.code || ''),
      status: Number(error?.status) || 0,
      name: String(error?.name || ''),
    })}\n`);
    if (helperRole !== 'attempt') process.exitCode = 1;
  }
}

if (helperRole) {
  void runHelperRole().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
} else {
  const test = require('node:test');
  const BetterSqlite3 = require('better-sqlite3');
  const {
    PROJECT_DATABASE_OWNER_GUARD_BASENAME,
    ProjectDatabase,
    ProjectDatabaseOwnerConflictError,
  } = require('../backend/src/services/projectDatabase');

  function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-project-owner-'));
    return {
      directory,
      filename: path.join(directory, 't8-projects.sqlite3'),
      cleanup() {
        fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  }

  function helperProcess(role, filename) {
    return spawn(process.execPath, [__filename], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        T8_PROJECT_DB_OWNER_HELPER_ROLE: role,
        T8_PROJECT_DB_OWNER_HELPER_FILE: filename,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  function waitForMessage(child, predicate, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`helper timeout; stdout=${stdout}; stderr=${stderr}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout.off('data', onStdout);
        child.stderr.off('data', onStderr);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      const inspect = () => {
        for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
          let value;
          try { value = JSON.parse(line); } catch (_) { continue; }
          if (predicate(value)) {
            cleanup();
            resolve(value);
            return true;
          }
        }
        return false;
      };
      const onStdout = (chunk) => {
        stdout += String(chunk);
        inspect();
      };
      const onStderr = (chunk) => { stderr += String(chunk); };
      const onExit = (code, signal) => {
        if (inspect()) return;
        cleanup();
        reject(new Error(`helper exited before message code=${code} signal=${signal}; stdout=${stdout}; stderr=${stderr}`));
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      child.on('exit', onExit);
      child.on('error', onError);
    });
  }

  function waitForExit(child, timeoutMs = 20_000) {
    if (child.exitCode != null || child.signalCode != null) {
      return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('helper exit timeout')), timeoutMs);
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  test('directory owner guard rejects a second ProjectDatabase and releases only after close', async () => {
    const item = fixture();
    let first = null;
    let second = null;
    try {
      first = new ProjectDatabase(item.filename, { autoBackup: false });
      assert.throws(
        () => new ProjectDatabase(path.join(item.directory, 'other.sqlite3'), { autoBackup: false }),
        (error) => error instanceof ProjectDatabaseOwnerConflictError
          && error.code === 'project_database_owner_conflict'
          && error.status === 409
          && !String(error.message).includes(item.directory),
      );
      await first.close();
      first = null;
      second = new ProjectDatabase(item.filename, { autoBackup: false });
      assert.equal(second.db.pragma('quick_check', { simple: true }), 'ok');
      assert.equal(fs.existsSync(path.join(item.directory, PROJECT_DATABASE_OWNER_GUARD_BASENAME)), true);
    } finally {
      await first?.close().catch(() => undefined);
      await second?.close().catch(() => undefined);
      item.cleanup();
    }
  });

  test('legacy v1 owner guard upgrades atomically to v2 without weakening the lifetime lock', async () => {
    const item = fixture();
    const ownerFilename = path.join(item.directory, PROJECT_DATABASE_OWNER_GUARD_BASENAME);
    let raw = null;
    let database = null;
    try {
      raw = new BetterSqlite3(ownerFilename);
      raw.exec(`
        CREATE TABLE project_database_owner_guard (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          owner_token TEXT NOT NULL,
          owner_pid INTEGER NOT NULL,
          acquired_at INTEGER NOT NULL
        ) STRICT
      `);
      raw.pragma('application_id = 1412976707');
      raw.pragma('user_version = 1');
      raw.close();
      raw = null;

      database = new ProjectDatabase(item.filename, { autoBackup: false });
      assert.throws(
        () => new ProjectDatabase(path.join(item.directory, 'contender.sqlite3'), {
          autoBackup: false,
        }),
        (error) => error?.code === 'project_database_owner_conflict',
      );
      await database.close();
      database = null;

      raw = new BetterSqlite3(ownerFilename, { readonly: true, fileMustExist: true });
      assert.equal(raw.pragma('application_id', { simple: true }), 1412976707);
      assert.equal(raw.pragma('user_version', { simple: true }), 2);
      assert.deepEqual(raw.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name ASC
      `).all().map((row) => row.name), [
        'project_database_owner_guard',
        'project_database_schema32_migration_guard',
      ]);
    } finally {
      try { raw?.close(); } catch (_) {}
      await database?.close().catch(() => undefined);
      item.cleanup();
    }
  });

  test('owner guard remains held while close waits for an in-flight backup', async () => {
    const item = fixture();
    let releaseBackup;
    let observeBackup;
    const backupStarted = new Promise((resolve) => { observeBackup = resolve; });
    const backupGate = new Promise((resolve) => { releaseBackup = resolve; });
    let database = null;
    let reopened = null;
    try {
      database = new ProjectDatabase(item.filename, {
        beforeDatabaseBackupWrite: async () => {
          observeBackup();
          await backupGate;
        },
      });
      await backupStarted;
      const closing = database.close();
      assert.throws(
        () => new ProjectDatabase(path.join(item.directory, 'other.sqlite3'), { autoBackup: false }),
        (error) => error?.code === 'project_database_owner_conflict',
      );
      releaseBackup();
      await closing;
      database = null;
      reopened = new ProjectDatabase(item.filename, { autoBackup: false });
    } finally {
      releaseBackup?.();
      await database?.close().catch(() => undefined);
      await reopened?.close().catch(() => undefined);
      item.cleanup();
    }
  });

  test('constructor failure releases the owner guard without weakening schema fail-close', async () => {
    const item = fixture();
    let raw = null;
    let database = null;
    try {
      raw = new BetterSqlite3(item.filename);
      raw.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER)');
      raw.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
        .run(999, 'future-schema', Date.now());
      raw.close();
      raw = null;
      assert.throws(
        () => new ProjectDatabase(item.filename, { autoBackup: false }),
        (error) => error?.code === 'project_database_schema_invalid'
          || error?.code === 'project_database_schema_too_new',
      );
      database = new ProjectDatabase(path.join(item.directory, 'other.sqlite3'), { autoBackup: false });
    } finally {
      try { raw?.close(); } catch (_) {}
      await database?.close().catch(() => undefined);
      item.cleanup();
    }
  });

  test('owner guard path cannot alias the primary database', () => {
    const item = fixture();
    try {
      assert.throws(
        () => new ProjectDatabase(item.filename, {
          autoBackup: false,
          ownerGuardFilename: item.filename,
        }),
        (error) => error?.code === 'project_database_owner_unavailable'
          && error?.status === 503,
      );
      assert.equal(fs.existsSync(item.filename), false);
    } finally {
      item.cleanup();
    }
  });

  test('NODE_TEST_CONTEXT owner bypass keeps completed schema32 guard proof on short transactions', async () => {
    const item = fixture();
    let first = null;
    let second = null;
    try {
      first = new ProjectDatabase(item.filename, {
        autoBackup: false,
        unsafeDisableOwnerGuardForTests: true,
      });
      second = new ProjectDatabase(item.filename, {
        autoBackup: false,
        unsafeDisableOwnerGuardForTests: true,
      });

      assert.equal(first.projectDatabaseOwner?.unsafeTestBypass, true);
      assert.equal(second.projectDatabaseOwner?.unsafeTestBypass, true);
      assert.equal(first.projectDatabaseOwner.database.inTransaction, false);
      assert.equal(second.projectDatabaseOwner.database.inTransaction, false);
      assert.equal(
        first.projectDatabaseOwner.database.prepare(`
          SELECT state FROM project_database_schema32_migration_guard WHERE singleton = 1
        `).get().state,
        'completed',
      );
      assert.equal(
        second.projectDatabaseOwner.database.prepare(`
          SELECT state FROM project_database_schema32_migration_guard WHERE singleton = 1
        `).get().state,
        'completed',
      );

      first.ensureCanvas('owner-bypass-first-canvas', { nodes: [], edges: [] });
      assert.equal(second.getCanvas('owner-bypass-first-canvas')?.canvasId, 'owner-bypass-first-canvas');
      second.ensureCanvas('owner-bypass-second-canvas', { nodes: [], edges: [] });
      assert.equal(first.getCanvas('owner-bypass-second-canvas')?.canvasId, 'owner-bypass-second-canvas');
      assert.equal(first.projectDatabaseOwner.database.inTransaction, false);
      assert.equal(second.projectDatabaseOwner.database.inTransaction, false);
    } finally {
      await first?.close().catch(() => undefined);
      await second?.close().catch(() => undefined);
      item.cleanup();
    }
  });

  test('schema32 stale-backup recovery rejection releases the owner guard immediately', async () => {
    const item = fixture();
    const backupFilename = `${item.filename}.backup`;
    const ownerFilename = path.join(item.directory, PROJECT_DATABASE_OWNER_GUARD_BASENAME);
    let database = null;
    let rawOwner = null;
    try {
      database = new ProjectDatabase(item.filename, { backupFilename, autoBackup: false });
      database.ensureCanvas('owner-recovery-canvas', { nodes: [], edges: [] });
      await database.createBackup();
      database.ensureCanvas('owner-recovery-newer-canvas', { nodes: [], edges: [] });
      await database.close();
      database = null;
      fs.writeFileSync(item.filename, Buffer.from('schema32-stale-backup-owner-release-probe'));

      assert.throws(
        () => new ProjectDatabase(item.filename, { backupFilename, autoBackup: false }),
        (error) => error?.code === 'project_database_recovery_failed'
          && error?.status === 503
          && error?.details?.phase === 'backup_freshness_rejected'
          && error?.details?.freshnessStatus === 'rejected'
          && error?.details?.freshnessReasons?.includes(
            'captured-write-sequence-behind-acknowledged-watermark',
          )
          && error.details.capturedWriteSequence < error.details.acknowledgedWriteSequence,
      );

      rawOwner = new BetterSqlite3(ownerFilename, { timeout: 0, fileMustExist: true });
      rawOwner.pragma('busy_timeout = 0');
      assert.equal(
        String(rawOwner.pragma('locking_mode = EXCLUSIVE', { simple: true })).toLowerCase(),
        'exclusive',
      );
      rawOwner.exec('BEGIN EXCLUSIVE');
      assert.equal(rawOwner.inTransaction, true);
      rawOwner.exec('ROLLBACK');
    } finally {
      try { if (rawOwner?.open) rawOwner.close(); } catch (_) {}
      await database?.close().catch(() => undefined);
      item.cleanup();
    }
  });

  test('independent Electron processes fail fast and an OS-released crash lock is immediately reclaimable', async () => {
    const item = fixture();
    const holder = helperProcess('hold', item.filename);
    let contender = null;
    let reopened = null;
    try {
      await waitForMessage(holder, (value) => value.type === 'opened');
      contender = helperProcess('attempt', path.join(item.directory, 'second.sqlite3'));
      const conflict = await waitForMessage(contender, (value) => value.type === 'error');
      assert.deepEqual(conflict, {
        type: 'error',
        code: 'project_database_owner_conflict',
        status: 409,
        name: 'ProjectDatabaseOwnerConflictError',
      });
      await waitForExit(contender);
      contender = null;

      holder.kill('SIGKILL');
      await waitForExit(holder);
      reopened = helperProcess('attempt', item.filename);
      await waitForMessage(reopened, (value) => value.type === 'opened');
      await waitForExit(reopened);
      reopened = null;
    } finally {
      if (holder.exitCode == null && holder.signalCode == null) holder.kill('SIGKILL');
      if (contender && contender.exitCode == null && contender.signalCode == null) contender.kill('SIGKILL');
      if (reopened && reopened.exitCode == null && reopened.signalCode == null) reopened.kill('SIGKILL');
      await Promise.allSettled([waitForExit(holder), contender ? waitForExit(contender) : null, reopened ? waitForExit(reopened) : null]);
      item.cleanup();
    }
  });
}
