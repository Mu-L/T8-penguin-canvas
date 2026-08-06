'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { app, session } = require('electron');

const {
  installChromiumResponseHeaderBridge,
} = require('../../electron/systemFetchBridge.cjs');

process.on('uncaughtException', (error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  app.exit(86);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

app.whenReady().then(async () => {
  const unicodePath = 'C:\\Users\\自定义用户\\AppData\\Roaming\\T8-PenguinCanvas\\输出图.png';
  const disposition = `attachment; filename="${unicodePath}"`;
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.end(Buffer.concat([
        Buffer.from('HTTP/1.1 200 OK\r\nContent-Disposition: ', 'ascii'),
        Buffer.from(disposition, 'utf8'),
        Buffer.from('\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok', 'ascii'),
      ]));
    });
  });
  try {
    if (process.env.T8_TEST_SKIP_HEADER_BRIDGE !== '1') {
      installChromiumResponseHeaderBridge(session.defaultSession);
    }
    const address = await listen(server);
    const response = await session.defaultSession.fetch(`http://127.0.0.1:${address.port}/unicode-path`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
    const received = response.headers.get('content-disposition');
    assert.ok(received);
    assert.equal(Buffer.from(received, 'latin1').toString('utf8'), disposition);
    process.stdout.write(JSON.stringify({ ok: true, status: response.status }));
    await close(server);
    app.quit();
  } catch (error) {
    try { await close(server); } catch (_) {}
    process.stderr.write(`${error?.stack || error}\n`);
    app.exit(1);
  }
});
