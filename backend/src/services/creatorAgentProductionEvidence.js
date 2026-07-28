const {
  CreatorAgentSessionError,
} = require('./creatorAgentSessions');
const {
  canvasPatchRequestDigest,
} = require('./canvasPatch');

const PRODUCTION_PHASES = Object.freeze([
  'idea',
  'script',
  'assets',
  'shots',
  'candidates',
  'delivery',
]);

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, limit = 240) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function unique(values, limit = 128) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => text(value, 160))
    .filter(Boolean))].slice(0, limit);
}

function creatorSessionPlanById(session, rawPlanId) {
  const planId = text(rawPlanId, 160);
  if (!planId) return null;
  if (text(session?.latestPlan?.planId, 160) === planId) return session.latestPlan;
  for (const event of [...(Array.isArray(session?.events) ? session.events : [])].reverse()) {
    const plan = event?.type === 'assistant.plan' ? event.payload?.plan : null;
    if (text(plan?.planId, 160) === planId) return plan;
  }
  return null;
}

function replayCreatorCanvasPlanStates(session) {
  const states = new Map();
  for (const event of Array.isArray(session?.events) ? session.events : []) {
    const planId = text(event?.payload?.planId, 160);
    if (!planId) continue;
    if (event.type === 'plan.applied') {
      states.set(planId, { status: 'applied', payload: event.payload });
    } else if (event.type === 'plan.reverted') {
      states.set(planId, { status: 'reverted', payload: event.payload });
    }
  }
  return states;
}

function operationNodeIds(operation) {
  const payload = record(operation?.payload);
  return unique([
    payload.nodeId,
    payload.node?.id,
    payload.source,
    payload.target,
    payload.edge?.source,
    payload.edge?.target,
  ], 16);
}

function creatorPlanAffectedNodeIds(session, plan) {
  const targetIds = unique([
    ...(Array.isArray(plan?.targets?.affectedNodeIds) ? plan.targets.affectedNodeIds : []),
    plan?.targets?.primaryNodeId,
    plan?.targets?.storyNodeId,
  ]);
  const latestPatch = text(session?.latestPlan?.planId, 160) === text(plan?.planId, 160)
    ? session?.latestPatch
    : null;
  const patchIds = (Array.isArray(latestPatch?.operations) ? latestPatch.operations : [])
    .flatMap(operationNodeIds);
  return unique([...targetIds, ...patchIds]);
}

function storyProjectForNode(node) {
  const data = record(node?.data);
  const project = record(data.storyProject);
  return project.schema === 't8-story-project-v1' ? project : null;
}

