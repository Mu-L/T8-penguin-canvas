'use strict';

const { createHash } = require('node:crypto');

const VERSION = 31;
const FROM_VERSION = 30;
const NAME = 'bounded-durable-ledgers';
const DOWN_POLICY = 'backup-only';
const COMPONENT_CHECKSUM_CANONICALIZATION = 't8-project-database-migration-31-component-v1';

const defaults = Object.freeze({
  projectMaxRows: 500_000,
  projectMaxBytes: 512 * 1024 * 1024,
  databaseMaxRows: 2_000_000,
  databaseMaxBytes: 2 * 1024 * 1024 * 1024,
  maxRowBytesByKind: Object.freeze({
    'audit-event': 256 * 1024,
    'run-event': 1024 * 1024,
    'run-output-commit': 64 * 1024,
    'run-output-slot-reservation': 32 * 1024,
  }),
});

const freezeError = (definition) => Object.freeze({ ...definition });

// sqliteMessage is part of the trigger ABI. The aggregation layer translates
// it to the frozen public code/status without relying on driver-specific text.
const errors = Object.freeze({
  recordTooLarge: freezeError({
    code: 'durable_ledger_record_too_large',
    status: 413,
    sqliteMessage: 'durable ledger record too large',
    publicMessage: '持久台账单条记录超过硬限制',
  }),
  projectCapacity: freezeError({
    code: 'project_durable_ledger_capacity_exceeded',
    status: 507,
    sqliteMessage: 'project durable ledger capacity exceeded',
    publicMessage: '项目持久台账容量已满',
  }),
  databaseCapacity: freezeError({
    code: 'database_durable_ledger_capacity_exceeded',
    status: 507,
    sqliteMessage: 'database durable ledger capacity exceeded',
    publicMessage: '项目数据库持久台账总容量已满',
  }),
  stateInvalid: freezeError({
    code: 'durable_ledger_state_invalid',
    status: 500,
    sqliteMessage: 'durable ledger state missing',
    publicMessage: '持久台账容量状态缺失或损坏',
  }),
  scopeMismatch: freezeError({
    code: 'durable_ledger_scope_mismatch',
    status: 409,
    sqliteMessage: 'durable ledger scope mismatch',
    publicMessage: '持久台账记录作用域不匹配',
  }),
  immutable: freezeError({
    code: 'durable_ledger_evidence_immutable',
    status: 409,
    sqliteMessage: 'durable ledger evidence is immutable',
    publicMessage: '持久台账证据不可修改',
  }),
  directDelete: freezeError({
    code: 'durable_ledger_direct_delete_forbidden',
    status: 409,
    sqliteMessage: 'durable ledger evidence cannot be deleted directly',
    publicMessage: '持久台账证据不能直接删除',
  }),
});

const freezeLedgerSpec = (spec) => Object.freeze({
  ...spec,
  accountingTable: spec.accountingTable || spec.table,
  textColumns: Object.freeze([...spec.textColumns]),
  integerColumns: Object.freeze([...spec.integerColumns]),
});

// Logical bytes deliberately exclude SQLite page/WAL overhead. Every present
// TEXT/JSON field contributes its exact UTF-8 byte length and every present
// INTEGER contributes eight bytes. These frozen lists must drive migration
// backfill, runtime triggers, preflight reservation, and cold-open verification.
const ledgerSpecs = Object.freeze([
  freezeLedgerSpec({
    kind: 'audit-event',
    table: 'audit_events',
    scopeMode: 'optional-canvas',
    deleteMode: 'retained',
    maxRowBytes: defaults.maxRowBytesByKind['audit-event'],
    textColumns: [
      'mutation_uid', 'project_id', 'canvas_id', 'actor_id', 'session_id', 'action',
      'target_type', 'target_id', 'metadata_json',
    ],
    integerColumns: ['id', 'created_at'],
  }),
  freezeLedgerSpec({
    kind: 'run-event',
    table: 'run_events',
    accountingTable: 'run_event_durable_bindings',
    scopeMode: 'run-parent',
    deleteMode: 'authoritative-cascade',
    maxRowBytes: defaults.maxRowBytesByKind['run-event'],
    textColumns: [
      'entity_uid', 'project_id', 'run_id', 'node_run_id', 'type', 'payload_json',
    ],
    integerColumns: ['id', 'created_at'],
  }),
  freezeLedgerSpec({
    kind: 'run-output-commit',
    table: 'run_output_commits',
    scopeMode: 'host-output-parents',
    deleteMode: 'authoritative-cascade',
    maxRowBytes: defaults.maxRowBytesByKind['run-output-commit'],
    textColumns: [
      'op_id', 'batch_id', 'project_id', 'canvas_id', 'run_id', 'run_entity_uid',
      'node_run_id', 'node_run_entity_uid', 'attempt_id', 'attempt_entity_uid',
      'node_entity_uid', 'asset_id', 'asset_entity_uid', 'blob_id', 'blob_entity_uid',
      'kind', 'content_hash', 'source_descriptor_digest', 'filename', 'mime_type',
      'event_entity_uid',
    ],
    integerColumns: [
      'operation_index', 'canvas_revision', 'output_ordinal', 'asset_revision',
      'run_revision_before', 'run_revision_after', 'node_run_revision_before',
      'node_run_revision_after', 'attempt_revision_before', 'attempt_revision_after',
      'byte_size', 'created_at',
    ],
  }),
  freezeLedgerSpec({
    kind: 'run-output-slot-reservation',
    table: 'run_output_slot_reservations',
    scopeMode: 'stable-output-slot',
    deleteMode: 'retained',
    maxRowBytes: defaults.maxRowBytesByKind['run-output-slot-reservation'],
    textColumns: [
      'attempt_entity_uid', 'project_id', 'canvas_id', 'run_id', 'run_entity_uid',
      'node_run_id', 'node_run_entity_uid', 'attempt_id', 'node_entity_uid', 'asset_id',
      'asset_entity_uid', 'content_hash', 'source_descriptor_digest', 'reservation_state',
      'evidence_source', 'evidence_digest',
    ],
    integerColumns: ['output_ordinal', 'evidence_count', 'created_at'],
  }),
]);

const LEDGER_KIND_COUNT = ledgerSpecs.length;
const ledgerKindsSql = ledgerSpecs.map((spec) => `'${spec.kind}'`).join(', ');
const ledgerKindsValuesSql = ledgerSpecs.map((spec) => `('${spec.kind}')`).join(', ');

