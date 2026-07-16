import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

async function listen(app: any) {
  return new Promise<any>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('external provider generation routes run enabled OpenAI compatible LLM and image calls', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-external-generation-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: '4mb' }));
  const upload = multer();
  const upstreamCalls: any[] = [];
  upstreamApp.post('/v1/chat/completions', (req, res) => {
    upstreamCalls.push({ path: req.path, body: req.body, auth: req.header('authorization') });
    res.set('x-request-id', 'req-route-chat');
    res.json({ choices: [{ message: { content: 'external hello' } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
  });
  upstreamApp.post('/v1/images/generations', (req, res) => {
    upstreamCalls.push({ path: req.path, body: req.body, auth: req.header('authorization') });
    res.json({ data: [{ b64_json: Buffer.from('PNGDATA').toString('base64'), mime_type: 'image/png' }] });
  });
  upstreamApp.post('/v1/images/edits', upload.any(), (req, res) => {
    upstreamCalls.push({
      path: req.path,
      body: req.body,
      files: req.files,
      auth: req.header('authorization'),
      contentType: req.header('content-type'),
    });
    res.json({ data: [{ b64_json: Buffer.from('EDITPNG').toString('base64'), mime_type: 'image/png' }] });
  });
  upstreamApp.post('/v1/videos/generations', (req, res) => {
    upstreamCalls.push({ path: req.path, body: req.body, auth: req.header('authorization') });
    res.json({ data: { video_url: 'data:video/mp4;base64,TVA0REFUQQ==', task_id: 'video-route-1' } });
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
  const externalProvidersRouter = require('../backend/src/routes/externalProviders.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/settings', settingsRouter);
  app.use('/api/proxy/external', externalProvidersRouter);
  const server = await listen(app);
  t.after(() => server.close());

  const base = `http://127.0.0.1:${server.address().port}`;
  const upstreamBase = `http://127.0.0.1:${upstreamServer.address().port}/v1`;
  await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      advancedProviders: [
        {
          id: 'openai-compatible',
          protocol: 'openai-compatible',
          enabled: true,
          baseUrl: upstreamBase,
          apiKey: 'sk-route-secret',
          imageModels: ['gpt-image-test'],
          videoModels: ['video-test'],
          chatModels: ['gpt-chat-test'],
        },
      ],
    }),
  }).then((res) => res.json());

  const llm = await fetch(`${base}/api/proxy/external/llm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'openai-compatible', prompt: 'hello route' }),
  }).then((res) => res.json());

  assert.equal(llm.success, true);
  assert.equal(llm.data.text, 'external hello');
  assert.equal(llm.data.requestId, 'req-route-chat');
  assert.equal(llm.data.upstreamHttpStatus, 200);
  assert.equal(llm.data.pollCount, 0);
  assert.deepEqual(llm.data.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
  assert.equal(JSON.stringify(llm).includes('sk-route-secret'), false);

  const image = await fetch(`${base}/api/proxy/external/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'openai-compatible', prompt: 'draw route', size: '512x512' }),
  }).then((res) => res.json());

  assert.equal(image.success, true);
  assert.equal(image.data.imageUrls.length, 1);
  assert.match(image.data.imageUrls[0], /^\/files\/output\/external_/);
  assert.equal(fs.existsSync(path.join(config.OUTPUT_DIR, path.basename(image.data.imageUrls[0]))), true);

  const imageEdit = await fetch(`${base}/api/proxy/external/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: 'openai-compatible',
      prompt: 'edit route',
      size: '512x512',
      referenceImages: ['data:image/png;base64,QUJD'],
    }),
  }).then((res) => res.json());

  assert.equal(imageEdit.success, true);
  assert.equal(imageEdit.data.imageUrls.length, 1);
  assert.match(imageEdit.data.imageUrls[0], /^\/files\/output\/external_/);
  assert.equal(fs.existsSync(path.join(config.OUTPUT_DIR, path.basename(imageEdit.data.imageUrls[0]))), true);

  const video = await fetch(`${base}/api/proxy/external/video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: 'openai-compatible',
      model: 'video-test',
      prompt: 'video route',
      aspect_ratio: '16:9',
      duration: 6,
    }),
  }).then((res) => res.json());

  assert.equal(video.success, true);
  assert.equal(video.data.taskId, 'video-route-1');
  assert.equal(video.data.videoUrls.length, 1);
  assert.match(video.data.videoUrls[0], /^\/files\/output\/external_/);
  assert.equal(fs.existsSync(path.join(config.OUTPUT_DIR, path.basename(video.data.videoUrls[0]))), true);
  assert.equal(upstreamCalls[0].auth, 'Bearer sk-route-secret');
  assert.equal(upstreamCalls[1].auth, 'Bearer sk-route-secret');
  assert.equal(upstreamCalls[2].path, '/v1/images/edits');
  assert.match(upstreamCalls[2].contentType, /^multipart\/form-data; boundary=/);
  assert.equal(upstreamCalls[2].auth, 'Bearer sk-route-secret');
  assert.equal(upstreamCalls[2].body.model, 'gpt-image-test');
  assert.equal(upstreamCalls[2].body.prompt, 'edit route');
  assert.equal(upstreamCalls[2].body.size, '512x512');
  assert.equal(upstreamCalls[2].files.length, 1);
  assert.equal(upstreamCalls[3].auth, 'Bearer sk-route-secret');
});

