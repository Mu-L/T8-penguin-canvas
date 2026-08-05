const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const express = require('express');
const sharp = require('sharp');
const { resolvePublicAddress } = require('../backend/src/utils/safeRemoteMediaFetch');
const { providerSubmissionContextMiddleware } = require('../backend/src/services/providerSubmissionContext');

const config = require('../backend/src/config');
const seedanceNzProvider = require('../backend/src/providers/seedanceNz');
const originalProxyMediaMaxBytes = process.env.T8_PROXY_MEDIA_REFERENCE_MAX_BYTES;
const originalProxyImageMaxBytes = process.env.T8_PROXY_IMAGE_REFERENCE_MAX_BYTES;
process.env.T8_PROXY_MEDIA_REFERENCE_MAX_BYTES = String(1024 * 1024);
process.env.T8_PROXY_IMAGE_REFERENCE_MAX_BYTES = String(1024 * 1024);
const proxyRouter = require('../backend/src/routes/proxy');
if (originalProxyMediaMaxBytes === undefined) delete process.env.T8_PROXY_MEDIA_REFERENCE_MAX_BYTES;
else process.env.T8_PROXY_MEDIA_REFERENCE_MAX_BYTES = originalProxyMediaMaxBytes;
if (originalProxyImageMaxBytes === undefined) delete process.env.T8_PROXY_IMAGE_REFERENCE_MAX_BYTES;
else process.env.T8_PROXY_IMAGE_REFERENCE_MAX_BYTES = originalProxyImageMaxBytes;

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

function runWithProviderSubmission(key, callback) {
  return new Promise((resolve, reject) => {
    providerSubmissionContextMiddleware({
      get(name) {
        return String(name).toLowerCase() === 'x-t8-provider-submission' ? key : '';
      },
    }, {}, () => {
      Promise.resolve().then(callback).then(resolve, reject);
    });
  });
}

async function startProxyApp() {
  const app = express();
  app.use(express.json({ limit: '2mb', strict: true }));
  app.use('/api/proxy', proxyRouter);
  return listen(app);
}

async function requestJson(server, pathname, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body ?? {}));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        ...extraHeaders,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        resolve({ status: res.statusCode, data, text });
      });
    });
    req.once('error', reject);
    req.end(payload);
  });
}

async function requestGet(server, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method: 'GET',
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        resolve({ status: res.statusCode, data, text });
      });
    });
    req.once('error', reject);
    req.end();
  });
}

async function withProxyFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b3-proxy-'));
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'output');
  const thumbnailDir = path.join(root, 'thumbnails');
  const settingsFile = path.join(root, 'settings.json');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(thumbnailDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({
    zhenzhenApiKey: 'provider-secret-key',
    llmApiKey: 'llm-provider-secret-key',
    rhApiKey: 'runninghub-secret-key',
  }));
  const previous = {
    SETTINGS_FILE: config.SETTINGS_FILE,
    INPUT_DIR: config.INPUT_DIR,
    OUTPUT_DIR: config.OUTPUT_DIR,
    THUMBNAILS_DIR: config.THUMBNAILS_DIR,
    ZHENZHEN_BASE_URL: config.ZHENZHEN_BASE_URL,
  };
  Object.assign(config, {
    SETTINGS_FILE: settingsFile,
    INPUT_DIR: inputDir,
    OUTPUT_DIR: outputDir,
    THUMBNAILS_DIR: thumbnailDir,
    ZHENZHEN_BASE_URL: 'https://ai.t8star.org',
  });
  const appServer = await startProxyApp();
  try {
    return await run({ root, inputDir, outputDir, settingsFile, appServer });
  } finally {
    proxyRouter._test.setProxySafeRemoteTestOptions(null);
    await closeServer(appServer);
    Object.assign(config, previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('B3 mounted canvas image references trust valid magic over a stale filename subtype', async () => {
  await withProxyFixture(async ({ inputDir }) => {
    const jpeg = await sharp({
      create: {
        width: 8,
        height: 4,
        channels: 3,
        background: { r: 170, g: 15, b: 35 },
      },
    }).jpeg().toBuffer();
    const misleadingName = 'reference-card.png';
    fs.writeFileSync(path.join(inputDir, misleadingName), jpeg);

    const references = [
      `/files/input/${misleadingName}`,
      `http://127.0.0.1:${config.PORT}/files/input/${misleadingName}`,
      `http://127.0.0.1:11422/files/input/${misleadingName}`,
    ];
    for (const reference of references) {
      const converted = await proxyRouter._test.refToBuffer(reference);
      assert.ok(converted);
      assert.equal(converted.mime, 'image/jpeg');
      assert.equal(converted.ext, 'jpg');
      assert.deepEqual(converted.buf, jpeg);
    }

    fs.writeFileSync(path.join(inputDir, 'not-an-image.png'), Buffer.from('<html>not media</html>'));
    await assert.rejects(
      () => proxyRouter._test.refToBuffer('/files/input/not-an-image.png'),
      /HTML\/JSON|不是媒体文件/,
    );
  });
});

function captureConsoleErrors() {
  const messages = [];
  const original = console.error;
  console.error = (...args) => { messages.push(args.map(String).join(' ')); };
  return {
    messages,
    restore() { console.error = original; },
  };
}

test('B3 proxy diagnostics use opaque references and redact credentials, paths, and signed URLs', () => {
  const prompt = 'private creative prompt Authorization: Bearer prompt-secret';
  const signedUrl = 'https://cdn.example/private/output.png?token=signed-secret&x-amz-signature=abcdef';
  const failure = 'Bearer failure-secret C:\\Users\\host\\private.txt apiKey=provider-secret';

  const promptSummary = proxyRouter._test.opaqueDiagnosticSummary('prompt', prompt);
  assert.match(promptSummary, /^promptLength=\d+ promptSha256=[0-9a-f]{12}$/);
  assert.doesNotMatch(promptSummary, /private creative|prompt-secret|Bearer/);

  const refSummary = proxyRouter._test.summarizeImageRef(signedUrl, 0);
  assert.match(refSummary, /^#1 refLength=\d+ refSha256=[0-9a-f]{12}$/);
  assert.doesNotMatch(refSummary, /signed-secret|x-amz|cdn\.example/);

  const shape = JSON.stringify(proxyRouter._test.summarizeRunningHubOutputShape({ signedUrl }));
  assert.match(shape, /refSha256/);
  assert.doesNotMatch(shape, /signed-secret|x-amz-signature|cdn\.example/);

  const safeFailure = proxyRouter._test.safeDiagnosticText(failure);
  assert.doesNotMatch(safeFailure, /failure-secret|provider-secret|Users|private\.txt/);
  assert.match(safeFailure, /\[redacted/);

  const jsonCredentialFailure = proxyRouter._test.safeDiagnosticText(
    '{"token":"json-token-secret","X-Api-Key":"json-api-secret","detail":"safe"}',
  );
  assert.doesNotMatch(jsonCredentialFailure, /json-token-secret|json-api-secret/);
  assert.match(jsonCredentialFailure, /detail/);
  assert.doesNotMatch(
    proxyRouter._test.safeDiagnosticText(
      'Invalid API key provider-secret-key',
      240,
      ['provider-secret-key'],
    ),
    /provider-secret-key/,
  );

  assert.equal(proxyRouter._test.safeFalRequestId('.'), '');
  assert.equal(proxyRouter._test.safeFalRequestId('..'), '');
  const manifestSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'falToolboxManifest.ts'), 'utf8');
  const manifestTools = [...manifestSource.matchAll(/tool\(\{\s*id:\s*'([^']+)'[\s\S]*?endpoint:\s*'([^']+)'/g)];
  assert.equal(manifestTools.length, 58);
  assert.equal(Object.keys(proxyRouter._test.FAL_TOOLBOX_AUTHORITY).length, manifestTools.length);
  for (const [, toolId, endpoint] of manifestTools) {
    assert.equal(proxyRouter._test.FAL_TOOLBOX_AUTHORITY[toolId]?.endpoint, endpoint, `server authority drift for ${toolId}`);
  }
});

test('B3 Provider JSON parsing enforces byte and structure budgets', async () => {
  const plainSecretBody = 'provider-json-token-secret';
  await assert.rejects(
    proxyRouter._test.parseJsonResponse(new Response(plainSecretBody, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }), 'plain secret fixture'),
    (error) => {
      assert.doesNotMatch(String(error?.message || ''), /provider-json-token-secret/);
      assert.match(String(error?.message || ''), /bodyLength=26 bodySha256=[0-9a-f]{12}/);
      return true;
    },
  );

  const oversized = new Response(JSON.stringify({ data: 'x'.repeat((2 * 1024 * 1024) + 64) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(
    proxyRouter._test.parseJsonResponse(oversized, 'oversized fixture'),
    (error) => error?.code === 'provider_response_too_large',
  );

  let nested = { value: true };
  for (let depth = 0; depth < 70; depth += 1) nested = { child: nested };
  await assert.rejects(
    proxyRouter._test.parseJsonResponse(new Response(JSON.stringify(nested), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }), 'deep fixture'),
    (error) => error?.code === 'json_too_complex',
  );

  const stalledBody = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('{"partial":'));
    },
  });
  const startedAt = Date.now();
  await assert.rejects(
    proxyRouter._test.parseJsonResponse(new Response(stalledBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }), 'stalled fixture', { deadlineMs: 120, idleTimeoutMs: 40 }),
    (error) => error?.code === 'provider_response_timeout',
  );
  assert.ok(Date.now() - startedAt < 1_000, 'stalled Provider body must release the route within its deadline');

  const stalledNodeBody = new PassThrough();
  stalledNodeBody.write('{"partial":');
  await assert.rejects(
    proxyRouter._test.parseJsonResponse({
      body: stalledNodeBody,
      status: 200,
      headers: { get: () => null },
    }, 'stalled Node stream fixture', { deadlineMs: 120, idleTimeoutMs: 40 }),
    (error) => error?.code === 'provider_response_timeout',
  );
  assert.equal(stalledNodeBody.destroyed, true);
});

test('B3 Provider fetch deadline covers DNS, connect, TLS, and response headers', async () => {
  const originalFetch = global.fetch;
  proxyRouter._test.setProxySafeRemoteTestOptions({ providerDeadlineMs: 40 });
  global.fetch = () => new Promise(() => {});
  const startedAt = Date.now();
  try {
    await assert.rejects(
      proxyRouter._test.fetchProviderResponse('https://provider.example/hangs', {}, 'header fixture'),
      (error) => error?.code === 'provider_response_timeout' && error?.status === 504,
    );
    assert.ok(Date.now() - startedAt < 1_000, 'response-header wait must stop at the shared Provider deadline');
  } finally {
    global.fetch = originalFetch;
    proxyRouter._test.setProxySafeRemoteTestOptions(null);
  }
});

test('B3 Provider fetch supports a longer model-specific deadline without changing the generic default', async () => {
  const originalFetch = global.fetch;
  proxyRouter._test.setProxySafeRemoteTestOptions(null);
  let signal;
  global.fetch = async (_url, init) => {
    signal = init?.signal;
    await new Promise((resolve) => setTimeout(resolve, 70));
    return new Response('ok', { status: 200 });
  };
  try {
    const response = await proxyRouter._test.fetchProviderResponse(
      'https://provider.example/slow-model',
      { method: 'POST', body: '{"prompt":"safe"}' },
      'slow synchronous Provider',
      { deadlineMs: 120, noRetry: true },
    );
    assert.equal(response.status, 200);
    assert.equal(signal?.aborted, false);
  } finally {
    global.fetch = originalFetch;
    proxyRouter._test.setProxySafeRemoteTestOptions(null);
  }
});

