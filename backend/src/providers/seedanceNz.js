const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { Agent, fetch: undiciFetch } = require('undici');
const config = require('../config');
const { mimeFromPath, resolveMediaRef } = require('./mediaResolver');
const { providerTrace } = require('./providerTrace');

const PROVIDER_ID = 'seedance-nz';
const BASE_URL = config.ZHENZHEN_SD2_BASE_URL;
const TASK_TYPES = new Set(['t2v', 'i2v', 'multi']);
const TIERS = new Set(['standard', 'fast', 'mini']);
const RATIOS = new Set(['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9']);
const RESOLUTIONS = new Set(['480p', '720p', '1080p', '2k', '4k', 'native1080p', 'native4k']);
const IMAGE_MODEL_PAIRS = {
  domestic: ['seedream-v5-pro-t2i', 'seedream-v5-pro-i2i'],
  overseas: ['dola-seedream-5.0-pro-t2i', 'dola-seedream-5.0-pro-i2i'],
};
const IMAGE_MODELS = new Set(Object.values(IMAGE_MODEL_PAIRS).flat());
const IMAGE_RESOLUTIONS = new Set(['1k', '2k']);
const IMAGE_OUTPUT_FORMATS = new Set(['jpeg', 'png']);
const HAPPYHORSE_MODELS = new Set([
  'happyhorse-1.1-t2v',
  'happyhorse-1.1-i2v',
  'happyhorse-1.1-r2v',
]);
const HAPPYHORSE_RESOLUTIONS = new Set(['720p', '1080p']);
const WAN27_SPICY_MODEL = 'wan-2.7-spicy-i2v';
const WAN27_SPICY_RESOLUTIONS = new Set(['720p', '1080p']);
const SEED_AUDIO_MODEL = 'doubao-seed-audio-1.0';
const SEED_AUDIO_FORMATS = new Set(['wav', 'mp3', 'pcm', 'ogg_opus']);
const SEED_AUDIO_SAMPLE_RATES = new Set(['8000', '16000', '24000', '32000', '44100']);
const IMAGE_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_UPLOAD_INTERVAL_MS = 6100;
const DEFAULT_UPLOAD_CACHE_TTL_MS = 20 * 60 * 60 * 1000;

// api.seedance.nz currently serves the new Let's Encrypt Generation Y chain.
// Electron's Node 20 CA bundle predates Root YR, so trust the official pinned
// root for this provider only while retaining normal hostname/signature checks.
// Source: https://letsencrypt.org/certs/gen-y/root-yr.pem
const LETS_ENCRYPT_ROOT_YR = `-----BEGIN CERTIFICATE-----
MIIFKTCCAxGgAwIBAgIRAOxGNJNgz0sP+KmC2Tqpyj0wDQYJKoZIhvcNAQELBQAw
LjELMAkGA1UEBhMCVVMxDTALBgNVBAoTBElTUkcxEDAOBgNVBAMTB1Jvb3QgWVIw
HhcNMjUwOTAzMDAwMDAwWhcNNDUwOTAyMjM1OTU5WjAuMQswCQYDVQQGEwJVUzEN
MAsGA1UEChMESVNSRzEQMA4GA1UEAxMHUm9vdCBZUjCCAiIwDQYJKoZIhvcNAQEB
BQADggIPADCCAgoCggIBANvGJnN78CTJdWL3+eGfsLN5TrNBJs+VH9hRXqRbwxu9
sGNiB0BD1fcOxbSUQCJIM1xE13Db+5Cw1w0s0EBYsvuIP/6joF0w8cuImbgR1OGg
YbSQ4OpzI+DG8SGuTlcE873OCS+kh3srlo6vl43M5OJg4Aeo1sfHp6kTJDoIiFBN
JAY+OKfX/FUvYKuhjT+no49lmqmupSBI5PkBQiqrEGtWU5uxU/cQWHGu8jSjFBzn
ZqvbNPLMXMLFxCb3WTfrJBXXjqvWG+v4bjzxjjeAtOlU7qarRDvNOyAuQYLln904
M+faKx8hnLCpJ15ZqaEgcNlY+9MMWcC5yvL2A2j3l9+2buggZX+dOE91zYmIdawT
vSZuVvlbRrAlLxIB6pwMBjneXCjYQ8+3BCCjssbSNpZU3hTcBDdhfAlEDlYr6pEa
tnMdmDT5BqnKC92bd0EhM1fbLHioLccLCuievT8ZkPhZrq7Mii7gNXAcUEAR8+lz
Yal+9zTg7C5DALyVOeG/CqfRAMn1KSHCR0NSA6P8tn/mGRlnCct5rtVCLnVySVpU
6H1qGg3DgTOuskf8eahTMiYbI5ezPJmO5ertalskQ1utp74+eDy92PI4ftHKTbq9
IWhH4YZKh3WnJEIt+oQvlYZbY8tpEroKrFB6PFGzrJIDRyts4HqvuH52RFj2zv/B
AgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1Ud
DgQWBBTe51tg0CJtQCh9Pw0B/qS1UrRRlDANBgkqhkiG9w0BAQsFAAOCAgEAWHnf
713Bdkq7t5yN2dNIgQakUb94X9WuyhMEHHkgx4oDpSUlnG0w4g94MoqaEUE31ZjR
LU7L5LD1g9ujFHTQu8AD215AHMVQFbm6j8hQxdXHAzDajFNQnOlDJrLjzIx176oy
AjvUtejZx2NNmdb5fd0WGVGsCdoAJ3N8ozo7ajE8t6vfxStZb4BQ9WYJGHUDrv2N
i5tJF6CNiPnlzs3BUfECRbE4JSk+jvy8+VoGiFE8qsH/j78x2fjgQhAQFV7P7Zxy
dBTZ1wEkNpZNW2qnaK1SKBLa+xf6E06YRIq5uaI+HWH8SY1y5VbRgzq40EKg3yxP
06fz+uYAUIFJoLNfhwRCc3Q6pQVuMX3yAjHAes4gk4moGcLQ5p7HAh39yeylZc1J
41sx/jKwLIkPE6Rr1Nf4pxdsxf9SA4yOEiAkDgq04DVxn8hgYFdUtBCuiuVC2heA
EiqVEa+8QZjuw8Gj0EbHXcRd1nInvGqRS1o9Is7YBdQN57X1AYveGBNNqjICSb7c
awuw1EawTDrs13VUlJVEsbQ0/O/1aaV73mCdOQ8azqL2KTv1Ewu1xbquE2S+kdQU
To9TUwat3wUA6cwXh1EfpS/3fJ0aGah5hdpRyoCLDlsSn8tkrjMfFFX0viC+GxHc
sI1ANRYvqSFC2X1VRZfDg+wD6E21BccmifG4yWc=
-----END CERTIFICATE-----`;
const seedanceDispatcher = new Agent({
  connect: {
    ca: [...tls.rootCertificates, LETS_ENCRYPT_ROOT_YR],
    rejectUnauthorized: true,
  },
});

