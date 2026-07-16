#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  artifactPaths,
  writeReleaseProvenance,
} = require('./release-provenance.cjs');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const releaseApproval = `release-${pkg.version}`;
const releaseRemote = process.env.T8_RELEASE_REMOTE || 'origin';
const env = {
  ...process.env,
  T8_REQUIRE_AI_WATERMARK_RUNTIME: '1',
  T8_REQUIRE_PARSEHUB_RUNTIME: '1',
  T8_REQUIRE_RUNTIME_ARCHIVES: '1',
  T8_REQUIRE_UPDATE_ARTIFACTS: '1',
  T8_REQUIRE_LOCAL_PRIVATE: '1',
  T8_ENABLE_LOCAL_PRIVATE: '1',
  T8_DISABLE_LOCAL_EXTENSIONS: '0',
};

function command(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function assertReleaseApproval() {
  if (process.env.T8_RELEASE_APPROVAL === releaseApproval) return;
  console.error('[dist-release] refusing to run Electron release without explicit approval.');
  console.error(
    `[dist-release] This command builds Electron and uploads a GitHub Release. Set T8_RELEASE_APPROVAL=${releaseApproval} only after the user explicitly asks to publish.`,
  );
  process.exit(1);
}

function captureGit(args) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout || ''}${result.stderr || ''}`.trim();
    console.error(`[dist-release] git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    process.exit(1);
  }
  return String(result.stdout || '').trim();
}

function assertReleaseTarget() {
  const explicitTarget = String(process.env.T8_RELEASE_TARGET || '').toLowerCase();
  if (explicitTarget && !/^[a-f0-9]{40}$/.test(explicitTarget)) {
    console.error('[dist-release] T8_RELEASE_TARGET must be the exact 40-character source commit SHA.');
    process.exit(1);
  }
  const head = captureGit(['rev-parse', 'HEAD']).toLowerCase();
  const target = explicitTarget || head;
  if (head !== target) {
    console.error(`[dist-release] T8_RELEASE_TARGET ${target} does not match HEAD ${head}.`);
    process.exit(1);
  }
  const remoteMain = captureGit(['ls-remote', releaseRemote, 'refs/heads/main'])
    .split(/\s+/)[0]
    .toLowerCase();
  if (remoteMain !== target) {
    console.error(`[dist-release] release target ${target} is not the pushed ${releaseRemote}/main commit ${remoteMain || '(missing)'}.`);
    process.exit(1);
  }
  env.T8_RELEASE_TARGET = target;
  console.log(`[dist-release] fixed release target: ${target}`);
  return target;
}

function prepareReleaseBuild(target) {
  const nonce = crypto.randomBytes(32).toString('hex');
  env.T8_RELEASE_BUILD_NONCE = nonce;
  const paths = artifactPaths(ROOT, pkg);
  for (const filePath of [
    ...paths.artifacts.map((artifact) => artifact.path),
    paths.provenance,
  ]) {
    fs.rmSync(filePath, { force: true });
  }
  console.log(`[dist-release] removed stale automatic-update artifacts for ${target}`);
  return nonce;
}

function run(label, executable, args) {
  console.log(`[dist-release] ${label}`);
  const shell = process.platform === 'win32' && /\.cmd$/i.test(executable);
  const result = spawnSync(executable, args, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell,
    windowsHide: true,
  });
  if (result.error) {
    console.error(`[dist-release] ${label} failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[dist-release] ${label} exited with ${result.status}`);
    process.exit(result.status || 1);
  }
}

function main() {
  assertReleaseApproval();
  const releaseTarget = assertReleaseTarget();
  const releaseBuildNonce = prepareReleaseBuild(releaseTarget);

  const electronBuilder = path.join(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
  );

  run('RH toolbox release manifest check', command('npm'), ['run', 'rh-toolbox:check']);
  run('build + encrypt', command('npm'), ['run', 'prepack:enc']);
  run('prepare runtime archives', command('npm'), ['run', 'prepack:runtimes']);
  run('rebuild native modules for Electron', command('npm'), ['run', 'rebuild:electron']);
  run('electron-builder nsis', electronBuilder, ['--win', '--x64', '--config.npmRebuild=false']);
  run('post-build checks', process.execPath, [path.join(ROOT, 'electron', '_post_build.cjs')]);
  try {
    const written = writeReleaseProvenance({
      root: ROOT,
      pkg,
      target: releaseTarget,
      nonce: releaseBuildNonce,
    });
    console.log(`[dist-release] release provenance: ${path.relative(ROOT, written.path)}`);
  } catch (error) {
    console.error(`[dist-release] release provenance failed: ${error?.message || error}`);
    process.exit(1);
  }
  run('github release upload + verify', process.execPath, [path.join(ROOT, 'scripts', 'release-github.cjs')]);
}

main();
