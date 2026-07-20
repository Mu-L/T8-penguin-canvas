const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const BetterSqlite3 = require('better-sqlite3');
const {
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
  ProjectDatabaseSchemaInvalidError,
} = require('../backend/src/services/projectDatabase');
const {
  PROJECT_DATABASE_MIGRATION_23,
  PROJECT_DATABASE_MIGRATION_23_DOWN_SQL,
  PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT,
  PROJECT_DATABASE_MIGRATION_23_UP_SQL,
} = require('../backend/src/services/projectDatabaseMigration23');

const SCHEMA_22_FINGERPRINT = PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT.from.fingerprint;
const SCHEMA_23_UPGRADED_FINGERPRINT =
  PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT.target.fingerprint;
const HISTORICAL_TAGS = Object.freeze(['v2.5.6', 'v2.5.7']);
const MIGRATION_23_CHECKPOINTS = Object.freeze([
  'after-from-verify',
  'after-ddl',
  'after-backfill',
  'after-to-verify',
  'after-ledger',
  'after-receipt',
  'before-commit',
]);

const historicalModuleCache = new Map();

function temporaryProject(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filename = path.join(directory, 'projects.sqlite3');
  return {
    directory,
    filename,
    backupFilename: `${filename}.pre-migration-v22.sqlite3`,
    markerFilename: path.join(directory, 'migration-crash-marker.json'),
  };
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function closeQuietly(database) {
  if (!database) return;
  try {
    const result = database.close();
    if (result && typeof result.then === 'function') await result;
  } catch (_) {}
}

function loadHistoricalProjectDatabase(ref) {
  if (historicalModuleCache.has(ref)) return historicalModuleCache.get(ref);
  const root = path.resolve(__dirname, '..');
  const filename = path.join(root, 'backend', 'src', 'services', 'projectDatabase.js');
  const source = childProcess.execFileSync(
    'git',
    ['show', `${ref}:backend/src/services/projectDatabase.js`],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  const historicalModule = new Module(`${filename}#${ref}`, module);
  historicalModule.filename = filename;
  historicalModule.paths = Module._nodeModulePaths(path.dirname(filename));
  historicalModule._compile(source, filename);
  historicalModuleCache.set(ref, historicalModule.exports);
  return historicalModule.exports;
}

function normalizeSqlValue(value) {
  if (Buffer.isBuffer(value)) return { blobHex: value.toString('hex') };
  return value;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function exactLogicalSnapshot(database) {
  const objects = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type ASC, name ASC
  `).all();
  const tables = objects
    .filter((entry) => entry.type === 'table')
    .map((entry) => String(entry.name));
  return {
    userVersion: Number(database.pragma('user_version', { simple: true })),
    applicationId: Number(database.pragma('application_id', { simple: true })),
    objects,
    tables: tables.map((tableName) => {
      const quoted = quoteIdentifier(tableName);
      const columns = database.pragma(`table_xinfo(${quoteIdentifier(tableName)})`)
        .map((column) => ({
          cid: Number(column.cid),
          name: String(column.name),
          type: String(column.type || ''),
          notnull: Number(column.notnull),
          defaultValue: column.dflt_value,
          primaryKey: Number(column.pk),
          hidden: Number(column.hidden),
        }));
      const rows = database.prepare(`SELECT * FROM ${quoted}`).all()
        .map((row) => Object.fromEntries(Object.entries(row).map(
          ([key, value]) => [key, normalizeSqlValue(value)],
        )))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      return { tableName, columns, rows };
    }),
  };
}

function migrationLedger(database) {
  return database.prepare(`
    SELECT version, applied_at FROM schema_migrations ORDER BY version ASC
  `).all().map((row) => ({
    version: Number(row.version),
    appliedAt: Number(row.applied_at),
  }));
}

function tableColumns(database, tableName) {
  return database.pragma(`table_xinfo(${quoteIdentifier(tableName)})`)
    .map((column) => String(column.name));
}

function assertExactSchema22(database) {
  assert.equal(migrationLedger(database).at(-1)?.version, 22);
  assert.equal(tableColumns(database, 'collaboration_invites').includes('canvas_id'), false);
  assert.equal(tableColumns(database, 'collaboration_members').includes('canvas_id'), false);
  assert.equal(tableColumns(database, 'collaboration_sessions').includes('canvas_id'), false);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE name IN (
      'canvas_resource_grants',
      'canvas_resource_grant_state',
      'schema_historical_migration_receipts'
    )
  `).get().count, 0);
  assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
}

function historicalIds(suffix) {
  const safe = String(suffix).replaceAll(/[^a-z0-9-]/gi, '-');
  return Object.freeze({
    projectId: `historical-project-${safe}`,
    canvasId: `historical-canvas-${safe}`,
    memberId: `historical-member-${safe}`,
    inviteId: `historical-invite-${safe}`,
    sessionId: `historical-session-${safe}`,
    intentId: `historical-intent-${safe}`,
    missingRequesterId: `historical-missing-requester-${safe}`,
  });
}

async function seedExactHistoricalSchema22(ref, filename, suffix) {
  const historical = loadHistoricalProjectDatabase(ref);
  assert.equal(historical.PROJECT_DATABASE_SCHEMA_VERSION, 22);
  const ids = historicalIds(suffix);
  let database = null;
  try {
    database = new historical.ProjectDatabase(filename, { autoBackup: false });
    const canvas = database.ensureCanvas(
      ids.canvasId,
      {
        nodes: [{ id: `historical-node-${suffix}`, type: 'text', data: { prompt: 'schema22' } }],
        edges: [],
      },
      ids.projectId,
    );
    const now = 1_725_000_000_000;
    database.db.transaction(() => {
      database.db.prepare(`
        INSERT INTO collaboration_members(
          id, project_id, display_name, role, capabilities_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'editor', ?, ?, ?)
      `).run(
        ids.memberId,
        ids.projectId,
        'Historical editor',
        JSON.stringify(['readCanvas', 'editGraph', 'runWorkflow']),
        now,
        now,
      );
      database.db.prepare(`
        INSERT INTO collaboration_invites(
          id, project_id, code_hash, role, capabilities_json,
          expires_at, max_uses, use_count, revoked_at, created_at
        ) VALUES (?, ?, ?, 'editor', ?, ?, 3, 0, NULL, ?)
      `).run(
        ids.inviteId,
        ids.projectId,
        `invite-hash-${suffix}`,
        JSON.stringify(['readCanvas', 'editGraph']),
        now + 86_400_000,
        now,
      );
      database.db.prepare(`
        INSERT INTO collaboration_sessions(
          id, project_id, member_id, token_hash,
          expires_at, revoked_at, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        ids.sessionId,
        ids.projectId,
        ids.memberId,
        `session-hash-${suffix}`,
        now + 86_400_000,
        now,
        now,
      );
      database.db.prepare(`
        INSERT INTO run_intents(
          id, project_id, canvas_id, canvas_revision, node_ids_json,
          idempotency_key, requested_by, status, run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '[]', ?, ?, 'accepted', NULL, ?, ?)
      `).run(
        ids.intentId,
        ids.projectId,
        ids.canvasId,
        canvas.revision,
        `intent-key-${suffix}`,
        ids.missingRequesterId,
        now,
        now,
      );
    }).immediate();
    database.db.pragma('wal_checkpoint(TRUNCATE)');
    assertExactSchema22(database.db);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_invites WHERE revoked_at IS NULL
    `).get().count, 1);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_sessions WHERE revoked_at IS NULL
    `).get().count, 1);
    assert.equal(database.db.prepare(`
      SELECT status FROM run_intents WHERE id = ?
    `).get(ids.intentId).status, 'accepted');
    return { ids, canvasRevision: Number(canvas.revision) };
  } finally {
    await closeQuietly(database);
  }
}

async function seedHistoricalScopeSemanticsMatrix(filename) {
  const historical = loadHistoricalProjectDatabase('v2.5.6');
  const now = 1_725_100_000_000;
  const matrix = Object.freeze({
    single: Object.freeze({
      projectId: 'historical-scope-single-project',
      canvasIds: Object.freeze(['historical-scope-single-canvas']),
      memberId: 'historical-scope-single-member',
      inviteId: 'historical-scope-single-invite',
      sessionId: 'historical-scope-single-session',
      validIntentId: 'historical-scope-single-valid-intent',
      completedIntentId: 'historical-scope-single-completed-intent',
      runId: 'historical-scope-single-run',
    }),
    multi: Object.freeze({
      projectId: 'historical-scope-multi-project',
      canvasIds: Object.freeze([
        'historical-scope-multi-canvas-a',
        'historical-scope-multi-canvas-b',
      ]),
      memberId: 'historical-scope-multi-member',
      inviteId: 'historical-scope-multi-invite',
      sessionId: 'historical-scope-multi-session',
      pendingIntentId: 'historical-scope-multi-pending-intent',
      acceptedIntentId: 'historical-scope-multi-accepted-intent',
    }),
    zero: Object.freeze({
      projectId: 'historical-scope-zero-project',
      canvasIds: Object.freeze([]),
      ghostCanvasId: 'historical-scope-zero-ghost-canvas',
      memberId: 'historical-scope-zero-member',
      inviteId: 'historical-scope-zero-invite',
      sessionId: 'historical-scope-zero-session',
      pendingIntentId: 'historical-scope-zero-pending-intent',
      acceptedIntentId: 'historical-scope-zero-accepted-intent',
    }),
  });
  let database = null;
  try {
    database = new historical.ProjectDatabase(filename, { autoBackup: false });
    const canvasRevisions = new Map();
    for (const scope of [matrix.single, matrix.multi]) {
      for (const canvasId of scope.canvasIds) {
        const canvas = database.ensureCanvas(
          canvasId,
          { nodes: [], edges: [] },
          scope.projectId,
        );
        canvasRevisions.set(canvasId, Number(canvas.revision));
      }
    }

    const insertMember = database.db.prepare(`
      INSERT INTO collaboration_members(
        id, project_id, display_name, role, capabilities_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'editor', ?, ?, ?)
    `);
    const insertInvite = database.db.prepare(`
      INSERT INTO collaboration_invites(
        id, project_id, code_hash, role, capabilities_json,
        expires_at, max_uses, use_count, revoked_at, created_at
      ) VALUES (?, ?, ?, 'editor', ?, ?, 3, 0, NULL, ?)
    `);
    const insertSession = database.db.prepare(`
      INSERT INTO collaboration_sessions(
        id, project_id, member_id, token_hash,
        expires_at, revoked_at, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    `);
    const insertIntent = database.db.prepare(`
      INSERT INTO run_intents(
        id, project_id, canvas_id, canvas_revision, node_ids_json,
        idempotency_key, requested_by, status, run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)
    `);
    database.db.transaction(() => {
      for (const [label, scope] of Object.entries(matrix)) {
        insertMember.run(
          scope.memberId,
          scope.projectId,
          `${label} editor`,
          JSON.stringify(['readCanvas', 'editGraph', 'runWorkflow']),
          now,
          now,
        );
        insertInvite.run(
          scope.inviteId,
          scope.projectId,
          `scope-${label}-invite-hash`,
          JSON.stringify(['readCanvas', 'editGraph']),
          now + 86_400_000,
          now,
        );
        insertSession.run(
          scope.sessionId,
          scope.projectId,
          scope.memberId,
          `scope-${label}-session-hash`,
          now + 86_400_000,
          now,
          now,
        );
      }

      const singleCanvasId = matrix.single.canvasIds[0];
      const singleCanvasRevision = canvasRevisions.get(singleCanvasId);
      insertIntent.run(
        matrix.single.validIntentId,
        matrix.single.projectId,
        singleCanvasId,
        singleCanvasRevision,
        'scope-single-valid-intent-key',
        matrix.single.memberId,
        'accepted',
        null,
        now,
        now,
      );
      database.db.prepare(`
        INSERT INTO runs(
          id, project_id, canvas_id, canvas_revision, initiator_id,
          parent_run_id, status, summary_json, created_at, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'completed', '{}', ?, ?, ?)
      `).run(
        matrix.single.runId,
        matrix.single.projectId,
        singleCanvasId,
        singleCanvasRevision,
        matrix.single.memberId,
        now,
        now,
        now + 1,
      );
      insertIntent.run(
        matrix.single.completedIntentId,
        matrix.single.projectId,
        singleCanvasId,
        singleCanvasRevision,
        'scope-single-completed-intent-key',
        'historical-scope-missing-completed-requester',
        'accepted',
        matrix.single.runId,
        now,
        now,
      );

      for (const [status, intentId] of [
        ['pending', matrix.multi.pendingIntentId],
        ['accepted', matrix.multi.acceptedIntentId],
      ]) {
        insertIntent.run(
          intentId,
          matrix.multi.projectId,
          matrix.multi.canvasIds[0],
          canvasRevisions.get(matrix.multi.canvasIds[0]),
          `scope-multi-${status}-intent-key`,
          matrix.multi.memberId,
          status,
          null,
          now,
          now,
        );
      }
      for (const [status, intentId] of [
        ['pending', matrix.zero.pendingIntentId],
        ['accepted', matrix.zero.acceptedIntentId],
      ]) {
        insertIntent.run(
          intentId,
          matrix.zero.projectId,
          matrix.zero.ghostCanvasId,
          1,
          `scope-zero-${status}-intent-key`,
          matrix.zero.memberId,
          status,
          null,
          now,
          now,
        );
      }
    }).immediate();
    database.db.pragma('wal_checkpoint(TRUNCATE)');
    assertExactSchema22(database.db);
    return Object.freeze({ matrix, canvasRevisions });
  } finally {
    await closeQuietly(database);
  }
}

function schemaHistoricalMigrationReceiptCreateSql() {
  const marker = 'CREATE TABLE schema_historical_migration_receipts';
  const start = PROJECT_DATABASE_MIGRATION_23_UP_SQL.indexOf(marker);
  assert.notEqual(start, -1, 'migration23 UP_SQL must own the historical receipt table');
  const receiptSql = PROJECT_DATABASE_MIGRATION_23_UP_SQL.slice(start).trim();
  assert.match(receiptSql, /^CREATE TABLE schema_historical_migration_receipts\b/);
  assert.match(receiptSql, /WITHOUT ROWID;$/);
  return receiptSql;
}

function readHistoricalReceipt(database) {
  return database.prepare(`
    SELECT version, name, checksum, from_fingerprint, to_fingerprint,
           down_policy, applied_at
    FROM schema_historical_migration_receipts
    ORDER BY version ASC
  `).all().map((row) => ({
    version: Number(row.version),
    name: row.name,
    checksum: row.checksum,
    fromFingerprint: row.from_fingerprint,
    toFingerprint: row.to_fingerprint,
    downPolicy: row.down_policy,
    appliedAt: Number(row.applied_at),
  }));
}

function assertExactHistoricalReceipt(database) {
  const receipt = readHistoricalReceipt(database);
  assert.deepEqual(receipt, [{
    version: PROJECT_DATABASE_MIGRATION_23.version,
    name: PROJECT_DATABASE_MIGRATION_23.name,
    checksum: PROJECT_DATABASE_MIGRATION_23.checksum,
    fromFingerprint: SCHEMA_22_FINGERPRINT,
    toFingerprint: SCHEMA_23_UPGRADED_FINGERPRINT,
    downPolicy: PROJECT_DATABASE_MIGRATION_23.downPolicy,
    appliedAt: Number(database.prepare(`
      SELECT applied_at FROM schema_migrations WHERE version = 23
    `).get().applied_at),
  }]);
}

function assertFinalHistoricalData(database, seed) {
  const { ids, canvasRevision } = seed;
  assert.equal(migrationLedger(database).at(-1)?.version, PROJECT_DATABASE_SCHEMA_VERSION);
  assert.deepEqual(database.prepare(`
    SELECT canvas_id, revoked_at IS NOT NULL AS revoked
    FROM collaboration_invites WHERE id = ?
  `).get(ids.inviteId), { canvas_id: ids.canvasId, revoked: 1 });
  assert.deepEqual(database.prepare(`
    SELECT canvas_id FROM collaboration_members WHERE id = ?
  `).get(ids.memberId), { canvas_id: ids.canvasId });
  assert.deepEqual(database.prepare(`
    SELECT canvas_id, revoked_at IS NOT NULL AS revoked
    FROM collaboration_sessions WHERE id = ?
  `).get(ids.sessionId), { canvas_id: ids.canvasId, revoked: 1 });
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM collaboration_invites WHERE revoked_at IS NULL
  `).get().count, 0);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM collaboration_sessions WHERE revoked_at IS NULL
  `).get().count, 0);
  assert.deepEqual(database.prepare(`
    SELECT trusted_revision, initialized_at
    FROM canvas_resource_grant_state
    WHERE project_id = ? AND canvas_id = ?
  `).get(ids.projectId, ids.canvasId), {
    trusted_revision: canvasRevision,
    initialized_at: 0,
  });
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM canvas_resource_grants
    WHERE project_id = ? AND canvas_id = ?
  `).get(ids.projectId, ids.canvasId).count, 0);
  assert.equal(database.prepare(`
    SELECT status FROM run_intents WHERE id = ?
  `).get(ids.intentId).status, 'stale');
  const audit = database.prepare(`
    SELECT action, target_type, target_id, metadata_json
    FROM audit_events
    WHERE action = 'collaboration.run-intent.schema23-scope-stale'
      AND target_id = ?
  `).get(ids.intentId);
  assert.equal(audit.action, 'collaboration.run-intent.schema23-scope-stale');
  assert.equal(audit.target_type, 'run-intent');
  assert.equal(audit.target_id, ids.intentId);
  assert.deepEqual(JSON.parse(audit.metadata_json), {
    previousStatus: 'accepted',
    nextStatus: 'stale',
    requestedBy: ids.missingRequesterId,
    reasonCode: 'intent_requester_canvas_scope_invalid',
  });
  assertExactHistoricalReceipt(database);
  assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
}

