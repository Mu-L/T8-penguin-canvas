'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const {
  COLLABORATION_SESSION_HEARTBEAT_MIN_INTERVAL_MS,
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');
const {
  CollaborationAuth,
  hashSecret,
} = require('../backend/src/collaboration/auth');

const PROJECT_ID = 'project-session-touch-capacity-b2';
const CANVAS_ID = 'canvas-session-touch-capacity-b2';
const MAX_PAGE_COUNT_RESET = 1073741823;

function scalarCount(database, sql, ...values) {
  return Number(database.db.prepare(sql).get(...values)?.count || 0);
}

function sessionRow(database, sessionId) {
  return database.db.prepare(`
    SELECT s.id, s.token_hash, s.project_id, s.canvas_id, s.member_id,
           s.expires_at, s.revoked_at, s.last_seen_at,
           m.updated_at AS authorization_epoch
    FROM collaboration_sessions s
    JOIN collaboration_members m ON m.id = s.member_id
    WHERE s.id = ?
  `).get(String(sessionId)) || null;
}

function heartbeatIdentity(redeemed) {
  return {
    sessionId: redeemed.sessionId,
    projectId: redeemed.projectId,
    canvasId: redeemed.canvasId,
    memberId: redeemed.memberId,
    authorizationEpoch: redeemed.authorizationEpoch,
  };
}

