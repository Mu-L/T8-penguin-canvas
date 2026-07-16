#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { assertReleaseProvenance } = require('./release-provenance.cjs');
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
const releaseApproval = `release-${version}`;
const expectedTag = `v${version}`;
const releaseRemote = process.env.T8_RELEASE_REMOTE || 'origin';
const allowedPackagingDirtyPaths = new Set([
  'tools/ffmpeg-runtime/ffmpeg.exe',
  'tools/ffmpeg-runtime/ffprobe.exe',
  'tools/remove-ai-watermarks-runtime/README.md',
]);

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
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

function existingReleaseMetadata() {
  if (dryRun) return null;
  const result = run('gh', [
    'release',
    'view',
    tag,
    '--repo',
    repo,
    '--json',
    'tagName,isDraft,isPrerelease',
  ], {
    capture: true,
    allowFailure: true,
  });
  if (result.status !== 0) return null;
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (_) {
    fail(`cannot parse existing release metadata for ${tag}`);
  }
  if (data.tagName !== tag) fail(`existing release tag mismatch: expected ${tag}, received ${data.tagName}`);
  if (!data.isDraft) {
    fail(`published release ${tag} is immutable; refusing to replace automatic-update assets`);
  }
  if (data.isPrerelease) fail(`existing draft ${tag} is a prerelease, but this publisher only creates stable automatic updates`);
  return data;
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
  const status = capture('git', ['status', '--porcelain=v1', '--untracked-files=all']).replace(/\r?\n$/, '');
  if (!status) return;
  const unexpected = [];
  const permitted = [];
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    const state = line.slice(0, 2);
    const file = line.slice(3).replace(/^"(.*)"$/, '$1');
    const packagingOnly = allowedPackagingDirtyPaths.has(file);
    const staged = state[0] !== ' ' && state[0] !== '?';
    if (!packagingOnly || staged) unexpected.push(line);
    else permitted.push(line);
  }
  if (unexpected.length > 0) {
    fail(`source worktree is not release-clean:\n${unexpected.join('\n')}`);
  }
  if (permitted.length > 0) {
    console.log('[release] permitted local packaging sidecars:');
    permitted.forEach((line) => console.log(`[release]   ${line}`));
  }
}

function writeFallbackNotes() {
  if (fs.existsSync(notesFile)) return notesFile;
  const tmp = path.join(os.tmpdir(), `t8pc-${tag}-release-notes.md`);
  fs.writeFileSync(
    tmp,
    [
      `# 贞贞的无限画布 ${tag}`,
      '',
      '- Electron 桌面端接入 GitHub Release 自动更新。',
      '- 顶栏新增检查、下载、重启安装状态入口。',
      '- Release 资产包含 NSIS 安装包、blockmap 与 latest.yml。',
      '',
    ].join('\n'),
    'utf-8',
  );
  return tmp;
}

function verifyRelease(phase) {
  if (dryRun) return 0;
  const verifyArgs = [path.join(ROOT, 'scripts', 'verify-github-release.cjs'), tag];
  if (phase === 'prepublish') verifyArgs.push('--prepublish');
  return run(process.execPath, verifyArgs, { allowFailure: true }).status;
}

function returnReleaseToDraft() {
  return run('gh', [
    'release',
    'edit',
    tag,
    '--repo',
    repo,
    '--draft',
    '--latest=false',
  ], { allowFailure: true }).status === 0;
}

function main() {
  assertReleaseApproval();
  if (!dryRun && tag !== expectedTag) {
    fail(`formal automatic-update tag must be ${expectedTag}, received ${tag}`);
  }
  if (prerelease && !dryRun) {
    fail('stable automatic-update publishing does not support --prerelease');
  }

  console.log(`[release] repo=${repo} tag=${tag}`);
  const releaseTarget = getGitTarget();
  assertReleaseGitState(releaseTarget);
  const existing = existingReleaseMetadata();

  assertFile(installer);
  assertFile(blockmap);
  assertLatestYaml();
  if (!dryRun) {
    try {
      assertReleaseProvenance({
        root: ROOT,
        pkg,
        target: releaseTarget,
        nonce: process.env.T8_RELEASE_BUILD_NONCE,
      });
    } catch (error) {
      fail(error?.message || String(error));
    }
  }

  const releaseNotes = writeFallbackNotes();
  const assets = [installer, blockmap, latest];
  const title = `贞贞的无限画布${tag}`;

  if (existing) {
    console.log(`[release] updating existing draft ${tag}`);
    run('gh', ['release', 'upload', tag, ...assets, '--repo', repo, '--clobber']);
    run('gh', [
      'release',
      'edit',
      tag,
      '--repo',
      repo,
      '--title',
      title,
      '--notes-file',
      releaseNotes,
      '--draft',
      '--latest=false',
    ]);
  } else {
    console.log(`[release] creating draft release ${tag}`);
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

  if (verifyRelease('prepublish') !== 0) {
    fail(`draft ${tag} failed prepublish verification and remains unpublished`);
  }
  if (draft) {
    console.log(`[release] draft ${tag} verified and left unpublished by request`);
    return;
  }

  const publishResult = run('gh', [
    'release',
    'edit',
    tag,
    '--repo',
    repo,
    '--draft=false',
    '--prerelease=false',
    '--latest',
  ], { allowFailure: true });
  if (verifyRelease('final') !== 0) {
    const returnedToDraft = returnReleaseToDraft();
    const publishStatus = publishResult.status !== 0
      ? `; publish command exited with ${publishResult.status}`
      : '';
    fail(
      returnedToDraft
        ? `${tag} failed final verification and was returned to draft${publishStatus}`
        : `${tag} failed final verification; automatic rollback to draft also failed${publishStatus}`,
    );
  }
  if (publishResult.status !== 0) {
    console.warn(`[release] publish command exited with ${publishResult.status}, but final remote verification succeeded`);
  }
  console.log('[release] done');
}

main();
