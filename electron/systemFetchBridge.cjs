'use strict';

const net = require('node:net');

const SYSTEM_FETCH_BRIDGE_MARKER = Symbol.for('t8-penguin-canvas.system-fetch-bridge.v1');
const CHROMIUM_MANAGED_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return String(input?.url || '');
}

function isHttpRequest(input) {
  try {
    const protocol = new URL(requestUrl(input)).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function isDirectLocalRequest(input) {
  try {
    const target = new URL(requestUrl(input));
    const hostname = String(target.hostname || '')
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '');
    if (!hostname) return false;
    if (
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname === 'host.docker.internal'
      || hostname === 'host.containers.internal'
    ) return true;
    const family = net.isIP(hostname);
    if (family === 4) {
      const [first, second] = hostname.split('.').map(Number);
      return first === 0
        || first === 10
        || first === 127
        || (first === 100 && second >= 64 && second <= 127)
        || (first === 169 && second === 254)
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168);
    }
    if (family === 6) {
      return hostname === '::' || hostname === '::1'
        || hostname.startsWith('fc') || hostname.startsWith('fd')
        || /^fe[89ab]/.test(hostname);
    }
    return false;
  } catch (_) {
    return false;
  }
}

function requestMethod(input, init) {
  const value = init?.method || input?.method || 'GET';
  return String(value).trim().toUpperCase() || 'GET';
}

function requestSignal(input, init) {
  return init?.signal || input?.signal || null;
}

function requestBody(input, init) {
  if (init && Object.prototype.hasOwnProperty.call(init, 'body')) return init.body;
  return input && typeof input === 'object' ? input.body : null;
}

function isSafeReadRequest(input, init) {
  const method = requestMethod(input, init);
  return method === 'GET' || method === 'HEAD';
}

function requiresNodeTransport(input, init) {
  if (init && typeof init === 'object' && (init.dispatcher || init.agent)) return true;
  const body = requestBody(input, init);
  const blob = typeof Blob !== 'undefined' && body instanceof Blob;
  const formData = typeof FormData !== 'undefined' && body instanceof FormData;
  return Boolean(
    body
    && (
      typeof body.pipe === 'function'
      || (
        typeof body[Symbol.asyncIterator] === 'function'
        && !blob
        && !formData
      )
    )
  );
}

function isChromiumManagedRequestHeader(name) {
  const normalized = String(name || '').trim().toLowerCase();
  return CHROMIUM_MANAGED_REQUEST_HEADERS.has(normalized)
    || normalized.startsWith('proxy-')
    || normalized.startsWith('sec-');
}

function chromiumRequestHeaders(headers) {
  if (!headers) return headers;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const result = new Headers(headers);
    for (const name of [...result.keys()]) {
      if (isChromiumManagedRequestHeader(name)) result.delete(name);
    }
    return result;
  }
  if (Array.isArray(headers)) {
    return headers.filter((entry) => (
      Array.isArray(entry)
      && entry.length >= 2
      && !isChromiumManagedRequestHeader(entry[0])
    ));
  }
  if (typeof headers === 'object') {
    return Object.fromEntries(
      Object.entries(headers).filter(([name]) => !isChromiumManagedRequestHeader(name)),
    );
  }
  return headers;
}

function chromiumRequestInit(input, init) {
  const hasInit = Boolean(init && typeof init === 'object');
  const inputHeaders = input && typeof input === 'object' ? input.headers : null;
  if (!hasInit && !inputHeaders) return init;
  const result = hasInit ? { ...init } : {};
  delete result.dispatcher;
  delete result.agent;
  delete result.duplex;
  const initHeaders = Object.prototype.hasOwnProperty.call(result, 'headers')
    ? result.headers
    : null;
  const requestHeaders = initHeaders || inputHeaders;
  if (requestHeaders) {
    // Electron's session.fetch delegates authority, connection management and
    // body framing to Chromium. Forwarding these caller-authored headers makes
    // Chromium reject the request locally with net::ERR_INVALID_ARGUMENT.
    // Semantic Provider headers (Authorization, Content-Type, API keys, etc.)
    // remain untouched. Request-object headers are covered too; Node-only
    // stream/dispatcher requests bypass this path.
    result.headers = chromiumRequestHeaders(requestHeaders);
  }
  return result;
}

function createSystemFetchBridge(options = {}) {
  const chromiumFetch = options.chromiumFetch;
  const nodeFetch = options.nodeFetch;
  const resolveHost = typeof options.resolveHost === 'function'
    ? options.resolveHost
    : null;
  const refreshNetwork = typeof options.refreshNetwork === 'function'
    ? options.refreshNetwork
    : null;
  const refreshIntervalMs = Math.max(0, Number(options.refreshIntervalMs) || 3_000);
  if (typeof chromiumFetch !== 'function') {
    throw new TypeError('chromiumFetch must be a function');
  }
  if (typeof nodeFetch !== 'function') {
    throw new TypeError('nodeFetch must be a function');
  }

  let lastRefreshAt = 0;
  let refreshPromise = null;
  const refreshSystemNetwork = async () => {
    if (!refreshNetwork) return;
    if (refreshPromise) return refreshPromise;
    const now = Date.now();
    if (lastRefreshAt && now - lastRefreshAt < refreshIntervalMs) return;
    lastRefreshAt = now;
    refreshPromise = Promise.resolve()
      .then(() => refreshNetwork())
      .catch(() => {})
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  };

  const bridgedFetch = async function systemAwareFetch(input, init) {
    if (!isHttpRequest(input) || isDirectLocalRequest(input) || requiresNodeTransport(input, init)) {
      return nodeFetch(input, init);
    }
    const chromiumInit = chromiumRequestInit(input, init);
    try {
      return await chromiumFetch(input, chromiumInit);
    } catch (error) {
      if (requestSignal(input, init)?.aborted) throw error;
      // Do not disturb concurrent SSE, polling or downloads on healthy requests.
      // Only a real network failure refreshes Chromium's proxy/PAC and resolver
      // view. Writes are never replayed here; their Provider layer owns any
      // idempotency-aware recovery. Safe reads may be repeated once.
      await refreshSystemNetwork();
      if (!isSafeReadRequest(input, init)) throw error;
      return chromiumFetch(input, chromiumInit);
    }
  };
  Object.defineProperty(bridgedFetch, SYSTEM_FETCH_BRIDGE_MARKER, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ nodeFetch, refreshNetwork: refreshSystemNetwork, resolveHost }),
    writable: false,
  });
  return bridgedFetch;
}

function installGlobalSystemFetchBridge(options = {}) {
  const target = options.target || globalThis;
  const currentFetch = target.fetch;
  if (typeof currentFetch !== 'function') {
    throw new TypeError('global fetch is unavailable');
  }
  if (currentFetch[SYSTEM_FETCH_BRIDGE_MARKER]) return currentFetch;
  const bridge = createSystemFetchBridge({
    chromiumFetch: options.chromiumFetch,
    nodeFetch: currentFetch.bind(target),
    refreshIntervalMs: options.refreshIntervalMs,
    refreshNetwork: options.refreshNetwork,
    resolveHost: options.resolveHost,
  });
  target.fetch = bridge;
  return bridge;
}

module.exports = {
  SYSTEM_FETCH_BRIDGE_MARKER,
  createSystemFetchBridge,
  installGlobalSystemFetchBridge,
};
