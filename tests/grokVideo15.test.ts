import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GROK_VIDEO_1_5_NEW_MODELS,
  VIDEO_FAL_REGISTRY,
  VIDEO_MODELS,
  GROK_VIDEO_1_5_NEW_SIZES,
  grokVideo15NewSizeFromRatio,
  isFalVideoModel,
  isGrokVideo15NewModel,
} from '../src/providers/models.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('video model type order keeps every released built-in family stable', () => {
  const visibleVideoModels = VIDEO_MODELS.filter((model) => model.kind !== 'seedance');

  assert.deepEqual(
    visibleVideoModels.map((model) => model.label),
    ['Grok Video', 'Veo', 'Sora2', 'Wan', 'Happy Horse', 'Hailuo', 'Flux3', 'Vidu', 'Kling', 'Upscaler', 'FlashVSR 视频超分', 'Seedance 2.5'],
  );
  assert.equal(VIDEO_MODELS[0].kind, 'grok');
});

test('grok video tab defaults to grok-video-3 zhenzhen model with the new display name', () => {
  const grok = VIDEO_MODELS.find((model) => model.kind === 'grok');

  assert.ok(grok);
  assert.equal(grok.apiModelOptions[0].value, 'grok-video-3');
  assert.equal(grok.apiModelOptions[0].label, 'grok-video-3（新版1.5）');
  assert.ok(grok.apiModelOptions.some((option) => option.value === 'grok-imagine-video-1.5'));
});

test('Grok Video includes the new zhenzhen grok 1.5 models without treating them as FAL', () => {
  const grok = VIDEO_MODELS.find((model) => model.kind === 'grok');

  assert.ok(grok);
  assert.deepEqual(
    GROK_VIDEO_1_5_NEW_MODELS,
    ['grok-1.5-video-6s', 'grok-1.5-video-10s', 'grok-1.5-video-15s'],
  );
  for (const model of GROK_VIDEO_1_5_NEW_MODELS) {
    assert.ok(grok.apiModelOptions.some((option) => option.value === model), `${model} should be selectable`);
    assert.equal(isGrokVideo15NewModel(model), true);
    assert.equal(isFalVideoModel(model), false);
  }
});

test('Grok Video 1.5 new models use Comfly size mapping instead of old duration/resolution fields', () => {
  assert.deepEqual(
    GROK_VIDEO_1_5_NEW_SIZES.map((item) => item.value),
    ['1280x720', '720x1280'],
  );
  assert.equal(grokVideo15NewSizeFromRatio('16:9'), '1280x720');
  assert.equal(grokVideo15NewSizeFromRatio('9:16'), '720x1280');
  assert.equal(grokVideo15NewSizeFromRatio('1:1'), '1280x720');

  const videoNode = read('../src/components/nodes/VideoNode.tsx');
  assert.match(videoNode, /isGrok15New/);
  assert.match(videoNode, /const grok15NewSize =/);
  assert.ok(videoNode.includes('payload.size = grok15NewSize'));
  assert.match(videoNode, /尺寸/);
  assert.match(videoNode, /Grok 1\.5 New 需要 1 张参考图/);
});

