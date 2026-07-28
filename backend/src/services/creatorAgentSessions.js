const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  CREATOR_AGENT_READINESS_SCHEMA,
  CREATOR_AGENT_LOCAL_PLAN_TARGET_MS,
} = require('./creatorAgentReadiness');
const {
  readCreativeCapabilityGraph,
  readCreativeCapabilityManifest,
} = require('./agentControlCapabilities');

const CREATOR_AGENT_SESSION_SCHEMA = 't8-creator-agent-session-v1';
const CREATOR_AGENT_EVENT_SCHEMA = 't8-creator-agent-event-v1';
const CREATOR_AGENT_MAX_EVENTS = 1_000;
const CREATOR_AGENT_EVENT_TAIL_BYTES = 4 * 1024 * 1024;
const CREATOR_AGENT_MAX_ATTACHMENTS = 16;
const CREATOR_AGENT_MAX_PATCH_BYTES = 2 * 1024 * 1024;
const CREATOR_AGENT_MAX_RESPONSE_CHUNKS = 8;
const CREATOR_REFERENCE_PRODUCTION_MAX_SHOTS = 240;

const CREATOR_PRODUCTION_STATE_SCHEMA = 't8-creator-production-state-v1';
const CREATOR_PRODUCTION_PHASES = ['idea', 'script', 'assets', 'shots', 'candidates', 'delivery'];
const CREATOR_PRODUCTION_MAX_HISTORY = 80;
const CREATOR_PRODUCTION_DOCUMENT_CONFIRMATION_SCHEMA = 't8-creator-production-document-confirmation-v1';
const CREATOR_PRODUCTION_DOCUMENT_CONFIRMATION_LIMIT = 200;

class CreatorAgentSessionError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'CreatorAgentSessionError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.details = details;
  }
}

function boundedText(value, maximum = 8_000) {
  return String(value == null ? '' : value).trim().slice(0, maximum);
}

function creatorStableString(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(creatorStableString).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${creatorStableString(value[key])}`
  )).join(',')}}`;
}

function creatorDigest(value) {
  return crypto.createHash('sha256').update(creatorStableString(value)).digest('hex');
}
function normalizeProductionDocumentConfirmations(value) {
  return (Array.isArray(value) ? value : []).slice(-CREATOR_PRODUCTION_DOCUMENT_CONFIRMATION_LIMIT)
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const contentDigest = boundedText(item.contentDigest, 64).toLowerCase();
      const confirmationDigest = boundedText(item.confirmationDigest, 64).toLowerCase();
      const confirmationId = boundedText(item.confirmationId, 80);
      const documentId = boundedText(item.documentId, 160);
      const versionId = boundedText(item.versionId, 160);
      const kind = boundedText(item.kind, 80);
      const revision = Math.max(1, Math.trunc(Number(item.revision) || 0));
      if (item.schema !== CREATOR_PRODUCTION_DOCUMENT_CONFIRMATION_SCHEMA
        || !confirmationId || !documentId || !versionId || !kind
        || !/^[a-f0-9]{64}$/.test(contentDigest)
        || !/^[a-f0-9]{64}$/.test(confirmationDigest)) return null;
      const normalized = {
        schema: CREATOR_PRODUCTION_DOCUMENT_CONFIRMATION_SCHEMA,
        confirmationId,
        documentId,
        kind,
        revision,
        versionId,
        contentDigest,
        sourcePlanId: boundedText(item.sourcePlanId, 160),
        sourcePlanDigest: boundedText(item.sourcePlanDigest, 64).toLowerCase(),
        actor: boundedText(item.actor, 40) || 'canvas-ui',
        confirmedAt: boundedText(item.confirmedAt, 80),
      };
      if (creatorDigest(normalized) !== confirmationDigest) return null;
      return { ...normalized, confirmationDigest };
    })
    .filter(Boolean);
}

function productionDocumentConfirmationFor(session, document) {
  return (session.productionDocumentConfirmations || []).find((item) => (
    item.documentId === String(document?.id || '')
    && item.versionId === String(document?.versionId || '')
    && item.contentDigest === String(document?.contentDigest || '')
  )) || null;
}


function creatorRunEventText(value, maximum = 500) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value.message || value.error || value.reason || value.code || ''
    : value;
  return boundedText(source, maximum)
    .replace(/https?:\/\/\S+/gi, '[远程地址已隐藏]')
    .replace(/\b(?:bearer|token|api[_-]?key|sk-)[=: _-]*[A-Za-z0-9._-]{8,}\b/gi, '[凭据已隐藏]');
}

function normalizeCreatorRunEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourceEventId = Number(value.id);
  const runId = boundedText(value.runId, 160);
  const eventType = boundedText(value.type, 80);
  if (!Number.isSafeInteger(sourceEventId) || sourceEventId < 1 || !runId || !eventType) return null;
  const raw = value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)
    ? value.payload
    : {};
  const videoOperation = raw.videoOperation && typeof raw.videoOperation === 'object'
    && !Array.isArray(raw.videoOperation) ? raw.videoOperation : {};
  const progressValue = raw.progress ?? raw.percent ?? videoOperation.progress;
  const progress = Number.isFinite(Number(progressValue))
    ? Math.max(0, Math.min(100, Math.round(Number(progressValue))))
    : null;
  const phase = boundedText(raw.phase || videoOperation.phase, 80);
  const status = boundedText(raw.status || videoOperation.status, 40);
  const message = creatorRunEventText(raw.message || videoOperation.message, 500);
  const error = creatorRunEventText(raw.error || videoOperation.error, 500);
  const terminalSignal = /(?:completed|succeeded|failed|stopped|interrupted|terminal|error)/i
    .test(`${eventType} ${phase} ${status}`);
  const visible = /^(?:run|node)\./.test(eventType)
    || progress != null
    || terminalSignal;
  return {
    visible,
    progressBucket: progress == null ? null : Math.floor(progress / 10) * 10,
    payload: {
      schema: 't8-creator-run-event-v1',
      sourceEventId,
      sourceEntityUid: boundedText(value.entityUid, 160) || null,
      runId,
      nodeRunId: boundedText(value.nodeRunId, 160) || null,
      eventType,
      phase: phase || null,
      status: status || null,
      progress,
      message: message || null,
      error: error || null,
      code: boundedText(raw.code || videoOperation.errorCode, 80) || null,
      attemptId: boundedText(raw.attemptId || videoOperation.attemptId, 160) || null,
      nodeId: boundedText(raw.nodeId, 160) || null,
      outputCount: Array.isArray(raw.outputRefs)
        ? Math.min(10_000, raw.outputRefs.length)
        : Math.max(0, Math.min(10_000, Number(raw.outputCount) || 0)),
      recoverable: raw.recoverable === true,
      sourceCreatedAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : null,
    },
  };
}

function creatorAttachmentKind(value) {
  const normalized = boundedText(value, 24).toLowerCase();
  return ['image', 'video', 'audio', 'text', 'file'].includes(normalized) ? normalized : 'file';
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, CREATOR_AGENT_MAX_ATTACHMENTS).map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CreatorAgentSessionError('CREATOR_ATTACHMENT_INVALID', `第 ${index + 1} 个附件无效`);
    }
    const ref = boundedText(entry.ref || entry.url, 2_000);
    if (!ref || /^data:/i.test(ref)) {
      throw new CreatorAgentSessionError(
        'CREATOR_ATTACHMENT_REF_REQUIRED',
        '附件必须先持久化为文件引用，不能把 base64 正文写入会话',
      );
    }
    const assetId = boundedText(entry.assetId, 160);
    return {
      id: boundedText(entry.id, 120) || crypto.randomUUID(),
      ...(assetId ? { assetId } : {}),
      kind: creatorAttachmentKind(entry.kind),
      name: boundedText(entry.name, 240) || `附件 ${index + 1}`,
      ref,
      mimeType: boundedText(entry.mimeType, 120),
      size: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(entry.size) || 0)),
      ...(boundedText(entry.contentHash, 128)
        ? { contentHash: boundedText(entry.contentHash, 128).toLowerCase().replace(/^sha256:/, '') }
        : {}),
      ...(Number(entry.contentRevision) > 0
        ? { contentRevision: Math.max(1, Math.trunc(Number(entry.contentRevision))) }
        : {}),
      ...(Number(entry.width) > 0 ? { width: Math.max(1, Math.trunc(Number(entry.width))) } : {}),
      ...(Number(entry.height) > 0 ? { height: Math.max(1, Math.trunc(Number(entry.height))) } : {}),
      ...(Number(entry.duration) > 0
        ? { duration: Math.max(0, Math.min(86_400, Number(entry.duration))) }
        : {}),
    };
  });
}

function creatorAttachmentSummary(attachments = []) {
  const counts = {
    image: 0,
    video: 0,
    audio: 0,
    text: 0,
    file: 0,
  };
  (Array.isArray(attachments) ? attachments : []).forEach((attachment) => {
    counts[creatorAttachmentKind(attachment?.kind)] += 1;
  });
  const labels = [
    counts.image ? `${counts.image} 张图片` : '',
    counts.video ? `${counts.video} 个视频` : '',
    counts.audio ? `${counts.audio} 段音频` : '',
    counts.text ? `${counts.text} 份文本` : '',
    counts.file ? `${counts.file} 个文件` : '',
  ].filter(Boolean);
  return labels.join('、');
}

function creatorAttachmentOnlyPrompt(attachments = []) {
  const summary = creatorAttachmentSummary(attachments);
  return summary
    ? `请分析我上传的${summary}，先说明可直接使用的内容和缺失信息，再给出 3 个可执行的创作下一步；不要自动生成或修改画布。`
    : '';
}

function normalizeStoredPatch(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== 't8-canvas-patch-v1'
    || !Array.isArray(value.operations)) {
    throw new CreatorAgentSessionError('CREATOR_PATCH_INVALID', '创作会话中的画布变更无效');
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new CreatorAgentSessionError('CREATOR_PATCH_INVALID', '创作会话中的画布变更无法保存');
  }
  if (Buffer.byteLength(serialized, 'utf8') > CREATOR_AGENT_MAX_PATCH_BYTES) {
    throw new CreatorAgentSessionError('CREATOR_PATCH_TOO_LARGE', '创作计划超过会话安全上限，请缩小本次变更范围', 413);
  }
  return JSON.parse(serialized);
}

function normalizeContext(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawNodeTypeCounts = input.nodeTypeCounts
    && typeof input.nodeTypeCounts === 'object'
    && !Array.isArray(input.nodeTypeCounts)
    ? input.nodeTypeCounts
    : {};
  const viewport = input.viewport
    && typeof input.viewport === 'object'
    && [input.viewport.x, input.viewport.y, input.viewport.zoom].every((item) => Number.isFinite(Number(item)))
    ? {
        x: Math.round(Number(input.viewport.x) * 100) / 100,
        y: Math.round(Number(input.viewport.y) * 100) / 100,
        zoom: Math.max(0.01, Math.min(8, Math.round(Number(input.viewport.zoom) * 1_000) / 1_000)),
      }
    : null;
  return {
    nodeCount: Math.max(0, Math.min(100_000, Number(input.nodeCount) || 0)),
    edgeCount: Math.max(0, Math.min(200_000, Number(input.edgeCount) || 0)),
    nodeTypeCounts: Object.fromEntries(Object.entries(rawNodeTypeCounts)
      .map(([type, count]) => [boundedText(type, 80), Math.max(0, Math.min(100_000, Number(count) || 0))])
      .filter(([type, count]) => type && count > 0)
      .slice(0, 64)),
    selectedNodeIds: Array.isArray(input.selectedNodeIds)
      ? [...new Set(input.selectedNodeIds.map((id) => boundedText(id, 160)).filter(Boolean))].slice(0, 32)
      : [],
    selectedNodeTypes: Array.isArray(input.selectedNodeTypes)
      ? [...new Set(input.selectedNodeTypes.map((type) => boundedText(type, 80)).filter(Boolean))].slice(0, 32)
      : [],
    referencedNodeIds: Array.isArray(input.referencedNodeIds)
      ? [...new Set(input.referencedNodeIds.map((id) => boundedText(id, 160)).filter(Boolean))].slice(0, 8)
      : [],
    referencedNodeTypes: Array.isArray(input.referencedNodeTypes)
      ? [...new Set(input.referencedNodeTypes.map((type) => boundedText(type, 80)).filter(Boolean))].slice(0, 8)
      : [],
    canvasTitle: boundedText(input.canvasTitle, 160),
    canvasRevision: input.canvasRevision != null
      && Number.isSafeInteger(Number(input.canvasRevision))
      && Number(input.canvasRevision) >= 0
      ? Number(input.canvasRevision)
      : null,
    phase: boundedText(input.phase, 80),
    viewport,
    failedRunCount: Math.max(0, Math.min(100, Number(input.failedRunCount) || 0)),
    outputAssetCount: Math.max(0, Math.min(10_000, Number(input.outputAssetCount) || 0)),
    canvasObjects: (Array.isArray(input.canvasObjects) ? input.canvasObjects : [])
      .slice(0, 24)
      .map((item) => ({
        nodeId: boundedText(item?.nodeId, 160),
        nodeType: boundedText(item?.nodeType, 80) || 'unknown',
        label: boundedText(item?.label, 120) || boundedText(item?.nodeType, 80) || '画布对象',
        status: ['idle', 'running', 'completed', 'failed'].includes(boundedText(item?.status, 32))
          ? boundedText(item?.status, 32)
          : 'idle',
        selected: item?.selected === true,
        inViewport: item?.inViewport !== false,
        mediaKinds: [...new Set((Array.isArray(item?.mediaKinds) ? item.mediaKinds : [])
          .map((kind) => boundedText(kind, 24))
          .filter((kind) => ['image', 'video', 'audio', 'text', 'model3d'].includes(kind)))]
          .slice(0, 5),
        resultCount: Math.max(0, Math.min(10_000, Number(item?.resultCount) || 0)),
        accepted: item?.accepted === true,
        lockKeys: [...new Set((Array.isArray(item?.lockKeys) ? item.lockKeys : [])
          .map((key) => boundedText(key, 48))
          .filter(Boolean))]
          .slice(0, 8),
        upstreamCount: Math.max(0, Math.min(10_000, Number(item?.upstreamCount) || 0)),
        downstreamCount: Math.max(0, Math.min(10_000, Number(item?.downstreamCount) || 0)),
      }))
      .filter((item) => item.nodeId),
    offscreenSummary: input.offscreenSummary
      && typeof input.offscreenSummary === 'object'
      && !Array.isArray(input.offscreenSummary)
      ? {
          nodeCount: Math.max(0, Math.min(100_000, Number(input.offscreenSummary.nodeCount) || 0)),
          failedCount: Math.max(0, Math.min(100_000, Number(input.offscreenSummary.failedCount) || 0)),
          outputCount: Math.max(0, Math.min(100_000, Number(input.offscreenSummary.outputCount) || 0)),
          lockedCount: Math.max(0, Math.min(100_000, Number(input.offscreenSummary.lockedCount) || 0)),
        }
      : {
          nodeCount: 0,
          failedCount: 0,
          outputCount: 0,
          lockedCount: 0,
        },
    recentActions: (Array.isArray(input.recentActions) ? input.recentActions : [])
      .slice(0, 8)
      .map((item) => ({
        eventType: boundedText(item?.eventType, 80),
        label: boundedText(item?.label, 120),
        createdAt: boundedText(item?.createdAt, 80),
      }))
      .filter((item) => item.eventType && item.label),
    assetLineage: (Array.isArray(input.assetLineage) ? input.assetLineage : [])
      .slice(0, 6)
      .map((item) => ({
        assetId: boundedText(item?.assetId, 160),
        kind: ['image', 'video', 'audio', 'text', 'model3d', 'other'].includes(boundedText(item?.kind, 24))
          ? boundedText(item?.kind, 24)
          : 'other',
        label: boundedText(item?.label, 120) || '持久素材',
        eventCount: Math.max(0, Math.min(10_000, Number(item?.eventCount) || 0)),
        relations: [...new Set((Array.isArray(item?.relations) ? item.relations : [])
          .map((value) => boundedText(value, 64))
          .filter(Boolean))]
          .slice(0, 8),
        parentAssetIds: [...new Set((Array.isArray(item?.parentAssetIds) ? item.parentAssetIds : [])
          .map((value) => boundedText(value, 160))
          .filter(Boolean))]
          .slice(0, 8),
        sourceNodeIds: [...new Set((Array.isArray(item?.sourceNodeIds) ? item.sourceNodeIds : [])
          .map((value) => boundedText(value, 160))
          .filter(Boolean))]
          .slice(0, 8),
        runIds: [...new Set((Array.isArray(item?.runIds) ? item.runIds : [])
          .map((value) => boundedText(value, 160))
          .filter(Boolean))]
          .slice(0, 8),
        nodeRunIds: [...new Set((Array.isArray(item?.nodeRunIds) ? item.nodeRunIds : [])
          .map((value) => boundedText(value, 160))
          .filter(Boolean))]
          .slice(0, 8),
        derivedOperations: [...new Set((Array.isArray(item?.derivedOperations) ? item.derivedOperations : [])
          .map((value) => boundedText(value, 80))
          .filter(Boolean))]
          .slice(0, 8),
        truncated: item?.truncated === true,
      }))
      .filter((item) => item.assetId),
    recentRuns: (Array.isArray(input.recentRuns) ? input.recentRuns : [])
      .slice(0, 8)
      .map((run) => ({
        runId: boundedText(run?.runId, 160),
        status: boundedText(run?.status, 40),
        nodeRunCount: Math.max(0, Math.min(10_000, Number(run?.nodeRunCount) || 0)),
        failedNodeCount: Math.max(0, Math.min(10_000, Number(run?.failedNodeCount) || 0)),
        outputAssetCount: Math.max(0, Math.min(10_000, Number(run?.outputAssetCount) || 0)),
      }))
      .filter((run) => run.runId && run.status),
  };
}

