const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const {
  PROJECT_DATABASE_MIGRATION_29_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration29');
const {
  PROJECT_DATABASE_MIGRATION_30_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration30');
const {
  PROJECT_DATABASE_MIGRATION_31,
} = require('../backend/src/services/projectDatabaseMigration31');
const {
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS,
} = require('../backend/src/services/projectDatabaseMigration31DurableLedgers');
const {
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration31LegacyGaps');
const { CollaborationGateway } = require('../backend/src/collaboration/gateway');
const { HostExecutionPolicy } = require('../backend/src/collaboration/executionPolicy');
const {
  deriveRunIntentAuthority,
  summarizeRunIntentAuthority,
} = require('../backend/src/collaboration/runIntentAuthority');
const {
  stripSchema32ForSyntheticSchema31,
} = require('./helpers/projectDatabaseVersion.cjs');
const MANAGEMENT_AUTHORITY_HEADER = 'x-t8-collaboration-management-token';
const TEST_MANAGEMENT_AUTHORITY = Object.freeze({
  token: 'test-collaboration-management-authority-token-run-intent-01',
  actorId: 'test-run-intent-host-owner',
  sessionId: 'test-run-intent-host-backend-session',
});

function installModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  const previous = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
  return () => {
    if (previous) require.cache[resolved] = previous;
    else delete require.cache[resolved];
  };
}

function node(id, type, data = {}) {
  return { id, type, position: { x: 0, y: 0 }, data };
}

function imageCanvas(database, {
  canvasId = 'canvas-a',
  projectId = 'project-local',
  data = { model: 'gpt-image-2', apiModel: 'gpt-image-2-all' },
  nodes = null,
  edges = [],
} = {}) {
  return database.ensureCanvas(canvasId, {
    nodes: nodes || [node('image-node', 'image', data)],
    edges,
  }, projectId);
}

function insertMember(database, {
  id = 'remote-editor',
  projectId = 'project-local',
  canvasId = 'canvas-a',
  role = 'editor',
  capabilities = ['runWorkflow'],
} = {}) {
  const now = Date.now();
  database.db.prepare(`
    INSERT INTO collaboration_members(
      id, project_id, canvas_id, display_name, role, capabilities_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, canvasId, id, role, JSON.stringify(capabilities), now, now);
  return database.getCollaborationMember(id);
}

function authoritativeIntent(database, suffix, {
  canvas = database.getCanvas('canvas-a'),
  requestedBy = 'remote-editor',
  nodeIds = ['image-node'],
  accepted = false,
} = {}) {
  const authority = deriveRunIntentAuthority(canvas, nodeIds);
  const summary = summarizeRunIntentAuthority(authority);
  const intent = database.createRunIntent({
    projectId: canvas.projectId,
    canvasId: canvas.canvasId,
    canvasRevision: canvas.revision,
    nodeIds: authority.requestedNodeIds,
    idempotencyKey: `authority-intent-${suffix}`,
    requestedBy,
    provider: summary.provider,
    model: summary.model,
    estimatedCost: summary.estimatedCost,
    estimatedCostKnown: summary.estimatedCostKnown,
    executionAuthority: authority,
  });
  if (accepted) database.updateRunIntent(intent.id, { status: 'accepted' });
  return database.getRunIntent(intent.id);
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function stripSchema31ForHistoricalFixture(database) {
  stripSchema32ForSyntheticSchema31(database);
  database.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DOWN_SQL);
  const drop = (type, name) => database.exec(`DROP ${type} IF EXISTS "${name}"`);
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.triggers
    .forEach((name) => drop('TRIGGER', name));
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.views
    .forEach((name) => drop('VIEW', name));
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.indexes
    .forEach((name) => drop('INDEX', name));
  [...PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.tables]
    .reverse()
    .forEach((name) => drop('TABLE', name));
  database.prepare('DELETE FROM schema_migration_receipts WHERE version = ?')
    .run(PROJECT_DATABASE_MIGRATION_31.version);
  database.prepare('DELETE FROM schema_migrations WHERE version = ?')
    .run(PROJECT_DATABASE_MIGRATION_31.version);
}

function managementFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set(MANAGEMENT_AUTHORITY_HEADER, TEST_MANAGEMENT_AUTHORITY.token);
  return fetch(url, { ...init, headers });
}

async function createRunServer(database, gateway) {
  const restores = [
    installModuleMock('../backend/src/services/projectDatabase', { getProjectDatabase: () => database }),
    installModuleMock('../backend/src/services/assetPreviewPipeline', { getAssetPreviewPipeline: () => ({}) }),
    installModuleMock('../backend/src/services/assetIndexer', { getBackgroundAssetIndexer: () => ({
      recordRunOutputAssets: async () => ({ nodeRun: {}, assets: [] }),
    }) }),
    installModuleMock('../backend/src/collaboration/gateway', { getCollaborationGateway: () => gateway }),
    installModuleMock('../backend/src/services/runRecovery', { getRunRecoveryManager: () => ({
      status: () => ({}), recoverPendingRuns: async () => ({}),
    }) }),
  ];
  const routePath = require.resolve('../backend/src/routes/projectRuns');
  const previousRoute = require.cache[routePath];
  delete require.cache[routePath];
  const router = require(routePath);
  restores.reverse().forEach((restore) => restore());
  if (previousRoute) require.cache[routePath] = previousRoute;
  else delete require.cache[routePath];

  const app = express();
  app.use(express.json({ strict: true }));
  app.use('/api/project-runs', router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/api/project-runs` };
}

async function createCollaborationManagementServer(gateway) {
  const restore = installModuleMock('../backend/src/collaboration/gateway', { getCollaborationGateway: () => gateway });
  const routePath = require.resolve('../backend/src/routes/collaboration');
  const previousRoute = require.cache[routePath];
  delete require.cache[routePath];
  const routeModule = require(routePath);
  const router = routeModule.createCollaborationRouter(gateway, {
    managementAuthority: TEST_MANAGEMENT_AUTHORITY,
  });
  restore();
  if (previousRoute) require.cache[routePath] = previousRoute;
  else delete require.cache[routePath];

  const app = express();
  app.use(express.json({ strict: true }));
  app.use('/api/collaboration', router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/api/collaboration` };
}

function gatewayBroadcastStub(database) {
  return {
    database,
    executionPolicy: new HostExecutionPolicy(database),
    broadcastHostRunIntent() {},
    broadcastHostRunState() {},
    broadcastHostNodeRunState() {},
    broadcastHostRunOutput() {},
  };
}

async function acceptAndLeaseIntent(url, intent, workerId = 'authority-test-worker') {
  let current = intent;
  if (current.status === 'pending') {
    const acceptResponse = await managementFetch(`${url}/run-intents/${encodeURIComponent(current.id)}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: current.projectId,
        canvasId: current.canvasId,
        expectedQueueRevision: current.queueRevision,
      }),
    });
    const accepted = await acceptResponse.json();
    assert.equal(acceptResponse.status, 200, JSON.stringify(accepted));
    assert.equal(accepted.data.status, 'accepted');
    current = accepted.data;
  }

  const leaseResponse = await managementFetch(`${url}/run-intents/lease`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: current.projectId,
      canvasId: current.canvasId,
      workerId,
      expectedIntentId: current.id,
    }),
  });
  const leased = await leaseResponse.json();
  assert.equal(leaseResponse.status, 200, JSON.stringify(leased));
  assert.ok(leased.data, 'expected the exact FIFO intent to receive a dispatch lease');
  assert.equal(leased.data.intent.id, current.id);
  assert.equal(leased.data.intent.status, 'dispatching');
  assert.equal(leased.data.lease.owner, workerId);
  assert.ok(leased.data.lease.token);
  return leased.data;
}

