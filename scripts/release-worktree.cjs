'use strict';

const { spawnSync } = require('child_process');

const DEFAULT_ALLOWED_PACKAGING_DIRTY_PATHS = new Set([
  'tools/ffmpeg-runtime/ffmpeg.exe',
  'tools/ffmpeg-runtime/ffprobe.exe',
  'tools/remove-ai-watermarks-runtime/README.md',
]);

function classifyReleaseWorktreeStatus(
  status,
  allowedPackagingDirtyPaths = DEFAULT_ALLOWED_PACKAGING_DIRTY_PATHS,
) {
  const unexpected = [];
  const permitted = [];
  for (const line of String(status || '').split(/\r?\n/).filter(Boolean)) {
    const state = line.slice(0, 2);
    const file = line.slice(3).replace(/^"(.*)"$/, '$1');
    const packagingOnly = allowedPackagingDirtyPaths.has(file);
    const staged = state[0] !== ' ' && state[0] !== '?';
    if (!packagingOnly || staged) unexpected.push(line);
    else permitted.push(line);
  }
  return { unexpected, permitted };
}

function readReleaseWorktreeStatus(root) {
  const result = spawnSync('git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout || ''}${result.stderr || ''}`.trim();
    throw new Error(`cannot inspect release worktree${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '').replace(/\r?\n$/, '');
}

function assertReleaseWorktreeClean({
  root,
  allowedPackagingDirtyPaths = DEFAULT_ALLOWED_PACKAGING_DIRTY_PATHS,
  log = console.log,
} = {}) {
  const status = readReleaseWorktreeStatus(root);
  const classified = classifyReleaseWorktreeStatus(status, allowedPackagingDirtyPaths);
  if (classified.unexpected.length > 0) {
    throw new Error(`source worktree is not release-clean:\n${classified.unexpected.join('\n')}`);
  }
  if (classified.permitted.length > 0 && typeof log === 'function') {
    log('[release] permitted local packaging sidecars:');
    classified.permitted.forEach((line) => log(`[release]   ${line}`));
  }
  return classified;
}

module.exports = {
  DEFAULT_ALLOWED_PACKAGING_DIRTY_PATHS,
  assertReleaseWorktreeClean,
  classifyReleaseWorktreeStatus,
  readReleaseWorktreeStatus,
};
