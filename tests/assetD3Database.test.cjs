const test = require('node:test');
const assert = require('node:assert/strict');

const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

function addAsset(db, id, input = {}) {
  return db.upsertAsset({
    id,
    projectId: input.projectId || 'd3-project',
    kind: input.kind || 'image',
    mimeType: input.kind === 'video' ? 'video/mp4' : 'image/png',
    filename: input.filename || `${id}.${input.kind === 'video' ? 'mp4' : 'png'}`,
    contentHash: input.contentHash || id.padEnd(64, '0').slice(0, 64).replace(/[^a-f0-9]/gi, 'a').toLowerCase(),
    contentHashVerification: input.contentHashVerification,
    perceptualHash: input.perceptualHash,
    perceptualHashAlgorithm: input.perceptualHashAlgorithm,
    perceptualHashes: input.perceptualHashes,
    metadata: input.metadata || {},
  });
}

test('exact duplicate groups require per-asset verified hashes and stay project/content scoped', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const sharedA = 'a'.repeat(64);
    const sharedB = 'b'.repeat(64);
    const first = addAsset(db, 'exact-a1', { contentHash: sharedA, contentHashVerification: 'verified', filename: 'same.png' });
    const second = addAsset(db, 'exact-a2', { contentHash: sharedA, contentHashVerification: 'verified', filename: 'copy.png' });
    addAsset(db, 'exact-a-legacy', { contentHash: sharedA, filename: 'legacy.png' });
    addAsset(db, 'exact-a-other-project', { projectId: 'other-project', contentHash: sharedA, contentHashVerification: 'verified' });
    addAsset(db, 'same-name-different-content', { contentHash: 'c'.repeat(64), contentHashVerification: 'verified', filename: 'same.png' });
    addAsset(db, 'exact-b1', { contentHash: sharedB, contentHashVerification: 'verified' });
    addAsset(db, 'exact-b2', { contentHash: sharedB, contentHashVerification: 'verified' });

    const firstPage = db.listExactDuplicateGroups('d3-project', { limit: 1 });
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.hasMore, true);
    assert.ok(firstPage.nextCursor);
    const secondPage = db.listExactDuplicateGroups('d3-project', { limit: 1, cursor: firstPage.nextCursor });
    assert.equal(secondPage.items.length, 1);
    assert.notEqual(secondPage.items[0].contentHash, firstPage.items[0].contentHash);
    assert.equal(secondPage.hasMore, false);

    const groupA = [firstPage.items[0], secondPage.items[0]].find((group) => group.contentHash === sharedA);
    assert.ok(groupA);
    assert.equal(groupA.memberCount, 2, 'legacy-unverified and cross-project refs must not be washed into the exact group');
    assert.deepEqual(groupA.members.map((asset) => asset.id).sort(), [first.id, second.id].sort());
    assert.equal(groupA.members.some((asset) => asset.id === 'same-name-different-content'), false);

    const detail = db.getExactDuplicateGroup('d3-project', groupA.id, { limit: 1 });
    assert.equal(detail.members.length, 1);
    assert.equal(detail.memberCount, 2);
    assert.ok(detail.nextCursor);
    const detailNext = db.getExactDuplicateGroup('d3-project', groupA.id, { limit: 1, cursor: detail.nextCursor });
    assert.equal(detailNext.members.length, 1);
    assert.notEqual(detailNext.members[0].id, detail.members[0].id);
  } finally {
    db.close();
  }
});