function logicalBytesSql(spec, alias = null, columnExpressions = {}) {
  const prefix = alias ? `${alias}.` : '';
  const textParts = spec.textColumns.map((column) => (
    `COALESCE(length(CAST(${columnExpressions[column] || `${prefix}${column}`} AS BLOB)), 0)`
  ));
  const integerParts = spec.integerColumns.map((column) => (
    `CASE WHEN ${columnExpressions[column] || `${prefix}${column}`} IS NULL THEN 0 ELSE 8 END`
  ));
  return [...textParts, ...integerParts].join('\n      + ') || '0';
}

function logicalBytes(spec, row = {}) {
  let total = 0;
  for (const column of spec.textColumns) {
    if (row[column] != null) total += Buffer.byteLength(String(row[column]), 'utf8');
  }
  for (const column of spec.integerColumns) {
    if (row[column] != null) total += 8;
  }
  return total;
}

const runEventSpec = ledgerSpecs.find((spec) => spec.kind === 'run-event');
const runEventLogicalBytesSql = logicalBytesSql(runEventSpec, 'event', {
  project_id: 'run.project_id',
});

// Never ALTER run_events: it is part of the frozen schema-28 base descriptor
// used recursively by the v28->v30 lineage verifier. Schema 31 binds the
// derived project and exact byte count in a new owned 1:1 child table instead.
const runEventBindings = Object.freeze({
  table: 'run_event_durable_bindings',
  sourceTable: 'run_events',
  backfillSql: String.raw`
INSERT OR IGNORE INTO run_event_durable_bindings(
  event_id, project_id, logical_bytes, created_at
)
SELECT
  event.id,
  run.project_id,
  ${runEventLogicalBytesSql},
  event.created_at
FROM run_events event
JOIN runs run ON run.id = event.run_id;
`.trim(),
  validateSql: String.raw`
SELECT COUNT(*) AS invalid_count
FROM (
  SELECT event.id
  FROM run_events event
  LEFT JOIN runs run ON run.id = event.run_id
  LEFT JOIN run_event_durable_bindings binding ON binding.event_id = event.id
  WHERE binding.event_id IS NULL
     OR run.id IS NULL
     OR binding.project_id <> run.project_id
     OR binding.logical_bytes <> (${runEventLogicalBytesSql})
     OR binding.created_at <> event.created_at
  UNION ALL
  SELECT binding.event_id
  FROM run_event_durable_bindings binding
  LEFT JOIN run_events event ON event.id = binding.event_id
  WHERE event.id IS NULL
) invalid;
`.trim(),
  validateRowsSql: String.raw`
SELECT
  'event-binding-mismatch' AS issue_type,
  event.id,
  event.run_id,
  run.project_id AS run_project_id,
  binding.project_id AS binding_project_id,
  (${runEventLogicalBytesSql}) AS expected_logical_bytes,
  binding.logical_bytes AS binding_logical_bytes,
  event.created_at AS event_created_at,
  binding.created_at AS binding_created_at
FROM run_events event
LEFT JOIN runs run ON run.id = event.run_id
LEFT JOIN run_event_durable_bindings binding ON binding.event_id = event.id
WHERE binding.event_id IS NULL
   OR run.id IS NULL
   OR binding.project_id <> run.project_id
   OR binding.logical_bytes <> (${runEventLogicalBytesSql})
   OR binding.created_at <> event.created_at
UNION ALL
SELECT
  'orphan-binding' AS issue_type,
  binding.event_id AS id,
  NULL AS run_id,
  NULL AS run_project_id,
  binding.project_id AS binding_project_id,
  NULL AS expected_logical_bytes,
  binding.logical_bytes AS binding_logical_bytes,
  NULL AS event_created_at,
  binding.created_at AS binding_created_at
FROM run_event_durable_bindings binding
LEFT JOIN run_events event ON event.id = binding.event_id
WHERE event.id IS NULL
ORDER BY id ASC
LIMIT 100;
`.trim(),
});

const stateTableGuardNames = Object.freeze([
  'trg_project_durable_ledger_policy_scope_update',
  'trg_project_durable_ledger_policy_delete_guard',
  'trg_project_durable_ledger_usage_scope_insert',
  'trg_project_durable_ledger_usage_identity_update',
  'trg_project_durable_ledger_usage_delete_guard',
  'trg_database_durable_ledger_policy_identity_update',
  'trg_database_durable_ledger_policy_delete_guard',
  'trg_database_durable_ledger_usage_scope_insert',
  'trg_database_durable_ledger_usage_identity_update',
  'trg_database_durable_ledger_usage_delete_guard',
]);

const projectHasEvidenceSql = ledgerSpecs
  .map((spec) => `EXISTS (SELECT 1 FROM ${spec.accountingTable} row WHERE row.project_id = OLD.project_id)`)
  .join('\n    OR ');

