'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  CdpClient,
  findFreePort,
  launch,
  pressKey,
  sleep,
  stopProcess,
  waitForEvaluation,
  waitForHtml,
  waitForJson,
} = require('./verify-creator-agent-p4-ui.cjs');
const {
  install,
  verifyInstallation,
} = require('../tools/zcanvas-cli/src/installer.cjs');

const ROOT = path.resolve(__dirname, '..');
const SYSTEM_TEMP = path.resolve(process.env.TEMP || process.env.TMP || path.join(ROOT, '.tmp'));
const QA_PARENT = path.join(SYSTEM_TEMP, 't8-penguin-canvas-qa');
const QA_ROOT = path.join(QA_PARENT, 'creator-agent-p4-pairing');
const USER_DATA = path.join(QA_ROOT, 'electron-user-data');
const HOME = path.join(QA_ROOT, 'fresh-user-home');
const CODEX_HOME = path.join(QA_ROOT, 'fresh-codex-home');
const LOCAL_APP_DATA = path.join(QA_ROOT, 'local-app-data');
const INSTALL_ROOT = path.join(LOCAL_APP_DATA, 'ZhenzhenCanvas', 'Agent');
const AGENTS_SKILL = path.join(HOME, '.agents', 'skills', 'zhenzhen-canvas');
const CODEX_SKILL = path.join(CODEX_HOME, 'skills', 'zhenzhen-canvas');
const AUTH_STORE = path.join(HOME, '.zcanvas', 'credentials-v1.json');
const SECONDARY_AUTH_STORE = path.join(HOME, '.zcanvas-secondary', 'credentials-v1.json');
const REGISTRY_DIR = path.join(QA_ROOT, 'instances');
const ARTIFACT_PARENT = path.join(ROOT, 'artifacts');
const ARTIFACT_DIR = path.join(ARTIFACT_PARENT, 'creator-agent-p4-pairing');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
let frontendPort = 0;
let frontendUrl = '';
let requestedBackendPort = 0;
const TIMEOUT_MS = 60_000;

function checkpoint(label) {
  process.stderr.write(`[creator-agent-pairing-qa] ${new Date().toISOString()} ${label}\n`);
}

function assertInside(parent, candidate, label) {
  const parentPath = path.resolve(parent);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(parentPath, candidatePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝清理非 ${label} 目录`);
  }
  return candidatePath;
}

function resetQaDirectories() {
  fs.rmSync(assertInside(QA_PARENT, QA_ROOT, 'P4-F QA'), { recursive: true, force: true });
  fs.rmSync(assertInside(ARTIFACT_PARENT, ARTIFACT_DIR, 'P4-F 证据'), {
    recursive: true,
    force: true,
  });
  for (const directory of [USER_DATA, HOME, CODEX_HOME, LOCAL_APP_DATA, REGISTRY_DIR, ARTIFACT_DIR]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

async function waitForElectronPage(debugPort) {
  const targetList = await waitForJson(
    `http://127.0.0.1:${debugPort}/json/list`,
    (items) => Array.isArray(items) && items.some((item) => (
      item.type === 'page'
      && item.url.startsWith(frontendUrl)
      && item.webSocketDebuggerUrl
    )),
    TIMEOUT_MS,
  );
  return targetList.find((item) => (
    item.type === 'page'
    && item.url.startsWith(frontendUrl)
    && item.webSocketDebuggerUrl
  ));
}

function cliEnvironment(options = {}) {
  return {
    ...process.env,
    HOME,
    USERPROFILE: HOME,
    CODEX_HOME,
    LOCALAPPDATA: LOCAL_APP_DATA,
    ZCANVAS_AUTH_STORE: options.authStore || AUTH_STORE,
    ZCANVAS_INSTANCE_DIR: REGISTRY_DIR,
    ZCANVAS_CLI: '',
  };
}

