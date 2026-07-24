'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  isLoopbackAddress,
  isPrivateAddress,
  isTunFakeAddress,
  resolvePublicAddress,
  resolveTunPublicDns,
  safeRemoteMediaDownload,
  safeRemoteMediaFetch,
  safeRemoteJsonFetch,
  safeRemoteUpload,
} = require('../backend/src/utils/safeRemoteMediaFetch');

async function listen(handler) {
  const server = http.createServer(handler);
  // Aborted oversize/timeout downloads intentionally reset their test socket.
  // Electron-as-Node can surface the peer's late EPIPE on the server socket.
  server.on('connection', (socket) => socket.on('error', () => {}));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function closeServer(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function allowOnlyLoopbackTestHost(hostname) {
  return hostname === '127.0.0.1';
}

const SENSITIVE_REQUEST_HEADERS = Object.freeze({
  authorization: 'Bearer must-not-cross-origin',
  'proxy-authorization': 'Basic cHJveHk6c2VjcmV0',
  cookie: 'private=cookie',
  'set-cookie': 'server-secret=cookie',
  'x-api-key': 'x-api-secret',
  'x-auth-token': 'x-auth-secret',
  'api-key': 'api-secret',
  'x-goog-api-key': 'google-secret',
});

function captureRedirectHeaders(req) {
  return {
    path: req.url,
    sensitive: Object.fromEntries(
      Object.keys(SENSITIVE_REQUEST_HEADERS).map((name) => {
        const value = req.headers[name];
        return [name, Array.isArray(value) ? value.join(', ') : value];
      }),
    ),
    safeHeader: req.headers['x-t8-test'],
  };
}

test('non-public address classifier only permits ordinary globally-routable unicast', () => {
  const blocked = [
    '0.0.0.0',
    '0.255.255.255',
    '10.4.5.6',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '169.254.20.30',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.9',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.254',
    '198.51.100.4',
    '203.0.113.9',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:8.8.8.8',
    '::ffff:7f00:1',
    '64:ff9b::808:808',
    '100::1',
    '2001::1',
    '2001:2::1',
    '2001:db8::1',
    '2002:0808:0808::1',
    '3fff::1',
    'fc00::1',
    'fdff::1',
    'fe80::1',
    'febf::1',
    'fec0::1',
    'feff::1',
    'ff02::1',
  ];
  for (const address of blocked) {
    assert.equal(isPrivateAddress(address), true, `${address} must fail closed`);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2001:4860:4860::8888', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, `${address} should be globally routable`);
  }
  assert.equal(isLoopbackAddress('127.200.1.2'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:8.8.8.8'), false);
  assert.equal(isTunFakeAddress('198.18.0.1'), true);
  assert.equal(isTunFakeAddress('198.19.255.254'), true);
  assert.equal(isTunFakeAddress('192.168.1.1'), false);
});

test('DNS resolution fails closed when any answer is invalid or non-public', async () => {
  await assert.rejects(
    resolvePublicAddress('mixed.example', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '100.64.0.10', family: 4 },
    ]),
    (error) => error?.code === 'private_address',
  );
  await assert.rejects(
    resolvePublicAddress('mapped.example', async () => [
      { address: '::ffff:8.8.8.8', family: 6 },
    ]),
    (error) => error?.code === 'private_address',
  );
  const pinned = await resolvePublicAddress('public.example', async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '2001:4860:4860::8888', family: 6 },
  ]);
  assert.deepEqual(pinned, { address: '93.184.216.34', family: 4 });
});

