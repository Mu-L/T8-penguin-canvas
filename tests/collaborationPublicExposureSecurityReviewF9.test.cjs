const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const {
  PublicSelfCheckChallenges,
  isInsecurePublicRequest,
  normalizePublicBaseUrl,
  resolvePinnedSelfCheckTarget,
  runPublicSelfCheck,
} = require('../backend/src/collaboration/publicExposure');

function requestFixture({
  host,
  origin = '',
  remoteAddress,
  localAddress,
  headers = {},
  trustProxy = () => false,
  secFetchSite = '',
  encrypted = false,
}) {
  const normalizedHeaders = {
    host,
    ...(origin ? { origin } : {}),
    ...(secFetchSite ? { 'sec-fetch-site': secFetchSite } : {}),
    ...headers,
  };
  return {
    headers: normalizedHeaders,
    socket: { remoteAddress, localAddress, encrypted },
    app: {
      get(name) {
        if (name === 'trust proxy fn') return trustProxy;
        return undefined;
      },
    },
    get(name) {
      return normalizedHeaders[String(name || '').toLowerCase()] || '';
    },
  };
}

test('F9 insecure public HTTP fails closed against Host/forwarding spoofing but preserves proven direct LAN/dev', () => {
  const publicHttp = 'http://collab.example/collab';
  const directLoopback = requestFixture({
    host: '127.0.0.1:18767',
    origin: 'http://127.0.0.1:18767',
    remoteAddress: '127.0.0.1',
    localAddress: '127.0.0.1',
  });
  const directLan = requestFixture({
    host: '192.168.50.20:18767',
    origin: 'http://192.168.50.20:18767',
    remoteAddress: '192.168.50.31',
    localAddress: '192.168.50.20',
  });
  const directIpv6Lan = requestFixture({
    host: '[fd00::20]:18767',
    origin: 'http://[fd00::20]:18767',
    remoteAddress: 'fd00::31',
    localAddress: 'fd00::20',
  });
  assert.equal(isInsecurePublicRequest(directLoopback, publicHttp), false);
  assert.equal(isInsecurePublicRequest(directLan, publicHttp), false);
  assert.equal(isInsecurePublicRequest(directIpv6Lan, publicHttp), false);

  const cases = [
    requestFixture({
      host: '192.168.50.20:18767',
      remoteAddress: '8.8.8.8',
      localAddress: '192.168.50.20',
    }),
    requestFixture({
      host: '127.0.0.1:18767',
      remoteAddress: '127.0.0.1',
      localAddress: '127.0.0.1',
      headers: { 'x-forwarded-host': '192.168.50.20:18767' },
    }),
    requestFixture({
      host: '127.0.0.1:18767',
      remoteAddress: '127.0.0.1',
      localAddress: '127.0.0.1',
      trustProxy: () => true,
    }),
    requestFixture({
      host: '192.168.50.21:18767',
      remoteAddress: '192.168.50.31',
      localAddress: '192.168.50.20',
    }),
    requestFixture({
      host: '192.168.50.20:18767',
      origin: 'http://192.168.50.20:18767',
      remoteAddress: '192.168.50.31',
      localAddress: '192.168.50.20',
      secFetchSite: 'cross-site',
    }),
    requestFixture({
      host: '[fd00::20]:18767',
      remoteAddress: '2001:4860:4860::8888',
      localAddress: 'fd00::20',
    }),
    requestFixture({
      host: 'attacker.invalid',
      remoteAddress: '127.0.0.1',
      localAddress: '127.0.0.1',
    }),
  ];
  for (const request of cases) assert.equal(isInsecurePublicRequest(request, publicHttp), true);
  assert.throws(() => normalizePublicBaseUrl('http://[::]/collab'));
});

