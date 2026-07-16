'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROVENANCE_SCHEMA = 't8-electron-release-provenance-v1';

function fail(message) {
  throw new Error(`[release-provenance] ${message}`);
}

function artifactPaths(root, pkg) {
  const productName = pkg.build?.productName || 'T8-PenguinCanvas';
  const installerName = `${productName}-Setup-${pkg.version}.exe`;
  const distDir = path.join(root, 'dist_electron');
  return {
    distDir,
    provenance: path.join(distDir, 'release-provenance.json'),
    artifacts: [
      { key: 'installer', name: installerName, path: path.join(distDir, installerName), sha512: true },
      { key: 'blockmap', name: `${installerName}.blockmap`, path: path.join(distDir, `${installerName}.blockmap`) },
      { key: 'latest', name: 'latest.yml', path: path.join(distDir, 'latest.yml') },
    ],
  };
}

function fileDigests(filePath, includeSha512 = false) {
  if (!fs.existsSync(filePath)) fail(`missing artifact: ${filePath}`);
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) fail(`empty artifact: ${filePath}`);
  const sha256 = crypto.createHash('sha256');
  const sha512 = includeSha512 ? crypto.createHash('sha512') : null;
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      sha256.update(chunk);
      if (sha512) sha512.update(chunk);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    size: stat.size,
    sha256: sha256.digest('hex'),
    ...(sha512 ? { sha512: sha512.digest('base64') } : {}),
  };
}

function assertInputs(target, nonce) {
  if (!/^[a-f0-9]{40}$/i.test(String(target || ''))) {
    fail('target must be an exact 40-character commit SHA');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(nonce || ''))) {
    fail('build nonce must be a fresh 64-character hexadecimal value');
  }
}

function nonceSha256(nonce) {
  return crypto.createHash('sha256').update(String(nonce)).digest('hex');
}

function buildProvenance({ root, pkg, target, nonce }) {
  assertInputs(target, nonce);
  const paths = artifactPaths(root, pkg);
  const artifacts = {};
  for (const artifact of paths.artifacts) {
    artifacts[artifact.key] = {
      name: artifact.name,
      ...fileDigests(artifact.path, artifact.sha512 === true),
    };
  }
  return {
    schema: PROVENANCE_SCHEMA,
    version: String(pkg.version),
    target: String(target).toLowerCase(),
    nonceSha256: nonceSha256(nonce),
    createdAt: new Date().toISOString(),
    artifacts,
  };
}

function writeReleaseProvenance(options) {
  const provenance = buildProvenance(options);
  const paths = artifactPaths(options.root, options.pkg);
  fs.mkdirSync(paths.distDir, { recursive: true });
  fs.writeFileSync(paths.provenance, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  return { path: paths.provenance, provenance };
}

function assertReleaseProvenance(options) {
  assertInputs(options.target, options.nonce);
  const paths = artifactPaths(options.root, options.pkg);
  if (!fs.existsSync(paths.provenance)) fail('release-provenance.json is missing; run dist:release for this source commit');
  let recorded;
  try {
    recorded = JSON.parse(fs.readFileSync(paths.provenance, 'utf8'));
  } catch (_) {
    fail('release-provenance.json is invalid');
  }
  if (recorded.schema !== PROVENANCE_SCHEMA) fail('provenance schema mismatch');
  if (String(recorded.version) !== String(options.pkg.version)) fail('provenance version mismatch');
  if (String(recorded.target || '').toLowerCase() !== String(options.target).toLowerCase()) {
    fail('provenance source target does not match T8_RELEASE_TARGET');
  }
  const expectedNonceHash = nonceSha256(options.nonce);
  const recordedNonceHash = String(recorded.nonceSha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(recordedNonceHash)
    || !crypto.timingSafeEqual(Buffer.from(recordedNonceHash, 'hex'), Buffer.from(expectedNonceHash, 'hex'))) {
    fail('provenance build nonce does not match this dist:release process');
  }
  for (const artifact of paths.artifacts) {
    const actual = {
      name: artifact.name,
      ...fileDigests(artifact.path, artifact.sha512 === true),
    };
    const expected = recorded.artifacts?.[artifact.key];
    if (!expected
      || expected.name !== actual.name
      || Number(expected.size) !== actual.size
      || String(expected.sha256 || '').toLowerCase() !== actual.sha256
      || (artifact.sha512 === true && String(expected.sha512 || '') !== actual.sha512)) {
      fail(`artifact provenance mismatch: ${artifact.name}`);
    }
  }
  return recorded;
}

module.exports = {
  PROVENANCE_SCHEMA,
  artifactPaths,
  assertReleaseProvenance,
  writeReleaseProvenance,
};
