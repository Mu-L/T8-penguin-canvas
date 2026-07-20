const crypto = require('node:crypto');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { performance } = require('node:perf_hooks');
const { WebSocket } = require('ws');
const { isPrivateAddress, isLoopbackAddress } = require('../utils/safeRemoteMediaFetch');

const PUBLIC_SELF_CHECK_CONTRACT = 't8-collaboration-public-self-check-v1';
const PUBLIC_SELF_CHECK_HEADER = 'x-t8-collaboration-self-check';
const PUBLIC_SELF_CHECK_INVITE_CODE = 't8-public-self-check';
const PUBLIC_SELF_CHECK_MAX_RESPONSE_BYTES = 64 * 1024;
const PUBLIC_SELF_CHECK_MAX_UPLOAD_BYTES = 1024;
const PUBLIC_SELF_CHECK_DEFAULT_TIMEOUT_MS = 6_000;
const PUBLIC_SELF_CHECK_MAX_TIMEOUT_MS = 15_000;
const PUBLIC_SELF_CHECK_CHALLENGE_TTL_MS = 45_000;
const PUBLIC_SELF_CHECK_MAX_CHALLENGES = 64;
const PUBLIC_SELF_CHECK_KINDS = new Set(['invite', 'websocket', 'upload', 'range']);
const FORWARDED_REQUEST_HEADERS = Object.freeze([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-forwarded-protocol',
  'x-forwarded-server',
  'x-real-ip',
  'x-url-scheme',
  'front-end-https',
  'cf-connecting-ip',
  'true-client-ip',
]);
const EXPLICIT_LAN_ADDRESSES = new net.BlockList();
for (const [network, prefixLength, family] of [
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
]) EXPLICIT_LAN_ADDRESSES.addSubnet(network, prefixLength, family);

class PublicExposureError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PublicExposureError';
    this.code = code;
    this.status = status;
  }
}

function publicExposureError(code, message, status = 400) {
  return new PublicExposureError(code, message, status);
}

function normalizeHostname(value) {
  return String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
}

function normalizeNetworkAddress(value) {
  let address = normalizeHostname(value);
  const zoneIndex = address.indexOf('%');
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  if (!net.isIP(address)) return '';
  if (net.isIPv4(address)) return address;
  try {
    const canonical = normalizeHostname(new URL(`http://[${address}]/`).hostname);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
    if (!mapped) return canonical;
    const value = (Number.parseInt(mapped[1], 16) * 0x10000) + Number.parseInt(mapped[2], 16);
    return [24, 16, 8, 0].map((shift) => Math.floor(value / (2 ** shift)) & 0xff).join('.');
  } catch (_) {
    return '';
  }
}

function isUnspecifiedAddress(value) {
  const address = normalizeNetworkAddress(value);
  return address === '0.0.0.0' || address === '::';
}

function isExplicitLanAddress(value) {
  const address = normalizeNetworkAddress(value);
  const family = net.isIP(address);
  if (!family) return false;
  return EXPLICIT_LAN_ADDRESSES.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048 || /[\u0000-\u0020\u007f]/.test(raw)) {
    throw publicExposureError('collaboration_public_base_url_invalid', '公网 Base URL 格式无效');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw publicExposureError('collaboration_public_base_url_invalid', '公网 Base URL 格式无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !parsed.hostname
    || isUnspecifiedAddress(parsed.hostname)) {
    throw publicExposureError(
      'collaboration_public_base_url_invalid',
      '公网 Base URL 只允许不含凭据、查询参数或片段的 HTTP/HTTPS 地址',
    );
  }
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  if (!pathname.endsWith('/collab')) {
    throw publicExposureError(
      'collaboration_public_base_url_path_invalid',
      '公网 Base URL 路径必须以 /collab 结尾',
    );
  }
  parsed.pathname = pathname;
  return parsed.toString().replace(/\/$/, '');
}

