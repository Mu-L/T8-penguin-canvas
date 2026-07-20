import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  commitSubflowDraftHistory,
  createSubflowDraftHistory,
  redoSubflowDraftHistory,
  undoSubflowDraftHistory,
} from '../src/utils/subflowDraftHistory.ts';
import type { SubflowDefinition } from '../src/utils/subflows.ts';

function definition(): SubflowDefinition {
  return {
    id: 'draft-history', version: 3, projectId: 'project-a', name: 'Original', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], inputs: [], outputs: [],
    nodes: [
      { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { text: 'before' } },
      { id: 'b', type: 'image', position: { x: 200, y: 0 }, data: { model: 'fixed' } },
    ],
    edges: [{ id: 'a-b', source: 'a', target: 'b' }],
  };
}

function read(rel: string) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

test('draft history undoes and redoes metadata, node data, movement and graph edits in order', () => {
  let history = createSubflowDraftHistory(definition());
  history = commitSubflowDraftHistory(history, { ...history.draft, name: 'Renamed' });
  history = commitSubflowDraftHistory(history, {
    ...history.draft,
    nodes: history.draft.nodes.map((node) => node.id === 'a' ? { ...node, data: { text: 'after' } } : node),
  });
  history = commitSubflowDraftHistory(history, {
    ...history.draft,
    nodes: history.draft.nodes.map((node) => node.id === 'b' ? { ...node, position: { x: 320, y: 80 } } : node),
  });
  history = commitSubflowDraftHistory(history, {
    ...history.draft,
    edges: [...history.draft.edges, { id: 'b-a', source: 'b', target: 'a' }],
  });

  assert.equal(history.undoStack.length, 4);
  history = undoSubflowDraftHistory(history);
  assert.deepEqual(history.draft.edges.map((edge) => edge.id), ['a-b']);
  history = undoSubflowDraftHistory(history);
  assert.deepEqual(history.draft.nodes.find((node) => node.id === 'b')?.position, { x: 200, y: 0 });
  history = undoSubflowDraftHistory(history);
  assert.equal((history.draft.nodes.find((node) => node.id === 'a')?.data as any).text, 'before');
  history = undoSubflowDraftHistory(history);
  assert.equal(history.draft.name, 'Original');
  assert.equal(history.redoStack.length, 4);

  history = redoSubflowDraftHistory(history);
  history = redoSubflowDraftHistory(history);
  history = redoSubflowDraftHistory(history);
  history = redoSubflowDraftHistory(history);
  assert.equal(history.draft.name, 'Renamed');
  assert.equal((history.draft.nodes.find((node) => node.id === 'a')?.data as any).text, 'after');
  assert.deepEqual(history.draft.nodes.find((node) => node.id === 'b')?.position, { x: 320, y: 80 });
  assert.deepEqual(history.draft.edges.map((edge) => edge.id), ['a-b', 'b-a']);
});

test('selection does not create history, new edits invalidate redo, and snapshots are cloned', () => {
  let history = createSubflowDraftHistory(definition());
  const selected = {
    ...history.draft,
    nodes: history.draft.nodes.map((node) => ({ ...node, selected: node.id === 'a' })),
  };
  history = commitSubflowDraftHistory(history, selected);
  assert.equal(history.undoStack.length, 0);
  assert.equal(history.draft.nodes[0].selected, true);

  const renamed = { ...history.draft, name: 'First edit' };
  history = commitSubflowDraftHistory(history, renamed);
  renamed.name = 'mutated outside history';
  assert.equal(history.draft.name, 'First edit');
  history = undoSubflowDraftHistory(history);
  assert.equal(history.redoStack.length, 1);
  history = commitSubflowDraftHistory(history, { ...history.draft, description: 'branched' });
  assert.equal(history.redoStack.length, 0);
  assert.equal(redoSubflowDraftHistory(history), history);
});

test('draft history enforces its configured capacity', () => {
  let history = createSubflowDraftHistory(definition());
  history = commitSubflowDraftHistory(history, { ...history.draft, name: '1' }, 2);
  history = commitSubflowDraftHistory(history, { ...history.draft, name: '2' }, 2);
  history = commitSubflowDraftHistory(history, { ...history.draft, name: '3' }, 2);
  assert.deepEqual(history.undoStack.map((item) => item.name), ['1', '2']);
  history = undoSubflowDraftHistory(history, 2);
  history = undoSubflowDraftHistory(history, 2);
  assert.equal(history.draft.name, '1');
  assert.equal(history.undoStack.length, 0);
});

test('canvas wires every internal draft mutation class to personal undo and redo controls', () => {
  const canvas = read('src/components/Canvas.tsx');
  assert.match(canvas, /createSubflowDraftHistory\(current\.stack\[depth\]\)/);
  assert.match(canvas, /handleSubflowRevisionNodeDragStart/);
  assert.match(canvas, /handleSubflowRevisionNodeDragStop/);
  assert.match(canvas, /commitSubflowDraftHistory\(current\.edit, nextDraft\)/);
  assert.match(canvas, /undoSubflowDraftHistory\(current\.edit\)/);
  assert.match(canvas, /redoSubflowDraftHistory\(current\.edit\)/);
  assert.match(canvas, /撤销内部草稿（Ctrl\/Cmd\+Z）/);
  assert.match(canvas, /重做内部草稿（Ctrl\/Cmd\+Shift\+Z 或 Ctrl\/Cmd\+Y）/);
  assert.match(canvas, /onNodeDragStart=\{editActive \? handleSubflowRevisionNodeDragStart/);
  assert.match(canvas, /onNodeDragStop=\{editActive \? handleSubflowRevisionNodeDragStop/);
});
