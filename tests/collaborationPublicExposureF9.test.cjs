const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const {
  PUBLIC_SELF_CHECK_HEADER,
  PUBLIC_SELF_CHECK_INVITE_CODE,
  PublicSelfCheckChallenges,
  classifyPublicBaseUrl,
  isInsecurePublicRequest,
  normalizePublicBaseUrl,
  resolvePinnedSelfCheckTarget,
  runPublicSelfCheck,
} = require('../backend/src/collaboration/publicExposure');

const gatewaySource = fs.readFileSync(path.resolve(__dirname, '../backend/src/collaboration/gateway.js'), 'utf8');

test('F9 public Base URL normalization and HTTP degradation fail closed without affecting LAN/dev', () => {
  assert.equal(
    normalizePublicBaseUrl('https://collab.example/team/collab/'),
    'https://collab.example/team/collab',
  );
  for (const invalid of [
    'ftp://collab.example/collab',
    'https://user:secret@collab.example/collab',
    'https://collab.example/collab?token=secret',
    'https://collab.example/collab#secret',
    'https://collab.example/not-collaboration',
    'http://0.0.0.0:18767/collab',
  ]) assert.throws(() => normalizePublicBaseUrl(invalid));

  const insecure = classifyPublicBaseUrl('http://collab.example/collab');
  assert.equal(insecure.exposure, 'public');
  assert.equal(insecure.insecurePublic, true);
  assert.equal(insecure.ownerManagementAllowed, false);
  assert.equal(insecure.sensitiveOriginalDownloadAllowed, false);
  assert.match(insecure.warning, /HTTPS.*owner.*原件/);

  const secure = classifyPublicBaseUrl('https://collab.example/collab');
  assert.equal(secure.insecurePublic, false);
  assert.equal(secure.ownerManagementAllowed, true);
  assert.equal(secure.sensitiveOriginalDownloadAllowed, true);

  for (const local of [
    'http://127.0.0.1:18767/collab',
    'http://localhost:18767/collab',
    'http://192.168.50.20:18767/collab',
  ]) {
    const policy = classifyPublicBaseUrl(local);
    assert.equal(policy.insecurePublic, false, local);
    assert.equal(policy.ownerManagementAllowed, true, local);
    assert.equal(policy.sensitiveOriginalDownloadAllowed, true, local);
  }

  const publicRequest = {
    get(name) {
      return String(name).toLowerCase() === 'host' ? 'collab.example' : '';
    },
  };
  const lanRequest = {
    get(name) {
      return String(name).toLowerCase() === 'host' ? '192.168.50.20:18767' : '';
    },
  };
  const forwardedPublicRequest = {
    get(name) {
      if (String(name).toLowerCase() === 'host') return '127.0.0.1:18767';
      if (String(name).toLowerCase() === 'x-forwarded-host') return 'collab.example, proxy.internal';
      return '';
    },
  };
  assert.equal(isInsecurePublicRequest(publicRequest, insecure.baseUrl), true);
  assert.equal(isInsecurePublicRequest(forwardedPublicRequest, insecure.baseUrl), true);
  assert.equal(isInsecurePublicRequest(lanRequest, insecure.baseUrl), false);
});

test('F9 self-check challenges are short-lived, typed, one-time and payloads stay in memory', () => {
  const challenges = new PublicSelfCheckChallenges({ ttlMs: 5_000, maxEntries: 4 });
  const issued = challenges.issue('upload', { bytes: 17, sha256: 'a'.repeat(64) });
  assert.doesNotMatch(JSON.stringify(challenges.entries), new RegExp(issued.token));
  assert.equal(challenges.consume(issued.token, 'range'), null, 'wrong kind consumes the token fail-closed');
  assert.equal(challenges.consume(issued.token, 'upload'), null, 'wrong-kind attempt cannot be retried');
  const second = challenges.issue('invite');
  assert.equal(challenges.consume(second.token, 'invite').kind, 'invite');
  assert.equal(challenges.consume(second.token, 'invite'), null);
});