const CREATE_STATE_SQL = String.raw`
CREATE TABLE IF NOT EXISTS project_durable_ledger_policies (
  project_id TEXT PRIMARY KEY
    CHECK(length(project_id) BETWEEN 1 AND 240),
  max_rows INTEGER NOT NULL CHECK(max_rows >= 1),
  max_bytes INTEGER NOT NULL CHECK(max_bytes >= 1),
  pressure_state TEXT NOT NULL CHECK(pressure_state IN ('normal', 'over-capacity')),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS project_durable_ledger_usage (
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 240),
  ledger_kind TEXT NOT NULL CHECK(ledger_kind IN (${ledgerKindsSql})),
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  logical_bytes INTEGER NOT NULL CHECK(logical_bytes >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  PRIMARY KEY(project_id, ledger_kind),
  FOREIGN KEY(project_id)
    REFERENCES project_durable_ledger_policies(project_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS database_durable_ledger_policy (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  max_rows INTEGER NOT NULL CHECK(max_rows >= 1),
  max_bytes INTEGER NOT NULL CHECK(max_bytes >= 1),
  pressure_state TEXT NOT NULL CHECK(pressure_state IN ('normal', 'over-capacity')),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
);

CREATE TABLE IF NOT EXISTS database_durable_ledger_usage (
  singleton_id INTEGER NOT NULL CHECK(singleton_id = 1),
  ledger_kind TEXT NOT NULL CHECK(ledger_kind IN (${ledgerKindsSql})),
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  logical_bytes INTEGER NOT NULL CHECK(logical_bytes >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  PRIMARY KEY(singleton_id, ledger_kind),
  FOREIGN KEY(singleton_id)
    REFERENCES database_durable_ledger_policy(singleton_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS run_event_durable_bindings (
  event_id INTEGER PRIMARY KEY CHECK(event_id >= 1),
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 240),
  logical_bytes INTEGER NOT NULL CHECK(logical_bytes >= 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  FOREIGN KEY(event_id)
    REFERENCES run_events(id)
    ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_run_event_durable_bindings_project
  ON run_event_durable_bindings(project_id, event_id);

CREATE VIEW IF NOT EXISTS project_durable_ledger_totals AS
SELECT
  policy.project_id,
  policy.max_rows,
  policy.max_bytes,
  COALESCE(SUM(usage.row_count), 0) AS total_rows,
  COALESCE(SUM(usage.logical_bytes), 0) AS total_bytes,
  policy.pressure_state,
  MAX(policy.updated_at, COALESCE(MAX(usage.updated_at), 0)) AS updated_at
FROM project_durable_ledger_policies policy
LEFT JOIN project_durable_ledger_usage usage
  ON usage.project_id = policy.project_id
GROUP BY policy.project_id;

CREATE VIEW IF NOT EXISTS database_durable_ledger_totals AS
SELECT
  policy.singleton_id,
  policy.max_rows,
  policy.max_bytes,
  COALESCE(SUM(usage.row_count), 0) AS total_rows,
  COALESCE(SUM(usage.logical_bytes), 0) AS total_bytes,
  policy.pressure_state,
  MAX(policy.updated_at, COALESCE(MAX(usage.updated_at), 0)) AS updated_at
FROM database_durable_ledger_policy policy
LEFT JOIN database_durable_ledger_usage usage
  ON usage.singleton_id = policy.singleton_id
GROUP BY policy.singleton_id;

CREATE TRIGGER IF NOT EXISTS trg_project_durable_ledger_policy_scope_update
BEFORE UPDATE OF project_id ON project_durable_ledger_policies
BEGIN
  SELECT RAISE(ABORT, '${errors.stateInvalid.sqliteMessage}');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_durable_ledger_policy_delete_guard
BEFORE DELETE ON project_durable_ledger_policies
WHEN ${projectHasEvidenceSql}
BEGIN
  SELECT RAISE(ABORT, '${errors.stateInvalid.sqliteMessage}');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_durable_ledger_usage_scope_insert
BEFORE INSERT ON project_durable_ledger_usage
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM project_durable_ledger_policies policy
    WHERE policy.project_id = NEW.project_id
  ) THEN RAISE(ABORT, '${errors.stateInvalid.sqliteMessage}') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_durable_ledger_usage_identity_update
BEFORE UPDATE OF project_id, ledger_kind ON project_durable_ledger_usage
BEGIN
  SELECT RAISE(ABORT, '${errors.stateInvalid.sqliteMessage}');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_durable_ledger_usage_delete_guard
BEFORE DELETE ON project_durable_ledger_usage
WHEN EXISTS (
  SELECT 1 FROM project_durable_ledger_policies policy
  WHERE policy.project_id = OLD.project_id
)
BEGIN
  SELECT RAISE(ABORT, '${errors.stateInvalid.sqliteMessage}');
END;

CREATE TRIGGER IF NOT EXISTS trg_database_durable_ledger_policy_identity_update
BEFORE UPDATE OF singleton_id ON database_durable_ledger_policy
BEGIN
  SELECT RAISE(ABORT, '${errors.stateInvalid.sqliteMessage}');
END;

CREATE TRIGGER IF NOT EXISTS trg_database_durable_ledger_policy_delete_guard
BEFORE DELETE ON database_durable_ledger_policy
BEGIN
  SELECT RAISE(ABORT, '${errors.stateInvalid.sqliteMessage}');
END;

CREATE TRIGGER IF NOT EXISTS trg_database_durable_ledger_usage_scope_insert
BEFORE INSERT ON database_durable_ledger_usage
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM database_durable_ledger_policy policy
    WHERE policy.singleton_id = NEW.singleton_id
  ) THEN RAISE(ABORT, '${errors.stateInvalid.sqliteMessage}') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_database_durable_ledger_usage_identity_update
BEFORE UPDATE OF singleton_id, ledger_kind ON database_durable_ledger_usage
BEGIN
  SELECT RAISE(ABORT, '${errors.stateInvalid.sqliteMessage}');
END;

CREATE TRIGGER IF NOT EXISTS trg_database_durable_ledger_usage_delete_guard
BEFORE DELETE ON database_durable_ledger_usage
WHEN EXISTS (
  SELECT 1 FROM database_durable_ledger_policy policy
  WHERE policy.singleton_id = OLD.singleton_id
)
BEGIN
  SELECT RAISE(ABORT, '${errors.stateInvalid.sqliteMessage}');
END;
`;

const INITIALIZE_GLOBAL_STATE_SQL = String.raw`
INSERT OR IGNORE INTO database_durable_ledger_policy(
  singleton_id, max_rows, max_bytes, pressure_state, updated_at
) VALUES (
  1, ${defaults.databaseMaxRows}, ${defaults.databaseMaxBytes}, 'normal',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

WITH ledger_kinds(ledger_kind) AS (VALUES ${ledgerKindsValuesSql})
INSERT OR IGNORE INTO database_durable_ledger_usage(
  singleton_id, ledger_kind, row_count, logical_bytes, updated_at
)
SELECT
  1, ledger_kind, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM ledger_kinds;
`;

const INITIALIZE_PROJECT_POLICY_SQL = String.raw`
INSERT OR IGNORE INTO project_durable_ledger_policies(
  project_id, max_rows, max_bytes, pressure_state, updated_at
) VALUES (
  @projectId, ${defaults.projectMaxRows}, ${defaults.projectMaxBytes}, 'normal', @updatedAt
);
`;

const INITIALIZE_PROJECT_USAGE_SQL = String.raw`
WITH ledger_kinds(ledger_kind) AS (VALUES ${ledgerKindsValuesSql})
INSERT OR IGNORE INTO project_durable_ledger_usage(
  project_id, ledger_kind, row_count, logical_bytes, updated_at
)
SELECT @projectId, ledger_kind, 0, 0, @updatedAt
FROM ledger_kinds;
`;

