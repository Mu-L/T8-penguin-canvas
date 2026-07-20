const test = require('node:test');
const assert = require('node:assert/strict');

const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

function addAsset(db, id, input = {}) {
  return db.upsertAsset({
    id,
    projectId: input.projectId || 'integrity-project',
    kind: input.kind || 'image',
    mimeType: input.kind === 'video' ? 'video/mp4' : 'image/png',
    filename: `${id}.${input.kind === 'video' ? 'mp4' : 'png'}`,
    contentHash: input.contentHash || id.padEnd(64, 'a').slice(0, 64).replace(/[^a-f0-9]/gi, 'a').toLowerCase(),
    contentHashVerification: input.contentHashVerification,
    perceptualHashAlgorithm: input.perceptualHashAlgorithm,
    perceptualHashes: input.perceptualHashes,
  });
}

test('near-duplicate cache refresh is atomic and later pages use revision-bound SQL keysets', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const algorithm = 'phash-dct64-v1';
    const hash = '0000000000000000';
    const source = addAsset(db, 'cache-source', { perceptualHashAlgorithm: algorithm, perceptualHashes: [{ hash }] });
    for (let index = 0; index < 405; index += 1) {
      addAsset(db, `cache-target-${String(index).padStart(4, '0')}`, {
        contentHash: index.toString(16).padStart(64, '0'),
        perceptualHashAlgorithm: algorithm,
        perceptualHashes: [{ hash }],
      });
    }

    db.db.exec(`
      CREATE TRIGGER fail_duplicate_cache_insert
      BEFORE INSERT ON asset_duplicate_candidates
      WHEN NEW.right_asset_id = 'cache-target-0003'
      BEGIN SELECT RAISE(ABORT, 'injected duplicate cache failure'); END;
    `);
    assert.throws(() => db.refreshAssetDuplicateCandidates(source.id, {
      expectedCatalogRevision: db.getAssetCatalogRevision(source.projectId),
    }), /injected duplicate cache failure/);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM asset_duplicate_candidates').get().count, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM asset_duplicate_scans').get().count, 0);
    db.db.exec('DROP TRIGGER fail_duplicate_cache_insert');

    const originalEvidence = db._nearDuplicateEvidence.bind(db);
    let evidenceCalls = 0;
    db._nearDuplicateEvidence = (...args) => {
      evidenceCalls += 1;
      return originalEvidence(...args);
    };
    const refresh = db.refreshAssetDuplicateCandidates(source.id, {
      expectedCatalogRevision: db.getAssetCatalogRevision(source.projectId),
    });
    assert.equal(refresh.refreshed, true);
    assert.equal(evidenceCalls > 0, true);
    evidenceCalls = 0;
    const seen = new Set();
    let cursor = null;
    let pages = 0;
    do {
      const page = db.listAssetDuplicates(source.id, { mode: 'near', maxDistance: 0, limit: 73, cursor });
      page.items.forEach((item) => {
        assert.equal(seen.has(item.asset.id), false, `duplicate page item ${item.asset.id}`);
        seen.add(item.asset.id);
      });
      assert.equal(evidenceCalls, 0, 'pure cursor pages must not rescore fingerprints');
      cursor = page.nextCursor;
      pages += 1;
      assert.equal(pages < 20, true, 'near-duplicate cursor must converge');
    } while (cursor);
    assert.equal(seen.size, 405);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM asset_duplicate_candidates').get().count, 405);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM asset_duplicate_scans').get().count, 1);
  } finally {
    db.close();
  }
});

test('lineage SQL triggers enforce live-or-tombstone project identity for both endpoints', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const child = addAsset(db, 'trigger-child', { projectId: 'project-one' });
    const parent = addAsset(db, 'trigger-parent', { projectId: 'project-one' });
    const foreign = addAsset(db, 'trigger-foreign', { projectId: 'project-two' });
    assert.throws(
      () => db.recordAssetLineageEvent({ assetId: child.id, parentAssetId: parent.id, canvasId: 'ghost-canvas' }),
      /Canvas 不存在/,
    );
    const insert = db.db.prepare(`
      INSERT INTO asset_lineage_events(
        id, project_id, asset_id, parent_asset_id, source_type, creator_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, 'derived-from', 'tester', '{}', ?)
    `);
    assert.throws(() => insert.run('bad-child', 'project-two', child.id, foreign.id, Date.now()), /child project mismatch/);
    assert.throws(() => insert.run('bad-parent', 'project-one', child.id, foreign.id, Date.now()), /parent project mismatch/);
    insert.run('valid-lineage', 'project-one', child.id, parent.id, Date.now());

    db.removeAssetIndex(child.id);
    db.removeAssetIndex(parent.id);
    assert.equal(db.db.prepare("UPDATE asset_lineage_events SET metadata_json='{}' WHERE id='valid-lineage'").run().changes, 1);
    assert.throws(
      () => db.db.prepare("UPDATE asset_lineage_events SET project_id='project-two' WHERE id='valid-lineage'").run(),
      /child project mismatch/,
    );
  } finally {
    db.close();
  }
});

