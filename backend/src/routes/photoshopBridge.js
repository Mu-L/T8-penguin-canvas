'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const settingsRouter = require('./settings');
const { maskAdvancedProviders, normalizeAdvancedProviders } = require('../providers/registry');
const { generateImageWithProvider } = require('../providers/adapters');

const router = express.Router();

const PHOTOSHOP_MESSAGE_TYPE = 't8:photoshop-result';
const PHOTOSHOP_MESSAGE_SOURCE = 'photoshop-uxp';
const PHOTOSHOP_COMMAND_TYPE = 't8:photoshop-command';
const PHOTOSHOP_COMMAND_SOURCE = 't8-canvas';
const MAX_QUEUE_SIZE = 120;
const MAX_COMMAND_QUEUE_SIZE = 120;
const MAX_SEEN_IDS = 360;
const MESSAGE_LEASE_MS = 45 * 1000;
const MAX_MESSAGE_ATTEMPTS = 3;
const COMMAND_LEASE_MS = 45 * 1000;
const MAX_COMMAND_ATTEMPTS = 3;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif)(?:$|[?#])/i;
const OUTPUT_EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
};

let queue = [];
let commandQueue = [];
let messageInFlight = new Map();
let commandInFlight = new Map();
let seenMessageIds = [];

function cleanText(value, maxLen = 8000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function cleanUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^(https?:\/\/|data:image\/|\/files\/|\/output\/|\/input\/|\/api\/resources\/)/i.test(text)) return text.slice(0, 4096);
  return '';
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function requestHost(req) {
  const headerHost = cleanText(typeof req.get === 'function' ? req.get('host') : '', 200);
  return headerHost || `${config.HOST || '127.0.0.1'}:${config.PORT}`;
}

function requestHostname(req) {
  const host = requestHost(req);
  const ipv6 = host.match(/^\[([^\]]+)\]/);
  if (ipv6) return ipv6[1];
  return host.split(':')[0] || '127.0.0.1';
}

function backendUrlForRequest(req) {
  return `http://${requestHost(req)}`;
}

function frontendUrlForRequest(req) {
  const explicit = trimTrailingSlash(process.env.T8PC_FRONTEND_URL || process.env.T8_FRONTEND_URL);
  if (/^https?:\/\/[^/]+/i.test(explicit)) return explicit;
  if (config.IS_PACKAGED) return backendUrlForRequest(req);
  const port = Number(process.env.T8_DEV_FRONTEND_PORT || process.env.VITE_PORT || 11422) || 11422;
  return `http://${requestHostname(req)}:${port}`;
}

function cleanMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/api|key|token|secret|password|credential|cookie/i.test(key)) continue;
    if (raw == null) continue;
    if (typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = raw;
    } else {
      out[key] = cleanText(raw, 500);
    }
  }
  return out;
}

function pushUniqueUrl(out, value) {
  if (Array.isArray(value)) {
    value.forEach((item) => pushUniqueUrl(out, item));
    return;
  }
  const raw = value && typeof value === 'object'
    ? value.url || value.imageUrl || value.resultUrl || value.outputUrl
    : value;
  const url = cleanUrl(raw);
  if (url && !out.includes(url)) out.push(url);
}

function collectUrls(...values) {
  const out = [];
  values.forEach((value) => pushUniqueUrl(out, value));
  return out.slice(0, 48);
}

function rememberMessageId(messageId) {
  if (!messageId) return;
  seenMessageIds.push(messageId);
  if (seenMessageIds.length > MAX_SEEN_IDS) {
    seenMessageIds = seenMessageIds.slice(-Math.floor(MAX_SEEN_IDS / 2));
  }
}

