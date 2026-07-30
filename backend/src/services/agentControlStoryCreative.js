const crypto = require('node:crypto');

const STORY_ANALYSIS_SCHEMA = 't8-story-analysis-v1';
const STORY_MIN_SHOT_DURATION_SEC = 4;
const STORY_MAX_SHOT_DURATION_SEC = 15;
const HARD_CONSTRAINT_RE = /(?:不要|不得|禁止|没有|无其他|无其它|只出现|始终|保持|不能|不可|never|without|only|must\s+not)[^。！？\n]*/gi;
const SHOT_HEADING_RE = /^(?:【\s*)?(?:镜头|shot)\s*([一二三四五六七八九十百千万零〇两\d]+)?(?:\s*[｜|:：·-]\s*([^】\n]+))?(?:\s*】)?\s*$/i;
const SCENE_HEADING_RE = /^(?:【\s*)?(?:scene|场景)(?:\s*[一二三四五六七八九十百千万零〇两\d]+)?\s*(?:[｜|:：·-]\s*([^】\n]+?))?(?:\s*】)?$/i;

class AgentControlStoryCreativeError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'AgentControlStoryCreativeError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function text(value, max = 20_000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function stableId(prefix, seed) {
  return `${prefix}-${crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 20)}`;
}

function boundedInt(value, fallback, min, max) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function splitStoryScriptBlocks(scriptInput) {
  const script = String(scriptInput || '').replace(/\r\n?/g, '\n');
  const lines = script.split('\n');
  const blocks = [];
  let offset = 0;
  let blockStart = 0;
  let buffer = [];
  const flush = () => {
    const joined = buffer.join('\n');
    const value = joined.trim();
    if (value) {
      const leading = joined.indexOf(value);
      const start = Math.max(0, blockStart + Math.max(0, leading));
      blocks.push({ start, end: Math.min(script.length, start + value.length), text: value });
    }
    buffer = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    const isHeading = SHOT_HEADING_RE.test(trimmed) || SCENE_HEADING_RE.test(trimmed);
    SHOT_HEADING_RE.lastIndex = 0;
    SCENE_HEADING_RE.lastIndex = 0;
    if (isHeading && buffer.length) flush();
    if (!buffer.length) blockStart = offset;
    buffer.push(line);
    if (!trimmed && buffer.some((item) => item.trim())) flush();
    offset += line.length + 1;
  }
  flush();
  if (!blocks.length && script.trim()) {
    const value = script.trim();
    const start = script.indexOf(value);
    return [{ start, end: start + value.length, text: value }];
  }
  const explicit = blocks.filter((block) => SHOT_HEADING_RE.test(block.text.split('\n')[0]?.trim() || ''));
  SHOT_HEADING_RE.lastIndex = 0;
  return explicit.length ? explicit : blocks;
}

function sceneTitleFromHeading(heading, index) {
  const match = String(heading || '').trim().match(SCENE_HEADING_RE);
  return text(match?.[1], 240) || `场景 ${index + 1}`;
}

function storySceneSections(scriptInput) {
  const script = String(scriptInput || '').replace(/\r\n?/g, '\n');
  const headings = [];
  let offset = 0;
  for (const line of script.split('\n')) {
    const trimmed = line.trim();
    if (SCENE_HEADING_RE.test(trimmed)) {
      headings.push({
        heading: trimmed,
        start: offset + Math.max(0, line.indexOf(trimmed)),
        contentStart: offset + line.length + (offset + line.length < script.length ? 1 : 0),
      });
    }
    offset += line.length + 1;
  }
  if (!headings.length) {
    const description = text(
      script.split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !SHOT_HEADING_RE.test(line))
        .join(' '),
      4_000,
    ) || text(script, 4_000);
    SHOT_HEADING_RE.lastIndex = 0;
    return [{
      id: stableId('scene', '主场景:0'),
      title: '主场景',
      description,
      sourceSpan: { start: 0, end: script.length, text: script },
    }];
  }
  const titleCounts = new Map();
  return headings.map((heading, index) => {
    const end = headings[index + 1]?.start ?? script.length;
    const title = sceneTitleFromHeading(heading.heading, index);
    const occurrence = titleCounts.get(title) || 0;
    titleCounts.set(title, occurrence + 1);
    const sectionText = script.slice(heading.start, end).trim();
    const description = text(
      script.slice(heading.contentStart, end)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !SHOT_HEADING_RE.test(line))
        .join(' '),
      4_000,
    ) || title;
    SHOT_HEADING_RE.lastIndex = 0;
    return {
      id: stableId('scene', `${title}:${occurrence}`),
      title,
      description,
      sourceSpan: {
        start: heading.start,
        end,
        text: sectionText,
      },
    };
  });
}

function hardConstraints(value) {
  HARD_CONSTRAINT_RE.lastIndex = 0;
  return [...new Set(Array.from(String(value || '').matchAll(HARD_CONSTRAINT_RE), (match) => match[0].trim()).filter(Boolean))];
}

function titleFromBlock(block, index) {
  const heading = block.text.split('\n')[0]?.trim() || '';
  const match = heading.match(SHOT_HEADING_RE);
  return text(match?.[2], 240) || (match?.[1] ? `镜头${match[1]}` : `镜头 ${index + 1}`);
}

function fallbackCharacterNames(script) {
  const candidates = Array.from(
    script.matchAll(/(?:^|[。！？\n])\s*([\u4e00-\u9fff]{2,4}?)(?=(?:独自|继续|缓缓|突然|右手|左手|向前|停下|走出|走来|走去|拔出|展开|放低|看向|目光|同时))/g),
    (match) => match[1],
  );
  const explicit = Array.from(
    script.matchAll(/(?:人物|角色)\s*[：:]\s*([\u4e00-\u9fff]{2,4})/g),
    (match) => match[1],
  );
  const blocked = /(?:双方|人物|镜头|画面|空气|电梯|走廊|后巷|场景|[左右]手|门|枪|刀|棍|外套|鞋|头发|嘴唇|垃圾桶)$/;
  return [...new Set([...candidates, ...explicit])].filter((name) => !blocked.test(name)).slice(0, 20);
}

const FALLBACK_PROP_TERMS = ['外套', '手枪', '短刀', '甩棍', '长刀', '匕首', '戒指', '手机', '雨伞', '箱子', '信件', '照片', '钥匙', '面具'];
const FALLBACK_CANONICAL_PROP_NAMES = ['黑色西装外套', '黑色手枪', '战术短刀', '战术甩棍'];

