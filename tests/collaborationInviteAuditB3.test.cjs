const test = require('node:test');
const assert = require('node:assert/strict');

const { CollaborationAuth } = require('../backend/src/collaboration/auth');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

function createFixture() {
  const database = new ProjectDatabase(':memory:');
  const auth = new CollaborationAuth(database);
  database.ensureCanvas('canvas-invite-audit', { nodes: [], edges: [] }, 'project-invite-audit');
  return { auth, database };
}

function createViewerInvite(auth) {
  return auth.createInvite({
    projectId: 'project-invite-audit',
    canvasId: 'canvas-invite-audit',
    role: 'viewer',
    maxUses: 1,
  });
}

test('successful invite redemption records the new member and session in the same audit transaction', async () => {
  const { auth, database } = createFixture();
  try {
    const invite = createViewerInvite(auth);
    const redeemed = auth.redeemInvite(invite.code, 'Audited viewer');

    assert.ok(redeemed);
    const events = database.listAuditEvents({
      projectId: 'project-invite-audit',
      canvasId: 'canvas-invite-audit',
      action: 'collaboration.invite.redeem',
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].actorId, redeemed.memberId);
    assert.equal(events[0].sessionId, redeemed.sessionId);
    assert.equal(events[0].targetType, 'invite');
    assert.equal(events[0].targetId, invite.id);
    assert.deepEqual(events[0].metadata, {
      memberId: redeemed.memberId,
      role: 'viewer',
      canvasId: 'canvas-invite-audit',
    });
  } finally {
    await database.close();
  }
});

test('invite redemption rolls back use count, member and session if its audit insert fails', async () => {
  const { auth, database } = createFixture();
  try {
    const invite = createViewerInvite(auth);
    const memberCountBefore = database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_members').get().count;
    const sessionCountBefore = database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_sessions').get().count;

    database.db.exec(`
      CREATE TRIGGER fail_invite_redeem_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'collaboration.invite.redeem'
      BEGIN
        SELECT RAISE(ABORT, 'forced invite redeem audit failure');
      END;
    `);

    assert.throws(
      () => auth.redeemInvite(invite.code, 'Must roll back'),
      /forced invite redeem audit failure/,
    );
    assert.equal(
      database.db.prepare('SELECT use_count FROM collaboration_invites WHERE id = ?').get(invite.id).use_count,
      0,
    );
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_members').get().count, memberCountBefore);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_sessions').get().count, sessionCountBefore);
    assert.equal(database.listAuditEvents({
      projectId: 'project-invite-audit',
      action: 'collaboration.invite.redeem',
    }).length, 0);

    database.db.exec('DROP TRIGGER fail_invite_redeem_audit');
    const retried = auth.redeemInvite(invite.code, 'Retry succeeds');
    assert.ok(retried);
    assert.equal(database.listAuditEvents({
      projectId: 'project-invite-audit',
      action: 'collaboration.invite.redeem',
    }).length, 1);
  } finally {
    await database.close();
  }
});
