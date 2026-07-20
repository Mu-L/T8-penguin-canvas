const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const { loadSettings } = require('./settings');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 128 * 1024 * 1024 } });

const VIBEX_APP_ID = 'app-6620095f4f9d4cd48f6d667627500d82';

const MODEL_ROUTES = {
  'seedance-2': {
    endpoint: '/openapi/v2/rhart-video/sparkvideo-2.0/text-to-video',
    mode: 'text',
    resolutions: ['480p', '720p', 'native1080p', 'native4k', '1080p', '2k', '4k'],
  },
  'seedance-2-i2v': {
    endpoint: '/openapi/v2/rhart-video/sparkvideo-2.0/image-to-video',
    mode: 'image',
    resolutions: ['480p', '720p', 'native1080p', 'native4k', '1080p', '2k', '4k'],
  },
  'seedance-2-ref': {
    endpoint: '/openapi/v2/rhart-video/sparkvideo-2.0/multimodal-video',
    mode: 'ref',
    resolutions: ['480p', '720p', 'native1080p', 'native4k', '1080p', '2k', '4k'],
  },
  'seedance2-0-fast-text-to-video': {
    endpoint: '/openapi/v2/rhart-video/sparkvideo-2.0-fast/text-to-video',
    mode: 'text',
    resolutions: ['480p', '720p', '1080p', '2k', '4k'],
    fast: true,
  },
  'seedance2-0-fast-image-to-video': {
    endpoint: '/openapi/v2/rhart-video/sparkvideo-2.0-fast/image-to-video',
    mode: 'image',
    resolutions: ['480p', '720p', '1080p', '2k', '4k'],
    fast: true,
  },
  'seedance2-0-fast-multimodal-video': {
    endpoint: '/openapi/v2/rhart-video/sparkvideo-2.0-fast/multimodal-video',
    mode: 'ref',
    resolutions: ['480p', '720p', '1080p', '2k', '4k'],
    fast: true,
  },
  'seedance-2-0-mini-text-to-video': {
    endpoint: '/openapi/v2/rhart-video/sparkvideo-2.0-mini/text-to-video',
    mode: 'text',
    resolutions: ['480p', '720p', '1080p', '2k', '4k'],
    mini: true,
  },
  'seedance-2-0-mini-image-to-video': {
    endpoint: '/openapi/v2/rhart-video/sparkvideo-2.0-mini/image-to-video',
    mode: 'image',
    resolutions: ['480p', '720p', '1080p', '2k', '4k'],
    mini: true,
  },
  'seedance-2-0-mini-multimodal-video': {
    endpoint: '/openapi/v2/rhart-video/sparkvideo-2.0-mini/multimodal-video',
    mode: 'ref',
    resolutions: ['480p', '720p', '1080p', '2k', '4k'],
    mini: true,
  },
};

const RATIO_VALUES = new Set(['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9']);
const DURATION_VALUES = new Set(['4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15']);
const TASKS_FILE = path.join(config.DATA_DIR, 'vibex_tasks.json');
const GALLERY_FILE = path.join(config.DATA_DIR, 'vibex_video_gallery.json');