function crashMigration23AtCheckpoint({
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
      preMigration23Backup: false,
      preMigration23BackupFilename: process.env.T8_MIGRATION_BACKUP,
      preMigrationBackup: false,
      preMigration30Backup: false,
      beforeExecutableMigrationPhase(_database, event) {
        if (event.version === 23
          && event.phase === process.env.T8_MIGRATION_CRASH_PHASE) {
          writeMarker(event);
          process.exit(91);
        }
      },
      afterExecutableMigrationCommit(_database, event) {
        if (process.env.T8_MIGRATION_CRASH_PHASE === 'after-commit-control'
          && event.version === 23) {
          writeMarker({ phase: 'after-commit-control', ...event });
          process.exit(93);
        }
      },
    });
    database.close();
    process.exit(92);
  `;
  return childProcess.spawnSync(process.execPath, ['-e', childScript], {
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
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

test('B2 v23 immutable provenance resolves each released tag, commit, source path, and Git blob', () => {
  const root = path.resolve(__dirname, '..');
  assert.equal(PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT.from.version, 22);
  assert.equal(PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT.target.version, 23);
  for (const provenance of PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT.provenance) {
    const tagCommit = childProcess.execFileSync(
      'git',
      ['rev-parse', `${provenance.tag}^{commit}`],
      { cwd: root, encoding: 'utf8', windowsHide: true },
    ).trim();
    const sourceBlob = childProcess.execFileSync(
      'git',
      ['rev-parse', `${provenance.commit}:${provenance.sourcePath}`],
      { cwd: root, encoding: 'utf8', windowsHide: true },
    ).trim();
    assert.equal(tagCommit, provenance.commit, `${provenance.tag} commit drifted`);
    assert.equal(sourceBlob, provenance.sourceBlob, `${provenance.tag} source blob drifted`);
  }
});

test('B2 released v2.5.6/v2.5.7 schema22 upgrades through exact backup-only v23 lineage', async (t) => {
  for (const ref of HISTORICAL_TAGS) {
    await t.test(ref, async () => {
      const fixture = temporaryProject(`t8-b2-historical-v23-${ref.replaceAll('.', '-')}-`);
      let database = null;
      try {
        const seed = await seedExactHistoricalSchema22(ref, fixture.filename, ref);
        const before = new BetterSqlite3(fixture.filename, { readonly: true, fileMustExist: true });
        let schema22Snapshot;
        try {
          schema22Snapshot = exactLogicalSnapshot(before);
        } finally {
          before.close();
        }

        let oldAuditObservation = null;
        let exactEndpointRuntime = null;
        database = new ProjectDatabase(fixture.filename, {
          autoBackup: false,
          preMigration23BackupFilename: fixture.backupFilename,
          preMigrationBackup: false,
          preMigration30Backup: false,
          beforeExecutableMigrationPhase(lockedDatabase, event) {
            if (event.version === 23 && event.phase === 'after-backfill') {
              oldAuditObservation = {
                hasMutationUid: tableColumns(lockedDatabase, 'audit_events').includes('mutation_uid'),
                row: lockedDatabase.prepare(`
                  SELECT action, target_type, target_id, metadata_json
                  FROM audit_events
                  WHERE target_id = ?
                `).get(seed.ids.intentId),
              };
            }
          },
          beforeMigrationCommit(_lockedDatabase, version, migration, runtime) {
            if (version === 23) {
              exactEndpointRuntime = {
                version,
                name: migration.name,
                executionMode: runtime?.executionMode,
              };
            }
          },
        });
        assert.deepEqual(oldAuditObservation && {
          hasMutationUid: oldAuditObservation.hasMutationUid,
          action: oldAuditObservation.row?.action,
          targetType: oldAuditObservation.row?.target_type,
          targetId: oldAuditObservation.row?.target_id,
        }, {
          hasMutationUid: false,
          action: 'collaboration.run-intent.schema23-scope-stale',
          targetType: 'run-intent',
          targetId: seed.ids.intentId,
        });
        assert.deepEqual(exactEndpointRuntime, {
          version: 23,
          name: PROJECT_DATABASE_MIGRATION_23.name,
          executionMode: 'exact-endpoint',
        });
        assertFinalHistoricalData(database.db, seed);
        await database.close();
        database = null;

        assert.equal(fs.existsSync(fixture.backupFilename), true);
        const backup = new BetterSqlite3(fixture.backupFilename, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          assertExactSchema22(backup);
          assert.deepEqual(exactLogicalSnapshot(backup), schema22Snapshot);
          assert.equal(backup.prepare(`
            SELECT revoked_at FROM collaboration_invites WHERE id = ?
          `).get(seed.ids.inviteId).revoked_at, null);
          assert.equal(backup.prepare(`
            SELECT revoked_at FROM collaboration_sessions WHERE id = ?
          `).get(seed.ids.sessionId).revoked_at, null);
          assert.equal(backup.prepare(`
            SELECT status FROM run_intents WHERE id = ?
          `).get(seed.ids.intentId).status, 'accepted');
          assert.equal(backup.prepare(`
            SELECT COUNT(*) AS count FROM audit_events
            WHERE action = 'collaboration.run-intent.schema23-scope-stale'
          `).get().count, 0);
        } finally {
          backup.close();
        }

        database = new ProjectDatabase(fixture.filename, {
          autoBackup: false,
          preMigrationBackup: false,
          preMigration30Backup: false,
        });
        assertFinalHistoricalData(database.db, seed);
      } finally {
        await closeQuietly(database);
        cleanup(fixture.directory);
      }
    });
  }
});

test('B2 real v2.5.6 schema22 scope inference is exact for single, multi, and zero-canvas projects', async () => {
  const fixture = temporaryProject('t8-b2-v23-scope-semantics-matrix-');
  let database = null;
  try {
    const seeded = await seedHistoricalScopeSemanticsMatrix(fixture.filename);
    const { single, multi, zero } = seeded.matrix;
    database = new ProjectDatabase(fixture.filename, {
      autoBackup: false,
      preMigration23BackupFilename: fixture.backupFilename,
      preMigrationBackup: false,
      preMigration30Backup: false,
    });

    assert.deepEqual(database.db.prepare(`
      SELECT canvas_id FROM collaboration_members WHERE id = ?
    `).get(single.memberId), { canvas_id: single.canvasIds[0] });
    assert.deepEqual(database.db.prepare(`
      SELECT canvas_id, revoked_at IS NOT NULL AS revoked
      FROM collaboration_invites WHERE id = ?
    `).get(single.inviteId), { canvas_id: single.canvasIds[0], revoked: 1 });
    assert.deepEqual(database.db.prepare(`
      SELECT canvas_id, revoked_at IS NOT NULL AS revoked
      FROM collaboration_sessions WHERE id = ?
    `).get(single.sessionId), { canvas_id: single.canvasIds[0], revoked: 1 });
    assert.deepEqual(database.db.prepare(`
      SELECT status, run_id FROM run_intents WHERE id = ?
    `).get(single.validIntentId), { status: 'accepted', run_id: null });
    assert.deepEqual(database.db.prepare(`
      SELECT status, run_id FROM run_intents WHERE id = ?
    `).get(single.completedIntentId), {
      status: 'accepted',
      run_id: single.runId,
    });

    for (const scope of [multi, zero]) {
      assert.deepEqual(database.db.prepare(`
        SELECT canvas_id FROM collaboration_members WHERE id = ?
      `).get(scope.memberId), { canvas_id: null });
      assert.deepEqual(database.db.prepare(`
        SELECT canvas_id, revoked_at IS NOT NULL AS revoked
        FROM collaboration_invites WHERE id = ?
      `).get(scope.inviteId), { canvas_id: null, revoked: 1 });
      assert.deepEqual(database.db.prepare(`
        SELECT canvas_id, revoked_at IS NOT NULL AS revoked
        FROM collaboration_sessions WHERE id = ?
      `).get(scope.sessionId), { canvas_id: null, revoked: 1 });
      assert.equal(database.db.prepare(`
        SELECT status FROM run_intents WHERE id = ?
      `).get(scope.pendingIntentId).status, 'stale');
      assert.equal(database.db.prepare(`
        SELECT status FROM run_intents WHERE id = ?
      `).get(scope.acceptedIntentId).status, 'stale');
    }

    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_invites WHERE revoked_at IS NULL
    `).get().count, 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_sessions WHERE revoked_at IS NULL
    `).get().count, 0);
    assert.deepEqual(database.db.prepare(`
      SELECT project_id, canvas_id, trusted_revision, initialized_at
      FROM canvas_resource_grant_state
      ORDER BY project_id ASC, canvas_id ASC
    `).all(), [
      {
        project_id: multi.projectId,
        canvas_id: multi.canvasIds[0],
        trusted_revision: seeded.canvasRevisions.get(multi.canvasIds[0]),
        initialized_at: 0,
      },
      {
        project_id: multi.projectId,
        canvas_id: multi.canvasIds[1],
        trusted_revision: seeded.canvasRevisions.get(multi.canvasIds[1]),
        initialized_at: 0,
      },
      {
        project_id: single.projectId,
        canvas_id: single.canvasIds[0],
        trusted_revision: seeded.canvasRevisions.get(single.canvasIds[0]),
        initialized_at: 0,
      },
    ]);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_resource_grant_state WHERE project_id = ?
    `).get(zero.projectId).count, 0);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_resource_grants
    `).get().count, 0);

    const staleAudits = database.db.prepare(`
      SELECT target_id, metadata_json
      FROM audit_events
      WHERE action = 'collaboration.run-intent.schema23-scope-stale'
      ORDER BY target_id ASC
    `).all().map((row) => ({
      targetId: row.target_id,
      metadata: JSON.parse(row.metadata_json),
    }));
    assert.deepEqual(staleAudits.map((row) => row.targetId), [
      multi.acceptedIntentId,
      multi.pendingIntentId,
      zero.acceptedIntentId,
      zero.pendingIntentId,
    ].sort());
    assert.equal(staleAudits.some((row) => row.targetId === single.validIntentId), false);
    assert.equal(staleAudits.some((row) => row.targetId === single.completedIntentId), false);
    assert.deepEqual(
      staleAudits.map((row) => row.metadata.previousStatus).sort(),
      ['accepted', 'accepted', 'pending', 'pending'],
    );
    for (const audit of staleAudits) {
      assert.equal(audit.metadata.nextStatus, 'stale');
      assert.equal(audit.metadata.reasonCode, 'intent_requester_canvas_scope_invalid');
    }
    assertExactHistoricalReceipt(database.db);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    await closeQuietly(database);
    cleanup(fixture.directory);
  }
});

test('B2 released v2.5.8 fresh schema23 remains compatible without fabricating a historical receipt', async () => {
  const fixture = temporaryProject('t8-b2-historical-v23-fresh-v258-');
  const historical = loadHistoricalProjectDatabase('v2.5.8');
  let seed = null;
  let database = null;
  try {
    assert.equal(historical.PROJECT_DATABASE_SCHEMA_VERSION, 23);
    seed = new historical.ProjectDatabase(fixture.filename, { autoBackup: false });
    await closeQuietly(seed);
    seed = null;
    const raw = new BetterSqlite3(fixture.filename, { readonly: true, fileMustExist: true });
    try {
      assert.equal(migrationLedger(raw).at(-1)?.version, 23);
      assert.equal(raw.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE name = 'schema_historical_migration_receipts'
      `).get().count, 0);
    } finally {
      raw.close();
    }

    database = new ProjectDatabase(fixture.filename, {
      autoBackup: false,
      preMigrationBackup: false,
      preMigration30Backup: false,
    });
    assert.equal(migrationLedger(database.db).at(-1)?.version, PROJECT_DATABASE_SCHEMA_VERSION);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE name = 'schema_historical_migration_receipts'
    `).get().count, 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
    await database.close();
    database = null;

    database = new ProjectDatabase(fixture.filename, { autoBackup: false });
    assert.equal(migrationLedger(database.db).at(-1)?.version, PROJECT_DATABASE_SCHEMA_VERSION);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE name = 'schema_historical_migration_receipts'
    `).get().count, 0);
  } finally {
    await closeQuietly(seed);
    await closeQuietly(database);
    cleanup(fixture.directory);
  }
});

