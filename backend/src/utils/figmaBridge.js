'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('../config');

const BRIDGE_VERSION = 2;
const DEFAULT_PORT = 3845;
const DEFAULT_BASE = `http://localhost:${DEFAULT_PORT}`;
const HEALTH_TIMEOUT_MS = 1200;
const START_WAIT_MS = 3500;

let childProcess = null;
let startPromise = null;
let startAbortController = null;
let stopPromise = null;
let bridgeStopping = false;
let exitHooksInstalled = false;

function log(logger, message) {
  if (logger && typeof logger.log === 'function') logger.log(message);
}

function warn(logger, message) {
  if (logger && typeof logger.warn === 'function') logger.warn(message);
  else log(logger, message);
}

function createAbortError(message = 'Figma bridge startup aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function awaitWithAbort(value, signal) {
  if (!signal) return Promise.resolve(value);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    Promise.resolve(value).then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function delayWithAbort(delayMs, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function normalizeBase(raw) {
  const value = String(raw || process.env.FIGMA_BRIDGE_BASE || DEFAULT_BASE).trim();
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_) {
    return DEFAULT_BASE;
  }
}

function portFromBase(base) {
  try {
    const parsed = new URL(base);
    return Number(parsed.port || DEFAULT_PORT) || DEFAULT_PORT;
  } catch (_) {
    return DEFAULT_PORT;
  }
}

function isBridgeHealthy(data, base) {
  return !!(
    data &&
    data.service === 't8-figma-bridge' &&
    Number(data.version || 0) >= BRIDGE_VERSION &&
    data.assetBase === normalizeBase(base)
  );
}

async function fetchJson(url, timeoutMs = HEALTH_TIMEOUT_MS, options = {}) {
  const externalSignal = options.signal;
  throwIfAborted(externalSignal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromExternal = () => controller.abort();
  externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  try {
    const resp = await fetch(url, { cache: 'no-store', signal: controller.signal });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) return null;
    return data;
  } catch (error) {
    if (externalSignal?.aborted) throw createAbortError();
    return null;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

async function getFigmaBridgeHealth(base = DEFAULT_BASE, options = {}) {
  return fetchJson(`${normalizeBase(base)}/health`, options.timeoutMs || HEALTH_TIMEOUT_MS, options);
}

function findBridgeScript() {
  const candidates = [
    process.env.T8_FIGMA_BRIDGE_SCRIPT,
    process.env.T8PC_RES ? path.join(process.env.T8PC_RES, 'tools', 'figma-bridge', 'server.cjs') : '',
    path.resolve(__dirname, '..', '..', '..', 'tools', 'figma-bridge', 'server.cjs'),
    path.join(config.BASE_DIR || '', 'tools', 'figma-bridge', 'server.cjs'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function electronRunAsNodeEnv() {
  return process.versions && process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
}

function installExitHooks() {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  const stop = () => {
    if (!childProcess || childProcess.exitCode !== null) return;
    try {
      childProcess.kill();
    } catch (_) {}
  };
  // Signals are owned by backend/server.js so its storage and worker barriers
  // can finish. The synchronous exit hook is only a last-resort process fence.
  process.once('exit', stop);
}

async function waitForHealthyBridge(base, timeoutMs = START_WAIT_MS, options = {}) {
  const signal = options.signal;
  const getHealth = options.getHealth || getFigmaBridgeHealth;
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(signal);
    last = await awaitWithAbort(getHealth(base, { signal }), signal);
    if (isBridgeHealthy(last, base)) return last;
    await delayWithAbort(250, signal);
  }
  return last;
}

async function ensureFigmaBridgeRunning(options = {}) {
  const logger = options.logger || console;
  const base = normalizeBase(options.base || DEFAULT_BASE);
  const signal = options.signal;
  throwIfAborted(signal);
  if (bridgeStopping) {
    return { ok: false, stopped: true, base, message: 'Figma bridge lifecycle is stopping' };
  }
  if (process.env.T8_FIGMA_BRIDGE_AUTOSTART === '0') {
    return { ok: false, disabled: true, base, message: 'Figma bridge autostart disabled' };
  }

  if (startPromise) return awaitWithAbort(startPromise, signal);

  const controller = new AbortController();
  const abortSharedStart = () => controller.abort();
  signal?.addEventListener('abort', abortSharedStart, { once: true });
  startAbortController = controller;
  let trackedPromise;
  const operation = (async () => {
    const operationSignal = controller.signal;
    const getHealth = options.getHealth || getFigmaBridgeHealth;
    const current = await awaitWithAbort(getHealth(base, { signal: operationSignal }), operationSignal);
    if (isBridgeHealthy(current, base)) {
      return { ok: true, alreadyRunning: true, base, health: current };
    }

    throwIfAborted(operationSignal);
    if (bridgeStopping) throw createAbortError('Figma bridge shutdown began before spawn');
    const script = options.script || findBridgeScript();
    if (!script) {
      return { ok: false, base, message: 'Figma bridge server.cjs not found' };
    }

    const port = portFromBase(base);
    const env = {
      ...process.env,
      ...electronRunAsNodeEnv(),
      T8_FIGMA_BRIDGE_PORT: String(port),
      T8_FIGMA_BRIDGE_KEEP_ALIVE_ON_EXISTING: '0',
      T8_FIGMA_BRIDGE_AUTOSTARTED_BY: 't8-penguin-canvas',
    };

    log(logger, `[figma-bridge] auto-start ${script} on ${base}`);
    throwIfAborted(operationSignal);
    if (bridgeStopping) throw createAbortError('Figma bridge shutdown began before spawn');
    const spawnProcess = options.spawn || spawn;
    const child = spawnProcess(process.execPath, [script], {
      env,
      cwd: path.dirname(script),
      windowsHide: true,
      stdio: 'ignore',
    });
    childProcess = child;
    installExitHooks();
    if (bridgeStopping || operationSignal.aborted) {
      try { if (child.exitCode === null) child.kill(); } catch (_) {}
      if (childProcess === child) childProcess = null;
      throw createAbortError('Figma bridge shutdown began during spawn');
    }
    child.once('exit', (code, signal) => {
      if (childProcess === child) childProcess = null;
      if (code && code !== 0) warn(logger, `[figma-bridge] exited code=${code} signal=${signal || ''}`);
    });

    const health = await waitForHealthyBridge(
      base,
      options.startWaitMs || START_WAIT_MS,
      { signal: operationSignal, getHealth },
    );
    if (isBridgeHealthy(health, base)) return { ok: true, started: true, base, health };
    try { if (child.exitCode === null) child.kill(); } catch (_) {}
    return { ok: false, base, message: 'Figma bridge did not become healthy after autostart', health };
  })();
  trackedPromise = operation.finally(() => {
    signal?.removeEventListener('abort', abortSharedStart);
    if (startAbortController === controller) startAbortController = null;
    if (startPromise === trackedPromise) startPromise = null;
  });
  startPromise = trackedPromise;
  return awaitWithAbort(trackedPromise, signal);
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve({ stopped: false, forced: false });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (forced) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve({ stopped: true, forced });
    };
    const onExit = () => finish(false);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish(true);
    }, Math.max(100, Math.min(10_000, Number(timeoutMs) || 2_000)));
    child.once('exit', onExit);
    try {
      child.kill();
    } catch (_) {
      finish(false);
    }
  });
}

