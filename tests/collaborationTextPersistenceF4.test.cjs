const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Y = require('yjs');

const {
  COLLABORATION_TEXT_RECOVERY_CONTRACT,
  CollaborationTextPersistence,
} = require('../backend/src/services/collaborationTextPersistence');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

const IDS = Object.freeze({
  nodeA: '10000000-0000-4000-8000-000000000001',
  nodeB: '10000000-0000-4000-8000-000000000002',
  recover: '10000000-0000-4000-8000-000000000003',
  edge: '20000000-0000-4000-8000-000000000001',
  subflow: '30000000-0000-4000-8000-000000000001',
  scopeUpdate: '40000000-0000-4000-8000-000000000001',
  nodeUpdate: '40000000-0000-4000-8000-000000000002',
  edgeUpdate: '40000000-0000-4000-8000-000000000003',
  subflowUpdate: '40000000-0000-4000-8000-000000000004',
  noOp: '40000000-0000-4000-8000-000000000005',
  afterNoOp: '40000000-0000-4000-8000-000000000006',
});

function principal(projectId, canvasId, overrides = {}) {
  return {
    memberId: 'member-f4-persistence',
    actorId: 'member-f4-persistence',
    sessionId: 'session-f4-persistence',
    role: 'editor',
    capabilities: ['editGraph', 'comment'],
    projectId,
    canvasId,
    ...overrides,
  };
}

function ensureCanvas(database, projectId, canvasId, input = {}) {
  return database.ensureCanvas(canvasId, {
    name: 'F4 text persistence hardening',
    nodes: input.nodes || [],
    edges: input.edges || [],
    subflowInstances: input.subflowInstances || [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }, projectId, { initializeResourceScope: false });
}

function identity(projectId, canvasId, targetType, targetEntityUid, field) {
  return { projectId, canvasId, targetType, targetEntityUid, field };
}

function encodeTextState(value) {
  const document = new Y.Doc();
  try {
    document.getText('content').insert(0, value);
    return Buffer.from(Y.encodeStateAsUpdate(document));
  } finally {
    document.destroy();
  }
}

function updateFromState(state, mutate) {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, Buffer.from(state, 'base64'));
    const before = Y.encodeStateVector(document);
    mutate(document.getText('content'));
    return Buffer.from(Y.encodeStateAsUpdate(document, before)).toString('base64');
  } finally {
    document.destroy();
  }
}

function noOpUpdate(state) {
  return updateFromState(state, () => {});
}

function appendUpdate(state, value) {
  return updateFromState(state, (text) => text.insert(text.length, value));
}

function envelope(snapshot, updateId, clientSeq, update) {
  return {
    contractVersion: 't8-collaboration-text-update-v1',
    updateId,
    clientSeq,
    projectId: snapshot.projectId,
    canvasId: snapshot.canvasId,
    baseRevision: snapshot.revision,
    targetType: snapshot.targetType,
    targetEntityUid: snapshot.targetEntityUid,
    bindingEpoch: snapshot.bindingEpoch,
    field: snapshot.field,
    update,
  };
}

