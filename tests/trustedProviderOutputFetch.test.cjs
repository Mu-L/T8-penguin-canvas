'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');

const {
  safeRemoteMediaFetch,
  safeRemoteMediaDownload,
  safeRemoteJsonFetch,
} = require('../backend/src/utils/safeRemoteMediaFetch');

const SYSTEM_FETCH_BRIDGE_MARKER = Symbol.for('t8-penguin-canvas.system-fetch-bridge.v1');

async function listen(handler) {
  const server = http.createServer(handler);
  server.on('connection', (socket) => socket.on('error', () => {}));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function publicLookup() {
  return [{ address: '93.184.216.34', family: 4 }];
}

function loopbackLookup() {
  return [{ address: '127.0.0.1', family: 4 }];
}

function allowLocalTestHost(hostname) {
  return hostname === 'pinned.test' || hostname === 'fallback.test';
}

function systemFetchBridge(fetchImpl, resolveHost = null) {
  Object.defineProperty(fetchImpl, SYSTEM_FETCH_BRIDGE_MARKER, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      nodeFetch: async () => {
        throw new Error('trusted Provider fallback must use the DNS-pinned transport');
      },
      resolveHost,
    }),
    writable: false,
  });
  return fetchImpl;
}

async function withGlobalFetch(fetchImpl, callback) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    enumerable: originalDescriptor?.enumerable ?? true,
    value: fetchImpl,
    writable: true,
  });
  try {
    return await callback();
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, 'fetch', originalDescriptor);
    else delete globalThis.fetch;
  }
}

test('trusted Provider output prefers the marked system-fetch bridge', { concurrency: false }, async () => {
  const bridgeCalls = [];
  const bridge = systemFetchBridge(async (input, init) => {
    bridgeCalls.push({ input: String(input), init });
    return new Response(Buffer.from('bridge-result'), {
      status: 200,
      headers: {
        'content-length': '13',
        'content-type': 'image/png',
      },
    });
  });

  await withGlobalFetch(bridge, async () => {
    const result = await safeRemoteMediaFetch('https://provider-output.test/result.png', {
      trustedProviderOutput: true,
      lookupImpl: publicLookup,
      timeoutMs: 2_000,
    });

    assert.equal(bridgeCalls.length, 1);
    assert.equal(bridgeCalls[0].input, 'https://provider-output.test/result.png');
    assert.equal(result.buffer.toString(), 'bridge-result');
    assert.equal(result.contentType, 'image/png');
    assert.equal(result.finalUrl, 'https://provider-output.test/result.png');
    assert.equal(result.status, 200);
  });
});

test('trusted Provider status JSON uses the marked system-fetch bridge', { concurrency: false }, async () => {
  let bridgeCalls = 0;
  const bridge = systemFetchBridge(async () => {
    bridgeCalls += 1;
    return new Response(Buffer.from('{"status":"completed"}'), {
      status: 200,
      headers: {
        'content-length': '22',
        'content-type': 'application/json',
      },
    });
  });

  await withGlobalFetch(bridge, async () => {
    const result = await safeRemoteJsonFetch('https://provider-output.test/status', {
      trustedProviderOutput: true,
      lookupImpl: publicLookup,
      timeoutMs: 2_000,
    });
    assert.deepEqual(result.data, { status: 'completed' });
    assert.equal(result.status, 200);
    assert.equal(result.ok, true);
  });
  assert.equal(bridgeCalls, 1);
});

