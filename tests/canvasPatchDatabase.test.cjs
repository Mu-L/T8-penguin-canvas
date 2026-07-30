const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');
const { Worker } = require('node:worker_threads');

const {
  applyCanvasOperation,
  normalizeCanvasDocument,
  validateOperation,
} = require('../backend/src/collaboration/protocol');
const {
  CANVAS_PATCH_CONTRACT,
  CANVAS_PATCH_OPERATION_TYPES,
  CanvasPatchConflictError,
  CanvasPatchConfirmationError,
  CanvasPatchPermissionError,
  CanvasPatchRevertConflictError,
  CanvasPatchValidationError,
  assertCanvasPatchCredentialAuthority,
  buildCanvasPatchPlan,
  canvasDocumentTouchesHostCredentials,
  canvasOperationsTouchHostCredentials,
  canvasPatchTouchesHostCredentials,
  canvasPatchRequestDigest,
  canvasStringContainsHostCredentialField,
  isHostCredentialFieldKey,
  normalizeCanvasPatchAuthority,
  safeCanvasPatchErrorMessage,
  scopedCanvasPatchOperationId,
  stableJson,
} = require('../backend/src/services/canvasPatch');
const {
  PROJECT_DATABASE_MIGRATIONS,
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectDatabase,
  RevisionConflictError,
} = require('../backend/src/services/projectDatabase');
const {
  PROJECT_DATABASE_MIGRATION_29_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration29');
const {
  PROJECT_DATABASE_MIGRATION_30_DOWN_SQL,
} = require('../backend/src/services/projectDatabaseMigration30');
const {
  PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS,
} = require('../backend/src/services/projectDatabaseMigration31');
const {
  assertCurrentProjectDatabaseRegistry,
  stripSchema32ForSyntheticSchema31,
} = require('./helpers/projectDatabaseVersion.cjs');

const PATCH_ID = '11111111-1111-4111-8111-111111111111';
const LOCAL_OWNER_PATCH_AUTHORITY = Object.freeze({
  source: 'local-owner', role: 'owner', capabilities: Object.freeze(['manageProviders']),
});

function patch(overrides = {}) {
  return {
    schema: CANVAS_PATCH_CONTRACT,
    id: PATCH_ID,
    baseRevision: 1,
    summary: '修复画布诊断',
    diagnosticsResolved: ['content.empty-text'],
    requiresConfirmation: true,
    operations: [{
      opId: 'attacker-op-id',
      actorId: 'forged-actor',
      sessionId: 'forged-session',
      projectId: 'forged-project',
      canvasId: 'forged-canvas',
      timestamp: 1,
      type: 'node.patch',
      payload: { nodeId: 'a', dataPatch: { prompt: 'fixed' } },
    }],
    ...overrides,
  };
}

function sha256Stable(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function quoteSqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

// TEST-ONLY fixture teardown. Production schema31 DOWN remains backup-only;
// this removes only source-controlled schema31 objects from a disposable DB.
function removeSchema31ExtensionForSyntheticSchema30(database) {
  stripSchema32ForSyntheticSchema31(database);
  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      for (const name of [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS.triggers].reverse()) {
        database.exec(`DROP TRIGGER IF EXISTS ${quoteSqlIdentifier(name)}`);
      }
      for (const name of [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS.views].reverse()) {
        database.exec(`DROP VIEW IF EXISTS ${quoteSqlIdentifier(name)}`);
      }
      for (const name of [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS.indexes].reverse()) {
        database.exec(`DROP INDEX IF EXISTS ${quoteSqlIdentifier(name)}`);
      }
      for (const name of [...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS.tables].reverse()) {
        database.exec(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(name)}`);
      }
      database.prepare('DELETE FROM schema_migration_receipts WHERE version = 31').run();
      database.prepare('DELETE FROM schema_migrations WHERE version = 31').run();
    }).immediate();
  } finally {
    database.pragma('foreign_keys = ON');
  }
  const ownedNames = Object.values(PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECTS).flat();
  const placeholders = ownedNames.map(() => '?').join(', ');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN (${placeholders})
  `).get(...ownedNames).count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migration_receipts WHERE version = 31').get().count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 31').get().count, 0);
  assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 30);
  assert.deepEqual(database.pragma('foreign_key_check'), []);
}

function rewriteAppliedPatchAsLegacyIdentityGuard(sqlite, context) {
  const row = sqlite.prepare(`
    SELECT * FROM canvas_patch_applications
    WHERE project_id = ? AND canvas_id = ? AND patch_id = ?
  `).get(context.projectId, context.canvasId, context.patchId);
  assert.ok(row);
  const operations = JSON.parse(row.forward_ops_json);
  const inverseOperations = JSON.parse(row.inverse_ops_json);
  const postconditions = JSON.parse(row.postconditions_json);
  const strippedFields = [];
  for (const condition of postconditions) {
    if (condition?.kind === 'node.added') {
      if (Object.prototype.hasOwnProperty.call(condition.node, 'legacyAliases')) {
        delete condition.node.legacyAliases;
        strippedFields.push('node.legacyAliases');
      }
    }
    if (condition?.kind === 'edge.added') {
      for (const key of ['legacyAliases', 'sourceEntityUid', 'targetEntityUid']) {
        if (Object.prototype.hasOwnProperty.call(condition.edge, key)) {
          delete condition.edge[key];
          strippedFields.push(`edge.${key}`);
        }
      }
    }
  }
  const guardDigest = sha256Stable({ operations, inverseOperations, postconditions });
  const previewDigest = sha256Stable({
    schema: row.schema,
    requestDigest: row.request_digest,
    projectId: row.project_id,
    canvasId: row.canvas_id,
    currentRevision: Number(row.base_revision),
    guardDigest,
  });
  const updated = sqlite.prepare(`
    UPDATE canvas_patch_applications
    SET postconditions_json = ?, preview_digest = ?
    WHERE project_id = ? AND canvas_id = ? AND patch_id = ?
  `).run(
    JSON.stringify(postconditions),
    previewDigest,
    row.project_id,
    row.canvas_id,
    row.patch_id,
  );
  assert.equal(updated.changes, 1);
  return { postconditions, strippedFields };
}

function seed(db, canvasId = 'canvas-patch') {
  return db.ensureCanvas(canvasId, {
    nodes: [
      {
        id: 'a',
        type: 'text',
        position: { x: 0, y: 0 },
        label: 'A',
        obsolete: true,
        data: {
          prompt: 'old',
          removeMe: 'legacy',
          apiKey: 'sk-old-secret-1234567890',
          localPath: 'C:\\Users\\alice\\private\\input.png',
        },
      },
      { id: 'b', type: 'text', position: { x: 100, y: 0 }, data: { prompt: 'B' } },
    ],
    edges: [{ id: 'edge-ab', source: 'a', target: 'b', type: 'default' }],
  }, 'project-patch');
}

function seedSchema19(filename) {
  const raw = new BetterSqlite3(filename);
  try {
    raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE canvas_documents (
        canvas_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE canvas_patch_applications (
        project_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        patch_id TEXT NOT NULL,
        schema TEXT NOT NULL CHECK(schema = 't8-canvas-patch-v1'),
        request_digest TEXT NOT NULL,
        preview_digest TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        applied_revision INTEGER NOT NULL,
        reverted_revision INTEGER,
        actor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL DEFAULT '[]',
        operation_count INTEGER NOT NULL,
        affected_node_ids_json TEXT NOT NULL DEFAULT '[]',
        affected_edge_ids_json TEXT NOT NULL DEFAULT '[]',
        changes_json TEXT NOT NULL DEFAULT '[]',
        forward_ops_json TEXT NOT NULL,
        inverse_ops_json TEXT NOT NULL,
        postconditions_json TEXT NOT NULL,
        acknowledgements_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'applied',
        created_at INTEGER NOT NULL,
        reverted_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, canvas_id, patch_id),
        FOREIGN KEY(canvas_id) REFERENCES canvas_documents(canvas_id) ON DELETE CASCADE
      );
    `);
    const insertMigration = raw.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)');
    raw.transaction(() => {
      for (let version = 1; version <= 19; version += 1) insertMigration.run(version, 1_700_000_000_000 + version);
      const document = normalizeCanvasDocument('legacy-patch-canvas', {
        nodes: [{ id: 'legacy-node', type: 'text', data: { prompt: 'preserve-me' } }],
        edges: [],
      }, { projectId: 'legacy-patch-project', revision: 7, updatedAt: 1_700_000_000_100 });
      raw.prepare(`
        INSERT INTO canvas_documents(
          canvas_id, project_id, schema_version, revision, snapshot_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        document.canvasId, document.projectId, document.schemaVersion, document.revision,
        JSON.stringify(document), 1_700_000_000_000, document.updatedAt,
      );
      raw.prepare(`
        INSERT INTO canvas_patch_applications(
          project_id, canvas_id, patch_id, schema, request_digest, preview_digest,
          base_revision, applied_revision, reverted_revision, actor_id, session_id,
          summary, diagnostics_json, operation_count, affected_node_ids_json,
          affected_edge_ids_json, changes_json, forward_ops_json, inverse_ops_json,
          postconditions_json, acknowledgements_json, status, created_at, reverted_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, '[]', 1, '[]', '[]', '[]', ?, ?, '[]', '[]', 'applied', ?, NULL, ?)
      `).run(
        document.projectId,
        document.canvasId,
        'legacy-schema19-patch',
        CANVAS_PATCH_CONTRACT,
        'a'.repeat(64),
        'b'.repeat(64),
        6,
        7,
        'legacy-member',
        'legacy-session',
        'legacy patch',
        JSON.stringify([{ type: 'viewport.set', payload: { viewport: { x: 0, y: 0, zoom: 1 } } }]),
        JSON.stringify([{ type: 'viewport.set', payload: { viewport: { x: 0, y: 0, zoom: 1 } } }]),
        1_700_000_000_200,
        1_700_000_000_200,
      );
    })();
  } finally {
    raw.close();
  }
}

test('protocol node.patch supports explicit unsets while protecting identity and rejecting phantom deletes', () => {
  const document = normalizeCanvasDocument('protocol-patch', {
    nodes: [{
      id: 'a', type: 'text', label: 'before', obsolete: true,
      data: { prompt: 'before', removeMe: true },
    }],
    edges: [],
  });
  const updated = applyCanvasOperation(document, {
    type: 'node.patch',
    payload: {
      nodeId: 'a',
      patch: { label: 'after', temporary: true },
      unsetKeys: ['obsolete', 'temporary'],
      dataPatch: { prompt: 'after', addedThenRemoved: true },
      dataUnsetKeys: ['removeMe', 'addedThenRemoved'],
    },
  }).document.nodes[0];
  assert.equal(updated.label, 'after');
  assert.equal(Object.hasOwn(updated, 'obsolete'), false);
  assert.equal(Object.hasOwn(updated, 'temporary'), false);
  assert.deepEqual(updated.data, { prompt: 'after' });

  for (const forbidden of ['id', 'entityUid', 'type']) {
    assert.throws(() => applyCanvasOperation(document, {
      type: 'node.patch', payload: { nodeId: 'a', patch: { [forbidden]: 'forged' } },
    }), /禁止修改/);
    assert.throws(() => applyCanvasOperation(document, {
      type: 'node.patch', payload: { nodeId: 'a', unsetKeys: [forbidden] },
    }), /禁止修改/);
  }
  assert.throws(() => applyCanvasOperation(document, {
    type: 'node.delete', payload: { nodeId: 'missing' },
  }), /节点不存在/);
  assert.throws(() => applyCanvasOperation(document, {
    type: 'edge.delete', payload: { edgeId: 'missing' },
  }), /连线不存在/);
  assert.throws(() => applyCanvasOperation(document, {
    type: 'node.delete', payload: { nodeId: '__proto__' },
  }), /无效/);
  assert.throws(() => applyCanvasOperation(document, {
    type: 'node.patch', payload: { nodeId: 'a', patch: { constructor: 'pollute' } },
  }), /无效字段/);
});

test('applyOperations accepts only exact opId retries and rejects scope, identity or payload collisions', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    seed(db, 'operation-id-a');
    seed(db, 'operation-id-b');
    const operation = {
      opId: 'strict-shared-operation-id',
      projectId: 'project-patch',
      canvasId: 'operation-id-a',
      actorId: 'member-a',
      sessionId: 'session-a',
      baseRevision: 1,
      clientSeq: 7,
      type: 'node.patch',
      payload: { nodeId: 'a', dataPatch: { prompt: 'first' } },
      timestamp: 1_700_000_000_000,
    };
    const first = db.applyOperations('operation-id-a', [operation], { expectedRevision: 1 });
    assert.equal(first.document.revision, 2);
    const provenanceCount = db.db.prepare('SELECT COUNT(*) AS count FROM canvas_mutation_provenance').get().count;
    const exactRetry = db.applyOperations('operation-id-a', [{ ...operation, timestamp: Date.now() }], { expectedRevision: 2 });
    assert.equal(exactRetry.acknowledgements[0].duplicate, true);
    assert.equal(exactRetry.document.revision, 2);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_mutation_provenance').get().count, provenanceCount);

    for (const collision of [
      { canvasId: 'operation-id-a', operation: { ...operation, actorId: 'member-b' } },
      { canvasId: 'operation-id-a', operation: { ...operation, sessionId: 'session-b' } },
      {
        canvasId: 'operation-id-a',
        operation: { ...operation, payload: { nodeId: 'a', dataPatch: { prompt: 'different' } } },
      },
      {
        canvasId: 'operation-id-b',
        operation: { ...operation, canvasId: 'operation-id-b', payload: { nodeId: 'a', dataPatch: { prompt: 'other-canvas' } } },
      },
    ]) {
      assert.throws(() => db.applyOperations(collision.canvasId, [collision.operation], {
        expectedRevision: db.getCanvas(collision.canvasId).revision,
      }), (error) => error?.code === 'operation_id_conflict');
    }
    assert.equal(db.getCanvas('operation-id-a').nodes.find((node) => node.id === 'a').data.prompt, 'first');
    assert.equal(db.getCanvas('operation-id-b').nodes.find((node) => node.id === 'a').data.prompt, 'old');
  } finally {
    db.close();
  }
});

