#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  assertReleaseProvenanceMatchesSealedRecovery,
  assertSealedReleaseRecovery,
  clearReleaseRecovery,
} = require('./release-provenance.cjs');
const { assertReleaseWorktreeClean } = require('./release-worktree.cjs');
const { assertLatestYamlArtifact } = require('./latest-yml.cjs');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const version = pkg.version;
const tag = process.env.T8_RELEASE_TAG || `v${version}`;
const repo = process.env.T8_RELEASE_REPO || process.env.GITHUB_REPOSITORY || 'T8mars/T8-penguin-canvas';
const productName = pkg.build && pkg.build.productName ? pkg.build.productName : 'T8-PenguinCanvas';
const distDir = path.join(ROOT, 'dist_electron');
const installerName = `${productName}-Setup-${version}.exe`;
const installer = path.join(distDir, installerName);
const blockmap = path.join(distDir, `${installerName}.blockmap`);
const latest = path.join(distDir, 'latest.yml');
const notesFile = path.join(ROOT, 'release-notes', `${tag}.md`);
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const draft = args.has('--draft');
const prerelease = args.has('--prerelease');
const reconcileOnly = args.has('--reconcile-only');
const remoteArtifactsOnly = args.has('--remote-artifacts-only');
const releaseApproval = `release-${version}`;
const expectedTag = `v${version}`;
const releaseRemote = process.env.T8_RELEASE_REMOTE || 'origin';
const RELEASE_DRAFT_MARKER_SCHEMA = 't8-electron-release-draft-v1';

function fail(message) {
  throw new Error(String(message));
}

function buildReleaseDraftMarker({ target, nonceSha256 }) {
  const normalizedTarget = String(target || '').toLowerCase();
  const normalizedNonceHash = String(nonceSha256 || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalizedTarget)) {
    throw new Error('release draft marker target must be an exact 40-character commit SHA');
  }
  if (!/^[a-f0-9]{64}$/.test(normalizedNonceHash)) {
    throw new Error('release draft marker nonceSha256 must be an exact 64-character hexadecimal digest');
  }
  return `<!-- ${RELEASE_DRAFT_MARKER_SCHEMA} target=${normalizedTarget} nonceSha256=${normalizedNonceHash} -->`;
}

function releaseAssetNames(assets) {
  if (!Array.isArray(assets)) throw new Error('existing release assets metadata is invalid');
  const names = assets.map((asset) => String(asset?.name || ''));
  if (names.some((name) => !name)) throw new Error('existing release contains an unnamed asset');
  if (new Set(names).size !== names.length) throw new Error('existing release contains duplicate asset names');
  return names;
}

function normalizeReleaseBody(value) {
  return String(value || '').replace(/\r\n/g, '\n').trimEnd();
}

function expectedArtifactsByName(artifacts) {
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new Error('sealed release recovery artifact manifest is missing');
  }
  const entries = Object.values(artifacts);
  const byName = new Map();
  for (const artifact of entries) {
    const name = String(artifact?.name || '');
    const size = Number(artifact?.size);
    const sha256 = String(artifact?.sha256 || '').toLowerCase();
    if (!name || !Number.isSafeInteger(size) || size <= 0 || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error('sealed release recovery artifact manifest is invalid');
    }
    if (byName.has(name)) throw new Error(`sealed release recovery contains duplicate asset name: ${name}`);
    byName.set(name, { name, size, sha256 });
  }
  return byName;
}

function assertReleaseAssetsMatchManifest(assets, expectedArtifacts, { allowSubset = false } = {}) {
  const names = releaseAssetNames(assets);
  const expectedByName = expectedArtifactsByName(expectedArtifacts);
  const unexpected = names.filter((name) => !expectedByName.has(name));
  if (unexpected.length > 0) {
    throw new Error(`release contains unexpected assets: ${unexpected.join(', ')}`);
  }
  if (!allowSubset) {
    const missing = [...expectedByName.keys()].filter((name) => !names.includes(name));
    if (missing.length > 0) throw new Error(`release is missing expected assets: ${missing.join(', ')}`);
  }
  for (const asset of assets) {
    const expected = expectedByName.get(asset.name);
    if (Number(asset?.size || 0) !== expected.size) {
      throw new Error(`release asset size mismatch: ${asset.name}`);
    }
    if (String(asset?.digest || '').toLowerCase() !== `sha256:${expected.sha256}`) {
      throw new Error(`release asset SHA-256 metadata mismatch: ${asset.name}`);
    }
  }
  return expectedByName;
}

