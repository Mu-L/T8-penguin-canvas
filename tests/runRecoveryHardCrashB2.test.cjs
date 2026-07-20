'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const { stableEntityUuid } = require('../backend/src/collaboration/protocol');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const { RunRecoveryManager } = require('../backend/src/services/runRecovery');

const PROJECT_ID = 'run-recovery-hard-crash-project-b2';
const CANVAS_ID = 'run-recovery-hard-crash-canvas-b2';
const NODE_ID = 'run-recovery-hard-crash-node-b2';

function createActiveRecovery(database, suffix = 'hard-crash') {
  const nodeEntityUid = stableEntityUuid(
    't8-run-recovery-hard-crash-node-v1',
    `${NODE_ID}:${suffix}`,
  );
  const canvas = database.ensureCanvas(CANVAS_ID, {
    projectId: PROJECT_ID,
    nodes: [{
      id: NODE_ID,
      entityUid: nodeEntityUid,
      entityRevision: 1,
      type: 'image',
      position: { x: 0, y: 0 },
      data: {},
    }],
    edges: [],
  }, PROJECT_ID);
  const run = database.createRun({
    id: `run-recovery-${suffix}`,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    canvasRevision: canvas.revision,
    status: 'running',
  });
  const nodeRun = database.createNodeRun({
    id: `node-run-recovery-${suffix}`,
    runId: run.id,
    nodeId: NODE_ID,
    status: 'running',
  });
  const attempt = database.createAttempt({
    id: `attempt-recovery-${suffix}`,
    nodeRunId: nodeRun.id,
    provider: 'seedance-nz',
    model: 'wan-2.7-spicy-i2v',
    upstreamTaskId: `task-recovery-${suffix}`,
    status: 'running',
    pollCount: 2,
    metadata: {
      recovery: {
        kind: 'wan',
        taskId: `task-recovery-${suffix}`,
        model: 'wan-2.7-spicy-i2v',
        pollIntervalMs: 250,
        maxPolls: 1,
      },
    },
  });
  return { run, nodeRun, attempt };
}

function recoveryStartInput(ticket, startedAt = Date.now()) {
  return {
    runId: ticket.run.id,
    runEntityUid: ticket.run.entityUid,
    runRevision: ticket.run.revision,
    nodeRunId: ticket.nodeRun.id,
    nodeRunEntityUid: ticket.nodeRun.entityUid,
    nodeRunRevision: ticket.nodeRun.revision,
    attemptId: ticket.attempt.id,
    attemptEntityUid: ticket.attempt.entityUid,
    attemptRevision: ticket.attempt.revision,
    kind: ticket.attempt.metadata.recovery.kind,
    startedAt,
  };
}

function recoveryStartedEvents(database, runId) {
  return database.getRunEvents(runId).filter(
    (event) => event.type === 'log' && event.payload?.phase === 'recovery.started',
  );
}