test('generic operations cannot preclaim the reserved CanvasPatch operation namespace', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const document = seed(db);
    const input = patch({ id: 'doctor-patch-reserved-operation-id' });
    const reservedRevertOpId = scopedCanvasPatchOperationId(
      document.projectId,
      document.canvasId,
      input.id,
      'revert',
      0,
    );
    assert.throws(() => db.applyOperations(document.canvasId, [{
      opId: reservedRevertOpId,
      projectId: document.projectId,
      canvasId: document.canvasId,
      actorId: 'malicious-editor',
      sessionId: 'malicious-session',
      baseRevision: 1,
      clientSeq: 1,
      type: 'node.patch',
      payload: { nodeId: 'a', dataPatch: { prompt: 'preclaimed' } },
      timestamp: 1_700_000_000_000,
    }], { expectedRevision: 1 }), (error) => error?.code === 'operation_id_reserved');
    assert.equal(db.getCanvas(document.canvasId).revision, 1);

    const preview = db.previewCanvasPatch(document.canvasId, input, { actorId: 'member-a' });
    const applied = db.applyCanvasPatch(document.canvasId, input, {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'member-a',
      sessionId: 'member-session',
    });
    assert.equal(applied.revision, 2);
    const reverted = db.revertCanvasPatch(document.canvasId, input.id, {
      actorId: 'member-a',
      sessionId: 'member-session',
      expectedRevision: 2,
    });
    assert.equal(reverted.revision, 3);
    assert.equal(reverted.document.nodes.find((node) => node.id === 'a').data.prompt, 'old');
  } finally {
    db.close();
  }
});

test('operation idempotency identity survives 5000-row compaction and a real reopen', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-operation-ledger-compaction-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const originalOperation = {
    opId: 'durable-operation-before-compaction',
    projectId: 'project-patch',
    canvasId: 'operation-ledger',
    actorId: 'member-a',
    sessionId: 'session-a',
    baseRevision: 1,
    clientSeq: 7,
    type: 'node.patch',
    payload: { nodeId: 'a', dataPatch: { durableMarker: 'original' } },
    timestamp: 1_700_000_000_000,
  };
  let compactedRevision = 0;
  try {
    const first = new ProjectDatabase(filename, { autoBackup: false });
    try {
      seed(first, 'operation-ledger');
      let current = first.applyOperations('operation-ledger', [originalOperation], { expectedRevision: 1 }).document;
      for (let batch = 0; batch < 10; batch += 1) {
        const operations = Array.from({ length: 500 }, (_, index) => {
          const sequence = batch * 500 + index;
          return {
            opId: `compaction-filler-${sequence}`,
            projectId: 'project-patch',
            canvasId: 'operation-ledger',
            actorId: 'compaction-writer',
            sessionId: 'compaction-session',
            clientSeq: index,
            type: 'node.patch',
            payload: { nodeId: 'a', dataPatch: { compactionMarker: sequence } },
            timestamp: 1_700_000_001_000 + sequence,
          };
        });
        current = first.applyOperations('operation-ledger', operations, {
          expectedRevision: current.revision,
        }).document;
      }
      compactedRevision = current.revision;
      assert.equal(compactedRevision, 5002);
      assert.equal(first.db.prepare('SELECT 1 FROM canvas_operations WHERE op_id = ?').get(originalOperation.opId), undefined);
      assert.equal(first.db.prepare('SELECT 1 AS ok FROM canvas_operation_idempotency WHERE op_id = ?').get(originalOperation.opId).ok, 1);
    } finally {
      first.close();
    }

    const reopened = new ProjectDatabase(filename, { autoBackup: false });
    try {
      const exactRetry = reopened.applyOperations('operation-ledger', [{
        ...originalOperation,
        timestamp: Date.now(),
      }], { expectedRevision: compactedRevision });
      assert.equal(exactRetry.document.revision, compactedRevision);
      assert.deepEqual(exactRetry.acknowledgements, [{
        opId: originalOperation.opId,
        revision: 2,
        duplicate: true,
      }]);
      assert.throws(() => reopened.applyOperations('operation-ledger', [{
        ...originalOperation,
        payload: { nodeId: 'a', dataPatch: { durableMarker: 'collision' } },
      }], { expectedRevision: compactedRevision }), (error) => error?.code === 'operation_id_conflict');
      assert.equal(reopened.getCanvas('operation-ledger').revision, compactedRevision);
      assert.equal(reopened.db.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('canvas patch contract is strict and preview is deterministic, redacted and read-only', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    seed(db);
    const input = patch({
      operations: [{
        type: 'node.patch',
        payload: {
          nodeId: 'a',
          patch: { label: 'updated' },
          unsetKeys: ['obsolete'],
          dataPatch: {
            apiKey: 'sk-new-secret-1234567890',
            localPath: 'D:\\private\\output.png',
            binary: `data:image/png;base64,${'A'.repeat(256)}`,
          },
          dataUnsetKeys: ['removeMe'],
        },
      }],
    });
    const before = db.getCanvas('canvas-patch');
    const first = db.previewCanvasPatch('canvas-patch', input, {
      actorId: 'member-a', authority: LOCAL_OWNER_PATCH_AUTHORITY,
    });
    const second = db.previewCanvasPatch('canvas-patch', JSON.parse(JSON.stringify(input)), {
      actorId: 'member-a', authority: LOCAL_OWNER_PATCH_AUTHORITY,
    });
    assert.deepEqual(second, first);
    assert.equal(first.patchId, PATCH_ID);
    assert.equal(first.baseRevision, 1);
    assert.equal(first.currentRevision, 1);
    assert.match(first.previewDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(first.affectedNodeIds, ['a']);
    assert.deepEqual(first.affectedEdgeIds, []);
    assert.deepEqual(first.warnings, []);
    assert.deepEqual(Object.keys(first.changes[0]).sort(), [
      'after', 'before', 'fields', 'operationIndex', 'targetId', 'targetType', 'type',
    ]);
    assert.deepEqual(first.changes[0].fields, [
      'data.apiKey', 'data.binary', 'data.localPath', 'data.removeMe', 'label', 'obsolete',
    ]);
    const serialized = JSON.stringify(first);
    assert.doesNotMatch(serialized, /sk-(?:old|new)-secret/i);
    assert.doesNotMatch(serialized, /Users\\\\alice|D:\\\\private|AAAAAA/);
    assert.deepEqual(db.getCanvas('canvas-patch'), before);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_patch_applications').get().count, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_mutation_provenance').get().count, 0);
    assert.equal(db.listAuditEvents({ projectId: 'project-patch', canvasId: 'canvas-patch' }).length, 0);

    for (const invalid of [
      { ...input, schema: 'wrong-contract' },
      { ...input, id: '' },
      { ...input, baseRevision: undefined },
      { ...input, summary: '' },
      { ...input, diagnosticsResolved: undefined },
      { ...input, requiresConfirmation: false },
      { ...input, operations: [] },
      { ...input, operations: Array.from({ length: 101 }, () => input.operations[0]) },
    ]) {
      assert.throws(() => db.previewCanvasPatch('canvas-patch', invalid), CanvasPatchValidationError);
    }
  } finally {
    db.close();
  }
});

test('credential field detection is obfuscation-resistant without blocking ordinary prompt and token-count fields', () => {
  const credentialKeys = [
    'apiKey', 'API-KEY', 'a_p_i_k_e_y', 'a.p.i.k.e.y',
    'a%70i%4Bey', '%2561%2570%2569%254b%2565%2579',
    'a\\u0070iKey', 'a&#112;iKey', `a\u200bpi\u2060Key`, 'ａｐｉＫｅｙ',
    'аpiKey', 'YXBpS2V5', '6170694b6579',
    'token', 'refresh_token', 'modelScopeToken', 'clientSecret', 'password', 'cookie',
    'authorization', 'provider.credentials', 'private-key', 'session_token',
    '密钥', '凭据',
  ];
  for (const key of credentialKeys) assert.equal(isHostCredentialFieldKey(key), true, key);
  for (const key of [
    'prompt', 'negativePrompt', 'systemPrompt', 'promptExtend', 'description',
    'maxTokens', 'tokenCount', 'inputTokens', 'outputTokenCount',
    'cacheKey', 'resourceKey', 'objectKey', 'modelKey', 'keyboardShortcut',
  ]) assert.equal(isHostCredentialFieldKey(key), false, key);
  for (const url of [
    'https://example.test/?state=STATE_SECRET',
    'https://example.test/?code=AUTH_CODE_SECRET',
    'https://example.test/oauth#access_token=FRAGMENT_ACCESS_SECRET',
    'https://example.test/#/callback?code=HASH_CODE_SECRET&state=HASH_STATE_SECRET',
    'https://user:password@example.test/path',
    `https://example.test/?next=${encodeURIComponent('https://auth.example/callback?code=NESTED_CODE_SECRET')}`,
    `https://example.test/?payload=${Buffer.from(JSON.stringify({ apiKey: 'NESTED_JSON_SECRET' })).toString('base64url')}`,
    'https://example.test/callback#next=apiKey%3DNESTED_ASSIGNMENT_SECRET',
    'https://example.test/callback?next=access_token%3DNESTED_QUERY_ASSIGNMENT_SECRET',
    'https://example.test/callback?foo=1;code=SEMICOLON_CODE_SECRET',
    'https://example.test/callback?foo=1&amp;code=HTML_CODE_SECRET',
  ]) assert.equal(canvasStringContainsHostCredentialField(url), true, url);
  assert.equal(canvasStringContainsHostCredentialField('https://example.test/result.png?page=2&productCode=ABC'), false);

  const document = normalizeCanvasDocument('credential-service', {
    nodes: [{ id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { prompt: 'before' } }],
    edges: [],
  }, { projectId: 'project-patch', revision: 1 });
  const normalAgentPatch = patch({
    id: 'agent-normal-fields',
    operations: [{
      type: 'node.patch',
      payload: {
        nodeId: 'a',
        dataPatch: {
          prompt: 'after; 示例文本 {"apiKey":"fictional-not-a-setting"}', negativePrompt: 'none', maxTokens: 2048, tokenCount: 12,
          cacheKey: 'cache-a', resourceKey: 'asset-a', nestedPrompt: { text: 'ordinary' },
        },
      },
    }],
  });
  assert.equal(canvasPatchTouchesHostCredentials(normalAgentPatch), false);
  const normalPlan = buildCanvasPatchPlan(document, normalAgentPatch, {
    authority: { source: 'agent', role: 'owner', capabilities: ['manageProviders'] },
  });
  assert.equal(normalPlan.resultingDocument.nodes[0].data.prompt, 'after; 示例文本 {"apiKey":"fictional-not-a-setting"}');
  for (const value of [
    { items: [['apiKey', 'PAIR_SECRET']] },
    { tabs: [['access_token', 'TAB_PAIR_SECRET']] },
    { rawPairs: JSON.stringify([['apiKey', 'JSON_PAIR_SECRET']]) },
  ]) {
    assert.equal(canvasOperationsTouchHostCredentials(document, [{
      type: 'node.patch',
      payload: { nodeId: 'a', dataPatch: value },
    }]), true);
  }
  assert.equal(canvasOperationsTouchHostCredentials(document, [{
    type: 'node.patch',
    payload: { nodeId: 'a', dataPatch: { items: [['prompt', 'visible']] } },
  }]), false);
  for (const plaintext of [
    ['sk-', 'abcdefghijklmnopqrstuvwxyz123456'].join(''),
    'Bearer test-bearer-token-value',
    ['ghp_', 'A'.repeat(36)].join(''),
    ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
    ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'c2lnbmF0dXJl'].join('.'),
    'data:image/png;base64,QUJDREVGRw==',
  ]) {
    assert.equal(canvasOperationsTouchHostCredentials(document, [{
      type: 'node.patch',
      payload: { nodeId: 'a', dataPatch: { prompt: plaintext } },
    }]), true, plaintext);
  }
  assert.equal(canvasDocumentTouchesHostCredentials(normalizeCanvasDocument('oauth-context', {
    nodes: [{
      id: 'oauth',
      type: 'text',
      position: { x: 0, y: 0 },
      data: {
        oauthResponse: { code: 'OBJECT_CODE_SECRET', state: 'OBJECT_STATE_SECRET' },
        callbackParams: { code: 'CALLBACK_CODE_SECRET' },
        oauthResponseRaw: JSON.stringify({ code: 'RAW_CODE_SECRET', state: 'RAW_STATE_SECRET' }),
      },
    }],
    edges: [],
  }, { projectId: 'project-patch', revision: 1 })), true);
  assert.equal(canvasPatchTouchesHostCredentials(patch({
    id: 'agent-normal-generic-keys',
    operations: [{
      type: 'node.patch',
      payload: {
        nodeId: 'a',
        dataPatch: {
          parameter: { key: 'prompt', value: 'ordinary value' },
          tabs: [{ key: 'timeline', label: '时间线' }],
        },
      },
    }],
  })), false);
  assert.equal(canvasPatchTouchesHostCredentials(patch({
    id: 'agent-real-feishu-node-add',
    operations: [{
      type: 'node.add',
      payload: {
        node: {
          id: 'feishu-new',
          type: 'feishu-bitable-input',
          position: { x: 100, y: 0 },
          data: {
            feishuAppToken: 'bascnPublicResourceId',
            feishuRows: [{
              appToken: 'bascnPublicResourceId',
              media: [{ fileToken: 'boxcnPublicFileId' }],
            }],
          },
        },
      },
    }],
  })), false);
  assert.equal(canvasPatchTouchesHostCredentials(patch({
    id: 'agent-fake-feishu-container-node-add',
    operations: [{
      type: 'node.add',
      payload: {
        node: {
          id: 'text-with-fake-feishu-container',
          type: 'text',
          position: { x: 100, y: 0 },
          data: {
            feishuRows: [{
              appToken: 'must-remain-forbidden',
              media: [{ fileToken: 'must-remain-forbidden' }],
            }],
          },
        },
      },
    }],
  })), true);
  assert.equal(canvasPatchTouchesHostCredentials(patch({
    id: 'agent-generic-key-credential-descriptor',
    operations: [{
      type: 'node.patch',
      payload: {
        nodeId: 'a',
        dataPatch: { parameter: { key: 'apiKey', value: 'must remain forbidden' } },
      },
    }],
  })), true);
  assert.equal(canvasPatchTouchesHostCredentials(patch({
    id: 'agent-id-credential-descriptor',
    operations: [{
      type: 'node.patch',
      payload: {
        nodeId: 'a',
        dataPatch: {
          providerParameter: { id: 'apiKey', value: 'must remain forbidden' },
          authorizationParameter: { id: 'authorization', defaultValue: 'must remain forbidden' },
        },
      },
    }],
  })), true);
  assert.equal(canvasPatchTouchesHostCredentials(patch({
    id: 'agent-bare-generic-key',
    operations: [{
      type: 'node.patch',
      payload: { nodeId: 'a', dataPatch: { key: 'opaque-value' } },
    }],
  })), true);
  assert.equal(canvasPatchTouchesHostCredentials(patch({
    id: 'agent-fake-feishu-scope',
    operations: [{
      type: 'node.patch',
      payload: {
        nodeId: 'a',
        dataPatch: { feishuAppToken: 'marker', fileToken: 'opaque-value' },
      },
    }],
  })), true);
  for (const [field, value] of [
    ['comfyMakerWorkflowRaw', '{"1":{"inputs":{"key":"opaque-value"}}}'],
    ['workflowJson', Buffer.from('{"apiKey":"opaque-value"}').toString('base64')],
    ['providerConfig', Buffer.from('{"apiKey":"opaque-value"}').toString('hex')],
  ]) {
    assert.equal(canvasPatchTouchesHostCredentials(patch({
      id: `agent-structured-${field}`,
      operations: [{
        type: 'node.patch',
        payload: { nodeId: 'a', dataPatch: { [field]: value } },
      }],
    })), true, field);
  }
  assert.equal(canvasPatchTouchesHostCredentials(patch({
    id: 'agent-oversized-structured-workflow',
    operations: [{
      type: 'node.patch',
      payload: {
        nodeId: 'a',
        dataPatch: {
          comfyMakerWorkflowRaw: JSON.stringify({
            padding: 'x'.repeat((512 * 1024) + 1024),
            apiKey: 'opaque-value',
          }),
        },
      },
    }],
  })), true);
  const sensitiveDocument = normalizeCanvasDocument('credential-operation-scope', {
    nodes: [{
      id: 'sensitive',
      type: 'text',
      position: { x: 0, y: 0 },
      data: { prompt: 'before', apiKey: 'host-owned-value' },
    }],
    edges: [],
  }, { projectId: 'project-patch', revision: 1 });
  assert.equal(canvasDocumentTouchesHostCredentials(sensitiveDocument), true);
  assert.equal(canvasOperationsTouchHostCredentials(sensitiveDocument, [{
    type: 'node.patch',
    payload: { nodeId: 'sensitive', dataPatch: { prompt: 'ordinary edit' } },
  }]), false);
  assert.equal(canvasOperationsTouchHostCredentials(sensitiveDocument, [{
    type: 'node.patch',
    payload: { nodeId: 'sensitive', unsetKeys: ['data'] },
  }]), true);
  assert.equal(canvasOperationsTouchHostCredentials(sensitiveDocument, [{
    type: 'node.patch',
    payload: { nodeId: 'sensitive', patch: { data: {} } },
  }]), true);
  assert.equal(canvasOperationsTouchHostCredentials(sensitiveDocument, [{
    type: 'node.delete',
    payload: { nodeId: 'sensitive' },
  }]), true);
  const sensitiveEntityUid = sensitiveDocument.nodes[0].entityUid;
  assert.equal(canvasOperationsTouchHostCredentials(sensitiveDocument, [{
    type: 'node.patch',
    payload: { nodeId: sensitiveEntityUid, unsetKeys: ['data'] },
  }]), true);
  assert.equal(canvasOperationsTouchHostCredentials(sensitiveDocument, [{
    type: 'node.delete',
    payload: { nodeId: sensitiveEntityUid },
  }]), true);
  const realFeishuDocument = normalizeCanvasDocument('credential-real-feishu-scope', {
    nodes: [{
      id: 'feishu',
      type: 'feishu-bitable-input',
      position: { x: 0, y: 0 },
      data: {
        feishuAppToken: 'bascnExistingResourceId',
        feishuRows: [{
          appToken: 'bascnExistingResourceId',
          media: [{ fileToken: 'boxcnExistingFileId' }],
        }],
        feishuBitableRows: [{
          appToken: 'bascnExistingBitableResourceId',
          fields: { attachment: [{ file_token: 'boxcnExistingRawFieldFileId' }] },
          rowData: { attachment: [{ fileToken: 'boxcnExistingRowDataFileId' }] },
          media: [{ fileToken: 'boxcnExistingBitableFileId' }],
          attachments: [{ fileToken: 'boxcnExistingAttachmentFileId' }],
        }],
        feishuRecords: [{
          fields: { attachment: [{ file_token: 'boxcnExistingRecordFileId' }] },
        }],
        feishuWriteResult: [{
          fields: { attachment: [{ file_token: 'boxcnExistingWriteResultFileId' }] },
        }],
        metadata: {
          feishuBitable: {
            appToken: 'bascnExistingMetadataContainerResourceId',
            rows: [{
              appToken: 'bascnExistingMetadataResourceId',
              media: [{ fileToken: 'boxcnExistingMetadataFileId' }],
            }],
          },
          feishuBitableWrite: { appToken: 'bascnExistingWriteResourceId' },
        },
      },
    }],
    edges: [],
  }, { projectId: 'project-patch', revision: 1 });
  assert.equal(canvasDocumentTouchesHostCredentials(realFeishuDocument), false);
  assert.equal(canvasOperationsTouchHostCredentials(realFeishuDocument, [{
    type: 'node.patch',
    payload: {
      nodeId: 'feishu',
      dataPatch: {
        feishuRows: [{
          appToken: 'bascnNextResourceId',
          media: [{ fileToken: 'boxcnNextFileId' }],
        }],
        feishuBitableRows: [{
          appToken: 'bascnNextBitableResourceId',
          fields: { attachment: [{ file_token: 'boxcnNextRawFieldFileId' }] },
          rowData: { attachment: [{ fileToken: 'boxcnNextRowDataFileId' }] },
          media: [{ fileToken: 'boxcnNextBitableFileId' }],
          attachments: [{ fileToken: 'boxcnNextAttachmentFileId' }],
        }],
        feishuRecords: [{
          fields: { attachment: [{ file_token: 'boxcnNextRecordFileId' }] },
        }],
        feishuWriteResult: [{
          fields: { attachment: [{ file_token: 'boxcnNextWriteResultFileId' }] },
        }],
        metadata: {
          feishuBitable: {
            appToken: 'bascnNextMetadataContainerResourceId',
            rows: [{
              appToken: 'bascnNextMetadataResourceId',
              media: [{ fileToken: 'boxcnNextMetadataFileId' }],
            }],
          },
          feishuBitableWrite: { appToken: 'bascnNextWriteResourceId' },
        },
      },
    },
  }]), false);
  assert.equal(canvasOperationsTouchHostCredentials(realFeishuDocument, [{
    type: 'node.patch',
    payload: { nodeId: 'feishu', dataUnsetKeys: ['feishuAppToken'] },
  }]), false);
  assert.equal(canvasOperationsTouchHostCredentials(realFeishuDocument, [{
    type: 'node.patch',
    payload: {
      nodeId: 'feishu',
      dataUnsetKeys: ['feishuAppToken', 'feishuOutputAppToken'],
    },
  }]), false);
  assert.equal(canvasOperationsTouchHostCredentials(realFeishuDocument, [{
    type: 'node.patch',
    payload: {
      nodeId: 'feishu',
      dataPatch: {
        ignored: {
          feishuRows: [{
            appToken: 'NESTED_FAKE_APP_SECRET',
            media: [{ fileToken: 'NESTED_FAKE_FILE_SECRET' }],
          }],
        },
      },
    },
  }]), true);
  const smuggledMove = {
    type: 'node.move',
    payload: {
      nodeId: 'feishu',
      position: { x: 20, y: 30 },
      junk: { appToken: 'MOVE_ENVELOPE_SECRET' },
    },
  };
  assert.equal(canvasOperationsTouchHostCredentials(realFeishuDocument, [smuggledMove]), true);
  assert.throws(() => validateOperation(smuggledMove), /node\.move\.payload 包含不支持字段: junk/);
  const realFeishuPatch = patch({
    id: 'agent-real-feishu-contextual-patch',
    operations: [{
      type: 'node.patch',
      payload: {
        nodeId: 'feishu',
        dataPatch: {
          feishuRows: [{
            appToken: 'bascnPlanResourceId',
            media: [{ fileToken: 'boxcnPlanFileId' }],
          }],
        },
      },
    }],
  });
  assert.equal(canvasPatchTouchesHostCredentials(realFeishuPatch), true);
  const realFeishuPlan = buildCanvasPatchPlan(realFeishuDocument, realFeishuPatch, {
    authority: { source: 'agent', role: 'owner', capabilities: ['editGraph'] },
  });
  assert.equal(
    realFeishuPlan.resultingDocument.nodes[0].data.feishuRows[0].media[0].fileToken,
    'boxcnPlanFileId',
  );
  const fakeFeishuDocument = normalizeCanvasDocument('credential-fake-feishu-scope', {
    nodes: [{
      id: 'text',
      type: 'text',
      position: { x: 0, y: 0 },
      data: { prompt: 'ordinary' },
    }],
    edges: [],
  }, { projectId: 'project-patch', revision: 1 });
  assert.equal(canvasOperationsTouchHostCredentials(fakeFeishuDocument, [{
    type: 'node.patch',
    payload: {
      nodeId: 'text',
      dataUnsetKeys: ['apiKey', 'accessToken'],
    },
  }]), true);
  assert.equal(canvasOperationsTouchHostCredentials(fakeFeishuDocument, [{
    type: 'node.patch',
    payload: {
      nodeId: 'text',
      dataPatch: {
        feishuRows: [{
          appToken: 'must-remain-forbidden',
          media: [{ fileToken: 'must-remain-forbidden' }],
        }],
      },
    },
  }]), true);
  const sensitiveEdgeDocument = normalizeCanvasDocument('credential-edge-scope', {
    nodes: [
      { id: 'left', type: 'text', position: { x: 0, y: 0 }, data: { prompt: 'left' } },
      { id: 'right', type: 'text', position: { x: 100, y: 0 }, data: { prompt: 'right' } },
    ],
    edges: [{
      id: 'sensitive-edge',
      source: 'left',
      target: 'right',
      data: { accessToken: 'host-owned-edge-value' },
    }],
  }, { projectId: 'project-patch', revision: 1 });
  assert.equal(canvasOperationsTouchHostCredentials(sensitiveEdgeDocument, [{
    type: 'node.delete',
    payload: { nodeId: sensitiveEdgeDocument.nodes[0].entityUid },
  }]), true);
  assert.equal(canvasOperationsTouchHostCredentials(sensitiveEdgeDocument, [{
    type: 'edge.delete',
    payload: { edgeId: sensitiveEdgeDocument.edges[0].entityUid },
  }]), true);

  const authorities = [
    { source: 'agent', role: 'owner', capabilities: ['manageProviders'], canManageHostCredentials: true },
    { source: 'collaboration', role: 'editor', capabilities: ['editGraph', 'manageProviders'], canManageHostCredentials: true },
    { source: 'collaboration', role: 'reviewer', capabilities: ['manageProviders'], canManageHostCredentials: true },
  ];
  const deniedPatches = [
    patch({
      id: 'agent-sensitive-nested-patch',
      operations: [{
        type: 'node.patch',
        payload: { nodeId: 'a', dataPatch: { provider: { credentials: { 'a%70i%4Bey': 'never-echo-this' } } } },
      }],
    }),
    patch({
      id: 'agent-sensitive-unset',
      operations: [{ type: 'node.patch', payload: { nodeId: 'a', dataUnsetKeys: ['%2561%2570%2569%254b%2565%2579'] } }],
    }),
    patch({
      id: 'agent-sensitive-add',
      operations: [{
        type: 'node.add',
        payload: { node: { id: 'new-sensitive', type: 'text', position: { x: 1, y: 1 }, apiKey: 'never-echo-this', data: { config: { clientSecret: 'never-echo-this' } } } },
      }],
    }),
    patch({
      id: 'agent-sensitive-restore',
      operations: [{
        type: 'node.restore',
        payload: { node: { id: 'restored-sensitive', type: 'text', position: { x: 2, y: 2 }, data: { headers: { authorization: 'never-echo-this' } } } },
      }],
    }),
    patch({
      id: 'agent-sensitive-stringified-config',
      operations: [{
        type: 'node.patch',
        payload: { nodeId: 'a', dataPatch: { providerConfig: '%7B%22api%254Bey%22%3A%22never-echo-this%22%7D' } },
      }],
    }),
    patch({
      id: 'agent-sensitive-header-tuples',
      operations: [{
        type: 'node.patch',
        payload: { nodeId: 'a', dataPatch: { requestHeaders: [['Authori%7Aation', 'never-echo-this']] } },
      }],
    }),
  ];
  for (const deniedPatch of deniedPatches) {
    assert.equal(canvasPatchTouchesHostCredentials(deniedPatch), true);
    for (const authority of authorities) {
      let caught = null;
      try {
        buildCanvasPatchPlan(document, deniedPatch, { authority });
      } catch (error) {
        caught = error;
      }
      assert.equal(caught?.code, 'canvas_patch_host_credentials_forbidden');
      assert.equal(caught?.status, 403);
      assert.doesNotMatch(JSON.stringify({ code: caught?.code, message: caught?.message }), /api.?key|clientsecret|authorization|never-echo|%25|%70/i);
    }
  }

  const localOwnerAuthority = normalizeCanvasPatchAuthority({
    authority: { source: 'local-owner', role: 'owner', capabilities: ['manageProviders'] },
  });
  assert.equal(localOwnerAuthority.canManageHostCredentials, true);
  const localOwnerPatch = patch({
    id: 'local-owner-sensitive-patch',
    operations: [{ type: 'node.patch', payload: { nodeId: 'a', dataPatch: { apiKey: 'local-owner-value' } } }],
  });
  assert.throws(() => assertCanvasPatchCredentialAuthority(localOwnerPatch), (error) => (
    error?.code === 'canvas_patch_host_credentials_forbidden'
  ));
  assert.doesNotThrow(() => assertCanvasPatchCredentialAuthority(localOwnerPatch, {
    authority: { source: 'local-owner', role: 'owner', capabilities: ['manageProviders'] },
  }));
  const ownerPlan = buildCanvasPatchPlan(document, localOwnerPatch, {
    authority: { source: 'local-owner', role: 'owner', capabilities: ['manageProviders'] },
  });
  assert.equal(ownerPlan.resultingDocument.nodes[0].data.apiKey, 'local-owner-value');
  assert.equal(ownerPlan.preview.changes[0].after['data.apiKey'], '[redacted]');
});

