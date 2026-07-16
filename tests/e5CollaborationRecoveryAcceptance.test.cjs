const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');

const {
  applyCanvasOperation,
  normalizeCanvasDocument,
} = require('../backend/src/collaboration/protocol');
const { CollaborationGateway } = require('../backend/src/collaboration/gateway');
const { HostExecutionPolicy } = require('../backend/src/collaboration/executionPolicy');
const { CANVAS_PATCH_CONTRACT } = require('../backend/src/services/canvasPatch');
const { executeCanvasAgentTool } = require('../backend/src/services/canvasAgentTools');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

function makeDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  return { response, payload };
}

async function redeem(baseUrl, gateway, role, displayName) {
  const invite = gateway.auth.createInvite({
    projectId: 'project-e5-collaboration',
    role,
    maxUses: 1,
  });
  const result = await requestJson(`${baseUrl}/api/collab/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, displayName }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return {
    ...result.payload.data,
    cookie: result.response.headers.get('set-cookie').split(';')[0],
  };
}

async function openJoinedSocket(status, cookie, canvasId) {
  const socket = new WebSocket(`ws://127.0.0.1:${status.port}/ws/collab`, {
    origin: `http://127.0.0.1:${status.port}`,
    headers: { cookie },
  });
  const joined = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('E5 collaboration websocket join timed out')), 4_000);
    socket.once('error', reject);
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'session.ready') {
        socket.send(JSON.stringify({ type: 'canvas.join', canvasId }));
      } else if (message.type === 'canvas.joined') {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
  return { socket, joined };
}

async function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.close();
  });
}

function operationRequest(baseUrl, client, baseRevision, operation) {
  return requestJson(`${baseUrl}/api/collab/canvases/canvas-e5/operations`, {
    method: 'POST',
    headers: { cookie: client.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision, operations: [operation] }),
  });
}

