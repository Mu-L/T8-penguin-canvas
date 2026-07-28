'use strict';

const crypto = require('node:crypto');
const { RESPONSE_SCHEMA } = require('./constants.cjs');
const { readManifest } = require('./manifest.cjs');

const SENSITIVE_KEY = /(?:api.?key|authorization|cookie|password|credential|secret|signature|token)/i;
const SECRET_TEXT = /(?:\bBearer\s+[^\s,;"'`<>]+|\bsk-[A-Za-z0-9_-]{8,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b)/gi;

function redact(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[configured-state-only]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  if (typeof value === 'string') return value.replace(SECRET_TEXT, '[redacted]');
  return value;
}

function envelope(options = {}) {
  const manifest = readManifest();
  return redact({
    schema: RESPONSE_SCHEMA,
    ok: options.ok !== false,
    code: options.code || 'OK',
    message: options.message || '',
    requestId: options.requestId || crypto.randomUUID(),
    timestamp: options.timestamp || new Date().toISOString(),
    cliVersion: manifest.cliVersion,
    data: options.data || {},
    warnings: Array.isArray(options.warnings) ? options.warnings : [],
    nextActions: Array.isArray(options.nextActions) ? options.nextActions : [],
  });
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeHuman(lines) {
  process.stdout.write(`${Array.isArray(lines) ? lines.join('\n') : String(lines)}\n`);
}

module.exports = { envelope, redact, writeHuman, writeJson };
