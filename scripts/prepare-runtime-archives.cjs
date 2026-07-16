#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tools', 'runtime-archives');
const FORCE = process.env.T8_REBUILD_RUNTIME_ARCHIVES === '1';
const STRICT = process.env.T8_REQUIRE_RUNTIME_ARCHIVES === '1';

const RUNTIMES = [
  {
    id: 'remove-ai-watermarks',
    sourceDir: path.join(ROOT, 'tools', 'remove-ai-watermarks-runtime'),
    archiveFile: 'remove-ai-watermarks-runtime.zip',
    manifestFile: 'runtime-manifest.json',
    requiredSourceFiles: [
      'python/python.exe',
      'python/Scripts/remove-ai-watermarks.exe',
      'runtime-manifest.json',
    ],
    minimumSourceFiles: 40_000,
    minimumSourceBytes: 1_000_000_000,
    minimumArchiveBytes: 500_000_000,
  },
  {
    id: 'parsehub-pythonlibs',
    sourceDir: path.join(ROOT, 'tools', 'parsehub-pythonlibs'),
    archiveFile: 'parsehub-pythonlibs.zip',
    requiredSourceFiles: [
      'parsehub/__init__.py',
    ],
    minimumSourceFiles: 6_000,
    minimumSourceBytes: 200_000_000,
    minimumArchiveBytes: 50_000_000,
  },
];

function require7za() {
  try {
    const mod = require('7zip-bin');
    if (mod && mod.path7za && fs.existsSync(mod.path7za)) return mod.path7za;
  } catch (_) {}
  return '';
}

