import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

async function listen(app: any) {
  return new Promise<any>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('Gemini Pro Image uses official generateContent payload without changing nano-banana-pro legacy payload', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-gemini-official-image-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const validPng = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 32, g: 96, b: 224, alpha: 1 } },
  }).png().toBuffer();

  const upstreamCalls: any[] = [];
  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: '4mb' }));
  upstreamApp.post(/^\/v1\/models\/([^/]+):generateContent$/, (req, res) => {
    upstreamCalls.push({
      path: req.path,
      body: req.body,
      auth: req.header('authorization'),
      googleKey: req.header('x-goog-api-key'),
    });
    res.json({
      candidates: [
        {
          content: {
            parts: [
              { text: 'ok' },
              { inlineData: { mimeType: 'image/png', data: validPng.toString('base64') } },
            ],
          },
        },
      ],
    });
  });
  upstreamApp.post('/v1/images/generations', (req, res) => {
    upstreamCalls.push({ path: req.path, body: req.body, auth: req.header('authorization') });
    res.json({ data: [{ b64_json: validPng.toString('base64'), mime_type: 'image/png' }] });
  });
  const upstreamServer = await listen(upstreamApp);
  t.after(() => upstreamServer.close());

  const config = require('../backend/src/config.js');
  const oldConfig = {
    SETTINGS_FILE: config.SETTINGS_FILE,
    OUTPUT_DIR: config.OUTPUT_DIR,
    ZHENZHEN_BASE_URL: config.ZHENZHEN_BASE_URL,
  };
  t.after(() => Object.assign(config, oldConfig));
  config.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  config.OUTPUT_DIR = path.join(tmpDir, 'output');
  config.ZHENZHEN_BASE_URL = `http://127.0.0.1:${upstreamServer.address().port}`;
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify({
    zhenzhenApiKey: '',
    nanoBananaApiKey: 'sk-nano-banana',
  }));

  const proxyRouter = require('../backend/src/routes/proxy.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/proxy', proxyRouter);
  const server = await listen(app);
  t.after(() => server.close());

  const base = `http://127.0.0.1:${server.address().port}`;
  const official = await fetch(`${base}/api/proxy/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'nano-banana-pro',
      apiModel: 'gemini-3-pro-image',
      paramKind: 'banana-ratio',
      prompt: 'official pro image',
      aspect_ratio: '16:9',
      image_size: '4K',
    }),
  }).then((res) => res.json());

  assert.equal(official.success, true);
  assert.match(official.data.urls[0], /^\/files\/output\/img_/);
  assert.equal(upstreamCalls[0].path, '/v1/models/gemini-3-pro-image:generateContent');
  assert.equal(upstreamCalls[0].auth, 'Bearer sk-nano-banana');
  assert.equal(upstreamCalls[0].googleKey, 'sk-nano-banana');
  assert.deepEqual(upstreamCalls[0].body.contents[0].parts, [{ text: 'official pro image' }]);
  assert.deepEqual(upstreamCalls[0].body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  assert.deepEqual(upstreamCalls[0].body.generationConfig.responseFormat.image, {
    aspectRatio: '16:9',
    imageSize: '4K',
  });
  assert.equal('image_size' in upstreamCalls[0].body, false);

  const lite = await fetch(`${base}/api/proxy/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'nano-banana-2',
      apiModel: 'gemini-3.1-flash-lite-image',
      paramKind: 'banana-ratio',
      prompt: 'official lite image',
      aspect_ratio: '1:1',
      image_size: '4K',
    }),
  }).then((res) => res.json());

  assert.equal(lite.success, true);
  assert.equal(upstreamCalls[1].path, '/v1/models/gemini-3.1-flash-lite-image:generateContent');
  assert.deepEqual(upstreamCalls[1].body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  assert.deepEqual(upstreamCalls[1].body.generationConfig.responseFormat.image, {
    aspectRatio: '1:1',
    imageSize: '1K',
  });
  assert.equal('image_size' in upstreamCalls[1].body, false);

  const legacy = await fetch(`${base}/api/proxy/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'nano-banana-pro',
      apiModel: 'nano-banana-pro',
      paramKind: 'banana-ratio',
      prompt: 'legacy pro image',
      aspect_ratio: '1:1',
      image_size: '2K',
    }),
  }).then((res) => res.json());

  assert.equal(legacy.success, true);
  assert.equal(upstreamCalls[2].path, '/v1/images/generations');
  assert.equal(upstreamCalls[2].auth, 'Bearer sk-nano-banana');
  assert.equal(upstreamCalls[2].body.model, 'nano-banana-pro');
  assert.equal(upstreamCalls[2].body.aspect_ratio, '1:1');
  assert.equal(upstreamCalls[2].body.image_size, '2K');
  assert.equal(upstreamCalls[2].body.generationConfig, undefined);
});

test('Gemini official async task results are polled and saved from nested OpenAI image data', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-gemini-official-task-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const validPng = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 120, b: 220, alpha: 1 } },
  }).png().toBuffer();

  let upstreamBase = '';
  let taskQueries = 0;
  let outputDownloads = 0;
  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: '4mb' }));
  upstreamApp.post(/^\/v1\/models\/([^/]+):generateContent$/, (_req, res) => {
    res.json({
      task_id: 'a7b5f20c5fa341f78c01f5e559751938',
      platform: 'sync-task',
      status: 'SUBMITTED',
    });
  });
  upstreamApp.get('/v1/images/tasks/a7b5f20c5fa341f78c01f5e559751938', (_req, res) => {
    taskQueries += 1;
    res.json({
      task_id: 'a7b5f20c5fa341f78c01f5e559751938',
      platform: 'sync-task',
      model_name: 'gemini-3.1-flash-lite-image',
      status: 'SUCCESS',
      progress: '100%',
      data: {
        data: [
          {
            url: `${upstreamBase}/output/lite.png`,
            b64_json: '',
            revised_prompt: 'A tiny blue ceramic cup on a plain white table, simple product photo, no text',
          },
        ],
        model: 'gemini-3.1-flash-lite-image',
      },
    });
  });
  upstreamApp.get('/output/lite.png', (_req, res) => {
    outputDownloads += 1;
    res.type('image/png').send(validPng);
  });
  const upstreamServer = await listen(upstreamApp);
  upstreamBase = `http://127.0.0.1:${upstreamServer.address().port}`;
  t.after(() => upstreamServer.close());

  const config = require('../backend/src/config.js');
  const oldConfig = {
    SETTINGS_FILE: config.SETTINGS_FILE,
    OUTPUT_DIR: config.OUTPUT_DIR,
    ZHENZHEN_BASE_URL: config.ZHENZHEN_BASE_URL,
  };
  t.after(() => Object.assign(config, oldConfig));
  config.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  config.OUTPUT_DIR = path.join(tmpDir, 'output');
  config.ZHENZHEN_BASE_URL = upstreamBase;
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify({
    zhenzhenApiKey: '',
    nanoBananaApiKey: 'sk-nano-banana',
  }));

  const proxyRouter = require('../backend/src/routes/proxy.js');
  const safeLookupHosts: string[] = [];
  proxyRouter._test.setProxySafeRemoteTestOptions({
    allowPrivateForTests: (hostname: string) => hostname === '127.0.0.1',
    lookupImpl: async (hostname: string) => {
      safeLookupHosts.push(hostname);
      return [{ address: '127.0.0.1', family: 4 }];
    },
  });
  t.after(() => proxyRouter._test.setProxySafeRemoteTestOptions(null));
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/proxy', proxyRouter);
  const server = await listen(app);
  t.after(() => server.close());

  const base = `http://127.0.0.1:${server.address().port}`;
  const result = await fetch(`${base}/api/proxy/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'nano-banana-2',
      apiModel: 'gemini-3.1-flash-lite-image',
      paramKind: 'banana-ratio',
      prompt: 'A tiny blue ceramic cup on a plain white table, simple product photo, no text',
      aspect_ratio: '1:1',
      image_size: '1K',
    }),
  }).then((res) => res.json());

  assert.equal(result.success, true);
  assert.match(result.data.urls[0], /^\/files\/output\/img_/);
  assert.ok(taskQueries >= 1);
  assert.equal(outputDownloads, 1);
  assert.deepEqual(safeLookupHosts, ['127.0.0.1']);
});