function normalizeMessage(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : raw;
  const imageUrls = collectUrls(payload.imageUrls, payload.images, payload.imageUrl, payload.url, payload.resultUrl);
  const prompt = cleanText(payload.prompt || payload.text || payload.outputText);
  if (imageUrls.length === 0 && !prompt) return null;

  const messageId = cleanText(
    payload.messageId || raw.messageId || `photoshop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    180,
  );
  const mode = cleanText(payload.mode || payload.exportMode || 'image', 80) || 'image';
  return {
    type: PHOTOSHOP_MESSAGE_TYPE,
    source: PHOTOSHOP_MESSAGE_SOURCE,
    receivedAt: new Date().toISOString(),
    payload: {
      messageId,
      mode,
      prompt,
      imageUrls,
      images: imageUrls,
      documentName: cleanText(payload.documentName || payload.document || payload.docName, 240),
      layerName: cleanText(payload.layerName || payload.layer, 240),
      source: 'photoshop',
      createdAt: Number(payload.createdAt) || Date.now(),
      metadata: {
        ...cleanMetadata(payload.metadata),
        sentVia: 'photoshop-uxp-local-bridge',
      },
    },
  };
}

function enqueueMessage(message) {
  const messageId = message.payload.messageId;
  if (
    seenMessageIds.includes(messageId) ||
    queue.some((item) => item.payload.messageId === messageId) ||
    messageInFlight.has(messageId)
  ) {
    return { messageId, queued: false, duplicate: true, queueSize: queue.length };
  }
  queue.push(message);
  rememberMessageId(messageId);
  if (queue.length > MAX_QUEUE_SIZE) {
    queue = queue.slice(-MAX_QUEUE_SIZE);
  }
  return { messageId, queued: true, duplicate: false, queueSize: queue.length };
}

function removeQueuedMessage(messageId) {
  const before = queue.length;
  queue = queue.filter((item) => item.payload.messageId !== messageId);
  return before - queue.length;
}

function releaseExpiredMessages() {
  const now = Date.now();
  const expired = [];
  for (const [messageId, entry] of messageInFlight.entries()) {
    if (now - entry.claimedAt < MESSAGE_LEASE_MS) continue;
    messageInFlight.delete(messageId);
    const message = entry.message;
    if ((message.attempts || 0) < MAX_MESSAGE_ATTEMPTS) {
      expired.push(message);
    }
  }
  if (expired.length > 0) {
    queue = [...expired, ...queue].slice(0, MAX_QUEUE_SIZE);
  }
  return expired.length;
}

function cleanTags(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => cleanText(item, 60))
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeCanvasMaterials(raw) {
  const items = Array.isArray(raw) ? raw : [];
  const out = [];
  let skipped = 0;
  const seen = new Set();
  items.forEach((item, index) => {
    const kind = cleanText(item?.kind, 30).toLowerCase();
    const url = cleanUrl(item?.url || item?.imageUrl);
    if (kind !== 'image' || !url) {
      skipped += 1;
      return;
    }
    if (seen.has(url)) return;
    seen.add(url);
    out.push({
      id: cleanText(item?.id || `image-${index + 1}`, 120),
      kind: 'image',
      url,
      name: cleanText(item?.name || fileNameFromUrl(url), 240),
      mime: cleanText(item?.mime, 100),
      size: Number(item?.size) || 0,
    });
  });
  return { materials: out.slice(0, 48), skipped };
}

function fileNameFromUrl(url) {
  try {
    const clean = String(url || '').split('?')[0].split('#')[0];
    return decodeURIComponent(clean.split('/').pop() || 'image');
  } catch {
    return String(url || '').split('/').pop() || 'image';
  }
}

function enqueueCommand(command) {
  commandQueue.push(command);
  if (commandQueue.length > MAX_COMMAND_QUEUE_SIZE) {
    commandQueue = commandQueue.slice(-MAX_COMMAND_QUEUE_SIZE);
  }
  return {
    commandId: command.commandId,
    queued: true,
    queueSize: commandQueue.length,
  };
}

function removeQueuedCommand(commandId) {
  const before = commandQueue.length;
  commandQueue = commandQueue.filter((item) => item.commandId !== commandId);
  return before - commandQueue.length;
}

function releaseExpiredCommands() {
  const now = Date.now();
  const expired = [];
  for (const [commandId, entry] of commandInFlight.entries()) {
    if (now - entry.claimedAt < COMMAND_LEASE_MS) continue;
    commandInFlight.delete(commandId);
    const command = entry.command;
    if ((command.attempts || 0) < MAX_COMMAND_ATTEMPTS) {
      expired.push(command);
    }
  }
  if (expired.length > 0) {
    commandQueue = [...expired, ...commandQueue].slice(0, MAX_COMMAND_QUEUE_SIZE);
  }
  return expired.length;
}

function safeFilename(value, fallback = 'photoshop') {
  const clean = String(value || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .replace(/[._-]+$/, '')
    .slice(0, 80);
  return clean || fallback;
}

function extFromMime(mime, fallback = '.png') {
  return OUTPUT_EXT_BY_MIME[String(mime || '').toLowerCase().split(';')[0]] || fallback;
}

function parseDataUrl(input, mimeHint = 'image/png') {
  const text = String(input || '').trim();
  const dataUrl = text.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (dataUrl) {
    return {
      mime: dataUrl[1].toLowerCase(),
      buffer: Buffer.from(dataUrl[2], 'base64'),
    };
  }
  return {
    mime: String(mimeHint || 'image/png').toLowerCase(),
    buffer: Buffer.from(text, 'base64'),
  };
}

function writeOutputImage(buffer, options = {}) {
  if (!buffer || !buffer.length) throw new Error('图像内容为空');
  if (!fs.existsSync(config.OUTPUT_DIR)) fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  const mime = String(options.mime || 'image/png').toLowerCase().split(';')[0];
  const ext = extFromMime(mime, '.png');
  const prefix = safeFilename(options.prefix || options.name || 'photoshop', 'photoshop');
  const suffix = crypto.randomBytes(4).toString('hex');
  const filename = `${prefix}_${Date.now()}_${suffix}${ext}`;
  fs.writeFileSync(path.join(config.OUTPUT_DIR, filename), buffer);
  return {
    filename,
    url: `/files/output/${filename}`,
    size: buffer.length,
    mime,
  };
}

function fileItemFromDir(dir, mount, filename) {
  if (!IMAGE_EXT_RE.test(filename)) return null;
  const fp = path.join(dir, filename);
  let stat;
  try {
    stat = fs.statSync(fp);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return {
    id: `${mount}:${filename}`,
    source: mount,
    kind: 'image',
    name: filename,
    url: `/files/${mount}/${encodeURIComponent(filename)}`,
    size: stat.size,
    updatedAt: stat.mtimeMs,
  };
}

function outputItems(limit = 80) {
  if (!fs.existsSync(config.OUTPUT_DIR)) return [];
  return fs.readdirSync(config.OUTPUT_DIR)
    .map((filename) => fileItemFromDir(config.OUTPUT_DIR, 'output', filename))
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

function inputItems(limit = 80) {
  if (!fs.existsSync(config.INPUT_DIR)) return [];
  return fs.readdirSync(config.INPUT_DIR)
    .map((filename) => fileItemFromDir(config.INPUT_DIR, 'input', filename))
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

function resourceRootFromSettings(settings) {
  return String(settings.resourceLibraryPath || config.DEFAULT_RESOURCE_LIBRARY_DIR || '').trim();
}

function resourceItems(settings, limit = 160) {
  try {
    const root = resourceRootFromSettings(settings);
    const dbPath = path.join(root, 'resource_library.json');
    if (!root || !fs.existsSync(dbPath)) return [];
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const categories = new Map(
      (Array.isArray(db.categories) ? db.categories : [])
        .filter((cat) => cat && cat.kind === 'image')
        .map((cat) => [cat.id, cat.name || '图像']),
    );
    return (Array.isArray(db.items) ? db.items : [])
      .filter((item) => item && item.kind === 'image')
      .map((item) => ({
        id: `resource:${item.id}`,
        source: 'resources',
        kind: 'image',
        name: item.title || item.originalName || item.id,
        categoryId: item.categoryId || '',
        categoryName: categories.get(item.categoryId) || '',
        url: `/api/resources/file/${encodeURIComponent(item.id)}`,
        thumbUrl: item.thumbRel ? `/api/resources/thumb/${encodeURIComponent(item.id)}` : '',
        size: Number(item.size) || 0,
        updatedAt: Number(item.updatedAt || item.createdAt) || 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function safeProviderForResponse(provider) {
  const masked = maskAdvancedProviders([provider]);
  const id = String(provider?.id || '').trim();
  const protocol = String(provider?.protocol || '').trim();
  return masked.find((item) => item.id === id && item.protocol === protocol) || masked[0] || null;
}

function imageProviders(settings) {
  const providers = normalizeAdvancedProviders(settings.advancedProviders);
  return providers
    .filter((provider) => provider.enabled && Array.isArray(provider.imageModels) && provider.imageModels.length > 0)
    .map((provider) => safeProviderForResponse(provider))
    .filter(Boolean);
}

function resolveProvider(body, providers) {
  const providerId = cleanText(body?.providerId || body?.provider_id, 120);
  if (providerId) return providers.find((provider) => provider.id === providerId) || null;
  return providers.find((provider) => provider.enabled && provider.imageModels?.length) || null;
}

function outputExtFromMime(mime, fallback = '.png') {
  return extFromMime(mime, fallback);
}

function outputExtFromUrl(url, fallback = '.png') {
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'].includes(ext)) return ext;
  } catch {
    // ignore
  }
  return fallback;
}

function writeOutputBuffer(buffer, ext) {
  if (!fs.existsSync(config.OUTPUT_DIR)) fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  const suffix = crypto.randomBytes(4).toString('hex');
  const filename = `ps_external_${Date.now()}_${suffix}${ext || '.png'}`;
  fs.writeFileSync(path.join(config.OUTPUT_DIR, filename), buffer);
  return `/files/output/${filename}`;
}

async function saveOneMediaOutput(url, options = {}) {
  const text = String(url || '').trim();
  if (!text) return '';
  const dataMatch = text.match(/^data:([^;,]+);base64,(.+)$/i);
  if (dataMatch) {
    const ext = outputExtFromMime(dataMatch[1], '.png');
    return writeOutputBuffer(Buffer.from(dataMatch[2], 'base64'), ext);
  }
  if (/^https?:\/\//i.test(text)) {
    const fetchImpl = options.fetchImpl || fetch;
    const res = await fetchImpl(text);
    if (!res.ok) throw new Error(`下载 Photoshop 生成输出失败：HTTP ${res.status}`);
    const mime = typeof res.headers?.get === 'function' ? res.headers.get('content-type') : '';
    const ext = outputExtFromMime(mime, outputExtFromUrl(text, '.png'));
    const buf = Buffer.from(await res.arrayBuffer());
    return writeOutputBuffer(buf, ext);
  }
  if (text.startsWith('/files/output/')) return text;
  return text;
}

async function saveImageOutputs(urls, options = {}) {
  const out = [];
  for (const url of Array.isArray(urls) ? urls : []) {
    const saved = await saveOneMediaOutput(url, options);
    if (saved) out.push(saved);
  }
  return out;
}

function generationTimeoutMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 60 * 60 * 1000;
  return Math.max(60 * 60 * 1000, Math.round(n));
}

router.get('/status', (req, res) => {
  const frontendUrl = frontendUrlForRequest(req);
  res.json({
    success: true,
    data: {
      ok: true,
      service: 't8-photoshop-bridge',
      backendUrl: backendUrlForRequest(req),
      frontendUrl,
      canvasUrl: frontendUrl,
      messageType: PHOTOSHOP_MESSAGE_TYPE,
      messageSource: PHOTOSHOP_MESSAGE_SOURCE,
      queueSize: queue.length,
      messageInFlightSize: messageInFlight.size,
      commandType: PHOTOSHOP_COMMAND_TYPE,
      commandSource: PHOTOSHOP_COMMAND_SOURCE,
      commandQueueSize: commandQueue.length,
      commandInFlightSize: commandInFlight.size,
      version: config.APP_VERSION,
    },
  });
});

router.get('/library', (req, res) => {
  const settings = settingsRouter.loadSettings({ persistMigrations: false });
  const limit = Math.max(10, Math.min(300, Number(req.query.limit || 120) || 120));
  const sections = [
    { id: 'outputs', label: '最近输出', items: outputItems(limit) },
    { id: 'inputs', label: '上传素材', items: inputItems(limit) },
    { id: 'resources', label: '资源库图像', items: resourceItems(settings, limit) },
  ];
  res.json({ success: true, data: { sections } });
});

router.get('/image-providers', (_req, res) => {
  const settings = settingsRouter.loadSettings({ persistMigrations: false });
  const providers = imageProviders(settings);
  res.json({ success: true, data: { providers } });
});

router.post('/upload-base64', express.json({ limit: '120mb' }), (req, res) => {
  try {
    const body = req.body || {};
    const raw = body.dataUrl || body.data || body.b64 || body.b64_json;
    if (!raw || typeof raw !== 'string') {
      return res.status(400).json({ success: false, code: 'missing_image_data', error: '缺少 Photoshop 导出的图像数据。' });
    }
    const parsed = parseDataUrl(raw, body.mime || body.content_type || 'image/png');
    const saved = writeOutputImage(parsed.buffer, {
      mime: parsed.mime,
      prefix: body.prefix || body.name || body.fileName || 'photoshop',
    });
    if (body.queue !== false) {
      const normalized = normalizeMessage({
        payload: {
          messageId: body.messageId || `ps-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          mode: body.mode || 'upload',
          prompt: body.prompt,
          imageUrls: [saved.url],
          documentName: body.documentName,
          layerName: body.layerName,
          metadata: body.metadata,
        },
      });
      if (normalized) enqueueMessage(normalized);
    }
    return res.json({ success: true, data: saved });
  } catch (e) {
    return res.status(500).json({ success: false, code: 'photoshop_upload_failed', error: e?.message || String(e) });
  }
});