function ensureDataDir() {
  if (!fs.existsSync(config.DATA_DIR)) fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function loadTaskStore() {
  const store = readJsonFile(TASKS_FILE, { tasks: [] });
  return { tasks: Array.isArray(store.tasks) ? store.tasks : [] };
}

function saveTaskStore(store) {
  writeJsonFile(TASKS_FILE, { tasks: Array.isArray(store.tasks) ? store.tasks.slice(-800) : [] });
}

function loadGalleryStore() {
  const store = readJsonFile(GALLERY_FILE, { items: [] });
  return { items: Array.isArray(store.items) ? store.items : [] };
}

function saveGalleryStore(store) {
  writeJsonFile(GALLERY_FILE, { items: Array.isArray(store.items) ? store.items.slice(-1000) : [] });
}

function pickRhApiKey(settings) {
  return settings?.rhApiKey || settings?.runninghubApiKey || '';
}

function rhApiKey() {
  return pickRhApiKey(loadSettings({ persistMigrations: false }));
}

function keyFingerprint(key) {
  const s = String(key || '');
  if (!s) return '';
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x1000193 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2, 2246822519) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

function isRhAuthErr(raw) {
  const s = String(raw || '');
  return /APIKEY_USER_NOT_FOUND|APIKEY_INVALID|TOKEN_INVALID|user not exist|"code":301|"errorCode":"(?:806|805|412)"/i.test(s);
}

function newTaskId() {
  return `task-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function sanitizeResolution(value, route) {
  const s = String(value || '720p');
  return route.resolutions.includes(s) ? s : '720p';
}

function sanitizeDuration(value) {
  const s = String(value || '5');
  return DURATION_VALUES.has(s) ? s : '5';
}

function sanitizeRatio(value) {
  const s = String(value || 'adaptive');
  return RATIO_VALUES.has(s) ? s : 'adaptive';
}

function collectStringArray(value, max) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, max);
}

function inferOutputType(url) {
  const text = String(url || '').split(/[?#]/)[0].toLowerCase();
  if (/\.(mp4|webm|mov|m4v|mkv)$/.test(text)) return 'video';
  if (/\.(mp3|wav|ogg|m4a|flac)$/.test(text)) return 'audio';
  if (/\.(glb|gltf|obj|fbx|stl|usdz)$/.test(text)) return '3d';
  if (/\.(png|jpe?g|webp|gif|bmp|avif)$/.test(text)) return 'image';
  return 'video';
}

function normalizeOutputUrl(rawUrl) {
  if (!rawUrl) return '';
  let url = String(rawUrl);
  const idx = url.indexOf('myqcloud.com/');
  if (idx >= 0) url = `https://rh-images.xiaoyaoyou.com/${url.slice(idx + 'myqcloud.com/'.length)}`;
  const qIdx = url.indexOf('?');
  let pathPart = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const query = qIdx >= 0 ? url.slice(qIdx) : '';
  try { pathPart = encodeURI(decodeURI(pathPart)); } catch {}
  return pathPart + query;
}

function collectOutputUrls(value, out = []) {
  if (!value || out.length >= 20) return out;
  if (typeof value === 'string') {
    if (/^(https?:\/\/|\/files\/|\/output\/|\/input\/)/i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectOutputUrls(item, out);
    return out;
  }
  if (typeof value !== 'object') return out;
  for (const key of ['url', 'fileUrl', 'file_url', 'imageUrl', 'videoUrl', 'audioUrl', 'downloadUrl', 'download_url', 'resultUrl', 'result_url']) {
    if (value[key]) collectOutputUrls(value[key], out);
  }
  for (const key of ['results', 'outputs', 'files', 'images', 'videos', 'audios', 'data']) {
    if (value[key]) collectOutputUrls(value[key], out);
  }
  return out;
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.replace(/\s+/g, ' ').slice(0, 240);
    const err = new Error(`${label} 返回非 JSON：HTTP ${response.status} ${preview}`);
    err.status = response.status;
    err.body = text;
    throw err;
  }
}

function errorStatusForRhAuth(raw) {
  return isRhAuthErr(raw) ? 412 : 502;
}

function buildPayload(model, route, body) {
  const prompt = String(body.prompt || '').trim().slice(0, 4000);
  const payload = {
    appCode: 'vibex',
    vibexAppId: VIBEX_APP_ID,
    resolution: sanitizeResolution(body.resolution, route),
    duration: sanitizeDuration(body.duration),
    ratio: sanitizeRatio(body.ratio),
    generateAudio: body.generateAudio === undefined || body.generateAudio === null ? true : !!body.generateAudio,
    realPersonMode: body.realPersonMode === undefined || body.realPersonMode === null ? true : !!body.realPersonMode,
  };
  if (prompt) payload.prompt = prompt;
  if (body.webSearch !== undefined) payload.webSearch = !!body.webSearch;
  if (body.returnLastFrame !== undefined) payload.returnLastFrame = !!body.returnLastFrame;
  if (body.seed !== undefined && body.seed !== null && String(body.seed).trim() !== '') payload.seed = Number(body.seed) || 0;

  if (route.mode === 'text') {
    if (!prompt) return { error: { status: 400, body: { error: 'prompt_required', message: '请输入视频描述' } } };
  } else if (route.mode === 'image') {
    const firstFrameUrl = String(body.firstFrameUrl || '').trim();
    if (!firstFrameUrl) return { error: { status: 400, body: { error: 'media_required', message: '缺少必填媒体 firstFrameUrl' } } };
    payload.firstFrameUrl = firstFrameUrl;
    if (body.lastFrameUrl) payload.lastFrameUrl = String(body.lastFrameUrl);
  } else {
    const imageUrls = collectStringArray(body.imageUrls, 9);
    const videoUrls = collectStringArray(body.videoUrls, 3);
    const audioUrls = collectStringArray(body.audioUrls, 3);
    if (!prompt && imageUrls.length === 0 && videoUrls.length === 0 && audioUrls.length === 0) {
      return { error: { status: 400, body: { error: 'input_required', message: '请上传参考素材或填写文字描述' } } };
    }
    if (imageUrls.length) payload.imageUrls = imageUrls;
    if (videoUrls.length) payload.videoUrls = videoUrls;
    if (audioUrls.length) payload.audioUrls = audioUrls;
  }

  return {
    payload,
    recordPrompt: prompt || (route.mode === 'image' ? '图片生视频' : '参考生视频'),
    page: String(body.page || ''),
  };
}

function taskToHistoryItem(task) {
  return {
    jobId: task.taskId || '',
    taskId: task.rhTaskId || '',
    status: task.status || 'running',
    page: task.page || '',
    prompt: task.prompt || '',
    resultUrl: task.resultUrl || '',
    errorMessage: task.errorMessage || '',
    created: task.created || '',
    updated: task.updated || task.created || '',
  };
}

router.post('/api/aigc/media/upload', upload.single('file'), async (req, res) => {
  const apiKey = rhApiKey();
  if (!apiKey) return res.status(412).json({ error: 'rh_login_required', message: '请先在 T8 设置里填写 RunningHub API Key' });
  if (!req.file?.buffer) return res.status(400).json({ error: 'file_required', message: '请上传文件' });
  try {
    const fd = new FormData();
    fd.set('apiKey', apiKey);
    fd.set('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' }), req.file.originalname || 'asset.bin');
    const upstream = await fetch(`${config.RH_BASE_URL}/openapi/v2/media/upload/binary`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });
    const text = await upstream.text();
    const parsed = JSON.parse(text || '{}');
    if (isRhAuthErr(text)) return res.status(412).json({ error: 'rh_login_required', message: 'RunningHub API Key 已失效' });
    if (!upstream.ok) {
      return res.status(502).json({ error: 'upload_failed', message: `RH upload HTTP ${upstream.status}: ${text.slice(0, 200)}` });
    }
    const downloadUrl = parsed?.data?.download_url || parsed?.data?.downloadUrl || parsed?.downloadUrl || parsed?.url || '';
    if (!downloadUrl) {
      return res.status(502).json({ error: 'upload_bad_response', message: `RH upload bad response: ${text.slice(0, 200)}` });
    }
    return res.json({ ok: true, downloadUrl: String(downloadUrl) });
  } catch (error) {
    return res.status(500).json({ error: 'upload_error', message: error.message || String(error) });
  }
});

