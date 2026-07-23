const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const tls = require('tls');
const { Agent, fetch: undiciFetch } = require('undici');
const config = require('../config');
const {
  isT8LocalMediaPath,
  mimeFromPath,
  normalizeT8LocalMediaRef,
  resolveMediaRef,
} = require('./mediaResolver');
const { providerTrace } = require('./providerTrace');
const { safeRemoteMediaFetch } = require('../utils/safeRemoteMediaFetch');

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
const ZHENZHEN_IMAGE_G2_T2I_MODEL = 'zhenzhen-image-g2-t2i';
const ZHENZHEN_IMAGE_G2_I2I_MODEL = 'zhenzhen-image-g2-i2i';
const ZHENZHEN_IMAGE_G2_MODELS = new Set([
  ZHENZHEN_IMAGE_G2_T2I_MODEL,
  ZHENZHEN_IMAGE_G2_I2I_MODEL,
]);
const ZHENZHEN_IMAGE_G2_RATIOS = new Set(RATIOS);
const IMAGE_MODELS = new Set([
  ...Object.values(IMAGE_MODEL_PAIRS).flat(),
  ...ZHENZHEN_IMAGE_G2_MODELS,
]);
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
const KLING_T2V_MODELS = new Set([
  'kling-v3.0-std-t2v',
  'kling-v3.0-pro-t2v',
  'kling-v3-turbo-std-t2v',
  'kling-v3-turbo-pro-t2v',
  'kling-v3-4k-t2v',
  'kling-o3-std-t2v',
  'kling-o3-pro-t2v',
  'kling-o3-4k-t2v',
]);
const KLING_I2V_MODELS = new Set([
  'kling-v3.0-std-i2v',
  'kling-v3.0-pro-i2v',
  'kling-v3-turbo-std-i2v',
  'kling-v3-turbo-pro-i2v',
  'kling-v3-4k-i2v',
  'kling-o3-std-i2v',
  'kling-o3-pro-i2v',
  'kling-o3-4k-i2v',
]);
const KLING_R2V_MODELS = new Set([
  'kling-o3-std-r2v',
  'kling-o3-pro-r2v',
  'kling-o3-4k-r2v',
]);
const KLING_EDIT_MODELS = new Set([
  'kling-o3-std-edit',
  'kling-o3-pro-edit',
]);
const KLING_VIDEO_MODELS = new Set([...KLING_T2V_MODELS, ...KLING_I2V_MODELS, ...KLING_R2V_MODELS]);
const KLING_MODELS = new Set([...KLING_VIDEO_MODELS, ...KLING_EDIT_MODELS]);
const KLING_SECONDS = new Set(['5', '10']);
const KLING_PROMPT_MAX_LENGTH = 20480;
const KLING_MAX_REFERENCE_IMAGES = 4;
const ZHENZHEN_UPSCALER_MODEL = 'zhenzhen-upscaler';
const ZHENZHEN_UPSCALER_RESOLUTIONS = new Set(['720p', '1080p', '2k', '4k']);
const HAILUO23_T2V_MODELS = new Set([
  'hailuo-2.3-t2v-standard',
  'hailuo-2.3-t2v-pro',
]);
const HAILUO23_I2V_MODELS = new Set([
  'hailuo-2.3-i2v-standard',
  'hailuo-2.3-i2v-pro',
  'hailuo-2.3-fast-i2v',
  'hailuo-2.3-fast-pro-i2v',
]);
const HAILUO23_MODELS = new Set([...HAILUO23_T2V_MODELS, ...HAILUO23_I2V_MODELS]);
const HAILUO23_RESOLUTIONS = new Set(['768p', '1080p']);
const HAILUO23_SECONDS = new Set(['6', '10']);
const HAILUO23_PROMPT_MAX_LENGTH = 2000;
const HAILUO23_MIN_IMAGE_SHORT_EDGE = 301;
const HAILUO23_MIN_ASPECT_RATIO = 2 / 5;
const HAILUO23_MAX_ASPECT_RATIO = 5 / 2;
const VIDU_Q3_T2V_MODELS = new Set([
  'vidu-q3-pro-t2v',
  'vidu-q3-turbo-t2v',
  'vidu-q3-pro-fast-t2v',
]);
const VIDU_Q3_I2V_MODELS = new Set([
  'vidu-q3-pro-i2v',
  'vidu-q3-turbo-i2v',
  'vidu-q3-pro-fast-i2v',
]);
const VIDU_Q3_START_END_MODELS = new Set([
  'vidu-q3-pro-start-end',
  'vidu-q3-turbo-start-end',
  'vidu-q3-pro-fast-start-end',
]);
const VIDU_Q3_R2V_MODELS = new Set([
  'vidu-q3-r2v',
  'vidu-q3-mix-r2v',
  'vidu-q3-ad-r2v',
  'vidu-q3-drama-r2v',
]);
const VIDU_Q3_SHORT_PLAY_MODELS = new Set([
  'vidu-q3-drama-short-play',
  'vidu-q3-ad-short-play',
]);
const VIDU_Q3_VIDEO_MODELS = new Set([
  ...VIDU_Q3_T2V_MODELS,
  ...VIDU_Q3_I2V_MODELS,
  ...VIDU_Q3_START_END_MODELS,
  ...VIDU_Q3_R2V_MODELS,
]);
const VIDU_Q3_MODELS = new Set([...VIDU_Q3_VIDEO_MODELS, ...VIDU_Q3_SHORT_PLAY_MODELS]);
const VIDU_Q3_SECONDS = new Set(Array.from({ length: 12 }, (_, index) => String(index + 4)));
const VIDU_Q3_RESOLUTIONS = new Set(['default', '720p', '1080p']);
const VIDU_Q3_SHORT_PLAY_DURATIONS = new Set(['8', '9', '10', '11', '12']);
const VIDU_Q3_SHORT_PLAY_ASPECT_RATIOS = new Set(['9:16', '16:9']);
const VIDU_Q3_SHORT_PLAY_ASSET_TYPES = new Set(['character', 'scene', 'prop']);
const VIDU_Q3_PROMPT_MAX_LENGTH = 20480;
const VIDU_Q3_MAX_REFERENCE_IMAGES = 9;
const VIDU_Q3_MAX_SHORT_PLAY_ASSETS = 14;
const SEED_AUDIO_MODEL = 'doubao-seed-audio-1.0';
const SEED_AUDIO_FORMATS = new Set(['wav', 'mp3', 'pcm', 'ogg_opus']);
const SEED_AUDIO_SAMPLE_RATES = new Set(['8000', '16000', '24000', '32000', '44100']);
const IMAGE_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_UPLOAD_INTERVAL_MS = 6100;
const DEFAULT_UPLOAD_CACHE_TTL_MS = 20 * 60 * 60 * 1000;
const DEFAULT_PROVIDER_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_PROVIDER_DEADLINE_MS = 30 * 1000;
const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 10 * 1000;
const SAFE_DIAGNOSTIC_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,159}$/;
const SENSITIVE_DIAGNOSTIC_TOKEN = /(?:api[-_]?key|authorization|cookie|token|secret|password|credential)/i;

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
const responseBoundaries = new WeakMap();

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

function boundedPositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(parsed)));
}

function providerBoundaryOptions(options = {}) {
  return {
    maxResponseBytes: boundedPositiveInteger(
      options.providerMaxResponseBytes ?? options.maxResponseBytes,
      DEFAULT_PROVIDER_RESPONSE_MAX_BYTES,
      64 * 1024 * 1024,
    ),
    deadlineMs: boundedPositiveInteger(
      options.providerDeadlineMs ?? options.deadlineMs,
      DEFAULT_PROVIDER_DEADLINE_MS,
      10 * 60 * 1000,
    ),
    idleTimeoutMs: boundedPositiveInteger(
      options.providerIdleTimeoutMs ?? options.idleTimeoutMs,
      DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
      10 * 60 * 1000,
    ),
  };
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '').trim();
  const normalized = String(name).toLowerCase();
  if (Array.isArray(headers)) {
    const entry = headers.find(([key]) => String(key).toLowerCase() === normalized);
    return String(entry?.[1] || '').trim();
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === normalized);
  return String(entry?.[1] || '').trim();
}

function sensitiveValuesFromInit(init = {}) {
  const values = [];
  for (const name of ['authorization', 'x-api-key', 'api-key']) {
    const value = headerValue(init.headers, name);
    if (!value) continue;
    values.push(value);
    const withoutScheme = value.replace(/^(?:bearer|basic)\s+/i, '').trim();
    if (withoutScheme) values.push(withoutScheme);
  }
  return [...new Set(values.filter((value) => value.length >= 4))];
}

function containsSensitiveValue(value, sensitiveValues = []) {
  const text = String(value || '');
  return sensitiveValues.some((sensitive) => sensitive && text.includes(sensitive));
}

function safeDiagnosticToken(value, sensitiveValues = []) {
  const text = String(value || '').trim();
  if (!SAFE_DIAGNOSTIC_TOKEN.test(text)) return '';
  if (SENSITIVE_DIAGNOSTIC_TOKEN.test(text)) return '';
  if (containsSensitiveValue(text, sensitiveValues)) return '';
  return text;
}

function safeUsageValue(value, depth = 0) {
  if (depth > 4) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key) || SENSITIVE_DIAGNOSTIC_TOKEN.test(key)) continue;
    const safeValue = safeUsageValue(item, depth + 1);
    if (safeValue !== undefined) output[key] = safeValue;
  }
  return Object.keys(output).length ? output : undefined;
}

function safeProviderTrace(response, data, extra = {}) {
  const unsafe = providerTrace(response, data, extra);
  const boundary = responseBoundaries.get(response);
  const sensitiveValues = boundary?.sensitiveValues || [];
  const requestId = safeDiagnosticToken(unsafe.requestId, sensitiveValues);
  const usage = safeUsageValue(unsafe.usage);
  return {
    ...(unsafe.upstreamHttpStatus ? { upstreamHttpStatus: unsafe.upstreamHttpStatus } : {}),
    ...(requestId ? { requestId } : {}),
    ...(usage ? { usage } : {}),
    ...(unsafe.pollCount !== undefined ? { pollCount: unsafe.pollCount } : {}),
  };
}

function safeUpstreamCode(data, sensitiveValues = []) {
  const candidates = [data?.error?.code, data?.code, data?.error_code, data?.errorCode];
  for (const candidate of candidates) {
    const code = safeDiagnosticToken(candidate, sensitiveValues);
    if (code) return code;
  }
  return '';
}

function boundaryError(message, code, status, trace = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, trace);
  return error;
}

function upstreamTimeoutError(label, response) {
  return boundaryError(
    `${label}上游响应超时`,
    'SEEDANCE_UPSTREAM_TIMEOUT',
    504,
    response ? safeProviderTrace(response, {}) : {},
  );
}

function upstreamUnavailableError(label, response) {
  return boundaryError(
    `${label}上游暂时不可用`,
    'SEEDANCE_UPSTREAM_UNAVAILABLE',
    502,
    response ? safeProviderTrace(response, {}) : {},
  );
}

function responseTooLargeError(label, response, maxBytes) {
  const error = boundaryError(
    `${label}响应超过大小上限`,
    'SEEDANCE_RESPONSE_TOO_LARGE',
    502,
    response ? safeProviderTrace(response, {}) : {},
  );
  error.maxBytes = maxBytes;
  return error;
}

