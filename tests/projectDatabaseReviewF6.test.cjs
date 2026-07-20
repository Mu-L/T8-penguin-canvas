const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const { COMMON_OPERATION_BATCH_CONTRACT } = require('../backend/src/collaboration/commonOperationProtocol');
const {
  PROJECT_DATABASE_MIGRATIONS,
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');
const {
  PROJECT_DATABASE_MIGRATION_29_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration29');
const {
  PROJECT_DATABASE_MIGRATION_30_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration30');
const {
  PROJECT_DATABASE_MIGRATION_31,
} = require('../backend/src/services/projectDatabaseMigration31');
const {
  PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration31LegacyGaps');
const {
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS,
} = require('../backend/src/services/projectDatabaseMigration31DurableLedgers');
const {
  assertCurrentProjectDatabaseRegistry,
  stripSchema32ForSyntheticSchema31,
} = require('./helpers/projectDatabaseVersion.cjs');

const IDS = {
  canvasEntity: '27000000-0000-4000-8000-000000000001',
  actor: '27000000-0000-4000-8000-000000000002',
  recipient: '27000000-0000-4000-8000-000000000003',
  otherCanvasMember: '27000000-0000-4000-8000-000000000004',
  otherProjectMember: '27000000-0000-4000-8000-000000000005',
  asset: '27000000-0000-4000-8000-000000000006',
  otherAsset: '27000000-0000-4000-8000-000000000007',
  thread: '27000000-0000-4000-8000-000000000008',
  comment: '27000000-0000-4000-8000-000000000009',
  reply: '27000000-0000-4000-8000-00000000000a',
  batch: '27000000-0000-4000-8000-00000000000b',
  client: '27000000-0000-4000-8000-00000000000c',
  operation: '27000000-0000-4000-8000-00000000000d',
  legacyBatch: '27000000-0000-4000-8000-00000000000e',
  legacyClient: '27000000-0000-4000-8000-00000000000f',
  legacyOperation: '27000000-0000-4000-8000-000000000010',
  legacyReply: '27000000-0000-4000-8000-000000000011',
};

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function insertMember(database, id, projectId, canvasId, displayName = id) {
  const now = Date.now();
  database.db.prepare(`
    INSERT INTO collaboration_members(
      id, project_id, canvas_id, display_name, role, capabilities_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'reviewer', '["comment","approve"]', ?, ?)
  `).run(id, projectId, canvasId, displayName, now, now);
}

function ensureCanvas(database, canvasId = 'canvas-f6', projectId = 'project-f6', entityUid = IDS.canvasEntity) {
  return database.ensureCanvas(canvasId, {
    projectId,
    entityUid,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }, projectId);
}

function insertAsset(database, input = {}) {
  return database.upsertAsset({
    id: input.id || 'asset-f6',
    entityUid: input.entityUid || IDS.asset,
    projectId: input.projectId || 'project-f6',
    contentHash: input.contentHash || HASH_A,
    kind: input.kind || 'image',
    filename: input.filename || 'asset.png',
    metadata: input.metadata || {},
    createdBy: input.createdBy || IDS.actor,
  });
}

function reviewThreadInput(overrides = {}) {
  return {
    id: overrides.id || IDS.thread,
    entityUid: overrides.entityUid || overrides.id || IDS.thread,
    projectId: overrides.projectId || 'project-f6',
    canvasId: overrides.canvasId || 'canvas-f6',
    canvasRevision: overrides.canvasRevision || 1,
    anchor: overrides.anchor || { kind: 'canvas', targetEntityUid: IDS.canvasEntity, x: 1, y: 2 },
    severity: overrides.severity || 'normal',
    createdBy: overrides.createdBy || IDS.actor,
    ...(overrides.reviewStatus ? { reviewStatus: overrides.reviewStatus } : {}),
    ...(overrides.resolutionStatus ? { resolutionStatus: overrides.resolutionStatus } : {}),
  };
}

function addFailureTrigger(database, name, table, action = null) {
  database.db.exec(`
    CREATE TRIGGER ${name}
    BEFORE INSERT ON ${table}
    ${action ? `WHEN NEW.action = '${action}'` : ''}
    BEGIN
      SELECT RAISE(ABORT, 'f6 injected failure');
    END;
  `);
}

// Production schema31 DOWN remains backup-only. This synthetic legacy fixture
// strips only schema31-owned objects plus its receipt/checkpoint.
function stripSchema31ForSchema30Test(database) {
  stripSchema32ForSyntheticSchema31(database);
  database.exec(PROJECT_DATABASE_MIGRATION_31_LEGACY_GAPS_DOWN_SQL);
  const drop = (type, name) => database.exec(`DROP ${type} IF EXISTS "${name}"`);
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.triggers.forEach((name) => drop('TRIGGER', name));
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.views.forEach((name) => drop('VIEW', name));
  PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.indexes.forEach((name) => drop('INDEX', name));
  [...PROJECT_DATABASE_MIGRATION_31_DURABLE_LEDGER_OWNED_OBJECTS.tables]
    .reverse()
    .forEach((name) => drop('TABLE', name));
  database.prepare('DELETE FROM schema_migration_receipts WHERE version = ?')
    .run(PROJECT_DATABASE_MIGRATION_31.version);
  database.prepare('DELETE FROM schema_migrations WHERE version = ?')
    .run(PROJECT_DATABASE_MIGRATION_31.version);
}

function downgradeCurrentSchemaTo27(database) {
  database.pragma('foreign_keys = OFF');
  stripSchema31ForSchema30Test(database);
  database.prepare('DELETE FROM schema_migration_receipts WHERE version = 30').run();
  database.prepare('DELETE FROM schema_migrations WHERE version = 30').run();
  database.exec(PROJECT_DATABASE_MIGRATION_30_DOWN_SQL);
  database.exec(PROJECT_DATABASE_MIGRATION_29_DOWN_SQL);
  database.exec(`
    DROP TRIGGER IF EXISTS trg_audit_events_mutation_uid_insert;
    DROP TRIGGER IF EXISTS trg_audit_events_append_only_update;
    DROP TRIGGER IF EXISTS trg_audit_events_append_only_delete;
    DROP INDEX IF EXISTS idx_audit_events_mutation_uid;
    DROP TRIGGER IF EXISTS trg_room_execution_policies_scope_insert;
    DROP TRIGGER IF EXISTS trg_room_execution_policies_scope_immutable;
    DROP TABLE IF EXISTS room_execution_policies;
    DROP INDEX IF EXISTS idx_run_intents_dispatch_queue;
    DROP INDEX IF EXISTS idx_run_intents_dispatch_lease;
    DROP INDEX IF EXISTS idx_run_intents_requester_created;
    ALTER TABLE run_intents DROP COLUMN last_error_message;
    ALTER TABLE run_intents DROP COLUMN last_error_code;
    ALTER TABLE run_intents DROP COLUMN cancelled_at;
    ALTER TABLE run_intents DROP COLUMN cancel_requested_at;
    ALTER TABLE run_intents DROP COLUMN last_heartbeat_at;
    ALTER TABLE run_intents DROP COLUMN lease_expires_at;
    ALTER TABLE run_intents DROP COLUMN lease_token;
    ALTER TABLE run_intents DROP COLUMN lease_owner;
    ALTER TABLE run_intents DROP COLUMN next_attempt_at;
    ALTER TABLE run_intents DROP COLUMN dispatch_attempts;
    ALTER TABLE run_intents DROP COLUMN confirmed_by;
    ALTER TABLE run_intents DROP COLUMN confirmed_at;
    ALTER TABLE run_intents DROP COLUMN confirmation_required;
    ALTER TABLE run_intents DROP COLUMN queue_revision;
    ALTER TABLE audit_events DROP COLUMN mutation_uid;
    DELETE FROM schema_migrations WHERE version >= 28;
  `);
  database.pragma('foreign_keys = ON');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
}

test('F6 review schema migrates atomically through current schema and cold-opens repeatedly', async () => {
  assertCurrentProjectDatabaseRegistry(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATIONS);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-f6-schema-'));
  const filename = path.join(directory, 'project.sqlite');
  try {
    const initial = new ProjectDatabase(filename, { autoBackup: false });
    await initial.close();

    const downgrade = new BetterSqlite3(filename);
    downgradeCurrentSchemaTo27(downgrade);
    downgrade.exec(`
      DROP TRIGGER IF EXISTS trg_review_comment_mentions_scope_insert;
      DROP TRIGGER IF EXISTS trg_review_comment_mentions_immutable;
      DROP TRIGGER IF EXISTS trg_review_comment_attachments_scope_insert;
      DROP TRIGGER IF EXISTS trg_review_comment_attachments_immutable;
      DROP TRIGGER IF EXISTS trg_collaboration_notifications_scope_insert;
      DROP TRIGGER IF EXISTS trg_collaboration_notifications_identity_immutable;
      DROP TABLE IF EXISTS collaboration_notifications;
      DROP TABLE IF EXISTS review_comment_attachments;
      DROP TABLE IF EXISTS review_comment_mentions;
      DROP TABLE IF EXISTS project_review_visibility_policies;
      ALTER TABLE assets DROP COLUMN content_revision;
      DELETE FROM schema_migrations WHERE version >= 27;
    `);
    downgrade.close();
    fs.rmSync(`${filename}.pre-migration-v30.sqlite3`, { force: true });

    assert.throws(() => new ProjectDatabase(filename, {
      autoBackup: false,
      beforeMigrationCommit(_database, version) {
        if (version === 28) throw new Error('rollback schema 28');
      },
    }), /rollback schema 28/);

    const rolledBack = new BetterSqlite3(filename, { readonly: true });
    assert.equal(rolledBack.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 26);
    assert.equal(rolledBack.pragma('table_info(assets)').some((column) => column.name === 'content_revision'), false);
    assert.equal(rolledBack.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='collaboration_notifications'").get().count, 0);
    rolledBack.close();

    const migrated = new ProjectDatabase(filename, { autoBackup: false });
    assert.equal(
      migrated.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      PROJECT_DATABASE_SCHEMA_VERSION,
    );
    assert.equal(migrated.db.pragma('table_info(assets)').find((column) => column.name === 'content_revision').notnull, 1);
    assert.equal(migrated.db.pragma('quick_check', { simple: true }), 'ok');
    await migrated.close();

    const reopened = new ProjectDatabase(filename, { autoBackup: false });
    assert.equal(
      reopened.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,
      PROJECT_DATABASE_SCHEMA_VERSION,
    );
    assert.equal(reopened.db.pragma('quick_check', { simple: true }), 'ok');
    await reopened.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('F6 asset contentRevision changes only for a normalized SHA-256 content change', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const first = insertAsset(database);
    assert.equal(first.contentRevision, 1);
    assert.equal(first.revision, 1);
    const sameCaseNormalized = database.upsertAsset({
      ...first,
      contentHash: HASH_A.toUpperCase(),
      metadata: { label: 'metadata-only' },
    });
    assert.equal(sameCaseNormalized.contentRevision, 1);
    const tagged = database.setAssetTags(first.id, ['review'], {
      expectedRevision: sameCaseNormalized.organizationRevision,
    });
    assert.equal(tagged.contentRevision, 1);
    const policy = database.getAssetAccessPolicy(first.projectId, first.id);
    database.setAssetAccessPolicy(first.projectId, first.id, {
      scope: 'restricted',
      expectedRevision: policy.revision,
      grants: [{ principalType: 'member', principalId: IDS.recipient, permissions: ['view'] }],
    });
    assert.equal(database.getAsset(first.id).contentRevision, 1);
    const changed = database.upsertAsset({ ...first, contentHash: HASH_B });
    assert.equal(changed.contentRevision, 2);
    assert.equal(changed.revision, 2);
    assert.equal(database.upsertAsset({ ...changed, contentHash: HASH_B }).contentRevision, 2);
    assert.equal(database.db.prepare('SELECT content_revision FROM assets WHERE id = ?').get(first.id).content_revision, 2);
  } finally {
    database.close();
  }
});

test('F6 explicit review lifecycle and independent resolution survive cold restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-f6-lifecycle-'));
  const filename = path.join(directory, 'project.sqlite');
  let database = new ProjectDatabase(filename, { autoBackup: false });
  try {
    ensureCanvas(database, 'canvas-f6-lifecycle', 'project-f6-lifecycle');
    let thread = database.createReviewThread(reviewThreadInput({
      id: '27000000-0000-4000-8000-000000000099',
      projectId: 'project-f6-lifecycle',
      canvasId: 'canvas-f6-lifecycle',
      reviewStatus: 'draft',
      resolutionStatus: 'open',
    }));
    thread = database.updateReviewThread(thread.id, {
      expectedRevision: thread.revision,
      reviewStatus: 'in_review',
      decisionCanvasRevision: null,
    });
    thread = database.updateReviewThread(thread.id, {
      expectedRevision: thread.revision,
      reviewStatus: 'changes_requested',
      decisionCanvasRevision: 1,
    });
    thread = database.updateReviewThread(thread.id, {
      expectedRevision: thread.revision,
      resolutionStatus: 'resolved',
    });
    assert.equal(thread.reviewStatus, 'changes_requested');
    assert.equal(thread.resolutionStatus, 'resolved');
    assert.equal(thread.decisionCanvasRevision, 1);
    await database.close();

    database = new ProjectDatabase(filename, { autoBackup: false });
    thread = database.getReviewThread(thread.id);
    assert.equal(thread.reviewStatus, 'changes_requested');
    assert.equal(thread.resolutionStatus, 'resolved');
    assert.equal(thread.decisionCanvasRevision, 1);
    thread = database.updateReviewThread(thread.id, {
      expectedRevision: thread.revision,
      reviewStatus: 'in_review',
      decisionCanvasRevision: null,
    });
    assert.equal(thread.reviewStatus, 'in_review');
    assert.equal(thread.resolutionStatus, 'resolved');
    assert.equal(thread.decisionCanvasRevision, null);
  } finally {
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('F6 direct legacy status mutations obey the explicit lifecycle and preserve resolution decisions', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    ensureCanvas(database, 'canvas-f6-legacy-state', 'project-f6-legacy-state');
    let thread = database.createReviewThread(reviewThreadInput({
      id: '27000000-0000-4000-8000-000000000098',
      projectId: 'project-f6-legacy-state',
      canvasId: 'canvas-f6-legacy-state',
      reviewStatus: 'draft',
      resolutionStatus: 'open',
    }));
    assert.throws(() => database.updateReviewThread(thread.id, {
      expectedRevision: thread.revision,
      status: 'approved',
      decisionCanvasRevision: 1,
    }), (error) => error?.code === 'collaboration_domain_review_transition_invalid');
    assert.equal(database.getReviewThread(thread.id).revision, 1);

    thread = database.updateReviewThread(thread.id, {
      expectedRevision: thread.revision,
      reviewStatus: 'in_review',
      decisionCanvasRevision: null,
    });
    thread = database.updateReviewThread(thread.id, {
      expectedRevision: thread.revision,
      status: 'resolved',
      decisionCanvasRevision: null,
    });
    assert.equal(thread.resolutionStatus, 'resolved');
    assert.equal(thread.reviewStatus, 'in_review');

    thread = database.updateReviewThread(thread.id, {
      expectedRevision: thread.revision,
      status: 'changes_requested',
      decisionCanvasRevision: 1,
    });
    assert.equal(thread.resolutionStatus, 'resolved');
    assert.equal(thread.reviewStatus, 'changes_requested');
    assert.equal(thread.decisionCanvasRevision, 1);
    assert.throws(() => database.updateReviewThread(thread.id, {
      expectedRevision: thread.revision,
      status: 'approved',
      decisionCanvasRevision: 1,
    }), (error) => error?.code === 'collaboration_domain_review_transition_invalid');

    thread = database.updateReviewThread(thread.id, {
      expectedRevision: thread.revision,
      status: 'open',
      decisionCanvasRevision: null,
    });
    assert.equal(thread.resolutionStatus, 'open');
    assert.equal(thread.reviewStatus, 'changes_requested');
    assert.equal(thread.decisionCanvasRevision, 1);
  } finally {
    database.close();
  }
});

test('F6 review mentions and attachment pins are scoped and hydrated without paths or URLs', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    ensureCanvas(database);
    ensureCanvas(database, 'canvas-other', 'project-f6', '27000000-0000-4000-8000-000000000020');
    ensureCanvas(database, 'canvas-foreign', 'project-foreign', '27000000-0000-4000-8000-000000000021');
    insertMember(database, IDS.actor, 'project-f6', 'canvas-f6', 'Actor');
    insertMember(database, IDS.recipient, 'project-f6', 'canvas-f6', 'Recipient');
    insertMember(database, IDS.otherCanvasMember, 'project-f6', 'canvas-other', 'Other canvas');
    insertMember(database, IDS.otherProjectMember, 'project-foreign', 'canvas-foreign', 'Other project');
    const asset = insertAsset(database, { metadata: { localPath: 'must-not-copy' } });
    const otherAsset = insertAsset(database, {
      id: 'asset-foreign',
      entityUid: IDS.otherAsset,
      projectId: 'project-foreign',
    });

    const created = database.createReviewThreadWithComment(reviewThreadInput(), {
      commentId: IDS.comment,
      commentEntityUid: IDS.comment,
      body: '带成员和素材 pin 的审片意见',
      mentions: [IDS.recipient],
      attachments: [{
        assetId: asset.id,
        assetUid: asset.entityUid,
        assetContentRevision: asset.contentRevision,
        contentHash: asset.contentHash,
      }],
      actorId: IDS.actor,
      sessionId: 'session-f6',
      sourceOperationId: 'f6-create-valid',
    });
    assert.deepEqual(created.comment.mentions, [IDS.recipient]);
    assert.deepEqual(created.comment.attachments.map((item) => ({
      assetId: item.assetId,
      assetUid: item.assetUid,
      assetContentRevision: item.assetContentRevision,
      contentHash: item.contentHash,
    })), [{
      assetId: asset.id,
      assetUid: asset.entityUid,
      assetContentRevision: 1,
      contentHash: HASH_A,
    }]);
    assert.equal(JSON.stringify(created.comment.attachments).includes('localPath'), false);
    assert.equal(JSON.stringify(created.comment.attachments).includes('sourceUrl'), false);

    for (const [suffix, options, pattern] of [
      ['1', { mentions: [IDS.otherCanvasMember] }, /project\/canvas|scope/i],
      ['2', { mentions: [IDS.otherProjectMember] }, /project\/canvas|scope/i],
      ['3', { attachments: [{ assetId: otherAsset.id, assetUid: otherAsset.entityUid, assetContentRevision: 1, contentHash: HASH_A }] }, /项目|scope/i],
    ]) {
      assert.throws(() => database.createReviewThreadWithComment(reviewThreadInput({
        id: `27000000-0000-4000-8000-00000000003${suffix}`,
      }), {
        commentId: `27000000-0000-4000-8000-00000000004${suffix}`,
        body: '非法 scope',
        actorId: IDS.actor,
        sourceOperationId: `invalid-scope-${suffix}`,
        ...options,
      }), pattern);
    }

    const changed = database.upsertAsset({ ...asset, contentHash: HASH_B });
    assert.equal(changed.contentRevision, 2);
    assert.throws(() => database.createReviewThreadWithComment(reviewThreadInput({
      id: '27000000-0000-4000-8000-000000000050',
    }), {
      commentId: '27000000-0000-4000-8000-000000000051',
      body: '陈旧 pin',
      actorId: IDS.actor,
      sourceOperationId: 'stale-pin',
      attachments: [{
        assetId: asset.id,
        assetUid: asset.entityUid,
        assetContentRevision: 1,
        contentHash: HASH_A,
      }],
    }), (error) => error.code === 'collaboration_domain_review_cas_conflict');
  } finally {
    database.close();
  }
});

test('F6 create, reply, and audited update roll back references, notifications, audit, and CAS on injected failures', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    ensureCanvas(database);
    insertMember(database, IDS.actor, 'project-f6', 'canvas-f6', 'Actor');
    insertMember(database, IDS.recipient, 'project-f6', 'canvas-f6', 'Recipient');

    addFailureTrigger(database, 'f6_fail_create_audit', 'audit_events', 'review.thread.create');
    assert.throws(() => database.createReviewThreadWithComment(reviewThreadInput(), {
      commentId: IDS.comment,
      body: '必须全部回滚',
      mentions: [IDS.recipient],
      actorId: IDS.actor,
      sourceOperationId: 'f6-create-rollback',
    }), /injected failure/);
    database.db.exec('DROP TRIGGER f6_fail_create_audit');
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM review_threads').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM review_comments').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM review_comment_mentions').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_notifications').get().count, 0);

    const baseline = database.createReviewThreadWithComment(reviewThreadInput(), {
      commentId: IDS.comment,
      body: '基线评论',
      actorId: IDS.actor,
      sourceOperationId: 'f6-create-baseline',
    });
    const baselineAuditCount = database.listAuditEvents({ projectId: 'project-f6' }).length;
    addFailureTrigger(database, 'f6_fail_reply_notification', 'collaboration_notifications');
    assert.throws(() => database.createReviewCommentWithThreadRevision({
      id: IDS.reply,
      entityUid: IDS.reply,
      threadId: baseline.id,
      parentId: baseline.comment.id,
      body: '回复触发通知失败',
      createdBy: IDS.recipient,
    }, {
      expectedRevision: 1,
      expectedCanvasRevision: 1,
      actorId: IDS.recipient,
      sourceOperationId: 'f6-reply-rollback',
    }), /injected failure/);
    database.db.exec('DROP TRIGGER f6_fail_reply_notification');
    assert.equal(database.listReviewComments(baseline.id).length, 1);
    assert.equal(database.getReviewThread(baseline.id).revision, 1);
    assert.equal(database.listAuditEvents({ projectId: 'project-f6' }).length, baselineAuditCount);

    addFailureTrigger(database, 'f6_fail_update_audit', 'audit_events', 'review.thread.update');
    assert.throws(() => database.updateReviewThreadWithAudit({
      threadId: baseline.id,
      expectedCanvasRevision: 1,
      expectedThreadRevision: 1,
      status: 'resolved',
      severity: 'normal',
      decisionCanvasRevision: null,
      actorId: IDS.recipient,
      sessionId: 'session-recipient',
      sourceOperationId: 'f6-update-rollback',
    }), /injected failure/);
    database.db.exec('DROP TRIGGER f6_fail_update_audit');
    assert.equal(database.getReviewThread(baseline.id).status, 'open');
    assert.equal(database.getReviewThread(baseline.id).revision, 1);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_notifications').get().count, 0);
    assert.equal(database.listAuditEvents({ projectId: 'project-f6' }).length, baselineAuditCount);
  } finally {
    database.close();
  }
});

