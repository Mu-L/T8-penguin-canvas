const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');
const { Worker } = require('node:worker_threads');
const {
  CANVAS_SCHEMA,
  normalizeCanvasDocument,
  applyCanvasOperation,
} = require('../backend/src/collaboration/protocol');
const {
  ProjectDatabase,
  ProjectDatabaseRecoveryError,
  PROJECT_DATABASE_SCHEMA_VERSION,
  RevisionConflictError,
  SubflowRevisionConflictError,
} = require('../backend/src/services/projectDatabase');
const { redactAndScanRunValue, redactRunValue, scanRunValueForSecrets } = require('../backend/src/services/runRedaction');
const { CollaborationAuth } = require('../backend/src/collaboration/auth');

test('legacy canvas normalizes to versioned document without losing graph fields', () => {
  const document = normalizeCanvasDocument('canvas-a', {
    nodes: [{ id: 'n1', type: 'text', data: { prompt: 'hello' }, position: { x: 1, y: 2 } }],
    edges: [],
    viewport: { x: 3, y: 4, zoom: 0.5 },
    creativeDesk: { version: 1, items: [] },
  });
  assert.equal(document.schema, CANVAS_SCHEMA);
  assert.equal(document.schemaVersion, 2);
  assert.equal(document.revision, 1);
  assert.match(document.entityUid, /^[0-9a-f-]{36}$/);
  assert.match(document.nodes[0].entityUid, /^[0-9a-f-]{36}$/);
  assert.equal(document.nodes[0].data.prompt, 'hello');
  assert.equal(document.creativeDesk.version, 1);
});

test('thirty legacy canvas variants round-trip all unknown business fields', () => {
  for (let index = 0; index < 30; index += 1) {
    const legacy = {
      nodes: [{ id: `node-${index}`, type: index % 2 ? 'image' : 'text', data: { privateProviderData: { index, flags: [true, false] } } }],
      edges: [],
      viewport: { x: index, y: -index, zoom: 0.5 + index / 100 },
      theme: { id: `theme-${index % 5}`, tokens: { accent: `#${String(index).padStart(6, '0')}` } },
      creativeDesk: { version: 1, items: [{ id: `desk-${index}`, custom: { index } }] },
      pluginNamespaces: { [`vendor-${index}`]: { revision: index, unknown: ['a', { b: index }] } },
      futureField: { schema: index + 10, enabled: index % 3 === 0 },
    };
    const migrated = normalizeCanvasDocument(`legacy-${index}`, legacy, { projectId: `project-${index % 3}` });
    const exported = JSON.parse(JSON.stringify(migrated));
    const reopened = normalizeCanvasDocument(exported.canvasId, exported, { projectId: exported.projectId, revision: exported.revision });
    assert.deepEqual(reopened.theme, legacy.theme);
    assert.deepEqual(reopened.creativeDesk, legacy.creativeDesk);
    assert.deepEqual(reopened.pluginNamespaces, legacy.pluginNamespaces);
    assert.deepEqual(reopened.futureField, legacy.futureField);
    assert.deepEqual(reopened.nodes[0].data, legacy.nodes[0].data);
  }
});

test('legacy entity UUIDs are deterministic and operations accept UUID identity', () => {
  const first = normalizeCanvasDocument('canvas-a', {
    nodes: [{ id: 'legacy-node', position: { x: 0, y: 0 } }],
    edges: [],
  });
  const second = normalizeCanvasDocument('canvas-a', {
    nodes: [{ id: 'legacy-node', position: { x: 0, y: 0 } }],
    edges: [],
  });
  assert.equal(first.nodes[0].entityUid, second.nodes[0].entityUid);
  const moved = applyCanvasOperation(first, {
    opId: 'move-by-uuid',
    type: 'node.move',
    payload: { nodeId: first.nodes[0].entityUid, position: { x: 12, y: 34 } },
  }).document;
  assert.deepEqual(moved.nodes[0].position, { x: 12, y: 34 });
});

test('node delete persists tombstones and stale edits cannot revive the node', () => {
  const base = normalizeCanvasDocument('canvas-a', {
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [{ id: 'e1', source: 'a', target: 'b' }],
  });
  const { document } = applyCanvasOperation(base, {
    opId: 'delete-a',
    type: 'node.delete',
    payload: { nodeId: 'a' },
  });
  assert.deepEqual(document.nodes.map((node) => node.id), ['b']);
  assert.equal(document.edges.length, 0);
  assert.equal(document.tombstones.nodes.a.opId, 'delete-a');
  assert.equal(document.tombstones.edges.e1.opId, 'delete-a');
  assert.throws(() => applyCanvasOperation(document, {
    opId: 'stale-patch-a',
    type: 'node.patch',
    payload: { nodeId: 'a', dataPatch: { prompt: 'revived' } },
  }), /必须显式恢复/);
  assert.throws(() => applyCanvasOperation(document, {
    opId: 'stale-add-a',
    type: 'node.add',
    payload: { node: { id: 'a' } },
  }), /必须显式恢复/);
});

test('deleted nodes and edges require explicit restore operations', () => {
  const base = normalizeCanvasDocument('canvas-a', {
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [{ id: 'e1', source: 'a', target: 'b' }],
  });
  const deleted = applyCanvasOperation(base, {
    opId: 'delete-a', type: 'node.delete', payload: { nodeId: 'a' },
  }).document;
  const restoredNode = applyCanvasOperation(deleted, {
    opId: 'restore-a', type: 'node.restore', payload: { node: { id: 'a' } },
  }).document;
  const restoredEdge = applyCanvasOperation(restoredNode, {
    opId: 'restore-e1', type: 'edge.restore', payload: { edge: { id: 'e1', source: 'a', target: 'b' } },
  }).document;
  assert.deepEqual(restoredEdge.nodes.map((node) => node.id), ['b', 'a']);
  assert.deepEqual(restoredEdge.edges.map((edge) => edge.id), ['e1']);
  assert.equal(restoredEdge.tombstones.nodes.a, undefined);
  assert.equal(restoredEdge.tombstones.edges.e1, undefined);
  assert.equal(restoredNode.nodes.find((node) => node.id === 'a').entityUid, base.nodes.find((node) => node.id === 'a').entityUid);
});

test('edge tombstones bind named handles exactly and preserve legacy restore compatibility', () => {
  const base = normalizeCanvasDocument('canvas-handles', {
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [{
      id: 'e1',
      source: 'a',
      target: 'b',
      sourceHandle: 'text-out',
      targetHandle: 'text-in',
    }],
  });
  const originalEdge = base.edges[0];
  const deleted = applyCanvasOperation(base, {
    opId: 'delete-named-edge',
    type: 'edge.delete',
    payload: { edgeId: 'e1' },
  }).document;
  assert.equal(deleted.tombstones.edges.e1.sourceHandle, 'text-out');
  assert.equal(deleted.tombstones.edges.e1.targetHandle, 'text-in');
  assert.throws(() => applyCanvasOperation(deleted, {
    opId: 'forge-source-handle',
    type: 'edge.restore',
    payload: { edge: { ...originalEdge, sourceHandle: 'image-out' } },
  }), /sourceHandle 与删除记录不一致/);
  assert.throws(() => applyCanvasOperation(deleted, {
    opId: 'omit-target-handle',
    type: 'edge.restore',
    payload: {
      edge: {
        id: originalEdge.id,
        entityUid: originalEdge.entityUid,
        source: originalEdge.source,
        target: originalEdge.target,
        sourceHandle: originalEdge.sourceHandle,
      },
    },
  }), /targetHandle 与删除记录不一致/);
  const restored = applyCanvasOperation(deleted, {
    opId: 'restore-named-edge',
    type: 'edge.restore',
    payload: { edge: originalEdge },
  }).document;
  assert.equal(restored.edges[0].sourceHandle, 'text-out');
  assert.equal(restored.edges[0].targetHandle, 'text-in');

  const legacyInput = structuredClone(deleted);
  delete legacyInput.tombstones.edges.e1.sourceHandle;
  delete legacyInput.tombstones.edges.e1.targetHandle;
  const legacy = normalizeCanvasDocument('canvas-handles', legacyInput, {
    projectId: legacyInput.projectId,
    revision: legacyInput.revision,
  });
  assert.equal(Object.hasOwn(legacy.tombstones.edges.e1, 'sourceHandle'), false);
  assert.equal(Object.hasOwn(legacy.tombstones.edges.e1, 'targetHandle'), false);
  const legacyRestored = applyCanvasOperation(legacy, {
    opId: 'restore-legacy-named-edge',
    type: 'edge.restore',
    payload: { edge: originalEdge },
  }).document;
  assert.equal(legacyRestored.edges[0].sourceHandle, 'text-out');

  const unnamedBase = normalizeCanvasDocument('canvas-unnamed-handles', {
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [{ id: 'e1', source: 'a', target: 'b' }],
  });
  const unnamedEdge = unnamedBase.edges[0];
  const unnamedDeleted = applyCanvasOperation(unnamedBase, {
    opId: 'delete-unnamed-edge', type: 'edge.delete', payload: { edgeId: 'e1' },
  }).document;
  assert.equal(Object.hasOwn(unnamedDeleted.tombstones.edges.e1, 'sourceHandle'), true);
  assert.equal(unnamedDeleted.tombstones.edges.e1.sourceHandle, null);
  assert.throws(() => applyCanvasOperation(unnamedDeleted, {
    opId: 'forge-handle-on-unnamed-edge',
    type: 'edge.restore',
    payload: { edge: { ...unnamedEdge, sourceHandle: 'text-out' } },
  }), /sourceHandle 与删除记录不一致/);

  const cascaded = applyCanvasOperation(base, {
    opId: 'delete-node-with-named-edge', type: 'node.delete', payload: { nodeId: 'a' },
  }).document;
  assert.equal(cascaded.tombstones.edges.e1.sourceHandle, 'text-out');
  assert.equal(cascaded.tombstones.edges.e1.targetHandle, 'text-in');
});

