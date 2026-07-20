const MENU_ID = 't8-web-image-reverse';
const DEFAULT_BACKEND_BASE = 'http://127.0.0.1:18766';
const DEFAULT_CANVAS_URL = 'http://127.0.0.1:11422/';
const CANVAS_MESSAGE_TYPE = 't8:web-image-result';
const CANVAS_MESSAGE_SOURCE = 't8-web-image-extension';

function storageGet(defaults) {
  return new Promise((resolve) => {
    chrome.storage.local.get(defaults, (items) => resolve(items || defaults));
  });
}

function absoluteBackendUrl(base, path) {
  const cleanBase = String(base || DEFAULT_BACKEND_BASE).replace(/\/+$/, '');
  if (/^https?:\/\//i.test(path)) return path;
  return `${cleanBase}${path.startsWith('/') ? path : `/${path}`}`;
}

function normalizeBackendFetchError(error) {
  const text = String(error?.message || error || '').trim();
  if (!text || /failed to fetch|networkerror|load failed|fetch/i.test(text)) {
    return '无法连接 T8 后端，请确认画布后端已启动，或在扩展设置中检查 Backend Base。';
  }
  return text;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {
      success: false,
      code: 'invalid_backend_response',
      error: text.slice(0, 220) || `T8 后端返回 HTTP ${response.status}`,
    };
  }
}

function installContextMenu() {
  chrome.contextMenus.remove(MENU_ID, () => {
    chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '反推生图并发送到 T8 画布',
      contexts: ['image'],
    });
  });
}

async function injectReverseImageUi(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['styles/content.css'],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['scripts/content.js'],
  });
}

function isCanvasUrl(url, configuredUrl) {
  const text = String(url || '');
  if (!text) return false;
  if (configuredUrl && text.startsWith(configuredUrl.replace(/\/+$/, ''))) return true;
  return /^https?:\/\/(?:127\.0\.0\.1|localhost):11422(?:\/|$)/i.test(text) ||
    /^https?:\/\/(?:127\.0\.0\.1|localhost):18766(?:\/|$)/i.test(text);
}

async function findExistingCanvasTab() {
  const settings = await storageGet({ t8_canvas_url: DEFAULT_CANVAS_URL });
  const canvasUrl = String(settings.t8_canvas_url || DEFAULT_CANVAS_URL);
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => isCanvasUrl(tab.url, canvasUrl)) || null;
}

