const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');
const { WebSocket } = require('ws');

const { CollaborationAuth } = require('../backend/src/collaboration/auth');
const { CollaborationGateway, SESSION_COOKIE } = require('../backend/src/collaboration/gateway');
const {
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');
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
const {
  stripSchema32ForSyntheticSchema31,
} = require('./helpers/projectDatabaseVersion.cjs');

const PROJECT_ID = 'project-legacy-session-embedded-f1';
const CANVAS_ID = 'canvas-legacy-session-embedded-f1';
const AUTHORIZED_SUBFLOW_ID = 'authorized-embedded-a';
const UNAUTHORIZED_SUBFLOW_ID = 'unauthorized-embedded-b';
const UNAUTHORIZED_ASSET_ID = 'unauthorized-embedded-asset';
const PRIVATE_MARKER = 'B_MARKER_7391_ZEBRA';
const DENIED_RESOURCE_STATUSES = new Set([403, 409, 422]);

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function textNode(id, text, data = {}) {
  return {
    id,
    type: 'text',
    position: { x: 0, y: 0 },
    data: { text, ...data },
  };
}

function subflowNode(id, definitionId, definitionVersion = 1, data = {}) {
  return {
    id,
    type: 'subflow',
    position: { x: 160, y: 0 },
    data: {
      definitionId,
      definitionVersion,
      ...data,
    },
  };
}

function subflowDefinition(id, name, nodes = [textNode(`${id}-text`, name)], assetRefs = []) {
  return {
    id,
    version: 1,
    projectId: PROJECT_ID,
    name,
    description: `${name} definition`,
    tags: [],
    nodes,
    edges: [],
    inputs: [],
    outputs: [],
    exposedParameters: [],
    requiredCapabilities: [],
    assetRefs,
  };
}

function saveSubflow(database, definition) {
  return database.saveSubflowDefinition(definition, {
    expectedRevision: 0,
    actorId: 'local-owner',
    sessionId: 'legacy-session-embedded-f1',
    changeSummary: `save ${definition.name}`,
  });
}

function addAsset(database, id, filename) {
  return database.upsertAsset({
    id,
    projectId: PROJECT_ID,
    kind: 'image',
    mimeType: 'image/png',
    filename,
    createdBy: 'local-owner',
  });
}

function ensureCanvas(database, nodes) {
  return database.ensureCanvas(CANVAS_ID, {
    name: 'Legacy session and embedded definition F1',
    nodes,
    edges: [],
  }, PROJECT_ID);
}

function normalizeGrants(database) {
  const grants = database.listCanvasResourceGrants(PROJECT_ID, CANVAS_ID);
  const subflows = [];
  for (const [id, versions] of grants.subflowReferences) {
    for (const version of versions) subflows.push(`${id}@${version}`);
  }
  return {
    assets: [...grants.assetIds].sort(),
    subflows: subflows.sort(),
  };
}

function createGateway(database, directory) {
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  return new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    FRONTEND_DIST: '',
    INPUT_DIR: input,
    OUTPUT_DIR: output,
  }, database);
}