test('near duplicate search separates algorithms, honors threshold zero, and requires multi-frame video agreement', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const zero = '0000000000000000';
    const one = '0000000000000001';
    const two = '0000000000000002';
    const three = '0000000000000003';
    const far = 'ffffffffffffffff';
    const image = addAsset(db, 'near-image-source', {
      contentHash: '1'.repeat(64),
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: zero }],
    });
    const imageSame = addAsset(db, 'near-image-same', {
      contentHash: '2'.repeat(64),
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: zero }],
    });
    addAsset(db, 'near-image-distance-one', {
      contentHash: '3'.repeat(64),
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: one }],
    });
    addAsset(db, 'near-image-dhash', {
      contentHash: '4'.repeat(64),
      perceptualHashAlgorithm: 'dhash64-v1',
      perceptualHash: zero,
    });

    const thresholdZero = db.listAssetDuplicates(image.id, { mode: 'near', maxDistance: 0, limit: 50 });
    assert.deepEqual(thresholdZero.items.map((item) => item.asset.id), [imageSame.id]);
    assert.equal(thresholdZero.items[0].algorithm, 'phash-dct64-v1');

    const videoSource = addAsset(db, 'near-video-source', {
      kind: 'video', contentHash: '5'.repeat(64), perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [
        { hash: zero, normalizedTime: 0 },
        { hash: zero, normalizedTime: 0.5 },
        { hash: zero, normalizedTime: 1 },
      ],
    });
    addAsset(db, 'near-video-single-frame', {
      kind: 'video', contentHash: '6'.repeat(64), perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: zero, normalizedTime: 0.5 }],
    });
    addAsset(db, 'near-video-one-different-third', {
      kind: 'video', contentHash: '7'.repeat(64), perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [
        { hash: zero, normalizedTime: 0 },
        { hash: zero, normalizedTime: 0.5 },
        { hash: far, normalizedTime: 1 },
      ],
    });
    const goodVideo = addAsset(db, 'near-video-good', {
      kind: 'video', contentHash: '8'.repeat(64), perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [
        { hash: zero, normalizedTime: 0 },
        { hash: one, normalizedTime: 0.5 },
        { hash: three, normalizedTime: 1 },
      ],
    });
    const goodSource = addAsset(db, 'near-video-good-source', {
      kind: 'video', contentHash: '9'.repeat(64), perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [
        { hash: zero, normalizedTime: 0 },
        { hash: one, normalizedTime: 0.5 },
        { hash: two, normalizedTime: 1 },
      ],
    });

    const falsePositiveGuard = db.listAssetDuplicates(videoSource.id, { mode: 'near', maxDistance: 0, limit: 50 });
    assert.equal(falsePositiveGuard.items.some((item) => item.asset.id === 'near-video-single-frame'), false);
    assert.equal(falsePositiveGuard.items.some((item) => item.asset.id === 'near-video-one-different-third'), false);

    const goodMatches = db.listAssetDuplicates(goodSource.id, { mode: 'near', maxDistance: 1, limit: 50 });
    const good = goodMatches.items.find((item) => item.asset.id === goodVideo.id);
    assert.ok(good);
    assert.equal(good.evidenceCount >= 3, true);
    assert.equal(good.coverage, 1);
    assert.equal(good.evidence.every((entry) => entry.sourceNormalizedTime != null && entry.targetNormalizedTime != null), true);
  } finally {
    db.close();
  }
});

