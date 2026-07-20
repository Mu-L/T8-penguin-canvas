'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'project-duplicate-refresh-b2';

function addAsset(database, id, input = {}) {
  return database.upsertAsset({
    id,
    projectId: input.projectId || PROJECT_ID,
    kind: input.kind || 'image',
    mimeType: input.kind === 'video' ? 'video/mp4' : 'image/png',
    filename: `${id}.${input.kind === 'video' ? 'mp4' : 'png'}`,
    contentHash: input.contentHash || id.padEnd(64, 'a').slice(0, 64).replace(/[^a-f0-9]/gi, 'a').toLowerCase(),
    contentHashVerification: input.contentHashVerification || 'verified',
    perceptualHashAlgorithm: input.perceptualHashAlgorithm,
    perceptualHashes: input.perceptualHashes,
    createdBy: 'duplicate-refresh-b2',
  });
}

function addNearPair(database, suffix = '') {
  const source = addAsset(database, `duplicate-source${suffix}`, {
    contentHash: '1'.repeat(64),
    perceptualHashAlgorithm: 'phash-dct64-v1',
    perceptualHashes: [{ hash: '0000000000000000' }],
  });
  const target = addAsset(database, `duplicate-target${suffix}`, {
    contentHash: '2'.repeat(64),
    perceptualHashAlgorithm: 'phash-dct64-v1',
    perceptualHashes: [{ hash: '0000000000000001' }],
  });
  return { source, target };
}

function totalChanges(database) {
  return Number(database.db.prepare('SELECT total_changes() AS value').get().value);
}

function writeSequence(database) {
  return Number(database.db.prepare(`
    SELECT write_sequence AS value
    FROM project_database_identity
    WHERE singleton_id = 1
  `).get().value);
}