function assertExistingDraftOwnership(data, {
  expectedTag,
  expectedTarget,
  expectedMarker,
  expectedAssetNames,
  expectedTitle,
  expectedBody,
}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`existing release metadata for ${expectedTag} is invalid`);
  }
  if (data.tagName !== expectedTag) {
    throw new Error(`existing release tag mismatch: expected ${expectedTag}, received ${data.tagName}`);
  }
  if (!data.isDraft) {
    throw new Error(`published release ${expectedTag} already exists; this publisher refuses to replace automatic-update assets`);
  }
  if (data.isPrerelease) {
    throw new Error(`existing draft ${expectedTag} is a prerelease, but this publisher only creates stable automatic updates`);
  }
  if (String(data.targetCommitish || '').toLowerCase() !== String(expectedTarget || '').toLowerCase()) {
    throw new Error(`existing draft ${expectedTag} targets ${data.targetCommitish || '(missing)'}, expected ${expectedTarget}`);
  }
  if (expectedTitle !== undefined && String(data.name || '') !== String(expectedTitle)) {
    throw new Error(`existing draft ${expectedTag} title does not match this release build`);
  }
  const markerPattern = new RegExp(
    `<!-- ${RELEASE_DRAFT_MARKER_SCHEMA} target=[a-f0-9]{40} nonceSha256=[a-f0-9]{64} -->`,
    'g',
  );
  const markers = String(data.body || '').match(markerPattern) || [];
  if (markers.length !== 1 || markers[0] !== expectedMarker) {
    throw new Error(`existing draft ${expectedTag} is not owned by this release build; refusing to mutate it`);
  }
  if (expectedBody !== undefined
    && normalizeReleaseBody(data.body) !== normalizeReleaseBody(expectedBody)) {
    throw new Error(`existing draft ${expectedTag} notes do not match this release build`);
  }
  const expectedNames = new Set(expectedAssetNames);
  if (expectedNames.size !== expectedAssetNames.length || expectedNames.has('')) {
    throw new Error('expected release asset names are invalid');
  }
  const unexpected = releaseAssetNames(data.assets).filter((name) => !expectedNames.has(name));
  if (unexpected.length > 0) {
    throw new Error(`existing draft ${expectedTag} contains unexpected assets: ${unexpected.join(', ')}`);
  }
  return data;
}

function assertOwnedDraftReadyForPublish(data, options) {
  const owned = assertExistingDraftOwnership(data, options);
  assertReleaseAssetsMatchManifest(owned.assets, options.expectedArtifacts, { allowSubset: false });
  return owned;
}

function assertPublishedReleaseOwnership(data, options) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`published release metadata for ${options.expectedTag} is invalid`);
  }
  if (data.tagName !== options.expectedTag) {
    throw new Error(`published release tag mismatch: expected ${options.expectedTag}, received ${data.tagName}`);
  }
  if (data.isDraft || data.isPrerelease) {
    throw new Error(`${options.expectedTag} is not a published stable release`);
  }
  if (String(data.targetCommitish || '').toLowerCase() !== String(options.expectedTarget || '').toLowerCase()) {
    throw new Error(`published release ${options.expectedTag} targets ${data.targetCommitish || '(missing)'}, expected ${options.expectedTarget}`);
  }
  if (String(data.name || '') !== String(options.expectedTitle || '')) {
    throw new Error(`published release ${options.expectedTag} title does not match this release build`);
  }
  const markerPattern = new RegExp(
    `<!-- ${RELEASE_DRAFT_MARKER_SCHEMA} target=[a-f0-9]{40} nonceSha256=[a-f0-9]{64} -->`,
    'g',
  );
  const markers = String(data.body || '').match(markerPattern) || [];
  if (markers.length !== 1 || markers[0] !== options.expectedMarker) {
    throw new Error(`published release ${options.expectedTag} is not owned by this release recovery`);
  }
  if (normalizeReleaseBody(data.body) !== normalizeReleaseBody(options.expectedBody)) {
    throw new Error(`published release ${options.expectedTag} notes do not match this release build`);
  }
  assertReleaseAssetsMatchManifest(data.assets, options.expectedArtifacts, { allowSubset: false });
  return data;
}