function classifyPublicBaseUrl(value) {
  const baseUrl = normalizePublicBaseUrl(value);
  const parsed = new URL(baseUrl);
  const hostname = normalizeHostname(parsed.hostname);
  let exposure = 'public';
  if (hostname === 'localhost' || isLoopbackAddress(hostname)) exposure = 'loopback';
  else if (net.isIP(hostname) && isPrivateAddress(hostname)) exposure = 'lan';
  const insecurePublic = exposure === 'public' && parsed.protocol !== 'https:';
  return {
    baseUrl,
    origin: parsed.origin,
    exposure,
    protocol: parsed.protocol.slice(0, -1),
    https: parsed.protocol === 'https:',
    insecurePublic,
    ownerManagementAllowed: !insecurePublic,
    sensitiveOriginalDownloadAllowed: !insecurePublic,
    warning: insecurePublic
      ? '当前公网地址未使用 HTTPS：服务端已禁用 owner 管理能力与敏感原件下载。请在可信反向代理或隧道上启用有效 TLS。'
      : null,
  };
}

function safeConfiguredPublicExposure(value) {
  try {
    return value ? classifyPublicBaseUrl(value) : null;
  } catch (_) {
    return null;
  }
}

function requestOrigin(req) {
  const raw = String(req?.get?.('origin') || req?.headers?.origin || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.origin.toLowerCase()
      : '';
  } catch (_) {
    return '';
  }
}

function requestHeader(req, name) {
  const normalizedName = String(name || '').toLowerCase();
  const value = req?.get?.(normalizedName) ?? req?.headers?.[normalizedName];
  return Array.isArray(value) ? value.join(',') : String(value || '').trim();
}

function requestHasForwardingEvidence(req) {
  return FORWARDED_REQUEST_HEADERS.some((name) => Boolean(requestHeader(req, name)));
}

