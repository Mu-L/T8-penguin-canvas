'use strict';

const { createHash } = require('node:crypto');

const VERSION = 29;
const FROM_VERSION = 28;
const NAME = 'bounded-history-evidence';
const DOWN_POLICY = 'empty-only';
const CHECKSUM_CANONICALIZATION = 't8-project-database-migration-v2';

// Schema 29 contains data migration work that cannot be expressed by DDL.
// Keep its ordered, reviewable contract in the same checksum domain as the
// SQL so one receipt can never describe two different backfill semantics.
const imperativeContract = Object.freeze({
  format: 't8-project-database-migration-29-imperative-v1',
  phases: Object.freeze([
    Object.freeze({
      id: 'locked-schema28-gate',
      algorithmVersion: 'fingerprint-data-version-v2',
      invariants: Object.freeze([
        'acquire-immediate-before-ddl',
        'backup-data-version-must-match-under-lock',
        'schema28-full-fingerprint-must-remain-exact',
      ]),
    }),
    Object.freeze({
      id: 'initialize-history-policy-usage',
      algorithmVersion: 'project-scoped-exact-accounting-v2',
      invariants: Object.freeze([
        'one-policy-and-usage-row-per-project-canvas',
        'snapshot-evidence-raw-pin-counts-and-bytes-are-exact',
        'preexisting-pin-overage-is-preserved-as-over-capacity',
      ]),
    }),
    Object.freeze({
      id: 'snapshot-pin-owner-backfill',
      algorithmVersion: 'project-scoped-owner-index-v3',
      invariants: Object.freeze([
        'owner-lookups-bind-project-canvas-and-snapshot-revision',
        'owner-scan-is-materialized-once-in-an-indexed-temp-table',
        'managed-owner-pin-set-is-exact-after-backfill',
      ]),
    }),
    Object.freeze({
      id: 'common-batch-keyset',
      algorithmVersion: 'batch-id-keyset-v1',
      invariants: Object.freeze([
        'common-batches-are-visited-once-in-primary-key-order',
        'each-operation-id-is-bound-to-its-ordered-batch-slot',
      ]),
    }),
    Object.freeze({
      id: 'domain-batch-classifier',
      algorithmVersion: 'review-host-base-subflow-advancing-v2',
      invariants: Object.freeze([
        'review-and-host-artifact-first-last-equal-base-revision',
        'subflow-first-is-base-plus-one-and-last-is-base-plus-operation-count',
        'domain-ledger-order-scope-principal-result-and-global-identity-are-exact',
      ]),
    }),
    Object.freeze({
      id: 'graph-evidence-binding',
      algorithmVersion: 'base-clientseq-actor-session-digest-timestamp-global-v5',
      invariants: Object.freeze([
        'raw-and-idempotency-base-revision-equal-common-batch-base-revision',
        'raw-and-idempotency-client-seq-equal-common-batch-client-seq-plus-index',
        'raw-and-idempotency-actor-session-equal-common-batch-principal',
        'raw-and-idempotency-created-at-match-and-become-the-exact-evidence-timestamp',
        'canvas-global-identity-has-null-domain-batch-and-exact-scope-type-digest',
        'revision-type-payload-digest-global-identity-and-common-batch-order-are-exact',
      ]),
    }),
    Object.freeze({
      id: 'post-backfill-integrity',
      algorithmVersion: 'accounting-owner-pins-fk-quick-v2',
      invariants: Object.freeze([
        'history-accounting-and-managed-owner-pins-are-recomputed-and-exact',
        'foreign-key-check-is-empty-and-quick-check-is-ok',
      ]),
    }),
    Object.freeze({
      id: 'lineage-receipt-commit',
      algorithmVersion: 'locked-fingerprint-mapping-v2',
      invariants: Object.freeze([
        'to-fingerprint-must-match-the-verified-from-to-lineage-map',
        'ledger-and-checksummed-receipt-commit-in-the-same-immediate-transaction',
      ]),
    }),
  ]),
});