test('asset batch operations enforce complete explicit CAS, idempotency, query revision and rollback', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const first = addAsset(db, 'batch-a', { contentHash: 'a'.repeat(64), filename: 'batch-a.png' });
    const second = addAsset(db, 'batch-b', { contentHash: 'b'.repeat(64), filename: 'batch-b.png' });
    const excluded = addAsset(db, 'batch-c', { contentHash: 'c'.repeat(64), filename: 'batch-c.png' });
    addAsset(db, 'batch-other-project', { projectId: 'other-project', contentHash: 'd'.repeat(64) });

    assert.throws(() => db.applyAssetBatch('d3-project', {
      idempotencyKey: 'missing-revisions',
      selection: { assetIds: [first.id, second.id] },
      expectedRevisions: { [first.id]: first.organizationRevision },
      operation: { type: 'tags.add', tags: ['should-not-write'] },
    }), /expectedRevision|组织版本|版本/);
    assert.equal(db.listAssets({ projectId: 'd3-project', tag: 'should-not-write' }).length, 0);

    const applied = db.applyAssetBatch('d3-project', {
      idempotencyKey: 'explicit-tags',
      selection: { assetIds: [first.id, second.id] },
      expectedRevisions: {
        [first.id]: first.organizationRevision,
        [second.id]: second.organizationRevision,
      },
      operation: { type: 'tags.add', tags: ['approved'] },
    });
    assert.equal(applied.affectedCount, 2);
    assert.equal(db.listAssets({ projectId: 'd3-project', tag: 'approved' }).length, 2);
    const replay = db.applyAssetBatch('d3-project', {
      idempotencyKey: 'explicit-tags',
      selection: { assetIds: [first.id, second.id] },
      expectedRevisions: {
        [first.id]: first.organizationRevision,
        [second.id]: second.organizationRevision,
      },
      operation: { type: 'tags.add', tags: ['approved'] },
    });
    assert.equal(replay.idempotent, true);
    assert.deepEqual(replay.organizationRevisions, applied.organizationRevisions);
    assert.throws(() => db.applyAssetBatch('d3-project', {
      idempotencyKey: 'explicit-tags',
      selection: { assetIds: [first.id, second.id] },
      expectedRevisions: applied.organizationRevisions,
      operation: { type: 'tags.add', tags: ['different-request'] },
    }), /幂等键|idempotency/i);
    assert.equal(db.listAssets({ projectId: 'd3-project', tag: 'different-request' }).length, 0);

    const catalogRevision = db.getAssetCatalogRevision('d3-project');
    const queryApplied = db.applyAssetBatch('d3-project', {
      idempotencyKey: 'query-tags',
      selection: {
        query: { query: 'batch-' },
        catalogRevision,
        exclusions: [excluded.id],
      },
      operation: { type: 'tags.add', tags: ['query-selected'] },
    });
    assert.equal(queryApplied.affectedCount, 2);
    assert.deepEqual(db.listAssets({ projectId: 'd3-project', tag: 'query-selected' }).map((asset) => asset.id).sort(), [first.id, second.id].sort());

    const staleCatalogRevision = db.getAssetCatalogRevision('d3-project');
    db.updateAssetAvailability(excluded.id, 'missing', { sourceState: 'missing' });
    assert.throws(() => db.applyAssetBatch('d3-project', {
      idempotencyKey: 'stale-query',
      selection: { query: { query: 'batch-' }, catalogRevision: staleCatalogRevision, exclusions: [] },
      operation: { type: 'tags.add', tags: ['stale-write'] },
    }), /目录版本|revision|版本/);
    assert.equal(db.listAssets({ projectId: 'd3-project', tag: 'stale-write' }).length, 0);

    const latestFirst = db.getAsset(first.id);
    assert.throws(() => db.applyAssetBatch('d3-project', {
      idempotencyKey: 'cross-project',
      selection: { assetIds: [first.id, 'batch-other-project'] },
      expectedRevisions: { [first.id]: latestFirst.organizationRevision, 'batch-other-project': 1 },
      operation: { type: 'tags.add', tags: ['cross-project-write'] },
    }), /跨项目|不存在/);
    assert.equal(db.listAssets({ projectId: 'd3-project', tag: 'cross-project-write' }).length, 0);
  } finally {
    db.close();
  }
});