function invalidResponseError(label, response, body) {
  const error = boundaryError(
    `${label}返回无效响应`,
    'SEEDANCE_INVALID_RESPONSE',
    502,
    response ? safeProviderTrace(response, {}) : {},
  );
  if (body) error.bodyDigest = `sha256:${crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
  return error;
}

function cancelBodyReader(reader, reason) {
  try {
    const cancellation = reader?.cancel?.(reason);
    Promise.resolve(cancellation).catch(() => {});
  } catch {}
}

function finishResponseBoundary(boundary) {
  if (!boundary || boundary.finished) return;
  boundary.finished = true;
  boundary.cleanup?.();
}

async function fetchProviderResponse(fetchImpl, url, init = {}, options = {}, label = 'seedance.nz 请求') {
  const limits = providerBoundaryOptions(options);
  const controller = new AbortController();
  const externalSignal = init?.signal;
  let externalAborted = externalSignal?.aborted === true;
  const forwardAbort = () => {
    externalAborted = true;
    controller.abort();
  };
  if (externalSignal?.addEventListener) {
    if (externalAborted) controller.abort();
    else externalSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  const boundary = {
    controller,
    deadlineAt: Date.now() + limits.deadlineMs,
    idleTimeoutMs: limits.idleTimeoutMs,
    maxResponseBytes: limits.maxResponseBytes,
    sensitiveValues: sensitiveValuesFromInit(init),
    cleanup: () => externalSignal?.removeEventListener?.('abort', forwardAbort),
    finished: false,
  };
  let timer;
  let timedOut = false;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(upstreamTimeoutError(label));
      }, limits.deadlineMs);
    });
    const response = await Promise.race([
      Promise.resolve().then(() => fetchImpl(url, { ...init, signal: controller.signal })),
      timeout,
    ]);
    if (!response || typeof response !== 'object') {
      finishResponseBoundary(boundary);
      throw invalidResponseError(label);
    }
    responseBoundaries.set(response, boundary);
    return response;
  } catch (error) {
    finishResponseBoundary(boundary);
    if (timedOut || error?.code === 'SEEDANCE_UPSTREAM_TIMEOUT') throw upstreamTimeoutError(label);
    if (error?.code?.startsWith?.('SEEDANCE_')) throw error;
    if (externalAborted) {
      throw boundaryError(`${label}已取消`, 'SEEDANCE_REQUEST_ABORTED', 499);
    }
    throw upstreamUnavailableError(label);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponse(response, label, maxBytesOverride) {
  const boundary = responseBoundaries.get(response) || {
    deadlineAt: Date.now() + DEFAULT_PROVIDER_DEADLINE_MS,
    idleTimeoutMs: DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
    maxResponseBytes: DEFAULT_PROVIDER_RESPONSE_MAX_BYTES,
    sensitiveValues: [],
    finished: false,
  };
  const maxBytes = boundedPositiveInteger(maxBytesOverride, boundary.maxResponseBytes, 64 * 1024 * 1024);
  const rawAdvertisedLength = response?.headers?.get?.('content-length');
  const advertisedLength = rawAdvertisedLength === null || rawAdvertisedLength === undefined || rawAdvertisedLength === ''
    ? null
    : Number(rawAdvertisedLength);
  const contentEncoding = String(response?.headers?.get?.('content-encoding') || '').trim().toLowerCase();
  const identityEncoded = !contentEncoding || contentEncoding === 'identity';
  const reader = response?.body?.getReader?.();

  if (advertisedLength !== null && (!Number.isSafeInteger(advertisedLength) || advertisedLength < 0)) {
    cancelBodyReader(reader, 'invalid content length');
    boundary.controller?.abort();
    finishResponseBoundary(boundary);
    throw invalidResponseError(label, response);
  }
  if (identityEncoded && Number.isFinite(advertisedLength) && advertisedLength >= 0 && advertisedLength > maxBytes) {
    cancelBodyReader(reader, 'response too large');
    boundary.controller?.abort();
    finishResponseBoundary(boundary);
    throw responseTooLargeError(label, response, maxBytes);
  }
  if (!reader) {
    finishResponseBoundary(boundary);
    if (advertisedLength > 0) throw invalidResponseError(label, response);
    return Buffer.alloc(0);
  }

  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const remainingMs = boundary.deadlineAt - Date.now();
      if (remainingMs <= 0) throw upstreamTimeoutError(label, response);
      const waitMs = Math.max(1, Math.min(boundary.idleTimeoutMs, remainingMs));
      let timer;
      let timedOut = false;
      let result;
      try {
        result = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              boundary.controller?.abort();
              reject(upstreamTimeoutError(label, response));
            }, waitMs);
          }),
        ]);
      } catch (error) {
        if (timedOut || error?.code === 'SEEDANCE_UPSTREAM_TIMEOUT') throw upstreamTimeoutError(label, response);
        if (error?.code?.startsWith?.('SEEDANCE_')) throw error;
        throw upstreamUnavailableError(label, response);
      } finally {
        clearTimeout(timer);
      }
      if (result.done) break;
      const chunk = result.value;
      if (!ArrayBuffer.isView(chunk)) throw invalidResponseError(label, response);
      const byteLength = Number(chunk?.byteLength ?? chunk?.length ?? 0);
      if (!Number.isFinite(byteLength) || byteLength < 0) throw invalidResponseError(label, response);
      if (totalBytes + byteLength > maxBytes) throw responseTooLargeError(label, response, maxBytes);
      if (byteLength > 0) {
        chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset || 0, byteLength));
        totalBytes += byteLength;
      }
    }
    if (identityEncoded && Number.isFinite(advertisedLength) && advertisedLength >= 0 && totalBytes !== advertisedLength) {
      throw invalidResponseError(label, response);
    }
    return Buffer.concat(chunks, totalBytes);
  } catch (error) {
    cancelBodyReader(reader, error?.code || 'response rejected');
    boundary.controller?.abort();
    throw error;
  } finally {
    finishResponseBoundary(boundary);
  }
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
    throw mediaTooLargeError(kind, max);
  }
}

function mediaTooLargeError(kind, maxBytes) {
  const error = new Error(`${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}超过 seedance.nz ${maxBytes / 1024 / 1024}MB 上限`);
  error.code = 'SEEDANCE_MEDIA_TOO_LARGE';
  error.status = 413;
  error.maxBytes = maxBytes;
  return error;
}

function readBoundedLocalFile(filePath, kind, maxBytes) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(descriptor).size;
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) throw mediaTooLargeError(kind, maxBytes);
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, size - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    if (fs.readSync(descriptor, probe, 0, 1, offset) > 0) throw mediaTooLargeError(kind, maxBytes);
    return offset === size ? buffer : buffer.subarray(0, offset);
  } finally {
    fs.closeSync(descriptor);
  }
}

function mediaKindLabel(kind) {
  if (kind === 'image') return '图片';
  if (kind === 'video') return '视频';
  if (kind === 'audio') return '音频';
  return '素材';
}

function localMediaUnavailableError(kind) {
  const label = mediaKindLabel(kind);
  return boundaryError(
    `参考${label}的本地文件不存在或无法读取。请删除失效素材后重新上传原${label}（错误码：SEEDANCE_MEDIA_REFERENCE_UNAVAILABLE）`,
    'SEEDANCE_MEDIA_REFERENCE_UNAVAILABLE',
    400,
  );
}

function normalizeRemoteMediaError(error, kind, maxBytes) {
  const label = mediaKindLabel(kind);
  if (error?.code === 'item_too_large') return mediaTooLargeError(kind, maxBytes);
  if (error?.code === 'fetch_timeout') {
    return boundaryError(
      `下载参考${label}超时。请检查网络和素材链接是否仍有效，或重新上传原${label}后重试（错误码：SEEDANCE_UPSTREAM_TIMEOUT）`,
      'SEEDANCE_UPSTREAM_TIMEOUT',
      504,
    );
  }
  if (error?.code === 'private_address') {
    return boundaryError(
      `参考${label}地址指向本机、局域网或受保护网络，已被安全校验拦截。请重新上传原${label}，或改用无需登录、可公开访问的 HTTPS ${label}直链（错误码：SEEDANCE_REMOTE_MEDIA_BLOCKED）`,
      'SEEDANCE_REMOTE_MEDIA_BLOCKED',
      400,
    );
  }
  if (error?.code === 'url_credentials_forbidden') {
    return boundaryError(
      `参考${label}网址包含账号或密码，已被安全校验拦截。请重新上传原${label}，或改用不含登录信息的公开 HTTPS ${label}直链（错误码：SEEDANCE_REMOTE_MEDIA_BLOCKED）`,
      'SEEDANCE_REMOTE_MEDIA_BLOCKED',
      400,
    );
  }
  if (error?.code === 'invalid_url' || error?.code === 'invalid_protocol') {
    return boundaryError(
      `参考${label}地址无效或不是 HTTP/HTTPS 链接。请重新上传原${label}，或改用可公开访问的 HTTPS ${label}直链（错误码：SEEDANCE_REMOTE_MEDIA_INVALID）`,
      'SEEDANCE_REMOTE_MEDIA_INVALID',
      400,
    );
  }
  const remoteStatus = Number(error?.status);
  if (error?.code === 'remote_http_error' && Number.isInteger(remoteStatus)) {
    return boundaryError(
      `下载参考${label}失败：素材服务器返回 HTTP ${remoteStatus}。链接可能已过期、需要登录或禁止外部访问；请重新上传原${label}后重试（错误码：SEEDANCE_REMOTE_MEDIA_HTTP_ERROR）`,
      'SEEDANCE_REMOTE_MEDIA_HTTP_ERROR',
      remoteStatus,
    );
  }
  return boundaryError(
    `下载参考${label}失败，远程地址当前无法访问。请检查网络和链接有效期，或重新上传原${label}后重试（错误码：SEEDANCE_REMOTE_MEDIA_UNAVAILABLE）`,
    'SEEDANCE_REMOTE_MEDIA_UNAVAILABLE',
    502,
  );
}

async function responseJson(response, label) {
  const body = await readBoundedResponse(response, label);
  const text = body.toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw invalidResponseError(label, response, body);
  }
}

function createUpstreamError(data, responseOrStatus) {
  const response = responseOrStatus && typeof responseOrStatus === 'object' ? responseOrStatus : null;
  const rawStatus = Number(response?.status ?? responseOrStatus);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 502;
  const trace = response ? safeProviderTrace(response, data) : {};
  const sensitiveValues = responseBoundaries.get(response)?.sensitiveValues || [];
  const upstreamCode = safeUpstreamCode(data, sensitiveValues);
  const error = boundaryError(
    `seedance.nz 上游请求失败（HTTP ${status}）`,
    'SEEDANCE_UPSTREAM_ERROR',
    status,
    trace,
  );
  if (upstreamCode) error.upstreamCode = upstreamCode;
  return error;
}

function safeProgress(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(100, value));
  const text = String(value ?? '').trim();
  return /^\d{1,3}%?$/.test(text) ? text.slice(0, 4) : '';
}

function requiredTaskId(value, label, response) {
  const taskId = String(value || '').trim();
  const sensitiveValues = responseBoundaries.get(response)?.sensitiveValues || [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\-]{0,255}$/.test(taskId) || containsSensitiveValue(taskId, sensitiveValues)) {
    throw invalidResponseError(label, response);
  }
  return taskId;
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

async function mediaBuffer(source, kind, maxBytes, options = {}) {
  const text = normalizeT8LocalMediaRef(source);
  const dataMatch = text.match(/^data:([^;,]+);base64,(.+)$/i);
  if (dataMatch) {
    const max = Number(maxBytes) || maxBytesForKind(kind);
    const encoded = dataMatch[2].replace(/\s+/g, '');
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    const decodedBytes = Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
    if (decodedBytes > max) throw mediaTooLargeError(kind, max);
    const buffer = Buffer.from(encoded, 'base64');
    ensureSize(buffer, kind, maxBytes);
    return {
      buffer,
      mime: dataMatch[1] || defaultMime(kind),
      fileName: `seedance-${kind}${extensionFromMime(dataMatch[1], kind)}`,
    };
  }

  let resolved = null;
  try {
    resolved = await resolveMediaRef(text, { target: 'local-path' });
  } catch {
    // Remote references are resolved below. Controlled T8 mounts must be tried
    // locally first so /files/* never becomes an SSRF-prone loopback fetch.
    if (isT8LocalMediaPath(text)) throw localMediaUnavailableError(kind);
  }
  if (!resolved) {
    try {
      resolved = await resolveMediaRef(text, { target: 'url' });
    } catch {
      const label = mediaKindLabel(kind);
      throw boundaryError(
        `参考${label}引用无效。请删除该素材后重新上传原${label}（错误码：SEEDANCE_MEDIA_REFERENCE_INVALID）`,
        'SEEDANCE_MEDIA_REFERENCE_INVALID',
        400,
      );
    }
  }
  if (resolved.kind === 'local-path') {
    const max = Number(maxBytes) || maxBytesForKind(kind);
    let buffer;
    try {
      buffer = readBoundedLocalFile(resolved.path, kind, max);
    } catch (error) {
      if (error?.code === 'SEEDANCE_MEDIA_TOO_LARGE') throw error;
      throw localMediaUnavailableError(kind);
    }
    return {
      buffer,
      mime: resolved.mime || mimeFromPath(resolved.path, defaultMime(kind)),
      fileName: path.basename(resolved.path),
    };
  }

  const max = Number(maxBytes) || maxBytesForKind(kind);
  const limits = providerBoundaryOptions(options);
  let remote;
  try {
    remote = await safeRemoteMediaFetch(resolved.url, {
      protocols: ['http:', 'https:'],
      maxBytes: max,
      deadlineMs: limits.deadlineMs,
      idleTimeoutMs: limits.idleTimeoutMs,
      maxRedirects: options.remoteMaxRedirects,
      lookupImpl: options.lookupImpl,
      allowPrivateForTests: options.allowPrivateForTests,
    });
  } catch (error) {
    throw normalizeRemoteMediaError(error, kind, max);
  }
  const buffer = remote.buffer;
  const rawMime = String(remote.contentType || defaultMime(kind)).split(';')[0].trim().toLowerCase();
  const mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(rawMime) ? rawMime : 'application/octet-stream';
  let fileName = `seedance-${kind}${extensionFromMime(mime, kind)}`;
  try {
    const remoteName = path.basename(new URL(remote.finalUrl).pathname).slice(0, 180);
    if (remoteName) fileName = remoteName;
  } catch {}
  return { buffer, mime, fileName };
}

async function uploadMedia(source, kind, apiKey, options = {}) {
  const text = normalizeT8LocalMediaRef(source);
  if (!text) throw new Error(`未收到参考${mediaKindLabel(kind)}，请重新选择或上传素材`);

  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const intervalMs = options.uploadIntervalMs ?? DEFAULT_UPLOAD_INTERVAL_MS;
  const ttlMs = options.uploadCacheTtlMs ?? DEFAULT_UPLOAD_CACHE_TTL_MS;
  const cacheKey = `${hashKey(apiKey)}:${kind}:${Number(options.maxBytes) || 0}:${String(options.cacheVariant || '')}:${hashKey(text)}`;
  const cached = uploadCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < ttlMs) return cached.promise;

  const promise = withUploadQueue(apiKey, intervalMs, async () => {
    const file = await mediaBuffer(text, kind, options.maxBytes, options);
    if (Array.isArray(options.allowedMimes) && !options.allowedMimes.includes(String(file.mime || '').toLowerCase())) {
      throw new Error(`seedance.nz 不支持该${kind}格式`);
    }
    if (typeof options.validateBuffer === 'function') {
      await options.validateBuffer(file.buffer, file);
    }
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const form = new FormData();
        form.append('file', new Blob([file.buffer], { type: file.mime }), file.fileName);
        const response = await fetchProviderResponse(fetchImpl, `${baseUrl}/v1/files/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        }, options, 'seedance.nz 文件上传');
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

