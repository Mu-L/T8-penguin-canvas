'use strict';

const { createHash } = require('node:crypto');

const PROJECT_DATABASE_FRESHNESS_FENCE_32_VERSION = 3;
const PROJECT_DATABASE_FRESHNESS_FENCE_32_INTEGRATION_STATUS = 'standalone-unwired';
const PROJECT_DATABASE_FRESHNESS_FENCE_32_REASON_MAX_BYTES = 120;

const PROJECT_DATABASE_FRESHNESS_FENCE_32_FIELDS = Object.freeze([
  'version',
  'databaseUuid',
  'generation',
  'previousGeneration',
  'acknowledgedWriteSequence',
  'reason',
  'requiresSnapshot',
  'updatedAt',
]);

const PROJECT_DATABASE_FRESHNESS_FENCE_32_CREATE_FIELDS = Object.freeze(
  PROJECT_DATABASE_FRESHNESS_FENCE_32_FIELDS.filter((field) => field !== 'version'),
);

const PROJECT_DATABASE_PRIMARY_IDENTITY_FIELDS_32 = Object.freeze([
  'databaseUuid',
  'recoveryGeneration',
  'writeSequence',
]);

// This is a canonical projection of the self-contained schema-32 receipt. The
// remaining receipt fields are covered by the explicit verification witnesses
// below and are not silently inferred by this standalone module.
const PROJECT_DATABASE_CANONICAL_RECEIPT_EVIDENCE_FIELDS_32 = Object.freeze([
  'receiptUuid',
  'databaseUuid',
  'recoveryGeneration',
  'capturedWriteSequence',
  'identityDigest',
  'migrationReceiptDigest',
  'logicalContentDigest',
  'schemaFingerprint',
]);

const PROJECT_DATABASE_CANONICAL_RECEIPT_VERIFICATION_FIELDS_32 = Object.freeze([
  'receiptEvidenceDigest',
  'readOnly',
  'quickCheck',
  'foreignKeyCheck',
  'manifest',
  'head',
  'identity',
  'migration',
  'logical',
  'schema',
]);

const PROJECT_DATABASE_FRESHNESS_FENCE_32_CONTRACT = Object.freeze({
  format: 't8-project-database-recovery-generation-sidecar-v3',
  integrationStatus: PROJECT_DATABASE_FRESHNESS_FENCE_32_INTEGRATION_STATUS,
  persistenceStatus: 'caller-owned-no-filesystem-writes',
  version: PROJECT_DATABASE_FRESHNESS_FENCE_32_VERSION,
  fields: PROJECT_DATABASE_FRESHNESS_FENCE_32_FIELDS,
  canonicalReceiptVerificationFields:
    PROJECT_DATABASE_CANONICAL_RECEIPT_VERIFICATION_FIELDS_32,
  transitionPrimaryBinding: 'required-exact-uuid-generation-and-write-sequence',
  generationReuseGuarantee: 'current-and-one-hop-previous-only-global-ledger-still-required',
  receiptVerificationBinding:
    'all-verification-witnesses-bound-to-one-canonical-receipt-evidence-digest',
  automaticRecoveryPolicy: 'standalone-module-never-authorizes-recovery',
});

class ProjectDatabaseFreshnessFence32Error extends TypeError {
  constructor(reason, message, details = {}) {
    super(message);
    this.name = 'ProjectDatabaseFreshnessFence32Error';
    this.code = 'project_database_freshness_fence_32_invalid';
    this.reason = String(reason || 'invalid');
    this.details = Object.freeze({
      reason: this.reason,
      ...details,
    });
  }
}

function fail(reason, message, details = {}) {
  throw new ProjectDatabaseFreshnessFence32Error(reason, message, details);
}

function assertExactOrdinaryObject(value, expectedFields, context) {
  if (value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('ordinary-object-required', `${context} must be an ordinary JSON object`, { context });
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    fail('field-set-invalid', `${context} has a non-JSON own key`, { context });
  }
  const actualFields = ownKeys.slice().sort();
  const expected = [...expectedFields].sort();
  if (actualFields.length !== expected.length
    || actualFields.some((field, index) => field !== expected[index])) {
    fail('field-set-invalid', `${context} has an invalid exact field set`, { context });
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const field of expected) {
    const descriptor = descriptors[field];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      fail('ordinary-object-required', `${context}.${field} must be an enumerable data field`, {
        context,
        field,
      });
    }
  }
  return value;
}