const uploadCache = new Map();
const uploadQueues = new Map();

function secureFetch(url, init = {}) {
  return undiciFetch(url, { ...init, dispatcher: seedanceDispatcher });
}

function getFetchImpl(options = {}) {
  return options.fetchImpl || secureFetch;
}

function cleanBaseUrl(value) {
  return String(value || BASE_URL).trim().replace(/\/+$/, '');
}

function hashKey(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 20);
}

function normalizeList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function normalizeResolution(value) {
  const raw = String(value || '720p').trim();
  const normalized = raw.toLowerCase() === 'native4k' ? 'native4k' : raw;
  if (!RESOLUTIONS.has(normalized)) {
    throw new Error(`seedance.nz 不支持分辨率 ${raw}`);
  }
  return normalized;
}

function normalizeRatio(value) {
  const ratio = String(value || '16:9').trim();
  if (!RATIOS.has(ratio)) throw new Error(`seedance.nz 不支持比例 ${ratio}`);
  return ratio;
}

function normalizeSeconds(value) {
  const raw = String(value ?? '5').trim();
  const seconds = Number(raw);
  if (raw === '-1') return '-1';
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 15) {
    throw new Error('seedance.nz 时长只支持 4-15 秒或 -1 自动时长');
  }
  return String(seconds);
}

function normalizeHappyHorseSeconds(value) {
  const seconds = Number(String(value ?? '4').trim());
  if (!Number.isInteger(seconds) || seconds < 3 || seconds > 15) {
    throw new Error('Happy Horse 时长只支持 3-15 秒');
  }
  return String(seconds);
}

function normalizeWanSeconds(value) {
  const seconds = Number(String(value ?? '2').trim());
  if (!Number.isInteger(seconds) || seconds < 2 || seconds > 15) {
    throw new Error('Wan 2.7 Spicy 时长只支持 2-15 秒');
  }
  return String(seconds);
}

