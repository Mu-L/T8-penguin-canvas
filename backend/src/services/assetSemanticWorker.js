'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const defaultConfig = require('../config');
const {
  ensureRuntimeArchiveExtracted,
  getRuntimeArchiveInfo,
  getRuntimeCachePath,
} = require('../utils/runtimeArchive');
const {
  SEMANTIC_TASKS,
  assertSemanticModelId,
  getPublicSemanticModel,
  getPublicSemanticModelManifest,
  getTrustedSemanticModelSpec,
} = require('./assetSemanticModels');

const DEFAULT_EXECUTE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 60_000;
const ABORT_KILL_GRACE_MS = 1_000;
const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_TEXT_CHARS = 8_192;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const INSTALL_MARKER = '.t8-semantic-model.json';
const DOWNLOAD_OWNER_MARKER = '.t8-semantic-download-owner.json';
const DEFAULT_ORPHAN_TTL_MS = 24 * 60 * 60_000;
const MAX_ORPHAN_CANDIDATES = 512;
const FORBIDDEN_REQUEST_FIELDS = /^(?:repo(?:sitory)?|url|revision|modelPath|cachePath|stagingDir|weight|sha256)$/i;

function semanticError(code, message, name = 'Error') {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  return error;
}

function abortError() {
  return semanticError('asset-semantic-aborted', '已停止语义模型任务', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function sanitizeSemanticError(error) {
  const candidate = String(error?.code || 'asset-semantic-failed').trim().slice(0, 120);
  const code = (/^(?:sk-|bearer\b)/i.test(candidate) ? '' : candidate)
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'asset-semantic-failed';
  const message = String(error?.message || error || '语义模型任务失败')
    .replace(/\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})\b/gi, '[redacted]')
    .replace(/[A-Za-z]:\\[^\r\n"'`]+/g, '[local-path]')
    .replace(/\\\\[^\r\n"'`]+/g, '[local-path]')
    .replace(/(^|\s)\/(?:Users|home|tmp|var|private|mnt)\/[^\r\n"'`]+/gi, '$1[local-path]')
    .replace(/https?:\/\/[^\s"'`]+/gi, '[remote-url]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600) || '语义模型任务失败';
  return { code, message };
}

function isInside(parent, child) {
  const root = path.resolve(parent);
  const target = path.resolve(child);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function assertInside(parent, child) {
  if (!isInside(parent, child)) {
    throw semanticError('asset-semantic-path-invalid', '语义模型缓存目录异常');
  }
}

function clampTimeout(value, fallback, maximum) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed)
    ? Math.max(100, Math.min(maximum, parsed))
    : fallback;
}

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (_) {
    return null;
  }
}

function stat(filename) {
  try {
    return fs.statSync(filename);
  } catch (_) {
    return null;
  }
}

function lstat(filename) {
  try {
    return fs.lstatSync(filename);
  } catch (_) {
    return null;
  }
}

function safeUnlinkTree(root, target) {
  assertInside(root, target);
  if (path.resolve(root) === path.resolve(target)) {
    throw semanticError('asset-semantic-path-invalid', '拒绝删除语义模型缓存根目录');
  }
  const targetStat = lstat(target);
  if (!targetStat) return;
  if (targetStat.isSymbolicLink()) {
    throw semanticError('asset-semantic-model-link-rejected', '拒绝删除符号链接形式的语义模型目录');
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}

function assertSafeDirectory(directory, { create = false, label = '语义模型目录' } = {}) {
  let current = lstat(directory);
  if (!current && create) {
    fs.mkdirSync(directory, { recursive: false });
    current = lstat(directory);
  }
  if (!current || !current.isDirectory() || current.isSymbolicLink()) {
    throw semanticError('asset-semantic-model-link-rejected', `${label}必须是本机普通目录`);
  }
  return current;
}

function processAppearsAlive(pid) {
  const normalized = Math.trunc(Number(pid));
  if (!Number.isInteger(normalized) || normalized <= 0) return false;
  if (normalized === process.pid) return true;
  try {
    process.kill(normalized, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function controlledOrphanName(name, location) {
  const escapedIds = getPublicSemanticModelManifest()
    .map((model) => model.modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const pattern = location === 'downloads'
    ? new RegExp(`^(?:${escapedIds})-${uuid}$`, 'i')
    : new RegExp(`^\\.(?:replaced|removed)-(?:${escapedIds})-${uuid}$`, 'i');
  return pattern.test(String(name || ''));
}

function readDirectoryEntriesBounded(directory, maximum = MAX_ORPHAN_CANDIDATES) {
  const entries = [];
  const handle = fs.opendirSync(directory);
  try {
    while (entries.length < maximum) {
      const entry = handle.readSync();
      if (!entry) break;
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
  return entries;
}

function cleanupSemanticModelOrphans(modelRoot, options = {}) {
  const root = path.resolve(modelRoot);
  assertSafeDirectory(root, { label: '语义模型缓存根目录' });
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const ttlMs = Math.max(60_000, Number(options.ttlMs) || DEFAULT_ORPHAN_TTL_MS);
  const warn = typeof options.onWarning === 'function' ? options.onWarning : () => {};
  const candidates = [];
  const downloadsRoot = path.join(root, '.downloads');
  const downloadsStat = lstat(downloadsRoot);
  if (downloadsStat) {
    if (!downloadsStat.isDirectory() || downloadsStat.isSymbolicLink()) {
      warn('语义模型下载暂存根目录不是普通目录，已拒绝清理');
    } else {
      for (const entry of readDirectoryEntriesBounded(downloadsRoot)) {
        if (controlledOrphanName(entry.name, 'downloads')) {
          candidates.push({ root: downloadsRoot, target: path.join(downloadsRoot, entry.name), download: true });
        }
      }
    }
  }
  for (const entry of readDirectoryEntriesBounded(root)) {
    if (controlledOrphanName(entry.name, 'model-root')) {
      candidates.push({ root, target: path.join(root, entry.name), download: false });
    }
  }
  let removed = 0;
  let skipped = 0;
  for (const candidate of candidates.slice(0, MAX_ORPHAN_CANDIDATES)) {
    try {
      assertInside(candidate.root, candidate.target);
      const candidateStat = lstat(candidate.target);
      if (!candidateStat || !candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if ((now - candidateStat.mtimeMs) < ttlMs) {
        skipped += 1;
        continue;
      }
      if (candidate.download) {
        const ownerPath = path.join(candidate.target, DOWNLOAD_OWNER_MARKER);
        const ownerStat = lstat(ownerPath);
        if (ownerStat?.isSymbolicLink()) {
          skipped += 1;
          continue;
        }
        const owner = ownerStat?.isFile() ? readJson(ownerPath) : null;
        if (owner && processAppearsAlive(owner.pid)) {
          skipped += 1;
          continue;
        }
      }
      assertNoLinks(candidate.target);
      safeUnlinkTree(candidate.root, candidate.target);
      removed += 1;
    } catch (error) {
      skipped += 1;
      warn(sanitizeSemanticError(error).message);
    }
  }
  return { removed, skipped, inspected: candidates.length };
}

function assertNoLinks(root, maximumEntries = 20_000) {
  const queue = [path.resolve(root)];
  let inspected = 0;
  while (queue.length) {
    const current = queue.shift();
    const currentStat = lstat(current);
    if (!currentStat || currentStat.isSymbolicLink()) {
      throw semanticError('asset-semantic-model-link-rejected', '模型目录包含不允许的符号链接');
    }
    if (!currentStat.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      throw semanticError('asset-semantic-model-invalid', '无法读取语义模型目录');
    }
    for (const entry of entries) {
      inspected += 1;
      if (inspected > maximumEntries) {
        throw semanticError('asset-semantic-model-too-complex', '语义模型目录文件数量超出限制');
      }
      const filename = path.join(current, entry.name);
      const entryStat = lstat(filename);
      if (!entryStat || entryStat.isSymbolicLink()) {
        throw semanticError('asset-semantic-model-link-rejected', '模型目录包含不允许的符号链接');
      }
      if (entryStat.isDirectory()) queue.push(filename);
    }
  }
}

function directoryBytes(root, maximumEntries = 20_000) {
  if (!fs.existsSync(root)) return 0;
  const rootStat = lstat(root);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return 0;
  const queue = [path.resolve(root)];
  let total = 0;
  let inspected = 0;
  while (queue.length) {
    const current = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      inspected += 1;
      if (inspected > maximumEntries) return total;
      const filename = path.join(current, entry.name);
      const entryStat = lstat(filename);
      if (!entryStat || entryStat.isSymbolicLink()) continue;
      if (entryStat.isDirectory()) queue.push(filename);
      else if (entryStat.isFile()) total += entryStat.size;
    }
  }
  return total;
}

function hashFileSha256(filename, options = {}) {
  const signal = options.signal;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash('sha256');
    const stream = fs.createReadStream(filename, { highWaterMark: 4 * 1024 * 1024 });
    let settled = false;
    let completedDigest = null;
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      const error = abortError();
      stream.destroy(error);
      finish(reject, error);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', (error) => finish(reject, error));
    // On Windows the readable `end` event can precede release of the file
    // handle. Resolve only after `close` so the verified staging directory can
    // be renamed atomically without a transient EPERM.
    stream.on('end', () => { completedDigest = digest.digest('hex'); });
    stream.on('close', () => {
      if (completedDigest !== null) finish(resolve, completedDigest);
    });
  });
}

const SEMANTIC_CHILD_ENV_ALLOWLIST = new Set([
  'ALLUSERSPROFILE', 'APPDATA', 'COMSPEC', 'HOME', 'LANG', 'LANGUAGE', 'LC_ALL',
  'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'PROGRAMDATA', 'SYSTEMROOT',
  'TEMP', 'TERM', 'TMP', 'TMPDIR', 'USERPROFILE', 'WINDIR',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'HF_HOME', 'HF_HUB_CACHE', 'HUGGINGFACE_HUB_CACHE', 'TRANSFORMERS_CACHE', 'TORCH_HOME',
  'XDG_CACHE_HOME', 'HF_HUB_DISABLE_XET', 'HF_XET_HIGH_PERFORMANCE', 'HF_HUB_ENABLE_HF_TRANSFER',
  'CUDA_VISIBLE_DEVICES', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS',
  'NUMEXPR_NUM_THREADS', 'KMP_DUPLICATE_LIB_OK', 'PYTHONUTF8', 'PYTHONIOENCODING', 'T8PC_RES',
]);
const SEMANTIC_PROXY_ENV = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']);
const SEMANTIC_SECRET_ENV_PATTERN = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTH(?:ORIZATION)?|COOKIE|CREDENTIAL|SESSION|^AWS_|^AZURE_|^GOOGLE_|^OPENAI_|^ANTHROPIC_)/i;

function safeProxyEnvironmentValue(name, value) {
  const text = String(value || '').trim().slice(0, 4_096);
  if (!text) return '';
  if (name === 'NO_PROXY') return /[\r\n]/.test(text) ? '' : text;
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:', 'socks:', 'socks5:', 'socks5h:'].includes(parsed.protocol)
      || parsed.username || parsed.password) return '';
    return parsed.toString();
  } catch (_) {
    return '';
  }
}

function semanticChildEnv({ offline = false } = {}) {
  const env = {};
  for (const [key, rawValue] of Object.entries(process.env)) {
    const normalizedKey = String(key).toUpperCase();
    if (SEMANTIC_SECRET_ENV_PATTERN.test(normalizedKey)) continue;
    if (SEMANTIC_CHILD_ENV_ALLOWLIST.has(normalizedKey)) {
      env[key] = String(rawValue || '');
      continue;
    }
    if (!offline && SEMANTIC_PROXY_ENV.has(normalizedKey)) {
      const proxy = safeProxyEnvironmentValue(normalizedKey, rawValue);
      if (proxy) env[key] = proxy;
    }
  }
  env.HF_HUB_DISABLE_TELEMETRY = '1';
  env.TOKENIZERS_PARALLELISM = 'false';
  env.PYTHONDONTWRITEBYTECODE = '1';
  if (offline) {
    env.HF_HUB_OFFLINE = '1';
    env.TRANSFORMERS_OFFLINE = '1';
  } else {
    delete env.HF_HUB_OFFLINE;
    delete env.TRANSFORMERS_OFFLINE;
  }
  return env;
}

function publicProgress(progress) {
  if (!progress) return null;
  return {
    modelId: progress.modelId,
    state: progress.state,
    downloadedBytes: Math.max(0, Math.min(Number(progress.totalBytes) || 0, Number(progress.downloadedBytes) || 0)),
    totalBytes: Math.max(0, Number(progress.totalBytes) || 0),
    percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
    ...(progress.startedAt ? { startedAt: progress.startedAt } : {}),
    ...(progress.completedAt ? { completedAt: progress.completedAt } : {}),
    ...(progress.error ? { error: { ...progress.error } } : {}),
  };
}

function parseSingleJsonOutput(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) {
    throw semanticError('asset-semantic-protocol-invalid', '语义运行时返回了无效的输出帧');
  }
  let value;
  try {
    value = JSON.parse(lines[0]);
  } catch (_) {
    throw semanticError('asset-semantic-protocol-invalid', '语义运行时返回了无效 JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw semanticError('asset-semantic-protocol-invalid', '语义运行时返回了无效对象');
  }
  return value;
}

function validateExecutionResult(modelId, task, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.task !== task) {
    throw semanticError('asset-semantic-result-invalid', '语义 worker 返回了无效任务结果');
  }
  if (task === SEMANTIC_TASKS.EMBEDDING) {
    const expectedDimension = getTrustedSemanticModelSpec(modelId).embeddingDimension;
    if (result.dimension !== expectedDimension
      || !Array.isArray(result.vector)
      || result.vector.length !== expectedDimension
      || result.vector.some((value) => !Number.isFinite(value) || Math.abs(value) > 1.000001)) {
      throw semanticError('asset-semantic-result-invalid', '语义 worker 返回了无效向量');
    }
    const norm = Math.sqrt(result.vector.reduce((total, value) => total + (value * value), 0));
    if (!Number.isFinite(norm) || norm < 0.98 || norm > 1.02) {
      throw semanticError('asset-semantic-result-invalid', '语义 worker 返回的向量未归一化');
    }
    if (!Number.isInteger(result.textLength) || result.textLength < 1 || result.textLength > MAX_TEXT_CHARS) {
      throw semanticError('asset-semantic-result-invalid', '语义 worker 返回了无效文本长度');
    }
    return {
      task,
      textLength: result.textLength,
      dimension: expectedDimension,
      vector: result.vector.map(Number),
    };
  }
  const maximumText = task === SEMANTIC_TASKS.CAPTION ? 512 : 8_192;
  if (typeof result.text !== 'string' || result.text.length > maximumText) {
    throw semanticError('asset-semantic-result-invalid', '语义 worker 返回了无效文本');
  }
  if (task === SEMANTIC_TASKS.CAPTION) {
    if (result.caption !== result.text) {
      throw semanticError('asset-semantic-result-invalid', '语义 worker 返回了不一致的图像描述');
    }
    return { task, text: result.text, caption: result.text };
  }
  if (!Array.isArray(result.lines)
    || result.lines.length > 16
    || result.lines.some((line) => typeof line !== 'string' || line.length > 512)
    || result.lineCount !== result.lines.length
    || result.lines.join('\n').slice(0, maximumText) !== result.text) {
    throw semanticError('asset-semantic-result-invalid', '语义 worker 返回了无效 OCR 行结果');
  }
  return {
    task,
    text: result.text,
    lines: [...result.lines],
    lineCount: result.lineCount,
  };
}

class AssetSemanticWorker {
  constructor(config = defaultConfig, options = {}) {
    this.config = config || defaultConfig;
    this.options = options;
    const dataRoot = this.config.DATA_DIR || path.join(this.config.BASE_DIR || process.cwd(), 'data');
    this.modelRoot = path.resolve(
      options.modelRoot
      || this.config.ASSET_SEMANTIC_MODELS_DIR
      || path.join(dataRoot, 'semantic-models'),
    );
    this.runnerPath = path.resolve(options.runnerPath || this._defaultRunnerPath());
    this.pythonCommand = options.pythonCommand ? path.resolve(String(options.pythonCommand)) : '';
    this.pythonPrefix = Array.isArray(options.pythonPrefix) ? options.pythonPrefix.map(String) : [];
    this.spawn = options.spawn || spawn;
    this.executeTimeoutMs = clampTimeout(options.executeTimeoutMs, DEFAULT_EXECUTE_TIMEOUT_MS, 2 * 60 * 60_000);
    this.probeTimeoutMs = clampTimeout(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 10 * 60_000);
    this.downloadTimeoutMs = clampTimeout(options.downloadTimeoutMs, DEFAULT_DOWNLOAD_TIMEOUT_MS, 8 * 60 * 60_000);
    this.modelVerifier = typeof options.modelVerifier === 'function' ? options.modelVerifier : null;
    this.worker = null;
    this.workerBuffer = '';
    this.workerStderr = '';
    this.pending = new Map();
    this.queueTail = Promise.resolve();
    this.downloads = new Map();
    this.downloadTail = Promise.resolve();
    this.downloadProgress = new Map();
    this.downloadChildren = new Set();
    this.verificationCache = new Map();
    this.verificationPromises = new Map();
    this.modelHasher = typeof options.modelHasher === 'function' ? options.modelHasher : hashFileSha256;
    this.closed = false;
    if (!fs.existsSync(this.modelRoot)) fs.mkdirSync(this.modelRoot, { recursive: true });
    assertSafeDirectory(this.modelRoot, { label: '语义模型缓存根目录' });
    cleanupSemanticModelOrphans(this.modelRoot, {
      ttlMs: options.orphanTtlMs,
      onWarning: (message) => console.warn('[asset-semantic] orphan cleanup skipped:', message),
    });
  }

  _defaultRunnerPath() {
    const resourceRoot = String(process.env.T8PC_RES || '').trim();
    const candidates = [
      ...(resourceRoot ? [path.join(resourceRoot, 'tools', 'asset-semantic', 'semantic_runner.py')] : []),
      path.resolve(this.config.BASE_DIR || process.cwd(), 'tools', 'asset-semantic', 'semantic_runner.py'),
      path.resolve(__dirname, '..', '..', '..', 'tools', 'asset-semantic', 'semantic_runner.py'),
    ];
    return candidates.find((filename) => fs.existsSync(filename)) || candidates[0];
  }

  _resolvePythonCommand() {
    if (this.pythonCommand) {
      if (!fs.existsSync(this.pythonCommand)) {
        throw semanticError('asset-semantic-runtime-missing', '指定的语义 Python 运行时不存在');
      }
      return this.pythonCommand;
    }
    const localRuntime = path.resolve(this.config.BASE_DIR || process.cwd(), 'tools', 'remove-ai-watermarks-runtime');
    const candidatesFor = (root) => [
      path.join(root, 'python', 'python.exe'),
      path.join(root, 'python.exe'),
      path.join(root, 'bin', 'python'),
    ];
    if (!this.config.IS_PACKAGED) {
      const local = candidatesFor(localRuntime).find((filename) => fs.existsSync(filename));
      if (local) return local;
    }
    let info = getRuntimeArchiveInfo('remove-ai-watermarks');
    if (!info.ready && info.archiveExists) {
      ensureRuntimeArchiveExtracted('remove-ai-watermarks');
      info = getRuntimeArchiveInfo('remove-ai-watermarks');
    }
    const cached = candidatesFor(getRuntimeCachePath('remove-ai-watermarks')).find((filename) => fs.existsSync(filename));
    if (cached) return cached;
    throw semanticError('asset-semantic-runtime-missing', '内置语义 Python 运行时不可用');
  }

  _assertRunner() {
    const runnerStat = lstat(this.runnerPath);
    if (!runnerStat || !runnerStat.isFile() || runnerStat.isSymbolicLink()) {
      throw semanticError('asset-semantic-runner-missing', '语义模型 runner 不可用');
    }
  }

  _spawn(args, options = {}) {
    this._assertRunner();
    const command = this._resolvePythonCommand();
    return this.spawn(command, [...this.pythonPrefix, this.runnerPath, ...args.map(String)], {
      cwd: this.config.BASE_DIR || process.cwd(),
      env: semanticChildEnv({ offline: options.offline }),
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  _runIndependent(args, options = {}) {
    const timeoutMs = options.timeoutMs;
    const signal = options.signal;
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawn(args, { offline: options.offline });
      } catch (error) {
        reject(error);
        return;
      }
      options.onSpawn?.(child);
      let stdout = '';
      let stderr = '';
      let settled = false;
      let forceTimer = null;
      let terminationError = null;
      const cleanup = () => {
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const kill = (killSignal) => {
        try { if (!child.killed) child.kill(killSignal); } catch (_) {}
      };
      const onAbort = () => {
        if (settled || terminationError) return;
        terminationError = abortError();
        kill('SIGTERM');
        forceTimer = setTimeout(() => kill('SIGKILL'), ABORT_KILL_GRACE_MS);
        forceTimer.unref?.();
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        if (settled || terminationError) return;
        terminationError = semanticError('asset-semantic-timeout', '语义模型进程执行超时');
        kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        if (Buffer.byteLength(stdout) > MAX_STDOUT_BYTES) {
          kill('SIGKILL');
          finish(reject, semanticError('asset-semantic-protocol-too-large', '语义运行时输出超过限制'));
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        if (Buffer.byteLength(stderr) > MAX_STDERR_BYTES) stderr = stderr.slice(-MAX_STDERR_BYTES);
      });
      child.on('error', (error) => finish(
        reject,
        terminationError || semanticError('asset-semantic-runtime-start-failed', sanitizeSemanticError(error).message),
      ));
      child.on('close', (code) => {
        if (settled) return;
        if (terminationError) {
          finish(reject, terminationError);
          return;
        }
        let payload;
        try {
          payload = parseSingleJsonOutput(stdout);
        } catch (error) {
          finish(reject, error);
          return;
        }
        if (code !== 0 || payload.ok !== true) {
          const safe = sanitizeSemanticError(payload.error || stderr || '语义模型进程执行失败');
          finish(reject, semanticError(safe.code, safe.message));
          return;
        }
        finish(resolve, payload);
      });
    });
  }

  _failWorker(error, child = this.worker) {
    if (!child || this.worker !== child) return;
    this.worker = null;
    this.workerBuffer = '';
    const safe = sanitizeSemanticError(error);
    const failure = error?.name === 'AbortError'
      ? error
      : semanticError(safe.code, safe.message);
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (pending.signal) pending.signal.removeEventListener('abort', pending.onAbort);
      pending.reject(failure);
    }
    try { if (!child.killed) child.kill('SIGKILL'); } catch (_) {}
  }

  _handleWorkerLine(line, child) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch (_) {
      this._failWorker(semanticError('asset-semantic-protocol-invalid', '语义 worker 返回了无效 JSONL 帧'), child);
      return;
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.id !== 'string') {
      this._failWorker(semanticError('asset-semantic-protocol-invalid', '语义 worker 返回了无效响应对象'), child);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) {
      this._failWorker(semanticError('asset-semantic-protocol-invalid', '语义 worker 返回了未知请求响应'), child);
      return;
    }
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (pending.signal) pending.signal.removeEventListener('abort', pending.onAbort);
    if (frame.ok === true) {
      pending.resolve(frame.result);
      return;
    }
    const safe = sanitizeSemanticError(frame.error || '语义 worker 执行失败');
    pending.reject(semanticError(safe.code, safe.message));
  }

  _ensureWorker() {
    if (this.closed) throw semanticError('asset-semantic-worker-closed', '语义 worker 已关闭');
    if (this.worker && !this.worker.killed) return this.worker;
    const child = this._spawn(['--worker', '--model-root', this.modelRoot], { offline: true });
    this.worker = child;
    this.workerBuffer = '';
    this.workerStderr = '';
    child.stdout.on('data', (chunk) => {
      if (this.worker !== child) return;
      this.workerBuffer += chunk.toString('utf8');
      if (Buffer.byteLength(this.workerBuffer) > MAX_STDOUT_BYTES && !this.workerBuffer.includes('\n')) {
        this._failWorker(semanticError('asset-semantic-protocol-too-large', '语义 worker 输出帧超过限制'), child);
        return;
      }
      let newline = this.workerBuffer.indexOf('\n');
      while (newline >= 0 && this.worker === child) {
        const line = this.workerBuffer.slice(0, newline).replace(/\r$/, '');
        this.workerBuffer = this.workerBuffer.slice(newline + 1);
        if (line.trim()) this._handleWorkerLine(line, child);
        newline = this.workerBuffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk) => {
      if (this.worker !== child) return;
      this.workerStderr += chunk.toString('utf8');
      if (Buffer.byteLength(this.workerStderr) > MAX_STDERR_BYTES) this.workerStderr = this.workerStderr.slice(-MAX_STDERR_BYTES);
    });
    child.on('error', (error) => this._failWorker(semanticError('asset-semantic-runtime-start-failed', sanitizeSemanticError(error).message), child));
    child.on('close', (code) => {
      if (this.worker !== child) return;
      const stderr = sanitizeSemanticError(this.workerStderr || `worker exit ${code}`).message;
      this._failWorker(semanticError('asset-semantic-worker-exited', stderr), child);
    });
    return child;
  }

  _request(payload, options = {}) {
    throwIfAborted(options.signal);
    const child = this._ensureWorker();
    const id = crypto.randomUUID();
    const frame = `${JSON.stringify({ ...payload, id })}\n`;
    if (Buffer.byteLength(frame) > 64 * 1024) {
      return Promise.reject(semanticError('asset-semantic-request-too-large', '语义请求超过大小限制'));
    }
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      const timeoutMs = clampTimeout(options.timeoutMs, this.executeTimeoutMs, 2 * 60 * 60_000);
      const onAbort = () => {
        const error = abortError();
        this._failWorker(error, child);
      };
      const timer = setTimeout(() => {
        this._failWorker(semanticError('asset-semantic-timeout', '语义模型任务执行超时'), child);
      }, timeoutMs);
      const pending = { resolve, reject, timer, signal, onAbort };
      this.pending.set(id, pending);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      child.stdin.write(frame, 'utf8', (error) => {
        if (error && this.pending.has(id)) {
          this._failWorker(semanticError('asset-semantic-worker-write-failed', sanitizeSemanticError(error).message), child);
        }
      });
    });
  }

  _enqueue(operation) {
    const run = this.queueTail.then(operation, operation);
    this.queueTail = run.catch(() => {});
    return run;
  }

  _modelDirectory(modelId) {
    assertSemanticModelId(modelId);
    const target = path.join(this.modelRoot, modelId);
    assertInside(this.modelRoot, target);
    return target;
  }

  _ensureDownloadsRoot() {
    assertSafeDirectory(this.modelRoot, { label: '语义模型缓存根目录' });
    const downloadsRoot = path.join(this.modelRoot, '.downloads');
    assertInside(this.modelRoot, downloadsRoot);
    if (!fs.existsSync(downloadsRoot)) {
      assertSafeDirectory(downloadsRoot, { create: true, label: '语义模型下载暂存目录' });
    } else {
      assertSafeDirectory(downloadsRoot, { label: '语义模型下载暂存目录' });
    }
    const realRoot = fs.realpathSync.native?.(this.modelRoot) || fs.realpathSync(this.modelRoot);
    const realDownloads = fs.realpathSync.native?.(downloadsRoot) || fs.realpathSync(downloadsRoot);
    if (!isInside(realRoot, realDownloads)) {
      throw semanticError('asset-semantic-path-invalid', '语义模型下载暂存目录越界');
    }
    return downloadsRoot;
  }

  _fastInstallState(modelId) {
    const spec = getTrustedSemanticModelSpec(modelId);
    const target = this._modelDirectory(modelId);
    const targetStat = lstat(target);
    if (!targetStat || !targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      return { installed: false, verified: false, invalid: Boolean(targetStat) };
    }
    const markerPath = path.join(target, INSTALL_MARKER);
    const markerStat = lstat(markerPath);
    const marker = markerStat?.isFile() && !markerStat.isSymbolicLink() ? readJson(markerPath) : null;
    const weightPath = path.join(target, spec.weight.filename);
    const weightStat = lstat(weightPath);
    const markerMatches = Boolean(marker
      && marker.modelId === modelId
      && marker.revision === spec.revision
      && marker.weightSize === spec.weight.size
      && marker.weightSha256 === spec.weight.sha256);
    const weightMatches = Boolean(weightStat
      && weightStat.isFile()
      && !weightStat.isSymbolicLink()
      && weightStat.size === spec.weight.size);
    if (!markerMatches || !weightMatches) return { installed: false, verified: false, invalid: true };
    const cached = this.verificationCache.get(modelId);
    const fingerprint = `${weightStat.size}:${weightStat.mtimeMs}:${weightStat.ctimeMs}`;
    return { installed: true, verified: cached?.fingerprint === fingerprint, fingerprint, weightPath };
  }

  _status(modelId) {
    const model = getPublicSemanticModel(modelId);
    const install = this._fastInstallState(modelId);
    const progress = this.downloadProgress.get(modelId);
    const progressState = String(progress?.state || '');
    const trustedInstalled = install.installed && install.verified;
    const state = ['downloading', 'verifying', 'failed', 'cancelled'].includes(progressState)
      ? progressState
      : (install.invalid ? 'invalid' : (install.installed ? (trustedInstalled ? 'installed' : 'verifying') : 'not-installed'));
    return {
      ...model,
      installed: trustedInstalled,
      verified: trustedInstalled,
      state,
      downloadedBytes: progress ? progress.downloadedBytes : (install.installed ? model.downloadBytes : 0),
      totalBytes: model.downloadBytes,
      percent: progress ? progress.percent : (trustedInstalled ? 100 : (install.installed ? 99 : 0)),
      ...(progress?.startedAt ? { startedAt: progress.startedAt } : {}),
      ...(progress?.completedAt ? { completedAt: progress.completedAt } : {}),
      ...(progress?.error ? { error: { ...progress.error } } : {}),
    };
  }

  listModelStatuses() {
    return getPublicSemanticModelManifest().map((model) => this._status(model.modelId));
  }

  getModelStatus(modelId) {
    assertSemanticModelId(modelId);
    return this._status(modelId);
  }

  getDownloadProgress(modelId) {
    assertSemanticModelId(modelId);
    return publicProgress(this.downloadProgress.get(modelId)) || publicProgress(this._status(modelId));
  }

  async verifyModel(modelId, options = {}) {
    const id = assertSemanticModelId(modelId);
    if (this.modelVerifier) {
      const injected = await this.modelVerifier(id, options);
      if (injected === false || injected?.verified === false || injected?.installed === false) {
        throw semanticError('asset-semantic-model-not-installed', '语义模型尚未安装或校验失败');
      }
      return { ...this._status(id), installed: true, verified: true, state: 'installed' };
    }
    throwIfAborted(options.signal);
    if (this.verificationPromises.has(id)) return this.verificationPromises.get(id);
    const operation = (async () => {
      const spec = getTrustedSemanticModelSpec(id);
      const current = this._fastInstallState(id);
      if (!current.installed || !current.weightPath) {
        throw semanticError(current.invalid ? 'asset-semantic-model-invalid' : 'asset-semantic-model-not-installed', current.invalid ? '语义模型安装无效' : '语义模型尚未安装');
      }
      assertNoLinks(this._modelDirectory(id));
      if (!current.verified) {
        let digest;
        try {
          digest = await this.modelHasher(current.weightPath, { signal: options.signal });
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          const safe = sanitizeSemanticError(error);
          throw semanticError('asset-semantic-model-read-failed', safe.message);
        }
        if (digest !== spec.weight.sha256) {
          this.verificationCache.delete(id);
          throw semanticError('asset-semantic-model-hash-mismatch', '语义模型主权重校验失败');
        }
        const verified = this._fastInstallState(id);
        if (!verified.installed || verified.fingerprint !== current.fingerprint) {
          this.verificationCache.delete(id);
          throw semanticError('asset-semantic-model-changed', '语义模型在校验期间发生变化');
        }
        this.verificationCache.set(id, { fingerprint: current.fingerprint, verifiedAt: Date.now() });
      }
      if (['failed', 'cancelled', 'invalid'].includes(String(this.downloadProgress.get(id)?.state || ''))) {
        this.downloadProgress.delete(id);
      }
      return { ...this._status(id), installed: true, verified: true, state: 'installed' };
    })();
    this.verificationPromises.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.verificationPromises.get(id) === operation) this.verificationPromises.delete(id);
    }
  }

  async execute(input, options = {}) {
    if (Object.keys(options).some((key) => !['signal', 'timeoutMs'].includes(key))) {
      throw semanticError('asset-semantic-request-field-not-allowed', '语义任务选项包含不允许的字段');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw semanticError('asset-semantic-request-invalid', '语义任务参数必须是对象');
    }
    for (const key of Object.keys(input)) {
      if (FORBIDDEN_REQUEST_FIELDS.test(key) || !['modelId', 'task', 'sourcePath', 'text'].includes(key)) {
        throw semanticError('asset-semantic-request-field-not-allowed', '语义任务包含不允许的字段');
      }
    }
    const task = String(input.task || '');
    if (!Object.values(SEMANTIC_TASKS).includes(task)) {
      throw semanticError('asset-semantic-task-invalid', '不支持的语义任务');
    }
    const modelId = assertSemanticModelId(input.modelId, task);
    let sourcePath;
    let text;
    if (task === SEMANTIC_TASKS.CAPTION || task === SEMANTIC_TASKS.OCR) {
      if (typeof input.sourcePath !== 'string' || !path.isAbsolute(input.sourcePath)) {
        throw semanticError('asset-semantic-source-invalid', '语义图像源路径无效');
      }
      sourcePath = path.resolve(input.sourcePath);
      const sourceStat = lstat(sourcePath);
      if (!sourceStat || !sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw semanticError('asset-semantic-source-invalid', '语义图像源必须是普通文件');
      }
      if (sourceStat.size <= 0 || sourceStat.size > MAX_SOURCE_BYTES) {
        throw semanticError('asset-semantic-source-too-large', '语义图像源大小超出限制');
      }
    } else {
      if (typeof input.text !== 'string' || !input.text.trim()) {
        throw semanticError('asset-semantic-text-required', '向量任务需要非空文本');
      }
      text = input.text.trim().slice(0, MAX_TEXT_CHARS);
    }
    throwIfAborted(options.signal);
    await this.verifyModel(modelId, { signal: options.signal });
    const result = await this._enqueue(() => this._request({
      op: 'execute',
      modelId,
      task,
      ...(sourcePath ? { sourcePath } : {}),
      ...(text ? { text } : {}),
    }, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    }));
    try {
      return validateExecutionResult(modelId, task, result);
    } catch (error) {
      if (this.worker) this._failWorker(error, this.worker);
      throw error;
    }
  }

  async probe(options = {}) {
    const payload = await this._runIndependent(['--probe'], {
      offline: true,
      signal: options.signal,
      timeoutMs: clampTimeout(options.timeoutMs, this.probeTimeoutMs, 10 * 60_000),
    });
    const result = { ...payload };
    delete result.result;
    delete result.error;
    const expectedIds = getPublicSemanticModelManifest().map((model) => model.modelId).sort();
    const reportedIds = Array.isArray(result.modelIds) ? result.modelIds.map(String).sort() : [];
    if (JSON.stringify(expectedIds) !== JSON.stringify(reportedIds)
      || result.directClasses !== true
      || result.trocrTokenizerAdapter !== true) {
      throw semanticError('asset-semantic-runtime-incompatible', '内置语义运行时缺少固定模型所需的直接类');
    }
    return result;
  }

  _setProgress(modelId, patch, onProgress) {
    const previous = this.downloadProgress.get(modelId) || {
      modelId,
      state: 'not-installed',
      downloadedBytes: 0,
      totalBytes: getTrustedSemanticModelSpec(modelId).downloadBytes,
      percent: 0,
    };
    const next = { ...previous, ...patch, modelId };
    next.totalBytes = getTrustedSemanticModelSpec(modelId).downloadBytes;
    next.downloadedBytes = Math.max(0, Math.min(next.totalBytes, Number(next.downloadedBytes) || 0));
    next.percent = next.state === 'installed'
      ? 100
      : Math.max(0, Math.min(99, next.totalBytes ? Math.floor((next.downloadedBytes / next.totalBytes) * 100) : 0));
    this.downloadProgress.set(modelId, next);
    if (typeof onProgress === 'function') {
      try { onProgress(publicProgress(next)); } catch (_) {}
    }
    return next;
  }

  async _installDownloadedModel(modelId, staging, options = {}) {
    const spec = getTrustedSemanticModelSpec(modelId);
    assertInside(this.modelRoot, staging);
    const ownerPath = path.join(staging, DOWNLOAD_OWNER_MARKER);
    const ownerStat = lstat(ownerPath);
    if (ownerStat?.isSymbolicLink()) {
      throw semanticError('asset-semantic-model-link-rejected', '模型下载所有者标记不能是符号链接');
    }
    if (ownerStat?.isFile()) fs.unlinkSync(ownerPath);
    assertNoLinks(staging);
    const weightPath = path.join(staging, spec.weight.filename);
    const weightStat = lstat(weightPath);
    if (!weightStat || !weightStat.isFile() || weightStat.isSymbolicLink() || weightStat.size !== spec.weight.size) {
      throw semanticError('asset-semantic-download-size-mismatch', '下载的模型主权重大小不匹配');
    }
    const digest = await this.modelHasher(weightPath, { signal: options.signal });
    if (digest !== spec.weight.sha256) {
      throw semanticError('asset-semantic-download-hash-mismatch', '下载的模型主权重校验失败');
    }
    const marker = {
      format: 1,
      modelId,
      task: spec.task,
      revision: spec.revision,
      weightSize: spec.weight.size,
      weightSha256: spec.weight.sha256,
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(staging, INSTALL_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    const destination = this._modelDirectory(modelId);
    const backup = path.join(this.modelRoot, `.replaced-${modelId}-${crypto.randomUUID()}`);
    assertInside(this.modelRoot, backup);
    let movedExisting = false;
    try {
      if (this.worker) {
        await this._enqueue(() => this._request({ op: 'unload', modelId }, { timeoutMs: 30_000 }));
      }
      if (fs.existsSync(destination)) {
        fs.renameSync(destination, backup);
        const touchedAt = new Date();
        fs.utimesSync(backup, touchedAt, touchedAt);
        movedExisting = true;
      }
      fs.renameSync(staging, destination);
    } catch (error) {
      if (movedExisting && !fs.existsSync(destination) && fs.existsSync(backup)) {
        try { fs.renameSync(backup, destination); } catch (_) {}
      }
      throw error;
    }
    if (movedExisting && fs.existsSync(backup)) {
      try {
        safeUnlinkTree(this.modelRoot, backup);
      } catch (error) {
        console.warn('[asset-semantic] old verified model cleanup was deferred:', sanitizeSemanticError(error).message);
      }
    }
    const installedWeight = lstat(path.join(destination, spec.weight.filename));
    const fingerprint = `${installedWeight.size}:${installedWeight.mtimeMs}:${installedWeight.ctimeMs}`;
    this.verificationCache.set(modelId, { fingerprint, verifiedAt: Date.now() });
  }

  async downloadModel(modelId, options = {}) {
    const id = assertSemanticModelId(modelId);
    if (Object.keys(options).some((key) => !['signal', 'onProgress', 'timeoutMs'].includes(key))) {
      throw semanticError('asset-semantic-request-field-not-allowed', '模型下载参数包含不允许的字段');
    }
    if (this.closed) throw semanticError('asset-semantic-worker-closed', '语义 worker 已关闭');
    if (this._fastInstallState(id).installed) {
      try {
        return await this.verifyModel(id, { signal: options.signal });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
      }
    }
    if (this.downloads.has(id)) return this.downloads.get(id);
    const performDownload = async () => {
      if (this.closed) throw semanticError('asset-semantic-worker-closed', '语义 worker 已关闭');
      throwIfAborted(options.signal);
      const spec = getTrustedSemanticModelSpec(id);
      const downloadsRoot = this._ensureDownloadsRoot();
      const staging = path.join(downloadsRoot, `${id}-${crypto.randomUUID()}`);
      assertInside(this.modelRoot, downloadsRoot);
      assertInside(downloadsRoot, staging);
      assertSafeDirectory(downloadsRoot, { label: '语义模型下载暂存目录' });
      fs.mkdirSync(staging, { recursive: false });
      assertSafeDirectory(staging, { label: '语义模型下载暂存快照' });
      const realDownloads = fs.realpathSync.native?.(downloadsRoot) || fs.realpathSync(downloadsRoot);
      const realStaging = fs.realpathSync.native?.(staging) || fs.realpathSync(staging);
      if (!isInside(realDownloads, realStaging)) {
        throw semanticError('asset-semantic-path-invalid', '语义模型下载暂存快照越界');
      }
      fs.writeFileSync(path.join(staging, DOWNLOAD_OWNER_MARKER), `${JSON.stringify({
        format: 1,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      })}\n`, { encoding: 'utf8', flag: 'wx' });
      const startedAt = new Date().toISOString();
      this._setProgress(id, {
        state: 'downloading',
        downloadedBytes: 0,
        startedAt,
        completedAt: null,
        error: null,
      }, options.onProgress);
      let pollTimer = null;
      const poll = () => {
        const bytes = directoryBytes(staging);
        this._setProgress(id, { state: 'downloading', downloadedBytes: bytes }, options.onProgress);
      };
      try {
        pollTimer = setInterval(poll, 250);
        pollTimer.unref?.();
        const payload = await this._runIndependent([
          '--download',
          '--model-id', id,
          '--staging-dir', staging,
        ], {
          offline: false,
          signal: options.signal,
          timeoutMs: clampTimeout(options.timeoutMs, this.downloadTimeoutMs, 8 * 60 * 60_000),
          onSpawn: (child) => {
            this.downloadChildren.add(child);
            child.once('close', () => this.downloadChildren.delete(child));
          },
        });
        poll();
        if (payload.result?.modelId !== id
          || payload.result?.revision !== spec.revision
          || payload.result?.weightSize !== spec.weight.size
          || payload.result?.weightSha256 !== spec.weight.sha256) {
          throw semanticError('asset-semantic-download-attestation-invalid', '模型下载进程返回的校验信息不匹配');
        }
        this._setProgress(id, { state: 'verifying', downloadedBytes: directoryBytes(staging) }, options.onProgress);
        await this._installDownloadedModel(id, staging, { signal: options.signal });
        const completedAt = new Date().toISOString();
        this._setProgress(id, {
          state: 'installed',
          downloadedBytes: spec.downloadBytes,
          completedAt,
          error: null,
        }, options.onProgress);
        return this._status(id);
      } catch (error) {
        const safe = sanitizeSemanticError(error);
        this._setProgress(id, {
          state: error?.name === 'AbortError' ? 'cancelled' : 'failed',
          downloadedBytes: directoryBytes(staging),
          completedAt: new Date().toISOString(),
          error: safe,
        }, options.onProgress);
        throw (error?.name === 'AbortError' ? error : semanticError(safe.code, safe.message));
      } finally {
        if (pollTimer) clearInterval(pollTimer);
        if (fs.existsSync(staging)) safeUnlinkTree(downloadsRoot, staging);
      }
    };
    const runDownload = async () => {
      try {
        return await performDownload();
      } finally {
        this.downloads.delete(id);
      }
    };
    const operation = this.downloadTail.then(runDownload, runDownload);
    this.downloadTail = operation.catch(() => {});
    this.downloads.set(id, operation);
    return operation;
  }

  async removeModel(modelId) {
    const id = assertSemanticModelId(modelId);
    if (this.downloads.has(id)) {
      throw semanticError('asset-semantic-download-active', '模型正在下载，无法删除');
    }
    return this._enqueue(async () => {
      try {
        if (this.worker) await this._request({ op: 'unload', modelId: id }, { timeoutMs: 30_000 });
        const target = this._modelDirectory(id);
        const removed = fs.existsSync(target);
        if (removed) {
          const trash = path.join(this.modelRoot, `.removed-${id}-${crypto.randomUUID()}`);
          assertInside(this.modelRoot, trash);
          fs.renameSync(target, trash);
          safeUnlinkTree(this.modelRoot, trash);
        }
        this.verificationCache.delete(id);
        this.verificationPromises.delete(id);
        this.downloadProgress.delete(id);
        return { ...this._status(id), removed };
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        const safe = sanitizeSemanticError(error);
        throw semanticError(safe.code, safe.message);
      }
    });
  }

  installModel(modelId, options = {}) {
    return this.downloadModel(modelId, options);
  }

  deleteModel(modelId) {
    return this.removeModel(modelId);
  }

  run(input, options = {}) {
    return this.execute(input, options);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const child of this.downloadChildren) {
      try { if (!child.killed) child.kill('SIGKILL'); } catch (_) {}
    }
    this.downloadChildren.clear();
    if (this.worker) {
      this._failWorker(semanticError('asset-semantic-worker-closed', '语义 worker 已关闭'), this.worker);
    }
  }
}

module.exports = {
  AssetSemanticWorker,
  abortError,
  hashFileSha256,
  sanitizeSemanticError,
  cleanupSemanticModelOrphans,
  semanticChildEnv,
  validateExecutionResult,
};
