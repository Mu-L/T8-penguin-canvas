const express = require('express');
const config = require('../config');
const { getCollaborationGateway } = require('../collaboration/gateway');

const router = express.Router();
const gateway = getCollaborationGateway(config);

function loopbackOnly(req, res, next) {
  const address = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!['127.0.0.1', '::1', 'localhost'].includes(address)) {
    return res.status(403).json({ success: false, error: '协作管理接口仅允许本机访问' });
  }
  next();
}

router.use(loopbackOnly);

router.get('/status', (_req, res) => {
  res.json({ success: true, data: gateway.status() });
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

router.post('/invites', (req, res) => {
  try {
    const invite = gateway.auth.createInvite(req.body || {});
    const baseUrl = gateway.status().running
      ? `http://127.0.0.1:${gateway.status().port}/collab?invite=${encodeURIComponent(invite.code)}`
      : null;
    res.json({ success: true, data: { ...invite, localUrl: baseUrl } });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.get('/invites', (req, res) => {
  res.json({ success: true, data: gateway.database.listInvites(String(req.query?.projectId || 'project-local')) });
});

router.delete('/invites/:inviteId', (req, res) => {
  const revoked = gateway.auth.revokeInvite(req.params.inviteId, { actorId: 'local-owner', sessionId: 'local-management' });
  if (!revoked) return res.status(404).json({ success: false, error: '邀请不存在' });
  res.json({ success: true, data: revoked });
});

router.get('/members', (req, res) => {
  res.json({ success: true, data: gateway.database.listMembers(String(req.query?.projectId || 'project-local')) });
});

router.patch('/members/:memberId', (req, res) => {
  try {
    const member = gateway.auth.updateMember(req.params.memberId, req.body || {}, { actorId: 'local-owner', sessionId: 'local-management' });
    if (!member) return res.status(404).json({ success: false, error: '成员不存在' });
    res.json({ success: true, data: member });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.delete('/members/:memberId', (req, res) => {
  const removed = gateway.auth.removeMember(req.params.memberId, { actorId: 'local-owner', sessionId: 'local-management' });
  if (!removed) return res.status(404).json({ success: false, error: '成员不存在' });
  res.json({ success: true, data: removed });
});

router.post('/sessions/revoke-all', (req, res) => {
  const projectId = String(req.body?.projectId || 'project-local');
  const revokedSessions = gateway.database.revokeProjectSessions(projectId, { actorId: 'local-owner', sessionId: 'local-management' });
  res.json({ success: true, data: { projectId, revokedSessions } });
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
  const data = status === 'actionable'
    ? [
        ...gateway.database.listRunIntents({ projectId: req.query?.projectId, status: 'pending' }),
        ...gateway.database.listRunIntents({ projectId: req.query?.projectId, status: 'accepted' }),
      ].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    : gateway.database.listRunIntents({
        projectId: req.query?.projectId,
        status: req.query?.status,
      });
  res.json({
    success: true,
    data,
  });
});

router.patch('/run-intents/:intentId', (req, res) => {
  try {
    const current = gateway.database.getRunIntent(req.params.intentId);
    if (!current) return res.status(404).json({ success: false, error: '运行意图不存在' });
    const nextStatus = String(req.body?.status || '');
    const allowed = current.status === 'pending'
      ? new Set(['rejected', 'stale'])
      : current.status === 'accepted'
        ? new Set(['failed', 'rejected', 'stale'])
        : new Set();
    if (!allowed.has(nextStatus)) return res.status(409).json({ success: false, error: `运行意图不能从 ${current.status} 变为 ${nextStatus || '(empty)'}` });
    const intent = gateway.database.updateRunIntent(current.id, { status: nextStatus });
    gateway.broadcastHostRunIntent(intent);
    res.json({ success: true, data: intent });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

module.exports = router;
