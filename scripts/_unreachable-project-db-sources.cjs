'use strict';

// Read-only source archaeology: inspect unreachable Git blobs for historical
// ProjectDatabase sources. No working-tree or retained database files are read.

const childProcess = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const git = (...args) => childProcess.execFileSync(
  'git',
  ['-c', 'safe.directory=E:/PenguinPravite/T8-penguin-canvas-release-2.5.7', ...args],
  { cwd: root, windowsHide: true },
);

const fsck = git('fsck', '--full', '--no-reflogs', '--unreachable').toString('utf8');
const hashes = fsck.split(/\r?\n/)
  .map((line) => /^unreachable blob ([0-9a-f]{40})$/.exec(line)?.[1] || null)
  .filter(Boolean);
const batch = childProcess.execFileSync(
  'git',
  ['-c', 'safe.directory=E:/PenguinPravite/T8-penguin-canvas-release-2.5.7', 'cat-file', '--batch'],
  {
    cwd: root,
    input: `${hashes.join('\n')}\n`,
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  },
);

let offset = 0;
const matches = [];
for (const expectedHash of hashes) {
  const headerEnd = batch.indexOf(0x0a, offset);
  if (headerEnd < 0) throw new Error(`missing cat-file header for ${expectedHash}`);
  const header = batch.subarray(offset, headerEnd).toString('utf8');
  offset = headerEnd + 1;
  const match = /^([0-9a-f]{40}) blob (\d+)$/.exec(header);
  if (!match || match[1] !== expectedHash) throw new Error(`invalid cat-file header: ${header}`);
  const size = Number(match[2]);
  const content = batch.subarray(offset, offset + size);
  offset += size + 1;
  if (size < 50_000 || size > 5_000_000) continue;
  const text = content.toString('utf8');
  if (!text.includes('class ProjectDatabase')
    || !text.includes('PROJECT_DATABASE_SCHEMA_VERSION')) continue;
  matches.push({
    hash: expectedHash,
    size,
    version: Number(/PROJECT_DATABASE_SCHEMA_VERSION\s*=\s*(\d+)/.exec(text)?.[1] || -1),
    ensureColumnCount: (text.match(/ensureColumn\(/g) || []).length,
    createTableCount: (text.match(/CREATE TABLE IF NOT EXISTS/g) || []).length,
  });
}

process.stdout.write(`${JSON.stringify({ blobCount: hashes.length, matches }, null, 2)}\n`);
