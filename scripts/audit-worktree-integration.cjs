'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  LEGACY_F2_HEAD,
  evaluateWorktreeRole,
} = require('./worktree-role.cjs');

const REPORT_SCHEMA_VERSION = 2;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const LEGACY_F2_PROTECTED_BASELINE = Object.freeze([
  Object.freeze({
    path: 'tools/ffmpeg-runtime/ffmpeg.exe',
    bytes: 143_314_432,
    sha256: '754a10ce2fc4a8c974ff492b351f58c02d35124d1d602fcf30f561fb1bd0f579',
  }),
  Object.freeze({
    path: 'tools/remove-ai-watermarks-runtime/README.md',
    bytes: 2_298,
    sha256: '04f13f0adbb8593372fb9ddfa297a0dfb90d9ead0325de0cd340fcfe8b7ced56',
  }),
]);
const PROTECTED_PATHS = Object.freeze(LEGACY_F2_PROTECTED_BASELINE.map((entry) => entry.path));

function compareText(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function normalizeRepositoryPath(value) {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .normalize('NFC');
  return path.posix.normalize(normalized);
}

function repositoryPathKey(value) {
  return normalizeRepositoryPath(value).toLowerCase();
}

function filesystemPathKey(value) {
  const normalized = path.resolve(String(value || '.'))
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function canonicalDirectory(value) {
  const resolved = path.resolve(String(value || '.'));
  const realpath = fs.realpathSync.native || fs.realpathSync;
  return realpath(resolved);
}

function sha256RegularFile(filename) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function inspectProtectedFiles(root, baseline = LEGACY_F2_PROTECTED_BASELINE) {
  const topLevel = path.resolve(String(root || '.'));
  return baseline.map((expected) => {
    const relativePath = normalizeRepositoryPath(expected.path);
    const filename = path.resolve(topLevel, ...relativePath.split('/'));
    const boundary = `${topLevel}${path.sep}`.toLowerCase();
    if (!filename.toLowerCase().startsWith(boundary)) {
      throw new Error(`protected path escapes source worktree: ${relativePath}`);
    }
    let stat;
    try {
      stat = fs.lstatSync(filename);
    } catch (error) {
      return {
        path: relativePath,
        exists: false,
        regular: false,
        symlink: false,
        bytes: null,
        sha256: null,
        error: error?.code || 'unreadable',
      };
    }
    const regular = stat.isFile() && !stat.isSymbolicLink();
    return {
      path: relativePath,
      exists: true,
      regular,
      symlink: stat.isSymbolicLink(),
      bytes: stat.size,
      sha256: regular ? sha256RegularFile(filename) : null,
    };
  }).sort((left, right) => compareText(left.path, right.path));
}

function gitSafeDirectoryValue(value) {
  return path.resolve(value).replace(/\\/g, '/');
}

function sanitizeRemoteUrl(value) {
  const remote = String(value || '').trim();
  if (!remote) return null;
  try {
    const parsed = new URL(remote);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return remote.replace(/^(https?:\/\/)[^/@\s]+@/i, '$1');
  }
}

function captureGit(root, args, { allowStatuses = [0] } = {}) {
  const result = spawnSync('git', [
    '-c',
    `safe.directory=${gitSafeDirectoryValue(root)}`,
    ...args,
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
  if (result.error || !allowStatuses.includes(result.status)) {
    const detail = `${result.stdout || ''}${result.stderr || ''}`.trim();
    throw new Error(`cannot run read-only git ${args[0] || 'inspection'}${detail ? `: ${detail}` : ''}`);
  }
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function splitLeadingFields(value, count) {
  const fields = [];
  let remainder = String(value || '');
  for (let index = 0; index < count; index += 1) {
    const separator = remainder.indexOf(' ');
    if (separator < 0) {
      throw new Error('malformed porcelain v2 status record');
    }
    fields.push(remainder.slice(0, separator));
    remainder = remainder.slice(separator + 1);
  }
  return { fields, remainder };
}

function statusChangeKind(indexStatus, worktreeStatus, fallback = 'tracked') {
  const states = `${indexStatus || ''}${worktreeStatus || ''}`;
  if (states.includes('U')) return 'unmerged';
  if (states.includes('R')) return 'renamed';
  if (states.includes('C')) return 'copied';
  if (states.includes('D')) return 'deleted';
  if (states.includes('A')) return 'added';
  if (states.includes('T')) return 'type-changed';
  if (states.includes('M')) return 'modified';
  return fallback;
}

function normalizeStatusEntry(entry) {
  const normalized = {
    scope: 'dirty',
    kind: entry.kind,
    status: entry.status,
    index: entry.index,
    worktree: entry.worktree,
    staged: entry.staged === true,
    unstaged: entry.unstaged === true,
    path: normalizeRepositoryPath(entry.path),
  };
  if (entry.originalPath) {
    normalized.originalPath = normalizeRepositoryPath(entry.originalPath);
  }
  if (entry.score) normalized.score = entry.score;
  return normalized;
}

function compareChange(left, right) {
  return compareText(left.path, right.path)
    || compareText(left.originalPath, right.originalPath)
    || compareText(left.scope, right.scope)
    || compareText(left.kind, right.kind)
    || compareText(left.status, right.status)
    || Number(left.staged || false) - Number(right.staged || false)
    || Number(left.unstaged || false) - Number(right.unstaged || false);
}

function parseStatusPorcelainV2(value) {
  const records = String(value || '').split('\0');
  if (records.at(-1) === '') records.pop();
  const entries = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('1 ')) {
      const { fields, remainder } = splitLeadingFields(record.slice(2), 7);
      const [xy] = fields;
      if (xy.length !== 2 || !remainder) throw new Error('malformed ordinary porcelain v2 status record');
      entries.push(normalizeStatusEntry({
        kind: statusChangeKind(xy[0], xy[1]),
        status: xy,
        index: xy[0],
        worktree: xy[1],
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
        path: remainder,
      }));
      continue;
    }
    if (record.startsWith('2 ')) {
      const { fields, remainder } = splitLeadingFields(record.slice(2), 8);
      const [xy, , , , , , , score] = fields;
      const originalPath = records[index + 1];
      if (xy.length !== 2 || !remainder || !originalPath || !/^[RC][0-9]+$/.test(score)) {
        throw new Error('malformed rename/copy porcelain v2 status record');
      }
      index += 1;
      entries.push(normalizeStatusEntry({
        kind: score.startsWith('C') ? 'copied' : 'renamed',
        status: xy,
        index: xy[0],
        worktree: xy[1],
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
        path: remainder,
        originalPath,
        score,
      }));
      continue;
    }
    if (record.startsWith('u ')) {
      const { fields, remainder } = splitLeadingFields(record.slice(2), 9);
      const [xy] = fields;
      if (xy.length !== 2 || !remainder) throw new Error('malformed unmerged porcelain v2 status record');
      entries.push(normalizeStatusEntry({
        kind: 'unmerged',
        status: xy,
        index: xy[0],
        worktree: xy[1],
        staged: true,
        unstaged: true,
        path: remainder,
      }));
      continue;
    }
    if (record.startsWith('? ')) {
      entries.push(normalizeStatusEntry({
        kind: 'untracked',
        status: '??',
        index: '?',
        worktree: '?',
        staged: false,
        unstaged: true,
        path: record.slice(2),
      }));
      continue;
    }
    if (record.startsWith('! ')) continue;
    throw new Error('unknown porcelain v2 status record');
  }

  return entries.sort(compareChange);
}

function headChangeKind(status) {
  const code = String(status || '').charAt(0);
  if (code === 'R') return 'renamed';
  if (code === 'C') return 'copied';
  if (code === 'D') return 'deleted';
  if (code === 'A') return 'added';
  if (code === 'T') return 'type-changed';
  if (code === 'M') return 'modified';
  if (code === 'U') return 'unmerged';
  return 'changed';
}

function parseNameStatusZ(value) {
  const tokens = String(value || '').split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const entries = [];
  for (let index = 0; index < tokens.length;) {
    let status = tokens[index];
    index += 1;
    let inlinePaths = [];
    if (status.includes('\t')) {
      const parts = status.split('\t');
      status = parts.shift();
      inlinePaths = parts;
    }
    if (!/^[A-Z][0-9]*$/.test(status)) {
      throw new Error('malformed git name-status record');
    }
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    const paths = inlinePaths.slice();
    while (paths.length < pathCount && index < tokens.length) {
      paths.push(tokens[index]);
      index += 1;
    }
    if (paths.length !== pathCount || paths.some((item) => !item)) {
      throw new Error('incomplete git name-status record');
    }
    const renamed = pathCount === 2;
    entries.push({
      scope: 'head',
      kind: headChangeKind(status),
      status,
      path: normalizeRepositoryPath(renamed ? paths[1] : paths[0]),
      ...(renamed ? { originalPath: normalizeRepositoryPath(paths[0]) } : {}),
    });
  }
  return entries.sort(compareChange);
}

function inspectWorktree(requestedPath) {
  const realPath = canonicalDirectory(requestedPath);
  const topLevelOutput = captureGit(realPath, ['rev-parse', '--show-toplevel']).stdout.trim();
  const topLevel = canonicalDirectory(topLevelOutput);
  const commonDirOutput = captureGit(topLevel, ['rev-parse', '--git-common-dir']).stdout.trim();
  const commonDirCandidate = path.isAbsolute(commonDirOutput)
    ? commonDirOutput
    : path.resolve(topLevel, commonDirOutput);
  const commonDir = canonicalDirectory(commonDirCandidate);
  const originResult = captureGit(topLevel, ['remote', 'get-url', 'origin'], { allowStatuses: [0, 2] });
  const branch = captureGit(topLevel, ['branch', '--show-current']).stdout.trim();
  const head = captureGit(topLevel, ['rev-parse', 'HEAD']).stdout.trim().toLowerCase();
  const statusOutput = captureGit(topLevel, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=none',
    '--renames',
  ]).stdout;

  return {
    requestedPath: path.resolve(String(requestedPath || '.')),
    realPath,
    topLevel,
    commonDir,
    origin: originResult.status === 0 ? sanitizeRemoteUrl(originResult.stdout) : null,
    branch,
    head,
    status: parseStatusPorcelainV2(statusOutput),
  };
}

function inspectHeadGraph(source, target) {
  if (filesystemPathKey(source.commonDir) !== filesystemPathKey(target.commonDir)) {
    return {
      mergeBase: null,
      aheadBehind: null,
      sourceChanges: [],
      targetChanges: [],
    };
  }

  const mergeBaseResult = captureGit(source.topLevel, [
    'merge-base',
    source.head,
    target.head,
  ], { allowStatuses: [0, 1] });
  if (mergeBaseResult.status !== 0 || !mergeBaseResult.stdout.trim()) {
    return {
      mergeBase: null,
      aheadBehind: null,
      sourceChanges: [],
      targetChanges: [],
    };
  }

  const mergeBase = mergeBaseResult.stdout.trim().toLowerCase();
  const counts = captureGit(source.topLevel, [
    'rev-list',
    '--left-right',
    '--count',
    `${source.head}...${target.head}`,
  ]).stdout.trim().split(/\s+/).map((item) => Number.parseInt(item, 10));
  if (counts.length !== 2 || counts.some((item) => !Number.isSafeInteger(item) || item < 0)) {
    throw new Error('cannot parse ahead/behind counts');
  }

  function changesTo(head) {
    if (head === mergeBase) return [];
    return parseNameStatusZ(captureGit(source.topLevel, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-status',
      '-z',
      mergeBase,
      head,
      '--',
    ]).stdout);
  }

  return {
    mergeBase,
    aheadBehind: {
      source: counts[0],
      target: counts[1],
    },
    sourceChanges: changesTo(source.head),
    targetChanges: changesTo(target.head),
  };
}

function summarizeStatus(entries) {
  const summary = {
    total: entries.length,
    tracked: 0,
    untracked: 0,
    renamed: 0,
    deleted: 0,
    staged: 0,
    unstaged: 0,
    unmerged: 0,
  };
  entries.forEach((entry) => {
    if (entry.kind === 'untracked') summary.untracked += 1;
    else summary.tracked += 1;
    if (entry.kind === 'renamed') summary.renamed += 1;
    if (entry.kind === 'deleted') summary.deleted += 1;
    if (entry.kind === 'unmerged') summary.unmerged += 1;
    if (entry.staged) summary.staged += 1;
    if (entry.unstaged) summary.unstaged += 1;
  });
  return summary;
}

function summarizeHeadChanges(entries) {
  const byKind = {};
  entries.forEach((entry) => {
    byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
  });
  return {
    total: entries.length,
    byKind: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => compareText(a, b))),
  };
}

