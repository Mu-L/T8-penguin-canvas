const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { DEFAULT_PROJECT_ID } = require('../collaboration/protocol');
const { getProjectDatabase } = require('../services/projectDatabase');
const { getBackgroundAssetIndexer } = require('../services/assetIndexer');
const { getAssetPreviewPipeline } = require('../services/assetPreviewPipeline');
const { getAssetBlobStore } = require('../services/assetBlobStore');
const { getAssetSemanticPipeline, normalizeSemanticText } = require('../services/assetSemanticPipeline');
const { getPublicSemanticModel } = require('../services/assetSemanticModels');
const {
  publicAsset,
  publicAssetLineageList,
  publicAssetSourceGraph,
  redactLocalPaths,
  sanitizePublicValue,
} = require('../services/assetPublicView');

const router = express.Router();
const database = getProjectDatabase(config);
const previewPipeline = getAssetPreviewPipeline(config, database);
const indexer = getBackgroundAssetIndexer(config, database, previewPipeline);
const semanticPipeline = getAssetSemanticPipeline(config, database);
const blobStore = getAssetBlobStore(config);

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || '').toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLoopbackHostname(value) {
  const hostname = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isTrustedSemanticRequest(req) {
  if (!isLoopbackRequest(req)) return false;
  const host = String(req.headers?.host || '').trim();
  if (!host) return false;
  try {
    const authority = new URL(`http://${host}`);
    if (!isLoopbackHostname(authority.hostname) || authority.username || authority.password) return false;
  } catch (_) {
    return false;
  }
  const fetchSite = String(req.headers?.['sec-fetch-site'] || '').trim().toLowerCase();
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) return false;
  const origin = String(req.headers?.origin || '').trim();
  if (!origin) return true; // Native loopback clients do not send browser Origin headers.
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol)
      && !parsed.username
      && !parsed.password
      && isLoopbackHostname(parsed.hostname);
  } catch (_) {
    return false;
  }
}

function requireSemanticJsonMutation(req, res) {
  const contentType = String(req.headers?.['content-type'] || '').trim().toLowerCase();
  if (/^application\/json(?:\s*;|$)/.test(contentType)) return true;
  res.status(415).json({ success: false, error: '语义管理操作只接受 application/json', code: 'semantic_json_required' });
  return false;
}

function publicErrorMessage(error, fallback = '素材操作失败') {
  return redactLocalPaths(error?.message || String(error || fallback)) || fallback;
}

function errorStatus(error, fallback = 400) {
  return /(?:[_-]conflict|[_-]in[_-](?:progress|use))$/.test(String(error?.code || '')) ? 409 : fallback;
}