function count(database, table) {
  return Number(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

function assertScanRequired(error, asset, catalogRevision) {
  assert.equal(error.code, 'asset_duplicate_scan_required');
  assert.deepEqual(error.current, {
    assetId: asset.id,
    projectId: asset.projectId,
    revision: catalogRevision,
    catalogRevision,
  });
  return true;
}

test('B2 exact/all/near duplicate reads stay pure and all fails closed before returning exact rows', async () => {
  const database = new ProjectDatabase(':memory:');
  let queryOnly = false;
  try {
    const { source } = addNearPair(database, '-pure');
    addAsset(database, 'duplicate-exact-pure', {
      contentHash: source.contentHash,
      contentHashVerification: 'verified',
    });
    addAsset(database, 'duplicate-exact-pure-2', {
      contentHash: source.contentHash,
      contentHashVerification: 'verified',
    });
    const catalogRevision = database.getAssetCatalogRevision(PROJECT_ID);
    const beforeMissingScanReads = totalChanges(database);

    database.db.pragma('query_only = ON');
    queryOnly = true;
    assert.throws(
      () => database.listAssetDuplicates(source.id, { mode: 'all', limit: 1 }),
      (error) => assertScanRequired(error, source, catalogRevision),
    );
    assert.throws(
      () => database.listAssetDuplicates(source.id, { mode: 'near', limit: 1 }),
      (error) => assertScanRequired(error, source, catalogRevision),
    );
    assert.throws(
      () => database.findAssetDuplicates(source.id, 8),
      (error) => assertScanRequired(error, source, catalogRevision),
    );
    const exact = database.listAssetDuplicates(source.id, { mode: 'exact', limit: 10 });
    assert.deepEqual(exact.items.map((item) => item.asset.id), ['duplicate-exact-pure', 'duplicate-exact-pure-2']);
    assert.equal(exact.catalogRevision, catalogRevision);
    assert.equal(totalChanges(database), beforeMissingScanReads);
    assert.equal(count(database, 'asset_duplicate_candidates'), 0);
    assert.equal(count(database, 'asset_duplicate_scans'), 0);

    database.db.pragma('query_only = OFF');
    queryOnly = false;
    database.refreshAssetDuplicateCandidates(source.id, { expectedCatalogRevision: catalogRevision });
    const beforePurePages = totalChanges(database);
    const candidatesBefore = database.db.prepare('SELECT * FROM asset_duplicate_candidates ORDER BY id').all();
    const scansBefore = database.db.prepare('SELECT * FROM asset_duplicate_scans ORDER BY asset_id').all();
    const originalEvidence = database._nearDuplicateEvidence.bind(database);
    let evidenceCalls = 0;
    database._nearDuplicateEvidence = (...args) => {
      evidenceCalls += 1;
      return originalEvidence(...args);
    };

    database.db.pragma('query_only = ON');
    queryOnly = true;
    const allIds = [];
    const allTypes = [];
    let allCursor = null;
    let staleCursor = null;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = database.listAssetDuplicates(source.id, {
        mode: 'all',
        limit: 1,
        cursor: allCursor || undefined,
      });
      assert.equal(page.catalogRevision, catalogRevision);
      assert.equal(page.items.length, 1);
      allIds.push(page.items[0].asset.id);
      allTypes.push(page.items[0].type);
      if (pageIndex === 0) staleCursor = page.nextCursor;
      allCursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    assert.deepEqual(allIds, [
      'duplicate-exact-pure',
      'duplicate-exact-pure-2',
      'duplicate-target-pure',
    ]);
    assert.deepEqual(allTypes, ['exact', 'exact', 'near']);
    assert.equal(allCursor, null);
    assert.ok(staleCursor);
    const near = database.listAssetDuplicates(source.id, { mode: 'near', limit: 10 });
    assert.equal(near.items.some((item) => item.asset.id.includes('duplicate-target')), true);
    assert.equal(evidenceCalls, 0);
    assert.equal(totalChanges(database), beforePurePages);
    assert.deepEqual(database.db.prepare('SELECT * FROM asset_duplicate_candidates ORDER BY id').all(), candidatesBefore);
    assert.deepEqual(database.db.prepare('SELECT * FROM asset_duplicate_scans ORDER BY asset_id').all(), scansBefore);

    database.db.pragma('query_only = OFF');
    queryOnly = false;
    addAsset(database, 'duplicate-cursor-catalog-bump', { contentHash: 'e'.repeat(64) });
    const bumpedCatalogRevision = database.getAssetCatalogRevision(PROJECT_ID);
    const beforeStaleCursorRead = totalChanges(database);
    database.db.pragma('query_only = ON');
    queryOnly = true;
    assert.throws(
      () => database.listAssetDuplicates(source.id, { mode: 'all', limit: 1, cursor: staleCursor }),
      (error) => error.code === 'asset_catalog_revision_conflict'
        && error.current.catalogRevision === bumpedCatalogRevision,
    );
    assert.equal(totalChanges(database), beforeStaleCursorRead);
  } finally {
    if (queryOnly) database.db.pragma('query_only = OFF');
    await database.close();
  }
});

test('B2 refresh canonicalizes both endpoints and binds decisions to catalog and evidence revisions', async () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const source = addAsset(database, 'duplicate-source-decision', {
      contentHash: '1'.repeat(64),
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: '0000000000000000', frameIndex: 7, timestampMs: 700, normalizedTime: 0.2 }],
    });
    const target = addAsset(database, 'duplicate-target-decision', {
      contentHash: '2'.repeat(64),
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: '0000000000000001', frameIndex: 13, timestampMs: 1300, normalizedTime: 0.8 }],
    });
    const firstCatalogRevision = database.getAssetCatalogRevision(PROJECT_ID);
    const firstRefresh = database.refreshAssetDuplicateCandidates(source.id, {
      expectedCatalogRevision: firstCatalogRevision,
    });
    assert.equal(firstRefresh.refreshed, true);
    const firstRow = database.db.prepare('SELECT * FROM asset_duplicate_candidates').get();

    const oppositeRefresh = database.refreshAssetDuplicateCandidates(target.id, {
      expectedCatalogRevision: firstCatalogRevision,
    });
    assert.equal(oppositeRefresh.refreshed, true);
    assert.deepEqual(database.db.prepare('SELECT * FROM asset_duplicate_candidates').get(), firstRow);
    const targetRelative = database.listAssetDuplicates(target.id, { mode: 'near', limit: 10 }).items[0];
    assert.equal(targetRelative.asset.id, source.id);
    assert.equal(targetRelative.evidence[0].sourceFrameIndex, 13);
    assert.equal(targetRelative.evidence[0].targetFrameIndex, 7);
    assert.equal(targetRelative.evidence[0].sourceTimestampMs, 1300);
    assert.equal(targetRelative.evidence[0].targetTimestampMs, 700);
    assert.equal(targetRelative.evidence[0].sourceNormalizedTime, 0.8);
    assert.equal(targetRelative.evidence[0].targetNormalizedTime, 0.2);

    const initial = database.listAssetDuplicates(source.id, { mode: 'near', limit: 10 }).items[0];
    const decided = database.setAssetDuplicateDecision(PROJECT_ID, initial.id, {
      decision: 'confirmed',
      expectedRevision: initial.decisionRevision,
      expectedCatalogRevision: firstCatalogRevision,
    }, { actorId: 'duplicate-reviewer' });
    assert.equal(decided.decision, 'confirmed');
    assert.equal(decided.revision, 2);

    addAsset(database, 'duplicate-unrelated-catalog-bump', { contentHash: 'f'.repeat(64) });
    const secondCatalogRevision = database.getAssetCatalogRevision(PROJECT_ID);
    database.refreshAssetDuplicateCandidates(source.id, {
      expectedCatalogRevision: secondCatalogRevision,
    });
    const sameEvidence = database.db.prepare('SELECT * FROM asset_duplicate_candidates WHERE id = ?').get(initial.id);
    assert.equal(sameEvidence.decision, 'confirmed');
    assert.equal(sameEvidence.revision, 3);
    assert.equal(sameEvidence.decided_by, 'duplicate-reviewer');
    assert.equal(sameEvidence.decided_at, decided.decidedAt);
    assert.throws(
      () => database.setAssetDuplicateDecision(PROJECT_ID, initial.id, {
        decision: 'dismissed',
        expectedRevision: decided.revision,
        expectedCatalogRevision: secondCatalogRevision,
      }),
      (error) => error.code === 'asset_duplicate_revision_conflict' && error.current.revision === 3,
    );

    database.upsertAsset({
      id: target.id,
      projectId: target.projectId,
      kind: target.kind,
      mimeType: target.mimeType,
      filename: target.filename,
      contentHash: target.contentHash,
      contentHashVerification: 'verified',
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: '0000000000000003', frameIndex: 13, timestampMs: 1300, normalizedTime: 0.8 }],
    });
    const thirdCatalogRevision = database.getAssetCatalogRevision(PROJECT_ID);
    database.refreshAssetDuplicateCandidates(source.id, {
      expectedCatalogRevision: thirdCatalogRevision,
    });
    const changedEvidence = database.db.prepare('SELECT * FROM asset_duplicate_candidates WHERE id = ?').get(initial.id);
    assert.equal(changedEvidence.decision, 'pending');
    assert.equal(changedEvidence.revision, 4);
    assert.equal(changedEvidence.decided_by, null);
    assert.equal(changedEvidence.decided_at, null);
  } finally {
    await database.close();
  }
});

