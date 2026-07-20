const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CollaborationGateway } = require('../backend/src/collaboration/gateway');
const {
  COMMON_OPERATION_BATCH_CONTRACT,
} = require('../backend/src/collaboration/commonOperationProtocol');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const {
  closeSocket,
  joinSocket,
  openSocketProbe,
  redeemActor,
  requestJson,
  TEST_MANAGEMENT_AUTHORITY,
} = require('./helpers/collaborationF2Fixture.cjs');

const PROJECT_ID = 'project-review-visibility-f6';
const CANVAS_ID = 'canvas-review-visibility-f6';
const NODE_UID = 'f6400000-0000-4000-8000-000000000001';
const SUBFLOW_ID = 'review-visibility-subflow-f6';
const PROMPT_SECRET = 'F6_REVIEWER_PROMPT_MUST_BE_HIDDEN';
const MODEL_SECRET = 'F6_PRIVATE_MODEL_MUST_BE_HIDDEN';
const PROVIDER_SECRET = 'F6_PRIVATE_PROVIDER_MUST_BE_HIDDEN';
const ASPECT_RATIO_SECRET = 'F6_PRIVATE_ASPECT_RATIO_MUST_BE_HIDDEN';
const SIZE_LEVEL_SECRET = 'F6_PRIVATE_SIZE_LEVEL_MUST_BE_HIDDEN';
const GUIDANCE_SECRET = 'F6_PRIVATE_GUIDANCE_MUST_BE_HIDDEN';
const RESOLUTION_SECRET = 'F6_PRIVATE_RESOLUTION_MUST_BE_HIDDEN';
const DURATION_SECRET = 'F6_PRIVATE_DURATION_MUST_BE_HIDDEN';
const DIRECT_MODEL_PARAMETER_VALUES = Object.freeze({
  maxTokens: 'F6_PRIVATE_MAX_TOKENS_MUST_BE_HIDDEN',
  maxCompletionTokens: 'F6_PRIVATE_MAX_COMPLETION_TOKENS_MUST_BE_HIDDEN',
  stop: 'F6_PRIVATE_STOP_MUST_BE_HIDDEN',
  n: 'F6_PRIVATE_N_MUST_BE_HIDDEN',
  doSample: 'F6_PRIVATE_DO_SAMPLE_MUST_BE_HIDDEN',
  numBeams: 'F6_PRIVATE_NUM_BEAMS_MUST_BE_HIDDEN',
  ckpt_name: 'F6_PRIVATE_CKPT_NAME_MUST_BE_HIDDEN',
  vae_name: 'F6_PRIVATE_VAE_NAME_MUST_BE_HIDDEN',
  lora_name: 'F6_PRIVATE_LORA_NAME_MUST_BE_HIDDEN',
  sample_shift: 'F6_PRIVATE_SAMPLE_SHIFT_MUST_BE_HIDDEN',
});
const EXPLICIT_MODEL_PARAMETER_VALUES = Object.freeze({
  width: 'F6_PRIVATE_REQUEST_WIDTH_MUST_BE_HIDDEN',
  height: 'F6_PRIVATE_REQUEST_HEIGHT_MUST_BE_HIDDEN',
  duration: 'F6_PRIVATE_REQUEST_DURATION_MUST_BE_HIDDEN',
  format: 'F6_PRIVATE_REQUEST_FORMAT_MUST_BE_HIDDEN',
});
const VISIBLE_OUTPUT_FIELDS = Object.freeze({
  width: 1920,
  height: 1080,
  duration: 8,
  format: 'mp4',
  imageUrl: '/files/output/f6-review-visible-image.png',
  videoUrl: '/files/output/f6-review-visible-video.mp4',
  audioUrl: '/files/output/f6-review-visible-audio.wav',
  mediaUrl: '/api/collab/assets/f6-review-visible/media',
  previewUrl: '/api/collab/assets/f6-review-visible/media?representation=preview',
  thumbnailUrl: '/api/collab/assets/f6-review-visible/media?representation=thumbnail',
  modelPreviewUrl: '/api/collab/assets/f6-review-visible/media?representation=model-preview',
});
const VISIBLE_OUTPUT_METADATA = Object.freeze({
  width: 1920,
  height: 1080,
  duration: 8,
  format: 'mp4',
  resolution: '1920x1080',
  size: 4096,
  outputFormat: 'mp4',
});
const MODEL_PARAMETER_SECRETS = [
  ASPECT_RATIO_SECRET,
  SIZE_LEVEL_SECRET,
  GUIDANCE_SECRET,
  RESOLUTION_SECRET,
  DURATION_SECRET,
  ...Object.values(DIRECT_MODEL_PARAMETER_VALUES),
  ...Object.values(EXPLICIT_MODEL_PARAMETER_VALUES),
];
const PUBLIC_CANVAS_MODEL_PARAMETER_SECRETS = MODEL_PARAMETER_SECRETS.filter((value) => (
  value !== DIRECT_MODEL_PARAMETER_VALUES.maxCompletionTokens
));
const COMMON_REVIEW_IDENTITIES = Object.freeze({
  reviewer: Object.freeze({
    batch: 'f6410000-0000-4000-8000-000000000001',
    client: 'f6410000-0000-4000-8000-000000000002',
    thread: 'f6410000-0000-4000-8000-000000000003',
    comment: 'f6410000-0000-4000-8000-000000000004',
    operation: 'f6410000-0000-4000-8000-000000000005',
  }),
  editor: Object.freeze({
    batch: 'f6420000-0000-4000-8000-000000000001',
    client: 'f6420000-0000-4000-8000-000000000002',
    thread: 'f6420000-0000-4000-8000-000000000003',
    comment: 'f6420000-0000-4000-8000-000000000004',
    operation: 'f6420000-0000-4000-8000-000000000005',
  }),
});

function installModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  const previous = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
  return () => {
    if (previous) require.cache[resolved] = previous;
    else delete require.cache[resolved];
  };
}

function loadRouterFactory(gateway) {
  const restoreGateway = installModuleMock('../backend/src/collaboration/gateway', {
    getCollaborationGateway: () => gateway,
  });
  const routePath = require.resolve('../backend/src/routes/collaboration');
  const previousRoute = require.cache[routePath];
  delete require.cache[routePath];
  try {
    return require(routePath).createCollaborationRouter;
  } finally {
    restoreGateway();
    if (previousRoute) require.cache[routePath] = previousRoute;
    else delete require.cache[routePath];
  }
}

async function createVisibilityFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-review-visibility-f6-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  database.saveSubflowDefinition({
    id: SUBFLOW_ID,
    version: 1,
    projectId: PROJECT_ID,
    name: 'F6 visibility subflow',
    description: 'subflow description',
    tags: [],
    nodes: [{
      id: 'subflow-sensitive-node',
      type: 'text',
      position: { x: 0, y: 0 },
      data: {
        prompt: PROMPT_SECRET,
        model: MODEL_SECRET,
        provider: PROVIDER_SECRET,
        parameters: { temperature: 0.7 },
        aspectRatio: ASPECT_RATIO_SECRET,
        sizeLevel: SIZE_LEVEL_SECRET,
        guidanceScale: GUIDANCE_SECRET,
        providerParams: { resolution: RESOLUTION_SECRET, duration: DURATION_SECRET },
        ...DIRECT_MODEL_PARAMETER_VALUES,
        request: EXPLICIT_MODEL_PARAMETER_VALUES,
      },
    }],
    edges: [],
    inputs: [],
    outputs: [],
    exposedParameters: [],
    requiredCapabilities: [],
    assetRefs: [],
  }, {
    expectedRevision: 0,
    actorId: 'local-owner',
    sessionId: 'f6-visibility-fixture',
    changeSummary: 'Create F6 visibility subflow fixture',
  });
  database.ensureCanvas(CANVAS_ID, {
    projectId: PROJECT_ID,
    name: 'F6 review visibility canvas',
    nodes: [
      {
        id: 'node-sensitive',
        entityUid: NODE_UID,
        type: 'text',
        position: { x: 0, y: 0 },
        data: {
          prompt: PROMPT_SECRET,
          negativePrompt: `${PROMPT_SECRET}_NEGATIVE`,
          model: MODEL_SECRET,
          provider: PROVIDER_SECRET,
          parameters: { temperature: 0.6, steps: 24 },
          aspectRatio: ASPECT_RATIO_SECRET,
          sizeLevel: SIZE_LEVEL_SECRET,
          guidanceScale: GUIDANCE_SECRET,
          providerParams: { resolution: RESOLUTION_SECRET, duration: DURATION_SECRET },
          ...DIRECT_MODEL_PARAMETER_VALUES,
          request: EXPLICIT_MODEL_PARAMETER_VALUES,
          ...VISIBLE_OUTPUT_FIELDS,
          outputMetadata: VISIBLE_OUTPUT_METADATA,
          visibleTitle: 'safe title',
        },
      },
      {
        id: 'node-subflow',
        type: 'subflow',
        position: { x: 240, y: 0 },
        data: { definitionId: SUBFLOW_ID, definitionVersion: 1 },
      },
    ],
    edges: [],
  }, PROJECT_ID);
  database.initializeCanvasResourceGrantsForSharing(PROJECT_ID, CANVAS_ID, {
    actorId: 'local-owner',
    sessionId: 'f6-visibility-fixture',
  });
  const run = database.createRun({
    id: 'review-visibility-run-f6',
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    canvasRevision: 1,
    initiatorId: 'local-owner',
    status: 'failed',
  });
  const nodeRun = database.createNodeRun({
    id: 'review-visibility-node-run-f6',
    runId: run.id,
    nodeId: 'node-sensitive',
    status: 'failed',
  });
  database.createAttempt({
    id: 'review-visibility-attempt-f6',
    nodeRunId: nodeRun.id,
    provider: PROVIDER_SECRET,
    model: MODEL_SECRET,
    status: 'failed',
    error: { kind: 'network', code: 'ETIMEDOUT', retryable: true },
  });

  const gateway = new CollaborationGateway({
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    FRONTEND_DIST: '',
    INPUT_DIR: input,
    OUTPUT_DIR: output,
  }, database);
  const status = await gateway.start({ host: '127.0.0.1', port: 0 });
  const baseUrl = `http://127.0.0.1:${status.port}`;
  const createCollaborationRouter = loadRouterFactory(gateway);
  const app = express();
  app.use(express.json({ strict: true }));
  app.use('/api/collaboration', createCollaborationRouter(gateway, {
    managementAuthority: TEST_MANAGEMENT_AUTHORITY,
  }));
  const managementServer = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const fixture = {
    directory,
    database,
    gateway,
    status,
    baseUrl,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    managementServer,
    managementBase: `http://127.0.0.1:${managementServer.address().port}/api/collaboration`,
    sockets: new Set(),
  };
  t.after(async () => {
    for (const probe of fixture.sockets) {
      try { await closeSocket(probe.socket); } catch (_) { /* best effort */ }
    }
    await gateway.stop();
    await new Promise((resolve) => managementServer.close(resolve));
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return fixture;
}

async function managementPut(fixture, body) {
  return requestJson(`${fixture.managementBase}/review-visibility-policy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function publicGet(fixture, actor, pathname) {
  return requestJson(`${fixture.baseUrl}${pathname}`, {
    headers: { cookie: actor.cookie },
  });
}

async function inspectRun(fixture, actor) {
  return requestJson(`${fixture.baseUrl}/api/collab/canvases/${CANVAS_ID}/agent/tools`, {
    method: 'POST',
    headers: {
      cookie: actor.cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      tool: 'inspectRun',
      requestId: `f6-visibility-${actor.role}`,
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      input: { runId: 'review-visibility-run-f6' },
    }),
  });
}

function commonReviewCreateBatch(fixture, identities, baseRevision) {
  return {
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    baseRevision,
    batchId: identities.batch,
    clientId: identities.client,
    clientSeq: 1,
    operations: [{
      opId: identities.operation,
      type: 'review.thread.create',
      payload: {
        threadUid: identities.thread,
        expectedCanvasRevision: baseRevision,
        anchor: { kind: 'canvas', x: 32, y: 48 },
        severity: 'normal',
        initialComment: {
          commentUid: identities.comment,
          body: '验证 Review mutation 响应可见性',
        },
      },
    }],
  };
}

async function postCommonReviewOperations(fixture, actor, batch) {
  return requestJson(`${fixture.baseUrl}/api/collab/common-operations`, {
    method: 'POST',
    headers: {
      cookie: actor.cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify(batch),
  });
}

function assertHiddenPayload(result, label) {
  assert.equal(result.response.status, 200, `${label}: ${JSON.stringify(result.payload)}`);
  assert.doesNotMatch(result.text, new RegExp(PROMPT_SECRET));
  assert.doesNotMatch(result.text, new RegExp(MODEL_SECRET));
  assert.doesNotMatch(result.text, new RegExp(PROVIDER_SECRET));
  for (const value of MODEL_PARAMETER_SECRETS) {
    assert.doesNotMatch(result.text, new RegExp(value));
  }
  assert.match(result.text, /由主机隐藏/, `${label} did not contain an explicit host-hidden marker`);
}

function assertVisiblePayload(result, label, expected = [PROMPT_SECRET, MODEL_SECRET, PROVIDER_SECRET]) {
  assert.equal(result.response.status, 200, `${label}: ${JSON.stringify(result.payload)}`);
  for (const value of expected) {
    assert.match(result.text, new RegExp(value), `${label} unexpectedly redacted ${value}`);
  }
}

function sensitiveCanvasNodeData(result, label) {
  assert.equal(result.response.status, 200, `${label}: ${JSON.stringify(result.payload)}`);
  const node = result.payload?.data?.nodes?.find((item) => item?.id === 'node-sensitive');
  assert.ok(node?.data && typeof node.data === 'object', `${label}: sensitive node.data missing`);
  return node.data;
}

function assertReviewerCanvasNodeShape(result, label) {
  const data = sensitiveCanvasNodeData(result, label);
  for (const field of Object.keys(DIRECT_MODEL_PARAMETER_VALUES)) {
    if (field === 'maxCompletionTokens') {
      assert.equal(data[field], undefined, `${label}: baseline sanitizer must omit ${field}`);
    } else {
      assert.equal(data[field], '[由主机隐藏]', `${label}: ${field} leaked`);
    }
  }
  for (const field of Object.keys(EXPLICIT_MODEL_PARAMETER_VALUES)) {
    assert.equal(data.request[field], '[由主机隐藏]', `${label}: request.${field} leaked`);
  }
  assert.equal(data.parameters, '[由主机隐藏]');
  assert.equal(data.providerParams, '[由主机隐藏]');
  for (const [field, value] of Object.entries(VISIBLE_OUTPUT_FIELDS)) {
    assert.deepEqual(data[field], value, `${label}: output ${field} was damaged`);
  }
  assert.deepEqual(
    data.outputMetadata,
    VISIBLE_OUTPUT_METADATA,
    `${label}: output metadata was damaged`,
  );
}

function assertEditorCanvasNodeShape(result, label) {
  const data = sensitiveCanvasNodeData(result, label);
  for (const [field, value] of Object.entries(DIRECT_MODEL_PARAMETER_VALUES)) {
    if (field === 'maxCompletionTokens') {
      assert.equal(data[field], undefined, `${label}: baseline sanitizer must omit ${field}`);
    } else {
      assert.equal(data[field], value, `${label}: ${field} changed`);
    }
  }
  assert.deepEqual(data.request, EXPLICIT_MODEL_PARAMETER_VALUES, `${label}: request changed`);
  assert.deepEqual(data.providerParams, {
    resolution: RESOLUTION_SECRET,
    duration: DURATION_SECRET,
  });
  for (const [field, value] of Object.entries(VISIBLE_OUTPUT_FIELDS)) {
    assert.deepEqual(data[field], value, `${label}: output ${field} changed`);
  }
  assert.deepEqual(data.outputMetadata, VISIBLE_OUTPUT_METADATA, `${label}: output metadata changed`);
}

test('F6 loopback review visibility management requires complete input and exact policy CAS', async (t) => {
  const fixture = await createVisibilityFixture(t);
  const initial = await requestJson(
    `${fixture.managementBase}/review-visibility-policy?projectId=${encodeURIComponent(PROJECT_ID)}`,
  );
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
  assert.equal(initial.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(initial.payload.data, {
    projectId: PROJECT_ID,
    hidePrompts: false,
    hideModelParameters: false,
    revision: 0,
    updatedBy: null,
    updatedAt: null,
  });

  const invalidBodies = [
    [],
    { projectId: PROJECT_ID, expectedRevision: 0, hidePrompts: true },
    {
      projectId: PROJECT_ID,
      expectedRevision: 0,
      hidePrompts: true,
      hideModelParameters: true,
      unsupported: true,
    },
    {
      projectId: PROJECT_ID,
      expectedRevision: '0',
      hidePrompts: true,
      hideModelParameters: true,
    },
    {
      projectId: PROJECT_ID,
      expectedRevision: 0,
      hidePrompts: 1,
      hideModelParameters: true,
    },
  ];
  for (const body of invalidBodies) {
    const invalid = await managementPut(fixture, body);
    assert.equal(invalid.response.status, 400, JSON.stringify(invalid.payload));
    assert.equal(invalid.payload.code, 'collaboration_review_visibility_policy_invalid');
  }

  const updated = await managementPut(fixture, {
    projectId: PROJECT_ID,
    expectedRevision: 0,
    hidePrompts: true,
    hideModelParameters: true,
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.response.headers.get('cache-control'), 'no-store');
  assert.equal(updated.payload.data.revision, 1);
  assert.equal(updated.payload.data.hidePrompts, true);
  assert.equal(updated.payload.data.hideModelParameters, true);
  assert.equal(updated.payload.data.updatedBy, TEST_MANAGEMENT_AUTHORITY.actorId);

  const stale = await managementPut(fixture, {
    projectId: PROJECT_ID,
    expectedRevision: 0,
    hidePrompts: false,
    hideModelParameters: false,
  });
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
  assert.equal(stale.payload.code, 'collaboration_review_visibility_policy_conflict');
  assert.equal(stale.payload.data.current.revision, 1);
  assert.equal(stale.payload.data.current.hidePrompts, true);
  assert.equal(stale.payload.data.current.hideModelParameters, true);

  const current = await requestJson(
    `${fixture.managementBase}/review-visibility-policy?projectId=${encodeURIComponent(PROJECT_ID)}`,
  );
  assert.equal(current.response.status, 200, JSON.stringify(current.payload));
  assert.equal(current.payload.data.revision, 1);
  assert.equal(current.payload.data.hidePrompts, true);
  assert.equal(current.payload.data.hideModelParameters, true);
  assert.equal(
    fixture.database.listAuditEvents({
      projectId: PROJECT_ID,
      action: 'review.visibility-policy.update',
      limit: 100,
    }).length,
    1,
    'a rejected stale CAS must not append a policy audit event',
  );
});

test('F6 reviewer/viewer are redacted across canvas, sync, Agent, subflow, text, and WebSocket while editor/owner remain visible', async (t) => {
  const fixture = await createVisibilityFixture(t);
  const reviewer = await redeemActor(fixture, 'reviewer', 'F6 visibility reviewer');
  const viewer = await redeemActor(fixture, 'viewer', 'F6 visibility viewer');
  const editor = await redeemActor(fixture, 'editor', 'F6 visibility editor');
  const policy = await managementPut(fixture, {
    projectId: PROJECT_ID,
    expectedRevision: 0,
    hidePrompts: true,
    hideModelParameters: true,
  });
  assert.equal(policy.response.status, 200, JSON.stringify(policy.payload));

  for (const actor of [reviewer, viewer]) {
    const canvas = await publicGet(fixture, actor, `/api/collab/canvases/${CANVAS_ID}`);
    assertHiddenPayload(canvas, `${actor.role} canvas`);
    assertReviewerCanvasNodeShape(canvas, `${actor.role} canvas`);
    assertHiddenPayload(
      await publicGet(fixture, actor, `/api/collab/canvases/${CANVAS_ID}/sync?afterRevision=0`),
      `${actor.role} sync`,
    );
    assertHiddenPayload(
      await inspectRun(fixture, actor),
      `${actor.role} Agent inspectRun`,
    );
    assertHiddenPayload(
      await publicGet(fixture, actor, `/api/collab/subflows/${SUBFLOW_ID}/1`),
      `${actor.role} subflow`,
    );
    for (const field of [
      'prompt',
      'model',
      'aspectRatio',
      'sizeLevel',
      'guidanceScale',
      'providerParams',
      ...Object.keys(DIRECT_MODEL_PARAMETER_VALUES).filter((field) => field !== 'maxCompletionTokens'),
    ]) {
      const hiddenText = await publicGet(
        fixture,
        actor,
        `/api/collab/canvases/${CANVAS_ID}/text?targetType=node&targetEntityUid=${NODE_UID}&field=${field}`,
      );
      assert.equal(hiddenText.response.status, 403, JSON.stringify(hiddenText.payload));
      assert.equal(hiddenText.payload.code, 'collaboration_review_visibility_hidden');
      assert.doesNotMatch(hiddenText.text, new RegExp(PROMPT_SECRET));
      assert.doesNotMatch(hiddenText.text, new RegExp(MODEL_SECRET));
    }
  }

  const editorCanvas = await publicGet(fixture, editor, `/api/collab/canvases/${CANVAS_ID}`);
  assertVisiblePayload(editorCanvas, 'editor canvas', [
    PROMPT_SECRET,
    MODEL_SECRET,
    PROVIDER_SECRET,
    ...PUBLIC_CANVAS_MODEL_PARAMETER_SECRETS,
  ]);
  assertEditorCanvasNodeShape(editorCanvas, 'editor canvas');
  assertVisiblePayload(
    await publicGet(fixture, editor, `/api/collab/canvases/${CANVAS_ID}/sync?afterRevision=0`),
    'editor sync',
    [PROMPT_SECRET, MODEL_SECRET, PROVIDER_SECRET, ...PUBLIC_CANVAS_MODEL_PARAMETER_SECRETS],
  );
  assertVisiblePayload(
    await inspectRun(fixture, editor),
    'editor Agent inspectRun',
    [MODEL_SECRET, PROVIDER_SECRET],
  );
  assertVisiblePayload(
    await publicGet(fixture, editor, `/api/collab/subflows/${SUBFLOW_ID}/1`),
    'editor subflow',
    [PROMPT_SECRET, MODEL_SECRET, PROVIDER_SECRET, ...PUBLIC_CANVAS_MODEL_PARAMETER_SECRETS],
  );
  const editorText = await publicGet(
    fixture,
    editor,
    `/api/collab/canvases/${CANVAS_ID}/text?targetType=node&targetEntityUid=${NODE_UID}&field=prompt`,
  );
  assert.equal(editorText.response.status, 200, JSON.stringify(editorText.payload));
  assert.equal(editorText.payload.data.materializedText, PROMPT_SECRET);

  const ownerValue = { prompt: PROMPT_SECRET, model: MODEL_SECRET, provider: PROVIDER_SECRET };
  assert.deepEqual(
    fixture.gateway.publicReviewVisibleValue({ role: 'owner', projectId: PROJECT_ID }, ownerValue),
    ownerValue,
    'owner authority must never inherit reviewer visibility redaction',
  );

  const nodePatchVisible = fixture.gateway.publicReviewVisibleValue({
    role: 'reviewer',
    projectId: PROJECT_ID,
  }, {
    type: 'node.patch',
    payload: {
      nodeUid: NODE_UID,
      fields: {
        data: {
          ...DIRECT_MODEL_PARAMETER_VALUES,
          request: EXPLICIT_MODEL_PARAMETER_VALUES,
          ...VISIBLE_OUTPUT_FIELDS,
          outputMetadata: VISIBLE_OUTPUT_METADATA,
        },
      },
    },
  });
  const nodePatchData = nodePatchVisible.payload.fields.data;
  for (const field of Object.keys(DIRECT_MODEL_PARAMETER_VALUES)) {
    assert.equal(nodePatchData[field], '[由主机隐藏]', `node.patch ${field} leaked`);
  }
  for (const field of Object.keys(EXPLICIT_MODEL_PARAMETER_VALUES)) {
    assert.equal(nodePatchData.request[field], '[由主机隐藏]', `node.patch request.${field} leaked`);
  }
  for (const [field, value] of Object.entries(VISIBLE_OUTPUT_FIELDS)) {
    assert.equal(nodePatchData[field], value, `node.patch output ${field} was damaged`);
  }
  assert.deepEqual(nodePatchData.outputMetadata, VISIBLE_OUTPUT_METADATA);

  const largeNodeCount = 25_100;
  const largeCanvas = {
    canvasId: 'f6-review-large-shape',
    nodes: Array.from({ length: largeNodeCount }, (_, index) => ({
      id: `large-node-${index}`,
      type: 'text',
      data: index === largeNodeCount - 1
        ? {
            visibleTitle: 'large canvas tail remains intact',
            model: MODEL_SECRET,
            maxTokens: DIRECT_MODEL_PARAMETER_VALUES.maxTokens,
            outputMetadata: VISIBLE_OUTPUT_METADATA,
          }
        : { visibleTitle: `large-node-${index}` },
    })),
  };
  const largeVisible = fixture.gateway.publicReviewVisibleValue({
    role: 'reviewer',
    projectId: PROJECT_ID,
  }, largeCanvas);
  assert.equal(largeVisible.nodes.length, largeNodeCount);
  const largeTail = largeVisible.nodes[largeVisible.nodes.length - 1];
  assert.equal(largeTail.data.visibleTitle, 'large canvas tail remains intact');
  assert.equal(largeTail.data.model, '[由主机隐藏]');
  assert.equal(largeTail.data.maxTokens, '[由主机隐藏]');
  assert.deepEqual(largeTail.data.outputMetadata, VISIBLE_OUTPUT_METADATA);
  assert.doesNotMatch(
    JSON.stringify(largeVisible),
    /\[truncated\]/,
    'review redaction must not silently truncate a canvas accepted by the public sanitizer',
  );

  const reviewerSocket = await openSocketProbe(fixture, reviewer, { label: 'F6 reviewer visibility WS' });
  const viewerSocket = await openSocketProbe(fixture, viewer, { label: 'F6 viewer visibility WS' });
  const editorSocket = await openSocketProbe(fixture, editor, { label: 'F6 editor visibility WS' });
  const revision = fixture.database.getCanvas(CANVAS_ID).revision;
  await Promise.all([
    joinSocket(reviewerSocket, CANVAS_ID, revision),
    joinSocket(viewerSocket, CANVAS_ID, revision),
    joinSocket(editorSocket, CANVAS_ID, revision),
  ]);
  fixture.gateway.broadcast(PROJECT_ID, CANVAS_ID, {
    type: 'review.visibility-probe',
    prompt: PROMPT_SECRET,
    model: MODEL_SECRET,
    provider: PROVIDER_SECRET,
    request: {
      duration: DURATION_SECRET,
      guidanceScale: GUIDANCE_SECRET,
      ...DIRECT_MODEL_PARAMETER_VALUES,
    },
    outputMetadata: VISIBLE_OUTPUT_METADATA,
    mediaUrl: VISIBLE_OUTPUT_FIELDS.mediaUrl,
    thumbnailUrl: VISIBLE_OUTPUT_FIELDS.thumbnailUrl,
    modelPreviewUrl: VISIBLE_OUTPUT_FIELDS.modelPreviewUrl,
  });
  const [reviewerMessage, viewerMessage, editorMessage] = await Promise.all([
    reviewerSocket.nextMessage(
      (message) => message.type === 'review.visibility-probe',
      'reviewer visibility probe timed out',
    ),
    viewerSocket.nextMessage(
      (message) => message.type === 'review.visibility-probe',
      'viewer visibility probe timed out',
    ),
    editorSocket.nextMessage(
      (message) => message.type === 'review.visibility-probe',
      'editor visibility probe timed out',
    ),
  ]);
  for (const message of [reviewerMessage, viewerMessage]) {
    assert.equal(message.prompt, '[由主机隐藏]');
    assert.equal(message.model, '[由主机隐藏]');
    assert.equal(message.provider, '[由主机隐藏]');
    assert.equal(message.request.duration, '[由主机隐藏]');
    assert.equal(message.request.guidanceScale, '[由主机隐藏]');
    for (const field of Object.keys(DIRECT_MODEL_PARAMETER_VALUES)) {
      assert.equal(message.request[field], '[由主机隐藏]', `WebSocket request.${field} leaked`);
    }
    assert.deepEqual(message.outputMetadata, VISIBLE_OUTPUT_METADATA);
    assert.equal(message.mediaUrl, VISIBLE_OUTPUT_FIELDS.mediaUrl);
    assert.equal(message.thumbnailUrl, VISIBLE_OUTPUT_FIELDS.thumbnailUrl);
    assert.equal(message.modelPreviewUrl, VISIBLE_OUTPUT_FIELDS.modelPreviewUrl);
  }
  assert.equal(editorMessage.prompt, PROMPT_SECRET);
  assert.equal(editorMessage.model, MODEL_SECRET);
  assert.equal(editorMessage.provider, PROVIDER_SECRET);
  assert.equal(editorMessage.request.duration, DURATION_SECRET);
  assert.equal(editorMessage.request.guidanceScale, GUIDANCE_SECRET);
  for (const [field, value] of Object.entries(DIRECT_MODEL_PARAMETER_VALUES)) {
    assert.equal(editorMessage.request[field], value);
  }
  assert.deepEqual(editorMessage.outputMetadata, VISIBLE_OUTPUT_METADATA);
  assert.equal(editorMessage.mediaUrl, VISIBLE_OUTPUT_FIELDS.mediaUrl);
  assert.equal(editorMessage.thumbnailUrl, VISIBLE_OUTPUT_FIELDS.thumbnailUrl);
  assert.equal(editorMessage.modelPreviewUrl, VISIBLE_OUTPUT_FIELDS.modelPreviewUrl);
});

test('F6 common Review mutation and exact replay apply current reviewer visibility without redacting editor or owner', async (t) => {
  const fixture = await createVisibilityFixture(t);
  const reviewer = await redeemActor(fixture, 'reviewer', 'F6 common Review visibility reviewer');
  const editor = await redeemActor(fixture, 'editor', 'F6 common Review visibility editor');
  const policy = await managementPut(fixture, {
    projectId: PROJECT_ID,
    expectedRevision: 0,
    hidePrompts: true,
    hideModelParameters: true,
  });
  assert.equal(policy.response.status, 200, JSON.stringify(policy.payload));

  const baseRevision = fixture.database.getCanvas(CANVAS_ID).revision;
  const reviewerBatch = commonReviewCreateBatch(
    fixture,
    COMMON_REVIEW_IDENTITIES.reviewer,
    baseRevision,
  );
  const reviewerApplied = await postCommonReviewOperations(fixture, reviewer, reviewerBatch);
  assert.equal(reviewerApplied.payload?.data?.duplicate, false);
  assertHiddenPayload(reviewerApplied, 'reviewer common Review first mutation');

  const reviewerReplay = await postCommonReviewOperations(fixture, reviewer, reviewerBatch);
  assert.equal(reviewerReplay.payload?.data?.duplicate, true);
  assertHiddenPayload(reviewerReplay, 'reviewer common Review exact replay');

  const editorBatch = commonReviewCreateBatch(
    fixture,
    COMMON_REVIEW_IDENTITIES.editor,
    baseRevision,
  );
  const editorApplied = await postCommonReviewOperations(fixture, editor, editorBatch);
  assert.equal(editorApplied.payload?.data?.duplicate, false);
  assertVisiblePayload(
    editorApplied,
    'editor common Review mutation',
    [PROMPT_SECRET, MODEL_SECRET, PROVIDER_SECRET, ...PUBLIC_CANVAS_MODEL_PARAMETER_SECRETS],
  );

  const ownerValue = {
    prompt: PROMPT_SECRET,
    model: MODEL_SECRET,
    request: { duration: DURATION_SECRET, guidanceScale: GUIDANCE_SECRET },
  };
  assert.strictEqual(
    fixture.gateway.publicReviewVisibleValue(
      { role: 'owner', projectId: PROJECT_ID },
      ownerValue,
    ),
    ownerValue,
    'owner common Review response values must remain untouched by reviewer visibility policy',
  );
});
