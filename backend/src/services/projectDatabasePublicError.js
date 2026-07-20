'use strict';

const PROJECT_DATABASE_STORAGE_CAPACITY_CODE = 'project_database_storage_capacity_exceeded';
const PUBLIC_PROJECT_DATABASE_CAPACITY_REASONS = new Set([
  'main-page-limit',
  'wal-pressure',
  'filesystem-reserve',
  'sqlite-full',
  'temp-storage-full',
  'backup-storage-full',
]);

function publicProjectDatabaseStorageMessage(reason) {
  return reason === 'filesystem-reserve' || reason === 'backup-storage-full'
    ? '项目数据库所在文件系统空间或配额不足，本次操作未完成'
    : '项目数据库或 SQLite 临时存储空间不足，本次写入已回滚';
}

function translateStorageCapacityError(error, details) {
  // Several route-level test doubles intentionally expose only getProjectDatabase.
  // Resolve the canonical translator lazily so unrelated errors keep their legacy
  // handling when such a minimal adapter is in use.
  let service = null;
  try {
    service = require('./projectDatabase');
  } catch (_) {
    return error;
  }
  return typeof service.translateProjectDatabaseStorageCapacityError === 'function'
    ? service.translateProjectDatabaseStorageCapacityError(error, details)
    : error;
}

function mapProjectDatabaseStorageCapacityPublicError(error, options = {}) {
  const translated = translateStorageCapacityError(error, {
    operation: options.operation,
  });
  if (translated?.code !== PROJECT_DATABASE_STORAGE_CAPACITY_CODE) return null;

  const rawReason = String(translated.reason || translated.details?.reason || '');
  const reason = PUBLIC_PROJECT_DATABASE_CAPACITY_REASONS.has(rawReason)
    ? rawReason
    : 'sqlite-full';
  return {
    status: 507,
    body: {
      success: false,
      code: PROJECT_DATABASE_STORAGE_CAPACITY_CODE,
      error: publicProjectDatabaseStorageMessage(reason),
      reason,
      retryable: translated.retryable === true || translated.details?.retryable === true,
    },
  };
}

function sendProjectDatabaseStorageCapacityError(res, error, options = {}) {
  const mapped = mapProjectDatabaseStorageCapacityPublicError(error, options);
  if (!mapped) return false;
  res.status(mapped.status).json(mapped.body);
  return true;
}

module.exports = {
  PROJECT_DATABASE_STORAGE_CAPACITY_CODE,
  PUBLIC_PROJECT_DATABASE_CAPACITY_REASONS,
  mapProjectDatabaseStorageCapacityPublicError,
  sendProjectDatabaseStorageCapacityError,
};
