const express = require('express');
const crypto = require('node:crypto');
const config = require('../config');
const { getCollaborationGateway } = require('../collaboration/gateway');
const { buildInviteUrls } = require('../collaboration/hostManagement');
const { redactLocalPaths, sanitizePublicValue } = require('../services/assetPublicView');
const {
  sendProjectDatabaseStorageCapacityError,
} = require('../services/projectDatabasePublicError');

const defaultGateway = getCollaborationGateway(config);
const AUDIT_QUERY_WINDOW_LIMIT = 1000;
const AUDIT_PAGE_DEFAULT_LIMIT = 25;
const AUDIT_PAGE_MAX_LIMIT = 100;
const AUDIT_METADATA_MAX_JSON_CHARS = 8192;
const EXECUTION_POLICY_MAX_COST = 1_000_000_000;
const RUN_INTENT_MAX_LEASE_MS = 5 * 60 * 1000;
const MANAGEMENT_AUTHORITY_HEADER = 'x-t8-collaboration-management-token';
const MANAGEMENT_AUTHORITY_MIN_TOKEN_BYTES = 32;
const MANAGEMENT_AUTHORITY_MAX_TOKEN_BYTES = 512;
const PROJECT_DATABASE_CAPACITY_RESPONSE_SENT = Symbol('project-database-capacity-response-sent');

function normalizedProjectId(value) {
  return String(value || 'project-local').trim() || 'project-local';
}

function normalizedCanvasId(value) {
  return String(value || '').trim();
}

function managementInputError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function boundedManagementText(value, name, maximum, options = {}) {
  const text = String(value ?? '').trim();
  if (!text && options.required) throw managementInputError(`${name}_required`, `缺少${options.label || name}`);
  if (text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw managementInputError(`${name}_invalid`, `${options.label || name}格式无效`);
  }
  return text;
}

function managementTokenDigest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function createManagementAuthority(input = {}) {
  const token = String(input.token ?? config.COLLAB_MANAGEMENT_TOKEN ?? '').trim();
  const tokenBytes = Buffer.byteLength(token, 'utf8');
  if (tokenBytes < MANAGEMENT_AUTHORITY_MIN_TOKEN_BYTES
    || tokenBytes > MANAGEMENT_AUTHORITY_MAX_TOKEN_BYTES
    || /[\u0000-\u0020\u007f]/.test(token)) {
    throw new Error('协作管理 authority token 缺失或格式无效');
  }
  const actorId = boundedManagementText(
    input.actorId || `host:${managementTokenDigest(token).toString('hex').slice(0, 32)}`,
    'management_actor_id',
    240,
    { required: true, label: '主机身份' },
  );
  const sessionId = boundedManagementText(
    input.sessionId || `host-backend:${crypto.randomUUID()}`,
    'management_session_id',
    240,
    { required: true, label: '主机后端会话' },
  );
  return Object.freeze({
    tokenDigest: managementTokenDigest(token),
    principal: Object.freeze({ actorId, sessionId }),
  });
}

function runProjectDatabaseWriteForHttp(res, operation, callback) {
  try {
    return callback();
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation })) {
      return PROJECT_DATABASE_CAPACITY_RESPONSE_SENT;
    }
    throw error;
  }
}

function runCoordinatedProjectDatabaseWrite(database, operation, callback) {
  if (typeof database?.withProjectDatabaseWrite === 'function') {
    return database.withProjectDatabaseWrite(operation, callback);
  }
  // Compatibility for focused route test doubles and older embedders. Real
  // ProjectDatabase instances always supply the outer transaction coordinator.
  return callback(database);
}

function broadcastHostRunIntentBestEffort(gateway, intent) {
  try {
    const pending = gateway?.broadcastHostRunIntent?.(intent);
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (_) {}
}

function managementAuthorityRequest(authority) {
  return (req, res, next) => {
    const receivedDigest = managementTokenDigest(req.get(MANAGEMENT_AUTHORITY_HEADER));
    if (!crypto.timingSafeEqual(receivedDigest, authority.tokenDigest)) {
      res.set('Cache-Control', 'no-store');
      return res.status(401).json({
        success: false,
        code: 'collaboration_management_auth_required',
        error: '协作管理身份认证失败',
      });
    }
    req.managementPrincipal = authority.principal;
    next();
  };
}

function normalizedManagementProjectId(value) {
  return boundedManagementText(value || 'project-local', 'project_id', 240, {
    required: true,
    label: '项目标识',
  });
}

function boundedAuditInteger(value, fallback, maximum, name) {
  if (value == null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > maximum) {
    throw managementInputError('audit_query_invalid', `${name}必须是 0-${maximum} 的整数`);
  }
  return numeric;
}

function safeAuditString(value, maximum) {
  return redactLocalPaths(String(value ?? '')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maximum);
}

function auditReferenceDigest(value) {
  const text = String(value || '');
  return text ? crypto.createHash('sha256').update(text).digest('hex').slice(0, 12) : null;
}

function opaqueAuditReference(value, prefix = 'ref') {
  const digest = auditReferenceDigest(value);
  return digest ? `${prefix}:${digest}` : null;
}

function boundedAuditMetadata(value) {
  const sanitized = sanitizePublicValue(value && typeof value === 'object' ? value : {});
  let serialized = '';
  try {
    serialized = JSON.stringify(sanitized);
  } catch (_) {
    return { redacted: true };
  }
  if (serialized.length <= AUDIT_METADATA_MAX_JSON_CHARS) return sanitized;
  return {
    truncated: true,
    keys: sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
      ? Object.keys(sanitized).slice(0, 50)
      : [],
  };
}

function safeAuditEvent(event = {}) {
  const sessionId = String(event.sessionId || '');
  const targetType = event.targetType == null ? null : safeAuditString(event.targetType, 80);
  return {
    id: Number(event.id) || 0,
    projectId: safeAuditString(event.projectId, 240),
    canvasId: event.canvasId == null ? null : safeAuditString(event.canvasId, 240),
    actorId: safeAuditString(event.actorId, 240),
    sessionRef: auditReferenceDigest(sessionId),
    action: safeAuditString(event.action, 120),
    targetType,
    targetId: event.targetId == null
      ? null
      : /session/i.test(targetType || '')
        ? opaqueAuditReference(event.targetId, 'session')
        : safeAuditString(event.targetId, 240),
    metadata: boundedAuditMetadata(event.metadata),
    createdAt: Math.max(0, Number(event.createdAt) || 0),
  };
}

function normalizeExecutionPolicyInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw managementInputError('execution_policy_invalid', '执行策略必须是对象');
  }
  const allowedKeys = new Set([
    'projectId',
    'allowedModels',
    'dailyCostLimit',
    'perRunCostLimit',
    'concurrencyLimit',
  ]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw managementInputError('execution_policy_invalid', '执行策略包含不支持的字段');
  }
  for (const key of ['projectId', 'allowedModels', 'dailyCostLimit', 'perRunCostLimit', 'concurrencyLimit']) {
    if (!Object.hasOwn(body, key)) {
      throw managementInputError('execution_policy_invalid', '执行策略必须一次提交完整配置');
    }
  }
  if (!Array.isArray(body.allowedModels) || body.allowedModels.length > 500) {
    throw managementInputError('execution_policy_invalid', '模型白名单必须是最多 500 项的数组');
  }
  const allowedModels = [...new Set(body.allowedModels.map((value) => {
    if (typeof value !== 'string') throw managementInputError('execution_policy_invalid', '模型白名单只能包含字符串');
    return boundedManagementText(value, 'allowed_model', 160, { required: true, label: '模型标识' });
  }))];
  const boundedCost = (value, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > EXECUTION_POLICY_MAX_COST) {
      throw managementInputError('execution_policy_invalid', `${label}必须是 0-${EXECUTION_POLICY_MAX_COST} 的有限数值`);
    }
    return value;
  };
  if (!Number.isInteger(body.concurrencyLimit) || body.concurrencyLimit < 1 || body.concurrencyLimit > 64) {
    throw managementInputError('execution_policy_invalid', '并发上限必须是 1-64 的整数');
  }
  return {
    projectId: boundedManagementText(body.projectId, 'project_id', 240, {
      required: true,
      label: '项目标识',
    }),
    allowedModels,
    dailyCostLimit: boundedCost(body.dailyCostLimit, '每日额度'),
    perRunCostLimit: boundedCost(body.perRunCostLimit, '单次成本上限'),
    concurrencyLimit: body.concurrencyLimit,
  };
}

function normalizeReviewVisibilityPolicyInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw managementInputError(
      'collaboration_review_visibility_policy_invalid',
      '审阅可见性策略必须是对象',
    );
  }
  const allowedKeys = new Set([
    'projectId',
    'expectedRevision',
    'hidePrompts',
    'hideModelParameters',
  ]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw managementInputError(
      'collaboration_review_visibility_policy_invalid',
      '审阅可见性策略包含不支持的字段',
    );
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(body, key)) {
      throw managementInputError(
        'collaboration_review_visibility_policy_invalid',
        '审阅可见性策略必须一次提交完整配置',
      );
    }
  }
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw managementInputError(
      'collaboration_review_visibility_policy_invalid',
      '审阅可见性策略 expectedRevision 必须是非负安全整数',
    );
  }
  if (typeof body.hidePrompts !== 'boolean' || typeof body.hideModelParameters !== 'boolean') {
    throw managementInputError(
      'collaboration_review_visibility_policy_invalid',
      '审阅可见性策略必须显式提供两个布尔值',
    );
  }
  return {
    projectId: normalizedManagementProjectId(body.projectId),
    expectedRevision: body.expectedRevision,
    hidePrompts: body.hidePrompts,
    hideModelParameters: body.hideModelParameters,
  };
}

function normalizeRoomExecutionPolicyInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw managementInputError('room_execution_policy_invalid', '房间执行策略必须是对象');
  }
  const allowedKeys = new Set([
    'projectId',
    'canvasId',
    'expectedRevision',
    'allowEditorRuns',
    'memberDailyRunLimit',
    'canvasConcurrencyLimit',
    'autoApproveLowRisk',
    'highCostConfirmationThreshold',
    'requireUnknownCostConfirmation',
  ]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))
    || [...allowedKeys].some((key) => !Object.hasOwn(body, key))) {
    throw managementInputError(
      'room_execution_policy_invalid',
      '房间执行策略必须一次提交完整配置且不能包含额外字段',
    );
  }
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw managementInputError('room_execution_policy_invalid', '房间执行策略 expectedRevision 必须是非负安全整数');
  }
  if (!Number.isSafeInteger(body.memberDailyRunLimit)
    || body.memberDailyRunLimit < 0
    || body.memberDailyRunLimit > 100000) {
    throw managementInputError('room_execution_policy_invalid', '成员每日运行上限必须是 0-100000 的整数');
  }
  if (!Number.isSafeInteger(body.canvasConcurrencyLimit)
    || body.canvasConcurrencyLimit < 1
    || body.canvasConcurrencyLimit > 64) {
    throw managementInputError('room_execution_policy_invalid', '画布并发上限必须是 1-64 的整数');
  }
  if (typeof body.highCostConfirmationThreshold !== 'number'
    || !Number.isFinite(body.highCostConfirmationThreshold)
    || body.highCostConfirmationThreshold < 0
    || body.highCostConfirmationThreshold > EXECUTION_POLICY_MAX_COST) {
    throw managementInputError(
      'room_execution_policy_invalid',
      `高费用确认阈值必须是 0-${EXECUTION_POLICY_MAX_COST} 的有限数值`,
    );
  }
  for (const key of ['allowEditorRuns', 'autoApproveLowRisk', 'requireUnknownCostConfirmation']) {
    if (typeof body[key] !== 'boolean') {
      throw managementInputError('room_execution_policy_invalid', '房间执行策略布尔字段必须显式提供 true 或 false');
    }
  }
  return {
    projectId: normalizedManagementProjectId(body.projectId),
    canvasId: boundedManagementText(body.canvasId, 'canvas_id', 240, {
      required: true,
      label: '画布标识',
    }),
    expectedRevision: body.expectedRevision,
    allowEditorRuns: body.allowEditorRuns,
    memberDailyRunLimit: body.memberDailyRunLimit,
    canvasConcurrencyLimit: body.canvasConcurrencyLimit,
    autoApproveLowRisk: body.autoApproveLowRisk,
    highCostConfirmationThreshold: body.highCostConfirmationThreshold,
    requireUnknownCostConfirmation: body.requireUnknownCostConfirmation,
  };
}

function normalizePublicSelfCheckInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => key !== 'baseUrl')
    || !Object.hasOwn(body, 'baseUrl')) {
    throw managementInputError(
      'collaboration_public_self_check_invalid',
      '公网自检必须只提交 baseUrl',
    );
  }
  return {
    baseUrl: boundedManagementText(body.baseUrl, 'public_base_url', 2048, {
      required: true,
      label: '公网 Base URL',
    }),
  };
}

function normalizeRunIntentScope(body, options = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw managementInputError('run_intent_request_invalid', '运行意图操作参数必须是对象');
  }
  if (options.allowedKeys
    && Object.keys(body).some((key) => !options.allowedKeys.has(key))) {
    throw managementInputError('run_intent_request_invalid', '运行意图操作包含不支持的字段');
  }
  const projectId = boundedManagementText(body.projectId, 'project_id', 240, {
    required: true,
    label: '项目标识',
  });
  const canvasId = boundedManagementText(body.canvasId, 'canvas_id', 240, {
    required: true,
    label: '画布标识',
  });
  const expectedQueueRevision = Number(body.expectedQueueRevision);
  if (options.requireRevision !== false
    && (!Number.isSafeInteger(expectedQueueRevision) || expectedQueueRevision < 1)) {
    throw managementInputError('run_intent_revision_invalid', '运行意图 expectedQueueRevision 必须是正安全整数');
  }
  return {
    projectId,
    canvasId,
    ...(options.requireRevision === false ? {} : { expectedQueueRevision }),
  };
}

function normalizeRunIntentSnapshotScope(query) {
  const scope = normalizeRunIntentScope(query, {
    requireRevision: false,
    allowedKeys: new Set(['projectId', 'canvasId', 'canvasRevision']),
  });
  const canvasRevision = Number(query.canvasRevision);
  if (!Number.isSafeInteger(canvasRevision) || canvasRevision < 1) {
    throw managementInputError(
      'run_intent_canvas_revision_invalid',
      '运行意图 canvasRevision 必须是正安全整数',
    );
  }
  return { ...scope, canvasRevision };
}

function normalizeRunIntentWorker(body, options = {}) {
  const scope = normalizeRunIntentScope(body, options);
  const workerId = boundedManagementText(body.workerId, 'worker_id', 240, {
    required: true,
    label: '主机 Worker 标识',
  });
  let leaseDurationMs;
  if (body.leaseDurationMs != null) {
    leaseDurationMs = Number(body.leaseDurationMs);
    if (!Number.isSafeInteger(leaseDurationMs)
      || leaseDurationMs < 5000
      || leaseDurationMs > RUN_INTENT_MAX_LEASE_MS) {
      throw managementInputError(
        'run_intent_lease_duration_invalid',
        `运行租约时长必须是 5000-${RUN_INTENT_MAX_LEASE_MS} 毫秒的整数`,
      );
    }
  }
  const output = { ...scope, workerId, ...(leaseDurationMs == null ? {} : { leaseDurationMs }) };
  if (options.allowExpectedIntentId === true && body.expectedIntentId != null) {
    output.expectedIntentId = boundedManagementText(body.expectedIntentId, 'expected_intent_id', 240, {
      required: true,
      label: '预期运行意图',
    });
  }
  if (options.requireToken === true) {
    output.leaseToken = boundedManagementText(body.leaseToken, 'lease_token', 512, {
      required: true,
      label: '运行租约凭据',
    });
  }
  return output;
}

function loopbackOnly(req, res, next) {
  const address = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!['127.0.0.1', '::1', 'localhost'].includes(address)) {
    return res.status(403).json({ success: false, error: '协作管理接口仅允许本机访问' });
  }
  next();
}

function localManagementOrigin(origin, requestHost = '') {
  if (!origin) return true;
  try {
    const parsed = new URL(String(origin));
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(hostname)) return false;
    let sameOriginHost = false;
    try {
      const requested = new URL(`http://${String(requestHost || '')}`);
      sameOriginHost = parsed.host.toLowerCase() === requested.host.toLowerCase();
    } catch (_) {}
    const configuredDevPort = String(process.env.T8_DEV_FRONTEND_PORT || process.env.VITE_PORT || '11422');
    // Packaged Electron is exact-origin. Development is the one fixed Vite
    // origin proxied to this backend; an arbitrary localhost web server must
    // not inherit management authority merely because it is loopback.
    return sameOriginHost || parsed.port === configuredDevPort;
  } catch (_) {
    return false;
  }
}

function trustedManagementBrowserRequest(req) {
  const origin = String(req.get('origin') || '').trim();
  const fetchSite = String(req.get('sec-fetch-site') || '').trim().toLowerCase();
  // Electron main-process requests and local CLI calls normally omit both
  // headers. A browser that explicitly reports a cross-site source is never
  // allowed to turn loopback reachability into management authority.
  if (!origin) return fetchSite !== 'cross-site';
  if (!localManagementOrigin(origin, req.get('host'))) return false;
  return !fetchSite || ['same-origin', 'same-site', 'none'].includes(fetchSite);
}

function trustedManagementRequest(req, res, next) {
  if (!trustedManagementBrowserRequest(req)) {
    return res.status(403).json({
      success: false,
      code: 'collaboration_management_origin_forbidden',
      error: '拒绝跨站访问协作管理接口',
    });
  }
  next();
}

