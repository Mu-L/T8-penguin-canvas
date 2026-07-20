const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { WebSocketServer, WebSocket } = require('ws');
const { SubflowRevisionConflictError, getProjectDatabase } = require('../services/projectDatabase');
const { getAssetPreviewPipeline } = require('../services/assetPreviewPipeline');
const { publicAsset } = require('../services/assetPublicView');
const {
  assertCanvasPatchCredentialAuthority,
  isHostCredentialFieldKey,
  mapCanvasMutationError,
} = require('../services/canvasPatch');
const {
  publicCanvasDocument,
  publicCanvasSync,
  publicCollaborationCanvasValue,
} = require('../services/collaborationCanvasPublicView');
const { executeCanvasAgentTool } = require('../services/canvasAgentTools');
const {
  AssetUploadManager,
  safeUploadErrorCode,
  safeUploadErrorMessage,
  uploadError,
} = require('../services/assetUploadManager');
const {
  normalizeSubflowChangeSummary,
  publicSubflowPublication,
  validateSubflowDefinition,
} = require('../services/subflowDefinition');
const { CollaborationAuth, parseCookies } = require('./auth');
const { CollaborativeTextStore } = require('./textCrdt');
const { ExecutionPolicyError, HostExecutionPolicy } = require('./executionPolicy');
const { inspectJsonComplexity, originAllowed } = require('./gatewaySecurity');
const { requireOperationBatchRevision } = require('./protocol');
const {
  RunIntentAuthorityError,
  deriveRunIntentAuthority,
  normalizeRequestedRunNodeIds,
  stableJson,
  summarizeRunIntentAuthority,
} = require('./runIntentAuthority');

const SESSION_COOKIE = 't8_collab_session';
const MAX_WS_MESSAGE_BYTES = 64 * 1024;
const MAX_CANVAS_AGENT_REQUEST_BYTES = 64 * 1024;
const MAX_COLLAB_UPLOAD_BYTES = 512 * 1024 * 1024;

function sendCanvasPatchError(res, error, options = {}) {
  const mapped = mapCanvasMutationError(error, options);
  return res.status(mapped.status).json(mapped.body);
}

function assertEquivalentRunIntentReplay(existing, expected, options = {}) {
  const conflictingFields = [];
  const compareText = (field) => {
    const left = existing?.[field] == null ? null : String(existing[field]);
    const right = expected?.[field] == null ? null : String(expected[field]);
    if (left !== right) conflictingFields.push(field);
  };
  const compareNumber = (field) => {
    const left = existing?.[field] == null ? null : Number(existing[field]);
    const right = expected?.[field] == null ? null : Number(expected[field]);
    if (left !== right) conflictingFields.push(field);
  };

  for (const field of ['projectId', 'requestedBy', 'canvasId']) compareText(field);
  compareNumber('canvasRevision');
  if (stableJson(existing?.nodeIds) !== stableJson(expected?.nodeIds)) conflictingFields.push('nodeIds');
  if (options.includeAuthority === true) {
    for (const field of ['provider', 'model']) compareText(field);
    compareNumber('estimatedCost');
    if ((existing?.estimatedCostKnown === true) !== (expected?.estimatedCostKnown === true)) {
      conflictingFields.push('estimatedCostKnown');
    }
    if (stableJson(existing?.executionAuthority) !== stableJson(expected?.executionAuthority)) {
      conflictingFields.push('executionAuthority');
    }
  }

  if (conflictingFields.length > 0) {
    throw new RunIntentAuthorityError(
      'intent_idempotency_conflict',
      '运行幂等键已绑定其他运行请求',
      { conflictingFields: [...new Set(conflictingFields)].sort() },
      409,
    );
  }
  return existing;
}

function scopeCanvasPatch(rawPatch, scope) {
  const source = rawPatch && typeof rawPatch === 'object' && !Array.isArray(rawPatch) ? rawPatch : {};
  const patch = {
    ...source,
    operations: Array.isArray(source.operations) ? source.operations.map((rawOperation) => ({
      ...(rawOperation && typeof rawOperation === 'object' && !Array.isArray(rawOperation) ? rawOperation : {}),
      projectId: scope.projectId,
      canvasId: scope.canvasId,
      actorId: scope.actorId,
      sessionId: scope.sessionId,
    })) : source.operations,
  };
  for (const key of ['projectId', 'canvasId', 'actorId', 'sessionId']) delete patch[key];
  return patch;
}

function canvasPatchAuthorityForSession(session) {
  return {
    source: 'collaboration',
    role: String(session?.role || ''),
    capabilities: Array.isArray(session?.capabilities) ? session.capabilities.map(String) : [],
  };
}

const CREDENTIAL_DESCRIPTOR_KEYS = new Set([
  'field', 'fieldname', 'header', 'headername', 'name',
  'parameter', 'parametername', 'property', 'propertyname',
]);
const CREDENTIAL_DESCRIPTOR_VALUE_KEYS = new Set(['content', 'defaultvalue', 'secret', 'value']);

function credentialProbeKey(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function canvasCredentialProbeValue(value, depth = 0, state = null) {
  const context = state || { remaining: 10_000, seen: new WeakSet() };
  if (context.remaining <= 0 || depth > 16 || value == null || typeof value !== 'object') return value;
  context.remaining -= 1;
  if (context.seen.has(value)) return { credentialProbeOverflow: true };
  context.seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => canvasCredentialProbeValue(item, depth + 1, context));
    context.seen.delete(value);
    return output;
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    output[key] = canvasCredentialProbeValue(item, depth + 1, context);
  }
  const hasCredentialValue = Object.keys(value)
    .some((key) => CREDENTIAL_DESCRIPTOR_VALUE_KEYS.has(credentialProbeKey(key)));
  if (hasCredentialValue) {
    for (const [key, item] of Object.entries(value)) {
      if (!CREDENTIAL_DESCRIPTOR_KEYS.has(credentialProbeKey(key))
        || typeof item !== 'string' || !isHostCredentialFieldKey(item)) continue;
      output[item] = '[credential]';
    }
  }
  context.seen.delete(value);
  return output;
}

function canvasOperationsCredentialProbe(operations) {
  return {
    operations: (Array.isArray(operations) ? operations : []).map((operation) => {
      const payload = operation?.payload && typeof operation.payload === 'object' && !Array.isArray(operation.payload)
        ? operation.payload
        : {};
      if (operation?.type === 'node.add' || operation?.type === 'node.restore') {
        return {
          ...operation,
          payload: {
            ...payload,
            node: canvasCredentialProbeValue(payload.node),
          },
        };
      }
      if (operation?.type !== 'node.patch') return operation;
      return {
        ...operation,
        payload: {
          ...payload,
          dataPatch: {
            nodePatch: canvasCredentialProbeValue(payload.patch),
            nodeDataPatch: canvasCredentialProbeValue(payload.dataPatch),
          },
          dataUnsetKeys: [
            ...(Array.isArray(payload.unsetKeys) ? payload.unsetKeys : []),
            ...(Array.isArray(payload.dataUnsetKeys) ? payload.dataUnsetKeys : []),
          ],
        },
      };
    }),
  };
}

function publicCanvasPatchEvent(result, fallbackPatchId, fallbackStatus, actor) {
  const record = result?.patch && typeof result.patch === 'object' ? result.patch : {};
  const patchId = String(record.patchId || result?.patchId || fallbackPatchId || '').slice(0, 160);
  const revisionValue = result?.revision
    ?? result?.document?.revision
    ?? record.revertedRevision
    ?? record.appliedRevision
    ?? record.revision;
  const revision = Number.isSafeInteger(Number(revisionValue)) ? Number(revisionValue) : 0;
  const status = String(record.status || result?.status || fallbackStatus || 'applied').slice(0, 40);
  return { type: 'canvas.patch', patchId, revision, status, actor: String(actor || '').slice(0, 160) };
}