test('B2 legacy endpoint-oriented scans fail closed and explicit refresh rewrites canonical evidence', async () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const source = addAsset(database, 'z-legacy-source', {
      contentHash: '3'.repeat(64),
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: '0000000000000000', frameIndex: 7, timestampMs: 700, normalizedTime: 0.7 }],
    });
    const target = addAsset(database, 'a-legacy-target', {
      contentHash: '4'.repeat(64),
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: '0000000000000001', frameIndex: 3, timestampMs: 300, normalizedTime: 0.3 }],
    });
    const staleTarget = addAsset(database, 'm-legacy-stale-target', {
      contentHash: '5'.repeat(64),
    });
    const catalogRevision = database.getAssetCatalogRevision(PROJECT_ID);
    database.refreshAssetDuplicateCandidates(source.id, { expectedCatalogRevision: catalogRevision });
    const row = database.db.prepare('SELECT * FROM asset_duplicate_candidates').get();
    const legacyAggregate = database._nearDuplicateEvidence(
      source,
      target,
      database.listAssetFingerprints(source.id),
      database.listAssetFingerprints(target.id),
      8,
    );
    database.db.prepare(`
      UPDATE asset_duplicate_candidates
      SET evidence_json = ?, decision = 'confirmed', revision = 5,
        decided_by = 'legacy-reviewer', decided_at = 1234
      WHERE id = ?
    `).run(JSON.stringify(legacyAggregate), row.id);
    database.db.prepare(`
      UPDATE asset_duplicate_scans SET updated_at = ABS(updated_at) WHERE asset_id = ?
    `).run(source.id);
    const [staleLeftId, staleRightId] = [source.id, staleTarget.id].sort();
    database.db.prepare(`
      INSERT INTO asset_duplicate_candidates(
        id, project_id, left_asset_id, right_asset_id, algorithm, distance, minimum_distance,
        catalog_revision, confidence, evidence_json, decision, revision,
        decided_by, decided_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'phash-dct64-v1', 1, 1, ?, 'low', ?, 'confirmed', 4,
        'legacy-reviewer', 1234, 1234, 1234)
    `).run(
      'duplicate_legacy_same_catalog_stale',
      PROJECT_ID,
      staleLeftId,
      staleRightId,
      catalogRevision,
      JSON.stringify(legacyAggregate),
    );

    assert.throws(
      () => database.listAssetDuplicates(source.id, { mode: 'near', limit: 10 }),
      (error) => assertScanRequired(error, source, catalogRevision),
    );
    const refreshed = database.refreshAssetDuplicateCandidates(source.id, { expectedCatalogRevision: catalogRevision });
    assert.equal(refreshed.refreshed, true);
    const scan = database.db.prepare('SELECT * FROM asset_duplicate_scans WHERE asset_id = ?').get(source.id);
    assert.equal(scan.updated_at < 0, true);
    const rewritten = database.db.prepare('SELECT * FROM asset_duplicate_candidates WHERE id = ?').get(row.id);
    assert.equal(rewritten.decision, 'pending');
    assert.equal(rewritten.revision, 6);
    assert.equal(rewritten.decided_by, null);
    assert.equal(rewritten.decided_at, null);
    assert.equal(
      database.db.prepare('SELECT id FROM asset_duplicate_candidates WHERE id = ?').get('duplicate_legacy_same_catalog_stale'),
      undefined,
    );
    const relative = database.listAssetDuplicates(source.id, { mode: 'near', limit: 10 }).items[0];
    assert.equal(relative.asset.id, target.id);
    assert.equal(relative.evidence[0].sourceFrameIndex, 7);
    assert.equal(relative.evidence[0].targetFrameIndex, 3);
    assert.equal(relative.evidence[0].sourceTimestampMs, 700);
    assert.equal(relative.evidence[0].targetTimestampMs, 300);

    database.db.prepare('UPDATE asset_duplicate_candidates SET catalog_revision = 1 WHERE id = ?').run(row.id);
    database.db.prepare('UPDATE asset_duplicate_scans SET catalog_revision = 1 WHERE asset_id = ?').run(source.id);
    database.db.prepare('DELETE FROM asset_catalog_revisions WHERE project_id = ?').run(PROJECT_ID);
    assert.equal(database.getAssetCatalogRevision(PROJECT_ID), 1);
    const logicalDefaultCandidate = database.listAssetDuplicates(source.id, { mode: 'near', limit: 10 }).items[0];
    const logicalDefaultDecision = database.setAssetDuplicateDecision(PROJECT_ID, row.id, {
      decision: 'confirmed',
      expectedRevision: logicalDefaultCandidate.decisionRevision,
      expectedCatalogRevision: 1,
    });
    assert.equal(logicalDefaultDecision.decision, 'confirmed');
    assert.equal(logicalDefaultDecision.revision, 7);
  } finally {
    await database.close();
  }
});

