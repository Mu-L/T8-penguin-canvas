const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');
const { CollaborationGateway } = require('../backend/src/collaboration/gateway');

const PROJECT_ID = 'project-gateway-writer-b2';
const CANVAS_ID = 'canvas-gateway-writer-b2';
const NODE_ID = 'image-gateway-writer-b2';

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-gateway-writer-b2-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  database.ensureCanvas(CANVAS_ID, {
    projectId: PROJECT_ID,
    name: 'B2 gateway writer',
    nodes: [{
      id: NODE_ID,
      type: 'image',
      position: { x: 0, y: 0 },
      data: { model: 'gpt-image-2' },
    }],
    edges: [],
  }, PROJECT_ID);
  database.initializeCanvasResourceGrantsForSharing(PROJECT_ID, CANVAS_ID, {
    actorId: 'local-owner',
    sessionId: 'gateway-writer-b2-fixture',
  });
  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    FRONTEND_DIST: '',
    INPUT_DIR: input,
    OUTPUT_DIR: output,
  }, database);
  return { directory, database, gateway, baseUrl: null };
}

async function startFixture(fixture) {
  const status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  fixture.baseUrl = `http://127.0.0.1:${status.port}`;
  const invite = fixture.gateway.auth.createInvite({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    role: 'editor',
    maxUses: 1,
  });
  const response = await fetch(`${fixture.baseUrl}/api/collab/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, displayName: 'B2 gateway writer' }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return response.headers.get('set-cookie').split(';')[0];
}

async function closeFixture(fixture) {
  await fixture.gateway.stop();
  await fixture.database.close();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

async function postIntent(fixture, cookie, idempotencyKey, revision = 1) {
  const response = await fetch(`${fixture.baseUrl}/api/collab/run-intents`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      canvasId: CANVAS_ID,
      canvasRevision: revision,
      nodeIds: [NODE_ID],
      idempotencyKey,
    }),
  });
  const text = await response.text();
  return {
    response,
    text,
    payload: text ? JSON.parse(text) : null,
  };
}

async function getTextBinding(fixture, cookie) {
  const document = fixture.database.getCanvas(CANVAS_ID);
  const query = new URLSearchParams({
    targetType: 'node',
    targetEntityUid: document.nodes[0].entityUid,
    field: 'prompt',
  });
  const response = await fetch(
    `${fixture.baseUrl}/api/collab/canvases/${CANVAS_ID}/text?${query}`,
    { headers: { cookie } },
  );
  const text = await response.text();
  return {
    response,
    text,
    payload: text ? JSON.parse(text) : null,
  };
}

function durableRunIntentState(database) {
  return {
    intents: database.db.prepare(`
      SELECT COUNT(*) AS count FROM run_intents
      WHERE project_id = ? AND canvas_id = ?
    `).get(PROJECT_ID, CANVAS_ID).count,
    pins: database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_snapshot_pins
      WHERE project_id = ? AND canvas_id = ? AND pin_kind = 'run_intent'
    `).get(PROJECT_ID, CANVAS_ID).count,
    gaps: database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_legacy_snapshot_gaps
      WHERE project_id = ? AND canvas_id = ? AND pin_kind = 'run_intent'
    `).get(PROJECT_ID, CANVAS_ID).count,
    audits: database.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE project_id = ? AND canvas_id = ?
    `).get(PROJECT_ID, CANVAS_ID).count,
    snapshots: database.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_snapshots
      WHERE project_id = ? AND canvas_id = ?
    `).get(PROJECT_ID, CANVAS_ID).count,
  };
}

test('gateway RunIntent reservation uses the unified synchronous writer and broadcasts only after commit', async () => {
  const fixture = createFixture();
  try {
    const cookie = await startFixture(fixture);
    const boundaryCalls = [];
    const broadcasts = [];
    const originalBoundary = fixture.database.withProjectDatabaseWrite.bind(fixture.database);
    fixture.database.withProjectDatabaseWrite = (operation, callback) => {
      const enteredInTransaction = fixture.database.db.inTransaction;
      const coordinatorActiveAtEntry = fixture.database.isProjectDatabaseWriteCoordinatorActive();
      boundaryCalls.push({
        operation,
        callbackType: typeof callback,
        enteredInTransaction,
        coordinatorActiveAtEntry,
      });
      try {
        return originalBoundary(operation, () => {
          assert.equal(fixture.database.db.inTransaction, true);
          assert.equal(fixture.database.isProjectDatabaseWriteCoordinatorActive(), true);
          return callback();
        });
      } finally {
        assert.equal(fixture.database.db.inTransaction, enteredInTransaction);
        assert.equal(
          fixture.database.isProjectDatabaseWriteCoordinatorActive(),
          coordinatorActiveAtEntry,
        );
      }
    };
    fixture.gateway.broadcastHostRunIntent = (intent) => {
      broadcasts.push({
        intentId: intent.id,
        inTransaction: fixture.database.db.inTransaction,
        coordinatorActive: fixture.database.isProjectDatabaseWriteCoordinatorActive(),
        persisted: fixture.database.getRunIntent(intent.id)?.id || null,
      });
    };

    const created = await postIntent(fixture, cookie, 'gateway-writer-created-0001');
    assert.equal(created.response.status, 202, created.text);
    assert.deepEqual(boundaryCalls.filter((call) => call.operation === 'collaboration.run-intent.reserve'), [
      {
        operation: 'collaboration.run-intent.reserve',
        callbackType: 'function',
        enteredInTransaction: false,
        coordinatorActiveAtEntry: false,
      },
      {
        operation: 'collaboration.run-intent.reserve',
        callbackType: 'function',
        enteredInTransaction: true,
        coordinatorActiveAtEntry: true,
      },
    ]);
    assert.deepEqual(broadcasts, [{
      intentId: created.payload.data.id,
      inTransaction: false,
      coordinatorActive: false,
      persisted: created.payload.data.id,
    }]);

    fixture.database.setExecutionPolicy(PROJECT_ID, {
      allowedModels: ['provider-not-allowed:model-not-allowed'],
      dailyCostLimit: 0,
      perRunCostLimit: 0,
      concurrencyLimit: 1,
    });
    const denied = await postIntent(fixture, cookie, 'gateway-writer-policy-0001');
    assert.equal(denied.response.status, 429, denied.text);
    assert.equal(denied.payload.code, 'model_not_allowed');
    assert.equal(denied.payload.error, '该模型不在主机允许列表中');
    assert.equal(
      fixture.database.getRunIntentByKey(PROJECT_ID, 'gateway-writer-policy-0001'),
      null,
    );
    assert.deepEqual(boundaryCalls.filter((call) => call.operation === 'collaboration.run-intent.reserve'), [
      {
        operation: 'collaboration.run-intent.reserve',
        callbackType: 'function',
        enteredInTransaction: false,
        coordinatorActiveAtEntry: false,
      },
      {
        operation: 'collaboration.run-intent.reserve',
        callbackType: 'function',
        enteredInTransaction: true,
        coordinatorActiveAtEntry: true,
      },
      {
        operation: 'collaboration.run-intent.reserve',
        callbackType: 'function',
        enteredInTransaction: false,
        coordinatorActiveAtEntry: false,
      },
    ]);
    assert.equal(broadcasts.length, 1);
  } finally {
    await closeFixture(fixture);
  }
});

test('gateway RunIntent capacity failures use safe 507 frames and FULL rolls back every durable side effect', async () => {
  const fixture = createFixture();
  try {
    const cookie = await startFixture(fixture);
    const originalBoundary = fixture.database.withProjectDatabaseWrite.bind(fixture.database);

    fixture.database.withProjectDatabaseWrite = (operation, callback) => {
      if (operation === 'collaboration.run-intent.reserve') {
        throw new ProjectDatabaseStorageCapacityError('wal-pressure');
      }
      return originalBoundary(operation, callback);
    };
    const typed = await postIntent(fixture, cookie, 'gateway-writer-typed-0001');
    assert.equal(typed.response.status, 507, typed.text);
    assert.equal(typed.payload.code, 'project_database_storage_capacity_exceeded');
    assert.equal(typed.payload.reason, 'wal-pressure');
    assert.equal(typed.payload.retryable, true);

    const rawMessage = 'SQLITE_FULL at C:\\Users\\host-owner\\secret.sqlite UPDATE run_intents';
    fixture.database.withProjectDatabaseWrite = (operation, callback) => {
      if (operation === 'collaboration.run-intent.reserve') {
        throw Object.assign(new Error(rawMessage), { code: 'SQLITE_FULL' });
      }
      return originalBoundary(operation, callback);
    };
    const raw = await postIntent(fixture, cookie, 'gateway-writer-raw-0001');
    assert.equal(raw.response.status, 507, raw.text);
    assert.equal(raw.payload.code, 'project_database_storage_capacity_exceeded');
    assert.equal(raw.payload.reason, 'sqlite-full');
    assert.equal(raw.payload.retryable, false);
    assert.doesNotMatch(raw.text, /host-owner|secret\.sqlite|UPDATE run_intents/i);

    fixture.database.withProjectDatabaseWrite = originalBoundary;
    const originalCreateRunIntent = fixture.database.createRunIntent.bind(fixture.database);
    const before = durableRunIntentState(fixture.database);
    const broadcasts = [];
    fixture.gateway.broadcastHostRunIntent = (intent) => broadcasts.push(intent.id);
    fixture.database.createRunIntent = (input) => {
      originalCreateRunIntent(input);
      throw Object.assign(new Error(rawMessage), { code: 'SQLITE_FULL' });
    };

    const failed = await postIntent(fixture, cookie, 'gateway-writer-rollback-0001');
    assert.equal(failed.response.status, 507, failed.text);
    assert.equal(failed.payload.code, 'project_database_storage_capacity_exceeded');
    assert.equal(failed.payload.reason, 'sqlite-full');
    assert.equal(failed.payload.retryable, false);
    assert.doesNotMatch(failed.text, /host-owner|secret\.sqlite|UPDATE run_intents/i);
    assert.deepEqual(durableRunIntentState(fixture.database), before);
    assert.equal(
      fixture.database.getRunIntentByKey(PROJECT_ID, 'gateway-writer-rollback-0001'),
      null,
    );
    assert.deepEqual(broadcasts, []);
    assert.equal(fixture.database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(fixture.database.db.pragma('foreign_key_check'), []);

    fixture.database.createRunIntent = originalCreateRunIntent;
    const retried = await postIntent(fixture, cookie, 'gateway-writer-rollback-0001');
    assert.equal(retried.response.status, 202, retried.text);
    assert.equal(
      fixture.database.getRunIntentByKey(PROJECT_ID, 'gateway-writer-rollback-0001').id,
      retried.payload.data.id,
    );
    assert.deepEqual(broadcasts, [retried.payload.data.id]);
  } finally {
    await closeFixture(fixture);
  }
});

test('gateway collaboration text boundaries preserve the shared redacted storage-capacity 507 ABI', async () => {
  const fixture = createFixture();
  try {
    const cookie = await startFixture(fixture);
    fixture.gateway.textPersistence.getBindingSnapshot = () => {
      throw new ProjectDatabaseStorageCapacityError('wal-pressure', {
        operation: 'collaboration.text.binding.ensure',
      });
    };
    const typed = await getTextBinding(fixture, cookie);
    assert.equal(typed.response.status, 507, typed.text);
    assert.deepEqual(typed.payload, {
      success: false,
      code: 'project_database_storage_capacity_exceeded',
      error: '项目数据库或 SQLite 临时存储空间不足,本次写入已回滚',
      reason: 'wal-pressure',
      retryable: true,
    });

    fixture.gateway.textPersistence.getBindingSnapshot = () => {
      throw Object.assign(
        new Error('SQLITE_FULL at C:\\Users\\private-owner\\secret.sqlite INSERT text'),
        { code: 'SQLITE_FULL' },
      );
    };
    const raw = await getTextBinding(fixture, cookie);
    assert.equal(raw.response.status, 507, raw.text);
    assert.equal(raw.payload.code, 'project_database_storage_capacity_exceeded');
    assert.equal(raw.payload.reason, 'sqlite-full');
    assert.equal(raw.payload.retryable, false);
    assert.doesNotMatch(raw.text, /private-owner|secret\.sqlite|INSERT text/i);
  } finally {
    await closeFixture(fixture);
  }
});

test('gateway upload capacity responses preserve only the safe reason and retryability ABI', async () => {
  const fixture = createFixture();
  const originalCreateSession = fixture.database.createAssetUploadSession;
  try {
    const cookie = await startFixture(fixture);
    fixture.database.createAssetUploadSession = () => {
      const error = new ProjectDatabaseStorageCapacityError('wal-pressure', {
        operation: 'private.asset-upload.writer',
      });
      error.message = 'SQLITE_FULL at C:\\Users\\private-owner\\secret.sqlite token=never-expose';
      error.path = 'C:\\Users\\private-owner\\secret.sqlite';
      throw error;
    };

    const response = await fetch(`${fixture.baseUrl}/api/collab/assets/uploads`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'capacity.png',
        size: 1,
        idempotencyKey: 'gateway-upload-capacity-b2',
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 507, text);
    assert.deepEqual(JSON.parse(text), {
      success: false,
      code: 'asset_upload_storage_full',
      error: '主机存储空间或数据库容量不足，本次上传操作未完成，请释放空间后重试',
      reason: 'wal-pressure',
      retryable: true,
    });
    assert.doesNotMatch(text, /private-owner|secret\.sqlite|never-expose|private\.asset-upload/i);

    fixture.database.createAssetUploadSession = () => {
      const error = Object.assign(new Error('forged private reason'), {
        code: 'asset_upload_storage_full',
        status: 507,
        reason: 'C:\\private\\database.sqlite',
        retryable: true,
        current: {
          privatePath: 'C:\\private\\current.sqlite3',
          token: 'never-expose-current',
        },
      });
      throw error;
    };
    const sanitized = await fetch(`${fixture.baseUrl}/api/collab/assets/uploads`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'capacity.png',
        size: 1,
        idempotencyKey: 'gateway-upload-capacity-b2-forged',
      }),
    });
    const sanitizedText = await sanitized.text();
    const sanitizedPayload = JSON.parse(sanitizedText);
    assert.equal(sanitized.status, 507, sanitizedText);
    assert.deepEqual(sanitizedPayload, {
      success: false,
      code: 'asset_upload_storage_full',
      error: '主机存储空间或数据库容量不足，本次上传操作未完成，请释放空间后重试',
      reason: 'sqlite-full',
      retryable: true,
    });
    assert.doesNotMatch(sanitizedText, /forged private reason|C:\\private|database\.sqlite|current\.sqlite3|never-expose-current/i);
  } finally {
    fixture.database.createAssetUploadSession = originalCreateSession;
    await closeFixture(fixture);
  }
});

test('gateway upload completion exposes a sanitized committed warning instead of a false 507', async () => {
  const fixture = createFixture();
  const originalComplete = fixture.gateway.uploadManager.complete;
  try {
    const cookie = await startFixture(fixture);
    fixture.gateway.uploadManager.complete = async () => ({
      session: {
        id: 'asset-upload-post-commit-capacity-b2',
        projectId: PROJECT_ID,
        filename: 'committed.png',
        mimeType: 'image/png',
        expectedSize: 1,
        chunkSize: 1024 * 1024,
        chunkCount: 1,
        receivedBytes: 1,
        reservedBytes: 0,
        receivedChunks: [],
        status: 'completed',
        revision: 3,
        assetId: 'asset-post-commit-capacity-b2',
        contentHash: 'a'.repeat(64),
        deduplicated: false,
      },
      asset: null,
      deduplicated: false,
      blobId: `blob_${'a'.repeat(64)}`,
      quota: null,
      idempotentReplay: false,
      persistenceWarning: {
        code: 'asset_upload_post_commit_capacity',
        committed: true,
        phase: 'C:\\private\\phase.sqlite3',
        reason: 'C:\\private\\reason.sqlite3',
        retryable: true,
        privateSql: 'INSERT secret',
      },
    });

    const response = await fetch(
      `${fixture.baseUrl}/api/collab/assets/uploads/asset-upload-post-commit-capacity-b2/complete`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ contentHash: 'a'.repeat(64) }),
      },
    );
    const text = await response.text();
    assert.equal(response.status, 201, text);
    const payload = JSON.parse(text);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data.persistenceWarning, {
      code: 'asset_upload_post_commit_capacity',
      committed: true,
      phase: 'finalization',
      reason: 'sqlite-full',
      retryable: true,
    });
    assert.doesNotMatch(text, /C:\\private|phase\.sqlite3|reason\.sqlite3|INSERT secret|privateSql/i);
  } finally {
    fixture.gateway.uploadManager.complete = originalComplete;
    await closeFixture(fixture);
  }
});

test('gateway authentication stays pure while explicit session heartbeat capacity uses the shared safe 507 ABI', async () => {
  const fixture = createFixture();
  try {
    const cookie = await startFixture(fixture);
    const originalBoundary = fixture.database.withProjectDatabaseWrite.bind(fixture.database);
    const before = durableRunIntentState(fixture.database);
    fixture.database.withProjectDatabaseWrite = (operation, callback) => {
      if (operation === 'collaboration.session.heartbeat') {
        throw Object.assign(
          new Error('SQLITE_FULL at C:\\Users\\private-owner\\session.sqlite UPDATE last_seen_at token=never-expose'),
          { code: 'SQLITE_FULL' },
        );
      }
      return originalBoundary(operation, callback);
    };

    const result = await postIntent(fixture, cookie, 'gateway-session-touch-capacity-b2');
    assert.equal(result.response.status, 202, result.text);
    assert.equal(
      fixture.database.getRunIntentByKey(PROJECT_ID, 'gateway-session-touch-capacity-b2')?.id,
      result.payload.data.id,
    );
    const afterIntent = durableRunIntentState(fixture.database);
    assert.equal(afterIntent.intents, before.intents + 1);

    const sessionResponse = await fetch(`${fixture.baseUrl}/api/collab/session`, {
      headers: { cookie },
    });
    const sessionPayload = await sessionResponse.json();
    assert.equal(sessionResponse.status, 200, JSON.stringify(sessionPayload));
    fixture.database.db.prepare('UPDATE collaboration_sessions SET last_seen_at = 1 WHERE id = ?')
      .run(sessionPayload.data.id);
    const heartbeat = await fetch(`${fixture.baseUrl}/api/collab/session/heartbeat`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionPayload.data.id,
        projectId: sessionPayload.data.projectId,
        canvasId: sessionPayload.data.canvasId,
        memberId: sessionPayload.data.memberId,
        authorizationEpoch: sessionPayload.data.authorizationEpoch,
      }),
    });
    const heartbeatText = await heartbeat.text();
    const heartbeatPayload = JSON.parse(heartbeatText);
    assert.equal(heartbeat.status, 507, heartbeatText);
    assert.equal(heartbeat.headers.get('cache-control'), 'no-store');
    assert.equal(heartbeatPayload.code, 'project_database_storage_capacity_exceeded');
    assert.equal(heartbeatPayload.reason, 'sqlite-full');
    assert.equal(heartbeatPayload.retryable, false);
    assert.doesNotMatch(heartbeatText, /private-owner|session\.sqlite|last_seen_at|never-expose/i);
    assert.deepEqual(durableRunIntentState(fixture.database), afterIntent);
  } finally {
    await closeFixture(fixture);
  }
});