function changeFootprints(entry) {
  const values = [entry.path];
  if (entry.originalPath) values.push(entry.originalPath);
  return [...new Set(values.map(normalizeRepositoryPath))].sort(compareText);
}

function collisionReference(entry) {
  return {
    scope: entry.scope,
    kind: entry.kind,
    status: entry.status,
    path: entry.path,
    ...(entry.originalPath ? { originalPath: entry.originalPath } : {}),
    ...(entry.scope === 'dirty' ? {
      staged: entry.staged === true,
      unstaged: entry.unstaged === true,
    } : {}),
  };
}

function indexChanges(entries) {
  const index = new Map();
  entries.forEach((entry) => {
    changeFootprints(entry).forEach((footprint) => {
      const key = repositoryPathKey(footprint);
      const current = index.get(key) || { paths: new Set(), entries: [] };
      current.paths.add(footprint);
      current.entries.push(entry);
      index.set(key, current);
    });
  });
  return index;
}

function uniqueCollisionReferences(entries) {
  const seen = new Set();
  const references = [];
  entries.sort(compareChange).forEach((entry) => {
    const reference = collisionReference(entry);
    const key = JSON.stringify(reference);
    if (seen.has(key)) return;
    seen.add(key);
    references.push(reference);
  });
  return references;
}