function publicErrorBody(error, fallback = '素材操作失败') {
  const body = { success: false, error: publicErrorMessage(error, fallback) };
  const code = String(error?.code || '').trim().replace(/-/g, '_').slice(0, 120);
  if (/^[a-z0-9_]+$/i.test(code)) body.code = code;
  if (error?.current && typeof error.current === 'object') {
    const current = {};
    for (const key of [
      'id', 'assetId', 'projectId', 'revision', 'organizationRevision',
      'catalogRevision', 'graphRevision', 'lineageRevision', 'decision', 'updatedAt',
    ]) {
      const value = error.current[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') current[key] = value;
    }
    if (Object.keys(current).length) body.current = current;
  }
  return body;
}

function requireLoopback(req, res, message = '该素材管理操作只允许从主机本地执行') {
  if (isTrustedSemanticRequest(req) && requireSemanticJsonMutation(req, res)) return true;
  if (res.headersSent) return false;
  res.status(403).json({ success: false, error: message, code: 'trusted_loopback_required' });
  return false;
}

router.use('/semantic', (req, res, next) => {
  if (isTrustedSemanticRequest(req)) return next();
  return res.status(403).json({
    success: false,
    error: '语义接口只接受可信的本机回环来源',
    code: 'trusted_loopback_required',
  });
});

function semanticInstallState(value) {
  const normalized = String(value || '').toLowerCase().replace(/_/g, '-');
  if (['invalid', 'cancelled'].includes(normalized)) return 'error';
  if (normalized === 'missing') return 'not-installed';
  if (['not-installed', 'downloading', 'verifying', 'installed', 'failed', 'error', 'disabled', 'deleting'].includes(normalized)) return normalized;
  return 'not-installed';
}

function publicSemanticModel(model) {
  let manifest = null;
  try {
    manifest = getPublicSemanticModel(String(model?.modelId || model?.modelKey || model?.key || ''));
  } catch (_) {}
  const installState = semanticInstallState(model?.status || model?.state || model?.installState);
  const error = model?.error?.message || model?.errorMessage || model?.error || null;
  return {
    key: String(model?.modelId || model?.modelKey || model?.key || ''),
    capability: String(model?.task || model?.capability || manifest?.task || ''),
    label: String(model?.displayName || model?.label || manifest?.displayName || model?.modelId || model?.modelKey || ''),
    version: String(model?.version || model?.modelVersion || manifest?.revision || ''),
    revision: model?.revision ?? 1,
    installState,
    installed: Boolean(model?.installed || installState === 'installed'),
    downloadedBytes: Math.max(0, Number(model?.downloadedBytes) || 0),
    totalBytes: Math.max(0, Number(model?.totalBytes || model?.downloadBytes || manifest?.downloadBytes) || 0),
    error: error ? normalizeSemanticText(redactLocalPaths(String(error)), 600) || null : null,
    updatedAt: model?.updatedAt || null,
  };
}

function publicSemanticCounts(value) {
  const counts = value && typeof value === 'object' ? value : {};
  return Object.fromEntries([
    'queued', 'running', 'retrying', 'succeeded', 'skipped', 'failed', 'superseded', 'total',
  ].map((key) => [key, Math.max(0, Math.trunc(Number(counts[key]) || 0))]));
}

function publicSemanticGeneration(generation) {
  if (!generation || typeof generation !== 'object') return null;
  const error = generation.error?.message || generation.errorMessage || generation.error || null;
  return {
    projectId: String(generation.projectId || ''),
    generation: Math.max(0, Math.trunc(Number(generation.generation) || 0)),
    revision: Math.max(0, Math.trunc(Number(generation.revision) || 0)),
    profileRevision: Math.max(0, Math.trunc(Number(generation.profileRevision) || 0)),
    catalogRevision: Math.max(0, Math.trunc(Number(generation.catalogRevision) || 0)),
    jobsSealed: Boolean(generation.jobsSealed),
    expectedJobCount: Math.max(0, Math.trunc(Number(generation.expectedJobCount) || 0)),
    eligibleAssetCount: Math.max(0, Math.trunc(Number(generation.eligibleAssetCount) || 0)),
    excludedAssetCount: Math.max(0, Math.trunc(Number(generation.excludedAssetCount) || 0)),
    payloadPrunedAt: generation.payloadPrunedAt == null ? null : Number(generation.payloadPrunedAt),
    status: ['building', 'ready', 'active', 'failed', 'superseded'].includes(String(generation.status))
      ? String(generation.status)
      : 'failed',
    counts: publicSemanticCounts(generation.counts),
    error: error ? normalizeSemanticText(redactLocalPaths(String(error)), 600) || null : null,
    createdAt: generation.createdAt == null ? null : Number(generation.createdAt),
    updatedAt: generation.updatedAt == null ? null : Number(generation.updatedAt),
    finishedAt: generation.finishedAt == null ? null : Number(generation.finishedAt),
  };
}

function publicSemanticJob(job) {
  if (!job || typeof job !== 'object') return null;
  const error = job.error?.message || job.errorMessage || job.error || null;
  return {
    id: String(job.id || ''),
    projectId: String(job.projectId || ''),
    assetId: String(job.assetId || ''),
    generation: Math.max(0, Math.trunc(Number(job.generation) || 0)),
    jobKind: String(job.jobKind || ''),
    modelKey: String(job.modelKey || ''),
    modelVersion: String(job.modelVersion || ''),
    status: String(job.status || ''),
    revision: Math.max(0, Math.trunc(Number(job.revision) || 0)),
    attemptCount: Math.max(0, Math.trunc(Number(job.attemptCount) || 0)),
    maxAttempts: Math.max(1, Math.trunc(Number(job.maxAttempts) || 1)),
    nextAttemptAt: job.nextAttemptAt == null ? null : Number(job.nextAttemptAt),
    error: error ? normalizeSemanticText(redactLocalPaths(String(error)), 600) || null : null,
    createdAt: job.createdAt == null ? null : Number(job.createdAt),
    startedAt: job.startedAt == null ? null : Number(job.startedAt),
    updatedAt: job.updatedAt == null ? null : Number(job.updatedAt),
    finishedAt: job.finishedAt == null ? null : Number(job.finishedAt),
  };
}

function countSemanticJobsByCapability(jobs = []) {
  const initial = () => ({ eligible: 0, queued: 0, running: 0, succeeded: 0, skipped: 0, failed: 0 });
  const result = { caption: initial(), ocr: initial(), embedding: initial() };
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const capability = result[job.jobKind];
    if (!capability) continue;
    capability.eligible += 1;
    const status = String(job.status || '').toLowerCase();
    if (status === 'retrying') capability.queued += 1;
    else if (Object.hasOwn(capability, status)) capability[status] += 1;
    else if (status === 'superseded') capability.failed += 1;
  }
  return result;
}