function canonicalPropName(script, term) {
  return FALLBACK_CANONICAL_PROP_NAMES.find((name) => name.endsWith(term) && script.includes(name)) || term;
}

function fallbackProductName(script) {
  const patterns = [
    /(?:产品|商品)\s*[：:]\s*([^，。！？\n]{2,30})/i,
    /为\s*([^，。！？\n]{2,30}?)\s*(?:做|制作|生成|拍)\s*\d*(?:\.\d+)?\s*(?:秒|分钟|分)?[^，。！？\n]{0,16}?(?:tvc|广告|宣传片)/i,
    /\d+(?:\.\d+)?\s*(?:秒|分钟|分)\s*([^，。！？\n]{2,30}?)\s*(?:tvc|广告|宣传片)/i,
  ];
  for (const pattern of patterns) {
    const candidate = text(script.match(pattern)?.[1], 80)
      .replace(/^(?:一款|一个|一把|一件|一种)\s*/, '')
      .trim();
    if (candidate) return candidate;
  }
  return '';
}

function buildLocalStoryAnalysis(project) {
  const script = text(project.script, 200_000).replace(/\r\n?/g, '\n').trim();
  if (!script) throw new AgentControlStoryCreativeError('STORY_SCRIPT_REQUIRED', 'Story 没有可分析的剧本', 409);
  const settings = record(project.settings);
  const blocks = splitStoryScriptBlocks(script);
  const scenes = storySceneSections(script);
  const sceneForOffset = (value) => {
    const offset = Math.max(0, Number(value) || 0);
    return [...scenes].reverse().find((scene) => offset >= Number(scene.sourceSpan?.start || 0))
      || scenes[0];
  };
  const shotSeedCounts = new Map();
  const shots = blocks.slice(0, 200).map((block, index) => {
    const scene = sceneForOffset(block.start);
    const contentLines = block.text.split('\n');
    if (SHOT_HEADING_RE.test(contentLines[0]?.trim() || '')) contentLines.shift();
    SHOT_HEADING_RE.lastIndex = 0;
    const content = contentLines.join('\n').trim() || block.text;
    const seed = `${scene.id}:${titleFromBlock(block, index)}:${block.text}`;
    const occurrence = shotSeedCounts.get(seed) || 0;
    shotSeedCounts.set(seed, occurrence + 1);
    return {
      id: stableId('shot', `${seed}:${occurrence}`),
      sceneId: scene.id,
      title: titleFromBlock(block, index),
      sourceSpan: block,
      sourceText: block.text,
      durationSec: boundedInt(
        Number(settings.targetDurationSec) / Math.max(1, blocks.length),
        6,
        STORY_MIN_SHOT_DURATION_SEC,
        STORY_MAX_SHOT_DURATION_SEC,
      ),
      visualDescription: content,
      action: content,
      dialogue: /(?:对白|台词)\s*[：:]\s*([^。！？\n]+)/.exec(content)?.[1]?.trim() || '',
      voiceover: /(?:旁白|解说)\s*[：:]\s*([^。！？\n]+)/.exec(content)?.[1]?.trim() || '',
      camera: /镜头[^。！？\n]*/.exec(content)?.[0] || '电影镜头，主体动作清晰连贯',
      lighting: /(?:光线|灯光|霓虹|阴影)[^。！？\n]*/.exec(content)?.[0] || '',
      sfx: /(?:声音|声|警笛|雨声|脚步)[^。！？\n]*/.exec(content)?.[0] || '',
      mustInclude: [],
      mustNotInclude: hardConstraints(content),
      entityRefs: [],
      assetIds: [],
    };
  });
  const visualStyle = text(settings.visualStyle, 4_000) || '电影感写实，高质量统一美术风格';
  const assets = [];
  if (settings.recipe === 'tvc') {
    const productName = fallbackProductName(script);
    if (productName) {
      assets.push({
        id: stableId('asset-prop', `product:${productName}`),
        kind: 'prop',
        name: productName,
        description: `${productName}的稳定产品母版，外形、结构、材质、颜色、标识与关键卖点在所有镜头保持一致`,
        prompt: `${productName}商业产品设定图，中性干净背景，完整主体、正侧背视图和关键材质细节，外形与标识清晰，不出现无关人物`,
        negativePrompt: '产品变形，结构错误，标识错误，多余产品，人物遮挡，文字乱码，水印',
      });
    }
  }
  fallbackCharacterNames(script).forEach((name, index) => assets.push({
    id: stableId('asset-character', `${name}:${index}`),
    kind: 'character',
    name,
    description: `${name}的稳定角色设定，保持面部、发型、体型和身份连续`,
    prompt: `${name}角色身份设定图，纯白横版背景，左侧一个清晰脸部特写，右侧同一人物正面、侧面、背面全身三视图，不出现环境和额外人物`,
    negativePrompt: '环境，额外人物，不同身份，脸部不一致，文字，水印',
  }));
  scenes.forEach((scene) => assets.push({
    id: stableId('asset-scene', scene.id),
    kind: 'scene',
    sceneId: scene.id,
    name: scene.title,
    description: scene.description,
    prompt: `${scene.title}场景设定图，${scene.description}，无人环境全景，空间方向、出入口和关键地标清晰，${visualStyle}`,
    negativePrompt: '人物，人群，文字，水印',
  }));
  [...new Set(FALLBACK_PROP_TERMS.filter((term) => script.includes(term)).map((term) => canonicalPropName(script, term)))]
    .forEach((name, index) => {
      const costume = name.includes('外套') || name.includes('服装') || name.includes('裙') || name.includes('西装');
      assets.push({
        id: stableId(costume ? 'asset-costume' : 'asset-prop', `${name}:${index}`),
        kind: costume ? 'costume' : 'prop',
        name,
        description: `剧本中的${name}，外观在所有镜头保持一致`,
        prompt: costume
          ? `${name}纯服装设定图，纯白横版背景，仅展示服装本体的正面、背面和材质细节，不出现人物、人体、衣架或环境`
          : `${name}道具设定图，完整外观，电影级材质，中性背景，不出现人物或手`,
        negativePrompt: costume
          ? '人物，脸，头，手，人体，模特，衣架，房间，街道，文字，水印'
          : '人物，手，环境，文字，水印',
      });
    });
  const retainedAudioAssets = (Array.isArray(project.assets) ? project.assets : [])
    .filter((asset) => asset?.kind === 'audio' && (asset?.url || asset?.locked))
    .map((asset) => ({
      ...clone(asset),
      id: text(asset.id, 160) || stableId('asset-audio', asset.sourceAssetId || asset.name),
      kind: 'audio',
      name: text(asset.name, 240) || '参考音频',
      description: text(asset.description, 12_000) || '创作者选择的持久音频素材',
      requiredByShotIds: [],
    }));
  assets.push(...retainedAudioAssets);
  for (const shot of shots) {
    shot.assetIds = assets
      .filter((asset) => {
        const aliases = asset.name.split(/[\/／|、]/).map((item) => item.trim()).filter(Boolean);
        return shot.sourceSpan.text.includes(asset.name)
          || aliases.some((alias) => shot.sourceSpan.text.includes(alias))
          || (asset.kind === 'scene' && shot.sceneId === asset.sceneId)
          || (settings.recipe === 'mv' && asset.kind === 'audio');
      })
      .map((asset) => asset.id);
  }
  for (const asset of assets) {
    asset.requiredByShotIds = shots.filter((shot) => shot.assetIds.includes(asset.id)).map((shot) => shot.id);
  }
  const audioPlan = buildStoryAudioPlan(shots, settings);
  if (settings.recipe === 'mv') {
    for (const asset of retainedAudioAssets) {
      audioPlan.items.unshift({
        id: stableId('story-audio', `${asset.id}:music-bed`),
        shotId: '',
        role: 'music',
        prompt: '按已绑定主音乐分析段落、节拍、重音、情绪与转场点；不替换或重新生成原音乐。',
        provider: 'project-assets',
        model: 'source-audio',
        requires: [],
        outputFormat: 'source',
        sampleRate: 0,
        source: 'existing',
        status: 'succeeded',
        sourceAssetId: text(asset.sourceAssetId, 160),
        resultAssetId: text(asset.sourceAssetId, 160),
        locked: true,
        licenseStatus: 'unknown',
        licenseNote: '创作者必须确认上传歌曲或音频的使用授权。',
      });
    }
    audioPlan.status = retainedAudioAssets.length ? 'planned-with-source' : audioPlan.status;
    audioPlan.mix.roles = unique(audioPlan.items.map((item) => item.role));
  }
  return {
    schema: STORY_ANALYSIS_SCHEMA,
    title: script.match(/《([^》]+)》/)?.[1] || project.title || '未命名故事',
    styleBible: visualStyle,
    scenes,
    shots,
    assets,
    audioPlan,
    analysisSource: 'local-fallback',
  };
}