test('UUID deletes preserve tombstone identity and require explicit UUID-aware restore', () => {
  const base = normalizeCanvasDocument('canvas-uuid-delete', {
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [{ id: 'e1', source: 'a', target: 'b' }],
  });
  const originalUid = base.nodes[0].entityUid;
  const deleted = applyCanvasOperation(base, {
    opId: 'delete-by-uuid', type: 'node.delete', payload: { nodeId: originalUid },
  }).document;
  assert.equal(deleted.tombstones.nodes.a.entityUid, originalUid);
  assert.throws(() => applyCanvasOperation(deleted, {
    opId: 'patch-deleted-uuid', type: 'node.patch', payload: { nodeId: originalUid, dataPatch: { stale: true } },
  }), /必须显式恢复/);
  const restored = applyCanvasOperation(deleted, {
    opId: 'restore-by-uuid', type: 'node.restore', payload: { node: { id: 'a', entityUid: originalUid } },
  }).document;
  assert.equal(restored.nodes.find((node) => node.id === 'a').entityUid, originalUid);
});

test('operation envelopes reject cross-project and cross-canvas writes', () => {
  const base = normalizeCanvasDocument('canvas-a', { nodes: [], edges: [] }, { projectId: 'project-a' });
  assert.throws(() => applyCanvasOperation(base, {
    opId: 'wrong-project', projectId: 'project-b', canvasId: 'canvas-a', type: 'viewport.set', payload: { viewport: {} },
  }), /projectId/);
  assert.throws(() => applyCanvasOperation(base, {
    opId: 'wrong-canvas', projectId: 'project-a', canvasId: 'canvas-b', type: 'viewport.set', payload: { viewport: {} },
  }), /canvasId/);
});

test('database applies operations atomically, returns deltas and deduplicates opId', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const initial = db.ensureCanvas('canvas-a', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    const moveOperation = {
      opId: 'move-a',
      actorId: 'member-1',
      sessionId: 'session-1',
      clientSeq: 1,
      type: 'node.move',
      payload: { nodeId: 'a', position: { x: 20, y: 40 } },
    };
    const first = db.applyOperations('canvas-a', [moveOperation], { expectedRevision: initial.revision });
    assert.equal(first.document.revision, 2);
    assert.deepEqual(first.document.nodes[0].position, { x: 20, y: 40 });

    const duplicate = db.applyOperations('canvas-a', [moveOperation], {
      expectedRevision: initial.revision,
    });
    assert.equal(duplicate.document.revision, 2);
    assert.equal(duplicate.acknowledgements[0].duplicate, true);
    assert.deepEqual(duplicate.document.nodes[0].position, { x: 20, y: 40 });

    assert.throws(() => db.applyOperations('canvas-a', [{
      opId: 'move-a',
      actorId: 'member-1',
      sessionId: 'session-1',
      clientSeq: 1,
      type: 'node.move',
      payload: { nodeId: 'a', position: { x: 999, y: 999 } },
    }], { expectedRevision: initial.revision }), (error) => error?.code === 'operation_id_conflict');

    const sync = db.syncCanvas('canvas-a', 1);
    assert.equal(sync.mode, 'operations');
    assert.equal(sync.operations.length, 1);
    assert.equal(sync.operations[0].type, 'node.move');
    const audits = db.listAuditEvents({ canvasId: 'canvas-a' });
    assert.equal(audits.some((event) => event.action === 'canvas.node.move'), true);
  } finally {
    db.close();
  }
});