function normalizeZhenzhenImageG2Prompt(value) {
  const prompt = String(value || '').trim();
  if (!prompt) throw new Error('Zhenzhen Image G-2 必须填写提示词');
  if (prompt.length > 20000) throw new Error('Zhenzhen Image G-2 提示词不能超过 20000 字符');
  return prompt;
}

function normalizeZhenzhenImageG2Metadata(request = {}) {
  const resolution = String(request.resolution || '1k').trim().toLowerCase();
  if (resolution !== '1k') throw new Error('Zhenzhen Image G-2 分辨率只能是 1k');
  if (request.output_format !== undefined || request.outputFormat !== undefined) {
    throw new Error('Zhenzhen Image G-2 不支持 output_format');
  }
  if (request.size !== undefined || request.width !== undefined || request.height !== undefined) {
    throw new Error('Zhenzhen Image G-2 不支持自定义宽高');
  }
  const ratio = String(request.ratio || 'adaptive').trim().toLowerCase();
  if (!ZHENZHEN_IMAGE_G2_RATIOS.has(ratio)) {
    throw new Error(`Zhenzhen Image G-2 不支持比例 ${ratio || '(空)'}`);
  }
  return ratio === 'adaptive' ? { resolution: '1k' } : { resolution: '1k', ratio };
}