function runElectronChild(source, environment, timeout = 90_000) {
  return spawnSync(process.execPath, ['-e', source], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ...environment,
    },
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function removeTemporaryDirectory(directory) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(directory);
  assert.equal(
    resolved.startsWith(`${temporaryRoot}${path.sep}`),
    true,
    `refusing to remove non-temporary directory: ${resolved}`,
  );
  fs.rmSync(resolved, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}

test('B2 recovery.started survives a real process.abort boundary and cold reentry is identity-idempotent', {
  timeout: 180_000,
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-run-recovery-hard-crash-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const crashMarker = path.join(directory, 'crash-marker.json');
  const terminalRestartMarker = path.join(directory, 'terminal-restart-marker.json');
  let database = null;
  let active;
  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    active = createActiveRecovery(database);
    await database.close();
    database = null;

    const crashChild = runElectronChild(String.raw`
      const fs = require('node:fs');
      const { ProjectDatabase } = require(process.env.T8_PROJECT_DATABASE_MODULE);
      const { RunRecoveryManager } = require(process.env.T8_RUN_RECOVERY_MODULE);

      function writeMarker(value) {
        const descriptor = fs.openSync(process.env.T8_RUN_RECOVERY_MARKER, 'w');
        try {
          fs.writeFileSync(descriptor, JSON.stringify(value), 'utf8');
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
      }

      const database = new ProjectDatabase(process.env.T8_RUN_RECOVERY_DATABASE, {
        autoBackup: false,
      });
      const ticket = database.listPendingRunRecoveries()[0];
      if (!ticket) process.exit(81);
      const manager = new RunRecoveryManager({
        database,
        baseUrl: 'http://127.0.0.1:1',
        queryRecovery: async () => {
          process.exit(82);
        },
        afterRunRecoveryStartCommit: ({ started }) => {
          writeMarker({
            transactionOpen: database.db.inTransaction,
            eventCount: 1,
            event: started.event,
            nodeRun: {
              id: started.nodeRun.id,
              entityUid: started.nodeRun.entityUid,
              revision: started.nodeRun.revision,
              status: started.nodeRun.status,
            },
            attempt: {
              id: started.attempt.id,
              entityUid: started.attempt.entityUid,
              revision: started.attempt.revision,
              status: started.attempt.status,
              recoveryStartedAt: started.attempt.timestamps.recoveryStartedAt,
              recoveryStartClaim: started.attempt.metadata.recoveryStartClaim,
            },
          });
          process.abort();
        },
        broadcast: {
          node: () => {
            process.exit(86);
          },
        },
      });
      void manager.recoverPendingRuns().then(
        () => process.exit(83),
        () => process.exit(84),
      );
    `, {
      T8_PROJECT_DATABASE_MODULE: path.resolve(
        __dirname,
        '../backend/src/services/projectDatabase.js',
      ),
      T8_RUN_RECOVERY_MODULE: path.resolve(
        __dirname,
        '../backend/src/services/runRecovery.js',
      ),
      T8_RUN_RECOVERY_DATABASE: filename,
      T8_RUN_RECOVERY_MARKER: crashMarker,
    });
    assert.equal(crashChild.error, undefined, crashChild.error?.message);
    assert.equal(fs.existsSync(crashMarker), true, crashChild.stderr || crashChild.stdout);
    assert.equal(
      crashChild.signal != null || (crashChild.status != null && crashChild.status !== 0),
      true,
      `process.abort did not hard-exit: status=${crashChild.status} signal=${crashChild.signal}`,
    );

    const committed = readJson(crashMarker);
    assert.equal(committed.transactionOpen, false);
    assert.equal(committed.eventCount, 1);
    assert.equal(committed.event.entityUid, stableEntityUuid(
      't8-run-recovery-start-event-v1',
      active.attempt.entityUid,
    ));
    assert.equal(committed.event.createdAt, committed.attempt.recoveryStartedAt);
    assert.equal(committed.nodeRun.entityUid, active.nodeRun.entityUid);
    assert.equal(committed.nodeRun.status, 'polling');
    assert.equal(committed.attempt.entityUid, active.attempt.entityUid);
    assert.equal(committed.attempt.status, 'polling');
    assert.deepEqual(committed.attempt.recoveryStartClaim, {
      version: 1,
      eventEntityUid: committed.event.entityUid,
      attemptEntityUid: active.attempt.entityUid,
    });

    const rawAfterCrash = new BetterSqlite3(filename);
    try {
      assert.equal(rawAfterCrash.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(rawAfterCrash.pragma('foreign_key_check'), []);
      assert.equal(rawAfterCrash.prepare('SELECT COUNT(*) AS count FROM node_runs WHERE id = ?')
        .get(active.nodeRun.id).count, 1);
      assert.equal(rawAfterCrash.prepare('SELECT COUNT(*) AS count FROM run_attempts WHERE id = ?')
        .get(active.attempt.id).count, 1);
      assert.equal(rawAfterCrash.prepare(`
        SELECT COUNT(*) AS count FROM run_events
        WHERE run_id = ? AND type = 'log'
          AND json_extract(payload_json, '$.phase') = 'recovery.started'
      `).get(active.run.id).count, 1);
    } finally {
      rawAfterCrash.close();
    }

    database = new ProjectDatabase(filename, { autoBackup: false });
    const ticket = database.listPendingRunRecoveries()[0];
    assert.ok(ticket);
    const beforeReplay = {
      nodeRun: database.getNodeRun(active.nodeRun.id),
      attempt: database.getAttempt(active.attempt.id),
    };
    const replay = database.beginRunRecoveryAttempt(
      recoveryStartInput(ticket, committed.event.createdAt + 10_000),
    );
    assert.equal(replay.duplicate, true);
    assert.equal(replay.adoptedLegacyClaim, false);
    assert.equal(replay.event.entityUid, committed.event.entityUid);
    assert.equal(replay.attempt.entityUid, active.attempt.entityUid);
    assert.deepEqual(database.getNodeRun(active.nodeRun.id), beforeReplay.nodeRun);
    assert.deepEqual(database.getAttempt(active.attempt.id), beforeReplay.attempt);
    assert.equal(recoveryStartedEvents(database, active.run.id).length, 1);

    let queryCalls = 0;
    const manager = new RunRecoveryManager({
      database,
      baseUrl: 'http://127.0.0.1:1',
      queryRecovery: async () => {
        queryCalls += 1;
        return {
          state: 'failed',
          outputs: [],
          usage: {},
          error: 'expected terminal after hard-crash replay',
          providerStatus: 'failed',
        };
      },
    });
    const recovered = await manager.recoverPendingRuns();
    assert.equal(recovered.failed, 1);
    assert.equal(queryCalls, 1);
    const terminalSnapshot = {
      run: database.getRun(active.run.id),
      nodeRun: database.getNodeRun(active.nodeRun.id),
      attempt: database.getAttempt(active.attempt.id),
      events: database.getRunEvents(active.run.id),
    };
    assert.equal(terminalSnapshot.run.status, 'failed');
    assert.equal(terminalSnapshot.nodeRun.status, 'failed');
    assert.equal(terminalSnapshot.attempt.status, 'failed');
    assert.equal(terminalSnapshot.attempt.entityUid, active.attempt.entityUid);
    assert.equal(recoveryStartedEvents(database, active.run.id).length, 1);
    await database.close();
    database = null;

    const terminalRestart = runElectronChild(String.raw`
      const fs = require('node:fs');
      const { ProjectDatabase } = require(process.env.T8_PROJECT_DATABASE_MODULE);
      const { RunRecoveryManager } = require(process.env.T8_RUN_RECOVERY_MODULE);

      function writeMarker(value) {
        const descriptor = fs.openSync(process.env.T8_RUN_RECOVERY_MARKER, 'w');
        try {
          fs.writeFileSync(descriptor, JSON.stringify(value), 'utf8');
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
      }

      void (async () => {
        const database = new ProjectDatabase(process.env.T8_RUN_RECOVERY_DATABASE, {
          autoBackup: false,
        });
        let queryCalls = 0;
        const manager = new RunRecoveryManager({
          database,
          baseUrl: 'http://127.0.0.1:1',
          queryRecovery: async () => {
            queryCalls += 1;
            throw new Error('terminal Run must not be queried');
          },
        });
        const result = await manager.recoverPendingRuns();
        const run = database.getRun(process.env.T8_RUN_ID);
        const nodeRun = database.getNodeRun(process.env.T8_NODE_RUN_ID);
        const attempt = database.getAttempt(process.env.T8_ATTEMPT_ID);
        const events = database.getRunEvents(run.id);
        writeMarker({
          queryCalls,
          result,
          run: { status: run.status, revision: run.revision },
          nodeRun: { status: nodeRun.status, revision: nodeRun.revision, entityUid: nodeRun.entityUid },
          attempt: { status: attempt.status, revision: attempt.revision, entityUid: attempt.entityUid },
          recoveryStartedEvents: events.filter(
            (event) => event.type === 'log'
              && event.payload && event.payload.phase === 'recovery.started',
          ),
          eventCount: events.length,
        });
        await database.close();
      })().then(
        () => process.exit(0),
        (error) => {
          process.stderr.write(String(error && (error.stack || error)));
          process.exit(85);
        },
      );
    `, {
      T8_PROJECT_DATABASE_MODULE: path.resolve(
        __dirname,
        '../backend/src/services/projectDatabase.js',
      ),
      T8_RUN_RECOVERY_MODULE: path.resolve(
        __dirname,
        '../backend/src/services/runRecovery.js',
      ),
      T8_RUN_RECOVERY_DATABASE: filename,
      T8_RUN_RECOVERY_MARKER: terminalRestartMarker,
      T8_RUN_ID: active.run.id,
      T8_NODE_RUN_ID: active.nodeRun.id,
      T8_ATTEMPT_ID: active.attempt.id,
    });
    assert.equal(
      terminalRestart.status,
      0,
      terminalRestart.error?.message || terminalRestart.stderr || terminalRestart.stdout,
    );
    const restarted = readJson(terminalRestartMarker);
    assert.equal(restarted.queryCalls, 0);
    assert.equal(restarted.result.pending, 0);
    assert.equal(restarted.result.status, 'completed');
    assert.equal(restarted.run.status, 'failed');
    assert.equal(restarted.run.revision, terminalSnapshot.run.revision);
    assert.equal(restarted.nodeRun.status, 'failed');
    assert.equal(restarted.nodeRun.revision, terminalSnapshot.nodeRun.revision);
    assert.equal(restarted.nodeRun.entityUid, active.nodeRun.entityUid);
    assert.equal(restarted.attempt.status, 'failed');
    assert.equal(restarted.attempt.revision, terminalSnapshot.attempt.revision);
    assert.equal(restarted.attempt.entityUid, active.attempt.entityUid);
    assert.equal(restarted.recoveryStartedEvents.length, 1);
    assert.equal(restarted.recoveryStartedEvents[0].entityUid, committed.event.entityUid);
    assert.equal(restarted.eventCount, terminalSnapshot.events.length);
  } finally {
    try { await database?.close(); } catch (_) {}
    removeTemporaryDirectory(directory);
  }
});

test('B2 one exact legacy recovery.started marker is adopted without changing its event identity', () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const active = createActiveRecovery(database, 'legacy-adoption');
    const startedAt = 1_789_000_000_123;
    const legacyEventEntityUid = stableEntityUuid(
      't8-run-recovery-legacy-start-event-v1',
      active.attempt.entityUid,
    );
    database.withProjectDatabaseWrite('test.legacy-recovery-start', () => {
      database.appendRunEvent(active.run.id, {
        entityUid: legacyEventEntityUid,
        nodeRunId: active.nodeRun.id,
        type: 'log',
        payload: {
          phase: 'recovery.started',
          attemptId: active.attempt.id,
          provider: active.attempt.provider,
          kind: 'wan',
        },
        createdAt: startedAt,
      });
      database.updateNodeRun(active.nodeRun.id, { status: 'polling' });
      database.updateAttempt(active.attempt.id, {
        status: 'polling',
        timestamps: { recoveryStartedAt: startedAt },
      }, { runId: active.run.id, nodeRunId: active.nodeRun.id });
    });

    let ticket = database.listPendingRunRecoveries()[0];
    const nodeRevision = ticket.nodeRun.revision;
    const attemptRevision = ticket.attempt.revision;
    const adopted = database.beginRunRecoveryAttempt(recoveryStartInput(ticket, startedAt + 1));
    assert.equal(adopted.duplicate, true);
    assert.equal(adopted.adoptedLegacyClaim, true);
    assert.equal(adopted.event.entityUid, legacyEventEntityUid);
    assert.equal(adopted.nodeRun.revision, nodeRevision);
    assert.equal(adopted.attempt.revision, attemptRevision + 1);
    assert.deepEqual(adopted.attempt.metadata.recoveryStartClaim, {
      version: 1,
      eventEntityUid: legacyEventEntityUid,
      attemptEntityUid: active.attempt.entityUid,
    });

    ticket = database.listPendingRunRecoveries()[0];
    const replayed = database.beginRunRecoveryAttempt(recoveryStartInput(ticket, startedAt + 2));
    assert.equal(replayed.duplicate, true);
    assert.equal(replayed.adoptedLegacyClaim, false);
    assert.equal(replayed.event.entityUid, legacyEventEntityUid);
    assert.equal(replayed.nodeRun.revision, adopted.nodeRun.revision);
    assert.equal(replayed.attempt.revision, adopted.attempt.revision);
    assert.equal(recoveryStartedEvents(database, active.run.id).length, 1);
  } finally {
    database.close();
  }
});