const projectIdsSql = [
  'SELECT project_id FROM canvas_documents',
  'SELECT project_id FROM runs',
  ...ledgerSpecs.map((spec) => `SELECT project_id FROM ${spec.accountingTable}`),
].join('\n  UNION\n  ');

const projectRowsCaseSql = ledgerSpecs.map((spec) => String.raw`
    WHEN '${spec.kind}' THEN (
      SELECT COUNT(*) FROM ${spec.accountingTable} source
      WHERE source.project_id = project_durable_ledger_usage.project_id
    )`).join('');
const projectBytesCaseSql = ledgerSpecs.map((spec) => String.raw`
    WHEN '${spec.kind}' THEN COALESCE((
      SELECT SUM(${spec.kind === 'run-event' ? 'source.logical_bytes' : logicalBytesSql(spec, 'source')})
      FROM ${spec.accountingTable} source
      WHERE source.project_id = project_durable_ledger_usage.project_id
    ), 0)`).join('');
const databaseRowsCaseSql = ledgerSpecs.map((spec) => String.raw`
    WHEN '${spec.kind}' THEN (SELECT COUNT(*) FROM ${spec.accountingTable})`).join('');
const databaseBytesCaseSql = ledgerSpecs.map((spec) => String.raw`
    WHEN '${spec.kind}' THEN COALESCE((
      SELECT SUM(${spec.kind === 'run-event' ? 'source.logical_bytes' : logicalBytesSql(spec, 'source')})
      FROM ${spec.accountingTable} source
    ), 0)`).join('');

// Execute only while holding the schema-31 migration write lock, after the
// run_events project column is backfilled/validated and before runtime guards
// are installed. Existing overage is preserved and marked; no evidence row is
// rewritten or deleted.
const BACKFILL_USAGE_SQL = String.raw`
${runEventBindings.backfillSql}

${INITIALIZE_GLOBAL_STATE_SQL}

WITH project_ids(project_id) AS (
  ${projectIdsSql}
)
INSERT OR IGNORE INTO project_durable_ledger_policies(
  project_id, max_rows, max_bytes, pressure_state, updated_at
)
SELECT DISTINCT
  project_id,
  ${defaults.projectMaxRows},
  ${defaults.projectMaxBytes},
  'normal',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM project_ids
WHERE project_id IS NOT NULL AND length(project_id) BETWEEN 1 AND 240;

WITH ledger_kinds(ledger_kind) AS (VALUES ${ledgerKindsValuesSql})
INSERT OR IGNORE INTO project_durable_ledger_usage(
  project_id, ledger_kind, row_count, logical_bytes, updated_at
)
SELECT
  policy.project_id,
  ledger_kinds.ledger_kind,
  0,
  0,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM project_durable_ledger_policies policy
CROSS JOIN ledger_kinds;

UPDATE project_durable_ledger_usage
SET row_count = CASE ledger_kind${projectRowsCaseSql}
      ELSE 0
    END,
    logical_bytes = CASE ledger_kind${projectBytesCaseSql}
      ELSE 0
    END,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000;

UPDATE database_durable_ledger_usage
SET row_count = CASE ledger_kind${databaseRowsCaseSql}
      ELSE 0
    END,
    logical_bytes = CASE ledger_kind${databaseBytesCaseSql}
      ELSE 0
    END,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE singleton_id = 1;

UPDATE project_durable_ledger_policies
SET pressure_state = CASE WHEN
      (SELECT COALESCE(SUM(usage.row_count), 0)
       FROM project_durable_ledger_usage usage
       WHERE usage.project_id = project_durable_ledger_policies.project_id) > max_rows
      OR
      (SELECT COALESCE(SUM(usage.logical_bytes), 0)
       FROM project_durable_ledger_usage usage
       WHERE usage.project_id = project_durable_ledger_policies.project_id) > max_bytes
    THEN 'over-capacity' ELSE 'normal' END,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000;

UPDATE database_durable_ledger_policy
SET pressure_state = CASE WHEN
      (SELECT COALESCE(SUM(usage.row_count), 0)
       FROM database_durable_ledger_usage usage
       WHERE usage.singleton_id = 1) > max_rows
      OR
      (SELECT COALESCE(SUM(usage.logical_bytes), 0)
       FROM database_durable_ledger_usage usage
       WHERE usage.singleton_id = 1) > max_bytes
    THEN 'over-capacity' ELSE 'normal' END,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE singleton_id = 1;
`;

function stateGateSql(spec, alias) {
  return String.raw`
  SELECT CASE WHEN (
    SELECT COUNT(*) FROM project_durable_ledger_policies policy
    WHERE policy.project_id = ${alias}.project_id
  ) <> 1
  OR (
    SELECT COUNT(*) FROM project_durable_ledger_usage usage
    WHERE usage.project_id = ${alias}.project_id
  ) <> ${LEDGER_KIND_COUNT}
  OR NOT EXISTS (
    SELECT 1 FROM project_durable_ledger_usage usage
    WHERE usage.project_id = ${alias}.project_id
      AND usage.ledger_kind = '${spec.kind}'
  )
  OR (
    SELECT COUNT(*) FROM database_durable_ledger_policy policy
    WHERE policy.singleton_id = 1
  ) <> 1
  OR (
    SELECT COUNT(*) FROM database_durable_ledger_usage usage
    WHERE usage.singleton_id = 1
  ) <> ${LEDGER_KIND_COUNT}
  OR NOT EXISTS (
    SELECT 1 FROM database_durable_ledger_usage usage
    WHERE usage.singleton_id = 1 AND usage.ledger_kind = '${spec.kind}'
  )
  THEN RAISE(ABORT, '${errors.stateInvalid.sqliteMessage}') END;`;
}