function assertReleaseApproval() {
  if (dryRun) return;
  if (process.env.T8_RELEASE_APPROVAL === releaseApproval) return;
  fail(
    `refusing to publish GitHub Release without explicit approval. Set T8_RELEASE_APPROVAL=${releaseApproval} only after the user explicitly asks to publish.`,
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function assertFile(file) {
  if (!fs.existsSync(file)) fail(`missing artifact: ${path.relative(ROOT, file)}`);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size <= 0) fail(`empty artifact: ${path.relative(ROOT, file)}`);
  console.log(`[release] artifact ok: ${path.relative(ROOT, file)} (${formatBytes(stat.size)})`);
}

function hashFile(filePath, algorithm, encoding = 'hex') {
  const hash = crypto.createHash(algorithm);
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest(encoding);
}

function assertLatestYaml() {
  assertFile(latest);
  const text = fs.readFileSync(latest, 'utf-8');
  const actualSha512 = hashFile(installer, 'sha512', 'base64');
  const actualSize = fs.statSync(installer).size;
  try {
    assertLatestYamlArtifact({
      text,
      version,
      installerName,
      installerSha512: actualSha512,
      installerSize: actualSize,
    });
  } catch (error) {
    fail(error?.message || String(error));
  }
}

function assertLocalArtifactsMatchSealedRecovery(releaseTarget) {
  try {
    return assertReleaseProvenanceMatchesSealedRecovery({
      root: ROOT,
      pkg,
      target: releaseTarget,
      nonce: process.env.T8_RELEASE_BUILD_NONCE,
    });
  } catch (error) {
    fail(error?.message || String(error));
  }
}

function run(command, commandArgs, options = {}) {
  if (dryRun && command === 'gh') {
    console.log(`[release] dry-run: gh ${commandArgs.join(' ')}`);
    return { status: 0, stdout: '', stderr: '' };
  }
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: options.capture ? 'pipe' : 'inherit',
    windowsHide: true,
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? `${result.stdout || ''}${result.stderr || ''}`.trim() : '';
    fail(`${command} ${commandArgs.join(' ')} exited with ${result.status}${detail ? `\n${detail}` : ''}`);
  }
  return result;
}

function capture(command, commandArgs, options = {}) {
  const result = run(command, commandArgs, { ...options, capture: true });
  return result.status === 0 ? String(result.stdout || '') : '';
}

function releaseNotFound(result) {
  const detail = `${result?.stdout || ''}${result?.stderr || ''}`;
  return result?.status !== 0 && /(release not found|HTTP 404|\bNot Found\b)/i.test(detail);
}

function readReleaseMetadata({ allowMissing = false } = {}) {
  const result = run('gh', [
    'release',
    'view',
    tag,
    '--repo',
    repo,
    '--json',
    'databaseId,tagName,name,isDraft,isPrerelease,isImmutable,targetCommitish,body,assets,uploadUrl,url',
  ], {
    capture: true,
    allowFailure: true,
  });
  if (result.status !== 0) {
    if (allowMissing && releaseNotFound(result)) return null;
    const detail = `${result.stdout || ''}${result.stderr || ''}`.trim();
    fail(`cannot read existing release metadata for ${tag}${detail ? `\n${detail}` : ''}`);
  }
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (_) {
    fail(`cannot parse existing release metadata for ${tag}`);
  }
  return data;
}

function existingReleaseMetadata(options) {
  if (dryRun) return null;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const data = readReleaseMetadata({ allowMissing: true });
    if (!data) return null;
    try {
      const owned = assertExistingDraftOwnership(data, options);
      assertReleaseAssetsMatchManifest(owned.assets, options.expectedArtifacts, { allowSubset: true });
      return owned;
    } catch (error) {
      lastError = error;
      if (attempt < 3) waitMilliseconds(3000);
    }
  }
  throw lastError || new Error(`cannot validate existing draft ${tag}`);
}

