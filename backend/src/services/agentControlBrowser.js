const crypto = require('node:crypto');

const HANDOFF_ACTIONS = new Set([
  'status',
  'open',
  'focus',
  'highlight',
  'screenshot',
  'inspect-visible-error',
]);
const FORBIDDEN_BROWSER_AUTHORITY_FIELDS = Object.freeze([
  'url',
  'targetUrl',
  'origin',
  'headers',
  'authorization',
  'credentials',
  'cookie',
  'cookies',
  'profile',
  'userDataDir',
  'storageState',
  'localStorage',
  'sessionStorage',
]);

class AgentControlBrowserError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AgentControlBrowserError';
    this.code = code;
    this.status = status;
  }
}

function localCanvasOrigin(config = {}) {
  const explicit = String(process.env.T8PC_FRONTEND_URL || process.env.T8_FRONTEND_URL || '').trim();
  if (explicit) {
    let parsed;
    try { parsed = new URL(explicit); } catch (_) {
      throw new AgentControlBrowserError('BROWSER_ORIGIN_INVALID', '画布前端地址无效，无法发起可见浏览器交接', 503);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new AgentControlBrowserError('BROWSER_ORIGIN_FORBIDDEN', '浏览器交接只允许本机画布的 HTTP(S) 地址', 403);
    }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      throw new AgentControlBrowserError('BROWSER_ORIGIN_FORBIDDEN', '浏览器交接只允许本机画布地址', 403);
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.origin;
  }
  if (config.IS_PACKAGED) return `http://127.0.0.1:${Number(config.PORT) || 18766}`;
  const port = Math.max(1, Math.min(65535, Number(process.env.T8_DEV_FRONTEND_PORT || process.env.VITE_PORT) || 11422));
  return `http://127.0.0.1:${port}`;
}

function safeEntityId(value, label) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new AgentControlBrowserError('BROWSER_TARGET_INVALID', `${label} 无效`);
  }
  return text;
}

function assertBrowserAuthorityBoundary(input = {}) {
  const unexpected = FORBIDDEN_BROWSER_AUTHORITY_FIELDS.filter(
    (field) => Object.prototype.hasOwnProperty.call(input, field),
  );
  if (unexpected.length > 0) {
    throw new AgentControlBrowserError(
      'BROWSER_AUTHORITY_EXPANSION_FORBIDDEN',
      `浏览器交接不能携带网页地址、登录态或浏览器凭据：${unexpected.join(', ')}`,
      403,
    );
  }
}

function createBrowserHandoff(input = {}, config = {}) {
  assertBrowserAuthorityBoundary(input);
  const action = String(input.action || 'status').trim().toLowerCase();
  if (!HANDOFF_ACTIONS.has(action)) {
    throw new AgentControlBrowserError('BROWSER_ACTION_INVALID', '不支持此浏览器交接动作');
  }
  if (action !== 'status' && input.userInitiated !== true) {
    throw new AgentControlBrowserError(
      'BROWSER_EXPLICIT_REQUEST_REQUIRED',
      '只有用户明确要求后，才能创建可见浏览器交接',
      409,
    );
  }
  const origin = localCanvasOrigin(config);
  const projectId = safeEntityId(input.projectId, 'projectId');
  const canvasId = safeEntityId(input.canvasId, 'canvasId');
  const nodeId = safeEntityId(input.nodeId, 'nodeId');
  if (!projectId || !canvasId) {
    throw new AgentControlBrowserError('BROWSER_SCOPE_REQUIRED', '浏览器交接必须绑定当前项目和画布');
  }
  if (action === 'highlight' && !nodeId) {
    throw new AgentControlBrowserError('BROWSER_TARGET_REQUIRED', '高亮节点必须提供 nodeId');
  }
  const handoffId = crypto.randomUUID();
  const handoffUrl = new URL('/', origin);
  handoffUrl.searchParams.set('zcanvasHandoff', handoffId);
  handoffUrl.searchParams.set('zcanvasAction', action);
  handoffUrl.searchParams.set('zcanvasCanvasId', canvasId);
  if (nodeId) handoffUrl.searchParams.set('zcanvasNodeId', nodeId);
  return {
    schema: 't8-browser-handoff-v1',
    handoffId,
    action,
    projectId,
    canvasId,
    ...(nodeId ? { nodeId } : {}),
    url: handoffUrl.toString(),
    allowedOrigin: origin,
    allowedOrigins: [origin],
    scope: 'current-tab-only',
    navigationPolicy: 'local-canvas-origin-only',
    credentialMode: 'omit',
    userInitiated: action !== 'status',
    requiresHostChrome: true,
    hostActionRequired: action !== 'status',
    executed: false,
    executionStatus: action === 'status' ? 'not-applicable' : 'handoff-only',
    readsCookies: false,
    readsProfile: false,
    readsOtherTabs: false,
    readsStorage: false,
    expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    instructions: action === 'open'
      ? ['此响应只创建交接，尚未打开 Chrome；使用 Agent 的 Chrome 能力在当前用户可见窗口打开此 URL 后，再回传可见证据。']
      : action === 'status'
        ? ['这是安全边界声明；未对 Chrome 执行任何操作。']
        : ['此响应只创建交接，尚未执行页面动作；先聚焦与 allowedOrigin 精确匹配的现有标签页，仅执行当前可见页面动作并回传证据。'],
    fallback: {
      available: true,
      message: '如果 Agent 没有 Chrome 控制能力，请把 url 返回给用户手动打开；画布业务结果不受影响。',
    },
  };
}

module.exports = {
  AgentControlBrowserError,
  FORBIDDEN_BROWSER_AUTHORITY_FIELDS,
  HANDOFF_ACTIONS,
  assertBrowserAuthorityBoundary,
  createBrowserHandoff,
  localCanvasOrigin,
};
