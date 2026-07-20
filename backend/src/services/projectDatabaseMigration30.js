'use strict';

const { createHash } = require('node:crypto');

const VERSION = 30;
const FROM_VERSION = 29;
const NAME = 'bounded-permanent-operation-ledgers';
const DOWN_POLICY = 'empty-only';
const CHECKSUM_CANONICALIZATION = 't8-project-database-migration-v2';
const EXTENSION_FINGERPRINT = 'd8ae5191a2f65deefd5d83222bd987732d36dcccdab4fde3329848f4a75850cb';

const freezeLedgerSpec = (spec) => Object.freeze({
  ...spec,
  textColumns: Object.freeze([...spec.textColumns]),
  integerColumns: Object.freeze([...spec.integerColumns]),
});

// Logical bytes are deliberately independent from SQLite page/WAL size. Every
// present TEXT/JSON value contributes its exact UTF-8 byte length and every
// present INTEGER contributes eight bytes. The same frozen field lists drive
// migration backfill, write triggers, and cold-open recomputation.
const ledgerSpecs = Object.freeze([
  freezeLedgerSpec({
    kind: 'operation-identity',
    table: 'collaboration_operation_identities',
    textColumns: [
      'op_id', 'project_id', 'canvas_id', 'domain', 'type', 'identity_digest', 'batch_id',
    ],
    integerColumns: ['created_at'],
  }),
  freezeLedgerSpec({
    kind: 'canvas-idempotency',
    table: 'canvas_operation_idempotency',
    textColumns: [
      'op_id', 'project_id', 'canvas_id', 'actor_id', 'session_id', 'type', 'payload_digest',
    ],
    integerColumns: ['revision', 'base_revision', 'client_seq', 'created_at'],
  }),
  freezeLedgerSpec({
    kind: 'canvas-batch',
    table: 'canvas_operation_batches',
    textColumns: [
      'request_digest', 'project_id', 'canvas_id', 'actor_id', 'session_id', 'operation_ids_json',
    ],
    integerColumns: [
      'base_revision', 'timestamp_identity', 'operation_count', 'first_revision', 'last_revision',
      'created_at',
    ],
  }),
  freezeLedgerSpec({
    kind: 'common-batch',
    table: 'collaboration_common_operation_batches',
    textColumns: [
      'batch_id', 'project_id', 'canvas_id', 'client_id', 'request_digest', 'operation_ids_json',
      'actor_id', 'session_id',
    ],
    integerColumns: ['client_seq', 'base_revision', 'first_revision', 'last_revision', 'created_at'],
  }),
  freezeLedgerSpec({
    kind: 'domain-idempotency',
    table: 'collaboration_domain_operation_idempotency',
    textColumns: [
      'op_id', 'batch_id', 'project_id', 'canvas_id', 'type', 'payload_digest', 'actor_id',
      'session_id', 'result_json',
    ],
    integerColumns: ['operation_index', 'created_at'],
  }),
  freezeLedgerSpec({
    kind: 'text-update',
    table: 'collaboration_text_update_idempotency',
    textColumns: [
      'update_id', 'request_digest', 'project_id', 'canvas_id', 'target_type', 'target_entity_uid',
      'field_name', 'binding_epoch', 'actor_id', 'session_id', 'result_json',
    ],
    integerColumns: ['client_seq', 'revision', 'created_at'],
  }),
  freezeLedgerSpec({
    kind: 'text-noop',
    table: 'collaboration_text_noop_idempotency',
    textColumns: [
      'update_id', 'request_digest', 'project_id', 'canvas_id', 'target_type', 'target_entity_uid',
      'field_name', 'binding_epoch', 'actor_id', 'session_id', 'result_json',
    ],
    integerColumns: ['client_seq', 'revision', 'created_at'],
  }),
]);

const LEDGER_KIND_COUNT = ledgerSpecs.length;
const ledgerKindsSql = ledgerSpecs.map((spec) => `'${spec.kind}'`).join(', ');

function logicalBytesSql(spec, alias = null) {
  const prefix = alias ? `${alias}.` : '';
  const textParts = spec.textColumns.map((column) => (
    `COALESCE(length(CAST(${prefix}${column} AS BLOB)), 0)`
  ));
  const integerParts = spec.integerColumns.map((column) => (
    `CASE WHEN ${prefix}${column} IS NULL THEN 0 ELSE 8 END`
  ));
  return [...textParts, ...integerParts].join('\n      + ');
}

