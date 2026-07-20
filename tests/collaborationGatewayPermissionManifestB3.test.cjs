const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const parser = require('@babel/parser');

const {
  CollaborationGateway,
  SESSION_COOKIE,
} = require('../backend/src/collaboration/gateway');
const {
  ROLE_CAPABILITIES,
  capabilitiesForRole,
} = require('../backend/src/collaboration/auth');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

const GATEWAY_SOURCE_FILE = path.resolve(__dirname, '../backend/src/collaboration/gateway.js');
const ROUTE_MANIFEST_FILE = path.resolve(
  __dirname,
  'fixtures/collaboration-gateway-route-permissions-b3.json',
);
const COMMON_HTTP_VERBS = Object.freeze(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
const DECLARED_ROUTE_METHODS = new Set(['delete', 'get', 'options', 'patch', 'post', 'put']);
const NON_ROUTE_APP_METHODS = new Set(['disable', 'set']);
const MUTATING_HTTP_VERBS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);
const EXPECTED_FRONTEND_ROUTE_REGEX = Object.freeze({
  method: 'GET',
  pattern: '^\\/collab(?:\\/.*)?$',
  flags: '',
});

function walk(node, visitor) {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, visitor);
    } else if (value && typeof value === 'object' && value.type) {
      walk(value, visitor);
    }
  }
}

function literalRoutePaths(node) {
  const first = node.arguments[0];
  if (first?.type === 'StringLiteral') return [first.value];
  if (first?.type === 'ArrayExpression') {
    if (first.elements.some((entry) => entry?.type !== 'StringLiteral')) {
      throw new Error(`协作网关路由数组必须全部使用字符串字面量（line ${node.loc?.start?.line || '?'})`);
    }
    return first.elements.map((entry) => entry.value);
  }
  if (first?.type === 'RegExpLiteral') return null;
  throw new Error(`协作网关路由必须使用可审计的字符串或正则字面量（line ${node.loc?.start?.line || '?'})`);
}

function directCapability(node) {
  const guards = node.arguments.filter((argument) => (
    argument?.type === 'CallExpression'
    && argument.callee?.type === 'MemberExpression'
    && argument.callee.object?.type === 'ThisExpression'
    && argument.callee.property?.name === 'requireCapability'
  ));
  if (guards.length > 1) {
    throw new Error(`单一路由不能声明多个 requireCapability（line ${node.loc?.start?.line || '?'})`);
  }
  if (guards.length === 0) return null;
  const capability = guards[0].arguments[0];
  if (capability?.type !== 'StringLiteral' || !capability.value) {
    throw new Error(`requireCapability 必须使用非空字符串字面量（line ${node.loc?.start?.line || '?'})`);
  }
  return capability.value;
}

