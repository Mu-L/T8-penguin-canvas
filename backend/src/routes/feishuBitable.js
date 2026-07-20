'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Blob } = require('buffer');
const config = require('../config');

const router = express.Router();

const DEFAULT_OPEN_API_BASE = 'https://open.feishu.cn';
const GLOBAL_OPEN_API_BASE = 'https://open.larksuite.com';
const PRIVATE_FILE = config.FEISHU_BITABLE_PRIVATE_FILE || path.join(config.DATA_DIR, 'feishu_bitable.private.json');
const TOKEN_SKEW_MS = 60 * 1000;
const MEDIA_UPLOAD_LIMIT = 20 * 1024 * 1024;

let tokenCache = {
  cacheKey: '',
  token: '',
  expiresAt: 0,
};

function safeText(value, fallback = '', limit = 4000) {
  return String(value || fallback).trim().slice(0, limit);
}

function safeFilename(value, fallback = 'feishu-media') {
  const cleaned = safeText(value, fallback, 180)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '');
  return cleaned || fallback;
}

function ensureDataDir() {
  if (!fs.existsSync(config.DATA_DIR)) fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

function resolveFeishuApiBase(rawValue) {
  const raw = safeText(rawValue || process.env.FEISHU_OPEN_API_BASE || DEFAULT_OPEN_API_BASE, DEFAULT_OPEN_API_BASE);
  const u = new URL(raw);
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.port || (host !== 'open.feishu.cn' && host !== 'open.larksuite.com')) {
    throw new Error('飞书多维表格只允许连接官方 Feishu/Lark OpenAPI');
  }
  return host === 'open.larksuite.com' ? GLOBAL_OPEN_API_BASE : DEFAULT_OPEN_API_BASE;
}

function maskOneSecret(value) {
  const raw = safeText(value, '', 240);
  if (!raw) return '';
  const underscore = raw.indexOf('_');
  const prefix = underscore >= 0 ? raw.slice(0, underscore + 1) : raw.slice(0, Math.min(4, raw.length));
  const tail = raw.length > 4 ? raw.slice(-4) : '';
  return `${prefix}****${tail}`;
}

function maskFeishuSettings(settings) {
  const appId = safeText(settings && settings.appId, '', 240);
  const appSecret = safeText(settings && settings.appSecret, '', 240);
  const apiBase = resolveFeishuApiBase(settings && settings.apiBase);
  return {
    apiBase,
    appId: maskOneSecret(appId),
    appSecret: maskOneSecret(appSecret),
    hasAppId: Boolean(appId),
    hasAppSecret: Boolean(appSecret),
  };
}

function readPrivateSettings() {
  try {
    if (!fs.existsSync(PRIVATE_FILE)) {
      return { apiBase: DEFAULT_OPEN_API_BASE, appId: '', appSecret: '' };
    }
    const raw = JSON.parse(fs.readFileSync(PRIVATE_FILE, 'utf-8'));
    return {
      apiBase: resolveFeishuApiBase(raw.apiBase || DEFAULT_OPEN_API_BASE),
      appId: safeText(raw.appId, '', 240),
      appSecret: safeText(raw.appSecret, '', 500),
    };
  } catch {
    return { apiBase: DEFAULT_OPEN_API_BASE, appId: '', appSecret: '' };
  }
}

function writePrivateSettings(patch) {
  ensureDataDir();
  const current = readPrivateSettings();
  const next = {
    apiBase: resolveFeishuApiBase(patch.apiBase || current.apiBase || DEFAULT_OPEN_API_BASE),
    appId: safeText(patch.appId ?? current.appId, '', 240),
    appSecret: safeText(patch.appSecret ?? current.appSecret, '', 500),
  };
  fs.writeFileSync(PRIVATE_FILE, JSON.stringify(next, null, 2), 'utf-8');
  tokenCache = { cacheKey: '', token: '', expiresAt: 0 };
  return next;
}

function resolveSettingsFromBody(body) {
  const saved = readPrivateSettings();
  return {
    apiBase: resolveFeishuApiBase(body?.apiBase || saved.apiBase || DEFAULT_OPEN_API_BASE),
    appId: safeText(body?.appId || saved.appId, '', 240),
    appSecret: safeText(body?.appSecret || saved.appSecret, '', 500),
  };
}

