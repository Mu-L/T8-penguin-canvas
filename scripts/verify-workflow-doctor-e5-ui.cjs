const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIST = path.join(ROOT, 'dist');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'workflow-doctor-e5-ui');
const TEMP_ROOT = path.resolve(process.env.TEMP || process.env.TMP || path.join(ROOT, '.tmp'));
const QA_ROOT = path.join(TEMP_ROOT, 't8-workflow-doctor-e5-ui');
const CHROME_PROFILE = path.join(QA_ROOT, 'chrome-profile');
const USER_DATA = path.join(QA_ROOT, 'user-data');
const TIMEOUT_MS = 45_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertOwnedTemporaryPath(candidate) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(TEMP_ROOT, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝清理非 QA 临时目录: ${resolved}`);
  }
  return resolved;
}

function resetQaDirectory() {
  const target = assertOwnedTemporaryPath(QA_ROOT);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(CHROME_PROFILE, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
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

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function boundedLog(lines, value) {
  const text = String(value || '').replace(/\r/g, '');
  for (const line of text.split('\n')) {
    if (!line) continue;
    lines.push(line.slice(0, 1_000));
    if (lines.length > 200) lines.shift();
  }
}

function launch(command, args, options = {}) {
  const logs = [];
  const child = spawn(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => boundedLog(logs, chunk));
  child.stderr?.on('data', (chunk) => boundedLog(logs, chunk));
  return { child, logs };
}

function stopProcess(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  child.kill('SIGTERM');
}

async function waitForJson(url, predicate = () => true, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const value = await response.json();
        if (predicate(value)) return value;
      } else {
        lastError = new Error(`${url} 返回 HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw lastError || new Error(`等待 ${url} 超时`);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    throw new Error(`${options.method || 'GET'} ${url} 失败: HTTP ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.socket = null;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10_000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket 连接失败'));
      }, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP 未连接，无法调用 ${method}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本执行失败');
    }
    return result.result?.value;
  }

  close() {
    try {
      this.socket?.close();
    } catch (_) {}
  }
}

async function waitForEvaluation(cdp, expression, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() < deadline) {
    lastValue = await cdp.evaluate(expression);
    if (lastValue) return lastValue;
    await sleep(120);
  }
  throw new Error(`等待页面条件超时: ${expression.slice(0, 160)}，最后结果=${JSON.stringify(lastValue)}`);
}

async function clickByText(cdp, text) {
  const serialized = JSON.stringify(text);
  const clicked = await cdp.evaluate(`(() => {
    const target = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === ${serialized});
    if (!target) return false;
    target.click();
    return true;
  })()`);
  assert.equal(clicked, true, `未找到按钮：${text}`);
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

function graphSnapshot(document) {
  return JSON.stringify({
    nodes: document.nodes,
    edges: document.edges,
    viewport: document.viewport,
    nextNodeSerialId: document.nextNodeSerialId,
  });
}

async function run() {
  assert.equal(fs.existsSync(path.join(FRONTEND_DIST, 'index.html')), true, '缺少 dist/index.html，请先执行 npm run build');
  resetQaDirectory();

  const backendPort = await findFreePort();
  const debugPort = await findFreePort();
  const baseUrl = `http://127.0.0.1:${backendPort}`;
  const backend = launch(process.execPath, [path.join(ROOT, 'backend', 'src', 'server.js')], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(backendPort),
      NODE_ENV: 'production',
      T8PC_PACKAGED: '1',
      T8PC_USER_DATA: USER_DATA,
      T8PC_FRONTEND_DIST: FRONTEND_DIST,
      T8PC_RES: ROOT,
      T8_FIGMA_BRIDGE_AUTOSTART: '0',
      TEMP: TEMP_ROOT,
      TMP: TEMP_ROOT,
    },
  });
  let chrome = null;
  let cdp = null;

  try {
    await waitForJson(`${baseUrl}/api/status`, (payload) => payload?.ok === true);
    const created = await requestJson(`${baseUrl}/api/canvas`, {
      method: 'POST',
      body: JSON.stringify({ name: 'E5 Workflow Doctor UI QA' }),
    });
    const canvasId = created.data.id;
    const seededGraph = {
      nodes: [
        {
          id: 'e5-ui-source',
          type: 'text',
          position: { x: 180, y: 260 },
          data: { text: 'E5 source', nodeSerialId: 1 },
        },
        {
          id: 'e5-ui-target',
          type: 'text',
          position: { x: 620, y: 260 },
          data: { text: 'E5 target', nodeSerialId: 2 },
        },
      ],
      edges: [
        { id: 'e5-ui-edge-primary', source: 'e5-ui-source', target: 'e5-ui-target' },
        { id: 'e5-ui-edge-duplicate', source: 'e5-ui-source', target: 'e5-ui-target' },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      nextNodeSerialId: 3,
      baseRevision: created.data.revision,
    };
    await requestJson(`${baseUrl}/api/canvas/${encodeURIComponent(canvasId)}?allowEmpty=1`, {
      method: 'PUT',
      body: JSON.stringify(seededGraph),
    });
    const before = (await requestJson(`${baseUrl}/api/canvas/${encodeURIComponent(canvasId)}`)).data;
    const beforeGraph = graphSnapshot(before);
    const beforeRevision = before.revision;

    const chromeExecutable = findChrome();
    chrome = launch(chromeExecutable, [
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
      baseUrl,
    ]);
    const targets = await waitForJson(
      `http://127.0.0.1:${debugPort}/json/list`,
      (items) => Array.isArray(items) && items.some((item) => item.type === 'page' && item.webSocketDebuggerUrl),
    );
    const page = targets.find((item) => item.type === 'page' && item.url.startsWith(baseUrl))
      || targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    assert.ok(page?.webSocketDebuggerUrl, '没有找到 Chrome 页面调试目标');

    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.connect();
    const browserErrors = [];
    cdp.onEvent((message) => {
      if (message.method === 'Runtime.exceptionThrown') {
        browserErrors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || 'runtime exception');
      }
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        browserErrors.push(message.params.entry.text || 'console error');
      }
    });
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('Log.enable'),
      cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1480,
        height: 920,
        deviceScaleFactor: 1,
        mobile: false,
      }),
    ]);

    await waitForEvaluation(cdp, `document.querySelectorAll('.react-flow__node').length === 2`);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.t8-workflow-doctor-node-marker').length`), 0);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.t8-workflow-doctor-port-highlight').length`), 0);

    const opened = await cdp.evaluate(`(() => {
      const button = document.querySelector('button[aria-label="项目工作台"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(opened, true, '无法打开项目工作台');
    await waitForEvaluation(cdp, `Boolean(document.querySelector('[data-project-workbench]'))`);
    await clickByText(cdp, '医生');
    await waitForEvaluation(cdp, `Boolean(document.querySelector('[data-testid="workflow-doctor"]'))`);
    const markerCounts = await waitForEvaluation(cdp, `(() => {
      const nodeMarkers = document.querySelectorAll('.t8-workflow-doctor-node-marker').length;
      const portMarkers = document.querySelectorAll('.t8-workflow-doctor-port-highlight').length;
      return nodeMarkers >= 2 && portMarkers >= 2 ? { nodeMarkers, portMarkers } : null;
    })()`);
    const markerStyles = await cdp.evaluate(`(() => {
      const marker = document.querySelector('.t8-workflow-doctor-node-marker');
      const port = document.querySelector('.t8-workflow-doctor-port-highlight');
      if (!marker || !port) return null;
      const markerStyle = getComputedStyle(marker);
      const portStyle = getComputedStyle(port);
      return {
        markerPointerEvents: markerStyle.pointerEvents,
        markerPosition: markerStyle.position,
        markerBorderStyle: markerStyle.borderStyle,
        portOutlineStyle: portStyle.outlineStyle,
      };
    })()`);
    assert.deepEqual(markerStyles, {
      markerPointerEvents: 'none',
      markerPosition: 'absolute',
      markerBorderStyle: 'solid',
      portOutlineStyle: 'solid',
    });
    const markedScreenshot = await captureScreenshot(cdp, 'doctor-markers-visible.png');

    await clickByText(cdp, '运行');
    await waitForEvaluation(cdp, `document.querySelectorAll('.t8-workflow-doctor-node-marker').length === 0
      && document.querySelectorAll('.t8-workflow-doctor-port-highlight').length === 0`);
    const clearedScreenshot = await captureScreenshot(cdp, 'doctor-markers-cleared.png');

    await clickByText(cdp, '医生');
    await waitForEvaluation(cdp, `document.querySelectorAll('.t8-workflow-doctor-node-marker').length >= 2`);
    const closed = await cdp.evaluate(`(() => {
      const button = document.querySelector('button[aria-label="关闭项目工作台"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(closed, true, '无法关闭项目工作台');
    await waitForEvaluation(cdp, `!document.querySelector('[data-project-workbench]')
      && document.querySelectorAll('.t8-workflow-doctor-node-marker').length === 0
      && document.querySelectorAll('.t8-workflow-doctor-port-highlight').length === 0`);

    const afterInteractions = (await requestJson(`${baseUrl}/api/canvas/${encodeURIComponent(canvasId)}`)).data;
    assert.equal(afterInteractions.revision, beforeRevision, '仅查看 Doctor 不应写入新 revision');
    assert.equal(graphSnapshot(afterInteractions), beforeGraph, 'Doctor 标记污染了持久画布文档');

    await cdp.send('Page.reload', { ignoreCache: true });
    await waitForEvaluation(cdp, `document.querySelectorAll('.react-flow__node').length === 2`);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.t8-workflow-doctor-node-marker').length`), 0);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.t8-workflow-doctor-port-highlight').length`), 0);
    const afterReload = (await requestJson(`${baseUrl}/api/canvas/${encodeURIComponent(canvasId)}`)).data;
    assert.equal(afterReload.revision, beforeRevision, '重开画布不应因 Doctor 标记增加 revision');
    assert.equal(graphSnapshot(afterReload), beforeGraph, '重开后持久画布与 Doctor 前不一致');

    await sleep(500);
    assert.deepEqual(browserErrors, [], `浏览器出现错误: ${browserErrors.join('\n')}`);

    const report = {
      schema: 't8-workflow-doctor-e5-ui-acceptance-v1',
      canvasId,
      viewport: { width: 1480, height: 920 },
      markerCounts,
      markerStyles,
      beforeRevision,
      afterRevision: afterReload.revision,
      graphUnchanged: true,
      markersClearedOnTabSwitch: true,
      markersClearedOnWorkbenchClose: true,
      markersAbsentAfterReload: true,
      browserErrors,
      screenshots: [markedScreenshot, clearedScreenshot],
    };
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const diagnostics = {
      error: error?.stack || String(error),
      backendLogs: backend.logs,
      chromeLogs: chrome?.logs || [],
    };
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'failure.json'), `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');
    throw error;
  } finally {
    cdp?.close();
    stopProcess(chrome?.child);
    stopProcess(backend.child);
  }
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