const UP_SQL = String.raw`
CREATE TABLE IF NOT EXISTS schema_migration_receipts (
  version INTEGER PRIMARY KEY CHECK(version >= 1),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  checksum TEXT NOT NULL
    CHECK(length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  from_fingerprint TEXT NOT NULL
    CHECK(length(from_fingerprint) = 64 AND from_fingerprint NOT GLOB '*[^0-9a-f]*'),
  to_fingerprint TEXT NOT NULL
    CHECK(length(to_fingerprint) = 64 AND to_fingerprint NOT GLOB '*[^0-9a-f]*'),
  down_policy TEXT NOT NULL CHECK(length(down_policy) BETWEEN 1 AND 80),
  applied_at INTEGER NOT NULL CHECK(applied_at >= 1),
  FOREIGN KEY(version) REFERENCES schema_migrations(version) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS collaboration_common_graph_operation_evidence (
  batch_id TEXT NOT NULL CHECK(length(batch_id) BETWEEN 1 AND 240),
  operation_index INTEGER NOT NULL CHECK(operation_index BETWEEN 0 AND 499),
  op_id TEXT NOT NULL
    CHECK(
      length(op_id) BETWEEN 1 AND 240
      AND op_id NOT IN ('__proto__', 'prototype', 'constructor')
    ),
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 240),
  canvas_id TEXT NOT NULL CHECK(length(canvas_id) BETWEEN 1 AND 240),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  base_revision INTEGER NOT NULL CHECK(base_revision >= 0),
  actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 240),
  session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 240),
  client_seq INTEGER NOT NULL CHECK(client_seq >= 0),
  type TEXT NOT NULL CHECK(length(type) BETWEEN 1 AND 240),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_digest TEXT NOT NULL
    CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  logical_bytes INTEGER NOT NULL CHECK(logical_bytes >= 0),
  timestamp INTEGER NOT NULL CHECK(timestamp >= 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(batch_id, operation_index),
  UNIQUE(op_id),
  FOREIGN KEY(batch_id)
    REFERENCES collaboration_common_operation_batches(batch_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  FOREIGN KEY(canvas_id)
    REFERENCES canvas_documents(canvas_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_common_graph_operation_evidence_scope_revision
  ON collaboration_common_graph_operation_evidence(
    project_id,
    canvas_id,
    revision DESC,
    batch_id,
    operation_index
  );

CREATE INDEX IF NOT EXISTS idx_common_graph_operation_evidence_scope_created
  ON collaboration_common_graph_operation_evidence(
    project_id,
    canvas_id,
    created_at ASC,
    batch_id,
    operation_index
  );

CREATE TRIGGER IF NOT EXISTS trg_common_graph_operation_evidence_scope_insert
BEFORE INSERT ON collaboration_common_graph_operation_evidence
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM canvas_documents document
    WHERE document.canvas_id = NEW.canvas_id
      AND document.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'common graph operation evidence canvas scope mismatch') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM collaboration_common_operation_batches batch
    WHERE batch.batch_id = NEW.batch_id
      AND batch.project_id = NEW.project_id
      AND batch.canvas_id = NEW.canvas_id
      AND json_valid(batch.operation_ids_json)
      AND json_type(batch.operation_ids_json) = 'array'
      AND json_extract(
        batch.operation_ids_json,
        '$[' || CAST(NEW.operation_index AS TEXT) || ']'
      ) = NEW.op_id
  ) THEN RAISE(ABORT, 'common graph operation evidence batch scope mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_common_graph_operation_evidence_immutable
BEFORE UPDATE ON collaboration_common_graph_operation_evidence
BEGIN
  SELECT RAISE(ABORT, 'common graph operation evidence is immutable');
END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_snapshots_project_canvas_revision
  ON canvas_snapshots(project_id, canvas_id, revision);

CREATE TRIGGER IF NOT EXISTS trg_canvas_snapshots_project_insert_v29
BEFORE INSERT ON canvas_snapshots
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM canvas_documents document
    WHERE document.canvas_id = NEW.canvas_id
      AND document.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'canvas snapshot project mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_snapshots_project_update_v29
BEFORE UPDATE OF project_id, canvas_id ON canvas_snapshots
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM canvas_documents document
    WHERE document.canvas_id = NEW.canvas_id
      AND document.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'canvas snapshot project mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_snapshots_immutable_v29
BEFORE UPDATE ON canvas_snapshots
BEGIN
  SELECT RAISE(ABORT, 'canvas snapshots are immutable');
END;

CREATE TABLE IF NOT EXISTS canvas_snapshot_pins (
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 240),
  canvas_id TEXT NOT NULL CHECK(length(canvas_id) BETWEEN 1 AND 240),
  snapshot_revision INTEGER NOT NULL CHECK(snapshot_revision >= 0),
  pin_kind TEXT NOT NULL CHECK(length(pin_kind) BETWEEN 1 AND 80),
  owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 240),
  slot TEXT NOT NULL CHECK(length(slot) BETWEEN 1 AND 120),
  retention_class TEXT NOT NULL CHECK(length(retention_class) BETWEEN 1 AND 80),
  expires_at INTEGER CHECK(expires_at IS NULL OR expires_at >= 0),
  owner_state_digest TEXT
    CHECK(
      owner_state_digest IS NULL
      OR (
        length(owner_state_digest) = 64
        AND owner_state_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  PRIMARY KEY(project_id, canvas_id, pin_kind, owner_id, slot),
  FOREIGN KEY(canvas_id, snapshot_revision)
    REFERENCES canvas_snapshots(canvas_id, revision)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_canvas_snapshot_pins_revision
  ON canvas_snapshot_pins(
    project_id,
    canvas_id,
    snapshot_revision,
    retention_class,
    pin_kind,
    owner_id,
    slot
  );

CREATE INDEX IF NOT EXISTS idx_canvas_snapshot_pins_expiry
  ON canvas_snapshot_pins(project_id, canvas_id, expires_at, pin_kind, owner_id, slot)
  WHERE expires_at IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_canvas_snapshot_pins_scope_insert
BEFORE INSERT ON canvas_snapshot_pins
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM canvas_documents document
    WHERE document.canvas_id = NEW.canvas_id
      AND document.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'canvas snapshot pin project mismatch') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM canvas_snapshots snapshot
    WHERE snapshot.canvas_id = NEW.canvas_id
      AND snapshot.revision = NEW.snapshot_revision
      AND snapshot.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'canvas snapshot pin snapshot scope mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_snapshot_pins_scope_update
BEFORE UPDATE OF project_id, canvas_id, snapshot_revision ON canvas_snapshot_pins
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM canvas_documents document
    WHERE document.canvas_id = NEW.canvas_id
      AND document.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'canvas snapshot pin project mismatch') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM canvas_snapshots snapshot
    WHERE snapshot.canvas_id = NEW.canvas_id
      AND snapshot.revision = NEW.snapshot_revision
      AND snapshot.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'canvas snapshot pin snapshot scope mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_snapshot_pins_identity_immutable
BEFORE UPDATE OF project_id, canvas_id, snapshot_revision, pin_kind, owner_id, slot
ON canvas_snapshot_pins
BEGIN
  SELECT RAISE(ABORT, 'canvas snapshot pin identity is immutable');
END;

CREATE TABLE IF NOT EXISTS canvas_history_policies (
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 240),
  canvas_id TEXT NOT NULL CHECK(length(canvas_id) BETWEEN 1 AND 240),
  max_snapshot_rows INTEGER NOT NULL CHECK(max_snapshot_rows >= 0),
  max_snapshot_bytes INTEGER NOT NULL CHECK(max_snapshot_bytes >= 0),
  max_common_evidence_rows INTEGER NOT NULL CHECK(max_common_evidence_rows >= 0),
  max_common_evidence_bytes INTEGER NOT NULL CHECK(max_common_evidence_bytes >= 0),
  max_raw_operation_rows INTEGER NOT NULL CHECK(max_raw_operation_rows >= 0),
  max_raw_operation_bytes INTEGER NOT NULL CHECK(max_raw_operation_bytes >= 0),
  max_pin_rows INTEGER NOT NULL CHECK(max_pin_rows >= 0),
  pressure_state TEXT NOT NULL CHECK(length(pressure_state) BETWEEN 1 AND 80),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  PRIMARY KEY(project_id, canvas_id),
  FOREIGN KEY(canvas_id)
    REFERENCES canvas_documents(canvas_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS trg_canvas_history_policies_scope_insert
BEFORE INSERT ON canvas_history_policies
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM canvas_documents document
    WHERE document.canvas_id = NEW.canvas_id
      AND document.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'canvas history policy project mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_history_policies_scope_update
BEFORE UPDATE OF project_id, canvas_id ON canvas_history_policies
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM canvas_documents document
    WHERE document.canvas_id = NEW.canvas_id
      AND document.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'canvas history policy project mismatch') END;
END;

CREATE TABLE IF NOT EXISTS canvas_history_usage (
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 240),
  canvas_id TEXT NOT NULL CHECK(length(canvas_id) BETWEEN 1 AND 240),
  snapshot_rows INTEGER NOT NULL CHECK(snapshot_rows >= 0),
  snapshot_bytes INTEGER NOT NULL CHECK(snapshot_bytes >= 0),
  common_evidence_rows INTEGER NOT NULL CHECK(common_evidence_rows >= 0),
  common_evidence_bytes INTEGER NOT NULL CHECK(common_evidence_bytes >= 0),
  raw_operation_rows INTEGER NOT NULL CHECK(raw_operation_rows >= 0),
  raw_operation_bytes INTEGER NOT NULL CHECK(raw_operation_bytes >= 0),
  pin_rows INTEGER NOT NULL CHECK(pin_rows >= 0),
  pin_bytes INTEGER NOT NULL CHECK(pin_bytes >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  PRIMARY KEY(project_id, canvas_id),
  FOREIGN KEY(canvas_id)
    REFERENCES canvas_documents(canvas_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS trg_canvas_history_usage_scope_insert
BEFORE INSERT ON canvas_history_usage
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM canvas_documents document
    WHERE document.canvas_id = NEW.canvas_id
      AND document.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'canvas history usage project mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_history_usage_scope_update
BEFORE UPDATE OF project_id, canvas_id ON canvas_history_usage
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM canvas_documents document
    WHERE document.canvas_id = NEW.canvas_id
      AND document.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'canvas history usage project mismatch') END;
END;

CREATE VIEW IF NOT EXISTS canvas_snapshot_refcounts AS
SELECT
  project_id,
  canvas_id,
  snapshot_revision,
  COUNT(*) AS refcount,
  SUM(CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END) AS non_expiring_refcount,
  SUM(CASE WHEN expires_at IS NOT NULL THEN 1 ELSE 0 END) AS expiring_refcount,
  MIN(expires_at) AS next_expires_at,
  MAX(updated_at) AS updated_at
FROM canvas_snapshot_pins
GROUP BY project_id, canvas_id, snapshot_revision;

CREATE TRIGGER IF NOT EXISTS trg_canvas_history_usage_snapshot_insert
AFTER INSERT ON canvas_snapshots
BEGIN
  INSERT INTO canvas_history_usage(
    project_id,
    canvas_id,
    snapshot_rows,
    snapshot_bytes,
    common_evidence_rows,
    common_evidence_bytes,
    raw_operation_rows,
    raw_operation_bytes,
    pin_rows,
    pin_bytes,
    updated_at
  ) VALUES (
    NEW.project_id,
    NEW.canvas_id,
    1,
    length(CAST(NEW.snapshot_json AS BLOB)),
    0,
    0,
    0,
    0,
    0,
    0,
    NEW.created_at
  )
  ON CONFLICT(project_id, canvas_id) DO UPDATE SET
    snapshot_rows = canvas_history_usage.snapshot_rows + 1,
    snapshot_bytes = canvas_history_usage.snapshot_bytes + excluded.snapshot_bytes,
    updated_at = MAX(canvas_history_usage.updated_at, excluded.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_history_usage_snapshot_delete
AFTER DELETE ON canvas_snapshots
BEGIN
  UPDATE canvas_history_usage
  SET snapshot_rows = snapshot_rows - 1,
      snapshot_bytes = snapshot_bytes - length(CAST(OLD.snapshot_json AS BLOB)),
      updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE project_id = OLD.project_id AND canvas_id = OLD.canvas_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_history_usage_common_evidence_insert
AFTER INSERT ON collaboration_common_graph_operation_evidence
BEGIN
  INSERT INTO canvas_history_usage(
    project_id,
    canvas_id,
    snapshot_rows,
    snapshot_bytes,
    common_evidence_rows,
    common_evidence_bytes,
    raw_operation_rows,
    raw_operation_bytes,
    pin_rows,
    pin_bytes,
    updated_at
  ) VALUES (
    NEW.project_id,
    NEW.canvas_id,
    0,
    0,
    1,
    NEW.logical_bytes,
    0,
    0,
    0,
    0,
    NEW.created_at
  )
  ON CONFLICT(project_id, canvas_id) DO UPDATE SET
    common_evidence_rows = canvas_history_usage.common_evidence_rows + 1,
    common_evidence_bytes = canvas_history_usage.common_evidence_bytes + excluded.common_evidence_bytes,
    updated_at = MAX(canvas_history_usage.updated_at, excluded.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_history_usage_common_evidence_delete
AFTER DELETE ON collaboration_common_graph_operation_evidence
BEGIN
  UPDATE canvas_history_usage
  SET common_evidence_rows = common_evidence_rows - 1,
      common_evidence_bytes = common_evidence_bytes - OLD.logical_bytes,
      updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE project_id = OLD.project_id AND canvas_id = OLD.canvas_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_history_usage_raw_operation_insert
AFTER INSERT ON canvas_operations
BEGIN
  INSERT INTO canvas_history_usage(
    project_id,
    canvas_id,
    snapshot_rows,
    snapshot_bytes,
    common_evidence_rows,
    common_evidence_bytes,
    raw_operation_rows,
    raw_operation_bytes,
    pin_rows,
    pin_bytes,
    updated_at
  )
  SELECT
    document.project_id,
    NEW.canvas_id,
    0,
    0,
    0,
    0,
    1,
    length(CAST(NEW.payload_json AS BLOB)),
    0,
    0,
    NEW.created_at
  FROM canvas_documents document
  WHERE document.canvas_id = NEW.canvas_id
  ON CONFLICT(project_id, canvas_id) DO UPDATE SET
    raw_operation_rows = canvas_history_usage.raw_operation_rows + 1,
    raw_operation_bytes = canvas_history_usage.raw_operation_bytes + excluded.raw_operation_bytes,
    updated_at = MAX(canvas_history_usage.updated_at, excluded.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_history_usage_raw_operation_delete
AFTER DELETE ON canvas_operations
BEGIN
  UPDATE canvas_history_usage
  SET raw_operation_rows = raw_operation_rows - 1,
      raw_operation_bytes = raw_operation_bytes - length(CAST(OLD.payload_json AS BLOB)),
      updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE canvas_id = OLD.canvas_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_history_usage_pin_insert
AFTER INSERT ON canvas_snapshot_pins
BEGIN
  INSERT INTO canvas_history_usage(
    project_id,
    canvas_id,
    snapshot_rows,
    snapshot_bytes,
    common_evidence_rows,
    common_evidence_bytes,
    raw_operation_rows,
    raw_operation_bytes,
    pin_rows,
    pin_bytes,
    updated_at
  ) VALUES (
    NEW.project_id,
    NEW.canvas_id,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    length(CAST(NEW.project_id AS BLOB))
      + length(CAST(NEW.canvas_id AS BLOB))
      + length(CAST(NEW.pin_kind AS BLOB))
      + length(CAST(NEW.owner_id AS BLOB))
      + length(CAST(NEW.slot AS BLOB))
      + length(CAST(NEW.retention_class AS BLOB))
      + COALESCE(length(CAST(NEW.owner_state_digest AS BLOB)), 0)
      + 24
      + CASE WHEN NEW.expires_at IS NULL THEN 0 ELSE 8 END,
    NEW.updated_at
  )
  ON CONFLICT(project_id, canvas_id) DO UPDATE SET
    pin_rows = canvas_history_usage.pin_rows + 1,
    pin_bytes = canvas_history_usage.pin_bytes + excluded.pin_bytes,
    updated_at = MAX(canvas_history_usage.updated_at, excluded.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_history_usage_pin_delete
AFTER DELETE ON canvas_snapshot_pins
BEGIN
  UPDATE canvas_history_usage
  SET pin_rows = pin_rows - 1,
      pin_bytes = pin_bytes - (
        length(CAST(OLD.project_id AS BLOB))
        + length(CAST(OLD.canvas_id AS BLOB))
        + length(CAST(OLD.pin_kind AS BLOB))
        + length(CAST(OLD.owner_id AS BLOB))
        + length(CAST(OLD.slot AS BLOB))
        + length(CAST(OLD.retention_class AS BLOB))
        + COALESCE(length(CAST(OLD.owner_state_digest AS BLOB)), 0)
        + 24
        + CASE WHEN OLD.expires_at IS NULL THEN 0 ELSE 8 END
      ),
      updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE project_id = OLD.project_id AND canvas_id = OLD.canvas_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_canvas_history_usage_pin_update
AFTER UPDATE OF retention_class, expires_at, owner_state_digest, updated_at
ON canvas_snapshot_pins
BEGIN
  UPDATE canvas_history_usage
  SET pin_bytes = pin_bytes
        - (
          length(CAST(OLD.project_id AS BLOB))
          + length(CAST(OLD.canvas_id AS BLOB))
          + length(CAST(OLD.pin_kind AS BLOB))
          + length(CAST(OLD.owner_id AS BLOB))
          + length(CAST(OLD.slot AS BLOB))
          + length(CAST(OLD.retention_class AS BLOB))
          + COALESCE(length(CAST(OLD.owner_state_digest AS BLOB)), 0)
          + 24
          + CASE WHEN OLD.expires_at IS NULL THEN 0 ELSE 8 END
        )
        + (
          length(CAST(NEW.project_id AS BLOB))
          + length(CAST(NEW.canvas_id AS BLOB))
          + length(CAST(NEW.pin_kind AS BLOB))
          + length(CAST(NEW.owner_id AS BLOB))
          + length(CAST(NEW.slot AS BLOB))
          + length(CAST(NEW.retention_class AS BLOB))
          + COALESCE(length(CAST(NEW.owner_state_digest AS BLOB)), 0)
          + 24
          + CASE WHEN NEW.expires_at IS NULL THEN 0 ELSE 8 END
        ),
      updated_at = MAX(updated_at, NEW.updated_at)
  WHERE project_id = NEW.project_id AND canvas_id = NEW.canvas_id;
END;
`;