function scopeGateSql(spec) {
  if (spec.scopeMode === 'optional-canvas') {
    return String.raw`
  SELECT CASE WHEN NEW.canvas_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM canvas_documents document
    WHERE document.canvas_id = NEW.canvas_id
      AND document.project_id = NEW.project_id
  ) THEN RAISE(ABORT, '${errors.scopeMismatch.sqliteMessage}') END;`;
  }
  if (spec.scopeMode === 'run-parent') {
    return String.raw`
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM runs run
    WHERE run.id = NEW.run_id
  ) THEN RAISE(ABORT, '${errors.scopeMismatch.sqliteMessage}') END;
  SELECT CASE WHEN NEW.node_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM node_runs node_run
    WHERE node_run.id = NEW.node_run_id AND node_run.run_id = NEW.run_id
  ) THEN RAISE(ABORT, '${errors.scopeMismatch.sqliteMessage}') END;`;
  }
  if (spec.scopeMode === 'host-output-parents') {
    return String.raw`
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM canvas_documents document
    WHERE document.canvas_id = NEW.canvas_id AND document.project_id = NEW.project_id
  ) THEN RAISE(ABORT, '${errors.scopeMismatch.sqliteMessage}') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM collaboration_common_operation_batches batch
    WHERE batch.batch_id = NEW.batch_id
      AND batch.project_id = NEW.project_id AND batch.canvas_id = NEW.canvas_id
  ) THEN RAISE(ABORT, '${errors.scopeMismatch.sqliteMessage}') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM runs run
    WHERE run.id = NEW.run_id AND run.entity_uid = NEW.run_entity_uid
      AND run.project_id = NEW.project_id AND run.canvas_id = NEW.canvas_id
  ) THEN RAISE(ABORT, '${errors.scopeMismatch.sqliteMessage}') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM node_runs node_run
    WHERE node_run.id = NEW.node_run_id
      AND node_run.entity_uid = NEW.node_run_entity_uid
      AND node_run.run_id = NEW.run_id
      AND node_run.node_entity_uid = NEW.node_entity_uid
  ) THEN RAISE(ABORT, '${errors.scopeMismatch.sqliteMessage}') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM run_attempts attempt
    WHERE attempt.id = NEW.attempt_id
      AND attempt.entity_uid = NEW.attempt_entity_uid
      AND attempt.node_run_id = NEW.node_run_id
  ) THEN RAISE(ABORT, '${errors.scopeMismatch.sqliteMessage}') END;`;
  }
  return String.raw`
  SELECT CASE WHEN NEW.reservation_state <> 'host-verified'
    OR NEW.evidence_source <> 'host-commit'
    OR NEW.evidence_count <> 1
  THEN RAISE(ABORT, '${errors.scopeMismatch.sqliteMessage}') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM canvas_documents document
    WHERE document.canvas_id = NEW.canvas_id AND document.project_id = NEW.project_id
  ) THEN RAISE(ABORT, '${errors.scopeMismatch.sqliteMessage}') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM runs run
    WHERE run.id = NEW.run_id AND run.entity_uid = NEW.run_entity_uid
      AND run.project_id = NEW.project_id AND run.canvas_id = NEW.canvas_id
  ) THEN RAISE(ABORT, '${errors.scopeMismatch.sqliteMessage}') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM node_runs node_run
    WHERE node_run.id = NEW.node_run_id
      AND node_run.entity_uid = NEW.node_run_entity_uid
      AND node_run.run_id = NEW.run_id
      AND (NEW.node_entity_uid IS NULL OR node_run.node_entity_uid = NEW.node_entity_uid)
  ) THEN RAISE(ABORT, '${errors.scopeMismatch.sqliteMessage}') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM run_attempts attempt
    WHERE attempt.id = NEW.attempt_id
      AND attempt.entity_uid = NEW.attempt_entity_uid
      AND attempt.node_run_id = NEW.node_run_id
  ) THEN RAISE(ABORT, '${errors.scopeMismatch.sqliteMessage}') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM run_output_commits output_commit
    WHERE output_commit.attempt_entity_uid = NEW.attempt_entity_uid
      AND output_commit.output_ordinal = NEW.output_ordinal
      AND output_commit.project_id = NEW.project_id
      AND output_commit.canvas_id = NEW.canvas_id
      AND output_commit.run_id = NEW.run_id
      AND output_commit.run_entity_uid = NEW.run_entity_uid
      AND output_commit.node_run_id = NEW.node_run_id
      AND output_commit.node_run_entity_uid = NEW.node_run_entity_uid
      AND output_commit.attempt_id = NEW.attempt_id
      AND output_commit.node_entity_uid = NEW.node_entity_uid
      AND output_commit.asset_id = NEW.asset_id
      AND output_commit.asset_entity_uid = NEW.asset_entity_uid
      AND output_commit.content_hash = NEW.content_hash
      AND output_commit.source_descriptor_digest IS NEW.source_descriptor_digest
      AND output_commit.created_at = NEW.created_at
  ) THEN RAISE(ABORT, '${errors.scopeMismatch.sqliteMessage}') END;`;
}

function directDeleteGuardWhenSql(spec) {
  if (spec.deleteMode === 'retained') return null;
  if (spec.scopeMode === 'run-parent') {
    return String.raw`EXISTS (
  SELECT 1 FROM runs run
  WHERE run.id = OLD.run_id AND run.project_id = OLD.project_id
)`;
  }
  return String.raw`EXISTS (
  SELECT 1 FROM canvas_documents document
  WHERE document.canvas_id = OLD.canvas_id AND document.project_id = OLD.project_id
)
AND EXISTS (
  SELECT 1 FROM collaboration_common_operation_batches batch
  WHERE batch.batch_id = OLD.batch_id
    AND batch.project_id = OLD.project_id AND batch.canvas_id = OLD.canvas_id
)
AND EXISTS (
  SELECT 1 FROM runs run
  WHERE run.id = OLD.run_id AND run.entity_uid = OLD.run_entity_uid
    AND run.project_id = OLD.project_id AND run.canvas_id = OLD.canvas_id
)
AND EXISTS (
  SELECT 1 FROM node_runs node_run
  WHERE node_run.id = OLD.node_run_id
    AND node_run.entity_uid = OLD.node_run_entity_uid
    AND node_run.run_id = OLD.run_id
)
AND EXISTS (
  SELECT 1 FROM run_attempts attempt
  WHERE attempt.id = OLD.attempt_id
    AND attempt.entity_uid = OLD.attempt_entity_uid
    AND attempt.node_run_id = OLD.node_run_id
)`;
}