async function buildZhenzhenImageG2Payload(request, apiKey, options = {}) {
  const model = String(request.model || '').trim().toLowerCase();
  if (!ZHENZHEN_IMAGE_G2_MODELS.has(model)) {
    throw new Error(`未知 Zhenzhen Image G-2 模型：${model || '(空)'}`);
  }
  const refs = normalizeList(request.images || request.refImages);
  if (model === ZHENZHEN_IMAGE_G2_I2I_MODEL && refs.length === 0) {
    throw new Error('zhenzhen-image-g2-i2i 至少需要 1 张参考图');
  }
  if (model === ZHENZHEN_IMAGE_G2_I2I_MODEL && refs.length > 10) {
    throw new Error('Zhenzhen Image G-2 图生图最多支持 10 张参考图');
  }

  const payload = {
    model,
    prompt: normalizeZhenzhenImageG2Prompt(request.prompt),
    metadata: normalizeZhenzhenImageG2Metadata(request),
  };
  if (model === ZHENZHEN_IMAGE_G2_I2I_MODEL) {
    payload.images = [];
    for (const source of refs) {
      payload.images.push(await uploadMedia(source, 'image', apiKey, {
        ...options,
        maxBytes: IMAGE_REFERENCE_MAX_BYTES,
        allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
      }));
    }
  }
  return {
    payload,
    model,
    taskType: model === ZHENZHEN_IMAGE_G2_I2I_MODEL ? 'i2i' : 't2i',
  };
}

async function buildImagePayload(request, apiKey, options = {}) {
  const requestedModel = String(request.model || '').trim().toLowerCase();
  if (ZHENZHEN_IMAGE_G2_MODELS.has(requestedModel)) {
    return buildZhenzhenImageG2Payload(request, apiKey, options);
  }
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

  const metadata = { resolution };
  if (negativePrompt) metadata.negative_prompt = negativePrompt;
  if (audioUrl) metadata.audio_url = await uploadMedia(audioUrl, 'audio', apiKey, options);
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

async function validateHailuoFirstImage(buffer) {
  let metadata;
  try {
    metadata = await sharp(buffer, {
      animated: false,
      failOn: 'error',
      limitInputPixels: 100_000_000,
    }).metadata();
  } catch {
    throw boundaryError('Hailuo 首帧图无法解码', 'HAILUO_INVALID_FIRST_IMAGE', 400);
  }
  const width = Number(metadata?.width || 0);
  const height = Number(metadata?.pageHeight || metadata?.height || 0);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw boundaryError('Hailuo 首帧图缺少有效尺寸', 'HAILUO_INVALID_FIRST_IMAGE_SIZE', 400);
  }
  if (Math.min(width, height) < HAILUO23_MIN_IMAGE_SHORT_EDGE) {
    throw boundaryError('Hailuo 首帧图短边必须大于 300px', 'HAILUO_FIRST_IMAGE_TOO_SMALL', 400);
  }
  const aspectRatio = width / height;
  if (aspectRatio < HAILUO23_MIN_ASPECT_RATIO || aspectRatio > HAILUO23_MAX_ASPECT_RATIO) {
    throw boundaryError('Hailuo 首帧图宽高比必须在 2:5 到 5:2 之间', 'HAILUO_FIRST_IMAGE_ASPECT_RATIO', 400);
  }
}

async function buildHailuoPayload(request, apiKey, options = {}) {
  const model = String(request.model || '').trim();
  if (!HAILUO23_MODELS.has(model)) throw new Error(`未知 Hailuo 2.3 模型：${model || '(空)'}`);

  const prompt = String(request.prompt || '').trim();
  if (prompt.length > HAILUO23_PROMPT_MAX_LENGTH) {
    throw new Error(`Hailuo 2.3 提示词不能超过 ${HAILUO23_PROMPT_MAX_LENGTH} 字符`);
  }
  const taskType = HAILUO23_T2V_MODELS.has(model) ? 't2v' : 'i2v';
  if (taskType === 't2v' && !prompt) throw new Error('Hailuo 2.3 文生视频必须填写提示词');

  const seconds = String(request.duration ?? request.seconds ?? '6').trim();
  if (!HAILUO23_SECONDS.has(seconds)) throw new Error('Hailuo 2.3 时长只支持 6 或 10 秒');
  const resolution = String(request.resolution || '768p').trim().toLowerCase();
  if (!HAILUO23_RESOLUTIONS.has(resolution)) throw new Error('Hailuo 2.3 分辨率只支持 768p 或 1080p');
  if (resolution === '1080p' && seconds !== '6') throw new Error('Hailuo 2.3 的 1080p 只支持 6 秒');

  const payload = {
    model,
    seconds,
    metadata: { resolution },
  };
  if (taskType === 't2v') {
    const ratio = normalizeRatio(request.ratio || '16:9');
    if (ratio !== 'adaptive') payload.metadata.ratio = ratio;
    payload.prompt = prompt;
    return { payload, model, taskType };
  }

  const sources = normalizeList(request.images || request.refImages);
  if (sources.length === 0) throw new Error('Hailuo 2.3 图生视频必须提供 1 张首帧图');
  const imageUrl = await uploadMedia(sources[0], 'image', apiKey, {
    ...options,
    maxBytes: 30 * 1024 * 1024,
    allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
    cacheVariant: 'hailuo23-first-image-v1',
    validateBuffer: validateHailuoFirstImage,
  });
  payload.images = [imageUrl];
  if (prompt) payload.prompt = prompt;
  return { payload, model, taskType };
}

function deriveKlingTaskType(model) {
  if (KLING_T2V_MODELS.has(model)) return 't2v';
  if (KLING_I2V_MODELS.has(model)) return 'i2v';
  if (KLING_R2V_MODELS.has(model)) return 'r2v';
  if (KLING_EDIT_MODELS.has(model)) return 'edit';
  return '';
}

async function uploadKlingImages(sources, apiKey, options = {}) {
  const images = [];
  for (const source of sources) {
    images.push(await uploadMedia(source, 'image', apiKey, {
      ...options,
      maxBytes: 30 * 1024 * 1024,
      allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
    }));
  }
  return images;
}

