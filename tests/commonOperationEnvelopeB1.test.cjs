const assert = require('node:assert/strict');
const test = require('node:test');

const {
  COMMON_OPERATION_BATCH_CONTRACT,
  COMMON_OPERATION_CONTRACTS,
  COMMON_OPERATION_TYPES,
  CommonOperationProtocolError,
  classifyCommonOperationBatchRetry,
  digestCommonOperationBatch,
  normalizeCommonOperationBatch,
  serializeCommonOperationBatch,
} = require('../backend/src/collaboration/commonOperationProtocol');

const UUIDS = Object.freeze({
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

function opId(index) {
  return `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function batch() {
  return {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: UUIDS.project,
    canvasId: UUIDS.canvas,
    baseRevision: 10,
    batchId: UUIDS.batch,
    clientId: UUIDS.client,
    clientSeq: 42,
    operations: [
      {
        opId: opId(1), type: 'node.add', payload: {
          nodeUid: UUIDS.nodeA.toUpperCase(), displayId: 'node-a', nodeType: 'text',
          position: { x: 1, y: 2 }, data: { label: 'A', nested: { value: 1 } }, expectedAbsent: true,
        },
      },
      {
        opId: opId(2), type: 'node.patch', payload: {
          nodeUid: UUIDS.nodeA, expectedEntityRevision: 7,
          fields: { data: { label: 'B' }, width: 320 }, unsetFields: ['height'],
        },
      },
      {
        opId: opId(3), type: 'node.move', payload: {
          nodeUid: UUIDS.nodeA, expectedEntityRevision: 7, position: { x: 20, y: 30 },
        },
      },
      {
        opId: opId(4), type: 'node.delete', payload: {
          nodeUid: UUIDS.nodeA, expectedEntityRevision: 8,
        },
      },
      {
        opId: opId(5), type: 'node.restore', payload: {
          nodeUid: UUIDS.nodeA, displayId: 'node-a', nodeType: 'text',
          position: { x: 20, y: 30 }, data: { label: 'B' }, expectedTombstoneRevision: 9,
        },
      },
      {
        opId: opId(6), type: 'edge.add', payload: {
          edgeUid: UUIDS.edge, displayId: 'edge-a-b', sourceNodeUid: UUIDS.nodeA,
          targetNodeUid: UUIDS.nodeB, sourceHandle: 'text-out', targetHandle: null,
          edgeType: 'default', data: {}, expectedAbsent: true,
        },
      },
      {
        opId: opId(7), type: 'edge.delete', payload: {
          edgeUid: UUIDS.edge, expectedEntityRevision: 8,
        },
      },
      {
        opId: opId(8), type: 'edge.restore', payload: {
          edgeUid: UUIDS.edge, displayId: 'edge-a-b', sourceNodeUid: UUIDS.nodeA,
          targetNodeUid: UUIDS.nodeB, sourceHandle: 'text-out', targetHandle: null,
          edgeType: 'default', data: {}, expectedTombstoneRevision: 9,
        },
      },
      {
        opId: opId(9), type: 'viewport.set', payload: {
          expectedViewportRevision: 9, viewport: { x: 0, y: 0, zoom: 1.25 },
        },
      },
      {
        opId: opId(10), type: 'review.thread.create', payload: {
          threadUid: UUIDS.thread, expectedCanvasRevision: 10,
          anchor: { kind: 'node', targetUid: UUIDS.nodeA }, severity: 'high',
          initialComment: { commentUid: UUIDS.commentA, body: '请复核标题' },
        },
      },
      {
        opId: opId(11), type: 'review.comment.add', payload: {
          threadUid: UUIDS.thread, commentUid: UUIDS.commentB, parentCommentUid: UUIDS.commentA,
          expectedCanvasRevision: 10, expectedThreadRevision: 9, body: '已复核' },
      },
      {
        opId: opId(12), type: 'review.thread.update', payload: {
          threadUid: UUIDS.thread, expectedCanvasRevision: 10, expectedThreadRevision: 9,
          status: 'approved', severity: 'normal', decisionCanvasRevision: 10,
        },
      },
      {
        opId: opId(13), type: 'subflow.instance.upgrade', payload: {
          instanceUid: UUIDS.instance, definitionUid: UUIDS.definition,
          expectedCanvasRevision: 10, expectedInstanceRevision: 8,
          expectedDefinitionVersion: 1, expectedDefinitionRevision: 4,
          targetDefinitionVersion: 2, targetDefinitionRevision: 1,
          upgradePlanDigest: 'a'.repeat(64),
        },
      },
      {
        opId: opId(14), type: 'host.artifact.commit', payload: {
          artifactUid: UUIDS.artifact, blobUid: UUIDS.blob, runUid: UUIDS.run,
          nodeRunUid: UUIDS.nodeRun, attemptUid: UUIDS.attempt, nodeUid: UUIDS.nodeA,
          expectedCanvasRevision: 10, expectedRunRevision: 3,
          expectedNodeRunRevision: 2, expectedAttemptRevision: 1, outputOrdinal: 0,
          kind: 'image', contentHash: 'B'.repeat(64), byteSize: 1234,
          filename: 'result.png', mimeType: 'image/png',
        },
      },
    ],
  };
}

function clone(value) {
  return structuredClone(value);
}

function errorCode(action) {
  try {
    action();
    return null;
  } catch (error) {
    assert.ok(error instanceof CommonOperationProtocolError);
    return error.code;
  }
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseObjectKeys(item)]));
}

test('B1 common operation batch freezes all graph, review, subflow-upgrade, and host-artifact contracts', () => {
  assert.equal(COMMON_OPERATION_TYPES.length, 14);
  assert.deepEqual(Object.keys(COMMON_OPERATION_CONTRACTS), COMMON_OPERATION_TYPES);
  assert.deepEqual(new Set(Object.values(COMMON_OPERATION_CONTRACTS).map((entry) => entry.domain)), new Set([
    'graph', 'review', 'subflow', 'host-artifact',
  ]));
  for (const type of COMMON_OPERATION_TYPES) {
    assert.ok(COMMON_OPERATION_CONTRACTS[type].revisionScope);
    assert.ok(Array.isArray(COMMON_OPERATION_CONTRACTS[type].identityFields));
    assert.ok(Array.isArray(COMMON_OPERATION_CONTRACTS[type].casFields));
  }

  const normalized = normalizeCommonOperationBatch(batch());
  assert.equal(normalized.operations.length, COMMON_OPERATION_TYPES.length);
  assert.deepEqual(normalized.operations.map((operation) => operation.type), COMMON_OPERATION_TYPES);
  assert.equal(normalized.operations[0].payload.nodeUid, UUIDS.nodeA);
  assert.equal(normalized.operations[13].payload.contentHash, 'b'.repeat(64));
  assert.equal(normalized.operations[9].payload.expectedCanvasRevision, normalized.baseRevision);
});

test('B1 envelope fails closed on missing/extra fields, unsafe prototypes, accessors, and unsafe nested keys', () => {
  const extra = { ...batch(), unexpected: true };
  assert.equal(errorCode(() => normalizeCommonOperationBatch(extra)), 'common_operation_extra_field');

  const missing = batch();
  delete missing.clientId;
  assert.equal(errorCode(() => normalizeCommonOperationBatch(missing)), 'common_operation_missing_field');

  const polluted = batch();
  Object.setPrototypeOf(polluted.operations[0].payload.data, { polluted: true });
  assert.equal(errorCode(() => normalizeCommonOperationBatch(polluted)), 'common_operation_unsafe_object');

  const ownProto = batch();
  ownProto.operations[0].payload.data = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.equal(errorCode(() => normalizeCommonOperationBatch(ownProto)), 'common_operation_unsafe_object');
  assert.equal({}.polluted, undefined);

  const accessor = batch();
  Object.defineProperty(accessor.operations[0].payload.data, 'secret', { enumerable: true, get: () => 'leak' });
  assert.equal(errorCode(() => normalizeCommonOperationBatch(accessor)), 'common_operation_unsafe_object');

  const extendedPayload = batch();
  extendedPayload.operations[2].payload.z = 1;
  assert.equal(errorCode(() => normalizeCommonOperationBatch(extendedPayload)), 'common_operation_extra_field');
});

test('B1 stable UUID, exact integer/string, and per-domain CAS guards reject ambiguous mutations', () => {
  const legacyScopes = batch();
  legacyScopes.projectId = 'project-legacy-display-id';
  legacyScopes.canvasId = 'canvas-legacy-display-id';
  assert.equal(normalizeCommonOperationBatch(legacyScopes).projectId, legacyScopes.projectId);

  const invalidProject = batch();
  invalidProject.projectId = 'project\u0000unsafe';
  assert.equal(errorCode(() => normalizeCommonOperationBatch(invalidProject)), 'common_operation_string_invalid');

  const fractionalSeq = batch();
  fractionalSeq.clientSeq = 1.5;
  assert.equal(errorCode(() => normalizeCommonOperationBatch(fractionalSeq)), 'common_operation_integer_invalid');

  const futureEntity = batch();
  futureEntity.operations[2].payload.expectedEntityRevision = 11;
  assert.equal(errorCode(() => normalizeCommonOperationBatch(futureEntity)), 'common_operation_cas_invalid');

  const staleCommentScope = batch();
  staleCommentScope.operations[10].payload.expectedCanvasRevision = 9;
  assert.equal(errorCode(() => normalizeCommonOperationBatch(staleCommentScope)), 'common_operation_cas_invalid');

  const approvalWithoutRevision = batch();
  approvalWithoutRevision.operations[11].payload.decisionCanvasRevision = null;
  assert.equal(errorCode(() => normalizeCommonOperationBatch(approvalWithoutRevision)), 'common_operation_cas_invalid');

  const downgrade = batch();
  downgrade.operations[12].payload.targetDefinitionVersion = 1;
  downgrade.operations[12].payload.targetDefinitionRevision = 4;
  assert.equal(errorCode(() => normalizeCommonOperationBatch(downgrade)), 'common_operation_cas_invalid');

  const hostPath = batch();
  hostPath.operations[13].payload.filename = 'C:\\secret\\result.png';
  assert.equal(errorCode(() => normalizeCommonOperationBatch(hostPath)), 'common_operation_string_invalid');

  const duplicate = batch();
  duplicate.operations[1].opId = duplicate.operations[0].opId;
  assert.equal(errorCode(() => normalizeCommonOperationBatch(duplicate)), 'common_operation_duplicate_op');
});

test('B1 canonical serialization and SHA-256 bind exact retry content, not object insertion order', () => {
  const original = batch();
  const reorderedKeys = reverseObjectKeys(original);
  assert.equal(serializeCommonOperationBatch(reorderedKeys), serializeCommonOperationBatch(original));
  assert.equal(digestCommonOperationBatch(reorderedKeys), digestCommonOperationBatch(original));
  assert.match(digestCommonOperationBatch(original), /^[0-9a-f]{64}$/);

  const changed = batch();
  changed.operations[2].payload.position.x += 1;
  assert.notEqual(serializeCommonOperationBatch(changed), serializeCommonOperationBatch(original));
  assert.notEqual(digestCommonOperationBatch(changed), digestCommonOperationBatch(original));
});

test('B1 retry classifier distinguishes exact, reorder, subset, superset, and mixed collisions', () => {
  const original = batch();
  assert.equal(classifyCommonOperationBatchRetry(original, clone(original)), 'exact');

  const reordered = batch();
  reordered.operations.reverse();
  assert.equal(classifyCommonOperationBatchRetry(original, reordered), 'reordered');

  const subset = batch();
  subset.operations = subset.operations.slice(0, -1);
  assert.equal(classifyCommonOperationBatchRetry(original, subset), 'subset');

  const superset = batch();
  superset.operations.push({ ...clone(superset.operations[2]), opId: opId(15) });
  assert.equal(classifyCommonOperationBatchRetry(original, superset), 'superset');

  const mixed = batch();
  mixed.operations = [mixed.operations[0], { ...clone(mixed.operations[2]), opId: opId(16) }];
  assert.equal(classifyCommonOperationBatchRetry(original, mixed), 'operation-collision');

  const changed = batch();
  changed.operations[2].payload.position.x += 1;
  assert.equal(classifyCommonOperationBatchRetry(original, changed), 'operation-collision');

  const identityCollision = batch();
  identityCollision.batchId = '00000000-0000-4000-8000-000000000099';
  assert.equal(classifyCommonOperationBatchRetry(original, identityCollision), 'identity-collision');

  const distinct = batch();
  distinct.batchId = '00000000-0000-4000-8000-000000000098';
  distinct.clientId = '00000000-0000-4000-8000-000000000097';
  distinct.clientSeq += 1;
  assert.equal(classifyCommonOperationBatchRetry(original, distinct), 'distinct');
});
