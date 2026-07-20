'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');
const {
  CollaborationAuth,
} = require('../backend/src/collaboration/auth');

const PROJECT_ID = 'project-session-rotation-capacity-b2';
const CANVAS_ID = 'canvas-session-rotation-capacity-b2';
const MAX_PAGE_COUNT_RESET = 1073741823;
const ROTATION_RECORDS = Object.freeze([
  Object.freeze({
    sessionId: '42000000-0000-4000-8000-000000000001',
    tokenHash: 'a'.repeat(64),
    expiresAt: 4102444800000,
  }),
  Object.freeze({
    sessionId: '42000000-0000-4000-8000-000000000002',
    tokenHash: 'b'.repeat(64),
    expiresAt: 4102444800000,
  }),
  Object.freeze({
    sessionId: '42000000-0000-4000-8000-000000000003',
    tokenHash: 'c'.repeat(64),
    expiresAt: 4102444800000,
  }),
]);

function scalarCount(database, sql, ...values) {
  return Number(database.db.prepare(sql).get(...values)?.count || 0);
}

function createActiveSession(database) {
  database.ensureCanvas(CANVAS_ID, {
    projectId: PROJECT_ID,
    name: 'Session rotation capacity B2',
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }, PROJECT_ID);
  const auth = new CollaborationAuth(database);
  const invite = auth.createInvite({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    role: 'editor',
    maxUses: 1,
  });
  const redeemed = auth.redeemInvite(invite.code, 'Session rotation capacity actor');
  assert.ok(redeemed);
  const session = auth.authenticate(redeemed.token);
  assert.ok(session);
  return { auth, redeemed, session };
}

function installLateRotationAuditFull(database) {
  let lateAuditHits = 0;
  database.db.function('session_rotation_capacity_b2_mark_late_audit', () => {
    lateAuditHits += 1;
    return 1;
  });
  database.db.exec(`
    CREATE TABLE session_rotation_capacity_b2_filler (
      id INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
    CREATE TRIGGER session_rotation_capacity_b2_force_late_full
    BEFORE INSERT ON audit_events
    WHEN NEW.action = 'collaboration.session.rotate'
    BEGIN
      SELECT session_rotation_capacity_b2_mark_late_audit();
      INSERT INTO session_rotation_capacity_b2_filler(payload) VALUES (zeroblob(4194304));
    END;
  `);

  const constrain = () => {
    database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
    database.db.pragma('wal_checkpoint(TRUNCATE)');
    database.db.exec('VACUUM');
    database.db.pragma('wal_checkpoint(TRUNCATE)');
    const pageCount = Number(database.db.pragma('page_count', { simple: true }));
    const constrainedPageCount = pageCount + 64;
    assert.equal(
      Number(database.db.pragma(`max_page_count = ${constrainedPageCount}`, { simple: true })),
      constrainedPageCount,
    );
  };

  constrain();
  return {
    constrain,
    lateAuditHits: () => lateAuditHits,
    release() {
      database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
    },
  };
}

