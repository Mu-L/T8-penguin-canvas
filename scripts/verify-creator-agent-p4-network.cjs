'use strict';

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
  requestJson,
  sleep,
  stopProcess,
  waitForEvaluation,
  waitForHtml,
  waitForJson,
} = require('./verify-creator-agent-p4-ui.cjs');

const ROOT = path.resolve(__dirname, '..');
const TEMP_PARENT = path.resolve(process.env.TEMP || process.env.TMP || path.join(ROOT, '.tmp'));
const QA_ROOT = path.join(TEMP_PARENT, 't8-creator-agent-p4-network');
const CHROME_PROFILE = path.join(QA_ROOT, 'chrome-profile');
const USER_DATA = path.join(QA_ROOT, 'user-data');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'creator-agent-p4-network');
const BACKEND_PORT = 18766;
const FRONTEND_PORT = 11422;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const FRONTEND_URL = `http://127.0.0.1:${FRONTEND_PORT}/`;
const TIMEOUT_MS = 120_000;

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
  fs.rmSync(assertInside(TEMP_PARENT, QA_ROOT, 'QA 临时'), { recursive: true, force: true });
  fs.rmSync(
    assertInside(path.join(ROOT, 'artifacts'), ARTIFACT_DIR, 'QA 证据'),
    { recursive: true, force: true },
  );
  fs.mkdirSync(CHROME_PROFILE, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function readDevelopmentAuthorityToken() {
  const authorityPath = path.join(ROOT, '.t8-collaboration-management-authority.json');
  const record = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
  assert.equal(record?.schema, 't8-collaboration-management-authority-v1');
  assert.match(String(record?.token || ''), /^[A-Za-z0-9_-]{43,128}$/);
  return String(record.token);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error('未找到 Chrome 或 Edge 可执行文件');
  return executable;
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

async function readSession(sessionId, projectId, canvasId) {
  const query = new URLSearchParams({ projectId, canvasId });
  return (await requestJson(
    `${BACKEND_URL}/api/creator-agent/v1/sessions/${encodeURIComponent(sessionId)}?${query}`,
  )).data;
}

async function waitForSession(sessionId, projectId, canvasId, predicate, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await readSession(sessionId, projectId, canvasId);
    if (predicate(latest)) return latest;
    await sleep(80);
  }
  throw new Error(`等待 Creator Session 条件超时，最后 sequence=${latest?.lastSequence || 0}`);
}

async function waitForPromise(value, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      value,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function launchBackend(authorityToken) {
  return launch(process.execPath, [path.join(ROOT, 'backend', 'src', 'server.js')], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(BACKEND_PORT),
      NODE_ENV: 'development',
      T8PC_PACKAGED: '1',
      T8PC_USER_DATA: USER_DATA,
      T8PC_FRONTEND_DIST: path.join(QA_ROOT, 'unused-frontend'),
      T8PC_RES: ROOT,
      T8_COLLAB_MANAGEMENT_TOKEN: authorityToken,
      T8_FIGMA_BRIDGE_AUTOSTART: '0',
      TEMP: TEMP_PARENT,
      TMP: TEMP_PARENT,
    },
  });
}

async function waitForBackendPortAvailable(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await assertPortAvailable(BACKEND_PORT);
      return;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw lastError || new Error('等待开发后端释放端口超时');
}

