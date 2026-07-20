const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PROJECT_DATABASE_CANONICAL_RECEIPT_VERIFICATION_FIELDS_32,
  PROJECT_DATABASE_FRESHNESS_FENCE_32_CONTRACT,
  PROJECT_DATABASE_FRESHNESS_FENCE_32_FIELDS,
  PROJECT_DATABASE_FRESHNESS_FENCE_32_INTEGRATION_STATUS,
  ProjectDatabaseFreshnessFence32Error,
  advanceProjectDatabaseFreshnessFence32,
  classifyProjectDatabaseCanonicalReceiptFreshness32,
  classifyProjectDatabasePrimaryAgainstFreshnessFence32,
  createProjectDatabaseFreshnessFence32,
  normalizeProjectDatabaseFreshnessFence32,
  projectDatabaseCanonicalReceiptEvidenceDigest32,
  rotateProjectDatabaseFreshnessFenceAfterRecovery32,
} = require('../backend/src/services/projectDatabaseFreshnessFence32');

const DATABASE_UUID = '11111111-1111-4111-8111-111111111111';
const GENERATION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GENERATION_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RECEIPT_UUID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const RECEIPT_UUID_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const IDENTITY_DIGEST = '1'.repeat(64);
const MIGRATION_RECEIPT_DIGEST = '2'.repeat(64);
const LOGICAL_CONTENT_DIGEST = '3'.repeat(64);
const SCHEMA_FINGERPRINT = '4'.repeat(64);

function createFence(overrides = {}) {
  return createProjectDatabaseFreshnessFence32({
    databaseUuid: DATABASE_UUID,
    generation: GENERATION_A,
    previousGeneration: null,
    acknowledgedWriteSequence: 7,
    reason: 'initialize',
    requiresSnapshot: false,
    updatedAt: 1000,
    ...overrides,
  });
}

function receipt(overrides = {}) {
  return {
    receiptUuid: RECEIPT_UUID,
    databaseUuid: DATABASE_UUID,
    recoveryGeneration: GENERATION_A,
    capturedWriteSequence: 7,
    identityDigest: IDENTITY_DIGEST,
    migrationReceiptDigest: MIGRATION_RECEIPT_DIGEST,
    logicalContentDigest: LOGICAL_CONTENT_DIGEST,
    schemaFingerprint: SCHEMA_FINGERPRINT,
    ...overrides,
  };
}

function verifications(overrides = {}, receiptValue = receipt()) {
  return Object.fromEntries(PROJECT_DATABASE_CANONICAL_RECEIPT_VERIFICATION_FIELDS_32
    .map((field) => {
      if (Object.hasOwn(overrides, field)) return [field, overrides[field]];
      if (field === 'receiptEvidenceDigest') {
        return [field, projectDatabaseCanonicalReceiptEvidenceDigest32(receiptValue)];
      }
      return [field, true];
    }));
}

function cleanupTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.equal(`${resolved}${path.sep}`.startsWith(temporaryRoot), true);
  fs.rmSync(resolved, { recursive: true, force: true });
}

test('B2 schema32 v3 fence is exact, canonical and TEMP JSON round-trip safe', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-schema32-freshness-fence-'));
  try {
    const fence = createFence({
      databaseUuid: DATABASE_UUID.toUpperCase(),
      generation: GENERATION_A.toUpperCase(),
    });
    assert.deepEqual(Object.keys(fence), PROJECT_DATABASE_FRESHNESS_FENCE_32_FIELDS);
    assert.equal(fence.version, 3);
    assert.equal(fence.databaseUuid, DATABASE_UUID);
    assert.equal(fence.generation, GENERATION_A);
    assert.equal(Object.isFrozen(fence), true);
    assert.equal(PROJECT_DATABASE_FRESHNESS_FENCE_32_INTEGRATION_STATUS, 'standalone-unwired');
    assert.equal(PROJECT_DATABASE_FRESHNESS_FENCE_32_CONTRACT.persistenceStatus,
      'caller-owned-no-filesystem-writes');

    const filename = path.join(directory, 'recovery-generation-v3.json');
    fs.writeFileSync(filename, `${JSON.stringify(fence)}\n`, { encoding: 'utf8', flag: 'wx' });
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.deepEqual(normalizeProjectDatabaseFreshnessFence32(parsed), fence);
  } finally {
    cleanupTemporaryDirectory(directory);
  }
});

