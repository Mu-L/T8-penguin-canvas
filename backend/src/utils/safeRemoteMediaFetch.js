'use strict';

const dns = require('dns').promises;
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');

const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 4;
const DEFAULT_JSON_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_JSON_MAX_DEPTH = 64;
const DEFAULT_JSON_MAX_NODES = 50_000;
const DEFAULT_UPLOAD_RESPONSE_MAX_BYTES = 64 * 1024;
const REQUEST_WRITE_CHUNK_BYTES = 64 * 1024;
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);
const TUN_FAKE_IPV4_NETWORK = 0xc6120000;
const TUN_FAKE_IPV4_PREFIX_LENGTH = 15;
const TUN_PUBLIC_DNS_TIMEOUT_MS = 3_000;
const TUN_PUBLIC_DNS_SERVERS = Object.freeze(
  String(process.env.T8_TUN_PUBLIC_DNS_SERVERS || '223.5.5.5,1.1.1.1,8.8.8.8')
    .split(',')
    .map((value) => value.trim())
    .filter((value, index, all) => net.isIP(value) && all.indexOf(value) === index)
    .slice(0, 4),
);
const TUN_DOH_ENDPOINTS = Object.freeze([
  Object.freeze({ address: '1.1.1.1', servername: 'cloudflare-dns.com' }),
  Object.freeze({ address: '8.8.8.8', servername: 'dns.google' }),
]);
const TUN_DOH_MAX_BYTES = 64 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const CROSS_ORIGIN_SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'cookie2',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'api-key',
  'x-goog-api-key',
]);

function remoteMediaError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function normalizeAddress(value) {
  let text = String(value || '').trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  return text;
}

function parseIpv4Number(value) {
  const address = normalizeAddress(value);
  if (!net.isIPv4(address)) return null;
  return address.split('.').reduce((result, part) => ((result * 256) + Number(part)) >>> 0, 0);
}

function matchesIpv4Cidr(value, network, prefixLength) {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return ((value & mask) >>> 0) === ((network & mask) >>> 0);
}

function isTunFakeAddress(value) {
  const ipv4 = parseIpv4Number(value);
  return ipv4 !== null && matchesIpv4Cidr(
    ipv4,
    TUN_FAKE_IPV4_NETWORK,
    TUN_FAKE_IPV4_PREFIX_LENGTH,
  );
}

// IANA special-purpose ranges that are not ordinary globally-routable unicast
// destinations. Several of the 192/8 entries are anycast/protocol assignments;
// a media downloader has no reason to reach them and treating them as public
// creates unnecessary SSRF ambiguity.
const BLOCKED_IPV4_RANGES = Object.freeze([
  [0x00000000, 8], // 0.0.0.0/8, this network
  [0x0a000000, 8], // RFC1918
  [0x64400000, 10], // RFC6598 shared address space / CGNAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local
  [0xac100000, 12], // RFC1918
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // TEST-NET-1
  [0xc01fc400, 24], // AS112-v4 anycast
  [0xc034c100, 24], // AMT anycast
  [0xc0586300, 24], // deprecated 6to4 relay anycast
  [0xc0a80000, 16], // RFC1918
  [0xc0af3000, 24], // AS112 direct delegation
  [0xc6120000, 15], // benchmarking
  [0xc6336400, 24], // TEST-NET-2
  [0xcb007100, 24], // TEST-NET-3
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved and limited broadcast
]);