async function findOrOpenCanvasTab() {
  const settings = await storageGet({ t8_canvas_url: DEFAULT_CANVAS_URL });
  const canvasUrl = String(settings.t8_canvas_url || DEFAULT_CANVAS_URL);
  const existing = await findExistingCanvasTab();
  if (existing?.id) return existing;
  return chrome.tabs.create({ url: canvasUrl, active: false });
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || tab?.status === 'complete') {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 6000);
      function listener(updatedTabId, changeInfo) {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

async function sendToCanvas(payload) {
  const messagePayload = {
    ...payload,
    messageId: payload?.messageId || `t8-web-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  const existingTarget = await findExistingCanvasTab();
  if (existingTarget?.id) {
    try {
      await postWebImageResultToCanvasTab(existingTarget, messagePayload);
      return { method: 'canvas-tab' };
    } catch (tabError) {
      try {
        const bridge = await postWebImageResultToLocalBridge(messagePayload);
        return { method: 'local-bridge', bridge };
      } catch {
        throw tabError;
      }
    }
  }

  try {
    const bridge = await postWebImageResultToLocalBridge(messagePayload);
    return { method: 'local-bridge', bridge };
  } catch (bridgeError) {
    const target = await findOrOpenCanvasTab();
    if (!target?.id) throw bridgeError || new Error('没有找到可发送的 T8 画布标签页。');
    await postWebImageResultToCanvasTab(target, messagePayload);
    return { method: 'canvas-tab-opened' };
  }
}

async function postWebImageResultToCanvasTab(target, messagePayload) {
  if (!target?.id) throw new Error('没有找到可发送的 T8 画布标签页。');
  await waitForTabComplete(target.id);
  await chrome.scripting.executeScript({
    target: { tabId: target.id },
    func: (messagePayload, messageSource, messageType) => {
      window.postMessage({ type: 't8:web-image-result', source: messageSource, payload: messagePayload }, window.location.origin);
      window.setTimeout(() => {
        window.postMessage({ type: messageType, source: messageSource, payload: messagePayload }, window.location.origin);
      }, 900);
    },
    args: [messagePayload, CANVAS_MESSAGE_SOURCE, CANVAS_MESSAGE_TYPE],
  });
  await chrome.tabs.update(target.id, { active: true });
  if (target.windowId != null) {
    try {
      await chrome.windows.update(target.windowId, { focused: true });
    } catch {
      // ignore focus failures
    }
  }
}

function backendCandidates(preferredBase) {
  const candidates = [];
  const push = (value) => {
    const clean = String(value || '').replace(/\/+$/, '');
    if (clean && !candidates.includes(clean)) candidates.push(clean);
  };
  push(preferredBase || DEFAULT_BACKEND_BASE);
  for (let port = 18766; port <= 18785; port += 1) {
    push(`http://127.0.0.1:${port}`);
  }
  return candidates;
}

async function postVibeXResultToLocalBridge(payload) {
  const settings = await storageGet({ t8_backend_base: DEFAULT_BACKEND_BASE });
  let lastError = null;
  for (const backendBase of backendCandidates(settings.t8_backend_base)) {
    try {
      const response = await fetch(absoluteBackendUrl(backendBase, '/api/vibex-bridge/messages'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 't8:vibex-result',
          source: 'vibex-workbench',
          payload,
        }),
      });
      const data = await readJsonResponse(response);
      if (response.ok && data?.success !== false) {
        return { backendBase, data };
      }
      lastError = new Error(data?.error || `T8 后端返回 HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('无法连接 T8 本地桥接服务。');
}

async function postWebImageResultToLocalBridge(payload) {
  const settings = await storageGet({ t8_backend_base: DEFAULT_BACKEND_BASE });
  let lastError = null;
  for (const backendBase of backendCandidates(settings.t8_backend_base)) {
    try {
      const response = await fetch(absoluteBackendUrl(backendBase, '/api/vibex-bridge/messages'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: CANVAS_MESSAGE_TYPE,
          source: CANVAS_MESSAGE_SOURCE,
          payload,
        }),
      });
      const data = await readJsonResponse(response);
      if (response.ok && data?.success !== false) {
        return { backendBase, data };
      }
      lastError = new Error(data?.error || `T8 后端返回 HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('无法连接 T8 本地桥接服务。');
}

async function sendVibeXResultToCanvas(payload) {
  const target = await findExistingCanvasTab();
  const messagePayload = {
    ...payload,
    messageId: payload?.messageId || `t8-vibex-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };

  if (target?.id) {
    await waitForTabComplete(target.id);
    await chrome.scripting.executeScript({
      target: { tabId: target.id },
      func: (payloadForCanvas) => {
        window.postMessage({ type: 't8:vibex-result', source: 'vibex-workbench', payload: payloadForCanvas }, window.location.origin);
      },
      args: [messagePayload],
    });
    return { method: 'canvas-tab' };
  }

  const bridge = await postVibeXResultToLocalBridge(messagePayload);
  return { method: 'local-bridge', bridge };
}

async function reverseAndGenerate(message) {
  const settings = await storageGet({ t8_backend_base: DEFAULT_BACKEND_BASE });
  const backendBase = message?.backendBase || settings.t8_backend_base || DEFAULT_BACKEND_BASE;
  const response = await fetch(absoluteBackendUrl(backendBase, '/api/proxy/external/web-image'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message?.payload || {}),
  });
  const data = await readJsonResponse(response);
  const ok = response.ok && data?.success !== false;
  return {
    ok,
    status: response.status,
    data,
    error: ok ? '' : (data?.error || `T8 后端返回 HTTP ${response.status}`),
  };
}

async function generateImage(message) {
  const settings = await storageGet({ t8_backend_base: DEFAULT_BACKEND_BASE });
  const backendBase = message?.backendBase || settings.t8_backend_base || DEFAULT_BACKEND_BASE;
  const response = await fetch(absoluteBackendUrl(backendBase, '/api/proxy/external/image'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message?.payload || {}),
  });
  const data = await readJsonResponse(response);
  const ok = response.ok && data?.success !== false;
  return {
    ok,
    status: response.status,
    data,
    error: ok ? '' : (data?.error || `T8 后端返回 HTTP ${response.status}`),
  };
}

async function scanAssetsInTab(tabId, autoScroll) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (shouldScroll) => {
      const originalX = window.scrollX;
      const originalY = window.scrollY;
      if (shouldScroll) {
        const step = Math.max(360, Math.floor(window.innerHeight * 0.8));
        const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        for (let y = 0; y <= maxY; y += step) {
          window.scrollTo(originalX, y);
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        window.scrollTo(originalX, maxY);
        await new Promise((resolve) => setTimeout(resolve, 180));
      }

      const out = [];
      const seen = new Set();
      const absolute = (value) => {
        const text = String(value || '').trim();
        if (!text) return '';
        if (/^(data:|blob:)/i.test(text)) return text;
        try { return new URL(text, document.baseURI).href; } catch { return ''; }
      };
      const add = (url, meta = {}) => {
        const clean = absolute(url);
        if (!clean || seen.has(clean) || out.length >= 200) return;
        seen.add(clean);
        let name = meta.name || '';
        if (!name) {
          if (/^data:/i.test(clean)) name = `embedded-image-${out.length + 1}.png`;
          else if (/^blob:/i.test(clean)) name = `blob-image-${out.length + 1}.png`;
          else {
            try { name = decodeURIComponent(new URL(clean).pathname.split('/').pop() || 'web-image'); } catch { name = 'web-image'; }
          }
        }
        out.push({
          id: `asset-${out.length}-${clean.slice(-48)}`,
          url: clean,
          previewUrl: clean,
          name: String(name).slice(0, 160),
          width: Math.max(0, Number(meta.width) || 0),
          height: Math.max(0, Number(meta.height) || 0),
          source: meta.source || 'image',
        });
      };
      const srcsetUrls = (value) => {
        const text = String(value || '').trim();
        if (!text) return [];
        if (/^data:/i.test(text)) return [text.replace(/\s+\d+(?:\.\d+)?[wx]\s*$/i, '')];
        return text.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
      };

      document.querySelectorAll('img').forEach((image) => {
        add(image.currentSrc || image.src, {
          name: image.alt || image.getAttribute('title') || '',
          width: image.naturalWidth || image.width,
          height: image.naturalHeight || image.height,
          source: 'img',
        });
        srcsetUrls(image.getAttribute('srcset')).forEach((url) => add(url, { source: 'srcset' }));
      });
      document.querySelectorAll('picture source, source[srcset]').forEach((source) => {
        srcsetUrls(source.getAttribute('srcset')).forEach((url) => add(url, { source: 'picture' }));
      });
      document.querySelectorAll('*').forEach((node) => {
        const background = getComputedStyle(node).backgroundImage;
        if (!background || background === 'none') return;
        const matches = background.matchAll(/url\((?:"|')?(.+?)(?:"|')?\)/g);
        for (const match of matches) {
          const rect = node.getBoundingClientRect();
          add(match[1], { width: Math.round(rect.width), height: Math.round(rect.height), source: 'background' });
        }
      });
      document.querySelectorAll('canvas').forEach((canvas, index) => {
        try {
          add(canvas.toDataURL('image/png'), { name: `canvas-${index + 1}.png`, width: canvas.width, height: canvas.height, source: 'canvas' });
        } catch {
          // Cross-origin tainted canvas cannot be exported.
        }
      });
      if (shouldScroll) window.scrollTo(originalX, originalY);
      return out;
    },
    args: [!!autoScroll],
  });
  return Array.isArray(results?.[0]?.result) ? results[0].result : [];
}

async function resolveAssetsInPage(tabId, assets) {
  if (!tabId || !assets.length) return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (input) => {
        const toDataUrl = (blob) => new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(reader.error || new Error('read_failed'));
          reader.readAsDataURL(blob);
        });
        return Promise.all(input.map(async (asset, index) => {
          if (asset.dataUrl) return { index, dataUrl: asset.dataUrl };
          try {
            const response = await fetch(asset.url, { credentials: 'include', cache: 'force-cache' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            if (!String(blob.type || '').startsWith('image/')) throw new Error('not_image');
            if (blob.size > 30 * 1024 * 1024) throw new Error('too_large');
            return { index, dataUrl: await toDataUrl(blob) };
          } catch (error) {
            return { index, error: error?.message || String(error) };
          }
        }));
      },
      args: [assets.map((asset) => ({ url: asset.url || '', dataUrl: asset.dataUrl || '' }))],
    });
    return Array.isArray(results?.[0]?.result) ? results[0].result : [];
  } catch {
    return [];
  }
}

async function findWebAssetsBackend() {
  const settings = await storageGet({ t8_backend_base: DEFAULT_BACKEND_BASE });
  let lastError = null;
  for (const backendBase of backendCandidates(settings.t8_backend_base)) {
    try {
      const response = await fetch(absoluteBackendUrl(backendBase, '/api/web-assets/status'));
      const data = await readJsonResponse(response);
      if (response.ok && data?.success && data?.data?.token) return { backendBase, token: data.data.token };
      lastError = new Error(data?.error || `T8 后端返回 HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('无法连接支持网页素材采集的 T8 后端。');
}

async function importWebAssets(message) {
  const assets = Array.isArray(message.assets) ? message.assets.slice(0, 50) : [];
  if (!assets.length) throw new Error('没有选择要导入的网页素材。');
  const resolved = await resolveAssetsInPage(message.tabId, assets);
  const resolvedByIndex = new Map(resolved.filter((item) => item?.dataUrl).map((item) => [item.index, item.dataUrl]));
  const prepared = assets.map((asset, index) => ({
    url: asset.url || '',
    dataUrl: asset.dataUrl || resolvedByIndex.get(index) || '',
    name: asset.name || `web-image-${index + 1}`,
    pageUrl: message.pageUrl || '',
    width: asset.width || 0,
    height: asset.height || 0,
    source: asset.source || 'web',
  }));
  const backend = await findWebAssetsBackend();
  const imported = [];
  const failures = [];
  const chunkSize = 4;
  for (let start = 0; start < prepared.length; start += chunkSize) {
    const chunk = prepared.slice(start, start + chunkSize);
    try {
      const response = await fetch(absoluteBackendUrl(backend.backendBase, '/api/web-assets/import'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-t8-web-assets-token': backend.token },
        body: JSON.stringify({ assets: chunk }),
      });
      const data = await readJsonResponse(response);
      const items = Array.isArray(data?.data?.items) ? data.data.items : [];
      const chunkFailures = Array.isArray(data?.data?.failures) ? data.data.failures : [];
      imported.push(...items);
      failures.push(...chunkFailures.map((failure) => ({ ...failure, index: start + Number(failure.index || 0) })));
      if (!response.ok && !items.length && !chunkFailures.length) {
        chunk.forEach((asset, index) => failures.push({ index: start + index, name: asset.name, error: data?.error || `HTTP ${response.status}` }));
      }
    } catch (error) {
      chunk.forEach((asset, index) => failures.push({ index: start + index, name: asset.name, error: normalizeBackendFetchError(error) }));
    }
  }
  if (!imported.length) {
    const error = new Error(failures[0]?.error || '网页素材导入失败。');
    error.failures = failures;
    throw error;
  }

  await sendToCanvas({
    mode: 'reference',
    source: 'web-asset-importer',
    images: imported.map((item) => ({
      url: item.url,
      name: item.name || item.filename,
      mime: item.mime,
      size: item.size,
      width: item.width,
      height: item.height,
      sourceUrl: item.sourceUrl,
      pageUrl: item.pageUrl,
    })),
    imageUrls: imported.map((item) => item.url),
    pageUrl: message.pageUrl || '',
    pageTitle: message.pageTitle || '',
    createdAt: Date.now(),
    metadata: { importedCount: imported.length, failedCount: failures.length },
  });
  return { imported, failures };
}

chrome.runtime.onInstalled.addListener(installContextMenu);
chrome.runtime.onStartup.addListener(installContextMenu);
installContextMenu();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl || !tab?.id) return;
  try {
    await injectReverseImageUi(tab.id);
    chrome.tabs.sendMessage(tab.id, {
      action: 't8WebImage.showModal',
      imageUrl: info.srcUrl,
      pageUrl: tab.url || '',
      pageTitle: tab.title || '',
    });
  } catch (error) {
    console.error('[T8 Web Image] 打开反推面板失败', error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 't8WebAssets.scan') {
    scanAssetsInTab(message.tabId, message.autoScroll)
      .then((assets) => sendResponse({ ok: true, assets }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.action === 't8WebAssets.capture') {
    chrome.tabs.captureVisibleTab(message.windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      else sendResponse({ ok: true, dataUrl });
    });
    return true;
  }

  if (message?.action === 't8WebAssets.import') {
    importWebAssets(message)
      .then((result) => sendResponse({ ok: true, imported: result.imported.length, failures: result.failures }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error), failures: error?.failures || [] }));
    return true;
  }

  if (message?.action === 't8WebAssets.openSidePanel') {
    chrome.sidePanel.open({ windowId: message.windowId })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.action === 't8WebImage.getSettings') {
    storageGet({
      t8_backend_base: DEFAULT_BACKEND_BASE,
      t8_canvas_url: DEFAULT_CANVAS_URL,
    }).then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }

  if (message?.action === 't8WebImage.sendToCanvas') {
    sendToCanvas(message.payload || {})
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.action === 't8WebImage.reverseAndGenerate') {
    reverseAndGenerate(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: normalizeBackendFetchError(error), data: { success: false } }));
    return true;
  }

  if (message?.action === 't8WebImage.generateImage') {
    generateImage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: normalizeBackendFetchError(error), data: { success: false } }));
    return true;
  }

  if (message?.action === 't8RunningHub.forwardVibeXResult') {
    const payload = {
      ...(message.payload || {}),
      pageUrl: message.payload?.pageUrl || message.pageUrl || '',
      pageTitle: message.payload?.pageTitle || message.pageTitle || '',
    };
    sendVibeXResultToCanvas(payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: normalizeBackendFetchError(error) }));
    return true;
  }

  return false;
});
