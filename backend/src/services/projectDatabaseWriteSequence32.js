'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { types: utilTypes } = require('node:util');

const {
  PROJECT_DATABASE_SCHEMA_32_CANONICAL_JSON,
} = require('./projectDatabaseMigration32');
const {
  advanceProjectDatabaseFreshnessFence32,
  normalizeProjectDatabaseFreshnessFence32,
} = require('./projectDatabaseFreshnessFence32');

const PROJECT_DATABASE_WRITE_SEQUENCE_32_INTEGRATION_STATUS = 'standalone-unwired';
const PROJECT_DATABASE_WRITE_SEQUENCE_32_ACK_MAX_BYTES = 16 * 1024;
const PROJECT_DATABASE_WRITE_SEQUENCE_32_CONTEXT_FORMAT =
  't8-project-database-write-transaction-context-v1';
const PROJECT_DATABASE_WRITE_SEQUENCE_32_ACK_FAILURE_MODES = Object.freeze([
  'fail-stop',
  'committed-warning',
]);
const PROJECT_DATABASE_WRITE_SEQUENCE_32_DIRECTORY_DURABILITY_WARNING_CODE =
  'project_database_write_acknowledgement_directory_durability_unconfirmed';

const PROJECT_DATABASE_WRITE_SEQUENCE_32_SELECT_IDENTITY_SQL = String.raw`
SELECT singleton_id, database_uuid, recovery_generation, write_sequence,
       created_at, updated_at
FROM project_database_identity
ORDER BY singleton_id ASC
`;

const PROJECT_DATABASE_WRITE_SEQUENCE_32_ADVANCE_SQL = String.raw`
UPDATE project_database_identity
SET write_sequence = write_sequence + 1,
    updated_at = @updatedAt
WHERE singleton_id = 1
  AND database_uuid = @databaseUuid
  AND recovery_generation = @recoveryGeneration
  AND write_sequence = @expectedWriteSequence
  AND write_sequence < 9007199254740991
RETURNING singleton_id, database_uuid, recovery_generation, write_sequence,
          created_at, updated_at
`;

const PROJECT_DATABASE_WRITE_SEQUENCE_32_CONTRACT = Object.freeze({
  format: 't8-project-database-write-sequence-coordinator-v1',
  integrationStatus: PROJECT_DATABASE_WRITE_SEQUENCE_32_INTEGRATION_STATUS,
  transactionOwnership: 'outermost-public-writer-immediate-transaction',
  nestedPolicy: 'same-context-no-second-sequence-advance',
  externalTransactionPolicy: 'fail-close',
  sequencePolicy: 'advance-exactly-once-inside-the-business-transaction',
  acknowledgementPolicy:
    'canonical-freshness-fence-compare-and-replace-after-successful-commit',
  acknowledgementDirectoryDurabilityPolicy:
    'directory-sync-false-is-a-nonfatal-capability-warning-never-a-persisted-claim',
  acknowledgementFailureModes: PROJECT_DATABASE_WRITE_SEQUENCE_32_ACK_FAILURE_MODES,
  acknowledgementFailureMeaning:
    'database-commit-is-authoritative-never-report-rollback-and-stop-future-writes',
  callbackPolicy: 'synchronous-only',
  contextFormat: PROJECT_DATABASE_WRITE_SEQUENCE_32_CONTEXT_FORMAT,
});

class ProjectDatabaseWriteSequence32Error extends Error {
  constructor(reason, message, details = {}, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProjectDatabaseWriteSequence32Error';
    this.code = reason === 'external-transaction-forbidden'
      ? 'project_database_write_sequence_external_transaction_forbidden'
      : 'project_database_write_sequence_32_invalid';
    this.reason = String(reason || 'invalid');
    this.committed = false;
    this.details = Object.freeze({ reason: this.reason, ...details });
  }
}

class ProjectDatabaseWriteSequence32CommittedError extends Error {
  constructor(message, warning, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProjectDatabaseWriteSequence32CommittedError';
    this.code = 'project_database_write_acknowledgement_failed';
    this.status = 503;
    this.statusCode = 503;
    this.reason = 'acknowledgement-persist-failed';
    this.committed = true;
    this.failStopped = true;
    this.retryable = false;
    this.automaticReplayAllowed = false;
    this.details = warning;
  }
}

