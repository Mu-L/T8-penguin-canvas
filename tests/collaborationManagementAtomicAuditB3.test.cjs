const test = require('node:test');
const assert = require('node:assert/strict');

const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'project-b3-atomic';
const OTHER_PROJECT_ID = 'project-b3-atomic-other';
const CANVAS_A = 'canvas-b3-atomic-a';
const CANVAS_B = 'canvas-b3-atomic-b';
const OTHER_CANVAS = 'canvas-b3-atomic-other';
const MANAGEMENT_OPTIONS = Object.freeze({
  actorId: 'owner-b3-atomic',
  sessionId: 'session-b3-atomic-management',
});

function createDatabase() {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  database.ensureCanvas(CANVAS_A, { name: 'B3 atomic A', nodes: [], edges: [] }, PROJECT_ID);
  database.ensureCanvas(CANVAS_B, { name: 'B3 atomic B', nodes: [], edges: [] }, PROJECT_ID);
  database.ensureCanvas(OTHER_CANVAS, { name: 'B3 atomic other', nodes: [], edges: [] }, OTHER_PROJECT_ID);
  return database;
}

function insertMember(database, {
  id,
  projectId = PROJECT_ID,
  canvasId = CANVAS_A,
  displayName = id,
  role = 'editor',
  capabilities = ['editCanvas', 'runWorkflow'],
  now = 10_000,
}) {
  database.db.prepare(`
    INSERT INTO collaboration_members(
      id, project_id, canvas_id, display_name, role, capabilities_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, canvasId, displayName, role, JSON.stringify(capabilities), now, now);
  return database.getCollaborationMember(id);
}

function insertSession(database, {
  id,
  memberId,
  projectId = PROJECT_ID,
  canvasId = CANVAS_A,
  now = 10_000,
}) {
  database.db.prepare(`
    INSERT INTO collaboration_sessions(
      id, project_id, canvas_id, member_id, token_hash,
      expires_at, revoked_at, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(id, projectId, canvasId, memberId, `hash-${id}`, now + 86_400_000, now, now);
  return database.db.prepare('SELECT * FROM collaboration_sessions WHERE id = ?').get(id);
}

function inviteRecord(id, canvasId = CANVAS_A) {
  return {
    id,
    projectId: PROJECT_ID,
    canvasId,
    codeHash: `hash-${id}`,
    role: 'viewer',
    capabilities: ['viewCanvas'],
    expiresAt: 86_410_000,
    maxUses: 2,
    createdAt: 10_000,
    createdBy: MANAGEMENT_OPTIONS.actorId,
    sessionId: MANAGEMENT_OPTIONS.sessionId,
  };
}

function failAudit(database, action) {
  database.db.exec(`
    CREATE TRIGGER fail_b3_management_atomic_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.action = '${action}'
    BEGIN
      SELECT RAISE(ABORT, 'forced B3 management audit failure');
    END;
  `);
}

function auditCount(database, action) {
  return Number(database.db.prepare(
    'SELECT COUNT(*) AS count FROM audit_events WHERE action = ?',
  ).get(action).count);
}

function assertDatabaseHealthy(database) {
  assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.db.pragma('foreign_key_check'), []);
}

async function withDatabase(run) {
  const database = createDatabase();
  try {
    await run(database);
    assertDatabaseHealthy(database);
  } finally {
    await database.close();
  }
}

test('B3 collaboration management mutations roll back completely when their audit append fails', async (t) => {
  await t.test('createInvite rolls back the inserted invite', () => withDatabase(async (database) => {
    failAudit(database, 'collaboration.invite.create');
    assert.throws(
      () => database.createInvite(inviteRecord('invite-create-b3')),
      /forced B3 management audit failure/,
    );
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_invites').get().count, 0);
    assert.equal(auditCount(database, 'collaboration.invite.create'), 0);
  }));

  await t.test('revokeInvite rolls back revoked_at', () => withDatabase(async (database) => {
    database.createInvite(inviteRecord('invite-revoke-b3'));
    const before = database.db.prepare('SELECT * FROM collaboration_invites WHERE id = ?').get('invite-revoke-b3');
    failAudit(database, 'collaboration.invite.revoke');
    assert.throws(
      () => database.revokeInvite('invite-revoke-b3', {
        expectedProjectId: PROJECT_ID,
        expectedCanvasId: CANVAS_A,
        ...MANAGEMENT_OPTIONS,
      }),
      /forced B3 management audit failure/,
    );
    assert.deepEqual(
      database.db.prepare('SELECT * FROM collaboration_invites WHERE id = ?').get('invite-revoke-b3'),
      before,
    );
    assert.equal(auditCount(database, 'collaboration.invite.revoke'), 0);
  }));

  await t.test('revokeSession rolls back the exact session', () => withDatabase(async (database) => {
    insertMember(database, { id: 'member-session-b3' });
    const before = insertSession(database, { id: 'session-revoke-b3', memberId: 'member-session-b3' });
    failAudit(database, 'collaboration.session.revoke');
    assert.throws(
      () => database.revokeSession('session-revoke-b3', {
        expectedProjectId: PROJECT_ID,
        expectedCanvasId: CANVAS_A,
        ...MANAGEMENT_OPTIONS,
      }),
      /forced B3 management audit failure/,
    );
    assert.deepEqual(
      database.db.prepare('SELECT * FROM collaboration_sessions WHERE id = ?').get('session-revoke-b3'),
      before,
    );
    assert.equal(auditCount(database, 'collaboration.session.revoke'), 0);
  }));

  await t.test('revokeMemberSessions rolls back every member session', () => withDatabase(async (database) => {
    insertMember(database, { id: 'member-revoke-sessions-b3' });
    insertSession(database, { id: 'member-session-b3-a', memberId: 'member-revoke-sessions-b3' });
    insertSession(database, { id: 'member-session-b3-b', memberId: 'member-revoke-sessions-b3' });
    failAudit(database, 'collaboration.sessions.revoke-member');
    assert.throws(
      () => database.revokeMemberSessions('member-revoke-sessions-b3', {
        expectedProjectId: PROJECT_ID,
        expectedCanvasId: CANVAS_A,
        ...MANAGEMENT_OPTIONS,
      }),
      /forced B3 management audit failure/,
    );
    assert.deepEqual(
      database.db.prepare(`
        SELECT id, revoked_at FROM collaboration_sessions
        WHERE member_id = ? ORDER BY id ASC
      `).all('member-revoke-sessions-b3'),
      [
        { id: 'member-session-b3-a', revoked_at: null },
        { id: 'member-session-b3-b', revoked_at: null },
      ],
    );
    assert.equal(auditCount(database, 'collaboration.sessions.revoke-member'), 0);
  }));

  await t.test('revokeProjectSessions rolls back every project session', () => withDatabase(async (database) => {
    insertMember(database, { id: 'project-member-b3-a', canvasId: CANVAS_A });
    insertMember(database, { id: 'project-member-b3-b', canvasId: CANVAS_B });
    insertSession(database, { id: 'project-session-b3-a', memberId: 'project-member-b3-a', canvasId: CANVAS_A });
    insertSession(database, { id: 'project-session-b3-b', memberId: 'project-member-b3-b', canvasId: CANVAS_B });
    failAudit(database, 'collaboration.sessions.revoke-project');
    assert.throws(
      () => database.revokeProjectSessions(PROJECT_ID, MANAGEMENT_OPTIONS),
      /forced B3 management audit failure/,
    );
    assert.deepEqual(
      database.db.prepare(`
        SELECT id, revoked_at FROM collaboration_sessions
        WHERE project_id = ? ORDER BY id ASC
      `).all(PROJECT_ID),
      [
        { id: 'project-session-b3-a', revoked_at: null },
        { id: 'project-session-b3-b', revoked_at: null },
      ],
    );
    assert.equal(auditCount(database, 'collaboration.sessions.revoke-project'), 0);
  }));

  await t.test('revokeCanvasSessions rolls back only-targeted canvas updates', () => withDatabase(async (database) => {
    insertMember(database, { id: 'canvas-member-b3-a', canvasId: CANVAS_A });
    insertMember(database, { id: 'canvas-member-b3-b', canvasId: CANVAS_B });
    insertSession(database, { id: 'canvas-session-b3-a', memberId: 'canvas-member-b3-a', canvasId: CANVAS_A });
    insertSession(database, { id: 'canvas-session-b3-b', memberId: 'canvas-member-b3-b', canvasId: CANVAS_B });
    failAudit(database, 'collaboration.sessions.revoke-canvas');
    assert.throws(
      () => database.revokeCanvasSessions(PROJECT_ID, CANVAS_A, MANAGEMENT_OPTIONS),
      /forced B3 management audit failure/,
    );
    assert.deepEqual(
      database.db.prepare(`
        SELECT id, revoked_at FROM collaboration_sessions
        WHERE project_id = ? ORDER BY id ASC
      `).all(PROJECT_ID),
      [
        { id: 'canvas-session-b3-a', revoked_at: null },
        { id: 'canvas-session-b3-b', revoked_at: null },
      ],
    );
    assert.equal(auditCount(database, 'collaboration.sessions.revoke-canvas'), 0);
  }));

  await t.test('updateMember rolls back identity, role, capabilities, and authorization epoch', () => withDatabase(async (database) => {
    const before = insertMember(database, {
      id: 'member-update-b3',
      displayName: 'Before update',
      role: 'editor',
      capabilities: ['editCanvas', 'runWorkflow'],
    });
    failAudit(database, 'collaboration.member.update');
    assert.throws(
      () => database.updateMember('member-update-b3', {
        displayName: 'After update',
        role: 'reviewer',
        capabilities: ['viewCanvas', 'comment'],
      }, {
        expectedProjectId: PROJECT_ID,
        expectedCanvasId: CANVAS_A,
        ...MANAGEMENT_OPTIONS,
      }),
      /forced B3 management audit failure/,
    );
    assert.deepEqual(database.getCollaborationMember('member-update-b3'), before);
    assert.equal(auditCount(database, 'collaboration.member.update'), 0);
  }));

  await t.test('removeMember rolls back nested session revocation, member deletion, and both audits', () => withDatabase(async (database) => {
    const memberBefore = insertMember(database, {
      id: 'member-remove-b3',
      displayName: 'Must survive',
    });
    const sessionBefore = insertSession(database, {
      id: 'session-remove-b3',
      memberId: 'member-remove-b3',
    });
    failAudit(database, 'collaboration.member.remove');
    assert.throws(
      () => database.removeMember('member-remove-b3', {
        expectedProjectId: PROJECT_ID,
        expectedCanvasId: CANVAS_A,
        ...MANAGEMENT_OPTIONS,
      }),
      /forced B3 management audit failure/,
    );
    assert.deepEqual(database.getCollaborationMember('member-remove-b3'), memberBefore);
    assert.deepEqual(
      database.db.prepare('SELECT * FROM collaboration_sessions WHERE id = ?').get('session-remove-b3'),
      sessionBefore,
    );
    assert.equal(auditCount(database, 'collaboration.sessions.revoke-member'), 0);
    assert.equal(auditCount(database, 'collaboration.member.remove'), 0);
  }));
});