router.post('/api/aigc/:model/submit', async (req, res) => {
  const model = String(req.params.model || '');
  const route = MODEL_ROUTES[model];
  if (!route) return res.status(404).json({ error: 'model_not_found', message: `未知 VibeX 模型: ${model}` });
  const apiKey = rhApiKey();
  if (!apiKey) return res.status(412).json({ error: 'rh_login_required', message: '请先在 T8 设置里填写 RunningHub API Key' });

  const built = buildPayload(model, route, req.body || {});
  if (built.error) return res.status(built.error.status).json(built.error.body);

  try {
    const upstream = await fetch(`${config.RH_BASE_URL}${route.endpoint}`, {
      method: 'POST',
      headers: { Host: 'www.runninghub.cn', Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(built.payload),
    });
    const text = await upstream.text();
    if (isRhAuthErr(text)) return res.status(412).json({ error: 'rh_login_required', message: 'RunningHub API Key 已失效' });
    if (!upstream.ok) {
      return res.status(errorStatusForRhAuth(text)).json({ error: 'rh_submit_failed', message: `RH HTTP ${upstream.status} ${text.slice(0, 200)}` });
    }
    const parsed = JSON.parse(text || '{}');
    const rhTaskId = String(parsed.taskId || parsed?.data?.taskId || '');
    if (!rhTaskId) {
      return res.status(502).json({ error: 'rh_submit_bad_json', message: `RH bad JSON: ${text.slice(0, 200)}` });
    }
    const now = new Date().toISOString();
    const task = {
      taskId: newTaskId(),
      rhTaskId,
      model,
      rhUserId: keyFingerprint(apiKey),
      page: built.page,
      prompt: built.recordPrompt,
      status: 'running',
      resultUrl: '',
      errorMessage: '',
      created: now,
      updated: now,
    };
    const store = loadTaskStore();
    store.tasks.push(task);
    saveTaskStore(store);
    return res.json({ ok: true, taskId: task.taskId, rhTaskId, status: 'running', model });
  } catch (error) {
    return res.status(500).json({ error: 'aigc_submit_error', message: error.message || String(error) });
  }
});

router.post('/api/aigc/:model/jobs/:jobId/poll', async (req, res) => {
  const model = String(req.params.model || '');
  const route = MODEL_ROUTES[model];
  if (!route) return res.status(404).json({ error: 'model_not_found', message: `未知 VibeX 模型: ${model}` });
  const apiKey = rhApiKey();
  if (!apiKey) return res.status(412).json({ error: 'rh_login_required', message: '请先在 T8 设置里填写 RunningHub API Key' });
  const jobId = String(req.params.jobId || '');
  const store = loadTaskStore();
  const task = store.tasks.find((item) => item.taskId === jobId && item.model === model);
  if (!task) return res.status(404).json({ error: 'job_not_found', message: '任务不存在或已过期' });
  if (!task.rhTaskId) return res.json({ ok: true, taskId: jobId, status: 'RUNNING', outputs: [], model });

  try {
    const upstream = await fetch(`${config.RH_BASE_URL}/openapi/v2/query`, {
      method: 'POST',
      headers: { Host: 'www.runninghub.cn', Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: task.rhTaskId }),
    });
    const data = await parseJsonResponse(upstream, 'RunningHub query');
    const raw = JSON.stringify(data);
    if (isRhAuthErr(raw)) return res.status(412).json({ error: 'rh_login_required', message: 'RunningHub API Key 已失效' });
    if (!upstream.ok) return res.json({ ok: true, taskId: jobId, status: 'RUNNING', outputs: [], model });

    const status = String(data.status || data?.data?.status || 'RUNNING').toUpperCase();
    const now = new Date().toISOString();
    if (status === 'SUCCESS') {
      const outputs = collectOutputUrls(data.results || data.data || data)
        .map((url) => normalizeOutputUrl(url))
        .filter(Boolean)
        .map((url) => ({ url, type: inferOutputType(url) }));
      if (outputs.length) {
        task.status = 'success';
        task.resultUrl = outputs[0].url;
        task.errorMessage = '';
        task.updated = now;
        saveTaskStore(store);
      }
      return res.json({ ok: true, taskId: jobId, status, outputs, model });
    }
    if (status === 'FAILED' || status === 'CANCEL') {
      const errMsg = String(data.errorMessage || data.errorCode || data?.data?.failedReason || data?.data?.failReason || 'task_failed');
      task.status = 'failed';
      task.errorMessage = errMsg.slice(0, 4000);
      task.updated = now;
      saveTaskStore(store);
      return res.json({ ok: true, taskId: jobId, status, outputs: [], error: errMsg, model });
    }
    task.updated = now;
    saveTaskStore(store);
    return res.json({ ok: true, taskId: jobId, status, outputs: [], model });
  } catch (error) {
    console.warn('[VibeX/poll] transient error:', error.message || error);
    return res.json({ ok: true, taskId: jobId, status: 'RUNNING', outputs: [], model });
  }
});

