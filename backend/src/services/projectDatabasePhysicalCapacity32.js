'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const SQLITE_WAL_HEADER_BYTES = 32;
const SQLITE_WAL_FRAME_HEADER_BYTES = 24;

const mib = (value) => value * 1024 * 1024;
const gib = (value) => value * 1024 * 1024 * 1024;

const DEFAULT_PROJECT_DATABASE_STORAGE_POLICY_32 = Object.freeze({
  policyRevision: 1,
  mainMaxBytes: gib(2),
  walCheckpointTargetBytes: mib(32),
  maximumSingleTransactionWalBytes: mib(128),
  walPressureBytes: mib(192),
  walReserveBytes: mib(256),
  walResidualLimitBytes: mib(16),
  shmReserveBytes: mib(64),
  hotJournalReserveBytes: mib(128),
  sqliteTempReserveBytes: mib(512),
  minimumFilesystemFreeBytes: mib(512),
  backupCandidateReserveBytes: gib(2) + mib(16 + 64 + 128),
  recoveryEvidenceReserveBytes: gib(2) + mib(256 + 64 + 128),
  synchronousMode: 'FULL',
});

class ProjectDatabasePhysicalCapacityAdmissionError extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.name = 'ProjectDatabasePhysicalCapacityAdmissionError';
    this.code = 'project_database_storage_capacity_exceeded';
    this.status = 507;
    this.statusCode = 507;
    this.reason = String(reason || 'measurement-unknown');
    this.retryable = ['wal-pressure', 'filesystem-reserve', 'temp-storage-full']
      .includes(this.reason);
    this.details = Object.freeze({
      reason: this.reason,
      retryable: this.retryable,
      ...details,
    });
  }
}

function safeInteger(value, field, { minimum = 0 } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    const error = new TypeError(`schema32 storage policy ${field} must be a safe integer >= ${minimum}`);
    error.code = 'project_database_storage_policy_invalid';
    error.field = field;
    throw error;
  }
  return normalized;
}

function normalizeProjectDatabaseStoragePolicy32(input = {}, options = {}) {
  const source = { ...DEFAULT_PROJECT_DATABASE_STORAGE_POLICY_32, ...input };
  const policy = {
    policyRevision: safeInteger(source.policyRevision, 'policyRevision', { minimum: 1 }),
    mainMaxBytes: safeInteger(source.mainMaxBytes, 'mainMaxBytes', { minimum: 1 }),
    walCheckpointTargetBytes: safeInteger(
      source.walCheckpointTargetBytes,
      'walCheckpointTargetBytes',
      { minimum: 1 },
    ),
    maximumSingleTransactionWalBytes: safeInteger(
      source.maximumSingleTransactionWalBytes,
      'maximumSingleTransactionWalBytes',
      { minimum: 1 },
    ),
    walPressureBytes: safeInteger(source.walPressureBytes, 'walPressureBytes', { minimum: 1 }),
    walReserveBytes: safeInteger(source.walReserveBytes, 'walReserveBytes', { minimum: 1 }),
    walResidualLimitBytes: safeInteger(source.walResidualLimitBytes, 'walResidualLimitBytes'),
    shmReserveBytes: safeInteger(source.shmReserveBytes, 'shmReserveBytes', { minimum: 1 }),
    hotJournalReserveBytes: safeInteger(
      source.hotJournalReserveBytes,
      'hotJournalReserveBytes',
      { minimum: 1 },
    ),
    sqliteTempReserveBytes: safeInteger(
      source.sqliteTempReserveBytes,
      'sqliteTempReserveBytes',
      { minimum: 1 },
    ),
    minimumFilesystemFreeBytes: safeInteger(
      source.minimumFilesystemFreeBytes,
      'minimumFilesystemFreeBytes',
      { minimum: 1 },
    ),
    backupCandidateReserveBytes: safeInteger(
      source.backupCandidateReserveBytes,
      'backupCandidateReserveBytes',
      { minimum: 1 },
    ),
    recoveryEvidenceReserveBytes: safeInteger(
      source.recoveryEvidenceReserveBytes,
      'recoveryEvidenceReserveBytes',
      { minimum: 1 },
    ),
    synchronousMode: String(source.synchronousMode || '').toUpperCase(),
    updatedAt: safeInteger(
      source.updatedAt ?? options.updatedAt ?? Date.now(),
      'updatedAt',
      { minimum: 1 },
    ),
  };
  if (policy.synchronousMode !== 'FULL') {
    const error = new TypeError('schema32 storage policy synchronousMode must be FULL');
    error.code = 'project_database_storage_policy_invalid';
    error.field = 'synchronousMode';
    throw error;
  }
  if (policy.walResidualLimitBytes > policy.walCheckpointTargetBytes
    || policy.walCheckpointTargetBytes + policy.maximumSingleTransactionWalBytes
      >= policy.walPressureBytes
    || policy.walPressureBytes >= policy.walReserveBytes) {
    const error = new TypeError('schema32 WAL policy ordering is invalid');
    error.code = 'project_database_storage_policy_invalid';
    error.field = 'walPressureBytes';
    throw error;
  }
  const requiredActiveStorageBudgetBytes = policy.mainMaxBytes
    + policy.walReserveBytes
    + policy.shmReserveBytes
    + policy.hotJournalReserveBytes
    + policy.sqliteTempReserveBytes
    + policy.minimumFilesystemFreeBytes;
  const minimumBackupCandidateReserveBytes = policy.mainMaxBytes
    + policy.walResidualLimitBytes
    + policy.shmReserveBytes
    + policy.hotJournalReserveBytes;
  if (!Number.isSafeInteger(requiredActiveStorageBudgetBytes)
    || !Number.isSafeInteger(minimumBackupCandidateReserveBytes)
    || policy.backupCandidateReserveBytes < minimumBackupCandidateReserveBytes
    || !Number.isSafeInteger(
      requiredActiveStorageBudgetBytes
      + policy.backupCandidateReserveBytes
      + policy.recoveryEvidenceReserveBytes,
    )) {
    const error = new TypeError('schema32 storage policy reserve arithmetic is invalid');
    error.code = 'project_database_storage_policy_invalid';
    error.field = 'activeStorageBudgetBytes';
    throw error;
  }
  return Object.freeze({
    ...policy,
    activeStorageBudgetBytes: requiredActiveStorageBudgetBytes,
    minimumBackupCandidateReserveBytes,
  });
}