function storyEvidence(document, affectedNodeIds, plan) {
  const nodes = Array.isArray(document?.nodes) ? document.nodes : [];
  const affected = new Set(affectedNodeIds);
  let candidates = nodes.filter((node) => (
    String(node?.type || '') === 'story' && affected.has(String(node?.id || ''))
  ));
  if (!candidates.length && plan?.targets?.storyNodeId) {
    candidates = nodes.filter((node) => (
      String(node?.type || '') === 'story'
      && String(node?.id || '') === String(plan.targets.storyNodeId)
    ));
  }
  if (!candidates.length && /^story\./.test(text(plan?.action, 80))) {
    const allStories = nodes.filter((node) => String(node?.type || '') === 'story');
    if (allStories.length === 1) candidates = allStories;
  }
  const snapshots = candidates.map((node) => {
    const project = storyProjectForNode(node);
    if (!project) return null;
    const shots = Array.isArray(project.shots) ? project.shots : [];
    const assets = Array.isArray(project.assets) ? project.assets : [];
    const readyAssets = assets.filter((asset) => (
      String(asset?.status || '') === 'succeeded' && text(asset?.url, 2_000)
    ));
    const compiledShots = shots.filter((shot) => text(shot?.finalPrompt, 24_000));
    const videoShots = shots.filter((shot) => (
      String(shot?.status || '') === 'succeeded' && text(shot?.videoUrl, 2_000)
    ));
    const scriptReady = text(project.script, 200_000).length > 0;
    const shotsReady = shots.length > 0 && project.coverage?.ready === true;
    const assetsReady = shotsReady && readyAssets.length === assets.length;
    const promptsReady = shotsReady && compiledShots.length === shots.length;
    const videosReady = shotsReady && videoShots.length === shots.length;
    return {
      nodeId: text(node?.id, 160),
      storyId: text(project.storyId, 160),
      stage: text(project.stage, 40) || 'script',
      storyRevision: Math.max(0, Math.trunc(Number(project.storyRevision) || 0)),
      productionRevision: Math.max(0, Math.trunc(Number(project.productionRevision) || 0)),
      scriptReady,
      shotsReady,
      assets: {
        ready: assetsReady,
        completed: readyAssets.length,
        total: assets.length,
      },
      prompts: {
        ready: promptsReady,
        completed: compiledShots.length,
        total: shots.length,
      },
      videos: {
        ready: videosReady,
        completed: videoShots.length,
        total: shots.length,
      },
      finalVideoReady: Boolean(text(project.finalVideoUrl, 2_000)),
    };
  }).filter(Boolean);
  if (!snapshots.length) {
    return {
      verified: false,
      nodeIds: [],
      scriptReady: false,
      assetsReady: false,
      promptsReady: false,
      videosReady: false,
      finalVideoReady: false,
      snapshots: [],
    };
  }
  return {
    verified: true,
    nodeIds: snapshots.map((item) => item.nodeId),
    scriptReady: snapshots.every((item) => item.scriptReady && item.shotsReady),
    assetsReady: snapshots.every((item) => item.assets.ready),
    promptsReady: snapshots.every((item) => item.prompts.ready),
    videosReady: snapshots.every((item) => item.videos.ready),
    finalVideoReady: snapshots.every((item) => item.finalVideoReady),
    snapshots,
  };
}

function candidateEvidence(document, affectedNodeIds) {
  const affected = new Set(affectedNodeIds);
  const nodes = (Array.isArray(document?.nodes) ? document.nodes : [])
    .filter((node) => affected.has(String(node?.id || '')));
  const acceptedNodeIds = [];
  const reviewedNodeIds = [];
  for (const node of nodes) {
    const data = record(node?.data);
    const state = record(data.creativeState);
    const review = record(data.creativeReview);
    if (review.schema === 't8-creative-review-v1'
      && review.source === 'visual-inspection'
      && Object.keys(record(review.dimensions)).length > 0) {
      reviewedNodeIds.push(text(node?.id, 160));
    }
    if (state.schema === 't8-creative-state-v1' && state.accepted === true) {
      acceptedNodeIds.push(text(node?.id, 160));
    }
  }
  return {
    acceptedNodeIds: unique(acceptedNodeIds),
    reviewedNodeIds: unique(reviewedNodeIds),
    acceptedAndReviewed: acceptedNodeIds.some((nodeId) => reviewedNodeIds.includes(nodeId)),
  };
}

function fallbackPhaseForAction(action, kind) {
  if (action === 'create.script' || kind === 'script') return 'script';
  if (action === 'create.story' || action === 'story.analyze' || action === 'story.import'
    || action === 'story.bind-asset') return 'assets';
  if (action === 'story.compile' || action === 'director.materialize') return 'shots';
  if (action === 'story.plan-previews' || action === 'story.adopt-preview'
    || action === 'video-edit.compose' || ['review', 'accept', 'lock', 'unlock', 'branch', 'rollback'].includes(action)
    || ['image', 'edit-image', 'video', 'edit-video', 'audio'].includes(kind)) return 'candidates';
  return 'idea';
}