const runtimeTriggerNames = [];
const DIRECT_RUNTIME_GUARDS_SQL = ledgerSpecs
  .filter((spec) => spec.kind !== 'run-event')
  .map((spec) => {
  const stem = spec.kind.replace(/-/g, '_');
  const bytesNew = logicalBytesSql(spec, 'NEW');
  const bytesOld = logicalBytesSql(spec, 'OLD');
  const deleteGuardWhen = directDeleteGuardWhenSql(spec);
  runtimeTriggerNames.push(
    `trg_durable_ledger_${stem}_state_insert`,
    `trg_durable_ledger_${stem}_scope_insert`,
    `trg_durable_ledger_${stem}_account_gate_insert`,
    `trg_durable_ledger_${stem}_immutable_update`,
    `trg_durable_ledger_${stem}_state_delete`,
    `trg_durable_ledger_${stem}_direct_delete_guard`,
    `trg_durable_ledger_${stem}_account_delete`,
  );
  return String.raw`
CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_${stem}_state_insert
BEFORE INSERT ON ${spec.table}
BEGIN
${stateGateSql(spec, 'NEW')}
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_${stem}_scope_insert
BEFORE INSERT ON ${spec.table}
BEGIN
${scopeGateSql(spec)}
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_${stem}_account_gate_insert
AFTER INSERT ON ${spec.table}
BEGIN
  SELECT CASE WHEN (
    ${bytesNew}
  ) > ${spec.maxRowBytes}
  THEN RAISE(ABORT, '${errors.recordTooLarge.sqliteMessage}') END;

  UPDATE project_durable_ledger_usage
  SET row_count = row_count + 1,
      logical_bytes = logical_bytes + (${bytesNew}),
      updated_at = MAX(updated_at, NEW.created_at)
  WHERE project_id = NEW.project_id AND ledger_kind = '${spec.kind}';

  UPDATE database_durable_ledger_usage
  SET row_count = row_count + 1,
      logical_bytes = logical_bytes + (${bytesNew}),
      updated_at = MAX(updated_at, NEW.created_at)
  WHERE singleton_id = 1 AND ledger_kind = '${spec.kind}';

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM project_durable_ledger_policies policy
    WHERE policy.project_id = NEW.project_id
      AND (
        policy.pressure_state = 'over-capacity'
        OR (SELECT COALESCE(SUM(usage.row_count), 0)
            FROM project_durable_ledger_usage usage
            WHERE usage.project_id = NEW.project_id) > policy.max_rows
        OR (SELECT COALESCE(SUM(usage.logical_bytes), 0)
            FROM project_durable_ledger_usage usage
            WHERE usage.project_id = NEW.project_id) > policy.max_bytes
      )
  ) THEN RAISE(ABORT, '${errors.projectCapacity.sqliteMessage}') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM database_durable_ledger_policy policy
    WHERE policy.singleton_id = 1
      AND (
        policy.pressure_state = 'over-capacity'
        OR (SELECT COALESCE(SUM(usage.row_count), 0)
            FROM database_durable_ledger_usage usage
            WHERE usage.singleton_id = 1) > policy.max_rows
        OR (SELECT COALESCE(SUM(usage.logical_bytes), 0)
            FROM database_durable_ledger_usage usage
            WHERE usage.singleton_id = 1) > policy.max_bytes
      )
  ) THEN RAISE(ABORT, '${errors.databaseCapacity.sqliteMessage}') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_${stem}_immutable_update
BEFORE UPDATE ON ${spec.table}
BEGIN
  SELECT RAISE(ABORT, '${errors.immutable.sqliteMessage}');
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_${stem}_state_delete
BEFORE DELETE ON ${spec.table}
BEGIN
${stateGateSql(spec, 'OLD')}
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_${stem}_direct_delete_guard
BEFORE DELETE ON ${spec.table}
${deleteGuardWhen ? `WHEN ${deleteGuardWhen}` : ''}
BEGIN
  SELECT RAISE(ABORT, '${errors.directDelete.sqliteMessage}');
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_${stem}_account_delete
AFTER DELETE ON ${spec.table}
BEGIN
  UPDATE project_durable_ledger_usage
  SET row_count = row_count - 1,
      logical_bytes = logical_bytes - (${bytesOld}),
      updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE project_id = OLD.project_id AND ledger_kind = '${spec.kind}';

  UPDATE database_durable_ledger_usage
  SET row_count = row_count - 1,
      logical_bytes = logical_bytes - (${bytesOld}),
      updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE singleton_id = 1 AND ledger_kind = '${spec.kind}';

  UPDATE project_durable_ledger_policies
  SET pressure_state = CASE WHEN
        (SELECT COALESCE(SUM(usage.row_count), 0)
         FROM project_durable_ledger_usage usage
         WHERE usage.project_id = OLD.project_id) > max_rows
        OR
        (SELECT COALESCE(SUM(usage.logical_bytes), 0)
         FROM project_durable_ledger_usage usage
         WHERE usage.project_id = OLD.project_id) > max_bytes
      THEN 'over-capacity' ELSE 'normal' END,
      updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE project_id = OLD.project_id;

  UPDATE database_durable_ledger_policy
  SET pressure_state = CASE WHEN
        (SELECT COALESCE(SUM(usage.row_count), 0)
         FROM database_durable_ledger_usage usage
         WHERE usage.singleton_id = 1) > max_rows
        OR
        (SELECT COALESCE(SUM(usage.logical_bytes), 0)
         FROM database_durable_ledger_usage usage
         WHERE usage.singleton_id = 1) > max_bytes
      THEN 'over-capacity' ELSE 'normal' END,
      updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE singleton_id = 1;
END;
`;
  }).join('\n');

runtimeTriggerNames.push(
  'trg_durable_ledger_run_event_scope_insert',
  'trg_durable_ledger_run_event_bind_insert',
  'trg_durable_ledger_run_event_immutable_update',
  'trg_durable_ledger_run_event_direct_delete_guard',
  'trg_durable_ledger_run_event_binding_state_insert',
  'trg_durable_ledger_run_event_binding_scope_insert',
  'trg_durable_ledger_run_event_binding_account_gate_insert',
  'trg_durable_ledger_run_event_binding_immutable_update',
  'trg_durable_ledger_run_event_binding_state_delete',
  'trg_durable_ledger_run_event_binding_direct_delete_guard',
  'trg_durable_ledger_run_event_binding_account_delete',
);

const runEventNewLogicalBytesSql = logicalBytesSql(runEventSpec, 'NEW', {
  project_id: 'run.project_id',
});

