const assert = require('node:assert/strict');
const test = require('node:test');

const {
  COMMON_OPERATION_BATCH_CONTRACT,
} = require('../backend/src/collaboration/commonOperationProtocol');
const { stableEntityUuid } = require('../backend/src/collaboration/protocol');
const {
  createFixture,
  joinSocket,
  openSocketProbe,
  redeemActor,
  requestJson,
} = require('./helpers/collaborationF2Fixture.cjs');

const PRIVATE_API_KEY = 'sk-proj-B1SubflowGatewaySyntheticSecret';
const PRIVATE_LOCAL_PATH = 'C:\\Users\\Administrator\\private-subflow-gateway.txt';
const PROJECT_ID = 'project-common-subflow-gateway-b1';
const CANVAS_ID = 'canvas-common-subflow-gateway-b1';
const DEFINITION_ID = 'legacy-subflow-gateway-display-id';

const U = Object.freeze({
  definition: stableEntityUuid(PROJECT_ID, 'subflow-definition', DEFINITION_ID),
  instance: '93000000-0000-4000-8000-000000000002',
  sourceNode: '93000000-0000-4000-8000-000000000003',
  sinkNode: '93000000-0000-4000-8000-000000000004',
  mappedEdge: '93000000-0000-4000-8000-000000000005',
  disconnectedEdge: '93000000-0000-4000-8000-000000000006',
  inputV1: '93000000-0000-4000-8000-000000000007',
  inputV2: '93000000-0000-4000-8000-000000000008',
  outputV1: '93000000-0000-4000-8000-000000000009',
  parameterKeepV1: '93000000-0000-4000-8000-000000000010',
  parameterKeepV2: '93000000-0000-4000-8000-000000000011',
  parameterDropV1: '93000000-0000-4000-8000-000000000012',
  definitionNodeV1: '93000000-0000-4000-8000-000000000013',
  definitionNodeV2: '93000000-0000-4000-8000-000000000014',
  batch: '93000000-0000-4000-8000-000000000020',
  client: '93000000-0000-4000-8000-000000000021',
  operation: '93000000-0000-4000-8000-000000000022',
  reviewThread: '93000000-0000-4000-8000-000000000023',
  reviewComment: '93000000-0000-4000-8000-000000000024',
  reviewOperation: '93000000-0000-4000-8000-000000000025',
  hostBatch: '93000000-0000-4000-8000-000000000030',
  hostClient: '93000000-0000-4000-8000-000000000031',
  hostOperation: '93000000-0000-4000-8000-000000000032',
  artifact: '93000000-0000-4000-8000-000000000033',
  blob: '93000000-0000-4000-8000-000000000034',
  run: '93000000-0000-4000-8000-000000000035',
  nodeRun: '93000000-0000-4000-8000-000000000036',
  attempt: '93000000-0000-4000-8000-000000000037',
});

function sourceDefinition(projectId, definitionId) {
  return {
    id: definitionId,
    entityUid: U.definition,
    projectId,
    version: 1,
    name: 'Gateway source definition',
    description: 'v1',
    nodes: [{
      id: 'definition-node-v1', entityUid: U.definitionNodeV1, type: 'text',
      position: { x: 0, y: 0 }, data: { text: 'source' },
    }],
    edges: [],
    inputs: [{
      id: 'prompt-v1', entityUid: U.inputV1, name: 'Prompt', kind: 'text',
      internalNodeId: 'definition-node-v1', internalHandle: 'text-in', maxConnections: 2,
    }],
    outputs: [{
      id: 'image-v1', entityUid: U.outputV1, name: 'Image', kind: 'image',
      internalNodeId: 'definition-node-v1', internalHandle: 'image-out',
    }],
    exposedParameters: [
      {
        id: 'steps-v1', entityUid: U.parameterKeepV1, name: 'Steps',
        nodeId: 'definition-node-v1', dataKey: 'steps',
        schema: { type: 'integer', minimum: 1, maximum: 20 },
      },
      {
        id: 'obsolete-v1', entityUid: U.parameterDropV1, name: 'Obsolete',
        nodeId: 'definition-node-v1', dataKey: 'obsolete', schema: { type: 'string' },
      },
    ],
  };
}