function projectDatabaseStoragePolicy32Row(policyInput = {}, options = {}) {
  const policy = normalizeProjectDatabaseStoragePolicy32(policyInput, options);
  return Object.freeze({
    singleton_id: 1,
    policy_revision: policy.policyRevision,
    active_storage_budget_bytes: policy.activeStorageBudgetBytes,
    main_max_bytes: policy.mainMaxBytes,
    wal_checkpoint_target_bytes: policy.walCheckpointTargetBytes,
    maximum_single_transaction_wal_bytes: policy.maximumSingleTransactionWalBytes,
    wal_pressure_bytes: policy.walPressureBytes,
    wal_reserve_bytes: policy.walReserveBytes,
    wal_residual_limit_bytes: policy.walResidualLimitBytes,
    shm_reserve_bytes: policy.shmReserveBytes,
    hot_journal_reserve_bytes: policy.hotJournalReserveBytes,
    sqlite_temp_reserve_bytes: policy.sqliteTempReserveBytes,
    minimum_filesystem_free_bytes: policy.minimumFilesystemFreeBytes,
    backup_candidate_reserve_bytes: policy.backupCandidateReserveBytes,
    recovery_evidence_reserve_bytes: policy.recoveryEvidenceReserveBytes,
    synchronous_mode: policy.synchronousMode,
    updated_at: policy.updatedAt,
  });
}

function projectDatabaseStoragePolicy32FromRow(row) {
  if (!row || Number(row.singleton_id) !== 1) {
    const error = new Error('schema32 storage policy singleton is missing');
    error.code = 'project_database_storage_policy_invalid';
    throw error;
  }
  return normalizeProjectDatabaseStoragePolicy32({
    policyRevision: row.policy_revision,
    mainMaxBytes: row.main_max_bytes,
    walCheckpointTargetBytes: row.wal_checkpoint_target_bytes,
    maximumSingleTransactionWalBytes: row.maximum_single_transaction_wal_bytes,
    walPressureBytes: row.wal_pressure_bytes,
    walReserveBytes: row.wal_reserve_bytes,
    walResidualLimitBytes: row.wal_residual_limit_bytes,
    shmReserveBytes: row.shm_reserve_bytes,
    hotJournalReserveBytes: row.hot_journal_reserve_bytes,
    sqliteTempReserveBytes: row.sqlite_temp_reserve_bytes,
    minimumFilesystemFreeBytes: row.minimum_filesystem_free_bytes,
    backupCandidateReserveBytes: row.backup_candidate_reserve_bytes,
    recoveryEvidenceReserveBytes: row.recovery_evidence_reserve_bytes,
    synchronousMode: row.synchronous_mode,
    updatedAt: row.updated_at,
  });
}