async function readCanvas(baseUrl, client) {
  const result = await requestJson(`${baseUrl}/api/collab/canvases/canvas-e5`, {
    headers: { cookie: client.cookie },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return result.payload.data;
}

function reconstructFromSync(baseDocument, sync) {
  if (sync.mode === 'snapshot') return sync.document;
  let document = baseDocument;
  for (const operation of sync.operations) {
    assert.equal(operation.revision, document.revision + 1);
    const applied = applyCanvasOperation(document, operation);
    document = normalizeCanvasDocument(document.canvasId, applied.document, {
      projectId: document.projectId,
      revision: operation.revision,
      updatedAt: operation.timestamp,
    });
  }
  assert.equal(document.revision, sync.revision);
  return document;
}

function graphProjection(document) {
  const tombstoneProjection = (records) => Object.entries(records || {})
    .map(([id, record]) => ({
      id,
      opId: record.opId,
      revision: record.revision,
      entityUid: record.entityUid,
      entityType: record.entityType,
      source: record.source,
      target: record.target,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    revision: document.revision,
    nodes: (document.nodes || []).map((node) => ({
      id: node.id,
      entityUid: node.entityUid,
      type: node.type,
      position: node.position,
      data: node.data,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    edges: (document.edges || []).map((edge) => ({
      id: edge.id,
      entityUid: edge.entityUid,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    tombstones: {
      nodes: tombstoneProjection(document.tombstones?.nodes),
      edges: tombstoneProjection(document.tombstones?.edges),
    },
  };
}

test('E5 three clients rebase stale additions, resolve delete/edit races, reconnect by delta, and reject stale run intent', {
  timeout: 20_000,
}, async () => {
  const directory = makeDirectory('t8-e5-three-client-');
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    FRONTEND_DIST: '',
    INPUT_DIR: input,
    OUTPUT_DIR: output,
  }, database);
  const sockets = [];
  try {
    database.ensureCanvas('canvas-e5', {
      name: 'E5 三客户端画布',
      nodes: [
        { id: 'anchor', type: 'text', position: { x: 0, y: 0 }, data: { text: 'anchor' } },
        { id: 'victim', type: 'text', position: { x: 180, y: 0 }, data: { text: 'must stay deleted' } },
        {
          id: 'run-image-node',
          type: 'image',
          position: { x: 360, y: 0 },
          data: { model: 'gpt-image-2', apiModel: 'gpt-image-2-all', prompt: 'first task' },
        },
      ],
      edges: [],
    }, 'project-e5-collaboration');
    const status = await gateway.start({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}`;
    const clients = await Promise.all([
      redeem(baseUrl, gateway, 'editor', 'E5 编辑者 A'),
      redeem(baseUrl, gateway, 'editor', 'E5 编辑者 B'),
      redeem(baseUrl, gateway, 'editor', 'E5 编辑者 C'),
    ]);
    assert.equal(new Set(clients.map((client) => client.memberId)).size, 3);

    for (const client of clients) {
      const joined = await openJoinedSocket(status, client.cookie, 'canvas-e5');
      sockets.push(joined.socket);
      assert.equal(joined.joined.revision, 1);
    }

    const initialDocuments = await Promise.all(clients.map((client) => readCanvas(baseUrl, client)));
    assert.deepEqual(initialDocuments.map((document) => document.revision), [1, 1, 1]);
    const additions = clients.map((_client, index) => ({
      opId: `e5-client-add-${index + 1}`,
      clientSeq: 1,
      type: 'node.add',
      payload: {
        node: {
          id: `client-${index + 1}-node`,
          type: 'text',
          position: { x: index * 160, y: 220 },
          data: { text: `client-${index + 1}` },
        },
      },
    }));
    const firstAttempts = await Promise.all(clients.map((client, index) => (
      operationRequest(baseUrl, client, 1, additions[index])
    )));
    assert.equal(firstAttempts.filter((result) => result.response.status === 200).length, 1);
    assert.equal(firstAttempts.filter((result) => result.response.status === 409).length, 2);

    for (let index = 0; index < firstAttempts.length; index += 1) {
      if (firstAttempts[index].response.status === 200) continue;
      const current = await readCanvas(baseUrl, clients[index]);
      const retried = await operationRequest(baseUrl, clients[index], current.revision, additions[index]);
      assert.equal(retried.response.status, 200, JSON.stringify(retried.payload));
    }
    const beforeDisconnect = await readCanvas(baseUrl, clients[2]);
    assert.equal(beforeDisconnect.revision, 4);
    assert.deepEqual(
      beforeDisconnect.nodes.filter((node) => /^client-\d-node$/.test(node.id)).map((node) => node.id).sort(),
      ['client-1-node', 'client-2-node', 'client-3-node'],
    );

    const oldIntentResult = await requestJson(`${baseUrl}/api/collab/run-intents`, {
      method: 'POST',
      headers: { cookie: clients[2].cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        canvasId: 'canvas-e5',
        canvasRevision: beforeDisconnect.revision,
        nodeIds: ['run-image-node'],
        idempotencyKey: 'e5-old-intent-0001',
      }),
    });
    assert.equal(oldIntentResult.response.status, 202, JSON.stringify(oldIntentResult.payload));
    const oldIntent = oldIntentResult.payload.data;

    await closeSocket(sockets.pop());
    const raceBaseRevision = beforeDisconnect.revision;
    const [deleteAttempt, editAttempt] = await Promise.all([
      operationRequest(baseUrl, clients[0], raceBaseRevision, {
        opId: 'e5-delete-victim',
        clientSeq: 2,
        type: 'node.delete',
        payload: { nodeId: 'victim' },
      }),
      operationRequest(baseUrl, clients[1], raceBaseRevision, {
        opId: 'e5-edit-victim',
        clientSeq: 2,
        type: 'node.patch',
        payload: { nodeId: 'victim', dataPatch: { text: 'stale edit must not revive' } },
      }),
    ]);
    assert.equal([deleteAttempt, editAttempt].filter((result) => result.response.status === 200).length, 1);
    assert.equal([deleteAttempt, editAttempt].filter((result) => result.response.status === 409).length, 1);
    if (deleteAttempt.response.status !== 200) {
      const current = await readCanvas(baseUrl, clients[0]);
      const retriedDelete = await operationRequest(baseUrl, clients[0], current.revision, {
        opId: 'e5-delete-victim',
        clientSeq: 3,
        type: 'node.delete',
        payload: { nodeId: 'victim' },
      });
      assert.equal(retriedDelete.response.status, 200, JSON.stringify(retriedDelete.payload));
    }

    let current = await readCanvas(baseUrl, clients[1]);
    const editDeleted = await operationRequest(baseUrl, clients[1], current.revision, {
      opId: 'e5-edit-deleted-victim',
      clientSeq: 4,
      type: 'node.patch',
      payload: { nodeId: 'victim', dataPatch: { text: 'must stay rejected' } },
    });
    assert.equal(editDeleted.response.status, 400, JSON.stringify(editDeleted.payload));
    assert.equal(editDeleted.payload.code, 'object_deleted');
    const addDeletedId = await operationRequest(baseUrl, clients[1], current.revision, {
      opId: 'e5-readd-deleted-victim',
      clientSeq: 5,
      type: 'node.add',
      payload: {
        node: { id: 'victim', type: 'text', position: { x: 999, y: 999 }, data: { text: 'implicit revival' } },
      },
    });
    assert.equal(addDeletedId.response.status, 400, JSON.stringify(addDeletedId.payload));
    assert.equal(addDeletedId.payload.code, 'object_deleted');
    assert.equal((await readCanvas(baseUrl, clients[1])).revision, current.revision);

    const offlineAddition = await operationRequest(baseUrl, clients[1], current.revision, {
      opId: 'e5-offline-addition',
      clientSeq: 6,
      type: 'node.add',
      payload: {
        node: { id: 'offline-addition', type: 'text', position: { x: 520, y: 220 }, data: { text: 'created while C was offline' } },
      },
    });
    assert.equal(offlineAddition.response.status, 200, JSON.stringify(offlineAddition.payload));
    current = offlineAddition.payload.data.document;
    const changeRunTarget = await operationRequest(baseUrl, clients[0], current.revision, {
      opId: 'e5-change-run-target',
      clientSeq: 7,
      type: 'node.patch',
      payload: { nodeId: 'run-image-node', dataPatch: { prompt: 'new task after old intent' } },
    });
    assert.equal(changeRunTarget.response.status, 200, JSON.stringify(changeRunTarget.payload));
    current = changeRunTarget.payload.data.document;

    const executionPolicy = new HostExecutionPolicy(database);
    assert.throws(
      () => executionPolicy.authorizeRunIntent(oldIntent.id, {
        allowedStatuses: ['pending'],
        requireUnclaimed: true,
        reservationAlreadyCounted: true,
      }),
      (error) => error?.code === 'intent_canvas_stale'
        && error?.details?.expectedRevision === beforeDisconnect.revision
        && error?.details?.currentRevision === current.revision,
    );
    const staleIntent = await requestJson(`${baseUrl}/api/collab/run-intents`, {
      method: 'POST',
      headers: { cookie: clients[2].cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        canvasId: 'canvas-e5',
        canvasRevision: beforeDisconnect.revision,
        nodeIds: ['run-image-node'],
        idempotencyKey: 'e5-stale-intent-0001',
      }),
    });
    assert.equal(staleIntent.response.status, 409, JSON.stringify(staleIntent.payload));
    assert.equal(staleIntent.payload.code, 'intent_canvas_stale');
    const freshIntent = await requestJson(`${baseUrl}/api/collab/run-intents`, {
      method: 'POST',
      headers: { cookie: clients[2].cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        canvasId: 'canvas-e5',
        canvasRevision: current.revision,
        nodeIds: ['run-image-node'],
        idempotencyKey: 'e5-fresh-intent-0001',
      }),
    });
    assert.equal(freshIntent.response.status, 202, JSON.stringify(freshIntent.payload));
    assert.notEqual(freshIntent.payload.data.id, oldIntent.id);

    const reconnected = await openJoinedSocket(status, clients[2].cookie, 'canvas-e5');
    sockets.push(reconnected.socket);
    assert.equal(reconnected.joined.revision, current.revision);
    const syncResult = await requestJson(
      `${baseUrl}/api/collab/canvases/canvas-e5/sync?afterRevision=${beforeDisconnect.revision}`,
      { headers: { cookie: clients[2].cookie } },
    );
    assert.equal(syncResult.response.status, 200, JSON.stringify(syncResult.payload));
    assert.equal(syncResult.payload.data.mode, 'operations');
    const reconstructed = reconstructFromSync(beforeDisconnect, syncResult.payload.data);
    const finalDocument = await readCanvas(baseUrl, clients[2]);
    assert.deepEqual(graphProjection(reconstructed), graphProjection(finalDocument));
    assert.equal(finalDocument.nodes.some((node) => node.id === 'victim'), false);
    assert.ok(finalDocument.tombstones.nodes.victim);
    assert.ok(finalDocument.nodes.some((node) => node.id === 'offline-addition'));
    assert.deepEqual(
      finalDocument.nodes.filter((node) => /^client-\d-node$/.test(node.id)).map((node) => node.id).sort(),
      ['client-1-node', 'client-2-node', 'client-3-node'],
    );
    assert.equal(database.listRunIntents({ projectId: 'project-e5-collaboration' }).length, 2);
  } finally {
    await Promise.all(sockets.map(closeSocket));
    await gateway.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function e5RecoveryPatch() {
  return {
    schema: CANVAS_PATCH_CONTRACT,
    id: '55555555-5555-4555-8555-555555555555',
    baseRevision: 1,
    summary: 'E5 恢复验收 Patch',
    diagnosticsResolved: ['e5.recovery.acceptance'],
    requiresConfirmation: true,
    operations: [
      {
        type: 'node.patch',
        payload: { nodeId: 'text-source', dataPatch: { text: 'patched before explicit revert' } },
      },
      {
        type: 'node.move',
        payload: { nodeId: 'image-runner', position: { x: 420, y: 160 } },
      },
    ],
  };
}

function agentRequest(tool, input = {}) {
  return {
    tool,
    requestId: `e5-recovery-${tool}`,
    projectId: 'project-e5-recovery',
    canvasId: 'canvas-e5-recovery',
    input,
  };
}

const AGENT_CONTEXT = Object.freeze({
  projectId: 'project-e5-recovery',
  canvasId: 'canvas-e5-recovery',
  actorId: 'e5-owner',
  role: 'owner',
  capabilities: Object.freeze(['editGraph', 'manageProviders']),
});

test('E5 failed Patch rolls back, explicit revert saves, and validation plus Run evidence stay deterministic after reopen', () => {
  const directory = makeDirectory('t8-e5-patch-recovery-');
  const filename = path.join(directory, 'projects.sqlite3');
  let failCommit = false;
  let validationBeforeReopen;
  let simulationBeforeReopen;
  let runInspectionBeforeReopen;
  let savedRevision;
  try {
    const first = new ProjectDatabase(filename, {
      autoBackup: false,
      beforeCanvasPatchCommit: () => {
        if (failCommit) throw new Error('e5-injected-patch-commit-failure');
      },
    });
    try {
      first.ensureCanvas('canvas-e5-recovery', {
        name: 'E5 恢复画布',
        nodes: [
          { id: 'text-source', type: 'text', position: { x: 0, y: 0 }, data: { text: 'original prompt' } },
          {
            id: 'image-runner',
            type: 'image',
            position: { x: 260, y: 0 },
            data: { model: 'gpt-image-2', apiModel: 'gpt-image-2-all' },
          },
        ],
        edges: [{ id: 'prompt-edge', source: 'text-source', target: 'image-runner' }],
      }, 'project-e5-recovery');
      const preview = first.previewCanvasPatch('canvas-e5-recovery', e5RecoveryPatch(), {
        actorId: 'e5-owner',
        sessionId: 'e5-session',
      });
      failCommit = true;
      assert.throws(() => first.applyCanvasPatch('canvas-e5-recovery', e5RecoveryPatch(), {
        previewDigest: preview.previewDigest,
        confirmed: true,
        actorId: 'e5-owner',
        sessionId: 'e5-session',
      }), /e5-injected-patch-commit-failure/);
      const rolledBack = first.getCanvas('canvas-e5-recovery');
      assert.equal(rolledBack.revision, 1);
      assert.equal(rolledBack.nodes.find((node) => node.id === 'text-source').data.text, 'original prompt');
      assert.deepEqual(rolledBack.nodes.find((node) => node.id === 'image-runner').position, { x: 260, y: 0 });
      assert.equal(first.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations').get().count, 0);
      assert.equal(first.db.prepare('SELECT COUNT(*) AS count FROM canvas_patch_applications').get().count, 0);
      assert.equal(first.db.prepare('SELECT COUNT(*) AS count FROM canvas_mutation_provenance').get().count, 0);
      assert.equal(first.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 0);
    } finally {
      first.close();
    }

    failCommit = false;
    const second = new ProjectDatabase(filename, { autoBackup: false });
    try {
      const recovered = second.getCanvas('canvas-e5-recovery');
      assert.equal(recovered.revision, 1);
      assert.equal(second.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations').get().count, 0);
      const preview = second.previewCanvasPatch('canvas-e5-recovery', e5RecoveryPatch(), {
        actorId: 'e5-owner',
        sessionId: 'e5-session',
      });
      const applied = second.applyCanvasPatch('canvas-e5-recovery', e5RecoveryPatch(), {
        previewDigest: preview.previewDigest,
        confirmed: true,
        actorId: 'e5-owner',
        sessionId: 'e5-session',
      });
      assert.equal(applied.revision, 3);
      const reverted = second.revertCanvasPatch(
        'canvas-e5-recovery',
        e5RecoveryPatch().id,
        {
          expectedRevision: 3,
          actorId: 'e5-owner',
          sessionId: 'e5-revert-session',
        },
      );
      assert.equal(reverted.revision, 5);
      assert.equal(reverted.document.nodes.find((node) => node.id === 'text-source').data.text, 'original prompt');
      assert.deepEqual(reverted.document.nodes.find((node) => node.id === 'image-runner').position, { x: 260, y: 0 });
      const saved = second.saveCanvasSnapshot('canvas-e5-recovery', reverted.document, {
        expectedRevision: 5,
        opId: 'e5-save-after-revert',
        actorId: 'e5-owner',
        sessionId: 'e5-save-session',
      });
      savedRevision = saved.revision;
      assert.equal(savedRevision, 6);
      validationBeforeReopen = executeCanvasAgentTool(
        second,
        agentRequest('validateCanvas'),
        AGENT_CONTEXT,
      );
      simulationBeforeReopen = executeCanvasAgentTool(
        second,
        agentRequest('simulateExecutionPlan'),
        AGENT_CONTEXT,
      );
      assert.equal(validationBeforeReopen.data.valid, true);
      assert.equal(simulationBeforeReopen.data.valid, true);
      assert.equal(simulationBeforeReopen.data.blocked, false);
      assert.equal(simulationBeforeReopen.data.executableNodeCount, 1);

      const run = second.createRun({
        id: 'e5-recovery-run',
        projectId: 'project-e5-recovery',
        canvasId: 'canvas-e5-recovery',
        canvasRevision: savedRevision,
        initiatorId: 'e5-owner',
        status: 'succeeded',
        startedAt: 1_800_000_000_000,
        finishedAt: 1_800_000_000_500,
      });
      const nodeRun = second.createNodeRun({
        id: 'e5-recovery-node-run',
        runId: run.id,
        nodeId: 'image-runner',
        originalNodeId: 'image-runner',
        status: 'succeeded',
        inputSnapshot: {
          node: saved.nodes.find((node) => node.id === 'image-runner'),
          upstream: [{ nodeId: 'text-source', text: 'original prompt' }],
        },
      });
      second.createAttempt({
        id: 'e5-recovery-attempt',
        nodeRunId: nodeRun.id,
        provider: 'image',
        model: 'gpt-image-2-all',
        requestId: 'e5-recovery-request',
        httpStatus: 200,
        status: 'succeeded',
        timestamps: { submittedAt: 1_800_000_000_100, finishedAt: 1_800_000_000_500 },
      });
      second.appendRunEvent(run.id, {
        nodeRunId: nodeRun.id,
        type: 'node.succeeded',
        payload: { status: 'succeeded' },
        createdAt: 1_800_000_000_500,
      });
      second.appendRunEvent(run.id, {
        type: 'run.succeeded',
        payload: { status: 'succeeded' },
        createdAt: 1_800_000_000_501,
      });
      runInspectionBeforeReopen = executeCanvasAgentTool(
        second,
        agentRequest('inspectRun', { runId: run.id }),
        AGENT_CONTEXT,
      );
      assert.equal(runInspectionBeforeReopen.data.evidenceComplete, true);
      assert.equal(runInspectionBeforeReopen.data.canvasRevision, savedRevision);
      assert.equal(runInspectionBeforeReopen.data.status, 'succeeded');
    } finally {
      second.close();
    }

    const third = new ProjectDatabase(filename, { autoBackup: false });
    try {
      const reopened = third.getCanvas('canvas-e5-recovery');
      assert.equal(reopened.revision, savedRevision);
      assert.equal(reopened.nodes.find((node) => node.id === 'text-source').data.text, 'original prompt');
      assert.deepEqual(reopened.nodes.find((node) => node.id === 'image-runner').position, { x: 260, y: 0 });
      assert.deepEqual(
        executeCanvasAgentTool(third, agentRequest('validateCanvas'), AGENT_CONTEXT),
        validationBeforeReopen,
      );
      assert.deepEqual(
        executeCanvasAgentTool(third, agentRequest('simulateExecutionPlan'), AGENT_CONTEXT),
        simulationBeforeReopen,
      );
      assert.deepEqual(
        executeCanvasAgentTool(
          third,
          agentRequest('inspectRun', { runId: 'e5-recovery-run' }),
          AGENT_CONTEXT,
        ),
        runInspectionBeforeReopen,
      );
      const patchRecord = third.listCanvasPatches('canvas-e5-recovery', { actorId: 'e5-owner' })[0];
      assert.equal(patchRecord.status, 'reverted');
      assert.equal(patchRecord.appliedRevision, 3);
      assert.equal(patchRecord.revertedRevision, 5);
      assert.equal(third.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(third.db.pragma('foreign_key_check'), []);
    } finally {
      third.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('E5 crash recovery isolates an interrupted old Attempt from a fresh Run with the same node id', () => {
  const directory = makeDirectory('t8-e5-stale-run-');
  const filename = path.join(directory, 'projects.sqlite3');
  try {
    const first = new ProjectDatabase(filename, { autoBackup: false });
    try {
      first.ensureCanvas('canvas-e5-run-isolation', {
        nodes: [{
          id: 'same-node',
          type: 'image',
          position: { x: 0, y: 0 },
          data: { model: 'gpt-image-2', apiModel: 'gpt-image-2-all' },
        }],
        edges: [],
      }, 'project-e5-run-isolation');
      const oldRun = first.createRun({
        id: 'e5-old-run',
        projectId: 'project-e5-run-isolation',
        canvasId: 'canvas-e5-run-isolation',
        canvasRevision: 1,
        status: 'running',
      });
      const oldNodeRun = first.createNodeRun({
        id: 'e5-old-node-run',
        runId: oldRun.id,
        nodeId: 'same-node',
        originalNodeId: 'same-node',
        status: 'running',
        inputSnapshot: { node: { id: 'same-node', type: 'image' }, prompt: 'old task' },
      });
      first.createAttempt({
        id: 'e5-old-attempt',
        nodeRunId: oldNodeRun.id,
        provider: 'image',
        model: 'gpt-image-2-all',
        upstreamTaskId: 'old-upstream-task',
        requestId: 'old-request',
        status: 'polling',
      });
    } finally {
      first.close();
    }

    const second = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(second.getRun('e5-old-run').status, 'interrupted');
      assert.equal(second.getNodeRun('e5-old-node-run').status, 'interrupted');
      assert.equal(second.getAttempt('e5-old-attempt').status, 'interrupted');
      const freshRun = second.createRun({
        id: 'e5-fresh-run',
        projectId: 'project-e5-run-isolation',
        canvasId: 'canvas-e5-run-isolation',
        canvasRevision: 1,
        status: 'running',
      });
      const freshNodeRun = second.createNodeRun({
        id: 'e5-fresh-node-run',
        runId: freshRun.id,
        nodeId: 'same-node',
        originalNodeId: 'same-node',
        status: 'running',
        inputSnapshot: { node: { id: 'same-node', type: 'image' }, prompt: 'fresh task' },
      });
      const freshAttempt = second.createAttempt({
        id: 'e5-fresh-attempt',
        nodeRunId: freshNodeRun.id,
        provider: 'image',
        model: 'gpt-image-2-all',
        upstreamTaskId: 'fresh-upstream-task',
        requestId: 'fresh-request',
        status: 'polling',
      });
      assert.throws(() => second.updateAttempt(
        'e5-old-attempt',
        { status: 'succeeded' },
        { runId: freshRun.id, nodeRunId: freshNodeRun.id },
      ), /Attempt 不属于当前 Run\/NodeRun/);
      assert.throws(() => second.recordRunOutputAssets({
        runId: freshRun.id,
        nodeRunId: freshNodeRun.id,
        attemptId: 'e5-old-attempt',
        outputs: [{
          kind: 'image',
          filename: 'stale.png',
          sourceUrl: 'https://cdn.example.test/stale-result.png',
        }],
      }), /输出 Attempt 不属于当前 NodeRun/);
      assert.deepEqual(second.getNodeRun('e5-old-node-run').outputRefs, []);
      assert.deepEqual(second.getNodeRun('e5-fresh-node-run').outputRefs, []);

      const recorded = second.recordRunOutputAssets({
        runId: freshRun.id,
        nodeRunId: freshNodeRun.id,
        attemptId: freshAttempt.id,
        outputs: [{
          kind: 'image',
          filename: 'fresh.png',
          mimeType: 'image/png',
          sourceUrl: 'https://cdn.example.test/fresh-result.png',
        }],
      });
      assert.equal(recorded.assets.length, 1);
      second.updateAttempt(freshAttempt.id, {
        status: 'succeeded',
        httpStatus: 200,
        timestamps: { finishedAt: 1_800_000_100_000 },
      }, {
        runId: freshRun.id,
        nodeRunId: freshNodeRun.id,
      });
      second.updateNodeRun(freshNodeRun.id, { status: 'succeeded' });
      second.updateRun(freshRun.id, { status: 'succeeded', finishedAt: 1_800_000_100_000 });
    } finally {
      second.close();
    }

    const third = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(third.getRun('e5-old-run').status, 'interrupted');
      assert.equal(third.getRun('e5-fresh-run').status, 'succeeded');
      assert.deepEqual(third.getNodeRun('e5-old-node-run').outputRefs, []);
      const freshRefs = third.getNodeRun('e5-fresh-node-run').outputRefs;
      assert.equal(freshRefs.length, 1);
      const freshAsset = third.getAsset(freshRefs[0]);
      assert.equal(freshAsset.provenance.runId, 'e5-fresh-run');
      assert.equal(freshAsset.provenance.nodeRunId, 'e5-fresh-node-run');
      assert.equal(freshAsset.provenance.attemptId, 'e5-fresh-attempt');
      assert.equal(third.listAssets({ projectId: 'project-e5-run-isolation', limit: 100 }).length, 1);
      assert.equal(third.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(third.db.pragma('foreign_key_check'), []);
    } finally {
      third.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
