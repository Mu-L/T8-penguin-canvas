const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const { CollaborationGateway } = require('../backend/src/collaboration/gateway');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'project-subflow-broadcast-scope';
const DEFINITION_ID = 'shared-exact-subflow';
const OTHER_DEFINITION_ID = 'other-subflow';

function subflowDefinition(id, name) {
  return {
    id,
    projectId: PROJECT_ID,
    name,
    description: '',
    tags: [],
    nodes: [{
      id: `${id}-text`,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { text: name },
    }],
    edges: [],
    inputs: [],
    outputs: [],
    exposedParameters: [],
    requiredCapabilities: [],
    assetRefs: [],
  };
}

function saveSubflow(database, definition, expectedRevision) {
  return database.saveSubflowDefinition(definition, {
    expectedRevision,
    actorId: 'local-owner',
    sessionId: 'local-subflow-broadcast-test',
    changeSummary: `publish ${definition.name}`,
  });
}

function ensureCanvas(database, canvasId, definitionId, version) {
  const canvas = database.ensureCanvas(canvasId, {
    name: canvasId,
    nodes: [{
      id: `${canvasId}-subflow`,
      type: 'subflow',
      position: { x: 0, y: 0 },
      data: {
        definitionId,
        definitionVersion: version,
      },
    }],
    edges: [],
  }, PROJECT_ID);
  const state = database.getCanvasResourceGrantState(PROJECT_ID, canvasId);
  assert.ok(state);
  assert.ok(state.initializedAt > 0);
  assert.equal(state.trustedRevision, canvas.revision);
  return canvas;
}

function connectProbe(gateway, canvasId, label) {
  const invite = gateway.auth.createInvite({
    projectId: PROJECT_ID,
    canvasId,
    role: 'viewer',
    maxUses: 1,
  });
  const actor = gateway.auth.redeemInvite(invite.code, label);
  assert.ok(actor);
  const socket = {
    readyState: WebSocket.OPEN,
    messages: [],
    closes: [],
    send(raw) {
      this.messages.push(JSON.parse(String(raw)));
    },
    close(code, reason) {
      this.closes.push({ code, reason: String(reason || '') });
      this.readyState = WebSocket.CLOSED;
    },
  };
  gateway.connections.set(socket, {
    sessionToken: actor.token,
    session: gateway.auth.authenticate(actor.token),
    canvasId,
  });
  return socket;
}

test('local subflow publish and import routes use exact-grant-aware broadcasting', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'src', 'routes', 'subflows.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /collaborationGateway\.broadcastProject\s*\(/);
  assert.equal(
    [...source.matchAll(/collaborationGateway\.broadcastSubflowPublication\s*\(/g)].length,
    2,
  );
});

test('exact subflow publication broadcast reaches only canvases granted that immutable version', () => {
  const database = new ProjectDatabase(':memory:');
  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    FRONTEND_DIST: '',
    INPUT_DIR: process.cwd(),
    OUTPUT_DIR: process.cwd(),
  }, database);
  try {
    const versionOne = saveSubflow(
      database,
      subflowDefinition(DEFINITION_ID, 'Shared v1'),
      0,
    );
    const versionTwo = saveSubflow(
      database,
      subflowDefinition(DEFINITION_ID, 'Shared v2'),
      versionOne.revision,
    );
    const other = saveSubflow(
      database,
      subflowDefinition(OTHER_DEFINITION_ID, 'Other v1'),
      0,
    );

    ensureCanvas(database, 'canvas-exact-v2', DEFINITION_ID, versionTwo.version);
    ensureCanvas(database, 'canvas-old-v1', DEFINITION_ID, versionOne.version);
    ensureCanvas(database, 'canvas-other-flow', OTHER_DEFINITION_ID, other.version);

    const exactSocket = connectProbe(gateway, 'canvas-exact-v2', 'Exact v2');
    const oldSocket = connectProbe(gateway, 'canvas-old-v1', 'Old v1');
    const otherSocket = connectProbe(gateway, 'canvas-other-flow', 'Other flow');

    const sent = gateway.broadcastSubflowPublication(
      PROJECT_ID,
      DEFINITION_ID,
      versionTwo.version,
      {
        type: 'subflow.published',
        publication: {
          id: DEFINITION_ID,
          version: versionTwo.version,
          revision: versionTwo.revision,
        },
      },
    );

    assert.equal(sent, 1);
    assert.equal(exactSocket.messages.length, 1);
    assert.equal(exactSocket.messages[0].type, 'subflow.published');
    assert.equal(exactSocket.messages[0].publication.id, DEFINITION_ID);
    assert.equal(exactSocket.messages[0].publication.version, versionTwo.version);
    assert.equal(typeof exactSocket.messages[0].timestamp, 'number');
    assert.deepEqual(oldSocket.messages, []);
    assert.deepEqual(otherSocket.messages, []);
    assert.deepEqual(exactSocket.closes, []);
    assert.deepEqual(oldSocket.closes, []);
    assert.deepEqual(otherSocket.closes, []);
  } finally {
    database.close();
  }
});
