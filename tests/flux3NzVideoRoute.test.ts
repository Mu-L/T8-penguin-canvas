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

test('FLUX 3 proxy uses only the budget provider key and returns draft cache on polling', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-flux3-nz-route-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const config = require('../backend/src/config.js');
  const oldConfig = { SETTINGS_FILE: config.SETTINGS_FILE, OUTPUT_DIR: config.OUTPUT_DIR };
  config.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  config.OUTPUT_DIR = path.join(tmpDir, 'output');
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify({
    zhenzhenApiKey: 'legacy-key-must-not-be-used',
    zhenzhenSd2ApiKey: 'budget-flux3-key',
  }));
  t.after(() => Object.assign(config, oldConfig));

  const seedanceNz = require('../backend/src/providers/seedanceNz.js');
  const originals = { submitFlux3Task: seedanceNz.submitFlux3Task, queryTask: seedanceNz.queryTask };
  let submittedKey = '';
  let queriedKey = '';
  seedanceNz.submitFlux3Task = async (request: any, apiKey: string) => {
    submittedKey = apiKey;
    return { taskId: 'flux3-route-task-1', model: request.model, taskType: 't2v' };
  };
  seedanceNz.queryTask = async (_taskId: string, apiKey: string) => {
    queriedKey = apiKey;
    return { status: 'running', progress: 50, videoUrl: null, draftCache: 'opaque-cache', failReason: null };
  };
  t.after(() => Object.assign(seedanceNz, originals));

  const proxyRouter = require('../backend/src/routes/proxy.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/proxy', proxyRouter);
  const server = await listen(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const submit = await fetch(`${base}/api/proxy/video/flux3/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'flux-3-video-t2v', prompt: 'camera move', duration: 5, resolution: 'hd', ratio: 'auto' }),
  }).then((response) => response.json());
  assert.equal(submit.success, true);
  assert.equal(submit.data.taskId, 'flux3-route-task-1');
  assert.equal(submittedKey, 'budget-flux3-key');

  const status = await fetch(`${base}/api/proxy/video/flux3/status/flux3-route-task-1`).then((response) => response.json());
  assert.equal(status.success, true);
  assert.equal(status.data.status, 'running');
  assert.equal(status.data.draftCache, 'opaque-cache');
  assert.equal(queriedKey, 'budget-flux3-key');
  assert.doesNotMatch(JSON.stringify({ submit, status }), /budget-flux3-key|legacy-key-must-not-be-used/);
});
