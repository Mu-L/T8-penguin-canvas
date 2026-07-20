'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProjectDatabase,
  translateProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');

const MAX_PAGE_COUNT_RESET = 1073741823;
const PROJECT_ID = 'project-runs-route-capacity-b2';
const CANVAS_ID = 'canvas-runs-route-capacity-b2';
const RUN_ID = 'run-routes-capacity-b2';
const SEED_NODE_RUN_ID = 'node-run-route-seed-capacity-b2';
const CREATE_NODE_RUN_ID = 'node-run-route-create-capacity-b2';
const ATTEMPT_ID = 'attempt-route-capacity-b2';

function installModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  const previous = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
  return () => {
    if (previous) require.cache[resolved] = previous;
    else delete require.cache[resolved];
  };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function scalarCount(database, sql, ...values) {
  return Number(database.db.prepare(sql).get(...values)?.count || 0);
}

function armRealRouteFull(database, fixtureName, triggerSql) {
  const markerName = `${fixtureName}_mark`;
  const fillerTable = `${fixtureName}_filler`;
  const triggerName = `${fixtureName}_full`;
  let hitCount = 0;
  let active = true;

  database.db.function(markerName, () => {
    hitCount += 1;
    return 1;
  });
  database.db.exec(`
    CREATE TABLE ${fillerTable} (
      id INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
    ${triggerSql({ markerName, fillerTable, triggerName })}
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
    fillerTable,
    get hitCount() { return hitCount; },
    disarm() {
      if (!active) return;
      database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
      database.db.exec(`DROP TRIGGER ${triggerName}`);
      active = false;
    },
  };
}

async function requestJson(server, pathname, method, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function assertRedactedCapacityResponse(result) {
  assert.equal(result.response.status, 507, JSON.stringify(result.body));
  assert.deepEqual(result.body, {
    success: false,
    code: 'project_database_storage_capacity_exceeded',
    error: '项目数据库或 SQLite 临时存储空间不足，本次写入已回滚',
    reason: 'sqlite-full',
    retryable: false,
  });
  assert.doesNotMatch(
    JSON.stringify(result.body),
    /Users|Administrator|private-user|projects\.sqlite3|token|never-expose/i,
  );
}

function assertHealthy(database) {
  assert.equal(database.db.inTransaction, false);
  assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.db.pragma('foreign_key_check'), []);
}

test('B2 project Run route converts post-rollback raw SQLITE_FULL into a redacted 507 response', async (t) => {
  const privateMessage = 'database full at C:\\Users\\private-user\\projects.sqlite3 token=never-expose';
  const database = {
    getRunRetentionPolicy() {
      return {};
    },
    setRunRetentionPolicy() {
      throw Object.assign(new Error(privateMessage), {
        code: 'SQLITE_FULL',
        path: 'C:\\Users\\private-user\\projects.sqlite3',
      });
    },
  };
  class FakeExecutionPolicyError extends Error {}
  class FakeHostExecutionPolicy {
    constructor() {}
  }
  const restores = [
    installModuleMock('../backend/src/services/projectDatabase', {
      getProjectDatabase: () => database,
      translateProjectDatabaseStorageCapacityError,
    }),
    installModuleMock('../backend/src/services/assetPreviewPipeline', {
      getAssetPreviewPipeline: () => ({}),
    }),
    installModuleMock('../backend/src/services/assetIndexer', {
      getBackgroundAssetIndexer: () => ({ commitHostRunOutputAssets: async () => ({}) }),
    }),
    installModuleMock('../backend/src/collaboration/gateway', {
      getCollaborationGateway: () => ({
        broadcastHostRunIntent() {},
        broadcastHostRunState() {},
        broadcastHostNodeRunState() {},
        broadcastHostRunOutput() {},
      }),
    }),
    installModuleMock('../backend/src/services/runRecovery', {
      getRunRecoveryManager: () => ({
        status: () => ({}),
        recoverPendingRuns: async () => ({}),
      }),
    }),
    installModuleMock('../backend/src/collaboration/executionPolicy', {
      ExecutionPolicyError: FakeExecutionPolicyError,
      HostExecutionPolicy: FakeHostExecutionPolicy,
    }),
  ];
  const publicErrorPath = require.resolve('../backend/src/services/projectDatabasePublicError');
  const routePath = require.resolve('../backend/src/routes/projectRuns');
  const previousPublicError = require.cache[publicErrorPath];
  const previousRoute = require.cache[routePath];
  delete require.cache[publicErrorPath];
  delete require.cache[routePath];
  const router = require(routePath);

  const app = express();
  app.use(express.json({ strict: true }));
  app.use('/api/project-runs', router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await closeServer(server);
    restores.reverse().forEach((restore) => restore());
    delete require.cache[routePath];
    delete require.cache[publicErrorPath];
    if (previousRoute) require.cache[routePath] = previousRoute;
    if (previousPublicError) require.cache[publicErrorPath] = previousPublicError;
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/project-runs/retention`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-capacity-route' }),
  });
  const body = await response.json();

  assert.equal(response.status, 507, JSON.stringify(body));
  assert.deepEqual(body, {
    success: false,
    code: 'project_database_storage_capacity_exceeded',
    error: '项目数据库或 SQLite 临时存储空间不足，本次写入已回滚',
    reason: 'sqlite-full',
    retryable: false,
  });
  assert.doesNotMatch(JSON.stringify(body), /Users|private-user|projects\.sqlite3|token|never-expose/i);
});