function sourceRouteContract(source = fs.readFileSync(GATEWAY_SOURCE_FILE, 'utf8')) {
  const ast = parser.parse(source, { sourceType: 'script' });
  const createAppMethods = [];
  walk(ast, (node) => {
    if (node.type === 'ClassMethod' && node.key?.name === 'createApp') createAppMethods.push(node);
  });
  assert.equal(createAppMethods.length, 1, 'CollaborationGateway 必须只有一个 createApp 路由注册入口');

  const calls = [];
  walk(createAppMethods[0].body, (node) => {
    if (node.type !== 'CallExpression'
      || node.callee?.type !== 'MemberExpression'
      || node.callee.object?.name !== 'app') return;
    calls.push(node);
  });
  calls.sort((left, right) => left.start - right.start);

  let requireSessionAt = null;
  let requireResourceAt = null;
  const routeCalls = [];
  const regexRoutes = [];
  const middleware = [];
  for (const call of calls) {
    if (call.callee.computed || call.callee.property?.type !== 'Identifier') {
      throw new Error(`createApp 禁止使用计算属性注册 Express 接口（line ${call.loc?.start?.line || '?'})`);
    }
    const method = String(call.callee.property?.name || '').toLowerCase();
    const callSource = source.slice(call.start, call.end);
    if (method === 'use') {
      const first = call.arguments[0];
      const mount = first?.type === 'StringLiteral' ? first.value : null;
      if (mount == null && call.arguments.length > 1) {
        throw new Error(`app.use 路径必须使用可审计的字符串字面量（line ${call.loc?.start?.line || '?'})`);
      }
      middleware.push({
        mount,
        sha256: crypto
          .createHash('sha256')
          .update(callSource.replace(/\s+/g, ' ').trim())
          .digest('hex'),
      });
      if (mount === '/api/collab' && callSource.includes('this.requireSession.bind(this)')) {
        requireSessionAt = call.start;
      }
      if (mount === '/api/collab' && callSource.includes('this.requireReadyResourceScope.bind(this)')) {
        requireResourceAt = call.start;
      }
      continue;
    }
    if (!DECLARED_ROUTE_METHODS.has(method)) {
      if (NON_ROUTE_APP_METHODS.has(method)) continue;
      throw new Error(`createApp 出现未纳入审计的 app.${method || '?'} 注册（line ${call.loc?.start?.line || '?'})`);
    }
    const paths = literalRoutePaths(call);
    if (paths == null) {
      regexRoutes.push({
        method: method.toUpperCase(),
        pattern: call.arguments[0].pattern,
        flags: call.arguments[0].flags || '',
      });
      continue;
    }
    const capability = directCapability(call);
    for (const routePath of paths) {
      if (!routePath.startsWith('/api/collab')) continue;
      routeCalls.push({
        start: call.start,
        method: method.toUpperCase(),
        path: routePath,
        capability,
      });
    }
  }

  assert.ok(Number.isInteger(requireSessionAt), '缺少 /api/collab 全局 requireSession 边界');
  assert.ok(Number.isInteger(requireResourceAt), '缺少 /api/collab 全局 requireReadyResourceScope 边界');
  assert.ok(requireSessionAt < requireResourceAt, 'session 边界必须先于 resource-scope 边界');
  assert.deepEqual(
    regexRoutes,
    [EXPECTED_FRONTEND_ROUTE_REGEX, EXPECTED_FRONTEND_ROUTE_REGEX],
    '仅允许两个等价的 /collab SPA 前端正则路由；任何 API 正则路由必须显式重审',
  );

  return {
    middleware,
    routes: routeCalls.map(({ start, ...route }) => ({
      ...route,
      scope: start < requireSessionAt
        ? 'public'
        : start < requireResourceAt
          ? 'session'
          : 'resource',
    })),
  };
}

function runtimeRouteContract(app) {
  const routes = [];
  for (const layer of app?._router?.stack || []) {
    if (!layer.route) continue;
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    for (const routePath of paths) {
      if (typeof routePath !== 'string' || !routePath.startsWith('/api/collab')) continue;
      for (const method of Object.keys(layer.route.methods || {})) {
        const normalizedMethod = method.toUpperCase();
        if (!DECLARED_ROUTE_METHODS.has(method)) continue;
        routes.push({ method: normalizedMethod, path: routePath });
      }
    }
  }
  return routes;
}

function readManifest() {
  const manifest = JSON.parse(fs.readFileSync(ROUTE_MANIFEST_FILE, 'utf8'));
  assert.equal(manifest.schema, 't8-collaboration-public-route-permissions-b3-v1');
  assert.ok(Array.isArray(manifest.middleware));
  assert.ok(Array.isArray(manifest.routes));
  return manifest;
}