async function postIntentRun(url, intentId, options = {}) {
  const runIntentClaim = options.claim ? {
    intentId,
    expectedQueueRevision: options.claim.intent.queueRevision,
    leaseToken: options.claim.lease.token,
    leaseOwner: options.claim.lease.owner,
  } : null;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: 'forged-project',
      canvasId: 'forged-canvas',
      canvasRevision: 999,
      initiatorId: 'forged-initiator',
      summary: {
        runIntentId: intentId,
      },
      ...(runIntentClaim ? { runIntentClaim } : {}),
    }),
  });
  return { response, payload: await response.json() };
}

function configureImagePolicy(database, allowedModels = ['zhenzhen:gpt-image-2-all']) {
  return database.setExecutionPolicy('project-local', {
    allowedModels,
    perRunCostLimit: 0,
    dailyCostLimit: 0,
    concurrencyLimit: 8,
  });
}

function createGatewayFixture(canvasData, canvasOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-run-intent-authority-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const database = new ProjectDatabase(':memory:');
  imageCanvas(database, { data: canvasData, ...canvasOptions });
  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    FRONTEND_DIST: '',
    INPUT_DIR: input,
    OUTPUT_DIR: output,
  }, database);
  return { directory, database, gateway };
}

async function redeemEditor(baseUrl, gateway, canvasId = 'canvas-a') {
  const invite = gateway.auth.createInvite({
    projectId: 'project-local',
    canvasId,
    role: 'editor',
    maxUses: 1,
  });
  const response = await fetch(`${baseUrl}/api/collab/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, displayName: '对抗测试编辑者' }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return response.headers.get('set-cookie').split(';')[0];
}

async function withRemoteGateway(canvasData, run, canvasOptions = {}) {
  const fixture = createGatewayFixture(canvasData, canvasOptions);
  try {
    const status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}`;
    const cookie = await redeemEditor(baseUrl, fixture.gateway);
    await run({ ...fixture, baseUrl, cookie });
  } finally {
    await fixture.gateway.stop();
    fixture.database.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
}

test('management API requires the explicit accept endpoint and lists actionable intents without insertion-order assumptions', async (t) => {
  const database = new ProjectDatabase(':memory:');
  t.after(() => database.close());
  imageCanvas(database);
  insertMember(database);
  configureImagePolicy(database);
  const pending = authoritativeIntent(database, 'management-pending');
  const legacyAccepted = authoritativeIntent(database, 'management-accepted', { accepted: true });
  const gateway = gatewayBroadcastStub(database);
  const { server, url } = await createCollaborationManagementServer(gateway);
  t.after(() => closeServer(server));

  const actionableResponse = await managementFetch(
    `${url}/run-intents?projectId=project-local&canvasId=canvas-a&status=actionable`,
  );
  const actionable = await actionableResponse.json();
  assert.equal(actionableResponse.status, 200);
  assert.equal(actionable.data.length, 2);
  const actionableStatuses = new Map(actionable.data.map((intent) => [intent.id, intent.status]));
  assert.equal(actionableStatuses.get(pending.id), 'pending');
  assert.equal(actionableStatuses.get(legacyAccepted.id), 'accepted');

  const response = await managementFetch(`${url}/run-intents/${pending.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      expectedQueueRevision: pending.queueRevision,
      status: 'accepted',
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'run_intent_queue_transition_invalid');
  assert.equal(database.getRunIntent(pending.id).status, 'pending');

  const acceptResponse = await managementFetch(`${url}/run-intents/${pending.id}/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      expectedQueueRevision: pending.queueRevision,
    }),
  });
  const accepted = await acceptResponse.json();
  assert.equal(acceptResponse.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.data.status, 'accepted');
  assert.equal(accepted.data.queueRevision, pending.queueRevision + 1);
});