function detectCollisions(sourceChanges, targetChanges) {
  const sourceIndex = indexChanges(sourceChanges);
  const targetIndex = indexChanges(targetChanges);
  const sharedKeys = [...sourceIndex.keys()]
    .filter((key) => targetIndex.has(key))
    .sort(compareText);

  return sharedKeys.map((key) => {
    const source = sourceIndex.get(key);
    const target = targetIndex.get(key);
    const paths = [...source.paths, ...target.paths].sort(compareText);
    const sourceEntries = uniqueCollisionReferences(source.entries.slice());
    const targetEntries = uniqueCollisionReferences(target.entries.slice());
    const reasons = new Set();
    sourceEntries.forEach((left) => {
      targetEntries.forEach((right) => reasons.add(`${left.scope}-vs-${right.scope}`));
    });
    return {
      path: paths[0],
      reasons: [...reasons].sort(compareText),
      source: sourceEntries,
      target: targetEntries,
      resolution: 'required',
    };
  });
}

function protectedStagedEntries(label, entries) {
  const protectedKeys = new Set(PROTECTED_PATHS.map(repositoryPathKey));
  const violations = [];
  entries.forEach((entry) => {
    if (!entry.staged) return;
    changeFootprints(entry).forEach((footprint) => {
      if (!protectedKeys.has(repositoryPathKey(footprint))) return;
      violations.push({
        worktree: label,
        path: footprint,
        status: entry.status,
      });
    });
  });
  return violations.sort((left, right) => compareText(left.worktree, right.worktree)
    || compareText(left.path, right.path)
    || compareText(left.status, right.status));
}