function normalizeUuid(value, field) {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)) {
    fail('uuid-invalid', `${field} must be an RFC 4122 UUID`, { field });
  }
  return value.toLowerCase();
}

function normalizeSafeInteger(value, field, minimum) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    fail('safe-integer-invalid', `${field} must be a safe integer >= ${minimum}`, {
      field,
      minimum,
    });
  }
  return value;
}

function normalizeReason(value) {
  if (typeof value !== 'string'
    || value.length < 1
    || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > PROJECT_DATABASE_FRESHNESS_FENCE_32_REASON_MAX_BYTES
    || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('reason-invalid', 'reason must be a trimmed, non-control UTF-8 string of at most 120 bytes', {
      field: 'reason',
    });
  }
  return value;
}

function normalizeSha256(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    fail('sha256-invalid', `${field} must be a canonical lowercase SHA-256 digest`, { field });
  }
  return value;
}

function normalizeProjectDatabaseFreshnessFence32(value) {
  assertExactOrdinaryObject(
    value,
    PROJECT_DATABASE_FRESHNESS_FENCE_32_FIELDS,
    'schema32 freshness fence',
  );
  if (value.version !== PROJECT_DATABASE_FRESHNESS_FENCE_32_VERSION) {
    fail('version-invalid', 'schema32 freshness fence version must be exactly 3', {
      field: 'version',
    });
  }
  const databaseUuid = normalizeUuid(value.databaseUuid, 'databaseUuid');
  const generation = normalizeUuid(value.generation, 'generation');
  const previousGeneration = value.previousGeneration === null
    ? null
    : normalizeUuid(value.previousGeneration, 'previousGeneration');
  if (previousGeneration === generation) {
    fail('generation-cycle', 'previousGeneration must not equal generation', {
      field: 'previousGeneration',
    });
  }
  const acknowledgedWriteSequence = normalizeSafeInteger(
    value.acknowledgedWriteSequence,
    'acknowledgedWriteSequence',
    0,
  );
  const reason = normalizeReason(value.reason);
  if (typeof value.requiresSnapshot !== 'boolean') {
    fail('requires-snapshot-invalid', 'requiresSnapshot must be a boolean', {
      field: 'requiresSnapshot',
    });
  }
  if (value.requiresSnapshot === false
    && (previousGeneration !== null || !['initialize', 'memory-database'].includes(reason))) {
    fail(
      'requires-snapshot-downgrade',
      'requiresSnapshot=false is only valid for an initial database generation',
      { field: 'requiresSnapshot' },
    );
  }
  const updatedAt = normalizeSafeInteger(value.updatedAt, 'updatedAt', 1);
  return Object.freeze({
    version: PROJECT_DATABASE_FRESHNESS_FENCE_32_VERSION,
    databaseUuid,
    generation,
    previousGeneration,
    acknowledgedWriteSequence,
    reason,
    requiresSnapshot: value.requiresSnapshot,
    updatedAt,
  });
}

function createProjectDatabaseFreshnessFence32(value) {
  assertExactOrdinaryObject(
    value,
    PROJECT_DATABASE_FRESHNESS_FENCE_32_CREATE_FIELDS,
    'schema32 freshness fence create input',
  );
  return normalizeProjectDatabaseFreshnessFence32({
    version: PROJECT_DATABASE_FRESHNESS_FENCE_32_VERSION,
    databaseUuid: value.databaseUuid,
    generation: value.generation,
    previousGeneration: value.previousGeneration,
    acknowledgedWriteSequence: value.acknowledgedWriteSequence,
    reason: value.reason,
    requiresSnapshot: value.requiresSnapshot,
    updatedAt: value.updatedAt,
  });
}

function assertNondecreasingTimestamp(current, next, changed, transition) {
  if (next.updatedAt < current.updatedAt || (changed && next.updatedAt === current.updatedAt)) {
    fail('updated-at-regression', `${transition} must advance updatedAt when state changes`, {
      currentUpdatedAt: current.updatedAt,
      nextUpdatedAt: next.updatedAt,
    });
  }
}