test('schema 22 recovers authoritative legacy accepted reservations to pending and stales unverifiable ones with audit', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-run-intent-schema22-'));
  const filename = path.join(directory, 'project.sqlite');
  let database = null;
  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    imageCanvas(database);
    insertMember(database);
    const recovered = authoritativeIntent(database, 'schema22-recovered', { accepted: true });
    const unverifiable = authoritativeIntent(database, 'schema22-stale', { accepted: true });
    database.close();
    database = null;

    const raw = new BetterSqlite3(filename);
    try {
      stripSchema31ForHistoricalFixture(raw);
      raw.prepare('DELETE FROM schema_migration_receipts WHERE version = 30').run();
      raw.prepare('DELETE FROM schema_migrations WHERE version = 30').run();
      raw.exec(PROJECT_DATABASE_MIGRATION_30_DOWN_SQL);
      raw.exec(PROJECT_DATABASE_MIGRATION_29_DOWN_SQL);
      raw.prepare('DELETE FROM schema_migrations WHERE version >= 22').run();
      raw.prepare(`
        UPDATE run_intents
        SET execution_authority_json = '{}',
            estimated_cost_known = 0,
            provider = 'forged-provider',
            model = 'forged-model'
        WHERE id IN (?, ?)
      `).run(recovered.id, unverifiable.id);
      raw.prepare('UPDATE run_intents SET canvas_revision = 999 WHERE id = ?').run(unverifiable.id);
    } finally {
      raw.close();
    }

    database = new ProjectDatabase(filename, {
      autoBackup: false,
      preMigration23BackupFilename: path.join(directory, 'schema22-reopen.pre-migration23.sqlite'),
      preMigrationBackupFilename: path.join(directory, 'schema22-reopen.pre-migration29.sqlite'),
      preMigration30BackupFilename: path.join(directory, 'schema22-reopen.pre-migration30.sqlite'),
      preMigration31BackupFilename: path.join(directory, 'schema22-reopen.pre-migration31.sqlite'),
    });
    const recoveredAfter = database.getRunIntent(recovered.id);
    assert.equal(recoveredAfter.status, 'accepted');
    assert.equal(recoveredAfter.provider, 'zhenzhen');
    assert.equal(recoveredAfter.model, 'gpt-image-2-all');
    assert.equal(recoveredAfter.executionAuthority.schema, 't8-run-intent-authority-v1');
    assert.equal(recoveredAfter.estimatedCost, null);
    assert.equal(recoveredAfter.estimatedCostKnown, false);
    assert.equal(recoveredAfter.confirmationRequired, false);
    assert.equal(database.getRunIntent(unverifiable.id).status, 'stale');

    const auditRows = database.db.prepare(`
      SELECT target_id, metadata_json
      FROM audit_events
      WHERE action = 'collaboration.run-intent.schema22-recover'
      ORDER BY target_id ASC
    `).all();
    assert.equal(auditRows.length, 2);
    const auditByIntent = new Map(
      auditRows.map((row) => [row.target_id, JSON.parse(row.metadata_json)]),
    );
    assert.deepEqual(auditByIntent.get(recovered.id), {
      previousStatus: 'accepted',
      nextStatus: 'pending',
      reasonCode: 'authority_backfilled',
    });
    assert.deepEqual(auditByIntent.get(unverifiable.id), {
      previousStatus: 'accepted',
      nextStatus: 'stale',
      reasonCode: 'intent_canvas_stale',
    });
  } finally {
    database?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('leased Run claim revalidates the current requester role before inserting a Run', async (t) => {
  const database = new ProjectDatabase(':memory:');
  t.after(() => database.close());
  imageCanvas(database);
  insertMember(database);
  configureImagePolicy(database);
  const intent = authoritativeIntent(database, 'member-revoked');
  const gateway = gatewayBroadcastStub(database);
  const management = await createCollaborationManagementServer(gateway);
  t.after(() => closeServer(management.server));
  const claim = await acceptAndLeaseIntent(management.url, intent);
  database.updateMember('remote-editor', { role: 'reviewer', capabilities: [] });
  const { server, url } = await createRunServer(database, gateway);
  t.after(() => closeServer(server));

  const result = await postIntentRun(url, intent.id, { claim });
  assert.equal(result.response.status, 403);
  assert.equal(result.payload.code, 'intent_requester_not_authorized');
  assert.equal(database.listRuns({ projectId: 'project-local' }).length, 0);
  assert.equal(database.getRunIntent(intent.id).status, 'dispatching');
  assert.equal(database.getRunIntent(intent.id).runId, null);
});

test('leased Run claim revalidates persisted authority and rolls back when host policy tightened', async (t) => {
  const database = new ProjectDatabase(':memory:');
  t.after(() => database.close());
  imageCanvas(database);
  insertMember(database);
  configureImagePolicy(database);
  const intent = authoritativeIntent(database, 'policy-tightened');
  const gateway = gatewayBroadcastStub(database);
  const management = await createCollaborationManagementServer(gateway);
  t.after(() => closeServer(management.server));
  const claim = await acceptAndLeaseIntent(management.url, intent);
  configureImagePolicy(database, ['zhenzhen:nano-banana-pro']);
  const { server, url } = await createRunServer(database, gateway);
  t.after(() => closeServer(server));

  const result = await postIntentRun(url, intent.id, { claim });
  assert.equal(result.response.status, 429);
  assert.equal(result.payload.code, 'model_not_allowed');
  assert.equal(database.listRuns({ projectId: 'project-local' }).length, 0);
  assert.equal(database.getRunIntent(intent.id).status, 'dispatching');
  assert.equal(database.getRunIntent(intent.id).runId, null);
});

test('accept, lease, Run claim, and queued event use the strict top-level claim with canonical scope', async (t) => {
  const database = new ProjectDatabase(':memory:');
  t.after(() => database.close());
  const canvas = imageCanvas(database);
  insertMember(database);
  configureImagePolicy(database);
  const intent = authoritativeIntent(database, 'atomic-success');
  const gateway = gatewayBroadcastStub(database);
  const management = await createCollaborationManagementServer(gateway);
  t.after(() => closeServer(management.server));
  const claim = await acceptAndLeaseIntent(management.url, intent);
  const { server, url } = await createRunServer(database, gateway);
  t.after(() => closeServer(server));

  const result = await postIntentRun(url, intent.id, { claim });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  assert.equal(result.payload.data.projectId, 'project-local');
  assert.equal(result.payload.data.canvasId, canvas.canvasId);
  assert.equal(result.payload.data.canvasRevision, canvas.revision);
  assert.equal(result.payload.data.initiatorId, 'remote-editor');
  assert.deepEqual(result.payload.data.summary, { runIntentId: intent.id });
  const claimed = database.getRunIntent(intent.id);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.runId, result.payload.data.id);
  assert.deepEqual(
    database.getRunEvents(result.payload.data.id).map((event) => event.type),
    ['run.queued'],
  );
});

