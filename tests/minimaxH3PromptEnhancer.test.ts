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
    shotCount: 0,
    rewriteMode: 'balanced',
    descriptionTarget: 0,
    outputLanguage: '中文',
    promptMode: '官方增强',
    officialSkillProfile: '现有兼容（保留中英文）',
    creativePreset: '无（仅核心规则）',
    images: [],
    videos: [],
    seed: 0,
    ...overrides,
  };
}

test('MiniMax H3 shared contract preserves the reference modes while overriding only the Canvas default model', () => {
  assert.equal(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.schema, 't8-minimax-h3-prompt-enhancer-contract-v1');
  assert.equal(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.sourceReferenceCommit, 'e9c5a225ea05ad94933fa4d26f3fd7ac1f21c1e9');
  assert.equal(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.defaultProvider, 'seedance-nz');
  assert.equal(MINIMAX_H3_DEFAULT_MODEL, 'bytedance/doubao-seed-2.1-pro');
  assert.deepEqual(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.taskTypes, ['T2VA', 'I2VA', 'FL2VA', 'L2VA', 'Ref2VA']);
  assert.deepEqual(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.limits.shotCount, { automatic: 0, minimum: 1, maximum: 20 });
  assert.equal(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.defaults.shotCount, 0);
  assert.equal(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.officialSkillSourceSha, '093f3129a3f7bd27c74928b1cd31a54fbdebe057');
  assert.equal(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.mvPromptSkill.name, 'digital-human-mv-prompting');
  assert.equal(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.mvPromptSkill.skillSha256, '44927bfbc9058ce0b874cd97817743c13d5f4812b2aa570a4620f3840e69ff48');
  assert.equal(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.mvPromptSkill.referenceSha256, '220a1e43a7e9b88fc39a87381bf8aa2b65f238cf3565026c181f8cfff8365963');
  assert.equal(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.mvPromptSkill.audioEvidence, 'text-only-no-audio-analysis');
  assert.deepEqual(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.officialSkillProfiles, [
    '现有兼容（保留中英文）',
    '官方 Skill 严格（全英文协议）',
  ]);
  assert.deepEqual(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.creativePresets, [
    '无（仅核心规则）', 'AUTO（根据意图判断）', '极简产品广告', '3D 动画短片', '品牌宣传短片',
    'MV / 歌词贴字', '双人合作游戏开场', '纸拼贴讲解', '立体纸艺停格讲解', '手绘实拍融合',
  ]);
  assert.equal(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.defaults.officialSkillProfile, '现有兼容（保留中英文）');
  assert.equal(MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.defaults.creativePreset, '无（仅核心规则）');
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
  assert.throws(() => validateMiniMaxH3Input(input({ shotCount: -1 })), /镜头数量必须为自动，或 1-20/);
  assert.throws(() => validateMiniMaxH3Input(input({ shotCount: 21 })), /镜头数量必须为自动，或 1-20/);
  assert.throws(() => validateMiniMaxH3Input(input({ shotCount: 1.5 })), /镜头数量必须为自动，或 1-20/);
  assert.throws(() => validateMiniMaxH3Input(input({ officialSkillProfile: 'future-profile' as any })), /不支持的官方 Skill 协议/);
  assert.throws(() => validateMiniMaxH3Input(input({ creativePreset: 'future-preset' as any })), /不支持的创意预设/);
});

test('shot-count LIST keeps AUTO compatible and sends fixed 1-20 constraints to the LLM', () => {
  const automatic = buildMiniMaxH3Messages(input({ shotCount: 0 }));
  assert.match(String(automatic[0].content), /Shot count mode: AUTO/);
  assert.match(String(automatic[1].content), /Shot count control: AUTO/);

  const fixed = buildMiniMaxH3Messages(input({ shotCount: 12 }));
  assert.match(String(fixed[0].content), /exactly 12 shots/);
  assert.match(String(fixed[0].content), /\[Shot 1\] through \[Shot 12\]/);
  assert.match(String(fixed[0].content), /overrides any approximate shot-count number or range/);
  assert.match(String(fixed[1].content), /Shot count control: exactly 12/);
});

test('official Skill strict profile forces English while the compatibility default preserves Chinese', () => {
  const compatibility = buildMiniMaxH3Messages(input({ descriptionTarget: 200 }));
  assert.match(String(compatibility[0].content), /Official Skill profile: compatibility/);
  assert.match(String(compatibility[0].content), /Output language: Simplified Chinese/);
  assert.match(String(compatibility[1].content), /approximately 200 Chinese characters/);

  const strict = buildMiniMaxH3Messages(input({
    outputLanguage: '中文',
    descriptionTarget: 200,
    officialSkillProfile: '官方 Skill 严格（全英文协议）',
  }));
  assert.match(String(strict[0].content), /strict all-English contract/);
  assert.match(String(strict[0].content), /Output language: English/);
  assert.doesNotMatch(String(strict[0].content), /Output language: Simplified Chinese/);
  assert.match(String(strict[1].content), /Effective descriptive output language: English/);
  assert.match(String(strict[1].content), /approximately 200 English words/);
});

