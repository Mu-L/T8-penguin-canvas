'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
  AgentControlAuthError,
  createAgentControlAuthService,
  developmentAuthServiceOptions,
} = require('../backend/src/services/agentControlAuth.js');
const agentControlRoute = require('../backend/src/routes/agentControl.js');

test('agent-control pairing issues a scoped token once and supports revocation', () => {
  let clock = Date.parse('2026-07-24T00:00:00.000Z');
  const auth = createAgentControlAuthService({ now: () => clock });
  const pairing = auth.createPairing({
    clientName: 'Codex 创作 Agent',
    agentKind: 'codex',
    requestedScopes: ['canvas:read', 'run:read'],
  });

  assert.equal(pairing.status, 'pending');
  assert.match(pairing.pollSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pairing.userCode, /^[A-Z2-9]{8}$/);
  assert.equal(auth.listPendingPairings()[0].pollSecret, undefined);

  const pendingSummary = auth.connectionSummary();
  assert.equal(pendingSummary.connected, false);
  assert.equal(pendingSummary.codexConnected, false);
  assert.equal(pendingSummary.pendingPairingCount, 1);
  assert.equal(JSON.stringify(pendingSummary).includes(pairing.userCode), false);
  assert.equal(JSON.stringify(pendingSummary).includes(pairing.pairingId), false);
  assert.equal(JSON.stringify(pendingSummary).includes(pairing.pollSecret), false);

  assert.throws(
    () => auth.approvePairing({ pairingId: pairing.pairingId, userCode: 'WRONG234' }),
    (error) => error instanceof AgentControlAuthError && error.code === 'PAIRING_CODE_MISMATCH',
  );
  assert.throws(
    () => auth.approvePairing({
      pairingId: pairing.pairingId,
      userCode: pairing.userCode,
      approvedScopes: ['canvas:write'],
    }),
    (error) => error instanceof AgentControlAuthError && error.code === 'PAIRING_SCOPE_ESCALATION',
  );

  auth.approvePairing({
    pairingId: pairing.pairingId,
    userCode: pairing.userCode,
    approvedScopes: ['canvas:read', 'run:read'],
  });
  const connectedSummary = auth.connectionSummary();
  assert.equal(connectedSummary.connected, true);
  assert.equal(connectedSummary.activeSessionCount, 1);
  assert.equal(connectedSummary.codexConnected, true);
  assert.equal(connectedSummary.codexSessionCount, 1);
  assert.equal(connectedSummary.pendingPairingCount, 0);
  assert.deepEqual(connectedSummary.codexScopes, ['canvas:read', 'run:read']);
  assert.equal(connectedSummary.nextCodexExpiryAt, '2026-07-24T08:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(connectedSummary), /accessToken|pollSecret|sessionId|userCode|pairingId/);
  assert.throws(
    () => auth.pollPairing({ pairingId: pairing.pairingId, pollSecret: 'x'.repeat(43) }),
    (error) => error instanceof AgentControlAuthError && error.code === 'PAIRING_POLL_FORBIDDEN',
  );

  const issued = auth.pollPairing({
    pairingId: pairing.pairingId,
    pollSecret: pairing.pollSecret,
  });
  assert.equal(issued.status, 'approved');
  assert.match(issued.accessToken, /^[A-Za-z0-9_-]{43}$/);

  const secondPoll = auth.pollPairing({
    pairingId: pairing.pairingId,
    pollSecret: pairing.pollSecret,
  });
  assert.equal(secondPoll.status, 'issued');
  assert.equal(secondPoll.accessToken, undefined);

  const session = auth.authenticate(issued.accessToken, ['canvas:read']);
  assert.equal(session.agentKind, 'codex');
  assert.deepEqual(session.scopes, ['canvas:read', 'run:read']);
  assert.throws(
    () => auth.authenticate(issued.accessToken, ['canvas:write']),
    (error) => error instanceof AgentControlAuthError && error.code === 'AUTH_SCOPE_FORBIDDEN',
  );

  assert.equal(auth.revoke(issued.accessToken).revoked, true);
  assert.equal(auth.connectionSummary().connected, false);
  assert.equal(auth.connectionSummary().codexConnected, false);
  assert.equal(auth.connectionSummary().activeSessionCount, 0);
  assert.throws(
    () => auth.authenticate(issued.accessToken),
    (error) => error instanceof AgentControlAuthError && error.code === 'AUTH_EXPIRED',
  );

  clock += 10 * 60 * 1000;
  assert.equal(auth.listPendingPairings().length, 0);
});

test('connection summary aggregates independent Codex sessions and revokes them separately', () => {
  const auth = createAgentControlAuthService();
  const firstPairing = auth.createPairing({
    clientName: 'Primary Codex',
    agentKind: 'codex',
    requestedScopes: ['canvas:read'],
  });
  const secondPairing = auth.createPairing({
    clientName: 'Secondary Codex',
    agentKind: 'codex',
    requestedScopes: ['run:read'],
  });
  assert.equal(auth.connectionSummary().pendingPairingCount, 2);

  auth.approvePairing({
    pairingId: firstPairing.pairingId,
    userCode: firstPairing.userCode,
    approvedScopes: ['canvas:read'],
  });
  auth.approvePairing({
    pairingId: secondPairing.pairingId,
    userCode: secondPairing.userCode,
    approvedScopes: ['run:read'],
  });
  const first = auth.pollPairing({
    pairingId: firstPairing.pairingId,
    pollSecret: firstPairing.pollSecret,
  });
  const second = auth.pollPairing({
    pairingId: secondPairing.pairingId,
    pollSecret: secondPairing.pollSecret,
  });

  const combined = auth.connectionSummary();
  assert.equal(combined.activeSessionCount, 2);
  assert.equal(combined.codexSessionCount, 2);
  assert.equal(combined.pendingPairingCount, 0);
  assert.deepEqual(combined.codexScopes, ['canvas:read', 'run:read']);

  assert.equal(auth.revoke(first.accessToken).revoked, true);
  const afterFirstRevoke = auth.connectionSummary();
  assert.equal(afterFirstRevoke.codexConnected, true);
  assert.equal(afterFirstRevoke.codexSessionCount, 1);
  assert.deepEqual(afterFirstRevoke.codexScopes, ['run:read']);
  assert.deepEqual(auth.authenticate(second.accessToken, ['run:read']).scopes, ['run:read']);

  assert.equal(auth.revoke(second.accessToken).revoked, true);
  const afterFinalRevoke = auth.connectionSummary();
  assert.equal(afterFinalRevoke.connected, false);
  assert.equal(afterFinalRevoke.codexConnected, false);
  assert.equal(afterFinalRevoke.activeSessionCount, 0);
  assert.deepEqual(afterFinalRevoke.codexScopes, []);
});

test('short pairing TTL override is development-only and packaged builds ignore it', () => {
  assert.deepEqual(developmentAuthServiceOptions({
    NODE_ENV: 'production',
    T8PC_AGENT_CONTROL_PAIRING_TTL_MS: '1000',
  }), {});
  assert.deepEqual(developmentAuthServiceOptions({
    NODE_ENV: 'development',
    T8PC_PACKAGED: '1',
    T8PC_AGENT_CONTROL_PAIRING_TTL_MS: '1000',
  }), {});
  assert.deepEqual(developmentAuthServiceOptions({
    NODE_ENV: 'development',
    T8PC_PACKAGED: '0',
    T8PC_AGENT_CONTROL_PAIRING_TTL_MS: '1500',
  }), {
    pairingTtlMs: 1500,
    minimumPairingTtlMs: 1000,
  });
});

function request(server, options = {}, body = null) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      method: options.method || 'GET',
      path: options.path || '/',
      headers: {
        Host: '127.0.0.1:19010',
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

test('agent-control HTTP route requires local CLI origin and real pairing', async (t) => {
  const auth = createAgentControlAuthService();
  const document = {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: 'project-local',
    canvasId: 'canvas-a',
    revision: 4,
    nodes: [{ id: 'text-a', type: 'text', position: { x: 0, y: 0 }, data: { text: 'private prompt' } }],
    edges: [],
  };
  const database = {
    listCanvases: () => [{
      id: 'canvas-a',
      projectId: 'project-local',
      revision: 4,
      name: '创作画布',
      nodeCount: 1,
      createdAt: 1,
      updatedAt: 2,
    }],
    getCanvas: (canvasId) => canvasId === 'canvas-a' ? structuredClone(document) : null,
  };
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use('/api/agent-control/v1', agentControlRoute.createAgentControlRouter({
    auth,
    config: {
      PORT: 19010,
      APP_VERSION: '2.6.4',
      BACKEND_INSTANCE_ID: 'a'.repeat(43),
    },
    database,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const status = await request(server, { path: '/api/agent-control/v1/status' });
  assert.equal(status.status, 200);
  assert.equal(status.body.data.controlProtocol, 't8-agent-control-v1');

  const rejectedOrigin = await request(server, {
    path: '/api/agent-control/v1/status',
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(rejectedOrigin.status, 403);
  assert.equal(rejectedOrigin.body.code, 'AGENT_CONTROL_ORIGIN_FORBIDDEN');

  const unauthenticated = await request(server, {
    path: '/api/agent-control/v1/session',
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.body.code, 'PAIRING_REQUIRED');

  const started = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/pairings',
  }, {
    clientName: 'Codex',
    agentKind: 'codex',
    requestedScopes: ['canvas:read'],
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.data.status, 'pending');

  auth.approvePairing({
    pairingId: started.body.data.pairingId,
    userCode: started.body.data.userCode,
    approvedScopes: ['canvas:read'],
  });
  const polled = await request(server, {
    method: 'POST',
    path: `/api/agent-control/v1/pairings/${started.body.data.pairingId}/poll`,
  }, { pollSecret: started.body.data.pollSecret });
  assert.equal(polled.status, 200);
  assert.equal(polled.body.data.status, 'approved');

  const session = await request(server, {
    path: '/api/agent-control/v1/session',
    headers: { Authorization: `Bearer ${polled.body.data.accessToken}` },
  });
  assert.equal(session.status, 200);
  assert.equal(session.body.data.agentKind, 'codex');

  const workspaces = await request(server, {
    path: '/api/agent-control/v1/workspaces',
    headers: { Authorization: `Bearer ${polled.body.data.accessToken}` },
  });
  assert.equal(workspaces.status, 200);
  assert.equal(workspaces.body.data.projectId, 'project-local');
  assert.equal(workspaces.body.data.canvases[0].id, 'canvas-a');

  const inspected = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/tools',
    headers: { Authorization: `Bearer ${polled.body.data.accessToken}` },
  }, {
    tool: 'inspectCanvas',
    requestId: 'request-agent-control',
    projectId: 'project-local',
    canvasId: 'canvas-a',
    input: {},
  });
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.data.readOnly, true);
  assert.match(inspected.body.data.actorId, /^agent:/);
  assert.equal(inspected.body.data.authority.canApplyCanvasPatch, false);
  assert.equal(JSON.stringify(inspected.body).includes('private prompt'), false);

  const revoked = await request(server, {
    method: 'DELETE',
    path: '/api/agent-control/v1/session',
    headers: { Authorization: `Bearer ${polled.body.data.accessToken}` },
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.data.revoked, true);
});