test('B3 Provider requests preserve native system networking first and replay writes only with one stable idempotency key', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const readDispatchers = [];
  proxyRouter._test.setProxySafeRemoteTestOptions({ providerRetryDelayMs: 1 });
  try {
    global.fetch = async (_url, init) => {
      calls += 1;
      readDispatchers.push(init?.dispatcher);
      if (calls === 1) {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('socket reset after TUN switch'), { code: 'ECONNRESET' }),
        });
      }
      return new Response('ok', { status: 200 });
    };
    const recovered = await proxyRouter._test.fetchProviderResponse(
      'https://provider.example/query',
      { method: 'GET' },
      'Provider query',
    );
    assert.equal(recovered.status, 200);
    assert.equal(calls, 2, 'read-only Provider queries may retry once after refreshing the connection pool');
    assert.equal(
      readDispatchers[0],
      undefined,
      'the primary Provider request must preserve the runtime/system network path used by v2.5.3',
    );
    assert.notEqual(readDispatchers[0], readDispatchers[1]);
    assert.equal(
      readDispatchers[1],
      proxyRouter._test.currentProviderDispatcher(false),
      'the recovery query must use a fresh system-DNS connection without bypassing the active proxy/TUN path',
    );

    calls = 0;
    const writeKeys = [];
    global.fetch = async (_url, init) => {
      calls += 1;
      writeKeys.push(new Headers(init?.headers).get('Idempotency-Key'));
      if (calls === 1) {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('network unreachable after TUN switch'), { code: 'ENETUNREACH' }),
        });
      }
      return new Response('accepted', { status: 202 });
    };
    const recoveredWrite = await runWithProviderSubmission(
      'attempt-image-tun-0001',
      () => proxyRouter._test.fetchProviderResponse(
        'https://provider.example/generate',
        { method: 'POST', body: '{"prompt":"safe"}' },
        'Provider submit',
      ),
    );
    assert.equal(recoveredWrite.status, 202);
    assert.equal(calls, 2, 'a generation POST with a stable submission identity retries once on a fresh connection');
    assert.deepEqual(
      writeKeys,
      ['attempt-image-tun-0001', 'attempt-image-tun-0001'],
      'the recovery attempt must carry exactly the same upstream idempotency key',
    );

    calls = 0;
    global.fetch = async () => {
      calls += 1;
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('network unreachable after TUN switch'), { code: 'ENETUNREACH' }),
      });
    };
    await assert.rejects(
      proxyRouter._test.fetchProviderResponse(
        'https://provider.example/legacy-generate',
        { method: 'POST', body: '{"prompt":"safe"}' },
        'Legacy Provider submit',
      ),
      (error) => {
        assert.equal(error?.code, 'provider_network_unavailable');
        assert.equal(error?.status, 503);
        assert.equal(error?.recoverable, true);
        assert.equal(error?.retryAfterMs, 3_000);
        assert.equal(error?.retryAttempted, false);
        assert.doesNotMatch(String(error?.message || ''), /关闭.*(?:代理|TUN|VPN)/);
        return true;
      },
    );
    assert.equal(calls, 1, 'legacy writes without a stable submission key must not be replayed');

    calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('socket reset after TUN switch'), { code: 'ECONNRESET' }),
        });
      }
      return new Response('ok', { status: 200 });
    };
    const recoveredReadPost = await proxyRouter._test.fetchProviderResponse(
      'https://provider.example/task/outputs',
      { method: 'POST', body: '{"taskId":"existing-task"}' },
      'Provider read-only POST query',
      { retryNetwork: true },
    );
    assert.equal(recoveredReadPost.status, 200);
    assert.equal(calls, 2, 'explicitly marked read-only POST queries may retry without resubmitting generation');
  } finally {
    global.fetch = originalFetch;
    proxyRouter._test.setProxySafeRemoteTestOptions(null);
    await proxyRouter._test.resetProviderDispatcherForTests();
  }
});

test('B3 pinned media requests disable the global Agent so TUN/VPN route changes cannot reuse an old socket', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../backend/src/utils/safeRemoteMediaFetch.js'),
    'utf8',
  );
  assert.match(
    source,
    /transport\.request\(target,\s*\{[\s\S]*?agent:\s*false,[\s\S]*?lookup\(/,
    'each DNS-pinned media request must open a fresh socket before applying its pinned lookup',
  );
});

test('B3 Provider fallback lookup prefers usable IPv4 while retaining IPv6-only support', async () => {
  const records = await new Promise((resolve, reject) => {
    proxyRouter._test.providerPublicDnsLookup(
      'provider.example',
      { all: true },
      (error, addresses) => error ? reject(error) : resolve(addresses),
      async () => [
        { address: '2001:4860:4860::8888', family: 6 },
        { address: '93.184.216.34', family: 4 },
      ],
    );
  });
  assert.deepEqual(records, [
    { address: '93.184.216.34', family: 4 },
    { address: '2001:4860:4860::8888', family: 6 },
  ]);

  const ipv6Only = await new Promise((resolve, reject) => {
    proxyRouter._test.providerPublicDnsLookup(
      'ipv6-provider.example',
      { all: true },
      (error, addresses) => error ? reject(error) : resolve(addresses),
      async () => [{ address: '2001:4860:4860::8844', family: 6 }],
    );
  });
  assert.deepEqual(ipv6Only, [{ address: '2001:4860:4860::8844', family: 6 }]);

  const seedanceRecords = await new Promise((resolve, reject) => {
    seedanceNzProvider.seedancePublicDnsLookup(
      'api.seedance.nz',
      { all: true },
      (error, addresses) => error ? reject(error) : resolve(addresses),
      async () => [
        { address: '2606:4700::6810:85e5', family: 6 },
        { address: '104.16.133.229', family: 4 },
      ],
    );
  });
  assert.deepEqual(seedanceRecords, [
    { address: '104.16.133.229', family: 4 },
    { address: '2606:4700::6810:85e5', family: 6 },
  ]);

  const literalIpv6 = await new Promise((resolve, reject) => {
    proxyRouter._test.providerPublicDnsLookup(
      '2606:4700::6810:85e5',
      { all: true },
      (error, addresses) => error ? reject(error) : resolve(addresses),
    );
  });
  assert.deepEqual(literalIpv6, [{ address: '2606:4700::6810:85e5', family: 6 }]);
});

test('B3 completed task query interruptions retain the original task and never submit a replacement', async () => {
  await withProxyFixture(async ({ appServer }) => {
    const originalFetch = global.fetch;
    const providerCalls = [];
    proxyRouter._test.setProxySafeRemoteTestOptions({ providerRetryDelayMs: 1 });
    try {
      global.fetch = async (url, init = {}) => {
        providerCalls.push({
          url: String(url),
          method: String(init?.method || 'GET').toUpperCase(),
          body: String(init?.body || ''),
        });
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('route changed after IPv6/TUN/VPN switch'), {
            code: 'ENETUNREACH',
          }),
        });
      };

      const cases = [
        {
          path: '/api/proxy/image/status/existing-image-task?model=gpt-image-2',
          taskId: 'existing-image-task',
        },
        {
          path: '/api/proxy/mj/task/existing-midjourney-task',
          taskId: 'existing-midjourney-task',
        },
        {
          path: '/api/proxy/video/query?taskId=existing-video-task&model=veo-3.1',
          taskId: 'existing-video-task',
        },
        {
          path: '/api/proxy/audio/query?clipIds=existing-audio-task&saveLocal=false',
          taskId: 'existing-audio-task',
        },
        {
          path: '/api/proxy/runninghub/query?taskId=existing-rh-task&site=cn',
          taskId: 'existing-rh-task',
        },
      ];

      for (const fixture of cases) {
        const response = await requestGet(appServer, fixture.path);
        assert.equal(response.status, 202, response.text);
        assert.equal(response.data?.success, true);
        assert.equal(response.data?.code, 'task_result_query_recovering');
        assert.equal(response.data?.data?.taskId, fixture.taskId);
        assert.equal(response.data?.data?.recoverable, true);
        assert.equal(response.data?.data?.retryAfterMs, 3_000);
        assert.match(response.data?.message || '', /原任务 ID/);
        assert.match(response.data?.message || '', /不会重新生成/);
        assert.match(response.data?.message || '', /不会重复扣费/);
      }

      assert.equal(
        providerCalls.length,
        cases.length * 2,
        'each read-only result query may retry once on a fresh connection',
      );
      assert.equal(
        providerCalls.filter((call) => call.method === 'POST').length,
        2,
        'only the RunningHub read-only query may use POST, including its one recovery attempt',
      );
      assert.ok(
        providerCalls
          .filter((call) => call.method === 'POST')
          .every((call) => call.url.includes('/task/openapi/outputs') && call.body.includes('existing-rh-task')),
        'read-only POST recovery must keep the original RunningHub task id',
      );
      assert.ok(
        providerCalls.every((call) => (
          call.method !== 'POST'
          || !/\/(?:generate|generations|submit)(?:\/|$|\?)/i.test(call.url)
        )),
        `a query/download recovery must never call a generation submission endpoint: ${JSON.stringify(providerCalls)}`,
      );
    } finally {
      global.fetch = originalFetch;
      proxyRouter._test.setProxySafeRemoteTestOptions(null);
      await proxyRouter._test.resetProviderDispatcherForTests();
    }
  });
});