test('TUN Fake-IP is re-resolved through independent public DNS without allowing arbitrary private addresses', async () => {
  let publicLookups = 0;
  const resolved = await resolvePublicAddress(
    'cdn.example',
    async () => [{ address: '198.18.12.34', family: 4 }],
    false,
    async () => {
      publicLookups += 1;
      return [{ address: '93.184.216.34', family: 4 }];
    },
  );
  assert.deepEqual(resolved, { address: '93.184.216.34', family: 4 });
  assert.equal(publicLookups, 1);

  const mixedTunAnswer = await resolvePublicAddress(
    'mixed-tun.example',
    async () => [
      { address: '198.18.12.35', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ],
    false,
    async () => [{ address: '1.1.1.1', family: 4 }],
  );
  assert.deepEqual(mixedTunAnswer, { address: '1.1.1.1', family: 4 });

  await assert.rejects(
    resolvePublicAddress(
      'private.example',
      async () => [{ address: '192.168.1.20', family: 4 }],
      false,
      async () => {
        publicLookups += 1;
        return [{ address: '93.184.216.34', family: 4 }];
      },
    ),
    (error) => error?.code === 'private_address',
  );
  assert.equal(publicLookups, 1, 'ordinary private addresses must never invoke the TUN fallback');

  const recoveredAfterDnsFailure = await resolvePublicAddress(
    'after-tun.example',
    async () => {
      throw Object.assign(new Error('temporary DNS failure'), { code: 'EAI_AGAIN' });
    },
    false,
    async () => [{ address: '1.1.1.1', family: 4 }],
  );
  assert.deepEqual(recoveredAfterDnsFailure, { address: '1.1.1.1', family: 4 });
});

test('TUN public resolution falls back to encrypted DNS when UDP DNS is intercepted with Fake-IP', async () => {
  let udpAttempts = 0;
  let dohAttempts = 0;
  const resolved = await resolveTunPublicDns('cdn.example', {
    dnsServers: ['1.1.1.1'],
    dohEndpoints: [{ address: '1.1.1.1', servername: 'cloudflare-dns.com' }],
    resolveFromServer: async () => {
      udpAttempts += 1;
      return [{ address: '198.18.20.30', family: 4 }];
    },
    resolveFromDoh: async () => {
      dohAttempts += 1;
      return [{ address: '93.184.216.34', family: 4 }];
    },
  });
  assert.deepEqual(resolved, [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(udpAttempts, 1);
  assert.equal(dohAttempts, 1);

  await assert.rejects(
    resolveTunPublicDns('private.example', {
      dnsServers: [],
      dohEndpoints: [{ address: '8.8.8.8', servername: 'dns.google' }],
      resolveFromDoh: async () => [{ address: '192.168.1.9', family: 4 }],
    }),
    (error) => error?.code === 'tun_dns_fallback_failed',
  );
});

test('URL credentials and caller protocol restrictions are enforced before I/O', async () => {
  await assert.rejects(
    safeRemoteMediaFetch('https://user:secret@example.com/file'),
    (error) => error?.code === 'url_credentials_forbidden',
  );
  await assert.rejects(
    safeRemoteMediaFetch('http://example.com/file', { protocols: ['https:'] }),
    (error) => error?.code === 'invalid_protocol',
  );
  await assert.rejects(
    safeRemoteMediaFetch('ftp://example.com/file', { protocols: ['ftp:'] }),
    (error) => error?.code === 'invalid_protocol',
  );
});

test('known Content-Length is collected into one exact buffer and truncated bodies fail closed', async (t) => {
  const body = Buffer.alloc(512 * 1024, 0x5a);
  const server = await listen((req, res) => {
    if (req.url === '/exact') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
      });
      res.end(body);
      return;
    }
    if (req.url === '/truncated') {
      res.shouldKeepAlive = false;
      res.writeHead(200, {
        Connection: 'close',
        'Content-Type': 'application/octet-stream',
        'Content-Length': '12',
      });
      res.end('short');
      return;
    }
    if (req.url === '/known-slow') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '2',
      });
      res.write('x');
      const timer = setTimeout(() => { if (!res.destroyed) res.end('y'); }, 1_000);
      res.once('close', () => clearTimeout(timer));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(() => closeServer(server));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const common = {
    allowPrivateForTests: allowOnlyLoopbackTestHost,
    protocols: ['http:'],
    maxBytes: body.length,
    deadlineMs: 2_000,
    idleTimeoutMs: 500,
  };

  const originalConcat = Buffer.concat;
  let concatCalls = 0;
  Buffer.concat = function trackedConcat(...args) {
    concatCalls += 1;
    return originalConcat.apply(this, args);
  };
  let fetched;
  try {
    fetched = await safeRemoteMediaFetch(`${baseUrl}/exact`, common);
  } finally {
    Buffer.concat = originalConcat;
  }
  assert.deepEqual(fetched.buffer, body);
  assert.equal(concatCalls, 0, 'known-length response must not retain chunks then concatenate a second buffer');

  await assert.rejects(
    safeRemoteMediaFetch(`${baseUrl}/truncated`, common),
    (error) => error?.code === 'content_length_mismatch'
      && error?.expectedBytes === 12
      && error?.receivedBytes === 5,
  );
  await assert.rejects(
    safeRemoteMediaFetch(`${baseUrl}/known-slow`, { ...common, idleTimeoutMs: 40 }),
    (error) => error?.code === 'fetch_timeout' && error?.timeoutKind === 'idle',
  );
});