function assertMiddlewareContract(sourceMiddleware, manifest) {
  assert.deepEqual(
    sourceMiddleware,
    manifest.middleware.map(({ mount, sha256 }) => ({ mount, sha256 })),
    '任何新增、删除、重排、改写或动态挂载的 app.use 都必须显式更新并复审 middleware manifest',
  );
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-collab-route-manifest-b3-'));
  const frontend = path.join(root, 'frontend');
  const privateRoot = path.join(root, 'private-host-root');
  const data = path.join(root, 'data');
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  const thumbnails = path.join(root, 'thumbnails');
  const uploads = path.join(data, 'collaboration-uploads');
  const blobs = path.join(data, 'asset-blobs');
  const previews = path.join(thumbnails, 'asset-previews');
  for (const directory of [
    frontend,
    path.join(frontend, 'assets'),
    privateRoot,
    data,
    input,
    output,
    thumbnails,
    uploads,
    blobs,
    previews,
  ]) fs.mkdirSync(directory, { recursive: true });

  fs.writeFileSync(path.join(frontend, 'index.html'), '<!doctype html><title>T8 B3 public frontend</title><main>PUBLIC_FRONTEND_B3</main>');
  fs.writeFileSync(path.join(frontend, 'assets', 'app.js'), 'globalThis.__T8_PUBLIC_ASSET_B3__ = true;\n');
  fs.writeFileSync(path.join(privateRoot, 'host-secret.txt'), 'PRIVATE_HOST_SENTINEL_B3');

  const database = new ProjectDatabase(':memory:');
  database.ensureCanvas('canvas-b3-route-manifest', { nodes: [], edges: [] }, 'project-b3-route-manifest');
  database.initializeCanvasResourceGrantsForSharing(
    'project-b3-route-manifest',
    'canvas-b3-route-manifest',
    { actorId: 'local-owner', sessionId: 'route-manifest-fixture' },
  );
  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    COLLAB_ALLOWED_ORIGINS: [],
    COLLAB_PUBLIC_BASE_URL: '',
    DATA_DIR: data,
    INPUT_DIR: input,
    OUTPUT_DIR: output,
    THUMBNAILS_DIR: thumbnails,
    ASSET_PREVIEWS_DIR: previews,
    ASSET_BLOB_DIR: blobs,
    COLLAB_UPLOAD_TEMP_DIR: uploads,
    FRONTEND_DIST: frontend,
  }, database);

  t.after(async () => {
    await gateway.stop();
    await gateway.uploadManager.startupGcPromise.catch(() => {});
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, frontend, privateRoot, database, gateway };
}

function invokeCapabilityGuard(gateway, role, capability) {
  const req = {
    collaborationSession: {
      role,
      capabilities: capabilitiesForRole(role),
    },
    headers: { host: '127.0.0.1:18767' },
    socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
    get(name) { return this.headers[String(name).toLowerCase()] || ''; },
  };
  const result = { next: false, status: null, body: null };
  const res = {
    status(value) { result.status = value; return this; },
    json(value) { result.body = value; return this; },
  };
  gateway.requireCapability(capability)(req, res, () => { result.next = true; });
  return result;
}

function rawRequest(port, requestPath, method, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers,
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    if (body != null && method !== 'GET' && method !== 'HEAD') request.write(body);
    request.end();
  });
}