function audioRoleForSfx(value) {
  return /(?:环境|氛围|雨声|风声|街道|人群|水声|虫鸣|海浪|ambien)/i.test(String(value || ''))
    ? 'ambience'
    : 'sfx';
}

function buildStoryAudioPlan(shots, settings = {}) {
  const config = record(settings);
  const soundProvider = text(config.audioProviderId || config.audioProviderSource, 160) || 'zhenzhen';
  const soundModel = text(config.audioProviderModel || config.audioModel, 240) || 'doubao-seed-audio-1.0';
  const outputFormat = ['wav', 'mp3', 'pcm', 'ogg_opus', 'opus'].includes(String(config.audioOutputFormat))
    ? String(config.audioOutputFormat)
    : 'wav';
  const sampleRate = boundedInt(config.audioSampleRate, 24_000, 8_000, 44_100);
  const items = [];
  for (const shot of shots) {
    const entries = [
      ['dialogue', shot.dialogue],
      ['voiceover', shot.voiceover],
      [audioRoleForSfx(shot.sfx), shot.sfx],
    ];
    for (const [role, content] of entries) {
      const prompt = text(content, 4_000);
      if (!prompt) continue;
      const isSpeech = role === 'dialogue' || role === 'voiceover';
      items.push({
        id: stableId('story-audio', `${shot.id}:${role}:${prompt}`),
        shotId: shot.id,
        role,
        prompt,
        provider: isSpeech ? 'grok-oauth' : soundProvider,
        model: isSpeech ? 'xai-tts' : soundModel,
        requires: isSpeech ? ['grok-oauth-login'] : [],
        outputFormat,
        sampleRate,
        source: 'planned',
        status: 'pending',
        sourceAssetId: '',
        resultAssetId: '',
        locked: false,
        licenseStatus: 'unknown',
        licenseNote: '生成模型条款或上传素材许可必须由创作者确认，Agent 不做推断。',
      });
    }
  }
  return {
    schema: 't8-story-audio-plan-v1',
    status: items.length ? 'planned' : 'not-required',
    items,
    mix: {
      strategy: 'per-shot-layered',
      roles: unique(items.map((item) => item.role)),
      requiresCreatorReview: true,
      instructions: '对白/旁白、环境声和音效分轨保留；成片前由创作者确认响度、淡入淡出和静音镜头。',
    },
    lipSync: {
      supported: true,
      provider: 'fal',
      model: 'creatify-aurora-fal',
      requiredAssetKinds: ['image', 'audio'],
      requiresRunApproval: true,
      message: '对白镜头可用已确认人物图与对应音频规划 Creatify Aurora 对口型；分析阶段不会自动提交。',
    },
  };
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function nodeData(node) {
  return record(node?.data);
}

function requireNode(document, nodeId, types = []) {
  const node = (document.nodes || []).find((item) => String(item.id) === String(nodeId || ''));
  if (!node) throw new AgentControlStoryCreativeError('STORY_NODE_NOT_FOUND', '找不到目标 Story 或候选节点', 404);
  if (types.length && !types.includes(String(node.type || ''))) {
    throw new AgentControlStoryCreativeError('STORY_NODE_TYPE_INVALID', `节点 ${node.id} 类型不适用于此 Story 操作`, 409);
  }
  return node;
}

function storyContext(document, input) {
  const node = requireNode(document, input.storyId || input.story || input.nodeId, ['story']);
  const project = clone(record(nodeData(node).storyProject));
  project.storyId = text(project.storyId, 160) || stableId('story', node.id);
  project.storyRevision = Math.max(1, Number(project.storyRevision) || 1);
  project.productionRevision = Math.max(0, Number(project.productionRevision) || 0);
  project.script = text(project.script || nodeData(node).script, 200_000);
  project.title = text(project.title || nodeData(node).title, 240) || '未命名 Story';
  project.settings = record(project.settings);
  project.scenes = Array.isArray(project.scenes) ? project.scenes : [];
  project.shots = Array.isArray(project.shots) ? project.shots : [];
  project.assets = Array.isArray(project.assets) ? project.assets : [];
  project.audioPlan = record(project.audioPlan);
  project.stages = record(project.stages);
  project.coverage = record(project.coverage);
  return { node, project };
}

function nodePatch(nodeId, dataPatch) {
  return { type: 'node.patch', payload: { nodeId, dataPatch } };
}

function nodeAdd(id, type, x, y, data) {
  return { type: 'node.add', payload: { node: { id, type, position: { x, y }, data } } };
}

function edgeAdd(id, source, target) {
  return { type: 'edge.add', payload: { edge: { id, source, target, sourceHandle: null, targetHandle: null } } };
}

function patch(document, planId, summary, operations) {
  return {
    schema: 't8-canvas-patch-v1',
    id: stableId('creative-patch', planId),
    baseRevision: Number(document.revision),
    summary,
    diagnosticsResolved: [],
    requiresConfirmation: true,
    operations,
  };
}

function originFor(document) {
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  return {
    x: nodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0) + 460,
    y: nodes.reduce((min, node) => Math.min(min, Number(node?.position?.y) || 0), 0),
  };
}

