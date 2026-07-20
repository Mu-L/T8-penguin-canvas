const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applyCanvasOperation,
  isUuid,
  normalizeCanvasDocument,
  stableEntityUuid,
} = require('../backend/src/collaboration/protocol');
const {
  PROJECT_DATABASE_MIGRATIONS,
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');
const {
  assertCurrentProjectDatabaseRegistry,
  removeSchema31ExtensionForSyntheticSchema30,
  removeSchema32SyntheticFixtureArtifacts,
} = require('./helpers/projectDatabaseVersion.cjs');
const {
  PROJECT_DATABASE_MIGRATION_29_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration29');
const {
  PROJECT_DATABASE_MIGRATION_30_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration30');

function graph() {
  return normalizeCanvasDocument('canvas-b1', {
    projectId: 'project-b1',
    nodes: [{ id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: {} }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
}

test('B1 graph adds reject malformed supplied UUIDs and generate canonical identity when omitted', () => {
  const document = graph();
  assert.throws(() => applyCanvasOperation(document, {
    opId: 'op-invalid-uid', actorId: 'actor', sessionId: 'session', clientSeq: 1,
    baseRevision: document.revision, timestamp: 1, type: 'node.add',
    payload: { node: { id: 'node-b', entityUid: 'spoofed', type: 'text', position: { x: 1, y: 1 }, data: {} } },
  }), /entityUid 无效/);

  const applied = applyCanvasOperation(document, {
    opId: 'op-generated-uid', actorId: 'actor', sessionId: 'session', clientSeq: 2,
    baseRevision: document.revision, timestamp: 2, type: 'node.add',
    payload: { node: { id: 'node-b', type: 'text', position: { x: 1, y: 1 }, data: {} } },
  });
  assert.equal(isUuid(applied.document.nodes.find((node) => node.id === 'node-b').entityUid), true);
});

test('B1 asset identity is immutable and a pre-identity ledger deterministically migrates malformed legacy values', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b1-asset-'));
  const filename = path.join(root, 'project.sqlite');
  let database = null;
  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    assert.throws(() => database.upsertAsset({
      id: 'legacy-asset', projectId: 'project-b1', entityUid: 'not-a-uuid',
      kind: 'image', filename: 'legacy.png', storageMode: 'remote', sourceUrl: 'https://example.test/legacy.png',
    }), /entityUid 必须是 UUID/);

    const canonical = database.upsertAsset({
      id: 'legacy-asset', projectId: 'project-b1',
      kind: 'image', filename: 'legacy.png', storageMode: 'remote', sourceUrl: 'https://example.test/legacy.png',
    });
    assert.equal(canonical.entityUid, stableEntityUuid('project-b1', 'asset', 'legacy-asset'));
    assert.throws(() => database.upsertAsset({
      ...canonical,
      entityUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }), /entityUid 不可修改/);

    database.db.prepare('UPDATE assets SET entity_uid = ? WHERE id = ?').run('legacy-invalid', 'legacy-asset');
    const identityMigration = PROJECT_DATABASE_MIGRATIONS.find((migration) => (
      migration.name === 'stable-cross-domain-identities'
    ));
    assert.equal(identityMigration?.version, 26);
    removeSchema31ExtensionForSyntheticSchema30(database.db);
    database.db.prepare('DELETE FROM schema_migration_receipts WHERE version = 30').run();
    database.db.prepare('DELETE FROM schema_migrations WHERE version = 30').run();
    database.db.exec(PROJECT_DATABASE_MIGRATION_30_DOWN_SQL);
    database.db.exec(PROJECT_DATABASE_MIGRATION_29_DOWN_SQL);
    database.db.prepare('DELETE FROM schema_migrations WHERE version = 29').run();
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
    database.db.prepare('DELETE FROM schema_migrations WHERE version >= ?').run(identityMigration.version);
    assert.equal(
      database.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      identityMigration.version - 1,
    );
    await database.close();
    database = null;
    removeSchema32SyntheticFixtureArtifacts(filename);
    database = new ProjectDatabase(filename, {
      autoBackup: false,
      // This fixture intentionally rewinds a database after adding business
      // rows. Reusing the first-open migration backup would correctly fail as
      // stale evidence, so the simulated second upgrade needs a new generation.
      preMigrationBackupFilename: path.join(root, 'reopen-pre-migration-v28.sqlite3'),
      preMigration30BackupFilename: path.join(root, 'reopen-pre-migration-v29.sqlite3'),
      preMigration31BackupFilename: path.join(root, 'reopen-pre-migration-v30.sqlite3'),
      preMigration32BackupFilename: path.join(root, 'reopen-pre-migration-v31.sqlite3'),
    });
    assert.equal(database.getAsset('legacy-asset').entityUid, stableEntityUuid('project-b1', 'asset', 'legacy-asset'));
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
    await database.close();
    database = null;
  } finally {
    await database?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('latest schema preserves schema 26 canonical UUIDs for subflows, reviews and the complete run hierarchy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b1-hierarchy-'));
  const filename = path.join(root, 'project.sqlite');
  let database = new ProjectDatabase(filename, { autoBackup: false });
  try {
    assertCurrentProjectDatabaseRegistry(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATIONS);
    const definition = database.saveSubflowDefinition({
      id: 'legacy-subflow', projectId: 'project-b1', name: 'Legacy',
      nodes: [], edges: [], ports: { inputs: [], outputs: [] }, parameters: [],
    });
    const nextDefinition = database.saveSubflowDefinition({
      id: 'legacy-subflow', projectId: 'project-b1', name: 'Legacy v2',
      nodes: [], edges: [], ports: { inputs: [], outputs: [] }, parameters: [],
    }, { expectedRevision: definition.revision });
    assert.equal(nextDefinition.entityUid, definition.entityUid);
    assert.throws(() => database.saveSubflowDefinition({
      id: 'legacy-subflow', projectId: 'project-b1',
      entityUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Spoofed identity',
      nodes: [], edges: [], ports: { inputs: [], outputs: [] }, parameters: [],
    }, { expectedRevision: nextDefinition.revision }), /entityUid 不可修改/);
    database.db.prepare(`
      UPDATE subflow_definitions
      SET definition_json = json_set(definition_json, '$.entityUid', 'legacy-invalid')
      WHERE project_id = ? AND id = ? AND version = 1
    `).run('project-b1', 'legacy-subflow');
    database.db.prepare(`
      UPDATE subflow_definitions
      SET definition_json = json_set(
        definition_json,
        '$.entityUid',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      )
      WHERE project_id = ? AND id = ? AND version = 2
    `).run('project-b1', 'legacy-subflow');
    assert.throws(
      () => database.getSubflowDefinition('legacy-subflow', 1, 'project-b1'),
      /definition_json 与 SQL 行绑定不一致/,
    );
    assert.throws(
      () => database.getSubflowDefinition('legacy-subflow', 2, 'project-b1'),
      /definition_json 与 SQL 行绑定不一致/,
    );
    removeSchema31ExtensionForSyntheticSchema30(database.db);
    database.db.prepare('DELETE FROM schema_migration_receipts WHERE version = 30').run();
    database.db.prepare('DELETE FROM schema_migrations WHERE version = 30').run();
    database.db.exec(PROJECT_DATABASE_MIGRATION_30_DOWN_SQL);
    database.db.exec(PROJECT_DATABASE_MIGRATION_29_DOWN_SQL);
    database.db.prepare('DELETE FROM schema_migrations WHERE version = 29').run();
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
    database.db.prepare('DELETE FROM schema_migrations WHERE version >= 26').run();
    await database.close();
    database = null;
    removeSchema32SyntheticFixtureArtifacts(filename);
    database = new ProjectDatabase(filename, {
      autoBackup: false,
      preMigrationBackupFilename: path.join(root, 'reopen-pre-migration-v28.sqlite3'),
      preMigration30BackupFilename: path.join(root, 'reopen-pre-migration-v29.sqlite3'),
      preMigration31BackupFilename: path.join(root, 'reopen-pre-migration-v30.sqlite3'),
      preMigration32BackupFilename: path.join(root, 'reopen-pre-migration-v31.sqlite3'),
    });
    const migratedDefinitions = database.db.prepare(`
      SELECT id, entity_uid, version, project_id, definition_json
      FROM subflow_definitions
      WHERE project_id = ? AND id = ?
      ORDER BY version
    `).all('project-b1', 'legacy-subflow');
    assert.equal(migratedDefinitions.length, 2);
    for (const row of migratedDefinitions) {
      const stored = JSON.parse(row.definition_json);
      assert.equal(stored.id, row.id);
      assert.equal(stored.entityUid, row.entity_uid);
      assert.equal(stored.version, row.version);
      assert.equal(stored.projectId, row.project_id);
    }
    assert.equal(
      database.getSubflowDefinition('legacy-subflow', 1, 'project-b1').entityUid,
      stableEntityUuid('project-b1', 'subflow-definition', 'legacy-subflow'),
    );
    database.ensureCanvas('canvas-b1', {
      projectId: 'project-b1',
      nodes: [{ id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }, 'project-b1');
    const thread = database.createReviewThread({
      id: 'legacy-thread', projectId: 'project-b1', canvasId: 'canvas-b1', canvasRevision: 1,
      anchor: { kind: 'canvas', targetEntityUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      createdBy: 'member-b1',
    });
    const comment = database.createReviewComment({
      id: 'legacy-comment', threadId: thread.id, body: 'review', createdBy: 'member-b1',
    });
    const intent = database.createRunIntent({
      id: 'legacy-intent', projectId: 'project-b1', canvasId: 'canvas-b1', canvasRevision: 1,
      nodeIds: ['node-a'], idempotencyKey: 'intent-b1', requestedBy: 'member-b1',
    });
    const run = database.createRun({
      id: 'legacy-run', projectId: 'project-b1', canvasId: 'canvas-b1', canvasRevision: 1,
      initiatorId: 'member-b1',
    });
    const nodeRun = database.createNodeRun({ id: 'legacy-node-run', runId: run.id, nodeId: 'node-a' });
    const attempt = database.createAttempt({ id: 'legacy-attempt', nodeRunId: nodeRun.id });
    const event = database.appendRunEvent(run.id, { id: 'legacy-event', nodeRunId: nodeRun.id, type: 'node.output' });

    for (const value of [definition, thread, comment, intent, run, nodeRun, attempt, event]) {
      assert.equal(isUuid(value.entityUid), true, JSON.stringify(value));
    }
    assert.equal(database.getSubflowDefinition('legacy-subflow', 2, 'project-b1').entityUid, definition.entityUid);
    assert.equal(database.getReviewThread(thread.id).entityUid, thread.entityUid);
    assert.equal(database.listReviewComments(thread.id)[0].entityUid, comment.entityUid);
    assert.equal(database.getRunIntent(intent.id).entityUid, intent.entityUid);
    assert.equal(database.getRun(run.id).entityUid, run.entityUid);
    assert.equal(database.getNodeRun(nodeRun.id).entityUid, nodeRun.entityUid);
    assert.equal(database.getAttempt(attempt.id).entityUid, attempt.entityUid);
    const columns = (table) => new Set(database.db.pragma(`table_info(${table})`).map((row) => row.name));
    for (const table of ['runs', 'node_runs', 'run_attempts', 'run_events', 'run_intents', 'review_threads', 'review_comments', 'subflow_definitions']) {
      assert.equal(columns(table).has('entity_uid'), true, table);
    }
    assert.equal(
      database.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      PROJECT_DATABASE_SCHEMA_VERSION,
    );
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    await database?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
