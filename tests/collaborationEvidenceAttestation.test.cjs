const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CLIENT_ATTESTATION_CONTRACT,
  DEVICE_ATTESTATION_CONTRACT,
  createChallenge,
  createClientAttestation,
  createDeviceAttestation,
  readJsonAttestation,
  runCli,
  writeJsonExclusive,
} = require('../scripts/collaboration-evidence-attestation.cjs');

const CHALLENGE = '1'.repeat(64);
const SOURCE_COMMIT = '2'.repeat(40);
const DEVICE_ID = '3'.repeat(64);
const CLIENT_ID = '4'.repeat(64);
const PROFILE_ID = '5'.repeat(64);
const SESSION_DIGEST = '6'.repeat(64);
const NOW = Date.parse('2026-07-20T03:00:00.000Z');

function deterministicRandom(...bytes) {
  const queue = bytes.map((value) => Buffer.alloc(32, value));
  return (size) => {
    assert.equal(size, 32);
    assert.ok(queue.length > 0, 'deterministic random queue exhausted');
    return queue.shift();
  };
}

function deviceFixture() {
  return createDeviceAttestation({
    challengeDigest: CHALLENGE,
    sourceCommit: SOURCE_COMMIT,
    physicalConfirmed: true,
    platform: 'win32',
    arch: 'x64',
    osBuild: '10.0.26100',
    now: NOW,
    deviceId: DEVICE_ID,
  });
}

test('attestation builders emit anonymous source-bound device and client contracts', () => {
  const challenge = createChallenge({ randomBytes: deterministicRandom(9) });
  assert.equal(challenge, '09'.repeat(32));
  const device = deviceFixture();
  assert.deepEqual(device, {
    contractVersion: DEVICE_ATTESTATION_CONTRACT,
    capturedAt: '2026-07-20T03:00:00.000Z',
    challengeDigest: CHALLENGE,
    sourceCommit: SOURCE_COMMIT,
    deviceId: DEVICE_ID,
    platform: 'win32',
    physical: true,
    arch: 'x64',
    osBuild: '10.0.26100',
  });
  const client = createClientAttestation({
    deviceAttestation: device,
    browser: 'chrome',
    sessionIdDigest: SESSION_DIGEST,
    clientId: CLIENT_ID,
    profileId: PROFILE_ID,
    now: NOW + 1000,
  });
  assert.deepEqual(client, {
    contractVersion: CLIENT_ATTESTATION_CONTRACT,
    capturedAt: '2026-07-20T03:00:01.000Z',
    challengeDigest: CHALLENGE,
    sourceCommit: SOURCE_COMMIT,
    clientId: CLIENT_ID,
    profileId: PROFILE_ID,
    sessionIdDigest: SESSION_DIGEST,
    deviceId: DEVICE_ID,
    browser: 'chrome',
  });
  const serialized = JSON.stringify({ device, client });
  assert.doesNotMatch(serialized, /hostname|username|serial|cookie|profilePath|sessionValue/i);
});

test('attestation builders fail closed on non-Windows, missing physical confirmation, and raw identities', () => {
  const base = {
    challengeDigest: CHALLENGE,
    sourceCommit: SOURCE_COMMIT,
    physicalConfirmed: true,
    platform: 'win32',
    arch: 'x64',
    osBuild: '10.0.26100',
    now: NOW,
    deviceId: DEVICE_ID,
  };
  assert.throws(() => createDeviceAttestation({ ...base, platform: 'linux' }), /must be collected on Windows/);
  assert.throws(() => createDeviceAttestation({ ...base, physicalConfirmed: false }), /confirmation is required/);
  assert.throws(() => createDeviceAttestation({ ...base, challengeDigest: 'not-a-digest' }), /SHA-256/);
  assert.throws(() => createDeviceAttestation({ ...base, sourceCommit: 'main' }), /40-character/);
  assert.throws(() => createClientAttestation({
    deviceAttestation: deviceFixture(),
    browser: 'firefox',
    sessionIdDigest: SESSION_DIGEST,
    now: NOW,
  }), /chrome, edge, or electron/);
  assert.throws(() => createClientAttestation({
    deviceAttestation: deviceFixture(),
    browser: 'chrome',
    sessionIdDigest: 'raw-cookie-value',
    now: NOW,
  }), /SHA-256/);
});

test('attestation files are bounded regular JSON and are never overwritten', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-collab-attestation-'));
  const filename = path.join(directory, 'device.json');
  try {
    const result = writeJsonExclusive(filename, deviceFixture());
    assert.ok(result.bytes > 0);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(readJsonAttestation(filename), deviceFixture());
    assert.throws(() => writeJsonExclusive(filename, deviceFixture()), /created exclusively/);
    const oversized = path.join(directory, 'oversized.json');
    fs.writeFileSync(oversized, Buffer.alloc(64 * 1024 + 1, 0x20));
    assert.throws(() => readJsonAttestation(oversized), /bounded regular file/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI creates device and client files without echoing paths or session digests', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-collab-attestation-cli-'));
  const devicePath = path.join(directory, 'device-a.json');
  const clientPath = path.join(directory, 'client-a.json');
  const deviceOutput = [];
  const clientOutput = [];
  try {
    assert.equal(runCli([
      'device',
      '--challenge', CHALLENGE,
      '--source-commit', SOURCE_COMMIT,
      '--physical-confirmed',
      '--out', devicePath,
    ], {
      stdout: { write: (value) => deviceOutput.push(value) },
      platform: 'win32',
      arch: 'x64',
      osBuild: '10.0.26100',
      now: NOW,
      randomBytes: deterministicRandom(3),
    }), 0);
    const device = readJsonAttestation(devicePath);
    assert.equal(device.deviceId, '03'.repeat(32));
    assert.equal(runCli([
      'client',
      '--device-attestation', devicePath,
      '--browser', 'edge',
      '--session-digest', SESSION_DIGEST,
      '--out', clientPath,
    ], {
      stdout: { write: (value) => clientOutput.push(value) },
      now: NOW + 1000,
      randomBytes: deterministicRandom(4, 5),
    }), 0);
    const client = readJsonAttestation(clientPath);
    assert.equal(client.clientId, '04'.repeat(32));
    assert.equal(client.profileId, '05'.repeat(32));
    assert.equal(client.sessionIdDigest, SESSION_DIGEST);
    const summary = `${deviceOutput.join('')}\n${clientOutput.join('')}`;
    assert.doesNotMatch(summary, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(summary, new RegExp(SESSION_DIGEST));
    assert.match(summary, /"outputFile":"device-a\.json"/);
    assert.match(summary, /"outputFile":"client-a\.json"/);
    assert.throws(() => runCli([
      'client', '--device-attestation', devicePath, '--browser', 'edge',
      '--session', 'raw-cookie', '--out', path.join(directory, 'forbidden.json'),
    ], { stdout: { write() {} }, now: NOW }), /option is not allowed/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
