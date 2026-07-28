'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createAgentControlAuthService } = require('../backend/src/services/agentControlAuth.js');
const agentControlRoute = require('../backend/src/routes/agentControl.js');
const { createCreatorAgentRouter } = require('../backend/src/routes/creatorAgent.js');
const {
  createCreatorAgentSessionStore,
} = require('../backend/src/services/creatorAgentSessions.js');

function issueReader(auth) {
  const pairing = auth.createPairing({
    clientName: 'Codex shared creator session',
    agentKind: 'codex',
    requestedScopes: ['canvas:read'],
  });
  auth.approvePairing({
    pairingId: pairing.pairingId,
    userCode: pairing.userCode,
    approvedScopes: ['canvas:read'],
  });
  return auth.pollPairing({
    pairingId: pairing.pairingId,
    pollSecret: pairing.pollSecret,
  });
}

function request(server, route, options = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : '';
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      method: options.method || 'GET',
      path: route,
      headers: {
        Host: '127.0.0.1:19033',
        Accept: 'application/json',
        ...(body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        } : {}),
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
    if (body) req.write(body);
    req.end();
  });
}

test('zcanvas sync is visible to the canvas Agent as the same idempotent Creator Session', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-agent-control-creator-session-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const auth = createAgentControlAuthService();
  const reader = issueReader(auth);
  const sessions = createCreatorAgentSessionStore({ rootDir });
  const document = {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: 'project-local',
    canvasId: 'canvas-shared',
    revision: 31,
    nodes: [{
      id: 'node-image-reference',
      type: 'image',
      data: {
        label: '角色参考',
        prompt: 'private prompt must never enter the Creator Session',
      },
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const patch = {
    schema: 't8-canvas-patch-v1',
    id: 'patch-shared',
    baseRevision: 31,
    summary: '从一句话建立 Story 制片骨架',
    requiresConfirmation: true,
    diagnosticsResolved: [],
    operations: [{
      type: 'node.add',
      payload: { node: { id: 'story-shared', type: 'story', data: {} } },
    }],
  };
  const publicPlan = {
    schema: 't8-agent-creative-plan-v1',
    planId: 'plan-shared',
    planDigest: 'f'.repeat(64),
    projectId: 'project-local',
    canvasId: 'canvas-shared',
    canvasRevision: 31,
    kind: 'story',
    ready: true,
    questions: [],
    brief: { goal: '雨夜重逢短片' },
  };
  const internalPlan = {
    id: publicPlan.planId,
    planDigest: publicPlan.planDigest,
    projectId: publicPlan.projectId,
    canvasId: publicPlan.canvasId,
    patch,
  };
  const database = {
    getCanvas(canvasId) {
      return canvasId === document.canvasId ? structuredClone(document) : null;
    },
    getAsset(assetId) {
      return assetId === 'asset-reference-image'
        ? {
            id: assetId,
            projectId: document.projectId,
            kind: 'image',
            filename: '私有角色参考.png',
            mimeType: 'image/png',
            sizeBytes: 2048,
            contentRevision: 3,
            sourceLocator: 'C:\\private\\角色参考.png',
          }
        : null;
    },
  };
  const creativeService = {
    publicPlan(plan) {
      assert.equal(plan, internalPlan);
      return publicPlan;
    },
    requirePlan(planId, scope) {
      assert.equal(planId, publicPlan.planId);
      assert.equal(scope.projectId, document.projectId);
      assert.equal(scope.canvasId, document.canvasId);
      return internalPlan;
    },
  };
  const app = express();
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use('/api/agent-control/v1', agentControlRoute.createAgentControlRouter({
    auth,
    database,
    creativeService,
    creatorSessions: sessions,
    config: {
      PORT: 19033,
      APP_VERSION: '2.6.5',
      BACKEND_INSTANCE_ID: 'b'.repeat(43),
      SETTINGS_FILE: '',
      DATA_DIR: rootDir,
    },
  }));
  app.use('/api/creator-agent/v1', createCreatorAgentRouter({
    database,
    creativeService,
    sessions,
    config: {
      DATA_DIR: rootDir,
      SETTINGS_FILE: '',
    },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const syncBody = {
    sessionId: 'cs_0123456789abcdefghijklmnop',
    projectId: document.projectId,
    canvasId: document.canvasId,
    title: '雨夜重逢',
    prompt: '一句话把雨夜重逢做成短片',
    planId: publicPlan.planId,
    planDigest: publicPlan.planDigest,
    context: {
      phase: 'script',
      referencedNodeIds: ['node-image-reference'],
      referencedNodeTypes: ['forged-video'],
    },
  };
  const authorization = { Authorization: `Bearer ${reader.accessToken}` };
  const synced = await request(server, '/api/agent-control/v1/creator-sessions', {
    method: 'POST',
    headers: authorization,
    body: syncBody,
  });
  assert.equal(synced.status, 201);
  assert.equal(synced.body.data.session.id, syncBody.sessionId);
  assert.equal(synced.body.data.session.latestPatch.id, patch.id);
  assert.equal(synced.body.data.session.lastSequence, 3);
  assert.deepEqual(synced.body.data.session.context.referencedNodeIds, ['node-image-reference']);
  assert.deepEqual(synced.body.data.session.context.referencedNodeTypes, ['image']);
  assert.equal(synced.body.data.session.context.canvasRevision, document.revision);
  assert.equal(JSON.stringify(synced.body.data).includes('private prompt'), false);

  const duplicate = await request(server, '/api/agent-control/v1/creator-sessions', {
    method: 'POST',
    headers: authorization,
    body: syncBody,
  });
  assert.equal(duplicate.status, 201);
  assert.equal(duplicate.body.data.session.lastSequence, 3);

  const previewed = await request(
    server,
    `/api/agent-control/v1/creator-sessions/${syncBody.sessionId}/events`,
    {
      method: 'POST',
      headers: authorization,
      body: {
        projectId: document.projectId,
        canvasId: document.canvasId,
        type: 'plan.previewed',
        payload: {
          planId: publicPlan.planId,
          planDigest: publicPlan.planDigest,
          patchId: patch.id,
        },
      },
    },
  );
  assert.equal(previewed.status, 201);
  assert.equal(previewed.body.data.status, 'previewed');
  assert.equal(previewed.body.data.lastSequence, 4);

  const agentControlView = await request(
    server,
    `/api/agent-control/v1/creator-sessions/${syncBody.sessionId}`
      + `?projectId=${document.projectId}&canvasId=${document.canvasId}`,
    { headers: authorization },
  );
  const canvasAgentView = await request(
    server,
    `/api/creator-agent/v1/sessions/${syncBody.sessionId}`
      + `?projectId=${document.projectId}&canvasId=${document.canvasId}`,
  );
  assert.equal(agentControlView.status, 200);
  assert.equal(canvasAgentView.status, 200);
  assert.equal(agentControlView.body.data.id, canvasAgentView.body.data.id);
  assert.equal(agentControlView.body.data.lastSequence, canvasAgentView.body.data.lastSequence);
  assert.equal(agentControlView.body.data.status, canvasAgentView.body.data.status);
  assert.equal(agentControlView.body.data.latestPlan.planId, canvasAgentView.body.data.latestPlan.planId);

  const missingReference = await request(server, '/api/agent-control/v1/creator-sessions', {
    method: 'POST',
    headers: authorization,
    body: {
      sessionId: 'cs_missingref0123456789abcdefghi',
      projectId: document.projectId,
      canvasId: document.canvasId,
      prompt: '调整这个节点',
      planId: publicPlan.planId,
      planDigest: publicPlan.planDigest,
      context: {
        phase: 'idea',
        referencedNodeIds: ['node-deleted'],
      },
    },
  });
  assert.equal(missingReference.status, 409);
  assert.equal(missingReference.body.code, 'CREATOR_REFERENCE_NODE_NOT_FOUND');
  assert.match(missingReference.body.message, /不存在或已被删除/);

  const attachmentOnly = await request(server, '/api/agent-control/v1/creator-sessions', {
    method: 'POST',
    headers: authorization,
    body: {
      sessionId: 'cs_assetonly0123456789abcdefghi',
      projectId: document.projectId,
      canvasId: document.canvasId,
      prompt: '',
      planId: publicPlan.planId,
      planDigest: publicPlan.planDigest,
      assetIds: ['asset-reference-image'],
      context: { phase: 'idea' },
    },
  });
  assert.equal(attachmentOnly.status, 201);
  assert.equal(attachmentOnly.body.data.session.title, '分析1 张图片');
  assert.equal(attachmentOnly.body.data.userEvent.payload.inputMode, 'attachments-only');
  assert.equal(
    attachmentOnly.body.data.userEvent.payload.text,
    '请分析我上传的1 张图片，先说明可直接使用的内容和缺失信息，再给出 3 个可执行的创作下一步；不要自动生成或修改画布。',
  );
  assert.deepEqual(attachmentOnly.body.data.userEvent.payload.attachments, [{
    id: 'asset:asset-reference-image',
    assetId: 'asset-reference-image',
    kind: 'image',
    name: '私有角色参考.png',
    ref: '/api/project-assets/asset-reference-image/media',
    mimeType: 'image/png',
    size: 2048,
    contentRevision: 3,
  }]);
  assert.equal(JSON.stringify(attachmentOnly.body.data).includes('C:\\private'), false);

  const latest = await request(
    server,
    `/api/creator-agent/v1/sessions?projectId=${document.projectId}&canvasId=${document.canvasId}&limit=1`,
  );
  assert.equal(latest.status, 200);
  assert.equal(latest.body.data.latest.id, attachmentOnly.body.data.session.id);

  const preview = await request(
    server,
    `/api/creator-agent/v1/sessions/${syncBody.sessionId}/plans/${publicPlan.planId}/patch`
      + `?projectId=${document.projectId}&canvasId=${document.canvasId}`,
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.patch.id, patch.id);
  assert.equal(preview.body.data.patch.baseRevision, document.revision);

  const forgedApplied = await request(
    server,
    `/api/agent-control/v1/creator-sessions/${syncBody.sessionId}/events`,
    {
      method: 'POST',
      headers: authorization,
      body: {
        projectId: document.projectId,
        canvasId: document.canvasId,
        type: 'plan.applied',
        payload: {
          planId: publicPlan.planId,
          planDigest: publicPlan.planDigest,
          patchId: patch.id,
          appliedRevision: document.revision + 1,
        },
      },
    },
  );
  assert.equal(forgedApplied.status, 503);
  assert.equal(forgedApplied.body.code, 'CREATOR_PATCH_LEDGER_UNAVAILABLE');
  assert.equal(sessions.read(syncBody.sessionId).lastSequence, 4);
});