function walkStats(root) {
  const stack = [root];
  const filePaths = [];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      filePaths.push(full);
    }
  }
  filePaths.sort((left, right) => (
    path.relative(root, left).replace(/\\/g, '/')
      .localeCompare(path.relative(root, right).replace(/\\/g, '/'), 'en')
  ));
  const sourceHash = crypto.createHash('sha256');
  let bytes = 0;
  let maxMtimeMs = 0;
  for (const full of filePaths) {
    const st = fs.statSync(full);
    const relativePath = path.relative(root, full).replace(/\\/g, '/');
    bytes += st.size;
    maxMtimeMs = Math.max(maxMtimeMs, st.mtimeMs);
    sourceHash.update(relativePath);
    sourceHash.update('\0');
    sourceHash.update(String(st.size));
    sourceHash.update('\0');
    sourceHash.update(sha256File(full));
    sourceHash.update('\n');
  }
  return {
    files: filePaths.length,
    bytes,
    maxMtimeMs,
    sourceSha256: sourceHash.digest('hex'),
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  const handle = fs.openSync(filePath, 'r');
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

function loadExistingManifest() {
  return readJson(path.join(OUT_DIR, 'runtime-archives-manifest.json')) || { runtimes: {} };
}

function assertStrictRuntimeSource(runtime, sourceStats) {
  if (!STRICT) return;
  const missing = (runtime.requiredSourceFiles || []).filter((relativePath) => {
    const absolutePath = path.join(runtime.sourceDir, ...relativePath.split('/'));
    try {
      return !fs.statSync(absolutePath).isFile();
    } catch (_) {
      return true;
    }
  });
  const problems = [];
  if (missing.length > 0) problems.push(`missing required files: ${missing.join(', ')}`);
  if (sourceStats.files < runtime.minimumSourceFiles) {
    problems.push(`sourceFiles=${sourceStats.files} < ${runtime.minimumSourceFiles}`);
  }
  if (sourceStats.bytes < runtime.minimumSourceBytes) {
    problems.push(`sourceBytes=${sourceStats.bytes} < ${runtime.minimumSourceBytes}`);
  }
  if (problems.length > 0) {
    console.error(`[runtime-archives] strict source validation failed for ${runtime.id}: ${problems.join('; ')}`);
    process.exit(1);
  }
}

function shouldRebuild(runtime, sourceStats, existingManifest) {
  if (FORCE) return true;
  const archivePath = path.join(OUT_DIR, runtime.archiveFile);
  const entry = existingManifest?.runtimes?.[runtime.id];
  if (!(
    fs.existsSync(archivePath) &&
    entry &&
    Number(entry.sourceFiles || 0) === sourceStats.files &&
    Number(entry.sourceBytes || 0) === sourceStats.bytes &&
    Number(entry.sourceMtimeMs || 0) === sourceStats.maxMtimeMs &&
    /^[a-f0-9]{64}$/i.test(String(entry.sourceSha256 || '')) &&
    String(entry.sourceSha256).toLowerCase() === sourceStats.sourceSha256
  )) {
    return true;
  }
  const archiveStat = fs.statSync(archivePath);
  if (archiveStat.size < runtime.minimumArchiveBytes) return true;
  if (Number(entry.archiveBytes || 0) > 0 && Number(entry.archiveBytes) !== archiveStat.size) return true;
  if (!/^[a-f0-9]{64}$/i.test(String(entry.archiveSha256 || ''))) return true;
  if (sha256File(archivePath) !== String(entry.archiveSha256).toLowerCase()) return true;
  return false;
}

function run7zip(runtime, archivePath, path7za) {
  fs.rmSync(archivePath, { force: true });
  const result = spawnSync(path7za, [
    'a',
    '-tzip',
    '-mx=1',
    '-mmt=on',
    archivePath,
    '.',
  ], {
    cwd: runtime.sourceDir,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`7za exited with ${result.status}`);
}

function buildEntry(runtime, sourceStats, archivePath) {
  const archiveStat = fs.statSync(archivePath);
  const sourceManifest = runtime.manifestFile
    ? readJson(path.join(runtime.sourceDir, runtime.manifestFile))
    : null;
  return {
    ...(sourceManifest || {}),
    id: runtime.id,
    archiveFile: runtime.archiveFile,
    archiveBytes: archiveStat.size,
    archiveSha256: sha256File(archivePath),
    sourceFiles: sourceStats.files,
    sourceBytes: sourceStats.bytes,
    sourceMtimeMs: sourceStats.maxMtimeMs,
    sourceSha256: sourceStats.sourceSha256,
    createdAt: new Date().toISOString(),
  };
}

function main() {
  const path7za = require7za();
  if (!path7za) {
    console.error('[runtime-archives] 7zip-bin is missing. Run npm install first.');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = {
    format: 'zip',
    compression: '7za -tzip -mx=1 -mmt=on',
    generatedAt: new Date().toISOString(),
    runtimes: {},
  };
  const existing = loadExistingManifest();

  for (const runtime of RUNTIMES) {
    if (!fs.existsSync(runtime.sourceDir)) {
      const message = `[runtime-archives] source missing: ${path.relative(ROOT, runtime.sourceDir)}`;
      if (STRICT) {
        console.error(message);
        process.exit(1);
      }
      console.warn(message);
      continue;
    }
    const sourceStats = walkStats(runtime.sourceDir);
    assertStrictRuntimeSource(runtime, sourceStats);
    const archivePath = path.join(OUT_DIR, runtime.archiveFile);
    if (shouldRebuild(runtime, sourceStats, existing)) {
      console.log(`[runtime-archives] creating ${runtime.archiveFile} from ${path.relative(ROOT, runtime.sourceDir)} (${sourceStats.files} files)`);
      run7zip(runtime, archivePath, path7za);
    } else {
      console.log(`[runtime-archives] reusing ${runtime.archiveFile}`);
    }
    manifest.runtimes[runtime.id] = buildEntry(runtime, sourceStats, archivePath);
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'runtime-archives-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
  console.log(`[runtime-archives] manifest written: ${path.relative(ROOT, path.join(OUT_DIR, 'runtime-archives-manifest.json'))}`);
}

main();