test('trusted Provider output ignores VPN-altered Content-Length and bounds actual bytes', { concurrency: false }, async () => {
  const body = Buffer.from('vpn-decoded-result');
  const bridge = systemFetchBridge(async () => new Response(body, {
    status: 200,
    headers: {
      'content-length': '1183525',
      'content-type': 'image/png',
    },
  }));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-content-length-drift-'));
  const targetPath = path.join(tmpDir, 'provider-result.png');

  try {
    await withGlobalFetch(bridge, async () => {
      const fetched = await safeRemoteMediaFetch('https://provider-output.test/result.png', {
        trustedProviderOutput: true,
        lookupImpl: publicLookup,
        maxBytes: 64,
        timeoutMs: 2_000,
      });
      assert.deepEqual(fetched.buffer, body);

      const downloaded = await safeRemoteMediaDownload(
        'https://provider-output.test/result.png',
        targetPath,
        {
          trustedProviderOutput: true,
          lookupImpl: publicLookup,
          maxBytes: 64,
          timeoutMs: 2_000,
        },
      );
      assert.equal(downloaded.byteSize, body.length);
      assert.deepEqual(fs.readFileSync(targetPath), body);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const oversizedBridge = systemFetchBridge(async () => new Response(Buffer.alloc(9, 0x5a), {
    status: 200,
    headers: {
      'content-length': '1',
      'content-type': 'application/octet-stream',
    },
  }));
  await withGlobalFetch(oversizedBridge, async () => {
    await assert.rejects(
      safeRemoteMediaFetch('https://provider-output.test/oversized.bin', {
        trustedProviderOutput: true,
        lookupImpl: publicLookup,
        maxBytes: 8,
        timeoutMs: 2_000,
      }),
      (error) => error?.code === 'item_too_large',
    );
  });
});

test('ordinary user URLs stay on the DNS-pinned transport', { concurrency: false }, async () => {
  let bridgeCalls = 0;
  let serverCalls = 0;
  let lookupCalls = 0;
  const bridge = systemFetchBridge(async () => {
    bridgeCalls += 1;
    throw new Error('ordinary URLs must not use the system-fetch bridge');
  });
  const server = await listen((request, response) => {
    serverCalls += 1;
    response.writeHead(200, {
      'content-length': '13',
      'content-type': 'text/plain',
    });
    response.end('pinned-result');
  });

  try {
    const port = server.address().port;
    await withGlobalFetch(bridge, async () => {
      const result = await safeRemoteMediaFetch(`http://pinned.test:${port}/asset`, {
        allowPrivateForTests: allowLocalTestHost,
        lookupImpl: async () => {
          lookupCalls += 1;
          return loopbackLookup();
        },
        timeoutMs: 2_000,
      });

      assert.equal(result.buffer.toString(), 'pinned-result');
    });
    assert.equal(bridgeCalls, 0);
    assert.equal(serverCalls, 1);
    assert.ok(lookupCalls >= 1);
  } finally {
    await closeServer(server);
  }
});

test('trusted Provider bridge strips sensitive headers after a cross-origin redirect', { concurrency: false }, async () => {
  const calls = [];
  const bridge = systemFetchBridge(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init.headers || {}) });
    if (url === 'https://provider-output.test/start') {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://provider-cdn.test/final' },
      });
    }
    if (url === 'https://provider-cdn.test/final') {
      return new Response(Buffer.from('redirected'), {
        status: 200,
        headers: {
          'content-length': '10',
          'content-type': 'image/webp',
        },
      });
    }
    throw new Error(`unexpected bridge URL: ${url}`);
  });

  await withGlobalFetch(bridge, async () => {
    const result = await safeRemoteMediaFetch('https://provider-output.test/start', {
      trustedProviderOutput: true,
      lookupImpl: publicLookup,
      headers: {
        authorization: 'Bearer provider-secret',
        cookie: 'provider=session',
        'proxy-authorization': 'Basic cHJveHk6c2VjcmV0',
        'x-api-key': 'provider-api-secret',
        'x-t8-safe': 'keep-across-origin',
      },
      timeoutMs: 2_000,
    });

    assert.equal(result.buffer.toString(), 'redirected');
    assert.equal(result.finalUrl, 'https://provider-cdn.test/final');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.get('authorization'), 'Bearer provider-secret');
    assert.equal(calls[0].headers.get('cookie'), 'provider=session');
    assert.equal(calls[1].headers.get('authorization'), null);
    assert.equal(calls[1].headers.get('cookie'), null);
    assert.equal(calls[1].headers.get('proxy-authorization'), null);
    assert.equal(calls[1].headers.get('x-api-key'), null);
    assert.equal(calls[1].headers.get('x-t8-safe'), 'keep-across-origin');
  });
});

test('trusted Provider bridge enforces the configured response size limit', { concurrency: false }, async () => {
  const bridge = systemFetchBridge(async () => new Response(Buffer.from('too-large'), {
    status: 200,
    headers: {
      'content-length': '9',
      'content-type': 'application/octet-stream',
    },
  }));

  await withGlobalFetch(bridge, async () => {
    await assert.rejects(
      safeRemoteMediaFetch('https://provider-output.test/large.bin', {
        trustedProviderOutput: true,
        lookupImpl: publicLookup,
        maxBytes: 4,
        timeoutMs: 2_000,
      }),
      (error) => error?.code === 'item_too_large',
    );
  });
});

