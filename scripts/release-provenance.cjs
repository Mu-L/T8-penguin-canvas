'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROVENANCE_SCHEMA = 't8-electron-release-provenance-v1';
const RELEASE_RECOVERY_SCHEMA = 't8-electron-release-recovery-v1';

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

function releaseRecoveryPath(root, pkg) {
  const dotGit = path.join(root, '.git');
  let gitDirectory = dotGit;
  if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
    const pointer = fs.readFileSync(dotGit, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/i.exec(pointer);
    if (!match) fail(`cannot resolve Git metadata directory from ${dotGit}`);
    gitDirectory = path.resolve(root, match[1]);
  }
  if (!fs.existsSync(gitDirectory) || !fs.statSync(gitDirectory).isDirectory()) {
    fail(`Git metadata directory is missing: ${gitDirectory}`);
  }
  return path.join(gitDirectory, 't8-release', `release-recovery-${pkg.version}.json`);
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
    fail('build nonce must be a 64-character hexadecimal value');
  }
}

function nonceSha256(nonce) {
  return crypto.createHash('sha256').update(String(nonce)).digest('hex');
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function normalizeRecoveryArtifacts({ root, pkg, artifacts }) {
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    fail('release recovery artifact manifest is missing');
  }
  const paths = artifactPaths(root, pkg);
  const expectedKeys = new Set(paths.artifacts.map((artifact) => artifact.key));
  const actualKeys = Object.keys(artifacts);
  const unexpectedKeys = actualKeys.filter((key) => !expectedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    fail(`release recovery artifact manifest contains unexpected keys: ${unexpectedKeys.join(', ')}`);
  }
  const normalized = {};
  for (const artifact of paths.artifacts) {
    const recorded = artifacts[artifact.key];
    if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) {
      fail(`release recovery artifact is missing: ${artifact.key}`);
    }
    if (String(recorded.name || '') !== artifact.name) {
      fail(`release recovery artifact name mismatch: ${artifact.key}`);
    }
    const size = Number(recorded.size);
    if (!Number.isSafeInteger(size) || size <= 0) {
      fail(`release recovery artifact size is invalid: ${artifact.name}`);
    }
    const sha256 = String(recorded.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      fail(`release recovery artifact SHA-256 is invalid: ${artifact.name}`);
    }
    const normalizedArtifact = {
      name: artifact.name,
      size,
      sha256,
    };
    if (artifact.sha512 === true) {
      const sha512 = String(recorded.sha512 || '');
      if (!sha512 || Buffer.from(sha512, 'base64').length !== 64) {
        fail(`release recovery artifact SHA-512 is invalid: ${artifact.name}`);
      }
      normalizedArtifact.sha512 = sha512;
    }
    normalized[artifact.key] = normalizedArtifact;
  }
  return normalized;
}

function readReleaseRecovery({ root, pkg, target }) {
  const recoveryPath = releaseRecoveryPath(root, pkg);
  if (!fs.existsSync(recoveryPath)) return null;
  let recovery;
  try {
    recovery = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
  } catch (_) {
    fail('release-recovery.json is invalid');
  }
  if (recovery.schema !== RELEASE_RECOVERY_SCHEMA) fail('release recovery schema mismatch');
  if (String(recovery.version) !== String(pkg.version)) fail('release recovery version mismatch');
  if (String(recovery.target || '').toLowerCase() !== String(target || '').toLowerCase()) {
    fail('release recovery source target mismatch; inspect the existing remote draft before discarding local recovery state');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(recovery.nonce || ''))) fail('release recovery nonce is invalid');
  return {
    path: recoveryPath,
    recovery: {
      ...recovery,
      target: String(recovery.target).toLowerCase(),
      nonce: String(recovery.nonce).toLowerCase(),
    },
  };
}

