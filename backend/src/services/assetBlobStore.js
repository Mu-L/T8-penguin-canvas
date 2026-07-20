const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;
const TEMP_FILE_PATTERN = /^\.cas-([a-f0-9]{64})-\d+-[a-f0-9-]{16,}\.tmp$/i;
const LOCK_FILE_PATTERN = /^\.cas-([a-f0-9]{64})\.lock$/i;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_LOCK_MS = 10 * 60_000;
const DEFAULT_TEMP_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const COPY_BUFFER_BYTES = 1024 * 1024;
const LOCK_RECORD_VERSION = 1;

class AssetBlobStoreError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AssetBlobStoreError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new AssetBlobStoreError(code, message, cause);
}

function normalizeSha256(value) {
  if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value.trim())) {
    fail('CAS_HASH_INVALID', 'SHA-256 必须是 64 位十六进制字符串');
  }
  return value.trim().toLowerCase();
}

function normalizeExpectedSize(value) {
  if (value == null || value === '') return null;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    fail('CAS_SIZE_INVALID', '预期文件大小必须是非负安全整数');
  }
  return size;
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameFileIdentity(left, right) {
  return Boolean(left && right
    && Number(left.dev) === Number(right.dev)
    && Number(left.ino) === Number(right.ino)
    && Number(left.size) === Number(right.size)
    && Number(left.mtimeMs) === Number(right.mtimeMs)
    && Number(left.ctimeMs) === Number(right.ctimeMs));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseLockRecord(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    const pid = Number(parsed?.pid);
    const token = String(parsed?.token || '');
    if (Number(parsed?.version) !== LOCK_RECORD_VERSION
      || !Number.isSafeInteger(pid)
      || pid <= 0
      || !/^[a-f0-9-]{16,}$/i.test(token)) {
      return null;
    }
    return { pid, token };
  } catch (_) {
    return null;
  }
}

function processAppearsAlive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  if (Number(pid) === process.pid) return true;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled. Unknown failures
    // are treated as alive: availability may wait, but an active owner is never
    // sacrificed merely because liveness could not be proven.
    return error?.code !== 'ESRCH';
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.promises.open(directory, 'r');
    await handle.sync();
  } catch (_) {
    // Windows and some filesystems do not allow opening directories for fsync.
    // The installed file itself is always synced before it becomes visible.
  } finally {
    try { await handle?.close(); } catch (_) {}
  }
}

async function hashOpenFile(handle) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { contentHash: hash.digest('hex'), byteSize: position };
}

async function openRegularFile(filename, label) {
  const absolute = path.resolve(String(filename || ''));
  let beforeOpen;
  try {
    beforeOpen = await fs.promises.lstat(absolute);
  } catch (error) {
    fail('CAS_SOURCE_UNREADABLE', `${label}不可读取`, error);
  }
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
    fail('CAS_SOURCE_NOT_REGULAR', `${label}必须是普通文件，不能是符号链接`);
  }
  let handle;
  try {
    const noFollow = Number(fs.constants.O_NOFOLLOW) || 0;
    handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile()) fail('CAS_SOURCE_NOT_REGULAR', `${label}不是普通文件`);
    if (Number(beforeOpen.dev) !== Number(opened.dev) || Number(beforeOpen.ino) !== Number(opened.ino)) {
      fail('CAS_SOURCE_CHANGED', `${label}在打开期间发生变化`);
    }
    return { absolute, handle, stat: opened };
  } catch (error) {
    try { await handle?.close(); } catch (_) {}
    if (error instanceof AssetBlobStoreError) throw error;
    fail('CAS_SOURCE_UNREADABLE', `${label}不可读取`, error);
  }
}

