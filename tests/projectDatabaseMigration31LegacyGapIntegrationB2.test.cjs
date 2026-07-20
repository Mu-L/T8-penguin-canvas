'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProjectDatabase,
  PROJECT_DATABASE_SCHEMA_VERSION,
} = require('../backend/src/services/projectDatabase');
const {
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_SOURCE_CONTRACT,
  projectDatabaseLegacyGapOwnerStateDigest,
} = require('../backend/src/services/projectDatabaseMigration31LegacyGaps');

const ACTOR_ID = 'owner-schema31-legacy-gap-b2';
const SESSION_ID = 'session-schema31-legacy-gap-b2';

function temporaryProject(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    directory,
    filename: path.join(directory, 'legacy-schema30.sqlite3'),
  };
}

function cleanupTemporaryDirectory(directory) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(directory);
  assert.equal(
    resolved.startsWith(`${temporaryRoot}${path.sep}`),
    true,
    `refusing to remove non-temporary directory: ${resolved}`,
  );
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function schemaVersion(database) {
  return Number(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version);
}

function assertDatabaseIntegrity(database) {
  assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
}

function replaceExactly(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  assert.equal(count, 1, `schema30 test module replacement drifted: ${label}`);
  return source.replace(needle, replacement);
}

// This test-only loader opens the exact schema30 recovery point without
// executing schema31. It is used only to seed legacy business rows before the
// real exported ProjectDatabase performs the production 30 -> 31 migration.
function loadSchema30ProjectDatabase() {
  const filename = path.resolve(__dirname, '../backend/src/services/projectDatabase.js');
  let source = fs.readFileSync(filename, 'utf8');
  source = replaceExactly(
    source,
    'const PROJECT_DATABASE_SCHEMA_VERSION = 32;',
    'const PROJECT_DATABASE_SCHEMA_VERSION = 30;',
    'current-version',
  );
  source = replaceExactly(
    source,
    `, Object.freeze({
  version: PROJECT_DATABASE_MIGRATION_32.version,
  name: PROJECT_DATABASE_MIGRATION_32.name,
  mode: 'executable',
  fromVersion: PROJECT_DATABASE_MIGRATION_32.fromVersion,
  checksum: PROJECT_DATABASE_MIGRATION_32.checksum,
  downPolicy: PROJECT_DATABASE_MIGRATION_32.downPolicy,
})`,
    '',
    'schema32-registry-entry',
  );
  source = replaceExactly(
    source,
    `, Object.freeze({
  version: PROJECT_DATABASE_MIGRATION_31.version,
  name: PROJECT_DATABASE_MIGRATION_31.name,
  mode: 'executable',
  fromVersion: PROJECT_DATABASE_MIGRATION_31.fromVersion,
  checksum: PROJECT_DATABASE_MIGRATION_31.checksum,
  downPolicy: PROJECT_DATABASE_MIGRATION_31.downPolicy,
})`,
    '',
    'schema31-registry-entry',
  );
  source = replaceExactly(
    source,
    'const PROJECT_DATABASE_CURRENT_SCHEMA_MANIFEST = PROJECT_DATABASE_SCHEMA_32_MANIFEST;',
    'const PROJECT_DATABASE_CURRENT_SCHEMA_MANIFEST = PROJECT_DATABASE_SCHEMA_30_MANIFEST;',
    'schema30-current-manifest',
  );
  source = replaceExactly(
    source,
    '      this._assertDurableLedgerAccounting({ updatePressureState: false });',
    '',
    'schema31-startup-accounting',
  );
  source = replaceExactly(
    source,
    'return assertProjectDatabaseCurrentSchema(database, context);',
    'return assertProjectDatabaseSchema30(database, context);',
    'schema30-preflight-fast-path',
  );
  source = replaceExactly(
    source,
    "assertProjectDatabaseCurrentSchema(this.db, 'migrate-fast-path');",
    "assertProjectDatabaseSchema30(this.db, 'migrate-fast-path');",
    'schema30-migrate-fast-path',
  );

  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(source, filename);
  assert.equal(loaded.exports.PROJECT_DATABASE_SCHEMA_VERSION, 30);
  return loaded.exports.ProjectDatabase;
}