function advanceProjectDatabaseFreshnessFence32(currentValue, nextValue, primaryValue) {
  const current = normalizeProjectDatabaseFreshnessFence32(currentValue);
  const next = normalizeProjectDatabaseFreshnessFence32(nextValue);
  const primary = normalizeProjectDatabasePrimaryIdentity32(primaryValue);
  if (next.databaseUuid !== current.databaseUuid) {
    fail('database-uuid-transition', 'acknowledged watermark cannot change databaseUuid');
  }
  if (next.generation !== current.generation) {
    fail('generation-transition', 'acknowledged watermark cannot change generation');
  }
  if (next.previousGeneration !== current.previousGeneration) {
    fail('previous-generation-transition', 'acknowledged watermark cannot change previousGeneration');
  }
  if (next.acknowledgedWriteSequence < current.acknowledgedWriteSequence) {
    fail('acknowledged-write-sequence-regression', 'acknowledged watermark cannot regress', {
      currentAcknowledgedWriteSequence: current.acknowledgedWriteSequence,
      nextAcknowledgedWriteSequence: next.acknowledgedWriteSequence,
    });
  }
  if (current.requiresSnapshot && !next.requiresSnapshot) {
    fail('requires-snapshot-downgrade', 'acknowledged watermark cannot clear requiresSnapshot');
  }
  const stateChanged = next.acknowledgedWriteSequence !== current.acknowledgedWriteSequence
    || next.reason !== current.reason
    || next.requiresSnapshot !== current.requiresSnapshot;
  assertNondecreasingTimestamp(current, next, stateChanged, 'acknowledged watermark transition');
  if (primary.databaseUuid !== next.databaseUuid) {
    fail('primary-database-uuid-mismatch', 'primary databaseUuid must match the freshness fence');
  }
  if (primary.recoveryGeneration !== next.generation) {
    fail('primary-generation-mismatch', 'primary recoveryGeneration must match the freshness fence');
  }
  if (primary.writeSequence !== next.acknowledgedWriteSequence) {
    fail(
      'primary-write-sequence-mismatch',
      'acknowledged watermark must equal the observed primary writeSequence',
      {
        primaryWriteSequence: primary.writeSequence,
        nextAcknowledgedWriteSequence: next.acknowledgedWriteSequence,
      },
    );
  }
  return next;
}

function rotateProjectDatabaseFreshnessFenceAfterRecovery32(
  currentValue,
  nextValue,
  primaryAfterRecoveryValue,
) {
  const current = normalizeProjectDatabaseFreshnessFence32(currentValue);
  const next = normalizeProjectDatabaseFreshnessFence32(nextValue);
  const primaryAfterRecovery = normalizeProjectDatabasePrimaryIdentity32(
    primaryAfterRecoveryValue,
  );
  if (next.databaseUuid !== current.databaseUuid) {
    fail('database-uuid-transition', 'recovery rotation cannot change databaseUuid');
  }
  if (next.generation === current.generation
    || (current.previousGeneration !== null && next.generation === current.previousGeneration)) {
    fail(
      'generation-cycle',
      'recovery rotation must differ from the current and one-hop previous generations',
    );
  }
  if (next.previousGeneration !== current.generation) {
    fail('previous-generation-transition', 'recovery rotation previousGeneration must equal current generation');
  }
  if (next.acknowledgedWriteSequence < current.acknowledgedWriteSequence) {
    fail('acknowledged-write-sequence-regression', 'recovery rotation cannot regress acknowledged watermark', {
      currentAcknowledgedWriteSequence: current.acknowledgedWriteSequence,
      nextAcknowledgedWriteSequence: next.acknowledgedWriteSequence,
    });
  }
  if (!next.requiresSnapshot) {
    fail('requires-snapshot-downgrade', 'recovery rotation must require a client snapshot');
  }
  assertNondecreasingTimestamp(current, next, true, 'recovery rotation');
  if (primaryAfterRecovery.databaseUuid !== next.databaseUuid) {
    fail('primary-database-uuid-mismatch', 'recovered primary databaseUuid must match the fence');
  }
  if (primaryAfterRecovery.recoveryGeneration !== next.generation) {
    fail('primary-generation-mismatch', 'recovered primary generation must equal the new fence generation');
  }
  if (primaryAfterRecovery.writeSequence !== next.acknowledgedWriteSequence) {
    fail(
      'primary-write-sequence-mismatch',
      'recovery fence watermark must equal the recovered primary writeSequence',
      {
        primaryWriteSequence: primaryAfterRecovery.writeSequence,
        nextAcknowledgedWriteSequence: next.acknowledgedWriteSequence,
      },
    );
  }
  if (primaryAfterRecovery.writeSequence <= current.acknowledgedWriteSequence) {
    fail(
      'recovery-write-sequence-not-advanced',
      'recovered primary writeSequence must advance beyond the prior acknowledged watermark',
      {
        currentAcknowledgedWriteSequence: current.acknowledgedWriteSequence,
        primaryWriteSequence: primaryAfterRecovery.writeSequence,
      },
    );
  }
  return next;
}

