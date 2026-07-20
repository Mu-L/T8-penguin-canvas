(function () {
  function report(error) {
    if (window.T8PS_REPORT_BOOT_ERROR) window.T8PS_REPORT_BOOT_ERROR(error, 'ps.js');
  }

  try {
  const photoshop = require('photoshop');
  const uxp = require('uxp');
  const app = photoshop.app || {};
  const core = photoshop.core || {};
  const action = photoshop.action || {};
  const fs = uxp.storage && uxp.storage.localFileSystem;
  const formats = uxp.storage && uxp.storage.formats;
  const shell = uxp.shell;
  const net = T8PS.net;

  function hasDocument() {
    return !!(app.documents && app.documents.length > 0);
  }

  function activeDocumentId() {
    try {
      return app.activeDocument && app.activeDocument.id;
    } catch (_) {
      return null;
    }
  }

  function activeLayerCount() {
    try {
      const doc = app.activeDocument;
      if (!doc || !doc.layers || typeof doc.layers.length !== 'number') return null;
      return doc.layers.length;
    } catch (_) {
      return null;
    }
  }

  async function downloadToTemp(item) {
    const buffer = await net.fetchBytes(item.url);
    const cleanUrl = String(item.url || '').split(/[?#]/)[0];
    let ext = cleanUrl.split('.').pop() || 'png';
    if (!/^[a-z0-9]{1,5}$/i.test(ext)) ext = 'png';
    const safe = String(item.name || 't8_asset').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 48) || 't8_asset';
    const folder = await fs.getTemporaryFolder();
    const file = await folder.createFile(`t8_${safe}_${Date.now()}.${ext}`, { overwrite: true });
    await file.write(buffer, { format: formats.binary });
    return file;
  }

  async function placeImage(item) {
    const file = await downloadToTemp(item);
    const token = await fs.createSessionToken(file);
    const hadDocument = hasDocument();
    const beforeDocId = activeDocumentId();
    const beforeLayers = activeLayerCount();
    let openedDocument = false;
    let batchResult = null;
    await core.executeAsModal(async () => {
      if (!app.documents.length) {
        await app.open(file);
        openedDocument = true;
        return;
      }
      batchResult = await action.batchPlay([{
        _obj: 'placeEvent',
        null: { _path: token, _kind: 'local' },
        linked: false,
        freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
        offset: {
          _obj: 'offset',
          horizontal: { _unit: 'pixelsUnit', _value: 0 },
          vertical: { _unit: 'pixelsUnit', _value: 0 },
        },
        _options: { dialogOptions: 'dontDisplay' },
      }], { synchronousExecution: true, modalBehavior: 'execute' });
    }, { commandName: 'T8 置入图像' });

    const afterLayers = activeLayerCount();
    const afterDocId = activeDocumentId();
    if (
      hadDocument &&
      beforeDocId &&
      afterDocId === beforeDocId &&
      beforeLayers !== null &&
      afterLayers !== null &&
      afterLayers <= beforeLayers
    ) {
      throw new Error('Photoshop 置入后未新增图层，请在 PS 面板重试或检查当前文档是否可编辑。');
    }
    return {
      placed: true,
      openedDocument,
      beforeLayers,
      afterLayers,
      batchResultCount: Array.isArray(batchResult) ? batchResult.length : 0,
    };
  }

  async function exportDocumentPng() {
    const folder = await fs.getTemporaryFolder();
    const file = await folder.createFile(`t8_doc_${Date.now()}.png`, { overwrite: true });
    let docName = 'Photoshop Document';
    await core.executeAsModal(async () => {
      const doc = app.activeDocument;
      if (!doc) throw new Error('没有打开的 Photoshop 文档');
      docName = doc.name || docName;
      await doc.saveAs.png(file, {}, true);
    }, { commandName: 'T8 导出文档' });
    const buffer = await file.read({ format: formats.binary });
    return { buffer, documentName: docName, layerName: '' };
  }

  async function exportActiveLayerPng() {
    const folder = await fs.getTemporaryFolder();
    const file = await folder.createFile(`t8_layer_${Date.now()}.png`, { overwrite: true });
    let docName = 'Photoshop Document';
    let layerName = 'Layer';
    await core.executeAsModal(async () => {
      const srcDoc = app.activeDocument;
      if (!srcDoc) throw new Error('没有打开的 Photoshop 文档');
      const srcId = srcDoc.id;
      docName = srcDoc.name || docName;
      const layers = srcDoc.activeLayers || [];
      if (!layers.length) throw new Error('请先选中要上传或编辑的图层');
      layerName = layers[0].name || layerName;
      await action.batchPlay([{
        _obj: 'make',
        _target: [{ _ref: 'document' }],
        name: 't8_tmp_layer_export',
        using: {
          _ref: [
            { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
            { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' },
          ],
        },
      }], { synchronousExecution: true });
      const tmpDoc = app.activeDocument;
      if (!tmpDoc || tmpDoc.id === srcId) throw new Error('未能从当前图层创建临时文档');
      await tmpDoc.saveAs.png(file, {}, true);
      await tmpDoc.closeWithoutSaving();
    }, { commandName: 'T8 导出当前图层' });
    const buffer = await file.read({ format: formats.binary });
    return { buffer, documentName: docName, layerName };
  }

  async function exportCurrentPng(preferLayer) {
    if (preferLayer) return exportActiveLayerPng();
    return exportDocumentPng();
  }

  async function openUrl(url) {
    await shell.openExternal(url);
  }

  function onDocChange(cb) {
    try {
      if (action && typeof action.addNotificationListener === 'function') {
        action.addNotificationListener(['open', 'close', 'select', 'newDocument'], cb);
      }
    } catch (e) {
      // Older Photoshop versions may not expose every notification.
    }
  }

  T8PS.ps = { hasDocument, placeImage, exportCurrentPng, openUrl, onDocChange };
  } catch (error) {
    report(error);
    const unavailable = async () => {
      throw new Error(`Photoshop API 初始化失败：${error && error.message ? error.message : String(error)}`);
    };
    T8PS.ps = {
      hasDocument: () => false,
      placeImage: unavailable,
      exportCurrentPng: unavailable,
      openUrl: unavailable,
      onDocChange: () => {},
    };
  }
})();