function normalizeBoundedInteger(value, name, min, max, fallback = 0) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 必须是 ${min}-${max} 的整数`);
  }
  return parsed;
}

function normalizePromptMentions(prompt) {
  return String(prompt || '').replace(
    /@(image|video|audio)[_\s-]*(\d+)/gi,
    (_match, type, index) => `@${String(type).charAt(0).toUpperCase()}${String(type).slice(1).toLowerCase()} ${index}`,
  );
}

function parseModelFamily(selection) {
  const raw = String(selection || '').trim().toLowerCase();
  const exact = raw.match(/^seedance-2\.0-(global-)?(standard|fast|mini)(?:-(t2v|i2v|multi))?$/);
  if (exact) return { global: !!exact[1], tier: exact[2] };
  const global = raw.includes('global');
  const tier = raw.includes('mini') ? 'mini' : (raw.includes('fast') ? 'fast' : 'standard');
  return { global, tier };
}

function resolveModel(selection, taskType) {
  if (!TASK_TYPES.has(taskType)) throw new Error(`未知 Seedance 任务类型：${taskType}`);
  const family = parseModelFamily(selection);
  if (!TIERS.has(family.tier)) throw new Error(`未知 Seedance 模型档位：${family.tier}`);
  return `seedance-2.0-${family.global ? 'global-' : ''}${family.tier}-${taskType}`;
}

function deriveTaskType(request) {
  const hasFirst = !!String(request.firstFrame || '').trim();
  const hasLast = !!String(request.lastFrame || '').trim();
  const images = normalizeList(request.refImages);
  const videos = normalizeList(request.videos);
  const audios = normalizeList(request.audios);
  const hasExtraRefs = images.length > 0 || videos.length > 0 || audios.length > 0;

  if (hasLast && !hasFirst) throw new Error('末帧模式必须同时提供首帧');
  if ((hasFirst || hasLast) && hasExtraRefs) {
    throw new Error('首帧/首尾帧任务不能同时混入参考图、视频或音频；请切换“自动/多参”模式');
  }
  if (hasFirst) return 'i2v';
  if (hasExtraRefs) return 'multi';
  return 't2v';
}

function ensureMediaLimits(taskType, request) {
  if (taskType === 'i2v') {
    const count = [request.firstFrame, request.lastFrame].filter((item) => !!String(item || '').trim()).length;
    if (count < 1 || count > 2) throw new Error('i2v 任务只支持 1-2 张首尾帧图片');
    return;
  }
  if (taskType !== 'multi') return;
  const imageCount = normalizeList(request.refImages).length;
  const videoCount = normalizeList(request.videos).length;
  const audioCount = normalizeList(request.audios).length;
  if (imageCount > 9) throw new Error('multi 任务最多支持 9 张图片');
  if (videoCount > 3) throw new Error('multi 任务最多支持 3 个视频');
  if (audioCount > 3) throw new Error('multi 任务最多支持 3 个音频');
}

function isPublicRemoteUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return false;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
    const private172 = host.match(/^172\.(\d+)\./);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
    return true;
  } catch {
    return false;
  }
}

function defaultMime(kind) {
  if (kind === 'image') return 'image/png';
  if (kind === 'video') return 'video/mp4';
  if (kind === 'audio') return 'audio/mpeg';
  return 'application/octet-stream';
}

function extensionFromMime(mime, kind) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/mp4': '.m4a',
  };
  return map[mime] || (kind === 'image' ? '.png' : kind === 'video' ? '.mp4' : '.bin');
}

function maxBytesForKind(kind) {
  return (kind === 'image' ? 30 : 50) * 1024 * 1024;
}

function ensureSize(buffer, kind, maxBytes) {
  const max = Number(maxBytes) || maxBytesForKind(kind);
  if (buffer.length > max) {
    throw new Error(`${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}超过 seedance.nz ${max / 1024 / 1024}MB 上限`);
  }
}

async function responseJson(response, label) {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} 返回非 JSON：HTTP ${response.status} · ${text.replace(/\s+/g, ' ').slice(0, 180)}`);
  }
}

function upstreamError(data, status) {
  return String(
    data?.error?.message
    || data?.error
    || data?.message
    || data?.detail
    || `seedance.nz HTTP ${status}`,
  );
}

function createUpstreamError(data, responseOrStatus) {
  const response = responseOrStatus && typeof responseOrStatus === 'object' ? responseOrStatus : null;
  const status = Number(response?.status ?? responseOrStatus);
  const error = new Error(upstreamError(data, status));
  error.status = status;
  Object.assign(error, providerTrace(response, data));
  return error;
}

