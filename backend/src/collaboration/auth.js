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
    const expiresInMs = Math.min(30 * 24 * 60 * 60 * 1000, Math.max(5 * 60 * 1000, Number(input.expiresInMs) || 24 * 60 * 60 * 1000));
    const record = {
      id: crypto.randomUUID(),
      projectId: String(input.projectId || 'project-local'),
      codeHash: hashSecret(code),
      role,
      capabilities: capabilitiesForRole(role, input.capabilities),
      expiresAt: now + expiresInMs,
      maxUses: Math.min(100, Math.max(1, Number(input.maxUses) || 1)),
      createdAt: now,
      createdBy: String(input.createdBy || 'local-owner'),
      sessionId: String(input.sessionId || 'local-session'),
    };
    this.database.createInvite(record);
    return {
      id: record.id,
      code,
      projectId: record.projectId,
      role: record.role,
      capabilities: record.capabilities,
      expiresAt: record.expiresAt,
      maxUses: record.maxUses,
    };
  }

  redeemInvite(code, displayName) {
    const token = randomSecret(32);
    const sessionExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const record = this.database.redeemInvite(hashSecret(code), {
      memberId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      tokenHash: hashSecret(token),
      displayName: sanitizeDisplayName(displayName),
      sessionExpiresAt,
    });
    return record ? { ...record, token } : null;
  }

  authenticate(token) {
    if (!token || String(token).length < 24) return null;
    return this.database.getSession(hashSecret(token));
  }

  revoke(sessionId) {
    this.database.revokeSession(sessionId);
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