test('schema migrations are idempotent and rollback atomically on failure', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-project-migration-'));
  const filename = path.join(directory, 'projects.sqlite3');
  try {
    assert.throws(() => new ProjectDatabase(filename, {
      autoBackup: false,
      beforeMigrationCommit: () => { throw new Error('injected migration failure'); },
    }), /injected migration failure/);
    const db = new ProjectDatabase(filename, { autoBackup: false });
    try {
      const versions = db.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
      assert.deepEqual(versions, Array.from({ length: PROJECT_DATABASE_SCHEMA_VERSION }, (_, index) => index + 1));
      assert.doesNotThrow(() => db.migrate());
      assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, PROJECT_DATABASE_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('subflow versions are isolated by project and allow the same id and version', () => {
  const db = new ProjectDatabase(':memory:');
  const base = {
    id: 'shared-flow', version: 1, name: 'shared', description: '', tags: [], nodes: [{ id: 'n', type: 'text', data: {}, position: { x: 0, y: 0 } }],
    edges: [], inputs: [], outputs: [], exposedParameters: [], requiredCapabilities: [], assetRefs: [],
  };
  try {
    const projectA = db.saveSubflowDefinition({ ...base, projectId: 'project-a', name: 'A' });
    const projectB = db.saveSubflowDefinition({ ...base, projectId: 'project-b', name: 'B' });
    assert.equal(projectA.version, 1);
    assert.equal(projectB.version, 1);
    assert.equal(db.getSubflowDefinition('shared-flow', 1, 'project-a').name, 'A');
    assert.equal(db.getSubflowDefinition('shared-flow', 1, 'project-b').name, 'B');
    assert.equal(db.getSubflowDefinition('shared-flow', 1, 'project-c'), null);
    assert.deepEqual(db.listSubflowVersions('shared-flow', 'project-a').map((item) => item.name), ['A']);
    assert.deepEqual(db.listSubflowDefinitions({ projectId: 'project-b' }).map((item) => item.name), ['B']);
  } finally {
    db.close();
  }
});

test('subflow definition revision is independent from immutable version and stale publishers keep the current head', () => {
  const db = new ProjectDatabase(':memory:');
  const base = {
    id: 'revision-flow', version: 7, projectId: 'project-a', name: 'Revision flow', description: '', tags: [],
    nodes: [{ id: 'n', type: 'text', data: { text: 'first' }, position: { x: 0, y: 0 } }],
    edges: [], inputs: [], outputs: [], exposedParameters: [], requiredCapabilities: [], assetRefs: [],
  };
  try {
    const first = db.saveSubflowDefinition(base, {
      expectedRevision: 0,
      actorId: 'editor-a',
      sessionId: 'session-a',
      changeSummary: '创建可复用定义',
    });
    assert.equal(first.version, 7);
    assert.equal(first.revision, 1);
    assert.equal(first.changeSummary, '创建可复用定义');
    assert.equal(first.publishedBy, 'editor-a');

    const second = db.saveSubflowDefinition({
      ...first,
      name: 'Revision flow v2',
      nodes: [{ ...first.nodes[0], data: { text: 'second' } }],
    }, {
      expectedRevision: 1,
      actorId: 'editor-b',
      sessionId: 'session-b',
      changeSummary: '更新文本节点',
    });
    assert.equal(second.version, 8);
    assert.equal(second.revision, 2);
    assert.equal(db.getSubflowDefinition('revision-flow', 7, 'project-a').nodes[0].data.text, 'first');

    assert.throws(() => db.saveSubflowDefinition({ ...first, name: 'stale overwrite' }, {
      expectedRevision: 1,
      actorId: 'editor-a',
      sessionId: 'session-a',
      changeSummary: '过期草稿',
    }), (error) => {
      assert.ok(error instanceof SubflowRevisionConflictError);
      assert.equal(error.code, 'subflow_revision_conflict');
      assert.equal(error.current.revision, 2);
      assert.equal(error.current.latestVersion, 8);
      assert.equal(error.current.definition.name, 'Revision flow v2');
      return true;
    });

    const head = db.getSubflowDefinitionHead('revision-flow', 'project-a');
    assert.equal(head.revision, 2);
    assert.equal(head.latestVersion, 8);
    assert.equal(head.updatedBy, 'editor-b');
    assert.equal(head.definition.version, 8);
    assert.equal(db.getSubflowDefinitionHead('revision-flow', 'project-b'), null);

    const audits = db.listAuditEvents({ projectId: 'project-a', action: 'subflow.definition.publish' });
    assert.equal(audits.length, 2);
    assert.deepEqual(audits[0].metadata, {
      version: 8,
      revision: 2,
      previousRevision: 1,
      changeSummary: '更新文本节点',
    });
    assert.equal(audits[0].actorId, 'editor-b');
    assert.equal(audits[0].sessionId, 'session-b');
  } finally {
    db.close();
  }
});

test('concurrent subflow writers allocate unique monotonic immutable versions', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-subflow-version-race-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const seed = new ProjectDatabase(filename, { autoBackup: false });
  await seed.close();
  const workerCount = 8;
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(shared);
  const modulePath = path.resolve(__dirname, '../backend/src/services/projectDatabase.js');
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { ProjectDatabase } = require(workerData.modulePath);
    const barrier = new Int32Array(workerData.shared);
    // This is an intentionally unreachable-in-production low-level SQLite CAS
    // fixture. Production defaults reject the second owner; the independent
    // process proof is frozen in projectDatabaseOwnerB2.test.cjs.
    const db = new ProjectDatabase(workerData.filename, {
      autoBackup: false,
      unsafeDisableOwnerGuardForTests: true,
    });
    parentPort.postMessage({ ready: true });
    Atomics.wait(barrier, 1, 0);
    try {
      const saved = db.saveSubflowDefinition({ id: 'race-flow', projectId: 'project-a', name: 'worker', description: '', tags: [], nodes: [{ id: 'n', type: 'text', data: {}, position: { x: 0, y: 0 } }], edges: [], inputs: [], outputs: [], exposedParameters: [], requiredCapabilities: [], assetRefs: [] });
      parentPort.postMessage({ version: saved.version });
    } catch (error) {
      parentPort.postMessage({ error: error.message });
    } finally { db.close(); }
  `;
  let workers = [];
  try {
    const results = [];
    for (let index = 0; index < workerCount; index += 1) {
      const worker = new Worker(workerSource, { eval: true, workerData: { filename, modulePath, shared } });
      workers.push(worker);
      await new Promise((resolve, reject) => {
        const onMessage = (message) => {
          if (!message?.ready) return;
          worker.off('error', reject);
          resolve();
        };
        worker.once('message', onMessage);
        worker.once('error', reject);
      });
      results.push(new Promise((resolve, reject) => {
        const onMessage = (message) => { if (!message?.ready) resolve(message); };
        worker.on('message', onMessage);
        worker.once('error', reject);
      }));
    }
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1, workerCount);
    const messages = await Promise.all(results);
    assert.deepEqual(messages.filter((item) => item.error), []);
    assert.deepEqual(messages.map((item) => item.version).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
    const verify = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.deepEqual(verify.listSubflowVersions('race-flow', 'project-a').map((item) => item.version), [8, 7, 6, 5, 4, 3, 2, 1]);
    } finally { verify.close(); }
  } finally {
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy subflow primary key migrates atomically to project scoped identity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-subflow-project-key-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const legacy = new BetterSqlite3(filename);
  const definition = {
    id: 'legacy-flow', version: 1, projectId: 'project-a', name: 'legacy', description: '', tags: [], nodes: [{ id: 'n', type: 'text', data: {}, position: { x: 0, y: 0 } }],
    edges: [], inputs: [], outputs: [], exposedParameters: [], requiredCapabilities: [], assetRefs: [],
  };
  try {
    legacy.exec(`
      CREATE TABLE subflow_definitions (
        id TEXT NOT NULL, version INTEGER NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL,
        definition_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(id, version)
      );
    `);
    legacy.prepare(`INSERT INTO subflow_definitions(id, version, project_id, name, definition_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-flow', 1, 'project-a', 'legacy', JSON.stringify(definition), 'owner', 1);
  } finally {
    legacy.close();
  }
  try {
    const db = new ProjectDatabase(filename, { autoBackup: false });
    try {
      const primaryKey = db.db.pragma('table_info(subflow_definitions)').filter((entry) => entry.pk).sort((a, b) => a.pk - b.pk).map((entry) => entry.name);
      assert.deepEqual(primaryKey, ['project_id', 'id', 'version']);
      assert.equal(db.getSubflowDefinition('legacy-flow', 1, 'project-a').name, 'legacy');
      assert.deepEqual(db.getSubflowDefinitionHead('legacy-flow', 'project-a'), {
        projectId: 'project-a',
        id: 'legacy-flow',
        revision: 1,
        latestVersion: 1,
        updatedBy: 'legacy-migration',
        updatedAt: 1,
        definition: db.getSubflowDefinition('legacy-flow', 1, 'project-a'),
      });
      assert.doesNotThrow(() => db.saveSubflowDefinition({ ...definition, projectId: 'project-b', name: 'other' }));
      assert.equal(db.getSubflowDefinition('legacy-flow', 1, 'project-b').name, 'other');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy database migration persists canvas and asset UUID identities in place', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-project-legacy-identity-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const legacy = new BetterSqlite3(filename);
  try {
    legacy.exec(`
      CREATE TABLE canvas_documents (
        canvas_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE assets (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, content_hash TEXT, kind TEXT NOT NULL, mime_type TEXT,
        filename TEXT NOT NULL, managed_path TEXT, source_url TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
        provenance_json TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    legacy.prepare(`
      INSERT INTO canvas_documents(canvas_id, project_id, schema_version, revision, snapshot_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-canvas', 'legacy-project', 1, 7, JSON.stringify({ nodes: [{ id: 'legacy-node' }], edges: [] }), 1, 2);
    legacy.prepare(`
      INSERT INTO assets(id, project_id, kind, filename, metadata_json, provenance_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, '{}', '{}', ?, ?, ?)
    `).run('legacy-asset', 'legacy-project', 'image', 'legacy.png', 'legacy-owner', 1, 2);
  } finally {
    legacy.close();
  }

  try {
    const db = new ProjectDatabase(filename, { autoBackup: false });
    try {
      const canvas = db.getCanvas('legacy-canvas');
      const asset = db.getAsset('legacy-asset');
      assert.match(canvas.entityUid, /^[0-9a-f-]{36}$/);
      assert.match(canvas.nodes[0].entityUid, /^[0-9a-f-]{36}$/);
      assert.equal(JSON.parse(db.db.prepare('SELECT snapshot_json FROM canvas_documents WHERE canvas_id = ?').get('legacy-canvas').snapshot_json).entityUid, canvas.entityUid);
      assert.equal(db.db.prepare('SELECT entity_uid FROM assets WHERE id = ?').get('legacy-asset').entity_uid, asset.entityUid);
      assert.equal(db.db.prepare('SELECT revision FROM canvas_documents WHERE canvas_id = ?').get('legacy-canvas').revision, 7);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('canvas snapshots can be listed and restored without rewriting history in place', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    db.ensureCanvas('canvas-history', { nodes: [{ id: 'a', data: { value: 1 } }], edges: [] });
    db.saveCanvasSnapshot('canvas-history', { nodes: [{ id: 'a', data: { value: 2 } }], edges: [] }, { expectedRevision: 1 });
    const restored = db.restoreCanvasSnapshot('canvas-history', 1, { expectedRevision: 2, actorId: 'owner-a' });
    assert.equal(restored.revision, 3);
    assert.equal(restored.nodes[0].data.value, 1);
    assert.deepEqual(db.listCanvasSnapshots('canvas-history').map((entry) => entry.revision), [3, 2, 1]);
    const restoreAudit = db.listAuditEvents({ canvasId: 'canvas-history', action: 'canvas.snapshot.restore' })[0];
    assert.equal(restoreAudit.actorId, 'owner-a');
    assert.deepEqual(restoreAudit.metadata, { sourceRevision: 1, restoredRevision: 3 });
  } finally {
    db.close();
  }
});

test('subflow parameter overrides and fixed definition survive database close and reopen', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-subflow-override-'));
  const databasePath = path.join(directory, 'project.sqlite');
  const definition = {
    id: 'definition-a', version: 4, projectId: 'canvas-parameter-history', name: 'Reusable prompt',
    nodes: [{ id: 'prompt-node', type: 'text', position: { x: 0, y: 0 }, data: { prompt: 'default' } }],
    edges: [], inputs: [], outputs: [],
    exposedParameters: [{ id: 'prompt', nodeId: 'prompt-node', dataKey: 'prompt', name: 'Prompt', defaultValue: 'default', schema: { type: 'string' } }],
  };
  try {
    const first = new ProjectDatabase(databasePath);
    try {
      first.ensureCanvas('canvas-parameter-history', {
        nodes: [{
          id: 'instance-a', type: 'subflow', position: { x: 40, y: 60 },
          data: { definitionId: definition.id, definitionVersion: definition.version, definition, parameterOverrides: {} },
        }],
        edges: [],
      });
      first.saveCanvasSnapshot('canvas-parameter-history', {
        nodes: [{
          id: 'instance-a', type: 'subflow', position: { x: 40, y: 60 },
          data: {
            definitionId: definition.id,
            definitionVersion: definition.version,
            definition,
            parameterOverrides: { prompt: 'persisted after reload', enabled: true, steps: 28 },
          },
        }],
        edges: [],
      }, { expectedRevision: 1 });
    } finally {
      await first.close();
    }

    const reopened = new ProjectDatabase(databasePath);
    try {
      const canvas = reopened.getCanvas('canvas-parameter-history');
      assert.equal(canvas.revision, 2);
      assert.equal(canvas.nodes[0].data.definition.id, definition.id);
      assert.equal(canvas.nodes[0].data.definition.version, 4);
      assert.deepEqual(canvas.nodes[0].data.parameterOverrides, {
        prompt: 'persisted after reload', enabled: true, steps: 28,
      });
    } finally {
      await reopened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('subflow library metadata and independent copy survive database close and reopen', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-subflow-library-'));
  const databasePath = path.join(directory, 'project.sqlite');
  const projectId = 'project-subflow-library';
  const base = {
    id: 'library-source', version: 1, projectId, name: '角色生成流程', description: 'library persistence',
    category: '未分类', tags: ['旧标签'],
    nodes: [{ id: 'prompt', type: 'text', position: { x: 20, y: 40 }, data: { text: 'portrait' } }],
    edges: [], inputs: [], outputs: [], exposedParameters: [], requiredCapabilities: [], assetRefs: [],
  };
  try {
    const first = new ProjectDatabase(databasePath);
    let categorized;
    try {
      const created = first.saveSubflowDefinition(base, {
        expectedRevision: 0, actorId: 'owner-a', changeSummary: '创建本地库流程',
      });
      categorized = first.saveSubflowDefinition({
        ...created, category: '图像流程', tags: ['角色', '常用'],
      }, {
        expectedRevision: created.revision, actorId: 'owner-a', changeSummary: '更新子工作流分类与标签',
      });
      const {
        entityUid: _entityUid, version: _version, revision: _revision, changeSummary: _summary, publishedBy: _publisher,
        publishedAt: _publishedAt, createdAt: _createdAt, updatedAt: _updatedAt, ...copyContent
      } = categorized;
      const copied = first.saveSubflowDefinition({
        ...JSON.parse(JSON.stringify(copyContent)), id: 'library-independent-copy', name: '角色生成流程 副本',
      }, {
        expectedRevision: 0, actorId: 'owner-a', changeSummary: '从 角色生成流程 v2 另存独立副本',
      });
      assert.equal(categorized.version, 2);
      assert.equal(categorized.revision, 2);
      assert.equal(copied.version, 1);
      assert.equal(copied.revision, 1);
    } finally {
      await first.close();
    }

    const reopened = new ProjectDatabase(databasePath);
    try {
      const sourceV1 = reopened.getSubflowDefinition('library-source', 1, projectId);
      const sourceV2 = reopened.getSubflowDefinition('library-source', 2, projectId);
      const copied = reopened.getSubflowDefinition('library-independent-copy', 1, projectId);
      assert.equal(sourceV1.category, '未分类');
      assert.deepEqual(sourceV1.tags, ['旧标签']);
      assert.equal(sourceV2.category, '图像流程');
      assert.deepEqual(sourceV2.tags, ['角色', '常用']);
      assert.equal(copied.name, '角色生成流程 副本');
      assert.equal(copied.category, '图像流程');
      assert.deepEqual(copied.tags, ['角色', '常用']);
      assert.deepEqual(copied.nodes, sourceV2.nodes);
      assert.notEqual(copied.id, sourceV2.id);
      assert.notEqual(copied.entityUid, sourceV2.entityUid);
      assert.deepEqual(
        reopened.listSubflowDefinitions({ projectId }).map((item) => [item.id, item.version]).sort(),
        [['library-independent-copy', 1], ['library-source', 2]],
      );
      assert.deepEqual(
        reopened.listSubflowDefinitions({ projectId, query: '角色' }).map((item) => item.id).sort(),
        ['library-independent-copy', 'library-source'],
      );
      assert.deepEqual(
        reopened.listSubflowDefinitions({ projectId, query: '图像流程' }).map((item) => item.id).sort(),
        ['library-independent-copy', 'library-source'],
      );
    } finally {
      await reopened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('three-level multi-port subflow graph survives database close and reopen unchanged', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-subflow-production-matrix-'));
  const databasePath = path.join(directory, 'project.sqlite');
  const canvasId = 'canvas-subflow-production-matrix';
  const inner = {
    id: 'persist-inner', version: 3, projectId: canvasId, name: 'inner', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], edges: [],
    nodes: [
      { id: 'left-leaf', type: 'text', position: { x: 0, y: 0 }, data: { text: 'left' } },
      { id: 'right-leaf', type: 'text', position: { x: 200, y: 0 }, data: { text: 'right' } },
    ],
    inputs: [
      { id: 'left-prompt', name: 'Left prompt', kind: 'text', required: true, minConnections: 1, maxConnections: 1, internalNodeId: 'left-leaf', internalHandle: 'text-in' },
      { id: 'right-prompt', name: 'Right prompt', kind: 'text', required: true, minConnections: 1, maxConnections: 1, internalNodeId: 'right-leaf', internalHandle: 'text-in' },
    ],
    outputs: [
      { id: 'left', name: 'Left', kind: 'text', required: false, internalNodeId: 'left-leaf', internalHandle: 'text-out' },
      { id: 'right', name: 'Right', kind: 'text', required: false, internalNodeId: 'right-leaf', internalHandle: 'text-out' },
    ],
  };
  const middle = {
    id: 'persist-middle', version: 5, projectId: canvasId, name: 'middle', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], edges: [],
    nodes: [{ id: 'inner-use', type: 'subflow', position: { x: 0, y: 0 }, data: { definition: inner, definitionId: inner.id, definitionVersion: inner.version, definitionProjectId: canvasId } }],
    inputs: [
      { id: 'left-prompt', name: 'Left prompt', kind: 'text', required: true, minConnections: 1, maxConnections: 1, internalNodeId: 'inner-use', internalHandle: 'left-prompt' },
      { id: 'right-prompt', name: 'Right prompt', kind: 'text', required: true, minConnections: 1, maxConnections: 1, internalNodeId: 'inner-use', internalHandle: 'right-prompt' },
    ],
    outputs: [
      { id: 'left', name: 'Left', kind: 'text', required: false, internalNodeId: 'inner-use', internalHandle: 'left' },
      { id: 'right', name: 'Right', kind: 'text', required: false, internalNodeId: 'inner-use', internalHandle: 'right' },
    ],
  };
  const outer = {
    id: 'persist-outer', version: 8, projectId: canvasId, name: 'outer', description: '', tags: [], requiredCapabilities: [], assetRefs: [], exposedParameters: [], edges: [],
    nodes: [{ id: 'middle-use', type: 'subflow', position: { x: 0, y: 0 }, data: { definition: middle, definitionId: middle.id, definitionVersion: middle.version, definitionProjectId: canvasId } }],
    inputs: [
      { id: 'left-prompt', name: 'Left prompt', kind: 'text', required: true, minConnections: 1, maxConnections: 1, internalNodeId: 'middle-use', internalHandle: 'left-prompt' },
      { id: 'right-prompt', name: 'Right prompt', kind: 'text', required: true, minConnections: 1, maxConnections: 1, internalNodeId: 'middle-use', internalHandle: 'right-prompt' },
    ],
    outputs: [
      { id: 'left', name: 'Left', kind: 'text', required: false, internalNodeId: 'middle-use', internalHandle: 'left' },
      { id: 'right', name: 'Right', kind: 'text', required: false, internalNodeId: 'middle-use', internalHandle: 'right' },
    ],
  };
  const snapshot = {
    nodes: [
      { id: 'source-left', type: 'text', position: { x: 0, y: 0 }, data: { text: 'left input' } },
      { id: 'source-right', type: 'text', position: { x: 0, y: 200 }, data: { text: 'right input' } },
      { id: 'outer-instance', type: 'subflow', position: { x: 400, y: 100 }, data: { definition: outer, definitionId: outer.id, definitionVersion: outer.version, definitionProjectId: canvasId, parameterOverrides: { mode: 'persisted' } } },
      { id: 'sink-left', type: 'output', position: { x: 900, y: 0 }, data: {} },
      { id: 'sink-right', type: 'output', position: { x: 900, y: 200 }, data: {} },
    ],
    edges: [
      { id: 'enter-left', source: 'source-left', sourceHandle: 'text-out', target: 'outer-instance', targetHandle: 'left-prompt' },
      { id: 'enter-right', source: 'source-right', sourceHandle: 'text-out', target: 'outer-instance', targetHandle: 'right-prompt' },
      { id: 'leave-left', source: 'outer-instance', sourceHandle: 'left', target: 'sink-left', targetHandle: 'text-in' },
      { id: 'leave-right', source: 'outer-instance', sourceHandle: 'right', target: 'sink-right', targetHandle: 'text-in' },
    ],
  };
  try {
    const first = new ProjectDatabase(databasePath);
    try {
      first.ensureCanvas(canvasId, { nodes: [], edges: [] });
      first.saveCanvasSnapshot(canvasId, snapshot, { expectedRevision: 1 });
    } finally {
      await first.close();
    }

    const reopened = new ProjectDatabase(databasePath);
    try {
      const canvas = reopened.getCanvas(canvasId);
      const instance = canvas.nodes.find((node) => node.id === 'outer-instance');
      assert.equal(canvas.revision, 2);
      assert.deepEqual(instance.data.definition, outer);
      assert.deepEqual(instance.data.parameterOverrides, { mode: 'persisted' });
      assert.deepEqual(canvas.edges.map((edge) => [edge.id, edge.sourceHandle, edge.targetHandle]), [
        ['enter-left', 'text-out', 'left-prompt'],
        ['enter-right', 'text-out', 'right-prompt'],
        ['leave-left', 'left', 'text-in'],
        ['leave-right', 'right', 'text-in'],
      ]);
    } finally {
      await reopened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('invite and member lifecycle refreshes roles, revokes removed-member sessions and records audits', () => {
  const db = new ProjectDatabase(':memory:');
  const auth = new CollaborationAuth(db);
  try {
    db.ensureCanvas('canvas-auth-lifecycle', { nodes: [], edges: [] }, 'project-local');
    const invite = auth.createInvite({
      projectId: 'project-local',
      canvasId: 'canvas-auth-lifecycle',
      role: 'editor',
      maxUses: 2,
    });
    const listedInvite = db.listInvites()[0];
    assert.equal(listedInvite.id, invite.id);
    assert.equal(Object.hasOwn(listedInvite, 'codeHash'), false);

    const redeemed = auth.redeemInvite(invite.code, 'Alice');
    assert.equal(auth.authenticate(redeemed.token).role, 'editor');
    const updated = auth.updateMember(redeemed.memberId, { role: 'reviewer' }, { actorId: 'owner-a' });
    assert.equal(updated.role, 'reviewer');
    assert.deepEqual(updated.capabilities.sort(), ['approve', 'comment', 'downloadOriginal'].sort());
    const refreshedSession = auth.authenticate(redeemed.token);
    assert.equal(refreshedSession.role, 'reviewer');
    assert.equal(refreshedSession.canvasId, 'canvas-auth-lifecycle');
    assert.deepEqual(refreshedSession.capabilities.sort(), ['approve', 'comment', 'downloadOriginal'].sort());

    const revoked = auth.revokeInvite(invite.id, { actorId: 'owner-a' });
    assert.equal(revoked.id, invite.id);
    assert.equal(auth.redeemInvite(invite.code, 'Bob'), null);

    const secondInvite = auth.createInvite({
      projectId: 'project-local',
      canvasId: 'canvas-auth-lifecycle',
      role: 'viewer',
    });
    const second = auth.redeemInvite(secondInvite.code, 'Carol');
    assert.equal(auth.removeMember(second.memberId, { actorId: 'owner-a' }).id, second.memberId);
    assert.equal(auth.authenticate(second.token), null);
    assert.equal(db.listAuditEvents().some((event) => event.action === 'collaboration.member.remove'), true);
  } finally {
    db.close();
  }
});

test('session rotation invalidates the old token and preserves member capabilities', () => {
  const db = new ProjectDatabase(':memory:');
  const auth = new CollaborationAuth(db);
  try {
    db.ensureCanvas('canvas-auth-rotation', { nodes: [], edges: [] }, 'project-local');
    const invite = auth.createInvite({
      projectId: 'project-local',
      canvasId: 'canvas-auth-rotation',
      role: 'editor',
    });
    const redeemed = auth.redeemInvite(invite.code, 'Rotate User');
    const current = auth.authenticate(redeemed.token);
    const rotated = auth.rotate(current);
    assert.equal(auth.authenticate(redeemed.token), null);
    assert.equal(auth.authenticate(rotated.token).memberId, current.memberId);
    assert.deepEqual(auth.authenticate(rotated.token).capabilities, current.capabilities);
    assert.equal(db.listAuditEvents({ action: 'collaboration.session.rotate' }).length, 1);
  } finally {
    db.close();
  }
});

test('snapshot replacement and stale operation both enforce revision conflicts', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    db.ensureCanvas('canvas-a', { nodes: [], edges: [] });
    const saved = db.saveCanvasSnapshot('canvas-a', { nodes: [{ id: 'a' }], edges: [] }, { expectedRevision: 1 });
    assert.equal(saved.revision, 2);
    assert.throws(
      () => db.applyOperations('canvas-a', [{ type: 'node.delete', payload: { nodeId: 'a' } }], { expectedRevision: 1 }),
      RevisionConflictError,
    );
    const sync = db.syncCanvas('canvas-a', 1);
    assert.equal(sync.mode, 'snapshot');
    assert.equal(sync.document.nodes[0].id, 'a');
  } finally {
    db.close();
  }
});

test('sync falls back to a snapshot when compacted operation history has a gap', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    db.ensureCanvas('canvas-gap', { nodes: [{ id: 'a', position: { x: 0, y: 0 }, data: {} }], edges: [] });
    db.applyOperations('canvas-gap', [{ opId: 'move-1', type: 'node.move', payload: { nodeId: 'a', position: { x: 1, y: 1 } } }], { expectedRevision: 1 });
    db.applyOperations('canvas-gap', [{ opId: 'move-2', type: 'node.move', payload: { nodeId: 'a', position: { x: 2, y: 2 } } }], { expectedRevision: 2 });
    db.db.prepare('DELETE FROM canvas_operations WHERE canvas_id = ? AND revision = ?').run('canvas-gap', 2);
    const sync = db.syncCanvas('canvas-gap', 1);
    assert.equal(sync.mode, 'snapshot');
    assert.deepEqual(sync.document.nodes[0].position, { x: 2, y: 2 });
  } finally {
    db.close();
  }
});

test('run secret scanner catches raw leaks and accepts recursively redacted payloads', () => {
  const raw = {
    note: 'Authorization: Bearer hidden-token-value',
    debug: 'request failed with sk-examplecredential123456789',
    headers: { cookie: 'session=must-not-survive' },
    image: `data:image/png;base64,${'A'.repeat(128)}`,
    url: 'https://example.com/file.png?X-Amz-Credential=credential-secret&X-Amz-Signature=signed-secret',
  };
  const findings = scanRunValueForSecrets(raw);
  assert.equal(findings.some((item) => item.endsWith(':authorization')), true);
  assert.equal(findings.some((item) => item.endsWith(':api-key')), true);
  assert.equal(findings.some((item) => item.endsWith(':secret-field')), true);
  assert.equal(findings.some((item) => item.endsWith(':base64')), true);
  assert.equal(findings.some((item) => item.includes(':signed-url:')), true);

  const safe = redactAndScanRunValue(raw);
  assert.deepEqual(scanRunValueForSecrets(safe), []);
  assert.equal(safe.headers.cookie, '[redacted]');
  assert.match(safe.note, /authorization: \[redacted\]/i);
  assert.doesNotMatch(JSON.stringify(safe), /hidden-token-value|examplecredential123456789|must-not-survive|credential-secret|signed-secret/);
});

test('run hierarchy persists node attempts and redacts credentials and large payloads', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const canvas = db.ensureCanvas('canvas-a', { nodes: [], edges: [] }, 'project-local');
    const run = db.createRun({
      projectId: canvas.projectId,
      canvasId: canvas.canvasId,
      canvasRevision: canvas.revision,
      status: 'running',
    });
    const snapshot = redactRunValue({
      prompt: 'hello',
      apiKey: 'sk-should-not-survive',
      authorization: 'Bearer hidden',
      cookie: 'session=must-not-survive',
      nested: { refreshToken: 'refresh-must-not-survive', totalTokens: 77 },
      image: `data:image/png;base64,${'A'.repeat(8000)}`,
      url: 'https://example.com/file.png?signature=secret&X-Amz-Credential=credential-secret&size=1',
    });
    const parentNodeRun = db.createNodeRun({ runId: run.id, nodeId: 'subflow-instance', status: 'running', inputSnapshot: { definitionId: 'flow-a', definitionVersion: 2 } });
    const nodeRun = db.createNodeRun({ runId: run.id, nodeId: 'subflow-instance::node-a', parentNodeRunId: parentNodeRun.id, originalNodeId: 'node-a', definitionId: 'flow-a', definitionVersion: 2, subflowPath: ['subflow-instance'], status: 'running', inputSnapshot: snapshot });
    const attempt = db.createAttempt({ nodeRunId: nodeRun.id, provider: 'test-provider', model: 'model-a', status: 'polling' });
    db.updateAttempt(attempt.id, {
      status: 'succeeded',
      upstreamTaskId: 'task-a',
      requestId: 'request-a',
      httpStatus: 200,
      pollCount: 4,
      usage: { totalTokens: 12 },
      metadata: { transport: 'local-backend' },
    });
    db.updateNodeRun(
      nodeRun.id,
      { status: 'succeeded', outputRefs: ['asset-a'] },
      { allowOutputRefs: true },
    );
    db.updateRun(run.id, { status: 'succeeded' });

    const storedNodeRun = db.getNodeRun(nodeRun.id);
    assert.equal(storedNodeRun.inputSnapshot.apiKey, '[redacted]');
    assert.equal(storedNodeRun.inputSnapshot.authorization, '[redacted]');
    assert.equal(storedNodeRun.inputSnapshot.cookie, '[redacted]');
    assert.equal(storedNodeRun.inputSnapshot.nested.refreshToken, '[redacted]');
    assert.equal(storedNodeRun.inputSnapshot.nested.totalTokens, 77);
    assert.match(storedNodeRun.inputSnapshot.image, /base64 omitted/);
    assert.equal(new URL(storedNodeRun.inputSnapshot.url).searchParams.get('signature'), '[redacted]');
    assert.equal(new URL(storedNodeRun.inputSnapshot.url).searchParams.get('X-Amz-Credential'), '[redacted]');
    assert.doesNotMatch(JSON.stringify(storedNodeRun), /sk-should-not-survive|session=must-not-survive|refresh-must-not-survive|credential-secret/);
    assert.equal(storedNodeRun.parentNodeRunId, parentNodeRun.id);
    assert.equal(storedNodeRun.originalNodeId, 'node-a');
    assert.equal(storedNodeRun.definitionId, 'flow-a');
    assert.equal(storedNodeRun.definitionVersion, 2);
    assert.deepEqual(storedNodeRun.subflowPath, ['subflow-instance']);
    assert.equal(db.listAttempts(nodeRun.id)[0].attemptNumber, 1);
    assert.equal(db.listAttempts(nodeRun.id)[0].status, 'succeeded');
    assert.equal(db.listAttempts(nodeRun.id)[0].requestId, 'request-a');
    assert.equal(db.listAttempts(nodeRun.id)[0].httpStatus, 200);
    assert.equal(db.listAttempts(nodeRun.id)[0].pollCount, 4);
    assert.deepEqual(db.listAttempts(nodeRun.id)[0].usage, { totalTokens: 12 });
    assert.deepEqual(db.listAttempts(nodeRun.id)[0].metadata, { transport: 'local-backend' });
    assert.deepEqual(db.listNodeRuns(run.id).find((item) => item.id === nodeRun.id).outputRefs, ['asset-a']);
  } finally {
    db.close();
  }
});

test('NodeRun outputRefs reject every default write and require the explicit internal authority option', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const run = db.createRun({ projectId: 'project-output-authority', canvasId: 'canvas-output-authority' });
    assert.throws(
      () => db.createNodeRun({ runId: run.id, nodeId: 'forged-create', outputRefs: [] }),
      (error) => error?.code === 'host_artifact_authority_required' && error?.status === 409,
    );
    assert.throws(
      () => db.createNodeRun(Object.assign(
        Object.create({ outputRefs: ['prototype-forged-asset'] }),
        { runId: run.id, nodeId: 'prototype-forged-create' },
      )),
      (error) => error?.code === 'host_artifact_authority_required',
    );
    const nodeRun = db.createNodeRun({ runId: run.id, nodeId: 'trusted-node' });
    assert.throws(
      () => db.updateNodeRun(nodeRun.id, { outputRefs: ['forged-asset'] }),
      (error) => error?.code === 'host_artifact_authority_required' && error?.status === 409,
    );
    const internallyUpdated = db.updateNodeRun(
      nodeRun.id,
      { outputRefs: ['trusted-asset'] },
      { allowOutputRefs: true },
    );
    assert.deepEqual(internallyUpdated.outputRefs, ['trusted-asset']);
  } finally {
    db.close();
  }
});

test('run list combines exact initiator, provider and model filters on the same attempt', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const addRun = (id, initiatorId, status, attempts) => {
      const run = db.createRun({ id, projectId: 'project-filter', canvasId: 'canvas-filter', initiatorId, status });
      const nodeRun = db.createNodeRun({ id: `${id}-node`, runId: run.id, nodeId: 'generate', status });
      attempts.forEach(([provider, model], index) => db.createAttempt({ id: `${id}-attempt-${index}`, nodeRunId: nodeRun.id, provider, model, status }));
      return run;
    };
    addRun('run-a', 'alice', 'succeeded', [['provider-a', 'model-a']]);
    addRun('run-b', 'alice', 'failed', [['provider-a', 'model-b']]);
    addRun('run-c', 'bob', 'succeeded', [['provider-b', 'model-a']]);
    addRun('run-cross', 'alice', 'succeeded', [['provider-a', 'model-b'], ['provider-b', 'model-a']]);
    const ids = (filters) => db.listRuns({ projectId: 'project-filter', ...filters }).map((run) => run.id).sort();

    assert.deepEqual(ids({ initiatorId: 'alice' }), ['run-a', 'run-b', 'run-cross']);
    assert.deepEqual(ids({ provider: 'provider-a' }), ['run-a', 'run-b', 'run-cross']);
    assert.deepEqual(ids({ model: 'model-a' }), ['run-a', 'run-c', 'run-cross']);
    assert.deepEqual(ids({ provider: 'provider-a', model: 'model-a' }), ['run-a']);
    assert.deepEqual(ids({ initiatorId: 'alice', provider: 'provider-a', model: 'model-b', status: 'failed' }), ['run-b']);
    assert.deepEqual(ids({ provider: "provider-a' OR 1=1 --" }), []);
  } finally {
    db.close();
  }
});

test('run outputs become deterministic project AssetRefs linked from the NodeRun', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    db.ensureCanvas('canvas-output', { nodes: [], edges: [] }, 'project-output');
    const run = db.createRun({ projectId: 'project-output', canvasId: 'canvas-output', status: 'running' });
    const nodeRun = db.createNodeRun({ runId: run.id, nodeId: 'image-a', status: 'running' });
    const attempt = db.createAttempt({ nodeRunId: nodeRun.id, provider: 'seedance-nz', model: 'seedream-v5-pro-t2i', status: 'running' });
    const first = db.recordRunOutputAssets({
      runId: run.id,
      nodeRunId: nodeRun.id,
      attemptId: attempt.id,
      outputs: [
        { kind: 'image', sourceUrl: '/files/output/generated.png', filename: 'generated.png' },
        { kind: 'text', text: 'caption', filename: 'caption.txt', mimeType: 'text/plain' },
      ],
    });
    const second = db.recordRunOutputAssets({
      runId: run.id,
      nodeRunId: nodeRun.id,
      attemptId: attempt.id,
      outputs: [{ kind: 'image', sourceUrl: '/files/output/generated.png', filename: 'generated.png' }],
    });

    assert.equal(first.assets.length, 2);
    assert.equal(second.assets[0].id, first.assets[0].id);
    assert.deepEqual(db.getNodeRun(nodeRun.id).outputRefs, first.assets.map((asset) => asset.id));
    assert.equal(first.assets[0].provenance.runId, run.id);
    assert.equal(first.assets[0].provenance.nodeRunId, nodeRun.id);
    assert.equal(first.assets[0].provenance.attemptId, attempt.id);
    assert.equal(first.assets[1].metadata.text, 'caption');
  } finally {
    db.close();
  }
});

test('run output lineage binds the exact node, Attempt, prompt, parent asset, canvas and creator', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const projectId = 'project-lineage';
    db.ensureCanvas('canvas-lineage', { nodes: [], edges: [] }, projectId);
    const parent = db.upsertAsset({
      projectId,
      id: 'asset-input-reference',
      kind: 'image',
      filename: 'reference.png',
      sourceUrl: '/files/input/reference.png',
      managedPath: 'C:\\host-only\\reference.png',
      storageMode: 'managed',
      availability: 'available',
      createdBy: 'alice',
    });
    const run = db.createRun({ projectId, canvasId: 'canvas-lineage', initiatorId: 'alice', status: 'running' });
    const nodeRun = db.createNodeRun({
      runId: run.id,
      nodeId: 'image-generator',
      originalNodeId: 'image-generator',
      status: 'running',
      inputSnapshot: {
        replayable: true,
        node: { id: 'image-generator', type: 'image', data: { prompt: 'cinematic penguin portrait', imageUrl: parent.sourceUrl } },
        upstreamNodes: [],
        incomingEdges: [],
      },
    });
    const attempt = db.createAttempt({ nodeRunId: nodeRun.id, provider: 'seedance-nz', model: 'seedream-v5-pro-i2i', status: 'running' });
    const result = db.recordRunOutputAssets({
      runId: run.id,
      nodeRunId: nodeRun.id,
      attemptId: attempt.id,
      outputs: [{ kind: 'image', sourceUrl: 'https://cdn.example/result.png', filename: 'result.png', metadata: { operation: 'image-to-image' } }],
    });
    const output = result.assets[0];
    const lineage = db.getAssetLineage(output.id);
    assert.equal(output.storageMode, 'remote');
    assert.equal(output.availability, 'unverified');
    assert.equal(output.createdBy, 'alice');
    assert.equal(lineage.length, 1);
    assert.equal(lineage[0].parentAssetId, parent.id);
    assert.equal(lineage[0].sourceNodeId, 'image-generator');
    assert.equal(lineage[0].sourceNodeType, 'image');
    assert.equal(lineage[0].runId, run.id);
    assert.equal(lineage[0].nodeRunId, nodeRun.id);
    assert.equal(lineage[0].attemptId, attempt.id);
    assert.equal(lineage[0].canvasId, 'canvas-lineage');
    assert.equal(lineage[0].creatorId, 'alice');
    assert.equal(lineage[0].promptSummary, 'cinematic penguin portrait');
    assert.match(lineage[0].promptDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(lineage[0].derivedOperation, 'image-to-image');
  } finally {
    db.close();
  }
});

test('canonical RunContext lifecycle events persist in causal order with one node identity', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const canvas = db.ensureCanvas('canvas-lifecycle', { nodes: [], edges: [] }, 'project-local');
    const run = db.createRun({
      projectId: canvas.projectId,
      canvasId: canvas.canvasId,
      canvasRevision: canvas.revision,
      status: 'queued',
    });
    db.appendRunEvent(run.id, { type: 'run.queued', payload: { status: 'queued', contextId: `run-context-${run.id}` } });
    db.updateRun(run.id, { status: 'running' });
    db.appendRunEvent(run.id, { type: 'run.running', payload: { status: 'running' } });
    const nodeRun = db.createNodeRun({ runId: run.id, nodeId: 'cinematic-a', status: 'queued' });
    const attempt = db.createAttempt({ nodeRunId: nodeRun.id, provider: 'canvas', status: 'running', timestamps: { queuedAt: 10, startedAt: 11 } });
    for (const [type, payload] of [
      ['node.queued', { nodeId: nodeRun.nodeId }],
      ['node.started', { nodeId: nodeRun.nodeId, executionToken: 'token-a' }],
      ['node.progress', { nodeId: nodeRun.nodeId, percent: 50 }],
      ['node.polling', { nodeId: nodeRun.nodeId, pollCount: 1 }],
      ['node.output', { nodeId: nodeRun.nodeId, outputCount: 1 }],
      ['node.succeeded', { nodeId: nodeRun.nodeId }],
    ]) {
      db.appendRunEvent(run.id, { nodeRunId: nodeRun.id, type, payload });
    }
    db.updateNodeRun(nodeRun.id, { status: 'succeeded' });
    db.updateAttempt(attempt.id, { status: 'succeeded', timestamps: { finishedAt: 20 } });
    db.updateRun(run.id, { status: 'succeeded' });
    db.appendRunEvent(run.id, { type: 'run.succeeded', payload: { status: 'succeeded' } });

    assert.deepEqual(db.getRunEvents(run.id).map((event) => event.type), [
      'run.queued',
      'run.running',
      'node.queued',
      'node.started',
      'node.progress',
      'node.polling',
      'node.output',
      'node.succeeded',
      'run.succeeded',
    ]);
    assert.equal(db.getRunEvents(run.id).filter((event) => event.nodeRunId === nodeRun.id).length, 6);
    assert.equal(db.getNodeRun(nodeRun.id).status, 'succeeded');
    assert.equal(db.getAttempt(attempt.id).status, 'succeeded');
  } finally {
    db.close();
  }
});

