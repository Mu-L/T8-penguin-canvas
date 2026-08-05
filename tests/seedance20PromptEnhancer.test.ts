import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildSeedance20Messages,
  SEEDANCE20_DEFAULT_MODEL,
  SEEDANCE20_PROMPT_ENHANCER_CONTRACT,
  validateSeedance20Input,
  type Seedance20Input,
  type Seedance20VideoEvidence,
} from '../src/utils/seedance20PromptEnhancer.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const video = (url: string, duration = 5): Seedance20VideoEvidence => ({ url, duration, size: 1024, formatName: 'mp4' });
const base = (overrides: Partial<Seedance20Input> = {}): Seedance20Input => ({
  prompt: '一名短发女孩在雨夜街道奔跑，镜头跟随她穿过霓虹倒影。',
  taskIntent: 'AUTO',
  complexityMode: 'auto',
  durationSeconds: 0,
  shotCount: 0,
  rewriteMode: 'balanced',
  outputDetail: 'auto',
  outputLanguage: '中文',
  promptMode: '官方优化',
  referenceSyntax: 'official-cn',
  subtitlePolicy: 'auto',
  stabilityConstraints: 'auto',
  customLengthTarget: 0,
  images: [],
  videos: [],
  seed: 0,
  ...overrides,
});

test('Seedance 2.0 contract keeps the Canvas default provider and model', () => {
  assert.equal(SEEDANCE20_PROMPT_ENHANCER_CONTRACT.schema, 't8-seedance20-prompt-enhancer-contract-v1');
  assert.equal(SEEDANCE20_PROMPT_ENHANCER_CONTRACT.defaultProvider, 'seedance-nz');
  assert.equal(SEEDANCE20_DEFAULT_MODEL, 'bytedance/doubao-seed-2.1-pro');
  assert.deepEqual(SEEDANCE20_PROMPT_ENHANCER_CONTRACT.taskIntents, [
    'AUTO', 'T2V', 'I2V', 'FL-I2V', 'MultiRef', 'VideoEdit', 'VideoExtend', 'TrackFill', 'Combined',
  ]);
});

test('Seedance 2.0 validates the task/media matrix and complete-video limits', () => {
  assert.deepEqual(validateSeedance20Input(base({ taskIntent: 'T2V' })), []);
  assert.throws(() => validateSeedance20Input(base({ taskIntent: 'T2V', images: ['image.png'] })), /T2V 不接受素材/);
  assert.equal(validateSeedance20Input(base({ taskIntent: 'I2V', images: ['first.png'] }))[0].role, 'opening frame');
  assert.throws(() => validateSeedance20Input(base({ taskIntent: 'I2V', images: ['a.png', 'b.png'] })), /只能连接 1 张/);
  const fl = validateSeedance20Input(base({ taskIntent: 'FL-I2V', images: ['first.png', 'last.png'] }));
  assert.deepEqual(fl.map((item) => item.role), ['opening frame', 'final frame']);
  assert.throws(() => validateSeedance20Input(base({ taskIntent: 'MultiRef' })), /至少需要/);
  assert.equal(validateSeedance20Input(base({ taskIntent: 'VideoEdit', videos: [video('edit.mp4')] }))[0].role, 'source video to edit');
  assert.throws(() => validateSeedance20Input(base({ taskIntent: 'VideoExtend', videos: [] })), /只能连接 1 个/);
  assert.equal(validateSeedance20Input(base({ taskIntent: 'VideoExtend', videos: [video('extend.mp4')] }))[0].role, 'source video to extend');
  assert.throws(() => validateSeedance20Input(base({ taskIntent: 'TrackFill', videos: [video('one.mp4')] })), /2-3 个/);
  assert.equal(validateSeedance20Input(base({ taskIntent: 'TrackFill', videos: [video('one.mp4'), video('two.mp4')] })).length, 2);
  assert.throws(() => validateSeedance20Input(base({ taskIntent: 'Combined', videos: [video('target.mp4')] })), /至少再连接 1 项/);
  assert.equal(validateSeedance20Input(base({ taskIntent: 'Combined', images: ['style.png'], videos: [video('target.mp4')] })).length, 2);
  assert.throws(() => validateSeedance20Input(base({ taskIntent: 'MultiRef', videos: [video('one.mp4', 8), video('two.mp4', 8)] })), /总时长最多 15 秒/);
});