router.post('/api/aigc/:model/history', (req, res) => {
  const model = String(req.params.model || '');
  if (!MODEL_ROUTES[model]) return res.status(404).json({ error: 'model_not_found' });
  const apiKey = rhApiKey();
  if (!apiKey) return res.json({ ok: true, items: [], page: 1, perPage: 0 });
  const page = Math.max(1, Number(req.body?.page || req.query?.page || 1) || 1);
  const perPage = Math.min(100, Math.max(1, Number(req.body?.perPage || req.query?.perPage || 20) || 20));
  const userId = keyFingerprint(apiKey);
  const items = loadTaskStore().tasks
    .filter((task) => task.rhUserId === userId && task.model === model)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
    .slice((page - 1) * perPage, page * perPage)
    .map(taskToHistoryItem);
  return res.json({ ok: true, items, page, perPage });
});

router.post('/api/aigc/:model/history/:jobId/update', (req, res) => {
  const model = String(req.params.model || '');
  const apiKey = rhApiKey();
  if (!apiKey) return res.status(412).json({ error: 'rh_login_required', message: '请先在 T8 设置里填写 RunningHub API Key' });
  const store = loadTaskStore();
  const userId = keyFingerprint(apiKey);
  const task = store.tasks.find((item) => item.taskId === req.params.jobId && item.model === model && item.rhUserId === userId);
  if (!task) return res.status(404).json({ error: 'history_not_found', message: '记录不存在或已删除' });
  task.rating = Number(req.body?.rating || task.rating || 0) || 0;
  if (req.body?.favorite !== undefined) task.favorite = !!req.body.favorite;
  if (req.body?.category !== undefined) task.category = String(req.body.category || '').slice(0, 32);
  if (req.body?.note !== undefined) task.note = String(req.body.note || '').slice(0, 1000);
  task.updated = new Date().toISOString();
  saveTaskStore(store);
  return res.json({ ok: true, item: { ...taskToHistoryItem(task), rating: task.rating || 0, favorite: !!task.favorite, category: task.category || '', note: task.note || '' } });
});