function creatorContextFocus(normalized) {
  const referencedObject = normalized.referencedNodeIds
    .map((nodeId) => normalized.canvasObjects.find((item) => item.nodeId === nodeId))
    .find(Boolean);
  const referencedFallback = normalized.referencedNodeIds[0]
    ? {
        label: normalized.referencedNodeTypes[0] || normalized.referencedNodeIds[0],
        nodeId: normalized.referencedNodeIds[0],
        nodeType: normalized.referencedNodeTypes[0] || 'unknown',
        accepted: false,
        lockKeys: [],
      }
    : null;
  if (referencedObject || referencedFallback) {
    return {
      source: 'reference',
      object: referencedObject || referencedFallback,
    };
  }
  const selectedObject = normalized.canvasObjects.find((item) => item.selected);
  if (selectedObject) {
    return {
      source: 'selection',
      object: selectedObject,
    };
  }
  const viewportObject = normalized.canvasObjects.find((item) => item.inViewport);
  if (viewportObject) {
    return {
      source: 'viewport',
      object: viewportObject,
    };
  }
  return null;
}

function creatorFocusedSuggestionLabels(focus, normalized) {
  const selectedObject = focus.object;
  const protectedLabel = selectedObject.accepted || selectedObject.lockKeys.length > 0
    ? '，保持已采用和锁定部分不变'
    : '';
  const lineageLabel = normalized.assetLineage.length > 0
    ? `，沿用 ${normalized.assetLineage.length} 项已核对的真实素材来源`
    : '';
  return [
    `继续完善「${selectedObject.label}」${protectedLabel}${lineageLabel}`,
    `检查「${selectedObject.label}」与上下游对象是否连贯`,
    `只补「${selectedObject.label}」仍缺失的素材和步骤`,
  ];
}

function creatorSuggestionLabels(context = {}, plan = null) {
  const normalized = normalizeContext(context);
  const focus = creatorContextFocus(normalized);
  if (focus) return creatorFocusedSuggestionLabels(focus, normalized);
  if (normalized.failedRunCount > 0) {
    return [
      '先说明失败发生在哪一步，以及哪些成果已安全保留',
      '只规划失败范围的重试，不重复已成功任务',
      '沿用现有素材继续下一步，并列出仍缺什么',
    ];
  }
  if (plan?.kind === 'story' && plan?.brief?.recipe === 'shot-breakdown') {
    return [
      '只学习参考视频的节奏和剪辑密度',
      '只提取镜头语言、景别和运镜规则',
      '核对拉片结果后继续规划关键帧和视频，不立即生成',
    ];
  }
  const planPhase = phaseForPlan(plan, normalized.phase || 'idea');
  if ((plan?.kind === 'story' || plan?.kind === 'script') && planPhase === 'assets') {
    return [
      '核对角色、场景、道具和声音资产，保留已上传与已采用内容',
      '只规划缺失资产，不覆盖现有素材',
      '资产确认后进入可编辑分镜，不立即生成视频',
    ];
  }
  if ((plan?.kind === 'story' || plan?.kind === 'script') && planPhase === 'shots') {
    return [
      '逐镜头核对动作、运镜、时长和前后连续性',
      '把已确认镜头编译成可编辑提示词，不立即生成',
      '只修正资产和角色一致性冲突，保留确认镜头',
    ];
  }
  if ((plan?.kind === 'story' || plan?.kind === 'script') && planPhase === 'candidates') {
    return [
      '对照分镜比较已生成候选，先不自动采用',
      '采用满意候选并锁定角色、风格和镜头连续性',
      '只重试失败镜头，保留已完成视频和素材',
    ];
  }
  if (normalized.offscreenSummary.failedCount > 0) {
    return [
      `定位画布外 ${normalized.offscreenSummary.failedCount} 个异常对象并说明原因`,
      '只规划异常对象的修复，不改已经完成的画面',
      '把需要处理的对象移到当前视野并逐个确认',
    ];
  }
  if (plan?.kind === 'story' || plan?.kind === 'script') {
    return [
      '先确认角色、人设和整体视觉风格',
      '把故事拆成节奏清晰、可编辑的镜头',
      '只规划缺失资产，保留我已经上传的内容',
    ];
  }
  if (plan?.kind === 'image' || plan?.kind === 'edit-image') {
    return [
      '给我 3 个构图方向，先预览再决定',
      '保持主体不变，只优化光影、皮肤和质感',
      '把可编辑的图像工作流发送到画布',
    ];
  }
  if (plan?.kind === 'video' || plan?.kind === 'edit-video') {
    return [
      '先做镜头与节奏方案，不立即调用模型',
      '沿用现有素材，只补缺失镜头',
      '把视频生产链发送到画布并让我确认',
    ];
  }
  if (plan?.kind === 'audio') {
    return [
      '先规划旁白、对白和环境声的层次',
      '根据当前画面给我 3 种声音方向',
      '把音频工作流发送到画布并让我确认',
    ];
  }
  if (plan?.kind === 'delivery') {
    return [
      '核对交付清单和许可状态',
      '只打包已验证并已持久化的素材',
      '创建后立即校验整个交付包',
    ];
  }
  if (normalized.selectedNodeTypes.length > 0) {
    return [
      '继续完善我当前选中的内容',
      '检查前后镜头、角色和风格是否连贯',
      '只补当前作品缺失的素材和步骤',
    ];
  }
  if (normalized.nodeCount > 0) {
    return [
      '看懂当前画布并告诉我下一步最值得做什么',
      '把现有素材整理成一条完整创作流程',
      '找出缺失的镜头、角色或声音并先做计划',
    ];
  }
  return [
    '把一句创意变成一套可编辑的 Story',
    '帮我从剧本开始做角色、分镜和视频',
    '为一个产品做 30 秒竖屏广告',
  ];
}

function referenceBreakdownContinuationState(plan = null) {
  const document = (Array.isArray(plan?.productionDocuments) ? plan.productionDocuments : [])
    .find((item) => item?.kind === 'reference-breakdown');
  if (!document) {
    return {
      ready: false,
      code: 'reference-breakdown-result-missing',
      message: '还没有可继续生产的拉片结果；请先完成当前参考视频拉片',
    };
  }
  const content = document?.content && typeof document.content === 'object'
    && !Array.isArray(document.content) ? document.content : {};
  const contentDigest = boundedText(document?.contentDigest, 64).toLowerCase();
  if (document.schema !== 't8-creator-production-document-v1'
    || !/^[a-f0-9]{64}$/.test(contentDigest)
    || creatorDigest({ kind: 'reference-breakdown', content }) !== contentDigest) {
    return {
      ready: false,
      code: 'reference-breakdown-document-invalid',
      message: '当前拉片作品文档无法验证；请刷新会话后重新核对结果',
    };
  }
  if (content.status !== 'analysis-result-ready') {
    return {
      ready: false,
      code: 'reference-breakdown-result-pending',
      message: content.analysisError
        ? `拉片结果还不能继续生产：${boundedText(content.analysisError, 240)}`
        : '拉片结果尚未完成；请先运行并核对当前拉片节点',
    };
  }
  const evidence = content.resultEvidence && typeof content.resultEvidence === 'object'
    && !Array.isArray(content.resultEvidence) ? content.resultEvidence : {};
  if (evidence.runBindingStatus !== 'verified') {
    return {
      ready: false,
      code: 'reference-breakdown-run-evidence-required',
      message: boundedText(evidence.runEvidenceReason, 240)
        || '拉片结果尚未完成 Run / NodeRun / Attempt 核验，暂不能进入生产',
    };
  }
  const shots = Array.isArray(content.shots) ? content.shots : [];
  if (shots.length === 0 || shots.length > CREATOR_REFERENCE_PRODUCTION_MAX_SHOTS) {
    return {
      ready: false,
      code: shots.length === 0
        ? 'reference-breakdown-shots-missing'
        : 'reference-breakdown-shot-limit',
      message: shots.length === 0
        ? '拉片结果没有可用镜头，暂不能进入关键帧与视频规划'
        : `当前拉片包含 ${shots.length} 镜，超过单次生产规划上限 ${CREATOR_REFERENCE_PRODUCTION_MAX_SHOTS} 镜；请先拆分参考片段`,
    };
  }
  return { ready: true, code: '', message: '', document, content, evidence, shots };
}

function creatorCapabilityIds(options = {}) {
  if (Array.isArray(options.availableCapabilityIds)) {
    return new Set(options.availableCapabilityIds.map((value) => boundedText(value, 120)).filter(Boolean));
  }
  return new Set(readCreativeCapabilityManifest().capabilities.map((capability) => capability.id));
}

function creatorSuggestionExecution(item, capabilityById) {
  const operationPriority = ['plan', 'inspect', 'preview', 'verify'];
  const operationContracts = [];
  const blockers = [];
  for (const capabilityId of item.requiredCapabilityIds || []) {
    const capability = capabilityById.get(capabilityId);
    if (!capability) {
      blockers.push({
        code: 'capability-not-found',
        message: `当前版本没有找到“${capabilityId}”能力，请更新应用后重试`,
      });
      continue;
    }
    const safeOperations = (capability.operations || [])
      .filter((operation) => operation.riskLevel === 'L0' && operation.approvalRequired === false);
    const operation = operationPriority
      .map((name) => safeOperations.find((candidate) => candidate.operation === name))
      .find(Boolean) || safeOperations[0];
    if (!operation) {
      blockers.push({
        code: 'safe-operation-missing',
        message: `“${capability.creatorLabel || capabilityId}”目前没有可验证的只读操作，请先更新能力清单`,
      });
      continue;
    }
    operationContracts.push({
      capabilityId,
      operation: operation.operation,
      riskLevel: operation.riskLevel,
      approvalRequired: operation.approvalRequired,
      boundary: operation.boundary,
      requiredScopes: [...(operation.requiredScopes || [])],
    });
  }
  const executable = blockers.length === 0
    && operationContracts.length === (item.requiredCapabilityIds || []).length;
  return {
    ...item,
    executable,
    operationContracts,
    blockers,
    unblockActions: blockers.map((blocker) => blocker.message),
    disabledReason: executable ? '' : blockers[0]?.message || '当前建议暂时不能执行',
  };
}

function creatorSuggestionInvariantReceipt(suggestionSet) {
  const capabilityById = new Map(
    readCreativeCapabilityGraph().capabilities.map((capability) => [capability.id, capability]),
  );
  const graphCapabilityIds = new Set(capabilityById.keys());
  const items = Array.isArray(suggestionSet?.items) ? suggestionSet.items : [];
  const ids = items.map((item) => boundedText(item?.id, 160));
  const intents = items.map((item) => boundedText(item?.intent, 160));
  const requiredCapabilityIds = [...new Set(items.flatMap((item) => (
    Array.isArray(item?.requiredCapabilityIds) ? item.requiredCapabilityIds : []
  )).map((value) => boundedText(value, 160)).filter(Boolean))].sort();
  const invalidCapabilityIds = requiredCapabilityIds
    .filter((capabilityId) => !graphCapabilityIds.has(capabilityId));
  let invalidContractCount = 0;
  let fakeEnabledActionCount = 0;
  let unexplainedDisabledActionCount = 0;
  for (const item of items) {
    const rawRequired = (Array.isArray(item?.requiredCapabilityIds)
      ? item.requiredCapabilityIds : [])
      .map((value) => boundedText(value, 160))
      .filter(Boolean);
    const required = [...new Set(rawRequired)].sort();
    const contracts = Array.isArray(item?.operationContracts) ? item.operationContracts : [];
    const contractIds = contracts
      .map((contract) => boundedText(contract?.capabilityId, 160))
      .filter(Boolean)
      .sort();
    const contractInvalid = rawRequired.length !== required.length
      || required.length === 0
      || contracts.length !== required.length
      || required.some((capabilityId, index) => contractIds[index] !== capabilityId)
      || contracts.some((contract) => {
        const capabilityId = boundedText(contract?.capabilityId, 160);
        const operationName = boundedText(contract?.operation, 80);
        const authoritative = capabilityById.get(capabilityId)?.operations
          ?.find((operation) => operation.operation === operationName);
        const scopes = (Array.isArray(contract?.requiredScopes) ? contract.requiredScopes : [])
          .map((scope) => boundedText(scope, 160))
          .filter(Boolean);
        const authoritativeScopes = (Array.isArray(authoritative?.requiredScopes)
          ? authoritative.requiredScopes : [])
          .map((scope) => boundedText(scope, 160))
          .filter(Boolean);
        return !authoritative
          || contract?.riskLevel !== authoritative.riskLevel
          || contract?.approvalRequired !== authoritative.approvalRequired
          || boundedText(contract?.boundary, 160) !== boundedText(authoritative.boundary, 160)
          || scopes.length !== new Set(scopes).size
          || scopes.slice().sort().join('\u0000') !== authoritativeScopes.slice().sort().join('\u0000');
      });
    if (contractInvalid) invalidContractCount += 1;
    const blockers = Array.isArray(item?.blockers) ? item.blockers : [];
    const blockerMessages = blockers
      .map((blocker) => boundedText(blocker?.message, 1_000))
      .filter(Boolean);
    const unblockActions = (Array.isArray(item?.unblockActions) ? item.unblockActions : [])
      .map((action) => boundedText(action, 1_000))
      .filter(Boolean);
    const disabledReason = boundedText(item?.disabledReason, 1_000);
    if (item?.executable === true && (
      contractInvalid
      || blockers.length > 0
      || Boolean(disabledReason)
      || (Array.isArray(item?.unblockActions) && item.unblockActions.length > 0)
      || required.some((capabilityId) => !graphCapabilityIds.has(capabilityId))
    )) fakeEnabledActionCount += 1;
    if (item?.executable !== true
      && blockerMessages.length === 0
      && !disabledReason
      && unblockActions.length === 0) {
      unexplainedDisabledActionCount += 1;
    }
  }
  const digestValid = suggestionSet?.schema === 't8-creator-suggestion-set-v1'
    && /^[a-f0-9]{64}$/.test(boundedText(suggestionSet?.setDigest, 64).toLowerCase())
    && suggestionSet.setDigest === creatorDigest({
      schema: suggestionSet.schema,
      binding: suggestionSet.binding,
      items,
    });
  const problems = [
    ...(items.length === 3 ? [] : ['item-count']),
    ...(ids.every(Boolean) && new Set(ids).size === 3 ? [] : ['unique-id']),
    ...(intents.every(Boolean) && new Set(intents).size === 3 ? [] : ['unique-intent']),
    ...(invalidCapabilityIds.length === 0 ? [] : ['capability-id']),
    ...(invalidContractCount === 0 ? [] : ['operation-contract']),
    ...(fakeEnabledActionCount === 0 ? [] : ['fake-enabled-action']),
    ...(unexplainedDisabledActionCount === 0 ? [] : ['unexplained-disabled-action']),
    ...(digestValid ? [] : ['set-digest']),
  ];
  if (problems.length > 0) {
    throw new CreatorAgentSessionError(
      'CREATOR_SUGGESTION_INVARIANT_FAILED',
      '当前回复无法提供 3 条可核对建议，已停止展示不完整操作，请刷新会话后重试',
      503,
      {
        problems,
        itemCount: items.length,
        invalidCapabilityIds,
        invalidContractCount,
        fakeEnabledActionCount,
        unexplainedDisabledActionCount,
      },
    );
  }
  return {
    schema: 't8-creator-suggestion-invariant-receipt-v1',
    suggestionSetCount: 1,
    itemCount: 3,
    uniqueIdCount: 3,
    uniqueIntentCount: 3,
    capabilityIdCount: requiredCapabilityIds.length,
    invalidCapabilityIds: [],
    invalidContractCount: 0,
    fakeEnabledActionCount: 0,
    unexplainedDisabledActionCount: 0,
    setDigest: suggestionSet.setDigest,
  };
}