function createCollaborationRouter(gateway = defaultGateway, options = {}) {
  const managementAuthority = createManagementAuthority(options.managementAuthority);
  const router = express.Router();
  router.use(loopbackOnly);
  router.use(trustedManagementRequest);
  router.use(managementAuthorityRequest(managementAuthority));

router.get('/status', (req, res) => {
  const projectId = String(req.query?.projectId || '').trim();
  const canvasId = normalizedCanvasId(req.query?.canvasId);
  const status = gateway.managementStatus();
  if (!projectId || !canvasId) return res.json({ success: true, data: status });
  const canvas = gateway.database.getCanvas(canvasId);
  if (!canvas || String(canvas.projectId) !== projectId) {
    return res.status(404).json({ success: false, error: '协作房间画布不存在' });
  }
  const sessions = gateway.database.listCollaborationSessions(projectId, { canvasId });
  res.json({
    success: true,
    data: {
      ...status,
      room: {
        projectId,
        canvasId,
        canvasCount: 1,
        memberCount: gateway.database.listMembers(projectId, { canvasId }).length,
        activeSessionCount: sessions.filter((session) => session.active).length,
        connectionCount: gateway.connectionCountForCanvas(projectId, canvasId),
        resourceScope: gateway.managementResourceScope(projectId, canvasId),
      },
    },
  });
});

router.post('/start', async (req, res) => {
  try {
    const status = await gateway.start({ host: req.body?.host, port: req.body?.port });
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.post('/public-self-check', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const input = normalizePublicSelfCheckInput(req.body);
    const result = await gateway.checkPublicBaseUrl(input.baseUrl);
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(Math.max(400, Math.min(599, Number(error?.status) || 400))).json({
      success: false,
      code: error?.code || 'collaboration_public_self_check_failed',
      error: error?.message || '公网自检失败',
    });
  }
});

router.delete('/public-base-url', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    return res.json({ success: true, data: gateway.clearPublicBaseUrl() });
  } catch (error) {
    return res.status(Math.max(400, Math.min(599, Number(error?.status) || 500))).json({
      success: false,
      code: error?.code || 'collaboration_public_exposure_clear_failed',
      error: error?.message || '公网 Base URL 配置清除失败',
    });
  }
});

router.post('/stop', async (_req, res) => {
  try {
    res.json({ success: true, data: await gateway.stop() });
  } catch (error) {
    res.status(500).json({ success: false, error: error?.message || String(error) });
  }
});