test('F6 common review exact replay deduplicates notifications and notification reads are recipient-only', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    ensureCanvas(database);
    insertMember(database, IDS.actor, 'project-f6', 'canvas-f6', 'Actor');
    insertMember(database, IDS.recipient, 'project-f6', 'canvas-f6', 'Recipient');
    const batch = {
      contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
      projectId: 'project-f6',
      canvasId: 'canvas-f6',
      baseRevision: 1,
      batchId: IDS.batch,
      clientId: IDS.client,
      clientSeq: 1,
      operations: [{
        opId: IDS.operation,
        type: 'review.thread.create',
        payload: {
          threadUid: IDS.thread,
          expectedCanvasRevision: 1,
          anchor: { kind: 'canvas', x: 1, y: 2 },
          severity: 'high',
          initialComment: {
            commentUid: IDS.comment,
            body: '请复核',
            mentions: [IDS.recipient],
          },
        },
      }],
    };
    const principal = {
      memberId: IDS.actor,
      sessionId: 'session-common-f6',
      capabilities: ['comment'],
    };
    const first = database.applyCommonReviewBatch(batch, { principal });
    assert.equal(first.duplicate, false);
    assert.deepEqual(first.results[0].thread.comments[0].mentions, [IDS.recipient]);
    assert.equal(first.notifications.length, 1);
    assert.equal(first.notifications[0].recipientMemberId, IDS.recipient);
    const replay = database.applyCommonReviewBatch(structuredClone(batch), { principal });
    assert.equal(replay.duplicate, true);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_notifications').get().count, 1);

    const legacyReply = database.applyCommonReviewBatch({
      contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
      projectId: 'project-f6',
      canvasId: 'canvas-f6',
      baseRevision: 1,
      batchId: IDS.legacyBatch,
      clientId: IDS.legacyClient,
      clientSeq: 1,
      operations: [{
        opId: IDS.legacyOperation,
        type: 'review.comment.add',
        payload: {
          threadUid: IDS.thread,
          commentUid: IDS.legacyReply,
          parentCommentUid: IDS.comment,
          expectedCanvasRevision: 1,
          expectedThreadRevision: 1,
          body: '旧客户端无 mentions 字段',
        },
      }],
    }, { principal: { ...principal, memberId: IDS.recipient } });
    assert.equal(Object.hasOwn(legacyReply, 'notifications'), false,
      'an old no-mentions batch preserves the v1 top-level result shape');
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM collaboration_notifications').get().count, 1,
      'an old no-mentions batch performs no compatibility notification write');

    const own = database.listCollaborationNotifications({ recipientMemberId: IDS.recipient });
    assert.equal(own.length, 1);
    assert.equal(database.listCollaborationNotifications({ recipientMemberId: IDS.actor }).length, 0);
    const notificationWriteOperations = [];
    const originalWriteBoundary = database.withProjectDatabaseWrite.bind(database);
    database.withProjectDatabaseWrite = (operation, callback) => {
      notificationWriteOperations.push(operation);
      return originalWriteBoundary(operation, callback);
    };
    assert.equal(database.markCollaborationNotificationRead({
      recipientMemberId: IDS.actor,
      notificationId: own[0].id,
    }), null);
    const read = database.markCollaborationNotificationRead({
      recipientMemberId: IDS.recipient,
      notificationId: own[0].id,
      readAt: 123456,
    });
    assert.equal(read.readAt, 123456);
    assert.equal(database.markCollaborationNotificationRead({
      recipientMemberId: IDS.recipient,
      notificationId: own[0].id,
      readAt: 999999,
    }).readAt, 123456, 'read timestamp is monotonic and exact replay safe');
    assert.equal(database.listCollaborationNotifications({
      recipientMemberId: IDS.recipient,
      unreadOnly: true,
    }).length, 0);
    assert.deepEqual(notificationWriteOperations, [
      'collaboration.notification.read',
      'collaboration.notification.read',
      'collaboration.notification.read',
    ]);
    database.withProjectDatabaseWrite = originalWriteBoundary;
  } finally {
    database.close();
  }
});