const RUN_EVENT_RUNTIME_GUARDS_SQL = String.raw`
CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_run_event_scope_insert
BEFORE INSERT ON run_events
BEGIN
${scopeGateSql(runEventSpec)}
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_run_event_bind_insert
AFTER INSERT ON run_events
BEGIN
  INSERT INTO run_event_durable_bindings(
    event_id, project_id, logical_bytes, created_at
  )
  SELECT NEW.id, run.project_id, (${runEventNewLogicalBytesSql}), NEW.created_at
  FROM runs run
  WHERE run.id = NEW.run_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_run_event_immutable_update
BEFORE UPDATE ON run_events
BEGIN
  SELECT RAISE(ABORT, '${errors.immutable.sqliteMessage}');
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_run_event_direct_delete_guard
BEFORE DELETE ON run_events
WHEN EXISTS (SELECT 1 FROM runs run WHERE run.id = OLD.run_id)
BEGIN
  SELECT RAISE(ABORT, '${errors.directDelete.sqliteMessage}');
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_run_event_binding_state_insert
BEFORE INSERT ON run_event_durable_bindings
BEGIN
${stateGateSql(runEventSpec, 'NEW')}
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_run_event_binding_scope_insert
BEFORE INSERT ON run_event_durable_bindings
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM run_events event
    JOIN runs run ON run.id = event.run_id
    WHERE event.id = NEW.event_id
      AND run.project_id = NEW.project_id
      AND event.created_at = NEW.created_at
      AND NEW.logical_bytes = (${runEventLogicalBytesSql})
  ) THEN RAISE(ABORT, '${errors.scopeMismatch.sqliteMessage}') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_run_event_binding_account_gate_insert
AFTER INSERT ON run_event_durable_bindings
BEGIN
  SELECT CASE WHEN NEW.logical_bytes > ${runEventSpec.maxRowBytes}
  THEN RAISE(ABORT, '${errors.recordTooLarge.sqliteMessage}') END;

  UPDATE project_durable_ledger_usage
  SET row_count = row_count + 1,
      logical_bytes = logical_bytes + NEW.logical_bytes,
      updated_at = MAX(updated_at, NEW.created_at)
  WHERE project_id = NEW.project_id AND ledger_kind = '${runEventSpec.kind}';

  UPDATE database_durable_ledger_usage
  SET row_count = row_count + 1,
      logical_bytes = logical_bytes + NEW.logical_bytes,
      updated_at = MAX(updated_at, NEW.created_at)
  WHERE singleton_id = 1 AND ledger_kind = '${runEventSpec.kind}';

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM project_durable_ledger_policies policy
    WHERE policy.project_id = NEW.project_id
      AND (
        policy.pressure_state = 'over-capacity'
        OR (SELECT COALESCE(SUM(usage.row_count), 0)
            FROM project_durable_ledger_usage usage
            WHERE usage.project_id = NEW.project_id) > policy.max_rows
        OR (SELECT COALESCE(SUM(usage.logical_bytes), 0)
            FROM project_durable_ledger_usage usage
            WHERE usage.project_id = NEW.project_id) > policy.max_bytes
      )
  ) THEN RAISE(ABORT, '${errors.projectCapacity.sqliteMessage}') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM database_durable_ledger_policy policy
    WHERE policy.singleton_id = 1
      AND (
        policy.pressure_state = 'over-capacity'
        OR (SELECT COALESCE(SUM(usage.row_count), 0)
            FROM database_durable_ledger_usage usage
            WHERE usage.singleton_id = 1) > policy.max_rows
        OR (SELECT COALESCE(SUM(usage.logical_bytes), 0)
            FROM database_durable_ledger_usage usage
            WHERE usage.singleton_id = 1) > policy.max_bytes
      )
  ) THEN RAISE(ABORT, '${errors.databaseCapacity.sqliteMessage}') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_run_event_binding_immutable_update
BEFORE UPDATE ON run_event_durable_bindings
BEGIN
  SELECT RAISE(ABORT, '${errors.immutable.sqliteMessage}');
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_run_event_binding_state_delete
BEFORE DELETE ON run_event_durable_bindings
BEGIN
${stateGateSql(runEventSpec, 'OLD')}
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_run_event_binding_direct_delete_guard
BEFORE DELETE ON run_event_durable_bindings
WHEN EXISTS (SELECT 1 FROM run_events event WHERE event.id = OLD.event_id)
BEGIN
  SELECT RAISE(ABORT, '${errors.directDelete.sqliteMessage}');
END;

CREATE TRIGGER IF NOT EXISTS trg_durable_ledger_run_event_binding_account_delete
AFTER DELETE ON run_event_durable_bindings
BEGIN
  UPDATE project_durable_ledger_usage
  SET row_count = row_count - 1,
      logical_bytes = logical_bytes - OLD.logical_bytes,
      updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE project_id = OLD.project_id AND ledger_kind = '${runEventSpec.kind}';

  UPDATE database_durable_ledger_usage
  SET row_count = row_count - 1,
      logical_bytes = logical_bytes - OLD.logical_bytes,
      updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE singleton_id = 1 AND ledger_kind = '${runEventSpec.kind}';

  UPDATE project_durable_ledger_policies
  SET pressure_state = CASE WHEN
        (SELECT COALESCE(SUM(usage.row_count), 0)
         FROM project_durable_ledger_usage usage
         WHERE usage.project_id = OLD.project_id) > max_rows
        OR
        (SELECT COALESCE(SUM(usage.logical_bytes), 0)
         FROM project_durable_ledger_usage usage
         WHERE usage.project_id = OLD.project_id) > max_bytes
      THEN 'over-capacity' ELSE 'normal' END,
      updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE project_id = OLD.project_id;

  UPDATE database_durable_ledger_policy
  SET pressure_state = CASE WHEN
        (SELECT COALESCE(SUM(usage.row_count), 0)
         FROM database_durable_ledger_usage usage
         WHERE usage.singleton_id = 1) > max_rows
        OR
        (SELECT COALESCE(SUM(usage.logical_bytes), 0)
         FROM database_durable_ledger_usage usage
         WHERE usage.singleton_id = 1) > max_bytes
      THEN 'over-capacity' ELSE 'normal' END,
      updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE singleton_id = 1;
END;
`;

const RUNTIME_GUARDS_SQL = `${DIRECT_RUNTIME_GUARDS_SQL}\n${RUN_EVENT_RUNTIME_GUARDS_SQL}`;

const ownedObjects = Object.freeze({
  tables: Object.freeze([
    'project_durable_ledger_policies',
    'project_durable_ledger_usage',
    'database_durable_ledger_policy',
    'database_durable_ledger_usage',
    'run_event_durable_bindings',
  ]),
  indexes: Object.freeze(['idx_run_event_durable_bindings_project']),
  views: Object.freeze([
    'project_durable_ledger_totals',
    'database_durable_ledger_totals',
  ]),
  triggers: Object.freeze([
    ...stateTableGuardNames,
    ...runtimeTriggerNames,
  ]),
});