function requestHost(req) {
  const raw = requestHeader(req, 'host');
  if (!raw || raw.length > 512 || /[\u0000-\u0020\u007f]/.test(raw)) return null;
  try {
    const parsed = new URL(`http://${raw}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    const hostname = normalizeHostname(parsed.hostname);
    if (!hostname || isUnspecifiedAddress(hostname)) return null;
    return {
      host: parsed.host.toLowerCase(),
      hostname,
      address: normalizeNetworkAddress(hostname),
      loopback: hostname === 'localhost' || isLoopbackAddress(hostname),
    };
  } catch (_) {
    return null;
  }
}

function requestTrustedProxyStatus(req, remoteAddress) {
  let trustProxy;
  try {
    trustProxy = req?.app?.get?.('trust proxy fn') ?? req?.app?.get?.('trust proxy');
  } catch (_) {
    return { valid: false, trusted: false };
  }
  // A blanket boolean trust setting is not proof of an explicitly enrolled
  // immediate proxy. Production installs an exact-address predicate.
  if (trustProxy === true) return { valid: false, trusted: false };
  if (typeof trustProxy !== 'function' || !remoteAddress) return { valid: true, trusted: false };
  try {
    return { valid: true, trusted: trustProxy(remoteAddress, 0) === true };
  } catch (_) {
    return { valid: false, trusted: false };
  }
}

function normalizedRequestAuthority(value, protocol) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 512 || raw.includes(',') || /[\u0000-\u0020\u007f]/.test(raw)) return '';
  try {
    const parsed = new URL(`${protocol}//${raw}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
    return parsed.host.toLowerCase();
  } catch (_) {
    return '';
  }
}

function requestMatchesSecurePublicHost(req, policy, trustedProxy) {
  const expected = new URL(policy.baseUrl);
  const rawOrigin = requestHeader(req, 'origin');
  const origin = requestOrigin(req);
  if (rawOrigin && (!origin || origin !== expected.origin.toLowerCase())) return false;
  const host = normalizedRequestAuthority(requestHeader(req, 'host'), expected.protocol);
  const rawForwardedHost = requestHeader(req, 'x-forwarded-host');
  if (rawForwardedHost) {
    if (!trustedProxy) return false;
    const forwardedHost = normalizedRequestAuthority(rawForwardedHost, expected.protocol);
    return forwardedHost === expected.host.toLowerCase();
  }
  return host === expected.host.toLowerCase();
}

function requestHasExplicitLocalTransport(req, host) {
  if (!host || (host.hostname !== 'localhost' && !host.address)) return false;
  if (!host.loopback && !isExplicitLanAddress(host.address)) return false;

  const socket = req?.socket || req?.connection || null;
  // Keep pure helper/test-double compatibility. Every real Node HTTP request has
  // a socket and therefore takes the transport-bound checks below.
  if (!socket) return !requestHasForwardingEvidence(req);

  const remoteAddress = normalizeNetworkAddress(socket.remoteAddress);
  const localAddress = normalizeNetworkAddress(socket.localAddress);
  if (!remoteAddress
    || (!isLoopbackAddress(remoteAddress) && !isExplicitLanAddress(remoteAddress))
    || isUnspecifiedAddress(remoteAddress)) return false;
  const proxyStatus = requestTrustedProxyStatus(req, remoteAddress);
  if (!proxyStatus.valid || proxyStatus.trusted) return false;
  if (requestHasForwardingEvidence(req)) return false;

  const remoteLoopback = isLoopbackAddress(remoteAddress);
  if (remoteLoopback !== host.loopback) return false;
  if (localAddress) {
    if (host.loopback) {
      if (!isLoopbackAddress(localAddress)) return false;
    } else if (localAddress !== host.address) {
      return false;
    }
  }

  if (String(requestHeader(req, 'sec-fetch-site')).toLowerCase() === 'cross-site') return false;
  const origin = requestOrigin(req);
  if (origin) {
    try {
      const parsedOrigin = new URL(origin);
      const originHost = requestHost({ headers: { host: parsedOrigin.host } });
      if (!originHost || originHost.host !== host.host || originHost.loopback !== host.loopback) return false;
    } catch (_) {
      return false;
    }
  }
  return true;
}

function requestMatchesPublicBase(req, value) {
  const policy = safeConfiguredPublicExposure(value);
  if (!policy) return false;
  const expected = new URL(policy.baseUrl);
  if (requestOrigin(req) === expected.origin.toLowerCase()) return true;
  const hostCandidates = [
    req?.get?.('host') || req?.headers?.host,
    String(req?.get?.('x-forwarded-host') || req?.headers?.['x-forwarded-host'] || '').split(',')[0],
  ].map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean);
  return hostCandidates.includes(expected.host.toLowerCase());
}

function isInsecurePublicRequest(req, value) {
  const policy = safeConfiguredPublicExposure(value);
  // A direct loopback/RFC1918/ULA connection remains usable for local/LAN
  // development regardless of whether a separate public URL is configured.
  if (requestHasExplicitLocalTransport(req, requestHost(req))) return false;

  // Everything outside a proven local transport is degraded by default. This
  // includes missing/corrupt persisted configuration and a public HTTP policy.
  if (!policy || policy.exposure !== 'public' || !policy.https) return true;

  const remoteAddress = normalizeNetworkAddress(req?.socket?.remoteAddress || req?.connection?.remoteAddress);
  const proxyStatus = requestTrustedProxyStatus(req, remoteAddress);
  if (!proxyStatus.valid) return true;
  const encryptedSocket = req?.socket?.encrypted === true || req?.connection?.encrypted === true;
  if (!requestMatchesSecurePublicHost(req, policy, proxyStatus.trusted)) return true;

  const forwardedProto = requestHeader(req, 'x-forwarded-proto').toLowerCase();
  if (encryptedSocket) return Boolean(forwardedProto && forwardedProto !== 'https');
  return !(proxyStatus.trusted && forwardedProto === 'https');
}