function publicSemanticStatus(raw) {
  const profile = raw.profile || {};
  const models = (Array.isArray(raw.models) ? raw.models : []).map(publicSemanticModel);
  const generation = raw.building || raw.failedGeneration || raw.activeGenerationRecord || null;
  const aggregate = raw.jobs?.byCapability;
  const counts = aggregate
    ? Object.fromEntries(['caption', 'ocr', 'embedding'].map((name) => {
      const value = aggregate[name] || {};
      return [name, {
        eligible: Math.max(0, Number(value.total) || 0),
        queued: Math.max(0, Number(value.queued) || 0) + Math.max(0, Number(value.retrying) || 0),
        running: Math.max(0, Number(value.running) || 0),
        succeeded: Math.max(0, Number(value.succeeded) || 0),
        skipped: Math.max(0, Number(value.skipped) || 0),
        failed: Math.max(0, Number(value.failed) || 0) + Math.max(0, Number(value.superseded) || 0),
      }];
    }))
    : countSemanticJobsByCapability(generation
      ? database.listAssetSemanticJobs({ projectId: raw.projectId, generation: generation.generation, limit: 500 })
      : []);
  const capability = (name) => {
    const configured = profile[name] || {};
    const modelKey = String(configured.modelKey || '');
    const model = models.find((entry) => entry.key === modelKey) || null;
    return {
      capability: name,
      enabled: Boolean(profile.enabled && configured.enabled),
      modelKey,
      modelVersion: String(configured.modelVersion || model?.version || ''),
      model,
      ...counts[name],
    };
  };
  const activeGeneration = Math.max(0, Number(profile.activeGeneration) || 0);
  const buildingGeneration = profile.buildingGeneration == null ? null : Math.max(0, Number(profile.buildingGeneration) || 0);
  const hasEnabledCapability = ['caption', 'ocr', 'embedding'].some((name) => Boolean(profile.enabled && profile[name]?.enabled));
  const embeddingEnabled = Boolean(profile.enabled && profile.embedding?.enabled);
  let indexState = 'empty';
  if (!hasEnabledCapability) indexState = 'disabled';
  else if (raw.building) indexState = 'building';
  else if (raw.failedGeneration) indexState = raw.activeGenerationRecord
    ? (raw.indexStale ? 'stale' : 'degraded')
    : 'error';
  else if (['ready', 'active'].includes(raw.activeGenerationRecord?.status)) {
    if (raw.indexStale) indexState = 'stale';
    else indexState = embeddingEnabled && Number(counts.embedding?.succeeded || 0) === 0 ? 'empty' : 'ready';
  }
  else if (raw.activeGenerationRecord?.status === 'failed') indexState = 'error';
  return {
    project: {
      projectId: String(raw.projectId || ''),
      revision: profile.revision ?? 1,
      enabled: Boolean(profile.enabled),
      activeGeneration,
      activeIndexRevision: raw.activeGenerationRecord?.revision || (raw.activeGenerationRecord ? `${raw.activeGenerationRecord.generation}:${raw.activeGenerationRecord.updatedAt || raw.activeGenerationRecord.createdAt || 0}` : ''),
      activeCatalogRevision: raw.activeGenerationRecord?.catalogRevision ?? 0,
      currentCatalogRevision: raw.currentCatalogRevision ?? 0,
      buildingGeneration,
      indexState,
      indexStale: Boolean(raw.indexStale),
      capabilities: {
        caption: capability('caption'),
        ocr: capability('ocr'),
        embedding: capability('embedding'),
      },
      updatedAt: profile.updatedAt || null,
    },
    models,
    rebuild: publicSemanticGeneration(raw.building || raw.failedGeneration || raw.activeGenerationRecord),
    worker: {
      active: Math.max(0, Number(raw.workerActive) || 0),
      concurrency: Math.max(1, Number(raw.concurrency) || 1),
    },
  };
}

function publicSemanticEvidence(match) {
  const metadata = match?.metadata && typeof match.metadata === 'object'
    ? sanitizePublicValue(match.metadata, {}, 0, 'metadata') || {}
    : {};
  return {
    source: String(match?.sourceKind || match?.source || match?.kind || 'metadata').slice(0, 40),
    snippet: normalizeSemanticText(match?.snippet || match?.text || '', 320),
    language: match?.language ? String(match.language).slice(0, 40) : undefined,
    modelKey: match?.modelKey ? String(match.modelKey).slice(0, 120) : undefined,
    modelVersion: match?.modelVersion ? String(match.modelVersion).slice(0, 120) : undefined,
    frameIndex: Number.isInteger(metadata.frameIndex) ? metadata.frameIndex : undefined,
    time: Number.isFinite(metadata.time) ? metadata.time : undefined,
    page: Number.isInteger(metadata.page) ? metadata.page : undefined,
    bbox: Array.isArray(metadata.bbox) && metadata.bbox.length === 4 ? metadata.bbox.map(Number) : undefined,
  };
}