test('trusted Provider bridge network failure falls back to the DNS-pinned transport', { concurrency: false }, async () => {
  let bridgeCalls = 0;
  let serverCalls = 0;
  const bridge = systemFetchBridge(async () => {
    bridgeCalls += 1;
    const error = new TypeError('fetch failed');
    error.cause = Object.assign(new Error('connect timed out'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    throw error;
  });
  const server = await listen((request, response) => {
    serverCalls += 1;
    response.writeHead(200, {
      'content-length': '15',
      'content-type': 'video/mp4',
    });
    response.end('fallback-result');
  });

  try {
    const port = server.address().port;
    await withGlobalFetch(bridge, async () => {
      const result = await safeRemoteMediaFetch(`http://fallback.test:${port}/provider-result`, {
        trustedProviderOutput: true,
        allowPrivateForTests: allowLocalTestHost,
        lookupImpl: loopbackLookup,
        timeoutMs: 2_000,
      });

      assert.equal(result.buffer.toString(), 'fallback-result');
      assert.equal(result.contentType, 'video/mp4');
    });
    assert.equal(bridgeCalls, 1);
    assert.equal(serverCalls, 1);
  } finally {
    await closeServer(server);
  }
});

test('trusted Provider output allows proxy-side DNS when Chromium resolution is unavailable', { concurrency: false }, async () => {
  let bridgeCalls = 0;
  const bridge = systemFetchBridge(async () => {
    bridgeCalls += 1;
    return new Response(Buffer.from('proxy-resolved'), {
      status: 200,
      headers: { 'content-length': '14', 'content-type': 'image/png' },
    });
  }, async () => {
    const error = new Error('local resolver intentionally unavailable');
    error.code = 'ERR_NAME_NOT_RESOLVED';
    throw error;
  });

  await withGlobalFetch(bridge, async () => {
    const result = await safeRemoteMediaFetch('https://provider-output.test/proxy.png', {
      trustedProviderOutput: true,
      timeoutMs: 2_000,
    });
    assert.equal(result.buffer.toString(), 'proxy-resolved');
  });
  assert.equal(bridgeCalls, 1);
});

test('trusted Provider output rejects Chromium targets resolving to loopback', { concurrency: false }, async () => {
  let bridgeCalls = 0;
  const bridge = systemFetchBridge(async () => {
    bridgeCalls += 1;
    throw new Error('blocked targets must never reach Chromium fetch');
  }, async () => ({
    endpoints: [{ address: '127.0.0.1', family: 'ipv4' }],
  }));

  await withGlobalFetch(bridge, async () => {
    await assert.rejects(
      safeRemoteMediaFetch('https://provider-output.test/private.png', {
        trustedProviderOutput: true,
        timeoutMs: 2_000,
      }),
      (error) => error?.code === 'private_address',
    );
  });
  assert.equal(bridgeCalls, 0);
});

test('trusted Provider output accepts the RFC 2544 range used by TUN Fake-IP', { concurrency: false }, async () => {
  let bridgeCalls = 0;
  const bridge = systemFetchBridge(async () => {
    bridgeCalls += 1;
    return new Response(Buffer.from('fake-ip-ok'), {
      status: 200,
      headers: { 'content-length': '10', 'content-type': 'image/webp' },
    });
  }, async () => ({
    endpoints: [{ address: '198.18.12.34', family: 'ipv4' }],
  }));

  await withGlobalFetch(bridge, async () => {
    const result = await safeRemoteMediaFetch('https://provider-output.test/fake-ip.webp', {
      trustedProviderOutput: true,
      timeoutMs: 2_000,
    });
    assert.equal(result.buffer.toString(), 'fake-ip-ok');
  });
  assert.equal(bridgeCalls, 1);
});

test('IPv4-mapped and standard NAT64 public endpoints preserve the IPv4 safety policy', async () => {
  const publicMapped = '::ffff:8.8.8.8';
  const publicNat64 = '64:ff9b::808:808';
  const privateMapped = '::ffff:127.0.0.1';
  const privateNat64 = '64:ff9b::7f00:1';
  const fakeNat64 = '64:ff9b::c612:2234';
  const {
    isPrivateAddress,
    isTunFakeAddress,
  } = require('../backend/src/utils/safeRemoteMediaFetch');

  assert.equal(isPrivateAddress(publicMapped), false);
  assert.equal(isPrivateAddress(publicNat64), false);
  assert.equal(isPrivateAddress(privateMapped), true);
  assert.equal(isPrivateAddress(privateNat64), true);
  assert.equal(isTunFakeAddress(fakeNat64), true);
});

test('trusted streaming download discards partial system data before pinned fallback', { concurrency: false }, async () => {
  let bridgeCalls = 0;
  let serverCalls = 0;
  let pullCount = 0;
  const bridge = systemFetchBridge(async () => {
    bridgeCalls += 1;
    return new Response(new ReadableStream({
      pull(controller) {
        if (pullCount++ === 0) {
          controller.enqueue(new TextEncoder().encode('partial-system-data'));
          return;
        }
        const error = new TypeError('system stream failed');
        error.cause = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        controller.error(error);
      },
    }), {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    });
  });
  const server = await listen((request, response) => {
    serverCalls += 1;
    response.writeHead(200, {
      'content-length': '15',
      'content-type': 'video/mp4',
    });
    response.end('fallback-result');
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-trusted-download-'));
  const targetPath = path.join(tmpDir, 'provider-result.mp4');

  try {
    const port = server.address().port;
    await withGlobalFetch(bridge, async () => {
      const result = await safeRemoteMediaDownload(
        `http://fallback.test:${port}/provider-result`,
        targetPath,
        {
          trustedProviderOutput: true,
          allowPrivateForTests: allowLocalTestHost,
          lookupImpl: loopbackLookup,
          timeoutMs: 2_000,
        },
      );
      assert.equal(result.byteSize, 15);
      assert.equal(result.contentType, 'video/mp4');
    });
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'fallback-result');
    assert.equal(bridgeCalls, 1);
    assert.equal(serverCalls, 1);
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