function challengeDigest(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

class PublicSelfCheckChallenges {
  constructor(options = {}) {
    this.entries = new Map();
    this.ttlMs = Math.max(5_000, Math.min(120_000, Number(options.ttlMs) || PUBLIC_SELF_CHECK_CHALLENGE_TTL_MS));
    this.maxEntries = Math.max(4, Math.min(256, Number(options.maxEntries) || PUBLIC_SELF_CHECK_MAX_CHALLENGES));
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  issue(kind, payload = null) {
    if (!PUBLIC_SELF_CHECK_KINDS.has(kind)) {
      throw publicExposureError('collaboration_public_self_check_kind_invalid', '公网自检类型无效');
    }
    this.prune();
    const token = crypto.randomBytes(32).toString('base64url');
    const record = Object.freeze({
      kind,
      payload,
      expiresAt: Date.now() + this.ttlMs,
    });
    this.entries.set(challengeDigest(token), record);
    return { token, payload, expiresAt: record.expiresAt };
  }

  consume(token, kind) {
    const normalizedToken = String(token || '').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(normalizedToken) || !PUBLIC_SELF_CHECK_KINDS.has(kind)) return null;
    const key = challengeDigest(normalizedToken);
    const record = this.entries.get(key);
    this.entries.delete(key);
    if (!record || record.kind !== kind || record.expiresAt <= Date.now()) return null;
    return record;
  }

  revoke(token) {
    this.entries.delete(challengeDigest(token));
  }

  clear() {
    this.entries.clear();
  }
}

function normalizeAllowedLocalOrigins(values) {
  const result = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    try {
      const parsed = new URL(String(value || ''));
      if (['http:', 'https:'].includes(parsed.protocol)) result.add(parsed.origin.toLowerCase());
    } catch (_) {}
  }
  return result;
}

function normalizeAllowedLocalAddresses(values) {
  const result = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const address = normalizeHostname(value);
    if (address && net.isIP(address)) result.add(address);
  }
  return result;
}

async function resolvePinnedSelfCheckTarget(baseUrl, options = {}) {
  const target = new URL(normalizePublicBaseUrl(baseUrl));
  const hostname = normalizeHostname(target.hostname);
  const deadline = normalizeDeadline(options.deadline, options.timeoutMs);
  let lookedUp;
  try {
    lookedUp = await waitForDeadline(
      (options.lookup || dns.promises.lookup)(hostname, { all: true, verbatim: true }),
      deadline,
    );
  } catch (error) {
    if (error?.code === 'ETIMEDOUT') {
      throw publicExposureError(
        'collaboration_public_self_check_timeout',
        '公网 Base URL 解析超时',
        504,
      );
    }
    throw publicExposureError('collaboration_public_self_check_dns_failed', '公网 Base URL 无法解析', 422);
  }
  const records = (Array.isArray(lookedUp) ? lookedUp : [lookedUp])
    .map((record) => ({
      address: normalizeHostname(record?.address),
      family: Number(record?.family),
    }));
  if (!records.length || records.some((record) => !net.isIP(record.address)
    || net.isIP(record.address) !== record.family)) {
    throw publicExposureError('collaboration_public_self_check_dns_failed', '公网 Base URL 无法安全解析', 422);
  }
  const privateRecords = records.filter((record) => isPrivateAddress(record.address));
  const allowedOrigins = normalizeAllowedLocalOrigins(options.allowedLocalOrigins);
  const allowedAddresses = normalizeAllowedLocalAddresses(options.allowedLocalAddresses);
  if (privateRecords.length) {
    const exactLocalOrigin = allowedOrigins.has(target.origin.toLowerCase());
    const standardReverseProxy = !net.isIP(hostname)
      && ((target.protocol === 'https:' && (!target.port || target.port === '443'))
        || (target.protocol === 'http:' && (!target.port || target.port === '80')))
      && privateRecords.every((record) => allowedAddresses.has(record.address));
    if (privateRecords.length !== records.length || (!exactLocalOrigin && !standardReverseProxy)) {
      throw publicExposureError(
        'collaboration_public_self_check_private_target_forbidden',
        'Base URL 解析到未获允许的本机或内网目标，已阻止自检请求',
        403,
      );
    }
  }
  return { target, address: records[0].address, family: records[0].family, deadline };
}