function targetDefinition(projectId, definitionId) {
  return {
    id: definitionId,
    entityUid: U.definition,
    projectId,
    name: 'Gateway target definition',
    description: 'v2',
    nodes: [{
      id: 'definition-node-v2', entityUid: U.definitionNodeV2, type: 'text',
      position: { x: 20, y: 30 },
      data: { text: 'target', apiKey: PRIVATE_API_KEY, localPath: PRIVATE_LOCAL_PATH },
    }],
    edges: [],
    inputs: [{
      id: 'prompt-v2', entityUid: U.inputV2, name: 'Prompt 2', kind: 'text',
      internalNodeId: 'definition-node-v2', internalHandle: 'text-in-v2', maxConnections: 2,
    }],
    outputs: [],
    exposedParameters: [{
      id: 'steps-v2', entityUid: U.parameterKeepV2, name: 'Steps 2',
      nodeId: 'definition-node-v2', dataKey: 'steps',
      schema: { type: 'integer', minimum: 1, maximum: 20 },
    }],
  };
}

async function createSubflowFixture(t) {
  const fixture = await createFixture(t, {
    persistent: true,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
  });
  const definitionId = DEFINITION_ID;
  const source = fixture.database.saveSubflowDefinition(
    sourceDefinition(fixture.projectId, definitionId),
    {
      expectedRevision: 0,
      actorId: 'host-owner',
      sessionId: 'host-publish',
      changeSummary: 'publish source',
      grantCanvasId: fixture.canvasId,
    },
  );
  const target = fixture.database.saveSubflowDefinition(
    targetDefinition(fixture.projectId, definitionId),
    {
      expectedRevision: source.revision,
      actorId: 'host-owner',
      sessionId: 'host-publish',
      changeSummary: 'publish target without room grant',
    },
  );
  const document = fixture.database.saveCanvasSnapshot(fixture.canvasId, {
    projectId: fixture.projectId,
    name: 'Common subflow gateway canvas',
    nodes: [
      {
        id: 'source-display', entityUid: U.sourceNode, entityRevision: 1,
        type: 'text', position: { x: 0, y: 0 }, data: { text: 'source' },
      },
      {
        id: 'instance-display', entityUid: U.instance, entityRevision: 1,
        type: 'subflow', position: { x: 200, y: 0 },
        data: {
          definitionEntityUid: U.definition,
          definitionId,
          definitionVersion: source.version,
          definitionRevision: source.revision,
          definitionProjectId: fixture.projectId,
          definition: source,
          parameterOverrides: { 'steps-v1': 8, 'obsolete-v1': 'discard me' },
          localPath: PRIVATE_LOCAL_PATH,
        },
      },
      {
        id: 'sink-display', entityUid: U.sinkNode, entityRevision: 1,
        type: 'output', position: { x: 500, y: 0 }, data: {},
      },
    ],
    edges: [
      {
        id: 'mapped-edge-display', entityUid: U.mappedEdge, entityRevision: 1,
        source: 'source-display', target: 'instance-display',
        sourceHandle: 'text-out', targetHandle: 'prompt-v1', type: 'default', data: {},
      },
      {
        id: 'disconnected-edge-display', entityUid: U.disconnectedEdge, entityRevision: 1,
        source: 'instance-display', target: 'sink-display',
        sourceHandle: 'image-v1', targetHandle: 'image-in', type: 'default', data: {},
      },
    ],
  }, {
    expectedRevision: 1,
    actorId: 'host-owner',
    sessionId: 'host-canvas',
  });
  assert.equal(source.version, 1);
  assert.equal(source.revision, 1);
  assert.equal(target.version, 2);
  assert.equal(target.revision, 2);
  assert.equal(document.revision, 2);
  assert.equal(document.nodes.find((node) => node.entityUid === U.instance).data.definitionVersion, 1);
  assert.equal(document.nodes.find((node) => node.entityUid === U.instance).data.definitionEntityUid, U.definition);
  const reopenedDocument = fixture.database.getCanvas(fixture.canvasId);
  assert.equal(reopenedDocument.nodes.find((node) => node.entityUid === U.instance).data.definitionVersion, 1);
  assert.equal(reopenedDocument.nodes.find((node) => node.entityUid === U.instance).data.definitionEntityUid, U.definition);
  assert.ok(fixture.database.getSubflowDefinitionByEntityUid(U.definition, 1, fixture.projectId));
  assert.ok(fixture.database.getSubflowDefinitionByEntityUid(U.definition, 2, fixture.projectId));
  return { fixture, definitionId, source, target };
}

