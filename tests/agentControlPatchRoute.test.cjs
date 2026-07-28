'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createAgentControlAuthService } = require('../backend/src/services/agentControlAuth.js');
const { createAgentControlApprovalService } = require('../backend/src/services/agentControlApprovals.js');
const agentControlRoute = require('../backend/src/routes/agentControl.js');

function request(server, options = {}, body = null) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      method: options.method || 'GET',
      path: options.path || '/',
      headers: {
        Host: '127.0.0.1:19020',
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: text ? JSON.parse(text) : null,
      }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function issueSession(auth, scopes, name) {
  const pairing = auth.createPairing({
    clientName: name,
    agentKind: 'codex',
    requestedScopes: scopes,
  });
  auth.approvePairing({
    pairingId: pairing.pairingId,
    userCode: pairing.userCode,
    approvedScopes: scopes,
  });
  return auth.pollPairing({
    pairingId: pairing.pairingId,
    pollSecret: pairing.pollSecret,
  });
}

function patch(id, revision = 4) {
  return {
    schema: 't8-canvas-patch-v1',
    id,
    baseRevision: revision,
    summary: '把标题改成安全的新标题',
    diagnosticsResolved: [],
    requiresConfirmation: true,
    operations: [{
      type: 'node.patch',
      payload: {
        nodeId: 'text-a',
        dataPatch: { text: '公开的新标题' },
      },
    }],
  };
}

test('agent patch route requires exact approval, commits once, mirrors, notifies and redacts', async (t) => {
  const auth = createAgentControlAuthService();
  const approvals = createAgentControlApprovalService();
  const mutationEvents = [];
  approvals.subscribeMutations((event) => mutationEvents.push(event));
  const document = {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: 'project-local',
    canvasId: 'canvas-a',
    revision: 4,
    nodes: [{ id: 'text-a', type: 'text', position: { x: 0, y: 0 }, data: { text: 'private prompt' } }],
    edges: [],
  };
  let previewPatch = null;
  let applyCalls = 0;
  let mirrorCalls = 0;
  let applyError = null;
  const database = {
    getCanvas: (canvasId) => canvasId === 'canvas-a' ? structuredClone(document) : null,
    previewCanvasPatch: (_canvasId, scopedPatch, context) => {
      previewPatch = structuredClone(scopedPatch);
      assert.equal(context.actorId.startsWith('agent:'), true);
      assert.equal(context.authority.source, 'agent');
      return {
        patchId: scopedPatch.id,
        summary: scopedPatch.summary,
        baseRevision: 4,
        currentRevision: 4,
        previewDigest: 'a'.repeat(64),
        affectedNodeIds: ['text-a'],
        affectedEdgeIds: [],
        changes: [{ operationIndex: 0, type: 'node.patch', targetType: 'node', targetId: 'text-a', fields: ['data.text'] }],
      };
    },
    applyCanvasPatch: (_canvasId, scopedPatch, context) => {
      applyCalls += 1;
      if (applyError) throw applyError;
      assert.equal(context.confirmed, true);
      assert.equal(context.previewDigest, 'a'.repeat(64));
      assert.equal(context.authority.source, 'agent');
      document.revision += 1;
      document.nodes[0].data.text = '公开的新标题';
      return {
        patchId: scopedPatch.id,
        status: 'applied',
        duplicate: false,
        baseRevision: 4,
        revision: document.revision,
        acknowledgements: [{ opId: 'op-a', revision: document.revision }],
        document: structuredClone(document),
      };
    },
    listCanvasPatches: () => [],
  };
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/agent-control/v1', agentControlRoute.createAgentControlRouter({
    auth,
    approvals,
    config: {
      PORT: 19020,
      APP_VERSION: '2.6.4',
      BACKEND_INSTANCE_ID: 'a'.repeat(43),
    },
    database,
    mirrorWriter: (_canvasId, committedDocument) => {
      mirrorCalls += 1;
      assert.equal(committedDocument.revision, 5);
      return [];
    },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const writer = issueSession(auth, ['canvas:read', 'canvas:write'], 'Codex writer');
  const otherWriter = issueSession(auth, ['canvas:read', 'canvas:write'], 'Other writer');
  const reader = issueSession(auth, ['canvas:read'], 'Codex reader');
  const writerHeaders = { Authorization: `Bearer ${writer.accessToken}` };

  const readOnlyRejected = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/patch-approvals',
    headers: { Authorization: `Bearer ${reader.accessToken}` },
  }, { projectId: 'project-local', canvasId: 'canvas-a', patch: patch('patch-read-only') });
  assert.equal(readOnlyRejected.status, 403);
  assert.equal(readOnlyRejected.body.code, 'AUTH_SCOPE_FORBIDDEN');

  const created = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/patch-approvals',
    headers: writerHeaders,
  }, { projectId: 'project-local', canvasId: 'canvas-a', patch: patch('patch-a') });
  assert.equal(created.status, 202);
  assert.match(created.body.data.pollSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(previewPatch.operations[0].projectId, 'project-local');
  assert.equal(previewPatch.operations[0].canvasId, 'canvas-a');
  assert.equal(previewPatch.operations[0].actorId.startsWith('agent:'), true);
  assert.equal(previewPatch.operations[0].sessionId, writer.sessionId);

  const mismatchedSession = await request(server, {
    method: 'POST',
    path: `/api/agent-control/v1/patch-approvals/${created.body.data.approvalRequestId}/complete`,
    headers: { Authorization: `Bearer ${otherWriter.accessToken}` },
  }, { pollSecret: created.body.data.pollSecret });
  assert.equal(mismatchedSession.status, 403);
  assert.equal(mismatchedSession.body.code, 'APPROVAL_SESSION_MISMATCH');

  const pending = await request(server, {
    method: 'POST',
    path: `/api/agent-control/v1/patch-approvals/${created.body.data.approvalRequestId}/complete`,
    headers: writerHeaders,
  }, { pollSecret: created.body.data.pollSecret });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.data.status, 'pending');
  assert.equal(applyCalls, 0);

  approvals.approve(created.body.data.approvalRequestId);
  const completed = await request(server, {
    method: 'POST',
    path: `/api/agent-control/v1/patch-approvals/${created.body.data.approvalRequestId}/complete`,
    headers: writerHeaders,
  }, { pollSecret: created.body.data.pollSecret });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.data.revision, 5);
  assert.equal(completed.body.data.acknowledgementCount, 1);
  assert.equal(applyCalls, 1);
  assert.equal(mirrorCalls, 1);
  assert.equal(mutationEvents.length, 1);
  assert.deepEqual(
    {
      canvasId: mutationEvents[0].canvasId,
      patchId: mutationEvents[0].patchId,
      revision: mutationEvents[0].revision,
    },
    { canvasId: 'canvas-a', patchId: 'patch-a', revision: 5 },
  );
  assert.equal(JSON.stringify(completed.body).includes('private prompt'), false);
  assert.equal(JSON.stringify(completed.body).includes('"document"'), false);

  const duplicateCompletion = await request(server, {
    method: 'POST',
    path: `/api/agent-control/v1/patch-approvals/${created.body.data.approvalRequestId}/complete`,
    headers: writerHeaders,
  }, { pollSecret: created.body.data.pollSecret });
  assert.equal(duplicateCompletion.status, 404);
  assert.equal(duplicateCompletion.body.code, 'APPROVAL_NOT_FOUND');
  assert.equal(applyCalls, 1);

  const conflicting = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/patch-approvals',
    headers: writerHeaders,
  }, { projectId: 'project-local', canvasId: 'canvas-a', patch: patch('patch-conflict', 5) });
  approvals.approve(conflicting.body.data.approvalRequestId);
  applyError = Object.assign(new Error('Canvas revision conflict'), {
    code: 'canvas_patch_revision_conflict',
    currentRevision: 7,
  });
  const conflict = await request(server, {
    method: 'POST',
    path: `/api/agent-control/v1/patch-approvals/${conflicting.body.data.approvalRequestId}/complete`,
    headers: writerHeaders,
  }, { pollSecret: conflicting.body.data.pollSecret });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'canvas_patch_revision_conflict');
  assert.equal(conflict.body.currentRevision, 7);
  assert.equal(mutationEvents.length, 1);
});