test('B2 schema32 v3 fence rejects non-ordinary, inexact and malformed state', () => {
  const valid = createFence();
  const invalid = (value, reason) => assert.throws(
    () => normalizeProjectDatabaseFreshnessFence32(value),
    (error) => error instanceof ProjectDatabaseFreshnessFence32Error
      && error.code === 'project_database_freshness_fence_32_invalid'
      && error.reason === reason,
  );
  invalid(null, 'ordinary-object-required');
  invalid([], 'ordinary-object-required');
  invalid(Object.assign(Object.create(null), valid), 'ordinary-object-required');
  invalid({ ...valid, extra: true }, 'field-set-invalid');
  const { reason: _removed, ...missingReason } = valid;
  invalid(missingReason, 'field-set-invalid');
  const getter = { ...valid };
  Object.defineProperty(getter, 'reason', { enumerable: true, get() { return 'initialize'; } });
  invalid(getter, 'ordinary-object-required');
  invalid({ ...valid, version: 2 }, 'version-invalid');
  invalid({ ...valid, databaseUuid: 'not-a-uuid' }, 'uuid-invalid');
  invalid({ ...valid, previousGeneration: valid.generation }, 'generation-cycle');
  invalid({ ...valid, acknowledgedWriteSequence: -1 }, 'safe-integer-invalid');
  invalid({ ...valid, acknowledgedWriteSequence: '7' }, 'safe-integer-invalid');
  invalid({ ...valid, acknowledgedWriteSequence: Number.MAX_SAFE_INTEGER + 1 }, 'safe-integer-invalid');
  invalid({ ...valid, reason: ' padded ' }, 'reason-invalid');
  invalid({ ...valid, reason: 'bad\nreason' }, 'reason-invalid');
  invalid({ ...valid, reason: '界'.repeat(41) }, 'reason-invalid');
  invalid({ ...valid, requiresSnapshot: 'false' }, 'requires-snapshot-invalid');
  invalid({
    ...valid,
    previousGeneration: GENERATION_B,
    requiresSnapshot: false,
  }, 'requires-snapshot-downgrade');
  invalid({ ...valid, updatedAt: 0 }, 'safe-integer-invalid');
});

test('B2 schema32 acknowledged watermark only advances within the exact UUID and generation', () => {
  const current = createFence({ requiresSnapshot: true, reason: 'sidecar-repair' });
  const next = createFence({
    acknowledgedWriteSequence: 12,
    requiresSnapshot: true,
    reason: 'canonical-backup-acknowledged',
    updatedAt: 1001,
  });
  const primary = {
    databaseUuid: DATABASE_UUID,
    recoveryGeneration: GENERATION_A,
    writeSequence: 12,
  };
  assert.deepEqual(advanceProjectDatabaseFreshnessFence32(current, next, primary), next);
  assert.deepEqual(advanceProjectDatabaseFreshnessFence32(current, current, {
    ...primary,
    writeSequence: 7,
  }), current);

  const rejected = (patch, reason) => assert.throws(
    () => advanceProjectDatabaseFreshnessFence32(current, { ...next, ...patch }, primary),
    (error) => error instanceof ProjectDatabaseFreshnessFence32Error
      && error.reason === reason,
  );
  rejected({ databaseUuid: '22222222-2222-4222-8222-222222222222' }, 'database-uuid-transition');
  rejected({ generation: GENERATION_B }, 'generation-transition');
  rejected({ previousGeneration: GENERATION_C }, 'previous-generation-transition');
  rejected({ acknowledgedWriteSequence: 6 }, 'acknowledged-write-sequence-regression');
  rejected({ requiresSnapshot: false, reason: 'initialize' }, 'requires-snapshot-downgrade');
  rejected({ updatedAt: 999 }, 'updated-at-regression');
  rejected({ updatedAt: 1000 }, 'updated-at-regression');

  const primaryRejected = (primaryPatch, reason) => assert.throws(
    () => advanceProjectDatabaseFreshnessFence32(current, next, {
      ...primary,
      ...primaryPatch,
    }),
    (error) => error instanceof ProjectDatabaseFreshnessFence32Error
      && error.reason === reason,
  );
  primaryRejected({ databaseUuid: '22222222-2222-4222-8222-222222222222' },
    'primary-database-uuid-mismatch');
  primaryRejected({ recoveryGeneration: GENERATION_B }, 'primary-generation-mismatch');
  primaryRejected({ writeSequence: 11 }, 'primary-write-sequence-mismatch');
  assert.throws(
    () => advanceProjectDatabaseFreshnessFence32(current, next),
    (error) => error instanceof ProjectDatabaseFreshnessFence32Error
      && error.reason === 'ordinary-object-required',
  );
});