async function buildKlingPayload(request, apiKey, options = {}) {
  const model = String(request.model || '').trim();
  if (!KLING_MODELS.has(model)) throw new Error(`未知 Kling 模型：${model || '(空)'}`);

  const taskType = deriveKlingTaskType(model);
  const prompt = String(request.prompt || '').trim();
  if (prompt.length > KLING_PROMPT_MAX_LENGTH) {
    throw new Error(`Kling 提示词不能超过 ${KLING_PROMPT_MAX_LENGTH} 字符`);
  }
  if (taskType !== 'i2v' && !prompt) {
    throw new Error(`Kling ${taskType === 'edit' ? '视频编辑' : taskType === 'r2v' ? '参考生视频' : '文生视频'}必须填写提示词`);
  }
  const seconds = String(request.duration ?? request.seconds ?? '5').trim();
  if (!KLING_SECONDS.has(seconds)) throw new Error('Kling 时长只支持 5 或 10 秒');

  if (taskType === 'edit') {
    const videos = normalizeList(request.videos || request.videoUrls);
    if (videos.length === 0) throw new Error('Kling 视频编辑必须提供 1 个输入视频');
    const videoUrl = await uploadMedia(videos[0], 'video', apiKey, {
      ...options,
      maxBytes: 50 * 1024 * 1024,
      allowedMimes: ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska'],
    });
    return {
      payload: {
        model,
        prompt,
        seconds,
        metadata: {
          content: [{ type: 'video_url', video_url: { url: videoUrl } }],
        },
      },
      model,
      taskType,
    };
  }

  const ratio = String(request.ratio || '16:9').trim();
  if (!RATIOS.has(ratio)) throw new Error(`Kling 不支持比例：${ratio || '(空)'}`);
  const negativePrompt = String(request.negativePrompt ?? request.negative_prompt ?? '').trim();
  if (negativePrompt.length > KLING_PROMPT_MAX_LENGTH) {
    throw new Error(`Kling 反向提示词不能超过 ${KLING_PROMPT_MAX_LENGTH} 字符`);
  }
  const sources = normalizeList(request.images || request.refImages);
  let selectedSources = [];
  if (taskType === 'i2v') {
    if (sources.length === 0) throw new Error('Kling 图生视频必须提供第 1 张首帧图');
    selectedSources = sources.slice(0, 2);
  } else if (taskType === 'r2v') {
    if (sources.length === 0) throw new Error('Kling 参考生视频至少需要 1 张参考图');
    selectedSources = sources.slice(0, KLING_MAX_REFERENCE_IMAGES);
  }

  const metadata = {};
  if (ratio !== 'adaptive') metadata.ratio = ratio;
  if (negativePrompt) metadata.negative_prompt = negativePrompt;
  const payload = { model, seconds, metadata };
  if (prompt) payload.prompt = prompt;
  if (selectedSources.length) payload.images = await uploadKlingImages(selectedSources, apiKey, options);
  return { payload, model, taskType };
}

function validateUpscalerMp4(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw boundaryError('Zhenzhen Upscaler 输入必须是有效 MP4', 'UPSCALER_INVALID_MP4', 400);
  }
}

async function buildUpscalerPayload(request, apiKey, options = {}) {
  const model = String(request.model || ZHENZHEN_UPSCALER_MODEL).trim();
  if (model !== ZHENZHEN_UPSCALER_MODEL) {
    throw new Error(`未知 Zhenzhen Upscaler 模型：${model || '(空)'}`);
  }
  const resolution = String(request.resolution || '1080p').trim().toLowerCase();
  if (!ZHENZHEN_UPSCALER_RESOLUTIONS.has(resolution)) {
    throw new Error('Zhenzhen Upscaler 分辨率只支持 720p、1080p、2k 或 4k');
  }
  const sources = normalizeList(request.videos || request.videoUrls || (request.video ? [request.video] : []));
  if (sources.length !== 1) throw new Error('Zhenzhen Upscaler 必须提供且只能提供 1 个 MP4 视频');
  const videoUrl = await uploadMedia(sources[0], 'video', apiKey, {
    ...options,
    maxBytes: 50 * 1024 * 1024,
    allowedMimes: ['video/mp4'],
    cacheVariant: 'zhenzhen-upscaler-mp4-v1',
    validateBuffer: validateUpscalerMp4,
  });
  return {
    payload: {
      model,
      prompt: 'upscale',
      metadata: {
        resolution,
        content: [{ type: 'video_url', video_url: { url: videoUrl } }],
      },
    },
    model,
    taskType: 'upscale',
  };
}

function deriveViduTaskType(model) {
  if (VIDU_Q3_T2V_MODELS.has(model)) return 't2v';
  if (VIDU_Q3_I2V_MODELS.has(model)) return 'i2v';
  if (VIDU_Q3_START_END_MODELS.has(model)) return 'start-end';
  if (VIDU_Q3_R2V_MODELS.has(model)) return 'r2v';
  if (VIDU_Q3_SHORT_PLAY_MODELS.has(model)) return 'short-play';
  return '';
}

async function uploadViduImages(sources, apiKey, options = {}) {
  const images = [];
  for (const source of sources) {
    images.push(await uploadMedia(source, 'image', apiKey, {
      ...options,
      maxBytes: 30 * 1024 * 1024,
      allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
    }));
  }
  return images;
}

