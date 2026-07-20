const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');

const {
  ProjectDatabase,
  PROJECT_DATABASE_MIGRATIONS,
  PROJECT_DATABASE_SCHEMA_VERSION,
} = require('../backend/src/services/projectDatabase');
const {
  assertCurrentProjectDatabaseRegistry,
} = require('./helpers/projectDatabaseVersion.cjs');

function seedSchema15(filename) {
  const db = new BetterSqlite3(filename);
  try {
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        entity_uid TEXT,
        content_hash TEXT,
        perceptual_hash TEXT,
        kind TEXT NOT NULL,
        mime_type TEXT,
        filename TEXT NOT NULL,
        managed_path TEXT,
        source_url TEXT,
        storage_mode TEXT NOT NULL DEFAULT 'linked',
        availability TEXT NOT NULL DEFAULT 'available',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        provenance_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const insertMigration = db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)');
    const insertAsset = db.prepare(`
      INSERT INTO assets(
        id, project_id, entity_uid, content_hash, perceptual_hash, kind, mime_type,
        filename, managed_path, source_url, storage_mode, availability,
        metadata_json, provenance_json, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'schema15-owner', ?, ?)
    `);
    db.transaction(() => {
      for (let version = 1; version <= 15; version += 1) insertMigration.run(version, 1_700_000_000_000 + version);
      insertAsset.run(
        'legacy-image', 'schema16-project', null, 'a'.repeat(64), '1'.repeat(16),
        'image', 'image/png', 'img.png', 'C:\\Users\\alice\\secret\\img.png', null,
        'linked', 'available', JSON.stringify({
          root: 'input',
          relativePath: 'img.png',
          perceptualHashAlgorithm: 'phash-dct64-v1',
          perceptualHashes: [{ role: 'primary', index: 0, hash: '1'.repeat(16) }],
        }), 1_700_000_000_100, 1_700_000_000_101,
      );
      insertAsset.run(
        'legacy-video', 'schema16-project', null, 'b'.repeat(64), '2'.repeat(16),
        'video', 'video/mp4', 'clip.mp4', 'input/clip.mp4', null,
        'managed', 'available', JSON.stringify({
          root: 'input',
          relativePath: 'clip.mp4',
          duration: 10,
          perceptualHashAlgorithm: 'phash-dct64-v1',
          perceptualHashes: [
            { frameKind: 'video-keyframe', index: 0, time: 0, hash: '2'.repeat(16) },
            { frameKind: 'video-keyframe', index: 1, time: 10, hash: '3'.repeat(16) },
          ],
        }), 1_700_000_000_200, 1_700_000_000_201,
      );
      insertAsset.run(
        'legacy-dhash', 'schema16-project', null, 'c'.repeat(64), '4'.repeat(16),
        'image', 'image/jpeg', 'old.jpg', 'input/old.jpg', null,
        'managed', 'available', '{}', 1_700_000_000_300, 1_700_000_000_301,
      );
    })();
  } finally {
    db.close();
  }
}

function tableColumns(db, table) {
  return db.pragma(`table_info(${table})`).map((row) => row.name);
}

