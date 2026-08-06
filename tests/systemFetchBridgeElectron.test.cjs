'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('Electron session.fetch survives a response header carrying a Chinese Windows path', () => {
  const electron = require('electron');
  const fixture = path.join(__dirname, 'fixtures', 'systemFetchUnicodeResponseElectron.cjs');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = childProcess.spawnSync(electron, [fixture], {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 30_000,
    windowsHide: true,
  });

  assert.equal(result.error, undefined, result.error?.stack || result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, status: 200 });
});