router.post('/messages', (req, res) => {
  const normalized = normalizeMessage(req.body || {});
  if (!normalized) {
    return res.status(400).json({
      success: false,
      code: 'empty_photoshop_result',
      error: '没有发现可发送到画布的 Photoshop 图像或提示词。',
    });
  }
  return res.json({ success: true, data: enqueueMessage(normalized) });
});

router.get('/pending', (req, res) => {
  const released = releaseExpiredMessages();
  const limit = Math.max(1, Math.min(36, Number(req.query.limit || 12) || 12));
  const messages = [];
  while (messages.length < limit && queue.length > 0) {
    const message = queue.shift();
    if (!message) continue;
    const messageId = message.payload?.messageId;
    if (!messageId) continue;
    const claimed = {
      ...message,
      attempts: (message.attempts || 0) + 1,
      claimedAt: new Date().toISOString(),
    };
    messageInFlight.set(messageId, { message: claimed, claimedAt: Date.now() });
    messages.push(claimed);
  }
  res.json({
    success: true,
    data: {
      messages,
      remaining: queue.length,
      inFlight: messageInFlight.size,
      released,
    },
  });
});

router.post('/messages/:messageId/complete', (req, res) => {
  const messageId = cleanText(req.params.messageId, 180);
  const hadInFlight = messageInFlight.delete(messageId);
  const removedQueued = removeQueuedMessage(messageId);
  res.json({
    success: true,
    data: {
      messageId,
      completed: hadInFlight || removedQueued > 0,
      imported: req.body?.imported !== false,
      remaining: queue.length,
      inFlight: messageInFlight.size,
    },
  });
});