function requireExpectedRevision(req, res, options = {}) {
  const raw = req.body?.expectedRevision;
  const revision = Number(raw);
  const minimum = options.allowZero ? 0 : 1;
  if (!Object.hasOwn(req.body || {}, 'expectedRevision')) {
    res.status(400).json({ success: false, error: '缺少 expectedRevision', code: 'expected_revision_required' });
    return false;
  }
  if (!Number.isInteger(revision) || revision < minimum) {
    res.status(400).json({ success: false, error: options.allowZero ? 'expectedRevision 必须为非负整数' : 'expectedRevision 必须为正整数', code: 'expected_revision_invalid' });
    return false;
  }
  return true;
}

function parseRange(value, size) {
  const match = String(value || '').match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start == null && end != null) { start = Math.max(0, size - end); end = size - 1; }
  if (start == null) return null;
  if (end == null) end = size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

router.get('/', (req, res) => {
  const filters = {
    projectId: req.query.projectId,
    kind: req.query.kind,
    storageMode: req.query.storageMode,
    availability: req.query.availability,
    query: req.query.query,
    tag: req.query.tag,
    collectionId: req.query.collectionId,
    source: req.query.source,
    sort: req.query.sort,
    limit: req.query.limit,
    offset: req.query.offset,
  };
  res.json({
    success: true,
    data: database.listAssets(filters).map(publicAsset),
    meta: {
      total: database.countAssets(filters),
      offset: Math.max(0, Number(filters.offset) || 0),
      limit: Math.min(500, Math.max(1, Number(filters.limit) || 100)),
      catalogRevision: database.getAssetCatalogRevision(filters.projectId),
      tags: database.listAssetTags(filters.projectId),
    },
  });
});

function projectAssetStatus() {
  return { scan: indexer.status(), previews: previewPipeline.status() };
}

router.get('/status', (_req, res) => res.json({ success: true, data: projectAssetStatus() }));

router.post('/scan', async (req, res) => {
  try {
    res.json({ success: true, data: await indexer.scan(req.body || {}) });
  } catch (error) {
    res.status(500).json({ success: false, error: publicErrorMessage(error, '素材扫描失败') });
  }
});