function boundedTimeout(value) {
  return Math.max(
    1_000,
    Math.min(PUBLIC_SELF_CHECK_MAX_TIMEOUT_MS, Number(value) || PUBLIC_SELF_CHECK_DEFAULT_TIMEOUT_MS),
  );
}

function createDeadline(timeoutMs) {
  return Object.freeze({ expiresAt: performance.now() + boundedTimeout(timeoutMs) });
}

function normalizeDeadline(value, timeoutMs) {
  const expiresAt = Number(value?.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > 0
    ? value
    : createDeadline(timeoutMs);
}

function remainingDeadlineMs(deadline) {
  return Math.max(0, Math.ceil(Number(deadline?.expiresAt) - performance.now()));
}

function deadlineTimeoutError() {
  return Object.assign(new Error('public self-check deadline exceeded'), { code: 'ETIMEDOUT' });
}

function waitForDeadline(value, deadline) {
  const remainingMs = remainingDeadlineMs(deadline);
  if (remainingMs <= 0) return Promise.reject(deadlineTimeoutError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(result);
    };
    const timer = setTimeout(() => finish(reject, deadlineTimeoutError()), remainingMs);
    Promise.resolve(value).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

function pinnedLookup(pinned) {
  return (_hostname, _options, callback) => callback(null, pinned.address, pinned.family);
}

function requestPinnedBuffer(target, pinned, options = {}) {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const deadline = normalizeDeadline(options.deadline || pinned?.deadline, timeoutMs);
  const maxResponseBytes = Math.max(1, Math.min(
    PUBLIC_SELF_CHECK_MAX_RESPONSE_BYTES,
    Number(options.maxResponseBytes) || PUBLIC_SELF_CHECK_MAX_RESPONSE_BYTES,
  ));
  const body = options.body == null
    ? null
    : Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body));
  if (body && body.length > PUBLIC_SELF_CHECK_MAX_UPLOAD_BYTES) {
    return Promise.reject(publicExposureError(
      'collaboration_public_self_check_request_too_large',
      '公网自检请求体超过安全上限',
    ));
  }
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const remainingMs = remainingDeadlineMs(deadline);
    let settled = false;
    let request;
    let response;
    let deadlineTimer = null;
    let abortListener = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (abortListener && options.signal) options.signal.removeEventListener('abort', abortListener);
      callback(value);
    };
    const abortAndReject = (error) => {
      if (settled) return;
      finish(reject, error);
      try { response?.destroy(); } catch (_) {}
      try { request?.destroy(); } catch (_) {}
    };
    if (remainingMs <= 0) {
      finish(reject, deadlineTimeoutError());
      return;
    }
    deadlineTimer = setTimeout(() => abortAndReject(deadlineTimeoutError()), remainingMs);
    if (options.signal) {
      abortListener = () => abortAndReject(Object.assign(new Error('public self-check aborted'), {
        code: 'ABORT_ERR',
      }));
      if (options.signal.aborted) {
        abortListener();
        return;
      }
      options.signal.addEventListener('abort', abortListener, { once: true });
    }
    try {
      request = transport.request(target, {
        method: String(options.method || 'GET').toUpperCase(),
        headers: {
          accept: '*/*',
          'user-agent': 'T8-PenguinCanvas/PublicSelfCheck',
          ...(options.headers || {}),
          ...(body ? { 'content-length': String(body.length) } : {}),
        },
        lookup: pinnedLookup(pinned),
        agent: false,
        ...(target.protocol === 'https:' && !net.isIP(normalizeHostname(target.hostname))
          ? { servername: normalizeHostname(target.hostname) }
          : {}),
      }, (incoming) => {
        response = incoming;
        const contentLength = Number(response.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
          abortAndReject(publicExposureError(
            'collaboration_public_self_check_response_too_large',
            '公网自检响应超过安全上限',
            502,
          ));
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > maxResponseBytes) {
            abortAndReject(publicExposureError(
              'collaboration_public_self_check_response_too_large',
              '公网自检响应超过安全上限',
              502,
            ));
            return;
          }
          chunks.push(chunk);
        });
        response.once('end', () => finish(resolve, {
          status: Number(response.statusCode || 0),
          headers: response.headers,
          body: Buffer.concat(chunks, bytes),
        }));
        response.once('error', (error) => finish(reject, error));
        response.once('aborted', () => finish(reject, Object.assign(new Error('response aborted'), {
          code: 'ECONNRESET',
        })));
        response.once('close', () => {
          if (!response.complete) finish(reject, Object.assign(new Error('response closed early'), {
            code: 'ECONNRESET',
          }));
        });
      });
      request.setTimeout(Math.max(1, Math.min(timeoutMs, remainingMs)), () => {
        abortAndReject(deadlineTimeoutError());
      });
      request.once('error', (error) => finish(reject, error));
      if (body) request.end(body);
      else request.end();
    } catch (error) {
      abortAndReject(error);
    }
  });
}

