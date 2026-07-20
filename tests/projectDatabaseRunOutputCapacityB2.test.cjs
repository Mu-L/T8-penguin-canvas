'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'project-run-output-capacity-b2';
const CANVAS_ID = 'canvas-run-output-capacity-b2';
const NODE_ID = 'node-run-output-capacity-b2';
const MAX_PAGE_COUNT_RESET = 1073741823;
const WRITE_OPERATION = 'run.output-assets.record';

function createTempDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-run-output-capacity-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  return {
    directory,
    database: new ProjectDatabase(filename, { autoBackup: false }),
  };
}

async function closeTempDatabase(database, directory) {
  try {
    if (database?.db?.open) database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
  } catch (_) {}
  try { await database?.close(); } catch (_) {}
  fs.rmSync(directory, { recursive: true, force: true });
}

function createRunOutputFixture(database, suffix = '') {
  const canvas = database.ensureCanvas(CANVAS_ID, {
    projectId: PROJECT_ID,
    nodes: [{
      id: NODE_ID,
      type: 'image',
      position: { x: 0, y: 0 },
      data: { prompt: 'B2 atomic run output' },
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }, PROJECT_ID);
  const run = database.createRun({
    id: `run-output-capacity-b2${suffix}`,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    canvasRevision: canvas.revision,
    initiatorId: 'run-output-owner-b2',
    status: 'running',
  });
  const nodeRun = database.createNodeRun({
    id: `node-run-output-capacity-b2${suffix}`,
    runId: run.id,
    nodeId: NODE_ID,
    originalNodeId: NODE_ID,
    status: 'running',
    inputSnapshot: {
      node: {
        id: NODE_ID,
        type: 'image',
        data: { prompt: 'B2 atomic run output' },
      },
    },
  });
  const attempt = database.createAttempt({
    id: `attempt-run-output-capacity-b2${suffix}`,
    nodeRunId: nodeRun.id,
    provider: 'capacity-provider-b2',
    model: 'capacity-model-b2',
    status: 'running',
  });
  return {
    run,
    nodeRun,
    attempt,
    request: {
      runId: run.id,
      nodeRunId: nodeRun.id,
      attemptId: attempt.id,
      outputs: [{
        kind: 'image',
        sourceUrl: `https://cdn.example.test${suffix}/run-output.png`,
        filename: `run-output${suffix}.png`,
        mimeType: 'image/png',
        metadata: { operation: 'image-generate' },
      }],
    },
  };
}

function orderedRows(database, table, orderBy) {
  return database.db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
}

function runOutputState(database, nodeRunId) {
  return {
    nodeRun: database.getNodeRun(nodeRunId),
    assets: orderedRows(database, 'assets', 'id'),
    blobRefs: orderedRows(database, 'asset_blob_refs', 'asset_id'),
    accessPolicies: orderedRows(database, 'asset_access_policies', 'project_id, asset_id'),
    catalogRevisions: orderedRows(database, 'asset_catalog_revisions', 'project_id'),
    lineage: orderedRows(database, 'asset_lineage_events', 'id'),
    canvasGrants: orderedRows(database, 'canvas_resource_grants', 'project_id, canvas_id, resource_type, resource_id'),
    outputCommits: orderedRows(database, 'run_output_commits', 'op_id'),
    outputSlots: orderedRows(database, 'run_output_slot_reservations', 'attempt_entity_uid, output_ordinal'),
  };
}

function armLateNodeRunFull(database, nodeRunId) {
  let hitCount = 0;
  database.db.function('b2_run_output_full_mark', () => {
    hitCount += 1;
    return 1;
  });
  database.db.exec(`
    CREATE TABLE b2_run_output_capacity_filler (
      id INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
    CREATE TRIGGER b2_run_output_late_full
    BEFORE UPDATE OF output_refs_json ON node_runs
    WHEN NEW.id = '${nodeRunId}'
    BEGIN
      SELECT b2_run_output_full_mark();
      INSERT INTO b2_run_output_capacity_filler(payload) VALUES (zeroblob(16777216));
    END;
  `);
  database.db.pragma('wal_checkpoint(TRUNCATE)');
  database.db.exec('VACUUM');
  database.db.pragma('wal_checkpoint(TRUNCATE)');
  const pageCount = Number(database.db.pragma('page_count', { simple: true }));
  const constrainedPageCount = pageCount + 64;
  assert.equal(
    Number(database.db.pragma(`max_page_count = ${constrainedPageCount}`, { simple: true })),
    constrainedPageCount,
  );
  return {
    get hitCount() { return hitCount; },
    disarm() {
      database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
      database.db.exec('DROP TRIGGER b2_run_output_late_full');
    },
  };
}

function assertStorageCapacityError(error, operation) {
  return error instanceof ProjectDatabaseStorageCapacityError
    && error.code === 'project_database_storage_capacity_exceeded'
    && error.status === 507
    && error.statusCode === 507
    && error.reason === 'sqlite-full'
    && error.details?.reason === 'sqlite-full'
    && error.details?.operation === operation;
}

test('B2 recordRunOutputAssets rolls back Asset, lineage, grant and NodeRun on a late real SQLITE_FULL, then retries exactly', async () => {
  const { database, directory } = createTempDatabase();
  try {
    const fixture = createRunOutputFixture(database);
    const full = armLateNodeRunFull(database, fixture.nodeRun.id);
    const before = runOutputState(database, fixture.nodeRun.id);

    assert.throws(
      () => database.recordRunOutputAssets(fixture.request),
      (error) => assertStorageCapacityError(error, WRITE_OPERATION),
    );
    assert.equal(full.hitCount, 1);
    assert.deepEqual(runOutputState(database, fixture.nodeRun.id), before);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM b2_run_output_capacity_filler').get().count, 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    full.disarm();
    const recorded = database.recordRunOutputAssets(fixture.request);
    assert.equal(recorded.assets.length, 1);
    assert.deepEqual(recorded.nodeRun.outputRefs, [recorded.assets[0].id]);
    assert.equal(database.getAssetLineage(recorded.assets[0].id).length, 1);
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_resource_grants
      WHERE project_id = ? AND canvas_id = ? AND resource_type = 'asset' AND resource_id = ?
    `).get(PROJECT_ID, CANVAS_ID, recorded.assets[0].id).count, 1);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM run_output_commits').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM run_output_slot_reservations').get().count, 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    await closeTempDatabase(database, directory);
  }
});

test('B2 recordRunOutputAssets leaves BUSY and business conflicts unchanged after rolling back an earlier output', async () => {
  const { database, directory } = createTempDatabase();
  try {
    const fixture = createRunOutputFixture(database, '-errors');
    const request = {
      ...fixture.request,
      outputs: [
        fixture.request.outputs[0],
        {
          kind: 'text',
          text: 'second output reaches the injected failure',
          filename: 'second-output.txt',
          mimeType: 'text/plain',
        },
      ],
    };
    const before = runOutputState(database, fixture.nodeRun.id);
    const originalUpsertAsset = database.upsertAsset.bind(database);
    for (const source of [
      Object.assign(new Error('busy must remain busy'), { code: 'SQLITE_BUSY_TIMEOUT' }),
      Object.assign(new Error('business conflict must remain unchanged'), {
        code: 'asset_identity_conflict',
        status: 409,
      }),
    ]) {
      let callCount = 0;
      database.upsertAsset = (input) => {
        callCount += 1;
        if (callCount === 2) throw source;
        return originalUpsertAsset(input);
      };
      let caught = null;
      try {
        database.recordRunOutputAssets(request);
      } catch (error) {
        caught = error;
      }
      assert.strictEqual(caught, source);
      assert.equal(callCount, 2);
      assert.deepEqual(runOutputState(database, fixture.nodeRun.id), before);
    }
    database.upsertAsset = originalUpsertAsset;
  } finally {
    await closeTempDatabase(database, directory);
  }
});

test('B2 nested recordRunOutputAssets leaves raw FULL for the outer writer boundary to translate after rollback', async () => {
  const { database, directory } = createTempDatabase();
  try {
    const fixture = createRunOutputFixture(database, '-nested');
    const before = runOutputState(database, fixture.nodeRun.id);
    const source = Object.assign(new Error('late nested full'), { code: 'SQLITE_FULL' });
    const originalUpsertAsset = database.upsertAsset.bind(database);
    let callCount = 0;
    database.upsertAsset = (input) => {
      callCount += 1;
      if (callCount === 2) throw source;
      return originalUpsertAsset(input);
    };
    const request = {
      ...fixture.request,
      outputs: [
        fixture.request.outputs[0],
        { kind: 'text', text: 'nested second output', filename: 'nested.txt', mimeType: 'text/plain' },
      ],
    };
    assert.throws(
      () => database.withProjectDatabaseWrite('run.output-assets.outer-test', () => (
        database.recordRunOutputAssets(request)
      )),
      (error) => assertStorageCapacityError(error, 'run.output-assets.outer-test'),
    );
    assert.equal(callCount, 2);
    assert.deepEqual(runOutputState(database, fixture.nodeRun.id), before);
    database.upsertAsset = originalUpsertAsset;
  } finally {
    await closeTempDatabase(database, directory);
  }
});
