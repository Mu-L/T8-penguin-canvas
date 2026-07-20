(function () {
  try {
  const state = T8PS.state;
  const net = T8PS.net;
  const ps = T8PS.ps;
  const $ = (id) => document.getElementById(id);

  const els = {
    connDot: $('connDot'),
    connText: $('connText'),
    tabs: document.querySelectorAll('.tab'),
    views: document.querySelectorAll('.view'),
    serverInput: $('serverInput'),
    connectBtn: $('connectBtn'),
    openT8: $('openT8'),
    uploadLayerToggle: $('uploadLayerToggle'),
    assetSection: $('assetSection'),
    assetSearch: $('assetSearch'),
    refreshAssets: $('refreshAssets'),
    assetGrid: $('assetGrid'),
    assetPager: $('assetPager'),
    prevAssetPage: $('prevAssetPage'),
    nextAssetPage: $('nextAssetPage'),
    assetPageInfo: $('assetPageInfo'),
    placeAsset: $('placeAsset'),
    uploadCurrent: $('uploadCurrent'),
    assetMsg: $('assetMsg'),
    providerSelect: $('providerSelect'),
    modelSelect: $('modelSelect'),
    promptInput: $('promptInput'),
    ratioSelect: $('ratioSelect'),
    sizeSelect: $('sizeSelect'),
    autoPlaceToggle: $('autoPlaceToggle'),
    syncCanvasToggle: $('syncCanvasToggle'),
    runGenerate: $('runGenerate'),
    generateResults: $('generateResults'),
    generateMsg: $('generateMsg'),
    settingsMsg: $('settingsMsg'),
    modeButtons: document.querySelectorAll('[data-mode]'),
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.className = `msg ${kind || ''}`;
  }

  function setConnected(on) {
    state.connected = !!on;
    els.connDot.classList.toggle('on', !!on);
    els.connText.textContent = on ? '已连接' : '未连接';
    els.placeAsset.disabled = !selectedAsset();
    els.uploadCurrent.disabled = !on || !ps.hasDocument();
    els.runGenerate.disabled = !on || !state.providers.length;
  }

  function canvasUrl() {
    const explicit = net.normalizeFrontendUrl ? net.normalizeFrontendUrl(state.frontendUrl) : '';
    if (explicit) return explicit;
    const host = String(state.host || '127.0.0.1:18766').trim();
    const match = host.match(/^([^:]+):(\d+)$/);
    if (match) {
      const port = Number(match[2]);
      if (port >= 18766 && port <= 18776) return `http://${match[1]}:11422`;
    }
    return `http://${host}/`;
  }

  function markPreviewBroken(thumbBox, text) {
    thumbBox.classList.add('thumb-broken');
    thumbBox.textContent = text || '预览失败';
  }

  function loadImagePreview(img, thumbBox, url) {
    const direct = net.absUrl(url);
    if (!direct) {
      markPreviewBroken(thumbBox, '无预览');
      return;
    }
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let usingFetchedData = false;
    img.setAttribute('data-preview-token', token);
    img.addEventListener('error', () => {
      if (img.getAttribute('data-preview-token') !== token || usingFetchedData) return;
      markPreviewBroken(thumbBox, '预览失败');
    });
    img.src = direct;
    if (!net.imageDataUrl) return;
    net.imageDataUrl(url).then((src) => {
      if (!src || img.getAttribute('data-preview-token') !== token) return;
      usingFetchedData = true;
      thumbBox.classList.remove('thumb-broken');
      if (!thumbBox.contains(img)) {
        thumbBox.textContent = '';
        thumbBox.appendChild(img);
      }
      img.src = src;
    }).catch(() => {
      // Keep the direct URL fallback if the UXP fetch path is unavailable.
    });
  }

  function switchTab(tab) {
    state.tab = tab;
    els.tabs.forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-tab') === tab));
    els.views.forEach((view) => view.classList.toggle('active', view.getAttribute('data-view') === tab));
  }

  function activeSection() {
    return state.assetSections.find((section) => section.id === state.activeSection) || state.assetSections[0] || null;
  }

  function allSectionItems() {
    const section = activeSection();
    return section && Array.isArray(section.items) ? section.items : [];
  }

  function filteredAssets() {
    const q = String(els.assetSearch.value || '').trim().toLowerCase();
    const list = allSectionItems();
    if (!q) return list;
    return list.filter((item) => `${item.name || ''} ${item.categoryName || ''} ${item.source || ''}`.toLowerCase().includes(q));
  }

  function selectedAsset() {
    const id = state.selectedAssetId;
    if (!id) return null;
    return state.assets.find((item) => item.id === id) || null;
  }

  function assetPageInfo(total) {
    const size = Math.max(1, Number(state.assetPageSize) || 24);
    const totalPages = Math.max(1, Math.ceil(total / size));
    let page = Math.max(1, Number(state.assetPage) || 1);
    if (page > totalPages) page = totalPages;
    state.assetPage = page;
    const start = (page - 1) * size;
    return {
      page,
      size,
      totalPages,
      start,
      end: Math.min(start + size, total),
    };
  }

  function renderAssetPager(info, total) {
    if (!els.assetPager) return;
    els.assetPager.hidden = total <= 0;
    if (total <= 0) return;
    els.prevAssetPage.disabled = info.page <= 1;
    els.nextAssetPage.disabled = info.page >= info.totalPages;
    const from = total ? info.start + 1 : 0;
    els.assetPageInfo.textContent = `${info.page} / ${info.totalPages} · ${from}-${info.end} / ${total}`;
  }

  function renderSections() {
    els.assetSection.innerHTML = state.assetSections.map((section) =>
      `<option value="${escapeHtml(section.id)}">${escapeHtml(section.label)} (${(section.items || []).length})</option>`,
    ).join('');
    els.assetSection.value = state.activeSection;
  }

  function renderAssets() {
    const items = filteredAssets();
    const pageInfo = assetPageInfo(items.length);
    const pageItems = items.slice(pageInfo.start, pageInfo.end);
    state.assets = allSectionItems();
    els.assetGrid.textContent = '';
    if (!items.length) {
      els.assetGrid.className = 'grid empty';
      els.assetGrid.textContent = state.connected ? '没有匹配的图像素材。' : '连接 T8 后会显示素材。';
      renderAssetPager(pageInfo, 0);
      els.placeAsset.disabled = true;
      return;
    }
    els.assetGrid.className = 'grid';
    renderAssetPager(pageInfo, items.length);
    pageItems.forEach((item) => {
      const selected = item.id === state.selectedAssetId ? ' selected' : '';
      const thumb = item.thumbUrl || item.url;
      const card = document.createElement('div');
      card.className = `card${selected}`;
      card.setAttribute('data-id', String(item.id || ''));
      card.setAttribute('title', String(item.name || ''));
      card.setAttribute('role', 'button');
      card.tabIndex = 0;

      const thumbBox = document.createElement('div');
      thumbBox.className = 'thumb';
      if (thumb) {
        const img = document.createElement('img');
        img.alt = '';
        thumbBox.appendChild(img);
        loadImagePreview(img, thumbBox, thumb);
      } else {
        markPreviewBroken(thumbBox, '无预览');
      }

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = item.name || '图像';

      card.appendChild(thumbBox);
      card.appendChild(meta);
      card.addEventListener('click', () => {
        state.selectedAssetId = card.getAttribute('data-id') || '';
        renderAssets();
      });
      card.addEventListener('dblclick', () => placeSelectedAsset());
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          state.selectedAssetId = card.getAttribute('data-id') || '';
          renderAssets();
        }
      });
      els.assetGrid.appendChild(card);
    });
    els.placeAsset.disabled = !selectedAsset();
  }

  function renderProviders() {
    els.providerSelect.innerHTML = state.providers.map((provider) =>
      `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.label || provider.id)}</option>`,
    ).join('');
    if (!state.providerId && state.providers[0]) state.providerId = state.providers[0].id;
    els.providerSelect.value = state.providerId;
    renderModels();
  }

  function currentProvider() {
    return state.providers.find((provider) => provider.id === state.providerId) || state.providers[0] || null;
  }

  function renderModels() {
    const provider = currentProvider();
    const models = provider && Array.isArray(provider.imageModels) ? provider.imageModels : [];
    els.modelSelect.innerHTML = models.map((model) =>
      `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`,
    ).join('');
    if (!state.model && models[0]) state.model = models[0];
    if (!models.includes(state.model) && models[0]) state.model = models[0];
    els.modelSelect.value = state.model || '';
    els.runGenerate.disabled = !state.connected || !models.length;
  }

  function renderResults() {
    const items = state.results || [];
    if (!items.length) {
      els.generateResults.className = 'result-grid empty';
      els.generateResults.textContent = '生成结果会显示在这里。';
      return;
    }
    els.generateResults.className = 'result-grid';
    els.generateResults.textContent = '';
    items.forEach((item, index) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.setAttribute('data-index', String(index));
      card.setAttribute('title', String(item.name || item.url || ''));
      card.setAttribute('role', 'button');
      card.tabIndex = 0;

      const thumbBox = document.createElement('div');
      thumbBox.className = 'thumb';
      const img = document.createElement('img');
      img.alt = '';
      thumbBox.appendChild(img);
      loadImagePreview(img, thumbBox, item.url);

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `结果 ${index + 1}`;

      card.appendChild(thumbBox);
      card.appendChild(meta);
      card.addEventListener('dblclick', async () => {
        const item = state.results[Number(card.getAttribute('data-index'))];
        if (item) await ps.placeImage(item);
      });
      els.generateResults.appendChild(card);
    });
  }

  async function loadAssets() {
    if (!state.connected) return;
    setMsg(els.assetMsg, '正在加载素材 …');
    const json = await net.apiGet('/api/photoshop-bridge/library');
    state.assetSections = (json.data && json.data.sections) || [];
    if (!state.assetSections.some((section) => section.id === state.activeSection)) {
      state.activeSection = state.assetSections[0] ? state.assetSections[0].id : '';
    }
    renderSections();
    renderAssets();
    setMsg(els.assetMsg, `已加载 ${state.assetSections.reduce((n, section) => n + ((section.items || []).length), 0)} 个图像素材`, 'ok');
  }

  async function loadProviders() {
    if (!state.connected) return;
    const json = await net.apiGet('/api/photoshop-bridge/image-providers');
    state.providers = (json.data && json.data.providers) || [];
    renderProviders();
  }

  function scheduleCommandPoll(delay) {
    if (state.commandTimer) clearTimeout(state.commandTimer);
    state.commandTimer = setTimeout(pollCommands, delay || 1800);
  }

  async function handleCommand(command) {
    const commandName = command && (command.command || command.action || command.type);
    if (!command || commandName !== 'place-materials') return 0;
    const payload = command.payload && typeof command.payload === 'object' ? command.payload : {};
    const materials = Array.isArray(payload.materials)
      ? payload.materials
      : (Array.isArray(payload.items) ? payload.items : (Array.isArray(command.items) ? command.items : []));
    let placed = 0;
    for (const item of materials) {
      const kind = String((item && (item.kind || item.type)) || 'image').toLowerCase();
      if (item && kind === 'image' && item.url) {
        await ps.placeImage(item);
        placed += 1;
      }
    }
    return placed;
  }

  async function pollCommands() {
    if (!state.connected) return;
    if (state.commandBusy) {
      scheduleCommandPoll(2200);
      return;
    }
    state.commandBusy = true;
    try {
      const json = await net.apiGet('/api/photoshop-bridge/commands/pending?limit=6');
      const commands = (json.data && Array.isArray(json.data.commands)) ? json.data.commands : [];
      if (commands.length > 0) {
        setMsg(els.assetMsg, `正在从 T8 画布置入 ${commands.length} 个任务 …`);
      }
      let placed = 0;
      for (const command of commands) {
        const commandId = command.commandId || command.id;
        if (!commandId) continue;
        try {
          const count = await handleCommand(command);
          placed += count;
          await net.apiPost(`/api/photoshop-bridge/commands/${encodeURIComponent(commandId)}/complete`, { placed: count });
        } catch (err) {
          await net.apiPost(`/api/photoshop-bridge/commands/${encodeURIComponent(commandId)}/fail`, {
            error: err.message || String(err),
          }).catch(() => {});
          throw err;
        }
      }
      if (placed > 0) {
        setMsg(els.assetMsg, `已从 T8 画布置入 ${placed} 张图像。`, 'ok');
      }
    } catch (err) {
      if (state.connected) {
        setMsg(els.assetMsg, err.message || String(err), 'err');
        setMsg(els.settingsMsg, err.message || String(err), 'err');
      }
    } finally {
      state.commandBusy = false;
      scheduleCommandPoll(1800);
    }
  }

  function startCommandPolling() {
    scheduleCommandPoll(350);
  }

  async function connect() {
    try {
      setMsg(els.settingsMsg, '正在连接 T8 …');
      await net.connect(els.serverInput.value);
      setConnected(true);
      setMsg(els.settingsMsg, `已连接 ${state.host}`, 'ok');
      await Promise.all([loadAssets(), loadProviders()]);
      startCommandPolling();
    } catch (err) {
      setConnected(false);
      setMsg(els.settingsMsg, err.message || String(err), 'err');
    }
  }

  async function placeSelectedAsset() {
    const item = selectedAsset();
    if (!item) return;
    try {
      setMsg(els.assetMsg, '正在置入 Photoshop …');
      await ps.placeImage(item);
      setMsg(els.assetMsg, '已置入当前 Photoshop 文档。', 'ok');
    } catch (err) {
      setMsg(els.assetMsg, err.message || String(err), 'err');
    }
  }

  async function uploadCurrentToT8(options) {
    const preferLayer = !!els.uploadLayerToggle.checked;
    const exported = await ps.exportCurrentPng(preferLayer);
    const upload = await net.uploadPng(exported.buffer, {
      name: exported.layerName || exported.documentName || 'photoshop',
      mode: exported.layerName ? 'layer' : 'document',
      documentName: exported.documentName,
      layerName: exported.layerName,
      prompt: options && options.prompt,
      queue: options && Object.prototype.hasOwnProperty.call(options, 'queue') ? options.queue : true,
    });
    return { exported, upload: upload.data };
  }

  async function uploadCurrent() {
    try {
      setMsg(els.assetMsg, '正在导出并上传 …');
      const result = await uploadCurrentToT8({ queue: true });
      setMsg(els.assetMsg, `已上传到 T8: ${result.upload.url}`, 'ok');
      state.assetPage = 1;
      await loadAssets();
    } catch (err) {
      setMsg(els.assetMsg, err.message || String(err), 'err');
    }
  }

  async function runGenerate() {
    const prompt = String(els.promptInput.value || '').trim();
    if (!prompt) {
      setMsg(els.generateMsg, '请输入提示词。', 'err');
      return;
    }
    const provider = currentProvider();
    if (!provider || !state.model) {
      setMsg(els.generateMsg, '请先在 T8 API 设置中启用图像扩展平台。', 'err');
      return;
    }

    els.runGenerate.disabled = true;
    try {
      setMsg(els.generateMsg, state.generateMode === 'edit' ? '正在导出图层并编辑 …' : '正在生成 …');
      let refs = [];
      let exported = null;
      if (state.generateMode === 'edit') {
        const uploaded = await uploadCurrentToT8({ queue: false, prompt });
        exported = uploaded.exported;
        refs = [uploaded.upload.url];
      }
      const json = await net.apiPost('/api/photoshop-bridge/image', {
        providerId: provider.id,
        providerModel: state.model,
        model: state.model,
        prompt,
        size: els.sizeSelect.value,
        aspect_ratio: els.ratioSelect.value,
        images: refs,
        referenceImages: refs,
        syncToCanvas: els.syncCanvasToggle.checked,
        documentName: exported && exported.documentName,
        layerName: exported && exported.layerName,
      });
      const urls = (json.data && json.data.imageUrls) || [];
      state.results = urls.map((url, index) => ({ kind: 'image', url, name: `t8_ps_result_${index + 1}.png` }));
      renderResults();
      if (els.autoPlaceToggle.checked) {
        for (const item of state.results) await ps.placeImage(item);
      }
      setMsg(els.generateMsg, `完成 ${state.results.length} 张。${els.autoPlaceToggle.checked ? '已置入 PS。' : ''}`, 'ok');
      await loadAssets();
    } catch (err) {
      setMsg(els.generateMsg, err.message || String(err), 'err');
    } finally {
      renderModels();
    }
  }

  els.tabs.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab') || 'assets')));
  els.modeButtons.forEach((btn) => btn.addEventListener('click', () => {
    state.generateMode = btn.getAttribute('data-mode') || 'generate';
    els.modeButtons.forEach((item) => item.classList.toggle('active', item === btn));
  }));
  els.serverInput.value = state.host;
  els.uploadLayerToggle.checked = state.uploadLayer;
  els.uploadLayerToggle.addEventListener('change', () => {
    state.uploadLayer = els.uploadLayerToggle.checked;
    localStorage.setItem('t8.ps.uploadLayer', state.uploadLayer ? '1' : '0');
  });
  els.connectBtn.addEventListener('click', connect);
  els.refreshAssets.addEventListener('click', loadAssets);
  els.assetSection.addEventListener('change', () => {
    state.activeSection = els.assetSection.value;
    state.selectedAssetId = '';
    state.assetPage = 1;
    renderAssets();
  });
  els.assetSearch.addEventListener('input', () => {
    state.assetPage = 1;
    renderAssets();
  });
  els.prevAssetPage.addEventListener('click', () => {
    state.assetPage = Math.max(1, (Number(state.assetPage) || 1) - 1);
    renderAssets();
  });
  els.nextAssetPage.addEventListener('click', () => {
    state.assetPage = (Number(state.assetPage) || 1) + 1;
    renderAssets();
  });
  els.placeAsset.addEventListener('click', placeSelectedAsset);
  els.uploadCurrent.addEventListener('click', uploadCurrent);
  els.providerSelect.addEventListener('change', () => {
    state.providerId = els.providerSelect.value;
    state.model = '';
    renderModels();
  });
  els.modelSelect.addEventListener('change', () => {
    state.model = els.modelSelect.value;
  });
  els.runGenerate.addEventListener('click', runGenerate);
  els.openT8.addEventListener('click', () => ps.openUrl(canvasUrl()));
  ps.onDocChange(() => setConnected(state.connected));

  connect();
  } catch (error) {
    if (window.T8PS_REPORT_BOOT_ERROR) window.T8PS_REPORT_BOOT_ERROR(error, 'app.js');
    else throw error;
  }
})();