test('safe streaming download is exclusive, bounded, deadline-aware and removes partial files', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-safe-remote-download-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const activeIntervals = new Set();
  const server = await listen((req, res) => {
    if (req.url === '/ok') {
      const body = Buffer.from('hello-stream');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) });
      res.end(body);
      return;
    }
    if (req.url === '/redirect-cgnat') {
      res.writeHead(302, { Location: 'http://100.64.0.50/internal' });
      res.end();
      return;
    }
    if (req.url === '/oversize-length') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '64' });
      res.end(Buffer.alloc(64, 1));
      return;
    }
    if (req.url === '/oversize-chunked') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' });
      res.write(Buffer.alloc(7, 1));
      res.end(Buffer.alloc(7, 2));
      return;
    }
    if (req.url === '/truncated-length') {
      res.shouldKeepAlive = false;
      res.writeHead(200, {
        Connection: 'close',
        'Content-Type': 'application/octet-stream',
        'Content-Length': '12',
      });
      res.end('short');
      return;
    }
    if (req.url === '/slow-drip') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' });
      let finishTimer;
      const timer = setInterval(() => {
        if (!res.destroyed) res.write(Buffer.from('x'));
      }, 35);
      activeIntervals.add(timer);
      const cleanup = () => {
        clearInterval(timer);
        if (finishTimer) clearTimeout(finishTimer);
        activeIntervals.delete(timer);
      };
      res.once('close', cleanup);
      finishTimer = setTimeout(() => {
        cleanup();
        if (!res.destroyed) res.end();
      }, 2_000);
      finishTimer.unref();
      return;
    }
    if (req.url === '/idle') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' });
      res.write(Buffer.from('x'));
      const timer = setTimeout(() => { if (!res.destroyed) res.end(Buffer.from('y')); }, 1_000);
      res.once('close', () => clearTimeout(timer));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(async () => {
    for (const timer of activeIntervals) clearInterval(timer);
    await closeServer(server);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const common = {
    allowPrivateForTests: allowOnlyLoopbackTestHost,
    protocols: ['http:'],
    deadlineMs: 2_000,
    idleTimeoutMs: 500,
  };

  const completedPath = path.join(tmpDir, 'completed.bin');
  const completed = await safeRemoteMediaDownload(`${baseUrl}/ok`, completedPath, {
    ...common,
    maxBytes: 32,
  });
  assert.deepEqual(completed, {
    contentType: 'application/octet-stream',
    finalUrl: `${baseUrl}/ok`,
    status: 200,
    byteSize: 12,
  });
  assert.equal(fs.readFileSync(completedPath, 'utf8'), 'hello-stream');

  const existingPath = path.join(tmpDir, 'existing.bin');
  fs.writeFileSync(existingPath, 'do-not-replace');
  await assert.rejects(
    safeRemoteMediaDownload(`${baseUrl}/ok`, existingPath, common),
    (error) => error?.code === 'download_target_exists',
  );
  assert.equal(fs.readFileSync(existingPath, 'utf8'), 'do-not-replace');

  const symlinkSource = path.join(tmpDir, 'symlink-source.bin');
  const symlinkTarget = path.join(tmpDir, 'symlink-target.bin');
  fs.writeFileSync(symlinkSource, 'symlink-source');
  fs.symlinkSync(symlinkSource, symlinkTarget, 'file');
  await assert.rejects(
    safeRemoteMediaDownload(`${baseUrl}/ok`, symlinkTarget, common),
    (error) => error?.code === 'download_target_exists',
  );
  assert.equal(fs.readFileSync(symlinkSource, 'utf8'), 'symlink-source');

  const redirectPath = path.join(tmpDir, 'redirect.bin');
  await assert.rejects(
    safeRemoteMediaDownload(`${baseUrl}/redirect-cgnat`, redirectPath, common),
    (error) => error?.code === 'private_address',
  );
  assert.equal(fs.existsSync(redirectPath), false);

  for (const [route, name] of [['/oversize-length', 'length'], ['/oversize-chunked', 'chunked']]) {
    const targetPath = path.join(tmpDir, `oversize-${name}.bin`);
    await assert.rejects(
      safeRemoteMediaDownload(`${baseUrl}${route}`, targetPath, { ...common, maxBytes: 8 }),
      (error) => error?.code === 'item_too_large',
    );
    assert.equal(fs.existsSync(targetPath), false, `${name} partial must be removed`);
  }

  const truncatedPath = path.join(tmpDir, 'truncated.bin');
  await assert.rejects(
    safeRemoteMediaDownload(`${baseUrl}/truncated-length`, truncatedPath, common),
    (error) => error?.code === 'content_length_mismatch'
      && error?.expectedBytes === 12
      && error?.receivedBytes === 5,
  );
  assert.equal(fs.existsSync(truncatedPath), false, 'truncated partial must be removed');

  const slowPath = path.join(tmpDir, 'slow.bin');
  const slowStartedAt = Date.now();
  await assert.rejects(
    safeRemoteMediaDownload(`${baseUrl}/slow-drip`, slowPath, {
      ...common,
      deadlineMs: 180,
      idleTimeoutMs: 100,
    }),
    (error) => error?.code === 'fetch_timeout' && error?.timeoutKind === 'deadline',
  );
  assert.ok(Date.now() - slowStartedAt < 1_000, 'absolute deadline must stop a slow drip');
  assert.equal(fs.existsSync(slowPath), false);

  const idlePath = path.join(tmpDir, 'idle.bin');
  await assert.rejects(
    safeRemoteMediaDownload(`${baseUrl}/idle`, idlePath, {
      ...common,
      deadlineMs: 1_500,
      idleTimeoutMs: 80,
    }),
    (error) => error?.code === 'fetch_timeout' && error?.timeoutKind === 'idle',
  );
  assert.equal(fs.existsSync(idlePath), false);
});