function websocketSelfCheck(target, pinned, token, timeoutMs, deadlineValue = null, signal = null) {
  const websocketUrl = new URL('/ws/collab', target.origin);
  websocketUrl.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Promise((resolve, reject) => {
    const deadline = normalizeDeadline(deadlineValue || pinned?.deadline, timeoutMs);
    const remainingMs = remainingDeadlineMs(deadline);
    let settled = false;
    let socket;
    let timer = null;
    let abortListener = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (abortListener && signal) signal.removeEventListener('abort', abortListener);
      callback(value);
    };
    const abortAndReject = (error) => {
      if (settled) return;
      finish(reject, error);
      try { socket?.terminate(); } catch (_) {}
    };
    if (remainingMs <= 0) {
      finish(reject, deadlineTimeoutError());
      return;
    }
    if (signal) {
      abortListener = () => abortAndReject(Object.assign(new Error('public self-check aborted'), {
        code: 'ABORT_ERR',
      }));
      if (signal.aborted) {
        abortListener();
        return;
      }
      signal.addEventListener('abort', abortListener, { once: true });
    }
    try {
      socket = new WebSocket(websocketUrl, {
        origin: target.origin,
        headers: { [PUBLIC_SELF_CHECK_HEADER]: token },
        handshakeTimeout: Math.max(1, Math.min(boundedTimeout(timeoutMs), remainingMs)),
        followRedirects: false,
        lookup: pinnedLookup(pinned),
        ...(target.protocol === 'https:' && !net.isIP(normalizeHostname(target.hostname))
          ? { servername: normalizeHostname(target.hostname) }
          : {}),
      });
    } catch (error) {
      abortAndReject(error);
      return;
    }
    timer = setTimeout(() => abortAndReject(deadlineTimeoutError()), remainingMs);
    socket.once('open', () => {});
    socket.once('message', (raw) => {
      let payload = null;
      try { payload = JSON.parse(String(raw)); } catch (_) {}
      if (payload?.type !== 'self-check.ready') {
        finish(reject, new Error('unexpected websocket response'));
        socket.terminate();
        return;
      }
      finish(resolve, { status: 101 });
      socket.close(1000, 'self-check complete');
    });
    socket.once('error', (error) => finish(reject, error));
    socket.once('close', () => {
      if (!settled) finish(reject, Object.assign(new Error('websocket closed before self-check response'), {
        code: 'ECONNRESET',
      }));
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      finish(reject, Object.assign(new Error('unexpected websocket status'), {
        status: Number(response.statusCode || 0),
      }));
    });
  });
}

