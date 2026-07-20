import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureCanvasHistoryTransition,
  captureCanvasHistoryState,
  createCanvasHistoryState,
  redoCanvasHistoryState,
  sanitizeCanvasHistorySnapshot,
  undoCanvasHistoryState,
} from '../src/hooks/useCanvasHistory.ts';

test('canvas history excludes subflow runtime projections and every incident edge', () => {
  const snapshot = sanitizeCanvasHistorySnapshot({
    nodes: [
      { id: 'persisted', type: 'text', position: { x: 0, y: 0 }, data: { text: 'keep' } },
      { id: 'runtime', type: 'image', position: { x: 0, y: 0 }, data: { __subflowRuntime: true } },
    ],
    edges: [
      { id: 'keep', source: 'persisted', target: 'other' },
      { id: 'into-runtime', source: 'persisted', target: 'runtime' },
      { id: 'from-runtime', source: 'runtime', target: 'persisted' },
      { id: 'marked', source: 'persisted', target: 'other', data: { __subflowRuntime: true } },
    ],
  });
  assert.deepEqual(snapshot.nodes.map((node) => node.id), ['persisted']);
  assert.deepEqual(snapshot.edges.map((edge) => edge.id), ['keep']);
});

test('canvas history sanitization does not mutate the live snapshot', () => {
  const live = { nodes: [{ id: 'runtime', position: { x: 0, y: 0 }, data: { __subflowRuntime: true } }], edges: [] };
  const sanitized = sanitizeCanvasHistorySnapshot(live);
  assert.equal(live.nodes.length, 1);
  assert.equal(sanitized.nodes.length, 0);
});

test('subflow parameter overrides undo, redo, branch and reset without transient UI frames', () => {
  const initial = {
    nodes: [{
      id: 'subflow-instance',
      type: 'subflow',
      position: { x: 10, y: 20 },
      selected: false,
      measured: { width: 330, height: 240 },
      data: { definitionId: 'definition-a', definitionVersion: 1, parameterOverrides: {} },
    }],
    edges: [],
  };
  let history = createCanvasHistoryState(initial);

  history = captureCanvasHistoryState(history, {
    ...initial,
    nodes: initial.nodes.map((node) => ({ ...node, selected: true, dragging: false, measured: { width: 331, height: 241 } })),
  });
  assert.equal(history.past.length, 0);
  assert.equal(history.present?.nodes[0].selected, true);

  history = captureCanvasHistoryState(history, {
    ...history.present!,
    nodes: history.present!.nodes.map((node) => ({
      ...node,
      data: { ...node.data, parameterOverrides: { prompt: 'cinematic', steps: 24 } },
    })),
  });
  assert.equal(history.past.length, 1);
  assert.deepEqual((history.present!.nodes[0].data as any).parameterOverrides, { prompt: 'cinematic', steps: 24 });

  history = undoCanvasHistoryState(history);
  assert.deepEqual((history.present!.nodes[0].data as any).parameterOverrides, {});
  assert.equal(history.future.length, 1);

  history = captureCanvasHistoryState(history, {
    ...history.present!,
    nodes: history.present!.nodes.map((node) => ({ ...node, selected: false, measured: { width: 332, height: 242 } })),
  });
  assert.equal(history.past.length, 0);
  assert.equal(history.future.length, 1);

  history = redoCanvasHistoryState(history);
  assert.deepEqual((history.present!.nodes[0].data as any).parameterOverrides, { prompt: 'cinematic', steps: 24 });

  history = undoCanvasHistoryState(history);
  history = captureCanvasHistoryState(history, {
    ...history.present!,
    nodes: history.present!.nodes.map((node) => ({
      ...node,
      data: { ...node.data, parameterOverrides: { prompt: 'branched' } },
    })),
  });
  assert.equal(history.future.length, 0);
  assert.deepEqual((history.present!.nodes[0].data as any).parameterOverrides, { prompt: 'branched' });

  history = captureCanvasHistoryState(history, {
    ...history.present!,
    nodes: history.present!.nodes.map((node) => ({
      ...node,
      data: { ...node.data, parameterOverrides: {} },
    })),
  });
  history = undoCanvasHistoryState(history);
  assert.deepEqual((history.present!.nodes[0].data as any).parameterOverrides, { prompt: 'branched' });
});

test('canvas history still records node position, dimensions, data and edge changes', () => {
  const initial = {
    nodes: [{ id: 'a', type: 'text', position: { x: 0, y: 0 }, width: 200, data: { text: 'before' } }],
    edges: [],
  };
  let history = createCanvasHistoryState(initial);
  history = captureCanvasHistoryState(history, {
    nodes: [{ id: 'a', type: 'text', position: { x: 25, y: 30 }, width: 260, data: { text: 'after' } }],
    edges: [{ id: 'self', source: 'a', target: 'a' }],
  });
  assert.equal(history.past.length, 1);
  history = undoCanvasHistoryState(history);
  assert.deepEqual(history.present, initial);
  history = redoCanvasHistoryState(history);
  assert.deepEqual(history.present?.nodes[0].position, { x: 25, y: 30 });
  assert.equal(history.present?.nodes[0].width, 260);
  assert.equal((history.present?.nodes[0].data as any).text, 'after');
  assert.deepEqual(history.present?.edges.map((edge) => edge.id), ['self']);
});

test('explicit graph transitions undo and redo encapsulation and detachment as single boundaries', () => {
  const leaf = {
    nodes: [{ id: 'leaf', type: 'text', position: { x: 40, y: 50 }, data: { prompt: 'leaf' } }],
    edges: [],
  };
  const encapsulated = {
    nodes: [{ id: 'instance', type: 'subflow', position: { x: 40, y: 50 }, data: { definitionId: 'qa', definitionVersion: 1 } }],
    edges: [],
  };
  const detached = {
    nodes: [{ id: 'instance::leaf', type: 'text', position: { x: 40, y: 50 }, data: { prompt: 'leaf' } }],
    edges: [],
  };

  let history = createCanvasHistoryState(leaf);
  history = captureCanvasHistoryTransition(history, leaf, encapsulated);
  assert.deepEqual(history.present, encapsulated);
  history = undoCanvasHistoryState(history);
  assert.deepEqual(history.present, leaf);
  history = redoCanvasHistoryState(history);
  assert.deepEqual(history.present, encapsulated);

  history = captureCanvasHistoryTransition(history, encapsulated, detached);
  assert.deepEqual(history.present, detached);
  history = undoCanvasHistoryState(history);
  assert.deepEqual(history.present, encapsulated);
  history = redoCanvasHistoryState(history);
  assert.deepEqual(history.present, detached);

  history = undoCanvasHistoryState(history);
  const branchedDetach = {
    ...detached,
    nodes: detached.nodes.map((node) => ({ ...node, data: { ...node.data, prompt: 'branched detach' } })),
  };
  history = captureCanvasHistoryTransition(history, encapsulated, branchedDetach);
  assert.equal(history.future.length, 0);
  assert.deepEqual(history.present, branchedDetach);
  history = undoCanvasHistoryState(history);
  assert.deepEqual(history.present, encapsulated);

  const beforeFailedTransition = structuredClone(history);
  history = captureCanvasHistoryTransition(history, encapsulated, encapsulated);
  assert.deepEqual(history, beforeFailedTransition);
});