test('B2 hard process exit at every v23 checkpoint preserves exact schema22 primary and backup', async (t) => {
  for (const [checkpointIndex, phase] of MIGRATION_23_CHECKPOINTS.entries()) {
    await t.test(phase, async () => {
      const fixture = temporaryProject(`t8-b2-v23-crash-${checkpointIndex}-`);
      let database = null;
      try {
        const seed = await seedExactHistoricalSchema22(
          'v2.5.6',
          fixture.filename,
          `crash-${checkpointIndex}`,
        );
        const rawBefore = new BetterSqlite3(fixture.filename, {
          readonly: true,
          fileMustExist: true,
        });
        let schema22Snapshot;
        try {
          schema22Snapshot = exactLogicalSnapshot(rawBefore);
        } finally {
          rawBefore.close();
        }

        const crashed = crashMigration23AtCheckpoint({
          filename: fixture.filename,
          backupFilename: fixture.backupFilename,
          markerFilename: fixture.markerFilename,
          phase,
        });
        assert.equal(
          crashed.status,
          91,
          `checkpoint ${phase} did not hard-exit: ${crashed.error?.message || crashed.stderr || crashed.stdout}`,
        );
        assert.equal(crashed.signal, null);
        assert.deepEqual(JSON.parse(fs.readFileSync(fixture.markerFilename, 'utf8')), {
          version: PROJECT_DATABASE_MIGRATION_23.version,
          name: PROJECT_DATABASE_MIGRATION_23.name,
          phase,
          ...(phase === 'after-from-verify'
            ? { fromFingerprint: SCHEMA_22_FINGERPRINT }
            : {}),
          ...(phase === 'after-to-verify'
            ? {
              fromFingerprint: SCHEMA_22_FINGERPRINT,
              toFingerprint: SCHEMA_23_UPGRADED_FINGERPRINT,
            }
            : {}),
        });
        assert.equal(fs.existsSync(fixture.backupFilename), true);

        const primary = new BetterSqlite3(fixture.filename);
        const backup = new BetterSqlite3(fixture.backupFilename, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          assertExactSchema22(primary);
          assertExactSchema22(backup);
          assert.deepEqual(exactLogicalSnapshot(primary), schema22Snapshot);
          assert.deepEqual(exactLogicalSnapshot(backup), schema22Snapshot);
        } finally {
          primary.close();
          backup.close();
        }

        database = new ProjectDatabase(fixture.filename, {
          autoBackup: false,
          preMigration23Backup: false,
          preMigration23BackupFilename: fixture.backupFilename,
          preMigrationBackup: false,
          preMigration30Backup: false,
        });
        assertFinalHistoricalData(database.db, seed);
        await database.close();
        database = null;

        database = new ProjectDatabase(fixture.filename, { autoBackup: false });
        assertFinalHistoricalData(database.db, seed);
      } finally {
        await closeQuietly(database);
        cleanup(fixture.directory);
      }
    });
  }

  await t.test('after-commit-control', async () => {
    const fixture = temporaryProject('t8-b2-v23-crash-after-commit-');
    let database = null;
    try {
      const seed = await seedExactHistoricalSchema22(
        'v2.5.6',
        fixture.filename,
        'after-commit',
      );
      const rawBefore = new BetterSqlite3(fixture.filename, {
        readonly: true,
        fileMustExist: true,
      });
      let schema22Snapshot;
      try {
        schema22Snapshot = exactLogicalSnapshot(rawBefore);
      } finally {
        rawBefore.close();
      }

      const crashed = crashMigration23AtCheckpoint({
        filename: fixture.filename,
        backupFilename: fixture.backupFilename,
        markerFilename: fixture.markerFilename,
        phase: 'after-commit-control',
      });
      assert.equal(
        crashed.status,
        93,
        `v23 committed control did not hard-exit: ${crashed.error?.message || crashed.stderr || crashed.stdout}`,
      );
      assert.equal(crashed.signal, null);
      assert.deepEqual(JSON.parse(fs.readFileSync(fixture.markerFilename, 'utf8')), {
        phase: 'after-commit-control',
        version: 23,
        name: PROJECT_DATABASE_MIGRATION_23.name,
        executionMode: 'exact-endpoint',
        fromFingerprint: SCHEMA_22_FINGERPRINT,
        toFingerprint: SCHEMA_23_UPGRADED_FINGERPRINT,
      });

      const primary = new BetterSqlite3(fixture.filename);
      const backup = new BetterSqlite3(fixture.backupFilename, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        assert.equal(migrationLedger(primary).at(-1)?.version, 23);
        assertExactHistoricalReceipt(primary);
        assert.equal(tableColumns(primary, 'collaboration_invites').includes('canvas_id'), true);
        assert.equal(primary.pragma('quick_check', { simple: true }), 'ok');
        assert.deepEqual(primary.pragma('foreign_key_check'), []);
        assertExactSchema22(backup);
        assert.deepEqual(exactLogicalSnapshot(backup), schema22Snapshot);
      } finally {
        primary.close();
        backup.close();
      }

      database = new ProjectDatabase(fixture.filename, {
        autoBackup: false,
        preMigrationBackup: false,
        preMigration30Backup: false,
      });
      assertFinalHistoricalData(database.db, seed);
      assert.equal(migrationLedger(database.db).at(-1)?.version, PROJECT_DATABASE_SCHEMA_VERSION);
      assertExactHistoricalReceipt(database.db);
    } finally {
      await closeQuietly(database);
      cleanup(fixture.directory);
    }
  });
});

