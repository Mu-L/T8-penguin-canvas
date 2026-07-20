import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SEEDANCE_NZ_MODEL_OPTIONS,
  SEEDANCE_NZ_RATIO_OPTIONS,
  SEEDANCE_NZ_NATIVE_RESOLUTION_OPTIONS,
} from '../src/config/seedance.ts';
import { assertProductionNodeSchema } from './helpers/canvasNodeSchema.ts';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('Seedance shared frontend catalog exposes six families that expand to 18 task models', () => {
  assert.equal(SEEDANCE_NZ_MODEL_OPTIONS.length, 6);
  assert.deepEqual(SEEDANCE_NZ_RATIO_OPTIONS, ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive']);
  assert.ok(SEEDANCE_NZ_NATIVE_RESOLUTION_OPTIONS.includes('native4k'));
});

test('new SD2 and director nodes default to automatic main API while old data stays legacy-compatible', () => {
  const canvas = read('../src/components/Canvas.tsx');
  const seedanceNode = read('../src/components/nodes/SeedanceNode.tsx');
  const directorNode = read('../src/components/nodes/DirectorStoryboardNode.tsx');

  assert.match(canvas, /seedance:\s*\{[\s\S]*seedanceApiSource: 'auto'[\s\S]*seedanceNzModel: 'fast'/);
  assert.match(canvas, /'director-storyboard':\s*\{[\s\S]*seedanceApiSource: 'auto'[\s\S]*seedanceNzModel: 'fast'/);
  assert.match(seedanceNode, /savedBuiltinSource[\s\S]*: 'zhenzhen-legacy'/);
  assert.match(directorNode, /savedBuiltinSource[\s\S]*: 'zhenzhen-legacy'/);
});

test('SD2 node exposes built-in provider choices and preserves provider during polling', () => {
  const node = read('../src/components/nodes/SeedanceNode.tsx');
  const generation = read('../src/services/generation.ts');

  assert.match(node, /主力 API（自动：优先国内平价工坊）/);
  assert.match(node, /贞贞的平价AI工坊（国内） · api\.seedance\.nz/);
  assert.match(node, /贞贞的AI工坊（海外） · ai\.t8star\.org/);
  assert.match(node, /taskProvider: builtinSource/);
  assert.match(node, /querySeedance\(tid, taskProvider\)/);
  assert.match(node, /lastTaskProvider/);
  assert.match(generation, /taskProvider=\$\{encodeURIComponent\(taskProvider\)\}/);
});

test('proxy routes seedance.nz independently and immediately stores completed output locally', () => {
  const proxy = read('../backend/src/routes/proxy.js');
  const settings = read('../backend/src/routes/settings.js');

  assert.match(proxy, /requestedTaskProvider === seedanceNz\.PROVIDER_ID/);
  assert.match(proxy, /seedanceNz\.submitTask/);
  assert.match(proxy, /seedanceNz\.queryTask/);
  assert.match(proxy, /saveRemoteVideo\(videoUrl, seedanceNz\.fetchRemote\)/);
  assert.match(proxy, /provider: 'zhenzhen-legacy'/);
  assert.match(settings, /zhenzhenSd2ApiKey/);
  assert.match(settings, /zhenzhenSd2BaseUrl: config\.ZHENZHEN_SD2_BASE_URL/);
});

test('video node exposes Happy Horse as an isolated built-in model family', () => {
  const models = read('../src/providers/models.ts');
  const node = read('../src/components/nodes/VideoNode.tsx');
  const generation = read('../src/services/generation.ts');
  for (const model of ['happyhorse-1.1-t2v', 'happyhorse-1.1-i2v', 'happyhorse-1.1-r2v']) {
    assert.match(models, new RegExp(model.replaceAll('.', '\\.')));
  }
  assert.match(models, /label: 'Happy Horse'/);
  assert.match(models, /durations: \[3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15\]/);
  assert.match(models, /resolutions: \['720p', '1080p'\]/);
  assert.match(node, /submitHappyHorse/);
  assert.match(node, /happyHorseMode === 'i2v' \? 1 : 9/);
  assert.match(node, /文生视频只使用提示词，不发送画布中的参考图/);
  assert.match(generation, /\/api\/proxy\/video\/happyhorse\/submit/);
  assert.match(generation, /\/api\/proxy\/video\/happyhorse\/status/);
});

test('video node exposes Wan 2.7 Spicy as an isolated built-in i2v family', () => {
  const models = read('../src/providers/models.ts');
  const node = read('../src/components/nodes/VideoNode.tsx');
  const generation = read('../src/services/generation.ts');
  const proxy = read('../backend/src/routes/proxy.js');

  assert.match(models, /label: 'Wan'/);
  assert.match(models, /value: 'wan-2\.7-spicy-i2v'/);
  assert.match(models, /durations: \[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15\]/);
  assert.match(node, /submitWan/);
  assert.match(node, /Wan 2\.7 Spicy 仅支持图生视频/);
  assert.match(node, /wanNegativePrompt/);
  assert.match(node, /wanAudioUrl/);
  assert.match(node, /wanPromptExtend/);
  assert.match(generation, /\/api\/proxy\/video\/wan\/submit/);
  assert.match(generation, /\/api\/proxy\/video\/wan\/status/);
  assert.match(proxy, /seedanceNz\.submitWanTask/);
});

test('Seedream NZ selector distinguishes domestic and Dola overseas model families', () => {
  const node = read('../src/components/nodes/ImageNode.tsx');
  const generation = read('../src/services/generation.ts');
  const provider = read('../backend/src/providers/seedanceNz.js');

  assert.match(node, /Seedream v5 Pro（国内模型）/);
  assert.match(node, /Dola Seedream 5\.0 Pro（海外模型）/);
  assert.match(node, /dola-seedream-5\.0-pro-t2i/);
  assert.match(node, /dola-seedream-5\.0-pro-i2i/);
  assert.match(node, /modelFamily: seedreamNzModelFamily/);
  assert.match(generation, /modelFamily\?: 'domestic' \| 'overseas'/);
  assert.match(provider, /dola-seedream-5\.0-pro-t2i/);
  assert.match(provider, /dola-seedream-5\.0-pro-i2i/);
});

test('audio node exposes Seed Audio without replacing Suno and supports image/audio references', () => {
  const node = read('../src/components/nodes/AudioNode.tsx');
  const generation = read('../src/services/generation.ts');
  const apiSettings = read('../src/components/ApiSettings.tsx');
  assert.match(node, /audioProviderMode.*seed-audio/);
  assert.match(node, /doubao-seed-audio-1\.0/);
  assert.match(node, /submitSeedAudio/);
  assert.match(node, /querySeedAudio/);
  assert.match(node, /Seed Audio 的音色 ID、参考图和参考音频只能选择一种/);
  assert.match(node, /\['wav', 'mp3', 'pcm', 'ogg_opus'\]/);
  assert.match(node, /\['8000', '16000', '24000', '32000', '44100'\]/);
  assert.match(node, /submitAudio\(/);
  assert.match(generation, /\/api\/proxy\/audio\/seed-audio\/submit/);
  assert.match(generation, /\/api\/proxy\/audio\/seed-audio\/status/);
  assertProductionNodeSchema('audio', {
    label: '音频',
    category: 'core',
    inputs: ['text', 'image', 'audio'],
    outputs: ['audio'],
    executable: true,
  });
  assert.match(apiSettings, /Happy Horse、Seedream 与 Seed Audio/);
});

test('proxy keeps Happy Horse and Seed Audio on the domestic key and stores outputs locally', () => {
  const proxy = read('../backend/src/routes/proxy.js');
  assert.match(proxy, /seedanceNz\.submitHappyHorseTask/);
  assert.match(proxy, /seedanceNz\.submitAudioTask/);
  assert.match(proxy, /settings\?\.zhenzhenSd2ApiKey/);
  assert.match(proxy, /saveRemoteVideo\(videoUrl, seedanceNz\.fetchRemote\)/);
  assert.match(proxy, /saveRemoteAudio\(audioUrl\)/);
});