test('Seedance 2.0 fixed shots use consecutive labels without H3 fields or timestamps', () => {
  const messages = buildSeedance20Messages(base({ taskIntent: 'T2V', complexityMode: 'complex', durationSeconds: 10, shotCount: 20 }));
  const system = String(messages[0].content);
  assert.match(system, /fixed at exactly 20/);
  assert.match(system, /镜头1 through 镜头20/);
  assert.match(system, /Never use MiniMax-H3/);
  assert.doesNotMatch(system, /integrated_multimodal_description:/);
  assert.doesNotMatch(system, /\[Shot 1\] At MM:SS\.mmm/);
  assert.throws(() => validateSeedance20Input(base({ shotCount: 21 })), /镜头数量必须/);
});

test('Seedance 2.0 media labels follow one selected syntax and never claim audio analysis', () => {
  const input = base({
    taskIntent: 'Combined',
    referenceSyntax: 'seedance-nz-en',
    images: ['style.png'],
    videos: [video('target.mp4')],
  });
  const plan = validateSeedance20Input(input);
  assert.deepEqual(plan.map((item) => item.label), ['@Image 1', '@Video 1']);
  const serialized = JSON.stringify(buildSeedance20Messages(input, plan));
  assert.match(serialized, /@Image 1/);
  assert.match(serialized, /@Video 1/);
  assert.doesNotMatch(serialized, /@图片1/);
  assert.match(serialized, /never claim to have heard or analyzed one/i);
});

test('Seedance 2.0 treats length as soft, requires a fusion template, and rejects embedded secrets', () => {
  const messages = buildSeedance20Messages(base({ customLengthTarget: 4000 }));
  assert.match(String(messages[0].content), /soft target of approximately 4000/);
  assert.throws(() => validateSeedance20Input(base({ customLengthTarget: 4001 })), /目标长度必须/);
  assert.throws(() => validateSeedance20Input(base({ promptMode: '参考模板融合' })), /必须填写参考模板/);
  assert.throws(() => validateSeedance20Input(base({ prompt: 'use sk-abcdefghijklmnopqrstuvwxyz123456' })), /疑似 API Key/);
});

test('Canvas schema, UI and backend expose a separate executable Seedance 2.0 node', () => {
  const node = read('src/components/nodes/Seedance20PromptEnhancerNode.tsx');
  const canvas = read('src/components/Canvas.tsx');
  const proxy = read('backend/src/routes/proxy.js');
  const schema = JSON.parse(read('backend/src/shared/canvasNodeSchema.json'));
  assert.match(node, /advancedProvidersForNode\(advancedProviders, 'llm'\)/);
  assert.match(node, /llmVideoMode: 'raw-base64'/);
  assert.match(node, /requestProfile: 'seedance20-prompt-enhancer'/);
  assert.match(node, /不会静默/);
  assert.match(canvas, /'seedance20-prompt-enhancer': Seedance20PromptEnhancerNode/);
  assert.match(proxy, /SEEDANCE20_REQUEST_PROFILE/);
  assert.match(proxy, /noRetry: promptEnhancerProfile/);
  const entry = schema.types.find((item: any) => item.type === 'seedance20-prompt-enhancer');
  assert.equal(entry.executable, true);
  assert.equal(entry.generatable, true);
  assert.deepEqual(entry.ports, { inputs: ['text', 'image', 'video'], outputs: ['text'] });
  assert.equal(entry.generation.defaults.providerModel, 'bytedance/doubao-seed-2.1-pro');
});
