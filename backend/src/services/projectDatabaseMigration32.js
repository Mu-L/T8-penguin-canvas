const { createHash } = require('node:crypto');

const VERSION = 32;
const FROM_VERSION = 31;
const NAME = 'physical-capacity-and-canonical-backup-contract';
const DOWN_POLICY = 'backup-only';
const CHECKSUM_CANONICALIZATION = 't8-project-database-migration-v2';
const MAX_SAFE_INTEGER = 9007199254740991;

const INTEGRATION_STATUS = 'production-wired';
const FRESHNESS_CLAIM =
  'canonical-backup-receipts-and-write-sequence-freshness-enforced-fail-closed';

const SCHEMA_31_MIGRATION_CHECKSUM =
  '33922f67c1f2d5126728f4cd74db10c2e1f381b37685935564031e85d898f444';
const SCHEMA_31_EXTENSION_FINGERPRINT =
  '2ac8af2dfa9ec92cdf1f2a978dc9a924ad147efbb8ad2fa749df6b522628e658';

function canonicalJson(value) {
  const active = new WeakSet();
  const encode = (current) => {
    if (current === null || typeof current === 'boolean' || typeof current === 'string') {
      return JSON.stringify(current);
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('canonical JSON rejects non-finite numbers');
      return JSON.stringify(current);
    }
    if (typeof current !== 'object') {
      throw new TypeError(`canonical JSON rejects ${typeof current}`);
    }
    if (active.has(current)) throw new TypeError('canonical JSON rejects cyclic values');
    active.add(current);
    try {
      if (Reflect.ownKeys(current).some((key) => typeof key === 'symbol')) {
        throw new TypeError('canonical JSON rejects symbol keys');
      }
      if (Array.isArray(current)) {
        const entries = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.hasOwn(current, index)) throw new TypeError('canonical JSON rejects sparse arrays');
          entries.push(encode(current[index]));
        }
        return `[${entries.join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('canonical JSON rejects non-plain objects');
      }
      return `{${Object.keys(current).sort().map((key) => (
        `${JSON.stringify(key)}:${encode(current[key])}`
      )).join(',')}}`;
    } finally {
      active.delete(current);
    }
  };
  return encode(value);
}

function canonicalSha256(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

// These are the ten exact schema-31 fingerprints accepted by the current
// schema-31 lineage map. The target map is frozen separately from the digest
// seed embedded in schema DDL so a target fingerprint never hashes itself.
const ACCEPTED_SCHEMA_31_FINGERPRINTS = Object.freeze([
  '4280e3554a8291a8292fe06c48ca2538349ac44e416d57755cddbee5a208f2d3',
  '5c9f3300794458131265551331b9cce9b7b1eaf7dd6f3bd00e12c83ad1e6f29e',
  '632f46888c88c6fb572404984b6125ca218c3a9ca734e6730eb96be6b001466d',
  '7d36855db4254c3190060bbd4247cd8b1a1bb1902d2c2c7941918c4dc3ea44a6',
  '7e926272b0d4cbd120d8e1c49bea496392fb24fd858205b15afddc49bedf5f71',
  'a7322cdf1a82412cf35acbdb9b4ba03815eaf0f4f51068faf2781c7212315858',
  'ad31dd3d75c7317a7cd43a2f89c0f0ed77c21bfd2fb9926cbcb4f1638969313d',
  'bd34241e06f5aca3cde5c5055587cdd78ce618d9d33d26754bc7d9555ffa0c5d',
  'd74d841fe60332a51968e90b24636ef6f0efc524a2309924a3de4082eecef91d',
  'd930bf64a047d0e7246c3ab1ad1630958656303f708f489f0c71e2ba37aabf8a',
]);

const SCHEMA_32_EXTENSION_FINGERPRINT =
  'bae4f62ab94effb8bafe3027c7bd037ab51e7c13f28bbdda5dcf80f8dce85276';

// These nine vectors have independent source-only/TEMP reproduction. The
// tenth accepted source is intentionally derived from its complete v31
// descriptor plus the exact schema32-owned extension descriptor below; no
// wildcard or retained-database observation participates in production.
const SCHEMA_32_FINGERPRINT_MAPPINGS = Object.freeze([
  Object.freeze({
    fromFingerprint: '4280e3554a8291a8292fe06c48ca2538349ac44e416d57755cddbee5a208f2d3',
    toFingerprint: '1a96058cf4f2be5a1f50aacefaa6db568b744f736f04f099922831197b238cc3',
  }),
  Object.freeze({
    fromFingerprint: '5c9f3300794458131265551331b9cce9b7b1eaf7dd6f3bd00e12c83ad1e6f29e',
    toFingerprint: 'd7b7ce892af6d7fd7a28c175912c3e77485b33fa05b93d02d4c7f1e34dd219ec',
  }),
  Object.freeze({
    fromFingerprint: '632f46888c88c6fb572404984b6125ca218c3a9ca734e6730eb96be6b001466d',
    toFingerprint: '2f8d6ea2d730680d99ab32800aabb0ec4aabbe86509443e70f68ac2ac501248b',
  }),
  Object.freeze({
    fromFingerprint: '7d36855db4254c3190060bbd4247cd8b1a1bb1902d2c2c7941918c4dc3ea44a6',
    toFingerprint: 'a8501c5d2ecc5c884326c34b52af0c06140daff9ab83fdb12fcc3f7d5695e4b9',
  }),
  Object.freeze({
    fromFingerprint: '7e926272b0d4cbd120d8e1c49bea496392fb24fd858205b15afddc49bedf5f71',
    toFingerprint: '008d4858e684f0defff378054557ba8cf1465743fcee4322bfb2802fe2d8de23',
  }),
  Object.freeze({
    fromFingerprint: 'a7322cdf1a82412cf35acbdb9b4ba03815eaf0f4f51068faf2781c7212315858',
    toFingerprint: '0d2e8bd0fc2ff308c8ec2a02ecc1098ef6510af81c8bf0042a0a3dacbc7ca873',
  }),
  Object.freeze({
    fromFingerprint: 'bd34241e06f5aca3cde5c5055587cdd78ce618d9d33d26754bc7d9555ffa0c5d',
    toFingerprint: '8beea0ab7330440639bbc5759aa43e10b8e2e74039e3eff484aaa9eadb7dafa3',
  }),
  Object.freeze({
    fromFingerprint: 'd74d841fe60332a51968e90b24636ef6f0efc524a2309924a3de4082eecef91d',
    toFingerprint: 'a69b7f2bf1c60b0949e3840b5609b1e894903f77feec3101cfaf3587d5fbf74e',
  }),
  Object.freeze({
    fromFingerprint: 'd930bf64a047d0e7246c3ab1ad1630958656303f708f489f0c71e2ba37aabf8a',
    toFingerprint: '3b072d4c4a23e98453f7a5657f46bc68388c08f0dd85fe3c78f9f94602cdbb49',
  }),
]);

function schema32CompositionError(message, details = {}) {
  const error = new TypeError(message);
  error.code = 'project_database_schema32_composition_invalid';
  error.details = Object.freeze({ ...details });
  return error;
}

function deepFreezeSchema32Value(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreezeSchema32Value);
  return Object.freeze(value);
}

function validateSchema32Manifest(value, label, expectedVersion) {
  const descriptor = value?.descriptor;
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw schema32CompositionError(`${label} manifest 缺少完整 descriptor`);
  }
  if (Number(descriptor.version) !== expectedVersion) {
    throw schema32CompositionError(`${label} descriptor version 不匹配`, {
      expectedVersion,
      actualVersion: descriptor.version,
    });
  }
  const arrays = ['tables', 'triggers', 'views'];
  for (const key of arrays) {
    if (!Array.isArray(descriptor[key])) {
      throw schema32CompositionError(`${label} descriptor.${key} 必须是数组`);
    }
  }
  const counts = descriptor.counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    throw schema32CompositionError(`${label} descriptor 缺少 counts`);
  }
  const explicitIndexNames = descriptor.tables.flatMap((table) => {
    if (!table || typeof table !== 'object' || !Array.isArray(table.indexes)) {
      throw schema32CompositionError(`${label} table descriptor 缺少 indexes`);
    }
    return table.indexes
      .filter((index) => index?.name != null)
      .map((index) => String(index.name));
  });
  const expectedCounts = {
    tables: descriptor.tables.length,
    indexes: explicitIndexNames.length,
    triggers: descriptor.triggers.length,
    views: descriptor.views.length,
  };
  for (const [key, expected] of Object.entries(expectedCounts)) {
    if (!Number.isSafeInteger(Number(counts[key])) || Number(counts[key]) !== expected) {
      throw schema32CompositionError(`${label} descriptor counts.${key} 不一致`, {
        expected,
        actual: counts[key],
      });
    }
    if (value.counts != null && Number(value.counts[key]) !== expected) {
      throw schema32CompositionError(`${label} manifest counts.${key} 不一致`, {
        expected,
        actual: value.counts[key],
      });
    }
  }
  const objectNames = [
    ...descriptor.tables.map((entry) => String(entry?.name || '')),
    ...explicitIndexNames,
    ...descriptor.triggers.map((entry) => String(entry?.name || '')),
    ...descriptor.views.map((entry) => String(entry?.name || '')),
  ];
  if (objectNames.some((name) => !name) || new Set(objectNames).size !== objectNames.length) {
    throw schema32CompositionError(`${label} descriptor 对象名缺失或冲突`);
  }
  const fingerprint = canonicalSha256(descriptor);
  if (String(value.fingerprint || '').toLowerCase() !== fingerprint) {
    throw schema32CompositionError(`${label} manifest fingerprint 与 descriptor 不一致`, {
      expectedFingerprint: fingerprint,
      actualFingerprint: value.fingerprint || null,
    });
  }
  return Object.freeze({ descriptor, fingerprint, objectNames, counts: expectedCounts });
}

function rawSchema32DescriptorObjectNames(value) {
  const descriptor = value?.descriptor;
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return [];
  const tables = Array.isArray(descriptor.tables) ? descriptor.tables : [];
  const triggers = Array.isArray(descriptor.triggers) ? descriptor.triggers : [];
  const views = Array.isArray(descriptor.views) ? descriptor.views : [];
  return [
    ...tables.map((entry) => String(entry?.name || '')).filter(Boolean),
    ...tables.flatMap((table) => (
      Array.isArray(table?.indexes)
        ? table.indexes.filter((index) => index?.name != null).map((index) => String(index.name))
        : []
    )),
    ...triggers.map((entry) => String(entry?.name || '')).filter(Boolean),
    ...views.map((entry) => String(entry?.name || '')).filter(Boolean),
  ];
}

function composeProjectDatabaseSchema32TargetManifest(sourceManifest, extensionManifest) {
  const rawSourceNames = new Set(rawSchema32DescriptorObjectNames(sourceManifest));
  const rawCollisions = rawSchema32DescriptorObjectNames(extensionManifest)
    .filter((name) => rawSourceNames.has(name));
  if (rawCollisions.length > 0) {
    throw schema32CompositionError('schema31 source 与 schema32 extension 对象名冲突', {
      collisionCount: rawCollisions.length,
      collisionDigest: canonicalSha256([...new Set(rawCollisions)].sort()),
    });
  }
  const source = validateSchema32Manifest(sourceManifest, 'schema31 source', FROM_VERSION);
  const extension = validateSchema32Manifest(extensionManifest, 'schema32 extension', VERSION);
  if (!ACCEPTED_SCHEMA_31_FINGERPRINTS.includes(source.fingerprint)) {
    throw schema32CompositionError('schema31 source fingerprint 不在精确白名单', {
      sourceFingerprint: source.fingerprint,
    });
  }
  if (extension.fingerprint !== SCHEMA_32_EXTENSION_FINGERPRINT) {
    throw schema32CompositionError('schema32 extension fingerprint 不匹配', {
      expectedFingerprint: SCHEMA_32_EXTENSION_FINGERPRINT,
      actualFingerprint: extension.fingerprint,
    });
  }
  const expectedOwnedNames = [...ownedObjectNames].sort();
  const actualOwnedNames = [...extension.objectNames].sort();
  if (canonicalJson(actualOwnedNames) !== canonicalJson(expectedOwnedNames)) {
    throw schema32CompositionError('schema32 extension owned-object partition 不精确', {
      expectedCount: expectedOwnedNames.length,
      actualCount: actualOwnedNames.length,
    });
  }
  const sourceNames = new Set(source.objectNames);
  const collisions = expectedOwnedNames.filter((name) => sourceNames.has(name));
  if (collisions.length > 0) {
    throw schema32CompositionError('schema31 source 与 schema32 extension 对象名冲突', {
      collisionCount: collisions.length,
      collisionDigest: canonicalSha256(collisions),
    });
  }
  const clone = (value) => JSON.parse(canonicalJson(value));
  const descriptor = {
    version: VERSION,
    counts: {
      tables: source.counts.tables + extension.counts.tables,
      indexes: source.counts.indexes + extension.counts.indexes,
      triggers: source.counts.triggers + extension.counts.triggers,
      views: source.counts.views + extension.counts.views,
    },
    tables: [...clone(source.descriptor.tables), ...clone(extension.descriptor.tables)]
      .sort((left, right) => left.name.localeCompare(right.name)),
    triggers: [...clone(source.descriptor.triggers), ...clone(extension.descriptor.triggers)]
      .sort((left, right) => left.name.localeCompare(right.name)),
    views: [...clone(source.descriptor.views), ...clone(extension.descriptor.views)]
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  const fingerprint = canonicalSha256(descriptor);
  const known = SCHEMA_32_FINGERPRINT_MAPPINGS.find(
    (entry) => entry.fromFingerprint === source.fingerprint,
  );
  if (known && known.toFingerprint !== fingerprint) {
    throw schema32CompositionError('schema32 descriptor 合成与冻结向量不一致', {
      sourceFingerprint: source.fingerprint,
      expectedFingerprint: known.toFingerprint,
      actualFingerprint: fingerprint,
    });
  }
  return deepFreezeSchema32Value({ descriptor, counts: descriptor.counts, fingerprint });
}

const SCHEMA_LINEAGE =
  't8-project-database:31-to-32:physical-capacity-canonical-backup-v1';
const SCHEMA_LINEAGE_DIGEST_SEED = Object.freeze({
  format: 't8-project-database-schema-lineage-seed-v1',
  fromVersion: FROM_VERSION,
  toVersion: VERSION,
  lineage: SCHEMA_LINEAGE,
  sourceMigrationChecksum: SCHEMA_31_MIGRATION_CHECKSUM,
  sourceExtensionFingerprint: SCHEMA_31_EXTENSION_FINGERPRINT,
  acceptedSourceFingerprints: ACCEPTED_SCHEMA_31_FINGERPRINTS,
  targetManifestAlgorithm: 't8-project-database-schema-manifest-v1',
  targetFingerprintRequirement:
    'exact-source-to-target-mapping-required-before-production-wiring',
});
const SCHEMA_LINEAGE_DIGEST = canonicalSha256(SCHEMA_LINEAGE_DIGEST_SEED);
const SCHEMA_LINEAGE_DESCRIPTOR = Object.freeze({
  format: 't8-project-database-schema-lineage-v2',
  embeddedLineageSeed: SCHEMA_LINEAGE_DIGEST_SEED,
  embeddedLineageDigest: SCHEMA_LINEAGE_DIGEST,
  exactMappingContract: Object.freeze({
    format: 't8-project-database-schema-fingerprint-map-v1',
    status: 'production-wired-descriptor-composed-exact',
    mappingCount: ACCEPTED_SCHEMA_31_FINGERPRINTS.length,
    knownVectorCount: SCHEMA_32_FINGERPRINT_MAPPINGS.length,
    targetDerivation:
      'exact-source-descriptor-plus-exact-owned-extension-descriptor-sha256',
    extensionFingerprint: SCHEMA_32_EXTENSION_FINGERPRINT,
    wildcardPolicy: 'forbidden',
    digestFeedbackPolicy:
      'target-mappings-are-excluded-from-the-embedded-lineage-digest',
  }),
});

const LOGICAL_CONTENT_DIGEST_SCOPE =
  'sqlite-logical-snapshot-excluding-schema32-backup-receipt-objects-v2';
const CANONICAL_JSON_CONTRACT = Object.freeze({
  format: 't8-canonical-json-utf8-v1',
  objectKeyOrder: 'ecmascript-utf16-code-unit-ascending-recursive',
  arrayOrder: 'preserved',
  whitespace: 'none',
  textEncoding: 'utf8',
  numberEncoding: 'ecmascript-json-finite-number-serialization',
  objectPolicy: 'plain-or-null-prototype-only',
  unsupportedValues:
    'reject-undefined-function-symbol-bigint-nonfinite-sparse-array-cycle-and-nonplain-object',
});
const LOGICAL_CONTENT_DIGEST_CONTRACT = Object.freeze({
  format: 't8-project-database-logical-content-digest-v2',
  algorithm: 'sha256',
  scope: LOGICAL_CONTENT_DIGEST_SCOPE,
  streamHeader: 't8-project-database-logical-content-digest-v2\0',
  lengthEncoding: 'unsigned-64-bit-big-endian',
  excludedObjectNames: Object.freeze([
    'project_database_backup_receipts',
    'project_database_canonical_backup_head',
  ]),
  tableOrder: 'main-table-name-utf8-buffer-compare-ascending',
  columnOrder: 'pragma-table-xinfo-cid-ascending-hidden-nonzero-excluded',
  rowOrder: Object.freeze({
    withPrimaryKey:
      'canonical-primary-key-tuple-buffer-compare-ascending-then-canonical-full-row-tuple-buffer-compare-ascending',
    withoutPrimaryKey:
      'canonical-full-row-tuple-buffer-compare-ascending',
    implicitRowidPolicy: 'never-read-or-order-by-rowid',
  }),
  frames: Object.freeze({
    table: Object.freeze({
      typeByte: 'T',
      bytes: 'ascii-T-plus-u64be-utf8-name-byte-length-plus-utf8-name',
    }),
    column: Object.freeze({
      typeByte: 'C',
      bytes: 'ascii-C-plus-u64be-utf8-name-byte-length-plus-utf8-name',
    }),
    row: Object.freeze({
      typeByte: 'R',
      bytes: 'ascii-R-plus-u64be-canonical-tuple-byte-length-plus-canonical-tuple',
    }),
    tableEnd: Object.freeze({
      typeByte: 'E',
      bytes: 'ascii-E-plus-u64be-row-count',
    }),
  }),
  valueEncoding: Object.freeze({
    framing: 'ascii-type-byte-plus-u64be-payload-byte-length-plus-payload',
    null: 'ascii-n-plus-u64be-zero',
    integer: 'ascii-i-plus-u64be-payload-length-plus-canonical-base10-ascii',
    real: 'ascii-r-plus-u64be-eight-plus-ieee754-binary64-big-endian',
    text: 'ascii-t-plus-u64be-utf8-byte-length-plus-utf8',
    blob: 'ascii-b-plus-u64be-raw-byte-length-plus-raw-bytes',
  }),
});

const acceptedSchema31FingerprintSql = ACCEPTED_SCHEMA_31_FINGERPRINTS
  .map((fingerprint) => `'${fingerprint}'`)
  .join(',\n      ');

const CREATE_SQL = String.raw`
CREATE TABLE project_database_storage_policy (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  policy_revision INTEGER NOT NULL
    CHECK (policy_revision BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  active_storage_budget_bytes INTEGER NOT NULL
    CHECK (active_storage_budget_bytes BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  main_max_bytes INTEGER NOT NULL
    CHECK (main_max_bytes BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  wal_checkpoint_target_bytes INTEGER NOT NULL
    CHECK (wal_checkpoint_target_bytes BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  maximum_single_transaction_wal_bytes INTEGER NOT NULL
    CHECK (maximum_single_transaction_wal_bytes BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  wal_pressure_bytes INTEGER NOT NULL
    CHECK (wal_pressure_bytes BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  wal_reserve_bytes INTEGER NOT NULL
    CHECK (wal_reserve_bytes BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  wal_residual_limit_bytes INTEGER NOT NULL
    CHECK (wal_residual_limit_bytes BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  shm_reserve_bytes INTEGER NOT NULL
    CHECK (shm_reserve_bytes BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  hot_journal_reserve_bytes INTEGER NOT NULL
    CHECK (hot_journal_reserve_bytes BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  sqlite_temp_reserve_bytes INTEGER NOT NULL
    CHECK (sqlite_temp_reserve_bytes BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  minimum_filesystem_free_bytes INTEGER NOT NULL
    CHECK (minimum_filesystem_free_bytes BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  backup_candidate_reserve_bytes INTEGER NOT NULL
    CHECK (backup_candidate_reserve_bytes BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  recovery_evidence_reserve_bytes INTEGER NOT NULL
    CHECK (recovery_evidence_reserve_bytes BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  synchronous_mode TEXT NOT NULL CHECK (synchronous_mode = 'FULL'),
  updated_at INTEGER NOT NULL
    CHECK (updated_at BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  CHECK (
    wal_residual_limit_bytes <= wal_checkpoint_target_bytes
    AND wal_checkpoint_target_bytes + maximum_single_transaction_wal_bytes
      < wal_pressure_bytes
    AND wal_pressure_bytes < wal_reserve_bytes
  ),
  CHECK (
    active_storage_budget_bytes =
      main_max_bytes
      + wal_reserve_bytes
      + shm_reserve_bytes
      + hot_journal_reserve_bytes
      + sqlite_temp_reserve_bytes
      + minimum_filesystem_free_bytes
  ),
  CHECK (
    backup_candidate_reserve_bytes >=
      main_max_bytes
      + wal_residual_limit_bytes
      + shm_reserve_bytes
      + hot_journal_reserve_bytes
  ),
  CHECK (
    active_storage_budget_bytes
      + backup_candidate_reserve_bytes
      + recovery_evidence_reserve_bytes
      <= ${MAX_SAFE_INTEGER}
  )
) STRICT;

CREATE TABLE project_database_identity (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  database_uuid TEXT NOT NULL CHECK (
    length(database_uuid) = 36
    AND lower(database_uuid) = database_uuid
    AND substr(database_uuid, 9, 1) = '-'
    AND substr(database_uuid, 14, 1) = '-'
    AND substr(database_uuid, 19, 1) = '-'
    AND substr(database_uuid, 24, 1) = '-'
    AND length(replace(database_uuid, '-', '')) = 32
    AND replace(database_uuid, '-', '') NOT GLOB '*[^0-9a-f]*'
    AND substr(database_uuid, 15, 1) GLOB '[1-8]'
    AND substr(database_uuid, 20, 1) GLOB '[89ab]'
  ),
  recovery_generation TEXT NOT NULL CHECK (
    length(recovery_generation) = 36
    AND lower(recovery_generation) = recovery_generation
    AND substr(recovery_generation, 9, 1) = '-'
    AND substr(recovery_generation, 14, 1) = '-'
    AND substr(recovery_generation, 19, 1) = '-'
    AND substr(recovery_generation, 24, 1) = '-'
    AND length(replace(recovery_generation, '-', '')) = 32
    AND replace(recovery_generation, '-', '') NOT GLOB '*[^0-9a-f]*'
    AND substr(recovery_generation, 15, 1) GLOB '[1-8]'
    AND substr(recovery_generation, 20, 1) GLOB '[89ab]'
  ),
  write_sequence INTEGER NOT NULL
    CHECK (write_sequence BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  schema_version INTEGER NOT NULL CHECK (schema_version = ${VERSION}),
  schema_lineage TEXT NOT NULL CHECK (schema_lineage = '${SCHEMA_LINEAGE}'),
  schema_lineage_digest TEXT NOT NULL CHECK (
    schema_lineage_digest = '${SCHEMA_LINEAGE_DIGEST}'
  ),
  created_at INTEGER NOT NULL
    CHECK (created_at BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  updated_at INTEGER NOT NULL
    CHECK (updated_at BETWEEN created_at AND ${MAX_SAFE_INTEGER})
) STRICT;

CREATE TABLE project_database_backup_receipts (
  receipt_uuid TEXT PRIMARY KEY NOT NULL CHECK (
    length(receipt_uuid) = 36
    AND lower(receipt_uuid) = receipt_uuid
    AND substr(receipt_uuid, 9, 1) = '-'
    AND substr(receipt_uuid, 14, 1) = '-'
    AND substr(receipt_uuid, 19, 1) = '-'
    AND substr(receipt_uuid, 24, 1) = '-'
    AND length(replace(receipt_uuid, '-', '')) = 32
    AND replace(receipt_uuid, '-', '') NOT GLOB '*[^0-9a-f]*'
    AND substr(receipt_uuid, 15, 1) GLOB '[1-8]'
    AND substr(receipt_uuid, 20, 1) GLOB '[89ab]'
  ),
  receipt_format_version INTEGER NOT NULL CHECK (receipt_format_version = 1),
  backup_kind TEXT NOT NULL CHECK (backup_kind = 'canonical'),
  database_uuid TEXT NOT NULL,
  recovery_generation TEXT NOT NULL,
  captured_write_sequence INTEGER NOT NULL
    CHECK (captured_write_sequence BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  storage_policy_revision INTEGER NOT NULL
    CHECK (storage_policy_revision BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  schema_version INTEGER NOT NULL CHECK (schema_version = ${VERSION}),
  schema_lineage TEXT NOT NULL CHECK (schema_lineage = '${SCHEMA_LINEAGE}'),
  schema_lineage_digest TEXT NOT NULL CHECK (
    schema_lineage_digest = '${SCHEMA_LINEAGE_DIGEST}'
  ),
  from_schema_fingerprint TEXT NOT NULL CHECK (
    from_schema_fingerprint IN (
      ${acceptedSchema31FingerprintSql}
    )
  ),
  schema_fingerprint TEXT NOT NULL CHECK (
    length(schema_fingerprint) = 64
    AND lower(schema_fingerprint) = schema_fingerprint
    AND schema_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  migration_name TEXT NOT NULL CHECK (migration_name = '${NAME}'),
  migration_checksum TEXT NOT NULL CHECK (
    length(migration_checksum) = 64
    AND lower(migration_checksum) = migration_checksum
    AND migration_checksum NOT GLOB '*[^0-9a-f]*'
  ),
  migration_down_policy TEXT NOT NULL
    CHECK (migration_down_policy = '${DOWN_POLICY}'),
  migration_applied_at INTEGER NOT NULL
    CHECK (migration_applied_at BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  migration_receipt_digest TEXT NOT NULL CHECK (
    length(migration_receipt_digest) = 64
    AND lower(migration_receipt_digest) = migration_receipt_digest
    AND migration_receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  identity_digest TEXT NOT NULL CHECK (
    length(identity_digest) = 64
    AND lower(identity_digest) = identity_digest
    AND identity_digest NOT GLOB '*[^0-9a-f]*'
  ),
  logical_content_digest_algorithm TEXT NOT NULL
    CHECK (logical_content_digest_algorithm = 'sha256'),
  logical_content_digest_scope TEXT NOT NULL
    CHECK (logical_content_digest_scope = '${LOGICAL_CONTENT_DIGEST_SCOPE}'),
  logical_content_digest TEXT NOT NULL CHECK (
    length(logical_content_digest) = 64
    AND lower(logical_content_digest) = logical_content_digest
    AND logical_content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL
    CHECK (created_at BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  sealed_at INTEGER NOT NULL
    CHECK (sealed_at BETWEEN created_at AND ${MAX_SAFE_INTEGER}),
  UNIQUE (
    receipt_uuid,
    database_uuid,
    recovery_generation,
    captured_write_sequence
  )
) STRICT;

CREATE INDEX idx_project_database_backup_receipts_identity_sequence
  ON project_database_backup_receipts (
    database_uuid,
    recovery_generation,
    captured_write_sequence DESC,
    sealed_at DESC
  );

CREATE TABLE project_database_canonical_backup_head (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  receipt_uuid TEXT NOT NULL,
  database_uuid TEXT NOT NULL,
  recovery_generation TEXT NOT NULL,
  captured_write_sequence INTEGER NOT NULL
    CHECK (captured_write_sequence BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  selected_at INTEGER NOT NULL
    CHECK (selected_at BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  FOREIGN KEY (
    receipt_uuid,
    database_uuid,
    recovery_generation,
    captured_write_sequence
  ) REFERENCES project_database_backup_receipts (
    receipt_uuid,
    database_uuid,
    recovery_generation,
    captured_write_sequence
  ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;
`;

const RUNTIME_GUARDS_SQL = String.raw`
CREATE TRIGGER trg_project_database_storage_policy_insert_guard
BEFORE INSERT ON project_database_storage_policy
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM project_database_storage_policy)
BEGIN
  SELECT RAISE(ABORT, 'schema32 storage policy replacement or duplicate insert is forbidden');
END;

CREATE TRIGGER trg_project_database_storage_policy_update_guard
BEFORE UPDATE ON project_database_storage_policy
FOR EACH ROW
WHEN NEW.singleton_id <> OLD.singleton_id
  OR NEW.policy_revision <> OLD.policy_revision + 1
  OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'schema32 storage policy identity/revision/timestamp is immutable or non-monotonic');
END;

CREATE TRIGGER trg_project_database_storage_policy_delete_guard
BEFORE DELETE ON project_database_storage_policy
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'schema32 storage policy singleton cannot be deleted');
END;

CREATE TRIGGER trg_project_database_identity_insert_guard
BEFORE INSERT ON project_database_identity
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM project_database_identity)
BEGIN
  SELECT RAISE(ABORT, 'schema32 database identity replacement or duplicate insert is forbidden');
END;

CREATE TRIGGER trg_project_database_identity_immutable
BEFORE UPDATE ON project_database_identity
FOR EACH ROW
WHEN NEW.singleton_id <> OLD.singleton_id
  OR NEW.database_uuid <> OLD.database_uuid
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.schema_lineage <> OLD.schema_lineage
  OR NEW.schema_lineage_digest <> OLD.schema_lineage_digest
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'schema32 permanent database identity or lineage is immutable');
END;

CREATE TRIGGER trg_project_database_identity_sequence_guard
BEFORE UPDATE ON project_database_identity
FOR EACH ROW
WHEN NEW.write_sequence <> OLD.write_sequence + 1
  OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'schema32 write sequence must advance exactly once per identity update');
END;

CREATE TRIGGER trg_project_database_identity_delete_guard
BEFORE DELETE ON project_database_identity
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'schema32 database identity singleton cannot be deleted');
END;

CREATE TRIGGER trg_project_database_backup_receipts_insert_collision_guard
BEFORE INSERT ON project_database_backup_receipts
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM project_database_backup_receipts
  WHERE receipt_uuid = NEW.receipt_uuid
)
BEGIN
  SELECT RAISE(ABORT, 'schema32 backup receipt replacement or duplicate insert is forbidden');
END;

CREATE TRIGGER trg_project_database_backup_receipts_current_identity_insert
BEFORE INSERT ON project_database_backup_receipts
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM project_database_identity AS identity
  JOIN project_database_storage_policy AS policy ON policy.singleton_id = 1
  WHERE identity.singleton_id = 1
    AND NEW.database_uuid = identity.database_uuid
    AND NEW.recovery_generation = identity.recovery_generation
    AND NEW.captured_write_sequence = identity.write_sequence
    AND NEW.storage_policy_revision = policy.policy_revision
    AND NEW.schema_version = identity.schema_version
    AND NEW.schema_lineage = identity.schema_lineage
    AND NEW.schema_lineage_digest = identity.schema_lineage_digest
)
BEGIN
  SELECT RAISE(ABORT, 'schema32 backup receipt must match current identity and storage policy');
END;

CREATE TRIGGER trg_project_database_backup_receipts_update_guard
BEFORE UPDATE ON project_database_backup_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'schema32 backup receipts are immutable');
END;

CREATE TRIGGER trg_project_database_backup_receipts_delete_guard
BEFORE DELETE ON project_database_backup_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'schema32 backup receipts are immutable');
END;

CREATE TRIGGER trg_project_database_canonical_backup_head_insert_collision_guard
BEFORE INSERT ON project_database_canonical_backup_head
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM project_database_canonical_backup_head)
BEGIN
  SELECT RAISE(ABORT, 'schema32 canonical backup head replacement or duplicate insert is forbidden');
END;

CREATE TRIGGER trg_project_database_canonical_backup_head_insert_guard
BEFORE INSERT ON project_database_canonical_backup_head
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM project_database_backup_receipts AS receipt
  JOIN project_database_identity AS identity ON identity.singleton_id = 1
  WHERE receipt.receipt_uuid = NEW.receipt_uuid
    AND receipt.database_uuid = NEW.database_uuid
    AND receipt.recovery_generation = NEW.recovery_generation
    AND receipt.captured_write_sequence = NEW.captured_write_sequence
    AND receipt.database_uuid = identity.database_uuid
    AND receipt.recovery_generation = identity.recovery_generation
    AND receipt.captured_write_sequence = identity.write_sequence
    AND NEW.selected_at >= receipt.sealed_at
)
BEGIN
  SELECT RAISE(ABORT, 'schema32 canonical backup head must select a sealed receipt for the current identity');
END;

CREATE TRIGGER trg_project_database_canonical_backup_head_update_guard
BEFORE UPDATE ON project_database_canonical_backup_head
FOR EACH ROW
WHEN NEW.singleton_id <> OLD.singleton_id
  OR NEW.captured_write_sequence <= OLD.captured_write_sequence
  OR NEW.selected_at < OLD.selected_at
  OR NOT EXISTS (
    SELECT 1
    FROM project_database_backup_receipts AS receipt
    JOIN project_database_identity AS identity ON identity.singleton_id = 1
    WHERE receipt.receipt_uuid = NEW.receipt_uuid
      AND receipt.database_uuid = NEW.database_uuid
      AND receipt.recovery_generation = NEW.recovery_generation
      AND receipt.captured_write_sequence = NEW.captured_write_sequence
      AND receipt.database_uuid = identity.database_uuid
      AND receipt.recovery_generation = identity.recovery_generation
      AND receipt.captured_write_sequence = identity.write_sequence
      AND NEW.selected_at >= receipt.sealed_at
  )
BEGIN
  SELECT RAISE(ABORT, 'schema32 canonical backup head must advance to a sealed current-identity receipt');
END;

CREATE TRIGGER trg_project_database_canonical_backup_head_delete_guard
BEFORE DELETE ON project_database_canonical_backup_head
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'schema32 canonical backup head cannot be deleted');
END;
`;

const UP_SQL = String.raw`
${CREATE_SQL}
${RUNTIME_GUARDS_SQL}
`;

// There is no truthful inverse after schema-32 identity sequences or backup
// receipts have been observed. Downgrade restores a separately verified
// schema-31 recovery point.
const DOWN_SQL = '';

const ownedObjects = Object.freeze({
  tables: Object.freeze([
    'project_database_storage_policy',
    'project_database_identity',
    'project_database_backup_receipts',
    'project_database_canonical_backup_head',
  ]),
  indexes: Object.freeze([
    'idx_project_database_backup_receipts_identity_sequence',
  ]),
  views: Object.freeze([]),
  triggers: Object.freeze([
    'trg_project_database_storage_policy_insert_guard',
    'trg_project_database_storage_policy_update_guard',
    'trg_project_database_storage_policy_delete_guard',
    'trg_project_database_identity_insert_guard',
    'trg_project_database_identity_immutable',
    'trg_project_database_identity_sequence_guard',
    'trg_project_database_identity_delete_guard',
    'trg_project_database_backup_receipts_insert_collision_guard',
    'trg_project_database_backup_receipts_current_identity_insert',
    'trg_project_database_backup_receipts_update_guard',
    'trg_project_database_backup_receipts_delete_guard',
    'trg_project_database_canonical_backup_head_insert_collision_guard',
    'trg_project_database_canonical_backup_head_insert_guard',
    'trg_project_database_canonical_backup_head_update_guard',
    'trg_project_database_canonical_backup_head_delete_guard',
  ]),
});

for (const [kind, names] of Object.entries(ownedObjects)) {
  if (new Set(names).size !== names.length) {
    throw new Error(`schema32 ${kind} object names collide`);
  }
}

const ownedObjectNames = Object.freeze([
  ...ownedObjects.tables,
  ...ownedObjects.indexes,
  ...ownedObjects.views,
  ...ownedObjects.triggers,
]);

const hardExitCheckpoints = Object.freeze([
  'after-from-verify',
  'after-ddl',
  'after-backfill',
  'after-to-verify',
  'after-ledger',
  'after-receipt',
  'before-commit',
]);

const imperativeContract = Object.freeze({
  format: 't8-project-database-migration-32-imperative-v1',
  integrationStatus: INTEGRATION_STATUS,
  freshnessClaim: FRESHNESS_CLAIM,
  lineage: SCHEMA_LINEAGE_DESCRIPTOR,
  targetManifestComposition: Object.freeze({
    format: 't8-project-database-schema32-descriptor-partition-v1',
    sourceDescriptorVersion: FROM_VERSION,
    targetDescriptorVersion: VERSION,
    acceptedSourceCount: ACCEPTED_SCHEMA_31_FINGERPRINTS.length,
    knownVectorCount: SCHEMA_32_FINGERPRINT_MAPPINGS.length,
    extensionFingerprint: SCHEMA_32_EXTENSION_FINGERPRINT,
    ownedObjectCount: ownedObjectNames.length,
    partitionPolicy: 'exact-owned-names-disjoint-and-counts-additive',
    fingerprintAlgorithm: 'sha256-canonical-json',
    postDdlPolicy: 'reinspect-complete-target-and-require-composed-fingerprint',
  }),
  storagePolicy: Object.freeze({
    format: 't8-project-database-storage-policy-v1',
    singletonCardinality: 1,
    maximumInteger: MAX_SAFE_INTEGER,
    requiredSynchronousMode: 'FULL',
    normalAdmissionAlgorithm:
      'main-plus-wal-reserve-plus-shm-plus-hot-journal-plus-temp-plus-minimum-free-v1',
    backupAdmissionAlgorithm:
      'main-plus-wal-residual-plus-shm-plus-hot-journal-with-explicit-recovery-reserve-v1',
    unknownMeasurementPolicy: 'deny-never-substitute-zero',
  }),
  databaseIdentity: Object.freeze({
    format: 't8-project-database-identity-v1',
    singletonCardinality: 1,
    databaseUuidPolicy: 'permanent-rfc4122-lowercase',
    recoveryGenerationPolicy: 'rfc4122-lowercase-rotate-on-recovery',
    recoveryGenerationTransition:
      'dedicated-recovery-transaction-with-verified-evidence-and-external-generation-fence',
    recoveryGenerationWiringStatus: 'production-wired-fail-closed',
    writeSequencePolicy: 'monotonic-exactly-once-per-committed-public-write',
    lineage: SCHEMA_LINEAGE,
    lineageDigest: SCHEMA_LINEAGE_DIGEST,
  }),
  canonicalBackupReceipt: Object.freeze({
    format: 't8-project-database-canonical-backup-receipt-v1',
    storage: 'inside-candidate-sqlite-transaction-never-loose-json',
    canonicalJson: CANONICAL_JSON_CONTRACT,
    identityDigestAlgorithm: 'sha256-canonical-json-utf8-v1',
    identityDigestFields: Object.freeze([
      'databaseUuid',
      'recoveryGeneration',
      'capturedWriteSequence',
      'storagePolicyRevision',
      'schemaLineageDigest',
    ]),
    migrationReceiptDigestAlgorithm: 'sha256-canonical-json-utf8-v1',
    migrationReceiptDigestFields: Object.freeze([
      'schemaVersion',
      'migrationName',
      'migrationChecksum',
      'fromSchemaFingerprint',
      'schemaFingerprint',
      'downPolicy',
      'appliedAt',
    ]),
    logicalContentDigestAlgorithm: 'sha256',
    logicalContentDigestScope: LOGICAL_CONTENT_DIGEST_SCOPE,
    logicalContentDigest: LOGICAL_CONTENT_DIGEST_CONTRACT,
    selectionPolicy:
      'singleton-head-must-match-receipt-and-candidate-database-identity-exactly',
    freshnessVerificationStatus: 'production-wired-fail-closed',
    freshnessFailurePolicy:
      'deny-when-sequence-generation-identity-digest-or-logical-digest-is-unverified',
  }),
  crashContract: Object.freeze({
    hardExitCheckpoints,
    afterCommitControl: 'after-commit-control',
    preCommitExpectation: 'exact-schema31-primary-and-verified-recovery-point',
    postCommitExpectation: 'complete-schema32-or-restore-verified-schema31-backup',
  }),
  phases: Object.freeze([
    Object.freeze({
      id: 'locked-schema31-gate',
      algorithmVersion: 'fingerprint-receipt-data-version-backup-v1',
      invariants: Object.freeze([
        'acquire-immediate-before-capacity-classification-or-ddl',
        'source-must-match-one-exact-accepted-schema31-fingerprint',
        'verified-schema31-backup-data-version-must-match-under-lock',
      ]),
    }),
    Object.freeze({
      id: 'physical-capacity-admission-before-ddl',
      algorithmVersion: 'active-backup-recovery-headroom-v1',
      invariants: Object.freeze([
        'filesystem-free-main-wal-shm-journal-and-temp-measurements-are-known',
        'unknown-measurement-never-falls-back-to-zero-or-unbounded',
        'active-backup-candidate-and-recovery-evidence-reserves-all-fit-before-ddl',
      ]),
    }),
    Object.freeze({
      id: 'create-schema32-contract-state',
      algorithmVersion: 'strict-singletons-and-self-contained-receipt-v1',
      invariants: Object.freeze([
        'create-only-the-frozen-schema32-owned-object-set',
        'do-not-expose-schema32-to-runtime-before-complete-verification',
        'canonical-receipt-state-lives-inside-the-sqlite-candidate',
      ]),
    }),
    Object.freeze({
      id: 'initialize-storage-policy-and-database-identity',
      algorithmVersion: 'explicit-policy-uuid-generation-sequence-v1',
      invariants: Object.freeze([
        'storage-policy-and-database-identity-each-have-exactly-one-row',
        'database-uuid-is-permanent-and-recovery-generation-is-explicit',
        'write-sequence-bootstrap-is-never-derived-from-file-size-or-mtime',
      ]),
    }),
    Object.freeze({
      id: 'install-schema32-runtime-guards',
      algorithmVersion: 'singleton-monotonic-append-only-v1',
      invariants: Object.freeze([
        'insert-replace-and-upsert-cannot-bypass-singleton-or-append-only-guards',
        'storage-policy-revisions-and-write-sequences-advance-exactly-once',
        'database-uuid-lineage-receipts-and-sealed-content-are-immutable',
        'canonical-head-can-only-advance-to-a-current-identity-sealed-receipt',
      ]),
    }),
    Object.freeze({
      id: 'verify-schema32-contract-state',
      algorithmVersion: 'owned-objects-singletons-foreign-key-quick-v1',
      invariants: Object.freeze([
        'owned-object-manifest-and-both-singletons-are-exact',
        'storage-policy-ordering-and-physical-budget-equations-are-exact',
        'foreign-key-check-is-empty-and-quick-check-is-ok',
      ]),
    }),
    Object.freeze({
      id: 'lineage-and-receipt-commit',
      algorithmVersion: 'schema31-source-plus-schema32-extension-descriptor-compose-v1',
      invariants: Object.freeze([
        'accepted-schema31-source-descriptor-and-exact-disjoint-extension-compose-one-target',
        'prepared-guard-binds-the-composed-target-before-main-database-ddl',
        'post-ddl-complete-manifest-must-equal-the-composed-target-fingerprint',
        'ledger-and-checksummed-migration-receipt-commit-in-the-same-transaction',
        'canonical-backup-freshness-requires-sealed-content-and-acknowledged-write-sequence',
      ]),
    }),
  ]),
});

function normalizeSql(sql) {
  return String(sql).replace(/\r\n?/g, '\n').trim();
}

const canonicalChecksumInput = JSON.stringify({
  format: CHECKSUM_CANONICALIZATION,
  version: VERSION,
  fromVersion: FROM_VERSION,
  name: NAME,
  downPolicy: DOWN_POLICY,
  UP_SQL: normalizeSql(UP_SQL),
  DOWN_SQL: normalizeSql(DOWN_SQL),
  ownedObjectNames,
  imperativeContract,
});

const checksum = createHash('sha256')
  .update(canonicalChecksumInput, 'utf8')
  .digest('hex');

const definition = Object.freeze({
  version: VERSION,
  fromVersion: FROM_VERSION,
  name: NAME,
  downPolicy: DOWN_POLICY,
  checksumAlgorithm: 'sha256',
  checksumCanonicalization: CHECKSUM_CANONICALIZATION,
  checksum,
  UP_SQL,
  DOWN_SQL,
  ownedObjects,
  ownedObjectNames,
  imperativeContract,
});

module.exports = Object.freeze({
  PROJECT_DATABASE_MIGRATION_32: definition,
  PROJECT_DATABASE_MIGRATION_32_UP_SQL: UP_SQL,
  PROJECT_DATABASE_MIGRATION_32_DOWN_SQL: DOWN_SQL,
  PROJECT_DATABASE_MIGRATION_32_CREATE_SQL: CREATE_SQL,
  PROJECT_DATABASE_MIGRATION_32_RUNTIME_GUARDS_SQL: RUNTIME_GUARDS_SQL,
  PROJECT_DATABASE_MIGRATION_32_IMPERATIVE_CONTRACT: imperativeContract,
  PROJECT_DATABASE_SCHEMA_32_OWNED_OBJECTS: ownedObjects,
  PROJECT_DATABASE_SCHEMA_32_OWNED_OBJECT_NAMES: ownedObjectNames,
  PROJECT_DATABASE_SCHEMA_32_LINEAGE: SCHEMA_LINEAGE,
  PROJECT_DATABASE_SCHEMA_32_LINEAGE_DESCRIPTOR: SCHEMA_LINEAGE_DESCRIPTOR,
  PROJECT_DATABASE_SCHEMA_32_LINEAGE_DIGEST: SCHEMA_LINEAGE_DIGEST,
  PROJECT_DATABASE_SCHEMA_32_ACCEPTED_SCHEMA_31_FINGERPRINTS:
    ACCEPTED_SCHEMA_31_FINGERPRINTS,
  PROJECT_DATABASE_SCHEMA_32_EXTENSION_FINGERPRINT:
    SCHEMA_32_EXTENSION_FINGERPRINT,
  PROJECT_DATABASE_SCHEMA_32_FINGERPRINT_MAPPINGS:
    SCHEMA_32_FINGERPRINT_MAPPINGS,
  composeProjectDatabaseSchema32TargetManifest,
  PROJECT_DATABASE_SCHEMA_32_LOGICAL_CONTENT_DIGEST_SCOPE:
    LOGICAL_CONTENT_DIGEST_SCOPE,
  PROJECT_DATABASE_SCHEMA_32_CANONICAL_JSON: canonicalJson,
  PROJECT_DATABASE_SCHEMA_32_CANONICAL_SHA256: canonicalSha256,
  PROJECT_DATABASE_SCHEMA_32_CANONICAL_JSON_CONTRACT: CANONICAL_JSON_CONTRACT,
  PROJECT_DATABASE_SCHEMA_32_LOGICAL_CONTENT_DIGEST_CONTRACT:
    LOGICAL_CONTENT_DIGEST_CONTRACT,
  PROJECT_DATABASE_MIGRATION_32_HARD_EXIT_CHECKPOINTS: hardExitCheckpoints,
});
