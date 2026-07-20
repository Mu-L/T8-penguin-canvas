#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEVICE_ATTESTATION_CONTRACT = 't8-collaboration-device-attestation-v1';
const CLIENT_ATTESTATION_CONTRACT = 't8-collaboration-client-attestation-v1';
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const MAX_ATTESTATION_BYTES = 64 * 1024;
const MAX_DEVICE_ATTESTATION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function attestationError(message) {
  const error = new Error(message);
  error.code = 'collaboration_evidence_attestation_invalid';
  return error;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) {
    throw attestationError(`${label} must be an object`);
  }
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw attestationError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertCommit(value) {
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) {
    throw attestationError('source commit must be a lowercase 40-character Git SHA');
  }
  return value;
}

function exactTimestamp(now, label = 'capture time') {
  const value = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(value) || value < 0) throw attestationError(`${label} is invalid`);
  return new Date(value).toISOString();
}

function randomDigest(randomBytes = crypto.randomBytes) {
  const value = randomBytes(32);
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw attestationError('secure random source did not return 32 bytes');
  }
  return value.toString('hex');
}

function createChallenge(options = {}) {
  return randomDigest(options.randomBytes);
}

function createDeviceAttestation(options = {}) {
  const platform = String(options.platform || process.platform).toLowerCase();
  const arch = String(options.arch || process.arch).toLowerCase();
  const osBuild = String(options.osBuild || os.release());
  if (platform !== 'win32') {
    throw attestationError('device attestation must be collected on Windows');
  }
  if (options.physicalConfirmed !== true) {
    throw attestationError('physical Windows device confirmation is required');
  }
  if (!['x64', 'arm64'].includes(arch)
    || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(osBuild)) {
    throw attestationError('Windows architecture or build is unsupported');
  }
  return Object.freeze({
    contractVersion: DEVICE_ATTESTATION_CONTRACT,
    capturedAt: exactTimestamp(options.now ?? Date.now()),
    challengeDigest: assertDigest(options.challengeDigest, 'challenge'),
    sourceCommit: assertCommit(options.sourceCommit),
    deviceId: options.deviceId
      ? assertDigest(options.deviceId, 'device id')
      : randomDigest(options.randomBytes),
    platform,
    physical: true,
    arch,
    osBuild,
  });
}

function readJsonAttestation(filename) {
  let stat;
  try {
    stat = fs.lstatSync(path.resolve(String(filename || '')));
  } catch (_) {
    throw attestationError('attestation input is missing or unreadable');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
    || stat.size > MAX_ATTESTATION_BYTES) {
    throw attestationError('attestation input must be a bounded regular file');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(String(filename)), 'utf8'));
  } catch (_) {
    throw attestationError('attestation input is not valid UTF-8 JSON');
  }
  return assertPlainObject(parsed, 'attestation input');
}

function validateDeviceAttestation(value, now = Date.now()) {
  const device = assertPlainObject(value, 'device attestation');
  if (device.contractVersion !== DEVICE_ATTESTATION_CONTRACT
    || device.platform !== 'win32'
    || device.physical !== true
    || !['x64', 'arm64'].includes(device.arch)
    || typeof device.osBuild !== 'string'
    || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(device.osBuild)) {
    throw attestationError('device attestation contract is invalid');
  }
  assertDigest(device.challengeDigest, 'device challenge');
  assertDigest(device.deviceId, 'device id');
  assertCommit(device.sourceCommit);
  const capturedAt = Date.parse(device.capturedAt);
  const current = Number(now);
  if (!Number.isFinite(capturedAt)
    || new Date(capturedAt).toISOString() !== device.capturedAt
    || !Number.isFinite(current)
    || capturedAt > current + 5 * 60 * 1000
    || current - capturedAt > MAX_DEVICE_ATTESTATION_AGE_MS) {
    throw attestationError('device attestation timestamp is outside the evidence window');
  }
  return device;
}

function createClientAttestation(options = {}) {
  const now = Number(options.now ?? Date.now());
  const device = validateDeviceAttestation(options.deviceAttestation, now);
  const browser = String(options.browser || '').toLowerCase();
  if (!['chrome', 'edge', 'electron'].includes(browser)) {
    throw attestationError('client browser must be chrome, edge, or electron');
  }
  return Object.freeze({
    contractVersion: CLIENT_ATTESTATION_CONTRACT,
    capturedAt: exactTimestamp(now),
    challengeDigest: device.challengeDigest,
    sourceCommit: device.sourceCommit,
    clientId: options.clientId
      ? assertDigest(options.clientId, 'client id')
      : randomDigest(options.randomBytes),
    profileId: options.profileId
      ? assertDigest(options.profileId, 'profile id')
      : randomDigest(options.randomBytes),
    sessionIdDigest: assertDigest(options.sessionIdDigest, 'session id'),
    deviceId: device.deviceId,
    browser,
  });
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeJsonExclusive(filename, value) {
  const output = path.resolve(String(filename || ''));
  const parent = path.dirname(output);
  let parentStat;
  try {
    parentStat = fs.lstatSync(parent);
  } catch (_) {
    throw attestationError('attestation output parent is missing or unreadable');
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw attestationError('attestation output parent must be a regular directory');
  }
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (body.length <= 0 || body.length > MAX_ATTESTATION_BYTES) {
    throw attestationError('attestation output exceeds the size bound');
  }
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(output, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
  } catch (_) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) { /* best effort */ }
      descriptor = undefined;
    }
    if (created) {
      try { fs.unlinkSync(output); } catch (_) { /* verifier rejects any partial file */ }
    }
    throw attestationError('attestation output could not be created exclusively');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return Object.freeze({ bytes: body.length, sha256: sha256Buffer(body) });
}

