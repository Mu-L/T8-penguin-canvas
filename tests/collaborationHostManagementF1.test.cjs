const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInviteUrls,
  collaborationBaseUrl,
  ipv4Scope,
  listNetworkInterfaces,
  normalizeBindHost,
  shareUrlsForHost,
  validateBindHost,
} = require('../backend/src/collaboration/hostManagement');

const SOURCE_INTERFACES = {
  Ethernet: [
    { family: 'IPv4', address: '192.168.50.20', internal: false, cidr: '192.168.50.20/24' },
    { family: 'IPv6', address: 'fe80::1', internal: false, cidr: 'fe80::1/64' },
  ],
  VPN: [
    { family: 4, address: '100.64.2.5', internal: false, cidr: '100.64.2.5/10' },
  ],
  Public: [
    { family: 'IPv4', address: '203.0.113.10', internal: false, cidr: '203.0.113.10/32' },
  ],
  LinkLocal: [
    { family: 'IPv4', address: '169.254.20.8', internal: false },
  ],
};

test('F1 host management enumerates only IPv4 interfaces, classifies them, and keeps wildcard explicit', () => {
  const interfaces = listNetworkInterfaces(SOURCE_INTERFACES);

  assert.deepEqual(
    interfaces.map((entry) => [entry.address, entry.scope]),
    [
      ['192.168.50.20', 'private'],
      ['100.64.2.5', 'private'],
      ['203.0.113.10', 'public'],
      ['169.254.20.8', 'link-local'],
      ['127.0.0.1', 'loopback'],
      ['0.0.0.0', 'wildcard'],
    ],
  );
  assert.equal(interfaces.some((entry) => entry.family !== 'IPv4'), false);
  assert.match(interfaces[0].label, /局域网/);
  assert.match(interfaces.at(-1).label, /谨慎使用/);
  assert.equal(interfaces.at(-1).id, 'all-ipv4:0.0.0.0');
});

test('F1 IPv4 classification covers private, carrier-grade NAT, loopback, link-local, and public boundaries', () => {
  const cases = new Map([
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.15.255.255', 'public'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['100.127.255.255', 'private'],
    ['100.63.255.255', 'public'],
    ['100.128.0.1', 'public'],
    ['127.0.0.1', 'loopback'],
    ['169.254.1.1', 'link-local'],
    ['203.0.113.10', 'public'],
  ]);

  for (const [address, expected] of cases) {
    assert.equal(ipv4Scope(address), expected, address);
  }
  assert.equal(ipv4Scope('10.0.0.1', true), 'loopback');
});

test('F1 bind validation accepts only loopback, wildcard, or an enumerated local IPv4 address', () => {
  const interfaces = listNetworkInterfaces(SOURCE_INTERFACES);

  assert.equal(normalizeBindHost(''), '127.0.0.1');
  assert.equal(normalizeBindHost(' localhost '), '127.0.0.1');
  assert.equal(validateBindHost('localhost', interfaces), '127.0.0.1');
  assert.equal(validateBindHost('0.0.0.0', interfaces), '0.0.0.0');
  assert.equal(validateBindHost('::1', interfaces), '::1');
  assert.equal(validateBindHost('192.168.50.20', interfaces), '192.168.50.20');
  assert.equal(validateBindHost('100.64.2.5', interfaces), '100.64.2.5');

  assert.throws(
    () => validateBindHost('192.168.50.21', interfaces),
    /当前设备上的 IPv4 网卡地址/,
  );
  assert.throws(
    () => validateBindHost('collaboration.example', interfaces),
    /当前设备上的 IPv4 网卡地址/,
  );
});

test('F1 share URLs use the selected host, expand wildcard deterministically, and format IPv6 safely', () => {
  const interfaces = listNetworkInterfaces({
    Ethernet: [
      { family: 'IPv4', address: '192.168.50.20', internal: false },
      { family: 'IPv4', address: '192.168.50.20', internal: false },
    ],
    VPN: [{ family: 'IPv4', address: '100.64.2.5', internal: false }],
    Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  });

  assert.deepEqual(
    shareUrlsForHost('192.168.50.20', 18767, interfaces),
    ['http://192.168.50.20:18767/collab'],
  );
  assert.deepEqual(
    shareUrlsForHost('0.0.0.0', 18767, interfaces),
    [
      'http://192.168.50.20:18767/collab',
      'http://100.64.2.5:18767/collab',
      'http://127.0.0.1:18767/collab',
    ],
  );
  assert.deepEqual(shareUrlsForHost('127.0.0.1', 0, interfaces), []);
  assert.equal(collaborationBaseUrl('::1', 18767), 'http://[::1]:18767/collab');
});

test('F1 invite URLs preserve the collaboration path and encode invite plus canvas scope', () => {
  const urls = buildInviteUrls(
    [
      'http://192.168.50.20:18767/collab',
      'https://canvas.example/collab',
    ],
    'code +/?:中文',
    'canvas/a?b',
  );

  assert.equal(urls.length, 2);
  for (const value of urls) {
    const url = new URL(value);
    assert.equal(url.pathname, '/collab');
    assert.equal(url.searchParams.get('invite'), 'code +/?:中文');
    assert.equal(url.searchParams.get('canvas'), 'canvas/a?b');
  }
  assert.deepEqual(buildInviteUrls([], 'code', 'canvas'), []);
});
