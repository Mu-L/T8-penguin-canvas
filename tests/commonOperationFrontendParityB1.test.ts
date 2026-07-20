import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  COMMON_OPERATION_BATCH_CONTRACT,
  COMMON_OPERATION_CONTRACTS,
  COMMON_OPERATION_TYPES,
  classifyCommonOperationBatchRetry,
  digestCommonOperationBatch,
  normalizeCommonOperationBatch,
  serializeCommonOperationBatch,
} from '../src/utils/commonOperationProtocol.ts';
import { enqueueCollaborationOperation } from '../src/utils/collaborationOfflineQueue.ts';

const require = createRequire(import.meta.url);
const backend = require('../backend/src/collaboration/commonOperationProtocol.js');

const U = Object.freeze({
  project: '00000000-0000-4000-8000-000000000001',
  canvas: '00000000-0000-4000-8000-000000000002',
  batch: '00000000-0000-4000-8000-000000000003',
  client: '00000000-0000-4000-8000-000000000004',
  nodeA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  nodeB: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  edge: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  thread: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
  commentA: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
  commentB: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
  instance: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  definition: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
  artifact: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
  blob: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
  run: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
  nodeRun: 'ffffffff-ffff-4fff-8fff-fffffffffff2',
  attempt: 'ffffffff-ffff-4fff-8fff-fffffffffff3',
});

