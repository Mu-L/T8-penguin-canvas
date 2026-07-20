const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');

const {
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_COLUMNS,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_SOURCE_CONTRACT,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_STATE_DIGEST_CONTRACT,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DDL,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_CREATE_SQL,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_RUNTIME_GUARDS_SQL,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DOWN_SQL,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_OWNED_OBJECTS,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_OWNED_OBJECT_NAMES,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_IMPERATIVE_CONTRACT,
  projectDatabaseLegacyGapOwnerStateDescriptor,
  projectDatabaseLegacyGapOwnerStateDigest,
} = require('../backend/src/services/projectDatabaseMigration31LegacyGaps');

function normalizeSql(sql) {
  return String(sql).replace(/\r\n?/g, '\n').trim();
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  Object.values(value).forEach((child) => assertDeepFrozen(child, seen));
}

function componentChecksum(definition) {
  return createHash('sha256').update(JSON.stringify({
    format: definition.checksumCanonicalization,
    version: definition.version,
    fromVersion: definition.fromVersion,
    name: definition.name,
    columns: definition.columns,
    ownerBindings: definition.ownerBindings,
    sourceContract: definition.sourceContract,
    ownerStateDigestContract: definition.ownerStateDigestContract,
    createSql: normalizeSql(definition.ddl.createSql),
    runtimeGuardsSql: normalizeSql(definition.ddl.runtimeGuardsSql),
    downSql: normalizeSql(definition.ddl.downSql),
    ownedObjectNames: definition.ownedObjectNames,
    imperativeContract: definition.imperativeContract,
  }), 'utf8').digest('hex');
}

function tempDatabase(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filename = path.join(directory, 'legacy-gaps.sqlite3');
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { directory, filename };
}

function insertStatement(database) {
  return database.prepare(`
    INSERT INTO canvas_legacy_snapshot_gaps(
      ${PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_COLUMNS.join(', ')}
    ) VALUES (
      ${PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_COLUMNS.map((column) => `@${column}`).join(', ')}
    )
  `);
}

function createOwnerTables(database) {
  database.exec(`
    CREATE TABLE canvas_documents (
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      PRIMARY KEY(project_id, canvas_id)
    ) WITHOUT ROWID;
    CREATE TABLE run_intents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL
    );
    CREATE TABLE review_threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL
    );
    CREATE TABLE canvas_patch_applications (
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      patch_id TEXT NOT NULL,
      PRIMARY KEY(project_id, canvas_id, patch_id)
    ) WITHOUT ROWID;
  `);
}

function insertOwner(database, binding, gap) {
  if (binding.ownerTable === 'canvas_patch_applications') {
    return database.prepare(`
      INSERT INTO canvas_patch_applications(project_id, canvas_id, patch_id)
      VALUES (?, ?, ?)
    `).run(gap.project_id, gap.canvas_id, gap.owner_id);
  }
  return database.prepare(`
    INSERT INTO ${binding.ownerTable}(id, project_id, canvas_id)
    VALUES (?, ?, ?)
  `).run(gap.owner_id, gap.project_id, gap.canvas_id);
}

function validGap(binding, index = 1, overrides = {}) {
  return {
    project_id: `legacy-gap-project-${index}`,
    canvas_id: `legacy-gap-canvas-${index}`,
    pin_kind: binding.pinKind,
    owner_id: `legacy-gap-owner-${index}`,
    slot: binding.slot,
    snapshot_revision: 10 + index,
    owner_table: binding.ownerTable,
    owner_status_at_migration: binding.pinKind === 'run_intent' ? 'pending' : 'historical',
    owner_revision_at_migration: binding.ownerRevisionColumn == null ? null : 20 + index,
    owner_state_digest: createHash('sha256').update(`legacy-gap-owner-state-${index}`).digest('hex'),
    source_schema_version: PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_SOURCE_CONTRACT.schemaVersion,
    source_migration_version: PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_SOURCE_CONTRACT.migrationVersion,
    source_receipt_checksum: PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_SOURCE_CONTRACT.migrationReceiptChecksum,
    created_at: 1_900_000_000_000 + index,
    ...overrides,
  };
}

function ownerStateRow(binding, index = 1, overrides = {}) {
  return {
    id: `owner-${index}`,
    patch_id: `patch-${index}`,
    project_id: `project-${index}`,
    canvas_id: `canvas-${index}`,
    canvas_revision: 100 + index,
    decision_canvas_revision: 200 + index,
    applied_revision: 300 + index,
    status: binding.pinKind === 'run_intent' ? 'stale' : 'historical',
    queue_revision: 400 + index,
    revision: 500 + index,
    unrelated_field: 'ignored-a',
    ...overrides,
  };
}

