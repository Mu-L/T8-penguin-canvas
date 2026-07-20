const openaiCompatible = require('./openaiCompatible');
const { resolveMediaRef } = require('./mediaResolver');
const { mergeProviderTrace, providerTrace } = require('./providerTrace');

const DEFAULT_MODEL = 'Tongyi-MAI/Z-Image-Turbo';
const DEFAULT_CHAT_MODEL = 'Qwen/Qwen3-235B-A22B';
const DEFAULT_CHAT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_IMAGE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const MAX_LORAS_PER_REQUEST = 5;

function generationTimeoutMs(value, fallback = DEFAULT_IMAGE_TIMEOUT_MS) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(DEFAULT_IMAGE_TIMEOUT_MS, Math.round(n));
}

function stripBearer(value) {
  return String(value || '').trim().replace(/^Bearer\s+/i, '');
}

function modelscopeApiRoot(value) {
  const base = String(value || 'https://api-inference.modelscope.cn/v1').trim().replace(/\/+$/, '');
  if (!base) return 'https://api-inference.modelscope.cn/v1';
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

function chatProvider(provider) {
  return {
    ...provider,
    protocol: 'modelscope',
    baseUrl: modelscopeApiRoot(provider?.baseUrl),
    apiKey: stripBearer(provider?.apiKey),
    defaults: {
      chatModel: DEFAULT_CHAT_MODEL,
      ...(provider?.defaults || {}),
    },
  };
}

function parseSize(size) {
  const text = String(size || '1024x1024').trim().toLowerCase().replace('*', 'x');
  const match = text.match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match) return { width: undefined, height: undefined, size: text };
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    size: `${Number(match[1])}x${Number(match[2])}`,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTaskId(raw) {
  return raw?.task_id || raw?.taskId || raw?.id || raw?.data?.task_id || raw?.data?.taskId || raw?.data?.id || '';
}

function taskStatus(raw) {
  return String(raw?.task_status || raw?.taskStatus || raw?.status || raw?.data?.task_status || raw?.data?.status || '').trim().toUpperCase();
}

function taskFailureDetail(raw) {
  return raw?.error_info || raw?.error || raw?.message || raw?.detail || raw?.data?.error_info || raw?.data?.message || JSON.stringify(raw);
}

function cleanLoraId(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 180 || /[\x00-\x1f\x7f]/.test(text)) return '';
  return text;
}

function normalizeLoraStrength(value, fallback = 0.8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizeLoraItems(value) {
  const out = [];
  const seen = new Set();
  const add = (rawId, rawStrength) => {
    if (out.length >= 24) return;
    const id = cleanLoraId(rawId);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, strength: normalizeLoraStrength(rawStrength, 0.8) });
  };
  if (!value) return out;
  if (typeof value === 'string') {
    add(value, 1);
    return out;
  }
  if (Array.isArray(value)) {
    for (const raw of value) {
      if (out.length >= 24) break;
      if (typeof raw === 'string') {
        add(raw, 1);
        continue;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      if (raw.enabled === false) continue;
      add(
        raw.id || raw.loraId,
        raw.strength ?? raw.loraStrength ?? raw.default_strength ?? raw.defaultStrength ?? raw.weight ?? raw.scale,
      );
    }
    return out;
  }
  if (typeof value !== 'object') return out;
  for (const [rawId, rawStrength] of Object.entries(value)) {
    if (out.length >= 24) break;
    if (rawStrength && typeof rawStrength === 'object' && !Array.isArray(rawStrength)) {
      add(rawId, rawStrength.strength ?? rawStrength.weight ?? rawStrength.scale ?? rawStrength.loraStrength);
    } else {
      add(rawId, rawStrength);
    }
  }
  return out;
}

function normalizeLorasPayload(value) {
  const weighted = normalizeLoraItems(value).filter((item) => item.strength > 0).slice(0, MAX_LORAS_PER_REQUEST);
  if (!weighted.length) return null;
  if (weighted.length === 1) return weighted[0].id;

  const total = weighted.reduce((sum, item) => sum + item.strength, 0);
  if (!(total > 0)) return null;

  const out = {};
  let used = 0;
  weighted.forEach((item, index) => {
    const weight = index === weighted.length - 1
      ? Math.max(0, Number((1 - used).toFixed(4)))
      : Number((item.strength / total).toFixed(4));
    out[item.id] = weight;
    used += weight;
  });
  return out;
}