function validateCreatorSuggestionPersistence(session, events = session?.events) {
  const corrupt = (reason) => {
    throw new CreatorAgentSessionError(
      'CREATOR_SESSION_CORRUPT',
      '创作会话的建议回执损坏，已停止展示和执行建议；请新建会话后重试',
      500,
      { reason },
    );
  };
  const validateSet = (set, receipt, reasonPrefix) => {
    let expected;
    try {
      expected = creatorSuggestionInvariantReceipt(set);
    } catch {
      corrupt(`${reasonPrefix}-set-invalid`);
    }
    if (!set?.invariantReceipt
      || creatorStableString(set.invariantReceipt) !== creatorStableString(expected)
      || creatorStableString(receipt) !== creatorStableString(expected)) {
      corrupt(`${reasonPrefix}-receipt-mismatch`);
    }
  };
  if (session?.suggestionSet?.invariantReceipt?.schema
    === 't8-creator-suggestion-invariant-receipt-v1') {
    validateSet(session.suggestionSet, session.suggestionSet.invariantReceipt, 'session');
  }
  const completedByResponseId = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'assistant.response.completed') continue;
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    const isVersioned = payload.suggestionInvariantReceipt?.schema
      === 't8-creator-suggestion-invariant-receipt-v1'
      || payload.suggestionSet?.invariantReceipt?.schema
        === 't8-creator-suggestion-invariant-receipt-v1';
    if (!isVersioned) continue;
    const responseId = boundedText(payload.responseId, 160);
    if (!responseId || completedByResponseId.has(responseId)) {
      corrupt('completed-event-not-unique');
    }
    completedByResponseId.add(responseId);
    validateSet(payload.suggestionSet, payload.suggestionInvariantReceipt, 'completed-event');
  }
  return session;
}

function creatorSuggestionBinding(context = {}, plan = null) {
  const normalized = normalizeContext(context);
  const canvasObjects = [...normalized.canvasObjects]
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const assetLineage = [...normalized.assetLineage]
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  const recentRuns = [...normalized.recentRuns]
    .sort((left, right) => left.runId.localeCompare(right.runId));
  const contextDigest = creatorDigest({
    nodeCount: normalized.nodeCount,
    edgeCount: normalized.edgeCount,
    nodeTypeCounts: normalized.nodeTypeCounts,
    selectedNodeIds: [...normalized.selectedNodeIds].sort(),
    selectedNodeTypes: [...normalized.selectedNodeTypes].sort(),
    referencedNodeIds: [...normalized.referencedNodeIds].sort(),
    referencedNodeTypes: [...normalized.referencedNodeTypes].sort(),
    canvasTitle: normalized.canvasTitle,
    viewport: normalized.viewport,
    failedRunCount: normalized.failedRunCount,
    offscreenSummary: normalized.offscreenSummary,
    canvasObjects: canvasObjects.map((item) => ({
      nodeId: item.nodeId,
      nodeType: item.nodeType,
      label: item.label,
      status: item.status,
      selected: item.selected,
      inViewport: item.inViewport,
      upstreamCount: item.upstreamCount,
      downstreamCount: item.downstreamCount,
    })),
    recentRuns,
  });
  const assetVersion = creatorDigest({
    outputAssetCount: normalized.outputAssetCount,
    canvasObjects: canvasObjects.map((item) => ({
      nodeId: item.nodeId,
      mediaKinds: [...item.mediaKinds].sort(),
      resultCount: item.resultCount,
      accepted: item.accepted,
      lockKeys: [...item.lockKeys].sort(),
    })),
    assetLineage: assetLineage.map((item) => ({
      ...item,
      relations: [...item.relations].sort(),
      parentAssetIds: [...item.parentAssetIds].sort(),
      sourceNodeIds: [...item.sourceNodeIds].sort(),
      runIds: [...item.runIds].sort(),
      nodeRunIds: [...item.nodeRunIds].sort(),
      derivedOperations: [...item.derivedOperations].sort(),
    })),
  });
  return {
    schema: 't8-creator-suggestion-binding-v1',
    canvasRevision: normalized.canvasRevision,
    contextDigest,
    assetVersion,
    planDigest: boundedText(plan?.planDigest, 160) || null,
  };
}

function creatorSuggestionSet(context = {}, plan = null, options = {}) {
  const normalized = normalizeContext(context);
  const availableCapabilityIds = creatorCapabilityIds(options);
  const capabilityById = new Map(
    readCreativeCapabilityGraph().capabilities.map((capability) => [capability.id, capability]),
  );
  const labels = creatorSuggestionLabels(context, plan);
  const planPhase = phaseForPlan(plan, normalized.phase || 'idea');
  const storyGroup = planPhase === 'assets'
    ? 'story-assets'
    : planPhase === 'shots'
      ? 'story-shots'
      : planPhase === 'candidates'
        ? 'story-candidates'
        : 'story';
  const focus = creatorContextFocus(normalized);
  const group = focus
    ? 'selection'
    : normalized.failedRunCount > 0 || normalized.offscreenSummary.failedCount > 0
    ? 'recovery'
    : plan?.kind === 'story' && plan?.brief?.recipe === 'shot-breakdown'
      ? 'story-breakdown'
      : plan?.kind === 'story' || plan?.kind === 'script'
      ? storyGroup
      : plan?.kind === 'image' || plan?.kind === 'edit-image'
          ? 'image'
          : plan?.kind === 'video' || plan?.kind === 'edit-video'
            ? 'video'
            : plan?.kind === 'audio'
              ? 'audio'
              : plan?.kind === 'delivery'
                ? 'delivery'
                : normalized.nodeCount > 0
                  ? 'canvas'
                  : 'blank';
  const specs = {
    recovery: [
      ['recovery-explain', 'run.explain-failure', '只读核对真实 Run/NodeRun/Attempt，不启动重试', ['run.start', 'iterate.compare']],
      ['recovery-retry-scope', 'run.plan-failed-only', '只形成失败范围重试计划，保持成功任务与素材不变', ['run.start']],
      ['recovery-continue', 'run.continue-with-results', '盘点已持久化素材并规划安全的下一步', ['run.start', 'story.analyze']],
    ],
    story: [
      ['story-style', 'story.define-style', '补齐可编辑的角色与视觉约束，不启动生成', ['create.story', 'story.analyze']],
      ['story-shots', 'story.plan-shots', '形成可编辑镜头表和分镜预览计划', ['story.analyze', 'story.plan-previews']],
      ['story-missing-assets', 'story.plan-missing-assets', '列出缺失项并保护上传、采用和锁定素材', ['story.analyze', 'story.bind-asset']],
    ],
    'story-assets': [
      ['story-assets-review', 'story.review-assets', '只读核对角色、场景、道具和声音资产，不启动生成', ['story.analyze', 'story.bind-asset']],
      ['story-assets-missing', 'story.plan-missing-assets', '只列出缺失资产，明确保护上传、采用和锁定素材', ['story.analyze', 'story.bind-asset']],
      ['story-assets-to-shots', 'story.prepare-shots', '形成下一阶段的可编辑分镜计划，Provider 调用为 0', ['story.plan-previews']],
    ],
    'story-shots': [
      ['story-shots-review', 'story.review-shots', '逐镜头核对动作、运镜、时长、声音和连续性', ['story.plan-previews']],
      ['story-shots-compile', 'story.compile-prompts', '只编译已确认镜头，不调用图像或视频 Provider', ['story.compile']],
      ['story-shots-continuity', 'story.repair-continuity', '只规划资产和身份冲突的修正范围', ['story.analyze', 'story.bind-asset']],
    ],
    'story-breakdown': [
      ['reference-breakdown-rhythm', 'reference-breakdown.rhythm', '保留同一参考视频，只收窄节奏和剪辑密度分析，不启动媒体生成', ['video.extract-frames', 'story.analyze']],
      ['reference-breakdown-camera', 'reference-breakdown.camera-language', '保留同一参考视频，只收窄景别、运镜和构图规则分析', ['video.extract-frames', 'story.analyze']],
      ['reference-breakdown-continue', 'reference-breakdown.continue-production', '核对真实拉片结果后再规划关键帧与视频链，当前 Provider 调用为 0', ['create.story', 'story.analyze']],
    ],
    'story-candidates': [
      ['story-candidates-compare', 'story.compare-candidates', '只比较真实候选及其来源，不自动采用', ['iterate.compare']],
      ['story-candidates-accept', 'story.accept-and-lock', '采用前仍需明确确认，并锁定连续性约束', ['iterate.accept', 'iterate.lock']],
      ['story-candidates-retry', 'story.retry-failed-only', '只规划失败镜头重试，保留成功产物', ['run.start']],
    ],
    image: [
      ['image-directions', 'image.compare-directions', '建立三个可比较方向，不覆盖当前采用结果', ['create.image', 'iterate.compare']],
      ['image-refine', 'image.refine-unlocked', '只修改未锁定的画面质量维度', ['edit.image']],
      ['image-to-canvas', 'image.preview-canvas', '先展示 CanvasPatch，再等待明确确认', ['create.image', 'asset.place']],
    ],
    video: [
      ['video-rhythm', 'video.plan-rhythm', '形成镜头和节奏草案，Provider 调用为 0', ['create.video', 'story.plan-previews']],
      ['video-missing', 'video.plan-missing', '保护成功素材，只规划缺失或失败镜头', ['create.video', 'story.plan-previews']],
      ['video-to-canvas', 'video.preview-canvas', '先展示完整变更范围，再等待确认', ['create.video', 'asset.place']],
    ],
    audio: [
      ['audio-layers', 'audio.plan-layers', '生成可编辑声音分层计划', ['create.audio']],
      ['audio-directions', 'audio.compare-directions', '建立三个可比较声音方向', ['create.audio', 'iterate.compare']],
      ['audio-to-canvas', 'audio.preview-canvas', '先预览音频工作流变更', ['create.audio', 'asset.place']],
    ],
    delivery: [
      ['delivery-review', 'delivery.review-manifest', '只读核对精确素材、哈希、大小和许可状态', ['delivery.package']],
      ['delivery-verified-only', 'delivery.package-verified', '只打包通过本地文件与 SHA-256 校验的素材', ['delivery.package']],
      ['delivery-verify', 'delivery.verify-package', '创建后用固定摘要独立复核完整交付包', ['delivery.package']],
    ],
    selection: [
      ['selection-refine', 'selection.refine', '只围绕当前选区形成修改计划', ['edit.image', 'edit.video']],
      ['selection-review', 'selection.review-continuity', '只读检查连续性和锁定项', ['iterate.compare']],
      ['selection-missing', 'selection.plan-missing', '只规划缺失和失败范围', ['story.analyze']],
    ],
    canvas: [
      ['canvas-next', 'canvas.recommend-next', '只读分析当前生产状态', ['story.analyze']],
      ['canvas-organize', 'canvas.organize-production', '形成不覆盖现有素材的工作流计划', ['create.story']],
      ['canvas-gaps', 'canvas.inspect-gaps', '列出缺失项和受保护成果', ['story.analyze']],
    ],
    blank: [
      ['blank-story', 'create.story', '创建本地可编辑计划，当前不写画布', ['create.story']],
      ['blank-script', 'create.script-to-video', '先形成剧本和阶段计划', ['create.script', 'create.story']],
      ['blank-ad', 'create.product-ad', '建立产品广告的可编辑生产计划', ['create.story']],
    ],
  };
  const preferred = labels.map((label, index) => {
    const [id, intent, expectedEffect, requiredCapabilityIds] = specs[group][index];
    return {
      id,
      label,
      intent,
      arguments: {
        preserveAccepted: true,
        planOnly: true,
      },
      expectedEffect,
      riskLevel: 'L0-intent',
      requiredCapabilityIds,
      disabledReason: '',
    };
  });
  const safeBackfills = [
    {
      id: 'safe-clarify-story',
      label: '先把一句想法整理成可编辑创作目标',
      intent: 'safe.clarify-story',
      expectedEffect: '只整理目标、受众和限制，不写画布或调用模型',
      requiredCapabilityIds: ['create.story'],
    },
    {
      id: 'safe-review-canvas',
      label: '先检查当前画布，再告诉我最值得做的下一步',
      intent: 'safe.review-canvas',
      expectedEffect: '只读分析画布状态、缺失项和已保护成果',
      requiredCapabilityIds: ['story.analyze'],
    },
    {
      id: 'safe-compare-options',
      label: '先给我 3 个可比较方向，不立即生成',
      intent: 'safe.compare-options',
      expectedEffect: '只形成候选方向与取舍标准，不启动 Provider',
      requiredCapabilityIds: ['iterate.compare'],
    },
    {
      id: 'safe-script-outline',
      label: '先把需求整理成可修改的剧本提纲',
      intent: 'safe.script-outline',
      expectedEffect: '只形成剧本结构和待确认问题',
      requiredCapabilityIds: ['create.script'],
    },
  ].map((item) => ({
    ...item,
    arguments: { preserveAccepted: true, planOnly: true },
    riskLevel: 'L0-intent',
    disabledReason: '',
  }));
  const items = [...preferred, ...safeBackfills]
    .filter((item) => item.requiredCapabilityIds.every((id) => availableCapabilityIds.has(id)))
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, 3);
  if (items.length !== 3) {
    throw new CreatorAgentSessionError(
      'CREATOR_SUGGESTION_CAPABILITY_GAP',
      '当前创作能力清单不足以提供 3 个可靠建议，已停止展示不可执行入口，请更新应用后重试',
      503,
      { availableCapabilityIds: [...availableCapabilityIds].sort() },
    );
  }
  const referenceContinuation = referenceBreakdownContinuationState(plan);
  const executableItems = items.map((item) => {
    const execution = creatorSuggestionExecution(item, capabilityById);
    if (item.intent !== 'reference-breakdown.continue-production'
      || referenceContinuation.ready) return execution;
    const blocker = {
      code: referenceContinuation.code,
      message: referenceContinuation.message,
    };
    return {
      ...execution,
      executable: false,
      blockers: [...execution.blockers, blocker],
      unblockActions: [...execution.unblockActions, blocker.message],
      disabledReason: blocker.message,
    };
  });
  const binding = creatorSuggestionBinding(context, plan);
  const suggestionSet = {
    schema: 't8-creator-suggestion-set-v1',
    deterministic: true,
    providerCalls: 0,
    binding,
    setDigest: creatorDigest({
      schema: 't8-creator-suggestion-set-v1',
      binding,
      items: executableItems,
    }),
    items: executableItems,
  };
  suggestionSet.invariantReceipt = creatorSuggestionInvariantReceipt(suggestionSet);
  return suggestionSet;
}

