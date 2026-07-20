import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { IMAGE_MODELS, gptImage2ZhenzhenVariantSize, isFalModel } from '../src/providers/models.ts';

const imageNodeSource = fs.readFileSync(new URL('../src/components/nodes/ImageNode.tsx', import.meta.url), 'utf8');
const proxySource = fs.readFileSync(new URL('../backend/src/routes/proxy.js', import.meta.url), 'utf8');

test('Nano Banana 2 maps to the current Gemini Flash image upstream model', () => {
  const banana2 = IMAGE_MODELS.find((model) => model.id === 'nano-banana-2');

  assert.equal(banana2?.apiModel, 'gemini-3.1-flash-image');
  assert.equal(banana2?.apiModelOptions[0]?.value, 'gemini-3.1-flash-image');
  assert.equal(banana2?.apiModelOptions[0]?.label, 'nano-banana-2 (Flash)');
  assert.equal(banana2?.apiModelOptions.some((option) => option.value === 'gemini-3.1-flash-lite-image'), true);
  assert.equal(banana2?.paramKind, 'banana-ratio');
  assert.equal(banana2?.apiModelOptions.some((option) => option.value === 'nano-banana-2-fal'), true);
});

test('Nano Banana image models expose the 9:21 portrait aspect ratio', () => {
  const banana2 = IMAGE_MODELS.find((model) => model.id === 'nano-banana-2');
  const bananaPro = IMAGE_MODELS.find((model) => model.id === 'nano-banana-pro');

  assert.ok(banana2?.aspectRatios.includes('9:21'));
  assert.ok(bananaPro?.aspectRatios.includes('9:21'));
});

test('old saved nano-banana-2 apiModel values are not submitted as upstream model ids', () => {
  assert.match(imageNodeSource, /modelDef\.apiModelOptions\.some\(\(opt\) => opt\.value === savedApiModel\)/);
  assert.match(proxySource, /function normalizeImageApiModel\(model\)/);
  assert.match(proxySource, /raw === 'nano-banana-2'\) return 'gemini-3\.1-flash-image'/);
  assert.match(proxySource, /raw === 'gemini-3\.1-flash-image-preview'\) return 'gemini-3\.1-flash-image'/);
  assert.match(proxySource, /raw === 'gemini-3\.1-flash-image-previiew'\) return 'gemini-3\.1-flash-image'/);
});

test('Gemini official image models use native generateContent while legacy banana ids keep image_size protocol', () => {
  assert.match(proxySource, /m\.includes\('flash-image'\)/);
  assert.match(proxySource, /m\.includes\('flash-lite-image'\)/);
  assert.match(proxySource, /m\.includes\('gemini-3-pro-image'\)/);
  assert.match(proxySource, /function isBananaImageModel\(model\)/);
  assert.match(proxySource, /function isOfficialGeminiImageModel\(model\)/);
  assert.match(proxySource, /\/v1\/models\/\$\{encodeURIComponent\(finalApiModel\)\}:generateContent/);
  assert.match(proxySource, /generationConfig/);
  assert.match(proxySource, /responseFormat/);
  assert.match(proxySource, /imageSize/);
  assert.match(proxySource, /form\.append\('image_size', lvlUpper\)/);
  assert.match(proxySource, /body\.image_size = lvlUpper/);
});

test('Nano Banana Pro short ids stay unchanged while Gemini Pro preview ids normalize separately', () => {
  const bananaPro = IMAGE_MODELS.find((model) => model.id === 'nano-banana-pro');
  const options = bananaPro?.apiModelOptions.map((option) => option.value) || [];

  assert.equal(bananaPro?.apiModel, 'nano-banana-pro');
  assert.deepEqual(options.slice(0, 3), [
    'nano-banana-pro',
    'nano-banana-pro-2k',
    'nano-banana-pro-4k',
  ]);
  assert.equal(options.includes('gemini-3-pro-image'), true);
  assert.equal(options.includes('nano-banana-pro-fal'), true);
  assert.equal(isFalModel('nano-banana-pro-fal'), true);
  assert.equal(isFalModel('nano-banana-pro'), false);
  assert.doesNotMatch(proxySource, /lower === 'nano-banana-pro'\) return 'gemini-3-pro-image'/);
  assert.match(proxySource, /raw === 'gemini-3-pro-image-preview'\) return 'gemini-3-pro-image'/);
  assert.match(proxySource, /raw === 'gemini-3-pro-image-2k-preview'\) return 'gemini-3-pro-image-2k'/);
  assert.match(proxySource, /raw === 'gemini-3-pro-image-4k-preview'\) return 'gemini-3-pro-image-4k'/);
});