test('B2 schema32 recovery rotation binds the exact previous generation without sequence regression', () => {
  const current = createFence({
    acknowledgedWriteSequence: 41,
    requiresSnapshot: true,
    reason: 'sidecar-repair',
  });
  const rotated = createFence({
    generation: GENERATION_B,
    previousGeneration: GENERATION_A,
    acknowledgedWriteSequence: 42,
    reason: 'database-recovery',
    requiresSnapshot: true,
    updatedAt: 1001,
  });
  const recoveredPrimary = {
    databaseUuid: DATABASE_UUID,
    recoveryGeneration: GENERATION_B,
    writeSequence: 42,
  };
  assert.deepEqual(
    rotateProjectDatabaseFreshnessFenceAfterRecovery32(current, rotated, recoveredPrimary),
    rotated,
  );

  const rejected = (patch, reason) => assert.throws(
    () => rotateProjectDatabaseFreshnessFenceAfterRecovery32(
      current,
      { ...rotated, ...patch },
      recoveredPrimary,
    ),
    (error) => error instanceof ProjectDatabaseFreshnessFence32Error
      && error.reason === reason,
  );
  rejected({ databaseUuid: '22222222-2222-4222-8222-222222222222' }, 'database-uuid-transition');
  rejected({ generation: GENERATION_A }, 'generation-cycle');
  rejected({ previousGeneration: GENERATION_C }, 'previous-generation-transition');
  rejected({ acknowledgedWriteSequence: 40 }, 'acknowledged-write-sequence-regression');
  rejected({ previousGeneration: null }, 'previous-generation-transition');
  rejected({ requiresSnapshot: false }, 'requires-snapshot-downgrade');
  rejected({ updatedAt: 1000 }, 'updated-at-regression');

  const primaryRejected = (primaryPatch, reason, rotatedPatch = {}) => assert.throws(
    () => rotateProjectDatabaseFreshnessFenceAfterRecovery32(
      current,
      { ...rotated, ...rotatedPatch },
      { ...recoveredPrimary, ...primaryPatch },
    ),
    (error) => error instanceof ProjectDatabaseFreshnessFence32Error
      && error.reason === reason,
  );
  primaryRejected({ databaseUuid: '22222222-2222-4222-8222-222222222222' },
    'primary-database-uuid-mismatch');
  primaryRejected({ recoveryGeneration: GENERATION_C }, 'primary-generation-mismatch');
  primaryRejected({ writeSequence: 43 }, 'primary-write-sequence-mismatch');
  primaryRejected(
    { writeSequence: 41 },
    'recovery-write-sequence-not-advanced',
    { acknowledgedWriteSequence: 41 },
  );
  assert.throws(
    () => rotateProjectDatabaseFreshnessFenceAfterRecovery32(current, rotated),
    (error) => error instanceof ProjectDatabaseFreshnessFence32Error
      && error.reason === 'ordinary-object-required',
  );
});

test('B2 schema32 primary/fence classification distinguishes identity, generation and watermark', () => {
  const fence = createFence({
    previousGeneration: GENERATION_B,
    requiresSnapshot: true,
    reason: 'database-recovery',
  });
  const classify = (overrides = {}) => classifyProjectDatabasePrimaryAgainstFreshnessFence32({
    databaseUuid: DATABASE_UUID,
    recoveryGeneration: GENERATION_A,
    writeSequence: 7,
    ...overrides,
  }, fence);
  assert.deepEqual(classify(), {
    classification: 'primary-at-acknowledged-watermark',
    databasePrimaryAuthoritative: true,
    clientSnapshotRequired: true,
    failClosed: false,
    explicitDatabaseRecoveryRequired: false,
    matchesDatabaseUuid: true,
    matchesGeneration: true,
    sequenceRelation: 'equal',
    primaryWriteSequence: 7,
    acknowledgedWriteSequence: 7,
  });
  assert.equal(classify({ writeSequence: 8 }).classification,
    'primary-ahead-of-acknowledged-watermark');
  const behind = classify({ writeSequence: 6 });
  assert.equal(behind.classification, 'primary-behind-acknowledged-watermark');
  assert.equal(behind.databasePrimaryAuthoritative, false);
  assert.equal(behind.clientSnapshotRequired, true);
  assert.equal(behind.failClosed, true);
  assert.equal(behind.explicitDatabaseRecoveryRequired, true);
  assert.equal(classify({ recoveryGeneration: GENERATION_B }).classification,
    'primary-previous-generation');
  assert.equal(classify({ recoveryGeneration: GENERATION_C }).classification, 'generation-mismatch');
  assert.equal(classify({ databaseUuid: '22222222-2222-4222-8222-222222222222' }).classification,
    'database-uuid-mismatch');
  assert.throws(
    () => classifyProjectDatabasePrimaryAgainstFreshnessFence32({
      databaseUuid: DATABASE_UUID,
      recoveryGeneration: GENERATION_A,
      writeSequence: 7,
      extra: true,
    }, fence),
    (error) => error instanceof ProjectDatabaseFreshnessFence32Error
      && error.reason === 'field-set-invalid',
  );
});