async function buildViduPayload(request, apiKey, options = {}) {
  const model = String(request.model || '').trim();
  if (!VIDU_Q3_MODELS.has(model)) throw new Error(`未知 Vidu Q3 模型：${model || '(空)'}`);

  const taskType = deriveViduTaskType(model);
  const prompt = String(request.prompt || '').trim();
  if (prompt.length > VIDU_Q3_PROMPT_MAX_LENGTH) {
    throw new Error(`Vidu Q3 提示词不能超过 ${VIDU_Q3_PROMPT_MAX_LENGTH} 字符`);
  }

  const sources = normalizeList(request.images || request.refImages);
  if (taskType === 'short-play') {
    if (!prompt) throw new Error('Vidu Q3 短剧成片必须填写脚本内容');
    const scriptName = String(request.scriptName ?? request.script_name ?? '').trim();
    if (!scriptName) throw new Error('Vidu Q3 短剧成片必须填写脚本名称');
    if (scriptName.length > 20) throw new Error('Vidu Q3 短剧脚本名称不能超过 20 字符');
    const resolution = String(request.resolution || '1080p').trim().toLowerCase();
    if (resolution !== '1080p') throw new Error('Vidu Q3 短剧成片分辨率必须是 1080p');
    const duration = String(request.duration ?? request.seconds ?? '8').trim();
    if (!VIDU_Q3_SHORT_PLAY_DURATIONS.has(duration)) throw new Error('Vidu Q3 短剧成片时长只支持 8-12 秒');
    const aspectRatio = String(request.aspectRatio ?? request.aspect_ratio ?? request.ratio ?? '9:16').trim();
    if (!VIDU_Q3_SHORT_PLAY_ASPECT_RATIOS.has(aspectRatio)) throw new Error('Vidu Q3 短剧成片比例只支持 9:16 或 16:9');
    const style = String(request.style || 'realistic').trim();
    if (style.length > 30) throw new Error('Vidu Q3 短剧视频风格不能超过 30 字符');
    const assetType = String(request.assetType ?? request.asset_type ?? 'character').trim();
    if (!VIDU_Q3_SHORT_PLAY_ASSET_TYPES.has(assetType)) throw new Error('Vidu Q3 短剧资产类型只支持 character、scene 或 prop');
    const assetNamePrefix = String(request.assetNamePrefix ?? request.asset_name_prefix ?? 'Asset').trim();
    if (!assetNamePrefix) throw new Error('Vidu Q3 短剧资产名称前缀不能为空');
    const assetDescription = String(request.assetDescription ?? request.asset_description ?? 'Reference asset').trim();
    if (!assetDescription) throw new Error('Vidu Q3 短剧资产描述不能为空');
    if (sources.length === 0) throw new Error('Vidu Q3 短剧成片至少需要 1 张参考资产图');
    if (sources.length > VIDU_Q3_MAX_SHORT_PLAY_ASSETS) throw new Error('Vidu Q3 短剧成片最多支持 14 张参考资产图');

    const uploaded = await uploadViduImages(sources, apiKey, options);
    return {
      payload: {
        model,
        prompt,
        metadata: {
          script_name: scriptName,
          resolution: '1080p',
          duration: Number(duration),
          aspect_ratio: aspectRatio,
          style,
          assets: uploaded.map((url, index) => ({
            id: String(index + 1),
            type: assetType,
            name: `${assetNamePrefix} ${index + 1}`,
            image_uri: url,
            description: assetDescription,
          })),
        },
      },
      model,
      taskType,
    };
  }

  if (taskType === 't2v' && !prompt) throw new Error('Vidu Q3 文生视频必须填写提示词');
  const seconds = String(request.duration ?? request.seconds ?? '4').trim();
  if (!VIDU_Q3_SECONDS.has(seconds)) throw new Error('Vidu Q3 时长只支持 4-15 秒');
  const ratio = String(request.ratio || '16:9').trim();
  if (!RATIOS.has(ratio)) throw new Error(`Vidu Q3 不支持比例：${ratio || '(空)'}`);
  const resolution = String(request.resolution || 'default').trim().toLowerCase();
  if (!VIDU_Q3_RESOLUTIONS.has(resolution)) throw new Error('Vidu Q3 分辨率只支持 default、720p 或 1080p');
  const seed = request.seed === undefined || request.seed === null || request.seed === ''
    ? -1
    : Number(request.seed);
  if (!Number.isInteger(seed) || seed < -1 || seed > 2147483647) {
    throw new Error('Vidu Q3 seed 必须是 -1 到 2147483647 的整数');
  }

  let selectedSources = [];
  if (taskType === 'i2v') {
    if (sources.length === 0) throw new Error('Vidu Q3 图生视频必须提供第 1 张首帧图');
    selectedSources = sources.slice(0, 1);
  } else if (taskType === 'start-end') {
    if (sources.length < 2) throw new Error('Vidu Q3 首尾帧视频必须提供第 1 张和第 2 张图片');
    selectedSources = sources.slice(0, 2);
  } else if (taskType === 'r2v') {
    if (sources.length === 0) throw new Error('Vidu Q3 参考生视频至少需要 1 张参考图');
    selectedSources = sources.slice(0, VIDU_Q3_MAX_REFERENCE_IMAGES);
  }

  const metadata = {};
  if (ratio !== 'adaptive') metadata.ratio = ratio;
  if (resolution !== 'default') metadata.resolution = resolution;
  if (seed >= 0) metadata.seed = seed;
  const payload = { model, seconds, metadata };
  if (prompt) payload.prompt = prompt;
  if (selectedSources.length) payload.images = await uploadViduImages(selectedSources, apiKey, options);
  return { payload, model, taskType };
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
  const response = await fetchProviderResponse(fetchImpl, `${baseUrl}/v1/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(built.payload),
  }, options, 'seedance.nz Happy Horse 任务提交');
  const data = await responseJson(response, 'seedance.nz Happy Horse 任务提交');
  if (!response.ok) throw createUpstreamError(data, response);
  const taskId = requiredTaskId(data?.id || data?.task_id || data?.data?.id, 'seedance.nz Happy Horse 任务提交', response);
  return { taskId, model: built.model, taskType: built.taskType, ...safeProviderTrace(response, data, { pollCount: 0 }) };
}

async function submitHailuoTask(request, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const built = await buildHailuoPayload(request, apiKey, options);
  const response = await fetchProviderResponse(fetchImpl, `${baseUrl}/v1/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(built.payload),
  }, options, 'seedance.nz Hailuo 2.3 任务提交');
  const data = await responseJson(response, 'seedance.nz Hailuo 2.3 任务提交');
  if (!response.ok) throw createUpstreamError(data, response);
  const taskId = requiredTaskId(data?.id || data?.task_id || data?.data?.id, 'seedance.nz Hailuo 2.3 任务提交', response);
  return { taskId, model: built.model, taskType: built.taskType, ...safeProviderTrace(response, data, { pollCount: 0 }) };
}

async function submitKlingTask(request, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const built = await buildKlingPayload(request, apiKey, options);
  const response = await fetchProviderResponse(fetchImpl, `${baseUrl}/v1/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(built.payload),
  }, options, 'seedance.nz Kling 任务提交');
  const data = await responseJson(response, 'seedance.nz Kling 任务提交');
  if (!response.ok) throw createUpstreamError(data, response);
  const taskId = requiredTaskId(data?.id || data?.task_id || data?.data?.id, 'seedance.nz Kling 任务提交', response);
  return { taskId, model: built.model, taskType: built.taskType, ...safeProviderTrace(response, data, { pollCount: 0 }) };
}

async function submitUpscalerTask(request, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const built = await buildUpscalerPayload(request, apiKey, options);
  const response = await fetchProviderResponse(fetchImpl, `${baseUrl}/v1/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(built.payload),
  }, options, 'seedance.nz Zhenzhen Upscaler 任务提交');
  const data = await responseJson(response, 'seedance.nz Zhenzhen Upscaler 任务提交');
  if (!response.ok) throw createUpstreamError(data, response);
  const taskId = requiredTaskId(data?.id || data?.task_id || data?.data?.id, 'seedance.nz Zhenzhen Upscaler 任务提交', response);
  return { taskId, model: built.model, taskType: built.taskType, ...safeProviderTrace(response, data, { pollCount: 0 }) };
}