function buildCreatorProductionEvidence(database, session, plan, scope, lifecycleType, appliedRevision) {
  const action = text(plan?.action, 80) || (plan?.kind ? `create.${text(plan.kind, 40)}` : '');
  const kind = text(plan?.kind, 40);
  const affectedNodeIds = creatorPlanAffectedNodeIds(session, plan);
  const document = typeof database?.getCanvas === 'function'
    ? database.getCanvas(scope.canvasId)
    : null;
  const documentRevision = Number(document?.revision);
  const documentVerified = Boolean(
    document
    && String(document.projectId || '') === scope.projectId
    && String(document.canvasId || '') === scope.canvasId
    && Number.isSafeInteger(documentRevision)
    && documentRevision >= Number(appliedRevision),
  );
  const story = documentVerified
    ? storyEvidence(document, affectedNodeIds, plan)
    : storyEvidence(null, [], plan);
  const candidates = documentVerified
    ? candidateEvidence(document, affectedNodeIds)
    : { acceptedNodeIds: [], reviewedNodeIds: [], acceptedAndReviewed: false };
  const completed = new Set();
  if (plan?.ready !== false && action !== 'plan-card') completed.add('idea');
  if (story.verified) {
    if (story.scriptReady) completed.add('script');
    if (story.assetsReady) completed.add('assets');
    if (story.promptsReady) completed.add('shots');
    if (story.videosReady && candidates.acceptedAndReviewed) completed.add('candidates');
  }
  if (lifecycleType !== 'plan.reverted' && action === 'accept' && candidates.acceptedAndReviewed) {
    completed.add('candidates');
  }
  let currentPhase = fallbackPhaseForAction(action, kind);
  if (story.verified) {
    currentPhase = !story.scriptReady
      ? 'script'
      : !story.assetsReady
        ? 'assets'
        : !story.promptsReady
          ? 'shots'
          : 'candidates';
  }
  return {
    schema: 't8-creator-production-evidence-v1',
    source: 'canonical-canvas-evidence',
    verified: true,
    authoritative: story.verified,
    lifecycleType,
    action,
    kind,
    currentPhase,
    completedPhases: PRODUCTION_PHASES.filter((phase) => completed.has(phase)),
    affectedNodeIds,
    canvasRevision: Number.isSafeInteger(documentRevision) ? documentRevision : null,
    documentVerified,
    story,
    candidates,
  };
}