test('safe original-input replay snapshot survives backend redaction without semantic changes', () => {
  const snapshot = {
    schema: 't8-run-node-input-v1',
    replayable: true,
    node: { id: 'combine-b', type: 'combine', position: { x: 10, y: 20 }, data: { separator: ' / ', label: '合并' } },
    upstreamNodes: [
      { id: 'text-a', type: 'text', position: { x: 0, y: 20 }, data: { text: 'original prompt' } },
    ],
    incomingEdges: [
      { id: 'a-b', source: 'text-a', target: 'combine-b', sourceHandle: 'text', targetHandle: 'text-0', data: { label: 'input' } },
    ],
  };
  assert.deepEqual(redactRunValue(snapshot), snapshot);
});

test('reopening the database archives unfinished runs as interrupted without touching completed runs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-project-run-recovery-'));
  const filename = path.join(directory, 'projects.sqlite3');
  let activeRunId;
  let activeNodeRunId;
  let activeAttemptId;
  let completedRunId;
  try {
    const first = new ProjectDatabase(filename, { autoBackup: false });
    try {
      const active = first.createRun({ canvasId: 'canvas-recovery', status: 'running' });
      activeRunId = active.id;
      const activeNode = first.createNodeRun({ runId: active.id, nodeId: 'async-node', status: 'polling' });
      activeNodeRunId = activeNode.id;
      activeAttemptId = first.createAttempt({ nodeRunId: activeNode.id, status: 'polling', upstreamTaskId: 'upstream-a' }).id;
      completedRunId = first.createRun({ canvasId: 'canvas-recovery', status: 'succeeded' }).id;
    } finally {
      first.close();
    }

    const reopened = new ProjectDatabase(filename, { autoBackup: false });
    try {
      assert.deepEqual(reopened.lastInterruptedRecovery, { runs: 1, nodeRuns: 1, attempts: 1, recoverableRuns: 0, recoverableNodeRuns: 0, recoverableAttempts: 0 });
      assert.equal(reopened.getRun(activeRunId).status, 'interrupted');
      assert.equal(reopened.getNodeRun(activeNodeRunId).status, 'interrupted');
      assert.equal(reopened.getAttempt(activeAttemptId).status, 'interrupted');
      assert.equal(reopened.getRun(completedRunId).status, 'succeeded');
      const events = reopened.getRunEvents(activeRunId);
      assert.equal(events.filter((event) => event.type === 'run.interrupted').length, 1);
      assert.deepEqual(events.find((event) => event.type === 'run.interrupted').payload, { reason: 'application-restart', recoverable: false });
      assert.deepEqual(reopened.recoverInterruptedRuns(), { runs: 0, nodeRuns: 0, attempts: 0, recoverableRuns: 0, recoverableNodeRuns: 0, recoverableAttempts: 0 });
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('run retention removes old unreferenced history but preserves referenced runs and assets', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const projectId = 'project-retention';
    const oldRun = db.createRun({ projectId, canvasId: 'canvas-retention', status: 'succeeded' });
    const protectedRun = db.createRun({ projectId, canvasId: 'canvas-retention', status: 'succeeded' });
    const currentRun = db.createRun({ projectId, canvasId: 'canvas-retention', status: 'succeeded' });
    const asset = db.upsertAsset({ projectId, kind: 'image', filename: 'kept.png', createdBy: 'owner-a' });
    db.createNodeRun(
      { runId: protectedRun.id, nodeId: 'image-output', status: 'succeeded', outputRefs: [asset.id] },
      { allowOutputRefs: true },
    );
    const oldTimestamp = Date.now() - 3 * 24 * 60 * 60 * 1000;
    db.db.prepare('UPDATE runs SET created_at = ? WHERE id IN (?, ?)').run(oldTimestamp, oldRun.id, protectedRun.id);
    const policy = db.setRunRetentionPolicy(projectId, { maxDays: 1, maxRuns: 100, keepReferenced: true });
    assert.equal(policy.maxDays, 1);
    const result = db.pruneRuns(projectId);
    assert.equal(result.deletedRuns, 1);
    assert.equal(result.protectedRuns, 1);
    assert.equal(db.getRun(oldRun.id), null);
    assert.equal(db.getRun(protectedRun.id).id, protectedRun.id);
    assert.equal(db.getRun(currentRun.id).id, currentRun.id);
    assert.equal(db.getAsset(asset.id).id, asset.id);
    assert.equal(result.assetsDeleted, 0);
  } finally {
    db.close();
  }
});