function safeObservedBytes(value) {
  try {
    const bytes = typeof value === 'bigint' ? value : BigInt(value);
    if (bytes < 0n || bytes > BigInt(MAX_SAFE_INTEGER)) return null;
    return Number(bytes);
  } catch (_) {
    return null;
  }
}

function observeFileBytes(filename, stat = fs.statSync) {
  if (!filename) return 0;
  try {
    const state = stat(filename, { bigint: true });
    return safeObservedBytes(state.size);
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    return null;
  }
}

function observeFilesystemFreeBytes(directory, statfs = fs.statfsSync) {
  if (!directory || typeof statfs !== 'function') return null;
  try {
    const state = statfs(directory, { bigint: true });
    return safeObservedBytes(state.bavail * state.bsize);
  } catch (_) {
    return null;
  }
}

function observeFilesystemIdentity(directory, stat = fs.statSync) {
  if (!directory) return null;
  try {
    const state = stat(directory, { bigint: true });
    if (state.dev != null) return `dev:${String(state.dev)}`;
    const root = path.parse(path.resolve(directory)).root;
    return root ? `root:${process.platform === 'win32' ? root.toLocaleLowerCase('en-US') : root}` : null;
  } catch (_) {
    return null;
  }
}

function safeByteProduct(left, right) {
  if (left == null || right == null) return null;
  const product = BigInt(left) * BigInt(right);
  return safeObservedBytes(product);
}

function observeProjectDatabasePhysicalStorage32(database, options = {}) {
  const filename = String(options.filename || database?.name || '');
  const memory = filename === ':memory:' || filename === '';
  const databaseDirectory = memory ? null : path.dirname(path.resolve(filename));
  const tempDirectory = path.resolve(options.tempDirectory || os.tmpdir());
  const stat = options.stat || fs.statSync;
  const statfs = options.statfs || fs.statfsSync;
  const pageSize = safeObservedBytes(database.pragma('page_size', { simple: true }));
  const pageCount = safeObservedBytes(database.pragma('page_count', { simple: true }));
  const files = memory ? {
    mainBytes: 0,
    walBytes: 0,
    shmBytes: 0,
    hotJournalBytes: 0,
  } : {
    mainBytes: observeFileBytes(filename, stat),
    walBytes: observeFileBytes(`${filename}-wal`, stat),
    shmBytes: observeFileBytes(`${filename}-shm`, stat),
    hotJournalBytes: observeFileBytes(`${filename}-journal`, stat),
  };
  const knownFiles = Object.values(files).every((value) => value != null);
  const databaseFilesystemFreeBytes = memory
    ? null
    : observeFilesystemFreeBytes(databaseDirectory, statfs);
  const tempFilesystemFreeBytes = memory
    ? null
    : observeFilesystemFreeBytes(tempDirectory, statfs);
  const databaseFilesystemIdentity = memory
    ? null
    : observeFilesystemIdentity(databaseDirectory, stat);
  const tempFilesystemIdentity = memory
    ? null
    : observeFilesystemIdentity(tempDirectory, stat);
  const allocatedPageBytes = safeByteProduct(pageSize, pageCount);
  const databaseAndTempShareFilesystem = memory
    ? null
    : databaseFilesystemIdentity != null
      && tempFilesystemIdentity != null
      && databaseFilesystemIdentity === tempFilesystemIdentity;
  return Object.freeze({
    memory,
    pageSize,
    pageCount,
    allocatedPageBytes,
    ...files,
    databaseFilesystemFreeBytes,
    tempFilesystemFreeBytes,
    databaseFilesystemIdentity,
    tempFilesystemIdentity,
    databaseAndTempShareFilesystem,
    complete: memory || (
      pageSize != null
      && pageCount != null
      && allocatedPageBytes != null
      && knownFiles
      && databaseFilesystemFreeBytes != null
      && tempFilesystemFreeBytes != null
      && databaseFilesystemIdentity != null
      && tempFilesystemIdentity != null
    ),
  });
}

function pragmaInteger(database, pragma) {
  return Number(database.pragma(pragma, { simple: true }));
}

