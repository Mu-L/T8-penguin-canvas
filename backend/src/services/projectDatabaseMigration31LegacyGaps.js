'use strict';

const { createHash } = require('node:crypto');

const VERSION = 31;
const FROM_VERSION = 30;
const NAME = 'owner-scoped-legacy-snapshot-gaps';
const COMPONENT_CHECKSUM_CANONICALIZATION = 't8-project-database-migration-31-component-v1';
const SOURCE_MIGRATION_VERSION = 29;
const SOURCE_MIGRATION_RECEIPT_CHECKSUM = 'a8f05a9c0029fc29d08037216ea0a58b686714daa3fb9bc616f658f97800b7d8';
const OWNER_STATE_DIGEST_FORMAT = 't8-project-database-schema31-legacy-owner-state-v1';

const columns = Object.freeze([
  'project_id',
  'canvas_id',
  'pin_kind',
  'owner_id',
  'slot',
  'snapshot_revision',
  'owner_table',
  'owner_status_at_migration',
  'owner_revision_at_migration',
  'owner_state_digest',
  'source_schema_version',
  'source_migration_version',
  'source_receipt_checksum',
  'created_at',
]);

const freezeOwnerBinding = (binding) => Object.freeze({
  ...binding,
  ownerStateDescriptorFields: Object.freeze([...binding.ownerStateDescriptorFields]),
});

// These are the only durable owner kinds that schema 29 attempted to pin and
// that can legitimately predate strict owner/snapshot enforcement. A recovery
// anchor is derived from an extant snapshot, so it can never be a legacy gap.
const ownerBindings = Object.freeze([
  freezeOwnerBinding({
    pinKind: 'run_intent',
    ownerTable: 'run_intents',
    slot: 'canvas',
    snapshotRevisionColumn: 'canvas_revision',
    ownerStatusColumn: 'status',
    ownerRevisionColumn: 'queue_revision',
    ownerStateDescriptorFields: [
      'id', 'project_id', 'canvas_id', 'canvas_revision', 'status', 'queue_revision',
    ],
  }),
  freezeOwnerBinding({
    pinKind: 'run',
    ownerTable: 'runs',
    slot: 'canvas',
    snapshotRevisionColumn: 'canvas_revision',
    ownerStatusColumn: 'status',
    ownerRevisionColumn: 'revision',
    ownerStateDescriptorFields: [
      'id', 'project_id', 'canvas_id', 'canvas_revision', 'status', 'revision',
    ],
  }),
  freezeOwnerBinding({
    pinKind: 'review_source',
    ownerTable: 'review_threads',
    slot: 'source',
    snapshotRevisionColumn: 'canvas_revision',
    ownerStatusColumn: 'status',
    ownerRevisionColumn: 'revision',
    ownerStateDescriptorFields: [
      'id', 'project_id', 'canvas_id', 'canvas_revision', 'status', 'revision',
    ],
  }),
  freezeOwnerBinding({
    pinKind: 'review_decision',
    ownerTable: 'review_threads',
    slot: 'decision',
    snapshotRevisionColumn: 'decision_canvas_revision',
    ownerStatusColumn: 'status',
    ownerRevisionColumn: 'revision',
    ownerStateDescriptorFields: [
      'id', 'project_id', 'canvas_id', 'decision_canvas_revision', 'status', 'revision',
    ],
  }),
  freezeOwnerBinding({
    pinKind: 'patch_applied',
    ownerTable: 'canvas_patch_applications',
    slot: 'applied',
    snapshotRevisionColumn: 'applied_revision',
    ownerStatusColumn: 'status',
    ownerRevisionColumn: null,
    ownerStateDescriptorFields: [
      'patch_id', 'project_id', 'canvas_id', 'applied_revision', 'status',
    ],
  }),
]);

const ownerStateDigestContract = Object.freeze({
  format: OWNER_STATE_DIGEST_FORMAT,
  algorithm: 'sha256',
  canonicalization: 'ordered-json-object-with-ordered-field-tuples-v1',
  descriptorPropertyOrder: Object.freeze(['format', 'pinKind', 'ownerTable', 'slot', 'fields']),
  fieldTupleOrder: Object.freeze(['columnName', 'exactScalarValue']),
  scalarPolicy: 'non-null-string-or-safe-integer-without-coercion-v1',
  unrelatedFieldPolicy: 'ignore-fields-not-listed-for-the-owner-binding',
  descriptors: Object.freeze(ownerBindings.map((binding) => Object.freeze({
    pinKind: binding.pinKind,
    ownerTable: binding.ownerTable,
    slot: binding.slot,
    fields: binding.ownerStateDescriptorFields,
  }))),
});