function resolveCreatorSuggestionSelection(session, input = {}) {
  const suggestionId = boundedText(input.suggestionId, 160);
  const suggestionSetDigest = boundedText(input.suggestionSetDigest, 128).toLowerCase();
  const storedSet = session?.suggestionSet;
  if (!suggestionId || !/^[a-f0-9]{64}$/.test(suggestionSetDigest)) {
    throw new CreatorAgentSessionError(
      'CREATOR_SUGGESTION_RECEIPT_REQUIRED',
      '这条建议缺少当前版本回执，请刷新 Agent 建议后再试',
      409,
    );
  }
  if (!storedSet || storedSet.schema !== 't8-creator-suggestion-set-v1'
    || storedSet.setDigest !== suggestionSetDigest) {
    throw new CreatorAgentSessionError(
      'CREATOR_SUGGESTION_STALE',
      '这条建议已经不是当前版本，请使用最新回复下方的建议',
      409,
      { staleFields: ['suggestionSet'] },
    );
  }
  const currentSet = creatorSuggestionSet(input.context || session.context, session.latestPlan, {
    availableCapabilityIds: input.availableCapabilityIds,
  });
  if (currentSet.setDigest !== storedSet.setDigest) {
    const staleFields = ['canvasRevision', 'contextDigest', 'assetVersion', 'planDigest']
      .filter((field) => currentSet.binding?.[field] !== storedSet.binding?.[field]);
    throw new CreatorAgentSessionError(
      'CREATOR_SUGGESTION_STALE',
      '画布、选区或素材已经变化，这条旧建议已停止执行；请使用刚刷新的 3 条建议',
      409,
      { staleFields, currentBinding: currentSet.binding },
    );
  }
  const suggestion = currentSet.items.find((item) => item.id === suggestionId);
  if (!suggestion) {
    throw new CreatorAgentSessionError(
      'CREATOR_SUGGESTION_NOT_FOUND',
      '当前建议中没有这个操作，请使用最新回复下方的建议',
      409,
    );
  }
  if (!suggestion.executable || suggestion.blockers.length > 0) {
    throw new CreatorAgentSessionError(
      'CREATOR_SUGGESTION_BLOCKED',
      suggestion.disabledReason || suggestion.blockers[0]?.message || '当前建议暂时不能执行',
      409,
      { blockers: suggestion.blockers, unblockActions: suggestion.unblockActions },
    );
  }
  return suggestion;
}

function creatorSuggestions(context = {}, plan = null) {
  return creatorSuggestionSet(context, plan).items.map((item) => item.label);
}

function inferCreatorKind(prompt, attachments = []) {
  const value = boundedText(prompt, 200_000).toLowerCase();
  const kinds = new Set(attachments.map((item) => creatorAttachmentKind(item.kind)));
  if (/(?:打包交付|整理成片|交付包|导出(?:项目|成片|作品|全部素材)|下载(?:成片|作品|全部素材)|package\s+(?:delivery|project)|deliver(?:y)?)/i.test(value)) {
    return 'delivery';
  }
  if (/(?:修改|编辑|重做|替换|擦除|扩图|换背景|edit).{0,20}(?:视频|影片|片段|video)/i.test(value)) return 'edit-video';
  if (/(?:修改|编辑|重做|替换|擦除|扩图|换背景|edit).{0,20}(?:图片|图像|照片|海报|image|photo)/i.test(value)) return 'edit-image';
  if (/(?:剧本|故事|分镜|导演|角色设定|人设|短片|广告片|tvc|mv|storyboard|story|script)/i.test(value)) return 'story';
  if (/(?:视频|影片|动画|运镜|镜头|口型|video|film|motion)/i.test(value)) return kinds.has('video') ? 'edit-video' : 'video';
  if (/(?:音频|音乐|歌曲|配音|旁白|对白|音效|转写|字幕|audio|music|voice|suno|whisper)/i.test(value)) return 'audio';
  if (/(?:图片|图像|照片|海报|插画|封面|画面|image|photo|poster|illustration)/i.test(value)) {
    return kinds.has('image') ? 'edit-image' : 'image';
  }
  if (/(?:文案|台词|对白|文章|文本|copywriting)/i.test(value)) return 'script';
  return 'story';
}

function inferCreatorRecipe(prompt, kind = '', attachments = []) {
  const value = boundedText(prompt, 200_000).toLowerCase();
  const normalizedKind = boundedText(kind, 40).toLowerCase();
  const attachmentKinds = new Set((Array.isArray(attachments) ? attachments : [])
    .map((item) => creatorAttachmentKind(item?.kind)));
  if (/(?:一键)?拉片|拆(?:解|分)(?:这个|这段|参考)?视频|分析(?:这个|这段|参考)?视频(?:的)?(?:镜头|运镜|节奏)/i.test(value)
    || (attachmentKinds.has('video') && /(?:镜头语言|运镜|节奏结构|参考分析)/i.test(value))) {
    return 'shot-breakdown';
  }
  if (/(?:tvc|商业广告|产品广告|品牌广告|广告片|宣传片)/i.test(value)) return 'tvc';
  if (/(?:竖屏短剧|短漫剧|微短剧|短剧)/i.test(value)
    || (normalizedKind === 'story' && /竖屏短片/i.test(value))) return 'short-drama';
  if (/(?:音乐\s*mv|歌曲\s*mv|做(?:成|一个)?\s*mv)/i.test(value)) return 'mv';
  if (/(?:商品图|电商图|产品主视觉|商品主图)/i.test(value)) return 'product';
  if (/(?:角色设定图|人物设定图|人设图|三视图)/i.test(value)) return 'character-sheet';
  if (/(?:导演分镜|镜头表|分镜脚本|故事板|storyboard)/i.test(value)) return 'storyboard';
  if (/(?:知识讲解|科普视频|教程视频)/i.test(value)) return 'education';
  if (/(?:参考改编|参考复刻|只学.*(?:风格|结构|节奏))/i.test(value)) return 'remake';
  return 'general';
}

function normalizeCreativePhase(value, fallback = 'idea') {
  const phase = boundedText(value, 80).toLowerCase();
  if (['delivery', 'export', 'done'].includes(phase)) return 'delivery';
  if (['candidates', 'video', 'edit', 'audio', 'sound', 'generation'].includes(phase)) return 'candidates';
  if (['shots', 'prompts', 'storyboard', 'director'].includes(phase)) return 'shots';
  if (['assets', 'style', 'characters'].includes(phase)) return 'assets';
  if (['script', 'story'].includes(phase)) return 'script';
  if (['idea', 'creative', 'brief'].includes(phase)) return 'idea';
  return boundedText(fallback, 80) || 'idea';
}

function phaseForPlan(plan, fallback = 'idea') {
  if (!plan || typeof plan !== 'object') return normalizeCreativePhase(fallback);
  const action = boundedText(plan.action, 80).toLowerCase();
  if (plan.kind === 'delivery') return 'delivery';
  if (action === 'create.story' || action === 'create.script') return 'script';
  if (action === 'asset.place' || plan.kind === 'asset') return 'assets';
  if (['story.analyze', 'story.import', 'story.bind-asset'].includes(action)) return 'assets';
  if (['story.compile', 'director.materialize'].includes(action)) return 'shots';
  if (['story.plan-previews', 'story.adopt-preview', 'video-edit.compose',
    'review', 'accept', 'lock', 'unlock', 'branch', 'rollback'].includes(action)) {
    return 'candidates';
  }
  if (plan.kind === 'story') {
    return normalizeCreativePhase(plan.analysis?.stage || 'script', fallback);
  }
  if (plan.kind === 'script') return 'script';
  if (['image', 'edit-image', 'video', 'edit-video', 'audio'].includes(plan.kind)) return 'candidates';
  return normalizeCreativePhase(fallback);
}

function normalizeCreatorProductionPhaseList(value) {
  const values = Array.isArray(value) ? value : [];
  return CREATOR_PRODUCTION_PHASES.filter((phase) => (
    values.some((item) => normalizeCreativePhase(item, '__invalid__') === phase)
  ));
}

function normalizeCreatorProductionState(value, fallbackPhase = 'idea') {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const currentPhase = normalizeCreativePhase(input.currentPhase || fallbackPhase, 'idea');
  const completedPhases = normalizeCreatorProductionPhaseList(input.completedPhases);
  const invalidatedPhases = normalizeCreatorProductionPhaseList(input.invalidatedPhases)
    .filter((phase) => !completedPhases.includes(phase));
  const visitedPhases = normalizeCreatorProductionPhaseList([
    ...(Array.isArray(input.visitedPhases) ? input.visitedPhases : []),
    currentPhase,
  ]);
  const blocked = input.blocked && typeof input.blocked === 'object'
    ? {
        phase: normalizeCreativePhase(input.blocked.phase, currentPhase),
        message: boundedText(input.blocked.message, 1_000) || '当前阶段需要补充信息后继续',
        at: boundedText(input.blocked.at, 80) || null,
      }
    : null;
  const checkpoint = input.checkpoint && typeof input.checkpoint === 'object'
    ? {
        type: boundedText(input.checkpoint.type, 80),
        planId: boundedText(input.checkpoint.planId, 160) || null,
        planDigest: boundedText(input.checkpoint.planDigest, 160) || null,
        runId: boundedText(input.checkpoint.runId, 160) || null,
        recordedAt: boundedText(input.checkpoint.recordedAt, 80) || null,
      }
    : null;
  const history = (Array.isArray(input.history) ? input.history : [])
    .slice(-CREATOR_PRODUCTION_MAX_HISTORY)
    .map((item) => {
      const from = normalizeCreativePhase(item?.from, 'idea');
      const to = normalizeCreativePhase(item?.to, from);
      return {
        revision: Math.max(1, Math.trunc(Number(item?.revision) || 1)),
        from,
        to,
        direction: item?.direction === 'revise' ? 'revise' : 'advance',
        reason: boundedText(item?.reason, 240) || '恢复创作阶段',
        completedPhases: normalizeCreatorProductionPhaseList(item?.completedPhases),
        invalidatedPhases: normalizeCreatorProductionPhaseList(item?.invalidatedPhases),
        recordedAt: boundedText(item?.recordedAt, 80) || null,
      };
    });
  return {
    schema: CREATOR_PRODUCTION_STATE_SCHEMA,
    currentPhase,
    revision: Math.max(0, Math.trunc(Number(input.revision) || 0)),
    visitedPhases,
    completedPhases,
    invalidatedPhases,
    blocked,
    checkpoint,
    history,
  };
}

function completedPhasesForPlan(plan) {
  // A plan is an intention, not evidence that any production stage completed.
  return [];
}

function creatorProductionCheckpoint(type, payload = {}, recordedAt = null) {
  return {
    type: boundedText(type, 80),
    planId: boundedText(payload?.planId, 160) || null,
    planDigest: boundedText(payload?.planDigest, 160) || null,
    runId: boundedText(payload?.runId, 160) || null,
    recordedAt: boundedText(recordedAt, 80) || null,
  };
}

function transitionCreatorProduction(session, targetPhase, options = {}) {
  const recordedAt = boundedText(options.recordedAt, 80) || null;
  const current = normalizeCreatorProductionState(session.production, session.phase || 'idea');
  const from = current.currentPhase;
  const to = normalizeCreativePhase(targetPhase, from);
  const fromIndex = CREATOR_PRODUCTION_PHASES.indexOf(from);
  const toIndex = CREATOR_PRODUCTION_PHASES.indexOf(to);
  const hasAuthoritativeCompletion = Array.isArray(options.authoritativeCompletedPhases);
  const completed = new Set(hasAuthoritativeCompletion
    ? normalizeCreatorProductionPhaseList(options.authoritativeCompletedPhases)
    : current.completedPhases);
  const invalidated = new Set(current.invalidatedPhases);
  const explicitCompleted = normalizeCreatorProductionPhaseList(options.completedPhases);

  if (hasAuthoritativeCompletion) {
    for (const phase of current.completedPhases) {
      if (!completed.has(phase)) invalidated.add(phase);
    }
    for (const phase of completed) invalidated.delete(phase);
  }
  for (const phase of explicitCompleted) {
    completed.add(phase);
    invalidated.delete(phase);
  }
  if (toIndex < fromIndex) {
    for (const phase of CREATOR_PRODUCTION_PHASES.slice(toIndex)) {
      if (completed.delete(phase) || current.visitedPhases.includes(phase)) invalidated.add(phase);
    }
  }
  const invalidateFromPhase = options.invalidateFromPhase
    ? normalizeCreativePhase(options.invalidateFromPhase, '__invalid__')
    : '';
  const invalidateFromIndex = CREATOR_PRODUCTION_PHASES.indexOf(invalidateFromPhase);
  if (invalidateFromIndex >= 0) {
    for (const phase of CREATOR_PRODUCTION_PHASES.slice(invalidateFromIndex)) {
      if (completed.delete(phase) || current.visitedPhases.includes(phase)) invalidated.add(phase);
    }
  }
  if (options.completeCurrent === true) {
    completed.add(to);
    invalidated.delete(to);
  }
  const completedPhases = CREATOR_PRODUCTION_PHASES.filter((phase) => completed.has(phase));
  const invalidatedPhases = CREATOR_PRODUCTION_PHASES
    .filter((phase) => invalidated.has(phase) && !completed.has(phase));
  const visitedPhases = CREATOR_PRODUCTION_PHASES.filter((phase) => (
    current.visitedPhases.includes(phase) || phase === to
  ));
  const stateChanged = from !== to
    || completedPhases.join('|') !== current.completedPhases.join('|')
    || invalidatedPhases.join('|') !== current.invalidatedPhases.join('|');
  const revision = current.revision + (stateChanged ? 1 : 0);
  const history = stateChanged
    ? [...current.history, {
        revision,
        from,
        to,
        direction: toIndex < fromIndex ? 'revise' : 'advance',
        reason: boundedText(options.reason, 240) || '创作计划更新',
        completedPhases,
        invalidatedPhases,
        recordedAt,
      }].slice(-CREATOR_PRODUCTION_MAX_HISTORY)
    : current.history;
  session.production = {
    schema: CREATOR_PRODUCTION_STATE_SCHEMA,
    currentPhase: to,
    revision,
    visitedPhases,
    completedPhases,
    invalidatedPhases,
    blocked: options.keepBlocked === true ? current.blocked : null,
    checkpoint: options.checkpoint || current.checkpoint,
    history,
  };
  session.phase = to;
  return session.production;
}

function blockCreatorProduction(session, message, options = {}) {
  const current = normalizeCreatorProductionState(session.production, session.phase || 'idea');
  session.production = {
    ...current,
    blocked: {
      phase: current.currentPhase,
      message: boundedText(message, 1_000) || '当前阶段需要补充信息后继续',
      at: boundedText(options.recordedAt, 80) || null,
    },
    checkpoint: options.checkpoint || current.checkpoint,
  };
  session.phase = current.currentPhase;
  return session.production;
}

function clearCreatorProductionBlock(session, checkpoint = null) {
  const current = normalizeCreatorProductionState(session.production, session.phase || 'idea');
  session.production = {
    ...current,
    blocked: null,
    checkpoint: checkpoint || current.checkpoint,
  };
  session.phase = current.currentPhase;
  return session.production;
}

