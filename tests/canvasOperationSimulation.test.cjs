const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyCanvasOperation,
  applyCanvasOperationForSimulation,
  assertCanvasDocumentInvariants,
  normalizeCanvasDocument,
} = require('../backend/src/collaboration/protocol');

test('read-only simulation preserves operation semantics but defers only intermediate graph invariants', () => {
  const source = normalizeCanvasDocument('canvas-a', {
    nodes: [{ id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {} }],
    edges: [{ id: 'dangling', source: 'missing', target: 'a' }],
  }, { projectId: 'project-a', revision: 4 });
  const move = {
    opId: 'simulation-move',
    projectId: 'project-a',
    canvasId: 'canvas-a',
    type: 'node.patch',
    payload: { nodeId: 'a', patch: { position: { x: 12, y: 34 } } },
  };
  assert.throws(() => applyCanvasOperation(source, move), /端点不存在/);

  const intermediate = applyCanvasOperationForSimulation(source, move).document;
  assert.deepEqual(intermediate.nodes[0].position, { x: 12, y: 34 });
  assert.equal(intermediate.edges.length, 1);
  assert.throws(() => assertCanvasDocumentInvariants(intermediate), /端点不存在/);

  const repaired = applyCanvasOperationForSimulation(intermediate, {
    opId: 'simulation-delete-edge',
    projectId: 'project-a',
    canvasId: 'canvas-a',
    type: 'edge.delete',
    payload: { edgeId: 'dangling' },
  }).document;
  assert.doesNotThrow(() => assertCanvasDocumentInvariants(repaired));
  assert.deepEqual(repaired.nodes[0].position, { x: 12, y: 34 });
  assert.equal(repaired.edges.length, 0);

  assert.deepEqual(source.nodes[0].position, { x: 0, y: 0 });
  assert.equal(source.edges.length, 1);
  assert.equal(source.tombstones.edges.dangling, undefined);
});

test('simulation helper keeps collision and tombstone protections intact', () => {
  const source = normalizeCanvasDocument('canvas-a', {
    nodes: [{ id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {} }],
    edges: [],
  }, { projectId: 'project-a', revision: 4 });
  assert.throws(() => applyCanvasOperationForSimulation(source, {
    opId: 'simulation-collision',
    projectId: 'project-a',
    canvasId: 'canvas-a',
    type: 'node.add',
    payload: { node: { id: 'a', type: 'text', position: { x: 1, y: 1 }, data: {} } },
  }), /节点已存在/);

  const deleted = applyCanvasOperationForSimulation(source, {
    opId: 'simulation-delete',
    projectId: 'project-a',
    canvasId: 'canvas-a',
    type: 'node.delete',
    payload: { nodeId: 'a' },
  }).document;
  assert.throws(() => applyCanvasOperationForSimulation(deleted, {
    opId: 'simulation-readd',
    projectId: 'project-a',
    canvasId: 'canvas-a',
    type: 'node.add',
    payload: { node: { id: 'a', type: 'text', position: { x: 1, y: 1 }, data: {} } },
  }), /必须显式恢复/);
});