function normalizeInputLoras(input = {}) {
  const params = input.providerParams && typeof input.providerParams === 'object' ? input.providerParams : {};
  const direct = normalizeLorasPayload(input.loras || params.loras || params.modelscopeLoras);
  if (direct) return direct;
  if (params.modelscopeLoraEnabled === true) {
    const id = cleanLoraId(params.modelscopeLoraId);
    if (id) return normalizeLorasPayload([{ id, strength: params.modelscopeLoraStrength }]);
  }
  return null;
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

async function testProvider(provider, options = {}) {
  const result = await openaiCompatible.testProvider(chatProvider(provider), options);
  return {
    ...result,
    providerId: provider.id,
    protocol: 'modelscope',
  };
}

async function generateChat(provider, input = {}, options = {}) {
  const result = await openaiCompatible.generateChat(
    chatProvider(provider),
    input,
    { ...options, timeoutMs: Number(options.timeoutMs) || DEFAULT_CHAT_TIMEOUT_MS },
  );
  return {
    ...result,
    providerId: provider.id,
    protocol: 'modelscope',
  };
}

async function resolveReferenceImages(refs, options = {}) {
  const out = [];
  for (const ref of Array.isArray(refs) ? refs.slice(0, 4) : []) {
    const value = typeof ref === 'string' ? ref : ref?.url || ref?.imageUrl || ref?.value;
    if (!value) continue;
    const resolved = await resolveMediaRef(value, {
      target: 'data-url',
      baseUrl: options.baseUrl,
    });
    out.push(resolved.dataUrl || resolved.url || value);
  }
  return out;
}

async function generateImage(provider, input = {}, options = {}) {
  const cleanProvider = {
    ...provider,
    baseUrl: modelscopeApiRoot(provider?.baseUrl),
    apiKey: stripBearer(provider?.apiKey),
  };
  const validation = openaiCompatible.validateProvider(cleanProvider, { apiKeyRequired: true });
  if (!validation.ok) return { ...validation, providerId: provider?.id, protocol: 'modelscope' };

  const prompt = String(input.prompt || '').trim();
  if (!prompt) {
    return { ok: false, code: 'missing_prompt', providerId: provider.id, protocol: 'modelscope', error: '请输入图像提示词。' };
  }

  const model = String(input.model || input.providerModel || provider.imageModels?.[0] || provider.defaults?.imageModel || DEFAULT_MODEL).trim();
  const { width, height, size } = parseSize(input.size || provider.defaults?.size || '1024x1024');
  const payload = {
    model,
    prompt,
  };
  if (width && height) {
    payload.width = width;
    payload.height = height;
    payload.size = size;
  }

  try {
    const refs = await resolveReferenceImages(input.images || input.referenceImages || input.reference_images, {
      baseUrl: options.baseUrl,
    });
    if (refs.length) payload.image_url = refs;
  } catch (e) {
    return { ok: false, code: 'invalid_reference', providerId: provider.id, protocol: 'modelscope', error: e?.message || '参考图解析失败。' };
  }

  const loras = normalizeInputLoras(input);
  if (loras) payload.loras = loras;

  const headers = {
    Authorization: `Bearer ${cleanProvider.apiKey}`,
    'Content-Type': 'application/json',
    'X-ModelScope-Async-Mode': 'true',
  };
  const apiRoot = validation.baseUrl;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = generationTimeoutMs(options.timeoutMs);
  const pollIntervalMs = Math.max(1, Number(options.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let trace = {};
  let pollCount = 0;

  try {
    const submit = await openaiCompatible.fetchWithTimeout(`${apiRoot}/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      timeoutMs: options.submitTimeoutMs || timeoutMs,
      fetchImpl,
    });
    const raw = await responseJson(submit);
    trace = providerTrace(submit, raw, { pollCount });
    if (!submit.ok) {
      return {
        ok: false,
        code: 'http_error',
        providerId: provider.id,
        protocol: 'modelscope',
        model,
        error: `ModelScope 提交失败：HTTP ${submit.status}`,
        raw,
        ...trace,
      };
    }

    const taskId = extractTaskId(raw);
    if (!taskId) {
      const imageUrls = openaiCompatible.extractImageUrls(raw);
      if (imageUrls.length) {
        return { ok: true, kind: 'image', code: 'completed', providerId: provider.id, protocol: 'modelscope', model, imageUrls, raw, ...trace };
      }
      return { ok: false, code: 'missing_task_id', providerId: provider.id, protocol: 'modelscope', model, error: 'ModelScope 未返回 task_id。', raw, ...trace };
    }

    let lastPayload = raw;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      pollCount += 1;
      const poll = await openaiCompatible.fetchWithTimeout(`${apiRoot}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: { ...headers, 'X-ModelScope-Task-Type': 'image_generation' },
        timeoutMs: options.pollTimeoutMs || timeoutMs,
        fetchImpl,
      });
      const data = await responseJson(poll);
      lastPayload = data;
      trace = mergeProviderTrace(trace, providerTrace(poll, data, { pollCount }));
      if (!poll.ok) {
        return {
          ok: false,
          code: 'http_error',
          providerId: provider.id,
          protocol: 'modelscope',
          model,
          taskId,
          error: `ModelScope 轮询失败：HTTP ${poll.status}`,
          raw: data,
          ...trace,
        };
      }
      const status = taskStatus(data);
      if (['SUCCEED', 'SUCCESS', 'COMPLETED', 'DONE'].includes(status)) {
        const imageUrls = openaiCompatible.extractImageUrls(data);
        if (!imageUrls.length) {
          return { ok: false, code: 'empty_image', providerId: provider.id, protocol: 'modelscope', model, taskId, error: 'ModelScope 成功但没有返回图片。', raw: data, ...trace };
        }
        return { ok: true, kind: 'image', code: 'completed', providerId: provider.id, protocol: 'modelscope', model, taskId, imageUrls, raw: data, ...trace };
      }
      if (['FAILED', 'FAIL', 'ERROR', 'CANCELED', 'CANCELLED', 'TIMEOUT', 'REVOKED'].includes(status)) {
        return { ok: false, code: 'task_failed', providerId: provider.id, protocol: 'modelscope', model, taskId, error: `ModelScope 任务失败：${taskFailureDetail(data)}`, raw: data, ...trace };
      }
    }
    return { ok: false, code: 'timeout', providerId: provider.id, protocol: 'modelscope', model, taskId, error: 'ModelScope 生图任务超时。', raw: lastPayload, ...mergeProviderTrace(trace, { pollCount }) };
  } catch (e) {
    return {
      ok: false,
      code: e?.name === 'AbortError' ? 'timeout' : 'network_error',
      providerId: provider.id,
      protocol: 'modelscope',
      model,
      error: e?.name === 'AbortError' ? 'ModelScope 调用超时。' : (e?.message || 'ModelScope 调用失败。'),
      ...mergeProviderTrace(trace, { pollCount }),
    };
  }
}

module.exports = {
  generateChat,
  generateImage,
  testProvider,
};
