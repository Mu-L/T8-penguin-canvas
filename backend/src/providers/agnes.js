const { resolveMediaRef } = require('./mediaResolver');
const openaiCompatible = require('./openaiCompatible');
const { mergeProviderTrace, providerTrace } = require('./providerTrace');

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_CHAT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const DEFAULT_IMAGE_MODEL = 'agnes-image-2.1-flash';
const DEFAULT_VIDEO_MODEL = 'agnes-video-v2.0';
const DEFAULT_CHAT_MODEL = 'agnes-2.0-flash';
const VIDEO_SUCCESS_STATUSES = new Set(['SUCCESS', 'SUCCEED', 'SUCCEEDED', 'COMPLETED', 'COMPLETE', 'DONE', 'FINISHED', 'OK', 'READY']);
const VIDEO_FAILURE_STATUSES = new Set(['FAILURE', 'FAILED', 'FAIL', 'ERROR', 'ERRORED', 'CANCELED', 'CANCELLED', 'TIMEOUT', 'TIMEDOUT', 'REJECTED', 'EXPIRED']);
const VIDEO_TRANSIENT_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function cleanBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function agnesApiBaseUrl(provider) {
  const base = cleanBaseUrl(provider?.baseUrl);
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

function agnesRootUrl(provider) {
  const base = cleanBaseUrl(provider?.baseUrl);
  return base.endsWith('/v1') ? base.slice(0, -3) : base;
}

function hasApiKey(provider) {
  return typeof provider?.apiKey === 'string' && provider.apiKey.trim().length > 0;
}

function validateProvider(provider, { apiKeyRequired = true } = {}) {
  const baseUrl = agnesApiBaseUrl(provider);
  if (!baseUrl) return { ok: false, code: 'missing_base_url', error: '请先填写 Agnes AI Base URL。' };
  if (apiKeyRequired && !hasApiKey(provider)) {
    return { ok: false, code: 'missing_api_key', error: '请先填写 Agnes AI API Key。' };
  }
  return { ok: true, baseUrl };
}

function bearerHeaders(provider) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${provider.apiKey}`,
    'Content-Type': 'application/json',
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl || fetch;
  const { timeoutMs, fetchImpl: _fetchImpl, ...fetchOptions } = options;
  try {
    return await fetchImpl(url, { ...fetchOptions, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function responseJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function trimBodyForError(text) {
  return errorText(text).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function errorText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) return value.message || String(value);
  if (typeof value !== 'object') return String(value);
  const parts = [];
  for (const key of ['message', 'msg', 'detail', 'code', 'type', 'status']) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) parts.push(item.trim());
    else if (typeof item === 'number' || typeof item === 'boolean') parts.push(String(item));
  }
  if (parts.length) return parts.join(' · ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function selectedModel(requested, providerModels, fallback) {
  const fromList = Array.isArray(providerModels) ? providerModels.find((item) => String(item || '').trim()) : '';
  const model = String(requested || fromList || fallback || '').trim();
  if (!model) throw new Error('模型名称不能为空。');
  if (model.length > 240 || /[\x00-\x1f\x7f]/.test(model)) throw new Error('模型名称不合法。');
  return model;
}

function normalizeBase64Image(value, mime = 'image/png') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^data:image\//i.test(text)) return text;
  return `data:${mime || 'image/png'};base64,${text}`;
}

function collectImageUrls(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^(https?:\/\/|data:image\/)/i.test(text)) out.push(text);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageUrls(item, out);
    return out;
  }
  if (typeof value !== 'object') return out;
  const mime = value.mime_type || value.mime || value.content_type || 'image/png';
  const direct = value.url || value.image_url || value.imageUrl || value.uri || value.value;
  if (direct) collectImageUrls(direct, out);
  if (value.b64_json || value.base64) out.push(normalizeBase64Image(value.b64_json || value.base64, mime));
  for (const key of ['data', 'images', 'image_urls', 'imageUrls', 'output_images', 'outputs', 'results']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) collectImageUrls(value[key], out);
  }
  return out;
}

function collectReferenceImageInputs(...values) {
  const out = [];
  const push = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    if (typeof value === 'string') {
      const text = value.trim();
      if (text) out.push(text);
      return;
    }
    if (typeof value !== 'object') return;
    const direct = (
      value.url || value.image_url || value.imageUrl ||
      value.uri || value.value || value.src || value.path ||
      value.b64_json || value.base64
    );
    if (direct) push(direct);
  };
  for (const value of values) push(value);
  return out;
}

function collectVideoUrls(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^(https?:\/\/|data:video\/|\/files\/output\/)/i.test(text)) out.push(text);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectVideoUrls(item, out);
    return out;
  }
  if (typeof value !== 'object') return out;
  const direct = (
    value.video_url || value.videoUrl || value.mp4_url || value.mp4Url ||
    value.output || value.output_url || value.outputUrl ||
    value.download_url || value.downloadUrl || value.video || value.url ||
    value.remixed_from_video_id || value.uri || value.value || value.src || value.path
  );
  if (direct) collectVideoUrls(direct, out);
  for (const key of ['data', 'videos', 'video_urls', 'videoUrls', 'output_videos', 'outputs', 'results', 'files', 'result', 'content']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) collectVideoUrls(value[key], out);
  }
  return out;
}

function extractTaskId(raw) {
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  return String(data?.video_id || data?.task_id || data?.taskId || data?.id || raw?.video_id || raw?.task_id || raw?.id || '').trim();
}

function videoStatus(raw) {
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  return String(data?.status || data?.task_status || raw?.status || raw?.task_status || '').toUpperCase();
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function agnesVideoDimensions(aspectRatio = '', resolution = '') {
  const ratio = String(aspectRatio || '16:9').trim();
  const [baseW, baseH] = ({
    '16:9': [1152, 648],
    '9:16': [648, 1152],
    '4:3': [1024, 768],
    '3:4': [768, 1024],
    '1:1': [768, 768],
    '21:9': [1280, 544],
    '9:21': [544, 1280],
  })[ratio] || [1152, 648];
  const scale = ({
    '480p': 0.625,
    '720p': 1,
    '780p': 1,
    '1080p': 1.5,
  })[String(resolution || '720p').trim().toLowerCase()] || 1;
  const width = Math.max(64, Math.round((baseW * scale) / 8) * 8);
  const height = Math.max(64, Math.round((baseH * scale) / 8) * 8);
  return { width, height };
}

function agnesVideoFrameCount(duration, fps = 24) {
  const seconds = clampNumber(duration, 5, 1, 18);
  const frameRate = clampNumber(fps, 24, 1, 60);
  const target = Math.min(441, Math.max(9, seconds * frameRate));
  const n = Math.max(1, Math.round((target - 1) / 8));
  return {
    numFrames: Math.min(441, Math.max(9, 8 * n + 1)),
    frameRate,
  };
}

function imageResponseFormat(provider, input = {}) {
  const params = input.providerParams && typeof input.providerParams === 'object' ? input.providerParams : {};
  return String(
    input.response_format ||
    input.responseFormat ||
    params.response_format ||
    params.responseFormat ||
    provider?.defaults?.responseFormat ||
    provider?.defaults?.response_format ||
    'url',
  ).trim() || 'url';
}

async function resolveImageRefs(refs, options = {}) {
  const out = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const value = typeof ref === 'string' ? ref : ref?.url || ref?.imageUrl || ref?.value;
    if (!value) continue;
    const resolved = await resolveMediaRef(normalizeLocalT8MediaRef(value, options.baseUrl), {
      target: options.target || 'data-url',
      baseUrl: options.baseUrl,
    });
    if (options.target === 'base64' && resolved.base64) out.push(resolved.base64);
    else out.push(resolved.dataUrl || resolved.url || resolved.path || value);
  }
  return out;
}

function normalizeLocalT8MediaRef(value, baseUrl) {
  const text = String(value || '').trim();
  if (!/^https?:\/\//i.test(text)) return text;
  try {
    const parsed = new URL(text);
    const path = parsed.pathname || '';
    if (!/^\/(?:files|api\/resources|api\/files|input|output)\//.test(path)) return text;
    const base = baseUrl ? new URL(baseUrl) : null;
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const baseHost = base?.hostname?.replace(/^\[|\]$/g, '').toLowerCase();
    const isSameBackend = base && parsed.protocol === base.protocol && parsed.host === base.host;
    const isLocalBackend = ['127.0.0.1', 'localhost', '::1'].includes(host)
      || (baseHost && host === baseHost && parsed.port === base.port);
    return isSameBackend || isLocalBackend ? `${path}${parsed.search || ''}` : text;
  } catch {
    return text;
  }
}

async function generateChat(provider, input = {}, options = {}) {
  return openaiCompatible.generateChat({
    ...provider,
    baseUrl: agnesApiBaseUrl(provider),
    chatModels: provider.chatModels || [DEFAULT_CHAT_MODEL],
    defaults: {
      ...(provider.defaults || {}),
      chatModel: provider.defaults?.chatModel || DEFAULT_CHAT_MODEL,
    },
  }, input, {
    ...options,
    timeoutMs: Number(options.timeoutMs) || DEFAULT_CHAT_TIMEOUT_MS,
  });
}

async function generateImage(provider, input = {}, options = {}) {
  const validation = validateProvider(provider, { apiKeyRequired: true });
  if (!validation.ok) return validation;
  const prompt = String(input.prompt || '').trim();
  if (!prompt) {
    return { ok: false, code: 'missing_prompt', providerId: provider.id, protocol: provider.protocol, error: '请输入 Agnes 图像提示词。' };
  }

  let model;
  try {
    model = selectedModel(input.model || input.providerModel, provider.imageModels, provider.defaults?.imageModel || DEFAULT_IMAGE_MODEL);
  } catch (e) {
    return { ok: false, code: 'invalid_model', providerId: provider.id, protocol: provider.protocol, error: e.message };
  }

  const params = input.providerParams && typeof input.providerParams === 'object' ? input.providerParams : {};
  const responseFormat = imageResponseFormat(provider, input);
  const body = {
    model,
    prompt,
    size: String(input.size || params.size || '1024x1024'),
    extra_body: {
      response_format: responseFormat,
    },
  };

  try {
    const refsInput = collectReferenceImageInputs(
      input.images,
      input.image,
      input.imageUrl,
      input.image_url,
      input.imageUrls,
      input.image_urls,
      input.referenceImages,
      input.reference_images,
    );
    const refs = await resolveImageRefs(refsInput, {
      baseUrl: options.baseUrl,
      target: 'data-url',
    });
    if (refs.length) body.extra_body.image = refs;
    if (!refs.length && (input.return_base64 === true || params.return_base64 === true || responseFormat === 'b64_json')) {
      body.return_base64 = true;
    }
  } catch (e) {
    return { ok: false, code: 'invalid_reference', providerId: provider.id, protocol: provider.protocol, error: e?.message || '参考图解析失败。' };
  }

  try {
    const res = await fetchWithTimeout(`${agnesApiBaseUrl(provider)}/images/generations`, {
      method: 'POST',
      headers: bearerHeaders(provider),
      body: JSON.stringify(body),
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    const raw = await responseJson(res);
    const trace = providerTrace(res, raw, { pollCount: 0 });
    if (!res.ok) {
      return {
        ok: false,
        code: 'http_error',
        providerId: provider.id,
        protocol: provider.protocol,
        model,
        error: `Agnes 图像调用失败：HTTP ${res.status}${raw?.message ? ` ${trimBodyForError(raw.message)}` : ''}`,
        raw,
        ...trace,
      };
    }
    const imageUrls = [...new Set(collectImageUrls(raw))];
    if (!imageUrls.length) {
      return { ok: false, code: 'empty_image', providerId: provider.id, protocol: provider.protocol, model, error: 'Agnes 图像接口没有返回图片。', raw, ...trace };
    }
    return { ok: true, kind: 'image', code: 'completed', providerId: provider.id, protocol: provider.protocol, model, imageUrls, raw, ...trace };
  } catch (e) {
    return {
      ok: false,
      code: e?.name === 'AbortError' ? 'timeout' : 'network_error',
      providerId: provider.id,
      protocol: provider.protocol,
      error: e?.name === 'AbortError' ? 'Agnes 图像调用超时。' : (e?.message || 'Agnes 图像调用失败。'),
    };
  }
}

async function waitForAgnesVideoTask(provider, videoId, model, options = {}) {
  const maxPolls = clampNumber(options.maxPolls, 120, 1, 240);
  const sleepImpl = options.sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastRaw = {};
  let trace = {};
  for (let i = 0; i < maxPolls; i += 1) {
    if (i > 0 || !options.skipInitialSleep) await sleepImpl(Math.min(5000 + i * 1200, 12000));
    const query = new URL(`${agnesRootUrl(provider)}/agnesapi`);
    query.searchParams.set('video_id', videoId);
    query.searchParams.set('model_name', model);
    const res = await fetchWithTimeout(query.toString(), {
      method: 'GET',
      headers: bearerHeaders(provider),
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    const raw = await responseJson(res);
    lastRaw = raw;
    trace = mergeProviderTrace(trace, providerTrace(res, raw, { pollCount: i + 1 }));
    if (!res.ok) {
      if (VIDEO_TRANSIENT_HTTP_STATUSES.has(Number(res.status))) continue;
      const error = new Error(`Agnes 视频任务查询失败：HTTP ${res.status}${raw?.message ? ` ${trimBodyForError(raw.message)}` : ''}`);
      Object.assign(error, trace);
      throw error;
    }
    const urls = [...new Set(collectVideoUrls(raw))];
    if (urls.length) return { raw, videoUrls: urls, ...trace };
    const status = videoStatus(raw);
    if (VIDEO_FAILURE_STATUSES.has(status)) {
      const error = new Error(`Agnes 视频任务失败：${trimBodyForError(raw?.message || raw?.error || status)}`);
      Object.assign(error, trace);
      throw error;
    }
    if (VIDEO_SUCCESS_STATUSES.has(status) && !urls.length) {
      return { raw, videoUrls: [], ...trace };
    }
  }
  const error = new Error(`Agnes 视频任务超时：${trimBodyForError(JSON.stringify(lastRaw)) || videoId}`);
  Object.assign(error, trace, { pollCount: maxPolls });
  throw error;
}

async function generateVideo(provider, input = {}, options = {}) {
  const validation = validateProvider(provider, { apiKeyRequired: true });
  if (!validation.ok) return validation;
  const prompt = String(input.prompt || '').trim();
  if (!prompt) {
    return { ok: false, code: 'missing_prompt', providerId: provider.id, protocol: provider.protocol, error: '请输入 Agnes 视频提示词。' };
  }

  let model;
  let trace = {};
  try {
    model = selectedModel(input.model || input.providerModel, provider.videoModels, provider.defaults?.videoModel || DEFAULT_VIDEO_MODEL);
  } catch (e) {
    return { ok: false, code: 'invalid_model', providerId: provider.id, protocol: provider.protocol, error: e.message };
  }

  const params = input.providerParams && typeof input.providerParams === 'object' ? input.providerParams : {};
  const { width, height } = agnesVideoDimensions(input.aspect_ratio || input.ratio || params.aspect_ratio || params.ratio, input.resolution || params.resolution);
  const { numFrames, frameRate } = agnesVideoFrameCount(input.duration ?? params.duration, params.frameRate ?? params.frame_rate ?? 24);
  const customNumFrames = params.numFrames ?? params.num_frames;
  const body = {
    model,
    prompt,
    width: clampNumber(params.width, width, 64, 4096),
    height: clampNumber(params.height, height, 64, 4096),
    num_frames: customNumFrames === '' || customNumFrames == null ? numFrames : clampNumber(customNumFrames, numFrames, 9, 441),
    frame_rate: frameRate,
  };
  if (input.seed != null && Number(input.seed) >= 0) body.seed = Number(input.seed);

  try {
    const refs = await resolveImageRefs(input.images || input.referenceImages || input.reference_images, {
      baseUrl: options.baseUrl,
      target: params.referenceTarget || params.videoReferenceTarget || provider.defaults?.videoReferenceTarget || 'base64',
    });
    if (refs.length === 1) body.image = refs[0];
    if (refs.length > 1) body.extra_body = { image: refs.slice(0, 4) };
  } catch (e) {
    return { ok: false, code: 'invalid_reference', providerId: provider.id, protocol: provider.protocol, error: e?.message || '参考图解析失败。' };
  }

  try {
    const submitUrl = `${agnesApiBaseUrl(provider)}/videos`;
    const res = await fetchWithTimeout(submitUrl, {
      method: 'POST',
      headers: bearerHeaders(provider),
      body: JSON.stringify(body),
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    const raw = await responseJson(res);
    trace = providerTrace(res, raw, { pollCount: 0 });
    if (!res.ok) {
      return {
        ok: false,
        code: 'http_error',
        providerId: provider.id,
        protocol: provider.protocol,
        model,
        error: `Agnes 视频调用失败：HTTP ${res.status}${raw?.message ? ` ${trimBodyForError(raw.message)}` : ''}`,
        raw,
        ...trace,
      };
    }
    let videoUrls = [...new Set(collectVideoUrls(raw))];
    const taskId = extractTaskId(raw);
    let finalRaw = raw;
    if (!videoUrls.length && taskId) {
      const polled = await waitForAgnesVideoTask(provider, taskId, model, options);
      trace = mergeProviderTrace(trace, polled);
      finalRaw = polled.raw;
      videoUrls = polled.videoUrls;
    }
    if (!videoUrls.length) {
      return { ok: false, code: 'empty_video', providerId: provider.id, protocol: provider.protocol, model, error: 'Agnes 视频接口任务完成但没有返回视频。', taskId, raw: finalRaw, ...trace };
    }
    return { ok: true, kind: 'video', code: 'completed', providerId: provider.id, protocol: provider.protocol, model, taskId, videoUrls, raw: finalRaw, ...trace };
  } catch (e) {
    return {
      ok: false,
      code: e?.name === 'AbortError' ? 'timeout' : 'network_error',
      providerId: provider.id,
      protocol: provider.protocol,
      model,
      error: e?.name === 'AbortError' ? 'Agnes 视频调用超时。' : (e?.message || 'Agnes 视频调用失败。'),
      ...mergeProviderTrace(trace, e),
    };
  }
}

async function testProvider(provider, options = {}) {
  return openaiCompatible.testProvider({
    ...provider,
    baseUrl: agnesApiBaseUrl(provider),
    chatModels: provider.chatModels || [DEFAULT_CHAT_MODEL],
  }, options);
}

module.exports = {
  agnesApiBaseUrl,
  agnesRootUrl,
  agnesVideoDimensions,
  agnesVideoFrameCount,
  generateChat,
  generateImage,
  generateVideo,
  testProvider,
};