router.post('/link', async (req, res) => {
  if (!isLoopbackRequest(req)) return res.status(403).json({ success: false, error: '链接本机素材只允许从主机本地操作' });
  if (req.body?.canvasId) {
    const canvas = database.getCanvas(req.body.canvasId);
    const projectId = String(req.body?.projectId || DEFAULT_PROJECT_ID);
    if (!canvas || canvas.projectId !== projectId) {
      return res.status(400).json({ success: false, error: 'Canvas 不存在或不属于当前项目', code: 'invalid_canvas_reference' });
    }
  }
  const paths = [...new Set((Array.isArray(req.body?.paths) ? req.body.paths : [req.body?.sourcePath]).map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 100);
  if (!paths.length) return res.status(400).json({ success: false, error: '缺少本机素材路径' });
  try {
    const assets = [];
    for (const sourcePath of paths) {
      if (!path.isAbsolute(sourcePath)) throw new Error('链接素材必须使用绝对路径');
      assets.push(publicAsset(await indexer.indexLinkedFile(sourcePath, {
        projectId: req.body?.projectId,
        canvasId: req.body?.canvasId,
        sourceNodeId: req.body?.sourceNodeId,
        sourceNodeType: req.body?.sourceNodeType,
        creatorId: req.body?.creatorId || 'local-owner',
        sourceType: req.body?.sourceNodeId ? 'upload-node-link' : 'linked-file',
      })));
    }
    res.status(201).json({ success: true, data: assets });
  } catch (error) {
    res.status(400).json({ success: false, error: publicErrorMessage(error, '链接素材失败') });
  }
});

router.get('/collections', (req, res) => {
  res.json({ success: true, data: database.listAssetCollections(req.query.projectId) });
});

router.get('/tags', (req, res) => {
  res.json({ success: true, data: database.listAssetTags(req.query.projectId, { limit: req.query.limit }) });
});

router.post('/collections', (req, res) => {
  try {
    res.status(201).json({ success: true, data: database.createAssetCollection(req.body || {}) });
  } catch (error) {
    res.status(errorStatus(error)).json(publicErrorBody(error));
  }
});

router.patch('/collections/:collectionId', (req, res) => {
  if (!requireExpectedRevision(req, res)) return;
  try {
    res.json({ success: true, data: database.updateAssetCollection(req.params.collectionId, req.body || {}, { projectId: req.body?.projectId }) });
  } catch (error) {
    res.status(errorStatus(error)).json(publicErrorBody(error));
  }
});

router.delete('/collections/:collectionId', (req, res) => {
  if (!requireExpectedRevision(req, res)) return;
  try {
    const removed = database.deleteAssetCollection(req.params.collectionId, { projectId: req.body?.projectId, expectedRevision: req.body?.expectedRevision });
    if (!removed) return res.status(404).json({ success: false, error: '素材集合不存在' });
    return res.json({ success: true, data: removed });
  } catch (error) {
    return res.status(errorStatus(error)).json(publicErrorBody(error));
  }
});

router.put('/collections/:collectionId/members', (req, res) => {
  if (!requireExpectedRevision(req, res)) return;
  try {
    res.json({ success: true, data: database.setAssetCollectionMembers(req.params.collectionId, req.body?.assetIds, { expectedRevision: req.body?.expectedRevision }).map(publicAsset) });
  } catch (error) {
    res.status(errorStatus(error)).json(publicErrorBody(error));
  }
});

router.post('/collections/:collectionId/members/:assetId', (req, res) => {
  if (!requireExpectedRevision(req, res)) return;
  try {
    res.json({ success: true, data: publicAsset(database.addAssetCollectionMember(req.params.collectionId, req.params.assetId, { expectedRevision: req.body?.expectedRevision })) });
  } catch (error) {
    res.status(errorStatus(error)).json(publicErrorBody(error));
  }
});

router.delete('/collections/:collectionId/members/:assetId', (req, res) => {
  if (!requireExpectedRevision(req, res)) return;
  try {
    res.json({ success: true, data: publicAsset(database.removeAssetCollectionMember(req.params.collectionId, req.params.assetId, { expectedRevision: req.body?.expectedRevision })) });
  } catch (error) {
    res.status(errorStatus(error)).json(publicErrorBody(error));
  }
});

router.post('/batch', (req, res) => {
  try {
    const projectId = req.body?.projectId || req.query.projectId;
    const data = database.applyAssetBatch(projectId, req.body || {}, { actorId: req.body?.actorId || 'local-owner' });
    res.json({ success: true, data });
  } catch (error) {
    res.status(errorStatus(error)).json(publicErrorBody(error));
  }
});

router.get('/duplicate-groups', (req, res) => {
  try {
    const page = database.listExactDuplicateGroups(req.query.projectId, { limit: req.query.limit, cursor: req.query.cursor });
    res.json({ success: true, data: page.items.map((group) => ({ ...group, members: group.members.map(publicAsset) })), meta: { nextCursor: page.nextCursor, hasMore: page.hasMore } });
  } catch (error) {
    res.status(errorStatus(error)).json(publicErrorBody(error));
  }
});

router.get('/duplicate-groups/:groupId', (req, res) => {
  try {
    const group = database.getExactDuplicateGroup(req.query.projectId, req.params.groupId, { limit: req.query.limit, cursor: req.query.cursor });
    if (!group) return res.status(404).json({ success: false, error: '精确重复组不存在' });
    return res.json({ success: true, data: { ...group, members: group.members.map(publicAsset) }, meta: { nextCursor: group.nextCursor, hasMore: group.hasMore } });
  } catch (error) {
    return res.status(errorStatus(error)).json(publicErrorBody(error));
  }
});

router.put('/duplicate-candidates/:candidateId/decision', (req, res) => {
  if (!requireExpectedRevision(req, res)) return;
  try {
    const updated = database.setAssetDuplicateDecision(req.body?.projectId, req.params.candidateId, req.body || {}, { actorId: req.body?.actorId || 'local-owner' });
    if (!updated) return res.status(404).json({ success: false, error: '重复候选不存在' });
    return res.json({ success: true, data: updated });
  } catch (error) {
    return res.status(errorStatus(error)).json(publicErrorBody(error));
  }
});

router.get('/semantic/status', async (req, res) => {
  try {
    const projectId = String(req.query.projectId || DEFAULT_PROJECT_ID);
    res.json({ success: true, data: publicSemanticStatus(await semanticPipeline.status(projectId)) });
  } catch (error) {
    res.status(errorStatus(error, 500)).json(publicErrorBody(error, '语义能力状态读取失败'));
  }
});

router.put('/semantic/profile', async (req, res) => {
  if (!requireLoopback(req, res)) return;
  if (!requireExpectedRevision(req, res, { allowZero: true })) return;
  try {
    const projectId = String(req.body?.projectId || DEFAULT_PROJECT_ID);
    await semanticPipeline.setProfile(projectId, {
      ...(Object.hasOwn(req.body || {}, 'enabled') ? { enabled: req.body.enabled } : {}),
      ...(req.body?.caption ? { caption: req.body.caption } : {}),
      ...(req.body?.ocr ? { ocr: req.body.ocr } : {}),
      ...(req.body?.embedding ? { embedding: req.body.embedding } : {}),
    }, {
      expectedRevision: req.body.expectedRevision,
      updatedBy: req.body.updatedBy || 'local-owner',
    });
    res.json({ success: true, data: publicSemanticStatus(await semanticPipeline.status(projectId)) });
  } catch (error) {
    res.status(errorStatus(error)).json(publicErrorBody(error, '语义配置保存失败'));
  }
});

router.post('/semantic/models/:modelKey/download', async (req, res) => {
  if (!requireLoopback(req, res, '语义模型下载只允许从主机本地发起')) return;
  if (!requireExpectedRevision(req, res)) return;
  try {
    const model = await semanticPipeline.startModelDownload(req.params.modelKey, {
      expectedRevision: req.body.expectedRevision,
      idempotencyKey: req.body.idempotencyKey,
    });
    res.status(202).json({ success: true, data: publicSemanticModel(model) });
  } catch (error) {
    res.status(errorStatus(error)).json(publicErrorBody(error, '语义模型下载启动失败'));
  }
});

router.delete('/semantic/models/:modelKey', async (req, res) => {
  if (!requireLoopback(req, res, '语义模型删除只允许从主机本地执行')) return;
  if (!requireExpectedRevision(req, res)) return;
  try {
    const model = await semanticPipeline.removeModel(req.params.modelKey, { expectedRevision: req.body.expectedRevision });
    res.json({ success: true, data: publicSemanticModel(model) });
  } catch (error) {
    res.status(errorStatus(error)).json(publicErrorBody(error, '语义模型删除失败'));
  }
});

router.post('/semantic/rebuild', async (req, res) => {
  if (!requireLoopback(req, res, '语义索引重建只允许从主机本地发起')) return;
  if (!requireExpectedRevision(req, res)) return;
  try {
    const projectId = String(req.body?.projectId || DEFAULT_PROJECT_ID);
    const generation = await semanticPipeline.rebuild(projectId, {
      expectedRevision: req.body.expectedRevision,
      idempotencyKey: req.body.idempotencyKey,
      createdBy: req.body.createdBy || 'local-owner',
    });
    res.status(202).json({ success: true, data: publicSemanticGeneration(generation), status: publicSemanticStatus(await semanticPipeline.status(projectId)) });
  } catch (error) {
    res.status(errorStatus(error)).json(publicErrorBody(error, '语义索引重建失败'));
  }
});

router.post('/semantic/search', async (req, res) => {
  const projectId = String(req.body?.projectId || DEFAULT_PROJECT_ID);
  const query = normalizeSemanticText(req.body?.query, 2_000);
  if (!query) return res.status(400).json({ success: false, error: '请输入自然语言检索内容', code: 'asset_semantic_query_empty' });
  const controller = new AbortController();
  res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const result = await semanticPipeline.search(projectId, {
      query,
      filters: req.body?.filters && typeof req.body.filters === 'object' ? req.body.filters : {},
      limit: req.body?.limit,
      offset: req.body?.offset,
      expectedCatalogRevision: req.body?.expectedCatalogRevision,
      expectedProfileRevision: req.body?.expectedProfileRevision,
      expectedGeneration: req.body?.expectedGeneration,
    }, { signal: controller.signal });
    const hits = (result.items || []).map((item, index) => ({
      asset: publicAsset(item.asset),
      rank: Math.max(1, Number(result.offset || 0) + index + 1),
      score: Number(item.score) || 0,
      metric: String(result.scoreMetric || item.scoreMetric || '').startsWith('rrf')
        ? 'rrf'
        : (result.scoreMetric === 'cosine' ? 'cosine' : (result.scoreMetric === 'keyword' ? 'keyword' : 'bm25')),
      evidence: (item.matches || []).slice(0, 3).map(publicSemanticEvidence).filter((entry) => entry.snippet),
    }));
    res.json({
      success: true,
      data: hits,
      meta: {
        total: Number(result.total) || 0,
        offset: Number(result.offset) || 0,
        limit: Math.min(120, Math.max(1, Number(result.limit) || 120)),
        projectId,
        queryDigest: result.queryDigest,
        catalogRevision: result.catalogRevision,
        semanticIndexRevision: result.semanticIndexRevision,
        profileRevision: result.profileRevision,
        activeGeneration: result.activeGeneration ?? result.generation,
        modelKey: result.modelKey,
        modelVersion: result.modelVersion,
        stale: Boolean(result.stale),
      },
    });
  } catch (error) {
    if (controller.signal.aborted && !res.headersSent) return;
    const fallbackStatus = /unavailable|not[_-]installed|query[_-]empty/.test(String(error?.code || '')) ? 422 : 400;
    res.status(errorStatus(error, fallbackStatus)).json(publicErrorBody(error, '自然语言检索失败'));
  }
});