function canvasScope(kind) {
  return {
    projectId: `project-schema31-gap-${kind}-b2`,
    canvasId: `canvas-schema31-gap-${kind}-b2`,
  };
}

function emptyCanvas(name) {
  return { name, nodes: [], edges: [] };
}

function advanceCanvas(database, scope, expectedRevision) {
  return database.saveCanvasSnapshot(
    scope.canvasId,
    emptyCanvas(`legacy ${scope.canvasId} revision ${expectedRevision + 1}`),
    {
      projectId: scope.projectId,
      expectedRevision,
      opId: `schema31-gap-advance-${scope.canvasId}-${expectedRevision}`,
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
    },
  );
}

function seedSchema30Owners(database) {
  const intentScope = canvasScope('intent');
  const runScope = canvasScope('run');
  const reviewScope = canvasScope('review');
  const patchScope = canvasScope('patch');

  const intentDocument = database.ensureCanvas(
    intentScope.canvasId,
    emptyCanvas('legacy intent canvas'),
    intentScope.projectId,
  );
  const intent = database.createRunIntent({
    id: 'legacy-active-intent-schema31-gap-b2',
    projectId: intentScope.projectId,
    canvasId: intentScope.canvasId,
    canvasRevision: intentDocument.revision,
    nodeIds: [],
    idempotencyKey: 'legacy-active-intent-schema31-gap-key-b2',
    requestedBy: ACTOR_ID,
    confirmationRequired: true,
  });
  assert.equal(intent.status, 'pending');
  advanceCanvas(database, intentScope, intentDocument.revision);

  const runDocument = database.ensureCanvas(
    runScope.canvasId,
    emptyCanvas('legacy run canvas'),
    runScope.projectId,
  );
  const run = database.createRun({
    id: 'legacy-active-run-schema31-gap-b2',
    projectId: runScope.projectId,
    canvasId: runScope.canvasId,
    canvasRevision: runDocument.revision,
    initiatorId: ACTOR_ID,
    status: 'running',
    startedAt: 1_960_000_000_000,
  });
  advanceCanvas(database, runScope, runDocument.revision);

  const reviewDocument = database.ensureCanvas(
    reviewScope.canvasId,
    emptyCanvas('legacy review canvas'),
    reviewScope.projectId,
  );
  const review = database.createReviewThread({
    id: 'legacy-review-schema31-gap-b2',
    projectId: reviewScope.projectId,
    canvasId: reviewScope.canvasId,
    canvasRevision: reviewDocument.revision,
    anchor: { kind: 'canvas', x: 12, y: 18 },
    status: 'open',
    severity: 'normal',
    createdBy: ACTOR_ID,
  });
  advanceCanvas(database, reviewScope, reviewDocument.revision);

  const patchDocument = database.ensureCanvas(
    patchScope.canvasId,
    emptyCanvas('legacy patch canvas'),
    patchScope.projectId,
  );
  const patchAppliedDocument = advanceCanvas(database, patchScope, patchDocument.revision);
  const patchId = 'legacy-patch-schema31-gap-b2';
  database.db.prepare(`
    INSERT INTO canvas_patch_applications(
      project_id, canvas_id, patch_id, schema, request_digest, preview_digest,
      base_revision, applied_revision, actor_id, session_id, summary,
      diagnostics_json, operation_count, affected_node_ids_json,
      affected_edge_ids_json, changes_json, forward_ops_json, inverse_ops_json,
      postconditions_json, guard_version, provenance_guards_json,
      provenance_guards_digest, acknowledgements_json, status, created_at, updated_at
    ) VALUES (
      ?, ?, ?, 't8-canvas-patch-v1', ?, ?,
      1, 2, ?, ?, 'legacy schema31 gap patch',
      '[]', 1, '[]', '[]', '[]', ?, ?, '[]', 0, '[]', '', '[]',
      'applied', ?, ?
    )
  `).run(
    patchScope.projectId,
    patchScope.canvasId,
    patchId,
    '1'.repeat(64),
    '2'.repeat(64),
    ACTOR_ID,
    SESSION_ID,
    JSON.stringify([{ type: 'node.add', payload: { node: { id: 'legacy' } } }]),
    JSON.stringify([{ type: 'node.delete', payload: { nodeId: 'legacy' } }]),
    1_960_000_000_010,
    1_960_000_000_010,
  );
  advanceCanvas(database, patchScope, patchAppliedDocument.revision);

  return {
    intent: { scope: intentScope, owner: intent, missingRevision: intentDocument.revision },
    run: { scope: runScope, owner: run, missingRevision: runDocument.revision },
    review: { scope: reviewScope, owner: review, missingRevision: reviewDocument.revision },
    patch: {
      scope: patchScope,
      owner: { id: patchId },
      missingRevision: patchAppliedDocument.revision,
    },
  };
}