test('database enforces credential authority before duplicate lookup and leaves denied attempts unaudited', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    seed(db, 'credential-database');
    const ownerPatch = patch({
      id: 'credential-owner-apply',
      operations: [{
        type: 'node.patch',
        payload: { nodeId: 'a', dataPatch: { apiKey: 'owner-new-private-value', prompt: 'owner prompt' } },
      }],
    });
    const ownerAuthority = { source: 'local-owner', role: 'owner', capabilities: ['manageProviders'] };
    const preview = db.previewCanvasPatch('credential-database', ownerPatch, {
      actorId: 'local-owner', sessionId: 'local-session', authority: ownerAuthority,
    });
    assert.equal(preview.changes[0].after['data.apiKey'], '[redacted]');
    const applied = db.applyCanvasPatch('credential-database', ownerPatch, {
      actorId: 'local-owner', sessionId: 'local-session', authority: ownerAuthority,
      previewDigest: preview.previewDigest, confirmed: true,
    });
    assert.equal(applied.revision, 2);
    assert.equal(applied.document.nodes.find((node) => node.id === 'a').data.apiKey, 'owner-new-private-value');

    for (const authority of [
      { source: 'agent', role: 'owner', capabilities: ['manageProviders'], canManageHostCredentials: true },
      { source: 'collaboration', role: 'editor', capabilities: ['editGraph', 'manageProviders'], canManageHostCredentials: true },
    ]) {
      assert.throws(() => db.applyCanvasPatch('credential-database', ownerPatch, {
        actorId: 'local-owner', sessionId: 'local-session', authority,
        previewDigest: preview.previewDigest, confirmed: true,
      }), (error) => error?.code === 'canvas_patch_host_credentials_forbidden');
    }

    const editorUnset = patch({
      id: 'credential-editor-unset',
      baseRevision: 1,
      operations: [{ type: 'node.patch', payload: { nodeId: 'a', dataUnsetKeys: ['a%70i%4Bey'] } }],
    });
    assert.throws(() => db.previewCanvasPatch('credential-database', editorUnset, {
      actorId: 'remote-editor', sessionId: 'remote-session',
      authority: { source: 'collaboration', role: 'editor', capabilities: ['editGraph'] },
    }), (error) => error?.code === 'canvas_patch_host_credentials_forbidden');

    assert.equal(db.getCanvas('credential-database').revision, 2);
    assert.equal(db.getCanvas('credential-database').nodes.find((node) => node.id === 'a').data.apiKey, 'owner-new-private-value');
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_patch_applications').get().count, 1);
    const audit = db.listAuditEvents({
      projectId: 'project-patch', canvasId: 'credential-database', action: 'canvas.patch.apply',
    });
    assert.equal(audit.length, 1);
    assert.doesNotMatch(JSON.stringify(audit), /owner-new-private-value|a%70i%4Bey/i);
  } finally {
    db.close();
  }
});