function mappingIntent() {
  return {
    instanceUid: U.instance,
    targetDefinitionVersion: 2,
    portMappings: [
      { direction: 'output', fromPortEntityUid: U.outputV1, toPortEntityUid: null },
      { direction: 'input', fromPortEntityUid: U.inputV1, toPortEntityUid: U.inputV2 },
    ],
    parameterMappings: [
      { fromParameterEntityUid: U.parameterDropV1, toParameterEntityUid: null },
      { fromParameterEntityUid: U.parameterKeepV1, toParameterEntityUid: U.parameterKeepV2 },
    ],
  };
}

async function issuePlan(fixture, actor, body = mappingIntent()) {
  return requestJson(`${fixture.baseUrl}/api/collab/subflow-upgrade-plans`, {
    method: 'POST',
    headers: {
      cookie: actor.cookie,
      'content-type': 'application/json',
      'x-t8-canvas-generation': actor.recoveryGeneration,
    },
    body: JSON.stringify(body),
  });
}

function commonBatch(fixture, operationPayload) {
  return {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    baseRevision: operationPayload.expectedCanvasRevision,
    batchId: U.batch,
    clientId: U.client,
    clientSeq: 7,
    operations: [{
      opId: U.operation,
      type: 'subflow.instance.upgrade',
      payload: operationPayload,
    }],
  };
}

async function postCommon(fixture, actor, body) {
  return requestJson(`${fixture.baseUrl}/api/collab/common-operations`, {
    method: 'POST',
    headers: {
      cookie: actor.cookie,
      'content-type': 'application/json',
      'x-t8-canvas-generation': actor.recoveryGeneration,
    },
    body: JSON.stringify(body),
  });
}

function writeState(database, canvasId) {
  const document = database.getCanvas(canvasId);
  return {
    revision: document.revision,
    edges: document.edges.map((edge) => edge.entityUid),
    tombstones: Object.keys(document.tombstones?.edges || {}).sort(),
    commonBatches: database.db.prepare(
      'SELECT COUNT(*) AS count FROM collaboration_common_operation_batches',
    ).get().count,
    domainOperations: database.db.prepare(
      'SELECT COUNT(*) AS count FROM collaboration_domain_operation_idempotency',
    ).get().count,
    canvasOperations: database.db.prepare(
      'SELECT COUNT(*) AS count FROM canvas_operations',
    ).get().count,
    reviewThreads: database.db.prepare(
      'SELECT COUNT(*) AS count FROM review_threads',
    ).get().count,
    reviewComments: database.db.prepare(
      'SELECT COUNT(*) AS count FROM review_comments',
    ).get().count,
    assets: database.db.prepare(
      'SELECT COUNT(*) AS count FROM assets',
    ).get().count,
    upgradeAudits: database.db.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'subflow.instance.upgrade'",
    ).get().count,
  };
}

function hostArtifactBatch(fixture, revision) {
  return {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    baseRevision: revision,
    batchId: U.hostBatch,
    clientId: U.hostClient,
    clientSeq: 1,
    operations: [{
      opId: U.hostOperation,
      type: 'host.artifact.commit',
      payload: {
        artifactUid: U.artifact,
        blobUid: U.blob,
        runUid: U.run,
        nodeRunUid: U.nodeRun,
        attemptUid: U.attempt,
        nodeUid: U.sourceNode,
        expectedCanvasRevision: revision,
        expectedRunRevision: 1,
        expectedNodeRunRevision: 1,
        expectedAttemptRevision: 1,
        outputOrdinal: 0,
        kind: 'image',
        contentHash: 'a'.repeat(64),
        byteSize: 12,
        filename: 'host-only.png',
        mimeType: 'image/png',
      },
    }],
  };
}