function removeHistoricalOwnerSnapshots(projectDatabase, fixture) {
  const { db: database } = projectDatabase;
  database.pragma('foreign_keys = ON');
  database.transaction(() => {
    for (const entry of Object.values(fixture)) {
      database.prepare(`
        DELETE FROM canvas_snapshot_pins
        WHERE project_id = ? AND canvas_id = ? AND snapshot_revision = ?
      `).run(entry.scope.projectId, entry.scope.canvasId, entry.missingRevision);
      assert.equal(database.prepare(`
        DELETE FROM canvas_snapshots
        WHERE project_id = ? AND canvas_id = ? AND revision = ?
      `).run(entry.scope.projectId, entry.scope.canvasId, entry.missingRevision).changes, 1);
      assert.equal(
        projectDatabase._ensureRecoveryAnchorPin(entry.scope.projectId, entry.scope.canvasId) >= 1,
        true,
      );
      database.prepare(`
        UPDATE canvas_history_policies
        SET pressure_state = 'missing-owner-snapshot', updated_at = ?
        WHERE project_id = ? AND canvas_id = ?
      `).run(1_960_000_000_100, entry.scope.projectId, entry.scope.canvasId);
    }
  }).immediate();
  assert.equal(schemaVersion(database), 30);
  assertDatabaseIntegrity(database);
}

function ownerBinding(pinKind) {
  const binding = PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS.find(
    (candidate) => candidate.pinKind === pinKind,
  );
  assert.ok(binding, `missing owner binding: ${pinKind}`);
  return binding;
}

function exactGap(database, entry, pinKind, expectedStatus, expectedOwnerRevision) {
  const binding = ownerBinding(pinKind);
  const idColumn = pinKind === 'patch_applied' ? 'patch_id' : 'id';
  const owner = database.db.prepare(`
    SELECT ${binding.ownerStateDescriptorFields.join(', ')}
    FROM ${binding.ownerTable}
    WHERE ${idColumn} = ? AND project_id = ? AND canvas_id = ?
  `).get(entry.owner.id, entry.scope.projectId, entry.scope.canvasId);
  assert.ok(owner);
  const gap = database.db.prepare(`
    SELECT * FROM canvas_legacy_snapshot_gaps
    WHERE project_id = ? AND canvas_id = ?
      AND pin_kind = ? AND owner_id = ? AND slot = ?
  `).get(
    entry.scope.projectId,
    entry.scope.canvasId,
    pinKind,
    entry.owner.id,
    binding.slot,
  );
  assert.ok(gap);
  assert.equal(gap.snapshot_revision, entry.missingRevision);
  assert.equal(gap.owner_table, binding.ownerTable);
  assert.equal(gap.owner_status_at_migration, expectedStatus);
  assert.equal(gap.owner_revision_at_migration, expectedOwnerRevision);
  assert.equal(gap.owner_state_digest, projectDatabaseLegacyGapOwnerStateDigest(binding, owner));
  assert.equal(
    gap.source_schema_version,
    PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_SOURCE_CONTRACT.schemaVersion,
  );
  assert.equal(
    gap.source_migration_version,
    PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_SOURCE_CONTRACT.migrationVersion,
  );
  assert.equal(
    gap.source_receipt_checksum,
    PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_SOURCE_CONTRACT.migrationReceiptChecksum,
  );
  assert.equal(Number(gap.created_at) >= 1, true);
  assert.equal(database.db.prepare(`
    SELECT COUNT(*) AS count FROM canvas_snapshot_pins
    WHERE project_id = ? AND canvas_id = ?
      AND pin_kind = ? AND owner_id = ? AND slot = ?
  `).get(
    entry.scope.projectId,
    entry.scope.canvasId,
    pinKind,
    entry.owner.id,
    binding.slot,
  ).count, 0);
  return gap;
}