test('B2 project Run mutation routes roll back real disk SQLITE_FULL, suppress broadcasts, and retry the same requests', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-private-user-token-project-runs-route-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const database = new ProjectDatabase(filename, { autoBackup: false });
  const nodeBroadcasts = [];
  const projectDatabaseModule = require('../backend/src/services/projectDatabase');
  class FakeExecutionPolicyError extends Error {}
  class FakeHostExecutionPolicy {
    constructor() {}
  }
  const restores = [
    installModuleMock('../backend/src/services/projectDatabase', {
      ...projectDatabaseModule,
      getProjectDatabase: () => database,
    }),
    installModuleMock('../backend/src/services/assetPreviewPipeline', {
      getAssetPreviewPipeline: () => ({}),
    }),
    installModuleMock('../backend/src/services/assetIndexer', {
      getBackgroundAssetIndexer: () => ({ commitHostRunOutputAssets: async () => ({}) }),
    }),
    installModuleMock('../backend/src/collaboration/gateway', {
      getCollaborationGateway: () => ({
        broadcastHostRunIntent() {},
        broadcastHostRunState() {},
        broadcastHostNodeRunState(run, nodeRun) {
          nodeBroadcasts.push({ runId: run.id, nodeRunId: nodeRun.id, status: nodeRun.status });
        },
        broadcastHostRunOutput() {},
      }),
    }),
    installModuleMock('../backend/src/services/runRecovery', {
      getRunRecoveryManager: () => ({
        status: () => ({}),
        recoverPendingRuns: async () => ({}),
      }),
    }),
    installModuleMock('../backend/src/collaboration/executionPolicy', {
      ExecutionPolicyError: FakeExecutionPolicyError,
      HostExecutionPolicy: FakeHostExecutionPolicy,
    }),
  ];
  const publicErrorPath = require.resolve('../backend/src/services/projectDatabasePublicError');
  const routePath = require.resolve('../backend/src/routes/projectRuns');
  const previousPublicError = require.cache[publicErrorPath];
  const previousRoute = require.cache[routePath];
  delete require.cache[publicErrorPath];
  delete require.cache[routePath];
  const router = require(routePath);

  const app = express();
  app.use(express.json({ strict: true }));
  app.use('/api/project-runs', router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const armedFaults = [];
  t.after(async () => {
    for (const fault of armedFaults) {
      try { fault.disarm(); } catch (_) {}
    }
    await closeServer(server);
    restores.reverse().forEach((restore) => restore());
    delete require.cache[routePath];
    delete require.cache[publicErrorPath];
    if (previousRoute) require.cache[routePath] = previousRoute;
    if (previousPublicError) require.cache[publicErrorPath] = previousPublicError;
    try {
      if (database?.db?.open) database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
    } catch (_) {}
    try { await database.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const canvas = database.ensureCanvas(CANVAS_ID, {
    projectId: PROJECT_ID,
    entityUid: '41000000-0000-4000-8000-000000000001',
    nodes: [{
      id: 'canvas-node-route-capacity-b2',
      entityUid: '41000000-0000-4000-8000-000000000002',
      entityRevision: 1,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { prompt: 'real route capacity rollback' },
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }, PROJECT_ID);
  const run = database.createRun({
    id: RUN_ID,
    entityUid: '41000000-0000-4000-8000-000000000003',
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    canvasRevision: canvas.revision,
    initiatorId: 'route-capacity-owner-b2',
    status: 'running',
  });
  const seedNodeRun = database.createNodeRun({
    id: SEED_NODE_RUN_ID,
    entityUid: '41000000-0000-4000-8000-000000000004',
    runId: run.id,
    nodeId: 'canvas-node-route-capacity-b2',
    status: 'queued',
  });

  const nodeCreateRequest = Object.freeze({
    id: CREATE_NODE_RUN_ID,
    entityUid: '41000000-0000-4000-8000-000000000005',
    nodeId: 'canvas-node-route-capacity-b2',
    inputSnapshot: Object.freeze({ prompt: 'same node create request' }),
  });
  const nodeCreateFault = armRealRouteFull(
    database,
    'b2_project_runs_route_node_create',
    ({ markerName, fillerTable, triggerName }) => `
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON run_events
      WHEN NEW.run_id = '${RUN_ID}' AND NEW.node_run_id = '${CREATE_NODE_RUN_ID}' AND NEW.type = 'node.queued'
      BEGIN
        SELECT ${markerName}();
        INSERT INTO ${fillerTable}(payload) VALUES (zeroblob(16777216));
      END;
    `,
  );
  armedFaults.push(nodeCreateFault);
  const failedNodeCreate = await requestJson(
    server,
    `/api/project-runs/${RUN_ID}/nodes`,
    'POST',
    nodeCreateRequest,
  );
  assertRedactedCapacityResponse(failedNodeCreate);
  assert.equal(nodeCreateFault.hitCount, 1, 'FULL must occur after the NodeRun insert');
  assert.equal(database.getNodeRun(CREATE_NODE_RUN_ID), null);
  assert.equal(scalarCount(database, `SELECT COUNT(*) AS count FROM ${nodeCreateFault.fillerTable}`), 0);
  assert.equal(scalarCount(
    database,
    'SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND node_run_id = ?',
    RUN_ID,
    CREATE_NODE_RUN_ID,
  ), 0);
  assert.deepEqual(nodeBroadcasts, []);
  assertHealthy(database);

  nodeCreateFault.disarm();
  const retriedNodeCreate = await requestJson(
    server,
    `/api/project-runs/${RUN_ID}/nodes`,
    'POST',
    nodeCreateRequest,
  );
  assert.equal(retriedNodeCreate.response.status, 201, JSON.stringify(retriedNodeCreate.body));
  assert.equal(retriedNodeCreate.body.data.id, CREATE_NODE_RUN_ID);
  assert.equal(database.getNodeRun(CREATE_NODE_RUN_ID).status, 'queued');
  assert.equal(scalarCount(
    database,
    'SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND node_run_id = ? AND type = ?',
    RUN_ID,
    CREATE_NODE_RUN_ID,
    'node.queued',
  ), 1);
  assert.deepEqual(nodeBroadcasts, [{
    runId: RUN_ID,
    nodeRunId: CREATE_NODE_RUN_ID,
    status: 'queued',
  }]);
  assertHealthy(database);

  const nodeUpdateRequest = Object.freeze({
    status: 'running',
    eventPayload: Object.freeze({ phase: 'same node update request' }),
  });
  const nodeBeforeUpdate = database.getNodeRun(seedNodeRun.id);
  const nodeUpdateFault = armRealRouteFull(
    database,
    'b2_project_runs_route_node_update',
    ({ markerName, fillerTable, triggerName }) => `
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON run_events
      WHEN NEW.run_id = '${RUN_ID}' AND NEW.node_run_id = '${SEED_NODE_RUN_ID}' AND NEW.type = 'node.started'
      BEGIN
        SELECT ${markerName}();
        INSERT INTO ${fillerTable}(payload) VALUES (zeroblob(16777216));
      END;
    `,
  );
  armedFaults.push(nodeUpdateFault);
  const failedNodeUpdate = await requestJson(
    server,
    `/api/project-runs/${RUN_ID}/nodes/${SEED_NODE_RUN_ID}`,
    'PATCH',
    nodeUpdateRequest,
  );
  assertRedactedCapacityResponse(failedNodeUpdate);
  assert.equal(nodeUpdateFault.hitCount, 1, 'FULL must occur after the NodeRun update');
  assert.deepEqual(database.getNodeRun(SEED_NODE_RUN_ID), nodeBeforeUpdate);
  assert.equal(scalarCount(database, `SELECT COUNT(*) AS count FROM ${nodeUpdateFault.fillerTable}`), 0);
  assert.equal(scalarCount(
    database,
    'SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND node_run_id = ? AND type = ?',
    RUN_ID,
    SEED_NODE_RUN_ID,
    'node.started',
  ), 0);
  assert.equal(nodeBroadcasts.length, 1);
  assertHealthy(database);

  nodeUpdateFault.disarm();
  const retriedNodeUpdate = await requestJson(
    server,
    `/api/project-runs/${RUN_ID}/nodes/${SEED_NODE_RUN_ID}`,
    'PATCH',
    nodeUpdateRequest,
  );
  assert.equal(retriedNodeUpdate.response.status, 200, JSON.stringify(retriedNodeUpdate.body));
  assert.equal(retriedNodeUpdate.body.data.status, 'running');
  assert.equal(retriedNodeUpdate.body.data.revision, nodeBeforeUpdate.revision + 1);
  assert.equal(scalarCount(
    database,
    'SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND node_run_id = ? AND type = ?',
    RUN_ID,
    SEED_NODE_RUN_ID,
    'node.started',
  ), 1);
  assert.deepEqual(nodeBroadcasts.at(-1), {
    runId: RUN_ID,
    nodeRunId: SEED_NODE_RUN_ID,
    status: 'running',
  });
  assertHealthy(database);

  const attemptCreateRequest = Object.freeze({
    id: ATTEMPT_ID,
    entityUid: '41000000-0000-4000-8000-000000000006',
    provider: 'route-capacity-provider-b2',
    model: 'route-capacity-model-b2',
    status: 'running',
    metadata: Object.freeze({ phase: 'same attempt create request' }),
  });
  const broadcastsBeforeAttemptCreate = nodeBroadcasts.length;
  const attemptCreateFault = armRealRouteFull(
    database,
    'b2_project_runs_route_attempt_create',
    ({ markerName, fillerTable, triggerName }) => `
      CREATE TRIGGER ${triggerName}
      AFTER INSERT ON run_attempts
      WHEN NEW.id = '${ATTEMPT_ID}'
      BEGIN
        SELECT ${markerName}();
        INSERT INTO ${fillerTable}(payload) VALUES (zeroblob(16777216));
      END;
    `,
  );
  armedFaults.push(attemptCreateFault);
  const failedAttemptCreate = await requestJson(
    server,
    `/api/project-runs/${RUN_ID}/nodes/${SEED_NODE_RUN_ID}/attempts`,
    'POST',
    attemptCreateRequest,
  );
  assertRedactedCapacityResponse(failedAttemptCreate);
  assert.equal(attemptCreateFault.hitCount, 1, 'FULL must occur after the Attempt insert');
  assert.equal(database.getAttempt(ATTEMPT_ID), null);
  assert.equal(scalarCount(database, `SELECT COUNT(*) AS count FROM ${attemptCreateFault.fillerTable}`), 0);
  assert.equal(nodeBroadcasts.length, broadcastsBeforeAttemptCreate);
  assertHealthy(database);

  attemptCreateFault.disarm();
  const retriedAttemptCreate = await requestJson(
    server,
    `/api/project-runs/${RUN_ID}/nodes/${SEED_NODE_RUN_ID}/attempts`,
    'POST',
    attemptCreateRequest,
  );
  assert.equal(retriedAttemptCreate.response.status, 201, JSON.stringify(retriedAttemptCreate.body));
  assert.equal(retriedAttemptCreate.body.data.id, ATTEMPT_ID);
  assert.equal(scalarCount(
    database,
    'SELECT COUNT(*) AS count FROM run_attempts WHERE id = ?',
    ATTEMPT_ID,
  ), 1);
  assert.equal(nodeBroadcasts.length, broadcastsBeforeAttemptCreate);
  assertHealthy(database);

  const attemptUpdateRequest = Object.freeze({
    status: 'polling',
    pollCount: 3,
    metadata: Object.freeze({ phase: 'same attempt update request' }),
  });
  const attemptBeforeUpdate = database.getAttempt(ATTEMPT_ID);
  const attemptUpdateFault = armRealRouteFull(
    database,
    'b2_project_runs_route_attempt_update',
    ({ markerName, fillerTable, triggerName }) => `
      CREATE TRIGGER ${triggerName}
      AFTER UPDATE ON run_attempts
      WHEN NEW.id = '${ATTEMPT_ID}'
      BEGIN
        SELECT ${markerName}();
        INSERT INTO ${fillerTable}(payload) VALUES (zeroblob(16777216));
      END;
    `,
  );
  armedFaults.push(attemptUpdateFault);
  const failedAttemptUpdate = await requestJson(
    server,
    `/api/project-runs/${RUN_ID}/nodes/${SEED_NODE_RUN_ID}/attempts/${ATTEMPT_ID}`,
    'PATCH',
    attemptUpdateRequest,
  );
  assertRedactedCapacityResponse(failedAttemptUpdate);
  assert.equal(attemptUpdateFault.hitCount, 1, 'FULL must occur after the Attempt update');
  assert.deepEqual(database.getAttempt(ATTEMPT_ID), attemptBeforeUpdate);
  assert.equal(scalarCount(database, `SELECT COUNT(*) AS count FROM ${attemptUpdateFault.fillerTable}`), 0);
  assert.equal(nodeBroadcasts.length, broadcastsBeforeAttemptCreate);
  assertHealthy(database);

  attemptUpdateFault.disarm();
  const retriedAttemptUpdate = await requestJson(
    server,
    `/api/project-runs/${RUN_ID}/nodes/${SEED_NODE_RUN_ID}/attempts/${ATTEMPT_ID}`,
    'PATCH',
    attemptUpdateRequest,
  );
  assert.equal(retriedAttemptUpdate.response.status, 200, JSON.stringify(retriedAttemptUpdate.body));
  assert.equal(retriedAttemptUpdate.body.data.status, 'polling');
  assert.equal(retriedAttemptUpdate.body.data.pollCount, 3);
  assert.equal(retriedAttemptUpdate.body.data.revision, attemptBeforeUpdate.revision + 1);
  assert.equal(scalarCount(
    database,
    'SELECT COUNT(*) AS count FROM run_attempts WHERE id = ?',
    ATTEMPT_ID,
  ), 1);
  assert.equal(nodeBroadcasts.length, broadcastsBeforeAttemptCreate);
  assertHealthy(database);
});
