function ensureColumn(db, table, column, definition) {
  const columns = new Set(db.pragma(`table_info(${table})`).map((entry) => entry.name));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function ensureCollaborationTextSchema(db) {
  if (!db?.prepare || !db?.exec) throw new Error('协同文本 schema 需要 SQLite database');
  ensureColumn(db, 'collaboration_text_documents', 'display_target_id', 'TEXT');
  ensureColumn(db, 'collaboration_text_documents', 'target_entity_uid', 'TEXT');
  ensureColumn(db, 'collaboration_text_documents', 'binding_epoch', 'TEXT');
  ensureColumn(
    db,
    'collaboration_text_documents',
    'lifecycle',
    "TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active', 'deleted', 'stale'))",
  );
  ensureColumn(
    db,
    'collaboration_text_documents',
    'created_revision',
    'INTEGER CHECK(created_revision IS NULL OR created_revision >= 1)',
  );
  ensureColumn(
    db,
    'collaboration_text_documents',
    'revision',
    'INTEGER CHECK(revision IS NULL OR revision >= 1)',
  );
  ensureColumn(db, 'collaboration_text_documents', 'state_vector', 'BLOB');
  ensureColumn(
    db,
    'collaboration_text_documents',
    'state_digest',
    "TEXT CHECK(state_digest IS NULL OR (length(state_digest) = 64 AND state_digest NOT GLOB '*[^0-9a-f]*'))",
  );
  ensureColumn(db, 'collaboration_text_documents', 'materialized_text', 'TEXT');
  ensureColumn(
    db,
    'collaboration_text_documents',
    'text_digest',
    "TEXT CHECK(text_digest IS NULL OR (length(text_digest) = 64 AND text_digest NOT GLOB '*[^0-9a-f]*'))",
  );

  db.exec(`
    UPDATE collaboration_text_documents
    SET display_target_id = target_id
    WHERE target_entity_uid IS NOT NULL AND display_target_id IS NULL;
    UPDATE collaboration_text_documents
    SET target_id = '@t8/text-entity/' || lower(target_entity_uid)
    WHERE target_entity_uid IS NOT NULL
      AND target_id != ('@t8/text-entity/' || lower(target_entity_uid));

    CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_text_entity_binding
      ON collaboration_text_documents(
        project_id, canvas_id, target_type, target_entity_uid, field_name
      ) WHERE target_entity_uid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_collaboration_text_entity_revision
      ON collaboration_text_documents(project_id, canvas_id, target_entity_uid, revision DESC)
      WHERE target_entity_uid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_collaboration_text_display_identity
      ON collaboration_text_documents(
        project_id, canvas_id, target_type, display_target_id, field_name
      ) WHERE target_entity_uid IS NOT NULL;

    DROP TRIGGER IF EXISTS trg_collaboration_text_documents_stable_identity_insert;
    DROP TRIGGER IF EXISTS trg_collaboration_text_documents_stable_identity_update;
    DROP TRIGGER IF EXISTS trg_collaboration_text_documents_stable_state_guard;

    CREATE TRIGGER IF NOT EXISTS trg_collaboration_text_documents_scope_insert
    BEFORE INSERT ON collaboration_text_documents BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM canvas_documents d
        WHERE d.canvas_id = NEW.canvas_id AND d.project_id = NEW.project_id
      ) THEN RAISE(ABORT, 'collaboration_text_documents project mismatch') END;
      SELECT CASE WHEN NEW.target_entity_uid IS NOT NULL AND (
        length(NEW.target_entity_uid) != 36
        OR NEW.binding_epoch IS NULL OR length(NEW.binding_epoch) != 36
        OR NEW.created_revision IS NULL OR NEW.revision IS NULL
        OR NEW.state_vector IS NULL OR NEW.state_digest IS NULL
        OR NEW.materialized_text IS NULL OR NEW.text_digest IS NULL
      ) THEN RAISE(ABORT, 'collaboration_text_documents stable binding incomplete') END;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_collaboration_text_documents_scope_update
    BEFORE UPDATE ON collaboration_text_documents BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM canvas_documents d
        WHERE d.canvas_id = NEW.canvas_id AND d.project_id = NEW.project_id
      ) THEN RAISE(ABORT, 'collaboration_text_documents project mismatch') END;
      SELECT CASE WHEN NEW.target_entity_uid IS NOT NULL AND (
        length(NEW.target_entity_uid) != 36
        OR NEW.binding_epoch IS NULL OR length(NEW.binding_epoch) != 36
        OR NEW.created_revision IS NULL OR NEW.revision IS NULL
        OR NEW.state_vector IS NULL OR NEW.state_digest IS NULL
        OR NEW.materialized_text IS NULL OR NEW.text_digest IS NULL
      ) THEN RAISE(ABORT, 'collaboration_text_documents stable binding incomplete') END;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_collaboration_text_documents_stable_identity_insert
    BEFORE INSERT ON collaboration_text_documents BEGIN
      SELECT CASE WHEN NEW.target_entity_uid IS NOT NULL AND (
        NEW.display_target_id IS NULL OR length(NEW.display_target_id) < 1
        OR NEW.target_id != ('@t8/text-entity/' || lower(NEW.target_entity_uid))
      ) THEN RAISE(ABORT, 'collaboration_text_documents stable identity invalid') END;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_collaboration_text_documents_stable_identity_update
    BEFORE UPDATE ON collaboration_text_documents BEGIN
      SELECT CASE WHEN NEW.target_entity_uid IS NOT NULL AND (
        NEW.display_target_id IS NULL OR length(NEW.display_target_id) < 1
        OR NEW.target_id != ('@t8/text-entity/' || lower(NEW.target_entity_uid))
      ) THEN RAISE(ABORT, 'collaboration_text_documents stable identity invalid') END;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_collaboration_text_documents_stable_state_guard
    BEFORE UPDATE OF state_blob ON collaboration_text_documents
    WHEN OLD.target_entity_uid IS NOT NULL
      AND NEW.target_entity_uid IS OLD.target_entity_uid
      AND NEW.binding_epoch IS OLD.binding_epoch
      AND NEW.created_revision IS OLD.created_revision
      AND NEW.revision IS OLD.revision
      AND NEW.state_vector IS OLD.state_vector
      AND NEW.state_digest IS OLD.state_digest
      AND NEW.materialized_text IS OLD.materialized_text
      AND NEW.text_digest IS OLD.text_digest
    BEGIN
      SELECT RAISE(ABORT, 'collaboration_text_documents stable state requires modern writer');
    END;

    CREATE TABLE IF NOT EXISTS collaboration_text_update_idempotency (
      update_id TEXT PRIMARY KEY CHECK(length(update_id) = 36),
      request_digest TEXT NOT NULL
        CHECK(length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      target_type TEXT NOT NULL
        CHECK(target_type IN ('canvas', 'node', 'edge', 'review', 'subflow')),
      target_entity_uid TEXT NOT NULL CHECK(length(target_entity_uid) = 36),
      field_name TEXT NOT NULL,
      binding_epoch TEXT NOT NULL CHECK(length(binding_epoch) = 36),
      actor_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      client_seq INTEGER NOT NULL CHECK(client_seq >= 0),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK(created_at >= 1),
      UNIQUE(project_id, canvas_id, actor_id, session_id, client_seq),
      FOREIGN KEY(canvas_id) REFERENCES canvas_documents(canvas_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_collaboration_text_idempotency_scope
      ON collaboration_text_update_idempotency(
        project_id, canvas_id, target_entity_uid, revision DESC
      );
    CREATE TRIGGER IF NOT EXISTS trg_collaboration_text_idempotency_scope_insert
    BEFORE INSERT ON collaboration_text_update_idempotency BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM canvas_documents d
        WHERE d.canvas_id = NEW.canvas_id AND d.project_id = NEW.project_id
      ) THEN RAISE(ABORT, 'collaboration_text_update_idempotency project mismatch') END;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_collaboration_text_idempotency_immutable
    BEFORE UPDATE ON collaboration_text_update_idempotency BEGIN
      SELECT RAISE(ABORT, 'collaboration_text_update_idempotency is immutable');
    END;

    CREATE TABLE IF NOT EXISTS collaboration_text_noop_idempotency (
      update_id TEXT PRIMARY KEY CHECK(length(update_id) = 36),
      request_digest TEXT NOT NULL
        CHECK(length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      target_type TEXT NOT NULL
        CHECK(target_type IN ('canvas', 'node', 'edge', 'review', 'subflow')),
      target_entity_uid TEXT NOT NULL CHECK(length(target_entity_uid) = 36),
      field_name TEXT NOT NULL,
      binding_epoch TEXT NOT NULL CHECK(length(binding_epoch) = 36),
      actor_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      client_seq INTEGER NOT NULL CHECK(client_seq >= 0),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK(created_at >= 1),
      FOREIGN KEY(canvas_id) REFERENCES canvas_documents(canvas_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_collaboration_text_noop_scope
      ON collaboration_text_noop_idempotency(
        project_id, canvas_id, target_entity_uid, revision DESC
      );
    CREATE TRIGGER IF NOT EXISTS trg_collaboration_text_noop_scope_insert
    BEFORE INSERT ON collaboration_text_noop_idempotency BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM canvas_documents d
        WHERE d.canvas_id = NEW.canvas_id AND d.project_id = NEW.project_id
      ) THEN RAISE(ABORT, 'collaboration_text_noop_idempotency project mismatch') END;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_collaboration_text_noop_global_identity_insert
    BEFORE INSERT ON collaboration_text_noop_idempotency BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM collaboration_operation_identities identity
        WHERE identity.op_id = NEW.update_id
          AND identity.project_id = NEW.project_id
          AND identity.canvas_id = NEW.canvas_id
          AND identity.domain = 'text'
          AND identity.type = 'text.update'
      ) THEN RAISE(ABORT, 'text no-op global identity missing') END;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_collaboration_text_noop_immutable
    BEFORE UPDATE ON collaboration_text_noop_idempotency BEGIN
      SELECT RAISE(ABORT, 'collaboration_text_noop_idempotency is immutable');
    END;

    CREATE TABLE IF NOT EXISTS collaboration_text_client_sequences (
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_client_seq INTEGER NOT NULL CHECK(last_client_seq >= 0),
      updated_at INTEGER NOT NULL CHECK(updated_at >= 1),
      PRIMARY KEY(project_id, canvas_id, actor_id, session_id),
      FOREIGN KEY(canvas_id) REFERENCES canvas_documents(canvas_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_collaboration_text_sequences_updated
      ON collaboration_text_client_sequences(project_id, canvas_id, updated_at DESC);
    CREATE TRIGGER IF NOT EXISTS trg_collaboration_text_sequences_scope_insert
    BEFORE INSERT ON collaboration_text_client_sequences BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM canvas_documents d
        WHERE d.canvas_id = NEW.canvas_id AND d.project_id = NEW.project_id
      ) THEN RAISE(ABORT, 'collaboration_text_client_sequences project mismatch') END;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_collaboration_text_sequences_scope_update
    BEFORE UPDATE ON collaboration_text_client_sequences BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM canvas_documents d
        WHERE d.canvas_id = NEW.canvas_id AND d.project_id = NEW.project_id
      ) THEN RAISE(ABORT, 'collaboration_text_client_sequences project mismatch') END;
    END;
  `);
}

module.exports = { ensureCollaborationTextSchema };
