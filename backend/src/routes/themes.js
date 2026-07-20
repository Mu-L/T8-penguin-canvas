const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const router = express.Router();
const SCHEMA = 't8-theme-template';
const VERSION = 2;
const VISUAL_STYLES = new Set(['plain', 'tech', 'pixel', 'op', 'rh', 'naruto', 'eva', 'yyh', 'slamdunk', 'soccer-hero', 'dragon-ball', 'saint-seiya', 'tetris', 'farm-story', 'garden-defense']);
const INTENSITIES = new Set(['subtle', 'medium', 'strong']);
const ICON_PACKS = new Set(['default', 'op', 'naruto', 'eva', 'yyh', 'slamdunk', 'soccer', 'dragon-ball', 'saint-seiya', 'tetromino-well', 'farm-tools', 'garden-guard']);
const CANVAS_PATTERNS = new Set(['none', 'dots', 'map', 'circuit', 'confetti', 'hub', 'chakra', 'eva-grid', 'spirit-map', 'court', 'pitch', 'dragon-radar', 'sanctuary-zodiac', 'tetris-stack', 'pasture-map', 'defense-lawn']);
const NODE_FRAMES = new Set(['plain', 'glass', 'sticker', 'wanted', 'hub-card', 'shinobi-scroll', 'eva-panel', 'spirit-case', 'scoreboard-card', 'match-card', 'capsule-card', 'cloth-box-card', 'arcade-cabinet-card', 'farm-sign-card', 'garden-card']);
const MUSIC_PRESETS = new Set(['tech-pulse', 'pixel-pop', 'grand-line-adventure', 'rh-pulse', 'shinobi-flame', 'eva-sync', 'spirit-gun', 'buzzer-beater', 'golden-goal', 'ki-burst', 'shenron-aura', 'pegasus-cosmos', 'hades-eclipse', 'block-drop', 'farm-breeze', 'garden-march']);
const MUSIC_SOURCES = new Set(['synth', 'url', 'upload']);

