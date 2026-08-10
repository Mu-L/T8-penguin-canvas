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

test('MiniMax H3 Context IR proxy uses only the budget key and returns result_text safely', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-context-ir-route-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const config = require('../backend/src/config.js');
  const oldConfig = { SETTINGS_FILE: config.SETTINGS_FILE, OUTPUT_DIR: config.OUTPUT_DIR };
  config.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  config.OUTPUT_DIR = path.join(tmpDir, 'output');
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify({
    zhenzhenApiKey: 'legacy-key-must-not-be-used',
    zhenzhenSd2ApiKey: 'budget-context-ir-key',
  }));
  t.after(() => Object.assign(config, oldConfig));

  const seedanceNz = require('../backend/src/providers/seedanceNz.js');
  const originals = {
    submitMinimaxH3ContextIrTask: seedanceNz.submitMinimaxH3ContextIrTask,
    queryMinimaxH3ContextIrTask: seedanceNz.queryMinimaxH3ContextIrTask,
  };
  let submittedRequest: any;
  let submittedKey = '';
  let queriedKey = '';
  seedanceNz.submitMinimaxH3ContextIrTask = async (request: any, apiKey: string) => {
    submittedRequest = request;
    submittedKey = apiKey;
    return { taskId: 'context-ir-route-task-1', model: request.model, taskType: 'multimodal' };
  };
  seedanceNz.queryMinimaxH3ContextIrTask = async (_taskId: string, apiKey: string) => {
    queriedKey = apiKey;
    return { status: 'succeeded', progress: '100', resultText: '增强后的提示词', failReason: '' };
  };
  t.after(() => Object.assign(seedanceNz, originals));

  const proxyRouter = require('../backend/src/routes/proxy.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/proxy', proxyRouter);
  const server = await listen(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const submit = await fetch(`${base}/api/proxy/minimax-h3-context-ir/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'minmax-h3-context-ir-multimodal',
      prompt: 'combine references',
      duration: 4,
      ratio: 'adaptive',
      images: ['/files/input/reference.png'],
    }),
  }).then((response) => response.json());

  assert.equal(submit.success, true);
  assert.equal(submit.data.taskId, 'context-ir-route-task-1');
  assert.equal(submit.data.taskProvider, 'seedance-nz');
  assert.equal(submit.data.model, 'minmax-h3-context-ir-multimodal');
  assert.equal(submit.data.taskType, 'multimodal');
  assert.equal(submittedKey, 'budget-context-ir-key');
  assert.deepEqual(submittedRequest.images, ['/files/input/reference.png']);

  const status = await fetch(`${base}/api/proxy/minimax-h3-context-ir/status/context-ir-route-task-1`)
    .then((response) => response.json());
  assert.equal(status.success, true);
  assert.equal(status.data.status, 'succeeded');
  assert.equal(status.data.progress, '100');
  assert.equal(status.data.resultText, '增强后的提示词');
  assert.equal(status.data.model, 'minmax-h3-context-ir-multimodal');
  assert.equal(status.data.taskType, 'multimodal');
  assert.equal(queriedKey, 'budget-context-ir-key');
  assert.doesNotMatch(JSON.stringify({ submit, status }), /budget-context-ir-key|legacy-key-must-not-be-used/);
});
