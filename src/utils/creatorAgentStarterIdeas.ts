export interface CreatorAgentStarterIdea {
  id: string;
  label: string;
}

export interface CreatorAgentStarterIdeaContext {
  canvasRevision?: number | null;
  nodeCount?: number;
  edgeCount?: number;
  selectedNodeTypes?: readonly string[];
  referencedNodeTypes?: readonly string[];
  failedRunCount?: number;
  offscreenFailedCount?: number;
}

const STARTER_IDEA_BATCHES: readonly (readonly CreatorAgentStarterIdea[])[] = [
  [
    { id: 'idea-story-system', label: '把一个模糊创意整理成可编辑的剧本、角色与镜头计划' },
    { id: 'idea-canvas-priority', label: '结合当前画布，找出最值得继续完善的三处内容' },
    { id: 'idea-vertical-ad', label: '从一句产品卖点开始，规划一支 30 秒竖屏广告' },
  ],
  [
    { id: 'idea-character-system', label: '帮我设计一个角色，并统一脸、服装、场景和镜头风格' },
    { id: 'idea-image-to-video', label: '把现有图片发展成一段有起承转合的短视频' },
    { id: 'idea-material-production', label: '为这组素材补全分镜、运镜、声音和成片节奏' },
  ],
  [
    { id: 'idea-script-breakdown', label: '把一段剧本拆成角色资产、场景资产和可拍分镜' },
    { id: 'idea-visual-directions', label: '为一个画面设计三种不同情绪的光影与构图方向' },
    { id: 'idea-music-video', label: '策划一支音乐短片，从视觉概念推进到镜头和剪辑' },
  ],
  [
    { id: 'idea-continuity-review', label: '检查当前作品的连续性，并给出不覆盖已确认内容的改进计划' },
    { id: 'idea-coherent-video', label: '用现有素材做一套角色一致、场景连贯的视频方案' },
    { id: 'idea-campaign-hook', label: '从受众和传播目标出发，完善脚本、视觉钩子与结尾行动' },
  ],
] as const;

export const CREATOR_AGENT_STARTER_IDEA_BATCH_COUNT = STARTER_IDEA_BATCHES.length;

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function boundedCount(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.min(9999, Math.trunc(parsed)))
    : 0;
}

function normalizedTypes(value: readonly string[] | undefined) {
  return [...new Set((value || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))]
    .sort()
    .slice(0, 16);
}

export function creatorAgentStarterIdeaContextKey(
  input: CreatorAgentStarterIdeaContext,
) {
  const safeSummary = {
    schema: 't8-creator-starter-context-v1',
    canvasRevision: input.canvasRevision == null
      ? null
      : boundedCount(input.canvasRevision),
    nodeCount: boundedCount(input.nodeCount),
    edgeCount: boundedCount(input.edgeCount),
    selectedNodeTypes: normalizedTypes(input.selectedNodeTypes),
    referencedNodeTypes: normalizedTypes(input.referencedNodeTypes),
    failedRunCount: boundedCount(input.failedRunCount),
    offscreenFailedCount: boundedCount(input.offscreenFailedCount),
  };
  return stableHash(JSON.stringify(safeSummary));
}

export function creatorAgentStarterIdeaBatch(input: {
  sessionSeed: string;
  contextKey: string;
  rotation?: number;
}) {
  const sessionSeed = String(input.sessionSeed || 'new-session').slice(0, 160);
  const contextKey = String(input.contextKey || '00000000').slice(0, 64);
  const hash = stableHash(`t8-creator-starter-v1\0${sessionSeed}\0${contextKey}`);
  const baseIndex = Number.parseInt(hash, 16) % CREATOR_AGENT_STARTER_IDEA_BATCH_COUNT;
  const rotation = Number.isFinite(input.rotation)
    ? Math.trunc(Number(input.rotation))
    : 0;
  const normalizedRotation = (
    (rotation % CREATOR_AGENT_STARTER_IDEA_BATCH_COUNT)
    + CREATOR_AGENT_STARTER_IDEA_BATCH_COUNT
  ) % CREATOR_AGENT_STARTER_IDEA_BATCH_COUNT;
  const batch = STARTER_IDEA_BATCHES[
    (baseIndex + normalizedRotation) % CREATOR_AGENT_STARTER_IDEA_BATCH_COUNT
  ];
  return batch.map((item) => ({ ...item }));
}
