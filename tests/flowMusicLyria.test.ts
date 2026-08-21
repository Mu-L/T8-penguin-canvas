import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FLOWMUSIC_ACTIONS,
  FLOWMUSIC_MODEL,
  ZHENZHEN_IMAGE_GK_V2_EDIT_MODEL,
  ZHENZHEN_IMAGE_GK_V2_EDIT_RATIOS,
} from '../src/providers/models.ts';

const require = createRequire(import.meta.url);
const provider = require('../backend/src/providers/seedanceNz.js');
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgo=';

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const operations = [
  'flowmusic-generation',
  'flowmusic-lyrics',
  'flowmusic-upload-audio',
  'flowmusic-extend',
  'flowmusic-replace',
  'flowmusic-cover',
  'flowmusic-stems',
  'flowmusic-download-audio',
  'flowmusic-video-clip',
] as const;

test('Grok Image v2 edit follows the official one-to-three image contract', async () => {
  assert.equal(ZHENZHEN_IMAGE_GK_V2_EDIT_MODEL, 'zhenzhen-image-gk-v2-edit');
  assert.ok(ZHENZHEN_IMAGE_GK_V2_EDIT_RATIOS.includes('auto'));
  let uploads = 0;
  const built = await provider.buildImagePayload({
    model: ZHENZHEN_IMAGE_GK_V2_EDIT_MODEL,
    prompt: '保留主体，改成雨夜电影灯光',
    images: [TINY_PNG, TINY_PNG],
    aspect_ratio: '16:9',
    resolution: '2k',
    n: 2,
    nsfw_check: true,
  }, 'test-key', {
    uploadIntervalMs: 0,
    fetchImpl: async () => jsonResponse({ url: `https://cdn.example.com/ref-${++uploads}.png` }),
  });
  assert.equal(built.taskType, 'i2i');
  assert.deepEqual(built.payload, {
    model: 'zhenzhen-image-gk-v2-edit',
    prompt: '保留主体，改成雨夜电影灯光',
    images: ['https://cdn.example.com/ref-1.png', 'https://cdn.example.com/ref-1.png'],
    n: 2,
    aspect_ratio: '16:9',
    resolution: '2k',
    nsfw_check: true,
  });
  assert.equal('quality' in built.payload, false);
  await assert.rejects(
    provider.buildImagePayload({ model: ZHENZHEN_IMAGE_GK_V2_EDIT_MODEL, prompt: 'x', images: [] }, 'test-key'),
    /1-3/,
  );
});

test('Lyria tab exposes nine action SKUs while every payload fixes model to flowmusic', async () => {
  assert.equal(FLOWMUSIC_MODEL, 'flowmusic');
  assert.deepEqual(FLOWMUSIC_ACTIONS.map((item) => item.value), operations);
  const cases: Record<string, Record<string, unknown>> = {
    'flowmusic-generation': { version: 'lyria-3.5', sound_prompt: 'cinematic piano', bpm: 120, length: 30, seed: 7 },
    'flowmusic-lyrics': { prompt: '雨夜重逢' },
    'flowmusic-upload-audio': { audioUrl: 'data:audio/wav;base64,UklGRgQAAABXQVZF' },
    'flowmusic-extend': { version: 'lyria-3.5', clip_id: 'clip-a', extend_from_s: 0, extend_s: 15, instruction: '自然续写' },
    'flowmusic-replace': { version: 'lyria-3.5', clip_id: 'clip-a', start_s: 1, end_s: 5, instruction: '改为弦乐过门' },
    'flowmusic-cover': { version: 'lyria-3.5', clip_id: 'clip-a', instruction: '改为女声爵士', strength: 0.5 },
    'flowmusic-stems': { clip_id: 'clip-a' },
    'flowmusic-download-audio': { clip_id: 'clip-a', format: 'wav' },
    'flowmusic-video-clip': { clip_id: 'clip-a', preset: 'modern' },
  };
  for (const operation of operations) {
    const built = await provider.buildFlowMusicPayload({ operation, ...cases[operation] }, 'test-key', {
      uploadIntervalMs: 0,
      uploadCacheTtlMs: 0,
      fetchImpl: async () => jsonResponse({ url: 'https://media.example.com/source.wav' }),
    });
    assert.equal(built.payload.model, 'flowmusic');
    assert.equal(built.action, operation === 'flowmusic-generation' ? '' : operation.slice('flowmusic-'.length));
    const supportsVersion = ['flowmusic-generation', 'flowmusic-extend', 'flowmusic-replace', 'flowmusic-cover'].includes(operation);
    assert.equal(built.payload.version, supportsVersion ? 'lyria-3.5' : undefined);
  }
  let publicUploadFetches = 0;
  const publicUpload = await provider.buildFlowMusicPayload({
    operation: 'flowmusic-upload-audio',
    audioUrl: 'https://media.example.com/source.m4a',
  }, 'test-key', {
    fetchImpl: async () => {
      publicUploadFetches += 1;
      return jsonResponse({});
    },
  });
  assert.equal(publicUpload.payload.audio_url, 'https://media.example.com/source.m4a');
  assert.equal(publicUploadFetches, 0);
});