router.post('/api/aigc/:model/history/:jobId/delete', (req, res) => {
  const model = String(req.params.model || '');
  const apiKey = rhApiKey();
  if (!apiKey) return res.status(412).json({ error: 'rh_login_required', message: '请先在 T8 设置里填写 RunningHub API Key' });
  const userId = keyFingerprint(apiKey);
  const store = loadTaskStore();
  const before = store.tasks.length;
  store.tasks = store.tasks.filter((item) => !(item.taskId === req.params.jobId && item.model === model && item.rhUserId === userId));
  saveTaskStore(store);
  return res.json({ ok: true, deleted: before !== store.tasks.length, jobId: req.params.jobId });
});

function normalizeGalleryItem(raw, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || `vg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    task_id: String(raw.task_id ?? existing.task_id ?? ''),
    rh_user_id: String(raw.rh_user_id ?? existing.rh_user_id ?? 't8-local-rh'),
    result_url: String(raw.result_url ?? existing.result_url ?? ''),
    prompt: String(raw.prompt ?? existing.prompt ?? ''),
    model_name: String(raw.model_name ?? existing.model_name ?? ''),
    resolution: String(raw.resolution ?? existing.resolution ?? ''),
    ratio: String(raw.ratio ?? existing.ratio ?? ''),
    duration: String(raw.duration ?? existing.duration ?? ''),
    rating: Number(raw.rating ?? existing.rating ?? 0) || 0,
    is_favorite: Boolean(raw.is_favorite ?? existing.is_favorite ?? false),
    tags: String(raw.tags ?? existing.tags ?? ''),
    note: String(raw.note ?? existing.note ?? ''),
    cost: Number(raw.cost ?? existing.cost ?? 0) || 0,
    gen_seconds: Number(raw.gen_seconds ?? existing.gen_seconds ?? 0) || 0,
    created: existing.created || now,
    updated: now,
  };
}

router.get('/api/video_gallery', (req, res) => {
  const rhUserId = String(req.query.rh_user_id || '').trim();
  const perPage = Math.min(500, Math.max(1, Number(req.query.perPage || 50) || 50));
  const page = Math.max(1, Number(req.query.page || 1) || 1);
  let items = loadGalleryStore().items;
  if (rhUserId) items = items.filter((item) => String(item.rh_user_id) === rhUserId);
  items = items.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return res.json({ page, perPage, totalItems: items.length, items: items.slice((page - 1) * perPage, page * perPage) });
});

router.post('/api/video_gallery', (req, res) => {
  const store = loadGalleryStore();
  const item = normalizeGalleryItem(req.body || {});
  store.items.unshift(item);
  saveGalleryStore(store);
  return res.status(201).json(item);
});

router.patch('/api/video_gallery/:id', (req, res) => {
  const store = loadGalleryStore();
  const index = store.items.findIndex((item) => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'not_found' });
  store.items[index] = normalizeGalleryItem(req.body || {}, store.items[index]);
  saveGalleryStore(store);
  return res.json(store.items[index]);
});

router.delete('/api/video_gallery/:id', (req, res) => {
  const store = loadGalleryStore();
  const before = store.items.length;
  store.items = store.items.filter((item) => item.id !== req.params.id);
  saveGalleryStore(store);
  return res.json({ ok: true, deleted: before !== store.items.length, id: req.params.id });
});

router.post('/getUserInfo', (_req, res) => {
  const apiKey = rhApiKey();
  if (!apiKey) return res.status(412).json({ error: 'rh_login_required', message: '请先在 T8 设置里填写 RunningHub API Key' });
  return res.json({
    data: {
      id: 't8-local-rh',
      nickName: 'T8 RunningHub',
      totalCoin: '',
      walletInfo: { balance: '' },
    },
  });
});

router.post('/logout', (_req, res) => {
  res.json({ ok: true });
});

module.exports = router;