test('database preview and apply use authoritative Feishu node context for public resource tokens', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    db.ensureCanvas('feishu-contextual-patch', {
      nodes: [{
        id: 'feishu',
        type: 'feishu-bitable-input',
        position: { x: 0, y: 0 },
        data: {
          feishuAppToken: 'bascnExistingResourceId',
          feishuRows: [{
            appToken: 'bascnExistingResourceId',
            media: [{ fileToken: 'boxcnExistingFileId' }],
          }],
        },
      }],
      edges: [],
    }, 'project-patch');
    const input = patch({
      id: 'feishu-contextual-database-patch',
      operations: [{
        type: 'node.patch',
        payload: {
          nodeId: 'feishu',
          dataPatch: {
            feishuAppToken: 'bascnNextResourceId',
            feishuRows: [{
              appToken: 'bascnNextResourceId',
              media: [{ fileToken: 'boxcnNextFileId' }],
            }],
          },
        },
      }],
    });
    const authority = { source: 'agent', role: 'owner', capabilities: ['editGraph'] };
    const preview = db.previewCanvasPatch('feishu-contextual-patch', input, {
      actorId: 'canvas-agent',
      sessionId: 'canvas-agent-session',
      authority,
    });
    const applied = db.applyCanvasPatch('feishu-contextual-patch', input, {
      actorId: 'canvas-agent',
      sessionId: 'canvas-agent-session',
      authority,
      previewDigest: preview.previewDigest,
      confirmed: true,
    });
    assert.equal(applied.revision, 2);
    assert.equal(
      applied.document.nodes[0].data.feishuRows[0].media[0].fileToken,
      'boxcnNextFileId',
    );
  } finally {
    db.close();
  }
});

test('public digest and plan helpers cannot bypass validation and the operation type export is immutable', () => {
  const document = normalizeCanvasDocument('direct-service', {
    nodes: [{ id: 'a', type: 'text', data: {} }],
    edges: [],
  });
  const bypass = {
    schema: CANVAS_PATCH_CONTRACT,
    id: 'doctor-patch-direct',
    baseRevision: 1,
    summary: '',
    diagnosticsResolved: [],
    requiresConfirmation: true,
    operations: [{ type: 'node.patch', payload: { nodeId: 'a', dataPatch: { value: 1 } } }],
  };
  assert.throws(() => canvasPatchRequestDigest(bypass), CanvasPatchValidationError);
  assert.throws(() => buildCanvasPatchPlan(document, bypass), CanvasPatchValidationError);
  assert.throws(() => canvasPatchRequestDigest({ ...patch(), unknownTopLevel: true }), CanvasPatchValidationError);
  assert.throws(() => CANVAS_PATCH_OPERATION_TYPES.push('unsafe.operation'), TypeError);
  assert.equal(CANVAS_PATCH_OPERATION_TYPES.includes('unsafe.operation'), false);
});

test('all protocol operation kinds have preview, atomic apply and inverse-operation revert coverage', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    seed(db);
    const input = patch({
      id: 'doctor-patch-full-operation-matrix',
      diagnosticsResolved: [],
      operations: [
        { type: 'node.add', payload: { node: { id: 'c', type: 'text', position: { x: 200, y: 0 }, data: { prompt: 'C' } } } },
        { type: 'node.move', payload: { nodeId: 'a', position: { x: 40, y: 50 } } },
        { type: 'edge.add', payload: { edge: { id: 'edge-bc', source: 'b', target: 'c', type: 'default' } } },
        { type: 'viewport.set', payload: { viewport: { x: 10, y: 20, zoom: 1.5 } } },
      ],
    });
    const preview = db.previewCanvasPatch('canvas-patch', input, { authority: LOCAL_OWNER_PATCH_AUTHORITY });
    assert.deepEqual(preview.changes.map((change) => change.type), [
      'node.add', 'node.move', 'edge.add', 'viewport.set',
    ]);
    assert.deepEqual(preview.affectedNodeIds, ['a', 'b', 'c']);
    assert.deepEqual(preview.affectedEdgeIds, ['edge-bc']);
    assert.deepEqual(preview.changes[2].relatedNodeIds, ['b', 'c']);

    const applied = db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'member-a',
    });
    assert.equal(applied.revision, 5);
    assert.deepEqual(applied.document.nodes.find((node) => node.id === 'a').position, { x: 40, y: 50 });
    assert.equal(applied.document.nodes.some((node) => node.id === 'c'), true);
    assert.equal(applied.document.edges.some((edge) => edge.id === 'edge-bc'), true);
    assert.deepEqual(applied.document.viewport, { x: 10, y: 20, zoom: 1.5 });
    const persisted = JSON.parse(db.db.prepare(`
      SELECT snapshot_json FROM canvas_documents WHERE canvas_id = ?
    `).get('canvas-patch').snapshot_json);
    const loaded = db.getCanvas('canvas-patch');
    assert.deepEqual(persisted, applied.document);
    assert.deepEqual(loaded, applied.document);
    const nodeB = loaded.nodes.find((node) => node.id === 'b');
    const nodeC = loaded.nodes.find((node) => node.id === 'c');
    const edgeBC = loaded.edges.find((edge) => edge.id === 'edge-bc');
    assert.deepEqual(nodeC.legacyAliases, ['c']);
    assert.deepEqual(edgeBC.legacyAliases, ['edge-bc']);
    assert.equal(edgeBC.sourceEntityUid, nodeB.entityUid);
    assert.equal(edgeBC.targetEntityUid, nodeC.entityUid);

    const reverted = db.revertCanvasPatch('canvas-patch', input.id, {
      actorId: 'member-a', expectedRevision: 5,
    });
    assert.equal(reverted.revision, 9);
    assert.deepEqual(reverted.document.nodes.find((node) => node.id === 'a').position, { x: 0, y: 0 });
    assert.equal(reverted.document.nodes.some((node) => node.id === 'c'), false);
    assert.equal(reverted.document.edges.some((edge) => edge.id === 'edge-bc'), false);
    assert.deepEqual(reverted.document.viewport, { x: 0, y: 0, zoom: 1 });
  } finally {
    db.close();
  }
});

test('project-only unverified references force snapshot fallback while exact deltas and stable aliases stay safe', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const simpleBase = seed(db, 'canvas-simple-project-delta');
    const simpleResult = db.applyOperations('canvas-simple-project-delta', [{
      opId: 'simple-project-delta',
      type: 'node.patch',
      payload: { nodeId: 'a', dataPatch: { label: 'plain-text' } },
    }], { expectedRevision: 1 });
    assert.equal(db.db.prepare(`
      SELECT requires_snapshot FROM canvas_operations WHERE op_id = ?
    `).get('simple-project-delta').requires_snapshot, 0);
    const simpleSync = db.syncCanvas('canvas-simple-project-delta', 1);
    assert.equal(simpleSync.mode, 'operations');
    const simpleReplay = applyCanvasOperation(simpleBase, simpleSync.operations[0]).document;
    assert.deepEqual(simpleReplay.nodes, simpleResult.document.nodes);
    assert.deepEqual(simpleReplay.edges, simpleResult.document.edges);

    seed(db, 'canvas-derived-project-delta');
    const derivedResult = db.applyOperations('canvas-derived-project-delta', [{
      opId: 'derived-project-delta',
      type: 'node.patch',
      payload: { nodeId: 'a', dataPatch: { sourceAssetId: 'asset-x' } },
    }], { expectedRevision: 1 });
    const derivedNode = derivedResult.document.nodes.find((node) => node.id === 'a');
    assert.equal(derivedNode.data.sourceAssetEntityUid, undefined);
    assert.deepEqual(derivedNode.data.unverifiedIdentityReferences, [{
      status: 'legacy-unverified',
      kind: 'asset',
      field: 'sourceAssetId',
      stableField: 'sourceAssetEntityUid',
      legacyReference: 'asset-x',
    }]);
    assert.equal(db.db.prepare(`
      SELECT requires_snapshot FROM canvas_operations WHERE op_id = ?
    `).get('derived-project-delta').requires_snapshot, 1);
    const derivedSync = db.syncCanvas('canvas-derived-project-delta', 1);
    assert.equal(derivedSync.mode, 'snapshot');
    assert.equal(derivedSync.reason, 'snapshot_required');
    assert.deepEqual(derivedSync.document, derivedResult.document);

    seed(db, 'canvas-derived-add-project-delta');
    const derivedAdd = db.applyOperations('canvas-derived-add-project-delta', [{
      opId: 'derived-add-project-delta',
      type: 'node.add',
      payload: {
        node: {
          id: 'asset-node',
          type: 'text',
          position: { x: 300, y: 0 },
          data: { sourceAssetId: 'asset-y' },
        },
      },
    }], { expectedRevision: 1 });
    assert.equal(db.db.prepare(`
      SELECT requires_snapshot FROM canvas_operations WHERE op_id = ?
    `).get('derived-add-project-delta').requires_snapshot, 1);
    assert.equal(db.syncCanvas('canvas-derived-add-project-delta', 1).reason, 'snapshot_required');
    const derivedAddNode = derivedAdd.document.nodes.find((node) => node.id === 'asset-node');
    assert.equal(derivedAddNode.data.sourceAssetEntityUid, undefined);
    assert.deepEqual(derivedAddNode.data.unverifiedIdentityReferences, [{
      status: 'legacy-unverified',
      kind: 'asset',
      field: 'sourceAssetId',
      stableField: 'sourceAssetEntityUid',
      legacyReference: 'asset-y',
    }]);

    seed(db, 'canvas-protected-alias');
    for (const [opId, payload] of [
      ['patch-protected-alias', { nodeId: 'a', patch: { legacyAliases: ['forged-alias'] } }],
      ['unset-protected-alias', { nodeId: 'a', unsetKeys: ['legacyAliases'] }],
    ]) {
      assert.throws(() => db.applyOperations('canvas-protected-alias', [{
        opId,
        type: 'node.patch',
        payload,
      }], { expectedRevision: 1 }));
    }
    assert.equal(db.getCanvas('canvas-protected-alias').revision, 1);
    assert.equal(db.db.prepare(`
      SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?
    `).get('canvas-protected-alias').count, 0);
  } finally {
    db.close();
  }
});

test('pre-schema26 guard-v1 added-entity postconditions lift to canonical project identity without weakening checks', () => {
  let legacyRewrite = null;
  const db = new ProjectDatabase(':memory:', {
    beforeCanvasPatchCommit: (sqlite, context) => {
      if (context.phase === 'apply') {
        legacyRewrite = rewriteAppliedPatchAsLegacyIdentityGuard(sqlite, context);
      }
    },
  });
  try {
    seed(db);
    const input = patch({
      id: 'doctor-patch-pre-schema26-guard-v1',
      diagnosticsResolved: [],
      operations: [
        { type: 'node.add', payload: { node: { id: 'c', type: 'text', position: { x: 200, y: 0 }, data: { prompt: 'C' } } } },
        { type: 'edge.add', payload: { edge: { id: 'edge-bc', source: 'b', target: 'c', type: 'default' } } },
      ],
    });
    const preview = db.previewCanvasPatch('canvas-patch', input, {
      authority: LOCAL_OWNER_PATCH_AUTHORITY,
    });
    const applied = db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'member-a',
      authority: LOCAL_OWNER_PATCH_AUTHORITY,
    });
    assert.equal(applied.revision, 3);
    assert.deepEqual(legacyRewrite.strippedFields.sort(), [
      'edge.legacyAliases',
      'edge.sourceEntityUid',
      'edge.targetEntityUid',
      'node.legacyAliases',
    ]);
    const storedLegacyConditions = JSON.parse(db.db.prepare(`
      SELECT postconditions_json FROM canvas_patch_applications WHERE patch_id = ?
    `).get(input.id).postconditions_json);
    const legacyNode = storedLegacyConditions.find((condition) => condition.kind === 'node.added').node;
    const legacyEdge = storedLegacyConditions.find((condition) => condition.kind === 'edge.added').edge;
    assert.equal(Object.prototype.hasOwnProperty.call(legacyNode, 'legacyAliases'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(legacyEdge, 'legacyAliases'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(legacyEdge, 'sourceEntityUid'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(legacyEdge, 'targetEntityUid'), false);

    const reverted = db.revertCanvasPatch('canvas-patch', input.id, {
      actorId: 'member-a',
      expectedRevision: 3,
      authority: LOCAL_OWNER_PATCH_AUTHORITY,
    });
    assert.equal(reverted.revision, 5);
    assert.equal(reverted.document.nodes.some((node) => node.id === 'c'), false);
    assert.equal(reverted.document.edges.some((edge) => edge.id === 'edge-bc'), false);
  } finally {
    db.close();
  }
});

test('pre-schema26 guard-v1 compatibility still rejects added-entity identity tampering', () => {
  const db = new ProjectDatabase(':memory:', {
    beforeCanvasPatchCommit: (sqlite, context) => {
      if (context.phase === 'apply') rewriteAppliedPatchAsLegacyIdentityGuard(sqlite, context);
    },
  });
  try {
    seed(db);
    const input = patch({
      id: 'doctor-patch-pre-schema26-guard-v1-tamper',
      diagnosticsResolved: [],
      operations: [
        { type: 'node.add', payload: { node: { id: 'c', type: 'text', position: { x: 200, y: 0 }, data: { prompt: 'C' } } } },
        { type: 'edge.add', payload: { edge: { id: 'edge-bc', source: 'b', target: 'c', type: 'default' } } },
      ],
    });
    const preview = db.previewCanvasPatch('canvas-patch', input, {
      authority: LOCAL_OWNER_PATCH_AUTHORITY,
    });
    db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'member-a',
      authority: LOCAL_OWNER_PATCH_AUTHORITY,
    });
    const tampered = db.getCanvas('canvas-patch');
    const addedNode = tampered.nodes.find((node) => node.id === 'c');
    addedNode.legacyAliases = [...addedNode.legacyAliases, 'attacker-alias'];
    const update = db.db.prepare(`
      UPDATE canvas_documents SET snapshot_json = ? WHERE canvas_id = ? AND revision = ?
    `).run(JSON.stringify(tampered), 'canvas-patch', 3);
    assert.equal(update.changes, 1);
    assert.throws(() => db.revertCanvasPatch('canvas-patch', input.id, {
      actorId: 'member-a',
      expectedRevision: 3,
      authority: LOCAL_OWNER_PATCH_AUTHORITY,
    }), CanvasPatchRevertConflictError);
    assert.equal(db.getCanvas('canvas-patch').nodes.find((node) => node.id === 'c')
      .legacyAliases.includes('attacker-alias'), true);
    assert.equal(db.db.prepare(`
      SELECT status FROM canvas_patch_applications WHERE patch_id = ?
    `).get(input.id).status, 'applied');
  } finally {
    db.close();
  }
});