test('B2 schema32 canonical receipt freshness requires identity, watermark and every witness', () => {
  const fence = createFence();
  const currentReceipt = receipt({ capturedWriteSequence: 9 });
  const fresh = classifyProjectDatabaseCanonicalReceiptFreshness32(
    fence,
    currentReceipt,
    verifications({}, currentReceipt),
  );
  assert.deepEqual(fresh, {
    status: 'fresh',
    fresh: true,
    automaticRecoveryAllowed: false,
    standaloneUnwired: true,
    failClosed: false,
    reasons: [],
    receiptCapturedWriteSequence: 9,
    acknowledgedWriteSequence: 7,
  });

  const rejected = [
    classifyProjectDatabaseCanonicalReceiptFreshness32(
      fence,
      receipt({ databaseUuid: '22222222-2222-4222-8222-222222222222' }),
      verifications(),
    ),
    classifyProjectDatabaseCanonicalReceiptFreshness32(
      fence,
      receipt({ recoveryGeneration: GENERATION_B }),
      verifications(),
    ),
    classifyProjectDatabaseCanonicalReceiptFreshness32(
      fence,
      receipt({ capturedWriteSequence: 6 }),
      verifications(),
    ),
  ];
  assert.deepEqual(rejected.map((result) => result.reasons[0]), [
    'database-uuid-mismatch',
    'generation-mismatch',
    'captured-write-sequence-behind-acknowledged-watermark',
  ]);
  for (const result of rejected) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.fresh, false);
    assert.equal(result.automaticRecoveryAllowed, false);
    assert.equal(result.standaloneUnwired, true);
    assert.equal(result.failClosed, true);
  }

  for (const field of PROJECT_DATABASE_CANONICAL_RECEIPT_VERIFICATION_FIELDS_32) {
    if (field === 'receiptEvidenceDigest') continue;
    const result = classifyProjectDatabaseCanonicalReceiptFreshness32(
      fence,
      receipt(),
      verifications({ [field]: false }),
    );
    assert.equal(result.fresh, false, field);
    assert.deepEqual(result.reasons, [`${field}-verification-failed`]);
  }

  const receiptB = receipt({ receiptUuid: RECEIPT_UUID_B });
  const splicedWitnesses = classifyProjectDatabaseCanonicalReceiptFreshness32(
    fence,
    receiptB,
    verifications({}, receipt()),
  );
  assert.equal(splicedWitnesses.fresh, false);
  assert.deepEqual(splicedWitnesses.reasons, ['receipt-evidence-binding-mismatch']);
});

test('B2 schema32 malformed receipt evidence also fails closed and never claims freshness', () => {
  const fence = createFence();
  const cases = [
    [null, receipt(), verifications()],
    [fence, { ...receipt(), extra: true }, verifications()],
    [fence, receipt(), { ...verifications(), extra: true }],
    [fence, receipt(), verifications({ schema: 'true' })],
  ];
  for (const args of cases) {
    const result = classifyProjectDatabaseCanonicalReceiptFreshness32(...args);
    assert.equal(result.status, 'invalid-evidence');
    assert.equal(result.fresh, false);
    assert.equal(result.automaticRecoveryAllowed, false);
    assert.equal(result.standaloneUnwired, true);
    assert.equal(result.failClosed, true);
    assert.equal(result.reasons.length, 1);
  }
});