function normalizeCreatorProductionEvidence(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (input.schema !== 't8-creator-production-evidence-v1'
    || input.source !== 'canonical-canvas-evidence') return null;
  const normalizeCountState = (state) => {
    const item = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    return {
      ready: item.ready === true,
      completed: Math.max(0, Math.min(100_000, Math.trunc(Number(item.completed) || 0))),
      total: Math.max(0, Math.min(100_000, Math.trunc(Number(item.total) || 0))),
    };
  };
  const snapshots = (Array.isArray(input.story?.snapshots) ? input.story.snapshots : [])
    .slice(0, 32)
    .map((snapshot) => ({
      nodeId: boundedText(snapshot?.nodeId, 160),
      storyId: boundedText(snapshot?.storyId, 160),
      stage: boundedText(snapshot?.stage, 40),
      storyRevision: Math.max(0, Math.trunc(Number(snapshot?.storyRevision) || 0)),
      productionRevision: Math.max(0, Math.trunc(Number(snapshot?.productionRevision) || 0)),
      scriptReady: snapshot?.scriptReady === true,
      shotsReady: snapshot?.shotsReady === true,
      assets: normalizeCountState(snapshot?.assets),
      prompts: normalizeCountState(snapshot?.prompts),
      videos: normalizeCountState(snapshot?.videos),
      finalVideoReady: snapshot?.finalVideoReady === true,
    }))
    .filter((snapshot) => snapshot.nodeId);
  return {
    schema: 't8-creator-production-evidence-v1',
    source: 'canonical-canvas-evidence',
    verified: input.verified === true,
    authoritative: input.authoritative === true,
    lifecycleType: boundedText(input.lifecycleType, 40),
    action: boundedText(input.action, 80),
    kind: boundedText(input.kind, 40),
    currentPhase: normalizeCreativePhase(input.currentPhase, 'idea'),
    completedPhases: normalizeCreatorProductionPhaseList(input.completedPhases),
    affectedNodeIds: [...new Set((Array.isArray(input.affectedNodeIds) ? input.affectedNodeIds : [])
      .map((value) => boundedText(value, 160))
      .filter(Boolean))].slice(0, 128),
    canvasRevision: input.canvasRevision != null && Number.isSafeInteger(Number(input.canvasRevision))
      ? Number(input.canvasRevision)
      : null,
    documentVerified: input.documentVerified === true,
    story: {
      verified: input.story?.verified === true,
      nodeIds: [...new Set((Array.isArray(input.story?.nodeIds) ? input.story.nodeIds : [])
        .map((value) => boundedText(value, 160))
        .filter(Boolean))].slice(0, 32),
      scriptReady: input.story?.scriptReady === true,
      assetsReady: input.story?.assetsReady === true,
      promptsReady: input.story?.promptsReady === true,
      videosReady: input.story?.videosReady === true,
      finalVideoReady: input.story?.finalVideoReady === true,
      snapshots,
    },
    candidates: {
      acceptedNodeIds: [...new Set((Array.isArray(input.candidates?.acceptedNodeIds)
        ? input.candidates.acceptedNodeIds : [])
        .map((value) => boundedText(value, 160))
        .filter(Boolean))].slice(0, 128),
      reviewedNodeIds: [...new Set((Array.isArray(input.candidates?.reviewedNodeIds)
        ? input.candidates.reviewedNodeIds : [])
        .map((value) => boundedText(value, 160))
        .filter(Boolean))].slice(0, 128),
      acceptedAndReviewed: input.candidates?.acceptedAndReviewed === true,
    },
  };
}

function normalizeCreatorAgentReadinessReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== CREATOR_AGENT_READINESS_SCHEMA) return null;
  const localPlanMs = Number(value.localPlanMs);
  const targetMs = Number(value.targetMs);
  if (!Number.isFinite(localPlanMs) || localPlanMs < 0
    || targetMs !== CREATOR_AGENT_LOCAL_PLAN_TARGET_MS
    || value.sideEffects?.providerCalls !== 0
    || value.sideEffects?.canvasWrites !== 0
    || value.sideEffects?.productionFileWrites !== 0) return null;
  return {
    schema: CREATOR_AGENT_READINESS_SCHEMA,
    measurement: 'server-monotonic-local-planner',
    localPlanMs: Math.round(localPlanMs * 1_000) / 1_000,
    targetMs: CREATOR_AGENT_LOCAL_PLAN_TARGET_MS,
    withinTarget: localPlanMs <= CREATOR_AGENT_LOCAL_PLAN_TARGET_MS,
    sideEffects: {
      providerCalls: 0,
      canvasWrites: 0,
      productionFileWrites: 0,
    },
  };
}

function assistantMessageForPlan(plan) {
  if (!plan?.ready) {
    const question = plan?.questions?.[0]?.question || '还需要补充一个关键创作条件。';
    return `我已经理解大方向，但不会用猜测替你做决定。${question}`;
  }
  const labels = {
    story: '全流程 Story',
    script: '可编辑剧本',
    image: '图像工作流',
    'edit-image': '图像修改工作流',
    video: '视频工作流',
    'edit-video': '视频修改工作流',
    audio: '音频工作流',
    asset: '素材放置方案',
    delivery: '可核验交付包',
  };
  if (plan.kind === 'delivery') {
    return '已经整理出精确交付清单：只包含已持久化并通过文件与 SHA-256 校验的素材。创建交付包仍需你在桌面端核对目录、许可状态和素材范围后明确确认；不会调用模型，也不会覆盖已有目录。';
  }
  const candidate = Number(plan?.candidateCount) || 1;
  return `已经整理成${labels[plan.kind] || '创作工作流'}：先生成可编辑结构和候选预览，再由你确认是否写入画布。当前不会调用模型，也不会覆盖已确认或锁定的内容${candidate > 1 ? `；计划准备 ${candidate} 个候选方向` : ''}。`;
}

function creatorResponseChunks(value, maximum = CREATOR_AGENT_MAX_RESPONSE_CHUNKS) {
  const characters = Array.from(boundedText(value, 8_000));
  if (!characters.length) return [];
  const limit = Math.max(1, Math.min(
    CREATOR_AGENT_MAX_RESPONSE_CHUNKS,
    Math.trunc(Number(maximum) || CREATOR_AGENT_MAX_RESPONSE_CHUNKS),
  ));
  const desired = Math.max(1, Math.min(limit, Math.ceil(characters.length / 24)));
  const targetSize = Math.max(1, Math.ceil(characters.length / desired));
  const chunks = [];
  for (let offset = 0; offset < characters.length; offset += targetSize) {
    chunks.push(characters.slice(offset, offset + targetSize).join(''));
  }
  return chunks;
}

function atomicWriteJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporary, filename);
}

function safeSessionId(value) {
  const id = boundedText(value, 80);
  const isUuid = /^[a-f0-9-]{36}$/i.test(id);
  const isCliSession = /^cs_[A-Za-z0-9_-]{12,64}$/.test(id);
  if (!isUuid && !isCliSession) {
    throw new CreatorAgentSessionError('CREATOR_SESSION_ID_INVALID', '创作会话 ID 无效');
  }
  return isUuid ? id.toLowerCase() : id;
}