test('node.restore and edge.restore are previewed and reverted without snapshot replacement', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const original = seed(db);
    const originalNode = original.nodes.find((node) => node.id === 'a');
    const originalEdge = original.edges.find((edge) => edge.id === 'edge-ab');
    db.applyOperations('canvas-patch', [{
      opId: 'prepare-delete-a', type: 'node.delete', payload: { nodeId: 'a' },
    }], { expectedRevision: 1 });
    const deleted = db.getCanvas('canvas-patch');
    assert.equal(deleted.revision, 2);
    const input = patch({
      id: 'doctor-patch-restore-matrix',
      baseRevision: 2,
      operations: [
        { type: 'node.restore', payload: { node: originalNode } },
        { type: 'edge.restore', payload: { edge: originalEdge } },
      ],
    });
    const preview = db.previewCanvasPatch('canvas-patch', input, {
      authority: LOCAL_OWNER_PATCH_AUTHORITY,
    });
    assert.deepEqual(preview.changes.map((change) => change.type), ['node.restore', 'edge.restore']);
    const applied = db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest, confirmed: true, actorId: 'member-a',
      authority: LOCAL_OWNER_PATCH_AUTHORITY,
    });
    assert.equal(applied.revision, 4);
    assert.equal(applied.document.nodes.some((node) => node.id === 'a'), true);
    assert.equal(applied.document.edges.some((edge) => edge.id === 'edge-ab'), true);
    const reverted = db.revertCanvasPatch('canvas-patch', input.id, {
      actorId: 'member-a',
      expectedRevision: 4,
      authority: LOCAL_OWNER_PATCH_AUTHORITY,
    });
    assert.equal(reverted.revision, 6);
    assert.equal(reverted.document.nodes.some((node) => node.id === 'a'), false);
    assert.equal(reverted.document.edges.some((edge) => edge.id === 'edge-ab'), false);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM canvas_operations WHERE type = 'snapshot.replace'").get().count, 0);
  } finally {
    db.close();
  }
});

test('restore operations are bound to tombstone uid, type and edge endpoints', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const original = seed(db);
    const originalNode = original.nodes.find((node) => node.id === 'a');
    const originalEdge = original.edges.find((edge) => edge.id === 'edge-ab');
    db.applyOperations('canvas-patch', [{
      opId: 'prepare-bound-delete-a', type: 'node.delete', payload: { nodeId: 'a' },
    }], { expectedRevision: 1 });
    const provenanceBeforeForgedPreviews = db.db.prepare('SELECT COUNT(*) AS count FROM canvas_mutation_provenance').get().count;

    const forgedNode = patch({
      id: 'doctor-patch-forged-node-restore',
      baseRevision: 2,
      operations: [{
        type: 'node.restore',
        payload: {
          node: {
            ...originalNode,
            entityUid: '11111111-1111-4111-8111-111111111111',
            type: 'unknown-attacker-node',
          },
        },
      }],
    });
    assert.throws(() => db.previewCanvasPatch('canvas-patch', forgedNode, {
      authority: LOCAL_OWNER_PATCH_AUTHORITY,
    }), CanvasPatchValidationError);

    const forgedEdge = patch({
      id: 'doctor-patch-forged-edge-restore',
      baseRevision: 2,
      operations: [
        { type: 'node.restore', payload: { node: originalNode } },
        {
          type: 'edge.restore',
          payload: {
            edge: {
              ...originalEdge,
              entityUid: '22222222-2222-4222-8222-222222222222',
              source: 'b',
              target: 'b',
              type: 'attacker-edge',
            },
          },
        },
      ],
    });
    assert.throws(() => db.previewCanvasPatch('canvas-patch', forgedEdge, {
      authority: LOCAL_OWNER_PATCH_AUTHORITY,
    }), CanvasPatchValidationError);
    assert.equal(db.getCanvas('canvas-patch').revision, 2);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_patch_applications').get().count, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_mutation_provenance').get().count, provenanceBeforeForgedPreviews);
  } finally {
    db.close();
  }
});

test('canvas operations reject structural patch bypasses and invalid final document invariants without writes', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    seed(db);
    const invalidPosition = patch({
      id: 'doctor-patch-invalid-position',
      operations: [{
        type: 'node.patch', payload: { nodeId: 'a', patch: { position: 'not-a-position' } },
      }],
    });
    assert.throws(() => db.previewCanvasPatch('canvas-patch', invalidPosition), CanvasPatchValidationError);
    assert.throws(() => db.previewCanvasPatch('canvas-patch', patch({
      id: 'doctor-patch-invalid-add',
      operations: [{
        type: 'node.add', payload: { node: { id: 'invalid', type: '', position: { x: 0, y: 0 } } },
      }],
    })), CanvasPatchValidationError);
    assert.equal(db.getCanvas('canvas-patch').revision, 1);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations').get().count, 0);

    const dangling = normalizeCanvasDocument('dangling-canvas', {
      nodes: [{ id: 'a', type: 'text', position: { x: 0, y: 0 } }],
      edges: [{ id: 'dangling', source: 'a', target: 'missing' }],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    assert.throws(() => applyCanvasOperation(dangling, {
      type: 'viewport.set', payload: { viewport: { x: 1, y: 1, zoom: 1 } },
    }), /source|target|端点|invariant|结构/i);
    assert.throws(() => applyCanvasOperation(normalizeCanvasDocument('viewport-canvas', {
      nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    }), {
      type: 'viewport.set', payload: { viewport: { x: 0, y: 0, zoom: Number.POSITIVE_INFINITY } },
    }), /viewport|视口|无效/i);
  } finally {
    db.close();
  }
});

test('deep and oversized patch inputs fail with stable validation errors and perform no writes', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    seed(db);
    let deep = 'leaf';
    for (let index = 0; index < 20; index += 1) deep = { nested: deep };
    const deepPatch = patch({
      operations: [{ type: 'node.patch', payload: { nodeId: 'a', dataPatch: { deep } } }],
    });
    assert.throws(() => db.previewCanvasPatch('canvas-patch', deepPatch), CanvasPatchValidationError);
    const hugePatch = patch({
      operations: [{ type: 'node.patch', payload: { nodeId: 'a', dataPatch: { huge: 'x'.repeat(600 * 1024) } } }],
    });
    assert.throws(() => db.previewCanvasPatch('canvas-patch', hugePatch), CanvasPatchValidationError);
    assert.equal(db.getCanvas('canvas-patch').revision, 1);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_patch_applications').get().count, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations').get().count, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 0);
  } finally {
    db.close();
  }
});

test('apply requires matching preview confirmation, overrides envelopes and retries idempotently from original base', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    seed(db);
    const input = patch();
    const preview = db.previewCanvasPatch('canvas-patch', input);
    assert.throws(() => db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest,
      confirmed: false,
      actorId: 'member-a',
      sessionId: 'session-a',
    }), CanvasPatchConfirmationError);
    assert.throws(() => db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: '0'.repeat(64),
      confirmed: true,
      actorId: 'member-a',
      sessionId: 'session-a',
    }), CanvasPatchConflictError);

    const applied = db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'member-a',
      sessionId: 'session-a',
    });
    assert.equal(applied.patchId, PATCH_ID);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.duplicate, false);
    assert.equal(applied.baseRevision, 1);
    assert.equal(applied.revision, 2);
    assert.equal(applied.document.nodes.find((node) => node.id === 'a').data.prompt, 'fixed');

    const operation = db.db.prepare('SELECT * FROM canvas_operations WHERE canvas_id = ? AND revision = 2').get('canvas-patch');
    assert.notEqual(operation.op_id, 'attacker-op-id');
    assert.match(operation.op_id, /^canvas-patch:/);
    assert.equal(operation.project_id, 'project-patch');
    assert.equal(operation.canvas_id, 'canvas-patch');
    assert.equal(operation.actor_id, 'member-a');
    assert.equal(operation.session_id, 'session-a');
    assert.notEqual(operation.created_at, 1);
    assert.equal(JSON.parse(operation.payload_json).nodeId, 'a');

    const duplicate = db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'member-a',
      sessionId: 'session-a',
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.revision, 2);
    assert.equal(duplicate.document.revision, 2);
    assert.deepEqual(duplicate.document, applied.document);
    assert.equal(duplicate.acknowledgements[0].duplicate, true);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?').get('canvas-patch').count, 1);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_patch_applications').get().count, 1);
    assert.equal(db.listAuditEvents({ projectId: 'project-patch', canvasId: 'canvas-patch', action: 'canvas.patch.apply' }).length, 1);

    assert.throws(() => db.applyCanvasPatch('canvas-patch', patch({
      summary: 'same id, different request',
    }), {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'member-a',
    }), CanvasPatchConflictError);
  } finally {
    db.close();
  }
});

test('an exact Creator Patch retry can recover across UI and Codex actors without transferring ownership', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    seed(db, 'canvas-patch');
    const input = patch({ id: 'creator-cross-entry-patch' });
    const preview = db.previewCanvasPatch('canvas-patch', input, {
      actorId: 'codex-agent',
      sessionId: 'codex-session',
    });
    const applied = db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'codex-agent',
      sessionId: 'codex-session',
    });
    assert.equal(applied.duplicate, false);
    assert.equal(applied.revision, 2);

    assert.throws(() => db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'local-owner',
      sessionId: 'local-session',
    }), CanvasPatchPermissionError);

    const recovered = db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'local-owner',
      sessionId: 'local-session',
      allowExactDuplicateAcrossActors: true,
    });
    assert.equal(recovered.duplicate, true);
    assert.equal(recovered.revision, applied.revision);
    assert.deepEqual(recovered.document, applied.document);
    assert.equal(db.db.prepare(
      'SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?',
    ).get('canvas-patch').count, 1);
    assert.equal(db.db.prepare(
      'SELECT COUNT(*) AS count FROM canvas_patch_applications WHERE canvas_id = ?',
    ).get('canvas-patch').count, 1);
    assert.equal(db.listAuditEvents({
      projectId: 'project-patch',
      canvasId: 'canvas-patch',
      action: 'canvas.patch.apply',
    }).length, 1);

    const publicLedger = db.listCanvasPatches('canvas-patch', {
      includeAllActors: true,
    });
    assert.equal(Object.hasOwn(publicLedger[0], 'requestDigest'), false);
    const evidenceLedger = db.listCanvasPatches('canvas-patch', {
      includeAllActors: true,
      includeRequestDigest: true,
    });
    assert.equal(evidenceLedger[0].requestDigest, canvasPatchRequestDigest(input));
    assert.equal(evidenceLedger[0].actorId, 'codex-agent');
    const exactApplication = db.getCanvasPatchApplication('canvas-patch', input.id, {
      includeAllActors: true,
      includeRequestDigest: true,
    });
    assert.equal(exactApplication.patchId, input.id);
    assert.equal(exactApplication.requestDigest, canvasPatchRequestDigest(input));
    assert.equal(exactApplication.previewDigest, preview.previewDigest);
    assert.equal(exactApplication.baseRevision, 1);
    assert.equal(exactApplication.appliedRevision, 2);
    assert.equal(exactApplication.status, 'applied');
    assert.deepEqual(exactApplication.affectedNodeIds, ['a']);
    assert.deepEqual(exactApplication.affectedEdgeIds, []);
    assert.equal(exactApplication.changes.length, 1);
    assert.equal(exactApplication.canRevert, true);

    assert.throws(() => db.revertCanvasPatch('canvas-patch', input.id, {
      actorId: 'local-owner',
      sessionId: 'local-session',
      expectedRevision: 2,
    }), CanvasPatchPermissionError);
    const reverted = db.revertCanvasPatch('canvas-patch', input.id, {
      actorId: 'codex-agent',
      sessionId: 'codex-session',
      expectedRevision: 2,
    });
    assert.equal(reverted.status, 'reverted');
    assert.equal(reverted.revision, 3);
  } finally {
    db.close();
  }
});