test('B3 public gateway route registry, source contract, and explicit permission manifest stay identical', async (t) => {
  const fixture = createFixture(t);
  const manifest = readManifest();
  const { middleware: sourceMiddleware, routes: sourceRoutes } = sourceRouteContract();
  const manifestSourceContract = manifest.routes.map((route) => ({
    method: route.method,
    path: route.path,
    capability: route.capability,
    scope: route.scope,
  }));
  assertMiddlewareContract(sourceMiddleware, manifest);
  assert.deepEqual(
    sourceRoutes,
    manifestSourceContract,
    '新增、删除、重排或改权的公开协作路由必须先显式更新并复审权限 manifest',
  );

  const runtimeRoutes = runtimeRouteContract(fixture.gateway.createApp());
  assert.deepEqual(
    runtimeRoutes,
    sourceRoutes.map(({ method, path }) => ({ method, path })),
    'Express 真实注册表必须与源码发现结果逐项、逐序一致',
  );

  const uniqueMiddleware = new Set(manifest.middleware.map((entry) => entry.authority));
  assert.equal(uniqueMiddleware.size, manifest.middleware.length, 'middleware authority 必须明确且唯一');
  for (const entry of manifest.middleware) {
    assert.match(entry.authority, /^[a-z][a-z0-9-]{2,80}$/);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  }

  const uniqueRoutes = new Set(manifest.routes.map((route) => `${route.method} ${route.path}`));
  assert.equal(uniqueRoutes.size, manifest.routes.length, '权限 manifest 不允许重复 method/path');
  const observedVerbs = new Set(manifest.routes.map((route) => route.method));
  observedVerbs.add('HEAD');
  assert.deepEqual([...observedVerbs].sort(), [...COMMON_HTTP_VERBS]);

  const knownCapabilities = new Set(Object.values(ROLE_CAPABILITIES).flat());
  for (const route of manifest.routes) {
    assert.ok(['public', 'session', 'resource'].includes(route.scope), `${route.method} ${route.path}`);
    assert.ok(route.capability == null || knownCapabilities.has(route.capability), `${route.method} ${route.path}`);
    if (route.scope === 'public') assert.equal(route.capability, null, `${route.method} ${route.path}`);
    if (MUTATING_HTTP_VERBS.has(route.method) && route.capability == null && route.method !== 'OPTIONS') {
      assert.match(
        String(route.handlerAuthority || ''),
        /^[a-z][a-z0-9-]{2,80}$/,
        `${route.method} ${route.path} 必须声明 capability 或明确的 handlerAuthority`,
      );
    }
  }
});

test('B3 route capability matrix denies every owner/editor/reviewer/viewer mismatch through the production guard', async (t) => {
  const fixture = createFixture(t);
  const { routes: manifest } = readManifest();
  const roles = ['owner', 'editor', 'reviewer', 'viewer'];
  const capabilities = [...new Set(Object.values(ROLE_CAPABILITIES).flat())].sort();

  for (const role of roles) {
    const allowed = new Set(ROLE_CAPABILITIES[role]);
    for (const capability of capabilities) {
      const result = invokeCapabilityGuard(fixture.gateway, role, capability);
      if (allowed.has(capability)) {
        assert.equal(result.next, true, `${role} should pass ${capability}`);
        assert.equal(result.status, null, `${role} ${capability}`);
      } else {
        assert.equal(result.next, false, `${role} must not pass ${capability}`);
        assert.equal(result.status, 403, `${role} ${capability}`);
        assert.match(String(result.body?.error || ''), new RegExp(capability));
      }
    }
  }

  for (const route of manifest.filter((entry) => entry.capability)) {
    for (const role of roles) {
      const expected = ROLE_CAPABILITIES[role].includes(route.capability);
      const result = invokeCapabilityGuard(fixture.gateway, role, route.capability);
      assert.equal(
        result.next,
        expected,
        `${route.method} ${route.path}: ${role} / ${route.capability}`,
      );
    }
  }
});

test('B3 source audit rejects alternate or unknown Express registration shapes', () => {
  const source = fs.readFileSync(GATEWAY_SOURCE_FILE, 'utf8');
  const anchor = "app.disable('x-powered-by');";
  assert.ok(source.includes(anchor));
  const registrations = [
    "app.all('/api/collab/hidden', (_req, res) => res.end())",
    "app.route('/api/collab/hidden').get((_req, res) => res.end())",
    "app['get']('/api/collab/hidden', (_req, res) => res.end())",
    "app.trace('/api/collab/hidden', (_req, res) => res.end())",
    "app.use('/api/collab/hidden', (_req, res) => res.end())",
    "app.use(dynamicCollaborationMount, (_req, res) => res.end())",
  ];
  for (const registration of registrations) {
    const mutated = source.replace(anchor, `${anchor}\n    ${registration};`);
    assert.throws(
      () => {
        const contract = sourceRouteContract(mutated);
        assertMiddlewareContract(contract.middleware, readManifest());
      },
      /禁止使用计算属性|未纳入审计|字符串字面量|middleware manifest/,
      registration,
    );
  }
});