function safeSelfCheckFailure(error) {
  const code = String(error?.code || '');
  if (code === 'ETIMEDOUT' || code === 'ERR_HTTP_REQUEST_TIMEOUT') {
    return { code: 'timeout', message: '请求超时，请检查公网代理是否可达' };
  }
  if (/CERT|TLS|SSL/i.test(code)) {
    return { code: 'tls_failed', message: 'TLS 证书或 HTTPS 握手失败' };
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return { code: 'unreachable', message: '公网入口无法连接' };
  }
  return { code: 'unexpected_response', message: '公网入口未返回预期的安全响应' };
}

async function timedCheck(id, hint, callback) {
  const startedAt = Date.now();
  try {
    const outcome = await callback();
    return {
      id,
      status: 'passed',
      latencyMs: Math.max(0, Date.now() - startedAt),
      ...(Number(outcome?.status) ? { httpStatus: Number(outcome.status) } : {}),
      hint,
    };
  } catch (error) {
    const failure = safeSelfCheckFailure(error);
    return {
      id,
      status: 'failed',
      latencyMs: Math.max(0, Date.now() - startedAt),
      ...(Number(error?.status) ? { httpStatus: Number(error.status) } : {}),
      errorCode: failure.code,
      message: failure.message,
      hint,
    };
  }
}

function assertHttpStatus(response, expected, validate = null) {
  if (response?.status !== expected || (validate && !validate(response))) {
    const error = new Error('unexpected response');
    error.status = Number(response?.status || 0);
    throw error;
  }
  return response;
}

