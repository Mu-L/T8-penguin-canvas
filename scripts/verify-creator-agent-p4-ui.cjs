const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEMP_ROOT = path.resolve(process.env.TEMP || process.env.TMP || path.join(ROOT, '.tmp'));
const QA_ROOT = path.join(TEMP_ROOT, 't8-creator-agent-p4-ui');
const CHROME_PROFILE = path.join(QA_ROOT, 'chrome-profile');
const USER_DATA = path.join(QA_ROOT, 'user-data');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'creator-agent-p4-ui');
const ELECTRON = require('electron');
const TIMEOUT_MS = 120_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
  const qaRoot = assertInside(TEMP_ROOT, QA_ROOT, 'QA 临时');
  const artifactDir = assertInside(path.join(ROOT, 'artifacts'), ARTIFACT_DIR, 'QA 证据');
  fs.rmSync(qaRoot, { recursive: true, force: true });
  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.mkdirSync(CHROME_PROFILE, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function readDevelopmentAuthorityToken() {
  const authorityPath = path.join(ROOT, '.t8-collaboration-management-authority.json');
  const record = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
  assert.equal(
    record?.schema,
    't8-collaboration-management-authority-v1',
    '开发协作 authority 文件 schema 不匹配',
  );
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

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => {
      reject(new Error(`Creator Agent QA 需要空闲端口 ${port}: ${error.message}`));
    });
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
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
    await sleep(160);
  }
  throw lastError || new Error(`等待 ${url} 超时`);
}

async function waitForHtml(url, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const text = response.ok ? await response.text() : '';
      if (response.ok && text.includes('<div id="root"')) return text;
      lastError = new Error(`${url} 尚未返回 Vite 页面`);
    } catch (error) {
      lastError = error;
    }
    await sleep(160);
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
    await sleep(140);
  }
  throw new Error(`等待页面条件超时: ${expression.slice(0, 180)}，最后结果=${JSON.stringify(lastValue)}`);
}

async function pressKey(cdp, key, options = {}) {
  const keyCode = {
    Tab: 9,
    Enter: 13,
    Escape: 27,
    ArrowLeft: 37,
    ArrowRight: 39,
  }[key] || 0;
  const modifiers = options.shiftKey ? 8 : 0;
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code: key,
    modifiers,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: key,
    modifiers,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
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

function rectsOverlap(first, second) {
  if (!first || !second) return false;
  return !(
    first.right <= second.left
    || first.left >= second.right
    || first.bottom <= second.top
    || first.top >= second.bottom
  );
}

function graphSnapshot(document) {
  return JSON.stringify({
    nodes: document.nodes,
    edges: document.edges,
    viewport: document.viewport,
    nextNodeSerialId: document.nextNodeSerialId,
  });
}

function nearestRankP95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] || 0;
}

async function focusLauncherAndOpen(cdp) {
  const focused = await cdp.evaluate(`(() => {
    const button = document.querySelector('button[data-canvas-floating-ui="creator-agent-launcher"]');
    if (!button) return false;
    const startedAt = performance.now();
    window.__t8CreatorShellReady = new Promise((resolve) => {
      let observer = null;
      const finish = () => {
        const panel = document.querySelector('[data-canvas-floating-ui="creator-agent-panel"]');
        if (!panel) return false;
        observer?.disconnect();
        requestAnimationFrame(() => resolve({
          elapsedMs: performance.now() - startedAt,
          schema: panel.dataset.shellReadinessSchema || '',
          commitMs: Number(panel.dataset.shellCommitMs || 0),
          paintReadyMs: Number(panel.dataset.shellPaintReadyMs || 0),
          targetMs: Number(panel.dataset.shellTargetMs || 0),
          status: panel.dataset.shellReadinessStatus || '',
        }));
        return true;
      };
      observer = new MutationObserver(finish);
      observer.observe(document.body, { childList: true, subtree: true });
      finish();
    });
    button.focus();
    return document.activeElement === button;
  })()`);
  assert.equal(focused, true, 'Creator Agent 启动按钮无法取得键盘焦点');
  await pressKey(cdp, 'Enter');
  const readiness = await cdp.evaluate('window.__t8CreatorShellReady');
  assert.equal(readiness.schema, 't8-creator-agent-shell-readiness-receipt-v1');
  assert.equal(readiness.targetMs, 300);
  assert.equal(readiness.status, 'within-target');
  assert.ok(readiness.elapsedMs <= 300, `Creator Agent 面板壳显示耗时超标: ${readiness.elapsedMs}ms`);
  assert.ok(readiness.commitMs <= 300, `Creator Agent 面板壳提交耗时超标: ${readiness.commitMs}ms`);
  assert.ok(readiness.paintReadyMs <= 300, `Creator Agent 面板壳绘制准备耗时超标: ${readiness.paintReadyMs}ms`);
  return readiness;
}

