const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const { getProjectDatabase, SubflowRevisionConflictError } = require('../services/projectDatabase');
const { getCollaborationGateway } = require('../collaboration/gateway');
const {
  DEFAULT_LIMITS,
  containsPlaintextSecret,
  createSubflowPackage,
  hydrateDependencyDefinitions,
  importSubflowPackage,
  inspectSubflowPackage,
} = require('../services/subflowPackage');
const {
  normalizeSubflowChangeSummary,
  publicSubflowPublication,
  validateSubflowDefinition,
} = require('../services/subflowDefinition');
const { createDerivedMedia, extensionInfo, previewStatePatchForJob, readMetadata, stableAssetId } = require('../services/assetIndexer');
const { getAssetPreviewPipeline } = require('../services/assetPreviewPipeline');
const { sendProjectDatabaseStorageCapacityError } = require('../services/projectDatabasePublicError');

const router = express.Router();
const packageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: DEFAULT_LIMITS.archiveBytes },
});

function runtimeDatabase() {
  return getProjectDatabase(config);
}

function runtimePreviewPipeline() {
  return getAssetPreviewPipeline(config, runtimeDatabase());
}

function runtimeCollaborationGateway() {
  return getCollaborationGateway(config);
}

function broadcastSubflowPublicationBestEffort(collaborationGateway, saved) {
  try {
    collaborationGateway.broadcastSubflowPublication(
      saved.projectId,
      saved.id,
      saved.version,
      {
        type: 'subflow.published',
        publication: publicSubflowPublication(saved),
      },
    );
    return [];
  } catch (_) {
    console.warn('[subflows] committed publication broadcast failed');
    return [{
      code: 'subflow_publication_broadcast_failed',
      message: '子工作流已成功保存，但实时协作通知暂未送达；客户端可通过版本列表重新同步。',
    }];
  }
}

function collectDependencyDefinitions(definition, environment = {}) {
  const projectDatabase = environment.database || runtimeDatabase();
  const collected = new Map();
  const visit = (current, stack = []) => {
    for (const node of current.nodes || []) {
      if (node?.type !== 'subflow') continue;
      const data = node.data && typeof node.data === 'object' ? node.data : {};
      const embedded = data.definition && typeof data.definition === 'object' ? data.definition : null;
      const projectId = String(data.definitionProjectId || embedded?.projectId || current.projectId || definition.projectId || 'project-local');
      const id = String(data.definitionId || embedded?.id || '');
      const version = Number(data.definitionVersion || embedded?.version || 0);
      const key = `${projectId}:${id}:${version}`;
      if (!id || !version) throw new Error(`嵌套子工作流节点缺少固定版本: ${String(node.id || '')}`);
      if (stack.includes(key)) throw new Error(`嵌套子工作流循环引用: ${[...stack, key].join(' -> ')}`);
      if (collected.has(key)) continue;
      const dependency = embedded || projectDatabase.getSubflowDefinition(id, version, projectId);
      if (!dependency) throw new Error(`找不到嵌套子工作流依赖: ${key}`);
      collected.set(key, dependency);
      visit(dependency, [...stack, key]);
    }
  };
  visit(definition);
  return [...collected.values()];
}

function collectPackageAssets(definition, environment = {}) {
  const projectDatabase = environment.database || runtimeDatabase();
  return (Array.isArray(definition.assetRefs) ? definition.assetRefs : []).map((assetRef) => {
    const asset = projectDatabase.getAsset(String(assetRef));
    if (!asset || asset.projectId !== String(definition.projectId || 'project-local')) throw new Error(`找不到同项目素材引用: ${String(assetRef)}`);
    if (!asset.managedPath || !fs.existsSync(asset.managedPath)) throw new Error(`素材原文件不存在: ${asset.filename}`);
    const license = String(asset.provenance?.license || asset.metadata?.license || '').trim();
    const redistributable = asset.provenance?.redistributable === true || asset.metadata?.redistributable === true;
    if (!license || !redistributable) throw new Error(`素材缺少可再分发许可: ${asset.filename}`);
    const extension = path.extname(asset.filename).toLowerCase();
    return {
      path: `assets/${String(asset.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}${extension}`,
      assetRef: asset.id,
      content: fs.readFileSync(asset.managedPath),
      license,
      redistributable: true,
    };
  });
}

function replaceAssetReferences(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => replaceAssetReferences(item, replacements));
  if (!value || typeof value !== 'object') return typeof value === 'string' && replacements.has(value) ? replacements.get(value) : value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceAssetReferences(item, replacements)]));
}

function rollbackImportedAssets(items, projectDatabase = null) {
  const targetDatabase = projectDatabase || runtimeDatabase();
  for (const item of [...(items || [])].reverse()) {
    if (item.previousAsset) targetDatabase.upsertAsset(item.previousAsset);
    else targetDatabase.removeAssetIndex(item.id);
    if (item.wasCreated) {
      try { fs.unlinkSync(item.path); } catch (_) {}
    }
  }
}

