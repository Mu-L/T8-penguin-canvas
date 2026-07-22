import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCanvasNodeClipboardMarker,
  expandClipboardNodesForGroups,
  markSystemClipboardAsCanvasNodes,
  offsetClipboardNodes,
  positionClipboardNodesAtAnchor,
  remapPastedGroupMemberIds,
  shouldPreferInternalNodeClipboardPaste,
} from '../src/utils/canvasClipboard.ts';

test('node clipboard marker replaces stale system media without serializing node payloads', async () => {
  let written = '';
  const ok = await markSystemClipboardAsCanvasNodes(2, {
    writeText: async (value) => { written = value; },
  });

  assert.equal(ok, true);
  assert.equal(written, buildCanvasNodeClipboardMarker(2));
  assert.equal(written, 'T8 Penguin Canvas nodes:2');
});

test('node clipboard marker failure leaves the in-memory clipboard usable', async () => {
  const ok = await markSystemClipboardAsCanvasNodes(1, {
    writeText: async () => { throw new Error('clipboard denied'); },
  });

  assert.equal(ok, false);
});

test('fresh internal node copies win over stale external media on the first paste', () => {
  assert.equal(shouldPreferInternalNodeClipboardPaste({
    hasInternalNodes: true,
    internalCopiedAt: 10_000,
    now: 10_500,
    mediaSignature: 'image/png:old-image',
  }), true);
  assert.equal(shouldPreferInternalNodeClipboardPaste({
    hasInternalNodes: true,
    internalCopiedAt: 1_000,
    now: 10_500,
    mediaSignature: 'image/png:new-image',
  }), false);
  assert.equal(shouldPreferInternalNodeClipboardPaste({
    hasInternalNodes: true,
    internalCopiedAt: 8_000,
    now: 20_000,
    mediaSignature: 'image/png:previously-consumed',
    lastExternalMediaSignature: 'image/png:previously-consumed',
    lastExternalPasteAt: 7_000,
  }), true);
  assert.equal(shouldPreferInternalNodeClipboardPaste({
    hasInternalNodes: false,
    internalCopiedAt: 19_900,
    now: 20_000,
    mediaSignature: 'image/png:external-only',
  }), false);
});

test('positionClipboardNodesAtAnchor aligns the copied group top-left to the pointer anchor', () => {
  const sourceNodes = [
    { id: 'a', position: { x: 100, y: 200 }, measured: { width: 200, height: 120 } },
    { id: 'b', position: { x: 420, y: 260 }, width: 240, height: 160 },
  ];

  const positioned = positionClipboardNodesAtAnchor(sourceNodes, { x: 1000, y: 800 });

  assert.deepEqual(
    positioned.map((node) => node.position),
    [
      { x: 1000, y: 800 },
      { x: 1320, y: 860 },
    ],
  );
  assert.equal(positioned[0].id, 'a');
  assert.equal(positioned[1].id, 'b');
});

test('positionClipboardNodesAtAnchor keeps relative spacing when nodes are not measured yet', () => {
  const sourceNodes = [
    { id: 'a', position: { x: -50, y: 120 } },
    { id: 'b', position: { x: 250, y: 420 } },
  ];

  const positioned = positionClipboardNodesAtAnchor(sourceNodes, { x: 600, y: 300 });

  assert.deepEqual(
    positioned.map((node) => node.position),
    [
      { x: 600, y: 300 },
      { x: 900, y: 600 },
    ],
  );
});

test('offsetClipboardNodes preserves the old quick-duplicate offset behavior', () => {
  const sourceNodes = [
    { id: 'a', position: { x: 12, y: 24 } },
    { id: 'b', position: { x: -30, y: 10 } },
  ];

  const positioned = offsetClipboardNodes(sourceNodes, { x: 40, y: 40 });

  assert.deepEqual(
    positioned.map((node) => node.position),
    [
      { x: 52, y: 64 },
      { x: 10, y: 50 },
    ],
  );
});

test('expandClipboardNodesForGroups copies the group box together with its members', () => {
  const allNodes = [
    {
      id: 'group-a',
      type: 'groupBox',
      position: { x: 40, y: 40 },
      data: { memberIds: ['node-a'], width: 500, height: 320 },
    },
    { id: 'node-a', type: 'text', position: { x: 120, y: 140 }, measured: { width: 120, height: 80 } },
    { id: 'node-b', type: 'image', position: { x: 380, y: 240 }, measured: { width: 140, height: 100 } },
    { id: 'outside', type: 'text', position: { x: 900, y: 900 }, measured: { width: 120, height: 80 } },
  ];

  const expanded = expandClipboardNodesForGroups([allNodes[0]], allNodes);

  assert.deepEqual(expanded.map((node) => node.id), ['group-a', 'node-a', 'node-b']);
});

test('remapPastedGroupMemberIds points pasted groups at pasted members', () => {
  const pastedNodes = [
    {
      id: 'group-new',
      type: 'groupBox',
      position: { x: 0, y: 0 },
      data: { memberIds: ['node-a', 'node-b', 'outside'] },
    },
    { id: 'node-new-a', type: 'text', position: { x: 80, y: 120 }, data: {} },
    { id: 'node-new-b', type: 'image', position: { x: 240, y: 180 }, data: {} },
  ];
  const idMap = new Map([
    ['group-a', 'group-new'],
    ['node-a', 'node-new-a'],
    ['node-b', 'node-new-b'],
  ]);

  const remapped = remapPastedGroupMemberIds(pastedNodes, idMap);

  assert.deepEqual(remapped[0].data?.memberIds, ['node-new-a', 'node-new-b']);
});