test('B2 schema22 disk migration cannot bypass its backup and rejects primary or sidecar collisions', async (t) => {
  await t.test('preMigration23Backup false still writes and verifies the v22 recovery point', async () => {
    const fixture = temporaryProject('t8-b2-v23-backup-mandatory-');
    let database = null;
    try {
      const seed = await seedExactHistoricalSchema22('v2.5.6', fixture.filename, 'mandatory');
      database = new ProjectDatabase(fixture.filename, {
        autoBackup: false,
        preMigration23Backup: false,
        preMigration23BackupFilename: fixture.backupFilename,
        preMigrationBackup: false,
        preMigration30Backup: false,
      });
      assertFinalHistoricalData(database.db, seed);
      assert.equal(fs.existsSync(fixture.backupFilename), true);
      const backup = new BetterSqlite3(fixture.backupFilename, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        assertExactSchema22(backup);
      } finally {
        backup.close();
      }
    } finally {
      await closeQuietly(database);
      cleanup(fixture.directory);
    }
  });

  for (const collision of [
    { label: 'primary', target: (filename) => filename },
    { label: 'wal-sidecar', target: (filename) => `${filename}-wal` },
  ]) {
    await t.test(`${collision.label} collision fails before migration`, async () => {
      const fixture = temporaryProject(`t8-b2-v23-backup-collision-${collision.label}-`);
      try {
        await seedExactHistoricalSchema22('v2.5.6', fixture.filename, collision.label);
        const rawBefore = new BetterSqlite3(fixture.filename, {
          readonly: true,
          fileMustExist: true,
        });
        let beforeSnapshot;
        try {
          beforeSnapshot = exactLogicalSnapshot(rawBefore);
        } finally {
          rawBefore.close();
        }

        assert.throws(
          () => new ProjectDatabase(fixture.filename, {
            autoBackup: false,
            preMigration23Backup: false,
            preMigration23BackupFilename: collision.target(fixture.filename),
            preMigrationBackup: false,
            preMigration30Backup: false,
          }),
          (error) => error instanceof ProjectDatabaseSchemaInvalidError
            && /备份路径|sidecar|恢复产物|冲突/i.test(String(error.message || '')),
        );

        const rawAfter = new BetterSqlite3(fixture.filename);
        try {
          assertExactSchema22(rawAfter);
          assert.deepEqual(exactLogicalSnapshot(rawAfter), beforeSnapshot);
        } finally {
          rawAfter.close();
        }
      } finally {
        cleanup(fixture.directory);
      }
    });
  }
});