const DOWN_SQL = String.raw`
DROP TRIGGER IF EXISTS trg_canvas_history_usage_pin_update;
DROP TRIGGER IF EXISTS trg_canvas_history_usage_pin_delete;
DROP TRIGGER IF EXISTS trg_canvas_history_usage_pin_insert;
DROP TRIGGER IF EXISTS trg_canvas_history_usage_raw_operation_delete;
DROP TRIGGER IF EXISTS trg_canvas_history_usage_raw_operation_insert;
DROP TRIGGER IF EXISTS trg_canvas_history_usage_common_evidence_delete;
DROP TRIGGER IF EXISTS trg_canvas_history_usage_common_evidence_insert;
DROP TRIGGER IF EXISTS trg_canvas_history_usage_snapshot_delete;
DROP TRIGGER IF EXISTS trg_canvas_history_usage_snapshot_insert;
DROP TRIGGER IF EXISTS trg_canvas_history_usage_scope_update;
DROP TRIGGER IF EXISTS trg_canvas_history_usage_scope_insert;
DROP TRIGGER IF EXISTS trg_canvas_history_policies_scope_update;
DROP TRIGGER IF EXISTS trg_canvas_history_policies_scope_insert;
DROP TRIGGER IF EXISTS trg_canvas_snapshot_pins_identity_immutable;
DROP TRIGGER IF EXISTS trg_canvas_snapshot_pins_scope_update;
DROP TRIGGER IF EXISTS trg_canvas_snapshot_pins_scope_insert;
DROP TRIGGER IF EXISTS trg_canvas_snapshots_immutable_v29;
DROP TRIGGER IF EXISTS trg_canvas_snapshots_project_update_v29;
DROP TRIGGER IF EXISTS trg_canvas_snapshots_project_insert_v29;
DROP TRIGGER IF EXISTS trg_common_graph_operation_evidence_immutable;
DROP TRIGGER IF EXISTS trg_common_graph_operation_evidence_scope_insert;

DROP VIEW IF EXISTS canvas_snapshot_refcounts;

DROP INDEX IF EXISTS idx_canvas_snapshot_pins_expiry;
DROP INDEX IF EXISTS idx_canvas_snapshot_pins_revision;
DROP INDEX IF EXISTS idx_canvas_snapshots_project_canvas_revision;
DROP INDEX IF EXISTS idx_common_graph_operation_evidence_scope_created;
DROP INDEX IF EXISTS idx_common_graph_operation_evidence_scope_revision;

DROP TABLE IF EXISTS canvas_history_usage;
DROP TABLE IF EXISTS canvas_history_policies;
DROP TABLE IF EXISTS canvas_snapshot_pins;
DROP TABLE IF EXISTS collaboration_common_graph_operation_evidence;
DROP TABLE IF EXISTS schema_migration_receipts;
`;