const imperativeContract = Object.freeze({
  format: 't8-project-database-migration-30-imperative-v1',
  byteModel: 'sum-present-text-json-utf8-bytes-plus-eight-per-present-integer',
  ledgerKinds: Object.freeze(ledgerSpecs.map((spec) => Object.freeze({
    kind: spec.kind,
    table: spec.table,
    textColumns: spec.textColumns,
    integerColumns: spec.integerColumns,
  }))),
  phases: Object.freeze([
    Object.freeze({
      id: 'locked-schema29-gate',
      algorithmVersion: 'fingerprint-data-version-v1',
      invariants: Object.freeze([
        'acquire-immediate-before-ddl',
        'schema29-backup-data-version-must-match-under-lock',
        'schema29-full-fingerprint-and-receipt-must-remain-exact',
      ]),
    }),
    Object.freeze({
      id: 'initialize-permanent-ledger-policy-usage',
      algorithmVersion: 'seven-kind-project-canvas-accounting-v1',
      invariants: Object.freeze([
        'one-policy-and-exactly-seven-usage-rows-per-project-canvas',
        'preexisting-rows-and-logical-utf8-bytes-are-recomputed-exactly',
        'preexisting-overage-is-preserved-without-deleting-replay-evidence',
      ]),
    }),
    Object.freeze({
      id: 'permanent-ledger-write-guards',
      algorithmVersion: 'after-insert-total-capacity-and-immutable-evidence-v1',
      invariants: Object.freeze([
        'only-successful-inserts-consume-row-and-byte-capacity',
        'over-capacity-insert-aborts-the-owning-business-transaction',
        'updates-and-live-canvas-direct-deletes-cannot-release-or-rewrite-evidence',
      ]),
    }),
    Object.freeze({
      id: 'post-backfill-integrity',
      algorithmVersion: 'seven-kind-accounting-fk-quick-v1',
      invariants: Object.freeze([
        'policy-usage-scope-and-every-kind-match-authoritative-ledgers',
        'foreign-key-check-is-empty-and-quick-check-is-ok',
      ]),
    }),
    Object.freeze({
      id: 'lineage-receipt-commit',
      algorithmVersion: 'schema29-base-plus-schema30-extension-v1',
      invariants: Object.freeze([
        'schema29-from-fingerprint-and-receipt-remain-exact',
        'schema30-owned-extension-fingerprint-is-frozen',
        'ledger-and-checksummed-receipt-commit-in-the-same-immediate-transaction',
      ]),
    }),
  ]),
});