test('latest schema migrates real schema 15 fingerprint data idempotently without trusting legacy hashes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-schema16-upgrade-'));
  const filename = path.join(directory, 'projects.sqlite3');
  try {
    seedSchema15(filename);
    const first = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assertCurrentProjectDatabaseRegistry(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATIONS);
      assert.equal(first.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, PROJECT_DATABASE_SCHEMA_VERSION);
      assert.equal(first.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(first.db.pragma('foreign_key_check'), []);

      const algorithms = first.db.prepare(`
        SELECT id, perceptual_hash_algorithm AS algorithm FROM assets ORDER BY id
      `).all();
      assert.deepEqual(algorithms, [
        { id: 'legacy-dhash', algorithm: 'dhash64-v1' },
        { id: 'legacy-image', algorithm: 'phash-dct64-v1' },
        { id: 'legacy-video', algorithm: 'phash-dct64-v1' },
      ]);

      const fingerprints = first.db.prepare(`
        SELECT asset_id AS assetId, algorithm, frame_index AS frameIndex, normalized_time AS normalizedTime, hash_hex AS hash
        FROM asset_fingerprints ORDER BY asset_id, frame_index
      `).all();
      assert.equal(fingerprints.length, 4);
      assert.deepEqual(fingerprints.map((row) => [row.assetId, row.algorithm, row.frameIndex, row.hash]), [
        ['legacy-dhash', 'dhash64-v1', 0, '4'.repeat(16)],
        ['legacy-image', 'phash-dct64-v1', 0, '1'.repeat(16)],
        ['legacy-video', 'phash-dct64-v1', 0, '2'.repeat(16)],
        ['legacy-video', 'phash-dct64-v1', 1, '3'.repeat(16)],
      ]);
      assert.equal(fingerprints[2].normalizedTime, 0);
      assert.equal(fingerprints[3].normalizedTime, 1);

      assert.deepEqual(
        first.db.prepare('SELECT verification_state AS state, COUNT(*) AS count FROM asset_blobs GROUP BY verification_state').all(),
        [{ state: 'legacy-unverified', count: 3 }],
      );
      assert.deepEqual(
        first.db.prepare('SELECT verification_state AS state, COUNT(*) AS count FROM asset_blob_refs GROUP BY verification_state').all(),
        [{ state: 'legacy-unverified', count: 3 }],
      );
      const locators = first.db.prepare('SELECT source_locator AS locator FROM assets ORDER BY id').all();
      assert.equal(locators.every(({ locator }) => /^asset_source_[a-f0-9]{64}$/.test(locator)), true);
      assert.equal(locators.some(({ locator }) => /alice|secret|img\.png/i.test(locator)), false);
    } finally {
      first.close();
    }

    const reopened = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM asset_fingerprints').get().count, 4);
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM asset_blobs').get().count, 3);
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM asset_blob_refs').get().count, 3);
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, PROJECT_DATABASE_SCHEMA_VERSION);
      assert.equal(reopened.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(reopened.db.pragma('foreign_key_check'), []);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema 16 migration failure rolls every new table, trigger, column and version back to schema 15', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-schema16-rollback-'));
  const filename = path.join(directory, 'projects.sqlite3');
  try {
    seedSchema15(filename);
    assert.throws(() => new ProjectDatabase(filename, {
      autoBackup: false,
      beforeMigrationCommit: () => { throw new Error('schema16-injected-failure'); },
    }), /schema16-injected-failure/);

    const raw = new BetterSqlite3(filename, { readonly: true });
    try {
      assert.equal(raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 15);
      const columns = tableColumns(raw, 'assets');
      assert.equal(columns.includes('perceptual_hash_algorithm'), false);
      assert.equal(columns.includes('organization_revision'), false);
      assert.equal(columns.includes('source_locator'), false);
      for (const table of [
        'asset_blobs',
        'asset_blob_refs',
        'asset_fingerprints',
        'asset_duplicate_candidates',
        'asset_duplicate_scans',
        'asset_access_policies',
        'asset_access_grants',
        'asset_catalog_revisions',
        'asset_batch_requests',
        'asset_lineage_tombstones',
      ]) {
        assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), undefined, table);
      }
      for (const trigger of [
        'trg_assets_project_immutable',
        'trg_asset_duplicate_scans_project_insert',
        'trg_asset_duplicate_scans_project_update',
        'trg_asset_lineage_events_project_insert',
        'trg_asset_lineage_events_project_update',
      ]) {
        assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger), undefined, trigger);
      }
      assert.equal(raw.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      raw.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema 16 reopen never downgrades a runtime-verified blob reference to legacy-unverified', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-schema16-verification-'));
  const filename = path.join(directory, 'projects.sqlite3');
  try {
    const first = new ProjectDatabase(filename, { autoBackup: false });
    try {
      first.upsertAsset({
        id: 'verified-runtime-asset',
        projectId: 'verified-project',
        kind: 'image',
        mimeType: 'image/png',
        filename: 'verified.png',
        contentHash: 'd'.repeat(64),
        contentHashVerification: 'verified',
      });
      first.upsertAsset({
        id: 'verified-runtime-asset',
        projectId: 'verified-project',
        kind: 'image',
        mimeType: 'image/png',
        filename: 'verified-renamed.png',
        contentHash: 'd'.repeat(64),
        metadata: { width: 1024, height: 1024 },
      });
      assert.equal(
        first.db.prepare('SELECT verification_state AS state FROM asset_blob_refs WHERE asset_id = ?').get('verified-runtime-asset').state,
        'verified',
      );
      first.upsertAsset({
        id: 'changed-runtime-asset',
        projectId: 'verified-project',
        kind: 'image',
        mimeType: 'image/png',
        filename: 'changed.png',
        contentHash: 'e'.repeat(64),
        contentHashVerification: 'verified',
      });
      first.upsertAsset({
        id: 'changed-runtime-asset',
        projectId: 'verified-project',
        kind: 'image',
        mimeType: 'image/png',
        filename: 'changed.png',
        contentHash: 'f'.repeat(64),
      });
      assert.equal(
        first.db.prepare('SELECT verification_state AS state FROM asset_blob_refs WHERE asset_id = ?').get('changed-runtime-asset').state,
        'unverified',
      );
    } finally {
      first.close();
    }

    const reopened = new ProjectDatabase(filename, { autoBackup: false });
    try {
      reopened.upsertAsset({
        id: 'verified-runtime-asset',
        projectId: 'verified-project',
        kind: 'image',
        mimeType: 'image/png',
        filename: 'verified-reopened.png',
        contentHash: 'd'.repeat(64),
        metadata: { width: 2048, height: 2048 },
      });
      assert.equal(
        reopened.db.prepare('SELECT verification_state AS state FROM asset_blob_refs WHERE asset_id = ?').get('verified-runtime-asset').state,
        'verified',
      );
      assert.equal(
        reopened.db.prepare("SELECT verification_state AS state FROM asset_blobs WHERE content_hash = ?").get('d'.repeat(64)).state,
        'verified',
      );
      assert.equal(
        reopened.db.prepare('SELECT verification_state AS state FROM asset_blob_refs WHERE asset_id = ?').get('changed-runtime-asset').state,
        'unverified',
      );
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