function uploadUrlFromResponse(data) {
  return String(
    data?.url
    || data?.file_url
    || data?.fileUrl
    || data?.data?.url
    || data?.data?.file_url
    || data?.data?.fileUrl
    || data?.file?.url
    || '',
  ).trim();
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withUploadQueue(apiKey, intervalMs, task) {
  const queueKey = hashKey(apiKey);
  const state = uploadQueues.get(queueKey) || { tail: Promise.resolve(), lastAt: 0 };
  let release;
  const slot = new Promise((resolve) => { release = resolve; });
  const previous = state.tail.catch(() => {});
  state.tail = previous.then(() => slot);
  uploadQueues.set(queueKey, state);
  await previous;
  try {
    const waitMs = Math.max(0, Number(intervalMs || 0) - (Date.now() - state.lastAt));
    if (waitMs > 0) await sleep(waitMs);
    return await task();
  } finally {
    state.lastAt = Date.now();
    release();
  }
}

async function mediaBuffer(source, kind, fetchImpl, maxBytes) {
  const text = String(source || '').trim();
  const dataMatch = text.match(/^data:([^;,]+);base64,(.+)$/i);
  if (dataMatch) {
    const buffer = Buffer.from(dataMatch[2], 'base64');
    ensureSize(buffer, kind, maxBytes);
    return {
      buffer,
      mime: dataMatch[1] || defaultMime(kind),
      fileName: `seedance-${kind}${extensionFromMime(dataMatch[1], kind)}`,
    };
  }

  const resolved = await resolveMediaRef(text, { target: 'url' });
  if (resolved.kind === 'local-path') {
    const buffer = fs.readFileSync(resolved.path);
    ensureSize(buffer, kind, maxBytes);
    return {
      buffer,
      mime: resolved.mime || mimeFromPath(resolved.path, defaultMime(kind)),
      fileName: path.basename(resolved.path),
    };
  }

  const response = await fetchImpl(resolved.url);
  if (!response.ok) throw new Error(`读取待上传${kind}失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  ensureSize(buffer, kind, maxBytes);
  const mime = String(response.headers?.get?.('content-type') || defaultMime(kind)).split(';')[0];
  let fileName = `seedance-${kind}${extensionFromMime(mime, kind)}`;
  try {
    const remoteName = path.basename(new URL(resolved.url).pathname);
    if (remoteName) fileName = remoteName;
  } catch {}
  return { buffer, mime, fileName };
}

async function uploadMedia(source, kind, apiKey, options = {}) {
  const text = String(source || '').trim();
  if (!text) throw new Error(`待上传${kind}为空`);
  if (isPublicRemoteUrl(text)) return text;

  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const intervalMs = options.uploadIntervalMs ?? DEFAULT_UPLOAD_INTERVAL_MS;
  const ttlMs = options.uploadCacheTtlMs ?? DEFAULT_UPLOAD_CACHE_TTL_MS;
  const cacheKey = `${hashKey(apiKey)}:${kind}:${Number(options.maxBytes) || 0}:${hashKey(text)}`;
  const cached = uploadCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < ttlMs) return cached.promise;

  const promise = withUploadQueue(apiKey, intervalMs, async () => {
    const file = await mediaBuffer(text, kind, fetchImpl, options.maxBytes);
    if (Array.isArray(options.allowedMimes) && !options.allowedMimes.includes(String(file.mime || '').toLowerCase())) {
      throw new Error(`seedance.nz 不支持该${kind}格式：${file.mime || 'unknown'}`);
    }
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const form = new FormData();
        form.append('file', new Blob([file.buffer], { type: file.mime }), file.fileName);
        const response = await fetchImpl(`${baseUrl}/v1/files/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        });
        const data = await responseJson(response, 'seedance.nz 文件上传');
        if (!response.ok) {
          throw createUpstreamError(data, response);
        }
        const url = uploadUrlFromResponse(data);
        if (!url) throw new Error('seedance.nz 文件上传成功但未返回 URL');
        return url;
      } catch (error) {
        lastError = error;
        const retryable = !error?.status || error.status === 429 || error.status >= 500;
        if (!retryable || attempt === 2) break;
        await sleep(1000 * (2 ** attempt));
      }
    }
    throw lastError || new Error('seedance.nz 文件上传失败');
  });

  uploadCache.set(cacheKey, { createdAt: Date.now(), promise });
  try {
    return await promise;
  } catch (error) {
    uploadCache.delete(cacheKey);
    throw error;
  }
}