function applyProjectDatabasePhysicalPragmas32(database, policyInput = {}) {
  const policy = normalizeProjectDatabaseStoragePolicy32(policyInput);
  const pageSize = pragmaInteger(database, 'page_size');
  const pageCount = pragmaInteger(database, 'page_count');
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0
    || !Number.isSafeInteger(pageCount) || pageCount < 0) {
    throw new ProjectDatabasePhysicalCapacityAdmissionError(
      'measurement-unknown',
      '无法可靠读取 SQLite 页容量状态',
    );
  }
  const maxPageCount = Math.floor(policy.mainMaxBytes / pageSize);
  if (maxPageCount < Math.max(1, pageCount)) {
    throw new ProjectDatabasePhysicalCapacityAdmissionError(
      'main-page-limit',
      '当前项目数据库已超过配置的主库上限',
      { pageCount, maxPageCount },
    );
  }
  const appliedMaxPageCount = pragmaInteger(database, `main.max_page_count = ${maxPageCount}`);
  if (appliedMaxPageCount !== maxPageCount) {
    throw new ProjectDatabasePhysicalCapacityAdmissionError(
      'configuration-invalid',
      '无法精确应用 SQLite 主库页上限',
      { maxPageCount, appliedMaxPageCount },
    );
  }
  const frameBytes = pageSize + SQLITE_WAL_FRAME_HEADER_BYTES;
  const walAutoCheckpointPages = Math.floor(
    (policy.walCheckpointTargetBytes - SQLITE_WAL_HEADER_BYTES) / frameBytes,
  );
  if (walAutoCheckpointPages < 1) {
    throw new ProjectDatabasePhysicalCapacityAdmissionError(
      'configuration-invalid',
      'WAL checkpoint target is smaller than one complete frame',
    );
  }
  const appliedWalAutoCheckpointPages = pragmaInteger(
    database,
    `wal_autocheckpoint = ${walAutoCheckpointPages}`,
  );
  const appliedJournalSizeLimit = pragmaInteger(
    database,
    `journal_size_limit = ${policy.walResidualLimitBytes}`,
  );
  database.pragma('synchronous = FULL');
  database.pragma('recursive_triggers = ON');
  const synchronous = pragmaInteger(database, 'synchronous');
  const recursiveTriggers = pragmaInteger(database, 'recursive_triggers');
  if (appliedWalAutoCheckpointPages !== walAutoCheckpointPages
    || appliedJournalSizeLimit !== policy.walResidualLimitBytes
    || synchronous !== 2
    || recursiveTriggers !== 1) {
    throw new ProjectDatabasePhysicalCapacityAdmissionError(
      'configuration-invalid',
      '无法精确应用 schema32 SQLite 运行策略',
      {
        walAutoCheckpointPages,
        appliedWalAutoCheckpointPages,
        appliedJournalSizeLimit,
        synchronous,
        recursiveTriggers,
      },
    );
  }
  return Object.freeze({
    pageSize,
    pageCount,
    maxPageCount,
    frameBytes,
    walAutoCheckpointPages,
    journalSizeLimitBytes: appliedJournalSizeLimit,
    synchronousMode: 'FULL',
    recursiveTriggers: true,
  });
}

function checkpointProjectDatabaseWal32(database, mode = 'PASSIVE') {
  const normalizedMode = String(mode || '').toUpperCase();
  if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(normalizedMode)) {
    throw new TypeError('unsupported WAL checkpoint mode');
  }
  const row = database.pragma(`wal_checkpoint(${normalizedMode})`)[0] || {};
  const result = Object.freeze({
    mode: normalizedMode,
    busy: Math.max(0, Number(row.busy) || 0),
    logFrames: Math.max(0, Number(row.log) || 0),
    checkpointedFrames: Math.max(0, Number(row.checkpointed) || 0),
  });
  return Object.freeze({
    ...result,
    complete: result.busy === 0 && result.checkpointedFrames >= result.logFrames,
  });
}

