'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createAgentControlAuthService } = require('../backend/src/services/agentControlAuth.js');
const { createAgentControlApprovalService } = require('../backend/src/services/agentControlApprovals.js');
const agentControlRoute = require('../backend/src/routes/agentControl.js');

function request(server, options = {}, body = null) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      method: options.method || 'GET',
      path: options.path || '/',
      headers: {
        Host: '127.0.0.1:19021',
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: text ? JSON.parse(text) : null,
      }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function issueSession(auth, scopes, name) {
  const pairing = auth.createPairing({
    clientName: name,
    agentKind: 'codex',
    requestedScopes: scopes,
  });
  auth.approvePairing({
    pairingId: pairing.pairingId,
    userCode: pairing.userCode,
    approvedScopes: scopes,
  });
  return auth.pollPairing({
    pairingId: pairing.pairingId,
    pollSecret: pairing.pollSecret,
  });
}

test('creator route plans with zero side effects and applies one approved workflow exactly once', async (t) => {
  const auth = createAgentControlAuthService();
  const approvals = createAgentControlApprovalService();
  const document = {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: 'project-local',
    canvasId: 'canvas-creative',
    revision: 20,
    nodes: [{
      id: 'node-text-reference',
      type: 'text',
      data: {
        label: '创意方向',
        prompt: 'private node prompt must never enter the plan response',
      },
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  let previewCalls = 0;
  let applyCalls = 0;
  let providerCalls = 0;
  let runtimeBlocked = false;
  const modelCatalogSecret = 'agent-control-route-private-key';
  const database = {
    getCanvas: (canvasId) => canvasId === document.canvasId ? structuredClone(document) : null,
    previewCanvasPatch: (_canvasId, patch, context) => {
      previewCalls += 1;
      assert.equal(patch.baseRevision, document.revision);
      assert.equal(context.authority.source, 'agent');
      return {
        patchId: patch.id,
        summary: patch.summary,
        baseRevision: document.revision,
        currentRevision: document.revision,
        previewDigest: 'c'.repeat(64),
        affectedNodeIds: patch.operations
          .filter((operation) => operation.type.startsWith('node.'))
          .map((operation) => operation.payload.nodeId || operation.payload.node?.id),
        affectedEdgeIds: patch.operations
          .filter((operation) => operation.type.startsWith('edge.'))
          .map((operation) => operation.payload.edgeId || operation.payload.edge?.id),
        changes: patch.operations.map((operation, index) => ({
          operationIndex: index,
          type: operation.type,
          targetType: operation.type.startsWith('node.') ? 'node' : 'edge',
          targetId: operation.payload.nodeId || operation.payload.node?.id
            || operation.payload.edgeId || operation.payload.edge?.id,
          fields: [],
        })),
        warnings: [],
      };
    },
    applyCanvasPatch: (_canvasId, patch, context) => {
      applyCalls += 1;
      assert.equal(context.previewDigest, 'c'.repeat(64));
      assert.equal(context.confirmed, true);
      assert.equal(context.allowExactDuplicateAcrossActors, true);
      patch.operations.forEach((operation) => {
        if (operation.type === 'node.add') document.nodes.push(structuredClone(operation.payload.node));
        if (operation.type === 'edge.add') document.edges.push(structuredClone(operation.payload.edge));
      });
      const baseRevision = document.revision;
      document.revision += 1;
      return {
        patchId: patch.id,
        status: 'applied',
        duplicate: false,
        baseRevision,
        revision: document.revision,
        acknowledgements: patch.operations.map((operation, index) => ({
          opId: operation.opId || `creative-op-${index + 1}`,
          revision: document.revision,
        })),
        document: structuredClone(document),
      };
    },
    listCanvasPatches: () => [],
    getAsset: (assetId) => {
      if (assetId === 'asset-reference-image') return {
          id: assetId,
          projectId: document.projectId,
          kind: 'image',
          filename: '不能进入提示词的私有文件名.png',
          mimeType: 'image/png',
          sizeBytes: 8192,
          contentHash: 'a'.repeat(64),
          contentRevision: 4,
          sourceLocator: 'D:\\private\\reference.png',
        };
      if (assetId === 'asset-reference-video') return {
        id: assetId,
        projectId: document.projectId,
        kind: 'video',
        filename: '不能进入提示词的私有视频名.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 65536,
        contentHash: 'b'.repeat(64),
        contentRevision: 7,
        availability: 'available',
        metadata: { width: 1920, height: 1080, durationSec: 12.5 },
        sourceLocator: 'D:\\private\\reference.mp4',
      };
      return null;
    },
  };

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/agent-control/v1', agentControlRoute.createAgentControlRouter({
    auth,
    approvals,
    config: {
      PORT: 19021,
      APP_VERSION: '2.6.4',
      BACKEND_INSTANCE_ID: 'b'.repeat(43),
      SETTINGS_FILE: '',
    },
    database,
    assetService: {
      inspect(assetId, projectId) {
        const asset = database.getAsset(assetId);
        if (!asset || asset.projectId !== projectId) throw new Error('fixture asset missing');
        return structuredClone(asset);
      },
    },
    settingsProvider: () => [],
    credentialSettingsProvider: () => ({ zhenzhenSd2ApiKey: modelCatalogSecret }),
    runtimeStatusProvider: () => runtimeBlocked ? { regionReady: false } : {},
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const reader = issueSession(auth, ['canvas:read'], 'Codex read-only');
  const writer = issueSession(auth, ['canvas:read', 'canvas:write'], 'Codex creator');
  const readerHeaders = { Authorization: `Bearer ${reader.accessToken}` };
  const writerHeaders = { Authorization: `Bearer ${writer.accessToken}` };
  const modelCatalog = await request(server, {
    path: `/api/agent-control/v1/models?projectId=${document.projectId}&canvasId=${document.canvasId}`,
    headers: readerHeaders,
  });
  assert.equal(modelCatalog.status, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(modelCatalog.body), 'utf8') < 256 * 1024);
  const seedanceModel = modelCatalog.body.data.items.find((item) => item.provider === 'seedance-nz');
  const zhenzhenModel = modelCatalog.body.data.items.find((item) => item.provider === 'zhenzhen');
  const seedanceAction = modelCatalog.body.data.actions.find((item) => item.provider === 'seedance-nz');
  const seedanceImageModel = modelCatalog.body.data.items
    .find((item) => item.kind === 'image' && item.provider === 'seedance-nz');
  const zhenzhenImageModel = modelCatalog.body.data.items
    .find((item) => item.kind === 'image' && item.provider === 'zhenzhen');
  assert.ok(seedanceModel);
  assert.ok(zhenzhenModel);
  assert.ok(seedanceAction);
  assert.ok(seedanceImageModel);
  assert.ok(zhenzhenImageModel);
  assert.equal(seedanceModel.readiness.executable, true);
  assert.equal(zhenzhenModel.readiness.executable, false);
  assert.equal(seedanceAction.readiness.credentialReady, true);
  assert.ok(modelCatalog.body.data.readinessSummary.models.executable > 0);
  assert.ok(modelCatalog.body.data.readinessSummary.actions.executable > 0);
  assert.equal(JSON.stringify(modelCatalog.body).includes(modelCatalogSecret), false);
  assert.match(modelCatalog.body.data.warning, /已知模型不等于当前可执行/);
  const missingStory = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-read',
    headers: readerHeaders,
  }, {
    projectId: document.projectId,
    canvasId: document.canvasId,
    action: 'story.inspect',
    input: { storyId: 'missing-story' },
  });
  assert.equal(missingStory.status, 404);
  assert.equal(missingStory.body.code, 'STORY_NODE_NOT_FOUND');
  assert.match(missingStory.body.message, /找不到目标 Story/);

  const input = {
    kind: 'image',
    prompt: '雨夜唐人街的电影角色设定',
    ratio: '16:9',
    profile: 'balanced',
    candidates: 3,
    template: 'character-sheet',
    imageProvider: 'seedance-nz',
    imageModel: seedanceImageModel.model,
  };

  const readOnlyPlan = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-plans',
    headers: readerHeaders,
  }, { projectId: document.projectId, canvasId: document.canvasId, input });
  assert.equal(readOnlyPlan.status, 200);
  assert.equal(readOnlyPlan.body.data.ready, true);
  assert.equal(readOnlyPlan.body.data.impact.writesNow, 0);
  assert.equal(readOnlyPlan.body.data.impact.providerCallsNow, 0);
  assert.equal(readOnlyPlan.body.data.modelDecisionReceipt.schema, 't8-model-decision-receipt-v1');
  assert.equal(readOnlyPlan.body.data.modelDecisionReceipt.mode, 'fixed');
  assert.equal(readOnlyPlan.body.data.modelDecisionReceipt.providerCalls, 0);
  assert.equal(readOnlyPlan.body.data.modelDecisionReceipt.canvasWrites, 0);
  assert.equal(readOnlyPlan.body.data.modelDecisionReceipt.decisions[0].selected.provider, 'seedance-nz');
  assert.equal(readOnlyPlan.body.data.modelDecisionReceipt.decisions[0].selected.model, seedanceImageModel.model);
  assert.equal(readOnlyPlan.body.data.modelDecisionReceipt.decisions[0].inputCompatibility.status, 'unverified');
  assert.ok(readOnlyPlan.body.data.modelDecisionReceipt.decisions[0].reasons.length >= 2);
  assert.equal(readOnlyPlan.body.data.modelDecisionReceipt.approvalBoundary.costTier.status, 'unknown');
  assert.equal(readOnlyPlan.body.data.modelDecisionReceipt.approvalBoundary.privacyBoundary.status, 'unknown');
  assert.equal(JSON.stringify(readOnlyPlan.body).includes(modelCatalogSecret), false);
  assert.equal(document.revision, 20);
  assert.equal(previewCalls, 0);
  assert.equal(applyCalls, 0);
  assert.equal(providerCalls, 0);

  const referencedPlan = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-plans',
    headers: readerHeaders,
  }, {
    projectId: document.projectId,
    canvasId: document.canvasId,
    input: {
      ...input,
      referencedNodeIds: ['node-text-reference'],
    },
  });
  assert.equal(referencedPlan.status, 200);
  assert.equal(referencedPlan.body.data.ready, true);
  assert.equal(JSON.stringify(referencedPlan.body).includes('private node prompt'), false);

  const missingReferencePlan = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-plans',
    headers: readerHeaders,
  }, {
    projectId: document.projectId,
    canvasId: document.canvasId,
    input: {
      ...input,
      referencedNodeIds: ['node-deleted'],
    },
  });
  assert.equal(missingReferencePlan.status, 409);
  assert.equal(missingReferencePlan.body.code, 'CREATOR_REFERENCE_NODE_NOT_FOUND');

  const missingActionReferencePlan = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-plans',
    headers: readerHeaders,
  }, {
    projectId: document.projectId,
    canvasId: document.canvasId,
    action: 'graph.node-add',
    input: {
      type: 'text',
      referencedNodeIds: ['node-deleted'],
    },
  });
  assert.equal(missingActionReferencePlan.status, 409);
  assert.equal(missingActionReferencePlan.body.code, 'CREATOR_REFERENCE_NODE_NOT_FOUND');

  const attachmentOnlyPlan = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-plans',
    headers: readerHeaders,
  }, {
    projectId: document.projectId,
    canvasId: document.canvasId,
    input: {
      assetIds: ['asset-reference-image'],
      imageProvider: 'seedance-nz',
      imageModel: seedanceImageModel.model,
    },
  });
  assert.equal(attachmentOnlyPlan.status, 200, JSON.stringify(attachmentOnlyPlan.body));
  assert.equal(attachmentOnlyPlan.body.data.kind, 'edit-image');
  assert.equal(
    attachmentOnlyPlan.body.data.brief.goal,
    '请分析我上传的1 张图片,先说明可直接使用的内容和缺失信息,再给出 3 个可执行的创作下一步;不要自动生成或修改画布。',
  );
  assert.deepEqual(attachmentOnlyPlan.body.data.brief.reuseAssetIds, ['asset-reference-image']);
  assert.equal(JSON.stringify(attachmentOnlyPlan.body).includes('私有文件名'), false);
  assert.equal(JSON.stringify(attachmentOnlyPlan.body).includes('D:\\private'), false);
  assert.equal(document.revision, 20);
  assert.equal(previewCalls, 0);
  assert.equal(applyCalls, 0);
  assert.equal(providerCalls, 0);

  const authoritativeVideoAttachmentPlan = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-plans',
    headers: readerHeaders,
  }, {
    projectId: document.projectId,
    canvasId: document.canvasId,
    input: {
      kind: 'story',
      recipe: 'shot-breakdown',
      prompt: '分析这段参考视频并整理镜头结构',
      attachments: [{
        assetId: 'asset-reference-video',
        kind: 'image',
        mimeType: 'image/png',
        size: 1,
        contentHash: 'f'.repeat(64),
        contentRevision: 1,
      }],
    },
  });
  assert.equal(authoritativeVideoAttachmentPlan.status, 200, JSON.stringify(authoritativeVideoAttachmentPlan.body));
  const attachmentDecision = authoritativeVideoAttachmentPlan.body.data.modelDecisionReceipt.decisions[0];
  assert.deepEqual(attachmentDecision.inputCompatibility.request.attachmentKinds, ['video']);
  assert.equal(
    authoritativeVideoAttachmentPlan.body.data.modelDecisionReceipt.attachmentEvidenceDigest.length,
    64,
  );
  assert.equal(JSON.stringify(authoritativeVideoAttachmentPlan.body).includes('D:\\private'), false);

  const blockedFixedPlan = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-plans',
    headers: readerHeaders,
  }, {
    projectId: document.projectId,
    canvasId: document.canvasId,
    input: {
      ...input,
      imageProvider: 'zhenzhen',
      imageModel: zhenzhenImageModel.model,
    },
  });
  assert.equal(blockedFixedPlan.status, 409);
  assert.equal(blockedFixedPlan.body.code, 'CREATOR_MODEL_RUNTIME_NOT_READY');
  assert.equal(blockedFixedPlan.body.details.modelKind, 'image');
  assert.equal(blockedFixedPlan.body.details.silentFallback, false);
  assert.match(blockedFixedPlan.body.message, /没有自动切换平台或模型/);
  assert.equal(previewCalls, 0);
  assert.equal(applyCalls, 0);
  assert.equal(providerCalls, 0);

  const oneLineStory = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-plans',
    headers: readerHeaders,
  }, {
    projectId: document.projectId,
    canvasId: document.canvasId,
    input: {
      kind: 'story',
      prompt: '把这段剧本做成 30 秒竖屏短片：雨夜后巷，萌萌听见警笛后走出电梯。',
    },
  });
  assert.equal(oneLineStory.status, 200);
  assert.equal(oneLineStory.body.data.brief.durationSec, 30);
  assert.equal(oneLineStory.body.data.brief.ratio, '9:16');
  assert.equal(oneLineStory.body.data.visibleAssumptions.editableByNaturalLanguage, true);
  assert.equal(oneLineStory.body.data.analysis.source, 'local-fallback');
  assert.ok(oneLineStory.body.data.analysis.shotCount >= 1);
  assert.ok(oneLineStory.body.data.analysis.assetCount >= 1);
  assert.match(oneLineStory.body.data.targets.storyNodeId, /^story-node-/);
  assert.equal(oneLineStory.body.data.modelDecisionReceipt.schema, 't8-model-decision-receipt-v1');
  assert.equal(oneLineStory.body.data.modelDecisionReceipt.decisions.length, 4);
  assert.equal(oneLineStory.body.data.modelDecisionReceipt.providerCalls, 0);
  assert.equal(oneLineStory.body.data.modelDecisionReceipt.canvasWrites, 0);
  assert.equal(previewCalls, 0);
  assert.equal(applyCalls, 0);
  assert.equal(providerCalls, 0);

  const writerPlan = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-plans',
    headers: writerHeaders,
  }, { projectId: document.projectId, canvasId: document.canvasId, input });
  const approval = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-approvals',
    headers: writerHeaders,
  }, {
    projectId: document.projectId,
    canvasId: document.canvasId,
    planId: writerPlan.body.data.planId,
  });
  assert.equal(approval.status, 202);
  assert.equal(approval.body.data.action, 'creative.apply');
  assert.equal(approval.body.data.approvalBinding.schema, 't8-agent-control-approval-binding-v1');
  assert.equal(approval.body.data.approvalBinding.planDigest, writerPlan.body.data.planDigest);
  assert.equal(approval.body.data.approvalBinding.modelDecisionDigest, writerPlan.body.data.modelDecisionReceipt.receiptDigest);
  assert.equal(approval.body.data.approvalBinding.boundary.costTier.status, 'unknown');
  assert.equal(approval.body.data.approvalBinding.boundary.privacyBoundary.status, 'unknown');
  assert.deepEqual(
    approval.body.data.approvalBinding.boundary.providerSelections,
    writerPlan.body.data.modelDecisionReceipt.approvalBoundary.providerSelections,
  );
  assert.deepEqual(
    approval.body.data.approvalBinding.boundary.costTier,
    writerPlan.body.data.modelDecisionReceipt.approvalBoundary.costTier,
  );
  assert.deepEqual(approval.body.data.approvalBinding.boundary.privacyBoundary, writerPlan.body.data.modelDecisionReceipt.approvalBoundary.privacyBoundary);
  assert.equal(approval.body.data.preview.providerTransfer.occursNow, false);
  assert.equal('cost' in approval.body.data.preview, false);
  assert.equal(approval.body.data.preview.creator.candidateCount, 3);
  assert.equal(previewCalls, 1);
  assert.equal(applyCalls, 0);
  assert.equal(providerCalls, 0);

  const replacementPlan = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-plans',
    headers: writerHeaders,
  }, {
    projectId: document.projectId,
    canvasId: document.canvasId,
    input: {
      ...input,
      prompt: '雨夜唐人街角色设定，改为红色霓虹与正面三视图',
    },
  });
  assert.equal(replacementPlan.status, 200);
  assert.notEqual(replacementPlan.body.data.planDigest, writerPlan.body.data.planDigest);
  assert.notEqual(
    replacementPlan.body.data.approvalBinding.bindingDigest,
    approval.body.data.approvalBinding.bindingDigest,
  );
  const staleCompletion = await request(server, {
    method: 'POST',
    path: `/api/agent-control/v1/approvals/${approval.body.data.approvalRequestId}/complete`,
    headers: writerHeaders,
  }, { pollSecret: approval.body.data.pollSecret });
  assert.equal(staleCompletion.status, 409);
  assert.equal(staleCompletion.body.code, 'APPROVAL_STALE');
  assert.match(staleCompletion.body.message, /计划、模型或平台已经更新/);
  assert.equal(applyCalls, 0);
  assert.equal(providerCalls, 0);

  const runtimeStaleApproval = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-approvals',
    headers: writerHeaders,
  }, {
    projectId: document.projectId,
    canvasId: document.canvasId,
    planId: replacementPlan.body.data.planId,
  });
  assert.equal(runtimeStaleApproval.status, 202);
  approvals.approve(runtimeStaleApproval.body.data.approvalRequestId);
  runtimeBlocked = true;
  const runtimeStaleCompletion = await request(server, {
    method: 'POST',
    path: `/api/agent-control/v1/approvals/${runtimeStaleApproval.body.data.approvalRequestId}/complete`,
    headers: writerHeaders,
  }, { pollSecret: runtimeStaleApproval.body.data.pollSecret });
  runtimeBlocked = false;
  assert.equal(runtimeStaleCompletion.status, 409);
  assert.equal(runtimeStaleCompletion.body.code, 'APPROVAL_STALE');
  assert.match(runtimeStaleCompletion.body.message, /凭据、组件或线路状态已变化/);
  assert.equal(applyCalls, 0);
  assert.equal(providerCalls, 0);

  const activeApproval = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-approvals',
    headers: writerHeaders,
  }, {
    projectId: document.projectId,
    canvasId: document.canvasId,
    planId: replacementPlan.body.data.planId,
  });
  assert.equal(activeApproval.status, 202);
  assert.equal(activeApproval.body.data.approvalBinding.planDigest, replacementPlan.body.data.planDigest);
  assert.equal(activeApproval.body.data.idempotent, false);
  assert.equal(previewCalls, 3);

  const approvalRequest = {
    method: 'POST',
    path: '/api/agent-control/v1/creative-approvals',
    headers: writerHeaders,
  };
  const approvalBody = {
    projectId: document.projectId,
    canvasId: document.canvasId,
    planId: replacementPlan.body.data.planId,
  };
  const concurrentRetries = await Promise.all([
    request(server, approvalRequest, approvalBody),
    request(server, approvalRequest, approvalBody),
  ]);
  concurrentRetries.forEach((retry) => {
    assert.equal(retry.status, 202);
    assert.equal(retry.body.data.approvalRequestId, activeApproval.body.data.approvalRequestId);
    assert.equal(retry.body.data.pollSecret, activeApproval.body.data.pollSecret);
    assert.equal(retry.body.data.idempotent, true);
  });
  assert.equal(approvals.listPending().length, 1);
  assert.equal(previewCalls, 5);
  assert.equal(applyCalls, 0);
  assert.equal(providerCalls, 0);

  const pending = await request(server, {
    method: 'POST',
    path: `/api/agent-control/v1/approvals/${activeApproval.body.data.approvalRequestId}/complete`,
    headers: writerHeaders,
  }, { pollSecret: activeApproval.body.data.pollSecret });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.data.status, 'pending');
  assert.equal(applyCalls, 0);

  approvals.approve(activeApproval.body.data.approvalRequestId);
  const completed = await request(server, {
    method: 'POST',
    path: `/api/agent-control/v1/approvals/${activeApproval.body.data.approvalRequestId}/complete`,
    headers: writerHeaders,
  }, { pollSecret: activeApproval.body.data.pollSecret });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.data.action, 'creative.apply');
  assert.equal(completed.body.data.revision, 21);
  assert.equal(applyCalls, 1);
  assert.equal(providerCalls, 0);
  assert.equal(document.nodes.filter((node) => node.type === 'image').length, 3);

  const duplicate = await request(server, {
    method: 'POST',
    path: `/api/agent-control/v1/approvals/${activeApproval.body.data.approvalRequestId}/complete`,
    headers: writerHeaders,
  }, { pollSecret: activeApproval.body.data.pollSecret });
  assert.equal(duplicate.status, 404);
  assert.equal(duplicate.body.code, 'APPROVAL_NOT_FOUND');
  assert.equal(applyCalls, 1);
  assert.equal(providerCalls, 0);

  const graphNodePlan = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-plans',
    headers: writerHeaders,
  }, {
    projectId: document.projectId,
    canvasId: document.canvasId,
    action: 'graph.node-add',
    input: { type: 'loop', x: 1320, y: 80 },
  });
  assert.equal(graphNodePlan.status, 200);
  assert.equal(graphNodePlan.body.data.ready, true);
  assert.equal(graphNodePlan.body.data.action, 'graph.node-add');
  assert.deepEqual(graphNodePlan.body.data.targets.proposedNodes.map((item) => item.type), ['loop']);
  assert.equal(applyCalls, 1);
  assert.equal(providerCalls, 0);

  const graphNodeApproval = await request(server, {
    method: 'POST',
    path: '/api/agent-control/v1/creative-approvals',
    headers: writerHeaders,
  }, {
    projectId: document.projectId,
    canvasId: document.canvasId,
    planId: graphNodePlan.body.data.planId,
  });
  assert.equal(graphNodeApproval.status, 202);
  approvals.approve(graphNodeApproval.body.data.approvalRequestId);
  const graphNodeCompleted = await request(server, {
    method: 'POST',
    path: `/api/agent-control/v1/approvals/${graphNodeApproval.body.data.approvalRequestId}/complete`,
    headers: writerHeaders,
  }, { pollSecret: graphNodeApproval.body.data.pollSecret });
  assert.equal(graphNodeCompleted.status, 200);
  assert.equal(graphNodeCompleted.body.data.revision, 22);
  assert.equal(applyCalls, 2);
  assert.equal(providerCalls, 0);
  assert.equal(document.nodes.filter((node) => node.type === 'loop').length, 1);
  assert.deepEqual(document.nodes.find((node) => node.type === 'loop').position, { x: 1320, y: 80 });
});
