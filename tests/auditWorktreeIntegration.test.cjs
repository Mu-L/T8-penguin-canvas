'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  LEGACY_F2_PROTECTED_BASELINE,
  evaluateIntegrationAudit,
  parseNameStatusZ,
  parseStatusPorcelainV2,
} = require('../scripts/audit-worktree-integration.cjs');
const {
  LEGACY_F2_HEAD,
} = require('../scripts/worktree-role.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'audit-worktree-integration.cjs');
const ZERO_HASH = '0'.repeat(40);

function writeFixtureFile(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function runGit(root, args) {
  const result = spawnSync('git', [
    '-c',
    `safe.directory=${path.resolve(root).replace(/\\/g, '/')}`,
    '-c',
    'commit.gpgsign=false',
    ...args,
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return String(result.stdout || '').trim();
}

function runCli(source, target, extraArgs = []) {
  return spawnSync(process.execPath, [
    SCRIPT_PATH,
    '--source',
    source,
    '--target',
    target,
    ...extraArgs,
  ], {
    cwd: source,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
}

function safeRemoveTempRoot(root) {
  const resolved = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir());
  assert.ok(
    resolved.startsWith(`${tempRoot}${path.sep}`)
      && path.basename(resolved).startsWith('t8-worktree-integration-audit-'),
    `refusing to remove non-test path: ${resolved}`,
  );
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function createLinkedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-worktree-integration-audit-'));
  const core = path.join(root, 'T8-penguin-canvas');
  const source = path.join(root, 'T8-penguin-canvas-dev-audit');
  fs.mkdirSync(core, { recursive: true });
  runGit(core, ['init', '--initial-branch=main']);
  runGit(core, ['config', 'user.name', 'T8 Audit Test']);
  runGit(core, ['config', 'user.email', 'audit@example.invalid']);
  runGit(core, ['config', 'core.autocrlf', 'false']);
  runGit(core, ['remote', 'add', 'origin', 'https://example.invalid/T8-penguin-canvas.git']);

  writeFixtureFile(core, 'tracked.txt', 'baseline tracked\n');
  writeFixtureFile(core, 'rename-old.txt', 'baseline rename\n');
  writeFixtureFile(core, 'delete.txt', 'baseline delete\n');
  writeFixtureFile(core, 'tools/ffmpeg-runtime/ffmpeg.exe', 'protected ffmpeg fixture\n');
  writeFixtureFile(core, 'tools/remove-ai-watermarks-runtime/README.md', 'protected watermark fixture\n');
  runGit(core, ['add', '--', '.']);
  runGit(core, ['commit', '--no-gpg-sign', '-m', 'baseline']);
  runGit(core, ['branch', 'codex/audit-source']);
  runGit(core, ['worktree', 'add', source, 'codex/audit-source']);

  t.after(() => safeRemoveTempRoot(root));
  return { root, core, source };
}

function fakeInspection({ root, commonDir, branch, head, status = [] }) {
  return {
    requestedPath: root,
    realPath: root,
    topLevel: root,
    commonDir,
    origin: 'https://example.invalid/T8-penguin-canvas.git',
    branch,
    head,
    status,
    protectedFiles: LEGACY_F2_PROTECTED_BASELINE.map((entry) => ({
      path: entry.path,
      exists: true,
      regular: true,
      symlink: false,
      bytes: entry.bytes,
      sha256: entry.sha256,
    })),
  };
}

test('porcelain v2 and name-status parsers preserve tracked, untracked, rename and delete footprints', () => {
  const status = [
    `1 M. N... 100644 100644 100644 ${ZERO_HASH} ${ZERO_HASH} tracked path.txt`,
    `1 .D N... 100644 100644 000000 ${ZERO_HASH} ${ZERO_HASH} deleted.txt`,
    `2 R. N... 100644 100644 100644 ${ZERO_HASH} ${ZERO_HASH} R100 renamed destination.txt`,
    'rename source.txt',
    '? untracked.txt',
    '',
  ].join('\0');
  const entries = parseStatusPorcelainV2(status);
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.path, entry.originalPath || null]), [
    ['deleted', 'deleted.txt', null],
    ['renamed', 'renamed destination.txt', 'rename source.txt'],
    ['modified', 'tracked path.txt', null],
    ['untracked', 'untracked.txt', null],
  ]);
  assert.equal(entries.find((entry) => entry.kind === 'modified').staged, true);
  assert.equal(entries.find((entry) => entry.kind === 'deleted').unstaged, true);

  const headEntries = parseNameStatusZ([
    'A', 'added.txt',
    'M', 'modified.txt',
    'R100', 'old.txt', 'new.txt',
    '',
  ].join('\0'));
  assert.deepEqual(headEntries.map((entry) => [entry.kind, entry.path, entry.originalPath || null]), [
    ['added', 'added.txt', null],
    ['modified', 'modified.txt', null],
    ['renamed', 'new.txt', 'old.txt'],
  ]);
});

test('a dirty legacy F2 worktree is rejected even while its frozen HEAD is unchanged', () => {
  const roleRoot = path.join(os.tmpdir(), 't8-worktree-role-fixture');
  const commonDir = path.join(roleRoot, '.git');
  const sourceRoot = path.join(roleRoot, 'T8-penguin-canvas-release-2.5.7');
  const targetRoot = path.join(roleRoot, 'T8-penguin-canvas');
  const dirtyStatus = parseStatusPorcelainV2('? pending-f2-work.txt\0');
  const report = evaluateIntegrationAudit({
    source: fakeInspection({
      root: sourceRoot,
      commonDir,
      branch: 'codex/f2-reconnect-sync',
      head: LEGACY_F2_HEAD,
      status: dirtyStatus,
    }),
    target: fakeInspection({
      root: targetRoot,
      commonDir,
      branch: 'codex/core-integration',
      head: LEGACY_F2_HEAD,
    }),
    graph: {
      mergeBase: LEGACY_F2_HEAD,
      aheadBehind: { source: 0, target: 0 },
      sourceChanges: [],
      targetChanges: [],
    },
  });

  assert.equal(report.source.role.ok, true, 'the exact legacy pair remains a recognized extraction source');
  assert.equal(report.checks.legacySourceCheckpointed, false);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((problem) => problem.code === 'legacy_source_uncheckpointed'));
  assert.equal(report.collisions.length, 0, 'dirty legacy rejection does not depend on a target collision');
});

test('legacy F2 integration rejects an unstaged protected file whose frozen bytes changed', () => {
  const roleRoot = path.join(os.tmpdir(), 't8-worktree-protected-snapshot-fixture');
  const commonDir = path.join(roleRoot, '.git');
  const source = fakeInspection({
    root: path.join(roleRoot, 'T8-penguin-canvas-release-2.5.7'),
    commonDir,
    branch: 'codex/f2-reconnect-sync',
    head: LEGACY_F2_HEAD,
  });
  source.protectedFiles = source.protectedFiles.map((entry) => (
    entry.path === 'tools/remove-ai-watermarks-runtime/README.md'
      ? { ...entry, bytes: entry.bytes + 1 }
      : entry
  ));
  const report = evaluateIntegrationAudit({
    source,
    target: fakeInspection({
      root: path.join(roleRoot, 'T8-penguin-canvas'),
      commonDir,
      branch: 'codex/core-integration',
      head: LEGACY_F2_HEAD,
    }),
    graph: {
      mergeBase: LEGACY_F2_HEAD,
      aheadBehind: { source: 0, target: 0 },
      sourceChanges: [],
      targetChanges: [],
    },
  });

  assert.equal(report.checks.protectedPathsUnstaged, true);
  assert.equal(report.checks.protectedSourceSnapshotIntact, false);
  assert.deepEqual(report.protectedSourceSnapshot.violations.map((entry) => [entry.path, entry.reason]), [
    ['tools/remove-ai-watermarks-runtime/README.md', 'size_mismatch'],
  ]);
  assert.ok(report.problems.some((problem) => problem.code === 'protected_path_snapshot_mismatch'));
  assert.equal(report.ok, false);
});

test('different Git common directories fail closed before an integration can be approved', () => {
  const root = path.join(os.tmpdir(), 't8-worktree-common-dir-fixture');
  const sourceRoot = path.join(root, 'T8-penguin-canvas-dev-audit');
  const targetRoot = path.join(root, 'T8-penguin-canvas');
  const head = '1'.repeat(40);
  const report = evaluateIntegrationAudit({
    source: fakeInspection({ root: sourceRoot, commonDir: path.join(root, 'source.git'), branch: 'codex/audit', head }),
    target: fakeInspection({ root: targetRoot, commonDir: path.join(root, 'target.git'), branch: 'main', head }),
    graph: { mergeBase: null, aheadBehind: null, sourceChanges: [], targetChanges: [] },
  });
  assert.equal(report.checks.sameCommonDir, false);
  assert.ok(report.problems.some((problem) => problem.code === 'different_common_dir'));
  assert.equal(report.ok, false);
});

test('source and target role misplacement is surfaced as a fail-closed audit problem', () => {
  const root = path.join(os.tmpdir(), 't8-worktree-role-misplacement-fixture');
  const commonDir = path.join(root, '.git');
  const head = '2'.repeat(40);
  const report = evaluateIntegrationAudit({
    source: fakeInspection({
      root: path.join(root, 'T8-penguin-canvas-release-v9.9.9'),
      commonDir,
      branch: 'codex/feature-in-release-path',
      head,
    }),
    target: fakeInspection({
      root: path.join(root, 'T8-penguin-canvas'),
      commonDir,
      branch: 'codex/release-v9.9.9',
      head,
    }),
    graph: { mergeBase: head, aheadBehind: { source: 0, target: 0 }, sourceChanges: [], targetChanges: [] },
  });
  assert.equal(report.checks.sourceRole, false);
  assert.equal(report.checks.targetRole, false);
  assert.ok(report.problems.some((problem) => problem.code === 'source_role_mismatch'));
  assert.ok(report.problems.some((problem) => problem.code === 'target_role_mismatch'));
  assert.equal(report.ok, false);
});

test('real linked-worktree CLI is deterministic and fails on head/dirty collisions and staged protected paths', (t) => {
  const fixture = createLinkedFixture(t);

  const clean = runCli(fixture.source, fixture.core, ['--check', '--json']);
  assert.equal(clean.status, 0, clean.stderr || clean.stdout);
  const cleanReport = JSON.parse(clean.stdout);
  assert.equal(cleanReport.ok, true);
  assert.equal(cleanReport.checks.sameCommonDir, true);
  assert.deepEqual(cleanReport.graph.aheadBehind, { source: 0, target: 0 });

  writeFixtureFile(fixture.source, 'head-only.txt', 'committed on source\n');
  runGit(fixture.source, ['add', '--', 'head-only.txt']);
  runGit(fixture.source, ['commit', '--no-gpg-sign', '-m', 'source head change']);
  writeFixtureFile(fixture.core, 'head-only.txt', 'untracked on target\n');

  writeFixtureFile(fixture.source, 'tracked.txt', 'dirty source tracked\n');
  runGit(fixture.source, ['mv', '--', 'rename-old.txt', 'rename-new.txt']);
  fs.unlinkSync(path.join(fixture.source, 'delete.txt'));
  writeFixtureFile(fixture.source, 'untracked-hit.txt', 'untracked source\n');

  writeFixtureFile(fixture.core, 'tracked.txt', 'dirty target tracked\n');
  writeFixtureFile(fixture.core, 'rename-old.txt', 'dirty target rename origin\n');
  writeFixtureFile(fixture.core, 'rename-new.txt', 'untracked target rename destination\n');
  writeFixtureFile(fixture.core, 'delete.txt', 'dirty target delete collision\n');
  writeFixtureFile(fixture.core, 'untracked-hit.txt', 'untracked target\n');

  const first = runCli(fixture.source, fixture.core, ['--json']);
  const second = runCli(fixture.source, fixture.core, ['--json']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout, 'JSON output must not contain time or iteration-dependent ordering');
  const report = JSON.parse(first.stdout);
  assert.deepEqual(report.graph.aheadBehind, { source: 1, target: 0 });
  const collisionPaths = new Set(report.collisions.map((collision) => collision.path));
  for (const expected of [
    'delete.txt',
    'head-only.txt',
    'rename-new.txt',
    'rename-old.txt',
    'tracked.txt',
    'untracked-hit.txt',
  ]) {
    assert.ok(collisionPaths.has(expected), `missing collision for ${expected}`);
  }
  const headOnly = report.collisions.find((collision) => collision.path === 'head-only.txt');
  assert.ok(headOnly.source.some((entry) => entry.scope === 'head' && entry.kind === 'added'));
  assert.ok(headOnly.target.some((entry) => entry.scope === 'dirty' && entry.kind === 'untracked'));
  const renameOrigin = report.collisions.find((collision) => collision.path === 'rename-old.txt');
  assert.ok(renameOrigin.source.some((entry) => entry.kind === 'renamed'));
  assert.ok(renameOrigin.target.some((entry) => entry.kind === 'modified'));
  const deleted = report.collisions.find((collision) => collision.path === 'delete.txt');
  assert.ok(deleted.source.some((entry) => entry.kind === 'deleted'));
  assert.ok(deleted.target.some((entry) => entry.kind === 'modified'));
  const untracked = report.collisions.find((collision) => collision.path === 'untracked-hit.txt');
  assert.ok(untracked.source.some((entry) => entry.kind === 'untracked'));
  assert.ok(untracked.target.some((entry) => entry.kind === 'untracked'));

  const rejected = runCli(fixture.source, fixture.core, ['--check', '--json']);
  assert.equal(rejected.status, 1, rejected.stderr || rejected.stdout);
  assert.ok(JSON.parse(rejected.stdout).problems.some((problem) => problem.code === 'unresolved_collision'));

  writeFixtureFile(fixture.source, 'tools/ffmpeg-runtime/ffmpeg.exe', 'staged protected mutation\n');
  writeFixtureFile(fixture.source, 'tools/remove-ai-watermarks-runtime/README.md', 'unstaged protected mutation\n');
  runGit(fixture.source, ['add', '--', 'tools/ffmpeg-runtime/ffmpeg.exe']);
  const protectedResult = runCli(fixture.source, fixture.core, ['--check', '--json']);
  assert.equal(protectedResult.status, 1, protectedResult.stderr || protectedResult.stdout);
  const protectedReport = JSON.parse(protectedResult.stdout);
  assert.deepEqual(protectedReport.protectedStaged.map((entry) => entry.path), [
    'tools/ffmpeg-runtime/ffmpeg.exe',
  ]);
  assert.ok(protectedReport.problems.some((problem) => problem.code === 'protected_path_staged'));

  const humanFirst = runCli(fixture.source, fixture.core);
  const humanSecond = runCli(fixture.source, fixture.core);
  assert.equal(humanFirst.status, 0, humanFirst.stderr);
  assert.equal(humanFirst.stdout, humanSecond.stdout, 'human output must also be deterministic');
  assert.match(humanFirst.stdout, /collision path=rename-old\.txt/);
  assert.match(humanFirst.stdout, /result=FAIL/);
});