function sourceSpan(value, script, fallback = '') {
  const raw = record(value);
  const spanText = text(raw.text || fallback);
  let start = Number.isInteger(Number(raw.start)) ? Number(raw.start) : -1;
  let end = Number.isInteger(Number(raw.end)) ? Number(raw.end) : -1;
  if ((start < 0 || end <= start) && spanText) {
    start = script.indexOf(spanText);
    end = start >= 0 ? start + spanText.length : -1;
  }
  if (start < 0 || end <= start || end > script.length) return { start: 0, end: 0, text: spanText };
  return { start, end, text: spanText || script.slice(start, end) };
}

function normalizeAsset(value, index, previous = null) {
  const raw = record(value);
  const allowed = new Set(['character', 'scene', 'prop', 'costume', 'audio']);
  const kind = allowed.has(String(raw.kind)) ? String(raw.kind) : 'prop';
  const name = text(raw.name, 240)
    || `${kind === 'character' ? '角色' : kind === 'scene' ? '场景' : kind === 'costume' ? '服装' : kind === 'audio' ? '声音' : '道具'} ${index + 1}`;
  return {
    id: previous && (previous.locked || previous.url)
      ? text(previous.id, 160)
      : text(raw.id, 160) || stableId(`asset-${kind}`, `${name}:${raw.description || ''}:${index}`),
    kind,
    sceneId: text(raw.sceneId, 160),
    name,
    description: text(raw.description, 12_000),
    prompt: text(raw.prompt) || [name, text(raw.description, 12_000)].filter(Boolean).join('，'),
    negativePrompt: text(raw.negativePrompt, 8_000),
    requiredByShotIds: unique(raw.requiredByShotIds),
    source: previous?.url ? text(previous.source, 40) || 'existing' : 'missing',
    status: previous?.url ? 'succeeded' : 'pending',
    url: text(previous?.url, 2_000),
    taskId: text(previous?.taskId, 240),
    taskProvider: text(previous?.taskProvider, 160),
    taskModel: text(previous?.taskModel, 240),
    taskEndpoint: text(previous?.taskEndpoint, 500),
    taskClipIds: unique(previous?.taskClipIds),
    error: '',
    locked: previous?.locked === true || raw.locked === true,
    revision: Math.max(1, Number(previous?.revision) || Number(raw.revision) || 1),
    generatedAt: text(previous?.generatedAt, 80),
    sourceAssetId: text(previous?.sourceAssetId || raw.sourceAssetId, 160),
    sourceAssetRevision: Math.max(
      0,
      Number(previous?.sourceAssetRevision) || Number(raw.sourceAssetRevision) || 0,
    ),
  };
}

function normalizeShot(value, script, index, previous = null) {
  const raw = record(value);
  const sourceText = text(raw.sourceText || raw.visualDescription);
  const id = text(raw.id, 160) || stableId('shot', `${raw.title || ''}:${sourceText}:${index}`);
  const next = {
    id,
    sceneId: text(raw.sceneId, 160),
    title: text(raw.title, 240) || `镜头 ${index + 1}`,
    sourceSpan: sourceSpan(raw.sourceSpan, script, sourceText),
    durationSec: Math.max(1, Math.min(15, Math.trunc(Number(raw.durationSec) || 6))),
    visualDescription: text(raw.visualDescription || sourceText),
    action: text(raw.action, 8_000),
    dialogue: text(raw.dialogue, 8_000),
    voiceover: text(raw.voiceover, 8_000),
    sfx: text(raw.sfx, 4_000),
    camera: text(raw.camera, 4_000) || '稳定电影镜头，主体清晰',
    lighting: text(raw.lighting, 4_000),
    mustInclude: unique(raw.mustInclude),
    mustNotInclude: unique(raw.mustNotInclude),
    entityRefs: unique(raw.entityRefs),
    assetIds: unique(raw.assetIds),
    finalPrompt: text(raw.finalPrompt, 30_000),
    negativePrompt: text(raw.negativePrompt, 12_000),
    status: 'pending',
    videoUrl: '',
    taskId: '',
    taskProvider: '',
    taskModel: '',
    error: '',
    lockedFields: unique(previous?.lockedFields || raw.lockedFields),
    revision: Math.max(1, Number(previous?.revision) || Number(raw.revision) || 1),
  };
  if (!previous) return next;
  const comparable = (shot) => ({
    sceneId: shot.sceneId,
    title: shot.title,
    sourceSpan: shot.sourceSpan,
    durationSec: shot.durationSec,
    visualDescription: shot.visualDescription,
    action: shot.action,
    dialogue: shot.dialogue,
    voiceover: shot.voiceover,
    sfx: shot.sfx,
    camera: shot.camera,
    lighting: shot.lighting,
    mustInclude: shot.mustInclude,
    mustNotInclude: shot.mustNotInclude,
    entityRefs: shot.entityRefs,
    assetIds: shot.assetIds,
  });
  next.lockedFields.forEach((key) => {
    if (Object.hasOwn(next, key) && Object.hasOwn(previous, key)) next[key] = clone(previous[key]);
  });
  const derivedPromptChanged = (
    (Object.hasOwn(raw, 'finalPrompt') && String(previous.finalPrompt || '') !== String(next.finalPrompt || ''))
    || (Object.hasOwn(raw, 'negativePrompt') && String(previous.negativePrompt || '') !== String(next.negativePrompt || ''))
  );
  if (JSON.stringify(comparable(previous)) === JSON.stringify(comparable(next)) && !derivedPromptChanged) {
    if (!Object.hasOwn(raw, 'finalPrompt')) next.finalPrompt = clone(previous.finalPrompt) || '';
    if (!Object.hasOwn(raw, 'negativePrompt')) next.negativePrompt = clone(previous.negativePrompt) || '';
    for (const key of ['status', 'videoUrl', 'taskId', 'taskProvider', 'taskModel', 'error']) {
      next[key] = clone(previous[key]) || next[key];
    }
  } else {
    next.revision += 1;
  }
  return next;
}