async function readAgentLayout(cdp) {
  return cdp.evaluate(`(() => {
    const launcher = document.querySelector('[data-canvas-floating-ui="creator-agent-launcher"]');
    const panel = document.querySelector('[data-canvas-floating-ui="creator-agent-panel"]');
    const minimap = document.querySelector('.react-flow__minimap');
    if (!launcher || !panel || !minimap) return null;
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    const panelStyle = getComputedStyle(panel);
    const launcherStyle = getComputedStyle(launcher);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      launcher: rect(launcher),
      panel: rect(panel),
      minimap: rect(minimap),
      themeVisual: panel.getAttribute('data-theme-visual'),
      themeMode: panel.getAttribute('data-theme-mode'),
      panelColor: panelStyle.color,
      panelBackground: panelStyle.backgroundColor,
      launcherBackground: launcherStyle.backgroundImage,
      suggestionCount: document.querySelectorAll('.t8-creator-agent-suggestions button').length,
      emptyStateTitle: document.querySelector('.t8-creator-agent-empty h2')?.textContent?.trim() || '',
      panelLabel: panel.getAttribute('aria-label'),
      launcherExpanded: launcher.getAttribute('aria-expanded'),
      launcherControls: launcher.getAttribute('aria-controls'),
    };
  })()`);
}

async function assertLayout(cdp, expectedTheme) {
  const layout = await waitForEvaluation(cdp, `(() => {
    const panel = document.querySelector('[data-canvas-floating-ui="creator-agent-panel"]');
    const minimap = document.querySelector('.react-flow__minimap');
    return panel && minimap ? true : false;
  })()`).then(() => readAgentLayout(cdp));
  assert.ok(layout, 'Creator Agent 或右侧地图未渲染');
  assert.equal(layout.themeVisual, expectedTheme.visual);
  assert.equal(layout.themeMode, expectedTheme.mode);
  assert.equal(layout.panelLabel, '贞贞创作 Agent');
  assert.equal(layout.launcherExpanded, 'true');
  assert.equal(layout.launcherControls, 't8-creator-agent-panel');
  assert.ok(layout.panel.width >= 420 && layout.panel.width <= 560, `面板宽度异常: ${layout.panel.width}`);
  assert.ok(layout.panel.left >= 0 && layout.panel.right <= layout.viewport.width, '面板超出水平视口');
  assert.ok(layout.panel.top >= 0 && layout.panel.bottom <= layout.viewport.height, '面板超出垂直视口');
  assert.equal(rectsOverlap(layout.launcher, layout.minimap), false, 'Creator Agent 启动按钮遮挡了右侧地图');
  assert.notEqual(layout.panelColor, 'rgba(0, 0, 0, 0)');
  assert.ok(layout.launcherBackground.includes('gradient'), '启动按钮没有应用主题渐变');
  return layout;
}

async function setThemeAndReload(cdp, theme) {
  await cdp.evaluate(`localStorage.setItem('t8-canvas-theme', ${JSON.stringify(JSON.stringify({
    state: {
      theme: theme.mode,
      style: theme.style,
      templateId: theme.templateId,
      uiFontPreset: 'system',
      customUiFont: '',
    },
    version: 0,
  }))}); true`);
  const previousTimeOrigin = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitForEvaluation(cdp, `(() => {
    const launcher = document.querySelector('[data-canvas-floating-ui="creator-agent-launcher"]');
    return performance.timeOrigin !== ${Number(previousTimeOrigin)}
      && launcher?.getAttribute('data-theme-mode') === ${JSON.stringify(theme.mode)}
      && launcher?.getAttribute('data-theme-visual') === ${JSON.stringify(theme.style)};
  })()`);
  await focusLauncherAndOpen(cdp);
}