const ownedObjectNames = Object.freeze([
  ...ownedObjects.tables,
  ...ownedObjects.indexes,
  ...ownedObjects.views,
  ...ownedObjects.triggers,
]);

const DOWN_SQL = '';

const ddl = Object.freeze({
  createStateSql: CREATE_STATE_SQL,
  backfillUsageSql: BACKFILL_USAGE_SQL,
  runtimeGuardsSql: RUNTIME_GUARDS_SQL,
  downSql: DOWN_SQL,
});

const initializationSql = Object.freeze({
  globalStateSql: INITIALIZE_GLOBAL_STATE_SQL,
  projectPolicySql: INITIALIZE_PROJECT_POLICY_SQL,
  projectUsageSql: INITIALIZE_PROJECT_USAGE_SQL,
});

const imperativeContract = Object.freeze({
  format: 't8-project-database-migration-31-durable-ledgers-imperative-v1',
  byteModel: 'sum-present-text-json-utf8-bytes-plus-eight-per-present-integer',
  defaults,
  errors,
  ledgerKinds: Object.freeze(ledgerSpecs.map((spec) => Object.freeze({
    kind: spec.kind,
    table: spec.table,
    accountingTable: spec.accountingTable,
    maxRowBytes: spec.maxRowBytes,
    textColumns: spec.textColumns,
    integerColumns: spec.integerColumns,
    deleteMode: spec.deleteMode,
  }))),
  applicationOrder: Object.freeze([
    'create-project-database-policy-usage-and-run-event-binding-state',
    'backfill-and-validate-one-to-one-run-event-bindings',
    'recompute-existing-project-and-database-usage',
    'install-runtime-state-scope-row-capacity-accounting-and-delete-guards',
  ]),
  phases: Object.freeze([
    Object.freeze({
      id: 'locked-schema30-durable-ledger-gate',
      algorithmVersion: 'fingerprint-data-version-v1',
      invariants: Object.freeze([
        'acquire-immediate-before-component-ddl-or-backfill',
        'schema30-full-fingerprint-and-receipt-remain-exact',
        'frozen-schema28-base-tables-are-never-altered',
      ]),
    }),
    Object.freeze({
      id: 'bind-run-event-project-scope',
      algorithmVersion: 'authoritative-run-project-child-binding-v1',
      invariants: Object.freeze([
        'every-run-event-has-exactly-one-child-binding-and-no-orphan-binding-exists',
        'binding-project-and-logical-bytes-exactly-match-the-authoritative-run-and-event',
        'missing-or-mismatched-run-parent-fails-before-accounting',
      ]),
    }),
    Object.freeze({
      id: 'initialize-durable-ledger-accounting',
      algorithmVersion: 'four-kind-project-global-exact-accounting-v1',
      invariants: Object.freeze([
        'exactly-four-usage-rows-exist-per-project-and-for-the-database-singleton',
        'legacy-overage-is-preserved-and-marked-without-truncation-or-deletion',
        'logical-bytes-use-one-frozen-field-list-per-kind',
      ]),
    }),
    Object.freeze({
      id: 'install-durable-ledger-runtime-gates',
      algorithmVersion: 'row-project-global-trigger-backstop-v1',
      invariants: Object.freeze([
        'only-successful-new-inserts-consume-project-and-global-capacity',
        'row-project-or-global-overage-aborts-the-owning-business-transaction',
        'exact-replay-without-a-new-row-does-not-consume-capacity',
        'audit-and-slot-evidence-never-release-capacity',
        'new-slot-reservations-require-one-exact-host-commit-and-never-accept-legacy-states',
        'run-event-binding-and-output-commit-release-only-through-authoritative-cascade',
      ]),
    }),
    Object.freeze({
      id: 'post-backfill-durable-ledger-integrity',
      algorithmVersion: 'scope-accounting-fk-quick-v1',
      invariants: Object.freeze([
        'project-and-global-usage-exactly-match-all-four-authoritative-tables',
        'policy-state-and-frozen-defaults-are-valid',
        'foreign-key-check-is-empty-and-quick-check-is-ok',
      ]),
    }),
    Object.freeze({
      id: 'backup-only-lineage-commit',
      algorithmVersion: 'schema31-composed-receipt-v1',
      invariants: Object.freeze([
        'component-checksum-is-included-in-the-composed-schema31-receipt',
        'downgrade-restores-a-verified-schema30-backup-and-never-mutates-base-tables-in-place',
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
  downPolicy: DOWN_POLICY,
  defaults,
  errors,
  ledgerSpecs,
  runEventBindings,
  createStateSql: normalizeSql(CREATE_STATE_SQL),
  initializeGlobalStateSql: normalizeSql(INITIALIZE_GLOBAL_STATE_SQL),
  initializeProjectPolicySql: normalizeSql(INITIALIZE_PROJECT_POLICY_SQL),
  initializeProjectUsageSql: normalizeSql(INITIALIZE_PROJECT_USAGE_SQL),
  backfillUsageSql: normalizeSql(BACKFILL_USAGE_SQL),
  runtimeGuardsSql: normalizeSql(RUNTIME_GUARDS_SQL),
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
  checksumCanonicalization: COMPONENT_CHECKSUM_CANONICALIZATION,
  checksum,
  defaults,
  errors,
  ledgerSpecs,
  runEventBindings,
  ddl,
  initializationSql,
  ownedObjects,
  ownedObjectNames,
  imperativeContract,
});

module.exports = Object.freeze({
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGERS: definition,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_DEFAULTS: defaults,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_ERRORS: errors,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_SPECS: ledgerSpecs,
  PROJECT_DATABASE_MIGRATION_31_RUN_EVENT_DURABLE_BINDINGS: runEventBindings,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_DDL: ddl,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_CREATE_STATE_SQL: CREATE_STATE_SQL,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_BACKFILL_USAGE_SQL: BACKFILL_USAGE_SQL,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_RUNTIME_GUARDS_SQL: RUNTIME_GUARDS_SQL,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_INITIALIZATION_SQL: initializationSql,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS: ownedObjects,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECT_NAMES: ownedObjectNames,
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_IMPERATIVE_CONTRACT: imperativeContract,
  projectDatabaseDurableLedgerLogicalBytesSql: logicalBytesSql,
  projectDatabaseDurableLedgerLogicalBytes: logicalBytes,
});