function normalizeProjectDatabasePrimaryIdentity32(value) {
  assertExactOrdinaryObject(
    value,
    PROJECT_DATABASE_PRIMARY_IDENTITY_FIELDS_32,
    'schema32 primary identity',
  );
  return Object.freeze({
    databaseUuid: normalizeUuid(value.databaseUuid, 'databaseUuid'),
    recoveryGeneration: normalizeUuid(value.recoveryGeneration, 'recoveryGeneration'),
    writeSequence: normalizeSafeInteger(value.writeSequence, 'writeSequence', 0),
  });
}

function classifyProjectDatabasePrimaryAgainstFreshnessFence32(primaryValue, fenceValue) {
  const primary = normalizeProjectDatabasePrimaryIdentity32(primaryValue);
  const fence = normalizeProjectDatabaseFreshnessFence32(fenceValue);
  const matchesDatabaseUuid = primary.databaseUuid === fence.databaseUuid;
  const matchesGeneration = primary.recoveryGeneration === fence.generation;
  const sequenceRelation = !matchesDatabaseUuid || !matchesGeneration
    ? 'not-comparable'
    : primary.writeSequence < fence.acknowledgedWriteSequence
      ? 'behind'
      : primary.writeSequence > fence.acknowledgedWriteSequence ? 'ahead' : 'equal';
  let classification;
  if (!matchesDatabaseUuid) classification = 'database-uuid-mismatch';
  else if (!matchesGeneration && primary.recoveryGeneration === fence.previousGeneration) {
    classification = 'primary-previous-generation';
  } else if (!matchesGeneration) classification = 'generation-mismatch';
  else if (sequenceRelation === 'behind') classification = 'primary-behind-acknowledged-watermark';
  else if (sequenceRelation === 'ahead') classification = 'primary-ahead-of-acknowledged-watermark';
  else classification = 'primary-at-acknowledged-watermark';
  const authoritativePrimary = matchesDatabaseUuid
    && matchesGeneration
    && sequenceRelation !== 'behind';
  return Object.freeze({
    classification,
    databasePrimaryAuthoritative: authoritativePrimary,
    clientSnapshotRequired: fence.requiresSnapshot,
    failClosed: !authoritativePrimary,
    explicitDatabaseRecoveryRequired: !authoritativePrimary,
    matchesDatabaseUuid,
    matchesGeneration,
    sequenceRelation,
    primaryWriteSequence: primary.writeSequence,
    acknowledgedWriteSequence: fence.acknowledgedWriteSequence,
  });
}

function normalizeProjectDatabaseCanonicalReceiptEvidence32(value) {
  assertExactOrdinaryObject(
    value,
    PROJECT_DATABASE_CANONICAL_RECEIPT_EVIDENCE_FIELDS_32,
    'schema32 canonical receipt evidence',
  );
  return Object.freeze({
    receiptUuid: normalizeUuid(value.receiptUuid, 'receiptUuid'),
    databaseUuid: normalizeUuid(value.databaseUuid, 'databaseUuid'),
    recoveryGeneration: normalizeUuid(value.recoveryGeneration, 'recoveryGeneration'),
    capturedWriteSequence: normalizeSafeInteger(
      value.capturedWriteSequence,
      'capturedWriteSequence',
      0,
    ),
    identityDigest: normalizeSha256(value.identityDigest, 'identityDigest'),
    migrationReceiptDigest: normalizeSha256(
      value.migrationReceiptDigest,
      'migrationReceiptDigest',
    ),
    logicalContentDigest: normalizeSha256(value.logicalContentDigest, 'logicalContentDigest'),
    schemaFingerprint: normalizeSha256(value.schemaFingerprint, 'schemaFingerprint'),
  });
}

function projectDatabaseCanonicalReceiptEvidenceDigest32(value) {
  const receipt = normalizeProjectDatabaseCanonicalReceiptEvidence32(value);
  return createHash('sha256')
    .update('t8-project-database-canonical-receipt-freshness-evidence-v1\u0000', 'utf8')
    .update(JSON.stringify(receipt), 'utf8')
    .digest('hex');
}