async function runPublicSelfCheck(options = {}) {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const deadline = createDeadline(timeoutMs);
  const policy = classifyPublicBaseUrl(options.baseUrl);
  const challenges = options.challenges;
  if (!(challenges instanceof PublicSelfCheckChallenges)) {
    throw publicExposureError('collaboration_public_self_check_unavailable', '公网自检服务未初始化', 503);
  }
  const pinned = await resolvePinnedSelfCheckTarget(policy.baseUrl, {
    ...options,
    timeoutMs,
    deadline,
  });
  const uploadPayload = Buffer.concat([
    Buffer.from('t8-public-self-check:'),
    crypto.randomBytes(32),
  ]);
  const rangePayload = crypto.randomBytes(128);
  const invite = challenges.issue('invite');
  const websocket = challenges.issue('websocket');
  const upload = challenges.issue('upload', {
    sha256: crypto.createHash('sha256').update(uploadPayload).digest('hex'),
    bytes: uploadPayload.length,
  });
  const range = challenges.issue('range', { body: rangePayload });
  const issued = [invite, websocket, upload, range];
  const apiUrl = (pathname) => new URL(pathname, pinned.target.origin);
  const originHeader = { origin: pinned.target.origin };
  const checks = await Promise.all([
    timedCheck('health', '确认反向代理放行 GET /api/collab/health。', async () => {
      const response = await requestPinnedBuffer(apiUrl('/api/collab/health'), pinned, {
        timeoutMs,
        deadline,
        signal: options.signal,
        maxResponseBytes: 4096,
        headers: originHeader,
      });
      return assertHttpStatus(response, 200, ({ body }) => {
        try {
          const payload = JSON.parse(body.toString('utf8'));
          return payload?.success === true && payload?.data?.service === 't8-collaboration-gateway';
        } catch (_) { return false; }
      });
    }),
    timedCheck('invite', '确认 POST /api/collab/invites/redeem 的 JSON 请求未被代理拦截。', async () => {
      const body = Buffer.from(JSON.stringify({
        code: PUBLIC_SELF_CHECK_INVITE_CODE,
        displayName: 'T8 公网自检',
      }));
      const response = await requestPinnedBuffer(apiUrl('/api/collab/invites/redeem'), pinned, {
        method: 'POST',
        timeoutMs,
        deadline,
        signal: options.signal,
        maxResponseBytes: 4096,
        headers: {
          ...originHeader,
          'content-type': 'application/json; charset=utf-8',
          [PUBLIC_SELF_CHECK_HEADER]: invite.token,
        },
        body,
      });
      return assertHttpStatus(response, 200, ({ body: responseBody }) => {
        try {
          const payload = JSON.parse(responseBody.toString('utf8'));
          return payload?.success === true && payload?.data?.selfCheck === true;
        } catch (_) { return false; }
      });
    }),
    timedCheck('websocket', '确认 /ws/collab 转发 HTTP Upgrade 与 Connection 头。', () => (
      websocketSelfCheck(pinned.target, pinned, websocket.token, timeoutMs, deadline, options.signal)
    )),
    timedCheck('upload', '确认代理允许微型 PUT application/octet-stream 请求体。', async () => {
      const response = await requestPinnedBuffer(apiUrl('/api/collab/self-check/upload'), pinned, {
        method: 'PUT',
        timeoutMs,
        deadline,
        signal: options.signal,
        maxResponseBytes: 4096,
        headers: {
          ...originHeader,
          'content-type': 'application/octet-stream',
          [PUBLIC_SELF_CHECK_HEADER]: upload.token,
        },
        body: uploadPayload,
      });
      return assertHttpStatus(response, 200, ({ body }) => {
        try {
          const payload = JSON.parse(body.toString('utf8'));
          return payload?.success === true && payload?.data?.bytes === uploadPayload.length;
        } catch (_) { return false; }
      });
    }),
    timedCheck('range', '确认代理保留 Range 请求并返回 206 Partial Content。', async () => {
      const response = await requestPinnedBuffer(apiUrl('/api/collab/self-check/range'), pinned, {
        timeoutMs,
        deadline,
        signal: options.signal,
        maxResponseBytes: 4096,
        headers: {
          ...originHeader,
          range: 'bytes=17-48',
          [PUBLIC_SELF_CHECK_HEADER]: range.token,
        },
      });
      return assertHttpStatus(response, 206, ({ body, headers }) => (
        body.equals(rangePayload.subarray(17, 49))
        && String(headers['content-range'] || '') === `bytes 17-48/${rangePayload.length}`
      ));
    }),
  ]).finally(() => {
    for (const entry of issued) challenges.revoke(entry.token);
  });
  const completedAt = Date.now();
  const allChecksPassed = checks.every((check) => check.status === 'passed');
  return {
    contractVersion: PUBLIC_SELF_CHECK_CONTRACT,
    baseUrl: policy.baseUrl,
    exposure: policy.exposure,
    protocol: policy.protocol,
    https: policy.https,
    insecurePublic: policy.insecurePublic,
    ownerManagementAllowed: policy.ownerManagementAllowed,
    sensitiveOriginalDownloadAllowed: policy.sensitiveOriginalDownloadAllowed,
    warning: policy.warning,
    allChecksPassed,
    status: allChecksPassed ? (policy.insecurePublic ? 'degraded' : 'passed') : 'failed',
    completedAt,
    checks,
  };
}

module.exports = {
  PUBLIC_SELF_CHECK_CONTRACT,
  PUBLIC_SELF_CHECK_HEADER,
  PUBLIC_SELF_CHECK_INVITE_CODE,
  PUBLIC_SELF_CHECK_MAX_UPLOAD_BYTES,
  PublicExposureError,
  PublicSelfCheckChallenges,
  classifyPublicBaseUrl,
  isInsecurePublicRequest,
  normalizePublicBaseUrl,
  requestMatchesPublicBase,
  resolvePinnedSelfCheckTarget,
  runPublicSelfCheck,
  safeConfiguredPublicExposure,
};