function opId(index: number) {
  return `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function batch(): any {
  return {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: U.project,
    canvasId: U.canvas,
    baseRevision: 10,
    batchId: U.batch,
    clientId: U.client,
    clientSeq: 42,
    operations: [
      { opId: opId(1), type: 'node.add', payload: { nodeUid: U.nodeA, displayId: 'node-a', nodeType: 'text', position: { x: 1, y: 2 }, data: { label: 'A' }, expectedAbsent: true } },
      { opId: opId(2), type: 'node.patch', payload: { nodeUid: U.nodeA, expectedEntityRevision: 7, fields: { data: { label: 'B' } }, unsetFields: [] } },
      { opId: opId(3), type: 'node.move', payload: { nodeUid: U.nodeA, expectedEntityRevision: 7, position: { x: 20, y: 30 } } },
      { opId: opId(4), type: 'node.delete', payload: { nodeUid: U.nodeA, expectedEntityRevision: 8 } },
      { opId: opId(5), type: 'node.restore', payload: { nodeUid: U.nodeA, displayId: 'node-a', nodeType: 'text', position: { x: 20, y: 30 }, data: {}, expectedTombstoneRevision: 9 } },
      { opId: opId(6), type: 'edge.add', payload: { edgeUid: U.edge, displayId: 'edge-a-b', sourceNodeUid: U.nodeA, targetNodeUid: U.nodeB, sourceHandle: 'text-out', targetHandle: null, edgeType: 'default', data: {}, expectedAbsent: true } },
      { opId: opId(7), type: 'edge.delete', payload: { edgeUid: U.edge, expectedEntityRevision: 8 } },
      { opId: opId(8), type: 'edge.restore', payload: { edgeUid: U.edge, displayId: 'edge-a-b', sourceNodeUid: U.nodeA, targetNodeUid: U.nodeB, sourceHandle: 'text-out', targetHandle: null, edgeType: 'default', data: {}, expectedTombstoneRevision: 9 } },
      { opId: opId(9), type: 'viewport.set', payload: { expectedViewportRevision: 9, viewport: { x: 0, y: 0, zoom: 1.25 } } },
      { opId: opId(10), type: 'review.thread.create', payload: { threadUid: U.thread, expectedCanvasRevision: 10, anchor: { kind: 'video', targetUid: U.artifact, frameMs: 1500, assetRevision: 3 }, severity: 'high', initialComment: { commentUid: U.commentA, body: '请复核' } } },
      { opId: opId(11), type: 'review.comment.add', payload: { threadUid: U.thread, commentUid: U.commentB, parentCommentUid: U.commentA, expectedCanvasRevision: 10, expectedThreadRevision: 9, body: '已复核' } },
      { opId: opId(12), type: 'review.thread.update', payload: { threadUid: U.thread, expectedCanvasRevision: 10, expectedThreadRevision: 9, status: 'approved', severity: 'normal', decisionCanvasRevision: 10 } },
      { opId: opId(13), type: 'subflow.instance.upgrade', payload: { instanceUid: U.instance, definitionUid: U.definition, expectedCanvasRevision: 10, expectedInstanceRevision: 8, expectedDefinitionVersion: 1, expectedDefinitionRevision: 4, targetDefinitionVersion: 2, targetDefinitionRevision: 1, upgradePlanDigest: 'a'.repeat(64) } },
      { opId: opId(14), type: 'host.artifact.commit', payload: { artifactUid: U.artifact, blobUid: U.blob, runUid: U.run, nodeRunUid: U.nodeRun, attemptUid: U.attempt, nodeUid: U.nodeA, expectedCanvasRevision: 10, expectedRunRevision: 3, expectedNodeRunRevision: 2, expectedAttemptRevision: 1, outputOrdinal: 0, kind: 'image', contentHash: 'b'.repeat(64), byteSize: 1234, filename: 'result.png', mimeType: 'image/png' } },
    ],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorCode(action: () => unknown) {
  try {
    action();
    return null;
  } catch (error: any) {
    return error?.code || error?.name || 'unknown';
  }
}

test('B1 browser and host normalize, serialize, hash, and describe the same complete contract', async () => {
  const input = batch();
  assert.deepEqual(normalizeCommonOperationBatch(input), backend.normalizeCommonOperationBatch(input));
  assert.equal(serializeCommonOperationBatch(input), backend.serializeCommonOperationBatch(input));
  assert.equal(await digestCommonOperationBatch(input), backend.digestCommonOperationBatch(input));
  assert.deepEqual(COMMON_OPERATION_TYPES, backend.COMMON_OPERATION_TYPES);
  assert.deepEqual(COMMON_OPERATION_CONTRACTS, backend.COMMON_OPERATION_CONTRACTS);
});

test('B1 browser and host fail closed with matching codes for malformed or ambiguous input', () => {
  const invalid: any[] = [];
  invalid.push({ ...batch(), extra: true });
  invalid.push({ ...batch(), projectId: 'legacy-project\u0000unsafe' });

  const missing = batch();
  delete missing.baseRevision;
  invalid.push(missing);

  const extraPayload = batch();
  extraPayload.operations[2].payload.extra = true;
  invalid.push(extraPayload);

  const futureCas = batch();
  futureCas.operations[2].payload.expectedEntityRevision = 11;
  invalid.push(futureCas);

  const unsafePatch = batch();
  unsafePatch.operations[1].payload.fields.entityUid = U.nodeB;
  invalid.push(unsafePatch);

  const undefinedData = batch();
  undefinedData.operations[0].payload.data.value = undefined;
  invalid.push(undefinedData);

  const duplicate = batch();
  duplicate.operations[1].opId = duplicate.operations[0].opId;
  invalid.push(duplicate);

  const polluted = batch();
  Object.setPrototypeOf(polluted.operations[0].payload.data, { polluted: true });
  invalid.push(polluted);

  const decision = batch();
  decision.operations[11].payload.decisionCanvasRevision = null;
  invalid.push(decision);

  for (const item of invalid) {
    assert.equal(
      errorCode(() => normalizeCommonOperationBatch(item)),
      errorCode(() => backend.normalizeCommonOperationBatch(item)),
    );
  }
});

test('B1 browser and host classify every exact-retry collision shape identically', () => {
  const original = batch();
  const candidates: any[] = [clone(original)];

  const reordered = batch();
  reordered.operations.reverse();
  candidates.push(reordered);

  const subset = batch();
  subset.operations.pop();
  candidates.push(subset);

  const superset = batch();
  superset.operations.push({ ...clone(superset.operations[2]), opId: opId(15) });
  candidates.push(superset);

  const collision = batch();
  collision.operations[2].payload.position.x = 999;
  candidates.push(collision);

  const mixed = batch();
  mixed.operations = [mixed.operations[0], { ...clone(mixed.operations[2]), opId: opId(16) }];
  candidates.push(mixed);

  for (const candidate of candidates) {
    assert.equal(
      classifyCommonOperationBatchRetry(original, candidate),
      backend.classifyCommonOperationBatchRetry(original, candidate),
    );
  }
  assert.deepEqual(candidates.map((candidate) => classifyCommonOperationBatchRetry(original, candidate)), [
    'exact', 'reordered', 'subset', 'superset', 'operation-collision', 'operation-collision',
  ]);
});

test('B1 domain expansion does not widen the active sessionStorage queue beyond exact node.move', () => {
  const queueMove = {
    id: 'offline-node-move',
    operation: {
      opId: 'offline-node-move', clientSeq: 1, timestamp: 1_700_000_000_001,
      type: 'node.move', payload: { nodeId: 'node-a', position: { x: 1, y: 2 } },
    },
    baseRevision: null,
    status: 'pending',
    ambiguous: false,
    attempts: 0,
    rebaseAttempts: 0,
  };
  assert.equal(enqueueCollaborationOperation([], queueMove as any).accepted, true);
  for (const type of COMMON_OPERATION_TYPES.filter((candidate) => candidate !== 'node.move')) {
    const item = clone(queueMove) as any;
    item.id = `offline-${type}`;
    item.operation.opId = item.id;
    item.operation.type = type;
    assert.deepEqual(enqueueCollaborationOperation([], item), {
      queue: [], accepted: false, coalesced: false, reason: 'unsupported',
    });
  }
});