function parseIpv6Bytes(value) {
  const normalized = normalizeAddress(value);
  if (!normalized || normalized.includes('%') || !net.isIPv6(normalized)) return null;
  let address = normalized;
  if (address.includes('.')) {
    const colon = address.lastIndexOf(':');
    const ipv4 = parseIpv4Number(address.slice(colon + 1));
    if (colon < 0 || ipv4 === null) return null;
    address = `${address.slice(0, colon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const parts = halves.length === 2
    ? [...left, ...Array(missing).fill('0'), ...right]
    : left;
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const bytes = Buffer.allocUnsafe(16);
  parts.forEach((part, index) => bytes.writeUInt16BE(Number.parseInt(part, 16), index * 2));
  return bytes;
}

function matchesIpv6Cidr(value, network, prefixLength) {
  const fullBytes = Math.floor(prefixLength / 8);
  const remainingBits = prefixLength % 8;
  for (let index = 0; index < fullBytes; index += 1) {
    if (value[index] !== network[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (value[fullBytes] & mask) === (network[fullBytes] & mask);
}

const BLOCKED_IPV6_RANGES = Object.freeze([
  ['2001::', 23], // IETF special-purpose space (Teredo, benchmarking, ORCHID, etc.)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // deprecated 6to4
  ['2620:4f:8000::', 48], // AS112 direct delegation anycast
  ['3fff::', 20], // documentation
].map(([network, prefixLength]) => Object.freeze({
  network: parseIpv6Bytes(network),
  prefixLength,
})));

function ipv4FromMappedIpv6(bytes) {
  if (!bytes || bytes.length !== 16) return null;
  for (let index = 0; index < 10; index += 1) {
    if (bytes[index] !== 0) return null;
  }
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return bytes.readUInt32BE(12);
}

function isLoopbackAddress(value) {
  const address = normalizeAddress(value);
  if (address === 'localhost') return true;
  const ipv4 = parseIpv4Number(address);
  if (ipv4 !== null) return matchesIpv4Cidr(ipv4, 0x7f000000, 8);
  const ipv6 = parseIpv6Bytes(address);
  if (!ipv6) return false;
  const mapped = ipv4FromMappedIpv6(ipv6);
  if (mapped !== null) return matchesIpv4Cidr(mapped, 0x7f000000, 8);
  return ipv6.subarray(0, 15).every((byte) => byte === 0) && ipv6[15] === 1;
}

// Despite its historical name, this is intentionally a "not globally-routable
// unicast" classifier. Unknown address syntax also fails closed.
function isPrivateAddress(value) {
  const address = normalizeAddress(value);
  if (!address || address === 'localhost') return true;
  const ipv4 = parseIpv4Number(address);
  if (ipv4 !== null) {
    return BLOCKED_IPV4_RANGES.some(([network, prefixLength]) => matchesIpv4Cidr(ipv4, network, prefixLength));
  }
  const ipv6 = parseIpv6Bytes(address);
  if (!ipv6) return true;
  // IPv4-mapped IPv6 is rejected even when the embedded IPv4 address is public:
  // it must not provide a second spelling that bypasses the IPv4 policy.
  if (ipv4FromMappedIpv6(ipv6) !== null) return true;
  // RFC4291 global unicast allocation. Everything outside 2000::/3 includes
  // unspecified, loopback, IPv4-compatible/NAT64, ULA, link/site-local and multicast.
  if ((ipv6[0] & 0xe0) !== 0x20) return true;
  return BLOCKED_IPV6_RANGES.some(({ network, prefixLength }) => matchesIpv6Cidr(ipv6, network, prefixLength));
}

function privateAddressAllowedForTests(setting, hostname) {
  if (setting === true) return true;
  return typeof setting === 'function' && setting(normalizeAddress(hostname)) === true;
}

async function resolveFromPublicDnsServer(hostname, server) {
  const resolver = new dns.Resolver();
  resolver.setServers([server]);
  let timer;
  try {
    const settled = await Promise.race([
      Promise.allSettled([
        resolver.resolve4(hostname),
        resolver.resolve6(hostname),
      ]),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          resolver.cancel();
          reject(remoteMediaError('tun_dns_fallback_timeout', 'TUN 公共 DNS 回源解析超时。'));
        }, TUN_PUBLIC_DNS_TIMEOUT_MS);
      }),
    ]);
    const records = [];
    for (const [index, result] of settled.entries()) {
      if (result.status !== 'fulfilled') continue;
      const family = index === 0 ? 4 : 6;
      for (const value of result.value || []) {
        const address = normalizeAddress(value);
        if (net.isIP(address) === family) records.push({ address, family });
      }
    }
    return records;
  } finally {
    if (timer) clearTimeout(timer);
    resolver.cancel();
  }
}

function normalizedTunPublicRecords(records) {
  const normalized = [];
  for (const record of records || []) {
    const address = normalizeAddress(record?.address);
    const detectedFamily = net.isIP(address);
    const family = Number(record?.family) || detectedFamily;
    if (!detectedFamily || family !== detectedFamily) continue;
    normalized.push({ address, family });
  }
  return normalized;
}

function parseDohAnswer(data) {
  if (Number(data?.Status) !== 0 || !Array.isArray(data?.Answer)) return [];
  const records = [];
  for (const answer of data.Answer) {
    const type = Number(answer?.type);
    const address = normalizeAddress(answer?.data);
    if (type === 1 && net.isIPv4(address)) records.push({ address, family: 4 });
    else if (type === 28 && net.isIPv6(address)) records.push({ address, family: 6 });
  }
  return records;
}

function resolveDohRecordType(hostname, endpoint, type) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let total = 0;
    const chunks = [];
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const request = https.request({
      protocol: 'https:',
      hostname: endpoint.address,
      port: 443,
      servername: endpoint.servername,
      method: 'GET',
      path: `/dns-query?name=${encodeURIComponent(hostname)}&type=${encodeURIComponent(type)}`,
      agent: false,
      headers: {
        Host: endpoint.servername,
        Accept: 'application/dns-json',
        Connection: 'close',
        'User-Agent': 'T8-PenguinCanvas/1.0',
      },
      timeout: TUN_PUBLIC_DNS_TIMEOUT_MS,
    }, (response) => {
      if (Number(response.statusCode || 0) < 200 || Number(response.statusCode || 0) >= 300) {
        response.resume();
        finish(reject, remoteMediaError(
          'tun_dns_fallback_doh_http',
          `加密 DNS 回源返回 HTTP ${Number(response.statusCode || 0) || 'unknown'}。`,
        ));
        return;
      }
      response.on('data', (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > TUN_DOH_MAX_BYTES) {
          response.destroy();
          finish(reject, remoteMediaError('tun_dns_fallback_doh_too_large', '加密 DNS 回源响应过大。'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        try {
          finish(resolve, parseDohAnswer(JSON.parse(Buffer.concat(chunks, total).toString('utf8'))));
        } catch (error) {
          finish(reject, remoteMediaError('tun_dns_fallback_doh_invalid', '加密 DNS 回源响应无效。', { cause: error }));
        }
      });
      response.on('error', (error) => finish(reject, error));
    });
    request.once('timeout', () => request.destroy(
      remoteMediaError('tun_dns_fallback_doh_timeout', '加密 DNS 回源超时。'),
    ));
    request.once('error', (error) => finish(reject, error));
    request.end();
  });
}

async function resolveFromPublicDoh(hostname, endpoint) {
  const settled = await Promise.allSettled([
    resolveDohRecordType(hostname, endpoint, 'A'),
    resolveDohRecordType(hostname, endpoint, 'AAAA'),
  ]);
  return settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
}

async function resolveTunPublicDns(hostname, options = {}) {
  const dnsServers = Array.isArray(options.dnsServers) ? options.dnsServers : TUN_PUBLIC_DNS_SERVERS;
  const dohEndpoints = Array.isArray(options.dohEndpoints) ? options.dohEndpoints : TUN_DOH_ENDPOINTS;
  const resolveFromServer = options.resolveFromServer || resolveFromPublicDnsServer;
  const resolveFromDoh = options.resolveFromDoh || resolveFromPublicDoh;
  let lastError = null;
  for (const server of dnsServers) {
    try {
      const records = normalizedTunPublicRecords(await resolveFromServer(hostname, server));
      if (!records.length) continue;
      if (records.some((record) => isPrivateAddress(record.address))) {
        lastError = remoteMediaError('tun_dns_fallback_private', '公共 DNS 返回了非公网地址。');
        continue;
      }
      return records;
    } catch (error) {
      lastError = error;
    }
  }
  // Clash Fake-IP/TUN 常会劫持全部 UDP/53，即便显式指定 1.1.1.1 仍返回
  // 198.18.0.0/15。此时直接连接可信 DoH 的固定公网 IP，并使用正确
  // TLS SNI/Host 取得真实记录；不依赖系统 DNS，也不会放宽任意内网地址。
  for (const endpoint of dohEndpoints) {
    try {
      const records = normalizedTunPublicRecords(await resolveFromDoh(hostname, endpoint));
      if (!records.length) continue;
      if (records.some((record) => isPrivateAddress(record.address))) {
        lastError = remoteMediaError('tun_dns_fallback_private', '加密 DNS 返回了非公网地址。');
        continue;
      }
      return records;
    } catch (error) {
      lastError = error;
    }
  }
  throw remoteMediaError(
    'tun_dns_fallback_failed',
    '检测到 TUN Fake-IP，但无法通过独立公共 DNS 或加密 DNS 获取真实公网地址。',
    { cause: lastError },
  );
}

async function resolvePublicAddress(
  hostname,
  lookupImpl = dns.lookup,
  allowPrivateForTests = false,
  publicLookupImpl = resolveTunPublicDns,
  acceptTunFake = true,
) {
  const normalizedHostname = normalizeAddress(hostname);
  const bypass = privateAddressAllowedForTests(allowPrivateForTests, normalizedHostname);
  if (!normalizedHostname || (!bypass && net.isIP(normalizedHostname) && isPrivateAddress(normalizedHostname))) {
    throw remoteMediaError('private_address', '远程地址不是全球可路由单播地址，已拒绝访问。');
  }
  let lookedUp;
  try {
    lookedUp = await lookupImpl(normalizedHostname, { all: true, verbatim: true });
  } catch (error) {
    if (!['ENOTFOUND', 'EAI_AGAIN'].includes(String(error?.code || '').toUpperCase())) throw error;
    lookedUp = await publicLookupImpl(normalizedHostname);
  }
  let records = Array.isArray(lookedUp) ? lookedUp : (lookedUp ? [lookedUp] : []);
  let normalizedRecords = records.map((record) => {
    const address = normalizeAddress(record?.address);
    const detectedFamily = net.isIP(address);
    const family = Number(record?.family) || detectedFamily;
    return { address, family, detectedFamily };
  });
  // A Fake-IP returned for a hostname is a routing token owned by the active
  // TUN, not the real destination. Keep it as the first connection path so
  // Clash/sing-box can apply the user's domain rules. Literal Fake-IP URLs are
  // still rejected above. If that connection fails, the caller falls back to
  // independently resolved public addresses without weakening the SSRF policy.
  const tunFakeRecord = normalizedRecords.find((record) => isTunFakeAddress(record.address));
  if (tunFakeRecord && acceptTunFake) {
    return {
      address: tunFakeRecord.address,
      family: tunFakeRecord.family,
      tunFake: true,
    };
  }
  if (tunFakeRecord) {
    records = await publicLookupImpl(normalizedHostname);
    normalizedRecords = records.map((record) => {
      const address = normalizeAddress(record?.address);
      const detectedFamily = net.isIP(address);
      const family = Number(record?.family) || detectedFamily;
      return { address, family, detectedFamily };
    });
  }
  if (!normalizedRecords.length || normalizedRecords.some((record) => (
    !record.detectedFamily || record.family !== record.detectedFamily || (!bypass && isPrivateAddress(record.address))
  ))) {
    throw remoteMediaError('private_address', '远程地址不是全球可路由单播地址，已拒绝访问。');
  }
  return {
    address: normalizedRecords[0].address,
    family: normalizedRecords[0].family,
    tunFake: false,
  };
}

function positiveInteger(value, fallback) {
  const parsed = Math.trunc(Number(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Math.trunc(Number(value));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function allowedProtocols(value) {
  let values;
  if (value === undefined) values = ['http:', 'https:'];
  else if (typeof value === 'string') values = [value];
  else {
    try { values = Array.from(value || []); } catch (_) {
      throw remoteMediaError('invalid_protocol', '远程资源协议限制无效。');
    }
  }
  const result = new Set(values.map((protocol) => {
    const normalized = String(protocol || '').trim().toLowerCase();
    return normalized.endsWith(':') ? normalized : `${normalized}:`;
  }));
  for (const protocol of result) {
    if (!SUPPORTED_PROTOCOLS.has(protocol)) {
      throw remoteMediaError('invalid_protocol', '只支持 HTTP/HTTPS 远程地址。');
    }
  }
  return result;
}

function parseRemoteUrl(inputUrl, options) {
  const raw = String(inputUrl || '').trim();
  if (!raw || raw.length > 16_384) throw remoteMediaError('invalid_url', '远程资源地址无效。');
  let target;
  try { target = new URL(raw); } catch (_) { throw remoteMediaError('invalid_url', '远程资源地址无效。'); }
  const protocols = options._protocols || allowedProtocols(options.protocols);
  if (!protocols.has(target.protocol)) {
    throw remoteMediaError('invalid_protocol', `远程资源协议 ${target.protocol || '(empty)'} 未获允许。`);
  }
  if (target.username || target.password) {
    throw remoteMediaError('url_credentials_forbidden', '远程资源地址禁止包含用户名或密码。');
  }
  if (!target.hostname) throw remoteMediaError('invalid_url', '远程资源地址缺少主机名。');
  target.hash = '';
  return target;
}

function requestHeaders(options, sensitiveHeadersAllowed = true) {
  const headers = new Map([
    ['accept', String(options.accept || '*/*')],
    ['user-agent', String(options.userAgent || 'T8-PenguinCanvas/1.0')],
  ]);
  for (const [name, value] of Object.entries(options.headers || {})) {
    const normalizedName = String(name).trim().toLowerCase();
    if (!normalizedName || HOP_BY_HOP_HEADERS.has(normalizedName) || value === undefined) continue;
    headers.set(normalizedName, value);
  }
  if (!sensitiveHeadersAllowed) {
    for (const name of CROSS_ORIGIN_SENSITIVE_HEADERS) headers.delete(name);
  }
  return Object.fromEntries(headers);
}

function fetchTimeoutError(kind) {
  return remoteMediaError(
    'fetch_timeout',
    kind === 'deadline' ? '远程资源读取超过绝对时限。' : '远程资源读取空闲超时。',
    { timeoutKind: kind },
  );
}

function remainingDeadlineMs(state) {
  const remaining = state.deadlineAt - Date.now();
  if (remaining <= 0) throw fetchTimeoutError('deadline');
  return remaining;
}

async function withinDeadline(promise, state) {
  const remaining = remainingDeadlineMs(state);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(fetchTimeoutError('deadline')), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writeRequestParts(request, parts, onBodyQueued = () => {}) {
  return new Promise((resolve, reject) => {
    let index = 0;
    let partOffset = 0;
    let settled = false;
    let scheduledImmediate = null;
    let bodyQueued = false;
    const cleanup = () => {
      if (scheduledImmediate) clearImmediate(scheduledImmediate);
      request.off('drain', writeNext);
      request.off('finish', onFinish);
      request.off('error', onError);
      request.off('close', onClose);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onFinish = () => settle(resolve);
    const onError = (error) => settle(reject, error);
    const onClose = () => {
      if (!request.writableFinished) {
        settle(reject, remoteMediaError('upload_incomplete', '远程上传请求体未完整发送。'));
      }
    };
    const markBodyQueued = () => {
      if (bodyQueued) return;
      bodyQueued = true;
      onBodyQueued();
    };
    const hasRemainingBody = () => {
      if (index < parts.length && partOffset < parts[index].length) return true;
      for (let nextIndex = index + 1; nextIndex < parts.length; nextIndex += 1) {
        if (parts[nextIndex].length > 0) return true;
      }
      return false;
    };
    const writeNext = () => {
      try {
        if (request.destroyed) {
          settle(reject, remoteMediaError('upload_incomplete', '远程上传请求体未完整发送。'));
          return;
        }
        while (index < parts.length && partOffset >= parts[index].length) {
          index += 1;
          partOffset = 0;
        }
        if (index < parts.length) {
          const part = parts[index];
          const nextOffset = Math.min(part.length, partOffset + REQUEST_WRITE_CHUNK_BYTES);
          const chunk = part.subarray(partOffset, nextOffset);
          partOffset = nextOffset;
          const accepted = request.write(chunk);
          if (!hasRemainingBody()) {
            markBodyQueued();
            request.end();
            return;
          }
          if (!accepted) {
            request.once('drain', writeNext);
            return;
          }
          // Yield between bounded writes so an endpoint that responds before
          // consuming the body can interrupt us before the whole Buffer is
          // handed to the Windows kernel send queue.
          scheduledImmediate = setImmediate(() => {
            scheduledImmediate = null;
            writeNext();
          });
          return;
        }
        markBodyQueued();
        request.end();
      } catch (error) {
        settle(reject, error);
      }
    };
    request.once('finish', onFinish);
    request.once('error', onError);
    request.once('close', onClose);
    writeNext();
  });
}

function issuePinnedRequest(target, pinned, headers, state, requestOptions = {}) {
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let request;
    let pendingResponse = null;
    let bodyQueued = !requestOptions.requireBodyCompletion;
    let bodyCompleted = !requestOptions.requireBodyCompletion;
    let settled = false;
    let deadlineTimer;
    const cleanup = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (request) request.setTimeout(0);
      if (pendingResponse) {
        pendingResponse.off('error', fail);
        pendingResponse.off('aborted', responseAborted);
      }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (pendingResponse) pendingResponse.destroy();
      reject(error);
    };
    const responseAborted = () => fail(remoteMediaError('remote_response_aborted', '远程服务响应提前中断。'));
    const maybeResolve = () => {
      if (settled || !pendingResponse || !bodyCompleted) return;
      settled = true;
      const response = pendingResponse;
      cleanup();
      resolve(response);
    };
    try {
      const remaining = remainingDeadlineMs(state);
      request = transport.request(target, {
        method: requestOptions.method || 'GET',
        headers,
        lookup(_hostname, lookupOptions, callback) {
          if (lookupOptions?.all) {
            callback(null, [{ address: pinned.address, family: pinned.family }]);
          } else {
            callback(null, pinned.address, pinned.family);
          }
        },
      }, (response) => {
        if (settled) {
          response.destroy();
          return;
        }
        pendingResponse = response;
        response.once('error', fail);
        response.once('aborted', responseAborted);
        if (requestOptions.requireBodyCompletion && !bodyQueued) {
          const error = remoteMediaError(
            'upload_incomplete',
            '远程上传地址在请求体发送完毕前返回响应，已拒绝将其视为成功。',
            { status: Number(response.statusCode || 0) },
          );
          request.destroy();
          fail(error);
          return;
        }
        maybeResolve();
      });
      request.setTimeout(state.idleTimeoutMs, () => request.destroy(fetchTimeoutError('idle')));
      deadlineTimer = setTimeout(() => request.destroy(fetchTimeoutError('deadline')), remaining);
      request.on('error', fail);
      const bodyParts = Array.isArray(requestOptions.bodyParts) ? requestOptions.bodyParts : [];
      if (bodyParts.length || requestOptions.requireBodyCompletion) {
        void writeRequestParts(request, bodyParts, () => { bodyQueued = true; })
          .then(() => {
            bodyCompleted = true;
            maybeResolve();
          })
          .catch((error) => {
            request.destroy();
            fail(error);
          });
      }
      else request.end();
    } catch (error) {
      if (request) request.destroy();
      fail(error);
    }
  });
}

async function openSafeRemoteResponse(inputUrl, options, state, initialRedirectCount = 0) {
  let currentUrl = inputUrl;
  let previousTarget = null;
  // Once a redirect crosses an origin boundary, credentials must stay stripped
  // for the rest of the chain. Rebuilding headers from the caller's original
  // options on a later same-origin hop would otherwise resurrect them.
  let sensitiveHeadersAllowed = true;
  let redirectCount = Math.max(0, Math.trunc(Number(initialRedirectCount)) || 0);
  while (true) {
    const target = parseRemoteUrl(currentUrl, options);
    if (previousTarget && previousTarget.origin !== target.origin) sensitiveHeadersAllowed = false;
    const privateTestSetting = options.allowPrivateForTests;
    let pinned = await withinDeadline(
      resolvePublicAddress(
        target.hostname,
        options.lookupImpl || dns.lookup,
        privateTestSetting,
        options.publicLookupImpl || resolveTunPublicDns,
        options.acceptTunFake !== false,
      ),
      state,
    );
    let response;
    try {
      response = await issuePinnedRequest(
        target,
        pinned,
        requestHeaders(options, sensitiveHeadersAllowed),
        state,
      );
    } catch (error) {
      if (!pinned.tunFake) throw error;
      // TUN may have been disabled after the task was submitted or may not own
      // this Fake-IP anymore. Resolve the same hostname independently and retry
      // only this idempotent download; the generation request is never replayed.
      pinned = await withinDeadline(
        resolvePublicAddress(
          target.hostname,
          async (name) => (options.publicLookupImpl || resolveTunPublicDns)(name),
          privateTestSetting,
          options.publicLookupImpl || resolveTunPublicDns,
          false,
        ),
        state,
      );
      response = await issuePinnedRequest(
        target,
        pinned,
        requestHeaders(options, sensitiveHeadersAllowed),
        state,
      );
    }
    const status = Number(response.statusCode || 0);
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      response.destroy();
      if (redirectCount >= state.maxRedirects) {
        throw remoteMediaError('too_many_redirects', '远程资源重定向次数过多。');
      }
      let nextUrl;
      try { nextUrl = new URL(String(response.headers.location), target).toString(); } catch (_) {
        throw remoteMediaError('invalid_redirect', '远程资源重定向地址无效。');
      }
      redirectCount += 1;
      previousTarget = target;
      currentUrl = nextUrl;
      continue;
    }
    if (!options.allowHttpErrors && (status < 200 || status >= 300)) {
      response.resume();
      response.destroy();
      throw remoteMediaError('remote_http_error', `远程资源返回 HTTP ${status}。`, { status });
    }
    return { response, status, target };
  }
}

function assertContentLength(response, maxBytes) {
  const raw = response.headers['content-length'];
  if (raw === undefined || raw === '') return null;
  const text = Array.isArray(raw) ? raw.join(',') : String(raw).trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw remoteMediaError('invalid_content_length', '远程资源 Content-Length 无效。');
  }
  if (Number(text) > maxBytes) {
    throw remoteMediaError('item_too_large', `远程资源超过 ${maxBytes} bytes 限制。`);
  }
  return Number(text);
}

function contentLengthMismatch(expectedBytes, receivedBytes) {
  return remoteMediaError(
    'content_length_mismatch',
    `远程资源实际长度 ${receivedBytes} bytes 与声明的 ${expectedBytes} bytes 不一致。`,
    { expectedBytes, receivedBytes },
  );
}

function isPrematureResponseError(error, response) {
  if (error?.code) {
    return error.code === 'ECONNRESET'
      || error.code === 'ERR_STREAM_PREMATURE_CLOSE'
      || error.code === 'HPE_INVALID_EOF_STATE';
  }
  return response.aborted === true || error?.message === 'aborted';
}

async function consumeResponse(response, state, onChunk, knownContentLength) {
  let expectedBytes = knownContentLength;
  if (expectedBytes === undefined) {
    try {
      expectedBytes = assertContentLength(response, state.maxBytes);
    } catch (error) {
      response.destroy(error);
      throw error;
    }
  }
  const remaining = remainingDeadlineMs(state);
  const deadlineTimer = setTimeout(() => response.destroy(fetchTimeoutError('deadline')), remaining);
  if (response.socket) {
    response.setTimeout(state.idleTimeoutMs, () => response.destroy(fetchTimeoutError('idle')));
  }
  let total = 0;
  try {
    for await (const value of response) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (total + chunk.length > state.maxBytes) {
        const error = remoteMediaError('item_too_large', `远程资源超过 ${state.maxBytes} bytes 限制。`);
        response.destroy(error);
        throw error;
      }
      if (expectedBytes !== null && total + chunk.length > expectedBytes) {
        const error = contentLengthMismatch(expectedBytes, total + chunk.length);
        response.destroy(error);
        throw error;
      }
      await onChunk(chunk);
      total += chunk.length;
    }
    if (expectedBytes !== null && total !== expectedBytes) {
      throw contentLengthMismatch(expectedBytes, total);
    }
    return total;
  } catch (error) {
    if (expectedBytes !== null && total !== expectedBytes && isPrematureResponseError(error, response)) {
      throw contentLengthMismatch(expectedBytes, total);
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    if (response.socket) response.setTimeout(0);
    if (!response.complete) response.destroy();
  }
}

async function consumeResponseBuffer(response, state) {
  let expectedBytes;
  try {
    expectedBytes = assertContentLength(response, state.maxBytes);
  } catch (error) {
    response.destroy(error);
    throw error;
  }
  if (expectedBytes !== null) {
    const buffer = expectedBytes === 0 ? Buffer.alloc(0) : Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    await consumeResponse(response, state, async (chunk) => {
      const copied = chunk.copy(buffer, offset);
      if (copied !== chunk.length) {
        throw contentLengthMismatch(expectedBytes, offset + copied);
      }
      offset += copied;
    }, expectedBytes);
    return buffer;
  }

  const chunks = [];
  const byteLength = await consumeResponse(response, state, async (chunk) => { chunks.push(chunk); }, null);
  return Buffer.concat(chunks, byteLength);
}

function createTransferState(options) {
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const deadlineMs = positiveInteger(options.deadlineMs, timeoutMs);
  return {
    deadlineAt: Date.now() + deadlineMs,
    idleTimeoutMs: positiveInteger(options.idleTimeoutMs, timeoutMs),
    maxBytes: positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES),
    maxRedirects: nonNegativeInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS),
  };
}

async function safeRemoteMediaFetch(inputUrl, options = {}, redirectCount = 0) {
  const normalizedOptions = { ...options, _protocols: allowedProtocols(options.protocols) };
  const state = createTransferState(normalizedOptions);
  const { response, status, target } = await openSafeRemoteResponse(inputUrl, normalizedOptions, state, redirectCount);
  const buffer = await consumeResponseBuffer(response, state);
  return {
    buffer,
    contentType: String(response.headers['content-type'] || ''),
    finalUrl: target.toString(),
    status,
  };
}

function assertJsonComplexity(value, options = {}) {
  const maxDepth = positiveInteger(options.maxJsonDepth, DEFAULT_JSON_MAX_DEPTH);
  const maxNodes = positiveInteger(options.maxJsonNodes, DEFAULT_JSON_MAX_NODES);
  let nodes = 1;
  const stack = [{ value, depth: 0 }];
  const seen = new WeakSet();
  while (stack.length) {
    const current = stack.pop();
    if (!current || current.value === null || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    if (current.depth > maxDepth) {
      throw remoteMediaError('json_too_complex', `远程 JSON 深度超过 ${maxDepth} 层限制。`);
    }
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    if (nodes + children.length > maxNodes) {
      throw remoteMediaError('json_too_complex', `远程 JSON 节点超过 ${maxNodes} 个限制。`);
    }
    nodes += children.length;
    for (const child of children) {
      if (child !== null && typeof child === 'object') {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return value;
}

/**
 * Fetch bounded JSON through the same DNS-pinned, redirect-revalidated transport.
 * Non-2xx responses are intentionally returned with their original status so
 * queue APIs can interpret bounded error/pending JSON without using fetch().
 */
async function safeRemoteJsonFetch(inputUrl, options = {}) {
  const normalizedOptions = {
    ...options,
    allowHttpErrors: true,
    maxBytes: positiveInteger(options.maxBytes, DEFAULT_JSON_MAX_BYTES),
    _protocols: allowedProtocols(options.protocols),
  };
  const state = createTransferState(normalizedOptions);
  const { response, status, target } = await openSafeRemoteResponse(inputUrl, normalizedOptions, state);
  const buffer = await consumeResponseBuffer(response, state);
  const text = buffer.toString('utf8').trim();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw remoteMediaError('invalid_json_response', '远程服务返回的内容不是有效 JSON。', { status });
    }
    assertJsonComplexity(data, normalizedOptions);
  }
  return {
    data,
    contentType: String(response.headers['content-type'] || ''),
    finalUrl: target.toString(),
    ok: status >= 200 && status < 300,
    status,
  };
}

function normalizedBodyParts(value) {
  const source = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  const parts = [];
  let byteLength = 0;
  for (const item of source) {
    const part = Buffer.isBuffer(item)
      ? item
      : (item instanceof Uint8Array ? Buffer.from(item.buffer, item.byteOffset, item.byteLength) : Buffer.from(String(item)));
    byteLength += part.length;
    if (!Number.isSafeInteger(byteLength)) throw remoteMediaError('upload_too_large', '上传请求体大小无效。');
    parts.push(part);
  }
  return { parts, byteLength };
}

/**
 * Send a request body only to a DNS-pinned globally-routable URL. Redirects are
 * never followed because replaying an upload body to a Provider-controlled
 * Location would create an SSRF primitive. The response body is still bounded.
 */
async function safeRemoteUpload(inputUrl, options = {}) {
  const method = String(options.method || 'PUT').trim().toUpperCase();
  if (method !== 'PUT' && method !== 'POST') {
    throw remoteMediaError('invalid_method', '远程上传只允许 POST 或 PUT。');
  }
  const normalizedOptions = { ...options, _protocols: allowedProtocols(options.protocols) };
  const target = parseRemoteUrl(inputUrl, normalizedOptions);
  const responseMaxBytes = positiveInteger(options.maxResponseBytes, DEFAULT_UPLOAD_RESPONSE_MAX_BYTES);
  const state = createTransferState({ ...normalizedOptions, maxBytes: responseMaxBytes, maxRedirects: 0 });
  const pinned = await withinDeadline(
    resolvePublicAddress(
      target.hostname,
      options.lookupImpl || dns.lookup,
      options.allowPrivateForTests,
      options.publicLookupImpl || resolveTunPublicDns,
      options.acceptTunFake !== false,
    ),
    state,
  );
  const body = normalizedBodyParts(options.bodyParts ?? options.body);
  const maxRequestBytes = positiveInteger(options.maxRequestBytes, 64 * 1024 * 1024);
  if (body.byteLength > maxRequestBytes) {
    throw remoteMediaError('upload_too_large', `上传请求体超过 ${maxRequestBytes} bytes 限制。`);
  }
  const headers = requestHeaders(normalizedOptions, true);
  headers['content-length'] = String(body.byteLength);
  const response = await issuePinnedRequest(target, pinned, headers, state, {
    method,
    bodyParts: body.parts,
    requireBodyCompletion: true,
  });
  const status = Number(response.statusCode || 0);
  const buffer = await consumeResponseBuffer(response, state);
  if (status >= 300 && status < 400) {
    throw remoteMediaError('upload_redirect_forbidden', '远程上传地址返回重定向，已拒绝重放请求体。', { status });
  }
  return {
    buffer,
    contentType: String(response.headers['content-type'] || ''),
    finalUrl: target.toString(),
    ok: status >= 200 && status < 300,
    status,
  };
}

async function openExclusiveDownloadTarget(targetPath) {
  const raw = String(targetPath || '');
  if (!raw || raw.includes('\0')) throw remoteMediaError('download_target_invalid', '下载目标路径无效。');
  const absolutePath = path.resolve(raw);
  let handle;
  let identity;
  try {
    handle = await fs.promises.open(absolutePath, 'wx', 0o600);
    identity = await handle.stat();
    await handle.chmod(0o600);
    return { absolutePath, handle, identity };
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch (_) {}
      try { await removeCreatedDownloadTarget(absolutePath, identity); } catch (_) {}
    }
    if (error?.code === 'EEXIST' || error?.code === 'ELOOP') {
      throw remoteMediaError('download_target_exists', '下载目标已存在或是符号链接，拒绝覆盖。');
    }
    throw remoteMediaError('download_target_open_failed', '无法安全创建下载目标。', { cause: error });
  }
}

async function removeCreatedDownloadTarget(absolutePath, identity) {
  try {
    const current = await fs.promises.lstat(absolutePath);
    if (current.isSymbolicLink()) return;
    if (identity && (current.dev !== identity.dev || current.ino !== identity.ino)) return;
    await fs.promises.unlink(absolutePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function writeWholeChunk(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
    if (!bytesWritten) throw remoteMediaError('download_write_failed', '远程资源写入未取得进展。');
    offset += bytesWritten;
  }
}

/**
 * Stream a DNS-pinned remote HTTP(S) response into a new caller-controlled file.
 *
 * Relevant options:
 *   protocols: ['https:'] (defaults to ['http:', 'https:'])
 *   maxBytes, maxRedirects, deadlineMs (absolute transfer budget), idleTimeoutMs
 *   accept, userAgent, headers, lookupImpl
 *
 * The target is opened with wx/0600 and is removed on every unsuccessful exit.
 * Resolves to { contentType, finalUrl, status, byteSize } without buffering the body.
 */
async function safeRemoteMediaDownload(inputUrl, targetPath, options = {}) {
  const normalizedOptions = { ...options, _protocols: allowedProtocols(options.protocols) };
  // Validate URL/protocol/userinfo before reserving a filesystem target.
  parseRemoteUrl(inputUrl, normalizedOptions);
  const state = createTransferState(normalizedOptions);
  const target = await openExclusiveDownloadTarget(targetPath);
  let response = null;
  let closed = false;
  try {
    const opened = await openSafeRemoteResponse(inputUrl, normalizedOptions, state);
    response = opened.response;
    const byteSize = await consumeResponse(response, state, (chunk) => writeWholeChunk(target.handle, chunk));
    await target.handle.sync();
    await target.handle.close();
    closed = true;
    return {
      contentType: String(response.headers['content-type'] || ''),
      finalUrl: opened.target.toString(),
      status: opened.status,
      byteSize,
    };
  } catch (error) {
    if (response) response.destroy();
    if (!closed) {
      try { await target.handle.close(); } catch (_) {}
      closed = true;
    }
    try {
      await removeCreatedDownloadTarget(target.absolutePath, target.identity);
    } catch (cleanupError) {
      if (error && typeof error === 'object') error.cleanupError = cleanupError;
    }
    throw error;
  } finally {
    if (!closed) {
      try { await target.handle.close(); } catch (_) {}
    }
  }
}

module.exports = {
  assertJsonComplexity,
  isLoopbackAddress,
  isPrivateAddress,
  isTunFakeAddress,
  normalizeAddress,
  resolvePublicAddress,
  resolveTunPublicDns,
  safeRemoteMediaDownload,
  safeRemoteMediaFetch,
  safeRemoteJsonFetch,
  safeRemoteUpload,
};
