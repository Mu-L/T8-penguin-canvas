const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

const ASSET_COUNT = 100_000;
const PAGE_SIZE = 500;
const PROJECT_ID = 'asset-catalog-100k-acceptance';
const SHARED_CREATED_AT = 1_780_000_000_000;
const MiB = 1024 * 1024;

function assetId(index) {
  return `asset-${String(index).padStart(6, '0')}`;
}

function treeBytes(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(filename);
      else if (entry.isFile()) total += fs.statSync(filename).size;
    }
  }
  return total;
}

function memoryTracker() {
  const baseline = process.memoryUsage();
  const peak = { ...baseline };
  return {
    baseline,
    peak,
    sample() {
      const current = process.memoryUsage();
      for (const key of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']) {
        peak[key] = Math.max(Number(peak[key]) || 0, Number(current[key]) || 0);
      }
    },
  };
}

test('100,000 persisted assets use the catalog index and paginate every real row exactly once', { timeout: 120_000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-100k-'));
  const dbFile = path.join(root, 'catalog.sqlite3');
  const memory = memoryTracker();
  const database = new ProjectDatabase(dbFile, { autoBackup: false });
  let seedElapsedMs = 0;
  let paginationElapsedMs = 0;
  try {
    const insertAsset = database.db.prepare(`
      INSERT INTO assets(
        id, project_id, content_hash, perceptual_hash, kind, mime_type,
        filename, managed_path, source_url, storage_mode, availability,
        metadata_json, provenance_json, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?, 'managed', 'available', ?, ?, 'scale-acceptance', ?, ?)
    `);
    const seed = database.db.transaction(() => {
      for (let index = 0; index < ASSET_COUNT; index += 1) {
        const id = assetId(index);
        const video = index % 5 === 0;
        insertAsset.run(
          id,
          PROJECT_ID,
          index.toString(16).padStart(64, '0'),
          video ? 'video' : 'image',
          video ? 'video/mp4' : 'image/png',
          `${id}.${video ? 'mp4' : 'png'}`,
          `/files/output/scale/${id}.${video ? 'mp4' : 'png'}`,
          `{"size":${4096 + index},"fixtureIndex":${index}}`,
          `{"source":"100k-scale-acceptance","fixtureIndex":${index}}`,
          SHARED_CREATED_AT,
          SHARED_CREATED_AT,
        );
      }
    });
    const seedStartedAt = performance.now();
    seed();
    seedElapsedMs = performance.now() - seedStartedAt;
    memory.sample();

    const decorated = new Map([
      [assetId(99_999), { tags: ['featured', 'first-page'], collections: ['collection-a', 'collection-z'] }],
      [assetId(99_500), { tags: ['page-boundary'], collections: ['collection-z'] }],
      [assetId(50_000), { tags: ['featured', 'middle'], collections: ['collection-a'] }],
      [assetId(49_999), { tags: ['middle-boundary'], collections: ['collection-z'] }],
      [assetId(0), { tags: ['last-page'], collections: ['collection-a', 'collection-z'] }],
    ]);
    const insertCollection = database.db.prepare(`
      INSERT INTO asset_collections(id, project_id, name, description, created_by, created_at, updated_at)
      VALUES (?, ?, ?, '', 'scale-acceptance', ?, ?)
    `);
    const insertTag = database.db.prepare('INSERT INTO asset_tags(asset_id, tag, created_at) VALUES (?, ?, ?)');
    const insertMember = database.db.prepare('INSERT INTO asset_collection_members(collection_id, asset_id, added_at) VALUES (?, ?, ?)');
    database.db.transaction(() => {
      insertCollection.run('collection-a', PROJECT_ID, 'A collection', SHARED_CREATED_AT, SHARED_CREATED_AT);
      insertCollection.run('collection-z', PROJECT_ID, 'Z collection', SHARED_CREATED_AT, SHARED_CREATED_AT);
      for (const [id, decoration] of decorated) {
        [...decoration.tags].reverse().forEach((tag) => insertTag.run(id, tag, SHARED_CREATED_AT));
        [...decoration.collections].reverse().forEach((collectionId) => insertMember.run(collectionId, id, SHARED_CREATED_AT));
      }
    })();

    assert.equal(database.countAssets({ projectId: PROJECT_ID }), ASSET_COUNT);
    assert.equal(database.countAssets({ projectId: PROJECT_ID, kind: 'video' }), ASSET_COUNT / 5);
    const indexNames = new Set(database.db.prepare("PRAGMA index_list('assets')").all().map((entry) => entry.name));
    assert.equal(indexNames.has('idx_assets_project_created_id'), true);
    const queryPlan = database.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT a.* FROM assets a
      WHERE a.project_id = ?
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?
    `).all(PROJECT_ID, PAGE_SIZE, ASSET_COUNT - PAGE_SIZE);
    const queryPlanText = queryPlan.map((entry) => entry.detail).join('\n');
    assert.match(queryPlanText, /idx_assets_project_created_id/i);
    assert.doesNotMatch(queryPlanText, /USE TEMP B-TREE FOR ORDER BY/i);

    const seen = new Set();
    const hydratedDecorations = new Map();
    const paginationStartedAt = performance.now();
    for (let offset = 0; offset < ASSET_COUNT; offset += PAGE_SIZE) {
      const page = database.listAssets({ projectId: PROJECT_ID, limit: PAGE_SIZE, offset });
      assert.equal(page.length, Math.min(PAGE_SIZE, ASSET_COUNT - offset), `unexpected page size at offset ${offset}`);
      for (let pageIndex = 0; pageIndex < page.length; pageIndex += 1) {
        const asset = page[pageIndex];
        const ordinal = offset + pageIndex;
        assert.equal(asset.id, assetId(ASSET_COUNT - 1 - ordinal), `gap or unstable ordering at ordinal ${ordinal}`);
        assert.equal(asset.projectId, PROJECT_ID);
        assert.equal(asset.createdAt, SHARED_CREATED_AT);
        assert.equal(seen.has(asset.id), false, `duplicate asset across pages: ${asset.id}`);
        seen.add(asset.id);
        if (decorated.has(asset.id)) hydratedDecorations.set(asset.id, { tags: asset.tags, collections: asset.collectionIds });
        else {
          assert.deepEqual(asset.tags, []);
          assert.deepEqual(asset.collectionIds, []);
        }
      }
      memory.sample();
    }
    paginationElapsedMs = performance.now() - paginationStartedAt;

    assert.equal(seen.size, ASSET_COUNT);
    for (const [id, expected] of decorated) {
      assert.deepEqual(hydratedDecorations.get(id), {
        tags: [...expected.tags].sort(),
        collections: [...expected.collections].sort(),
      });
    }
    const featured = database.listAssets({ projectId: PROJECT_ID, tag: 'featured', limit: PAGE_SIZE });
    assert.deepEqual(featured.map((asset) => asset.id), [assetId(99_999), assetId(50_000)]);
    const collectionA = database.listAssets({ projectId: PROJECT_ID, collectionId: 'collection-a', limit: PAGE_SIZE });
    assert.deepEqual(collectionA.map((asset) => asset.id), [assetId(99_999), assetId(50_000), assetId(0)]);
    assert.equal(database.db.pragma('integrity_check', { simple: true }), 'ok');

    memory.sample();
    const peakRssDelta = memory.peak.rss - memory.baseline.rss;
    const peakHeapDelta = memory.peak.heapUsed - memory.baseline.heapUsed;
    assert.equal(seedElapsedMs < 60_000, true, `100k insert took ${seedElapsedMs.toFixed(1)}ms`);
    assert.equal(paginationElapsedMs < 30_000, true, `100k pagination took ${paginationElapsedMs.toFixed(1)}ms`);
    assert.equal(peakRssDelta < 384 * MiB, true, `100k acceptance RSS grew by ${(peakRssDelta / MiB).toFixed(1)} MiB`);
    t.diagnostic(JSON.stringify({
      assets: ASSET_COUNT,
      pages: Math.ceil(ASSET_COUNT / PAGE_SIZE),
      pageSize: PAGE_SIZE,
      seedElapsedMs: Number(seedElapsedMs.toFixed(1)),
      paginationElapsedMs: Number(paginationElapsedMs.toFixed(1)),
      peakRssMiB: Number((memory.peak.rss / MiB).toFixed(1)),
      peakRssDeltaMiB: Number((peakRssDelta / MiB).toFixed(1)),
      peakHeapUsedMiB: Number((memory.peak.heapUsed / MiB).toFixed(1)),
      peakHeapDeltaMiB: Number((peakHeapDelta / MiB).toFixed(1)),
      sqliteBytes: treeBytes(root),
      queryPlan: queryPlanText,
    }));
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
