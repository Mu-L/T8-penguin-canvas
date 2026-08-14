'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  startFigmaBridgeOnAppStart,
  stopFigmaBridge,
} = require('../backend/src/utils/figmaBridge');

const BASE = 'http://localhost:3845';
const HEALTHY = { service: 't8-figma-bridge', version: 2, assetBase: BASE };
const silentLogger = { log() {}, warn() {} };

function makeChild(options = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killSignals = [];
  child.kill = (signal = 'SIGTERM') => {
    child.killSignals.push(signal);
    if (options.autoExit !== false && child.exitCode === null) {
      queueMicrotask(() => {
        if (child.exitCode !== null) return;
        child.exitCode = 0;
        child.emit('exit', 0, signal);
      });
    }
    return true;
  };
  return child;
}

test('Figma startup is awaitable and shutdown fences every spawn race', async (t) => {
  const previousAutostart = process.env.T8_FIGMA_BRIDGE_AUTOSTART;
  process.env.T8_FIGMA_BRIDGE_AUTOSTART = '1';
  t.after(async () => {
    await stopFigmaBridge({ timeoutMs: 100, allowRestart: true });
    if (previousAutostart == null) delete process.env.T8_FIGMA_BRIDGE_AUTOSTART;
    else process.env.T8_FIGMA_BRIDGE_AUTOSTART = previousAutostart;
  });

  await t.test('start settles only after the spawned bridge becomes healthy', async () => {
    let spawnCount = 0;
    let healthCalls = 0;
    let resolveHealth;
    const child = makeChild();
    const health = new Promise((resolve) => { resolveHealth = resolve; });
    const start = startFigmaBridgeOnAppStart(silentLogger, {
      base: BASE,
      script: __filename,
      getHealth: async () => (++healthCalls === 1 ? null : health),
      spawn: () => {
        spawnCount += 1;
        return child;
      },
      startWaitMs: 1_000,
    });
    assert.equal(typeof start?.then, 'function');
    let settled = false;
    void start.finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(spawnCount, 1);
    assert.equal(settled, false);
    resolveHealth(HEALTHY);
    const result = await start;
    assert.equal(result.ok, true);
    assert.equal(result.started, true);
    assert.equal(settled, true);
    const stopped = await stopFigmaBridge({ timeoutMs: 100, allowRestart: true });
    assert.equal(stopped.ok, true);
    assert.deepEqual(child.killSignals, ['SIGTERM']);
  });

  await t.test('an already-aborted maintenance signal cannot probe or spawn', async () => {
    let probes = 0;
    let spawns = 0;
    const controller = new AbortController();
    controller.abort();
    const result = await startFigmaBridgeOnAppStart(silentLogger, {
      signal: controller.signal,
      script: __filename,
      getHealth: async () => { probes += 1; return null; },
      spawn: () => { spawns += 1; return makeChild(); },
    });
    assert.equal(result.aborted, true);
    assert.equal(probes, 0);
    assert.equal(spawns, 0);
    await stopFigmaBridge({ timeoutMs: 100, allowRestart: true });
  });

  await t.test('maintenance followed immediately by shutdown never reaches spawn', async () => {
    let spawnCount = 0;
    const start = startFigmaBridgeOnAppStart(silentLogger, {
      script: __filename,
      getHealth: async () => null,
      spawn: () => { spawnCount += 1; return makeChild(); },
    });
    const stopped = await stopFigmaBridge({ timeoutMs: 100, allowRestart: true });
    const startResult = await start;
    assert.equal(stopped.ok, true);
    assert.equal(startResult.aborted, true);
    assert.equal(spawnCount, 0);
  });

  await t.test('shutdown during health wait aborts startup and waits for child exit', async () => {
    let spawnCount = 0;
    let healthCalls = 0;
    const child = makeChild();
    const start = startFigmaBridgeOnAppStart(silentLogger, {
      script: __filename,
      getHealth: async () => {
        healthCalls += 1;
        return healthCalls === 1 ? null : new Promise(() => {});
      },
      spawn: () => { spawnCount += 1; return child; },
      startWaitMs: 5_000,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(spawnCount, 1);
    const stopped = await stopFigmaBridge({ timeoutMs: 100, allowRestart: true });
    const startResult = await start;
    assert.equal(startResult.aborted, true);
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopped, true);
    assert.deepEqual(child.killSignals, ['SIGTERM']);
  });
});