function evaluateLegacyProtectedSnapshot(source, sourceRole) {
  const applicable = sourceRole.legacyF2 === true;
  const observed = Array.isArray(source.protectedFiles)
    ? source.protectedFiles.slice().sort((left, right) => compareText(left.path, right.path))
    : [];
  const byPath = new Map(observed.map((entry) => [repositoryPathKey(entry.path), entry]));
  const violations = [];
  if (applicable) {
    LEGACY_F2_PROTECTED_BASELINE.forEach((expected) => {
      const actual = byPath.get(repositoryPathKey(expected.path));
      let reason = '';
      if (!actual) reason = 'unverified';
      else if (actual.exists !== true) reason = 'missing';
      else if (actual.regular !== true || actual.symlink === true) reason = 'not_regular';
      else if (actual.bytes !== expected.bytes) reason = 'size_mismatch';
      else if (String(actual.sha256 || '').toLowerCase() !== expected.sha256) reason = 'sha256_mismatch';
      if (reason) {
        violations.push({
          worktree: 'source',
          path: expected.path,
          reason,
          expectedBytes: expected.bytes,
          expectedSha256: expected.sha256,
          actualBytes: actual?.bytes ?? null,
          actualSha256: actual?.sha256 ?? null,
        });
      }
    });
  }
  return {
    applicable,
    expected: LEGACY_F2_PROTECTED_BASELINE.map((entry) => ({ ...entry })),
    observed,
    violations,
    intact: !applicable || violations.length === 0,
  };
}