function getGitTarget() {
  const explicit = process.env.T8_RELEASE_TARGET;
  if (explicit && /^[a-f0-9]{40}$/i.test(explicit)) return explicit.toLowerCase();
  if (!dryRun) {
    fail('T8_RELEASE_TARGET must be the exact 40-character source commit SHA for a formal release');
  }
  const sha = capture('git', ['rev-parse', 'HEAD'], { allowFailure: true }).trim();
  return sha || 'HEAD';
}

function remoteRefTarget(ref) {
  const output = capture('git', ['ls-remote', releaseRemote, ref, `${ref}^{}`], { allowFailure: true }).trim();
  if (!output) return '';
  const rows = output.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((row) => row.length >= 2);
  const peeled = rows.find((row) => row[1] === `${ref}^{}`);
  return String((peeled || rows[0] || [])[0] || '').toLowerCase();
}

function assertReleaseGitState(target) {
  if (dryRun) return;
  const head = capture('git', ['rev-parse', 'HEAD']).trim().toLowerCase();
  if (head !== target) fail(`T8_RELEASE_TARGET ${target} does not match HEAD ${head}`);
  const remoteMain = remoteRefTarget('refs/heads/main');
  if (!remoteMain) fail(`cannot resolve ${releaseRemote}/main`);
  if (remoteMain !== target) {
    fail(`release target ${target} is not the pushed ${releaseRemote}/main commit ${remoteMain}`);
  }
  const remoteTag = remoteRefTarget(`refs/tags/${tag}`);
  if (remoteTag && remoteTag !== target) {
    fail(`existing tag ${tag} targets ${remoteTag}, expected ${target}`);
  }
  assertReleaseWorktreeClean({ root: ROOT });
}

function releaseNotesBody(releaseTarget) {
  if (/^[a-f0-9]{40}$/.test(String(releaseTarget || ''))) {
    const relativeNotesPath = path.posix.join('release-notes', `${tag}.md`);
    const result = run('git', [
      'show',
      `${releaseTarget}:${relativeNotesPath}`,
    ], {
      capture: true,
      allowFailure: true,
    });
    if (result.status !== 0) {
      const detail = `${result.stdout || ''}${result.stderr || ''}`.trim();
      fail(`cannot read release notes from fixed source target ${releaseTarget}${detail ? `\n${detail}` : ''}`);
    }
    return String(result.stdout || '');
  }
  if (fs.existsSync(notesFile)) return fs.readFileSync(notesFile, 'utf8');
  return [
    `# 贞贞的无限画布 ${tag}`,
    '',
    '- Electron 桌面端接入 GitHub Release 自动更新。',
    '- 顶栏新增检查、下载、重启安装状态入口。',
    '- Release 资产包含 NSIS 安装包、blockmap 与 latest.yml。',
    '',
  ].join('\n');
}

function markedReleaseBody(marker, releaseTarget) {
  const body = releaseNotesBody(releaseTarget).replace(/\s+$/, '');
  return `${body}\n\n${marker}\n`;
}

function withMarkedReleaseNotes(marker, releaseTarget, action) {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 't8pc-release-notes-'));
  const tempNotes = path.join(tempDirectory, `${tag}.md`);
  const cleanup = () => fs.rmSync(tempDirectory, { recursive: true, force: true });
  process.once('exit', cleanup);
  try {
    fs.writeFileSync(tempNotes, markedReleaseBody(marker, releaseTarget), 'utf8');
    return action(tempNotes);
  } finally {
    process.removeListener('exit', cleanup);
    cleanup();
  }
}

function verifyRelease(phase, options = {}) {
  if (dryRun) return 0;
  const verifyArgs = [path.join(ROOT, 'scripts', 'verify-github-release.cjs'), tag];
  if (phase === 'prepublish') verifyArgs.push('--prepublish');
  if (options.metadataOnly) verifyArgs.push('--metadata-only');
  if (options.recoveryManifest) verifyArgs.push('--recovery-manifest');
  return run(process.execPath, verifyArgs, { allowFailure: true }).status;
}

