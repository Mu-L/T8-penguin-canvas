const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

const ASSET_COUNT = 10_000;
const PAGE_SIZE = 120;
const PROJECT_ID = 'asset-catalog-scale-project';
const SHARED_CREATED_AT = 1_750_000_000_000;

function assetId(index) {
  return `asset-${String(index).padStart(5, '0')}`;
}

test('10,000-asset catalog pagination is deterministic, complete, bounded, and batch-hydrated', (t) => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const insertAsset = database.db.prepare(`
      INSERT INTO assets(
        id, project_id, content_hash, perceptual_hash, kind, mime_type,
        filename, managed_path, source_url, storage_mode, availability,
        metadata_json, provenance_json, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const seedAssets = database.db.transaction(() => {
      for (let index = 0; index < ASSET_COUNT; index += 1) {
        const id = assetId(index);
        insertAsset.run(
          id,
          PROJECT_ID,
          `sha256-${String(index).padStart(5, '0')}`,
          index % 3 === 0 ? `phash-${String(index).padStart(5, '0')}` : null,
          index % 5 === 0 ? 'video' : 'image',
          index % 5 === 0 ? 'video/mp4' : 'image/png',
          `${id}.${index % 5 === 0 ? 'mp4' : 'png'}`,
          null,
          `/files/output/${id}.${index % 5 === 0 ? 'mp4' : 'png'}`,
          'managed',
          'available',
          JSON.stringify({ size: 1024 + index, fixtureIndex: index }),
          JSON.stringify({ source: 'scale-fixture', fixtureIndex: index }),
          'scale-test',
          SHARED_CREATED_AT,
          SHARED_CREATED_AT,
        );
      }
    });
    seedAssets();

    const collectionRows = [
      ['collection-a', 'A collection'],
      ['collection-z', 'Z collection'],
    ];
    const decoratedAssets = new Map([
      [assetId(9_999), { tags: ['featured', 'red'], collections: ['collection-a', 'collection-z'] }],
      [assetId(9_880), { tags: ['boundary'], collections: ['collection-z'] }],
      [assetId(5_000), { tags: ['featured', 'middle'], collections: ['collection-a'] }],
      [assetId(0), { tags: ['last'], collections: ['collection-a', 'collection-z'] }],
    ]);
    const insertCollection = database.db.prepare(`
      INSERT INTO asset_collections(id, project_id, name, description, created_by, created_at, updated_at)
      VALUES (?, ?, ?, '', 'scale-test', ?, ?)
    `);
    const insertTag = database.db.prepare('INSERT INTO asset_tags(asset_id, tag, created_at) VALUES (?, ?, ?)');
    const insertMember = database.db.prepare('INSERT INTO asset_collection_members(collection_id, asset_id, added_at) VALUES (?, ?, ?)');
    database.db.transaction(() => {
      for (const [collectionId, name] of collectionRows) insertCollection.run(collectionId, PROJECT_ID, name, SHARED_CREATED_AT, SHARED_CREATED_AT);
      for (const [id, decoration] of decoratedAssets) {
        // Insert in reverse lexical order so hydration must rely on its explicit ORDER BY.
        [...decoration.tags].reverse().forEach((tag) => insertTag.run(id, tag, SHARED_CREATED_AT));
        [...decoration.collections].reverse().forEach((collectionId) => insertMember.run(collectionId, id, SHARED_CREATED_AT));
      }
    })();

    assert.equal(database.countAssets({ projectId: PROJECT_ID }), ASSET_COUNT);

    const seen = new Set();
    const orderedIds = [];
    const hydratedDecorations = new Map();
    let previous = null;
    const paginationStartedAt = performance.now();
    for (let offset = 0; offset < ASSET_COUNT; offset += PAGE_SIZE) {
      const page = database.listAssets({ projectId: PROJECT_ID, limit: PAGE_SIZE, offset });
      assert.equal(page.length, Math.min(PAGE_SIZE, ASSET_COUNT - offset), `unexpected page size at offset ${offset}`);
      for (const asset of page) {
        assert.equal(asset.projectId, PROJECT_ID);
        assert.equal(asset.createdAt, SHARED_CREATED_AT);
        assert.equal(seen.has(asset.id), false, `duplicate asset across pages: ${asset.id}`);
        if (previous) {
          assert.equal(
            previous.createdAt > asset.createdAt || (previous.createdAt === asset.createdAt && previous.id > asset.id),
            true,
            `catalog order is not createdAt DESC, id DESC: ${previous.id} before ${asset.id}`,
          );
        }
        seen.add(asset.id);
        orderedIds.push(asset.id);
        previous = asset;
        if (decoratedAssets.has(asset.id)) hydratedDecorations.set(asset.id, { tags: asset.tags, collections: asset.collectionIds });
        else {
          assert.deepEqual(asset.tags, []);
          assert.deepEqual(asset.collectionIds, []);
        }
      }
    }
    const paginationElapsedMs = performance.now() - paginationStartedAt;

    assert.equal(seen.size, ASSET_COUNT);
    assert.equal(orderedIds.length, ASSET_COUNT);
    assert.deepEqual(
      orderedIds,
      Array.from({ length: ASSET_COUNT }, (_, offset) => assetId(ASSET_COUNT - 1 - offset)),
      'equal-created_at rows must use id DESC as a deterministic tie-breaker without gaps',
    );
    for (const [id, expected] of decoratedAssets) {
      const hydrated = hydratedDecorations.get(id);
      assert.ok(hydrated, `${id} should have been observed and hydrated`);
      assert.deepEqual(hydrated.tags, [...expected.tags].sort());
      assert.deepEqual(hydrated.collections, [...expected.collections].sort());
    }

    const featured = database.listAssets({ projectId: PROJECT_ID, tag: 'featured', limit: PAGE_SIZE, offset: 0 });
    assert.deepEqual(featured.map((asset) => asset.id), [assetId(9_999), assetId(5_000)]);
    assert.deepEqual(featured[0].tags, ['featured', 'red']);
    assert.deepEqual(featured[0].collectionIds, ['collection-a', 'collection-z']);

    const collectionA = database.listAssets({ projectId: PROJECT_ID, collectionId: 'collection-a', limit: PAGE_SIZE, offset: 0 });
    assert.deepEqual(collectionA.map((asset) => asset.id), [assetId(9_999), assetId(5_000), assetId(0)]);
    assert.equal(paginationElapsedMs < 15_000, true, `10,000-asset pagination took ${paginationElapsedMs.toFixed(1)}ms`);
    t.diagnostic(`10,000 assets paged in ${paginationElapsedMs.toFixed(1)}ms across ${Math.ceil(ASSET_COUNT / PAGE_SIZE)} pages`);
  } finally {
    database.close();
  }
});