test('GPT Image 2 2K and 4K variants stay on the Zhenzhen gpt-image-2 route', () => {
  const gpt2 = IMAGE_MODELS.find((model) => model.id === 'gpt-image-2');
  const options = gpt2?.apiModelOptions.map((option) => option.value) || [];

  assert.ok(options.includes('gpt-image-2-2K'));
  assert.ok(options.includes('gpt-image-2-4K'));
  assert.equal(gptImage2ZhenzhenVariantSize('gpt-image-2-2K'), '2K');
  assert.equal(gptImage2ZhenzhenVariantSize('gpt-image-2-4K'), '4K');
  assert.equal(isFalModel('gpt-image-2-2K'), false);
  assert.equal(isFalModel('gpt-image-2-4K'), false);
  assert.match(imageNodeSource, /gptImage2ZhenzhenVariantSize\(nextApiModel\)/);
  assert.match(proxySource, /if \(gptImage2ZhenzhenVariantSize\(raw\)\) return 'gpt-image-2'/);
  assert.match(proxySource, /image_size: gptImage2ForcedSize \|\| image_size/);
  assert.match(proxySource, /size: gptImage2ForcedSize \? undefined : size/);
});

test('Seedream V5 Pro is isolated behind its own image protocol and supports up to 10 edit references', () => {
  const seedream = IMAGE_MODELS.find((model) => model.id === 'seedream-v5-pro');

  assert.equal(seedream?.tabLabel, 'Seedream');
  assert.equal(seedream?.apiModel, 'seedream-v5-pro');
  assert.equal(seedream?.paramKind, 'seedream-v5');
  assert.deepEqual(seedream?.capabilities, ['t2i', 'i2i', 'edit']);
  assert.equal(seedream?.defaultSize, '2048x2048');
  assert.ok(seedream?.sizes.includes('1024x1024'));
  assert.ok(seedream?.sizes.includes('4096x4096'));
  assert.ok(seedream?.sizes.includes('custom'));
  assert.equal(seedream?.maxReferenceImages, 10);
  assert.match(imageNodeSource, /sizeLevel === 'custom' \? seedreamCustomSize : sizeLevel/);
  assert.match(imageNodeSource, /Seedream 自定义尺寸格式应为 宽x高/);
  assert.match(imageNodeSource, /response_format: isSeedream \? 'url' : undefined/);
  assert.match(imageNodeSource, /output_format: isSeedream \? seedreamOutputFormat : undefined/);
  assert.match(proxySource, /if \(paramKind === 'seedream-v5'\)/);
  assert.match(proxySource, /const url = `\$\{upstreamBase\}\/generations`/);
  assert.match(proxySource, /if \(seedreamRefs\.length\) body\.image = seedreamRefs/);
  assert.match(proxySource, /Seedream 尺寸格式无效/);
  assert.match(imageNodeSource, /remaining: maxRefs - orderedImages\.length/);
});

test('Seedream tab keeps legacy source by default and exposes isolated seedance.nz image routing', () => {
  assert.match(imageNodeSource, /d\?\.seedreamApiSource === 'seedance-nz' \? 'seedance-nz' : 'zhenzhen'/);
  assert.match(imageNodeSource, /贞贞的AI工坊（海外） · 原 Seedream/);
  assert.match(imageNodeSource, /贞贞的平价AI工坊（国内） · api\.seedance\.nz/);
  assert.match(imageNodeSource, /seedream-v5-pro-i2i/);
  assert.match(imageNodeSource, /seedream-v5-pro-t2i/);
  assert.match(imageNodeSource, /submitSeedreamNz/);
  assert.match(imageNodeSource, /querySeedreamNz/);
  assert.match(proxySource, /\/image\/seedance-nz\/submit/);
  assert.match(proxySource, /\/image\/seedance-nz\/status\/:tid/);
  assert.match(proxySource, /settings\?\.zhenzhenSd2ApiKey/);
  assert.match(proxySource, /seedanceNz\.submitImageTask/);
  assert.match(proxySource, /seedanceNz\.queryImageTask/);
});