test('run retention enforces Run and output-reference limits without deleting assets or active history', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const projectId = 'project-retention-limits';
    const referencedRuns = [];
    const assets = [];
    for (let index = 0; index < 3; index += 1) {
      const run = db.createRun({ projectId, canvasId: 'canvas-retention-limits', status: 'succeeded' });
      const asset = db.upsertAsset({ projectId, kind: 'image', filename: `kept-${index}.png` });
      db.createNodeRun(
        { runId: run.id, nodeId: `output-${index}`, status: 'succeeded', outputRefs: [asset.id] },
        { allowOutputRefs: true },
      );
      db.db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(Date.now() - 10000 + index, run.id);
      referencedRuns.push(run);
      assets.push(asset);
    }
    for (let index = 0; index < 9; index += 1) {
      db.createRun({ projectId, canvasId: 'canvas-retention-limits', status: 'succeeded' });
    }
    const active = db.createRun({ projectId, canvasId: 'canvas-retention-limits', status: 'running' });
    db.setRunRetentionPolicy(projectId, { maxDays: 3650, maxRuns: 20, maxAssetRefs: 1, keepReferenced: false });
    const result = db.pruneRuns(projectId);

    assert.equal(result.beforeRuns, 13);
    assert.equal(result.afterRuns, 11);
    assert.equal(result.beforeAssetRefs, 3);
    assert.equal(result.afterAssetRefs, 1);
    assert.equal(result.deletedAssetRefs, 2);
    assert.equal(result.assetsDeleted, 0);
    assert.equal(result.limitsSatisfied, true);
    assert.equal(db.getRun(active.id).status, 'running');
    assert.equal(db.getRun(referencedRuns[0].id), null);
    assert.equal(db.getRun(referencedRuns[1].id), null);
    assert.equal(db.getRun(referencedRuns[2].id).id, referencedRuns[2].id);
    for (const asset of assets) assert.equal(db.getAsset(asset.id).id, asset.id);
  } finally {
    db.close();
  }
});