function waitMilliseconds(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function verifyReleaseWithRetries(phase, {
  attempts = 4,
  delayMs = 3000,
  metadataOnly = false,
  recoveryManifest = false,
  ownership,
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const status = verifyRelease(phase, { metadataOnly, recoveryManifest });
    if (status === 0) {
      try {
        if (ownership && !dryRun) {
          const data = readReleaseMetadata();
          if (phase === 'prepublish') assertOwnedDraftReadyForPublish(data, ownership);
          else assertPublishedReleaseOwnership(data, ownership);
        }
        return true;
      } catch (error) {
        console.warn(`[release] ${phase} ownership verification failed: ${error?.message || String(error)}`);
      }
    }
    if (attempt < attempts) {
      console.warn(`[release] ${phase} verification attempt ${attempt}/${attempts} failed; retrying read-only verification`);
      waitMilliseconds(delayMs);
    }
  }
  return false;
}

function readReleaseMetadataWithRetries({
  attempts = 3,
  delayMs = 3000,
  retryMissing = false,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const data = readReleaseMetadata({ allowMissing: true });
      if (data || !retryMissing || attempt === attempts) return data;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) waitMilliseconds(delayMs);
  }
  throw lastError || new Error(`cannot determine remote state for ${tag}`);
}

function clearRecoveryAfterSuccess(releaseTarget) {
  if (dryRun) return;
  try {
    const cleared = clearReleaseRecovery({
      root: ROOT,
      pkg,
      target: releaseTarget,
      nonce: process.env.T8_RELEASE_BUILD_NONCE,
    });
    console.log(`[release] cleared local recovery: ${path.relative(ROOT, cleared)}`);
  } catch (error) {
    console.warn(`[release] release succeeded but local recovery cleanup failed: ${error?.message || String(error)}`);
  }
}

function reconcilePublishedRelease(data, ownership, releaseTarget) {
  try {
    assertPublishedReleaseOwnership(data, ownership);
  } catch (error) {
    fail(
      `${tag} is already published but does not match this sealed recovery; `
      + `no upload, edit, delete, rollback, or recovery cleanup was attempted, and local recovery was retained: `
      + `${error?.message || String(error)}`,
    );
  }
  if (!verifyReleaseWithRetries('final', {
    attempts: 4,
    delayMs: 3000,
    metadataOnly: true,
    recoveryManifest: true,
    ownership,
  })) {
    fail(
      `${tag} is published but final read-only reconciliation did not converge; `
      + 'the published release and local recovery were left unchanged for another read-only retry',
    );
  }
  clearRecoveryAfterSuccess(releaseTarget);
  console.log(`[release] published ${tag} reconciled without rebuilding or uploading`);
}

function releaseAssetUploadBase(data) {
  const releaseId = Number(data?.databaseId);
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0) {
    throw new Error(`owned draft ${tag} has an invalid GitHub release databaseId`);
  }
  const rawUploadUrl = String(data?.uploadUrl || '').replace(/\{.*$/, '');
  let uploadUrl;
  try {
    uploadUrl = new URL(rawUploadUrl);
  } catch (_) {
    throw new Error(`owned draft ${tag} has an invalid GitHub uploadUrl`);
  }
  const expectedPath = `/repos/${repo}/releases/${releaseId}/assets`.toLowerCase();
  if (uploadUrl.protocol !== 'https:'
    || uploadUrl.hostname.toLowerCase() !== 'uploads.github.com'
    || uploadUrl.pathname.toLowerCase() !== expectedPath
    || uploadUrl.search
    || uploadUrl.hash) {
    throw new Error(`owned draft ${tag} uploadUrl does not match its repository and databaseId`);
  }
  return uploadUrl;
}

