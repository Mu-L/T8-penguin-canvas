const test = require('node:test');
const assert = require('node:assert/strict');
const Y = require('yjs');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const { CollaborativeTextStore } = require('../backend/src/collaboration/textCrdt');

function updateFromClient(state, insert) {
  const client = new Y.Doc();
  Y.applyUpdate(client, Buffer.from(state, 'base64'));
  const before = Y.encodeStateVector(client);
  client.getText('content').insert(0, insert);
  return Buffer.from(Y.encodeStateAsUpdate(client, before)).toString('base64');
}

test('Yjs text updates merge concurrent clients without replacing the whole field', () => {
  const database = new ProjectDatabase(':memory:');
  const store = new CollaborativeTextStore(database);
  const key = { projectId: 'project-local', canvasId: 'canvas-text', targetType: 'node', targetId: 'node-a', field: 'prompt' };
  try {
    database.ensureCanvas('canvas-text', { nodes: [{ id: 'node-a' }], edges: [] });
    const initial = store.read(key);
    const alice = updateFromClient(initial.state, '甲');
    const bob = updateFromClient(initial.state, '乙');
    store.apply(key, alice, { actorId: 'alice', sessionId: 'session-a' });
    store.apply(key, bob, { actorId: 'bob', sessionId: 'session-b' });
    const merged = store.read(key);
    assert.equal(merged.text.length, 2);
    assert.equal(new Set(merged.text).has('甲'), true);
    assert.equal(new Set(merged.text).has('乙'), true);
    assert.equal(database.listAuditEvents({ canvasId: 'canvas-text', action: 'collaboration.text.update' }).length, 2);
  } finally {
    database.close();
  }
});

test('collaborative text rejects oversized or invalid updates', () => {
  const database = new ProjectDatabase(':memory:');
  const store = new CollaborativeTextStore(database);
  const key = { canvasId: 'canvas-text', targetType: 'node', targetId: 'node-a', field: 'prompt' };
  try {
    database.ensureCanvas('canvas-text', { nodes: [{ id: 'node-a' }], edges: [] });
    assert.throws(() => store.apply(key, Buffer.from('invalid-yjs').toString('base64')), /格式无效/);
    assert.throws(() => store.apply(key, Buffer.alloc(300 * 1024).toString('base64')), /过大/);
  } finally {
    database.close();
  }
});