async function submitViduTask(request, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const built = await buildViduPayload(request, apiKey, options);
  const response = await fetchProviderResponse(fetchImpl, `${baseUrl}/v1/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(built.payload),
  }, options, 'seedance.nz Vidu Q3 任务提交');
  const data = await responseJson(response, 'seedance.nz Vidu Q3 任务提交');
  if (!response.ok) throw createUpstreamError(data, response);
  const taskId = requiredTaskId(data?.id || data?.task_id || data?.data?.id, 'seedance.nz Vidu Q3 任务提交', response);
  return { taskId, model: built.model, taskType: built.taskType, ...safeProviderTrace(response, data, { pollCount: 0 }) };
}

async function submitWanTask(request, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const built = await buildWanPayload(request, apiKey, options);
  const response = await fetchProviderResponse(fetchImpl, `${baseUrl}/v1/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(built.payload),
  }, options, 'seedance.nz Wan 2.7 Spicy 任务提交');
  const data = await responseJson(response, 'seedance.nz Wan 2.7 Spicy 任务提交');
  if (!response.ok) throw createUpstreamError(data, response);
  const taskId = requiredTaskId(data?.id || data?.task_id || data?.data?.id, 'seedance.nz Wan 2.7 Spicy 任务提交', response);
  return { taskId, model: built.model, taskType: built.taskType, ...safeProviderTrace(response, data, { pollCount: 0 }) };
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
  const response = await fetchProviderResponse(fetchImpl, `${baseUrl}/v1/audio/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(built.payload),
  }, options, 'seedance.nz Seed Audio 任务提交');
  const data = await responseJson(response, 'seedance.nz Seed Audio 任务提交');
  if (!response.ok) throw createUpstreamError(data, response);
  const taskId = requiredTaskId(data?.task_id || data?.id || data?.data?.task_id, 'seedance.nz Seed Audio 任务提交', response);
  return { taskId, model: built.model, ...safeProviderTrace(response, data, { pollCount: 0 }) };
}

async function queryAudioTask(taskId, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('缺少贞贞的平价AI工坊（国内） API Key');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const response = await fetchProviderResponse(fetchImpl, `${baseUrl}/v1/audio/generations/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, options, 'seedance.nz Seed Audio 任务查询');
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
    progress: safeProgress(record?.progress ?? data?.progress),
    audioUrl: audioUrl || null,
    failReason: status === 'failed' ? 'Seed Audio 任务失败' : null,
    ...safeProviderTrace(response, data),
  };
}

async function submitImageTask(request, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const built = await buildImagePayload(request, apiKey, options);
  const response = await fetchProviderResponse(fetchImpl, `${baseUrl}/v1/image/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(built.payload),
  }, options, 'seedance.nz 图像任务提交');
  const data = await responseJson(response, 'seedance.nz 图像任务提交');
  if (!response.ok) throw createUpstreamError(data, response);
  const taskId = requiredTaskId(
    data?.task_id || data?.id || data?.data?.task_id || data?.data?.id,
    'seedance.nz 图像任务提交',
    response,
  );
  return { taskId, model: built.model, taskType: built.taskType, ...safeProviderTrace(response, data, { pollCount: 0 }) };
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
  const response = await fetchProviderResponse(fetchImpl, `${baseUrl}/v1/image/generations/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, options, 'seedance.nz 图像任务查询');
  const data = await responseJson(response, 'seedance.nz 图像任务查询');
  if (!response.ok) throw createUpstreamError(data, response);
  const record = data?.data && typeof data.data === 'object' ? data.data : data;
  const status = normalizeImageTaskStatus(record?.status || data?.status);
  const nested = record?.data && typeof record.data === 'object' ? record.data : {};
  const imageUrl = status === 'succeeded'
    ? String(record?.result_url || record?.resultUrl || nested?.content?.image_url || nested?.content?.imageUrl || '').trim()
    : '';
  return {
    status,
    progress: safeProgress(record?.progress ?? data?.progress),
    imageUrl: imageUrl || null,
    failReason: status === 'failed' ? '图像任务失败' : null,
    ...safeProviderTrace(response, data),
  };
}

async function submitTask(request, apiKey, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('请先在 API 设置中填写“贞贞的平价AI工坊（国内） API Key”');
  const fetchImpl = getFetchImpl(options);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const built = await buildPayload(request, apiKey, options);
  const response = await fetchProviderResponse(fetchImpl, `${baseUrl}/v1/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(built.payload),
  }, options, 'seedance.nz 任务提交');
  const data = await responseJson(response, 'seedance.nz 任务提交');
  if (!response.ok) throw createUpstreamError(data, response);
  const taskId = requiredTaskId(data?.id || data?.task_id || data?.data?.id, 'seedance.nz 任务提交', response);
  return { taskId, taskType: built.taskType, model: built.model, ...safeProviderTrace(response, data, { pollCount: 0 }) };
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
  const response = await fetchProviderResponse(fetchImpl, `${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, options, 'seedance.nz 任务查询');
  const data = await responseJson(response, 'seedance.nz 任务查询');
  if (!response.ok) throw createUpstreamError(data, response);
  const status = normalizeStatus(data?.status || data?.data?.status);
  const metadata = data?.metadata || data?.data?.metadata || {};
  return {
    status,
    progress: safeProgress(data?.progress ?? data?.data?.progress),
    videoUrl: status === 'succeeded'
      ? String(metadata?.url || data?.url || data?.data?.url || '').trim() || null
      : null,
    failReason: status === 'failed' ? 'Seedance 任务失败' : null,
    ...safeProviderTrace(response, data),
  };
}

function resetCachesForTests() {
  uploadCache.clear();
  uploadQueues.clear();
}

module.exports = {
  BASE_URL,
  HAILUO23_I2V_MODELS,
  HAILUO23_MODELS,
  HAILUO23_RESOLUTIONS,
  HAILUO23_SECONDS,
  HAILUO23_T2V_MODELS,
  KLING_EDIT_MODELS,
  KLING_I2V_MODELS,
  KLING_MODELS,
  KLING_R2V_MODELS,
  KLING_SECONDS,
  KLING_T2V_MODELS,
  KLING_VIDEO_MODELS,
  VIDU_Q3_I2V_MODELS,
  VIDU_Q3_MODELS,
  VIDU_Q3_R2V_MODELS,
  VIDU_Q3_RESOLUTIONS,
  VIDU_Q3_SECONDS,
  VIDU_Q3_SHORT_PLAY_MODELS,
  VIDU_Q3_START_END_MODELS,
  VIDU_Q3_T2V_MODELS,
  VIDU_Q3_VIDEO_MODELS,
  HAPPYHORSE_MODELS,
  HAPPYHORSE_RESOLUTIONS,
  IMAGE_MODEL_PAIRS,
  IMAGE_MODELS,
  IMAGE_RESOLUTIONS,
  ZHENZHEN_IMAGE_G2_I2I_MODEL,
  ZHENZHEN_IMAGE_G2_MODELS,
  ZHENZHEN_IMAGE_G2_RATIOS,
  ZHENZHEN_IMAGE_G2_T2I_MODEL,
  ZHENZHEN_UPSCALER_MODEL,
  ZHENZHEN_UPSCALER_RESOLUTIONS,
  PROVIDER_ID,
  RATIOS,
  RESOLUTIONS,
  SEED_AUDIO_FORMATS,
  SEED_AUDIO_MODEL,
  SEED_AUDIO_SAMPLE_RATES,
  WAN27_SPICY_MODEL,
  WAN27_SPICY_RESOLUTIONS,
  buildAudioPayload,
  buildHailuoPayload,
  buildKlingPayload,
  buildUpscalerPayload,
  buildViduPayload,
  buildHappyHorsePayload,
  buildWanPayload,
  buildPayload,
  buildImagePayload,
  buildZhenzhenImageG2Payload,
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
  submitHailuoTask,
  submitKlingTask,
  submitUpscalerTask,
  submitViduTask,
  submitHappyHorseTask,
  submitImageTask,
  submitTask,
  submitWanTask,
  uploadMedia,
};