router.get('/semantic/assets/:assetId', (req, res) => {
  const projectId = String(req.query.projectId || DEFAULT_PROJECT_ID);
  const asset = database.getAsset(req.params.assetId);
  if (!asset || asset.projectId !== projectId) return res.status(404).json({ success: false, error: '素材不存在' });
  const profile = database.getAssetSemanticProfile(projectId);
  const generation = Math.max(0, Number(profile.activeGeneration) || 0);
  const activeDocumentKinds = new Set(profile.enabled
    ? ['caption', 'ocr'].filter((kind) => Boolean(profile[kind]?.enabled))
    : []);
  const documents = generation > 0 && activeDocumentKinds.size > 0
    ? database.listAssetSemanticDocuments(projectId, { assetId: asset.id, generation, limit: 8 })
      .filter((document) => activeDocumentKinds.has(document.kind))
    : [];
  res.json({ success: true, data: documents.map((document) => ({
    id: document.id,
    assetId: document.assetId,
    source: document.sourceKind || document.kind,
    text: normalizeSemanticText(document.text, 1_200),
    language: document.language || null,
    modelKey: document.modelKey,
    modelVersion: document.modelVersion,
    metadata: sanitizePublicValue(document.metadata || {}, {}, 0, 'metadata') || {},
    indexedAt: document.updatedAt || document.createdAt,
  })) });
});

