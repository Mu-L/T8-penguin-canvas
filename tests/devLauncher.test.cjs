'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { waitForLocalService } = require('../scripts/wait-for-local-service.cjs');

test('development launcher waits for backend before frontend and browser', () => {
  const launcherPath = path.join(__dirname, '..', 'start-dev.bat');
  const launcherBytes = fs.readFileSync(launcherPath);
  const launcher = launcherBytes.toString('utf8');
  const newlineCount = (launcher.match(/\n/g) || []).length;
  const windowsNewlineCount = (launcher.match(/\r\n/g) || []).length;
  const backendWait = launcher.indexOf('18766/api/status');
  const frontendStart = launcher.indexOf('npm run dev:vite');
  const frontendWait = launcher.indexOf('127.0.0.1:11422/');
  const browserOpen = launcher.lastIndexOf('start "" "http://127.0.0.1:11422"');

  assert.ok(backendWait >= 0);
  assert.ok(backendWait < frontendStart);
  assert.ok(frontendStart < frontendWait);
  assert.ok(frontendWait < browserOpen);
  assert.doesNotMatch(launcher, /timeout \/t [23] >nul/);
  assert.equal(
    windowsNewlineCount,
    newlineCount,
    'start-dev.bat must use CRLF consistently because cmd.exe can concatenate bare-LF commands',
  );
});

test('local service waiter tolerates startup refusal/status errors until service is ready', async (t) => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.statusCode = requests < 3 ? 503 : 200;
    response.end(requests < 3 ? 'starting' : 'ready');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const result = await waitForLocalService({
    url: `http://127.0.0.1:${address.port}/status`,
    timeoutMs: 2_000,
    intervalMs: 10,
    requestTimeoutMs: 200,
    label: '测试服务',
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.attempts, 3);
});