test('duplicate decisions reject candidates whose catalog-bound evidence is stale', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const source = addAsset(db, 'decision-source', {
      contentHash: '1'.repeat(64),
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: '0000000000000000' }],
    });
    const target = addAsset(db, 'decision-target', {
      contentHash: '2'.repeat(64),
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: '0000000000000001' }],
    });
    db.refreshAssetDuplicateCandidates(source.id, {
      expectedCatalogRevision: db.getAssetCatalogRevision(source.projectId),
    });
    const candidate = db.listAssetDuplicates(source.id, { mode: 'near', maxDistance: 2 }).items[0];
    assert.ok(candidate);
    db.upsertAsset({
      id: target.id,
      projectId: target.projectId,
      kind: target.kind,
      mimeType: target.mimeType,
      filename: target.filename,
      contentHash: target.contentHash,
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: 'ffffffffffffffff' }],
    });
    assert.throws(
      () => db.setAssetDuplicateDecision(source.projectId, candidate.id, {
        decision: 'confirmed',
        expectedRevision: candidate.decisionRevision,
        expectedCatalogRevision: db.getAssetCatalogRevision(source.projectId) - 1,
      }),
      (error) => error.code === 'asset_catalog_revision_conflict' && error.current.catalogRevision === db.getAssetCatalogRevision(source.projectId),
    );
    assert.equal(db.db.prepare('SELECT decision FROM asset_duplicate_candidates WHERE id = ?').get(candidate.id).decision, 'pending');
  } finally {
    db.close();
  }
});

test('source graph advances its cursor at the public 240-edge page boundary without loss or duplicates', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const parent = addAsset(db, 'edge-page-parent');
    const child = addAsset(db, 'edge-page-child');
    for (let index = 0; index < 300; index += 1) {
      db.recordAssetLineageEvent({
        assetId: child.id,
        parentAssetId: parent.id,
        sourceType: `edge-page-${String(index).padStart(3, '0')}`,
        sourceNodeId: `node-${index}`,
        derivedOperation: 'many-evidence-events',
      });
    }
    const edgeIds = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = db.getAssetSourceGraph(parent.id, {
        direction: 'descendants', maxDepth: 2, maxNodes: 2, cursor,
      });
      assert.equal(page.edges.length <= 240, true);
      edgeIds.push(...page.edges.map((edge) => edge.id));
      cursor = page.nextCursor;
      pages += 1;
      assert.equal(pages < 10, true, 'source graph edge cursor must converge');
    } while (cursor);
    assert.equal(edgeIds.length, 300);
    assert.equal(new Set(edgeIds).size, 300);
  } finally {
    db.close();
  }
});

test('direct tag and collection mutations reject stale revisions without partial writes', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const first = addAsset(db, 'cas-first');
    const second = addAsset(db, 'cas-second');
    const tagged = db.setAssetTags(first.id, ['one'], { expectedRevision: first.organizationRevision });
    assert.throws(
      () => db.setAssetTags(first.id, ['stale'], { expectedRevision: first.organizationRevision }),
      (error) => error.code === 'asset_organization_revision_conflict',
    );
    assert.deepEqual(db.getAsset(first.id).tags, ['one']);

    const collection = db.createAssetCollection({ projectId: first.projectId, name: 'CAS' });
    db.setAssetCollectionMembers(collection.id, [first.id], { expectedRevision: collection.revision });
    assert.throws(
      () => db.setAssetCollectionMembers(collection.id, [second.id], { expectedRevision: collection.revision }),
      (error) => error.code === 'asset_collection_revision_conflict',
    );
    assert.deepEqual(db.listAssets({ projectId: first.projectId, collectionId: collection.id }).map((asset) => asset.id), [first.id]);
    assert.equal(db.getAsset(first.id).organizationRevision, tagged.organizationRevision + 1);
    assert.equal(db.getAsset(second.id).organizationRevision, second.organizationRevision);
  } finally {
    db.close();
  }
});
