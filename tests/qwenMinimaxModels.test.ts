import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IMAGE_MODELS,
  MINIMAX_H3_OW_VIDEO_MODELS,
  QWEN_IMAGE_30_MODELS,
  QWEN_IMAGE_30_RATIOS,
  VIDEO_MODELS,
  videoModelOptionsForSource,
} from '../src/providers/models.ts';

const root = join(import.meta.dirname, '..');
const workflow = (name: string) => JSON.parse(readFileSync(join(root, 'docs', 'workflows', `${name}.json`), 'utf8'));
const source = (name: string) => readFileSync(join(root, name), 'utf8');

const QWEN_MODELS = [
  'qwen-image-3.0-t2i',
  'qwen-image-3.0-i2i',
  'qwen-image-3.0-pro-t2i',
  'qwen-image-3.0-pro-i2i',
  'qwen-image-3.0-global-t2i',
  'qwen-image-3.0-global-i2i',
  'qwen-image-3.0-global-pro-t2i',
  'qwen-image-3.0-global-pro-i2i',
] as const;

const MINIMAX_MODELS = [
  'minimax-h3-ow-t2v',
  'minimax-h3-ow-r2v',
  'minimax-h3-ow-i2v',
  'minimax-h3-ow-i2v-fast',
  'minimax-h3-ow-r2v-fast',
] as const;

test('Qwen Image tab exposes the exact documented 8-model catalog and controls', () => {
  assert.deepEqual(QWEN_IMAGE_30_MODELS, QWEN_MODELS);
  assert.deepEqual(QWEN_IMAGE_30_RATIOS, [
    '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
  ]);
  const tab = IMAGE_MODELS.find((item) => item.id === 'qwen-image-3.0');
  assert.ok(tab);
  assert.equal(tab.tabLabel, 'Qwen Image');
  assert.equal(tab.paramKind, 'qwen-image-3.0');
  assert.equal(tab.maxReferenceImages, 3);
  assert.deepEqual(tab.apiModelOptions.map((item) => item.value), QWEN_MODELS);

  const ui = source('src/components/nodes/ImageNode.tsx');
  for (const field of ['qwenSizingMode', 'qwenResolution', 'qwenCustomSize', 'qwenImageCount', 'qwenSeed', 'qwenNegativePrompt', 'qwenPromptExtend']) {
    assert.match(ui, new RegExp(field));
  }
  assert.match(ui, /Qwen Image 3\.0 提示词必须为 5-2000 字符/);
  assert.match(ui, /isQwenImageI2I.*必须提供 1-3 张参考图/s);
});

test('Hailuo tab contains the exact MiniMax H3 OW catalog with model-specific options', () => {
  const hailuo = VIDEO_MODELS.find((item) => item.id === 'hailuo-2.3');
  assert.ok(hailuo);
  const options = videoModelOptionsForSource(hailuo, 'seedance-nz');
  const minimax = options.filter((item) => item.value.startsWith('minimax-h3-ow-'));
  assert.deepEqual(MINIMAX_H3_OW_VIDEO_MODELS, MINIMAX_MODELS);
  assert.deepEqual(minimax.map((item) => item.value), MINIMAX_MODELS);
  for (const option of minimax) {
    assert.deepEqual(option.durations, [5, 10, 15]);
    assert.deepEqual(option.resolutions, ['480p', '720p']);
    assert.deepEqual(option.ratios, ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9']);
  }
  assert.equal(minimax.find((item) => item.value.endsWith('-t2v'))?.maxRefImages, 0);
  assert.equal(minimax.find((item) => item.value.endsWith('-r2v'))?.maxRefImages, 1);
  assert.equal(minimax.find((item) => item.value.endsWith('-i2v'))?.maxRefImages, 1);
  assert.equal(minimax.find((item) => item.value === 'minimax-h3-ow-r2v-fast')?.maxRefImages, 9);
  assert.equal(minimax.find((item) => item.value === 'minimax-h3-ow-i2v-fast')?.maxRefImages, 1);

  const ui = source('src/components/nodes/VideoNode.tsx');
  assert.match(ui, /const isMinimaxH3Ow/);
  assert.match(ui, /hailuoMode === 'r2v'/);
  assert.match(ui, /isMinimaxH3OwFast && hailuoMode === 'r2v' \? 9 : 1/);
  assert.match(ui, /Fast 图生视频必须且只能连接或拖入 1 张首帧图/);
  assert.match(ui, /resolution === '720p' \? '720p' : '480p'/);
});

test('all 13 model workflows are saved, key-free and provide reference upload nodes where required', () => {
  for (const model of [...QWEN_MODELS, ...MINIMAX_MODELS]) {
    const doc = workflow(model);
    assert.equal(doc.schema, 't8-workflow-fragment');
    assert.equal(JSON.stringify(doc).includes('sk-'), false);
    const generation = doc.nodes.find((node: any) => node.data?.apiModel === model || node.data?.model === model);
    assert.ok(generation, `${model} workflow must contain its generation node`);
    const needsImage = model.endsWith('-i2i') || model.includes('-i2v') || model.includes('-r2v');
    const incomingImage = doc.edges.some((edge: any) => edge.target === generation.id
      && doc.nodes.some((node: any) => node.id === edge.source && node.type === 'upload' && node.data?.uploadType === 'image'));
    assert.equal(incomingImage, needsImage, `${model} reference upload contract`);
  }
});

test('Qwen and MiniMax companion concurrency workflows use the real parallel Loop node', () => {
  for (const [name, generationType, expectedModel] of [
    ['qwen-image-3.0-concurrent', 'image', 'qwen-image-3.0-t2i'],
    ['minimax-h3-ow-concurrent', 'video', 'minimax-h3-ow-t2v'],
  ] as const) {
    const doc = workflow(name);
    const loop = doc.nodes.find((node: any) => node.type === 'loop');
    assert.ok(loop);
    assert.equal(loop.data.mode, 'parallel');
    assert.equal(loop.data.kind, 'text');
    const promptNodes = doc.nodes.filter((node: any) => node.type === 'text');
    assert.equal(promptNodes.length, 3);
    const generation = doc.nodes.find((node: any) => node.type === generationType);
    assert.ok(generation);
    assert.equal(generation.data.apiModel || generation.data.model, expectedModel);
    assert.ok(doc.edges.some((edge: any) => edge.source === loop.id && edge.target === generation.id));
    assert.ok(doc.edges.some((edge: any) => edge.source === generation.id
      && doc.nodes.some((node: any) => node.id === edge.target && node.type === 'output')));
  }
});
