const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizePublicBaseUrl } = require('./publicExposure');

const PUBLIC_EXPOSURE_STORE_SCHEMA = 't8-collaboration-public-exposure-v1';
const PUBLIC_EXPOSURE_STORE_VERSION = 1;
const PUBLIC_EXPOSURE_STORE_MAX_BYTES = 16 * 1024;

class PublicExposureStoreError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'PublicExposureStoreError';
    this.code = code;
    this.status = status;
  }
}

function storeError(code, message) {
  return new PublicExposureStoreError(code, message);
}

function configuredState(baseUrl, source, options = {}) {
  return Object.freeze({
    status: 'configured',
    source,
    baseUrl,
    durable: source === 'persisted' || source === 'environment',
    failClosed: false,
    canClearPersisted: options.canClearPersisted === true,
    updatedAt: Number.isSafeInteger(options.updatedAt) ? options.updatedAt : null,
    errorCode: null,
    warning: source === 'runtime'
      ? '当前公网 Base URL 只在本进程内有效；重启后将恢复环境配置或安全降级。'
      : null,
  });
}

function unconfiguredState() {
  return Object.freeze({
    status: 'unconfigured',
    source: 'none',
    baseUrl: '',
    durable: true,
    failClosed: true,
    canClearPersisted: false,
    updatedAt: null,
    errorCode: null,
    warning: '尚未配置公网 Base URL；无法证明为本机或局域网直连的请求将保持安全降级。',
  });
}

function invalidState(source, errorCode, options = {}) {
  return Object.freeze({
    status: 'invalid',
    source,
    baseUrl: '',
    durable: true,
    failClosed: true,
    canClearPersisted: options.canClearPersisted === true,
    updatedAt: null,
    errorCode,
    warning: source === 'environment'
      ? '环境变量中的公网 Base URL 无效；远程请求已进入安全降级。'
      : '公网配置文件损坏或无法读取；远程请求已进入安全降级，请清除后重新配置。',
  });
}

function recordPayload(baseUrl, updatedAt) {
  return {
    schema: PUBLIC_EXPOSURE_STORE_SCHEMA,
    version: PUBLIC_EXPOSURE_STORE_VERSION,
    baseUrl,
    updatedAt,
  };
}

function recordChecksum(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function serializeRecord(baseUrl, updatedAt) {
  const payload = recordPayload(baseUrl, updatedAt);
  return `${JSON.stringify({ ...payload, checksum: recordChecksum(payload) }, null, 2)}\n`;
}

function timingSafeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(String(left || '')) || !/^[a-f0-9]{64}$/.test(String(right || ''))) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function parseRecord(raw) {
  let record;
  try {
    record = JSON.parse(String(raw || ''));
  } catch (_) {
    throw storeError('collaboration_public_exposure_store_invalid', '公网配置文件格式无效');
  }
  const keys = record && typeof record === 'object' && !Array.isArray(record)
    ? Object.keys(record).sort()
    : [];
  const expectedKeys = ['baseUrl', 'checksum', 'schema', 'updatedAt', 'version'];
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || record.schema !== PUBLIC_EXPOSURE_STORE_SCHEMA
    || record.version !== PUBLIC_EXPOSURE_STORE_VERSION
    || !Number.isSafeInteger(record.updatedAt)
    || record.updatedAt <= 0) {
    throw storeError('collaboration_public_exposure_store_invalid', '公网配置文件格式无效');
  }
  let baseUrl;
  try {
    baseUrl = normalizePublicBaseUrl(record.baseUrl);
  } catch (_) {
    throw storeError('collaboration_public_exposure_store_invalid', '公网配置文件格式无效');
  }
  if (baseUrl !== record.baseUrl) {
    throw storeError('collaboration_public_exposure_store_invalid', '公网配置文件格式无效');
  }
  const payload = recordPayload(baseUrl, record.updatedAt);
  if (!timingSafeHexEqual(String(record.checksum || '').toLowerCase(), recordChecksum(payload))) {
    throw storeError('collaboration_public_exposure_store_invalid', '公网配置文件校验失败');
  }
  return { baseUrl, updatedAt: record.updatedAt };
}