const ownedObjects = Object.freeze({
  tables: Object.freeze([
    'schema_migration_receipts',
    'collaboration_common_graph_operation_evidence',
    'canvas_snapshot_pins',
    'canvas_history_policies',
    'canvas_history_usage',
  ]),
  indexes: Object.freeze([
    'idx_common_graph_operation_evidence_scope_revision',
    'idx_common_graph_operation_evidence_scope_created',
    'idx_canvas_snapshots_project_canvas_revision',
    'idx_canvas_snapshot_pins_revision',
    'idx_canvas_snapshot_pins_expiry',
  ]),
  views: Object.freeze([
    'canvas_snapshot_refcounts',
  ]),
  triggers: Object.freeze([
    'trg_common_graph_operation_evidence_scope_insert',
    'trg_common_graph_operation_evidence_immutable',
    'trg_canvas_snapshots_project_insert_v29',
    'trg_canvas_snapshots_project_update_v29',
    'trg_canvas_snapshots_immutable_v29',
    'trg_canvas_snapshot_pins_scope_insert',
    'trg_canvas_snapshot_pins_scope_update',
    'trg_canvas_snapshot_pins_identity_immutable',
    'trg_canvas_history_policies_scope_insert',
    'trg_canvas_history_policies_scope_update',
    'trg_canvas_history_usage_scope_insert',
    'trg_canvas_history_usage_scope_update',
    'trg_canvas_history_usage_snapshot_insert',
    'trg_canvas_history_usage_snapshot_delete',
    'trg_canvas_history_usage_common_evidence_insert',
    'trg_canvas_history_usage_common_evidence_delete',
    'trg_canvas_history_usage_raw_operation_insert',
    'trg_canvas_history_usage_raw_operation_delete',
    'trg_canvas_history_usage_pin_insert',
    'trg_canvas_history_usage_pin_delete',
    'trg_canvas_history_usage_pin_update',
  ]),
});

const ownedObjectNames = Object.freeze([
  ...ownedObjects.tables,
  ...ownedObjects.indexes,
  ...ownedObjects.views,
  ...ownedObjects.triggers,
]);

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
  PROJECT_DATABASE_MIGRATION_29: definition,
  PROJECT_DATABASE_MIGRATION_29_UP_SQL: UP_SQL,
  PROJECT_DATABASE_MIGRATION_29_DOWN_SQL: DOWN_SQL,
  PROJECT_DATABASE_MIGRATION_29_IMPERATIVE_CONTRACT: imperativeContract,
  PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES: ownedObjectNames,
});
