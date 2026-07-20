'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 't8-collab-ssrf-b3-'));
const TEST_INPUT = path.join(TEST_ROOT, 'input');
const TEST_OUTPUT = path.join(TEST_ROOT, 'output');
const TEST_THUMBNAILS = path.join(TEST_ROOT, 'thumbnails');
const TEST_DATA = path.join(TEST_ROOT, 'data');
for (const directory of [TEST_INPUT, TEST_OUTPUT, TEST_THUMBNAILS, TEST_DATA]) {
  fs.mkdirSync(directory, { recursive: true });
}

const configPath = require.resolve('../backend/src/config');
const imageOpsPath = require.resolve('../backend/src/routes/imageOps');
const videoOpsPath = require.resolve('../backend/src/routes/videoOps');
const previousConfigModule = require.cache[configPath];
const actualConfig = require(configPath);
const testConfig = {
  ...actualConfig,
  BASE_DIR: TEST_ROOT,
  DATA_DIR: TEST_DATA,
  INPUT_DIR: TEST_INPUT,
  OUTPUT_DIR: TEST_OUTPUT,
  THUMBNAILS_DIR: TEST_THUMBNAILS,
  SETTINGS_FILE: path.join(TEST_DATA, 'settings.json'),
  COLLAB_PUBLIC_EXPOSURE_FILE: path.join(TEST_DATA, 'collaboration-public-exposure.json'),
  PROJECT_DB_FILE: path.join(TEST_DATA, 'project.sqlite3'),
  PROJECT_DB_BACKUP_FILE: path.join(TEST_DATA, 'project.sqlite3.backup'),
  FRONTEND_DIST: '',
};
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: testConfig,
};
delete require.cache[imageOpsPath];
delete require.cache[videoOpsPath];

const imageOpsRouter = require(imageOpsPath);
const videoOpsRouter = require(videoOpsPath);
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const { CollaborationGateway } = require('../backend/src/collaboration/gateway');