test('B2 stale decision catalog CAS prevents candidate revision ABA after content replacement', async () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const { source, target } = addNearPair(database, '-aba');
    const firstCatalogRevision = database.getAssetCatalogRevision(PROJECT_ID);
    database.refreshAssetDuplicateCandidates(source.id, { expectedCatalogRevision: firstCatalogRevision });
    const staleCandidate = database.listAssetDuplicates(source.id, { mode: 'near', limit: 10 }).items[0];
    assert.equal(staleCandidate.decisionRevision, 1);

    database.upsertAsset({
      id: target.id,
      projectId: target.projectId,
      kind: target.kind,
      mimeType: target.mimeType,
      filename: target.filename,
      contentHash: '9'.repeat(64),
      contentHashVerification: 'verified',
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: '0000000000000001' }],
    });
    const secondCatalogRevision = database.getAssetCatalogRevision(PROJECT_ID);
    database.refreshAssetDuplicateCandidates(source.id, { expectedCatalogRevision: secondCatalogRevision });
    const replacement = database.listAssetDuplicates(source.id, { mode: 'near', limit: 10 }).items[0];
    assert.equal(replacement.id, staleCandidate.id);
    assert.equal(replacement.decisionRevision, 1, 'delete/reinsert deliberately reproduces the candidate revision ABA');

    const rowBeforeStaleDecision = database.db.prepare('SELECT * FROM asset_duplicate_candidates WHERE id = ?').get(staleCandidate.id);
    const writeSequenceBeforeStaleDecision = writeSequence(database);
    assert.throws(
      () => database.setAssetDuplicateDecision(PROJECT_ID, staleCandidate.id, {
        decision: 'confirmed',
        expectedRevision: staleCandidate.decisionRevision,
        expectedCatalogRevision: firstCatalogRevision,
      }),
      (error) => error.code === 'asset_catalog_revision_conflict'
        && error.current.catalogRevision === secondCatalogRevision,
    );
    assert.equal(writeSequence(database), writeSequenceBeforeStaleDecision);
    assert.deepEqual(
      database.db.prepare('SELECT * FROM asset_duplicate_candidates WHERE id = ?').get(staleCandidate.id),
      rowBeforeStaleDecision,
    );

    const freshDecision = database.setAssetDuplicateDecision(PROJECT_ID, replacement.id, {
      decision: 'confirmed',
      expectedRevision: replacement.decisionRevision,
      expectedCatalogRevision: secondCatalogRevision,
    });
    assert.equal(freshDecision.decision, 'confirmed');
    assert.equal(freshDecision.revision, 2);
  } finally {
    await database.close();
  }
});

