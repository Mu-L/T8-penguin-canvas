const express = require('express');
const config = require('../config');
const { getCollaborationGateway } = require('../collaboration/gateway');
const { buildInviteUrls } = require('../collaboration/hostManagement');

const defaultGateway = getCollaborationGateway(config);

function normalizedProjectId(value) {
  return String(value || 'project-local').trim() || 'project-local';
}

function normalizedCanvasId(value) {
  return String(value || '').trim();
}

function loopbackOnly(req, res, next) {
  const address = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!['127.0.0.1', '::1', 'localhost'].includes(address)) {
    return res.status(403).json({ success: false, error: '协作管理接口仅允许本机访问' });
  }
  next();
}

function createCollaborationRouter(gateway = defaultGateway) {
  const router = express.Router();
  router.use(loopbackOnly);

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
    gateway.database.initializeCanvasResourceGrantsForSharing(projectId, canvasId, {
      actorId: 'local-owner',
      sessionId: 'local-management',
    });
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
    const invite = gateway.auth.createInvite({ ...(req.body || {}), projectId, canvasId });
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
  const revoked = gateway.auth.revokeInvite(req.params.inviteId, {
    actorId: 'local-owner',
    sessionId: 'local-management',
    expectedProjectId: projectId,
    expectedCanvasId: canvasId,
  });
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
    const member = gateway.auth.updateMember(req.params.memberId, req.body || {}, {
      actorId: 'local-owner',
      sessionId: 'local-management',
      expectedProjectId: projectId,
      expectedCanvasId: canvasId,
    });
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
  const removed = gateway.auth.removeMember(req.params.memberId, {
    actorId: 'local-owner',
    sessionId: 'local-management',
    expectedProjectId: projectId,
    expectedCanvasId: canvasId,
  });
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
  const revoked = gateway.database.revokeSession(req.params.sessionId, {
    actorId: 'local-owner',
    sessionId: 'local-management',
    expectedProjectId: projectId,
    expectedCanvasId: canvasId,
  });
  if (!revoked) return res.status(404).json({ success: false, error: '会话不存在' });
  const disconnectedConnections = gateway.closeSessionConnections(revoked.id, 'session revoked by host');
  res.json({ success: true, data: { ...revoked, disconnectedConnections } });
});

router.post('/sessions/revoke-all', (req, res) => {
  const projectId = normalizedProjectId(req.body?.projectId);
  const canvasId = normalizedCanvasId(req.body?.canvasId);
  if (!canvasId) return res.status(400).json({ success: false, error: '缺少协作房间画布' });
  const revokedSessions = gateway.database.revokeCanvasSessions(projectId, canvasId, {
    actorId: 'local-owner',
    sessionId: 'local-management',
  });
  const disconnectedConnections = gateway.closeCanvasConnections(projectId, canvasId, 'all canvas sessions revoked by host');
  res.json({ success: true, data: { projectId, canvasId, revokedSessions, disconnectedConnections } });
});

router.get('/execution-policy', (req, res) => {
  try {
    const projectId = String(req.query?.projectId || 'project-local');
    const excludeIntentId = String(req.query?.excludeIntentId || '').trim();
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
    const projectId = String(req.body?.projectId || 'project-local');
    const policy = gateway.database.setExecutionPolicy(projectId, req.body || {}, {
      actorId: 'local-owner',
      sessionId: 'local-management',
    });
    res.json({ success: true, data: policy });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
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
      ].sort((left, right) => (
        left.createdAt - right.createdAt
        || Number(left.status === 'accepted') - Number(right.status === 'accepted')
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

router.patch('/run-intents/:intentId', (req, res) => {
  try {
    const projectId = String(req.body?.projectId || '').trim();
    if (!projectId) return res.status(400).json({ success: false, error: '缺少运行意图所属项目' });
    const canvasId = normalizedCanvasId(req.body?.canvasId);
    if (!canvasId) return res.status(400).json({ success: false, error: '缺少运行意图所属画布' });
    const current = gateway.database.getRunIntent(req.params.intentId);
    if (!current || String(current.projectId) !== projectId || String(current.canvasId) !== canvasId) {
      return res.status(404).json({ success: false, error: '运行意图不存在' });
    }
    const nextStatus = String(req.body?.status || '');
    const allowed = current.status === 'pending'
      ? new Set(['rejected', 'stale'])
      : current.status === 'accepted'
        ? new Set(['failed', 'rejected', 'stale'])
        : new Set();
    if (!allowed.has(nextStatus)) return res.status(409).json({ success: false, error: `运行意图不能从 ${current.status} 变为 ${nextStatus || '(empty)'}` });
    const intent = gateway.database.updateRunIntent(current.id, { status: nextStatus }, {
      expectedProjectId: projectId,
      expectedCanvasId: canvasId,
    });
    if (!intent) return res.status(404).json({ success: false, error: '运行意图不存在' });
    gateway.broadcastHostRunIntent(intent);
    res.json({ success: true, data: intent });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

  return router;
}

const router = createCollaborationRouter();

module.exports = router;
module.exports.createCollaborationRouter = createCollaborationRouter;