async function buildPayload(request, apiKey, options = {}) {
  const taskType = deriveTaskType(request);
  ensureMediaLimits(taskType, request);
  const model = resolveModel(request.model, taskType);
  const family = parseModelFamily(model);
  const resolution = normalizeResolution(request.resolution);
  if (resolution.startsWith('native') && family.tier !== 'standard') {
    throw new Error('native1080p/native4k 只支持 Standard 模型');
  }

  const prompt = normalizePromptMentions(request.prompt).trim();
  if ((taskType === 't2v' || taskType === 'multi') && !prompt) {
    throw new Error(`${taskType} 任务的 prompt 不得为空`);
  }

  const payload = {
    model,
    seconds: normalizeSeconds(request.duration),
    metadata: {
      resolution,
      ratio: normalizeRatio(request.ratio),
      generate_audio: request.generate_audio !== false,
      return_last_frame: request.return_last_frame === true,
    },
  };
  if (prompt) payload.prompt = prompt;
  if (Number.isFinite(Number(request.seed)) && Number(request.seed) !== -1) {
    payload.metadata.seed = Number(request.seed);
  }

  if (taskType === 'i2v') {
    const frameSources = [request.firstFrame, request.lastFrame].filter((item) => !!String(item || '').trim());
    payload.images = [];
    for (const source of frameSources) {
      payload.images.push(await uploadMedia(source, 'image', apiKey, options));
    }
  }

  if (taskType === 'multi') {
    payload.metadata.content = [];
    for (const source of normalizeList(request.refImages)) {
      const url = await uploadMedia(source, 'image', apiKey, options);
      payload.metadata.content.push({ type: 'image_url', image_url: { url } });
    }
    for (const source of normalizeList(request.videos)) {
      const url = await uploadMedia(source, 'video', apiKey, options);
      payload.metadata.content.push({ type: 'video_url', video_url: { url } });
    }
    for (const source of normalizeList(request.audios)) {
      const url = await uploadMedia(source, 'audio', apiKey, options);
      payload.metadata.content.push({ type: 'audio_url', audio_url: { url } });
    }
  }

  return { payload, taskType, model };
}

function normalizeImagePrompt(value) {
  const prompt = String(value || '').trim();
  if (prompt.length < 5 || prompt.length > 2000) {
    throw new Error('seedance.nz Seedream 提示词长度必须为 5-2000 字符');
  }
  return prompt;
}

