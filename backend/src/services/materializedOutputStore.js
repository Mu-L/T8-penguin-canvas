'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_SUFFIX = '.complete.json';
const MANIFEST_DIRECTORY = '.t8-materialized';
const BUFFER_CHUNK_BYTES = 1024 * 1024;

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  const chunk = Buffer.allocUnsafe(BUFFER_CHUNK_BYTES);
  try {
    let offset = 0;
    while (true) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, offset);
      if (!read) break;
      hash.update(chunk.subarray(0, read));
      offset += read;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function safeToken(value, fallback) {
  const token = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '');
  return token || fallback;
}

function fsyncDirectoryBestEffort(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (_) {
    // Windows does not guarantee directory fsync support. File fsync plus
    // same-directory rename remains the strongest portable commit boundary.
  } finally {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
  }
}

function writeTempFile(target, buffer) {
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.part`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    return temporary;
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
    throw error;
  }
}

function readManifest(manifestPath) {
  try {
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 16 * 1024) return null;
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (Number(parsed?.version) !== 1) return null;
    if (!Number.isSafeInteger(Number(parsed?.byteSize)) || Number(parsed.byteSize) < 1) return null;
    if (!/^[0-9a-f]{64}$/i.test(String(parsed?.sha256 || ''))) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function committedFileMatches(filePath, manifestPath, expected = null) {
  const manifest = readManifest(manifestPath);
  if (!manifest) return false;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Number(manifest.byteSize)) return false;
    if (expected) {
      if (stat.size !== expected.byteSize || String(manifest.sha256) !== expected.sha256) return false;
      return sha256File(filePath) === expected.sha256;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function removeUncommittedTarget(filePath, manifestPath) {
  try { fs.rmSync(manifestPath, { force: true }); } catch (_) {}
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isSymbolicLink()) fs.rmSync(filePath, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function commitManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const temporary = writeTempFile(manifestPath, Buffer.from(JSON.stringify(manifest), 'utf8'));
  try {
    fs.renameSync(temporary, manifestPath);
    fsyncDirectoryBestEffort(path.dirname(manifestPath));
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

function manifestPathFor(directory, filename) {
  const normalizedDirectory = path.resolve(String(directory || ''));
  const safeFilename = path.basename(String(filename || ''));
  return path.join(normalizedDirectory, MANIFEST_DIRECTORY, `${safeFilename}${MANIFEST_SUFFIX}`);
}

function commitMaterializedOutputBuffer({
  outputDir,
  buffer,
  prefix,
  extension,
  materializationKey = '',
}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1) throw new Error('物化结果为空，拒绝落盘');
  const safePrefix = safeToken(prefix, 'media');
  const safeExtension = safeToken(extension, 'bin');
  const cacheKey = String(materializationKey || '').trim();
  const keyDigest = cacheKey
    ? crypto.createHash('sha256').update(cacheKey, 'utf8').digest('hex').slice(0, 24)
    : '';
  const contentDigest = sha256Buffer(buffer);
  const filename = keyDigest
    ? `${safePrefix}_task_${keyDigest}_${contentDigest.slice(0, 16)}.${safeExtension}`
    : `${safePrefix}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}.${safeExtension}`;
  const directory = path.resolve(String(outputDir || ''));
  const filePath = path.join(directory, filename);
  const manifestPath = manifestPathFor(directory, filename);
  const expected = { byteSize: buffer.length, sha256: contentDigest };
  fs.mkdirSync(directory, { recursive: true });

  if (committedFileMatches(filePath, manifestPath, expected)) {
    return { filename, filePath, manifestPath, byteSize: buffer.length, sha256: contentDigest };
  }

  // A process may have completed the data rename and exited before committing
  // the small manifest. Promote only after exact byte/hash verification.
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isFile() && !stat.isSymbolicLink()
      && stat.size === buffer.length
      && sha256File(filePath) === contentDigest) {
      commitManifest(manifestPath, {
        version: 1,
        filename,
        byteSize: buffer.length,
        sha256: contentDigest,
        committedAt: Date.now(),
      });
      return { filename, filePath, manifestPath, byteSize: buffer.length, sha256: contentDigest };
    }
  } catch (_) {
    // First commit or a stale partial file.
  }

  removeUncommittedTarget(filePath, manifestPath);
  const temporary = writeTempFile(filePath, buffer);
  try {
    fs.renameSync(temporary, filePath);
    fsyncDirectoryBestEffort(directory);
    commitManifest(manifestPath, {
      version: 1,
      filename,
      byteSize: buffer.length,
      sha256: contentDigest,
      committedAt: Date.now(),
    });
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
  }
  if (!committedFileMatches(filePath, manifestPath, expected)) {
    removeUncommittedTarget(filePath, manifestPath);
    throw new Error('物化结果原子落盘校验失败');
  }
  return { filename, filePath, manifestPath, byteSize: buffer.length, sha256: contentDigest };
}

function isCommittedMaterializedOutputUrl(outputDir, localUrl) {
  const match = String(localUrl || '').match(/^\/files\/output\/([^/?#]+)$/);
  if (!match || path.basename(match[1]) !== match[1]) return false;
  const directory = path.resolve(String(outputDir || ''));
  const filePath = path.join(directory, match[1]);
  return committedFileMatches(filePath, manifestPathFor(directory, match[1]));
}

module.exports = {
  MANIFEST_DIRECTORY,
  MANIFEST_SUFFIX,
  commitMaterializedOutputBuffer,
  isCommittedMaterializedOutputUrl,
  manifestPathFor,
};
