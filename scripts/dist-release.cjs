#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  artifactPaths,
  assertReleaseProvenanceMatchesSealedRecovery,
  assertSealedReleaseRecovery,
  readReleaseRecovery,
  sealReleaseRecovery,
  writeReleaseRecovery,
  writeReleaseProvenance,
} = require('./release-provenance.cjs');
const { assertReleaseWorktreeClean } = require('./release-worktree.cjs');
const { assertCollaborationReleaseEvidence } = require('./collaboration-release-evidence.cjs');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const releaseApproval = `release-${pkg.version}`;
const releaseRemote = process.env.T8_RELEASE_REMOTE || 'origin';
const releaseRepo = process.env.T8_RELEASE_REPO || process.env.GITHUB_REPOSITORY || 'T8mars/T8-penguin-canvas';
const releaseTag = process.env.T8_RELEASE_TAG || `v${pkg.version}`;
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

function releaseNotFound(result) {
  const detail = `${result?.stdout || ''}${result?.stderr || ''}`;
  return result?.status !== 0 && /(release not found|HTTP 404|\bNot Found\b)/i.test(detail);
}

function readRemoteRelease() {
  const result = spawnSync('gh', [
    'release',
    'view',
    releaseTag,
    '--repo',
    releaseRepo,
    '--json',
    'tagName,isDraft,isPrerelease,targetCommitish,body,assets,url',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
  if (releaseNotFound(result)) return null;
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout || ''}${result.stderr || ''}`.trim();
    console.error(`[dist-release] cannot inspect GitHub Release ${releaseTag}${detail ? `: ${detail}` : ''}`);
    process.exit(1);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (_) {
    console.error(`[dist-release] cannot parse GitHub Release metadata for ${releaseTag}`);
    process.exit(1);
  }
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

function assertReleaseSourceClean(phase) {
  try {
    assertReleaseWorktreeClean({
      root: ROOT,
      log: (message) => console.log(message.replace(/^\[release\]/, '[dist-release]')),
    });
  } catch (error) {
    console.error(`[dist-release] ${phase}: ${error?.message || error}`);
    process.exit(1);
  }
}

function assertReleaseTargetUnchanged(expectedTarget, phase) {
  const head = captureGit(['rev-parse', 'HEAD']).toLowerCase();
  const remoteMain = captureGit(['ls-remote', releaseRemote, 'refs/heads/main'])
    .split(/\s+/)[0]
    .toLowerCase();
  if (head !== expectedTarget || remoteMain !== expectedTarget) {
    console.error(
      `[dist-release] ${phase}: release target changed during the build `
      + `(expected ${expectedTarget}, HEAD ${head || '(missing)'}, ${releaseRemote}/main ${remoteMain || '(missing)'}).`,
    );
    process.exit(1);
  }
}

function prepareReleaseBuild(target) {
  let recorded;
  try {
    recorded = readReleaseRecovery({
      root: ROOT,
      pkg,
      target,
    });
  } catch (error) {
    console.error(`[dist-release] release recovery failed: ${error?.message || error}`);
    process.exit(1);
  }
  const remoteRelease = readRemoteRelease();
  if (!recorded && remoteRelease) {
    console.error(
      remoteRelease.isDraft
        ? `[dist-release] ${releaseTag} already has a draft but no matching local recovery record; refusing to mutate it.`
        : `[dist-release] published release ${releaseTag} already exists; refusing to rebuild or replace it.`,
    );
    process.exit(1);
  }
  const nonce = recorded
    ? recorded.recovery.nonce
    : crypto.randomBytes(32).toString('hex');
  env.T8_RELEASE_BUILD_NONCE = nonce;
  let sealedRecovery = null;
  if (recorded) {
    const hasSealedState = recorded.recovery.nonceSha256 !== undefined
      || recorded.recovery.artifacts !== undefined
      || recorded.recovery.sealedAt !== undefined;
    if (hasSealedState) {
      try {
        sealedRecovery = assertSealedReleaseRecovery({
          root: ROOT,
          pkg,
          target,
          nonce,
        });
      } catch (error) {
        console.error(`[dist-release] sealed release recovery is invalid: ${error?.message || error}`);
        process.exit(1);
      }
    } else if (remoteRelease) {
      console.error(
        `[dist-release] ${releaseTag} exists remotely but the matching local recovery was never sealed; refusing to rebuild or mutate it.`,
      );
      process.exit(1);
    }
  }
  if (sealedRecovery && remoteRelease && !remoteRelease.isDraft) {
    console.log(`[dist-release] reconciling previously published ${releaseTag} without rebuilding or uploading`);
    run(
      'reconcile existing published release',
      process.execPath,
      [path.join(ROOT, 'scripts', 'release-github.cjs'), '--reconcile-only'],
    );
    return { nonce, completed: true };
  }
  if (sealedRecovery) {
    try {
      assertReleaseProvenanceMatchesSealedRecovery({
        root: ROOT,
        pkg,
        target,
        nonce,
      });
      console.log(`[dist-release] resuming sealed ${releaseTag} with the original local artifacts; no rebuild required`);
      run(
        'resume sealed release',
        process.execPath,
        [path.join(ROOT, 'scripts', 'release-github.cjs')],
      );
      return { nonce, completed: true };
    } catch (error) {
      if (!remoteRelease?.isDraft) {
        console.error(
          `[dist-release] sealed release artifacts are unavailable or changed, and ${releaseTag} has no complete remote draft to reconcile: `
          + `${error?.message || error}`,
        );
        process.exit(1);
      }
      console.warn(
        `[dist-release] original local artifacts are unavailable or changed; attempting remote-only recovery of the sealed draft: `
        + `${error?.message || error}`,
      );
      run(
        'resume sealed release from remote assets',
        process.execPath,
        [path.join(ROOT, 'scripts', 'release-github.cjs'), '--remote-artifacts-only'],
      );
      return { nonce, completed: true };
    }
  }
  if (!recorded) {
    try {
      const written = writeReleaseRecovery({
        root: ROOT,
        pkg,
        target,
        nonce,
      });
      console.log(`[dist-release] release recovery created: ${path.relative(ROOT, written.path)}`);
    } catch (error) {
      console.error(`[dist-release] release recovery failed: ${error?.message || error}`);
      process.exit(1);
    }
  } else {
    console.log(`[dist-release] reusing release recovery for ${target}`);
  }
  const paths = artifactPaths(ROOT, pkg);
  for (const filePath of [
    ...paths.artifacts.map((artifact) => artifact.path),
    paths.provenance,
  ]) {
    fs.rmSync(filePath, { force: true });
  }
  console.log(`[dist-release] removed stale automatic-update artifacts for ${target}`);
  return { nonce, completed: false };
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
  try {
    const evidence = assertCollaborationReleaseEvidence({
      root: ROOT,
      version: pkg.version,
      target: releaseTarget,
    });
    console.log(
      `[dist-release] collaboration evidence: ${evidence.checkCount} checks, `
      + `${evidence.artifactCount} artifacts, manifest ${evidence.manifestSha256}`,
    );
  } catch (error) {
    console.error(`[dist-release] collaboration release gate failed: ${error?.message || error}`);
    process.exit(1);
  }
  assertReleaseSourceClean('release worktree check before build or recovery');
  const prepared = prepareReleaseBuild(releaseTarget);
  if (prepared.completed) {
    console.log(`[dist-release] ${releaseTag} recovery completed without rebuilding`);
    return;
  }
  const releaseBuildNonce = prepared.nonce;

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
  assertReleaseTargetUnchanged(releaseTarget, 'release target check before provenance');
  assertReleaseSourceClean('release worktree check before provenance sealing');
  try {
    const written = writeReleaseProvenance({
      root: ROOT,
      pkg,
      target: releaseTarget,
      nonce: releaseBuildNonce,
    });
    console.log(`[dist-release] release provenance: ${path.relative(ROOT, written.path)}`);
    assertReleaseTargetUnchanged(releaseTarget, 'release target check before recovery sealing');
    assertReleaseSourceClean('release worktree check before recovery sealing');
    const sealed = sealReleaseRecovery({
      root: ROOT,
      pkg,
      target: releaseTarget,
      nonce: releaseBuildNonce,
    });
    console.log(`[dist-release] sealed release recovery: ${path.relative(ROOT, sealed.path)}`);
  } catch (error) {
    console.error(`[dist-release] release provenance failed: ${error?.message || error}`);
    process.exit(1);
  }
  run('github release upload + verify', process.execPath, [path.join(ROOT, 'scripts', 'release-github.cjs')]);
}

main();