function sqliteObjects(database) {
  return database.prepare(`
    SELECT type, name
    FROM sqlite_master
    WHERE name LIKE '%legacy_snapshot_gaps%'
    ORDER BY type ASC, name ASC
  `).all().map((row) => `${row.type}:${row.name}`);
}

function isConstraint(error) {
  assert.match(String(error?.code || ''), /^SQLITE_CONSTRAINT/);
  return true;
}

test('B2 schema31 legacy-gap component freezes fields, DDL, owner bindings, and ordered contract', () => {
  assert.equal(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS.version, 31);
  assert.equal(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS.fromVersion, 30);
  assert.equal(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS.name, 'owner-scoped-legacy-snapshot-gaps');
  assert.equal(
    PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS.checksum,
    componentChecksum(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS),
  );
  assert.match(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS.checksum, /^[a-f0-9]{64}$/);
  assert.equal(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS.columns, PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_COLUMNS);
  assert.equal(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS.ownerBindings, PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS);
  assert.equal(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS.sourceContract, PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_SOURCE_CONTRACT);
  assert.equal(
    PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS.ownerStateDigestContract,
    PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_STATE_DIGEST_CONTRACT,
  );
  assert.equal(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS.ddl, PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DDL);
  assert.equal(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS.ownedObjects, PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_OWNED_OBJECTS);
  assert.equal(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS.imperativeContract, PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_IMPERATIVE_CONTRACT);

  assert.deepEqual(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_COLUMNS, [
    'project_id',
    'canvas_id',
    'pin_kind',
    'owner_id',
    'slot',
    'snapshot_revision',
    'owner_table',
    'owner_status_at_migration',
    'owner_revision_at_migration',
    'owner_state_digest',
    'source_schema_version',
    'source_migration_version',
    'source_receipt_checksum',
    'created_at',
  ]);
  assert.deepEqual(
    PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS.map((binding) => [
      binding.pinKind,
      binding.ownerTable,
      binding.slot,
      binding.snapshotRevisionColumn,
      binding.ownerRevisionColumn,
    ]),
    [
      ['run_intent', 'run_intents', 'canvas', 'canvas_revision', 'queue_revision'],
      ['run', 'runs', 'canvas', 'canvas_revision', 'revision'],
      ['review_source', 'review_threads', 'source', 'canvas_revision', 'revision'],
      ['review_decision', 'review_threads', 'decision', 'decision_canvas_revision', 'revision'],
      ['patch_applied', 'canvas_patch_applications', 'applied', 'applied_revision', null],
    ],
  );
  assert.deepEqual(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_SOURCE_CONTRACT, {
    schemaVersion: 30,
    migrationVersion: 29,
    migrationReceiptChecksum: 'a8f05a9c0029fc29d08037216ea0a58b686714daa3fb9bc616f658f97800b7d8',
  });
  assert.deepEqual(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_STATE_DIGEST_CONTRACT, {
    format: 't8-project-database-schema31-legacy-owner-state-v1',
    algorithm: 'sha256',
    canonicalization: 'ordered-json-object-with-ordered-field-tuples-v1',
    descriptorPropertyOrder: ['format', 'pinKind', 'ownerTable', 'slot', 'fields'],
    fieldTupleOrder: ['columnName', 'exactScalarValue'],
    scalarPolicy: 'non-null-string-or-safe-integer-without-coercion-v1',
    unrelatedFieldPolicy: 'ignore-fields-not-listed-for-the-owner-binding',
    descriptors: [
      {
        pinKind: 'run_intent',
        ownerTable: 'run_intents',
        slot: 'canvas',
        fields: ['id', 'project_id', 'canvas_id', 'canvas_revision', 'status', 'queue_revision'],
      },
      {
        pinKind: 'run',
        ownerTable: 'runs',
        slot: 'canvas',
        fields: ['id', 'project_id', 'canvas_id', 'canvas_revision', 'status', 'revision'],
      },
      {
        pinKind: 'review_source',
        ownerTable: 'review_threads',
        slot: 'source',
        fields: ['id', 'project_id', 'canvas_id', 'canvas_revision', 'status', 'revision'],
      },
      {
        pinKind: 'review_decision',
        ownerTable: 'review_threads',
        slot: 'decision',
        fields: ['id', 'project_id', 'canvas_id', 'decision_canvas_revision', 'status', 'revision'],
      },
      {
        pinKind: 'patch_applied',
        ownerTable: 'canvas_patch_applications',
        slot: 'applied',
        fields: ['patch_id', 'project_id', 'canvas_id', 'applied_revision', 'status'],
      },
    ],
  });
  assert.deepEqual(
    PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_IMPERATIVE_CONTRACT.phases.map((phase) => phase.id),
    [
      'locked-schema30-legacy-gap-gate',
      'create-legacy-gap-ledger-before-guards',
      'repair-or-classify-legacy-owner-gaps',
      'install-legacy-gap-runtime-guards',
      'verify-owner-pin-gap-partition',
    ],
  );
  assert.doesNotMatch(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_CREATE_SQL, /CREATE\s+TRIGGER/i);
  assert.match(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_RUNTIME_GUARDS_SQL, /BEFORE INSERT/i);
  assert.match(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_RUNTIME_GUARDS_SQL, /BEFORE UPDATE/i);
  assert.match(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_RUNTIME_GUARDS_SQL, /BEFORE DELETE/i);
  assertDeepFrozen(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS);
  assertDeepFrozen(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_OWNED_OBJECTS);
  assertDeepFrozen(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_IMPERATIVE_CONTRACT);
  assertDeepFrozen(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_STATE_DIGEST_CONTRACT);
});