test('B3 TEMP frontend exposes its assets and SPA only while every private surface stays unreachable for all common verbs', async (t) => {
  const fixture = createFixture(t);
  const status = await fixture.gateway.start({ host: '127.0.0.1', port: 0 });
  const invite = fixture.gateway.auth.createInvite({
    projectId: 'project-b3-route-manifest',
    canvasId: 'canvas-b3-route-manifest',
    role: 'viewer',
    maxUses: 1,
  });
  const participant = fixture.gateway.auth.redeemInvite(invite.code, 'B3 route manifest viewer');
  assert.ok(participant?.token);
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(participant.token)}`;
  const generation = fixture.database.getRecoveryGeneration();

  const publicAsset = await rawRequest(status.port, '/assets/app.js', 'GET');
  assert.equal(publicAsset.status, 200);
  assert.equal(publicAsset.body, 'globalThis.__T8_PUBLIC_ASSET_B3__ = true;\n');
  const publicAssetHead = await rawRequest(status.port, '/assets/app.js', 'HEAD');
  assert.equal(publicAssetHead.status, 200);
  assert.equal(publicAssetHead.body, '');
  const spa = await rawRequest(status.port, '/collab/canvas-b3-route-manifest', 'GET');
  assert.equal(spa.status, 200);
  assert.match(spa.body, /PUBLIC_FRONTEND_B3/);
  for (const method of COMMON_HTTP_VERBS.filter((verb) => !['GET', 'HEAD'].includes(verb))) {
    const deniedAssetVerb = await rawRequest(status.port, '/assets/app.js', method);
    assert.equal(deniedAssetVerb.status, 404, `${method} public asset`);
  }

  const privateApiTails = [
    'settings/raw',
    'commands',
    'command/run',
    'shell',
    'terminal',
    'files/open',
    'files/import',
    'files/local-path',
    'proxy?url=http%3A%2F%2F127.0.0.1%2F',
    'providers',
    'external-providers',
    'plugins',
  ];
  const privatePaths = [
    ...privateApiTails.flatMap((tail) => [`/api/${tail}`, `/api/collab/${tail}`]),
    '/input/host-secret.txt',
    '/output/host-secret.txt',
    '/data/host-secret.txt',
    '/thumbnails/host-secret.txt',
    '/files/input/host-secret.txt',
    '/files/output/host-secret.txt',
    '/.env',
    '/package.json',
    '/backend/src/config.js',
  ];
  const commonHeaders = {
    cookie,
    'content-type': 'application/json',
    'x-t8-canvas-generation': generation,
  };
  for (const requestPath of privatePaths) {
    for (const method of COMMON_HTTP_VERBS) {
      let response;
      try {
        response = await rawRequest(status.port, requestPath, method, commonHeaders, '{}');
      } catch (error) {
        error.message = `${method} ${requestPath}: ${error.message}`;
        throw error;
      }
      assert.equal(response.status, 404, `${method} ${requestPath}: ${response.status} ${response.body}`);
      assert.doesNotMatch(response.body, /PRIVATE_HOST_SENTINEL_B3|private-host-root|t8-collab-route-manifest-b3/i);
    }
  }

  const privateDirectoryName = path.basename(fixture.privateRoot);
  const traversalPaths = [
    `/assets/%2e%2e/${privateDirectoryName}/host-secret.txt`,
    `/assets/%2e%2e%2f${privateDirectoryName}%2fhost-secret.txt`,
    `/assets/%252e%252e%252f${privateDirectoryName}%252fhost-secret.txt`,
    `/%2e%2e%2f${privateDirectoryName}%2fhost-secret.txt`,
  ];
  for (const requestPath of traversalPaths) {
    for (const method of COMMON_HTTP_VERBS) {
      let response;
      try {
        response = await rawRequest(status.port, requestPath, method, commonHeaders, '{}');
      } catch (error) {
        error.message = `${method} ${requestPath}: ${error.message}`;
        throw error;
      }
      assert.ok([400, 403, 404].includes(response.status), `${method} ${requestPath}: ${response.status}`);
      assert.doesNotMatch(response.body, /PRIVATE_HOST_SENTINEL_B3|t8-collab-route-manifest-b3/i);
    }
  }
});