test('B2 partial recovery start evidence fails closed instead of minting a replacement identity', () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const active = createActiveRecovery(database, 'partial-evidence');
    database.updateNodeRun(active.nodeRun.id, { status: 'polling' });
    database.updateAttempt(active.attempt.id, {
      status: 'polling',
      timestamps: { recoveryStartedAt: 1_789_000_001_234 },
    }, { runId: active.run.id, nodeRunId: active.nodeRun.id });
    const ticket = database.listPendingRunRecoveries()[0];
    const before = {
      nodeRun: database.getNodeRun(active.nodeRun.id),
      attempt: database.getAttempt(active.attempt.id),
      events: database.getRunEvents(active.run.id),
    };
    assert.throws(
      () => database.beginRunRecoveryAttempt(recoveryStartInput(ticket)),
      (error) => error?.code === 'run_recovery_state_conflict'
        && error?.status === 409
        && error?.retryable === false,
    );
    assert.deepEqual(database.getNodeRun(active.nodeRun.id), before.nodeRun);
    assert.deepEqual(database.getAttempt(active.attempt.id), before.attempt);
    assert.deepEqual(database.getRunEvents(active.run.id), before.events);
    assert.equal(recoveryStartedEvents(database, active.run.id).length, 0);
  } finally {
    database.close();
  }
});