test('B2 historical v23 receipt tampering and reserved-name VIEW/trigger shadows fail closed on cold open', async (t) => {
  await t.test('present receipt with a different valid-looking checksum is rejected', async () => {
    const fixture = temporaryProject('t8-b2-v23-receipt-tamper-');
    let database = null;
    try {
      await seedExactHistoricalSchema22('v2.5.6', fixture.filename, 'receipt-tamper');
      database = new ProjectDatabase(fixture.filename, {
        autoBackup: false,
        preMigration23BackupFilename: fixture.backupFilename,
        preMigrationBackup: false,
        preMigration30Backup: false,
      });
      await database.close();
      database = null;

      const raw = new BetterSqlite3(fixture.filename);
      let tamperedSnapshot;
      try {
        assert.equal(raw.prepare(`
          UPDATE schema_historical_migration_receipts
          SET checksum = ? WHERE version = 23
        `).run('0'.repeat(64)).changes, 1);
        raw.pragma('wal_checkpoint(TRUNCATE)');
        tamperedSnapshot = exactLogicalSnapshot(raw);
      } finally {
        raw.close();
      }

      assert.throws(
        () => new ProjectDatabase(fixture.filename, { autoBackup: false }),
        (error) => error instanceof ProjectDatabaseSchemaInvalidError
          && /historical|receipt|历史/i.test(String(error.message || '')),
      );
      const verify = new BetterSqlite3(fixture.filename);
      try {
        assert.deepEqual(exactLogicalSnapshot(verify), tamperedSnapshot);
      } finally {
        verify.close();
      }
    } finally {
      await closeQuietly(database);
      cleanup(fixture.directory);
    }
  });

  for (const shadow of [
    {
      label: 'view',
      createSql: `
        CREATE VIEW schema_historical_migration_receipts AS
        SELECT version, applied_at FROM schema_migrations WHERE version = 23
      `,
    },
    {
      label: 'trigger',
      createSql: `
        CREATE TRIGGER schema_historical_migration_receipts
        AFTER INSERT ON collaboration_members BEGIN SELECT 1; END
      `,
    },
  ]) {
    await t.test(`reserved receipt name shadowed by ${shadow.label} is rejected`, async () => {
      const fixture = temporaryProject(`t8-b2-v23-receipt-shadow-${shadow.label}-`);
      const historical = loadHistoricalProjectDatabase('v2.5.8');
      let seed = null;
      try {
        seed = new historical.ProjectDatabase(fixture.filename, { autoBackup: false });
        await closeQuietly(seed);
        seed = null;
        const raw = new BetterSqlite3(fixture.filename);
        let shadowedSnapshot;
        try {
          raw.exec(shadow.createSql);
          raw.pragma('wal_checkpoint(TRUNCATE)');
          shadowedSnapshot = exactLogicalSnapshot(raw);
        } finally {
          raw.close();
        }

        assert.throws(
          () => new ProjectDatabase(fixture.filename, { autoBackup: false }),
          (error) => error instanceof ProjectDatabaseSchemaInvalidError
            && /receipt|保留对象|名称或类型/i.test(String(error.message || '')),
        );
        const verify = new BetterSqlite3(fixture.filename);
        try {
          assert.deepEqual(exactLogicalSnapshot(verify), shadowedSnapshot);
        } finally {
          verify.close();
        }
      } finally {
        await closeQuietly(seed);
        cleanup(fixture.directory);
      }
    });
  }
});