router.post('/messages/:messageId/fail', (req, res) => {
  const messageId = cleanText(req.params.messageId, 180);
  const entry = messageInFlight.get(messageId);
  if (!entry) {
    return res.json({
      success: true,
      data: { messageId, requeued: false, missing: true, remaining: queue.length, inFlight: messageInFlight.size },
    });
  }
  messageInFlight.delete(messageId);
  const message = {
    ...entry.message,
    lastError: cleanText(req.body?.error, 500),
    failedAt: new Date().toISOString(),
  };
  const attempts = Number(message.attempts || 0);
  const requeued = attempts < MAX_MESSAGE_ATTEMPTS;
  if (requeued) {
    queue.unshift(message);
    if (queue.length > MAX_QUEUE_SIZE) queue = queue.slice(0, MAX_QUEUE_SIZE);
  }
  return res.json({
    success: true,
    data: {
      messageId,
      requeued,
      attempts,
      remaining: queue.length,
      inFlight: messageInFlight.size,
    },
  });
});

router.post('/send-to-photoshop', (req, res) => {
  const { materials, skipped } = normalizeCanvasMaterials(req.body?.materials);
  if (materials.length === 0) {
    return res.status(400).json({
      success: false,
      code: 'no_photoshop_image_materials',
      error: '没有可发送到 Photoshop 的图像素材。',
      data: { skipped },
    });
  }
  const commandId = cleanText(
    req.body?.commandId || `ps-place-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    180,
  );
  const command = {
    type: PHOTOSHOP_COMMAND_TYPE,
    source: PHOTOSHOP_COMMAND_SOURCE,
    command: 'place-materials',
    commandId,
    createdAt: new Date().toISOString(),
    payload: {
      commandId,
      action: 'place-materials',
      materials,
      tags: cleanTags(req.body?.tags),
      sourceCanvasId: cleanText(req.body?.sourceCanvasId, 120),
      sourceLabel: cleanText(req.body?.sourceLabel || 'T8 画布', 120),
    },
  };
  const queued = enqueueCommand(command);
  res.json({
    success: true,
    data: {
      ...queued,
      sent: materials.length,
      skipped,
    },
  });
});

router.get('/commands/pending', (req, res) => {
  const released = releaseExpiredCommands();
  const limit = Math.max(1, Math.min(24, Number(req.query.limit || 6) || 6));
  const commands = [];
  while (commands.length < limit && commandQueue.length > 0) {
    const command = commandQueue.shift();
    if (!command) continue;
    const claimed = {
      ...command,
      attempts: (command.attempts || 0) + 1,
      claimedAt: new Date().toISOString(),
    };
    commandInFlight.set(claimed.commandId, { command: claimed, claimedAt: Date.now() });
    commands.push(claimed);
  }
  res.json({
    success: true,
    data: {
      commands,
      remaining: commandQueue.length,
      inFlight: commandInFlight.size,
      released,
    },
  });
});

router.post('/commands/:commandId/complete', (req, res) => {
  const commandId = cleanText(req.params.commandId, 180);
  const deleted = commandInFlight.delete(commandId);
  const removedQueued = removeQueuedCommand(commandId);
  res.json({
    success: true,
    data: {
      commandId,
      completed: deleted || removedQueued > 0,
      removedQueued,
      queueSize: commandQueue.length,
      inFlight: commandInFlight.size,
      placed: Number(req.body?.placed) || 0,
    },
  });
});

router.post('/commands/:commandId/fail', (req, res) => {
  const commandId = cleanText(req.params.commandId, 180);
  const entry = commandInFlight.get(commandId);
  let requeued = false;
  let attempts = 0;
  if (entry) {
    commandInFlight.delete(commandId);
    attempts = entry.command.attempts || 0;
    if (attempts < MAX_COMMAND_ATTEMPTS) {
      commandQueue.unshift({
        ...entry.command,
        lastError: cleanText(req.body?.error, 1000),
        failedAt: new Date().toISOString(),
      });
      requeued = true;
      if (commandQueue.length > MAX_COMMAND_QUEUE_SIZE) commandQueue = commandQueue.slice(0, MAX_COMMAND_QUEUE_SIZE);
    }
  }
  res.json({
    success: true,
    data: {
      commandId,
      requeued,
      attempts,
      queueSize: commandQueue.length,
      inFlight: commandInFlight.size,
    },
  });
});

router.post('/image', express.json({ limit: '80mb' }), async (req, res) => {
  try {
    const settings = settingsRouter.loadSettings({ persistMigrations: false });
    const providers = normalizeAdvancedProviders(settings.advancedProviders);
    const provider = resolveProvider(req.body || {}, providers);
    if (!provider) {
      return res.json({ success: false, code: 'provider_not_found', error: '未找到可用于 Photoshop 的图像扩展平台。' });
    }
    if (!provider.enabled) {
      return res.json({
        success: false,
        code: 'provider_disabled',
        error: '扩展平台未启用，请先在 T8 API 设置中启用。',
        data: { provider: safeProviderForResponse(provider) },
      });
    }
    const model = cleanText(req.body?.providerModel || req.body?.model || provider.defaults?.imageModel || provider.imageModels?.[0], 240);
    const prompt = cleanText(req.body?.prompt, 20000);
    if (!model) {
      return res.json({
        success: false,
        code: 'missing_model',
        error: '扩展平台未配置可用图像模型。',
        data: { provider: safeProviderForResponse(provider) },
      });
    }
    if (!prompt) {
      return res.json({
        success: false,
        code: 'missing_prompt',
        error: '请输入图像提示词。',
        data: { provider: safeProviderForResponse(provider) },
      });
    }
    const imageRefs = collectUrls(req.body?.images, req.body?.imageUrls, req.body?.referenceImages, req.body?.reference_images);
    const result = await generateImageWithProvider(provider, {
      ...req.body,
      providerId: provider.id,
      providerModel: model,
      model,
      prompt,
      images: imageRefs,
      referenceImages: imageRefs,
    }, {
      timeoutMs: generationTimeoutMs(req.body?.timeoutMs),
      baseUrl: `http://127.0.0.1:${config.PORT}`,
    });
    if (!result.ok) {
      return res.json({
        success: false,
        code: result.code,
        error: result.error,
        data: { ...result, provider: safeProviderForResponse(provider), imageUrls: [] },
      });
    }
    const remoteImageUrls = Array.isArray(result.imageUrls) ? result.imageUrls : [];
    const imageUrls = await saveImageOutputs(remoteImageUrls);
    const payload = {
      ...result,
      provider: safeProviderForResponse(provider),
      prompt,
      model,
      mode: imageRefs.length ? 'edit' : 'generate',
      source: 'photoshop-generate',
      referenceImages: imageRefs,
      remoteImageUrls,
      imageUrls,
    };

    let bridge = null;
    if (req.body?.syncToCanvas !== false) {
      const normalized = normalizeMessage({
        payload: {
          messageId: req.body?.messageId || `ps-generate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          mode: payload.mode,
          prompt,
          imageUrls,
          documentName: req.body?.documentName,
          layerName: req.body?.layerName,
          metadata: {
            providerId: provider.id,
            protocol: provider.protocol,
            model,
            referenceCount: imageRefs.length,
          },
        },
      });
      if (normalized) bridge = enqueueMessage(normalized);
    }
    return res.json({ success: true, code: 'completed', data: { ...payload, bridge } });
  } catch (e) {
    return res.status(500).json({
      success: false,
      code: 'photoshop_image_failed',
      error: e?.message || String(e),
    });
  }
});

module.exports = router;