test('B3 refToBuffer, refToGrokImage, and uploadRefToZhenzhen routes reject collaborator private media before connect', async () => {
  let privateHits = 0;
  const privateServer = await listen((_req, res) => {
    privateHits += 1;
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
  const signedPrivateUrl = `http://127.0.0.1:${privateServer.address().port}/host-private.png?token=signed-secret`;
  const captured = captureConsoleErrors();
  const originalFetch = global.fetch;
  let providerFetches = 0;
  global.fetch = async () => {
    providerFetches += 1;
    throw new Error('provider fetch must not happen for a rejected media reference');
  };
  try {
    await withProxyFixture(async ({ appServer, root, outputDir }) => {
      const runningHub = await requestJson(appServer, '/api/proxy/runninghub/upload-asset', {
        url: signedPrivateUrl,
        site: 'cn',
      });
      assert.equal(runningHub.status, 400, runningHub.text);

      const image = await requestJson(appServer, '/api/proxy/image/submit', {
        apiModel: 'gpt-image-2',
        model: 'gpt-image-2',
        paramKind: 'gpt-size',
        prompt: 'private creative prompt Authorization: Bearer prompt-secret',
        images: [signedPrivateUrl],
      });
      assert.equal(image.status, 500, image.text);

      const grokImage = await requestJson(appServer, '/api/proxy/image/submit', {
        apiModel: 'grok-imagine-image',
        model: 'grok-imagine-image',
        paramKind: 'grok-image',
        prompt: 'private creative prompt Authorization: Bearer prompt-secret',
        images: [signedPrivateUrl],
      });
      assert.equal(grokImage.status, 500, grokImage.text);

      const grokVideo = await requestJson(appServer, '/api/proxy/video/submit', {
        model: 'grok-imagine-video',
        prompt: 'private creative prompt Authorization: Bearer prompt-secret',
        images: [signedPrivateUrl],
      });
      assert.equal(grokVideo.status, 500, grokVideo.text);

      const bananaToolbox = await requestJson(appServer, '/api/proxy/fal-toolbox/submit', {
        toolId: 'gpt-image-2-fal-edit',
        endpoint: 'openai/gpt-image-2/edit',
        payload: { prompt: 'edit safely', image_urls: [signedPrivateUrl] },
        mediaFields: [],
        outputSchema: [{ key: 'url', kind: 'model3d', pathCandidates: ['url'] }],
      });
      assert.equal(bananaToolbox.status, 500, bananaToolbox.text);

      const wrongPortFile = path.join(outputDir, 'wrong-port-secret.png');
      fs.writeFileSync(wrongPortFile, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('wrong-port-local-secret'),
      ]));
      const wrongPort = await requestJson(appServer, '/api/proxy/image/submit', {
        apiModel: 'gpt-image-2',
        model: 'gpt-image-2',
        paramKind: 'gpt-size',
        prompt: 'wrong port must not map to a local mount',
        images: [`http://127.0.0.1:9/files/output/wrong-port-secret.png`],
      });
      assert.equal(wrongPort.status, 500, wrongPort.text);

      const exposure = `${runningHub.text}\n${image.text}\n${grokImage.text}\n${grokVideo.text}\n${bananaToolbox.text}\n${wrongPort.text}\n${captured.messages.join('\n')}`;
      assert.doesNotMatch(exposure, /signed-secret|prompt-secret|wrong-port-local-secret|provider-secret-key|runninghub-secret-key/);
      assert.doesNotMatch(exposure, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      assert.doesNotMatch(exposure, /host-private\.png/);
      assert.equal(privateHits, 0, 'private endpoint must not receive a TCP request');
      assert.equal(providerFetches, 0, 'rejected references must not reach a provider fetch');
    });
  } finally {
    global.fetch = originalFetch;
    captured.restore();
    await closeServer(privateServer);
  }
});

test('legacy Seedance upload resolves controlled absolute localhost media without an SSRF fetch', async () => {
  await withProxyFixture(async ({ appServer, outputDir }) => {
    const filename = 'seedance-controlled-local.png';
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 20, g: 180, b: 90, alpha: 1 },
      },
    }).png().toFile(path.join(outputDir, filename));

    const originalFetch = global.fetch;
    const providerRequests = [];
    global.fetch = async (url, init = {}) => {
      providerRequests.push({ url: String(url), body: init.body });
      if (String(url).endsWith('/v1/files')) {
        assert.ok(init.body instanceof FormData);
        return new Response(JSON.stringify({ url: 'https://cdn.example.com/seedance-local.png' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).endsWith('/seedance/v3/contents/generations/tasks')) {
        const payload = JSON.parse(String(init.body || '{}'));
        assert.equal(payload.content?.[1]?.image_url?.url, 'https://cdn.example.com/seedance-local.png');
        return new Response(JSON.stringify({ id: 'seedance-local-task' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected Provider URL: ${url}`);
    };

    try {
      const result = await requestJson(appServer, '/api/proxy/seedance/submit', {
        taskProvider: 'zhenzhen-legacy',
        model: 'doubao-seedance-2-0-fast-260128',
        prompt: 'controlled local upload regression',
        duration: 4,
        ratio: '16:9',
        resolution: '720p',
        generate_audio: false,
        firstFrame: `http://127.0.0.1:${config.PORT}/files/output/${filename}?cache=1`,
      });

      assert.equal(result.status, 200, result.text);
      assert.equal(result.data?.data?.taskId, 'seedance-local-task');
      assert.equal(providerRequests.length, 2);
      assert.ok(providerRequests.every((request) => !request.url.includes('127.0.0.1')));
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('B3 RunningHub upload route enforces encoded traversal, symlink, max-byte, and media-magic boundaries', async () => {
  await withProxyFixture(async ({ appServer, root, outputDir }) => {
    const outside = path.join(root, 'settings-export.png');
    fs.writeFileSync(outside, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('local-file-secret'),
    ]));
    assert.equal(path.dirname(outside), path.dirname(outputDir));
    const originalFetch = global.fetch;
    let providerFetches = 0;
    const providerUploads = [];
    global.fetch = async (_url, options = {}) => {
      providerFetches += 1;
      const file = options.body?.get?.('file');
      providerUploads.push({
        name: String(file?.name || ''),
        type: String(file?.type || ''),
      });
      return new Response(JSON.stringify({ code: 0, data: { fileName: 'safe-upload.png', fileType: 'image/png' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const result = await requestJson(appServer, '/api/proxy/runninghub/upload-asset', {
        url: '/files/output/../settings-export.png',
        site: 'cn',
      });
      assert.equal(result.status, 404, result.text);
      assert.doesNotMatch(result.text, /local-file-secret|settings-export|t8-b3-proxy/i);
      assert.equal(providerFetches, 0);

      const encodedTraversal = await requestJson(appServer, '/api/proxy/runninghub/upload-asset', {
        url: '/files/output/%2e%2e/settings-export.png',
        site: 'cn',
      });
      assert.equal(encodedTraversal.status, 404, encodedTraversal.text);
      assert.equal(providerFetches, 0);

      const doubleEncodedTraversal = await requestJson(appServer, '/api/proxy/runninghub/upload-asset', {
        url: '/files/output/%252e%252e/settings-export.png',
        site: 'cn',
      });
      assert.equal(doubleEncodedTraversal.status, 404, doubleEncodedTraversal.text);
      assert.equal(providerFetches, 0);

      const outsideDir = path.join(root, 'outside-linked-dir');
      const linkedSecret = path.join(outsideDir, 'linked-secret.png');
      const linkDir = path.join(outputDir, 'linked-outside');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(linkedSecret, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('linked-local-secret'),
      ]));
      fs.symlinkSync(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
      const linked = await requestJson(appServer, '/api/proxy/runninghub/upload-asset', {
        url: '/files/output/linked-outside/linked-secret.png',
        site: 'cn',
      });
      assert.equal(linked.status, 404, linked.text);
      assert.doesNotMatch(linked.text, /linked-local-secret|linked-secret/i);
      assert.equal(providerFetches, 0);

      const oversized = path.join(outputDir, 'oversized.png');
      const oversizedBuffer = Buffer.alloc((1024 * 1024) + 1);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversizedBuffer);
      fs.writeFileSync(oversized, oversizedBuffer);
      const tooLarge = await requestJson(appServer, '/api/proxy/runninghub/upload-asset', {
        url: '/files/output/oversized.png',
        site: 'cn',
      });
      assert.equal(tooLarge.status, 404, tooLarge.text);
      assert.equal(providerFetches, 0);

      fs.writeFileSync(path.join(outputDir, 'fake.png'), Buffer.from('not an image: magic-secret'));
      const badMagic = await requestJson(appServer, '/api/proxy/runninghub/upload-asset', {
        url: '/files/output/fake.png',
        site: 'cn',
      });
      assert.equal(badMagic.status, 400, badMagic.text);
      assert.doesNotMatch(badMagic.text, /magic-secret/);
      assert.equal(providerFetches, 0);

      const disguisedJpeg = await sharp({
        create: { width: 2, height: 1, channels: 3, background: { r: 180, g: 20, b: 40 } },
      }).jpeg().toBuffer();
      fs.writeFileSync(path.join(outputDir, 'jpeg-disguised-as-png.png'), disguisedJpeg);
      const subtypeDrift = await requestJson(appServer, '/api/proxy/runninghub/upload-asset', {
        url: '/files/output/jpeg-disguised-as-png.png',
        site: 'cn',
      });
      assert.equal(subtypeDrift.status, 200, subtypeDrift.text);
      assert.equal(providerFetches, 1);
      assert.deepEqual(providerUploads[0], {
        name: 'jpeg-disguised-as-png.jpg',
        type: 'image/jpeg',
      });

      const overlongUrl = await requestJson(appServer, '/api/proxy/runninghub/upload-asset', {
        url: `https://example.invalid/${'x'.repeat(16_384)}`,
        site: 'cn',
      });
      assert.equal(overlongUrl.status, 400, overlongUrl.text);
      assert.equal(providerFetches, 1);

      const safeFile = path.join(outputDir, 'safe.png');
      const safePng = await sharp({
        create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 160, b: 255, alpha: 1 } },
      }).png().toBuffer();
      fs.writeFileSync(safeFile, safePng);
      const decoded = await sharp(safePng).raw().toBuffer({ resolveWithObject: true });
      assert.equal(decoded.info.width, 1);
      assert.equal(decoded.info.height, 1);
      const safe = await requestJson(appServer, '/api/proxy/runninghub/upload-asset', {
        url: '/files/output/safe.png',
        site: 'cn',
      });
      assert.equal(safe.status, 200, safe.text);
      assert.equal(safe.data.data.fileName, 'safe-upload.png');
      assert.equal(providerFetches, 2);
      assert.deepEqual(providerUploads[1], {
        name: 'safe.png',
        type: 'image/png',
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('B3 FAL actual query route binds Bearer fetches to the registered provider URL and rejects tampering', async () => {
  const pollCalls = [];
  const requestId = 'fal-b3-route-0001';
  const providerServer = await listen((req, res) => {
    pollCalls.push({ url: req.url, authorization: req.headers.authorization || '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'IN_PROGRESS',
      provider_secret: 'provider-raw-secret',
      debug_url: 'https://provider.example/debug?token=raw-signed-secret',
    }));
  });
  const providerBase = `http://provider.test:${providerServer.address().port}`;
  const responseUrl = `${providerBase}/fal/openai/gpt-image-2/requests/${requestId}?token=poll-secret&X-Amz-Signature=poll-signature`;
  try {
    await withProxyFixture(async ({ appServer }) => {
      config.ZHENZHEN_BASE_URL = providerBase;
      proxyRouter._test.setProxySafeRemoteTestOptions({
        allowPrivateForTests: (hostname) => hostname === 'provider.test',
        lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
      });
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), authorization: init.headers?.Authorization || init.headers?.authorization || '' });
      if (String(url) === `${providerBase}/fal/openai/gpt-image-2`) {
        return new Response(JSON.stringify({ request_id: requestId, response_url: responseUrl }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    try {
      const submitted = await requestJson(appServer, '/api/proxy/image/fal/submit', {
        apiModel: 'gpt-image-2-fal',
        prompt: 'safe prompt',
        mode: 'gen',
      });
      assert.equal(submitted.status, 200, submitted.text);
      assert.equal(Object.hasOwn(submitted.data.data, 'responseUrl'), false);
      assert.doesNotMatch(submitted.text, /poll-secret|poll-signature|X-Amz/i);

      proxyRouter._test.resetFalTaskRegistryMemoryForTests();

      const queried = await requestJson(appServer, '/api/proxy/image/fal/query', {
        requestId,
        endpoint: 'openai/gpt-image-2',
      });
      assert.equal(queried.status, 200, queried.text);
      assert.equal(queried.data.data.status, 'pending');
      assert.doesNotMatch(queried.text, /provider-raw-secret|raw-signed-secret|provider\.example/);
      assert.equal(calls.length, 1, 'FAL poll must not use ordinary fetch');
      assert.deepEqual(pollCalls, [{
        url: `/fal/openai/gpt-image-2/requests/${requestId}?token=poll-secret&X-Amz-Signature=poll-signature`,
        authorization: 'Bearer provider-secret-key',
      }]);

      const crossRoute = await requestJson(appServer, '/api/proxy/video/fal/query', {
        requestId,
        endpoint: 'xai/grok-imagine-video',
      });
      assert.equal(crossRoute.status, 409, crossRoute.text);
      assert.equal(pollCalls.length, 1, 'an image registry entry must not authorize a video poll');

      const tampered = await requestJson(appServer, '/api/proxy/image/fal/query', {
        requestId,
        endpoint: 'openai/gpt-image-2',
        responseUrl: 'http://127.0.0.1:9/steal?token=signed-secret',
      });
      assert.equal(tampered.status, 400, tampered.text);
      assert.doesNotMatch(tampered.text, /signed-secret|provider-secret-key|127\.0\.0\.1/);
      assert.equal(pollCalls.length, 1, 'tampered URL must be rejected before a Bearer fetch');
    } finally {
      global.fetch = originalFetch;
    }
    });
  } finally {
    await closeServer(providerServer);
  }
});

test('B3 image, video, and toolbox FAL polls share pinned redirects, byte bounds, and non-2xx JSON handling', async () => {
  let privateHits = 0;
  const privateServer = await listen((_req, res) => {
    privateHits += 1;
    res.end('{"status":"internal"}');
  });
  const providerPolls = [];
  const providerServer = await listen((req, res) => {
    providerPolls.push({ path: req.url, authorization: req.headers.authorization || '' });
    if (req.url.endsWith('/requests/image-private-redirect')) {
      res.writeHead(302, { Location: `http://127.0.0.1:${privateServer.address().port}/metadata` });
      res.end();
      return;
    }
    if (req.url.endsWith('/requests/video-oversize')) {
      res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
      res.write(Buffer.alloc(96, 0x20));
      res.end(Buffer.alloc(96, 0x20));
      return;
    }
    if (req.url.endsWith('/requests/toolbox-pending/status')) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'IN_QUEUE' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'FAILED' }));
  });
  const providerBase = `http://provider.test:${providerServer.address().port}`;
  try {
    await withProxyFixture(async ({ appServer }) => {
      config.ZHENZHEN_BASE_URL = providerBase;
      proxyRouter._test.setProxySafeRemoteTestOptions({
        allowPrivateForTests: (hostname) => hostname === 'provider.test',
        lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
        maxBytes: 128,
      });
      const originalFetch = global.fetch;
      global.fetch = async (url, init = {}) => {
        const target = String(url);
        const body = String(init.body || '');
        let requestId;
        let endpoint;
        if (target.endsWith('/fal/xai/grok-imagine-video/text-to-video')) {
          requestId = 'video-oversize';
          endpoint = 'xai/grok-imagine-video/text-to-video';
        } else if (body.includes('toolbox-prompt')) {
          requestId = 'toolbox-pending';
          endpoint = 'openai/gpt-image-2';
        } else {
          requestId = 'image-private-redirect';
          endpoint = 'openai/gpt-image-2';
        }
        const responseUrl = `${providerBase}/fal/${endpoint}/requests/${requestId}`;
        return new Response(JSON.stringify({
          request_id: requestId,
          response_url: responseUrl,
          status_url: requestId === 'toolbox-pending' ? `${responseUrl}/status` : undefined,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      try {
        const imageSubmit = await requestJson(appServer, '/api/proxy/image/fal/submit', {
          apiModel: 'gpt-image-2-fal', prompt: 'private redirect test', mode: 'gen',
        });
        assert.equal(imageSubmit.status, 200, imageSubmit.text);
        const imageQuery = await requestJson(appServer, '/api/proxy/image/fal/query', {
          requestId: 'image-private-redirect', endpoint: 'openai/gpt-image-2',
        });
        assert.notEqual(imageQuery.status, 200, imageQuery.text);
        assert.equal(privateHits, 0, 'FAL redirect to private address must stop before TCP connect');

        const videoSubmit = await requestJson(appServer, '/api/proxy/video/fal/submit', {
          apiModel: 'grok-video-fal', prompt: 'oversize poll test', gkMode: 'image_to_video',
        });
        assert.equal(videoSubmit.status, 200, videoSubmit.text);
        const videoQuery = await requestJson(appServer, '/api/proxy/video/fal/query', {
          requestId: 'video-oversize', endpoint: 'xai/grok-imagine-video/text-to-video',
        });
        assert.notEqual(videoQuery.status, 200, videoQuery.text);

        const toolboxSubmit = await requestJson(appServer, '/api/proxy/fal-toolbox/submit', {
          toolId: 'gpt-image-2-fal', endpoint: 'openai/gpt-image-2',
          payload: { prompt: 'toolbox-prompt' },
        });
        assert.equal(toolboxSubmit.status, 200, toolboxSubmit.text);
        const toolboxQuery = await requestJson(appServer, '/api/proxy/fal-toolbox/query', {
          requestId: 'toolbox-pending',
        });
        assert.equal(toolboxQuery.status, 200, toolboxQuery.text);
        assert.equal(toolboxQuery.data.data.status, 'pending');
        assert.equal(toolboxQuery.data.data.falStatus, 'IN_QUEUE');
        assert.ok(providerPolls.every((call) => call.authorization === 'Bearer provider-secret-key'));
      } finally {
        global.fetch = originalFetch;
      }
    });
  } finally {
    await closeServer(providerServer);
    await closeServer(privateServer);
  }
});

test('B3 FAL query fails closed without a matching task registry instead of accepting a body URL', async () => {
  await withProxyFixture(async ({ appServer }) => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      throw new Error('unregistered FAL query must not fetch');
    };
    try {
      const toolbox = await requestJson(appServer, '/api/proxy/fal-toolbox/query', {
        requestId: 'unregistered-toolbox-task',
        endpoint: 'fal-ai/example',
        responseUrl: 'https://attacker.example/steal',
        statusUrl: 'https://attacker.example/status',
      });
      assert.equal(toolbox.status, 400, toolbox.text);
      assert.equal(calls, 0);

      const image = await requestJson(appServer, '/api/proxy/image/fal/query', {
        requestId: 'unregistered-image-task',
        endpoint: 'openai/gpt-image-2',
        responseUrl: 'https://attacker.example/steal',
      });
      assert.equal(image.status, 409, image.text);
      assert.equal(calls, 0);

      const allowedEndpointOnly = await requestJson(appServer, '/api/proxy/image/fal/query', {
        requestId: 'arbitrary-other-users-task',
        endpoint: 'openai/gpt-image-2',
      });
      assert.equal(allowedEndpointOnly.status, 409, allowedEndpointOnly.text);
      assert.equal(calls, 0);

      const videoEndpointOnly = await requestJson(appServer, '/api/proxy/video/fal/query', {
        requestId: 'arbitrary-video-task',
        endpoint: 'xai/grok-imagine-video',
      });
      assert.equal(videoEndpointOnly.status, 409, videoEndpointOnly.text);
      assert.equal(calls, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('B3 FAL submit rejects dot request ids and binds toolbox endpoint/media schema to server toolId authority', async () => {
  await withProxyFixture(async ({ appServer }) => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ request_id: '..' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const invalidId = await requestJson(appServer, '/api/proxy/image/fal/submit', {
        apiModel: 'gpt-image-2-fal',
        prompt: 'safe prompt',
      });
      assert.equal(invalidId.status, 502, invalidId.text);
      assert.equal(calls, 1);

      const unknownTool = await requestJson(appServer, '/api/proxy/fal-toolbox/submit', {
        toolId: 'collaborator-invented-tool',
        endpoint: 'openai/gpt-image-2',
        payload: { prompt: 'safe' },
      });
      assert.equal(unknownTool.status, 400, unknownTool.text);

      const endpointSwap = await requestJson(appServer, '/api/proxy/fal-toolbox/submit', {
        toolId: 'gpt-image-2-fal',
        endpoint: 'xai/grok-imagine-video/text-to-video',
        payload: { prompt: 'safe' },
      });
      assert.equal(endpointSwap.status, 400, endpointSwap.text);

      const unboundMedia = await requestJson(appServer, '/api/proxy/fal-toolbox/submit', {
        toolId: 'gpt-image-2-fal',
        endpoint: 'openai/gpt-image-2',
        payload: { prompt: 'safe', callback_url: 'http://127.0.0.1:9/private' },
        mediaFields: [{ key: 'callback_url', kind: 'image', upload: false }],
      });
      assert.equal(unboundMedia.status, 500, unboundMedia.text);
      assert.equal(calls, 1, 'tool authority failures must not reach Provider fetch');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('B3 provider output downloads fail closed on private destinations for FAL and RunningHub routes', async () => {
  let privateHits = 0;
  const privateServer = await listen((_req, res) => {
    privateHits += 1;
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
  const privateOutput = `http://127.0.0.1:${privateServer.address().port}/provider-output.png?token=output-secret`;
  const requestId = 'fal-private-output-001';
  const providerServer = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ images: [{ url: privateOutput }] }));
  });
  const providerBase = `http://provider.test:${providerServer.address().port}`;
  const responseUrl = `${providerBase}/fal/openai/gpt-image-2/requests/${requestId}`;
  try {
    await withProxyFixture(async ({ appServer }) => {
      config.ZHENZHEN_BASE_URL = providerBase;
      proxyRouter._test.setProxySafeRemoteTestOptions({
        allowPrivateForTests: (hostname) => hostname === 'provider.test',
        lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
      });
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        const target = String(url);
        if (target === `${providerBase}/fal/openai/gpt-image-2`) {
          return new Response(JSON.stringify({ request_id: requestId, response_url: responseUrl }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (target.includes('/task/openapi/outputs')) {
          return new Response(JSON.stringify({ code: 0, data: [{ fileUrl: privateOutput, fileType: 'png' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected Provider fetch ${target}`);
      };
      try {
        const submit = await requestJson(appServer, '/api/proxy/image/fal/submit', {
          apiModel: 'gpt-image-2-fal',
          prompt: 'safe prompt',
        });
        assert.equal(submit.status, 200, submit.text);

        const query = await requestJson(appServer, '/api/proxy/image/fal/query', {
          requestId,
          endpoint: 'openai/gpt-image-2',
        });
        assert.equal(query.status, 502, query.text);
        assert.doesNotMatch(query.text, /output-secret|127\.0\.0\.1/);

        const runningHub = await requestGet(appServer, '/api/proxy/runninghub/query?taskId=rh-private-output&site=cn');
        assert.equal(runningHub.status, 502, runningHub.text);
        assert.doesNotMatch(runningHub.text, /output-secret|127\.0\.0\.1/);
        assert.equal(privateHits, 0, 'Provider output URL must be rejected before TCP connect');
      } finally {
        global.fetch = originalFetch;
      }
    });
  } finally {
    await closeServer(providerServer);
    await closeServer(privateServer);
  }
});

test('B3 RunningHub output filenames come only from verified media magic and static media blocks active extensions', async () => {
  const fixtures = {
    '/result.html': {
      buffer: Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
      extension: 'tif',
    },
    '/result.svg': {
      buffer: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI '), Buffer.alloc(8)]),
      extension: 'avi',
    },
    '/result.js': {
      buffer: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88]), Buffer.from('matroska')]),
      extension: 'mkv',
    },
  };
  const assetServer = await listen((req, res) => {
    const fixture = fixtures[req.url];
    if (!fixture) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(fixture.buffer);
  });
  const assetBase = `http://asset.test:${assetServer.address().port}`;
  try {
    await withProxyFixture(async ({ appServer, outputDir }) => {
      proxyRouter._test.setProxySafeRemoteTestOptions({
        allowPrivateForTests: (hostname) => hostname === 'asset.test',
        lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
      });
      const originalFetch = global.fetch;
      global.fetch = async (_url, init = {}) => {
        const taskId = JSON.parse(String(init.body || '{}')).taskId;
        const remotePath = taskId === 'rh-tiff' ? '/result.html' : taskId === 'rh-avi' ? '/result.svg' : '/result.js';
        return new Response(JSON.stringify({ code: 0, data: [{ fileUrl: `${assetBase}${remotePath}` }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      try {
        for (const [taskId, expectedExtension] of [['rh-tiff', 'tif'], ['rh-avi', 'avi'], ['rh-mkv', 'mkv']]) {
          const response = await requestGet(appServer, `/api/proxy/runninghub/query?taskId=${taskId}&site=cn`);
          assert.equal(response.status, 200, response.text);
          assert.match(response.data.data.urls[0], new RegExp(`\\.${expectedExtension}$`));
          assert.doesNotMatch(response.data.data.urls[0], /\.(?:html|svg|js)$/i);
        }
        const outputNames = fs.readdirSync(outputDir);
        assert.equal(outputNames.some((name) => /\.(?:html|svg|js)$/i.test(name)), false);
      } finally {
        global.fetch = originalFetch;
      }
    });
  } finally {
    await closeServer(assetServer);
  }

  assert.equal(proxyRouter._test.verifiedProxyMediaExtension({ detectedMime: 'image/png' }), 'png');
  assert.equal(proxyRouter._test.verifiedProxyMediaExtension({ detectedMime: 'video/mp4' }), 'mp4');
  assert.equal(proxyRouter._test.verifiedProxyMediaExtension({ detectedMime: 'audio/mpeg' }), 'mp3');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'backend', 'src', 'server.js'), 'utf8');
  assert.match(serverSource, /ACTIVE_USER_MEDIA_EXTENSIONS[\s\S]*?'\.html'[\s\S]*?'\.svg'[\s\S]*?'\.js'/);
  assert.match(serverSource, /X-Content-Type-Options', 'nosniff'/);
  assert.match(serverSource, /mountUserMediaStatic\('\/files\/output'/);
});

test('B3 media validation accepts stale MIME and unknown codecs while rejecting clear non-media or cross-kind input', () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]);
  const quickTime = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x14]),
    Buffer.from('ftypqt  ', 'ascii'),
    Buffer.alloc(8),
  ]);
  const mp4 = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x14]),
    Buffer.from('ftypisom', 'ascii'),
    Buffer.alloc(8),
  ]);
  const sameKindCases = [
    {
      bytes: png,
      declared: 'image/jpeg',
      allowedKinds: ['image'],
      detected: 'image/png',
      extension: 'png',
    },
    {
      bytes: quickTime,
      declared: 'video/mp4',
      allowedKinds: ['video'],
      detected: 'video/quicktime',
      extension: 'mov',
    },
    {
      bytes: mp4,
      declared: 'video/quicktime',
      allowedKinds: ['video'],
      detected: 'video/mp4',
      extension: 'mp4',
    },
    {
      bytes: mp3,
      declared: 'audio/wav',
      allowedKinds: ['audio'],
      detected: 'audio/mpeg',
      extension: 'mp3',
    },
  ];
  for (const fixture of sameKindCases) {
    const verified = proxyRouter._test.validateProxyMediaBuffer(
      fixture.bytes,
      fixture.declared,
      {
        allowedKinds: fixture.allowedKinds,
        maxBytes: 1024,
      },
    );
    assert.equal(verified.detectedMime, fixture.detected);
    assert.equal(verified.contentType, fixture.detected);
    assert.equal(verified.mediaKind, fixture.allowedKinds[0]);
    assert.equal(verified.contentTypeMismatch, true);
    assert.equal(proxyRouter._test.verifiedProxyMediaExtension(verified), fixture.extension);
  }

  const staleCrossKindHeader = proxyRouter._test.validateProxyMediaBuffer(png, 'video/mp4', {
    allowedKinds: ['image', 'video', 'audio'],
    maxBytes: 1024,
  });
  assert.equal(staleCrossKindHeader.mediaKind, 'image');
  assert.equal(staleCrossKindHeader.contentType, 'image/png');
  assert.equal(staleCrossKindHeader.contentTypeMismatch, true);

  const unknownImage = proxyRouter._test.validateProxyMediaBuffer(
    Buffer.from([0x01, 0x02, 0x03, 0x04]),
    'image/x-new-codec',
    { allowedKinds: ['image'], maxBytes: 1024 },
  );
  assert.equal(unknownImage.mediaKind, 'image');
  assert.equal(unknownImage.contentType, 'image/x-new-codec');
  assert.equal(proxyRouter._test.verifiedProxyMediaExtension(unknownImage), 'png');

  const unknownMov = proxyRouter._test.validateProxyMediaBuffer(
    Buffer.from([0x01, 0x02, 0x03, 0x04]),
    'application/octet-stream',
    { allowedKinds: ['video'], maxBytes: 1024, sourceName: 'signed-result.mov?token=redacted' },
  );
  assert.equal(unknownMov.mediaKind, 'video');
  assert.equal(unknownMov.contentType, 'video/quicktime');
  assert.equal(proxyRouter._test.verifiedProxyMediaExtension({ ...unknownMov, finalUrl: 'https://cdn.invalid/signed.mov?x=1' }), 'mov');

  const unknownAudio = proxyRouter._test.validateProxyMediaBuffer(
    Buffer.from([0x01, 0x02, 0x03, 0x04]),
    'application/octet-stream',
    { allowedKinds: ['audio'], maxBytes: 1024 },
  );
  assert.equal(unknownAudio.contentType, 'audio/mpeg');
  assert.equal(proxyRouter._test.verifiedProxyMediaExtension(unknownAudio), 'mp3');

  for (const [bytes, declared, allowedKinds] of [
    [png, 'image/png', ['video']],
    [Buffer.from('<html>not media</html>'), 'image/png', ['image']],
    [Buffer.from('{"error":"not media"}'), 'video/mp4', ['video']],
    [Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), Buffer.alloc(16)]), 'application/octet-stream', ['image', 'video', 'audio']],
  ]) {
    assert.throws(
      () => proxyRouter._test.validateProxyMediaBuffer(bytes, declared, { allowedKinds, maxBytes: 1024 }),
      /当前节点|HTML\/JSON|归档容器|支持范围/,
    );
  }

  assert.throws(
    () => proxyRouter._test.validateProxyMediaBuffer(Buffer.alloc(0), 'image/png', {
      allowedKinds: ['image'],
      maxBytes: 1024,
    }),
    /为空/,
  );
});

test('B3 RunningHub materializes mixed image, video, and audio outputs despite same-kind CDN subtype drift', async () => {
  const fixtures = {
    '/image': {
      declared: 'image/jpeg',
      buffer: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(16),
      ]),
      extension: 'png',
    },
    '/video': {
      declared: 'video/mp4',
      buffer: Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x14]),
        Buffer.from('ftypqt  ', 'ascii'),
        Buffer.alloc(8),
      ]),
      extension: 'mov',
    },
    '/audio': {
      declared: 'audio/wav',
      buffer: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]),
      extension: 'mp3',
    },
  };
  const assetServer = await listen((req, res) => {
    const fixture = fixtures[req.url];
    if (!fixture) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': fixture.declared,
      'content-length': fixture.buffer.length,
    });
    res.end(fixture.buffer);
  });
  const assetBase = `http://rh-mixed-output.test:${assetServer.address().port}`;
  try {
    await withProxyFixture(async ({ appServer, outputDir }) => {
      proxyRouter._test.setProxySafeRemoteTestOptions({
        allowPrivateForTests: (hostname) => hostname === 'rh-mixed-output.test',
        lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
      });
      const originalFetch = global.fetch;
      global.fetch = async () => new Response(JSON.stringify({
        code: 0,
        data: Object.keys(fixtures).map((pathname) => ({
          fileUrl: `${assetBase}${pathname}`,
        })),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      try {
        const response = await requestGet(
          appServer,
          '/api/proxy/runninghub/query?taskId=rh-mixed-subtype-drift&site=cn',
        );
        assert.equal(response.status, 200, response.text);
        assert.equal(response.data?.data?.status, 'SUCCESS');
        assert.equal(response.data?.data?.urls?.length, 3);
        const outputExtensions = response.data.data.urls.map((url) => path.extname(url)).sort();
        assert.deepEqual(outputExtensions, ['.mov', '.mp3', '.png']);
        const outputFiles = fs.readdirSync(outputDir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name);
        assert.deepEqual(
          outputFiles.map((name) => path.extname(name)).sort(),
          ['.mov', '.mp3', '.png'],
        );
      } finally {
        global.fetch = originalFetch;
      }
    });
  } finally {
    await closeServer(assetServer);
  }
});

test('B3 Suno audio validation preserves the supported format matrix by magic bytes', () => {
  const mp4Box = (type, payload) => {
    const body = Buffer.from(payload);
    const box = Buffer.allocUnsafe(8 + body.length);
    box.writeUInt32BE(box.length, 0);
    box.write(type, 4, 4, 'ascii');
    body.copy(box, 8);
    return box;
  };
  const handlerPayload = Buffer.alloc(24);
  handlerPayload.write('soun', 8, 4, 'ascii');
  const isomAudio = Buffer.concat([
    mp4Box('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.alloc(4), Buffer.from('isomm4a ')])),
    mp4Box('moov', mp4Box('trak', mp4Box('mdia', mp4Box('hdlr', handlerPayload)))),
  ]);
  const fixtures = [
    ['audio/mpeg', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)])],
    ['audio/wav', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(4)])],
    ['audio/ogg', Buffer.concat([Buffer.from('OggS'), Buffer.alloc(16)])],
    ['audio/flac', Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(16)])],
    ['audio/mp4', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypm4a '), Buffer.alloc(8)])],
    ['audio/mp4', isomAudio],
    ['audio/aac', Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc, 0x00])],
    ['audio/x-ms-wma', Buffer.concat([
      Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]),
      Buffer.alloc(16),
    ])],
  ];
  for (const [mime, bytes] of fixtures) {
    const verified = proxyRouter._test.validateProxyMediaBuffer(bytes, mime, {
      allowedKinds: ['audio'],
      maxBytes: 1024,
    });
    assert.equal(verified.detectedMime, mime);
  }
  assert.equal(
    proxyRouter._test.validateProxyMediaBuffer(fixtures[0][1], 'audio/mp3', {
      allowedKinds: ['audio'],
      maxBytes: 1024,
    }).detectedMime,
    'audio/mpeg',
  );
});

test('B3 Suno audio upload verifies bytes and never exposes Provider response secrets', async () => {
  await withProxyFixture(async ({ appServer }) => {
    const clientFetch = global.fetch;
    const originalFetch = global.fetch;
    const providerCalls = [];
    global.fetch = async (url, init = {}) => {
      providerCalls.push({ url: String(url), body: String(init.body || '') });
      return new Response(JSON.stringify({
        token: 'provider-json-token-secret',
        signedUrl: 'https://cdn.example/upload?token=provider-signed-secret',
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const invalid = new FormData();
      invalid.append('file', new Blob(['<html><script>bad()</script></html>'], { type: 'text/html' }), 'payload.html');
      const invalidResponse = await clientFetch(
        `http://127.0.0.1:${appServer.address().port}/api/proxy/audio/upload`,
        { method: 'POST', body: invalid },
      );
      const invalidText = await invalidResponse.text();
      assert.equal(invalidResponse.status, 400, invalidText);
      assert.equal(providerCalls.length, 0, 'invalid bytes must be rejected before Provider init');

      const valid = new FormData();
      valid.append('file', new Blob([Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 0x5a)])], {
        type: 'audio/mpeg',
      }), 'misleading.html');
      const providerFailure = await clientFetch(
        `http://127.0.0.1:${appServer.address().port}/api/proxy/audio/upload`,
        { method: 'POST', body: valid },
      );
      const providerFailureText = await providerFailure.text();
      assert.equal(providerFailure.status, 401, providerFailureText);
      assert.equal(providerCalls.length, 1);
      assert.match(providerCalls[0].body, /"extension":"mp3"/);
      assert.doesNotMatch(providerCalls[0].body, /html/i);
      assert.doesNotMatch(providerFailureText, /provider-json-token-secret|provider-signed-secret|cdn\.example/);
      assert.match(providerFailureText, /HTTP 401/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('B3 Suno submit and query bound Provider bodies without exposing credentials', async () => {
  await withProxyFixture(async ({ appServer }) => {
    const originalFetch = global.fetch;
    const providerCalls = [];
    const upstreamSecretBody = JSON.stringify({
      message: 'Invalid API key provider-secret-key',
      token: 'provider-json-token-secret',
      signedUrl: 'https://cdn.example/private?token=provider-signed-secret',
    });
    global.fetch = async (url) => {
      providerCalls.push(String(url));
      return new Response(upstreamSecretBody, {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const submissions = [
        { mode: 'generate', prompt: 'generate safely' },
        { mode: 'extend', continue_clip_id: 'clip-extend' },
        { mode: 'cover', prompt: 'cover safely', cover_clip_id: 'clip-cover' },
      ];
      for (const body of submissions) {
        const response = await requestJson(appServer, '/api/proxy/audio/submit', body);
        assert.equal(response.status, 401, response.text);
        assert.match(response.text, /HTTP 401/);
        assert.doesNotMatch(
          response.text,
          /provider-secret-key|provider-json-token-secret|provider-signed-secret|cdn\.example/,
        );
      }

      const query = await requestGet(appServer, '/api/proxy/audio/query?clipIds=clip-query&saveLocal=false');
      assert.equal(query.status, 401, query.text);
      assert.match(query.text, /HTTP 401/);
      assert.doesNotMatch(
        query.text,
        /provider-secret-key|provider-json-token-secret|provider-signed-secret|cdn\.example/,
      );
      assert.equal(providerCalls.length, 4);

      const captured = captureConsoleErrors();
      global.fetch = async () => {
        throw new Error('network failed provider-secret-key https://cdn.example/private?token=provider-signed-secret');
      };
      try {
        const failed = await requestJson(appServer, '/api/proxy/audio/submit', {
          mode: 'generate',
          prompt: 'network failure',
        });
        assert.equal(failed.status, 500, failed.text);
        assert.doesNotMatch(failed.text, /provider-secret-key|provider-signed-secret|cdn\.example/);
      } finally {
        captured.restore();
      }
      assert.doesNotMatch(
        captured.messages.join('\n'),
        /provider-secret-key|provider-signed-secret|cdn\.example/,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('B3 Suno completed media is localized without returning Provider signed URLs', async () => {
  const safePng = await sharp({
    create: { width: 1, height: 1, channels: 4, background: { r: 30, g: 180, b: 90, alpha: 1 } },
  }).png().toBuffer();
  const safeAudio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 0x5a)]);
  const mediaServer = await listen((req, res) => {
    if (req.url.startsWith('/audio.mp3')) {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(safeAudio);
      return;
    }
    if (req.url.startsWith('/cover.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(safePng);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const mediaBase = `http://media.test:${mediaServer.address().port}`;
  try {
    await withProxyFixture(async ({ appServer, outputDir }) => {
      proxyRouter._test.setProxySafeRemoteTestOptions({
        allowPrivateForTests: (hostname) => hostname === 'media.test',
        lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
        protocols: ['http:'],
      });
      const originalFetch = global.fetch;
      global.fetch = async () => new Response(JSON.stringify([{
        id: 'clip-localized',
        clip_id: 'clip-localized',
        status: 'complete',
        audio_url: `${mediaBase}/audio.mp3?X-Amz-Credential=audio-secret&X-Amz-Signature=audio-signature`,
        image_large_url: `${mediaBase}/cover.png?token=cover-secret&signature=cover-signature`,
        title: 'Localized track',
        tags: 'safe tags',
        metadata: { duration: 12.5 },
      }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      try {
        const query = await requestGet(appServer, '/api/proxy/audio/query?clipIds=clip-localized&saveLocal=false');
        assert.equal(query.status, 200, query.text);
        assert.equal(query.data.data.status, 'SUCCESS');
        assert.equal(query.data.data.tracks.length, 1);
        const [track] = query.data.data.tracks;
        assert.match(track.audioUrl, /^\/files\/output\/audio_[^/]+\.mp3$/);
        assert.match(track.imageUrl, /^\/files\/output\/img_[^/]+\.png$/);
        assert.equal(Object.hasOwn(track, 'remoteUrl'), false);
        assert.doesNotMatch(
          query.text,
          /media\.test|audio-secret|audio-signature|cover-secret|cover-signature|X-Amz/i,
        );
        assert.equal(fs.readdirSync(outputDir, { withFileTypes: true }).filter((entry) => entry.isFile()).length, 2);
      } finally {
        global.fetch = originalFetch;
      }
    });
  } finally {
    await closeServer(mediaServer);
  }
});

test('B3 MJ routes normalize task data, localize outputs, and reject signed reference URLs', async () => {
  const safePng = await sharp({
    create: { width: 1, height: 1, channels: 4, background: { r: 210, g: 80, b: 40, alpha: 1 } },
  }).png().toBuffer();
  const mediaServer = await listen((req, res) => {
    if (req.url.startsWith('/mj.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(safePng);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const mediaBase = `http://media.test:${mediaServer.address().port}`;
  try {
    await withProxyFixture(async ({ appServer }) => {
      proxyRouter._test.setProxySafeRemoteTestOptions({
        allowPrivateForTests: (hostname) => hostname === 'media.test',
        lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
        protocols: ['http:'],
      });
      const originalFetch = global.fetch;
      let mode = 'submit';
      global.fetch = async () => {
        if (mode === 'submit') {
          return new Response(JSON.stringify({
            code: 1,
            result: 'mj-task-safe-1',
            provider_secret: 'mj-provider-raw-secret',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (mode === 'task') {
          return new Response(JSON.stringify({
            status: 'SUCCESS',
            image_url: `${mediaBase}/mj.png?token=mj-output-secret&X-Amz-Signature=mj-signature`,
            provider_secret: 'mj-task-raw-secret',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (mode === 'upload') {
          return new Response(JSON.stringify({
            result: 'https://cdn.example/ref.png?token=mj-upload-secret&signature=mj-upload-signature',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          error: 'Invalid API key provider-secret-key',
          token: 'mj-error-secret',
        }), { status: 401, headers: { 'content-type': 'application/json' } });
      };
      try {
        const submitted = await requestJson(appServer, '/api/proxy/mj/imagine', { prompt: 'safe prompt' });
        assert.equal(submitted.status, 200, submitted.text);
        assert.deepEqual(submitted.data.data, { taskId: 'mj-task-safe-1' });
        assert.doesNotMatch(submitted.text, /mj-provider-raw-secret/);

        mode = 'task';
        const task = await requestGet(appServer, '/api/proxy/mj/task/mj-task-safe-1?speed=fast');
        assert.equal(task.status, 200, task.text);
        assert.equal(task.data.data.status, 'SUCCESS');
        assert.match(task.data.data.imageUrl, /^\/files\/output\/img_[^/]+\.png$/);
        assert.doesNotMatch(task.text, /media\.test|mj-output-secret|mj-signature|mj-task-raw-secret/);

        mode = 'upload';
        const uploaded = await requestJson(appServer, '/api/proxy/mj/upload', {
          base64Data: `data:image/png;base64,${safePng.toString('base64')}`,
        });
        assert.equal(uploaded.status, 502, uploaded.text);
        assert.doesNotMatch(uploaded.text, /cdn\.example|mj-upload-secret|mj-upload-signature/);

        mode = 'error';
        const rejected = await requestJson(appServer, '/api/proxy/mj/imagine', { prompt: 'safe prompt' });
        assert.equal(rejected.status, 401, rejected.text);
        assert.match(rejected.text, /HTTP 401/);
        assert.doesNotMatch(rejected.text, /provider-secret-key|mj-error-secret/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  } finally {
    await closeServer(mediaServer);
  }
});

test('B3 RunningHub app-info exposes only the form schema allowlist', async () => {
  await withProxyFixture(async ({ appServer }) => {
    const originalFetch = global.fetch;
    let fail = false;
    global.fetch = async () => new Response(JSON.stringify(fail ? {
      code: 500,
      msg: 'Invalid API key runninghub-secret-key rh-app-error-secret',
    } : {
      code: 0,
      data: {
        webappId: 'provider-overridden-id',
        appName: 'Safe workflow',
        nodeInfoList: [{
          nodeId: '1',
          fieldName: 'prompt runninghub-secret-key',
          fieldType: 'TEXT',
          fieldValue: 'default',
          options: [{ label: 'A', value: 'a', token: 'option-secret' }],
          apiKey: 'nested-provider-secret',
        }],
        token: 'top-level-secret',
        signedUrl: 'https://provider.example/private?token=signed-secret',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    try {
      const info = await requestGet(appServer, '/api/proxy/runninghub/app-info?webappId=requested-app&site=cn');
      assert.equal(info.status, 200, info.text);
      assert.equal(info.data.data.webappId, 'requested-app');
      assert.equal(info.data.data.nodeInfoList.length, 1);
      assert.equal(Object.hasOwn(info.data.data, 'token'), false);
      assert.equal(Object.hasOwn(info.data.data.nodeInfoList[0], 'apiKey'), false);
      assert.equal(Object.hasOwn(info.data.data.nodeInfoList[0].options[0], 'token'), false);
      assert.doesNotMatch(
        info.text,
        /runninghub-secret-key|nested-provider-secret|option-secret|top-level-secret|signed-secret|provider\.example/,
      );

      fail = true;
      const rejected = await requestGet(appServer, '/api/proxy/runninghub/app-info?webappId=requested-app&site=cn');
      assert.equal(rejected.status, 400, rejected.text);
      assert.match(rejected.text, /code=500/);
      assert.doesNotMatch(rejected.text, /runninghub-secret-key|rh-app-error-secret/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('B3 RunningHub app-info exhausts the alternate site for opaque read-only lookup failures', async () => {
  await withProxyFixture(async ({ appServer, settingsFile }) => {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    fs.writeFileSync(settingsFile, JSON.stringify({
      ...settings,
      rhIntlApiKey: 'runninghub-intl-secret-key',
    }));

    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).startsWith('https://www.runninghub.ai/')) {
        return new Response(JSON.stringify({ code: 332 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        code: 0,
        data: {
          webappId: 'provider-overridden-id',
          nodeInfoList: [{ nodeId: '1', fieldName: 'prompt', fieldType: 'TEXT', fieldValue: '' }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const info = await requestGet(appServer, '/api/proxy/runninghub/app-info?webappId=2075149522166181890&site=intl');
      assert.equal(info.status, 200, info.text);
      assert.equal(info.data.data.webappId, '2075149522166181890');
      assert.equal(info.data.data.rhSite, 'cn');
      assert.equal(info.data.data.rhFallbackUsed, true);
      assert.equal(info.data.data.nodeInfoList.length, 1);
      assert.equal(calls.length, 2);
      assert.match(calls[0], /^https:\/\/www\.runninghub\.ai\/api\/webapp\/apiCallDemo\?/);
      assert.match(calls[1], /^https:\/\/www\.runninghub\.cn\/api\/webapp\/apiCallDemo\?/);
      assert.doesNotMatch(info.text, /runninghub-intl-secret-key|runninghub-secret-key/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('B3 LLM JSON and SSE paths bound Provider bodies and expose only normalized fields', async () => {
  await withProxyFixture(async ({ appServer }) => {
    const originalFetch = global.fetch;
    const requestBody = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    };
    try {
      global.fetch = async () => new Response(JSON.stringify({
        error: { message: 'Invalid API key llm-provider-secret-key' },
        token: 'llm-json-secret',
      }), { status: 401, headers: { 'content-type': 'application/json' } });
      const rejected = await requestJson(appServer, '/api/proxy/llm', requestBody);
      assert.equal(rejected.status, 401, rejected.text);
      assert.match(rejected.text, /HTTP 401/);
      assert.doesNotMatch(rejected.text, /llm-provider-secret-key|llm-json-secret/);

      global.fetch = async () => new Response(JSON.stringify({
        id: 'llm-request-1',
        choices: [{
          message: { content: 'safe reply llm-provider-secret-key' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 3, completion_tokens: 5, debug: 'usage-secret' },
        provider_debug: 'provider-raw-secret',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      const completed = await requestJson(appServer, '/api/proxy/llm', requestBody);
      assert.equal(completed.status, 200, completed.text);
      assert.equal(completed.data.data.requestId, 'llm-request-1');
      assert.equal(completed.data.data.usage.prompt_tokens, 3);
      assert.equal(completed.data.data.usage.completion_tokens, 5);
      assert.equal(Object.hasOwn(completed.data.data.usage, 'debug'), false);
      assert.equal(Object.hasOwn(completed.data.data, 'raw'), false);
      assert.doesNotMatch(completed.text, /llm-provider-secret-key|usage-secret|provider-raw-secret/);

      proxyRouter._test.setProxySafeRemoteTestOptions({ providerRetryDelayMs: 1 });
      let recoveryCalls = 0;
      const recoveryDispatchers = [];
      const recoveryKeys = [];
      global.fetch = async (_url, init = {}) => {
        recoveryCalls += 1;
        recoveryDispatchers.push(init.dispatcher);
        recoveryKeys.push(new Headers(init.headers).get('Idempotency-Key'));
        if (recoveryCalls === 1) {
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('stale route'), { code: 'ECONNRESET' }),
          });
        }
        return new Response(JSON.stringify({
          id: 'llm-recovered-request',
          choices: [{ message: { content: 'recovered' }, finish_reason: 'stop' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const recovered = await requestJson(
        appServer,
        '/api/proxy/llm',
        requestBody,
        { 'x-t8-provider-submission': 'llm-node-run-attempt-0001' },
      );
      assert.equal(recovered.status, 200, recovered.text);
      assert.equal(recovered.data.data.requestId, 'llm-recovered-request');
      assert.equal(recoveryCalls, 2);
      assert.equal(recoveryDispatchers[0], undefined);
      assert.ok(recoveryDispatchers[1], 'the retry must use a fresh system-DNS connection');
      assert.deepEqual(
        recoveryKeys,
        ['llm-node-run-attempt-0001', 'llm-node-run-attempt-0001'],
        'LLM recovery must retain one stable submission identity',
      );

      global.fetch = async () => new Response(
        'data: {"choices":[{"delta":{"content":"stream llm-provider-secret-key"}}],"token":"stream-debug-secret"}\n\n'
          + 'data: {"choices":[{"finish_reason":"stop"}],"provider_debug":"raw-stream-secret"}\n\n'
          + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
      const streamed = await requestJson(appServer, '/api/proxy/llm', { ...requestBody, stream: true });
      assert.equal(streamed.status, 200, streamed.text);
      assert.match(streamed.text, /stream \[redacted-secret\]/);
      assert.match(streamed.text, /finish_reason/);
      assert.doesNotMatch(streamed.text, /llm-provider-secret-key|stream-debug-secret|raw-stream-secret/);

      proxyRouter._test.setProxySafeRemoteTestOptions({ providerDeadlineMs: 120, idleTimeoutMs: 40 });
      global.fetch = async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(''));
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      const startedAt = Date.now();
      const stalled = await requestJson(appServer, '/api/proxy/llm', { ...requestBody, stream: true });
      assert.equal(stalled.status, 504, stalled.text);
      assert.ok(Date.now() - startedAt < 1_000, 'stalled LLM SSE must stop at its idle/deadline budget');
    } finally {
      global.fetch = originalFetch;
      proxyRouter._test.setProxySafeRemoteTestOptions(null);
    }
  });
});

test('B3 completed task response stalls remain recoverable without resubmitting generation', async () => {
  await withProxyFixture(async ({ appServer }) => {
    const originalFetch = global.fetch;
    let calls = 0;
    proxyRouter._test.setProxySafeRemoteTestOptions({
      providerDeadlineMs: 120,
      idleTimeoutMs: 40,
      providerRetryDelayMs: 1,
    });
    global.fetch = async () => {
      calls += 1;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('{"status":"completed","data":'));
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const response = await requestGet(
        appServer,
        '/api/proxy/image/status/existing-completed-image-task?model=gpt-image-2',
      );
      assert.equal(response.status, 202, response.text);
      assert.equal(response.data?.code, 'task_result_query_recovering');
      assert.equal(response.data?.data?.taskId, 'existing-completed-image-task');
      assert.equal(response.data?.data?.recoverable, true);
      assert.equal(calls, 1, 'a stalled result body must continue the same query instead of submitting again');
    } finally {
      global.fetch = originalFetch;
      proxyRouter._test.setProxySafeRemoteTestOptions(null);
    }
  });
});

test('B3 Zhenzhen image routes bound Provider JSON and expose only normalized results', async () => {
  await withProxyFixture(async ({ appServer }) => {
    const originalFetch = global.fetch;
    const secretPattern = /provider-secret-key|provider-json-token-secret|provider-signed-secret|cdn\.example/;
    const upstreamSecretBody = JSON.stringify({
      error: { message: 'Invalid API key provider-secret-key' },
      token: 'provider-json-token-secret',
      signedUrl: 'https://cdn.example/private?token=provider-signed-secret',
    });
    global.fetch = async () => new Response(upstreamSecretBody, {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    try {
      const image = await requestJson(appServer, '/api/proxy/image', {
        apiModel: 'gpt-image-2',
        model: 'gpt-image-2',
        prompt: 'bounded image',
      });
      const submit = await requestJson(appServer, '/api/proxy/image/submit', {
        apiModel: 'gpt-image-2',
        model: 'gpt-image-2',
        prompt: 'bounded submit',
      });
      const status = await requestGet(appServer, '/api/proxy/image/status/image-task?model=gpt-image-2');
      for (const response of [image, submit, status]) {
        assert.equal(response.status, 401, response.text);
        assert.match(response.text, /HTTP 401/);
        assert.doesNotMatch(response.text, secretPattern);
      }

      global.fetch = async (url) => {
        if (String(url).includes('/v1/images/tasks/')) {
          return new Response(JSON.stringify({
            status: 'pending',
            progress: '10%',
            providerDebugToken: 'provider-json-token-secret',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          task_id: 'normalized-image-task',
          providerDebugToken: 'provider-json-token-secret',
          signedUrl: 'https://cdn.example/private?token=provider-signed-secret',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const successfulSubmit = await requestJson(appServer, '/api/proxy/image/submit', {
        apiModel: 'gpt-image-2',
        model: 'gpt-image-2',
        prompt: 'normalized submit',
      });
      assert.equal(successfulSubmit.status, 200, successfulSubmit.text);
      assert.equal(successfulSubmit.data?.data?.taskId, 'normalized-image-task');
      assert.doesNotMatch(successfulSubmit.text, secretPattern);
      const pending = await requestGet(appServer, '/api/proxy/image/status/image-task?model=gpt-image-2');
      assert.equal(pending.status, 200, pending.text);
      assert.equal(pending.data?.data?.status, 'pending');
      assert.doesNotMatch(pending.text, secretPattern);

      const captured = captureConsoleErrors();
      global.fetch = async () => {
        throw new Error('network failed provider-secret-key https://cdn.example/private?token=provider-signed-secret');
      };
      try {
        const failed = await requestJson(appServer, '/api/proxy/image/submit', {
          apiModel: 'gpt-image-2',
          model: 'gpt-image-2',
          prompt: 'network failure',
        });
        assert.equal(failed.status, 500, failed.text);
        assert.doesNotMatch(failed.text, secretPattern);
      } finally {
        captured.restore();
      }
      assert.doesNotMatch(captured.messages.join('\n'), secretPattern);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('B3 hostname-bound TUN Fake-IP stays on the TUN path without opening literal Fake-IP URLs', async () => {
  let publicDnsCalls = 0;
  const pinned = await resolvePublicAddress(
    'generated.example',
    async () => [{ address: '198.18.9.25', family: 4 }],
    false,
    async () => {
      publicDnsCalls += 1;
      return [{ address: '203.0.113.25', family: 4 }];
    },
  );
  assert.deepEqual(pinned, { address: '198.18.9.25', family: 4, tunFake: true });
  assert.equal(publicDnsCalls, 0, 'normal TUN downloads must use the active Fake-IP mapping first');
  await assert.rejects(
    resolvePublicAddress(
      '198.18.9.25',
      async () => [{ address: '198.18.9.25', family: 4 }],
    ),
    (error) => error?.code === 'private_address',
  );
});

test('B3 completed image tasks retry transient downloads and expose actionable safe failure reasons', async () => {
  await withProxyFixture(async ({ appServer, outputDir }) => {
    const originalFetch = global.fetch;
    const validPng = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 120, b: 220, alpha: 1 } },
    }).png().toBuffer();
    let outputRequests = 0;
    const outputServer = await listen((req, res) => {
      if (req.url?.startsWith('/expired.png')) {
        res.writeHead(410, { 'content-type': 'text/plain' });
        res.end('expired signed output');
        return;
      }
      outputRequests += 1;
      if (outputRequests < 3) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('temporary unavailable');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': validPng.length });
      res.end(validPng);
    });
    try {
      const localOutput = `http://127.0.0.1:${outputServer.address().port}/generated.png`;
      proxyRouter._test.setProxySafeRemoteTestOptions({
        allowPrivateForTests: true,
        lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
      });
      global.fetch = async () => new Response(JSON.stringify({
        status: 'SUCCESS',
        progress: '100%',
        data: { data: [{ url: localOutput }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });

      const recovered = await requestGet(appServer, '/api/proxy/image/status/retry-image-task?model=gpt-image-2');
      assert.equal(recovered.status, 200, recovered.text);
      assert.equal(recovered.data?.data?.status, 'completed');
      assert.match(recovered.data?.data?.urls?.[0] || '', /^\/files\/output\/img_task_/);
      assert.equal(outputRequests, 3, 'transient output download must retry before failing the completed task');
      assert.equal(fs.readdirSync(outputDir).filter((name) => name.startsWith('img_task_') && !name.endsWith('.complete.json')).length, 1);

      global.fetch = async () => new Response(JSON.stringify({
        status: 'completed',
        progress: '100%',
        result: { output_url: `http://127.0.0.1:${outputServer.address().port}/expired.png?token=provider-signed-secret` },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      const expired = await requestGet(appServer, '/api/proxy/image/status/expired-image-task?model=gpt-image-2');
      assert.equal(expired.status, 502, expired.text);
      assert.equal(expired.data?.code, 'image_download_http_error');
      assert.match(expired.data?.error || '', /HTTP 410/);
      assert.doesNotMatch(expired.text, /provider-signed-secret|expired\.png/);

      const tunOutput = `http://cdn.example:${outputServer.address().port}/generated.png?token=provider-signed-secret`;
      proxyRouter._test.setProxySafeRemoteTestOptions({
        lookupImpl: async () => [{ address: '198.18.0.25', family: 4 }],
        acceptTunFake: false,
        publicLookupImpl: async () => {
          throw Object.assign(new Error('public DNS temporarily unavailable'), {
            code: 'tun_dns_fallback_failed',
          });
        },
      });
      global.fetch = async () => new Response(JSON.stringify({
        status: 'completed',
        progress: '100%',
        result: { image_url: tunOutput },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      const waitingForTunDns = await requestGet(appServer, '/api/proxy/image/status/fake-ip-image-task?model=gpt-image-2');
      assert.equal(waitingForTunDns.status, 202, waitingForTunDns.text);
      assert.equal(waitingForTunDns.data?.success, true);
      assert.equal(waitingForTunDns.data?.data?.status, 'materializing');
      assert.equal(waitingForTunDns.data?.data?.recoverable, true);
      assert.equal(waitingForTunDns.data?.code, 'image_download_tun_dns_recovering');
      assert.match(waitingForTunDns.data?.data?.error || '', /TUN Fake-IP|自动重试/);
      assert.doesNotMatch(waitingForTunDns.text, /cdn\.example|provider-signed-secret/);

      proxyRouter._test.setProxySafeRemoteTestOptions({
        lookupImpl: async () => [{ address: '198.18.0.25', family: 4 }],
        acceptTunFake: false,
        publicLookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
        allowPrivateForTests: true,
      });
      const recoveredWithTunEnabled = await requestGet(appServer, '/api/proxy/image/status/fake-ip-image-task?model=gpt-image-2');
      assert.equal(recoveredWithTunEnabled.status, 200, recoveredWithTunEnabled.text);
      assert.equal(recoveredWithTunEnabled.data?.data?.status, 'completed');
      assert.match(recoveredWithTunEnabled.data?.data?.urls?.[0] || '', /^\/files\/output\/img_task_/);

      let arbitraryPrivateFallbacks = 0;
      proxyRouter._test.setProxySafeRemoteTestOptions({
        lookupImpl: async () => [{ address: '192.168.20.30', family: 4 }],
        publicLookupImpl: async () => {
          arbitraryPrivateFallbacks += 1;
          return [{ address: '127.0.0.1', family: 4 }];
        },
      });
      global.fetch = async () => new Response(JSON.stringify({
        status: 'completed',
        progress: '100%',
        result: {
          image_url: `http://private.example:${outputServer.address().port}/private.png?token=provider-signed-secret`,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      const blockedPrivate = await requestGet(appServer, '/api/proxy/image/status/private-image-task?model=gpt-image-2');
      assert.equal(blockedPrivate.status, 502, blockedPrivate.text);
      assert.equal(blockedPrivate.data?.code, 'image_download_private_address_blocked');
      assert.equal(arbitraryPrivateFallbacks, 0);
      assert.doesNotMatch(blockedPrivate.text, /private\.example|provider-signed-secret/);

      global.fetch = async () => new Response(JSON.stringify({
        status: 'finished',
        progress: '100%',
        data: {},
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      const missing = await requestGet(appServer, '/api/proxy/image/status/missing-image-task?model=gpt-image-2');
      assert.equal(missing.status, 502, missing.text);
      assert.equal(missing.data?.code, 'image_output_missing');
      assert.match(missing.data?.error || '', /没有可识别的图片地址/);
    } finally {
      global.fetch = originalFetch;
      proxyRouter._test.setProxySafeRemoteTestOptions(null);
      await closeServer(outputServer);
    }
  });
});

test('B3 video, audio, and RunningHub completed tasks survive TUN Fake-IP and resume the same task', async () => {
  const videoBytes = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x14]),
    Buffer.from('ftypisom', 'ascii'),
    Buffer.alloc(8),
  ]);
  const audioBytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32, 0x5a)]);
  const outputServer = await listen((req, res) => {
    if (req.url?.startsWith('/result.mp4')) {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': videoBytes.length });
      res.end(videoBytes);
      return;
    }
    if (req.url?.startsWith('/result.mp3')) {
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audioBytes.length });
      res.end(audioBytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    await withProxyFixture(async ({ appServer, outputDir }) => {
      const signedVideo = `http://result.example:${outputServer.address().port}/result.mp4?token=video-secret`;
      const signedAudio = `http://result.example:${outputServer.address().port}/result.mp3?token=audio-secret`;
      let providerQueries = 0;
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        providerQueries += 1;
        const target = String(url);
        if (target.includes('/suno/feed/')) {
          return new Response(JSON.stringify([{
            id: 'tun-audio-task',
            clip_id: 'tun-audio-task',
            status: 'complete',
            audio_url: signedAudio,
            metadata: { duration: 1 },
          }]), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (target.includes('/task/openapi/outputs')) {
          return new Response(JSON.stringify({
            code: 0,
            data: [{ fileUrl: signedVideo, fileType: 'mp4' }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          status: 'SUCCESS',
          video_url: signedVideo,
          progress: '100%',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      try {
        proxyRouter._test.setProxySafeRemoteTestOptions({
          lookupImpl: async () => [{ address: '198.18.1.25', family: 4 }],
          acceptTunFake: false,
          publicLookupImpl: async () => {
            throw Object.assign(new Error('independent DNS temporarily unavailable'), {
              code: 'tun_dns_fallback_failed',
            });
          },
        });

        const videoWaiting = await requestGet(appServer, '/api/proxy/video/query?taskId=tun-video-task&model=veo-3.1');
        const audioWaiting = await requestGet(appServer, '/api/proxy/audio/query?clipIds=tun-audio-task&saveLocal=false');
        const rhWaiting = await requestGet(appServer, '/api/proxy/runninghub/query?taskId=tun-rh-task&site=cn');
        for (const response of [videoWaiting, audioWaiting, rhWaiting]) {
          assert.equal(response.status, 202, response.text);
          assert.equal(response.data?.success, true);
          assert.equal(String(response.data?.data?.status).toUpperCase(), 'MATERIALIZING');
          assert.equal(response.data?.data?.recoverable, true);
          assert.doesNotMatch(response.text, /result\.example|video-secret|audio-secret/);
        }

        proxyRouter._test.setProxySafeRemoteTestOptions({
          lookupImpl: async () => [{ address: '198.18.1.25', family: 4 }],
          acceptTunFake: false,
          publicLookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
          allowPrivateForTests: true,
        });

        const videoRecovered = await requestGet(appServer, '/api/proxy/video/query?taskId=tun-video-task&model=veo-3.1');
        const audioRecovered = await requestGet(appServer, '/api/proxy/audio/query?clipIds=tun-audio-task&saveLocal=false');
        const rhRecovered = await requestGet(appServer, '/api/proxy/runninghub/query?taskId=tun-rh-task&site=cn');
        assert.equal(videoRecovered.status, 200, videoRecovered.text);
        assert.equal(videoRecovered.data?.data?.status, 'SUCCESS');
        assert.match(videoRecovered.data?.data?.videoUrl || '', /^\/files\/output\/vid_task_/);
        assert.equal(audioRecovered.status, 200, audioRecovered.text);
        assert.equal(audioRecovered.data?.data?.status, 'SUCCESS');
        assert.match(audioRecovered.data?.data?.tracks?.[0]?.audioUrl || '', /^\/files\/output\/audio_task_/);
        assert.equal(rhRecovered.status, 200, rhRecovered.text);
        assert.equal(rhRecovered.data?.data?.status, 'SUCCESS');
        assert.match(rhRecovered.data?.data?.urls?.[0] || '', /^\/files\/output\/rh_task_/);
        assert.equal(providerQueries, 6, 'recovery must query the same tasks without submitting replacements');
        assert.equal(fs.readdirSync(outputDir, { withFileTypes: true }).filter((entry) => entry.isFile()).length, 3);
      } finally {
        global.fetch = originalFetch;
      }
    });
  } finally {
    await closeServer(outputServer);
  }
});

test('B3 Zhenzhen video and Seedance routes bound Provider JSON and redact failures', async () => {
  await withProxyFixture(async ({ appServer }) => {
    const originalFetch = global.fetch;
    const secretPattern = /provider-secret-key|provider-json-token-secret|provider-signed-secret|cdn\.example/;
    const upstreamSecretBody = JSON.stringify({
      error: { message: 'Invalid API key provider-secret-key' },
      token: 'provider-json-token-secret',
      signedUrl: 'https://cdn.example/private?token=provider-signed-secret',
    });
    global.fetch = async () => new Response(upstreamSecretBody, {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    try {
      const videoSubmit = await requestJson(appServer, '/api/proxy/video/submit', {
        model: 'veo-3.1',
        prompt: 'bounded video',
      });
      const videoQuery = await requestGet(appServer, '/api/proxy/video/query?taskId=video-task&model=veo-3.1');
      const seedanceSubmit = await requestJson(appServer, '/api/proxy/seedance/submit', {
        taskProvider: 'zhenzhen-legacy',
        model: 'doubao-seedance-2-0-260128',
        prompt: 'bounded seedance',
      });
      const seedanceQuery = await requestGet(
        appServer,
        '/api/proxy/seedance/query?taskId=seedance-task&taskProvider=zhenzhen-legacy',
      );
      for (const response of [videoSubmit, videoQuery, seedanceSubmit, seedanceQuery]) {
        assert.equal(response.status, 401, response.text);
        assert.match(response.text, /HTTP 401/);
        assert.doesNotMatch(response.text, secretPattern);
      }

      global.fetch = async (url) => {
        const value = String(url);
        if (value.includes('/seedance/v3/contents/generations/tasks/')) {
          return new Response(JSON.stringify({
            status: 'pending',
            progress: '12%',
            providerDebugToken: 'provider-json-token-secret',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (value.includes('/seedance/v3/contents/generations/tasks')) {
          return new Response(JSON.stringify({
            id: 'normalized-seedance-task',
            providerDebugToken: 'provider-json-token-secret',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (/\/v2\/videos\/generations\/[^/]+$/.test(value)) {
          return new Response(JSON.stringify({
            status: 'pending',
            progress: '9%',
            providerDebugToken: 'provider-json-token-secret',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          id: 'normalized-video-task',
          providerDebugToken: 'provider-json-token-secret',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const successfulVideo = await requestJson(appServer, '/api/proxy/video/submit', {
        model: 'veo-3.1',
        prompt: 'normalized video',
      });
      assert.equal(successfulVideo.status, 200, successfulVideo.text);
      assert.equal(successfulVideo.data?.data?.taskId, 'normalized-video-task');
      assert.doesNotMatch(successfulVideo.text, secretPattern);
      const pendingVideo = await requestGet(appServer, '/api/proxy/video/query?taskId=video-task&model=veo-3.1');
      assert.equal(pendingVideo.status, 200, pendingVideo.text);
      assert.doesNotMatch(pendingVideo.text, secretPattern);

      const successfulSeedance = await requestJson(appServer, '/api/proxy/seedance/submit', {
        taskProvider: 'zhenzhen-legacy',
        model: 'doubao-seedance-2-0-260128',
        prompt: 'normalized seedance',
      });
      assert.equal(successfulSeedance.status, 200, successfulSeedance.text);
      assert.equal(successfulSeedance.data?.data?.taskId, 'normalized-seedance-task');
      assert.doesNotMatch(successfulSeedance.text, secretPattern);
      const pendingSeedance = await requestGet(
        appServer,
        '/api/proxy/seedance/query?taskId=seedance-task&taskProvider=zhenzhen-legacy',
      );
      assert.equal(pendingSeedance.status, 200, pendingSeedance.text);
      assert.doesNotMatch(pendingSeedance.text, secretPattern);

      const captured = captureConsoleErrors();
      global.fetch = async () => {
        throw new Error('network failed provider-secret-key https://cdn.example/private?token=provider-signed-secret');
      };
      try {
        const failed = await requestJson(appServer, '/api/proxy/video/submit', {
          model: 'veo-3.1',
          prompt: 'network failure',
        });
        assert.equal(failed.status, 500, failed.text);
        assert.doesNotMatch(failed.text, secretPattern);
      } finally {
        captured.restore();
      }
      assert.doesNotMatch(captured.messages.join('\n'), secretPattern);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('B3 task-scoped video materialization coalesces concurrent polls and reuses one output file', async () => {
  const videoBytes = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x14]),
    Buffer.from('ftypisom', 'ascii'),
    Buffer.alloc(8),
  ]);
  let assetHits = 0;
  const assetServer = await listen((_req, res) => {
    assetHits += 1;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(videoBytes);
    }, 60);
  });
  const assetBase = `http://video-output.test:${assetServer.address().port}`;

  try {
    await withProxyFixture(async ({ outputDir }) => {
      proxyRouter._test.resetVideoMaterializationCacheForTests();
      proxyRouter._test.setProxySafeRemoteTestOptions({
        allowPrivateForTests: (hostname) => hostname === 'video-output.test',
        lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
      });
      const taskKey = 'zhenzhen-legacy:dedupe-video-task';
      const urls = await Promise.all(Array.from({ length: 8 }, () => (
        proxyRouter._test.saveRemoteVideo(`${assetBase}/result.mp4?signature=first`, null, taskKey)
      )));

      assert.equal(new Set(urls).size, 1);
      assert.match(urls[0], /^\/files\/output\/vid_task_[0-9a-f]{24}_[0-9a-f]{16}\.mp4$/);
      assert.equal(assetHits, 1, 'concurrent completed polls must share one remote download');
      assert.equal(fs.readdirSync(outputDir).length, 2);

      // 模拟后端重启后内存缓存丢失、Provider 又返回了不同签名 URL：任务键仍应落到同一个文件。
      proxyRouter._test.resetVideoMaterializationCacheForTests();
      const recovered = await proxyRouter._test.saveRemoteVideo(
        `${assetBase}/result.mp4?signature=second`,
        null,
        taskKey,
      );
      assert.equal(recovered, urls[0]);
      assert.equal(assetHits, 2);
      assert.equal(fs.readdirSync(outputDir).length, 2);
    });
  } finally {
    await closeServer(assetServer);
  }
});

test('B3 signed audio upload pins the public destination, requires TLS, forbids redirects, and bounds responses', async () => {
  let privateHits = 0;
  const privateServer = await listen((_req, res) => {
    privateHits += 1;
    res.writeHead(204);
    res.end();
  });
  const received = [];
  const uploadServer = await listen((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({ path: req.url, method: req.method, contentType: req.headers['content-type'], body });
      if (req.url === '/redirect') {
        res.writeHead(307, { Location: `http://127.0.0.1:${privateServer.address().port}/internal` });
        res.end();
        return;
      }
      if (req.url === '/oversize') {
        res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' });
        res.write(Buffer.alloc(48 * 1024, 0x61));
        res.end(Buffer.alloc(48 * 1024, 0x62));
        return;
      }
      res.writeHead(req.url === '/multipart' ? 201 : 204, { 'content-type': 'text/plain' });
      res.end();
    });
  });
  const publicBase = `http://upload.test:${uploadServer.address().port}`;
  const audio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32, 0x5a)]);
  await assert.rejects(
    proxyRouter._test.uploadAudioToSignedUrl({
      uploadUrl: 'http://upload.example/insecure',
      audioBuffer: audio,
      contentType: 'audio/mpeg',
      filename: 'insecure.mp3',
    }),
    (error) => error?.code === 'invalid_protocol',
  );
  proxyRouter._test.setProxySafeRemoteTestOptions({
    allowPrivateForTests: (hostname) => hostname === 'upload.test',
    lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    protocols: ['http:'],
  });
  try {
    await assert.rejects(
      proxyRouter._test.uploadAudioToSignedUrl({
        uploadUrl: `http://127.0.0.1:${privateServer.address().port}/direct-private`,
        audioBuffer: audio,
        contentType: 'audio/mpeg',
        filename: 'private.mp3',
      }),
      (error) => error?.code === 'private_address',
    );
    assert.equal(privateHits, 0, 'direct private signed URL must be rejected before TCP connect');

    await assert.rejects(
      proxyRouter._test.uploadAudioToSignedUrl({
        uploadUrl: `${publicBase}/redirect`,
        audioBuffer: audio,
        contentType: 'audio/mpeg',
        filename: 'redirect.mp3',
      }),
      (error) => error?.code === 'upload_redirect_forbidden',
    );
    assert.equal(privateHits, 0, 'signed upload redirect target must never receive the request body');

    const put = await proxyRouter._test.uploadAudioToSignedUrl({
      uploadUrl: `${publicBase}/put`,
      audioBuffer: audio,
      contentType: 'audio/mpeg',
      filename: 'legal.mp3',
    });
    assert.equal(put.status, 204);
    assert.equal(put.ok, true);
    const post = await proxyRouter._test.uploadAudioToSignedUrl({
      uploadUrl: `${publicBase}/multipart`,
      fields: { key: 'signed/object', policy: 'bounded-policy' },
      audioBuffer: audio,
      contentType: 'audio/mpeg',
      filename: 'legal.mp3',
    });
    assert.equal(post.status, 201);
    assert.equal(post.ok, true);
    const legalPut = received.find((entry) => entry.path === '/put');
    assert.equal(legalPut.method, 'PUT');
    assert.equal(legalPut.contentType, 'audio/mpeg');
    assert.deepEqual(legalPut.body, audio);
    const legalPost = received.find((entry) => entry.path === '/multipart');
    assert.equal(legalPost.method, 'POST');
    assert.match(legalPost.contentType, /^multipart\/form-data; boundary=/);
    assert.ok(legalPost.body.includes(audio));
    assert.match(legalPost.body.toString('latin1'), /bounded-policy/);

    await assert.rejects(
      proxyRouter._test.uploadAudioToSignedUrl({
        uploadUrl: `${publicBase}/oversize`,
        audioBuffer: audio,
        contentType: 'audio/mpeg',
        filename: 'oversize.mp3',
      }),
      (error) => error?.code === 'item_too_large',
    );
  } finally {
    proxyRouter._test.setProxySafeRemoteTestOptions(null);
    await closeServer(uploadServer);
    await closeServer(privateServer);
  }
});

test('B3 task key registry scopes prevent a Zhenzhen taskId collision from overriding RunningHub credentials', async () => {
  await withProxyFixture(async ({ appServer }) => {
    const originalFetch = global.fetch;
    const calls = [];
    const collisionId = 'shared-provider-task-id';
    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), authorization: init.headers?.Authorization || '', body: String(init.body || '') });
      if (String(url).includes('/v1/images/')) {
        return new Response(JSON.stringify({ task_id: collisionId }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes('/task/openapi/outputs')) {
        return new Response(JSON.stringify({ code: 804, data: { providerDebugToken: 'rh-provider-raw-secret' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    try {
      const image = await requestJson(appServer, '/api/proxy/image/submit', {
        apiModel: 'gpt-image-2',
        model: 'gpt-image-2',
        prompt: 'scope this task key',
      });
      assert.equal(image.status, 200, image.text);

      const rh = await requestGet(appServer, `/api/proxy/runninghub/query?taskId=${collisionId}&site=cn`);
      assert.equal(rh.status, 200, rh.text);
      assert.doesNotMatch(rh.text, /rh-provider-raw-secret|providerDebugToken/);
      const rhCall = calls.find((call) => call.url.includes('/task/openapi/outputs'));
      assert.ok(rhCall);
      assert.equal(rhCall.authorization, 'Bearer runninghub-secret-key');
      assert.match(rhCall.body, /runninghub-secret-key/);
      assert.doesNotMatch(`${rhCall.authorization}\n${rhCall.body}`, /provider-secret-key/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
