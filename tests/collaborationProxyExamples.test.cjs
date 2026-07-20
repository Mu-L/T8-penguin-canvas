const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')
  .replace(/\r\n?/g, '\n');

function assertBalancedBraces(source, label) {
  let depth = 0;
  for (const character of source.replace(/#[^\n]*/g, '')) {
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    assert.ok(depth >= 0, `${label} closes a block before it opens`);
  }
  assert.equal(depth, 0, `${label} has an unclosed block`);
}

test('F9 Nginx example terminates HTTPS and preserves WebSocket, upload, and proxy identity contracts', () => {
  const source = read('deploy/collaboration/nginx.conf.example');
  assertBalancedBraces(source, 'nginx example');
  assert.match(source, /return 308 https:\/\/\$host\$request_uri;/);
  assert.match(source, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
  assert.match(source, /proxy_pass http:\/\/t8_collaboration_gateway;/);
  assert.match(source, /proxy_http_version 1\.1;/);
  assert.match(source, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(source, /proxy_set_header Connection \$connection_upgrade;/);
  assert.match(source, /proxy_set_header X-Forwarded-Proto https;/);
  assert.match(source, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
  assert.match(source, /proxy_request_buffering off;/);
  assert.match(source, /proxy_buffering off;/);
  assert.match(source, /client_max_body_size 512m;/);
  assert.doesNotMatch(source, /proxy_pass\s+http:\/\/0\.0\.0\.0/);
  assert.doesNotMatch(source, /ssl_verify\s+off|Access-Control-Allow-Origin\s+["']?\*/i);
});

test('F9 Caddy example keeps automatic TLS, bounded bodies, and exact forwarded scheme', () => {
  const source = read('deploy/collaboration/Caddyfile.example');
  assertBalancedBraces(source, 'Caddy example');
  assert.match(source, /^canvas\.example\.com \{/m);
  assert.match(source, /max_size 512MB/);
  assert.match(source, /reverse_proxy 127\.0\.0\.1:18767/);
  assert.match(source, /header_up X-Forwarded-Proto https/);
  assert.match(source, /Strict-Transport-Security "max-age=31536000"/);
  assert.doesNotMatch(source, /tls\s+internal|auto_https\s+off|Access-Control-Allow-Origin\s+["']?\*/i);
});

test('F9 deployment guide freezes loopback, exact trusted proxy, and five-part public self-check', () => {
  const source = read('docs/collaboration-public-deployment.md');
  assert.match(source, /T8_COLLAB_HOST=127\.0\.0\.1/);
  assert.match(source, /T8_COLLAB_PUBLIC_BASE_URL=https:\/\/canvas\.example\.com\/collab/);
  assert.match(source, /T8_COLLAB_TRUST_PROXY_ADDRESSES=127\.0\.0\.1,::1/);
  assert.match(source, /真实客户端 IP 和已认证 session 分层计费/);
  assert.match(source, /T8_COLLAB_RATE_LIMIT_MAX_BUCKETS/);
  assert.match(source, /稳定 `1013`/);
  assert.match(source, /GET \/api\/collab\/health/);
  assert.match(source, /邀请兑换/);
  assert.match(source, /\/ws\/collab/);
  assert.match(source, /小型上传/);
  assert.match(source, /Range/);
  assert.match(source, /不会写入项目素材或协作成员数据/);
});