function createSession(gateway, role = 'editor', displayName = 'Embedded F1 editor') {
  const invite = gateway.auth.createInvite({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    role,
    maxUses: 1,
  });
  const redeemed = gateway.auth.redeemInvite(invite.code, displayName);
  assert.ok(redeemed, 'fixture invite must redeem');
  return {
    token: redeemed.token,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(redeemed.token)}`,
    session: redeemed,
  };
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_) {
      payload = text;
    }
  }
  return { status: response.status, payload };
}

function postOperation(baseUrl, database, cookie, operation) {
  return request(baseUrl, `/api/collab/canvases/${encodeURIComponent(CANVAS_ID)}/operations`, {
    method: 'POST',
    cookie,
    body: {
      baseRevision: database.getCanvas(CANVAS_ID).revision,
      operations: [operation],
    },
  });
}

function probeLegacyWebSocket(baseUrl, cookie, canvasId) {
  return new Promise((resolve) => {
    const result = {
      opened: false,
      statusCode: null,
      joined: false,
      messages: [],
      closeCode: null,
      error: null,
    };
    let settled = false;
    const socket = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/ws/collab', {
      origin: baseUrl,
      headers: { cookie },
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN) socket.terminate();
      resolve(result);
    };
    const timer = setTimeout(finish, 2500);

    socket.on('unexpected-response', (_request, response) => {
      result.statusCode = response.statusCode;
      response.resume();
      finish();
    });
    socket.on('open', () => {
      result.opened = true;
    });
    socket.on('message', (raw) => {
      let message = null;
      try {
        message = JSON.parse(String(raw));
      } catch (_) {
        return;
      }
      result.messages.push(message.type);
      if (message.type === 'session.ready') {
        socket.send(JSON.stringify({ type: 'canvas.join', canvasId }));
      }
      if (message.type === 'canvas.joined') {
        result.joined = true;
        finish();
      }
      if (message.type === 'error') finish();
    });
    socket.on('close', (code) => {
      result.closeCode = code;
      finish();
    });
    socket.on('error', (error) => {
      result.error = String(error?.code || error?.message || error);
    });
  });
}

test('schema 22 upgrade revokes legacy invites/sessions and old cookies fail closed for HTTP and WebSocket', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-schema22-session-f1-'));
  const filename = path.join(directory, 'projects.sqlite3');
  let upgraded = null;
  let gateway = null;
  try {
    const latest = new ProjectDatabase(filename, { autoBackup: false });
    let sessionInvite = null;
    let pendingInvite = null;
    let legacySession = null;
    try {
      ensureCanvas(latest, [textNode('legacy-node', 'legacy canvas')]);
      const auth = new CollaborationAuth(latest);
      sessionInvite = auth.createInvite({
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        role: 'viewer',
        maxUses: 1,
      });
      legacySession = auth.redeemInvite(sessionInvite.code, 'Legacy cookie holder');
      assert.ok(legacySession);
      pendingInvite = auth.createInvite({
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        role: 'viewer',
        maxUses: 1,
      });
    } finally {
      latest.close();
    }

    const legacy = new BetterSqlite3(filename);
    try {
      stripSchema31ForHistoricalFixture(legacy);
      legacy.prepare('DELETE FROM schema_migration_receipts WHERE version = 30').run();
      legacy.prepare('DELETE FROM schema_migrations WHERE version = 30').run();
      legacy.exec(PROJECT_DATABASE_MIGRATION_30_DOWN_SQL);
      legacy.exec(PROJECT_DATABASE_MIGRATION_29_DOWN_SQL);
      legacy.exec(`
        DELETE FROM schema_migrations WHERE version > 22;
        DROP TABLE canvas_resource_grants;
        DROP TABLE canvas_resource_grant_state;
        UPDATE collaboration_invites SET canvas_id = NULL, revoked_at = NULL;
        UPDATE collaboration_members SET canvas_id = NULL;
        UPDATE collaboration_sessions SET canvas_id = NULL, revoked_at = NULL;
      `);
      assert.equal(
        legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
        22,
      );
    } finally {
      legacy.close();
    }

    upgraded = new ProjectDatabase(filename, {
      autoBackup: false,
      preMigration23BackupFilename: path.join(directory, 'schema22-reopen.pre-migration23.sqlite3'),
      preMigrationBackupFilename: path.join(directory, 'schema22-reopen.pre-migration29.sqlite3'),
      preMigration30BackupFilename: path.join(directory, 'schema22-reopen.pre-migration30.sqlite3'),
      preMigration31BackupFilename: path.join(directory, 'schema22-reopen.pre-migration31.sqlite3'),
    });
    const migratedState = upgraded.getCanvasResourceGrantState(PROJECT_ID, CANVAS_ID);
    assert.ok(migratedState, 'schema 23 upgrade must create the fail-closed state row');
    assert.equal(migratedState.initializedAt, 0);
    const inviteRows = upgraded.db.prepare(`
      SELECT id, revoked_at AS revokedAt
      FROM collaboration_invites
      WHERE id IN (?, ?)
      ORDER BY id ASC
    `).all(sessionInvite.id, pendingInvite.id);
    const sessionRow = upgraded.db.prepare(`
      SELECT id, revoked_at AS revokedAt
      FROM collaboration_sessions
      WHERE id = ?
    `).get(legacySession.sessionId);
    const oldTokenAuthenticates = Boolean(new CollaborationAuth(upgraded).authenticate(legacySession.token));

    gateway = createGateway(upgraded, directory);
    const status = await gateway.start({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}`;
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(legacySession.token)}`;
    const canvasRead = await request(
      baseUrl,
      `/api/collab/canvases/${encodeURIComponent(CANVAS_ID)}`,
      { cookie },
    );
    const syncRead = await request(
      baseUrl,
      `/api/collab/canvases/${encodeURIComponent(CANVAS_ID)}/sync`,
      { cookie },
    );
    const socket = await probeLegacyWebSocket(baseUrl, cookie, CANVAS_ID);
    const pendingInviteRedeems = Boolean(
      gateway.auth.redeemInvite(pendingInvite.code, 'Must remain revoked'),
    );

    const observed = {
      schemaVersion: upgraded.db
        .prepare('SELECT MAX(version) AS version FROM schema_migrations')
        .get().version,
      invitesRevoked: inviteRows.length === 2 && inviteRows.every((row) => Number(row.revokedAt) > 0),
      sessionRevoked: Number(sessionRow?.revokedAt) > 0,
      oldTokenAuthenticates,
      pendingInviteRedeems,
      canvasStatus: canvasRead.status,
      syncStatus: syncRead.status,
      socketOpened: socket.opened,
      socketStatus: socket.statusCode,
      socketJoined: socket.joined,
    };
    assert.deepEqual(observed, {
      schemaVersion: PROJECT_DATABASE_SCHEMA_VERSION,
      invitesRevoked: true,
      sessionRevoked: true,
      oldTokenAuthenticates: false,
      pendingInviteRedeems: false,
      canvasStatus: 401,
      syncStatus: 401,
      socketOpened: false,
      socketStatus: 401,
      socketJoined: false,
    }, JSON.stringify({ observed, socket }));
  } finally {
    await gateway?.stop();
    upgraded?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('embedded authorized A cannot smuggle unauthorized B or an asset across write/read boundaries', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-embedded-boundary-f1-'));
  const database = new ProjectDatabase(':memory:');
  const gateway = createGateway(database, directory);
  try {
    saveSubflow(
      database,
      subflowDefinition(AUTHORIZED_SUBFLOW_ID, 'Authorized A'),
    );
    saveSubflow(
      database,
      subflowDefinition(
        UNAUTHORIZED_SUBFLOW_ID,
        'Unauthorized B',
        [textNode('b-private-node', PRIVATE_MARKER)],
      ),
    );
    addAsset(database, UNAUTHORIZED_ASSET_ID, 'unauthorized-embedded.png');
    ensureCanvas(database, [
      subflowNode('authorized-a-instance', AUTHORIZED_SUBFLOW_ID, 1),
    ]);
    assert.deepEqual(normalizeGrants(database), {
      assets: [],
      subflows: [`${AUTHORIZED_SUBFLOW_ID}@1`],
    });

    const status = await gateway.start({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}`;
    const editor = createSession(gateway);

    const embeddedBReference = subflowDefinition(
      AUTHORIZED_SUBFLOW_ID,
      'Authorized A with unauthorized B',
      [
        subflowNode('a-to-unauthorized-b', UNAUTHORIZED_SUBFLOW_ID, 1, {
          text: PRIVATE_MARKER,
        }),
      ],
    );
    const bOnlyBefore = database.getCanvas(CANVAS_ID);
    const bOnlyWrite = await postOperation(baseUrl, database, editor.cookie, {
      opId: 'embedded-b-only-write',
      type: 'node.patch',
      payload: {
        nodeId: 'authorized-a-instance',
        dataPatch: { definition: embeddedBReference },
      },
    });
    const bOnlyAfter = database.getCanvas(CANVAS_ID);

    const embeddedAssetReference = subflowDefinition(
      AUTHORIZED_SUBFLOW_ID,
      'Authorized A with unauthorized asset',
      [textNode('a-asset-node', 'unauthorized asset', { assetId: UNAUTHORIZED_ASSET_ID })],
    );
    const assetOnlyWrite = await postOperation(baseUrl, database, editor.cookie, {
      opId: 'embedded-asset-only-write',
      type: 'node.patch',
      payload: {
        nodeId: 'authorized-a-instance',
        dataPatch: { definition: embeddedAssetReference },
      },
    });
    const assetOnlyAfter = database.getCanvas(CANVAS_ID);

    const corrupted = clone(assetOnlyAfter);
    corrupted.nodes.find((node) => node.id === 'authorized-a-instance').data.definition =
      subflowDefinition(
        AUTHORIZED_SUBFLOW_ID,
        'Authorized A with combined unauthorized resources',
        [
          subflowNode('a-to-private-b', UNAUTHORIZED_SUBFLOW_ID, 1, {
            text: PRIVATE_MARKER,
            assetId: UNAUTHORIZED_ASSET_ID,
          }),
        ],
      );
    database.db.prepare(`
      UPDATE canvas_documents
      SET snapshot_json = ?
      WHERE canvas_id = ?
    `).run(JSON.stringify(corrupted), CANVAS_ID);

    const canvasRead = await request(
      baseUrl,
      `/api/collab/canvases/${encodeURIComponent(CANVAS_ID)}`,
      { cookie: editor.cookie },
    );
    const syncRead = await request(
      baseUrl,
      `/api/collab/canvases/${encodeURIComponent(CANVAS_ID)}/sync`,
      { cookie: editor.cookie },
    );
    const combinedBefore = database.getCanvas(CANVAS_ID);
    const benignWrite = await postOperation(baseUrl, database, editor.cookie, {
      opId: 'embedded-combined-benign-write',
      type: 'node.patch',
      payload: {
        nodeId: 'authorized-a-instance',
        dataPatch: { label: 'benign edit must not bless hidden resources' },
      },
    });
    const combinedAfter = database.getCanvas(CANVAS_ID);
    const hiddenB = await request(
      baseUrl,
      `/api/collab/subflows/${encodeURIComponent(UNAUTHORIZED_SUBFLOW_ID)}/1`,
      { cookie: editor.cookie },
    );
    const hiddenAsset = await request(
      baseUrl,
      `/api/collab/assets/${encodeURIComponent(UNAUTHORIZED_ASSET_ID)}`,
      { cookie: editor.cookie },
    );
    const readText = JSON.stringify([canvasRead.payload, syncRead.payload]);

    const observed = {
      bOnlyDenied: DENIED_RESOURCE_STATUSES.has(bOnlyWrite.status),
      bOnlyRevisionUnchanged: bOnlyAfter.revision === bOnlyBefore.revision,
      bOnlyNotPersisted: !bOnlyAfter.nodes
        .find((node) => node.id === 'authorized-a-instance')
        .data.definition,
      assetOnlyDenied: DENIED_RESOURCE_STATUSES.has(assetOnlyWrite.status),
      assetOnlyRevisionUnchanged: assetOnlyAfter.revision === bOnlyAfter.revision,
      assetOnlyNotPersisted: !assetOnlyAfter.nodes
        .find((node) => node.id === 'authorized-a-instance')
        .data.definition,
      canvasReadDenied: DENIED_RESOURCE_STATUSES.has(canvasRead.status),
      syncReadDenied: DENIED_RESOURCE_STATUSES.has(syncRead.status),
      privateMarkerNotReturned: !readText.includes(PRIVATE_MARKER),
      hiddenIdsNotReturned: !readText.includes(UNAUTHORIZED_SUBFLOW_ID)
        && !readText.includes(UNAUTHORIZED_ASSET_ID),
      benignWriteDenied: DENIED_RESOURCE_STATUSES.has(benignWrite.status),
      combinedRevisionUnchanged: combinedAfter.revision === combinedBefore.revision,
      unauthorizedSubflowHidden: hiddenB.status === 404,
      unauthorizedAssetHidden: hiddenAsset.status === 404,
      grantsUnchanged: JSON.stringify(normalizeGrants(database))
        === JSON.stringify({
          assets: [],
          subflows: [`${AUTHORIZED_SUBFLOW_ID}@1`],
        }),
    };
    assert.deepEqual(observed, {
      bOnlyDenied: true,
      bOnlyRevisionUnchanged: true,
      bOnlyNotPersisted: true,
      assetOnlyDenied: true,
      assetOnlyRevisionUnchanged: true,
      assetOnlyNotPersisted: true,
      canvasReadDenied: true,
      syncReadDenied: true,
      privateMarkerNotReturned: true,
      hiddenIdsNotReturned: true,
      benignWriteDenied: true,
      combinedRevisionUnchanged: true,
      unauthorizedSubflowHidden: true,
      unauthorizedAssetHidden: true,
      grantsUnchanged: true,
    }, JSON.stringify({
      observed,
      bOnlyWrite,
      assetOnlyWrite,
      canvasRead,
      syncRead,
      benignWrite,
      hiddenB,
      hiddenAsset,
    }));
  } finally {
    await gateway.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('incremental sync falls back to the current snapshot instead of replaying historical unauthorized resources', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-embedded-sync-history-f1-'));
  const database = new ProjectDatabase(':memory:');
  const gateway = createGateway(database, directory);
  try {
    saveSubflow(
      database,
      subflowDefinition(AUTHORIZED_SUBFLOW_ID, 'Authorized current A'),
    );
    const historicalB = saveSubflow(
      database,
      subflowDefinition(
        UNAUTHORIZED_SUBFLOW_ID,
        'Historical B',
        [textNode('historical-b-private', PRIVATE_MARKER, {
          assetId: UNAUTHORIZED_ASSET_ID,
        })],
      ),
    );
    addAsset(database, UNAUTHORIZED_ASSET_ID, 'historical-unauthorized.png');
    ensureCanvas(database, [
      subflowNode('authorized-a-instance', AUTHORIZED_SUBFLOW_ID, 1),
    ]);

    database.applyOperations(CANVAS_ID, [{
      opId: 'historical-embedded-resource-add',
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      actorId: 'local-owner',
      sessionId: 'local-owner-session',
      baseRevision: 1,
      clientSeq: 1,
      type: 'node.add',
      payload: {
        node: subflowNode('historical-b-instance', UNAUTHORIZED_SUBFLOW_ID, 1, {
          definition: historicalB,
        }),
      },
      timestamp: Date.now(),
    }], { expectedRevision: 1 });
    database.applyOperations(CANVAS_ID, [{
      opId: 'historical-embedded-resource-remove',
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      actorId: 'local-owner',
      sessionId: 'local-owner-session',
      baseRevision: 2,
      clientSeq: 2,
      type: 'node.delete',
      payload: {
        nodeId: 'historical-b-instance',
      },
      timestamp: Date.now() + 1,
    }], { expectedRevision: 2 });
    assert.equal(database.getCanvas(CANVAS_ID).revision, 3);
    assert.deepEqual(normalizeGrants(database), {
      assets: [],
      subflows: [`${AUTHORIZED_SUBFLOW_ID}@1`],
    }, 'the removed historical B/asset must no longer be granted by the current canvas');

    const status = await gateway.start({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}`;
    const viewer = createSession(gateway, 'viewer', 'Historical sync viewer');
    const sync = await request(
      baseUrl,
      `/api/collab/canvases/${encodeURIComponent(CANVAS_ID)}/sync?afterRevision=1`,
      { cookie: viewer.cookie },
    );
    const serialized = JSON.stringify(sync.payload);

    assert.equal(sync.status, 200, serialized);
    assert.equal(sync.payload?.data?.mode, 'snapshot', serialized);
    assert.equal(sync.payload?.data?.document?.revision, 3, serialized);
    assert.equal(Array.isArray(sync.payload?.data?.operations), false, serialized);
    assert.equal(serialized.includes(PRIVATE_MARKER), false, serialized);
    assert.equal(serialized.includes(UNAUTHORIZED_SUBFLOW_ID), false, serialized);
    assert.equal(serialized.includes(UNAUTHORIZED_ASSET_ID), false, serialized);
  } finally {
    await gateway.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a legal two-level embedded definition is accepted without a false depth-limit 422', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-embedded-depth-f1-'));
  const database = new ProjectDatabase(':memory:');
  const gateway = createGateway(database, directory);
  try {
    const embeddedB = subflowDefinition(
      UNAUTHORIZED_SUBFLOW_ID,
      'Authorized nested B',
      [textNode('nested-b-leaf', 'legal nested leaf')],
    );
    const authoritativeA = subflowDefinition(
      AUTHORIZED_SUBFLOW_ID,
      'Authorized parent A',
      [subflowNode('a-to-authorized-b', UNAUTHORIZED_SUBFLOW_ID, 1)],
    );
    const canonicalB = saveSubflow(database, embeddedB);
    const canonicalA = saveSubflow(database, authoritativeA);
    ensureCanvas(database, [
      subflowNode('authorized-a-instance', AUTHORIZED_SUBFLOW_ID, 1),
    ]);
    assert.deepEqual(normalizeGrants(database), {
      assets: [],
      subflows: [
        `${AUTHORIZED_SUBFLOW_ID}@1`,
        `${UNAUTHORIZED_SUBFLOW_ID}@1`,
      ].sort(),
    });

    const status = await gateway.start({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}`;
    const editor = createSession(gateway);
    const embeddedA = clone(canonicalA);
    embeddedA.nodes[0].data.definition = clone(canonicalB);
    const before = database.getCanvas(CANVAS_ID);
    const mutation = await postOperation(baseUrl, database, editor.cookie, {
      opId: 'legal-two-level-embedded-definition',
      type: 'node.patch',
      payload: {
        nodeId: 'authorized-a-instance',
        dataPatch: { definition: embeddedA },
      },
    });
    const after = database.getCanvas(CANVAS_ID);

    assert.equal(mutation.status, 200, JSON.stringify(mutation.payload));
    assert.equal(after.revision, before.revision + 1);
    assert.equal(
      after.nodes
        .find((node) => node.id === 'authorized-a-instance')
        .data.definition.nodes[0].data.definition.nodes[0].data.text,
      'legal nested leaf',
    );
    assert.deepEqual(normalizeGrants(database), {
      assets: [],
      subflows: [
        `${AUTHORIZED_SUBFLOW_ID}@1`,
        `${UNAUTHORIZED_SUBFLOW_ID}@1`,
      ].sort(),
    });
  } finally {
    await gateway.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