function ownerStateBinding(bindingOrPinKind) {
  const pinKind = typeof bindingOrPinKind === 'string'
    ? bindingOrPinKind
    : bindingOrPinKind?.pinKind;
  const binding = ownerBindings.find((candidate) => candidate.pinKind === pinKind);
  if (!binding) throw new TypeError(`unknown legacy snapshot gap owner binding: ${String(pinKind || '')}`);
  return binding;
}

function ownerStateScalar(row, field, pinKind) {
  if (!Object.prototype.hasOwnProperty.call(row, field) || row[field] == null) {
    throw new TypeError(`${pinKind} owner state field ${field} is required`);
  }
  const value = row[field];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw new TypeError(`${pinKind} owner state field ${field} must be a string or safe integer`);
}

function ownerStateDescriptor(bindingOrPinKind, row) {
  const binding = ownerStateBinding(bindingOrPinKind);
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError(`${binding.pinKind} owner state row must be an object`);
  }
  const fields = Object.freeze(binding.ownerStateDescriptorFields.map((field) => Object.freeze([
    field,
    ownerStateScalar(row, field, binding.pinKind),
  ])));
  return Object.freeze({
    format: OWNER_STATE_DIGEST_FORMAT,
    pinKind: binding.pinKind,
    ownerTable: binding.ownerTable,
    slot: binding.slot,
    fields,
  });
}

function ownerStateDigest(bindingOrPinKind, row) {
  return createHash('sha256')
    .update(JSON.stringify(ownerStateDescriptor(bindingOrPinKind, row)), 'utf8')
    .digest('hex');
}

const sourceContract = Object.freeze({
  schemaVersion: FROM_VERSION,
  migrationVersion: SOURCE_MIGRATION_VERSION,
  migrationReceiptChecksum: SOURCE_MIGRATION_RECEIPT_CHECKSUM,
});

const ownerBindingCheckSql = ownerBindings.map((binding) => (
  `(pin_kind = '${binding.pinKind}' AND owner_table = '${binding.ownerTable}' AND slot = '${binding.slot}')`
)).join('\n      OR ');

// Runtime guards are intentionally not part of CREATE_SQL. The schema 31
// migration must create the table, classify/repair the locked legacy set, and
// insert the exact remaining gaps before installing these guards. Once the
// guards exist, no normal runtime path can mint, rewrite, resolve, or delete a
// compatibility exception.
const CREATE_SQL = String.raw`
CREATE TABLE IF NOT EXISTS canvas_legacy_snapshot_gaps (
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 240),
  canvas_id TEXT NOT NULL CHECK(length(canvas_id) BETWEEN 1 AND 240),
  pin_kind TEXT NOT NULL CHECK(length(pin_kind) BETWEEN 1 AND 80),
  owner_id TEXT NOT NULL
    CHECK(
      length(owner_id) BETWEEN 1 AND 240
      AND owner_id NOT IN ('__proto__', 'prototype', 'constructor')
    ),
  slot TEXT NOT NULL CHECK(length(slot) BETWEEN 1 AND 120),
  snapshot_revision INTEGER NOT NULL CHECK(snapshot_revision >= 1),
  owner_table TEXT NOT NULL CHECK(length(owner_table) BETWEEN 1 AND 120),
  owner_status_at_migration TEXT NOT NULL
    CHECK(length(owner_status_at_migration) BETWEEN 1 AND 80),
  owner_revision_at_migration INTEGER
    CHECK(owner_revision_at_migration IS NULL OR owner_revision_at_migration >= 1),
  owner_state_digest TEXT NOT NULL
    CHECK(
      length(owner_state_digest) = 64
      AND owner_state_digest NOT GLOB '*[^0-9a-f]*'
    ),
  source_schema_version INTEGER NOT NULL CHECK(source_schema_version = ${FROM_VERSION}),
  source_migration_version INTEGER NOT NULL CHECK(source_migration_version = ${SOURCE_MIGRATION_VERSION}),
  source_receipt_checksum TEXT NOT NULL
    CHECK(source_receipt_checksum = '${SOURCE_MIGRATION_RECEIPT_CHECKSUM}'),
  created_at INTEGER NOT NULL CHECK(created_at >= 1),
  PRIMARY KEY(project_id, canvas_id, pin_kind, owner_id, slot),
  CHECK (
      ${ownerBindingCheckSql}
  ),
  CHECK (
    (pin_kind = 'patch_applied' AND owner_revision_at_migration IS NULL)
    OR (pin_kind <> 'patch_applied' AND owner_revision_at_migration IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_canvas_legacy_snapshot_gaps_revision
  ON canvas_legacy_snapshot_gaps(
    project_id,
    canvas_id,
    snapshot_revision,
    pin_kind,
    owner_id,
    slot
  );
`;