function normalizeImageMetadata(request = {}) {
  const outputFormat = String(request.output_format || request.outputFormat || 'png').trim().toLowerCase();
  if (!IMAGE_OUTPUT_FORMATS.has(outputFormat)) {
    throw new Error('seedance.nz Seedream 输出格式只支持 png 或 jpeg');
  }
  const metadata = { output_format: outputFormat };
  const resolution = String(request.resolution || '').trim().toLowerCase();
  if (resolution) {
    if (!IMAGE_RESOLUTIONS.has(resolution)) {
      throw new Error('seedance.nz Seedream 分辨率只支持 1k 或 2k');
    }
    metadata.resolution = resolution;
    return metadata;
  }

  const size = String(request.size || '').trim().replace(/\s+/g, '').replace(/[X×]/g, 'x');
  const sizeMatch = size.match(/^(\d+)x(\d+)$/);
  const width = Number(request.width ?? sizeMatch?.[1]);
  const height = Number(request.height ?? sizeMatch?.[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 240 || width > 8192 || height < 240 || height > 8192) {
    throw new Error('seedance.nz Seedream 自定义宽高必须为 240-8192 的整数');
  }
  metadata.width = width;
  metadata.height = height;
  return metadata;
}

async function buildImagePayload(request, apiKey, options = {}) {
  const refs = normalizeList(request.images || request.refImages);
  if (refs.length > 10) throw new Error('seedance.nz Seedream 最多支持 10 张参考图');
  const requestedFamily = String(
    request.modelFamily || request.model_family || request.model || 'domestic',
  ).trim().toLowerCase();
  const family = requestedFamily === 'overseas'
    || requestedFamily === 'dola'
    || requestedFamily.startsWith('dola-seedream-5.0-pro')
    ? 'overseas'
    : requestedFamily === 'domestic'
      || requestedFamily === 'seedream'
      || requestedFamily.startsWith('seedream-v5-pro')
      ? 'domestic'
      : '';
  if (!family) throw new Error(`未知 Seedream 模型系列：${requestedFamily || '(空)'}`);
  const modelPair = IMAGE_MODEL_PAIRS[family];
  const model = refs.length ? modelPair[1] : modelPair[0];
  if (!IMAGE_MODELS.has(model)) throw new Error(`未知 Seedream 模型：${model}`);
  const payload = {
    model,
    prompt: normalizeImagePrompt(request.prompt),
    metadata: normalizeImageMetadata(request),
  };
  if (refs.length) {
    payload.images = [];
    for (const source of refs) {
      payload.images.push(await uploadMedia(source, 'image', apiKey, {
        ...options,
        maxBytes: IMAGE_REFERENCE_MAX_BYTES,
        allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
      }));
    }
  }
  return { payload, model, taskType: refs.length ? 'i2i' : 't2i' };
}

async function buildWanPayload(request, apiKey, options = {}) {
  const model = String(request.model || WAN27_SPICY_MODEL).trim();
  if (model !== WAN27_SPICY_MODEL) throw new Error(`未知 Wan 模型：${model || '(空)'}`);

  const sources = normalizeList(request.images || request.refImages);
  if (sources.length === 0) throw new Error('Wan 2.7 Spicy 必须提供 1 张首帧图');
  const prompt = String(request.prompt || '').trim();
  if (prompt.length > 20480) throw new Error('Wan 2.7 Spicy 提示词不能超过 20480 字符');
  const negativePrompt = String(request.negative_prompt || request.negativePrompt || '').trim();
  if (negativePrompt.length > 20480) throw new Error('Wan 2.7 Spicy 反向提示词不能超过 20480 字符');
  const resolution = String(request.resolution || '720p').trim().toLowerCase();
  if (!WAN27_SPICY_RESOLUTIONS.has(resolution)) {
    throw new Error('Wan 2.7 Spicy 分辨率只支持 720p 或 1080p');
  }
  const audioUrl = String(request.audio_url || request.audioUrl || '').trim();
  if (audioUrl && !/^https?:\/\//i.test(audioUrl)) {
    throw new Error('Wan 2.7 Spicy audio_url 必须是 http(s) 公网 URL');
  }

  const metadata = { resolution };
  if (negativePrompt) metadata.negative_prompt = negativePrompt;
  if (audioUrl) metadata.audio_url = audioUrl;
  if (request.prompt_extend === true || request.promptExtend === true) metadata.prompt_extend = true;
  const seed = request.seed === undefined || request.seed === null || request.seed === ''
    ? -1
    : Number(request.seed);
  if (!Number.isInteger(seed) || seed < -1 || seed > 2147483647) {
    throw new Error('Wan 2.7 Spicy seed 必须是 -1 到 2147483647 的整数');
  }
  if (seed >= 0) metadata.seed = seed;

  const imageUrl = await uploadMedia(sources[0], 'image', apiKey, {
    ...options,
    allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
  });
  const payload = {
    model,
    seconds: normalizeWanSeconds(request.duration ?? request.seconds),
    metadata,
    images: [imageUrl],
  };
  if (prompt) payload.prompt = prompt;
  return { payload, model, taskType: 'i2v' };
}

async function buildHappyHorsePayload(request, apiKey, options = {}) {
  const model = String(request.model || '').trim();
  if (!HAPPYHORSE_MODELS.has(model)) throw new Error(`未知 Happy Horse 模型：${model || '(空)'}`);
  const prompt = String(request.prompt || '').trim();
  if (prompt.length > 20480) throw new Error('Happy Horse 提示词不能超过 20480 字符');
  if (model.endsWith('-t2v') && !prompt) throw new Error('Happy Horse 文生视频必须填写提示词');

  const resolution = String(request.resolution || '720p').trim().toLowerCase();
  if (!HAPPYHORSE_RESOLUTIONS.has(resolution)) {
    throw new Error('Happy Horse 分辨率只支持 720p 或 1080p');
  }
  const ratio = normalizeRatio(request.ratio || 'adaptive');
  const sources = normalizeList(request.images || request.refImages);
  const taskType = model.endsWith('-t2v') ? 't2v' : model.endsWith('-i2v') ? 'i2v' : 'r2v';
  if (taskType !== 't2v' && sources.length === 0) {
    throw new Error(`Happy Horse ${taskType} 至少需要 1 张参考图`);
  }
  if (taskType === 'r2v' && sources.length > 9) throw new Error('Happy Horse r2v 最多支持 9 张参考图');

  const payload = {
    model,
    seconds: normalizeHappyHorseSeconds(request.duration ?? request.seconds),
    metadata: { resolution, ratio },
  };
  if (prompt) payload.prompt = prompt;
  if (taskType !== 't2v') {
    payload.images = [];
    const selected = taskType === 'i2v' ? sources.slice(0, 1) : sources.slice(0, 9);
    for (const source of selected) {
      payload.images.push(await uploadMedia(source, 'image', apiKey, {
        ...options,
        allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
      }));
    }
  }
  return { payload, model, taskType };
}

async function submitHappyHorseTask(request, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const built = await buildHappyHorsePayload(request, apiKey, options);
  const response = await fetchImpl(`${baseUrl}/v1/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(built.payload),
  });
  const data = await responseJson(response, 'seedance.nz Happy Horse 任务提交');
  if (!response.ok) throw createUpstreamError(data, response);
  const taskId = String(data?.id || data?.task_id || data?.data?.id || '').trim();
  if (!taskId) throw new Error('seedance.nz Happy Horse 未返回任务 ID');
  return { taskId, model: built.model, taskType: built.taskType, raw: data, ...providerTrace(response, data, { pollCount: 0 }) };
}

async function submitWanTask(request, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const built = await buildWanPayload(request, apiKey, options);
  const response = await fetchImpl(`${baseUrl}/v1/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(built.payload),
  });
  const data = await responseJson(response, 'seedance.nz Wan 2.7 Spicy 任务提交');
  if (!response.ok) throw createUpstreamError(data, response);
  const taskId = String(data?.id || data?.task_id || data?.data?.id || '').trim();
  if (!taskId) throw new Error('seedance.nz Wan 2.7 Spicy 未返回任务 ID');
  return { taskId, model: built.model, taskType: built.taskType, raw: data, ...providerTrace(response, data, { pollCount: 0 }) };
}

