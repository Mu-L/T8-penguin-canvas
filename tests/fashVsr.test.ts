import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FASHVSR_VIDEO_UPSCALE_MODEL, VIDEO_MODELS } from '../src/providers/models.ts';

const require = createRequire(import.meta.url);
const provider = require('../backend/src/providers/seedanceNz.js');
const root = join(import.meta.dirname, '..');
const VIDEO = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb20=';

test('FashVSR payload uses the exact model and single metadata.video_url contract', async () => {
  provider.resetCachesForTests();
  const calls: Array<{ url: string; body: unknown }> = [];
  const built = await provider.buildFashVsrPayload({
    model: 'FashVSR_video_upscale',
    videos: [VIDEO],
  }, 'test-key', {
    uploadIntervalMs: 0,
    fashVsrProbe: async () => ({ width: 854, height: 480, duration: 3.2 }),
    fetchImpl: async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body });
      return new Response(JSON.stringify({ url: 'https://cdn.example.com/source.mp4' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  assert.equal(FASHVSR_VIDEO_UPSCALE_MODEL, 'FashVSR_video_upscale');
  assert.deepEqual(built, {
    payload: {
      model: 'FashVSR_video_upscale',
      metadata: { video_url: 'https://cdn.example.com/source.mp4' },
    },
    model: 'FashVSR_video_upscale',
    taskType: 'upscale',
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/files\/upload$/);
});

test('FashVSR rejects missing, multiple, non-480P and out-of-range inputs before submission', async () => {
  await assert.rejects(provider.buildFashVsrPayload({ videos: [] }, 'test-key'), /只能提供 1 个/);
  await assert.rejects(provider.buildFashVsrPayload({ videos: [VIDEO, VIDEO] }, 'test-key'), /只能提供 1 个/);
  const fetchImpl = async () => new Response(JSON.stringify({ url: 'https://cdn.example.com/source.mp4' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  provider.resetCachesForTests();
  await assert.rejects(provider.buildFashVsrPayload({ videos: [VIDEO] }, 'test-key', {
    fetchImpl,
    uploadIntervalMs: 0,
    fashVsrProbe: async () => ({ width: 1280, height: 720, duration: 4 }),
  }), /必须是 480P/);
  provider.resetCachesForTests();
  await assert.rejects(provider.buildFashVsrPayload({ videos: [VIDEO] }, 'test-key', {
    fetchImpl,
    uploadIntervalMs: 0,
    fashVsrProbe: async () => ({ width: 854, height: 480, duration: 15.01 }),
  }), /3-15 秒/);
});

test('FashVSR submits and polls only the documented legacy video endpoint', async () => {
  provider.resetCachesForTests();
  const requests: Array<{ url: string; method: string; body: any }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = String(init?.method || 'GET').toUpperCase();
    requests.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (url.endsWith('/v1/files/upload')) {
      return new Response(JSON.stringify({ url: 'https://cdn.example.com/source.mp4' }), { status: 200 });
    }
    if (url.endsWith('/v1/video/generations') && method === 'POST') {
      return new Response(JSON.stringify({ data: { task_id: 'fash-task-1' } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: {
        status: 'SUCCESS',
        data: { content: { video_url: 'https://cdn.example.com/result.mp4' } },
      },
    }), { status: 200 });
  };
  const submitted = await provider.submitFashVsrTask({ videos: [VIDEO] }, 'test-key', {
    fetchImpl,
    uploadIntervalMs: 0,
    fashVsrProbe: async () => ({ width: 854, height: 480, duration: 3.2 }),
  });
  assert.equal(submitted.taskId, 'fash-task-1');
  const polled = await provider.queryFashVsrTask(submitted.taskId, 'test-key', { fetchImpl });
  assert.equal(polled.status, 'succeeded');
  assert.equal(polled.videoUrl, 'https://cdn.example.com/result.mp4');
  const submit = requests.find((item) => item.method === 'POST' && item.url.endsWith('/v1/video/generations'));
  assert.ok(submit);
  assert.deepEqual(submit.body, {
    model: 'FashVSR_video_upscale',
    metadata: { video_url: 'https://cdn.example.com/source.mp4' },
  });
  assert.equal(requests.at(-1)?.url.endsWith('/v1/video/generations/fash-task-1'), true);
});

test('FashVSR is a standalone canvas node with one video input and a key-free workflow', () => {
  const tab = VIDEO_MODELS.find((item) => item.id === 'fashvsr-video-upscale');
  assert.ok(tab);
  assert.equal(tab.kind, 'upscaler');
  assert.equal(tab.builtinSource, 'seedance-nz');
  assert.deepEqual(tab.apiModelOptions.map((item) => item.value), ['FashVSR_video_upscale']);

  const schema = JSON.parse(readFileSync(join(root, 'backend', 'src', 'shared', 'canvasNodeSchema.json'), 'utf8'));
  assert.deepEqual(schema.connectionPorts['fashvsr-video-upscale'].inputs[0], {
    id: null,
    kinds: ['video'],
    required: true,
    minConnections: 1,
    maxConnections: 1,
  });
  const workflow = JSON.parse(readFileSync(join(root, 'docs', 'workflows', 'fashvsr-video-upscale.json'), 'utf8'));
  assert.equal(workflow.nodes.some((node: any) => node.type === 'fashvsr-video-upscale'), true);
  assert.equal(workflow.edges.length, 1);
  assert.equal(JSON.stringify(workflow).includes('sk-'), false);

  const wrapper = readFileSync(join(root, 'src', 'components', 'nodes', 'FashVsrNode.tsx'), 'utf8');
  const video = readFileSync(join(root, 'src', 'components', 'nodes', 'VideoNode.tsx'), 'utf8');
  const routes = readFileSync(join(root, 'backend', 'src', 'routes', 'proxy.js'), 'utf8');
  assert.match(wrapper, /fashVsrVariant: true/);
  assert.match(video, /submitFashVsr/);
  assert.match(video, /queryFashVsr/);
  assert.match(routes, /\/video\/fashvsr\/submit/);
  assert.match(routes, /\/video\/fashvsr\/status\/:tid/);
});