test('B2 an exact-looking v23 receipt cannot claim a different schema28 downstream lineage', async () => {
  const fixture = temporaryProject('t8-b2-v23-receipt-wrong-downstream-');
  let database = null;
  try {
    database = new ProjectDatabase(fixture.filename, {
      autoBackup: false,
      preMigrationBackup: false,
      preMigration30Backup: false,
    });
    await database.close();
    database = null;

    const raw = new BetterSqlite3(fixture.filename);
    let forgedSnapshot;
    try {
      assert.equal(migrationLedger(raw).at(-1)?.version, PROJECT_DATABASE_SCHEMA_VERSION);
      assert.equal(raw.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE name = 'schema_historical_migration_receipts'
      `).get().count, 0);
      raw.exec(schemaHistoricalMigrationReceiptCreateSql());
      const appliedAt = Number(raw.prepare(`
        SELECT applied_at FROM schema_migrations WHERE version = 23
      `).get().applied_at);
      raw.prepare(`
        INSERT INTO schema_historical_migration_receipts(
          version, name, checksum, from_fingerprint, to_fingerprint, down_policy, applied_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        23,
        PROJECT_DATABASE_MIGRATION_23.name,
        PROJECT_DATABASE_MIGRATION_23.checksum,
        SCHEMA_22_FINGERPRINT,
        SCHEMA_23_UPGRADED_FINGERPRINT,
        PROJECT_DATABASE_MIGRATION_23.downPolicy,
        appliedAt,
      );
      assertExactHistoricalReceipt(raw);
      raw.pragma('wal_checkpoint(TRUNCATE)');
      forgedSnapshot = exactLogicalSnapshot(raw);
    } finally {
      raw.close();
    }

    assert.throws(
      () => new ProjectDatabase(fixture.filename, { autoBackup: false }),
      (error) => error instanceof ProjectDatabaseSchemaInvalidError
        && /receipt|lineage|历史/i.test(String(error.message || ''))
        && error.details?.receiptValid === true
        && typeof error.details?.expectedDownstreamFingerprint === 'string'
        && error.details.expectedDownstreamFingerprint
          !== PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT.downstream.fingerprint,
    );
    const verify = new BetterSqlite3(fixture.filename);
    try {
      assert.deepEqual(exactLogicalSnapshot(verify), forgedSnapshot);
      assertExactHistoricalReceipt(verify);
    } finally {
      verify.close();
    }
  } finally {
    await closeQuietly(database);
    cleanup(fixture.directory);
  }
});

test('B2 compatibility boundary accepts an absent v23 receipt and is explicitly not deletion detection', async () => {
  const fixture = temporaryProject('t8-b2-v23-receipt-absence-compatibility-');
  let database = null;
  try {
    const seed = await seedExactHistoricalSchema22(
      'v2.5.6',
      fixture.filename,
      'receipt-absence',
    );
    database = new ProjectDatabase(fixture.filename, {
      autoBackup: false,
      preMigration23BackupFilename: fixture.backupFilename,
      preMigrationBackup: false,
      preMigration30Backup: false,
    });
    assertFinalHistoricalData(database.db, seed);
    await database.close();
    database = null;

    const raw = new BetterSqlite3(fixture.filename);
    try {
      assert.equal(readHistoricalReceipt(raw).length, 1);
      raw.exec('DROP TABLE schema_historical_migration_receipts');
      raw.pragma('wal_checkpoint(TRUNCATE)');
      assert.equal(raw.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE name = 'schema_historical_migration_receipts'
      `).get().count, 0);
      assert.equal(raw.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(raw.pragma('foreign_key_check'), []);
    } finally {
      raw.close();
    }

    // Deliberate compatibility with released v2.5.8 and older pre-receipt
    // lineages makes absence indistinguishable from an offline DROP. This
    // proves only the compatibility boundary; it is not receipt deletion
    // detection and must not be cited as complete tamper protection.
    database = new ProjectDatabase(fixture.filename, { autoBackup: false });
    assert.equal(migrationLedger(database.db).at(-1)?.version, PROJECT_DATABASE_SCHEMA_VERSION);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE name = 'schema_historical_migration_receipts'
    `).get().count, 0);
    assert.equal(database.db.prepare(`
      SELECT status FROM run_intents WHERE id = ?
    `).get(seed.ids.intentId).status, 'stale');
    assert.equal(database.db.prepare(`
      SELECT revoked_at IS NOT NULL AS revoked
      FROM collaboration_invites WHERE id = ?
    `).get(seed.ids.inviteId).revoked, 1);
    assert.equal(database.db.prepare(`
      SELECT revoked_at IS NOT NULL AS revoked
      FROM collaboration_sessions WHERE id = ?
    `).get(seed.ids.sessionId).revoked, 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    await closeQuietly(database);
    cleanup(fixture.directory);
  }
});

test('B2 schema23 DOWN is explicitly backup-only and never performs an in-place inverse', async () => {
  const fixture = temporaryProject('t8-b2-v23-down-backup-only-');
  const historical23 = loadHistoricalProjectDatabase('v2.5.8');
  let seed22 = null;
  let seed23 = null;
  let raw = null;
  try {
    await seedExactHistoricalSchema22('v2.5.6', fixture.filename, 'down');
    seed23 = new historical23.ProjectDatabase(fixture.filename, { autoBackup: false });
    await closeQuietly(seed23);
    seed23 = null;

    raw = new BetterSqlite3(fixture.filename);
    assert.equal(migrationLedger(raw).at(-1)?.version, 23);
    const before = exactLogicalSnapshot(raw);
    const maintenance = Object.create(ProjectDatabase.prototype);
    maintenance.db = raw;
    maintenance.options = { allowOfflineSchemaMigrationDown: true };

    assert.throws(
      () => maintenance.migrateSchema23Down({ offline: true }),
      (error) => error?.code === 'project_database_migration_down_requires_backup'
        && error?.status === 409
        && error?.details?.fromVersion === 23
        && error?.details?.toVersion === 22
        && error?.details?.downPolicy === 'backup-only',
    );
    assert.equal(PROJECT_DATABASE_MIGRATION_23.downPolicy, 'backup-only');
    assert.equal(PROJECT_DATABASE_MIGRATION_23_DOWN_SQL, '');
    assert.deepEqual(exactLogicalSnapshot(raw), before);
  } finally {
    try { raw?.close(); } catch (_) {}
    await closeQuietly(seed22);
    await closeQuietly(seed23);
    cleanup(fixture.directory);
  }
});