function stopFigmaBridge(options = {}) {
  if (stopPromise) return stopPromise;
  bridgeStopping = true;
  startAbortController?.abort();
  const pendingStart = startPromise;
  const childAtStop = childProcess;
  stopPromise = (async () => {
    if (pendingStart) {
      try { await pendingStart; } catch (_) {}
    }
    const child = childProcess || childAtStop;
    const outcome = await waitForChildExit(child, options.timeoutMs);
    if (childProcess === child && (child?.exitCode !== null || (outcome.stopped && !outcome.forced))) {
      childProcess = null;
    }
    return { ok: true, ...outcome };
  })().finally(() => {
    stopPromise = null;
    if (options.allowRestart === true) bridgeStopping = false;
  });
  return stopPromise;
}

function startFigmaBridgeOnAppStart(logger = console, options = {}) {
  return ensureFigmaBridgeRunning({ ...options, logger }).then((result) => {
    if (result.ok) {
      log(logger, `[figma-bridge] ready at ${result.base}${result.started ? ' (auto-started)' : ''}`);
    } else if (!result.disabled) {
      warn(logger, `[figma-bridge] not ready: ${result.message || 'unknown error'}`);
    }
    return result;
  }).catch((error) => {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      log(logger, '[figma-bridge] startup cancelled');
      return { ok: false, aborted: true, message: error.message };
    }
    warn(logger, `[figma-bridge] auto-start failed: ${error && error.message ? error.message : error}`);
    return { ok: false, error: true, message: error?.message || String(error) };
  });
}

module.exports = {
  ensureFigmaBridgeRunning,
  getFigmaBridgeHealth,
  startFigmaBridgeOnAppStart,
  stopFigmaBridge,
};