function loadSettings() {
  try {
    if (!fs.existsSync(config.SETTINGS_FILE)) return {};
    return JSON.parse(fs.readFileSync(config.SETTINGS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function getThemeDir(options = {}) {
  const settings = loadSettings();
  const raw = String(settings.themeTemplatePath || config.DEFAULT_THEME_TEMPLATE_DIR || '').trim();
  const dir = raw || config.DEFAULT_THEME_TEMPLATE_DIR;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (options.required) throw e;
    console.warn('[themes] 主题模板目录不可写，暂只加载内置模板:', dir, e?.message || e);
  }
  return dir;
}

function safeId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

function templateFile(id) {
  const clean = safeId(id);
  if (!clean) throw new Error('模板 ID 不能为空');
  return path.join(getThemeDir({ required: true }), `${clean}.json`);
}

function normalizeVisuals(raw, legacyStyle) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const fallbackStyle = legacyStyle === 'tech' ? 'tech' : 'pixel';
  const style = VISUAL_STYLES.has(source.style) ? source.style : fallbackStyle;
  return {
    style,
    intensity: INTENSITIES.has(source.intensity) ? source.intensity : 'medium',
    iconPack: ICON_PACKS.has(source.iconPack)
      ? source.iconPack
      : style === 'op'
        ? 'op'
        : style === 'naruto'
          ? 'naruto'
        : style === 'eva'
          ? 'eva'
        : style === 'yyh'
          ? 'yyh'
        : style === 'slamdunk'
          ? 'slamdunk'
        : style === 'soccer-hero'
          ? 'soccer'
        : style === 'dragon-ball'
          ? 'dragon-ball'
        : style === 'saint-seiya'
          ? 'saint-seiya'
        : style === 'tetris'
          ? 'tetromino-well'
        : style === 'farm-story'
          ? 'farm-tools'
        : style === 'garden-defense'
          ? 'garden-guard'
          : 'default',
    canvasPattern: CANVAS_PATTERNS.has(source.canvasPattern)
      ? source.canvasPattern
      : style === 'op'
        ? 'map'
        : style === 'rh'
          ? 'hub'
        : style === 'naruto'
          ? 'chakra'
        : style === 'eva'
          ? 'eva-grid'
        : style === 'yyh'
          ? 'spirit-map'
        : style === 'slamdunk'
          ? 'court'
        : style === 'soccer-hero'
          ? 'pitch'
        : style === 'dragon-ball'
          ? 'dragon-radar'
        : style === 'saint-seiya'
          ? 'sanctuary-zodiac'
        : style === 'tetris'
          ? 'tetris-stack'
        : style === 'farm-story'
          ? 'pasture-map'
        : style === 'garden-defense'
          ? 'defense-lawn'
        : style === 'tech'
          ? 'circuit'
          : 'dots',
    nodeFrame: NODE_FRAMES.has(source.nodeFrame)
      ? source.nodeFrame
      : style === 'op'
        ? 'wanted'
        : style === 'rh'
          ? 'hub-card'
        : style === 'naruto'
          ? 'shinobi-scroll'
        : style === 'eva'
          ? 'eva-panel'
        : style === 'yyh'
          ? 'spirit-case'
        : style === 'slamdunk'
          ? 'scoreboard-card'
        : style === 'soccer-hero'
          ? 'match-card'
        : style === 'dragon-ball'
          ? 'capsule-card'
        : style === 'saint-seiya'
          ? 'cloth-box-card'
        : style === 'tetris'
          ? 'arcade-cabinet-card'
        : style === 'farm-story'
          ? 'farm-sign-card'
        : style === 'garden-defense'
          ? 'garden-card'
        : style === 'tech'
          ? 'glass'
          : 'sticker',
    headerMark: typeof source.headerMark === 'string' ? source.headerMark.slice(0, 40) : '',
  };
}

function defaultMusicFor(legacyStyle, visuals) {
  const style = visuals?.style;
  if (style === 'op') {
    return {
      title: 'Grand Line Adventure Loop',
      preset: 'grand-line-adventure',
      source: 'synth',
      volume: 0.16,
      bpm: 96,
      copyrightNote: '原创航海冒险风循环；可替换为已授权音频 URL。',
    };
  }
  if (style === 'rh') {
    return {
      title: '潮鸣',
      preset: 'rh-pulse',
      source: 'synth',
      volume: 0.14,
      bpm: 104,
      copyrightNote: 'RH 工作台氛围默认音乐；可替换为已授权音频 URL。',
    };
  }
  if (style === 'naruto') {
    return {
      title: 'Shinobi Flame Loop',
      preset: 'shinobi-flame',
      source: 'synth',
      volume: 0.16,
      bpm: 146,
      copyrightNote: '原创火焰查克拉氛围合成循环；可替换为已授权音频 URL。',
    };
  }
  if (style === 'eva') {
    return {
      title: 'MAGI Sync Loop',
      preset: 'eva-sync',
      source: 'synth',
      volume: 0.16,
      bpm: 152,
      copyrightNote: '原创同步警戒氛围合成循环；可替换为已授权音频 URL。',
    };
  }
  if (style === 'yyh') {
    return {
      title: 'Spirit Gun Pulse',
      preset: 'spirit-gun',
      source: 'synth',
      volume: 0.16,
      bpm: 138,
      copyrightNote: '原创灵界侦探氛围合成循环；可替换为已授权音频 URL。',
    };
  }
  if (style === 'slamdunk') {
    return {
      title: 'Buzzer Beater Warmup',
      preset: 'buzzer-beater',
      source: 'synth',
      volume: 0.16,
      bpm: 104,
      copyrightNote: '原创篮球馆热血合成循环；可替换为已授权音频 URL。',
    };
  }
  if (style === 'soccer-hero') {
    return {
      title: '足球小将主题歌（燃烧英雄）',
      preset: 'golden-goal',
      source: 'synth',
      volume: 0.16,
      bpm: 150,
      copyrightNote: '足球小将风格默认音乐由前端内置模板提供；后端规范化兜底仍使用 golden-goal 合成循环，可替换为已授权音频 URL。',
    };
  }
  if (style === 'dragon-ball') {
    return {
      title: 'Ki Burst Radar Loop',
      preset: 'ki-burst',
      source: 'synth',
      volume: 0.16,
      bpm: 156,
      copyrightNote: '七龙珠主题默认音乐由前端内置模板提供；后端导入规范化缺少可用 URL 时仅使用 ki-burst 合成兜底，可替换为已授权音频 URL。',
    };
  }
  if (style === 'saint-seiya') {
    return {
      title: 'Pegasus Cosmos Loop',
      preset: 'pegasus-cosmos',
      source: 'synth',
      hiddenTitle: 'Hades Eclipse',
      hiddenVolume: 0.18,
      volume: 0.16,
      bpm: 148,
      copyrightNote: '原创圣域小宇宙合成循环；冥界篇使用隐藏合成 preset，可替换为已授权音频 URL。',
    };
  }
  if (style === 'tetris') {
    return {
      title: 'Korobeiniki Block Drop',
      preset: 'block-drop',
      source: 'synth',
      volume: 0.15,
      bpm: 132,
      copyrightNote: '俄罗斯方块主题默认音乐由前端内置模板提供；后端导入规范化缺少可用 URL 时使用 block-drop 合成兜底，可替换为已授权音频 URL。',
    };
  }
  if (style === 'farm-story') {
    return {
      title: 'Farm Breeze Loop',
      preset: 'farm-breeze',
      source: 'synth',
      volume: 0.12,
      bpm: 92,
      copyrightNote: '原创牧场微风氛围合成循环；可替换为已授权音频 URL。',
    };
  }
  if (style === 'garden-defense') {
    return {
      title: 'Garden Guard March',
      preset: 'garden-march',
      source: 'synth',
      volume: 0.14,
      bpm: 112,
      copyrightNote: '原创庭院守卫合成循环；可替换为已授权音频 URL。',
    };
  }
  if (legacyStyle === 'tech' || style === 'tech') {
    return {
      title: 'Neon Circuit Pulse',
      preset: 'tech-pulse',
      source: 'synth',
      volume: 0.16,
      bpm: 112,
      copyrightNote: '原创合成循环。',
    };
  }
  return {
    title: 'Candy Bit Bounce',
    preset: 'pixel-pop',
    source: 'synth',
    volume: 0.15,
    bpm: 128,
    copyrightNote: '原创 8-bit 风格循环。',
  };
}

function normalizeMusic(raw, legacyStyle, visuals) {
  const fallback = defaultMusicFor(legacyStyle, visuals);
  const source = raw && typeof raw === 'object' ? raw : {};
  const volume = Number(source.volume);
  const bpm = Number(source.bpm);
  const rawUrl = typeof source.url === 'string' ? source.url.trim() : '';
  const safeUrl = rawUrl.startsWith('data:audio/') || /^https?:\/\//i.test(rawUrl) ? rawUrl.slice(0, 45000000) : '';
  const rawHiddenUrl = typeof source.hiddenUrl === 'string' ? source.hiddenUrl.trim() : '';
  const safeHiddenUrl = rawHiddenUrl.startsWith('data:audio/') || /^https?:\/\//i.test(rawHiddenUrl)
    ? rawHiddenUrl.slice(0, 45000000)
    : '';
  const hiddenVolume = Number(source.hiddenVolume);
  return {
    title: typeof source.title === 'string' && source.title.trim()
      ? source.title.trim().slice(0, 80)
      : fallback.title,
    preset: MUSIC_PRESETS.has(source.preset) ? source.preset : fallback.preset,
    source: MUSIC_SOURCES.has(source.source) ? source.source : fallback.source,
    url: safeUrl,
    hiddenTitle: typeof source.hiddenTitle === 'string' && source.hiddenTitle.trim()
      ? source.hiddenTitle.trim().slice(0, 80)
      : '',
    hiddenUrl: safeHiddenUrl,
    hiddenVolume: Number.isFinite(hiddenVolume) ? Math.max(0, Math.min(hiddenVolume, 0.5)) : undefined,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(volume, 0.5)) : fallback.volume,
    bpm: Number.isFinite(bpm) ? Math.max(40, Math.min(Math.round(bpm), 220)) : fallback.bpm,
    copyrightNote: typeof source.copyrightNote === 'string'
      ? source.copyrightNote.trim().slice(0, 200)
      : fallback.copyrightNote,
  };
}

function normalizeTemplate(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') throw new Error('主题模板必须是 JSON 对象');
  const id = safeId(raw.id || fallbackId);
  if (!id) throw new Error('主题模板缺少 id');
  const name = String(raw.name || '').trim().slice(0, 80);
  if (!name) throw new Error('主题模板缺少名称');
  const legacyStyle = raw.legacyStyle === 'tech' ? 'tech' : 'pixel';
  const modes = raw.modes && typeof raw.modes === 'object' ? raw.modes : {};
  for (const mode of ['light', 'dark']) {
    if (!modes[mode] || typeof modes[mode] !== 'object' || !modes[mode].tokens) {
      throw new Error(`主题模板缺少 ${mode} tokens`);
    }
  }
  const visuals = normalizeVisuals(raw.visuals, legacyStyle);
  return {
    schema: SCHEMA,
    version: VERSION,
    id,
    name,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 300) : '',
    author: typeof raw.author === 'string' ? raw.author.slice(0, 80) : '',
    builtIn: false,
    legacyStyle,
    visuals,
    music: normalizeMusic(raw.music, legacyStyle, visuals),
    modes: {
      light: { tokens: modes.light.tokens },
      dark: { tokens: modes.dark.tokens },
    },
  };
}

function readTemplateFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return normalizeTemplate(raw, path.basename(file, '.json'));
}

function listTemplates() {
  const dir = getThemeDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((name) => {
      try {
        return readTemplateFile(path.join(dir, name));
      } catch (e) {
        console.warn('[themes] 跳过损坏模板:', name, e?.message || e);
        return null;
      }
    })
    .filter(Boolean);
}

router.get('/templates', (_req, res) => {
  try {
    res.json({ success: true, data: { path: getThemeDir(), templates: listTemplates() } });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

router.post('/templates/import', (req, res) => {
  try {
    const template = normalizeTemplate(req.body?.template || req.body);
    const file = templateFile(template.id);
    fs.writeFileSync(file, JSON.stringify(template, null, 2), 'utf-8');
    res.json({ success: true, data: template });
  } catch (e) {
    res.status(400).json({ success: false, error: e?.message || String(e) });
  }
});

router.put('/templates/:id', (req, res) => {
  try {
    const id = safeId(req.params.id);
    const template = normalizeTemplate({ ...req.body, id }, id);
    fs.writeFileSync(templateFile(id), JSON.stringify(template, null, 2), 'utf-8');
    res.json({ success: true, data: template });
  } catch (e) {
    res.status(400).json({ success: false, error: e?.message || String(e) });
  }
});

router.get('/templates/:id/export', (req, res) => {
  try {
    const file = templateFile(req.params.id);
    if (!fs.existsSync(file)) return res.status(404).json({ success: false, error: '模板不存在' });
    res.json({ success: true, data: readTemplateFile(file) });
  } catch (e) {
    res.status(400).json({ success: false, error: e?.message || String(e) });
  }
});

router.delete('/templates/:id', (req, res) => {
  try {
    const file = templateFile(req.params.id);
    if (!fs.existsSync(file)) return res.status(404).json({ success: false, error: '模板不存在' });
    fs.unlinkSync(file);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: e?.message || String(e) });
  }
});

module.exports = router;