test('a re-paired writer can request an approved revert of an earlier Agent patch', async (t) => {
  const auth = createAgentControlAuthService();
  const approvals = createAgentControlApprovalService();
  const document = {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    revision: 6,
  };
  const originalActorId = 'agent:expired-session';
  let revertContext = null;
  const database = {
    getCanvas: (canvasId) => canvasId === 'canvas-a' ? structuredClone(document) : null,
    listCanvasPatches: (_canvasId, options) => {
      assert.equal(options.projectId, 'project-local');
      assert.equal(options.includeAllActors, true);
      return [{
        patchId: 'patch-from-earlier-pairing',
        summary: '创建隔离验收链路',
        appliedRevision: 6,
        operationCount: 5,
        actorId: originalActorId,
        canRevert: true,
      }];
    },
    revertCanvasPatch: (_canvasId, patchId, context) => {
      assert.equal(patchId, 'patch-from-earlier-pairing');
      revertContext = structuredClone(context);
      document.revision += 5;
      return {
        patchId,
        status: 'reverted',
        duplicate: false,
        revision: document.revision,
        document: structuredClone(document),
      };
    },
  };
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/agent-control/v1', agentControlRoute.createAgentControlRouter({
    auth,
    approvals,
    config: {
      PORT: 19020,
      APP_VERSION: '2.6.5',
      BACKEND_INSTANCE_ID: 'a'.repeat(43),
    },
    database,
    mirrorWriter: () => [],
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const resumedWriter = issueSession(auth, ['canvas:read', 'canvas:write'], 'Codex writer');
  const headers = { Authorization: `Bearer ${resumedWriter.accessToken}` };
  const created = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/patch-revert-approvals',
    headers,
  }, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    patchId: 'patch-from-earlier-pairing',
  });
  assert.equal(created.status, 202);
  assert.equal(created.body.data.preview.appliedRevision, 6);

  approvals.approve(created.body.data.approvalRequestId);
  const completed = await request(server, {
    method: 'POST',
    path: `/api/agent-control/v1/patch-approvals/${created.body.data.approvalRequestId}/complete`,
    headers,
  }, { pollSecret: created.body.data.pollSecret });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.data.revision, 11);
  assert.equal(revertContext.actorId, `agent:${resumedWriter.sessionId}`);
  assert.equal(revertContext.patchOwnerActorId, originalActorId);
  assert.equal(revertContext.projectId, 'project-local');
  assert.equal(revertContext.expectedRevision, 6);
});
