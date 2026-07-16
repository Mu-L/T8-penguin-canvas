const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { WebSocket } = require('ws');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIST = path.join(ROOT, 'dist');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'collaboration-f1-ui');
const TEMP_ROOT = path.resolve(process.env.TEMP || process.env.TMP || path.join(ROOT, '.tmp'));
const RUN_ID = `${process.pid}-${Date.now()}`;
const QA_ROOT = path.join(TEMP_ROOT, `t8-collaboration-f1-ui-${RUN_ID}`);
const CHROME_PROFILE = path.join(QA_ROOT, 'chrome-profile');
const USER_DATA = path.join(QA_ROOT, 'user-data');
const TIMEOUT_MS = 45_000;
const PROJECT_ID = 'project-local';
const DISPLAY_NAME = 'F1 Viewer';
const SECOND_DISPLAY_NAME = 'F1 Viewer Two';

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function assertOwnedTemporaryPath(candidate) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(TEMP_ROOT, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝清理非 QA 临时目录: ${resolved}`);
  }
  return resolved;
}

function prepareQaDirectories() {
  const target = assertOwnedTemporaryPath(QA_ROOT);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(CHROME_PROFILE, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.rmSync(path.join(ARTIFACT_DIR, 'failure.json'), { force: true });
  fs.rmSync(path.join(ARTIFACT_DIR, 'failure.png'), { force: true });
}

function cleanupQaDirectory() {
  const target = assertOwnedTemporaryPath(QA_ROOT);
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) {
    // A killed browser can briefly retain profile handles. The unique path remains owned by this run.
  }
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

async function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function canConnect(host, port, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function boundedLog(lines, value) {
  const text = String(value || '').replace(/\r/g, '');
  for (const line of text.split('\n')) {
    if (!line) continue;
    lines.push(line.slice(0, 1_000));
    if (lines.length > 300) lines.shift();
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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_) {
    payload = text;
  }
  return { response, payload, text };
}

async function requestJson(url, options = {}) {
  const result = await fetchJson(url, options);
  if (!result.response.ok || result.payload?.success === false) {
    throw new Error(`${options.method || 'GET'} ${url} 失败: HTTP ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  return result.payload;
}

