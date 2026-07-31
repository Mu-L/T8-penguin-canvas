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

test('Hailuo proxy uses the domestic key and keeps task polling in its own authority scope', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-hailuo-nz-route-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const config = require('../backend/src/config.js');
  const oldConfig = { SETTINGS_FILE: config.SETTINGS_FILE, OUTPUT_DIR: config.OUTPUT_DIR };
  config.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  config.OUTPUT_DIR = path.join(tmpDir, 'output');
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify({
    zhenzhenApiKey: 'legacy-key-must-not-be-used',
    zhenzhenSd2ApiKey: 'domestic-hailuo-key',
  }));
  t.after(() => Object.assign(config, oldConfig));

  const seedanceNz = require('../backend/src/providers/seedanceNz.js');
  const originals = {
    submitHailuoTask: seedanceNz.submitHailuoTask,
    queryTask: seedanceNz.queryTask,
  };
  let submittedRequest: any;
  let submittedKey = '';
  let queriedKey = '';
  seedanceNz.submitHailuoTask = async (request: any, apiKey: string) => {
    submittedRequest = request;
    submittedKey = apiKey;
    return { taskId: 'hailuo-route-task-1', model: request.model, taskType: 'multi' };
  };
  seedanceNz.queryTask = async (_taskId: string, apiKey: string) => {
    queriedKey = apiKey;
    return { status: 'running', progress: 50, videoUrl: null, failReason: null };
  };
  t.after(() => Object.assign(seedanceNz, originals));

  const proxyRouter = require('../backend/src/routes/proxy.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/proxy', proxyRouter);
  const server = await listen(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const submit = await fetch(`${base}/api/proxy/video/hailuo/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'hailuo-h3-multi',
      prompt: '@Image 1 follows @Video 1 and @Audio 1',
      duration: 5,
      resolution: '2K',
      ratio: '16:9',
      images: ['/files/input/hailuo-h3-reference.png'],
      videos: ['/files/input/hailuo-h3-reference.mp4'],
      audios: ['/files/input/hailuo-h3-reference.wav'],
    }),
  }).then((response) => response.json());

  assert.equal(submit.success, true);
  assert.equal(submit.data.taskId, 'hailuo-route-task-1');
  assert.equal(submittedKey, 'domestic-hailuo-key');
  assert.equal(submittedRequest.model, 'hailuo-h3-multi');
  assert.deepEqual(submittedRequest.images, ['/files/input/hailuo-h3-reference.png']);
  assert.deepEqual(submittedRequest.videos, ['/files/input/hailuo-h3-reference.mp4']);
  assert.deepEqual(submittedRequest.audios, ['/files/input/hailuo-h3-reference.wav']);

  const status = await fetch(`${base}/api/proxy/video/hailuo/status/hailuo-route-task-1`)
    .then((response) => response.json());
  assert.equal(status.success, true);
  assert.equal(status.data.status, 'running');
  assert.equal(status.data.progress, '50');
  assert.equal(queriedKey, 'domestic-hailuo-key');
  assert.doesNotMatch(JSON.stringify({ submit, status }), /domestic-hailuo-key|legacy-key-must-not-be-used/);
});