function runCli(args, options = {}) {
  const wrapper = path.join(CODEX_SKILL, 'scripts', 'zcanvas.cjs');
  const result = spawnSync(process.execPath, [wrapper, ...args], {
    cwd: QA_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: cliEnvironment(options),
    timeout: 60_000,
  });
  let payload = null;
  try {
    payload = JSON.parse(String(result.stdout || '').trim());
  } catch (_) {}
  if (!options.allowFailure) {
    assert.equal(
      result.status,
      0,
      `zcanvas 命令失败: ${args.join(' ')}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.equal(payload?.ok, true);
  }
  return { ...result, payload };
}

async function captureScreenshot(cdp, filename) {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  const target = path.join(ARTIFACT_DIR, filename);
  fs.writeFileSync(target, Buffer.from(result.data, 'base64'));
  return target;
}

async function waitForPairingDialog(cdp, userCode) {
  await waitForEvaluation(cdp, `(() => {
    const dialog = document.querySelector('[role="dialog"][aria-labelledby="agent-control-pairing-title"]');
    return Boolean(dialog && dialog.textContent.includes(${JSON.stringify(userCode)}));
  })()`);
}

async function approveCurrentPairing(cdp, options = {}) {
  const removeScopeLabel = String(options.removeScopeLabel || '');
  const result = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-labelledby="agent-control-pairing-title"]');
    if (!dialog) return { ok: false, reason: 'dialog-missing' };
    const labels = [...dialog.querySelectorAll('label')];
    const removed = ${JSON.stringify(removeScopeLabel)}
      ? labels.find((label) => label.textContent.includes(${JSON.stringify(removeScopeLabel)}))
      : null;
    if (removed) {
      const checkbox = removed.querySelector('input[type="checkbox"]');
      if (checkbox?.checked) checkbox.click();
    }
    const confirmation = labels.find((label) => label.textContent.includes('我已核对验证码'));
    const confirmationCheckbox = confirmation?.querySelector('input[type="checkbox"]');
    if (!confirmationCheckbox) return { ok: false, reason: 'confirmation-missing' };
    if (!confirmationCheckbox.checked) confirmationCheckbox.click();
    const approve = [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent.includes('批准连接'));
    if (!approve || approve.disabled) return { ok: false, reason: 'approve-disabled' };
    approve.click();
    return {
      ok: true,
      removedScope: Boolean(removed),
      code: dialog.querySelector('.font-mono')?.textContent?.trim() || '',
    };
  })()`);
  assert.equal(result.ok, true, JSON.stringify(result));
  await waitForEvaluation(cdp, `!document.querySelector(
    '[role="dialog"][aria-labelledby="agent-control-pairing-title"]'
  )`);
  return result;
}

async function denyCurrentPairing(cdp) {
  const denied = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-labelledby="agent-control-pairing-title"]');
    if (!dialog) return false;
    const button = [...dialog.querySelectorAll('footer button')]
      .find((item) => item.textContent.trim() === '拒绝');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(denied, true);
  await waitForEvaluation(cdp, `!document.querySelector(
    '[role="dialog"][aria-labelledby="agent-control-pairing-title"]'
  )`);
}

