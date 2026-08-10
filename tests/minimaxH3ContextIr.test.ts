import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Node } from '@xyflow/react';
import { buildRunPreflightDiagnostics } from '../src/utils/runPreflightContext.ts';
import type { ApiSettings } from '../src/types/canvas.ts';

const require = createRequire(import.meta.url);
const provider = require('../backend/src/providers/seedanceNz.js');
const { deriveRunIntentAuthority } = require('../backend/src/collaboration/runIntentAuthority.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const dataUrl = (mime: string, text: string) => `data:${mime};base64,${Buffer.from(text).toString('base64')}`;

test('Context IR models and payload rules exactly match the official/reference contract', async () => {
  assert.deepEqual([...provider.MINMAX_H3_CONTEXT_IR_MODELS], [
    'minmax-h3-context-ir-text',
    'minmax-h3-context-ir-image',
    'minmax-h3-context-ir-multimodal',
  ]);
  assert.deepEqual([...provider.MINMAX_H3_CONTEXT_IR_SECONDS], Array.from({ length: 12 }, (_, index) => String(index + 4)));

  const text = await provider.buildMinimaxH3ContextIrPayload({
    model: 'minmax-h3-context-ir-text',
    prompt: 'camera follows the subject',
    duration: 4,
    ratio: '16:9',
  }, 'test-key');
  assert.deepEqual(text, {
    model: 'minmax-h3-context-ir-text',
    taskType: 'text',
    payload: {
      model: 'minmax-h3-context-ir-text',
      prompt: 'camera follows the subject',
      seconds: '4',
      metadata: { ratio: '16:9' },
    },
  });
  await assert.rejects(
    provider.buildMinimaxH3ContextIrPayload({
      model: 'minmax-h3-context-ir-text', prompt: 'x', seconds: 4, ratio: 'adaptive',
    }, 'test-key'),
    /比例只支持/,
  );

  let uploadIndex = 0;
  const fetchImpl = async (url: string) => {
    assert.match(String(url), /\/v1\/files\/upload$/);
    uploadIndex += 1;
    return new Response(JSON.stringify({ url: `https://cdn.example.test/reference-${uploadIndex}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const image = await provider.buildMinimaxH3ContextIrPayload({
    model: 'minmax-h3-context-ir-image',
    prompt: 'preserve the subject and add motion',
    seconds: '15',
    ratio: '9:16',
    images: [dataUrl('image/png', 'first'), dataUrl('image/png', 'last')],
  }, 'test-key', { fetchImpl, uploadIntervalMs: 0, uploadCacheTtlMs: 0 });
  assert.deepEqual(image.payload, {
    model: 'minmax-h3-context-ir-image',
    prompt: 'preserve the subject and add motion',
    seconds: '15',
    images: ['https://cdn.example.test/reference-1', 'https://cdn.example.test/reference-2'],
  });
  assert.equal('metadata' in image.payload, false, 'Image mode must not send ratio metadata');

  const multimodal = await provider.buildMinimaxH3ContextIrPayload({
    model: 'minmax-h3-context-ir-multimodal',
    prompt: 'combine subject, motion, and rhythm',
    seconds: 8,
    ratio: 'api_default',
    images: [dataUrl('image/png', 'image')],
    videos: [dataUrl('video/mp4', 'video')],
    audios: [dataUrl('audio/wav', 'audio')],
  }, 'test-key', { fetchImpl, uploadIntervalMs: 0, uploadCacheTtlMs: 0 });
  assert.deepEqual(multimodal.payload, {
    model: 'minmax-h3-context-ir-multimodal',
    prompt: 'combine subject, motion, and rhythm',
    seconds: '8',
    images: ['https://cdn.example.test/reference-3'],
    metadata: {
      video_urls: ['https://cdn.example.test/reference-4'],
      audio_url: ['https://cdn.example.test/reference-5'],
    },
  });
});

test('Context IR provider uses the legacy compatibility endpoint and reads result_text', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === 'POST') {
      return new Response(JSON.stringify({ id: 'context-task-1', status: 'queued' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      code: 'success',
      data: { status: 'SUCCESS', progress: '100%', result_text: 'Enhanced official H3 prompt' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const submitted = await provider.submitMinimaxH3ContextIrTask({
    model: 'minmax-h3-context-ir-text', prompt: 'source prompt', seconds: 4, ratio: '16:9',
  }, 'process-only-key', { fetchImpl, baseUrl: 'https://api.seedance.nz' });
  assert.equal(submitted.taskId, 'context-task-1');
  assert.equal(calls[0].url, 'https://api.seedance.nz/v1/video/generations');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    model: 'minmax-h3-context-ir-text',
    prompt: 'source prompt',
    seconds: '4',
    metadata: { ratio: '16:9' },
  });
  const queried = await provider.queryMinimaxH3ContextIrTask(
    submitted.taskId,
    'process-only-key',
    { fetchImpl, baseUrl: 'https://api.seedance.nz' },
  );
  assert.equal(calls[1].url, 'https://api.seedance.nz/v1/video/generations/context-task-1');
  assert.equal(queried.status, 'succeeded');
  assert.equal(queried.resultText, 'Enhanced official H3 prompt');
  assert.doesNotMatch(JSON.stringify({ submitted, queried }), /process-only-key/);
});

test('Canvas node, schema, preflight, authority, and three credential-free workflows are wired', () => {
  const nodeSource = read('src/components/nodes/MinimaxH3OfficialPromptEnhancerNode.tsx');
  const canvasSource = read('src/components/Canvas.tsx');
  const proxySource = read('backend/src/routes/proxy.js');
  const schema = JSON.parse(read('backend/src/shared/canvasNodeSchema.json'));
  assert.match(nodeSource, /submitMinimaxH3ContextIr/);
  assert.match(nodeSource, /queryMinimaxH3ContextIr/);
  assert.match(nodeSource, /最多 9 图 \/ 3 视频 \/ 3 音频/);
  assert.match(nodeSource, /let taskId = String\(d\.taskId \|\| ''\)\.trim\(\)/);
  assert.match(nodeSource, /status: 'success',[\s\S]*taskId: ''/);
  assert.match(nodeSource, /result\.status === 'failed'[\s\S]*update\(\{ taskId: '', progress: '', status: 'error' \}\)/);
  assert.match(canvasSource, /'minimax-h3-official-prompt-enhancer'/);
  assert.match(proxySource, /\/minimax-h3-context-ir\/submit/);
  assert.match(proxySource, /\/minimax-h3-context-ir\/status\/:tid/);
  const entry = schema.types.find((item: any) => item.type === 'minimax-h3-official-prompt-enhancer');
  assert.equal(entry.executable, true);
  assert.equal(entry.generatable, true);
  assert.deepEqual(entry.ports, { inputs: ['text', 'image', 'video', 'audio'], outputs: ['text'] });
  assert.deepEqual(entry.generation.allowedDataFields.model.enum, [
    'minmax-h3-context-ir-text',
    'minmax-h3-context-ir-image',
    'minmax-h3-context-ir-multimodal',
  ]);

  const document = {
    nodes: [{ id: 'official-h3', type: 'minimax-h3-official-prompt-enhancer', position: { x: 0, y: 0 }, data: {} }],
    edges: [],
  };
  assert.deepEqual(deriveRunIntentAuthority(document, ['official-h3']).declarations, [{
    provider: 'seedance-nz', model: 'minmax-h3-context-ir-text', nodeIds: ['official-h3'],
  }]);

  const node = document.nodes[0] as Node;
  const emptySettings: ApiSettings = {
    zhenzhenApiKey: '', zhenzhenBaseUrl: 'https://ai.t8star.org',
    zhenzhenSd2ApiKey: '', zhenzhenSd2BaseUrl: 'https://api.seedance.nz',
    rhApiKey: '', rhBaseUrl: 'https://www.runninghub.cn', rhIntlApiKey: '', rhIntlBaseUrl: 'https://www.runninghub.ai',
    llmApiKey: '', llmBaseUrl: 'https://ai.t8star.org', advancedProviders: [],
  };
  const input = {
    nodes: [node], edges: [], executionNodeIds: [node.id], scopeMode: 'exact-plan' as const,
    projectId: 'official-h3-project', providersComplete: true, assets: [], policy: null,
  };
  const missing = buildRunPreflightDiagnostics({ ...input, settings: emptySettings });
  assert.equal(missing.capability.some((item) => item.ruleId === 'provider.seedance-nz-credential-missing'), true);
  const configured = buildRunPreflightDiagnostics({ ...input, settings: { ...emptySettings, zhenzhenSd2ApiKey: 'configured' } });
  assert.equal(configured.capability.some((item) => item.ruleId === 'provider.seedance-nz-credential-missing'), false);

  for (const model of ['text', 'image', 'multimodal']) {
    const raw = read(`docs/workflows/minmax-h3-context-ir-${model}.json`);
    const workflow = JSON.parse(raw);
    assert.equal(workflow.schema, 't8-workflow-fragment');
    assert.equal(workflow.nodeCount, workflow.nodes.length);
    assert.equal(workflow.edgeCount, workflow.edges.length);
    assert.equal(workflow.nodes.some((item: any) => item.type === 'minimax-h3-official-prompt-enhancer'), true);
    assert.doesNotMatch(raw, /sk-[A-Za-z0-9]/);
  }
});
