import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  digestCommonOperationBatch,
  normalizeCommonOperationBatch,
  serializeCommonOperationBatch,
} from '../src/utils/commonOperationProtocol.ts';

const require = createRequire(import.meta.url);
const backend = require('../backend/src/collaboration/commonOperationProtocol.js');

const ID = Object.freeze({
  op: '00000000-0000-4000-8000-000000000001',
  batch: '82000000-0000-4000-8000-000000000001',
  client: '83000000-0000-4000-8000-000000000001',
  thread: '50000000-0000-4000-8000-000000000001',
  comment: '50000000-0000-4000-8000-000000000002',
  asset: '40000000-0000-4000-8000-000000000002',
  member: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
});

const HASH = 'd'.repeat(64);

function batch(modern: boolean): any {
  return {
    contractVersion: 't8-common-operation-batch-v1',
    projectId: 'project-f6',
    canvasId: 'canvas-f6',
    baseRevision: 7,
    batchId: ID.batch,
    clientId: ID.client,
    clientSeq: 1,
    operations: [{
      opId: ID.op,
      type: 'review.thread.create',
      payload: {
        threadUid: ID.thread,
        expectedCanvasRevision: 7,
        anchor: modern
          ? {
            kind: 'video', targetUid: ID.asset, frameMs: 1_500,
            assetContentRevision: 4, contentHash: HASH,
          }
          : { kind: 'video', targetUid: ID.asset, frameMs: 1_500, assetRevision: 3 },
        severity: 'high',
        initialComment: modern
          ? {
            commentUid: ID.comment,
            body: 'TS/host parity',
            mentions: [ID.member.toUpperCase(), ID.member],
            attachments: [{ assetUid: ID.asset, assetContentRevision: 4, contentHash: HASH }],
          }
          : { commentUid: ID.comment, body: 'TS/host parity' },
      },
    }],
  };
}

function errorCode(action: () => unknown) {
  try {
    action();
    return null;
  } catch (error: any) {
    return error?.code;
  }
}

test('F6 browser and host normalize/serialize/hash both legacy and content-pinned reviews identically', async () => {
  for (const raw of [batch(false), batch(true)]) {
    assert.deepEqual(normalizeCommonOperationBatch(raw), backend.normalizeCommonOperationBatch(raw));
    assert.equal(serializeCommonOperationBatch(raw), backend.serializeCommonOperationBatch(raw));
    assert.equal(await digestCommonOperationBatch(raw), backend.digestCommonOperationBatch(raw));
  }
  const legacy = normalizeCommonOperationBatch(batch(false));
  assert.equal(Object.hasOwn(legacy.operations[0].payload.initialComment, 'mentions'), false);
  assert.equal(Object.hasOwn(legacy.operations[0].payload.initialComment, 'attachments'), false);
});

test('F6 browser and host normalize explicit lifecycle updates identically', () => {
  const raw: any = batch(false);
  raw.operations = [{
    opId: ID.op,
    type: 'review.thread.update',
    payload: {
      threadUid: ID.thread,
      expectedCanvasRevision: 7,
      expectedThreadRevision: 2,
      reviewStatus: 'in_review',
      severity: 'normal',
      decisionCanvasRevision: null,
    },
  }];
  assert.deepEqual(normalizeCommonOperationBatch(raw), backend.normalizeCommonOperationBatch(raw));
  const mixed = structuredClone(raw);
  mixed.operations[0].payload.resolutionStatus = 'open';
  assert.equal(errorCode(() => normalizeCommonOperationBatch(mixed)), 'common_operation_payload_invalid');
  assert.equal(errorCode(() => backend.normalizeCommonOperationBatch(mixed)), 'common_operation_payload_invalid');
});

test('F6 browser and host fail with matching codes for malformed content pins and references', () => {
  const cases: any[] = [];
  const partial = batch(true);
  delete partial.operations[0].payload.anchor.contentHash;
  cases.push(partial);

  const mixed = batch(true);
  mixed.operations[0].payload.anchor.assetRevision = 3;
  cases.push(mixed);

  const uppercase = batch(true);
  uppercase.operations[0].payload.initialComment.attachments[0].contentHash = HASH.toUpperCase();
  cases.push(uppercase);

  const duplicate = batch(true);
  duplicate.operations[0].payload.initialComment.attachments.push(
    structuredClone(duplicate.operations[0].payload.initialComment.attachments[0]),
  );
  cases.push(duplicate);

  for (const raw of cases) {
    const frontendCode = errorCode(() => normalizeCommonOperationBatch(raw));
    const backendCode = errorCode(() => backend.normalizeCommonOperationBatch(raw));
    assert.ok(frontendCode);
    assert.equal(frontendCode, backendCode);
  }
});
