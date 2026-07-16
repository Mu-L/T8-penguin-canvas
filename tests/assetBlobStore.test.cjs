const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  AssetBlobStore,
  AssetBlobStoreError,
  getAssetBlobStore,
  normalizeSha256,
} = require('../backend/src/services/assetBlobStore');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-cas-'));
  const root = path.join(directory, 'private-blobs');
  const sources = path.join(directory, 'sources');
  fs.mkdirSync(sources, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }));
  return { directory, root, sources, store: new AssetBlobStore(root) };
}

function writeSource(sources, name, content) {
  const filename = path.join(sources, name);
  fs.writeFileSync(filename, content);
  return filename;
}

function ownedTransientFiles(root) {
  const output = [];
  const queue = [root];
  while (queue.length) {
    const directory = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(filename);
      else if (/^\.cas-.*\.(?:tmp|lock)$/i.test(entry.name)) output.push(filename);
    }
  }
  return output;
}

test('SHA-256 paths are canonical, hash-layered, private, and traversal-proof', (t) => {
  const { store, directory } = fixture(t);
  const hash = 'ABCD'.padEnd(64, '0');
  const normalized = normalizeSha256(hash);
  const resolved = store.resolvePath(hash);

  assert.equal(normalized, hash.toLowerCase());
  assert.equal(
    path.relative(store.rootPath, resolved).split(path.sep).join('/'),
    `sha256/${normalized.slice(0, 2)}/${normalized.slice(2, 4)}/${normalized}`,
  );
  assert.equal(store.isBlobPath(resolved), true);
  assert.equal(store.isBlobPath(path.join(directory, normalized)), false);
  assert.throws(() => store.resolvePath('../outside'), (error) => (
    error instanceof AssetBlobStoreError && error.code === 'CAS_HASH_INVALID'
  ));
  assert.throws(() => store.resolvePath(`${normalized}/../../outside`), (error) => (
    error instanceof AssetBlobStoreError && error.code === 'CAS_HASH_INVALID'
  ));
});

test('installVerifiedFile fully verifies source hash and size and returns the integration contract', async (t) => {
  const { root, sources, store } = fixture(t);
  const content = Buffer.from('server-verified-cas-payload');
  const source = writeSource(sources, 'payload.bin', content);
  const expectedHash = sha256(content);

  const installed = await store.installVerifiedFile(source, {
    expectedHash,
    expectedSize: content.length,
    mimeType: 'application/octet-stream',
  });

  assert.deepEqual(
    Object.keys(installed).sort(),
    ['byteSize', 'contentHash', 'path', 'reused', 'storageKey'],
  );
  assert.equal(installed.contentHash, expectedHash);
  assert.equal(installed.byteSize, content.length);
  assert.equal(installed.reused, false);
  assert.equal(installed.storageKey, `sha256/${expectedHash.slice(0, 2)}/${expectedHash.slice(2, 4)}/${expectedHash}`);
  assert.equal(installed.path, store.resolvePath(expectedHash));
  assert.equal(store.isBlobPath(installed.path), true);
  assert.deepEqual(fs.readFileSync(installed.path), content);
  assert.equal(fs.existsSync(source), true, 'source is retained unless removeSource is explicit');
  assert.equal(path.relative(store.rootPath, installed.path).startsWith('..'), false);
  assert.deepEqual(await store.resolveVerifiedBlob(expectedHash, content.length), {
    contentHash: expectedHash,
    byteSize: content.length,
    path: installed.path,
  });
  assert.deepEqual(ownedTransientFiles(root), []);
});

