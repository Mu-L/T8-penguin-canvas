#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function installedCliCandidate(installRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(installRoot, '.zcanvas-install.json'), 'utf8'));
    const installed = path.join(
      installRoot,
      'runtime',
      String(manifest?.cliVersion || ''),
      'bin',
      'zcanvas.cjs',
    );
    if (manifest?.schema === 't8-zcanvas-install-v1' && fs.existsSync(installed)) {
      return { command: process.execPath, args: [installed], cwd: path.dirname(installRoot) };
    }
  } catch (_) {}
  return null;
}

function projectCliCandidate(startDirectory = process.cwd()) {
  let cursor = path.resolve(startDirectory);
  for (let depth = 0; depth < 12; depth += 1) {
    const source = path.join(cursor, 'tools', 'zcanvas-cli', 'bin', 'zcanvas.cjs');
    const projectSkill = path.join(cursor, '.agents', 'skills', 'zhenzhen-canvas', 'SKILL.md');
    if (fs.existsSync(source) && fs.existsSync(projectSkill)) {
      return { command: process.execPath, args: [source], cwd: cursor };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function executableCandidates() {
  const candidates = [];
  const explicit = String(process.env.ZCANVAS_CLI || '').trim();
  if (explicit) candidates.push({ command: process.execPath, args: [path.resolve(explicit)] });

  // A project checkout is the most specific authority for work performed in
  // that project. It must win over a managed user/global copy so an older
  // installed Skill cannot silently shadow the workspace Skill and CLI.
  const project = projectCliCandidate(process.cwd());
  if (project) candidates.push(project);

  // A Skill discovered from ~/.agents or $CODEX_HOME is a managed copy, not
  // the master installation. Resolve its immutable owner before trying PATH so
  // a stale global zcanvas command cannot silently shadow the paired Skill.
  try {
    const marker = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '..', '.zcanvas-managed.json'),
      'utf8',
    ));
    if (marker?.schema === 't8-zcanvas-discovery-copy-v1' && marker.installRoot) {
      const managed = installedCliCandidate(path.resolve(String(marker.installRoot)));
      if (managed) candidates.push(managed);
    }
  } catch (_) {}

  let cursor = path.resolve(__dirname);
  for (let depth = 0; depth < 8; depth += 1) {
    const source = path.join(cursor, 'tools', 'zcanvas-cli', 'bin', 'zcanvas.cjs');
    if (fs.existsSync(source)) candidates.push({ command: process.execPath, args: [source] });
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const installed = installedCliCandidate(path.resolve(__dirname, '..', '..', '..'));
  if (installed) candidates.push(installed);

  candidates.push({ command: process.platform === 'win32' ? 'zcanvas.cmd' : 'zcanvas', args: [] });
  return candidates;
}

function run() {
  const userArgs = process.argv.slice(2);
  let lastError = null;
  for (const candidate of executableCandidates()) {
    // On Windows an update cannot atomically replace a managed discovery copy
    // while this wrapper still has that directory as its current directory.
    // Move both parent and child execution outside the discovery copy and the
    // swappable master install root before starting the immutable runtime.
    if (candidate.cwd) {
      try { process.chdir(candidate.cwd); } catch (_) {}
    }
    const result = spawnSync(candidate.command, [...candidate.args, ...userArgs], {
      stdio: 'inherit',
      windowsHide: true,
      shell: false,
      env: process.env,
      cwd: candidate.cwd || process.cwd(),
    });
    if (!result.error) process.exit(result.status == null ? 1 : result.status);
    lastError = result.error;
    if (result.error.code !== 'ENOENT') break;
  }

  process.stderr.write(`zcanvas CLI 未安装或不可执行：${lastError?.message || 'unknown error'}\n`);
  process.exit(8);
}

run();