test('confirmed rN intent reads its host-only pinned snapshot and still claims and executes after rN+1 is persisted', async (t) => {
  const database = new ProjectDatabase(':memory:');
  t.after(() => database.close());
  const revisionN = imageCanvas(database, {
    data: {
      model: 'gpt-image-2',
      apiModel: 'gpt-image-2-all',
      prompt: 'provider-input-from-rN',
    },
  });
  insertMember(database);
  configureImagePolicy(database);
  const intent = authoritativeIntent(database, 'pinned-rn-execution', { canvas: revisionN });

  const gateway = gatewayBroadcastStub(database);
  const management = await createCollaborationManagementServer(gateway);
  t.after(() => closeServer(management.server));
  const acceptResponse = await managementFetch(
    `${management.url}/run-intents/${encodeURIComponent(intent.id)}/accept`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: intent.projectId,
        canvasId: intent.canvasId,
        expectedQueueRevision: intent.queueRevision,
      }),
    },
  );
  const accepted = await acceptResponse.json();
  assert.equal(acceptResponse.status, 200, JSON.stringify(accepted));

  const revisionN1 = database.saveCanvasSnapshot(revisionN.canvasId, {
    ...revisionN,
    nodes: revisionN.nodes.map((entry) => entry.id === 'image-node'
      ? { ...entry, data: { ...entry.data, prompt: 'visible-input-from-rN+1' } }
      : entry),
  }, {
    expectedRevision: revisionN.revision,
    projectId: revisionN.projectId,
  });
  assert.equal(revisionN1.revision, revisionN.revision + 1);

  const snapshotQuery = new URLSearchParams({
    projectId: intent.projectId,
    canvasId: intent.canvasId,
    canvasRevision: String(intent.canvasRevision),
  });
  const snapshotUrl = `${management.url}/run-intents/${encodeURIComponent(intent.id)}/snapshot?${snapshotQuery}`;
  const unauthorized = await fetch(snapshotUrl);
  assert.equal(unauthorized.status, 401, 'historical execution input must remain host-only');
  assert.equal(unauthorized.headers.get('cache-control'), 'no-store');
  const snapshotResponse = await managementFetch(snapshotUrl);
  const snapshotPayload = await snapshotResponse.json();
  assert.equal(snapshotResponse.status, 200, JSON.stringify(snapshotPayload));
  assert.equal(snapshotResponse.headers.get('cache-control'), 'no-store');
  assert.equal(snapshotPayload.data.revision, revisionN.revision);
  assert.equal(snapshotPayload.data.nodes[0].data.prompt, 'provider-input-from-rN');
  assert.equal(database.getCanvas(intent.canvasId).nodes[0].data.prompt, 'visible-input-from-rN+1');

  const claim = await acceptAndLeaseIntent(management.url, accepted.data, 'pinned-rn-worker');
  const runServer = await createRunServer(database, gateway);
  t.after(() => closeServer(runServer.server));
  const claimed = await postIntentRun(runServer.url, intent.id, { claim });
  assert.equal(claimed.response.status, 201, JSON.stringify(claimed.payload));
  assert.equal(claimed.payload.data.canvasRevision, revisionN.revision);

  // This is the exact post-claim value the Canvas worker feeds into its frozen
  // runtime before issuing a Provider token; the current rN+1 value is never
  // consulted or substituted.
  const providerFacingInput = snapshotPayload.data.nodes
    .find((entry) => entry.id === 'image-node')?.data?.prompt;
  assert.equal(providerFacingInput, 'provider-input-from-rN');
});