test('external Agnes image route sends image edit aliases through generations JSON', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-external-agnes-image-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: '8mb' }));
  const upstreamCalls: any[] = [];
  upstreamApp.post('/v1/images/generations', (req, res) => {
    upstreamCalls.push({ path: req.path, body: req.body, auth: req.header('authorization') });
    res.json({ data: [{ b64_json: Buffer.from('AGNES_EDIT').toString('base64'), mime_type: 'image/png' }] });
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
  const externalProvidersRouter = require('../backend/src/routes/externalProviders.js');
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/settings', settingsRouter);
  app.use('/api/proxy/external', externalProvidersRouter);
  const server = await listen(app);
  t.after(() => server.close());

  const base = `http://127.0.0.1:${server.address().port}`;
  const upstreamBase = `http://127.0.0.1:${upstreamServer.address().port}/v1`;
  await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      advancedProviders: [
        {
          id: 'agnes',
          protocol: 'agnes',
          enabled: true,
          baseUrl: upstreamBase,
          apiKey: 'sk-agnes-route-secret',
          imageModels: ['agnes-image-2.1-flash'],
          videoModels: ['agnes-video-v2.0'],
          chatModels: ['agnes-2.0-flash'],
        },
      ],
    }),
  }).then((res) => res.json());

  const imageEdit = await fetch(`${base}/api/proxy/external/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: 'agnes',
      providerModel: 'agnes-image-2.1-flash',
      model: 'agnes-image-2.1-flash',
      prompt: 'edit route with agnes',
      size: '1024x1024',
      imageUrls: ['data:image/png;base64,QUJD'],
      response_format: 'url',
    }),
  }).then((res) => res.json());

  assert.equal(imageEdit.success, true);
  assert.equal(imageEdit.data.imageUrls.length, 1);
  assert.match(imageEdit.data.imageUrls[0], /^\/files\/output\/external_/);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].path, '/v1/images/generations');
  assert.equal(upstreamCalls[0].auth, 'Bearer sk-agnes-route-secret');
  assert.deepEqual(upstreamCalls[0].body, {
    model: 'agnes-image-2.1-flash',
    prompt: 'edit route with agnes',
    size: '1024x1024',
    extra_body: {
      image: ['data:image/png;base64,QUJD'],
      response_format: 'url',
    },
  });
});

test('ComfyUI external image route persists mixed image video and audio outputs', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-comfyui-mixed-route-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: '2mb' }));
  upstreamApp.post('/prompt', (_req, res) => res.json({ prompt_id: 'mixed-route-1' }));
  upstreamApp.get('/history/mixed-route-1', (_req, res) => res.json({
    'mixed-route-1': {
      status: { status_str: 'success' },
      outputs: {
        '10': { images: [{ filename: 'mixed.png', type: 'output' }] },
        '11': { videos: [{ filename: 'mixed.mp4', type: 'output' }] },
        '12': { audio: [{ filename: 'mixed.wav', type: 'output' }] },
        '13': { text: 'mixed caption' },
      },
    },
  }));
  upstreamApp.get('/view', (req, res) => {
    const filename = String(req.query.filename || '');
    if (filename.endsWith('.mp4')) return res.type('video/mp4').send(Buffer.from('MP4DATA'));
    if (filename.endsWith('.wav')) return res.type('audio/wav').send(Buffer.from('WAVDATA'));
    return res.type('image/png').send(Buffer.from('PNGDATA'));
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
  const externalProvidersRouter = require('../backend/src/routes/externalProviders.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/settings', settingsRouter);
  app.use('/api/proxy/external', externalProvidersRouter);
  const server = await listen(app);
  t.after(() => server.close());

  const base = `http://127.0.0.1:${server.address().port}`;
  const comfyBase = `http://127.0.0.1:${upstreamServer.address().port}`;
  await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      advancedProviders: [{
        id: 'comfyui-mixed',
        protocol: 'comfyui',
        enabled: true,
        baseUrl: comfyBase,
        comfyuiConfig: {
          instances: [comfyBase],
          workflows: [{
            id: 'mixed-workflow',
            name: 'Mixed workflow',
            workflowJson: { '1': { class_type: 'T8Fixture', inputs: { value: 1 } } },
          }],
        },
      }],
    }),
  }).then((res) => res.json());

  const result = await fetch(`${base}/api/proxy/external/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'comfyui-mixed', providerModel: 'mixed-workflow' }),
  }).then((res) => res.json());

  assert.equal(result.success, true);
  assert.deepEqual(result.data.outputKinds, ['image', 'video', 'audio', 'text']);
  assert.equal(result.data.primaryKind, 'image');
  assert.equal(result.data.text, 'mixed caption');
  assert.equal(result.data.imageUrls.length, 1);
  assert.equal(result.data.videoUrls.length, 1);
  assert.equal(result.data.audioUrls.length, 1);
  assert.equal(result.data.outputSaveErrors.length, 0);
  for (const url of [...result.data.imageUrls, ...result.data.videoUrls, ...result.data.audioUrls]) {
    assert.match(url, /^\/files\/output\/external_/);
    assert.equal(fs.existsSync(path.join(config.OUTPUT_DIR, path.basename(url))), true);
  }
  assert.match(result.data.remoteImageUrls[0], new RegExp(`^${comfyBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/view`));
  assert.match(result.data.remoteVideoUrls[0], /filename=mixed\.mp4/);
  assert.match(result.data.remoteAudioUrls[0], /filename=mixed\.wav/);
});
