const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DOMAIN_OPERATION_TYPES,
  authorizeCollaborationDomainBatch,
  authorizeCollaborationDomainOperation,
  authorizeHostArtifactCommit,
  authorizeReviewThreadCreate,
  authorizeReviewThreadUpdate,
  authorizeSubflowInstanceUpgrade,
  digestSubflowUpgradePlan,
} = require('../backend/src/services/collaborationDomainAuthority');
const {
  COMMON_OPERATION_CONTRACTS,
} = require('../backend/src/collaboration/commonOperationProtocol');

const IDS = Object.freeze({
  operation: '00000000-0000-4000-8000-000000000001',
  operation2: '00000000-0000-4000-8000-000000000002',
  canvas: '10000000-0000-4000-8000-000000000001',
  node: '20000000-0000-4000-8000-000000000001',
  nodeReplacement: '20000000-0000-4000-8000-000000000002',
  edge: '30000000-0000-4000-8000-000000000001',
  asset: '40000000-0000-4000-8000-000000000001',
  video: '40000000-0000-4000-8000-000000000002',
  thread: '50000000-0000-4000-8000-000000000001',
  comment: '50000000-0000-4000-8000-000000000002',
  definition: '60000000-0000-4000-8000-000000000001',
  inputV1: '61000000-0000-4000-8000-000000000001',
  inputV2: '61000000-0000-4000-8000-000000000002',
  outputV1: '62000000-0000-4000-8000-000000000001',
  outputV2: '62000000-0000-4000-8000-000000000002',
  parameterV1: '63000000-0000-4000-8000-000000000001',
  parameterV2: '63000000-0000-4000-8000-000000000002',
  instance: '64000000-0000-4000-8000-000000000001',
  instanceReplacement: '64000000-0000-4000-8000-000000000002',
  instanceInputEdge: '65000000-0000-4000-8000-000000000001',
  instanceOutputEdge: '65000000-0000-4000-8000-000000000002',
  run: '70000000-0000-4000-8000-000000000001',
  nodeRun: '71000000-0000-4000-8000-000000000001',
  attempt: '72000000-0000-4000-8000-000000000001',
  outputAsset: '73000000-0000-4000-8000-000000000001',
  runNode: '74000000-0000-4000-8000-000000000001',
  project: '80000000-0000-4000-8000-000000000001',
  canvasId: '81000000-0000-4000-8000-000000000001',
  batch: '82000000-0000-4000-8000-000000000001',
  client: '83000000-0000-4000-8000-000000000001',
  blob: '84000000-0000-4000-8000-000000000001',
  foreignProject: '85000000-0000-4000-8000-000000000001',
});

function operation(type, payload, overrides = {}) {
  return {
    opId: IDS.operation,
    type,
    payload,
    ...overrides,
  };
}

function batchScope(overrides = {}) {
  return {
    contractVersion: 't8-common-operation-batch-v1',
    projectId: IDS.project,
    canvasId: IDS.canvasId,
    baseRevision: 7,
    batchId: IDS.batch,
    clientId: IDS.client,
    clientSeq: 1,
    ...overrides,
  };
}

function baseDocument(overrides = {}) {
  return {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: IDS.project,
    canvasId: IDS.canvasId,
    entityUid: IDS.canvas,
    revision: 7,
    nodes: [
      { id: 'node-a', entityUid: IDS.node, type: 'text', position: { x: 0, y: 0 }, data: {} },
    ],
    edges: [],
    tombstones: { nodes: {}, edges: {} },
    ...overrides,
  };
}

function reviewAuthority(overrides = {}) {
  return {
    batch: batchScope(),
    document: baseDocument(),
    principal: { memberId: 'member-a', sessionId: 'session-a', capabilities: ['comment', 'approve'] },
    assets: [
      {
        id: 'asset-display', entityUid: IDS.asset, projectId: IDS.project, kind: 'image', revision: 2,
        availability: 'available', metadata: {},
      },
      {
        id: 'video-display', entityUid: IDS.video, projectId: IDS.project, kind: 'video', revision: 3,
        availability: 'available', metadata: { durationMs: 10_000, frameCount: 300 },
      },
    ],
    allowedAssetEntityUids: new Set([IDS.asset, IDS.video]),
    reviewThreads: [],
    reviewComments: [],
    ...overrides,
  };
}

function reviewCreate(anchor, overrides = {}) {
  return operation('review.thread.create', {
    threadUid: IDS.thread,
    expectedCanvasRevision: 7,
    anchor,
    severity: 'high',
    initialComment: { commentUid: IDS.comment, body: '第一条审片意见' },
    ...overrides,
  });
}

function errorCode(code) {
  return (error) => error?.code === code;
}

