const os = require('os');

function normalizeIpv4Family(value) {
  return value === 'IPv4' || value === 4;
}

function ipv4Scope(address, internal = false) {
  const value = String(address || '').trim();
  if (internal || /^127\./.test(value)) return 'loopback';
  if (/^169\.254\./.test(value)) return 'link-local';
  const parts = value.split('.').map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    if (parts[0] === 10) return 'private';
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return 'private';
    if (parts[0] === 192 && parts[1] === 168) return 'private';
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return 'private';
  }
  return 'public';
}

function interfaceLabel(entry) {
  if (entry.address === '0.0.0.0') return '全部 IPv4 网卡（谨慎使用）';
  const scopeLabels = {
    loopback: '仅本机',
    private: '局域网',
    'link-local': '链路本地',
    public: '公网地址',
  };
  return `${entry.name} · ${entry.address} · ${scopeLabels[entry.scope] || entry.scope}`;
}

function listNetworkInterfaces(source = os.networkInterfaces()) {
  const entries = [];
  for (const [name, addresses] of Object.entries(source || {})) {
    for (const address of Array.isArray(addresses) ? addresses : []) {
      if (!normalizeIpv4Family(address?.family)) continue;
      const value = String(address.address || '').trim();
      if (!value) continue;
      const entry = {
        id: `${name}:${value}`,
        name: String(name),
        address: value,
        family: 'IPv4',
        internal: Boolean(address.internal),
        cidr: address.cidr ? String(address.cidr) : null,
        scope: ipv4Scope(value, Boolean(address.internal)),
      };
      entries.push({ ...entry, label: interfaceLabel(entry) });
    }
  }

  if (!entries.some((entry) => entry.address === '127.0.0.1')) {
    const loopback = {
      id: 'loopback:127.0.0.1',
      name: '本机回环',
      address: '127.0.0.1',
      family: 'IPv4',
      internal: true,
      cidr: '127.0.0.1/8',
      scope: 'loopback',
    };
    entries.push({ ...loopback, label: interfaceLabel(loopback) });
  }

  entries.sort((left, right) => {
    const leftRank = left.scope === 'private' ? 0 : left.scope === 'public' ? 1 : left.scope === 'link-local' ? 2 : 3;
    const rightRank = right.scope === 'private' ? 0 : right.scope === 'public' ? 1 : right.scope === 'link-local' ? 2 : 3;
    return leftRank - rightRank
      || left.name.localeCompare(right.name, 'zh-CN')
      || left.address.localeCompare(right.address);
  });

  const wildcard = {
    id: 'all-ipv4:0.0.0.0',
    name: '全部 IPv4 网卡',
    address: '0.0.0.0',
    family: 'IPv4',
    internal: false,
    cidr: null,
    scope: 'wildcard',
  };
  return [...entries, { ...wildcard, label: interfaceLabel(wildcard) }];
}

function normalizeBindHost(value) {
  const host = String(value || '').trim();
  if (!host || host.toLowerCase() === 'localhost') return '127.0.0.1';
  return host;
}

function validateBindHost(value, interfaces = listNetworkInterfaces()) {
  const host = normalizeBindHost(value);
  if (host === '0.0.0.0' || host === '127.0.0.1' || host === '::1') return host;
  if (interfaces.some((entry) => entry.family === 'IPv4' && entry.address === host && entry.address !== '0.0.0.0')) return host;
  throw new Error('协作监听地址必须是当前设备上的 IPv4 网卡地址');
}

function formatHostForUrl(host) {
  return String(host).includes(':') ? `[${host}]` : String(host);
}

function collaborationBaseUrl(host, port) {
  return `http://${formatHostForUrl(host)}:${Number(port)}/collab`;
}

function shareUrlsForHost(host, port, interfaces = listNetworkInterfaces()) {
  const normalizedHost = normalizeBindHost(host);
  if (!Number.isInteger(Number(port)) || Number(port) <= 0) return [];
  if (normalizedHost === '0.0.0.0') {
    const addresses = interfaces
      .filter((entry) => entry.family === 'IPv4' && entry.address !== '0.0.0.0')
      .map((entry) => entry.address);
    return [...new Set(addresses)].map((address) => collaborationBaseUrl(address, port));
  }
  return [collaborationBaseUrl(normalizedHost, port)];
}

function buildInviteUrls(baseUrls, code, canvasId) {
  return (Array.isArray(baseUrls) ? baseUrls : []).map((baseUrl) => {
    const url = new URL(baseUrl);
    url.searchParams.set('invite', String(code || ''));
    if (canvasId) url.searchParams.set('canvas', String(canvasId));
    return url.toString();
  });
}

module.exports = {
  buildInviteUrls,
  collaborationBaseUrl,
  ipv4Scope,
  listNetworkInterfaces,
  normalizeBindHost,
  shareUrlsForHost,
  validateBindHost,
};