test('Flow Music submission and query use the exact documented endpoints and preserve all result kinds', async () => {
  const calls: string[] = [];
  const submitted = await provider.submitFlowMusicTask({
    operation: 'flowmusic-video-clip', clip_id: 'clip-a', preset: 'modern',
  }, 'test-key', {
    fetchImpl: async (url: string) => {
      calls.push(url);
      return jsonResponse({ data: { id: 'task-flow', status: 'pending' } });
    },
  });
  assert.equal(submitted.taskId, 'task-flow');
  assert.match(calls[0], /\/v1\/music\/generations\/video-clip$/);

  const queried = await provider.queryFlowMusicTask('task-flow', 'test-key', {
    resultFamily: 'video',
    fetchImpl: async (url: string) => {
      calls.push(url);
      return jsonResponse({ data: { id: 'task-flow', status: 'completed', result: { music: [{ clip_id: 'clip-a', audio_url: 'https://media.example.com/a.wav', video_url: 'https://media.example.com/a.mp4' }], file_url: 'https://media.example.com/stems.zip', lyrics: '雨落以后' } } });
    },
  });
  assert.match(calls[1], /\/v1\/music\/tasks\/task-flow$/);
  assert.equal(queried.status, 'succeeded');
  assert.deepEqual(queried.clipIds, ['clip-a']);
  assert.equal(queried.text, '雨落以后');
  assert.deepEqual(queried.artifacts.map((item: any) => item.kind).sort(), ['audio', 'file', 'video']);
});

test('all ten importable workflows exist, cover every action, and contain no credentials', () => {
  const names = ['zhenzhen-image-gk-v2-edit', ...operations];
  for (const name of names) {
    const source = readFileSync(join(process.cwd(), 'docs', 'workflows', `${name}.json`), 'utf8');
    const workflow = JSON.parse(source);
    assert.equal(workflow.schema, 't8-workflow-fragment');
    assert.ok(Array.isArray(workflow.nodes) && workflow.nodes.length > 0);
    assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]+/);
    if (name.startsWith('flowmusic-')) {
      assert.ok(workflow.nodes.some((node: any) => node?.data?.flowMusicOperation === name));
      if (!['flowmusic-generation', 'flowmusic-lyrics', 'flowmusic-upload-audio'].includes(name)) {
        assert.ok(workflow.nodes.some((node: any) => node?.data?.flowMusicOperation === 'flowmusic-generation'));
      }
    } else {
      assert.ok(workflow.nodes.some((node: any) => node?.data?.apiModel === name));
    }
  }
});

test('runtime catalog and UI expose Grok edit plus Lyria actions under seedance-nz', () => {
  const artifacts = require('../tools/zcanvas-cli/scripts/creativeRuntimeCatalogArtifacts.cjs');
  const catalog = artifacts.buildRuntimeCatalog();
  const edit = catalog.image.find((entry: any) => entry.id === 'image:seedance-nz:zhenzhen-image-gk-v2-edit');
  assert.equal(edit.family, 'grok-image');
  assert.equal(edit.parameters.maxReferenceImages, 3);
  assert.ok(catalog.audio.some((entry: any) => entry.id === 'audio:seedance-nz:flowmusic'));
  for (const operation of operations) assert.ok(catalog.actions.some((entry: any) => entry.operation === operation || entry.id.endsWith(`:${operation}`)));
  const source = readFileSync(join(process.cwd(), 'src', 'components', 'nodes', 'AudioNode.tsx'), 'utf8');
  for (const fragment of ['Lyria', 'FLOWMUSIC_ACTIONS', 'submitFlowMusic', 'queryFlowMusic']) assert.match(source, new RegExp(fragment));
  const proxy = readFileSync(join(process.cwd(), 'backend', 'src', 'routes', 'proxy.js'), 'utf8');
  for (const fragment of ['/audio/flowmusic/submit', '/audio/flowmusic/status/:tid', 'flowmusic_stems', 'isZip']) {
    assert.match(proxy, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