router.post('/resource-scope/initialize', (req, res) => {
  try {
    const projectId = normalizedProjectId(req.body?.projectId);
    const canvasId = normalizedCanvasId(req.body?.canvasId);
    if (!canvasId) return res.status(400).json({ success: false, error: '缺少协作房间画布' });
    if (req.body?.confirmed !== true) {
      return res.status(409).json({
        success: false,
        code: 'canvas_resource_scope_confirmation_required',
        error: '初始化协作资源范围需要主机明确确认',
      });
    }
    const initialized = runProjectDatabaseWriteForHttp(
      res,
      'collaboration.resource-scope.initialize',
      () => gateway.database.initializeCanvasResourceGrantsForSharing(projectId, canvasId, {
        ...req.managementPrincipal,
      }),
    );
    if (initialized === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
    res.json({
      success: true,
      data: gateway.managementResourceScope(projectId, canvasId),
    });
  } catch (error) {
    res.status(Number(error?.status) || 400).json({
      success: false,
      code: error?.code || 'canvas_resource_scope_initialize_failed',
      error: error?.message || String(error),
    });
  }
});

router.post('/invites', (req, res) => {
  try {
    const projectId = normalizedProjectId(req.body?.projectId);
    const canvasId = String(req.body?.canvasId || '').trim();
    if (!canvasId) {
      return res.status(400).json({ success: false, error: '创建邀请必须指定当前画布' });
    }
    const canvas = gateway.database.getCanvas(canvasId);
    if (!canvas || String(canvas.projectId) !== projectId) {
      return res.status(404).json({ success: false, error: '画布不存在或不属于当前协作房间' });
    }
    const {
      createdBy: _ignoredCreatedBy,
      sessionId: _ignoredSessionId,
      ...inviteInput
    } = req.body || {};
    const invite = runProjectDatabaseWriteForHttp(
      res,
      'collaboration.invite.create',
      () => gateway.auth.createInvite({
        ...inviteInput,
        projectId,
        canvasId,
        createdBy: req.managementPrincipal.actorId,
        sessionId: req.managementPrincipal.sessionId,
      }),
    );
    if (invite === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
    const shareUrls = buildInviteUrls(gateway.managementStatus().shareUrls, invite.code, canvasId);
    res.json({
      success: true,
      data: {
        ...invite,
        canvasId: canvasId || null,
        localUrl: shareUrls[0] || null,
        shareUrls,
      },
    });
  } catch (error) {
    res.status(Number(error?.status) || 400).json({
      success: false,
      code: error?.code || 'collaboration_invite_create_failed',
      error: error?.message || String(error),
    });
  }
});

router.get('/invites', (req, res) => {
  const projectId = normalizedProjectId(req.query?.projectId);
  const canvasId = normalizedCanvasId(req.query?.canvasId);
  if (!canvasId) return res.status(400).json({ success: false, error: '缺少协作房间画布' });
  res.json({ success: true, data: gateway.database.listInvites(projectId, { canvasId }) });
});

router.delete('/invites/:inviteId', (req, res) => {
  const projectId = normalizedProjectId(req.query?.projectId);
  const canvasId = normalizedCanvasId(req.query?.canvasId);
  if (!canvasId) return res.status(400).json({ success: false, error: '缺少协作房间画布' });
  const revoked = runProjectDatabaseWriteForHttp(
    res,
    'collaboration.invite.revoke',
    () => gateway.auth.revokeInvite(req.params.inviteId, {
      ...req.managementPrincipal,
      expectedProjectId: projectId,
      expectedCanvasId: canvasId,
    }),
  );
  if (revoked === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
  if (!revoked) return res.status(404).json({ success: false, error: '邀请不存在' });
  res.json({ success: true, data: revoked });
});

router.get('/members', (req, res) => {
  const projectId = normalizedProjectId(req.query?.projectId);
  const canvasId = normalizedCanvasId(req.query?.canvasId);
  if (!canvasId) return res.status(400).json({ success: false, error: '缺少协作房间画布' });
  const sessions = gateway.database.listCollaborationSessions(projectId, { canvasId });
  const sessionsByMember = new Map();
  for (const session of sessions) {
    if (!sessionsByMember.has(session.memberId)) sessionsByMember.set(session.memberId, []);
    sessionsByMember.get(session.memberId).push(session);
  }
  const members = gateway.database.listMembers(projectId, { canvasId }).map((member) => {
    const memberSessions = sessionsByMember.get(member.id) || [];
    const connectionCount = memberSessions.reduce((total, session) => total + gateway.connectionCountForSession(session.id), 0);
    return {
      ...member,
      sessionCount: memberSessions.filter((session) => session.active).length,
      connectionCount,
      online: connectionCount > 0,
      lastSeenAt: memberSessions.reduce((latest, session) => Math.max(latest, Number(session.lastSeenAt) || 0), 0) || null,
    };
  });
  res.json({ success: true, data: members });
});

router.patch('/members/:memberId', (req, res) => {
  try {
    const projectId = normalizedProjectId(req.body?.projectId);
    const canvasId = normalizedCanvasId(req.body?.canvasId);
    if (!canvasId) return res.status(400).json({ success: false, error: '缺少协作房间画布' });
    const member = runProjectDatabaseWriteForHttp(
      res,
      'collaboration.member.update',
      () => gateway.auth.updateMember(req.params.memberId, req.body || {}, {
        ...req.managementPrincipal,
        expectedProjectId: projectId,
        expectedCanvasId: canvasId,
      }),
    );
    if (member === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
    if (!member) return res.status(404).json({ success: false, error: '成员不存在' });
    const disconnectedConnections = gateway.closeMemberConnections(member.id, 'member role changed', {
      code: 4002,
      messageType: 'session.changed',
    });
    res.json({ success: true, data: { ...member, disconnectedConnections } });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.delete('/members/:memberId', (req, res) => {
  const projectId = normalizedProjectId(req.query?.projectId);
  const canvasId = normalizedCanvasId(req.query?.canvasId);
  if (!canvasId) return res.status(400).json({ success: false, error: '缺少协作房间画布' });
  const removed = runProjectDatabaseWriteForHttp(
    res,
    'collaboration.member.remove',
    () => gateway.auth.removeMember(req.params.memberId, {
      ...req.managementPrincipal,
      expectedProjectId: projectId,
      expectedCanvasId: canvasId,
    }),
  );
  if (removed === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
  if (!removed) return res.status(404).json({ success: false, error: '成员不存在' });
  const disconnectedConnections = gateway.closeMemberConnections(removed.id, 'member removed');
  res.json({ success: true, data: { ...removed, disconnectedConnections } });
});

router.get('/sessions', (req, res) => {
  const projectId = normalizedProjectId(req.query?.projectId);
  const canvasId = normalizedCanvasId(req.query?.canvasId);
  if (!canvasId) return res.status(400).json({ success: false, error: '缺少协作房间画布' });
  const sessions = gateway.database.listCollaborationSessions(projectId, { canvasId }).map((session) => {
    const connectionCount = gateway.connectionCountForSession(session.id);
    return { ...session, connectionCount, connected: connectionCount > 0 };
  });
  res.json({ success: true, data: sessions });
});

router.delete('/sessions/:sessionId', (req, res) => {
  const projectId = normalizedProjectId(req.query?.projectId);
  const canvasId = normalizedCanvasId(req.query?.canvasId);
  if (!canvasId) return res.status(400).json({ success: false, error: '缺少协作房间画布' });
  const revoked = runProjectDatabaseWriteForHttp(
    res,
    'collaboration.session.revoke',
    () => gateway.database.revokeSession(req.params.sessionId, {
      ...req.managementPrincipal,
      expectedProjectId: projectId,
      expectedCanvasId: canvasId,
    }),
  );
  if (revoked === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
  if (!revoked) return res.status(404).json({ success: false, error: '会话不存在' });
  const disconnectedConnections = gateway.closeSessionConnections(revoked.id, 'session revoked by host');
  res.json({ success: true, data: { ...revoked, disconnectedConnections } });
});

router.post('/sessions/revoke-all', (req, res) => {
  const projectId = normalizedProjectId(req.body?.projectId);
  const canvasId = normalizedCanvasId(req.body?.canvasId);
  if (!canvasId) return res.status(400).json({ success: false, error: '缺少协作房间画布' });
  const revokedSessions = runProjectDatabaseWriteForHttp(
    res,
    'collaboration.sessions.revoke-all',
    () => gateway.database.revokeCanvasSessions(projectId, canvasId, {
      ...req.managementPrincipal,
    }),
  );
  if (revokedSessions === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
  const disconnectedConnections = gateway.closeCanvasConnections(projectId, canvasId, 'all canvas sessions revoked by host');
  res.json({ success: true, data: { projectId, canvasId, revokedSessions, disconnectedConnections } });
});

router.get('/audit-events', (req, res) => {
  try {
    const projectId = boundedManagementText(req.query?.projectId, 'project_id', 240, {
      required: true,
      label: '项目标识',
    });
    const canvasId = boundedManagementText(req.query?.canvasId, 'canvas_id', 240, { label: '画布标识' });
    const action = boundedManagementText(req.query?.action, 'action', 120, { label: '审计动作' });
    const actorId = boundedManagementText(req.query?.actorId, 'actor_id', 240, { label: '操作者标识' });
    const targetType = boundedManagementText(req.query?.targetType, 'target_type', 80, { label: '目标类型' });
    const offset = boundedAuditInteger(req.query?.offset, 0, AUDIT_QUERY_WINDOW_LIMIT - 1, 'offset');
    const limit = boundedAuditInteger(req.query?.limit, AUDIT_PAGE_DEFAULT_LIMIT, AUDIT_PAGE_MAX_LIMIT, 'limit');
    if (limit < 1 || offset + limit > AUDIT_QUERY_WINDOW_LIMIT) {
      throw managementInputError(
        'audit_query_invalid',
        `审计分页必须落在最近 ${AUDIT_QUERY_WINDOW_LIMIT} 条事件窗口内`,
      );
    }
    const source = gateway.database.listAuditEvents({
      projectId,
      canvasId: canvasId || undefined,
      action: action || undefined,
      limit: AUDIT_QUERY_WINDOW_LIMIT,
    });
    const filtered = source.filter((event) => (
      (!actorId || String(event.actorId || '') === actorId)
      && (!targetType || String(event.targetType || '') === targetType)
    ));
    const events = filtered.slice(offset, offset + limit).map(safeAuditEvent);
    const nextOffset = offset + events.length < filtered.length ? offset + events.length : null;
    res.json({
      success: true,
      data: {
        events,
        pagination: {
          offset,
          limit,
          nextOffset,
          hasMoreWithinWindow: nextOffset != null,
          totalWithinWindow: filtered.length,
          windowLimit: AUDIT_QUERY_WINDOW_LIMIT,
          sourceTruncated: source.length === AUDIT_QUERY_WINDOW_LIMIT,
        },
      },
    });
  } catch (error) {
    res.status(Number(error?.status) || 400).json({
      success: false,
      code: error?.code || 'audit_query_invalid',
      error: error?.message || String(error),
    });
  }
});

router.get('/execution-policy', (req, res) => {
  try {
    const projectId = normalizedManagementProjectId(req.query?.projectId);
    const excludeIntentId = boundedManagementText(req.query?.excludeIntentId, 'exclude_intent_id', 240, {
      label: '运行意图标识',
    });
    res.json({
      success: true,
      data: {
        policy: gateway.database.getExecutionPolicy(projectId),
        usage: gateway.database.getExecutionUsage(projectId, Date.now(), { excludeIntentId }),
      },
    });
  } catch (error) {
    res.status(Number(error?.status) || 400).json({
      success: false,
      code: error?.code || 'execution_usage_invalid',
      error: error?.message || String(error),
    });
  }
});

router.put('/execution-policy', (req, res) => {
  try {
    const input = normalizeExecutionPolicyInput(req.body);
    const policy = runProjectDatabaseWriteForHttp(
      res,
      'collaboration.execution-policy.update',
      () => gateway.database.setExecutionPolicy(input.projectId, input, {
        ...req.managementPrincipal,
      }),
    );
    if (policy === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
    res.json({ success: true, data: policy });
  } catch (error) {
    res.status(Number(error?.status) || 400).json({
      success: false,
      code: error?.code || 'execution_policy_invalid',
      error: error?.message || String(error),
    });
  }
});

router.get('/room-execution-policy', (req, res) => {
  try {
    const projectId = normalizedManagementProjectId(req.query?.projectId);
    const canvasId = boundedManagementText(req.query?.canvasId, 'canvas_id', 240, {
      required: true,
      label: '画布标识',
    });
    const canvas = gateway.database.getCanvas(canvasId);
    if (!canvas || String(canvas.projectId) !== projectId) {
      return res.status(404).json({ success: false, code: 'canvas_not_found', error: '画布不存在' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      data: {
        policy: gateway.database.getRoomExecutionPolicy(projectId, canvasId),
        usage: gateway.database.getRoomExecutionUsage(
          projectId,
          canvasId,
          req.managementPrincipal.actorId,
          Date.now(),
        ),
      },
    });
  } catch (error) {
    return res.status(Number(error?.status) || 400).json({
      success: false,
      code: error?.code || 'room_execution_policy_invalid',
      error: error?.message || String(error),
      ...(error?.current ? { data: { current: error.current } } : {}),
    });
  }
});

router.put('/room-execution-policy', (req, res) => {
  try {
    const input = normalizeRoomExecutionPolicyInput(req.body);
    const canvas = gateway.database.getCanvas(input.canvasId);
    if (!canvas || String(canvas.projectId) !== input.projectId) {
      return res.status(404).json({ success: false, code: 'canvas_not_found', error: '画布不存在' });
    }
    const policy = runProjectDatabaseWriteForHttp(
      res,
      'collaboration.room-execution-policy.update',
      () => gateway.database.setRoomExecutionPolicy(
        input.projectId,
        input.canvasId,
        input,
        req.managementPrincipal,
      ),
    );
    if (policy === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data: policy });
  } catch (error) {
    return res.status(Number(error?.status) || 400).json({
      success: false,
      code: error?.code || 'room_execution_policy_invalid',
      error: error?.message || String(error),
      ...(error?.current ? { data: { current: error.current } } : {}),
    });
  }
});

router.get('/review-visibility-policy', (req, res) => {
  try {
    const projectId = normalizedManagementProjectId(req.query?.projectId);
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      data: gateway.database.getProjectReviewVisibilityPolicy(projectId),
    });
  } catch (error) {
    res.status(Number(error?.status) || 400).json({
      success: false,
      code: error?.code || 'collaboration_review_visibility_policy_invalid',
      error: error?.message || String(error),
      ...(error?.details?.current ? { data: { current: error.details.current } } : {}),
    });
  }
});

router.put('/review-visibility-policy', (req, res) => {
  try {
    const input = normalizeReviewVisibilityPolicyInput(req.body);
    const policy = runProjectDatabaseWriteForHttp(
      res,
      'collaboration.review-visibility-policy.update',
      () => gateway.database.setProjectReviewVisibilityPolicy(input.projectId, input, {
        ...req.managementPrincipal,
      }),
    );
    if (policy === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: policy });
  } catch (error) {
    res.status(Number(error?.status) || 400).json({
      success: false,
      code: error?.code || 'collaboration_review_visibility_policy_invalid',
      error: error?.message || String(error),
      ...(error?.details?.current ? { data: { current: error.details.current } } : {}),
    });
  }
});

router.get('/run-intents', (req, res) => {
  const status = String(req.query?.status || '');
  const canvasId = normalizedCanvasId(req.query?.canvasId);
  if (!canvasId) return res.status(400).json({ success: false, error: '缺少协作房间画布' });
  const data = status === 'actionable'
    ? [
        ...gateway.database.listRunIntents({ projectId: req.query?.projectId, canvasId, status: 'pending' }),
        ...gateway.database.listRunIntents({ projectId: req.query?.projectId, canvasId, status: 'accepted' }),
        ...gateway.database.listRunIntents({ projectId: req.query?.projectId, canvasId, status: 'dispatching' }),
      ].sort((left, right) => (
        left.createdAt - right.createdAt
        || left.id.localeCompare(right.id)
      ))
    : gateway.database.listRunIntents({
        projectId: req.query?.projectId,
        canvasId,
        status: req.query?.status,
      });
  res.json({
    success: true,
    data,
  });
});

router.get('/run-intents/:intentId/snapshot', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const scope = normalizeRunIntentSnapshotScope(req.query);
    const intent = gateway.database.getRunIntent(req.params.intentId);
    if (!intent
      || String(intent.projectId) !== scope.projectId
      || String(intent.canvasId) !== scope.canvasId
      || Number(intent.canvasRevision) !== scope.canvasRevision) {
      return res.status(404).json({
        success: false,
        code: 'run_intent_not_found',
        error: '运行意图不存在或与请求的项目、画布、revision 不匹配',
      });
    }
    if (!['pending', 'accepted', 'dispatching', 'running'].includes(String(intent.status))) {
      return res.status(409).json({
        success: false,
        code: 'run_intent_snapshot_inactive',
        error: '运行意图当前状态不允许读取执行快照',
      });
    }

    // This entire router is loopback + management-authority protected. Keep
    // the document off the public collaboration surface and re-open the
    // current recovery-generation fence before returning historical input.
    gateway.database.getRecoveryGeneration();
    gateway.database.requiresRecoveryGeneration();
    const current = gateway.database.getCanvas(scope.canvasId);
    let document = null;
    try {
      document = gateway.database.getCanvasSnapshotDocument(
        scope.canvasId,
        scope.canvasRevision,
      );
    } catch (error) {
      const snapshotIsInvalid = new Set([
        'canvas_snapshot_integrity_conflict',
        'collaboration_domain_review_snapshot_invalid',
      ]).has(String(error?.code || ''));
      return res.status(snapshotIsInvalid ? 409 : 503).json({
        success: false,
        code: snapshotIsInvalid
          ? 'intent_canvas_snapshot_unavailable'
          : 'intent_canvas_snapshot_read_unavailable',
        error: snapshotIsInvalid
          ? '运行意图绑定的精确历史画布快照不可用，不能回退到最新版本'
          : '运行意图绑定的历史画布快照暂时无法读取，请稍后重试',
      });
    }
    if (!current
      || String(current.projectId) !== scope.projectId
      || !document
      || String(document.projectId) !== scope.projectId
      || String(document.canvasId) !== scope.canvasId
      || Number(document.revision) !== scope.canvasRevision) {
      return res.status(409).json({
        success: false,
        code: 'intent_canvas_snapshot_unavailable',
        error: '运行意图绑定的精确历史画布快照不可用，不能回退到最新版本',
      });
    }
    return res.json({ success: true, data: document });
  } catch (error) {
    return res.status(Number(error?.statusCode ?? error?.status) || 400).json({
      success: false,
      code: error?.code || 'run_intent_snapshot_read_failed',
      error: error?.message || String(error),
    });
  }
});

router.get('/run-intents/:intentId', (req, res) => {
  try {
    const scope = normalizeRunIntentScope({
      projectId: req.query?.projectId,
      canvasId: req.query?.canvasId,
    }, {
      requireRevision: false,
      allowedKeys: new Set(['projectId', 'canvasId']),
    });
    const intent = gateway.database.getRunIntent(req.params.intentId);
    if (!intent
      || String(intent.projectId) !== scope.projectId
      || String(intent.canvasId) !== scope.canvasId) {
      return res.status(404).json({ success: false, code: 'run_intent_not_found', error: '运行意图不存在' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data: intent });
  } catch (error) {
    return res.status(Number(error?.status) || 400).json({
      success: false,
      code: error?.code || 'run_intent_read_failed',
      error: error?.message || String(error),
    });
  }
});

router.post('/run-intents/:intentId/accept', (req, res) => {
  try {
    const input = normalizeRunIntentScope(req.body, {
      allowedKeys: new Set(['projectId', 'canvasId', 'expectedQueueRevision']),
    });
    const intent = runProjectDatabaseWriteForHttp(
      res,
      'collaboration.run-intent.accept',
      () => gateway.database.acceptRunIntentForDispatch(req.params.intentId, {
        ...input,
        confirmedBy: req.managementPrincipal.actorId,
        ...req.managementPrincipal,
      }),
    );
    if (intent === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
    broadcastHostRunIntentBestEffort(gateway, intent);
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data: intent });
  } catch (error) {
    return res.status(Number(error?.status) || 400).json({
      success: false,
      code: error?.code || 'run_intent_accept_failed',
      error: error?.message || String(error),
      ...(error?.current ? { data: { current: error.current } } : {}),
    });
  }
});

router.post('/run-intents/lease', (req, res) => {
  try {
    const input = normalizeRunIntentWorker(req.body, {
      requireRevision: false,
      allowExpectedIntentId: true,
      allowedKeys: new Set(['projectId', 'canvasId', 'workerId', 'leaseDurationMs', 'expectedIntentId']),
    });
    const outcome = runProjectDatabaseWriteForHttp(
      res,
      'collaboration.run-intent.lease',
      () => runCoordinatedProjectDatabaseWrite(
        gateway.database,
        'collaboration.run-intent.lease',
        () => {
          const roomPolicy = gateway.database.getRoomExecutionPolicy(input.projectId, input.canvasId);
          const leased = gateway.database.leaseRunIntentForDispatch(
            {
              projectId: input.projectId,
              canvasId: input.canvasId,
              expectedIntentId: input.expectedIntentId,
            },
            {
              workerId: input.workerId,
              leaseDurationMs: input.leaseDurationMs,
              canvasConcurrencyLimit: roomPolicy.canvasConcurrencyLimit,
              ...req.managementPrincipal,
            },
          );
          if (!leased) return { type: 'empty' };
          try {
            gateway.executionPolicy.authorizeRunIntent(leased.intent.id, {
              allowedStatuses: ['dispatching'],
              requireUnclaimed: true,
              requireConfirmationSatisfied: true,
              reservationAlreadyCounted: true,
              enforceConcurrency: true,
            });
          } catch (policyError) {
            if (String(policyError?.code || '') === 'intent_confirmation_required') {
              const pending = gateway.database.returnRunIntentToPendingConfirmation(leased.intent.id, {
                projectId: input.projectId,
                canvasId: input.canvasId,
                expectedQueueRevision: leased.intent.queueRevision,
                workerId: input.workerId,
                leaseToken: leased.leaseToken,
                ...req.managementPrincipal,
              });
              return { type: 'policy-rejected', policyError, intent: pending };
            }
            const retryable = new Set([
              'concurrency_limit',
              'daily_cost_limit',
              'daily_cost_usage_incomplete',
              'room_member_daily_run_limit',
              'project_database_recovery_generation_unavailable',
              'intent_canvas_snapshot_read_unavailable',
            ]).has(String(policyError?.code || ''));
            const released = gateway.database.releaseRunIntentDispatchLease(leased.intent.id, {
              projectId: input.projectId,
              canvasId: input.canvasId,
              expectedQueueRevision: leased.intent.queueRevision,
              workerId: input.workerId,
              leaseToken: leased.leaseToken,
              retryable,
              errorCode: String(policyError?.code || 'execution_policy_rejected'),
              errorMessage: String(policyError?.message || '执行策略复核失败'),
              ...req.managementPrincipal,
            });
            return { type: 'policy-rejected', policyError, intent: released };
          }
          return { type: 'leased', leased, intent: leased.intent };
        },
      ),
    );
    if (outcome === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
    if (outcome.type === 'empty') {
      res.set('Cache-Control', 'no-store');
      return res.json({ success: true, data: null });
    }
    broadcastHostRunIntentBestEffort(gateway, outcome.intent);
    if (outcome.type === 'policy-rejected') throw outcome.policyError;
    const { leased } = outcome;
    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      data: {
        intent: leased.intent,
        lease: {
          token: leased.leaseToken,
          owner: input.workerId,
          expiresAt: leased.intent.leaseExpiresAt,
        },
      },
    });
  } catch (error) {
    return res.status(Number(error?.httpStatus || error?.status) || 400).json({
      success: false,
      code: error?.code || 'run_intent_lease_failed',
      error: error?.message || String(error),
      ...(error?.current ? { data: { current: error.current } } : {}),
    });
  }
});

router.post('/run-intents/:intentId/lease/renew', (req, res) => {
  try {
    const input = normalizeRunIntentWorker(req.body, {
      requireToken: true,
      allowedKeys: new Set([
        'projectId', 'canvasId', 'expectedQueueRevision', 'workerId', 'leaseToken', 'leaseDurationMs',
      ]),
    });
    const intent = runProjectDatabaseWriteForHttp(
      res,
      'collaboration.run-intent.lease-renew',
      () => gateway.database.renewRunIntentDispatchLease(req.params.intentId, {
        ...input,
        ...req.managementPrincipal,
      }),
    );
    if (intent === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
    broadcastHostRunIntentBestEffort(gateway, intent);
    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      data: {
        intent,
        lease: { owner: input.workerId, expiresAt: intent.leaseExpiresAt },
      },
    });
  } catch (error) {
    return res.status(Number(error?.status) || 400).json({
      success: false,
      code: error?.code || 'run_intent_lease_renew_failed',
      error: error?.message || String(error),
      ...(error?.current ? { data: { current: error.current } } : {}),
    });
  }
});

router.post('/run-intents/:intentId/lease/release', (req, res) => {
  try {
    const input = normalizeRunIntentWorker(req.body, {
      requireToken: true,
      allowedKeys: new Set([
        'projectId', 'canvasId', 'expectedQueueRevision', 'workerId', 'leaseToken',
        'retryable', 'errorCode', 'errorMessage',
      ]),
    });
    if (req.body.retryable != null && typeof req.body.retryable !== 'boolean') {
      throw managementInputError('run_intent_release_invalid', 'retryable 必须是布尔值');
    }
    const intent = runProjectDatabaseWriteForHttp(
      res,
      'collaboration.run-intent.lease-release',
      () => gateway.database.releaseRunIntentDispatchLease(req.params.intentId, {
        ...input,
        retryable: req.body.retryable !== false,
        errorCode: boundedManagementText(req.body.errorCode, 'error_code', 120, { label: '错误代码' }),
        errorMessage: boundedManagementText(req.body.errorMessage, 'error_message', 600, { label: '错误说明' }),
        ...req.managementPrincipal,
      }),
    );
    if (intent === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
    broadcastHostRunIntentBestEffort(gateway, intent);
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data: intent });
  } catch (error) {
    return res.status(Number(error?.status) || 400).json({
      success: false,
      code: error?.code || 'run_intent_lease_release_failed',
      error: error?.message || String(error),
      ...(error?.current ? { data: { current: error.current } } : {}),
    });
  }
});

router.post('/run-intents/:intentId/cancel', (req, res) => {
  try {
    const input = normalizeRunIntentScope(req.body, {
      allowedKeys: new Set(['projectId', 'canvasId', 'expectedQueueRevision']),
    });
    const intent = runProjectDatabaseWriteForHttp(
      res,
      'collaboration.run-intent.cancel',
      () => gateway.database.requestRunIntentCancellation(req.params.intentId, {
        ...input,
        ...req.managementPrincipal,
      }),
    );
    if (intent === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
    broadcastHostRunIntentBestEffort(gateway, intent);
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data: intent });
  } catch (error) {
    return res.status(Number(error?.status) || 400).json({
      success: false,
      code: error?.code || 'run_intent_cancel_failed',
      error: error?.message || String(error),
      ...(error?.current ? { data: { current: error.current } } : {}),
    });
  }
});

router.patch('/run-intents/:intentId', (req, res) => {
  try {
    const input = normalizeRunIntentScope(req.body, {
      allowedKeys: new Set(['projectId', 'canvasId', 'expectedQueueRevision', 'status']),
    });
    const intent = runProjectDatabaseWriteForHttp(
      res,
      'collaboration.run-intent.update',
      () => gateway.database.transitionRunIntentQueueState(req.params.intentId, {
        ...input,
        status: req.body.status,
        ...req.managementPrincipal,
      }),
    );
    if (intent === PROJECT_DATABASE_CAPACITY_RESPONSE_SENT) return;
    broadcastHostRunIntentBestEffort(gateway, intent);
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data: intent });
  } catch (error) {
    return res.status(Number(error?.status) || 400).json({
      success: false,
      code: error?.code || 'run_intent_update_failed',
      error: error?.message || String(error),
      ...(error?.details?.current ? { data: { current: error.details.current } } : {}),
    });
  }
});

  return router;
}

const router = createCollaborationRouter();

module.exports = router;
module.exports.createCollaborationRouter = createCollaborationRouter;
module.exports.localManagementOrigin = localManagementOrigin;
module.exports.trustedManagementBrowserRequest = trustedManagementBrowserRequest;