test.after(() => {
  delete require.cache[imageOpsPath];
  delete require.cache[videoOpsPath];
  if (previousConfigModule) require.cache[configPath] = previousConfigModule;
  else delete require.cache[configPath];
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function canvasNode(id, type, data = {}) {
  return { id, type, position: { x: 0, y: 0 }, data };
}

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

function loopbackTestOptions(hostname, overrides = {}) {
  return {
    protocols: ['http:'],
    maxBytes: 1024,
    deadlineMs: 2_000,
    idleTimeoutMs: 500,
    allowPrivateForTests: (candidate) => candidate === hostname,
    lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    ...overrides,
  };
}

test('remote editor RunIntent can carry an upstream image URL, but host image I/O rejects private destinations before connect', async () => {
  let privateEndpointHits = 0;
  const privateServer = await listen((_req, res) => {
    privateEndpointHits += 1;
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end('host-private-response');
  });
  const privateUrl = `http://127.0.0.1:${privateServer.address().port}/internal-metadata`;
  const database = new ProjectDatabase(':memory:');
  const gateway = new CollaborationGateway({
    ...testConfig,
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    COLLAB_ALLOWED_ORIGINS: [],
  }, database);

  try {
    const canvas = database.ensureCanvas('canvas-ssrf', {
      nodes: [
        canvasNode('attacker-upload', 'upload', { imageUrl: privateUrl, status: 'success' }),
        canvasNode('host-resize', 'resize', { width: 64, height: 64, fit: 'cover' }),
      ],
      edges: [{ id: 'edge-attacker-resize', source: 'attacker-upload', target: 'host-resize' }],
    }, 'project-local');
    const gatewayStatus = await gateway.start({ host: '127.0.0.1', port: 0 });
    const gatewayUrl = `http://127.0.0.1:${gatewayStatus.port}`;
    const invite = gateway.auth.createInvite({
      projectId: 'project-local',
      canvasId: canvas.canvasId,
      role: 'editor',
      maxUses: 1,
    });
    const redeemResponse = await fetch(`${gatewayUrl}/api/collab/invites/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: invite.code, displayName: 'SSRF editor' }),
    });
    const redeemPayload = await redeemResponse.json();
    assert.equal(redeemResponse.status, 200, JSON.stringify(redeemPayload));
    const cookie = redeemResponse.headers.get('set-cookie').split(';')[0];

    const intentResponse = await fetch(`${gatewayUrl}/api/collab/run-intents`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        canvasId: canvas.canvasId,
        canvasRevision: canvas.revision,
        nodeIds: ['host-resize'],
        idempotencyKey: 'ssrf-image-op-intent-0001',
      }),
    });
    const intentPayload = await intentResponse.json();
    assert.equal(intentResponse.status, 202, JSON.stringify(intentPayload));
    assert.deepEqual(intentPayload.data.executionAuthority.authorizedNodeIds, ['host-resize']);
    assert.deepEqual(intentPayload.data.executionAuthority.declarations, []);
    assert.equal(database.getCanvas(canvas.canvasId).nodes[0].data.imageUrl, privateUrl);

    const imageOpFrame = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'nodes', 'ImageOpFrame.tsx'), 'utf8');
    const resizeNode = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'nodes', 'ResizeNode.tsx'), 'utf8');
    const imageOpsService = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'imageOps.ts'), 'utf8');
    assert.match(imageOpFrame, /pushImage\(d\.imageUrl\)/);
    assert.match(imageOpFrame, /await runOp\(needsMulti \? \(imgs as any\) : imgs\[0\]\)/);
    assert.match(resizeNode, /opResize\(img as string, width, height, fit\)/);
    assert.match(imageOpsService, /postOp<\{ imageUrl: string \}>\('resize', \{ imageUrl, width, height, fit \}\)/);

    await assert.rejects(
      imageOpsRouter._test.fetchImageBuffer(privateUrl),
      (error) => error?.code === 'private_address',
    );
    assert.equal(privateEndpointHits, 0, 'private endpoint must not receive a TCP request');
  } finally {
    await gateway.stop();
    database.close();
    await closeServer(privateServer);
  }
});

test('image operation boundary pins DNS, revalidates every redirect, and enforces byte/deadline limits', async () => {
  let finalHits = 0;
  const activeTimers = new Set();
  const server = await listen((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end('safe-image');
      return;
    }
    if (req.url === '/redirect-private') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
      return;
    }
    if (req.url === '/redirect-rebind') {
      res.writeHead(302, { location: `http://rebind.test:${server.address().port}/final` });
      res.end();
      return;
    }
    if (req.url === '/final') {
      finalHits += 1;
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end('must-not-be-reached');
      return;
    }
    if (req.url === '/oversize') {
      res.writeHead(200, { 'content-type': 'image/png', 'transfer-encoding': 'chunked' });
      res.end(Buffer.alloc(32, 1));
      return;
    }
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'image/png', 'transfer-encoding': 'chunked' });
      res.write('x');
      const timer = setTimeout(() => {
        activeTimers.delete(timer);
        if (!res.destroyed) res.end('late');
      }, 2_000);
      timer.unref();
      activeTimers.add(timer);
      res.once('close', () => {
        clearTimeout(timer);
        activeTimers.delete(timer);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = server.address().port;

  try {
    let pinnedLookups = 0;
    const pinned = await imageOpsRouter._test.fetchImageBuffer(`http://pinned.test:${port}/ok`, loopbackTestOptions('pinned.test', {
      lookupImpl: async () => {
        pinnedLookups += 1;
        return [{ address: pinnedLookups === 1 ? '127.0.0.1' : '169.254.169.254', family: 4 }];
      },
    }));
    assert.equal(pinned.toString('utf8'), 'safe-image');
    assert.equal(pinnedLookups, 1, 'the socket must use the validated pinned address without a second DNS lookup');

    await assert.rejects(
      imageOpsRouter._test.fetchImageBuffer(
        `http://redirect.test:${port}/redirect-private`,
        loopbackTestOptions('redirect.test'),
      ),
      (error) => error?.code === 'private_address',
    );

    let rebindPolicyChecks = 0;
    let rebindLookups = 0;
    await assert.rejects(
      imageOpsRouter._test.fetchImageBuffer(`http://rebind.test:${port}/redirect-rebind`, {
        protocols: ['http:'],
        maxBytes: 1024,
        deadlineMs: 2_000,
        idleTimeoutMs: 500,
        allowPrivateForTests: (hostname) => {
          rebindPolicyChecks += 1;
          return hostname === 'rebind.test' && rebindPolicyChecks === 1;
        },
        lookupImpl: async () => {
          rebindLookups += 1;
          return [{ address: rebindLookups === 1 ? '127.0.0.1' : '169.254.169.254', family: 4 }];
        },
      }),
      (error) => error?.code === 'private_address',
    );
    assert.equal(rebindLookups, 2, 'redirect hop must resolve and validate again');
    assert.equal(finalHits, 0, 'the rebound private address must never be connected');

    await assert.rejects(
      imageOpsRouter._test.fetchImageBuffer(
        `http://bounded.test:${port}/oversize`,
        loopbackTestOptions('bounded.test', { maxBytes: 8 }),
      ),
      (error) => error?.code === 'item_too_large',
    );
    await assert.rejects(
      imageOpsRouter._test.fetchImageBuffer(
        `http://deadline.test:${port}/slow`,
        loopbackTestOptions('deadline.test', { deadlineMs: 100, idleTimeoutMs: 1_000 }),
      ),
      (error) => error?.code === 'fetch_timeout' && error?.timeoutKind === 'deadline',
    );
  } finally {
    for (const timer of activeTimers) clearTimeout(timer);
    await closeServer(server);
  }
});

test('controlled same-app mounts stay local while video downloads share the same hardened boundary', async () => {
  const localImage = path.join(TEST_INPUT, 'controlled-image.png');
  const localVideo = path.join(TEST_INPUT, 'controlled-video.mp4');
  fs.writeFileSync(localImage, 'local-image');
  fs.writeFileSync(localVideo, 'local-video');

  const localImageBuffer = await imageOpsRouter._test.fetchImageBuffer(
    'http://localhost:65535/files/input/controlled-image.png',
  );
  assert.equal(localImageBuffer.toString('utf8'), 'local-image');
  assert.equal(
    videoOpsRouter._test.resolveMountedPath('http://[::1]:65535/files/input/controlled-video.mp4'),
    localVideo,
  );

  await assert.rejects(
    videoOpsRouter._test.downloadRemoteVideo('http://127.0.0.1:65535/private.mp4', TEST_OUTPUT),
    (error) => error?.code === 'private_address',
  );

  const server = await listen((req, res) => {
    if (req.url === '/video.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end('remote-video');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('not-video');
  });
  const port = server.address().port;
  try {
    const downloaded = await videoOpsRouter._test.downloadRemoteVideo(
      `http://video.test:${port}/video.mp4`,
      TEST_OUTPUT,
      loopbackTestOptions('video.test'),
    );
    assert.equal(fs.readFileSync(downloaded, 'utf8'), 'remote-video');

    const beforeInvalidMime = new Set(fs.readdirSync(TEST_OUTPUT));
    await assert.rejects(
      videoOpsRouter._test.downloadRemoteVideo(
        `http://video.test:${port}/not-video.mp4`,
        TEST_OUTPUT,
        loopbackTestOptions('video.test'),
      ),
      /远程地址不是视频文件/,
    );
    assert.deepEqual(new Set(fs.readdirSync(TEST_OUTPUT)), beforeInvalidMime, 'invalid MIME download must be removed');
  } finally {
    await closeServer(server);
  }
});

test('gateway Origin policy is derived from listener/LAN/public/proxy configuration and never from request Host', async () => {
  const database = new ProjectDatabase(':memory:');
  const interfaces = [
    { id: 'loopback', name: 'loopback', address: '127.0.0.1', family: 'IPv4', internal: true, scope: 'loopback' },
    { id: 'lan', name: 'lan', address: '192.168.50.20', family: 'IPv4', internal: false, scope: 'private' },
    { id: 'wildcard', name: 'all', address: '0.0.0.0', family: 'IPv4', internal: false, scope: 'wildcard' },
  ];
  const gateway = new CollaborationGateway({
    ...testConfig,
    COLLAB_HOST: '0.0.0.0',
    COLLAB_PORT: 0,
    COLLAB_ALLOWED_ORIGINS: ['https://proxy.example/collab'],
    COLLAB_PUBLIC_BASE_URL: 'https://public.example/team/collab',
  }, database, {
    listNetworkInterfaces: () => interfaces.map((entry) => ({ ...entry })),
  });
  try {
    const status = await gateway.start({ host: '0.0.0.0', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}`;
    const listenerOrigin = `http://127.0.0.1:${status.port}`;
    const lanOrigin = `http://192.168.50.20:${status.port}`;
    assert.deepEqual([...gateway.collaborationAllowedOrigins('0.0.0.0', status.port)].sort(), [
      listenerOrigin,
      lanOrigin,
      'https://proxy.example',
      'https://public.example',
    ].sort());

    const noOrigin = await fetch(`${baseUrl}/api/collab/status`);
    assert.equal(noOrigin.status, 200);

    for (const origin of [listenerOrigin, lanOrigin, 'https://proxy.example', 'https://public.example']) {
      const response = await fetch(`${baseUrl}/api/collab/status`, { headers: { origin } });
      assert.equal(response.status, 200, origin);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
      assert.match(response.headers.get('vary') || '', /Origin/i);
    }

    const forgedHost = await fetch(`${baseUrl}/api/collab/status`, {
      headers: { origin: 'https://evil.example', host: 'evil.example' },
    });
    assert.equal(forgedHost.status, 403);
    assert.equal(forgedHost.headers.get('access-control-allow-origin'), null);
    const opaqueOrigin = await fetch(`${baseUrl}/api/collab/status`, { headers: { origin: 'null' } });
    assert.equal(opaqueOrigin.status, 403);

    const preflight = await fetch(`${baseUrl}/api/collab/run-intents`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://public.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://public.example');
    assert.match(preflight.headers.get('access-control-allow-methods') || '', /POST/);
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type');
  } finally {
    await gateway.stop();
    database.close();
  }
});

test('gateway reverse enumeration cannot reach settings, commands, local paths, proxy routes, or private static roots', async () => {
  const database = new ProjectDatabase(':memory:');
  const gateway = new CollaborationGateway({
    ...testConfig,
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    FRONTEND_DIST: '',
  }, database);
  const probes = [
    '/api/settings/raw',
    '/api/settings',
    '/api/commands',
    '/api/command/run',
    '/api/shell',
    '/api/terminal',
    '/api/files/open',
    '/api/files/import',
    '/api/files/local-path',
    '/api/proxy?url=http%3A%2F%2F127.0.0.1%2F',
    '/api/providers',
    '/api/external-providers',
    '/api/plugins',
    '/files/input/private.png',
    '/files/output/private.png',
    '/input/private.png',
    '/output/private.png',
    '/api/resources/file/private-id',
    '/.env',
    '/package.json',
    '/backend/src/config.js',
    '/%2e%2e/%2e%2e/data/settings.json',
    '/api/collab/%2e%2e/%2e%2e/api/settings/raw',
  ];
  try {
    const status = await gateway.start({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}`;
    for (const probe of probes) {
      for (const method of ['GET', 'POST']) {
        const response = await fetch(`${baseUrl}${probe}`, {
          method,
          ...(method === 'POST' ? {
            headers: { 'content-type': 'application/json' },
            body: '{}',
          } : {}),
        });
        const body = await response.text();
        assert.equal(response.status, 404, `${method} ${probe}: ${response.status} ${body}`);
        assert.match(body, /协作网关未开放此接口/, `${method} ${probe}`);
        assert.doesNotMatch(body, /T8_IMAGE_OPS|T8_COLLAB|PROJECT_DB_FILE|PenguinPravite/i);
      }
    }
  } finally {
    await gateway.stop();
    database.close();
  }
});
