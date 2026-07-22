'use strict';

const http = require('node:http');
const https = require('node:https');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function probeLocalService(url, requestTimeoutMs = 1_500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      finish({ ok: false, reason: error instanceof Error ? error.message : 'URL 无效' });
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.get(parsed, {
      headers: { connection: 'close' },
      timeout: requestTimeoutMs,
    }, (response) => {
      response.resume();
      const statusCode = Number(response.statusCode || 0);
      finish({
        ok: statusCode >= 200 && statusCode < 400,
        statusCode,
        reason: statusCode ? `HTTP ${statusCode}` : '没有 HTTP 状态码',
      });
    });
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', (error) => finish({
      ok: false,
      reason: String(error?.code || error?.message || '连接失败'),
    }));
  });
}

async function waitForLocalService({
  url,
  timeoutMs = 60_000,
  intervalMs = 250,
  requestTimeoutMs = 1_500,
  label = '本地服务',
}) {
  const startedAt = Date.now();
  let attempts = 0;
  let lastReason = '尚未连接';
  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    const probe = await probeLocalService(url, requestTimeoutMs);
    if (probe.ok) {
      return { attempts, elapsedMs: Date.now() - startedAt, statusCode: probe.statusCode || 0 };
    }
    lastReason = probe.reason || lastReason;
    await delay(intervalMs);
  }
  throw new Error(`${label}在 ${Math.ceil(timeoutMs / 1000)} 秒内未就绪（最后状态：${lastReason}）`);
}

async function main(argv = process.argv.slice(2)) {
  const url = String(argv[0] || '').trim();
  const timeoutMs = Math.max(1_000, Number(argv[1]) || 60_000);
  const label = String(argv[2] || '本地服务').trim() || '本地服务';
  if (!url) throw new Error('缺少待检测的本地服务 URL');
  process.stdout.write(`[启动检查] 等待${label}就绪: ${url}\n`);
  const result = await waitForLocalService({ url, timeoutMs, label });
  process.stdout.write(`[启动检查] ${label}已就绪（HTTP ${result.statusCode}，${result.elapsedMs} ms）\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[启动检查] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  probeLocalService,
  waitForLocalService,
};