test('Grok Video 1.5 new backend path follows Comfly /v1/videos multipart protocol', () => {
  const proxyRoute = read('../backend/src/routes/proxy.js');

  assert.match(proxyRoute, /GROK_VIDEO_1_5_NEW_MODELS/);
  assert.match(proxyRoute, /isGrokVideo15NewModel\(lowerModel\)/);
  assert.match(proxyRoute, /form\.append\('model', model\)/);
  assert.match(proxyRoute, /form\.append\('prompt', prompt\)/);
  assert.match(proxyRoute, /form\.append\('size', grokVideo15NewSizeFromRatio/);
  assert.match(proxyRoute, /appendGrokVideo15InputReference\(form, refs\[0\]/);
  assert.match(proxyRoute, /rememberTaskKey\(taskId, apiKey, \{ model,/);
  assert.match(proxyRoute, /isVeoOmniModel\(queryModel\) \|\| isGrokVideo15NewModel\(queryModel\)/);
});

test('Veo category defaults to veo-omni-10s without removing legacy Veo options', () => {
  const veo = VIDEO_MODELS.find((model) => model.kind === 'veo');

  assert.ok(veo);
  assert.equal(veo.label, 'Veo');
  assert.equal(veo.apiModelOptions[0].value, 'veo-omni-10s');
  assert.ok(veo.apiModelOptions.some((option) => option.value === 'veo3.1'));
  assert.ok(veo.apiModelOptions.some((option) => option.value === 'veo3.1-fal'));
});

test('Grok Video 1.5 uses the v1.5 image-to-video FAL endpoint with base64 images', () => {
  const fal = VIDEO_FAL_REGISTRY['grok-imagine-video-1.5'];

  assert.ok(fal);
  assert.equal(fal.paramKind, 'grok-fal');
  assert.equal(fal.endpoint, 'xai/grok-imagine-video/v1.5/image-to-video');
  assert.equal(fal.maxRefImages, 1);
  assert.equal(fal.defaultImageMode, 'base64');
});

test('Sora2 keeps the existing FAL option and adds a separate Zhenzhen API option', () => {
  const sora = VIDEO_MODELS.find((model) => model.kind === 'sora');

  assert.ok(sora);
  assert.deepEqual(
    sora.apiModelOptions.map((option) => option.value),
    ['sora-2', 'sora-2-zhenzhen'],
  );
  assert.equal(isFalVideoModel('sora-2'), true);
  assert.equal(isFalVideoModel('sora-2-zhenzhen'), false);
  assert.deepEqual(sora.ratios, ['16:9', '9:16']);
  assert.deepEqual(sora.durations, [15]);
  assert.equal(sora.maxRefImages, 1);
});

test('Sora2 has an independent classified API key field', () => {
  const apiSettings = read('../src/components/ApiSettings.tsx');
  const settingsRoute = read('../backend/src/routes/settings.js');
  const proxyRoute = read('../backend/src/routes/proxy.js');

  assert.match(apiSettings, /'soraApiKey'/);
  assert.match(apiSettings, /label: 'sora2 系列'/);
  assert.match(settingsRoute, /soraApiKey: ''/);
  assert.match(settingsRoute, /'soraApiKey'/);
  assert.match(proxyRoute, /m\.includes\('sora'\)\) return settings\.soraApiKey \|\| fb/);
});

test('Sora2 Zhenzhen API channel maps to upstream sora-2 without touching FAL sora-2', () => {
  const proxyRoute = read('../backend/src/routes/proxy.js');

  assert.match(proxyRoute, /const isSoraZhenzhen = lowerModel === 'sora-2-zhenzhen'/);
  assert.match(proxyRoute, /model: 'sora-2'/);
  assert.match(proxyRoute, /private: privateVideo !== false && is_private !== false/);
  assert.match(proxyRoute, /images\.slice\(0,\s*1\)\.map\(stripDataUrlPrefix\)/);
  assert.match(proxyRoute, /const providerError = await boundedProviderHttpError\(r, 'Video submit failed'\)/);
  assert.match(proxyRoute, /return res\.status\(r\.status\)\.json\(\{ success: false, error: providerError\.message \}\)/);
  assert.doesNotMatch(proxyRoute, /getUpstreamErrorMessage\(data, text, r\.status\)/);
});

test('Veo Omni uses the Comfly /v1/videos multipart protocol', () => {
  const proxyRoute = read('../backend/src/routes/proxy.js');
  const videoNode = read('../src/components/nodes/VideoNode.tsx');

  assert.match(proxyRoute, /const VEO_OMNI_PUBLIC_MODEL = 'veo-omni-10s'/);
  assert.match(proxyRoute, /const VEO_OMNI_UPSTREAM_MODEL = 'omni_flash-10s'/);
  assert.match(proxyRoute, /\/v1\/videos/);
  assert.match(proxyRoute, /form\.append\('input_reference'/);
  assert.match(proxyRoute, /rememberTaskKey\(taskId, apiKey, \{ model: VEO_OMNI_PUBLIC_MODEL,/);
  assert.match(proxyRoute, /isVeoOmniModel\(queryModel\)/);
  assert.ok(videoNode.includes('payload.duration = 10'));
  assert.match(videoNode, /veo-omni-10s 需要 1 张参考图/);
});

test('FAL routes use the common zhenzhen key instead of group tokens', () => {
  const proxyRoute = read('../backend/src/routes/proxy.js');
  const imageNode = read('../src/components/nodes/ImageNode.tsx');
  const videoNode = read('../src/components/nodes/VideoNode.tsx');

  assert.match(proxyRoute, /FAL 全部固定使用通用贞贞 API Key/);
  assert.match(proxyRoute, /ensureDefaultZhenzhenKey\(settings, res, '图像 FAL'\)/);
  assert.match(proxyRoute, /ensureDefaultZhenzhenKey\(settings, res, '视频 FAL'\)/);
  assert.doesNotMatch(proxyRoute, /route: 'image\/fal\/submit'[\s\S]*?applyZhenzhenProviderContext/);
  assert.doesNotMatch(proxyRoute, /route: 'video\/fal\/submit'[\s\S]*?applyZhenzhenProviderContext/);
  assert.match(imageNode, /providerKind: isFal[\s\S]{0,220}\? 'fal'[\s\S]{0,220}isZhenzhenBudgetImageSelected \? 'seedance-nz-image'/);
  assert.match(videoNode, /providerKind: isFal \? 'fal' : \(isSeedanceNzVideo \? 'seedance-nz-video' : modelDef\.kind\)/);
});