function createActiveSession(database) {
  database.ensureCanvas(CANVAS_ID, {
    projectId: PROJECT_ID,
    name: 'Session heartbeat capacity B2',
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
  const redeemed = auth.redeemInvite(invite.code, 'Session heartbeat capacity actor');
  assert.ok(redeemed);
  return { auth, redeemed, identity: heartbeatIdentity(redeemed) };
}

function installLateHeartbeatFull(database) {
  let lateHeartbeatHits = 0;
  database.db.function('session_heartbeat_capacity_b2_mark_late', () => {
    lateHeartbeatHits += 1;
    return 1;
  });
  database.db.exec(`
    CREATE TABLE session_heartbeat_capacity_b2_filler (
      id INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
    CREATE TRIGGER session_heartbeat_capacity_b2_force_late_full
    BEFORE UPDATE OF last_seen_at ON collaboration_sessions
    BEGIN
      SELECT session_heartbeat_capacity_b2_mark_late();
      INSERT INTO session_heartbeat_capacity_b2_filler(payload) VALUES (zeroblob(4194304));
    END;
  `);

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

  return {
    lateHeartbeatHits: () => lateHeartbeatHits,
    release() {
      database.db.pragma(`max_page_count = ${MAX_PAGE_COUNT_RESET}`);
    },
  };
}

function assertHeartbeatCapacityError(error, operation) {
  assert.ok(error instanceof ProjectDatabaseStorageCapacityError);
  assert.equal(error.code, 'project_database_storage_capacity_exceeded');
  assert.equal(error.status, 507);
  assert.equal(error.statusCode, 507);
  assert.equal(error.reason, 'sqlite-full');
  assert.equal(error.retryable, false);
  assert.deepEqual(error.details, {
    reason: 'sqlite-full',
    retryable: false,
    operation,
  });
  return true;
}

test('B2 default session authentication is a pure read and explicit heartbeat is monotonic, bounded, and exact', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const { auth, redeemed, identity } = createActiveSession(database);
    const tokenHash = hashSecret(redeemed.token);
    const initialLastSeenAt = Date.now() - 120_000;
    database.db.prepare('UPDATE collaboration_sessions SET last_seen_at = ? WHERE id = ?')
      .run(initialLastSeenAt, redeemed.sessionId);
    const initial = sessionRow(database, redeemed.sessionId);
    const initialAuditCount = scalarCount(database, 'SELECT COUNT(*) AS count FROM audit_events');

    const boundaryCalls = [];
    const originalBoundary = database.withProjectDatabaseWrite.bind(database);
    database.withProjectDatabaseWrite = (operation, callback) => {
      boundaryCalls.push(operation);
      return originalBoundary(operation, () => {
        assert.equal(database.db.inTransaction, true);
        return callback();
      });
    };

    const changesBeforeAuthentication = database.db.totalChanges;
    database.db.pragma('query_only = ON');
    const authenticated = auth.authenticate(redeemed.token);
    const authenticatedWithLegacyOptions = auth.authenticate(redeemed.token, { touch: true });
    database.db.pragma('query_only = OFF');
    assert.equal(authenticated.id, redeemed.sessionId);
    assert.equal(authenticatedWithLegacyOptions.id, redeemed.sessionId);
    assert.equal(database.db.totalChanges, changesBeforeAuthentication);
    assert.deepEqual(sessionRow(database, redeemed.sessionId), initial);
    assert.deepEqual(boundaryCalls, []);

    const notDue = database.heartbeatSession(tokenHash, identity, {
      now: initialLastSeenAt + COLLABORATION_SESSION_HEARTBEAT_MIN_INTERVAL_MS - 1,
    });
    assert.deepEqual(notDue, {
      touched: false,
      lastSeenAt: initialLastSeenAt,
      nextHeartbeatAt: initialLastSeenAt + COLLABORATION_SESSION_HEARTBEAT_MIN_INTERVAL_MS,
    });
    const regressed = database.heartbeatSession(tokenHash, identity, {
      now: initialLastSeenAt - 1,
    });
    assert.equal(regressed.touched, false);
    assert.deepEqual(boundaryCalls, []);
    assert.deepEqual(sessionRow(database, redeemed.sessionId), initial);

    const writeNow = initialLastSeenAt + COLLABORATION_SESSION_HEARTBEAT_MIN_INTERVAL_MS;
    const touched = database.heartbeatSession(tokenHash, identity, { now: writeNow });
    assert.deepEqual(touched, {
      touched: true,
      lastSeenAt: writeNow,
      nextHeartbeatAt: writeNow + COLLABORATION_SESSION_HEARTBEAT_MIN_INTERVAL_MS,
    });
    assert.deepEqual(boundaryCalls, ['collaboration.session.heartbeat']);
    const afterTouch = sessionRow(database, redeemed.sessionId);
    assert.equal(afterTouch.last_seen_at, writeNow);
    assert.equal(afterTouch.expires_at, initial.expires_at);
    assert.equal(afterTouch.authorization_epoch, initial.authorization_epoch);
    assert.equal(afterTouch.revoked_at, initial.revoked_at);
    assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM audit_events'), initialAuditCount);

    const beforeInvalid = { ...afterTouch };
    assert.throws(
      () => database.heartbeatSession(tokenHash, { ...identity, memberId: ` ${identity.memberId}` }, {
        now: writeNow + COLLABORATION_SESSION_HEARTBEAT_MIN_INTERVAL_MS,
      }),
      (error) => error?.code === 'collaboration_session_heartbeat_identity_conflict'
        && error?.status === 409,
    );
    assert.deepEqual(sessionRow(database, redeemed.sessionId), beforeInvalid);

    database.db.prepare('UPDATE collaboration_sessions SET last_seen_at = 0 WHERE id = ?')
      .run(redeemed.sessionId);
    assert.throws(
      () => database.heartbeatSession(tokenHash, identity, { now: writeNow + 120_000 }),
      (error) => error?.code === 'collaboration_session_heartbeat_state_invalid'
        && error?.status === 500,
    );
    database.db.prepare('UPDATE collaboration_sessions SET last_seen_at = ? WHERE id = ?')
      .run(writeNow, redeemed.sessionId);

    const originalExpiresAt = initial.expires_at;
    database.db.prepare('UPDATE collaboration_sessions SET last_seen_at = 1, expires_at = 500000 WHERE id = ?')
      .run(redeemed.sessionId);
    const clockValues = [400000, 500001];
    const expiredWhileWaitingForWriter = database.heartbeatSession(tokenHash, identity, {
      clock: () => clockValues.shift(),
    });
    assert.equal(expiredWhileWaitingForWriter, null);
    assert.equal(sessionRow(database, redeemed.sessionId).last_seen_at, 1);
    assert.deepEqual(clockValues, []);
    database.db.prepare('UPDATE collaboration_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(writeNow, originalExpiresAt, redeemed.sessionId);

    const overflowLastSeenAt = Number.MAX_SAFE_INTEGER
      - COLLABORATION_SESSION_HEARTBEAT_MIN_INTERVAL_MS + 1;
    database.db.prepare(`
      UPDATE collaboration_sessions
      SET last_seen_at = ?, expires_at = ?
      WHERE id = ?
    `).run(overflowLastSeenAt, Number.MAX_SAFE_INTEGER, redeemed.sessionId);
    const callsBeforeOverflow = boundaryCalls.length;
    assert.throws(
      () => database.heartbeatSession(tokenHash, identity, { now: overflowLastSeenAt }),
      (error) => error?.code === 'collaboration_session_heartbeat_state_invalid'
        && error?.status === 500,
    );
    assert.equal(boundaryCalls.length, callsBeforeOverflow);
    assert.equal(sessionRow(database, redeemed.sessionId).last_seen_at, overflowLastSeenAt);
    database.db.prepare('UPDATE collaboration_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(writeNow, originalExpiresAt, redeemed.sessionId);

    const callsBeforeMissing = boundaryCalls.length;
    assert.equal(auth.authenticate('unknown-session-token-that-is-long-enough'), null);
    assert.equal(auth.authenticate('short'), null);
    assert.equal(database.heartbeatSession(hashSecret('unknown-session-token-that-is-long-enough'), identity, {
      now: writeNow + 120_000,
    }), null);
    assert.equal(boundaryCalls.length, callsBeforeMissing);

    const forwarded = [];
    const facade = new CollaborationAuth({
      getSession(...args) {
        forwarded.push(['getSession', args]);
        return null;
      },
      heartbeatSession(...args) {
        forwarded.push(['heartbeatSession', args]);
        return null;
      },
    });
    facade.authenticate('default-session-token-that-is-long-enough');
    facade.authenticate('legacy-options-token-that-is-long-enough', { touch: true });
    facade.heartbeat('heartbeat-session-token-that-is-long-enough', identity);
    assert.equal(forwarded[0][1].length, 1);
    assert.equal(forwarded[1][1].length, 1);
    assert.equal(forwarded[2][1].length, 2);
    assert.deepEqual(forwarded.map(([name]) => name), ['getSession', 'getSession', 'heartbeatSession']);
  } finally {
    await database.close();
  }
});

test('B2 TEMP database explicit heartbeat translates real late FULL, retries exactly, and leaves BUSY distinct', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-session-heartbeat-capacity-b2-'));
  const filename = path.join(directory, 'project.sqlite3');
  const database = new ProjectDatabase(filename, { autoBackup: false });
  let blocker = null;
  let fault = null;

  try {
    const { auth, redeemed, identity } = createActiveSession(database);
    const tokenHash = hashSecret(redeemed.token);
    database.db.prepare('UPDATE collaboration_sessions SET last_seen_at = ? WHERE id = ?')
      .run(1, redeemed.sessionId);
    const before = sessionRow(database, redeemed.sessionId);
    fault = installLateHeartbeatFull(database);

    database.db.pragma('query_only = ON');
    const pureAtCapacity = auth.authenticate(redeemed.token);
    database.db.pragma('query_only = OFF');
    assert.equal(pureAtCapacity.id, redeemed.sessionId);
    assert.deepEqual(sessionRow(database, redeemed.sessionId), before);
    assert.equal(fault.lateHeartbeatHits(), 0);

    let capacity = null;
    try {
      database.heartbeatSession(tokenHash, identity, { now: 100000 });
    } catch (error) {
      capacity = error;
    }
    assertHeartbeatCapacityError(capacity, 'collaboration.session.heartbeat');
    assert.doesNotMatch(String(capacity.message || ''), /project\.sqlite3|session_heartbeat_capacity_b2_filler/i);
    assert.equal(fault.lateHeartbeatHits(), 1);
    assert.deepEqual(sessionRow(database, redeemed.sessionId), before);
    assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM session_heartbeat_capacity_b2_filler'), 0);

    assert.throws(
      () => database.withProjectDatabaseWrite('collaboration.session.heartbeat.outer-test', () => (
        database.heartbeatSession(tokenHash, identity, { now: 100000 })
      )),
      (error) => assertHeartbeatCapacityError(error, 'collaboration.session.heartbeat.outer-test'),
    );
    assert.equal(fault.lateHeartbeatHits(), 2);
    assert.deepEqual(sessionRow(database, redeemed.sessionId), before);
    assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM session_heartbeat_capacity_b2_filler'), 0);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);

    fault.release();
    const retried = database.heartbeatSession(tokenHash, identity, { now: 100000 });
    assert.equal(retried.touched, true);
    assert.equal(fault.lateHeartbeatHits(), 3);
    assert.equal(sessionRow(database, redeemed.sessionId).last_seen_at, 100000);
    assert.equal(scalarCount(database, 'SELECT COUNT(*) AS count FROM session_heartbeat_capacity_b2_filler'), 1);

    database.db.prepare('UPDATE collaboration_sessions SET last_seen_at = 1 WHERE id = ?')
      .run(redeemed.sessionId);
    database.db.pragma('busy_timeout = 1');
    blocker = new BetterSqlite3(filename);
    blocker.exec('BEGIN IMMEDIATE');
    const beforeBusy = sessionRow(database, redeemed.sessionId);
    assert.equal(auth.authenticate(redeemed.token).id, redeemed.sessionId);
    assert.deepEqual(sessionRow(database, redeemed.sessionId), beforeBusy);

    let busy = null;
    try {
      database.heartbeatSession(tokenHash, identity, { now: 200000 });
    } catch (error) {
      busy = error;
    }
    assert.ok(busy);
    assert.match(String(busy.code || ''), /^SQLITE_BUSY/);
    assert.equal(busy instanceof ProjectDatabaseStorageCapacityError, false);
    assert.deepEqual(sessionRow(database, redeemed.sessionId), beforeBusy);
    assert.equal(auth.authenticate('missing-session-token-that-is-long-enough'), null);

    blocker.exec('ROLLBACK');
    blocker.close();
    blocker = null;
    database.db.pragma('busy_timeout = 5000');
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