test('host snapshot read fails closed without fallback for missing rows and safely retries transient read errors', async (t) => {
  const database = new ProjectDatabase(':memory:');
  t.after(() => database.close());
  const canvas = imageCanvas(database);
  insertMember(database);
  configureImagePolicy(database);
  const intent = authoritativeIntent(database, 'missing-pinned-snapshot', { canvas });
  const gateway = gatewayBroadcastStub(database);
  const management = await createCollaborationManagementServer(gateway);
  t.after(() => closeServer(management.server));

  const originalSnapshotReader = database.getCanvasSnapshotDocument.bind(database);
  database.getCanvasSnapshotDocument = (canvasId, revision) => (
    String(canvasId) === intent.canvasId && Number(revision) === intent.canvasRevision
      ? null
      : originalSnapshotReader(canvasId, revision)
  );
  const snapshotQuery = new URLSearchParams({
    projectId: intent.projectId,
    canvasId: intent.canvasId,
    canvasRevision: String(intent.canvasRevision),
  });
  const response = await managementFetch(
    `${management.url}/run-intents/${encodeURIComponent(intent.id)}/snapshot?${snapshotQuery}`,
  );
  const payload = await response.json();
  assert.equal(response.status, 409, JSON.stringify(payload));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(payload.code, 'intent_canvas_snapshot_unavailable');
  assert.throws(
    () => gateway.executionPolicy.authorizeRunIntent(intent.id, {
      allowedStatuses: ['pending'],
      reservationAlreadyCounted: true,
    }),
    (error) => error.code === 'intent_canvas_snapshot_unavailable',
  );

  database.getCanvasSnapshotDocument = () => {
    const error = new Error('sensitive sqlite read detail');
    error.code = 'SQLITE_BUSY';
    throw error;
  };
  const transientResponse = await managementFetch(
    `${management.url}/run-intents/${encodeURIComponent(intent.id)}/snapshot?${snapshotQuery}`,
  );
  const transientPayload = await transientResponse.json();
  assert.equal(transientResponse.status, 503, JSON.stringify(transientPayload));
  assert.equal(transientResponse.headers.get('cache-control'), 'no-store');
  assert.equal(transientPayload.code, 'intent_canvas_snapshot_read_unavailable');
  assert.doesNotMatch(transientPayload.error, /sensitive|sqlite/i);
  assert.throws(
    () => gateway.executionPolicy.authorizeRunIntent(intent.id, {
      allowedStatuses: ['pending'],
      reservationAlreadyCounted: true,
    }),
    (error) => error.code === 'intent_canvas_snapshot_read_unavailable'
      && error.httpStatus === 503
      && !/sensitive|sqlite/i.test(error.message),
  );
  assert.equal(database.getRunIntent(intent.id).status, 'pending');
  database.getCanvasSnapshotDocument = originalSnapshotReader;
});

test('legacy accepted intent without a dispatch lease is rejected by the atomic Run endpoint', async (t) => {
  const database = new ProjectDatabase(':memory:');
  t.after(() => database.close());
  imageCanvas(database);
  insertMember(database);
  configureImagePolicy(database);
  const intent = authoritativeIntent(database, 'legacy-recovery', { accepted: true });
  const { server, url } = await createRunServer(database, gatewayBroadcastStub(database));
  t.after(() => closeServer(server));

  const unmarked = await postIntentRun(url, intent.id);
  assert.equal(unmarked.response.status, 409);
  assert.equal(unmarked.payload.code, 'run_intent_lease_required');
  assert.equal(database.getRunIntent(intent.id).status, 'accepted');
  assert.equal(database.listRuns({ projectId: 'project-local' }).length, 0);
});

test('forced claim or queued-event failure rolls back the new Run while preserving the valid dispatch lease', async (t) => {
  for (const failure of ['claim', 'event']) {
    const database = new ProjectDatabase(':memory:');
    t.after(() => database.close());
    imageCanvas(database);
    insertMember(database);
    configureImagePolicy(database);
    const intent = authoritativeIntent(database, `rollback-${failure}`);
    const gateway = gatewayBroadcastStub(database);
    const management = await createCollaborationManagementServer(gateway);
    t.after(() => closeServer(management.server));
    const claim = await acceptAndLeaseIntent(management.url, intent, `rollback-${failure}-worker`);
    if (failure === 'claim') {
      database.claimRunIntent = () => { throw new Error('forced claim failure'); };
    } else {
      database.appendRunEvent = () => { throw new Error('forced queued event failure'); };
    }
    const { server, url } = await createRunServer(database, gateway);
    t.after(() => closeServer(server));

    const result = await postIntentRun(url, intent.id, { claim });
    assert.equal(result.response.status, 400);
    assert.match(result.payload.error, new RegExp(`forced ${failure === 'claim' ? 'claim' : 'queued event'} failure`));
    assert.equal(database.listRuns({ projectId: 'project-local' }).length, 0);
    assert.equal(database.getRunIntent(intent.id).status, 'dispatching');
    assert.equal(database.getRunIntent(intent.id).runId, null);
  }
});