const ledgerTriggerSql = ledgerSpecs.map((spec) => {
  const bytesNew = logicalBytesSql(spec, 'NEW');
  const bytesOld = logicalBytesSql(spec, 'OLD');
  const triggerStem = spec.kind.replace(/-/g, '_');
  return String.raw`
CREATE TRIGGER IF NOT EXISTS trg_permanent_ledger_${triggerStem}_state_insert
BEFORE INSERT ON ${spec.table}
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM canvas_permanent_ledger_policies policy
    WHERE policy.project_id = NEW.project_id AND policy.canvas_id = NEW.canvas_id
  ) OR (
    SELECT COUNT(*)
    FROM canvas_permanent_ledger_usage usage
    WHERE usage.project_id = NEW.project_id AND usage.canvas_id = NEW.canvas_id
  ) <> ${LEDGER_KIND_COUNT}
  THEN RAISE(ABORT, 'permanent operation ledger state missing') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_permanent_ledger_${triggerStem}_account_insert
AFTER INSERT ON ${spec.table}
BEGIN
  UPDATE canvas_permanent_ledger_usage
  SET row_count = row_count + 1,
      logical_bytes = logical_bytes + (
        ${bytesNew}
      ),
      updated_at = MAX(updated_at, NEW.created_at)
  WHERE project_id = NEW.project_id
    AND canvas_id = NEW.canvas_id
    AND ledger_kind = '${spec.kind}';

  SELECT CASE WHEN (
    SELECT COALESCE(SUM(usage.row_count), 0) > policy.max_rows
    FROM canvas_permanent_ledger_policies policy
    JOIN canvas_permanent_ledger_usage usage
      ON usage.project_id = policy.project_id AND usage.canvas_id = policy.canvas_id
    WHERE policy.project_id = NEW.project_id AND policy.canvas_id = NEW.canvas_id
  ) THEN RAISE(ABORT, 'permanent operation ledger row capacity exceeded') END;

  SELECT CASE WHEN (
    SELECT COALESCE(SUM(usage.logical_bytes), 0) > policy.max_bytes
    FROM canvas_permanent_ledger_policies policy
    JOIN canvas_permanent_ledger_usage usage
      ON usage.project_id = policy.project_id AND usage.canvas_id = policy.canvas_id
    WHERE policy.project_id = NEW.project_id AND policy.canvas_id = NEW.canvas_id
  ) THEN RAISE(ABORT, 'permanent operation ledger byte capacity exceeded') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_permanent_ledger_${triggerStem}_immutable_update
BEFORE UPDATE ON ${spec.table}
BEGIN
  SELECT RAISE(ABORT, 'permanent operation ledger evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_permanent_ledger_${triggerStem}_delete_guard
BEFORE DELETE ON ${spec.table}
WHEN EXISTS (
  SELECT 1 FROM canvas_documents document
  WHERE document.project_id = OLD.project_id AND document.canvas_id = OLD.canvas_id
)
BEGIN
  SELECT RAISE(ABORT, 'permanent operation ledger evidence cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_permanent_ledger_${triggerStem}_account_delete
AFTER DELETE ON ${spec.table}
BEGIN
  UPDATE canvas_permanent_ledger_usage
  SET row_count = row_count - 1,
      logical_bytes = logical_bytes - (
        ${bytesOld}
      ),
      updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE project_id = OLD.project_id
    AND canvas_id = OLD.canvas_id
    AND ledger_kind = '${spec.kind}';
END;
`;
}).join('\n');

const UP_SQL = String.raw`
CREATE TABLE IF NOT EXISTS canvas_permanent_ledger_policies (
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 240),
  canvas_id TEXT NOT NULL CHECK(length(canvas_id) BETWEEN 1 AND 240),
  max_rows INTEGER NOT NULL CHECK(max_rows >= 1),
  max_bytes INTEGER NOT NULL CHECK(max_bytes >= 1),
  pressure_state TEXT NOT NULL CHECK(pressure_state IN ('normal', 'over-capacity')),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  PRIMARY KEY(project_id, canvas_id),
  FOREIGN KEY(canvas_id)
    REFERENCES canvas_documents(canvas_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS canvas_permanent_ledger_usage (
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 240),
  canvas_id TEXT NOT NULL CHECK(length(canvas_id) BETWEEN 1 AND 240),
  ledger_kind TEXT NOT NULL CHECK(ledger_kind IN (${ledgerKindsSql})),
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  logical_bytes INTEGER NOT NULL CHECK(logical_bytes >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  PRIMARY KEY(project_id, canvas_id, ledger_kind),
  FOREIGN KEY(canvas_id)
    REFERENCES canvas_documents(canvas_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) WITHOUT ROWID;

CREATE VIEW IF NOT EXISTS canvas_permanent_ledger_totals AS
SELECT
  policy.project_id,
  policy.canvas_id,
  policy.max_rows,
  policy.max_bytes,
  COALESCE(SUM(usage.row_count), 0) AS total_rows,
  COALESCE(SUM(usage.logical_bytes), 0) AS total_bytes,
  policy.pressure_state,
  MAX(policy.updated_at, COALESCE(MAX(usage.updated_at), 0)) AS updated_at
FROM canvas_permanent_ledger_policies policy
LEFT JOIN canvas_permanent_ledger_usage usage
  ON usage.project_id = policy.project_id AND usage.canvas_id = policy.canvas_id
GROUP BY policy.project_id, policy.canvas_id;

CREATE TRIGGER IF NOT EXISTS trg_permanent_ledger_policy_scope_insert
BEFORE INSERT ON canvas_permanent_ledger_policies
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM canvas_documents document
    WHERE document.project_id = NEW.project_id AND document.canvas_id = NEW.canvas_id
  ) THEN RAISE(ABORT, 'permanent operation ledger policy project mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_permanent_ledger_policy_scope_update
BEFORE UPDATE OF project_id, canvas_id ON canvas_permanent_ledger_policies
BEGIN
  SELECT RAISE(ABORT, 'permanent operation ledger policy scope is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_permanent_ledger_policy_delete_guard
BEFORE DELETE ON canvas_permanent_ledger_policies
WHEN EXISTS (
  SELECT 1 FROM canvas_documents document
  WHERE document.project_id = OLD.project_id AND document.canvas_id = OLD.canvas_id
)
BEGIN
  SELECT RAISE(ABORT, 'permanent operation ledger policy cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_permanent_ledger_usage_scope_insert
BEFORE INSERT ON canvas_permanent_ledger_usage
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM canvas_documents document
    WHERE document.project_id = NEW.project_id AND document.canvas_id = NEW.canvas_id
  ) THEN RAISE(ABORT, 'permanent operation ledger usage project mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_permanent_ledger_usage_scope_update
BEFORE UPDATE OF project_id, canvas_id, ledger_kind ON canvas_permanent_ledger_usage
BEGIN
  SELECT RAISE(ABORT, 'permanent operation ledger usage scope is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_permanent_ledger_usage_delete_guard
BEFORE DELETE ON canvas_permanent_ledger_usage
WHEN EXISTS (
  SELECT 1 FROM canvas_documents document
  WHERE document.project_id = OLD.project_id AND document.canvas_id = OLD.canvas_id
)
BEGIN
  SELECT RAISE(ABORT, 'permanent operation ledger usage cannot be deleted');
END;

${ledgerTriggerSql}
`;

