const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compatibilitySnapshot } = require('./agentControlCompatibility');

const AGENT_CONTROL_PROTOCOL = 't8-agent-control-v1';
const AGENT_CONTROL_INSTANCE_SCHEMA = 't8-agent-control-instance-v1';
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 20_000;

function safeInstanceId(value) {
  const normalized = String(value || '').trim();
  return /^[A-Za-z0-9_-]{43,128}$/.test(normalized) ? normalized : '';
}

function resolveAgentControlRegistryDir(env = process.env, homeDir = os.homedir()) {
  const explicit = String(env.ZCANVAS_INSTANCE_DIR || '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(homeDir || process.cwd(), '.zcanvas', 'instances');
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch (_) {}
}

function writeJsonAtomic(targetPath, value) {
  const directory = path.dirname(targetPath);
  ensurePrivateDirectory(directory);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  try { fs.chmodSync(temporaryPath, 0o600); } catch (_) {}
  try {
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch (_) {}
    throw error;
  }
}

function instanceDescriptor(config, now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS) {
  const instanceId = safeInstanceId(config?.BACKEND_INSTANCE_ID);
  if (!instanceId) throw new Error('Agent Control instanceId 无效');
  const port = Number(config?.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Agent Control 端口无效');
  const host = String(config?.HOST || '').trim();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Agent Control 只允许本机地址');
  const originHost = host === '::1' ? '[::1]' : host;
  const origin = `http://${originHost}:${port}`;
  const compatibility = compatibilitySnapshot();
  return {
    schema: AGENT_CONTROL_INSTANCE_SCHEMA,
    instanceId,
    pid: process.pid,
    origin,
    statusUrl: `${origin}/api/status`,
    appVersion: String(config?.APP_VERSION || '0.0.0-dev'),
    controlProtocol: AGENT_CONTROL_PROTOCOL,
    ...compatibility,
    heartbeatAt: new Date(now).toISOString(),
    staleAfterMs,
  };
}

function registerAgentControlInstance(config, options = {}) {
  const registryDir = resolveAgentControlRegistryDir(options.env, options.homeDir);
  const instanceId = safeInstanceId(config?.BACKEND_INSTANCE_ID);
  if (!instanceId) throw new Error('Agent Control instanceId 无效');
  const descriptorPath = path.join(registryDir, `${instanceId}.json`);
  const heartbeatMs = Math.max(1_000, Math.min(30_000, Number(options.heartbeatMs) || DEFAULT_HEARTBEAT_MS));
  const staleAfterMs = Math.max(
    heartbeatMs * 2,
    Math.min(120_000, Number(options.staleAfterMs) || DEFAULT_STALE_AFTER_MS),
  );
  let stopped = false;

  const heartbeat = () => {
    if (stopped) return;
    writeJsonAtomic(descriptorPath, instanceDescriptor(config, Date.now(), staleAfterMs));
  };

  heartbeat();
  const timer = setInterval(heartbeat, heartbeatMs);
  timer.unref?.();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      const current = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
      if (current?.schema === AGENT_CONTROL_INSTANCE_SCHEMA
        && current.instanceId === instanceId
        && Number(current.pid) === process.pid) {
        fs.unlinkSync(descriptorPath);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };

  return {
    registryDir,
    descriptorPath,
    heartbeat,
    stop,
  };
}

module.exports = {
  AGENT_CONTROL_INSTANCE_SCHEMA,
  AGENT_CONTROL_PROTOCOL,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_STALE_AFTER_MS,
  instanceDescriptor,
  registerAgentControlInstance,
  resolveAgentControlRegistryDir,
  safeInstanceId,
  writeJsonAtomic,
};
