const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const { capabilitiesForRole, hashSecret } = require('../backend/src/collaboration/auth');
const { CollaborationGateway } = require('../backend/src/collaboration/gateway');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function redeem(baseUrl, gateway, role, displayName) {
  const invite = gateway.auth.createInvite({ projectId: 'project-local', role, maxUses: 1 });
  const response = await fetch(`${baseUrl}/api/collab/invites/redeem`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, displayName }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
  return { cookie, payload: payload.data, session: gateway.auth.authenticate(token) };
}

async function redeemOwner(baseUrl, gateway, database, displayName) {
  const code = `owner-${crypto.randomBytes(18).toString('base64url')}`;
  const now = Date.now();
  database.createInvite({
    id: crypto.randomUUID(),
    projectId: 'project-local',
    codeHash: hashSecret(code),
    role: 'owner',
    capabilities: capabilitiesForRole('owner'),
    expiresAt: now + 60_000,
    maxUses: 1,
    createdAt: now,
    createdBy: 'local-owner',
    sessionId: 'local-session',
  });
  const response = await fetch(`${baseUrl}/api/collab/invites/redeem`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, displayName }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
  return { cookie, payload: payload.data, session: gateway.auth.authenticate(token) };
}

async function openJoinedSocket(status, cookie, canvasId = 'canvas-a') {
  const socket = new WebSocket(`ws://127.0.0.1:${status.port}/ws/collab`, {
    origin: `http://127.0.0.1:${status.port}`,
    headers: { cookie },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('patch websocket did not join')), 3000);
    socket.once('error', reject);
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'session.ready') socket.send(JSON.stringify({ type: 'canvas.join', canvasId }));
      if (message.type !== 'canvas.joined') return;
      clearTimeout(timer);
      resolve();
    });
  });
  return socket;
}

function waitForMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} broadcast timed out`)), 3000);
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

test('collaboration patch routes enforce role, scope identity, safe broadcasts, and conflict errors', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-collab-canvas-patch-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const database = new ProjectDatabase(':memory:');
  database.ensureCanvas('canvas-a', {
    projectId: 'project-local',
    nodes: [{ id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: { text: 'hello' } }],
    edges: [],
  });
  const calls = [];
  const appliedDocument = { ...database.getCanvas('canvas-a'), revision: 2, updatedAt: 20 };
  const revertedDocument = { ...database.getCanvas('canvas-a'), revision: 3, updatedAt: 30 };
  database.previewCanvasPatch = (canvasId, patch, options) => {
    calls.push({ method: 'preview', canvasId, patch: clone(patch), options: clone(options) });
    const unknown = Object.keys(patch).filter((key) => ![
      'schema', 'id', 'baseRevision', 'summary', 'operations', 'diagnosticsResolved', 'requiresConfirmation',
    ].includes(key));
    if (unknown.length) {
      throw Object.assign(new Error(`未知 CanvasPatch 字段: ${unknown.join(', ')}`), { code: 'canvas_patch_invalid' });
    }
    if (patch.id === 'leaky') {
      throw Object.assign(new Error('node D:\\private\\input.png /var/private/input.png D%3A%5Cprivate%5Cencoded-user%5Cinput.png %252Fvar%252Fprivate%252Fencoded-user%252Finput.png sk-test-secret-123456 ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA eyJAAAAAA.BBBBBBBB.CCCCCCCC token=super-secret-value data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), { code: 'canvas_patch_invalid' });
    }
    return {
      patchId: patch.id,
      baseRevision: patch.baseRevision,
      currentRevision: 1,
      previewDigest: 'preview-digest',
      summary: patch.summary,
      diagnosticsResolved: patch.diagnosticsResolved,
      affectedNodeIds: ['node-a'],
      affectedEdgeIds: [],
      changes: [{ before: 'raw-preview-only' }],
      warnings: [],
    };
  };
  database.applyCanvasPatch = (canvasId, patch, options) => {
    calls.push({ method: 'apply', canvasId, patch: clone(patch), options: clone(options) });
    if (patch.id === 'conflict') {
      throw Object.assign(new Error('Patch revision 已变化'), { code: 'canvas_patch_revision_conflict', currentRevision: 8 });
    }
    return { patchId: patch.id, status: 'applied', revision: 2, document: clone(appliedDocument), diff: { raw: 'must-not-broadcast' } };
  };
  database.listCanvasPatches = (canvasId, options) => {
    calls.push({ method: 'list', canvasId, options: clone(options) });
    return [{
      patchId: 'patch-1', summary: '修复坐标', diagnosticsResolved: ['layout.invalid-position'],
      baseRevision: 1, appliedRevision: 2, revertedRevision: null,
      actorId: options.actorId, status: 'applied', operationCount: 1,
      createdAt: 20, revertedAt: null, canRevert: true,
    }];
  };
  database.revertCanvasPatch = (canvasId, patchId, options) => {
    calls.push({ method: 'revert', canvasId, patchId, options: clone(options) });
    if (patchId === 'missing') throw Object.assign(new Error('Patch 不存在'), { code: 'canvas_patch_not_found' });
    return { patchId, status: 'reverted', revision: 3, document: clone(revertedDocument), inverseOperations: [{ secret: 'must-not-broadcast' }] };
  };

  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1', COLLAB_PORT: 0, FRONTEND_DIST: '', INPUT_DIR: input, OUTPUT_DIR: output,
  }, database);
  let socket;
  try {
    const status = await gateway.start({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}`;
    const viewer = await redeem(baseUrl, gateway, 'reviewer', 'Patch Reviewer');
    const editor = await redeem(baseUrl, gateway, 'editor', 'Patch Editor');
    socket = await openJoinedSocket(status, editor.cookie);

    const maliciousPatch = {
      schema: 't8-canvas-patch-v1',
      id: 'patch-1', baseRevision: 1, summary: '修复坐标', diagnosticsResolved: ['layout.invalid-position'], requiresConfirmation: true,
      projectId: 'project-evil', canvasId: 'canvas-evil', actorId: 'actor-evil', sessionId: 'session-evil',
      operations: [{
        opId: 'patch-1:0', projectId: 'project-evil', canvasId: 'canvas-evil', actorId: 'actor-evil', sessionId: 'session-evil',
        clientSeq: 1, timestamp: 1, baseRevision: 1, type: 'node.move', payload: { nodeId: 'node-a', position: { x: 80, y: 80 } },
      }],
    };

    const viewerPreview = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/patches/preview`, {
      method: 'POST', headers: { cookie: viewer.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ patch: maliciousPatch }),
    });
    assert.equal(viewerPreview.status, 200, await viewerPreview.text());
    const previewCall = calls.find((entry) => entry.method === 'preview');
    assert.deepEqual(previewCall.options, {
      actorId: viewer.session.memberId, sessionId: viewer.session.id, projectId: 'project-local',
      authority: {
        source: 'collaboration', role: 'reviewer', capabilities: viewer.session.capabilities,
      },
    });
    assert.deepEqual(Object.keys(previewCall.patch).sort(), [
      'baseRevision', 'diagnosticsResolved', 'id', 'operations', 'requiresConfirmation', 'schema', 'summary',
    ]);
    for (const key of ['projectId', 'canvasId', 'actorId', 'sessionId']) assert.equal(Object.hasOwn(previewCall.patch, key), false);
    assert.equal(previewCall.patch.operations[0].actorId, viewer.session.memberId);
    assert.equal(previewCall.patch.operations[0].sessionId, viewer.session.id);
    assert.equal(previewCall.patch.operations[0].projectId, 'project-local');
    assert.equal(previewCall.patch.operations[0].canvasId, 'canvas-a');

    const unknownFieldResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/patches/preview`, {
      method: 'POST', headers: { cookie: viewer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { ...maliciousPatch, unknownTopLevel: true } }),
    });
    assert.equal(unknownFieldResponse.status, 400);
    assert.equal((await unknownFieldResponse.json()).code, 'canvas_patch_invalid');

    const leakyResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/patches/preview`, {
      method: 'POST', headers: { cookie: viewer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { ...maliciousPatch, id: 'leaky' } }),
    });
    assert.equal(leakyResponse.status, 400);
    const leakyPayload = await leakyResponse.json();
    assert.equal(leakyPayload.code, 'canvas_patch_invalid');
    assert.doesNotMatch(JSON.stringify(leakyPayload), /private|encoded-user|%3A|%5C|%2Fvar|sk-test|ghp_|eyJAAAAAA|super-secret|AAAAAA/i);
    assert.match(leakyPayload.error, /\[(?:local-path|redacted|binary)\]/);

    const viewerList = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/patches?limit=3`, { headers: { cookie: viewer.cookie } });
    assert.equal(viewerList.status, 200);
    assert.deepEqual(calls.find((entry) => entry.method === 'list').options, { actorId: viewer.session.memberId, limit: 3 });

    const viewerApply = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/patches`, {
      method: 'POST', headers: { cookie: viewer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: maliciousPatch, previewDigest: 'preview-digest', confirmed: true }),
    });
    assert.equal(viewerApply.status, 403);

    const applyBroadcast = waitForMessage(socket, 'canvas.patch');
    const editorApply = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/patches`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: maliciousPatch, previewDigest: 'preview-digest', confirmed: true, actorId: 'body-actor' }),
    });
    assert.equal(editorApply.status, 200, await editorApply.text());
    const applyCall = calls.find((entry) => entry.method === 'apply');
    assert.deepEqual(applyCall.options, {
      previewDigest: 'preview-digest', confirmed: true,
      actorId: editor.session.memberId, sessionId: editor.session.id, projectId: 'project-local',
      authority: {
        source: 'collaboration', role: 'editor', capabilities: editor.session.capabilities,
      },
    });
    assert.equal(applyCall.patch.operations[0].actorId, editor.session.memberId);
    assert.equal(applyCall.patch.operations[0].sessionId, editor.session.id);
    const appliedMessage = await applyBroadcast;
    assert.deepEqual(Object.keys(appliedMessage).sort(), ['actor', 'patchId', 'revision', 'status', 'timestamp', 'type']);
    assert.ok(Number.isSafeInteger(appliedMessage.timestamp));
    const { timestamp: _appliedTimestamp, ...appliedPayload } = appliedMessage;
    assert.deepEqual(appliedPayload, {
      type: 'canvas.patch', patchId: 'patch-1', revision: 2, status: 'applied', actor: editor.session.memberId,
    });

    const viewerRevert = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/patches/patch-1/revert`, {
      method: 'POST', headers: { cookie: viewer.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 2 }),
    });
    assert.equal(viewerRevert.status, 403);

    const revertBroadcast = waitForMessage(socket, 'canvas.patch');
    const editorRevert = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/patches/patch-1/revert`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: 2, actorId: 'body-actor', sessionId: 'body-session', projectId: 'project-evil' }),
    });
    assert.equal(editorRevert.status, 200, await editorRevert.text());
    assert.deepEqual(calls.find((entry) => entry.method === 'revert').options, {
      expectedRevision: 2, actorId: editor.session.memberId, sessionId: editor.session.id, projectId: 'project-local',
    });
    const revertedMessage = await revertBroadcast;
    assert.ok(Number.isSafeInteger(revertedMessage.timestamp));
    const { timestamp: _revertedTimestamp, ...revertedPayload } = revertedMessage;
    assert.deepEqual(revertedPayload, {
      type: 'canvas.patch', patchId: 'patch-1', revision: 3, status: 'reverted', actor: editor.session.memberId,
    });

    const conflictResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/patches`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { ...maliciousPatch, id: 'conflict' }, previewDigest: 'old', confirmed: true }),
    });
    assert.equal(conflictResponse.status, 409);
    assert.deepEqual(await conflictResponse.json(), {
      success: false, code: 'canvas_patch_revision_conflict', error: 'Patch revision 已变化', currentRevision: 8,
    });

    const missingResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-a/patches/missing/revert`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 3 }),
    });
    assert.equal(missingResponse.status, 404);
    assert.equal((await missingResponse.json()).code, 'canvas_patch_not_found');

    const missingCanvas = await fetch(`${baseUrl}/api/collab/canvases/not-found/patches/preview`, {
      method: 'POST', headers: { cookie: viewer.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ patch: maliciousPatch }),
    });
    assert.equal(missingCanvas.status, 404);
  } finally {
    socket?.close();
    await gateway.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('collaboration patch routes complete a real SQLite lifecycle with reviewer and actor isolation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-collab-canvas-patch-real-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const database = new ProjectDatabase(':memory:');
  database.ensureCanvas('canvas-real', {
    nodes: [{ id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: { text: 'before' } }],
    edges: [],
  }, 'project-local');
  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1', COLLAB_PORT: 0, FRONTEND_DIST: '', INPUT_DIR: input, OUTPUT_DIR: output,
  }, database);
  let socket;
  try {
    const status = await gateway.start({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}`;
    const reviewer = await redeem(baseUrl, gateway, 'reviewer', 'Real Patch Reviewer');
    const editor = await redeem(baseUrl, gateway, 'editor', 'Real Patch Editor');

    const reviewerPatch = {
      schema: 't8-canvas-patch-v1',
      id: 'real-reviewer-preview',
      baseRevision: 1,
      summary: 'reviewer 只读预览',
      diagnosticsResolved: ['content.empty-text'],
      requiresConfirmation: true,
      operations: [{
        opId: 'reviewer-forged-op', actorId: 'forged', sessionId: 'forged',
        projectId: 'forged', canvasId: 'forged', clientSeq: 1, timestamp: 1,
        type: 'node.patch', payload: { nodeId: 'node-a', dataPatch: { text: 'review-only' } },
      }],
    };
    const reviewerPreviewResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-real/patches/preview`, {
      method: 'POST', headers: { cookie: reviewer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: reviewerPatch }),
    });
    const reviewerPreviewPayload = await reviewerPreviewResponse.json();
    assert.equal(reviewerPreviewResponse.status, 200, JSON.stringify(reviewerPreviewPayload));
    assert.equal(reviewerPreviewPayload.data.currentRevision, 1);
    const reviewerListResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-real/patches`, {
      headers: { cookie: reviewer.cookie },
    });
    assert.equal(reviewerListResponse.status, 200);
    assert.deepEqual((await reviewerListResponse.json()).data, []);
    const reviewerApplyResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-real/patches`, {
      method: 'POST', headers: { cookie: reviewer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        patch: reviewerPatch,
        previewDigest: reviewerPreviewPayload.data.previewDigest,
        confirmed: true,
      }),
    });
    assert.equal(reviewerApplyResponse.status, 403);
    const reviewerRevertResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-real/patches/${reviewerPatch.id}/revert`, {
      method: 'POST', headers: { cookie: reviewer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: 1 }),
    });
    assert.equal(reviewerRevertResponse.status, 403);

    const strictResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-real/patches/preview`, {
      method: 'POST', headers: { cookie: reviewer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { ...reviewerPatch, id: 'real-reviewer-unknown', unknownTopLevel: true } }),
    });
    const strictPayload = await strictResponse.json();
    assert.equal(strictResponse.status, 400, JSON.stringify(strictPayload));
    assert.equal(strictPayload.code, 'canvas_patch_invalid');

    socket = await openJoinedSocket(status, editor.cookie, 'canvas-real');
    const canvasPatchMessages = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'canvas.patch') canvasPatchMessages.push(message);
    });
    const editorPatch = {
      ...reviewerPatch,
      id: 'real-editor-patch',
      summary: 'editor 真实应用',
      projectId: 'forged-project',
      canvasId: 'forged-canvas',
      actorId: 'forged-actor',
      sessionId: 'forged-session',
      operations: [{
        ...reviewerPatch.operations[0],
        opId: 'editor-forged-op',
        payload: { nodeId: 'node-a', dataPatch: { text: 'after' } },
      }],
    };
    const editorPreviewResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-real/patches/preview`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: editorPatch }),
    });
    const editorPreviewPayload = await editorPreviewResponse.json();
    assert.equal(editorPreviewResponse.status, 200, JSON.stringify(editorPreviewPayload));

    const applyBroadcast = waitForMessage(socket, 'canvas.patch');
    const editorApplyResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-real/patches`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        patch: editorPatch,
        previewDigest: editorPreviewPayload.data.previewDigest,
        confirmed: true,
      }),
    });
    const editorApplyPayload = await editorApplyResponse.json();
    assert.equal(editorApplyResponse.status, 200, JSON.stringify(editorApplyPayload));
    assert.equal(editorApplyPayload.data.patchId, editorPatch.id);
    assert.equal(editorApplyPayload.data.revision, 2);
    assert.equal(editorApplyPayload.data.document.nodes[0].data.text, 'after');

    const operation = database.db.prepare(`
      SELECT op_id, project_id, canvas_id, actor_id, session_id, revision
      FROM canvas_operations WHERE canvas_id = ? AND revision = 2
    `).get('canvas-real');
    assert.deepEqual({
      projectId: operation.project_id,
      canvasId: operation.canvas_id,
      actorId: operation.actor_id,
      sessionId: operation.session_id,
      revision: operation.revision,
    }, {
      projectId: 'project-local', canvasId: 'canvas-real',
      actorId: editor.session.memberId, sessionId: editor.session.id, revision: 2,
    });
    assert.notEqual(operation.op_id, 'editor-forged-op');
    const appliedMessage = await applyBroadcast;
    assert.deepEqual(Object.keys(appliedMessage).sort(), ['actor', 'patchId', 'revision', 'status', 'timestamp', 'type']);
    assert.deepEqual({
      type: appliedMessage.type,
      patchId: appliedMessage.patchId,
      revision: appliedMessage.revision,
      status: appliedMessage.status,
      actor: appliedMessage.actor,
    }, {
      type: 'canvas.patch', patchId: editorPatch.id, revision: 2,
      status: 'applied', actor: editor.session.memberId,
    });
    assert.doesNotMatch(JSON.stringify(appliedMessage), /operations|changes|inverse|session|payload|after/);
    assert.equal(canvasPatchMessages.length, 1);

    const duplicateApplyResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-real/patches`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        patch: editorPatch,
        previewDigest: editorPreviewPayload.data.previewDigest,
        confirmed: true,
      }),
    });
    const duplicateApplyPayload = await duplicateApplyResponse.json();
    assert.equal(duplicateApplyResponse.status, 200, JSON.stringify(duplicateApplyPayload));
    assert.equal(duplicateApplyPayload.data.duplicate, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(canvasPatchMessages.length, 1, 'an exact apply retry must not broadcast twice');

    const editorListResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-real/patches`, {
      headers: { cookie: editor.cookie },
    });
    const editorListPayload = await editorListResponse.json();
    assert.equal(editorListResponse.status, 200, JSON.stringify(editorListPayload));
    assert.equal(editorListPayload.data.length, 1);
    assert.equal(editorListPayload.data[0].actorId, editor.session.memberId);
    assert.equal(editorListPayload.data[0].canRevert, true);
    assert.doesNotMatch(JSON.stringify(editorListPayload), /forged-session|forward_ops|inverse_ops|payload_json/);
    const isolatedReviewerList = await fetch(`${baseUrl}/api/collab/canvases/canvas-real/patches`, {
      headers: { cookie: reviewer.cookie },
    });
    assert.deepEqual((await isolatedReviewerList.json()).data, []);

    const revertBroadcast = waitForMessage(socket, 'canvas.patch');
    const editorRevertResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-real/patches/${editorPatch.id}/revert`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: 2, actorId: 'forged-actor', sessionId: 'forged-session' }),
    });
    const editorRevertPayload = await editorRevertResponse.json();
    assert.equal(editorRevertResponse.status, 200, JSON.stringify(editorRevertPayload));
    assert.equal(editorRevertPayload.data.revision, 3);
    assert.equal(editorRevertPayload.data.document.nodes[0].data.text, 'before');
    const revertedMessage = await revertBroadcast;
    assert.deepEqual(Object.keys(revertedMessage).sort(), ['actor', 'patchId', 'revision', 'status', 'timestamp', 'type']);
    assert.equal(revertedMessage.patchId, editorPatch.id);
    assert.equal(revertedMessage.revision, 3);
    assert.equal(revertedMessage.status, 'reverted');
    assert.equal(revertedMessage.actor, editor.session.memberId);
    assert.doesNotMatch(JSON.stringify(revertedMessage), /operations|changes|inverse|session|payload|before/);
    assert.equal(canvasPatchMessages.length, 2);

    const duplicateRevertResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-real/patches/${editorPatch.id}/revert`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: 2, actorId: 'forged-actor', sessionId: 'forged-session' }),
    });
    const duplicateRevertPayload = await duplicateRevertResponse.json();
    assert.equal(duplicateRevertResponse.status, 200, JSON.stringify(duplicateRevertPayload));
    assert.equal(duplicateRevertPayload.data.duplicate, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(canvasPatchMessages.length, 2, 'an exact revert retry must not broadcast twice');

    const auditApply = database.listAuditEvents({
      projectId: 'project-local', canvasId: 'canvas-real', action: 'canvas.patch.apply',
    });
    const auditRevert = database.listAuditEvents({
      projectId: 'project-local', canvasId: 'canvas-real', action: 'canvas.patch.revert',
    });
    assert.equal(auditApply.length, 1);
    assert.equal(auditRevert.length, 1);
    assert.equal(auditApply[0].actorId, editor.session.memberId);
    assert.equal(auditRevert[0].actorId, editor.session.memberId);
  } finally {
    socket?.close();
    await gateway.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('gateway credential boundary keeps reviewer advisory, editor graph-only, and owner provider-authorized', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-collab-patch-credential-authority-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const database = new ProjectDatabase(':memory:');
  database.ensureCanvas('canvas-credential-authority', {
    projectId: 'project-local',
    nodes: [{ id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: { prompt: 'before' } }],
    edges: [],
  });
  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1', COLLAB_PORT: 0, FRONTEND_DIST: '', INPUT_DIR: input, OUTPUT_DIR: output,
  }, database);
  try {
    const status = await gateway.start({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}`;
    const reviewer = await redeem(baseUrl, gateway, 'reviewer', 'Credential Reviewer');
    const editor = await redeem(baseUrl, gateway, 'editor', 'Credential Editor');
    const owner = await redeemOwner(baseUrl, gateway, database, 'Credential Owner');
    assert.equal(reviewer.session.role, 'reviewer');
    assert.equal(editor.session.role, 'editor');
    assert.equal(owner.session.role, 'owner');
    assert.equal(owner.session.capabilities.includes('manageProviders'), true);

    const normalPatch = {
      schema: 't8-canvas-patch-v1',
      id: 'credential-role-normal-prompt',
      baseRevision: 1,
      summary: '普通 Prompt 修改',
      diagnosticsResolved: ['content.empty-text'],
      requiresConfirmation: true,
      operations: [{ type: 'node.patch', payload: { nodeId: 'node-a', dataPatch: { prompt: 'ordinary edit', maxTokens: 512 } } }],
    };
    const reviewerPreviewResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-credential-authority/patches/preview`, {
      method: 'POST', headers: { cookie: reviewer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: normalPatch }),
    });
    const reviewerPreview = await reviewerPreviewResponse.json();
    assert.equal(reviewerPreviewResponse.status, 200, JSON.stringify(reviewerPreview));
    const reviewerApplyResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-credential-authority/patches`, {
      method: 'POST', headers: { cookie: reviewer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: normalPatch, previewDigest: reviewerPreview.data.previewDigest, confirmed: true }),
    });
    assert.equal(reviewerApplyResponse.status, 403);

    const editorPreviewResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-credential-authority/patches/preview`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: normalPatch }),
    });
    const editorPreview = await editorPreviewResponse.json();
    assert.equal(editorPreviewResponse.status, 200, JSON.stringify(editorPreview));
    const editorApplyResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-credential-authority/patches`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: normalPatch, previewDigest: editorPreview.data.previewDigest, confirmed: true }),
    });
    const editorApply = await editorApplyResponse.json();
    assert.equal(editorApplyResponse.status, 200, JSON.stringify(editorApply));
    assert.equal(editorApply.data.document.nodes[0].data.prompt, 'ordinary edit');
    assert.equal(editorApply.data.revision, 2);

    const sensitiveEditorPatch = {
      ...normalPatch,
      id: 'credential-role-editor-sensitive',
      baseRevision: 2,
      summary: '受限配置修改',
      operations: [{
        type: 'node.patch',
        payload: { nodeId: 'node-a', dataPatch: { provider: { credentials: { 'a%70i%4Bey': 'editor-private-value' } } } },
      }],
    };
    const sensitiveEditorPreviewResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-credential-authority/patches/preview`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: sensitiveEditorPatch }),
    });
    const sensitiveEditorPreview = await sensitiveEditorPreviewResponse.json();
    assert.equal(sensitiveEditorPreviewResponse.status, 403, JSON.stringify(sensitiveEditorPreview));
    assert.equal(sensitiveEditorPreview.code, 'canvas_patch_host_credentials_forbidden');
    assert.doesNotMatch(JSON.stringify(sensitiveEditorPreview), /a%70|api.?key|editor-private-value/i);
    const sensitiveEditorApplyResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-credential-authority/patches`, {
      method: 'POST', headers: { cookie: editor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: sensitiveEditorPatch, previewDigest: 'a'.repeat(64), confirmed: true }),
    });
    const sensitiveEditorApply = await sensitiveEditorApplyResponse.json();
    assert.equal(sensitiveEditorApplyResponse.status, 403, JSON.stringify(sensitiveEditorApply));
    assert.equal(sensitiveEditorApply.code, 'canvas_patch_host_credentials_forbidden');
    assert.doesNotMatch(JSON.stringify(sensitiveEditorApply), /a%70|api.?key|editor-private-value/i);
    assert.equal(database.getCanvas('canvas-credential-authority').revision, 2);

    const ownerPatch = {
      ...normalPatch,
      id: 'credential-role-owner-sensitive',
      baseRevision: 2,
      summary: '主机 owner 更新凭据',
      operations: [{ type: 'node.patch', payload: { nodeId: 'node-a', dataPatch: { apiKey: 'owner-private-value' } } }],
    };
    const ownerPreviewResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-credential-authority/patches/preview`, {
      method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: ownerPatch }),
    });
    const ownerPreview = await ownerPreviewResponse.json();
    assert.equal(ownerPreviewResponse.status, 200, JSON.stringify(ownerPreview));
    assert.doesNotMatch(JSON.stringify(ownerPreview), /owner-private-value/i);
    assert.equal(ownerPreview.data.changes[0].after['data.apiKey'], '[redacted]');
    const ownerApplyResponse = await fetch(`${baseUrl}/api/collab/canvases/canvas-credential-authority/patches`, {
      method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: ownerPatch, previewDigest: ownerPreview.data.previewDigest, confirmed: true }),
    });
    const ownerApply = await ownerApplyResponse.json();
    assert.equal(ownerApplyResponse.status, 200, JSON.stringify(ownerApply));
    assert.equal(ownerApply.data.revision, 3);
    assert.equal(database.getCanvas('canvas-credential-authority').nodes[0].data.apiKey, 'owner-private-value');

    const audit = database.listAuditEvents({
      projectId: 'project-local', canvasId: 'canvas-credential-authority', action: 'canvas.patch.apply',
    });
    assert.equal(audit.length, 2);
    assert.doesNotMatch(JSON.stringify(audit), /editor-private-value|owner-private-value|a%70/i);
  } finally {
    await gateway.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
