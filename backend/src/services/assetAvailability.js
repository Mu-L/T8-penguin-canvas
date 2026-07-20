'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);
const PERMISSION_CODES = new Set(['EACCES', 'EPERM']);
const MEDIA_VERIFICATION_CACHE_LIMIT = 256;
const MEDIA_VERIFICATION_QUEUE_LIMIT = 128;
const MEDIA_VERIFICATION_CONCURRENCY = 4;
const verifiedMediaCache = new Map();
const inflightMediaVerifications = new Map();
const mediaVerificationWaiters = [];
let activeMediaVerifications = 0;

function availabilityStatIdentity(stat) {
  return {
    dev: Number(stat?.dev) || 0,
    ino: Number(stat?.ino) || 0,
    mode: Number(stat?.mode) || 0,
    size: Number(stat?.size) || 0,
    mtimeMs: Number(stat?.mtimeMs) || 0,
    ctimeMs: Number(stat?.ctimeMs) || 0,
  };
}

function sameAvailabilityStat(left, right) {
  const a = availabilityStatIdentity(left);
  const b = availabilityStatIdentity(right);
  return a.dev === b.dev
    && a.ino === b.ino
    && a.mode === b.mode
    && a.size === b.size
    && a.mtimeMs === b.mtimeMs
    && a.ctimeMs === b.ctimeMs;
}

function hashAvailabilityFile(filename) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filename);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function mediaVerificationKey(snapshot, filename, stat) {
  const identity = availabilityStatIdentity(stat);
  return JSON.stringify([
    String(snapshot?.id || ''),
    String(snapshot?.projectId || ''),
    String(snapshot?.entityUid || ''),
    Number(snapshot?.contentRevision) || 0,
    String(snapshot?.contentHash || '').trim().toLowerCase(),
    String(snapshot?.managedPath || ''),
    String(snapshot?.storageMode || ''),
    String(filename || ''),
    identity.dev,
    identity.ino,
    identity.mode,
    identity.size,
    identity.mtimeMs,
    identity.ctimeMs,
  ]);
}

function rememberVerifiedMedia(key) {
  if (verifiedMediaCache.has(key)) verifiedMediaCache.delete(key);
  verifiedMediaCache.set(key, true);
  while (verifiedMediaCache.size > MEDIA_VERIFICATION_CACHE_LIMIT) {
    verifiedMediaCache.delete(verifiedMediaCache.keys().next().value);
  }
}

function acquireMediaVerificationSlot() {
  if (activeMediaVerifications < MEDIA_VERIFICATION_CONCURRENCY) {
    activeMediaVerifications += 1;
    return Promise.resolve(true);
  }
  if (mediaVerificationWaiters.length >= MEDIA_VERIFICATION_QUEUE_LIMIT) return Promise.resolve(false);
  return new Promise((resolve) => mediaVerificationWaiters.push(resolve));
}

function releaseMediaVerificationSlot() {
  const next = mediaVerificationWaiters.shift();
  if (next) next(true);
  else activeMediaVerifications = Math.max(0, activeMediaVerifications - 1);
}

/**
 * Open a media file only after its current physical identity has been matched
 * to the frozen asset hash. The bounded cache is keyed by the complete stat
 * identity; cache misses hash outside the database and the returned fd is
 * re-fstat'ed before the caller may stream it. No availability state is
 * repaired here, so GET/HEAD remain database-pure.
 */
async function openVerifiedAssetMedia(snapshot, options = {}) {
  const storageMode = String(snapshot?.storageMode || '').trim().toLowerCase();
  const rawPath = String(options.filename || snapshot?.managedPath || '').trim();
  const expectedContentHash = String(snapshot?.contentHash || '').trim().toLowerCase();
  if (!['managed', 'linked'].includes(storageMode)
    || !rawPath
    || !/^[a-f0-9]{64}$/.test(expectedContentHash)) return null;

  const filename = path.resolve(rawPath);
  let before;
  try {
    before = fs.lstatSync(filename);
  } catch (_) {
    return null;
  }
  if (before.isSymbolicLink() || !before.isFile()) return null;
  const key = mediaVerificationKey(snapshot, filename, before);

  let verified = verifiedMediaCache.has(key);
  if (!verified) {
    let task = inflightMediaVerifications.get(key);
    if (!task) {
      task = (async () => {
        const acquired = await acquireMediaVerificationSlot();
        if (!acquired) return false;
        try {
          const calculateHash = typeof options.hashFile === 'function'
            ? options.hashFile
            : hashAvailabilityFile;
          const observedContentHash = String(await calculateHash(filename)).trim().toLowerCase();
          const after = fs.lstatSync(filename);
          if (after.isSymbolicLink()
            || !after.isFile()
            || !sameAvailabilityStat(before, after)
            || observedContentHash !== expectedContentHash) return false;
          rememberVerifiedMedia(key);
          return true;
        } catch (_) {
          return false;
        } finally {
          releaseMediaVerificationSlot();
        }
      })();
      inflightMediaVerifications.set(key, task);
    }
    try {
      verified = await task;
    } finally {
      if (inflightMediaVerifications.get(key) === task) inflightMediaVerifications.delete(key);
    }
  } else {
    rememberVerifiedMedia(key);
  }
  if (!verified) return null;

  let handle;
  try {
    handle = await fs.promises.open(filename, 'r');
    const opened = await handle.stat();
    if (!opened.isFile() || !sameAvailabilityStat(before, opened)) {
      await handle.close();
      return null;
    }
    return { filename, handle, stat: opened };
  } catch (_) {
    if (handle) {
      try { await handle.close(); } catch (_) { /* best-effort close */ }
    }
    return null;
  }
}