test('simultaneous UI and Codex retries of one exact Creator Patch commit once and both recover', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-creator-cross-entry-race-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const modulePath = path.resolve(__dirname, '../backend/src/services/projectDatabase.js');
  const workers = [];
  try {
    const setup = new ProjectDatabase(filename, { autoBackup: false });
    let request;
    try {
      seed(setup, 'canvas-patch');
      const input = patch({ id: 'creator-cross-entry-race-patch' });
      const preview = setup.previewCanvasPatch('canvas-patch', input, {
        actorId: 'local-owner',
        sessionId: 'local-session',
      });
      request = { patch: input, previewDigest: preview.previewDigest };
    } finally {
      setup.close();
    }

    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { ProjectDatabase } = require(workerData.modulePath);
      const db = new ProjectDatabase(workerData.filename, {
        autoBackup: false,
        unsafeDisableOwnerGuardForTests: true,
      });
      parentPort.postMessage({ type: 'ready' });
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      let message;
      try {
        const result = db.applyCanvasPatch('canvas-patch', workerData.request.patch, {
          previewDigest: workerData.request.previewDigest,
          confirmed: true,
          actorId: workerData.actorId,
          sessionId: workerData.sessionId,
          allowExactDuplicateAcrossActors: true,
        });
        message = {
          type: 'result',
          ok: true,
          duplicate: result.duplicate,
          revision: result.revision,
        };
      } catch (error) {
        message = {
          type: 'result',
          ok: false,
          code: error && error.code,
          message: String(error && error.message || ''),
        };
      } finally {
        db.close();
      }
      parentPort.postMessage(message);
      parentPort.close();
    `;
    const actors = [
      { actorId: 'local-owner', sessionId: 'local-session' },
      { actorId: 'codex-agent', sessionId: 'codex-session' },
    ];
    const workerEnv = {
      ...process.env,
      NODE_ENV: 'test',
      T8_PROJECT_DATABASE_UNSAFE_TEST_WORKER: '1',
    };
    delete workerEnv.NODE_TEST_CONTEXT;
    const ready = [];
    const results = [];
    for (const actor of actors) {
      const worker = new Worker(workerSource, {
        execArgv: [],
        eval: true,
        env: workerEnv,
        workerData: {
          modulePath,
          filename,
          gate,
          request,
          ...actor,
        },
      });
      workers.push(worker);
      ready.push(new Promise((resolve, reject) => {
        const onMessage = (message) => {
          if (message?.type !== 'ready') return;
          worker.off('message', onMessage);
          worker.off('error', reject);
          resolve();
        };
        worker.on('message', onMessage);
        worker.once('error', reject);
      }));
      results.push(new Promise((resolve, reject) => {
        const onMessage = (message) => {
          if (message?.type !== 'result') return;
          worker.off('message', onMessage);
          worker.off('error', reject);
          resolve(message);
        };
        worker.on('message', onMessage);
        worker.once('error', reject);
      }));
    }
    await Promise.all(ready);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, actors.length);
    const settled = await Promise.all(results);
    assert.equal(settled.every((result) => result.ok), true, JSON.stringify(settled));
    assert.deepEqual(settled.map((result) => result.duplicate).sort(), [false, true]);
    assert.deepEqual([...new Set(settled.map((result) => result.revision))], [2]);
    assert.equal(settled.some((result) => /SQLITE_BUSY|database is locked/i.test(result.message || '')), false);

    const verified = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(verified.getCanvas('canvas-patch').revision, 2);
      assert.equal(verified.db.prepare(
        'SELECT COUNT(*) AS count FROM canvas_patch_applications WHERE canvas_id = ?',
      ).get('canvas-patch').count, 1);
      assert.equal(verified.db.prepare(
        'SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?',
      ).get('canvas-patch').count, 1);
      assert.equal(verified.db.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE canvas_id = ? AND action = 'canvas.patch.apply'",
      ).get('canvas-patch').count, 1);
      assert.equal(verified.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(verified.db.pragma('foreign_key_check'), []);
    } finally {
      verified.close();
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => null)));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('the same patchId on two canvases derives distinct scoped operation ids instead of false deduplication', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    seed(db, 'canvas-patch-a');
    seed(db, 'canvas-patch-b');
    const input = patch({ id: 'doctor-patch-shared-id' });
    for (const canvasId of ['canvas-patch-a', 'canvas-patch-b']) {
      const preview = db.previewCanvasPatch(canvasId, input);
      const applied = db.applyCanvasPatch(canvasId, input, {
        previewDigest: preview.previewDigest, confirmed: true, actorId: 'member-a',
      });
      assert.equal(applied.revision, 2);
      assert.equal(applied.document.nodes.find((node) => node.id === 'a').data.prompt, 'fixed');
    }
    const rows = db.db.prepare(`
      SELECT canvas_id AS canvasId, op_id AS opId FROM canvas_operations ORDER BY canvas_id
    `).all();
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].opId, rows[1].opId);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_patch_applications').get().count, 2);
  } finally {
    db.close();
  }
});

test('patch transaction rolls document, operation, patch record, snapshot and audit back together', () => {
  let fail = false;
  const db = new ProjectDatabase(':memory:', {
    beforeCanvasPatchCommit: () => {
      if (fail) throw new Error('injected-patch-failure');
    },
  });
  try {
    seed(db);
    const input = patch();
    const preview = db.previewCanvasPatch('canvas-patch', input);
    fail = true;
    assert.throws(() => db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'member-a',
    }), /injected-patch-failure/);
    assert.equal(db.getCanvas('canvas-patch').revision, 1);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations').get().count, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_patch_applications').get().count, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_snapshots WHERE revision > 1').get().count, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_mutation_provenance').get().count, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 0);

    fail = false;
    const applied = db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'member-a',
    });
    assert.equal(applied.revision, 2);
    const provenanceBeforeFailedRevert = db.db.prepare(`
      SELECT * FROM canvas_mutation_provenance ORDER BY target_type, entity_uid, aspect, field_scope, field_name
    `).all();
    fail = true;
    assert.throws(() => db.revertCanvasPatch('canvas-patch', input.id, {
      actorId: 'member-a', expectedRevision: 2,
    }), /injected-patch-failure/);
    assert.equal(db.getCanvas('canvas-patch').revision, 2);
    assert.equal(db.getCanvas('canvas-patch').nodes.find((node) => node.id === 'a').data.prompt, 'fixed');
    assert.equal(db.db.prepare('SELECT status FROM canvas_patch_applications').get().status, 'applied');
    assert.deepEqual(db.db.prepare(`
      SELECT * FROM canvas_mutation_provenance ORDER BY target_type, entity_uid, aspect, field_scope, field_name
    `).all(), provenanceBeforeFailedRevert);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'canvas.patch.revert'").get().count, 0);
  } finally {
    db.close();
  }
});

test('a database failure on the second operation rolls the already inserted first operation back', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    seed(db);
    const input = patch({
      id: 'doctor-patch-second-operation-failure',
      operations: [
        { type: 'node.patch', payload: { nodeId: 'a', dataPatch: { prompt: 'first-write' } } },
        { type: 'node.patch', payload: { nodeId: 'b', dataPatch: { prompt: 'second-write' } } },
      ],
    });
    const preview = db.previewCanvasPatch('canvas-patch', input);
    db.db.exec(`
      CREATE TRIGGER fail_canvas_patch_second_operation
      BEFORE INSERT ON canvas_operations
      WHEN NEW.client_seq = 1
      BEGIN
        SELECT RAISE(ABORT, 'forced-second-op-failure');
      END;
    `);
    assert.throws(() => db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'member-a',
    }), /forced-second-op-failure/);
    const document = db.getCanvas('canvas-patch');
    assert.equal(document.revision, 1);
    assert.equal(document.nodes.find((node) => node.id === 'a').data.prompt, 'old');
    assert.equal(document.nodes.find((node) => node.id === 'b').data.prompt, 'B');
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations').get().count, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_patch_applications').get().count, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_mutation_provenance').get().count, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 0);
  } finally {
    db.close();
  }
});

test('personal patch list is actor-scoped and exposes no forward, inverse, diff or session material', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    seed(db);
    const input = patch();
    const preview = db.previewCanvasPatch('canvas-patch', input);
    db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'member-a',
      sessionId: 'private-session',
    });
    assert.deepEqual(db.listCanvasPatches('canvas-patch', { actorId: 'member-b' }), []);
    const records = db.listCanvasPatches('canvas-patch', { actorId: 'member-a' });
    assert.equal(records.length, 1);
    assert.deepEqual(Object.keys(records[0]).sort(), [
      'actorId', 'appliedRevision', 'baseRevision', 'canRevert', 'createdAt',
      'diagnosticsResolved', 'operationCount', 'patchId', 'revertedAt',
      'revertedRevision', 'status', 'summary',
    ]);
    assert.equal(records[0].canRevert, true);
    const serialized = JSON.stringify(records);
    assert.doesNotMatch(serialized, /private-session|forward|inverse|payload|diff|prompt/i);
  } finally {
    db.close();
  }
});

test('public preview, patch history and audit redact summary secrets, paths and raw operation values', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    seed(db);
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'signature123456'].join('.');
    const githubToken = ['ghp_', '0123456789abcdefghijklmnopqrstuvwxyz'].join('');
    const encodedPath = 'C%3A%5CUsers%5Calice%5Cprivate%5Csecret.txt';
    const encodedRootPath = 'path=%2Froot%2Fprivate%2Fsecret.txt';
    const encodedCredential = 'api_key%3DplainCredentialValue123456';
    const foldedDataUrl = 'data:image/png;base64,\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=';
    const input = patch({
      id: 'doctor-patch-public-redaction',
      summary: `修复 sk-summary-secret-123456 ${jwt} ${githubToken} ${encodedPath} ${encodedRootPath} ${encodedCredential} ${foldedDataUrl} at C:\\Users\\alice\\private\\workflow.json`,
      operations: [{
        type: 'node.patch',
        payload: {
          nodeId: 'a',
          dataPatch: {
            auth: jwt,
            apiKey: 'sk-operation-secret-123456',
            localPath: 'D:\\private\\output.png',
            encodedPath,
            note: `${githubToken} ${jwt} ${encodedRootPath} ${encodedCredential} ${foldedDataUrl}`,
            binary: `data:image/png;base64,${'B'.repeat(512)}`,
            nested: {
              token: 'nested-token-must-not-leak',
              samples: [`data:image/png;base64,${'C'.repeat(256)}`],
            },
          },
        },
      }],
    });
    const preview = db.previewCanvasPatch('canvas-patch', input, {
      actorId: 'member-a', authority: LOCAL_OWNER_PATCH_AUTHORITY,
    });
    const applied = db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest, confirmed: true, actorId: 'member-a', sessionId: 'session-a',
      authority: LOCAL_OWNER_PATCH_AUTHORITY,
    });
    assert.equal(applied.revision, 2);
    const publicJson = JSON.stringify({
      preview,
      history: db.listCanvasPatches('canvas-patch', { actorId: 'member-a' }),
      audit: db.listAuditEvents({ projectId: 'project-patch', canvasId: 'canvas-patch' }),
    });
    assert.doesNotMatch(publicJson, /sk-(?:summary|operation)-secret/i);
    assert.doesNotMatch(publicJson, /Users\\\\alice|D:\\\\private|BBBBBBBB|CCCCCCCC|nested-token-must-not-leak/);
    assert.doesNotMatch(publicJson, /eyJhbGciOiJIUzI1NiJ9|ghp_0123456789|C%3A%5CUsers%5Calice|%2Froot|plainCredentialValue123456|QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=/i);
    assert.match(publicJson, /redacted|local-path/i);
    const safeError = safeCanvasPatchErrorMessage(
      `upstream auth=${jwt} token=plainTokenValue123 access_token=plainAccessToken456 `
      + `refresh-token=plainRefreshToken789 id_token=plainIdToken012 path=${encodedPath} `
      + `${encodedRootPath} ${encodedCredential} ${foldedDataUrl}`,
    );
    assert.doesNotMatch(
      safeError,
      /eyJhbGciOiJIUzI1NiJ9|plainTokenValue123|plainAccessToken456|plainRefreshToken789|plainIdToken012|C%3A%5CUsers%5Calice|%2Froot|plainCredentialValue123456|QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=/i,
    );
    assert.match(safeError, /redacted|local-path/i);

    assert.throws(() => db.previewCanvasPatch('canvas-patch', patch({
      id: 'sk-forbidden-patch-id-123456', baseRevision: 2,
    })), CanvasPatchValidationError);
    assert.throws(() => db.previewCanvasPatch('canvas-patch', patch({
      id: 'doctor-patch-forbidden-target',
      baseRevision: 2,
      operations: [{ type: 'node.delete', payload: { nodeId: 'C:\\Users\\alice\\node.json' } }],
    })), CanvasPatchValidationError);
  } finally {
    db.close();
  }
});

test('revert appends inverse operations, preserves unrelated later fields and restores cascaded deletes', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    seed(db);
    const input = patch({
      operations: [
        { type: 'node.patch', payload: { nodeId: 'b', dataPatch: { prompt: 'patched-b' } } },
        { type: 'node.delete', payload: { nodeId: 'a' } },
      ],
    });
    const preview = db.previewCanvasPatch('canvas-patch', input, {
      authority: LOCAL_OWNER_PATCH_AUTHORITY,
    });
    const applied = db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'member-a',
      sessionId: 'session-a',
      authority: LOCAL_OWNER_PATCH_AUTHORITY,
    });
    assert.equal(applied.revision, 3);
    assert.deepEqual(applied.document.nodes.map((node) => node.id), ['b']);
    assert.equal(applied.document.edges.length, 0);

    const unrelated = db.applyOperations('canvas-patch', [{
      opId: 'later-unrelated',
      actorId: 'member-a',
      sessionId: 'session-a',
      type: 'node.patch',
      payload: { nodeId: 'b', dataPatch: { unrelated: 'keep-me' } },
    }], { expectedRevision: 3 });
    assert.equal(unrelated.document.revision, 4);

    assert.throws(() => db.revertCanvasPatch('canvas-patch', PATCH_ID, {
      actorId: 'member-b', expectedRevision: 4,
    }), CanvasPatchPermissionError);
    const reverted = db.revertCanvasPatch('canvas-patch', PATCH_ID, {
      actorId: 'member-a',
      sessionId: 'session-revert',
      expectedRevision: 4,
      authority: LOCAL_OWNER_PATCH_AUTHORITY,
    });
    assert.equal(reverted.status, 'reverted');
    assert.equal(reverted.duplicate, false);
    assert.equal(reverted.revision, 7);
    assert.equal(reverted.document.nodes.find((node) => node.id === 'b').data.prompt, 'B');
    assert.equal(reverted.document.nodes.find((node) => node.id === 'b').data.unrelated, 'keep-me');
    assert.equal(reverted.document.nodes.find((node) => node.id === 'a').data.prompt, 'old');
    assert.deepEqual(reverted.document.edges.map((edge) => edge.id), ['edge-ab']);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?').get('canvas-patch').count, 6);

    const listed = db.listCanvasPatches('canvas-patch', { actorId: 'member-a' })[0];
    assert.equal(listed.status, 'reverted');
    assert.equal(listed.canRevert, false);
    assert.equal(listed.revertedRevision, 7);
    const duplicate = db.revertCanvasPatch('canvas-patch', PATCH_ID, { actorId: 'member-a' });
    assert.equal(duplicate.duplicate, true);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?').get('canvas-patch').count, 6);
  } finally {
    db.close();
  }
});

test('revert detects touched-field changes atomically but ignores unrelated-field changes', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    seed(db);
    const input = patch();
    const preview = db.previewCanvasPatch('canvas-patch', input);
    db.applyCanvasPatch('canvas-patch', input, {
      previewDigest: preview.previewDigest,
      confirmed: true,
      actorId: 'member-a',
    });
    db.applyOperations('canvas-patch', [{
      opId: 'later-related',
      type: 'node.patch',
      payload: { nodeId: 'a', dataPatch: { prompt: 'changed-again', unrelated: 1 } },
    }], { expectedRevision: 2 });
    assert.throws(() => db.revertCanvasPatch('canvas-patch', PATCH_ID, {
      actorId: 'member-a', expectedRevision: 3,
    }), CanvasPatchRevertConflictError);
    assert.equal(db.getCanvas('canvas-patch').revision, 3);
    assert.equal(db.getCanvas('canvas-patch').nodes.find((node) => node.id === 'a').data.prompt, 'changed-again');
    assert.equal(db.db.prepare('SELECT status FROM canvas_patch_applications').get().status, 'applied');
    assert.equal(db.listAuditEvents({ projectId: 'project-patch', action: 'canvas.patch.revert' }).length, 0);
  } finally {
    db.close();
  }
});

test('durable field provenance rejects ABA but allows same-node unrelated fields and tracks revert revisions', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    seed(db);
    const abaInput = patch({ id: 'doctor-patch-aba' });
    const abaPreview = db.previewCanvasPatch('canvas-patch', abaInput);
    db.applyCanvasPatch('canvas-patch', abaInput, {
      previewDigest: abaPreview.previewDigest,
      confirmed: true,
      actorId: 'member-a',
    });
    db.applyOperations('canvas-patch', [{
      opId: 'aba-other', type: 'node.patch', payload: { nodeId: 'a', dataPatch: { prompt: 'other' } },
    }], { expectedRevision: 2 });
    db.applyOperations('canvas-patch', [{
      opId: 'aba-back', type: 'node.patch', payload: { nodeId: 'a', dataPatch: { prompt: 'fixed' } },
    }], { expectedRevision: 3 });
    assert.throws(() => db.revertCanvasPatch('canvas-patch', abaInput.id, {
      actorId: 'member-a', expectedRevision: 4,
    }), CanvasPatchRevertConflictError);
    assert.equal(db.getCanvas('canvas-patch').revision, 4);
    assert.equal(db.getCanvas('canvas-patch').nodes.find((node) => node.id === 'a').data.prompt, 'fixed');
    assert.equal(db.db.prepare('SELECT status FROM canvas_patch_applications WHERE canvas_id = ?').get('canvas-patch').status, 'applied');

    seed(db, 'canvas-unrelated');
    const unrelatedInput = patch({ id: 'doctor-patch-unrelated-same-node' });
    const unrelatedPreview = db.previewCanvasPatch('canvas-unrelated', unrelatedInput);
    db.applyCanvasPatch('canvas-unrelated', unrelatedInput, {
      previewDigest: unrelatedPreview.previewDigest,
      confirmed: true,
      actorId: 'member-a',
    });
    db.applyOperations('canvas-unrelated', [{
      opId: 'same-node-unrelated',
      type: 'node.patch',
      payload: { nodeId: 'a', dataPatch: { unrelated: 'keep-me' } },
    }], { expectedRevision: 2 });
    const reverted = db.revertCanvasPatch('canvas-unrelated', unrelatedInput.id, {
      actorId: 'member-a', expectedRevision: 3,
    });
    assert.equal(reverted.revision, 4);
    const node = reverted.document.nodes.find((item) => item.id === 'a');
    assert.equal(node.data.prompt, 'old');
    assert.equal(node.data.unrelated, 'keep-me');
    const provenance = db.db.prepare(`
      SELECT last_revision, last_op_digest
      FROM canvas_mutation_provenance
      WHERE project_id = ? AND canvas_id = ? AND target_type = 'node'
        AND entity_uid = ? AND aspect = 'field' AND field_scope = 'data' AND field_name = 'prompt'
    `).get('project-patch', 'canvas-unrelated', node.entityUid);
    assert.equal(provenance.last_revision, 4);
    assert.match(provenance.last_op_digest, /^[a-f0-9]{64}$/);

    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_mutation_provenance WHERE canvas_id = ?').get('canvas-unrelated').count > 0, true);
    db.deleteCanvas('canvas-unrelated');
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM canvas_mutation_provenance WHERE canvas_id = ?').get('canvas-unrelated').count, 0);

    seed(db, 'canvas-reset');
    const resetInput = patch({ id: 'doctor-patch-reset-aba' });
    const resetPreview = db.previewCanvasPatch('canvas-reset', resetInput);
    db.applyCanvasPatch('canvas-reset', resetInput, {
      previewDigest: resetPreview.previewDigest, confirmed: true, actorId: 'member-a',
    });
    const sameSnapshot = db.getCanvas('canvas-reset');
    db.saveCanvasSnapshot('canvas-reset', sameSnapshot, {
      expectedRevision: 2, opId: 'snapshot-reset-after-patch', actorId: 'member-a',
    });
    assert.throws(() => db.revertCanvasPatch('canvas-reset', resetInput.id, {
      actorId: 'member-a', expectedRevision: 3,
    }), CanvasPatchRevertConflictError);
  } finally {
    db.close();
  }
});

test('latest schema retains schema 22 project-scoped provenance, operation identity and stale preview rejection', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    assertCurrentProjectDatabaseRegistry(PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_MIGRATIONS);
    assert.equal(db.db.prepare('SELECT 1 AS ok FROM schema_migrations WHERE version = 21').get().ok, 1);
    const columns = db.db.pragma('table_info(canvas_patch_applications)').map((row) => row.name);
    for (const column of [
      'project_id', 'canvas_id', 'patch_id', 'request_digest', 'preview_digest',
      'forward_ops_json', 'inverse_ops_json', 'postconditions_json', 'status',
      'reverted_revision', 'guard_version', 'provenance_guards_json', 'provenance_guards_digest',
    ]) assert.equal(columns.includes(column), true, column);
    const provenanceColumns = db.db.pragma('table_info(canvas_mutation_provenance)').map((row) => row.name);
    for (const column of [
      'project_id', 'canvas_id', 'target_type', 'entity_uid', 'aspect',
      'field_scope', 'field_name', 'last_revision', 'last_op_digest', 'updated_at',
    ]) assert.equal(provenanceColumns.includes(column), true, column);
    const operationIdentityColumns = db.db.pragma('table_info(canvas_operation_idempotency)').map((row) => row.name);
    for (const column of [
      'op_id', 'project_id', 'canvas_id', 'revision', 'base_revision', 'actor_id',
      'session_id', 'client_seq', 'type', 'payload_digest', 'created_at',
    ]) assert.equal(operationIdentityColumns.includes(column), true, column);
    const seeded = seed(db);
    assert.throws(() => db.db.prepare(`
      INSERT INTO canvas_mutation_provenance(
        project_id, canvas_id, target_type, entity_uid, aspect,
        field_scope, field_name, last_revision, last_op_digest, updated_at
      ) VALUES (?, ?, 'canvas', ?, 'reset', '', '', 1, ?, 1)
    `).run('wrong-project', seeded.canvasId, seeded.entityUid, '0'.repeat(64)), /project mismatch/);
    db.saveCanvasSnapshot('canvas-patch', db.getCanvas('canvas-patch'), { expectedRevision: 1 });
    assert.throws(() => db.previewCanvasPatch('canvas-patch', patch()), RevisionConflictError);
  } finally {
    db.close();
  }
});

test('concurrent generic operation writers serialize to one commit and stable revision conflicts without SQLITE_BUSY leaks', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-canvas-operation-concurrency-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const modulePath = path.resolve(__dirname, '../backend/src/services/projectDatabase.js');
  const workers = [];
  try {
    const setup = new ProjectDatabase(filename, { autoBackup: false });
    try {
      seed(setup, 'operation-race');
    } finally {
      setup.close();
    }
    const workerCount = 8;
    const operationsPerWriter = 60;
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { ProjectDatabase } = require(workerData.modulePath);
      const db = new ProjectDatabase(workerData.filename, {
        autoBackup: false,
        unsafeDisableOwnerGuardForTests: true,
      });
      const gate = new Int32Array(workerData.gate);
      const writerSource = String(ProjectDatabase.prototype.applyOperations);
      const usesSerializedWriter = writerSource.includes('.immediate(')
        || writerSource.includes('withProjectDatabaseWrite(');
      if (!usesSerializedWriter) {
        const getCanvas = db.getCanvas.bind(db);
        let barrierArmed = true;
        db.getCanvas = (canvasId) => {
          const document = getCanvas(canvasId);
          if (barrierArmed) {
            barrierArmed = false;
            const arrived = Atomics.add(gate, 1, 1) + 1;
            if (arrived === workerData.workerCount) {
              Atomics.store(gate, 2, 1);
              Atomics.notify(gate, 2, workerData.workerCount);
            } else {
              Atomics.wait(gate, 2, 0);
            }
          }
          return document;
        };
      }
      parentPort.postMessage({ type: 'ready' });
      Atomics.wait(gate, 0, 0);
      const operations = Array.from({ length: workerData.operationsPerWriter }, (_, index) => ({
        opId: 'generic-race-' + workerData.writerIndex + '-' + index,
        projectId: 'project-patch',
        canvasId: 'operation-race',
        actorId: 'member-' + workerData.writerIndex,
        sessionId: 'session-' + workerData.writerIndex,
        clientSeq: index,
        type: 'node.patch',
        payload: { nodeId: 'a', dataPatch: { ['race_' + workerData.writerIndex + '_' + index]: index } },
        timestamp: 1700000000000 + workerData.writerIndex * 1000 + index,
      }));
      try {
        const result = db.applyOperations('operation-race', operations, { expectedRevision: 1 });
        parentPort.postMessage({ type: 'result', ok: true, revision: result.document.revision });
      } catch (error) {
        parentPort.postMessage({
          type: 'result', ok: false, code: error && error.code, name: error && error.name,
          message: String(error && error.message || ''),
        });
      } finally {
        db.close();
      }
    `;
    const readyPromises = [];
    const resultPromises = [];
    for (let writerIndex = 0; writerIndex < workerCount; writerIndex += 1) {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: { modulePath, filename, gate, workerCount, operationsPerWriter, writerIndex },
      });
      workers.push(worker);
      const ready = new Promise((resolve, reject) => {
        const onMessage = (message) => {
          if (message?.type === 'ready') {
            worker.off('message', onMessage);
            worker.off('error', reject);
            resolve();
          }
        };
        worker.on('message', onMessage);
        worker.once('error', reject);
      });
      readyPromises.push(ready);
      resultPromises.push(new Promise((resolve, reject) => {
        const onMessage = (message) => {
          if (message?.type === 'result') {
            worker.off('message', onMessage);
            worker.off('error', reject);
            resolve(message);
          }
        };
        worker.on('message', onMessage);
        worker.once('error', reject);
      }));
      await ready;
    }
    await Promise.all(readyPromises);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, workerCount);
    const results = await Promise.all(resultPromises);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok).length, workerCount - 1);
    assert.equal(results.filter((result) => !result.ok).every((result) => result.code === 'revision_conflict'), true);
    assert.equal(results.some((result) => /SQLITE_BUSY|database is locked/i.test(result.message)), false);

    const verified = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(verified.getCanvas('operation-race').revision, operationsPerWriter + 1);
      assert.equal(verified.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ?').get('operation-race').count, operationsPerWriter);
      assert.equal(verified.db.prepare('SELECT COUNT(*) AS count FROM canvas_mutation_provenance WHERE canvas_id = ?').get('operation-race').count, operationsPerWriter + 1);
      assert.equal(verified.db.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      verified.close();
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => null)));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('snapshot save and restore serialize across two real sqlite connections with revision CAS', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-canvas-snapshot-concurrency-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const modulePath = path.resolve(__dirname, '../backend/src/services/projectDatabase.js');

  const racePair = async (method, argsByWriter) => {
    const workers = [];
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { ProjectDatabase } = require(workerData.modulePath);
      const db = new ProjectDatabase(workerData.filename, {
        autoBackup: false,
        unsafeDisableOwnerGuardForTests: true,
      });
      const gate = new Int32Array(workerData.gate);
      const method = ProjectDatabase.prototype[workerData.method];
      const writerSource = String(method);
      const usesSerializedWriter = writerSource.includes('.immediate(')
        || writerSource.includes('withProjectDatabaseWrite(');
      if (!usesSerializedWriter) {
        const getCanvas = db.getCanvas.bind(db);
        let barrierArmed = true;
        db.getCanvas = (canvasId) => {
          const document = getCanvas(canvasId);
          if (barrierArmed) {
            barrierArmed = false;
            const arrived = Atomics.add(gate, 1, 1) + 1;
            if (arrived === 2) {
              Atomics.store(gate, 2, 1);
              Atomics.notify(gate, 2, 2);
            } else {
              Atomics.wait(gate, 2, 0);
            }
          }
          return document;
        };
      }
      parentPort.postMessage({ type: 'ready' });
      Atomics.wait(gate, 0, 0);
      try {
        const result = db[workerData.method](...workerData.args);
        parentPort.postMessage({ type: 'result', ok: true, revision: result.revision });
      } catch (error) {
        parentPort.postMessage({
          type: 'result', ok: false, code: error && error.code, name: error && error.name,
          message: String(error && error.message || ''),
        });
      } finally {
        db.close();
      }
    `;
    try {
      const ready = [];
      const results = [];
      for (let index = 0; index < 2; index += 1) {
        const worker = new Worker(workerSource, {
          eval: true,
          workerData: { modulePath, filename, gate, method, args: argsByWriter[index] },
        });
        workers.push(worker);
        const readyPromise = new Promise((resolve, reject) => {
          const onMessage = (message) => {
            if (message?.type !== 'ready') return;
            worker.off('message', onMessage);
            worker.off('error', reject);
            resolve();
          };
          worker.on('message', onMessage);
          worker.once('error', reject);
        });
        ready.push(readyPromise);
        results.push(new Promise((resolve, reject) => {
          const onMessage = (message) => {
            if (message?.type !== 'result') return;
            worker.off('message', onMessage);
            worker.off('error', reject);
            resolve(message);
          };
          worker.on('message', onMessage);
          worker.once('error', reject);
        }));
        await readyPromise;
      }
      await Promise.all(ready);
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0, 2);
      return await Promise.all(results);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate().catch(() => null)));
    }
  };

  try {
    const setup = new ProjectDatabase(filename, { autoBackup: false });
    try {
      seed(setup, 'snapshot-race');
    } finally {
      setup.close();
    }

    const saveResults = await racePair('saveCanvasSnapshot', [0, 1].map((index) => [
      'snapshot-race',
      {
        nodes: [{ id: 'a', type: 'text', position: { x: index, y: index }, data: { prompt: `save-writer-${index}` } }],
        edges: [],
      },
      {
        expectedRevision: 1,
        opId: `snapshot-save-race-${index}`,
        actorId: `save-writer-${index}`,
        sessionId: `save-session-${index}`,
      },
    ]));
    assert.equal(saveResults.filter((result) => result.ok).length, 1);
    assert.equal(saveResults.filter((result) => !result.ok).length, 1);
    assert.equal(saveResults.find((result) => !result.ok).code, 'revision_conflict');
    assert.equal(saveResults.some((result) => /SQLITE_BUSY|database is locked/i.test(result.message)), false);

    const restoreResults = await racePair('restoreCanvasSnapshot', [0, 1].map((index) => [
      'snapshot-race',
      1,
      {
        expectedRevision: 2,
        opId: `snapshot-restore-race-${index}`,
        actorId: `restore-writer-${index}`,
        sessionId: `restore-session-${index}`,
        authority: {
          source: 'local-owner',
          role: 'owner',
          capabilities: ['manageProviders'],
        },
      },
    ]));
    assert.equal(restoreResults.filter((result) => result.ok).length, 1);
    assert.equal(restoreResults.filter((result) => !result.ok).length, 1);
    assert.equal(restoreResults.find((result) => !result.ok).code, 'revision_conflict');
    assert.equal(restoreResults.some((result) => /SQLITE_BUSY|database is locked/i.test(result.message)), false);

    const verified = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(verified.getCanvas('snapshot-race').revision, 3);
      assert.equal(verified.db.prepare("SELECT COUNT(*) AS count FROM canvas_operations WHERE canvas_id = ? AND type = 'snapshot.replace'").get('snapshot-race').count, 1);
      assert.equal(verified.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(verified.db.pragma('foreign_key_check'), []);
    } finally {
      verified.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('eight concurrent baseRevision writers yield one commit and stable revision conflicts without SQLITE_BUSY leaks', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-canvas-patch-concurrency-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const modulePath = path.resolve(__dirname, '../backend/src/services/projectDatabase.js');
  const workers = [];
  try {
    const setup = new ProjectDatabase(filename, { autoBackup: false });
    const requests = [];
    try {
      seed(setup);
      for (let index = 0; index < 8; index += 1) {
        const input = patch({
          id: `doctor-patch-race-${index}`,
          summary: `并发 Patch ${index}`,
          operations: [{
            type: 'node.patch', payload: { nodeId: 'a', dataPatch: { prompt: `winner-${index}` } },
          }],
        });
        const preview = setup.previewCanvasPatch('canvas-patch', input, { actorId: 'member-a' });
        requests.push({ patch: input, previewDigest: preview.previewDigest });
      }
    } finally {
      setup.close();
    }

    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { ProjectDatabase } = require(workerData.modulePath);
      const db = new ProjectDatabase(workerData.filename, {
        autoBackup: false,
        unsafeDisableOwnerGuardForTests: true,
      });
      parentPort.postMessage({ type: 'ready' });
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      try {
        const result = db.applyCanvasPatch('canvas-patch', workerData.request.patch, {
          previewDigest: workerData.request.previewDigest,
          confirmed: true,
          actorId: 'member-a',
          sessionId: 'race-session',
        });
        parentPort.postMessage({ type: 'result', ok: true, revision: result.revision });
      } catch (error) {
        parentPort.postMessage({
          type: 'result', ok: false, code: error && error.code, name: error && error.name,
          message: String(error && error.message || ''),
        });
      } finally {
        db.close();
      }
    `;
    const readyPromises = [];
    const resultPromises = [];
    for (const request of requests) {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: { modulePath, filename, gate, request },
      });
      workers.push(worker);
      const readyPromise = new Promise((resolve, reject) => {
        const onMessage = (message) => {
          if (message?.type === 'ready') {
            worker.off('error', reject);
            worker.off('message', onMessage);
            resolve();
          }
        };
        worker.on('message', onMessage);
        worker.once('error', reject);
      });
      readyPromises.push(readyPromise);
      resultPromises.push(new Promise((resolve, reject) => {
        const onMessage = (message) => {
          if (message?.type === 'result') {
            worker.off('error', reject);
            worker.off('message', onMessage);
            resolve(message);
          }
        };
        worker.on('message', onMessage);
        worker.once('error', reject);
      }));
      await readyPromise;
    }
    await Promise.all(readyPromises);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, workers.length);
    const results = await Promise.all(resultPromises);
    assert.equal(results.filter((result) => result.ok).length, 1);
    const conflicts = results.filter((result) => !result.ok);
    assert.equal(conflicts.length, 7);
    assert.equal(conflicts.every((result) => result.code === 'revision_conflict'), true);
    assert.equal(conflicts.some((result) => /SQLITE_BUSY|database is locked/i.test(result.message)), false);

    const verified = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(verified.getCanvas('canvas-patch').revision, 2);
      assert.equal(verified.db.prepare('SELECT COUNT(*) AS count FROM canvas_patch_applications').get().count, 1);
      assert.equal(verified.db.prepare('SELECT COUNT(*) AS count FROM canvas_operations').get().count, 1);
      assert.equal(verified.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'canvas.patch.apply'").get().count, 1);
      assert.equal(verified.db.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      verified.close();
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => null)));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('patch apply, personal history, audit and revert survive two real sqlite reopen cycles', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-canvas-patch-persistence-'));
  const filename = path.join(directory, 'projects.sqlite3');
  try {
    const first = new ProjectDatabase(filename, { autoBackup: false });
    try {
      seed(first);
      const input = patch({ id: 'doctor-patch-persist' });
      const preview = first.previewCanvasPatch('canvas-patch', input, { actorId: 'member-a' });
      first.applyCanvasPatch('canvas-patch', input, {
        previewDigest: preview.previewDigest,
        confirmed: true,
        actorId: 'member-a',
        sessionId: 'session-a',
      });
    } finally {
      first.close();
    }

    const second = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(second.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(second.db.pragma('foreign_key_check'), []);
      assert.equal(second.getCanvas('canvas-patch').revision, 2);
      assert.equal(second.getCanvas('canvas-patch').nodes.find((node) => node.id === 'a').data.prompt, 'fixed');
      assert.equal(second.listCanvasPatches('canvas-patch', { actorId: 'member-a' })[0].status, 'applied');
      assert.equal(second.listAuditEvents({
        projectId: 'project-patch', canvasId: 'canvas-patch', action: 'canvas.patch.apply',
      }).length, 1);
      second.revertCanvasPatch('canvas-patch', 'doctor-patch-persist', {
        actorId: 'member-a', sessionId: 'session-b', expectedRevision: 2,
      });
    } finally {
      second.close();
    }

    const third = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(third.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(third.db.pragma('foreign_key_check'), []);
      assert.equal(third.getCanvas('canvas-patch').revision, 3);
      assert.equal(third.getCanvas('canvas-patch').nodes.find((node) => node.id === 'a').data.prompt, 'old');
      const record = third.listCanvasPatches('canvas-patch', { actorId: 'member-a' })[0];
      assert.equal(record.status, 'reverted');
      assert.equal(record.revertedRevision, 3);
      assert.equal(third.listAuditEvents({
        projectId: 'project-patch', canvasId: 'canvas-patch', action: 'canvas.patch.revert',
      }).length, 1);
    } finally {
      third.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema 19 bridge commits schema 28 before executable schema 29 rolls back atomically and retries idempotently', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-canvas-patch-schema21-'));
  const filename = path.join(directory, 'projects.sqlite3');
  try {
    seedSchema19(filename);
    let unexpectedOpen = null;
    try {
      assert.throws(() => {
        unexpectedOpen = new ProjectDatabase(filename, {
          autoBackup: false,
          beforeMigrationCommit: (_db, version) => {
            if (version === 29) throw new Error('schema-29-injected-failure');
          },
        });
      }, /schema-29-injected-failure/);
    } finally {
      unexpectedOpen?.close();
    }
    const rolledBack = new BetterSqlite3(filename, { readonly: true });
    try {
      assert.equal(rolledBack.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 28);
      assert.equal(rolledBack.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='canvas_mutation_provenance'").get().ok, 1);
      assert.equal(rolledBack.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='schema_migration_receipts'").get(), undefined);
      const patchColumns = rolledBack.pragma('table_info(canvas_patch_applications)').map((row) => row.name);
      assert.equal(patchColumns.includes('guard_version'), true);
      assert.equal(rolledBack.prepare('SELECT revision FROM canvas_documents WHERE canvas_id = ?').get('legacy-patch-canvas').revision, 7);
      assert.equal(rolledBack.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(rolledBack.pragma('foreign_key_check'), []);
    } finally {
      rolledBack.close();
    }

    const migrated = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(
        migrated.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
        PROJECT_DATABASE_SCHEMA_VERSION,
      );
      assert.equal(migrated.getCanvas('legacy-patch-canvas').revision, 7);
      assert.equal(migrated.getCanvas('legacy-patch-canvas').nodes[0].data.prompt, 'preserve-me');
      const patchColumns = migrated.db.pragma('table_info(canvas_patch_applications)').map((row) => row.name);
      assert.equal(patchColumns.includes('guard_version'), true);
      assert.equal(patchColumns.includes('provenance_guards_json'), true);
      assert.equal(patchColumns.includes('provenance_guards_digest'), true);
      assert.equal(migrated.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='canvas_mutation_provenance'").get().ok, 1);
      assert.equal(migrated.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='canvas_operation_idempotency'").get().ok, 1);
      const legacyRecord = migrated.listCanvasPatches('legacy-patch-canvas', { actorId: 'legacy-member' })[0];
      assert.equal(legacyRecord.patchId, 'legacy-schema19-patch');
      assert.equal(legacyRecord.canRevert, false);
      assert.throws(() => migrated.revertCanvasPatch('legacy-patch-canvas', legacyRecord.patchId, {
        actorId: 'legacy-member', expectedRevision: 7,
      }), (error) => error?.code === 'canvas_patch_revert_guard_unavailable');
      assert.equal(migrated.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(migrated.db.pragma('foreign_key_check'), []);
      assert.doesNotThrow(() => migrated.migrate());
      assert.equal(
        migrated.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,
        PROJECT_DATABASE_SCHEMA_VERSION,
      );
    } finally {
      migrated.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema 20 bridge preserves operation identity at schema 28 when executable schema 29 rolls back and retries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-canvas-operation-schema21-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const retryMigrationOptions = {
    autoBackup: false,
    // The fixture rewinds after adding business rows, so the simulated second
    // upgrade must not reuse the first-open migration backup generation.
    preMigrationBackupFilename: path.join(directory, 'retry-pre-migration-v28.sqlite3'),
    preMigration30BackupFilename: path.join(directory, 'retry-pre-migration-v29.sqlite3'),
    preMigration31BackupFilename: path.join(directory, 'retry-pre-migration-v30.sqlite3'),
  };
  const operation = {
    opId: 'schema20-operation-to-backfill',
    projectId: 'project-patch',
    canvasId: 'schema20-ledger-canvas',
    actorId: 'legacy-writer',
    sessionId: 'legacy-session',
    baseRevision: 1,
    clientSeq: 3,
    type: 'node.patch',
    payload: { nodeId: 'a', dataPatch: { migrated: true } },
    timestamp: 1_700_000_000_000,
  };
  try {
    const latest = new ProjectDatabase(filename, { autoBackup: false });
    try {
      seed(latest, operation.canvasId);
      latest.applyOperations(operation.canvasId, [operation], { expectedRevision: 1 });
    } finally {
      latest.close();
    }

    const downgrade = new BetterSqlite3(filename);
    try {
      removeSchema31ExtensionForSyntheticSchema30(downgrade);
      downgrade.prepare('DELETE FROM schema_migration_receipts WHERE version = 30').run();
      downgrade.prepare('DELETE FROM schema_migrations WHERE version = 30').run();
      downgrade.exec(PROJECT_DATABASE_MIGRATION_30_DOWN_SQL);
      downgrade.exec(PROJECT_DATABASE_MIGRATION_29_DOWN_SQL);
      downgrade.prepare('DELETE FROM schema_migrations WHERE version = 29').run();
      assert.deepEqual(downgrade.pragma('foreign_key_check'), []);
      downgrade.exec(`
        DELETE FROM schema_migrations WHERE version >= 21;
        DROP TABLE IF EXISTS canvas_operation_idempotency;
      `);
      assert.equal(downgrade.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 20);
      assert.equal(downgrade.prepare('SELECT 1 AS ok FROM canvas_operations WHERE op_id = ?').get(operation.opId).ok, 1);
      assert.deepEqual(downgrade.pragma('foreign_key_check'), []);
    } finally {
      downgrade.close();
    }

    let failedOpen = null;
    try {
      assert.throws(() => {
        failedOpen = new ProjectDatabase(filename, {
          ...retryMigrationOptions,
          beforeMigrationCommit: (_db, version) => {
            if (version === 29) throw new Error('schema-29-ledger-injected-failure');
          },
        });
      }, /schema-29-ledger-injected-failure/);
    } finally {
      failedOpen?.close();
    }

    const rolledBack = new BetterSqlite3(filename, { readonly: true });
    try {
      assert.equal(rolledBack.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 28);
      assert.equal(rolledBack.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='canvas_operation_idempotency'").get().ok, 1);
      assert.equal(rolledBack.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='schema_migration_receipts'").get(), undefined);
      assert.equal(rolledBack.prepare('SELECT COUNT(*) AS count FROM canvas_operation_idempotency WHERE op_id = ?').get(operation.opId).count, 1);
      assert.equal(rolledBack.prepare('SELECT 1 AS ok FROM canvas_operations WHERE op_id = ?').get(operation.opId).ok, 1);
      assert.equal(rolledBack.prepare('SELECT revision FROM canvas_documents WHERE canvas_id = ?').get(operation.canvasId).revision, 2);
      assert.deepEqual(rolledBack.pragma('foreign_key_check'), []);
    } finally {
      rolledBack.close();
    }

    const migrated = new ProjectDatabase(filename, retryMigrationOptions);
    try {
      const identity = migrated.db.prepare('SELECT * FROM canvas_operation_idempotency WHERE op_id = ?').get(operation.opId);
      assert.equal(identity.project_id, operation.projectId);
      assert.equal(identity.canvas_id, operation.canvasId);
      assert.equal(identity.revision, 2);
      assert.equal(identity.base_revision, 1);
      assert.equal(identity.actor_id, operation.actorId);
      assert.equal(identity.session_id, operation.sessionId);
      assert.equal(identity.client_seq, operation.clientSeq);
      assert.equal(identity.type, operation.type);
      assert.match(identity.payload_digest, /^[a-f0-9]{64}$/);
      assert.doesNotThrow(() => migrated.migrate());
      assert.equal(migrated.db.prepare('SELECT COUNT(*) AS count FROM canvas_operation_idempotency WHERE op_id = ?').get(operation.opId).count, 1);
    } finally {
      migrated.close();
    }

    const reopened = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM canvas_operation_idempotency WHERE op_id = ?').get(operation.opId).count, 1);
      assert.equal(reopened.db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(reopened.db.pragma('foreign_key_check'), []);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