test('official core speaker/reference rules and every creative preset reach the single LLM request', () => {
  const core = String(buildMiniMaxH3Messages(input())[0].content);
  for (const marker of [
    'Simultaneous group speech uses a compact group identifier such as (S1,S2)',
    'place <scenetrans> on both sides of the cut',
    'Never put (S1), (S2), or other speaker identifiers in retention_analysis',
    'ordinary sound embedded in <Video N> does not automatically create an <Audio N> role',
    'newly requested action or background is not by itself evidence',
  ]) assert.match(core, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const expected = new Map([
    ['无（仅核心规则）', ['Creative preset: none', 'only the H3 core contract']],
    ['AUTO（根据意图判断）', ['Creative preset: AUTO', 'Infer at most one']],
    ['极简产品广告', ['minimalist product advertisement', 'one concise single-line text event']],
    ['3D 动画短片', ['3D animation short', 'squash-and-stretch']],
    ['品牌宣传短片', ['brand promotional video', 'never fabricate a capability or claim']],
    ['MV / 歌词贴字', ['music-video and digital-human MV prompting', 'evidence-based rhythm']],
    ['双人合作游戏开场', ['two-player cooperative game intro', 'five main colors']],
    ['纸拼贴讲解', ['paper-collage explainer', 'press-flat']],
    ['立体纸艺停格讲解', ['papercraft stop-motion explainer', 'pull-tabs']],
    ['手绘实拍融合', ['hand-drawn/live-action fusion', 'first 20 percent']],
  ] as const);
  for (const [creativePreset, markers] of expected) {
    const messages = buildMiniMaxH3Messages(input({ creativePreset }));
    for (const marker of markers) assert.match(String(messages[0].content), new RegExp(marker));
    assert.match(String(messages[0].content), /prompt-writing profile only/);
    assert.match(String(messages[1].content), new RegExp(`Creative preset: ${creativePreset}`));
  }
});

test('combined MV Skill preserves lyrics, digital-human identity, local clip time and self-contained continuity', () => {
  const prompt = [
    '数字人暗色抒情 MV，使用肖像保持同一人物。',
    '歌词原文：夜色落在我肩上，别回头。',
    '源歌曲区间：01:04.000-01:19.000。',
    '当前选段作为完整最终音轨，开场承接上一段紧握琥珀光，末帧停在抬眼姿势。',
  ].join('\n');
  const messages = buildMiniMaxH3Messages(input({
    prompt,
    taskType: 'Ref2VA',
    durationSeconds: 15,
    creativePreset: 'MV / 歌词贴字',
    officialSkillProfile: '官方 Skill 严格（全英文协议）',
    referenceContext: '<Picture 1>=数字人身份与外观；<Picture 2>=字体包装，只参考字体、版式和动效。',
    images: ['portrait.png'],
  }));
  const system = String(messages[0].content);
  const user = (messages[1].content as Array<Record<string, any>>).map((part) => part.text || '').join('\n');

  for (const marker of [
    'User-supplied lyrics are the only trusted lyric source',
    'never translate, paraphrase, extend, replace, or invent lyrics',
    'Do not add a singer, lip sync, readable lyrics, or a vocal performance',
    'put <scenetrans> on both sides',
    'foreground, midground, or background graphic layer',
    'never claim beat, BPM, hook, chorus, or audio-file analysis',
    'A character reference controls only',
    'Never copy sample words',
    'portrait-derived digital person as <Subject N>',
    'not as a standalone <Picture N>',
    'A source-song offset such as 01:04.000-01:19.000 is planning metadata',
    'Every H3 shot timestamp stays local from 00:00.000',
    'Audio source range: MM:SS.mmm-MM:SS.mmm',
    '<Audio 1>: fully_copy - <Audio 1> is reused 1:1',
    'This prompt-only node cannot hear, transcribe, trim, upload, or verify an audio attachment',
    'Make every segment self-contained',
    'a usable handoff pose or composition',
    'Fold them naturally into integrated_multimodal_description or Ref2VA detailed_description',
  ]) assert.match(system, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(user, /夜色落在我肩上，别回头。/);
  assert.match(user, /01:04\.000-01:19\.000/);
  assert.match(system, /Output language: English/);
  assert.match(system, /MV request context: H3 task=Ref2VA; duration=15\.00s; AUTO/);
});

test('MV deep module is conditional, AUTO is conservative, and fixed shots outrank templates', () => {
  const plain = String(buildMiniMaxH3Messages(input({ prompt: '产品标题贴字动画' }))[0].content);
  assert.doesNotMatch(plain, /MV Skill — locked lyrics/);

  const autoProduct = String(buildMiniMaxH3Messages(input({
    prompt: '产品标题贴字动画',
    creativePreset: 'AUTO（根据意图判断）',
  }))[0].content);
  assert.match(autoProduct, /no explicit MV intent was found/);
  assert.match(autoProduct, /ordinary product text, captions, titles, UI copy/);
  assert.doesNotMatch(autoProduct, /MV Skill — locked lyrics/);

  const autoMv = String(buildMiniMaxH3Messages(input({
    prompt: '用人物肖像制作数字人 MV，画内对口型演唱',
    creativePreset: 'AUTO（根据意图判断）',
  }))[0].content);
  assert.match(autoMv, /explicit trusted text matches/);
  assert.match(autoMv, /MV Skill — locked lyrics/);
  assert.match(autoMv, /Digital-human MV extension/);

  const fused = String(buildMiniMaxH3Messages(input({
    prompt: '器乐 MV，只使用抽象文字形状，不出现歌手和可读歌词。',
    durationSeconds: 4,
    shotCount: 20,
    rewriteMode: 'creative',
    creativePreset: 'MV / 歌词贴字',
    promptMode: '参考模板融合',
    referenceTemplate: '陌生角色演唱模板歌词，120 BPM，源歌曲 02:00-02:16，固定 8 镜头。',
  }))[0].content);
  assert.match(fused, /Fixed: honor exactly 20 shots/);
  assert.match(fused, /duration=4\.00s/);
  assert.match(fused, /MV rewrite scope: creative/);
  assert.match(fused, /Template people, identities, lyrics, BPM, titles, plot, source range, and shot count remain non-authoritative/);
  assert.match(fused, /Instrumental, pure-typography, montage, and off-screen-vocal MVs remain valid/);
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
  const rangePrefixed = reorderMiniMaxH3OutputFields([
    'Audio source range: 01:04.000-01:19.000',
    'overall_soundscape: cloth movement',
    'subject_definitions: <Subject 1> is the portrait-derived performer.',
    'summary: [reference generation + audio reuse]',
    'retention_analysis: <Subject 1>: fully_preserved',
    'detailed_description: [Shot 1] The performer opens her eyes.',
    'non_diegetic_music: <Audio 1> is directly reused.',
  ].join('\n\n'), 'Ref2VA');
  assert.match(rangePrefixed, /^Audio source range: 01:04\.000-01:19\.000/);
  assert.ok(rangePrefixed.indexOf('subject_definitions:') < rangePrefixed.indexOf('summary:'));
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
  assert.match(node, /<FieldLabel>镜头数量<\/FieldLabel>/);
  assert.match(node, /Array\.from\(\{ length: 20 \}/);
  assert.match(node, /<FieldLabel>官方 Skill 协议<\/FieldLabel>/);
  assert.match(node, /<FieldLabel>官方创意预设<\/FieldLabel>/);
  assert.match(node, /MV_PROMPT_PLACEHOLDER/);
  assert.match(node, /数字人身份、外观与表演/);
  assert.match(node, /源歌曲区间（可空/);
  assert.match(node, /当前节点只写提示词，不读取、转录或裁切音频/);
  assert.match(node, /MV_REFERENCE_PLACEHOLDER/);
  assert.match(node, /MV_CONSTRAINTS_PLACEHOLDER/);
  assert.match(node, /严格协议优先于“输出语言”/);
  assert.match(node, /contract\.creativePresets\.map/);
  assert.match(canvas, /providerModel: 'bytedance\/doubao-seed-2\.1-pro'/);
  assert.match(canvas, /'minimax-h3-prompt-enhancer': \{[\s\S]*shotCount: 0/);
  assert.match(canvas, /officialSkillProfile: '现有兼容（保留中英文）'/);
  assert.match(canvas, /creativePreset: '无（仅核心规则）'/);
  assert.match(proxy, /noRetry: promptEnhancerProfile/);
  assert.match(proxy, /uploadMiniMaxH3MessageMedia/);
  assert.match(read('backend/src/providers/seedanceNz.js'), /normalizeImagePng[\s\S]*ensureSize\(buffer, kind, options\.maxBytes\)/);
  const entry = schema.types.find((item: any) => item.type === 'minimax-h3-prompt-enhancer');
  assert.equal(entry.executable, true);
  assert.equal(entry.generatable, true);
  assert.deepEqual(entry.ports, { inputs: ['text', 'image', 'video'], outputs: ['text'] });
  assert.match(entry.description, /数字人 MV/);
  assert.deepEqual(entry.generation.allowedDataFields.shotCount, { type: 'integer', minimum: 0, maximum: 20 });
  assert.equal(entry.generation.defaults.shotCount, 0);
  assert.deepEqual(entry.generation.allowedDataFields.officialSkillProfile.enum, MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.officialSkillProfiles);
  assert.deepEqual(entry.generation.allowedDataFields.creativePreset.enum, MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.creativePresets);
  assert.equal(entry.generation.defaults.officialSkillProfile, MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.defaults.officialSkillProfile);
  assert.equal(entry.generation.defaults.creativePreset, MINIMAX_H3_PROMPT_ENHANCER_CONTRACT.defaults.creativePreset);
});