class AssetBlobStore {
  constructor(rootPath, options = {}) {
    if (rootPath && typeof rootPath === 'object') {
      options = rootPath;
      rootPath = options.rootPath || options.rootDir || options.root;
    }
    if (!rootPath || !String(rootPath).trim()) {
      fail('CAS_ROOT_INVALID', 'CAS 根目录不能为空');
    }
    this.options = options || {};
    this.rootPath = path.resolve(String(rootPath));
    fs.mkdirSync(this.rootPath, { recursive: true, mode: 0o700 });
    const rootStat = fs.lstatSync(this.rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      fail('CAS_ROOT_INVALID', 'CAS 根目录必须是真实目录，不能是符号链接');
    }
    this.rootPath = fs.realpathSync.native(this.rootPath);
    this.sha256Root = path.join(this.rootPath, 'sha256');
    this.lockTimeoutMs = Math.max(1_000, Number(options.lockTimeoutMs) || DEFAULT_LOCK_TIMEOUT_MS);
    this.staleLockMs = Math.max(this.lockTimeoutMs, Number(options.staleLockMs) || DEFAULT_STALE_LOCK_MS);
  }

  _parts(contentHash) {
    const hash = normalizeSha256(contentHash);
    return { hash, first: hash.slice(0, 2), second: hash.slice(2, 4) };
  }

  _target(contentHash) {
    const parts = this._parts(contentHash);
    const directory = path.join(this.sha256Root, parts.first, parts.second);
    const filename = path.join(directory, parts.hash);
    if (!isPathInside(this.rootPath, directory) || !isPathInside(this.rootPath, filename)) {
      fail('CAS_PATH_ESCAPE', 'CAS 路径越过了私有根目录');
    }
    return { ...parts, directory, filename };
  }