async function waitForJson(url, predicate = () => true, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await fetchJson(url);
      if (result.response.ok && predicate(result.payload)) return result.payload;
      lastError = new Error(`${url} 返回 HTTP ${result.response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw lastError || new Error(`等待 ${url} 超时`);
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
  throw new Error(`等待页面条件超时: ${expression.slice(0, 180)}，最后结果=${JSON.stringify(lastValue)}`);
}

async function clickButton(cdp, options) {
  const text = options.text == null ? null : JSON.stringify(options.text);
  const title = options.title == null ? null : JSON.stringify(options.title);
  const testId = options.testId == null ? null : JSON.stringify(options.testId);
  const articleText = options.articleText == null ? null : JSON.stringify(options.articleText);
  const clicked = await cdp.evaluate(`(() => {
    const root = ${testId} ? document.querySelector('[data-testid="' + ${testId} + '"]') : document;
    if (!root) return false;
    const scope = ${articleText}
      ? [...root.querySelectorAll('article')].find((article) => article.textContent.includes(${articleText}))
      : root;
    if (!scope) return false;
    const target = [...scope.querySelectorAll('button')].find((button) => {
      if (${text} && button.textContent.trim() !== ${text}) return false;
      if (${title} && button.getAttribute('title') !== ${title}) return false;
      return true;
    });
    if (!target || target.disabled) return false;
    target.click();
    return true;
  })()`);
  assert.equal(
    clicked,
    true,
    `未找到可点击按钮: ${options.text || options.title || '(unknown)'}${options.articleText ? ` / ${options.articleText}` : ''}`,
  );
}

async function setLabeledControl(cdp, testId, labelText, value) {
  const result = await cdp.evaluate(`(() => {
    const root = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
    if (!root) return null;
    const label = [...root.querySelectorAll('label')]
      .find((entry) => entry.textContent.trim().startsWith(${JSON.stringify(labelText)}));
    const control = label?.querySelector('select, input');
    if (!control || control.disabled) return null;
    const prototype = control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(control, ${JSON.stringify(String(value))});
    else control.value = ${JSON.stringify(String(value))};
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
    return control.value;
  })()`);
  assert.equal(String(result), String(value), `无法设置 ${labelText}=${value}`);
}

async function setMemberRole(cdp, displayName, role) {
  const result = await cdp.evaluate(`(() => {
    const root = document.querySelector('[data-testid="collaboration-member-management"]');
    const article = [...(root?.querySelectorAll('article') || [])]
      .find((entry) => entry.textContent.includes(${JSON.stringify(displayName)}));
    const control = article?.querySelector('select');
    if (!control || control.disabled) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter.call(control, ${JSON.stringify(role)});
    control.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(result, true, `无法把 ${displayName} 的角色改为 ${role}`);
}

async function refreshHostPanel(cdp) {
  await clickButton(cdp, { title: '刷新协作状态' });
  await sleep(120);
  await waitForEvaluation(cdp, `(() => {
    const button = document.querySelector('button[title="刷新协作状态"]');
    return Boolean(button && !button.disabled);
  })()`);
  await sleep(200);
}

async function captureScreenshot(cdp, filename, scrollSelector = null) {
  if (scrollSelector) {
    await cdp.evaluate(`(() => {
      const target = document.querySelector(${JSON.stringify(scrollSelector)});
      if (!target) return false;
      target.scrollIntoView({ block: 'start' });
      return true;
    })()`);
    await sleep(100);
  }
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  const target = path.join(ARTIFACT_DIR, filename);
  fs.writeFileSync(target, Buffer.from(result.data, 'base64'));
  return target;
}

function isPrivateIpv4(address) {
  const value = String(address || '');
  if (/^10\./.test(value) || /^192\.168\./.test(value)) return true;
  const parts = value.split('.').map(Number);
  return parts.length === 4 && (
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
  );
}

function cookieFromResponse(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')];
  const value = values.find(Boolean);
  return String(value || '').split(';')[0];
}

async function redeemInvite(inviteUrl, displayName, canvasId) {
  const invite = new URL(inviteUrl);
  const code = invite.searchParams.get('invite');
  assert.ok(code, '邀请 URL 缺少 invite 参数');
  assert.equal(invite.searchParams.get('canvas'), canvasId, '邀请 URL 未绑定当前画布');
  const gatewayOrigin = invite.origin;
  const result = await fetchJson(`${gatewayOrigin}/api/collab/invites/redeem`, {
    method: 'POST',
    body: JSON.stringify({ code, displayName, canvasId }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const cookie = cookieFromResponse(result.response);
  assert.match(cookie, /^t8_collab_session=.{24,}$/);
  return {
    gatewayOrigin,
    cookie,
    inviteCode: code,
    redemption: result.payload.data,
  };
}

function socketMessagePromise(socket, predicate, timeoutMs, message) {
  return withTimeout(new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      let payload = null;
      try {
        payload = JSON.parse(String(raw));
      } catch (_) {
        return;
      }
      if (!predicate(payload)) return;
      cleanup();
      resolve(payload);
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`WebSocket 在等待消息时关闭: ${code} ${String(reason)}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    socket.on('message', onMessage);
    socket.once('close', onClose);
    socket.once('error', onError);
  }), timeoutMs, message);
}

async function openCollaborationSocket(gatewayOrigin, cookie, canvasId) {
  const socketUrl = gatewayOrigin.replace(/^http/, 'ws') + '/ws/collab';
  const socket = new WebSocket(socketUrl, {
    origin: gatewayOrigin,
    headers: { cookie },
  });
  const messages = [];
  socket.on('message', (raw) => {
    try {
      messages.push(JSON.parse(String(raw)));
    } catch (_) {
      // Ignore non-JSON frames; the gateway protocol is expected to remain JSON.
    }
  });
  const closed = new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: String(reason) }));
  });
  socket.on('error', () => {
    // Opening errors are handled below. Later forced disconnects are expected during host actions.
  });
  await withTimeout(new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  }), 5_000, '协作 WebSocket 建立超时');
  const joined = socketMessagePromise(
    socket,
    (message) => message?.type === 'canvas.joined' && message.canvasId === canvasId,
    5_000,
    '协作 WebSocket 加入画布超时',
  );
  socket.send(JSON.stringify({ type: 'canvas.join', canvasId }));
  const joinMessage = await joined;
  return { socket, closed, messages, joinMessage };
}

async function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  try {
    if (socket.readyState === WebSocket.OPEN) socket.close();
    else socket.terminate();
  } catch (_) {}
}

async function latestInviteUi(cdp, previousUrl = '') {
  return waitForEvaluation(cdp, `(() => {
    const root = document.querySelector('[data-testid="collaboration-invite-management"]');
    if (!root) return null;
    const input = [...root.querySelectorAll('input')].find((entry) => entry.readOnly && /^https?:/.test(entry.value));
    const qr = root.querySelector('img[alt="协作邀请二维码"]');
    if (!input || !qr || !qr.src.startsWith('data:image/png;base64,')) return null;
    if (${JSON.stringify(previousUrl)} && input.value === ${JSON.stringify(previousUrl)}) return null;
    return {
      url: input.value,
      qrDataUrlPrefix: qr.src.slice(0, 32),
      qrDataUrlLength: qr.src.length,
    };
  })()`);
}

async function waitForMemberOnline(cdp, displayName) {
  return waitForEvaluation(cdp, `(() => {
    const memberRoot = document.querySelector('[data-testid="collaboration-member-management"]');
    const sessionRoot = document.querySelector('[data-testid="collaboration-session-management"]');
    const member = [...(memberRoot?.querySelectorAll('article') || [])]
      .find((entry) => entry.textContent.includes(${JSON.stringify(displayName)}));
    const session = [...(sessionRoot?.querySelectorAll('article') || [])]
      .find((entry) => entry.textContent.includes(${JSON.stringify(displayName)}));
    if (!member || !session) return null;
    if (!member.textContent.includes('1 连接') || !session.textContent.includes('1 条在线连接')) return null;
    return { memberText: member.textContent.trim(), sessionText: session.textContent.trim() };
  })()`);
}

async function run() {
  assert.equal(fs.existsSync(path.join(FRONTEND_DIST, 'index.html')), true, '缺少 dist/index.html，请先执行 npm run build');
  assert.equal(fs.existsSync(ELECTRON), true, '缺少项目锁定的 Electron 可执行文件');
  prepareQaDirectories();

  const backendPort = await findFreePort('127.0.0.1');
  const debugPort = await findFreePort('127.0.0.1');
  const collaborationPort = await findFreePort('0.0.0.0');
  const baseUrl = `http://127.0.0.1:${backendPort}`;
  const backend = launch(ELECTRON, [path.join(ROOT, 'backend', 'src', 'server.js')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOST: '127.0.0.1',
      PORT: String(backendPort),
      NODE_ENV: 'production',
      T8PC_PACKAGED: '1',
      T8PC_USER_DATA: USER_DATA,
      T8PC_FRONTEND_DIST: FRONTEND_DIST,
      T8PC_RES: ROOT,
      T8_FIGMA_BRIDGE_AUTOSTART: '0',
      TEMP: QA_ROOT,
      TMP: QA_ROOT,
    },
  });
  let chrome = null;
  let cdp = null;
  let primarySocket = null;
  let secondSocket = null;

  try {
    await waitForJson(`${baseUrl}/api/status`, (payload) => payload?.ok === true);
    const created = await requestJson(`${baseUrl}/api/canvas`, {
      method: 'POST',
      body: JSON.stringify({ name: 'F1 Collaboration Host UI QA' }),
    });
    const canvasId = created.data.id;

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

    await waitForEvaluation(cdp, `Boolean(document.querySelector('button[aria-label="项目工作台"]'))`);
    const opened = await cdp.evaluate(`(() => {
      const button = document.querySelector('button[aria-label="项目工作台"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(opened, true, '无法打开项目工作台');
    await waitForEvaluation(cdp, `Boolean(document.querySelector('[data-project-workbench]'))`);
    await clickButton(cdp, { text: '协作' });
    await waitForEvaluation(cdp, `(() => {
      const panel = document.querySelector('[data-testid="collaboration-host-panel"]');
      return panel?.dataset.canvasId === ${JSON.stringify(canvasId)};
    })()`);

    const managementStatusUrl = `${baseUrl}/api/collaboration/status?projectId=${encodeURIComponent(PROJECT_ID)}&canvasId=${encodeURIComponent(canvasId)}`;
    const initialManagement = await waitForJson(
      managementStatusUrl,
      (payload) => Array.isArray(payload?.data?.networkInterfaces)
        && payload.data.networkInterfaces.some((entry) => entry.address === '127.0.0.1'),
    );
    const preferredInterface = initialManagement.data.networkInterfaces.find((entry) => (
      entry.scope === 'private' && isPrivateIpv4(entry.address)
    )) || initialManagement.data.networkInterfaces.find((entry) => entry.address === '127.0.0.1');
    assert.ok(preferredInterface, '管理状态既没有私网 IPv4，也没有回环地址');
    const hostOptions = await waitForEvaluation(cdp, `(() => {
      const root = document.querySelector('[data-testid="collaboration-gateway-settings"]');
      const select = root?.querySelector('select');
      if (!select || ![...select.options].some((option) => option.value === ${JSON.stringify(preferredInterface.address)})) {
        return null;
      }
      return [...select.options].map((option) => ({
        value: option.value,
        label: option.textContent.trim(),
      }));
    })()`);
    const selected = hostOptions.find((option) => option.value === preferredInterface.address);
    assert.ok(selected, '监听网卡列表既没有私网 IPv4，也没有回环地址');
    const usedLoopbackFallback = !isPrivateIpv4(selected.value);
    await setLabeledControl(cdp, 'collaboration-gateway-settings', '监听网卡', selected.value);
    await setLabeledControl(cdp, 'collaboration-gateway-settings', '端口', collaborationPort);
    await clickButton(cdp, { text: '启动网关', testId: 'collaboration-gateway-settings' });

    const runningManagement = await waitForJson(
      managementStatusUrl,
      (payload) => payload?.data?.running === true && payload.data.port === collaborationPort,
    );
    await waitForEvaluation(cdp, `(() => {
      const panel = document.querySelector('[data-testid="collaboration-host-panel"]');
      return panel?.textContent.includes('已运行')
        && panel?.textContent.includes('私有后端暴露：否')
        && [...panel.querySelectorAll('button')].some((button) => button.textContent.trim() === '应用监听设置');
    })()`);
    assert.equal(runningManagement.data.privateBackendExposed, false);
    assert.equal(runningManagement.data.host, selected.value);
    assert.equal(await canConnect(selected.value, collaborationPort), true);

    const shareBaseUrl = await waitForEvaluation(cdp, `(() => {
      const select = document.querySelector('[data-testid="collaboration-share-address"] select');
      return select?.value || null;
    })()`);
    const parsedShareUrl = new URL(shareBaseUrl);
    assert.equal(parsedShareUrl.hostname, selected.value);
    assert.equal(Number(parsedShareUrl.port), collaborationPort);
    assert.equal(parsedShareUrl.pathname, '/collab');
    const publicStatus = await requestJson(`${parsedShareUrl.origin}/api/collab/status`);
    assert.equal(publicStatus.data.privateBackendExposed, false);
    assert.equal(Object.hasOwn(publicStatus.data, 'host'), false);
    assert.equal(Object.hasOwn(publicStatus.data, 'port'), false);

    const resourceScopeNeedsConfirmation = await cdp.evaluate(
      `Boolean(document.querySelector('[data-testid="collaboration-resource-scope-confirmation"]'))`,
    );
    if (resourceScopeNeedsConfirmation) {
      await clickButton(cdp, {
        text: '检查说明并初始化资源范围',
        testId: 'collaboration-resource-scope-confirmation',
      });
      await waitForEvaluation(cdp, `(() => {
        const button = document.querySelector('[data-testid="collaboration-resource-scope-confirmation"] button');
        return button?.textContent.trim() === '再次确认当前资源范围';
      })()`);
      await clickButton(cdp, {
        text: '再次确认当前资源范围',
        testId: 'collaboration-resource-scope-confirmation',
      });
      await waitForEvaluation(
        cdp,
        `!document.querySelector('[data-testid="collaboration-resource-scope-confirmation"]')`,
      );
    }

    await setLabeledControl(cdp, 'collaboration-invite-management', '角色', 'viewer');
    await setLabeledControl(cdp, 'collaboration-invite-management', '最大使用次数', '5');
    await clickButton(cdp, {
      text: '生成邀请、复制链接与二维码',
      testId: 'collaboration-invite-management',
    });
    const firstInviteUi = await latestInviteUi(cdp);
    const firstInvite = new URL(firstInviteUi.url);
    assert.equal(firstInvite.origin, parsedShareUrl.origin);
    assert.equal(firstInvite.pathname, '/collab');
    assert.equal(firstInvite.searchParams.get('canvas'), canvasId);
    assert.ok(firstInvite.searchParams.get('invite'));
    assert.ok(firstInviteUi.qrDataUrlLength > 100, '本地二维码 data URL 过短');
    const inviteScreenshot = await captureScreenshot(
      cdp,
      'invite-and-local-qr.png',
      '[data-testid="collaboration-invite-management"]',
    );

    const actor = await redeemInvite(firstInviteUi.url, DISPLAY_NAME, canvasId);
    assert.equal(actor.redemption.role, 'viewer');
    assert.deepEqual(actor.redemption.capabilities, []);
    const viewerSession = await fetchJson(`${actor.gatewayOrigin}/api/collab/session`, {
      headers: { cookie: actor.cookie },
    });
    assert.equal(viewerSession.response.status, 200);
    assert.equal(viewerSession.payload.data.role, 'viewer');
    const viewerRead = await fetchJson(`${actor.gatewayOrigin}/api/collab/canvases/${encodeURIComponent(canvasId)}`, {
      headers: { cookie: actor.cookie },
    });
    assert.equal(viewerRead.response.status, 200, JSON.stringify(viewerRead.payload));
    const viewerWrite = await fetchJson(`${actor.gatewayOrigin}/api/collab/canvases/${encodeURIComponent(canvasId)}/operations`, {
      method: 'POST',
      headers: { cookie: actor.cookie },
      body: JSON.stringify({
        baseRevision: viewerRead.payload.data.revision,
        operations: [],
      }),
    });
    assert.equal(viewerWrite.response.status, 403, JSON.stringify(viewerWrite.payload));
    assert.match(String(viewerWrite.payload?.error || ''), /editGraph/);

    primarySocket = await openCollaborationSocket(actor.gatewayOrigin, actor.cookie, canvasId);
    assert.equal(primarySocket.joinMessage.revision, viewerRead.payload.data.revision);
    await refreshHostPanel(cdp);
    const onlineMember = await waitForMemberOnline(cdp, DISPLAY_NAME);
    const memberScreenshot = await captureScreenshot(
      cdp,
      'member-and-session-online.png',
      '[data-testid="collaboration-member-management"]',
    );

    const primaryRoleClosePromise = primarySocket.closed;
    await setMemberRole(cdp, DISPLAY_NAME, 'reviewer');
    await waitForEvaluation(cdp, `(() => {
      const root = document.querySelector('[data-testid="collaboration-host-panel"]');
      const member = [...(document.querySelectorAll('[data-testid="collaboration-member-management"] article'))]
        .find((entry) => entry.textContent.includes(${JSON.stringify(DISPLAY_NAME)}));
      return root?.textContent.includes('已改为审阅者')
        && member?.querySelector('select')?.value === 'reviewer';
    })()`);
    const roleClose = await withTimeout(primaryRoleClosePromise, 5_000, '角色变更未刷新在线 WebSocket');
    assert.equal(roleClose.code, 4002);
    const reviewerSession = await fetchJson(`${actor.gatewayOrigin}/api/collab/session`, {
      headers: { cookie: actor.cookie },
    });
    assert.equal(reviewerSession.response.status, 200);
    assert.equal(reviewerSession.payload.data.role, 'reviewer');
    assert.equal(reviewerSession.payload.data.capabilities.includes('editGraph'), false);
    primarySocket = await openCollaborationSocket(actor.gatewayOrigin, actor.cookie, canvasId);
    await refreshHostPanel(cdp);
    await waitForMemberOnline(cdp, DISPLAY_NAME);

    await clickButton(cdp, {
      title: '撤销邀请',
      testId: 'collaboration-invite-management',
    });
    await waitForEvaluation(cdp, `(() => {
      const panel = document.querySelector('[data-testid="collaboration-host-panel"]');
      const inviteRoot = document.querySelector('[data-testid="collaboration-invite-management"]');
      return panel?.textContent.includes('邀请已撤销') && inviteRoot?.textContent.includes('已撤销');
    })()`);

    const primaryRevokeClosePromise = primarySocket.closed;
    await clickButton(cdp, {
      text: '撤销',
      testId: 'collaboration-session-management',
      articleText: DISPLAY_NAME,
    });
    await waitForEvaluation(cdp, `(() => {
      const root = document.querySelector('[data-testid="collaboration-session-management"]');
      const article = [...(root?.querySelectorAll('article') || [])]
        .find((entry) => entry.textContent.includes(${JSON.stringify(DISPLAY_NAME)}));
      return [...(article?.querySelectorAll('button') || [])]
        .some((button) => button.textContent.trim() === '再次确认');
    })()`);
    await clickButton(cdp, {
      text: '再次确认',
      testId: 'collaboration-session-management',
      articleText: DISPLAY_NAME,
    });
    const sessionRevokeClose = await withTimeout(primaryRevokeClosePromise, 5_000, '单会话撤销未断开 WebSocket');
    assert.equal(sessionRevokeClose.code, 4001);
    await waitForEvaluation(cdp, `(() => {
      const panel = document.querySelector('[data-testid="collaboration-host-panel"]');
      return panel?.textContent.includes('会话已撤销');
    })()`);
    const revokedPrimarySession = await fetchJson(`${actor.gatewayOrigin}/api/collab/session`, {
      headers: { cookie: actor.cookie },
    });
    assert.equal(revokedPrimarySession.response.status, 401);

    await setLabeledControl(cdp, 'collaboration-invite-management', '角色', 'viewer');
    await clickButton(cdp, {
      text: '生成邀请、复制链接与二维码',
      testId: 'collaboration-invite-management',
    });
    const secondInviteUi = await latestInviteUi(cdp, firstInviteUi.url);
    const secondActor = await redeemInvite(secondInviteUi.url, SECOND_DISPLAY_NAME, canvasId);
    assert.equal(secondActor.redemption.role, 'viewer');
    secondSocket = await openCollaborationSocket(secondActor.gatewayOrigin, secondActor.cookie, canvasId);
    await refreshHostPanel(cdp);
    await waitForMemberOnline(cdp, SECOND_DISPLAY_NAME);

    const revokeAllClosePromise = secondSocket.closed;
    await clickButton(cdp, {
      text: '断开全部会话',
      testId: 'collaboration-session-management',
    });
    await waitForEvaluation(cdp, `(() => {
      const root = document.querySelector('[data-testid="collaboration-session-management"]');
      return [...(root?.querySelectorAll('button') || [])]
        .some((button) => button.textContent.trim() === '再次确认全部断开');
    })()`);
    await clickButton(cdp, {
      text: '再次确认全部断开',
      testId: 'collaboration-session-management',
    });
    const revokeAllClose = await withTimeout(revokeAllClosePromise, 5_000, '全部会话撤销未断开 WebSocket');
    assert.equal(revokeAllClose.code, 4001);
    const noActiveSessions = await waitForJson(
      managementStatusUrl,
      (payload) => payload?.data?.room?.activeSessionCount === 0 && payload.data.room.connectionCount === 0,
    );
    assert.equal(noActiveSessions.data.room.activeSessionCount, 0);
    const revokedSecondSession = await fetchJson(`${secondActor.gatewayOrigin}/api/collab/session`, {
      headers: { cookie: secondActor.cookie },
    });
    assert.equal(revokedSecondSession.response.status, 401);
    const revokedScreenshot = await captureScreenshot(
      cdp,
      'all-sessions-revoked.png',
      '[data-testid="collaboration-session-management"]',
    );

    await clickButton(cdp, {
      text: '停止网关',
      testId: 'collaboration-gateway-settings',
    });
    await waitForEvaluation(cdp, `(() => {
      const root = document.querySelector('[data-testid="collaboration-gateway-settings"]');
      return [...(root?.querySelectorAll('button') || [])]
        .some((button) => button.textContent.trim() === '再次确认停止');
    })()`);
    await clickButton(cdp, {
      text: '再次确认停止',
      testId: 'collaboration-gateway-settings',
    });
    const stoppedManagement = await waitForJson(
      managementStatusUrl,
      (payload) => payload?.data?.running === false,
    );
    await waitForEvaluation(cdp, `(() => {
      const panel = document.querySelector('[data-testid="collaboration-host-panel"]');
      return panel?.textContent.includes('未启动')
        && panel?.textContent.includes('监听端口已经关闭');
    })()`);
    assert.equal(stoppedManagement.data.host, null);
    assert.equal(stoppedManagement.data.port, null);
    assert.equal(await canConnect(selected.value, collaborationPort), false);
    const stoppedScreenshot = await captureScreenshot(
      cdp,
      'gateway-stopped.png',
      '[data-testid="collaboration-gateway-settings"]',
    );

    await sleep(500);
    assert.deepEqual(browserErrors, [], `浏览器出现错误: ${browserErrors.join('\n')}`);

    const report = {
      schema: 't8-collaboration-f1-ui-acceptance-v1',
      canvasId,
      projectId: PROJECT_ID,
      viewport: { width: 1480, height: 920 },
      backendRuntime: {
        executable: ELECTRON,
        electronRunAsNode: true,
        isolatedUserData: USER_DATA,
      },
      gateway: {
        selectedHost: selected.value,
        selectedInterfaceLabel: selected.label,
        usedLoopbackFallback,
        port: collaborationPort,
        shareBaseUrl,
        privateBackendExposed: publicStatus.data.privateBackendExposed,
        stopped: stoppedManagement.data.running === false,
        portClosed: true,
      },
      invite: {
        urlOrigin: firstInvite.origin,
        urlPath: firstInvite.pathname,
        queryParameters: [...firstInvite.searchParams.keys()].sort(),
        inviteCodeLength: firstInvite.searchParams.get('invite').length,
        inviteCodeSha256: crypto.createHash('sha256').update(firstInvite.searchParams.get('invite')).digest('hex'),
        projectCanvasBound: true,
        localQrDataUrl: firstInviteUi.qrDataUrlPrefix.startsWith('data:image/png;base64,'),
        firstInviteRevoked: true,
      },
      viewerAuthority: {
        sessionStatus: viewerSession.response.status,
        readStatus: viewerRead.response.status,
        writeStatus: viewerWrite.response.status,
      },
      memberAndSession: {
        initialOnlineEvidence: onlineMember,
        roleChangedTo: reviewerSession.payload.data.role,
        roleChangeSocketClose: roleClose,
        roleChangeReconnected: true,
        singleSessionSocketClose: sessionRevokeClose,
        singleSessionRevoked: revokedPrimarySession.response.status === 401,
        revokeAllSocketClose: revokeAllClose,
        allSessionsRevoked: revokedSecondSession.response.status === 401,
      },
      browserErrors,
      screenshots: [
        inviteScreenshot,
        memberScreenshot,
        revokedScreenshot,
        stoppedScreenshot,
      ],
    };
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    let failureScreenshot = null;
    if (cdp) {
      try {
        failureScreenshot = await captureScreenshot(cdp, 'failure.png');
      } catch (_) {
        failureScreenshot = null;
      }
    }
    const diagnostics = {
      error: error?.stack || String(error),
      failureScreenshot,
      backendLogs: backend.logs,
      chromeLogs: chrome?.logs || [],
    };
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'failure.json'), `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');
    throw error;
  } finally {
    await closeSocket(primarySocket?.socket);
    await closeSocket(secondSocket?.socket);
    cdp?.close();
    stopProcess(chrome?.child);
    stopProcess(backend.child);
    await sleep(100);
    cleanupQaDirectory();
  }
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
