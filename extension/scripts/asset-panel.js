(() => {
  const state = {
    tab: null,
    assets: [],
    selected: new Set(),
    failed: new Set(),
    busy: false,
  };

  const el = (id) => document.getElementById(id);
  const list = el('assetList');
  const status = el('status');
  const importButton = el('importButton');

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response || {});
      });
    });
  }

  function assetId(asset) {
    return String(asset.id || asset.url || asset.dataUrl || '');
  }

  function filteredAssets() {
    const minWidth = Math.max(0, Number(el('minWidth').value) || 0);
    const minHeight = Math.max(0, Number(el('minHeight').value) || 0);
    return state.assets.filter((asset) => (!asset.width || asset.width >= minWidth) && (!asset.height || asset.height >= minHeight));
  }

  function setStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle('error', error);
  }

  function updateCounts() {
    const visible = filteredAssets();
    const selected = visible.filter((asset) => state.selected.has(assetId(asset))).length;
    el('counts').textContent = `${visible.length} 项 · 已选 ${selected}`;
    importButton.disabled = state.busy || selected === 0;
  }

  function render() {
    const assets = filteredAssets();
    list.replaceChildren();
    if (!assets.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = state.assets.length ? '没有符合尺寸筛选的图片。' : '尚未扫描到素材。';
      list.appendChild(empty);
      updateCounts();
      return;
    }

    const fragment = document.createDocumentFragment();
    assets.forEach((asset) => {
      const id = assetId(asset);
      const card = document.createElement('label');
      card.className = 'asset';
      card.dataset.selected = String(state.selected.has(id));
      card.dataset.failed = String(state.failed.has(id));

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.selected.has(id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selected.add(id);
        else state.selected.delete(id);
        card.dataset.selected = String(checkbox.checked);
        updateCounts();
      });

      const image = document.createElement('img');
      image.src = asset.previewUrl || asset.dataUrl || asset.url;
      image.alt = asset.name || '网页素材';
      image.loading = 'lazy';

      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.title = asset.name || asset.url || '';
      name.textContent = asset.name || '网页图片';
      const size = document.createElement('div');
      size.className = 'size';
      size.textContent = asset.width && asset.height ? `${asset.width}×${asset.height} · ${asset.source || 'image'}` : (asset.source || 'image');
      meta.append(name, size);
      card.append(checkbox, image, meta);
      fragment.appendChild(card);
    });
    list.appendChild(fragment);
    updateCounts();
  }

  async function scan() {
    if (!state.tab?.id || state.busy) return;
    state.busy = true;
    el('scanButton').disabled = true;
    setStatus('正在扫描当前页面...');
    try {
      const response = await runtimeMessage({
        action: 't8WebAssets.scan',
        tabId: state.tab.id,
        autoScroll: el('autoScroll').checked,
      });
      if (!response.ok) throw new Error(response.error || '扫描失败');
      state.assets = Array.isArray(response.assets) ? response.assets.slice(0, 200) : [];
      state.selected = new Set(state.assets.map(assetId));
      state.failed.clear();
      setStatus(`扫描完成，共发现 ${state.assets.length} 项。`);
      render();
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      state.busy = false;
      el('scanButton').disabled = false;
      updateCounts();
    }
  }

  async function capture() {
    if (!state.tab?.id || state.busy) return;
    state.busy = true;
    setStatus('正在截取当前视口...');
    try {
      const response = await runtimeMessage({ action: 't8WebAssets.capture', tabId: state.tab.id, windowId: state.tab.windowId });
      if (!response.ok || !response.dataUrl) throw new Error(response.error || '截图失败');
      const asset = {
        id: `screenshot-${Date.now()}`,
        dataUrl: response.dataUrl,
        previewUrl: response.dataUrl,
        name: `viewport-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
        width: response.width || 0,
        height: response.height || 0,
        source: 'screenshot',
      };
      state.assets.unshift(asset);
      state.selected.add(asset.id);
      setStatus('已加入当前视口截图。');
      render();
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      state.busy = false;
      updateCounts();
    }
  }

  async function importSelected() {
    const selected = state.assets.filter((asset) => state.selected.has(assetId(asset))).slice(0, 50);
    if (!selected.length || state.busy) return;
    state.busy = true;
    state.failed.clear();
    updateCounts();
    setStatus(`正在导入 ${selected.length} 项...`);
    try {
      const response = await runtimeMessage({
        action: 't8WebAssets.import',
        tabId: state.tab.id,
        pageUrl: state.tab.url || '',
        pageTitle: state.tab.title || '',
        assets: selected,
      });
      const failures = Array.isArray(response.failures) ? response.failures : [];
      failures.forEach((failure) => {
        const source = selected[failure.index];
        if (source) state.failed.add(assetId(source));
      });
      if (!response.ok) throw new Error(response.error || '导入失败');
      setStatus(failures.length
        ? `已导入 ${response.imported || 0} 项，${failures.length} 项失败；失败项仍保持选中，可重试。`
        : `已导入 ${response.imported || selected.length} 项并发送到 T8 画布。`, failures.length > 0);
      render();
    } catch (error) {
      setStatus(error.message || String(error), true);
      render();
    } finally {
      state.busy = false;
      updateCounts();
    }
  }

  el('scanButton').addEventListener('click', scan);
  el('captureButton').addEventListener('click', capture);
  el('selectAll').addEventListener('click', () => {
    filteredAssets().forEach((asset) => state.selected.add(assetId(asset)));
    render();
  });
  el('clearSelection').addEventListener('click', () => {
    filteredAssets().forEach((asset) => state.selected.delete(assetId(asset)));
    render();
  });
  el('minWidth').addEventListener('input', render);
  el('minHeight').addEventListener('input', render);
  importButton.addEventListener('click', importSelected);
  el('openSidePanel')?.addEventListener('click', async () => {
    const response = await runtimeMessage({ action: 't8WebAssets.openSidePanel', windowId: state.tab?.windowId });
    if (!response.ok) setStatus(response.error || '无法打开侧栏', true);
    else window.close();
  });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    state.tab = tabs[0] || null;
    el('pageTitle').textContent = state.tab?.title || '当前页面';
    scan();
  });
})();