test('batch collection move removes only named sources and preserves unrelated memberships', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const first = addAsset(db, 'move-a', { contentHash: '1'.repeat(64) });
    const second = addAsset(db, 'move-b', { contentHash: '2'.repeat(64) });
    const source = db.createAssetCollection({ projectId: 'd3-project', name: 'Source' });
    const target = db.createAssetCollection({ projectId: 'd3-project', name: 'Target' });
    const preserved = db.createAssetCollection({ projectId: 'd3-project', name: 'Preserved' });
    const foreign = db.createAssetCollection({ projectId: 'other-project', name: 'Foreign' });

    db.setAssetCollectionMembers(source.id, [first.id, second.id], { expectedRevision: source.revision });
    db.addAssetCollectionMember(preserved.id, first.id, { expectedRevision: preserved.revision });
    const sourceBefore = db.getAssetCollection(source.id, 'd3-project');
    const targetBefore = db.getAssetCollection(target.id, 'd3-project');
    const catalogBefore = db.getAssetCatalogRevision('d3-project');
    const currentFirst = db.getAsset(first.id);
    const currentSecond = db.getAsset(second.id);

    const moved = db.applyAssetBatch('d3-project', {
      idempotencyKey: 'collection-move',
      selection: { assetIds: [first.id, second.id] },
      expectedRevisions: {
        [first.id]: currentFirst.organizationRevision,
        [second.id]: currentSecond.organizationRevision,
      },
      operation: {
        type: 'collection.move',
        fromCollectionIds: [source.id],
        toCollectionId: target.id,
      },
    });

    assert.equal(moved.affectedCount, 2);
    assert.equal(moved.catalogRevision, catalogBefore + 1);
    assert.deepEqual(db.listAssets({ projectId: 'd3-project', collectionId: source.id }), []);
    assert.deepEqual(
      db.listAssets({ projectId: 'd3-project', collectionId: target.id }).map((asset) => asset.id).sort(),
      [first.id, second.id].sort(),
    );
    assert.deepEqual(
      db.listAssets({ projectId: 'd3-project', collectionId: preserved.id }).map((asset) => asset.id),
      [first.id],
      'move must not behave like replace and erase unrelated collection membership',
    );
    assert.equal(db.getAssetCollection(source.id, 'd3-project').revision, sourceBefore.revision + 1);
    assert.equal(db.getAssetCollection(target.id, 'd3-project').revision, targetBefore.revision + 1);
    assert.equal(moved.organizationRevisions[first.id], currentFirst.organizationRevision + 1);
    assert.equal(moved.organizationRevisions[second.id], currentSecond.organizationRevision + 1);

    const replay = db.applyAssetBatch('d3-project', {
      idempotencyKey: 'collection-move',
      selection: { assetIds: [first.id, second.id] },
      expectedRevisions: {
        [first.id]: currentFirst.organizationRevision,
        [second.id]: currentSecond.organizationRevision,
      },
      operation: { type: 'collection.move', fromCollectionIds: [source.id], toCollectionId: target.id },
    });
    assert.equal(replay.idempotent, true);
    assert.deepEqual(replay.organizationRevisions, moved.organizationRevisions);

    const latestFirst = db.getAsset(first.id);
    const latestSecond = db.getAsset(second.id);
    assert.throws(() => db.applyAssetBatch('d3-project', {
      idempotencyKey: 'collection-move-cross-project',
      selection: { assetIds: [first.id, second.id] },
      expectedRevisions: {
        [first.id]: latestFirst.organizationRevision,
        [second.id]: latestSecond.organizationRevision,
      },
      operation: { type: 'collection.move', fromCollectionIds: [target.id], toCollectionId: foreign.id },
    }), /集合不存在|不属于当前项目/);
    assert.deepEqual(
      db.listAssets({ projectId: 'd3-project', collectionId: target.id }).map((asset) => asset.id).sort(),
      [first.id, second.id].sort(),
      'failed cross-project move must roll back without removing source memberships',
    );
  } finally {
    db.close();
  }
});