const perLedgerTriggerNames = ledgerSpecs.flatMap((spec) => {
  const stem = spec.kind.replace(/-/g, '_');
  return [
    `trg_permanent_ledger_${stem}_state_insert`,
    `trg_permanent_ledger_${stem}_account_insert`,
    `trg_permanent_ledger_${stem}_immutable_update`,
    `trg_permanent_ledger_${stem}_delete_guard`,
    `trg_permanent_ledger_${stem}_account_delete`,
  ];
});

const ownedObjects = Object.freeze({
  tables: Object.freeze([
    'canvas_permanent_ledger_policies',
    'canvas_permanent_ledger_usage',
  ]),
  indexes: Object.freeze([]),
  views: Object.freeze(['canvas_permanent_ledger_totals']),
  triggers: Object.freeze([
    'trg_permanent_ledger_policy_scope_insert',
    'trg_permanent_ledger_policy_scope_update',
    'trg_permanent_ledger_policy_delete_guard',
    'trg_permanent_ledger_usage_scope_insert',
    'trg_permanent_ledger_usage_scope_update',
    'trg_permanent_ledger_usage_delete_guard',
    ...perLedgerTriggerNames,
  ]),
});

const ownedObjectNames = Object.freeze([
  ...ownedObjects.tables,
  ...ownedObjects.indexes,
  ...ownedObjects.views,
  ...ownedObjects.triggers,
]);

const DOWN_SQL = String.raw`
${[...ownedObjects.triggers].reverse().map((name) => `DROP TRIGGER IF EXISTS ${name};`).join('\n')}
DROP VIEW IF EXISTS canvas_permanent_ledger_totals;
DROP TABLE IF EXISTS canvas_permanent_ledger_usage;
DROP TABLE IF EXISTS canvas_permanent_ledger_policies;
`;

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
  PROJECT_DATABASE_MIGRATION_30: definition,
  PROJECT_DATABASE_MIGRATION_30_UP_SQL: UP_SQL,
  PROJECT_DATABASE_MIGRATION_30_DOWN_SQL: DOWN_SQL,
  PROJECT_DATABASE_MIGRATION_30_IMPERATIVE_CONTRACT: imperativeContract,
  PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES: ownedObjectNames,
  PROJECT_DATABASE_SCHEMA_30_EXTENSION_FINGERPRINT: EXTENSION_FINGERPRINT,
  PROJECT_DATABASE_PERMANENT_LEDGER_SPECS: ledgerSpecs,
  projectDatabasePermanentLedgerLogicalBytesSql: logicalBytesSql,
});