test('run retention reports when protected or non-Run data prevents a byte target', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const projectId = 'project-retention-blocked';
    const run = db.createRun({ projectId, canvasId: 'canvas-retention-blocked', status: 'succeeded' });
    const asset = db.upsertAsset({ projectId, kind: 'image', filename: 'protected.png' });
    db.createNodeRun(
      { runId: run.id, nodeId: 'protected-output', status: 'succeeded', outputRefs: [asset.id] },
      { allowOutputRefs: true },
    );
    db.setRunRetentionPolicy(projectId, { maxDays: 3650, maxRuns: 10, maxAssetRefs: 0, keepReferenced: true });
    db.db.prepare('UPDATE run_retention_policies SET max_db_bytes = 1 WHERE project_id = ?').run(projectId);
    const result = db.pruneRuns(projectId);
    assert.equal(result.deletedRuns, 0);
    assert.equal(result.assetsDeleted, 0);
    assert.equal(result.limitsSatisfied, false);
    assert.equal(result.blockedBy.includes('max-asset-refs-protected'), true);
    assert.equal(result.blockedBy.includes('max-db-bytes-protected-or-non-run-data'), true);
    assert.equal(db.getAsset(asset.id).id, asset.id);
  } finally {
    db.close();
  }
});

test('run-center list and Attempt detail queries stay bounded on large histories', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const projectId = 'project-large-run-history';
    db.ensureCanvas('load-canvas', { nodes: [], edges: [] }, projectId);
    db.ensureCanvas('detail-canvas', { nodes: [], edges: [] }, projectId);
    const insertRun = db.db.prepare(`INSERT INTO runs(id, project_id, canvas_id, canvas_revision, initiator_id, parent_run_id, status, summary_json, created_at, started_at, finished_at) VALUES (?, ?, ?, 1, 'load-test', NULL, 'succeeded', '{}', ?, ?, ?)`);
    const insertNode = db.db.prepare(`INSERT INTO node_runs(id, run_id, node_id, parent_node_run_id, original_node_id, definition_id, definition_version, subflow_path_json, status, input_json, output_refs_json, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, '[]', 'succeeded', '{}', '[]', ?, ?)`);
    const insertAttempt = db.db.prepare(`INSERT INTO run_attempts(id, node_run_id, provider, model, upstream_task_id, request_id, http_status, poll_count, status, timestamps_json, usage_json, metadata_json, error_json, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, 200, 1, 'succeeded', '{}', '{}', '{}', NULL, ?, ?)`);
    db.db.transaction(() => {
      for (let index = 0; index < 5000; index += 1) {
        const runId = `load-run-${String(index).padStart(5, '0')}`;
        const nodeId = `load-node-${String(index).padStart(5, '0')}`;
        const createdAt = 100000 + index;
        insertRun.run(runId, projectId, 'load-canvas', createdAt, createdAt, createdAt + 1);
        insertNode.run(nodeId, runId, 'image-node', createdAt, createdAt + 1);
        insertAttempt.run(`load-attempt-${index}`, nodeId, index % 2 ? 'provider-a' : 'provider-b', index % 2 ? 'model-a' : 'model-b', createdAt, createdAt + 1);
      }
    })();
    const listStartedAt = performance.now();
    const filtered = db.listRuns({ projectId, provider: 'provider-a', model: 'model-a', limit: 500 });
    const listElapsed = performance.now() - listStartedAt;
    assert.equal(filtered.length, 500);
    assert.equal(filtered.every((run) => run.projectId === projectId), true);
    assert.equal(listElapsed < 2000, true, `large Run list took ${listElapsed.toFixed(1)}ms`);

    const detailRun = db.createRun({ projectId, canvasId: 'detail-canvas', status: 'succeeded' });
    const detailNode = db.createNodeRun({ runId: detailRun.id, nodeId: 'retry-heavy', status: 'succeeded' });
    db.db.transaction(() => {
      for (let index = 0; index < 2000; index += 1) {
        insertAttempt.run(`detail-attempt-${String(index).padStart(4, '0')}`, detailNode.id, 'provider-detail', 'model-detail', 200000 + index, 200001 + index);
      }
    })();
    const attemptsStartedAt = performance.now();
    const attempts = db.listAttempts(detailNode.id);
    const attemptsElapsed = performance.now() - attemptsStartedAt;
    assert.equal(attempts.length, 2000);
    assert.equal(attempts[0].attemptNumber, 1);
    assert.equal(attempts.at(-1).attemptNumber, 2000);
    assert.equal(attemptsElapsed < 2000, true, `Attempt detail took ${attemptsElapsed.toFixed(1)}ms`);
  } finally {
    db.close();
  }
});