function compareProblem(left, right) {
  return compareText(left.code, right.code)
    || compareText(left.worktree, right.worktree)
    || compareText(left.path, right.path)
    || compareText(left.message, right.message);
}

function evaluateIntegrationAudit({ source, target, graph }) {
  const sourceStatus = (source.status || []).slice().sort(compareChange);
  const targetStatus = (target.status || []).slice().sort(compareChange);
  const sourceHeadChanges = (graph.sourceChanges || []).slice().sort(compareChange);
  const targetHeadChanges = (graph.targetChanges || []).slice().sort(compareChange);
  const sameCommonDir = filesystemPathKey(source.commonDir) === filesystemPathKey(target.commonDir);
  const distinctWorktrees = filesystemPathKey(source.topLevel) !== filesystemPathKey(target.topLevel);
  const sourceRole = evaluateWorktreeRole({
    root: source.topLevel,
    branch: source.branch,
    head: source.head,
    mode: 'development',
    allowLegacyF2: true,
  });
  const targetRole = evaluateWorktreeRole({
    root: target.topLevel,
    branch: target.branch,
    head: target.head,
    mode: 'core',
  });
  const collisions = detectCollisions(
    [...sourceHeadChanges, ...sourceStatus],
    [...targetHeadChanges, ...targetStatus],
  );
  const protectedStaged = [
    ...protectedStagedEntries('source', sourceStatus),
    ...protectedStagedEntries('target', targetStatus),
  ];
  const protectedSourceSnapshot = evaluateLegacyProtectedSnapshot(source, sourceRole);
  const unmerged = [
    ...sourceStatus.filter((entry) => entry.kind === 'unmerged').map((entry) => ({ worktree: 'source', path: entry.path })),
    ...targetStatus.filter((entry) => entry.kind === 'unmerged').map((entry) => ({ worktree: 'target', path: entry.path })),
  ].sort((left, right) => compareText(left.worktree, right.worktree) || compareText(left.path, right.path));
  const legacySourceDirty = sourceRole.legacyF2
    && String(source.head || '').toLowerCase() === LEGACY_F2_HEAD
    && sourceStatus.length > 0;
  const problems = [];
  const warnings = [];

  if (!sameCommonDir) {
    problems.push({
      code: 'different_common_dir',
      message: 'source and target are not linked worktrees of the same Git common directory',
    });
  }
  if (!distinctWorktrees) {
    problems.push({
      code: 'same_worktree',
      message: 'source and target resolve to the same worktree',
    });
  }
  sourceRole.errors.forEach((message) => problems.push({ code: 'source_role_mismatch', worktree: 'source', message }));
  targetRole.errors.forEach((message) => problems.push({ code: 'target_role_mismatch', worktree: 'target', message }));
  sourceRole.warnings.forEach((message) => warnings.push({ code: 'source_role_warning', worktree: 'source', message }));
  targetRole.warnings.forEach((message) => warnings.push({ code: 'target_role_warning', worktree: 'target', message }));
  if (sameCommonDir && !graph.mergeBase) {
    problems.push({
      code: 'missing_merge_base',
      message: 'source and target do not have a verifiable merge base',
    });
  }
  if (!source.origin) warnings.push({ code: 'origin_missing', worktree: 'source', message: 'source origin is not configured' });
  if (!target.origin) warnings.push({ code: 'origin_missing', worktree: 'target', message: 'target origin is not configured' });
  if (source.origin && target.origin && source.origin !== target.origin) {
    warnings.push({ code: 'origin_mismatch', message: 'source and target report different origin URLs' });
  }
  if (legacySourceDirty) {
    problems.push({
      code: 'legacy_source_uncheckpointed',
      worktree: 'source',
      message: 'the frozen legacy F2 HEAD still has an uncheckpointed dirty overlay and cannot be integrated directly',
    });
  }
  protectedStaged.forEach((violation) => problems.push({
    code: 'protected_path_staged',
    ...violation,
    message: 'protected path is staged',
  }));
  protectedSourceSnapshot.violations.forEach((violation) => problems.push({
    code: 'protected_path_snapshot_mismatch',
    ...violation,
    message: `protected source snapshot is not intact (${violation.reason})`,
  }));
  unmerged.forEach((entry) => problems.push({
    code: 'unmerged_status',
    ...entry,
    message: 'worktree already contains an unresolved Git conflict',
  }));
  collisions.forEach((collision) => problems.push({
    code: 'unresolved_collision',
    path: collision.path,
    message: 'source and target changes overlap and require an explicit semantic resolution',
  }));

  problems.sort(compareProblem);
  warnings.sort(compareProblem);
  const checks = {
    distinctWorktrees,
    sameCommonDir,
    sourceRole: sourceRole.ok,
    targetRole: targetRole.ok,
    mergeBaseAvailable: Boolean(graph.mergeBase),
    legacySourceCheckpointed: !legacySourceDirty,
    protectedPathsUnstaged: protectedStaged.length === 0,
    protectedSourceSnapshotIntact: protectedSourceSnapshot.intact,
    noUnmergedStatus: unmerged.length === 0,
    noUnresolvedCollisions: collisions.length === 0,
  };

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    readOnly: true,
    source: {
      ...source,
      status: sourceStatus,
      statusSummary: summarizeStatus(sourceStatus),
      headChanges: sourceHeadChanges,
      headChangeSummary: summarizeHeadChanges(sourceHeadChanges),
      role: sourceRole,
    },
    target: {
      ...target,
      status: targetStatus,
      statusSummary: summarizeStatus(targetStatus),
      headChanges: targetHeadChanges,
      headChangeSummary: summarizeHeadChanges(targetHeadChanges),
      role: targetRole,
    },
    graph: {
      mergeBase: graph.mergeBase || null,
      aheadBehind: graph.aheadBehind || null,
    },
    protectedPaths: [...PROTECTED_PATHS],
    protectedStaged,
    protectedSourceSnapshot,
    collisions,
    checks,
    problems,
    warnings,
    ok: problems.length === 0,
  };
}

