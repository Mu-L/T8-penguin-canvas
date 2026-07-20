const assert = require('node:assert/strict');
const test = require('node:test');

const {
  digestCommonOperationBatch,
  normalizeCommonOperationBatch,
  serializeCommonOperationBatch,
} = require('../backend/src/collaboration/commonOperationProtocol');

const ID = Object.freeze({
  op1: '00000000-0000-4000-8000-000000000001',
  op2: '00000000-0000-4000-8000-000000000002',
  batch: '82000000-0000-4000-8000-000000000001',
  client: '83000000-0000-4000-8000-000000000001',
  thread: '50000000-0000-4000-8000-000000000001',
  comment1: '50000000-0000-4000-8000-000000000002',
  comment2: '50000000-0000-4000-8000-000000000003',
  asset: '40000000-0000-4000-8000-000000000002',
  member: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
});

const HASH = 'c'.repeat(64);

function legacyBatch() {
  return {
    contractVersion: 't8-common-operation-batch-v1',
    projectId: 'project-legacy',
    canvasId: 'canvas-legacy',
    baseRevision: 7,
    batchId: ID.batch,
    clientId: ID.client,
    clientSeq: 1,
    operations: [
      {
        opId: ID.op1,
        type: 'review.thread.create',
        payload: {
          threadUid: ID.thread,
          expectedCanvasRevision: 7,
          anchor: { kind: 'video', targetUid: ID.asset, frameMs: 4_500, assetRevision: 3 },
          severity: 'high',
          initialComment: { commentUid: ID.comment1, body: '第一条审片意见' },
        },
      },
      {
        opId: ID.op2,
        type: 'review.comment.add',
        payload: {
          threadUid: ID.thread,
          commentUid: ID.comment2,
          parentCommentUid: null,
          expectedCanvasRevision: 7,
          expectedThreadRevision: 1,
          body: '旧评论',
        },
      },
    ],
  };
}

function modernBatch() {
  const batch = legacyBatch();
  batch.operations[0].payload.anchor = {
    kind: 'video',
    targetUid: ID.asset,
    frameMs: 4_500,
    assetContentRevision: 9,
    contentHash: HASH,
  };
  batch.operations[0].payload.initialComment = {
    ...batch.operations[0].payload.initialComment,
    mentions: [ID.member.toUpperCase(), ID.member],
    attachments: [{ assetUid: ID.asset, assetContentRevision: 9, contentHash: HASH }],
  };
  batch.operations[1].payload = {
    ...batch.operations[1].payload,
    mentions: [],
    attachments: [{ assetUid: ID.asset, assetContentRevision: 9, contentHash: HASH }],
  };
  return batch;
}

function errorCode(action) {
  try {
    action();
    return null;
  } catch (error) {
    return error?.code;
  }
}

test('F6 protocol preserves the frozen legacy review serialization and digest byte-for-byte', () => {
  const normalized = normalizeCommonOperationBatch(legacyBatch());
  assert.equal(
    digestCommonOperationBatch(legacyBatch()),
    '9b19633faff38657c10ba85d7d8d80d533e2314514144c7f3ecd3b19711341bc',
  );
  assert.equal(Object.hasOwn(normalized.operations[0].payload.initialComment, 'mentions'), false);
  assert.equal(Object.hasOwn(normalized.operations[0].payload.initialComment, 'attachments'), false);
  assert.equal(Object.hasOwn(normalized.operations[1].payload, 'mentions'), false);
  assert.equal(Object.hasOwn(normalized.operations[1].payload, 'attachments'), false);
  assert.deepEqual(normalized.operations[0].payload.anchor, {
    kind: 'video', targetUid: ID.asset, frameMs: 4_500, assetRevision: 3,
  });
  assert.equal(serializeCommonOperationBatch(legacyBatch()).includes('assetContentRevision'), false);
});

test('F6 protocol accepts exact structured references, canonicalizes/deduplicates mentions, and content-pins video', () => {
  const normalized = normalizeCommonOperationBatch(modernBatch());
  const create = normalized.operations[0].payload;
  const comment = normalized.operations[1].payload;
  assert.deepEqual(create.anchor, {
    kind: 'video',
    targetUid: ID.asset,
    frameMs: 4_500,
    assetContentRevision: 9,
    contentHash: HASH,
  });
  assert.deepEqual(create.initialComment.mentions, [ID.member]);
  assert.deepEqual(create.initialComment.attachments, [
    { assetUid: ID.asset, assetContentRevision: 9, contentHash: HASH },
  ]);
  assert.deepEqual(comment.mentions, []);
  assert.deepEqual(comment.attachments, [
    { assetUid: ID.asset, assetContentRevision: 9, contentHash: HASH },
  ]);
});

test('F6 protocol rejects partial/mixed pins, uppercase hashes, duplicate attachments, and limits over 20', () => {
  const partial = modernBatch();
  delete partial.operations[0].payload.anchor.contentHash;
  assert.equal(errorCode(() => normalizeCommonOperationBatch(partial)), 'common_operation_missing_field');

  const mixed = modernBatch();
  mixed.operations[0].payload.anchor.assetRevision = 3;
  assert.equal(errorCode(() => normalizeCommonOperationBatch(mixed)), 'common_operation_extra_field');

  const uppercase = modernBatch();
  uppercase.operations[0].payload.anchor.contentHash = HASH.toUpperCase();
  assert.equal(errorCode(() => normalizeCommonOperationBatch(uppercase)), 'common_operation_string_invalid');

  const duplicateAttachment = modernBatch();
  duplicateAttachment.operations[1].payload.attachments.push(
    structuredClone(duplicateAttachment.operations[1].payload.attachments[0]),
  );
  assert.equal(
    errorCode(() => normalizeCommonOperationBatch(duplicateAttachment)),
    'common_operation_payload_invalid',
  );

  const tooManyMentions = modernBatch();
  tooManyMentions.operations[1].payload.mentions = Array.from({ length: 21 }, (_, index) => (
    `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 1).padStart(12, '0')}`
  ));
  assert.equal(errorCode(() => normalizeCommonOperationBatch(tooManyMentions)), 'common_operation_unsafe_object');

  const tooManyAttachments = modernBatch();
  tooManyAttachments.operations[1].payload.attachments = Array.from({ length: 21 }, () => ({
    assetUid: ID.asset,
    assetContentRevision: 9,
    contentHash: HASH,
  }));
  assert.equal(errorCode(() => normalizeCommonOperationBatch(tooManyAttachments)), 'common_operation_unsafe_object');
});