test('lineage is immutable and cycle-safe while source graph survives asset tombstones and cursor paging', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const assets = Array.from({ length: 6 }, (_, index) => addAsset(db, `graph-${index}`, {
      contentHash: (index + 1).toString(16).repeat(64).slice(0, 64),
    }));
    for (let index = 1; index < assets.length; index += 1) {
      const event = db.recordAssetLineageEvent({
        id: `caller-controlled-${index}`,
        assetId: assets[index].id,
        parentAssetId: assets[index - 1].id,
        sourceType: 'derived',
        derivedOperation: 'chain',
        metadata: { index },
      });
      assert.equal(event.some((row) => row.id === `caller-controlled-${index}`), false);
    }
    const countBeforeRetry = db.db.prepare('SELECT COUNT(*) AS count FROM asset_lineage_events').get().count;
    db.recordAssetLineageEvent({
      assetId: assets[1].id,
      parentAssetId: assets[0].id,
      sourceType: 'derived',
      derivedOperation: 'chain',
      metadata: { callerTriedToMutate: true },
    });
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM asset_lineage_events').get().count, countBeforeRetry);
    assert.throws(() => db.recordAssetLineageEvent({ assetId: assets[0].id, parentAssetId: assets[0].id }), /自身/);
    assert.throws(() => db.recordAssetLineageEvent({ assetId: assets[0].id, parentAssetId: assets.at(-1).id }), /循环/);

    db.removeAssetIndex(assets[2].id);
    const collectedNodes = new Map();
    const collectedEdges = new Map();
    const collectedEdgeIds = [];
    let cursor = null;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const page = db.getAssetSourceGraph(assets[0].id, {
        direction: 'descendants', maxDepth: 10, maxNodes: 2, cursor,
      });
      page.nodes.forEach((node) => collectedNodes.set(node.id, node));
      page.edges.forEach((edge) => {
        collectedEdgeIds.push(edge.id);
        collectedEdges.set(edge.id, edge);
      });
      cursor = page.nextCursor;
      if (!cursor) break;
      assert.notEqual(pageIndex, 19, 'source graph cursor must converge');
    }
    assert.deepEqual([...collectedNodes.keys()].sort(), assets.map((asset) => asset.id).sort());
    assert.equal(collectedEdges.size, assets.length - 1);
    assert.equal(collectedEdgeIds.length, collectedEdges.size, 'source graph pages must never emit an edge twice');
    assert.equal(collectedNodes.get(assets[2].id).asset, undefined);
    assert.equal(collectedNodes.get(assets[2].id).tombstone.filename, assets[2].filename);
    for (const edge of collectedEdges.values()) {
      assert.equal(collectedNodes.has(edge.sourceAssetId), true);
      assert.equal(collectedNodes.has(edge.targetAssetId), true);
    }
  } finally {
    db.close();
  }
});

test('asset lineage keyset pages are stable, bounded, asset-bound, and revision-bound', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const root = addAsset(db, 'lineage-page-root', { contentHash: 'd'.repeat(64) });
    const other = addAsset(db, 'lineage-page-other', { contentHash: 'e'.repeat(64) });
    const baseTime = 1_700_000_000_000;
    for (let index = 0; index < 7; index += 1) {
      db.recordAssetLineageEvent({
        assetId: root.id,
        sourceType: 'node-output',
        sourceNodeId: `lineage-node-${index}`,
        sourceNodeType: 'image',
        derivedOperation: `lineage-operation-${index}`,
        metadata: { safeIndex: index },
        // Deliberate timestamp ties prove that id is the deterministic second
        // key rather than relying on insertion order.
        createdAt: baseTime + Math.floor(index / 2),
      });
    }

    const expectedIds = db.getAssetLineage(root.id).map((event) => event.id);
    assert.equal(expectedIds.length, 7);
    const collectedIds = [];
    let cursor = null;
    let lineageRevision = null;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = db.listAssetLineage(root.id, { limit: 2, cursor });
      assert.equal(page.total, 7);
      assert.equal(page.limit, 2);
      assert.equal(page.items.length <= 2, true);
      assert.equal(typeof page.lineageRevision, 'string');
      assert.equal(page.lineageRevision.length > 0, true);
      lineageRevision ||= page.lineageRevision;
      assert.equal(page.lineageRevision, lineageRevision, 'all cursor pages must belong to one immutable lineage revision');
      collectedIds.push(...page.items.map((event) => event.id));
      assert.equal(new Set(collectedIds).size, collectedIds.length, 'lineage cursor pages must never repeat an event');
      assert.equal(page.hasMore, Boolean(page.nextCursor));
      cursor = page.nextCursor;
      if (!cursor) break;
      assert.notEqual(pageIndex, 9, 'lineage cursor must converge');
    }
    assert.deepEqual(collectedIds, expectedIds, 'keyset pages preserve created_at DESC, id DESC order without gaps');

    const bounded = db.listAssetLineage(root.id, { limit: 10_000 });
    assert.equal(bounded.limit, 100);
    assert.equal(bounded.items.length, 7);
    assert.equal(db.listAssetLineage(root.id, { limit: 0 }).limit, 1);

    const first = db.listAssetLineage(root.id, { limit: 2 });
    assert.ok(first.nextCursor);
    assert.throws(
      () => db.listAssetLineage(other.id, { limit: 2, cursor: first.nextCursor }),
      (error) => error?.code === 'asset_lineage_revision_conflict' && error?.current?.assetId === other.id,
      'a cursor minted for one asset must not be usable for another asset',
    );
    assert.throws(
      () => db.listAssetLineage(root.id, { limit: 3, cursor: first.nextCursor }),
      (error) => error?.code === 'asset_lineage_revision_conflict',
      'the cursor binds its page size so callers cannot silently change keyset semantics',
    );

    db.recordAssetLineageEvent({
      assetId: root.id,
      sourceType: 'node-output',
      sourceNodeId: 'lineage-node-added-after-cursor',
      sourceNodeType: 'image',
      derivedOperation: 'lineage-operation-added-after-cursor',
      metadata: { safeIndex: 99 },
      createdAt: baseTime + 100,
    });
    assert.throws(
      () => db.listAssetLineage(root.id, { limit: 2, cursor: first.nextCursor }),
      (error) => error?.code === 'asset_lineage_revision_conflict'
        && error?.current?.assetId === root.id
        && error?.current?.lineageRevision !== first.lineageRevision,
      'adding an event must invalidate every cursor from the prior lineage revision',
    );
    const refreshed = db.listAssetLineage(root.id, { limit: 2 });
    assert.equal(refreshed.total, 8);
    assert.notEqual(refreshed.lineageRevision, first.lineageRevision);
    assert.equal(refreshed.items[0].sourceNodeId, 'lineage-node-added-after-cursor');
  } finally {
    db.close();
  }
});