test('B2 schema31 legacy owner-state digest freezes exact per-kind fields and ignores unrelated fields', () => {
  const expectedVectors = {
    run_intent: '42c8e883154c0ee645ddb8f3fabf6fc130fd285900aa84e22a3178b03187667d',
    run: '9634e91e71ad60988e6f7ba9338e9272cfafd707ca50b1cc74d507013ed7c032',
    review_source: '6f8c20eef90db197a81f555aa5691cfc9b2996bce3685e44cfde36bd0eb636c4',
    review_decision: 'a6c8bcde44aa5fbd6a1b815805f5c4dd05c96e44d888612f5571c74e61ecd43e',
    patch_applied: '017aa0c3ac25d3af85f632dd533aa4b5bcf158ebceb56190f27b69fd6e2b8bef',
  };

  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS.forEach((binding, offset) => {
    const index = offset + 1;
    const row = ownerStateRow(binding, index);
    const descriptor = projectDatabaseLegacyGapOwnerStateDescriptor(binding.pinKind, row);
    const digest = projectDatabaseLegacyGapOwnerStateDigest(binding, row);
    assert.deepEqual(descriptor, {
      format: PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_STATE_DIGEST_CONTRACT.format,
      pinKind: binding.pinKind,
      ownerTable: binding.ownerTable,
      slot: binding.slot,
      fields: binding.ownerStateDescriptorFields.map((field) => [field, row[field]]),
    });
    assert.equal(digest, expectedVectors[binding.pinKind]);
    assert.match(digest, /^[a-f0-9]{64}$/);
    assertDeepFrozen(descriptor);

    const reordered = Object.fromEntries(Object.entries(row).reverse());
    assert.equal(projectDatabaseLegacyGapOwnerStateDigest(binding.pinKind, reordered), digest);
    assert.equal(projectDatabaseLegacyGapOwnerStateDigest(binding.pinKind, {
      ...row,
      unrelated_field: 'ignored-b',
      newly_added_future_column: { ignored: true },
    }), digest);

    binding.ownerStateDescriptorFields.forEach((field) => {
      const value = row[field];
      const changed = typeof value === 'number' ? value + 1 : `${value}-changed`;
      assert.notEqual(
        projectDatabaseLegacyGapOwnerStateDigest(binding.pinKind, { ...row, [field]: changed }),
        digest,
        `${binding.pinKind}/${field} must be digest-significant`,
      );
      const missing = { ...row };
      delete missing[field];
      assert.throws(
        () => projectDatabaseLegacyGapOwnerStateDigest(binding.pinKind, missing),
        new RegExp(`${field} is required`),
      );
    });
  });

  const runBinding = PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS[1];
  assert.throws(
    () => projectDatabaseLegacyGapOwnerStateDigest('unknown-kind', ownerStateRow(runBinding)),
    /unknown legacy snapshot gap owner binding/i,
  );
  assert.throws(
    () => projectDatabaseLegacyGapOwnerStateDigest(runBinding, ownerStateRow(runBinding, 1, {
      revision: 1.5,
    })),
    /must be a string or safe integer/i,
  );
  assert.throws(
    () => projectDatabaseLegacyGapOwnerStateDigest(runBinding, ownerStateRow(runBinding, 1, {
      status: null,
    })),
    /status is required/i,
  );
});