test('B2 duplicate list end CAS rejects cross-connection catalog drift without returning mixed assets', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-duplicate-list-drift-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  let first = null;
  let second = null;
  try {
    first = new ProjectDatabase(filename, {
      autoBackup: false,
      unsafeDisableOwnerGuardForTests: true,
    });
    const { source, target } = addNearPair(first, '-list-drift');
    const catalogRevision = first.getAssetCatalogRevision(PROJECT_ID);
    first.refreshAssetDuplicateCandidates(source.id, { expectedCatalogRevision: catalogRevision });
    second = new ProjectDatabase(filename, {
      autoBackup: false,
      unsafeDisableOwnerGuardForTests: true,
    });

    const originalHydrate = first._hydrateAssetIdsOrdered.bind(first);
    let interleaved = false;
    first._hydrateAssetIdsOrdered = (ids) => {
      if (!interleaved) {
        interleaved = true;
        second.upsertAsset({
          id: target.id,
          projectId: target.projectId,
          kind: target.kind,
          mimeType: target.mimeType,
          filename: 'duplicate-target-list-drift-renamed.png',
          contentHash: target.contentHash,
          contentHashVerification: 'verified',
          perceptualHashAlgorithm: 'phash-dct64-v1',
          perceptualHashes: [{ hash: '0000000000000001' }],
        });
      }
      return originalHydrate(ids);
    };
    const beforeRead = totalChanges(first);
    assert.throws(
      () => first.listAssetDuplicates(source.id, { mode: 'near', limit: 10 }),
      (error) => error.code === 'asset_catalog_revision_conflict'
        && error.current.catalogRevision > catalogRevision,
    );
    assert.equal(interleaved, true);
    assert.equal(totalChanges(first), beforeRead);
  } finally {
    try { await second?.close(); } catch (_) {}
    try { await first?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('B2 refresh rejects calculation drift and interleaved same-revision connections commit once', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-duplicate-refresh-interleave-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  let first = null;
  let second = null;
  try {
    first = new ProjectDatabase(filename, {
      autoBackup: false,
      unsafeDisableOwnerGuardForTests: true,
    });
    const { source } = addNearPair(first, '-interleave');
    const revision = first.getAssetCatalogRevision(PROJECT_ID);
    second = new ProjectDatabase(filename, {
      autoBackup: false,
      unsafeDisableOwnerGuardForTests: true,
    });

    const originalCompute = first._computeAssetDuplicateCandidates.bind(first);
    let interleavedResult = null;
    first._computeAssetDuplicateCandidates = (asset) => {
      const computed = originalCompute(asset);
      interleavedResult = second.refreshAssetDuplicateCandidates(source.id, {
        expectedCatalogRevision: revision,
      });
      return computed;
    };
    const outerResult = first.refreshAssetDuplicateCandidates(source.id, {
      expectedCatalogRevision: revision,
    });
    assert.equal(interleavedResult.refreshed, true);
    assert.equal(outerResult.refreshed, false);
    assert.equal(count(first, 'asset_duplicate_candidates'), 1);
    assert.equal(count(first, 'asset_duplicate_scans'), 1);

    addAsset(first, 'duplicate-drift-source', {
      contentHash: '3'.repeat(64),
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: '0000000000000000' }],
    });
    addAsset(first, 'duplicate-drift-target', {
      contentHash: '4'.repeat(64),
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: '0000000000000001' }],
    });
    const driftRevision = first.getAssetCatalogRevision(PROJECT_ID);
    first._computeAssetDuplicateCandidates = (asset) => {
      const computed = originalCompute(asset);
      first.db.prepare('UPDATE assets SET content_revision = content_revision + 1 WHERE id = ?').run(asset.id);
      return computed;
    };
    assert.throws(
      () => first.refreshAssetDuplicateCandidates('duplicate-drift-source', {
        expectedCatalogRevision: driftRevision,
      }),
      (error) => error.code === 'asset_duplicate_identity_conflict',
    );
    assert.equal(first.db.prepare('SELECT * FROM asset_duplicate_scans WHERE asset_id = ?').get('duplicate-drift-source'), undefined);
  } finally {
    try { await second?.close(); } catch (_) {}
    try { await first?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('B2 refresh fails closed when a malformed database exceeds the per-asset fingerprint bound', async () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const source = addAsset(database, 'duplicate-fingerprint-overflow-source', {
      contentHash: '5'.repeat(64),
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: Array.from({ length: 64 }, (_, frameIndex) => ({
        hash: '0000000000000000',
        frameIndex,
      })),
    });
    addAsset(database, 'duplicate-fingerprint-overflow-target', {
      contentHash: '6'.repeat(64),
      perceptualHashAlgorithm: 'phash-dct64-v1',
      perceptualHashes: [{ hash: '0000000000000001' }],
    });
    database.db.prepare(`
      INSERT INTO asset_fingerprints(
        id, project_id, asset_id, content_hash, algorithm, frame_kind, frame_index,
        timestamp_ms, normalized_time, hash_hex,
        band_0, band_1, band_2, band_3, band_4, band_5, band_6, band_7, band_8,
        evidence_json, created_at, updated_at
      )
      SELECT 'duplicate-fingerprint-overflow-65', project_id, asset_id, content_hash,
        algorithm, frame_kind, 64, timestamp_ms, normalized_time, hash_hex,
        band_0, band_1, band_2, band_3, band_4, band_5, band_6, band_7, band_8,
        evidence_json, created_at, updated_at
      FROM asset_fingerprints WHERE asset_id = ? ORDER BY frame_index LIMIT 1
    `).run(source.id);

    assert.throws(
      () => database.refreshAssetDuplicateCandidates(source.id, {
        expectedCatalogRevision: database.getAssetCatalogRevision(PROJECT_ID),
      }),
      (error) => error.code === 'asset_duplicate_scan_limit_exceeded',
    );
    assert.equal(count(database, 'asset_duplicate_candidates'), 0);
    assert.equal(count(database, 'asset_duplicate_scans'), 0);

    database._computeAssetDuplicateCandidates = () => {
      const error = new Error('controlled duplicate compute temp full');
      error.code = 'SQLITE_FULL';
      throw error;
    };
    assert.throws(
      () => database.refreshAssetDuplicateCandidates(source.id, {
        expectedCatalogRevision: database.getAssetCatalogRevision(PROJECT_ID),
      }),
      (error) => {
        assert.ok(error instanceof ProjectDatabaseStorageCapacityError);
        assert.equal(error.reason, 'sqlite-full');
        assert.equal(error.details.operation, 'asset.duplicate.refresh');
        return true;
      },
    );
  } finally {
    await database.close();
  }
});