function fail(reason, message, details = {}, cause = undefined) {
  throw new ProjectDatabaseWriteSequence32Error(reason, message, details, cause);
}

function safeInteger(value, field, minimum = 0) {
  if (typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > Number.MAX_SAFE_INTEGER) {
    fail('safe-integer-invalid', `${field} must be a safe integer >= ${minimum}`, { field });
  }
  return value;
}

function canonicalUuid(value, field) {
  if (typeof value !== 'string'
    || value !== value.toLowerCase()
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(value)) {
    fail('uuid-invalid', `${field} must be a canonical lowercase RFC 4122 UUID`, { field });
  }
  return value;
}

function normalizeOperation(value) {
  if (typeof value !== 'string'
    || value.length < 1
    || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > 240
    || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('operation-invalid', 'write operation must be a trimmed non-control UTF-8 string', {
      field: 'operation',
    });
  }
  return value;
}

function assertDatabase(database) {
  if (!database
    || typeof database.prepare !== 'function'
    || typeof database.transaction !== 'function') {
    fail('database-required', 'schema32 write sequencing requires an open SQLite database');
  }
  return database;
}

function normalizeIdentityRow(row) {
  if (!row || typeof row !== 'object') {
    fail('identity-invalid', 'project_database_identity must contain exactly one row');
  }
  const identity = Object.freeze({
    singletonId: safeInteger(row.singleton_id, 'identity.singletonId', 1),
    databaseUuid: canonicalUuid(row.database_uuid, 'identity.databaseUuid'),
    recoveryGeneration: canonicalUuid(
      row.recovery_generation,
      'identity.recoveryGeneration',
    ),
    writeSequence: safeInteger(row.write_sequence, 'identity.writeSequence'),
    createdAt: safeInteger(row.created_at, 'identity.createdAt', 1),
    updatedAt: safeInteger(row.updated_at, 'identity.updatedAt', 1),
  });
  if (identity.singletonId !== 1 || identity.updatedAt < identity.createdAt) {
    fail('identity-invalid', 'project_database_identity violates the singleton timestamp contract');
  }
  return identity;
}

function readIdentity(database) {
  const rows = database.prepare(PROJECT_DATABASE_WRITE_SEQUENCE_32_SELECT_IDENTITY_SQL).all();
  if (!Array.isArray(rows) || rows.length !== 1) {
    fail('identity-invalid', 'project_database_identity must contain exactly one row', {
      actualCount: Array.isArray(rows) ? rows.length : null,
    });
  }
  return normalizeIdentityRow(rows[0]);
}

function normalizeProjectDatabaseWriteAcknowledgement32(value) {
  let normalized;
  try {
    normalized = normalizeProjectDatabaseFreshnessFence32(value);
  } catch (cause) {
    fail(
      'acknowledgement-invalid',
      'schema32 write acknowledgement is not a valid freshness fence',
      { fenceReason: cause?.reason || null },
      cause,
    );
  }
  canonicalUuid(value.databaseUuid, 'acknowledgement.databaseUuid');
  canonicalUuid(value.generation, 'acknowledgement.generation');
  if (value.previousGeneration !== null) {
    canonicalUuid(value.previousGeneration, 'acknowledgement.previousGeneration');
  }
  safeInteger(
    value.acknowledgedWriteSequence,
    'acknowledgement.acknowledgedWriteSequence',
  );
  safeInteger(value.updatedAt, 'acknowledgement.updatedAt', 1);
  return normalized;
}

function serializeProjectDatabaseWriteAcknowledgement32(value) {
  const normalized = normalizeProjectDatabaseWriteAcknowledgement32(value);
  return `${PROJECT_DATABASE_SCHEMA_32_CANONICAL_JSON(normalized)}\n`;
}