function createSelfCheckServer(challenges) {
  const webSockets = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'GET' && req.url === '/api/collab/health') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        success: true,
        data: { service: 't8-collaboration-gateway', running: true },
      }));
    }
    if (req.method === 'GET' && req.url === '/api/collab/self-check/range') {
      const challenge = challenges.consume(req.headers[PUBLIC_SELF_CHECK_HEADER], 'range');
      const body = challenge?.payload?.body;
      if (!Buffer.isBuffer(body) || req.headers.range !== 'bytes=17-48') {
        res.statusCode = 404;
        return res.end();
      }
      const selected = body.subarray(17, 49);
      res.statusCode = 206;
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('content-range', `bytes 17-48/${body.length}`);
      res.setHeader('content-length', selected.length);
      return res.end(selected);
    }
    const chunks = [];
    let byteLength = 0;
    req.on('data', (chunk) => {
      byteLength += chunk.length;
      if (byteLength <= 2048) chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'POST' && req.url === '/api/collab/invites/redeem') {
        const challenge = challenges.consume(req.headers[PUBLIC_SELF_CHECK_HEADER], 'invite');
        let payload = null;
        try { payload = JSON.parse(body.toString('utf8')); } catch (_) {}
        if (!challenge || payload?.code !== PUBLIC_SELF_CHECK_INVITE_CODE) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ success: true, data: { selfCheck: true } }));
      }
      if (req.method === 'PUT' && req.url === '/api/collab/self-check/upload') {
        const challenge = challenges.consume(req.headers[PUBLIC_SELF_CHECK_HEADER], 'upload');
        const digest = crypto.createHash('sha256').update(body).digest('hex');
        if (!challenge
          || body.length !== challenge.payload?.bytes
          || digest !== challenge.payload?.sha256) {
          res.statusCode = 422;
          return res.end();
        }
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ success: true, data: { bytes: body.length } }));
      }
      res.statusCode = 404;
      return res.end();
    });
  });
  server.on('upgrade', (request, socket, head) => {
    const challenge = challenges.consume(request.headers[PUBLIC_SELF_CHECK_HEADER], 'websocket');
    if (request.url !== '/ws/collab' || !challenge) return socket.destroy();
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.send(JSON.stringify({ type: 'self-check.ready' }));
    });
  });
  return { server, webSockets };
}

test('F9 runs health, invite redeem, WebSocket Upgrade, micro-upload and Range without durable data', async () => {
  const challenges = new PublicSelfCheckChallenges();
  const { server, webSockets } = createSelfCheckServer(challenges);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/collab`;
  try {
    const result = await runPublicSelfCheck({
      baseUrl,
      challenges,
      timeoutMs: 3_000,
      allowedLocalOrigins: [baseUrl],
      allowedLocalAddresses: ['127.0.0.1'],
    });
    assert.equal(result.contractVersion, 't8-collaboration-public-self-check-v1');
    assert.equal(result.status, 'passed');
    assert.equal(result.allChecksPassed, true);
    assert.deepEqual(result.checks.map((entry) => entry.id).sort(), [
      'health',
      'invite',
      'range',
      'upload',
      'websocket',
    ]);
    assert.equal(result.checks.every((entry) => entry.status === 'passed'), true);
    assert.equal(challenges.entries.size, 0);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /x-t8-collaboration-self-check|t8-public-self-check:[A-Za-z0-9+/=_-]+/i);
  } finally {
    for (const client of webSockets.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    webSockets.close();
  }
});

test('F9 SSRF guard refuses an unapproved private target before any probe is issued', async () => {
  const challenges = new PublicSelfCheckChallenges();
  await assert.rejects(
    resolvePinnedSelfCheckTarget('http://127.0.0.1:65530/collab', {
      allowedLocalOrigins: [],
      allowedLocalAddresses: [],
    }),
    (error) => error?.code === 'collaboration_public_self_check_private_target_forbidden'
      && error?.status === 403,
  );
  assert.equal(challenges.entries.size, 0);
});

test('F9 gateway wires ephemeral probes before session auth and enforces HTTP public degradation server-side', () => {
  const healthIndex = gatewaySource.indexOf("app.get('/api/collab/health'");
  const inviteIndex = gatewaySource.indexOf("app.post('/api/collab/invites/redeem'");
  const sessionIndex = gatewaySource.indexOf("app.use('/api/collab', this.requireSession.bind(this))");
  assert.ok(healthIndex > 0 && healthIndex < sessionIndex);
  assert.ok(inviteIndex > 0 && inviteIndex < sessionIndex);
  assert.match(gatewaySource, /publicSelfCheckChallenges\.consume\([\s\S]*'upload'/);
  assert.match(gatewaySource, /publicSelfCheckChallenges\.consume\([\s\S]*'range'/);
  assert.match(gatewaySource, /publicSelfCheckChallenges\.consume\(selfCheckToken, 'websocket'\)/);
  assert.match(gatewaySource, /collaboration_public_http_owner_management_disabled/);
  assert.match(gatewaySource, /\['manageMembers', 'manageProviders'\]\.includes\(capability\)/);
  assert.match(gatewaySource, /const insecurePublicRequest = isInsecurePublicRequest\(req, this\.publicBaseUrl\)/);
  assert.match(gatewaySource, /if \(downloadOriginal\) \{[\s\S]*if \(insecurePublicRequest\)[\s\S]*collaboration_public_http_original_download_disabled/);
  assert.match(gatewaySource, /const canFallbackToOriginal = !downloadOriginal\s*&& !insecurePublicRequest/);
});