async function persistImportedAssets(imported, projectId, environment = {}) {
  const projectDatabase = environment.database || runtimeDatabase();
  const runtimeConfig = environment.config || config;
  const backgroundPreviewPipeline = environment.previewPipeline
    || (!environment.database && !environment.config ? runtimePreviewPipeline() : null);
  const root = path.join(runtimeConfig.INPUT_DIR, 'subflows', imported.archiveSha256.slice(0, 16));
  fs.mkdirSync(root, { recursive: true });
  const replacements = new Map();
  const created = [];
  try {
    for (const asset of imported.assets || []) {
      const extension = path.extname(asset.path).toLowerCase();
      const filename = `${asset.sha256.slice(0, 24)}${extension}`;
      const absolute = path.join(root, filename);
      const wasCreated = !fs.existsSync(absolute);
      if (wasCreated) fs.writeFileSync(absolute, asset.content, { flag: 'wx' });
      const stat = fs.statSync(absolute);
      const info = extensionInfo(absolute);
      let metadata;
      try { metadata = await readMetadata(absolute, info.kind, stat); } catch (error) { metadata = { size: stat.size, health: 'corrupt', metadataError: error?.message || String(error) }; }
      const supportsPreview = ['image', 'video', 'audio', 'model3d'].includes(info.kind);
      if (supportsPreview && metadata.health === 'corrupt') {
        metadata = { ...metadata, previewStatus: 'failed', previewError: '素材损坏，未加入预览队列' };
      } else if (backgroundPreviewPipeline && supportsPreview) {
        metadata = { ...metadata, previewStatus: 'queued' };
      } else {
        try { metadata = { ...metadata, ...await createDerivedMedia(absolute, info.kind, metadata, runtimeConfig, asset.sha256) }; } catch (error) { metadata = { ...metadata, previewStatus: 'failed', previewError: error?.message || String(error) }; }
      }
      const relativePath = path.relative(runtimeConfig.INPUT_DIR, absolute);
      const id = stableAssetId(`${String(projectId || 'project-local')}:input`, relativePath);
      const previousAsset = projectDatabase.getAsset(id);
      created.push({ id, path: absolute, wasCreated, previousAsset });
      const indexed = projectDatabase.upsertAsset({
        id, projectId, contentHash: asset.sha256, contentHashVerification: 'verified', kind: info.kind, mimeType: info.mimeType,
        filename, managedPath: absolute, sourceUrl: `/files/input/${relativePath.split(path.sep).map(encodeURIComponent).join('/')}`,
        availability: metadata.health === 'corrupt' ? 'corrupt' : 'available',
        metadata: { ...metadata, extension: info.extension, root: 'input', relativePath: relativePath.replace(/\\/g, '/'), license: asset.license, redistributable: true },
        provenance: { source: 't8flow-import', archiveSha256: imported.archiveSha256, license: asset.license, redistributable: true },
        createdBy: 'local-owner', createdAt: stat.birthtimeMs || stat.ctimeMs,
      });
      created[created.length - 1].indexed = indexed;
      replacements.set(asset.assetRef, indexed.id);
    }
  } catch (error) {
    rollbackImportedAssets(created, projectDatabase);
    throw error;
  }
  if (backgroundPreviewPipeline) {
    for (const item of created) {
      if (!item.indexed || item.indexed.availability !== 'available' || item.indexed.metadata?.health === 'corrupt'
        || !['image', 'video', 'audio', 'model3d'].includes(item.indexed.kind)) continue;
      try {
        const job = backgroundPreviewPipeline.enqueueAsset(item.indexed);
        projectDatabase.patchAssetPreviewState?.(item.indexed.id, item.indexed.contentHash, previewStatePatchForJob(job));
      } catch (_) {
        projectDatabase.patchAssetPreviewState?.(item.indexed.id, item.indexed.contentHash, {
          previewStatus: 'failed',
          previewError: '预览任务排队失败，可在素材中心重试',
        });
      }
    }
  }
  return { replacements, created };
}

router.get('/', (req, res) => {
  const database = runtimeDatabase();
  res.json({ success: true, data: database.listSubflowDefinitions({ projectId: req.query?.projectId, query: req.query?.query }) });
});

