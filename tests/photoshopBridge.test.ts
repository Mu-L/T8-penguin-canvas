import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import express from 'express';
import multer from 'multer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function projectFile(file: string) {
  return path.resolve(process.cwd(), file);
}

function read(file: string) {
  return fs.readFileSync(projectFile(file), 'utf8');
}

function exists(file: string) {
  return fs.existsSync(projectFile(file));
}

async function listen(app: any) {
  return new Promise<any>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('Photoshop bridge queues sanitized image imports and drains once', async (t) => {
  const route = require('../backend/src/routes/photoshopBridge.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/photoshop-bridge', route);
  const server = await listen(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = await fetch(`${base}/api/photoshop-bridge/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 't8:photoshop-result',
      source: 'photoshop-uxp',
      payload: {
        messageId: 'ps-layer-1',
        mode: 'layer',
        prompt: '把当前图层变成夜景',
        imageUrls: ['/files/output/ps-layer.png', 'https://cdn.example.com/extra.png'],
        documentName: 'poster.psd',
        layerName: '人物',
        apiKey: 'should-not-survive',
        metadata: {
          safe: 'kept',
          token: 'should-not-survive',
        },
      },
    }),
  }).then((res) => res.json());

  assert.equal(post.success, true);
  assert.equal(post.data.messageId, 'ps-layer-1');
  assert.equal(post.data.queued, true);

  const duplicate = await fetch(`${base}/api/photoshop-bridge/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 't8:photoshop-result',
      source: 'photoshop-uxp',
      payload: { messageId: 'ps-layer-1', imageUrls: ['/files/output/ps-layer.png'] },
    }),
  }).then((res) => res.json());
  assert.equal(duplicate.success, true);
  assert.equal(duplicate.data.duplicate, true);

  const pending = await fetch(`${base}/api/photoshop-bridge/pending?limit=10`).then((res) => res.json());
  assert.equal(pending.success, true);
  assert.equal(pending.data.messages.length, 1);
  assert.equal(pending.data.messages[0].type, 't8:photoshop-result');
  assert.equal(pending.data.messages[0].source, 'photoshop-uxp');
  assert.deepEqual(pending.data.messages[0].payload.imageUrls, ['/files/output/ps-layer.png', 'https://cdn.example.com/extra.png']);
  assert.equal(pending.data.messages[0].payload.prompt, '把当前图层变成夜景');
  assert.equal(pending.data.messages[0].payload.documentName, 'poster.psd');
  assert.equal(pending.data.messages[0].payload.layerName, '人物');
  assert.equal(pending.data.messages[0].payload.metadata.safe, 'kept');
  assert.equal(JSON.stringify(pending).includes('should-not-survive'), false);

  const complete = await fetch(`${base}/api/photoshop-bridge/messages/ps-layer-1/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imported: true }),
  }).then((res) => res.json());
  assert.equal(complete.success, true);
  assert.equal(complete.data.completed, true);

  const empty = await fetch(`${base}/api/photoshop-bridge/pending?limit=10`).then((res) => res.json());
  assert.equal(empty.success, true);
  assert.equal(empty.data.messages.length, 0);
});

test('Photoshop bridge exposes image providers, image generation/editing route, and base64 upload', () => {
  const route = read('backend/src/routes/photoshopBridge.js');

  assert.match(route, /router\.get\(['"]\/image-providers['"]/);
  assert.match(route, /router\.post\(['"]\/image['"]/);
  assert.match(route, /router\.post\(['"]\/upload-base64['"]/);
  assert.match(route, /router\.post\(['"]\/send-to-photoshop['"]/);
  assert.match(route, /router\.post\(['"]\/messages\/:messageId\/complete['"]/);
  assert.match(route, /router\.post\(['"]\/messages\/:messageId\/fail['"]/);
  assert.match(route, /router\.get\(['"]\/commands\/pending['"]/);
  assert.match(route, /router\.post\(['"]\/commands\/:commandId\/complete['"]/);
  assert.match(route, /router\.post\(['"]\/commands\/:commandId\/fail['"]/);
  assert.match(route, /generateImageWithProvider/);
  assert.match(route, /saveImageOutputs/);
  assert.match(route, /enqueueCommand/);
  assert.match(route, /messageInFlight/);
  assert.match(route, /commandInFlight/);
  assert.match(route, /syncToCanvas/);
  assert.match(route, /imageUrls/);
});

test('Photoshop bridge status exposes the canvas frontend URL separately from the backend bridge', async (t) => {
  const route = require('../backend/src/routes/photoshopBridge.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/photoshop-bridge', route);
  const server = await listen(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const status = await fetch(`${base}/api/photoshop-bridge/status`).then((res) => res.json());

  assert.equal(status.success, true);
  assert.equal(status.data.service, 't8-photoshop-bridge');
  assert.equal(status.data.backendUrl, base);
  assert.equal(status.data.frontendUrl, 'http://127.0.0.1:11422');
  assert.equal(status.data.canvasUrl, status.data.frontendUrl);
  assert.notEqual(status.data.frontendUrl, status.data.backendUrl);
});

test('Photoshop bridge queues canvas image materials for the UXP plugin', async (t) => {
  const route = require('../backend/src/routes/photoshopBridge.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/photoshop-bridge', route);
  const server = await listen(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const queued = await fetch(`${base}/api/photoshop-bridge/send-to-photoshop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      materials: [
        { id: 'img-1', kind: 'image', url: '/files/output/canvas-a.png', name: 'canvas-a.png' },
        { id: 'vid-1', kind: 'video', url: '/files/output/skip.mp4', name: 'skip.mp4' },
        { id: 'img-2', kind: 'image', url: 'https://cdn.example.com/canvas-b.png', name: 'canvas-b.png' },
      ],
      tags: ['T8', 'Photoshop'],
    }),
  }).then((res) => res.json());

  assert.equal(queued.success, true);
  assert.equal(queued.data.sent, 2);
  assert.equal(queued.data.skipped, 1);
  assert.ok(queued.data.commandId);

  const pending = await fetch(`${base}/api/photoshop-bridge/commands/pending?limit=4`).then((res) => res.json());
  assert.equal(pending.success, true);
  assert.equal(pending.data.commands.length, 1);
  assert.equal(pending.data.commands[0].type, 't8:photoshop-command');
  assert.equal(pending.data.commands[0].source, 't8-canvas');
  assert.equal(pending.data.commands[0].command, 'place-materials');
  assert.equal(pending.data.commands[0].payload.materials.length, 2);
  assert.deepEqual(pending.data.commands[0].payload.materials.map((item: any) => item.url), [
    '/files/output/canvas-a.png',
    'https://cdn.example.com/canvas-b.png',
  ]);

  const complete = await fetch(`${base}/api/photoshop-bridge/commands/${encodeURIComponent(queued.data.commandId)}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ placed: 2 }),
  }).then((res) => res.json());
  assert.equal(complete.success, true);
  assert.equal(complete.data.completed, true);
  assert.equal(complete.data.placed, 2);

  const empty = await fetch(`${base}/api/photoshop-bridge/commands/pending?limit=4`).then((res) => res.json());
  assert.equal(empty.success, true);
  assert.equal(empty.data.commands.length, 0);
});

test('Photoshop image route runs generation and edit through an enabled image provider', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-photoshop-image-route-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: '4mb' }));
  const upload = multer();
  const upstreamCalls: any[] = [];
  upstreamApp.post('/v1/images/generations', (req, res) => {
    upstreamCalls.push({ path: req.path, body: req.body, auth: req.header('authorization') });
    res.json({ data: [{ b64_json: Buffer.from('PSPNG').toString('base64'), mime_type: 'image/png' }] });
  });
  upstreamApp.post('/v1/images/edits', upload.any(), (req, res) => {
    upstreamCalls.push({
      path: req.path,
      body: req.body,
      files: req.files,
      auth: req.header('authorization'),
      contentType: req.header('content-type'),
    });
    res.json({ data: [{ b64_json: Buffer.from('PSEDITPNG').toString('base64'), mime_type: 'image/png' }] });
  });
  const upstreamServer = await listen(upstreamApp);
  t.after(() => upstreamServer.close());

  const config = require('../backend/src/config.js');
  const oldConfig = {
    SETTINGS_FILE: config.SETTINGS_FILE,
    OUTPUT_DIR: config.OUTPUT_DIR,
    DEFAULT_LOCAL_SAVE_DIR: config.DEFAULT_LOCAL_SAVE_DIR,
    DEFAULT_CANVAS_AUTO_SAVE_DIR: config.DEFAULT_CANVAS_AUTO_SAVE_DIR,
    DEFAULT_RESOURCE_LIBRARY_DIR: config.DEFAULT_RESOURCE_LIBRARY_DIR,
    DEFAULT_THEME_TEMPLATE_DIR: config.DEFAULT_THEME_TEMPLATE_DIR,
  };
  t.after(() => Object.assign(config, oldConfig));
  config.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  config.OUTPUT_DIR = path.join(tmpDir, 'output');
  config.DEFAULT_LOCAL_SAVE_DIR = path.join(tmpDir, 'save');
  config.DEFAULT_CANVAS_AUTO_SAVE_DIR = path.join(tmpDir, 'canvas');
  config.DEFAULT_RESOURCE_LIBRARY_DIR = path.join(tmpDir, 'resources');
  config.DEFAULT_THEME_TEMPLATE_DIR = path.join(tmpDir, 'themes');
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  const settingsRouter = require('../backend/src/routes/settings.js');
  const route = require('../backend/src/routes/photoshopBridge.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/settings', settingsRouter);
  app.use('/api/photoshop-bridge', route);
  const server = await listen(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const upstreamBase = `http://127.0.0.1:${upstreamServer.address().port}/v1`;

  const savedSettings = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      advancedProviders: [
        {
          id: 'ps-openai',
          name: 'PS Mock Provider',
          protocol: 'openai-compatible',
          enabled: true,
          baseUrl: upstreamBase,
          apiKey: 'sk-photoshop-route-secret',
          imageModels: ['ps-image-model'],
        },
      ],
    }),
  }).then((res) => res.json());
  assert.equal(savedSettings.success, true);

  const generated = await fetch(`${base}/api/photoshop-bridge/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: 'ps-openai',
      providerModel: 'ps-image-model',
      prompt: 'draw from photoshop panel',
      size: '512x512',
      syncToCanvas: true,
      messageId: 'ps-image-route-generate-1',
    }),
  }).then((res) => res.json());

  assert.equal(generated.success, true);
  assert.equal(generated.data.mode, 'generate');
  assert.equal(generated.data.model, 'ps-image-model');
  assert.equal(generated.data.imageUrls.length, 1);
  assert.match(generated.data.imageUrls[0], /^\/files\/output\/ps_external_/);
  assert.equal(fs.existsSync(path.join(config.OUTPUT_DIR, path.basename(generated.data.imageUrls[0]))), true);
  assert.equal(generated.data.bridge.queued, true);
  assert.equal(JSON.stringify(generated).includes('sk-photoshop-route-secret'), false);

  const generatedPending = await fetch(`${base}/api/photoshop-bridge/pending?limit=4`).then((res) => res.json());
  assert.equal(generatedPending.success, true);
  assert.equal(generatedPending.data.messages.length, 1);
  assert.equal(generatedPending.data.messages[0].payload.messageId, 'ps-image-route-generate-1');
  assert.deepEqual(generatedPending.data.messages[0].payload.imageUrls, generated.data.imageUrls);

  const generatedComplete = await fetch(`${base}/api/photoshop-bridge/messages/ps-image-route-generate-1/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imported: true }),
  }).then((res) => res.json());
  assert.equal(generatedComplete.success, true);
  assert.equal(generatedComplete.data.completed, true);

  const edited = await fetch(`${base}/api/photoshop-bridge/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: 'ps-openai',
      providerModel: 'ps-image-model',
      prompt: 'edit from photoshop layer',
      size: '512x512',
      referenceImages: ['data:image/png;base64,QUJD'],
      documentName: 'route.psd',
      layerName: 'Layer 1',
      syncToCanvas: false,
    }),
  }).then((res) => res.json());

  assert.equal(edited.success, true);
  assert.equal(edited.data.mode, 'edit');
  assert.deepEqual(edited.data.referenceImages, ['data:image/png;base64,QUJD']);
  assert.equal(edited.data.imageUrls.length, 1);
  assert.match(edited.data.imageUrls[0], /^\/files\/output\/ps_external_/);
  assert.equal(fs.existsSync(path.join(config.OUTPUT_DIR, path.basename(edited.data.imageUrls[0]))), true);
  assert.equal(edited.data.bridge, null);
  assert.equal(JSON.stringify(edited).includes('sk-photoshop-route-secret'), false);

  assert.equal(upstreamCalls.length, 2);
  assert.equal(upstreamCalls[0].path, '/v1/images/generations');
  assert.equal(upstreamCalls[0].auth, 'Bearer sk-photoshop-route-secret');
  assert.equal(upstreamCalls[0].body.model, 'ps-image-model');
  assert.equal(upstreamCalls[0].body.prompt, 'draw from photoshop panel');
  assert.equal(upstreamCalls[1].path, '/v1/images/edits');
  assert.match(upstreamCalls[1].contentType, /^multipart\/form-data; boundary=/);
  assert.equal(upstreamCalls[1].auth, 'Bearer sk-photoshop-route-secret');
  assert.equal(upstreamCalls[1].body.model, 'ps-image-model');
  assert.equal(upstreamCalls[1].body.prompt, 'edit from photoshop layer');
  assert.ok(upstreamCalls[1].files.length >= 1);
});

test('Photoshop UXP plugin has assets, generate, and settings tabs without Agent', () => {
  assert.ok(exists('tools/photoshop-bridge/plugin/manifest.json'), 'missing Photoshop plugin manifest');
  assert.ok(exists('tools/photoshop-bridge/plugin/index.html'), 'missing Photoshop plugin index');
  assert.ok(exists('tools/photoshop-bridge/plugin/style.css'), 'missing Photoshop plugin styles');
  assert.ok(exists('tools/photoshop-bridge/plugin/js/boot.js'), 'missing Photoshop plugin boot diagnostics');
  assert.ok(exists('tools/photoshop-bridge/plugin/js/state.js'), 'missing Photoshop plugin state');
  assert.ok(exists('tools/photoshop-bridge/plugin/js/net.js'), 'missing Photoshop plugin net');
  assert.ok(exists('tools/photoshop-bridge/plugin/js/ps.js'), 'missing Photoshop plugin ps helpers');
  assert.ok(exists('tools/photoshop-bridge/plugin/js/app.js'), 'missing Photoshop plugin app');

  const manifest = JSON.parse(read('tools/photoshop-bridge/plugin/manifest.json'));
  assert.equal(manifest.manifestVersion, 5);
  assert.equal(manifest.version, '0.1.4');
  assert.equal(manifest.host.app, 'PS');
  assert.match(manifest.name, /T8|Photoshop|PS/i);
  assert.deepEqual(
    manifest.entrypoints?.[0]?.label,
    { default: 'T8 Photoshop Link' },
    'Manifest v5 panel labels should use the localized string object form used by Adobe examples',
  );

  const html = read('tools/photoshop-bridge/plugin/index.html');
  const css = read('tools/photoshop-bridge/plugin/style.css');
  assert.match(html, /data-tab=["']assets["']/);
  assert.match(html, /data-tab=["']generate["']/);
  assert.match(html, /data-tab=["']settings["']/);
  assert.match(html, /id=["']generateModeHint["']/, 'current-layer mode needs an immediate visible readiness message');
  assert.match(html, /v0\.1\.4/, 'the panel should expose its loaded plugin version for support diagnostics');
  assert.match(html, /id=["']assetPager["']/, 'asset library needs pagination in Photoshop panels');
  assert.match(html, /id=["']prevAssetPage["']/, 'asset library needs a previous page control');
  assert.match(html, /id=["']nextAssetPage["']/, 'asset library needs a next page control');
  assert.match(html, /js\/boot\.js/, 'plugin should install boot diagnostics before app scripts');
  assert.match(html, /id=["']assetSearch["'][^>]+type=["']text["']/, 'UXP search fields should use a stable text input');
  assert.match(html, /id=["']assetSearch["'][^>]+inputmode=["']search["']/, 'asset search should still hint search keyboard behavior');
  assert.doesNotMatch(html, /data-tab=["']agent["']/i);
  assert.doesNotMatch(html, /Agent/i);
  assert.match(css, /white-space:\s*nowrap/, 'plugin action buttons should not wrap Chinese labels vertically');
  assert.match(css, /min-width:\s*(?:5[6-9]|[6-9]\d)px/, 'compact action buttons need a stable minimum width');
  assert.match(css, /height:\s*36px/, 'plugin inputs need a fixed readable height in Photoshop UXP');
  assert.match(css, /height:\s*100vh/, 'plugin shell should be bounded to the Photoshop panel viewport');
  assert.match(css, /overflow:\s*hidden/, 'plugin shell should prevent asset lists from growing the panel');
  assert.match(css, /\[data-view=["']generate["']\]\.active[\s\S]*overflow-y:\s*auto/, 'compact generate panels must scroll instead of clipping current-layer feedback');
  assert.match(css, /-webkit-appearance:\s*none/, 'native search/input appearance can collapse in Photoshop UXP');
  assert.match(css, /flex-wrap:\s*wrap/, 'asset cards should use a UXP-safe wrapping layout');
  assert.doesNotMatch(css, /repeat\(auto-fill/, 'auto-fill CSS grids can render blank in Photoshop UXP panels');

  const app = read('tools/photoshop-bridge/plugin/js/app.js');
  const boot = read('tools/photoshop-bridge/plugin/js/boot.js');
  const ps = read('tools/photoshop-bridge/plugin/js/ps.js');
  assert.match(boot, /T8PS_REPORT_BOOT_ERROR/);
  assert.match(ps, /Photoshop API 初始化失败/);
  assert.match(app, /\/api\/photoshop-bridge\/library/);
  assert.match(app, /\/api\/photoshop-bridge\/image-providers/);
  assert.match(app, /\/api\/photoshop-bridge\/image/);
  assert.match(app, /\/api\/photoshop-bridge\/commands\/pending/);
  assert.match(app, /exportCurrentPng/);
  assert.match(app, /placeImage/);
  assert.match(app, /pollCommands/);
  assert.match(app, /document\.createElement\(['"]div['"]\)/, 'asset cards should be created with DOM APIs for UXP');
  assert.match(app, /assetPageSize:\s*24|assetPageSize\)\s*\|\|\s*24|state\.assetPageSize/, 'asset cards should be paged in UXP panels');
  assert.match(app, /renderAssetPager/, 'asset pagination controls should be rendered');
  assert.doesNotMatch(app, /assetGrid\.innerHTML\s*=\s*items\.map/, 'large asset lists should not be rendered with one innerHTML blob in UXP');
  assert.doesNotMatch(app, /\/api\/chat\/agent/);
});

test('Photoshop UXP manifest allows the local T8 bridge origins used by fetch', () => {
  const manifest = JSON.parse(read('tools/photoshop-bridge/plugin/manifest.json'));
  const domains = manifest.requiredPermissions?.network?.domains || [];
  assert.ok(Array.isArray(domains), 'network.domains must be an explicit allowlist');

  for (const host of ['127.0.0.1', 'localhost']) {
    for (let port = 18766; port <= 18776; port += 1) {
      const origin = `http://${host}:${port}`;
      assert.ok(
        domains.includes(origin),
        `UXP fetch needs manifest requiredPermissions.network.domains to include ${origin}`,
      );
    }
  }

  assert.equal(domains.includes('all'), false, 'Photoshop plugin should only allow local T8 bridge origins');
  assert.equal(domains.includes('127.0.0.1'), false, 'UXP v5 network domains should not include bare host entries');
  assert.equal(domains.includes('localhost'), false, 'UXP v5 network domains should not include bare host entries');
});