function canonicalCreatorCanvasLifecycle(database, session, scope, type, rawPayload = {}) {
  const planId = text(rawPayload?.planId, 160);
  const planDigest = text(rawPayload?.planDigest, 160);
  const patchId = text(rawPayload?.patchId, 160);
  const plan = creatorSessionPlanById(session, planId);
  if (!plan
    || String(plan.projectId || '') !== scope.projectId
    || String(plan.canvasId || '') !== scope.canvasId) {
    throw new CreatorAgentSessionError(
      'CREATOR_PLAN_EVIDENCE_INVALID',
      '找不到属于当前项目和画布的创作计划，已停止记录画布变更',
      409,
    );
  }
  if (!planDigest || planDigest !== String(plan.planDigest || '')) {
    throw new CreatorAgentSessionError(
      'CREATOR_PLAN_DIGEST_MISMATCH',
      '创作计划摘要与当前会话不一致，请刷新后重新预览',
      409,
    );
  }
  const expectedPatchId = text(
    plan.patchId
    || (text(session?.latestPlan?.planId, 160) === planId ? session?.latestPatch?.id : ''),
    160,
  );
  if (!patchId || !expectedPatchId || patchId !== expectedPatchId) {
    throw new CreatorAgentSessionError(
      'CREATOR_PATCH_ID_MISMATCH',
      '画布 Patch 与这条创作计划不一致，已停止记录',
      409,
    );
  }
  if (typeof database?.listCanvasPatches !== 'function') {
    throw new CreatorAgentSessionError(
      'CREATOR_PATCH_LEDGER_UNAVAILABLE',
      '画布 Patch 台账当前不可用，无法确认这次变更是否真实完成',
      503,
    );
  }
  const latestPatch = text(session?.latestPlan?.planId, 160) === planId
    && text(session?.latestPatch?.id, 160) === patchId
    ? session.latestPatch
    : null;
  let expectedRequestDigest = '';
  if (latestPatch) {
    try {
      expectedRequestDigest = canvasPatchRequestDigest(latestPatch);
    } catch (_) {
      throw new CreatorAgentSessionError(
        'CREATOR_PATCH_EVIDENCE_INVALID',
        '当前创作计划的画布 Patch 已损坏，请刷新后重新生成计划',
        409,
      );
    }
  }
  const patch = (database.listCanvasPatches(scope.canvasId, {
    projectId: scope.projectId,
    actorId: scope.actorId,
    includeAllActors: Boolean(expectedRequestDigest),
    includeRequestDigest: Boolean(expectedRequestDigest),
    limit: 100,
  }) || []).find((item) => String(item?.patchId || '') === patchId);
  const patchActorId = String(patch?.actorId || '');
  const crossActor = Boolean(patch) && patchActorId !== scope.actorId;
  if (!patch || (crossActor && (
    !expectedRequestDigest || String(patch.requestDigest || '') !== expectedRequestDigest
  ))) {
    throw new CreatorAgentSessionError(
      'CREATOR_PATCH_EVIDENCE_NOT_FOUND',
      '没有在画布 Patch 台账中找到这次变更，已停止记录',
      409,
    );
  }
  const expectedStatus = type === 'plan.reverted' ? 'reverted' : 'applied';
  if (String(patch.status || '') !== expectedStatus) {
    throw new CreatorAgentSessionError(
      'CREATOR_PATCH_STATUS_MISMATCH',
      expectedStatus === 'reverted' ? '画布服务尚未确认撤回成功' : '画布服务尚未确认应用成功',
      409,
    );
  }
  const appliedRevision = Number(patch.appliedRevision);
  if (!Number.isSafeInteger(appliedRevision) || appliedRevision < 0
    || Number(rawPayload?.appliedRevision) !== appliedRevision) {
    throw new CreatorAgentSessionError(
      'CREATOR_PATCH_REVISION_MISMATCH',
      '画布 revision 与 Patch 台账不一致，请刷新后重试',
      409,
    );
  }
  const normalized = {
    schema: 't8-creator-canvas-lifecycle-v1',
    planId,
    planDigest,
    patchId,
    previewDigest: /^[a-f0-9]{64}$/i.test(String(rawPayload?.previewDigest || ''))
      ? String(rawPayload.previewDigest).toLowerCase()
      : '',
    appliedRevision,
    duplicate: rawPayload?.duplicate === true,
    canvasEvidence: {
      source: 'canvas-patch-ledger',
      status: expectedStatus,
      actorId: patchActorId,
      operationCount: Math.max(0, Number(patch.operationCount) || 0),
    },
  };
  if (type === 'plan.reverted') {
    const revertedRevision = Number(patch.revertedRevision);
    if (!Number.isSafeInteger(revertedRevision) || revertedRevision < appliedRevision
      || Number(rawPayload?.revertedRevision) !== revertedRevision) {
      throw new CreatorAgentSessionError(
        'CREATOR_PATCH_REVERT_REVISION_MISMATCH',
        '撤回后的画布 revision 与 Patch 台账不一致，请刷新后重试',
        409,
      );
    }
    normalized.revertedRevision = revertedRevision;
  }
  normalized.productionEvidence = buildCreatorProductionEvidence(
    database,
    session,
    plan,
    scope,
    type,
    type === 'plan.reverted' ? normalized.revertedRevision : normalized.appliedRevision,
  );
  return normalized;
}

module.exports = {
  buildCreatorProductionEvidence,
  canonicalCreatorCanvasLifecycle,
  creatorPlanAffectedNodeIds,
  creatorSessionPlanById,
  replayCreatorCanvasPlanStates,
};
