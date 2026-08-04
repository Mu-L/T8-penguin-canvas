import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildMiniMaxH3Messages,
  MINIMAX_H3_DEFAULT_MODEL,
  MINIMAX_H3_PROMPT_ENHANCER_CONTRACT,
  miniMaxH3Temperature,
  reorderMiniMaxH3OutputFields,
  validateMiniMaxH3Input,
  type MiniMaxH3Input,
} from '../src/utils/minimaxH3PromptEnhancer.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function input(overrides: Partial<MiniMaxH3Input> = {}): MiniMaxH3Input {
  return {
    prompt: '一只企鹅在雨夜的球场完成最后一次射门',
    taskType: 'T2VA',
    durationSeconds: 5,
    rewriteMode: 'balanced',
    descriptionTarget: 0,
    outputLanguage: '中文',
    promptMode: '官方增强',
    images: [],
    videos: [],
    seed: 0,
    ...overrides,
  };
}

test('MiniMax H3 shared contract preserves the reference modes while overriding only the Canvas default model', () => {
  assert.equal(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.schema, 't8-minimax-h3-prompt-enhancer-contract-v1');
  assert.equal(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.defaultProvider, 'seedance-nz');
  assert.equal(MINIMAX_H3_DEFAULT_MODEL, 'bytedance/doubao-seed-2.1-pro');
  assert.deepEqual(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.taskTypes, ['T2VA', 'I2VA', 'FL2VA', 'L2VA', 'Ref2VA']);
  assert.equal(miniMaxH3Temperature('strict'), 0.2);
  assert.equal(miniMaxH3Temperature('balanced'), 0.7);
  assert.equal(miniMaxH3Temperature('creative'), 1.2);
});

test('MiniMax H3 validates exact task media contracts and API-key-like text fail closed', () => {
  assert.deepEqual(validateMiniMaxH3Input(input()), []);
  assert.deepEqual(validateMiniMaxH3Input(input({ taskType: 'I2VA', images: ['/files/input/first.png'] })), [
    { kind: 'image', label: '<Picture 1>', url: '/files/input/first.png' },
  ]);
  assert.deepEqual(validateMiniMaxH3Input(input({ taskType: 'FL2VA', images: ['first.png', 'last.png'] })), [
    { kind: 'image', label: '<Picture 1>', url: 'first.png' },
    { kind: 'image', label: '<Picture 2>', url: 'last.png' },
  ]);
  assert.throws(() => validateMiniMaxH3Input(input({ taskType: 'T2VA', images: ['unexpected.png'] })), /不接受参考素材/);
  assert.throws(() => validateMiniMaxH3Input(input({ taskType: 'I2VA' })), /只能连接 1 张图片/);
  assert.throws(() => validateMiniMaxH3Input(input({ prompt: 'secret sk-abcdefghijklmnop' })), /疑似 API Key/);
  assert.throws(() => validateMiniMaxH3Input(input({ promptMode: '参考模板融合' })), /必须填写参考模板/);
});

test('Ref2VA keeps full temporal evidence limits instead of silently reducing videos to frames', () => {
  const plan = validateMiniMaxH3Input(input({
    taskType: 'Ref2VA',
    images: ['a.png', 'b.png'],
    videos: [
      { url: 'a.mp4', duration: 5, size: 1024, formatName: 'mov,mp4,m4a,3gp,3g2,mj2' },
      { url: 'b.mkv', duration: 6, size: 2048, formatName: 'matroska,webm' },
    ],
  }));
  assert.deepEqual(plan.map((item) => item.label), ['<Picture 1>', '<Picture 2>', '<Video 1>', '<Video 2>']);
  assert.throws(() => validateMiniMaxH3Input(input({
    taskType: 'Ref2VA',
    videos: [{ url: 'too-short.mp4', duration: 1.9, formatName: 'mp4' }],
  })), /2-15 秒/);
  assert.throws(() => validateMiniMaxH3Input(input({
    taskType: 'Ref2VA',
    videos: [
      { url: 'a.mp4', duration: 8, formatName: 'mp4' },
      { url: 'b.mp4', duration: 8, formatName: 'mp4' },
    ],
  })), /总时长最多 15 秒/);
});

test('message compiler labels every picture and full temporal video and preserves official output contract', () => {
  const spec = input({
    taskType: 'Ref2VA',
    promptMode: '参考模板融合',
    referenceTemplate: '三段式节奏模板',
    referenceContext: 'Picture 1 与 Picture 2 是同一角色',
    constraints: '不要改变球衣号码',
    images: ['a.png'],
    videos: [{ url: 'a.mp4', duration: 5, formatName: 'mp4' }],
  });
  const plan = validateMiniMaxH3Input(spec);
  const messages = buildMiniMaxH3Messages(spec, plan);
  assert.equal(messages.length, 2);
  assert.match(String(messages[0].content), /Output exactly these six fields in order/);
  assert.match(String(messages[0].content), /A video is temporal evidence/);
  assert.ok(Array.isArray(messages[1].content));
  const parts = messages[1].content as Array<Record<string, any>>;
  assert.deepEqual(parts.filter((part) => part.type === 'image_url').map((part) => part.image_url.url), ['a.png']);
  assert.deepEqual(parts.filter((part) => part.type === 'video_url').map((part) => part.video_url.url), ['a.mp4']);
  assert.match(parts.map((part) => part.text || '').join('\n'), /Analyze its full timeline/);
});

test('field reorder is conservative and only reorders a complete unique field set', () => {
  const reordered = reorderMiniMaxH3OutputFields([
    'overall_soundscape: rain',
    '',
    'integrated_multimodal_description: [Shot 1] kick',
    '',
    'non_diegetic_music: drums',
  ].join('\n'), 'T2VA');
  assert.match(reordered, /^integrated_multimodal_description:/);
  assert.ok(reordered.indexOf('overall_soundscape:') < reordered.indexOf('non_diegetic_music:'));
  const incomplete = 'overall_soundscape: rain\n\nnon_diegetic_music: drums';
  assert.equal(reorderMiniMaxH3OutputFields(incomplete, 'T2VA'), incomplete);
});

test('Canvas node, proxy and schema wire the default channel, single paid request and executable surface', () => {
  const node = read('src/components/nodes/MiniMaxH3PromptEnhancerNode.tsx');
  const canvas = read('src/components/Canvas.tsx');
  const proxy = read('backend/src/routes/proxy.js');
  const schema = JSON.parse(read('backend/src/shared/canvasNodeSchema.json'));
  assert.match(node, /requestProfile: 'minimax-h3-prompt-enhancer'/);
  assert.match(node, /llmVideoMode: 'raw-base64'/);
  assert.match(node, /advancedProvidersForNode\(advancedProviders, 'llm'\)/);
  assert.match(node, /savedExternalModelMissing/);
  assert.match(node, /savedSeedanceModelMissing/);
  assert.match(node, /不会静默切换模型/);
  assert.match(canvas, /providerModel: 'bytedance\/doubao-seed-2\.1-pro'/);
  assert.match(proxy, /noRetry: minimaxH3Profile/);
  assert.match(proxy, /uploadMiniMaxH3MessageMedia/);
  assert.match(read('backend/src/providers/seedanceNz.js'), /normalizeImagePng[\s\S]*ensureSize\(buffer, kind, options\.maxBytes\)/);
  const entry = schema.types.find((item: any) => item.type === 'minimax-h3-prompt-enhancer');
  assert.equal(entry.executable, true);
  assert.equal(entry.generatable, true);
  assert.deepEqual(entry.ports, { inputs: ['text', 'image', 'video'], outputs: ['text'] });
});