router.post('/', (req, res) => {
  try {
    const database = runtimeDatabase();
    const collaborationGateway = runtimeCollaborationGateway();
    validateSubflowDefinition(req.body);
    const projectId = String(req.body.projectId || 'project-local');
    const id = String(req.body.id || '');
    const head = database.getSubflowDefinitionHead(id, projectId);
    if (head && req.body.baseRevision == null) throw new Error('发布现有子工作流必须提供 baseRevision');
    const baseRevision = req.body.baseRevision == null ? 0 : Number(req.body.baseRevision);
    const changeSummary = normalizeSubflowChangeSummary(req.body.changeSummary, { required: true });
    const saved = database.saveSubflowDefinition(req.body, {
      expectedRevision: baseRevision,
      actorId: 'local-owner',
      sessionId: 'local-subflow-api',
      changeSummary,
    });
    const warnings = broadcastSubflowPublicationBestEffort(collaborationGateway, saved);
    res.status(201).json({
      success: true,
      data: saved,
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'subflow.definition.publish' })) return;
    if (error instanceof SubflowRevisionConflictError) {
      return res.status(409).json({ success: false, code: error.code, error: error.message, data: error.current });
    }
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.post('/package/inspect', packageUpload.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer) throw new Error('请选择 .t8flow 文件');
    const inspected = await inspectSubflowPackage(req.file.buffer);
    res.json({ success: true, data: inspected });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.post('/package/import', packageUpload.single('file'), async (req, res) => {
  let importedAssets = null;
  const database = runtimeDatabase();
  const collaborationGateway = runtimeCollaborationGateway();
  try {
    if (!req.file?.buffer) throw new Error('请选择 .t8flow 文件');
    if (!String(req.body?.archiveSha256 || '').trim()) throw new Error('导入前必须先检查并提供归档 SHA256');
    const imported = await importSubflowPackage(req.file.buffer, {
      expectedArchiveSha256: req.body.archiveSha256,
      projectId: req.body.projectId,
      preserveId: req.body.preserveId !== 'false',
      preserveVersion: false,
    });
    const projectId = String(req.body.projectId || imported.definition.projectId || 'project-local');
    importedAssets = await persistImportedAssets(imported, projectId);
    const hydrated = hydrateDependencyDefinitions(imported.definition, imported.dependencies, { projectId });
    const definition = replaceAssetReferences({ ...hydrated, projectId }, importedAssets.replacements);
    definition.assetRefs = (definition.assetRefs || []).map(String);
    delete definition.version;
    validateSubflowDefinition(definition);
    const head = database.getSubflowDefinitionHead(definition.id, projectId);
    const saved = database.saveSubflowDefinition(definition, {
      expectedRevision: head?.revision || 0,
      actorId: 'local-owner',
      sessionId: 'local-subflow-import',
      changeSummary: '导入 .t8flow 归档',
    });
    const warnings = broadcastSubflowPublicationBestEffort(collaborationGateway, saved);
    res.status(201).json({
      success: true,
      data: {
        definition: saved,
        archiveSha256: imported.archiveSha256,
        importedAssetIds: importedAssets.created.map((item) => item.id),
      },
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (error) {
    rollbackImportedAssets(importedAssets?.created || [], database);
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'subflow.package.import' })) return;
    if (error instanceof SubflowRevisionConflictError) {
      return res.status(409).json({ success: false, code: error.code, error: error.message, data: error.current });
    }
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.get('/:id/:version/package', async (req, res) => {
  try {
    const database = runtimeDatabase();
    const definition = database.getSubflowDefinition(req.params.id, req.params.version, req.query?.projectId);
    if (!definition) return res.status(404).json({ success: false, error: '子工作流定义不存在' });
    const archive = await createSubflowPackage(definition, collectPackageAssets(definition), collectDependencyDefinitions(definition));
    const safeName = String(definition.name || definition.id || 'subflow').replace(/[^\w\u4e00-\u9fff.-]+/g, '-').slice(0, 80) || 'subflow';
    res.setHeader('Content-Type', 'application/vnd.t8.subflow+zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName}-v${definition.version}.t8flow`)}`);
    res.setHeader('Content-Length', archive.length);
    res.end(archive);
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.get('/:id/versions', (req, res) => {
  const database = runtimeDatabase();
  res.json({ success: true, data: database.listSubflowVersions(req.params.id, req.query?.projectId) });
});

function sendDefinition(req, res) {
  const database = runtimeDatabase();
  const definition = database.getSubflowDefinition(req.params.id, req.params.version, req.query?.projectId);
  if (!definition) return res.status(404).json({ success: false, error: '子工作流定义不存在' });
  res.json({ success: true, data: definition });
}

router.get('/:id/:version', sendDefinition);
router.get('/:id', sendDefinition);

module.exports = router;
module.exports.validateDefinition = validateSubflowDefinition;
module.exports.containsPlaintextSecret = containsPlaintextSecret;
module.exports.collectDependencyDefinitions = collectDependencyDefinitions;
module.exports.collectPackageAssets = collectPackageAssets;
module.exports.persistImportedAssets = persistImportedAssets;
module.exports.rollbackImportedAssets = rollbackImportedAssets;
module.exports.replaceAssetReferences = replaceAssetReferences;
module.exports.broadcastSubflowPublicationBestEffort = broadcastSubflowPublicationBestEffort;