test('remote gateway derives model and unknown cost from the current canvas, ignoring forged safe fields and zero cost', async () => {
  await withRemoteGateway(
    { model: 'nano-banana-pro', apiModel: 'gpt-image-2-all' },
    async ({ baseUrl, cookie, database }) => {
      const canvas = database.getCanvas('canvas-a');
      const submit = async (idempotencyKey) => {
        const response = await fetch(`${baseUrl}/api/collab/run-intents`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            canvasId: canvas.canvasId,
            canvasRevision: canvas.revision,
            nodeIds: ['image-node'],
            idempotencyKey,
            provider: 'image',
            model: 'gpt-image-2-all',
            estimatedCost: 0,
          }),
        });
        return { response, payload: await response.json() };
      };

      configureImagePolicy(database, ['zhenzhen:gpt-image-2-all']);
      const forgedSafe = await submit('forged-safe-model-0001');
      assert.equal(forgedSafe.response.status, 429);
      assert.equal(forgedSafe.payload.code, 'model_not_allowed');
      assert.equal(database.listRunIntents({ projectId: 'project-local' }).length, 0);

      configureImagePolicy(database, ['zhenzhen:nano-banana-pro']);
      const authoritative = await submit('authoritative-model-0001');
      assert.equal(authoritative.response.status, 202, JSON.stringify(authoritative.payload));
      assert.equal(authoritative.payload.data.provider, 'zhenzhen');
      assert.equal(authoritative.payload.data.model, 'nano-banana-pro');
      assert.equal(authoritative.payload.data.estimatedCost, null);
      assert.equal(authoritative.payload.data.estimatedCostKnown, false);
      assert.deepEqual(authoritative.payload.data.executionAuthority.declarations, [{
        provider: 'zhenzhen',
        model: 'nano-banana-pro',
        nodeIds: ['image-node'],
      }]);

      database.setExecutionPolicy('project-local', {
        allowedModels: ['zhenzhen:nano-banana-pro'],
        perRunCostLimit: 1,
        dailyCostLimit: 0,
        concurrencyLimit: 8,
      });
      const forgedZero = await submit('forged-zero-cost-0001');
      assert.equal(forgedZero.response.status, 409);
      assert.equal(forgedZero.payload.code, 'cost_estimate_unavailable');
      assert.equal(database.listRunIntents({ projectId: 'project-local' }).length, 1);
    },
  );
});

test('remote run intent idempotency only replays the same server-normalized request', async () => {
  await withRemoteGateway(
    { model: 'gpt-image-2', apiModel: 'gpt-image-2-all' },
    async ({ baseUrl, cookie, database, gateway }) => {
      configureImagePolicy(database, ['zhenzhen:gpt-image-2-all']);
      imageCanvas(database, { canvasId: 'canvas-b' });
      const canvasA = database.getCanvas('canvas-a');
      const canvasB = database.getCanvas('canvas-b');
      const key = 'normalized-replay-0001';
      const submit = async (sessionCookie, overrides = {}) => {
        const response = await fetch(`${baseUrl}/api/collab/run-intents`, {
          method: 'POST',
          headers: { cookie: sessionCookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            canvasId: canvasA.canvasId,
            canvasRevision: canvasA.revision,
            nodeIds: ['image-node'],
            idempotencyKey: key,
            ...overrides,
          }),
        });
        return { response, payload: await response.json() };
      };

      const first = await submit(cookie);
      assert.equal(first.response.status, 202, JSON.stringify(first.payload));

      const exactReplay = await submit(cookie, {
        nodeIds: ['image-node', 'image-node'],
        provider: 'forged-provider-is-ignored',
        model: 'forged-model-is-ignored',
        estimatedCost: 999,
      });
      assert.equal(exactReplay.response.status, 202, JSON.stringify(exactReplay.payload));
      assert.equal(exactReplay.payload.data.id, first.payload.data.id);

      const nodeCollision = await submit(cookie, { nodeIds: [] });
      assert.equal(nodeCollision.response.status, 409);
      assert.equal(nodeCollision.payload.code, 'intent_idempotency_conflict');
      assert.ok(nodeCollision.payload.data.conflictingFields.includes('nodeIds'));

      const missingNodeCollision = await submit(cookie, { nodeIds: ['missing-node'] });
      assert.equal(missingNodeCollision.response.status, 409);
      assert.equal(missingNodeCollision.payload.code, 'intent_idempotency_conflict');
      assert.ok(missingNodeCollision.payload.data.conflictingFields.includes('nodeIds'));

      const secondCookie = await redeemEditor(baseUrl, gateway);
      const requesterCollision = await submit(secondCookie);
      assert.equal(requesterCollision.response.status, 409);
      assert.equal(requesterCollision.payload.code, 'intent_idempotency_conflict');
      assert.ok(requesterCollision.payload.data.conflictingFields.includes('requestedBy'));

      const canvasBCookie = await redeemEditor(baseUrl, gateway, canvasB.canvasId);
      const canvasCollision = await submit(canvasBCookie, {
        canvasId: canvasB.canvasId,
        canvasRevision: canvasB.revision,
      });
      assert.equal(canvasCollision.response.status, 409);
      assert.equal(canvasCollision.payload.code, 'intent_idempotency_conflict');
      assert.ok(canvasCollision.payload.data.conflictingFields.includes('canvasId'));

      const revisedCanvas = database.saveCanvasSnapshot('canvas-a', canvasA, {
        expectedRevision: canvasA.revision,
      });
      const revisionCollision = await submit(cookie, { canvasRevision: revisedCanvas.revision });
      assert.equal(revisionCollision.response.status, 409);
      assert.equal(revisionCollision.payload.code, 'intent_idempotency_conflict');
      assert.ok(revisionCollision.payload.data.conflictingFields.includes('canvasRevision'));
      assert.equal(database.listRunIntents({ projectId: 'project-local' }).length, 1);
    },
  );
});