function parseCommand(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!['challenge', 'device', 'client', 'help', '--help', '-h'].includes(command)) {
    throw attestationError('command must be challenge, device, or client');
  }
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag.startsWith('--') || flags.has(flag)) {
      throw attestationError('attestation option is unknown or duplicated');
    }
    if (flag === '--physical-confirmed') {
      flags.set(flag, true);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw attestationError('attestation option value is missing');
    flags.set(flag, value);
    index += 1;
  }
  return { command, flags };
}

function requireOnly(flags, allowed) {
  for (const flag of flags.keys()) {
    if (!allowed.has(flag)) throw attestationError('attestation option is not allowed for this command');
  }
}

function requireFlag(flags, name) {
  if (!flags.has(name)) throw attestationError('required attestation option is missing');
  return flags.get(name);
}

function usage() {
  return [
    'Usage:',
    '  node scripts/collaboration-evidence-attestation.cjs challenge',
    '  node scripts/collaboration-evidence-attestation.cjs device --challenge <sha256> --source-commit <git-sha> --physical-confirmed --out <file>',
    '  node scripts/collaboration-evidence-attestation.cjs client --device-attestation <file> --browser <chrome|edge|electron> --session-digest <sha256> --out <file>',
    '',
    'The tool never accepts a raw session, cookie, profile path, machine name, or hardware serial.',
    'Output files are created exclusively and are never overwritten.',
  ].join('\n');
}

function runCli(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout || process.stdout;
  const parsed = parseCommand(argv);
  if (['help', '--help', '-h'].includes(parsed.command)) {
    requireOnly(parsed.flags, new Set());
    stdout.write(`${usage()}\n`);
    return 0;
  }
  if (parsed.command === 'challenge') {
    requireOnly(parsed.flags, new Set());
    stdout.write(`${JSON.stringify({ challengeDigest: createChallenge(options) })}\n`);
    return 0;
  }
  if (parsed.command === 'device') {
    requireOnly(parsed.flags, new Set([
      '--challenge', '--source-commit', '--physical-confirmed', '--out',
    ]));
    const attestation = createDeviceAttestation({
      challengeDigest: requireFlag(parsed.flags, '--challenge'),
      sourceCommit: requireFlag(parsed.flags, '--source-commit'),
      physicalConfirmed: parsed.flags.get('--physical-confirmed') === true,
      platform: options.platform,
      arch: options.arch,
      osBuild: options.osBuild,
      now: options.now,
      randomBytes: options.randomBytes,
    });
    const output = requireFlag(parsed.flags, '--out');
    const written = writeJsonExclusive(output, attestation);
    stdout.write(`${JSON.stringify({
      ok: true,
      kind: 'device',
      outputFile: path.basename(path.resolve(output)),
      deviceId: attestation.deviceId,
      ...written,
    })}\n`);
    return 0;
  }
  requireOnly(parsed.flags, new Set([
    '--device-attestation', '--browser', '--session-digest', '--out',
  ]));
  const device = readJsonAttestation(requireFlag(parsed.flags, '--device-attestation'));
  const attestation = createClientAttestation({
    deviceAttestation: device,
    browser: requireFlag(parsed.flags, '--browser'),
    sessionIdDigest: requireFlag(parsed.flags, '--session-digest'),
    now: options.now,
    randomBytes: options.randomBytes,
  });
  const output = requireFlag(parsed.flags, '--out');
  const written = writeJsonExclusive(output, attestation);
  stdout.write(`${JSON.stringify({
    ok: true,
    kind: 'client',
    outputFile: path.basename(path.resolve(output)),
    clientId: attestation.clientId,
    profileId: attestation.profileId,
    ...written,
  })}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    process.stderr.write(`[collaboration-evidence-attestation] ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CLIENT_ATTESTATION_CONTRACT,
  DEVICE_ATTESTATION_CONTRACT,
  createChallenge,
  createClientAttestation,
  createDeviceAttestation,
  readJsonAttestation,
  runCli,
  usage,
  validateDeviceAttestation,
  writeJsonExclusive,
};