function auditWorktreeIntegration({ sourcePath, targetPath }) {
  const inspectedSource = inspectWorktree(sourcePath);
  const source = {
    ...inspectedSource,
    protectedFiles: inspectProtectedFiles(inspectedSource.topLevel),
  };
  const target = inspectWorktree(targetPath);
  const graph = inspectHeadGraph(source, target);
  return evaluateIntegrationAudit({ source, target, graph });
}

function formatChangeReference(reference) {
  const pathLabel = reference.originalPath
    ? `${reference.originalPath}->${reference.path}`
    : reference.path;
  return `${reference.scope}:${reference.kind}:${reference.status}:${pathLabel}`;
}

function formatHuman(report) {
  const lines = [
    `[worktree-integration] source.realPath=${report.source.realPath}`,
    `[worktree-integration] source.topLevel=${report.source.topLevel}`,
    `[worktree-integration] source.branch=${report.source.branch || '(detached)'}`,
    `[worktree-integration] source.head=${report.source.head}`,
    `[worktree-integration] source.commonDir=${report.source.commonDir}`,
    `[worktree-integration] source.origin=${report.source.origin || '(none)'}`,
    `[worktree-integration] target.realPath=${report.target.realPath}`,
    `[worktree-integration] target.topLevel=${report.target.topLevel}`,
    `[worktree-integration] target.branch=${report.target.branch || '(detached)'}`,
    `[worktree-integration] target.head=${report.target.head}`,
    `[worktree-integration] target.commonDir=${report.target.commonDir}`,
    `[worktree-integration] target.origin=${report.target.origin || '(none)'}`,
    `[worktree-integration] mergeBase=${report.graph.mergeBase || '(none)'}`,
    `[worktree-integration] aheadBehind=source:${report.graph.aheadBehind?.source ?? '?'} target:${report.graph.aheadBehind?.target ?? '?'}`,
    `[worktree-integration] source.status=total:${report.source.statusSummary.total} tracked:${report.source.statusSummary.tracked} untracked:${report.source.statusSummary.untracked} staged:${report.source.statusSummary.staged} renamed:${report.source.statusSummary.renamed} deleted:${report.source.statusSummary.deleted}`,
    `[worktree-integration] target.status=total:${report.target.statusSummary.total} tracked:${report.target.statusSummary.tracked} untracked:${report.target.statusSummary.untracked} staged:${report.target.statusSummary.staged} renamed:${report.target.statusSummary.renamed} deleted:${report.target.statusSummary.deleted}`,
    `[worktree-integration] headChanges=source:${report.source.headChangeSummary.total} target:${report.target.headChangeSummary.total}`,
    `[worktree-integration] protectedSourceSnapshot=applicable:${report.protectedSourceSnapshot.applicable} intact:${report.protectedSourceSnapshot.intact} verified:${report.protectedSourceSnapshot.observed.length}/${report.protectedSourceSnapshot.expected.length}`,
  ];
  report.collisions.forEach((collision) => {
    lines.push(`[worktree-integration] collision path=${collision.path} reasons=${collision.reasons.join(',')} source=${collision.source.map(formatChangeReference).join('|')} target=${collision.target.map(formatChangeReference).join('|')}`);
  });
  report.warnings.forEach((warning) => {
    lines.push(`[worktree-integration] warning code=${warning.code}${warning.worktree ? ` worktree=${warning.worktree}` : ''}${warning.path ? ` path=${warning.path}` : ''}: ${warning.message}`);
  });
  report.problems.forEach((problem) => {
    lines.push(`[worktree-integration] error code=${problem.code}${problem.worktree ? ` worktree=${problem.worktree}` : ''}${problem.path ? ` path=${problem.path}` : ''}: ${problem.message}`);
  });
  lines.push(`[worktree-integration] result=${report.ok ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

function usage() {
  return [
    'Usage: node scripts/audit-worktree-integration.cjs --target <core-worktree> [options]',
    '',
    'Options:',
    '  --source <path>  Source development worktree (default: current directory)',
    '  --target <path>  Canonical core/integration worktree (required)',
    '  --json           Emit deterministic JSON instead of human output',
    '  --check          Exit 1 when any fail-closed integration condition exists',
    '  --help           Show this help',
  ].join('\n');
}

function parseArguments(argv) {
  const options = {
    sourcePath: process.cwd(),
    targetPath: '',
    json: false,
    check: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--check') options.check = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--source' || argument === '--target') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`);
      index += 1;
      if (argument === '--source') options.sourcePath = value;
      else options.targetPath = value;
    } else if (argument.startsWith('--source=')) options.sourcePath = argument.slice('--source='.length);
    else if (argument.startsWith('--target=')) options.targetPath = argument.slice('--target='.length);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.help && !options.targetPath) throw new Error('--target is required');
  return options;
}

function runCli(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const report = auditWorktreeIntegration(options);
    process.stdout.write(options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatHuman(report)}\n`);
    return options.check && !report.ok ? 1 : 0;
  } catch (error) {
    process.stderr.write(`[worktree-integration] ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = runCli();
}

module.exports = {
  LEGACY_F2_PROTECTED_BASELINE,
  PROTECTED_PATHS,
  REPORT_SCHEMA_VERSION,
  auditWorktreeIntegration,
  captureGit,
  detectCollisions,
  evaluateIntegrationAudit,
  formatHuman,
  inspectHeadGraph,
  inspectProtectedFiles,
  inspectWorktree,
  normalizeRepositoryPath,
  parseArguments,
  parseNameStatusZ,
  parseStatusPorcelainV2,
  evaluateLegacyProtectedSnapshot,
  runCli,
  sanitizeRemoteUrl,
  summarizeStatus,
  usage,
};