function coverage(script, shots) {
  const spans = shots
    .map((shot) => shot.sourceSpan)
    .filter((span) => Number(span?.end) > Number(span?.start))
    .map((span) => [Math.max(0, Number(span.start)), Math.min(script.length, Number(span.end))])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of spans) {
    const last = merged.at(-1);
    if (!last || start > last[1]) merged.push([start, end]);
    else last[1] = Math.max(last[1], end);
  }
  const covered = merged.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0);
  const percent = script.length ? Math.min(100, Math.round((covered / script.length) * 100)) : 0;
  return {
    coveredBlocks: spans.length,
    totalBlocks: shots.length,
    percent,
    uncovered: [],
    hardConstraintLosses: [],
    continuityIssues: [],
    ready: shots.length > 0 && percent >= 90,
  };
}

function refresh(project) {
  const now = new Date().toISOString();
  const assetDone = project.assets.filter((asset) => asset.status === 'succeeded' && asset.url).length;
  const promptDone = project.shots.filter((shot) => shot.finalPrompt).length;
  const videoDone = project.shots.filter((shot) => shot.status === 'succeeded' && shot.videoUrl).length;
  const stage = text(project.stage, 40) || 'shots';
  const state = (done, total, active, message) => ({
    status: total && done >= total ? 'succeeded' : active ? 'running' : total ? 'pending' : 'idle',
    completed: done,
    total,
    message: total && done >= total ? message : `${done}/${total}`,
    updatedAt: now,
  });
  return {
    ...project,
    stages: {
      script: state(project.script ? 1 : 0, 1, stage === 'script', '剧本已录入'),
      shots: state(project.coverage?.ready ? project.shots.length : 0, project.shots.length, stage === 'shots', '分镜已确认'),
      assets: state(assetDone, project.assets.length, stage === 'assets', '资产已齐备'),
      prompts: state(promptDone, project.shots.length, stage === 'prompts', '提示词已编译'),
      videos: state(videoDone, project.shots.length, stage === 'videos', '视频已生成'),
      compose: state(project.finalVideoUrl ? 1 : 0, 1, stage === 'compose', '成片已输出'),
    },
    updatedAt: now,
  };
}

function mergeAnalysisIntoProject(project, payloadInput, options = {}) {
  const payload = record(payloadInput);
  if (!Array.isArray(payload.shots) || !payload.shots.length) {
    throw new AgentControlStoryCreativeError('STORY_IMPORT_SHOTS_REQUIRED', 'Story 导入文件至少需要一个 shots 项');
  }
  if (payload.shots.length > 200 || (Array.isArray(payload.assets) && payload.assets.length > 500)) {
    throw new AgentControlStoryCreativeError('STORY_IMPORT_LIMIT_EXCEEDED', '单次最多导入 200 个镜头和 500 个资产', 413);
  }
  const priorShots = new Map(project.shots.map((shot) => [String(shot.id), shot]));
  const priorAssets = new Map(project.assets.map((asset) => [String(asset.id), asset]));
  const priorAssetsByKey = new Map(project.assets.map((asset) => [
    `${String(asset.kind || '')}:${String(asset.name || '').trim().toLowerCase()}`,
    asset,
  ]));
  const importedAssets = (Array.isArray(payload.assets) ? payload.assets : [])
    .map((asset, index) => {
      const previous = priorAssets.get(String(asset?.id || ''))
        || priorAssetsByKey.get(`${String(asset?.kind || '')}:${String(asset?.name || '').trim().toLowerCase()}`);
      return normalizeAsset(asset, index, previous);
    });
  const importedIds = new Set(importedAssets.map((asset) => asset.id));
  const assets = [
    ...importedAssets,
    ...clone(project.assets.filter((asset) => !importedIds.has(String(asset.id)) && (asset.locked || asset.url))),
  ];
  const validAssetIds = new Set(assets.map((asset) => String(asset.id)));
  const shots = payload.shots.map((shot, index) => {
    const item = normalizeShot(shot, project.script, index, priorShots.get(String(shot?.id || '')));
    item.assetIds = item.assetIds.filter((assetId) => validAssetIds.has(assetId));
    return item;
  });
  const shotIds = new Set(shots.map((shot) => shot.id));
  for (const asset of assets) {
    asset.requiredByShotIds = unique([
      ...asset.requiredByShotIds.filter((shotId) => shotIds.has(shotId)),
      ...shots.filter((shot) => shot.assetIds.includes(asset.id)).map((shot) => shot.id),
    ]);
  }
  const scenes = (Array.isArray(payload.scenes) ? payload.scenes : []).slice(0, 100).map((scene, index) => {
    const raw = record(scene);
    const description = text(raw.description || raw.sourceText);
    return {
      id: text(raw.id, 160) || stableId('scene', `${raw.title || ''}:${description}:${index}`),
      title: text(raw.title, 240) || `场景 ${index + 1}`,
      description,
      sourceSpan: sourceSpan(raw.sourceSpan, project.script, text(raw.sourceText || description)),
    };
  });
  let next = {
    ...project,
    title: text(payload.title, 240) || project.title,
    styleBible: text(payload.styleBible, 12_000) || project.styleBible,
    scenes,
    shots,
    assets,
    audioPlan: record(payload.audioPlan).schema === 't8-story-audio-plan-v1'
      ? clone(payload.audioPlan)
      : buildStoryAudioPlan(shots, project.settings),
    stage: 'shots',
    storyRevision: Math.max(1, Number(project.storyRevision) || 1)
      + (options.incrementRevisions === false ? 0 : 1),
    productionRevision: Math.max(0, Number(project.productionRevision) || 0)
      + (options.incrementRevisions === false ? 0 : 1),
    analysisSource: text(payload.analysisSource, 40) === 'llm' ? 'llm' : 'local-fallback',
    finalVideoUrl: '',
    composeTaskId: '',
    composeTaskStatus: 'idle',
    lastError: '',
  };
  next.coverage = coverage(project.script, shots);
  next = refresh(next);
  return next;
}