async function run() {
  await assertPortAvailable(BACKEND_PORT);
  await assertPortAvailable(FRONTEND_PORT);
  resetQaDirectories();

  const debugPort = await findFreePort();
  const authorityToken = readDevelopmentAuthorityToken();
  const backendInstances = [];
  let backend = launchBackend(authorityToken);
  backendInstances.push(backend);
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
      TEMP: TEMP_PARENT,
      TMP: TEMP_PARENT,
    },
  });
  let chrome = null;
  let cdp = null;

  try {
    await waitForJson(`${BACKEND_URL}/api/status`, (payload) => payload?.ok === true);
    await waitForHtml(FRONTEND_URL);
    const created = await requestJson(`${BACKEND_URL}/api/canvas`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Creator Agent P4 Network QA' }),
    });
    const canvasId = created.data.id;
    const projectId = 'project-local';
    const before = (await requestJson(
      `${BACKEND_URL}/api/canvas/${encodeURIComponent(canvasId)}`,
    )).data;
    const beforeRevision = before.revision;
    const beforeGraph = graphSnapshot(before);

    chrome = launch(findChrome(), [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${CHROME_PROFILE}`,
      '--headless=new',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-allow-origins=*',
      '--window-size=1480,920',
      'about:blank',
    ]);
    const targets = await waitForJson(
      `http://127.0.0.1:${debugPort}/json/list`,
      (items) => Array.isArray(items)
        && items.some((item) => item.type === 'page' && item.webSocketDebuggerUrl),
    );
    const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    assert.ok(page?.webSocketDebuggerUrl, '没有找到 Chrome 页面调试目标');
    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.connect();

    const browserErrors = [];
    const expectedOfflineErrors = [];
    const expectedRestartProxyErrors = [];
    let backendRestartInProgress = false;
    cdp.onEvent((message) => {
      let detail = '';
      if (message.method === 'Runtime.exceptionThrown') {
        detail = message.params?.exceptionDetails?.exception?.description
          || message.params?.exceptionDetails?.text || 'runtime exception';
      } else if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        detail = message.params.entry.text || 'console error';
      }
      if (!detail) return;
      if (backendRestartInProgress && /500\s*\(Internal Server Error\)/i.test(detail)) {
        expectedRestartProxyErrors.push(detail);
      } else if (/ERR_INTERNET_DISCONNECTED|ERR_FAILED|ERR_CONNECTION_REFUSED|Failed to fetch|network error/i.test(detail)) {
        expectedOfflineErrors.push(detail);
      } else {
        browserErrors.push(detail);
      }
    });
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('Log.enable'),
      cdp.send('Network.enable'),
      cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1480,
        height: 920,
        deviceScaleFactor: 1,
        mobile: false,
      }),
    ]);
    await cdp.send('Page.navigate', { url: FRONTEND_URL });
    await waitForEvaluation(
      cdp,
      `Boolean(document.querySelector('[data-canvas-floating-ui="creator-agent-launcher"]'))`,
    );
    await focusLauncherAndOpen(cdp);
    await waitForEvaluation(
      cdp,
      `document.querySelectorAll('.t8-creator-agent-suggestions button').length === 3`,
    );

    const sessionKey = `t8-creator-agent-session-v1:${projectId}:${canvasId}`;
    const sessionId = await waitForEvaluation(
      cdp,
      `localStorage.getItem(${JSON.stringify(sessionKey)}) || ''`,
    );
    const prompt = '一句话做一个15秒雨夜霓虹追逐短片';
    let resolvePausedMessageResponse;
    const pausedMessageResponse = new Promise((resolve) => {
      resolvePausedMessageResponse = resolve;
    });
    const removeFetchListener = cdp.onEvent((message) => {
      if (message.method !== 'Fetch.requestPaused') return;
      const request = message.params?.request;
      if (request?.method !== 'POST'
        || !/\/api\/creator-agent\/v1\/sessions\/[^/]+\/messages$/.test(String(request.url || ''))
        || !message.params?.responseStatusCode) return;
      resolvePausedMessageResponse({
        requestId: message.params.requestId,
        responseStatusCode: message.params.responseStatusCode,
      });
    });
    await cdp.send('Fetch.enable', {
      patterns: [{
        urlPattern: '*api/creator-agent/v1/sessions/*/messages',
        requestStage: 'Response',
      }],
    });
    const submitted = await cdp.evaluate(`(() => {
      const textarea = document.querySelector('.t8-creator-agent-composer textarea');
      const send = document.querySelector('.t8-creator-agent-composer button[aria-label="发送"]');
      if (!textarea || !send) return false;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      ).set;
      setter.call(textarea, ${JSON.stringify(prompt)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    assert.equal(submitted, true, '无法填写 Creator Agent 一句话输入');
    await waitForEvaluation(
      cdp,
      `!document.querySelector('.t8-creator-agent-composer button[aria-label="发送"]').disabled`,
    );
    await cdp.evaluate(`document.querySelector(
      '.t8-creator-agent-composer button[aria-label="发送"]'
    ).click(); true`);

    const accepted = await waitForSession(
      sessionId,
      projectId,
      canvasId,
      (session) => session.events.some((event) => event.type === 'assistant.response.started'),
    );
    const userEvent = accepted.events.find((event) => (
      event.type === 'user.message' && event.payload?.text === prompt
    ));
    assert.ok(userEvent?.payload?.clientRequestId, '服务端没有持久化客户端请求编号');
    const clientRequestId = userEvent.payload.clientRequestId;
    const startedEvent = accepted.events.find((event) => (
      event.type === 'assistant.response.started'
        && event.payload?.clientRequestId === clientRequestId
    ));
    assert.ok(startedEvent?.payload?.responseId, '服务端没有持久化流式响应编号');
    const responseId = startedEvent.payload.responseId;

    const completedBeforeResponseDelivery = await waitForSession(
      sessionId,
      projectId,
      canvasId,
      (session) => session.events.some((event) => (
        event.type === 'assistant.response.completed'
          && event.payload?.clientRequestId === clientRequestId
      )),
    );
    const paused = await waitForPromise(
      pausedMessageResponse,
      20_000,
      '等待服务器已完成但尚未交给页面的消息响应',
    );
    assert.equal(paused.responseStatusCode, 201);
    await waitForEvaluation(
      cdp,
      `(() => {
        const assistant = document.querySelector('.t8-creator-agent-message.is-assistant');
        return Boolean(assistant) && !assistant.querySelector('.t8-creator-agent-stream-status');
      })()`,
      20_000,
    );
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
      connectionType: 'none',
    });
    await cdp.send('Fetch.failRequest', {
      requestId: paused.requestId,
      errorReason: 'Aborted',
    });
    await cdp.send('Fetch.disable');
    removeFetchListener();
    await waitForEvaluation(
      cdp,
      `Boolean(document.querySelector('.t8-creator-agent-connection'))`,
      20_000,
    );
    const disconnectedScreenshot = await captureScreenshot(
      cdp,
      'creator-agent-response-lost.png',
    );
    assert.equal(
      completedBeforeResponseDelivery.events.filter((event) => (
        event.type === 'user.message'
          && event.payload?.clientRequestId === clientRequestId
      )).length,
      1,
    );

    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: 'wifi',
    });
    await waitForEvaluation(cdp, `(() => {
      const user = [...document.querySelectorAll('.t8-creator-agent-message.is-user')]
        .some((element) => element.textContent.includes(${JSON.stringify(prompt)}));
      const assistant = document.querySelectorAll('.t8-creator-agent-message.is-assistant').length > 0;
      const suggestions = document.querySelectorAll('.t8-creator-agent-suggestions button').length === 3;
      return user && assistant && suggestions
        && !document.querySelector('.t8-creator-agent-connection');
    })()`);

    const retryWasAvailable = await cdp.evaluate(`(() => {
      const textarea = document.querySelector('.t8-creator-agent-composer textarea');
      const send = document.querySelector('.t8-creator-agent-composer button[aria-label="发送"]');
      if (!textarea || !send || !textarea.value.trim() || send.disabled) return false;
      send.click();
      return true;
    })()`);
    assert.equal(retryWasAvailable, false, '终态已由 SSE 到达时不应恢复可重复发送的草稿');
    if (retryWasAvailable) {
      await waitForEvaluation(
        cdp,
        `!document.querySelector('.t8-creator-agent-composer button[aria-label="发送"]').disabled`,
        20_000,
      ).catch(() => true);
    }

    backendRestartInProgress = true;
    stopProcess(backend.child);
    await waitForBackendPortAvailable();
    backend = launchBackend(authorityToken);
    backendInstances.push(backend);
    await waitForJson(`${BACKEND_URL}/api/status`, (payload) => payload?.ok === true);

    const requestQuery = new URLSearchParams({ projectId, canvasId });
    const requestReceiptAfterRestart = (await requestJson(
      `${BACKEND_URL}/api/creator-agent/v1/sessions/${encodeURIComponent(sessionId)}`
        + `/messages/${encodeURIComponent(clientRequestId)}?${requestQuery}`,
    )).data;
    assert.equal(requestReceiptAfterRestart.schema, 't8-creator-message-request-v1');
    assert.equal(requestReceiptAfterRestart.status, 'completed');
    assert.equal(requestReceiptAfterRestart.responseId, responseId);

    await cdp.send('Page.reload', { ignoreCache: true });
    await waitForEvaluation(
      cdp,
      `Boolean(document.querySelector('[data-canvas-floating-ui="creator-agent-launcher"]'))`,
    );
    assert.equal(
      await cdp.evaluate(`localStorage.getItem(${JSON.stringify(sessionKey)}) || ''`),
      sessionId,
      '后端重启后浏览器没有保留原 Creator Session',
    );
    await focusLauncherAndOpen(cdp);
    await waitForEvaluation(cdp, `(() => {
      const user = [...document.querySelectorAll('.t8-creator-agent-message.is-user')]
        .some((element) => element.textContent.includes(${JSON.stringify(prompt)}));
      const assistant = document.querySelectorAll('.t8-creator-agent-message.is-assistant').length > 0;
      const suggestions = document.querySelectorAll('.t8-creator-agent-suggestions button').length === 3;
      return user && assistant && suggestions
        && !document.querySelector('.t8-creator-agent-connection');
    })()`);
    backendRestartInProgress = false;
    const restartedScreenshot = await captureScreenshot(
      cdp,
      'creator-agent-backend-restarted.png',
    );

    const finalSession = await readSession(sessionId, projectId, canvasId);
    const matchingEvents = finalSession.events.filter((event) => (
      event.payload?.clientRequestId === clientRequestId
    ));
    assert.equal(matchingEvents.filter((event) => event.type === 'user.message').length, 1);
    assert.equal(matchingEvents.filter((event) => event.type === 'assistant.response.started').length, 1);
    assert.equal(matchingEvents.filter((event) => event.type === 'assistant.response.completed').length, 1);
    assert.equal(finalSession.suggestions.length, 3);
    assert.equal(finalSession.suggestionSet.items.length, 3);

    const recoveredScreenshot = await captureScreenshot(
      cdp,
      'creator-agent-network-recovered.png',
    );
    const after = (await requestJson(
      `${BACKEND_URL}/api/canvas/${encodeURIComponent(canvasId)}`,
    )).data;
    assert.equal(after.revision, beforeRevision, '断线恢复验收不应写入画布 revision');
    assert.equal(graphSnapshot(after), beforeGraph, '断线恢复验收污染了画布文档');
    assert.deepEqual(browserErrors, [], `浏览器出现非预期错误: ${browserErrors.join('\n')}`);

    const report = {
      schema: 't8-creator-agent-p4-network-acceptance-v1',
      scope: 'development-browser-no-provider',
      projectId,
      canvasId,
      sessionId,
      clientRequestId,
      responseId,
      interruption: {
        serverAcceptedBeforeResponseLoss: true,
        completedBeforeResponseDelivery: true,
        browserOfflineObserved: true,
        durableRequestRecovered: true,
        durableSessionPreserved: true,
        backendProcessRestarted: true,
        requestReceiptRecoveredAfterRestart: true,
        retryWasAvailable,
      },
      exactlyOnce: {
        userMessages: matchingEvents.filter((event) => event.type === 'user.message').length,
        responseStarts: matchingEvents.filter((event) => event.type === 'assistant.response.started').length,
        responseCompletions: matchingEvents.filter((event) => event.type === 'assistant.response.completed').length,
        providerCalls: 0,
        canvasWrites: 0,
      },
      suggestions: finalSession.suggestions.length,
      canvasRevision: { before: beforeRevision, after: after.revision, unchanged: true },
      expectedOfflineErrors,
      expectedRestartProxyErrors,
      browserErrors,
      screenshots: [
        disconnectedScreenshot,
        recoveredScreenshot,
        restartedScreenshot,
      ],
    };
    fs.writeFileSync(
      path.join(ARTIFACT_DIR, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const diagnostics = {
      error: error?.stack || String(error),
      backendLogs: backendInstances.map((instance) => instance.logs),
      viteLogs: vite.logs,
      chromeLogs: chrome?.logs || [],
    };
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(ARTIFACT_DIR, 'failure.json'),
      `${JSON.stringify(diagnostics, null, 2)}\n`,
      'utf8',
    );
    throw error;
  } finally {
    try {
      if (cdp) {
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
          connectionType: 'wifi',
        });
      }
    } catch (_) {}
    cdp?.close();
    stopProcess(chrome?.child);
    stopProcess(vite.child);
    for (const instance of backendInstances) stopProcess(instance.child);
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { run };