test('B1 gateway issues scoped authoritative subflow tickets, fails closed, broadcasts redacted state and replays across restart', async (t) => {
  const { fixture, definitionId } = await createSubflowFixture(t);
  const editor = await redeemActor(fixture, 'editor', 'B1 subflow editor');
  const otherEditor = await redeemActor(fixture, 'editor', 'B1 other editor');
  const viewer = await redeemActor(fixture, 'viewer', 'B1 subflow viewer');
  const initialState = writeState(fixture.database, fixture.canvasId);

  const viewerDenied = await issuePlan(fixture, viewer);
  assert.equal(viewerDenied.response.status, 403, JSON.stringify(viewerDenied.payload));
  assert.deepEqual(writeState(fixture.database, fixture.canvasId), initialState);

  const rawAuthorityFields = await issuePlan(fixture, editor, {
    ...mappingIntent(),
    expectedCanvasRevision: 2,
  });
  assert.equal(rawAuthorityFields.response.status, 400, JSON.stringify(rawAuthorityFields.payload));
  assert.equal(rawAuthorityFields.payload.code, 'collaboration_subflow_plan_intent_invalid');
  assert.deepEqual(writeState(fixture.database, fixture.canvasId), initialState);

  const resourceDenied = await issuePlan(fixture, editor);
  assert.equal(resourceDenied.response.status, 403, JSON.stringify(resourceDenied.payload));
  assert.equal(resourceDenied.payload.code, 'canvas_resource_access_denied');
  assert.deepEqual(writeState(fixture.database, fixture.canvasId), initialState);

  fixture.database.grantCanvasSubflowResource(
    fixture.projectId,
    fixture.canvasId,
    definitionId,
    2,
  );
  const issued = await issuePlan(fixture, editor);
  assert.equal(issued.response.status, 200, JSON.stringify(issued.payload));
  assert.equal(issued.payload.success, true);
  assert.equal(issued.payload.data.contractVersion, 't8-subflow-upgrade-plan-ticket-v1');
  assert.ok(issued.payload.data.expiresAt > Date.now());
  assert.match(issued.payload.data.operationPayload.upgradePlanDigest, /^[0-9a-f]{64}$/);
  assert.equal(issued.text.includes('portMappings'), false, 'ticket leaked the raw port plan');
  assert.equal(issued.text.includes('parameterMappings'), false, 'ticket leaked the raw parameter plan');
  assert.equal(issued.text.includes(PRIVATE_API_KEY), false);
  assert.equal(issued.text.includes(PRIVATE_LOCAL_PATH), false);
  assert.deepEqual(writeState(fixture.database, fixture.canvasId), initialState);

  const envelope = commonBatch(fixture, issued.payload.data.operationPayload);
  const beforeRejections = writeState(fixture.database, fixture.canvasId);

  const viewerCommonDenied = await postCommon(fixture, viewer, envelope);
  assert.equal(viewerCommonDenied.response.status, 403, JSON.stringify(viewerCommonDenied.payload));
  assert.equal(viewerCommonDenied.payload.code, 'collaboration_domain_capability_missing');
  assert.deepEqual(writeState(fixture.database, fixture.canvasId), beforeRejections);

  fixture.database.db.prepare(`
    DELETE FROM canvas_resource_grants
    WHERE project_id = ? AND canvas_id = ? AND resource_type = 'subflow'
      AND resource_id = ? AND resource_version = 2
  `).run(fixture.projectId, fixture.canvasId, definitionId);
  const commitResourceDenied = await postCommon(fixture, editor, envelope);
  assert.equal(commitResourceDenied.response.status, 403, JSON.stringify(commitResourceDenied.payload));
  assert.equal(commitResourceDenied.payload.code, 'canvas_resource_access_denied');
  assert.deepEqual(writeState(fixture.database, fixture.canvasId), beforeRejections);
  fixture.database.grantCanvasSubflowResource(
    fixture.projectId,
    fixture.canvasId,
    definitionId,
    2,
  );

  const crossSession = await postCommon(fixture, otherEditor, envelope);
  assert.equal(crossSession.response.status, 409, JSON.stringify(crossSession.payload));
  assert.equal(crossSession.payload.code, 'collaboration_subflow_plan_required');
  assert.deepEqual(writeState(fixture.database, fixture.canvasId), beforeRejections);

  const forged = structuredClone(envelope);
  forged.operations[0].payload.upgradePlanDigest = '0'.repeat(64);
  const forgedDenied = await postCommon(fixture, editor, forged);
  assert.equal(forgedDenied.response.status, 409, JSON.stringify(forgedDenied.payload));
  assert.equal(forgedDenied.payload.code, 'collaboration_subflow_plan_required');
  assert.deepEqual(writeState(fixture.database, fixture.canvasId), beforeRejections);

  const rawPlan = structuredClone(envelope);
  rawPlan.operations[0].payload.upgradePlan = mappingIntent();
  const rawPlanDenied = await postCommon(fixture, editor, rawPlan);
  assert.equal(rawPlanDenied.response.status, 400, JSON.stringify(rawPlanDenied.payload));
  assert.deepEqual(writeState(fixture.database, fixture.canvasId), beforeRejections);

  const mixed = structuredClone(envelope);
  mixed.operations.push({
    opId: U.reviewOperation,
    type: 'review.thread.create',
    payload: {
      threadUid: U.reviewThread,
      expectedCanvasRevision: envelope.baseRevision,
      anchor: { kind: 'canvas', x: 0, y: 0 },
      severity: 'normal',
      initialComment: { commentUid: U.reviewComment, body: 'mixed batches must fail' },
    },
  });
  const mixedDenied = await postCommon(fixture, editor, mixed);
  assert.equal(mixedDenied.response.status, 400, JSON.stringify(mixedDenied.payload));
  assert.equal(mixedDenied.payload.code, 'collaboration_domain_mixed_batch');
  assert.deepEqual(writeState(fixture.database, fixture.canvasId), beforeRejections);

  const hostDenied = await postCommon(
    fixture,
    editor,
    hostArtifactBatch(fixture, envelope.baseRevision),
  );
  assert.equal(hostDenied.response.status, 403, JSON.stringify(hostDenied.payload));
  assert.equal(hostDenied.payload.code, 'collaboration_host_artifact_forbidden');
  assert.deepEqual(writeState(fixture.database, fixture.canvasId), beforeRejections);
  const forgedHostScope = hostArtifactBatch(fixture, envelope.baseRevision);
  forgedHostScope.canvasId = 'forged-host-canvas-scope';
  const fixedHostDenied = await postCommon(fixture, viewer, forgedHostScope);
  assert.equal(fixedHostDenied.response.status, 403, JSON.stringify(fixedHostDenied.payload));
  assert.equal(fixedHostDenied.payload.code, 'collaboration_host_artifact_forbidden');
  assert.deepEqual(writeState(fixture.database, fixture.canvasId), beforeRejections);

  await fixture.restart();
  const restartUnissued = await postCommon(fixture, editor, envelope);
  assert.equal(restartUnissued.response.status, 409, JSON.stringify(restartUnissued.payload));
  assert.equal(restartUnissued.payload.code, 'collaboration_subflow_plan_required');
  assert.deepEqual(writeState(fixture.database, fixture.canvasId), beforeRejections);

  const reissued = await issuePlan(fixture, editor);
  assert.equal(reissued.response.status, 200, JSON.stringify(reissued.payload));
  assert.deepEqual(
    reissued.payload.data.operationPayload,
    issued.payload.data.operationPayload,
    'canonical authority reconstruction must reproduce the same operation payload and digest',
  );

  const socket = await openSocketProbe(fixture, editor, { label: 'B1 subflow broadcast socket' });
  await joinSocket(socket, fixture.canvasId, envelope.baseRevision);
  const applied = await postCommon(fixture, editor, envelope);
  assert.equal(applied.response.status, 200, JSON.stringify(applied.payload));
  assert.equal(applied.payload.data.duplicate, false);
  assert.equal(applied.payload.data.document.revision, envelope.baseRevision + 1);
  assert.equal(applied.payload.data.results.length, 1);
  assert.equal(applied.payload.data.results[0].upgradePlanDigest, issued.payload.data.operationPayload.upgradePlanDigest);
  assert.equal(Object.hasOwn(applied.payload.data.results[0], 'nodeDataPatch'), false);
  assert.equal(applied.text.includes('portMappings'), false);
  assert.equal(applied.text.includes('parameterMappings'), false);
  assert.equal(applied.text.includes(PRIVATE_API_KEY), false, 'public response leaked target definition API key');
  assert.equal(applied.text.includes(PRIVATE_LOCAL_PATH), false, 'public response leaked a host path');
  assert.equal(applied.text.includes(editor.cookie), false, 'public response leaked a session cookie');

  const event = await socket.nextMessage(
    (message) => message.type === 'collaboration.domain-operation'
      && message.opId === U.operation,
    'subflow domain operation broadcast timed out',
  );
  assert.equal(event.operationType, 'subflow.instance.upgrade');
  assert.equal(event.revision, envelope.baseRevision + 1);
  assert.equal(event.document.revision, envelope.baseRevision + 1);
  assert.equal(event.result.upgradePlanDigest, issued.payload.data.operationPayload.upgradePlanDigest);
  assert.equal(Object.hasOwn(event.result, 'nodeDataPatch'), false);
  const eventText = JSON.stringify(event);
  assert.equal(eventText.includes('portMappings'), false);
  assert.equal(eventText.includes('parameterMappings'), false);
  assert.equal(eventText.includes(PRIVATE_API_KEY), false);
  assert.equal(eventText.includes(PRIVATE_LOCAL_PATH), false);
  assert.equal(eventText.includes(editor.cookie), false);

  const persisted = fixture.database.getCanvas(fixture.canvasId);
  const instance = persisted.nodes.find((node) => node.entityUid === U.instance);
  assert.equal(persisted.revision, 3);
  assert.equal(instance.entityRevision, 3);
  assert.equal(instance.data.definitionVersion, 2);
  assert.equal(instance.data.definitionRevision, 2);
  assert.deepEqual(instance.data.parameterOverrides, { 'steps-v2': 8 });
  assert.equal(persisted.edges.find((edge) => edge.entityUid === U.mappedEdge).targetHandle, 'prompt-v2');
  assert.equal(persisted.edges.some((edge) => edge.entityUid === U.disconnectedEdge), false);
  assert.equal(persisted.tombstones.edges['disconnected-edge-display'].entityUid, U.disconnectedEdge);

  const replay = await postCommon(fixture, editor, envelope);
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.payload.data.duplicate, true);
  assert.deepEqual(replay.payload.data.commonBatch, applied.payload.data.commonBatch);
  assert.deepEqual(replay.payload.data.document, applied.payload.data.document);
  assert.deepEqual(replay.payload.data.results, applied.payload.data.results);
  await socket.expectNoMessage(
    (message) => message.type === 'collaboration.domain-operation' && message.opId === U.operation,
    100,
    'exact replay must not rebroadcast an already committed subflow upgrade',
  );

  const afterApply = writeState(fixture.database, fixture.canvasId);
  const collision = structuredClone(envelope);
  collision.operations[0].payload.upgradePlanDigest = 'f'.repeat(64);
  const collisionDenied = await postCommon(fixture, editor, collision);
  assert.equal(collisionDenied.response.status, 409, JSON.stringify(collisionDenied.payload));
  assert.equal(collisionDenied.payload.code, 'operation_batch_conflict');
  assert.deepEqual(writeState(fixture.database, fixture.canvasId), afterApply);

  await fixture.restart();
  const restartReplay = await postCommon(fixture, editor, envelope);
  assert.equal(restartReplay.response.status, 200, JSON.stringify(restartReplay.payload));
  assert.equal(restartReplay.payload.data.duplicate, true);
  assert.deepEqual(restartReplay.payload.data.commonBatch, applied.payload.data.commonBatch);
  assert.deepEqual(restartReplay.payload.data.document, applied.payload.data.document);
  assert.deepEqual(restartReplay.payload.data.results, applied.payload.data.results);
  assert.deepEqual(writeState(fixture.database, fixture.canvasId), afterApply);

  assert.equal(fixture.database.db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(fixture.database.db.pragma('foreign_key_check'), []);
});
