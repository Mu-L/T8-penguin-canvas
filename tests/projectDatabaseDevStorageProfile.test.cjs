'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = 'a'.repeat(43);

function readProfile(extraEnv = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 't8pc-db-profile-'));
  const result = spawnSync(process.execPath, [
    '-e',
    "const c=require('./backend/src/config'); process.stdout.write(JSON.stringify(c.PROJECT_DB_STORAGE_POLICY_32 ?? null));",
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      T8_COLLAB_MANAGEMENT_TOKEN: TOKEN,
      T8PC_BACKEND_INSTANCE_ID: TOKEN,
      T8PC_USER_DATA: userData,
      ...extraEnv,
    },
  });
  fs.rmSync(userData, { recursive: true, force: true });
  return result;
}

test('development acceptance profile is explicit and bounded', () => {
  const result = readProfile({
    T8PC_PACKAGED: '0',
    T8PC_DEV_PROJECT_DB_STORAGE_PROFILE: 'acceptance-small-v1',
  });
  assert.equal(result.status, 0, result.stderr);
  const profile = JSON.parse(result.stdout);
  assert.equal(profile.mainMaxBytes, 64 * 1024 * 1024);
  assert.equal(profile.minimumFilesystemFreeBytes, 64 * 1024 * 1024);
  assert.equal(profile.backupCandidateReserveBytes, 80 * 1024 * 1024);
  assert.equal(profile.recoveryEvidenceReserveBytes, 96 * 1024 * 1024);
});

test('unknown development storage profile fails closed', () => {
  const result = readProfile({
    T8PC_PACKAGED: '0',
    T8PC_DEV_PROJECT_DB_STORAGE_PROFILE: 'unsafe-custom',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /仅支持 acceptance-small-v1/);
});

test('packaged config ignores the development-only storage profile', () => {
  const result = readProfile({
    T8PC_PACKAGED: '1',
    T8PC_DEV_PROJECT_DB_STORAGE_PROFILE: 'unsafe-custom',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), null);
});