function uploadMissingAssets(data, files, ownership, releaseTarget) {
  const originalReleaseId = Number(data?.databaseId);
  for (const file of files) {
    assertLocalArtifactsMatchSealedRecovery(releaseTarget);
    const current = readReleaseMetadata();
    const owned = assertExistingDraftOwnership(current, ownership);
    assertReleaseAssetsMatchManifest(owned.assets, ownership.expectedArtifacts, { allowSubset: true });
    if (Number(owned.databaseId) !== originalReleaseId) {
      throw new Error(`owned draft ${tag} databaseId changed before asset upload`);
    }
    const name = path.basename(file);
    if (releaseAssetNames(owned.assets).includes(name)) {
      console.log(`[release] asset already present after retry reconciliation: ${name}`);
      continue;
    }
    const uploadUrl = new URL(releaseAssetUploadBase(owned));
    uploadUrl.searchParams.set('name', name);
    run('gh', [
      'api',
      uploadUrl.toString(),
      '--silent',
      '--method',
      'POST',
      '--header',
      'Accept: application/vnd.github+json',
      '--header',
      'Content-Type: application/octet-stream',
      '--input',
      file,
    ]);
  }
}

function publishOwnedDraft(data, ownership) {
  if (dryRun) {
    return run('gh', [
      'api',
      '--silent',
      '--method',
      'PATCH',
      `repos/${repo}/releases/DRY_RUN_RELEASE_ID`,
      '-F',
      'draft=false',
      '-F',
      'prerelease=false',
      '-f',
      'make_latest=true',
    ], { allowFailure: true }).status;
  }
  const expectedReleaseId = Number(data?.databaseId);
  if (!Number.isSafeInteger(expectedReleaseId) || expectedReleaseId <= 0) {
    throw new Error(`owned draft ${tag} has an invalid GitHub release databaseId`);
  }
  assertReleaseGitState(ownership.expectedTarget);
  const current = readReleaseMetadata();
  const owned = assertOwnedDraftReadyForPublish(current, ownership);
  const releaseId = Number(owned.databaseId);
  if (releaseId !== expectedReleaseId) {
    throw new Error(`owned draft ${tag} databaseId changed immediately before publish`);
  }
  return run('gh', [
    'api',
    '--silent',
    '--method',
    'PATCH',
    `repos/${repo}/releases/${releaseId}`,
    '-F',
    'draft=false',
    '-F',
    'prerelease=false',
    '-f',
    'make_latest=true',
    '-f',
    `tag_name=${ownership.expectedTag}`,
    '-f',
    `target_commitish=${ownership.expectedTarget}`,
    '-f',
    `name=${ownership.expectedTitle}`,
    '-f',
    `body=${ownership.expectedBody}`,
  ], { allowFailure: true }).status;
}

