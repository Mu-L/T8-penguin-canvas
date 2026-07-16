const crypto = require('crypto');

const ROLE_CAPABILITIES = Object.freeze({
  owner: ['editGraph', 'publishSubflow', 'runWorkflow', 'uploadAsset', 'downloadOriginal', 'comment', 'approve', 'manageMembers', 'manageProviders'],
  editor: ['editGraph', 'publishSubflow', 'runWorkflow', 'uploadAsset', 'downloadOriginal', 'comment'],
  reviewer: ['downloadOriginal', 'comment', 'approve'],
  viewer: [],
});

const INVITABLE_ROLES = new Set(['editor', 'reviewer', 'viewer']);

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function capabilitiesForRole(role, requested) {
  const allowed = ROLE_CAPABILITIES[role] || [];
  if (!Array.isArray(requested)) return [...allowed];
  const requestedSet = new Set(requested.map(String));
  return allowed.filter((capability) => requestedSet.has(capability));
}

function sanitizeDisplayName(value) {
  const clean = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48);
  return clean || '协作者';
}

class CollaborationAuth {
  constructor(database) {
    this.database = database;
  }

  createInvite(input = {}) {
    const role = INVITABLE_ROLES.has(String(input.role)) ? String(input.role) : 'viewer';
    const code = randomSecret(18);
    const now = Date.now();
    const projectId = String(input.projectId || 'project-local').trim() || 'project-local';
    const canvasId = String(input.canvasId || '').trim();
    const canvas = canvasId ? this.database.getCanvas(canvasId) : null;
    if (!canvas || String(canvas.projectId) !== projectId) {
      throw new Error('邀请必须绑定当前项目中的有效画布');
    }
    const resourceState = this.database.ensureCanvasResourceGrantState(projectId, canvasId);
    if (!resourceState || Number(resourceState.initializedAt) <= 0) {
      const error = new Error('首次共享该画布前，需要主机确认并初始化协作资源范围');
      error.code = 'canvas_resource_scope_confirmation_required';
      error.status = 409;
      throw error;
    }
    if (Number(resourceState.trustedRevision) !== Number(canvas.revision)) {
      const error = new Error('画布资源范围已过期，需要主机重新同步后再创建邀请');
      error.code = 'canvas_resource_scope_stale';
      error.status = 409;
      throw error;
    }
    const resolvedResources = this.database.resolveCanvasDocumentResources(canvas);
    if (resolvedResources.truncated
      || resolvedResources.subflowPinMismatches.length > 0
      || resolvedResources.subflowContentMismatches.length > 0
      || resolvedResources.missingSubflows.length > 0) {
      const error = new Error('画布资源范围无法安全共享，需要主机修复后重新初始化');
      error.code = 'canvas_resource_scope_invalid';
      error.status = 409;
      throw error;
    }
    const requestedMaxUses = input.maxUses == null || input.maxUses === '' ? 1 : Number(input.maxUses);
    if (!Number.isInteger(requestedMaxUses) || requestedMaxUses < 1 || requestedMaxUses > 100) {
      throw new Error('邀请使用次数必须是 1-100 的整数');
    }
    const expiresInMs = Math.trunc(Math.min(
      30 * 24 * 60 * 60 * 1000,
      Math.max(5 * 60 * 1000, Number(input.expiresInMs) || 24 * 60 * 60 * 1000),
    ));
    const record = {
      id: crypto.randomUUID(),
      projectId,
      canvasId,
      codeHash: hashSecret(code),
      role,
      capabilities: capabilitiesForRole(role, input.capabilities),
      expiresAt: now + expiresInMs,
      maxUses: requestedMaxUses,
      createdAt: now,
      createdBy: String(input.createdBy || 'local-owner'),
      sessionId: String(input.sessionId || 'local-session'),
    };
    this.database.createInvite(record);
    return {
      id: record.id,
      code,
      projectId: record.projectId,
      canvasId: record.canvasId,
      role: record.role,
      capabilities: record.capabilities,
      expiresAt: record.expiresAt,
      maxUses: record.maxUses,
    };
  }

  redeemInvite(code, displayName, options = {}) {
    const token = randomSecret(32);
    const sessionExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const record = this.database.redeemInvite(hashSecret(code), {
      memberId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      tokenHash: hashSecret(token),
      displayName: sanitizeDisplayName(displayName),
      sessionExpiresAt,
      expectedCanvasId: options.canvasId == null ? null : String(options.canvasId),
    });
    return record ? { ...record, token } : null;
  }

  authenticate(token) {
    if (!token || String(token).length < 24) return null;
    return this.database.getSession(hashSecret(token));
  }

  revoke(sessionId, options = {}) {
    return this.database.revokeSession(sessionId, options);
  }

  rotate(session) {
    if (!session?.id) return null;
    const token = randomSecret(32);
    const record = this.database.rotateSession(session.id, {
      sessionId: crypto.randomUUID(),
      tokenHash: hashSecret(token),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    return record ? { ...record, token } : null;
  }

  revokeInvite(inviteId, options = {}) {
    return this.database.revokeInvite(inviteId, options);
  }

  updateMember(memberId, patch = {}, options = {}) {
    const role = INVITABLE_ROLES.has(String(patch.role)) ? String(patch.role) : null;
    if (!role) throw new Error('成员角色无效');
    return this.database.updateMember(memberId, {
      displayName: patch.displayName,
      role,
      capabilities: capabilitiesForRole(role, patch.capabilities),
    }, options);
  }

  removeMember(memberId, options = {}) {
    return this.database.removeMember(memberId, options);
  }

  hasCapability(session, capability) {
    return Boolean(session && Array.isArray(session.capabilities) && session.capabilities.includes(capability));
  }
}

function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch (_) { result[key] = value; }
  }
  return result;
}

module.exports = {
  ROLE_CAPABILITIES,
  INVITABLE_ROLES,
  CollaborationAuth,
  capabilitiesForRole,
  hashSecret,
  parseCookies,
};