function assertGapAuthority409(action, pinKind) {
  assert.throws(
    action,
    (error) => error?.code === 'legacy_snapshot_gap_authority_unavailable'
      && error?.status === 409
      && error?.details?.pinKind === pinKind,
  );
}

function assertGapBackedMutators(database, fixture) {
  assertGapAuthority409(
    () => database.updateRun(fixture.run.owner.id, { status: 'failed' }),
    'run',
  );
  assertGapAuthority409(
    () => database.updateReviewThread(fixture.review.owner.id, {
      expectedRevision: 1,
      severity: 'high',
    }),
    'review_source',
  );
  assertGapAuthority409(
    () => database.revertCanvasPatch(
      fixture.patch.scope.canvasId,
      fixture.patch.owner.id,
      {
        projectId: fixture.patch.scope.projectId,
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      },
    ),
    'patch_applied',
  );
}

test('B2 real schema30 migration freezes exact legacy gaps, terminalizes active owners, and rejects unsafe mutations/new owners', async () => {
  const fixturePath = temporaryProject('t8-b2-schema31-legacy-gap-');
  const seedPath = temporaryProject('t8-b2-schema31-legacy-gap-seed-');
  const seedCurrentFilename = seedPath.filename;
  const seedSchema30Backup = `${seedCurrentFilename}.pre-migration-v30.sqlite3`;
  const migrationSchema30Backup = `${fixturePath.filename}.pre-migration-v30.sqlite3`;
  const Schema30ProjectDatabase = loadSchema30ProjectDatabase();
  let seed = null;
  let legacy = null;
  let migrated = null;
  try {
    seed = new ProjectDatabase(seedCurrentFilename, { autoBackup: false });
    await seed.close();
    seed = null;
    assert.equal(fs.existsSync(seedSchema30Backup), true);
    fs.copyFileSync(seedSchema30Backup, fixturePath.filename, fs.constants.COPYFILE_EXCL);

    legacy = new Schema30ProjectDatabase(fixturePath.filename, { autoBackup: false });
    assert.equal(schemaVersion(legacy.db), 30);
    const ownerFixture = seedSchema30Owners(legacy);
    removeHistoricalOwnerSnapshots(legacy, ownerFixture);
    await legacy.close();
    legacy = null;

    try {
      migrated = new ProjectDatabase(fixturePath.filename, { autoBackup: false });
    } catch (error) {
      process.stderr.write(`schema31 legacy-gap fixture open failed: ${JSON.stringify(error?.details || {})}\n`);
      throw error;
    }
    assert.equal(schemaVersion(migrated.db), PROJECT_DATABASE_SCHEMA_VERSION);
    assert.equal(fs.existsSync(migrationSchema30Backup), true);
    assertDatabaseIntegrity(migrated.db);

    const migratedIntent = migrated.getRunIntent(ownerFixture.intent.owner.id);
    assert.equal(migratedIntent.status, 'stale');
    assert.equal(migratedIntent.queueRevision, 2);
    assert.equal(migratedIntent.lastErrorCode, 'legacy_snapshot_gap');
    exactGap(migrated, ownerFixture.intent, 'run_intent', 'stale', 2);
    assert.equal(migrated.db.prepare(`
      SELECT pressure_state FROM canvas_history_policies
      WHERE project_id = ? AND canvas_id = ?
    `).get(
      ownerFixture.intent.scope.projectId,
      ownerFixture.intent.scope.canvasId,
    ).pressure_state, 'normal');

    const migratedRun = migrated.getRun(ownerFixture.run.owner.id);
    assert.equal(migratedRun.status, 'interrupted');
    assert.equal(migratedRun.revision, 2);
    assert.equal(migratedRun.finishedAt != null, true);
    exactGap(migrated, ownerFixture.run, 'run', 'interrupted', 2);
    assert.equal(migrated.getRunEvents(migratedRun.id).some((event) => (
      event.type === 'run.interrupted'
      && event.payload?.reason === 'legacy-snapshot-gap'
    )), true);

    exactGap(migrated, ownerFixture.review, 'review_source', 'open', 1);
    exactGap(migrated, ownerFixture.patch, 'patch_applied', 'applied', null);
    assertGapBackedMutators(migrated, ownerFixture);
    assert.equal(migrated.getRun(migratedRun.id).status, 'interrupted');
    assert.equal(migrated.getReviewThread(ownerFixture.review.owner.id).severity, 'normal');

    const intentGap = migrated.db.prepare(`
      SELECT * FROM canvas_legacy_snapshot_gaps
      WHERE pin_kind = 'run_intent' AND owner_id = ?
    `).get(ownerFixture.intent.owner.id);
    assert.throws(
      () => migrated.db.prepare(`
        UPDATE canvas_legacy_snapshot_gaps SET created_at = created_at + 1
        WHERE pin_kind = 'run_intent' AND owner_id = ?
      `).run(ownerFixture.intent.owner.id),
      /legacy snapshot gap evidence is immutable/,
    );
    assert.throws(
      () => migrated.db.prepare(`
        DELETE FROM canvas_legacy_snapshot_gaps
        WHERE pin_kind = 'run_intent' AND owner_id = ?
      `).run(ownerFixture.intent.owner.id),
      /legacy snapshot gap evidence cannot be deleted/,
    );
    assert.throws(
      () => migrated.db.prepare(`
        INSERT INTO canvas_legacy_snapshot_gaps
        SELECT * FROM canvas_legacy_snapshot_gaps
        WHERE pin_kind = 'run_intent' AND owner_id = ?
      `).run(ownerFixture.intent.owner.id),
      /legacy snapshot gap insert is migration-only/,
    );
    assert.deepEqual(migrated.db.prepare(`
      SELECT * FROM canvas_legacy_snapshot_gaps
      WHERE pin_kind = 'run_intent' AND owner_id = ?
    `).get(ownerFixture.intent.owner.id), intentGap);

    const missingRevision = 999;
    const rejectedIntentId = 'new-missing-snapshot-intent-schema31-gap-b2';
    assert.throws(
      () => migrated.createRunIntent({
        id: rejectedIntentId,
        projectId: ownerFixture.intent.scope.projectId,
        canvasId: ownerFixture.intent.scope.canvasId,
        canvasRevision: missingRevision,
        nodeIds: [],
        idempotencyKey: 'new-missing-snapshot-intent-key-schema31-gap-b2',
        requestedBy: ACTOR_ID,
      }),
      (error) => error?.code === 'snapshot_owner_authority_unavailable'
        && error?.status === 409
        && error?.details?.ownerKind === 'run_intent'
        && error?.details?.snapshotRevision === missingRevision,
    );
    assert.equal(migrated.db.prepare(`
      SELECT COUNT(*) AS count FROM run_intents WHERE id = ?
    `).get(rejectedIntentId).count, 0);
    assert.equal(migrated.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_legacy_snapshot_gaps WHERE owner_id = ?
    `).get(rejectedIntentId).count, 0);

    const rejectedRunId = 'new-missing-snapshot-run-schema31-gap-b2';
    assert.throws(
      () => migrated.createRun({
        id: rejectedRunId,
        projectId: ownerFixture.run.scope.projectId,
        canvasId: ownerFixture.run.scope.canvasId,
        canvasRevision: missingRevision,
        initiatorId: ACTOR_ID,
        status: 'queued',
      }),
      (error) => error?.code === 'snapshot_owner_authority_unavailable'
        && error?.status === 409
        && error?.details?.ownerKind === 'run'
        && error?.details?.snapshotRevision === missingRevision,
    );
    assert.equal(migrated.db.prepare(`
      SELECT COUNT(*) AS count FROM runs WHERE id = ?
    `).get(rejectedRunId).count, 0);
    assert.equal(migrated.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_legacy_snapshot_gaps WHERE owner_id = ?
    `).get(rejectedRunId).count, 0);
    assertDatabaseIntegrity(migrated.db);

    await migrated.close();
    migrated = null;
    migrated = new ProjectDatabase(fixturePath.filename, { autoBackup: false });
    assert.equal(schemaVersion(migrated.db), PROJECT_DATABASE_SCHEMA_VERSION);
    assert.equal(migrated.getRunIntent(ownerFixture.intent.owner.id).status, 'stale');
    assert.equal(migrated.getRun(ownerFixture.run.owner.id).status, 'interrupted');
    exactGap(migrated, ownerFixture.intent, 'run_intent', 'stale', 2);
    exactGap(migrated, ownerFixture.run, 'run', 'interrupted', 2);
    exactGap(migrated, ownerFixture.review, 'review_source', 'open', 1);
    exactGap(migrated, ownerFixture.patch, 'patch_applied', 'applied', null);
    assertGapBackedMutators(migrated, ownerFixture);

    const rollbackSentinel = Object.assign(
      new Error('rollback reserved legacy owner identity checks'),
      { code: 'test_reserved_owner_identity_rollback' },
    );
    assert.throws(() => migrated.withProjectDatabaseWrite(
      'test.schema31.reserved-owner-identity-checks',
      () => {
    const intentScope = ownerFixture.intent.scope;
    const reservedIntentId = ownerFixture.intent.owner.id;
    assert.equal(migrated.db.prepare(`
      DELETE FROM run_intents WHERE id = ? AND project_id = ? AND canvas_id = ?
    `).run(reservedIntentId, intentScope.projectId, intentScope.canvasId).changes, 1);
    assert.throws(
      () => migrated.createRunIntent({
        id: reservedIntentId,
        projectId: intentScope.projectId,
        canvasId: intentScope.canvasId,
        canvasRevision: migrated.getCanvas(intentScope.canvasId).revision,
        nodeIds: [],
        idempotencyKey: 'must-not-reuse-frozen-intent-identity',
        requestedBy: ACTOR_ID,
      }),
      (error) => error?.code === 'legacy_snapshot_gap_owner_identity_reserved'
        && error?.status === 409
        && error?.details?.action === 'create-run-intent',
    );
    assert.equal(migrated.db.prepare(`
      SELECT COUNT(*) AS count FROM run_intents WHERE id = ?
    `).get(reservedIntentId).count, 0);

    const runScope = ownerFixture.run.scope;
    const reservedRunId = ownerFixture.run.owner.id;
    assert.equal(migrated.db.prepare(`
      DELETE FROM runs WHERE id = ? AND project_id = ? AND canvas_id = ?
    `).run(reservedRunId, runScope.projectId, runScope.canvasId).changes, 1);
    assert.throws(
      () => migrated.createRun({
        id: reservedRunId,
        projectId: runScope.projectId,
        canvasId: runScope.canvasId,
        canvasRevision: migrated.getCanvas(runScope.canvasId).revision,
        initiatorId: ACTOR_ID,
        status: 'queued',
      }),
      (error) => error?.code === 'legacy_snapshot_gap_owner_identity_reserved'
        && error?.status === 409
        && error?.details?.action === 'create-run',
    );
    assert.equal(migrated.db.prepare(`
      SELECT COUNT(*) AS count FROM runs WHERE id = ?
    `).get(reservedRunId).count, 0);

    const reviewScope = ownerFixture.review.scope;
    const reservedReviewId = ownerFixture.review.owner.id;
    assert.equal(migrated.db.prepare(`
      DELETE FROM review_threads WHERE id = ? AND project_id = ? AND canvas_id = ?
    `).run(reservedReviewId, reviewScope.projectId, reviewScope.canvasId).changes, 1);
    assert.throws(
      () => migrated.createReviewThread({
        id: reservedReviewId,
        projectId: reviewScope.projectId,
        canvasId: reviewScope.canvasId,
        canvasRevision: migrated.getCanvas(reviewScope.canvasId).revision,
        anchor: { kind: 'canvas', x: 0, y: 0 },
        status: 'open',
        severity: 'normal',
        createdBy: ACTOR_ID,
      }),
      (error) => error?.code === 'legacy_snapshot_gap_owner_identity_reserved'
        && error?.status === 409
        && error?.details?.action === 'create-review-thread',
    );
    assert.equal(migrated.db.prepare(`
      SELECT COUNT(*) AS count FROM review_threads WHERE id = ?
    `).get(reservedReviewId).count, 0);

    const patchScope = ownerFixture.patch.scope;
    const reservedPatchId = ownerFixture.patch.owner.id;
    assert.equal(migrated.db.prepare(`
      DELETE FROM canvas_patch_applications
      WHERE project_id = ? AND canvas_id = ? AND patch_id = ?
    `).run(patchScope.projectId, patchScope.canvasId, reservedPatchId).changes, 1);
    const beforeReservedPatch = migrated.getCanvas(patchScope.canvasId);
    const reservedPatch = {
      schema: 't8-canvas-patch-v1',
      id: reservedPatchId,
      baseRevision: beforeReservedPatch.revision,
      summary: 'must not reuse a frozen legacy owner identity',
      diagnosticsResolved: [],
      requiresConfirmation: true,
      operations: [{
        type: 'node.add',
        payload: {
          node: {
            id: 'reserved-legacy-gap-node',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { prompt: 'must roll back' },
          },
        },
      }],
    };
    const reservedPreview = migrated.previewCanvasPatch(patchScope.canvasId, reservedPatch, {
      actorId: ACTOR_ID,
    });
    assert.throws(
      () => migrated.applyCanvasPatch(patchScope.canvasId, reservedPatch, {
        projectId: patchScope.projectId,
        previewDigest: reservedPreview.previewDigest,
        confirmed: true,
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
      (error) => error?.code === 'legacy_snapshot_gap_owner_identity_reserved'
        && error?.status === 409
        && error?.details?.action === 'apply-canvas-patch',
    );
    assert.deepEqual(migrated.getCanvas(patchScope.canvasId), beforeReservedPatch);
    assert.equal(migrated.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_patch_applications
      WHERE project_id = ? AND canvas_id = ? AND patch_id = ?
    `).get(patchScope.projectId, patchScope.canvasId, reservedPatchId).count, 0);
    assert.equal(migrated.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_legacy_snapshot_gaps
      WHERE project_id = ? AND canvas_id = ?
        AND pin_kind = 'patch_applied' AND owner_id = ? AND slot = 'applied'
    `).get(patchScope.projectId, patchScope.canvasId, reservedPatchId).count, 1);
        throw rollbackSentinel;
      },
    ), (error) => error === rollbackSentinel);
    exactGap(migrated, ownerFixture.intent, 'run_intent', 'stale', 2);
    exactGap(migrated, ownerFixture.run, 'run', 'interrupted', 2);
    exactGap(migrated, ownerFixture.review, 'review_source', 'open', 1);
    exactGap(migrated, ownerFixture.patch, 'patch_applied', 'applied', null);
    assertDatabaseIntegrity(migrated.db);

    await migrated.close();
    migrated = null;
    migrated = new ProjectDatabase(fixturePath.filename, { autoBackup: false });
    assert.equal(migrated.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_legacy_snapshot_gaps
    `).get().count, 4);
    exactGap(migrated, ownerFixture.intent, 'run_intent', 'stale', 2);
    exactGap(migrated, ownerFixture.run, 'run', 'interrupted', 2);
    exactGap(migrated, ownerFixture.review, 'review_source', 'open', 1);
    exactGap(migrated, ownerFixture.patch, 'patch_applied', 'applied', null);
    assertGapBackedMutators(migrated, ownerFixture);
    assertDatabaseIntegrity(migrated.db);
  } finally {
    if (migrated) await migrated.close();
    if (legacy) await legacy.close();
    if (seed) await seed.close();
    cleanupTemporaryDirectory(fixturePath.directory);
    cleanupTemporaryDirectory(seedPath.directory);
  }
});