function initializeStoryProject(project) {
  return mergeAnalysisIntoProject(
    project,
    buildLocalStoryAnalysis(project),
    { incrementRevisions: false },
  );
}

function importPatch(document, planId, input) {
  const { node, project } = storyContext(document, input);
  const next = mergeAnalysisIntoProject(project, input.payload);
  return patch(document, planId, `导入 ${next.shots.length} 个镜头与 ${next.assets.length} 个资产计划`, [
    nodePatch(node.id, { storyProject: next }),
  ]);
}

function analyzePatch(document, planId, input) {
  const { project } = storyContext(document, input);
  const payload = buildLocalStoryAnalysis(project);
  return importPatch(document, planId, { ...input, payload });
}

function bindAssetPatch(document, database, planId, input) {
  const { node, project } = storyContext(document, input);
  const storyAssetId = text(input.to || input.storyAssetId, 160);
  const assetId = text(input.assetId || input.asset, 160);
  const source = database?.getAsset?.(assetId);
  if (!source || String(source.projectId || '') !== String(document.projectId || '')) {
    throw new AgentControlStoryCreativeError('STORY_BIND_ASSET_NOT_FOUND', '项目资产不存在或不属于当前项目', 404);
  }
  const index = project.assets.findIndex((asset) => String(asset.id) === storyAssetId);
  if (index < 0) throw new AgentControlStoryCreativeError('STORY_ASSET_NOT_FOUND', 'Story 中找不到要绑定的资产', 404);
  const target = project.assets[index];
  const expectsAudio = target.kind === 'audio';
  if ((expectsAudio && source.kind !== 'audio') || (!expectsAudio && source.kind !== 'image')) {
    throw new AgentControlStoryCreativeError(
      'STORY_BIND_ASSET_KIND_INVALID',
      expectsAudio ? '声音资产只能绑定音频素材' : '角色、场景、道具和服装只能绑定图片素材',
      409,
    );
  }
  const affected = new Set(target.requiredByShotIds || []);
  const nextAsset = {
    ...target,
    source: 'existing',
    status: 'succeeded',
    url: `/api/project-assets/${encodeURIComponent(assetId)}/media`,
    taskId: '',
    taskProvider: 'project-assets',
    taskModel: '',
    taskEndpoint: '',
    error: '',
    locked: true,
    revision: Math.max(1, Number(target.revision) || 1) + 1,
    generatedAt: new Date().toISOString(),
    sourceAssetId: assetId,
    sourceAssetRevision: Math.max(1, Number(source.contentRevision || source.revision) || 1),
  };
  let next = {
    ...project,
    assets: project.assets.map((asset, assetIndex) => assetIndex === index ? nextAsset : asset),
    shots: project.shots.map((shot) => affected.has(String(shot.id))
      ? {
        ...shot,
        videoUrl: '',
        taskId: '',
        taskProvider: '',
        taskModel: '',
        status: 'pending',
        error: '',
        revision: Math.max(1, Number(shot.revision) || 1) + 1,
      }
      : shot),
    stage: 'assets',
    storyRevision: project.storyRevision + 1,
    productionRevision: project.productionRevision + 1,
    finalVideoUrl: '',
    composeTaskId: '',
    composeTaskStatus: 'idle',
  };
  next = refresh(next);
  return patch(document, planId, `绑定项目素材到 Story 资产“${target.name || storyAssetId}”`, [
    nodePatch(node.id, { storyProject: next }),
  ]);
}

function shotPrompt(project, shot) {
  const assets = (shot.assetIds || [])
    .map((assetId) => project.assets.find((asset) => String(asset.id) === String(assetId)))
    .filter(Boolean);
  return [
    project.styleBible || project.settings?.visualStyle,
    assets.length ? `稳定身份与资产：${assets.map((asset) => `${asset.kind}:${asset.name}=${asset.description}`).join('；')}` : '',
    `本镜头画面：${shot.visualDescription || ''}`,
    shot.action ? `动作：${shot.action}` : '',
    shot.camera ? `景别与运镜：${shot.camera}` : '',
    shot.lighting ? `光线氛围：${shot.lighting}` : '',
    shot.dialogue ? `台词：${shot.dialogue}` : '',
    shot.voiceover ? `旁白：${shot.voiceover}` : '',
    shot.sfx ? `声音：${shot.sfx}` : '',
    shot.mustInclude?.length ? `必须出现：${shot.mustInclude.join('；')}` : '',
    shot.mustNotInclude?.length ? `严格禁止：${shot.mustNotInclude.join('；')}` : '',
    `保持人物身份、服装、道具、空间方向与前后镜头连续。${project.settings?.aspectRatio || '16:9'}，${shot.durationSec || 6}秒。`,
  ].filter(Boolean).join('\n');
}

function compilePatch(document, planId, input) {
  const { node, project } = storyContext(document, input);
  if (!project.shots.length) throw new AgentControlStoryCreativeError('STORY_SHOTS_REQUIRED', 'Story 还没有镜头，请先导入或确认分镜', 409);
  const targets = new Set(unique(String(input.shotIds || input.shot || '').split(',')));
  const all = !targets.size;
  const shots = project.shots.map((shot) => {
    if (!all && !targets.has(String(shot.id))) return shot;
    const locked = new Set(shot.lockedFields || []);
    return {
      ...shot,
      finalPrompt: locked.has('finalPrompt') && shot.finalPrompt ? shot.finalPrompt : shotPrompt(project, shot),
      negativePrompt: locked.has('negativePrompt') && shot.negativePrompt
        ? shot.negativePrompt
        : unique([...(shot.mustNotInclude || []), '身份漂移', '服装突变', '道具消失', '多余人物', '肢体畸形', '文字水印', '镜头抖动']).join('，'),
      status: shot.videoUrl ? 'succeeded' : 'pending',
      error: '',
      revision: Math.max(1, Number(shot.revision) || 1) + 1,
    };
  });
  const next = refresh({
    ...project,
    shots,
    stage: 'prompts',
    storyRevision: project.storyRevision + 1,
    productionRevision: project.productionRevision + 1,
  });
  return patch(document, planId, `编译 ${all ? shots.length : targets.size} 个镜头提示词`, [
    nodePatch(node.id, { storyProject: next }),
  ]);
}