const RUNTIME_GUARDS_SQL = String.raw`
CREATE TRIGGER IF NOT EXISTS trg_canvas_legacy_snapshot_gaps_insert_guard
BEFORE INSERT ON canvas_legacy_snapshot_gaps
BEGIN
  SELECT RAISE(ABORT, 'legacy snapshot gap insert is migration-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_legacy_snapshot_gaps_update_guard
BEFORE UPDATE ON canvas_legacy_snapshot_gaps
BEGIN
  SELECT RAISE(ABORT, 'legacy snapshot gap evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_legacy_snapshot_gaps_delete_guard
BEFORE DELETE ON canvas_legacy_snapshot_gaps
BEGIN
  SELECT RAISE(ABORT, 'legacy snapshot gap evidence cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_legacy_snapshot_gaps_reserve_run_intent_insert
BEFORE INSERT ON run_intents
WHEN EXISTS (
  SELECT 1
  FROM canvas_legacy_snapshot_gaps gap
  WHERE gap.project_id = NEW.project_id
    AND gap.canvas_id = NEW.canvas_id
    AND gap.pin_kind = 'run_intent'
    AND gap.owner_table = 'run_intents'
    AND gap.owner_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'legacy snapshot gap owner identity is permanently reserved');
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_legacy_snapshot_gaps_reserve_run_insert
BEFORE INSERT ON runs
WHEN EXISTS (
  SELECT 1
  FROM canvas_legacy_snapshot_gaps gap
  WHERE gap.project_id = NEW.project_id
    AND gap.canvas_id = NEW.canvas_id
    AND gap.pin_kind = 'run'
    AND gap.owner_table = 'runs'
    AND gap.owner_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'legacy snapshot gap owner identity is permanently reserved');
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_legacy_snapshot_gaps_reserve_review_thread_insert
BEFORE INSERT ON review_threads
WHEN EXISTS (
  SELECT 1
  FROM canvas_legacy_snapshot_gaps gap
  WHERE gap.project_id = NEW.project_id
    AND gap.canvas_id = NEW.canvas_id
    AND gap.pin_kind IN ('review_source', 'review_decision')
    AND gap.owner_table = 'review_threads'
    AND gap.owner_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'legacy snapshot gap owner identity is permanently reserved');
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_legacy_snapshot_gaps_reserve_canvas_patch_application_insert
BEFORE INSERT ON canvas_patch_applications
WHEN EXISTS (
  SELECT 1
  FROM canvas_legacy_snapshot_gaps gap
  WHERE gap.project_id = NEW.project_id
    AND gap.canvas_id = NEW.canvas_id
    AND gap.pin_kind = 'patch_applied'
    AND gap.owner_table = 'canvas_patch_applications'
    AND gap.owner_id = NEW.patch_id
)
BEGIN
  SELECT RAISE(ABORT, 'legacy snapshot gap owner identity is permanently reserved');
END;
`;

const ownedObjects = Object.freeze({
  tables: Object.freeze(['canvas_legacy_snapshot_gaps']),
  indexes: Object.freeze(['idx_canvas_legacy_snapshot_gaps_revision']),
  views: Object.freeze([]),
  triggers: Object.freeze([
    'trg_canvas_legacy_snapshot_gaps_insert_guard',
    'trg_canvas_legacy_snapshot_gaps_update_guard',
    'trg_canvas_legacy_snapshot_gaps_delete_guard',
    'trg_canvas_legacy_snapshot_gaps_reserve_run_intent_insert',
    'trg_canvas_legacy_snapshot_gaps_reserve_run_insert',
    'trg_canvas_legacy_snapshot_gaps_reserve_review_thread_insert',
    'trg_canvas_legacy_snapshot_gaps_reserve_canvas_patch_application_insert',
  ]),
});

const ownedObjectNames = Object.freeze([
  ...ownedObjects.tables,
  ...ownedObjects.indexes,
  ...ownedObjects.views,
  ...ownedObjects.triggers,
]);

const DOWN_SQL = String.raw`
DROP TRIGGER IF EXISTS trg_canvas_legacy_snapshot_gaps_reserve_canvas_patch_application_insert;
DROP TRIGGER IF EXISTS trg_canvas_legacy_snapshot_gaps_reserve_review_thread_insert;
DROP TRIGGER IF EXISTS trg_canvas_legacy_snapshot_gaps_reserve_run_insert;
DROP TRIGGER IF EXISTS trg_canvas_legacy_snapshot_gaps_reserve_run_intent_insert;
DROP TRIGGER IF EXISTS trg_canvas_legacy_snapshot_gaps_delete_guard;
DROP TRIGGER IF EXISTS trg_canvas_legacy_snapshot_gaps_update_guard;
DROP TRIGGER IF EXISTS trg_canvas_legacy_snapshot_gaps_insert_guard;
DROP INDEX IF EXISTS idx_canvas_legacy_snapshot_gaps_revision;
DROP TABLE IF EXISTS canvas_legacy_snapshot_gaps;
`;