function requireCredentials(settings) {
  if (!settings.appId || !settings.appSecret) {
    throw new Error('请先配置飞书应用 App ID 和 App Secret');
  }
}

function buildOpenApiUrl(settings, endpoint) {
  const base = resolveFeishuApiBase(settings.apiBase);
  const pathPart = String(endpoint || '').startsWith('/') ? String(endpoint) : `/${endpoint}`;
  return `${base}${pathPart}`;
}

async function readJsonResponse(resp, label) {
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!resp.ok) {
    throw new Error(json?.msg || json?.message || json?.error || `${label} HTTP ${resp.status}`);
  }
  if (json && json.code !== undefined && json.code !== null) {
    const code = typeof json.code === 'string' ? json.code.trim() : json.code;
    if (!((typeof code === 'number' && code === 0) || (typeof code === 'string' && code === '0'))) {
      throw new Error(json.msg || json.message || `${label} code ${json.code}`);
    }
  }
  return json || {};
}

async function getTenantAccessToken(settings) {
  requireCredentials(settings);
  const apiBase = resolveFeishuApiBase(settings.apiBase);
  const cacheKey = `${apiBase}:${settings.appId}:${settings.appSecret}`;
  if (tokenCache.cacheKey === cacheKey && tokenCache.token && Date.now() < tokenCache.expiresAt - TOKEN_SKEW_MS) {
    return tokenCache.token;
  }
  const resp = await fetch(`${apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: settings.appId,
      app_secret: settings.appSecret,
    }),
  });
  const json = await readJsonResponse(resp, 'Feishu tenant_access_token');
  const token = safeText(json.tenant_access_token || json.data?.tenant_access_token, '', 4000);
  if (!token) throw new Error('Feishu 未返回 tenant_access_token');
  const expireSeconds = Number(json.expire || json.data?.expire || 7200);
  tokenCache = {
    cacheKey,
    token,
    expiresAt: Date.now() + Math.max(60, expireSeconds) * 1000,
  };
  return token;
}

async function feishuJson(settings, method, endpoint, body) {
  const token = await getTenantAccessToken(settings);
  const headers = {
    Authorization: `Bearer ${token}`,
  };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(buildOpenApiUrl(settings, endpoint), init);
  const json = await readJsonResponse(resp, `Feishu ${method} ${endpoint}`);
  return json.data || {};
}

function assertInside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (t === r || t.startsWith(r + path.sep)) return t;
  throw new Error('路径越界');
}

function normalizeLocalPathname(value) {
  const raw = safeText(value, '', 4000);
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return '';
      return decodeURIComponent(u.pathname || '');
    } catch {
      return '';
    }
  }
  return raw.split(/[?#]/)[0];
}

function resolveKnownLocalFile(url) {
  const clean = normalizeLocalPathname(url);
  if (!clean) return null;
  const decodeTail = (prefix) => decodeURIComponent(clean.slice(prefix.length)).replace(/^[/\\]+/, '');
  if (clean.startsWith('/files/output/')) {
    return assertInside(config.OUTPUT_DIR, path.join(config.OUTPUT_DIR, decodeTail('/files/output/')));
  }
  if (clean.startsWith('/output/')) {
    return assertInside(config.OUTPUT_DIR, path.join(config.OUTPUT_DIR, decodeTail('/output/')));
  }
  if (clean.startsWith('/files/input/')) {
    return assertInside(config.INPUT_DIR, path.join(config.INPUT_DIR, decodeTail('/files/input/')));
  }
  if (clean.startsWith('/input/')) {
    return assertInside(config.INPUT_DIR, path.join(config.INPUT_DIR, decodeTail('/input/')));
  }
  return null;
}

function resolveAllowedAttachmentFile(value) {
  const clean = normalizeLocalPathname(value);
  if (!clean) return null;
  const known = resolveKnownLocalFile(clean);
  if (known) return known;
  const absolute = path.resolve(clean);
  try {
    return assertInside(config.INPUT_DIR, absolute);
  } catch {
    // Continue checking output.
  }
  try {
    return assertInside(config.OUTPUT_DIR, absolute);
  } catch {
    return null;
  }
}

function normalizeAppToken(value) {
  const token = safeText(value, '', 240);
  if (!token) throw new Error('缺少 appToken');
  return token;
}

function normalizeTableId(value) {
  const tableId = safeText(value, '', 240);
  if (!tableId) throw new Error('缺少 tableId');
  return tableId;
}

function isAttachmentPlaceholder(value) {
  return value && typeof value === 'object' && (
    value.file_token || value.fileToken || value.url || value.path
  );
}

async function uploadMediaFile(settings, appToken, filePath, displayName) {
  const localPath = path.resolve(filePath);
  if (!fs.existsSync(localPath)) throw new Error(`附件文件不存在: ${localPath}`);
  const stat = fs.statSync(localPath);
  if (!stat.isFile()) throw new Error(`附件不是文件: ${localPath}`);
  if (stat.size > MEDIA_UPLOAD_LIMIT) {
    throw new Error('飞书 upload_all 单文件上限为 20MB，请压缩或改用云端文件链接字段');
  }
  const token = await getTenantAccessToken(settings);
  const fileName = safeText(displayName || path.basename(localPath), path.basename(localPath), 240);
  const buffer = fs.readFileSync(localPath);
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'bitable_file');
  form.append('parent_node', appToken);
  form.append('size', String(stat.size));
  form.append('file', new Blob([buffer], { type: 'application/octet-stream' }), fileName);

  const resp = await fetch(buildOpenApiUrl(settings, '/open-apis/drive/v1/medias/upload_all'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = await readJsonResponse(resp, 'Feishu media upload_all');
  const fileToken = safeText(json.data?.file_token || json.file_token, '', 1000);
  if (!fileToken) throw new Error('飞书附件上传未返回 file_token');
  return fileToken;
}

async function downloadMediaFile(settings, fileToken, displayName) {
  const token = await getTenantAccessToken(settings);
  const cleanToken = safeText(fileToken, '', 1000);
  if (!cleanToken) throw new Error('缺少 fileToken');
  const resp = await fetch(buildOpenApiUrl(
    settings,
    `/open-apis/drive/v1/medias/${encodeURIComponent(cleanToken)}/download`,
  ), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    let message = `Feishu media download HTTP ${resp.status}`;
    try {
      const text = await resp.text();
      const json = text ? JSON.parse(text) : null;
      message = json?.msg || json?.message || json?.error || message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  const dir = assertInside(config.INPUT_DIR, path.join(config.INPUT_DIR, 'feishu-bitable'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeFilename(displayName || cleanToken)}`;
  const filePath = assertInside(dir, path.join(dir, fileName));
  fs.writeFileSync(filePath, buffer);
  return {
    name: fileName,
    path: filePath,
    url: `/files/input/feishu-bitable/${encodeURIComponent(fileName)}`,
    size: buffer.length,
    contentType: resp.headers.get('content-type') || '',
  };
}

async function normalizeAttachmentValue(settings, appToken, item) {
  if (!item || typeof item !== 'object') return null;
  const existing = safeText(item.file_token || item.fileToken, '', 1000);
  if (existing) return { file_token: existing };
  const rawPath = safeText(item.path || '', '', 4000);
  const rawUrl = safeText(item.url || '', '', 4000);
  const localPath = resolveAllowedAttachmentFile(rawPath) || resolveAllowedAttachmentFile(rawUrl);
  if (!localPath) {
    throw new Error('飞书附件写回只允许上传 T8 本地 input/output 文件，不能把远端 URL 直接写入附件字段');
  }
  const fileToken = await uploadMediaFile(settings, appToken, localPath, item.name);
  return { file_token: fileToken };
}

async function normalizeWriteFields(settings, appToken, fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (Array.isArray(value) && value.some(isAttachmentPlaceholder)) {
      const list = [];
      for (const item of value) {
        const normalized = await normalizeAttachmentValue(settings, appToken, item);
        if (normalized) list.push(normalized);
      }
      out[key] = list;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function recordListFromBody(body) {
  if (Array.isArray(body?.records) && body.records.length > 0) return body.records;
  if (body?.fields && typeof body.fields === 'object') {
    return [{ recordId: body.recordId, fields: body.fields }];
  }
  return [];
}

router.get('/status', (_req, res) => {
  try {
    res.json({ success: true, data: maskFeishuSettings(readPrivateSettings()) });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

router.post('/settings', (req, res) => {
  try {
    const settings = writePrivateSettings(req.body || {});
    res.json({ success: true, data: maskFeishuSettings(settings) });
  } catch (e) {
    res.status(400).json({ success: false, error: e?.message || String(e) });
  }
});

router.post('/test', async (req, res) => {
  try {
    const settings = resolveSettingsFromBody(req.body || {});
    const token = await getTenantAccessToken(settings);
    res.json({
      success: true,
      data: {
        ...maskFeishuSettings(settings),
        tokenPreview: maskOneSecret(token),
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

router.post('/fields', async (req, res) => {
  try {
    const settings = resolveSettingsFromBody(req.body || {});
    const appToken = normalizeAppToken(req.body?.appToken);
    const tableId = normalizeTableId(req.body?.tableId);
    const items = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({ page_size: '200' });
      if (pageToken) q.set('page_token', pageToken);
      const data = await feishuJson(
        settings,
        'GET',
        `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields?${q.toString()}`,
      );
      if (Array.isArray(data.items)) items.push(...data.items);
      pageToken = data.has_more ? safeText(data.page_token, '', 400) : '';
    } while (pageToken);
    res.json({ success: true, data: { items } });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

router.post('/records/search', async (req, res) => {
  try {
    const settings = resolveSettingsFromBody(req.body || {});
    const appToken = normalizeAppToken(req.body?.appToken);
    const tableId = normalizeTableId(req.body?.tableId);
    const pageSize = Math.min(Math.max(Number(req.body?.pageSize) || 50, 1), 500);
    const limit = Math.min(Math.max(Number(req.body?.limit) || pageSize, 1), 5000);
    const records = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({ page_size: String(pageSize) });
      if (pageToken) q.set('page_token', pageToken);
      const body = {};
      const viewId = safeText(req.body?.viewId, '', 240);
      if (viewId) body.view_id = viewId;
      if (Array.isArray(req.body?.fieldNames) && req.body.fieldNames.length > 0) {
        body.field_names = req.body.fieldNames.map((x) => safeText(x, '', 240)).filter(Boolean);
      }
      if (req.body?.filter && typeof req.body.filter === 'object') body.filter = req.body.filter;
      if (Array.isArray(req.body?.sort) && req.body.sort.length > 0) body.sort = req.body.sort;
      const data = await feishuJson(
        settings,
        'POST',
        `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/search?${q.toString()}`,
        body,
      );
      if (Array.isArray(data.items)) records.push(...data.items);
      pageToken = data.has_more && records.length < limit ? safeText(data.page_token, '', 400) : '';
    } while (pageToken && records.length < limit);
    res.json({ success: true, data: { items: records.slice(0, limit) } });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

router.post('/media/download', async (req, res) => {
  try {
    const settings = resolveSettingsFromBody(req.body || {});
    const item = await downloadMediaFile(settings, req.body?.fileToken || req.body?.file_token, req.body?.name);
    res.json({ success: true, data: item });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

router.post('/records/write', async (req, res) => {
  try {
    const settings = resolveSettingsFromBody(req.body || {});
    const appToken = normalizeAppToken(req.body?.appToken);
    const tableId = normalizeTableId(req.body?.tableId);
    const mode = safeText(req.body?.mode || 'create', 'create', 20);
    const records = recordListFromBody(req.body);
    if (records.length === 0) throw new Error('没有可写回飞书的记录');
    const results = [];
    for (const record of records) {
      const recordId = safeText(record.recordId || req.body?.recordId, '', 240);
      const fields = await normalizeWriteFields(settings, appToken, record.fields || {});
      if (mode === 'update') {
        if (!recordId) throw new Error('更新飞书记录需要 recordId');
        const data = await feishuJson(
          settings,
          'PUT',
          `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
          { fields },
        );
        results.push(data.record || data);
      } else {
        const data = await feishuJson(
          settings,
          'POST',
          `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
          { fields },
        );
        results.push(data.record || data);
      }
    }
    res.json({ success: true, data: { items: results } });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

module.exports = router;
module.exports.__test__ = {
  resolveFeishuApiBase,
  maskFeishuSettings,
  resolveKnownLocalFile,
  normalizeWriteFields,
  resolveAllowedAttachmentFile,
  downloadMediaFile,
  buildOpenApiUrl,
  PRIVATE_FILE,
  DEFAULT_OPEN_API_BASE,
  GLOBAL_OPEN_API_BASE,
};