test('client-declared hashes and sizes never authorize bytes that were not fully proven', async (t) => {
  const { root, sources, store } = fixture(t);
  const legitimate = Buffer.from('legitimate-content');
  const malicious = Buffer.from('malicious-content!');
  assert.equal(legitimate.length, malicious.length, 'fixture keeps the same byte size');
  const legitimateHash = sha256(legitimate);
  const goodSource = writeSource(sources, 'good.bin', legitimate);
  const badSource = writeSource(sources, 'bad.bin', malicious);

  await assert.rejects(
    store.installVerifiedFile(badSource, { expectedHash: legitimateHash, expectedSize: malicious.length }),
    (error) => error instanceof AssetBlobStoreError && error.code === 'CAS_SOURCE_HASH_MISMATCH',
  );
  assert.equal(fs.existsSync(store.resolvePath(legitimateHash)), false);
  assert.deepEqual(ownedTransientFiles(root), []);

  await assert.rejects(
    store.installVerifiedFile(goodSource, { expectedHash: legitimateHash, expectedSize: legitimate.length + 1 }),
    (error) => error instanceof AssetBlobStoreError && error.code === 'CAS_SOURCE_SIZE_MISMATCH',
  );
  assert.equal(fs.existsSync(store.resolvePath(legitimateHash)), false);

  await store.installVerifiedFile(goodSource, { expectedHash: legitimateHash, expectedSize: legitimate.length });
  await assert.rejects(
    store.installVerifiedFile(badSource, { expectedHash: legitimateHash, expectedSize: malicious.length }),
    (error) => error instanceof AssetBlobStoreError && error.code === 'CAS_SOURCE_HASH_MISMATCH',
    'an existing blob must not turn a claimed hash into proof of possession',
  );
  assert.deepEqual(fs.readFileSync(store.resolvePath(legitimateHash)), legitimate);
  assert.deepEqual(ownedTransientFiles(root), []);
});

test('concurrent same-hash installs across store instances expose one physical blob and revalidate reuse', async (t) => {
  const { root, sources } = fixture(t);
  const leftStore = new AssetBlobStore(root);
  const rightStore = new AssetBlobStore(root);
  const content = crypto.randomBytes(2 * 1024 * 1024 + 31);
  const expectedHash = sha256(content);
  const left = writeSource(sources, 'left.bin', content);
  const right = writeSource(sources, 'right.bin', content);

  const results = await Promise.all([
    leftStore.installVerifiedFile(left, { expectedHash, expectedSize: content.length }),
    rightStore.installVerifiedFile(right, { expectedHash, expectedSize: content.length }),
  ]);

  assert.equal(new Set(results.map((result) => result.path)).size, 1);
  assert.deepEqual(results.map((result) => result.reused).sort(), [false, true]);
  assert.deepEqual(fs.readFileSync(results[0].path), content);
  const shardEntries = fs.readdirSync(path.dirname(results[0].path));
  assert.deepEqual(shardEntries, [expectedHash]);
  assert.deepEqual(ownedTransientFiles(root), []);
});

