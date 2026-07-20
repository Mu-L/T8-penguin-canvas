/**
 * 上游 API 代理路由
 * 1. 隐藏 API Key,前端只通过 /api/proxy/* 调用
 * 2. 自动注入对应的 Key(贞贞工坊 / LLM 独立)
 * 3. 图像生成结果自动转存到 /output 并返回本地 URL
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const { getWhitePng } = require('../utils/whitePng');
const { tryDecodeDuckPayload } = require('../utils/duckPayload');
const { normalizeLlmMessageMedia } = require('../providers/llmMedia');
const seedanceNz = require('../providers/seedanceNz');
const {
  normalizeRhSite,
  buildRhSiteCandidates,
  shouldRetryRhSiteResponse,
  missingRhKeyError,
} = require('../providers/runninghubSite');
const { runLocalHooks } = require('../extensions/runtimeHooks');

const router = express.Router();

// 音频文件上传中间件(内存存储, 50MB)
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function safeOutputExt(ext, fallback = 'png') {
  const s = String(ext || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12);
  return s || fallback;
}

function extFromContentType(contentType) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/avif': 'avif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/flac': 'flac',
  };
  return map[ct] || '';
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  const trimmed = String(text || '').trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const contentType = response.headers?.get?.('content-type') || 'unknown';
    const preview = trimmed.replace(/\s+/g, ' ').slice(0, 240);
    const err = new Error(`${label} 返回非 JSON：HTTP ${response.status} ${contentType} · ${preview}`);
    err.status = response.status;
    err.contentType = contentType;
    err.preview = preview;
    throw err;
  }
}

function inferRemoteOutputExt(url, contentType) {
  const tail = String(url || '').split(/[?#]/)[0];
  const m = tail.match(/\.([a-z0-9]{2,8})$/i);
  return safeOutputExt(m ? m[1] : extFromContentType(contentType), 'png');
}

function isRunningHubOutputUrl(value) {
  return /^(https?:\/\/|data:(image|video|audio)\/|\/files\/|\/output\/|\/input\/)/i.test(String(value || '').trim());
}

const RUNNINGHUB_OUTPUT_URL_KEYS = [
  'fileUrl',
  'file_url',
  'url',
  'src',
  'href',
  'downloadUrl',
  'download_url',
  'resultUrl',
  'result_url',
  'outputUrl',
  'output_url',
  'imageUrl',
  'image_url',
  'videoUrl',
  'video_url',
  'audioUrl',
  'audio_url',
  'ossUrl',
  'oss_url',
  'signedUrl',
  'signed_url',
  'publicUrl',
  'public_url',
  'originUrl',
  'origin_url',
  'originalUrl',
  'original_url',
  'previewUrl',
  'preview_url',
  'thumbnailUrl',
  'thumbnail_url',
  'thumbUrl',
  'thumb_url',
  'largeImageUrl',
  'large_image_url',
  'file',
  'path',
  'fileName',
  'file_name',
  'filename',
];

function collectRunningHubOutputItems(value, out = [], seen = new Set()) {
  const pushRemote = (remote, source = {}) => {
    const text = String(remote || '').trim();
    if (!text || !isRunningHubOutputUrl(text) || seen.has(text)) return;
    seen.add(text);
    out.push({
      ...source,
      fileUrl: text,
      url: text,
      fileType: source.fileType || source.file_type || source.type || '',
    });
  };
  if (value == null) return out;
  if (typeof value === 'string') {
    pushRemote(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRunningHubOutputItems(item, out, seen);
    return out;
  }
  if (typeof value !== 'object') return out;

  for (const key of RUNNINGHUB_OUTPUT_URL_KEYS) {
    if (typeof value[key] === 'string') pushRemote(value[key], value);
  }

  for (const child of Object.values(value)) {
    collectRunningHubOutputItems(child, out, seen);
  }
  return out;
}

function summarizeRunningHubOutputShape(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value;
  const type = typeof value;
  if (type !== 'object') {
    if (type === 'string') {
      const text = value.trim();
      return isRunningHubOutputUrl(text) ? `url(${text.slice(0, 48)})` : `string(${text.length})`;
    }
    return type;
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (depth >= 3) {
    return Array.isArray(value)
      ? { type: 'array', length: value.length }
      : { type: 'object', keys: Object.keys(value).slice(0, 30) };
  }
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      sample: value.slice(0, 3).map((item) => summarizeRunningHubOutputShape(item, depth + 1, seen)),
    };
  }
  const keys = Object.keys(value);
  const sample = {};
  for (const key of keys.slice(0, 24)) {
    sample[key] = summarizeRunningHubOutputShape(value[key], depth + 1, seen);
  }
  return { type: 'object', keys: keys.slice(0, 60), sample };
}

// ========== 工具:加载 Settings 明文 ==========
function loadRawSettings() {
  if (!fs.existsSync(config.SETTINGS_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(config.SETTINGS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

// ========== 工具: 按提示词（模型名 / endpoint / 路由名）选择分类 API Key ==========
// 未填分类 key 时 fallback 到 通用 zhenzhenApiKey。
// hint 例: 'gpt-image-1' / 'gemini-3-pro-image' / 'gemini-3.1-flash-image' / 'mj-fast' / 'veo3.1-fal'
//          / 'grok-video-fal' / 'seedance-v3' / 'suno-v5.5' / 'fal-ai/nano-banana/edit'
function pickApiKey(settings, hint = '') {
  if (!settings) return '';
  const fb = settings.zhenzhenApiKey || '';
  const m = String(hint || '').toLowerCase();
  if (!m) return fb;
  if (m.includes('gpt-image') || m.includes('gpt2') || m.includes('gpt_image') || m.includes('gptimage')) return settings.gptImageApiKey || fb;
  if (m.includes('nano-banana') || m.includes('nano_banana') || m.includes('nanobanana') || m.includes('flash-image') || m.includes('flash-lite-image') || m.includes('gemini-3-pro-image')) return settings.nanoBananaApiKey || fb;
  if (m.includes('midjourney') || /\bmj[-_/]/.test(m) || m.startsWith('mj') || m === 'mj') return settings.mjApiKey || fb;
  if (m.includes('veo')) return settings.veoApiKey || fb;
  if (m.includes('sora')) return settings.soraApiKey || fb;
  if (m.includes('grok')) return settings.grokApiKey || fb;
  if (m.includes('seedance')) return settings.seedanceApiKey || fb;
  if (m.includes('suno') || m.includes('chirp')) return settings.sunoApiKey || fb;
  return fb;
}

function normalizeImageApiModel(model) {
  const raw = String(model || '').trim();
  if (raw === 'nano-banana-2') return 'gemini-3.1-flash-image';
  if (raw === 'gemini-3.1-flash-image-preview') return 'gemini-3.1-flash-image';
  if (raw === 'gemini-3.1-flash-image-previiew') return 'gemini-3.1-flash-image';
  if (raw === 'gemini-3-pro-image-preview') return 'gemini-3-pro-image';
  if (raw === 'gemini-3-pro-image-2k-preview') return 'gemini-3-pro-image-2k';
  if (raw === 'gemini-3-pro-image-4k-preview') return 'gemini-3-pro-image-4k';
  if (gptImage2ZhenzhenVariantSize(raw)) return 'gpt-image-2';
  return raw;
}

function gptImage2ZhenzhenVariantSize(model) {
  const raw = String(model || '').trim().toLowerCase();
  if (raw === 'gpt-image-2-2k') return '2K';
  if (raw === 'gpt-image-2-4k') return '4K';
  return '';
}

function isBananaImageModel(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('nano-banana')
    || m.includes('nano_banana')
    || m.includes('nanobanana')
    || m.includes('flash-image')
    || m.includes('flash-lite-image')
    || m.includes('gemini-3-pro-image');
}

function isOfficialGeminiImageModel(model) {
  const raw = String(model || '').trim();
  return raw === 'gemini-3.1-flash-lite-image'
    || raw === 'gemini-3-pro-image';
}

// ========== 工具: 以提示词为准，将 settings.zhenzhenApiKey 临时覆盖为分类 key ==========
// 调用后，后续所有 settings.zhenzhenApiKey 引用默认都会拿到分类 key（零侵入原逻辑）。
function applyClassifiedKey(settings, hint) {
  if (!settings) return;
  const picked = pickApiKey(settings, hint);
  if (picked) settings.zhenzhenApiKey = picked;
}

// ========== v1.2.9.15 新增：「专属优先 fallback 通用」一体化 API Key 校验 ==========
// 修复 v1.2.9.14 之前的两类 bug：
//   ① 旧路由先校验 settings.zhenzhenApiKey 非空 → 再 applyClassifiedKey；
//      若用户「只配置了分类专属 key 而通用 key 留空」，会被第一道检查误拦，
//      报「未配置贞贞工坊 API Key」，但其实专属 key 已存在；
//   ② 即使 zhenzhenApiKey 是错误值（如 '123'），按旧顺序通过校验后 applyClassifiedKey
//      仍能用 sunoApiKey 覆盖，但用户错配了 audio/upload 这类「完全没调 applyClassifiedKey」
//      的子路由 → Suno 上传步骤直接用 zhenzhenApiKey='123' 上传 → 上游返回令牌错误。
//
// 用法：
//   const settings = loadRawSettings();
//   if (!ensureKey(settings, res, 'suno', 'Suno')) return;
//   // 此时 settings.zhenzhenApiKey 已是 effective key（专属优先 fallback 通用），
//   // 后续直接 `Bearer ${settings.zhenzhenApiKey}` 即可。
//
// 副作用：成功时（return true）已对 settings 做 applyClassifiedKey；
//        失败时（return false）已通过 res 写入 400 响应，调用方应直接 return。
//
// 设计原则：
//   - 「专属优先」：sunoApiKey 非空 → 用 sunoApiKey；
//   - 「通用 fallback」：sunoApiKey 留空但 zhenzhenApiKey 非空 → 用 zhenzhenApiKey；
//   - 「双空才拒」：两者都空时报「分类专属 + 通用 至少填其一」。
function ensureKey(settings, res, hint, label) {
  if (!settings) {
    res.status(400).json({ success: false, error: '未找到 settings 文件，请先在【设置】中配置 API Key' });
    return false;
  }
  applyClassifiedKey(settings, hint || '');
  if (!settings.zhenzhenApiKey) {
    const tip = label
      ? `未配置 ${label} 专属 API Key，且贞贞工坊通用 API Key 也为空（请在【设置】中至少填写其中一个）`
      : '未配置贞贞工坊 API Key（请在【设置】中填写）';
    res.status(400).json({ success: false, error: tip });
    return false;
  }
  return true;
}

function ensureDefaultZhenzhenKey(settings, res, label = '贞贞工坊') {
  if (!settings) {
    res.status(400).json({ success: false, error: '未找到 settings 文件，请先在【设置】中配置 API Key' });
    return false;
  }
  if (!settings.zhenzhenApiKey) {
    res.status(400).json({ success: false, error: `${label} 使用通用贞贞 API Key，请先在【设置】中填写贞贞工坊通用 API Key` });
    return false;
  }
  return true;
}

// ========== 工具: taskId → 实际使用的 apiKey 内存映射 ==========
// submit 阶段根据 hint 选了分类 key 后，将 (taskId → key) 记下，
// query/status 阶段优先从该 Map 恢复 key，
// 防止前端未透传 model 时轮询错误 fallback 到通用 key 导致“令牌不合法”。
// 30 分钟过期自清。
const taskKeyMap = new Map();
function rememberTaskKey(taskId, apiKey, meta = {}) {
  if (!taskId || !apiKey) return;
  taskKeyMap.set(String(taskId), { apiKey, ...meta });
  const timer = setTimeout(() => taskKeyMap.delete(String(taskId)), 30 * 60 * 1000);
  timer.unref?.();
}
function recallTaskMeta(taskId) {
  if (!taskId) return null;
  const item = taskKeyMap.get(String(taskId));
  if (!item) return null;
  return typeof item === 'string' ? { apiKey: item } : item;
}
function normalizeProviderParams(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseProviderParams(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return normalizeProviderParams(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return normalizeProviderParams(value);
}

function hasSelectedProviderGroup(providerParams) {
  const params = normalizeProviderParams(providerParams);
  return !!String(params.zhenzhenGroup || params.t8Group || params.group || '').trim();
}

function ensureKeyOrSelectedGroup(settings, res, hint = '', label = '', providerParams = {}) {
  if (!settings) {
    res.status(400).json({ success: false, error: '未找到 settings 文件，请先在【设置】中配置 API Key' });
    return false;
  }
  applyClassifiedKey(settings, hint || '');
  if (settings.zhenzhenApiKey || hasSelectedProviderGroup(providerParams)) return true;
  const tip = label
    ? `未配置 ${label} 专属 API Key，且贞贞工坊通用 API Key 也为空（如已绑定 New API 分组令牌，请在节点上选择分组）`
    : '未配置贞贞工坊 API Key（请在【设置】中填写，或绑定 New API 后在节点选择分组）';
  res.status(400).json({ success: false, error: tip });
  return false;
}

async function applyZhenzhenProviderContext(settings, options = {}) {
  if (!settings) {
    return {
      apiKey: '',
      taskMeta: {},
    };
  }
  const providerParams = normalizeProviderParams(options.providerParams);
  const selectedGroup = String(providerParams.zhenzhenGroup || providerParams.t8Group || providerParams.group || '').trim();
  const result = await runLocalHooks('zhenzhen.resolveApiKey', {
    provider: 'zhenzhen',
    route: options.route || '',
    kind: options.kind || '',
    model: options.model || options.hint || '',
    hint: options.hint || options.model || '',
    apiKey: settings.zhenzhenApiKey,
    providerParams,
  });
  if (result?.apiKey && typeof result.apiKey === 'string') {
    settings.zhenzhenApiKey = result.apiKey;
  }
  if (selectedGroup && !settings.zhenzhenApiKey) {
    throw new Error('已选择分组令牌，但当前未找到可用 API Key；请在 API Key 设置里启用并绑定 New API 分组令牌，或改用通用贞贞 API Key');
  }
  const taskMeta = {
    ...(result?.taskMeta && typeof result.taskMeta === 'object' ? result.taskMeta : {}),
  };
  if (result?.group) taskMeta.group = result.group;
  if (result?.groupLabel) taskMeta.groupLabel = result.groupLabel;
  if (result?.model) taskMeta.model = result.model;
  return {
    apiKey: settings.zhenzhenApiKey,
    taskMeta,
  };
}

function isInvalidApiKeyError(errorText) {
  return /无效的令牌|令牌无效|invalid\s+(?:access\s+)?token|unauthorized/i.test(String(errorText || ''));
}

async function invalidateZhenzhenProviderKey(providerContext, apiKey, errorText) {
  const group = providerContext?.taskMeta?.group || providerContext?.taskMeta?.selectedGroup;
  if (!group || !apiKey || !isInvalidApiKeyError(errorText)) return;
  try {
    await runLocalHooks('zhenzhen.invalidateApiKey', {
      group,
      apiKey,
      error: String(errorText || '').slice(0, 500),
    });
  } catch (error) {
    console.warn('[zhenzhen] invalidate group token failed:', error?.message || error);
  }
}

// ========== 工具:保存上游返回的图像到本地 ==========
async function saveRemoteImage(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`下载失败: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const contentExt = extFromContentType(res.headers?.get?.('content-type'));
    const ext = (contentExt || url.match(/\.(png|jpe?g|webp|gif)/i)?.[1] || 'png').toLowerCase();
    const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const filePath = path.join(config.OUTPUT_DIR, filename);
    fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(filePath, buf);
    return `/files/output/${filename}`;
  } catch (e) {
    console.error('⚠ 转存图像失败:', e.message);
    return url; // 退化:返回原 URL
  }
}

// ========== 工具:保存上游返回的音频到本地 ==========
async function saveRemoteAudio(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = (url.match(/\.(mp3|wav|m4a|ogg|flac|aac)/i)?.[1] || 'mp3').toLowerCase();
    const filename = `audio_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const filePath = path.join(config.OUTPUT_DIR, filename);
    fs.writeFileSync(filePath, buf);
    return `/files/output/${filename}`;
  } catch (e) {
    console.error('⚠ 转存音频失败:', e.message);
    return url; // 退化:返回原 URL
  }
}

// 处理 b64_json 格式
function saveBase64Image(b64) {
  try {
    const raw = String(b64 || '');
    const clean = raw.includes(',') ? raw.split(',').pop() : raw;
    const buf = Buffer.from(clean || '', 'base64');
    const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`;
    const filePath = path.join(config.OUTPUT_DIR, filename);
    fs.writeFileSync(filePath, buf);
    return `/files/output/${filename}`;
  } catch (e) {
    console.error('⚠ 解析 b64 失败:', e.message);
    return null;
  }
}

// ========== POST /api/proxy/image — 图像生成 ==========
// body: { model, apiModel?, paramKind?, prompt, aspect_ratio?, image_size?, images?[], size?, image?, quality?, n?, response_format?, output_format? }
//
// 主项目对齐的双协议路由:
//  1. paramKind === 'gpt-size'
//     - 无参考图 → POST /v1/images/generations (JSON)  body: { model, prompt, size }
//     - 有参考图 → POST /v1/images/edits        (multipart) image 多次 append
//     - size 从 (aspect_ratio + image_size 等级) 映射为像素串(1024x1024/1536x1024/1024x1536/2048x2048…)
//  2. paramKind === 'banana-ratio'
//     - POST /v1/images/generations (JSON) body: { model, prompt, aspect_ratio, image_size:'1K'|'2K'|'4K', image:[base64...]? }

// ========== 主项目 gpt-image-2-web 完整 GPT_SIZE_MAP(line 2173)==========
const GPT_SIZE_MAP = {
  '1:1_1k': '1024x1024', '1:1_2k': '2048x2048', '1:1_4k': '2880x2880',
  '3:2_1k': '1248x832',  '3:2_2k': '2496x1664', '3:2_4k': '3504x2336',
  '2:3_1k': '832x1248',  '2:3_2k': '1664x2496', '2:3_4k': '2336x3504',
  '4:3_1k': '1152x864',  '4:3_2k': '2304x1728', '4:3_4k': '3264x2448',
  '3:4_1k': '864x1152',  '3:4_2k': '1728x2304', '3:4_4k': '2448x3264',
  '5:4_1k': '1120x896',  '5:4_2k': '2240x1792', '5:4_4k': '3200x2560',
  '4:5_1k': '896x1120',  '4:5_2k': '1792x2240', '4:5_4k': '2560x3200',
  '16:9_1k': '1280x720', '16:9_2k': '2560x1440', '16:9_4k': '3840x2160',
  '9:16_1k': '720x1280', '9:16_2k': '1440x2560', '9:16_4k': '2160x3840',
  '2:1_1k': '2048x1024', '2:1_2k': '2688x1344', '2:1_4k': '3840x1920',
  '1:2_1k': '1024x2048', '1:2_2k': '1344x2688', '1:2_4k': '1920x3840',
  '21:9_1k': '1456x624', '21:9_2k': '3024x1296', '21:9_4k': '3696x1584',
  '9:21_1k': '624x1456', '9:21_2k': '1296x3024', '9:21_4k': '1584x3696',
};

// 将 (aspectRatio + sizeLevel) 用主项目 GPT_SIZE_MAP 映射成像素串;Auto 返 'auto'
function aspectToGptSize(aspectRatio, sizeLevel) {
  const ar = String(aspectRatio || '').trim();
  const lvl = String(sizeLevel || '1K').toLowerCase();
  const isAuto = !ar || ar === 'Auto' || ar === 'AUTO' || ar === 'empty';
  if (isAuto) return 'auto';
  const key = `${ar}_${lvl}`;
  return GPT_SIZE_MAP[key] || '1024x1024';
}

function imageMimeFromLocalPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase().replace(/^\./, '');
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    avif: 'image/avif',
    tif: 'image/tiff',
    tiff: 'image/tiff',
  };
  return map[ext] || 'image/png';
}

function assertInsideDir(root, target) {
  const base = path.resolve(root);
  const full = path.resolve(target);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

function toLocalPathnameIfSameApp(url) {
  const raw = String(url || '').trim();
  try {
    const u = new URL(raw);
    const host = String(u.hostname || '').toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
      return decodeURIComponent(u.pathname || '');
    }
  } catch {
    // Relative app URLs stay on the normal path below.
  }
  return raw;
}

function resolveStaticImagePath(ref) {
  const raw = toLocalPathnameIfSameApp(ref);
  const candidates = [
    ['/files/input/', config.INPUT_DIR],
    ['/input/', config.INPUT_DIR],
    ['/files/output/', config.OUTPUT_DIR],
    ['/output/', config.OUTPUT_DIR],
    ['/files/thumbnails/', config.THUMBNAILS_DIR],
  ];
  for (const [prefix, root] of candidates) {
    if (!raw.startsWith(prefix)) continue;
    const rel = decodeURIComponent(raw.slice(prefix.length).split('?')[0].split('#')[0]);
    return assertInsideDir(root, path.join(root, rel));
  }
  return null;
}

function readLocalImageRefBuffer(ref) {
  const full = resolveStaticImagePath(ref);
  if (!full || !fs.existsSync(full)) return null;
  const mime = imageMimeFromLocalPath(full);
  return {
    buf: fs.readFileSync(full),
    mime,
    ext: safeOutputExt(path.extname(full), 'png'),
  };
}

function getResourceLibraryRootForProxy() {
  const settings = loadRawSettings() || {};
  return String(settings.resourceLibraryPath || config.DEFAULT_RESOURCE_LIBRARY_DIR || '').trim();
}

function readResourceLibraryDbForProxy(root) {
  if (!root) return null;
  const dbPath = path.join(root, 'resource_library.json');
  if (!fs.existsSync(dbPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function resolveResourceImageRef(ref) {
  const clean = toLocalPathnameIfSameApp(ref).split(/[?#]/)[0];
  const fileMatch = /^\/api\/resources\/file\/([^/?#]+)/.exec(clean);
  const setFileMatch = /^\/api\/resources\/set-file\/([^/?#]+)\/(\d+)/.exec(clean);
  if (!fileMatch && !setFileMatch) return null;

  const root = getResourceLibraryRootForProxy();
  const db = readResourceLibraryDbForProxy(root);
  const items = Array.isArray(db?.items) ? db.items : [];
  if (!root || items.length === 0) return null;

  if (fileMatch) {
    const id = decodeURIComponent(fileMatch[1]);
    const item = items.find((entry) => entry?.id === id);
    const fileRel = String(item?.fileRel || '').trim();
    if (!item || !fileRel) return null;
    const full = assertInsideDir(root, path.join(root, fileRel));
    if (!full) return null;
    return {
      full,
      mime: item.mime || imageMimeFromLocalPath(full),
      ext: safeOutputExt(path.extname(full), 'png'),
    };
  }

  const id = decodeURIComponent(setFileMatch[1]);
  const index = Number(setFileMatch[2]);
  const item = items.find((entry) => entry?.id === id);
  const children = Array.isArray(item?.materialSetItems) ? item.materialSetItems : [];
  const child = Number.isFinite(index) ? children[index] : null;
  const fileRel = String(child?.fileRel || '').trim();
  if (!child || !fileRel) return null;
  const full = assertInsideDir(root, path.join(root, fileRel));
  if (!full) return null;
  return {
    full,
    mime: child.mime || imageMimeFromLocalPath(full),
    ext: safeOutputExt(path.extname(full), 'png'),
  };
}

function readResourceImageRefBuffer(ref) {
  const resolved = resolveResourceImageRef(ref);
  if (!resolved || !fs.existsSync(resolved.full)) return null;
  const mime = String(resolved.mime || imageMimeFromLocalPath(resolved.full)).toLowerCase();
  if (mime && !mime.startsWith('image/')) return null;
  return {
    buf: fs.readFileSync(resolved.full),
    mime: resolved.mime || imageMimeFromLocalPath(resolved.full),
    ext: resolved.ext || safeOutputExt(path.extname(resolved.full), 'png'),
  };
}

// 将 base64 dataURL / http(s) URL 转成 multipart Buffer
async function refToBuffer(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  if (ref.startsWith('data:')) {
    const m = ref.match(/^data:([^;,]+);base64,(.+)$/);
    if (!m) return null;
    const mime = m[1] || 'image/png';
    const buf = Buffer.from(m[2], 'base64');
    const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return { buf, mime, ext };
  }
  if (
    ref.startsWith('http://') ||
    ref.startsWith('https://') ||
    ref.startsWith('/files/') ||
    ref.startsWith('/api/resources/file/') ||
    ref.startsWith('/api/resources/set-file/')
  ) {
    const local = readLocalImageRefBuffer(ref);
    if (local) return local;
    const resource = readResourceImageRefBuffer(ref);
    if (resource) return resource;
    // /files/* 是本地静态,走 127.0.0.1:18766
    const url = ref.startsWith('/') ? `http://127.0.0.1:${config.PORT}${ref}` : ref;
    const r = await fetch(url);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = (ct.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return { buf, mime: ct, ext };
  }
  return null;
}

function summarizeImageRef(ref, index) {
  const text = String(ref || '').trim();
  if (!text) return `#${index + 1} 空引用`;
  if (text.startsWith('data:')) {
    const mime = text.match(/^data:([^;,]+)/)?.[1] || 'image';
    return `#${index + 1} data:${mime};base64,...`;
  }
  return `#${index + 1} ${text.length > 140 ? `${text.slice(0, 96)}...${text.slice(-24)}` : text}`;
}

async function collectConvertedImageRefs(refs, label = '参考图') {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  const convertedRefs = [];
  const failedRefs = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    try {
      const conv = await refToBuffer(ref);
      if (!conv) {
        failedRefs.push({ index: i, ref, reason: '读取结果为空或 HTTP 非成功' });
        continue;
      }
      const mime = String(conv.mime || '').toLowerCase();
      if (mime && !mime.startsWith('image/')) {
        failedRefs.push({ index: i, ref, reason: `非图片内容 ${conv.mime}` });
        continue;
      }
      convertedRefs.push({ ...conv, index: i, ref });
    } catch (error) {
      failedRefs.push({ index: i, ref, reason: error?.message || '读取异常' });
    }
  }
  if (refs.length > 0 && convertedRefs.length === 0) {
    const preview = failedRefs
      .slice(0, 3)
      .map((item) => `${summarizeImageRef(item.ref, item.index)} ${item.reason}`)
      .join('；');
    throw new Error(`${label}读取失败，已中止生成，避免按无参考图生成${preview ? `：${preview}` : ''}`);
  }
  if (failedRefs.length > 0) {
    const preview = failedRefs
      .slice(0, 3)
      .map((item) => `${summarizeImageRef(item.ref, item.index)} ${item.reason}`)
      .join('；');
    console.warn(`[upstream] ${label}部分读取失败 converted=${convertedRefs.length}/${refs.length}: ${preview}`);
  }
  return convertedRefs;
}

function appendConvertedImagesToForm(form, convertedRefs) {
  for (let i = 0; i < convertedRefs.length; i++) {
    const conv = convertedRefs[i];
    const blob = new Blob([conv.buf], { type: conv.mime || 'image/png' });
    const ext = safeOutputExt(conv.ext, 'png');
    form.append('image', blob, `image_${Number.isFinite(conv.index) ? conv.index : i}.${ext}`);
  }
}

// 将 base64/URL 参考图转成 banana 希望的 dataURL 或保留外部 URL
function isLocalImageDataRef(ref) {
  return (
    typeof ref === 'string' &&
    (
      ref.startsWith('/files/') ||
      ref.startsWith('/api/resources/file/') ||
      ref.startsWith('/api/resources/set-file/')
    )
  );
}

async function localImageRefToDataUrl(ref) {
  const conv = await refToBuffer(ref);
  if (!conv) return null;
  const mime = String(conv.mime || 'image/png');
  if (!mime.toLowerCase().startsWith('image/')) return null;
  return `data:${mime};base64,${conv.buf.toString('base64')}`;
}

async function refToBananaImage(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  if (ref.startsWith('data:')) return ref;
  if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
  if (
    ref.startsWith('/files/') ||
    ref.startsWith('/api/resources/file/') ||
    ref.startsWith('/api/resources/set-file/')
  ) {
    // 本地资源 → 转 base64
    try {
      return await localImageRefToDataUrl(ref);
    } catch { return null; }
  }
  return null;
}

// Grok Image 默认按 gpt-image-2-web 的 Base64 方式传参考图,最多 4 张。
async function refToGrokImage(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  if (ref.startsWith('data:')) return ref.startsWith('data:image') ? ref : null;
  if (
    ref.startsWith('http://') ||
    ref.startsWith('https://') ||
    ref.startsWith('/files/') ||
    ref.startsWith('/api/resources/file/') ||
    ref.startsWith('/api/resources/set-file/')
  ) {
    try {
      if (isLocalImageDataRef(ref)) return await localImageRefToDataUrl(ref);
      const url = ref.startsWith('/') ? `http://127.0.0.1:${config.PORT}${ref}` : ref;
      const r = await fetch(url);
      if (!r.ok) return ref.startsWith('http') ? ref : null;
      const ct = r.headers.get('content-type') || 'image/png';
      const buf = Buffer.from(await r.arrayBuffer());
      if (!String(ct).toLowerCase().startsWith('image/')) return null;
      return `data:${ct};base64,${buf.toString('base64')}`;
    } catch {
      // 外网图片转 base64 失败时保留 URL,避免破坏已有可公网访问的上游图。
      return ref.startsWith('http') ? ref : null;
    }
  }
  return null;
}

function isImageTaskString(s) {
  return /^[A-Za-z0-9_-]{8,256}$/.test(String(s || '').trim());
}

function imageTaskId(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
  for (const k of ['task_id', 'id', 'request_id']) {
    if (result[k]) return String(result[k]);
  }
  const d = result.data;
  if (typeof d === 'string' && d.trim() && !/^https?:\/\//.test(d) && !d.startsWith('data:image')) return d.trim();
  if (d && typeof d === 'object') {
    for (const k of ['task_id', 'id', 'request_id']) {
      if (d[k]) return String(d[k]);
    }
  }
  return '';
}

function imageError(result) {
  if (!result) return '';
  if (typeof result === 'string') return result.substring(0, 500);
  if (Array.isArray(result)) return JSON.stringify(result.slice(0, 3)).substring(0, 500);
  if (typeof result !== 'object') return '';
  for (const k of ['detail', 'fail_reason', 'error', 'message']) {
    const v = result[k];
    if (!v) continue;
    if (typeof v === 'string') return v.substring(0, 500);
    if (typeof v === 'object') return String(v.message || v.detail || JSON.stringify(v)).substring(0, 500);
  }
  const d = result.data;
  if (d && typeof d === 'object') {
    const nested = imageError(d);
    if (nested) return nested;
  }
  return '';
}

function imageApiFailed(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const code = String(result.code ?? '').toLowerCase();
  if (code && !['success', 'ok', '0', '200'].includes(code)) return true;
  if (result.detail || result.error) return true;
  return false;
}

function imageStatus(result) {
  if (!result || typeof result !== 'object') return '';
  for (const k of ['status', 'task_status', 'state']) {
    if (result[k]) return String(result[k]).toUpperCase();
  }
  const d = result.data;
  if (d && typeof d === 'object') {
    for (const k of ['status', 'task_status', 'state']) {
      if (d[k]) return String(d[k]).toUpperCase();
    }
  }
  return '';
}

function imageItems(result) {
  if (!result) return [];
  if (Array.isArray(result)) {
    const nested = result.flatMap((item) => imageItems(item));
    return nested.length ? nested : result;
  }
  if (typeof result === 'string') {
    const s = result.trim();
    return s && !isImageTaskString(s) ? [s] : [];
  }
  if (typeof result !== 'object') return [];
  const inlineData = result.inlineData || result.inline_data;
  if (inlineData?.data) {
    return [{
      b64_json: inlineData.data,
      mime_type: inlineData.mimeType || inlineData.mime_type || inlineData.mime || 'image/png',
    }];
  }
  if (Array.isArray(result.parts)) return imageItems(result.parts);
  if (Array.isArray(result.content?.parts)) return imageItems(result.content.parts);
  if (Array.isArray(result.candidates)) return imageItems(result.candidates);
  if (result.url || result.image_url || result.b64_json || result.base64 || result.image_base64) return [result];
  for (const k of ['data', 'images', 'result', 'results', 'output', 'outputs', 'image', 'url']) {
    const v = result[k];
    if (!v) continue;
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s || isImageTaskString(s)) continue;
      return [s];
    }
    if (typeof v === 'object') {
      const nested = imageItems(v);
      if (nested.length) return nested;
    }
  }
  return [];
}

function normalizeImageItems(result) {
  return imageItems(result).map((item) => {
    if (typeof item === 'string') {
      return /^https?:\/\//.test(item) ? { url: item } : { b64_json: item.startsWith('data:image') ? item : item };
    }
    if (item && typeof item === 'object') {
      const url = item.url || item.image_url || (typeof item.image === 'string' && /^https?:\/\//.test(item.image) ? item.image : '');
      const b64 = item.b64_json || item.base64 || item.image_base64 || (!url && typeof item.image === 'string' ? item.image : '');
      if (url) return { url };
      if (b64) return { b64_json: b64 };
    }
    return null;
  }).filter(Boolean);
}

async function saveImageItemsFromResult(result) {
  const urls = [];
  for (const it of normalizeImageItems(result)) {
    if (it?.b64_json) {
      const u = saveBase64Image(it.b64_json);
      if (u) urls.push(u);
    } else if (it?.url) {
      const u = await saveRemoteImage(it.url);
      urls.push(u);
    }
  }
  return urls;
}

// LLM 多模态 image_url 预处理:
//   上游 LLM 服务(贞贞工坊)无法访问本地 /files/* 路径,需提前转成 base64 dataURL inline。
//   - data: 保留
//   - http(s):// 保留(上游可访问)
//   - /files/* → 本地拉 buffer 转 base64 dataURL
//   对齐 gpt-image-2-web chat 模式处理参考图的思路。
//   零破坏:对于 content 为字符串的普通文本消息不动;仅处理 content 为数组且含 image_url 部分。
async function normalizeLlmMessageImages(messages) {
  if (!Array.isArray(messages)) return messages;
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!part || part.type !== 'image_url' || !part.image_url) continue;
      const url = part.image_url.url;
      if (typeof url !== 'string' || !url) continue;
      // 已是 base64 或外网 URL→不动
      if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://')) continue;
      // 本地路径→转 base64 dataURL
      if (url.startsWith('/files/')) {
        const dataUrl = await refToBananaImage(url);
        if (dataUrl) {
          part.image_url.url = dataUrl;
        } else {
          // 转换失败:报一个明确错误,避免上游 'base64:/files/...' 这种误导报错
          throw new Error(`本地图片读取失败: ${url}`);
        }
      }
      // 其它未知前缀:保留原值,让上游报真错误
    }
  }
  return messages;
}

function geminiOfficialImageSize(model, value) {
  if (String(model || '').trim() === 'gemini-3.1-flash-lite-image') return '1K';
  const raw = String(value || '').trim();
  const upper = raw.toUpperCase();
  if (upper === '1K' || upper === '2K' || upper === '4K') return upper;
  if (raw === '512' || raw.toLowerCase() === '512px') return '512';
  return '';
}

async function buildGeminiOfficialContents(prompt, refs) {
  const parts = [];
  if (Array.isArray(refs) && refs.length) {
    const convertedRefs = await collectConvertedImageRefs(refs, 'Gemini 官方参考图');
    for (const conv of convertedRefs) {
      parts.push({
        inlineData: {
          mimeType: conv.mime || 'image/png',
          data: conv.buf.toString('base64'),
        },
      });
    }
  }
  parts.push({ text: prompt });
  return [{ parts }];
}

// ========================================================================
// 核心 helper:完全对齐主项目 gpt-image-2-web 的上游调用
//   - GPT2 始终走 multipart /v1/images/edits?async=true(line 2869)
//   - 文生图时用 1024x1024 白图占位(line 2861)
//   - GPT2 字段: prompt/model/n/quality/moderation/size(像素串)/aspectRatio(camelCase)/resolution(1k|2k|4k)
//   - nano-banana 文生图: JSON /generations?async=true { prompt, model, aspect_ratio, image_size }
//   - nano-banana 图生图: multipart /edits?async=true 添加 image 多个
//   - Gemini 3 官方图像模型: JSON /v1/models/{model}:generateContent + generationConfig.responseFormat.image
//   - Grok Image: JSON /generations?async=true { model, prompt, aspect_ratio, image:[base64...]? }
// ========================================================================
async function callImageUpstreamAsync({ apiKey, finalApiModel, paramKind, prompt, n, aspect_ratio, image_size, refs, size, quality, response_format, output_format }) {
  const upstreamBase = `${config.ZHENZHEN_BASE_URL}/v1/images`;
  const auth = `Bearer ${apiKey}`;
  const ar = String(aspect_ratio || '').trim();
  const isAuto = !ar || ar === 'Auto' || ar === 'AUTO' || ar === 'empty';
  const lvlLower = String(image_size || '1K').toLowerCase();
  const lvlUpper = String(image_size || '2K').toUpperCase();
  const hasRefs = Array.isArray(refs) && refs.length > 0;

  // ===== Gemini 3 官方图像格式(对齐 Nano Banana 2 Lite / Gemini 3 Pro Image generateContent) =====
  if (isOfficialGeminiImageModel(finalApiModel)) {
    const imageConfig = { aspectRatio: isAuto ? '1:1' : ar };
    const officialImageSize = geminiOfficialImageSize(finalApiModel, image_size || '2K');
    if (officialImageSize) imageConfig.imageSize = officialImageSize;
    const body = {
      contents: await buildGeminiOfficialContents(prompt, refs),
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        responseFormat: {
          image: imageConfig,
        },
      },
    };
    const url = `${config.ZHENZHEN_BASE_URL}/v1/models/${encodeURIComponent(finalApiModel)}:generateContent`;
    console.log('[upstream] Gemini official JSON → generateContent model:', finalApiModel, 'aspectRatio:', imageConfig.aspectRatio, 'imageSize:', imageConfig.imageSize || '', { refs: refs?.length || 0 });
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth,
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });
  }

  // ===== Seedream V5 Pro (OpenAI Dall-e compatible JSON) =====
  // Text-to-image omits image; image editing uses the same endpoint with image[].
  if (paramKind === 'seedream-v5') {
    const seedreamRefs = [];
    if (hasRefs) {
      for (const ref of refs.slice(0, 10)) {
        const converted = await refToBananaImage(ref);
        if (converted) seedreamRefs.push(converted);
      }
      if (seedreamRefs.length === 0) {
        throw new Error('Seedream 参考图读取失败，已中止生成，避免按文生图生成');
      }
    }
    const requestedSize = String(size || image_size || '2048x2048')
      .trim()
      .replace(/\s+/g, '')
      .replace(/[X×]/g, 'x');
    if (!/^\d+x\d+$/.test(requestedSize)) {
      throw new Error(`Seedream 尺寸格式无效: ${requestedSize || '(空)'}，应为 WIDTHxHEIGHT`);
    }
    const body = {
      model: finalApiModel,
      prompt,
      size: requestedSize,
      response_format: response_format === 'b64_json' ? 'b64_json' : 'url',
      output_format: output_format === 'jpeg' ? 'jpeg' : 'png',
    };
    if (seedreamRefs.length) body.image = seedreamRefs;
    const url = `${upstreamBase}/generations`;
    console.log('[upstream] Seedream JSON → /generations model:', finalApiModel, 'size:', body.size, 'output_format:', body.output_format, { requested: refs?.length || 0, converted: seedreamRefs.length });
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify(body),
    });
  }

  // ===== Grok Image 路径(对齐 gpt-image-2-web Tab 12,默认参考图 Base64) =====
  if (paramKind === 'grok-image') {
    const grokRefs = [];
    if (hasRefs) {
      for (const ref of refs.slice(0, 4)) {
        const converted = await refToGrokImage(ref);
        if (converted) grokRefs.push(converted);
      }
      if (grokRefs.length === 0) {
        throw new Error('Grok 参考图读取失败，已中止生成，避免按无参考图生成');
      }
    }
    const body = { model: finalApiModel, prompt, aspect_ratio: isAuto ? '1:1' : ar };
    if (grokRefs.length) body.image = grokRefs;
    const url = `${upstreamBase}/generations?async=true`;
    console.log('[upstream] Grok Image JSON → /generations?async=true model:', finalApiModel, 'aspect_ratio:', body.aspect_ratio, { requested: refs?.length || 0, converted: grokRefs.length });
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify(body),
    });
  }

  // ===== GPT2 总走 multipart /edits?async=true(文生图加白图占位) =====
  if (paramKind === 'gpt-size') {
    const form = new FormData();
    const px = size || aspectToGptSize(ar, lvlLower);
    form.append('prompt', prompt);
    form.append('model', finalApiModel);
    form.append('n', String(n || 1));
    form.append('quality', quality || 'auto');
    form.append('moderation', 'auto');
    form.append('size', px);
    form.append('aspectRatio', isAuto ? '' : ar); // 主项目用 camelCase
    form.append('resolution', lvlLower);          // 主项目用小写 1k/2k/4k

    let convertedRefs = [];
    if (hasRefs) {
      convertedRefs = await collectConvertedImageRefs(refs, 'GPT2 参考图');
      appendConvertedImagesToForm(form, convertedRefs);
    } else {
      // 主项目 line 2861: 无参考图时创建 1024x1024 白图占位
      const whiteBuf = getWhitePng(1024, 1024);
      const blob = new Blob([whiteBuf], { type: 'image/png' });
      form.append('image', blob, 'blank.png');
    }

    const url = `${upstreamBase}/edits?async=true`;
    console.log('[upstream] GPT2 multipart → /edits?async=true model:', finalApiModel, 'size:', px, 'aspectRatio:', ar, 'resolution:', lvlLower, { requested: refs.length, converted: convertedRefs.length });
    return await fetch(url, { method: 'POST', headers: { Authorization: auth }, body: form });
  }

  // ===== nano-banana 路径 =====
  if (hasRefs) {
    // 图生图 → multipart /edits?async=true
    const form = new FormData();
    form.append('prompt', prompt);
    form.append('model', finalApiModel);
    form.append('aspect_ratio', isAuto ? '1:1' : ar);
    form.append('image_size', lvlUpper);
    const convertedRefs = await collectConvertedImageRefs(refs, 'nano-banana 参考图');
    appendConvertedImagesToForm(form, convertedRefs);
    const url = `${upstreamBase}/edits?async=true`;
    console.log('[upstream] nano-banana multipart → /edits?async=true model:', finalApiModel, 'aspect_ratio:', ar, 'image_size:', lvlUpper, { requested: refs.length, converted: convertedRefs.length });
    return await fetch(url, { method: 'POST', headers: { Authorization: auth }, body: form });
  }
  // 文生图 → JSON /generations?async=true
  const body = { prompt, model: finalApiModel, aspect_ratio: isAuto ? '1:1' : ar };
  body.image_size = lvlUpper;
  const url = `${upstreamBase}/generations?async=true`;
  console.log('[upstream] nano-banana JSON → /generations?async=true model:', finalApiModel, 'aspect_ratio:', body.aspect_ratio, 'image_size:', body.image_size);
  return await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify(body),
  });
}

// 将上游响应 normalize 为 { kind: 'sync'|'async', urls?, taskId? }
async function normalizeImageResponse(data) {
  if (imageApiFailed(data)) {
    return { kind: 'failed', error: imageError(data) || '上游图像 API 返回失败' };
  }
  const urls = await saveImageItemsFromResult(data);
  if (urls.length) return { kind: 'sync', urls };
  // 异步任务 task_id
  const taskId = imageTaskId(data);
  if (taskId) return { kind: 'async', taskId };
  return { kind: 'unknown' };
}

function seedreamNzProgress(value, fallback = '0%') {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  return /^\d+(?:\.\d+)?$/.test(text) ? `${text}%` : text;
}

function seedanceNzTrace(value = {}) {
  const requestId = String(value?.requestId || '').trim();
  const upstreamHttpStatus = Number(value?.upstreamHttpStatus);
  const pollCount = value?.pollCount === undefined ? undefined : Math.max(0, Math.trunc(Number(value.pollCount) || 0));
  const usage = value?.usage && typeof value.usage === 'object' && !Array.isArray(value.usage) ? value.usage : undefined;
  return {
    ...(requestId ? { requestId } : {}),
    ...(Number.isInteger(upstreamHttpStatus) && upstreamHttpStatus >= 100 && upstreamHttpStatus <= 599 ? { upstreamHttpStatus } : {}),
    ...(pollCount !== undefined ? { pollCount } : {}),
    ...(usage ? { usage } : {}),
  };
}

// seedance.nz Seedream uses a dedicated async protocol. Keep this route
// isolated from the existing zhenzhen /v1/images/generations implementation.
router.post('/image/seedance-nz/submit', async (req, res) => {
  const settings = loadRawSettings();
  const apiKey = String(settings?.zhenzhenSd2ApiKey || '').trim();
  if (!apiKey) {
    return res.status(400).json({ success: false, error: '请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”' });
  }
  try {
    const result = await seedanceNz.submitImageTask(req.body || {}, apiKey);
    rememberTaskKey(result.taskId, apiKey, {
      provider: 'seedance-nz-image',
      model: result.model,
      taskType: result.taskType,
    });
    return res.json({
      success: true,
      data: {
        sync: false,
        taskId: result.taskId,
        status: 'pending',
        progress: '0%',
        model: result.model,
        taskProvider: 'seedance-nz-image',
        raw: result.raw,
        ...seedanceNzTrace(result),
      },
    });
  } catch (error) {
    const status = Number(error?.status || 500);
    console.error('proxy/image/seedance-nz/submit 错误:', error?.message || error);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: error?.message || 'seedance.nz Seedream 请求失败',
      ...seedanceNzTrace(error),
    });
  }
});

router.get('/image/seedance-nz/status/:tid', async (req, res) => {
  const settings = loadRawSettings();
  const remembered = recallTaskMeta(req.params.tid);
  const apiKey = String(remembered?.apiKey || settings?.zhenzhenSd2ApiKey || '').trim();
  if (!apiKey) {
    return res.status(400).json({ success: false, error: '缺少贞贞的平价AI工坊（国内） API Key' });
  }
  try {
    const result = await seedanceNz.queryImageTask(req.params.tid, apiKey);
    if (result.status === 'succeeded') {
      if (!result.imageUrl) {
        return res.status(502).json({ success: false, error: 'Seedream 任务成功但未返回图片 URL', raw: result.raw, ...seedanceNzTrace(result) });
      }
      const localUrl = await saveRemoteImage(result.imageUrl, seedanceNz.fetchRemote);
      return res.json({
        success: true,
        data: {
          status: 'completed',
          progress: '100%',
          urls: [localUrl],
          remoteUrls: [result.imageUrl],
          raw: result.raw,
          ...seedanceNzTrace(result),
        },
      });
    }
    if (result.status === 'failed') {
      return res.json({
        success: false,
        data: {
          status: 'failed',
          progress: seedreamNzProgress(result.progress, '100%'),
          error: result.failReason || 'Seedream 任务失败',
          raw: result.raw,
          ...seedanceNzTrace(result),
        },
      });
    }
    return res.json({
      success: true,
      data: {
        status: result.status,
        progress: seedreamNzProgress(result.progress),
        raw: result.raw,
        ...seedanceNzTrace(result),
      },
    });
  } catch (error) {
    const status = Number(error?.status || 500);
    console.error('proxy/image/seedance-nz/status 错误:', error?.message || error);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: error?.message || 'seedance.nz Seedream 查询失败',
      ...seedanceNzTrace(error),
    });
  }
});

router.post('/video/happyhorse/submit', async (req, res) => {
  const settings = loadRawSettings();
  const apiKey = String(settings?.zhenzhenSd2ApiKey || '').trim();
  if (!apiKey) {
    return res.status(400).json({ success: false, error: '请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”' });
  }
  try {
    const result = await seedanceNz.submitHappyHorseTask(req.body || {}, apiKey);
    rememberTaskKey(result.taskId, apiKey, {
      provider: 'happyhorse-nz',
      model: result.model,
      taskType: result.taskType,
    });
    return res.json({
      success: true,
      data: {
        taskId: result.taskId,
        model: result.model,
        taskType: result.taskType,
        raw: result.raw,
        ...seedanceNzTrace(result),
      },
    });
  } catch (error) {
    const status = Number(error?.status || 500);
    console.error('proxy/video/happyhorse/submit 错误:', error?.message || error);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: error?.message || 'Happy Horse 请求失败',
      ...seedanceNzTrace(error),
    });
  }
});

router.get('/video/happyhorse/status/:tid', async (req, res) => {
  const settings = loadRawSettings();
  const remembered = recallTaskMeta(req.params.tid);
  const apiKey = String(remembered?.apiKey || settings?.zhenzhenSd2ApiKey || '').trim();
  if (!apiKey) return res.status(400).json({ success: false, error: '缺少贞贞的平价AI工坊（国内） API Key' });
  try {
    const result = await seedanceNz.queryTask(req.params.tid, apiKey);
    let videoUrl = result.videoUrl;
    if (result.status === 'succeeded' && videoUrl) {
      videoUrl = await saveRemoteVideo(videoUrl, seedanceNz.fetchRemote);
    }
    return res.json({
      success: true,
      data: {
        status: result.status,
        progress: result.progress,
        videoUrl,
        failReason: result.failReason,
        model: remembered?.model || '',
        taskType: remembered?.taskType || '',
        raw: result.raw,
        ...seedanceNzTrace(result),
      },
    });
  } catch (error) {
    const status = Number(error?.status || 500);
    console.error('proxy/video/happyhorse/status 错误:', error?.message || error);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: error?.message || 'Happy Horse 查询失败',
      ...seedanceNzTrace(error),
    });
  }
});

router.post('/video/wan/submit', async (req, res) => {
  const settings = loadRawSettings();
  const apiKey = String(settings?.zhenzhenSd2ApiKey || '').trim();
  if (!apiKey) {
    return res.status(400).json({ success: false, error: '请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”' });
  }
  try {
    const result = await seedanceNz.submitWanTask(req.body || {}, apiKey);
    rememberTaskKey(result.taskId, apiKey, {
      provider: 'wan-nz',
      model: result.model,
      taskType: result.taskType,
    });
    return res.json({
      success: true,
      data: {
        taskId: result.taskId,
        model: result.model,
        taskType: result.taskType,
        raw: result.raw,
        ...seedanceNzTrace(result),
      },
    });
  } catch (error) {
    const status = Number(error?.status || 500);
    console.error('proxy/video/wan/submit 错误:', error?.message || error);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: error?.message || 'Wan 2.7 Spicy 请求失败',
      ...seedanceNzTrace(error),
    });
  }
});

router.get('/video/wan/status/:tid', async (req, res) => {
  const settings = loadRawSettings();
  const remembered = recallTaskMeta(req.params.tid);
  const apiKey = String(remembered?.apiKey || settings?.zhenzhenSd2ApiKey || '').trim();
  if (!apiKey) return res.status(400).json({ success: false, error: '缺少贞贞的平价AI工坊（国内） API Key' });
  try {
    const result = await seedanceNz.queryTask(req.params.tid, apiKey);
    let videoUrl = result.videoUrl;
    if (result.status === 'succeeded' && videoUrl) {
      videoUrl = await saveRemoteVideo(videoUrl, seedanceNz.fetchRemote);
    }
    return res.json({
      success: true,
      data: {
        status: result.status,
        progress: result.progress,
        videoUrl,
        failReason: result.failReason,
        model: remembered?.model || '',
        taskType: remembered?.taskType || '',
        raw: result.raw,
        ...seedanceNzTrace(result),
      },
    });
  } catch (error) {
    const status = Number(error?.status || 500);
    console.error('proxy/video/wan/status 错误:', error?.message || error);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: error?.message || 'Wan 2.7 Spicy 查询失败',
      ...seedanceNzTrace(error),
    });
  }
});

router.post('/audio/seed-audio/submit', async (req, res) => {
  const settings = loadRawSettings();
  const apiKey = String(settings?.zhenzhenSd2ApiKey || '').trim();
  if (!apiKey) {
    return res.status(400).json({ success: false, error: '请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”' });
  }
  try {
    const result = await seedanceNz.submitAudioTask(req.body || {}, apiKey);
    rememberTaskKey(result.taskId, apiKey, {
      provider: 'seed-audio-nz',
      model: result.model,
    });
    return res.json({ success: true, data: { taskId: result.taskId, model: result.model, raw: result.raw, ...seedanceNzTrace(result) } });
  } catch (error) {
    const status = Number(error?.status || 500);
    console.error('proxy/audio/seed-audio/submit 错误:', error?.message || error);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: error?.message || 'Seed Audio 请求失败',
      ...seedanceNzTrace(error),
    });
  }
});

router.get('/audio/seed-audio/status/:tid', async (req, res) => {
  const settings = loadRawSettings();
  const remembered = recallTaskMeta(req.params.tid);
  const apiKey = String(remembered?.apiKey || settings?.zhenzhenSd2ApiKey || '').trim();
  if (!apiKey) return res.status(400).json({ success: false, error: '缺少贞贞的平价AI工坊（国内） API Key' });
  try {
    const result = await seedanceNz.queryAudioTask(req.params.tid, apiKey);
    let audioUrl = result.audioUrl;
    if (result.status === 'succeeded' && audioUrl) audioUrl = await saveRemoteAudio(audioUrl);
    return res.json({
      success: true,
      data: {
        status: result.status,
        progress: result.progress,
        audioUrl,
        remoteAudioUrl: result.audioUrl,
        failReason: result.failReason,
        model: remembered?.model || '',
        raw: result.raw,
        ...seedanceNzTrace(result),
      },
    });
  } catch (error) {
    const status = Number(error?.status || 500);
    console.error('proxy/audio/seed-audio/status 错误:', error?.message || error);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: error?.message || 'Seed Audio 查询失败',
      ...seedanceNzTrace(error),
    });
  }
});

router.post('/image', async (req, res) => {
  const settings = loadRawSettings();
  const {
    model, apiModel, paramKind: paramKindIn,
    prompt, n,
    aspect_ratio, image_size,
    images, image, size, quality, response_format, output_format, providerParams,
  } = req.body || {};
  // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
  if (!ensureKeyOrSelectedGroup(settings, res, apiModel || model || '', '图像', providerParams)) return;
  if (!prompt) return res.status(400).json({ success: false, error: 'prompt 必填' });
  const originalApiModel = String(apiModel || model || '');
  const gptImage2ForcedSize = gptImage2ZhenzhenVariantSize(originalApiModel);
  const finalApiModel = normalizeImageApiModel(originalApiModel);
  const ml = `${originalApiModel} ${finalApiModel}`.toLowerCase();
  const paramKind = paramKindIn || (ml.includes('seedream-v5') ? 'seedream-v5' : (ml.includes('grok') && ml.includes('image') ? 'grok-image' : (isBananaImageModel(ml) ? 'banana-ratio' : 'gpt-size')));
  if (!finalApiModel) return res.status(400).json({ success: false, error: 'model 必填' });
  const refs = Array.isArray(images) ? images.filter(Boolean) : [];
  if (typeof image === 'string' && image && !refs.includes(image)) refs.unshift(image);

  try {
    const providerContext = await applyZhenzhenProviderContext(settings, {
      route: 'image',
      kind: 'image',
      model: finalApiModel,
      hint: apiModel || model || '',
      providerParams,
    });
    const r = await callImageUpstreamAsync({
      apiKey: settings.zhenzhenApiKey, finalApiModel, paramKind,
      prompt, n, aspect_ratio, image_size: gptImage2ForcedSize || image_size, refs, size: gptImage2ForcedSize ? undefined : size, quality, response_format, output_format,
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch {
      return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 300) });
    }
    if (!r.ok) {
      const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
      await invalidateZhenzhenProviderKey(providerContext, settings.zhenzhenApiKey, errorText);
      return res.status(r.status).json({
        success: false,
        error: errorText,
      });
    }
    const norm = await normalizeImageResponse(data);
    if (norm.kind === 'failed') {
      await invalidateZhenzhenProviderKey(providerContext, settings.zhenzhenApiKey, norm.error);
      return res.status(500).json({ success: false, error: norm.error || '上游图像任务失败', raw: data });
    }
    if (norm.kind === 'sync') {
      return res.json({ success: true, data: { urls: norm.urls, raw: data, model: finalApiModel, prompt } });
    }
    if (norm.kind === 'async') {
      // 同步接口需要同步返回结果 → 内部轮询
      const url = await pollImageTask(norm.taskId, settings.zhenzhenApiKey);
      if (!url) return res.status(500).json({ success: false, error: '异步任务轮询超时/失败', taskId: norm.taskId });
      return res.json({ success: true, data: { urls: [url], raw: data, taskId: norm.taskId, model: finalApiModel, prompt } });
    }
    return res.status(500).json({ success: false, error: '上游未返回图片也未返 task_id: ' + JSON.stringify(data).slice(0, 300) });
  } catch (e) {
    console.error('proxy/image 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// ========================================================================
// 图像异步任务接口(与主项目 gpt-image-2-web 一致)
// POST /api/proxy/image/submit -> { taskId }(同 submit 逻辑,但不同步轮询)
// GET  /api/proxy/image/status/:tid -> { status, progress, urls? }
// ========================================================================
router.post('/image/submit', async (req, res) => {
  const settings = loadRawSettings();
  try {
    const { model, apiModel, paramKind: paramKindIn, prompt, n,
            aspect_ratio, image_size, images, image, size, quality, response_format, output_format, providerParams } = req.body || {};
    // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
    if (!ensureKeyOrSelectedGroup(settings, res, apiModel || model || '', '图像', providerParams)) return;
    if (!prompt) return res.status(400).json({ success: false, error: 'prompt 不得为空' });
    const originalApiModel = String(apiModel || model || '');
    const gptImage2ForcedSize = gptImage2ZhenzhenVariantSize(originalApiModel);
    const finalApiModel = normalizeImageApiModel(originalApiModel);
    const ml = `${originalApiModel} ${finalApiModel}`.toLowerCase();
    const paramKind = paramKindIn || (ml.includes('seedream-v5') ? 'seedream-v5' : (ml.includes('grok') && ml.includes('image') ? 'grok-image' : (isBananaImageModel(ml) ? 'banana-ratio' : 'gpt-size')));
    if (!finalApiModel) return res.status(400).json({ success: false, error: 'model 必填' });
    const refs = Array.isArray(images) ? images.filter(Boolean) : [];
    if (typeof image === 'string' && image && !refs.includes(image)) refs.unshift(image);

    // 完全对齐主项目 gpt-image-2-web:走 ?async=true,GPT2 强制 multipart edits + 白图占位
    const providerContext = await applyZhenzhenProviderContext(settings, {
      route: 'image/submit',
      kind: 'image',
      model: finalApiModel,
      hint: apiModel || model || '',
      providerParams,
    });
    const r = await callImageUpstreamAsync({
      apiKey: settings.zhenzhenApiKey, finalApiModel, paramKind,
      prompt, n, aspect_ratio, image_size: gptImage2ForcedSize || image_size, refs, size: gptImage2ForcedSize ? undefined : size, quality, response_format, output_format,
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    if (!r.ok) {
      const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
      await invalidateZhenzhenProviderKey(providerContext, settings.zhenzhenApiKey, errorText);
      return res.status(r.status).json({ success: false, error: errorText, raw: data });
    }

    const norm = await normalizeImageResponse(data);
    if (norm.kind === 'failed') {
      await invalidateZhenzhenProviderKey(providerContext, settings.zhenzhenApiKey, norm.error);
      return res.status(500).json({ success: false, error: norm.error || '上游图像任务失败', raw: data });
    }
    if (norm.kind === 'sync') {
      return res.json({ success: true, data: { sync: true, status: 'completed', progress: '100%', urls: norm.urls, raw: data } });
    }
    if (norm.kind === 'async') {
      rememberTaskKey(norm.taskId, settings.zhenzhenApiKey, { model: finalApiModel, ...providerContext.taskMeta });
      return res.json({ success: true, data: { sync: false, taskId: norm.taskId, status: 'pending', progress: '0%', raw: data } });
    }
    return res.status(500).json({ success: false, error: '未获取到 task_id 且无同步结果: ' + JSON.stringify(data).slice(0, 300) });
  } catch (e) {
    console.error('proxy/image/submit 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// 查询异步图像任务状态
router.get('/image/status/:tid', async (req, res) => {
  const settings = loadRawSettings();
  // 优先从 submit 阶段记录的 (taskId → key) 映射恢复，防止前端未传 model 导致 fallback 错 key。
  const rememberedMeta = recallTaskMeta(req.params.tid);
  if (rememberedMeta?.apiKey) {
    if (settings) settings.zhenzhenApiKey = rememberedMeta.apiKey;
    else return res.status(400).json({ success: false, error: '未找到 settings' });
  } else {
    // v1.2.9.15: 一体化「专属优先 fallback 通用」校验（查询阶段可选传 ?model=xxx）
    if (!ensureKey(settings, res, String(req.query.model || ''), '图像')) return;
  }
  const tid = req.params.tid;
  try {
    const url = `${config.ZHENZHEN_BASE_URL}/v1/images/tasks/${encodeURIComponent(tid)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${settings.zhenzhenApiKey}` } });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    if (!r.ok) {
      const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
      await invalidateZhenzhenProviderKey({ taskMeta: rememberedMeta || {} }, settings.zhenzhenApiKey, errorText);
      return res.status(r.status).json({ success: false, error: errorText, raw: data });
    }
    if (imageApiFailed(data)) {
      const errorText = imageError(data) || '任务失败';
      await invalidateZhenzhenProviderKey({ taskMeta: rememberedMeta || {} }, settings.zhenzhenApiKey, errorText);
      return res.json({ success: false, data: { status: 'failed', progress: '0%', error: errorText, raw: data } });
    }
    const statusRaw = imageStatus(data);
    const status = String(statusRaw || '').toLowerCase();
    const inner = data?.data && typeof data.data === 'object' ? data.data : {};
    const progress = inner.progress || data?.progress || '0%';
    const SUCCESS = ['success', 'completed', 'complete', 'done', 'finished'];
    const FAILURE = ['failure', 'failed', 'error', 'cancelled', 'canceled'];
    const urls = await saveImageItemsFromResult(data);
    if (SUCCESS.includes(status) || urls.length) {
      return res.json({ success: true, data: { status: 'completed', progress: '100%', urls, raw: data } });
    }
    if (FAILURE.includes(status)) {
      return res.json({ success: false, data: { status: 'failed', progress, error: imageError(data) || inner.fail_reason || '任务失败', raw: data } });
    }
    res.json({ success: true, data: { status: status || 'pending', progress, raw: data } });
  } catch (e) {
    console.error('proxy/image/status 错误:', e);
    res.status(500).json({ success: false, error: e.message || '查询失败' });
  }
});

// ========== 图像异步任务轮询(同步代理内部使用,路径对齐主项目 /v1/images/tasks/) ==========
// 轮询上限:1800 × 2s = 3600s = 60 分钟,与前端 ImageNode 标准路径保持一致,
// 避免 GPT2 复杂 prompt / 多参考图任务被 120s 提前中断。
async function pollImageTask(taskId, apiKey, maxRetries = 1800, interval = 2000) {
  const url = `${config.ZHENZHEN_BASE_URL}/v1/images/tasks/${encodeURIComponent(taskId)}`;
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { continue; }
      if (!r.ok) continue;
      const st = String(imageStatus(data) || '').toLowerCase();
      const urls = await saveImageItemsFromResult(data);
      if (['success', 'completed', 'complete', 'done', 'finished'].includes(st) || urls.length) {
        return urls[0] || null;
      }
      if (['failure', 'failed', 'error', 'cancelled', 'canceled'].includes(st) || imageApiFailed(data)) {
        console.error('[poll] 任务失败:', imageError(data) || st);
        return null;
      }
    } catch (e) {
      console.warn('[poll] 轮询异常:', e.message);
    }
  }
  return null;
}

// ========================================================================
// FAL 渠道 —— 完全对齐 gpt-image-2-web SKILL.md §FAL模型渠道接入规范
// 不破坏原有 /image · /image/submit · /image/status/:tid 三个路由。
//
// 核心路由:
//   POST /api/proxy/image/fal/submit   -> { sync, urls?, requestId?, responseUrl?, endpoint? }
//   POST /api/proxy/image/fal/query    -> { status, images?, error? }   body: { responseUrl, endpoint, requestId }
//
// 主项目上游协议(index.html line 2890 runGPTFal / line 3587 runNanoFal):
//   URL: ${baseUrl}/fal/${endpoint}
//   Auth: Bearer ${apiKey}
//   GPT FAL  endpoint: 'openai/gpt-image-2' 或 'openai/gpt-image-2/edit'
//   NBPro FAL endpoint: 'fal-ai/nano-banana-pro/edit'
//   参考图上传: POST ${baseUrl}/v1/files  (复用现有 uploadRefToZhenzhen)
//   response_url 域名修复: queue.fal.run → ${baseUrl}/fal
//   轮询 HTTP 非200时 body 中 status=IN_QUEUE/IN_PROGRESS 仍视为进行中
// ========================================================================

const FAL_REGISTRY = {
  'gpt-image-2-fal': {
    endpoint: 'openai/gpt-image-2',
    editEndpoint: 'openai/gpt-image-2/edit',
    paramKind: 'gpt-fal',
    maxRefs: 5,
  },
  'nano-banana-pro-fal': {
    endpoint: 'fal-ai/nano-banana-pro/edit',
    editEndpoint: 'fal-ai/nano-banana-pro/edit',
    paramKind: 'nbpro-fal',
    maxRefs: 8,
  },
  // 主项目 runGeminiFal (line 3491) 与 runNanoFal 共用同一 fal-ai/nano-banana-pro/edit 端点 + 同 paramKind。
  // 只是 UI 控件 id 前缀不同 (g2f_* vs nf_*)。后端零增量分支，复用 nbpro-fal payload 组装。
  'nano-banana-2-fal': {
    endpoint: 'fal-ai/nano-banana-pro/edit',
    editEndpoint: 'fal-ai/nano-banana-pro/edit',
    paramKind: 'nbpro-fal',
    maxRefs: 8,
  },
};

// 按 16 倍数对齐(主项目 line 2904)
function snap16(v, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(256, Math.min(3840, Math.round(n / 16) * 16));
}

// 修复 response_url 域名(主项目 line 2954)
function fixFalResponseUrl(responseUrl, baseUrl, endpoint, requestId) {
  let url = String(responseUrl || '');
  if (url.includes('queue.fal.run')) {
    url = url.replace('https://queue.fal.run', `${baseUrl}/fal`);
  }
  if (!url) {
    const requestEndpoint = String(endpoint || '').startsWith('fal-ai/sora-2/')
      ? 'fal-ai/sora-2'
      : endpoint;
    url = `${baseUrl}/fal/${requestEndpoint}/requests/${requestId}`;
  }
  return url;
}

// POST /api/proxy/image/fal/submit
//   body 公用: { apiModel, prompt, images?, n?, format?, sync?, ... }
//   gpt-fal 专属: { mode?: 'edit'|'gen', size?: '1024x1024'|'square'|...|'custom', customW?, customH?, quality?: low|medium|high|auto }
//   nbpro-fal 专属: { aspect_ratio, resolution, safety_tolerance, seed?, system_prompt?, enable_web_search?, image_mode?: 'image_url'|'base64' }
router.post('/image/fal/submit', async (req, res) => {
  const settings = loadRawSettings();
  const {
    apiModel, prompt, images, n, format, sync,
    // gpt-fal
    mode, size, customW, customH, quality,
    // nbpro-fal
    aspect_ratio, resolution, safety_tolerance, seed,
    system_prompt, enable_web_search, image_mode,
  } = req.body || {};
  // FAL 全部固定使用通用贞贞 API Key，不参与 New API 分组令牌。
  if (!ensureDefaultZhenzhenKey(settings, res, '图像 FAL')) return;
  let apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;

  if (!apiModel) return res.status(400).json({ success: false, error: 'apiModel 必填' });
  if (!prompt) return res.status(400).json({ success: false, error: 'prompt 不得为空' });

  const reg = FAL_REGISTRY[apiModel];
  if (!reg) return res.status(400).json({ success: false, error: `未知的 FAL 模型: ${apiModel}` });

  const refs = Array.isArray(images) ? images.filter(Boolean) : [];
  const trimmedRefs = refs.slice(0, reg.maxRefs);
  const numImages = Math.max(1, Math.min(4, parseInt(n ?? 1, 10) || 1));
  const outputFormat = String(format || 'png').toLowerCase();

  // ========== 根据 paramKind 组装 payload ==========
  let payload;
  let endpoint;
  try {
    if (reg.paramKind === 'gpt-fal') {
      // 选 endpoint: edit 或 gen
      const useEdit = (mode === 'edit') || (mode !== 'gen' && trimmedRefs.length > 0);
      endpoint = useEdit ? (reg.editEndpoint || reg.endpoint) : reg.endpoint;
      // image_size
      let imageSize;
      const sz = String(size || 'auto');
      if (sz === 'custom') {
        imageSize = { width: snap16(customW, 1280), height: snap16(customH, 1280) };
      } else if (sz && sz !== 'auto') {
        imageSize = sz; // 预设字串 square_hd / portrait_16_9 等,或像素串
      }
      payload = {
        prompt,
        quality: String(quality || 'medium'),
        num_images: numImages,
        output_format: outputFormat,
      };
      if (imageSize) payload.image_size = imageSize;
      // image_urls 仅在 edit 下添加
      if (useEdit && trimmedRefs.length) {
        const urls = [];
        for (let i = 0; i < trimmedRefs.length; i++) {
          const u = await uploadRefToZhenzhen(trimmedRefs[i], apiKey);
          if (u) urls.push(u);
          else throw new Error(`FAL 参考图 #${i + 1} 上传失败`);
        }
        if (urls.length) payload.image_urls = urls;
      }
      if (sync === true || sync === 'true') payload.sync_mode = true;
    } else if (reg.paramKind === 'nbpro-fal') {
      // nano-banana-pro 只有 edit 端点
      endpoint = reg.endpoint;
      payload = {
        prompt,
        num_images: numImages,
        aspect_ratio: String(aspect_ratio || 'auto'),
        resolution: String(resolution || '2K'),
        output_format: outputFormat,
        safety_tolerance: String(safety_tolerance || '4'),
      };
      if (seed && Number(seed) > 0) payload.seed = Number(seed);
      if (system_prompt) payload.system_prompt = String(system_prompt);
      if (enable_web_search === true || enable_web_search === 'true') payload.enable_web_search = true;
      // 参考图(最多 8 张)
      if (trimmedRefs.length) {
        const imgs = [];
        const useBase64 = String(image_mode || 'image_url') === 'base64';
        for (let i = 0; i < trimmedRefs.length; i++) {
          const r = trimmedRefs[i];
          if (useBase64) {
            // 转 base64 dataURI
            const conv = await refToBananaImage(r);
            if (conv) imgs.push(conv);
          } else {
            const u = await uploadRefToZhenzhen(r, apiKey);
            if (u) imgs.push(u);
            else throw new Error(`FAL 参考图 #${i + 1} 上传失败`);
          }
        }
        if (imgs.length) payload.image_urls = imgs;
      }
    } else {
      return res.status(400).json({ success: false, error: `不支持的 FAL paramKind: ${reg.paramKind}` });
    }

    const falUrl = `${baseUrl}/fal/${endpoint}`;
    console.log('[fal/submit]', apiModel, '→', falUrl, '| payload keys:', Object.keys(payload), '| refs:', trimmedRefs.length);

    const resp = await fetch(falUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    if (!resp.ok) {
      return res.status(resp.status).json({
        success: false,
        error: data?.error || data?.detail || data?.message || `FAL HTTP ${resp.status}: ${text.slice(0, 300)}`,
      });
    }
    if (Array.isArray(data)) {
      return res.status(400).json({ success: false, error: `FAL 参数校验错误: ${JSON.stringify(data).slice(0, 300)}` });
    }
    if (data?.detail && !data?.images && !data?.request_id) {
      return res.status(400).json({ success: false, error: `FAL 错误: ${JSON.stringify(data.detail).slice(0, 300)}` });
    }

    // 同步返回
    if (Array.isArray(data?.images) && data.images.length) {
      const urls = [];
      for (const it of data.images) {
        if (it?.url) {
          const local = await saveRemoteImage(it.url);
          urls.push(local);
        }
      }
      return res.json({ success: true, data: { sync: true, urls, endpoint, raw: data } });
    }

    // 异步
    const requestId = data?.request_id;
    let responseUrl = data?.response_url || '';
    if (!requestId) {
      return res.status(500).json({ success: false, error: '未获取到 request_id: ' + JSON.stringify(data).slice(0, 300) });
    }
    responseUrl = fixFalResponseUrl(responseUrl, baseUrl, endpoint, requestId);
    rememberTaskKey(requestId, apiKey, { model: apiModel, endpoint });
    return res.json({
      success: true,
      data: { sync: false, requestId, responseUrl, endpoint, raw: data },
    });
  } catch (e) {
    console.error('proxy/image/fal/submit 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// POST /api/proxy/image/fal/query
//   body: { responseUrl, endpoint, requestId }
//   返回: { status: 'pending'|'completed'|'failed', urls?, error? }
router.post('/image/fal/query', async (req, res) => {
  const settings = loadRawSettings();
  const { responseUrl: rawUrl, endpoint, requestId } = req.body || {};
  const rememberedMeta = recallTaskMeta(requestId);
  if (rememberedMeta?.apiKey) {
    if (settings) settings.zhenzhenApiKey = rememberedMeta.apiKey;
    else return res.status(400).json({ success: false, error: '未找到 settings' });
  } else {
    // FAL 查询和提交保持同一策略：只用通用贞贞 API Key。
    if (!ensureDefaultZhenzhenKey(settings, res, '图像 FAL')) return;
  }
  const apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;
  const responseUrl = fixFalResponseUrl(rawUrl, baseUrl, endpoint, requestId);
  if (!responseUrl) return res.status(400).json({ success: false, error: 'responseUrl 或 (endpoint+requestId) 必填' });

  try {
    const pr = await fetch(responseUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    const text = await pr.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    // HTTP 非200: 主项目规范 - body 中 status=IN_QUEUE/IN_PROGRESS 视为继续等待,其他报错
    if (!pr.ok) {
      if (data && (data.status === 'IN_QUEUE' || data.status === 'IN_PROGRESS')) {
        return res.json({ success: true, data: { status: 'pending', raw: data } });
      }
      return res.status(pr.status).json({
        success: false,
        error: `FAL Poll HTTP ${pr.status}: ${text.slice(0, 300)}`,
        raw: data,
      });
    }
    if (!data) {
      return res.status(500).json({ success: false, error: 'FAL Poll 响应非 JSON: ' + text.slice(0, 200) });
    }
    // 完成
    if (Array.isArray(data.images) && data.images.length) {
      const urls = [];
      for (const it of data.images) {
        if (it?.url) {
          const local = await saveRemoteImage(it.url);
          urls.push(local);
        }
      }
      return res.json({ success: true, data: { status: 'completed', urls, raw: data } });
    }
    const st = String(data.status || '').toUpperCase();
    if (st === 'FAILED' || st === 'CANCELLED') {
      return res.json({
        success: false,
        data: { status: 'failed', error: data.error || data.detail || `FAL ${st}` },
      });
    }
    // IN_QUEUE / IN_PROGRESS / 空 => pending
    return res.json({ success: true, data: { status: 'pending', falStatus: st || 'IN_QUEUE', raw: data } });
  } catch (e) {
    console.error('proxy/image/fal/query 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '查询失败' });
  }
});

// ============================================================================
// Midjourney 三路由：严格对齐 gpt-image-2-web server.py _handle_mj_imagine / _handle_mj_fetch_task / _handle_mj_upload
//   上游：{ZHENZHEN_BASE_URL}/{mj-turbo|mj-fast|mj-relax}/mj/submit/imagine
//          {ZHENZHEN_BASE_URL}/{...}/mj/task/{id}/fetch
//          {ZHENZHEN_BASE_URL}/{...}/mj/submit/upload-discord-images
//   服从贞贞工坊集中 Key（同上其他 zhenzhen 路由）。
// ============================================================================
const MJ_SPEED_MAP = { turbo: 'mj-turbo', fast: 'mj-fast', relax: 'mj-relax' };
function mjSpeedSeg(speed) {
  return MJ_SPEED_MAP[String(speed || '').toLowerCase()] || 'mj-fast';
}

// ---- POST /api/proxy/mj/imagine ----
// body: { prompt, ar?, no?, c?, s?, iw?, sw?, cw?, sv?, seed?, base64Array?, speed?, modes?, instanceId?, notifyHook?, remix? }
// 返回上游 imagine 原始响应 { code, description, result(taskId), properties }
router.post('/mj/imagine', async (req, res) => {
  const settings = loadRawSettings();
  // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
  if (!ensureKey(settings, res, 'mj', 'MJ')) return;
  const body = req.body || {};
  const speedSeg = mjSpeedSeg(body.speed);
  const url = `${config.ZHENZHEN_BASE_URL}/${speedSeg}/mj/submit/imagine`;
  // 严格对齐主项目 runMJ payload（index.html L4547~L4587）
  const payload = {
    base64Array: Array.isArray(body.base64Array) ? body.base64Array : [],
    instanceId: body.instanceId || '',
    modes: Array.isArray(body.modes) ? body.modes : [],
    notifyHook: body.notifyHook || '',
    prompt: String(body.prompt || ''),
    remix: body.remix !== false,
    state: body.state || '',
    ar: body.ar || null,
    no: body.no || null,
    c: body.c || null,
    s: body.s || null,
    iw: body.iw || null,
    tile: false,
    r: null,
    video: false,
    sw: body.sw || null,
    cw: body.cw || null,
    sv: body.sv || null,
    seed: body.seed || null,
  };
  try {
    console.log(`[mj/imagine] -> ${url}\n  prompt: ${payload.prompt.slice(0, 200)}`);
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.zhenzhenApiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) }); }
    if (!r.ok) return res.status(r.status).json({ success: false, error: data?.error || data?.description || `上游 HTTP ${r.status}` });
    return res.json({ success: true, data });
  } catch (e) {
    console.error('proxy/mj/imagine 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '提交失败' });
  }
});

// ---- GET /api/proxy/mj/task/:id?speed=fast ----
// 轮询任务状态
router.get('/mj/task/:id', async (req, res) => {
  const settings = loadRawSettings();
  // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
  if (!ensureKey(settings, res, 'mj', 'MJ')) return;
  const taskId = req.params.id;
  const speedSeg = mjSpeedSeg(req.query.speed);
  if (!taskId) return res.status(400).json({ success: false, error: 'taskId 必填' });
  const url = `${config.ZHENZHEN_BASE_URL}/${speedSeg}/mj/task/${encodeURIComponent(taskId)}/fetch`;
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.zhenzhenApiKey}`,
      },
    });
    const raw = await r.text();
    let data;
    try { data = JSON.parse(raw); } catch { return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + raw.slice(0, 200) }); }
    if (!r.ok) return res.status(r.status).json({ success: false, error: data?.error || data?.description || `上游 HTTP ${r.status}` });
    // image_urls 可能是 JSON 字符串也可能已是数组，透传，让前端统一处理
    return res.json({ success: true, data });
  } catch (e) {
    console.error('proxy/mj/task 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '查询失败' });
  }
});

// ---- POST /api/proxy/mj/upload ----
// body: { base64Data: 'data:image/png;base64,xxxx', speed? }
// 上传参考图到 MJ Discord，返回 URL（主项目 uploadMJImage L4407 + server.py L2457）
router.post('/mj/upload', async (req, res) => {
  const settings = loadRawSettings();
  // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
  if (!ensureKey(settings, res, 'mj', 'MJ')) return;
  const { base64Data, speed } = req.body || {};
  if (!base64Data) return res.status(400).json({ success: false, error: 'base64Data 不得为空' });
  const speedSeg = mjSpeedSeg(speed);
  const url = `${config.ZHENZHEN_BASE_URL}/${speedSeg}/mj/submit/upload-discord-images`;
  const payload = { base64Array: [base64Data], instanceId: '', notifyHook: '' };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.zhenzhenApiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) }); }
    if (!r.ok) return res.status(r.status).json({ success: false, error: data?.error || data?.description || `上游 HTTP ${r.status}` });
    if (data.status === 'FAILURE') return res.status(500).json({ success: false, error: data.fail_reason || data.failReason || 'MJ upload failed' });
    let imgUrl = '';
    if (Array.isArray(data.result)) imgUrl = data.result[0] || '';
    else if (typeof data.result === 'string') imgUrl = data.result;
    if (!imgUrl) return res.status(500).json({ success: false, error: '上游未返回 URL: ' + JSON.stringify(data).slice(0, 200) });
    return res.json({ success: true, data: { url: imgUrl, raw: data } });
  } catch (e) {
    console.error('proxy/mj/upload 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '上传失败' });
  }
});

// ========== POST /api/proxy/llm — LLM Chat(独立 Key) ==========
function hasLlmVideoParts(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((msg) => Array.isArray(msg?.content) && msg.content.some((part) => (
    part?.type === 'video_url' || part?.type === 'input_video' || !!part?.video_url || !!part?.input_video
  )));
}

// body: { model, messages, temperature?, max_tokens?, stream?, llmVideoMode? }
//   - messages[i].content 支持 string 或 多模态数组 [{type:'text',text} | {type:'image_url',image_url:{url}} | {type:'video_url',video_url:{url}}]
//   - stream=true → 透传上游 SSE(text/event-stream) 到前端；有视频时强制非流式，避免网关丢多模态附件
//   - 完全对齐 gpt-image-2-web _doSendChat (index.html L8128~L8305)
router.post('/llm', async (req, res) => {
  const settings = loadRawSettings();
  if (!settings?.llmApiKey) {
    return res.status(400).json({ success: false, error: '未配置 LLM 独立 API Key' });
  }
  const { model, messages, temperature, max_tokens, stream } = req.body || {};
  if (!model || !messages) {
    return res.status(400).json({ success: false, error: 'model 和 messages 必填' });
  }
  const inputHadVideos = hasLlmVideoParts(messages);

  // 预处理 messages 中的 image_url / video_url:
  //   - 图片: 本地 /files/* 转 base64 dataURL
  //   - 视频: 默认用项目内置 ffmpeg 抽关键帧转 image_url；或按用户选择发送原视频 Base64 / URL
  // 避免上游 LLM 服务拿着本地相对路径报 convert_request_failed。
  let normalizedMessages;
  try {
    normalizedMessages = await normalizeLlmMessageMedia(messages, req.body || {}, {
      baseUrl: `http://127.0.0.1:${config.PORT}`,
    });
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message || '多模态素材预处理失败' });
  }

  const upstream = `${config.ZHENZHEN_BASE_URL}/v1/chat/completions`;
  const payload = {
    model,
    messages: normalizedMessages,
    temperature: temperature ?? 0.7,
    max_tokens: max_tokens ?? 16384,
    stream: !!stream && !inputHadVideos,
  };

  try {
    const r = await fetch(upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.llmApiKey}`,
      },
      body: JSON.stringify(payload),
    });

    // ===== 流式分支:SSE pass-through =====
    if (payload.stream) {
      if (!r.ok) {
        const errText = await r.text();
        return res.status(r.status).json({
          success: false,
          error: `上游 HTTP ${r.status}: ${errText.slice(0, 300)}`,
        });
      }
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      // Node 18+ fetch response.body 为 ReadableStream
      try {
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        // 透传上游字节,前端按 SSE 解析
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } catch (streamErr) {
        console.error('proxy/llm SSE 转发异常:', streamErr);
      }
      return res.end();
    }

    // ===== 非流式分支(gpt-image-2-all 等) =====
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) });
    }
    if (!r.ok) {
      return res.status(r.status).json({
        success: false,
        error: data?.error?.message || `上游 HTTP ${r.status}`,
      });
    }
    // 处理 content 可能是字符串或多模态数组(gpt-image-2-all 出图)
    const choice = data?.choices?.[0];
    let content = choice?.message?.content || '';
    const imageUrls = [];
    if (Array.isArray(content)) {
      let textParts = '';
      content.forEach((part) => {
        if (part?.type === 'text') textParts += part.text || '';
        else if (part?.type === 'image_url' && part.image_url?.url) imageUrls.push(part.image_url.url);
        else if (part?.type === 'image' && part.image_url?.url) imageUrls.push(part.image_url.url);
      });
      content = textParts;
    }
    if (Array.isArray(data?.data)) {
      data.data.forEach((d) => {
        if (d?.url) imageUrls.push(d.url);
        else if (d?.b64_json) imageUrls.push('data:image/png;base64,' + d.b64_json);
      });
    }
    const finishReason = choice?.finish_reason || choice?.finishReason || '';
    res.json({
      success: true,
      data: {
        content,
        imageUrls,
        raw: data,
        model,
        finishReason,
        truncated: ['length', 'max_tokens', 'content_length'].includes(String(finishReason || '').toLowerCase()),
      },
    });
  } catch (e) {
    console.error('proxy/llm 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// ========================================================================
// 视频生成(异步) — 完全对齐 gpt-image-2-web
// 协议(贞贞工坊): POST /v2/videos/generations + GET /v2/videos/generations/:tid
//
// 通过 model 字段自动选择上游 payload 协议:
//   - veo-omni-10s  → Veo Omni 协议: POST /v1/videos multipart
//                      { model=omni_flash-10s, prompt, size, seconds=10, watermark, input_reference }
//   - 含 'veo'      → Veo3.1 协议:  { prompt, model, enhance_prompt, aspect_ratio, seed?, enable_upsample?, images?(base64,最多3) }
//                       (主项目 runVeo3, index.html line 3372)
//   - 含 'grok'     → Grok Video 协议: { prompt, model, ratio, duration(数字秒), resolution, seed?, images?(URL,最多7) }
//                       (主项目 runGrok3, index.html line 3863) — 参考图先 POST /v1/files 取 URL
//   - 其它(seedance 等)→ 沿用旧 Veo 字段(零破坏)
// ========================================================================

// 上传本地/远端参考素材到上游 /v1/files 取 URL
// 对齐 gpt-image-2-web 的 uploadFileToAPI: Seedance 的图像、视频、音频都不能直接传 /files/* 本地 URL。
async function uploadRefToZhenzhen(ref, apiKey, label = '参考素材') {
  if (typeof ref !== 'string' || !ref) throw new Error(`${label} 上传失败: 引用为空`);
  const trimmed = ref.trim();
  if (/^asset-[a-z0-9_-]+$/i.test(trimmed)) return trimmed;
  let buf, mime, ext;
  if (trimmed.startsWith('data:')) {
    const m = trimmed.match(/^data:([^;,]+);base64,(.+)$/);
    if (!m) throw new Error(`${label} 上传失败: data URL 格式无效`);
    mime = m[1] || 'image/png';
    buf = Buffer.from(m[2], 'base64');
    ext = extFromContentType(mime) || (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
  } else if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('/files/') ||
    trimmed.startsWith('/api/resources/file/') ||
    trimmed.startsWith('/api/resources/set-file/')
  ) {
    const url = trimmed.startsWith('/') ? `http://127.0.0.1:${config.PORT}${trimmed}` : trimmed;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${label} 上传失败: 读取素材 HTTP ${r.status}`);
    mime = r.headers.get('content-type') || 'image/png';
    buf = Buffer.from(await r.arrayBuffer());
    const tailExt = url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,8})$/i)?.[1];
    ext = extFromContentType(mime) || tailExt || (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
  } else {
    throw new Error(`${label} 上传失败: 不支持的引用地址`);
  }
  const fd = new FormData();
  const blob = new Blob([buf], { type: mime });
  fd.append('file', blob, `ref_${Date.now()}.${ext}`);
  const upR = await fetch(`${config.ZHENZHEN_BASE_URL}/v1/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });
  const upText = await upR.text();
  const preview = String(upText || '').replace(/\s+/g, ' ').slice(0, 300);
  if (!upR.ok) {
    console.warn('[video] /v1/files 上传失败', label, 'status=', upR.status, preview);
    throw new Error(`${label} 上传失败: /v1/files HTTP ${upR.status} ${preview}`);
  }
  let j;
  try {
    j = upText ? JSON.parse(upText) : {};
  } catch {
    throw new Error(`${label} 上传失败: /v1/files 返回非 JSON ${preview}`);
  }
  const uploadedUrl = j?.url || j?.file_url || j?.data?.url || j?.data?.file_url || null;
  if (!uploadedUrl) throw new Error(`${label} 上传失败: /v1/files 未返回 url ${preview}`);
  return uploadedUrl;
}

// ========================================================================
// Video FAL 渠道 — 完全对齐 gpt-image-2-web runVeo3Fal / runGrokFal
// 不破坏原有 /video/submit · /video/query 路由。
//
// POST /api/proxy/video/fal/submit  → { sync, videoUrl?, requestId?, responseUrl?, endpoint? }
// POST /api/proxy/video/fal/query   → { status, videoUrl?, error? }   body: { responseUrl, endpoint, requestId }
// ========================================================================

const VIDEO_FAL_REGISTRY = {
  'veo3.1-fal': {
    endpoint: 'fal-ai/veo3.1/fast/reference-to-video',
    paramKind: 'veo-fal',
    maxRefImages: 3,
  },
  'grok-video-fal': {
    endpoint: 'xai/grok-imagine-video/text-to-video',
    i2vEndpoint: 'xai/grok-imagine-video/image-to-video',
    referenceEndpoint: 'xai/grok-imagine-video/reference-to-video',
    paramKind: 'grok-fal',
    maxRefImages: 7,
    defaultImageMode: 'base64',
  },
  'grok-imagine-video-1.5': {
    endpoint: 'xai/grok-imagine-video/v1.5/image-to-video',
    paramKind: 'grok-fal',
    maxRefImages: 1,
    defaultImageMode: 'base64',
    requiresImage: true,
    disableAspectRatio: true,
  },
  'sora-2': {
    endpoint: 'fal-ai/sora-2/text-to-video',
    i2vEndpoint: 'fal-ai/sora-2/image-to-video',
    paramKind: 'sora-fal',
    maxRefImages: 1,
    defaultImageMode: 'base64',
  },
};

function getFalVideoUrl(data) {
  const video = data && data.video;
  if (video && typeof video === 'object' && video.url) return video.url;
  if (typeof video === 'string') return video;
  return data?.video_url
    || data?.url
    || data?.output?.video?.url
    || data?.data?.output
    || data?.data?.video_url
    || data?.data?.video?.url
    || '';
}

function splitSoraCharacterIds(raw) {
  return String(raw || '')
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2);
}

function splitGrokReferenceUrls(raw) {
  const values = Array.isArray(raw) ? raw : String(raw || '').split(/[,，\n]/);
  return values
    .map((s) => String(s || '').trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

function stripDataUrlPrefix(value) {
  const text = String(value || '').trim();
  const match = /^data:[^,;]+;base64,(.+)$/i.exec(text);
  return match ? match[1].trim() : text;
}

const VEO_OMNI_PUBLIC_MODEL = 'veo-omni-10s';
const VEO_OMNI_UPSTREAM_MODEL = 'omni_flash-10s';
const GROK_VIDEO_1_5_NEW_MODELS = new Set([
  'grok-1.5-video-6s',
  'grok-1.5-video-10s',
  'grok-1.5-video-15s',
]);

function isVeoOmniModel(model) {
  const m = String(model || '').trim().toLowerCase();
  return m === VEO_OMNI_PUBLIC_MODEL || m === VEO_OMNI_UPSTREAM_MODEL;
}

function isGrokVideo15NewModel(model) {
  const m = String(model || '').trim().toLowerCase();
  return GROK_VIDEO_1_5_NEW_MODELS.has(m);
}

function veoOmniSizeFromAspect(aspectRatio) {
  return String(aspectRatio || '').trim() === '9:16' ? '720x1280' : '1280x720';
}

function grokVideo15NewSizeFromRatio(ratioOrSize) {
  const value = String(ratioOrSize || '').trim();
  if (value === '720x1280') return '720x1280';
  if (value === '9:16') return '720x1280';
  return '1280x720';
}

async function appendGrokVideo15InputReference(form, ref) {
  const refText = String(ref || '').trim();
  if (!refText) return false;
  if (/^https?:\/\//i.test(refText)) {
    form.append('input_reference', refText);
    return true;
  }
  const conv = await refToBuffer(refText);
  if (!conv) return false;
  form.append('input_reference', new Blob([conv.buf], { type: conv.mime || 'image/png' }), `input_reference.${conv.ext || 'png'}`);
  return true;
}

function normalizeVideoTaskStatus(status) {
  const raw = String(status || '').trim();
  const lower = raw.toLowerCase();
  if (['success', 'succeeded', 'completed', 'complete', 'done'].includes(lower)) return 'SUCCESS';
  if (['failure', 'failed', 'error', 'cancelled', 'canceled'].includes(lower)) return 'FAILURE';
  if (['running', 'processing', 'in_progress', 'in-progress'].includes(lower)) return 'RUNNING';
  if (['queued', 'pending', 'created', 'submitted'].includes(lower)) return 'PENDING';
  return raw.toUpperCase();
}

function stringifyUpstreamErrorValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    if (typeof value.message === 'string') return value.message.trim();
    if (typeof value.msg === 'string') return value.msg.trim();
    if (typeof value.detail === 'string') return value.detail.trim();
    try { return JSON.stringify(value).slice(0, 500); } catch { return ''; }
  }
  return String(value).trim();
}

function getUpstreamErrorMessage(data, text, status) {
  const candidates = [
    data?.error?.message,
    data?.error,
    data?.message,
    data?.msg,
    data?.detail,
    data?.error_msg,
    data?.fail_reason,
    data?.data?.error?.message,
    data?.data?.error,
    data?.data?.message,
    data?.data?.msg,
    data?.data?.detail,
    data?.data?.fail_reason,
  ];
  for (const candidate of candidates) {
    const msg = stringifyUpstreamErrorValue(candidate);
    if (msg) return `上游 HTTP ${status}: ${msg}`;
  }
  const rawText = String(text || '').trim();
  if (rawText) return `上游 HTTP ${status}: ${rawText.slice(0, 500)}`;
  return `上游 HTTP ${status}`;
}

// 保存远程视频到本地
async function saveRemoteVideo(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`下载失败: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = (url.match(/\.(mp4|webm|mov)/i)?.[1] || 'mp4').toLowerCase();
    const filename = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const filePath = path.join(config.OUTPUT_DIR, filename);
    fs.writeFileSync(filePath, buf);
    return `/files/output/${filename}`;
  } catch (e) {
    console.error('⚠ 转存视频失败:', e.message);
    return url;
  }
}

// POST /api/proxy/video/fal/submit
router.post('/video/fal/submit', async (req, res) => {
  const settings = loadRawSettings();
  const {
    apiModel, prompt, images,
    // veo-fal
    aspect_ratio, duration, resolution, generate_audio, safety_tolerance, image_mode,
    // grok-fal
    gkDuration, gkRatio, gkMode, gkReferenceUrls,
    // sora-fal
    soraMode, soraRatio, soraDuration, soraResolution, soraDeleteVideo, soraBlockIp, soraCharacterIds,
  } = req.body || {};
  const rawApiModel = String(apiModel || '').trim();
  // 历史节点里可能保存过日期版 Sora2 选项；T8 现在只暴露稳定的 sora-2 FAL。
  const effectiveApiModel = /^sora-2(?:-\d{4}-\d{2}-\d{2})?$/.test(rawApiModel) ? 'sora-2' : rawApiModel;
  // FAL 全部固定使用通用贞贞 API Key，不参与 New API 分组令牌。
  if (!ensureDefaultZhenzhenKey(settings, res, '视频 FAL')) return;
  let apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;

  if (!rawApiModel) return res.status(400).json({ success: false, error: 'apiModel 必填' });
  if (!prompt) return res.status(400).json({ success: false, error: 'prompt 不得为空' });

  const reg = VIDEO_FAL_REGISTRY[effectiveApiModel];
  if (!reg) return res.status(400).json({ success: false, error: `未知的 Video FAL 模型: ${rawApiModel}` });

  const refs = Array.isArray(images) ? images.filter(Boolean) : [];
  const trimmedRefs = refs.slice(0, reg.maxRefImages);

  let payload;
  let endpoint;
  try {
    if (reg.paramKind === 'veo-fal') {
      // ===== Veo3.1 FAL (主项目 runVeo3Fal line 3694) =====
      endpoint = reg.endpoint;
      payload = {
        prompt,
        aspect_ratio: String(aspect_ratio || '16:9'),
        duration: String(duration || '8s'),
        resolution: String(resolution || '720p'),
        generate_audio: generate_audio === true,
        safety_tolerance: parseInt(safety_tolerance ?? 4, 10) || 4,
      };
      // 参考图(最多 3 张)
      if (trimmedRefs.length) {
        const imgArr = [];
        const useBase64 = String(image_mode || 'image_url') === 'base64';
        for (let i = 0; i < trimmedRefs.length; i++) {
          if (useBase64) {
            // base64 直传
            const conv = await refToBananaImage(trimmedRefs[i]);
            if (conv) imgArr.push(conv);
          } else {
            const u = await uploadRefToZhenzhen(trimmedRefs[i], apiKey);
            if (u) imgArr.push(u);
            else throw new Error(`FAL 参考图 #${i + 1} 上传失败`);
          }
        }
        if (imgArr.length) payload.image_urls = imgArr;
      }
    } else if (reg.paramKind === 'grok-fal') {
      // ===== Grok Video FAL (主项目 runGrokFal line 3787) =====
      const isV15 = effectiveApiModel === 'grok-imagine-video-1.5';
      const mode = isV15
        ? 'image_to_video'
        : String(gkMode || 'image_to_video') === 'reference_to_video' ? 'reference_to_video' : 'image_to_video';
      const extraReferenceUrls = splitGrokReferenceUrls(gkReferenceUrls);
      const hasImg = trimmedRefs.length > 0;
      const effectiveRatio = (mode === 'reference_to_video' || !hasImg) && String(gkRatio || '16:9') === 'auto'
        ? '16:9'
        : String(gkRatio || '16:9');
      payload = {
        prompt,
        duration: parseInt(gkDuration ?? 6, 10) || 6,
        resolution: String(resolution || '720p'),
      };
      if (!isV15) payload.aspect_ratio = effectiveRatio;
      const useBase64 = String(image_mode || reg.defaultImageMode || 'base64') === 'base64';
      if (isV15) {
        endpoint = reg.endpoint;
        if (!hasImg) throw new Error('Grok Video 1.5 requires one uploaded image');
        const imgData = useBase64
          ? await refToBananaImage(trimmedRefs[0])
          : await uploadRefToZhenzhen(trimmedRefs[0], apiKey);
        if (imgData) payload.image_url = imgData;
        else throw new Error('Grok Video 1.5 参考图处理失败');
      } else if (mode === 'reference_to_video') {
        endpoint = reg.referenceEndpoint || reg.i2vEndpoint || reg.endpoint;
        const referenceImageUrls = [];
        const uploadRefs = trimmedRefs.slice(0, 7);
        for (let i = 0; i < uploadRefs.length && referenceImageUrls.length < 7; i++) {
          const imgData = useBase64
            ? await refToBananaImage(uploadRefs[i])
            : await uploadRefToZhenzhen(uploadRefs[i], apiKey);
          if (imgData) referenceImageUrls.push(imgData);
          else throw new Error(`Grok FAL 参考图 #${i + 1} 处理失败`);
        }
        for (const url of extraReferenceUrls) {
          if (referenceImageUrls.length >= 7) break;
          referenceImageUrls.push(url);
        }
        if (!referenceImageUrls.length) throw new Error('Grok FAL 参考生视频需要至少 1 张参考图或 URL');
        payload.reference_image_urls = referenceImageUrls;
      } else {
        endpoint = hasImg ? (reg.i2vEndpoint || reg.endpoint) : reg.endpoint;
        // 图生视频模式: 单张 image_url；无图时保留文生视频 fallback。
        if (hasImg) {
          const imgData = useBase64
            ? await refToBananaImage(trimmedRefs[0])
            : await uploadRefToZhenzhen(trimmedRefs[0], apiKey);
          if (imgData) payload.image_url = imgData;
          else throw new Error('Grok FAL 参考图处理失败');
        }
      }
    } else if (reg.paramKind === 'sora-fal') {
      // ===== Sora2 FAL (主项目 runSora2Fal line 5341) =====
      const hasImg = trimmedRefs.length > 0;
      let mode = String(soraMode || 'auto');
      if (!['auto', 'text_to_video', 'image_to_video'].includes(mode)) mode = 'auto';
      if (mode === 'auto') mode = hasImg ? 'image_to_video' : 'text_to_video';
      if (mode === 'image_to_video' && !hasImg) throw new Error('FAL Sora2 image-to-video requires one uploaded image');

      const ratio = String(soraRatio || aspect_ratio || '16:9');
      const reso = String(soraResolution || resolution || '720p');
      endpoint = mode === 'image_to_video' ? (reg.i2vEndpoint || reg.endpoint) : reg.endpoint;
      payload = {
        prompt,
        resolution: mode === 'text_to_video' && reso === 'auto' ? '720p' : reso,
        aspect_ratio: mode === 'text_to_video' && ratio === 'auto' ? '16:9' : ratio,
        duration: parseInt(soraDuration ?? duration ?? 4, 10) || 4,
        delete_video: soraDeleteVideo !== false,
        model: effectiveApiModel,
        detect_and_block_ip: soraBlockIp === true,
      };
      const ids = splitSoraCharacterIds(soraCharacterIds);
      if (ids.length) payload.character_ids = ids;
      if (mode === 'image_to_video') {
        const useBase64 = String(image_mode || 'base64') === 'base64';
        const imgData = useBase64
          ? await refToBananaImage(trimmedRefs[0])
          : await uploadRefToZhenzhen(trimmedRefs[0], apiKey);
        if (imgData) payload.image_url = imgData;
        else throw new Error('Sora2 FAL 参考图处理失败');
      }
    } else {
      return res.status(400).json({ success: false, error: `不支持的 Video FAL paramKind: ${reg.paramKind}` });
    }

    const falUrl = `${baseUrl}/fal/${endpoint}`;
    console.log('[video/fal/submit]', effectiveApiModel, '→', falUrl, '| payload keys:', Object.keys(payload), '| refs:', trimmedRefs.length);

    const resp = await fetch(falUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    if (!resp.ok) {
      return res.status(resp.status).json({
        success: false,
        error: data?.error || data?.detail || data?.message || `FAL HTTP ${resp.status}: ${text.slice(0, 300)}`,
      });
    }
    if (Array.isArray(data)) {
      return res.status(400).json({ success: false, error: `FAL 参数校验错误: ${JSON.stringify(data).slice(0, 300)}` });
    }
    if (data?.detail && !data?.video && !data?.request_id) {
      return res.status(400).json({ success: false, error: `FAL 错误: ${JSON.stringify(data.detail).slice(0, 300)}` });
    }

    // 同步返回: result.video.url 或同类 video_url/url 字段
    const syncVideoUrl = getFalVideoUrl(data);
    if (syncVideoUrl) {
      const local = await saveRemoteVideo(syncVideoUrl);
      return res.json({ success: true, data: { sync: true, videoUrl: local, endpoint, raw: data } });
    }

    // 异步: request_id + response_url
    const requestId = data?.request_id;
    let responseUrl = data?.response_url || '';
    if (!requestId) {
      return res.status(500).json({ success: false, error: '未获取到 request_id: ' + JSON.stringify(data).slice(0, 300) });
    }
    responseUrl = fixFalResponseUrl(responseUrl, baseUrl, endpoint, requestId);
    rememberTaskKey(requestId, apiKey, { model: effectiveApiModel, endpoint });
    return res.json({
      success: true,
      data: { sync: false, requestId, responseUrl, endpoint, raw: data },
    });
  } catch (e) {
    console.error('proxy/video/fal/submit 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// POST /api/proxy/video/fal/query
//   body: { responseUrl, endpoint, requestId }
//   完成标志: data.video.url (区别于图像的 data.images[])
router.post('/video/fal/query', async (req, res) => {
  const settings = loadRawSettings();
  const { responseUrl: rawUrl, endpoint, requestId } = req.body || {};
  const rememberedMeta = recallTaskMeta(requestId);
  if (rememberedMeta?.apiKey) {
    if (settings) settings.zhenzhenApiKey = rememberedMeta.apiKey;
    else return res.status(400).json({ success: false, error: '未找到 settings' });
  } else {
    // FAL 查询和提交保持同一策略：只用通用贞贞 API Key。
    if (!ensureDefaultZhenzhenKey(settings, res, '视频 FAL')) return;
  }
  const apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;
  const responseUrl = fixFalResponseUrl(rawUrl, baseUrl, endpoint, requestId);
  if (!responseUrl) return res.status(400).json({ success: false, error: 'responseUrl 或 (endpoint+requestId) 必填' });

  try {
    const pr = await fetch(responseUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    const text = await pr.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    // HTTP 非200: 主项目规范 - body 中 status=IN_QUEUE/IN_PROGRESS 视为继续等待
    if (!pr.ok) {
      if (data && (data.status === 'IN_QUEUE' || data.status === 'IN_PROGRESS')) {
        return res.json({ success: true, data: { status: 'pending', raw: data } });
      }
      return res.status(pr.status).json({
        success: false,
        error: `FAL Poll HTTP ${pr.status}: ${text.slice(0, 300)}`,
        raw: data,
      });
    }
    if (!data) {
      return res.status(500).json({ success: false, error: 'FAL Poll 响应非 JSON: ' + text.slice(0, 200) });
    }
    // 完成: video.url 或同类 video_url/url 字段
    const finishedVideoUrl = getFalVideoUrl(data);
    if (finishedVideoUrl) {
      const local = await saveRemoteVideo(finishedVideoUrl);
      return res.json({ success: true, data: { status: 'completed', videoUrl: local, raw: data } });
    }
    const st = String(data.status || '').toUpperCase();
    if (st === 'FAILED' || st === 'CANCELLED') {
      return res.json({
        success: false,
        data: { status: 'failed', error: data.error || data.detail || `FAL ${st}` },
      });
    }
    // IN_QUEUE / IN_PROGRESS / 空 => pending
    return res.json({ success: true, data: { status: 'pending', falStatus: st || 'IN_QUEUE', raw: data } });
  } catch (e) {
    console.error('proxy/video/fal/query 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '查询失败' });
  }
});

// ========================================================================
// Fal 超市通用 FAL Queue 适配器
// 不替换现有 /image/fal/* 与 /video/fal/* 路由；这里只服务新的 Fal超市节点。
// ========================================================================

const FAL_TOOLBOX_PENDING = new Set(['IN_QUEUE', 'IN_PROGRESS', 'PENDING', 'RUNNING', 'QUEUED']);
const FAL_TOOLBOX_COMPLETED = new Set(['COMPLETED', 'COMPLETE', 'DONE', 'SUCCEEDED', 'SUCCESS']);
const FAL_TOOLBOX_FAILED = new Set(['FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED']);

function isFalToolboxEndpoint(value) {
  const endpoint = String(value || '').trim();
  return !!endpoint && /^[a-z0-9._~:/-]+$/i.test(endpoint) && !endpoint.includes('..') && !/^https?:\/\//i.test(endpoint);
}

function falToolboxStatusValue(data) {
  if (!data || typeof data !== 'object') return '';
  const status = data.status ?? data.state ?? data.task_status ?? data.taskStatus;
  return String(status || '').trim().toUpperCase();
}

function falToolboxErrorMessage(data, fallback = 'FAL 任务失败') {
  if (!data) return fallback;
  if (typeof data === 'string') return data;
  const candidates = [
    data.failure_details,
    data.failure_reason,
    data.fail_reason,
    data.error,
    data.errors,
    data.detail,
    data.message,
    data.msg,
    data.data?.failure_details,
    data.data?.error,
    data.data?.detail,
    data.data?.message,
  ];
  for (const candidate of candidates) {
    if (candidate == null || candidate === '' || (Array.isArray(candidate) && !candidate.length)) continue;
    const msg = stringifyUpstreamErrorValue(candidate);
    if (msg) return msg;
  }
  try {
    return JSON.stringify(data).slice(0, 800);
  } catch {
    return fallback;
  }
}

function fixFalToolboxUrl(url, baseUrl, endpoint, requestId) {
  let value = String(url || '').trim();
  if (value.includes('queue.fal.run')) value = value.replace('https://queue.fal.run', `${baseUrl}/fal`);
  if (value.includes('fal.run')) value = value.replace('https://fal.run', `${baseUrl}/fal`);
  if (!value && endpoint && requestId) value = `${baseUrl}/fal/${endpoint}/requests/${requestId}`;
  return value;
}

function getByPath(data, pathText) {
  if (!data || !pathText) return undefined;
  const parts = String(pathText).split('.').filter(Boolean);
  let cur = data;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function collectFalToolboxUrls(value, out = []) {
  const pushUrl = (url) => {
    const text = String(url || '').trim();
    if (text && !out.includes(text)) out.push(text);
  };
  if (value == null) return out;
  if (typeof value === 'string') {
    if (/^(https?:\/\/|\/files\/|\/output\/|\/input\/)/i.test(value) || /^data:/i.test(value)) pushUrl(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFalToolboxUrls(item, out);
    return out;
  }
  if (typeof value === 'object') {
    if (typeof value.url === 'string') pushUrl(value.url);
    if (typeof value.file_url === 'string') pushUrl(value.file_url);
    if (typeof value.fileUrl === 'string') pushUrl(value.fileUrl);
    for (const child of Object.values(value)) collectFalToolboxUrls(child, out);
  }
  return out;
}

function collectFalToolboxText(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') {
    if (!/^(https?:\/\/|\/files\/|data:)/i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFalToolboxText(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'caption', 'prompt']) {
      if (typeof value[key] === 'string') out.push(value[key]);
    }
  }
  return out;
}

async function saveRemoteFalToolboxFile(url, kind) {
  if (/^\/(files|output|input)\//i.test(String(url || ''))) return url;
  if (kind === 'image') return saveRemoteImage(url);
  if (kind === 'video') return saveRemoteVideo(url);
  if (kind === 'audio') return saveRemoteAudio(url);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const cleanUrl = String(url || '').split(/[?#]/)[0];
    const match = cleanUrl.match(/\.([a-z0-9]{2,8})$/i);
    const ext = safeOutputExt(match?.[1], kind === 'model3d' ? 'glb' : 'bin');
    const prefix = kind === 'model3d' ? 'model3d' : 'fal';
    const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
    fs.writeFileSync(path.join(config.OUTPUT_DIR, filename), buf);
    return `/files/output/${filename}`;
  } catch (e) {
    console.error('⚠ 转存 FAL 文件失败:', e.message);
    return url;
  }
}

async function extractFalToolboxOutputs(data, outputSchema) {
  const outputs = Array.isArray(outputSchema) ? outputSchema : [];
  const urls = [];
  const imageUrls = [];
  const videoUrls = [];
  const audioUrls = [];
  const modelUrls = [];
  const textOutputs = [];
  const jsonOutputs = [];

  const normalizedOutputs = outputs.length ? outputs : [
    { key: 'images', kind: 'image', pathCandidates: ['images', 'data.images'] },
    { key: 'video', kind: 'video', pathCandidates: ['video', 'data.video', 'video_url', 'url'] },
    { key: 'audio', kind: 'audio', pathCandidates: ['audio', 'data.audio', 'audio_url'] },
    { key: 'model', kind: 'model3d', pathCandidates: ['model', 'mesh', 'file', 'files'] },
  ];

  for (const output of normalizedOutputs) {
    const kind = String(output?.kind || 'json');
    const candidates = Array.isArray(output?.pathCandidates) && output.pathCandidates.length
      ? output.pathCandidates
      : [output?.key].filter(Boolean);
    for (const candidate of candidates) {
      const value = getByPath(data, candidate);
      if (value == null) continue;
      if (kind === 'text') {
        textOutputs.push(...collectFalToolboxText(value));
        continue;
      }
      if (kind === 'json') {
        jsonOutputs.push(value);
        continue;
      }
      const found = collectFalToolboxUrls(value, []);
      for (const remote of found) {
        const local = await saveRemoteFalToolboxFile(remote, kind);
        urls.push(local);
        if (kind === 'image') imageUrls.push(local);
        else if (kind === 'video') videoUrls.push(local);
        else if (kind === 'audio') audioUrls.push(local);
        else if (kind === 'model3d') modelUrls.push(local);
      }
    }
  }

  return {
    urls: Array.from(new Set(urls)),
    imageUrls: Array.from(new Set(imageUrls)),
    videoUrls: Array.from(new Set(videoUrls)),
    audioUrls: Array.from(new Set(audioUrls)),
    modelUrls: Array.from(new Set(modelUrls)),
    textOutputs: Array.from(new Set(textOutputs.filter(Boolean))),
    jsonOutputs,
  };
}

function falToolboxHasOutput(result) {
  return Boolean(result.urls.length || result.textOutputs.length || result.jsonOutputs.length);
}

async function resolveFalToolboxMediaPayload(payload, mediaFields, apiKey) {
  const next = { ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}) };
  const fields = Array.isArray(mediaFields) ? mediaFields : [];
  for (const field of fields) {
    const key = String(field?.key || '').trim();
    if (!key || !(key in next)) continue;
    const rawValues = Array.isArray(next[key]) ? next[key] : [next[key]];
    const resolved = [];
    for (const raw of rawValues) {
      const value = String(raw || '').trim();
      if (!value) continue;
      if (field?.upload === false) {
        resolved.push(value);
      } else if (field?.kind === 'image' && field?.mediaMode === 'base64') {
        const dataUrl = await refToBananaImage(value);
        if (!dataUrl) throw new Error(`FAL 图片读取失败: ${value.slice(0, 80)}`);
        resolved.push(dataUrl);
      } else {
        const url = await uploadRefToZhenzhen(value, apiKey);
        if (!url) throw new Error(`FAL 素材上传失败: ${value.slice(0, 80)}`);
        resolved.push(url);
      }
    }
    if (field?.multiple === false || !Array.isArray(next[key])) next[key] = resolved[0] || '';
    else next[key] = resolved;
  }
  return next;
}

router.post('/fal-toolbox/submit', async (req, res) => {
  const settings = loadRawSettings();
  if (!ensureDefaultZhenzhenKey(settings, res, 'Fal超市')) return;
  const apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;
  const {
    toolId,
    title,
    endpoint,
    payload,
    mediaFields,
    outputSchema,
    statusPath,
  } = req.body || {};
  if (!isFalToolboxEndpoint(endpoint)) {
    return res.status(400).json({ success: false, error: `非法 FAL endpoint: ${endpoint || ''}` });
  }
  try {
    const finalPayload = await resolveFalToolboxMediaPayload(payload, mediaFields, apiKey);
    const falUrl = `${baseUrl}/fal/${endpoint}`;
    console.log('[fal-toolbox/submit]', toolId || title || endpoint, '→', falUrl, '| payload keys:', Object.keys(finalPayload));
    const upstream = await fetch(falUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(finalPayload),
    });
    const text = await upstream.text();
    let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        success: false,
        error: falToolboxErrorMessage(data, `FAL HTTP ${upstream.status}: ${text.slice(0, 300)}`),
        raw: data,
      });
    }
    if (Array.isArray(data)) {
      return res.status(400).json({ success: false, error: `FAL 参数校验错误: ${JSON.stringify(data).slice(0, 500)}` });
    }
    const st = falToolboxStatusValue(data);
    if (FAL_TOOLBOX_FAILED.has(st)) {
      return res.json({ success: false, data: { status: 'failed', error: falToolboxErrorMessage(data, `FAL ${st}`), raw: data } });
    }

    const output = await extractFalToolboxOutputs(data, outputSchema);
    if (falToolboxHasOutput(output)) {
      return res.json({ success: true, data: { sync: true, endpoint, ...output, raw: data } });
    }

    const requestId = data?.request_id || data?.requestId;
    if (!requestId) {
      return res.status(500).json({ success: false, error: 'FAL 未返回 request_id: ' + JSON.stringify(data).slice(0, 400), raw: data });
    }
    const responseUrl = fixFalToolboxUrl(data?.response_url || data?.responseUrl, baseUrl, endpoint, requestId);
    const rawStatusUrl = data?.status_url || data?.statusUrl || (statusPath === 'result-only' ? '' : `${responseUrl}/status`);
    const statusUrl = rawStatusUrl ? fixFalToolboxUrl(rawStatusUrl, baseUrl, endpoint, requestId) : '';
    rememberTaskKey(requestId, apiKey, {
      route: 'fal-toolbox',
      toolId,
      title,
      endpoint,
      outputSchema,
      responseUrl,
      statusUrl,
      statusPath,
    });
    return res.json({
      success: true,
      data: { sync: false, requestId, responseUrl, statusUrl, endpoint, raw: data },
    });
  } catch (e) {
    console.error('proxy/fal-toolbox/submit 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

router.post('/fal-toolbox/query', async (req, res) => {
  const settings = loadRawSettings();
  const { responseUrl: rawResponseUrl, statusUrl: rawStatusUrl, endpoint: rawEndpoint, requestId, outputSchema: bodyOutputSchema, statusPath: rawStatusPath } = req.body || {};
  const rememberedMeta = recallTaskMeta(requestId);
  if (rememberedMeta?.apiKey) {
    if (settings) settings.zhenzhenApiKey = rememberedMeta.apiKey;
    else return res.status(400).json({ success: false, error: '未找到 settings' });
  } else {
    if (!ensureDefaultZhenzhenKey(settings, res, 'Fal超市')) return;
  }
  const apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;
  const endpoint = rememberedMeta?.endpoint || rawEndpoint;
  const outputSchema = rememberedMeta?.outputSchema || bodyOutputSchema;
  const statusPath = rememberedMeta?.statusPath || rawStatusPath;
  const responseUrl = fixFalToolboxUrl(rawResponseUrl || rememberedMeta?.responseUrl, baseUrl, endpoint, requestId);
  const rawEffectiveStatusUrl = rawStatusUrl || rememberedMeta?.statusUrl || (statusPath === 'result-only' ? '' : (responseUrl ? `${responseUrl}/status` : ''));
  const statusUrl = rawEffectiveStatusUrl ? fixFalToolboxUrl(rawEffectiveStatusUrl, baseUrl, endpoint, requestId) : '';
  if (!responseUrl && !statusUrl) return res.status(400).json({ success: false, error: 'responseUrl/statusUrl 或 requestId 必填' });

  const fetchJson = async (url) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    return { r, text, data };
  };

  try {
    let statusData = null;
    if (statusUrl) {
      const statusResp = await fetchJson(statusUrl);
      statusData = statusResp.data;
      if (!statusResp.r.ok) {
        const st = falToolboxStatusValue(statusData);
        if (FAL_TOOLBOX_PENDING.has(st)) {
          return res.json({ success: true, data: { status: 'pending', falStatus: st, requestId, responseUrl, statusUrl, raw: statusData } });
        }
        return res.status(statusResp.r.status).json({
          success: false,
          data: { status: 'failed', error: falToolboxErrorMessage(statusData, `FAL Poll HTTP ${statusResp.r.status}: ${statusResp.text.slice(0, 300)}`), raw: statusData },
        });
      }
      const st = falToolboxStatusValue(statusData);
      if (FAL_TOOLBOX_FAILED.has(st)) {
        return res.json({ success: false, data: { status: 'failed', error: falToolboxErrorMessage(statusData, `FAL ${st}`), falStatus: st, requestId, responseUrl, statusUrl, raw: statusData } });
      }
      const statusOutput = await extractFalToolboxOutputs(statusData, outputSchema);
      if (falToolboxHasOutput(statusOutput)) {
        return res.json({ success: true, data: { status: 'completed', requestId, responseUrl, statusUrl, ...statusOutput, raw: statusData } });
      }
      if (st && !FAL_TOOLBOX_COMPLETED.has(st)) {
        return res.json({ success: true, data: { status: 'pending', falStatus: st, requestId, responseUrl, statusUrl, raw: statusData } });
      }
    }

    const resultResp = await fetchJson(responseUrl || statusUrl);
    if (!resultResp.r.ok) {
      const st = falToolboxStatusValue(resultResp.data);
      if (FAL_TOOLBOX_PENDING.has(st)) {
        return res.json({ success: true, data: { status: 'pending', falStatus: st, requestId, responseUrl, statusUrl, raw: resultResp.data } });
      }
      return res.status(resultResp.r.status).json({
        success: false,
        data: { status: 'failed', error: falToolboxErrorMessage(resultResp.data, `FAL Result HTTP ${resultResp.r.status}: ${resultResp.text.slice(0, 300)}`), raw: resultResp.data },
      });
    }
    if (!resultResp.data) {
      return res.status(500).json({ success: false, data: { status: 'failed', error: 'FAL 响应非 JSON: ' + resultResp.text.slice(0, 200) } });
    }
    const resultStatus = falToolboxStatusValue(resultResp.data);
    if (FAL_TOOLBOX_FAILED.has(resultStatus)) {
      return res.json({ success: false, data: { status: 'failed', error: falToolboxErrorMessage(resultResp.data, `FAL ${resultStatus}`), falStatus: resultStatus, requestId, responseUrl, statusUrl, raw: resultResp.data } });
    }
    const output = await extractFalToolboxOutputs(resultResp.data, outputSchema);
    if (falToolboxHasOutput(output)) {
      return res.json({ success: true, data: { status: 'completed', requestId, responseUrl, statusUrl, ...output, raw: resultResp.data } });
    }
    return res.json({ success: true, data: { status: 'pending', falStatus: resultStatus || falToolboxStatusValue(statusData) || 'IN_PROGRESS', requestId, responseUrl, statusUrl, raw: resultResp.data || statusData } });
  } catch (e) {
    console.error('proxy/fal-toolbox/query 错误:', e);
    return res.status(500).json({ success: false, data: { status: 'failed', error: e.message || '查询失败' } });
  }
});

router.post('/video/submit', async (req, res) => {
  const settings = loadRawSettings();
  const {
    model, prompt,
    // Veo 参数
    aspect_ratio, enhance_prompt, enable_upsample,
    // Grok 参数
    ratio, duration, resolution,
    // 通用
    seed, private: privateVideo, is_private, watermark, images, providerParams, size,
  } = req.body || {};
  // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
  if (!ensureKeyOrSelectedGroup(settings, res, model || '', '视频', providerParams)) return;
  if (!model || !prompt) {
    return res.status(400).json({ success: false, error: 'model 和 prompt 必填' });
  }
  const lowerModel = String(model).toLowerCase();
  const isVeoOmni = isVeoOmniModel(lowerModel);
  const isGrokVideo15New = isGrokVideo15NewModel(lowerModel);
  const isGrok = lowerModel.includes('grok');
  const isSoraZhenzhen = lowerModel === 'sora-2-zhenzhen';
  const isVeo = lowerModel.includes('veo');
  let body;

  try {
    const providerContext = await applyZhenzhenProviderContext(settings, {
      route: 'video/submit',
      kind: 'video',
      model,
      hint: model || '',
      providerParams,
    });
    const apiKey = settings.zhenzhenApiKey;
    if (isVeoOmni) {
      // ===== Veo Omni 协议(参考 Comfly_veo_omini): POST /v1/videos multipart =====
      const refs = Array.isArray(images) ? images.slice(0, 1) : [];
      if (!refs.length) {
        return res.status(400).json({ success: false, error: 'veo-omni-10s 需要 1 张参考图' });
      }
      const conv = await refToBuffer(refs[0]);
      if (!conv) {
        return res.status(400).json({ success: false, error: 'veo-omni-10s 参考图读取失败' });
      }
      const form = new FormData();
      const seconds = ['4', '5', '6', '8', '10'].includes(String(duration)) ? String(duration) : '10';
      const size = veoOmniSizeFromAspect(aspect_ratio || ratio || '16:9');
      form.append('model', VEO_OMNI_UPSTREAM_MODEL);
      form.append('prompt', prompt);
      form.append('size', size);
      form.append('seconds', seconds);
      form.append('watermark', String(Boolean(watermark)).toLowerCase());
      form.append('input_reference', new Blob([conv.buf], { type: conv.mime }), `input_reference.${conv.ext || 'png'}`);

      const upstream = `${config.ZHENZHEN_BASE_URL}/v1/videos`;
      console.log('[upstream] Veo Omni → /v1/videos model:', VEO_OMNI_UPSTREAM_MODEL, 'size:', size, 'seconds:', seconds, 'refs:', refs.length);
      const r = await fetch(upstream, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch {
        return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) });
      }
      if (!r.ok) {
        const errorText = getUpstreamErrorMessage(data, text, r.status);
        await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
        return res.status(r.status).json({ success: false, error: errorText, raw: data });
      }
      const taskId = data?.task_id || data?.id;
      if (!taskId) return res.status(500).json({ success: false, error: '未获取到 task_id: ' + text.slice(0, 200) });
      rememberTaskKey(taskId, apiKey, { model: VEO_OMNI_PUBLIC_MODEL, ...providerContext.taskMeta });
      return res.json({ success: true, data: { taskId, raw: data } });
    } else if (isGrokVideo15New) {
      // ===== Grok Video 1.5 New 协议(参考 Comfly_grok_video_1_5): POST /v1/videos multipart =====
      const refs = Array.isArray(images) ? images.slice(0, 1) : [];
      if (!refs.length) {
        return res.status(400).json({ success: false, error: 'Grok 1.5 New 需要 1 张参考图' });
      }
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('size', grokVideo15NewSizeFromRatio(size || aspect_ratio || ratio || '16:9'));
      const hasReference = await appendGrokVideo15InputReference(form, refs[0]);
      if (!hasReference) {
        return res.status(400).json({ success: false, error: 'Grok 1.5 New 参考图读取失败' });
      }

      const upstream = `${config.ZHENZHEN_BASE_URL}/v1/videos`;
      console.log('[upstream] Grok Video 1.5 New → /v1/videos model:', model, 'size:', grokVideo15NewSizeFromRatio(size || aspect_ratio || ratio || '16:9'), 'refs:', refs.length);
      const r = await fetch(upstream, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch {
        return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) });
      }
      if (!r.ok) {
        const errorText = getUpstreamErrorMessage(data, text, r.status);
        await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
        return res.status(r.status).json({ success: false, error: errorText, raw: data });
      }
      const taskId = data?.task_id || data?.id;
      if (!taskId) return res.status(500).json({ success: false, error: '未获取到 task_id: ' + text.slice(0, 200) });
      rememberTaskKey(taskId, apiKey, { model, ...providerContext.taskMeta });
      return res.json({ success: true, data: { taskId, raw: data } });
    } else if (isSoraZhenzhen) {
      // ===== Sora2 Zhenzhen API 协议(参考 gpt-image-2-web runSora2) =====
      body = {
        prompt,
        model: 'sora-2',
        aspect_ratio: aspect_ratio || ratio || '16:9',
        duration: String(duration ?? 15),
        private: privateVideo !== false && is_private !== false,
      };
      if (seed && seed > 0) body.seed = seed;
      if (Array.isArray(images) && images.length) {
        const refs = images.slice(0, 1).map(stripDataUrlPrefix).filter(Boolean);
        if (refs.length) body.images = refs;
      }
      console.log('[upstream] Sora2 Zhenzhen → /v2/videos/generations model:', body.model, 'aspect_ratio:', body.aspect_ratio, 'duration:', body.duration, 'private:', body.private, 'refs:', body.images?.length || 0);
    } else if (isGrok) {
      // ===== Grok Video 协议(主项目 runGrok3 line 3863) =====
      body = {
        prompt,
        model,
        ratio: ratio || '16:9',
        duration: parseInt(duration ?? 15, 10),
        resolution: resolution || '720P',
      };
      if (seed && seed > 0) body.seed = seed;
      if (Array.isArray(images) && images.length) {
        const refs = images.slice(0, 7); // Grok 最多 7 张
        const urls = [];
        for (let i = 0; i < refs.length; i++) {
          const u = await uploadRefToZhenzhen(refs[i], apiKey);
          if (u) urls.push(u);
          else throw new Error(`参考图 #${i + 1} 上传失败`);
        }
        if (urls.length) body.images = urls;
      }
      console.log('[upstream] Grok Video → /v2/videos/generations model:', model, 'ratio:', body.ratio, 'duration:', body.duration, 'resolution:', body.resolution, 'refs:', body.images?.length || 0);
    } else {
      // ===== Veo3.1 协议(主项目 runVeo3 line 3372)=====
      // 旧 seedance / 默认行为也走这里(零破坏)
      body = { prompt, model, enhance_prompt: enhance_prompt !== false };
      if (aspect_ratio) body.aspect_ratio = aspect_ratio;
      if (seed && seed > 0) body.seed = seed;
      if (enable_upsample) body.enable_upsample = true;
      if (Array.isArray(images) && images.length) body.images = images.slice(0, 3); // base64 dataURL
      console.log('[upstream] Veo/Default → /v2/videos/generations model:', model, 'aspect_ratio:', body.aspect_ratio, 'refs:', body.images?.length || 0, isVeo ? '(veo)' : '(legacy)');
    }

    const upstream = `${config.ZHENZHEN_BASE_URL}/v2/videos/generations`;
    const r = await fetch(upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) });
    }
    if (!r.ok) {
      const errorText = getUpstreamErrorMessage(data, text, r.status);
      await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
      return res.status(r.status).json({ success: false, error: errorText, raw: data });
    }
    const taskId = data?.task_id || data?.id;
    if (!taskId) return res.status(500).json({ success: false, error: '未获取到 task_id: ' + text.slice(0, 200) });
    rememberTaskKey(taskId, apiKey, { model, ...providerContext.taskMeta });
    res.json({ success: true, data: { taskId, raw: data } });
  } catch (e) {
    console.error('proxy/video/submit 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

router.get('/video/query', async (req, res) => {
  const settings = loadRawSettings();
  const taskId = String(req.query.taskId || '').trim();
  const rememberedMeta = recallTaskMeta(taskId);
  const queryModel = String(req.query.model || rememberedMeta?.model || '').trim();
  // 优先从 submit 阶段记录的 (taskId → key) 映射恢复，防止前端未传 model 导致 fallback 错 key。
  if (rememberedMeta?.apiKey) {
    if (settings) settings.zhenzhenApiKey = rememberedMeta.apiKey;
    else return res.status(400).json({ success: false, error: '未找到 settings' });
  } else {
    // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
    if (!ensureKey(settings, res, queryModel, '视频')) return;
  }
  if (!taskId) return res.status(400).json({ success: false, error: 'taskId 必填' });
  const usesV1VideoQuery = isVeoOmniModel(queryModel) || isGrokVideo15NewModel(queryModel);
  const upstream = usesV1VideoQuery
    ? `${config.ZHENZHEN_BASE_URL}/v1/videos/${encodeURIComponent(taskId)}`
    : `${config.ZHENZHEN_BASE_URL}/v2/videos/generations/${encodeURIComponent(taskId)}`;
  try {
    const r = await fetch(upstream, {
      headers: { Authorization: `Bearer ${settings.zhenzhenApiKey}` },
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) });
    }
    if (!r.ok) {
      const errorText = getUpstreamErrorMessage(data, text, r.status);
      await invalidateZhenzhenProviderKey({ taskMeta: rememberedMeta || {} }, settings.zhenzhenApiKey, errorText);
      return res.status(r.status).json({ success: false, error: errorText, raw: data });
    }
    const st = normalizeVideoTaskStatus(data?.status);
    let videoUrl = null;
    if (st === 'SUCCESS') {
      const remote = getFalVideoUrl(data);
      if (remote) {
        videoUrl = await saveRemoteVideo(remote);
      }
    }
    res.json({
      success: true,
      data: {
        status: st || 'PENDING',
        progress: data?.progress == null ? '' : String(data.progress),
        videoUrl,
        failReason: data?.fail_reason || data?.failure_details || data?.error || data?.message || null,
        raw: data,
      },
    });
  } catch (e) {
    console.error('proxy/video/query 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// ========================================================================
// Seedance 2.0(异步)— 完全对齐 gpt-image-2-web runSeedance / pollSeedance
//   submit: POST ${ZHENZHEN_BASE_URL}/seedance/v3/contents/generations/tasks
//   query : GET  ${ZHENZHEN_BASE_URL}/seedance/v3/contents/generations/tasks/{tid}
// model includes: doubao-seedance-2-0-260128 / doubao-seedance-2-0-fast-260128 / doubao-seedance-2.0-mini
// resolution includes: 480p / 720p / native1080p / native4K / 1080p / 2k / 4k
// payload: { model, content[], duration, ratio, resolution, generate_audio,
//            return_last_frame, watermark, tools?[web_search], seed? }
// content 数组成员:
//   { type:'text', text }
//   { type:'image_url', image_url:{url}, role:'first_frame'|'last_frame'|'reference_image' }
//   { type:'video_url', video_url:{url}, role:'reference_video' }   // 需先 /v1/files 上传换 URL
//   { type:'audio_url', audio_url:{url}, role:'reference_audio' }   // 需先 /v1/files 上传换 URL
// ========================================================================
router.post('/seedance/submit', async (req, res) => {
  const settings = loadRawSettings();
  // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
  let apiKey = settings?.zhenzhenApiKey || '';
  const baseUrl = config.ZHENZHEN_BASE_URL;
  const {
    model, prompt,
    duration, ratio, resolution,
    generate_audio, return_last_frame, watermark, web_search,
    seed,
    firstFrame, lastFrame,
    refImages,
    videos, audios,
    taskProvider,
    providerParams,
  } = req.body || {};

  const requestedTaskProvider = taskProvider === 'auto'
    ? (settings?.zhenzhenSd2ApiKey ? seedanceNz.PROVIDER_ID : 'zhenzhen-legacy')
    : (taskProvider || 'zhenzhen-legacy');

  if (requestedTaskProvider === seedanceNz.PROVIDER_ID) {
    try {
      const result = await seedanceNz.submitTask(req.body || {}, settings?.zhenzhenSd2ApiKey || '');
      rememberTaskKey(result.taskId, settings.zhenzhenSd2ApiKey, {
        provider: seedanceNz.PROVIDER_ID,
        model: result.model,
        taskType: result.taskType,
      });
      return res.json({
        success: true,
        data: {
          taskId: result.taskId,
          taskProvider: seedanceNz.PROVIDER_ID,
          model: result.model,
          taskType: result.taskType,
          raw: result.raw,
          ...seedanceNzTrace(result),
        },
      });
    } catch (e) {
      console.error('proxy/seedance/submit seedance.nz 错误:', e?.message || e);
      const status = Number(e?.status);
      return res.status(status >= 400 && status < 600 ? status : 500).json({ success: false, error: e?.message || 'seedance.nz 请求失败', ...seedanceNzTrace(e) });
    }
  }

  if (requestedTaskProvider !== 'zhenzhen-legacy') {
    return res.status(400).json({ success: false, error: `不支持的 Seedance provider：${requestedTaskProvider}` });
  }
  if (!ensureKeyOrSelectedGroup(settings, res, 'seedance', 'Seedance', providerParams)) return;

  if (!model) return res.status(400).json({ success: false, error: 'model 必填' });
  if (!prompt) return res.status(400).json({ success: false, error: 'prompt 不得为空' });

  try {
    const providerContext = await applyZhenzhenProviderContext(settings, {
      route: 'seedance/submit',
      kind: 'seedance',
      model,
      hint: model || 'seedance',
      providerParams,
    });
    apiKey = settings.zhenzhenApiKey;
    const content = [{ type: 'text', text: String(prompt) }];

    const hasF = !!firstFrame;
    const hasL = !!lastFrame;

    // first_frame:
    //   - 单独 first_frame(无 last_frame): 不带 role
    //   - 与 last_frame 同时存在: role='first_frame'
    if (hasF) {
      const u = await uploadRefToZhenzhen(firstFrame, apiKey, 'first_frame');
      if (!u) throw new Error('first_frame 上传失败');
      const e = { type: 'image_url', image_url: { url: u } };
      if (hasL) e.role = 'first_frame';
      content.push(e);
    }

    // last_frame: 必须与 first_frame 同时
    if (hasL && hasF) {
      const u = await uploadRefToZhenzhen(lastFrame, apiKey, 'last_frame');
      if (!u) throw new Error('last_frame 上传失败');
      content.push({ type: 'image_url', image_url: { url: u }, role: 'last_frame' });
    }

    // reference_image
    if (Array.isArray(refImages)) {
      for (let i = 0; i < refImages.length; i++) {
        const u = await uploadRefToZhenzhen(refImages[i], apiKey, `reference_image ${i + 1}`);
        if (u) content.push({ type: 'image_url', image_url: { url: u }, role: 'reference_image' });
      }
    }

    // reference_video / reference_audio:
    // gpt-image-2-web 的 runSeedance 会把本地视频/音频先上传到 /v1/files，再把返回 URL 放入 content。
    // T8 画布上游素材通常是 /files/input 或 /files/output，本地地址不能直接提交给 Seedance。
    if (Array.isArray(videos)) {
      for (let i = 0; i < videos.length; i++) {
        const v = videos[i];
        if (typeof v === 'string' && v) {
          const u = await uploadRefToZhenzhen(v, apiKey, `reference_video ${i + 1}`);
          if (!u) throw new Error(`reference_video ${i + 1} 上传失败`);
          content.push({ type: 'video_url', video_url: { url: u }, role: 'reference_video' });
        }
      }
    }
    if (Array.isArray(audios)) {
      for (let i = 0; i < audios.length; i++) {
        const a = audios[i];
        if (typeof a === 'string' && a) {
          const u = await uploadRefToZhenzhen(a, apiKey, `reference_audio ${i + 1}`);
          if (!u) throw new Error(`reference_audio ${i + 1} 上传失败`);
          content.push({ type: 'audio_url', audio_url: { url: u }, role: 'reference_audio' });
        }
      }
    }

    const payload = {
      model,
      content,
      duration: parseInt(duration ?? 5, 10),
      ratio: ratio || '16:9',
      resolution: resolution || '720p',
      generate_audio: generate_audio !== false,
      return_last_frame: return_last_frame === true,
      watermark: watermark === true,
    };
    if (web_search === true) payload.tools = [{ type: 'web_search' }];
    if (typeof seed === 'number' && seed !== -1) payload.seed = seed;

    console.log('[upstream] Seedance2.0 → /seedance/v3/contents/generations/tasks model:', model,
      'duration:', payload.duration, 'ratio:', payload.ratio, 'resolution:', payload.resolution,
      'content_items:', content.length);

    const r = await fetch(`${baseUrl}/seedance/v3/contents/generations/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) });
    }
    if (!r.ok) {
      const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
      await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
      return res.status(r.status).json({ success: false, error: errorText });
    }
    const taskId = data?.id || data?.task_id;
    if (!taskId) return res.status(500).json({ success: false, error: '未获取到 task_id: ' + text.slice(0, 200) });
    rememberTaskKey(taskId, apiKey, { provider: 'zhenzhen-legacy', model, ...providerContext.taskMeta });
    res.json({ success: true, data: { taskId, taskProvider: 'zhenzhen-legacy', model, raw: data } });
  } catch (e) {
    console.error('proxy/seedance/submit 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

router.get('/seedance/query', async (req, res) => {
  const settings = loadRawSettings();
  const taskId = String(req.query.taskId || '').trim();
  if (!taskId) return res.status(400).json({ success: false, error: 'taskId 必填' });
  const rememberedMeta = recallTaskMeta(taskId);
  const requestedTaskProvider = String(req.query.taskProvider || rememberedMeta?.provider || 'zhenzhen-legacy').trim();

  if (requestedTaskProvider === seedanceNz.PROVIDER_ID) {
    const apiKey = rememberedMeta?.apiKey || settings?.zhenzhenSd2ApiKey || '';
    try {
      const result = await seedanceNz.queryTask(taskId, apiKey);
      let videoUrl = result.videoUrl;
      if (result.status === 'succeeded' && videoUrl) {
        videoUrl = await saveRemoteVideo(videoUrl, seedanceNz.fetchRemote);
      }
      return res.json({
        success: true,
        data: {
          ...result,
          videoUrl,
          taskProvider: seedanceNz.PROVIDER_ID,
          model: rememberedMeta?.model || '',
          taskType: rememberedMeta?.taskType || '',
        },
      });
    } catch (e) {
      console.error('proxy/seedance/query seedance.nz 错误:', e?.message || e);
      const status = Number(e?.status);
      return res.status(status >= 400 && status < 600 ? status : 500).json({ success: false, error: e?.message || 'seedance.nz 查询失败', ...seedanceNzTrace(e) });
    }
  }

  if (requestedTaskProvider !== 'zhenzhen-legacy') {
    return res.status(400).json({ success: false, error: `不支持的 Seedance provider：${requestedTaskProvider}` });
  }
  if (rememberedMeta?.apiKey) {
    if (settings) settings.zhenzhenApiKey = rememberedMeta.apiKey;
    else return res.status(400).json({ success: false, error: '未找到 settings' });
  } else {
    // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
    if (!ensureKey(settings, res, 'seedance', 'Seedance')) return;
  }

  const apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;
  const upstream = `${baseUrl}/seedance/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`;

  try {
    const r = await fetch(upstream, { headers: { Authorization: `Bearer ${apiKey}` } });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) });
    }
    if (!r.ok) {
      const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
      await invalidateZhenzhenProviderKey({ taskMeta: rememberedMeta || {} }, apiKey, errorText);
      return res.status(r.status).json({ success: false, error: errorText });
    }
    // 状态归一(对齐主项目)
    let st = String(data?.status || '').toLowerCase();
    if (st === 'success') st = 'succeeded';
    if (st === 'fail' || st === 'failure') st = 'failed';

    let videoUrl = null;
    if (st === 'succeeded') {
      // 多重路径解析 video_url(对齐 pollSeedance line 3287-3296)
      let vUrl = null;
      const rc = data?.content;
      if (rc && typeof rc === 'object' && !Array.isArray(rc)) {
        vUrl = rc.video_url || rc.videoUrl;
      }
      if (!vUrl && data?.data && typeof data.data === 'object') {
        const dc = data.data.content;
        if (dc && typeof dc === 'object') vUrl = dc.video_url || dc.videoUrl;
        if (!vUrl) vUrl = data.data.video_url || data.data.videoUrl;
      }
      if (!vUrl && Array.isArray(data?.results)) {
        for (const it of data.results) {
          if (it && (it.outputType === 'mp4' || it.outputType === 'video' || (it.url && /\.mp4(\?|$)/i.test(it.url)))) {
            vUrl = it.url; break;
          }
          if (it && it.url && !vUrl) vUrl = it.url;
        }
      }
      if (!vUrl && Array.isArray(data?.content)) {
        for (const it of data.content) {
          if (it?.type === 'video_url') {
            const vu = it.video_url;
            vUrl = typeof vu === 'string' ? vu : (vu && vu.url);
            if (vUrl) break;
          }
        }
      }
      if (!vUrl) vUrl = data?.video_url || data?.videoUrl;

      if (vUrl) {
        // 转存到本地
        videoUrl = await saveRemoteVideo(vUrl);
      }
    }

    return res.json({
      success: true,
      data: {
        status: st || 'pending',
        progress: data?.progress || '',
        videoUrl,
        failReason: data?.fail_reason || data?.failReason || null,
        taskProvider: 'zhenzhen-legacy',
        raw: data,
      },
    });
  } catch (e) {
    console.error('proxy/seedance/query 错误:', e);
    res.status(500).json({ success: false, error: e.message || '查询失败' });
  }
});

// ========================================================================
// 音频生成(Suno - 异步)
// 协议(贞贞工坊):POST /suno/generate + GET /suno/feed/:clipIds + POST /suno/submit/music
// 模式:generate / cover / extend
// 严格对齐主项目 gpt-image-2-web 的 SUNO_MV_MAP (7 个版本)
// ========================================================================
const SUNO_MV_MAP = {
  'v3.0': 'chirp-v3.0',
  'v3.5': 'chirp-v3.5',
  'v4': 'chirp-v4',
  'v4.5': 'chirp-auk',
  'v4.5+': 'chirp-bluejay',
  'v5': 'chirp-crow',
  'v5.5': 'chirp-fenix',
};

// 兼容带 'suno-' 前缀的旧调用方 (如 'suno-v5.5')
function resolveSunoMv(version) {
  const v = String(version || 'v5.5').replace(/^suno-/i, '');
  return SUNO_MV_MAP[v] || 'chirp-fenix';
}

router.post('/audio/submit', async (req, res) => {
  const settings = loadRawSettings();
  // v1.2.9.15: 一体化「专属优先 fallback 通用」校验 —— 先 applyClassifiedKey('suno') 再校验 effective key
  const { mode, prompt, title, tags, version, seed, continue_clip_id, continue_at, cover_clip_id, providerParams } = req.body || {};
  if (!ensureKeyOrSelectedGroup(settings, res, 'suno', 'Suno', providerParams)) return;
  const m = mode || 'generate';
  if (!prompt && m !== 'extend') {
    return res.status(400).json({ success: false, error: 'prompt 必填' });
  }
  const mv = resolveSunoMv(version);
  try {
    const providerContext = await applyZhenzhenProviderContext(settings, {
      route: 'audio/submit',
      kind: 'audio',
      model: `suno-${version || 'v5.5'}`,
      hint: 'suno',
      providerParams,
    });
    const apiKey = settings.zhenzhenApiKey;
    const auth = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    if (m === 'generate') {
      const body = { prompt: prompt || '', tags: tags || '', mv, title: title || '' };
      if (seed && seed > 0) body.seed = seed;
      const r = await fetch(`${config.ZHENZHEN_BASE_URL}/suno/generate`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) }); }
      if (!r.ok) {
        const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
        await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
        return res.status(r.status).json({ success: false, error: errorText });
      }
      const taskId = data?.id;
      const clipIds = (data?.clips || []).map((c) => c.id).filter(Boolean);
      if (!taskId || clipIds.length < 1) return res.status(500).json({ success: false, error: '未获取到 task/clip: ' + text.slice(0, 200) });
      rememberTaskKey(taskId, apiKey, { model: `suno-${version || 'v5.5'}`, ...providerContext.taskMeta });
      for (const clipId of clipIds) rememberTaskKey(clipId, apiKey, { model: `suno-${version || 'v5.5'}`, taskId, ...providerContext.taskMeta });
      return res.json({ success: true, data: { taskId, clipIds, raw: data } });
    }
    if (m === 'extend') {
      if (!continue_clip_id) return res.status(400).json({ success: false, error: 'extend 模式需 continue_clip_id' });
      const body = { prompt: prompt || '', tags: tags || '', mv, title: title || '', task: 'upload_extend', continue_clip_id, continue_at: continue_at ?? 28 };
      if (seed && seed > 0) body.seed = seed;
      const r = await fetch(`${config.ZHENZHEN_BASE_URL}/suno/generate`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) }); }
      if (!r.ok) {
        const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
        await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
        return res.status(r.status).json({ success: false, error: errorText });
      }
      const taskId = data?.id;
      const clipIds = (data?.clips || []).map((c) => c.id).filter(Boolean);
      if (!taskId) return res.status(500).json({ success: false, error: '未获取 task' });
      rememberTaskKey(taskId, apiKey, { model: `suno-${version || 'v5.5'}`, ...providerContext.taskMeta });
      for (const clipId of clipIds) rememberTaskKey(clipId, apiKey, { model: `suno-${version || 'v5.5'}`, taskId, ...providerContext.taskMeta });
      return res.json({ success: true, data: { taskId, clipIds, raw: data } });
    }
    if (m === 'cover') {
      if (!cover_clip_id) return res.status(400).json({ success: false, error: 'cover 模式需 cover_clip_id' });
      const body = {
        prompt: prompt || '', tags: tags || '', mv, title: title || '', task: 'cover',
        cover_clip_id, generation_type: 'TEXT', make_instrumental: false, negative_tags: '',
        continue_clip_id: null, continue_at: null, continued_aligned_prompt: null,
        infill_start_s: null, infill_end_s: null,
      };
      if (seed && seed > 0) body.seed = seed;
      const r = await fetch(`${config.ZHENZHEN_BASE_URL}/suno/submit/music`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) }); }
      if (!r.ok) {
        const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
        await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
        return res.status(r.status).json({ success: false, error: errorText });
      }
      const taskId = (typeof data?.data === 'string' ? data.data : data?.id) || '';
      const clipIds = Array.isArray(data?.data) ? data.data.map((c) => c.id || c.clip_id).filter(Boolean) : (data?.clips || []).map((c) => c.id);
      if (!taskId) return res.status(500).json({ success: false, error: '未获取 task: ' + text.slice(0, 200) });
      rememberTaskKey(taskId, apiKey, { model: `suno-${version || 'v5.5'}`, ...providerContext.taskMeta });
      for (const clipId of clipIds) rememberTaskKey(clipId, apiKey, { model: `suno-${version || 'v5.5'}`, taskId, ...providerContext.taskMeta });
      return res.json({ success: true, data: { taskId, clipIds, raw: data } });
    }
    return res.status(400).json({ success: false, error: `未知模式: ${m}` });
  } catch (e) {
    console.error('proxy/audio/submit 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

router.get('/audio/query', async (req, res) => {
  const settings = loadRawSettings();
  const ids = String(req.query.clipIds || req.query.taskId || '').trim();
  if (!ids) return res.status(400).json({ success: false, error: 'clipIds 或 taskId 必填' });
  const rememberedMeta = recallTaskMeta(ids.split(',')[0]?.trim() || ids);
  if (rememberedMeta?.apiKey) {
    if (settings) settings.zhenzhenApiKey = rememberedMeta.apiKey;
    else return res.status(400).json({ success: false, error: '未找到 settings' });
  } else {
    // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
    if (!ensureKey(settings, res, 'suno', 'Suno')) return;
  }
  // 是否将完成的音频转存到本地 output 目录(默认 true)
  const saveLocal = String(req.query.saveLocal ?? 'true').toLowerCase() !== 'false';
  try {
    const r = await fetch(`${config.ZHENZHEN_BASE_URL}/suno/feed/${encodeURIComponent(ids)}`, {
      headers: { Authorization: `Bearer ${settings.zhenzhenApiKey}` },
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) }); }
    if (!r.ok) {
      const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
      await invalidateZhenzhenProviderKey({ taskMeta: rememberedMeta || {} }, settings.zhenzhenApiKey, errorText);
      return res.status(r.status).json({ success: false, error: errorText });
    }
    const clips = Array.isArray(data) ? data : (data?.clips || []);
    const tracks = [];
    for (const c of clips) {
      if (c?.status === 'complete' && c?.audio_url) {
        const remoteUrl = c.audio_url;
        const localUrl = saveLocal ? await saveRemoteAudio(remoteUrl) : remoteUrl;
        tracks.push({
          id: c.id || c.clip_id,
          clipId: c.clip_id || c.id,
          audioUrl: localUrl,
          remoteUrl,
          imageUrl: c.image_large_url || c.image_url || '',
          title: c.title || '',
          tags: c.tags || '',
          duration: c.metadata?.duration || 0,
        });
      }
    }
    const allDone = clips.length > 0 && tracks.length === clips.length;
    res.json({
      success: true,
      data: {
        status: allDone ? 'SUCCESS' : 'PENDING',
        tracks,
        total: clips.length,
        completed: tracks.length,
        raw: data,
      },
    });
  } catch (e) {
    console.error('proxy/audio/query 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// ========================================================================
// 音频上传 (Suno cover/extend 使用)
// 完全对齐主项目 gpt-image-2-web 的 _sunoUploadAudio 5 步流程:
// 1) POST /suno/uploads/audio { extension }  -> { id, url, fields? }
// 2) S3 上传: 有 fields 走 POST FormData / 无 fields 走 PUT 预签 URL
// 3) POST /suno/uploads/audio/{id}/upload-finish { upload_type, upload_filename }
// 4) GET /suno/uploads/audio/{id} 轮询 30 × 2s 直到 status='complete'
// 5) POST /suno/uploads/audio/{id}/initialize-clip {} -> { clip_id }
// ========================================================================
router.post('/audio/upload', audioUpload.single('file'), async (req, res) => {
  const settings = loadRawSettings();
  // v1.2.9.15: 修复 BUG —— 之前完全缺失 applyClassifiedKey('suno')，
  // 导致 Suno cover/extend 上传步骤即使配置了 sunoApiKey 也始终用通用 zhenzhenApiKey，
  // 与 audio/submit · audio/query 的 key 不一致。改用 ensureKey 统一「专属优先 fallback 通用」。
  if (!req.file) return res.status(400).json({ success: false, error: '未接收到音频文件 (field=file)' });
  const providerParams = parseProviderParams(req.body?.providerParams);
  if (!ensureKeyOrSelectedGroup(settings, res, 'suno', 'Suno', providerParams)) return;
  let apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;
  const audioBuf = req.file.buffer;
  const filename = req.file.originalname || 'audio.mp3';
  const ext = (filename.split('.').pop() || 'mp3').toLowerCase();
  const mimeMap = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', wma: 'audio/x-ms-wma' };
  const ct = mimeMap[ext] || req.file.mimetype || 'audio/mpeg';
  try {
    const providerContext = await applyZhenzhenProviderContext(settings, {
      route: 'audio/upload',
      kind: 'audio',
      model: 'suno-upload',
      hint: 'suno',
      providerParams,
    });
    apiKey = settings.zhenzhenApiKey;
    // 1) init
    const r1 = await fetch(`${baseUrl}/suno/uploads/audio`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ extension: ext }),
    });
    if (!r1.ok) {
      const errorText = `Upload init failed: ${r1.status} ${await r1.text()}`;
      await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
      return res.status(r1.status).json({ success: false, error: errorText });
    }
    const r1Json = await r1.json();
    const upData = (r1Json.code && r1Json.data) ? r1Json.data : r1Json;
    const uploadId = upData.id;
    const uploadUrl = upData.url;
    const fields = upData.fields;
    if (!uploadId || !uploadUrl) return res.status(500).json({ success: false, error: 'Upload init 返回无效: missing id/url' });
    // 2) S3 upload
    let r2;
    if (fields && Object.keys(fields).length > 0) {
      const fd = new FormData();
      Object.keys(fields).forEach((k) => fd.append(k, fields[k]));
      fd.append('file', new Blob([audioBuf], { type: ct }), filename);
      r2 = await fetch(uploadUrl, { method: 'POST', body: fd });
    } else {
      r2 = await fetch(uploadUrl, { method: 'PUT', body: audioBuf, headers: { 'Content-Type': ct } });
    }
    if (r2.status !== 204 && r2.status !== 200 && !r2.ok) {
      return res.status(500).json({ success: false, error: `S3 upload failed: ${r2.status}` });
    }
    // 3) finish
    const r3 = await fetch(`${baseUrl}/suno/uploads/audio/${uploadId}/upload-finish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_type: 'file_upload', upload_filename: filename }),
    });
    if (!r3.ok) {
      const errorText = `Upload finish failed: ${r3.status} ${await r3.text()}`;
      await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
      return res.status(500).json({ success: false, error: errorText });
    }
    // 4) poll status
    let clipId = '';
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const sr = await fetch(`${baseUrl}/suno/uploads/audio/${uploadId}`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!sr.ok) continue;
      const srJson = await sr.json();
      const sd = (srJson.code && srJson.data) ? srJson.data : srJson;
      const st = sd.status || sd.state || '';
      if (st === 'complete') {
        // 5) initialize-clip
        const r4 = await fetch(`${baseUrl}/suno/uploads/audio/${uploadId}/initialize-clip`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!r4.ok) {
          const errorText = `Initialize clip failed: ${r4.status} ${await r4.text()}`;
          await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
          return res.status(500).json({ success: false, error: errorText });
        }
        const r4Json = await r4.json();
        const initData = (r4Json.code && r4Json.data) ? r4Json.data : r4Json;
        clipId = initData.clip_id || initData.id || '';
        break;
      } else if (st === 'failed' || st === 'error') {
        const errMsg = sd.error_message || sd.error || sd.detail || sd.message || st;
        return res.status(500).json({ success: false, error: `音频处理失败: ${errMsg}` });
      }
    }
    if (!clipId) return res.status(504).json({ success: false, error: 'Upload timeout - no clip_id (60s)' });
    return res.json({ success: true, data: { clipId, uploadId, filename, size: req.file.size, mime: ct } });
  } catch (e) {
    console.error('proxy/audio/upload 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// ========================================================================
// RunningHub 工作流(异步)
// 协议:POST /task/openapi/ai-app/run + POST /task/openapi/outputs
// 国内站使用 settings.rhApiKey，海外站使用 settings.rhIntlApiKey。
// RH 钱包应用仍只做 UI 区分，不再拥有独立钱包 Key。
// ========================================================================

function rhRequestedSite(value) {
  return normalizeRhSite(value);
}

function isRhTaskStateCode(code) {
  return ['0', '804', '813', '805'].includes(String(code));
}

function logRhSiteFallback(stage, from, to, detail = '') {
  console.warn(`[RH/${stage}] ${from.id} -> ${to.id} 自动切换站点${detail ? ` · ${detail}` : ''}`);
}

router.post('/runninghub/submit', async (req, res) => {
  const settings = loadRawSettings();
  const { webappId, nodeInfoList, instanceType } = req.body || {};
  const requestedSite = rhRequestedSite(req.body?.site);
  const candidates = buildRhSiteCandidates(settings, requestedSite);
  if (candidates.length === 0) return res.status(400).json({ success: false, error: missingRhKeyError(requestedSite) });
  if (!webappId) return res.status(400).json({ success: false, error: 'webappId 必填' });
  try {
    let lastResponse = null;
    let lastData = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const body = { apiKey: candidate.apiKey, webappId, nodeInfoList: nodeInfoList || [] };
      if (instanceType) body.instanceType = instanceType;
      const r = await fetch(`${candidate.baseUrl}/task/openapi/ai-app/run`, {
        method: 'POST',
        headers: { Host: candidate.host, 'Content-Type': 'application/json', Authorization: `Bearer ${candidate.apiKey}` },
        body: JSON.stringify(body),
      });
      const data = await parseJsonResponse(r, `RH ${candidate.label}提交接口`);
      lastResponse = r;
      lastData = data;
      if (String(data?.code) === '0' && data?.data?.taskId) {
        const taskId = data.data.taskId;
        rememberTaskKey(taskId, candidate.apiKey, {
          provider: 'runninghub',
          webappId,
          instanceType: instanceType || '',
          rhSite: candidate.id,
        });
        console.log(`[RH/submit] site=${candidate.id} webappId=${webappId} fields=${Array.isArray(nodeInfoList) ? nodeInfoList.length : 0} instance=${instanceType || 'default'} taskId=${taskId}`);
        return res.json({
          success: true,
          data: { taskId, site: candidate.id, fallbackUsed: candidate.id !== requestedSite, raw: data },
        });
      }
      const next = candidates[index + 1];
      if (!next || !shouldRetryRhSiteResponse(r, data)) break;
      logRhSiteFallback('submit', candidate, next, data?.msg || `HTTP ${r.status}`);
    }
    console.warn(`[RH/submit] failed webappId=${webappId} code=${lastData?.code} msg=${lastData?.msg || ''}`);
    return res.status(lastResponse?.status === 401 || lastResponse?.status === 403 ? lastResponse.status : 400).json({
      success: false,
      error: lastData?.msg || `RH 提交失败 code=${lastData?.code}`,
    });
  } catch (e) {
    console.error('proxy/rh/submit 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

router.get('/runninghub/query', async (req, res) => {
  const settings = loadRawSettings();
  const taskId = String(req.query.taskId || '').trim();
  if (!taskId) return res.status(400).json({ success: false, error: 'taskId 必填' });
  const taskMeta = recallTaskMeta(taskId);
  const requestedSite = rhRequestedSite(taskMeta?.rhSite || req.query.site);
  const candidates = buildRhSiteCandidates(settings, requestedSite, taskMeta?.apiKey || '');
  if (candidates.length === 0) return res.status(400).json({ success: false, error: missingRhKeyError(requestedSite) });
  try {
    let selectedCandidate = candidates[0];
    let selectedData = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const r = await fetch(`${candidate.baseUrl}/task/openapi/outputs`, {
        method: 'POST',
        headers: { Host: candidate.host, 'Content-Type': 'application/json', Authorization: `Bearer ${candidate.apiKey}` },
        body: JSON.stringify({ apiKey: candidate.apiKey, taskId }),
      });
      const data = await parseJsonResponse(r, `RH ${candidate.label}查询接口`);
      selectedCandidate = candidate;
      selectedData = data;
      if (isRhTaskStateCode(data?.code)) break;
      const next = candidates[index + 1];
      if (!next || !shouldRetryRhSiteResponse(r, data)) break;
      logRhSiteFallback('query', candidate, next, data?.msg || `HTTP ${r.status}`);
    }
    const data = selectedData || {};
    rememberTaskKey(taskId, selectedCandidate.apiKey, { ...(taskMeta || {}), provider: 'runninghub', rhSite: selectedCandidate.id });
    // code 0=成功 / 804=运行中 / 813=排队 / 805=失败
    const taskCode = String(data.code ?? '');
    let status = 'PENDING';
    let urls = [];
    if (taskCode === '0') {
      status = 'SUCCESS';
      // RH outputs 返回结构兼容：
      //   ① data: [{fileUrl, fileType}, ...]                  // 常见 (AI 应用)
      //   ② data: { outputs: [...] }                            // 包一层的变体
      //   ③ data: { fileUrl, fileType }                         // 单产物对象
      //   ④ data: { results: [...] } / { files: [...] }         // 边缘变体
      //   ⑤ data: { data/output/images/... }                    // 应用市场嵌套变体
      const arr = collectRunningHubOutputItems(data.data);
      if (arr.length === 0) {
        const shape = JSON.stringify(summarizeRunningHubOutputShape(data.data)).slice(0, 1800);
        console.warn(`[RH/query] taskId=${taskId} code=0 but no output urls. shape=${shape}`);
      }
      // 转存所有产物到本地
      for (const it of arr) {
        const remote = it?.fileUrl || it?.file_url || it?.downloadUrl || it?.download_url || it?.resultUrl || it?.result_url || it?.outputUrl || it?.output_url || it?.signedUrl || it?.signed_url || it?.publicUrl || it?.public_url || it?.previewUrl || it?.preview_url || it?.url;
        if (!remote) continue;
        try {
          const fr = await fetch(remote);
          if (fr.ok) {
            let buf = Buffer.from(await fr.arrayBuffer());
            let ext = inferRemoteOutputExt(remote, fr.headers.get('content-type'));
            const duck = await tryDecodeDuckPayload(buf);
            if (duck?.decoded && duck.buffer) {
              buf = duck.buffer;
              ext = safeOutputExt(duck.ext, ext);
              console.log(
                '[RH/query][duck] decoded',
                `bits=${duck.lsbBits}`,
                `${duck.originalExt} -> ${ext}`,
                `kind=${duck.kind}`,
                `bytes=${buf.length}`,
              );
            } else if (duck?.passwordProtected) {
              console.log('[RH/query][duck] password protected payload detected, keep original duck image');
            }
            const filename = `rh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
            fs.writeFileSync(path.join(config.OUTPUT_DIR, filename), buf);
            urls.push(`/files/output/${filename}`);
          } else {
            urls.push(remote);
          }
        } catch (downloadError) {
          console.warn(`[RH/query] save output failed taskId=${taskId} url=${String(remote).slice(0, 140)} error=${downloadError?.message || downloadError}`);
          urls.push(remote);
        }
      }
    } else if (taskCode === '804') status = 'RUNNING';
    else if (taskCode === '813') status = 'QUEUED';
    else if (taskCode === '805') status = 'FAILED';
    else status = 'UNKNOWN';
    // failReason 序列化为字符串：ComfyUI 报错可能是 object（traceback/exception_message/...）
    // 前端直接用于 setError 会造成 React JSX 渲染 object 崩溃。
    let failReasonRaw = data?.data?.failedReason ?? data?.data?.failReason ?? null;
    let failReasonStr = null;
    if (failReasonRaw != null) {
      if (typeof failReasonRaw === 'string') {
        failReasonStr = failReasonRaw;
      } else if (typeof failReasonRaw === 'object') {
        failReasonStr = failReasonRaw.exception_message || failReasonRaw.message || JSON.stringify(failReasonRaw);
      } else {
        failReasonStr = String(failReasonRaw);
      }
    }
    console.log(`[RH/query] site=${selectedCandidate.id} taskId=${taskId} status=${status} code=${data.code} urls=${urls.length}${failReasonStr ? ` fail=${String(failReasonStr).slice(0, 160)}` : ''}`);
    res.json({
      success: true,
      data: {
        status,
        urls,
        failReason: failReasonStr,
        code: data.code,
        site: selectedCandidate.id,
        fallbackUsed: selectedCandidate.id !== requestedSite,
        raw: data,
      },
    });
  } catch (e) {
    console.error('proxy/rh/query 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

router.post('/runninghub/cancel', async (req, res) => {
  const settings = loadRawSettings();
  const taskId = String(req.body?.taskId || '').trim();
  if (!taskId) return res.status(400).json({ success: false, error: 'taskId 必填' });
  const taskMeta = recallTaskMeta(taskId);
  const requestedSite = rhRequestedSite(taskMeta?.rhSite || req.body?.site);
  const candidates = buildRhSiteCandidates(settings, requestedSite, taskMeta?.apiKey || '');
  if (candidates.length === 0) return res.status(400).json({ success: false, error: missingRhKeyError(requestedSite) });
  try {
    let lastResponse = null;
    let lastData = null;
    let lastCandidate = candidates[0];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const r = await fetch(`${candidate.baseUrl}/task/openapi/cancel`, {
        method: 'POST',
        headers: { Host: candidate.host, 'Content-Type': 'application/json', Authorization: `Bearer ${candidate.apiKey}` },
        body: JSON.stringify({ apiKey: candidate.apiKey, taskId }),
      });
      const data = await parseJsonResponse(r, `RH ${candidate.label}取消接口`);
      lastResponse = r;
      lastData = data;
      lastCandidate = candidate;
      console.log(`[RH/cancel] site=${candidate.id} taskId=${taskId} http=${r.status} code=${data?.code} msg=${data?.msg || ''}`);
      if (String(data?.code) === '0') {
        rememberTaskKey(taskId, candidate.apiKey, { ...(taskMeta || {}), provider: 'runninghub', rhSite: candidate.id });
        return res.json({ success: true, data: { taskId, site: candidate.id, fallbackUsed: candidate.id !== requestedSite, raw: data } });
      }
      const next = candidates[index + 1];
      if (!next || !shouldRetryRhSiteResponse(r, data)) break;
      logRhSiteFallback('cancel', candidate, next, data?.msg || `HTTP ${r.status}`);
    }
    try {
      console.warn(`[RH/cancel] failed site=${lastCandidate.id} taskId=${taskId} raw=${JSON.stringify(lastData).slice(0, 500)}`);
    } catch {}
    return res.status(lastResponse?.status === 401 || lastResponse?.status === 403 ? lastResponse.status : 400).json({ success: false, error: lastData?.msg || `RH 取消失败 code=${lastData?.code}` });
  } catch (e) {
    console.error('proxy/rh/cancel 错误:', e);
    res.status(502).json({
      success: false,
      error: e.message || '请求失败',
      data: {
        taskId,
        contentType: e.contentType || '',
        preview: e.preview || '',
      },
    });
  }
});

// ----------------------------------------------------------------
// POST /runninghub/upload-asset
// 通用素材→RH 上传转换：
//   入参 JSON: { url: '/files/output/xxx.png' | 'https://....' }
//   出参: { success, data: { fileName, fileType } }
// 用途: RhConfigNode 中 valueType=image|video|audio 的条目，
//       提交工作流前先把 url 转成 RH 内部 fileName，再写入 nodeInfoList.fieldValue。
// 协议: POST {RH}/task/openapi/upload  (multipart: apiKey, fileType=input, file)
// ----------------------------------------------------------------
router.post('/runninghub/upload-asset', express.json({ limit: '20mb' }), async (req, res) => {
  const settings = loadRawSettings();
  const requestedSite = rhRequestedSite(req.body?.site);
  const candidates = buildRhSiteCandidates(settings, requestedSite);
  if (candidates.length === 0) return res.status(400).json({ success: false, error: missingRhKeyError(requestedSite) });
  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ success: false, error: 'url 必填' });
  try {
    // 1) 拿到 buffer + mime + filename
    let buf;
    let mime = 'application/octet-stream';
    let baseName = 'asset';
    if (url.startsWith('/files/output/') || url.startsWith('/output/')) {
      // 本地静态资源 - 输出目录
      const rel = url.replace(/^\/files\/output\//, '').replace(/^\/output\//, '');
      const full = path.join(config.OUTPUT_DIR, rel);
      if (!fs.existsSync(full)) return res.status(404).json({ success: false, error: '本地文件不存在: ' + url });
      buf = fs.readFileSync(full);
      baseName = path.basename(full);
    } else if (url.startsWith('/files/input/') || url.startsWith('/input/')) {
      // 本地静态资源 - 上传目录（视频/音频/参考图上传节点的产物）
      const rel = url.replace(/^\/files\/input\//, '').replace(/^\/input\//, '');
      const full = path.join(config.INPUT_DIR, rel);
      if (!fs.existsSync(full)) return res.status(404).json({ success: false, error: '本地文件不存在: ' + url });
      buf = fs.readFileSync(full);
      baseName = path.basename(full);
    } else if (/^https?:\/\//i.test(url)) {
      const fr = await fetch(url);
      if (!fr.ok) return res.status(400).json({ success: false, error: `下载素材失败 HTTP ${fr.status}` });
      buf = Buffer.from(await fr.arrayBuffer());
      mime = fr.headers.get('content-type') || mime;
      const tail = url.split(/[?#]/)[0];
      baseName = tail.split('/').pop() || baseName;
    } else {
      return res.status(400).json({ success: false, error: '不支持的 url: ' + url });
    }
    // 2) 根据扩展名校正 mime
    const extMatch = baseName.match(/\.([a-zA-Z0-9]+)$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : '';
    const mimeMap = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v', mkv: 'video/x-matroska',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
    };
    if (mimeMap[ext]) mime = mimeMap[ext];
    if (!ext) baseName += '.bin';
    // 3) FormData 上传到 RH
    let lastData = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const fd = new FormData();
      fd.append('apiKey', candidate.apiKey);
      fd.append('fileType', 'input');
      fd.append('file', new Blob([buf], { type: mime }), baseName);
      const r = await fetch(`${candidate.baseUrl}/task/openapi/upload`, {
        method: 'POST',
        headers: { Host: candidate.host, Authorization: `Bearer ${candidate.apiKey}` },
        body: fd,
      });
      const data = await parseJsonResponse(r, `RH ${candidate.label}上传接口`);
      lastData = data;
      console.log('[RH/upload-asset]', `site=${candidate.id}`, baseName, mime, buf.length, '→', data?.code, data?.data?.fileName);
      if (String(data?.code) === '0' && data?.data?.fileName) {
        return res.json({ success: true, data: { fileName: data.data.fileName, fileType: data.data.fileType || mime, site: candidate.id, fallbackUsed: candidate.id !== requestedSite } });
      }
      const next = candidates[index + 1];
      if (!next || !shouldRetryRhSiteResponse(r, data)) break;
      logRhSiteFallback('upload', candidate, next, data?.msg || `HTTP ${r.status}`);
    }
    return res.status(400).json({ success: false, error: lastData?.msg || `RH 上传失败 code=${lastData?.code}` });
  } catch (e) {
    console.error('proxy/rh/upload-asset 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// 获取 AI 应用信息(nodeInfoList 等)
router.get('/runninghub/app-info', async (req, res) => {
  const settings = loadRawSettings();
  const requestedSite = rhRequestedSite(req.query.site);
  const candidates = buildRhSiteCandidates(settings, requestedSite);
  if (candidates.length === 0) return res.status(400).json({ success: false, error: missingRhKeyError(requestedSite) });
  const webappId = String(req.query.webappId || '').trim();
  if (!webappId) return res.status(400).json({ success: false, error: 'webappId 必填' });
  try {
    let lastData = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const url = `${candidate.baseUrl}/api/webapp/apiCallDemo?apiKey=${encodeURIComponent(candidate.apiKey)}&webappId=${encodeURIComponent(webappId)}`;
      const r = await fetch(url, { method: 'GET', headers: { Host: candidate.host, Authorization: `Bearer ${candidate.apiKey}` } });
      const data = await parseJsonResponse(r, `RH ${candidate.label}应用参数接口`);
      lastData = data;
      if (String(data?.code) === '0') {
        return res.json({
          success: true,
          data: { ...(data.data || {}), rhSite: candidate.id, rhFallbackUsed: candidate.id !== requestedSite },
        });
      }
      const next = candidates[index + 1];
      if (!next || !shouldRetryRhSiteResponse(r, data)) break;
      logRhSiteFallback('app-info', candidate, next, data?.msg || `HTTP ${r.status}`);
    }
    return res.status(400).json({ success: false, error: lastData?.msg || `RH 查询失败 code=${lastData?.code}` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

module.exports = router;
