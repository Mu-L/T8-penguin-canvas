const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function requestJson(baseUrl, pathname, options = {}) {
  const method = options.method || 'GET';
  const hasBody = Object.hasOwn(options, 'body');
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: hasBody ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      assert.fail(`Expected JSON from ${method} ${pathname}, received: ${text.slice(0, 500)} (${error.message})`);
    }
  }
  return { response, payload, text };
}

function assertPrivateDataRedacted(payload, forbiddenValues = []) {
  const serialized = JSON.stringify(payload);
  for (const value of forbiddenValues) {
    assert.equal(serialized.includes(String(value)), false, `public response leaked ${value}`);
    assert.equal(serialized.includes(String(value).replace(/\\/g, '/')), false, `public response leaked normalized ${value}`);
  }
  assert.equal(serialized.includes('sk-http-d3-super-secret'), false);
  assert.equal(serialized.includes('Bearer http-d3-secret'), false);
  assert.equal(serialized.includes('managedPath'), false);
  assert.equal(serialized.includes('sourceLocator'), false);
  assert.equal(serialized.includes('sourcePath'), false);
  assert.equal(serialized.includes('apiKey'), false);
  assert.equal(serialized.includes('authorization'), false);
}

test('D3 project-assets HTTP contract is atomic, revisioned, paginated, and path-safe', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-project-assets-d3-http-'));
  const previousPackaged = process.env.T8PC_PACKAGED;
  const previousUserData = process.env.T8PC_USER_DATA;
  process.env.T8PC_PACKAGED = '1';
  process.env.T8PC_USER_DATA = directory;
  fs.mkdirSync(path.join(directory, 'input'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'output'), { recursive: true });

  const config = require('../backend/src/config');
  const router = require('../backend/src/routes/projectAssets');
  const { getProjectDatabase } = require('../backend/src/services/projectDatabase');
  const database = getProjectDatabase(config);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/project-assets', router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/project-assets`;
  const projectId = 'd3-http-project';
  const privateRoot = path.join(directory, 'private-assets');
  fs.mkdirSync(privateRoot, { recursive: true });

  const addAsset = (id, input = {}) => database.upsertAsset({
    id,
    projectId: input.projectId || projectId,
    kind: input.kind || 'image',
    mimeType: input.kind === 'video' ? 'video/mp4' : 'image/png',
    filename: input.filename || `${id}.${input.kind === 'video' ? 'mp4' : 'png'}`,
    managedPath: path.join(privateRoot, `${id}.${input.kind === 'video' ? 'mp4' : 'png'}`),
    sourceUrl: `/api/project-assets/${encodeURIComponent(id)}/media`,
    storageMode: 'linked',
    availability: 'available',
    contentHash: input.contentHash || sha256(id),
    contentHashVerification: input.contentHashVerification || 'verified',
    perceptualHashAlgorithm: input.perceptualHashAlgorithm,
    perceptualHashes: input.perceptualHashes,
    metadata: {
      size: 123,
      sourcePath: path.join(privateRoot, `${id}-metadata.png`),
      apiKey: 'sk-http-d3-super-secret',
      nested: {
        authorization: 'Bearer http-d3-secret',
        signedUrl: 'https://example.invalid/asset?token=http-d3-secret',
        safeLabel: id,
      },
      ...(input.metadata || {}),
    },
    provenance: {
      source: input.source || 'http-fixture',
      localPath: path.join(privateRoot, `${id}-provenance.png`),
      credential: 'http-d3-secret',
    },
  });

  try {
    const exactHashA = 'a'.repeat(64);
    const exactHashB = 'b'.repeat(64);
    const exactA1 = addAsset('http-exact-a1', { contentHash: exactHashA, filename: 'same-name.png' });
    const exactA2 = addAsset('http-exact-a2', { contentHash: exactHashA, filename: 'copy-a.png' });
    addAsset('http-exact-a-legacy', { contentHash: exactHashA, contentHashVerification: 'legacy-unverified' });
    addAsset('http-exact-a-other-project', { projectId: 'd3-http-other-project', contentHash: exactHashA });
    addAsset('http-same-name-different-content', { contentHash: sha256('different-content'), filename: 'same-name.png' });
    addAsset('http-exact-b1', { contentHash: exactHashB });
    addAsset('http-exact-b2', { contentHash: exactHashB });

    const nearSource = addAsset('http-near-source', {
      contentHash: sha256('near-source-content'),
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: '0000000000000000' }],
    });
    const nearTarget = addAsset('http-near-target', {
      contentHash: sha256('near-target-content'),
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: '0000000000000001' }],
    });
    addAsset('http-near-different-algorithm', {
      contentHash: sha256('near-dhash-content'),
      perceptualHashAlgorithm: 'dhash64-v1',
      perceptualHashes: [{ hash: '0000000000000000' }],
    });

    const batchA = addAsset('http-query-batch-a');
    const batchB = addAsset('http-query-batch-b');
    const batchExcluded = addAsset('http-query-batch-excluded');
    addAsset('http-query-batch-other-project', { projectId: 'd3-http-other-project' });

    const graphAssets = Array.from({ length: 6 }, (_, index) => addAsset(`http-graph-${index}`));
    for (let index = 1; index < graphAssets.length; index += 1) {
      database.recordAssetLineageEvent({
        assetId: graphAssets[index].id,
        parentAssetId: graphAssets[index - 1].id,
        sourceType: 'derived',
        derivedOperation: 'http-chain',
        metadata: {
          sourcePath: path.join(privateRoot, `lineage-${index}.png`),
          authorization: 'Bearer http-d3-secret',
          safeIndex: index,
        },
      });
    }

    const lineageAsset = addAsset('http-lineage-page-root');
    const lineageBaseTime = 1_700_100_000_000;
    for (let index = 0; index < 7; index += 1) {
      database.recordAssetLineageEvent({
        assetId: lineageAsset.id,
        sourceType: 'node-output',
        sourceNodeId: `http-lineage-node-${index}`,
        sourceNodeType: 'image',
        derivedOperation: `http-lineage-operation-${index}`,
        createdAt: lineageBaseTime + Math.floor(index / 2),
        metadata: {
          safeIndex: index,
          sourcePath: path.join(privateRoot, `http-lineage-private-${index}.png`),
          authorization: 'Bearer http-d3-secret',
          nested: { apiKey: 'sk-http-d3-super-secret', safeLabel: `lineage-${index}` },
        },
      });
    }

    await t.test('exact duplicate group list/detail cursors remain content-, verification-, and project-scoped', async () => {
      const first = await requestJson(baseUrl, `/duplicate-groups?projectId=${projectId}&limit=1`);
      assert.equal(first.response.status, 200);
      assert.equal(first.payload.success, true);
      assert.equal(first.payload.data.length, 1);
      assert.equal(first.payload.meta.hasMore, true);
      assert.ok(first.payload.meta.nextCursor);
      assertPrivateDataRedacted(first.payload, [privateRoot]);

      const second = await requestJson(baseUrl, `/duplicate-groups?projectId=${projectId}&limit=1&cursor=${encodeURIComponent(first.payload.meta.nextCursor)}`);
      assert.equal(second.response.status, 200);
      assert.equal(second.payload.data.length, 1);
      assert.notEqual(second.payload.data[0].contentHash, first.payload.data[0].contentHash);
      assert.equal(second.payload.meta.hasMore, false);

      const groups = [...first.payload.data, ...second.payload.data];
      const groupA = groups.find((group) => group.contentHash === exactHashA);
      assert.ok(groupA);
      assert.equal(groupA.memberCount, 2);
      assert.deepEqual(groupA.members.map((asset) => asset.id).sort(), [exactA1.id, exactA2.id].sort());
      assert.equal(groupA.members.some((asset) => asset.id === 'http-exact-a-legacy'), false);
      assert.equal(groupA.members.some((asset) => asset.id === 'http-exact-a-other-project'), false);
      assert.equal(groupA.members.some((asset) => asset.id === 'http-same-name-different-content'), false);

      const detailFirst = await requestJson(baseUrl, `/duplicate-groups/${encodeURIComponent(groupA.id)}?projectId=${projectId}&limit=1`);
      assert.equal(detailFirst.response.status, 200);
      assert.equal(detailFirst.payload.data.members.length, 1);
      assert.equal(detailFirst.payload.data.memberCount, 2);
      assert.ok(detailFirst.payload.meta.nextCursor);
      const detailSecond = await requestJson(baseUrl, `/duplicate-groups/${encodeURIComponent(groupA.id)}?projectId=${projectId}&limit=1&cursor=${encodeURIComponent(detailFirst.payload.meta.nextCursor)}`);
      assert.equal(detailSecond.response.status, 200);
      assert.equal(detailSecond.payload.data.members.length, 1);
      assert.notEqual(detailSecond.payload.data.members[0].id, detailFirst.payload.data.members[0].id);
      assert.equal(detailSecond.payload.meta.hasMore, false);
    });

    await t.test('near/exact duplicate discovery is public-safe and decisions use optimistic CAS', async () => {
      const near = await requestJson(baseUrl, `/${nearSource.id}/duplicates?mode=near&maxDistance=1&limit=50`);
      assert.equal(near.response.status, 200);
      const candidate = near.payload.data.find((item) => item.asset.id === nearTarget.id);
      assert.ok(candidate);
      assert.equal(candidate.type, 'near');
      assert.equal(candidate.algorithm, 'phash-dct64-v1');
      assert.equal(candidate.decision, 'pending');
      assert.equal(candidate.decisionRevision, 1);
      assert.equal(near.payload.data.some((item) => item.asset.id === 'http-near-different-algorithm'), false);
      assertPrivateDataRedacted(near.payload, [privateRoot]);

      const missingDecisionRevision = await requestJson(baseUrl, `/duplicate-candidates/${candidate.id}/decision`, {
        method: 'PUT', body: { projectId, decision: 'dismissed' },
      });
      assert.equal(missingDecisionRevision.response.status, 400);
      assert.equal(missingDecisionRevision.payload.code, 'expected_revision_required');

      const decided = await requestJson(baseUrl, `/duplicate-candidates/${candidate.id}/decision`, {
        method: 'PUT',
        body: { projectId, decision: 'dismissed', expectedRevision: candidate.decisionRevision, actorId: 'http-reviewer' },
      });
      assert.equal(decided.response.status, 200);
      assert.equal(decided.payload.data.decision, 'dismissed');
      assert.equal(decided.payload.data.revision, 2);
      assert.equal(decided.payload.data.decidedBy, 'http-reviewer');

      const stale = await requestJson(baseUrl, `/duplicate-candidates/${candidate.id}/decision`, {
        method: 'PUT',
        body: { projectId, decision: 'confirmed', expectedRevision: 1, actorId: 'stale-reviewer' },
      });
      assert.equal(stale.response.status, 409);
      assert.equal(stale.payload.success, false);
      assert.equal(stale.payload.code, 'asset_duplicate_revision_conflict');
      assert.equal(stale.payload.current.revision, 2);

      const exact = await requestJson(baseUrl, `/${exactA1.id}/duplicates?mode=exact&limit=50`);
      assert.equal(exact.response.status, 200);
      assert.deepEqual(exact.payload.data.map((item) => item.asset.id), [exactA2.id]);
      assert.equal(exact.payload.data[0].evidence.verification, 'verified');
      assertPrivateDataRedacted(exact.payload, [privateRoot]);
    });

    await t.test('lineage cursor pages are stable, bounded, revision-bound, and recursively public-safe', async () => {
      const first = await requestJson(baseUrl, `/${lineageAsset.id}/lineage?limit=2`);
      assert.equal(first.response.status, 200);
      assert.equal(first.payload.success, true);
      assert.equal(first.payload.data.length, 2);
      assert.equal(first.payload.meta.total, 7);
      assert.equal(first.payload.meta.limit, 2);
      assert.equal(first.payload.meta.hasMore, true);
      assert.ok(first.payload.meta.nextCursor);
      assert.equal(typeof first.payload.meta.lineageRevision, 'string');
      assert.equal(first.payload.meta.lineageRevision.length > 0, true);
      assertPrivateDataRedacted(first.payload, [privateRoot]);
      assert.equal(first.payload.data.every((event) => Number.isInteger(event.metadata.safeIndex)), true);

      const unrelatedAsset = addAsset('http-lineage-unrelated-same-project');
      const unrelatedWrite = await requestJson(baseUrl, `/${unrelatedAsset.id}/lineage`, {
        method: 'POST',
        body: {
          sourceType: 'unrelated-node-output',
          sourceNodeId: 'http-unrelated-lineage-node',
          sourceNodeType: 'image',
          derivedOperation: 'http-unrelated-lineage-operation',
          createdAt: lineageBaseTime + 1_000,
          metadata: {
            safe: true,
            sourcePath: path.join(privateRoot, 'unrelated-lineage-private.png'),
            authorization: 'Bearer http-d3-secret',
          },
        },
      });
      assert.equal(unrelatedWrite.response.status, 201);
      assertPrivateDataRedacted(unrelatedWrite.payload, [privateRoot]);
      const afterUnrelated = await requestJson(
        baseUrl,
        `/${lineageAsset.id}/lineage?limit=2&cursor=${encodeURIComponent(first.payload.meta.nextCursor)}`,
      );
      assert.equal(afterUnrelated.response.status, 200, 'same-project lineage on another asset must not invalidate this cursor');
      assert.equal(afterUnrelated.payload.meta.lineageRevision, first.payload.meta.lineageRevision);

      const retryWrite = await requestJson(baseUrl, `/${lineageAsset.id}/lineage`, {
        method: 'POST',
        body: {
          sourceType: 'node-output',
          sourceNodeId: 'http-lineage-node-0',
          sourceNodeType: 'image',
          derivedOperation: 'http-lineage-operation-0',
          // Identity fields match the existing event. These changed fields
          // prove INSERT OR IGNORE does not mutate or revise it.
          createdAt: lineageBaseTime + 2_000,
          metadata: {
            retryMustNotOverwrite: true,
            sourcePath: path.join(privateRoot, 'retry-lineage-private.png'),
            apiKey: 'sk-http-d3-super-secret',
          },
        },
      });
      assert.equal(retryWrite.response.status, 201);
      assert.equal(retryWrite.payload.data.length, 7);
      assert.equal(JSON.stringify(retryWrite.payload).includes('retryMustNotOverwrite'), false);
      assertPrivateDataRedacted(retryWrite.payload, [privateRoot]);
      const afterRetry = await requestJson(
        baseUrl,
        `/${lineageAsset.id}/lineage?limit=2&cursor=${encodeURIComponent(first.payload.meta.nextCursor)}`,
      );
      assert.equal(afterRetry.response.status, 200, 'idempotent lineage retries must preserve existing cursors');
      assert.equal(afterRetry.payload.meta.total, 7);
      assert.equal(afterRetry.payload.meta.lineageRevision, first.payload.meta.lineageRevision);

      const expectedIds = database.getAssetLineage(lineageAsset.id).map((event) => event.id);
      const collectedIds = [];
      let page = first;
      for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
        assert.equal(page.response.status, 200);
        assert.equal(page.payload.data.length <= 2, true);
        assert.equal(page.payload.meta.lineageRevision, first.payload.meta.lineageRevision);
        collectedIds.push(...page.payload.data.map((event) => event.id));
        assert.equal(new Set(collectedIds).size, collectedIds.length, 'HTTP lineage pages must not repeat events');
        assertPrivateDataRedacted(page.payload, [privateRoot]);
        if (!page.payload.meta.nextCursor) break;
        page = await requestJson(
          baseUrl,
          `/${lineageAsset.id}/lineage?limit=2&cursor=${encodeURIComponent(page.payload.meta.nextCursor)}`,
        );
        assert.notEqual(pageIndex, 9, 'HTTP lineage cursor must converge');
      }
      assert.deepEqual(collectedIds, expectedIds, 'HTTP pages preserve DB created_at DESC, id DESC order without gaps');

      const bounded = await requestJson(baseUrl, `/${lineageAsset.id}/lineage?limit=10000`);
      assert.equal(bounded.response.status, 200);
      assert.equal(bounded.payload.meta.limit, 100);
      assert.equal(bounded.payload.data.length, 7);
      assertPrivateDataRedacted(bounded.payload, [privateRoot]);

      const wrongAsset = await requestJson(
        baseUrl,
        `/${nearSource.id}/lineage?limit=2&cursor=${encodeURIComponent(first.payload.meta.nextCursor)}`,
      );
      assert.equal(wrongAsset.response.status, 409);
      assert.equal(wrongAsset.payload.code, 'asset_lineage_revision_conflict');
      assert.equal(wrongAsset.payload.current.assetId, nearSource.id);
      assertPrivateDataRedacted(wrongAsset.payload, [privateRoot]);

      const changedLimit = await requestJson(
        baseUrl,
        `/${lineageAsset.id}/lineage?limit=3&cursor=${encodeURIComponent(first.payload.meta.nextCursor)}`,
      );
      assert.equal(changedLimit.response.status, 409);
      assert.equal(changedLimit.payload.code, 'asset_lineage_revision_conflict');

      database.recordAssetLineageEvent({
        assetId: lineageAsset.id,
        sourceType: 'node-output',
        sourceNodeId: 'http-lineage-node-added-after-cursor',
        sourceNodeType: 'image',
        derivedOperation: 'http-lineage-operation-added-after-cursor',
        createdAt: lineageBaseTime + 100,
        metadata: {
          safeIndex: 99,
          sourcePath: path.join(privateRoot, 'http-lineage-added-private.png'),
          authorization: 'Bearer http-d3-secret',
        },
      });
      const stale = await requestJson(
        baseUrl,
        `/${lineageAsset.id}/lineage?limit=2&cursor=${encodeURIComponent(first.payload.meta.nextCursor)}`,
      );
      assert.equal(stale.response.status, 409);
      assert.equal(stale.payload.success, false);
      assert.equal(stale.payload.code, 'asset_lineage_revision_conflict');
      assert.equal(stale.payload.current.assetId, lineageAsset.id);
      assert.notEqual(stale.payload.current.lineageRevision, first.payload.meta.lineageRevision);
      assertPrivateDataRedacted(stale.payload, [privateRoot]);

      const refreshed = await requestJson(baseUrl, `/${lineageAsset.id}/lineage?limit=2`);
      assert.equal(refreshed.response.status, 200);
      assert.equal(refreshed.payload.meta.total, 8);
      assert.notEqual(refreshed.payload.meta.lineageRevision, first.payload.meta.lineageRevision);
      assert.equal(refreshed.payload.data[0].sourceNodeId, 'http-lineage-node-added-after-cursor');
      assertPrivateDataRedacted(refreshed.payload, [privateRoot]);
    });

    await t.test('negative historical lineage timestamps remain valid cursor positions', async () => {
      const negativeAsset = addAsset('http-lineage-negative-history');
      for (let index = 0; index < 4; index += 1) {
        database.recordAssetLineageEvent({
          assetId: negativeAsset.id,
          sourceType: 'historical-import',
          sourceNodeId: `http-negative-lineage-node-${index}`,
          sourceNodeType: 'image',
          derivedOperation: `http-negative-lineage-operation-${index}`,
          metadata: {
            safeIndex: index,
            sourcePath: path.join(privateRoot, `negative-lineage-${index}.png`),
          },
          createdAt: -(index + 1),
        });
      }
      const first = await requestJson(baseUrl, `/${negativeAsset.id}/lineage?limit=2`);
      assert.equal(first.response.status, 200);
      assert.deepEqual(first.payload.data.map((event) => event.createdAt), [-1, -2]);
      assert.equal(first.payload.meta.hasMore, true);
      assert.ok(first.payload.meta.nextCursor);
      assertPrivateDataRedacted(first.payload, [privateRoot]);

      const second = await requestJson(
        baseUrl,
        `/${negativeAsset.id}/lineage?limit=2&cursor=${encodeURIComponent(first.payload.meta.nextCursor)}`,
      );
      assert.equal(second.response.status, 200, 'negative createdAt is a finite valid keyset value, not a malformed cursor');
      assert.deepEqual(second.payload.data.map((event) => event.createdAt), [-3, -4]);
      assert.equal(second.payload.meta.hasMore, false);
      assert.equal(second.payload.meta.nextCursor, null);
      assert.equal(second.payload.meta.lineageRevision, first.payload.meta.lineageRevision);
      assertPrivateDataRedacted(second.payload, [privateRoot]);
    });

    await t.test('project B assetId reuse cannot read project A tombstoned lineage through GET, POST, or list', async () => {
      const sharedId = 'http-lineage-cross-project-reused-id';
      const projectAId = 'http-lineage-project-a';
      const projectBId = 'http-lineage-project-b';
      const projectAAsset = addAsset(sharedId, { projectId: projectAId, contentHash: sha256('project-a-reused-id') });
      database.recordAssetLineageEvent({
        assetId: projectAAsset.id,
        sourceType: 'project-a-private-history',
        sourceNodeId: 'http-project-a-private-node',
        sourceNodeType: 'image',
        derivedOperation: 'http-project-a-private-operation',
        createdAt: 100,
        metadata: {
          project: 'A',
          sourcePath: path.join(privateRoot, 'project-a-private-lineage.png'),
          authorization: 'Bearer http-d3-secret',
        },
      });
      const beforeDelete = await requestJson(baseUrl, `/${sharedId}/lineage?limit=10`);
      assert.equal(beforeDelete.response.status, 200);
      assert.deepEqual(beforeDelete.payload.data.map((event) => event.sourceNodeId), ['http-project-a-private-node']);
      assertPrivateDataRedacted(beforeDelete.payload, [privateRoot]);

      database.removeAssetIndex(sharedId);
      const whileTombstoned = await requestJson(baseUrl, `/${sharedId}/lineage?limit=10`);
      assert.equal(whileTombstoned.response.status, 404);
      const projectBAsset = addAsset(sharedId, { projectId: projectBId, contentHash: sha256('project-b-reused-id') });

      const projectBInitial = await requestJson(baseUrl, `/${sharedId}/lineage?limit=10`);
      assert.equal(projectBInitial.response.status, 200);
      assert.equal(projectBInitial.payload.meta.total, 0);
      assert.deepEqual(projectBInitial.payload.data, []);
      assert.equal(JSON.stringify(projectBInitial.payload).includes('http-project-a-private-node'), false);

      const projectBWrite = await requestJson(baseUrl, `/${sharedId}/lineage`, {
        method: 'POST',
        body: {
          // A forged projectId must not change the current asset-owned scope.
          projectId: projectAId,
          sourceType: 'project-b-visible-history',
          sourceNodeId: 'http-project-b-visible-node',
          sourceNodeType: 'image',
          derivedOperation: 'http-project-b-visible-operation',
          createdAt: 200,
          metadata: { project: 'B', safe: true },
        },
      });
      assert.equal(projectBWrite.response.status, 201);
      assert.deepEqual(projectBWrite.payload.data.map((event) => event.sourceNodeId), ['http-project-b-visible-node']);
      assert.equal(JSON.stringify(projectBWrite.payload).includes('http-project-a-private-node'), false);

      const projectBGet = await requestJson(baseUrl, `/${sharedId}/lineage?limit=10`);
      assert.equal(projectBGet.response.status, 200);
      assert.equal(projectBGet.payload.meta.total, 1);
      assert.deepEqual(projectBGet.payload.data.map((event) => event.sourceNodeId), ['http-project-b-visible-node']);
      assert.equal(JSON.stringify(projectBGet.payload).includes('http-project-a-private-node'), false);
      assert.deepEqual(database.listAssetLineage(projectBAsset.id, { limit: 10 }).items.map((event) => event.sourceNodeId), ['http-project-b-visible-node']);
      assert.deepEqual(database.getAssetLineage(projectBAsset.id).map((event) => event.sourceNodeId), ['http-project-b-visible-node']);
      assertPrivateDataRedacted(projectBGet.payload, [privateRoot]);
    });

    await t.test('collection CRUD and membership writes reject stale revisions with 409', async () => {
      const created = await requestJson(baseUrl, '/collections', {
        method: 'POST',
        body: { projectId, name: 'HTTP Collection', description: 'created by integration test', createdBy: 'http-owner' },
      });
      assert.equal(created.response.status, 201);
      assert.equal(created.payload.data.revision, 1);
      const collectionId = created.payload.data.id;

      const missingPatchRevision = await requestJson(baseUrl, `/collections/${collectionId}`, {
        method: 'PATCH', body: { projectId, name: 'must-not-write-without-cas' },
      });
      assert.equal(missingPatchRevision.response.status, 400);
      assert.equal(missingPatchRevision.payload.code, 'expected_revision_required');

      const renamed = await requestJson(baseUrl, `/collections/${collectionId}`, {
        method: 'PATCH',
        body: { projectId, name: 'HTTP Collection Renamed', expectedRevision: 1 },
      });
      assert.equal(renamed.response.status, 200);
      assert.equal(renamed.payload.data.revision, 2);

      const staleRename = await requestJson(baseUrl, `/collections/${collectionId}`, {
        method: 'PATCH',
        body: { projectId, name: 'must-not-win', expectedRevision: 1 },
      });
      assert.equal(staleRename.response.status, 409);
      assert.equal(staleRename.payload.code, 'asset_collection_revision_conflict');
      assert.equal(staleRename.payload.current.revision, 2);

      const missingMemberRevision = await requestJson(baseUrl, `/collections/${collectionId}/members/${exactA1.id}`, {
        method: 'POST', body: {},
      });
      assert.equal(missingMemberRevision.response.status, 400);
      assert.equal(missingMemberRevision.payload.code, 'expected_revision_required');

      const added = await requestJson(baseUrl, `/collections/${collectionId}/members/${exactA1.id}`, {
        method: 'POST', body: { expectedRevision: 2 },
      });
      assert.equal(added.response.status, 200);
      assert.deepEqual(added.payload.data.collectionIds, [collectionId]);
      assertPrivateDataRedacted(added.payload, [privateRoot]);

      const staleAdd = await requestJson(baseUrl, `/collections/${collectionId}/members/${exactA2.id}`, {
        method: 'POST', body: { expectedRevision: 2 },
      });
      assert.equal(staleAdd.response.status, 409);
      assert.equal(database.getAsset(exactA2.id).collectionIds.includes(collectionId), false);

      const missingReplaceRevision = await requestJson(baseUrl, `/collections/${collectionId}/members`, {
        method: 'PUT', body: { assetIds: [exactA2.id] },
      });
      assert.equal(missingReplaceRevision.response.status, 400);
      assert.equal(missingReplaceRevision.payload.code, 'expected_revision_required');

      const replaced = await requestJson(baseUrl, `/collections/${collectionId}/members`, {
        method: 'PUT', body: { assetIds: [exactA1.id, exactA2.id], expectedRevision: 3 },
      });
      assert.equal(replaced.response.status, 200);
      assert.deepEqual(replaced.payload.data.map((asset) => asset.id).sort(), [exactA1.id, exactA2.id].sort());

      const missingRemoveRevision = await requestJson(baseUrl, `/collections/${collectionId}/members/${exactA1.id}`, {
        method: 'DELETE', body: {},
      });
      assert.equal(missingRemoveRevision.response.status, 400);
      assert.equal(missingRemoveRevision.payload.code, 'expected_revision_required');

      const removed = await requestJson(baseUrl, `/collections/${collectionId}/members/${exactA1.id}`, {
        method: 'DELETE', body: { expectedRevision: 4 },
      });
      assert.equal(removed.response.status, 200);
      assert.equal(removed.payload.data.collectionIds.includes(collectionId), false);

      const missingDeleteRevision = await requestJson(baseUrl, `/collections/${collectionId}`, {
        method: 'DELETE', body: { projectId },
      });
      assert.equal(missingDeleteRevision.response.status, 400);
      assert.equal(missingDeleteRevision.payload.code, 'expected_revision_required');

      const staleDelete = await requestJson(baseUrl, `/collections/${collectionId}`, {
        method: 'DELETE', body: { projectId, expectedRevision: 4 },
      });
      assert.equal(staleDelete.response.status, 409);
      const currentCollections = await requestJson(baseUrl, `/collections?projectId=${projectId}`);
      const current = currentCollections.payload.data.find((collection) => collection.id === collectionId);
      assert.equal(current.revision, 5);
      assert.equal(current.assetCount, 1);

      const deleted = await requestJson(baseUrl, `/collections/${collectionId}`, {
        method: 'DELETE', body: { projectId, expectedRevision: 5 },
      });
      assert.equal(deleted.response.status, 200);
      assert.equal(deleted.payload.data.id, collectionId);
    });

    await t.test('explicit/query batches are idempotent, catalog-bound, and fail atomically', async () => {
      const explicitBody = {
        projectId,
        actorId: 'http-batch-owner',
        idempotencyKey: 'http-explicit-tags-v1',
        selection: { assetIds: [batchA.id, batchB.id] },
        expectedRevisions: {
          [batchA.id]: batchA.organizationRevision,
          [batchB.id]: batchB.organizationRevision,
        },
        operation: { type: 'tags.add', tags: ['http-approved'] },
      };
      const applied = await requestJson(baseUrl, '/batch', { method: 'POST', body: explicitBody });
      assert.equal(applied.response.status, 200);
      assert.equal(applied.payload.data.affectedCount, 2);
      assert.equal(applied.payload.data.idempotent, false);

      const replay = await requestJson(baseUrl, '/batch', { method: 'POST', body: explicitBody });
      assert.equal(replay.response.status, 200);
      assert.equal(replay.payload.data.idempotent, true);
      assert.deepEqual(replay.payload.data.organizationRevisions, applied.payload.data.organizationRevisions);

      const keyConflict = await requestJson(baseUrl, '/batch', {
        method: 'POST',
        body: { ...explicitBody, operation: { type: 'tags.add', tags: ['must-not-write-key-conflict'] } },
      });
      assert.equal(keyConflict.response.status, 409);
      assert.equal(database.listAssets({ projectId, tag: 'must-not-write-key-conflict' }).length, 0);

      const currentA = database.getAsset(batchA.id);
      const staleAtomic = await requestJson(baseUrl, '/batch', {
        method: 'POST',
        body: {
          projectId,
          idempotencyKey: 'http-stale-explicit-v1',
          selection: { assetIds: [batchA.id, batchB.id] },
          expectedRevisions: {
            [batchA.id]: currentA.organizationRevision,
            [batchB.id]: batchB.organizationRevision,
          },
          operation: { type: 'tags.add', tags: ['must-rollback'] },
        },
      });
      assert.equal(staleAtomic.response.status, 409);
      assert.equal(database.listAssets({ projectId, tag: 'must-rollback' }).length, 0);

      const crossProjectAtomic = await requestJson(baseUrl, '/batch', {
        method: 'POST',
        body: {
          projectId,
          idempotencyKey: 'http-cross-project-v1',
          selection: { assetIds: [batchA.id, 'http-query-batch-other-project'] },
          expectedRevisions: {
            [batchA.id]: currentA.organizationRevision,
            'http-query-batch-other-project': 1,
          },
          operation: { type: 'tags.add', tags: ['must-rollback-cross-project'] },
        },
      });
      assert.equal(crossProjectAtomic.response.status, 400);
      assert.equal(database.listAssets({ projectId, tag: 'must-rollback-cross-project' }).length, 0);

      const queryList = await requestJson(baseUrl, `/?projectId=${projectId}&query=http-query-batch&limit=100`);
      assert.equal(queryList.response.status, 200);
      const queryApplied = await requestJson(baseUrl, '/batch', {
        method: 'POST',
        body: {
          projectId,
          idempotencyKey: 'http-query-tags-v1',
          selection: {
            query: { query: 'http-query-batch' },
            catalogRevision: queryList.payload.meta.catalogRevision,
            exclusions: [batchExcluded.id],
          },
          operation: { type: 'tags.add', tags: ['http-query-selected'] },
        },
      });
      assert.equal(queryApplied.response.status, 200);
      assert.equal(queryApplied.payload.data.selectionMode, 'query');
      assert.equal(queryApplied.payload.data.affectedCount, 2);
      assert.deepEqual(
        database.listAssets({ projectId, tag: 'http-query-selected' }).map((asset) => asset.id).sort(),
        [batchA.id, batchB.id].sort(),
      );

      const staleList = await requestJson(baseUrl, `/?projectId=${projectId}&query=http-query-batch&limit=100`);
      const excludedCurrent = database.getAsset(batchExcluded.id);
      const missingTagRevision = await requestJson(baseUrl, `/${batchExcluded.id}/tags`, {
        method: 'PUT', body: { tags: ['must-not-write-without-cas'] },
      });
      assert.equal(missingTagRevision.response.status, 400);
      assert.equal(missingTagRevision.payload.code, 'expected_revision_required');
      const mutation = await requestJson(baseUrl, `/${batchExcluded.id}/tags`, {
        method: 'PUT', body: { tags: ['catalog-mutated'], expectedRevision: excludedCurrent.organizationRevision },
      });
      assert.equal(mutation.response.status, 200);
      const staleQuery = await requestJson(baseUrl, '/batch', {
        method: 'POST',
        body: {
          projectId,
          idempotencyKey: 'http-stale-query-v1',
          selection: {
            query: { query: 'http-query-batch' },
            catalogRevision: staleList.payload.meta.catalogRevision,
            exclusions: [],
          },
          operation: { type: 'tags.add', tags: ['must-not-write-stale-query'] },
        },
      });
      assert.equal(staleQuery.response.status, 409);
      assert.equal(database.listAssets({ projectId, tag: 'must-not-write-stale-query' }).length, 0);

      const sourceCollection = await requestJson(baseUrl, '/collections', {
        method: 'POST', body: { projectId, name: 'HTTP Move Source' },
      });
      const targetCollection = await requestJson(baseUrl, '/collections', {
        method: 'POST', body: { projectId, name: 'HTTP Move Target' },
      });
      assert.equal(sourceCollection.response.status, 201);
      assert.equal(targetCollection.response.status, 201);
      const seededSource = await requestJson(baseUrl, `/collections/${sourceCollection.payload.data.id}/members`, {
        method: 'PUT',
        body: { assetIds: [batchA.id, batchB.id], expectedRevision: sourceCollection.payload.data.revision },
      });
      assert.equal(seededSource.response.status, 200);
      const moveCurrentA = database.getAsset(batchA.id);
      const moveCurrentB = database.getAsset(batchB.id);
      const moved = await requestJson(baseUrl, '/batch', {
        method: 'POST',
        body: {
          projectId,
          idempotencyKey: 'http-collection-move-v1',
          selection: { assetIds: [batchA.id, batchB.id] },
          expectedRevisions: {
            [batchA.id]: moveCurrentA.organizationRevision,
            [batchB.id]: moveCurrentB.organizationRevision,
          },
          operation: {
            type: 'collection.move',
            fromCollectionIds: [sourceCollection.payload.data.id],
            toCollectionId: targetCollection.payload.data.id,
          },
        },
      });
      assert.equal(moved.response.status, 200);
      assert.equal(moved.payload.data.affectedCount, 2);
      assert.deepEqual(database.listAssets({ projectId, collectionId: sourceCollection.payload.data.id }), []);
      assert.deepEqual(
        database.listAssets({ projectId, collectionId: targetCollection.payload.data.id }).map((asset) => asset.id).sort(),
        [batchA.id, batchB.id].sort(),
      );
    });

    await t.test('source-tree cursor converges, rejects graph changes, and recursively sanitizes nodes/edges', async () => {
      const first = await requestJson(baseUrl, `/${graphAssets[0].id}/source-tree?direction=descendants&maxDepth=10&maxNodes=3`);
      assert.equal(first.response.status, 200);
      assert.equal(first.payload.data.truncated, true);
      assert.ok(first.payload.data.nextCursor);
      assertPrivateDataRedacted(first.payload, [privateRoot]);

      const addedGraphAsset = addAsset('http-graph-added-after-cursor');
      database.recordAssetLineageEvent({
        assetId: addedGraphAsset.id,
        parentAssetId: graphAssets[0].id,
        sourceType: 'derived',
        derivedOperation: 'cursor-invalidation',
        metadata: { sourcePath: path.join(privateRoot, 'cursor-invalidation.png') },
      });
      const stale = await requestJson(baseUrl, `/${graphAssets[0].id}/source-tree?direction=descendants&maxDepth=10&maxNodes=3&cursor=${encodeURIComponent(first.payload.data.nextCursor)}`);
      assert.equal(stale.response.status, 409);
      assert.equal(stale.payload.success, false);
      assert.equal(stale.payload.code, 'asset_source_graph_revision_conflict');
      assert.equal(typeof stale.payload.current.graphRevision, 'string');
      assertPrivateDataRedacted(stale.payload, [privateRoot]);

      const nodes = new Map();
      const edges = new Map();
      let cursor = null;
      for (let pageIndex = 0; pageIndex < 30; pageIndex += 1) {
        const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const page = await requestJson(baseUrl, `/${graphAssets[0].id}/source-tree?direction=descendants&maxDepth=10&maxNodes=3${query}`);
        assert.equal(page.response.status, 200);
        assert.equal(page.payload.data.nodes.length <= 3, true);
        page.payload.data.nodes.forEach((node) => nodes.set(node.id, node));
        page.payload.data.edges.forEach((edge) => edges.set(edge.id, edge));
        assertPrivateDataRedacted(page.payload, [privateRoot]);
        cursor = page.payload.data.nextCursor;
        if (!cursor) break;
        assert.notEqual(pageIndex, 29, 'HTTP source-tree cursor must converge');
      }
      assert.deepEqual(
        [...nodes.keys()].sort(),
        [...graphAssets.map((asset) => asset.id), addedGraphAsset.id].sort(),
      );
      assert.equal(edges.size, graphAssets.length);
      for (const edge of edges.values()) {
        assert.equal(nodes.has(edge.sourceAssetId), true);
        assert.equal(nodes.has(edge.targetAssetId), true);
      }
    });

    await t.test('permission policy normalizes grants, rejects unknown permissions, and enforces CAS', async () => {
      const organizationRevisionBeforeAcl = database.getAsset(nearTarget.id).organizationRevision;
      const initial = await requestJson(baseUrl, `/${nearTarget.id}/permissions`);
      assert.equal(initial.response.status, 200);
      assert.equal(initial.payload.data.scope, 'project');
      assert.equal(initial.payload.data.revision, 1);

      const missingPermissionRevision = await requestJson(baseUrl, `/${nearTarget.id}/permissions`, {
        method: 'PUT', body: { scope: 'restricted', grants: [] },
      });
      assert.equal(missingPermissionRevision.response.status, 400);
      assert.equal(missingPermissionRevision.payload.code, 'expected_revision_required');

      const updated = await requestJson(baseUrl, `/${nearTarget.id}/permissions`, {
        method: 'PUT',
        body: {
          scope: 'restricted',
          expectedRevision: 1,
          actorId: 'http-acl-owner',
          grants: [{
            principalType: 'MEMBER',
            principalId: '  alice  ',
            permissions: ['view', 'preview', 'view'],
          }],
        },
      });
      assert.equal(updated.response.status, 200);
      assert.equal(updated.payload.data.scope, 'restricted');
      assert.equal(updated.payload.data.revision, 2);
      assert.deepEqual(updated.payload.data.grants, [{
        principalType: 'member',
        principalId: 'alice',
        permissions: ['preview', 'view'],
        grantedBy: 'http-acl-owner',
        createdAt: updated.payload.data.grants[0].createdAt,
      }]);

      const staleOrganizationWrite = await requestJson(baseUrl, `/${nearTarget.id}/tags`, {
        method: 'PUT', body: { tags: ['stale-after-acl'], expectedRevision: organizationRevisionBeforeAcl },
      });
      assert.equal(staleOrganizationWrite.response.status, 409);
      const freshAsset = await requestJson(baseUrl, `/${nearTarget.id}`);
      assert.equal(freshAsset.response.status, 200);
      assert.equal(freshAsset.payload.data.organizationRevision, organizationRevisionBeforeAcl + 1);
      const freshOrganizationWrite = await requestJson(baseUrl, `/${nearTarget.id}/tags`, {
        method: 'PUT', body: { tags: ['fresh-after-acl'], expectedRevision: freshAsset.payload.data.organizationRevision },
      });
      assert.equal(freshOrganizationWrite.response.status, 200);
      assert.deepEqual(freshOrganizationWrite.payload.data.tags, ['fresh-after-acl']);

      const stale = await requestJson(baseUrl, `/${nearTarget.id}/permissions`, {
        method: 'PUT',
        body: { scope: 'project', expectedRevision: 1, actorId: 'stale-owner', grants: [] },
      });
      assert.equal(stale.response.status, 409);
      assert.equal(stale.payload.code, 'asset_access_revision_conflict');
      assert.equal(stale.payload.current.revision, 2);

      const invalid = await requestJson(baseUrl, `/${nearTarget.id}/permissions`, {
        method: 'PUT',
        body: {
          scope: 'restricted',
          expectedRevision: 2,
          actorId: 'invalid-owner',
          grants: [{ principalType: 'member', principalId: 'alice', permissions: ['view', 'download'] }],
        },
      });
      assert.equal(invalid.response.status, 400);
      const afterInvalid = await requestJson(baseUrl, `/${nearTarget.id}/permissions`);
      assert.equal(afterInvalid.payload.data.revision, 2);
      assert.equal(afterInvalid.payload.data.scope, 'restricted');
      assert.deepEqual(afterInvalid.payload.data.grants[0].permissions, ['preview', 'view']);
      assert.equal(JSON.stringify(afterInvalid.payload).includes('download'), false);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    if (previousPackaged == null) delete process.env.T8PC_PACKAGED;
    else process.env.T8PC_PACKAGED = previousPackaged;
    if (previousUserData == null) delete process.env.T8PC_USER_DATA;
    else process.env.T8PC_USER_DATA = previousUserData;
  }
});