test('a live same-hash owner is never reaped after the stale interval', async (t) => {
  const { root, sources } = fixture(t);
  const leftStore = new AssetBlobStore(root, { lockTimeoutMs: 1_000, staleLockMs: 1_000 });
  const rightStore = new AssetBlobStore(root, { lockTimeoutMs: 1_000, staleLockMs: 1_000 });
  const content = crypto.randomBytes(512 * 1024 + 19);
  const expectedHash = sha256(content);
  const left = writeSource(sources, 'long-commit-left.bin', content);
  const right = writeSource(sources, 'long-commit-right.bin', content);
  let activeCallbacks = 0;
  let maximumActiveCallbacks = 0;
  let enterFirst;
  let releaseFirst;
  const firstEntered = new Promise((resolve) => { enterFirst = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = leftStore.installVerifiedFile(left, {
    expectedHash,
    expectedSize: content.length,
    onInstalled: async () => {
      activeCallbacks += 1;
      maximumActiveCallbacks = Math.max(maximumActiveCallbacks, activeCallbacks);
      enterFirst();
      await firstGate;
      activeCallbacks -= 1;
    },
  });
  await firstEntered;
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  const second = rightStore.installVerifiedFile(right, {
    expectedHash,
    expectedSize: content.length,
    onInstalled: async () => {
      activeCallbacks += 1;
      maximumActiveCallbacks = Math.max(maximumActiveCallbacks, activeCallbacks);
      activeCallbacks -= 1;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(maximumActiveCallbacks, 1, 'the stale threshold must not evict a live owner');
  releaseFirst();

  const [installed, reused] = await Promise.all([first, second]);
  assert.equal(maximumActiveCallbacks, 1);
  assert.equal(installed.reused, false);
  assert.equal(reused.reused, true);
  assert.deepEqual(fs.readFileSync(installed.path), content);
  assert.deepEqual(ownedTransientFiles(root), []);
});

test('an existing blob is fully rehashed before reuse and corruption is never overwritten silently', async (t) => {
  const { root, sources, store } = fixture(t);
  const content = Buffer.from('immutable-blob');
  const expectedHash = sha256(content);
  const source = writeSource(sources, 'immutable.bin', content);
  const first = await store.installVerifiedFile(source, { expectedHash, expectedSize: content.length });

  fs.writeFileSync(first.path, Buffer.from('tampered-blob!'));
  assert.equal(fs.statSync(first.path).size, content.length, 'tamper keeps the original size');
  await assert.rejects(
    store.installVerifiedFile(source, { expectedHash, expectedSize: content.length }),
    (error) => error instanceof AssetBlobStoreError && error.code === 'CAS_BLOB_CORRUPT',
  );
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'tampered-blob!');
  assert.deepEqual(ownedTransientFiles(root), []);
});

test('resolve and isBlobPath reject a symlink masquerading as a hash-addressed blob', async (t) => {
  const { directory, sources, store } = fixture(t);
  const external = writeSource(sources, 'external.bin', 'external');
  const expectedHash = sha256('external');
  const target = store.resolvePath(expectedHash);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.symlinkSync(external, target, 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(String(error?.code))) {
      t.diagnostic('Windows symlink privilege is unavailable; path validation is covered by non-symlink cases');
      return;
    }
    throw error;
  }

  assert.equal(store.isBlobPath(target), false);
  assert.throws(() => store.resolvePath(expectedHash), (error) => (
    error instanceof AssetBlobStoreError && ['CAS_BLOB_UNSAFE', 'CAS_PATH_ESCAPE'].includes(error.code)
  ));
  assert.equal(fs.readFileSync(external, 'utf8'), 'external');
  assert.equal(path.resolve(external).startsWith(path.resolve(directory)), true);
});

test('removeVerifiedBlob verifies before deletion, is idempotent, and never deletes corrupt bytes', async (t) => {
  const { sources, store } = fixture(t);
  const content = Buffer.from('remove-after-verification');
  const expectedHash = sha256(content);
  const source = writeSource(sources, 'remove.bin', content);
  const installed = await store.installVerifiedFile(source, { expectedHash, expectedSize: content.length });

  assert.equal(await store.removeVerifiedBlob(expectedHash, { expectedSize: content.length }), true);
  assert.equal(fs.existsSync(installed.path), false);
  assert.equal(await store.removeVerifiedBlob(expectedHash), false);

  const second = await store.installVerifiedFile(source, { expectedHash, expectedSize: content.length });
  fs.writeFileSync(second.path, Buffer.alloc(content.length, 0x78));
  await assert.rejects(
    store.removeVerifiedBlob(expectedHash, { expectedSize: content.length }),
    (error) => error instanceof AssetBlobStoreError && error.code === 'CAS_BLOB_CORRUPT',
  );
  assert.equal(fs.existsSync(second.path), true);
});

test('install commit hooks and guarded deletes serialize references with the same hash lock', async (t) => {
  const { root, sources } = fixture(t);
  const installer = new AssetBlobStore(root);
  const deleter = new AssetBlobStore(root);
  const content = crypto.randomBytes(1024 * 1024 + 17);
  const expectedHash = sha256(content);
  const firstSource = writeSource(sources, 'commit-first.bin', content);
  let references = 0;
  let enterCommit;
  let releaseCommit;
  const commitEntered = new Promise((resolve) => { enterCommit = resolve; });
  const commitGate = new Promise((resolve) => { releaseCommit = resolve; });

  const installing = installer.installVerifiedFile(firstSource, {
    expectedHash,
    expectedSize: content.length,
    onInstalled: async () => {
      enterCommit();
      await commitGate;
      references = 1;
    },
  });
  await commitEntered;
  const deleting = deleter.removeVerifiedBlob(expectedHash, {
    expectedSize: content.length,
    beforeDelete: () => references === 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseCommit();
  const [installed, deleted] = await Promise.all([installing, deleting]);
  assert.equal(deleted, false, 'delete waits for the install commit and observes its new reference');
  assert.equal(fs.existsSync(installed.path), true);

  references = 0;
  let enterDeleteGuard;
  let releaseDeleteGuard;
  const deleteGuardEntered = new Promise((resolve) => { enterDeleteGuard = resolve; });
  const deleteGate = new Promise((resolve) => { releaseDeleteGuard = resolve; });
  const deleteFirst = deleter.removeVerifiedBlob(expectedHash, {
    expectedSize: content.length,
    beforeDelete: async () => {
      enterDeleteGuard();
      await deleteGate;
      return references === 0;
    },
  });
  await deleteGuardEntered;
  const secondSource = writeSource(sources, 'install-after-delete.bin', content);
  const installAfterDelete = installer.installVerifiedFile(secondSource, {
    expectedHash,
    expectedSize: content.length,
    onInstalled: () => { references = 1; },
  });
  releaseDeleteGuard();
  const [wasDeleted, reinstalled] = await Promise.all([deleteFirst, installAfterDelete]);
  assert.equal(wasDeleted, true);
  assert.equal(reinstalled.reused, false, 'an install waiting behind deletion recreates verified bytes');
  assert.equal(references, 1);
  assert.deepEqual(fs.readFileSync(reinstalled.path), content);
});

test('a failed install commit restores an explicitly removed source and rolls back a new blob', async (t) => {
  const { sources, store } = fixture(t);
  const content = Buffer.from('restore-source-after-commit-failure');
  const expectedHash = sha256(content);
  const source = writeSource(sources, 'commit-failure.bin', content);

  await assert.rejects(
    store.installVerifiedFile(source, {
      expectedHash,
      expectedSize: content.length,
      removeSource: true,
      onInstalled: () => { throw new Error('database-commit-failed'); },
    }),
    /database-commit-failed/,
  );
  assert.deepEqual(fs.readFileSync(source), content);
  assert.equal(fs.existsSync(store.resolvePath(expectedHash)), false);
});

test('removeSource is post-install only and the config factory is stable per private root', async (t) => {
  const { directory, sources } = fixture(t);
  const data = path.join(directory, 'data');
  const store = getAssetBlobStore({ DATA_DIR: data });
  assert.equal(store, getAssetBlobStore({ DATA_DIR: data }));
  const content = Buffer.from('move-into-private-cas');
  const expectedHash = sha256(content);
  const source = writeSource(sources, 'move.bin', content);

  const installed = await store.installVerifiedFile(source, {
    expectedHash,
    expectedSize: content.length,
    removeSource: true,
  });
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(fs.readFileSync(installed.path), content);
  assert.match(installed.storageKey, /^sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}$/);

  const bad = writeSource(sources, 'bad-move.bin', 'not-the-content');
  await assert.rejects(
    store.installVerifiedFile(bad, { expectedHash, expectedSize: fs.statSync(bad).size, removeSource: true }),
    (error) => error instanceof AssetBlobStoreError && error.code === 'CAS_SOURCE_HASH_MISMATCH',
  );
  assert.equal(fs.existsSync(bad), true, 'failed verification must never remove the source');
});

test('cleanupTemporaryFiles removes only stale owned temp/lock names', (t) => {
  const { store } = fixture(t);
  const hash = 'f'.repeat(64);
  const target = store.resolvePath(hash);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staleTemp = path.join(path.dirname(target), `.cas-${hash}-${process.pid}-${crypto.randomUUID()}.tmp`);
  const staleLock = path.join(path.dirname(target), `.cas-${hash}.lock`);
  const activeHash = 'e'.repeat(64);
  const activeTarget = store.resolvePath(activeHash);
  fs.mkdirSync(path.dirname(activeTarget), { recursive: true });
  const activeLock = path.join(path.dirname(activeTarget), `.cas-${activeHash}.lock`);
  const unrelated = path.join(path.dirname(target), 'keep-me.tmp');
  const recentTemp = path.join(path.dirname(target), `.cas-${hash}-${process.pid}-${crypto.randomUUID()}.tmp`);
  [staleTemp, staleLock, unrelated, recentTemp].forEach((filename) => fs.writeFileSync(filename, 'x'));
  fs.writeFileSync(activeLock, `${JSON.stringify({
    version: 1,
    pid: process.pid,
    token: crypto.randomUUID(),
    createdAtMs: Date.now() - 120_000,
  })}\n`);
  const now = Date.now();
  fs.utimesSync(staleTemp, new Date(now - 120_000), new Date(now - 120_000));
  fs.utimesSync(staleLock, new Date(now - 120_000), new Date(now - 120_000));
  fs.utimesSync(activeLock, new Date(now - 120_000), new Date(now - 120_000));

  const result = store.cleanupTemporaryFiles({ now, maxAgeMs: 60_000 });
  assert.equal(result.removed, 2);
  assert.equal(fs.existsSync(staleTemp), false);
  assert.equal(fs.existsSync(staleLock), false);
  assert.equal(fs.existsSync(activeLock), true, 'cleanup must not reap a lock owned by a live process');
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(fs.existsSync(recentTemp), true);
});