  _assertExistingPathSafety(target, options = {}) {
    const directories = [this.sha256Root, path.dirname(path.dirname(target.filename)), target.directory];
    for (const directory of directories) {
      if (!fs.existsSync(directory)) continue;
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail('CAS_PATH_UNSAFE', 'CAS 分层目录不是安全的真实目录');
      }
      const real = fs.realpathSync.native(directory);
      if (!samePath(real, this.rootPath) && !isPathInside(this.rootPath, real)) {
        fail('CAS_PATH_ESCAPE', 'CAS 分层目录解析到了私有根目录之外');
      }
    }
    if (!fs.existsSync(target.filename)) return;
    const stat = fs.lstatSync(target.filename);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('CAS_BLOB_UNSAFE', 'CAS blob 不是安全的普通文件');
    }
    const real = fs.realpathSync.native(target.filename);
    if (!samePath(real, target.filename) || !isPathInside(this.rootPath, real)) {
      fail('CAS_PATH_ESCAPE', 'CAS blob 解析到了私有根目录之外');
    }
    if (options.requireShape !== false && !this.isBlobPath(real, { skipExistingSafety: true })) {
      fail('CAS_PATH_INVALID', 'CAS blob 路径不符合 SHA-256 分层规则');
    }
  }

  _ensureDirectory(target) {
    this._assertExistingPathSafety(target);
    fs.mkdirSync(target.directory, { recursive: true, mode: 0o700 });
    this._assertExistingPathSafety(target);
  }

  resolve(contentHash) {
    const target = this._target(contentHash);
    this._assertExistingPathSafety(target);
    return target.filename;
  }

  resolvePath(contentHash) {
    return this.resolve(contentHash);
  }

  isBlobPath(candidate, options = {}) {
    try {
      const absolute = path.resolve(String(candidate || ''));
      const relative = path.relative(this.rootPath, absolute);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
      const segments = relative.split(path.sep);
      if (segments.length !== 4 || segments[0] !== 'sha256') return false;
      const hash = normalizeSha256(segments[3]);
      if (segments[1] !== hash.slice(0, 2) || segments[2] !== hash.slice(2, 4)) return false;
      const expected = this._target(hash).filename;
      if (!samePath(expected, absolute)) return false;
      if (!options.skipExistingSafety && fs.existsSync(absolute)) this._assertExistingPathSafety(this._target(hash), { requireShape: false });
      return true;
    } catch (_) {
      return false;
    }
  }

  async _verifyBlob(filename, contentHash, expectedSize = null, code = 'CAS_BLOB_CORRUPT') {
    const expectedHash = normalizeSha256(contentHash);
    const normalizedSize = normalizeExpectedSize(expectedSize);
    const opened = await openRegularFile(filename, 'CAS blob');
    try {
      const before = opened.stat;
      const digest = await hashOpenFile(opened.handle);
      const after = await opened.handle.stat();
      if (!sameFileIdentity(before, after) || digest.byteSize !== Number(after.size)) {
        fail(code, 'CAS blob 在校验期间发生变化');
      }
      if (normalizedSize != null && digest.byteSize !== normalizedSize) {
        fail(code, 'CAS blob 大小与预期不一致');
      }
      if (digest.contentHash !== expectedHash) {
        fail(code, 'CAS blob 内容哈希与路径不一致');
      }
      return { contentHash: digest.contentHash, byteSize: digest.byteSize, path: opened.absolute };
    } finally {
      try { await opened.handle.close(); } catch (_) {}
    }
  }

  async resolveVerifiedBlob(contentHash, expectedSize = null) {
    const hash = normalizeSha256(contentHash);
    const filename = this.resolve(hash);
    if (!fs.existsSync(filename)) return null;
    return this._verifyBlob(filename, hash, expectedSize);
  }

  async withVerifiedBlobLock(contentHash, expectedSize, callback) {
    const hash = normalizeSha256(contentHash);
    const normalizedSize = normalizeExpectedSize(expectedSize);
    if (typeof callback !== 'function') fail('CAS_CALLBACK_INVALID', 'CAS 锁内回调无效');
    const target = this._target(hash);
    this._assertExistingPathSafety(target);
    if (!fs.existsSync(target.filename)) return null;
    const release = await this._acquireLock(path.join(target.directory, `.cas-${hash}.lock`));
    try {
      this._assertExistingPathSafety(target);
      if (!fs.existsSync(target.filename)) return null;
      const verified = await this._verifyBlob(target.filename, hash, normalizedSize);
      return await callback({
        ...verified,
        storageKey: path.relative(this.rootPath, target.filename).split(path.sep).join('/'),
      });
    } finally {
      await release();
    }
  }

  async _copyAndVerifySource(sourcePath, temporary, expectedHash, expectedSize) {
    const source = await openRegularFile(sourcePath, '待安装源文件');
    let output;
    let completed = false;
    try {
      if (expectedSize != null && Number(source.stat.size) !== expectedSize) {
        fail('CAS_SOURCE_SIZE_MISMATCH', '待安装源文件大小与预期不一致');
      }
      output = await fs.promises.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let position = 0;
      while (true) {
        const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, position + written);
          if (!result.bytesWritten) fail('CAS_TEMP_WRITE_FAILED', 'CAS 临时文件写入被截断');
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      await output.sync();
      const sourceAfter = await source.handle.stat();
      if (!sameFileIdentity(source.stat, sourceAfter) || position !== Number(sourceAfter.size)) {
        fail('CAS_SOURCE_CHANGED', '待安装源文件在校验期间发生变化');
      }
      if (expectedSize != null && position !== expectedSize) {
        fail('CAS_SOURCE_SIZE_MISMATCH', '待安装源文件大小与预期不一致');
      }
      const actualHash = hash.digest('hex');
      if (actualHash !== expectedHash) {
        fail('CAS_SOURCE_HASH_MISMATCH', '待安装源文件的真实 SHA-256 与预期不一致');
      }
      completed = true;
      return { contentHash: actualHash, byteSize: position };
    } finally {
      try { await output?.close(); } catch (_) {}
      try { await source.handle.close(); } catch (_) {}
      if (!completed) {
        try { await fs.promises.rm(temporary, { force: true }); } catch (_) {}
      }
    }
  }

  async _acquireLock(lockPath) {
    const startedAt = Date.now();
    while (true) {
      let handle;
      try {
        handle = await fs.promises.open(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        const token = crypto.randomUUID();
        await handle.writeFile(`${JSON.stringify({
          version: LOCK_RECORD_VERSION,
          pid: process.pid,
          token,
          createdAtMs: Date.now(),
        })}\n`, 'utf8');
        await handle.sync();
        let releasing = false;
        let heartbeatPromise = null;
        const heartbeatMs = Math.max(250, Math.min(30_000, Math.floor(this.staleLockMs / 3)));
        const heartbeat = setInterval(() => {
          if (releasing || heartbeatPromise) return;
          const now = new Date();
          heartbeatPromise = handle.utimes(now, now)
            .catch(() => {})
            .finally(() => { heartbeatPromise = null; });
        }, heartbeatMs);
        heartbeat.unref?.();
        return async () => {
          releasing = true;
          clearInterval(heartbeat);
          try { await heartbeatPromise; } catch (_) {}
          try { await handle.close(); } catch (_) {}
          try {
            const current = parseLockRecord(await fs.promises.readFile(lockPath, 'utf8'));
            if (current?.token === token && current.pid === process.pid) {
              await fs.promises.unlink(lockPath);
            }
          } catch (error) {
            if (error?.code !== 'ENOENT') {
              // Leaving an uncertain lock behind is safer than deleting another
              // owner's lock. A later dead-owner cleanup can reclaim it.
            }
          }
        };
      } catch (error) {
        try { await handle?.close(); } catch (_) {}
        if (error?.code !== 'EEXIST') fail('CAS_LOCK_FAILED', '无法取得 CAS 安装锁', error);
        try {
          const stat = await fs.promises.lstat(lockPath);
          if (!stat.isFile() || stat.isSymbolicLink()) fail('CAS_LOCK_UNSAFE', 'CAS 安装锁不是安全的普通文件');
          if (stat.mtimeMs <= Date.now() - this.staleLockMs) {
            const owner = parseLockRecord(await fs.promises.readFile(lockPath, 'utf8'));
            if (!owner || !processAppearsAlive(owner.pid)) {
              try {
                await fs.promises.unlink(lockPath);
                continue;
              } catch (removeError) {
                if (removeError?.code === 'ENOENT') continue;
              }
            }
          }
        } catch (inspectionError) {
          if (inspectionError instanceof AssetBlobStoreError) throw inspectionError;
          if (inspectionError?.code === 'ENOENT') continue;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          fail('CAS_LOCK_TIMEOUT', '等待同一 SHA-256 的 CAS 操作超时');
        }
        await delay(10 + Math.floor(Math.random() * 20));
      }
    }
  }

  async _installTemporary(temporary, target, onInstalled = null) {
    const lockPath = path.join(target.directory, `.cas-${target.hash}.lock`);
    const release = await this._acquireLock(lockPath);
    try {
      this._assertExistingPathSafety(target);
      let installed = null;
      if (fs.existsSync(target.filename)) {
        const existing = await this._verifyBlob(target.filename, target.hash, null);
        installed = { ...existing, reused: true };
      } else {
        try {
          await fs.promises.link(temporary, target.filename);
          await fs.promises.rm(temporary, { force: true });
        } catch (error) {
          if (error?.code === 'EEXIST') {
            const existing = await this._verifyBlob(target.filename, target.hash, null);
            installed = { ...existing, reused: true };
          } else {
            if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(String(error?.code || ''))) throw error;
            // Some Windows/filesystem combinations do not support hard links. The
            // exclusive per-hash lock keeps the same-directory rename non-replacing.
            if (fs.existsSync(target.filename)) {
              const existing = await this._verifyBlob(target.filename, target.hash, null);
              installed = { ...existing, reused: true };
            } else {
              await fs.promises.rename(temporary, target.filename);
            }
          }
        }
      }
      if (!installed) {
        try { await fs.promises.chmod(target.filename, 0o600); } catch (_) {}
        await syncDirectory(target.directory);
        const verified = await this._verifyBlob(target.filename, target.hash, null);
        installed = { ...verified, reused: false };
      }
      if (typeof onInstalled === 'function') {
        try {
          await onInstalled(installed);
        } catch (error) {
          if (!installed.reused && error?.preserveInstalledBlob !== true) {
            try {
              await this._verifyBlob(target.filename, target.hash, installed.byteSize);
              await fs.promises.unlink(target.filename);
              await syncDirectory(target.directory);
            } catch (_) {
              // A verified but unreferenced file is safer than deleting bytes whose
              // identity changed during rollback; a later CAS audit may reclaim it.
            }
          }
          throw error;
        }
      }
      return installed;
    } finally {
      await release();
    }
  }

  async installVerifiedFile(sourcePath, expectedOrOptions, maybeOptions = {}) {
    const options = typeof expectedOrOptions === 'string'
      ? { ...(maybeOptions || {}), expectedHash: expectedOrOptions }
      : { ...(expectedOrOptions || {}) };
    const expectedHash = normalizeSha256(options.expectedHash || options.contentHash || options.sha256);
    const expectedSize = normalizeExpectedSize(options.expectedSize ?? options.byteSize ?? options.size);
    const target = this._target(expectedHash);
    this._ensureDirectory(target);
    const temporary = path.join(
      target.directory,
      `.cas-${target.hash}-${process.pid}-${crypto.randomUUID()}.tmp`,
    );
    try {
      const source = await this._copyAndVerifySource(sourcePath, temporary, expectedHash, expectedSize);
      await this._verifyBlob(temporary, expectedHash, source.byteSize, 'CAS_TEMP_CORRUPT');
      let sourceRemoved = false;
      const buildResult = (installed) => ({
        contentHash: expectedHash,
        byteSize: source.byteSize,
        storageKey: path.relative(this.rootPath, target.filename).split(path.sep).join('/'),
        path: target.filename,
        reused: Boolean(installed.reused),
      });
      const needsCommitCallback = options.removeSource === true || typeof options.onInstalled === 'function';
      const installed = await this._installTemporary(temporary, target, needsCommitCallback ? async (lockedInstalled) => {
        if (lockedInstalled.byteSize !== source.byteSize) {
          fail('CAS_BLOB_CORRUPT', '现存 CAS blob 大小与已验证源文件不一致');
        }
        const absoluteSource = path.resolve(String(sourcePath || ''));
        const sourceDiffersFromTarget = !samePath(absoluteSource, target.filename);
        if (options.removeSource === true) {
          if (!samePath(absoluteSource, target.filename)) {
            try {
              await fs.promises.unlink(absoluteSource);
            } catch (error) {
              fail('CAS_SOURCE_REMOVE_FAILED', 'CAS 已安装，但无法删除源文件', error);
            }
          }
          sourceRemoved = true;
        }
        if (typeof options.onInstalled === 'function') {
          try {
            await options.onInstalled(buildResult(lockedInstalled));
          } catch (error) {
            if (sourceRemoved && sourceDiffersFromTarget && !fs.existsSync(absoluteSource)) {
              try {
                await fs.promises.copyFile(target.filename, absoluteSource, fs.constants.COPYFILE_EXCL);
                await this._verifyBlob(absoluteSource, expectedHash, source.byteSize, 'CAS_SOURCE_RESTORE_FAILED');
              } catch (restoreError) {
                error.preserveInstalledBlob = true;
                error.restoreErrorCode = restoreError?.code || 'CAS_SOURCE_RESTORE_FAILED';
              }
            }
            throw error;
          }
        }
      } : null);
      if (installed.byteSize !== source.byteSize) {
        fail('CAS_BLOB_CORRUPT', '现存 CAS blob 大小与已验证源文件不一致');
      }
      const result = buildResult(installed);
      if (options.removeSource === true && !sourceRemoved) {
        const absoluteSource = path.resolve(String(sourcePath || ''));
        if (!samePath(absoluteSource, target.filename)) {
          try {
            await fs.promises.unlink(absoluteSource);
          } catch (error) {
            fail('CAS_SOURCE_REMOVE_FAILED', 'CAS 已安装，但无法删除源文件', error);
          }
        }
      }
      return result;
    } finally {
      try { await fs.promises.rm(temporary, { force: true }); } catch (_) {}
    }
  }

  async removeVerifiedBlob(contentHash, options = {}) {
    const hash = normalizeSha256(contentHash);
    const expectedSize = normalizeExpectedSize(options.expectedSize ?? options.byteSize ?? options.size);
    const target = this._target(hash);
    this._assertExistingPathSafety(target);
    if (!fs.existsSync(target.filename)) return false;
    const release = await this._acquireLock(path.join(target.directory, `.cas-${hash}.lock`));
    try {
      this._assertExistingPathSafety(target);
      if (!fs.existsSync(target.filename)) return false;
      const verified = await this._verifyBlob(target.filename, hash, expectedSize);
      if (typeof options.beforeDelete === 'function') {
        const allowed = await options.beforeDelete({ ...verified, storageKey: path.relative(this.rootPath, target.filename).split(path.sep).join('/') });
        if (!allowed) return false;
      }
      await fs.promises.unlink(target.filename);
      await syncDirectory(target.directory);
    } finally {
      await release();
    }
    for (const directory of [target.directory, path.dirname(target.directory)]) {
      try { await fs.promises.rmdir(directory); } catch (_) {}
    }
    return true;
  }

  cleanupTemporaryFiles(options = {}) {
    const now = Number(options.now) || Date.now();
    const maxAgeMs = Math.max(60_000, Number(options.maxAgeMs) || DEFAULT_TEMP_MAX_AGE_MS);
    const maximumFiles = Math.max(1, Math.min(100_000, Number(options.maximumFiles) || 10_000));
    const queue = [this.sha256Root];
    let inspected = 0;
    let removed = 0;
    while (queue.length && inspected < maximumFiles) {
      const directory = queue.shift();
      let entries = [];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { continue; }
      for (const entry of entries) {
        if (inspected >= maximumFiles) break;
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!entry.isSymbolicLink()) queue.push(filename);
          continue;
        }
        inspected += 1;
        if (!entry.isFile() || (!TEMP_FILE_PATTERN.test(entry.name) && !LOCK_FILE_PATTERN.test(entry.name))) continue;
        try {
          const stat = fs.lstatSync(filename);
          if (stat.isSymbolicLink() || stat.mtimeMs > now - maxAgeMs) continue;
          if (LOCK_FILE_PATTERN.test(entry.name)) {
            const owner = parseLockRecord(fs.readFileSync(filename, 'utf8'));
            if (owner && processAppearsAlive(owner.pid)) continue;
          }
          fs.rmSync(filename, { force: true });
          removed += 1;
        } catch (_) {}
      }
    }
    return { inspected, removed };
  }
}

const storesByRoot = new Map();

function getAssetBlobStore(config = {}) {
  const rootPath = config.ASSET_BLOB_DIR
    || config.ASSET_BLOBS_DIR
    || config.ASSET_BLOB_STORE_DIR
    || (config.DATA_DIR ? path.join(config.DATA_DIR, 'asset-blobs') : null)
    || (config.INPUT_DIR ? path.join(path.dirname(path.resolve(config.INPUT_DIR)), 'data', 'asset-blobs') : null);
  if (!rootPath) fail('CAS_ROOT_INVALID', '配置缺少 ASSET_BLOBS_DIR 或 DATA_DIR');
  const key = path.resolve(String(rootPath));
  let store = storesByRoot.get(process.platform === 'win32' ? key.toLowerCase() : key);
  if (!store) {
    store = new AssetBlobStore(key, config.assetBlobStoreOptions || {});
    storesByRoot.set(process.platform === 'win32' ? key.toLowerCase() : key, store);
  }
  return store;
}

module.exports = {
  AssetBlobStore,
  AssetBlobStoreError,
  SHA256_HEX_PATTERN,
  getAssetBlobStore,
  normalizeSha256,
};