test('B2 recovery start hard-crash hook is inert outside node:test context', () => {
  const child = runElectronChild(String.raw`
    delete process.env.NODE_TEST_CONTEXT;
    const { RunRecoveryManager } = require(process.env.T8_RUN_RECOVERY_MODULE);
    let hookCalls = 0;
    const ticket = {
      run: { id: 'run', entityUid: '11111111-1111-4111-8111-111111111111', revision: 1 },
      nodeRun: { id: 'node-run', entityUid: '22222222-2222-4222-8222-222222222222', revision: 1 },
      attempt: {
        id: 'attempt',
        entityUid: '33333333-3333-4333-8333-333333333333',
        revision: 1,
        provider: 'seedance-nz',
        metadata: {
          recovery: {
            kind: 'wan',
            taskId: 'test-only-hook-gate',
            pollIntervalMs: 250,
            maxPolls: 1,
          },
        },
      },
    };
    const database = {
      beginRunRecoveryAttempt: () => ({
        run: ticket.run,
        nodeRun: ticket.nodeRun,
        attempt: ticket.attempt,
        duplicate: false,
      }),
      completeRecoveredRunAttempt: () => ({ duplicate: true }),
    };
    const manager = new RunRecoveryManager({
      database,
      afterRunRecoveryStartCommit: () => {
        hookCalls += 1;
        throw new Error('production must never execute the test hook');
      },
      queryRecovery: async () => {
        throw Object.assign(new Error('expected terminal'), {
          httpStatus: 404,
          retryable: false,
        });
      },
    });
    void manager.recoverTicket(ticket).then(
      (result) => {
        process.stdout.write(JSON.stringify({ result, hookCalls }));
        process.exit(0);
      },
      (error) => {
        process.stderr.write(String(error && (error.stack || error)));
        process.exit(87);
      },
    );
  `, {
    T8_RUN_RECOVERY_MODULE: path.resolve(
      __dirname,
      '../backend/src/services/runRecovery.js',
    ),
  });
  assert.equal(
    child.status,
    0,
    child.error?.message || child.stderr || child.stdout,
  );
  assert.deepEqual(JSON.parse(child.stdout), {
    result: 'interrupted',
    hookCalls: 0,
  });
});