function createCreatorAgentSessionStore(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(process.cwd(), 'data', 'creator-agent'));
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const randomUUID = typeof options.randomUUID === 'function' ? options.randomUUID : () => crypto.randomUUID();

  function pathsFor(sessionId) {
    const id = safeSessionId(sessionId);
    return {
      snapshot: path.join(rootDir, 'sessions', `${id}.json`),
      events: path.join(rootDir, 'events', `${id}.jsonl`),
    };
  }

  function withSessionLock(sessionId, purpose, action) {
    const id = safeSessionId(sessionId);
    const lockDir = path.join(rootDir, 'locks');
    const lockPath = path.join(lockDir, `${id}.${boundedText(purpose, 40) || 'write'}.lock`);
    fs.mkdirSync(lockDir, { recursive: true });
    let handle = null;
    for (let attempt = 0; attempt < 250 && handle === null; attempt += 1) {
      try {
        handle = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 30_000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch (statError) {
          if (statError?.code !== 'ENOENT') throw statError;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8);
      }
    }
    if (handle === null) {
      throw new CreatorAgentSessionError(
        'CREATOR_SESSION_BUSY',
        '创作会话正在由另一个本地进程更新，请稍后重试',
        409,
      );
    }
    try {
      return action();
    } finally {
      try { fs.closeSync(handle); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  function read(sessionId) {
    const id = safeSessionId(sessionId);
    const locations = pathsFor(id);
    if (!fs.existsSync(locations.snapshot)) {
      throw new CreatorAgentSessionError('CREATOR_SESSION_NOT_FOUND', '创作会话不存在', 404);
    }
    let session;
    try {
      session = JSON.parse(fs.readFileSync(locations.snapshot, 'utf8'));
    } catch {
      throw new CreatorAgentSessionError('CREATOR_SESSION_CORRUPT', '创作会话记录损坏，已停止继续写入', 500);
    }
    if (session?.schema !== CREATOR_AGENT_SESSION_SCHEMA || session?.id !== id) {
      throw new CreatorAgentSessionError('CREATOR_SESSION_CORRUPT', '创作会话结构不匹配，已停止继续写入', 500);
    }
    if (!Array.isArray(session.runLinks)) session.runLinks = [];
    if (!Array.isArray(session.artifactVerifications)) session.artifactVerifications = [];
    if (!session.runEventCursors || typeof session.runEventCursors !== 'object'
      || Array.isArray(session.runEventCursors)) session.runEventCursors = {};
    session.runEventCursors = Object.fromEntries(Object.entries(session.runEventCursors)
      .map(([runId, cursor]) => [boundedText(runId, 160), Number(cursor)])
      .filter(([runId, cursor]) => runId
        && Number.isSafeInteger(cursor) && cursor >= 0));
    session.production = normalizeCreatorProductionState(session.production, session.phase || 'idea');
    session.phase = session.production.currentPhase;
    session.productionDocumentConfirmations = normalizeProductionDocumentConfirmations(
      session.productionDocumentConfirmations);
    if (!Array.isArray(session.deliveryEvidence)) session.deliveryEvidence = [];
    if (!Array.isArray(session.events)) session.events = [];
    return validateCreatorSuggestionPersistence(session);
  }

  function appendEvent(session, type, payload = {}) {
    const locations = pathsFor(session.id);
    const sequence = Number(session.lastSequence || 0) + 1;
    const event = {
      schema: CREATOR_AGENT_EVENT_SCHEMA,
      eventId: randomUUID(),
      sessionId: session.id,
      sequence,
      type: boundedText(type, 80),
      payload,
      createdAt: new Date(now()).toISOString(),
    };
    fs.mkdirSync(path.dirname(locations.events), { recursive: true });
    fs.appendFileSync(locations.events, `${JSON.stringify(event)}\n`, 'utf8');
    session.lastSequence = sequence;
    session.updatedAt = event.createdAt;
    session.events = [...(Array.isArray(session.events) ? session.events : []), event]
      .slice(-CREATOR_AGENT_MAX_EVENTS);
    atomicWriteJson(locations.snapshot, session);
    return event;
  }

  function eventsAfter(sessionId, afterSequence = 0, limit = 200) {
    const session = read(sessionId);
    const locations = pathsFor(session.id);
    if (!fs.existsSync(locations.events)) return { events: [], cursorReset: false };
    const stat = fs.statSync(locations.events);
    const bytes = Math.min(stat.size, CREATOR_AGENT_EVENT_TAIL_BYTES);
    const start = Math.max(0, stat.size - bytes);
    const buffer = Buffer.alloc(bytes);
    const handle = fs.openSync(locations.events, 'r');
    try {
      fs.readSync(handle, buffer, 0, bytes, start);
    } finally {
      fs.closeSync(handle);
    }
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstLineBreak = text.indexOf('\n');
      text = firstLineBreak >= 0 ? text.slice(firstLineBreak + 1) : '';
    }
    const parsed = text.split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((event) => event?.schema === CREATOR_AGENT_EVENT_SCHEMA
        && event.sessionId === session.id
        && Number.isInteger(Number(event.sequence)));
    validateCreatorSuggestionPersistence(session, parsed);
    const after = Math.max(0, Math.trunc(Number(afterSequence) || 0));
    const maximum = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 200)));
    const firstSequence = Number(parsed[0]?.sequence || 0);
    return {
      events: parsed.filter((event) => Number(event.sequence) > after).slice(0, maximum),
      cursorReset: Boolean(after > 0 && firstSequence > after + 1),
    };
  }

  function list(input = {}) {
    const projectId = boundedText(input.projectId, 160);
    const canvasId = boundedText(input.canvasId, 160);
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(input.limit) || 20)));
    const directory = path.join(rootDir, 'sessions');
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .slice(0, 500)
      .map((entry) => entry.name.slice(0, -5))
      .filter((id) => /^[a-f0-9-]{36}$/i.test(id) || /^cs_[A-Za-z0-9_-]{12,64}$/.test(id))
      .map((id) => {
        try { return read(id); } catch { return null; }
      })
      .filter((session) => session
        && (!projectId || session.projectId === projectId)
        && (!canvasId || session.canvasId === canvasId))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, limit);
  }

  function create(input = {}) {
    const requestedId = boundedText(input.sessionId || input.id, 80);
    const id = requestedId ? safeSessionId(requestedId) : randomUUID().toLowerCase();
    if (fs.existsSync(pathsFor(id).snapshot)) {
      const existing = read(id);
      if (boundedText(input.projectId, 160) !== existing.projectId
        || boundedText(input.canvasId, 160) !== existing.canvasId) {
        throw new CreatorAgentSessionError(
          'CREATOR_SESSION_SCOPE_MISMATCH',
          '这个创作会话不属于当前项目或画布',
          409,
        );
      }
      return existing;
    }
    const createdAt = new Date(now()).toISOString();
    const context = normalizeContext(input.context);
    const session = {
      schema: CREATOR_AGENT_SESSION_SCHEMA,
      id,
      projectId: boundedText(input.projectId, 160),
      canvasId: boundedText(input.canvasId, 160),
      title: boundedText(input.title, 160) || '新的创作',
      status: 'active',
      phase: 'idea',
      source: boundedText(input.source, 40) || 'canvas-ui',
      context,
      production: normalizeCreatorProductionState({ currentPhase: 'idea' }, 'idea'),
      suggestions: creatorSuggestions(context),
      suggestionSet: creatorSuggestionSet(context),
      events: [],
      runLinks: [],
      runEventCursors: {},
      artifactVerifications: [],
      deliveryEvidence: [],
      lastSequence: 0,
      productionDocumentConfirmations: [],
      latestPlan: null,
      latestPatch: null,
      createdAt,
      updatedAt: createdAt,
    };
    atomicWriteJson(pathsFor(id).snapshot, session);
    appendEvent(session, 'session.created', {
      projectId: session.projectId,
      canvasId: session.canvasId,
      context,
      suggestions: session.suggestions,
    });
    return read(id);
  }

  function applyPlanState(session, input, context) {
    session.context = context;
    session.status = input.plan?.ready ? 'planned' : 'needs-input';
    const recordedAt = new Date(now()).toISOString();
    if (input.plan?.ready) {
      session.latestPlan = input.plan;
      session.latestPatch = input.patch ? normalizeStoredPatch(input.patch) : null;
      session.source = boundedText(input.source, 40) || session.source || 'canvas-ui';
      clearCreatorProductionBlock(
        session,
        creatorProductionCheckpoint('assistant.plan', input.plan, recordedAt),
      );
    } else if (input.plan) {
      session.latestPlan = input.plan;
      session.latestPatch = null;
      blockCreatorProduction(
        session,
        input.plan?.questions?.[0]?.question || '还需要补充一个关键创作条件',
        {
          recordedAt,
          checkpoint: creatorProductionCheckpoint('assistant.needs-input', input.plan, recordedAt),
        },
      );
    }
    const suggestionContext = {
      ...context,
      phase: input.plan?.ready ? phaseForPlan(input.plan, session.production.currentPhase)
        : session.production.currentPhase,
    };
    session.suggestions = creatorSuggestions(suggestionContext, input.plan);
    session.suggestionSet = creatorSuggestionSet(suggestionContext, input.plan);
    return assistantMessageForPlan(input.plan);
  }

  function appendTurn(sessionId, input = {}) {
    const session = read(sessionId);
    const attachments = normalizeAttachments(input.attachments);
    const requestedText = boundedText(input.text, 200_000);
    const text = requestedText
      || creatorAttachmentOnlyPrompt(attachments);
    const attachmentOnly = !requestedText && attachments.length > 0;
    const clientRequestId = boundedText(input.clientRequestId, 120);
    const requestDigest = boundedText(input.requestDigest, 64).toLowerCase();
    const requestBinding = clientRequestId && /^[a-f0-9]{64}$/.test(requestDigest)
      ? { clientRequestId, requestDigest } : null;
    if (!text) throw new CreatorAgentSessionError(
      'CREATOR_MESSAGE_EMPTY', '请先输入创作要求，或添加一个已上传附件',
    );
    const context = normalizeContext({ ...session.context, ...input.context });
    const suggestionSelection = input.suggestionSelection
      && typeof input.suggestionSelection === 'object'
      && /^[a-f0-9]{64}$/.test(boundedText(input.suggestionSelection.setDigest, 128).toLowerCase())
      ? {
          id: boundedText(input.suggestionSelection.id, 160),
          intent: boundedText(input.suggestionSelection.intent, 160),
          setDigest: boundedText(input.suggestionSelection.setDigest, 128).toLowerCase(),
        }
      : null;
    const userEvent = appendEvent(session, suggestionSelection ? 'user.suggestion' : 'user.message', {
      text,
      attachments,
      context,
      ...(suggestionSelection ? { suggestion: suggestionSelection } : {}),
      ...(attachmentOnly ? { inputMode: 'attachments-only' } : {}),
      ...(requestBinding || {}),
    });
    if (session.title === '新的创作') {
      session.title = attachmentOnly
        ? `分析${creatorAttachmentSummary(attachments)}`.slice(0, 40)
        : text.replace(/\s+/g, ' ').slice(0, 40);
    }
    const assistantText = applyPlanState(session, input, context);
    const readinessReceipt = normalizeCreatorAgentReadinessReceipt(input.readinessReceipt);
    const assistantEvent = appendEvent(session, 'assistant.plan', {
      text: assistantText,
      plan: input.plan || null,
      ...(readinessReceipt ? { readinessReceipt } : {}),
      suggestions: session.suggestions,
      suggestionSet: session.suggestionSet,
      suggestionInvariantReceipt: session.suggestionSet.invariantReceipt,
      requiresExplicitApply: Boolean(input.plan?.ready),
      ...(requestBinding || {}),
    });
    return {
      session: read(session.id),
      userEvent,
      assistantEvent,
    };
  }

  function productionDocumentsForNextPlan(sessionId) {
    const session = read(sessionId);
    const documents = Array.isArray(session.latestPlan?.productionDocuments)
      ? session.latestPlan.productionDocuments
      : [];
    return documents.map((document) => ({
      ...document,
      status: productionDocumentConfirmationFor(session, document) ? 'confirmed' : document.status,
    }));
  }

  function confirmProductionDocuments(sessionId, input = {}) {
    const session = read(sessionId);
    const planId = boundedText(input.planId, 160);
    const planDigest = boundedText(input.planDigest, 64).toLowerCase();
    if (!session.latestPlan
      || session.latestPlan.planId !== planId
      || session.latestPlan.planDigest !== planDigest) {
      throw new CreatorAgentSessionError(
        'CREATOR_PRODUCTION_DOCUMENT_STALE',
        '这份前期文档已经有新版本，请刷新后确认当前版本',
        409,
      );
    }
    const requested = Array.isArray(input.documents) ? input.documents.slice(0, 16) : [];
    if (requested.length === 0) {
      throw new CreatorAgentSessionError(
        'CREATOR_PRODUCTION_DOCUMENT_CONFIRMATION_EMPTY',
        '请选择至少一份当前前期文档再确认',
      );
    }
    const currentDocuments = Array.isArray(session.latestPlan.productionDocuments)
      ? session.latestPlan.productionDocuments
      : [];
    const selected = requested.map((item) => {
      const documentId = boundedText(item?.documentId, 160);
      const versionId = boundedText(item?.versionId, 160);
      const contentDigest = boundedText(item?.contentDigest, 64).toLowerCase();
      const document = currentDocuments.find((candidate) => (
        candidate?.id === documentId
        && candidate?.versionId === versionId
        && candidate?.contentDigest === contentDigest
      ));
      if (!document) {
        throw new CreatorAgentSessionError(
          'CREATOR_PRODUCTION_DOCUMENT_STALE',
          '这份前期文档已经有新版本，请刷新后确认当前版本',
          409,
        );
      }
      if (creatorDigest({ kind: document.kind, content: document.content }) !== contentDigest) {
        throw new CreatorAgentSessionError(
          'CREATOR_PRODUCTION_DOCUMENT_INVALID',
          '这份前期文档内容无法验证，已停止确认以保护版本记录',
          409,
        );
      }
      return document;
    });
    if (new Set(selected.map((document) => document.versionId)).size !== selected.length) {
      throw new CreatorAgentSessionError(
        'CREATOR_PRODUCTION_DOCUMENT_CONFIRMATION_DUPLICATE',
        '同一份前期文档不能在一次确认中重复提交',
      );
    }
    const selectedVersionIds = new Set(selected.map((document) => String(document.versionId || '')));
    const expectedSourceKindByDerivedKind = {
      'character-bible': 'script-doc',
      'asset-needs': 'script-doc',
      'shot-list': 'script-doc',
      'audio-plan': 'shot-list',
      storyboard: 'shot-list',
      'prompt-pack': 'storyboard',
      'candidate-review': 'prompt-pack',
      'edit-decision-list': 'candidate-review',
      'qc-report': 'edit-decision-list',
      'delivery-manifest': 'qc-report',
    };
    for (const document of selected) {
      if (!document.content?.derivation) continue;
      const expectedSourceKind = expectedSourceKindByDerivedKind[String(document.kind || '')];
      const derivation = document.content?.derivation;
      const sourceDocumentId = boundedText(derivation?.sourceDocumentId, 160);
      const sourceVersionId = boundedText(derivation?.sourceVersionId, 160);
      const sourceContentDigest = boundedText(derivation?.sourceContentDigest, 64).toLowerCase();
      const sourceDigest = boundedText(derivation?.sourceDigest, 64).toLowerCase();
      const sourceDocument = currentDocuments.find((candidate) => (
        candidate?.kind === expectedSourceKind
        && candidate?.id === sourceDocumentId
        && candidate?.versionId === sourceVersionId
        && candidate?.contentDigest === sourceContentDigest
      ));
      const sourceAnalysisDigest = boundedText(
        sourceDocument?.kind === 'script-doc'
          ? sourceDocument?.content?.scriptAnalysis?.sourceDigest
          : sourceDocument?.content?.derivation?.sourceDigest,
        64,
      ).toLowerCase();
      const sourceDocumentValid = Boolean(sourceDocument
        && /^[a-f0-9]{64}$/.test(sourceContentDigest)
        && creatorDigest({
          kind: sourceDocument.kind,
          content: sourceDocument.content,
        }) === sourceContentDigest);
      const deterministicSourceValid = (
        derivation?.schema === 't8-creator-source-derivation-v1'
        && derivation?.method === 'deterministic-source-map'
        && derivation?.sourceBacked === true
        && derivation?.providerCalls === 0
        && derivation?.inferredFacts === 0
        && /^[a-f0-9]{64}$/.test(sourceDigest)
        && sourceAnalysisDigest === sourceDigest
      );
      const persistedEvidenceValid = (
        document.kind === 'candidate-review'
        && derivation?.schema === 't8-creator-evidence-derivation-v1'
        && derivation?.method === 'persisted-candidate-evidence'
        && Number.isSafeInteger(Number(derivation?.canvasRevision))
        && Number(derivation?.canvasRevision) >= 0
        && /^[a-f0-9]{64}$/.test(boundedText(derivation?.evidenceDigest, 64).toLowerCase())
        && derivation?.documentProviderCalls === 0
        && derivation?.documentCanvasWrites === 0
      );
      const persistedEditDecisionListValid = (
        document.kind === 'edit-decision-list'
        && derivation?.schema === 't8-creator-evidence-derivation-v1'
        && derivation?.method === 'verified-adopted-video-sequence'
        && Number.isSafeInteger(Number(derivation?.canvasRevision))
        && Number(derivation?.canvasRevision) >= 0
        && Number(derivation?.canvasRevision) === Number(sourceDocument?.content?.derivation?.canvasRevision || 0)
        && boundedText(derivation?.evidenceDigest, 64).toLowerCase()
          === creatorDigest(Array.isArray(document.content?.sequence) ? document.content.sequence : [])
        && derivation?.documentProviderCalls === 0
        && derivation?.documentCanvasWrites === 0
      );
      const persistedQualityControlReportValid = (
        document.kind === 'qc-report'
        && derivation?.schema === 't8-creator-evidence-derivation-v1'
        && derivation?.method === 'persisted-artifact-qc-evidence'
        && Number.isSafeInteger(Number(derivation?.canvasRevision))
        && Number(derivation?.canvasRevision) >= 0
        && Number(derivation?.canvasRevision) === Number(sourceDocument?.content?.derivation?.canvasRevision || 0)
        && boundedText(derivation?.evidenceDigest, 64).toLowerCase()
          === creatorDigest(Array.isArray(document.content?.qcItems) ? document.content.qcItems : [])
        && derivation?.documentProviderCalls === 0
        && derivation?.documentCanvasWrites === 0
      );
      const persistedDeliveryManifestValid = (
        document.kind === 'delivery-manifest'
        && derivation?.schema === 't8-creator-evidence-derivation-v1'
        && derivation?.method === 'verified-local-delivery-package-evidence'
        && Number.isSafeInteger(Number(derivation?.canvasRevision))
        && Number(derivation?.canvasRevision) >= 0
        && Number(derivation?.canvasRevision) === Number(sourceDocument?.content?.derivation?.canvasRevision || 0)
        && boundedText(derivation?.evidenceDigest, 64).toLowerCase()
          === creatorDigest({
            deliverables: Array.isArray(document.content?.deliverables)
              ? document.content.deliverables
              : [],
            packageEvidence: document.content?.packageEvidence || null,
          })
        && derivation?.documentProviderCalls === 0
        && derivation?.documentCanvasWrites === 0
        && derivation?.documentDeliveryWrites === 0
      );
      if (!expectedSourceKind
        || !sourceDocumentValid
        || (!deterministicSourceValid
          && !persistedEvidenceValid
          && !persistedEditDecisionListValid
          && !persistedQualityControlReportValid
          && !persistedDeliveryManifestValid)) {
        throw new CreatorAgentSessionError(
          'CREATOR_PRODUCTION_DOCUMENT_SOURCE_INVALID',
          '源证据草案的来源版本无法验证，已停止确认以保护作品记录',
          409,
        );
      }
      if (!productionDocumentConfirmationFor(session, sourceDocument)
        && !selectedVersionIds.has(sourceVersionId)) {
        throw new CreatorAgentSessionError(
          'CREATOR_PRODUCTION_DOCUMENT_SOURCE_UNCONFIRMED',
          '请先确认这份草案对应的当前来源版本；也可以一次确认当前完整来源链和全部草案',
          409,
        );
      }
    }

    const existing = [];
    const created = [];
    const confirmedAt = new Date(now()).toISOString();
    for (const document of selected) {
      const prior = productionDocumentConfirmationFor(session, document);
      if (prior) {
        existing.push(prior);
        continue;
      }
      const normalized = {
        schema: CREATOR_PRODUCTION_DOCUMENT_CONFIRMATION_SCHEMA,
        confirmationId: `pdc_${creatorDigest({
          sessionId: session.id,
          documentId: document.id,
          versionId: document.versionId,
          contentDigest: document.contentDigest,
        }).slice(0, 32)}`,
        documentId: document.id,
        kind: document.kind,
        revision: document.revision,
        versionId: document.versionId,
        contentDigest: document.contentDigest,
        sourcePlanId: planId,
        sourcePlanDigest: planDigest,
        actor: boundedText(input.actor, 40) || 'canvas-ui',
        confirmedAt,
      };
      created.push({ ...normalized, confirmationDigest: creatorDigest(normalized) });
    }
    if (created.length > 0) {
      session.productionDocumentConfirmations = [
        ...session.productionDocumentConfirmations,
        ...created,
      ].slice(-CREATOR_PRODUCTION_DOCUMENT_CONFIRMATION_LIMIT);
      appendEvent(session, 'production-documents.confirmed', {
        planId,
        planDigest,
        confirmationIds: created.map((item) => item.confirmationId),
        documentVersions: created.map((item) => ({
          documentId: item.documentId,
          versionId: item.versionId,
          revision: item.revision,
          contentDigest: item.contentDigest,
        })),
        providerCalls: 0,
        canvasWrites: 0,
      });
    }
    return {
      session: read(session.id),
      confirmations: [...existing, ...created],
      duplicate: created.length === 0,
    };
  }

  function beginStreamingTurn(sessionId, input = {}) {
    const session = read(sessionId);
    const attachments = normalizeAttachments(input.attachments);
    const requestedText = boundedText(input.text, 200_000);
    const text = requestedText
      || creatorAttachmentOnlyPrompt(attachments);
    const attachmentOnly = !requestedText && attachments.length > 0;
    const clientRequestId = boundedText(input.clientRequestId, 120);
    const requestDigest = boundedText(input.requestDigest, 64).toLowerCase();
    const requestBinding = clientRequestId && /^[a-f0-9]{64}$/.test(requestDigest)
      ? { clientRequestId, requestDigest } : null;
    if (!text) throw new CreatorAgentSessionError(
      'CREATOR_MESSAGE_EMPTY', '请先输入创作要求，或添加一个已上传附件',
    );
    const context = normalizeContext({ ...session.context, ...input.context });
    const suggestionSelection = input.suggestionSelection
      && typeof input.suggestionSelection === 'object'
      && /^[a-f0-9]{64}$/.test(boundedText(input.suggestionSelection.setDigest, 128).toLowerCase())
      ? {
          id: boundedText(input.suggestionSelection.id, 160),
          intent: boundedText(input.suggestionSelection.intent, 160),
          setDigest: boundedText(input.suggestionSelection.setDigest, 128).toLowerCase(),
        }
      : null;
    const responseId = randomUUID();
    const userEvent = appendEvent(session, suggestionSelection ? 'user.suggestion' : 'user.message', {
      text,
      attachments,
      context,
      ...(suggestionSelection ? { suggestion: suggestionSelection } : {}),
      ...(attachmentOnly ? { inputMode: 'attachments-only' } : {}),
      ...(requestBinding || {}),
    });
    if (session.title === '新的创作') {
      session.title = attachmentOnly
        ? `分析${creatorAttachmentSummary(attachments)}`.slice(0, 40)
        : text.replace(/\s+/g, ' ').slice(0, 40);
    }
    session.context = context;
    session.status = 'responding';
    const assistantText = assistantMessageForPlan(input.plan);
    const chunks = creatorResponseChunks(assistantText);
    const readinessReceipt = normalizeCreatorAgentReadinessReceipt(input.readinessReceipt);
    const startedEvent = appendEvent(session, 'assistant.response.started', {
      responseId,
      mode: 'plan',
      chunkCount: chunks.length,
      providerCalls: 0,
      ...(readinessReceipt ? { readinessReceipt } : {}),
      ...(requestBinding || {}),
    });
    return {
      session: read(session.id),
      userEvent,
      startedEvent,
      responseId,
      chunks,
    };
  }

  function appendResponseDelta(sessionId, input = {}) {
    const session = read(sessionId);
    const responseId = boundedText(input.responseId, 160);
    const index = Math.trunc(Number(input.index));
    const delta = boundedText(input.delta, 2_000);
    if (!responseId || !Number.isInteger(index) || index < 0 || index >= CREATOR_AGENT_MAX_RESPONSE_CHUNKS || !delta) {
      throw new CreatorAgentSessionError(
        'CREATOR_RESPONSE_DELTA_INVALID',
        '创作 Agent 回复片段无效，已停止继续写入',
      );
    }
    const events = Array.isArray(session.events) ? session.events : [];
    const started = events.find((event) => (
      event.type === 'assistant.response.started'
      && event.payload?.responseId === responseId
    ));
    if (!started) {
      throw new CreatorAgentSessionError(
        'CREATOR_RESPONSE_NOT_STARTED',
        '创作 Agent 回复起点不存在，已停止继续写入',
        409,
      );
    }
    if (events.some((event) => (
      ['assistant.response.completed', 'assistant.response.failed', 'assistant.response.stopped'].includes(event.type)
      && event.payload?.responseId === responseId
    ))) {
      throw new CreatorAgentSessionError(
        'CREATOR_RESPONSE_ALREADY_FINISHED',
        '这次创作 Agent 回复已经结束',
        409,
      );
    }
    const responseDeltas = events
      .filter((event) => (
        event.type === 'assistant.response.delta'
        && event.payload?.responseId === responseId
      ))
      .sort((left, right) => Number(left.payload?.index) - Number(right.payload?.index));
    const duplicate = responseDeltas.find((event) => Number(event.payload?.index) === index);
    if (duplicate) {
      if (String(duplicate.payload?.delta || '') !== delta) {
        throw new CreatorAgentSessionError(
          'CREATOR_RESPONSE_DELTA_CONFLICT',
          '同一回复片段内容不一致，已停止继续写入',
          409,
        );
      }
      return { session, event: duplicate, duplicate: true };
    }
    if (index !== responseDeltas.length) {
      throw new CreatorAgentSessionError(
        'CREATOR_RESPONSE_DELTA_OUT_OF_ORDER',
        '创作 Agent 回复片段顺序不连续，请重新连接后恢复',
        409,
      );
    }
    const event = appendEvent(session, 'assistant.response.delta', {
      responseId,
      index,
      delta,
    });
    return { session: read(session.id), event, duplicate: false };
  }

  function completeStreamingTurnUnlocked(sessionId, input = {}) {
    const session = read(sessionId);
    const responseId = boundedText(input.responseId, 160);
    const events = Array.isArray(session.events) ? session.events : [];
    const terminal = events.find((event) => (
      ['assistant.response.completed', 'assistant.response.failed', 'assistant.response.stopped'].includes(event.type)
      && event.payload?.responseId === responseId
    ));
    if (terminal) {
      return {
        session,
        assistantEvent: terminal,
        duplicate: true,
        status: terminal.type === 'assistant.response.stopped'
          ? 'stopped'
          : terminal.type === 'assistant.response.failed' ? 'failed' : 'completed',
      };
    }
    const started = events.find((event) => (
      event.type === 'assistant.response.started'
      && event.payload?.responseId === responseId
    ));
    if (!responseId || !started) {
      throw new CreatorAgentSessionError(
        'CREATOR_RESPONSE_NOT_STARTED',
        '创作 Agent 回复起点不存在，已停止完成这次回复',
        409,
      );
    }
    const deltas = events
      .filter((event) => (
        event.type === 'assistant.response.delta'
        && event.payload?.responseId === responseId
      ))
      .sort((left, right) => Number(left.payload?.index) - Number(right.payload?.index));
    const expectedCount = Math.max(0, Number(started.payload?.chunkCount) || 0);
    const assistantText = assistantMessageForPlan(input.plan);
    if (deltas.length !== expectedCount
      || deltas.some((event, index) => Number(event.payload?.index) !== index)
      || deltas.map((event) => String(event.payload?.delta || '')).join('') !== assistantText) {
      throw new CreatorAgentSessionError(
        'CREATOR_RESPONSE_INCOMPLETE',
        '创作 Agent 回复尚未完整写入，请等待恢复后再继续',
        409,
      );
    }
    const context = normalizeContext({ ...session.context, ...input.context });
    applyPlanState(session, input, context);
    const readinessReceipt = normalizeCreatorAgentReadinessReceipt(
      input.readinessReceipt || started.payload?.readinessReceipt,
    );
    const assistantEvent = appendEvent(session, 'assistant.response.completed', {
      responseId,
      text: assistantText,
      plan: input.plan || null,
      ...(readinessReceipt ? { readinessReceipt } : {}),
      suggestions: session.suggestions,
      suggestionSet: session.suggestionSet,
      suggestionInvariantReceipt: session.suggestionSet.invariantReceipt,
      requiresExplicitApply: Boolean(input.plan?.ready),
      providerCalls: 0,
      ...(started.payload?.clientRequestId ? { clientRequestId: started.payload.clientRequestId } : {}),
      ...(started.payload?.requestDigest ? { requestDigest: started.payload.requestDigest } : {}),
    });
    return {
      session: read(session.id),
      assistantEvent,
      duplicate: false,
      status: 'completed',
    };
  }

  function completeStreamingTurn(sessionId, input = {}) {
    return withSessionLock(sessionId, 'response-complete', () => (
      completeStreamingTurnUnlocked(sessionId, input)
    ));
  }

  function failStreamingTurn(sessionId, input = {}) {
    const session = read(sessionId);
    const responseId = boundedText(input.responseId, 160);
    if (!responseId) return session;
    const events = Array.isArray(session.events) ? session.events : [];
    if (events.some((event) => (
      ['assistant.response.completed', 'assistant.response.failed', 'assistant.response.stopped'].includes(event.type)
      && event.payload?.responseId === responseId
    ))) return session;
    session.status = 'needs-input';
    const started = events.find((event) => (
      event.type === 'assistant.response.started'
      && event.payload?.responseId === responseId
    ));
    appendEvent(session, 'assistant.response.failed', {
      responseId,
      message: boundedText(input.message, 1_000) || '回复意外中断；已保留你的要求，可以直接重试。',
      providerCalls: 0,
      ...(started?.payload?.clientRequestId ? { clientRequestId: started.payload.clientRequestId } : {}),
      ...(started?.payload?.requestDigest ? { requestDigest: started.payload.requestDigest } : {}),
    });
    return read(session.id);
  }

  function stopStreamingTurn(sessionId, input = {}) {
    const session = read(sessionId);
    const responseId = boundedText(input.responseId, 160);
    if (!responseId) {
      throw new CreatorAgentSessionError(
        'CREATOR_RESPONSE_ID_REQUIRED',
        '没有找到要停止的本轮回复，请刷新会话后重试',
      );
    }
    const events = Array.isArray(session.events) ? session.events : [];
    const started = events.find((event) => (
      event.type === 'assistant.response.started'
      && event.payload?.responseId === responseId
    ));
    if (!started) {
      throw new CreatorAgentSessionError(
        'CREATOR_RESPONSE_NOT_STARTED',
        '没有找到要停止的本轮回复；画布里的生成任务没有受到影响',
        404,
      );
    }
    const terminal = events.find((event) => (
      ['assistant.response.completed', 'assistant.response.failed', 'assistant.response.stopped'].includes(event.type)
      && event.payload?.responseId === responseId
    ));
    if (terminal) {
      return {
        session,
        assistantEvent: terminal,
        duplicate: true,
        status: terminal.type === 'assistant.response.stopped'
          ? 'stopped'
          : terminal.type === 'assistant.response.failed' ? 'failed' : 'completed',
      };
    }
    const deltas = events
      .filter((event) => (
        event.type === 'assistant.response.delta'
        && event.payload?.responseId === responseId
      ))
      .sort((left, right) => Number(left.payload?.index) - Number(right.payload?.index));
    const partialText = deltas.map((event) => String(event.payload?.delta || '')).join('');
    session.status = 'needs-input';
    const assistantEvent = appendEvent(session, 'assistant.response.stopped', {
      responseId,
      text: partialText,
      message: '已停止本轮文字回复。你的要求和已显示内容仍然保留；画布里的图像、视频、音频等远端生成任务没有被取消。',
      reason: 'creator-stopped-reply',
      providerCalls: 0,
      remoteTasksAffected: 0,
      ...(started.payload?.clientRequestId ? { clientRequestId: started.payload.clientRequestId } : {}),
      ...(started.payload?.requestDigest ? { requestDigest: started.payload.requestDigest } : {}),
    });
    return {
      session: read(session.id),
      assistantEvent,
      duplicate: false,
      status: 'stopped',
    };
  }

  function messageRequest(sessionId, input = {}) {
    const session = read(sessionId);
    const clientRequestId = boundedText(input.clientRequestId, 120);
    const requestDigest = boundedText(input.requestDigest, 64).toLowerCase();
    if (!clientRequestId) {
      throw new CreatorAgentSessionError(
        'CREATOR_MESSAGE_REQUEST_ID_REQUIRED',
        '这条创作要求缺少恢复编号，请重新发送',
      );
    }
    const events = Array.isArray(session.events) ? session.events : [];
    const userEvent = events.find((event) => (
      ['user.message', 'user.suggestion'].includes(event.type)
      && event.payload?.clientRequestId === clientRequestId
    ));
    if (!userEvent) return null;
    const storedDigest = boundedText(userEvent.payload?.requestDigest, 64).toLowerCase();
    if (requestDigest && storedDigest !== requestDigest) {
      throw new CreatorAgentSessionError(
        'CREATOR_MESSAGE_IDEMPOTENCY_CONFLICT',
        '同一恢复编号对应了不同创作要求，已停止重复提交；请作为新要求重新发送',
        409,
      );
    }
    const responseId = boundedText(userEvent.payload?.responseId, 160);
    const matchesRequest = (event) => (
      event.payload?.clientRequestId === clientRequestId
      || (responseId && event.payload?.responseId === responseId)
    );
    const assistantEvent = [...events].reverse().find((event) => (
      [
        'assistant.plan',
        'assistant.response.completed',
        'assistant.response.failed',
        'assistant.response.stopped',
        'assistant.response.started',
      ].includes(event.type)
      && matchesRequest(event)
    )) || null;
    const status = assistantEvent?.type === 'assistant.response.failed'
      ? 'failed'
      : assistantEvent?.type === 'assistant.response.stopped'
        ? 'stopped'
      : ['assistant.plan', 'assistant.response.completed'].includes(assistantEvent?.type)
        ? 'completed'
        : 'in-progress';
    const startedEvent = events.find((event) => (
      event.type === 'assistant.response.started'
      && matchesRequest(event)
    ));
    return {
      schema: 't8-creator-message-request-v1',
      clientRequestId,
      requestDigest: storedDigest,
      status,
      responseId: responseId || boundedText(startedEvent?.payload?.responseId, 160),
      chunkCount: Math.max(0, Number(startedEvent?.payload?.chunkCount) || 0),
      session,
      userEvent,
      assistantEvent,
    };
  }

  function appendActionPlan(sessionId, input = {}) {
    const session = read(sessionId);
    const action = boundedText(input.action, 80);
    const label = boundedText(input.label, 240);
    if (!action || !input.plan) {
      throw new CreatorAgentSessionError(
        'CREATOR_ACTION_PLAN_INVALID',
        '受控创作操作缺少动作或预览计划',
      );
    }
    const context = normalizeContext({ ...session.context, ...input.context });
    const userEvent = appendEvent(session, 'user.action', {
      action,
      label: label || action,
      nodeId: boundedText(input.nodeId, 160),
      context,
    });
    session.context = context;
    const recordedAt = new Date(now()).toISOString();
    session.status = input.plan.ready ? 'planned' : 'needs-input';
    session.latestPlan = input.plan;
    session.latestPatch = input.plan.ready && input.patch ? normalizeStoredPatch(input.patch) : null;
    session.source = boundedText(input.source, 40) || session.source || 'canvas-ui';
    if (input.plan.ready) {
      clearCreatorProductionBlock(
        session,
        creatorProductionCheckpoint('assistant.plan', input.plan, recordedAt),
      );
    } else {
      blockCreatorProduction(session, input.plan?.questions?.[0]?.question, {
        recordedAt,
        checkpoint: creatorProductionCheckpoint('assistant.needs-input', input.plan, recordedAt),
      });
    }
    const suggestionContext = {
      ...context,
      phase: input.plan?.ready ? phaseForPlan(input.plan, session.production.currentPhase)
        : session.production.currentPhase,
    };
    session.suggestions = creatorSuggestions(suggestionContext, input.plan);
    session.suggestionSet = creatorSuggestionSet(suggestionContext, input.plan);
    const assistantEvent = appendEvent(session, 'assistant.plan', {
      text: assistantMessageForPlan(input.plan),
      plan: input.plan,
      suggestions: session.suggestions,
      suggestionSet: session.suggestionSet,
      suggestionInvariantReceipt: session.suggestionSet.invariantReceipt,
      requiresExplicitApply: Boolean(input.plan.ready),
    });
    return {
      session: read(session.id),
      userEvent,
      assistantEvent,
    };
  }

  function appendRunEvents(sessionId, values = []) {
    const session = read(sessionId);
    const linkedRunIds = new Set(session.runLinks.map((link) => boundedText(link?.runId, 160)).filter(Boolean));
    const normalized = (Array.isArray(values) ? values : [])
      .map(normalizeCreatorRunEvent)
      .filter(Boolean)
      .filter((item) => linkedRunIds.has(item.payload.runId))
      .sort((left, right) => left.payload.sourceEventId - right.payload.sourceEventId)
      .slice(0, 500);
    const appended = [];
    let cursorChanged = false;
    for (const item of normalized) {
      const runId = item.payload.runId;
      const currentCursor = Math.max(0, Number(session.runEventCursors[runId]) || 0);
      if (item.payload.sourceEventId <= currentCursor) continue;
      session.runEventCursors[runId] = item.payload.sourceEventId;
      cursorChanged = true;
      if (!item.visible) continue;
      const duplicateSource = session.events.some((event) => (
        event?.type === 'run.event'
        && Number(event?.payload?.sourceEventId) === item.payload.sourceEventId
        && event?.payload?.runId === runId
      ));
      if (duplicateSource) continue;
      if (item.progressBucket != null && !/(?:completed|succeeded|failed|stopped|interrupted|terminal|error)/i
        .test(`${item.payload.eventType} ${item.payload.phase || ''} ${item.payload.status || ''}`)) {
        const duplicateBucket = [...session.events].reverse().find((event) => (
          event?.type === 'run.event'
          && event?.payload?.runId === runId
          && (event?.payload?.nodeRunId || null) === (item.payload.nodeRunId || null)
          && event?.payload?.eventType === item.payload.eventType
          && event?.payload?.phase === item.payload.phase
          && event?.payload?.progress != null
        ));
        if (duplicateBucket
          && Math.floor(Number(duplicateBucket.payload.progress) / 10) * 10 === item.progressBucket) continue;
      }
      appended.push(appendEvent(session, 'run.event', item.payload));
    }
    if (cursorChanged) atomicWriteJson(pathsFor(session.id).snapshot, session);
    return { session: read(session.id), events: appended };
  }

  function appendLifecycle(sessionId, type, payload = {}) {
    const session = read(sessionId);
    const allowed = new Set([
      'plan.previewed',
      'plan.applied',
      'plan.reverted',
      'plan.failed',
      'artifact.sent-to-canvas',
      'run.linked',
      'run.artifacts-verified',
      'delivery.approval-requested',
      'delivery.completed',
      'delivery.denied',
      'delivery.failed',
    ]);
    if (!allowed.has(type)) throw new CreatorAgentSessionError('CREATOR_EVENT_TYPE_INVALID', '创作事件类型无效');
    let normalizedPayload = payload;
    if (type === 'plan.previewed') {
      session.status = 'previewed';
    } else if (type === 'plan.applied' || type === 'plan.reverted') {
      const normalizeRevision = (value) => {
        const revision = Number(value);
        return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
      };
      const canvasEvidence = payload?.canvasEvidence && typeof payload.canvasEvidence === 'object'
        ? {
            source: boundedText(payload.canvasEvidence.source, 80),
            status: boundedText(payload.canvasEvidence.status, 40),
            actorId: boundedText(payload.canvasEvidence.actorId, 160),
            operationCount: Math.max(0, Math.min(10_000, Number(payload.canvasEvidence.operationCount) || 0)),
          }
        : null;
      normalizedPayload = {
        schema: 't8-creator-canvas-lifecycle-v1',
        planId: boundedText(payload?.planId, 160),
        planDigest: boundedText(payload?.planDigest, 160),
        patchId: boundedText(payload?.patchId, 160),
        previewDigest: /^[a-f0-9]{64}$/i.test(String(payload?.previewDigest || ''))
          ? String(payload.previewDigest).toLowerCase() : '',
        appliedRevision: normalizeRevision(payload?.appliedRevision),
        ...(type === 'plan.reverted'
          ? { revertedRevision: normalizeRevision(payload?.revertedRevision) }
          : {}),
        duplicate: payload?.duplicate === true,
        canvasEvidence,
        productionEvidence: normalizeCreatorProductionEvidence(payload?.productionEvidence),
      };
      const duplicate = (Array.isArray(session.events) ? session.events : []).some((event) => (
        event?.type === type
        && String(event?.payload?.planId || '') === normalizedPayload.planId
        && String(event?.payload?.patchId || '') === normalizedPayload.patchId
        && Number(event?.payload?.appliedRevision) === Number(normalizedPayload.appliedRevision)
        && (type !== 'plan.reverted'
          || Number(event?.payload?.revertedRevision) === Number(normalizedPayload.revertedRevision))
      ));
      if (duplicate) return session;
      session.status = 'active';
      if (type === 'plan.applied') {
        const recordedAt = new Date(now()).toISOString();
        const evidence = normalizedPayload.productionEvidence;
        if (evidence?.verified) {
          transitionCreatorProduction(session, evidence.currentPhase, {
            ...(evidence.authoritative
              ? { authoritativeCompletedPhases: evidence.completedPhases }
              : { completedPhases: evidence.completedPhases }),
            reason: `已通过画布 Patch 台账核验 ${evidence.action || '创作'} 动作`,
            recordedAt,
            checkpoint: creatorProductionCheckpoint(type, normalizedPayload, recordedAt),
          });
        } else {
          clearCreatorProductionBlock(
            session,
            creatorProductionCheckpoint(type, normalizedPayload, recordedAt),
          );
        }
      } else {
        const recordedAt = new Date(now()).toISOString();
        const evidence = normalizedPayload.productionEvidence;
        transitionCreatorProduction(session, evidence?.currentPhase || session.production.currentPhase, {
          ...(evidence?.authoritative
            ? { authoritativeCompletedPhases: evidence.completedPhases }
            : {}),
          invalidateFromPhase: evidence?.currentPhase || phaseForPlan(session.latestPlan, session.phase),
          reason: `已撤回 ${evidence?.action || '创作'} 的画布变更`,
          recordedAt,
          checkpoint: creatorProductionCheckpoint(type, normalizedPayload, recordedAt),
        });
      }
      session.lastFailure = null;
    } else if (type === 'plan.failed') {
      session.status = 'active';
      const recordedAt = new Date(now()).toISOString();
      session.lastFailure = {
        message: boundedText(payload?.error, 2_000) || '创作计划执行失败',
        at: recordedAt,
      };
      blockCreatorProduction(session, session.lastFailure.message, {
        recordedAt,
        checkpoint: creatorProductionCheckpoint(type, payload, recordedAt),
      });
    } else if (type === 'artifact.sent-to-canvas') {
      normalizedPayload = {
        schema: 't8-creator-artifact-canvas-evidence-v1',
        planId: boundedText(payload?.planId, 160),
        planDigest: boundedText(payload?.planDigest, 160),
        patchId: boundedText(payload?.patchId, 160),
        assetId: boundedText(payload?.assetId, 160),
        contentHash: /^[a-f0-9]{64}$/i.test(String(payload?.contentHash || ''))
          ? String(payload.contentHash).toLowerCase()
          : '',
        nodeId: boundedText(payload?.nodeId, 160),
        appliedRevision: Number.isSafeInteger(Number(payload?.appliedRevision))
          && Number(payload.appliedRevision) >= 0
          ? Number(payload.appliedRevision)
          : null,
        duplicate: payload?.duplicate === true,
        recordedAt: new Date(now()).toISOString(),
      };
      if (!normalizedPayload.planId
        || !normalizedPayload.planDigest
        || !normalizedPayload.patchId
        || !normalizedPayload.assetId
        || !normalizedPayload.contentHash
        || !normalizedPayload.nodeId
        || normalizedPayload.appliedRevision == null) {
        throw new CreatorAgentSessionError(
          'CREATOR_ARTIFACT_CANVAS_EVIDENCE_INVALID',
          '素材发送到画布的完成证据不完整',
        );
      }
      const duplicate = (Array.isArray(session.events) ? session.events : []).some((event) => (
        event?.type === type
        && event?.payload?.patchId === normalizedPayload.patchId
        && event?.payload?.assetId === normalizedPayload.assetId
      ));
      if (duplicate) return session;
      session.status = 'active';
      session.lastFailure = null;
      clearCreatorProductionBlock(
        session,
        creatorProductionCheckpoint(type, normalizedPayload, normalizedPayload.recordedAt),
      );
    } else if (type === 'run.linked') {
      normalizedPayload = {
        schema: 't8-creator-run-link-v1',
        planId: boundedText(payload?.planId, 160),
        planDigest: boundedText(payload?.planDigest, 160),
        patchId: boundedText(payload?.patchId, 160),
        runId: boundedText(payload?.runId, 160),
        runIntentId: boundedText(payload?.runIntentId, 160),
        matchedNodeIds: [...new Set((Array.isArray(payload?.matchedNodeIds) ? payload.matchedNodeIds : [])
          .map((value) => boundedText(value, 160))
          .filter(Boolean))].slice(0, 64),
        linkedAt: new Date(now()).toISOString(),
      };
      if (!normalizedPayload.planId || !normalizedPayload.runId || !normalizedPayload.matchedNodeIds.length) {
        throw new CreatorAgentSessionError('CREATOR_RUN_LINK_INVALID', '真实运行关联缺少计划、Run 或节点证据');
      }
      const duplicate = session.runLinks.some((link) => (
        link?.planId === normalizedPayload.planId && link?.runId === normalizedPayload.runId
      ));
      if (duplicate) return session;
      session.runLinks = [...session.runLinks, normalizedPayload].slice(-100);
      session.status = 'active';
      session.lastFailure = null;
    } else if (type === 'run.artifacts-verified') {
      const verification = payload?.verification && typeof payload.verification === 'object'
        ? payload.verification
        : {};
      const normalizeList = (value, limit = 64, textLimit = 200) => (
        [...new Set((Array.isArray(value) ? value : [])
          .map((item) => boundedText(item, textLimit))
          .filter(Boolean))].slice(0, limit)
      );
      const normalizedRun = verification.run && typeof verification.run === 'object'
        ? {
            runId: boundedText(verification.run.runId, 160),
            status: boundedText(verification.run.status, 40),
            canvasRevision: verification.run.canvasRevision != null
              && Number.isSafeInteger(Number(verification.run.canvasRevision))
              ? Number(verification.run.canvasRevision)
              : null,
            createdAt: verification.run.createdAt == null ? null : Number(verification.run.createdAt),
            finishedAt: verification.run.finishedAt == null ? null : Number(verification.run.finishedAt),
          }
        : null;
      const normalizedNodeRuns = (Array.isArray(verification.nodeRuns) ? verification.nodeRuns : [])
        .slice(0, 100)
        .map((nodeRun) => ({
          nodeRunId: boundedText(nodeRun?.nodeRunId, 160),
          nodeId: boundedText(nodeRun?.nodeId, 160),
          status: boundedText(nodeRun?.status, 40),
          latestAttemptId: boundedText(nodeRun?.latestAttemptId, 160) || null,
          latestAttemptStatus: boundedText(nodeRun?.latestAttemptStatus, 40) || null,
          outputAssetIds: normalizeList(nodeRun?.outputAssetIds, 64, 160),
        }))
        .filter((nodeRun) => nodeRun.nodeRunId);
      const normalizedAssets = (Array.isArray(verification.assets) ? verification.assets : [])
        .slice(0, 100)
        .map((asset) => ({
          assetId: boundedText(asset?.assetId, 160),
          nodeRunId: boundedText(asset?.nodeRunId, 160),
          kind: boundedText(asset?.kind, 40) || null,
          mimeType: boundedText(asset?.mimeType, 160) || null,
          contentHash: boundedText(asset?.contentHash, 160) || null,
          availability: boundedText(asset?.availability, 40) || null,
          stored: asset?.stored === true,
          blobPresent: asset?.blobPresent === true,
          hashVerified: asset?.hashVerified === true,
          magicVerified: asset?.magicVerified === true,
          detectedKind: boundedText(asset?.detectedKind, 40) || null,
          detectedMimeType: boundedText(asset?.detectedMimeType, 160) || null,
          observedContentHash: boundedText(asset?.observedContentHash, 160) || null,
          byteSize: asset?.byteSize != null
            && Number.isSafeInteger(Number(asset.byteSize)) && Number(asset.byteSize) >= 0
            ? Number(asset.byteSize)
            : null,
          width: asset?.width != null
            && Number.isFinite(Number(asset.width)) && Number(asset.width) > 0
            ? Number(asset.width)
            : null,
          height: asset?.height != null
            && Number.isFinite(Number(asset.height)) && Number(asset.height) > 0
            ? Number(asset.height)
            : null,
          duration: asset?.duration != null
            && Number.isFinite(Number(asset.duration)) && Number(asset.duration) > 0
            ? Number(asset.duration)
            : null,
          decodeEvidence: boundedText(asset?.decodeEvidence, 80) || 'not-recorded',
          associationVerified: asset?.associationVerified === true,
          expectedNodeId: boundedText(asset?.expectedNodeId, 160) || null,
          expectedShotIds: normalizeList(asset?.expectedShotIds, 64, 160),
          observedShotIds: normalizeList(asset?.observedShotIds, 64, 160),
          expectedCanvasRevision: asset?.expectedCanvasRevision != null
            && Number.isSafeInteger(Number(asset.expectedCanvasRevision))
            ? Number(asset.expectedCanvasRevision)
            : null,
        }))
        .filter((asset) => asset.assetId);
      normalizedPayload = {
        schema: 't8-creator-artifact-verification-v1',
        runId: boundedText(payload?.runId, 160),
        verified: verification.verified === true,
        reasons: normalizeList(verification.reasons, 100, 240),
        run: normalizedRun,
        nodeRuns: normalizedNodeRuns,
        assets: normalizedAssets,
        verifiedAt: new Date(now()).toISOString(),
      };
      if (!normalizedPayload.runId) {
        throw new CreatorAgentSessionError('CREATOR_ARTIFACT_VERIFICATION_INVALID', '产物核验缺少 Run 证据');
      }
      normalizedPayload.verificationDigest = crypto.createHash('sha256')
        .update(JSON.stringify({
          runId: normalizedPayload.runId,
          verified: normalizedPayload.verified,
          reasons: normalizedPayload.reasons,
          run: normalizedPayload.run,
          nodeRuns: normalizedPayload.nodeRuns,
          assets: normalizedPayload.assets,
        }))
        .digest('hex');
      const duplicate = session.artifactVerifications.find((item) => (
        item?.runId === normalizedPayload.runId
        && item?.verificationDigest === normalizedPayload.verificationDigest
      ));
      if (duplicate) return session;
      session.artifactVerifications = [
        ...session.artifactVerifications.filter((item) => item?.runId !== normalizedPayload.runId),
        normalizedPayload,
      ].slice(-100);
      const fullyVerified = normalizedPayload.verified
        && normalizedPayload.assets.length > 0
        && normalizedPayload.nodeRuns.length > 0
        && normalizedPayload.nodeRuns.every((nodeRun) => (
          nodeRun.status === 'succeeded' && nodeRun.outputAssetIds.length > 0
        ));
      if (fullyVerified) {
        transitionCreatorProduction(session, 'candidates', {
          completeCurrent: true,
          reason: '真实 Run 产物已完成文件、格式、摘要与运行关联核验',
          recordedAt: normalizedPayload.verifiedAt,
          checkpoint: creatorProductionCheckpoint(type, normalizedPayload, normalizedPayload.verifiedAt),
        });
      }
    } else if (type.startsWith('delivery.')) {
      const approvalRequestId = boundedText(payload?.approvalRequestId, 160);
      const planId = boundedText(payload?.planId, 160);
      if (!approvalRequestId || !planId) {
        throw new CreatorAgentSessionError(
          'CREATOR_DELIVERY_EVENT_INVALID',
          '交付事件缺少计划或确认记录',
        );
      }
      const duplicate = (Array.isArray(session.events) ? session.events : []).find((event) => (
        event?.type === type
        && event?.payload?.approvalRequestId === approvalRequestId
      ));
      if (duplicate) return session;
      const licenseSummary = payload?.licenseSummary && typeof payload.licenseSummary === 'object'
        ? {
            known: Math.max(0, Math.min(100_000, Number(payload.licenseSummary.known) || 0)),
            unknown: Math.max(0, Math.min(100_000, Number(payload.licenseSummary.unknown) || 0)),
          }
        : { known: 0, unknown: 0 };
      normalizedPayload = {
        schema: 't8-creator-delivery-evidence-v1',
        approvalRequestId,
        planId,
        packageName: boundedText(payload?.packageName, 160),
        itemCount: Math.max(0, Math.min(100_000, Number(payload?.itemCount) || 0)),
        totalBytes: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(payload?.totalBytes) || 0)),
        packageDigest: /^[a-f0-9]{64}$/i.test(String(payload?.packageDigest || ''))
          ? String(payload.packageDigest).toLowerCase()
          : '',
        verifiedItems: Math.max(0, Math.min(100_000, Number(payload?.verifiedItems) || 0)),
        verifiedBytes: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(payload?.verifiedBytes) || 0)),
        valid: payload?.valid === true,
        scope: payload?.scope === 'project' ? 'project' : 'canvas',
        canvasRevision: Number.isSafeInteger(Number(payload?.canvasRevision))
          && Number(payload.canvasRevision) >= 0 ? Number(payload.canvasRevision) : null,
        catalogRevision: Number.isSafeInteger(Number(payload?.catalogRevision))
          && Number(payload.catalogRevision) >= 1 ? Number(payload.catalogRevision) : null,
        selectionDigest: /^[a-f0-9]{64}$/i.test(String(payload?.selectionDigest || ''))
          ? String(payload.selectionDigest).toLowerCase()
          : '',
        files: (Array.isArray(payload?.files) ? payload.files : []).slice(0, 500)
          .map((item) => ({
            assetId: boundedText(item?.assetId, 240),
            size: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(item?.size) || 0)),
            sha256: /^[a-f0-9]{64}$/i.test(String(item?.sha256 || ''))
              ? String(item.sha256).toLowerCase()
              : '',
          }))
          .filter((item) => item.assetId && item.sha256),
        licenseSummary,
        expiresAt: boundedText(payload?.expiresAt, 80),
        error: boundedText(payload?.error, 2_000),
        status: type === 'delivery.completed'
          ? 'completed'
          : type === 'delivery.denied'
            ? 'denied'
            : type === 'delivery.failed'
              ? 'failed'
              : 'pending',
        recordedAt: new Date(now()).toISOString(),
      };
      transitionCreatorProduction(session, 'delivery', {
        completeCurrent: type === 'delivery.completed' && normalizedPayload.valid,
        reason: type === 'delivery.completed'
          ? '交付包已完成本地核验'
          : type === 'delivery.approval-requested'
            ? '已进入交付确认'
            : '交付阶段状态更新',
        recordedAt: normalizedPayload.recordedAt,
        checkpoint: creatorProductionCheckpoint(type, normalizedPayload, normalizedPayload.recordedAt),
      });
      session.status = type === 'delivery.approval-requested' ? 'awaiting-approval' : 'active';
      if (type === 'delivery.failed') {
        session.lastFailure = {
          message: normalizedPayload.error || '交付包创建失败',
          at: normalizedPayload.recordedAt,
        };
        blockCreatorProduction(session, session.lastFailure.message, {
          recordedAt: normalizedPayload.recordedAt,
          checkpoint: creatorProductionCheckpoint(type, normalizedPayload, normalizedPayload.recordedAt),
        });
      } else if (type === 'delivery.completed') {
        session.lastFailure = null;
        session.deliveryEvidence = [
          ...(Array.isArray(session.deliveryEvidence) ? session.deliveryEvidence : [])
            .filter((item) => item?.approvalRequestId !== approvalRequestId),
          normalizedPayload,
        ].slice(-50);
      }
    }
    appendEvent(session, type, normalizedPayload);
    return read(session.id);
  }

  return {
    appendResponseDelta,
    appendRunEvents,
    appendActionPlan,
    confirmProductionDocuments,
    appendLifecycle,
    appendTurn,
    beginStreamingTurn,
    completeStreamingTurn,
    create,
    eventsAfter,
    failStreamingTurn,
    list,
    stopStreamingTurn,
    messageRequest,
    productionDocumentsForNextPlan,
    read,
    rootDir,
  };
}

module.exports = {
  CREATOR_AGENT_EVENT_SCHEMA,
  CREATOR_AGENT_SESSION_SCHEMA,
  CREATOR_PRODUCTION_DOCUMENT_CONFIRMATION_SCHEMA,
  CREATOR_PRODUCTION_PHASES,
  CREATOR_PRODUCTION_STATE_SCHEMA,
  CreatorAgentSessionError,
  assistantMessageForPlan,
  completedPhasesForPlan,
  createCreatorAgentSessionStore,
  creatorResponseChunks,
  creatorSuggestions,
  creatorSuggestionSet,
  creatorSuggestionInvariantReceipt,
  creatorAttachmentOnlyPrompt,
  creatorSuggestionBinding,
  inferCreatorKind,
  inferCreatorRecipe,
  normalizeAttachments,
  normalizeCreativePhase,
  normalizeContext,
  normalizeCreatorProductionState,
  normalizeStoredPatch,
  phaseForPlan,
  resolveCreatorSuggestionSelection,
};