const ddl = Object.freeze({
  createSql: CREATE_SQL,
  runtimeGuardsSql: RUNTIME_GUARDS_SQL,
  downSql: DOWN_SQL,
});

const imperativeContract = Object.freeze({
  format: 't8-project-database-migration-31-legacy-gaps-imperative-v1',
  source: sourceContract,
  ownerStateDigest: ownerStateDigestContract,
  columns,
  ownerBindings,
  phases: Object.freeze([
    Object.freeze({
      id: 'locked-schema30-legacy-gap-gate',
      algorithmVersion: 'exact-receipt-owner-set-v1',
      invariants: Object.freeze([
        'acquire-immediate-before-classification-or-ddl',
        'schema30-full-fingerprint-and-v29-v30-receipts-must-remain-exact',
        'candidate-owner-set-is-materialized-once-under-the-write-lock',
      ]),
    }),
    Object.freeze({
      id: 'create-legacy-gap-ledger-before-guards',
      algorithmVersion: 'pre-guard-owner-ledger-v1',
      invariants: Object.freeze([
        'create-table-and-index-without-runtime-write-guards',
        'no-normal-runtime-is-exposed-before-guard-installation-and-commit',
      ]),
    }),
    Object.freeze({
      id: 'repair-or-classify-legacy-owner-gaps',
      algorithmVersion: 'current-head-repair-stale-intent-exact-gap-v1',
      invariants: Object.freeze([
        'current-head-document-may-repair-only-its-byte-equivalent-project-canvas-revision',
        'historical-snapshots-are-never-fabricated-from-the-current-document',
        'unrecoverable-active-run-intents-become-stale-with-an-atomic-audit-event',
        'remaining-preexisting-gaps-bind-owner-scope-revision-state-and-source-receipt-exactly',
      ]),
    }),
    Object.freeze({
      id: 'install-legacy-gap-runtime-guards',
      algorithmVersion: 'post-backfill-insert-update-delete-deny-v1',
      invariants: Object.freeze([
        'insert-guard-is-installed-only-after-the-exact-backfill-completes',
        'runtime-insert-update-and-delete-all-fail-closed',
        'owner-insert-guards-reserve-every-gap-identity-in-its-exact-project-canvas-scope',
        'gap-identities-remain-reserved-after-owner-terminalization-or-canvas-deletion',
      ]),
    }),
    Object.freeze({
      id: 'verify-owner-pin-gap-partition',
      algorithmVersion: 'exact-disjoint-owner-partition-v1',
      invariants: Object.freeze([
        'every-managed-owner-has-an-exact-snapshot-pin-or-one-exact-legacy-gap-never-both',
        'no-post-migration-owner-can-enter-the-legacy-gap-set',
        'foreign-key-check-is-empty-and-quick-check-is-ok-before-receipt-commit',
      ]),
    }),
  ]),
});

function normalizeSql(sql) {
  return String(sql).replace(/\r\n?/g, '\n').trim();
}

const canonicalChecksumInput = JSON.stringify({
  format: COMPONENT_CHECKSUM_CANONICALIZATION,
  version: VERSION,
  fromVersion: FROM_VERSION,
  name: NAME,
  columns,
  ownerBindings,
  sourceContract,
  ownerStateDigestContract,
  createSql: normalizeSql(CREATE_SQL),
  runtimeGuardsSql: normalizeSql(RUNTIME_GUARDS_SQL),
  downSql: normalizeSql(DOWN_SQL),
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
  checksumAlgorithm: 'sha256',
  checksumCanonicalization: COMPONENT_CHECKSUM_CANONICALIZATION,
  checksum,
  columns,
  ownerBindings,
  sourceContract,
  ownerStateDigestContract,
  ddl,
  ownedObjects,
  ownedObjectNames,
  imperativeContract,
});

module.exports = Object.freeze({
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS: definition,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_COLUMNS: columns,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_BINDINGS: ownerBindings,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_SOURCE_CONTRACT: sourceContract,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAP_OWNER_STATE_DIGEST_CONTRACT: ownerStateDigestContract,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DDL: ddl,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_CREATE_SQL: CREATE_SQL,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_RUNTIME_GUARDS_SQL: RUNTIME_GUARDS_SQL,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DOWN_SQL: DOWN_SQL,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_OWNED_OBJECTS: ownedObjects,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_OWNED_OBJECT_NAMES: ownedObjectNames,
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_IMPERATIVE_CONTRACT: imperativeContract,
  projectDatabaseLegacyGapOwnerStateDescriptor: ownerStateDescriptor,
  projectDatabaseLegacyGapOwnerStateDigest: ownerStateDigest,
});