async function buildAudioPayload(request, apiKey, options = {}) {
  const model = String(request.model || SEED_AUDIO_MODEL).trim();
  if (model !== SEED_AUDIO_MODEL) throw new Error(`未知 Seed Audio 模型：${model}`);
  const prompt = String(request.prompt || '').trim();
  if (prompt.length < 5 || prompt.length > 2048) {
    throw new Error('Seed Audio 提示词长度必须为 5-2048 字符');
  }

  const speaker = String(request.speaker || '').trim();
  const imageSources = normalizeList(request.images || request.refImages).slice(0, 1);
  const audioSources = normalizeList(request.audioUrls || request.audios || request.referenceAudios);
  if (audioSources.length > 3) throw new Error('Seed Audio 最多支持 3 段参考音频');
  const referenceModes = [!!speaker, imageSources.length > 0, audioSources.length > 0].filter(Boolean).length;
  if (referenceModes > 1) throw new Error('Seed Audio 的音色 ID、参考图和参考音频只能选择一种');

  const outputFormat = String(request.outputFormat || request.output_format || 'wav').trim().toLowerCase();
  if (!SEED_AUDIO_FORMATS.has(outputFormat)) throw new Error('Seed Audio 输出格式只支持 wav/mp3/pcm/ogg_opus');
  const sampleRate = String(request.sampleRate || request.sample_rate || '24000').trim();
  if (!SEED_AUDIO_SAMPLE_RATES.has(sampleRate)) throw new Error('Seed Audio 不支持该采样率');
  const metadata = {
    format: outputFormat,
    sample_rate: sampleRate,
    speech_rate: normalizeBoundedInteger(request.speechRate ?? request.speech_rate, 'Seed Audio 语速', -50, 100),
    loudness_rate: normalizeBoundedInteger(request.loudnessRate ?? request.loudness_rate, 'Seed Audio 音量', -50, 100),
    pitch_rate: normalizeBoundedInteger(request.pitchRate ?? request.pitch_rate, 'Seed Audio 音高', -12, 12),
  };
  if (speaker) metadata.speaker = speaker;

  const payload = { model, prompt, metadata };
  if (imageSources.length) {
    payload.images = [await uploadMedia(imageSources[0], 'image', apiKey, {
      ...options,
      allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
    })];
  }
  if (audioSources.length) {
    metadata.audio_urls = [];
    for (const source of audioSources) {
      metadata.audio_urls.push(await uploadMedia(source, 'audio', apiKey, options));
    }
  }
  return { payload, model };
}