test('B2 explicit refresh translates a real late SQLITE_FULL after rolling candidates, scan and filler back', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-duplicate-refresh-full-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  let database = null;
  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    const { source } = addNearPair(database, '-full');
    const catalogRevision = database.getAssetCatalogRevision(PROJECT_ID);
    let lateWriteReached = false;
    database.db.function('duplicate_refresh_b2_mark_late_write', () => {
      lateWriteReached = true;
      return 1;
    });
    database.db.exec(`
      CREATE TABLE duplicate_refresh_b2_filler (
        id INTEGER PRIMARY KEY,
        payload BLOB NOT NULL
      );
      CREATE TRIGGER duplicate_refresh_b2_force_late_full
      BEFORE INSERT ON asset_duplicate_scans
      WHEN NEW.asset_id = '${source.id}'
      BEGIN
        SELECT duplicate_refresh_b2_mark_late_write();
        INSERT INTO duplicate_refresh_b2_filler(payload) VALUES (zeroblob(16777216));
      END;
    `);
    database.db.pragma('wal_checkpoint(TRUNCATE)');
    database.db.exec('VACUUM');
    database.db.pragma('wal_checkpoint(TRUNCATE)');
    const pageCount = Number(database.db.pragma('page_count', { simple: true }));
    const constrainedPageCount = pageCount + 64;
    assert.equal(
      Number(database.db.pragma(`max_page_count = ${constrainedPageCount}`, { simple: true })),
      constrainedPageCount,
    );

    assert.throws(
      () => database.refreshAssetDuplicateCandidates(source.id, { expectedCatalogRevision: catalogRevision }),
      (error) => {
        assert.ok(error instanceof ProjectDatabaseStorageCapacityError);
        assert.equal(error.code, 'project_database_storage_capacity_exceeded');
        assert.equal(error.status, 507);
        assert.equal(error.reason, 'sqlite-full');
        assert.deepEqual(error.details, {
          reason: 'sqlite-full',
          retryable: false,
          operation: 'asset.duplicate.refresh',
        });
        return true;
      },
    );
    assert.equal(lateWriteReached, true);
    assert.equal(count(database, 'asset_duplicate_candidates'), 0);
    assert.equal(count(database, 'asset_duplicate_scans'), 0);
    assert.equal(count(database, 'duplicate_refresh_b2_filler'), 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');

    database.db.pragma('max_page_count = 1073741823');
    lateWriteReached = false;
    const retried = database.refreshAssetDuplicateCandidates(source.id, {
      expectedCatalogRevision: catalogRevision,
    });
    assert.equal(retried.refreshed, true);
    assert.equal(lateWriteReached, true);
    assert.equal(count(database, 'asset_duplicate_candidates'), 1);
    assert.equal(count(database, 'asset_duplicate_scans'), 1);
    assert.equal(count(database, 'duplicate_refresh_b2_filler'), 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');

    const candidate = database.listAssetDuplicates(source.id, { mode: 'near', limit: 10 }).items[0];
    database.setAssetDuplicateDecision(PROJECT_ID, candidate.id, {
      decision: 'confirmed',
      expectedRevision: candidate.decisionRevision,
      expectedCatalogRevision: catalogRevision,
    }, { actorId: 'capacity-reviewer' });
    addAsset(database, 'duplicate-full-catalog-bump', { contentHash: 'd'.repeat(64) });
    const nextCatalogRevision = database.getAssetCatalogRevision(PROJECT_ID);
    database.db.pragma('wal_checkpoint(TRUNCATE)');
    database.db.exec('VACUUM');
    database.db.pragma('wal_checkpoint(TRUNCATE)');
    const candidatesBeforeUpdateFailure = database.db.prepare('SELECT * FROM asset_duplicate_candidates ORDER BY id').all();
    const scansBeforeUpdateFailure = database.db.prepare('SELECT * FROM asset_duplicate_scans ORDER BY asset_id').all();
    const updatePageCount = Number(database.db.pragma('page_count', { simple: true }));
    const constrainedUpdatePageCount = updatePageCount + 64;
    assert.equal(
      Number(database.db.pragma(`max_page_count = ${constrainedUpdatePageCount}`, { simple: true })),
      constrainedUpdatePageCount,
    );
    lateWriteReached = false;
    assert.throws(
      () => database.refreshAssetDuplicateCandidates(source.id, { expectedCatalogRevision: nextCatalogRevision }),
      (error) => error instanceof ProjectDatabaseStorageCapacityError
        && error.details.operation === 'asset.duplicate.refresh',
    );
    assert.equal(lateWriteReached, true);
    assert.deepEqual(
      database.db.prepare('SELECT * FROM asset_duplicate_candidates ORDER BY id').all(),
      candidatesBeforeUpdateFailure,
    );
    assert.deepEqual(
      database.db.prepare('SELECT * FROM asset_duplicate_scans ORDER BY asset_id').all(),
      scansBeforeUpdateFailure,
    );
    assert.equal(count(database, 'duplicate_refresh_b2_filler'), 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');

    database.db.pragma('max_page_count = 1073741823');
    const updateRetried = database.refreshAssetDuplicateCandidates(source.id, {
      expectedCatalogRevision: nextCatalogRevision,
    });
    assert.equal(updateRetried.refreshed, true);
    const preserved = database.db.prepare('SELECT * FROM asset_duplicate_candidates WHERE id = ?').get(candidate.id);
    assert.equal(preserved.decision, 'confirmed');
    assert.equal(preserved.revision, 3);
    assert.equal(preserved.decided_by, 'capacity-reviewer');
    assert.equal(count(database, 'duplicate_refresh_b2_filler'), 2);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
  } finally {
    try {
      if (database?.db?.open) database.db.pragma('max_page_count = 1073741823');
    } catch (_) {}
    try { await database?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