function comparableFilesystemPath(value) {
  const normalized = path.normalize(String(value || ''));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function filesystemPathWithin(root, candidate) {
  const normalizedRoot = comparableFilesystemPath(root);
  const normalizedCandidate = comparableFilesystemPath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}
const DERIVED_URL_FIELDS = new Set([
  'previewUrl', 'thumbnailUrl', 'firstFrameUrl', 'lastFrameUrl', 'contactSheetUrl',
  'proxyUrl', 'videoProxyUrl', 'audioProxyUrl', 'waveformUrl', 'modelPreviewUrl', 'keyframeUrls',
]);

function rateLimiter({ limit, windowMs }) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const now = Date.now();
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > limit) return res.status(429).json({ success: false, error: '请求过于频繁，请稍后再试' });
    next();
  };
}

function sanitizeUploadName(value) {
  const parsed = path.parse(path.basename(String(value || 'upload.bin')));
  const base = parsed.name.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]+/g, '_').replace(/^\.+/, '').slice(0, 100) || 'upload';
  const extension = parsed.ext.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
  return `${base}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${extension}`;
}

function publicRunState(run) {
  return {
    id: String(run.id),
    canvasId: String(run.canvasId),
    canvasRevision: Number(run.canvasRevision) || 0,
    status: String(run.status),
    parentRunId: run.parentRunId ? String(run.parentRunId) : null,
    initiatorId: String(run.initiatorId || 'host'),
    createdAt: Number(run.createdAt) || 0,
    startedAt: run.startedAt == null ? null : Number(run.startedAt),
    finishedAt: run.finishedAt == null ? null : Number(run.finishedAt),
  };
}

function publicNodeRunState(runId, nodeRun, outputRefs = nodeRun.outputRefs) {
  return {
    id: String(nodeRun.id),
    runId: String(runId),
    nodeId: String(nodeRun.originalNodeId || nodeRun.nodeId),
    parentNodeRunId: nodeRun.parentNodeRunId ? String(nodeRun.parentNodeRunId) : null,
    status: String(nodeRun.status),
    outputRefs: Array.isArray(outputRefs) ? outputRefs.map(String).slice(0, 1000) : [],
    updatedAt: Number(nodeRun.updatedAt) || Date.now(),
  };
}

function publicRunOutputAssets(assets) {
  return (assets || []).slice(0, 1000).map((asset) => ({
    id: String(asset.id),
    kind: String(asset.kind || 'other'),
    filename: String(asset.filename || 'asset').slice(0, 300),
    mimeType: String(asset.mimeType || 'application/octet-stream'),
    mediaUrl: `/api/collab/assets/${encodeURIComponent(String(asset.id))}/media`,
  }));
}

function parseRangeHeader(header, size) {
  const match = String(header || '').match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start == null && end != null) {
    start = Math.max(0, size - end);
    end = size - 1;
  }
  if (start == null) return null;
  if (end == null) end = size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function parseUploadContentRange(value) {
  const match = String(value || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  if (!match) throw uploadError('asset_upload_range_invalid', 'Content-Range 格式无效', 416);
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) {
    throw uploadError('asset_upload_range_invalid', 'Content-Range 数值无效', 416);
  }
  return { start, end, total };
}

function publicUploadSession(session) {
  if (!session) return null;
  const receivedRecords = Array.isArray(session.receivedChunks) ? session.receivedChunks : [];
  const receivedChunks = receivedRecords.map((entry) => Number(entry?.index ?? entry)).filter(Number.isSafeInteger).sort((a, b) => a - b);
  const received = new Set(receivedChunks);
  const missingChunks = Array.from({ length: Math.max(0, Number(session.chunkCount) || 0) }, (_, index) => index)
    .filter((index) => !received.has(index));
  return {
    id: session.id,
    projectId: session.projectId,
    filename: session.filename,
    mimeType: session.mimeType,
    expectedSize: session.expectedSize,
    chunkSize: session.chunkSize,
    chunkCount: session.chunkCount,
    receivedBytes: session.receivedBytes,
    reservedBytes: session.reservedBytes,
    receivedChunks,
    missingChunks,
    status: session.status,
    revision: session.revision,
    assetId: session.assetId,
    contentHash: session.contentHash,
    deduplicated: Boolean(session.deduplicated),
    errorCode: session.errorCode ? safeUploadErrorCode({ code: session.errorCode }) : null,
    errorMessage: session.errorMessage
      ? safeUploadErrorMessage({ code: session.errorCode, message: session.errorMessage })
      : null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    completedAt: session.completedAt,
  };
}

function mimeTypeForFilename(filename, fallback = 'application/octet-stream') {
  const extension = path.extname(String(filename || '')).slice(1).toLowerCase();
  return ({
    mp4: 'video/mp4', webm: 'video/webm', webp: 'image/webp', png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', wav: 'audio/wav',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', txt: 'text/plain', json: 'application/json',
  })[extension] || fallback;
}

function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  });
  next();
}