function normalizeProjectDatabaseCanonicalReceiptVerifications32(value) {
  assertExactOrdinaryObject(
    value,
    PROJECT_DATABASE_CANONICAL_RECEIPT_VERIFICATION_FIELDS_32,
    'schema32 canonical receipt verifications',
  );
  const normalized = {};
  for (const field of PROJECT_DATABASE_CANONICAL_RECEIPT_VERIFICATION_FIELDS_32) {
    if (field === 'receiptEvidenceDigest') {
      normalized[field] = normalizeSha256(value[field], field);
      continue;
    }
    if (typeof value[field] !== 'boolean') {
      fail('verification-invalid', `${field} verification must be a boolean`, { field });
    }
    normalized[field] = value[field];
  }
  return Object.freeze(normalized);
}

function canonicalReceiptFreshnessResult(status, reasons, values = {}) {
  const fresh = status === 'fresh';
  return Object.freeze({
    status,
    fresh,
    automaticRecoveryAllowed: false,
    standaloneUnwired: true,
    failClosed: !fresh,
    reasons: Object.freeze([...reasons]),
    receiptCapturedWriteSequence: values.receiptCapturedWriteSequence ?? null,
    acknowledgedWriteSequence: values.acknowledgedWriteSequence ?? null,
  });
}

function classifyProjectDatabaseCanonicalReceiptFreshness32(
  fenceValue,
  receiptValue,
  verificationValue,
) {
  let fence;
  let receipt;
  let verifications;
  try {
    fence = normalizeProjectDatabaseFreshnessFence32(fenceValue);
    receipt = normalizeProjectDatabaseCanonicalReceiptEvidence32(receiptValue);
    verifications = normalizeProjectDatabaseCanonicalReceiptVerifications32(verificationValue);
  } catch (error) {
    return canonicalReceiptFreshnessResult('invalid-evidence', [
      error instanceof ProjectDatabaseFreshnessFence32Error
        ? error.reason
        : 'unexpected-evidence-error',
    ]);
  }

  const reasons = [];
  if (receipt.databaseUuid !== fence.databaseUuid) reasons.push('database-uuid-mismatch');
  if (receipt.recoveryGeneration !== fence.generation) reasons.push('generation-mismatch');
  if (receipt.capturedWriteSequence < fence.acknowledgedWriteSequence) {
    reasons.push('captured-write-sequence-behind-acknowledged-watermark');
  }
  if (verifications.receiptEvidenceDigest
    !== projectDatabaseCanonicalReceiptEvidenceDigest32(receipt)) {
    reasons.push('receipt-evidence-binding-mismatch');
  }
  for (const field of PROJECT_DATABASE_CANONICAL_RECEIPT_VERIFICATION_FIELDS_32) {
    if (field === 'receiptEvidenceDigest') continue;
    if (verifications[field] !== true) reasons.push(`${field}-verification-failed`);
  }
  return canonicalReceiptFreshnessResult(
    reasons.length === 0 ? 'fresh' : 'rejected',
    reasons,
    {
      receiptCapturedWriteSequence: receipt.capturedWriteSequence,
      acknowledgedWriteSequence: fence.acknowledgedWriteSequence,
    },
  );
}

module.exports = Object.freeze({
  PROJECT_DATABASE_CANONICAL_RECEIPT_EVIDENCE_FIELDS_32,
  PROJECT_DATABASE_CANONICAL_RECEIPT_VERIFICATION_FIELDS_32,
  PROJECT_DATABASE_FRESHNESS_FENCE_32_CONTRACT,
  PROJECT_DATABASE_FRESHNESS_FENCE_32_CREATE_FIELDS,
  PROJECT_DATABASE_FRESHNESS_FENCE_32_FIELDS,
  PROJECT_DATABASE_FRESHNESS_FENCE_32_INTEGRATION_STATUS,
  PROJECT_DATABASE_FRESHNESS_FENCE_32_REASON_MAX_BYTES,
  PROJECT_DATABASE_FRESHNESS_FENCE_32_VERSION,
  PROJECT_DATABASE_PRIMARY_IDENTITY_FIELDS_32,
  ProjectDatabaseFreshnessFence32Error,
  advanceProjectDatabaseFreshnessFence32,
  classifyProjectDatabaseCanonicalReceiptFreshness32,
  classifyProjectDatabasePrimaryAgainstFreshnessFence32,
  createProjectDatabaseFreshnessFence32,
  normalizeProjectDatabaseCanonicalReceiptEvidence32,
  normalizeProjectDatabaseCanonicalReceiptVerifications32,
  normalizeProjectDatabaseFreshnessFence32,
  normalizeProjectDatabasePrimaryIdentity32,
  projectDatabaseCanonicalReceiptEvidenceDigest32,
  rotateProjectDatabaseFreshnessFenceAfterRecovery32,
});
