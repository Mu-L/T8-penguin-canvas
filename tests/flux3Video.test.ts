import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FLUX3_VIDEO_DURATIONS,
  FLUX3_VIDEO_MODELS,
  FLUX3_VIDEO_RATIOS,
  FLUX3_VIDEO_RESOLUTIONS,
  HAILUO_H3_GLOBAL_VIDEO_MODELS,
  VIDEO_MODELS,
  videoModelOptionsForSource,
} from '../src/providers/models.ts';

const require = createRequire(import.meta.url);
const provider = require('../backend/src/providers/seedanceNz.js');
const root = join(import.meta.dirname, '..');
const source = (name: string) => readFileSync(join(root, name), 'utf8');
const workflow = (model: string) => JSON.parse(source(`docs/workflows/${model}.json`));
const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';
const VIDEO = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb20=';

const uploadFetch = async (_url: string, init?: RequestInit) => {
  const file = (init?.body as FormData).get('file') as File;
  return new Response(JSON.stringify({ url: `https://cdn.example.com/${file.type.startsWith('image/') ? 'frame.png' : 'source.mp4'}` }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

test('Video catalog exposes the exact official Hailuo H3 global and FLUX 3 models', () => {
  assert.deepEqual(HAILUO_H3_GLOBAL_VIDEO_MODELS, [
    'hailuo-h3-global-t2v',
    'hailuo-h3-global-i2v',
    'hailuo-h3-global-multi',
  ]);
  assert.deepEqual(FLUX3_VIDEO_MODELS, [
    'flux-3-video-t2v',
    'flux-3-video-i2v',
    'flux-3-video-v2v',
    'flux-3-video-draft-enhance',
    'flux-3-video-global-t2v',
    'flux-3-video-global-i2v',
    'flux-3-video-global-v2v',
    'flux-3-video-global-draft-enhance',
  ]);
  assert.deepEqual(FLUX3_VIDEO_DURATIONS, Array.from({ length: 16 }, (_, index) => index + 5));
  assert.deepEqual(FLUX3_VIDEO_RESOLUTIONS, ['hd', 'fhd']);
  assert.deepEqual(FLUX3_VIDEO_RATIOS, ['auto', '21:9', '2:1', '16:9', '4:3', '1:1', '3:4', '9:16']);

  const hailuo = VIDEO_MODELS.find((item) => item.id === 'hailuo-2.3');
  const flux3 = VIDEO_MODELS.find((item) => item.id === 'flux-3-video');
  assert.ok(hailuo);
  assert.ok(flux3);
  assert.equal(flux3.label, 'Flux3');
  assert.equal(flux3.kind, 'flux3');
  assert.deepEqual(videoModelOptionsForSource(flux3, 'seedance-nz').map((item) => item.value), FLUX3_VIDEO_MODELS);
  for (const model of HAILUO_H3_GLOBAL_VIDEO_MODELS) {
    const option = videoModelOptionsForSource(hailuo, 'seedance-nz').find((item) => item.value === model);
    assert.ok(option, model);
    assert.deepEqual(option.resolutions, ['768P', '2K']);
  }
});

test('Hailuo H3 global payloads preserve the official mode split and 768P option', async () => {
  provider.resetCachesForTests();
  const t2v = await provider.buildHailuoPayload({
    model: 'hailuo-h3-global-t2v', prompt: 'camera move', duration: 5, resolution: '768P', ratio: '16:9',
  }, 'opaque-test-key', { fetchImpl: uploadFetch, uploadIntervalMs: 0 });
  assert.equal(t2v.taskType, 't2v');
  assert.deepEqual(t2v.payload, {
    model: 'hailuo-h3-global-t2v', seconds: '5', prompt: 'camera move', metadata: { resolution: '768P', ratio: '16:9' },
  });

  const i2v = await provider.buildHailuoPayload({
    model: 'hailuo-h3-global-i2v', duration: 6, resolution: '2K', images: [IMAGE],
  }, 'opaque-test-key', { fetchImpl: uploadFetch, uploadIntervalMs: 0 });
  assert.equal(i2v.taskType, 'i2v');
  assert.deepEqual(i2v.payload.images, ['https://cdn.example.com/frame.png']);

  const multi = await provider.buildHailuoPayload({
    model: 'hailuo-h3-global-multi', prompt: '@Image 1', duration: 7, resolution: '768P', images: [IMAGE], ratio: 'adaptive',
  }, 'opaque-test-key', { fetchImpl: uploadFetch, uploadIntervalMs: 0 });
  assert.equal(multi.taskType, 'multi');
  assert.equal(multi.payload.metadata.resolution, '768P');
  assert.deepEqual(multi.payload.images, ['https://cdn.example.com/frame.png']);
});

test('FLUX 3 payload builder follows T2V/I2V/V2V/Draft Enhance contracts exactly', async () => {
  provider.resetCachesForTests();
  const t2v = await provider.buildFlux3Payload({
    model: 'flux-3-video-t2v', prompt: 'paper sculpture rotates', duration: 5, resolution: 'hd', ratio: 'auto',
    draft: true, audioMode: 'disabled', safetyTolerance: 0,
  }, 'opaque-test-key', { fetchImpl: uploadFetch, uploadIntervalMs: 0 });
  assert.equal(t2v.taskType, 't2v');
  assert.deepEqual(t2v.payload, {
    model: 'flux-3-video-t2v', seconds: '5', prompt: 'paper sculpture rotates',
    metadata: { resolution: 'hd', ratio: 'auto', draft: true, generate_audio: false, safety_tolerance: 0 },
  });

  const i2v = await provider.buildFlux3Payload({
    model: 'flux-3-video-global-i2v', prompt: 'slow push in', duration: 6, resolution: 'fhd', ratio: '16:9', images: [IMAGE, IMAGE],
  }, 'opaque-test-key', { fetchImpl: uploadFetch, uploadIntervalMs: 0 });
  assert.equal(i2v.taskType, 'i2v');
  assert.equal(i2v.payload.images.length, 2);
  assert.equal(i2v.payload.metadata.video_url, undefined);

  const v2v = await provider.buildFlux3Payload({
    model: 'flux-3-video-v2v', prompt: 'replace the background', duration: 7, resolution: 'hd', ratio: '9:16', videos: [VIDEO],
  }, 'opaque-test-key', { fetchImpl: uploadFetch, uploadIntervalMs: 0 });
  assert.equal(v2v.taskType, 'v2v');
  assert.equal(v2v.payload.metadata.video_url, 'https://cdn.example.com/source.mp4');
  assert.equal(v2v.payload.images, undefined);

  const enhance = await provider.buildFlux3Payload({
    model: 'flux-3-video-global-draft-enhance', duration: 8, resolution: 'fhd', ratio: '21:9', draftCache: 'opaque-cache',
  }, 'opaque-test-key', { fetchImpl: uploadFetch, uploadIntervalMs: 0 });
  assert.equal(enhance.taskType, 'draft-enhance');
  assert.equal(enhance.payload.prompt, undefined);
  assert.equal(enhance.payload.metadata.draft_cache, 'opaque-cache');
});

test('FLUX 3 validation fails closed before paid submission', async () => {
  await assert.rejects(() => provider.buildFlux3Payload({
    model: 'flux-3-video-i2v', prompt: 'x', duration: 5, resolution: 'hd', ratio: 'auto',
  }, 'opaque-test-key', { fetchImpl: uploadFetch }), /1-10 张关键帧/);
  await assert.rejects(() => provider.buildFlux3Payload({
    model: 'flux-3-video-v2v', prompt: 'x', duration: 5, resolution: 'hd', ratio: 'auto', videos: [VIDEO, VIDEO],
  }, 'opaque-test-key', { fetchImpl: uploadFetch }), /只能提供 1 个 MP4/);
  await assert.rejects(() => provider.buildFlux3Payload({
    model: 'flux-3-video-draft-enhance', duration: 5, resolution: 'hd', ratio: 'auto',
  }, 'opaque-test-key', { fetchImpl: uploadFetch }), /必须提供 draft_cache/);
  await assert.rejects(() => provider.buildFlux3Payload({
    model: 'flux-3-video-t2v', prompt: 'x', duration: 4, resolution: 'hd', ratio: 'auto',
  }, 'opaque-test-key', { fetchImpl: uploadFetch }), /5-20 秒/);
});

test('FLUX 3 submission uses the documented video endpoint and keeps authorization opaque', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const result = await provider.submitFlux3Task({
    model: 'flux-3-video-global-t2v', prompt: 'cinematic product turntable', duration: 5, resolution: 'hd', ratio: '16:9',
  }, 'opaque-test-key', {
    fetchImpl: async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ id: 'task-safe' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  assert.equal(capturedUrl, 'https://api.seedance.nz/v1/videos');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal((capturedInit?.headers as Record<string, string>).Authorization, 'Bearer opaque-test-key');
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    model: 'flux-3-video-global-t2v',
    seconds: '5',
    prompt: 'cinematic product turntable',
    metadata: { resolution: 'hd', ratio: '16:9' },
  });
  assert.equal(result.taskId, 'task-safe');
  assert.doesNotMatch(JSON.stringify(result), /opaque-test-key/);
});

test('queryTask preserves the completed FLUX 3 draft cache without exposing credentials', async () => {
  const result = await provider.queryTask('task-safe', 'opaque-test-key', {
    fetchImpl: async () => new Response(JSON.stringify({
      id: 'task-safe', status: 'completed', progress: 100,
      metadata: { url: 'https://cdn.example.com/result.mp4', draft_cache: 'opaque-cache' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.draftCache, 'opaque-cache');
  assert.doesNotMatch(JSON.stringify(result), /opaque-test-key/);
});

test('all 11 new model workflows are saved, key-free, and mode-correct', () => {
  for (const model of [...HAILUO_H3_GLOBAL_VIDEO_MODELS, ...FLUX3_VIDEO_MODELS]) {
    const doc = workflow(model);
    assert.equal(doc.schema, 't8-workflow-fragment');
    assert.doesNotMatch(JSON.stringify(doc), /sk-[A-Za-z0-9]/);
    const generation = doc.nodes.find((node: any) => node.type === 'video' && node.data?.model === model);
    assert.ok(generation, model);
    assert.equal(generation.data.videoBuiltinSource, 'seedance-nz');
    const uploads = doc.nodes.filter((node: any) => node.type === 'upload');
    if (model.endsWith('-i2v')) assert.ok(uploads.some((node: any) => node.data?.uploadType === 'image'));
    if (model.endsWith('-v2v')) assert.ok(uploads.some((node: any) => node.data?.uploadType === 'video'));
    if (model.endsWith('-draft-enhance')) {
      assert.equal(generation.data.flux3DraftCache, '');
      assert.equal(uploads.length, 0);
    }
  }
});

test('Video UI and generation service expose FLUX 3 controls and dedicated routes', () => {
  const ui = source('src/components/nodes/VideoNode.tsx');
  const service = source('src/services/generation.ts');
  for (const token of ['flux3Draft', 'flux3AudioMode', 'flux3SafetyTolerance', 'flux3DraftCache', '继续草稿增强']) {
    assert.match(ui, new RegExp(token));
  }
  assert.match(service, /\/api\/proxy\/video\/flux3\/submit/);
  assert.match(service, /\/api\/proxy\/video\/flux3\/status/);
});