test('F6 audited thread update requires both CAS revisions and materializes immutable exact decision snapshots', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    const initialCanvas = ensureCanvas(database);
    insertMember(database, IDS.actor, 'project-f6', 'canvas-f6', 'Actor');
    insertMember(database, IDS.recipient, 'project-f6', 'canvas-f6', 'Recipient');
    const created = database.createReviewThreadWithComment(reviewThreadInput(), {
      commentId: IDS.comment,
      body: '等待审批',
      actorId: IDS.actor,
      sourceOperationId: 'f6-approval-create',
    });
    assert.throws(() => database.updateReviewThreadWithAudit({
      threadId: created.id,
      expectedThreadRevision: 1,
      status: 'resolved',
    }), (error) => error.code === 'collaboration_domain_review_cas_required');

    const revisionTwo = database.saveCanvasSnapshot('canvas-f6', {
      ...initialCanvas,
      viewport: { x: 5, y: 6, zoom: 1 },
    }, { expectedRevision: 1, actorId: IDS.actor, sessionId: 'canvas-session' });
    assert.equal(revisionTwo.revision, 2);
    database.db.prepare('DELETE FROM canvas_snapshots WHERE canvas_id = ? AND revision = ?')
      .run('canvas-f6', 2);
    assert.equal(database.getCanvasSnapshotDocument('canvas-f6', 2), null);
    assert.equal(database.getCanvasSnapshotDocument('canvas-f6', 999), null);

    const approved = database.updateReviewThreadWithAudit({
      threadId: created.id,
      expectedCanvasRevision: 2,
      expectedThreadRevision: 1,
      status: 'approved',
      severity: 'normal',
      decisionCanvasRevision: 2,
      actorId: IDS.recipient,
      sourceOperationId: 'f6-approval-update',
    });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.thread.revision, 2);
    assert.equal(database.getCanvasSnapshotDocument('canvas-f6', 2).revision, 2);

    database.saveCanvasSnapshot('canvas-f6', {
      ...revisionTwo,
      viewport: { x: 8, y: 9, zoom: 1 },
    }, { expectedRevision: 2, actorId: IDS.actor, sessionId: 'canvas-session-2' });
    assert.equal(database.getReviewThread(created.id).approvalExpired, true);
    assert.equal(database.countReviewThreads({ projectId: 'project-f6', approvalExpired: true }), 1);
    assert.equal(database.countReviewThreads({ projectId: 'project-f6', approvalExpired: false }), 0);
    assert.throws(() => database.updateReviewThread(created.id, {
      expectedRevision: 2,
      reviewStatus: 'approved',
      decisionCanvasRevision: 3,
    }), (error) => error.code === 'collaboration_domain_capability_missing');
    assert.equal(database.getReviewThread(created.id).decisionCanvasRevision, 2);
    assert.throws(() => database.updateReviewThreadWithAudit({
      threadId: created.id,
      expectedCanvasRevision: 2,
      expectedThreadRevision: 2,
      status: 'resolved',
      severity: 'normal',
      decisionCanvasRevision: null,
    }), (error) => error.code === 'collaboration_domain_review_cas_conflict');

    assert.throws(() => database.db.prepare(`
      UPDATE canvas_snapshots
      SET snapshot_json = '{'
      WHERE canvas_id = ? AND revision = ?
    `).run('canvas-f6', 2),
    (error) => error.code === 'SQLITE_CONSTRAINT_TRIGGER'
      && /canvas snapshots are immutable/.test(error.message),
    'schema 29 rejects mutation of an exact decision snapshot');
    assert.equal(database.getCanvasSnapshotDocument('canvas-f6', 2).revision, 2);
  } finally {
    database.close();
  }
});

