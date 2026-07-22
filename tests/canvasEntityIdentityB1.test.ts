import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cloneCanvasEntityAsNew,
  createCanvasEntityUid,
  ensureCanvasEntityUids,
  isCanonicalEntityUid,
} from '../src/utils/canvasEntityIdentity.ts';

test('B1 assigns immutable UUIDs to new runtime nodes and edges without mutating inputs', () => {
  const nodes = [{ id: 'text-12', type: 'text', data: { unknown: true } }];
  const edges = [{ id: 'edge-12', source: 'text-12', target: 'text-13' }];
  const nextNodes = ensureCanvasEntityUids(nodes, 'node');
  const nextEdges = ensureCanvasEntityUids(edges, 'edge');

  assert.equal(Object.hasOwn(nodes[0], 'entityUid'), false);
  assert.equal(Object.hasOwn(edges[0], 'entityUid'), false);
  assert.equal(isCanonicalEntityUid(nextNodes[0].entityUid), true);
  assert.equal(isCanonicalEntityUid(nextEdges[0].entityUid), true);
  assert.notEqual(nextNodes[0].entityUid, nextEdges[0].entityUid);
  assert.deepEqual(nextNodes[0].data, { unknown: true });
});

test('B1 preserves canonical UUIDs and fails closed on malformed or duplicate identities', () => {
  const uid = createCanvasEntityUid();
  const canonical = [{ id: 'node-a', entityUid: uid }];
  assert.equal(ensureCanvasEntityUids(canonical, 'node'), canonical);
  assert.throws(
    () => ensureCanvasEntityUids([{ id: 'node-a', entityUid: 'legacy-uid' }], 'node'),
    /entityUid 无效/,
  );
  assert.throws(
    () => ensureCanvasEntityUids([
      { id: 'node-a', entityUid: uid },
      { id: 'node-b', entityUid: uid.toUpperCase() },
    ], 'node'),
    /entityUid 重复/,
  );
});

test('copied canvas entities must receive fresh identities before entering state', () => {
  const originalUid = createCanvasEntityUid();
  const original = {
    id: 'node-original',
    entityUid: originalUid,
    entityRevision: 12,
    legacyAliases: ['node-original'],
  };
  const copied = cloneCanvasEntityAsNew({
    ...original,
    id: 'node-copy',
  }, 'node');

  assert.notEqual(copied.entityUid, original.entityUid);
  assert.equal(Object.hasOwn(copied, 'entityRevision'), false);
  assert.equal(Object.hasOwn(copied, 'legacyAliases'), false);
  assert.doesNotThrow(() => ensureCanvasEntityUids([original, copied], 'node'));
});

test('copied edges discard source identity aliases so remapped endpoints can be resolved', () => {
  const copied = cloneCanvasEntityAsNew({
    id: 'edge-copy',
    entityUid: createCanvasEntityUid(),
    entityRevision: 12,
    legacyAliases: ['edge-original'],
    sourceEntityUid: createCanvasEntityUid(),
    targetEntityUid: createCanvasEntityUid(),
    source: 'node-copy-a',
    target: 'node-copy-b',
  }, 'edge');

  assert.equal(Object.hasOwn(copied, 'entityRevision'), false);
  assert.equal(Object.hasOwn(copied, 'legacyAliases'), false);
  assert.equal(Object.hasOwn(copied, 'sourceEntityUid'), false);
  assert.equal(Object.hasOwn(copied, 'targetEntityUid'), false);
});