router.post('/semantic/jobs/:jobId/retry', (req, res) => {
  if (!requireLoopback(req, res, '语义任务重试只允许从主机本地发起')) return;
  if (!requireExpectedRevision(req, res)) return;
  try {
    const jobs = semanticPipeline.retryJob(req.params.jobId, {
      projectId: String(req.body?.projectId || DEFAULT_PROJECT_ID),
      expectedRevision: req.body.expectedRevision,
    });
    res.json({ success: true, data: jobs.map(publicSemanticJob).filter(Boolean) });
  } catch (error) {
    res.status(errorStatus(error)).json(publicErrorBody(error, '语义任务重试失败'));
  }
});

router.put('/:assetId/tags', (req, res) => {
  if (!requireExpectedRevision(req, res)) return;
  try {
    res.json({ success: true, data: publicAsset(database.setAssetTags(req.params.assetId, req.body?.tags, { expectedRevision: req.body?.expectedRevision })) });
  } catch (error) {
    res.status(errorStatus(error)).json(publicErrorBody(error));
  }
});

router.get('/:assetId/duplicates', (req, res) => {
  try {
    const page = database.listAssetDuplicates(req.params.assetId, {
      mode: req.query.mode,
      maxDistance: req.query.maxDistance,
      limit: req.query.limit,
      cursor: req.query.cursor,
    });
    res.json({ success: true, data: page.items.map((item) => ({ ...item, asset: publicAsset(item.asset) })), meta: { nextCursor: page.nextCursor, hasMore: page.hasMore } });
  } catch (error) {
    res.status(errorStatus(error, 404)).json(publicErrorBody(error));
  }
});

router.get('/:assetId/lineage', (req, res) => {
  try {
    const page = database.listAssetLineage(req.params.assetId, {
      limit: req.query.limit,
      cursor: req.query.cursor,
    });
    if (!page) return res.status(404).json({ success: false, error: '素材不存在' });
    return res.json({
      success: true,
      data: publicAssetLineageList(page.items),
      meta: {
        total: page.total,
        limit: page.limit,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        lineageRevision: page.lineageRevision,
      },
    });
  } catch (error) {
    return res.status(errorStatus(error, 404)).json(publicErrorBody(error));
  }
});

router.post('/:assetId/lineage', (req, res) => {
  try {
    res.status(201).json({ success: true, data: publicAssetLineageList(database.addAssetLineage({ ...req.body, id: undefined, childAssetId: req.params.assetId, strictReferences: true })) });
  } catch (error) {
    res.status(400).json({ success: false, error: publicErrorMessage(error) });
  }
});

router.get('/:assetId/source-tree', (req, res) => {
  try {
    const graph = database.getAssetSourceGraph(req.params.assetId, {
      direction: req.query.direction,
      maxDepth: req.query.maxDepth,
      maxNodes: req.query.maxNodes,
      cursor: req.query.cursor,
    });
    if (!graph) return res.status(404).json({ success: false, error: '素材不存在' });
    return res.json({ success: true, data: publicAssetSourceGraph(graph) });
  } catch (error) {
    return res.status(errorStatus(error)).json(publicErrorBody(error));
  }
});

router.get('/:assetId/permissions', (req, res) => {
  const asset = database.getAsset(req.params.assetId);
  if (!asset) return res.status(404).json({ success: false, error: '素材不存在' });
  return res.json({ success: true, data: database.getAssetAccessPolicy(asset.projectId, asset.id) });
});

router.put('/:assetId/permissions', (req, res) => {
  if (!requireExpectedRevision(req, res)) return;
  try {
    const asset = database.getAsset(req.params.assetId);
    if (!asset) return res.status(404).json({ success: false, error: '素材不存在' });
    return res.json({ success: true, data: database.setAssetAccessPolicy(asset.projectId, asset.id, req.body || {}, { actorId: req.body?.actorId || 'local-owner' }) });
  } catch (error) {
    return res.status(errorStatus(error)).json(publicErrorBody(error));
  }
});

router.post('/:assetId/preview/retry', (req, res) => {
  if (!isLoopbackRequest(req)) return res.status(403).json({ success: false, error: '重试本机预览只允许从主机本地操作' });
  const asset = database.getAsset(req.params.assetId);
  if (!asset) return res.status(404).json({ success: false, error: '素材不存在' });
  try {
    previewPipeline.retryAsset(asset.id);
    return res.json({ success: true, data: projectAssetStatus() });
  } catch (error) {
    return res.status(400).json({ success: false, error: publicErrorMessage(error, '当前素材不能生成预览') });
  }
});

