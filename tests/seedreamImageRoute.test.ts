import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

async function listen(app: any) {
  return new Promise<any>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('Seedream uses one synchronous JSON endpoint for text-to-image and image editing', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-seedream-image-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const upstreamCalls: any[] = [];
  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: '4mb' }));
  upstreamApp.post('/v1/images/generations', (req, res) => {
    upstreamCalls.push({
      path: req.path,
      query: req.query,
      body: req.body,
      auth: req.header('authorization'),
    });
    res.json({
      data: [{ b64_json: Buffer.from(`SEEDREAM-${upstreamCalls.length}`).toString('base64') }],
    });
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
  fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify({ zhenzhenApiKey: 'sk-seedream-test' }));

  const proxyRouter = require('../backend/src/routes/proxy.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/proxy', proxyRouter);
  const server = await listen(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const textToImage = await fetch(`${base}/api/proxy/image/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'seedream-v5-pro',
      apiModel: 'seedream-v5-pro',
      paramKind: 'seedream-v5',
      prompt: 'blue ceramic cup',
      size: '1024x1024',
      response_format: 'url',
      output_format: 'png',
    }),
  }).then((res) => res.json());

  assert.equal(textToImage.success, true);
  assert.equal(textToImage.data.sync, true);
  assert.match(textToImage.data.urls[0], /^\/files\/output\/img_/);
  assert.equal(upstreamCalls[0].path, '/v1/images/generations');
  assert.deepEqual(upstreamCalls[0].query, {});
  assert.equal(upstreamCalls[0].auth, 'Bearer sk-seedream-test');
  assert.deepEqual(upstreamCalls[0].body, {
    model: 'seedream-v5-pro',
    prompt: 'blue ceramic cup',
    size: '1024x1024',
    response_format: 'url',
    output_format: 'png',
  });

  const reference = `data:image/png;base64,${Buffer.from('REFERENCE').toString('base64')}`;
  const imageEdit = await fetch(`${base}/api/proxy/image/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'seedream-v5-pro',
      apiModel: 'seedream-v5-pro',
      paramKind: 'seedream-v5',
      prompt: 'make the cup red',
      size: '1280x960',
      response_format: 'url',
      output_format: 'jpeg',
      images: [reference],
    }),
  }).then((res) => res.json());

  assert.equal(imageEdit.success, true);
  assert.equal(imageEdit.data.sync, true);
  assert.equal(upstreamCalls[1].path, '/v1/images/generations');
  assert.deepEqual(upstreamCalls[1].query, {});
  assert.deepEqual(upstreamCalls[1].body, {
    model: 'seedream-v5-pro',
    prompt: 'make the cup red',
    size: '1280x960',
    response_format: 'url',
    output_format: 'jpeg',
    image: [reference],
  });

  const invalidSize = await fetch(`${base}/api/proxy/image/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'seedream-v5-pro',
      apiModel: 'seedream-v5-pro',
      paramKind: 'seedream-v5',
      prompt: 'invalid custom size',
      size: 'wide',
    }),
  }).then((res) => res.json());

  assert.equal(invalidSize.success, false);
  assert.match(invalidSize.error, /Seedream 尺寸格式无效/);
  assert.equal(upstreamCalls.length, 2);
});
