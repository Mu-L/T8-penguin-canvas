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

test('Seedream NZ proxy uses the independent SD2 key and stores completed output locally', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-seedream-nz-route-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const config = require('../backend/src/config.js');
  const oldConfig = { SETTINGS_FILE: config.SETTINGS_FILE, OUTPUT_DIR: config.OUTPUT_DIR };
  config.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  config.OUTPUT_DIR = path.join(tmpDir, 'output');
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify({
    zhenzhenApiKey: 'legacy-key-must-not-be-used',
    zhenzhenSd2ApiKey: 'sd2-image-key',
  }));
  t.after(() => Object.assign(config, oldConfig));

  const seedanceNz = require('../backend/src/providers/seedanceNz.js');
  const originals = {
    submitImageTask: seedanceNz.submitImageTask,
    queryImageTask: seedanceNz.queryImageTask,
    fetchRemote: seedanceNz.fetchRemote,
  };
  let submittedRequest: any;
  let submittedKey = '';
  seedanceNz.submitImageTask = async (request: any, apiKey: string) => {
    submittedRequest = request;
    submittedKey = apiKey;
    return {
      taskId: 'seedream-nz-task-1',
      model: request.images?.length ? 'seedream-v5-pro-i2i' : 'seedream-v5-pro-t2i',
      taskType: request.images?.length ? 'i2i' : 't2i',
      raw: { status: 'queued' },
    };
  };
  seedanceNz.queryImageTask = async () => ({
    status: 'succeeded',
    progress: '100%',
    imageUrl: 'https://cdn.example.com/seedream-result.png',
    raw: { data: { status: 'SUCCESS' } },
  });
  seedanceNz.fetchRemote = async () => new Response(Buffer.from('PNG-RESULT'), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });
  t.after(() => Object.assign(seedanceNz, originals));

  const proxyRouter = require('../backend/src/routes/proxy.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/proxy', proxyRouter);
  const server = await listen(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const submit = await fetch(`${base}/api/proxy/image/seedance-nz/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'change the reference image colors',
      images: ['/files/input/reference.png'],
      resolution: '1k',
      output_format: 'png',
    }),
  }).then((response) => response.json());

  assert.equal(submit.success, true);
  assert.equal(submit.data.taskId, 'seedream-nz-task-1');
  assert.equal(submit.data.taskProvider, 'seedance-nz-image');
  assert.equal(submittedKey, 'sd2-image-key');
  assert.deepEqual(submittedRequest.images, ['/files/input/reference.png']);

  const status = await fetch(`${base}/api/proxy/image/seedance-nz/status/seedream-nz-task-1`)
    .then((response) => response.json());
  assert.equal(status.success, true);
  assert.equal(status.data.status, 'completed');
  assert.match(status.data.urls[0], /^\/files\/output\/img_/);
  assert.equal(status.data.remoteUrls[0], 'https://cdn.example.com/seedream-result.png');
  assert.equal(fs.readdirSync(config.OUTPUT_DIR).length, 1);
});
