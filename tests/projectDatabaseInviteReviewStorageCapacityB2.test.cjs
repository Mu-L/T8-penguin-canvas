'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');
const {
  CollaborationAuth,
  hashSecret,
} = require('../backend/src/collaboration/auth');

const IDS = Object.freeze({
  canvasEntity: '32000000-0000-4000-8000-000000000001',
  inviteMember: '32000000-0000-4000-8000-000000000002',
  inviteSession: '32000000-0000-4000-8000-000000000003',
  reviewActor: '32000000-0000-4000-8000-000000000004',
  reviewRecipient: '32000000-0000-4000-8000-000000000005',
  reviewThread: '32000000-0000-4000-8000-000000000006',
  reviewComment: '32000000-0000-4000-8000-000000000007',
});

function scalarCount(database, sql, ...values) {
  return Number(database.db.prepare(sql).get(...values)?.count || 0);
}

function insertReviewMember(database, id, projectId, canvasId, displayName) {
  const now = Date.now();
  database.db.prepare(`
    INSERT INTO collaboration_members(
      id, project_id, canvas_id, display_name, role, capabilities_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'reviewer', '["comment","approve"]', ?, ?)
  `).run(id, projectId, canvasId, displayName, now, now);
}

function installLateAuditFull(database, fixtureName, auditAction) {
  const markerName = `${fixtureName}_mark_late_audit`;
  const tableName = `${fixtureName}_filler`;
  const triggerName = `${fixtureName}_force_late_full`;
  let lateAuditHits = 0;

  database.db.function(markerName, () => {
    lateAuditHits += 1;
    return 1;
  });
  database.db.exec(`
    CREATE TABLE ${tableName} (
      id INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT ON audit_events
    WHEN NEW.action = '${auditAction}'
    BEGIN
      SELECT ${markerName}();
      INSERT INTO ${tableName}(payload) VALUES (zeroblob(4194304));
    END;
  `);
  database.db.pragma('wal_checkpoint(TRUNCATE)');
  database.db.exec('VACUUM');
  database.db.pragma('wal_checkpoint(TRUNCATE)');

  const pageCount = Number(database.db.pragma('page_count', { simple: true }));
  const constrainedPageCount = pageCount + 64;
  assert.equal(
    Number(database.db.pragma(`max_page_count = ${constrainedPageCount}`, { simple: true })),
    constrainedPageCount,
  );

  return {
    tableName,
    lateAuditHits: () => lateAuditHits,
    release() {
      database.db.pragma('max_page_count = 1073741823');
    },
  };
}

function assertStorageCapacityError(error, operation) {
  assert.ok(error instanceof ProjectDatabaseStorageCapacityError);
  assert.equal(error.code, 'project_database_storage_capacity_exceeded');
  assert.equal(error.status, 507);
  assert.equal(error.statusCode, 507);
  assert.equal(error.reason, 'sqlite-full');
  assert.deepEqual(error.details, {
    reason: 'sqlite-full',
    retryable: false,
    operation,
  });
  return true;
}

function invokeWithTransactionFailure(methodName, args, error) {
  const transaction = () => {
    throw error;
  };
  transaction.immediate = () => {
    throw error;
  };
  const context = {
    projectDatabaseWriteDepth: 0,
    projectDatabaseReadSnapshotDepth: 0,
    db: {
      inTransaction: false,
      transaction() {
        return transaction;
      },
    },
    withProjectDatabaseWrite: ProjectDatabase.prototype.withProjectDatabaseWrite,
  };
  return ProjectDatabase.prototype[methodName].call(context, ...args);
}

test('B2 invite/review boundaries translate raw capacity errors and preserve BUSY/business errors', () => {
  for (const [methodName, args, operation] of [
    ['redeemInvite', ['code-hash', {}], 'collaboration.invite.redeem'],
    ['createReviewThreadWithComment', [{}, {}], 'review.thread.create'],
  ]) {
    for (const [code, reason] of [
      ['SQLITE_FULL', 'sqlite-full'],
      ['ENOSPC', 'filesystem-reserve'],
      ['EDQUOT', 'filesystem-reserve'],
    ]) {
      const rawCapacity = Object.assign(new Error('private raw capacity failure'), { code });
      assert.throws(
        () => invokeWithTransactionFailure(methodName, args, rawCapacity),
        (error) => error instanceof ProjectDatabaseStorageCapacityError
          && error.code === 'project_database_storage_capacity_exceeded'
          && error.status === 507
          && error.reason === reason
          && error.details?.operation === operation,
      );
    }

    const busy = Object.assign(new Error('writer is busy'), { code: 'SQLITE_BUSY' });
    assert.throws(
      () => invokeWithTransactionFailure(methodName, args, busy),
      (error) => error === busy,
    );

    const business = Object.assign(new Error('review conflict'), {
      code: 'collaboration_domain_review_cas_conflict',
      status: 409,
    });
    assert.throws(
      () => invokeWithTransactionFailure(methodName, args, business),
      (error) => error === business,
    );
  }
});