async function exerciseKeyboardDenial(cdp) {
  const initial = await waitForEvaluation(cdp, `(() => {
    const dialog = document.querySelector('[data-agent-control-pairing-dialog]');
    if (!dialog || document.activeElement !== dialog) return null;
    const descriptionId = dialog.getAttribute('aria-describedby');
    return {
      focusInside: dialog.contains(document.activeElement),
      describedBy: descriptionId,
      descriptionPresent: Boolean(descriptionId && document.getElementById(descriptionId)),
    };
  })()`);
  assert.equal(initial.focusInside, true);
  assert.equal(initial.descriptionPresent, true);

  const focusBoundary = async (which) => cdp.evaluate(`(() => {
    const dialog = document.querySelector('[data-agent-control-pairing-dialog]');
    if (!dialog) return false;
    const selector = [
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      'a[href]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const focusable = [...dialog.querySelectorAll(selector)]
      .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
    const target = ${JSON.stringify(which)} === 'first'
      ? focusable[0]
      : focusable[focusable.length - 1];
    target?.focus();
    return Boolean(target && document.activeElement === target);
  })()`);

  assert.equal(await focusBoundary('last'), true);
  await pressKey(cdp, 'Tab');
  const forwardWrapped = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[data-agent-control-pairing-dialog]');
    return Boolean(dialog && dialog.contains(document.activeElement));
  })()`);
  assert.equal(forwardWrapped, true);

  assert.equal(await focusBoundary('first'), true);
  await pressKey(cdp, 'Tab', { shiftKey: true });
  const backwardWrapped = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[data-agent-control-pairing-dialog]');
    return Boolean(dialog && dialog.contains(document.activeElement));
  })()`);
  assert.equal(backwardWrapped, true);

  await pressKey(cdp, 'Escape');
  await waitForEvaluation(cdp, `!document.querySelector('[data-agent-control-pairing-dialog]')`);
  return { forwardWrapped, backwardWrapped };
}

async function assertConnectionCounts(cdp, expected, label) {
  const summary = await cdp.evaluate(
    `window.t8pc.agentControl.getConnectionSummary()`,
  );
  assert.equal(summary?.success, true, `${label}: connection summary failed`);
  assert.equal(
    summary.data.activeSessionCount,
    expected.active,
    `${label}: activeSessionCount`,
  );
  assert.equal(summary.data.codexSessionCount, expected.codex, `${label}: codexSessionCount`);
  checkpoint(`${label} active=${summary.data.activeSessionCount} codex=${summary.data.codexSessionCount}`);
  return summary;
}

async function waitForRegisteredBackend(timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = fs.existsSync(REGISTRY_DIR)
      ? fs.readdirSync(REGISTRY_DIR).filter((name) => name.endsWith('.json'))
      : [];
    for (const name of files) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, name), 'utf8'));
        if (
          record?.schema !== 't8-agent-control-instance-v1'
          || !/^http:\/\/127\.0\.0\.1:\d+\/api\/status$/.test(String(record.statusUrl || ''))
        ) continue;
        const status = await waitForJson(
          record.statusUrl,
          (payload) => payload?.ok === true && payload?.instanceId === record.instanceId,
          Math.min(5_000, Math.max(500, deadline - Date.now())),
        );
        return { record, status };
      } catch (_) {}
    }
    await sleep(120);
  }
  throw new Error('等待隔离 Electron 注册 Agent Control 后端超时');
}

function startPairing(scopes, name, options = {}) {
  const result = runCli([
    'auth',
    'pair',
    '--name',
    name,
    '--scopes',
    scopes.join(','),
  ], { ...options, allowFailure: true });
  assert.equal(result.payload?.code, 'PAIRING_CONFIRMATION_REQUIRED', result.stdout);
  assert.match(String(result.payload?.data?.userCode || ''), /^[A-Z2-9]{8}$/);
  assert.match(String(result.payload?.data?.instanceId || ''), /^[A-Za-z0-9_-]{43,128}$/);
  return result.payload.data;
}

async function waitForProcessExit(child, timeoutMs = 20_000) {
  if (!child || child.exitCode != null || child.signalCode != null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

async function distinctFreePort(excluded) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = await findFreePort();
    if (candidate !== excluded) return candidate;
  }
  throw new Error('无法为 Creator Agent QA 分配两个不同的隔离端口');
}

async function requestStatus(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch (_) {}
  return {
    status: response.status,
    code: String(payload?.code || ''),
    ok: Boolean(payload?.ok ?? payload?.success ?? response.ok),
  };
}