class PublicExposureStore {
  constructor(options = {}) {
    this.filePath = String(options.filePath || '').trim();
    this.environmentBaseUrl = String(options.environmentBaseUrl || '').trim();
    this.fs = options.fs || fs;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.randomId = typeof options.randomId === 'function'
      ? options.randomId
      : () => crypto.randomUUID();
  }

  environmentState() {
    if (!this.environmentBaseUrl) return unconfiguredState();
    try {
      return configuredState(
        normalizePublicBaseUrl(this.environmentBaseUrl),
        'environment',
      );
    } catch (_) {
      return invalidState('environment', 'collaboration_public_exposure_environment_invalid');
    }
  }

  load() {
    if (!this.filePath) return this.environmentState();
    let stat;
    try {
      stat = this.fs.lstatSync(this.filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return this.environmentState();
      return invalidState('persisted', 'collaboration_public_exposure_store_unreadable', {
        canClearPersisted: true,
      });
    }
    if (!stat?.isFile?.() || stat.isSymbolicLink?.() || stat.size <= 0
      || stat.size > PUBLIC_EXPOSURE_STORE_MAX_BYTES) {
      return invalidState('persisted', 'collaboration_public_exposure_store_invalid', {
        canClearPersisted: true,
      });
    }
    try {
      const record = parseRecord(this.fs.readFileSync(this.filePath, 'utf8'));
      return configuredState(record.baseUrl, 'persisted', {
        canClearPersisted: true,
        updatedAt: record.updatedAt,
      });
    } catch (error) {
      return invalidState(
        'persisted',
        error instanceof PublicExposureStoreError
          ? error.code
          : 'collaboration_public_exposure_store_unreadable',
        { canClearPersisted: true },
      );
    }
  }

  save(value) {
    const baseUrl = normalizePublicBaseUrl(value);
    const updatedAt = Math.max(1, Math.trunc(Number(this.now()) || Date.now()));
    if (!this.filePath) return configuredState(baseUrl, 'runtime', { updatedAt });
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.${this.randomId()}.tmp`;
    let descriptor = null;
    try {
      this.fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      descriptor = this.fs.openSync(tempPath, 'wx', 0o600);
      this.fs.writeFileSync(descriptor, serializeRecord(baseUrl, updatedAt), 'utf8');
      this.fs.fsyncSync(descriptor);
      this.fs.closeSync(descriptor);
      descriptor = null;
      this.fs.renameSync(tempPath, this.filePath);
      try { this.fs.chmodSync(this.filePath, 0o600); } catch (_) {}
      // Directory fsync is unsupported on some Windows filesystems. The rename
      // is still atomic; this best-effort flush only strengthens crash durability.
      try {
        const directoryDescriptor = this.fs.openSync(directory, 'r');
        try { this.fs.fsyncSync(directoryDescriptor); } finally { this.fs.closeSync(directoryDescriptor); }
      } catch (_) {}
      return configuredState(baseUrl, 'persisted', {
        canClearPersisted: true,
        updatedAt,
      });
    } catch (_) {
      if (descriptor != null) {
        try { this.fs.closeSync(descriptor); } catch (_) {}
      }
      try { this.fs.unlinkSync(tempPath); } catch (_) {}
      throw storeError(
        'collaboration_public_exposure_persist_failed',
        '公网 Base URL 无法安全保存；原配置保持不变',
      );
    }
  }

  clear() {
    if (this.filePath) {
      try {
        this.fs.unlinkSync(this.filePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw storeError(
            'collaboration_public_exposure_clear_failed',
            '公网 Base URL 配置无法安全清除；原配置保持不变',
          );
        }
      }
    }
    return this.environmentState();
  }
}

module.exports = {
  PUBLIC_EXPOSURE_STORE_MAX_BYTES,
  PUBLIC_EXPOSURE_STORE_SCHEMA,
  PublicExposureStore,
  PublicExposureStoreError,
  parseRecord,
};