test('review thread create validates stable target UID and returns one atomic thread + first-comment plan', () => {
  const result = authorizeReviewThreadCreate(reviewCreate({
    kind: 'node',
    targetUid: IDS.node,
  }), reviewAuthority());

  assert.equal(result.atomic, true);
  assert.deepEqual(result.writes.map((write) => write.kind), [
    'review.thread.insert',
    'review.comment.insert',
  ]);
  assert.equal(result.writes[0].record.entityUid, IDS.thread);
  assert.deepEqual(result.writes[0].record.anchor, { kind: 'node', targetEntityUid: IDS.node });
  assert.equal(result.writes[0].record.revision, 1);
  assert.equal(result.writes[1].record.threadId, IDS.thread);
  assert.equal(result.audit.actorId, 'member-a');
  assert.equal(result.audit.sessionId, 'session-a');
  assert.equal(result.preconditions[0].revision, 7);
  assert.throws(
    () => authorizeReviewThreadCreate(reviewCreate({ kind: 'node', targetUid: IDS.node }), reviewAuthority({
      reviewThreads: [{
        id: IDS.thread,
        entityUid: IDS.operation2,
        projectId: IDS.project,
        canvasId: IDS.canvasId,
        revision: 1,
      }],
    })),
    errorCode('collaboration_domain_review_cas_conflict'),
  );
});