test('B2 schema31 legacy-gap pre-guard DDL accepts exactly the five owner bindings', (t) => {
  const { filename } = tempDatabase(t, 't8-b2-legacy-gap-ddl-');
  const database = new BetterSqlite3(filename);
  try {
    database.pragma('foreign_keys = ON');
    database.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_CREATE_SQL);
    const insert = insertStatement(database);
    PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS.forEach((binding, index) => {
      assert.equal(insert.run(validGap(binding, index + 1)).changes, 1);
    });

    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM canvas_legacy_snapshot_gaps
    `).get().count, PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS.length);
    assert.deepEqual(sqliteObjects(database), [
      'index:idx_canvas_legacy_snapshot_gaps_revision',
      'table:canvas_legacy_snapshot_gaps',
    ]);
    assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});

test('B2 schema31 legacy-gap table rejects forged scope, source, digest, revision, and binding rows', (t) => {
  const { filename } = tempDatabase(t, 't8-b2-legacy-gap-constraints-');
  const database = new BetterSqlite3(filename);
  try {
    database.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_CREATE_SQL);
    const insert = insertStatement(database);
    const runBinding = PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS[1];
    const patchBinding = PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS[4];
    let sequence = 100;
    const rejected = (overrides, binding = runBinding) => {
      sequence += 1;
      assert.throws(() => insert.run(validGap(binding, sequence, overrides)), isConstraint);
    };

    rejected({ project_id: '' });
    rejected({ canvas_id: '' });
    rejected({ owner_id: '__proto__' });
    rejected({ slot: 'decision' });
    rejected({ owner_table: 'review_threads' });
    rejected({ snapshot_revision: 0 });
    rejected({ owner_status_at_migration: '' });
    rejected({ owner_revision_at_migration: null });
    rejected({ owner_state_digest: 'A'.repeat(64) });
    rejected({ owner_state_digest: 'a'.repeat(63) });
    rejected({ source_schema_version: 29 });
    rejected({ source_migration_version: 30 });
    rejected({ source_receipt_checksum: 'b'.repeat(64) });
    rejected({ created_at: 0 });
    rejected({ owner_revision_at_migration: 1 }, patchBinding);

    const valid = validGap(runBinding, 999);
    assert.equal(insert.run(valid).changes, 1);
    assert.throws(() => insert.run(valid), isConstraint);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM canvas_legacy_snapshot_gaps').get().count, 1);
  } finally {
    database.close();
  }
});

test('B2 schema31 legacy-gap runtime guards install after backfill and permanently deny every mutation', (t) => {
  const { filename } = tempDatabase(t, 't8-b2-legacy-gap-guards-');
  let database = new BetterSqlite3(filename);
  const firstBinding = PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS[0];
  const first = validGap(firstBinding, 1);
  try {
    createOwnerTables(database);
    database.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_CREATE_SQL);
    assert.equal(insertStatement(database).run(first).changes, 1, 'migration backfill must precede guards');
    database.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_RUNTIME_GUARDS_SQL);
    database.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_RUNTIME_GUARDS_SQL);

    assert.deepEqual(sqliteObjects(database), [
      'index:idx_canvas_legacy_snapshot_gaps_revision',
      'table:canvas_legacy_snapshot_gaps',
      'trigger:trg_canvas_legacy_snapshot_gaps_delete_guard',
      'trigger:trg_canvas_legacy_snapshot_gaps_insert_guard',
      'trigger:trg_canvas_legacy_snapshot_gaps_reserve_canvas_patch_application_insert',
      'trigger:trg_canvas_legacy_snapshot_gaps_reserve_review_thread_insert',
      'trigger:trg_canvas_legacy_snapshot_gaps_reserve_run_insert',
      'trigger:trg_canvas_legacy_snapshot_gaps_reserve_run_intent_insert',
      'trigger:trg_canvas_legacy_snapshot_gaps_update_guard',
    ]);
    assert.throws(
      () => insertStatement(database).run(validGap(firstBinding, 2)),
      /legacy snapshot gap insert is migration-only/i,
    );
    assert.throws(
      () => database.prepare(`
        UPDATE canvas_legacy_snapshot_gaps
        SET owner_status_at_migration = 'rewritten'
        WHERE owner_id = ?
      `).run(first.owner_id),
      /legacy snapshot gap evidence is immutable/i,
    );
    assert.throws(
      () => database.prepare('DELETE FROM canvas_legacy_snapshot_gaps WHERE owner_id = ?').run(first.owner_id),
      /legacy snapshot gap evidence cannot be deleted/i,
    );
    database.close();
    database = new BetterSqlite3(filename);
    assert.throws(
      () => database.prepare('DELETE FROM canvas_legacy_snapshot_gaps WHERE owner_id = ?').run(first.owner_id),
      /legacy snapshot gap evidence cannot be deleted/i,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM canvas_legacy_snapshot_gaps').get().count, 1);
    assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
  } finally {
    try { database.close(); } catch (_) {}
  }
});

test('B2 schema31 legacy gaps reserve owner identities after both owner and canvas deletion', (t) => {
  const { filename } = tempDatabase(t, 't8-b2-legacy-gap-owner-reservation-');
  const database = new BetterSqlite3(filename);
  try {
    createOwnerTables(database);
    database.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_CREATE_SQL);
    const insertGap = insertStatement(database);
    const fixtures = PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS.map((binding, index) => ({
      binding,
      gap: validGap(binding, index + 1),
    }));
    fixtures.forEach(({ binding, gap }) => {
      database.prepare(`
        INSERT INTO canvas_documents(project_id, canvas_id) VALUES (?, ?)
      `).run(gap.project_id, gap.canvas_id);
      assert.equal(insertOwner(database, binding, gap).changes, 1);
      assert.equal(insertGap.run(gap).changes, 1);
    });
    database.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_RUNTIME_GUARDS_SQL);

    database.exec(`
      DELETE FROM run_intents;
      DELETE FROM runs;
      DELETE FROM review_threads;
      DELETE FROM canvas_patch_applications;
      DELETE FROM canvas_documents;
    `);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM canvas_documents').get().count, 0);
    for (const table of ['run_intents', 'runs', 'review_threads', 'canvas_patch_applications']) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM canvas_legacy_snapshot_gaps').get().count,
      fixtures.length,
    );

    fixtures.forEach(({ binding, gap }) => {
      assert.throws(
        () => insertOwner(database, binding, gap),
        /legacy snapshot gap owner identity is permanently reserved/i,
        `${binding.pinKind} identity must remain reserved after deleting its owner and canvas`,
      );
    });

    const unrelated = validGap(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS[1], 99, {
      owner_id: fixtures[1].gap.owner_id,
      canvas_id: `${fixtures[1].gap.canvas_id}-different-scope`,
    });
    assert.equal(
      insertOwner(database, PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS[1], unrelated).changes,
      1,
      'reservation must not overreach a different project/canvas scope',
    );
    assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
  } finally {
    database.close();
  }
});

test('B2 schema31 legacy-gap owned-object manifest and DOWN SQL are exact and composable', (t) => {
  assert.deepEqual(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_OWNED_OBJECTS, {
    tables: ['canvas_legacy_snapshot_gaps'],
    indexes: ['idx_canvas_legacy_snapshot_gaps_revision'],
    views: [],
    triggers: [
      'trg_canvas_legacy_snapshot_gaps_insert_guard',
      'trg_canvas_legacy_snapshot_gaps_update_guard',
      'trg_canvas_legacy_snapshot_gaps_delete_guard',
      'trg_canvas_legacy_snapshot_gaps_reserve_run_intent_insert',
      'trg_canvas_legacy_snapshot_gaps_reserve_run_insert',
      'trg_canvas_legacy_snapshot_gaps_reserve_review_thread_insert',
      'trg_canvas_legacy_snapshot_gaps_reserve_canvas_patch_application_insert',
    ],
  });
  assert.deepEqual(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_OWNED_OBJECT_NAMES, [
    'canvas_legacy_snapshot_gaps',
    'idx_canvas_legacy_snapshot_gaps_revision',
    'trg_canvas_legacy_snapshot_gaps_insert_guard',
    'trg_canvas_legacy_snapshot_gaps_update_guard',
    'trg_canvas_legacy_snapshot_gaps_delete_guard',
    'trg_canvas_legacy_snapshot_gaps_reserve_run_intent_insert',
    'trg_canvas_legacy_snapshot_gaps_reserve_run_insert',
    'trg_canvas_legacy_snapshot_gaps_reserve_review_thread_insert',
    'trg_canvas_legacy_snapshot_gaps_reserve_canvas_patch_application_insert',
  ]);

  const { filename } = tempDatabase(t, 't8-b2-legacy-gap-down-');
  const database = new BetterSqlite3(filename);
  try {
    createOwnerTables(database);
    database.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_CREATE_SQL);
    insertStatement(database).run(validGap(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS[2], 1));
    database.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_RUNTIME_GUARDS_SQL);
    assert.equal(sqliteObjects(database).length, PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_OWNED_OBJECT_NAMES.length);

    database.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DOWN_SQL);
    assert.deepEqual(sqliteObjects(database), []);
    assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
  } finally {
    database.close();
  }
});