function secureRequest(req) {
  return Boolean(req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https');
}

function sessionCookie(token, req) {
  const secure = secureRequest(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}${secure}`;
}

function clearSessionCookie(req) {
  const secure = secureRequest(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function sameOriginUpgrade(request, configuredOrigins) {
  const origin = String(request.headers.origin || '');
  return originAllowed(origin, request.headers.host, configuredOrigins);
}

class CollaborationGateway {
  constructor(config, database = null) {
    this.config = config;
    this.database = database || getProjectDatabase(config);
    this.previewPipeline = database ? null : getAssetPreviewPipeline(config, this.database);
    this.uploadManager = new AssetUploadManager(config, this.database, { previewPipeline: this.previewPipeline });
    this.auth = new CollaborationAuth(this.database);
    this.textStore = new CollaborativeTextStore(this.database);
    this.executionPolicy = new HostExecutionPolicy(this.database);
    this.server = null;
    this.webSocketServer = null;
    this.connections = new Map();
    this.startedAt = null;
    this.host = null;
    this.port = null;
  }

  status() {
    return {
      running: Boolean(this.server?.listening),
      host: this.host,
      port: this.port,
      startedAt: this.startedAt,
      connectionCount: this.connections.size,
      privateBackendExposed: false,
    };
  }

  requireSession(req, res, next) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = this.auth.authenticate(token);
    if (!session) return res.status(401).json({ success: false, error: '协作会话无效或已过期' });
    req.collaborationSession = session;
    next();
  }

  requireCapability(capability) {
    return (req, res, next) => {
      if (!this.auth.hasCapability(req.collaborationSession, capability)) {
        return res.status(403).json({ success: false, error: `缺少权限: ${capability}` });
      }
      next();
    };
  }

  ensureCanvasAccess(session, canvasId) {
    const document = this.database.getCanvas(canvasId);
    if (!document || document.projectId !== session.projectId) return null;
    return document;
  }

  assetAccessSubject(session, permission) {
    return {
      memberId: String(session?.memberId || ''),
      role: String(session?.role || ''),
      permission: String(permission || 'view'),
    };
  }

  canSessionAccessAsset(session, asset, permission = 'view') {
    if (!session || !asset || String(asset.projectId) !== String(session.projectId)) return false;
    if (typeof this.database.canAccessAsset !== 'function') return false;
    try {
      return Boolean(this.database.canAccessAsset(
        session.projectId,
        asset.id,
        this.assetAccessSubject(session, permission),
      ));
    } catch (_) {
      return false;
    }
  }

  filterSessionAssets(session, assets, permission = 'view') {
    const candidates = (Array.isArray(assets) ? assets : [])
      .filter((asset) => asset && String(asset.projectId) === String(session?.projectId))
      .slice(0, 1000);
    if (!session || typeof this.database.filterAccessibleAssets !== 'function') return [];
    try {
      const filtered = this.database.filterAccessibleAssets(
        session.projectId,
        candidates,
        this.assetAccessSubject(session, permission),
      );
      return Array.isArray(filtered) ? filtered : [];
    } catch (_) {
      return [];
    }
  }

  publicAssetForSession(session, asset) {
    const safe = publicAsset(asset);
    if (!safe) return null;
    const canPreview = this.canSessionAccessAsset(session, asset, 'preview');
    const canOriginal = this.canSessionAccessAsset(session, asset, 'original')
      && this.auth.hasCapability(session, 'downloadOriginal');
    const base = `/api/collab/assets/${encodeURIComponent(String(asset.id))}/media`;
    const metadata = safe.metadata && typeof safe.metadata === 'object' ? { ...safe.metadata } : {};
    for (const key of DERIVED_URL_FIELDS) delete metadata[key];
    const hasThumbnail = Boolean(asset.metadata?.thumbnailUrl || asset.metadata?.firstFrameUrl
      || asset.metadata?.waveformUrl || asset.metadata?.modelPreviewUrl);
    const hasPreview = Boolean(asset.metadata?.proxyUrl || asset.metadata?.videoProxyUrl
      || asset.metadata?.audioProxyUrl || hasThumbnail);
    if (canPreview && hasPreview) {
      metadata.previewUrl = `${base}?representation=preview`;
      if (hasThumbnail) metadata.thumbnailUrl = `${base}?representation=thumbnail`;
    }
    return {
      ...safe,
      metadata,
      sourceUrl: canPreview ? base : null,
      effectivePermissions: {
        view: this.canSessionAccessAsset(session, asset, 'view'),
        preview: canPreview,
        original: canOriginal,
        organize: this.canSessionAccessAsset(session, asset, 'organize'),
      },
      representations: {
        ...(canPreview ? { preview: base } : {}),
        ...(canPreview && hasThumbnail ? { thumbnail: `${base}?representation=thumbnail` } : {}),
        ...(canOriginal ? { original: `${base}?download=1` } : {}),
      },
    };
  }

  _resolveSafeFile(candidate, roots) {
    if (!candidate) return null;
    try {
      const requested = path.resolve(String(candidate));
      if (!fs.existsSync(requested)) return null;
      const filename = fs.realpathSync.native(requested);
      const allowed = roots
        .filter(Boolean)
        .filter((root) => fs.existsSync(root))
        .map((root) => fs.realpathSync.native(path.resolve(root)));
      if (!allowed.some((root) => filesystemPathWithin(root, filename))) return null;
      const stat = fs.statSync(filename);
      return stat.isFile() ? { filename, stat } : null;
    } catch (_) {
      return null;
    }
  }

  _derivedUrlToFile(value) {
    const raw = String(value || '').split(/[?#]/)[0];
    const prefixes = ['/files/thumbnails/', '/thumbnails/'];
    const prefix = prefixes.find((entry) => raw.startsWith(entry));
    if (!prefix) return null;
    try {
      const segments = raw.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent);
      if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'))) return null;
      return this._resolveSafeFile(path.join(this.config.THUMBNAILS_DIR, ...segments), [this.config.THUMBNAILS_DIR, this.config.ASSET_PREVIEWS_DIR]);
    } catch (_) {
      return null;
    }
  }

  _resolveAssetRepresentation(asset, representation, allowOriginalFallback = false) {
    const metadata = asset?.metadata && typeof asset.metadata === 'object' ? asset.metadata : {};
    if (representation === 'original') {
      const original = this._resolveSafeFile(asset?.managedPath, [this.config.INPUT_DIR, this.config.OUTPUT_DIR, this.config.ASSET_BLOB_DIR]);
      return original ? { ...original, mimeType: asset.mimeType || mimeTypeForFilename(original.filename) } : null;
    }
    const thumbnailKeys = ['thumbnailUrl', 'firstFrameUrl', 'waveformUrl', 'modelPreviewUrl', 'contactSheetUrl'];
    const previewKeys = asset?.kind === 'video'
      ? ['proxyUrl', 'videoProxyUrl', ...thumbnailKeys]
      : asset?.kind === 'audio'
        ? ['audioProxyUrl', 'proxyUrl', 'waveformUrl']
        : asset?.kind === 'model3d'
          ? ['modelPreviewUrl', 'thumbnailUrl']
          : ['previewUrl', 'thumbnailUrl', 'modelPreviewUrl', 'firstFrameUrl'];
    const keys = representation === 'thumbnail' ? thumbnailKeys : previewKeys;
    for (const key of keys) {
      const resolved = this._derivedUrlToFile(metadata[key]);
      if (resolved) return { ...resolved, mimeType: mimeTypeForFilename(resolved.filename) };
    }
    if (!allowOriginalFallback) return null;
    const resolved = this._resolveSafeFile(asset?.managedPath, [this.config.INPUT_DIR, this.config.OUTPUT_DIR, this.config.ASSET_BLOB_DIR]);
    return resolved ? { ...resolved, mimeType: asset.mimeType || mimeTypeForFilename(resolved.filename) } : null;
  }

  refreshConnectionSession(webSocket, state) {
    if (!state?.sessionToken) {
      if (webSocket?.readyState === WebSocket.OPEN) webSocket.close(1008, 'session unavailable');
      return null;
    }
    const session = this.auth.authenticate(state.sessionToken);
    if (!session) {
      if (webSocket?.readyState === WebSocket.OPEN) webSocket.close(1008, 'session revoked');
      return null;
    }
    state.session = session;
    return session;
  }

  sendAssetScoped(projectId, canvasId, buildMessage) {
    for (const [webSocket, state] of this.connections.entries()) {
      if (webSocket.readyState !== WebSocket.OPEN || state.canvasId !== canvasId) continue;
      const session = this.refreshConnectionSession(webSocket, state);
      if (!session || String(session.projectId) !== String(projectId)) continue;
      const message = buildMessage(session);
      if (!message) continue;
      webSocket.send(JSON.stringify({ ...message, timestamp: Date.now() }));
    }
  }

  createApp() {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.use(securityHeaders);
    app.use((req, res, next) => {
      if (!originAllowed(req.get('origin'), req.get('host'), this.config.COLLAB_ALLOWED_ORIGINS)) {
        return res.status(403).json({ success: false, error: '请求 Origin 不在协作白名单中' });
      }
      next();
    });
    app.use('/api/collab', rateLimiter({ limit: 600, windowMs: 60_000 }));
    const collaborationAgentJsonParser = express.json({ limit: '64kb', strict: true });
    app.use((req, res, next) => {
      if (req.method !== 'POST' || !/^\/api\/collab\/canvases\/[^/]+\/agent\/tools\/?$/.test(req.path)) return next();
      const contentLength = Number(req.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_CANVAS_AGENT_REQUEST_BYTES) {
        return res.status(413).json({ success: false, code: 'agent_request_too_large', error: 'Agent 工具请求超过 64 KiB' });
      }
      return collaborationAgentJsonParser(req, res, (error) => {
        if (!error) return next();
        const tooLarge = error?.type === 'entity.too.large';
        return res.status(tooLarge ? 413 : 400).json({
          success: false,
          code: tooLarge ? 'agent_request_too_large' : 'agent_request_invalid',
          error: tooLarge ? 'Agent 工具请求超过 64 KiB' : 'Agent 工具请求格式无效',
        });
      });
    });
    app.use(express.json({ limit: '2mb', strict: true }));
    app.use((req, res, next) => {
      try {
        inspectJsonComplexity(req.body);
        next();
      } catch (error) {
        res.status(400).json({ success: false, error: error?.message || String(error) });
      }
    });

    app.get('/api/collab/status', (_req, res) => {
      res.json({ success: true, data: { service: 't8-collaboration-gateway', ...this.status() } });
    });

    app.post('/api/collab/invites/redeem', rateLimiter({ limit: 12, windowMs: 60_000 }), (req, res) => {
      const redeemed = this.auth.redeemInvite(req.body?.code, req.body?.displayName);
      if (!redeemed) return res.status(400).json({ success: false, error: '邀请无效、已过期或使用次数已满' });
      res.setHeader('Set-Cookie', sessionCookie(redeemed.token, req));
      res.json({
        success: true,
        data: {
          projectId: redeemed.projectId,
          memberId: redeemed.memberId,
          displayName: redeemed.displayName,
          role: redeemed.role,
          capabilities: redeemed.capabilities,
          expiresAt: redeemed.expiresAt,
        },
      });
    });

    app.use('/api/collab', this.requireSession.bind(this));

    app.get('/api/collab/session', (req, res) => {
      res.json({ success: true, data: req.collaborationSession });
    });

    app.post('/api/collab/logout', (req, res) => {
      this.auth.revoke(req.collaborationSession.id);
      res.setHeader('Set-Cookie', clearSessionCookie(req));
      res.json({ success: true });
    });

    app.post('/api/collab/session/rotate', (req, res) => {
      const rotated = this.auth.rotate(req.collaborationSession);
      if (!rotated) return res.status(401).json({ success: false, error: '协作会话无法轮换' });
      res.setHeader('Set-Cookie', sessionCookie(rotated.token, req));
      const { token: _token, ...session } = rotated;
      res.json({ success: true, data: session });
    });

    app.get('/api/collab/canvases', (req, res) => {
      res.json({ success: true, data: this.database.listCanvases(req.collaborationSession.projectId) });
    });

    app.get('/api/collab/canvases/:canvasId', (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
      res.set('ETag', `"${document.revision}"`);
      res.json({ success: true, data: publicCanvasDocument(document) });
    });

    app.get('/api/collab/canvases/:canvasId/sync', (req, res) => {
      if (!this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId)) {
        return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
      }
      res.json({
        success: true,
        data: publicCanvasSync(this.database.syncCanvas(req.params.canvasId, req.query?.afterRevision)),
      });
    });

    app.post('/api/collab/canvases/:canvasId/agent/tools', rateLimiter({ limit: 60, windowMs: 60_000 }), (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, code: 'agent_scope_not_found', error: 'Agent 工具目标不存在或不属于当前项目' });
      try {
        const raw = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_CANVAS_AGENT_REQUEST_BYTES) {
          return res.status(413).json({ success: false, code: 'agent_request_too_large', error: 'Agent 工具请求超过 64 KiB' });
        }
        const data = executeCanvasAgentTool(this.database, {
          ...raw,
          projectId: req.collaborationSession.projectId,
          canvasId: document.canvasId,
        }, {
          projectId: req.collaborationSession.projectId,
          canvasId: document.canvasId,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
          role: req.collaborationSession.role,
          capabilities: req.collaborationSession.capabilities,
        });
        return res.json({ success: true, data });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'agent_tool_failed',
          fallbackMessage: 'Agent 只读工具执行失败',
        });
      }
    });

    app.post('/api/collab/canvases/:canvasId/patches/preview', (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, code: 'canvas_not_found', error: '画布不存在或无权访问' });
      try {
        const context = {
          projectId: req.collaborationSession.projectId,
          canvasId: document.canvasId,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
        };
        const patch = scopeCanvasPatch(req.body?.patch, context);
        const preview = this.database.previewCanvasPatch(document.canvasId, patch, {
          actorId: context.actorId,
          sessionId: context.sessionId,
          projectId: context.projectId,
          authority: canvasPatchAuthorityForSession(req.collaborationSession),
        });
        res.json({ success: true, data: preview });
      } catch (error) {
        return sendCanvasPatchError(res, error);
      }
    });

    app.get('/api/collab/canvases/:canvasId/patches', (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, code: 'canvas_not_found', error: '画布不存在或无权访问' });
      try {
        const limit = Math.min(100, Math.max(1, Math.trunc(Number(req.query?.limit) || 50)));
        const patches = this.database.listCanvasPatches(document.canvasId, {
          actorId: req.collaborationSession.memberId,
          limit,
        });
        res.json({ success: true, data: patches });
      } catch (error) {
        return sendCanvasPatchError(res, error);
      }
    });

    app.post('/api/collab/canvases/:canvasId/patches', this.requireCapability('editGraph'), (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, code: 'canvas_not_found', error: '画布不存在或无权访问' });
      try {
        const context = {
          projectId: req.collaborationSession.projectId,
          canvasId: document.canvasId,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
        };
        const patch = scopeCanvasPatch(req.body?.patch, context);
        const result = this.database.applyCanvasPatch(document.canvasId, patch, {
          previewDigest: req.body?.previewDigest,
          confirmed: req.body?.confirmed === true,
          actorId: context.actorId,
          sessionId: context.sessionId,
          projectId: context.projectId,
          authority: canvasPatchAuthorityForSession(req.collaborationSession),
        });
        if (!result.duplicate) {
          this.broadcast(context.projectId, document.canvasId, publicCanvasPatchEvent(
            result,
            patch.id,
            'applied',
            context.actorId,
          ));
        }
        res.json({ success: true, data: publicCollaborationCanvasValue(result) });
      } catch (error) {
        return sendCanvasPatchError(res, error);
      }
    });

    app.post('/api/collab/canvases/:canvasId/patches/:patchId/revert', this.requireCapability('editGraph'), (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, code: 'canvas_not_found', error: '画布不存在或无权访问' });
      try {
        const result = this.database.revertCanvasPatch(document.canvasId, req.params.patchId, {
          expectedRevision: req.body?.expectedRevision ?? req.body?.baseRevision,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
          projectId: req.collaborationSession.projectId,
        });
        if (!result.duplicate) {
          this.broadcast(req.collaborationSession.projectId, document.canvasId, publicCanvasPatchEvent(
            result,
            req.params.patchId,
            'reverted',
            req.collaborationSession.memberId,
          ));
        }
        res.json({ success: true, data: publicCollaborationCanvasValue(result) });
      } catch (error) {
        return sendCanvasPatchError(res, error);
      }
    });

    app.get('/api/collab/subflows', (req, res) => {
      res.json({
        success: true,
        data: this.database.listSubflowDefinitions({
          projectId: req.collaborationSession.projectId,
          query: req.query?.query,
        }),
      });
    });

    app.get('/api/collab/subflows/:id/versions', (req, res) => {
      res.json({
        success: true,
        data: this.database.listSubflowVersions(req.params.id, req.collaborationSession.projectId),
      });
    });

    app.get('/api/collab/subflows/:id/:version', (req, res) => {
      const definition = this.database.getSubflowDefinition(req.params.id, req.params.version, req.collaborationSession.projectId);
      if (!definition) return res.status(404).json({ success: false, error: '子工作流定义不存在或无权访问' });
      res.json({ success: true, data: definition });
    });

    app.post('/api/collab/subflows/:id/publish', this.requireCapability('publishSubflow'), (req, res) => {
      try {
        const baseRevision = Number(req.body?.baseRevision);
        if (!Number.isInteger(baseRevision) || baseRevision < 0) throw new Error('发布子工作流必须提供有效 baseRevision');
        const changeSummary = normalizeSubflowChangeSummary(req.body?.changeSummary, { required: true });
        const source = req.body?.definition;
        if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('子工作流定义无效');
        const definition = {
          ...source,
          id: String(req.params.id),
          projectId: req.collaborationSession.projectId,
        };
        validateSubflowDefinition(definition);
        const saved = this.database.saveSubflowDefinition(definition, {
          expectedRevision: baseRevision,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
          changeSummary,
        });
        const publication = publicSubflowPublication(saved);
        this.broadcastProject(saved.projectId, { type: 'subflow.published', publication });
        res.status(201).json({ success: true, data: saved });
      } catch (error) {
        if (error instanceof SubflowRevisionConflictError) {
          return res.status(409).json({ success: false, code: error.code, error: error.message, data: error.current });
        }
        res.status(400).json({ success: false, error: error?.message || String(error) });
      }
    });

    app.get('/api/collab/canvases/:canvasId/history', (req, res) => {
      if (!this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId)) {
        return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
      }
      res.json({ success: true, data: this.database.listCanvasSnapshots(req.params.canvasId, req.query?.limit) });
    });

    app.post('/api/collab/canvases/:canvasId/history/:revision/restore', this.requireCapability('editGraph'), (req, res) => {
      try {
        if (!this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId)) {
          return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
        }
        const document = this.database.restoreCanvasSnapshot(req.params.canvasId, req.params.revision, {
          expectedRevision: req.body?.baseRevision,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
        });
        this.broadcast(document.projectId, document.canvasId, {
          type: 'canvas.snapshot-restored',
          canvasId: document.canvasId,
          revision: document.revision,
          sourceRevision: Number(req.params.revision),
          actorId: req.collaborationSession.memberId,
        });
        res.json({ success: true, data: publicCanvasDocument(document) });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'snapshot_restore_invalid',
          fallbackMessage: '历史快照恢复请求无效',
        });
      }
    });

    app.get('/api/collab/canvases/:canvasId/text', (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
      try {
        const data = this.textStore.read({
          projectId: document.projectId,
          canvasId: document.canvasId,
          targetType: req.query?.targetType,
          targetId: req.query?.targetId,
          field: req.query?.field,
        });
        res.json({ success: true, data });
      } catch (error) {
        res.status(400).json({ success: false, error: error?.message || String(error) });
      }
    });

    app.post('/api/collab/canvases/:canvasId/text/updates', this.requireCapability('editGraph'), (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
      if (!document) return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
      try {
        const targetType = String(req.body?.targetType || 'node');
        const targetId = String(req.body?.targetId || '');
        if (targetType === 'node' && !document.nodes.some((node) => String(node?.id) === targetId || String(node?.entityUid) === targetId)) {
          return res.status(404).json({ success: false, error: '协同文本节点不存在' });
        }
        if (targetType === 'edge' && !document.edges.some((edge) => String(edge?.id) === targetId || String(edge?.entityUid) === targetId)) {
          return res.status(404).json({ success: false, error: '协同文本连线不存在' });
        }
        const data = this.textStore.apply({
          projectId: document.projectId,
          canvasId: document.canvasId,
          targetType,
          targetId,
          field: req.body?.field,
        }, req.body?.update, {
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
        });
        this.broadcast(document.projectId, document.canvasId, {
          type: 'collaboration.text-update',
          canvasId: document.canvasId,
          targetType: data.targetType,
          targetId: data.targetId,
          field: data.field,
          update: req.body?.update,
          actorId: req.collaborationSession.memberId,
        });
        res.json({ success: true, data });
      } catch (error) {
        res.status(400).json({ success: false, error: error?.message || String(error) });
      }
    });

    app.post('/api/collab/canvases/:canvasId/operations', this.requireCapability('editGraph'), (req, res) => {
      try {
        const document = this.ensureCanvasAccess(req.collaborationSession, req.params.canvasId);
        if (!document) {
          return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
        }
        const rawOperations = Array.isArray(req.body?.operations) ? req.body.operations : [];
        const baseRevision = requireOperationBatchRevision(req.body?.baseRevision, rawOperations);
        const operations = rawOperations.map((operation, index) => ({
          ...operation,
          projectId: req.collaborationSession.projectId,
          canvasId: req.params.canvasId,
          baseRevision,
          actorId: req.collaborationSession.memberId,
          sessionId: req.collaborationSession.id,
          clientSeq: Number(operation?.clientSeq) || index,
        }));
        assertCanvasPatchCredentialAuthority(canvasOperationsCredentialProbe(operations), {
          authority: canvasPatchAuthorityForSession(req.collaborationSession),
        });
        const result = this.database.applyOperations(req.params.canvasId, operations, {
          expectedRevision: baseRevision,
        });
        this.broadcast(req.collaborationSession.projectId, req.params.canvasId, {
          type: 'canvas.operations',
          canvasId: req.params.canvasId,
          revision: result.document.revision,
          operations: result.acknowledgements,
          actorId: req.collaborationSession.memberId,
        });
        res.json({ success: true, data: publicCollaborationCanvasValue(result) });
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'canvas_operation_invalid',
          fallbackMessage: '画布操作请求无效',
        });
      }
    });

    app.get('/api/collab/reviews', (req, res) => {
      res.json({
        success: true,
        data: this.database.listReviewThreads({
          projectId: req.collaborationSession.projectId,
          canvasId: req.query?.canvasId,
          status: req.query?.status,
        }),
      });
    });

    app.post('/api/collab/reviews', this.requireCapability('comment'), (req, res) => {
      const document = this.ensureCanvasAccess(req.collaborationSession, req.body?.canvasId);
      if (!document) return res.status(404).json({ success: false, error: '画布不存在或无权访问' });
      const anchor = req.body?.anchor;
      if (!anchor || typeof anchor !== 'object' || !['canvas', 'node', 'edge', 'asset', 'video'].includes(String(anchor.kind))) {
        return res.status(400).json({ success: false, error: '评论锚点无效' });
      }
      const body = String(req.body?.body || '').trim();
      if (!body || body.length > 5000) return res.status(400).json({ success: false, error: '评论正文应为 1-5000 字' });
      const thread = this.database.createReviewThread({
        projectId: req.collaborationSession.projectId,
        canvasId: document.canvasId,
        canvasRevision: document.revision,
        anchor,
        severity: req.body?.severity,
        createdBy: req.collaborationSession.memberId,
      });
      const comment = this.database.createReviewComment({ threadId: thread.id, body, createdBy: req.collaborationSession.memberId });
      this.broadcast(thread.projectId, thread.canvasId, { type: 'review.created', thread: { ...thread, comments: [comment] } });
      res.status(201).json({ success: true, data: { ...thread, comments: [comment] } });
    });

    app.post('/api/collab/reviews/:threadId/comments', this.requireCapability('comment'), (req, res) => {
      const thread = this.database.getReviewThread(req.params.threadId);
      if (!thread || thread.projectId !== req.collaborationSession.projectId) return res.status(404).json({ success: false, error: '评论线程不存在' });
      const body = String(req.body?.body || '').trim();
      if (!body || body.length > 5000) return res.status(400).json({ success: false, error: '评论正文应为 1-5000 字' });
      const comment = this.database.createReviewComment({
        threadId: thread.id,
        parentId: req.body?.parentId,
        body,
        createdBy: req.collaborationSession.memberId,
      });
      this.broadcast(thread.projectId, thread.canvasId, { type: 'review.comment', threadId: thread.id, comment });
      res.status(201).json({ success: true, data: comment });
    });

    app.patch('/api/collab/reviews/:threadId', (req, res) => {
      const thread = this.database.getReviewThread(req.params.threadId);
      if (!thread || thread.projectId !== req.collaborationSession.projectId) return res.status(404).json({ success: false, error: '评论线程不存在' });
      const nextStatus = String(req.body?.status || thread.status);
      const approval = ['approved', 'changes_requested'].includes(nextStatus);
      const capability = approval ? 'approve' : 'comment';
      if (!this.auth.hasCapability(req.collaborationSession, capability)) return res.status(403).json({ success: false, error: `缺少权限: ${capability}` });
      const updated = this.database.updateReviewThread(thread.id, { status: nextStatus, severity: req.body?.severity });
      this.broadcast(thread.projectId, thread.canvasId, { type: 'review.updated', thread: updated });
      res.json({ success: true, data: updated });
    });

    app.get('/api/collab/assets', (req, res) => {
      const filters = {
        projectId: req.collaborationSession.projectId,
        kind: req.query?.kind,
        query: req.query?.query,
        limit: req.query?.limit,
        offset: req.query?.offset,
      };
      const subject = this.assetAccessSubject(req.collaborationSession, 'view');
      const assets = typeof this.database.listAccessibleAssets === 'function'
        ? this.database.listAccessibleAssets(filters, subject)
        : [];
      const countFilters = { projectId: filters.projectId, kind: filters.kind, query: filters.query };
      const total = typeof this.database.countAccessibleAssets === 'function'
        ? this.database.countAccessibleAssets(countFilters, subject)
        : 0;
      res.json({
        success: true,
        data: (Array.isArray(assets) ? assets : []).map((asset) => this.publicAssetForSession(req.collaborationSession, asset)).filter(Boolean),
        meta: { total: Math.max(0, Number(total) || 0) },
      });
    });

    app.get('/api/collab/assets/:assetId', (req, res) => {
      const asset = this.database.getAsset(req.params.assetId);
      if (!asset || !this.canSessionAccessAsset(req.collaborationSession, asset, 'view')) return res.status(404).json({ success: false, error: '素材不存在或无权访问' });
      res.json({ success: true, data: this.publicAssetForSession(req.collaborationSession, asset) });
    });

    app.get('/api/collab/assets/:assetId/media', (req, res) => {
      const asset = this.database.getAsset(req.params.assetId);
      const downloadOriginal = String(req.query?.download || '') === '1';
      const representation = String(req.query?.representation || 'preview') === 'thumbnail' ? 'thumbnail' : 'preview';
      if (!asset) return res.status(404).end();
      if (downloadOriginal) {
        if (!this.canSessionAccessAsset(req.collaborationSession, asset, 'original')) return res.status(404).end();
        if (!this.auth.hasCapability(req.collaborationSession, 'downloadOriginal')) return res.status(403).end();
      } else if (!this.canSessionAccessAsset(req.collaborationSession, asset, 'preview')) {
        return res.status(404).end();
      }
      const canFallbackToOriginal = !downloadOriginal
        && this.canSessionAccessAsset(req.collaborationSession, asset, 'original')
        && this.auth.hasCapability(req.collaborationSession, 'downloadOriginal');
      const resolved = downloadOriginal
        ? this._resolveAssetRepresentation(asset, 'original', true)
        : this._resolveAssetRepresentation(asset, representation, canFallbackToOriginal);
      if (!resolved) return res.status(404).end();
      const { filename, stat } = resolved;
      const rangeHeader = req.headers.range;
      const range = parseRangeHeader(rangeHeader, stat.size);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', resolved.mimeType || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.setHeader('Content-Disposition', `${downloadOriginal ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(asset.filename || 'asset')}`);
      if (rangeHeader && !range) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
      }
      if (!range) {
        res.setHeader('Content-Length', stat.size);
      } else {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
        res.setHeader('Content-Length', range.end - range.start + 1);
      }
      if (req.method === 'HEAD') return res.end();
      let stream;
      try {
        stream = fs.createReadStream(filename, range || undefined);
      } catch (_) {
        res.removeHeader('Content-Length');
        res.removeHeader('Content-Range');
        return res.status(404).end();
      }
      stream.once('error', () => {
        if (res.headersSent) return res.destroy();
        res.removeHeader('Content-Length');
        res.removeHeader('Content-Range');
        return res.status(404).end();
      });
      return stream.pipe(res);
    });

    const uploadContext = (req) => ({
      projectId: req.collaborationSession.projectId,
      memberId: req.collaborationSession.memberId,
      sourceKind: 'collaboration',
    });
    const sendUploadFailure = (res, error) => {
      const code = safeUploadErrorCode(error);
      const status = Math.max(400, Math.min(599, Number(error?.status) || (code.startsWith('CAS_') ? 422 : 400)));
      const current = error?.current?.id ? publicUploadSession(error.current) : error?.current;
      return res.status(status).json({
        success: false,
        code,
        error: safeUploadErrorMessage(error),
        ...(current ? { data: current } : {}),
      });
    };

    app.get('/api/collab/assets/uploads/policy', this.requireCapability('uploadAsset'), (req, res) => {
      try {
        res.json({ success: true, data: this.uploadManager.policy(uploadContext(req)) });
      } catch (error) { sendUploadFailure(res, error); }
    });

    app.post('/api/collab/assets/uploads', this.requireCapability('uploadAsset'), rateLimiter({ limit: 120, windowMs: 60_000 }), (req, res) => {
      try {
        const session = this.uploadManager.createSession(req.body || {}, uploadContext(req));
        res.status(session.idempotentReplay ? 200 : 201).json({ success: true, data: publicUploadSession(session) });
      } catch (error) { sendUploadFailure(res, error); }
    });

    app.get('/api/collab/assets/uploads/:sessionId', this.requireCapability('uploadAsset'), (req, res) => {
      try {
        res.json({ success: true, data: publicUploadSession(this.uploadManager.getSession(req.params.sessionId, uploadContext(req))) });
      } catch (error) { sendUploadFailure(res, error); }
    });

    app.put(
      '/api/collab/assets/uploads/:sessionId/chunks/:index',
      this.requireCapability('uploadAsset'),
      rateLimiter({ limit: 600, windowMs: 60_000 }),
      express.raw({ type: 'application/octet-stream', limit: this.uploadManager.chunkSize }),
      async (req, res) => {
        try {
          const range = parseUploadContentRange(req.get('content-range'));
          const session = await this.uploadManager.writeChunk(req.params.sessionId, {
            index: req.params.index,
            ...range,
            contentHash: req.get('x-chunk-sha256'),
            buffer: req.body,
          }, uploadContext(req));
          res.json({ success: true, data: publicUploadSession(session) });
        } catch (error) { sendUploadFailure(res, error); }
      },
    );

    app.post('/api/collab/assets/uploads/:sessionId/pause', this.requireCapability('uploadAsset'), (req, res) => {
      try { res.json({ success: true, data: publicUploadSession(this.uploadManager.pause(req.params.sessionId, uploadContext(req))) }); }
      catch (error) { sendUploadFailure(res, error); }
    });

    app.post('/api/collab/assets/uploads/:sessionId/resume', this.requireCapability('uploadAsset'), (req, res) => {
      try { res.json({ success: true, data: publicUploadSession(this.uploadManager.resume(req.params.sessionId, uploadContext(req))) }); }
      catch (error) { sendUploadFailure(res, error); }
    });

    app.post('/api/collab/assets/uploads/:sessionId/complete', this.requireCapability('uploadAsset'), rateLimiter({ limit: 60, windowMs: 60_000 }), async (req, res) => {
      try {
        this.uploadManager.previewPipeline = this.previewPipeline;
        const result = await this.uploadManager.complete(req.params.sessionId, req.body || {}, uploadContext(req));
        res.status(201).json({
          success: true,
          data: {
            session: publicUploadSession(result.session),
            asset: this.publicAssetForSession(req.collaborationSession, result.asset),
            deduplicated: Boolean(result.deduplicated),
            blobId: result.blobId,
            quota: result.quota,
          },
        });
      } catch (error) { sendUploadFailure(res, error); }
    });

    app.delete('/api/collab/assets/uploads/:sessionId', this.requireCapability('uploadAsset'), (req, res) => {
      try { res.json({ success: true, data: publicUploadSession(this.uploadManager.cancel(req.params.sessionId, uploadContext(req))) }); }
      catch (error) { sendUploadFailure(res, error); }
    });

    const uploadDirectory = path.join(this.config.COLLAB_UPLOAD_TEMP_DIR || this.config.INPUT_DIR, 'legacy');
    fs.mkdirSync(uploadDirectory, { recursive: true });
    const upload = multer({
      storage: multer.diskStorage({
        destination: (_req, _file, callback) => callback(null, uploadDirectory),
        filename: (_req, file, callback) => callback(null, sanitizeUploadName(file.originalname)),
      }),
      limits: { fileSize: Number(this.config.COLLAB_MAX_UPLOAD_BYTES) || MAX_COLLAB_UPLOAD_BYTES, files: 1 },
    });
    app.post('/api/collab/assets/upload', this.requireCapability('uploadAsset'), rateLimiter({ limit: 30, windowMs: 60_000 }), upload.single('file'), async (req, res) => {
      if (!req.file) return res.status(400).json({ success: false, error: '缺少上传文件' });
      try {
        this.uploadManager.previewPipeline = this.previewPipeline;
        const result = await this.uploadManager.ingestFile(req.file.path, {
          filename: req.file.originalname,
          idempotencyKey: req.body?.idempotencyKey || `legacy-${crypto.randomUUID()}`,
          removeSource: true,
        }, uploadContext(req));
        res.status(201).json({ success: true, data: this.publicAssetForSession(req.collaborationSession, result.asset) });
      } catch (error) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        sendUploadFailure(res, error);
      }
    });

    app.post('/api/collab/run-intents', this.requireCapability('runWorkflow'), (req, res) => {
      try {
        const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
        if (!/^[a-zA-Z0-9._:-]{8,160}$/.test(idempotencyKey)) return res.status(400).json({ success: false, error: '运行幂等键无效' });
        const reserve = this.database.db.transaction(() => {
          const document = this.ensureCanvasAccess(req.collaborationSession, req.body?.canvasId);
          if (!document) {
            throw new RunIntentAuthorityError('intent_canvas_not_found', '画布不存在或无权访问', {}, 404);
          }
          const revision = Number(req.body?.canvasRevision);
          if (revision !== document.revision) {
            throw new RunIntentAuthorityError(
              'intent_canvas_stale',
              '画布版本已变化，请同步后重试',
              { revision: document.revision },
              409,
            );
          }
          const existing = this.database.getRunIntentByKey(req.collaborationSession.projectId, idempotencyKey);
          if (existing) {
            assertEquivalentRunIntentReplay(existing, {
              projectId: req.collaborationSession.projectId,
              canvasId: document.canvasId,
              canvasRevision: document.revision,
              nodeIds: normalizeRequestedRunNodeIds(req.body?.nodeIds),
              requestedBy: req.collaborationSession.memberId,
            });
          }
          const authority = deriveRunIntentAuthority(document, req.body?.nodeIds);
          const summary = summarizeRunIntentAuthority(authority);
          if (existing) {
            return {
              intent: assertEquivalentRunIntentReplay(existing, {
                projectId: req.collaborationSession.projectId,
                canvasId: document.canvasId,
                canvasRevision: document.revision,
                nodeIds: authority.requestedNodeIds,
                requestedBy: req.collaborationSession.memberId,
                provider: summary.provider,
                model: summary.model,
                estimatedCost: summary.estimatedCost,
                estimatedCostKnown: summary.estimatedCostKnown,
                executionAuthority: authority,
              }, { includeAuthority: true }),
              created: false,
            };
          }
          this.executionPolicy.authorize({
            projectId: document.projectId,
            declarations: authority.declarations,
            estimatedCost: summary.estimatedCost,
            estimatedCostKnown: summary.estimatedCostKnown,
          });
          const intent = this.database.createRunIntent({
            projectId: req.collaborationSession.projectId,
            canvasId: document.canvasId,
            canvasRevision: document.revision,
            nodeIds: authority.requestedNodeIds,
            idempotencyKey,
            requestedBy: req.collaborationSession.memberId,
            provider: summary.provider,
            model: summary.model,
            estimatedCost: summary.estimatedCost,
            estimatedCostKnown: summary.estimatedCostKnown,
            executionAuthority: authority,
          });
          return { intent, created: true };
        });
        const result = reserve.immediate();
        if (result.created) {
          this.broadcast(result.intent.projectId, result.intent.canvasId, { type: 'run.intent', intent: result.intent });
        }
        res.status(202).json({ success: true, data: result.intent });
      } catch (error) {
        if (error instanceof ExecutionPolicyError || error instanceof RunIntentAuthorityError) {
          return res.status(error.httpStatus || 429).json({
            success: false,
            code: error.code,
            error: error.message,
            data: error.details,
          });
        }
        res.status(400).json({ success: false, error: error?.message || String(error) });
      }
    });

    const frontend = this.config.FRONTEND_DIST;
    if (frontend && fs.existsSync(path.join(frontend, 'index.html'))) {
      app.use(express.static(frontend, { index: false, fallthrough: true }));
      app.get(/^\/collab(?:\/.*)?$/, (_req, res) => res.sendFile(path.join(frontend, 'index.html')));
    } else {
      app.get(/^\/collab(?:\/.*)?$/, (_req, res) => {
        res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><title>T8 协作</title><p>T8 协作前端尚未构建，请先运行 npm run build。</p>');
      });
    }

    app.use((_req, res) => res.status(404).json({ success: false, error: '协作网关未开放此接口' }));
    app.use((error, _req, res, _next) => {
      if (res.headersSent) return res.end();
      const isTooLarge = error?.type === 'entity.too.large' || error?.code === 'LIMIT_FILE_SIZE';
      const isMalformedBody = error?.type === 'entity.parse.failed';
      const status = isTooLarge ? 413 : (isMalformedBody ? 400 : 500);
      const code = isTooLarge ? 'asset_upload_chunk_too_large' : (isMalformedBody ? 'request_body_invalid' : 'collaboration_request_failed');
      return res.status(status).json({
        success: false,
        code,
        error: isTooLarge ? '上传内容超过允许大小' : (isMalformedBody ? '请求内容格式无效' : '协作请求处理失败'),
      });
    });
    return app;
  }

  async start(options = {}) {
    if (this.server?.listening) return this.status();
    const requestedHost = String(options.host || this.config.COLLAB_HOST || '127.0.0.1');
    if (!['0.0.0.0', '127.0.0.1', '::1'].includes(requestedHost)) throw new Error('不支持的协作监听地址');
    const requestedPort = Number(options.port ?? this.config.COLLAB_PORT);
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('协作端口无效');

    const app = this.createApp();
    const server = http.createServer(app);
    const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });
    server.on('upgrade', (request, socket, head) => {
      try {
        const url = new URL(request.url, 'http://collaboration.local');
        if (url.pathname !== '/ws/collab' || !sameOriginUpgrade(request, this.config.COLLAB_ALLOWED_ORIGINS)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        const session = this.auth.authenticate(token);
        if (!session) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit('connection', webSocket, request, session, token);
        });
      } catch (_) {
        socket.destroy();
      }
    });
    webSocketServer.on('connection', (webSocket, _request, session, token) => this.attachWebSocket(webSocket, session, token));

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(requestedPort, requestedHost, () => resolve());
    });
    const address = server.address();
    this.server = server;
    this.webSocketServer = webSocketServer;
    this.host = requestedHost;
    this.port = typeof address === 'object' && address ? address.port : requestedPort;
    this.startedAt = Date.now();
    return this.status();
  }

  attachWebSocket(webSocket, session, token) {
    this.connections.set(webSocket, { session, sessionToken: token, canvasId: null, lastSeenAt: Date.now(), messageWindowAt: Date.now(), messageCount: 0 });
    webSocket.send(JSON.stringify({ type: 'session.ready', session, timestamp: Date.now() }));
    webSocket.on('message', (raw) => {
      if (raw.length > MAX_WS_MESSAGE_BYTES) return webSocket.close(1009, 'message too large');
      let message;
      try { message = JSON.parse(String(raw)); } catch (_) { return; }
      const state = this.connections.get(webSocket);
      if (!state) return;
      const currentSession = this.refreshConnectionSession(webSocket, state);
      if (!currentSession) return;
      const now = Date.now();
      if (now - state.messageWindowAt >= 10_000) {
        state.messageWindowAt = now;
        state.messageCount = 0;
      }
      state.messageCount += 1;
      if (state.messageCount > 240) return webSocket.close(1008, 'message rate exceeded');
      state.lastSeenAt = Date.now();
      try { inspectJsonComplexity(message, { maxDepth: 16, maxKeys: 4000 }); } catch (_) { return webSocket.close(1008, 'message too complex'); }
      if (message.type === 'ping') return webSocket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      if (typeof message.type === 'string' && (message.type.startsWith('run.') || message.type.startsWith('node.') || message.type.startsWith('provider.'))) {
        return webSocket.send(JSON.stringify({ type: 'error', code: 'host_authoritative_message', message: '运行状态和产物只能由主机广播' }));
      }
      if (message.type === 'canvas.join') {
        const document = this.ensureCanvasAccess(currentSession, message.canvasId);
        if (!document) return webSocket.send(JSON.stringify({ type: 'error', code: 'canvas_forbidden' }));
        state.canvasId = document.canvasId;
        return webSocket.send(JSON.stringify({ type: 'canvas.joined', canvasId: document.canvasId, revision: document.revision }));
      }
      if (message.type === 'presence.update' && state.canvasId) {
        this.broadcast(currentSession.projectId, state.canvasId, {
          type: 'presence.update',
          canvasId: state.canvasId,
          memberId: currentSession.memberId,
          displayName: currentSession.displayName,
          presence: message.presence && typeof message.presence === 'object' ? message.presence : {},
        }, webSocket);
      }
      if (message.type === 'awareness.update' && state.canvasId) {
        const awareness = message.awareness && typeof message.awareness === 'object' ? message.awareness : {};
        if (Buffer.byteLength(JSON.stringify(awareness), 'utf8') > 16 * 1024) return;
        this.broadcast(currentSession.projectId, state.canvasId, {
          type: 'awareness.update',
          canvasId: state.canvasId,
          memberId: currentSession.memberId,
          displayName: currentSession.displayName,
          awareness,
        }, webSocket);
      }
    });
    webSocket.on('close', () => {
      const state = this.connections.get(webSocket);
      this.connections.delete(webSocket);
      if (state?.canvasId) {
        this.broadcast(session.projectId, state.canvasId, {
          type: 'presence.left',
          canvasId: state.canvasId,
          memberId: session.memberId,
        });
      }
    });
  }

  broadcast(projectId, canvasId, message, except = null) {
    for (const [webSocket, state] of this.connections.entries()) {
      if (webSocket === except || webSocket.readyState !== WebSocket.OPEN) continue;
      if (state.canvasId !== canvasId) continue;
      const session = this.refreshConnectionSession(webSocket, state);
      if (!session || session.projectId !== projectId) continue;
      webSocket.send(JSON.stringify({ ...message, timestamp: Date.now() }));
    }
  }

  broadcastProject(projectId, message, except = null) {
    for (const [webSocket, state] of this.connections.entries()) {
      if (webSocket === except || webSocket.readyState !== WebSocket.OPEN) continue;
      const session = this.refreshConnectionSession(webSocket, state);
      if (!session || session.projectId !== projectId) continue;
      webSocket.send(JSON.stringify({ ...message, timestamp: Date.now() }));
    }
  }

  broadcastHostRunIntent(intent) {
    if (!intent) return;
    this.broadcast(intent.projectId, intent.canvasId, {
      type: 'run.intent-state',
      intent: {
        id: intent.id,
        canvasId: intent.canvasId,
        canvasRevision: intent.canvasRevision,
        requestedBy: intent.requestedBy,
        status: intent.status,
        runId: intent.runId || null,
        provider: intent.provider || null,
        model: intent.model || null,
        estimatedCost: intent.estimatedCostKnown === true ? Math.max(0, Number(intent.estimatedCost) || 0) : null,
        estimatedCostKnown: intent.estimatedCostKnown === true,
        actualCost: intent.actualCost == null ? null : Number(intent.actualCost),
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
      },
    });
  }

  broadcastHostRunState(run) {
    if (!run) return;
    this.broadcast(run.projectId, run.canvasId, { type: 'run.state', run: publicRunState(run) });
  }

  broadcastHostNodeRunState(run, nodeRun) {
    if (!run || !nodeRun) return;
    const outputRefs = Array.isArray(nodeRun.outputRefs) ? nodeRun.outputRefs.map(String).slice(0, 1000) : [];
    const assets = outputRefs.map((assetId) => this.database.getAsset(assetId)).filter(Boolean);
    this.sendAssetScoped(run.projectId, run.canvasId, (session) => {
      const accessibleIds = new Set(this.filterSessionAssets(session, assets, 'view').map((asset) => String(asset.id)));
      return {
        type: 'run.node-state',
        runId: run.id,
        node: publicNodeRunState(run.id, nodeRun, outputRefs.filter((assetId) => accessibleIds.has(assetId))),
      };
    });
  }

  broadcastHostRunOutput(run, nodeRun, assets) {
    if (!run || !nodeRun) return;
    const canonicalAssets = (Array.isArray(assets) ? assets : [])
      .slice(0, 1000)
      .map((asset) => this.database.getAsset(asset?.id))
      .filter((asset) => asset && String(asset.projectId) === String(run.projectId));
    this.sendAssetScoped(run.projectId, run.canvasId, (session) => {
      const visible = this.filterSessionAssets(session, canonicalAssets, 'preview');
      return {
        type: 'run.output',
        runId: run.id,
        nodeRunId: nodeRun.id,
        nodeId: String(nodeRun.originalNodeId || nodeRun.nodeId),
        assets: visible.map((asset) => {
          const safe = this.publicAssetForSession(session, asset);
          return {
            id: String(asset.id),
            kind: String(asset.kind || 'other'),
            filename: String(asset.filename || 'asset').slice(0, 300),
            mimeType: String(asset.mimeType || 'application/octet-stream'),
            mediaUrl: safe?.representations?.preview || null,
          };
        }).filter((asset) => asset.mediaUrl),
      };
    });
  }

  async stop() {
    if (!this.server) return this.status();
    for (const webSocket of this.connections.keys()) webSocket.close(1001, 'gateway stopped');
    this.connections.clear();
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.webSocketServer?.close();
    this.server = null;
    this.webSocketServer = null;
    this.startedAt = null;
    this.host = null;
    this.port = null;
    return this.status();
  }
}

let singleton = null;

function getCollaborationGateway(config) {
  if (!singleton) singleton = new CollaborationGateway(config);
  return singleton;
}

module.exports = {
  CollaborationGateway,
  SESSION_COOKIE,
  getCollaborationGateway,
  publicNodeRunState,
  publicRunOutputAssets,
  publicRunState,
};