test('cross-origin redirect strips credentials permanently across later same-origin hops', async (t) => {
  const sourceRequests = [];
  const destinationRequests = [];
  const finalServer = await listen((req, res) => {
    destinationRequests.push(captureRedirectHeaders(req));
    if (req.url === '/first') {
      res.writeHead(302, { Location: '/final' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('compatible');
  });
  const firstDestinationUrl = `http://127.0.0.1:${finalServer.address().port}/first`;
  const finalUrl = `http://127.0.0.1:${finalServer.address().port}/final`;
  const redirectServer = await listen((req, res) => {
    sourceRequests.push(captureRedirectHeaders(req));
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/same-origin' });
      res.end();
      return;
    }
    res.writeHead(302, { Location: firstDestinationUrl });
    res.end();
  });
  t.after(async () => {
    await closeServer(redirectServer);
    await closeServer(finalServer);
  });
  const redirectUrl = `http://127.0.0.1:${redirectServer.address().port}/redirect`;
  const lookupHosts = [];
  const result = await safeRemoteMediaFetch(redirectUrl, {
    allowPrivateForTests: allowOnlyLoopbackTestHost,
    protocols: ['http:'],
    maxBytes: 32,
    deadlineMs: 1_000,
    idleTimeoutMs: 500,
    headers: {
      ...SENSITIVE_REQUEST_HEADERS,
      'X-T8-Test': 'safe',
    },
    lookupImpl: async (hostname) => {
      lookupHosts.push(hostname);
      return [{ address: '127.0.0.1', family: 4 }];
    },
  });
  assert.equal(result.buffer.toString('utf8'), 'compatible');
  assert.equal(result.contentType, 'text/plain');
  assert.equal(result.finalUrl, finalUrl);
  assert.equal(result.status, 200);
  assert.deepEqual(lookupHosts, ['127.0.0.1', '127.0.0.1', '127.0.0.1', '127.0.0.1']);
  assert.deepEqual(sourceRequests, [
    { path: '/redirect', sensitive: SENSITIVE_REQUEST_HEADERS, safeHeader: 'safe' },
    { path: '/same-origin', sensitive: SENSITIVE_REQUEST_HEADERS, safeHeader: 'safe' },
  ]);
  const strippedHeaders = Object.fromEntries(Object.keys(SENSITIVE_REQUEST_HEADERS).map((name) => [name, undefined]));
  assert.deepEqual(destinationRequests, [
    { path: '/first', sensitive: strippedHeaders, safeHeader: 'safe' },
    { path: '/final', sensitive: strippedHeaders, safeHeader: 'safe' },
  ]);
});

test('safe JSON fetch rejects private redirects and oversized or complex bodies while preserving bounded HTTP JSON status', async (t) => {
  let privateHits = 0;
  const privateServer = await listen((_req, res) => {
    privateHits += 1;
    res.end('{"status":"should-not-connect"}');
  });
  const publicServer = await listen((req, res) => {
    if (req.url === '/redirect-private') {
      res.writeHead(302, { Location: `http://127.0.0.1:${privateServer.address().port}/internal` });
      res.end();
      return;
    }
    if (req.url === '/oversize') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
      res.write(Buffer.alloc(48, 0x20));
      res.end(Buffer.alloc(48, 0x20));
      return;
    }
    if (req.url === '/pending') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'IN_QUEUE', detail: { retry: true } }));
      return;
    }
    if (req.url === '/error') {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'FAILED', code: 'invalid_input' }));
      return;
    }
    if (req.url === '/deep') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ a: { b: { c: { d: { e: true } } } } }));
      return;
    }
    if (req.url === '/wide') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ values: [1, 2, 3, 4, 5, 6] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  t.after(async () => {
    await closeServer(publicServer);
    await closeServer(privateServer);
  });
  const baseUrl = `http://public-a.test:${publicServer.address().port}`;
  const common = {
    allowPrivateForTests: (hostname) => hostname === 'public-a.test',
    lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    protocols: ['http:'],
    deadlineMs: 1_000,
    idleTimeoutMs: 500,
    maxBytes: 2 * 1024 * 1024,
  };

  await assert.rejects(
    safeRemoteJsonFetch(`${baseUrl}/redirect-private`, common),
    (error) => error?.code === 'private_address',
  );
  assert.equal(privateHits, 0, 'private redirect target must be rejected before TCP connect');

  await assert.rejects(
    safeRemoteJsonFetch(`${baseUrl}/oversize`, { ...common, maxBytes: 64 }),
    (error) => error?.code === 'item_too_large',
  );

  const pending = await safeRemoteJsonFetch(`${baseUrl}/pending`, common);
  assert.equal(pending.ok, false);
  assert.equal(pending.status, 409);
  assert.equal(pending.data.status, 'IN_QUEUE');
  const failed = await safeRemoteJsonFetch(`${baseUrl}/error`, common);
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 422);
  assert.equal(failed.data.status, 'FAILED');

  await assert.rejects(
    safeRemoteJsonFetch(`${baseUrl}/deep`, { ...common, maxJsonDepth: 3 }),
    (error) => error?.code === 'json_too_complex',
  );
  await assert.rejects(
    safeRemoteJsonFetch(`${baseUrl}/wide`, { ...common, maxJsonNodes: 5 }),
    (error) => error?.code === 'json_too_complex',
  );
});

test('safe upload rejects an early success response while the request body is still backpressured', async (t) => {
  let receivedBytes = 0;
  let responded = false;
  const server = await listen((req, res) => {
    req.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (!responded && receivedBytes >= 64 * 1024) {
        responded = true;
        req.pause();
        res.writeHead(200, { 'Content-Length': '0' });
        res.end();
      }
    });
  });
  t.after(() => closeServer(server));
  const body = Buffer.alloc(32 * 1024 * 1024, 0x5a);
  const target = `http://127.0.0.1:${server.address().port}/early-success`;

  await assert.rejects(
    safeRemoteUpload(target, {
      allowPrivateForTests: allowOnlyLoopbackTestHost,
      protocols: ['http:'],
      method: 'PUT',
      body,
      maxRequestBytes: body.length,
      deadlineMs: 1_000,
      idleTimeoutMs: 500,
    }),
    (error) => error?.code === 'upload_incomplete',
  );
  assert.equal(responded, true);
  assert.ok(receivedBytes < body.length, 'an early response must not be accepted as a completed upload');
});
