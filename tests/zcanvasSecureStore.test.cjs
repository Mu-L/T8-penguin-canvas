'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SecureStoreError,
  configuredInstances,
  runDpapi,
  storePending,
  storeSession,
} = require('../tools/zcanvas-cli/src/secureStore.cjs');

test('DPAPI retries a transient Windows secure-store failure without weakening storage', () => {
  let attempts = 0;
  const result = runDpapi('protect', 'opaque-test-value', {
    dpapiAttempts: 3,
    spawnSync() {
      attempts += 1;
      if (attempts < 3) {
        return { status: 1, stdout: '', stderr: 'transient DPAPI failure' };
      }
      return { status: 0, stdout: 'encrypted-value\n', stderr: '' };
    },
  });

  assert.equal(result, 'encrypted-value');
  assert.equal(attempts, 3);
});

test('DPAPI remains fail-closed after the bounded retry limit', () => {
  let attempts = 0;
  assert.throws(
    () => runDpapi('unprotect', 'opaque-test-value', {
      dpapiAttempts: 2,
      spawnSync() {
        attempts += 1;
        return { status: 1, stdout: '', stderr: 'permanent DPAPI failure' };
      },
    }),
    (error) => {
      assert.ok(error instanceof SecureStoreError);
      assert.equal(error.code, 'CREDENTIAL_STORE_UNAVAILABLE');
      assert.doesNotMatch(error.message, /opaque-test-value/);
      return true;
    },
  );
  assert.equal(attempts, 2);
});

test('configured auth status hides expired pending requests and sessions', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zcanvas-expired-auth-'));
  const authStore = path.join(sandbox, 'credentials-v1.json');
  const now = Date.parse('2026-07-27T08:00:00.000Z');
  const options = {
    env: { ZCANVAS_AUTH_STORE: authStore, ZCANVAS_ALLOW_FILE_CREDENTIALS: '1' },
    platform: 'linux',
  };
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const instance = {
    instanceId: 'a'.repeat(43),
    origin: 'http://127.0.0.1:18766',
  };
  storePending(instance, {
    pairingId: 'pairing-expired',
    userCode: 'ABCD2345',
    pollSecret: 'p'.repeat(43),
    expiresAt: new Date(now - 1).toISOString(),
  }, options);
  storeSession({
    instanceId: 'b'.repeat(43),
    origin: 'http://127.0.0.1:18766',
  }, {
    sessionId: 'session-expired',
    accessToken: 's'.repeat(43),
    expiresAt: new Date(now - 1).toISOString(),
  }, options);
  storePending({
    instanceId: 'c'.repeat(43),
    origin: 'http://127.0.0.1:18766',
  }, {
    pairingId: 'pairing-live',
    userCode: 'WXYZ6789',
    pollSecret: 'q'.repeat(43),
    expiresAt: new Date(now + 60_000).toISOString(),
  }, options);
  storeSession({
    instanceId: 'd'.repeat(43),
    origin: 'http://127.0.0.1:18766',
  }, {
    sessionId: 'session-live',
    accessToken: 't'.repeat(43),
    expiresAt: new Date(now + 60_000).toISOString(),
  }, options);

  const configured = configuredInstances({ ...options, now });
  assert.deepEqual(configured.pending.map((item) => item.pairingId), ['pairing-live']);
  assert.deepEqual(configured.sessions.map((item) => item.sessionId), ['session-live']);
});