async function submitAudioTask(request, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const built = await buildAudioPayload(request, apiKey, options);
  const response = await fetchImpl(`${baseUrl}/v1/audio/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(built.payload),
  });
  const data = await responseJson(response, 'seedance.nz Seed Audio 任务提交');
  if (!response.ok) throw createUpstreamError(data, response);
  const taskId = String(data?.task_id || data?.id || data?.data?.task_id || '').trim();
  if (!taskId) throw new Error('seedance.nz Seed Audio 未返回任务 ID');
  return { taskId, model: built.model, raw: data, ...providerTrace(response, data, { pollCount: 0 }) };
}

async function queryAudioTask(taskId, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('缺少贞贞的平价AI工坊（国内） API Key');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const response = await fetchImpl(`${baseUrl}/v1/audio/generations/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await responseJson(response, 'seedance.nz Seed Audio 任务查询');
  if (!response.ok) throw createUpstreamError(data, response);
  const record = data?.data && typeof data.data === 'object' ? data.data : data;
  const status = normalizeImageTaskStatus(record?.status || data?.status);
  const nested = record?.data && typeof record.data === 'object' ? record.data : {};
  const content = nested?.content && typeof nested.content === 'object' ? nested.content : {};
  const audioUrl = status === 'succeeded'
    ? String(record?.result_url || record?.resultUrl || content?.audio_url || content?.url || '').trim()
    : '';
  return {
    status,
    progress: record?.progress ?? data?.progress ?? '',
    audioUrl: audioUrl || null,
    failReason: status === 'failed'
      ? String(record?.fail_reason || record?.error?.message || record?.error || data?.message || 'Seed Audio 任务失败')
      : null,
    raw: data,
    ...providerTrace(response, data),
  };
}

async function submitImageTask(request, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const built = await buildImagePayload(request, apiKey, options);
  const response = await fetchImpl(`${baseUrl}/v1/image/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(built.payload),
  });
  const data = await responseJson(response, 'seedance.nz Seedream 任务提交');
  if (!response.ok) throw createUpstreamError(data, response);
  const taskId = String(data?.task_id || data?.id || data?.data?.task_id || data?.data?.id || '').trim();
  if (!taskId) throw new Error('seedance.nz Seedream 未返回任务 ID');
  return { taskId, model: built.model, taskType: built.taskType, raw: data, ...providerTrace(response, data, { pollCount: 0 }) };
}

function normalizeImageTaskStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  if (status === 'SUCCESS' || status === 'COMPLETED' || status === 'SUCCEEDED') return 'succeeded';
  if (status === 'FAILURE' || status === 'FAILED' || status === 'CANCELLED' || status === 'CANCELED') return 'failed';
  if (status === 'IN_PROGRESS' || status === 'PROCESSING' || status === 'RUNNING') return 'running';
  return 'pending';
}

async function queryImageTask(taskId, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('缺少贞贞的平价AI工坊（国内） API Key');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const response = await fetchImpl(`${baseUrl}/v1/image/generations/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await responseJson(response, 'seedance.nz Seedream 任务查询');
  if (!response.ok) throw createUpstreamError(data, response);
  const record = data?.data && typeof data.data === 'object' ? data.data : data;
  const status = normalizeImageTaskStatus(record?.status || data?.status);
  const nested = record?.data && typeof record.data === 'object' ? record.data : {};
  const imageUrl = status === 'succeeded'
    ? String(record?.result_url || record?.resultUrl || nested?.content?.image_url || nested?.content?.imageUrl || '').trim()
    : '';
  return {
    status,
    progress: record?.progress ?? data?.progress ?? '',
    imageUrl: imageUrl || null,
    failReason: status === 'failed'
      ? String(record?.fail_reason || record?.error?.message || record?.error || data?.message || 'Seedream 任务失败')
      : null,
    raw: data,
    ...providerTrace(response, data),
  };
}

async function submitTask(request, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const built = await buildPayload(request, apiKey, options);
  const response = await fetchImpl(`${baseUrl}/v1/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(built.payload),
  });
  const data = await responseJson(response, 'seedance.nz 任务提交');
  if (!response.ok) throw createUpstreamError(data, response);
  const taskId = String(data?.id || data?.task_id || data?.data?.id || '').trim();
  if (!taskId) throw new Error('seedance.nz 未返回任务 ID');
  return { taskId, taskType: built.taskType, model: built.model, raw: data, ...providerTrace(response, data, { pollCount: 0 }) };
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'completed' || status === 'success' || status === 'succeeded') return 'succeeded';
  if (status === 'failed' || status === 'failure' || status === 'cancelled' || status === 'canceled') return 'failed';
  if (status === 'in_progress' || status === 'processing' || status === 'running') return 'running';
  return 'pending';
}

async function queryTask(taskId, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('缺少贞贞的平价AI工坊（国内） API Key');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const response = await fetchImpl(`${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await responseJson(response, 'seedance.nz 任务查询');
  if (!response.ok) throw createUpstreamError(data, response);
  const status = normalizeStatus(data?.status || data?.data?.status);
  const metadata = data?.metadata || data?.data?.metadata || {};
  return {
    status,
    progress: data?.progress ?? data?.data?.progress ?? '',
    videoUrl: status === 'succeeded'
      ? String(metadata?.url || data?.url || data?.data?.url || '').trim() || null
      : null,
    failReason: status === 'failed'
      ? String(data?.error?.message || data?.error || data?.fail_reason || data?.message || '任务失败')
      : null,
    raw: data,
    ...providerTrace(response, data),
  };
}

function resetCachesForTests() {
  uploadCache.clear();
  uploadQueues.clear();
}

module.exports = {
  BASE_URL,
  HAPPYHORSE_MODELS,
  HAPPYHORSE_RESOLUTIONS,
  IMAGE_MODEL_PAIRS,
  IMAGE_MODELS,
  IMAGE_RESOLUTIONS,
  PROVIDER_ID,
  RATIOS,
  RESOLUTIONS,
  SEED_AUDIO_FORMATS,
  SEED_AUDIO_MODEL,
  SEED_AUDIO_SAMPLE_RATES,
  WAN27_SPICY_MODEL,
  WAN27_SPICY_RESOLUTIONS,
  buildAudioPayload,
  buildHappyHorsePayload,
  buildWanPayload,
  buildPayload,
  buildImagePayload,
  deriveTaskType,
  fetchRemote: secureFetch,
  normalizePromptMentions,
  normalizeResolution,
  queryImageTask,
  queryAudioTask,
  queryTask,
  resetCachesForTests,
  resolveModel,
  submitAudioTask,
  submitHappyHorseTask,
  submitImageTask,
  submitTask,
  submitWanTask,
  uploadMedia,
};