test('F6 review queries cap pages and visibility policy updates are CAS-audited atomically', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    ensureCanvas(database);
    insertMember(database, IDS.actor, 'project-f6', 'canvas-f6', 'Actor');
    for (let index = 0; index < 105; index += 1) {
      const suffix = index.toString(16).padStart(12, '0');
      database.createReviewThread(reviewThreadInput({
        id: `27000000-0000-4000-8000-${suffix}`,
        severity: index % 2 === 0 ? 'high' : 'normal',
        anchor: index % 3 === 0
          ? { kind: 'canvas', targetEntityUid: IDS.canvasEntity, x: index, y: 0 }
          : { kind: 'asset', targetEntityUid: IDS.asset },
      }));
    }
    assert.equal(database.countReviewThreads({ projectId: 'project-f6', canvasId: 'canvas-f6' }), 105);
    assert.equal(database.listReviewThreads({
      projectId: 'project-f6',
      canvasId: 'canvas-f6',
      limit: 999,
    }).length, 100);
    assert.equal(database.listReviewThreads({
      projectId: 'project-f6',
      canvasId: 'canvas-f6',
      limit: 100,
      offset: 100,
    }).length, 5);
    assert.equal(database.countReviewThreads({
      projectId: 'project-f6',
      anchorKind: 'canvas',
      severity: 'high',
      unresolved: true,
      createdBy: IDS.actor,
    }) > 0, true);

    assert.deepEqual(database.getProjectReviewVisibilityPolicy('project-f6'), {
      projectId: 'project-f6',
      hidePrompts: false,
      hideModelParameters: false,
      revision: 0,
      updatedBy: null,
      updatedAt: null,
    });
    const first = database.setProjectReviewVisibilityPolicy('project-f6', {
      hidePrompts: true,
      hideModelParameters: false,
      expectedRevision: 0,
    }, { actorId: IDS.actor, sessionId: 'policy-session' });
    assert.equal(first.revision, 1);
    assert.equal(first.hidePrompts, true);
    assert.throws(() => database.setProjectReviewVisibilityPolicy('project-f6', {
      hidePrompts: false,
      hideModelParameters: false,
      expectedRevision: 0,
    }), (error) => error.code === 'collaboration_review_visibility_policy_conflict');

    addFailureTrigger(database, 'f6_fail_policy_audit', 'audit_events', 'review.visibility-policy.update');
    assert.throws(() => database.setProjectReviewVisibilityPolicy('project-f6', {
      hidePrompts: false,
      hideModelParameters: true,
      expectedRevision: 1,
    }, { actorId: IDS.actor }), /injected failure/);
    database.db.exec('DROP TRIGGER f6_fail_policy_audit');
    assert.equal(database.getProjectReviewVisibilityPolicy('project-f6').revision, 1);
    assert.equal(database.getProjectReviewVisibilityPolicy('project-f6').hidePrompts, true);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});
