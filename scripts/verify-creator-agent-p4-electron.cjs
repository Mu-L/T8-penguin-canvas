const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CdpClient,
  assertPortAvailable,
  findFreePort,
  focusLauncherAndOpen,
  graphSnapshot,
  launch,
  pressKey,
  requestJson,
  sleep,
  stopProcess,
  waitForEvaluation,
  waitForHtml,
  waitForJson,
} = require('./verify-creator-agent-p4-ui.cjs');

const ROOT = path.resolve(__dirname, '..');
const SYSTEM_TEMP = path.resolve(process.env.TEMP || process.env.TMP || path.join(ROOT, '.tmp'));
const QA_PARENT = path.resolve(
  process.env.T8_CREATOR_AGENT_QA_PARENT || path.join(ROOT, '.tmp'),
);
const QA_ROOT = path.join(QA_PARENT, 'creator-agent-p4-electron');
const USER_DATA = path.join(QA_ROOT, 'user-data');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'creator-agent-p4-electron');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FRONTEND_PORT = 11422;
const BACKEND_PORT = 18766;
const FRONTEND_URL = `http://127.0.0.1:${FRONTEND_PORT}/`;
const TIMEOUT_MS = 60_000;

function assertInside(parent, candidate, label) {
  const parentPath = path.resolve(parent);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(parentPath, candidatePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝清理非 ${label} 目录: ${candidatePath}`);
  }
  return candidatePath;
}

function resetQaDirectories() {
  const qaRoot = assertInside(QA_PARENT, QA_ROOT, 'QA 临时');
  const artifactDir = assertInside(path.join(ROOT, 'artifacts'), ARTIFACT_DIR, 'QA 证据');
  fs.rmSync(qaRoot, { recursive: true, force: true });
  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function normalizedPath(value) {
  return path.resolve(String(value || '')).toLowerCase();
}

async function waitForElectronPage(debugPort) {
  const targetList = await waitForJson(
    `http://127.0.0.1:${debugPort}/json/list`,
    (items) => Array.isArray(items) && items.some((item) => (
      item.type === 'page'
      && item.url.startsWith(FRONTEND_URL)
      && item.webSocketDebuggerUrl
    )),
    TIMEOUT_MS,
  );
  return targetList.find((item) => (
    item.type === 'page'
    && item.url.startsWith(FRONTEND_URL)
    && item.webSocketDebuggerUrl
  ));
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

async function run() {
  assert.equal(fs.existsSync(ELECTRON), true, '缺少项目锁定的 Electron 可执行文件');
  await assertPortAvailable(BACKEND_PORT);
  await assertPortAvailable(FRONTEND_PORT);
  resetQaDirectories();

  const debugPort = await findFreePort();
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const vite = launch(process.execPath, [
    path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    String(FRONTEND_PORT),
    '--strictPort',
  ], {
    env: {
      ...process.env,
      T8_FIGMA_BRIDGE_AUTOSTART: '0',
      TEMP: SYSTEM_TEMP,
      TMP: SYSTEM_TEMP,
    },
  });
  let electron = null;
  let cdp = null;
  let requestedGracefulClose = false;

  try {
    await waitForHtml(FRONTEND_URL);
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
        T8PC_DEV_SERVER_URL: FRONTEND_URL,
        T8PC_DEV_DATA_ROOT: USER_DATA,
        T8_FIGMA_BRIDGE_AUTOSTART: '0',
        TEMP: QA_ROOT,
        TMP: QA_ROOT,
      },
    });

    const page = await waitForElectronPage(debugPort);
    assert.ok(page?.webSocketDebuggerUrl, '没有找到 Electron 主窗口调试目标');
    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.connect();

    const browserErrors = [];
    cdp.onEvent((message) => {
      if (message.method === 'Runtime.exceptionThrown') {
        browserErrors.push(
          message.params?.exceptionDetails?.exception?.description
          || message.params?.exceptionDetails?.text
          || 'runtime exception',
        );
      }
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        browserErrors.push(message.params.entry.text || 'console error');
      }
    });
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('Log.enable'),
      cdp.send('Network.enable'),
    ]);
    await cdp.send('Page.bringToFront');
    await waitForEvaluation(cdp, `Boolean(window.t8pc?.getInfo)`);

    const electronInfo = await cdp.evaluate(`window.t8pc.getInfo()`);
    assert.equal(electronInfo.packaged, false, 'Electron 开发窗口被误标为 packaged');
    assert.equal(electronInfo.backendPort, BACKEND_PORT, 'Electron 没有使用预期的隔离后端端口');
    assert.equal(electronInfo.version, require(path.join(ROOT, 'package.json')).version);
    assert.equal(
      normalizedPath(electronInfo.userData).startsWith(normalizedPath(USER_DATA)),
      true,
      `Electron userData 未隔离到 QA 目录: ${electronInfo.userData}`,
    );

    const backendUrl = `http://127.0.0.1:${electronInfo.backendPort}`;
    await waitForJson(`${backendUrl}/api/status`, (payload) => payload?.ok === true);
    const created = await requestJson(`${backendUrl}/api/canvas`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Creator Agent P4 Electron QA' }),
    });
    const canvasId = created.data.id;
    const projectId = 'project-local';
    const before = (await requestJson(`${backendUrl}/api/canvas/${encodeURIComponent(canvasId)}`)).data;
    const beforeRevision = before.revision;
    const beforeGraph = graphSnapshot(before);

    const firstTimeOrigin = await cdp.evaluate('performance.timeOrigin');
    await cdp.send('Page.navigate', { url: FRONTEND_URL });
    await waitForEvaluation(cdp, `performance.timeOrigin !== ${Number(firstTimeOrigin)}
      && Boolean(window.t8pc?.getInfo)
      && Boolean(document.querySelector('[data-canvas-floating-ui="creator-agent-launcher"]'))`);

    const runtimeIdentity = await cdp.evaluate(`(() => ({
      title: document.title,
      userAgent: navigator.userAgent,
      hasNodeRequire: typeof window.require !== 'undefined',
      hasProcess: typeof window.process !== 'undefined',
      hasTrustedPreload: Boolean(window.t8pc?.agentControl?.getConnectionSummary),
    }))()`);
    assert.match(runtimeIdentity.userAgent, /Electron\//, '主窗口不是 Electron renderer');
    assert.equal(runtimeIdentity.hasNodeRequire, false, 'renderer 暴露了 Node require');
    assert.equal(runtimeIdentity.hasProcess, false, 'renderer 暴露了 Node process');
    assert.equal(runtimeIdentity.hasTrustedPreload, true, '可信 preload API 缺失');

    const connectionSummary = await cdp.evaluate(`window.t8pc.agentControl.getConnectionSummary()`);
    assert.equal(connectionSummary.success, true, 'Electron Agent Control IPC 摘要不可用');
    assert.equal(
      JSON.stringify(connectionSummary).toLowerCase().includes('token'),
      false,
      'Electron Agent Control 公开摘要泄露 token 字段',
    );
    const updater = await cdp.evaluate(`window.t8pc.updater.getStatus()`);
    assert.equal(updater.packaged, false);
    assert.equal(updater.status, 'disabled');
    assert.match(String(updater.message || ''), /开发模式/);

    await focusLauncherAndOpen(cdp);
    await waitForEvaluation(cdp, `document.querySelectorAll('.t8-creator-agent-suggestions button').length === 3`);
    const sessionKey = `t8-creator-agent-session-v1:${projectId}:${canvasId}`;
    const sessionId = await waitForEvaluation(cdp, `localStorage.getItem(${JSON.stringify(sessionKey)}) || ''`);

    const drafted = await cdp.evaluate(`(() => {
      const textarea = document.querySelector('.t8-creator-agent-composer textarea');
      if (!textarea) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '帮我做一支12秒森林奇遇短片');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    assert.equal(drafted, true, 'Electron Creator Agent 输入框尚未就绪');
    await waitForEvaluation(cdp, `(() => {
      const button = document.querySelector('.t8-creator-agent-composer button[aria-label="发送"]');
      return button && !button.disabled;
    })()`);
    const sent = await cdp.evaluate(`(() => {
      const button = document.querySelector('.t8-creator-agent-composer button[aria-label="发送"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    assert.equal(sent, true, 'Electron Creator Agent 无法发送一句话需求');
    await waitForEvaluation(cdp, `(() => {
      const userMessage = [...document.querySelectorAll('.t8-creator-agent-message.is-user')]
        .some((item) => item.textContent.includes('帮我做一支12秒森林奇遇短片'));
      return userMessage && document.querySelectorAll('.t8-creator-agent-suggestions button').length === 3;
    })()`);

    const separatorFocused = await cdp.evaluate(`(() => {
      const separator = document.querySelector('.t8-creator-agent-resize-handle');
      if (!separator) return false;
      separator.focus();
      return document.activeElement === separator;
    })()`);
    assert.equal(separatorFocused, true);
    const widthBefore = await cdp.evaluate(
      `document.querySelector('[data-canvas-floating-ui="creator-agent-panel"]').getBoundingClientRect().width`,
    );
    await pressKey(cdp, 'ArrowLeft');
    const widthAfter = await waitForEvaluation(cdp, `(() => {
      const width = document.querySelector('[data-canvas-floating-ui="creator-agent-panel"]')
        ?.getBoundingClientRect().width || 0;
      return width > ${Number(widthBefore)} ? width : 0;
    })()`);
    assert.ok(widthAfter <= 560);

    const screenshot = await captureScreenshot(cdp, 'creator-agent-electron-one-sentence.png');
    await pressKey(cdp, 'Escape');
    await waitForEvaluation(cdp, `(() => {
      const launcher = document.querySelector('[data-canvas-floating-ui="creator-agent-launcher"]');
      return !document.querySelector('[data-canvas-floating-ui="creator-agent-panel"]')
        && document.activeElement === launcher;
    })()`);

    const reloadTimeOrigin = await cdp.evaluate('performance.timeOrigin');
    await cdp.send('Page.navigate', { url: FRONTEND_URL });
    await waitForEvaluation(cdp, `performance.timeOrigin !== ${Number(reloadTimeOrigin)}
      && Boolean(window.t8pc?.getInfo)
      && Boolean(document.querySelector('[data-canvas-floating-ui="creator-agent-launcher"]'))`);
    await focusLauncherAndOpen(cdp);
    await waitForEvaluation(cdp, `(() => [...document.querySelectorAll('.t8-creator-agent-message.is-user')]
      .some((item) => item.textContent.includes('帮我做一支12秒森林奇遇短片')))()`);
    assert.equal(
      await cdp.evaluate(`localStorage.getItem(${JSON.stringify(sessionKey)}) || ''`),
      sessionId,
      'Electron 刷新后 Creator Session 被替换',
    );

    const sessions = await requestJson(
      `${backendUrl}/api/creator-agent/v1/sessions?projectId=${encodeURIComponent(projectId)}&canvasId=${encodeURIComponent(canvasId)}&limit=20`,
    );
    assert.equal(sessions.data.sessions.length, 1, 'Electron 一次对话与刷新产生重复 Session');
    assert.equal(sessions.data.sessions[0].id, sessionId);

    const after = (await requestJson(`${backendUrl}/api/canvas/${encodeURIComponent(canvasId)}`)).data;
    assert.equal(after.revision, beforeRevision, 'Electron 只读对话修改了画布 revision');
    assert.equal(graphSnapshot(after), beforeGraph, 'Electron 只读对话污染画布文档');
    await sleep(500);
    assert.deepEqual(browserErrors, [], `Electron renderer 出现错误: ${browserErrors.join('\n')}`);

    const report = {
      schema: 't8-creator-agent-p4-electron-acceptance-v1',
      scope: 'development-electron-no-provider',
      runtime: {
        executable: ELECTRON,
        packaged: electronInfo.packaged,
        version: electronInfo.version,
        backendPort: electronInfo.backendPort,
        isolatedUserData: true,
        userAgent: runtimeIdentity.userAgent,
        contextIsolation: runtimeIdentity.hasNodeRequire === false && runtimeIdentity.hasProcess === false,
        trustedPreload: runtimeIdentity.hasTrustedPreload,
        updaterDisabledInDevelopment: updater.status === 'disabled',
      },
      canvasId,
      projectId,
      oneSentenceFlow: {
        prompt: '帮我做一支12秒森林奇遇短片',
        sessionId,
        sessionCountAfterReload: sessions.data.sessions.length,
        restoredAfterReload: true,
        suggestionCount: 3,
      },
      keyboard: {
        launcherOpenedWithEnter: true,
        panelResizedWithArrowKey: true,
        escapeClosedPanel: true,
        focusReturnedToLauncher: true,
      },
      agentControlSummaryAvailable: connectionSummary.success === true,
      canvasRevision: {
        before: beforeRevision,
        after: after.revision,
        unchanged: true,
      },
      browserErrors,
      screenshots: [screenshot],
    };
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    requestedGracefulClose = true;
    await cdp.evaluate(`window.close(); true`);
    cdp.close();
    cdp = null;
    assert.equal(
      await waitForProcessExit(electron.child),
      true,
      'Electron 窗口关闭后没有在有界时间内完成后端收尾',
    );
  } catch (error) {
    const diagnostics = {
      error: error?.stack || String(error),
      viteLogs: vite.logs,
      electronLogs: electron?.logs || [],
    };
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'failure.json'), `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');
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