async function run() {
  assert.equal(fs.existsSync(ELECTRON), true, '缺少项目锁定的 Electron 可执行文件');
  const backendPort = await findFreePort();
  let frontendPort = await findFreePort();
  while (frontendPort === backendPort) {
    frontendPort = await findFreePort();
  }
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const frontendUrl = `http://127.0.0.1:${frontendPort}/`;
  await assertPortAvailable(backendPort);
  await assertPortAvailable(frontendPort);
  resetQaDirectories();

  const debugPort = await findFreePort();
  const authorityToken = readDevelopmentAuthorityToken();
  const backend = launch(ELECTRON, [path.join(ROOT, 'backend', 'src', 'server.js')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOST: '127.0.0.1',
      PORT: String(backendPort),
      NODE_ENV: 'development',
      T8PC_PACKAGED: '0',
      T8PC_DEV_DATA_ROOT: USER_DATA,
      T8PC_FRONTEND_DIST: path.join(QA_ROOT, 'unused-frontend'),
      T8PC_RES: ROOT,
      T8PC_DEV_PROJECT_DB_STORAGE_PROFILE: 'acceptance-small-v1',
      T8_COLLAB_MANAGEMENT_TOKEN: authorityToken,
      T8_FIGMA_BRIDGE_AUTOSTART: '0',
      TEMP: TEMP_ROOT,
      TMP: TEMP_ROOT,
    },
  });
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
      T8PC_DEV_BACKEND_ORIGIN: backendUrl,
      T8_FIGMA_BRIDGE_AUTOSTART: '0',
      TEMP: TEMP_ROOT,
      TMP: TEMP_ROOT,
    },
  });
  let chrome = null;
  let cdp = null;

  try {
    await waitForJson(`${backendUrl}/api/status`, (payload) => payload?.ok === true);
    await waitForHtml(frontendUrl);
    const created = await requestJson(`${backendUrl}/api/canvas`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Creator Agent P4 UI QA' }),
    });
    const canvasId = created.data.id;
    const projectId = 'project-local';
    const before = (await requestJson(`${backendUrl}/api/canvas/${encodeURIComponent(canvasId)}`)).data;
    const beforeRevision = before.revision;
    const beforeGraph = graphSnapshot(before);

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
      'about:blank',
    ]);
    const targets = await waitForJson(
      `http://127.0.0.1:${debugPort}/json/list`,
      (items) => Array.isArray(items) && items.some((item) => item.type === 'page' && item.webSocketDebuggerUrl),
    );
    const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
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
      cdp.send('Network.enable'),
      cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1480,
        height: 920,
        deviceScaleFactor: 1,
        mobile: false,
      }),
    ]);
    await cdp.send('Page.bringToFront');
    await cdp.send('Page.navigate', { url: frontendUrl });
    await waitForEvaluation(cdp, `Boolean(document.querySelector('[data-canvas-floating-ui="creator-agent-launcher"]'))`);

    const initialShellReadiness = await focusLauncherAndOpen(cdp);
    await waitForEvaluation(cdp, `document.querySelectorAll('.t8-creator-agent-suggestions button').length === 3`);
    const initialLayout = await assertLayout(cdp, { visual: 'pixel', mode: 'light' });
    assert.equal(initialLayout.suggestionCount, 3);
    assert.equal(initialLayout.emptyStateTitle, '今天想把什么灵感做出来？');

    const capabilityContract = (await requestJson(
      `${backendUrl}/api/creator-agent/v1/capabilities`,
    )).data;
    const capabilityIds = new Set(
      capabilityContract.capabilities.map((capability) => capability.id),
    );
    const initialSuggestionAudit = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.t8-creator-agent-suggestions button')];
      const items = buttons.map((button) => ({
        id: button.getAttribute('data-suggestion-id') || '',
        intent: button.getAttribute('data-suggestion-intent') || '',
        executable: button.getAttribute('data-suggestion-executable') === 'true',
        disabled: button.disabled,
        requiredCapabilityIds: (button.getAttribute('data-required-capabilities') || '')
          .split(',').map((value) => value.trim()).filter(Boolean),
      }));
      return {
        count: items.length,
        uniqueIdCount: new Set(items.map((item) => item.id)).size,
        uniqueIntentCount: new Set(items.map((item) => item.intent)).size,
        missingIdentityCount: items.filter((item) => !item.id || !item.intent).length,
        fakeEnabledActionCount: items.filter((item) => (
          !item.disabled && (!item.executable || item.requiredCapabilityIds.length === 0)
        )).length,
        items,
      };
    })()`);
    assert.equal(initialSuggestionAudit.count, 3);
    assert.equal(initialSuggestionAudit.uniqueIdCount, 3);
    assert.equal(initialSuggestionAudit.uniqueIntentCount, 3);
    assert.equal(initialSuggestionAudit.missingIdentityCount, 0);
    assert.equal(initialSuggestionAudit.fakeEnabledActionCount, 0);
    const invalidInitialCapabilityIds = [...new Set(
      initialSuggestionAudit.items.flatMap((item) => item.requiredCapabilityIds),
    )].filter((capabilityId) => !capabilityIds.has(capabilityId));
    assert.deepEqual(invalidInitialCapabilityIds, []);


    const composerFocusedOnOpen = await waitForEvaluation(cdp, `(() => {
      const composer = document.querySelector('[data-creator-agent-composer="true"]');
      return composer && document.activeElement === composer;
    })()`);
    assert.equal(composerFocusedOnOpen, true, '打开 Creator Agent 后输入框没有取得焦点');

    const sessionKey = `t8-creator-agent-session-v1:${projectId}:${canvasId}`;
    const initialSessionId = await waitForEvaluation(cdp, `localStorage.getItem(${JSON.stringify(sessionKey)}) || ''`);
    const messageSubmitted = await cdp.evaluate(`(() => {
      const textarea = document.querySelector('.t8-creator-agent-composer textarea');
      if (!textarea) return false;
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '帮我设计一支15秒雨夜霓虹短片');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '片' }));
      return true;
    })()`);
    assert.equal(messageSubmitted, true, '一句话输入框尚未就绪');
    await waitForEvaluation(cdp, `(() => {
      const button = document.querySelector('.t8-creator-agent-composer button[aria-label="发送"]');
      return button && !button.disabled;
    })()`);
    await pressKey(cdp, 'Enter');
    await sleep(80);
    const imeCompositionEnterSuppressed = await cdp.evaluate(
      `document.querySelectorAll('.t8-creator-agent-message.is-user').length === 0`,
    );
    assert.equal(imeCompositionEnterSuppressed, true, '输入法候选阶段 Enter 误发送了消息');
    await cdp.evaluate(`(() => {
      const textarea = document.querySelector('[data-creator-agent-composer="true"]');
      if (!textarea) return false;
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '片' }));
      return true;
    })()`);
    await pressKey(cdp, 'Enter');
    await sleep(80);
    const imePostCompositionEnterSuppressed = await cdp.evaluate(
      `document.querySelectorAll('.t8-creator-agent-message.is-user').length === 0`,
    );
    assert.equal(imePostCompositionEnterSuppressed, true, '输入法候选刚结束后的 Enter 误发送了消息');
    await sleep(180);
    const planTimerArmed = await cdp.evaluate(`(() => {
      const existing = new Set([...document.querySelectorAll('[data-creator-agent-plan-id]')]
        .map((item) => item.getAttribute('data-creator-agent-plan-id')));
      const startedAt = performance.now();
      window.__t8CreatorPlanReady = new Promise((resolve) => {
        let observer = null;
        const finish = () => {
          const plan = [...document.querySelectorAll('[data-creator-agent-plan-id]')]
            .find((item) => !existing.has(item.getAttribute('data-creator-agent-plan-id')));
          if (!plan) return false;
          observer?.disconnect();
          requestAnimationFrame(() => resolve({
            elapsedMs: performance.now() - startedAt,
            planId: plan.getAttribute('data-creator-agent-plan-id') || '',
            schema: plan.getAttribute('data-readiness-schema') || '',
            localPlanMs: Number(plan.getAttribute('data-local-plan-ms') || 0),
            targetMs: Number(plan.getAttribute('data-local-plan-target-ms') || 0),
            withinTarget: plan.getAttribute('data-local-plan-within-target') === 'true',
            providerCalls: Number(plan.getAttribute('data-plan-provider-calls') || 0),
            canvasWrites: Number(plan.getAttribute('data-plan-canvas-writes') || 0),
            productionFileWrites: Number(plan.getAttribute('data-plan-production-file-writes') || 0),
          }));
          return true;
        };
        observer = new MutationObserver(finish);
        observer.observe(document.body, { childList: true, subtree: true });
        finish();
      });
      return true;
    })()`);
    assert.equal(planTimerArmed, true, '无法建立本地计划显示计时器');
    await pressKey(cdp, 'Enter');
    const firstPlanReadiness = await cdp.evaluate('window.__t8CreatorPlanReady');
    assert.equal(firstPlanReadiness.schema, 't8-creator-agent-local-readiness-receipt-v1');
    assert.equal(firstPlanReadiness.targetMs, 2000);
    assert.equal(firstPlanReadiness.withinTarget, true);
    assert.ok(firstPlanReadiness.elapsedMs <= 2000,
      `一句话到首份可编辑计划耗时超标: ${firstPlanReadiness.elapsedMs}ms`);
    assert.ok(firstPlanReadiness.localPlanMs <= 2000,
      `服务端本地计划耗时超标: ${firstPlanReadiness.localPlanMs}ms`);
    assert.deepEqual({
      providerCalls: firstPlanReadiness.providerCalls,
      canvasWrites: firstPlanReadiness.canvasWrites,
      productionFileWrites: firstPlanReadiness.productionFileWrites,
    }, {
      providerCalls: 0,
      canvasWrites: 0,
      productionFileWrites: 0,
    });
    await waitForEvaluation(cdp, `(() => {
      const user = [...document.querySelectorAll('.t8-creator-agent-message.is-user')]
        .some((item) => item.textContent.includes('帮我设计一支15秒雨夜霓虹短片'));
      const suggestions = document.querySelectorAll('.t8-creator-agent-suggestions button').length === 3;
      return user && suggestions;
    })()`);
    const completedReplyAccessibility = await waitForEvaluation(cdp, `(() => {
      const live = document.querySelector('[data-creator-agent-live-status="true"]');
      const log = document.querySelector('.t8-creator-agent-messages[role="log"]');
      if (!live?.textContent?.includes('回复完成') || !log) return null;
      return {
        announcement: live.textContent.trim(),
        logLive: log.getAttribute('aria-live'),
        logBusy: log.getAttribute('aria-busy'),
      };
    })()`);
    assert.equal(completedReplyAccessibility.logLive, 'off');
    assert.equal(completedReplyAccessibility.logBusy, 'false');
    const conversationScreenshot = await captureScreenshot(cdp, 'creator-agent-one-sentence.png');

    const firstCompletedSession = (await requestJson(
      `${backendUrl}/api/creator-agent/v1/sessions/${encodeURIComponent(initialSessionId)}?projectId=${encodeURIComponent(projectId)}&canvasId=${encodeURIComponent(canvasId)}`,
    )).data;
    const firstCompletedPlanId = String(firstCompletedSession.latestPlan?.planId || '');
    assert.ok(firstCompletedPlanId, '第一轮完成回复没有形成可核对的计划');
    const completedEvents = firstCompletedSession.events.filter((event) => (
      event.type === 'assistant.response.completed'
    ));
    assert.equal(completedEvents.length, 1, '第一轮逻辑回复必须只有一个完成事件');
    const completedSuggestionSet = completedEvents[0].payload?.suggestionSet;
    const completedSuggestionReceipt = completedEvents[0].payload?.suggestionInvariantReceipt;
    assert.ok(completedSuggestionSet, '完成事件缺少 SuggestionSet');
    assert.equal(completedSuggestionSet.items.length, 3);
    assert.equal(new Set(completedSuggestionSet.items.map((item) => item.id)).size, 3);
    assert.equal(new Set(completedSuggestionSet.items.map((item) => item.intent)).size, 3);
    assert.equal(completedSuggestionReceipt?.schema, 't8-creator-suggestion-invariant-receipt-v1');
    assert.equal(completedSuggestionReceipt?.suggestionSetCount, 1);
    assert.equal(completedSuggestionReceipt?.itemCount, 3);
    assert.equal(completedSuggestionReceipt?.uniqueIdCount, 3);
    assert.equal(completedSuggestionReceipt?.uniqueIntentCount, 3);
    assert.deepEqual(completedSuggestionReceipt?.invalidCapabilityIds, []);
    assert.equal(completedSuggestionReceipt?.invalidContractCount, 0);
    assert.equal(completedSuggestionReceipt?.fakeEnabledActionCount, 0);
    assert.equal(completedSuggestionReceipt?.unexplainedDisabledActionCount, 0);
    assert.equal(completedSuggestionReceipt?.setDigest, completedSuggestionSet.setDigest);
    assert.deepEqual(completedSuggestionSet.invariantReceipt, completedSuggestionReceipt);
    const invalidCompletedCapabilityIds = [...new Set(
      completedSuggestionSet.items.flatMap((item) => item.requiredCapabilityIds),
    )].filter((capabilityId) => !capabilityIds.has(capabilityId));
    assert.deepEqual(invalidCompletedCapabilityIds, []);
    const completedSuggestionDom = await cdp.evaluate(`(() => (
      [...document.querySelectorAll('.t8-creator-agent-suggestions button')].map((button) => ({
        id: button.getAttribute('data-suggestion-id') || '',
        intent: button.getAttribute('data-suggestion-intent') || '',
        executable: button.getAttribute('data-suggestion-executable') === 'true',
        disabled: button.disabled,
        requiredCapabilityIds: (button.getAttribute('data-required-capabilities') || '')
          .split(',').map((value) => value.trim()).filter(Boolean),
      }))
    ))()`);
    assert.equal(completedSuggestionDom.length, 3);
    assert.deepEqual(
      completedSuggestionDom.map((item) => item.id).sort(),
      completedSuggestionSet.items.map((item) => item.id).sort(),
    );
    assert.deepEqual(
      completedSuggestionDom.map((item) => item.intent).sort(),
      completedSuggestionSet.items.map((item) => item.intent).sort(),
    );
    assert.equal(completedSuggestionDom.filter((item) => (
      !item.disabled && (!item.executable || item.requiredCapabilityIds.length === 0)
    )).length, 0);

    const stopPrompt = '把这支短片继续拆成五个镜头，并先解释镜头节奏';
    const stopRequestReady = await cdp.evaluate(`(() => {
      const textarea = document.querySelector('[data-creator-agent-composer="true"]');
      if (!textarea) return false;
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, ${JSON.stringify(stopPrompt)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    assert.equal(stopRequestReady, true, '停止回复验收的第二轮输入框尚未就绪');
    await pressKey(cdp, 'Enter');
    const stopControl = await waitForEvaluation(cdp, `(() => {
      const button = document.querySelector('.t8-creator-agent-composer button[aria-label="停止本轮回复，不取消远端生成任务"]');
      const note = document.querySelector('.t8-creator-agent-composer__stop-note');
      if (!button || !note || button.disabled) return null;
      return {
        label: button.getAttribute('aria-label'),
        title: button.getAttribute('title'),
        note: note.textContent.trim(),
      };
    })()`);
    assert.match(stopControl.note, /停止回复只结束本轮文字输出/);
    assert.match(stopControl.note, /取消远端任务需在对应任务卡单独操作/);
    assert.match(stopControl.title, /不会取消画布里的远端生成任务/);
    const stopClicked = await cdp.evaluate(`(() => {
      const button = document.querySelector('.t8-creator-agent-composer button[aria-label="停止本轮回复，不取消远端生成任务"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    assert.equal(stopClicked, true, '停止回复按钮无法点击');
    const stoppedReplyAccessibility = await waitForEvaluation(cdp, `(() => {
      const live = document.querySelector('[data-creator-agent-live-status="true"]');
      const stopped = [...document.querySelectorAll('.t8-creator-agent-stream-status.is-stopped')].at(-1);
      const composer = document.querySelector('[data-creator-agent-composer="true"]');
      if (!live?.textContent?.includes('回复已停止') || !stopped || !composer) return null;
      return {
        announcement: live.textContent.trim(),
        stoppedText: stopped.textContent.trim(),
        stoppedAriaHidden: stopped.getAttribute('aria-hidden'),
        restoredDraft: composer.value,
      };
    })()`);
    assert.equal(stoppedReplyAccessibility.stoppedAriaHidden, 'true');
    assert.equal(stoppedReplyAccessibility.restoredDraft, stopPrompt, '停止回复后没有保留原始要求');
    const stopScreenshot = await captureScreenshot(cdp, 'creator-agent-stopped-reply.png');
    const stoppedSession = (await requestJson(
      `${backendUrl}/api/creator-agent/v1/sessions/${encodeURIComponent(initialSessionId)}?projectId=${encodeURIComponent(projectId)}&canvasId=${encodeURIComponent(canvasId)}`,
    )).data;
    const stoppedEvents = stoppedSession.events.filter((event) => event.type === 'assistant.response.stopped');
    assert.equal(stoppedEvents.length, 1, '停止一轮回复应只记录一个 durable stopped 终态');
    const stoppedEvent = stoppedEvents[0];
    const stoppedResponseId = String(stoppedEvent.payload?.responseId || '');
    assert.ok(stoppedResponseId, '停止回复事件缺少 responseId');
    assert.equal(stoppedEvent.payload?.remoteTasksAffected, 0);
    assert.equal(stoppedEvent.payload?.providerCalls, 0);
    assert.ok(String(stoppedEvent.payload?.text || '').length > 0, '停止回复没有保留已生成的部分文字');
    assert.equal(
      stoppedSession.events.some((event) => (
        event.type === 'assistant.response.completed'
        && String(event.payload?.responseId || '') === stoppedResponseId
      )),
      false,
      '停止回复竞态错误地产生了 completed 终态',
    );
    assert.equal(stoppedSession.latestPlan?.planId, firstCompletedPlanId, '停止回复错误地应用了第二轮计划');

    const focusedSeparator = await cdp.evaluate(`(() => {
      const separator = document.querySelector('.t8-creator-agent-resize-handle');
      if (!separator) return false;
      separator.focus();
      return document.activeElement === separator;
    })()`);
    assert.equal(focusedSeparator, true, '面板宽度分隔条无法取得焦点');
    const widthBefore = await cdp.evaluate(`document.querySelector('[data-canvas-floating-ui="creator-agent-panel"]').getBoundingClientRect().width`);
    await pressKey(cdp, 'ArrowLeft');
    const widthAfter = await waitForEvaluation(cdp, `(() => {
      const width = document.querySelector('[data-canvas-floating-ui="creator-agent-panel"]')?.getBoundingClientRect().width || 0;
      return width > ${Number(widthBefore)} ? width : 0;
    })()`);
    assert.ok(widthAfter <= 560, '键盘调整面板宽度越过上限');

    await pressKey(cdp, 'Escape');
    await waitForEvaluation(cdp, `(() => {
      const launcher = document.querySelector('[data-canvas-floating-ui="creator-agent-launcher"]');
      return !document.querySelector('[data-canvas-floating-ui="creator-agent-panel"]')
        && document.activeElement === launcher;
    })()`);

    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await focusLauncherAndOpen(cdp);
    const reducedMotion = await cdp.evaluate(`(() => {
      const panel = document.querySelector('[data-canvas-floating-ui="creator-agent-panel"]');
      const aura = document.querySelector('.t8-creator-agent-launcher__aura');
      return {
        panelAnimation: getComputedStyle(panel).animationName,
        panelTransition: getComputedStyle(panel).transitionDuration,
        auraAnimation: getComputedStyle(aura).animationName,
      };
    })()`);
    assert.deepEqual(reducedMotion, {
      panelAnimation: 'none',
      panelTransition: '0s',
      auraAnimation: 'none',
    });

    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await setThemeAndReload(cdp, {
      mode: 'dark',
      style: 'tech',
      templateId: 'tech-default',
    });
    const techLayout = await assertLayout(cdp, { visual: 'tech', mode: 'dark' });
    const techScreenshot = await captureScreenshot(cdp, 'creator-agent-tech-dark.png');

    await setThemeAndReload(cdp, {
      mode: 'light',
      style: 'pixel',
      templateId: 'pixel-candy',
    });
    const pixelLayout = await assertLayout(cdp, { visual: 'pixel', mode: 'light' });
    const pixelScreenshot = await captureScreenshot(cdp, 'creator-agent-pixel-light.png');

    const viewportChecks = [];
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 2560, height: 1440 },
    ]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        ...viewport,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(120);
      const layout = await assertLayout(cdp, { visual: 'pixel', mode: 'light' });
      viewportChecks.push({ viewport, panel: layout.panel, launcher: layout.launcher, minimap: layout.minimap });
    }

    const sessionIdBeforeReload = await cdp.evaluate(`localStorage.getItem(${JSON.stringify(sessionKey)}) || ''`);
    assert.equal(sessionIdBeforeReload, initialSessionId);
    const beforeReloadTimeOrigin = await cdp.evaluate('performance.timeOrigin');
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitForEvaluation(cdp, `performance.timeOrigin !== ${Number(beforeReloadTimeOrigin)}
      && Boolean(document.querySelector('[data-canvas-floating-ui="creator-agent-launcher"]'))`);
    await focusLauncherAndOpen(cdp);
    await waitForEvaluation(cdp, `(() => {
      return [...document.querySelectorAll('.t8-creator-agent-message.is-user')]
        .some((item) => item.textContent.includes('帮我设计一支15秒雨夜霓虹短片'));
    })()`);
    const sessionIdAfterReload = await cdp.evaluate(`localStorage.getItem(${JSON.stringify(sessionKey)}) || ''`);
    assert.equal(sessionIdAfterReload, initialSessionId, '刷新后 Creator Session 被重复创建');

    const sessions = await requestJson(
      `${backendUrl}/api/creator-agent/v1/sessions?projectId=${encodeURIComponent(projectId)}&canvasId=${encodeURIComponent(canvasId)}&limit=20`,
    );
    assert.equal(sessions.data.sessions.length, 1, '一次对话与多次刷新产生了重复 Creator Session');
    assert.equal(sessions.data.sessions[0].id, initialSessionId);

    const localPlanSamples = [];
    const localPlanReceipts = [];
    for (let index = 0; index < 20; index += 1) {
      const benchmarkSession = await requestJson(`${backendUrl}/api/creator-agent/v1/sessions`, {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          canvasId,
          context: { nodeCount: 0, edgeCount: 0, canvasRevision: beforeRevision },
        }),
      });
      const startedAt = performance.now();
      const benchmarkPlan = await requestJson(
        `${backendUrl}/api/creator-agent/v1/sessions/${encodeURIComponent(benchmarkSession.data.id)}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            projectId,
            canvasId,
            text: `做一支15秒竖屏产品短片，方向 ${index + 1}`,
            stream: false,
            context: { nodeCount: 0, edgeCount: 0, canvasRevision: beforeRevision },
          }),
        },
      );
      const elapsedMs = performance.now() - startedAt;
      const receipt = benchmarkPlan.data.readinessReceipt;
      assert.equal(receipt.schema, 't8-creator-agent-local-readiness-receipt-v1');
      assert.equal(receipt.withinTarget, true);
      assert.deepEqual(receipt.sideEffects, {
        providerCalls: 0,
        canvasWrites: 0,
        productionFileWrites: 0,
      });
      assert.equal(benchmarkPlan.data.session.latestPlan.impact.writesNow, 0);
      assert.equal(benchmarkPlan.data.session.latestPlan.impact.providerCallsNow, 0);
      assert.equal(benchmarkPlan.data.session.latestPlan.impact.fileWritesNow, 0);
      localPlanSamples.push(Math.round(elapsedMs * 1000) / 1000);
      localPlanReceipts.push(receipt.localPlanMs);
    }
    const localPlanP95Ms = nearestRankP95(localPlanSamples);
    const serverLocalPlanP95Ms = nearestRankP95(localPlanReceipts);
    assert.ok(localPlanP95Ms <= 2000, `本地计划 HTTP p95 超标: ${localPlanP95Ms}ms`);
    assert.ok(serverLocalPlanP95Ms <= 2000, `服务端本地计划 p95 超标: ${serverLocalPlanP95Ms}ms`);

    const after = (await requestJson(`${backendUrl}/api/canvas/${encodeURIComponent(canvasId)}`)).data;
    assert.equal(after.revision, beforeRevision, '只读对话和 UI 验收不应写入画布 revision');
    assert.equal(graphSnapshot(after), beforeGraph, '只读对话和 UI 验收污染了画布文档');
    await sleep(500);
    assert.deepEqual(browserErrors, [], `浏览器出现错误: ${browserErrors.join('\n')}`);

    const report = {
      schema: 't8-creator-agent-p4-ui-acceptance-v1',
      scope: 'development-browser-no-provider',
      canvasId,
      projectId,
      runtime: {
        frontendUrl,
        backendUrl,
        frontendPort,
        backendPort,
      },
      oneSentenceFlow: {
        prompt: '帮我设计一支15秒雨夜霓虹短片',
        sessionId: initialSessionId,
        sessionCountAfterReload: sessions.data.sessions.length,
        restoredAfterReload: true,
        suggestionCount: 3,
      },
      suggestionInvariant: {
        schema: 't8-creator-suggestion-invariant-acceptance-v1',
        initialBlank: {
          ...initialSuggestionAudit,
          invalidCapabilityIds: invalidInitialCapabilityIds,
        },
        completedReply: {
          completedEventCount: completedEvents.length,
          suggestionSetCount: completedSuggestionReceipt.suggestionSetCount,
          itemCount: completedSuggestionReceipt.itemCount,
          uniqueIdCount: completedSuggestionReceipt.uniqueIdCount,
          uniqueIntentCount: completedSuggestionReceipt.uniqueIntentCount,
          invalidCapabilityIds: invalidCompletedCapabilityIds,
          invalidContractCount: completedSuggestionReceipt.invalidContractCount,
          fakeEnabledActionCount: completedSuggestionReceipt.fakeEnabledActionCount,
          unexplainedDisabledActionCount:
            completedSuggestionReceipt.unexplainedDisabledActionCount,
          setDigest: completedSuggestionReceipt.setDigest,
          domMatchesReceipt: true,
        },
      },

      readiness: {
        schema: 't8-creator-agent-local-readiness-acceptance-v1',
        shell: initialShellReadiness,
        firstPlan: firstPlanReadiness,
        samples: localPlanSamples,
        serverSamples: localPlanReceipts,
        p95Ms: localPlanP95Ms,
        serverP95Ms: serverLocalPlanP95Ms,
        targetMs: 2000,
        sideEffects: {
          providerCalls: 0,
          canvasWrites: 0,
          productionFileWrites: 0,
        },
      },
      stopReply: {
        prompt: stopPrompt,
        responseId: stoppedResponseId,
        terminalEventCount: stoppedEvents.length,
        partialTextPreserved: true,
        restoredDraft: stoppedReplyAccessibility.restoredDraft,
        remoteTasksAffected: stoppedEvent.payload.remoteTasksAffected,
        providerCalls: stoppedEvent.payload.providerCalls,
        planUnchanged: stoppedSession.latestPlan?.planId === firstCompletedPlanId,
        announcement: stoppedReplyAccessibility.announcement,
        semanticsNote: stopControl.note,
      },
      keyboard: {
        launcherOpenedWithEnter: true,
        panelResizedWithArrowKey: true,
        escapeClosedPanel: true,
        focusReturnedToLauncher: true,
        composerFocusedOnOpen: true,
        imeCompositionEnterSuppressed,
        imePostCompositionEnterSuppressed,
      },
      accessibility: {
        panelLabel: initialLayout.panelLabel,
        launcherControls: initialLayout.launcherControls,
        reducedMotion,
        completedReplyAnnounced: completedReplyAccessibility.announcement,
        streamingLogLive: completedReplyAccessibility.logLive,
        streamingLogBusyAfterCompletion: completedReplyAccessibility.logBusy,
      },
      themes: {
        techDark: {
          visual: techLayout.themeVisual,
          mode: techLayout.themeMode,
          launcherBackground: techLayout.launcherBackground,
        },
        pixelLight: {
          visual: pixelLayout.themeVisual,
          mode: pixelLayout.themeMode,
          launcherBackground: pixelLayout.launcherBackground,
        },
      },
      viewportChecks,
      minimapUnobstructed: true,
      canvasRevision: {
        before: beforeRevision,
        after: after.revision,
        unchanged: true,
      },
      browserErrors,
      screenshots: [
        conversationScreenshot,
        stopScreenshot,
        techScreenshot,
        pixelScreenshot,
      ],
    };
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const diagnostics = {
      error: error?.stack || String(error),
      backendLogs: backend.logs,
      viteLogs: vite.logs,
      chromeLogs: chrome?.logs || [],
    };
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'failure.json'), `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');
    throw error;
  } finally {
    cdp?.close();
    stopProcess(chrome?.child);
    stopProcess(vite.child);
    stopProcess(backend.child);
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
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
};