test('runtime authority normalizes stale raw model fields instead of trusting apiModel', () => {
  const imageAuthority = deriveRunIntentAuthority({
    nodes: [node('image-node', 'image', {
      model: 'nano-banana-pro',
      apiModel: 'gpt-image-2-all',
    })],
    edges: [],
  }, ['image-node']);
  assert.deepEqual(imageAuthority.declarations, [{
    provider: 'zhenzhen',
    model: 'nano-banana-pro',
    nodeIds: ['image-node'],
  }]);

  const videoAuthority = deriveRunIntentAuthority({
    nodes: [node('video-node', 'video', {
      mainId: 'wan-2.7-spicy',
      model: 'grok-video-3',
      apiModel: 'grok-video-3',
    })],
    edges: [],
  }, ['video-node']);
  assert.deepEqual(videoAuthority.declarations, [{
    provider: 'seedance-nz',
    model: 'wan-2.7-spicy-i2v',
    nodeIds: ['video-node'],
  }]);

  const seedanceAuthority = deriveRunIntentAuthority({
    nodes: [
      node('seedance-node', 'seedance', {
        seedanceApiSource: 'seedance-nz',
        seedanceNzModel: 'global-fast',
        model: 'doubao-seedance-2-0-fast-260128',
        apiModel: 'forged-safe-model',
      }),
      node('director-node', 'director-storyboard', {
        seedanceApiSource: 'zhenzhen-legacy',
        model: 'doubao-seedance-2.0-mini',
        apiModel: 'forged-safe-model',
        shots: [{ id: 'shot-1', modelOverride: 'custom-shot-model' }],
      }),
    ],
    edges: [],
  }, ['seedance-node', 'director-node']);
  assert.deepEqual(seedanceAuthority.declarations, [
    {
      provider: 'seedance-nz',
      model: 'global-fast',
      nodeIds: ['seedance-node'],
    },
    {
      provider: 'zhenzhen-legacy',
      model: 'custom-shot-model',
      nodeIds: ['director-node'],
    },
    {
      provider: 'zhenzhen-legacy',
      model: 'doubao-seedance-2.0-mini',
      nodeIds: ['director-node'],
    },
  ]);
});

test('remote RunIntent rejects host-only media tools before local paths, private URLs, or executable paths persist', async () => {
  const hostileNodes = [
    node('watermark-file-url', 'remove-ai-watermark', {
      items: [{ url: 'file:///C:/Users/host/private/source.png' }],
    }),
    node('watermark-absolute-path', 'remove-ai-watermark', {
      items: [{ url: 'C:\\Users\\host\\private\\source.png' }],
    }),
    node('watermark-private-url', 'remove-ai-watermark', {
      items: [{ url: 'http://127.0.0.1:18765/api/settings' }],
    }),
    node('topaz-image-host-path', 'topaz-image-upscale', {
      imageUrl: 'http://169.254.169.254/latest/meta-data',
      executablePath: 'C:\\Windows\\System32\\cmd.exe',
      topazGigapixelPath: 'C:\\Windows\\System32\\cmd.exe',
    }),
    node('topaz-video-host-path', 'topaz-video-upscale', {
      videoUrl: 'http://10.0.0.1/private/video.mp4',
      executablePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      topazVideoPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    }),
  ];

  await withRemoteGateway(
    {},
    async ({ baseUrl, cookie, database }) => {
      const canvas = database.getCanvas('canvas-a');
      for (const hostileNode of hostileNodes) {
        const response = await fetch(`${baseUrl}/api/collab/run-intents`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            canvasId: canvas.canvasId,
            canvasRevision: canvas.revision,
            nodeIds: [hostileNode.id],
            idempotencyKey: `host-only-${hostileNode.id}`,
          }),
        });
        const payload = await response.json();
        assert.equal(response.status, 403, JSON.stringify(payload));
        assert.equal(payload.code, 'intent_host_only_remote_unsupported');
        assert.match(payload.error, /host-only/i);
        assert.match(payload.error, /remote unsupported/i);
        assert.deepEqual(payload.data.nodeIds, [hostileNode.id]);
      }
      assert.equal(database.listRunIntents({ projectId: 'project-local' }).length, 0);
    },
    { nodes: hostileNodes },
  );
});

test('authority provider names and specialized model fields match runtime tracing exactly', () => {
  const authority = deriveRunIntentAuthority({
    nodes: [
      node('fal-image', 'image', {
        model: 'gpt-image-2',
        apiModel: 'gpt-image-2-fal',
      }),
      node('midjourney-image', 'image', {
        model: 'midjourney',
        apiModel: 'forged-safe-model',
        mjVersion: 'niji 7',
      }),
      node('fal-video', 'video', {
        mainId: 'grok-video-3',
        model: 'grok-video-fal',
        apiModel: 'forged-safe-model',
      }),
      node('suno-audio', 'audio', {
        audioProviderMode: 'suno',
        version: 'v5.5',
        apiModel: 'forged-safe-model',
      }),
      node('builtin-llm', 'llm', {
        model: 'gemini-3.1-pro-preview',
        apiModel: 'forged-safe-model',
      }),
      node('runninghub-intl', 'runninghub', {
        rhSite: 'intl',
        webappId: '1977570194900316162',
      }),
    ],
    edges: [],
  }, ['fal-image', 'midjourney-image', 'fal-video', 'suno-audio', 'builtin-llm', 'runninghub-intl']);
  assert.deepEqual(authority.declarations, [
    { provider: 'fal', model: 'gpt-image-2-fal', nodeIds: ['fal-image'] },
    { provider: 'fal', model: 'grok-video-fal', nodeIds: ['fal-video'] },
    { provider: 'runninghub', model: '1977570194900316162', nodeIds: ['runninghub-intl'] },
    { provider: 'suno', model: 'v5.5', nodeIds: ['suno-audio'] },
    { provider: 'zhenzhen', model: 'gemini-3.1-pro-preview', nodeIds: ['builtin-llm'] },
    { provider: 'zhenzhen-mj', model: 'niji 7', nodeIds: ['midjourney-image'] },
  ]);
});