function safeUrl(value) {
  const url = text(value, 2_000);
  return /^(?:https?:\/\/|\/(?:api|files|input|output)\/)/i.test(url) ? url : '';
}

function adoptionEvidenceDigest(data, url) {
  const evidence = {
    assetId: text(data.outputAssetId || data.assetId, 160) || null,
    contentHash: text(data.contentHash, 200) || null,
    url,
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(evidence))
    .digest('hex');
}

function previewPatch(document, planId, input) {
  const { node, project } = storyContext(document, input);
  const requested = new Set(unique(String(input.shotIds || input.shot || '').split(',')));
  const shots = requested.size
    ? project.shots.filter((shot) => requested.has(String(shot.id)))
    : project.shots.slice(0, 3);
  if (!shots.length) throw new AgentControlStoryCreativeError('STORY_PREVIEW_SHOTS_REQUIRED', '没有可预览镜头，请先导入分镜或提供有效 --shot', 409);
  const origin = originFor(document);
  const outputId = stableId('output', `${planId}:story-previews`);
  const operations = [];
  const productionBinding = record(nodeData(node).creatorProductionBinding);
  const shotBindings = Array.isArray(productionBinding.shotBindings)
    ? productionBinding.shotBindings : [];
  const previewIds = [];
  shots.forEach((shot, index) => {
    const refs = (shot.assetIds || [])
      .map((assetId) => project.assets.find((asset) => String(asset.id) === String(assetId)))
      .filter((asset) => asset && asset.kind !== 'audio' && safeUrl(asset.url));
    const imageId = stableId('image', `${planId}:${shot.id}`);
    const locks = {
      identity: refs.some((asset) => asset.kind === 'character'),
      wardrobe: refs.some((asset) => asset.kind === 'costume'),
      background: false,
      prompt: false,
    };
    const shotBinding = shotBindings.find((item) => (
      text(item?.storyShotId, 160) === text(shot.id, 160)
    ));
    operations.push(nodeAdd(imageId, 'image', origin.x + index * 440, origin.y, {
      model: 'gpt-image-2',
      apiModel: project.settings?.imageModel || 'zhenzhen-image-g2-t2i',
      providerSource: project.settings?.imageProviderSource || 'zhenzhen',
      providerId: project.settings?.imageProviderId || '',
      providerModel: project.settings?.imageProviderId ? project.settings?.imageProviderModel : '',
      aspectRatio: project.settings?.aspectRatio || '16:9',
      sizeLevel: '1K',
      gptImageQuality: 'auto',
      gptImageModeration: 'auto',
      referenceImages: refs.map((asset) => asset.url),
      referenceBindings: refs.map((asset) => ({
        id: asset.id,
        sourceType: 'story-asset',
        storyId: project.storyId,
        storyAssetId: asset.id,
        revision: Math.max(1, Number(asset.revision) || 1),
      })),
      prompt: shot.finalPrompt || shotPrompt(project, shot),
      title: `${shot.title || `镜头 ${index + 1}`} · 低成本预览`,
      candidateLabel: shot.title || `镜头 ${index + 1}`,
      storyId: project.storyId,
      storyNodeId: node.id,
      storyShotId: shot.id,
      ...(shotBinding ? {
        creatorProductionBinding: {
          schema: 't8-creator-production-binding-v1',
          promptPackDocumentId: text(productionBinding.promptPackDocumentId, 160),
          promptPackVersionId: text(productionBinding.promptPackVersionId, 160),
          promptPackContentDigest: text(productionBinding.promptPackContentDigest, 64),
          ...clone(shotBinding),
        },
      } : {}),
      imageOnlyOutput: true,
      reuseResult: false,
      creativeState: {
        schema: 't8-creative-state-v1',
        groupId: stableId('story-preview-group', `${project.storyId}:${shot.id}`),
        candidateId: stableId('candidate', `${planId}:${shot.id}`),
        candidateIndex: 1,
        candidateCount: 1,
        profile: 'economy',
        template: 'keyframe',
        accepted: false,
        activeBranchId: 'main',
        locks,
        versions: [],
        branches: [{ id: 'main', label: '主版本', parentId: '', createdAt: new Date().toISOString() }],
        brief: { kind: 'image', goal: shot.finalPrompt || shot.visualDescription, profile: 'economy', template: 'keyframe' },
      },
    }));
    previewIds.push(imageId);
  });
  operations.push(nodeAdd(outputId, 'output', origin.x, origin.y + 600, {
    title: `${project.title} · ${shots.length} 镜低成本预览`,
    storyId: project.storyId,
    storyNodeId: node.id,
  }));
  previewIds.forEach((imageId) => {
    operations.push(edgeAdd(stableId('edge', `${imageId}:${outputId}`), imageId, outputId));
  });
  return patch(document, planId, `为 ${shots.length} 个不同镜头创建 1K 预览节点`, operations);
}