function assertProjectDatabaseWriteAdmission32(snapshot, policyInput = {}) {
  const policy = normalizeProjectDatabaseStoragePolicy32(policyInput);
  if (snapshot?.memory === true) return Object.freeze({ admitted: true, memory: true });
  if (!snapshot || snapshot.complete !== true) {
    throw new ProjectDatabasePhysicalCapacityAdmissionError(
      'measurement-unknown',
      '项目数据库物理容量观测不完整，已停止新写入',
    );
  }
  if (snapshot.pageSize <= 0 || snapshot.pageCount < 0
    || snapshot.allocatedPageBytes == null
    || snapshot.allocatedPageBytes > policy.mainMaxBytes
    || snapshot.mainBytes > policy.mainMaxBytes) {
    throw new ProjectDatabasePhysicalCapacityAdmissionError(
      'main-page-limit',
      '项目数据库主库已达到物理容量上限',
    );
  }
  if (snapshot.walBytes + policy.maximumSingleTransactionWalBytes
    >= policy.walPressureBytes) {
    throw new ProjectDatabasePhysicalCapacityAdmissionError(
      'wal-pressure',
      'WAL 压力已达安全拒绝线，请等待读者释放后重试',
      { checkpointRecommended: true },
    );
  }
  if (typeof snapshot.databaseAndTempShareFilesystem !== 'boolean') {
    throw new ProjectDatabasePhysicalCapacityAdmissionError(
      'measurement-unknown',
      '无法确认项目数据库与 SQLite 临时目录是否共享同一文件系统，已停止新写入',
    );
  }
  const consumedMainBytes = Math.max(snapshot.mainBytes, snapshot.allocatedPageBytes);
  const requiredDatabaseFreeBytes = Math.max(0, policy.mainMaxBytes - consumedMainBytes)
    + Math.max(0, policy.walReserveBytes - snapshot.walBytes)
    + Math.max(0, policy.shmReserveBytes - snapshot.shmBytes)
    + Math.max(0, policy.hotJournalReserveBytes - snapshot.hotJournalBytes)
    + policy.minimumFilesystemFreeBytes
    + (snapshot.databaseAndTempShareFilesystem ? policy.sqliteTempReserveBytes : 0);
  const observedDatabaseFreeBytes = snapshot.databaseAndTempShareFilesystem
    ? Math.min(snapshot.databaseFilesystemFreeBytes, snapshot.tempFilesystemFreeBytes)
    : snapshot.databaseFilesystemFreeBytes;
  if (observedDatabaseFreeBytes < requiredDatabaseFreeBytes) {
    throw new ProjectDatabasePhysicalCapacityAdmissionError(
      'filesystem-reserve',
      '项目数据库所在磁盘的安全空间不足',
      { requiredDatabaseFreeBytes, observedDatabaseFreeBytes },
    );
  }
  if (!snapshot.databaseAndTempShareFilesystem
    && snapshot.tempFilesystemFreeBytes < policy.sqliteTempReserveBytes) {
    throw new ProjectDatabasePhysicalCapacityAdmissionError(
      'temp-storage-full',
      'SQLite 临时存储所在磁盘的安全空间不足',
      {
        requiredTempFreeBytes: policy.sqliteTempReserveBytes,
        observedTempFreeBytes: snapshot.tempFilesystemFreeBytes,
      },
    );
  }
  return Object.freeze({ admitted: true, memory: false });
}

function assertProjectDatabaseMigrationAdmission32(snapshot, policyInput = {}) {
  const policy = normalizeProjectDatabaseStoragePolicy32(policyInput);
  assertProjectDatabaseWriteAdmission32(snapshot, policy);
  if (snapshot?.memory === true) return Object.freeze({ admitted: true, memory: true });
  const consumedMainBytes = Math.max(snapshot.mainBytes, snapshot.allocatedPageBytes);
  const requiredDatabaseFreeBytes = Math.max(0, policy.mainMaxBytes - consumedMainBytes)
    + Math.max(0, policy.walReserveBytes - snapshot.walBytes)
    + Math.max(0, policy.shmReserveBytes - snapshot.shmBytes)
    + Math.max(0, policy.hotJournalReserveBytes - snapshot.hotJournalBytes)
    + policy.minimumFilesystemFreeBytes
    + (snapshot.databaseAndTempShareFilesystem ? policy.sqliteTempReserveBytes : 0)
    + policy.backupCandidateReserveBytes
    + policy.recoveryEvidenceReserveBytes;
  const observedDatabaseFreeBytes = snapshot.databaseAndTempShareFilesystem
    ? Math.min(snapshot.databaseFilesystemFreeBytes, snapshot.tempFilesystemFreeBytes)
    : snapshot.databaseFilesystemFreeBytes;
  if (observedDatabaseFreeBytes < requiredDatabaseFreeBytes) {
    throw new ProjectDatabasePhysicalCapacityAdmissionError(
      'filesystem-reserve',
      'schema32 迁移缺少备份候选与恢复证据的安全空间',
      { migration: true, requiredDatabaseFreeBytes, observedDatabaseFreeBytes },
    );
  }
  return Object.freeze({ admitted: true, memory: false });
}

module.exports = Object.freeze({
  DEFAULT_PROJECT_DATABASE_STORAGE_POLICY_32,
  ProjectDatabasePhysicalCapacityAdmissionError,
  SQLITE_WAL_FRAME_HEADER_BYTES,
  SQLITE_WAL_HEADER_BYTES,
  applyProjectDatabasePhysicalPragmas32,
  assertProjectDatabaseMigrationAdmission32,
  assertProjectDatabaseWriteAdmission32,
  checkpointProjectDatabaseWal32,
  normalizeProjectDatabaseStoragePolicy32,
  observeProjectDatabasePhysicalStorage32,
  projectDatabaseStoragePolicy32FromRow,
  projectDatabaseStoragePolicy32Row,
});