test('review anchors cover canvas, edge, scoped asset, and bounded video frame/timecode', () => {
  const document = baseDocument({
    edges: [{ id: 'edge-a', entityUid: IDS.edge, source: 'node-a', target: 'node-a' }],
  });
  const authority = reviewAuthority({ document });
  const cases = [
    [{ kind: 'canvas', x: 12, y: -4 }, 'canvas'],
    [{ kind: 'edge', targetUid: IDS.edge }, 'edge'],
    [{ kind: 'asset', targetUid: IDS.asset }, 'asset'],
    [{ kind: 'video', targetUid: IDS.video, frameMs: 4_500, assetRevision: 3 }, 'video'],
  ];
  cases.forEach(([anchor, kind], index) => {
    const result = authorizeReviewThreadCreate(reviewCreate(anchor, {
      threadUid: `50000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
      initialComment: {
        commentUid: `50000000-0000-4000-8000-${String(index + 20).padStart(12, '0')}`,
        body: '第一条审片意见',
      },
    }), authority);
    assert.equal(result.result.thread.anchor.kind, kind);
  });
});

test('review target lifecycle rejects deleted UID even when the legacy display ID was reused (ABA)', () => {
  const document = baseDocument({
    nodes: [{ id: 'node-a', entityUid: IDS.nodeReplacement, type: 'text', data: {} }],
    tombstones: { nodes: { 'node-a-old': { entityUid: IDS.node, revision: 6 } }, edges: {} },
  });
  assert.throws(
    () => authorizeReviewThreadCreate(
      reviewCreate({ kind: 'node', targetUid: IDS.node }),
      reviewAuthority({ document }),
    ),
    errorCode('collaboration_domain_target_deleted'),
  );
  const replacement = authorizeReviewThreadCreate(
    reviewCreate({ kind: 'node', targetUid: IDS.nodeReplacement }),
    reviewAuthority({ document }),
  );
  assert.equal(replacement.result.thread.anchor.targetEntityUid, IDS.nodeReplacement);
});

test('review anchors fail closed for assets outside the authoritative canvas grant', () => {
  const crossCanvas = reviewAuthority({ allowedAssetEntityUids: new Set([]) });
  assert.throws(
    () => authorizeReviewThreadCreate(reviewCreate({ kind: 'asset', targetUid: IDS.asset }), crossCanvas),
    errorCode('collaboration_domain_target_missing'),
  );
});

test('review validation rejects stale canvas CAS, uncontrolled enums, and out-of-range video positions', () => {
  const nodeAnchor = { kind: 'node', targetUid: IDS.node };
  assert.throws(
    () => authorizeReviewThreadCreate(
      reviewCreate(nodeAnchor),
      reviewAuthority({ document: baseDocument({ revision: 8 }) }),
    ),
    errorCode('collaboration_domain_revision_mismatch'),
  );
  assert.throws(
    () => authorizeReviewThreadCreate(reviewCreate(nodeAnchor, { unexpectedStatus: 'whatever' }), reviewAuthority()),
    errorCode('collaboration_domain_unsafe_value'),
  );
  assert.throws(
    () => authorizeReviewThreadCreate(reviewCreate(nodeAnchor, { severity: 'critical-ish' }), reviewAuthority()),
    errorCode('collaboration_domain_review_invalid'),
  );
  assert.throws(
    () => authorizeReviewThreadCreate(reviewCreate(nodeAnchor, {
      initialComment: { commentUid: IDS.comment, body: ' padded review ' },
    }), reviewAuthority()),
    errorCode('collaboration_domain_review_invalid'),
  );
  assert.throws(
    () => authorizeReviewThreadCreate(
      reviewCreate({ kind: 'video', targetUid: IDS.video, frameMs: 10_001, assetRevision: 3 }),
      reviewAuthority(),
    ),
    errorCode('collaboration_domain_review_invalid'),
  );
});

test('review update uses a distinct thread revision CAS and never trusts client-created identity fields', () => {
  const thread = {
    id: IDS.thread, entityUid: IDS.thread, projectId: IDS.project, canvasId: IDS.canvasId,
    revision: 3, status: 'open', severity: 'normal',
  };
  const update = operation('review.thread.update', {
    threadUid: IDS.thread,
    expectedCanvasRevision: 7,
    expectedThreadRevision: 3,
    status: 'resolved',
    severity: 'low',
    decisionCanvasRevision: null,
  });
  const result = authorizeReviewThreadUpdate(update, reviewAuthority({ reviewThreads: [thread] }));
  assert.equal(result.writes[0].expectedRevision, 3);
  assert.equal(result.writes[0].patch.revision, 4);
  assert.equal(result.audit.actorId, 'member-a');
  assert.throws(
    () => authorizeReviewThreadUpdate(
      { ...update, payload: { ...update.payload, expectedThreadRevision: 2 } },
      reviewAuthority({ reviewThreads: [thread] }),
    ),
    errorCode('collaboration_domain_review_cas_conflict'),
  );
  assert.throws(
    () => authorizeReviewThreadCreate(
      { ...reviewCreate({ kind: 'node', targetUid: IDS.node }), actorId: 'forged-member' },
      reviewAuthority(),
    ),
    errorCode('collaboration_domain_unsafe_value'),
  );
});

test('review reply atomically inserts the comment and advances the thread CAS revision', () => {
  const parent = {
    id: IDS.operation2,
    entityUid: IDS.operation2,
    threadId: IDS.thread,
    body: 'parent',
  };
  const thread = {
    id: IDS.thread, entityUid: IDS.thread, projectId: IDS.project, canvasId: IDS.canvasId,
    revision: 4, status: 'open', severity: 'normal', comments: [parent],
  };
  const result = authorizeCollaborationDomainOperation(operation('review.comment.add', {
    threadUid: IDS.thread,
    commentUid: IDS.comment,
    parentCommentUid: IDS.operation2,
    expectedCanvasRevision: 7,
    expectedThreadRevision: 4,
    body: '补充证据',
  }), reviewAuthority({ reviewThreads: [thread] }));
  assert.deepEqual(result.writes.map((write) => write.kind), [
    'review.comment.insert',
    'review.thread.update',
  ]);
  assert.equal(result.writes[1].expectedRevision, 4);
  assert.equal(result.writes[1].patch.revision, 5);
  assert.equal(result.result.comment.parentId, IDS.operation2);
  assert.equal(result.audit.actorId, 'member-a');
  const migratedThread = {
    ...thread,
    id: IDS.batch,
    entityUid: IDS.thread,
    comments: [{ ...parent, id: IDS.client, entityUid: IDS.operation2, threadId: IDS.batch }],
  };
  const migratedReply = authorizeCollaborationDomainOperation(operation('review.comment.add', {
    threadUid: IDS.thread,
    commentUid: IDS.comment,
    parentCommentUid: IDS.operation2,
    expectedCanvasRevision: 7,
    expectedThreadRevision: 4,
    body: '回复 UUID 旧主键评论',
  }), reviewAuthority({ reviewThreads: [migratedThread] }));
  assert.equal(migratedReply.result.comment.parentId, IDS.client);
  assert.equal(migratedReply.result.comment.parentEntityUid, IDS.operation2);
  assert.throws(
    () => authorizeCollaborationDomainOperation(operation('review.comment.add', {
      threadUid: IDS.thread,
      commentUid: IDS.operation2,
      parentCommentUid: null,
      expectedCanvasRevision: 7,
      expectedThreadRevision: 4,
      body: '重复 UID',
    }), reviewAuthority({ reviewThreads: [thread] })),
    errorCode('collaboration_domain_review_cas_conflict'),
  );
  const storageCollisionThread = {
    ...thread,
    comments: [{ id: IDS.comment, entityUid: IDS.operation2, threadId: IDS.thread }],
  };
  assert.throws(
    () => authorizeCollaborationDomainOperation(operation('review.comment.add', {
      threadUid: IDS.thread,
      commentUid: IDS.comment,
      parentCommentUid: null,
      expectedCanvasRevision: 7,
      expectedThreadRevision: 4,
      body: '碰撞 UUID 旧主键',
    }), reviewAuthority({ reviewThreads: [storageCollisionThread] })),
    errorCode('collaboration_domain_review_cas_conflict'),
  );
  const otherThread = {
    id: 'other-thread', entityUid: IDS.foreignProject, projectId: IDS.project, canvasId: IDS.canvasId,
    revision: 1, comments: [{ ...parent, threadId: 'other-thread' }],
  };
  assert.throws(
    () => authorizeCollaborationDomainOperation(operation('review.comment.add', {
      threadUid: IDS.thread,
      commentUid: IDS.operation,
      parentCommentUid: IDS.operation2,
      expectedCanvasRevision: 7,
      expectedThreadRevision: 4,
      body: '跨线程回复',
    }), reviewAuthority({ reviewThreads: [{ ...thread, comments: [] }, otherThread] })),
    errorCode('collaboration_domain_target_missing'),
  );
  const deletedParentThread = { ...thread, comments: [{ ...parent, deletedAt: 1 }] };
  assert.throws(
    () => authorizeCollaborationDomainOperation(operation('review.comment.add', {
      threadUid: IDS.thread,
      commentUid: IDS.operation,
      parentCommentUid: IDS.operation2,
      expectedCanvasRevision: 7,
      expectedThreadRevision: 4,
      body: '回复已删除评论',
    }), reviewAuthority({ reviewThreads: [deletedParentThread] })),
    errorCode('collaboration_domain_target_deleted'),
  );
  assert.throws(
    () => authorizeCollaborationDomainOperation(operation('review.comment.add', {
      threadUid: IDS.thread,
      commentUid: IDS.operation2,
      parentCommentUid: null,
      expectedCanvasRevision: 7,
      expectedThreadRevision: 4,
      body: '越权评论',
    }), reviewAuthority({
      reviewThreads: [thread],
      principal: { memberId: 'member-a', sessionId: 'session-a', capabilities: [] },
    })),
    errorCode('collaboration_domain_capability_missing'),
  );
});

function subflowDefinition(version, projectId = IDS.project) {
  const next = version === 2;
  return {
    id: IDS.definition,
    entityUid: IDS.definition,
    projectId,
    version,
    revision: version === 1 ? 4 : 6,
    inputs: [{
      id: next ? 'prompt-v2' : 'prompt-v1',
      entityUid: next ? IDS.inputV2 : IDS.inputV1,
      name: 'Prompt', kind: 'text', internalNodeId: 'leaf', internalHandle: 'text-in',
    }],
    outputs: [{
      id: next ? 'image-v2' : 'image-v1',
      entityUid: next ? IDS.outputV2 : IDS.outputV1,
      name: 'Image', kind: 'image', internalNodeId: 'leaf', internalHandle: 'image-out',
    }],
    exposedParameters: [{
      id: next ? 'steps-v2' : 'steps-v1',
      entityUid: next ? IDS.parameterV2 : IDS.parameterV1,
      name: 'Steps', nodeId: 'leaf', dataKey: 'steps', schema: { type: 'integer', minimum: 1, maximum: 20 },
    }],
  };
}

function subflowDocument(overrides = {}) {
  const instance = {
    id: 'subflow-display',
    entityUid: IDS.instance,
    revision: 2,
    type: 'subflow',
    position: { x: 0, y: 0 },
    data: {
      definitionEntityUid: IDS.definition,
      definitionId: IDS.definition,
      definitionVersion: 1,
      definitionProjectId: IDS.project,
      definitionRevision: 4,
      parameterOverrides: { 'steps-v1': 8 },
    },
  };
  return baseDocument({
    nodes: [
      { id: 'source', entityUid: IDS.node, type: 'text', data: {} },
      instance,
      { id: 'target', entityUid: IDS.nodeReplacement, type: 'output', data: {} },
    ],
    edges: [
      {
        id: 'incoming', entityUid: IDS.instanceInputEdge, source: 'source', target: 'subflow-display',
        targetHandle: 'prompt-v1',
      },
      {
        id: 'outgoing', entityUid: IDS.instanceOutputEdge, source: 'subflow-display', target: 'target',
        sourceHandle: 'image-v1',
      },
    ],
    ...overrides,
  });
}

function subflowPlan(overrides = {}) {
  const plan = {
    instanceUid: IDS.instance,
    definitionUid: IDS.definition,
    expectedCanvasRevision: 7,
    expectedInstanceRevision: 2,
    expectedDefinitionVersion: 1,
    expectedDefinitionRevision: 4,
    targetDefinitionVersion: 2,
    targetDefinitionRevision: 6,
    portMappings: [
      { direction: 'input', fromPortEntityUid: IDS.inputV1, toPortEntityUid: IDS.inputV2 },
      { direction: 'output', fromPortEntityUid: IDS.outputV1, toPortEntityUid: IDS.outputV2 },
    ],
    parameterMappings: [
      { fromParameterEntityUid: IDS.parameterV1, toParameterEntityUid: IDS.parameterV2 },
    ],
    ...overrides,
  };
  return { ...plan, upgradePlanDigest: digestSubflowUpgradePlan(plan) };
}

function subflowAuthority(overrides = {}) {
  return {
    batch: batchScope(),
    document: subflowDocument(),
    principal: { memberId: 'member-a', sessionId: 'session-a', capabilities: ['editGraph'] },
    subflowDefinitions: [subflowDefinition(1), subflowDefinition(2)],
    subflowUpgradePlans: [subflowPlan()],
    ...overrides,
  };
}

function subflowUpgrade(overrides = {}, plan = subflowPlan()) {
  return operation('subflow.instance.upgrade', {
    instanceUid: IDS.instance,
    definitionUid: IDS.definition,
    expectedCanvasRevision: 7,
    expectedInstanceRevision: 2,
    expectedDefinitionVersion: 1,
    expectedDefinitionRevision: 4,
    targetDefinitionVersion: 2,
    targetDefinitionRevision: 6,
    upgradePlanDigest: plan.upgradePlanDigest,
    ...overrides,
  });
}

test('subflow.instance.upgrade resolves authoritative definitions and returns exact node/edge/parameter transaction plan', () => {
  const result = authorizeSubflowInstanceUpgrade(subflowUpgrade(), subflowAuthority());
  const write = result.writes[0];
  assert.equal(result.atomic, true);
  assert.equal(write.instanceEntityUid, IDS.instance);
  assert.equal(write.nodeDataPatch.definitionVersion, 2);
  assert.equal(write.nodeDataPatch.definition.version, 2);
  assert.equal(write.nodeDataPatch.definition.revision, 6);
  assert.deepEqual(write.nodeDataPatch.definition.inputs.map((port) => port.id), ['prompt-v2']);
  assert.deepEqual(write.nodeDataPatch.definition.outputs.map((port) => port.id), ['image-v2']);
  assert.deepEqual(write.nodeDataPatch.parameterOverrides, { 'steps-v2': 8 });
  assert.deepEqual(write.edgePatches.map((patch) => [patch.edgeEntityUid, patch.handle]), [
    [IDS.instanceInputEdge, 'prompt-v2'],
    [IDS.instanceOutputEdge, 'image-v2'],
  ]);
  assert.deepEqual(write.disconnectedEdgeEntityUids, []);
  assert.equal(result.audit.targetId, IDS.instance);
});

test('subflow upgrade makes removals explicit and fails closed on omitted connected-port/override mapping', () => {
  const removedPlan = subflowPlan({
    portMappings: [
      { direction: 'input', fromPortEntityUid: IDS.inputV1, toPortEntityUid: null },
      { direction: 'output', fromPortEntityUid: IDS.outputV1, toPortEntityUid: null },
    ],
    parameterMappings: [{ fromParameterEntityUid: IDS.parameterV1, toParameterEntityUid: null }],
  });
  const removed = authorizeSubflowInstanceUpgrade(
    subflowUpgrade({}, removedPlan),
    subflowAuthority({ subflowUpgradePlans: [removedPlan] }),
  );
  assert.deepEqual(removed.writes[0].disconnectedEdgeEntityUids, [IDS.instanceInputEdge, IDS.instanceOutputEdge]);
  assert.deepEqual(removed.writes[0].discardedOverrides, [{ parameterEntityUid: IDS.parameterV1, reason: 'removed' }]);
  assert.throws(
    () => {
      const plan = subflowPlan({ portMappings: [] });
      return authorizeSubflowInstanceUpgrade(subflowUpgrade({}, plan), subflowAuthority({ subflowUpgradePlans: [plan] }));
    },
    errorCode('collaboration_domain_subflow_invalid'),
  );
  assert.throws(
    () => {
      const plan = subflowPlan({ parameterMappings: [] });
      return authorizeSubflowInstanceUpgrade(subflowUpgrade({}, plan), subflowAuthority({ subflowUpgradePlans: [plan] }));
    },
    errorCode('collaboration_domain_subflow_invalid'),
  );
  assert.throws(
    () => {
      const plan = subflowPlan({
        portMappings: [{ direction: 'input', fromPortEntityUid: IDS.inputV1 }],
      });
      return authorizeSubflowInstanceUpgrade(subflowUpgrade({}, plan), subflowAuthority({ subflowUpgradePlans: [plan] }));
    },
    errorCode('collaboration_domain_subflow_invalid'),
  );
});

test('subflow upgrade rejects deleted/ABA instance UID, foreign definitions, stale revision, and non-forward versions', () => {
  const canonicalPlan = subflowPlan();
  assert.throws(
    () => authorizeSubflowInstanceUpgrade(
      subflowUpgrade({ upgradePlanDigest: [canonicalPlan.upgradePlanDigest] }, canonicalPlan),
      subflowAuthority({ subflowUpgradePlans: [canonicalPlan] }),
    ),
    errorCode('collaboration_domain_subflow_invalid'),
  );
  const abaDocument = subflowDocument({
    nodes: subflowDocument().nodes.map((node) => node.id === 'subflow-display'
      ? { ...node, entityUid: IDS.instanceReplacement }
      : node),
    tombstones: { nodes: { old: { entityUid: IDS.instance, revision: 6 } }, edges: {} },
  });
  assert.throws(
    () => authorizeSubflowInstanceUpgrade(subflowUpgrade(), subflowAuthority({ document: abaDocument })),
    errorCode('collaboration_domain_target_deleted'),
  );
  assert.throws(
    () => authorizeSubflowInstanceUpgrade(
      subflowUpgrade(),
      subflowAuthority({ subflowDefinitions: [subflowDefinition(1), subflowDefinition(2, IDS.foreignProject)] }),
    ),
    errorCode('collaboration_domain_scope_mismatch'),
  );
  assert.throws(
    () => authorizeSubflowInstanceUpgrade(subflowUpgrade(), subflowAuthority({ document: subflowDocument({ revision: 8 }) })),
    errorCode('collaboration_domain_revision_mismatch'),
  );
  assert.throws(
    () => authorizeSubflowInstanceUpgrade(subflowUpgrade({ targetDefinitionVersion: 1, targetDefinitionRevision: 4 }), subflowAuthority()),
    errorCode('collaboration_domain_subflow_invalid'),
  );
});

test('subflow upgrade rechecks target port capacity against authoritative attached edges', () => {
  const document = subflowDocument({
    edges: [
      ...subflowDocument().edges,
      {
        id: 'incoming-2', entityUid: IDS.operation2, source: 'source', target: 'subflow-display',
        targetHandle: 'prompt-v1',
      },
    ],
  });
  const next = subflowDefinition(2);
  next.inputs[0].maxConnections = 1;
  assert.throws(
    () => authorizeSubflowInstanceUpgrade(
      subflowUpgrade(),
      subflowAuthority({ document, subflowDefinitions: [subflowDefinition(1), next] }),
    ),
    errorCode('collaboration_domain_subflow_invalid'),
  );
});

function hostAuthority(overrides = {}) {
  const run = {
    id: IDS.run, entityUid: IDS.run, projectId: IDS.project, canvasId: IDS.canvasId,
    canvasRevision: 6, revision: 3, status: 'running',
  };
  const nodeRun = {
    id: IDS.nodeRun, entityUid: IDS.nodeRun, runId: IDS.run, runEntityUid: IDS.run,
    nodeEntityUid: IDS.runNode, revision: 4, status: 'running',
  };
  const attempt = {
    id: IDS.attempt, entityUid: IDS.attempt, nodeRunId: IDS.nodeRun, nodeRunEntityUid: IDS.nodeRun,
    revision: 5, status: 'succeeded',
  };
  const asset = {
    id: IDS.outputAsset,
    entityUid: IDS.outputAsset,
    projectId: IDS.project,
    blobUid: IDS.blob,
    kind: 'image',
    filename: 'result.png',
    mimeType: 'image/png',
    byteSize: 12,
    availability: 'available',
    contentHash: 'a'.repeat(64),
    provenance: {
      runEntityUid: IDS.run,
      nodeRunEntityUid: IDS.nodeRun,
      attemptEntityUid: IDS.attempt,
      canvasId: IDS.canvasId,
      canvasRevision: 6,
      sourceNodeEntityUid: IDS.runNode,
      outputOrdinal: 0,
    },
  };
  const blob = {
    id: IDS.blob,
    entityUid: IDS.blob,
    contentHash: 'a'.repeat(64),
    byteSize: 12,
    verificationState: 'verified',
    storageState: 'ready',
    storageKey: 'cas/aa/result',
    verifiedAt: 1,
  };
  return {
    batch: batchScope(),
    document: baseDocument(),
    hostIdentity: { actorId: 'host-executor', sessionId: 'host-session' },
    runs: [run], nodeRuns: [nodeRun], attempts: [attempt], assets: [asset], blobs: [blob],
    ...overrides,
  };
}

function hostCommit(overrides = {}) {
  return operation('host.artifact.commit', {
    artifactUid: IDS.outputAsset,
    blobUid: IDS.blob,
    runUid: IDS.run,
    nodeRunUid: IDS.nodeRun,
    attemptUid: IDS.attempt,
    nodeUid: IDS.runNode,
    expectedCanvasRevision: 7,
    expectedRunRevision: 3,
    expectedNodeRunRevision: 4,
    expectedAttemptRevision: 5,
    outputOrdinal: 0,
    kind: 'image',
    contentHash: 'a'.repeat(64),
    byteSize: 12,
    filename: 'result.png',
    mimeType: 'image/png',
    ...overrides,
  });
}

test('host artifact commit binds UUID run/nodeRun/attempt/asset and produces one authoritative node.output + audit plan', () => {
  const result = authorizeHostArtifactCommit(hostCommit(), hostAuthority());
  const write = result.writes[0];
  assert.equal(result.atomic, true);
  assert.equal(write.kind, 'host.artifact.commit');
  assert.equal(write.event.type, 'node.output');
  assert.equal(write.event.canvasRevision, 6);
  assert.deepEqual(result.result, {
    runId: IDS.run,
    nodeRunId: IDS.nodeRun,
    attemptId: IDS.attempt,
    assetEntityUid: IDS.outputAsset,
    blobUid: IDS.blob,
    nodeEntityUid: IDS.runNode,
    outputIndex: 0,
  });
  assert.equal(result.audit.actorId, 'host-executor');
  assert.equal(result.audit.sessionId, 'host-session');
});

test('host artifact authority rejects forged audit identity, cross-canvas/wrong revision, and broken lineage bindings', () => {
  assert.throws(
    () => authorizeHostArtifactCommit({ ...hostCommit(), actorId: 'member-a' }, hostAuthority()),
    errorCode('collaboration_domain_unsafe_value'),
  );
  assert.throws(
    () => authorizeHostArtifactCommit(hostCommit(), hostAuthority({ batch: batchScope({ canvasId: IDS.foreignProject }) })),
    errorCode('collaboration_domain_scope_mismatch'),
  );
  assert.throws(
    () => authorizeHostArtifactCommit(hostCommit({ expectedCanvasRevision: 8 }), hostAuthority()),
    errorCode('collaboration_domain_revision_mismatch'),
  );
  const brokenAsset = { ...hostAuthority().assets[0], provenance: { ...hostAuthority().assets[0].provenance, attemptEntityUid: IDS.operation2 } };
  assert.throws(
    () => authorizeHostArtifactCommit(hostCommit(), hostAuthority({ assets: [brokenAsset] })),
    errorCode('collaboration_domain_artifact_invalid'),
  );
});

test('host artifact authority rejects failed lifecycle, non-UUID references, invalid content identity, and caller audit fields', () => {
  const failedAttempt = { ...hostAuthority().attempts[0], status: 'failed' };
  assert.throws(
    () => authorizeHostArtifactCommit(hostCommit(), hostAuthority({ attempts: [failedAttempt] })),
    errorCode('collaboration_domain_artifact_invalid'),
  );
  assert.throws(
    () => authorizeHostArtifactCommit(hostCommit({ runUid: 'run-display-id' }), hostAuthority()),
    errorCode('collaboration_domain_artifact_invalid'),
  );
  assert.throws(
    () => authorizeHostArtifactCommit(hostCommit({ contentHash: 'b'.repeat(64) }), hostAuthority()),
    errorCode('collaboration_domain_artifact_invalid'),
  );
  assert.throws(
    () => authorizeHostArtifactCommit(hostCommit({ kind: ['image'] }), hostAuthority()),
    errorCode('collaboration_domain_artifact_invalid'),
  );
  assert.throws(
    () => authorizeHostArtifactCommit(hostCommit({ contentHash: ['a'.repeat(64)] }), hostAuthority()),
    errorCode('collaboration_domain_artifact_invalid'),
  );
  const unverifiedBlob = { ...hostAuthority().blobs[0], verificationState: 'unverified' };
  assert.throws(
    () => authorizeHostArtifactCommit(hostCommit(), hostAuthority({ blobs: [unverifiedBlob] })),
    errorCode('collaboration_domain_artifact_invalid'),
  );
  const unboundAsset = {
    ...hostAuthority().assets[0],
    provenance: { ...hostAuthority().assets[0].provenance },
  };
  delete unboundAsset.provenance.outputOrdinal;
  assert.throws(
    () => authorizeHostArtifactCommit(hostCommit(), hostAuthority({ assets: [unboundAsset] })),
    errorCode('collaboration_domain_artifact_invalid'),
  );
  const pathAsset = { ...hostAuthority().assets[0], filename: '../result.png' };
  assert.throws(
    () => authorizeHostArtifactCommit(hostCommit({ filename: '../result.png' }), hostAuthority({ assets: [pathAsset] })),
    errorCode('collaboration_domain_artifact_invalid'),
  );
  assert.throws(
    () => authorizeHostArtifactCommit(
      { ...hostCommit(), payload: { ...hostCommit().payload, createdBy: 'forged' } },
      hostAuthority(),
    ),
    errorCode('collaboration_domain_unsafe_value'),
  );
});

test('domain batch entry consumes the frozen t8-common-operation-batch-v1 envelope without a parallel scope', () => {
  const rawBatch = {
    contractVersion: 't8-common-operation-batch-v1',
    projectId: IDS.project,
    canvasId: IDS.canvasId,
    baseRevision: 7,
    batchId: IDS.batch,
    clientId: IDS.client,
    clientSeq: 9,
    operations: [reviewCreate({ kind: 'node', targetUid: IDS.node })],
  };
  const result = authorizeCollaborationDomainBatch(rawBatch, reviewAuthority());
  assert.equal(result.batch.operations[0].type, 'review.thread.create');
  assert.equal(result.operations.length, 1);
  assert.deepEqual(result.writes.map((write) => write.kind), [
    'review.thread.insert',
    'review.comment.insert',
  ]);
  assert.equal(result.operations[0].scope.projectId, IDS.project);
  assert.equal(result.operations[0].scope.canvasId, IDS.canvasId);
});

test('domain authority operation types and legacy project/canvas scope stay aligned with the frozen common protocol', () => {
  const commonDomainTypes = Object.entries(COMMON_OPERATION_CONTRACTS)
    .filter(([, contract]) => contract.domain !== 'graph')
    .map(([type]) => type)
    .sort();
  assert.deepEqual([...DOMAIN_OPERATION_TYPES].sort(), commonDomainTypes);

  const projectId = 'legacy-project-id';
  const canvasId = 'legacy-canvas-id';
  const rawBatch = {
    contractVersion: 't8-common-operation-batch-v1',
    projectId,
    canvasId,
    baseRevision: 7,
    batchId: IDS.batch,
    clientId: IDS.client,
    clientSeq: 10,
    operations: [reviewCreate({ kind: 'node', targetUid: IDS.node })],
  };
  const authority = reviewAuthority({
    document: baseDocument({ projectId, canvasId }),
  });
  const result = authorizeCollaborationDomainBatch(rawBatch, authority);
  assert.deepEqual(result.operations[0].scope, { projectId, canvasId, baseRevision: 7 });
});

test('direct domain helpers preserve common-protocol exact payload fields', () => {
  const raw = reviewCreate({ kind: 'node', targetUid: IDS.node });
  assert.throws(
    () => authorizeReviewThreadCreate(reviewCreate({ kind: ['node'], targetUid: IDS.node }), reviewAuthority()),
    errorCode('collaboration_domain_review_invalid'),
  );
  const { severity: _omitted, ...payload } = raw.payload;
  assert.throws(
    () => authorizeReviewThreadCreate({ ...raw, payload }, reviewAuthority()),
    errorCode('collaboration_domain_review_invalid'),
  );
  for (const severity of [undefined, null]) {
    assert.throws(
      () => authorizeReviewThreadCreate({ ...raw, payload: { ...raw.payload, severity } }, reviewAuthority()),
    );
  }
  const hidden = { ...raw.payload };
  Object.defineProperty(hidden, 'severity', { value: 'high', enumerable: false });
  assert.throws(
    () => authorizeReviewThreadCreate({ ...raw, payload: hidden }, reviewAuthority()),
    errorCode('collaboration_domain_unsafe_value'),
  );
  const nullPrototype = Object.assign(Object.create(null), raw.payload);
  assert.throws(
    () => authorizeReviewThreadCreate({ ...raw, payload: nullPrototype }, reviewAuthority()),
    errorCode('collaboration_domain_unsafe_value'),
  );
  const aheadThread = {
    id: IDS.thread, entityUid: IDS.thread, projectId: IDS.project, canvasId: IDS.canvasId,
    revision: 8, status: 'open', severity: 'normal', comments: [],
  };
  const aheadUpdate = authorizeReviewThreadUpdate(operation('review.thread.update', {
      threadUid: IDS.thread,
      expectedCanvasRevision: 7,
      expectedThreadRevision: 8,
      status: 'resolved',
      severity: 'normal',
      decisionCanvasRevision: null,
    }), reviewAuthority({ reviewThreads: [aheadThread] }));
  assert.equal(aheadUpdate.result.thread.revision, 9, 'thread CAS is independent from canvas revision');
  const aheadComment = authorizeCollaborationDomainOperation(operation('review.comment.add', {
      threadUid: IDS.thread,
      commentUid: IDS.comment,
      parentCommentUid: null,
      expectedCanvasRevision: 7,
      expectedThreadRevision: 8,
      body: 'revision ahead',
    }), reviewAuthority({ reviewThreads: [aheadThread] }));
  assert.equal(aheadComment.result.threadRevision, 9, 'comment advances the independent thread CAS');
});

test('domain authority rejects prototype pollution and bounded payload/mapping violations without mutating inputs', () => {
  const pollutedPayload = JSON.parse(`{
    "threadUid":"${IDS.thread}",
    "expectedCanvasRevision":7,
    "anchor":{"kind":"node","targetUid":"${IDS.node}"},
    "severity":"normal",
    "initialComment":{"commentUid":"${IDS.comment}","body":"ok"},
    "__proto__":{"polluted":true}
  }`);
  assert.throws(
    () => authorizeCollaborationDomainOperation(
      operation('review.thread.create', pollutedPayload),
      reviewAuthority(),
    ),
    errorCode('collaboration_domain_unsafe_value'),
  );
  assert.equal({}.polluted, undefined);

  const sparseMappings = new Array(1);
  assert.throws(
    () => subflowPlan({ portMappings: sparseMappings }),
    errorCode('collaboration_domain_unsafe_value'),
  );

  const tooManyMappings = Array.from({ length: 501 }, () => ({
    direction: 'input', fromPortEntityUid: IDS.inputV1, toPortEntityUid: IDS.inputV2,
  }));
  assert.throws(
    () => {
      const plan = subflowPlan({ portMappings: tooManyMappings });
      return authorizeSubflowInstanceUpgrade(subflowUpgrade({}, plan), subflowAuthority({ subflowUpgradePlans: [plan] }));
    },
    (error) => ['collaboration_domain_subflow_invalid', 'collaboration_domain_operation_too_large'].includes(error?.code),
  );

  const oversized = reviewCreate({ kind: 'node', targetUid: IDS.node }, {
    initialComment: { commentUid: IDS.comment, body: 'x'.repeat(70_000) },
  });
  assert.throws(
    () => authorizeReviewThreadCreate(oversized, reviewAuthority()),
    (error) => ['collaboration_domain_unsafe_value', 'collaboration_domain_operation_too_large'].includes(error?.code),
  );

  const input = subflowUpgrade();
  const before = JSON.stringify(input);
  authorizeSubflowInstanceUpgrade(input, subflowAuthority());
  assert.equal(JSON.stringify(input), before);
});