function adoptPreviewPatch(document, planId, input) {
  const { node, project } = storyContext(document, input);
  const shotId = text(input.shotId || input.shot, 160);
  const candidate = requireNode(document, input.candidateId || input.candidate, ['image']);
  const candidateData = nodeData(candidate);
  const candidateState = record(candidateData.creativeState);
  if (candidateState.accepted !== true) {
    throw new AgentControlStoryCreativeError('STORY_PREVIEW_NOT_ACCEPTED', '关键帧候选尚未采用，请先比较并执行 iterate accept', 409);
  }
  const url = safeUrl(candidateData.imageUrl || candidateData.imageUrls?.[0]);
  if (!url) throw new AgentControlStoryCreativeError('STORY_PREVIEW_RESULT_MISSING', '已采用关键帧没有可复用的持久化图片', 409);
  const acceptance = record(candidateState.acceptance);
  const receiptValid = (
    acceptance.schema === 't8-creative-adoption-receipt-v1'
    && text(acceptance.nodeId, 160) === text(candidate.id, 160)
    && text(acceptance.candidateId, 160) === text(candidateState.candidateId, 160)
    && /^[a-f0-9]{64}$/.test(text(acceptance.reviewDigest, 64).toLowerCase())
    && text(acceptance.evidenceDigest, 64).toLowerCase() === adoptionEvidenceDigest(candidateData, url)
  );
  if (!receiptValid) {
    throw new AgentControlStoryCreativeError(
      'STORY_PREVIEW_ADOPTION_RECEIPT_REQUIRED',
      '当前关键帧只有旧采用状态，缺少与这张图片一致的真实评审回执；请重新检查作品并执行采用。',
      409,
    );
  }
  const shotIndex = project.shots.findIndex((shot) => String(shot.id) === shotId);
  if (shotIndex < 0) throw new AgentControlStoryCreativeError('STORY_SHOT_NOT_FOUND', 'Story 中找不到目标镜头', 404);
  const previewAssetId = stableId('asset-keyframe', `${project.storyId}:${shotId}`);
  const previous = project.assets.find((asset) => String(asset.id) === previewAssetId);
  const previewAsset = {
    id: previewAssetId,
    kind: 'scene',
    name: `${project.shots[shotIndex].title || shotId} · 已采用关键帧`,
    description: '由创作者采用的镜头预览，作为后续视频的首要视觉参考。',
    prompt: text(candidateData.prompt),
    negativePrompt: text(candidateData.negativePrompt, 8_000),
    requiredByShotIds: [shotId],
    source: 'existing',
    status: 'succeeded',
    url,
    taskId: '',
    taskProvider: text(candidateData.providerId || candidateData.providerSource, 160),
    taskModel: text(candidateData.providerModel || candidateData.apiModel || candidateData.model, 240),
    taskEndpoint: '',
    taskClipIds: [],
    error: '',
    locked: true,
    revision: Math.max(1, Number(previous?.revision) || 0) + 1,
    generatedAt: new Date().toISOString(),
    sourceNodeId: candidate.id,
  };
  const assets = project.assets.some((asset) => String(asset.id) === previewAssetId)
    ? project.assets.map((asset) => String(asset.id) === previewAssetId ? previewAsset : asset)
    : [...project.assets, previewAsset];
  const shots = project.shots.map((shot, index) => index === shotIndex
    ? {
      ...shot,
      assetIds: unique([...(shot.assetIds || []), previewAssetId]),
      videoUrl: '',
      taskId: '',
      taskProvider: '',
      taskModel: '',
      status: 'pending',
      error: '',
      revision: Math.max(1, Number(shot.revision) || 1) + 1,
    }
    : shot);
  const next = refresh({
    ...project,
    assets,
    shots,
    stage: 'prompts',
    storyRevision: project.storyRevision + 1,
    productionRevision: project.productionRevision + 1,
    finalVideoUrl: '',
    composeTaskId: '',
    composeTaskStatus: 'idle',
  });
  return patch(document, planId, `采用关键帧并绑定到镜头“${shots[shotIndex].title || shotId}”`, [
    nodePatch(node.id, { storyProject: next }),
  ]);
}

function inspect(document, input) {
  const { node, project } = storyContext(document, input);
  return {
    schema: 't8-agent-story-inspection-v1',
    nodeId: node.id,
    storyId: project.storyId,
    title: project.title,
    stage: project.stage,
    storyRevision: project.storyRevision,
    productionRevision: project.productionRevision,
    script: { characters: project.script.length, digest: digest(project.script) },
    settings: {
      aspectRatio: project.settings?.aspectRatio,
      targetDurationSec: project.settings?.targetDurationSec,
      llm: {
        provider: project.settings?.llmProviderId || project.settings?.llmProviderSource,
        model: project.settings?.llmProviderModel || project.settings?.llmModel,
      },
      image: {
        provider: project.settings?.imageProviderId || project.settings?.imageProviderSource,
        model: project.settings?.imageProviderModel || project.settings?.imageModel,
      },
      video: {
        provider: project.settings?.videoProviderId || project.settings?.videoProviderSource,
        model: project.settings?.videoProviderModel || project.settings?.videoModel,
      },
      audio: {
        provider: project.settings?.audioProviderId || project.settings?.audioProviderSource,
        model: project.settings?.audioProviderModel || project.settings?.audioModel,
        outputFormat: project.settings?.audioOutputFormat,
        sampleRate: project.settings?.audioSampleRate,
      },
    },
    coverage: clone(project.coverage),
    shots: project.shots.map((shot) => ({
      id: shot.id,
      title: shot.title,
      durationSec: shot.durationSec,
      assetIds: clone(shot.assetIds || []),
      promptReady: Boolean(shot.finalPrompt),
      status: shot.status,
      hasVideo: Boolean(shot.videoUrl),
      lockedFields: clone(shot.lockedFields || []),
    })),
    assets: project.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      requiredByShotIds: clone(asset.requiredByShotIds || []),
      source: asset.source,
      status: asset.status,
      ready: Boolean(asset.url),
      locked: asset.locked === true,
      revision: asset.revision,
    })),
    audioPlan: {
      schema: project.audioPlan?.schema || 't8-story-audio-plan-v1',
      status: project.audioPlan?.status || 'not-required',
      items: clone(Array.isArray(project.audioPlan?.items) ? project.audioPlan.items : []),
      mix: clone(record(project.audioPlan?.mix)),
      lipSync: clone(record(project.audioPlan?.lipSync)),
    },
    nextActions: project.shots.length
      ? ['绑定缺失资产，编译提示词，然后为前三镜创建低成本关键帧预览。']
      : ['用 story import 导入可编辑镜头与资产计划；不会自动生成。'],
  };
}

module.exports = {
  AgentControlStoryCreativeError,
  analyzePatch,
  adoptPreviewPatch,
  bindAssetPatch,
  compilePatch,
  importPatch,
  initializeStoryProject,
  inspect,
  previewPatch,
  buildLocalStoryAnalysis,
  buildStoryAudioPlan,
  splitStoryScriptBlocks,
  storySceneSections,
};