function tableCount(database, table) {
  return database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function textAuditCount(database, projectId, canvasId) {
  return database.listAuditEvents({
    projectId,
    canvasId,
    action: 'collaboration.text.update',
    limit: 1000,
  }).length;
}

test('F4 persistence rejects principal scope before any canvas lookup and leaves every text ledger unchanged', () => {
  const projectId = 'project-f4-scope-hardening';
  const canvasId = 'canvas-f4-scope-hardening';
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    ensureCanvas(database, projectId, canvasId, {
      nodes: [{
        id: 'node-scope', entityUid: IDS.nodeA, entityRevision: 1,
        type: 'text', position: { x: 0, y: 0 }, data: { prompt: '' },
      }],
    });
    const persistence = new CollaborationTextPersistence(database);
    const scopedIdentity = identity(projectId, canvasId, 'node', IDS.nodeA, 'prompt');
    const before = {
      bindings: tableCount(database, 'collaboration_text_documents'),
      updates: tableCount(database, 'collaboration_text_update_idempotency'),
      noOps: tableCount(database, 'collaboration_text_noop_idempotency'),
      sequences: tableCount(database, 'collaboration_text_client_sequences'),
      audits: textAuditCount(database, projectId, canvasId),
    };
    const originalGetCanvas = database.getCanvas.bind(database);
    let canvasLookups = 0;
    database.getCanvas = (...args) => {
      canvasLookups += 1;
      return originalGetCanvas(...args);
    };
    const crossed = principal('project-other', canvasId);
    assert.throws(
      () => persistence.getBindingSnapshot(scopedIdentity, crossed),
      (error) => error?.code === 'collaboration_text_scope_mismatch' && error?.status === 403,
    );
    assert.throws(
      () => persistence.applyUpdate({
        contractVersion: 't8-collaboration-text-update-v1',
        updateId: IDS.scopeUpdate,
        clientSeq: 0,
        projectId,
        canvasId,
        baseRevision: 1,
        targetType: 'node',
        targetEntityUid: IDS.nodeA,
        bindingEpoch: '50000000-0000-4000-8000-000000000001',
        field: 'prompt',
        update: 'AAA=',
      }, { principal: crossed }),
      (error) => error?.code === 'collaboration_text_scope_mismatch' && error?.status === 403,
    );
    assert.equal(canvasLookups, 0, 'cross-scope requests must fail before document/target/binding lookup');
    assert.deepEqual({
      bindings: tableCount(database, 'collaboration_text_documents'),
      updates: tableCount(database, 'collaboration_text_update_idempotency'),
      noOps: tableCount(database, 'collaboration_text_noop_idempotency'),
      sequences: tableCount(database, 'collaboration_text_client_sequences'),
      audits: textAuditCount(database, projectId, canvasId),
    }, before);
  } finally {
    database.close();
  }
});