function main() {
  assertReleaseApproval();
  if (!dryRun && tag !== expectedTag) {
    fail(`formal automatic-update tag must be ${expectedTag}, received ${tag}`);
  }
  if (prerelease && !dryRun) {
    fail('stable automatic-update publishing does not support --prerelease');
  }
  if (draft && !dryRun) {
    fail('formal automatic-update publishing cannot intentionally stop at a draft; run the complete release workflow');
  }
  if ((reconcileOnly || remoteArtifactsOnly) && dryRun) {
    fail('release recovery modes are only valid for a formal release');
  }

  console.log(`[release] repo=${repo} tag=${tag}`);
  const releaseTarget = getGitTarget();
  assertReleaseGitState(releaseTarget);

  let sealedRecovery;
  if (!dryRun) {
    try {
      sealedRecovery = assertSealedReleaseRecovery({
        root: ROOT,
        pkg,
        target: releaseTarget,
        nonce: process.env.T8_RELEASE_BUILD_NONCE,
      });
    } catch (error) {
      fail(error?.message || String(error));
    }
  }

  const assets = [installer, blockmap, latest];
  const expectedAssetNames = assets.map((asset) => path.basename(asset));
  const expectedArtifacts = sealedRecovery?.recovery.artifacts || {};
  const title = `贞贞的无限画布${tag}`;
  let releaseMarker;
  try {
    releaseMarker = buildReleaseDraftMarker({
      target: releaseTarget,
      nonceSha256: dryRun ? '0'.repeat(64) : sealedRecovery?.recovery.nonceSha256,
    });
  } catch (error) {
    fail(error?.message || String(error));
  }
  const expectedBody = markedReleaseBody(releaseMarker, releaseTarget);
  const ownership = {
    expectedTag: tag,
    expectedTarget: releaseTarget,
    expectedMarker: releaseMarker,
    expectedAssetNames,
    expectedTitle: title,
    expectedBody,
    expectedArtifacts,
  };

  const initialRemote = dryRun
    ? null
    : readReleaseMetadataWithRetries({
      attempts: 3,
      delayMs: 3000,
      retryMissing: false,
    });
  if (initialRemote && !initialRemote.isDraft) {
    reconcilePublishedRelease(initialRemote, ownership, releaseTarget);
    return;
  }
  if (reconcileOnly) {
    fail(
      initialRemote
        ? `${tag} is still a draft; read-only published reconciliation cannot mutate or publish it`
        : `${tag} is missing; read-only published reconciliation cannot rebuild or upload it`,
    );
  }
  if (remoteArtifactsOnly && !initialRemote) {
    fail(`${tag} is missing; sealed remote-asset recovery cannot create or upload a release`);
  }

  if (!remoteArtifactsOnly) {
    assertFile(installer);
    assertFile(blockmap);
    assertLatestYaml();
  }
  if (!dryRun && !remoteArtifactsOnly) {
    assertLocalArtifactsMatchSealedRecovery(releaseTarget);
  }

  withMarkedReleaseNotes(releaseMarker, releaseTarget, (releaseNotes) => {
    let readyDraft;
    try {
      const existing = existingReleaseMetadata(ownership);
      if (existing) {
        const presentNames = new Set(releaseAssetNames(existing.assets));
        const missingAssets = assets.filter((asset) => !presentNames.has(path.basename(asset)));
        if (missingAssets.length > 0) {
          if (remoteArtifactsOnly) {
            fail(
              `sealed remote draft ${tag} is missing assets (${missingAssets.map((asset) => path.basename(asset)).join(', ')}); `
              + 'the original local bytes are required and no rebuild or overwrite is allowed',
            );
          }
          console.log(`[release] resuming owned draft ${tag}; uploading ${missingAssets.length} missing asset(s)`);
          uploadMissingAssets(existing, missingAssets, ownership, releaseTarget);
        } else {
          console.log(`[release] owned draft ${tag} already contains all expected assets`);
        }
      } else {
        if (remoteArtifactsOnly) {
          fail(`sealed remote-asset recovery requires an existing owned draft ${tag}`);
        }
        console.log(`[release] creating draft release ${tag}`);
        assertLocalArtifactsMatchSealedRecovery(releaseTarget);
        const createArgs = [
          'release',
          'create',
          tag,
          ...assets,
          '--repo',
          repo,
          '--target',
          releaseTarget,
          '--title',
          title,
          '--notes-file',
          releaseNotes,
          '--draft',
          '--latest=false',
        ];
        run('gh', createArgs);
      }

      if (!verifyReleaseWithRetries('prepublish', {
        attempts: 4,
        delayMs: 3000,
        metadataOnly: true,
        recoveryManifest: true,
        ownership,
      })) {
        fail(`draft ${tag} asset metadata did not converge before prepublish download verification`);
      }
      if (!verifyReleaseWithRetries('prepublish', {
        attempts: 2,
        delayMs: 3000,
        metadataOnly: false,
        recoveryManifest: true,
        ownership,
      })) {
        fail(`draft ${tag} failed full prepublish download verification`);
      }
      if (!dryRun) {
        readyDraft = readReleaseMetadataWithRetries({
          attempts: 3,
          delayMs: 3000,
          retryMissing: true,
        });
        assertOwnedDraftReadyForPublish(readyDraft, ownership);
      }
    } catch (error) {
      fail(
        `${error?.message || String(error)}; no automatic draft deletion or rollback was attempted, and local recovery was retained. `
        + 'Rerun the complete dist:release workflow from the same source target; it will reuse the sealed recovery.',
      );
    }

    const publishStatuses = [];
    publishStatuses.push(publishOwnedDraft(readyDraft, ownership));
    let finalVerified = verifyReleaseWithRetries('final', {
      attempts: 4,
      delayMs: 3000,
      metadataOnly: true,
      recoveryManifest: true,
      ownership,
    });
    if (!finalVerified) {
      let remote;
      try {
        remote = readReleaseMetadataWithRetries({
          attempts: 3,
          delayMs: 3000,
          retryMissing: true,
        });
      } catch (error) {
        const publishStatus = publishStatuses.some((status) => status !== 0)
          ? `; publish command statuses: ${publishStatuses.join(',')}`
          : '';
        fail(
          `${tag} final verification did not converge and remote state is unknown${publishStatus}; `
          + `no automatic rollback was attempted: ${error?.message || String(error)}`,
        );
      }
      if (remote?.isDraft) {
        try {
          assertOwnedDraftReadyForPublish(remote, ownership);
        } catch (error) {
          fail(
            `${tag} still appears as a draft, but ownership or artifact metadata changed before the publish retry; `
            + `no second publish request was sent: ${error?.message || String(error)}`,
          );
        }
        console.warn(`[release] ${tag} still appears as a draft; retrying the idempotent publish request`);
        publishStatuses.push(publishOwnedDraft(remote, ownership));
        finalVerified = verifyReleaseWithRetries('final', {
          attempts: 4,
          delayMs: 3000,
          metadataOnly: true,
          recoveryManifest: true,
          ownership,
        });
      } else if (remote) {
        reconcilePublishedRelease(remote, ownership, releaseTarget);
        return;
      }
      if (!finalVerified) {
        const publishStatus = publishStatuses.some((status) => status !== 0)
          ? `; publish command statuses: ${publishStatuses.join(',')}`
          : '';
        let reconciled;
        try {
          reconciled = readReleaseMetadataWithRetries({
            attempts: 3,
            delayMs: 3000,
            retryMissing: true,
          });
        } catch (error) {
          fail(
            `${tag} final verification did not converge and remote state is unknown${publishStatus}; `
            + `the remote release was left unchanged and recovery state was retained: ${error?.message || String(error)}`,
          );
        }
        if (reconciled?.isDraft) {
          try {
            assertOwnedDraftReadyForPublish(reconciled, ownership);
          } catch (error) {
            fail(
              `${tag} remained a draft after bounded publish retries, but its ownership or artifacts changed; `
              + `the remote release was left unchanged: ${error?.message || String(error)}`,
            );
          }
          fail(
            `${tag} remained an owned draft after bounded publish retries${publishStatus}; `
            + 'the draft was left unchanged and local recovery state was retained for a complete dist:release retry',
          );
        }
        if (reconciled) {
          try {
            assertPublishedReleaseOwnership(reconciled, ownership);
          } catch (error) {
            fail(
              `${tag} is published but no longer matches this sealed recovery${publishStatus}; `
              + `the published release was left unchanged: ${error?.message || String(error)}`,
            );
          }
          fail(
            `${tag} is published but final read-only verification did not converge${publishStatus}; `
            + 'the published release and local recovery were left unchanged for another read-only reconciliation',
          );
        }
        fail(
          `${tag} is missing after bounded publish retries${publishStatus}; `
          + 'the remote state was left unchanged and local recovery state was retained',
        );
      }
    }
    if (publishStatuses.some((status) => status !== 0)) {
      console.warn(`[release] publish command returned uncertain statuses ${publishStatuses.join(',')}, but final remote verification succeeded`);
    }
    clearRecoveryAfterSuccess(releaseTarget);
    console.log('[release] done');
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[release] ${error?.message || String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  RELEASE_DRAFT_MARKER_SCHEMA,
  assertExistingDraftOwnership,
  assertOwnedDraftReadyForPublish,
  assertPublishedReleaseOwnership,
  assertReleaseAssetsMatchManifest,
  buildReleaseDraftMarker,
  main,
  markedReleaseBody,
  normalizeReleaseBody,
  publishOwnedDraft,
  releaseAssetUploadBase,
  releaseNotFound,
  uploadMissingAssets,
  verifyReleaseWithRetries,
  withMarkedReleaseNotes,
};