test('asset-local lineage revision ignores unrelated and idempotent writes and pages negative timestamps', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const root = addAsset(db, 'lineage-local-revision-root', { contentHash: '1'.repeat(64) });
    const unrelated = addAsset(db, 'lineage-local-revision-unrelated', { contentHash: '2'.repeat(64) });
    const rootEvents = Array.from({ length: 4 }, (_, index) => ({
      assetId: root.id,
      sourceType: 'historical-import',
      sourceNodeId: `negative-lineage-node-${index}`,
      sourceNodeType: 'image',
      derivedOperation: `negative-lineage-operation-${index}`,
      metadata: { safeIndex: index },
      createdAt: -(index + 1),
    }));
    rootEvents.forEach((event) => db.recordAssetLineageEvent(event));

    const first = db.listAssetLineage(root.id, { limit: 2 });
    assert.equal(first.total, 4);
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    assert.deepEqual(first.items.map((event) => event.createdAt), [-1, -2]);

    db.recordAssetLineageEvent({
      assetId: unrelated.id,
      sourceType: 'unrelated-import',
      sourceNodeId: 'unrelated-lineage-node',
      sourceNodeType: 'image',
      derivedOperation: 'unrelated-lineage-operation',
      metadata: { shouldNotInvalidateRoot: true },
      createdAt: 9_999,
    });
    const afterUnrelated = db.listAssetLineage(root.id, { limit: 2, cursor: first.nextCursor });
    assert.equal(afterUnrelated.lineageRevision, first.lineageRevision, 'same-project events on another asset are outside this cursor revision');
    assert.deepEqual(afterUnrelated.items.map((event) => event.createdAt), [-3, -4]);

    const beforeRetryCount = db.db.prepare(`
      SELECT COUNT(*) AS count FROM asset_lineage_events
      WHERE project_id = ? AND (asset_id = ? OR parent_asset_id = ?)
    `).get(root.projectId, root.id, root.id).count;
    db.recordAssetLineageEvent({
      ...rootEvents[0],
      // These mutable fields must not replace the immutable existing event;
      // identity fields are identical, so INSERT OR IGNORE is a true retry.
      metadata: { retryMustNotOverwrite: true },
      createdAt: 99_999,
    });
    const afterRetryCount = db.db.prepare(`
      SELECT COUNT(*) AS count FROM asset_lineage_events
      WHERE project_id = ? AND (asset_id = ? OR parent_asset_id = ?)
    `).get(root.projectId, root.id, root.id).count;
    assert.equal(afterRetryCount, beforeRetryCount);
    const afterRetry = db.listAssetLineage(root.id, { limit: 2, cursor: first.nextCursor });
    assert.equal(afterRetry.lineageRevision, first.lineageRevision, 'INSERT OR IGNORE retries must not invalidate an existing cursor');
    assert.deepEqual(afterRetry.items.map((event) => event.createdAt), [-3, -4]);

    const allIds = [...first.items, ...afterRetry.items].map((event) => event.id);
    assert.deepEqual(allIds, db.getAssetLineage(root.id).map((event) => event.id));
    assert.equal(db.getAssetLineage(root.id)[0].metadata.retryMustNotOverwrite, undefined);
  } finally {
    db.close();
  }
});

