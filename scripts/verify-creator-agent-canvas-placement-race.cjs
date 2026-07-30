const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const {
  CANVAS_PATCH_CONTRACT,
} = require('../backend/src/services/canvasPatch');
const {
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');

function waitForMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== type) return;
      worker.off('message', onMessage);
      worker.off('error', reject);
      resolve(message);
    };
    worker.on('message', onMessage);
    worker.once('error', reject);
  });
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-creator-placement-race-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const modulePath = path.resolve(__dirname, '../backend/src/services/projectDatabase.js');
  const workers = [];
  try {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousWorkerMarker = process.env.T8_PROJECT_DATABASE_UNSAFE_TEST_WORKER;
    process.env.NODE_ENV = 'test';
    process.env.T8_PROJECT_DATABASE_UNSAFE_TEST_WORKER = '1';
    try {
      assert.throws(
        () => new ProjectDatabase(path.join(directory, 'main-thread-probe.sqlite3'), {
          autoBackup: false,
          unsafeDisableOwnerGuardForTests: true,
        }),
        (error) => error?.code === 'project_database_owner_unavailable'
          && error?.details?.phase === 'unsafe-test-bypass-rejected',
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousWorkerMarker === undefined) {
        delete process.env.T8_PROJECT_DATABASE_UNSAFE_TEST_WORKER;
      } else {
        process.env.T8_PROJECT_DATABASE_UNSAFE_TEST_WORKER = previousWorkerMarker;
      }
    }

    const setup = new ProjectDatabase(filename, { autoBackup: false });
    let request;
    try {
      setup.ensureCanvas('canvas-placement-race', {
        nodes: [{
          id: 'source',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { prompt: 'source' },
        }],
        edges: [],
      }, 'project-placement-race');
      const patch = {
        schema: CANVAS_PATCH_CONTRACT,
        id: 'creator-placement-race-patch',
        baseRevision: 1,
        summary: '发送已验证素材到画布',
        diagnosticsResolved: [],
        requiresConfirmation: true,
        operations: [{
          type: 'node.add',
          payload: {
            node: {
              id: 'asset-placement-node',
              type: 'upload',
              position: { x: 360, y: 120 },
              data: {
                assetId: 'asset-placement-fixture',
                assetLineage: {
                  source: 'creator-agent',
                  sourceAssetId: 'asset-placement-fixture',
                },
              },
            },
          },
        }],
      };
      const preview = setup.previewCanvasPatch('canvas-placement-race', patch, {
        actorId: 'local-owner',
        sessionId: 'local-session',
      });
      request = { patch, previewDigest: preview.previewDigest };
    } finally {
      setup.close();
    }

    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { ProjectDatabase } = require(workerData.modulePath);
      const db = new ProjectDatabase(workerData.filename, {
        autoBackup: false,
        unsafeDisableOwnerGuardForTests: true,
      });
      parentPort.postMessage({ type: 'ready' });
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      let message;
      try {
        const result = db.applyCanvasPatch(
          'canvas-placement-race',
          workerData.request.patch,
          {
            previewDigest: workerData.request.previewDigest,
            confirmed: true,
            actorId: workerData.actorId,
            sessionId: workerData.sessionId,
            allowExactDuplicateAcrossActors: true,
          },
        );
        message = {
          type: 'result',
          ok: true,
          duplicate: result.duplicate,
          revision: result.revision,
        };
      } catch (error) {
        message = {
          type: 'result',
          ok: false,
          code: error?.code || null,
          message: String(error?.message || error),
        };
      } finally {
        db.close();
      }
      parentPort.postMessage(message);
      parentPort.close();
    `;
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workerEnv = {
      ...process.env,
      NODE_ENV: 'test',
      T8_PROJECT_DATABASE_UNSAFE_TEST_WORKER: '1',
    };
    delete workerEnv.NODE_TEST_CONTEXT;
    const actors = [
      { actorId: 'local-owner', sessionId: 'local-session' },
      { actorId: 'codex-agent', sessionId: 'codex-session' },
    ];
    const ready = [];
    const results = [];
    for (const actor of actors) {
      const worker = new Worker(workerSource, {
        eval: true,
        execArgv: [],
        env: workerEnv,
        workerData: {
          modulePath,
          filename,
          gate,
          request,
          ...actor,
        },
      });
      workers.push(worker);
      ready.push(waitForMessage(worker, 'ready'));
      results.push(waitForMessage(worker, 'result'));
    }
    await Promise.all(ready);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, actors.length);
    const settled = await Promise.all(results);

    assert.equal(settled.every((result) => result.ok), true, JSON.stringify(settled));
    assert.deepEqual(settled.map((result) => result.duplicate).sort(), [false, true]);
    assert.deepEqual([...new Set(settled.map((result) => result.revision))], [2]);
    assert.equal(
      settled.some((result) => /SQLITE_BUSY|database is locked/i.test(result.message || '')),
      false,
    );

    const verified = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(verified.getCanvas('canvas-placement-race').revision, 2);
      assert.equal(verified.db.prepare(
        'SELECT COUNT(*) AS count FROM canvas_patch_applications WHERE canvas_id = ?',
      ).get('canvas-placement-race').count, 1);
      assert.equal(verified.db.prepare(
        'SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?',
      ).get('canvas-placement-race').count, 1);
      assert.equal(verified.db.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE canvas_id = ? AND action = 'canvas.patch.apply'",
      ).get('canvas-placement-race').count, 1);
      assert.equal(verified.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(verified.db.pragma('foreign_key_check'), []);
    } finally {
      verified.close();
    }

    console.log(JSON.stringify({
      ok: true,
      committedWrites: 1,
      recoveredEntrypoints: 2,
      revision: 2,
      duplicateReceipts: settled.filter((result) => result.duplicate).length,
    }));
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => null)));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