test('F4 stable bindings survive legacy writer calls, display-ID reuse and restart without losing old recovery text', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-f4-text-binding-'));
  const filename = path.join(directory, 'project.sqlite3');
  const projectId = 'project-f4-stable-binding';
  const canvasId = 'canvas-f4-stable-binding';
  let database;
  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    ensureCanvas(database, projectId, canvasId, {
      nodes: [
        {
          id: 'node-reuse', entityUid: IDS.nodeA, entityRevision: 1,
          type: 'text', position: { x: 0, y: 0 }, data: { prompt: 'stable A' },
        },
        {
          id: 'node-recovery', entityUid: IDS.recover, entityRevision: 1,
          type: 'text', position: { x: 50, y: 0 }, data: { prompt: 'current materialized' },
        },
      ],
    });
    database.saveCollaborativeTextDocument({
      projectId,
      canvasId,
      targetType: 'node',
      targetId: 'node-recovery',
      field: 'prompt',
      state: encodeTextState('preserved legacy draft'),
      updatedBy: 'legacy-writer',
    });
    let persistence = new CollaborationTextPersistence(database);
    const actor = principal(projectId, canvasId);
    const recoveryIdentity = identity(projectId, canvasId, 'node', IDS.recover, 'prompt');
    assert.throws(
      () => persistence.getBindingSnapshot(recoveryIdentity, actor),
      (error) => error?.code === 'collaboration_text_schema_mismatch'
        && error?.details?.recoveryAvailable === true
        && error?.details?.recoveryContractVersion === COLLABORATION_TEXT_RECOVERY_CONTRACT,
    );
    const recovery = persistence.getLegacyRecoveryModel(recoveryIdentity, actor);
    assert.deepEqual({
      contractVersion: recovery.contractVersion,
      projectId: recovery.projectId,
      canvasId: recovery.canvasId,
      targetEntityUid: recovery.targetEntityUid,
      field: recovery.field,
      legacyText: recovery.legacyText,
      currentText: recovery.currentText,
      preserved: recovery.preserved,
    }, {
      contractVersion: COLLABORATION_TEXT_RECOVERY_CONTRACT,
      projectId,
      canvasId,
      targetEntityUid: IDS.recover,
      field: 'prompt',
      legacyText: 'preserved legacy draft',
      currentText: 'current materialized',
      preserved: true,
    });
    assert.throws(
      () => persistence.getLegacyRecoveryModel(recoveryIdentity, principal('project-crossed', canvasId)),
      (error) => error?.code === 'collaboration_text_scope_mismatch',
    );

    const first = persistence.getBindingSnapshot(
      identity(projectId, canvasId, 'node', IDS.nodeA, 'prompt'),
      actor,
    ).binding;
    assert.equal(first.materializedText, 'stable A');
    database.saveCollaborativeTextDocument({
      projectId,
      canvasId,
      targetType: 'node',
      targetId: 'node-reuse',
      field: 'prompt',
      state: encodeTextState('legacy writer must not overwrite stable A'),
      updatedBy: 'legacy-writer',
    });
    assert.equal(
      persistence.getBindingSnapshot(
        identity(projectId, canvasId, 'node', IDS.nodeA, 'prompt'),
        actor,
      ).binding.bindingEpoch,
      first.bindingEpoch,
    );
    const modernA = database.db.prepare(`
      SELECT * FROM collaboration_text_documents WHERE target_entity_uid = ?
    `).get(IDS.nodeA);
    assert.equal(modernA.target_id, `@t8/text-entity/${IDS.nodeA}`);
    assert.equal(modernA.display_target_id, 'node-reuse');
    const modernStateBeforeSyntheticLegacyWrite = Buffer.from(modernA.state_blob).toString('hex');
    assert.throws(() => database.saveCollaborativeTextDocument({
      projectId,
      canvasId,
      targetType: 'node',
      targetId: modernA.target_id,
      field: 'prompt',
      state: encodeTextState('synthetic target attack'),
      updatedBy: 'legacy-writer',
    }), (error) => error?.code === 'collaboration_text_legacy_writer_forbidden');
    assert.equal(
      Buffer.from(database.db.prepare(`
        SELECT state_blob FROM collaboration_text_documents WHERE target_entity_uid = ?
      `).get(IDS.nodeA).state_blob).toString('hex'),
      modernStateBeforeSyntheticLegacyWrite,
      'legacy writer must not modify a modern row even when given its private storage key',
    );
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count FROM collaboration_text_documents
      WHERE target_id = 'node-reuse' AND target_entity_uid IS NULL
    `).get().count, 1, 'legacy writer must be isolated in an unbound row');

    const current = database.getCanvas(canvasId);
    const next = JSON.parse(JSON.stringify(current));
    next.revision = current.revision + 1;
    next.updatedAt = Date.now();
    const replacement = next.nodes.find((node) => node.id === 'node-reuse');
    replacement.entityUid = IDS.nodeB;
    replacement.entityRevision = next.revision;
    replacement.data.prompt = 'stable B';
    database.db.prepare(`
      UPDATE canvas_documents SET revision = ?, snapshot_json = ?, updated_at = ?
      WHERE project_id = ? AND canvas_id = ?
    `).run(next.revision, JSON.stringify(next), next.updatedAt, projectId, canvasId);

    const second = persistence.getBindingSnapshot(
      identity(projectId, canvasId, 'node', IDS.nodeB, 'prompt'),
      actor,
    ).binding;
    assert.equal(second.materializedText, 'stable B');
    assert.notEqual(second.bindingEpoch, first.bindingEpoch);
    const stableRows = database.db.prepare(`
      SELECT target_entity_uid, target_id, display_target_id, lifecycle, materialized_text
      FROM collaboration_text_documents
      WHERE display_target_id = 'node-reuse' AND target_entity_uid IS NOT NULL
      ORDER BY target_entity_uid
    `).all();
    assert.deepEqual(stableRows.map((row) => ({
      uid: row.target_entity_uid,
      targetId: row.target_id,
      displayId: row.display_target_id,
      lifecycle: row.lifecycle,
      text: row.materialized_text,
    })), [
      {
        uid: IDS.nodeA,
        targetId: `@t8/text-entity/${IDS.nodeA}`,
        displayId: 'node-reuse',
        lifecycle: 'stale',
        text: 'stable A',
      },
      {
        uid: IDS.nodeB,
        targetId: `@t8/text-entity/${IDS.nodeB}`,
        displayId: 'node-reuse',
        lifecycle: 'active',
        text: 'stable B',
      },
    ]);
    database.close();
    database = null;

    database = new ProjectDatabase(filename, { autoBackup: false });
    persistence = new CollaborationTextPersistence(database);
    const reopened = persistence.getBindingSnapshot(
      identity(projectId, canvasId, 'node', IDS.nodeB, 'prompt'),
      actor,
    ).binding;
    assert.equal(reopened.bindingEpoch, second.bindingEpoch);
    assert.equal(reopened.materializedText, 'stable B');
    assert.equal(
      persistence.getLegacyRecoveryModel(recoveryIdentity, actor).legacyText,
      'preserved legacy draft',
    );
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('F4 text commits raise entityRevision while legal Yjs no-ops keep revision, sequence, audit and broadcast inputs still', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-f4-text-noop-'));
  const filename = path.join(directory, 'project.sqlite3');
  const projectId = 'project-f4-entity-revision';
  const canvasId = 'canvas-f4-entity-revision';
  let database;
  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    ensureCanvas(database, projectId, canvasId, {
      nodes: [
        {
          id: 'node-a', entityUid: IDS.nodeA, entityRevision: 1,
          type: 'text', position: { x: 0, y: 0 }, data: { prompt: '' },
        },
        {
          id: 'node-b', entityUid: IDS.nodeB, entityRevision: 1,
          type: 'text', position: { x: 100, y: 0 }, data: {},
        },
      ],
      edges: [{
        id: 'edge-a', entityUid: IDS.edge, entityRevision: 1,
        source: 'node-a', target: 'node-b', label: '', data: {},
      }],
      subflowInstances: [{
        instanceId: 'subflow-a', entityUid: IDS.subflow, entityRevision: 1,
        name: 'Flow', description: '',
      }],
    });
    let persistence = new CollaborationTextPersistence(database);
    const actor = principal(projectId, canvasId);

    const node = persistence.getBindingSnapshot(
      identity(projectId, canvasId, 'node', IDS.nodeA, 'prompt'),
      actor,
    ).binding;
    const nodeApplied = persistence.applyUpdate(
      envelope(node, IDS.nodeUpdate, 0, appendUpdate(node.state, 'node text')),
      { principal: actor },
    );
    assert.equal(nodeApplied.result.revision, 2);
    assert.equal(database.getCanvas(canvasId).nodes.find((item) => item.entityUid === IDS.nodeA).entityRevision, 2);

    const edge = persistence.getBindingSnapshot(
      identity(projectId, canvasId, 'edge', IDS.edge, 'label'),
      actor,
    ).binding;
    const edgeApplied = persistence.applyUpdate(
      envelope(edge, IDS.edgeUpdate, 1, appendUpdate(edge.state, 'edge text')),
      { principal: actor },
    );
    assert.equal(edgeApplied.result.revision, 3);
    assert.equal(database.getCanvas(canvasId).edges.find((item) => item.entityUid === IDS.edge).entityRevision, 3);

    const subflow = persistence.getBindingSnapshot(
      identity(projectId, canvasId, 'subflow', IDS.subflow, 'name'),
      actor,
    ).binding;
    const subflowApplied = persistence.applyUpdate(
      envelope(subflow, IDS.subflowUpdate, 2, appendUpdate(subflow.state, ' + text')),
      { principal: actor },
    );
    assert.equal(subflowApplied.result.revision, 4);
    assert.equal(
      database.getCanvas(canvasId).subflowInstances.find((item) => item.entityUid === IDS.subflow).entityRevision,
      4,
    );

    const currentNode = persistence.getBindingSnapshot(
      identity(projectId, canvasId, 'node', IDS.nodeA, 'prompt'),
      actor,
    ).binding;
    const noOpEnvelope = envelope(currentNode, IDS.noOp, 3, noOpUpdate(currentNode.state));
    const beforeNoOp = {
      revision: database.getCanvas(canvasId).revision,
      nodeRevision: database.getCanvas(canvasId).nodes.find((item) => item.entityUid === IDS.nodeA).entityRevision,
      operations: database.db.prepare("SELECT COUNT(*) AS count FROM canvas_operations WHERE type = 'text.update'").get().count,
      updates: tableCount(database, 'collaboration_text_update_idempotency'),
      sequences: tableCount(database, 'collaboration_text_client_sequences'),
      lastClientSeq: database.db.prepare(`
        SELECT last_client_seq FROM collaboration_text_client_sequences
        WHERE project_id = ? AND canvas_id = ? AND actor_id = ? AND session_id = ?
      `).get(projectId, canvasId, actor.actorId, actor.sessionId).last_client_seq,
      audits: textAuditCount(database, projectId, canvasId),
    };
    const noOp = persistence.applyUpdate(noOpEnvelope, { principal: actor });
    assert.equal(noOp.duplicate, true);
    assert.equal(noOp.noOp, true);
    assert.equal(noOp.operation, null);
    assert.equal(noOp.audit, null);
    assert.equal(noOp.result.revision, beforeNoOp.revision);
    assert.deepEqual(
      (({ op_id, project_id, canvas_id, domain, type }) => ({
        opId: op_id,
        projectId: project_id,
        canvasId: canvas_id,
        domain,
        type,
      }))(database.getCollaborationOperationIdentity(IDS.noOp)),
      {
        opId: IDS.noOp,
        projectId,
        canvasId,
        domain: 'text',
        type: 'text.update',
      },
      'no-op updateId must still reserve the global cross-domain operation identity',
    );
    assert.throws(() => database.reserveCollaborationOperationIdentity({
      opId: IDS.noOp,
      projectId,
      canvasId,
      domain: 'canvas',
      type: 'node.move',
      identityDigest: 'a'.repeat(64),
      createdAt: Date.now(),
    }, database.getCanvas(canvasId)), (error) => error?.code === 'operation_id_conflict');
    assert.deepEqual({
      revision: database.getCanvas(canvasId).revision,
      nodeRevision: database.getCanvas(canvasId).nodes.find((item) => item.entityUid === IDS.nodeA).entityRevision,
      operations: database.db.prepare("SELECT COUNT(*) AS count FROM canvas_operations WHERE type = 'text.update'").get().count,
      updates: tableCount(database, 'collaboration_text_update_idempotency'),
      sequences: tableCount(database, 'collaboration_text_client_sequences'),
      lastClientSeq: database.db.prepare(`
        SELECT last_client_seq FROM collaboration_text_client_sequences
        WHERE project_id = ? AND canvas_id = ? AND actor_id = ? AND session_id = ?
      `).get(projectId, canvasId, actor.actorId, actor.sessionId).last_client_seq,
      audits: textAuditCount(database, projectId, canvasId),
    }, beforeNoOp);
    assert.equal(tableCount(database, 'collaboration_text_noop_idempotency'), 1);
    assert.deepEqual(persistence.applyUpdate(structuredClone(noOpEnvelope), { principal: actor }).result, noOp.result);
    assert.equal(tableCount(database, 'collaboration_text_noop_idempotency'), 1);
    assert.throws(
      () => persistence.applyUpdate({
        ...noOpEnvelope,
        update: appendUpdate(currentNode.state, 'collision'),
      }, { principal: actor }),
      (error) => error?.code === 'collaboration_text_idempotency_collision',
    );

    const afterNoOp = persistence.applyUpdate(
      envelope(currentNode, IDS.afterNoOp, 3, appendUpdate(currentNode.state, ' after no-op')),
      { principal: actor },
    );
    assert.equal(afterNoOp.result.revision, 5);
    assert.equal(database.getCanvas(canvasId).nodes.find((item) => item.entityUid === IDS.nodeA).entityRevision, 5);
    assert.equal(database.db.prepare(`
      SELECT last_client_seq FROM collaboration_text_client_sequences
      WHERE project_id = ? AND canvas_id = ? AND actor_id = ? AND session_id = ?
    `).get(projectId, canvasId, actor.actorId, actor.sessionId).last_client_seq, 3);
    database.close();
    database = null;

    database = new ProjectDatabase(filename, { autoBackup: false });
    persistence = new CollaborationTextPersistence(database);
    assert.deepEqual(
      persistence.applyUpdate(structuredClone(noOpEnvelope), { principal: actor }).result,
      noOp.result,
      'no-op exact replay must survive a host restart',
    );
    assert.equal(database.getCanvas(canvasId).revision, 5);
    assert.equal(database.db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.db.pragma('foreign_key_check'), []);
  } finally {
    database?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