router.delete('/:assetId/index', (req, res) => {
  const removed = database.removeAssetIndex(req.params.assetId);
  if (!removed) return res.status(404).json({ success: false, error: '素材不存在' });
  res.json({ success: true, data: { id: removed.id, fileDeleted: false } });
});

router.delete('/:assetId/file', (req, res) => {
  const asset = database.getAsset(req.params.assetId);
  if (!asset) return res.status(404).json({ success: false, error: '素材不存在' });
  if (req.body?.deleteFile !== true || req.body?.confirmFilename !== asset.filename) return res.status(400).json({ success: false, error: '删除原文件需要输入完整文件名确认' });
  const managedPath = path.resolve(String(asset.managedPath || ''));
  const roots = [config.INPUT_DIR, config.OUTPUT_DIR].map((root) => path.resolve(root));
  const casManaged = asset.storageMode === 'managed' && blobStore.isBlobPath(managedPath);
  const legacyManaged = asset.storageMode === 'managed' && asset.managedPath
    && roots.some((root) => managedPath === root || managedPath.startsWith(`${root}${path.sep}`));
  if (!casManaged && !legacyManaged) return res.status(400).json({ success: false, error: '只允许删除受管 input/output 或私有 CAS 内的素材；链接文件只能移除索引' });
  try {
    if (casManaged) {
      const referenceCount = database.assetBlobReferenceCount(asset.contentHash);
      database.removeAssetIndex(asset.id);
      if (referenceCount <= 1) {
        Promise.resolve(blobStore.removeVerifiedBlob(asset.contentHash, {
          expectedSize: asset.metadata?.size,
          beforeDelete: () => database.assetBlobReferenceCount(asset.contentHash) === 0,
        }))
          .then((deleted) => {
            const blobRetained = database.assetBlobReferenceCount(asset.contentHash) > 0;
            if (!blobRetained) database.markAssetBlobDeleted(asset.contentHash);
            res.json({ success: true, data: { id: asset.id, fileDeleted: Boolean(deleted), blobRetained } });
          })
          .catch((error) => res.status(500).json({ success: false, error: publicErrorMessage(error, 'CAS 素材索引已移除，但物理文件清理失败') }));
        return;
      }
      return res.json({ success: true, data: { id: asset.id, fileDeleted: false, blobRetained: true } });
    }
    if (fs.existsSync(managedPath)) fs.unlinkSync(managedPath);
    database.removeAssetIndex(asset.id);
    return res.json({ success: true, data: { id: asset.id, fileDeleted: true, blobRetained: false } });
  } catch (error) {
    return res.status(500).json({ success: false, error: publicErrorMessage(error, '删除素材文件失败') });
  }
});

router.get('/:assetId/media', (req, res) => {
  if (!isLoopbackRequest(req)) return res.status(403).end();
  const asset = database.getAsset(req.params.assetId);
  if (!asset || !asset.managedPath || !['linked', 'managed'].includes(asset.storageMode)) return res.status(404).end();
  const filename = path.resolve(asset.managedPath);
  if (asset.storageMode === 'managed') {
    const managedRoots = [config.INPUT_DIR, config.OUTPUT_DIR].map((root) => path.resolve(root));
    const safeManaged = blobStore.isBlobPath(filename)
      || managedRoots.some((root) => filename === root || filename.startsWith(`${root}${path.sep}`));
    if (!safeManaged) return res.status(404).end();
  }
  if (!fs.existsSync(filename)) {
    database.updateAssetAvailability(asset.id, 'missing', { health: 'missing' });
    return res.status(404).end();
  }
  try {
    const stat = fs.statSync(filename);
    if (!stat.isFile()) return res.status(404).end();
    const rangeHeader = req.headers.range;
    const range = parseRange(rangeHeader, stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', asset.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=60');
    if (rangeHeader && !range) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
      res.setHeader('Content-Length', range.end - range.start + 1);
      return fs.createReadStream(filename, range).pipe(res);
    }
    res.setHeader('Content-Length', stat.size);
    return fs.createReadStream(filename).pipe(res);
  } catch (_) {
    return res.status(404).end();
  }
});

router.get('/:assetId', (req, res) => {
  const asset = database.getAsset(req.params.assetId);
  if (!asset) return res.status(404).json({ success: false, error: '素材不存在' });
  res.json({ success: true, data: publicAsset(asset) });
});

module.exports = router;
module.exports.indexer = indexer;
module.exports.previewPipeline = previewPipeline;
module.exports.semanticPipeline = semanticPipeline;
module.exports.isLoopbackRequest = isLoopbackRequest;
module.exports.isTrustedSemanticRequest = isTrustedSemanticRequest;