function parseProjectDatabaseWriteAcknowledgement32(rawValue) {
  const raw = Buffer.isBuffer(rawValue) ? Buffer.from(rawValue) : Buffer.from(String(rawValue), 'utf8');
  if (raw.length < 2 || raw.length > PROJECT_DATABASE_WRITE_SEQUENCE_32_ACK_MAX_BYTES) {
    fail('acknowledgement-size-invalid', 'schema32 write acknowledgement has an invalid size');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch (cause) {
    fail('acknowledgement-utf8-invalid', 'schema32 write acknowledgement is not valid UTF-8', {}, cause);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    fail('acknowledgement-json-invalid', 'schema32 write acknowledgement is not valid JSON', {}, cause);
  }
  const value = normalizeProjectDatabaseWriteAcknowledgement32(parsed);
  const canonical = serializeProjectDatabaseWriteAcknowledgement32(value);
  if (text !== canonical) {
    fail(
      'acknowledgement-canonical-invalid',
      'schema32 write acknowledgement must use the exact canonical JSON encoding',
    );
  }
  return value;
}

function normalizeAcknowledgementFilename(filename) {
  if (typeof filename !== 'string' || filename.length < 1 || filename.includes('\u0000')) {
    fail('acknowledgement-path-invalid', 'acknowledgementFilename must be a non-empty path');
  }
  return path.resolve(filename);
}

function readRegularFile(filename) {
  const before = fs.lstatSync(filename, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    fail('acknowledgement-file-invalid', 'schema32 acknowledgement must be a regular file');
  }
  if (before.size < 2n || before.size > BigInt(PROJECT_DATABASE_WRITE_SEQUENCE_32_ACK_MAX_BYTES)) {
    fail('acknowledgement-size-invalid', 'schema32 write acknowledgement has an invalid size');
  }
  let descriptor = null;
  try {
    descriptor = fs.openSync(filename, 'r');
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail('acknowledgement-file-race', 'schema32 acknowledgement changed before it was opened');
    }
    const raw = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterPath = fs.lstatSync(filename, { bigint: true });
    if (!after.isFile()
      || afterPath.isSymbolicLink()
      || !afterPath.isFile()
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || afterPath.dev !== opened.dev
      || afterPath.ino !== opened.ino
      || BigInt(raw.length) !== opened.size
      || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs) {
      fail('acknowledgement-file-race', 'schema32 acknowledgement changed while it was read');
    }
    return raw;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function readProjectDatabaseWriteAcknowledgement32(filename) {
  const resolved = normalizeAcknowledgementFilename(filename);
  let raw;
  try {
    raw = readRegularFile(resolved);
  } catch (cause) {
    if (cause instanceof ProjectDatabaseWriteSequence32Error) throw cause;
    fail(
      'acknowledgement-read-failed',
      'schema32 write acknowledgement could not be read safely',
      { errorCode: cause?.code || null },
      cause,
    );
  }
  return Object.freeze({
    value: parseProjectDatabaseWriteAcknowledgement32(raw),
    serialized: Buffer.from(raw),
  });
}

function invokeSynchronousHook(hook, context, name) {
  if (hook == null) return;
  if (typeof hook !== 'function') {
    fail('hook-invalid', `${name} must be a function`, { hook: name });
  }
  const result = hook(context);
  if (result && typeof result.then === 'function') {
    fail('hook-async', `${name} must be synchronous`, { hook: name });
  }
}

function fsyncDirectory(directory, provider) {
  if (provider != null) {
    if (typeof provider !== 'function') fail('hook-invalid', 'syncDirectory must be a function');
    const result = provider(directory);
    if (result && typeof result.then === 'function') {
      fail('hook-async', 'syncDirectory must be synchronous', { hook: 'syncDirectory' });
    }
    return result !== false;
  }
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && [
      'EACCES',
      'EBADF',
      'EINVAL',
      'EISDIR',
      'ENOTSUP',
      'EPERM',
    ].includes(String(error?.code || ''))) return false;
    throw error;
  } finally {
    try { if (descriptor != null) fs.closeSync(descriptor); } catch (_) {}
  }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(count) || count <= 0) {
      fail('acknowledgement-write-short', 'schema32 acknowledgement write made no progress');
    }
    offset += count;
  }
}