test('host claims one accepted run intent exactly once and finalizes it from the authoritative Run', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const canvas = db.ensureCanvas('intent-canvas', { nodes: [], edges: [] }, 'intent-project');
    const intent = db.createRunIntent({
      projectId: 'intent-project', canvasId: 'intent-canvas', canvasRevision: canvas.revision,
      idempotencyKey: 'intent-authoritative-0001', requestedBy: 'remote-editor', estimatedCost: 1.5,
    });
    const accepted = db.acceptRunIntentForDispatch(intent.id, {
      projectId: intent.projectId,
      canvasId: intent.canvasId,
      expectedQueueRevision: intent.queueRevision,
      confirmedBy: 'local-owner',
    });
    const leased = db.leaseRunIntentForDispatch(
      { projectId: intent.projectId, canvasId: intent.canvasId },
      { workerId: 'project-database-test-worker', canvasConcurrencyLimit: 1 },
    );
    assert.equal(leased.intent.id, accepted.id);
    const run = db.createRun({ projectId: 'intent-project', canvasId: 'intent-canvas', canvasRevision: canvas.revision, initiatorId: 'remote-editor', status: 'queued' });
    const claimed = db.claimRunIntent(intent.id, run, {
      expectedQueueRevision: leased.intent.queueRevision,
      leaseOwner: 'project-database-test-worker',
      leaseToken: leased.leaseToken,
    });
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.runId, run.id);
    assert.throws(() => db.claimRunIntent(intent.id, run, {
      expectedQueueRevision: claimed.queueRevision,
      leaseOwner: 'project-database-test-worker',
      leaseToken: leased.leaseToken,
    }), /已消费|请求取消|另一主机/);
    const finished = db.finishRunIntentForRun(run.id, 'succeeded', 0.75);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.actualCost, 0.75);
    assert.equal(db.finishRunIntentForRun('missing-run', 'failed'), null);
  } finally {
    db.close();
  }
});