function writeReleaseRecovery({ root, pkg, target, nonce }) {
  assertInputs(target, nonce);
  const existing = readReleaseRecovery({ root, pkg, target });
  if (existing) fail('release recovery already exists for this source target');
  const recoveryPath = releaseRecoveryPath(root, pkg);
  const recovery = {
    schema: RELEASE_RECOVERY_SCHEMA,
    version: String(pkg.version),
    target: String(target).toLowerCase(),
    nonce: String(nonce).toLowerCase(),
    createdAt: new Date().toISOString(),
  };
  atomicWriteJson(recoveryPath, recovery);
  return { path: recoveryPath, recovery };
}

function assertReleaseRecovery(options) {
  assertInputs(options.target, options.nonce);
  const recorded = readReleaseRecovery(options);
  if (!recorded) fail('release-recovery.json is missing; run dist:release for this source commit');
  const actualNonce = Buffer.from(String(recorded.recovery.nonce), 'hex');
  const expectedNonce = Buffer.from(String(options.nonce).toLowerCase(), 'hex');
  if (!crypto.timingSafeEqual(actualNonce, expectedNonce)) {
    fail('release recovery nonce does not match this dist:release invocation');
  }
  return recorded;
}

function clearReleaseRecovery(options) {
  const recorded = assertReleaseRecovery(options);
  fs.rmSync(recorded.path, { force: true });
  return recorded.path;
}

function sealReleaseRecovery(options) {
  const recorded = assertReleaseRecovery(options);
  const provenance = assertReleaseProvenance(options);
  const artifacts = normalizeRecoveryArtifacts({
    root: options.root,
    pkg: options.pkg,
    artifacts: provenance.artifacts,
  });
  const alreadySealed = recorded.recovery.nonceSha256 !== undefined
    || recorded.recovery.artifacts !== undefined
    || recorded.recovery.sealedAt !== undefined;
  if (alreadySealed) {
    const sealed = assertSealedReleaseRecovery(options);
    if (JSON.stringify(sealed.recovery.artifacts) !== JSON.stringify(artifacts)) {
      fail('release recovery is already sealed with different artifact bytes and cannot be overwritten');
    }
    return sealed;
  }
  const recovery = {
    ...recorded.recovery,
    nonceSha256: nonceSha256(options.nonce),
    artifacts,
    sealedAt: new Date().toISOString(),
  };
  atomicWriteJson(recorded.path, recovery);
  return { path: recorded.path, recovery };
}

function assertSealedReleaseRecovery(options) {
  const recorded = assertReleaseRecovery(options);
  const expectedNonceHash = nonceSha256(options.nonce);
  const recordedNonceHash = String(recorded.recovery.nonceSha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(recordedNonceHash)
    || !crypto.timingSafeEqual(Buffer.from(recordedNonceHash, 'hex'), Buffer.from(expectedNonceHash, 'hex'))) {
    fail('sealed release recovery nonce digest does not match this dist:release invocation');
  }
  return {
    path: recorded.path,
    recovery: {
      ...recorded.recovery,
      nonceSha256: recordedNonceHash,
      artifacts: normalizeRecoveryArtifacts({
        root: options.root,
        pkg: options.pkg,
        artifacts: recorded.recovery.artifacts,
      }),
    },
  };
}

function assertReleaseProvenanceMatchesSealedRecovery(options) {
  const provenance = assertReleaseProvenance(options);
  const sealed = assertSealedReleaseRecovery(options);
  const provenanceArtifacts = normalizeRecoveryArtifacts({
    root: options.root,
    pkg: options.pkg,
    artifacts: provenance.artifacts,
  });
  if (JSON.stringify(provenanceArtifacts) !== JSON.stringify(sealed.recovery.artifacts)) {
    fail('current provenance and local artifact bytes do not match sealed release recovery');
  }
  return { provenance, sealed };
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
    fail('provenance build nonce does not match this dist:release invocation');
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
  RELEASE_RECOVERY_SCHEMA,
  artifactPaths,
  assertReleaseRecovery,
  assertReleaseProvenance,
  assertReleaseProvenanceMatchesSealedRecovery,
  assertSealedReleaseRecovery,
  clearReleaseRecovery,
  nonceSha256,
  readReleaseRecovery,
  releaseRecoveryPath,
  sealReleaseRecovery,
  writeReleaseRecovery,
  writeReleaseProvenance,
};