function writeProjectDatabaseWriteAcknowledgementAtomically32(
  filename,
  value,
  options = {},
) {
  const resolved = normalizeAcknowledgementFilename(filename);
  const expected = Buffer.isBuffer(options.expectedSerialized)
    ? Buffer.from(options.expectedSerialized)
    : Buffer.from(String(options.expectedSerialized ?? ''), 'utf8');
  parseProjectDatabaseWriteAcknowledgement32(expected);
  const serialized = Buffer.from(serializeProjectDatabaseWriteAcknowledgement32(value), 'utf8');
  const suffixProvider = options.createTemporarySuffix
    ?? (() => `${process.pid}-${randomBytes(8).toString('hex')}`);
  if (typeof suffixProvider !== 'function') {
    fail('temporary-suffix-provider-invalid', 'createTemporarySuffix must be a function');
  }
  const suffix = String(suffixProvider());
  if (!/^[0-9A-Za-z_-]{6,96}$/.test(suffix)) {
    fail('temporary-suffix-invalid', 'temporary acknowledgement suffix is invalid');
  }
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.tmp-${suffix}`);
  if (temporary === resolved) fail('acknowledgement-path-invalid', 'temporary path collides with target');

  let descriptor = null;
  let published = false;
  let phase = 'open';
  const hookContext = Object.freeze({ value: normalizeProjectDatabaseWriteAcknowledgement32(value) });
  try {
    invokeSynchronousHook(options.beforeOpen, hookContext, 'beforeOpen');
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    phase = 'write';
    invokeSynchronousHook(options.beforeWrite, hookContext, 'beforeWrite');
    writeAll(descriptor, serialized);
    phase = 'file-fsync';
    invokeSynchronousHook(options.beforeFileFsync, hookContext, 'beforeFileFsync');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;

    phase = 'compare-and-replace';
    invokeSynchronousHook(options.beforeReplace, hookContext, 'beforeReplace');
    const observed = readRegularFile(resolved);
    if (!observed.equals(expected)) {
      fail(
        'acknowledgement-concurrent-change',
        'schema32 acknowledgement changed before atomic replacement',
      );
    }
    const temporaryBytes = readRegularFile(temporary);
    if (!temporaryBytes.equals(serialized)) {
      fail('acknowledgement-temp-invalid', 'temporary acknowledgement bytes changed before replace');
    }
    fs.renameSync(temporary, resolved);
    published = true;

    phase = 'post-replace-verification';
    invokeSynchronousHook(options.afterReplace, hookContext, 'afterReplace');
    const publishedBytes = readRegularFile(resolved);
    if (!publishedBytes.equals(serialized)) {
      fail('acknowledgement-published-invalid', 'published acknowledgement bytes do not match');
    }
    phase = 'directory-fsync';
    const directoryDurable = fsyncDirectory(path.dirname(resolved), options.syncDirectory);
    const durability = directoryDurable ? 'confirmed' : 'directory-unconfirmed';
    const durabilityWarning = directoryDurable
      ? null
      : Object.freeze({
        code: PROJECT_DATABASE_WRITE_SEQUENCE_32_DIRECTORY_DURABILITY_WARNING_CODE,
        reason: 'directory-fsync-unavailable',
        published: true,
        fileDurable: true,
        directoryDurable: false,
        durability,
        failStopped: false,
      });
    return Object.freeze({
      persisted: directoryDurable,
      published: true,
      fileDurable: true,
      directoryDurable,
      status: directoryDurable ? 'persisted' : 'directory-unconfirmed',
      durability,
      durabilityWarning,
      value: parseProjectDatabaseWriteAcknowledgement32(publishedBytes),
    });
  } catch (cause) {
    const details = Object.freeze({
      phase,
      published,
      errorCode: cause?.code || null,
    });
    throw new ProjectDatabaseWriteSequence32Error(
      cause instanceof ProjectDatabaseWriteSequence32Error
        ? cause.reason
        : 'acknowledgement-persist-failed',
      'schema32 write acknowledgement atomic persistence failed',
      details,
      cause,
    );
  } finally {
    try { if (descriptor != null) fs.closeSync(descriptor); } catch (_) {}
    if (!published) {
      try {
        const state = fs.lstatSync(temporary);
        if (!state.isSymbolicLink() && state.isFile()) fs.rmSync(temporary, { force: true });
      } catch (_) {}
    }
  }
}

const CONTEXT_STATE = new WeakMap();

function createTransactionContext(coordinator, state, operation, depth) {
  const context = Object.freeze({
    format: PROJECT_DATABASE_WRITE_SEQUENCE_32_CONTEXT_FORMAT,
    operation,
    outermostOperation: state.outermostOperation,
    depth,
    outermost: depth === 1,
    databaseUuid: state.primary.databaseUuid,
    recoveryGeneration: state.primary.recoveryGeneration,
    startingWriteSequence: state.startingIdentity.writeSequence,
    writeSequence: state.primary.writeSequence,
    sequenceAdvanced: true,
  });
  CONTEXT_STATE.set(context, Object.freeze({ coordinator, state }));
  return context;
}

function assertProjectDatabaseWriteTransactionContext32(database, context) {
  const stored = context && typeof context === 'object' ? CONTEXT_STATE.get(context) : null;
  if (!stored
    || stored.coordinator.database !== database
    || stored.coordinator.activeState !== stored.state
    || database.inTransaction !== true) {
    fail(
      'transaction-context-invalid',
      'schema32 mutation requires the active write-sequence transaction context',
    );
  }
  return context;
}

function nextTimestamp(nowValue, identity, acknowledgement) {
  const now = safeInteger(nowValue, 'now', 1);
  const floor = Math.max(identity.updatedAt, acknowledgement.updatedAt);
  if (floor >= Number.MAX_SAFE_INTEGER) {
    fail('timestamp-exhausted', 'schema32 write timestamp cannot advance safely');
  }
  return Math.max(now, floor + 1);
}

function assertAcknowledgementMatchesIdentity(acknowledgement, identity) {
  if (acknowledgement.databaseUuid !== identity.databaseUuid) {
    fail('acknowledgement-database-uuid-mismatch', 'acknowledgement belongs to another database');
  }
  if (acknowledgement.generation !== identity.recoveryGeneration) {
    fail('acknowledgement-generation-mismatch', 'acknowledgement belongs to another generation');
  }
  if (acknowledgement.acknowledgedWriteSequence !== identity.writeSequence) {
    fail(
      'acknowledged-watermark-mismatch',
      'database write sequence must equal the acknowledged watermark before a new write',
      {
        databaseWriteSequence: identity.writeSequence,
        acknowledgedWriteSequence: acknowledgement.acknowledgedWriteSequence,
      },
    );
  }
}

function createCommittedWarning(operation, primary, cause) {
  return Object.freeze({
    code: 'project_database_write_acknowledgement_failed',
    status: 503,
    statusCode: 503,
    reason: 'acknowledgement-persist-failed',
    committed: true,
    failStopped: true,
    retryable: false,
    automaticReplayAllowed: false,
    operation,
    databaseUuid: primary.databaseUuid,
    recoveryGeneration: primary.recoveryGeneration,
    writeSequence: primary.writeSequence,
    acknowledgementPublished: Boolean(cause?.details?.published),
    acknowledgementPhase: String(cause?.details?.phase || 'unknown'),
    errorCode: cause?.details?.errorCode || cause?.code || null,
  });
}

function createDirectoryDurabilityWarning(operation, primary, persistenceResult) {
  if (!persistenceResult?.durabilityWarning) return null;
  return Object.freeze({
    ...persistenceResult.durabilityWarning,
    committed: true,
    retryable: false,
    automaticReplayAllowed: false,
    operation,
    databaseUuid: primary.databaseUuid,
    recoveryGeneration: primary.recoveryGeneration,
    writeSequence: primary.writeSequence,
  });
}

class ProjectDatabaseWriteSequenceCoordinator32 {
  constructor(options = {}) {
    this.database = assertDatabase(options.database);
    this.acknowledgementFilename = normalizeAcknowledgementFilename(
      options.acknowledgementFilename,
    );
    this.acknowledgementFailureMode = options.acknowledgementFailureMode ?? 'fail-stop';
    if (!PROJECT_DATABASE_WRITE_SEQUENCE_32_ACK_FAILURE_MODES
      .includes(this.acknowledgementFailureMode)) {
      fail('acknowledgement-failure-mode-invalid', 'unsupported acknowledgement failure mode');
    }
    this.now = options.now ?? Date.now;
    if (typeof this.now !== 'function') fail('time-provider-invalid', 'now must be a function');
    this.persistenceOptions = Object.freeze({ ...(options.persistenceOptions || {}) });
    this.afterCommitBeforeAcknowledgement = options.afterCommitBeforeAcknowledgement ?? null;
    if (this.afterCommitBeforeAcknowledgement != null
      && typeof this.afterCommitBeforeAcknowledgement !== 'function') {
      fail('hook-invalid', 'afterCommitBeforeAcknowledgement must be a function');
    }
    const databaseFilename = String(this.database.name || '');
    if (databaseFilename && databaseFilename !== ':memory:') {
      const primary = path.resolve(databaseFilename);
      const protectedPaths = [primary, `${primary}-wal`, `${primary}-shm`, `${primary}-journal`]
        .map((entry) => process.platform === 'win32' ? entry.toLowerCase() : entry);
      const acknowledgementKey = process.platform === 'win32'
        ? this.acknowledgementFilename.toLowerCase()
        : this.acknowledgementFilename;
      if (protectedPaths.includes(acknowledgementKey)) {
        fail('acknowledgement-path-invalid', 'acknowledgement path collides with SQLite state');
      }
    }
    this.activeState = null;
    this.failStopWarning = null;
  }

  isActive() {
    return this.activeState !== null && this.database.inTransaction === true;
  }

  isFailStopped() {
    return this.failStopWarning !== null;
  }

  currentContext() {
    return this.activeState?.currentContext ?? null;
  }

  _invokeCallback(operation, callback, state, depth) {
    const context = createTransactionContext(this, state, operation, depth);
    const previousContext = state.currentContext;
    state.currentContext = context;
    try {
      const result = callback(context);
      if (result && typeof result.then === 'function') {
        const error = new TypeError('schema32 write callback must not return a Promise');
        error.code = 'project_database_write_callback_async';
        throw error;
      }
      return result;
    } finally {
      state.currentContext = previousContext;
    }
  }

  withWrite(operationValue, callback) {
    const operation = normalizeOperation(operationValue);
    if (typeof callback !== 'function') {
      throw new TypeError('schema32 write callback must be a synchronous function');
    }
    if (utilTypes.isAsyncFunction(callback)) {
      const error = new TypeError('schema32 write callback must not be async');
      error.code = 'project_database_write_callback_async';
      throw error;
    }
    if (this.activeState) {
      if (this.database.inTransaction !== true) {
        fail('transaction-context-lost', 'active schema32 coordinator lost its SQLite transaction');
      }
      return this._invokeCallback(
        operation,
        callback,
        this.activeState,
        (this.activeState.currentContext?.depth ?? 1) + 1,
      );
    }
    if (this.failStopWarning) {
      fail(
        'coordinator-fail-stopped',
        'schema32 writer is fail-stopped after an acknowledgement failure',
        { writeSequence: this.failStopWarning.writeSequence },
      );
    }
    if (this.database.inTransaction === true) {
      throw new ProjectDatabaseWriteSequence32Error(
        'external-transaction-forbidden',
        'schema32 public writer refuses a caller-owned SQLite transaction',
        { operation },
      );
    }

    const observation = readProjectDatabaseWriteAcknowledgement32(
      this.acknowledgementFilename,
    );
    const transaction = this.database.transaction(() => {
      const startingIdentity = readIdentity(this.database);
      assertAcknowledgementMatchesIdentity(observation.value, startingIdentity);
      const updatedAt = nextTimestamp(this.now(), startingIdentity, observation.value);
      const advancedRow = this.database
        .prepare(PROJECT_DATABASE_WRITE_SEQUENCE_32_ADVANCE_SQL)
        .get({
          databaseUuid: startingIdentity.databaseUuid,
          recoveryGeneration: startingIdentity.recoveryGeneration,
          expectedWriteSequence: startingIdentity.writeSequence,
          updatedAt,
        });
      const primary = normalizeIdentityRow(advancedRow);
      if (primary.databaseUuid !== startingIdentity.databaseUuid
        || primary.recoveryGeneration !== startingIdentity.recoveryGeneration
        || primary.writeSequence !== startingIdentity.writeSequence + 1
        || primary.updatedAt !== updatedAt) {
        fail('sequence-advance-failed', 'schema32 write sequence did not advance exactly once');
      }
      const state = {
        outermostOperation: operation,
        startingIdentity,
        primary,
        depth: 1,
        currentContext: null,
      };
      this.activeState = state;
      try {
        return Object.freeze({
          value: this._invokeCallback(operation, callback, state, 1),
          primary,
        });
      } finally {
        this.activeState = null;
      }
    });

    const committed = transaction.immediate();
    const nextAcknowledgement = advanceProjectDatabaseFreshnessFence32(
      observation.value,
      {
        ...observation.value,
        acknowledgedWriteSequence: committed.primary.writeSequence,
        updatedAt: committed.primary.updatedAt,
      },
      {
        databaseUuid: committed.primary.databaseUuid,
        recoveryGeneration: committed.primary.recoveryGeneration,
        writeSequence: committed.primary.writeSequence,
      },
    );

    try {
      invokeSynchronousHook(
        this.afterCommitBeforeAcknowledgement,
        Object.freeze({
          operation,
          databaseUuid: committed.primary.databaseUuid,
          recoveryGeneration: committed.primary.recoveryGeneration,
          writeSequence: committed.primary.writeSequence,
        }),
        'afterCommitBeforeAcknowledgement',
      );
      const persisted = writeProjectDatabaseWriteAcknowledgementAtomically32(
        this.acknowledgementFilename,
        nextAcknowledgement,
        {
          ...this.persistenceOptions,
          expectedSerialized: observation.serialized,
        },
      );
      const durabilityWarning = createDirectoryDurabilityWarning(
        operation,
        committed.primary,
        persisted,
      );
      return Object.freeze({
        committed: true,
        value: committed.value,
        primaryIdentity: committed.primary,
        acknowledgement: Object.freeze({
          status: persisted.status,
          published: true,
          fileDurable: persisted.fileDurable,
          directoryDurable: persisted.directoryDurable,
          durability: persisted.durability,
          acknowledgedWriteSequence: persisted.value.acknowledgedWriteSequence,
        }),
        persistenceWarning: null,
        durabilityWarning,
      });
    } catch (cause) {
      const warning = createCommittedWarning(operation, committed.primary, cause);
      this.failStopWarning = warning;
      if (this.acknowledgementFailureMode === 'committed-warning') {
        return Object.freeze({
          committed: true,
          value: committed.value,
          primaryIdentity: committed.primary,
          acknowledgement: Object.freeze({
            status: 'warning',
            published: warning.acknowledgementPublished,
            directoryDurable: false,
            acknowledgedWriteSequence: warning.acknowledgementPublished
              ? committed.primary.writeSequence
              : observation.value.acknowledgedWriteSequence,
            attemptedWriteSequence: committed.primary.writeSequence,
          }),
          persistenceWarning: warning,
          durabilityWarning: null,
        });
      }
      throw new ProjectDatabaseWriteSequence32CommittedError(
        'project database write committed but its acknowledgement could not be persisted',
        warning,
        cause,
      );
    }
  }
}

function createProjectDatabaseWriteSequenceCoordinator32(options) {
  return new ProjectDatabaseWriteSequenceCoordinator32(options);
}

module.exports = Object.freeze({
  PROJECT_DATABASE_WRITE_SEQUENCE_32_ACK_FAILURE_MODES,
  PROJECT_DATABASE_WRITE_SEQUENCE_32_ACK_MAX_BYTES,
  PROJECT_DATABASE_WRITE_SEQUENCE_32_ADVANCE_SQL,
  PROJECT_DATABASE_WRITE_SEQUENCE_32_CONTEXT_FORMAT,
  PROJECT_DATABASE_WRITE_SEQUENCE_32_CONTRACT,
  PROJECT_DATABASE_WRITE_SEQUENCE_32_DIRECTORY_DURABILITY_WARNING_CODE,
  PROJECT_DATABASE_WRITE_SEQUENCE_32_INTEGRATION_STATUS,
  PROJECT_DATABASE_WRITE_SEQUENCE_32_SELECT_IDENTITY_SQL,
  ProjectDatabaseWriteSequence32CommittedError,
  ProjectDatabaseWriteSequence32Error,
  ProjectDatabaseWriteSequenceCoordinator32,
  assertProjectDatabaseWriteTransactionContext32,
  createProjectDatabaseWriteSequenceCoordinator32,
  normalizeProjectDatabaseWriteAcknowledgement32,
  parseProjectDatabaseWriteAcknowledgement32,
  readProjectDatabaseWriteAcknowledgement32,
  serializeProjectDatabaseWriteAcknowledgement32,
  writeProjectDatabaseWriteAcknowledgementAtomically32,
});