test('asset collections, tags, lineage and duplicate detection keep project boundaries', () => {
  const db = new ProjectDatabase(':memory:');
  try {
    const projectId = 'asset-project';
    const parent = db.upsertAsset({ projectId, kind: 'image', filename: 'parent.png', contentHash: 'a'.repeat(64), contentHashVerification: 'verified', perceptualHash: '0000000000000000' });
    const exact = db.upsertAsset({ projectId, kind: 'image', filename: 'exact-copy.png', contentHash: 'a'.repeat(64), contentHashVerification: 'verified', perceptualHash: 'ffffffffffffffff' });
    const similar = db.upsertAsset({ projectId, kind: 'image', filename: 'similar.png', contentHash: 'b'.repeat(64), perceptualHash: '0000000000000001' });
    const otherProject = db.upsertAsset({ projectId: 'other-project', kind: 'image', filename: 'other.png', contentHash: 'a'.repeat(64), perceptualHash: '0000000000000000' });

    const tagged = db.setAssetTags(parent.id, ['角色', ' hero ', '角色']);
    assert.deepEqual(tagged.tags, ['hero', '角色']);
    assert.equal(db.listAssets({ projectId, tag: '角色' }).length, 1);

    const collection = db.createAssetCollection({ projectId, name: '训练集', description: 'approved' });
    db.setAssetCollectionMembers(collection.id, [parent.id, similar.id]);
    assert.equal(db.listAssetCollections(projectId)[0].assetCount, 2);
    assert.deepEqual(db.listAssets({ projectId, collectionId: collection.id }).map((item) => item.id).sort(), [parent.id, similar.id].sort());
    assert.throws(() => db.setAssetCollectionMembers(collection.id, [otherProject.id]), /跨项目/);

    db.ensureCanvas('asset-canvas', { nodes: [], edges: [] }, projectId);
    const lineageRun = db.createRun({ id: 'run-a', projectId, canvasId: 'asset-canvas', status: 'succeeded' });
    const lineageNodeRun = db.createNodeRun({ id: 'node-run-a', runId: lineageRun.id, nodeId: 'asset-node', status: 'succeeded' });
    const lineageAttempt = db.createAttempt({ id: 'attempt-a', nodeRunId: lineageNodeRun.id, provider: 'test', model: 'test', status: 'succeeded' });
    const lineage = db.addAssetLineage({ childAssetId: similar.id, parentAssetId: parent.id, relation: 'upscaled-from', runId: lineageRun.id, nodeRunId: lineageNodeRun.id, attemptId: lineageAttempt.id, promptDigest: 'sha256:prompt' });
    assert.equal(lineage[0].relation, 'upscaled-from');
    assert.equal(db.getAssetLineage(parent.id)[0].childAssetId, similar.id);

    db.refreshAssetDuplicateCandidates(parent.id, {
      expectedCatalogRevision: db.getAssetCatalogRevision(parent.projectId),
    });
    const duplicates = db.findAssetDuplicates(parent.id, 2);
    assert.deepEqual(duplicates.map((item) => [item.asset.id, item.match, item.distance]), [[exact.id, 'exact', 0], [similar.id, 'perceptual', 1]]);
    assert.equal(duplicates.some((item) => item.asset.id === otherProject.id), false);

    const removed = db.removeAssetIndex(exact.id);
    assert.equal(removed.filename, 'exact-copy.png');
    assert.equal(db.getAsset(exact.id), null);
    assert.equal(db.getAsset(parent.id).filename, 'parent.png');
  } finally {
    db.close();
  }
});

test('corrupt primary and hot journal fail closed when the schema32 backup is stale', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-project-db-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const backupFilename = `${filename}.backup`;
  const generationFilename = `${filename}.recovery-generation.json`;
  try {
    const first = new ProjectDatabase(filename, { backupFilename, autoBackup: false });
    first.ensureCanvas('canvas-restored', { nodes: [{ id: 'kept' }], edges: [] });
    await first.createBackup();
    first.saveCanvasSnapshot('canvas-restored', {
      nodes: [{ id: 'kept' }, { id: 'post-backup-write' }],
      edges: [],
    }, { expectedRevision: 1 });
    await first.close();
    const backupBefore = fs.readFileSync(backupFilename);
    const generationBefore = fs.readFileSync(generationFilename);
    const brokenPrimary = Buffer.from('this is not a sqlite database');
    const hotJournal = Buffer.from('untrusted-hot-journal-evidence');
    fs.writeFileSync(filename, brokenPrimary);
    fs.writeFileSync(`${filename}-journal`, hotJournal);

    let failure = null;
    assert.throws(
      () => new ProjectDatabase(filename, { backupFilename, autoBackup: false }),
      (error) => {
        failure = error;
        return error instanceof ProjectDatabaseRecoveryError
          && error.code === 'project_database_recovery_failed'
          && error.status === 503
          && error.details?.phase === 'backup_freshness_rejected'
          && error.details?.freshnessStatus === 'rejected'
          && error.details?.capturedWriteSequence < error.details?.acknowledgedWriteSequence;
      },
    );
    assert.deepEqual(fs.readFileSync(filename), brokenPrimary);
    assert.deepEqual(fs.readFileSync(`${filename}-journal`), hotJournal);
    assert.deepEqual(fs.readFileSync(backupFilename), backupBefore);
    assert.deepEqual(fs.readFileSync(generationFilename), generationBefore);
    assert.equal(failure.details.backupEvidence, backupFilename);
    assert.equal(fs.existsSync(failure.details.restoreTemp), true);
    const evidence = failure.details.primaryEvidence.map((entry) => fs.readFileSync(entry));
    assert.equal(evidence.some((value) => value.equals(brokenPrimary)), true);
    assert.equal(evidence.some((value) => value.equals(hotJournal)), true);

    const candidate = new BetterSqlite3(failure.details.restoreTemp, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      assert.equal(JSON.parse(candidate.prepare(`
        SELECT snapshot_json FROM canvas_documents WHERE canvas_id = ?
      `).get('canvas-restored').snapshot_json).nodes[0].id, 'kept');
    } finally {
      candidate.close();
    }
  } finally {
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});
