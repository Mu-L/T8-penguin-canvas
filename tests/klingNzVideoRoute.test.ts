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

test('Kling proxy uses the domestic key and keeps task polling in its own authority scope', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-kling-nz-route-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const config = require('../backend/src/config.js');
  const oldConfig = { SETTINGS_FILE: config.SETTINGS_FILE, OUTPUT_DIR: config.OUTPUT_DIR };
  config.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  config.OUTPUT_DIR = path.join(tmpDir, 'output');
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify({
    zhenzhenApiKey: 'legacy-key-must-not-be-used',
    zhenzhenSd2ApiKey: 'domestic-kling-key',
  }));
  t.after(() => Object.assign(config, oldConfig));

  const seedanceNz = require('../backend/src/providers/seedanceNz.js');
  const originals = {
    submitKlingTask: seedanceNz.submitKlingTask,
    queryTask: seedanceNz.queryTask,
  };
  let submittedRequest: any;
  let submittedKey = '';
  let queriedKey = '';
  seedanceNz.submitKlingTask = async (request: any, apiKey: string) => {
    submittedRequest = request;
    submittedKey = apiKey;
    return { taskId: 'kling-route-task-1', model: request.model, taskType: 't2v' };
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

  const submit = await fetch(`${base}/api/proxy/video/kling/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kling-v3.0-std-t2v',
      prompt: 'A paper bird takes flight under soft studio light',
      duration: 5,
      ratio: '16:9',
    }),
  }).then((response) => response.json());

  assert.equal(submit.success, true);
  assert.equal(submit.data.taskId, 'kling-route-task-1');
  assert.equal(submittedKey, 'domestic-kling-key');
  assert.equal(submittedRequest.model, 'kling-v3.0-std-t2v');

  const status = await fetch(`${base}/api/proxy/video/kling/status/kling-route-task-1`)
    .then((response) => response.json());
  assert.equal(status.success, true);
  assert.equal(status.data.status, 'running');
  assert.equal(status.data.progress, '50');
  assert.equal(queriedKey, 'domestic-kling-key');
  assert.doesNotMatch(JSON.stringify({ submit, status }), /domestic-kling-key|legacy-key-must-not-be-used/);
});