test('Photoshop UXP net connect falls back when the default local bridge port is occupied', async () => {
  const storage = new Map([['t8.ps.host', '127.0.0.1:18766']]);
  const calls: string[] = [];
  const context: any = {
    console,
    URL,
    Uint8Array,
    ArrayBuffer,
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    fetch: async (url: string) => {
      calls.push(String(url));
      const parsed = new URL(String(url));
      if (parsed.origin === 'http://127.0.0.1:18766') {
        return {
          ok: false,
          status: 404,
          text: async () => '<pre>Cannot GET /api/photoshop-bridge/status</pre>',
        };
      }
      if (parsed.origin === 'http://127.0.0.1:18767') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            success: true,
            data: { service: 't8-photoshop-bridge', version: '2.4.7' },
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('tools/photoshop-bridge/plugin/js/state.js'), context);
  vm.runInContext(read('tools/photoshop-bridge/plugin/js/net.js'), context);

  const data = await context.T8PS.net.connect('127.0.0.1:18766');

  assert.equal(data.service, 't8-photoshop-bridge');
  assert.equal(context.T8PS.state.connected, true);
  assert.equal(context.T8PS.state.host, '127.0.0.1:18767');
  assert.equal(storage.get('t8.ps.host'), '127.0.0.1:18767');
  assert.deepEqual(calls, [
    'http://127.0.0.1:18766/api/photoshop-bridge/status',
    'http://127.0.0.1:18767/api/photoshop-bridge/status',
  ]);
});

test('Photoshop UXP plugin opens the canvas frontend and fetches asset previews for UXP rendering', () => {
  const state = read('tools/photoshop-bridge/plugin/js/state.js');
  const net = read('tools/photoshop-bridge/plugin/js/net.js');
  const app = read('tools/photoshop-bridge/plugin/js/app.js');

  assert.match(state, /frontendUrl/, 'plugin state should remember the frontend canvas URL reported by the bridge');
  assert.match(net, /state\.frontendUrl/, 'connect() should store the frontend canvas URL from /status');
  assert.match(net, /imageDataUrl/, 'plugin should fetch local thumbnails and convert them into data URLs for UXP images');
  assert.match(app, /function\s+canvasUrl\(/, 'open canvas button should resolve a dedicated frontend URL');
  assert.match(app, /ps\.openUrl\(canvasUrl\(\)\)/, 'open canvas button must not open the backend bridge root');
  assert.doesNotMatch(app, /ps\.openUrl\(`http:\/\/\$\{state\.host\}\/`\)/, 'opening the backend bridge root shows Cannot GET / in dev');
  assert.match(app, /loadImagePreview/, 'asset and result cards should use the UXP preview loader');
  assert.match(app, /net\.imageDataUrl/, 'preview loader should use fetched image data instead of only direct localhost img src');
  assert.match(app, /正在从 T8 画布置入/, 'canvas-to-Photoshop command polling should show visible asset-tab progress');
  assert.match(app, /setMsg\(els\.assetMsg,\s*err\.message \|\| String\(err\),\s*['"]err['"]\)/, 'command polling errors should be visible outside the settings tab');
});

function createPhotoshopPlaceContext(options: { addLayerOnPlace?: boolean } = {}) {
  const calls: any[] = [];
  const tempFile = {
    write: async () => undefined,
    read: async () => new ArrayBuffer(0),
  };
  const doc: any = {
    id: 10,
    name: 'canvas.psd',
    layers: [{ id: 1, name: '背景' }],
  };
  const context: any = {
    console,
    ArrayBuffer,
    Uint8Array,
    window: {},
    T8PS: {
      net: {
        fetchBytes: async () => new Uint8Array([137, 80, 78, 71]).buffer,
      },
    },
    require: (name: string) => {
      if (name === 'uxp') {
        return {
          storage: {
            formats: { binary: 'binary' },
            localFileSystem: {
              getTemporaryFolder: async () => ({
                createFile: async () => tempFile,
              }),
              createSessionToken: async () => 'session-token',
            },
          },
          shell: { openExternal: async () => undefined },
        };
      }
      if (name === 'photoshop') {
        return {
          app: {
            documents: [doc],
            activeDocument: doc,
            open: async () => undefined,
          },
          core: {
            executeAsModal: async (fn: any) => fn(),
          },
          action: {
            batchPlay: async (descriptors: any[], batchOptions: any) => {
              calls.push({ descriptors, batchOptions });
              if (options.addLayerOnPlace) doc.layers.push({ id: 2, name: 'T8 placed image' });
              return [{ _obj: 'placedLayer' }];
            },
            addNotificationListener: () => undefined,
          },
        };
      }
      throw new Error(`unexpected require ${name}`);
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('tools/photoshop-bridge/plugin/js/ps.js'), context);
  return { context, calls, doc };
}

test('Photoshop UXP placeImage only reports success after Photoshop creates a layer', async () => {
  const noOp = createPhotoshopPlaceContext({ addLayerOnPlace: false });
  await assert.rejects(
    () => noOp.context.T8PS.ps.placeImage({ url: '/files/output/noop.png', name: 'noop.png' }),
    /未新增图层|置入/,
  );

  const placed = createPhotoshopPlaceContext({ addLayerOnPlace: true });
  const result = await placed.context.T8PS.ps.placeImage({ url: '/files/output/ok.png', name: 'ok.png' });

  assert.equal(result.placed, true);
  assert.equal(placed.doc.layers.length, 2);
  assert.equal(placed.calls.length, 1);
  assert.equal(placed.calls[0].descriptors[0]._obj, 'placeEvent');
  assert.equal(placed.calls[0].descriptors[0].linked, false);
  assert.equal(placed.calls[0].descriptors[0]._options.dialogOptions, 'dontDisplay');
  assert.equal(placed.calls[0].batchOptions.synchronousExecution, true);
});

function createPhotoshopLayerExportContext(options: {
  batchResult?: any[];
  saveError?: Error;
  activateTemporaryDocument?: boolean;
  mode?: string;
  bitsPerChannel?: number;
  cancelDuringSave?: boolean;
  closeError?: Error;
} = {}) {
  const calls: any[] = [];
  let closeCalls = 0;
  let autoCloseCalls = 0;
  const registeredDocumentIds: number[] = [];
  const unregisteredDocumentIds: number[] = [];
  const modeChanges: string[] = [];
  let currentExecutionContext: any = null;
  const output = new Uint8Array([137, 80, 78, 71]).buffer;
  const tempFile = {
    read: async () => output,
  };
  const sourceDoc: any = {
    id: 10,
    name: 'canvas.psd',
    activeLayers: [{ id: 77, name: '用户当前层' }],
    layers: [{ id: 77, name: '用户当前层' }],
  };
  const tempDoc: any = {
    id: 20,
    name: 't8_tmp_layer_export',
    mode: options.mode || 'rgb',
    bitsPerChannel: options.bitsPerChannel || 8,
    changeMode: async (mode: string) => {
      modeChanges.push(mode);
      tempDoc.mode = mode;
    },
    saveAs: {
      png: async () => {
        if (options.cancelDuringSave && currentExecutionContext) currentExecutionContext.isCancelled = true;
        if (options.saveError) throw options.saveError;
      },
    },
    closeWithoutSaving: async () => {
      if (options.closeError) throw options.closeError;
      closeCalls += 1;
      app.activeDocument = sourceDoc;
    },
  };
  const app: any = {
    documents: [sourceDoc],
    activeDocument: sourceDoc,
    open: async () => undefined,
  };
  const context: any = {
    console,
    ArrayBuffer,
    Uint8Array,
    window: {},
    T8PS: {
      net: {
        fetchBytes: async () => output,
      },
    },
    require: (name: string) => {
      if (name === 'uxp') {
        return {
          storage: {
            formats: { binary: 'binary' },
            localFileSystem: {
              getTemporaryFolder: async () => ({
                createFile: async () => tempFile,
              }),
              createSessionToken: async () => 'session-token',
            },
          },
          shell: { openExternal: async () => undefined },
        };
      }
      if (name === 'photoshop') {
        return {
          app,
          constants: {
            ChangeMode: { RGB: 'rgb' },
            DocumentMode: {
              RGB: 'rgb',
              CMYK: 'cmyk',
              LAB: 'lab',
              BITMAP: 'bitmap',
              GRAYSCALE: 'grayscale',
              INDEXEDCOLOR: 'indexedColor',
              DUOTONE: 'duotone',
              MULTICHANNEL: 'multichannel',
            },
            BitsPerChannelType: { EIGHT: 8, SIXTEEN: 16, THIRTYTWO: 32 },
          },
          core: {
            executeAsModal: async (fn: any) => {
              const autoCloseIds = new Set<number>();
              const executionContext = {
                isCancelled: false,
                hostControl: {
                  registerAutoCloseDocument: async (documentId: number) => {
                    registeredDocumentIds.push(documentId);
                    autoCloseIds.add(documentId);
                  },
                  unregisterAutoCloseDocument: async (documentId: number) => {
                    unregisteredDocumentIds.push(documentId);
                    autoCloseIds.delete(documentId);
                  },
                },
              };
              currentExecutionContext = executionContext;
              try {
                return await fn(executionContext);
              } finally {
                currentExecutionContext = null;
                if (autoCloseIds.has(tempDoc.id)) {
                  autoCloseCalls += 1;
                  app.activeDocument = sourceDoc;
                }
              }
            },
          },
          action: {
            batchPlay: async (descriptors: any[], batchOptions: any) => {
              calls.push({ descriptors, batchOptions });
              const result = options.batchResult || [{ _obj: 'document', documentID: tempDoc.id }];
              if (options.activateTemporaryDocument !== false && !result.some((entry) => entry?._obj === 'error')) {
                app.activeDocument = tempDoc;
              }
              return result;
            },
            addNotificationListener: () => undefined,
          },
        };
      }
      throw new Error(`unexpected require ${name}`);
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('tools/photoshop-bridge/plugin/js/ps.js'), context);
  return {
    context,
    calls,
    sourceDoc,
    tempDoc,
    modeChanges,
    registeredDocumentIds,
    unregisteredDocumentIds,
    getCloseCalls: () => closeCalls,
    getAutoCloseCalls: () => autoCloseCalls,
  };
}

test('Photoshop UXP current-layer export uses a direct layer reference and always closes its temporary document', async () => {
  const exported = createPhotoshopLayerExportContext();
  const result = await exported.context.T8PS.ps.exportCurrentPng(true);

  assert.equal(result.documentName, 'canvas.psd');
  assert.equal(result.layerName, '用户当前层');
  assert.equal(result.buffer.byteLength, 4);
  assert.equal(exported.calls.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(exported.calls[0].descriptors[0].using)),
    { _ref: 'layer', _id: 77 },
  );
  assert.equal(exported.calls[0].descriptors[0].version, 5);
  assert.deepEqual(exported.registeredDocumentIds, [20]);
  assert.deepEqual(exported.unregisteredDocumentIds, []);
  assert.equal(exported.getCloseCalls(), 0);
  assert.equal(exported.getAutoCloseCalls(), 1);
  assert.equal(exported.context.require('photoshop').app.activeDocument, exported.sourceDoc);

  const failedSave = createPhotoshopLayerExportContext({ saveError: new Error('PNG save failed') });
  await assert.rejects(
    () => failedSave.context.T8PS.ps.exportCurrentPng(true),
    /PNG save failed/,
  );
  assert.equal(failedSave.getCloseCalls(), 0);
  assert.equal(failedSave.getAutoCloseCalls(), 1, 'temporary document must auto-close even when PNG saving fails');
  assert.equal(failedSave.context.require('photoshop').app.activeDocument, failedSave.sourceDoc);
});

test('Photoshop UXP current-layer export normalizes CMYK 32-bit temporary documents before PNG save', async () => {
  const exported = createPhotoshopLayerExportContext({ mode: 'cmyk', bitsPerChannel: 32 });
  await exported.context.T8PS.ps.exportCurrentPng(true);

  assert.deepEqual(exported.modeChanges, ['rgb']);
  assert.equal(exported.tempDoc.mode, 'rgb');
  assert.equal(exported.tempDoc.bitsPerChannel, 8);
  assert.equal(exported.getCloseCalls(), 0);
  assert.equal(exported.getAutoCloseCalls(), 1);
});

test('Photoshop UXP current-layer export keeps PNG-compatible Bitmap mode unchanged', async () => {
  const exported = createPhotoshopLayerExportContext({ mode: 'bitmap', bitsPerChannel: 8 });
  await exported.context.T8PS.ps.exportCurrentPng(true);

  assert.deepEqual(exported.modeChanges, []);
  assert.equal(exported.tempDoc.mode, 'bitmap');
  assert.equal(exported.getAutoCloseCalls(), 1);
});

test('Photoshop UXP current-layer export registers host auto-close for modal cancellation cleanup', async () => {
  const cancelled = createPhotoshopLayerExportContext({
    saveError: new Error('User cancelled the operation'),
    cancelDuringSave: true,
    closeError: new Error('document changes forbidden after cancellation'),
  });

  await assert.rejects(
    () => cancelled.context.T8PS.ps.exportCurrentPng(true),
    /User cancelled/,
  );
  assert.deepEqual(cancelled.registeredDocumentIds, [20]);
  assert.deepEqual(cancelled.unregisteredDocumentIds, []);
  assert.equal(cancelled.getCloseCalls(), 0);
  assert.equal(cancelled.getAutoCloseCalls(), 1);
  assert.equal(cancelled.context.require('photoshop').app.activeDocument, cancelled.sourceDoc);
});

test('Photoshop UXP current-layer export surfaces resolved batchPlay errors instead of looking successful', async () => {
  const exported = createPhotoshopLayerExportContext({
    batchResult: [{ _obj: 'error', result: -25922, message: '当前图层命令不可用' }],
    activateTemporaryDocument: false,
  });

  await assert.rejects(
    () => exported.context.T8PS.ps.exportCurrentPng(true),
    /当前图层命令不可用/,
  );
  assert.equal(exported.getCloseCalls(), 0);
});

test('Photoshop edit-current-layer mode ignores the persisted document-upload preference and gives immediate feedback', () => {
  const app = read('tools/photoshop-bridge/plugin/js/app.js');
  assert.match(
    app,
    /uploadCurrentToT8\(\{\s*queue:\s*false,\s*prompt:\s*request\.prompt,\s*preferLayer:\s*true\s*\}\)/,
    'edit-current-layer must always export a layer even if the upload preference was persisted as false',
  );
  assert.match(app, /已选择当前图层/, 'selecting edit mode should immediately explain which layer will be used');
  assert.match(app, /activeLayerInfo/, 'mode feedback should inspect the actual Photoshop document/layer state');
});

test('Photoshop generation snapshots mutable controls and serializes every Photoshop mutation', () => {
  const app = read('tools/photoshop-bridge/plugin/js/app.js');
  const state = read('tools/photoshop-bridge/plugin/js/state.js');
  assert.match(app, /const request = \{[\s\S]*providerId:\s*provider\.id,[\s\S]*model:\s*state\.model,[\s\S]*size:\s*els\.sizeSelect\.value,[\s\S]*aspectRatio:\s*els\.ratioSelect\.value,[\s\S]*syncToCanvas:[\s\S]*autoPlace:/);
  assert.match(app, /providerId:\s*request\.providerId/);
  assert.match(app, /providerModel:\s*request\.model/);
  assert.match(app, /model:\s*request\.model/);
  assert.match(app, /size:\s*request\.size/);
  assert.match(app, /aspect_ratio:\s*request\.aspectRatio/);
  assert.match(app, /syncToCanvas:\s*request\.syncToCanvas/);
  assert.match(app, /if \(request\.autoPlace\)/);
  assert.match(app, /\[\s*els\.providerSelect,[\s\S]*els\.connectBtn,[\s\S]*\]\.forEach\(\(control\) => \{\s*control\.disabled = locked;/);
  assert.match(app, /els\.modeButtons\.forEach\(\(button\) => \{\s*button\.disabled = locked;/);
  assert.match(state, /psOperationBusy:\s*''/);
  assert.match(app, /function beginPhotoshopOperation\(label\)/);
  assert.match(app, /function endPhotoshopOperation\(label\)/);
  assert.ok(
    (app.match(/if \(state\.generateBusy \|\| state\.psOperationBusy\)/g) || []).length >= 2,
    'background command polling must check the shared lock both before and after awaiting pending commands',
  );
  assert.match(app, /beginPhotoshopOperation\('canvas-command'\)/);
  assert.match(app, /beginPhotoshopOperation\('generate'\)/);
  assert.match(app, /beginPhotoshopOperation\('asset-place'\)/);
  assert.match(app, /beginPhotoshopOperation\('asset-upload'\)/);
  assert.match(app, /async function connect\(\) \{\s*if \(state\.generateBusy \|\| state\.psOperationBusy\) return;/, 'reconnecting must not change hosts during an in-flight Photoshop operation');
});

test('T8 app packages Photoshop plugin and drains Photoshop bridge messages into canvas', () => {
  const server = read('backend/src/server.js');
  const canvas = read('src/components/Canvas.tsx');
  const bridge = read('src/utils/photoshopBridge.ts');
  const modal = read('src/components/SendMaterialsModal.tsx');
  const api = read('src/services/api.ts');
  const pkg = read('package.json');
  const postBuild = read('electron/_post_build.cjs');

  assert.match(server, /photoshopBridgeRouter/);
  assert.match(server, /\/api\/photoshop-bridge/);
  assert.match(canvas, /importPhotoshopPayload/);
  assert.match(canvas, /\/api\/photoshop-bridge\/pending/);
  assert.match(canvas, /\/api\/photoshop-bridge\/messages\/\$\{encodeURIComponent\(messageId\)\}\/\$\{endpoint\}/);
  assert.match(canvas, /settleMessage/);
  assert.match(canvas, /buildPhotoshopSendNodeSpecs/);
  assert.match(canvas, /handleSendMaterialsToPhotoshop/);
  assert.ok(
    canvas.indexOf('photoshopImportMessageIdsRef.current.add(messageId)') >
      canvas.indexOf("registerPlacementShelfNodes(assignedNewNodes, '发送')"),
  );
  assert.match(bridge, /PHOTOSHOP_MESSAGE_CONTRACT/);
  assert.match(bridge, /createOutputDataFromItems/);
  assert.match(modal, /onSendToPhotoshop/);
  assert.match(modal, /发送到 Photoshop/);
  assert.match(api, /sendToPhotoshop/);
  assert.match(pkg, /tools\/photoshop-bridge/);
  assert.match(postBuild, /photoshop-bridge/);
  assert.match(postBuild, /packaged Photoshop plugin differs from the authoritative source/);
  assert.match(postBuild, /packaged Photoshop plugin manifest id\/version is stale/);
  assert.match(postBuild, /stale Photoshop plugin archive must not be packaged/);
  assert.match(postBuild, /manifest\.json/);
});