function indeterminate(reason) {
  return { state: 'indeterminate', reason };
}

function classifyObservationError(error) {
  const code = String(error?.code || '').toUpperCase();
  if (MISSING_CODES.has(code)) return { state: 'missing', reason: 'source-missing' };
  if (PERMISSION_CODES.has(code)) return indeterminate('source-permission-denied');
  return indeterminate('source-io-indeterminate');
}

/**
 * Observe one server-owned asset snapshot without holding a database writer.
 * The caller must pass the unchanged snapshot to the database CAS writer; this
 * helper deliberately returns no desired path or client-controlled metadata.
 */
async function observeAssetAvailabilitySnapshot(snapshot, options = {}) {
  const storageMode = String(snapshot?.storageMode || '').toLowerCase();
  const rawPath = String(snapshot?.managedPath || '').trim();
  if (!['managed', 'linked'].includes(storageMode) || !rawPath) {
    return indeterminate('source-not-local-file');
  }

  const filename = path.resolve(rawPath);
  const calculateHash = typeof options.hashFile === 'function'
    ? options.hashFile
    : hashAvailabilityFile;
  let before;
  try {
    before = fs.lstatSync(filename);
  } catch (error) {
    return classifyObservationError(error);
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    return indeterminate('source-not-regular-file');
  }

  let observedContentHash;
  try {
    observedContentHash = String(await calculateHash(filename)).trim().toLowerCase();
  } catch (error) {
    return classifyObservationError(error);
  }

  let after;
  try {
    after = fs.lstatSync(filename);
  } catch (error) {
    return classifyObservationError(error);
  }
  if (after.isSymbolicLink() || !after.isFile()) {
    return indeterminate('source-not-regular-file');
  }
  if (!sameAvailabilityStat(before, after)) {
    return indeterminate('source-changing');
  }
  if (!/^[a-f0-9]{64}$/.test(observedContentHash)) {
    return indeterminate('source-hash-invalid');
  }

  const expectedContentHash = String(snapshot?.contentHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedContentHash)) {
    return indeterminate('expected-hash-unverified');
  }
  if (observedContentHash !== expectedContentHash) {
    return {
      state: 'source-changed',
      reason: 'source-content-changed',
      observedContentHash,
      sourceStat: availabilityStatIdentity(after),
    };
  }
  return {
    state: 'available',
    reason: 'source-content-verified',
    observedContentHash,
    sourceStat: availabilityStatIdentity(after),
  };
}

async function reconcileAssetAvailabilitySnapshots(database, batch, options = {}) {
  if (!database || typeof database.syncAssetAvailabilityObservations !== 'function') {
    throw new TypeError('素材可用性 reconciler 缺少数据库写入边界');
  }
  const projectId = String(batch?.projectId || '').trim();
  const catalogRevision = Number(batch?.catalogRevision);
  const snapshots = Array.isArray(batch?.snapshots) ? batch.snapshots : null;
  if (!projectId || !Number.isSafeInteger(catalogRevision) || catalogRevision < 1 || !snapshots) {
    throw new Error('素材可用性 snapshot batch 无效');
  }
  if (snapshots.length === 0) {
    return {
      projectId,
      checked: 0,
      changed: 0,
      missing: 0,
      restored: 0,
      sourceChanged: 0,
      indeterminate: 0,
      catalogRevision,
      items: [],
    };
  }
  const requestedConcurrency = Math.trunc(Number(options.concurrency));
  const concurrency = Number.isSafeInteger(requestedConcurrency) && requestedConcurrency > 0
    ? Math.min(4, requestedConcurrency)
    : 2;
  const observations = new Array(snapshots.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, snapshots.length) }, async () => {
    while (cursor < snapshots.length) {
      const index = cursor++;
      const snapshot = snapshots[index];
      observations[index] = {
        expected: snapshot,
        ...await observeAssetAvailabilitySnapshot(snapshot, options),
      };
    }
  });
  await Promise.all(workers);
  return database.syncAssetAvailabilityObservations(observations, {
    expectedCatalogRevision: catalogRevision,
    ...(options.now == null ? {} : { now: options.now }),
  });
}

module.exports = {
  openVerifiedAssetMedia,
  observeAssetAvailabilitySnapshot,
  reconcileAssetAvailabilitySnapshots,
  sameAvailabilityStat,
};
