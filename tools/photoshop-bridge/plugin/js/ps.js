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
  const constants = photoshop.constants || {};
  const fs = uxp.storage && uxp.storage.localFileSystem;
  const formats = uxp.storage && uxp.storage.formats;
  const shell = uxp.shell;
  const net = T8PS.net;

  function errorText(error, fallback) {
    if (error && typeof error.message === 'string' && error.message.trim()) return error.message.trim();
    if (typeof error === 'string' && error.trim()) return error.trim();
    return fallback || '未知 Photoshop 错误';
  }

  function assertBatchPlaySucceeded(results, fallback) {
    const list = Array.isArray(results) ? results : [];
    const failed = list.find((entry) => entry && (
      String(entry._obj || '').toLowerCase() === 'error' ||
      (typeof entry.result === 'number' && entry.result < 0)
    ));
    if (failed) throw new Error(errorText(failed, fallback));
  }

  function activeLayerInfo() {
    const available = !!(
      app &&
      core && typeof core.executeAsModal === 'function' &&
      action && typeof action.batchPlay === 'function' &&
      fs && typeof fs.getTemporaryFolder === 'function'
    );
    try {
      const doc = app.activeDocument;
      const layers = doc && doc.activeLayers;
      const layer = layers && layers.length ? layers[0] : null;
      return {
        available,
        hasDocument: !!doc,
        hasLayer: !!layer,
        documentId: doc && doc.id != null ? doc.id : null,
        documentName: doc && doc.name ? String(doc.name) : '',
        layerId: layer && layer.id != null ? layer.id : null,
        layerName: layer && layer.name ? String(layer.name) : '',
      };
    } catch (error) {
      return {
        available,
        hasDocument: false,
        hasLayer: false,
        documentId: null,
        documentName: '',
        layerId: null,
        layerName: '',
        error: errorText(error),
      };
    }
  }

  function isThirtyTwoBit(value) {
    const expected = constants.BitsPerChannelType && constants.BitsPerChannelType.THIRTYTWO;
    if (expected != null && value === expected) return true;
    if (typeof value === 'number') return value === 32;
    return /(?:thirty.?two|32)/i.test(String(value == null ? '' : value));
  }

  function modeMatches(value, names) {
    const modes = constants.DocumentMode || {};
    if (names.some((name) => modes[name] != null && value === modes[name])) return true;
    const text = String(value == null ? '' : value);
    return names.some((name) => {
      if (name === 'GRAYSCALE') return /gray|grey/i.test(text);
      if (name === 'BITMAP') return /bitmap/i.test(text);
      if (name === 'INDEXEDCOLOR') return /indexed/i.test(text);
      return new RegExp(name, 'i').test(text);
    });
  }

  function needsRgbConversionForPng(value) {
    if (modeMatches(value, ['RGB', 'GRAYSCALE', 'BITMAP', 'INDEXEDCOLOR'])) return false;
    return modeMatches(value, ['CMYK', 'LAB', 'DUOTONE', 'MULTICHANNEL']);
  }

  async function normalizeTemporaryDocumentForPng(doc) {
    if (isThirtyTwoBit(doc.bitsPerChannel)) {
      const eightBit = constants.BitsPerChannelType && constants.BitsPerChannelType.EIGHT;
      if (eightBit == null) throw new Error('当前 Photoshop 无法把 32 位图层转换为 PNG 支持的位深');
      doc.bitsPerChannel = eightBit;
    }
    if (doc.mode != null && needsRgbConversionForPng(doc.mode)) {
      const rgbMode = constants.ChangeMode && constants.ChangeMode.RGB;
      if (rgbMode == null || typeof doc.changeMode !== 'function') {
        throw new Error('当前 Photoshop 无法把图层颜色模式转换为 RGB');
      }
      await doc.changeMode(rgbMode);
    }
  }

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
    await core.executeAsModal(async (executionContext) => {
      const srcDoc = app.activeDocument;
      if (!srcDoc) throw new Error('没有打开的 Photoshop 文档');
      const srcId = srcDoc.id;
      docName = srcDoc.name || docName;
      const layers = srcDoc.activeLayers || [];
      if (!layers.length) throw new Error('请先选中要上传或编辑的图层');
      const selectedLayer = layers[0];
      layerName = selectedLayer.name || layerName;
      const layerId = selectedLayer.id == null ? Number.NaN : Number(selectedLayer.id);
      const using = Number.isFinite(layerId)
        ? { _ref: 'layer', _id: layerId }
        : { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' };
      const makeResult = await action.batchPlay([{
        _obj: 'make',
        _target: [{ _ref: 'document' }],
        name: 't8_tmp_layer_export',
        using,
        version: 5,
        _options: { dialogOptions: 'dontDisplay' },
      }], { synchronousExecution: true });
      assertBatchPlaySucceeded(makeResult, 'Photoshop 无法从当前图层创建临时文档');
      const tmpDoc = app.activeDocument;
      if (!tmpDoc || tmpDoc.id === srcId) throw new Error('未能从当前图层创建临时文档');
      const hostControl = executionContext && executionContext.hostControl;
      let autoCloseRegistered = false;
      if (hostControl && typeof hostControl.registerAutoCloseDocument === 'function') {
        try {
          await hostControl.registerAutoCloseDocument(tmpDoc.id);
          autoCloseRegistered = true;
        } catch (_) {
          // Fall back to explicit close for older or incomplete host implementations.
        }
      }
      let operationError = null;
      try {
        await normalizeTemporaryDocumentForPng(tmpDoc);
        await tmpDoc.saveAs.png(file, {}, true);
      } catch (error) {
        operationError = error;
      }
      if (!autoCloseRegistered) {
        try {
          await tmpDoc.closeWithoutSaving();
        } catch (closeError) {
          if (!operationError) operationError = closeError;
        }
      }
      if (operationError) throw operationError;
    }, { commandName: 'T8 导出当前图层' });
    const buffer = await file.read({ format: formats.binary });
    if (!buffer || typeof buffer.byteLength !== 'number' || buffer.byteLength <= 0) {
      throw new Error('当前图层导出结果为空，请确认图层可见且包含可渲染内容');
    }
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

  T8PS.ps = { hasDocument, activeLayerInfo, placeImage, exportCurrentPng, openUrl, onDocChange };
  } catch (error) {
    report(error);
    const unavailable = async () => {
      throw new Error(`Photoshop API 初始化失败：${error && error.message ? error.message : String(error)}`);
    };
    T8PS.ps = {
      hasDocument: () => false,
      activeLayerInfo: () => ({
        available: false,
        hasDocument: false,
        hasLayer: false,
        documentId: null,
        documentName: '',
        layerId: null,
        layerName: '',
        error: error && error.message ? error.message : String(error),
      }),
      placeImage: unavailable,
      exportCurrentPng: unavailable,
      openUrl: unavailable,
      onDocChange: () => {},
    };
  }
})();
