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

test('Upscaler proxy uses the domestic key and keeps task polling in its own authority scope', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-upscaler-nz-route-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const config = require('../backend/src/config.js');
  const oldConfig = { SETTINGS_FILE: config.SETTINGS_FILE, OUTPUT_DIR: config.OUTPUT_DIR };
  config.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  config.OUTPUT_DIR = path.join(tmpDir, 'output');
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify({
    zhenzhenApiKey: 'legacy-key-must-not-be-used',
    zhenzhenSd2ApiKey: 'domestic-upscaler-key',
  }));
  t.after(() => Object.assign(config, oldConfig));

  const seedanceNz = require('../backend/src/providers/seedanceNz.js');
  const originals = {
    submitUpscalerTask: seedanceNz.submitUpscalerTask,
    queryTask: seedanceNz.queryTask,
  };
  let submittedRequest: any;
  let submittedKey = '';
  let queriedKey = '';
  seedanceNz.submitUpscalerTask = async (request: any, apiKey: string) => {
    submittedRequest = request;
    submittedKey = apiKey;
    return { taskId: 'upscaler-route-task-1', model: request.model, taskType: 'upscale' };
  };
  seedanceNz.queryTask = async (_taskId: string, apiKey: string) => {
    queriedKey = apiKey;
    return { status: 'running', progress: 35, videoUrl: null, failReason: null };
  };
  t.after(() => Object.assign(seedanceNz, originals));

  const proxyRouter = require('../backend/src/routes/proxy.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/proxy', proxyRouter);
  const server = await listen(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const submit = await fetch(`${base}/api/proxy/video/upscaler/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'zhenzhen-upscaler',
      resolution: '1080p',
      videos: ['/files/source.mp4'],
    }),
  }).then((response) => response.json());

  assert.equal(submit.success, true);
  assert.equal(submit.data.taskId, 'upscaler-route-task-1');
  assert.equal(submittedKey, 'domestic-upscaler-key');
  assert.equal(submittedRequest.model, 'zhenzhen-upscaler');

  const status = await fetch(`${base}/api/proxy/video/upscaler/status/upscaler-route-task-1`)
    .then((response) => response.json());
  assert.equal(status.success, true);
  assert.equal(status.data.status, 'running');
  assert.equal(status.data.progress, '35');
  assert.equal(queriedKey, 'domestic-upscaler-key');
  assert.doesNotMatch(JSON.stringify({ submit, status }), /domestic-upscaler-key|legacy-key-must-not-be-used/);
});