test('F9 HTTPS policy requires an exact public authority and either real TLS or an explicitly trusted immediate proxy', () => {
  const publicHttps = 'https://collab.example/collab';
  const trustedLoopbackProxy = (address, hop) => address === '127.0.0.1' && hop === 0;
  const request = (overrides = {}) => requestFixture({
    host: 'collab.example',
    remoteAddress: '8.8.8.8',
    localAddress: '192.168.50.20',
    ...overrides,
  });

  assert.equal(isInsecurePublicRequest(request(), publicHttps), true, 'matching Host cannot turn plaintext into TLS');
  assert.equal(isInsecurePublicRequest(request({
    remoteAddress: '127.0.0.1',
    localAddress: '127.0.0.1',
    trustProxy: trustedLoopbackProxy,
    headers: { 'x-forwarded-proto': 'http' },
  }), publicHttps), true, 'trusted proxy must report https');
  assert.equal(isInsecurePublicRequest(request({
    remoteAddress: '127.0.0.1',
    localAddress: '127.0.0.1',
    trustProxy: trustedLoopbackProxy,
  }), publicHttps), true, 'plaintext proxy hop without X-Forwarded-Proto fails closed');
  assert.equal(isInsecurePublicRequest(request({
    remoteAddress: '127.0.0.1',
    localAddress: '127.0.0.1',
    trustProxy: trustedLoopbackProxy,
    headers: { 'x-forwarded-proto': 'https, http' },
  }), publicHttps), true, 'ambiguous forwarded protocol fails closed');
  assert.equal(isInsecurePublicRequest(request({
    host: '127.0.0.1:18767',
    remoteAddress: '127.0.0.1',
    localAddress: '127.0.0.1',
    trustProxy: trustedLoopbackProxy,
    headers: {
      'x-forwarded-host': 'collab.example',
      'x-forwarded-proto': 'https',
    },
  }), publicHttps), false, 'trusted proxy may supply the exact external authority');
  assert.equal(isInsecurePublicRequest(request({
    remoteAddress: '127.0.0.1',
    localAddress: '127.0.0.1',
    trustProxy: trustedLoopbackProxy,
    headers: { 'x-forwarded-proto': 'https' },
  }), publicHttps), false, 'trusted proxy may preserve the exact public Host');
  assert.equal(isInsecurePublicRequest(request({
    headers: { 'x-forwarded-proto': 'https' },
  }), publicHttps), true, 'untrusted clients cannot self-assert forwarded TLS');
  assert.equal(isInsecurePublicRequest(request({
    remoteAddress: '127.0.0.1',
    localAddress: '127.0.0.1',
    trustProxy: true,
    headers: { 'x-forwarded-proto': 'https' },
  }), publicHttps), true, 'blanket trust-proxy is not explicit upstream enrollment');
  assert.equal(isInsecurePublicRequest(request({ encrypted: true }), publicHttps), false);
  assert.equal(isInsecurePublicRequest(request({
    encrypted: true,
    host: 'attacker.invalid',
  }), publicHttps), true);
  assert.equal(isInsecurePublicRequest(request({
    encrypted: true,
    headers: { 'x-forwarded-proto': 'http' },
  }), publicHttps), true, 'contradictory proxy evidence fails closed even on TLS');
  assert.equal(isInsecurePublicRequest(request({
    encrypted: true,
    headers: { 'x-forwarded-host': 'attacker.invalid' },
  }), publicHttps), true, 'untrusted forwarding evidence cannot override direct TLS authority');
  assert.equal(isInsecurePublicRequest(request({
    remoteAddress: '127.0.0.1',
    localAddress: '127.0.0.1',
    trustProxy: trustedLoopbackProxy,
    headers: {
      'x-forwarded-host': 'attacker.invalid',
      'x-forwarded-proto': 'https',
    },
  }), publicHttps), true, 'conflicting forwarded authority fails closed');
  assert.equal(isInsecurePublicRequest(request({
    origin: 'https://attacker.invalid',
    remoteAddress: '127.0.0.1',
    localAddress: '127.0.0.1',
    trustProxy: trustedLoopbackProxy,
    headers: { 'x-forwarded-proto': 'https' },
  }), publicHttps), true, 'trusted TLS metadata cannot override a mismatched browser Origin');
  assert.equal(isInsecurePublicRequest(request({
    encrypted: true,
    origin: 'not a valid origin',
  }), publicHttps), true, 'malformed Origin cannot be treated as absent');
});

test('F9 missing or corrupt public policy degrades unknown remote transports but preserves proven LAN', () => {
  const remote = requestFixture({
    host: 'collab.example',
    remoteAddress: '8.8.8.8',
    localAddress: '192.168.50.20',
  });
  const lan = requestFixture({
    host: '192.168.50.20:18767',
    remoteAddress: '192.168.50.31',
    localAddress: '192.168.50.20',
  });
  assert.equal(isInsecurePublicRequest(remote, ''), true);
  assert.equal(isInsecurePublicRequest(remote, 'corrupt persisted value'), true);
  assert.equal(isInsecurePublicRequest(lan, ''), false);
  assert.equal(isInsecurePublicRequest(lan, 'corrupt persisted value'), false);
});

test('F9 DNS resolution obeys the same bounded total deadline', { timeout: 3_000 }, async () => {
  const startedAt = performance.now();
  await assert.rejects(
    resolvePinnedSelfCheckTarget('https://deadline.example/collab', {
      timeoutMs: 1_000,
      lookup: () => new Promise(() => {}),
    }),
    (error) => error?.code === 'collaboration_public_self_check_timeout' && error?.status === 504,
  );
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= 800 && elapsedMs < 1_800, `DNS deadline took ${elapsedMs}ms`);
});

test('F9 total deadline spans DNS, TLS/headers and slow-drip bodies and releases every challenge', { timeout: 4_000 }, async () => {
  const intervals = new Set();
  const sockets = new Set();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    const interval = setInterval(() => {
      if (!response.destroyed) response.write(' ');
    }, 40);
    intervals.add(interval);
    response.once('close', () => {
      clearInterval(interval);
      intervals.delete(interval);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (_request, socket) => sockets.add(socket));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/collab`;
  const challenges = new PublicSelfCheckChallenges();
  const startedAt = performance.now();
  try {
    const result = await runPublicSelfCheck({
      baseUrl,
      challenges,
      timeoutMs: 1_000,
      allowedLocalOrigins: [baseUrl],
      allowedLocalAddresses: ['127.0.0.1'],
      lookup: async () => {
        await new Promise((resolve) => setTimeout(resolve, 650));
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    const elapsedMs = performance.now() - startedAt;
    assert.equal(result.allChecksPassed, false);
    assert.equal(result.checks.length, 5);
    assert.equal(result.checks.every((entry) => entry.status === 'failed'), true);
    assert.ok(elapsedMs >= 800 && elapsedMs < 1_800, `shared deadline took ${elapsedMs}ms`);
    assert.equal(challenges.entries.size, 0);
  } finally {
    for (const interval of intervals) clearInterval(interval);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