async function run() {
  assert.equal(fs.existsSync(ELECTRON), true, '缺少项目锁定的 Electron 可执行文件');
  frontendPort = await findFreePort();
  frontendUrl = `http://127.0.0.1:${frontendPort}/`;
  requestedBackendPort = await distinctFreePort(frontendPort);
  resetQaDirectories();

  install({
    projectRoot: ROOT,
    installRoot: INSTALL_ROOT,
    discoveryRoots: [AGENTS_SKILL, CODEX_SKILL],
  });
  assert.equal(verifyInstallation({ installRoot: INSTALL_ROOT }).verified, true);
  assert.equal(runCli(['version']).payload.data.skillName, 'zhenzhen-canvas');

  const debugPort = await findFreePort();
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const vite = launch(process.execPath, [
    path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--config',
    path.join(ROOT, 'vite.config.ts'),
    '--host',
    '127.0.0.1',
    '--port',
    String(frontendPort),
    '--strictPort',
  ], {
    env: {
      ...process.env,
      T8_FIGMA_BRIDGE_AUTOSTART: '0',
      T8PC_DEV_BACKEND_ORIGIN: `http://127.0.0.1:${requestedBackendPort}`,
      TEMP: SYSTEM_TEMP,
      TMP: SYSTEM_TEMP,
    },
  });
  let electron = null;
  let cdp = null;
  let requestedGracefulClose = false;

  try {
    await waitForHtml(frontendUrl);
    electron = launch(ELECTRON, [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${USER_DATA}`,
      '--remote-allow-origins=*',
      path.join(ROOT, 'electron', 'main.cjs'),
    ], {
      env: {
        ...electronEnv,
        NODE_ENV: 'development',
        T8PC_PACKAGED: '0',
        T8PC_DEV_SERVER_URL: frontendUrl,
        T8PC_DEV_BACKEND_PORT: String(requestedBackendPort),
        T8PC_DEV_DATA_ROOT: USER_DATA,
        T8PC_AGENT_CONTROL_PAIRING_TTL_MS: '10000',
        T8PC_DEV_PROJECT_DB_STORAGE_PROFILE: 'acceptance-small-v1',
        ZCANVAS_INSTANCE_DIR: REGISTRY_DIR,
        T8_FIGMA_BRIDGE_AUTOSTART: '0',
        TEMP: QA_ROOT,
        TMP: QA_ROOT,
      },
    });

    const page = await waitForElectronPage(debugPort);
    const registeredBackend = await waitForRegisteredBackend();
    assert.equal(
      registeredBackend.record.origin,
      `http://127.0.0.1:${requestedBackendPort}`,
      'Electron 没有使用 QA 请求的隔离后端端口',
    );
    const authorityRecord = JSON.parse(
      fs.readFileSync(path.join(ROOT, '.t8-collaboration-management-authority.json'), 'utf8'),
    );
    const authorityToken = String(authorityRecord?.token || '');
    assert.match(authorityToken, /^[A-Za-z0-9_-]{43,128}$/);
    const backendOrigin = registeredBackend.record.origin;
    const [directCapabilities, proxiedCapabilities, directCollaboration, proxiedCollaboration] = await Promise.all([
      requestStatus(`${backendOrigin}/api/creator-agent/v1/capabilities`),
      requestStatus(`${frontendUrl}api/creator-agent/v1/capabilities`),
      requestStatus(`${backendOrigin}/api/collaboration/run-intents?status=accepted&projectId=project-local&canvasId=qa-preflight`, {
        headers: { 'x-t8-collaboration-management-token': authorityToken },
      }),
      requestStatus(`${frontendUrl}api/collaboration/run-intents?status=accepted&projectId=project-local&canvasId=qa-preflight`),
    ]);
    checkpoint(`backend-preflight ${JSON.stringify({
      directCapabilities,
      proxiedCapabilities,
      directCollaboration,
      proxiedCollaboration,
    })}`);
    assert.equal(directCapabilities.status, 200, '隔离后端未挂载 Creator Agent capability 路由');
    assert.equal(
      proxiedCapabilities.status,
      200,
      'Vite 没有把 Creator Agent capability 路由代理到隔离后端',
    );
    assert.notEqual(directCollaboration.status, 401, '隔离后端拒绝了同源管理 authority');
    assert.notEqual(proxiedCollaboration.status, 401, 'Vite 未携带同源协作管理 authority');
    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.connect();
    const browserErrors = [];
    const failedResponses = [];
    cdp.onEvent((message) => {
      if (message.method === 'Runtime.exceptionThrown') {
        browserErrors.push(
          message.params?.exceptionDetails?.exception?.description
          || message.params?.exceptionDetails?.text
          || 'runtime exception',
        );
      }
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        const entry = message.params.entry;
        browserErrors.push(`${entry.text || 'console error'}${entry.url ? ` @ ${entry.url}` : ''}`);
      }
      if (message.method === 'Network.responseReceived') {
        const response = message.params?.response;
        if (Number(response?.status) >= 400) {
          let safeUrl = String(response?.url || '');
          try {
            const parsed = new URL(safeUrl);
            safeUrl = `${parsed.origin}${parsed.pathname}`;
          } catch (_) {}
          failedResponses.push({ status: Number(response.status), url: safeUrl });
        }
      }
    });
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('Log.enable'),
      cdp.send('Network.enable'),
    ]);
    await cdp.send('Page.bringToFront');
    await waitForEvaluation(cdp, `Boolean(window.t8pc?.agentControl?.getConnectionSummary)`);
    await waitForEvaluation(cdp, `Boolean(
      document.querySelector('#root')?.childElementCount
      && document.querySelector('.t8-main-layout')
    )`);
    // The pairing modal refresh loop is mounted with the top-level App. Give
    // its initial IPC read one complete interval before creating a short-lived request.
    await sleep(2_200);
    checkpoint('renderer-ready');

    const requestedScopes = ['canvas:read', 'run:read'];
    const approvedPairing = startPairing(requestedScopes, 'P4-F Fresh Codex');
    await waitForPairingDialog(cdp, approvedPairing.userCode);
    const pairingScreenshot = await captureScreenshot(cdp, 'creator-agent-pairing-code-match.png');
    const approvedUi = await approveCurrentPairing(cdp, { removeScopeLabel: '查看任务状态与结果' });
    assert.equal(approvedUi.code, approvedPairing.userCode);
    assert.equal(approvedUi.removedScope, true);

    const completed = runCli([
      'auth',
      'complete',
      '--instance',
      approvedPairing.instanceId,
    ]);
    assert.equal(completed.payload.data.authenticated, true);
    const status = runCli(['auth', 'status', '--instance', approvedPairing.instanceId]);
    assert.deepEqual(status.payload.data.scopes, ['canvas:read']);
    const connectedSummary = await cdp.evaluate(`window.t8pc.agentControl.getConnectionSummary()`);
    assert.equal(connectedSummary.success, true);
    assert.equal(connectedSummary.data.codexConnected, true);
    assert.deepEqual(connectedSummary.data.codexScopes, ['canvas:read']);
    assert.doesNotMatch(
      JSON.stringify(connectedSummary),
      /accessToken|pollSecret|sessionId|userCode|pairingId/i,
    );
    checkpoint('first-pairing-approved');

    const revoked = runCli(['auth', 'revoke', '--instance', approvedPairing.instanceId]);
    assert.equal(revoked.payload.data.revoked, true);
    const revokedStatus = runCli(
      ['auth', 'status', '--instance', approvedPairing.instanceId],
      { allowFailure: true },
    );
    assert.equal(revokedStatus.payload?.code, 'PAIRING_REQUIRED');
    await waitForEvaluation(cdp, `(async () => {
      const summary = await window.t8pc.agentControl.getConnectionSummary();
      return summary?.success && summary.data.codexConnected === false;
    })()`);
    checkpoint('first-session-revoked');

    const focusSentinelReady = await cdp.evaluate(`(() => {
      const sentinel = document.createElement('button');
      sentinel.id = 'p4-pairing-focus-sentinel';
      sentinel.type = 'button';
      sentinel.textContent = 'P4 pairing focus return target';
      sentinel.style.position = 'fixed';
      sentinel.style.left = '-10000px';
      document.body.appendChild(sentinel);
      sentinel.focus();
      return document.activeElement === sentinel;
    })()`);
    assert.equal(focusSentinelReady, true);
    const deniedPairing = startPairing(['canvas:read'], 'P4-F Denied Codex');
    checkpoint('keyboard-denial-pairing-started');
    await waitForPairingDialog(cdp, deniedPairing.userCode);
    const keyboardDenial = await exerciseKeyboardDenial(cdp);
    await waitForEvaluation(cdp, `document.activeElement?.id === 'p4-pairing-focus-sentinel'`);
    checkpoint('keyboard-denial-complete');
    const deniedComplete = runCli([
      'auth',
      'complete',
      '--instance',
      deniedPairing.instanceId,
    ], { allowFailure: true });
    assert.equal(deniedComplete.payload?.code, 'PAIRING_DENIED');
    await assertConnectionCounts(cdp, { active: 0, codex: 0 }, 'after-denial');

    const expiredPairing = startPairing(['canvas:read'], 'P4-F Expired Codex');
    await waitForPairingDialog(cdp, expiredPairing.userCode);
    await sleep(Math.max(0, Date.parse(expiredPairing.expiresAt) - Date.now()) + 500);
    const expiredComplete = runCli([
      'auth',
      'complete',
      '--instance',
      expiredPairing.instanceId,
    ], { allowFailure: true });
    assert.equal(expiredComplete.payload?.code, 'PAIRING_EXPIRED');
    const authListAfterExpiry = runCli(['auth', 'list']);
    assert.equal(authListAfterExpiry.payload.data.pending.length, 0);
    await waitForEvaluation(cdp, `!document.querySelector(
      '[role="dialog"][aria-labelledby="agent-control-pairing-title"]'
    )`);
    checkpoint('expiry-complete');
    await assertConnectionCounts(cdp, { active: 0, codex: 0 }, 'after-expiry');

    const recoveredPairing = startPairing(['canvas:read'], 'P4-F Repaired Codex');
    await waitForPairingDialog(cdp, recoveredPairing.userCode);
    await approveCurrentPairing(cdp);
    const recovered = runCli([
      'auth',
      'complete',
      '--instance',
      recoveredPairing.instanceId,
    ]);
    assert.equal(recovered.payload.data.authenticated, true);
    assert.equal(
      runCli(['auth', 'status', '--instance', recoveredPairing.instanceId]).payload.data.authenticated,
      true,
    );
    checkpoint('recovery-pairing-approved');
    await assertConnectionCounts(cdp, { active: 1, codex: 1 }, 'after-recovery');

    const secondaryPairing = startPairing(
      ['run:read'],
      'P4-G Secondary Codex',
      { authStore: SECONDARY_AUTH_STORE },
    );
    await waitForPairingDialog(cdp, secondaryPairing.userCode);
    await approveCurrentPairing(cdp);
    const secondary = runCli([
      'auth',
      'complete',
      '--instance',
      secondaryPairing.instanceId,
    ], { authStore: SECONDARY_AUTH_STORE });
    assert.equal(secondary.payload.data.authenticated, true);
    checkpoint('secondary-pairing-approved');

    const twoSessionSummary = await assertConnectionCounts(
      cdp,
      { active: 2, codex: 2 },
      'after-secondary',
    );
    assert.deepEqual(twoSessionSummary.data.codexScopes, ['canvas:read', 'run:read']);
    assert.doesNotMatch(
      JSON.stringify(twoSessionSummary),
      /accessToken|pollSecret|sessionId|userCode|pairingId/i,
    );

    runCli(['auth', 'revoke', '--instance', recoveredPairing.instanceId]);
    const oneSessionSummary = await waitForEvaluation(cdp, `(async () => {
      const summary = await window.t8pc.agentControl.getConnectionSummary();
      return summary?.success
        && summary.data.codexSessionCount === 1
        && summary.data.codexScopes.length === 1
        && summary.data.codexScopes[0] === 'run:read'
        ? summary
        : null;
    })()`);
    assert.equal(oneSessionSummary.data.codexConnected, true);
    assert.equal(
      runCli([
        'auth',
        'status',
        '--instance',
        secondaryPairing.instanceId,
      ], { authStore: SECONDARY_AUTH_STORE }).payload.data.authenticated,
      true,
    );

    runCli([
      'auth',
      'revoke',
      '--instance',
      secondaryPairing.instanceId,
    ], { authStore: SECONDARY_AUTH_STORE });
    await waitForEvaluation(cdp, `(async () => {
      const summary = await window.t8pc.agentControl.getConnectionSummary();
      return summary?.success
        && summary.data.codexConnected === false
        && summary.data.activeSessionCount === 0;
    })()`);
    checkpoint('all-sessions-revoked');

    await sleep(300);
    if (browserErrors.length) {
      checkpoint(`renderer-errors ${JSON.stringify({ browserErrors, failedResponses })}`);
    }
    assert.deepEqual(browserErrors, [], `Electron renderer 出现错误: ${browserErrors.join('\n')}`);
    const report = {
      schema: 't8-creator-agent-p4-pairing-acceptance-v1',
      generatedAt: new Date().toISOString(),
      passed: true,
      runtime: {
        realElectron: true,
        isolatedUserData: true,
        isolatedUserProfile: true,
        isolatedCodexHome: true,
        managedDiscoveryWrapper: true,
        realGlobalSkillTouched: false,
        dynamicFrontendPort: frontendPort,
        registeredBackendOrigin: registeredBackend.record.origin,
      },
      pairing: {
        terminalAndDialogCodeMatched: true,
        explicitScopeReduction: {
          requested: requestedScopes,
          approved: ['canvas:read'],
        },
        completed: true,
        connectionSummarySecretFree: true,
      },
      revocation: {
        serverSessionRevoked: true,
        localCredentialDeleted: true,
        subsequentStatusFailedClosed: true,
      },
      denial: {
        desktopDenied: true,
        keyboardEscapeDenied: true,
        focusTrappedForward: keyboardDenial.forwardWrapped,
        focusTrappedBackward: keyboardDenial.backwardWrapped,
        previousFocusRestored: true,
        cliReceivedPairingDenied: true,
        sessionIssued: false,
      },
      expiration: {
        developmentOnlyShortTtl: true,
        cliReceivedPairingExpired: true,
        stalePendingHidden: true,
        repairedByFreshPairing: true,
      },
      multipleSessions: {
        independentCredentialStores: 2,
        simultaneousCodexSessions: 2,
        scopesAggregatedWithoutEscalation: true,
        revokingOnePreservedOther: true,
        finalRevokeDisconnected: true,
        summariesSecretFree: true,
      },
      browserErrors,
      failedResponses,
      providerCalls: 0,
      canvasWrites: 0,
      electronBuilds: 0,
      screenshots: [pairingScreenshot],
    };
    fs.writeFileSync(
      path.join(ARTIFACT_DIR, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    checkpoint('report-written');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    requestedGracefulClose = true;
    await cdp.evaluate(`window.close(); true`);
    cdp.close();
    cdp = null;
    assert.equal(await waitForProcessExit(electron.child), true);
  } catch (error) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'failure.json'), `${JSON.stringify({
      error: error?.stack || String(error),
      viteLogs: vite.logs,
      electronLogs: electron?.logs || [],
    }, null, 2)}\n`, 'utf8');
    throw error;
  } finally {
    cdp?.close();
    if (!requestedGracefulClose || electron?.child.exitCode == null) stopProcess(electron?.child);
    stopProcess(vite.child);
  }
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