test('B2 createInvite authorizes and persists inside one ProjectDatabase coordinator boundary', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const auth = new CollaborationAuth(database);
  const projectId = 'project-invite-writer-boundary-b2';
  const canvasId = 'canvas-invite-writer-boundary-b2';
  const missingCanvasId = 'canvas-invite-missing-state-b2';
  const observed = [];
  const originals = new Map();

  try {
    database.ensureCanvas(canvasId, {
      projectId,
      entityUid: IDS.canvasEntity,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }, projectId);
    database.ensureCanvas(missingCanvasId, {
      projectId,
      entityUid: '32000000-0000-4000-8000-000000000008',
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }, projectId);
    if (Number(database.getCanvasResourceGrantState(projectId, canvasId)?.initializedAt) <= 0) {
      database.initializeCanvasResourceGrantsForSharing(projectId, canvasId);
    }

    for (const methodName of [
      'getCanvas',
      'getCanvasResourceGrantState',
      'resolveCanvasDocumentResources',
      'createInvite',
    ]) {
      const original = database[methodName];
      originals.set(methodName, original);
      database[methodName] = function (...args) {
        observed.push({
          methodName,
          inTransaction: this.db.inTransaction,
          coordinatorActive: this.isProjectDatabaseWriteCoordinatorActive(),
        });
        return original.apply(this, args);
      };
    }

    const invite = auth.createInvite({
      projectId,
      canvasId,
      role: 'viewer',
      maxUses: 1,
    });
    assert.equal(invite.projectId, projectId);
    assert.equal(invite.canvasId, canvasId);
    assert.equal(database.db.inTransaction, false);
    for (const methodName of [
      'getCanvas',
      'getCanvasResourceGrantState',
      'resolveCanvasDocumentResources',
      'createInvite',
    ]) {
      const entries = observed.filter((entry) => entry.methodName === methodName);
      assert.ok(entries.length > 0, `${methodName} must participate in invite creation`);
      assert.equal(entries.every((entry) => entry.inTransaction), true, `${methodName} must run in the transaction`);
      assert.equal(
        entries.every((entry) => entry.coordinatorActive),
        true,
        `${methodName} must run under the ProjectDatabase writer coordinator`,
      );
    }
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM collaboration_invites WHERE id = ?',
      invite.id,
    ), 1);
    assert.equal(scalarCount(
      database,
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE action = 'collaboration.invite.create' AND target_id = ?`,
      invite.id,
    ), 1);

    for (const [methodName, original] of originals) database[methodName] = original;
    originals.clear();
    database.db.prepare(`
      DELETE FROM canvas_resource_grant_state
      WHERE project_id = ? AND canvas_id = ?
    `).run(projectId, missingCanvasId);
    assert.equal(database.getCanvasResourceGrantState(projectId, missingCanvasId), null);
    assert.throws(() => auth.createInvite({
      projectId,
      canvasId: missingCanvasId,
      role: 'viewer',
      maxUses: 1,
    }), (error) => error?.code === 'canvas_resource_scope_confirmation_required'
      && error?.status === 409);
    assert.equal(
      database.getCanvasResourceGrantState(projectId, missingCanvasId),
      null,
      'invite authorization must not repair missing resource state',
    );
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM collaboration_invites WHERE canvas_id = ?',
      missingCanvasId,
    ), 0);
    assert.equal(database.db.inTransaction, false);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    for (const [methodName, original] of originals) database[methodName] = original;
    await database.close();
  }
});

test('B2 createInvite translates a late real SQLITE_FULL, rolls back, then retries the business request', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-invite-create-capacity-b2-'));
  const filename = path.join(directory, 'project.sqlite3');
  let database = null;
  let fault = null;

  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    const auth = new CollaborationAuth(database);
    const projectId = 'project-invite-create-capacity-b2';
    const canvasId = 'canvas-invite-create-capacity-b2';
    database.ensureCanvas(canvasId, {
      projectId,
      entityUid: '32000000-0000-4000-8000-000000000009',
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }, projectId);
    if (Number(database.getCanvasResourceGrantState(projectId, canvasId)?.initializedAt) <= 0) {
      database.initializeCanvasResourceGrantsForSharing(projectId, canvasId);
    }
    fault = installLateAuditFull(
      database,
      'invite_create_capacity_b2',
      'collaboration.invite.create',
    );

    const request = Object.freeze({ projectId, canvasId, role: 'reviewer', maxUses: 2 });
    assert.throws(
      () => auth.createInvite(request),
      (error) => assertStorageCapacityError(error, 'collaboration.invite.create'),
    );
    assert.equal(fault.lateAuditHits(), 1, 'FULL must occur after the invite row is inserted');
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM collaboration_invites WHERE canvas_id = ?',
      canvasId,
    ), 0);
    assert.equal(scalarCount(
      database,
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE action = 'collaboration.invite.create' AND canvas_id = ?`,
      canvasId,
    ), 0);
    assert.equal(scalarCount(database, `SELECT COUNT(*) AS count FROM ${fault.tableName}`), 0);
    assert.equal(database.db.inTransaction, false);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    fault.release();
    const invite = auth.createInvite(request);
    assert.equal(invite.projectId, projectId);
    assert.equal(invite.canvasId, canvasId);
    assert.equal(invite.role, 'reviewer');
    assert.equal(invite.maxUses, 2);
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM collaboration_invites WHERE id = ?',
      invite.id,
    ), 1);
    assert.equal(scalarCount(
      database,
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE action = 'collaboration.invite.create' AND target_id = ?`,
      invite.id,
    ), 1);
    assert.equal(scalarCount(database, `SELECT COUNT(*) AS count FROM ${fault.tableName}`), 1);
    assert.equal(database.db.inTransaction, false);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try { fault?.release(); } catch (_) {}
    try { await database?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('B2 redeemInvite translates a late real SQLITE_FULL, fully rolls back, then retries the same record', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-invite-capacity-b2-'));
  const filename = path.join(directory, 'project.sqlite3');
  let database = null;
  let fault = null;

  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    const auth = new CollaborationAuth(database);
    const projectId = 'project-invite-capacity-b2';
    const canvasId = 'canvas-invite-capacity-b2';
    database.ensureCanvas(canvasId, {
      projectId,
      entityUid: IDS.canvasEntity,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }, projectId);
    const invite = auth.createInvite({
      projectId,
      canvasId,
      role: 'viewer',
      maxUses: 1,
    });
    const record = Object.freeze({
      memberId: IDS.inviteMember,
      sessionId: IDS.inviteSession,
      tokenHash: 'a'.repeat(64),
      displayName: 'Capacity retry member',
      sessionExpiresAt: Date.now() + 60 * 60 * 1000,
      expectedCanvasId: canvasId,
    });
    fault = installLateAuditFull(
      database,
      'invite_capacity_b2',
      'collaboration.invite.redeem',
    );

    assert.throws(
      () => database.redeemInvite(hashSecret(invite.code), record),
      (error) => assertStorageCapacityError(error, 'collaboration.invite.redeem'),
    );
    assert.equal(fault.lateAuditHits(), 1, 'FULL must occur at the final invite audit write');
    assert.equal(database.db.prepare(`
      SELECT use_count FROM collaboration_invites WHERE id = ?
    `).get(invite.id).use_count, 0);
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM collaboration_members WHERE id = ?',
      record.memberId,
    ), 0);
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM collaboration_sessions WHERE id = ?',
      record.sessionId,
    ), 0);
    assert.equal(scalarCount(
      database,
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE action = 'collaboration.invite.redeem' AND target_id = ?`,
      invite.id,
    ), 0);
    assert.equal(scalarCount(database, `SELECT COUNT(*) AS count FROM ${fault.tableName}`), 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    fault.release();
    const retried = database.redeemInvite(hashSecret(invite.code), record);
    assert.ok(retried);
    assert.equal(retried.memberId, record.memberId);
    assert.equal(retried.sessionId, record.sessionId);
    assert.equal(database.db.prepare(`
      SELECT use_count FROM collaboration_invites WHERE id = ?
    `).get(invite.id).use_count, 1);
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM collaboration_members WHERE id = ?',
      record.memberId,
    ), 1);
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM collaboration_sessions WHERE id = ?',
      record.sessionId,
    ), 1);
    assert.equal(scalarCount(
      database,
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE action = 'collaboration.invite.redeem' AND target_id = ?`,
      invite.id,
    ), 1);
    assert.equal(scalarCount(database, `SELECT COUNT(*) AS count FROM ${fault.tableName}`), 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try { fault?.release(); } catch (_) {}
    try { await database?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('B2 createReviewThreadWithComment translates a late real SQLITE_FULL, fully rolls back, then retries exactly', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-review-capacity-b2-'));
  const filename = path.join(directory, 'project.sqlite3');
  let database = null;
  let fault = null;

  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    const projectId = 'project-review-capacity-b2';
    const canvasId = 'canvas-review-capacity-b2';
    database.ensureCanvas(canvasId, {
      projectId,
      entityUid: IDS.canvasEntity,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }, projectId);
    insertReviewMember(database, IDS.reviewActor, projectId, canvasId, 'Review actor');
    insertReviewMember(database, IDS.reviewRecipient, projectId, canvasId, 'Review recipient');

    const input = Object.freeze({
      id: IDS.reviewThread,
      entityUid: IDS.reviewThread,
      projectId,
      canvasId,
      canvasRevision: 1,
      anchor: Object.freeze({
        kind: 'canvas',
        targetEntityUid: IDS.canvasEntity,
        x: 1,
        y: 2,
      }),
      severity: 'normal',
      createdBy: IDS.reviewActor,
    });
    const options = Object.freeze({
      commentId: IDS.reviewComment,
      commentEntityUid: IDS.reviewComment,
      body: 'The exact review request must be retryable after storage is available.',
      mentions: Object.freeze([IDS.reviewRecipient]),
      actorId: IDS.reviewActor,
      sessionId: 'review-capacity-session',
      sourceOperationId: 'review-capacity-b2-exact-request',
    });
    fault = installLateAuditFull(
      database,
      'review_capacity_b2',
      'review.thread.create',
    );

    assert.throws(
      () => database.createReviewThreadWithComment(input, options),
      (error) => assertStorageCapacityError(error, 'review.thread.create'),
    );
    assert.equal(fault.lateAuditHits(), 1, 'FULL must occur after review rows and notifications');
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM review_threads WHERE id = ?',
      input.id,
    ), 0);
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM review_comments WHERE id = ?',
      options.commentId,
    ), 0);
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM review_comment_mentions WHERE comment_id = ?',
      options.commentId,
    ), 0);
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM collaboration_notifications WHERE source_operation_id = ?',
      options.sourceOperationId,
    ), 0);
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM canvas_snapshot_pins WHERE owner_id = ?',
      input.id,
    ), 0);
    assert.equal(scalarCount(
      database,
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE action = 'review.thread.create' AND target_id = ?`,
      input.entityUid,
    ), 0);
    assert.equal(scalarCount(database, `SELECT COUNT(*) AS count FROM ${fault.tableName}`), 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    fault.release();
    const retried = database.createReviewThreadWithComment(input, options);
    assert.equal(retried.id, input.id);
    assert.equal(retried.comment.id, options.commentId);
    assert.deepEqual(retried.comment.mentions, [IDS.reviewRecipient]);
    assert.equal(retried.notifications.length, 1);
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM review_threads WHERE id = ?',
      input.id,
    ), 1);
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM review_comments WHERE id = ?',
      options.commentId,
    ), 1);
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM review_comment_mentions WHERE comment_id = ?',
      options.commentId,
    ), 1);
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM collaboration_notifications WHERE source_operation_id = ?',
      options.sourceOperationId,
    ), 1);
    assert.equal(scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM canvas_snapshot_pins WHERE owner_id = ?',
      input.id,
    ), 1);
    assert.equal(scalarCount(
      database,
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE action = 'review.thread.create' AND target_id = ?`,
      input.entityUid,
    ), 1);
    assert.equal(scalarCount(database, `SELECT COUNT(*) AS count FROM ${fault.tableName}`), 1);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try { fault?.release(); } catch (_) {}
    try { await database?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