test('tombstoned project A lineage stays isolated when project B reuses the same assetId', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const sharedId = 'lineage-cross-project-reused-id';
    const projectA = addAsset(db, sharedId, { projectId: 'lineage-project-a', contentHash: 'a'.repeat(64) });
    db.recordAssetLineageEvent({
      assetId: projectA.id,
      sourceType: 'project-a-private-history',
      sourceNodeId: 'project-a-private-node',
      sourceNodeType: 'image',
      derivedOperation: 'project-a-private-operation',
      metadata: { project: 'A', mustNeverReachProjectB: true },
      createdAt: 100,
    });
    assert.equal(db.listAssetLineage(sharedId, { limit: 10 }).total, 1);
    db.removeAssetIndex(sharedId);
    assert.equal(db.getAsset(sharedId), null);
    assert.equal(db.db.prepare('SELECT project_id FROM asset_lineage_tombstones WHERE id = ?').get(sharedId).project_id, 'lineage-project-a');

    const projectB = addAsset(db, sharedId, { projectId: 'lineage-project-b', contentHash: 'b'.repeat(64) });
    const beforeProjectBWrite = db.listAssetLineage(sharedId, { limit: 10 });
    assert.equal(beforeProjectBWrite.total, 0);
    assert.deepEqual(beforeProjectBWrite.items, []);
    assert.deepEqual(db.getAssetLineage(sharedId), [], 'legacy full GET must resolve the active asset project before reading history');

    const writeResponse = db.addAssetLineage({
      childAssetId: projectB.id,
      sourceType: 'project-b-visible-history',
      sourceNodeId: 'project-b-visible-node',
      sourceNodeType: 'image',
      derivedOperation: 'project-b-visible-operation',
      metadata: { project: 'B', safe: true },
      createdAt: 200,
    });
    assert.equal(writeResponse.length, 1);
    assert.equal(writeResponse[0].sourceNodeId, 'project-b-visible-node');
    assert.equal(writeResponse.some((event) => event.sourceNodeId === 'project-a-private-node'), false, 'write response must not hydrate project A tombstoned history');

    const projectBPage = db.listAssetLineage(sharedId, { limit: 10 });
    assert.equal(projectBPage.total, 1);
    assert.deepEqual(projectBPage.items.map((event) => event.sourceNodeId), ['project-b-visible-node']);
    assert.deepEqual(db.getAssetLineage(sharedId).map((event) => event.sourceNodeId), ['project-b-visible-node']);
    assert.deepEqual(
      db.db.prepare('SELECT project_id, source_node_id FROM asset_lineage_events WHERE asset_id = ? ORDER BY project_id').all(sharedId),
      [
        { project_id: 'lineage-project-a', source_node_id: 'project-a-private-node' },
        { project_id: 'lineage-project-b', source_node_id: 'project-b-visible-node' },
      ],
      'both immutable histories remain stored but are scoped by project at every public read/write response',
    );
  } finally {
    db.close();
  }
});