test('Dola Seedream authority includes persisted upstream images and fails closed when this run may change them', () => {
  const document = {
    nodes: [
      node('source-image', 'upload', { imageUrl: 'https://assets.example/reference.png' }),
      node('seedream-image', 'image', {
        model: 'seedream-v5-pro',
        apiModel: 'seedream-v5-pro',
        seedreamApiSource: 'seedance-nz',
        seedreamNzModelFamily: 'overseas',
        referenceImages: [],
      }),
    ],
    edges: [{ id: 'edge-image', source: 'source-image', target: 'seedream-image' }],
  };
  const authority = deriveRunIntentAuthority(document, ['seedream-image']);
  assert.deepEqual(authority.declarations, [{
    provider: 'seedance-nz',
    model: 'dola-seedream-5.0-pro-i2i',
    nodeIds: ['seedream-image'],
  }]);

  const database = new ProjectDatabase(':memory:');
  try {
    database.setExecutionPolicy('project-local', {
      allowedModels: ['seedance-nz:dola-seedream-5.0-pro-t2i'],
      perRunCostLimit: 0,
      dailyCostLimit: 0,
      concurrencyLimit: 2,
    });
    assert.throws(() => new HostExecutionPolicy(database).authorize({
      projectId: 'project-local',
      declarations: authority.declarations,
      estimatedCostKnown: false,
    }), (error) => error.code === 'model_not_allowed');
  } finally {
    database.close();
  }

  assert.throws(
    () => deriveRunIntentAuthority(document, ['source-image', 'seedream-image']),
    (error) => error.code === 'intent_execution_model_unresolved',
  );
});

test('scheduler scope expands every downstream executable branch while subflows and unmapped provider nodes fail closed', () => {
  const authority = deriveRunIntentAuthority({
    nodes: [
      node('loop-node', 'loop'),
      node('random-node', 'random-route'),
      node('image-node', 'image', { model: 'gpt-image-2', apiModel: 'gpt-image-2-all' }),
      node('video-node', 'video', { mainId: 'wan-2.7-spicy', model: 'wan-2.7-spicy-i2v' }),
    ],
    edges: [
      { id: 'edge-loop-random', source: 'loop-node', target: 'random-node' },
      { id: 'edge-random-image', source: 'random-node', target: 'image-node' },
      { id: 'edge-random-video', source: 'random-node', target: 'video-node' },
    ],
  }, ['loop-node']);
  assert.deepEqual(authority.authorizedNodeIds, ['image-node', 'loop-node', 'random-node', 'video-node']);
  assert.deepEqual(authority.declarations, [
    { provider: 'seedance-nz', model: 'wan-2.7-spicy-i2v', nodeIds: ['video-node'] },
    { provider: 'zhenzhen', model: 'gpt-image-2-all', nodeIds: ['image-node'] },
  ]);

  assert.throws(
    () => deriveRunIntentAuthority({
      nodes: [node('subflow-node', 'subflow', { definitionId: 'nested', definitionVersion: 1 })],
      edges: [],
    }, ['subflow-node']),
    (error) => error.code === 'intent_subflow_authority_unavailable',
  );
  assert.throws(
    () => deriveRunIntentAuthority({
      nodes: [node('panorama-node', 'panorama-3d', { model: 'forged-safe-model', apiModel: 'forged-safe-model' })],
      edges: [],
    }, ['panorama-node']),
    (error) => error.code === 'intent_execution_authority_unresolved',
  );
});

test('execution-usage API excludes one validated active same-project reservation and rejects invalid exclusions', async (t) => {
  const database = new ProjectDatabase(':memory:');
  t.after(() => database.close());
  imageCanvas(database);
  insertMember(database);
  const intent = authoritativeIntent(database, 'usage-exclusion');
  const gateway = gatewayBroadcastStub(database);
  const { server, url } = await createCollaborationManagementServer(gateway);
  t.after(() => closeServer(server));

  const validResponse = await managementFetch(
    `${url}/execution-policy?projectId=project-local&excludeIntentId=${encodeURIComponent(intent.id)}`,
  );
  const valid = await validResponse.json();
  assert.equal(validResponse.status, 200);
  assert.equal(valid.data.usage.activeCount, 0);
  assert.equal(valid.data.usage.dailyCost, 0);
  assert.equal(valid.data.usage.unknownCostCount, 0);

  const otherCanvas = imageCanvas(database, {
    projectId: 'project-other',
    canvasId: 'canvas-other',
  });
  const otherProject = database.createRunIntent({
    projectId: 'project-other',
    canvasId: 'canvas-other',
    canvasRevision: otherCanvas.revision,
    idempotencyKey: 'other-project-reservation',
    requestedBy: 'other-member',
    provider: 'image',
    model: 'gpt-image-2-all',
    estimatedCost: 1,
  });
  const crossResponse = await managementFetch(
    `${url}/execution-policy?projectId=project-local&excludeIntentId=${encodeURIComponent(otherProject.id)}`,
  );
  const cross = await crossResponse.json();
  assert.equal(crossResponse.status, 409);
  assert.equal(cross.code, 'intent_reservation_invalid');

  database.updateRunIntent(intent.id, { status: 'completed' });
  const inactiveResponse = await managementFetch(
    `${url}/execution-policy?projectId=project-local&excludeIntentId=${encodeURIComponent(intent.id)}`,
  );
  const inactive = await inactiveResponse.json();
  assert.equal(inactiveResponse.status, 409);
  assert.equal(inactive.code, 'intent_reservation_invalid');
});