function assertRotationCapacityError(error, operation) {
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

function sessionRow(database, sessionId) {
  return database.db.prepare(`
    SELECT id, token_hash, revoked_at
    FROM collaboration_sessions
    WHERE id = ?
  `).get(String(sessionId)) || null;
}

test('B2 rotateSession delegates unchanged BUSY and business errors to the unified outer writer', () => {
  for (const source of [
    Object.assign(new Error('writer remains busy'), { code: 'SQLITE_BUSY_TIMEOUT' }),
    Object.assign(new Error('session rotation conflict'), {
      code: 'collaboration_session_rotation_conflict',
      status: 409,
    }),
  ]) {
    let operation = null;
    let caught = null;
    try {
      ProjectDatabase.prototype.rotateSession.call({
        withProjectDatabaseWrite(candidateOperation) {
          operation = candidateOperation;
          throw source;
        },
      }, 'old-session', ROTATION_RECORDS[0]);
    } catch (error) {
      caught = error;
    }
    assert.equal(operation, 'collaboration.session.rotate');
    assert.strictEqual(caught, source);
  }
});

test('B2 rotateSession rolls back a real late audit FULL, retries the exact session request, and leaves nested translation to the outer writer', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-session-rotation-capacity-b2-'));
  const filename = path.join(directory, 'project.sqlite3');
  const database = new ProjectDatabase(filename, { autoBackup: false });
  let blocker = null;
  let fault = null;

  try {
    const { auth, redeemed, session: original } = createActiveSession(database);
    const originalRow = sessionRow(database, original.id);
    const auditBefore = scalarCount(
      database,
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE project_id = ? AND action = 'collaboration.session.rotate'`,
      PROJECT_ID,
    );
    fault = installLateRotationAuditFull(database);

    assert.throws(
      () => database.rotateSession(original.id, ROTATION_RECORDS[0]),
      (error) => assertRotationCapacityError(error, 'collaboration.session.rotate'),
    );
    assert.equal(fault.lateAuditHits(), 1, 'FULL must occur after revoke and replacement insert at audit append');
    assert.deepEqual(sessionRow(database, original.id), originalRow);
    assert.equal(sessionRow(database, ROTATION_RECORDS[0].sessionId), null);
    assert.equal(auth.authenticate(redeemed.token)?.id, original.id, 'the old token must remain valid after rollback');
    assert.equal(scalarCount(
      database,
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE project_id = ? AND action = 'collaboration.session.rotate'`,
      PROJECT_ID,
    ), auditBefore);
    assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM session_rotation_capacity_b2_filler'), 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    fault.release();
    const retried = database.rotateSession(original.id, ROTATION_RECORDS[0]);
    assert.equal(retried.id, ROTATION_RECORDS[0].sessionId);
    assert.equal(retried.memberId, original.memberId);
    assert.ok(sessionRow(database, original.id).revoked_at > 0);
    assert.deepEqual(sessionRow(database, ROTATION_RECORDS[0].sessionId), {
      id: ROTATION_RECORDS[0].sessionId,
      token_hash: ROTATION_RECORDS[0].tokenHash,
      revoked_at: null,
    });
    assert.equal(auth.authenticate(redeemed.token), null);
    assert.equal(database.getSession(ROTATION_RECORDS[0].tokenHash)?.id, ROTATION_RECORDS[0].sessionId);
    assert.equal(scalarCount(
      database,
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE project_id = ? AND action = 'collaboration.session.rotate'`,
      PROJECT_ID,
    ), auditBefore + 1);
    assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM session_rotation_capacity_b2_filler'), 1);

    fault.constrain();
    assert.throws(
      () => database.withProjectDatabaseWrite('collaboration.session.rotate.outer-test', () => (
        database.rotateSession(ROTATION_RECORDS[0].sessionId, ROTATION_RECORDS[1])
      )),
      (error) => assertRotationCapacityError(error, 'collaboration.session.rotate.outer-test'),
    );
    assert.equal(fault.lateAuditHits(), 3);
    assert.equal(sessionRow(database, ROTATION_RECORDS[0].sessionId).revoked_at, null);
    assert.equal(sessionRow(database, ROTATION_RECORDS[1].sessionId), null);
    assert.equal(scalarCount(
      database,
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE project_id = ? AND action = 'collaboration.session.rotate'`,
      PROJECT_ID,
    ), auditBefore + 1);
    assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM session_rotation_capacity_b2_filler'), 1);

    fault.release();
    const nestedRetry = database.withProjectDatabaseWrite(
      'collaboration.session.rotate.outer-test',
      () => database.rotateSession(ROTATION_RECORDS[0].sessionId, ROTATION_RECORDS[1]),
    );
    assert.equal(nestedRetry.id, ROTATION_RECORDS[1].sessionId);
    assert.ok(sessionRow(database, ROTATION_RECORDS[0].sessionId).revoked_at > 0);
    assert.equal(sessionRow(database, ROTATION_RECORDS[1].sessionId).revoked_at, null);
    assert.equal(scalarCount(
      database,
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE project_id = ? AND action = 'collaboration.session.rotate'`,
      PROJECT_ID,
    ), auditBefore + 2);
    assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM session_rotation_capacity_b2_filler'), 2);

    database.db.pragma('busy_timeout = 1');
    blocker = new BetterSqlite3(filename);
    blocker.exec('BEGIN IMMEDIATE');
    let busy = null;
    try {
      database.rotateSession(ROTATION_RECORDS[1].sessionId, ROTATION_RECORDS[2]);
    } catch (error) {
      busy = error;
    }
    assert.ok(busy);
    assert.match(String(busy.code || ''), /^SQLITE_BUSY/);
    assert.equal(busy instanceof ProjectDatabaseStorageCapacityError, false);
    blocker.exec('ROLLBACK');
    blocker.close();
    blocker = null;
    database.db.pragma('busy_timeout = 5000');
    assert.equal(sessionRow(database, ROTATION_RECORDS[1].sessionId).revoked_at, null);
    assert.equal(sessionRow(database, ROTATION_RECORDS[2].sessionId), null);
    assert.equal(database.rotateSession('missing-session', ROTATION_RECORDS[2]), null);
    assert.equal(sessionRow(database, ROTATION_RECORDS[1].sessionId).revoked_at, null);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    try { blocker?.exec('ROLLBACK'); } catch (_) {}
    try { blocker?.close(); } catch (_) {}
    try { fault?.release(); } catch (_) {}
    try { await database.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
